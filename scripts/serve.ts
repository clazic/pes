// PES local server (one port): serves the whole PES home folder on 127.0.0.1. TypeScript twin of scripts/serve.py when that file is
// run directly:  node scripts/serve.ts <PES home folder> [port=8760]   (Node 26 strips the types; no build step, no extra package)
//
//  - GET /                  → the home's index.html (project list)
//  - GET /<slug>/           → that project's index.html (newest ask-*.html when there is none yet)
//  - GET /ping, /<slug>/ping → {"ok": true}            GET /whoami → {"root": "<home>", "single": true}
//  - GET /version, /<slug>/version → {"v": <newest index.html / ask-*.html time, epoch seconds>}
//  - POST /<slug>/feedback  {"stage","round","kind","text","answers",...}
//      the answer is ONE submission written to the database in THIS process (no child process, no feedback/<name>.json file);
//      <slug>/feedback.log gets one line  FEEDBACK <stage> R<round> <kind> <file name>  and the reply is {"ok":true,"file":<name>,"v":<cursor>}.
//      A folder that is not in the database takes no answer (404): project.json is read-only now.
//  - POST /feedback (screens made before 0.8) finds the project from the Referer.
//  - A POST from another Origin is refused (403) unless ~/.pes/config.json lists it in trusted_origins (read on every request).
//
// Not here (SEL-77 and later, with scripts/pes.ts): the /api/v1/* pass-through, the DB-built dashboard and hub pages.
//
// Safety: binds 127.0.0.1 only, never asks DNS for a host name (SEL-33: socket.getfqdn() stalled 30 s on some macOS runners), never
// contacts the hub ports 8760~8775, never starts another program.
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

import type { BridgeReply } from "./pes_core/cli_bridge.ts";

const MAX_BODY = 256 * 1024;
/** A body above MAX_BODY but within this size is read away before the 413 is sent (the sender is not cut off). */
const DRAIN_LIMIT = 8 * 1024 * 1024;
const DRAIN_IO_TIMEOUT_MS = 10_000;
const SAFE_INT = 2n ** 53n - 1n;
const MAX_JSON_DEPTH = 200;
const KINDS = new Set(["feedback", "review", "stage_start", "approve", "resume", "reopen"]);
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const USAGE = "사용: node scripts/serve.ts <PES 홈 폴더> [포트=8760]";

class Exit extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- small Python-compatible helpers
/** Python's json.dumps(obj, ensure_ascii=False): separators ", " and ": ". */
function py_dumps(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(py_dumps).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${JSON.stringify(key)}: ${py_dumps(item)}`)
      .join(", ")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** str(value) for what a JSON document can hold (containers are only approximated: they never reach a stored value as such). */
function py_str(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function py_truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

/** int(value) of a JSON value; throws where Python's int() raises. */
function py_int(value: unknown): bigint {
  if (typeof value === "boolean") return value ? 1n : 0n;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("int() of a non-finite number");
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^[+-]?\d+(_\d+)*$/.test(text)) throw new Error("int() of a non-number string");
    return BigInt(text.replace(/_/g, ""));
  }
  throw new Error("int() of a container or null");
}

/** urllib.parse.unquote: %XX runs are UTF-8 bytes; bytes that are not UTF-8 become U+FFFD. */
function py_unquote(text: string): string {
  if (!text.includes("%")) return text;
  return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => Buffer.from(run.split("%").slice(1).map((hex) => parseInt(hex, 16))).toString("utf8"));
}

/** The depth check of serve.py's DB route, without recursion: a container deeper than `limit` levels. */
function json_depth_exceeds(value: unknown, limit = MAX_JSON_DEPTH): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [item, depth] = stack.pop() as [unknown, number];
    if (item !== null && typeof item === "object") {
      if (depth > limit) return true;
      for (const child of Array.isArray(item) ? item : Object.values(item as object)) {
        if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------- content types (python's mimetypes + serve.py's guess_type)
const MIME: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".csv": "text/csv",
  ".xml": "text/xml", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".ico": "image/vnd.microsoft.icon", ".avif": "image/avif", ".pdf": "application/pdf",
  ".zip": "application/zip", ".gz": "application/gzip", ".tar": "application/x-tar", ".wasm": "application/wasm", ".woff": "font/woff",
  ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".mp3": "audio/mpeg", ".wav": "audio/x-wav", ".mp4": "video/mp4",
  ".webm": "video/webm", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".hwpx": "application/octet-stream",
};

function guess_type(path: string): string {
  const lower = path.toLowerCase();
  if ([".md", ".markdown", ".txt", ".log"].some((suffix) => lower.endsWith(suffix))) return "text/plain; charset=utf-8";
  const type = MIME[extname(lower)] ?? "application/octet-stream";
  return type.startsWith("text/") || type === "application/json" || type === "application/javascript" || type === "image/svg+xml" ? `${type}; charset=utf-8` : type;
}

// ---------------------------------------------------------------- the server
interface Config {
  root: string;
  port: number;
}

function error_page(code: number, short: string, explain: string, message?: string): string {
  return `<!DOCTYPE HTML>
<html lang="en">
    <head>
        <meta charset="utf-8">
        <title>Error response</title>
    </head>
    <body>
        <h1>Error response</h1>
        <p>Error code: ${code}</p>
        <p>Message: ${message ?? short}.</p>
        <p>Error code explanation: ${code} - ${explain}.</p>
    </body>
</html>
`;
}

function trusted_origins(): Set<string> {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".pes", "config.json"), "utf8")) as { trusted_origins?: unknown };
    const list = config.trusted_origins;
    return new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/** The path part of the request target (no query, no fragment), still percent-encoded. */
function raw_path(url: string | undefined): string {
  return (url ?? "/").split("?", 1)[0]?.split("#", 1)[0] ?? "/";
}

function query_of(url: string | undefined): string {
  const at = (url ?? "").indexOf("?");
  return at < 0 ? "" : (url as string).slice(at).split("#", 1)[0] ?? "";
}

function mtime_ms(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function mtime_seconds(path: string): number | undefined {
  return existsSync(path) ? Math.floor(mtime_ms(path) / 1000) : undefined;
}

function ask_forms(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.startsWith("ask-") && name.endsWith(".html"));
  } catch {
    return [];
  }
}

type Answerer = (slug: string, args: Record<string, unknown>) => Promise<BridgeReply | null>;

/** In-process access to the database: one request at a time (a burst of answers is written one after another, none lost). */
function make_db(root: string): { route: (slug: string) => Promise<"database" | "none" | null>; feedback: Answerer } {
  const env: Record<string, string | undefined> = { ...process.env, PES_HOME: root };
  delete env.PES_TOKEN;
  delete env.PES_OWNER;
  let tail: Promise<unknown> = Promise.resolve();
  const bridge = async (op: string, slug: string, args: Record<string, unknown>): Promise<BridgeReply | null> => {
    const run = async (): Promise<BridgeReply | null> => {
      try {
        const { handle_request } = await import("./pes_core/cli_bridge.ts");
        const answer = await handle_request(env, { op, slug, args });
        // an unexpected error comes back with its stack (the bridge prints nothing): the server's stderr is where it belongs
        if (!answer.ok && answer.stack !== undefined) process.stderr.write(`${answer.stack}\n`);
        return answer;
      } catch (error) {
        process.stderr.write(`serve.ts: ${error instanceof Error ? error.message : String(error)}\n`);
        return null;
      }
    };
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  };
  return {
    route: async (slug) => {
      const res = await bridge("route", slug, {});
      if (res === null || !res.ok) return null;
      return (res.data as { serving?: string }).serving === "database" ? "database" : "none";
    },
    feedback: (slug, args) => bridge("web_feedback", slug, args),
  };
}

async function start(config: Config): Promise<void> {
  const { root, port } = config;
  // Load the database code BEFORE listening: otherwise the first answer waits for it. A failure here is not fatal: the first answer meets it again and is refused with 503.
  await import("./pes_core/cli_bridge.ts").catch(() => undefined);
  const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const db = make_db(root);
  const project_of = (path: string): { dir: string | null; rest: string[] } => {
    const parts = py_unquote(path).split("/").filter((part) => part !== "");
    if (parts[0] !== undefined && SLUG.test(parts[0]) && existsSync(join(root, parts[0], "project.json"))) return { dir: join(root, parts[0]), rest: parts.slice(1) };
    if (existsSync(join(root, "project.json"))) return { dir: root, rest: parts };
    return { dir: null, rest: parts };
  };

  const send = (req: IncomingMessage, res: ServerResponse, status: number, headers: Record<string, string | number>, body: Buffer | string = ""): void => {
    const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    res.writeHead(status, { "Cache-Control": "no-store", ...headers, "Content-Length": bytes.length });
    res.end(req.method === "HEAD" ? undefined : bytes);
  };

  const send_json = (req: IncomingMessage, res: ServerResponse, status: number, value: unknown, options: { cors?: boolean; close?: boolean } = {}): void => {
    const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
    const origin = header(req, "origin");
    if (options.cors === true && /^http:\/\/(127\.0\.0\.1|localhost):87\d\d$/.test(origin)) headers["Access-Control-Allow-Origin"] = origin;
    if (options.close === true) headers.Connection = "close";
    send(req, res, status, headers, py_dumps(value));
  };

  const send_error = (req: IncomingMessage, res: ServerResponse, status: number, short: string, explain: string, message?: string): void => {
    send(req, res, status, { "Content-Type": "text/html;charset=utf-8", Connection: "close" }, error_page(status, short, explain, message));
  };

  const not_found = (req: IncomingMessage, res: ServerResponse, message = "File not found"): void => send_error(req, res, 404, message, "Nothing matches the given URI");

  const redirect = (req: IncomingMessage, res: ServerResponse, status: number, location: string): void => send(req, res, status, { Location: location }, "");

  /** SimpleHTTPRequestHandler.translate_path: normalised, can never leave `root`. */
  const translate = (path: string): string => {
    const trailing = path.trimEnd().endsWith("/");
    const words: string[] = [];
    for (const word of py_unquote(path).split("/")) {
      if (word === "" || word === ".") continue;
      if (word === "..") {
        words.pop();
        continue;
      }
      words.push(word);
    }
    const safe = words.filter((word) => !/[\\/\0]/.test(word) && !/^[A-Za-z]:/.test(word));
    const full = safe.length === 0 ? root : join(root, ...safe);
    return trailing ? `${full}/` : full;
  };

  const serve_static = (req: IncomingMessage, res: ServerResponse): void => {
    const path = raw_path(req.url);
    let target = translate(path);
    let stat: Stats | null = null;
    try {
      stat = statSync(target);
    } catch {
      stat = null;
    }
    if (stat !== null && stat.isDirectory()) {
      if (!/(\/|%2f)$/i.test(path)) {
        redirect(req, res, 301, `${path}/${query_of(req.url)}`);
        return;
      }
      const index = ["index.html", "index.htm"].map((name) => join(target, name)).find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      if (index === undefined) {
        not_found(req, res, "Not Found");
        return;
      }
      target = index;
      stat = statSync(target);
    }
    if (target.endsWith("/") || stat === null || !stat.isFile()) {
      not_found(req, res);
      return;
    }
    const headers = {
      "Content-Type": guess_type(target),
      "Content-Length": stat.size,
      "Last-Modified": new Date(stat.mtimeMs).toUTCString(),
      "Cache-Control": "no-store",
    };
    if (req.method === "HEAD") {
      res.writeHead(200, headers);
      res.end();
      return;
    }
    const stream = createReadStream(target);
    stream.once("error", () => {
      if (res.headersSent) res.destroy();
      else not_found(req, res);
    });
    stream.once("open", () => {
      res.writeHead(200, headers);
      stream.pipe(res);
    });
  };

  const handle_get = (req: IncomingMessage, res: ServerResponse): void => {
    const path = raw_path(req.url);
    if (path === "/whoami") return send_json(req, res, 200, { root, single: true }, { cors: true });
    if (path === "/version" || path.endsWith("/version")) {
      const { dir } = project_of(path.slice(0, -"version".length) || "/");
      const base = dir ?? root;
      const times = [join(base, "index.html"), ...ask_forms(base).map((name) => join(base, name))].map(mtime_seconds).filter((t): t is number => t !== undefined);
      return send_json(req, res, 200, { v: Math.max(0, ...times) });
    }
    if (path === "/ping" || path.endsWith("/ping")) return send_json(req, res, 200, { ok: true });
    const { dir, rest } = project_of(path);
    if (dir !== null && rest.length === 0) {
      const base = dir === root ? "/" : `/${basename(dir)}/`;
      if (path !== base) return redirect(req, res, 302, base);
      if (!existsSync(join(dir, "index.html"))) {
        const asks = ask_forms(dir)
          .map((name) => ({ name, at: mtime_ms(join(dir, name)) }))
          .sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : 1));
        const newest = asks[asks.length - 1];
        if (newest !== undefined) return redirect(req, res, 302, base + encodeURI(newest.name));
      }
    }
    return serve_static(req, res);
  };

  /** Over the size limit: read a body within the drain limit away first (an upload in progress is not cut off), then answer 413 and close. */
  const reject_oversize = (req: IncomingMessage, res: ServerResponse, length: number): void => {
    const answer = (): void => {
      if (!res.writableEnded) send_json(req, res, 413, { ok: false }, { close: true });
    };
    if (length <= 0 || length > DRAIN_LIMIT) return answer();
    let timer = setTimeout(() => req.destroy(), DRAIN_IO_TIMEOUT_MS);
    req.on("data", () => {
      clearTimeout(timer);
      timer = setTimeout(() => req.destroy(), DRAIN_IO_TIMEOUT_MS);
    });
    req.once("end", () => {
      clearTimeout(timer);
      answer();
    });
    req.once("close", () => clearTimeout(timer));
  };

  const read_body = (req: IncomingMessage, length: number): Promise<Buffer | null> =>
    new Promise((done) => {
      const chunks: Buffer[] = [];
      let got = 0;
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        got += chunk.length;
      });
      req.once("end", () => done(Buffer.concat(chunks).subarray(0, length)));
      req.once("error", () => done(null));
      req.once("close", () => done(got >= length ? Buffer.concat(chunks).subarray(0, length) : null));
    });

  const handle_post = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = raw_path(req.url);
    // which project takes the answer: '/<slug>/feedback', or (screens before 0.8) the first segment of the Referer's path for '/feedback'
    let slug: string | null = null;
    const parts = py_unquote(path).split("/").filter((part) => part !== "");
    if (parts.length === 2 && parts[1] === "feedback" && SLUG.test(parts[0] as string)) slug = parts[0] as string;
    else if (path === "/feedback") {
      let referer = "";
      try {
        referer = new URL(header(req, "referer")).pathname;
      } catch {
        referer = "";
      }
      const first = py_unquote(referer).split("/").filter((part) => part !== "")[0];
      if (first !== undefined && SLUG.test(first)) slug = first;
    }
    if (slug === null) return send_json(req, res, 404, { ok: false });
    const serving = await db.route(slug);
    if (serving === null) return send_json(req, res, 503, { ok: false, error: "db" });
    if (serving !== "database") return send_json(req, res, 404, { ok: false });

    const origin = header(req, "origin");
    if (!allowed.has(origin) && !trusted_origins().has(origin)) return send_json(req, res, 403, { ok: false, error: "origin", hint: `pes remote add ${origin}` });
    const length_text = header(req, "content-length");
    const length = /^\d+$/.test(length_text) ? Number(length_text) : 0;
    if (length <= 0 || length > MAX_BODY) return reject_oversize(req, res, length);
    const body = await read_body(req, length);
    if (body === null) return;

    let text: string;
    let round: bigint;
    let kind: string;
    let stage: string;
    let answers: Record<string, unknown>;
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      data = parsed as Record<string, unknown>;
      text = py_str(Object.hasOwn(data, "text") ? data.text : "").trim();
      round = py_int(Object.hasOwn(data, "round") ? data.round : 0);
      kind = py_truthy(data.kind) ? (typeof data.kind === "string" ? data.kind : "\0") : "feedback";
      stage = (py_truthy(data.stage) ? py_str(data.stage) : "x").replace(/[^a-z]/g, "").slice(0, 12) || "x";
      answers = data.answers !== null && typeof data.answers === "object" && !Array.isArray(data.answers) ? (data.answers as Record<string, unknown>) : {};
    } catch {
      return send_json(req, res, 400, { ok: false });
    }
    if (!KINDS.has(kind)) return send_json(req, res, 400, { ok: false, error: "kind" });
    if (text === "" && Object.keys(answers).length === 0) return send_json(req, res, 400, { ok: false, error: "empty" });
    // the core reads numbers and JSON like JavaScript: refuse here what it would read differently
    if (round > SAFE_INT || round < -SAFE_INT || json_depth_exceeds(data)) return send_json(req, res, 400, { ok: false, error: "invalid" });

    const rnd = Number(round);
    const reply = await db.feedback(slug, {
      stage,
      round: rnd,
      kind,
      text,
      answers,
      spec: py_str(Object.hasOwn(data, "spec") ? data.spec : "").slice(0, 1024),
      set_id: typeof data.set_id === "string" ? data.set_id : null,
      via: allowed.has(origin) ? "html" : "remote",
      origin,
      who: header(req, "tailscale-user-login"),
    });
    if (reply === null) return send_json(req, res, 503, { ok: false, error: "db" });
    if (!reply.ok) {
      if (reply.code === "form_revised") return send_json(req, res, 409, { ok: false, error: "conflict", message: "질문이 바뀌었습니다 — 화면을 새로 불러온 뒤 다시 보내세요" });
      if (reply.code === "invalid_payload" || reply.code === "unknown_command") return send_json(req, res, 400, { ok: false });
      if (reply.code === "not_found") return send_json(req, res, 404, { ok: false });
      return send_json(req, res, 503, { ok: false, error: "db" });
    }
    const result = reply.data as { name: string; stage?: string; v?: unknown };
    const folder = join(root, slug);
    mkdirSync(folder, { recursive: true });
    // one synchronous append per answer: lines of different answers cannot interleave
    appendFileSync(join(folder, "feedback.log"), `FEEDBACK ${result.stage || stage} R${rnd} ${kind} ${result.name}\n`, "utf8");
    send_json(req, res, 200, { ok: true, file: result.name, ...(Number.isInteger(result.v) ? { v: result.v } : {}) });
  };

  const server = createServer((req, res) => {
    const fail = (error: unknown): void => {
      process.stderr.write(`serve.ts: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      if (res.headersSent) res.destroy();
      else send_json(req, res, 500, { ok: false });
    };
    try {
      const method = req.method ?? "GET";
      if (method === "GET" || method === "HEAD") handle_get(req, res);
      else if (method === "POST") handle_post(req, res).catch(fail);
      else if (method === "PUT") send_json(req, res, 405, { ok: false });
      else send_error(req, res, 501, `Unsupported method ('${method}')`, "Server does not support this operation");
    } catch (error) {
      fail(error);
    }
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    else socket.destroy();
  });
  server.once("error", (error: NodeJS.ErrnoException) => {
    const why = error.code === "EADDRINUSE" ? `포트 ${port} 사용 중 — 다른 프로그램을 끄거나 잠시 뒤 다시` : `포트 ${port} 에서 서버를 시작하지 못했습니다 (${error.code ?? error.message})`;
    process.stderr.write(`serve.ts: ${why}\n`);
    process.exit(1);
  });
  // listen on the IP literal: no host-name lookup of any kind
  server.listen({ port, host: "127.0.0.1" }, () => {
    process.stdout.write(`serving ${root} at http://127.0.0.1:${port}/\n`);
  });
}

async function main(argv: string[]): Promise<void> {
  if (argv.length < 1) throw new Exit(2, USAGE);
  let root: string;
  try {
    root = realpathSync.native(resolve(argv[0] as string));
  } catch {
    root = resolve(argv[0] as string);
  }
  let port = 8760;
  if (argv.length > 1) {
    const text = argv[1] as string;
    port = /^\d{1,5}$/.test(text) ? Number(text) : 0;
    if (port < 1 || port > 65535) throw new Exit(2, `serve.ts: 포트는 1~65535 사이의 정수여야 합니다 (받은 값: ${JSON.stringify(text)})`);
  }
  await start({ root, port });
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof Exit) {
    process.stderr.write(`${error.message}\n`);
    process.exit(error.code);
  }
  throw error;
});

// PES local server (one port): serves the whole PES home folder on 127.0.0.1. TypeScript twin of scripts/serve.py when that file is
// run directly:  node scripts/serve.ts <PES home folder> [port=8760]   (Node 26 strips the types; no build step, no extra package)
//
//  - GET /                  → the home's index.html (project list)
//  - GET /<slug>/           → that project's index.html (newest ask-*.html when there is none yet)
//  - GET /ping, /<slug>/ping → {"ok": true}            GET /whoami → {"root": "<home>", "single": true, "pid": <this process>}
//  - GET /version, /<slug>/version → {"v": <newest index.html / ask-*.html time, epoch seconds>}
//  - POST /<slug>/feedback  {"stage","round","kind","text","answers",...}
//      the answer is ONE submission written to the database in THIS process (no child process, no feedback/<name>.json file);
//      <slug>/feedback.log gets one line  FEEDBACK <stage> R<round> <kind> <file name>  and the reply is {"ok":true,"file":<name>,"v":<cursor>}.
//      A folder that is not in the database takes no answer (404): project.json is read-only now.
//  - POST /feedback (screens made before 0.8) finds the project from the Referer.
//  - A POST from another Origin is refused (403) unless ~/.pes/config.json lists it in trusted_origins (read on every request).
//
//  - /api/v1/*  → the PES API (pes_core/api.ts, in this process), BEFORE any static file: a folder named api/v1 never shadows it. A request of
//      another Origin (null included) is refused 403 `forbidden` before the database is even touched; a missing credential is the API's 401.
//  - /<slug>/ and /<slug>/index.html, / and /index.html of a project (home) the database serves are BUILT FROM THE DATABASE on every request;
//      the reports (/<slug>/reports/<stage>/<name>, /<slug>/out/<name>) are the database's reports and files, never a file of the folder.
//  - /version, /<slug>/version = one integer: the database change cursor (the home's moves with any project's change).
//  - The web app (SEL-82 U1b, built by `cd app && npm run build`; the folder is PES_APP_DIR, default <repo>/app/dist):
//      GET /p/<slug>/**  → the app's index.html (the app routes by its own address), GET /_app/<file> → a file of that folder (the app is built with
//      base "/_app/": a project name cannot start with "_", so no project's page is ever hidden — /app/ and /p/ stay a project's own when it has that name).
//      The folder is a jail: no `..`, no link that leads out of it. Nothing is added to the page (no session value, no cookie): `pes open <slug> --app`
//      hands the owner's session to the app in the URL fragment, so it never reaches the server, a Referer or another Origin. Without a build both are a plain 404.
//      PES_APP_DIR should name a build folder only (an absolute path); a missing one is announced once at start-up.
//
// Safety: binds 127.0.0.1 only, never asks DNS for a host name (SEL-33: socket.getfqdn() stalled 30 s on some macOS runners), never
// contacts the hub ports 8760~8775, never starts another program.
import "./node_guard.ts"; // first: Node 26 미만이면 한국어 한 줄로 끝낸다 (exit 1)
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ApiApp } from "./pes_core/api.ts";
import type { BridgeReply } from "./pes_core/cli_bridge.ts";
import type { Db } from "./pes_core/db.ts";

const MAX_BODY = 256 * 1024;
const MAX_API_BODY = 2 * MAX_BODY;
/** Query string limit of the API (a signed cursor, limit and wait_ms fit; the request stays small). */
const MAX_API_QUERY = 2048;
/**
 * SEL-86: a report / output page (text/html or image/svg+xml under /<slug>/reports/… and /<slug>/out/…) is a document with its own scripts (print button, eli5), served from the
 * app's origin. `sandbox` makes it an opaque origin — it cannot read the app's sessionStorage or call the same-origin API — while its own scripts, print(),
 * dialogs, pop-ups and downloads keep working. No allow-same-origin / allow-top-navigation / allow-forms. Never on PDF / images (Chromium's PDF viewer is blocked by it).
 */
const REPORT_HTML_CSP = "sandbox allow-scripts allow-popups allow-modals allow-downloads";
/** SEL-86: the app's index.html runs only scripts of its own origin (the build has no inline script). No sandbox — the app needs its same-origin sessionStorage. */
const APP_INDEX_CSP = "script-src 'self'";
/** SEL-86: SVG opened as a page runs its scripts like HTML does, so it gets the same sandbox (an <img> of it is not a page — it still shows). Raster images and PDF never do. */
const needs_report_csp = (content_type: string): boolean => /^(text\/html|image\/svg\+xml|(?:text|application)\/(?:xml|xhtml\+xml))\b/i.test(content_type);
const REPORT_TYPES: Record<string, string> = { ".svg": "image/svg+xml; charset=utf-8", ".html": "text/html; charset=utf-8", ".md": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8" };
/** The API error texts the server itself gives (the envelope of ApiApp: Korean message, retryable only for 429/503, next_action a string). */
const API_ERROR_TEXT: Record<string, [string, string]> = {
  forbidden: ["이 요청은 허용되지 않습니다.", "use_owner_session"],
  invalid_payload: ["요청 내용이 올바르지 않습니다.", "fix_request"],
  payload_too_large: ["요청 본문이 너무 큽니다.", "fix_request"],
  internal_error: ["서버 안에서 문제가 생겼습니다. 잠시 뒤 다시 시도해 주세요.", "retry_later"],
  schema_not_ready: ["PES 데이터베이스가 아직 준비되지 않았습니다.", "migrate_database"],
  unauthenticated: ["인증이 필요합니다. 올바른 자격으로 다시 요청해 주세요.", "authenticate"],
};
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
function make_db(root: string): { route: (slug: string) => Promise<"database" | "none" | null>; feedback: Answerer; call: (op: string, slug: string | null, args?: Record<string, unknown>) => Promise<BridgeReply | null>; env: Record<string, string | undefined> } {
  const env: Record<string, string | undefined> = { ...process.env, PES_HOME: root };
  delete env.PES_TOKEN;
  delete env.PES_OWNER;
  let tail: Promise<unknown> = Promise.resolve();
  const bridge = async (op: string, slug: string | null, args: Record<string, unknown>): Promise<BridgeReply | null> => {
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
    env,
    // the project is served by the database once it is active; a name the database does not serve (yet) is an old folder. Asked every time: a project migrated while this server runs is served at once.
    route: async (slug) => {
      const res = await bridge("route", slug, {});
      if (res === null || !res.ok) return null;
      return (res.data as { serving?: string }).serving === "database" ? "database" : "none";
    },
    feedback: (slug, args) => bridge("web_feedback", slug, args),
    call: (op, slug, args = {}) => bridge(op, slug, args),
  };
}

async function start(config: Config): Promise<void> {
  const { root, port } = config;
  // the home this server serves is the PES home; the screens read and write as this computer's human owner, so no credential variable counts
  process.env.PES_HOME = root;
  delete process.env.PES_TOKEN;
  delete process.env.PES_OWNER;
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

  const real_root = ((): string => {
    try {
      return realpathSync.native(root);
    } catch {
      return root;
    }
  })();
  const inside_home = (target: string): boolean => {
    try {
      const real = realpathSync.native(target);
      return real === real_root || real.startsWith(real_root.endsWith(sep) ? real_root : `${real_root}${sep}`);
    } catch {
      return false;
    }
  };

  /**
   * SEL-86: is `file` inside a project's reports/ or out/ folder (the first word under the slug — any project folder, DB or legacy, with or without project.json; or under the home itself when the home is one project)?
   * The AI's HTML lives there, so its text/html gets the sandbox. Judged on the translated path AND on the real path (a link whose real place is reports/ or
   * out/ counts), words compared lower-case (a case-insensitive disk opens `Reports/`).
   */
  const in_report_zone = (file: string): boolean => {
    const zone = (absolute: string, base: string): boolean => {
      const rel = relative(base, absolute);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
      const words = rel.split(sep).filter((word) => word !== "");
      const first_under = (name: string | undefined): boolean => name !== undefined && (name.toLowerCase() === "reports" || name.toLowerCase() === "out");
      if (existsSync(join(root, "project.json")) && first_under(words[0])) return true;
      return words[0] !== undefined && SLUG.test(words[0]) && first_under(words[1]);
    };
    if (zone(file, root)) return true;
    try {
      return zone(realpathSync.native(file), real_root);
    } catch {
      return false;
    }
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
    // a link inside the home that points out of it is not followed (the home is what is served, not the disk)
    if (!inside_home(target)) {
      not_found(req, res);
      return;
    }
    const content_type = guess_type(target);
    const headers: Record<string, string | number> = {
      "Content-Type": content_type,
      "Content-Length": stat.size,
      "Last-Modified": new Date(stat.mtimeMs).toUTCString(),
      "Cache-Control": "no-store",
    };
    if (needs_report_csp(content_type) && in_report_zone(target)) headers["Content-Security-Policy"] = REPORT_HTML_CSP;
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

  /** The folder of the built web app: PES_APP_DIR, else <repo>/app/dist. Read on every request (a build made after the server started is found). */
  const app_dir = (): string => resolve(process.env.PES_APP_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "app", "dist"));

  /** A file of the app folder, or null: no `..` / drive / back-slash word, and the real path (links followed) stays inside the real folder. */
  const app_file = (words: string[]): string | null => {
    try {
      const base = realpathSync.native(app_dir());
      if (words.some((word) => word === "." || word === ".." || /[\\/\0]/.test(word) || /^[A-Za-z]:/.test(word))) return null;
      const real = realpathSync.native(words.length === 0 ? base : join(base, ...words));
      if (real !== base && !real.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)) return null;
      return statSync(real).isFile() ? real : null;
    } catch {
      return null;
    }
  };

  const send_app_file = (req: IncomingMessage, res: ServerResponse, target: string): void => {
    let stat: Stats;
    try {
      stat = statSync(target);
    } catch {
      return not_found(req, res);
    }
    const content_type = guess_type(target);
    const headers: Record<string, string | number> = { "Content-Type": content_type, "Content-Length": stat.size, "Last-Modified": new Date(stat.mtimeMs).toUTCString(), "Cache-Control": "no-store" };
    if (/^text\/html/i.test(content_type)) headers["Content-Security-Policy"] = APP_INDEX_CSP;
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

  /**
   * /p/<slug>/** is the app (its own router reads the rest), /_app/<file> is its build (base "/_app/"). A project name can never start with "_"
   * (SLUG), so the build's address never hides a project's page — unlike "/app/", which a project called "app" owns. Returns true when it answered.
   */
  const handle_app_get = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> => {
    const words = py_unquote(path).split("/").filter((word) => word !== "");
    if (words[0] === "_app" && words.length >= 2) {
      const target = app_file(words.slice(1));
      if (target === null) not_found(req, res);
      else send_app_file(req, res, target);
      return true;
    }
    if (words[0] === "p" && words.length >= 2 && SLUG.test(words[1] as string)) {
      // a project that is itself called "p" keeps its own pages (/p/ping, /p/version, /p/index.html, /p/ask-*.html, /p/reports/…, /p/out/…); every other /p/<slug>/… is still the app
      const second = words[1] as string;
      const own_page = second === "ping" || second === "version" || second === "index.html" || second === "reports" || second === "out" || /^ask-.+\.html$/.test(second);
      if (own_page && (existsSync(join(root, "p", "project.json")) || (await db.route("p")) === "database")) return false;
      const target = app_file(["index.html"]);
      if (target === null) not_found(req, res);
      else send_app_file(req, res, target);
      return true;
    }
    return false;
  };

  const send_html = (req: IncomingMessage, res: ServerResponse, text: string): void => send(req, res, 200, { "Content-Type": "text/html; charset=utf-8" }, text);
  const db_down = (req: IncomingMessage, res: ServerResponse): void => send_json(req, res, 503, { ok: false, error: "db" });

  /**
   * The screens the database builds. Returns true when it answered; false when the address is not one of them (an old project.json folder,
   * a static file such as ask-*.html): the caller goes on with the folder.
   */
  /**
   * A question form page of a project the database serves: the file `pes ask` wrote, with the form version it shows (set_id) and its form key
   * put into its data and the DB screen additions (kept drafts, receipts, conflict notice) behind it — so an answer names the version it answered.
   */
  const serve_ask_form = async (req: IncomingMessage, res: ServerResponse, slug: string, dir: string, name: string, overlay: (page: string, file: string) => string): Promise<boolean> => {
    const file = join(dir, name);
    let page: string;
    try {
      if (!statSync(file).isFile() || !inside_home(file)) return false;
      page = readFileSync(file, "utf8");
    } catch {
      return false;
    }
    const match = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(page);
    if (match === null) return false;
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(match[1] as string);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      data = parsed as Record<string, unknown>;
    } catch {
      return false;
    }
    const form_key = name.slice("ask-".length, -".html".length);
    const spec = data.spec !== null && typeof data.spec === "object" ? (data.spec as Record<string, unknown>) : {};
    const reply = await db.call("form_set", slug, { form_key, ...(typeof spec.stage === "string" ? { stage: spec.stage } : {}) });
    if (reply === null) {
      db_down(req, res);
      return true;
    }
    if (reply.ok && typeof (reply.data as { set_id?: unknown }).set_id === "string") data.set_id = (reply.data as { set_id: string }).set_id;
    data.form_key = form_key;
    const blob = JSON.stringify(data).replace(/<\//g, "<\\/");
    const out = page.slice(0, match.index) + `<script id="data" type="application/json">${blob}</script>` + page.slice(match.index + match[0].length);
    send_html(req, res, overlay(out, "overlay-ask.html"));
    return true;
  };

  const handle_db_get = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> => {
    const parts = py_unquote(path).split("/").filter((part) => part !== "");
    const screens = await import("./pes_core/cli_screens.ts");
    const { Die } = await import("./pes_core/cli_support.ts");
    try {
      if (path === "/version" || (parts.length === 1 && parts[0] === "version")) {
        const reply = await db.call("version", null);
        if (reply === null || !reply.ok) return false; // no database yet: the old file time answers
        send_json(req, res, 200, { v: Number((reply.data as { v?: unknown }).v ?? 0) });
        return true;
      }
      if (parts.length === 0 || (parts.length === 1 && parts[0] === "index.html")) {
        if (existsSync(join(root, "project.json"))) return false; // the home itself is a project (old way)
        let any_dir = false;
        try {
          any_dir = readdirSync(root, { withFileTypes: true }).some((entry) => entry.isDirectory());
        } catch {
          any_dir = false;
        }
        if (!existsSync(join(root, "index.html")) && !any_dir) return false;
        const { db_hub_html } = await import("./pes_core/cli_server.ts");
        send_html(req, res, await db_hub_html(root));
        return true;
      }
      const slug = parts[0] as string;
      if (!SLUG.test(slug) || slug === "ping" || slug === "whoami") return false;
      const tail = parts.slice(1);
      const is_version = tail.length === 1 && tail[0] === "version";
      const is_ping = tail.length === 1 && tail[0] === "ping";
      const is_index = tail.length === 0 || (tail.length === 1 && tail[0] === "index.html");
      const is_report = tail.length > 0 && (tail[0] === "reports" || tail[0] === "out");
      const ask_name = tail.length === 1 && /^ask-.+\.html$/.test(tail[0] as string) ? (tail[0] as string) : null;
      if (!is_version && !is_ping && !is_index && !is_report && ask_name === null) return false;
      const serving = await db.route(slug);
      if (serving === null) {
        db_down(req, res);
        return true;
      }
      if (serving !== "database") return false;
      const dir = join(root, slug);
      if (is_ping) {
        send_json(req, res, 200, { ok: true });
        return true;
      }
      if (ask_name !== null) return await serve_ask_form(req, res, slug, dir, ask_name, screens.with_overlay);
      if (is_version) {
        const reply = await db.call("version", slug);
        if (reply === null || !reply.ok) {
          db_down(req, res);
          return true;
        }
        send_json(req, res, 200, { v: Number((reply.data as { v?: unknown }).v ?? 0) });
        return true;
      }
      if (is_index) {
        if (tail.length === 0) {
          // before the first render the question form is the first page — only for /<slug>/; /<slug>/index.html is always the dashboard
          const base = `/${slug}/`;
          if (path !== base) return false; // /<slug> without the slash: the folder rules (301 for a folder, 302 for an old project.json project)
          if (!existsSync(join(dir, "index.html"))) {
            const asks = ask_forms(dir)
              .map((name) => ({ name, at: mtime_ms(join(dir, name)) }))
              .sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : 1));
            const newest = asks[asks.length - 1];
            if (newest !== undefined) {
              redirect(req, res, 302, base + encodeURI(newest.name));
              return true;
            }
          }
        }
        send_html(req, res, await screens.db_dashboard_html(dir, slug));
        return true;
      }
      // reports, eli5, final report: the database's rendered files at the same address
      const reply = await db.call("report_file", slug, { path: tail.join("/") });
      if (reply === null) {
        db_down(req, res);
        return true;
      }
      if (!reply.ok) {
        // the address of a report / output is the database's, never a file of the folder (a link or a hand-copied file does not answer for it): no such report is the plain 404
        if (reply.code !== "not_found") {
          db_down(req, res);
          return true;
        }
        not_found(req, res);
        return true;
      }
      const data = reply.data as { name: string; bytes_b64: string };
      const report_type = REPORT_TYPES[extname(data.name).toLowerCase()] ?? "application/octet-stream";
      const report_headers: Record<string, string> = { "Content-Type": report_type };
      if (needs_report_csp(report_type)) report_headers["Content-Security-Policy"] = REPORT_HTML_CSP;
      send(req, res, 200, report_headers, Buffer.from(data.bytes_b64, "base64"));
      return true;
    } catch (error) {
      if (error instanceof Die) {
        db_down(req, res);
        return true;
      }
      throw error;
    }
  };

  const handle_get = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = raw_path(req.url);
    if (path === "/whoami") return send_json(req, res, 200, { root, single: true, pid: process.pid }, { cors: true });
    if (await handle_app_get(req, res, path)) return;
    // the retired base of the app build (/app/…, before SEL-82 R1): a project called "app" owns every /app/… address; without one it is a plain 404
    if (py_unquote(path).split("/").filter((word) => word !== "")[0] === "app" && !existsSync(join(root, "app", "project.json")) && (await db.route("app")) !== "database") {
      return not_found(req, res);
    }
    if (await handle_db_get(req, res, path)) return;
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

  // ---------------------------------------------------------------- /api/v1
  const is_api_path = (path: string): boolean => path === "/api/v1" || path.startsWith("/api/v1/");

  const api_error = (req: IncomingMessage, res: ServerResponse, status: number, code: string, options: { close?: boolean; target?: string | null } = {}): void => {
    const [message, next_action] = API_ERROR_TEXT[code] ?? (API_ERROR_TEXT.internal_error as [string, string]);
    const request_id = `serve-${process.hrtime.bigint()}`;
    const body = JSON.stringify({ format_version: "1.0", error: { code, message, retryable: status === 429 || status === 503, target: options.target ?? null, details: null, next_action }, request_id });
    const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8", "x-request-id": request_id };
    if (options.close === true) headers.Connection = "close";
    send(req, res, status, headers, body);
  };

  /** One long-lived API app on its own connection: migrated on the first ACCEPTED API request (a refused cross-origin request never creates the database). */
  let api: { app: ApiApp; db: Db } | "failed" | null = null;
  const ensure_api = async (): Promise<{ app: ApiApp; db: Db } | "failed"> => {
    if (api !== null && api !== "failed") return api;
    try {
      const [{ ApiApp: App }, { SystemClock }, { connect, migrate }, { db_path, objects_dir }, { local_session_secret }] = await Promise.all([
        import("./pes_core/api.ts"),
        import("./pes_core/clock.ts"),
        import("./pes_core/db.ts"),
        import("./pes_core/paths.ts"),
        import("./pes_core/api_secret.ts"),
      ]);
      const env = db.env;
      mkdirSync(dirname(db_path(env)), { recursive: true });
      const handle = connect(db_path(env));
      try {
        migrate(handle);
        api = { app: new App({ db: handle, clock: new SystemClock(), objects_dir: objects_dir(env), local_session_secret: local_session_secret(env) }), db: handle };
      } catch (error) {
        handle.close();
        throw error;
      }
      return api;
    } catch (error) {
      process.stderr.write(`serve.ts: ${error instanceof Error ? error.message : String(error)}\n`);
      return "failed"; // tried again by the next request
    }
  };

  const origin_allowed = (req: IncomingMessage): boolean => {
    const origin = header(req, "origin");
    return origin === "" || allowed.has(origin) || trusted_origins().has(origin);
  };

  /** True when the database exists (not empty), or when the request carries the owner's local session secret (which may create it). */
  const may_create_db = async (req: IncomingMessage): Promise<boolean> => {
    try {
      const [{ db_path }, { existing_local_session_secret }] = await Promise.all([import("./pes_core/paths.ts"), import("./pes_core/api_secret.ts")]);
      try {
        if (statSync(db_path(db.env)).size > 0) return true;
      } catch {
        // no database file
      }
      const secret = existing_local_session_secret(db.env);
      const presented = header(req, "x-pes-session");
      if (secret === null || presented === "") return false;
      const digest = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();
      return digest(presented).equals(digest(secret)) && presented.length === secret.length;
    } catch {
      return false;
    }
  };

  const query_refused = (query: string): boolean => {
    if (query === "") return false;
    if (query.length > MAX_API_QUERY || /[^\x21-\x7e]/.test(query)) return true;
    try {
      decodeURIComponent(query.replace(/\+/g, "%2B"));
      return false;
    } catch {
      return true;
    }
  };

  const handle_api = async (req: IncomingMessage, res: ServerResponse, method: string): Promise<void> => {
    const path = raw_path(req.url);
    const query = query_of(req.url).replace(/^\?/, "");
    if (method !== "GET" && method !== "HEAD" && !origin_allowed(req)) return api_error(req, res, 403, "forbidden");
    const length_text = header(req, "content-length");
    const length = /^\d+$/.test(length_text) ? Number(length_text) : 0;
    if (length > MAX_API_BODY) return reject_oversize(req, res, length, () => api_error(req, res, 413, "payload_too_large", { close: true }));
    const body = length > 0 ? await read_body(req, length) : Buffer.alloc(0);
    if (body === null) return;
    if (query_refused(query)) return api_error(req, res, 400, "invalid_payload", { target: "$.query" });
    // a home without a database (none, or an empty file) gets one only for the owner's session: any other request (an <img> of any page, a
    // token — which no missing database can hold) is 401 before anything is created, so a GET never turns a 0.15 home into a database home (E15)
    if ((api === null || api === "failed") && !(await may_create_db(req))) return api_error(req, res, 401, "unauthenticated");
    const ready = await ensure_api();
    if (ready === "failed") return api_error(req, res, 503, "schema_not_ready");
    const headers_in: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers_in[name.toLowerCase()] = Array.isArray(value) ? (value[0] ?? "") : value;
    const response = await ready.app.handle({ method, path: query === "" ? path : `${path}?${query}`, headers: headers_in, body: new Uint8Array(body) });
    const bytes = response.bytes !== null && response.bytes !== undefined ? Buffer.from(response.bytes) : Buffer.from(JSON.stringify(response.json), "utf8");
    const out: Record<string, string | number> = {};
    for (const [name, value] of Object.entries(response.headers)) {
      const lower = name.toLowerCase();
      if (lower === "content-length" || lower === "connection" || lower === "transfer-encoding") continue;
      if (name === "" || /[\r\n\0:]/.test(name) || /[\r\n\0]/.test(String(value))) continue;
      out[name] = String(value);
    }
    res.writeHead(response.status, { ...out, "Content-Length": bytes.length });
    res.end(method === "HEAD" ? undefined : bytes);
  };

  /** Over the size limit: read a body within the drain limit away first (an upload in progress is not cut off), then answer 413 and close. */
  const reject_oversize = (req: IncomingMessage, res: ServerResponse, length: number, respond?: () => void): void => {
    const answer = (): void => {
      if (res.writableEnded) return;
      if (respond !== undefined) respond();
      else send_json(req, res, 413, { ok: false }, { close: true });
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
      // 0.15 (BaseHTTPRequestHandler.parse_request, gh-87389): leading slashes fold into one, so `//dir` never redirects to the
      // protocol-relative `//dir/` (another host) but to `/dir/` on this origin
      if (req.url?.startsWith("//")) req.url = `/${req.url.replace(/^\/+/, "")}`;
      const method = req.method ?? "GET";
      // /api/v1 first, whatever the folders are called (a folder api/v1 never shadows it)
      if (is_api_path(raw_path(req.url)) && ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"].includes(method)) handle_api(req, res, method).catch(fail);
      else if (method === "GET" || method === "HEAD") handle_get(req, res).catch(fail);
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
    const given_app_dir = process.env.PES_APP_DIR;
    if (given_app_dir !== undefined && given_app_dir !== "") {
      let is_dir = false;
      try {
        is_dir = statSync(app_dir()).isDirectory();
      } catch {
        is_dir = false;
      }
      if (!is_dir) process.stderr.write(`serve.ts: 경고 — PES_APP_DIR 가 가리키는 폴더가 없습니다 (${app_dir()}) — 웹 앱 주소(/p/…, /_app/…)는 404 입니다. 빌드 폴더의 절대 경로를 쓰세요\n`);
      else if (!isAbsolute(given_app_dir)) process.stderr.write(`serve.ts: 경고 — PES_APP_DIR 가 상대 경로입니다 (서버를 켠 폴더 기준으로 읽습니다) — 절대 경로를 쓰세요\n`);
    }
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

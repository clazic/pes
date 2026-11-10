/**
 * SEL-53 PR20a — 보강: the MCP server as a real process (tester, 보강 모드).
 *
 * `node scripts/pes_core/mcp_server.ts` is what Claude Code would start. Here a synthetic parent starts it with an
 * isolated HOME/USERPROFILE/PES_HOME, speaks newline-delimited JSON-RPC on its stdin, and a fake local HTTP server plays
 * PES. No real Claude, no MCP config, no real PES server. Pinned:
 *  - it needs its three variables and refuses a base URL that is not this computer's http address (exit 2, nothing on
 *    stdout, the token nowhere)
 *  - the token goes only to the configured address, in the Authorization header; the defaults of PES_RUNTIME,
 *    PES_PROVIDER and PES_MODEL are the documented ones
 *  - a redirect is never followed (the token cannot be carried to another host); a broken server is a tool error
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { isolated_home } from "./helpers/isolated_home.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_SCRIPT = join(REPO, "scripts", "pes_core", "mcp_server.ts");
const TOKEN = "synthetic-process-token-0123456789";

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

interface Fake {
  server: Server;
  base: string;
  seen: Seen[];
  close(): Promise<void>;
}

async function fake_pes(handler: (req: Seen, res: ServerResponse) => void): Promise<Fake> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const entry: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(entry);
      handler(entry, res);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

function envelope(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
  replies: any[];
}

/** Start the server script with the given variables, feed it messages, close stdin, collect everything. */
function run_server(env_extra: Record<string, string>, messages: unknown[]): Promise<Ran> {
  const home = isolated_home("pes-sel53-proc-");
  const env: Record<string, string | undefined> = { ...home.env };
  for (const name of Object.keys(env)) if (name.startsWith("PES_") && name !== "PES_HOME") delete env[name];
  Object.assign(env, env_extra);
  return new Promise<Ran>((resolve_run, reject) => {
    const child = spawn(process.execPath, [SERVER_SCRIPT], { env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("the server process did not end"));
    }, 30_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      home.cleanup();
      reject(e);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      home.cleanup();
      const stdout = Buffer.concat(out).toString("utf8");
      const replies = stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { not_json: line };
          }
        });
      resolve_run({ status, stdout, stderr: Buffer.concat(err).toString("utf8"), replies });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(messages.map((m) => `${JSON.stringify(m)}\n`).join(""));
  });
}

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "synthetic", version: "0" } } };
const call_tool = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

test("without its variables the process exits 2, says why on stderr only, and never starts serving", async () => {
  const cases: Array<Record<string, string>> = [
    {},
    { PES_PROJECT_ID: "p" },
    { PES_PROJECT_ID: "p", PES_API_BASE_URL: "http://127.0.0.1:1" },
    { PES_PROJECT_ID: "p", PES_AGENT_TOKEN: TOKEN },
    { PES_API_BASE_URL: "http://127.0.0.1:1", PES_AGENT_TOKEN: TOKEN },
    { PES_PROJECT_ID: "", PES_API_BASE_URL: "http://127.0.0.1:1", PES_AGENT_TOKEN: TOKEN },
  ];
  for (const env of cases) {
    const ran = await run_server(env, [init]);
    assert.equal(ran.status, 2, JSON.stringify(Object.keys(env)));
    assert.equal(ran.stdout, "", "nothing but JSON-RPC may ever be on stdout, and there is none");
    assert.match(ran.stderr, /PES_PROJECT_ID/);
    assert.ok(!ran.stderr.includes(TOKEN) && !ran.stdout.includes(TOKEN), "the token is never printed");
  }
});

test("a base URL that is not this computer's plain http address is refused before anything is sent", async () => {
  const spy = await fake_pes((_req, res) => envelope(res, 200, { format_version: "1.0", request_id: "r", data: {} }));
  try {
    for (const base of [
      "http://example.com",
      "https://127.0.0.1:8760",
      "not a url",
      "http://127.0.0.1.evil.example",
      "http://localhost.evil.example",
      "http://127.0.0.1@evil.example",
      "http://evil.example#@127.0.0.1",
      "http://192.168.0.10:8760",
    ]) {
      const ran = await run_server({ PES_PROJECT_ID: "p", PES_API_BASE_URL: base, PES_AGENT_TOKEN: TOKEN }, [init, call_tool(2, "pes_context", {})]);
      assert.equal(ran.status, 2, `base URL ${JSON.stringify(base)}`);
      assert.equal(ran.stdout, "");
      assert.ok(!ran.stderr.includes(TOKEN));
    }
    assert.equal(spy.seen.length, 0, "no request went anywhere");
  } finally {
    await spy.close();
  }
});

test("the token goes in the Authorization header to the configured address only; defaults are the documented ones", async () => {
  const pes = await fake_pes((req, res) => {
    if (req.method === "POST" && req.url.endsWith("/claims")) return envelope(res, 200, { format_version: "1.0", request_id: "r1", data: { run_id: "run-1", lease_id: "lease-1", fence: "1" } });
    return envelope(res, 200, { format_version: "1.0", request_id: "r2", data: { project_id: "synthetic-proj", control_rev: "0", lease: { lease_id: "lease-1" } } });
  });
  try {
    const ran = await run_server({ PES_PROJECT_ID: "synthetic-proj", PES_API_BASE_URL: pes.base, PES_AGENT_TOKEN: TOKEN }, [
      init,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      call_tool(3, "pes_claim", { idempotency_key: "proc-claim" }),
      call_tool(4, "pes_context", {}),
    ]);
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stderr, "");
    assert.ok(ran.replies.every((r) => r.jsonrpc === "2.0"), "stdout is JSON-RPC lines only");
    assert.deepEqual(ran.replies.map((r) => r.id), [1, 2, 3, 4]);
    assert.ok(!ran.stdout.includes(TOKEN), "the token never reaches the client");
    assert.equal(ran.replies[1].result.tools.length, 10);
    assert.equal(ran.replies[2].result.isError, false);

    assert.ok(pes.seen.length >= 3);
    for (const req of pes.seen) {
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      assert.ok(req.url.startsWith("/api/v1/projects/synthetic-proj/"), req.url);
      assert.ok(!req.body.includes(TOKEN), "the token is not in a body");
      assert.ok(!req.url.includes(TOKEN), "the token is not in a URL");
      assert.equal(req.headers["x-pes-session"], undefined, "the MCP server never sends a session header");
    }
    const claim = pes.seen.find((r) => r.method === "POST" && r.url.endsWith("/claims"))!;
    assert.equal(claim.headers["idempotency-key"], "proc-claim");
    assert.deepEqual(JSON.parse(claim.body), { mode: "B", runtime: "claude_code", provider: "anthropic", model: "unknown" }, "documented defaults");
  } finally {
    await pes.close();
  }

  const pes2 = await fake_pes((_req, res) => envelope(res, 200, { format_version: "1.0", request_id: "r", data: { run_id: "run-2", lease_id: "lease-2", fence: "1" } }));
  try {
    const ran = await run_server(
      { PES_PROJECT_ID: "synthetic-proj", PES_API_BASE_URL: pes2.base, PES_AGENT_TOKEN: TOKEN, PES_RUNTIME: "codex_cli", PES_PROVIDER: "openai", PES_MODEL: "synthetic-model-1" },
      [init, call_tool(2, "pes_claim", { idempotency_key: "proc-claim-2" })],
    );
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual(JSON.parse(pes2.seen[0]!.body), { mode: "B", runtime: "codex_cli", provider: "openai", model: "synthetic-model-1" });
  } finally {
    await pes2.close();
  }
});

test("a redirect is never followed: the token cannot be carried to another address", async () => {
  const elsewhere = await fake_pes((_req, res) => envelope(res, 200, { format_version: "1.0", request_id: "r", data: { project_id: "stolen" } }));
  const pes = await fake_pes((_req, res) => {
    res.writeHead(302, { location: `${elsewhere.base}/collect` });
    res.end();
  });
  try {
    const ran = await run_server({ PES_PROJECT_ID: "p", PES_API_BASE_URL: pes.base, PES_AGENT_TOKEN: TOKEN }, [init, call_tool(2, "pes_context", {}), call_tool(3, "pes_claim", { idempotency_key: "redirect-claim" })]);
    assert.equal(ran.status, 0, ran.stderr);
    for (const reply of ran.replies.slice(1)) {
      assert.equal(reply.result.isError, true);
      assert.equal(reply.result.structuredContent.error.code, "unavailable");
      assert.match(reply.result.structuredContent.error.message, /[가-힣]/);
    }
    assert.equal(elsewhere.seen.length, 0, "the other address saw nothing: no token, no body");
    assert.ok(!ran.stdout.includes(TOKEN));
  } finally {
    await pes.close();
    await elsewhere.close();
  }
});

test("a server that answers badly, or hangs up, is a tool error and the process keeps serving", async () => {
  let mode = 0;
  const pes = await fake_pes((_req, res) => {
    mode += 1;
    if (mode === 1) {
      res.writeHead(500, { "content-type": "text/html" });
      res.end("<html>boom</html>");
    } else if (mode === 2) {
      envelope(res, 200, { unexpected: true });
    } else if (mode === 3) {
      res.socket?.destroy();
    } else if (mode === 4) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{ not json");
    } else {
      envelope(res, 200, { format_version: "1.0", request_id: "r", data: { project_id: "synthetic-proj" } });
    }
  });
  try {
    const ran = await run_server({ PES_PROJECT_ID: "p", PES_API_BASE_URL: pes.base, PES_AGENT_TOKEN: TOKEN }, [
      init,
      call_tool(2, "pes_context", {}),
      call_tool(3, "pes_context", {}),
      call_tool(4, "pes_context", {}),
      call_tool(5, "pes_context", {}),
      call_tool(6, "pes_context", {}),
    ]);
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stderr, "");
    const results = ran.replies.slice(1).map((r) => r.result);
    for (const result of results.slice(0, 4)) {
      assert.equal(result.isError, true);
      assert.ok(["internal_error", "unavailable"].includes(result.structuredContent.error.code), result.structuredContent.error.code);
      assert.equal(result.structuredContent.error.retryable, true);
      assert.match(result.structuredContent.error.message, /[가-힣]/);
    }
    assert.equal(results[4].isError, false, "and it still serves the next request");
    assert.ok(!ran.stdout.includes(TOKEN));
    assert.ok(!ran.stdout.includes("boom"), "a server's page is not forwarded to the client");
  } finally {
    await pes.close();
  }
});

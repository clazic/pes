// SEL-103 — the idle-socket regression tests (SEL-95 I1 / I2) are too weak: I1 still passes when `connection: close` is taken out of the helpers
// (a GET succeeds either way), TsServeProcess.request is never run by it, and its 6 s wait sits exactly on Node's 5 s + 1 s keep-alive boundary.
//
// What is tested here instead — deterministic and fast, against a SYNTHETIC server (tests/helpers/idle_socket_server.mjs, a separate process) that sends
// no `Keep-Alive` hint (so fetch/undici keeps a socket pooled for its default 4 s) and RESETS a connection the moment a second request arrives on it:
//   * that is what a client sees when it reuses a socket the server already closed; in the real flake it happens only when the block ends within a
//     few ms of the server's 5 s + 1 s idle timer (a block that is clearly longer than the timer does NOT hit it — undici notices the FIN on resume),
//     so the race is replaced by a rule;
//   * the request after the block is a POST; undici may quietly retry it on a new connection after the reset, so the reuse is read from the server's
//     counters (`reused`, connections vs requests), not only from a thrown `fetch failed` / ECONNRESET (which is asserted too: the POST must be 200);
//   * the server counts connections, requests and reuses, so "every request used its own connection" is also asserted directly (no timing in it);
//   * the long synchronous child is kept (BLOCK_S) as the scenario of SEL-95; it is checked to have really run (status · signal · elapsed).
// Paths covered: http() (web_env), TsServeProcess.request / .post (compat_ts_srv), and TsServeProcess.start()'s readiness probe (the synthetic
// script is started through the `script` option, so the real wait_ready() code runs against it).
// A control (S0) shows the server's counters are sensitive: a bare fetch() without `connection: close` DOES register a reuse in the same scenario.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { request as http_request } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { make_ctx } from "./helpers/compat_env.ts";
import type { TsSrvCtx } from "./helpers/compat_ts_srv.ts";
import { TsServeProcess } from "./helpers/compat_ts_srv.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { free_port, http, post_feedback, type Server } from "./helpers/web_env.ts";

use_home_guard();

const BLOCK_S = 1.5;

const SERVER_FIXTURE = join(import.meta.dirname, "helpers", "idle_socket_server.mjs");

interface Block {
  elapsed_ms: number;
}

/** Block this process's event loop for `seconds` with a synchronous child, and prove the block really happened. */
function block_loop(seconds: number): Block {
  const started = Date.now();
  const run = spawnSync(process.execPath, ["-e", `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${Math.round(seconds * 1000)})`], { encoding: "utf8" });
  const elapsed_ms = Date.now() - started;
  assert.equal(run.error, undefined, `the blocking child started (${String(run.error)})`);
  assert.equal(run.status, 0, `the blocking child ended cleanly (status ${String(run.status)}, signal ${String(run.signal)}): ${run.stderr}`);
  assert.equal(run.signal, null);
  assert.ok(elapsed_ms >= seconds * 1000 - 100, `the loop was really blocked for ~${seconds}s (only ${elapsed_ms} ms)`);
  return { elapsed_ms };
}

interface Stats {
  connections: number;
  requests: number;
  reused: number;
  log: string[];
}

/** The server's counters, read on a connection of their own (this request is counted in both numbers). */
function stats_of(port: number): Promise<Stats> {
  return new Promise((resolve, reject) => {
    const req = http_request({ host: "127.0.0.1", port, path: "/_stats", agent: false, headers: { connection: "close" } }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (chunk: Buffer) => parts.push(chunk));
      res.on("end", () => resolve(JSON.parse(Buffer.concat(parts).toString("utf8")) as Stats));
    });
    req.once("error", reject);
    req.end();
  });
}

let work: ReturnType<typeof make_ctx>;
let ctx: TsSrvCtx;
before(() => {
  work = make_ctx("pes-sel103-idle-");
  mkdirSync(work.narrow_bin, { recursive: true });
  ctx = { home: { root: work.home.root }, env: work.env, narrow_bin: work.narrow_bin, pes_home: work.pes_home, home_dir: work.home_dir };
});
after(() => {
  work?.cleanup();
});

/** TsServeProcess whose `start()` runs the synthetic server (script option) — the real wait_ready() probes it. */
async function started_proc(): Promise<TsServeProcess> {
  const proc = new TsServeProcess(ctx, work.pes_home, { script: SERVER_FIXTURE, ready_timeout_ms: 30_000 });
  await proc.start();
  return proc;
}

/** The synthetic server on its own (for http() and the control), no TsServeProcess. */
async function bare_server(): Promise<{ server: Server; stop(): Promise<void> }> {
  const port = await free_port();
  const child: ChildProcess = spawn(process.execPath, [SERVER_FIXTURE, work.pes_home, String(port)], { env: { ...process.env, HOME: work.home_dir, USERPROFILE: work.home_dir }, stdio: "ignore" });
  for (let i = 0; i < 100; i += 1) {
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/whoami`, { headers: { connection: "close" } });
      if (probe.status === 200) break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const origin = `http://127.0.0.1:${port}`;
  return {
    server: { port, origin, url: origin, stop: async () => undefined },
    stop: async () => {
      child.kill();
      await new Promise<void>((done) => (child.exitCode !== null ? done() : child.once("exit", () => done())));
    },
  };
}

test("S0 control: a bare fetch() (keep-alive pool) reuses an idle socket in the S2 / S3 scenario — the server's counters do register it", async () => {
  const { server, stop } = await bare_server();
  try {
    // undici hands the second request of a fresh pool to a new connection; from the third on it reuses an idle one — hence three requests, like S2 / S3
    const plain = async (path: string, method = "GET"): Promise<string | undefined> =>
      fetch(`${server.url}${path}`, method === "GET" ? {} : { method, body: "{}", headers: { "content-type": "application/json" } }).then((r) => r.text(), () => undefined);
    assert.equal(await plain("/a"), "ok");
    block_loop(BLOCK_S);
    await plain("/b", "POST");
    block_loop(BLOCK_S);
    await plain("/c"); // may be refused (reset socket) or quietly retried by undici; either way the server saw a reuse
    const stats = await stats_of(server.port);
    assert.ok(stats.reused >= 1, `a pooled connection was reused: ${JSON.stringify(stats)}`);
    assert.ok(stats.connections < stats.requests, JSON.stringify(stats));
  } finally {
    await stop();
  }
});

test("S1 TsServeProcess.start() leaves no idle socket behind: readiness probe, long synchronous child, then a POST through .post() succeeds", async () => {
  const proc = await started_proc();
  try {
    block_loop(BLOCK_S);
    const posted = await proc.post("/x/feedback", { text: "합성" });
    assert.equal(posted.status, 200, posted.text());
    const stats = await stats_of(proc.port);
    assert.equal(stats.connections, stats.requests, `every request opened its own connection (readiness probes included): ${JSON.stringify(stats)}`);
    assert.equal(stats.reused, 0, JSON.stringify(stats));
  } finally {
    await proc.stop();
  }
});

test("S2 TsServeProcess.request() itself: GET, long synchronous child, POST, long synchronous child, GET — no ECONNRESET, one connection per request", async () => {
  const proc = await started_proc();
  try {
    assert.equal((await proc.request("/a")).status, 200);
    block_loop(BLOCK_S);
    const posted = await proc.request("/b", { method: "POST", body: "{}", headers: { "content-type": "application/json", origin: proc.origin() } });
    assert.equal(posted.status, 200, posted.text());
    block_loop(BLOCK_S);
    assert.equal((await proc.request("/c")).status, 200);
    const stats = await stats_of(proc.port);
    assert.equal(stats.connections, stats.requests, JSON.stringify(stats));
    assert.equal(stats.reused, 0, JSON.stringify(stats));
    assert.deepEqual(stats.log.filter((line) => /^(GET|POST) \/[abc]$/.test(line)), ["GET /a", "POST /b", "GET /c"]);
  } finally {
    await proc.stop();
  }
});

test("S3 http() of web_env: GET, long synchronous child, POST through post_feedback, long synchronous child, GET — no ECONNRESET, one connection per request", async () => {
  const { server, stop } = await bare_server();
  try {
    assert.equal((await http(server, "/a")).status, 200);
    block_loop(BLOCK_S);
    const posted = await post_feedback(server, "demo", { text: "합성 idle 소켓" });
    assert.equal(posted.status, 200, posted.text);
    block_loop(BLOCK_S);
    assert.equal((await http(server, "/c")).status, 200);
    const stats = await stats_of(server.port);
    assert.equal(stats.reused, 0, JSON.stringify(stats));
    // every request (the /whoami wait of bare_server, the 3 helper requests, this /_stats one) on a connection of its own
    assert.equal(stats.connections, stats.requests, JSON.stringify(stats));
    assert.deepEqual(stats.log.filter((line) => /^(GET|POST) \/(a|c|demo\/feedback)$/.test(line)), ["GET /a", "POST /demo/feedback", "GET /c"]);
  } finally {
    await stop();
  }
});

test("S4 the readiness probe alone is enough to catch a missing `connection: close`: start(), long synchronous child, a POST — and the probe left no pooled connection", async () => {
  const proc = await started_proc();
  try {
    const before_block = await stats_of(proc.port);
    assert.ok(before_block.requests >= 2, `at least one /whoami probe and this /_stats request: ${JSON.stringify(before_block)}`);
    assert.equal(before_block.connections, before_block.requests, `no probe request reused a connection: ${JSON.stringify(before_block)}`);
    assert.equal(before_block.reused, 0, JSON.stringify(before_block));
    block_loop(BLOCK_S);
    const posted = await proc.post("/y", {});
    assert.equal(posted.status, 200, posted.text());
  } finally {
    await proc.stop();
  }
});

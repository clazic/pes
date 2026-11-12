// SEL-95 — a test helper must not leave an idle keep-alive socket in fetch()'s pool: while a synchronous child (step() → spawnSync) blocks this
// process's event loop, the server closes the idle socket (Node's keepAliveTimeout is 5 s) and the next fetch() reuses the dead one → "fetch failed:
// read ECONNRESET". That made H9 (test_web_hardening_state) and H6c (test_web_hardening_http) fail now and then in a full, loaded `npm test`.
// Here the block is made long on purpose (7 s: clearly past Node's 5 s keepAliveTimeout + 1 s, not sitting on that boundary), so the race is not left to the machine's load.
//
// SEL-103 kept these two (they run the REAL scripts/serve.ts end to end, which the synthetic-server tests of test_sel103_idle_socket.test.ts do not), and made them
// stricter: the request after the block is a POST (fetch does not retry a POST, so a reused dead socket cannot be hidden by a quiet retry — a GET could), and the
// blocking child itself is checked (it started, ended cleanly, and really blocked for the time asked). The deterministic counter tests of SEL-103 (S1~S4) are the
// ones that catch a missing `connection: close` regardless of timing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";

import type { CliEnv } from "./helpers/cli_write_env.ts";
import { db_with_form, http, post_feedback, feedback_body, SLUG, start_server, type Server } from "./helpers/web_env.ts";
import { use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

let c: CliEnv;
let s: Server;
before(async () => {
  c = await db_with_form();
  s = await start_server(c);
});
after(async () => {
  await s?.stop();
  c?.close();
});

const BLOCK_S = 7;

/** Blocks this process's event loop with a synchronous child — and proves the child ran and blocked for the time asked. */
const block_loop = (seconds: number): void => {
  const started = Date.now();
  const run = spawnSync(process.execPath, ["-e", `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${seconds * 1000})`], { encoding: "utf8" });
  const elapsed_ms = Date.now() - started;
  assert.equal(run.error, undefined, `the blocking child started (${String(run.error)})`);
  assert.equal(run.status, 0, `the blocking child ended cleanly (status ${String(run.status)}, signal ${String(run.signal)}): ${run.stderr}`);
  assert.ok(elapsed_ms >= seconds * 1000 - 100, `the loop was really blocked for ~${seconds}s (only ${elapsed_ms} ms)`);
};

test("I1 first request after start_server, a long synchronous child, then a POST (fetch does not retry it): no ECONNRESET (the readiness probe leaves no idle socket)", async () => {
  block_loop(BLOCK_S);
  const post = await post_feedback(s, SLUG, feedback_body({ text: "합성 idle 소켓 I1", answers: { memo: "idle-1" } }));
  assert.equal(post.status, 200, post.text);
});

test("I2 request, a long synchronous child, a POST (not retried by fetch), then a GET: no ECONNRESET", async () => {
  assert.equal((await http(s, `/${SLUG}/version`)).status, 200);
  block_loop(BLOCK_S);
  const post = await post_feedback(s, SLUG, feedback_body({ text: "합성 idle 소켓", answers: { memo: "idle" } }));
  assert.equal(post.status, 200, post.text);
  block_loop(BLOCK_S);
  assert.equal((await http(s, `/${SLUG}/version`)).status, 200);
});

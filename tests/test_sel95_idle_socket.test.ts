// SEL-95 — a test helper must not leave an idle keep-alive socket in fetch()'s pool: while a synchronous child (step() → spawnSync) blocks this
// process's event loop, the server closes the idle socket (Node's keepAliveTimeout is 5 s) and the next fetch() reuses the dead one → "fetch failed:
// read ECONNRESET". That made H9 (test_web_hardening_state) and H6c (test_web_hardening_http) fail now and then in a full, loaded `npm test`.
// Here the block is made long on purpose (6 s), so the race is not left to the machine's load.
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

const block_loop = (seconds: number): void => {
  spawnSync(process.execPath, ["-e", `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${seconds * 1000})`]);
};

test("I1 first request after start_server, a long synchronous child, then another request: no ECONNRESET (the readiness probe leaves no idle socket)", async () => {
  block_loop(6);
  const r = await http(s, `/${SLUG}/version`);
  assert.equal(r.status, 200, r.text);
});

test("I2 request, a long synchronous child, a POST (not retried by fetch), then a GET: no ECONNRESET", async () => {
  assert.equal((await http(s, `/${SLUG}/version`)).status, 200);
  block_loop(6);
  const post = await post_feedback(s, SLUG, feedback_body({ text: "합성 idle 소켓", answers: { memo: "idle" } }));
  assert.equal(post.status, 200, post.text);
  block_loop(6);
  assert.equal((await http(s, `/${SLUG}/version`)).status, 200);
});

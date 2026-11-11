// SEL-74 G2 — ensure_server ends a server child that has not answered within its 20 seconds (it must not outlive the failed `serve`).
// Own file: the test waits the full 20 seconds (Windows is slower — the timeout is generous). A test-only `--import` module makes serve.ts
// start but never listen, so the child stays alive without answering /whoami.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { free_port } from "./helpers/compat_env.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { pes_ts, with_ctx } from "./helpers/sel74_env.ts";

use_home_guard();

const HANG_MODULE = join(import.meta.dirname, "helpers", "ts_inject_hang_serve.ts");
const SLUG = "g-시험";

test("G2: `serve` ends the server child that did not answer within 20 seconds — it does not outlive the failed command", { timeout: 180_000 }, async () => {
  await with_ctx("pes-sel74-g2-", async (ctx) => {
    assert.equal(pes_ts(ctx, ["init", join(ctx.pes_home, SLUG), "--topic", "합성 주제"]).status, 0);
    const port = await free_port();
    const pid_file = join(ctx.home.root, "hang-pids.txt");
    const started = Date.now();
    const run = pes_ts(ctx, ["serve", join(ctx.pes_home, SLUG)], {
      allow_child_process: true,
      imports: [HANG_MODULE],
      timeout_ms: 150_000,
      env: { PES_HUB_PORTS: `${port}-${port}`, PES_TEST_HANG_PID_FILE: pid_file, PES_NO_BROWSER: "1" },
    });
    const pids = existsSync(pid_file) ? readFileSync(pid_file, "utf8").split("\n").filter((x) => x !== "").map(Number) : [];
    try {
      assert.equal(pids.length, 1, `exactly one server child was started (stderr: ${run.stderr})`);
      assert.equal(run.status, 1, "the command fails when the server never answers");
      assert.match(run.stderr, /서버가 시작되지 않았습니다/, "the one Korean line stays");
      assert.ok(Date.now() - started >= 15_000, "the wait is the 20 seconds, not an early give-up");
      assert.equal(existsSync(join(ctx.pes_home, ".pes-hub-server")), false, "the record of a server that never answered is removed");
      // the child must be gone shortly after the command returned
      const deadline = Date.now() + 10_000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        try {
          process.kill(pids[0] as number, 0);
          await new Promise((r) => setTimeout(r, 200));
        } catch {
          alive = false;
        }
      }
      assert.equal(alive, false, `the unresponsive server child (pid ${pids[0]}) was ended`);
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL"); // clean up even when the assertion above failed (the product left it running)
        } catch {
          // already gone
        }
      }
    }
  });
});


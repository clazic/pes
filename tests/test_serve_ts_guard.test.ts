// SEL-72 (PR26c): the TS child guard (ts_child_guard.ts + --permission) is really applied to serve.ts and setup.ts, and a server
// that tries to read the "real" PES home is stopped and reported. The "real" home here is a FAKE folder (a second temp folder), so
// nothing real is ever touched; the same fake-home technique as tests/test_home_guard.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { make_ctx } from "./helpers/compat_env.ts";
import {
  NO_REVERSE_DNS_MODULE,
  SERVE_TS_FILE,
  SETUP_TS_FILE,
  TS_GUARD_MODULE,
  TsServeProcess,
  run_ts_setup,
  ts_srv_argv,
} from "./helpers/compat_ts_srv.ts";
import { real_homes, use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

test("the child argv of serve.ts and setup.ts carries the permission allow-list and the guard import (no real home in it, no child process by default)", () => {
  const ctx = make_ctx("pes-srv-guard-");
  try {
    for (const script of [SERVE_TS_FILE, SETUP_TS_FILE]) {
      const argv = ts_srv_argv(ctx, script, ["x"]);
      assert.ok(argv.includes("--permission"), "permission model on");
      const imp = argv.indexOf("--import");
      assert.ok(imp >= 0 && argv[imp + 1] === pathToFileURL(TS_GUARD_MODULE).href, "the guard is the first --import");
      assert.ok(!argv.includes("--allow-child-process"), "no child process unless a case asks");
      assert.ok(argv.includes("--allow-net"), "sockets are allowed (the hub ports are refused by the guard, not by the permission model)");
      // the repo may live below the real home (a developer checkout), so the test is per entry: nothing equals the real home, contains
      // it (an ancestor), or lies inside its .pes / pes-projects
      const entries = argv.filter((a) => a.startsWith("--allow-fs-")).map((a) => a.replace(/^--allow-fs-(read|write)=/, "").replace(/[\\/]\*$/, ""));
      assert.ok(entries.length >= 4, "read + write entries");
      const fold = (p: string): string => resolve(p).toLowerCase();
      for (const home of real_homes()) {
        for (const entry of entries) {
          const e = fold(entry);
          const h = fold(home);
          assert.notEqual(e, h, `allow-list entry ${entry} is the real home`);
          assert.ok(!h.startsWith(e + sep), `allow-list entry ${entry} contains the real home ${home}`);
          for (const name of [".pes", "pes-projects"]) assert.ok(!(e === join(h, name) || e.startsWith(join(h, name) + sep)), `allow-list entry ${entry} is inside the real ${name}`);
        }
      }
      assert.ok(argv.indexOf(script) > imp, "the script comes after the flags");
    }
    assert.ok(ts_srv_argv(ctx, SETUP_TS_FILE, ["keys"], { allow_child_process: true }).includes("--allow-child-process"));
    const server = new TsServeProcess(ctx, ctx.pes_home);
    const argv = server.argv(54321);
    assert.ok(argv.includes(pathToFileURL(NO_REVERSE_DNS_MODULE).href), "serve.ts always runs with the reverse-DNS probe");
    assert.deepEqual(argv.slice(-2), [ctx.pes_home, "54321"], "the injected port is the last argument");
  } finally {
    ctx.cleanup();
  }
});

test("a serve.ts that reads below the (fake) real PES home is reported: PESHomeAccessViolation, and the file's content never leaves the server", { timeout: 60_000 }, async () => {
  const ctx = make_ctx("pes-srv-fake-real-");
  const fake_home = realpathSync.native(mkdtempSync(join(tmpdir(), "pes-fake-real-home-")));
  try {
    const projects = join(fake_home, "pes-projects");
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, "index.html"), "<html>FAKE-REAL-HOME-MARKER</html>", "utf8");
    const server = new TsServeProcess(ctx, projects, { real_homes: [fake_home], expect_violation: true, ready_timeout_ms: 8000 });
    let leaked = false;
    try {
      await server.start();
      const answer = await server.request("/index.html");
      leaked = answer.text().includes("FAKE-REAL-HOME-MARKER");
      await server.request("/anything/");
    } catch {
      // the server may refuse to start at all: also fine, the log is judged below
    } finally {
      await server.stop();
    }
    assert.equal(leaked, false, "the marker inside the fake real home must not be served");
    assert.match(server.log, /PESHomeAccessViolation|ERR_ACCESS_DENIED/, "the attempt must be reported (guard) or denied (permission model)");
  } finally {
    ctx.cleanup();
    rmSync(fake_home, { recursive: true, force: true });
  }
});

test("a setup.ts that is pointed below the (fake) real home is stopped too", { timeout: 60_000 }, () => {
  const ctx = make_ctx("pes-setup-fake-real-");
  const fake_home = realpathSync.native(mkdtempSync(join(tmpdir(), "pes-fake-real-home-")));
  try {
    mkdirSync(join(fake_home, ".pes"), { recursive: true });
    writeFileSync(join(fake_home, ".pes", "setup.json"), JSON.stringify({ version: "0", time: "x", state: {} }), "utf8");
    // HOME of the child IS the fake real home → the isolated-env check refuses before anything is spawned
    assert.throws(() => run_ts_setup(ctx, ["needed"], { env: { HOME: fake_home, USERPROFILE: fake_home }, real_homes: [fake_home] }), /home guard/);
  } finally {
    ctx.cleanup();
    rmSync(fake_home, { recursive: true, force: true });
  }
});

// SEL-74 G — the three server-safety recommendations of the SEL-77 final review. Written before the fixes: these fail until the code has them.
//   G1  kill_recorded compares the pid in the /whoami answer with the pid in the record; different (or not given) → nothing is signalled.
//       The real serve.ts therefore answers /whoami with its own pid.
//   G2  (own file: test_sel74_g2_hung_server.test.ts — it waits the 20 seconds)
//   G3  a hub port range of the developer's shell never reaches a test child (shared helpers drop PES_HUB_PORTS; an explicit value still works).
// Safety: temporary HOME / USERPROFILE / PES_HOME; ts_child_guard.ts + hub block; process.kill is a recorder in the child (nothing is sent).
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { free_port, make_ctx, type CompatCtx } from "./helpers/compat_env.ts";
import { ts_child_env } from "./helpers/compat_ts.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { isolated_home } from "./helpers/isolated_home.ts";
import { serve_fixture } from "./helpers/serve_ts_env.ts";
import { pes_ts, pes_ts_async, with_ctx } from "./helpers/sel74_env.ts";

use_home_guard();

const KILL_MODULE = join(import.meta.dirname, "helpers", "ts_inject_kill.ts");
const HANG_MODULE = join(import.meta.dirname, "helpers", "ts_inject_hang_serve.ts");
const SLUG = "g-시험";

type Kill = { pid: unknown; signal: unknown };
const kills_of = (log: string): Kill[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Kill) : []);

/** A stand-in hub: answers /whoami with the given body. */
async function stand_in(port: number, body: () => unknown): Promise<Server> {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(req.url === "/whoami" ? JSON.stringify(body()) : "{}");
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => done());
  });
  return server;
}

async function stop_with_record(ctx: CompatCtx, port: number, record_pid: number): Promise<{ status: number | null; kills: Kill[]; stderr: string }> {
  const project = join(ctx.pes_home, SLUG);
  const log = join(ctx.home.root, `kills-${record_pid}.log`);
  rmSync(log, { force: true });
  writeFileSync(join(ctx.pes_home, ".pes-hub-server"), JSON.stringify({ pid: record_pid, port }), "utf8");
  const run = await pes_ts_async(ctx, ["stop", project], { allow_hub_port: port, imports: [KILL_MODULE], env: { PES_HUB_PORTS: `${port}-${port}`, PES_TEST_KILL_LOG: log } });
  return { status: run.status, kills: kills_of(log), stderr: run.stderr };
}

test("G1: `stop` signals the recorded pid only when the /whoami answer of that port names the same pid", { timeout: 240_000 }, async () => {
  await with_ctx("pes-sel74-g1-", async (ctx) => {
    assert.equal(pes_ts(ctx, ["init", join(ctx.pes_home, SLUG), "--topic", "합성 주제"]).status, 0);
    const port = await free_port();
    const home_root = realpathSync.native(ctx.pes_home); // the product names the home by its real path (macOS /private, Windows long names)
    let answer: Record<string, unknown> = {};
    const server = await stand_in(port, () => answer);
    try {
      // the port answers as this home's server but with ANOTHER pid than the record: the record is stale, the pid belongs to some other program now
      answer = { root: home_root, single: true, pid: 111111 };
      const other = await stop_with_record(ctx, port, 222222);
      assert.equal(other.status, 0, other.stderr);
      assert.deepEqual(other.kills, [], "a different pid in the /whoami answer: nothing is signalled");
      // an answer that names no pid (an older server) cannot confirm the record: nothing is signalled either
      answer = { root: home_root, single: true };
      const none = await stop_with_record(ctx, port, 222222);
      assert.equal(none.status, 0, none.stderr);
      assert.deepEqual(none.kills, [], "an answer without pid cannot confirm the record");
      // a pid that is not a number in the answer
      for (const bad of ["111111", null, 111111.5, -1]) {
        answer = { root: home_root, single: true, pid: bad };
        const run = await stop_with_record(ctx, port, 111111);
        assert.deepEqual(run.kills, [], `pid ${JSON.stringify(bad)} in the answer does not confirm the record`);
      }
      // control: the same pid in the answer and in the record is the server this home started → one SIGTERM for exactly that pid
      answer = { root: home_root, single: true, pid: 111111 };
      const same = await stop_with_record(ctx, port, 111111);
      assert.equal(same.status, 0, same.stderr);
      assert.deepEqual(same.kills, [{ pid: 111111, signal: "SIGTERM" }], "control: matching pids are stopped by the record");
    } finally {
      server.close();
    }
  });
});

test("G1: the real serve.ts answers /whoami with {root, single, pid} and the pid is the server's own process id", { timeout: 120_000 }, async () => {
  const fx = await serve_fixture("pes-sel74-g1-real-");
  try {
    const response = await fetch(`${fx.server.origin()}/whoami`);
    const info = (await response.json()) as { root?: unknown; single?: unknown; pid?: unknown };
    assert.equal(info.single, true);
    assert.equal(typeof info.root, "string");
    assert.equal(typeof info.pid, "number", "/whoami carries the server's pid");
    assert.equal(info.pid, fx.server.proc?.pid, "the pid in the answer is the pid of the server process");
  } finally {
    await fx.cleanup();
  }
});

test("G3: PES_HUB_PORTS of the developer's shell never reaches a test child; an explicit value in the run options still does", () => {
  const before = process.env.PES_HUB_PORTS;
  process.env.PES_HUB_PORTS = "8760-8760";
  try {
    const home = isolated_home("pes-sel74-g3-");
    const ctx = make_ctx("pes-sel74-g3b-");
    try {
      assert.equal(home.env.PES_HUB_PORTS, undefined, "isolated_home() env");
      assert.equal(ctx.env.PES_HUB_PORTS, undefined, "make_ctx() env");
      assert.equal(ts_child_env(ctx).PES_HUB_PORTS, undefined, "ts_child_env() default");
      assert.equal(ts_child_env(ctx, { env: { PES_HUB_PORTS: "49300-49300" } }).PES_HUB_PORTS, "49300-49300", "an explicit range is kept");
    } finally {
      home.cleanup();
      ctx.cleanup();
    }
  } finally {
    if (before === undefined) delete process.env.PES_HUB_PORTS;
    else process.env.PES_HUB_PORTS = before;
  }
});

test("G3: a real child run with the shell's range set sees none of it — `doctor` asks no hub port of that range", { timeout: 120_000 }, async () => {
  const before = process.env.PES_HUB_PORTS;
  process.env.PES_HUB_PORTS = "8762-8762"; // inside the real range: the hub block would log an attempt if it reached the child
  try {
    await with_ctx("pes-sel74-g3c-", (ctx) => {
      const run = pes_ts(ctx, ["list"]);
      assert.equal(run.status, 0, run.stderr);
      assert.ok(run.hub_attempts.every((p) => p !== 8762), `the child asked port 8762 (${run.hub_attempts.join(",")}) — the shell's range leaked in`);
    });
  } finally {
    if (before === undefined) delete process.env.PES_HUB_PORTS;
    else process.env.PES_HUB_PORTS = before;
  }
  void pathToFileURL;
});

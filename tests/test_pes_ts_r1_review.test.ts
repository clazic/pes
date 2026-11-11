// SEL-77 1st review (R1, logs/SEL-77-r1.md) — the tester's half, written before the fixes: these fail until the code has them.
//   必1·권장9  a pid taken from `.pes-hub-server` / `.pes-server` is signalled only when it is a safe integer > 1, and a server that answers
//              `/whoami` with a root outside the PES home is never touched (process.kill is replaced by a recorder in the child: nothing is sent)
//   권장4     NaN / Infinity in project.json → one Korean line "지원하지 않는 값", exit 1, folder untouched; a BOM is tolerated (intended difference)
//   권장5     `current` missing / not a stage name → one Korean line, exit 1 (D11), folder untouched
//   권장6     the rest of the read commands on a broken project.json — serve · hub · open · list · watch · doctor — with their exit codes pinned
//   (doctor --json exit: the 0.15 path the user runs has no PES_DB_CORE, so `--json` ends with 0 even with a `bad` row — pinned in
//    test_pes_ts_read_serve.test.ts (a); recorder self-test below.)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { looks_like_stack_trace, norm_out } from "./helpers/compat_cases.ts";
import { free_port, make_ctx, pes, synthetic_project, walk_files, type CompatCtx } from "./helpers/compat_env.ts";
import { run_ts_cli, run_ts_cli_async, type TsRunOptions } from "./helpers/compat_ts.ts";
import { use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

const KILL_MODULE = join(import.meta.dirname, "helpers", "ts_inject_kill.ts");
const SLUG = "kill-시험";

type Kill = { pid: unknown; signal: unknown };

function kills_of(log: string): Kill[] {
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Kill) : [];
}

/** run_ts_cli with the kill recorder in the child; returns what the child TRIED to signal (nothing is sent). */
function recorded(ctx: CompatCtx, args: string[], extra: TsRunOptions = {}): { run: ReturnType<typeof run_ts_cli>; kills: Kill[] } {
  const log = join(ctx.home.root, "kills.log");
  rmSync(log, { force: true });
  const run = run_ts_cli(ctx, args, { ...extra, imports: [KILL_MODULE], env: { ...(extra.env ?? {}), PES_TEST_KILL_LOG: log } });
  return { run, kills: kills_of(log) };
}

test("recorder self-test: process.kill with a real signal is recorded and NOT sent; signal 0 is a real probe", () => {
  const ctx = make_ctx("pes-ts-kill-self-");
  try {
    const log = join(ctx.home.root, "self.log");
    const code = "process.kill(424242,'SIGTERM'); process.kill(0,'SIGKILL'); process.kill(-1,'SIGTERM'); let e=''; try{process.kill(2147483646,0)}catch(x){e=x.code} process.stdout.write('probe:'+e)";
    const out = spawnSync(process.execPath, ["--import", pathToFileURL(KILL_MODULE).href, "-e", code], { env: { ...ctx.env, PES_TEST_KILL_LOG: log }, encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(kills_of(log), [{ pid: 424242, signal: "SIGTERM" }, { pid: 0, signal: "SIGKILL" }, { pid: -1, signal: "SIGTERM" }]);
    assert.equal(out.stdout, "probe:ESRCH", "signal 0 is passed through (a pid that does not exist)");
  } finally {
    ctx.cleanup();
  }
});

// A pid is signalled only when Number.isSafeInteger(pid) && pid > 1 — never null (→ 0 = own process group), 0, -1 (= every process of the user), 1, a string, a fraction, a huge number.
const BAD_PIDS: unknown[] = [null, 0, -1, 1, "4242", 1.5, "abc", 1e300, true, undefined];

test("필수 1: `stop` never signals a pid that is not a safe integer > 1 — from .pes-hub-server (the home) or .pes-server (the project), exit 0, nothing sent", { timeout: 240_000 }, async () => {
  const ctx = make_ctx("pes-ts-kill-stop-");
  try {
    const port = await free_port();
    const project = join(ctx.pes_home, SLUG);
    assert.equal(run_ts_cli(ctx, ["init", project, "--topic", "합성 주제"]).status, 0);
    for (const pid of BAD_PIDS) {
      const label = `pid=${JSON.stringify(pid) ?? "(missing)"}`;
      writeFileSync(join(ctx.pes_home, ".pes-hub-server"), JSON.stringify({ pid, port }), "utf8");
      writeFileSync(join(project, ".pes-server"), JSON.stringify({ pid }), "utf8");
      writeFileSync(join(project, ".pes-port"), String(port), "utf8");
      const { run, kills } = recorded(ctx, ["stop", project], { env: { PES_HUB_PORTS: `${port}-${port}` } });
      assert.equal(run.status, 0, `${label}: ${run.stderr}`);
      assert.deepEqual(kills, [], `${label}: the product tried to signal ${JSON.stringify(kills)}`);
      assert.ok(!looks_like_stack_trace(run.stderr.split("\n")), `${label}: stack trace`);
    }
  } finally {
    ctx.cleanup();
  }
});

test("필수 1: `doctor --fix` removes a stale .pes-server record without signalling a pid that is not a safe integer > 1", { timeout: 240_000 }, () => {
  const ctx = make_ctx("pes-ts-kill-fix-");
  try {
    const project = join(ctx.pes_home, SLUG);
    assert.equal(run_ts_cli(ctx, ["init", project, "--topic", "합성 주제"]).status, 0);
    for (const pid of [null, -1, 1]) {
      writeFileSync(join(project, ".pes-server"), JSON.stringify({ pid }), "utf8");
      const { run, kills } = recorded(ctx, ["doctor", project, "--fix"], { narrow_path: true, extra_read: [ctx.narrow_bin], allow_child_process: true });
      assert.ok(run.status === 0 || run.status === 1, `pid=${pid}: ${run.stderr}`);
      assert.deepEqual(kills, [], `pid=${pid}: the product tried to signal ${JSON.stringify(kills)}`);
    }
  } finally {
    ctx.cleanup();
  }
});

/** A stand-in "old per-project server": answers /whoami with `root`. It listens on the first free port of 8765~8775 (the legacy range — the loader refuses all of them but the ONE allowed). */
async function legacy_stand_in(answer: () => string): Promise<{ port: number; server: Server }> {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(req.url === "/whoami" ? JSON.stringify({ root: answer(), single: false }) : "{}");
  });
  for (let port = 8765; port <= 8775; port += 1) {
    const ok = await new Promise<boolean>((done) => {
      server.once("error", () => done(false));
      server.listen(port, "127.0.0.1", () => done(true));
    });
    if (ok) return { port, server };
  }
  throw new Error("no free port in 8765~8775 for the stand-in");
}

test("권장 9: `doctor --fix` stops an old server only when the root it answers is inside the PES home — a root outside it is left alone (no signal, record files stay)", { timeout: 240_000 }, async () => {
  const ctx = make_ctx("pes-ts-kill-root-");
  let root = "";
  const { port, server } = await legacy_stand_in(() => root);
  try {
    const outside = join(ctx.tmp, "outside-proj");
    const inside = join(ctx.pes_home, "inside-proj");
    for (const dir of [outside, inside]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".pes-server"), JSON.stringify({ pid: 424242, port }), "utf8");
      writeFileSync(join(dir, ".pes-port"), String(port), "utf8");
    }
    const fix = async (answers: string): Promise<{ kills: Kill[]; status: number | null }> => {
      root = answers;
      const log = join(ctx.home.root, "kills.log");
      rmSync(log, { force: true });
      const run = await run_ts_cli_async(ctx, ["doctor", "--fix"], { narrow_path: true, extra_read: [ctx.narrow_bin], allow_hub_port: port, imports: [KILL_MODULE], env: { PES_TEST_KILL_LOG: log } });
      return { kills: kills_of(log), status: run.status };
    };
    const out = await fix(outside);
    assert.deepEqual(out.kills, [], "a root outside the PES home must not be touched (any local program can answer /whoami with any path)");
    assert.ok(existsSync(join(outside, ".pes-server")) && existsSync(join(outside, ".pes-port")), "and its record files stay");
    // control: the same stand-in answering a folder INSIDE the home is the old server doctor is meant to stop — the recorder sees exactly one SIGTERM for its pid
    const inn = await fix(inside);
    assert.deepEqual(inn.kills, [{ pid: 424242, signal: "SIGTERM" }], "control: a root inside the home is stopped by its record");
  } finally {
    server.close();
    ctx.cleanup();
  }
});

// ------------------------------------------------------------------------------------------------ project.json shapes
const fingerprint = (dir: string): string => JSON.stringify(walk_files(dir).map((rel) => [rel, readFileSync(join(dir, ...rel.split("/"))).toString("hex"), statSync(join(dir, ...rel.split("/"))).mtimeMs]));

function base_text(slug: string, extra = ""): string {
  return `{"pes": 1, "topic": "합성 주제", "slug": "${slug}", "current": "plan", "processed": [], "notes": [], "stages": {}${extra}}`;
}

function put(ctx: CompatCtx, name: string, text: string): string {
  const dir = join(ctx.tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "project.json"), text, "utf8");
  return dir;
}

function one_korean_line(run: ReturnType<typeof run_ts_cli>, label: string): string {
  assert.equal(run.status, 1, `${label}: exit (stdout=${run.stdout} stderr=${run.stderr})`);
  const lines = run.stderr.split("\n").filter((l) => l !== "");
  assert.equal(lines.length, 1, `${label}: one stderr line, got ${JSON.stringify(run.stderr)}`);
  assert.match(lines[0] as string, /[가-힣]/, `${label}: Korean`);
  assert.ok(!looks_like_stack_trace(lines), `${label}: no stack trace`);
  assert.equal(run.stdout, "", `${label}: nothing on stdout`);
  return lines[0] as string;
}

test("권장 4: NaN / Infinity in project.json (Python accepts them, JSON.parse does not) → exit 1 and one Korean line that says the value is not supported; the folder is untouched", { timeout: 240_000 }, () => {
  const ctx = make_ctx("pes-ts-nan-");
  try {
    for (const [name, token] of [["nan", "NaN"], ["inf", "Infinity"], ["neg", "-Infinity"]] as const) {
      const dir = put(ctx, `nan-${name}`, base_text(`nan-${name}`, `, "score": ${token}`));
      const before = fingerprint(dir);
      for (const args of [["status", dir], ["show", dir, "plan"]]) {
        const line = one_korean_line(run_ts_cli(ctx, args), `${token} ${args[0]}`);
        assert.match(line, /지원하지 않는 값/, `${token} ${args[0]}: says why (not an English parser message): ${line}`);
        assert.doesNotMatch(line, /Unexpected token|JSON\.parse|예상하지 못한 오류/, `${token} ${args[0]}: ${line}`);
        assert.equal(fingerprint(dir), before, `${token} ${args[0]}: the folder changed`);
      }
    }
  } finally {
    ctx.cleanup();
  }
});

test("권장 4: a BOM at the start of project.json is tolerated (intended difference: 0.15 stops with JSONDecodeError) — same output as the same file without it, folder untouched", { timeout: 120_000 }, () => {
  const ctx = make_ctx("pes-ts-bom-");
  try {
    const plain = put(ctx, "bom-plain/proj", base_text("proj"));
    const bom = put(ctx, "bom-with/proj", `﻿${base_text("proj")}`);
    const before = fingerprint(bom);
    const roots = (dir: string) => ({ PROJECT: dir, HOME: ctx.home_dir, TMP: ctx.home.root });
    for (const args of [["status"], ["pending"]]) {
      const want = run_ts_cli(ctx, [args[0] as string, plain]);
      const got = run_ts_cli(ctx, [args[0] as string, bom]);
      assert.equal(want.status, 0, want.stderr);
      assert.equal(got.status, 0, `${args[0]}: ${got.stderr}`);
      assert.equal(got.stderr, "");
      assert.deepEqual(norm_out(got.stdout, roots(bom)), norm_out(want.stdout, roots(plain)), `${args[0]}: BOM output differs`);
    }
    assert.equal(fingerprint(bom), before, "the BOM file is not rewritten");
  } finally {
    ctx.cleanup();
  }
});

test("권장 5 (D11): `current` missing or not a stage name → exit 1 and one Korean line (no `현재 단계: undefined`), folder untouched", { timeout: 240_000 }, () => {
  const ctx = make_ctx("pes-ts-current-");
  try {
    const shapes: Array<[string, string]> = [
      ["missing", `{"pes": 1, "topic": "합성 주제", "slug": "cur-missing", "processed": [], "notes": [], "stages": {}}`],
      ["unknown", base_text("cur-unknown").replace('"plan"', '"nope"')],
      ["number", base_text("cur-number").replace('"plan"', "5")],
      ["null", base_text("cur-null").replace('"plan"', "null")],
    ];
    for (const [name, text] of shapes) {
      const dir = put(ctx, `cur-${name}`, text);
      const before = fingerprint(dir);
      for (const args of [["status", dir], ["pending", dir]]) {
        const run = run_ts_cli(ctx, args);
        one_korean_line(run, `current ${name} ${args[0]}`);
        assert.doesNotMatch(run.stdout + run.stderr, /undefined/, `current ${name} ${args[0]}`);
        assert.equal(fingerprint(dir), before, `current ${name} ${args[0]}: the folder changed`);
      }
    }
  } finally {
    ctx.cleanup();
  }
});

// ------------------------------------------------------------------------------------------------ (d) the other read commands on a broken project.json
// Exit codes pinned (0.15 on the same folder, isolated home, hub ports blocked):
//   serve  traceback → ts exit 1 + one Korean line (D11) · open  0, the file address of the (absent) index.html · list  0, an error row `[오류]`, `서버 꺼짐`
//   watch  0, the tail line · hub  0 (reads no project.json; builds the PARENT's hub and starts a server) · doctor  text 1 (a `bad` row), --json 0 (0.15)
test("(d) broken project.json: serve · open · list · watch · doctor end as 0.15 does (exit pinned), and the folder is byte-for-byte untouched", { timeout: 240_000 }, async () => {
  const ctx = make_ctx("pes-ts-broken-rest-");
  try {
    const broken = synthetic_project(ctx, "broken");
    const before = fingerprint(broken);
    const port = await free_port();
    const env = { PES_HUB_PORTS: `${port}-${port}`, PES_NO_BROWSER: "1" };
    const narrow: TsRunOptions = { narrow_path: true, extra_read: [ctx.narrow_bin], allow_child_process: true, env };
    const unchanged = (what: string): void => {
      assert.equal(fingerprint(broken), before, `${what}: the broken folder changed`);
      assert.deepEqual(walk_files(broken), ["project.json"], `${what}: a file was added to the broken folder`);
    };

    const serve = run_ts_cli(ctx, ["serve", broken], { env });
    one_korean_line(serve, "serve");
    assert.deepEqual(serve.hub_attempts, []);
    unchanged("serve");

    const open = run_ts_cli(ctx, ["open", broken], { env });
    assert.equal(open.status, 0, open.stderr);
    assert.match(open.stdout.trim(), /^file:\/\/\/.*\/index\.html$/);
    unchanged("open");

    const list = run_ts_cli(ctx, ["list", broken], { env });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /\[오류\]/);
    assert.match(list.stdout, /서버 꺼짐/);
    unchanged("list");

    const watch = run_ts_cli(ctx, ["watch", broken], { env });
    assert.equal(watch.status, 0, watch.stderr);
    assert.match(watch.stdout, /^tail -n0 -F .*feedback\.log'? \| grep --line-buffered FEEDBACK\n$/);
    unchanged("watch");

    // doctor: the exit code is 0.15's own, whatever it is (py oracle, same folder), and pinned explicitly next to it
    const py_text = pes(ctx, "doctor", broken);
    const py_json = pes(ctx, "doctor", broken, "--json");
    const text = run_ts_cli(ctx, ["doctor", broken], narrow);
    const json = run_ts_cli(ctx, ["doctor", broken, "--json"], narrow);
    assert.equal(py_text.code, 1, "0.15: a bad row ends the text mode with 1");
    assert.equal(py_json.code, 0, "0.15: --json ends with 0 even with a bad row");
    assert.equal(text.status, py_text.code, `doctor text: ${text.stderr}`);
    assert.equal(json.status, py_json.code, `doctor --json: ${json.stderr}`);
    assert.match(text.stdout, /\[문제\]/);
    assert.ok((JSON.parse(json.stdout) as Array<{ level: string }>).some((r) => r.level === "bad"), "--json carries the bad row");
    unchanged("doctor");
  } finally {
    ctx.cleanup();
  }
});

test("(d) broken project.json: `hub <broken>` ends 0 with the home's address (it reads no project.json of the argument), the broken folder is untouched; the server is stopped afterwards", { timeout: 240_000 }, async () => {
  const ctx = make_ctx("pes-ts-broken-hub-");
  const port = await free_port();
  const env = { PES_HUB_PORTS: `${port}-${port}`, PES_NO_BROWSER: "1" };
  const run = (args: string[]) => run_ts_cli(ctx, args, { allow_child_process: true, timeout_ms: 90_000, env });
  try {
    const broken = synthetic_project(ctx, "broken");
    const before = fingerprint(broken);
    const hub = run(["hub", broken]);
    assert.equal(hub.status, 0, hub.stderr);
    assert.equal(hub.stdout.trim(), `http://127.0.0.1:${port}/`);
    assert.equal(fingerprint(broken), before, "hub: the broken folder changed");
    assert.deepEqual(walk_files(broken), ["project.json"]);
  } finally {
    try {
      run(["stop", ctx.tmp]);
    } catch {
      // the pid record below is the second net
    }
    const record = join(ctx.tmp, ".pes-hub-server");
    if (existsSync(record)) {
      try {
        process.kill(JSON.parse(readFileSync(record, "utf8")).pid);
      } catch {
        // already gone
      }
    }
    ctx.cleanup();
  }
});

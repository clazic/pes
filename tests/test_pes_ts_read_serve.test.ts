// SEL-77 (PR26b-2, tester): what the cases E05~E15 do not say by themselves — written before the code, they fail until scripts/pes.ts has them.
//   (a) doctor: exit code, schema and --fix next to the py oracle (E15 pins the fresh home and a fresh project; D08 = no Python row, one Node row);
//   (b) serve · hub · stop · open: pes.ts starts and stops scripts/serve.ts with the same contract as 0.15 (port, URL, whoami, version, ping),
//       on an INJECTED port — the real PES ports 8760~8775 stay refused by the guard (hub_block), and `open` starts no browser;
//   (c) watch: 0.15's one-line `tail -n0 -F …/feedback.log | grep --line-buffered FEEDBACK` (D05: the long-poll way is the API's, the CLI keeps the line);
//   (d) a broken project.json: every read / report command ends with exit 1 + one Korean line, the folder is untouched (D11, E12 pins `status`).
//
// INTERPRETATIONS the worker must follow (the issue names no variable; leader may rename them here and in the worker's code together):
//   I1  PES_HUB_PORTS="<first>-<last>" (inclusive, e.g. "49200-49200") replaces the hub port range 8760~8764 for every pes.ts command that
//       looks for / starts a home server (serve hub list open stop doctor). Absent → the 0.15 range.
//   I2  PES_NO_BROWSER=1: `open` prints the address and starts NO browser and NO child process (the test runs it without --allow-child-process).
//   I3  serve / hub start scripts/serve.ts as a detached child (`node scripts/serve.ts <home> <port>`), write <home>/.pes-hub-server = {"pid","port"}
//       like 0.15, wait until /whoami answers, print the URL; stop reads that file.
//   I4  doctor's tool rows (group "도구") are per PC; all other rows are compared with 0.15 (see compat_ts_srv.adapt_ts_doctor_stdout, D08).
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { get } from "node:http";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { looks_like_stack_trace, norm_out } from "./helpers/compat_cases.ts";
import { shell_words } from "./helpers/cli_read_env.ts";
import { free_port, init_project, make_ctx, pes, synthetic_project, walk_files, type CompatCtx } from "./helpers/compat_env.ts";
import { adapt_ts_doctor_stdout } from "./helpers/compat_ts_srv.ts";
import { run_ts_cli, type TsRunOptions } from "./helpers/compat_ts.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { HUB_PORT_FIRST, HUB_PORT_LAST } from "./helpers/hub_block.ts";

use_home_guard();

const SLUG = "서버-시험";

function ports_env(port: number): Record<string, string> {
  return { PES_HUB_PORTS: `${port}-${port}` };
}

function http_json(port: number, path: string): Promise<{ status: number; json: any }> {
  return new Promise((done, fail) => {
    // Reason: node's http rejects raw non-ASCII request paths (ERR_UNESCAPED_CHARACTERS); browsers percent-encode each path segment, so the test client does the same (a test bug, not an implementation one).
    const wire_path = path.split("/").map((seg) => encodeURIComponent(seg)).join("/");
    const req = get({ host: "127.0.0.1", port, path: wire_path, timeout: 10_000 }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (c: string) => (body += c)).on("end", () => {
        try {
          done({ status: res.statusCode ?? 0, json: body === "" ? null : JSON.parse(body) });
        } catch {
          done({ status: res.statusCode ?? 0, json: body });
        }
      });
    });
    req.on("error", fail);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

async function refused(port: number): Promise<boolean> {
  try {
    await http_json(port, "/ping");
    return false;
  } catch {
    return true;
  }
}

/** The one stand-in server of a test: stops it through the CLI and, if that fails, by the pid the CLI wrote (never leaves a process behind). */
async function with_server(fn: (ctx: CompatCtx, port: number, run: (args: string[], extra?: TsRunOptions) => ReturnType<typeof run_ts_cli>) => Promise<void>): Promise<void> {
  const ctx = make_ctx("pes-ts-serve-");
  const port = await free_port();
  assert.ok(port < HUB_PORT_FIRST || port > HUB_PORT_LAST, "the injected port is outside the real PES range");
  const run = (args: string[], extra: TsRunOptions = {}) => run_ts_cli(ctx, args, { allow_child_process: true, timeout_ms: 90_000, ...extra, env: { ...ports_env(port), ...(extra.env ?? {}) } });
  try {
    await fn(ctx, port, run);
  } finally {
    try {
      run(["stop"]);
    } catch {
      // the pid file below is the second net
    }
    const record = join(ctx.pes_home, ".pes-hub-server");
    if (existsSync(record)) {
      try {
        process.kill(JSON.parse(readFileSync(record, "utf8")).pid);
      } catch {
        // already gone
      }
    }
    ctx.cleanup();
  }
}

test("(b) serve: pes.ts starts scripts/serve.ts on the injected port and prints the project's address; whoami / version / ping answer like 0.15", { timeout: 240_000 }, () =>
  with_server(async (ctx, port, run) => {
    const project = join(ctx.pes_home, SLUG);
    assert.equal(run(["init", project, "--topic", "합성 주제"]).status, 0);
    const started = run(["serve", project]);
    assert.equal(started.status, 0, started.stderr);
    assert.equal(started.stderr, "");
    assert.deepEqual(started.hub_attempts, [], "the injected range replaces the real hub ports: no attempt at 8760~8775");
    assert.equal(started.stdout.trim(), `http://127.0.0.1:${port}/${SLUG}/`, "serve prints the project's address (0.15: server_url)");
    const whoami = await http_json(port, "/whoami");
    assert.equal(whoami.status, 200);
    assert.deepEqual(whoami.json, { root: realpathSync.native(ctx.pes_home), single: true });
    assert.deepEqual((await http_json(port, "/ping")).json, { ok: true });
    assert.deepEqual((await http_json(port, `/${SLUG}/ping`)).json, { ok: true });
    const version = (await http_json(port, "/version")).json;
    assert.equal(typeof version.v, "number");
    assert.equal((await http_json(port, "/없는-프로젝트/")).status, 404);
    // the record 0.15 keeps, and that `stop` reads
    const record = JSON.parse(readFileSync(join(ctx.pes_home, ".pes-hub-server"), "utf8"));
    assert.equal(record.port, port);
    assert.ok(Number.isInteger(record.pid) && record.pid > 0);
    // a second serve finds the running server: same address, same process
    const again = run(["serve", project]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout.trim(), started.stdout.trim());
    assert.deepEqual(JSON.parse(readFileSync(join(ctx.pes_home, ".pes-hub-server"), "utf8")), record, "no second server was started");
  }));

test("(b) hub · list · stop: hub prints the home's address and builds index.html; list shows the address while it runs and `서버 꺼짐` after `stop`; stop prints 0.15's line and the port is closed", { timeout: 240_000 }, () =>
  with_server(async (ctx, port, run) => {
    const project = join(ctx.pes_home, SLUG);
    assert.equal(run(["init", project, "--topic", "합성 주제"]).status, 0);
    const before = run(["list"]);
    assert.equal(before.status, 0, before.stderr);
    assert.match(before.stdout, /서버 꺼짐/);
    const hub = run(["hub"]);
    assert.equal(hub.status, 0, hub.stderr);
    assert.equal(hub.stdout.trim(), `http://127.0.0.1:${port}/`);
    assert.ok(existsSync(join(ctx.pes_home, "index.html")), "hub builds the home's index.html");
    assert.ok(existsSync(join(ctx.pes_home, ".pes-hub")), "and the .pes-hub marker (0.15)");
    assert.equal((await http_json(port, "/whoami")).json.single, true);
    const listed = run(["list"]);
    assert.match(listed.stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}/${SLUG}/`), "list shows the project's address while the server runs");
    const stopped = run(["stop"]);
    assert.equal(stopped.status, 0, stopped.stderr);
    const said = /^서버 종료 \((.+) — 이 홈의 모든 프로젝트 화면이 함께 꺼집니다\)\n$/.exec(stopped.stdout);
    assert.ok(said !== null, `stop prints 0.15's line, got ${JSON.stringify(stopped.stdout)}`);
    assert.equal(realpathSync.native(said[1] as string), realpathSync.native(ctx.pes_home));
    assert.equal(await refused(port), true, "the port is closed after stop");
    assert.ok(!existsSync(join(ctx.pes_home, ".pes-hub-server")), "stop removes the record");
    assert.match(run(["list"]).stdout, /서버 꺼짐/);
    // stop with nothing running is not an error (0.15)
    assert.equal(run(["stop"]).status, 0);
  }));

test("(b) open (PES_NO_BROWSER=1): prints the address, starts no browser and no child process; with the server off it is the project's index.html as a file address", { timeout: 240_000 }, () =>
  with_server(async (ctx, port, run) => {
    const project = join(ctx.pes_home, SLUG);
    assert.equal(run(["init", project, "--topic", "합성 주제"]).status, 0);
    // no allow_child_process: a spawn would be refused by the permission model
    const off = run_ts_cli(ctx, ["open", project], { env: { ...ports_env(port), PES_NO_BROWSER: "1" } });
    assert.equal(off.status, 0, off.stderr);
    assert.equal(off.stderr, "");
    const line = off.stdout.trim();
    assert.match(line, /^file:\/\/\/.*\/index\.html$/);
    assert.equal(realpathSync.native(fileURLToPath(line)), realpathSync.native(join(project, "index.html")), "the project's own index.html (written at open when the DB serves the project)");
    assert.equal(run(["serve", project]).status, 0);
    const on = run_ts_cli(ctx, ["open", project], { env: { ...ports_env(port), PES_NO_BROWSER: "1" } });
    assert.equal(on.status, 0, on.stderr);
    assert.equal(on.stdout.trim(), `http://127.0.0.1:${port}/${SLUG}/`);
    const url = run_ts_cli(ctx, ["open", "http://127.0.0.1:1/x"], { env: { ...ports_env(port), PES_NO_BROWSER: "1" } });
    assert.equal(url.stdout.trim(), "http://127.0.0.1:1/x", "an http address is opened as is");
  }));

test("(b) the real PES ports stay closed: serve / hub / open / stop / list / doctor with an injected range never even try 8760~8775", { timeout: 240_000 }, () =>
  with_server(async (ctx, port, run) => {
    const project = join(ctx.pes_home, SLUG);
    assert.equal(run(["init", project, "--topic", "합성 주제"]).status, 0);
    const attempts: number[] = [];
    for (const args of [["serve", project], ["hub"], ["list"], ["doctor", "--json"], ["doctor", project, "--json"], ["stop"]]) {
      const result = run(args, { narrow_path: args[0] === "doctor", extra_read: args[0] === "doctor" ? [ctx.narrow_bin] : [] });
      attempts.push(...result.hub_attempts);
    }
    const open = run_ts_cli(ctx, ["open", project], { env: { ...ports_env(port), PES_NO_BROWSER: "1" } });
    attempts.push(...open.hub_attempts);
    assert.deepEqual(attempts, [], "a hub attempt means the injected range was ignored");
  }));

test("(c) watch: the same one line as 0.15 (D05 keeps the tail form during the transition; waiting by long-poll is the API's), also for a path with a space and an apostrophe", { timeout: 120_000 }, () => {
  const ctx = make_ctx("pes-ts-watch-");
  try {
    for (const name of ["watch-plain", "watch 공백's"]) {
      const project = init_project(ctx, name);
      const before = walk_files(project);
      const want = pes(ctx, "watch", project);
      assert.equal(want.code, 0);
      const got = run_ts_cli(ctx, ["watch", project]);
      assert.equal(got.status, 0, got.stderr);
      assert.equal(got.stderr, "");
      const roots = ctx.roots(project);
      // Reason (R1 권장 8): 0.15 builds `f'{d}/feedback.log'`, which on Windows mixes `\\` and `/` (`C:\\x\\proj/feedback.log`); ts uses join(d, "feedback.log")
      // — one separator, the OS's own. The py line is aligned to that single separator on win32 (same device as an os_overrides entry); elsewhere the two are identical.
      const want_out = process.platform === "win32" ? want.out.replace("/feedback.log", "\\feedback.log") : want.out;
      assert.deepEqual(norm_out(got.stdout, roots), norm_out(want_out, roots), `${name}: watch line differs from 0.15`);
      const log_word = shell_words(got.stdout.trim())[3] as string;
      assert.equal(basename(log_word), "feedback.log");
      assert.equal(realpathSync.native(dirname(log_word)), realpathSync.native(project), `${name}: the log path is the project's own folder`);
      assert.equal(log_word.includes(process.platform === "win32" ? "/" : "\\"), false, `${name}: one separator only (join(d, "feedback.log")): ${log_word}`);
      assert.match(got.stdout, /^tail -n0 -F .*feedback\.log'? \| grep --line-buffered FEEDBACK\n$/);
      assert.deepEqual(walk_files(project), before, "watch writes nothing");
    }
    const missing = run_ts_cli(ctx, ["watch", join(ctx.tmp, "없는-프로젝트")]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /[가-힣]/);
    assert.ok(!looks_like_stack_trace(missing.stderr.split("\n")));
  } finally {
    ctx.cleanup();
  }
});

// ------------------------------------------------------------------------------------------------ (a) doctor
type Row = { group: string; level: string; title: string; detail: string; fixable: boolean };

function doctor_rows(ctx: CompatCtx, who: "py" | "ts", args: string[]): { exit: number | null; rows: Row[]; stdout: string } {
  const argv = ["doctor", ...args, "--json"];
  const run = who === "py" ? (() => { const r = pes(ctx, ...argv); return { status: r.code, stdout: r.out, stderr: r.err }; })() : run_ts_cli(ctx, argv, { narrow_path: true, extra_read: [ctx.narrow_bin], allow_child_process: true });
  const roots = ctx.roots(args[0]);
  const text = (v: unknown): string => norm_out(String(v ?? ""), roots).join("\n");
  const stdout = who === "ts" ? adapt_ts_doctor_stdout(argv, run.stdout) : run.stdout;
  const rows = (JSON.parse(stdout) as Row[]).filter((r) => r.group !== "도구").map((r) => ({ group: r.group, level: r.level, title: text(r.title).replace(/Python \d+\.\d+\.\d+/, "Python <VER>"), detail: text(r.detail), fixable: r.fixable }));
  return { exit: run.status, rows, stdout };
}

test("(a) doctor on a project whose project.json is broken: same exit as 0.15, same rows (group·level·title·detail·fixable); the exit contract is explicit — text mode 1 with a bad row, `--json` 0 even with a bad row (R1 필수 2)", { timeout: 240_000 }, () => {
  const ctx = make_ctx("pes-ts-doctor-bad-");
  try {
    const broken = synthetic_project(ctx, "broken");
    const want = doctor_rows(ctx, "py", [broken]);
    const got = doctor_rows(ctx, "ts", [broken]);
    assert.equal(got.exit, want.exit, "doctor's exit code is exactly 0.15's (py oracle)");
    assert.deepEqual(got.rows, want.rows);
    // The contract, stated outright (not only "equal to the oracle"): the 0.15 path the user runs has no PES_DB_CORE, and there `--json` ends with 0 whatever the rows say.
    assert.ok(got.rows.some((r) => r.level === "bad"), "the broken project.json gives a bad row");
    assert.equal(want.exit, 0, "0.15 (no PES_DB_CORE): --json with a bad row ends with 0");
    assert.equal(got.exit, 0, "ts: --json with a bad row ends with 0 (same as 0.15)");
    const text_want = pes(ctx, "doctor", broken);
    const text_got = run_ts_cli(ctx, ["doctor", broken], { narrow_path: true, extra_read: [ctx.narrow_bin], allow_child_process: true });
    assert.equal(text_want.code, 1, "0.15: text mode with a bad row ends with 1");
    assert.equal(text_got.status, 1, `ts: text mode with a bad row ends with 1 (same as 0.15): ${text_got.stderr}`);
  } finally {
    ctx.cleanup();
  }
});

test("(a) doctor text mode (no --json) ends with 0.15's exit code, prints Korean lines and no Python row; --json rows carry exactly {group, level, title, detail, fixable}", { timeout: 240_000 }, () => {
  const ctx = make_ctx("pes-ts-doctor-text-");
  try {
    const project = init_project(ctx, "doctor-text");
    const want = pes(ctx, "doctor", project);
    const got = run_ts_cli(ctx, ["doctor", project], { narrow_path: true, extra_read: [ctx.narrow_bin], allow_child_process: true });
    assert.equal(got.status, want.code);
    assert.match(got.stdout, /[가-힣]/);
    assert.doesNotMatch(got.stdout, /Python/, "PES TS runs no Python (D08)");
    assert.ok(!looks_like_stack_trace(got.stderr.split("\n")));
    const json = run_ts_cli(ctx, ["doctor", project, "--json"], { narrow_path: true, extra_read: [ctx.narrow_bin], allow_child_process: true });
    for (const row of JSON.parse(json.stdout) as Row[]) assert.deepEqual(Object.keys(row).sort(), ["detail", "fixable", "group", "level", "title"]);
  } finally {
    ctx.cleanup();
  }
});

test("(a) doctor --fix repairs the fixable row (a stale dashboard) and nothing else: afterwards the row is gone, the project state is unchanged", { timeout: 240_000 }, () => {
  const ctx = make_ctx("pes-ts-doctor-fix-");
  try {
    const project = join(ctx.pes_home, "doctor-fix");
    assert.equal(run_ts_cli(ctx, ["init", project, "--topic", "합성 주제"]).status, 0);
    const view = (): Row[] => (JSON.parse(adapt_ts_doctor_stdout(["--json"], run_ts_cli(ctx, ["doctor", project, "--json"], { narrow_path: true, extra_read: [ctx.narrow_bin], allow_child_process: true }).stdout)) as Row[]).filter((r) => r.group !== "도구");
    const status_before = run_ts_cli(ctx, ["status", project]).stdout;
    const stale = view().filter((r) => r.fixable);
    assert.ok(stale.length >= 1, "a fresh project has a fixable row (the dashboard is older than the state, 0.15 E15)");
    const fixed = run_ts_cli(ctx, ["doctor", project, "--fix"], { narrow_path: true, extra_read: [ctx.narrow_bin], allow_child_process: true });
    assert.equal(fixed.status, 0, fixed.stderr);
    assert.deepEqual(view().filter((r) => r.fixable), [], "nothing fixable is left");
    assert.equal(run_ts_cli(ctx, ["status", project]).stdout, status_before, "--fix does not change the project's state");
  } finally {
    ctx.cleanup();
  }
});

// ------------------------------------------------------------------------------------------------ (d) broken project.json
test("(d) broken project.json: every read / report command ends with exit 1 and one Korean line (no stack trace), the folder is byte-for-byte untouched (D11)", { timeout: 240_000 }, () => {
  const ctx = make_ctx("pes-ts-broken-");
  try {
    const broken = synthetic_project(ctx, "broken");
    const snapshot = (): string => JSON.stringify(walk_files(broken).map((rel) => [rel, readFileSync(join(broken, ...rel.split("/"))).toString("hex"), statSync(join(broken, ...rel.split("/"))).mtimeMs]));
    const before = snapshot();
    const commands: string[][] = [["status"], ["pending"], ["digest", "plan"], ["show", "plan"], ["show", "plan", "1", "--fields", "title"], ["render"], ["report", "plan"], ["assemble"], ["web"]];
    for (const [name, ...rest] of commands) {
      const run = run_ts_cli(ctx, [name as string, broken, ...rest]);
      const label = [name, ...rest].join(" ");
      assert.equal(run.status, 1, `${label}: exit`);
      const lines = run.stderr.split("\n").filter((l) => l !== "");
      assert.equal(lines.length, 1, `${label}: one stderr line, got ${JSON.stringify(run.stderr)}`);
      assert.match(lines[0] as string, /[가-힣]/, `${label}: Korean`);
      assert.ok(!looks_like_stack_trace(lines), `${label}: no stack trace`);
      assert.equal(snapshot(), before, `${label}: the broken folder changed (D11: original untouched)`);
    }
    assert.deepEqual(readdirSync(broken), ["project.json"], "no file was added to the broken folder");
    assert.equal(basename(broken).startsWith("broken"), true);
    // serve · hub · open · list · watch · doctor (R1 권장 6) and the project.json shapes NaN / BOM / `current` (권장 4·5): tests/test_pes_ts_r1_review.test.ts, same rules.
  } finally {
    ctx.cleanup();
  }
});

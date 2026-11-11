// SEL-72 final review 1 (F1-1, F1-2, F1-3): fixed behaviour of scripts/setup.ts and scripts/serve.ts that the other suites do not reach.
//
// (1) F1-1 — setup.ts `which()` on Windows is shutil.which: a name without a PATHEXT extension is looked up only as `name + ext`, never as
//     the bare file. npm's cmd-shim puts an extensionless sh script (`npm`, `claude`, `korean-law`) next to every `.cmd`; the bare one
//     cannot be started by spawnSync on Windows. Windows is injected here (process.platform = "win32" in a preload module) so the case
//     runs on every CI machine; spawnSync is replaced by a recorder (nothing is ever started).
// (2) F1-2 — serve.ts folds the leading slashes of the request target like 0.15 (BaseHTTPRequestHandler.parse_request, gh-87389):
//     `GET //x` answers 301 with the same-origin `Location: /x/`, never the protocol-relative `//x/` (an open redirect to host `x`).
// (3) F1-3 — `keys` with the port taken ends an earlier screen only when setup-keys.json holds a real pid (integer > 1). process.kill is
//     replaced by a recorder, so no process is ever signalled; a pid of 0 / -1 would signal a whole process group.
//
// Isolation: temp HOME / USERPROFILE / PES_HOME (make_ctx), PATH narrowed to the case's own empty folder, `--permission` (compat_ts_srv).
// The preload modules are written into the case's temp root at run time.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";

import { make_ctx, type CompatCtx } from "./helpers/compat_env.ts";
import { KEYS_PORT_ENV, free_port, run_ts_setup } from "./helpers/compat_ts_srv.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { header_of, raw_http, serve_fixture, status_line } from "./helpers/serve_ts_env.ts";

use_home_guard();

const RECORD_ENV = "PES_TEST_FINAL1_RECORD";

/** A preload that pretends to be Windows and records every spawnSync / process.kill instead of doing it (one JSON line each). */
function write_preload(ctx: CompatCtx, platform_win32: boolean): string {
  const file = join(ctx.home.root, `final1-preload-${platform_win32 ? "win" : "host"}.mjs`);
  writeFileSync(
    file,
    `import { appendFileSync } from "node:fs";
import child_process from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const record = (entry) => appendFileSync(process.env.${RECORD_ENV}, JSON.stringify(entry) + "\\n", "utf8");
${platform_win32 ? 'Object.defineProperty(process, "platform", { value: "win32", configurable: true, enumerable: true, writable: false });' : ""}
child_process.spawnSync = (command, args, options) => {
  record({ spawn: command, args: Array.isArray(args) ? args : [], shell: Boolean((Array.isArray(args) ? options : args)?.shell) });
  return { pid: 0, status: 0, signal: null, stdout: "", stderr: "", output: [null, "", ""] };
};
syncBuiltinESMExports();
process.kill = (pid, signal) => {
  record({ kill: pid, signal: signal ?? null });
  return true;
};
`,
    "utf8",
  );
  // the real spelling: the loader resolves the --import URL, and `--permission` does not allow reading /var (macOS) or 8.3 names
  return realpathSync.native(file);
}

function records(path: string): Array<Record<string, unknown>> {
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
}

const PATHEXT = ".com;.exe;.bat;.cmd";

test("F1-1 setup.ts which() on Windows (injected): with `npm` and `npm.cmd` side by side the .cmd is run; an extensionless shim alone is no tool", () => {
  const ctx = make_ctx("pes-final1-which-");
  try {
    const preload = write_preload(ctx, true);
    const record = join(ctx.home.root, "final1-which.jsonl");
    const env = { PATHEXT, [RECORD_ENV]: record };
    const bin = ctx.narrow_bin;
    const shim = "#!/bin/sh\nexit 0\n";

    // only extensionless shims: shutil.which finds nothing, so npm (and node) count as missing and nothing is started
    for (const name of ["node", "npm", "korean-law"]) writeFileSync(join(bin, name), shim, { mode: 0o755 });
    let run = run_ts_setup(ctx, ["install", "korean-law"], { narrow_path: true, env, imports: [preload] });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /FAIL korean-law — npm 없음/, run.stdout);
    assert.deepEqual(records(record), [], "an extensionless shim must not be run");
    run = run_ts_setup(ctx, ["check", "--json"], { narrow_path: true, env, imports: [preload] });
    assert.equal(run.status, 0, run.stderr);
    let rows = JSON.parse(run.stdout) as Array<{ name: string; state: string; detail: string }>;
    assert.ok(rows.some((row) => row.name === "gitbash"), "the Windows-only row shows the injection took effect");
    assert.equal(rows.find((row) => row.name === "node")?.state, "missing", "bare `node` / `npm` are no tools on Windows");
    assert.equal(rows.find((row) => row.name === "korean-law")?.state, "missing", "bare `korean-law` is no tool on Windows");

    // the .cmd next to the shim is the one chosen (and run through the shell, as a batch file must be)
    for (const name of ["node", "npm", "korean-law"]) writeFileSync(join(bin, `${name}.cmd`), "@exit /b 0\r\n");
    run = run_ts_setup(ctx, ["install", "korean-law"], { narrow_path: true, env, imports: [preload] });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /OK korean-law/, run.stdout);
    const spawned = records(record);
    assert.equal(spawned.length, 1, JSON.stringify(spawned));
    const command = String(spawned[0]?.spawn).replace(/"/g, "");
    assert.ok(command.startsWith(`${join(bin, "npm.cmd")} install -g korean-law-mcp`), command);
    assert.equal(spawned[0]?.shell, true);
    run = run_ts_setup(ctx, ["check", "--json"], { narrow_path: true, env, imports: [preload] });
    assert.equal(run.status, 0, run.stderr);
    rows = JSON.parse(run.stdout) as Array<{ name: string; state: string; detail: string }>;
    assert.equal(rows.find((row) => row.name === "node")?.state, "ok");
    const law = rows.find((row) => row.name === "korean-law");
    assert.equal(law?.state, "ok");
    assert.ok(law?.detail.endsWith("korean-law.cmd"), `korean-law row: ${law?.detail}`);
  } finally {
    ctx.cleanup();
  }
});

test("F1-1 setup.ts which() off Windows: an extensionless file on PATH that is executable is the tool (unchanged)", () => {
  if (process.platform === "win32") return;
  const ctx = make_ctx("pes-final1-which-posix-");
  try {
    const preload = write_preload(ctx, false);
    const record = join(ctx.home.root, "final1-which-posix.jsonl");
    writeFileSync(join(ctx.narrow_bin, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const run = run_ts_setup(ctx, ["install", "korean-law"], { narrow_path: true, env: { [RECORD_ENV]: record }, imports: [preload] });
    assert.equal(run.status, 0, run.stderr);
    const spawned = records(record);
    assert.equal(spawned.length, 1, JSON.stringify(spawned));
    assert.equal(spawned[0]?.spawn, join(ctx.narrow_bin, "npm"));
    assert.equal(spawned[0]?.shell, false);
  } finally {
    ctx.cleanup();
  }
});

test("F1-2 serve.ts: a request target that starts with `//` is folded to one slash (0.15) — the directory redirect stays on this origin", { timeout: 90_000 }, async () => {
  const fx = await serve_fixture("pes-final1-slashes-", { files: { "x/index.html": "<html>x-dir</html>" } });
  try {
    const port = fx.server.port;
    const get = (target: string) => raw_http(port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    for (const [target, location] of [
      ["/x", "/x/"],
      ["//x", "/x/"],
      ["///x", "/x/"],
      ["//x?a=1", "/x/?a=1"],
    ] as const) {
      const answer = await get(target);
      assert.match(status_line(answer.text), /\s301\s/, `${target}: ${status_line(answer.text)}`);
      assert.equal(header_of(answer.text, "location"), location, target);
    }
    // with the slash already there it is the directory itself (as 0.15: no redirect, the index page)
    for (const target of ["///x/", "//x/"]) {
      const answer = await get(target);
      assert.match(status_line(answer.text), /\s200\s/, `${target}: ${status_line(answer.text)}`);
      assert.match(answer.text, /<html>x-dir<\/html>/, target);
    }
  } finally {
    await fx.cleanup();
  }
});

test("F1-3 setup.ts keys: with the port taken, setup-keys.json's pid is signalled only when it is a real process id (integer > 1)", { timeout: 120_000 }, async () => {
  const ctx = make_ctx("pes-final1-keys-pid-");
  const holder = createServer((socket) => socket.end());
  try {
    const port = await free_port();
    await new Promise<void>((done) => holder.listen(port, "127.0.0.1", () => done()));
    const preload = write_preload(ctx, false);
    const pes = join(ctx.home_dir, ".pes");
    mkdirSync(pes, { recursive: true });
    const cases: Array<[unknown, boolean]> = [
      [null, false],
      ["", false],
      [0, false],
      [-1, false],
      [1, false],
      ["4242", false],
      [1.5, false],
      [999_999, true],
    ];
    for (const [i, [pid, killed]] of cases.entries()) {
      const record = join(ctx.home.root, `final1-keys-${i}.jsonl`);
      writeFileSync(join(pes, "setup-keys.json"), JSON.stringify({ pid, port }), "utf8");
      const run = run_ts_setup(ctx, ["keys", "--no-open"], { narrow_path: true, env: { [KEYS_PORT_ENV]: String(port), [RECORD_ENV]: record }, imports: [preload] });
      assert.equal(run.status, 1, `pid ${JSON.stringify(pid)}: ${run.stdout}${run.stderr}`);
      assert.match(run.stdout + run.stderr, new RegExp(`포트 ${port} 사용 중`));
      const kills = records(record).filter((entry) => "kill" in entry);
      assert.deepEqual(kills.map((entry) => entry.kill), killed ? [pid] : [], `pid ${JSON.stringify(pid)}`);
    }
  } finally {
    await new Promise<void>((done) => holder.close(() => done()));
    ctx.cleanup();
  }
});

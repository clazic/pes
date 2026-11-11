// home_guard (SEL-70): the TS counterpart of the Python audit hook in tests/conftest.py (test_project_basic.py guard tests).
// Everything uses a *fake* "real home" under a temp folder, so the guard is tested without touching the real ~/.pes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { PYTHON, ServeProcess, guarded_script_argv, make_ctx, make_serve_home, run_py_code, run_pes } from "./helpers/compat_env.ts";
import { account_home, assert_isolated_env, assert_no_real_path, protected_paths, real_homes, take_home_snapshot, touches_protected, use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

function fake_real_home(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "pes-fake-real-home-"));
  mkdirSync(join(dir, ".pes"), { recursive: true });
  writeFileSync(join(dir, ".pes", "config.json"), '{"home": "synthetic"}', "utf8");
  mkdirSync(join(dir, "pes-projects", "p"), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a compat context is isolated: HOME = USERPROFILE, PES_HOME inside the temp root, no owner / token / flag", () => {
  const ctx = make_ctx("pes-guard-");
  try {
    assert_isolated_env(ctx.env);
    assert.equal(ctx.env.HOME, ctx.env.USERPROFILE);
    assert.ok((ctx.env.PES_HOME as string).startsWith(ctx.home.root));
    for (const key of ["PES_OWNER", "PES_TOKEN", "PES_DB_CORE", "LAW_OC", "PYTHONPATH"]) assert.equal(ctx.env[key], undefined, key);
  } finally {
    ctx.cleanup();
  }
});

test("assert_isolated_env refuses every way of reaching the real home", () => {
  const fake = fake_real_home();
  const ctx = make_ctx("pes-guard-");
  try {
    const ok = { ...ctx.env };
    assert_isolated_env(ok, fake.dir);
    const cases: [string, Record<string, string | undefined>][] = [
      ["HOME is the real home", { ...ok, HOME: fake.dir, USERPROFILE: fake.dir }],
      ["PES_HOME is the real pes-projects", { ...ok, PES_HOME: join(fake.dir, "pes-projects") }],
      ["PES_HOME below the real pes-projects", { ...ok, PES_HOME: join(fake.dir, "pes-projects", "p") }],
      ["HOME inside the real .pes", { ...ok, HOME: join(fake.dir, ".pes"), USERPROFILE: join(fake.dir, ".pes") }],
      ["HOME missing", { ...ok, HOME: undefined }],
      ["PES_HOME missing", { ...ok, PES_HOME: undefined }],
      ["USERPROFILE differs from HOME", { ...ok, USERPROFILE: join(ctx.home.root, "other") }],
      ["relative PES_HOME", { ...ok, PES_HOME: "pes-projects" }],
      ["PES_OWNER leaks", { ...ok, PES_OWNER: "alice" }],
      ["PES_TOKEN leaks", { ...ok, PES_TOKEN: "t" }],
      ["PES_DB_CORE leaks", { ...ok, PES_DB_CORE: "1" }],
    ];
    for (const [what, env] of cases) assert.throws(() => assert_isolated_env(env, fake.dir), /home guard/, what);
  } finally {
    ctx.cleanup();
    fake.cleanup();
  }
});

test("run_pes refuses to start a child when the context points at this process's real home (checked before spawn)", () => {
  const ctx = make_ctx("pes-guard-");
  try {
    ctx.env.HOME = homedir();
    ctx.env.USERPROFILE = homedir();
    assert.throws(() => run_pes("py", ctx, ["home"]), /home guard/);
    ctx.env.HOME = ctx.home_dir;
    ctx.env.USERPROFILE = ctx.home_dir;
    ctx.env.PES_HOME = join(homedir(), "pes-projects");
    assert.throws(() => run_pes("py", ctx, ["list"]), /home guard/);
    // the owner is the one variable a case may add on purpose, but only per call through options.env
    ctx.env.PES_HOME = ctx.pes_home;
    assert.doesNotThrow(() => run_pes("py", ctx, ["home"], { env: { PES_OWNER: "alice-session" } }));
    ctx.env.PES_OWNER = "alice";
    assert.throws(() => assert_isolated_env(ctx.env), /PES_OWNER/);
  } finally {
    ctx.cleanup();
  }
});

test("touches_protected sees symlink aliases of .pes and pes-projects (read and write paths)", (t) => {
  const fake = fake_real_home();
  const work = mkdtempSync(join(tmpdir(), "pes-alias-"));
  try {
    for (const folder of [".pes", "pes-projects"]) {
      const alias = join(work, `alias-${folder}`);
      try {
        symlinkSync(join(fake.dir, folder), alias, process.platform === "win32" ? "junction" : "dir");
      } catch {
        t.skip("creating directory links is unavailable");
        return;
      }
      assert.ok(touches_protected(join(alias, "existing.json"), fake.dir), `read through ${folder} alias`);
      assert.ok(touches_protected(join(alias, "new.json"), fake.dir), `write through ${folder} alias (file does not exist yet)`);
    }
    assert.ok(!touches_protected(join(work, "safe.txt"), fake.dir));
  } finally {
    rmSync(work, { recursive: true, force: true });
    fake.cleanup();
  }
});

test("touches_protected: the protected folders, anything below them; not look-alike siblings", () => {
  const fake = fake_real_home();
  try {
    assert.ok(touches_protected(join(fake.dir, ".pes"), fake.dir));
    assert.ok(touches_protected(join(fake.dir, ".pes", "config.json"), fake.dir));
    assert.ok(touches_protected(join(fake.dir, "pes-projects", "p", "project.json"), fake.dir));
    assert.ok(!touches_protected(join(fake.dir, ".pes-other"), fake.dir));
    assert.ok(!touches_protected(join(fake.dir, "pes-projects-copy"), fake.dir));
    assert.ok(!touches_protected(fake.dir, fake.dir), "the home itself is not a protected folder (only its two children are)");
  } finally {
    fake.cleanup();
  }
});

test("the home snapshot catches a change of name, size and mtime, and an absent folder that appears", () => {
  const fake = fake_real_home();
  try {
    const steady = take_home_snapshot(fake.dir);
    steady.check();

    const added = take_home_snapshot(fake.dir);
    writeFileSync(join(fake.dir, ".pes", "new.json"), "{}", "utf8");
    assert.throws(() => added.check(), /home guard/, "new file");
    rmSync(join(fake.dir, ".pes", "new.json"));

    const resized = take_home_snapshot(fake.dir);
    writeFileSync(join(fake.dir, ".pes", "config.json"), '{"home": "synthetic-longer"}', "utf8");
    assert.throws(() => resized.check(), /home guard/, "size");

    const touched = take_home_snapshot(fake.dir);
    utimesSync(join(fake.dir, ".pes", "config.json"), 1_000_000_000, 1_000_000_000);
    assert.throws(() => touched.check(), /home guard/, "mtime only");

    rmSync(join(fake.dir, "pes-projects"), { recursive: true });
    const absent = take_home_snapshot(fake.dir);
    absent.check();
    mkdirSync(join(fake.dir, "pes-projects"));
    assert.throws(() => absent.check(), /home guard/, "a folder that was absent must stay absent");
  } finally {
    fake.cleanup();
  }
});

test("assert_no_real_path finds a protected path in any spelling (plain, forward slashes, doubled backslashes)", () => {
  const fake = fake_real_home();
  try {
    const plain = join(fake.dir, ".pes", "config.json");
    assert.throws(() => assert_no_real_path(`opened ${plain}`, "stdout", fake.dir), /home guard/);
    for (const form of protected_paths(fake.dir)) assert.throws(() => assert_no_real_path(`x ${form} y`, "stderr", fake.dir), /home guard/);
    assert.doesNotThrow(() => assert_no_real_path(`opened ${join(fake.dir, "safe.txt")}`, "stdout", fake.dir));
  } finally {
    fake.cleanup();
  }
});

test("a real CLI run in the isolated context leaves the real home alone (list / home / remote / doctor)", () => {
  const ctx = make_ctx("pes-guard-");
  const before = take_home_snapshot();
  try {
    for (const args of [["list"], ["home"], ["remote"], ["doctor", "--json"]]) {
      const run = run_pes("py", ctx, args, { narrow_path: args[0] === "doctor" });
      assert.equal(run.kind, "ran");
    }
  } finally {
    ctx.cleanup();
  }
  before.check();
});

// ---------------------------------------------------------------- the read guard inside the Python children (conftest GUARD)
// A *synthetic* "real home" is handed to the child through PES_TEST_REAL_HOME: the child must be stopped when it reads anything
// below its .pes / pes-projects — a pure read, which the snapshot layer cannot see. The real ~/.pes is never involved.
const VIOLATION = /PESHomeAccessViolation/;

test("a python snippet that only READS below the (synthetic) real home is stopped by the audit hook; a safe read passes", () => {
  const fake = fake_real_home();
  const ctx = make_ctx("pes-guard-");
  try {
    const env = { PES_TEST_REAL_HOME: fake.dir };
    const read = "import sys; print(open(sys.argv[1], encoding='utf-8').read())";
    const safe = join(ctx.tmp, "safe.txt");
    writeFileSync(safe, "synthetic", "utf8");
    assert.equal(run_py_code(ctx, read, [safe], { env }).stdout.trim(), "synthetic");
    const snapshot = take_home_snapshot(fake.dir);
    for (const [what, code, target] of [
      ["open a file in .pes", read, join(fake.dir, ".pes", "config.json")],
      ["list pes-projects", "import os, sys; print(os.listdir(sys.argv[1]))", join(fake.dir, "pes-projects")],
      ["stat a project below pes-projects", "import os, sys; print(os.stat(sys.argv[1]))", join(fake.dir, "pes-projects", "p")],
      ["pathlib exists() on .pes", "import sys; from pathlib import Path; print(Path(sys.argv[1]).exists())", join(fake.dir, ".pes")],
    ] as const) {
      assert.throws(() => run_py_code(ctx, code, [target], { env }), VIOLATION, what);
    }
    snapshot.check(); // and the blocked reads changed nothing
    if (process.platform !== "win32") {
      mkdirSync(join(ctx.tmp, "alias-parent"), { recursive: true });
      symlinkSync(join(fake.dir, ".pes"), join(ctx.tmp, "alias-parent", "alias"), "dir");
      assert.throws(() => run_py_code(ctx, read, [join(ctx.tmp, "alias-parent", "alias", "config.json")], { env }), VIOLATION, "read through a symlink alias");
    }
  } finally {
    ctx.cleanup();
    fake.cleanup();
  }
});

test("run_pes('py') runs the hook: a CLI pointed at the synthetic real pes-projects is stopped (end to end, nothing skipped)", () => {
  const fake = fake_real_home();
  const ctx = make_ctx("pes-guard-");
  try {
    const env = { PES_HOME: join(fake.dir, "pes-projects"), PES_TEST_REAL_HOME: fake.dir };
    assert.throws(() => run_pes("py", ctx, ["list"], { env }), VIOLATION);
    // the same command with the isolated PES_HOME and the same synthetic real home is fine
    const run = run_pes("py", ctx, ["list"], { env: { PES_TEST_REAL_HOME: fake.dir } });
    assert.equal(run.kind === "ran" ? run.status : -1, 0);
  } finally {
    ctx.cleanup();
    fake.cleanup();
  }
});

test("ServeProcess runs the hook too: a server rooted in the synthetic real pes-projects fails to start with the violation", async () => {
  const fake = fake_real_home();
  const ctx = make_ctx("pes-guard-");
  try {
    make_serve_home(ctx);
    const server = new ServeProcess(ctx, join(fake.dir, "pes-projects"), { extra_env: { PES_TEST_REAL_HOME: fake.dir }, ready_timeout_ms: 3_000 });
    await assert.rejects(server.start(), VIOLATION);
    await server.stop().catch(() => undefined);
    // control: the isolated root starts and answers
    const ok = await new ServeProcess(ctx, make_serve_home(ctx), { extra_env: { PES_TEST_REAL_HOME: fake.dir } }).start();
    try {
      assert.equal((await ok.request("/ping")).status, 200);
    } finally {
      await ok.stop();
    }
  } finally {
    ctx.cleanup();
    fake.cleanup();
  }
});

test("the guarded launcher keeps the script's own view: argv, __file__, __name__ and the exit code", () => {
  const ctx = make_ctx("pes-guard-");
  try {
    const script = join(ctx.tmp, "probe.py");
    writeFileSync(script, "import sys\nprint(sys.argv[1:], __name__, __file__ == sys.argv[0])\nsys.exit(7)\n", "utf8");
    const env = { ...ctx.env, PES_TEST_GUARD: "1", PES_TEST_REAL_HOME: account_home() };
    const probe = spawnSync(PYTHON, guarded_script_argv(script, ["a b", "한글"]), { env: env as NodeJS.ProcessEnv, encoding: "utf8" });
    assert.equal(probe.status, 7);
    assert.match(probe.stdout, /\['a b', '한글'\] __main__ True/);
  } finally {
    ctx.cleanup();
  }
});

test("'real home' means both os.homedir() and the account's home; a snapshot and the path checks cover each", () => {
  const homes = real_homes();
  assert.ok(homes.length >= 1 && homes.length <= 2);
  assert.ok(homes.includes(account_home()) || homes.some((h) => h.toLowerCase() === account_home().toLowerCase()));
  assert.deepEqual(take_home_snapshot().homes, homes);
  for (const home of homes) assert.ok(touches_protected(join(home, ".pes", "x")), home);

  // with $HOME / %USERPROFILE% pointing at a temp folder (an isolated run), os.homedir() follows it but the account home must still be listed
  const temp = mkdtempSync(join(tmpdir(), "pes-homes-"));
  try {
    const module = pathToFileURL(join(import.meta.dirname, "helpers", "home_guard.ts")).href;
    const child = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(module)}).then((m) => console.log(JSON.stringify({ homes: m.real_homes(), account: m.account_home() })))`], {
      env: { ...process.env, HOME: temp, USERPROFILE: temp } as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    const seen = JSON.parse(child.stdout) as { homes: string[]; account: string };
    assert.ok(seen.homes.some((h) => h === temp || h.toLowerCase() === temp.toLowerCase()), "os.homedir() (the temp folder) is listed");
    assert.ok(seen.homes.includes(seen.account), "the account home is listed too");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

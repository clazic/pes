// home_guard (SEL-70): the TS counterpart of the Python audit hook in tests/conftest.py (test_project_basic.py guard tests).
// Everything uses a *fake* "real home" under a temp folder, so the guard is tested without touching the real ~/.pes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { make_ctx, run_pes } from "./helpers/compat_env.ts";
import { assert_isolated_env, assert_no_real_path, protected_paths, take_home_snapshot, touches_protected, use_home_guard } from "./helpers/home_guard.ts";

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

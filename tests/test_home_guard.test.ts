// home_guard (SEL-70; SEL-74: the Python audit hook it mirrored is gone — the guard of the ts children is tested in test_pes_ts_guard and test_serve_ts_guard).
// Everything uses a *fake* "real home" under a temp folder, so the guard is tested without touching the real ~/.pes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, promises as fsp, readdirSync, readFileSync, rmSync, stat as stat_cb, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { make_ctx, run_pes } from "./helpers/compat_env.ts";
import { account_home, assert_isolated_env, assert_no_real_path, guard_process_fs, protected_paths, real_homes, take_home_snapshot, touches_protected, unguarded, use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

function fake_real_home(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "pes-fake-real-home-"));
  mkdirSync(join(dir, ".pes"), { recursive: true });
  writeFileSync(join(dir, ".pes", "config.json"), '{"home": "synthetic"}', "utf8");
  mkdirSync(join(dir, "pes-projects", "p"), { recursive: true });
  mkdirSync(join(dir, ".claude", "plugins"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"), '{"theme": "synthetic"}', "utf8");
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
    assert.throws(() => run_pes("ts", ctx, ["home"]), /home guard/);
    ctx.env.HOME = ctx.home_dir;
    ctx.env.USERPROFILE = ctx.home_dir;
    ctx.env.PES_HOME = join(homedir(), "pes-projects");
    assert.throws(() => run_pes("ts", ctx, ["list"]), /home guard/);
    // the owner is the one variable a case may add on purpose, but only per call through options.env
    ctx.env.PES_HOME = ctx.pes_home;
    assert.doesNotThrow(() => run_pes("ts", ctx, ["home"], { env: { PES_OWNER: "alice-session" } }));
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
      const run = run_pes("ts", ctx, args, { narrow_path: args[0] === "doctor" });
      assert.equal(run.kind, "ran");
    }
  } finally {
    ctx.cleanup();
  }
  before.check();
});


// (deleted with Python — a python snippet that only READS …: the Python audit hook of tests/conftest.py is gone; the same guarantee for the ts children — a read below the real home is reported AND denied, the two nets are independent, a server is guarded too — is test_pes_ts_guard.test.ts and test_serve_ts_guard.test.ts)
// (deleted with Python — run_pes('py') runs the hook …: the Python audit hook of tests/conftest.py is gone; the same guarantee for the ts children — a read below the real home is reported AND denied, the two nets are independent, a server is guarded too — is test_pes_ts_guard.test.ts and test_serve_ts_guard.test.ts)
// (deleted with Python — ServeProcess runs the hook too …: the Python audit hook of tests/conftest.py is gone; the same guarantee for the ts children — a read below the real home is reported AND denied, the two nets are independent, a server is guarded too — is test_pes_ts_guard.test.ts and test_serve_ts_guard.test.ts)
// (deleted with Python — the guarded launcher keeps the script's own view …: the Python audit hook of tests/conftest.py is gone; the same guarantee for the ts children — a read below the real home is reported AND denied, the two nets are independent, a server is guarded too — is test_pes_ts_guard.test.ts and test_serve_ts_guard.test.ts)
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

// ---------------------------------------------------------------------------
// layer 4 (SEL-95): the test process's own fs calls — D13 stat()ed the real ~/.claude and compared mtimes; other Claude sessions made it flaky

test(".claude is a protected folder of a real home (names, children, aliases of the path), look-alikes are not", () => {
  const fake = fake_real_home();
  try {
    assert.ok(touches_protected(join(fake.dir, ".claude"), fake.dir));
    assert.ok(touches_protected(join(fake.dir, ".claude", "settings.json"), fake.dir));
    assert.ok(touches_protected(join(fake.dir, ".claude", "plugins", "x", "y.json"), fake.dir));
    assert.ok(!touches_protected(join(fake.dir, ".claude-other", "settings.json"), fake.dir));
    assert.ok(!touches_protected(join(fake.dir, "claude", "settings.json"), fake.dir));
    assert.throws(() => assert_isolated_env({ HOME: join(fake.dir, ".claude"), USERPROFILE: join(fake.dir, ".claude"), PES_HOME: join(fake.dir, ".claude", "x") }, fake.dir), /home guard/);
    assert.ok(protected_paths(fake.dir).some((p) => p.endsWith(".claude")));
  } finally {
    fake.cleanup();
  }
});

test("guard_process_fs denies stat · lstat · exists · read · readdir · write on the real home's .pes · pes-projects · .claude, in every spelling and API (sync, callback, promises)", async () => {
  const fake = fake_real_home();
  const guard = guard_process_fs(fake.dir);
  const seen: string[] = [];
  try {
    const attempts: Array<[string, () => unknown]> = [];
    for (const folder of [".claude", ".pes", "pes-projects"]) {
      const dir = join(fake.dir, folder);
      const file = join(dir, folder === ".claude" ? "settings.json" : folder === ".pes" ? "config.json" : join("p", "project.json"));
      attempts.push(
        [`statSync ${folder}`, () => statSync(dir)],
        [`lstatSync ${folder}`, () => lstatSync(dir)],
        [`existsSync ${folder}`, () => existsSync(file)],
        [`readdirSync ${folder}`, () => readdirSync(dir)],
        [`readFileSync ${folder}`, () => readFileSync(file)],
        [`writeFileSync ${folder}`, () => writeFileSync(join(dir, "new.json"), "{}")],
        [`relative path spelled through ..`, () => lstatSync(join(dir, "..", folder, "x"))],
        [`file URL ${folder}`, () => statSync(new URL(`file://${dir}`))],
        [`Buffer path ${folder}`, () => statSync(Buffer.from(dir))],
      );
    }
    for (const [what, run] of attempts) assert.throws(run, /PESHomeAccessViolation/, what);
    await assert.rejects(fsp.stat(join(fake.dir, ".claude")), /PESHomeAccessViolation/, "promises.stat");
    await assert.rejects(fsp.readFile(join(fake.dir, ".claude", "settings.json")), /PESHomeAccessViolation/, "promises.readFile");
    assert.throws(() => stat_cb(join(fake.dir, ".claude"), () => undefined), /PESHomeAccessViolation/, "callback stat (refused at once)");
    seen.push(...guard.violations);
    assert.ok(seen.length >= attempts.length + 3, `every refusal is recorded (${seen.length})`);
    // what is not the real home's protected folders works as ever
    const safe = mkdtempSync(join(tmpdir(), "pes-guard-safe-"));
    try {
      writeFileSync(join(safe, "a.txt"), "ok");
      assert.equal(readFileSync(join(safe, "a.txt"), "utf8"), "ok");
      assert.ok(existsSync(join(fake.dir, ".claude-other")) === false);
      assert.ok(existsSync(fake.dir), "the home itself is not protected");
      assert.ok(touches_protected(join(fake.dir, ".claude", "x"), fake.dir), "touches_protected (realpath) still works while the guard is on");
    } finally {
      rmSync(safe, { recursive: true, force: true });
    }
    // the guard's own listing is allowed
    assert.doesNotThrow(() => take_home_snapshot(fake.dir));
    assert.doesNotThrow(() => unguarded(() => statSync(join(fake.dir, ".claude"))));
    // swallowing the throw does not hide the access: release() fails (a test that wrapped the stat in try/catch "absent" is still caught)
    assert.throws(() => guard.release(), /home guard/);
  } finally {
    fake.cleanup();
  }
  // released: the originals are back
  const fresh = fake_real_home();
  try {
    assert.doesNotThrow(() => statSync(join(fresh.dir, ".claude")));
  } finally {
    fresh.cleanup();
  }
});

test("guard_process_fs without an access releases cleanly and puts the real fs functions back", () => {
  const fake = fake_real_home();
  const before_stat = statSync;
  const guard = guard_process_fs(fake.dir);
  try {
    assert.notEqual(statSync, before_stat, "wrapped while the guard is on");
    assert.ok(statSync(fake.dir).isDirectory());
  } finally {
    assert.doesNotThrow(() => guard.release());
    assert.equal(statSync, before_stat, "restored");
    fake.cleanup();
  }
});

test("use_home_guard denies the real ~/.claude in this very process (the D13 pattern): a swallowed lstat of the account's .claude is still a violation", () => {
  const child_source = `
    const guard = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "helpers", "home_guard.ts")).href)});
    const fs = await import("node:fs");
    const g = guard.guard_process_fs();
    let outcome = "no throw";
    try { fs.lstatSync(guard.account_home() + "/.claude"); } catch (error) { outcome = String(error.message).split(" ")[0]; }
    let released = "released";
    try { g.release(); } catch (error) { released = "release failed"; }
    console.log(JSON.stringify({ outcome, released }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", child_source], { encoding: "utf8", env: process.env });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim().split("\n").pop() as string), { outcome: "PESHomeAccessViolation:", released: "release failed" });
});

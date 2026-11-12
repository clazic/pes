// SEL-103 — gaps of the home guard that SEL-95's final review found (tests/helpers/home_guard.ts). Everything uses a *fake* "real home" inside a
// temp folder; no test here looks at the account's real ~/.pes · ~/pes-projects · ~/.claude.
//
// Interface these tests fix (the worker has to meet it):
//   * use_home_guard(real_home?)  — same as before, plus an optional fake "real home" (string | string[]) that replaces the default real homes
//                                   for the fs guard and the before/after snapshot. Without an argument nothing changes.
//   * the guard's own `after` hook runs LAST: after every `after` hook the file registered later (hook order = release + final snapshot last).
//   * a path component that only STARTS with two dots (`..cache`) is an ordinary child name; only `..` itself (or `../`) leaves a folder.
//   * guard_process_fs also refuses: realpathSync (+ .native) · statfsSync · globSync (pattern or `cwd`) · mkdtempSync (prefix), their callback and
//     promises forms, and the other path-taking fs calls listed in EXTRA_PATH_APIS below. A call the guard denies throws / rejects with
//     `PESHomeAccessViolation: <fn> <path>` and is recorded in guard.violations (release() then fails).
//   * the guard's own path decisions (touches_protected · assert_isolated_env · take_home_snapshot) keep working while the guard is on (they use a
//     private, unwrapped realpath).
//   * Deliberately NOT path calls (documented limits, asserted below): file-descriptor calls (fstatSync(fd) …); a symlink alias spelled outside a
//     protected folder is the child guard's / layer 2's job.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { chownSync, existsSync, fstatSync, globSync, lchownSync, lutimesSync, mkdirSync, mkdtempSync, openSync, closeSync, openAsBlob, promises as fsp, readFileSync, realpathSync, rmSync, statfsSync, statSync, symlinkSync, watch, watchFile, unwatchFile, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { make_ctx } from "./helpers/compat_env.ts";
import { assert_isolated_env, guard_process_fs, take_home_snapshot, touches_protected, use_home_guard, type ProcessFsGuard } from "./helpers/home_guard.ts";

use_home_guard();

const GUARD_URL = pathToFileURL(join(import.meta.dirname, "helpers", "home_guard.ts")).href;

function fake_real_home(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "pes-sel103-fake-home-"));
  mkdirSync(join(dir, ".pes"), { recursive: true });
  writeFileSync(join(dir, ".pes", "config.json"), '{"home": "synthetic"}', "utf8");
  mkdirSync(join(dir, "pes-projects", "p"), { recursive: true });
  writeFileSync(join(dir, "pes-projects", "p", "project.json"), "{}", "utf8");
  mkdirSync(join(dir, ".claude", "plugins"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"), '{"theme": "synthetic"}', "utf8");
  for (const folder of [".claude", ".pes", "pes-projects"]) {
    mkdirSync(join(dir, folder, "..cache"), { recursive: true });
    writeFileSync(join(dir, folder, "..cache", "synthetic.txt"), "inside", "utf8");
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Run `body` with the fs guard on a fake home; always puts the fs functions back. Returns what the guard recorded. */
async function guarded(fake: { dir: string }, body: (guard: ProcessFsGuard) => unknown): Promise<string[]> {
  const guard = guard_process_fs(fake.dir);
  let recorded: string[] = [];
  try {
    await body(guard);
  } finally {
    recorded = [...guard.violations];
    try {
      guard.release();
    } catch {
      // a recorded violation makes release() fail — that is the point; the caller looks at `recorded`
    }
  }
  return recorded;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// 1. cleanup hooks registered AFTER use_home_guard() are still guarded

interface HookRun {
  status: number | null;
  output: string;
}

/** Runs a tiny test file in a child node: `use_home_guard(fake)` first, then an `after` hook of the file that does `hook_body`. */
function run_hook_file(mode: "touch-protected" | "touch-protected-swallowed" | "touch-safe" | "two-hooks-second-touches", fake_dir: string, work: string): HookRun {
  const file = join(work, `hook-${mode}.test.ts`);
  writeFileSync(
    file,
    `import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { use_home_guard } from ${JSON.stringify(GUARD_URL)};

const fake = ${JSON.stringify(fake_dir)};
use_home_guard(fake);
const mode = ${JSON.stringify(mode)};

if (mode === "two-hooks-second-touches") after(() => undefined);
after(() => {
  if (mode === "touch-safe") {
    lstatSync(fake); // the fake home itself is not protected
    return;
  }
  if (mode === "touch-protected-swallowed") {
    try {
      lstatSync(join(fake, ".claude"));
    } catch {
      // swallowed on purpose: the guard has still recorded it
    }
    return;
  }
  if (mode === "two-hooks-second-touches") {
    return;
  }
  readFileSync(join(fake, ".claude", "settings.json"));
});
if (mode === "two-hooks-second-touches") {
  after(() => {
    lstatSync(join(fake, ".pes"));
  });
}
test("noop", () => undefined);
`,
    "utf8",
  );
  const env: Record<string, string | undefined> = { ...process.env, PYTHONIOENCODING: "utf-8", HOME: work, USERPROFILE: work };
  delete env.NODE_TEST_CONTEXT; // we are inside a node:test run; the child must report on its own
  delete env.NODE_OPTIONS;
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", file], { encoding: "utf8", env: env as NodeJS.ProcessEnv, cwd: work, timeout: 60_000 });
  assert.equal(run.error, undefined, `the child test file started (${String(run.error)})`);
  assert.notEqual(run.status, null, `the child test file ended by itself (signal ${String(run.signal)})`);
  return { status: run.status, output: `${run.stdout}\n${run.stderr}`.replace(/\r\n/g, "\n") };
}

test("H1 control: a cleanup hook that stays away from the protected folders passes (the child test file really runs)", () => {
  const fake = fake_real_home();
  const ctx = make_ctx("pes-sel103-");
  try {
    const run = run_hook_file("touch-safe", fake.dir, ctx.tmp);
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /noop/, "the test of the child file ran");
    assert.ok(!run.output.includes("PESHomeAccessViolation"), run.output);
  } finally {
    ctx.cleanup();
    fake.cleanup();
  }
});

test("H2 an `after` hook registered after use_home_guard() that reads the protected folder fails the file with PESHomeAccessViolation", () => {
  const fake = fake_real_home();
  const ctx = make_ctx("pes-sel103-");
  try {
    const run = run_hook_file("touch-protected", fake.dir, ctx.tmp);
    assert.notEqual(run.status, 0, `the later cleanup hook touched the protected .claude, so the file must fail:\n${run.output}`);
    assert.match(run.output, /PESHomeAccessViolation/, run.output);
  } finally {
    ctx.cleanup();
    fake.cleanup();
  }
});

test("H3 a later cleanup hook that swallows the throw is still caught (the guard's last step sees the recorded violation)", () => {
  const fake = fake_real_home();
  const ctx = make_ctx("pes-sel103-");
  try {
    const run = run_hook_file("touch-protected-swallowed", fake.dir, ctx.tmp);
    assert.notEqual(run.status, 0, `a swallowed lstat of the protected .claude in a later hook must still fail the file:\n${run.output}`);
    assert.match(run.output, /home guard|PESHomeAccessViolation/, run.output);
  } finally {
    ctx.cleanup();
    fake.cleanup();
  }
});

test("H4 with several later `after` hooks, the one registered last is guarded too (the guard's release + final snapshot come after all of them)", () => {
  const fake = fake_real_home();
  const ctx = make_ctx("pes-sel103-");
  try {
    const run = run_hook_file("two-hooks-second-touches", fake.dir, ctx.tmp);
    assert.notEqual(run.status, 0, `the second later hook looked at .pes:\n${run.output}`);
    assert.match(run.output, /PESHomeAccessViolation/, run.output);
  } finally {
    ctx.cleanup();
    fake.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// 2. names that merely start with two dots are children, not a way out of the folder

test("D1 `..cache` (a real child name) inside .claude · .pes · pes-projects is protected: touches_protected and every fs read/write", async () => {
  const fake = fake_real_home();
  try {
    for (const folder of [".claude", ".pes", "pes-projects"]) {
      const child = join(fake.dir, folder, "..cache");
      assert.ok(touches_protected(child, fake.dir), `${folder}/..cache`);
      assert.ok(touches_protected(join(child, "synthetic.txt"), fake.dir), `${folder}/..cache/synthetic.txt`);
      assert.ok(touches_protected(join(fake.dir, folder, "..x", "deep", "file"), fake.dir), `${folder}/..x/deep/file (not even existing)`);
    }
    const recorded = await guarded(fake, () => {
      for (const folder of [".claude", ".pes", "pes-projects"]) {
        const file = join(fake.dir, folder, "..cache", "synthetic.txt");
        assert.throws(() => readFileSync(file), /PESHomeAccessViolation/, `readFileSync ${folder}/..cache/synthetic.txt`);
        assert.throws(() => statSync(join(fake.dir, folder, "..cache")), /PESHomeAccessViolation/, `statSync ${folder}/..cache`);
        assert.throws(() => writeFileSync(join(fake.dir, folder, "..cache", "new.txt"), "x"), /PESHomeAccessViolation/, `writeFileSync ${folder}/..cache/new.txt`);
      }
    });
    assert.equal(recorded.length, 9, `nine refusals recorded: ${recorded.join(" | ")}`);
  } finally {
    fake.cleanup();
  }
});

test("D2 a real `..` still leaves the folder: .claude/.. is the home, .claude/../other and a look-alike ..claude are not protected", async () => {
  const fake = fake_real_home();
  try {
    writeFileSync(join(fake.dir, "other.txt"), "outside", "utf8");
    mkdirSync(join(fake.dir, "..claude"), { recursive: true });
    writeFileSync(join(fake.dir, "..claude", "x.txt"), "look-alike", "utf8");
    assert.ok(!touches_protected(join(fake.dir, ".claude", ".."), fake.dir), ".claude/.. is the home itself");
    assert.ok(!touches_protected(join(fake.dir, ".claude", "..", "other.txt"), fake.dir), ".claude/../other.txt");
    assert.ok(!touches_protected(join(fake.dir, "..claude", "x.txt"), fake.dir), "..claude is a sibling look-alike");
    const recorded = await guarded(fake, () => {
      assert.equal(readFileSync(join(fake.dir, ".claude", "..", "other.txt"), "utf8"), "outside");
      assert.equal(readFileSync(join(fake.dir, "..claude", "x.txt"), "utf8"), "look-alike");
      assert.ok(existsSync(join(fake.dir, ".claude", "..")));
    });
    assert.deepEqual(recorded, []);
  } finally {
    fake.cleanup();
  }
});

test("D3 assert_isolated_env refuses a HOME / PES_HOME that lies in a `..cache` child of a protected folder", () => {
  const fake = fake_real_home();
  const ctx = make_ctx("pes-sel103-");
  try {
    const ok = { ...ctx.env };
    assert_isolated_env(ok, fake.dir);
    const inside_cache = join(fake.dir, ".claude", "..cache");
    assert.throws(() => assert_isolated_env({ ...ok, PES_HOME: inside_cache }, fake.dir), /home guard/, "PES_HOME in .claude/..cache");
    assert.throws(() => assert_isolated_env({ ...ok, HOME: inside_cache, USERPROFILE: inside_cache }, fake.dir), /home guard/, "HOME in .claude/..cache");
  } finally {
    ctx.cleanup();
    fake.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// 3. path-taking fs APIs that the guard used to miss

test("A1 realpathSync · realpathSync.native · statfsSync · globSync · mkdtempSync on the protected folders throw PESHomeAccessViolation (sync)", async () => {
  const fake = fake_real_home();
  try {
    const recorded = await guarded(fake, () => {
      for (const folder of [".claude", ".pes", "pes-projects"]) {
        const dir = join(fake.dir, folder);
        const file = join(dir, folder === ".claude" ? "settings.json" : folder === ".pes" ? "config.json" : join("p", "project.json"));
        assert.throws(() => realpathSync(file), /PESHomeAccessViolation/, `realpathSync ${folder}`);
        assert.throws(() => realpathSync.native(file), /PESHomeAccessViolation/, `realpathSync.native ${folder}`);
        assert.throws(() => statfsSync(dir), /PESHomeAccessViolation/, `statfsSync ${folder}`);
        assert.throws(() => globSync("*", { cwd: dir }), /PESHomeAccessViolation/, `globSync cwd=${folder}`);
        assert.throws(() => globSync(join(dir, "*")), /PESHomeAccessViolation/, `globSync absolute pattern in ${folder}`);
        assert.throws(() => mkdtempSync(join(dir, "pfx-")), /PESHomeAccessViolation/, `mkdtempSync prefix in ${folder}`);
      }
    });
    assert.equal(recorded.length, 18, `eighteen refusals recorded: ${recorded.join(" | ")}`);
    for (const folder of [".claude", ".pes", "pes-projects"]) {
      assert.deepEqual(
        fs.readdirSync(join(fake.dir, folder)).filter((name) => name.startsWith("pfx-")),
        [],
        `mkdtempSync must not create anything in ${folder}`,
      );
    }
  } finally {
    fake.cleanup();
  }
});

test("A2 the callback forms (realpath · realpath.native · statfs · glob · mkdtemp) on a protected folder are refused too", async () => {
  const fake = fake_real_home();
  try {
    const dir = join(fake.dir, ".claude");
    const file = join(dir, "settings.json");
    const never = (): void => {
      throw new Error("the callback must not be reached for a protected path");
    };
    const forms: Array<[string, () => unknown]> = [
      ["realpath", () => fs.realpath(file, never)],
      ["realpath.native", () => fs.realpath.native(file, never)],
      ["statfs", () => fs.statfs(dir, never)],
      ["glob cwd", () => fs.glob("*", { cwd: dir }, never)],
      ["mkdtemp", () => fs.mkdtemp(join(dir, "cb-"), never)],
    ];
    const recorded = await guarded(fake, async () => {
      for (const [what, run] of forms) {
        await assert.rejects(
          async () => {
            await new Promise<void>((resolve, reject) => {
              try {
                run();
                setTimeout(resolve, 200); // not refused at all: let the real call finish so the test fails on the assertion, not on a hang
              } catch (error) {
                reject(error);
              }
            });
          },
          /PESHomeAccessViolation/,
          `callback ${what}`,
        );
      }
    });
    assert.equal(recorded.length, forms.length, recorded.join(" | "));
  } finally {
    fake.cleanup();
  }
});

test("A3 the promises forms (realpath · statfs · glob · mkdtemp) on a protected folder reject with PESHomeAccessViolation", async () => {
  const fake = fake_real_home();
  try {
    const dir = join(fake.dir, ".pes");
    const recorded = await guarded(fake, async () => {
      await assert.rejects(fsp.realpath(join(dir, "config.json")), /PESHomeAccessViolation/, "promises.realpath");
      await assert.rejects(fsp.statfs(dir), /PESHomeAccessViolation/, "promises.statfs");
      await assert.rejects(fsp.mkdtemp(join(dir, "pr-")), /PESHomeAccessViolation/, "promises.mkdtemp");
      await assert.rejects(
        async () => {
          for await (const _entry of fsp.glob("*", { cwd: dir })) void _entry;
        },
        /PESHomeAccessViolation/,
        "promises.glob (first iteration)",
      );
    });
    assert.equal(recorded.length, 4, recorded.join(" | "));
  } finally {
    fake.cleanup();
  }
});

/** More fs calls that take a path and could look at / change the protected folders. Each must be refused; the list is the contract. */
const EXTRA_PATH_APIS: Array<[string, (dir: string, file: string) => unknown, (() => boolean)?]> = [
  ["chownSync", (dir) => chownSync(dir, process.getuid?.() ?? 0, process.getgid?.() ?? 0), () => process.platform !== "win32"],
  ["lchownSync", (dir) => lchownSync(dir, process.getuid?.() ?? 0, process.getgid?.() ?? 0), () => process.platform !== "win32"],
  ["lutimesSync", (dir) => lutimesSync(dir, new Date(), new Date())],
  ["watch", (dir) => watch(dir, () => undefined).close()],
  ["watchFile", (_dir, file) => watchFile(file, () => undefined)],
  ["openAsBlob", (_dir, file) => openAsBlob(file)],
];

test("A4 the other path-taking calls (chown · lchown · lutimes · watch · watchFile · openAsBlob) are refused as well", async () => {
  const fake = fake_real_home();
  const dir = join(fake.dir, ".claude");
  const file = join(dir, "settings.json");
  try {
    const recorded = await guarded(fake, async () => {
      for (const [name, run, applies] of EXTRA_PATH_APIS) {
        if (applies !== undefined && !applies()) continue;
        await assert.rejects(async () => run(dir, file), /PESHomeAccessViolation/, name);
      }
    });
    const expected = EXTRA_PATH_APIS.filter(([, , applies]) => applies === undefined || applies()).length;
    assert.equal(recorded.length, expected, recorded.join(" | "));
  } finally {
    unwatchFile(file); // only matters when the guard let watchFile through
    fake.cleanup();
  }
});

test("A5 release() puts every wrapped function back, and what is allowed keeps working while the guard is on", async () => {
  const fake = fake_real_home();
  const safe = mkdtempSync(join(tmpdir(), "pes-sel103-safe-"));
  const original = { realpath: realpathSync, native: realpathSync.native, statfs: statfsSync, glob: globSync, mkdtemp: mkdtempSync, fsp_realpath: fsp.realpath };
  try {
    writeFileSync(join(safe, "a.txt"), "ok", "utf8");
    const guard = guard_process_fs(fake.dir);
    try {
      assert.equal(typeof realpathSync.native, "function", "realpathSync.native survives the wrapping");
      assert.ok(realpathSync(join(safe, "a.txt")).endsWith("a.txt"), "realpathSync of a non-protected path");
      assert.ok(realpathSync.native(join(safe, "a.txt")).endsWith("a.txt"), "realpathSync.native of a non-protected path");
      assert.ok(statfsSync(safe).bsize > 0, "statfsSync of a non-protected path");
      assert.deepEqual(globSync("*.txt", { cwd: safe }), ["a.txt"], "globSync in a non-protected folder");
      const made = mkdtempSync(join(safe, "pfx-"));
      assert.ok(existsSync(made), "mkdtempSync in a non-protected folder");
    } finally {
      assert.doesNotThrow(() => guard.release());
    }
    assert.equal(realpathSync, original.realpath);
    assert.equal(realpathSync.native, original.native);
    assert.equal(statfsSync, original.statfs);
    assert.equal(globSync, original.glob);
    assert.equal(mkdtempSync, original.mkdtemp);
    assert.equal(fsp.realpath, original.fsp_realpath);
  } finally {
    rmSync(safe, { recursive: true, force: true });
    fake.cleanup();
  }
});

test("A6 the guard's own decisions keep working while it is on (private realpath): touches_protected of a symlink alias, the snapshot, assert_isolated_env", async () => {
  const fake = fake_real_home();
  const ctx = make_ctx("pes-sel103-");
  try {
    let alias_ok = true;
    const alias = join(ctx.tmp, "alias-to-claude");
    try {
      symlinkSync(join(fake.dir, ".claude"), alias, "junction");
    } catch {
      alias_ok = false; // no symlink right (Windows without developer mode): the alias half is skipped
    }
    const recorded = await guarded(fake, () => {
      assert.ok(touches_protected(join(fake.dir, ".claude", "x"), fake.dir), "a protected spelling is decided without realpath");
      if (alias_ok) assert.ok(touches_protected(join(alias, "x"), fake.dir), "a symlink alias outside the folder is seen through by the guard's own realpath");
      assert.doesNotThrow(() => take_home_snapshot(fake.dir).check());
      assert.doesNotThrow(() => assert_isolated_env(ctx.env, fake.dir));
    });
    assert.deepEqual(recorded, [], "the guard's own look-ups are not violations");
  } finally {
    ctx.cleanup();
    fake.cleanup();
  }
});

test("A7 documented limit: file-descriptor calls are not path calls (fstatSync on an already open fd works with the guard on)", async () => {
  const fake = fake_real_home();
  const safe = mkdtempSync(join(tmpdir(), "pes-sel103-fd-"));
  try {
    writeFileSync(join(safe, "fd.txt"), "fd", "utf8");
    const fd = openSync(join(safe, "fd.txt"), "r");
    try {
      const recorded = await guarded(fake, () => {
        assert.equal(fstatSync(fd).size, 2);
      });
      assert.deepEqual(recorded, []);
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(safe, { recursive: true, force: true });
    fake.cleanup();
  }
});

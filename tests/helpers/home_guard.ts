// The guards of the temporary-home tests (SEL-70, PR26a; SEL-74: the Python audit hook of the 0.15 children is gone — what is left guards the ts
// children and the test process itself).
//
// Two layers outside the child, one inside it:
//   * inside the child (TS): `--permission` with an allow-list that holds no real home, plus `ts_child_guard.ts` (`--import`) that reports
//     `PESHomeAccessViolation` for a read or write of the real `~/.pes` / `~/pes-projects` — see compat_ts.ts and test_pes_ts_guard.
//   * the three layers below, for every child.
// The three layers (for every child, Python or not):
//   1. assert_isolated_env(env)  — a child process may only start with HOME / USERPROFILE / PES_HOME inside one temp folder that
//                                  is not (and does not contain, and is not inside) the protected folders of either real home.
//   2. use_home_guard()          — names / sizes / mtimes (never contents) of the real <home>/.pes and <home>/pes-projects are
//                                  taken before the file's tests and compared after them; any change fails the file. An absent
//                                  folder must stay absent. This catches creations / deletions / edits, never a pure read.
//   3. assert_no_real_path(text) — a child's stdout / stderr / a produced file must not mention a protected real path.
// "Real home" means BOTH os.homedir() (follows $HOME, i.e. the temp folder when the whole run is isolated) and
// os.userInfo().homedir (the account's home, whatever $HOME says); a duplicate is looked at once.
// 4. guard_process_fs()        — (SEL-95) the test process itself: every fs call (stat · read · readdir · exists · open · write …, sync, callback
//                                  and promises) on a path inside the real <home>/.pes, <home>/pes-projects or <home>/.claude is recorded as a
//                                  PESHomeAccessViolation and thrown; use_home_guard() fails the file at the end even if the test swallowed the
//                                  throw (try/catch "absent"). Layer 2 can only see *changes* of .pes / pes-projects; a test that stat()ed the real
//                                  ~/.claude and compared mtimes (D13) passed or flaked depending on other Claude sessions — now it cannot even look.
// Layer 2 reuses the Playwright globalSetup listing (tests/e2e/helpers/home_guard.ts). All of it works with a *fake* "real home"
// too, so the guard itself is tested without touching anything real (tests/test_home_guard.test.ts).

import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before } from "node:test";

import { snapshot_of } from "../e2e/helpers/home_guard.ts";

/** Folders of a real home no test may look at. `.pes` and `pes-projects` are also compared before / after (layer 2); `.claude` is denied only —
 * other Claude sessions write there all the time, so a before / after comparison of it is a flaky test, not a guard (SEL-95, D13). */
export const PROTECTED_NAMES = [".pes", "pes-projects", ".claude"] as const;

/** The account's real home, whatever $HOME / %USERPROFILE% say (the home a Python child must never open anything below). */
export function account_home(): string {
  try {
    return userInfo().homedir || homedir();
  } catch {
    return homedir();
  }
}

/** Every home that counts as "real": os.homedir() and the account home (one entry when they are the same folder). */
export function real_homes(): string[] {
  const out: string[] = [];
  for (const home of [homedir(), account_home()]) if (!out.some((seen) => norm(seen) === norm(home))) out.push(home);
  return out;
}

type Homes = string | readonly string[];
function homes_of(real_home: Homes | undefined): readonly string[] {
  if (real_home === undefined) return real_homes();
  return typeof real_home === "string" ? [real_home] : real_home;
}

/** realpath.native of the longest existing prefix (symlinks, junctions, Windows 8.3 names), the missing tail appended unchanged. */
function native(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...[...tail].reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(basename(current));
      current = parent;
    }
  }
}

function norm(path: string): string {
  const full = resolve(path);
  return process.platform === "win32" || process.platform === "darwin" ? full.toLowerCase() : full;
}

/** Every spelling of the protected folders of one home: as given, resolved (symlinks / 8.3 names), forward and doubled backslashes. */
export function protected_paths(real_home?: Homes): string[] {
  const bases = new Set(homes_of(real_home).flatMap((home) => [resolve(home), native(home)]));
  const out = new Set<string>();
  for (const base of bases) {
    for (const name of PROTECTED_NAMES) {
      const path = join(base, name);
      out.add(path);
      if (path.includes("\\")) {
        out.add(path.split("\\").join("/"));
        out.add(path.split("\\").join("\\\\"));
      }
    }
  }
  return [...out];
}

function inside(path: string, folder: string): boolean {
  const rel = relative(norm(folder), norm(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * True when `path` is, or lies below, a protected folder of a real home. A path that looks protected is decided from its spelling
 * alone (the filesystem is not touched); only a path that does not look protected is resolved (realpath of its existing prefix) to
 * see through a symlink / junction alias.
 */
export function touches_protected(path: string, real_home?: Homes): boolean {
  const bases = new Set(homes_of(real_home).flatMap((home) => [resolve(home), native(home)]));
  for (const base of bases) {
    for (const name of PROTECTED_NAMES) if (inside(path, join(base, name))) return true;
  }
  const resolved = native(path);
  for (const base of bases) {
    for (const name of PROTECTED_NAMES) if (inside(resolved, join(base, name))) return true;
  }
  return false;
}

export function assert_isolated_env(env: Record<string, string | undefined>, real_home?: Homes): void {
  for (const key of ["HOME", "USERPROFILE", "PES_HOME"] as const) {
    const value = env[key];
    assert.ok(typeof value === "string" && value !== "", `home guard: ${key} must be set to a temporary folder`);
    assert.ok(isAbsolute(value), `home guard: ${key} must be absolute`);
    assert.ok(!touches_protected(value, real_home), `home guard: ${key} points into the real PES home (${value})`);
  }
  assert.equal(env.HOME, env.USERPROFILE, "home guard: HOME and USERPROFILE must be the same folder");
  const real = new Set(homes_of(real_home).flatMap((home) => [resolve(home), native(home)]).map(norm));
  assert.ok(!real.has(norm(env.HOME as string)), "home guard: HOME is the real home");
  assert.ok(!real.has(norm(env.PES_HOME as string)), "home guard: PES_HOME is the real home");
  for (const key of ["PES_OWNER", "PES_TOKEN", "PES_DB_CORE"] as const) {
    assert.equal(env[key], undefined, `home guard: ${key} must not leak into a compat child`);
  }
}

export function assert_no_real_path(text: string, what: string, real_home?: Homes): void {
  const flat = text.split("\\\\").join("\\");
  for (const path of protected_paths(real_home)) {
    assert.ok(!text.includes(path) && !flat.includes(path), `home guard: ${what} mentions the real path ${path}`);
  }
}

export interface HomeSnapshot {
  /** the homes that were listed (os.homedir() and the account home unless given) */
  readonly homes: readonly string[];
  readonly before: string;
  check(): void;
}

export function take_home_snapshot(real_home?: Homes): HomeSnapshot {
  const homes = homes_of(real_home);
  const list = (): string => unguarded(() => JSON.stringify(homes.map((home) => snapshot_of(home))));
  const first = list();
  return {
    homes,
    before: first,
    check(): void {
      const second = list();
      assert.equal(second, first, `home guard: ${homes.join(" | ")}/.pes or pes-projects changed (names, sizes or mtimes differ)`);
    },
  };
}

/** A Python child that tripped the audit hook says so on stderr; that is a test failure, never a "result". */
export function assert_no_violation(text: string, what: string): void {
  assert.ok(!text.includes("PESHomeAccessViolation"), `home guard: ${what} — the child touched the real PES home:\n${text.split("\n").filter((line) => line.includes("PESHomeAccessViolation")).slice(-2).join("\n")}`);
}

// ---------------------------------------------------------------------------
// layer 4 — the test process's own fs calls (SEL-95)

const cjs_fs = createRequire(import.meta.url)("node:fs") as Record<string, any>;

const FS_ONE_PATH = [
  "statSync", "lstatSync", "existsSync", "accessSync", "readFileSync", "readdirSync", "opendirSync", "openSync", "readlinkSync",
  "createReadStream", "createWriteStream", "writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "rmdirSync", "unlinkSync", "utimesSync", "chmodSync", "truncateSync",
  "stat", "lstat", "exists", "access", "readFile", "readdir", "opendir", "open", "readlink", "writeFile", "appendFile", "mkdir", "rm", "rmdir", "unlink", "utimes", "chmod", "truncate",
] as const;
const FS_TWO_PATH = ["copyFileSync", "cpSync", "renameSync", "linkSync", "copyFile", "cp", "rename", "link"] as const;
const FS_PROMISE_NAMES = ["stat", "lstat", "access", "readFile", "readdir", "opendir", "open", "readlink", "writeFile", "appendFile", "mkdir", "rm", "rmdir", "unlink", "utimes", "chmod", "truncate", "copyFile", "cp", "rename", "link", "symlink"] as const;

let allowed = 0;

/** Run `fn` with the process fs guard off (the before / after listing of the guard's own homes). */
export function unguarded<T>(fn: () => T): T {
  allowed += 1;
  try {
    return fn();
  } finally {
    allowed -= 1;
  }
}

function as_path(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof URL) {
    try {
      return fileURLToPath(value);
    } catch {
      return undefined;
    }
  }
  return undefined; // a file descriptor or anything else: not a path
}

export interface ProcessFsGuard {
  /** every access that was refused (also the ones the test swallowed) */
  readonly violations: readonly string[];
  /** put the original fs functions back; fails when a violation was recorded */
  release(): void;
}

/**
 * Deny (throw `PESHomeAccessViolation: <fn> <path>`) and record every fs call of this process whose path lies in a protected folder of the
 * real home(s). Decided from the spelling of the path alone (no realpath per call); a symlink alias is the child guard's and layer 2's job.
 */
export function guard_process_fs(real_home?: Homes): ProcessFsGuard {
  const bases = [...new Set(homes_of(real_home).flatMap((home) => [resolve(home), native(home)]))];
  const folders = bases.flatMap((base) => PROTECTED_NAMES.map((name) => join(base, name)));
  const violations: string[] = [];
  const hit = (fn: string, value: unknown): void => {
    if (allowed > 0) return;
    const path = as_path(value);
    if (path === undefined || path === "") return;
    const full = resolve(path);
    if (folders.some((folder) => inside(full, folder))) {
      const message = `PESHomeAccessViolation: ${fn} ${full}`;
      violations.push(message);
      throw new Error(message);
    }
  };
  const restore: Array<() => void> = [];
  const wrap = (target: Record<string, any>, name: string, paths: number, label: string, promise: boolean): void => {
    const original = target[name];
    if (typeof original !== "function") return;
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      try {
        for (let i = 0; i < paths; i += 1) hit(`${label}${name}`, args[i]);
      } catch (error) {
        if (promise) return Promise.reject(error);
        throw error;
      }
      return original.apply(this, args);
    };
    for (const key of Object.keys(original)) (wrapped as any)[key] = original[key]; // e.g. realpathSync.native
    target[name] = wrapped;
    restore.push(() => {
      target[name] = original;
    });
  };
  for (const name of FS_ONE_PATH) wrap(cjs_fs, name, 1, "fs.", false);
  for (const name of FS_TWO_PATH) wrap(cjs_fs, name, 2, "fs.", false);
  wrap(cjs_fs, "symlinkSync", 2, "fs.", false);
  for (const name of FS_PROMISE_NAMES) wrap(cjs_fs.promises, name, ["copyFile", "cp", "rename", "link", "symlink"].includes(name) ? 2 : 1, "fs.promises.", true);
  syncBuiltinESMExports();
  return {
    violations,
    release(): void {
      for (const undo of restore.reverse()) undo();
      restore.length = 0;
      syncBuiltinESMExports();
      assert.deepEqual(violations, [], `home guard: the test process touched the real home (${violations.length} access)`);
    },
  };
}

/** Call once at the top of a test file: compares the real home before / after the file's tests, and denies every look at the real home (layer 4). */
export function use_home_guard(): void {
  let snapshot: HomeSnapshot | undefined;
  let fs_guard: ProcessFsGuard | undefined;
  before(() => {
    snapshot = take_home_snapshot();
    fs_guard = guard_process_fs();
  });
  after(() => {
    fs_guard?.release();
    snapshot?.check();
  });
}

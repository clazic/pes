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
//   2. use_home_guard()          — names / sizes / mtimes (never contents) of <home>/.pes and <home>/pes-projects are taken before the file's
//                                  tests and compared after them; any change fails the file. An absent folder must stay absent. This catches
//                                  creations / deletions / edits, never a pure read. (SEL-103) Only the TEMPORARY home (os.homedir()) and the
//                                  fake homes a test passes in are listed — the real account home is NEVER listed: a lstat / readdir of ~/.pes
//                                  is itself a look at it. The real account home is protected by layers 0 and 4, decided from spellings.
//   3. assert_no_real_path(text) — a child's stdout / stderr / a produced file must not mention a protected real path.
// "Real home" (what is PROTECTED: layers 1, 3, 4, touches_protected) means BOTH os.homedir() (follows $HOME, i.e. the temp folder when the whole run is isolated)
// and os.userInfo().homedir (the account's home, whatever $HOME says); a duplicate is looked at once. What is LISTED (layer 2) is less: listed_homes().
// 4. guard_process_fs()        — (SEL-95, SEL-103) the test process itself: every path-taking fs call (stat · read · readdir · exists · open · write ·
//                                  realpath · statfs · glob · mkdtemp · chown · lutimes · watch · openAsBlob …, sync, callback and promises)
//                                  on a path inside the real <home>/.pes, <home>/pes-projects or <home>/.claude is recorded as a
//                                  PESHomeAccessViolation and thrown; use_home_guard() fails the file at the end even if the test swallowed the
//                                  throw (try/catch "absent"). Layer 2 can only see *changes* of .pes / pes-projects; a test that stat()ed the real
//                                  ~/.claude and compared mtimes (D13) passed or flaked depending on other Claude sessions — now it cannot even look.
//                                  Whole-tree calls (rm · rmdir · rename · cp, a recursive readdir / opendir / watch) are refused on a PARENT of a protected
//                                  folder too — the home itself included; Windows spellings are made plain first, with layer 0's rewrite (SEL-103).
//                                  Deliberately NOT covered (documented in tests/README.md): calls on an already open file descriptor (fstatSync(fd) …,
//                                  the fd was opened by a path call the guard saw), a symlink / junction alias that is spelled outside a protected
//                                  folder (layer 2 and the child guard's realpath own that), wildcards that expand into a protected folder from an
//                                  ancestor (`globSync("*/x", { cwd: home })` — only the cwd and the pattern's own spelling are looked at), other
//                                  channels (child processes, node:sqlite, native addons, `process.binding`).
// 0. (SEL-103) a run that STARTS in the real account home is refused before any layer lists anything: require_temp_home.ts (`--import`) and the first import
//    of this file compare HOME / USERPROFILE with the account home as strings (temp_home_check.ts) — no fs call on the real home. The Playwright run
//    is refused the same way (playwright.config.ts · the globalSetup).
// Layer 2 reuses the Playwright globalSetup listing (tests/e2e/helpers/home_guard.ts). No default look at the account home anywhere — the guard does not even
// realpath it (base_spellings): tests/test_sel103_no_account_listing proves it with a recorder (zero fs calls) on a fake account home. All of it works with a *fake* "real home"
// too, so the guard itself is tested without touching anything real (tests/test_home_guard.test.ts).

// SEL-103: FIRST import, on purpose — a run that starts in the real account home must fail here, before anything below (the snapshot helper, the guard) can list or
// stat a path of it. ESM evaluates imports in order, so this side-effect module runs before the next ones. Strings only (temp_home_check.ts).
import "./require_temp_home.ts";

import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before } from "node:test";

import { snapshot_of } from "../e2e/helpers/home_guard.ts";
import { PROTECTED_NAMES, default_account_homes, is_account_home, plain_windows_spelling } from "./temp_home_check.ts";

/** Folders of a real home no test may look at. `.pes` and `pes-projects` are also compared before / after (layer 2); `.claude` is denied only —
 * other Claude sessions write there all the time, so a before / after comparison of it is a flaky test, not a guard (SEL-95, D13). */
export { PROTECTED_NAMES }; // defined in temp_home_check.ts (the start check needs it and may not import this module)

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

/**
 * The homes whose `.pes` / `pes-projects` the before / after listing (layer 2) may LOOK at (SEL-103): the temporary HOME (os.homedir(); layer 0 has refused
 * the run if it were the real one) and the fake homes a test passes in — never an account home. The real account home is protected by layer 0 and layer 4
 * (decided from spellings); listing it would itself be a lstat / readdir of ~/.pes, which nothing may do. Decided by comparing strings, no fs call.
 */
export function listed_homes(real_home?: Homes): readonly string[] {
  const accounts = default_account_homes();
  return (real_home === undefined ? [homedir()] : homes_of(real_home)).filter((home) => !is_account_home(home, accounts));
}

/** Every spelling of the homes' own folders: as given, and (a temporary or fake home) with symlinks / 8.3 names resolved. An account home is NOT resolved — realpath of it would be an fs call on the real home; its spelling (os.userInfo().homedir) is already the canonical one. */
function base_spellings(homes: readonly string[]): string[] {
  const accounts = default_account_homes();
  return [...new Set(homes.flatMap((home) => (is_account_home(home, accounts) ? [resolve(home)] : [resolve(home), native(home)])))];
}

const cjs_fs = createRequire(import.meta.url)("node:fs") as Record<string, any>;

/** The guard's own realpath: the original, unwrapped `fs.realpathSync.native` taken when this module loads (before any guard wraps `fs`), so the
 * guard's path decisions are never counted as (or refused as) accesses of the test. */
const raw_realpath_native: (path: string) => string = cjs_fs.realpathSync.native;

/** realpath.native of the longest existing prefix (symlinks, junctions, Windows 8.3 names), the missing tail appended unchanged. */
function native(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(raw_realpath_native(current), ...[...tail].reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** Windows path rules (node:path is win32): the namespace / administrative-share spellings are rewritten first (SEL-103). */
const WINDOWS_PATHS = sep === "\\";

/**
 * Absolute, case-folded on the case-insensitive systems. On Windows the spelling is first made plain with layer 0's own rewrite (plain_windows_spelling):
 * `\\?\C:\x` · `\\localhost\c$\x` are `C:\x`, for a protected root and for a called path alike (SEL-103). An unreadable namespace stays as spelled.
 */
function norm(path: string): string {
  const full = resolve(WINDOWS_PATHS ? (plain_windows_spelling(path) ?? path) : path);
  return process.platform === "win32" || process.platform === "darwin" ? full.toLowerCase() : full;
}

/** Every spelling of the protected folders of one home: as given, resolved (symlinks / 8.3 names), forward and doubled backslashes. */
export function protected_paths(real_home?: Homes): string[] {
  const bases = new Set(base_spellings(homes_of(real_home)));
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

/** Only `..` itself (or `..<sep>…`) leaves the folder; `..cache` is an ordinary child name (SEL-103). */
function inside(path: string, folder: string): boolean {
  const rel = relative(norm(folder), norm(path));
  if (rel === "") return true;
  if (isAbsolute(rel)) return false; // another drive
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

/**
 * True when `path` is, or lies below, a protected folder of a real home. A path that looks protected is decided from its spelling
 * alone (the filesystem is not touched); only a path that does not look protected is resolved (realpath of its existing prefix) to
 * see through a symlink / junction alias.
 */
export function touches_protected(path: string, real_home?: Homes): boolean {
  const bases = new Set(base_spellings(homes_of(real_home)));
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
  const real = new Set(base_spellings(homes_of(real_home)).map(norm));
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
  /** the homes that were listed: os.homedir() (the temporary HOME) unless given — never the account home (listed_homes) */
  readonly homes: readonly string[];
  readonly before: string;
  check(): void;
}

export function take_home_snapshot(real_home?: Homes): HomeSnapshot {
  const homes = listed_homes(real_home);
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

// Path-taking fs functions, by how many leading arguments are paths. A name that is not a function on this Node is skipped.
const FS_ONE_PATH = [
  // sync
  "statSync", "lstatSync", "existsSync", "accessSync", "readFileSync", "readdirSync", "opendirSync", "openSync", "readlinkSync", "realpathSync", "statfsSync",
  "createReadStream", "createWriteStream", "writeFileSync", "appendFileSync", "mkdirSync", "mkdtempSync", "mkdtempDisposableSync", "rmSync", "rmdirSync", "unlinkSync",
  "utimesSync", "lutimesSync", "chmodSync", "lchmodSync", "chownSync", "lchownSync", "truncateSync", "watch", "watchFile",
  // callback
  "stat", "lstat", "exists", "access", "readFile", "readdir", "opendir", "open", "readlink", "realpath", "statfs", "writeFile", "appendFile", "mkdir", "mkdtemp", "rm", "rmdir", "unlink",
  "utimes", "lutimes", "chmod", "lchmod", "chown", "lchown", "truncate",
] as const;
const FS_TWO_PATH = ["copyFileSync", "cpSync", "renameSync", "linkSync", "symlinkSync", "copyFile", "cp", "rename", "link", "symlink"] as const;
const FS_PROMISE_ONE_PATH = [
  "stat", "lstat", "access", "readFile", "readdir", "opendir", "open", "readlink", "realpath", "statfs", "writeFile", "appendFile", "mkdir", "mkdtemp", "mkdtempDisposable", "rm", "rmdir",
  "unlink", "utimes", "lutimes", "chmod", "lchmod", "chown", "lchown", "truncate",
] as const;
const FS_PROMISE_TWO_PATH = ["copyFile", "cp", "rename", "link", "symlink"] as const;
/**
 * (SEL-103) Calls that act on a whole tree: removing, moving or copying `~` (or a folder above it) removes, moves or reads `~/.pes` without the guard ever
 * seeing a protected path — the recursion happens inside fs, not through the wrapped functions. For these, a path that is a PARENT of a protected folder
 * (the home itself included) is refused as well, every path argument (source and destination). A plain stat / readdir / open of the home stays allowed.
 */
const WHOLE_TREE = new Set(["rmSync", "rm", "rmdirSync", "rmdir", "renameSync", "rename", "cpSync", "cp"]);
/** The same, only when called with `{ recursive: true }` (they then walk below the folder). */
const WHOLE_TREE_IF_RECURSIVE = new Set(["readdirSync", "readdir", "opendirSync", "opendir", "watch"]);

function is_recursive(options: unknown): boolean {
  return typeof options === "object" && options !== null && (options as { recursive?: unknown }).recursive === true;
}

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
 * Deny (throw `PESHomeAccessViolation: <fn> <path>`) and record every path-taking fs call of this process whose path lies in a protected folder of
 * the real home(s). Decided from the spelling of the path alone (no realpath per call); a symlink alias is the child guard's and layer 2's job.
 * Sync and callback forms throw at once; promise forms reject; the iterator forms (`promises.glob` · `promises.watch`) fail on the first iteration.
 */
export function guard_process_fs(real_home?: Homes): ProcessFsGuard {
  const bases = base_spellings(homes_of(real_home));
  const folders = bases.flatMap((base) => PROTECTED_NAMES.map((name) => join(base, name)));
  const violations: string[] = [];
  /** `whole_tree`: the call acts on everything below `value` (rm · rename · cp · a recursive readdir …) — then a PARENT of a protected folder is refused too. */
  const hit = (fn: string, value: unknown, whole_tree = false): void => {
    if (allowed > 0) return;
    const path = as_path(value);
    if (path === undefined || path === "") return;
    const full = resolve(path);
    if (folders.some((folder) => inside(full, folder) || (whole_tree && inside(folder, full)))) {
      const message = `PESHomeAccessViolation: ${fn} ${full}`;
      violations.push(message);
      throw new Error(message);
    }
  };
  const leading = (paths: number): Check => (args, fn) => {
    const name = fn.slice(fn.lastIndexOf(".") + 1);
    const whole_tree = WHOLE_TREE.has(name) || (WHOLE_TREE_IF_RECURSIVE.has(name) && is_recursive(args[1]));
    for (let i = 0; i < paths; i += 1) hit(fn, args[i], whole_tree);
  };
  // glob(pattern | patterns, { cwd }): the cwd, and every pattern as spelled (resolved against the cwd — `*` in a protected cwd, or an absolute pattern into one)
  const glob_check: Check = (args, fn) => {
    const options = typeof args[1] === "object" && args[1] !== null ? (args[1] as { cwd?: unknown }) : {};
    const cwd = as_path(options.cwd);
    if (cwd !== undefined) hit(fn, cwd);
    for (const pattern of Array.isArray(args[0]) ? args[0] : [args[0]]) if (typeof pattern === "string") hit(fn, resolve(cwd ?? process.cwd(), pattern));
  };
  const restore: Array<() => void> = [];
  const wrap = (target: Record<string, any>, name: string, label: string, mode: Mode, check: Check): void => {
    const original = target[name];
    if (typeof original !== "function") return;
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      try {
        check(args, `${label}${name}`);
      } catch (error) {
        if (mode === "promise") return Promise.reject(error);
        if (mode === "iterator") return refused_iterator(error);
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
  for (const name of FS_ONE_PATH) wrap(cjs_fs, name, "fs.", "sync", leading(1));
  for (const name of FS_TWO_PATH) wrap(cjs_fs, name, "fs.", "sync", leading(2));
  wrap(cjs_fs, "openAsBlob", "fs.", "promise", leading(1));
  wrap(cjs_fs, "globSync", "fs.", "sync", glob_check);
  wrap(cjs_fs, "glob", "fs.", "sync", glob_check);
  // `.native` of the two realpath functions is a function of its own (copied onto the wrapper above, so it is wrapped on the wrapper)
  wrap(cjs_fs.realpathSync, "native", "fs.realpathSync.", "sync", leading(1));
  wrap(cjs_fs.realpath, "native", "fs.realpath.", "sync", leading(1));
  for (const name of FS_PROMISE_ONE_PATH) wrap(cjs_fs.promises, name, "fs.promises.", "promise", leading(1));
  for (const name of FS_PROMISE_TWO_PATH) wrap(cjs_fs.promises, name, "fs.promises.", "promise", leading(2));
  wrap(cjs_fs.promises, "glob", "fs.promises.", "iterator", glob_check);
  wrap(cjs_fs.promises, "watch", "fs.promises.", "iterator", leading(1));
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

type Mode = "sync" | "promise" | "iterator";
type Check = (args: unknown[], fn: string) => void;

/** What an iterator-returning API (`promises.glob` · `promises.watch`) gives back when the call was refused: an iterator that throws at the first step. */
function refused_iterator(error: unknown): AsyncGenerator<never> {
  return (async function* (): AsyncGenerator<never> {
    throw error;
  })();
}

/**
 * Call once at the top level of a test file: compares the real home before / after the file's tests, and denies every look at the real home (layer 4).
 * `real_home` (a folder or several) replaces the default real homes — for the guard's own tests with a fake home; nothing real is looked at then.
 *
 * The guard's release + final snapshot are an `after` hook registered at the END of the file's loading (a microtask after the module body), so
 * they run after every `after` hook the file registers, whenever in its body it does so — a cleanup hook that touches the protected folders is
 * caught too. (Hooks registered after a top-level `await`, or while the tests run, can still come after it.)
 */
export function use_home_guard(real_home?: Homes): void {
  let snapshot: HomeSnapshot | undefined;
  let fs_guard: ProcessFsGuard | undefined;
  let finished = false;
  /** Release the fs guard and compare the snapshots (once); returns what failed. */
  const finish = (): Error[] => {
    if (finished) return [];
    finished = true;
    const errors: Error[] = [];
    for (const step of [() => fs_guard?.release(), () => snapshot?.check()]) {
      try {
        step();
      } catch (error) {
        errors.push(error as Error);
      }
    }
    // a failed file-level `after` hook does not change the exit code of a plain `node file.ts` run (only `node --test` counts it), so say it ourselves
    if (errors.length > 0) process.exitCode = 1;
    return errors;
  };
  before(() => {
    snapshot = take_home_snapshot(real_home);
    fs_guard = guard_process_fs(real_home);
  });
  queueMicrotask(() => {
    after(() => {
      const errors = finish();
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, errors.map((error) => error.message).join("\n"));
    });
  });
  // The runner skips the remaining `after` hooks once one has thrown (a later cleanup hook that hit the guard): then this is the last word.
  process.once("exit", () => {
    const wanted = fs_guard?.violations.slice() ?? [];
    const errors = finish();
    if (errors.length > 0) process.stderr.write(`home guard: ${errors.map((error) => error.message).join(" | ")}${wanted.length > 0 ? `\n${wanted.join("\n")}` : ""}\n`);
  });
}

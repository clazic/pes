// SEL-103 — Codex final review 2/2, the three required fixes. Every "account home" below is a FAKE (an injected string or a folder under a temp root); the real
// account home is never opened, listed or realpath'd (children get a temporary HOME and a fake os.userInfo().homedir).
//   R1  layer 4 refuses an rm / rename / cp (and a recursive readdir / opendir / watch) of a PARENT of a protected folder — the account home itself included —
//       before the call: such a call removes, moves or reads ~/.pes without the guard ever seeing that path. A plain stat / readdir of the home still works.
//   R2  layer 4 compares Windows spellings after the same namespace / administrative-share rewrite as layer 0 (`\\?\C:\…` · `\\localhost\c$\…` = `C:\…`),
//       for the protected roots and for the called path.
//   R3  the start check keeps a UNC `\\host\share` as a fixed root on Windows: `..` cannot climb over the share (Windows does not), so
//       `\\server\share\..\hong` IS `\\server\share\hong`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, opendirSync, promises as fsp, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

import { guard_process_fs, use_home_guard } from "./helpers/home_guard.ts";
import { is_account_home, real_home_problem } from "./helpers/temp_home_check.ts";

use_home_guard();

const REPO = join(import.meta.dirname, "..");
const HELPERS = join(REPO, "tests", "helpers");
const GUARD_URL = pathToFileURL(join(HELPERS, "home_guard.ts")).href;

const roots: string[] = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function populate(dir: string): void {
  for (const name of [".pes", "pes-projects", ".claude"]) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "synthetic.txt"), "inside\n");
  }
}

/** A temp root holding a FAKE account home (`acct`) and, as its sibling, the temporary HOME of a child (`home`). */
function make_fixture(): { root: string; acct: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "pes-sel103-r2-"));
  roots.push(root);
  const acct = join(root, "acct");
  const home = join(root, "temp-home");
  populate(acct);
  mkdirSync(home, { recursive: true });
  return { root, acct, home };
}

function child_env(home: string, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, PES_HOME: join(home, "pes-home"), ...extra };
  for (const key of ["SystemRoot", "TMPDIR", "TEMP", "TMP"]) if (process.env[key] !== undefined) env[key] = process.env[key] as string;
  return env;
}

// ---------------------------------------------------------------------------
// R1 · a parent of a protected folder (the account home itself)

/** A guarded test file run in a child: the DEFAULT use_home_guard(), os.userInfo().homedir = the fake account home, HOME = its sibling; the test does `action`. */
function run_default_guard(action: "rm" | "rename" | "stat"): { status: number | null; out: string; acct: string; moved: string } {
  const fx = make_fixture();
  const moved = join(fx.root, "acct-moved");
  const file = join(fx.root, `ancestor-${action}.test.mjs`);
  writeFileSync(
    file,
    `import { renameSync, rmSync, statSync } from "node:fs";
import { test } from "node:test";
import { use_home_guard } from ${JSON.stringify(GUARD_URL)};
use_home_guard();
const acct = ${JSON.stringify(fx.acct)};
test("${action} of the account home", () => {
  if (${JSON.stringify(action)} === "rm") rmSync(acct, { recursive: true, force: true });
  else if (${JSON.stringify(action)} === "rename") renameSync(acct, ${JSON.stringify(moved)});
  else statSync(acct);
});
`,
  );
  const run = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--import", join(HELPERS, "fake_account_home.ts"), "--import", join(HELPERS, "require_temp_home.ts"), "--test", file],
    { cwd: REPO, env: child_env(fx.home, { PES_FAKE_ACCOUNT_HOME: fx.acct }), encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(run.error, undefined, String(run.error));
  return { status: run.status, out: `${run.stdout}\n${run.stderr}`, acct: fx.acct, moved };
}

test("R1 default use_home_guard(): rmSync(account home, { recursive, force }) is refused before it runs — the fake account home and its .pes survive", () => {
  const run = run_default_guard("rm");
  assert.notEqual(run.status, 0, run.out);
  assert.match(run.out, /PESHomeAccessViolation: fs\.rmSync/);
  assert.ok(existsSync(join(run.acct, ".pes", "synthetic.txt")), "the account home's .pes is still there");
});

test("R1 default use_home_guard(): renameSync(account home, sibling) is refused before it runs — nothing is moved", () => {
  const run = run_default_guard("rename");
  assert.notEqual(run.status, 0, run.out);
  assert.match(run.out, /PESHomeAccessViolation: fs\.renameSync/);
  assert.ok(existsSync(join(run.acct, ".pes", "synthetic.txt")), "the account home is where it was");
  assert.equal(existsSync(run.moved), false, "no moved copy");
});

test("R1 control: a plain statSync of the account home itself is still allowed (only whole-tree calls get the parent check)", () => {
  const run = run_default_guard("stat");
  assert.equal(run.status, 0, run.out);
});

test("R1 in process (fake home): rm · rmdir · rename · cp of the home or a parent, and a recursive readdir / opendir of it, are refused in every API; plain calls still work", async () => {
  const fx = make_fixture();
  const guard = guard_process_fs(fx.acct);
  const other = join(fx.root, "other");
  try {
    const refused: Array<[string, () => unknown]> = [
      ["rmSync home", () => rmSync(fx.acct, { recursive: true, force: true })],
      ["rmSync parent", () => rmSync(fx.root, { recursive: true, force: true })],
      ["renameSync home (source)", () => renameSync(fx.acct, other)],
      ["renameSync onto the home (destination)", () => renameSync(fx.home, fx.acct)],
      ["cpSync home (source)", () => cpSync(fx.acct, other, { recursive: true })],
      ["cpSync onto the home (destination)", () => cpSync(fx.home, fx.acct, { recursive: true })],
      ["readdirSync recursive", () => readdirSync(fx.acct, { recursive: true })],
      ["readdirSync recursive (parent)", () => readdirSync(fx.root, { recursive: true })],
      ["rmdirSync home", () => rmdirSync(fx.acct)],
      ["opendirSync recursive", () => opendirSync(fx.acct, { recursive: true })],
    ];
    for (const [what, run] of refused) assert.throws(run, /PESHomeAccessViolation/, what);
    await assert.rejects(fsp.rm(fx.acct, { recursive: true, force: true }), /PESHomeAccessViolation/, "promises.rm");
    await assert.rejects(fsp.rename(fx.acct, other), /PESHomeAccessViolation/, "promises.rename");
    await assert.rejects(fsp.cp(fx.acct, other, { recursive: true }), /PESHomeAccessViolation/, "promises.cp");
    await assert.rejects(fsp.readdir(fx.acct, { recursive: true }), /PESHomeAccessViolation/, "promises.readdir recursive");
    assert.ok(guard.violations.length >= refused.length + 4, `every refusal is recorded (${guard.violations.length})`);
    // what is not a whole-tree call on a parent keeps working
    assert.ok(statSync(fx.acct).isDirectory(), "statSync of the home");
    assert.ok(readdirSync(fx.acct).includes(".pes"), "a plain (non-recursive) readdir of the home lists names only");
  } catch (error) {
    try {
      guard.release();
    } catch {
      // the refusals above were recorded on purpose
    }
    throw error;
  }
  try {
    guard.release();
  } catch {
    // the refusals above were recorded on purpose
  }
  assert.ok(existsSync(join(fx.acct, ".pes", "synthetic.txt")), "nothing was removed");
  assert.equal(existsSync(other), false, "nothing was copied or moved");
  // a sibling of the home is no parent: removing / renaming it is allowed
  const sibling_guard = guard_process_fs(fx.acct);
  try {
    mkdirSync(join(fx.root, "sib"));
    renameSync(join(fx.root, "sib"), join(fx.root, "sib2"));
    rmSync(join(fx.root, "sib2"), { recursive: true, force: true });
    rmSync(fx.home, { recursive: true, force: true });
  } finally {
    assert.doesNotThrow(() => sibling_guard.release());
  }
});

// ---------------------------------------------------------------------------
// R2 · layer 4 on Windows spellings (the real helper sources, node:path = win32, a recording fake fs — see helpers/win32_guard_probe.ts)

function win32_probe(account: string, paths: readonly string[]): { results: Array<{ path: string; outcome: string; violations: number }>; reached: string[] } {
  const fx = make_fixture();
  const run = spawnSync(
    process.execPath,
    ["--experimental-vm-modules", "--disable-warning=ExperimentalWarning", join(HELPERS, "win32_guard_probe.ts")],
    {
      cwd: REPO,
      env: child_env(fx.home, { PROBE_ACCOUNT: account, PROBE_HOME: "D:\\Temp\\pes-test-home", PROBE_PATHS: JSON.stringify(paths) }),
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  assert.equal(run.error, undefined, String(run.error));
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  return JSON.parse(run.stdout.trim().split("\n").pop() as string);
}

const WIN_FILE = "C:\\Users\\hong\\.pes\\synthetic.txt";
const WIN_SPELLINGS = [WIN_FILE, win32.toNamespacedPath(WIN_FILE), "\\\\localhost\\c$\\Users\\hong\\.pes\\synthetic.txt", "\\\\?\\UNC\\localhost\\C$\\Users\\hong\\pes-projects\\p"];

test("R2 layer 4 (win32): a fake account home's file is refused in its plain, \\\\?\\ (toNamespacedPath) and \\\\localhost\\c$ spellings — the fake fs is never reached", () => {
  const seen = win32_probe("C:\\Users\\hong", WIN_SPELLINGS);
  for (const result of seen.results) assert.deepEqual({ outcome: result.outcome, violations: result.violations }, { outcome: "refused", violations: 1 }, result.path);
  assert.deepEqual(seen.reached, [], "the underlying fs is never called");
});

test("R2 layer 4 (win32): the protected ROOT is normalised too — an account home spelled \\\\?\\C:\\… or \\\\localhost\\c$\\… protects the plain spellings", () => {
  for (const account of [win32.toNamespacedPath("C:\\Users\\hong"), "\\\\localhost\\c$\\Users\\hong"]) {
    const seen = win32_probe(account, WIN_SPELLINGS);
    for (const result of seen.results) assert.equal(result.outcome, "refused", `${account} · ${result.path}`);
    assert.deepEqual(seen.reached, [], account);
  }
});

test("R2 control (win32): other drives, look-alike names and ordinary shares still reach the fs", () => {
  const ok = ["D:\\Users\\hong\\.pes\\x", "C:\\Users\\hong\\.pesx\\x", "\\\\?\\C:\\Users\\hong\\AppData\\x", "\\\\fileserver\\share\\Users\\hong\\.pes\\x", "C:\\Users\\hong"];
  const seen = win32_probe("C:\\Users\\hong", ok);
  for (const result of seen.results) assert.equal(result.outcome, "reached", result.path);
  assert.equal(seen.reached.length, ok.length);
});

// ---------------------------------------------------------------------------
// R3 · a UNC share root is fixed: `..` does not climb over it

const UNC_ACCT = ["\\\\server\\share\\hong"];

test("R3 a UNC spelling that climbs over the share root with .. is the account home on Windows — refused, and is_account_home agrees", () => {
  for (const bad of ["\\\\server\\share\\..\\hong", "\\\\server\\share\\..\\..\\hong", "\\\\server\\share\\x\\..\\..\\hong", "//server/share/../hong", "\\\\?\\UNC\\server\\share\\..\\hong"]) {
    assert.equal(win32.normalize(bad.replace(/^\\\\\?\\UNC\\/, "\\\\")).toLowerCase(), "\\\\server\\share\\hong", `Windows itself reads ${bad} as the account home`);
    assert.match(String(real_home_problem({ USERPROFILE: bad }, UNC_ACCT, "win32")), /USERPROFILE/, bad);
    assert.equal(is_account_home(bad, UNC_ACCT, "win32"), true, bad);
  }
  for (const bad of ["\\\\server\\share\\..\\hong\\.pes", "\\\\server\\share\\..\\hong\\pes-projects\\p", "\\\\server\\share\\..\\..\\hong\\.claude"]) {
    assert.match(String(real_home_problem({ USERPROFILE: bad }, UNC_ACCT, "win32")), /USERPROFILE/, bad);
  }
});

test("R3 control: an ordinary UNC temp folder is accepted, a UNC path without a share is refused, POSIX keeps reading // as /", () => {
  for (const ok of ["\\\\server\\share\\tmp\\pes-test-home", "\\\\server\\share\\hong-tmp", "\\\\server\\other\\hong", "\\\\fileserver\\share\\pes-test-home"]) {
    assert.equal(real_home_problem({ USERPROFILE: ok }, UNC_ACCT, "win32"), undefined, ok);
    assert.equal(is_account_home(ok, UNC_ACCT, "win32"), false, ok);
  }
  assert.match(String(real_home_problem({ USERPROFILE: "\\\\server" }, UNC_ACCT, "win32")), /USERPROFILE/, "no share");
  // on POSIX `//tmp/x/../../srv/acct/hong` is /srv/acct/hong — the .. may climb (no share root there)
  assert.match(String(real_home_problem({ HOME: "//tmp/x/../../srv/acct/hong" }, ["/srv/acct/hong"], "linux")), /HOME/);
});

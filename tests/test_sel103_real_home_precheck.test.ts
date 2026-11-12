// SEL-103 — a run that STARTS in the real account home must fail before the home guard looks at anything (the incident this stops: a test run with
// the real HOME let the guard's own snapshot / lstat walk the real ~/.pes · ~/pes-projects · ~/.claude).
//
// The check (tests/helpers/temp_home_check.ts) is a comparison of strings: HOME / USERPROFILE against os.userInfo().homedir (HOME ignored), against the
// usual account-home shapes (/Users/x · /home/x · C:\Users\x) and against anything injected through PES_TEST_ACCOUNT_HOME. It sits in two places:
//   * tests/helpers/require_temp_home.ts — the `--import` entry of `npm test` (package.json) and of the CI test step: every test-file process runs it first;
//   * the first import of tests/helpers/home_guard.ts — so a test file started by hand (`node --test file.ts`, no --import) is covered as well.
//
// What is tested:
//   A  the judgement function with an INJECTED "real home" (nothing real is looked at, nothing is created);
//   B  a child `node --test` whose HOME is a fake "account home" (a temp folder holding .pes · pes-projects · .claude): it must exit non-zero with the
//      "임시 HOME" message and a recorder (tests/helpers/fs_path_recorder.ts, loaded before the entry) must see ZERO fs calls on that folder; a control
//      run of the same probe WITHOUT the injection shows the recorder and the probe do see the lstat / readdir calls (so "0" means something);
//   C  package.json and the CI test step really go through the entry.
// The real account home is never opened: the probe is given the fake home explicitly (use_home_guard(<fake>)), so os.userInfo().homedir is only compared.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { after, test } from "node:test";

import { assert_temp_home_env, default_account_homes, real_home_problem } from "./helpers/temp_home_check.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { import_url } from "./helpers/import_url.ts";

use_home_guard();

const REPO = join(import.meta.dirname, "..");
const ENTRY = join(REPO, "tests", "helpers", "require_temp_home.ts");
const RECORDER = join(REPO, "tests", "helpers", "fs_path_recorder.ts");
const PROBE = join(REPO, "tests", "helpers", "precheck_probe.ts");

// ---------------------------------------------------------------------------
// A · the judgement, with an injected account home that does not exist

const ACCT = ["/srv/acct/hong"]; // not account-shaped, never opened — only the injected value makes it "real"
const TEMP_HOME = join(tmpdir(), "pes-precheck-a-home");
const posix = (env: Record<string, string | undefined>, homes: readonly string[] = ACCT): string | undefined => real_home_problem(env, homes, "linux");
const win = (env: Record<string, string | undefined>, homes: readonly string[] = ACCT): string | undefined => real_home_problem(env, homes, "win32");

test("A1 HOME equal to the (injected) account home is refused, whatever the spelling", () => {
  for (const spelling of ["/srv/acct/hong", "/srv/acct/hong/", "/srv/acct/./hong", "/srv/acct/x/../hong", "/srv/acct//hong"]) {
    assert.match(String(posix({ HOME: spelling })), /HOME/, spelling);
  }
  if (process.platform === "darwin" || process.platform === "win32") assert.match(String(real_home_problem({ HOME: "/SRV/Acct/Hong" }, ACCT)), /HOME/, "case-insensitive file systems");
});

test("A2 an empty or missing HOME is refused (Node would fall back to the passwd entry — the real home)", () => {
  assert.match(String(posix({})), /HOME/);
  assert.match(String(posix({ HOME: "" })), /HOME/);
  assert.match(String(win({ HOME: TEMP_HOME })), /USERPROFILE/, "on Windows os.homedir() follows USERPROFILE: HOME alone is not enough");
  assert.equal(posix({ HOME: TEMP_HOME }), undefined, "USERPROFILE is normally absent on macOS / Linux");
  assert.equal(win({ USERPROFILE: TEMP_HOME }), undefined);
});

test("A3 each of HOME and USERPROFILE is judged when set — a real USERPROFILE next to a temporary HOME is refused", () => {
  assert.match(String(posix({ HOME: TEMP_HOME, USERPROFILE: "/srv/acct/hong" })), /USERPROFILE/);
  assert.match(String(win({ HOME: "/srv/acct/hong", USERPROFILE: TEMP_HOME })), /HOME/);
  assert.equal(posix({ HOME: TEMP_HOME, USERPROFILE: TEMP_HOME }), undefined);
});

test("A4 the usual account-home shapes are refused without any injection: /Users/x · /home/x · /root · C:\\Users\\x", () => {
  for (const shape of ["/Users/alice", "/Users/alice/", "/home/bob", "/root", "C:\\Users\\carol", "c:/users/carol/", "D:\\Users\\dave\\"]) {
    assert.match(String(posix({ HOME: shape }, [])), /HOME/, shape);
    assert.match(String(win({ USERPROFILE: shape }, [])), /USERPROFILE/, shape);
  }
  // …but a folder BELOW such a home, or a temp folder of any OS, is an ordinary temporary folder
  for (const ok of ["/Users/alice/scratch/h", "/home/bob/.cache/h", "/var/folders/ab/xyz/T/pes-h", "/tmp/pes-h", "C:\\Users\\carol\\AppData\\Local\\Temp\\pes-h", "D:\\a\\_temp\\pes-test-home"]) {
    assert.equal(posix({ HOME: ok }, []), undefined, ok);
  }
  assert.equal(posix({ HOME: TEMP_HOME }), undefined);
});

test("A5 a parent of the account home, and the protected folders inside it, are refused; their look-alikes are not", () => {
  for (const bad of ["/", "/srv", "/srv/acct", "/srv/acct/hong/.pes", "/srv/acct/hong/.pes/work", "/srv/acct/hong/pes-projects", "/srv/acct/hong/.claude/x"]) {
    assert.match(String(posix({ HOME: bad })), /HOME/, bad);
  }
  for (const ok of ["/srv/acct/hong/.pesx", "/srv/acct/hong/pes-projects2", "/srv/acct/hong/work/h", "/srv/acct/other"]) {
    assert.equal(posix({ HOME: ok }), undefined, ok);
  }
});

test("A6 a relative HOME is refused", () => {
  assert.match(String(posix({ HOME: "tmp/h" })), /HOME/);
});

test("A7 assert_temp_home_env throws the 임시 HOME message; the default account homes hold os.userInfo().homedir and PES_TEST_ACCOUNT_HOME (additions only)", () => {
  assert.throws(() => assert_temp_home_env({ HOME: "/srv/acct/hong" }, ACCT), /임시 HOME/);
  // both keys: on Windows os.homedir() follows USERPROFILE, so an empty USERPROFILE is refused (A2) — CI windows-latest (SEL-125)
  assert.doesNotThrow(() => assert_temp_home_env({ HOME: TEMP_HOME, USERPROFILE: TEMP_HOME }, ACCT));
  const homes = default_account_homes({ PES_TEST_ACCOUNT_HOME: ["/x/one", "/x/two"].join(delimiter) });
  assert.ok(homes.includes("/x/one") && homes.includes("/x/two"), "injected homes are added");
  assert.deepEqual(default_account_homes({}).filter((home) => home === "/x/one"), [], "nothing is injected by default");
});

// ---------------------------------------------------------------------------
// B · a child node --test that starts in a (fake) account home

const roots: string[] = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  readonly acct: string;
  readonly log: string;
}

function make_fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pes-precheck-"));
  roots.push(root);
  const acct = join(root, "acct");
  mkdirSync(join(acct, ".pes"), { recursive: true });
  writeFileSync(join(acct, ".pes", "config.json"), "{}\n");
  mkdirSync(join(acct, "pes-projects", "p1"), { recursive: true });
  writeFileSync(join(acct, "pes-projects", "p1", "state.txt"), "x\n");
  mkdirSync(join(acct, ".claude"), { recursive: true });
  const log = join(root, "fs-calls.log"); // outside the watched folder
  return { acct, log };
}

function run_child(fx: Fixture, options: { entry: boolean; inject: boolean }): { status: number | null; out: string; calls: string[] } {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: fx.acct,
    USERPROFILE: fx.acct,
    PES_FS_LOG: fx.log,
    PES_FS_WATCH: fx.acct,
    PES_PROBE_HOMES: fx.acct,
  };
  for (const key of ["SystemRoot", "TMPDIR", "TEMP", "TMP"]) if (process.env[key] !== undefined) env[key] = process.env[key] as string;
  if (options.inject) env.PES_TEST_ACCOUNT_HOME = fx.acct;
  const argv = ["--disable-warning=ExperimentalWarning", "--import", import_url(RECORDER), ...(options.entry ? ["--import", import_url(ENTRY)] : []), "--test", PROBE];
  const run = spawnSync(process.execPath, argv, { cwd: REPO, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.error, undefined, `the child started (${String(run.error)})`);
  const calls = existsSync(fx.log) ? readFileSync(fx.log, "utf8").split("\n").filter((line) => line !== "") : [];
  return { status: run.status, out: `${run.stdout}\n${run.stderr}`, calls };
}

test("B1 the --import entry: a start in the account home exits non-zero with the 임시 HOME message, the probe never runs, and the home gets ZERO fs calls", () => {
  const fx = make_fixture();
  const run = run_child(fx, { entry: true, inject: true });
  assert.notEqual(run.status, 0, run.out);
  assert.match(run.out, /임시 HOME/);
  assert.doesNotMatch(run.out, /PROBE-RAN/, "no test ran");
  assert.deepEqual(run.calls, [], "not one fs call (lstat · readdir · …) on the account home");
});

test("B2 without --import (a test file started by hand): the first import of home_guard.ts refuses just as early — zero fs calls", () => {
  const fx = make_fixture();
  const run = run_child(fx, { entry: false, inject: true });
  assert.notEqual(run.status, 0, run.out);
  assert.match(run.out, /임시 HOME/);
  assert.doesNotMatch(run.out, /PROBE-RAN/);
  assert.deepEqual(run.calls, []);
});

test("B3 control — the same probe in a home that is NOT the account home runs, and the recorder sees the guard's lstat / readdir of .pes and pes-projects", () => {
  const fx = make_fixture();
  const run = run_child(fx, { entry: true, inject: false });
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /PROBE-RAN/);
  const seen = run.calls.filter((line) => /^(lstatSync|readdirSync) /.test(line));
  assert.ok(seen.some((line) => line.endsWith(`${sep}.pes`)), `an lstat of .pes is recorded:\n${run.calls.join("\n")}`);
  assert.ok(seen.some((line) => line.endsWith(`${sep}pes-projects`)), "an lstat of pes-projects is recorded");
});

// ---------------------------------------------------------------------------
// C · the entry points

test("C1 npm test goes through the entry: package.json's test script is the runner (SEL-106), which passes --import ./tests/helpers/require_temp_home.ts", async () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.test, "node scripts/run_tests.ts");
  const { build_node_args } = await import("../scripts/run_tests.ts");
  const args: string[] = build_node_args({}, [], 4);
  assert.deepEqual(args.slice(0, 2), ["--import", "./tests/helpers/require_temp_home.ts"], "the runner's node arguments start with the entry");
  assert.ok(existsSync(ENTRY));
});

test("C2 the CI test step (typescript job) runs with a temporary HOME and the same entry", () => {
  const ci = readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8");
  const start = ci.indexOf("Run tests (shard");
  assert.ok(start > 0, "the test step");
  const step = ci.slice(start, ci.indexOf("\n  browser:", start));
  assert.match(step, /require_temp_home\.ts/, "the CI command carries the entry");
  assert.match(step, /HOME:/, "HOME is set for the step");
  assert.match(step, /USERPROFILE:/, "USERPROFILE is set for the step");
});

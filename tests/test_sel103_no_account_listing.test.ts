// SEL-103 (decision "no listing of the real account home") — the home guard's layer 2 and the Playwright globalSetup list names / sizes / mtimes of
// <home>/.pes and <home>/pes-projects. That listing (lstat · readdir) is itself a look at the folder, and the rule is: nothing looks at the REAL account home's
// .pes / pes-projects, not even to compare. So the default listing has only the temporary HOME (os.homedir(), which layer 0 guarantees is temporary) and the
// fake homes a test injects. The real account home is protected by layer 0 (a run that starts there is refused) and layer 4 (every fs call on its protected
// folders is denied) — both decided from spellings.
//
// What is tested (children only; a FAKE account home stands in for the real one — os.userInfo().homedir is patched by tests/helpers/fake_account_home.ts, so
// nothing real is opened, and tests/helpers/fs_path_recorder.ts records every fs call on the watched folders):
//   A  is_account_home(): the string judgement
//   B  use_home_guard() with the default homes: ZERO fs calls on the account home (not even a realpath of it); control — the temp HOME is listed
//   C  the Playwright globalSetup: ZERO fs calls on the account home, listing of the temp HOME only; a start in the account home is refused first
//   D  the Playwright CLI is refused before it loads a spec when HOME is the account home (config check, strings only)
//   E  ci.yml: the browser job runs `npx playwright test` with a temporary HOME
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";

import { is_account_home } from "./helpers/temp_home_check.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { import_url } from "./helpers/import_url.ts";

use_home_guard();

const REPO = join(import.meta.dirname, "..");
const FAKE_ACCOUNT = join(REPO, "tests", "helpers", "fake_account_home.ts");
const RECORDER = join(REPO, "tests", "helpers", "fs_path_recorder.ts");
const ENTRY = join(REPO, "tests", "helpers", "require_temp_home.ts");
const LISTING_PROBE = join(REPO, "tests", "helpers", "listing_probe.ts");
const SETUP_PROBE = join(REPO, "tests", "helpers", "global_setup_probe.ts");
const PLAYWRIGHT_CLI = join(REPO, "node_modules", "@playwright", "test", "cli.js");

// ---------------------------------------------------------------------------
// A · the string judgement

test("A1 is_account_home: equal to an account home in any spelling; not a child, not a parent, not a look-alike", () => {
  const homes = ["/srv/acct/hong"];
  for (const same of ["/srv/acct/hong", "/srv/acct/hong/", "/srv/acct/./hong", "/srv/acct/x/../hong", "/srv/acct//hong"]) assert.equal(is_account_home(same, homes, "linux"), true, same);
  for (const other of ["/srv/acct/hong/work", "/srv/acct", "/srv/acct/hongx", "/tmp/pes-h", "relative/hong"]) assert.equal(is_account_home(other, homes, "linux"), false, other);
  assert.equal(is_account_home("/SRV/ACCT/HONG", homes, "darwin"), true, "case-insensitive file systems");
  assert.equal(is_account_home("/SRV/ACCT/HONG", homes, "linux"), false);
  assert.equal(is_account_home("C:\\Users\\hong\\", ["c:/users/hong"], "win32"), true);
});

// ---------------------------------------------------------------------------
// fixtures

const roots: string[] = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  readonly root: string;
  /** the FAKE account home (os.userInfo().homedir in the child) — holds .pes · pes-projects · .claude */
  readonly acct: string;
  /** the temporary HOME of the child — holds a .pes and a pes-projects too, so a listing of it is visible */
  readonly home: string;
  readonly log: string;
}

function populate(dir: string): void {
  mkdirSync(join(dir, ".pes"), { recursive: true });
  writeFileSync(join(dir, ".pes", "config.json"), "{}\n");
  mkdirSync(join(dir, "pes-projects", "p1"), { recursive: true });
  writeFileSync(join(dir, "pes-projects", "p1", "state.txt"), "x\n");
  mkdirSync(join(dir, ".claude"), { recursive: true });
}

function make_fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pes-nolist-"));
  roots.push(root);
  const acct = join(root, "acct");
  const home = join(root, "temp-home");
  populate(acct);
  populate(home);
  return { root, acct, home, log: join(root, "fs-calls.log") }; // the log lies outside both watched folders
}

interface Run {
  readonly status: number | null;
  readonly out: string;
  readonly on_account: string[];
  readonly on_home: string[];
}

function child_env(fx: Fixture, home: string, watch: string[]): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    PES_FAKE_ACCOUNT_HOME: fx.acct,
    PES_FS_LOG: fx.log,
    PES_FS_WATCH: watch.join(delimiter),
  };
  for (const key of ["SystemRoot", "TMPDIR", "TEMP", "TMP"]) if (process.env[key] !== undefined) env[key] = process.env[key] as string;
  return env;
}

function calls_of(fx: Fixture, run: { status: number | null; stdout: string; stderr: string }): Run {
  const calls = existsSync(fx.log) ? readFileSync(fx.log, "utf8").split("\n").filter((line) => line !== "") : [];
  const under = (folder: string) => calls.filter((line) => line.split(" ").slice(1).join(" ").startsWith(folder));
  return { status: run.status, out: `${run.stdout}\n${run.stderr}`, on_account: under(fx.acct), on_home: under(fx.home) };
}

const PRELOAD = ["--import", import_url(FAKE_ACCOUNT), "--import", import_url(RECORDER)];

// ---------------------------------------------------------------------------
// B · use_home_guard() with the default homes

test("B1 use_home_guard() lists the temp HOME and makes ZERO fs calls on the account home (not a lstat · readdir of .pes · pes-projects, not even a realpath of the home)", () => {
  const fx = make_fixture();
  const env = child_env(fx, fx.home, [fx.acct, fx.home]);
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", ...PRELOAD, "--import", import_url(ENTRY), "--test", LISTING_PROBE], { cwd: REPO, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.error, undefined, String(run.error));
  const seen = calls_of(fx, run);
  assert.equal(seen.status, 0, seen.out);
  assert.match(seen.out, /PROBE-RAN/);
  assert.deepEqual(seen.on_account, [], "not one fs call on the account home");
  // control: the recorder and the probe do see the listing of the temporary HOME
  assert.ok(seen.on_home.some((line) => /^lstatSync .*[\\/]\.pes$/.test(line)), `an lstat of the temp HOME's .pes:\n${seen.on_home.join("\n")}`);
  assert.ok(seen.on_home.some((line) => /^lstatSync .*[\\/]pes-projects$/.test(line)), "an lstat of the temp HOME's pes-projects");
});

// ---------------------------------------------------------------------------
// C · the Playwright globalSetup

test("C1 globalSetup (HOME = a temp folder): ZERO fs calls on the account home, the temp HOME is listed, the teardown passes", () => {
  const fx = make_fixture();
  const env = child_env(fx, fx.home, [fx.acct, fx.home]);
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", ...PRELOAD, SETUP_PROBE], { cwd: REPO, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.error, undefined, String(run.error));
  const seen = calls_of(fx, run);
  assert.equal(seen.status, 0, seen.out);
  assert.match(seen.out, /SETUP-RAN/);
  assert.deepEqual(seen.on_account, [], "not one fs call on the account home");
  assert.ok(seen.on_home.some((line) => /^lstatSync .*[\\/]\.pes$/.test(line)), `the temp HOME's .pes is listed:\n${seen.on_home.join("\n")}`);
});

test("C2 globalSetup started WITH the account home as HOME is refused (임시 HOME) before it lists anything — zero fs calls on it", () => {
  const fx = make_fixture();
  const env = child_env(fx, fx.acct, [fx.acct]);
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", ...PRELOAD, SETUP_PROBE], { cwd: REPO, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.error, undefined, String(run.error));
  const seen = calls_of(fx, run);
  assert.notEqual(seen.status, 0, seen.out);
  assert.match(seen.out, /임시 HOME/);
  assert.doesNotMatch(seen.out, /SETUP-RAN/);
  assert.deepEqual(seen.on_account, [], "not one fs call on the account home");
});

// ---------------------------------------------------------------------------
// D · the Playwright CLI

test("D1 `playwright test --list` with the account home as HOME is refused at config load (임시 HOME); with a temp HOME it lists the specs", () => {
  const fx = make_fixture();
  const protected_folders = [".pes", "pes-projects", ".claude"].map((name) => join(fx.acct, name));
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", ...PRELOAD, PLAYWRIGHT_CLI, "test", "--list"], {
    cwd: REPO,
    env: { ...child_env(fx, fx.acct, protected_folders), NODE_OPTIONS: `--import ${JSON.stringify(import_url(FAKE_ACCOUNT))}` },
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(run.error, undefined, String(run.error));
  const refused = calls_of(fx, run);
  assert.notEqual(refused.status, 0, refused.out);
  assert.match(refused.out, /임시 HOME/);
  assert.deepEqual(refused.on_account, [], "not one fs call on the account home's protected folders");

  const ok = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", PLAYWRIGHT_CLI, "test", "--list"], {
    cwd: REPO,
    env: { ...child_env(fx, fx.home, []), NODE_OPTIONS: `--import ${JSON.stringify(import_url(FAKE_ACCOUNT))}` },
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
  assert.match(ok.stdout, /workspace_smoke\.spec\.ts/);
});

// ---------------------------------------------------------------------------
// E · CI

test("E1 the CI browser job runs `npx playwright test` with a temporary HOME / USERPROFILE (the config refuses the runner's real home)", () => {
  const ci = readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8");
  const start = ci.indexOf("Run browser smoke");
  assert.ok(start > 0, "the browser smoke step");
  const step = ci.slice(start, ci.indexOf("\n  # ", start) > 0 ? ci.indexOf("\n  # ", start) : undefined);
  assert.match(step, /HOME:/, "HOME is set for the step");
  assert.match(step, /USERPROFILE:/, "USERPROFILE is set for the step");
  // job 수준 env 에서는 runner 컨텍스트를 쓸 수 없다(쓰면 ci.yml 전체가 무효) — 단계에서 GITHUB_ENV 로 넘긴다.
  const before = ci.slice(ci.indexOf("  browser:"), start);
  assert.match(before, /PLAYWRIGHT_BROWSERS_PATH=\$RUNNER_TEMP\/pw-browsers" >> "\$GITHUB_ENV"/, "browsers are installed and found outside HOME");
  assert.doesNotMatch(ci, /^ {4}env:\r?\n(?: {6}.*\r?\n)*? {6}\w+: \$\{\{ runner\./m, "no runner context in a job-level env");
});

// SEL-122 — the app's Vitest and Playwright runs refuse a start in the real account home, before anything is listed or opened (the same judgement as the
// root runs: tests/helpers/temp_home_check.ts, strings only). The app's guard files import nothing but that helper, so this test needs no app/node_modules.
//
// What is tested:
//   A  a child process that starts an app guard (app/vitest.global-setup.ts · app/e2e/global-setup.ts) with HOME = a FAKE account home (injected through
//      PES_TEST_ACCOUNT_HOME) exits non-zero with the 임시 HOME message, the probe never runs, and the recorder sees ZERO fs calls on that home;
//      a control run with a temporary HOME passes (PROBE-RAN) — so "0 calls" means something;
//   B  the wiring: the vitest config, the playwright config (first import, first call before anything else makes a folder) and the CI app job.
// The real account home is never opened: the fake home is only compared as a string.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const REPO = join(import.meta.dirname, "..");
const RECORDER = join(REPO, "tests", "helpers", "fs_path_recorder.ts");
const PROBE = join(REPO, "tests", "helpers", "app_guard_probe.ts");
const VITEST_GUARD = join(REPO, "app", "vitest.global-setup.ts");
const E2E_GUARD = join(REPO, "app", "e2e", "global-setup.ts");

const roots: string[] = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function fake_account_home(): { acct: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), "pes-sel122-"));
  roots.push(root);
  const acct = join(root, "acct");
  mkdirSync(join(acct, ".pes"), { recursive: true });
  mkdirSync(join(acct, "pes-projects", "p1"), { recursive: true });
  writeFileSync(join(acct, "pes-projects", "p1", "state.txt"), "x\n");
  mkdirSync(join(acct, ".claude"), { recursive: true });
  return { acct, log: join(root, "fs-calls.log") }; // the log stays outside the watched home
}

function run_guard(guard: string, home: string, log: string, inject: boolean): { status: number | null; out: string; calls: string[] } {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    PES_FS_LOG: log,
    PES_FS_WATCH: home,
    PES_APP_GUARD_FILE: guard,
  };
  for (const key of ["SystemRoot", "TMPDIR", "TEMP", "TMP"]) if (process.env[key] !== undefined) env[key] = process.env[key] as string;
  if (inject) env.PES_TEST_ACCOUNT_HOME = home;
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", RECORDER, PROBE], { cwd: REPO, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.error, undefined, `the child started (${String(run.error)})`);
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line !== "") : [];
  return { status: run.status, out: `${run.stdout}\n${run.stderr}`, calls };
}

for (const [name, guard] of [
  ["app Vitest (vitest.global-setup.ts)", VITEST_GUARD],
  ["app Playwright (e2e/global-setup.ts)", E2E_GUARD],
] as const) {
  test(`A1 ${name}: a start in the (fake) account home is refused with the 임시 HOME message before anything is listed — zero fs calls`, () => {
    const fx = fake_account_home();
    const run = run_guard(guard, fx.acct, fx.log, true);
    assert.notEqual(run.status, 0, run.out);
    assert.match(run.out, /임시 HOME/);
    assert.doesNotMatch(run.out, /PROBE-RAN/, "the guard did not pass");
    assert.deepEqual(run.calls, [], `not one fs call on the account home:\n${run.calls.join("\n")}`);
  });

  test(`A2 ${name}: control — the same guard in a temporary HOME passes (PROBE-RAN)`, () => {
    const fx = fake_account_home();
    const temp_home = mkdtempSync(join(tmpdir(), "pes-sel122-temp-"));
    roots.push(temp_home);
    const run = run_guard(guard, temp_home, fx.log, false);
    assert.equal(run.status, 0, run.out);
    assert.match(run.out, /PROBE-RAN/);
  });
}

test("B1 the app's Vitest config runs the start guard as globalSetup (before any test file)", () => {
  const cfg = readFileSync(join(REPO, "app", "vitest.config.ts"), "utf8");
  assert.match(cfg, /globalSetup:\s*\["\.\/vitest\.global-setup\.ts"\]/);
  assert.ok(existsSync(VITEST_GUARD));
});

test("B2 the app's Playwright config: the helper is its first import and the first call comes before any folder is made or port picked", () => {
  const cfg = readFileSync(join(REPO, "app", "playwright.config.ts"), "utf8");
  const imports = [...cfg.matchAll(/^import .*$/gm)].map((m) => m[0]);
  assert.match(imports[0] ?? "", /temp_home_check\.ts/, "the guard is the first import");
  const call = cfg.indexOf("assert_temp_home_env();");
  assert.ok(call > 0, "the guard is called");
  assert.ok(call < cfg.indexOf("mkdtempSync(join("), "the call comes before the temporary folder is made");
  assert.ok(call < cfg.indexOf("pickFreePort()"), "the call comes before the free port is picked");
  assert.match(cfg, /globalSetup:\s*"\.\/e2e\/global-setup\.ts"/);
  assert.ok(existsSync(E2E_GUARD));
});

test("B3 the CI app job runs its test steps with a temporary HOME and USERPROFILE, and keeps the browsers outside HOME", () => {
  const ci = readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8");
  const start = ci.indexOf("\n  app:\n");
  assert.ok(start > 0, "the app job");
  const job = ci.slice(start, ci.indexOf("\n  install-", start) > 0 ? ci.indexOf("\n  install-", start) : undefined);
  // the browser cache is outside HOME — set in a step through GITHUB_ENV (a job-level env may not use the runner context: the whole workflow file would be invalid)
  assert.match(job, /PLAYWRIGHT_BROWSERS_PATH=\$RUNNER_TEMP\/pw-browsers" >> "\$GITHUB_ENV"/, "the browser cache is outside HOME");
  const job_env = /\n {4}env:\n((?: {6}.*\n)+)/.exec(job.slice(0, job.indexOf("\n    steps:")))?.[1] ?? "";
  assert.doesNotMatch(job_env, /runner\./, "no runner context in the app job's job-level env");
  const unit = job.slice(job.indexOf("Unit tests (Vitest)"), job.indexOf("Browser tests (Playwright)"));
  const browser = job.slice(job.indexOf("Browser tests (Playwright)"));
  for (const step of [unit, browser]) {
    assert.match(step, /HOME: \$\{\{ runner\.temp \}\}\/pes-test-home/, "HOME is the temporary folder");
    assert.match(step, /USERPROFILE: \$\{\{ runner\.temp \}\}\/pes-test-home/, "USERPROFILE is the temporary folder");
  }
});

test("C1 the app's real Vitest CLI refuses a start in the (fake) account home before it globs or loads any test file — zero fs calls under its pes-projects", (t) => {
  // The review (SEL-122 final 1/2) reproduced the gap: the guard ran as globalSetup, after Vitest had already read <home>/pes-projects/src (a readdir).
  // Here the real runner gets HOME · USERPROFILE · PES_TEST_ACCOUNT_HOME = the fake home and --dir = its pes-projects; a probe spec there throws if loaded.
  // The recorder watches only pes-projects: Vitest writes its own token under HOME/Library at start, which is not what this test is about.
  const app = join(REPO, "app");
  const vitest_bin = join(app, "node_modules", "vitest", "vitest.mjs");
  if (!existsSync(vitest_bin)) {
    // The root CI jobs install only the root deps; the app CI job sets PES_REQUIRE_APP_DEPS=1 and runs this test there.
    const reason = "app/node_modules/vitest is missing (root-only install) — run with cd app && npm ci, or in the app CI job";
    if (process.env.PES_REQUIRE_APP_DEPS === "1") assert.fail(`PES_REQUIRE_APP_DEPS=1 but ${reason}`);
    t.skip(reason);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "pes-sel122-cli-"));
  roots.push(root);
  const acct = join(root, "acct");
  const projects = join(acct, "pes-projects");
  mkdirSync(join(projects, "src"), { recursive: true });
  writeFileSync(join(projects, "src", "probe.test.ts"), 'throw new Error("SPEC-SHOULD-NOT-LOAD");\n');
  const log = join(root, "fs-calls.log"); // outside the watched folder
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: acct,
    USERPROFILE: acct,
    PES_TEST_ACCOUNT_HOME: acct,
    PES_FS_LOG: log,
    PES_FS_WATCH: projects,
  };
  for (const key of ["SystemRoot", "TMPDIR", "TEMP", "TMP"]) if (process.env[key] !== undefined) env[key] = process.env[key] as string;
  const run = spawnSync(process.execPath, ["--import", RECORDER, vitest_bin, "run", "--dir", projects], {
    cwd: app,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(run.error, undefined, `the child started (${String(run.error)})`);
  const out = `${run.stdout}\n${run.stderr}`;
  assert.notEqual(run.status, 0, out);
  assert.match(out, /임시 HOME/, out);
  assert.doesNotMatch(out, /SPEC-SHOULD-NOT-LOAD/, "the probe spec was not loaded");
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line !== "") : [];
  assert.deepEqual(calls, [], `not one fs call under the account's pes-projects:\n${calls.join("\n")}`);
});

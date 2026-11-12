// SEL-106 — `npm test` goes through scripts/run_tests.ts, which caps node --test's concurrency (PES_TEST_CONCURRENCY, default max(2, cores/2)).
// Only the ARGUMENTS the runner builds are tested (value, entry, target, extra args) — the full suite is never started here.
//   A  default value and PES_TEST_CONCURRENCY parsing (pure functions)
//   B  the argument list: --import entry kept, concurrency flag, extra args before the glob (node ignores options after it), own --test-concurrency wins
//   C  the real script refuses a bad value with exit 2 before any node --test starts (and says why)
//   D  package.json / README / CI wiring: npm test uses the runner, CI keeps its direct --test-shard call
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { use_home_guard } from "./helpers/home_guard.ts";
import { isolated_home } from "./helpers/isolated_home.ts";
import { IMPORT_ENTRY, TEST_GLOB, build_node_args, default_concurrency, parse_concurrency } from "../scripts/run_tests.ts";

use_home_guard();

const REPO = join(import.meta.dirname, "..");
const home = isolated_home("pes-sel106-");
after(() => home.cleanup());

test("A1 default = half the cores, at least 2", () => {
  assert.equal(default_concurrency(1), 2);
  assert.equal(default_concurrency(2), 2);
  assert.equal(default_concurrency(3), 2);
  assert.equal(default_concurrency(4), 2);
  assert.equal(default_concurrency(5), 2);
  assert.equal(default_concurrency(6), 3);
  assert.equal(default_concurrency(10), 5);
  assert.equal(default_concurrency(64), 32);
});

test("A2 PES_TEST_CONCURRENCY: unset or empty → default, a positive integer → that number", () => {
  assert.equal(parse_concurrency(undefined, 10), 5);
  assert.equal(parse_concurrency("", 10), 5);
  assert.equal(parse_concurrency("1", 10), 1, "1 is allowed when asked for explicitly (only the default has the floor of 2)");
  assert.equal(parse_concurrency("3", 10), 3);
  assert.equal(parse_concurrency("32", 4), 32, "more than the cores is the caller's choice");
});

test("A3 bad values are refused with the variable name in the message", () => {
  for (const bad of ["0", "-1", "1.5", "2x", "x", " 2", "2 ", "+2", "0x10", "1e3", "007", "NaN", "Infinity", "99999999999999999999"]) {
    assert.throws(() => parse_concurrency(bad, 10), /PES_TEST_CONCURRENCY/, JSON.stringify(bad));
  }
});

test("B1 arguments: --import entry, --test, concurrency, then the glob — nothing else", () => {
  assert.deepEqual(build_node_args({}, [], 10), ["--import", "./tests/helpers/require_temp_home.ts", "--test", "--test-concurrency=5", "tests/**/*.test.ts"]);
  assert.equal(IMPORT_ENTRY, "./tests/helpers/require_temp_home.ts");
  assert.equal(TEST_GLOB, "tests/**/*.test.ts");
});

test("B2 PES_TEST_CONCURRENCY reaches --test-concurrency", () => {
  assert.ok(build_node_args({ PES_TEST_CONCURRENCY: "3" }, [], 10).includes("--test-concurrency=3"));
  assert.ok(build_node_args({ PES_TEST_CONCURRENCY: "" }, [], 8).includes("--test-concurrency=4"));
  assert.ok(build_node_args({}, [], 2).includes("--test-concurrency=2"));
  assert.throws(() => build_node_args({ PES_TEST_CONCURRENCY: "0" }, [], 10), /PES_TEST_CONCURRENCY/);
});

test("B3 extra args (npm test -- …) stay, before the glob, in order", () => {
  const args = build_node_args({}, ["--test-shard=1/8", "tests/test_x.test.ts"], 10);
  assert.deepEqual(args.slice(-3), ["--test-shard=1/8", "tests/test_x.test.ts", "tests/**/*.test.ts"]);
  const pattern = build_node_args({}, ["--test-name-pattern", "W0"], 10);
  assert.deepEqual(pattern.slice(-3), ["--test-name-pattern", "W0", "tests/**/*.test.ts"], "an option and its separate value keep their order");
  assert.equal(args[args.length - 1], TEST_GLOB, "the glob is always last — node ignores options after it");
});

test("B4 an own --test-concurrency in the extra args wins; none is added (and a bad env value is then not read)", () => {
  for (const own of [["--test-concurrency=7"], ["--test-concurrency", "7"]]) {
    const args = build_node_args({ PES_TEST_CONCURRENCY: "bad" }, own, 10);
    assert.deepEqual(args.filter((a) => a.startsWith("--test-concurrency")), [own[0]], JSON.stringify(own));
  }
});

test("C1 the script exits 2 on a bad value, before any test starts", () => {
  for (const bad of ["0", "abc", "-3"]) {
    const run = spawnSync(process.execPath, [join(REPO, "scripts", "run_tests.ts")], { env: { ...home.env, PES_TEST_CONCURRENCY: bad }, encoding: "utf8", timeout: 20000 });
    assert.equal(run.status, 2, `${bad}: ${run.stderr}`);
    assert.match(run.stderr, /PES_TEST_CONCURRENCY/);
    assert.doesNotMatch(run.stdout, /^TAP|✔|ℹ tests/m, "no test output");
  }
});

test("D1 package.json: npm test is the runner (no shell syntax), typecheck covers it", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  assert.equal(pkg.scripts.test, "node scripts/run_tests.ts");
  assert.ok(JSON.parse(readFileSync(join(REPO, "tsconfig.json"), "utf8")).include.includes("scripts/*.ts"));
});

test("D2 CI keeps calling node --test with --test-shard directly (shards and the cap do not overlap)", () => {
  const ci = readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ci, /node --test --import \.\/tests\/helpers\/require_temp_home\.ts --test-shard=\$\{\{ matrix\.shard \}\}\/8 "tests\/\*\*\/\*\.test\.ts"/);
  assert.doesNotMatch(ci, /run_tests/);
});

test("D3 tests/README.md documents PES_TEST_CONCURRENCY", () => {
  const readme = readFileSync(join(REPO, "tests", "README.md"), "utf8");
  assert.match(readme, /PES_TEST_CONCURRENCY/);
  assert.match(readme, /scripts\/run_tests\.ts/);
});

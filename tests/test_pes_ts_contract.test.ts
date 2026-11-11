// SEL-71 (PR26b): scripts/pes.ts — the 32 CLI commands as a TypeScript entry point, difference 0 against 0.15 (intended differences D01~D11 aside).
//
// This file is the contract of the issue, written before the code (it fails until scripts/pes.ts exists):
//   1. the SEL-71 completion list is pinned (a: skeleton + write commands; SEL-77 owns the reads);
//   2. the run method is pinned: `node scripts/pes.ts` (Node 26 strips types) — also bare, unguarded, with a clean stderr;
//   3. every implemented case runs on the ts target and equals the pinned 0.15 baseline (E01~E04, E10, X01~X05);
//   4. the real-home guard covers the real child: nothing of the (fake and the account's) real ~/.pes / ~/pes-projects is touched.
// The ts target always runs here, whatever PES_COMPAT_TARGET says (test_compat_cases_* keep running the py side).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { all_cases, assert_case, case_def, implemented_ids, load_contract_table, load_table, norm_out, read_baseline } from "./helpers/compat_cases.ts";
import { PES_PY, make_ctx, pes } from "./helpers/compat_env.ts";
import { PES_TS_FILE, REPO_ROOT, run_ts_bare, run_ts_cli } from "./helpers/compat_ts.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { LATER, SEL71_DONE, SEL77_DONE, sel77_on } from "./helpers/sel_scope.ts";

use_home_guard();

test("SEL-71 completion list (a: pes.ts skeleton + write commands): exactly E01~E04, E10, X01~X05 are implemented on ts; SEL-77's read cases are not_yet until SEL-77 turns them on; server / setup / doctor stay not_yet", () => {
  assert.deepEqual([...implemented_ids()].sort(), [...SEL71_DONE].sort(), "cases.json / contract.json ts.status differ from the SEL-71 completion list");
  for (const id of SEL77_DONE) assert.equal(case_def(id).ts.status, "not_yet", `${id} belongs to SEL-77 (reads / reports) — not_yet until that issue turns SEL77_DONE on`);
  assert.equal(sel77_on(), false, "SEL-77 flips all of SEL77_DONE at once; SEL-71 leaves them off");
  for (const id of LATER) assert.equal(case_def(id).ts.status, "not_yet", `${id} is not part of SEL-71`);
  assert.deepEqual(load_table().cases.filter((c) => c.kind !== "cli" && c.ts.status === "implemented"), [], "http / setup cases need serve.ts / setup.ts (a later PR)");
  assert.equal(all_cases().length, 15 + load_contract_table().cases.length);
  assert.deepEqual([...SEL71_DONE, ...SEL77_DONE, ...LATER].sort(), all_cases().map((c) => c.id).sort(), "every case has exactly one owner");
  for (const id of [...SEL71_DONE, ...SEL77_DONE]) assert.ok(existsSync(join(REPO_ROOT, "tests", "fixtures", "compat", "baseline", `${id}.json`)), `${id}: pinned 0.15 baseline`);
});

test("the run method: scripts/pes.ts exists, runs as plain `node scripts/pes.ts` (Node >= 26 strips the types) and needs no tsx / build / loader", () => {
  assert.ok(existsSync(PES_TS_FILE), "scripts/pes.ts does not exist yet — SEL-71 writes it");
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { engines?: { node?: string }; devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
  assert.equal(pkg.engines?.node, ">=26");
  const deps = Object.keys({ ...pkg.devDependencies, ...pkg.dependencies });
  for (const forbidden of ["tsx", "ts-node", "esbuild", "swc", "@swc/core", "sucrase"]) assert.ok(!deps.includes(forbidden), `${forbidden}: pes.ts must run as plain node (Node 26 strips types)`);
  const source = readFileSync(PES_TS_FILE, "utf8");
  assert.doesNotMatch(source, /^#!.*(tsx|ts-node)/m);
  // the file is the thin entry: it imports the core instead of re-implementing it (the DB commands live in scripts/pes_core)
  assert.match(source, /pes_core\//, "pes.ts is an entry point over scripts/pes_core, not a second core");
});

test("bare `node scripts/pes.ts` (no guard flags): usage page and exit 1 equal 0.15's, stderr is clean — no warning, no stack trace", () => {
  const ctx = make_ctx("pes-ts-bare-");
  try {
    const roots = ctx.roots();
    const want = read_baseline("X01").steps as any[];
    const run = (args: string[]) => run_ts_bare(ctx, args);
    const none = run([]);
    assert.equal(none.status, 1);
    assert.equal(none.stderr, "", `a user's stderr must be clean:\n${none.stderr}`);
    assert.deepEqual(norm_out(none.stdout, roots), want[0].stdout);
    const unknown = run(["foo", "bar"]);
    assert.equal(unknown.status, 1);
    assert.equal(unknown.stderr, "");
    assert.deepEqual(norm_out(unknown.stdout, roots), want[2].stdout);
    // the 0.15 page (same text, the one word of the runner aside): compare with a live py run too, so the baseline cannot drift unseen
    const py = pes(ctx);
    assert.deepEqual(norm_out(py.out, roots), want[0].stdout);
    assert.ok(PES_PY.endsWith("pes.py"));
  } finally {
    ctx.cleanup();
  }
});

test("every command name 0.15 knows (the 33 old ones; context·claim·submit·wait·complete are the DB-only five) is a command of pes.ts: with a missing project it answers a project error, never the usage page", () => {
  const source = readFileSync(PES_PY, "utf8");
  const table = /^CMDS = \{([\s\S]*?)\}\s*$/m.exec(source);
  assert.ok(table, "pes.py: CMDS moved");
  const names = [...(table[1] as string).matchAll(/"([a-z-]+)":/g)].map((m) => m[1] as string);
  assert.equal(names.length, 38, "pes.py CMDS has 38 names (32 + set + 5 DB-only); update this test with the table");
  const known = names.filter((n) => !["context", "claim", "submit", "wait", "complete"].includes(n));
  assert.equal(known.length, 33);
  assert.ok(existsSync(PES_TS_FILE), "scripts/pes.ts does not exist yet — SEL-71 writes it");
  const ctx = make_ctx("pes-ts-names-");
  try {
    const usage = read_baseline("X01").steps[0] as any;
    // SEL-71 = the write commands (+ status); the read / report commands are SEL-77's and are checked there
    const needs_project = known.filter((n) => !["list", "hub", "home", "doctor", "stop", "remote", "serve", "open", "watch", "which", "init", "pending", "digest", "show", "report", "assemble", "web"].includes(n));
    for (const name of needs_project) {
      const args = name === "ask-prep" || name === "round-start" || name === "approve" || name === "reopen" || name === "report" || name === "digest" || name === "show" || name === "qa-brief" || name === "qa" ? [name, join(ctx.tmp, "없는-프로젝트"), "plan"] : [name, join(ctx.tmp, "없는-프로젝트"), "a"];
      const run = run_ts_cli(ctx, args);
      assert.notDeepEqual(norm_out(run.stdout, ctx.roots()), usage.stdout, `${name}: pes.ts does not know this command (it printed the usage page)`);
      assert.match(`${run.stdout}${run.stderr}`, /[가-힣]/, `${name}: a Korean project error was expected, got ${JSON.stringify(run.stderr.slice(0, 120))}`);
      assert.doesNotMatch(run.stderr, /Cannot find module|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION/, `${name}: pes.ts did not start`);
    }
  } finally {
    ctx.cleanup();
  }
});

for (const id of SEL71_DONE) {
  test(`${id} on the ts target equals the 0.15 baseline${case_def(id).diffs.length > 0 ? ` (intended differences ${case_def(id).diffs.join(",")})` : ""}`, { timeout: 300_000 }, async () => {
    await assert_case("ts", id);
  });
}

test("the real child never touches the real home: a battery of commands under the guard with a fake real home and the account's real home — no violation, no hub connection counted from a project command", () => {
  assert.ok(existsSync(PES_TS_FILE), "scripts/pes.ts does not exist yet — SEL-71 writes it");
  const ctx = make_ctx("pes-ts-realhome-");
  try {
    const project = join(ctx.tmp, "guard-project");
    const calls: string[][] = [["home"], ["remote"], ["init", project, "--topic", "합성 주제"], ["round-start", project, "plan"], ["status", project], ["note", project, "메모"], ["render", project], ["stop"]];
    for (const args of calls) {
      // run_ts_cli itself fails the test on a PESHomeAccessViolation line, on a real path in stdout / stderr, and on a real-home env
      const run = run_ts_cli(ctx, args);
      assert.equal(run.status, 0, `${args.join(" ")}: ${run.stderr}`);
      assert.doesNotMatch(run.stderr, /PESHomeAccessViolation|ERR_ACCESS_DENIED/, `${args[0]}: ${run.stderr}`);
      assert.doesNotMatch(run.stderr, /ExperimentalWarning/, `${args[0]}: a warning on the user's stderr`);
    }
    // the commands that write to the home wrote below the isolated one only
    assert.ok(existsSync(join(ctx.home_dir, ".pes")) || existsSync(ctx.pes_home), "something was written below the isolated home");
  } finally {
    ctx.cleanup();
  }
});

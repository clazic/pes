// SEL-71 (PR26b): scripts/pes.ts — the 32 CLI commands as a TypeScript entry point, difference 0 against 0.15 (intended differences D01~D11 aside).
//
// This file is the contract of the issue, written before the code (it fails until scripts/pes.ts exists):
//   1. the SEL-71 completion list is pinned (a: skeleton + write commands; SEL-77 owns the reads);
//   2. the run method is pinned: `node scripts/pes.ts` (Node 26 strips types) — also bare, unguarded, with a clean stderr;
//   3. every implemented case runs on the ts target and equals the pinned 0.15 baseline (E01~E04, E10, X01~X05, X08~X11);
//   4. the real-home guard covers the real child: nothing of the (fake and the account's) real ~/.pes / ~/pes-projects is touched.
// The ts target is the only target (SEL-74: the 0.15 Python side is gone; the baselines are its frozen record).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { D15_USAGE_PREFIXES, all_cases, assert_case, case_def, implemented_ids, load_contract_table, load_table, norm_out, read_baseline, strip_d15 } from "./helpers/compat_cases.ts";
import { make_ctx } from "./helpers/compat_env.ts";
import { PES_TS_FILE, REPO_ROOT, run_ts_bare, run_ts_cli } from "./helpers/compat_ts.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { SEL72_DONE } from "./helpers/sel72_scope.ts";
import { LATER, SEL71_DONE, SEL77_DONE, sel77_on } from "./helpers/sel_scope.ts";

use_home_guard();

test("completion list (SEL-71 a: pes.ts skeleton + write commands, SEL-72 serve / setup, SEL-77 b+c: read / report / doctor): exactly E01~E15 and X01~X11 are implemented on ts, every case has one owner", () => {
  assert.deepEqual([...implemented_ids()].sort(), [...SEL71_DONE, ...SEL72_DONE, ...SEL77_DONE].sort(), "cases.json / contract.json ts.status differ from the SEL-71 + SEL-72 + SEL-77 completion lists");
  assert.deepEqual([...SEL77_DONE], ["E05", "E06", "E07", "E11", "E12", "E15", "X06", "X07"], "SEL-77 owns the read / report cases and doctor (E15, moved over from SEL-72)");
  for (const id of SEL77_DONE) assert.equal(case_def(id).ts.status, "implemented", `${id} belongs to SEL-77 — implemented with it`);
  assert.equal(sel77_on(), true, "SEL-77 flips all of SEL77_DONE at once");
  assert.deepEqual([...LATER], [], "nothing is left to a later issue: every case has a ts target");
  assert.deepEqual(load_table().cases.filter((c) => c.kind !== "cli" && c.ts.status === "implemented").map((c) => c.id), [...SEL72_DONE], "http / setup cases are exactly SEL-72's (serve.ts / setup.ts)");
  assert.equal(all_cases().length, 15 + load_contract_table().cases.length);
  assert.deepEqual([...SEL71_DONE, ...SEL72_DONE, ...SEL77_DONE, ...LATER].sort(), all_cases().map((c) => c.id).sort(), "every case has exactly one owner");
  assert.equal(all_cases().filter((c) => c.ts.status === "not_yet").length, 0, "no not_yet case remains after SEL-77");
  for (const id of [...SEL71_DONE, ...SEL77_DONE]) assert.ok(existsSync(join(REPO_ROOT, "tests", "fixtures", "compat", "baseline", `${id}.json`)), `${id}: pinned 0.15 baseline`);
});

for (const id of SEL77_DONE) {
  test(`${id} on the ts target equals the 0.15 baseline (intended differences ${case_def(id).diffs.join(",")})`, { timeout: 300_000 }, async () => {
    await assert_case("ts", id);
  });
}

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
    // (SEL-74: the live 0.15 run next to the baseline is gone — the baseline IS the 0.15 page; the runner word and the new lines are D15 below)
  } finally {
    ctx.cleanup();
  }
});

test("D15: the usage page of pes.ts has exactly seven lines 0.15's did not (context · claim · submit · wait · complete · migrate <dir> · migrate --all) — taking out those and only those leaves the frozen 0.15 page letter for letter", () => {
  const ctx = make_ctx("pes-ts-d15-");
  try {
    const raw = run_ts_bare(ctx, []).stdout.replace(/\r\n/g, "\n");
    const page = raw.split("\n");
    for (const prefix of D15_USAGE_PREFIXES) assert.equal(page.filter((line) => line.startsWith(prefix)).length, 1, `${JSON.stringify(prefix)} appears exactly once`);
    const stripped = strip_d15(raw);
    assert.equal(page.length - stripped.split("\n").length, 7, "exactly seven lines are taken out");
    const want = (read_baseline("X01").steps as any[])[0].stdout as string[];
    assert.deepEqual(norm_out(raw, ctx.roots()), want, "the rest equals the 0.15 page");
    // a page with one other line changed (or one more) is NOT excused
    const tampered = raw.replace("  doctor ", "  doctor! ");
    assert.notDeepEqual(norm_out(tampered, ctx.roots()), want);
    assert.notDeepEqual(norm_out(`${raw.trimEnd()}\n  extra <dir>   one more line\n`, ctx.roots()), want);
  } finally {
    ctx.cleanup();
  }
});

test("every command name 0.15 knows (the 33 old ones; context·claim·submit·wait·complete are the DB-only five) is a command of pes.ts: with a missing project it answers a project error, never the usage page", () => {
  // the 38 command names of 0.15 (pes.py CMDS, recorded when the file still existed — SEL-74): 32 + set + the 5 DB-only ones
  const names = ["approve", "ask", "ask-prep", "assemble", "chat", "claim", "complete", "context", "digest", "doctor", "home", "hub", "init", "list", "lock", "mark", "merge", "note", "open", "pending", "qa", "qa-brief", "remote", "render", "reopen", "report", "round-start", "serve", "set", "show", "status", "stop", "submit", "unlock", "wait", "watch", "web", "which"];
  assert.equal(names.length, 38, "0.15 CMDS had 38 names (32 + set + 5 DB-only)");
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

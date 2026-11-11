// tests/test_project_basic.py → TS (SEL-70, PR26a; table 8: test_cli_compat). SEL-74: runs the TS CLI (node scripts/pes.ts) in an isolated
// HOME / USERPROFILE / PES_HOME, with the same synthetic input and assertions; the state is read from the database (project_state).
//
// What never had a CLI form (Python-internal) and is gone with the Python file — see tests/README.md "SEL-74 처리표":
//   test_isolated_home        pes.pes_home() / pes.CONFIG attributes      → the observable part is the `home` test below
//   test_main_*_dispatch / *_does_not_mutate_argv / passes_multiple_arguments_unchanged   monkeypatched pes.CMDS
//   test_guard_*              Python audit hook                           → tests/test_home_guard.test.ts, test_pes_ts_guard.test.ts
// The usage text is compared with the frozen 0.15 record (baseline X01) by test_pes_ts_contract (the new lines of D15 aside).
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { STAGES, make_ctx, pes, project_state, run_pes } from "./helpers/compat_env.ts";
import { use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

const ctx = make_ctx("pes-cli-compat-");
const real = (path: string): string => realpathSync.native(path);
after(() => ctx.cleanup());

test("isolated home: PES_HOME wins; without it the default is <HOME>/pes-projects (the config file is read from the isolated HOME)", () => {
  const set = pes(ctx, "home");
  assert.equal(set.code, 0, set.err);
  assert.ok(set.out.includes(real(ctx.pes_home)), set.out);
  assert.match(set.out, /프로젝트 0개/);

  const unset = run_pes("ts", ctx, ["home"], { env: { PES_HOME: undefined } });
  assert.equal(unset.kind, "ran");
  if (unset.kind !== "ran") return;
  assert.equal(unset.status, 0, unset.stderr);
  assert.ok(unset.stdout.includes(join(real(ctx.home_dir), "pes-projects")), unset.stdout);
});

test("cli init creates the six-stage skeleton at a Korean path with spaces; a duplicate init exits 2 and changes nothing", () => {
  const project = ctx.project("한글 공백 경로/새 프로젝트");
  const first = pes(ctx, "init", project, "--topic", "합성 주제");
  assert.equal(first.code, 0, first.out + first.err);
  const data = project_state(ctx, project);
  assert.equal(data.pes, 1);
  assert.equal(data.topic, "합성 주제");
  assert.equal(data.slug, "새 프로젝트");
  assert.equal(data.current, "plan");
  assert.deepEqual(Object.keys(data.stages).sort(), [...STAGES].sort());
  assert.equal(data.stages.plan.status, "asking");
  for (const stage of STAGES.slice(1)) assert.equal(data.stages[stage].status, "pending", stage);
  assert.deepEqual(data.processed, []);
  assert.deepEqual(data.settings, {});
  assert.equal(data.complete, false);

  const before = JSON.stringify(project_state(ctx, project));
  const second = pes(ctx, "init", project, "--topic", "다른 주제");
  assert.equal(second.code, 2, second.out + second.err);
  assert.equal(JSON.stringify(project_state(ctx, project)), before, "a refused init changes nothing");
});

test("no arguments and unknown commands print the usage text and exit 1", () => {
  for (const args of [[], ["unknown", "project"]]) {
    const run = pes(ctx, ...args);
    assert.equal(run.code, 1);
    assert.match(run.out, /^PES \(Project Execution System\) — 프로젝트 상태 CLI\./);
    assert.match(run.out, /사용: node scripts\/pes\.ts <명령> <프로젝트 폴더> \[인자\]/);
    assert.ok(run.out.trim().split("\n").length > 20, "the whole usage text, not one line");
  }
  const none = pes(ctx);
  const unknown = pes(ctx, "unknown", "project");
  assert.equal(none.out, unknown.out, "no arguments and an unknown command print the same page");
});

test("a single non-special command prints the usage and exits 1 (init, status, unknown)", () => {
  const page = pes(ctx).out;
  for (const command of ["init", "status", "unknown"]) {
    const run = pes(ctx, command);
    assert.equal(run.code, 1, command);
    assert.match(run.out, /^PES \(Project Execution System\)/, command);
    assert.equal(run.out, page, `${command}: the whole usage text`);
  }
});

test("main keeps the exit code of die(): init in a folder that already has a project.json exits 2", () => {
  const project = join(ctx.tmp, "duplicate");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "project.json"), "{}", "utf8");
  const run = pes(ctx, "init", project, "--topic", "주제");
  assert.equal(run.code, 2, run.out + run.err);
});

test("the single-argument commands list / hub-less set (home, remote) run with the implicit `--` and agree run to run", () => {
  for (const command of ["list", "home", "remote"]) {
    const a = pes(ctx, command);
    const b = pes(ctx, command);
    assert.equal(a.code, 0, `${command}: ${a.err}`);
    assert.deepEqual([a.code, a.out, a.err], [b.code, b.out, b.err], command);
    assert.notEqual(a.out.trim(), "", command);
  }
});

test("init with explicit path argument writes the topic (main with explicit argv / default argv are the same CLI call)", () => {
  const project = join(ctx.tmp, "명시 경로");
  const run = pes(ctx, "init", project, "--topic", "주제");
  assert.equal(run.code, 0, run.err);
  assert.equal(project_state(ctx, project).topic, "주제");
  assert.equal(run.out.trim(), join(real(project), "project.json"));
});

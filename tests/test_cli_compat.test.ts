// tests/test_project_basic.py → TS (SEL-70, PR26a; table 8: test_cli_compat). Runs the 0.15 CLI (python -I -X utf8 scripts/pes.py)
// in an isolated HOME / USERPROFILE / PES_HOME, with the same synthetic input and the same assertions as the pytest file.
//
// What did NOT move (Python-internal, no CLI form — they stay in pytest until PR26 removes it, see tests/README.md "TS 이전 대응"):
//   test_isolated_home        pes.pes_home() / pes.CONFIG attributes      → the observable part is the `home` test below
//   test_main_*_dispatch / *_does_not_mutate_argv / passes_multiple_arguments_unchanged   monkeypatched pes.CMDS
//   test_guard_*              Python audit hook                           → tests/test_home_guard.test.ts
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { PES_PY, STAGES, make_ctx, pes, project_json, read_json, run_pes, run_py_code } from "./helpers/compat_env.ts";
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

  const unset = run_pes("py", ctx, ["home"], { env: { PES_HOME: undefined } });
  assert.equal(unset.kind, "ran");
  if (unset.kind !== "ran") return;
  assert.equal(unset.status, 0, unset.stderr);
  assert.ok(unset.stdout.includes(join(real(ctx.home_dir), "pes-projects")), unset.stdout);
});

test("cli init creates the six-stage skeleton at a Korean path with spaces; a duplicate init exits 2 and changes nothing", () => {
  const project = ctx.project("한글 공백 경로/새 프로젝트");
  const first = pes(ctx, "init", project, "--topic", "합성 주제");
  assert.equal(first.code, 0, first.out + first.err);
  const data = project_json(project);
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

  const before = readFileSync(join(project, "project.json"));
  const second = pes(ctx, "init", project, "--topic", "다른 주제");
  assert.equal(second.code, 2, second.out + second.err);
  assert.deepEqual(readFileSync(join(project, "project.json")), before);
});

/** `pes.__doc__.strip()` of the pytest original: the module docstring of scripts/pes.py, read without importing the script. */
function pes_doc(): string {
  const run = run_py_code(ctx, "import ast, sys; print(ast.get_docstring(ast.parse(open(sys.argv[1], encoding='utf-8').read()), clean=False), end='')", [PES_PY]);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.trim().length > 100, "the docstring must be the whole usage text");
  return run.stdout.trim();
}

test("no arguments and unknown commands print the usage text and exit 1", () => {
  const doc = pes_doc();
  for (const args of [[], ["unknown", "project"]]) {
    const run = pes(ctx, ...args);
    assert.equal(run.code, 1);
    assert.ok(run.out.includes(doc), "the whole module docstring is the usage text");
    assert.match(run.out, /^PES \(Project Execution System\) — 프로젝트 상태 CLI\./);
    assert.match(run.out, /사용: python3 -I pes\.py <명령> <프로젝트 폴더> \[인자\]/);
  }
});

test("a single non-special command prints the usage and exits 1 (init, status, unknown)", () => {
  for (const command of ["init", "status", "unknown"]) {
    const run = pes(ctx, command);
    assert.equal(run.code, 1, command);
    assert.match(run.out, /^PES \(Project Execution System\)/, command);
    assert.ok(run.out.includes(pes_doc()), `${command}: the whole usage text`);
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
  assert.equal(read_json(join(project, "project.json")).topic, "주제");
  assert.equal(run.out.trim(), join(real(project), "project.json"));
});

test("PES_PY is the 0.15 script of this checkout", () => {
  assert.match(PES_PY.split("\\").join("/"), /\/scripts\/pes\.py$/);
});

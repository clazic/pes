// SEL-73 (stage 2 PR26d): 설계 검사 `docs/plan/schemas/check_ddl.py` → TS 검사기 `scripts/check_ddl.ts`.
// 시험을 먼저 썼다: 지금은 scripts/check_ddl.ts 가 없어서 실패한다(요구 때문에 실패 — import/문법 오류 아님).
// 인터페이스와 격리 규칙은 tests/helpers/ddl_check_env.ts 머리말. 기준은 check_ddl.py(python -I -X utf8)를 지금 돌린 결과다.
// 합성 자료만(DDL 초안 + 변이 사본), 임시 HOME/PES_HOME, 저장소 DDL 은 읽기만.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import {
  CHECK_PY,
  checker,
  CHECK_TS,
  DDL_SQL,
  MUTATIONS,
  lf,
  py_failure_message,
  read_lf,
  run_py_default,
  run_ts_default,
  with_work,
} from "./helpers/ddl_check_env.ts";
import { isolated_home } from "./helpers/isolated_home.ts";

const VERSION_LINE = /^SQLite \S+; foreign_keys=ON; database=:memory:$/;

function stdout_lines(text: string): string[] {
  return lf(text).split("\n").filter((l) => l !== "");
}

// ---------------------------------------------------------------------------
// 기준(Python)이 지금도 통과해야 비교가 의미 있다

test("baseline: check_ddl.py still passes on the repository DDL (reference for the TS port)", () => {
  const home = isolated_home("pes-sel73-base-");
  try {
    const py = run_py_default(home);
    assert.equal(py.status, 0, py.all);
    const lines = stdout_lines(py.stdout);
    assert.match(lines[0]!, VERSION_LINE);
    assert.ok(lines.some((l) => l.startsWith("RESULT PASS; rejected cases=64; representative queries=3")), py.stdout);
    assert.ok(lines.some((l) => l.includes("all 61 tables populated")), py.stdout);
  } finally {
    home.cleanup();
  }
});

test("the python reference stays in the repository until PR26 ends (the TS port is compared against it)", () => {
  assert.ok(existsSync(CHECK_PY), "docs/plan/schemas/check_ddl.py must not be deleted by PR26d");
});

// ---------------------------------------------------------------------------
// 같은 합성 사례(저장소 DDL 초안)에서 같은 결과

test("scripts/check_ddl.ts exists and is a TS module", () => {
  assert.ok(existsSync(CHECK_TS), "scripts/check_ddl.ts is the TS design checker");
});

test("TS checker passes on the repository DDL with the same PASS lines as check_ddl.py", () => {
  const home = isolated_home("pes-sel73-eq-");
  try {
    const py = run_py_default(home);
    const ts = run_ts_default(home);
    assert.equal(ts.status, 0, ts.all);
    const py_lines = stdout_lines(py.stdout);
    const ts_lines = stdout_lines(ts.stdout);
    // 첫 줄은 SQLite 버전이라 구현마다 다를 수 있다(python 번들 vs node:sqlite 번들). 형식은 같아야 한다.
    assert.match(py_lines[0]!, VERSION_LINE);
    assert.match(ts_lines[0]!, VERSION_LINE);
    assert.deepEqual(ts_lines.slice(1), py_lines.slice(1));
  } finally {
    home.cleanup();
  }
});

test("TS checker: the default DDL is docs/plan/schemas/stage-1-ddl-draft.sql and --ddl gives the same result", () => {
  return with_work((work) => {
    // work.dir 의 SQL 은 저장소 DDL 의 사본이다 — 명시한 경로로 돌려도 기본 경로와 같은 결과.
    const explicit = work.run_ts();
    const home = isolated_home("pes-sel73-def-");
    try {
      const implicit = run_ts_default(home);
      assert.equal(explicit.status, 0, explicit.all);
      assert.equal(implicit.status, 0, implicit.all);
      assert.deepEqual(stdout_lines(explicit.stdout).slice(1), stdout_lines(implicit.stdout).slice(1));
    } finally {
      home.cleanup();
    }
  });
});

test("run_ddl_checks() returns the numbers the python reference prints (61 tables, 64 rejections, 3 queries)", async () => {
  const mod = await checker();
  assert.equal(typeof mod.run_ddl_checks, "function");
  const result = mod.run_ddl_checks();
  assert.equal(result.ok, true, String(result.error));
  assert.equal(result.table_count, 61);
  assert.equal(result.rejected_cases, 64);
  assert.equal(result.representative_queries, 3);
  assert.equal(result.error, undefined);
  assert.ok(result.lines.some((l) => l.startsWith("RESULT PASS; rejected cases=64; representative queries=3")));
});

test("run_ddl_checks() reports a broken DDL as ok=false with a message (it does not throw a rule failure)", async () => {
  await with_work(async (work) => {
    const broken = work.write_sql(`${read_lf(DDL_SQL)}\nCREATE TRIGGER synthetic_trg AFTER INSERT ON users BEGIN SELECT 1; END;\n`);
    const mod = await checker();
    const result = mod.run_ddl_checks({ ddl_path: broken });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /Triggers forbidden/);
  });
});

test("importing scripts/check_ddl.ts does not run the checks by itself (CLI only when it is the entry point)", async () => {
  const source = readFileSync(CHECK_TS, "utf8");
  assert.match(source, /import\.meta\.main/, "the CLI part must be guarded by import.meta.main");
  assert.doesNotMatch(source, /node:child_process/, "the TS checker needs no child process");
  assert.doesNotMatch(source, /\b(spawn|execFile|execSync)\w*\(/, "the TS checker runs nothing external");
  await checker();
});

test("TS checker only uses an in-memory database (no filesystem database, no writes)", () => {
  const source = readFileSync(CHECK_TS, "utf8");
  assert.match(source, /:memory:/);
  assert.doesNotMatch(source, /writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync/, "design check never writes files");
});

// ---------------------------------------------------------------------------
// 깨진 DDL 변이: 각 규칙이 실제로 실패를 내고, 두 구현이 같은 실패(메시지 의미)를 낸다

for (const mutation of MUTATIONS) {
  test(`broken DDL '${mutation.name}' (${mutation.rule}) fails in python and in TS with the same message`, () =>
    with_work((work) => {
      const base = read_lf(DDL_SQL);
      const mutated = mutation.apply(base);
      assert.notEqual(mutated, base, "the mutation changes the DDL");
      work.write_sql(mutated);

      const py = work.run_py();
      assert.notEqual(py.status, 0, "the python reference must fail on the broken DDL");
      const py_message = py_failure_message(py.stderr);
      assert.ok(
        py_message.includes(mutation.expect),
        `python reference message for ${mutation.name}: ${JSON.stringify(py_message)}`,
      );

      const ts = work.run_ts();
      assert.notEqual(ts.status, 0, `TS checker must fail on '${mutation.name}':\n${ts.all}`);
      assert.ok(
        ts.all.includes(mutation.expect),
        `TS checker must say "${mutation.expect}" (the python message) — got:\n${ts.all}`,
      );
      // 통과 요약을 내면 안 된다
      assert.ok(!ts.stdout.includes("RESULT PASS"), "no RESULT PASS on a broken DDL");
    }));
}

test("a missing --ddl file is a clean failure (non-zero exit, a message, no PASS)", () =>
  with_work((work) => {
    const ts = work.run_ts_with(["--ddl", `${work.dir}/does-not-exist.sql`]);
    assert.notEqual(ts.status, 0);
    assert.ok(ts.all.includes("does-not-exist.sql"), `the message names the missing file:\n${ts.all}`);
    assert.ok(!ts.stdout.includes("RESULT PASS"));
    assert.doesNotMatch(ts.all, /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/, "the checker itself must exist and run");
  }));

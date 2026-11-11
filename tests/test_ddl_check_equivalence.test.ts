// SEL-73 (stage 2 PR26d): 설계 검사 `docs/plan/schemas/check_ddl.py` → TS 검사기 `scripts/check_ddl.ts`.
// SEL-74: 옛 Python 검사기는 저장소에서 사라졌다 — 기준은 그것이 낸 줄·실패 문장을 고정한 것(ddl_check_env.PY_REFERENCE_LINES · MUTATIONS[].expect)이다.
// 인터페이스와 격리 규칙은 tests/helpers/ddl_check_env.ts 머리말.
// 합성 자료만(DDL 초안 + 변이 사본), 임시 HOME/PES_HOME, 저장소 DDL 은 읽기만.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import {
  PY_REFERENCE_LINES,
  checker,
  CHECK_TS,
  DDL_SQL,
  MUTATIONS,
  lf,
  read_lf,
  run_ts_default,
  with_work,
} from "./helpers/ddl_check_env.ts";
import { isolated_home } from "./helpers/isolated_home.ts";

const VERSION_LINE = /^SQLite \S+; foreign_keys=ON; database=:memory:$/;

function stdout_lines(text: string): string[] {
  return lf(text).split("\n").filter((l) => l !== "");
}

// (옛 'baseline: check_ddl.py still passes' 와 'the python reference stays in the repository' 두 시험은 지웠다 — 기준이 고정한 줄은 아래에서 쓴다)

// ---------------------------------------------------------------------------
// 같은 합성 사례(저장소 DDL 초안)에서 같은 결과

test("scripts/check_ddl.ts exists and is a TS module", () => {
  assert.ok(existsSync(CHECK_TS), "scripts/check_ddl.ts is the TS design checker");
});

test("TS checker passes on the repository DDL with the same PASS lines the 0.15 check_ddl.py printed (frozen)", () => {
  const home = isolated_home("pes-sel73-eq-");
  try {
    const ts = run_ts_default(home);
    assert.equal(ts.status, 0, ts.all);
    const ts_lines = stdout_lines(ts.stdout);
    // 첫 줄은 SQLite 버전이라 번들마다 다를 수 있다. 형식은 같아야 한다.
    assert.match(ts_lines[0]!, VERSION_LINE);
    assert.deepEqual(ts_lines.slice(1), [...PY_REFERENCE_LINES]);
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

test("run_ddl_checks() returns the numbers the 0.15 python reference printed (61 tables, 64 rejections, 3 queries)", async () => {
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
  test(`broken DDL '${mutation.name}' (${mutation.rule}) fails in TS with the message the 0.15 reference gave`, () =>
    with_work((work) => {
      const base = read_lf(DDL_SQL);
      const mutated = mutation.apply(base);
      assert.notEqual(mutated, base, "the mutation changes the DDL");
      work.write_sql(mutated);

      const ts = work.run_ts();
      assert.notEqual(ts.status, 0, `TS checker must fail on '${mutation.name}':\n${ts.all}`);
      assert.ok(
        ts.all.includes(mutation.expect),
        `TS checker must say "${mutation.expect}" (the message check_ddl.py gave) — got:\n${ts.all}`,
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

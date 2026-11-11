/**
 * SEL-56 PR21 — A·B 교차 계약, SQLite/D1 편 (tester, 작성 모드). 완료 조건 6:
 *   SQLite 와 D1(로컬 miniflare)이 같은 시나리오에서 같은 성공·충돌·부분 실패를 낸다.
 * The scenario table is tests/fixtures/contracts/cross/d1_scenarios.json: the claim / release / heartbeat / receipt
 * statements of the A and B paths (the same SQL shapes commands/runs.ts and mutation_commits use), run as ONE batch per step.
 * The reference engine (node:sqlite) always runs. The local D1 (miniflare) part follows the existing smoke
 * (tests/test_d1_smoke.test.ts): it runs when tests/d1/node_modules has miniflare, is skipped WITH a reason when it has not,
 * and PES_D1_SMOKE=1 without the tool is a hard failure. On top of that an always-running test PRINTS whether D1 ran, so a
 * green run never silently means "D1 not covered".
 *
 *   (cd tests/d1 && npm ci) && PES_D1_SMOKE=1 node --test tests/test_cross_d1.test.ts
 *
 * 해석:
 *  해석 19  D1 은 001 만 적용한다(문서 8.16: 002 의 foreign_keys=off 방식은 D1 에서 안 된다, 5단계 별도 절차). 그래서 D1 쪽의
 *           A run 은 001 의 Go 라벨 쌍(mode A + opencode-go)으로 표현한다 — SQLite 쪽 pes_builtin 경로는 이 표가 아니라
 *           다른 cross 시험들이 본다. 002 의 D1 적용 여부는 이 이슈 밖(5단계)이다.
 *  해석 20  표의 SQL 은 서비스 코드를 import 하지 않고 다시 쓴 것이다(서비스는 node:sqlite 동기 API 라 D1 에서 못 돈다).
 *           release·heartbeat 는 commands/runs.ts 와 같은 모양이다. claim 은 D1 에서 쓸 CAS 변형(fence·만료 조건 추가)이며
 *           runs.ts 의 claim UPDATE(WHERE project_id = ? 뿐, 살아 있는 lease 검사는 TS 가 같은 tx 안에서 먼저 한다)와
 *           다르다 — 5단계 D1 claim CAS 의 기준 표이지 서비스 쿼리의 등가 증명이 아니다. release·heartbeat 모양이 바뀌면
 *           이 표도 같이 고쳐야 한다(worker 몫으로 보고서에 적음).
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { connect, tx, type Db } from "../scripts/pes_core/db.ts";
import {
  apply_migrations,
  run_batch,
  type BatchStatement,
  type D1Like,
} from "../scripts/pes_core/d1_smoke.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const D1_DIR = join(HERE, "d1");
const MINIFLARE_ENTRY = join(D1_DIR, "node_modules", "miniflare", "dist", "src", "index.js");
const MIGRATION_001 = readFileSync(join(HERE, "..", "scripts", "pes_core", "migrations", "001_initial.sql"), "utf8");
const FIXTURE = join(HERE, "fixtures", "contracts", "cross", "d1_scenarios.json");

const forced = process.env.PES_D1_SMOKE === "1";
const tool_present = existsSync(MINIFLARE_ENTRY);
const run_d1 = tool_present;

type Row = Record<string, unknown>;

interface FixtureStatement {
  sql: string;
  params: Array<string | number | null>;
  require_change?: boolean;
}
interface Expectation {
  sql: string;
  params: Array<string | number | null>;
  rows: Row[];
}
interface FixtureStep {
  label: string;
  batch: FixtureStatement[];
  expect: "ok" | "zero_rows" | "error";
  changes?: number[];
  then?: Expectation[];
}
interface Scenario {
  name: string;
  why: string;
  steps: FixtureStep[];
}
interface Table {
  seed: FixtureStatement[];
  scenarios: Scenario[];
}

const TABLE = JSON.parse(readFileSync(FIXTURE, "utf8")) as Table;

// ---------------------------------------------------------------------------------------------------------
// engines (same shape as the existing smoke's Engine; kept local because that file does not export it)

interface Engine {
  kind: "sqlite" | "d1";
  apply(sql: string): Promise<void>;
  batch(statements: readonly BatchStatement[]): Promise<number[]>;
  rows(sql: string, params?: readonly (string | number | null)[]): Promise<Row[]>;
  close(): void;
}

class RefZeroRows extends Error {
  override name = "ZeroRowsError";
}

function normalize(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) out[key] = typeof value === "bigint" ? Number(value) : value;
  return out;
}

function sqlite_engine(): Engine {
  const db: Db = connect(":memory:");
  return {
    kind: "sqlite",
    async apply(sql) {
      tx(db, () => {
        db.exec(sql);
      });
    },
    async batch(statements) {
      return tx(db, () => {
        const changes: number[] = [];
        for (const statement of statements) {
          const result = db.run(statement.sql, ...(statement.params ?? []));
          const count = Number(result.changes);
          if (statement.require_change === true && count === 0) throw new RefZeroRows("statement changed 0 rows");
          changes.push(count);
        }
        return changes;
      });
    },
    async rows(sql, params = []) {
      return db.all(sql, ...params).map((row) => normalize(row));
    },
    close() {
      db.close();
    },
  };
}

interface MiniflareLike {
  getD1Database(binding: string): Promise<D1Full>;
  dispose(): Promise<void>;
}
interface D1Full {
  prepare(sql: string): { bind(...values: unknown[]): { all(): Promise<{ results: Row[] }> } };
  batch: D1Like["batch"];
}

const POOL_SIZE = 24;
let miniflare: MiniflareLike | undefined;
let pool_next = 0;

async function d1_engine(): Promise<Engine> {
  assert.ok(miniflare, "miniflare did not start");
  assert.ok(pool_next < POOL_SIZE, "the D1 pool is used up: raise POOL_SIZE");
  const d1 = await miniflare.getD1Database(`DB${pool_next}`);
  pool_next += 1;
  return {
    kind: "d1",
    async apply(sql) {
      await apply_migrations(d1 as unknown as D1Like, sql);
    },
    async batch(statements) {
      return (await run_batch(d1 as unknown as D1Like, statements)).changes;
    },
    async rows(sql, params = []) {
      const { results } = await d1.prepare(sql).bind(...params).all();
      return results.map((row) => normalize(row));
    },
    close() {},
  };
}

// ---------------------------------------------------------------------------------------------------------
// running the table

interface StepTrace {
  label: string;
  outcome: "ok" | "zero_rows" | "error";
  changes: number[] | null;
  then: Row[][];
}

async function run_scenario(engine: Engine, scenario: Scenario): Promise<StepTrace[]> {
  await engine.apply(MIGRATION_001);
  await engine.batch(TABLE.seed);
  const trace: StepTrace[] = [];
  for (const step of scenario.steps) {
    let outcome: StepTrace["outcome"] = "ok";
    let changes: number[] | null = null;
    try {
      changes = await engine.batch(step.batch);
    } catch (error) {
      outcome = error instanceof Error && error.name === "ZeroRowsError" ? "zero_rows" : "error";
    }
    const after_rows: Row[][] = [];
    for (const q of step.then ?? []) after_rows.push(await engine.rows(q.sql, q.params));
    trace.push({ label: step.label, outcome, changes, then: after_rows });
  }
  return trace;
}

function check_against_table(kind: string, scenario: Scenario, trace: StepTrace[]): void {
  assert.equal(trace.length, scenario.steps.length);
  scenario.steps.forEach((step, i) => {
    const got = trace[i]!;
    const where = `${kind} / ${scenario.name} / ${step.label}`;
    assert.equal(got.outcome, step.expect, `${where}: outcome`);
    if (step.changes !== undefined) assert.deepEqual(got.changes, step.changes, `${where}: changes per statement`);
    (step.then ?? []).forEach((q, j) => assert.deepEqual(got.then[j], q.rows, `${where}: table state ${j} (${q.sql.slice(0, 40)}…)`));
  });
}

function define_table_tests(kind: "sqlite" | "d1"): void {
  for (const scenario of TABLE.scenarios) {
    test(`${kind} / ${scenario.name} — ${scenario.why}`, async () => {
      const engine = kind === "sqlite" ? sqlite_engine() : await d1_engine();
      try {
        check_against_table(kind, scenario, await run_scenario(engine, scenario));
      } finally {
        engine.close();
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------------------

test("fixture: eleven named scenarios, each step states its outcome, and the table covers success, conflict and partial failure", () => {
  assert.ok(TABLE.scenarios.length >= 11);
  const names = new Set<string>();
  const outcomes = new Set<string>();
  for (const scenario of TABLE.scenarios) {
    assert.ok(!names.has(scenario.name), `duplicate ${scenario.name}`);
    names.add(scenario.name);
    for (const step of scenario.steps) {
      assert.ok(["ok", "zero_rows", "error"].includes(step.expect));
      outcomes.add(step.expect);
      for (const s of step.batch) assert.ok(s.params.every((p) => p === null || typeof p === "string" || typeof p === "number"), "D1 takes no bigint");
    }
  }
  assert.deepEqual([...outcomes].sort(), ["error", "ok", "zero_rows"]);
});

test("D1 status — always printed, never silent: this run says whether the local D1 part ran", (t) => {
  const line = run_d1
    ? "D1 part: RAN against local miniflare (tests/d1/node_modules present)."
    : forced
      ? "D1 part: FAILING (PES_D1_SMOKE=1 but tests/d1/node_modules has no miniflare)."
      : "D1 part: NOT RUN in this run (tests/d1/node_modules has no miniflare). Install with (cd tests/d1 && npm ci), then PES_D1_SMOKE=1 node --test tests/test_cross_d1.test.ts. CI runs it in the d1-smoke workflow.";
  t.diagnostic(line);
  console.log(line);
  if (forced) assert.ok(run_d1, line);
});

describe("sqlite (reference engine, always runs)", () => {
  define_table_tests("sqlite");
});

if (!tool_present && forced) {
  test("PES_D1_SMOKE=1 but the D1 tool (tests/d1/node_modules/miniflare) is missing", () => {
    assert.fail(`D1 tool is not installed: ${MINIFLARE_ENTRY} not found. Run (cd tests/d1 && npm ci) first.`);
  });
}

describe("d1 (local miniflare)", {
  skip: run_d1 ? false : "tests/d1/node_modules has no miniflare, so the D1 part was skipped. Run (cd tests/d1 && npm ci), then PES_D1_SMOKE=1.",
}, () => {
  before(async () => {
    const mod = (await import(pathToFileURL(MINIFLARE_ENTRY).href)) as { Miniflare: new (options: Record<string, unknown>) => MiniflareLike };
    const d1Databases: Record<string, string> = {};
    for (let index = 0; index < POOL_SIZE; index += 1) d1Databases[`DB${index}`] = `pes-cross-d1-${index}`;
    // no persist option = memory; no account, no network
    miniflare = new mod.Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases });
  });

  after(async () => {
    await miniflare?.dispose();
    miniflare = undefined;
  });

  define_table_tests("d1");

  test("d1 and sqlite give the same trace for every scenario (outcome, per-statement changes, table state)", async () => {
    for (const scenario of TABLE.scenarios) {
      const reference = sqlite_engine();
      const d1 = await d1_engine();
      try {
        const a = await run_scenario(reference, scenario);
        const b = await run_scenario(d1, scenario);
        assert.deepEqual(b, a, `${scenario.name}: D1 and SQLite agree step by step`);
      } finally {
        reference.close();
        d1.close();
      }
    }
  });
});

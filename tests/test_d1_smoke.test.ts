// SEL-35 (stage 2 PR2): D1 호환 smoke.
//
// ── worker 가 구현할 계약: scripts/pes_core/d1_smoke.ts ─────────────────────────
// miniflare 를 import 하지 않는다. 아래 최소 D1 모양만 받는다(Cloudflare D1Database 가 그대로 맞는다).
//
//   export type D1Param = string | number | null;      // bigint 는 D1 이 받지 못한다
//   export interface D1ResultLike { meta: { changes: number } }
//   export interface D1PreparedLike { bind(...values: D1Param[]): D1PreparedLike }
//   export interface D1Like {
//     prepare(sql: string): D1PreparedLike;
//     batch(statements: D1PreparedLike[]): Promise<D1ResultLike[]>;
//   }
//   export interface BatchStatement {
//     sql: string;
//     params?: readonly D1Param[];
//     require_change?: boolean;   // true 이면 이 문장이 0행을 바꾸면 전체 batch 가 실패한다
//   }
//
//   export class ZeroRowsError extends Error { }       // name === "ZeroRowsError"
//
//   // 0행 확인 helper. changes === 0 이면 ZeroRowsError, 아니면 아무 일도 없다.
//   export function assert_changed(changes: number, what: string): void;
//
//   // SQL 텍스트를 문장 배열로 나눈다. 각 원소는 앞뒤 공백·끝 ';' 가 없는 한 문장.
//   // 문자열 리터럴('...;...'), `-- ...;` 줄 주석, `/* ...; */` 블록 주석 안의 ';' 에서는 자르지 않는다.
//   // 빈 조각·주석뿐인 조각은 버린다. (D1 의 exec 는 줄 단위라 여러 줄 DDL 에 쓸 수 없다.)
//   export function split_sql(sql: string): string[];
//
//   // 마이그레이션 SQL 전체를 batch 한 번(=한 tx)으로 적용한다. 중간에 실패하면 아무것도 남지 않는다.
//   // 빈 SQL 이면 D1 을 부르지 않고 { statements: 0 }.
//   export function apply_migrations(d1: D1Like, sql: string): Promise<{ statements: number }>;
//
//   // 문장들을 batch 한 번(=한 tx)으로 실행한다. 반환 changes 는 statements 와 같은 길이·순서의 변경 행 수.
//   //  - require_change 인 문장은 직후에 가드 문장을 같은 batch 에 붙여, 0행이면 batch 안에서 실패하게 한다
//   //    (그래야 앞서 실행한 문장도 함께 롤백된다). 실패는 ZeroRowsError 로 보고한다.
//   //    가드 예: `SELECT CASE WHEN changes() = 0 THEN abs(-9223372036854775808) ELSE 1 END`
//   //    (로컬 D1 측정: 존재하지 않는 표를 가리키는 가드는 컴파일 때 실패해 쓸 수 없고, 위 형태는 0행일 때만 실패한다.)
//   //    가드 문장의 changes 는 반환값에서 뺀다.
//   //  - require_change 가 없으면 0행도 성공이다(changes 에 0 이 그대로 나온다).
//   //  - params 에 bigint 가 있으면 아무것도 실행하기 전에 TypeError. 큰 정수는 10진 문자열로 넘긴다.
//   //  - 빈 배열이면 D1 을 부르지 않고 { changes: [] }.
//   //  - 그 밖의 SQL 오류(제약 위반, tx 끝의 deferred FK 위반 등)는 D1 오류를 그대로 reject 한다.
//   export function run_batch(d1: D1Like, statements: readonly BatchStatement[]): Promise<{ changes: number[] }>;
//
// ── 실행 ──────────────────────────────────────────────────────────────────────
//   (cd tests/d1 && npm ci) && PES_D1_SMOKE=1 node --test tests/test_d1_smoke.test.ts
// 로컬 D1(miniflare)만 쓴다. 계정·로그인·원격 접근 없음. 도구가 없고 PES_D1_SMOKE=1 도 아니면 D1 부분은
// 이유를 적고 건너뛴다. PES_D1_SMOKE=1 인데 도구가 없으면 실패한다.
// 같은 시나리오를 node:sqlite(참조 엔진)로도 돌려 성공·실패 의미가 같은지 본다. 참조 엔진 부분은 도구 없이 항상 돈다.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { connect, tx, type Db } from "../scripts/pes_core/db.ts";
import {
  ZeroRowsError,
  apply_migrations,
  assert_changed,
  run_batch,
  split_sql,
  type BatchStatement,
  type D1Like,
} from "../scripts/pes_core/d1_smoke.ts";

// ── 도구 확인 ────────────────────────────────────────────────────────────────

const D1_DIR = fileURLToPath(new URL("./d1/", import.meta.url));
const MINIFLARE_ENTRY = join(D1_DIR, "node_modules", "miniflare", "dist", "src", "index.js");
const MIGRATION_001 = readFileSync(
  fileURLToPath(new URL("../scripts/pes_core/migrations/001_initial.sql", import.meta.url)),
  "utf8",
);

const forced = process.env.PES_D1_SMOKE === "1";
const tool_present = existsSync(MINIFLARE_ENTRY);
const run_d1 = tool_present;

const POOL_SIZE = 40;

interface MiniflareLike {
  getD1Database(binding: string): Promise<D1Full>;
  dispose(): Promise<void>;
}
interface D1Full {
  prepare(sql: string): PreparedFull;
  batch: D1Like["batch"];
}
interface PreparedFull {
  bind(...values: unknown[]): PreparedFull;
  all(): Promise<{ results: Record<string, unknown>[] }>;
}

let miniflare: MiniflareLike | undefined;
let pool_next = 0;

async function next_d1(): Promise<D1Full> {
  assert.ok(miniflare, "miniflare 가 시작되지 않았다");
  assert.ok(pool_next < POOL_SIZE, "D1 풀이 모자란다: POOL_SIZE 를 늘린다");
  const binding = `DB${pool_next}`;
  pool_next += 1;
  return miniflare.getD1Database(binding);
}

// ── 엔진 추상화: 같은 시나리오를 D1 과 node:sqlite 에서 돌린다 ────────────────────────

type Row = Record<string, unknown>;
type Kind = "d1" | "sqlite";

interface Engine {
  kind: Kind;
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
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === "bigint" ? Number(value) : value;
  }
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
          if (statement.require_change === true && count === 0) {
            throw new RefZeroRows("statement changed 0 rows");
          }
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

async function d1_engine(): Promise<Engine> {
  const d1 = await next_d1();
  return {
    kind: "d1",
    async apply(sql) {
      await apply_migrations(d1, sql);
    },
    async batch(statements) {
      return (await run_batch(d1, statements)).changes;
    },
    async rows(sql, params = []) {
      const { results } = await d1.prepare(sql).bind(...params).all();
      return results.map((row) => normalize(row));
    },
    close() {},
  };
}

async function fresh(kind: Kind): Promise<Engine> {
  const engine = kind === "d1" ? await d1_engine() : sqlite_engine();
  await engine.apply(MIGRATION_001);
  return engine;
}

async function count(engine: Engine, table: string): Promise<number> {
  const rows = await engine.rows(`SELECT count(*) AS n FROM ${table}`);
  return Number(rows[0]?.n);
}

function is_zero_rows(error: unknown): boolean {
  return error instanceof Error && error.name === "ZeroRowsError";
}

// ── 합성 데이터(전부 지어낸 값) ────────────────────────────────────────────────

const USER_SQL = "INSERT INTO users (id, display_name) VALUES (?, ?)";
const PROJECT_SQL = "INSERT INTO projects (id, slug, topic, owner_user_id) VALUES (?, ?, ?, ?)";
const MEMBER_SQL = "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)";

function user(id: string): BatchStatement {
  return { sql: USER_SQL, params: [id, `user ${id}`] };
}

/** 사용자 → 프로젝트 → owner 멤버. projects→project_members 는 deferred FK 라 이 순서가 허용된다. */
function project_with_owner(project_id: string, user_id: string): BatchStatement[] {
  return [
    user(user_id),
    { sql: PROJECT_SQL, params: [project_id, `slug-${project_id}`, "synthetic topic", user_id] },
    { sql: MEMBER_SQL, params: [project_id, user_id, "owner"] },
  ];
}

const EDITION_SQL =
  "INSERT INTO editions (id, project_id, edition_no, status, settings_json) VALUES (?, ?, ?, ?, ?)";

function edition(id: string, project_id: string, no: number, status: string, settings = "{}"): BatchStatement {
  return { sql: EDITION_SQL, params: [id, project_id, no, status, settings] };
}

// ── 시나리오(양쪽 엔진에서 같은 기대) ────────────────────────────────────────────

function scenarios(kind: Kind): void {
  describe(kind, () => {
    test("001 마이그레이션이 61개 표와 부분 UNIQUE 인덱스를 만든다", async () => {
      const engine = await fresh(kind);
      try {
        const tables = await engine.rows(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
        );
        assert.equal(tables.length, 61);
        const indexes = await engine.rows(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('one_project_owner','one_active_edition','one_open_round') ORDER BY name",
        );
        assert.deepEqual(
          indexes.map((row) => row.name),
          ["one_active_edition", "one_open_round", "one_project_owner"],
        );
      } finally {
        engine.close();
      }
    });

    test("foreign_keys 가 켜져 있다", async () => {
      const engine = await fresh(kind);
      try {
        const rows = await engine.rows("PRAGMA foreign_keys");
        assert.equal(Number(rows[0]?.foreign_keys), 1);
      } finally {
        engine.close();
      }
    });

    test("batch: 정상 문장들이 모두 반영되고 문장별 changes 를 돌려준다", async () => {
      const engine = await fresh(kind);
      try {
        const changes = await engine.batch(project_with_owner("p1", "u1"));
        assert.deepEqual(changes, [1, 1, 1]);
        assert.equal(await count(engine, "users"), 1);
        assert.equal(await count(engine, "projects"), 1);
        assert.equal(await count(engine, "project_members"), 1);
      } finally {
        engine.close();
      }
    });

    test("batch 원자성: 중간 문장이 실패하면 앞 문장도 남지 않는다", async () => {
      const engine = await fresh(kind);
      try {
        await assert.rejects(
          engine.batch([user("u1"), user("u2"), user("u1") /* PK 중복 */, user("u3")]),
        );
        assert.equal(await count(engine, "users"), 0);
        // 실패 뒤에도 연결이 정상이다.
        assert.deepEqual(await engine.batch([user("u9")]), [1]);
        assert.equal(await count(engine, "users"), 1);
      } finally {
        engine.close();
      }
    });

    test("뒤늦은 실패: 마지막 문장의 CHECK 위반이 앞의 성공 문장 전부를 롤백한다", async () => {
      const engine = await fresh(kind);
      try {
        await assert.rejects(
          engine.batch([
            ...project_with_owner("p1", "u1"),
            user("u2"),
            { sql: USER_SQL, params: ["u3", ""] }, // length(display_name) > 0 위반
          ]),
        );
        for (const table of ["users", "projects", "project_members"]) {
          assert.equal(await count(engine, table), 0, `${table} 에 행이 남았다`);
        }
      } finally {
        engine.close();
      }
    });

    test("deferred FK: tx 안에서는 순서가 틀려도 되고 끝에서 충족되면 성공한다", async () => {
      const engine = await fresh(kind);
      try {
        // projects 가 project_members 보다 먼저 들어가도(project_members 는 아직 없다) 끝에서 맞으면 된다.
        const changes = await engine.batch(project_with_owner("p1", "u1"));
        assert.deepEqual(changes, [1, 1, 1]);
        const rows = await engine.rows("SELECT owner_user_id FROM projects WHERE id = ?", ["p1"]);
        assert.equal(rows[0]?.owner_user_id, "u1");
      } finally {
        engine.close();
      }
    });

    test("deferred FK: tx 끝까지 충족되지 않으면 전체가 실패하고 롤백된다", async () => {
      const engine = await fresh(kind);
      try {
        const [u, p] = project_with_owner("p1", "u1"); // owner 멤버 행을 일부러 뺀다
        await assert.rejects(engine.batch([u, p]));
        assert.equal(await count(engine, "users"), 0);
        assert.equal(await count(engine, "projects"), 0);
        // 실패 뒤 정상 batch 가 된다.
        assert.deepEqual(await engine.batch(project_with_owner("p2", "u2")), [1, 1, 1]);
        assert.equal(await count(engine, "projects"), 1);
      } finally {
        engine.close();
      }
    });

    test("deferred FK 위반은 앞서 성공한 0행 확인·갱신까지 함께 롤백한다(뒤늦은 실패)", async () => {
      const engine = await fresh(kind);
      try {
        await engine.batch(project_with_owner("p1", "u1"));
        const [u, p] = project_with_owner("p2", "u2");
        await assert.rejects(
          engine.batch([
            {
              sql: "UPDATE projects SET control_rev = control_rev + 1 WHERE id = ? AND control_rev = ?",
              params: ["p1", 0],
              require_change: true,
            },
            u,
            p, // owner 멤버 없음 → tx 끝에서 실패
          ]),
        );
        const rows = await engine.rows("SELECT control_rev FROM projects WHERE id = ?", ["p1"]);
        assert.equal(rows[0]?.control_rev, 0, "앞선 UPDATE 가 롤백되지 않았다");
        assert.equal(await count(engine, "projects"), 1);
        assert.equal(await count(engine, "users"), 1);
      } finally {
        engine.close();
      }
    });

    test("부분 UNIQUE one_project_owner: owner 는 프로젝트당 하나, 다른 역할은 여럿", async () => {
      const engine = await fresh(kind);
      try {
        await engine.batch(project_with_owner("p1", "u1"));
        await assert.rejects(engine.batch([user("u2"), { sql: MEMBER_SQL, params: ["p1", "u2", "owner"] }]));
        assert.equal(await count(engine, "users"), 1, "실패한 batch 의 user 가 남았다");

        const changes = await engine.batch([
          user("u2"),
          user("u3"),
          { sql: MEMBER_SQL, params: ["p1", "u2", "editor"] },
          { sql: MEMBER_SQL, params: ["p1", "u3", "editor"] },
        ]);
        assert.deepEqual(changes, [1, 1, 1, 1]);
        assert.equal(await count(engine, "project_members"), 3);
      } finally {
        engine.close();
      }
    });

    test("부분 UNIQUE one_active_edition: active 판은 프로젝트당 하나, draft 는 여럿", async () => {
      const engine = await fresh(kind);
      try {
        await engine.batch(project_with_owner("p1", "u1"));
        await engine.batch([
          edition("e1", "p1", 1, "active"),
          edition("e2", "p1", 2, "draft"),
          edition("e3", "p1", 3, "draft"),
        ]);
        await assert.rejects(engine.batch([edition("e4", "p1", 4, "active")]));
        assert.equal(await count(engine, "editions"), 3);
        // 다른 프로젝트의 active 는 허용된다.
        await engine.batch([...project_with_owner("p2", "u2"), edition("e5", "p2", 1, "active")]);
        assert.equal(await count(engine, "editions"), 4);
      } finally {
        engine.close();
      }
    });

    test("JSON 함수와 json_valid CHECK", async () => {
      const engine = await fresh(kind);
      try {
        const rows = await engine.rows(
          `SELECT json_valid('{"a":[1,2]}') AS valid,
                  json_valid('{') AS invalid,
                  json_type('[1]') AS arr,
                  json_type('{"a":1}') AS obj,
                  json_extract('{"a":[1,2]}', '$.a[1]') AS second,
                  json_array_length('[1,2,3]') AS len`,
        );
        assert.deepEqual(rows[0], { valid: 1, invalid: 0, arr: "array", obj: "object", second: 2, len: 3 });

        await engine.batch(project_with_owner("p1", "u1"));
        await engine.batch([edition("e1", "p1", 1, "draft", '{"theme":{"k":[10,20]}}')]);
        const stored = await engine.rows(
          "SELECT json_extract(settings_json, '$.theme.k[1]') AS v FROM editions WHERE id = ?",
          ["e1"],
        );
        assert.equal(stored[0]?.v, 20);

        await assert.rejects(engine.batch([edition("e2", "p1", 2, "draft", "{")]));
        assert.equal(await count(engine, "editions"), 1);
      } finally {
        engine.close();
      }
    });

    test("0행 실패: require_change 문장이 0행이면 batch 전체가 ZeroRowsError 로 실패한다", async () => {
      const engine = await fresh(kind);
      try {
        await assert.rejects(
          engine.batch([
            user("u1"),
            {
              sql: "UPDATE users SET display_name = ? WHERE id = ?",
              params: ["changed", "no-such-user"],
              require_change: true,
            },
            user("u2"),
          ]),
          is_zero_rows,
        );
        assert.equal(await count(engine, "users"), 0, "0행 실패인데 앞 문장이 남았다");
      } finally {
        engine.close();
      }
    });

    test("0행 실패: INSERT OR IGNORE 가 무시되어 0행이면 require_change 로 실패한다", async () => {
      const engine = await fresh(kind);
      try {
        await engine.batch([user("u1")]);
        await assert.rejects(
          engine.batch([
            user("u2"),
            { sql: "INSERT OR IGNORE INTO users (id, display_name) VALUES (?, ?)", params: ["u1", "dup"], require_change: true },
          ]),
          is_zero_rows,
        );
        assert.equal(await count(engine, "users"), 1);
      } finally {
        engine.close();
      }
    });

    test("0행이 아니면 require_change 는 통과하고 changes 는 가드를 포함하지 않는다", async () => {
      const engine = await fresh(kind);
      try {
        await engine.batch([user("u1")]);
        const changes = await engine.batch([
          { sql: "UPDATE users SET display_name = ? WHERE id = ?", params: ["new", "u1"], require_change: true },
          user("u2"),
          { sql: "UPDATE users SET display_name = ? WHERE id = ?", params: ["x", "u2"], require_change: true },
        ]);
        assert.deepEqual(changes, [1, 1, 1]);
        const rows = await engine.rows("SELECT display_name FROM users WHERE id = ?", ["u1"]);
        assert.equal(rows[0]?.display_name, "new");
      } finally {
        engine.close();
      }
    });

    test("require_change 가 없으면 0행도 성공이고 changes 에 0 이 나온다", async () => {
      const engine = await fresh(kind);
      try {
        const changes = await engine.batch([
          { sql: "UPDATE users SET display_name = ? WHERE id = ?", params: ["x", "no-such-user"] },
          user("u1"),
        ]);
        assert.deepEqual(changes, [0, 1]);
        assert.equal(await count(engine, "users"), 1);
      } finally {
        engine.close();
      }
    });

    test("rev 충돌(대표 명령): 낡은 control_rev 의 UPDATE 는 0행이라 같은 batch 의 기록까지 롤백된다", async () => {
      const engine = await fresh(kind);
      try {
        await engine.batch(project_with_owner("p1", "u1"));
        const bump = (expected: number): BatchStatement => ({
          sql: "UPDATE projects SET control_rev = control_rev + 1 WHERE id = ? AND control_rev = ?",
          params: ["p1", expected],
          require_change: true,
        });

        assert.deepEqual(await engine.batch([bump(0), user("u2")]), [1, 1]);
        // 같은 base 로 한 번 더 → 충돌.
        await assert.rejects(engine.batch([bump(0), user("u3")]), is_zero_rows);

        const rows = await engine.rows("SELECT control_rev FROM projects WHERE id = ?", ["p1"]);
        assert.equal(rows[0]?.control_rev, 1);
        const ids = await engine.rows("SELECT id FROM users ORDER BY id");
        assert.deepEqual(ids.map((row) => row.id), ["u1", "u2"]);
      } finally {
        engine.close();
      }
    });

    test("2^53 를 넘는 INTEGER: 10진 문자열로 넣고 CAST AS TEXT 로 읽으면 손실이 없다", async () => {
      const engine = await fresh(kind);
      try {
        const big = "9007199254740993"; // 2^53 + 1
        await engine.batch([
          user("u1"),
          {
            sql: "INSERT INTO projects (id, slug, topic, owner_user_id, control_rev) VALUES (?, ?, ?, ?, ?)",
            params: ["p1", "slug-p1", "synthetic topic", "u1", big],
          },
          { sql: MEMBER_SQL, params: ["p1", "u1", "owner"] },
        ]);
        const rows = await engine.rows(
          "SELECT CAST(control_rev AS TEXT) AS s, typeof(control_rev) AS t FROM projects WHERE id = ?",
          ["p1"],
        );
        assert.deepEqual(rows[0], { s: big, t: "integer" });
      } finally {
        engine.close();
      }
    });
  });
}

// ── 참조 엔진(node:sqlite): 도구 없이 항상 돈다 ───────────────────────────────────

scenarios("sqlite");

// ── 로컬 D1 ─────────────────────────────────────────────────────────────────

if (!tool_present && forced) {
  test("PES_D1_SMOKE=1 인데 D1 도구(tests/d1/node_modules/miniflare)가 없다", () => {
    assert.fail(
      `D1 도구가 설치되지 않았다: ${MINIFLARE_ENTRY} 없음. (cd tests/d1 && npm ci) 를 먼저 실행한다.`,
    );
  });
}

describe("d1 (로컬 miniflare)", {
  skip: run_d1
    ? false
    : "tests/d1/node_modules 에 miniflare 가 없어 건너뜀. (cd tests/d1 && npm ci) 후 PES_D1_SMOKE=1 로 실행한다.",
}, () => {
  before(async () => {
    const mod = (await import(pathToFileURL(MINIFLARE_ENTRY).href)) as {
      Miniflare: new (options: Record<string, unknown>) => MiniflareLike;
    };
    const d1Databases: Record<string, string> = {};
    for (let index = 0; index < POOL_SIZE; index += 1) {
      d1Databases[`DB${index}`] = `pes-d1-smoke-${index}`;
    }
    // 저장소를 만들지 않는다(persist 옵션 없음 = 메모리). 계정·네트워크 접근 없음.
    miniflare = new mod.Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases,
    });
  });

  after(async () => {
    await miniflare?.dispose();
    miniflare = undefined;
  });

  scenarios("d1");

  describe("d1_smoke 도구 함수", () => {
    test("split_sql: 문자열·주석 안의 ';' 에서 자르지 않고 빈 조각은 버린다", () => {
      const parts = split_sql(
        [
          "CREATE TABLE t (",
          "  a TEXT, -- 주석; 안의 세미콜론",
          "  b TEXT /* 블록; 주석 */",
          ");",
          "",
          "INSERT INTO t VALUES ('x;y', 'z');",
          "-- 끝 주석만 있는 조각;",
          ";",
        ].join("\n"),
      );
      assert.equal(parts.length, 2);
      assert.match(parts[0], /^CREATE TABLE t/);
      assert.ok(parts[1].includes("'x;y'"));
      for (const part of parts) assert.ok(!part.trim().endsWith(";"));
    });

    test("split_sql: 실제 001 마이그레이션이 CREATE 문 수만큼 나뉜다", () => {
      const parts = split_sql(MIGRATION_001);
      const creates = parts.filter((part) => /^CREATE\s/i.test(part.replace(/^(\s*--.*\n)+/g, "").trim()));
      assert.ok(parts.length >= 61, `문장 ${parts.length}개`);
      assert.ok(creates.length >= 61, `CREATE ${creates.length}개`);
    });

    test("apply_migrations: 중간 문장이 실패하면 앞서 만든 표도 남지 않는다", async () => {
      const d1 = await next_d1();
      await assert.rejects(
        apply_migrations(
          d1,
          "CREATE TABLE keep_me (id TEXT PRIMARY KEY);\nCREATE TABLE keep_me (id TEXT PRIMARY KEY);",
        ),
      );
      const { results } = await d1
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'keep_me'")
        .all();
      assert.equal(results.length, 0);
    });

    test("apply_migrations: 여러 줄·주석·문자열 안의 ';' 가 있는 SQL 을 적용한다", async () => {
      const d1 = await next_d1();
      const result = await apply_migrations(
        d1,
        [
          "-- 주석; 세미콜론",
          "CREATE TABLE t (",
          "  id TEXT PRIMARY KEY,",
          "  v TEXT NOT NULL",
          ");",
          "INSERT INTO t VALUES ('a', 'x;y');",
        ].join("\n"),
      );
      assert.equal(result.statements, 2);
      const { results } = await d1.prepare("SELECT v FROM t WHERE id = 'a'").all();
      assert.equal(results[0]?.v, "x;y");
    });

    test("apply_migrations: 빈 SQL 은 아무것도 하지 않는다", async () => {
      const d1 = await next_d1();
      assert.deepEqual(await apply_migrations(d1, "  \n-- 주석뿐\n"), { statements: 0 });
    });

    test("run_batch: 빈 배열은 { changes: [] }", async () => {
      const d1 = await next_d1();
      assert.deepEqual(await run_batch(d1, []), { changes: [] });
    });

    test("run_batch: bigint 파라미터는 아무것도 실행하기 전에 TypeError", async () => {
      const d1 = await next_d1();
      await apply_migrations(d1, MIGRATION_001);
      await assert.rejects(
        run_batch(d1, [
          user("u1"),
          { sql: USER_SQL, params: ["u2", 9007199254740993n as unknown as string] },
        ]),
        TypeError,
      );
      const { results } = await d1.prepare("SELECT count(*) AS n FROM users").all();
      assert.equal(Number(results[0]?.n), 0);
    });

    test("0행은 ZeroRowsError 클래스로 보고된다", async () => {
      const d1 = await next_d1();
      await apply_migrations(d1, MIGRATION_001);
      await assert.rejects(
        run_batch(d1, [
          { sql: "UPDATE users SET display_name = ? WHERE id = ?", params: ["x", "none"], require_change: true },
        ]),
        (error: unknown) => error instanceof ZeroRowsError && error instanceof Error,
      );
    });

    test("assert_changed: 0 이면 ZeroRowsError, 1 이상이면 통과", () => {
      assert.doesNotThrow(() => assert_changed(1, "update users"));
      assert.doesNotThrow(() => assert_changed(7, "update users"));
      assert.throws(() => assert_changed(0, "update users"), (error: unknown) => {
        return error instanceof ZeroRowsError && error.name === "ZeroRowsError" && /update users/.test(error.message);
      });
    });
  });
});

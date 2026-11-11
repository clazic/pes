// SEL-73 (stage 2 PR26d) 시험 공용 준비물: 설계 검사 `scripts/check_ddl.ts`(TS)를 DDL 초안과 아래 변이로 돌려 고정한 0.15 결과(옛 Python
// `docs/plan/schemas/check_ddl.py` 가 낸 줄·실패 문장 — SEL-74 로 그 파일은 저장소에서 사라졌다)와 견준다. 전부 합성 입력.
//
// 격리: 검사기는 `:memory:` 만 쓰지만, 규칙대로 자식 프로세스에는 임시 HOME·USERPROFILE·PES_HOME 만
// 넘기고 process.env 는 바꾸지 않는다. 변이 DDL 은 임시 폴더에 쓴다(저장소의 DDL 은 절대 고치지 않는다).
//
// Windows 점검표: Node 자식은 UTF-8 stdout, 출력 CRLF→LF, 경로는 node:path 로만, `which` 를 쓰지 않는다.
//
// 인터페이스(요구사항에 이름이 없어 여기서 정한다 — worker 는 이대로 만든다):
//   scripts/check_ddl.ts
//     CLI : `node scripts/check_ddl.ts [--ddl <sql 파일>]`
//           --ddl 이 없으면 docs/plan/schemas/stage-1-ddl-draft.sql(스크립트 위치 기준 ../docs/plan/schemas/…).
//           통과: 표준출력에 check_ddl.py 와 같은 줄(첫 줄의 SQLite 버전만 다를 수 있음)을 내고 종료 코드 0.
//           실패: 종료 코드 != 0, 실패 메시지(= check_ddl.py 의 AssertionError/SQLite 오류와 같은 문장)를 표준오류에(표준출력에 둬도 됨)
//                 낸다. 규칙 위반이 Node 의 처리되지 않은 예외 모양(스택 덤프)일 필요는 없다.
//     모듈: `run_ddl_checks(options?: { ddl_path?: string }): DdlCheckResult` — 규칙 위반을 던지지 않고 ok=false + error 로 돌려준다.
//           import 만으로 검사를 돌리지 않는다(CLI 실행은 import.meta.main 일 때만).
//   npm run check:ddl  ==  node scripts/check_ddl.ts

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isolated_home, type IsolatedHome } from "./isolated_home.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..");
export const SCHEMAS = join(REPO, "docs", "plan", "schemas");
export const DDL_SQL = join(SCHEMAS, "stage-1-ddl-draft.sql");
export const CHECK_TS = join(REPO, "scripts", "check_ddl.ts");

export interface DdlCheckResult {
  ok: boolean;
  /** 표준출력과 같은 줄들(줄바꿈 없음). 실패하면 실패 전까지의 PASS 줄. */
  lines: string[];
  rejected_cases: number;
  representative_queries: number;
  /** 적재한 설계 표 수. */
  table_count: number;
  /** ok=false 일 때 실패 메시지. */
  error?: string;
}

export interface DdlChecker {
  run_ddl_checks(options?: { ddl_path?: string }): DdlCheckResult;
}

/** scripts/check_ddl.ts 를 동적으로 불러온다(아직 없을 때 파일 전체가 아니라 시험 하나씩 실패하게). */
export async function checker(): Promise<DdlChecker> {
  const path = "../../scripts/check_ddl.ts";
  return (await import(path)) as DdlChecker;
}

export interface RunOut {
  status: number | null;
  stdout: string;
  stderr: string;
  /** stdout + stderr, LF 정규화 */
  all: string;
}

export function lf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function read_lf(path: string): string {
  return lf(readFileSync(path, "utf8"));
}

function child_env(home: IsolatedHome): NodeJS.ProcessEnv {
  return { ...home.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", NODE_NO_WARNINGS: "1" } as NodeJS.ProcessEnv;
}

function pack(result: ReturnType<typeof spawnSync>): RunOut {
  const stdout = lf(String(result.stdout ?? ""));
  const stderr = lf(String(result.stderr ?? ""));
  return { status: result.status, stdout, stderr, all: `${stdout}${stderr}` };
}

export interface DdlWork {
  home: IsolatedHome;
  /** 임시 폴더: 변이 DDL(stage-1-ddl-draft.sql). */
  dir: string;
  /** 이 폴더의 SQL 을 바꿔 쓴다. */
  write_sql(sql: string): string;
  run_ts(): RunOut;
  /** CLI 인자를 직접 정해서 TS 검사기를 돌린다. */
  run_ts_with(args: string[]): RunOut;
  cleanup(): void;
}

export function make_work(): DdlWork {
  const home = isolated_home("pes-sel73-ddl-");
  const dir = mkdtempSync(join(tmpdir(), "pes-sel73-ddlwork-"));
  mkdirSync(dir, { recursive: true });
  const sql_path = join(dir, "stage-1-ddl-draft.sql");
  copyFileSync(DDL_SQL, sql_path);
  return {
    home,
    dir,
    write_sql(sql: string): string {
      writeFileSync(sql_path, sql, "utf8");
      return sql_path;
    },
    run_ts(): RunOut {
      return pack(
        spawnSync(process.execPath, [CHECK_TS, "--ddl", sql_path], {
          env: child_env(home),
          cwd: dir,
          encoding: "utf8",
          timeout: 120_000,
        }),
      );
    },
    run_ts_with(args: string[]): RunOut {
      return pack(
        spawnSync(process.execPath, [CHECK_TS, ...args], {
          env: child_env(home),
          cwd: dir,
          encoding: "utf8",
          timeout: 120_000,
        }),
      );
    },
    cleanup(): void {
      home.cleanup();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

export async function with_work(fn: (work: DdlWork) => Promise<void> | void): Promise<void> {
  const work = make_work();
  try {
    await fn(work);
  } finally {
    work.cleanup();
  }
}

/** 저장소 DDL 을 CLI 기본 경로(--ddl 없이)로 돌린다. */
export function run_ts_default(home: IsolatedHome): RunOut {
  return pack(
    spawnSync(process.execPath, [CHECK_TS], { env: child_env(home), cwd: REPO, encoding: "utf8", timeout: 120_000 }),
  );
}

// ---------------------------------------------------------------------------
// 변이 사례: 깨진 DDL. 각 규칙이 실제로 실패를 내는지 본다.
//
// `expect` 는 옛 check_ddl.py 가 이 변이에서 낸 실패 메시지가 품은 문장이다(0.15 에서 확인해 고정했다). TS 검사기도 같은 문장을 내야 한다.

/** The lines the 0.15 check_ddl.py printed on the repository DDL (after the SQLite version line) — frozen when the Python file still existed. */
export const PY_REFERENCE_LINES: readonly string[] = [
  "PASS DDL execution; no triggers or external databases",
  "PASS synthetic hierarchy: 2 projects, 12 stages, all 61 tables populated",
  "PASS allowed cases: inactive edition, duplicate URL sources, uncertain legacy approval, Go initialized ON",
  "PASS constraints: 62 invalid/reference/cross-project/duplicate writes rejected",
  "PASS partial UNIQUE: second active edition and second open round rejected",
  "PASS representative queries: hierarchy, historical answer + comment, scoped change cursor (indexed)",
  "PASS zero-row CAS: explicit failure; version, payload, pointer, event, receipt all rolled back",
  "PASS late SQL failure: successful CAS and all other writes rolled back",
  "PASS successful command: new version + pointer + event + idempotency receipt committed; old version retained",
  "PASS SQL guard examples: stale fence and synthetic Go OFF rejected (SQLite only)",
  "PASS foreign_key_check and integrity_check",
  "RESULT PASS; rejected cases=64; representative queries=3",
  "D1 NOT TESTED: batch/guard, deferred FKs, partial indexes, JSON functions, migrations, runtime limits",
];

export interface Mutation {
  name: string;
  /** 어느 규칙을 건드리나 */
  rule: string;
  apply(sql: string): string;
  expect: string;
}

function replace_once(sql: string, pattern: RegExp, replacement: string): string {
  assert_matches(sql, pattern);
  return sql.replace(pattern, replacement);
}

function assert_matches(sql: string, pattern: RegExp): void {
  if (!pattern.test(sql)) throw new Error(`mutation pattern not found in the DDL draft: ${pattern}`);
}

export const MUTATIONS: Mutation[] = [
  {
    name: "append-trigger",
    rule: "no triggers",
    apply: (sql) => `${sql}\nCREATE TRIGGER synthetic_trg AFTER INSERT ON users BEGIN SELECT 1; END;\n`,
    expect: "Triggers forbidden",
  },
  {
    name: "attach-second-database",
    rule: "only in-memory main database",
    apply: (sql) => `${sql}\nATTACH DATABASE ':memory:' AS synthetic_other;\n`,
    expect: "Only the in-memory main database may be connected",
  },
  {
    name: "extra-unpopulated-table",
    rule: "every design table receives a synthetic row",
    apply: (sql) => `${sql}\nCREATE TABLE synthetic_unpopulated (id TEXT PRIMARY KEY);\n`,
    expect: "Every design table must receive at least one synthetic row",
  },
  {
    name: "ddl-syntax-error",
    rule: "DDL executes",
    apply: (sql) => `${sql}\nCREATE TABL synthetic_oops (id TEXT);\n`,
    expect: "syntax error",
  },
  {
    name: "drop-stage-ordinal-check",
    rule: "rejected: wrong stage ordinal",
    apply: (sql) => replace_once(sql, /CHECK \(\(key = 'plan' AND ordinal = 1\)[\s\S]*?ordinal = 6\)\),\n/, ""),
    expect: "wrong stage ordinal: invalid write was accepted",
  },
  {
    name: "drop-policy-boolean-check",
    rule: "rejected: invalid policy boolean",
    apply: (sql) => replace_once(sql, / CHECK \(allow_opencode_go IN \(0,1\)\)/, ""),
    expect: "invalid policy boolean: invalid write was accepted",
  },
  {
    name: "drop-json-valid-stats",
    rule: "rejected: invalid JSON",
    apply: (sql) => replace_once(sql, / CHECK \(json_valid\(stats\)\)/, ""),
    expect: "invalid JSON: invalid write was accepted",
  },
  {
    name: "drop-one-active-edition-index",
    rule: "partial UNIQUE: two active editions",
    apply: (sql) => replace_once(sql, /CREATE UNIQUE INDEX one_active_edition ON [^;]*;\n/, ""),
    expect: "two active editions: invalid write was accepted",
  },
  {
    name: "drop-one-open-round-index",
    rule: "partial UNIQUE: two open rounds",
    apply: (sql) => replace_once(sql, /CREATE UNIQUE INDEX one_open_round ON [^;]*;\n/, ""),
    expect: "two open rounds: invalid write was accepted",
  },
  {
    name: "drop-display-no-unique",
    rule: "rejected: duplicate display number",
    apply: (sql) => replace_once(sql, /    UNIQUE \(project_id, kind, display_no\),\n/, ""),
    expect: "duplicate display number: invalid write was accepted",
  },
  {
    name: "drop-dispatch-response-check",
    rule: "rejected: dispatch response without hash",
    apply: (sql) => replace_once(sql, /    CHECK \(state <> 'response' OR response_hash IS NOT NULL\),\n/, ""),
    expect: "dispatch response without hash: invalid write was accepted",
  },
  {
    name: "drop-edition-parent-fk",
    rule: "rejected: foreign edition parent (cross-project reference)",
    apply: (sql) =>
      replace_once(
        sql,
        /    FOREIGN KEY \(project_id, parent_edition_id\) REFERENCES editions\(project_id, id\) ON DELETE RESTRICT,\n/,
        "",
      ),
    expect: "foreign edition parent: invalid write was accepted",
  },
  {
    name: "drop-guard-ok-check",
    rule: "late SQL failure rolls back (guard CHECK)",
    apply: (sql) => replace_once(sql, / CHECK \(guard_ok = 1\)/, ""),
    expect: "Guard failure was not raised",
  },
  {
    name: "drop-idempotency-unique",
    rule: "rejected: duplicate idempotency key",
    apply: (sql) => replace_once(sql, /    UNIQUE \(project_id, actor_id, client_request_id\),\n/, ""),
    expect: "duplicate idempotency key: invalid write was accepted",
  },
];

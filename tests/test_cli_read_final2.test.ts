/**
 * SEL-49 PR16 — Codex 최종 2/2 회귀 시험 (tester). 구현 전에는 실패하는 것이 정상이다. 자료는 모두 합성, HOME·USERPROFILE·PES_HOME 은 임시 폴더.
 *        안내는 두 경우를 함께 말한다: "다른 PES 가 실행 중이거나 비정상 종료 흔적 — 다른 PES 를 끈 뒤 다시 실행, 그래도 남으면 doctor --fix"
 *        (WAL 모드에서는 다른 PES 가 정상 실행 중에도 -wal 이 비어 있지 않다). 0바이트 -wal 은 정상: DB 를 열고 기존 진단을 한다.
 *   F1b  비정상 종료(SIGKILL)로 pes.db-wal 이나 hot pes.db-journal 이 남은 DB: 기본 doctor(플래그 켜짐; --json 포함, 전체·프로젝트별)는
 *        DB 를 열지 않는다 — pes.db·-wal·-shm·-journal 의 바이트·mtime·존재가 그대로이고, "데이터베이스" 그룹에
 *        '비정상 종료 흔적 — 복구 필요' 류 행(warn 또는 bad, 복구 안내 포함)만 낸다. bad 이면 종료 1, warn 이면 0(8.13 doctor 규칙).
 *        --fix 와 다른 명령은 SQLite 자동 복구를 허용하므로 여기서 단언하지 않는다.
 *   정상 상태(곁가지 없음)는 test_cli_read_final1.test.ts 의 F1 이 그대로 지킨다.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import { make_cli_env, SLUG, type CliEnv } from "./helpers/cli_write_env.ts";
import { run_cli } from "./helpers/cli_read_env.ts";
import { sha256_of } from "./helpers/legacy_env.ts";

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = lstatSync(full);
      const rel = relative(root, full).split("\\").join("/");
      if (st.isDirectory()) {
        out[rel] = "dir";
        walk(full);
      } else {
        out[rel] = `${st.size}:${st.mtimeMs}:${sha256_of(readFileSync(full))}`;
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** 별도 프로세스가 DB 를 열어 쓰다가 SIGKILL 로 죽는다 — SQLite 가 정리할 기회가 없다. */
function killed_writer(c: CliEnv, script: string): void {
  const res = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script, c.env.db.path], { env: c.env.home.env as NodeJS.ProcessEnv, encoding: "utf8" });
  assert.ok(res.signal === "SIGKILL" || res.status !== 0, `쓰기 프로세스가 강제 종료됐다 (signal=${res.signal} status=${res.status} ${res.stderr})`);
}

const WAL_WRITER = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1]);
db.exec("CREATE TABLE IF NOT EXISTS synthetic_pad (x TEXT)");
db.exec("INSERT INTO synthetic_pad VALUES ('committed row that stays only in the WAL')");
process.kill(process.pid, "SIGKILL");
`;

const JOURNAL_WRITER = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1]);
db.exec("PRAGMA journal_mode = DELETE");
db.exec("CREATE TABLE IF NOT EXISTS synthetic_pad (x TEXT)");
db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000) INSERT INTO synthetic_pad SELECT printf('%0500d', i) FROM n");
db.exec("PRAGMA cache_size = 10");
db.exec("BEGIN");
db.exec("UPDATE synthetic_pad SET x = x || 'changed'");
process.kill(process.pid, "SIGKILL");
`;

interface Row {
  group: string;
  level: "ok" | "info" | "warn" | "bad";
  title: string;
  detail: string;
}

const WORDS = /비정상 종료/;
/** 두 경우를 함께 안내한다: 다른 PES(serve.py 등)가 실행 중일 수도 있고, 비정상 종료 흔적일 수도 있다. */
const BOTH_CASES = (text: string) => /다른 PES/.test(text) && /비정상 종료/.test(text) && /--fix/.test(text);

for (const kind of ["wal", "journal"] as const) {
  test(`F1b (${kind}) 강제 종료로 ${kind === "wal" ? "pes.db-wal" : "hot pes.db-journal"} 이 남은 DB: 기본 doctor 4가지 호출은 DB 를 열지 않고 '복구 필요' 행만 낸다`, async () => {
    const c = await make_cli_env();
    try {
      const dot_pes = join(c.env.home.root, "home", ".pes");
      c.env.db.close();
      killed_writer(c, kind === "wal" ? WAL_WRITER : JOURNAL_WRITER);
      const before = snapshot(dot_pes);
      const sidecar = kind === "wal" ? "pes.db-wal" : "pes.db-journal";
      assert.ok(before[sidecar] !== undefined && !before[sidecar]!.startsWith("0:"), `시작 상태: 비어 있지 않은 ${sidecar} 가 남아 있다 (${Object.keys(before)})`);
      for (const args of [["doctor", "--json"], ["doctor"], ["doctor", SLUG, "--json"], ["doctor", SLUG]]) {
        const label = args.join(" ");
        const res = run_cli(c, args);
        assert.doesNotMatch(res.stderr, /Traceback/, label);
        assert.deepEqual(snapshot(dot_pes), before, `${label}: pes.db·-wal·-shm·-journal 의 존재·바이트·mtime 이 그대로 (DB 를 열어 복구하지 않았다)`);
        if (args.includes("--json")) {
          const rows = JSON.parse(res.stdout) as Row[];
          const hit = rows.find((r) => r.group === "데이터베이스" && WORDS.test(`${r.title} ${r.detail}`));
          assert.ok(hit, `${label}: '비정상 종료 흔적 — 복구 필요' 행: ${JSON.stringify(rows.filter((r) => r.group === "데이터베이스"))}`);
          assert.ok(hit.level === "warn" || hit.level === "bad", `${label}: warn 또는 bad (정상 행이 아님): ${hit.level}`);
          assert.ok(BOTH_CASES(`${hit.title} ${hit.detail}`), `${label}: '다른 PES 실행 중' 과 '비정상 종료 흔적' 을 함께, --fix 안내까지: ${hit.title} / ${hit.detail}`);
          assert.ok(!rows.some((r) => r.group === "데이터베이스" && r.level === "ok"), `${label}: DB 가 정상이라는 행을 내지 않는다`);
          if (hit.level === "bad") assert.equal(res.status, 1, `${label}: 문제 행이면 --json 도 종료 1`);
          else assert.equal(res.status, 0, `${label}: 주의 행만이면 종료 0`);
        } else {
          assert.ok(BOTH_CASES(res.stdout), `${label}: 사람이 읽는 출력에도 같은 안내`);
          assert.match(res.stdout, /\[(주의|문제)\]/, label);
        }
      }
    } finally {
      c.env.home.cleanup();
    }
  });
}

test("F1c 0바이트 pes.db-wal 은 남은 흔적이 아니다: doctor 는 DB 를 열어 기존 진단('데이터베이스' 정상 행)을 한다", async () => {
  const c = await make_cli_env();
  try {
    const dot_pes = join(c.env.home.root, "home", ".pes");
    c.env.db.close();
    writeFileSync(join(dot_pes, "pes.db-wal"), "");
    const db_before = sha256_of(readFileSync(join(dot_pes, "pes.db")));
    for (const args of [["doctor", "--json"], ["doctor", SLUG, "--json"]]) {
      const res = run_cli(c, args);
      assert.doesNotMatch(res.stderr, /Traceback/);
      const rows = JSON.parse(res.stdout) as Row[];
      const db_rows = rows.filter((r) => r.group === "데이터베이스");
      if (!args.includes(SLUG)) assert.ok(db_rows.some((r) => r.level === "ok"), `${args.join(" ")}: 정상 행: ${JSON.stringify(db_rows)}`);
      else assert.ok(rows.some((r) => r.group === SLUG && r.level === "ok"), `${args.join(" ")}: 프로젝트 진단이 DB 에서 정상으로 읽힌다: ${JSON.stringify(rows.filter((r) => r.group === SLUG))}`);
      assert.ok(!db_rows.some((r) => BOTH_CASES(`${r.title} ${r.detail}`) || WORDS.test(`${r.title} ${r.detail}`)), "남은 흔적 경고가 없다");
      assert.equal(sha256_of(readFileSync(join(dot_pes, "pes.db"))), db_before, "pes.db 바이트 불변");
    }
  } finally {
    c.env.home.cleanup();
  }
});

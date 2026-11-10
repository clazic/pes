/**
 * SEL-50 PR17 — `pes set` 와 PES_DB_CORE=1 (tester, 작성 모드). 허용·거부 계약은 test_cli_set_accept/reject (플래그 없음).
 *
 * leader 결정: 플래그가 켜지면 코어에 대응 명령이 있으면 그것으로 쓰고, 없으면 분명한 한국어 거부 + 0 아닌 종료 + DB 불변이다.
 * 어느 쪽인지는 구현이 정한다(코어 명령을 더하면 EXPECTED_COMMAND_NAMES 도 구현 PR 이 함께 바꾼다). 그래서 이 시험은 **두 길 모두에서 지켜야 할 것**을 고정한다.
 *
 * 해석 11 (두 길 공통)
 *   (가) 거부하면: 0 아닌 종료 + 한국어 설명 + 스택 추적 없음 + DB 전체(state_signature)·legacy project.json 바이트·프로젝트 폴더 파일이 불변.
 *   (나) 받아들이면: 영수증(mutation_commits)이 늘고, 옛 project.json 은 바이트·mtime 이 그대로(직접 쓰기 0)이고, DB 에서 만든 단계 보고서(report 명령)에
 *        그 값이 나타난다.
 *   (다) 어느 길이든 화이트리스트와 형식 검사는 그대로다: 모르는 필드·잘못된 JSON·모양이 틀린 JSON 은 DB 에 아무것도 남기지 않는다.
 *   (라) 이 컴퓨터 DB 가 서비스하지 않는 옛 폴더(import 전)는 다른 쓰기 명령처럼 거부한다(`쓸 수 없습니다`), 파일 불변.
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { disk_path } from "./helpers/blob_env.ts";
import { SLUG, with_cli, type CliEnv, type CliResult } from "./helpers/cli_write_env.ts";
import { ok, run_py, seed, write_legacy, plain_json_legacy } from "./helpers/cli_read_env.ts";
import { expect_refused } from "./helpers/set_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const ON = { flag: "1" } as const;

function set_args(c: CliEnv, target: string, field: string, text: string, name = `v-${target}-${field}.txt`): string[] {
  const file = join(c.env.home.root, name);
  writeFileSync(file, text, "utf8");
  return ["set", SLUG, target, field, file];
}

/** DB 에서 만든 단계 보고서 마크다운(가장 최근 버전의 report.md). */
function db_report_md(c: CliEnv): string {
  const obj = c.env.db.get<{ object_id: string }>(
    "SELECT object_id FROM artifacts WHERE project_id = ? AND kind = 'report' AND stage_id = ? ORDER BY rowid",
    c.env.p.project_id,
    c.stages.plan,
  );
  assert.ok(obj, "단계 보고서 artifact");
  const ver = c.env.db.get<{ id: string }>("SELECT id FROM object_versions WHERE object_id = ? ORDER BY version_no DESC", obj.object_id);
  assert.ok(ver, "보고서 버전");
  const blob = c.env.db.get<{ storage_key: string }>(
    `SELECT b.storage_key FROM version_files vf JOIN blobs b ON b.project_id = vf.project_id AND b.id = vf.blob_id
      WHERE vf.version_id = ? AND b.original_name = 'report.md'`,
    ver.id,
  );
  assert.ok(blob, "report.md blob");
  return readFileSync(disk_path(c.env, blob), "utf8").replace(/\r\n/g, "\n");
}

function snapshot(c: CliEnv) {
  return { db: state_signature(c.env.db), json: c.sig(c.project_json), listing: c.listing(c.folder), commits: c.commits().length };
}

function same_state(c: CliEnv, before: ReturnType<typeof snapshot>, what: string): void {
  const now = snapshot(c);
  assert.equal(now.db, before.db, `${what}: DB 전체가 그대로다`);
  assert.deepEqual(now.json, before.json, `${what}: project.json 바이트·mtime 이 그대로다`);
  assert.deepEqual(now.listing, before.listing, `${what}: 프로젝트 폴더가 그대로다`);
  assert.equal(now.commits, before.commits, `${what}: 영수증이 늘지 않는다`);
}

test("플래그 켜짐: set 은 코어로 쓰거나 분명히 거부한다 — 어느 쪽이든 직접 쓰기 0 (해석 11 가·나)", () =>
  with_cli(async (c) => {
    seed(c, "1");
    const cases: Array<{ target: string; field: string; text: string; shows: string }> = [
      { target: "plan", field: "summary", text: "플래그 켜짐 기획 요약 한 줄", shows: "플래그 켜짐 기획 요약 한 줄" },
      { target: "plan", field: "carry_over", text: JSON.stringify([{ item: 2, title: "합성 이월 항목", request: "원문을 확인한다", from: "plan" }]), shows: "합성 이월 항목" },
    ];
    let accepted = 0;
    for (const k of cases) {
      const before = snapshot(c);
      const res = run_py(c, set_args(c, k.target, k.field, k.text), ON);
      if (res.status === 0) {
        accepted += 1;
        assert.doesNotMatch(res.stderr, /Traceback/);
        const now = snapshot(c);
        assert.ok(now.commits > before.commits, `${k.field}: 받아들였으면 영수증이 남는다`);
        assert.deepEqual(now.json, before.json, `${k.field}: 옛 project.json 에는 쓰지 않는다 (바이트·mtime)`);
        assert.deepEqual(now.listing, before.listing, `${k.field}: 프로젝트 폴더에 새 파일이 없다`);
        ok(run_py(c, ["report", SLUG, "plan"], ON), "report");
        assert.ok(db_report_md(c).includes(k.shows), `${k.field}: DB 보고서에 값이 나타난다`);
      } else {
        expect_refused(res, `${k.field} (플래그 켜짐 거부)`);
        same_state(c, before, `${k.field} (거부)`);
      }
    }
    // 한 필드만 받고 한 필드는 거부하는 어정쩡한 상태는 허용하지 않는다 — 같은 명령의 같은 경로다
    assert.ok(accepted === 0 || accepted === cases.length, `두 필드가 같은 길을 간다 (받은 수 ${accepted}/${cases.length})`);
  }));

test("플래그 켜짐: project 대상(executive_summary·conclusion)도 같은 규칙이다", () =>
  with_cli(async (c) => {
    seed(c, "1");
    for (const field of ["executive_summary", "conclusion"]) {
      const before = snapshot(c);
      const res = run_py(c, set_args(c, "project", field, `켜짐 ${field} 한 줄`), ON);
      if (res.status === 0) {
        assert.ok(snapshot(c).commits > before.commits, `${field}: 영수증`);
        assert.deepEqual(snapshot(c).json, before.json, `${field}: 옛 project.json 불변`);
      } else {
        expect_refused(res, `${field} (거부)`);
        same_state(c, before, field);
      }
    }
  }));

test("플래그 켜짐: 모르는 필드·잘못된 JSON·틀린 모양은 어느 길이든 DB 에 아무것도 남기지 않는다 (해석 11 다)", () =>
  with_cli(async (c) => {
    seed(c, "1");
    const bad: Array<[string, string[]]> = [
      ["items", set_args(c, "plan", "items", "[]")],
      ["status", set_args(c, "plan", "status", "approved")],
      ["approved_at", set_args(c, "plan", "approved_at", "2026-01-01")],
      ["project topic", set_args(c, "project", "topic", "바뀐 주제")],
      ["project summary", set_args(c, "project", "summary", "x")],
      ["모르는 단계", set_args(c, "foo", "summary", "x")],
      ["잘못된 JSON", set_args(c, "plan", "carry_over", "{bad")],
      ["틀린 모양", set_args(c, "plan", "changes", '{"a": 1}')],
      ["값 파일 없음", ["set", SLUG, "plan", "summary", join(c.env.home.root, "없는-파일.txt")]],
    ];
    for (const [what, args] of bad) {
      const before = snapshot(c);
      expect_refused(run_py(c, args, ON), what);
      same_state(c, before, what);
    }
  }));

test("플래그 켜짐: DB 가 서비스하지 않는 옛 폴더에는 set 도 쓰지 않는다 (해석 11 라)", () =>
  with_cli(async (c) => {
    const legacy_slug = "legacy-only-set";
    const folder = join(c.env.home.env.PES_HOME as string, legacy_slug);
    const file = write_legacy(folder, plain_json_legacy(legacy_slug));
    const bytes = readFileSync(file, "utf8");
    const before = snapshot(c);
    const value = join(c.env.home.root, "legacy-v.txt");
    writeFileSync(value, "옛 폴더 요약", "utf8");
    const res: CliResult = run_py(c, ["set", legacy_slug, "plan", "summary", value], ON);
    expect_refused(res, "legacy 폴더");
    assert.equal(readFileSync(file, "utf8"), bytes, "옛 project.json 은 그대로");
    same_state(c, before, "legacy 폴더");
  }));

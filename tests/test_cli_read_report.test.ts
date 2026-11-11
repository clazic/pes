/**
 * SEL-49 PR16 — CLI 읽기·보고서·doctor — 보고서·assemble·web (tester). 원래 tests/test_cli_read.test.ts 하나였고 Windows CI 조각 상한(10분) 때문에 주제별로 나눴다. 해석 번호는 test_cli_read_v015.test.ts 머리말 참고. 구현 전이므로 새 시험은 실패하는 것이 정상이다.
 *
 * 시험 방식은 PR15와 같다: `node scripts/pes.ts ...`를 subprocess로 실행하고 (SEL-74: 0.15 Python 은 없다) HOME·USERPROFILE·PES_HOME은
 * 모두 임시 폴더다(tests/helpers/cli_write_env.ts 의 하니스 + cli_read_env.ts). 자료는 모두 합성이다.
 * 개발 플래그 PES_DB_CORE=1 일 때만 DB 읽기 경로가 켜진다. 플래그가 없으면 v0.15 출력·종료 코드·파일이 그대로다.
 *
 * 이 시험이 고정하는 해석(보고서의 '해석 n'과 번호가 같다):
 *   해석 1  읽기가 DB를 쓰는지는 PR12 `serving_path`와 같다: 프로젝트가 DB에 있고 active 이면 DB, 그 밖(DB에 없음·staging·
 *           failed·archived)은 project.json 을 읽는 legacy 다. legacy 읽기 출력은 v0.15 와 바이트가 같고 mtime 도 안 바뀐다.
 *   해석 2  v0.15 기준본은 03fc81b(PR15 머지 시점: 읽기 명령이 아직 project.json 만 읽는 main)의 `git archive`다.
 *   해석 3  DB `pending` 의 식별자는 옛 feedback 파일 이름 모양을 유지한다(이전해 온 답은 그 이름 그대로). 새로 생긴 답의 이름
 *           형식은 PR14 API 쪽 결정이라 여기서 고정하지 않는다.
 *   해석 4  `report <slug> <stage>`: 단계마다 artifact(kind 'report') 한 객체. 실행할 때마다 content.append_version 으로 새 버전을
 *           쌓고(덮어쓰기 없음), 렌더 파일 report.md·report.html 을 file.reserve_upload→complete_upload→attach_version(role
 *           'rendered')으로 붙인다. '정확한 버전' = 새 보고서 버전이 그때 쓴 항목들의 현재 버전을 derived_from 으로 가리킴.
 *           '각주' = 마크다운 「출처」 절 번호(처음 나온 순서·중복 제거, v0.15 와 같음).
 *   해석 5  새 코어 명령은 없다(EXPECTED_COMMAND_NAMES 불변). report/assemble/web 의 쓰기는 기존 content.*·file.* 명령만 지난다.
 *   해석 6  `assemble`/`web` 은 artifact(kind 'output') 한 객체에 새 버전을 쌓는다. 파일 이름은 report.md·sources.json·report.html.
 *           내용이 같은 재실행도 새 버전이다(leader 결정).
 *   해석 7  report/output artifact 는 render 봉인 목록과 approve plan 인계에 들어가지 않는다.
 *   해석 8  `watch` 는 같은 출력 형식(`tail -n0 -F <따옴표 처리한 경로>/feedback.log | grep --line-buffered FEEDBACK` 한 줄)을
 *           유지한다. 입력 long-poll 은 PR18 몫이라 여기서는 고정하지 않는다(이슈: '같은 출력 형식이나 long-poll').
 *   해석 9  doctor 의 `--json` 행은 {group, level, title, detail, fixable}. DB 상태 그룹은 "데이터베이스", 서버 그룹은 "서버"
 *           (점유 포트 행: 제목에 ":<포트>", 상세에 소유 프로세스 pid), 경로 quoting 경고는 그룹 "환경"·level "warn"·제목에
 *           "경로"와 (공백|따옴표|괄호|특수).
 *   해석 10 validate_import: 재생성 보고서가 옛 보고서와 다르면 문제(check "reports_regeneration", path)이고 ok=false.
 *           '작성 …' 시각 줄은 비교에서 무시한다. html 도 같은 규칙(시각 정규화 뒤 같아야 함). `regeneration_format` 은 더는
 *           "provisional" 이 아니다. 이 시험은 기존 S4b(provisional 단언)·'손으로 고친 보고서도 validated'·`full` 픽스처의
 *           손글씨 reports/plan/report.md 와 부딪친다 — 구현 PR 에서 그 시험·픽스처를 함께 바꿔야 한다(leader 결정).
 *   해석 11 DB 모드는 프로젝트 폴더 reports/·out/ 에 쓰지 않는다. 출력에 새 버전 id 와 파일 이름·blob id 를 보인다.
 *   해석 12 `hub`·`open` 은 서버·브라우저를 띄우므로 이 시험에서 실행하지 않는다.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { COMMANDS } from "../scripts/pes_core/commands.ts";
import { EXPECTED_COMMAND_NAMES } from "./helpers/command_names.ts";
import { disk_path } from "./helpers/blob_env.ts";
import { expect_rejected, make_cli_env, SLUG, with_cli, type CliEnv, type CliResult, LEGACY_JSON } from "./helpers/cli_write_env.ts";
import { normalize, ok, plain_legacy, folder_of, PLAN_ITEMS, WRITE_ITEMS, read_lf, rich_legacy, RICH_TOPIC, run_cli, seed, shell_words, write_json, write_legacy, write_pending_answer, type HomeLike } from "./helpers/cli_read_env.ts";
import { FIXTURES, legacy, tree_digest } from "./helpers/legacy_env.ts";
import { copy_fixture, has_problem, migration, with_migration, owner_of, pes_home_of, backup_dir_of, batch_row } from "./helpers/migration_env.ts";
import { isolated_home } from "./helpers/isolated_home.ts";
import { state_signature } from "./helpers/state_signature.ts";

// ---------------------------------------------------------------------------
// 4 · 보고서 (report): 새 버전·정확한 버전·각주·PR9 경계

interface Rendered {
  role: string;
  name: string | null;
  sha: string;
  state: string;
  text: string;
}

function report_object(c: CliEnv, kind: "report" | "output", stage: "plan" | null): string | undefined {
  const rows = c.env.db.all<{ object_id: string }>(
    "SELECT object_id FROM artifacts WHERE project_id = ? AND kind = ? AND (? IS NULL OR stage_id = ?) ORDER BY rowid",
    c.env.p.project_id,
    kind,
    stage === null ? null : c.stages[stage],
    stage === null ? null : c.stages[stage],
  );
  return rows[0]?.object_id;
}

function versions_of(c: CliEnv, object_id: string) {
  return c.env.db.all<{ id: string; version_no: bigint; content_hash: string }>(
    "SELECT id, version_no, content_hash FROM object_versions WHERE object_id = ? ORDER BY version_no",
    object_id,
  );
}

function rendered_of(c: CliEnv, version_id: string): Rendered[] {
  const rows = c.env.db.all<{ role: string; original_name: string | null; sha256: string; state: string; storage_key: string }>(
    `SELECT vf.role, b.original_name, b.sha256, b.state, b.storage_key
       FROM version_files vf JOIN blobs b ON b.project_id = vf.project_id AND b.id = vf.blob_id
      WHERE vf.version_id = ? ORDER BY b.original_name`,
    version_id,
  );
  return rows.map((r) => ({
    role: r.role,
    name: r.original_name,
    sha: r.sha256,
    state: r.state,
    text: readFileSync(disk_path(c.env, r), "utf8"),
  }));
}

function file_named(files: Rendered[], name: string): Rendered {
  const hit = files.find((f) => f.name === name);
  assert.ok(hit, `렌더 파일 ${name} (role rendered) 가 붙어 있다: [${files.map((f) => f.name)}]`);
  assert.equal(hit.role, "rendered");
  assert.equal(hit.state, "ready");
  return hit;
}

test("report: 실행마다 새 버전 — 옛 버전과 옛 파일은 그대로, 마크다운은 v0.15 형식·출처 번호가 정확하다", () =>
  with_cli(async (c) => {
    ok(run_cli(c, ["round-start", SLUG, "plan"]), "round-start");
    ok(run_cli(c, ["merge", SLUG, "plan", write_json(c, "r-items.json", PLAN_ITEMS)]), "merge");
    const json_sig = c.sig(c.project_json);

    const first = ok(run_cli(c, ["report", SLUG, "plan"]), "report 1");
    assert.match(first.stdout, /^기획보고서:/m, "옛 출력의 머리말 '<이름>:' 유지");
    const object_id = report_object(c, "report", "plan");
    assert.ok(object_id, "기획 단계의 보고서 artifact (kind report)");
    const v1 = versions_of(c, object_id);
    assert.equal(v1.length, 1);
    // (SEL-74: PR16 의 DB 모드 출력은 새 버전 id·blob id 를 보였지만, pes.ts 는 0.15 와 같은 출력 — '<이름>: 웹 보고서 …, 마크다운 …' — 을 낸다. 버전·파일은 DB 에서 확인한다.)
    assert.match(first.stdout, /reports\/plan\/report\.html/, `옛 출력의 경로: ${first.stdout}`);
    const files1 = rendered_of(c, v1[0]!.id);
    // 원본은 DB·객체 저장소다. pes.ts 는 0.15 호환으로 폴더의 reports/plan/ 에도 같은 파일을 둔다(D02) — 같은 내용이어야 한다.
    assert.equal(read_lf(join(c.folder, "reports", "plan", "report.md")), files1.find((f) => f.name === "report.md")?.text, "폴더의 report.md = DB 버전 1 의 report.md");
    const md1 = file_named(files1, "report.md");
    file_named(files1, "report.html");
    assert.match(md1.text, /^# 합성 파일 주제 — 기획보고서$/m);
    assert.match(md1.text, /^- 항목 2개 · 출처 2개 \(원문 확인 1개\)$/m);
    assert.match(md1.text, /^## 1\. 요약$/m);
    assert.match(md1.text, /^## 3\. 결과$/m);
    assert.match(md1.text, /^#### #1 합성 기획 항목 하나$/m);
    assert.match(md1.text, /^1\. 합성 출처 A — https:\/\/example\.invalid\/a \(2026-01-02\) \[확인됨\]$/m, "각주 1 = 처음 나온 출처");
    assert.match(md1.text, /^2\. 합성 출처 B — https:\/\/example\.invalid\/b \[미확인\]$/m, "각주 2");

    // 항목을 고쳐 새 출처를 더하고 다시 만든다
    ok(run_cli(c, ["merge", SLUG, "plan", write_json(c, "r-items2.json", [{ id: 1, sources: [{ title: "합성 출처 D", url: "https://example.invalid/d", method: "kosis" }] }])]), "merge 2");
    ok(run_cli(c, ["report", SLUG, "plan"]), "report 2");
    const v2 = versions_of(c, object_id);
    assert.equal(v2.length, 2, "덮어쓰지 않고 새 버전");
    assert.deepEqual(v2[0], v1[0], "버전 1 행은 그대로");
    assert.equal(report_object(c, "report", "plan"), object_id, "같은 객체 위에 쌓는다");
    const cur = c.env.db.get<{ current_version_id: string }>("SELECT current_version_id FROM objects WHERE id = ?", object_id);
    assert.equal(cur?.current_version_id, v2[1]!.id, "현재 버전 포인터는 새 버전");
    const old_files = rendered_of(c, v1[0]!.id);
    assert.equal(file_named(old_files, "report.md").sha, md1.sha, "버전 1 의 마크다운 파일은 그대로 읽힌다 (덮어쓰지 않음)");
    assert.doesNotMatch(md1.text, /합성 출처 D/);
    const md2 = file_named(rendered_of(c, v2[1]!.id), "report.md");
    assert.notEqual(md2.sha, md1.sha);
    assert.match(md2.text, /^- 항목 2개 · 출처 3개 \(원문 확인 2개\)$/m);
    assert.match(md2.text, /^3\. 합성 출처 D — https:\/\/example\.invalid\/d \[확인됨\]$/m, "새 출처는 번호 3");

    // 정확한 버전: 새 보고서 버전은 그때 쓴 항목들의 현재 버전을 가리킨다 (옛 버전은 옛 항목 버전)
    const item_versions = (n: 1 | 2) =>
      c.env.db.all<{ id: string }>(
        `SELECT cur.current_version_id AS id FROM artifacts a JOIN objects cur ON cur.id = a.object_id
          WHERE a.project_id = ? AND a.stage_id = ? AND a.kind = 'topic' AND cur.display_no = ?`,
        c.env.p.project_id,
        c.stages.plan,
        BigInt(n),
      );
    const derived = (version_id: string) =>
      c.env.db.all<{ to_version_id: string }>("SELECT to_version_id FROM version_relations WHERE from_version_id = ? AND kind = 'derived_from'", version_id).map((r) => r.to_version_id);
    const used2 = derived(v2[1]!.id);
    assert.ok(used2.includes(item_versions(1)[0]!.id), "버전 2 는 항목 1 의 현재(두 번째) 버전을 근거로 든다");
    const first_item_versions = c.env.db.all<{ id: string }>(
      "SELECT ov.id FROM object_versions ov JOIN artifacts a ON a.object_id = ov.object_id WHERE a.kind = 'topic' AND ov.version_no = 1 AND a.stage_id = ?",
      c.stages.plan,
    );
    const used1 = derived(v1[0]!.id);
    assert.ok(used1.length >= 2 && used1.every((id) => first_item_versions.some((f) => f.id === id)), "버전 1 은 항목들의 첫 버전을 근거로 든다 (나중 수정에 끌려가지 않음)");
    assert.deepEqual(c.sig(c.project_json), json_sig, "옛 project.json 은 건드리지 않는다");
  }));

test("report: 쓰기는 PR9 경계(content.append_version 과 file.reserve_upload·complete_upload·attach_version)만 지나고 via 는 cli 다", () =>
  with_cli(async (c) => {
    ok(run_cli(c, ["round-start", SLUG, "plan"]), "round-start");
    ok(run_cli(c, ["merge", SLUG, "plan", write_json(c, "b-items.json", PLAN_ITEMS)]), "merge");
    const n = c.commits().length;
    ok(run_cli(c, ["report", SLUG, "plan"]), "report");
    const added = c.commits_since(n);
    const actions = added.map((m) => m.action);
    // 영수증 action 은 명령 이름이 아니라 definition.action(사건 이름)이다: content.append_version → content.version_appended 등.
    // 첫 실행은 report artifact 를 만든다(content.artifact_added, 버전 1개 — 첫 report 시험과 같은 계약).
    for (const want of ["content.artifact_added", "file.upload_reserved", "file.version_attached"]) {
      assert.ok(actions.includes(want), `${want} 영수증: [${actions}]`);
    }
    // 두 번째 실행은 같은 객체에 새 버전을 쌓는다(content.version_appended) — 덮어쓰기 없음.
    const n2 = c.commits().length;
    ok(run_cli(c, ["report", SLUG, "plan"]), "report 2");
    const again = c.commits_since(n2).map((m) => m.action);
    for (const want of ["content.version_appended", "file.upload_reserved", "file.version_attached"]) {
      assert.ok(again.includes(want), `두 번째 실행 ${want} 영수증: [${again}]`);
    }
    assert.ok(!again.includes("content.artifact_added"), `두 번째 실행은 새 객체를 만들지 않는다: [${again}]`);
    assert.ok(again.every((a) => a.startsWith("content.") || a.startsWith("file.")), `report 는 content.*·file.* 만 쓴다: [${again}]`);
    assert.ok(actions.every((a) => a.startsWith("content.") || a.startsWith("file.")), `report 는 content.*·file.* 만 쓴다: [${actions}]`);
    assert.ok(added.every((m) => m.via === "cli" && m.actor_id === c.env.p.actor_id), "사람 소유자의 cli 영수증");
    const blobs = c.env.db.all<{ state: string }>("SELECT state FROM blobs WHERE project_id = ? AND original_name IN ('report.md','report.html')", c.env.p.project_id);
    assert.ok(blobs.length >= 2 && blobs.every((b) => b.state === "ready"), "렌더 파일 blob 은 모두 ready (staging 으로 남지 않음)");
  }));

test("report/output artifact 는 render 봉인 목록과 approve plan 인계에 들어가지 않는다 (해석 7)", () =>
  with_cli(async (c) => {
    ok(run_cli(c, ["round-start", SLUG, "plan"]), "round-start");
    ok(run_cli(c, ["merge", SLUG, "plan", write_json(c, "s-items.json", [PLAN_ITEMS[0]])]), "merge");
    ok(run_cli(c, ["report", SLUG, "plan"]), "report");
    const rendered = ok(run_cli(c, ["render", SLUG, "plan"]), "render");
    // 봉인 목록 = render 가 남기는 snapshots/plan-R1.json 의 항목들 (0.15 와 같은 파일, D07): 보고서는 항목이 아니다
    assert.match(rendered.stdout, /index\.html/, `render 는 대시보드 경로를 낸다: ${rendered.stdout}`);
    const sealed = JSON.parse(readFileSync(join(c.folder, "snapshots", "plan-R1.json"), "utf8")) as { state?: { items?: unknown[] } };
    const sealed_items = sealed.state?.items;
    assert.equal(sealed_items?.length, 1, `보고서가 봉인 항목으로 세어지면 안 된다 (기획 R1 봉인 항목 1개): ${JSON.stringify(sealed).slice(0, 200)}`);
    const approved = ok(run_cli(c, ["approve", SLUG, "plan"]), "approve");
    assert.match(approved.stdout, /조사 항목 1개 생성/, `인계는 기획 항목만: ${approved.stdout}`);
  }));

test("report 권한: 범위가 모자란 토큰·lease 없는 토큰·다른 세션의 잠금은 거부되고 아무것도 쓰지 않는다", () =>
  with_cli(async (c) => {
    ok(run_cli(c, ["round-start", SLUG, "plan"]), "round-start");
    ok(run_cli(c, ["merge", SLUG, "plan", write_json(c, "p-items.json", PLAN_ITEMS)]), "merge");
    const reader = await c.agent("report-reader", ["context:read"]);
    const bare = await c.agent("report-bare");
    const signature = state_signature(c.env.db);
    expect_rejected(run_cli(c, ["report", SLUG, "plan"], { extra: { PES_TOKEN: reader.token } }), "읽기 범위 토큰");
    expect_rejected(run_cli(c, ["report", SLUG, "plan"], { extra: { PES_TOKEN: bare.token } }), "claim 안 한 토큰");
    expect_rejected(run_cli(c, ["report", SLUG, "plan"], { extra: { PES_TOKEN: "garbage-token" } }), "엉터리 토큰");
    assert.equal(state_signature(c.env.db), signature, "거부는 영수증·행을 남기지 않는다");
    ok(run_cli(c, ["lock", SLUG], { extra: { PES_OWNER: "sess-report001" } }), "lock");
    const other = run_cli(c, ["report", SLUG, "plan"], { extra: { PES_OWNER: "sess-report002" } });
    assert.equal(other.status, 3, "다른 세션이 쥔 lease: 종료 3");
    assert.equal(report_object(c, "report", "plan"), undefined);
    ok(run_cli(c, ["report", SLUG, "plan"], { extra: { PES_OWNER: "sess-report001" } }), "같은 세션");
    assert.ok(report_object(c, "report", "plan"));
  }));

// ---------------------------------------------------------------------------
// 5 · assemble · web: 같은 문구, 각주 다시 매김, 새 버전

test("assemble: 각주를 출처 순서로 다시 매기고(같은 URL·제목은 한 번) 실행마다 새 버전을 쌓는다", () =>
  with_cli(async (c) => {
    ok(run_cli(c, ["merge", SLUG, "write", write_json(c, "w-items.json", WRITE_ITEMS)]), "merge write");
    const json_sig = c.sig(c.project_json);
    const n = c.commits().length;
    const res = ok(run_cli(c, ["assemble", SLUG]), "assemble");
    assert.match(res.stdout, /\(장·절 1개, 각주 2개\)\s*$/m, `옛 출력 끝부분: ${res.stdout}`);
    const actions = c.commits_since(n).map((m) => m.action);
    assert.ok(actions.every((a) => a.startsWith("content.") || a.startsWith("file.")), `PR9 경계만: [${actions}]`);
    const object_id = report_object(c, "output", null);
    assert.ok(object_id, "최종 보고서 artifact (kind output)");
    const v1 = versions_of(c, object_id);
    assert.equal(v1.length, 1);
    const files = rendered_of(c, v1[0]!.id);
    const md = file_named(files, "report.md").text;
    assert.match(md, /^# 합성 파일 주제$/m);
    assert.match(md, /첫 장 본문입니다 \[\^1\] 그리고 \[\^2\] 끝\./);
    assert.match(md, /^\[\^1\]: 합성 출처 A, https:\/\/example\.invalid\/a \(2026-01-02\)$/m);
    assert.match(md, /^\[\^2\]: 합성 출처 C, https:\/\/example\.invalid\/c$/m);
    const sources = JSON.parse(file_named(files, "sources.json").text) as Array<{ n: number; title: string; url: string; verified: boolean }>;
    assert.deepEqual(sources.map((s) => [s.n, s.title, s.verified]), [[1, "합성 출처 A", true], [2, "합성 출처 C", false]]);

    // 두 번째 장을 더하면 같은 출처 A 는 같은 번호를 쓰고 새 출처는 이어 붙는다
    ok(run_cli(c, ["merge", SLUG, "write", write_json(c, "w-items2.json", [{ id: 2, kind: "section", title: "2장", order: 2, status: "done", details: "둘째 장 [^1] [^2]", sources: [{ title: "합성 출처 C", url: "https://example.invalid/c", method: "search" }, { title: "합성 출처 A", url: "https://example.invalid/a", method: "law" }] }])]), "merge write 2");
    const again = ok(run_cli(c, ["assemble", SLUG]), "assemble 2");
    assert.match(again.stdout, /\(장·절 2개, 각주 2개\)\s*$/m);
    const v2 = versions_of(c, object_id);
    assert.equal(v2.length, 2, "덮어쓰지 않고 새 버전");
    assert.deepEqual(v2[0], v1[0]);
    const md2 = file_named(rendered_of(c, v2[1]!.id), "report.md").text;
    assert.match(md2, /둘째 장 \[\^2\] \[\^1\]/, "장 안의 번호는 전체 각주 번호로 바뀐다 (C=2, A=1)");
    assert.equal(file_named(rendered_of(c, v1[0]!.id), "report.md").text, md, "버전 1 파일은 그대로");
    ok(run_cli(c, ["assemble", SLUG]), "assemble 3 (내용 같음)");
    assert.equal(versions_of(c, object_id).length, 3, "내용이 같아도 실행마다 새 버전 (보고서처럼)");
    // pes.ts 는 0.15 호환으로 폴더 out/ 에도 최신 조립본을 둔다(D02) — DB 의 최신 버전과 같은 내용
    assert.equal(read_lf(join(c.folder, "out", "report.md")), file_named(rendered_of(c, versions_of(c, object_id).at(-1)!.id), "report.md").text, "out/report.md = DB 최신 버전");
    assert.deepEqual(c.sig(c.project_json), json_sig, "옛 project.json 은 건드리지 않는다");
  }));

test("web: 최종 웹 보고서를 새 버전의 report.html 로 쌓고 출력 문구를 유지한다 (assemble 안 했으면 먼저 조립)", () =>
  with_cli(async (c) => {
    ok(run_cli(c, ["merge", SLUG, "write", write_json(c, "web-items.json", WRITE_ITEMS)]), "merge write");
    const n = c.commits().length;
    const res = ok(run_cli(c, ["web", SLUG]), "web");
    assert.match(res.stdout, /\(출처 2개 · 확인됨 1개/, `옛 출력: ${res.stdout}`);
    const actions = c.commits_since(n).map((m) => m.action);
    assert.ok(actions.includes("file.version_attached") && actions.every((a) => a.startsWith("content.") || a.startsWith("file.")), `PR9 경계만: [${actions}]`);
    const object_id = report_object(c, "output", null);
    assert.ok(object_id);
    const latest = versions_of(c, object_id).at(-1)!;
    const files = rendered_of(c, latest.id);
    const html = file_named(files, "report.html").text;
    assert.match(html, /합성 파일 주제/);
    assert.match(html, /합성 출처 A/);
    file_named(files, "report.md");
    const count = versions_of(c, object_id).length;
    ok(run_cli(c, ["web", SLUG, "--assemble"]), "web --assemble");
    assert.ok(versions_of(c, object_id).length > count, "--assemble 은 새 조립본(새 버전)을 만든다");
    const before = versions_of(c, object_id).length;
    ok(run_cli(c, ["web", SLUG]), "web 다시 (내용 같음)");
    assert.equal(versions_of(c, object_id).length, before + 1, "web 도 내용이 같아도 실행마다 새 버전");
    assert.equal(read_lf(join(c.folder, "out", "report.html")), file_named(rendered_of(c, versions_of(c, object_id).at(-1)!.id), "report.html").text, "out/report.html = DB 최신 버전 (pes.ts 는 0.15 호환으로 폴더에도 둔다, D02)");
  }));


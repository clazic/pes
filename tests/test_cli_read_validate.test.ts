/**
 * SEL-49 PR16 — CLI 읽기·보고서·doctor — validate_import 보고서 재생성 (tester). 원래 tests/test_cli_read.test.ts 하나였고 Windows CI 조각 상한(10분) 때문에 주제별로 나눴다. 해석 번호는 test_cli_read_v015.test.ts 머리말 참고. 구현 전이므로 새 시험은 실패하는 것이 정상이다.
 *
 * 시험 방식은 PR15와 같다: `python3 -I -X utf8 scripts/pes.py ...`를 subprocess로 실행하고 HOME·USERPROFILE·PES_HOME은
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
import { baseline_dir, normalize, OFF, ok, plain_legacy, folder_of, PLAN_ITEMS, WRITE_ITEMS, read_lf, rich_legacy, RICH_TOPIC, run_py, seed, shell_words, write_json, write_legacy, write_pending_answer, type HomeLike } from "./helpers/cli_read_env.ts";
import { FIXTURES, legacy, tree_digest } from "./helpers/legacy_env.ts";
import { copy_fixture, has_problem, migration, with_migration, owner_of, pes_home_of, backup_dir_of, batch_row } from "./helpers/migration_env.ts";
import { isolated_home } from "./helpers/isolated_home.ts";
import { state_signature } from "./helpers/state_signature.ts";

// ---------------------------------------------------------------------------
// 8 · PR12 validate_import 의 보고서 재생성: 실제 생성기, 불일치는 문제

/** v0.15 (03fc81b) 의 report 로 만든, 시각 줄만 고정한 원본 보고서가 든 fixture 사본. */
function legacy_with_real_reports(env: Parameters<typeof copy_fixture>[0]): string {
  const base = baseline_dir();
  assert.notEqual(base, null, "기준 커밋 03fc81b 가 이 저장소에 없다 (CI 는 fetch-depth: 0)");
  const dir = copy_fixture(env, "full");
  try {
    const like: HomeLike = { env: { home: env.home } };
    const res = run_py(like, ["report", dir, "plan"], { flag: undefined, script: join(base!, "scripts", "pes.py") });
    assert.equal(res.status, 0, res.stderr + res.stdout);
    const md_path = join(dir, "reports", "plan", "report.md");
    const html_path = join(dir, "reports", "plan", "report.html");
    const md = readFileSync(md_path, "utf8");
    const stamp = md.match(/^- 작성 (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · PES\r?$/m)?.[1];
    assert.ok(stamp, "v0.15 보고서의 '작성 <시각>' 줄");
    // 시각을 옛날 값으로 고정: 재생성기가 '작성 …' 시각 줄을 비교에서 무시해야 한다 (해석 10)
    writeFileSync(md_path, md.split(stamp).join("2001-01-01 00:00"), "utf8");
    writeFileSync(html_path, readFileSync(html_path, "utf8").split(stamp).join("2001-01-01 00:00"), "utf8");
    return dir;
  } finally {
    rmSync(base!, { recursive: true, force: true });
  }
}

test("validate_import: v0.15 가 만든 보고서(시각만 다름)는 실제 생성기로 재생성해도 같고 문제가 없다", async () => {
  await with_migration(async (env, api, mig) => {
    const dir = legacy_with_real_reports(env);
    const imp = await api.import_project(env.service, dir, { owner_actor_id: owner_of(env) });
    const out = await mig.validate_import(env.service, imp.batch_id, { owner_actor_id: owner_of(env), source_dir: dir });
    assert.equal(out.ok, true, JSON.stringify(out.report.problems));
    for (const path of ["reports/plan/report.md", "reports/plan/report.html"]) {
      const entry = out.report.regenerated_reports.find((r) => r.path === path);
      assert.ok(entry, `${path} 를 재생성해 비교한다`);
      assert.equal(entry.matches, true, `${path}: 시각을 뺀 내용이 v0.15 와 같다`);
    }
    assert.notEqual((out.report as unknown as Record<string, unknown>).regeneration_format, "provisional", "임시 형식 표식이 사라진다");
    assert.equal(batch_row(env.db, imp.batch_id).state, "validated");
  });
});

test("validate_import: 옛 보고서와 재생성본이 다르면 문제로 올리고 검증하지 않는다 (md·html 각각)", async () => {
  await with_migration(async (env, api, mig) => {
    for (const [file, path] of [["report.md", "reports/plan/report.md"], ["report.html", "reports/plan/report.html"]] as const) {
      const dir = legacy_with_real_reports(env);
      writeFileSync(join(dir, "reports", "plan", file), file.endsWith("md") ? "# 사람이 직접 고친 보고서\n" : "<html>손으로 고침</html>\n", "utf8");
      const imp = await api.import_project(env.service, dir, { owner_actor_id: owner_of(env) });
      const out = await mig.validate_import(env.service, imp.batch_id, { owner_actor_id: owner_of(env), source_dir: dir });
      assert.equal(out.ok, false, `${file}: 불일치는 문제`);
      assert.equal(out.state, "staging");
      assert.ok(has_problem(out.report, "reports_regeneration"), JSON.stringify(out.report.problems));
      const problem = out.report.problems.find((p) => p.check === "reports_regeneration");
      assert.equal(problem?.path, path, "문제는 어느 보고서인지 경로로 알린다");
      assert.equal(out.report.regenerated_reports.find((r) => r.path === path)?.matches, false);
      assert.equal(batch_row(env.db, imp.batch_id).state, "staging", "문제가 있으면 validated 가 되지 않는다");
    }
  });
});

test("validate_import: 재생성 대상이 아닌 보고서 파일(pdf·eli5)은 비교하지 않는다", async () => {
  await with_migration(async (env, api, mig) => {
    const dir = legacy_with_real_reports(env);
    writeFileSync(join(dir, "reports", "plan", "report.pdf"), "다른 PDF 바이트", "utf8");
    const imp = await api.import_project(env.service, dir, { owner_actor_id: owner_of(env) });
    const out = await mig.validate_import(env.service, imp.batch_id, { owner_actor_id: owner_of(env), source_dir: dir });
    assert.equal(out.ok, true, JSON.stringify(out.report.problems));
    const paths = out.report.regenerated_reports.map((r) => r.path);
    assert.ok(!paths.some((p) => /\.pdf$|eli5/.test(p)), `비교 대상은 report.md·report.html 뿐: ${paths}`);
  });
});


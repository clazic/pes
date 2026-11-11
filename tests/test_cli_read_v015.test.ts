/**
 * SEL-49 PR16 — CLI 읽기·보고서·doctor (tester, 작성 모드). 구현 전이므로 새 시험은 실패하는 것이 정상이다.
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
import { pes_cmds } from "./helpers/skill_docs.ts";
import { expect_same_as_015, golden, normalize, ok, plain_legacy, folder_of, PLAN_ITEMS, WRITE_ITEMS, read_lf, rich_legacy, RICH_TOPIC, run_cli, seed, shell_words, write_json, write_legacy, write_pending_answer, type HomeLike, expect_staging } from "./helpers/cli_read_env.ts";
import { FIXTURES, legacy, tree_digest } from "./helpers/legacy_env.ts";
import { copy_fixture, has_problem, migration, with_migration, owner_of, pes_home_of, backup_dir_of, batch_row } from "./helpers/migration_env.ts";
import { isolated_home } from "./helpers/isolated_home.ts";
import { state_signature } from "./helpers/state_signature.ts";

// ---------------------------------------------------------------------------
// 0 · 구성

test("읽기 13개는 pes.ts 명령표에 그대로 있고, 새 코어 명령은 더해지지 않는다 (해석 5)", () => {
  const cmds = new Set(pes_cmds());
  for (const name of ["status", "pending", "digest", "show", "list", "hub", "open", "which", "doctor", "watch", "assemble", "report", "web"]) {
    assert.ok(cmds.has(name), `${name} 는 CMDS 에 남는다`);
  }
  assert.deepEqual([...COMMANDS.keys()].sort(), [...EXPECTED_COMMAND_NAMES], "등록된 코어 명령 = 기대 목록 (report 는 기존 content.*·file.* 만 쓴다)");
});

// ---------------------------------------------------------------------------
// 1 · 플래그 없음: v0.15 와 바이트 단위로 같다 (A1 방식)

/**
 * stdout 비교. 유일하게 허용하는 차이: `watch` 의 경로에 역슬래시가 있으면(Windows 임시 경로 C:\\Users\\…) 새 출력은
 * v0.15 출력의 그 경로 단어를 작은따옴표로 감싼 것이다 — 그 밖의 어떤 차이도 허용하지 않는다.
 */
function expect_same_stdout(command: string, now: string, base: string, label: string): void {
  if (command === "watch" && now !== base) {
    // Windows 의 print 는 줄 끝이 \r\n 이다 — 줄 끝은 기준본과 같아야 하고, 경로 단어만 다를 수 있다.
    const m = base.match(/^tail -n0 -F (.+) \| grep --line-buffered FEEDBACK(\r?\n)$/);
    assert.ok(m && m[1]!.includes("\\") && !m[1]!.includes("'"), `${label}: 달라진 이유가 역슬래시 경로 quoting 이 아니다\n새:  ${now}기준: ${base}`);
    assert.equal(now, `tail -n0 -F '${m[1]}' | grep --line-buffered FEEDBACK${m[2]}`, `${label}: 경로 단어만 작은따옴표로 감싼다`);
    return;
  }
  assert.equal(now, base, `${label}: stdout`);
}

test("A1b watch 비교 허용 규칙: 역슬래시 경로의 작은따옴표만 허용하고 다른 차이는 거부한다 (Windows 대비, 플랫폼 무관)", () => {
  const base = "tail -n0 -F <ROOT>\\pes-projects\\p/feedback.log | grep --line-buffered FEEDBACK\n";
  expect_same_stdout("watch", "tail -n0 -F '<ROOT>\\pes-projects\\p/feedback.log' | grep --line-buffered FEEDBACK\n", base, "허용");
  expect_same_stdout("watch", base, base, "같음");
  // Windows 줄 끝(\r\n): 같은 규칙, 줄 끝은 기준본과 같아야 한다.
  const crlf = base.replace(/\n$/, "\r\n");
  expect_same_stdout("watch", "tail -n0 -F '<ROOT>\\pes-projects\\p/feedback.log' | grep --line-buffered FEEDBACK\r\n", crlf, "허용(CRLF)");
  assert.throws(() => expect_same_stdout("watch", "tail -n0 -F '<ROOT>\\pes-projects\\p/feedback.log' | grep --line-buffered FEEDBACK\n", crlf, "x"), "줄 끝이 기준본과 다르면 거부");
  assert.throws(() => expect_same_stdout("watch", "tail -n0 -F '<ROOT>\\pes-projects\\other/feedback.log' | grep --line-buffered FEEDBACK\n", base, "x"), "경로가 다르면 거부");
  assert.throws(() => expect_same_stdout("watch", "tail -n0 -F \"<ROOT>\\pes-projects\\p/feedback.log\" | grep --line-buffered FEEDBACK\n", base, "x"), "큰따옴표는 거부");
  const plain = "tail -n0 -F <ROOT>/pes-projects/p/feedback.log | grep --line-buffered FEEDBACK\n";
  assert.throws(() => expect_same_stdout("watch", `tail -n0 -F '<ROOT>/pes-projects/p/feedback.log' | grep --line-buffered FEEDBACK\n`, plain, "x"), "역슬래시 없는 경로의 따옴표는 거부");
  assert.throws(() => expect_same_stdout("status", "a\n", "b\n", "x"), "watch 아닌 명령은 항상 엄격");
});

test("A1 옛 폴더(DB 에 없음)의 읽기 명령은 출력·종료 코드가 0.15 와 같고 폴더·DB 는 불변이다", async () => {
  // 0.15(같은 입력)가 낸 출력: 고정 기록 tests/fixtures/golden/rich-legacy-reads.json.
  // (0.15 는 report·assemble·web 도 옛 폴더에 파일을 만들었다. TS 는 D14 로 거절한다 — test_sel74_c_d14_refusal C1 과 아래 'legacy 쓰기' 가 그 보장이다.
  //  doctor 행은 baseline E15 가 고정한다.)
  const c = await make_cli_env();
  try {
    const slug = "legacy-only";
    const folder = folder_of(c, slug);
    const json = write_legacy(folder, rich_legacy(slug));
    write_pending_answer(folder, "plan-R1-20260301-100000.json");
    const sig = c.sig(json);
    const tree = tree_digest(folder);
    const signature = state_signature(c.env.db);
    const rec = golden("rich-legacy-reads");
    for (const args of [
      ["status", slug], ["status", "no-such-project"], ["pending", slug], ["digest", slug, "plan"], ["digest", slug, "plan", "--round", "1"], ["digest", slug, "nope"],
      ["show", slug, "plan"], ["show", slug, "plan", "1", "--fields", "title,status"], ["show", slug, "plan", "99"], ["which", "no-such-tool-sel49"], ["watch", slug],
      // (list 는 뺐다: 이 환경에는 DB 프로젝트도 있어 목록이 0.15 기록과 다르다. 옛 폴더만 있는 목록은 아래 list 시험과 test_sel74_c_d14_refusal C4)
    ]) {
      const label = args.join(" ");
      const res = expect_same_as_015(c, args, rec[label], label);
      if (args[0] === "watch") expect_same_stdout("watch", normalize(res.stdout, [c.env.home.root]), rec[label]!.stdout, label);
    }
    assert.deepEqual(c.sig(json), sig, "project.json 바이트·mtime 불변");
    assert.equal(tree_digest(folder), tree, "읽기는 폴더에 아무것도 만들지 않는다");
    assert.equal(state_signature(c.env.db), signature, "읽기는 DB 에 쓰지 않는다");
  } finally {
    c.close();
  }
});

// A2 (PES_DB_CORE 가 1 이 아니면 읽기는 project.json) — 지움: 플래그가 없어졌다. 환경 변수 PES_DB_CORE 가 아무 영향을 못 주는 것은
// test_sel74_b_db_commands·test_pes_ts_guard 쪽 시험(ts_run 이 그 변수를 지운다)과 아래 'DB 프로젝트의 status' 가 지킨다.

// ---------------------------------------------------------------------------
// 2 · 플래그 켜짐 + DB 프로젝트: 읽기는 DB, project.json 은 건드리지 않는다

test("DB 프로젝트의 status 는 DB 에서 읽고 project.json 은 바이트·mtime 이 그대로다", () =>
  with_cli(async (c) => {
    const sig = c.sig(c.project_json);
    const listing = c.listing(c.folder);
    const signature = state_signature(c.env.db);
    const res = ok(run_cli(c, ["status", SLUG]), "status");
    assert.match(res.stdout, /^주제: 합성 파일 주제 {2}\(/m, "DB 의 주제 (옛 JSON 의 '합성 옛 주제' 가 아님)");
    assert.doesNotMatch(res.stdout, /합성 옛 주제/);
    assert.match(res.stdout, /^현재 단계: 기획/m);
    for (const label of ["기획", "조사", "분석·종합", "집필", "검증", "산출·공유"]) assert.match(res.stdout, new RegExp(`^ +[▶ ] ?${label}`, "m"), `${label} 줄`);
    assert.match(res.stdout, /^처리 안 한 답: 0개/m);
    assert.match(res.stdout, /^대시보드: 서버 꺼짐 — serve synthetic-files/m);
    assert.deepEqual(c.sig(c.project_json), sig, "project.json 불변");
    assert.deepEqual(c.listing(c.folder), listing, "읽기는 폴더에 아무것도 만들지 않는다");
    assert.equal(state_signature(c.env.db), signature, "읽기는 DB 에 쓰지 않는다 (영수증·사건 0)");
  }));

test("DB 읽기 출력이 같은 쓰기를 한 v0.15 출력과 같다: status·digest·show·list", async () => {
  // 0.15 가 같은 합성 쓰기(seed)를 한 뒤 낸 출력: 고정 기록 tests/fixtures/golden/seeded-plain-reads.json
  const now = await make_cli_env();
  try {
    seed(now);
    const rec = golden<Record<string, any>>("seeded-plain-reads");
    for (const args of [
      ["status", SLUG],
      ["digest", SLUG, "plan"],
      ["digest", SLUG, "plan", "--round", "1"],
      ["digest", SLUG, "write"],
      ["show", SLUG, "plan", "1", "--fields", "title,status,confidence"],
      ["show", SLUG, "plan", "1", "2"],
      ["show", SLUG, "write", "1", "--fields", "title,details"],
      ["list"],
    ]) {
      const label = args.join(" ");
      const a = expect_same_as_015(now, args, rec[label], `${label}: DB 쪽 출력 = v0.15 출력`);
      assert.doesNotMatch(a.stderr, /Traceback/, label);
    }
    // 단계 전체 요약(show <stage>)의 항목 목록·상태 필드
    const a = JSON.parse(run_cli(now, ["show", SLUG, "plan"]).stdout);
    const b = rec["show plan keys"];
    for (const key of ["items", "round", "status", "approved_at", "stale"]) assert.deepEqual(a[key], b[key], `show plan: ${key}`);
  } finally {
    now.close();
  }
});

test("pending 은 DB 의 처리 안 한 답을 옛 파일 이름 모양으로 보이고, mark 하면 사라진다 (해석 3)", () =>
  with_cli(async (c) => {
    const dir = join(c.env.home.env.PES_HOME as string, "synthetic-legacy-full");
    cpSync(join(FIXTURES, "full"), dir, { recursive: true });
    const origin = run_cli(c, ["pending", "synthetic-legacy-full"]); // 아직 DB 에 없는 옛 폴더: project.json 을 읽는다
    const api = await legacy();
    const mig = await migration();
    const imp = await api.import_project(c.env.service, dir, { owner_actor_id: owner_of(c.env) });
    expect_staging(imp, dir, "test_cli_read_v015.test.ts#1");
    assert.equal(imp.state, "staging");
    const origin_names = origin.stdout.trim().split("\n").map((l) => l.trim().split(/[\\/]/).pop());
    assert.deepEqual(origin_names, ["research-R1-20260105-130000.json", "research-R1-20260105-140000.json"], "fixture: 처리 안 한 답 2개");
    // staging 은 아직 legacy 경로 — 출력은 v0.15 와 같다
    assert.equal(run_cli(c, ["pending", "synthetic-legacy-full"]).stdout, origin.stdout, "staging 프로젝트는 project.json 을 읽는다 (해석 1)");
    const val = await mig.validate_import(c.env.service, imp.batch_id, { owner_actor_id: owner_of(c.env), source_dir: dir });
    assert.equal(val.ok, true, JSON.stringify(val.report.problems));
    await mig.activate_import(c.env.service, imp.batch_id, { owner_actor_id: owner_of(c.env), backup_dir: backup_dir_of(c.env, "read-pending"), pes_home: pes_home_of(c.env) });
    const json_sig = c.sig(join(dir, "project.json"));
    const db_pending = ok(run_cli(c, ["pending", "synthetic-legacy-full"]), "pending (DB)");
    const names = db_pending.stdout.trim().split("\n").map((l) => l.trim().split(/[\\/]/).pop());
    assert.deepEqual(names, origin_names, "DB 에서 읽은 처리 안 한 답 = 옛 파일 이름");
    ok(run_cli(c, ["mark", "synthetic-legacy-full", origin_names[0]!]), "mark");
    const after = run_cli(c, ["pending", "synthetic-legacy-full"]).stdout.trim().split("\n").map((l) => l.trim().split(/[\\/]/).pop());
    assert.deepEqual(after, [origin_names[1]], "표시한 답은 더는 처리 대기가 아니다");
    const status = ok(run_cli(c, ["status", "synthetic-legacy-full"]), "status");
    assert.match(status.stdout, /^주제: 합성 도서관 운영 연구/m);
    assert.match(status.stdout, /^현재 단계: 조사/m);
    assert.match(status.stdout, /^처리 안 한 답: 1개/m);
    assert.deepEqual(c.sig(join(dir, "project.json")), json_sig, "활성화된 프로젝트의 읽기·mark 는 옛 project.json 을 건드리지 않는다");
  }));

test("list: DB 프로젝트와 project.json 만 있는 프로젝트가 한 번씩 나온다 (같은 슬러그는 중복되지 않음)", () =>
  with_cli(async (c) => {
    write_legacy(join(c.env.home.env.PES_HOME as string, "legacy-only"), plain_legacy("legacy-only"));
    const out = ok(run_cli(c, ["list"]), "list").stdout;
    const count = (slug: string) => out.split("\n").filter((l) => l.includes(`(${slug})`)).length;
    assert.equal(count(SLUG), 1, `DB 프로젝트는 한 번 (폴더에 옛 project.json 이 같이 있어도): ${out}`);
    assert.equal(count("legacy-only"), 1, "옛 프로젝트도 목록에 나온다");
    assert.match(out, /합성 파일 주제/, "DB 프로젝트의 제목은 DB 의 주제");
    assert.doesNotMatch(out, /합성 옛 주제/);
  }));

// ---------------------------------------------------------------------------
// 3 · legacy (DB에 없는 프로젝트): 읽기는 v0.15 와 같고 쓰기는 이전 안내로 막힌다

// 'legacy 읽기: DB 에 없는 프로젝트의 읽기 출력이 플래그 없을 때(v0.15)와 같다' 는 위 A1(고정 기록 rich-legacy-reads)이 같은 입력으로 지킨다. 옛 폴더 doctor 행은 baseline E15 가 고정한다.

test("legacy 쓰기: 이전 안내 메시지와 0 아닌 종료 코드, 폴더·DB 불변 (report·assemble·web 포함)", () =>
  with_cli(async (c) => {
    const folder = folder_of(c, "legacy-only");
    const json = write_legacy(folder, rich_legacy("legacy-only"));
    const items = write_json(c, "legacy-items.json", PLAN_ITEMS);
    const sig = c.sig(json);
    const tree = tree_digest(folder);
    const signature = state_signature(c.env.db);
    const S = "legacy-only";
    for (const [args, extra] of [
      [["note", S, "x"], {}],
      [["round-start", S, "plan"], {}],
      [["merge", S, "plan", items], {}],
      [["render", S, "plan"], {}],
      [["approve", S, "plan"], {}],
      [["reopen", S, "plan"], {}],
      [["chat", S, "plan", "x"], {}],
      [["mark", S, "a.json"], {}],
      [["qa-brief", S, "plan"], {}],
      [["ask-prep", S, "plan"], {}],
      [["lock", S], { PES_OWNER: "sess-legacy01" }],
      [["report", S, "plan"], {}],
      [["assemble", S], {}],
      [["web", S], {}],
    ] as Array<[string[], Record<string, string | undefined>]>) {
      const res = run_cli(c, args, { extra });
      expect_rejected(res, args[0]!);
      assert.match(res.stderr, /이전/, `${args[0]}: '이전' 안내 한국어 메시지: ${res.stderr}`);
      assert.deepEqual(c.sig(json), sig, `${args[0]}: project.json 불변`);
      assert.equal(tree_digest(folder), tree, `${args[0]}: 폴더에 reports/·out/·feedback/ 등을 만들지 않는다`);
    }
    assert.equal(state_signature(c.env.db), signature, "DB 불변");
  }));


test("테스트 격리: 이 파일의 하니스는 HOME·USERPROFILE·PES_HOME 이 모두 임시 폴더 안이다", () =>
  with_cli(async (c) => {
    const env = c.env.home.env;
    for (const key of ["HOME", "USERPROFILE", "PES_HOME"]) {
      const value = env[key];
      assert.ok(value && value.startsWith(c.env.home.root), `${key} 는 임시 루트 안: ${value}`);
    }
    assert.equal(LEGACY_JSON.includes("/Users/"), false, "fixture 에 사용자 절대경로가 없다");
    assert.equal(spawnSync("git", ["--version"]).status, 0);
  }));


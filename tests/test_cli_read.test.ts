/**
 * SEL-49 PR16 — CLI 읽기·보고서·doctor (tester, 작성 모드). 구현 전이므로 새 시험은 실패하는 것이 정상이다.
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
import { baseline_dir, normalize, rich_legacy, RICH_TOPIC, run_py, shell_words, write_legacy, write_pending_answer, type HomeLike } from "./helpers/cli_read_env.ts";
import { FIXTURES, legacy, tree_digest } from "./helpers/legacy_env.ts";
import { copy_fixture, has_problem, migration, with_migration, owner_of, pes_home_of, backup_dir_of, batch_row } from "./helpers/migration_env.ts";
import { isolated_home } from "./helpers/isolated_home.ts";
import { state_signature } from "./helpers/state_signature.ts";

const OFF = { flag: undefined } as const;

function ok(res: CliResult, what: string): CliResult {
  assert.equal(res.status, 0, `${what}: exit ${res.status}\n${res.stderr}${res.stdout}`);
  assert.doesNotMatch(res.stderr, /Traceback/, `${what}: 스택 추적이 아니라 분명한 메시지여야 한다`);
  return res;
}

function write_json(c: { env: { home: { root: string } } }, name: string, value: unknown): string {
  const file = join(c.env.home.root, name);
  writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

const PLAN_ITEMS = [
  {
    id: 1,
    kind: "topic",
    title: "합성 기획 항목 하나",
    summary: "합성 요약 하나",
    confidence: "high",
    status: "done",
    sources: [
      { title: "합성 출처 A", url: "https://example.invalid/a", method: "law", date: "2026-01-02" },
      { title: "합성 출처 B", url: "https://example.invalid/b", method: "search" },
    ],
  },
  { id: 2, kind: "topic", title: "합성 기획 항목 둘", summary: "합성 요약 둘", status: "deepen" },
];

const WRITE_ITEMS = [
  {
    id: 1,
    kind: "section",
    title: "1장",
    order: 1,
    status: "done",
    details: "첫 장 본문입니다 [^1] 그리고 [^2] 끝.",
    sources: [
      { title: "합성 출처 A", url: "https://example.invalid/a", method: "law", date: "2026-01-02" },
      { title: "합성 출처 C", url: "https://example.invalid/c", method: "search" },
    ],
  },
];

/** 같은 쓰기를 한 환경에 한다. flag 가 undefined 이면 v0.15(project.json), "1" 이면 DB. */
function seed(c: CliEnv, flag: string | undefined): void {
  const run = (args: string[]) => ok(run_py(c, args, { flag }), args.join(" "));
  run(["round-start", SLUG, "plan"]);
  run(["merge", SLUG, "plan", write_json(c, "seed-plan.json", PLAN_ITEMS)]);
  run(["merge", SLUG, "write", write_json(c, "seed-write.json", WRITE_ITEMS)]);
  run(["note", SLUG, "합성 인계 메모 하나"]);
  run(["note", SLUG, "합성 인계 메모 둘"]);
}

function plain_legacy(slug: string): Record<string, unknown> {
  return { pes: 1, topic: RICH_TOPIC, slug, current: "plan", processed: [], notes: [], stages: {} };
}

function folder_of(c: CliEnv, slug: string): string {
  return join(c.env.home.env.PES_HOME as string, slug);
}

// ---------------------------------------------------------------------------
// 0 · 구성

test("읽기 13개는 pes.py CMDS 에 그대로 있고, 새 코어 명령은 더해지지 않는다 (해석 5)", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "scripts", "pes.py"), "utf8");
  const block = source.slice(source.indexOf("CMDS = {"), source.indexOf("def main("));
  const cmds = new Set([...block.matchAll(/"([a-z-]+)":\s*cmd_/g)].map((m) => m[1]!));
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
    const m = base.match(/^tail -n0 -F (.+) \| grep --line-buffered FEEDBACK\n$/);
    assert.ok(m && m[1]!.includes("\\") && !m[1]!.includes("'"), `${label}: 달라진 이유가 역슬래시 경로 quoting 이 아니다\n새:  ${now}기준: ${base}`);
    assert.equal(now, `tail -n0 -F '${m[1]}' | grep --line-buffered FEEDBACK\n`, `${label}: 경로 단어만 작은따옴표로 감싼다`);
    return;
  }
  assert.equal(now, base, `${label}: stdout`);
}

test("A1b watch 비교 허용 규칙: 역슬래시 경로의 작은따옴표만 허용하고 다른 차이는 거부한다 (Windows 대비, 플랫폼 무관)", () => {
  const base = "tail -n0 -F <ROOT>\\pes-projects\\p/feedback.log | grep --line-buffered FEEDBACK\n";
  expect_same_stdout("watch", "tail -n0 -F '<ROOT>\\pes-projects\\p/feedback.log' | grep --line-buffered FEEDBACK\n", base, "허용");
  expect_same_stdout("watch", base, base, "같음");
  assert.throws(() => expect_same_stdout("watch", "tail -n0 -F '<ROOT>\\pes-projects\\other/feedback.log' | grep --line-buffered FEEDBACK\n", base, "x"), "경로가 다르면 거부");
  assert.throws(() => expect_same_stdout("watch", "tail -n0 -F \"<ROOT>\\pes-projects\\p/feedback.log\" | grep --line-buffered FEEDBACK\n", base, "x"), "큰따옴표는 거부");
  const plain = "tail -n0 -F <ROOT>/pes-projects/p/feedback.log | grep --line-buffered FEEDBACK\n";
  assert.throws(() => expect_same_stdout("watch", `tail -n0 -F '<ROOT>/pes-projects/p/feedback.log' | grep --line-buffered FEEDBACK\n`, plain, "x"), "역슬래시 없는 경로의 따옴표는 거부");
  assert.throws(() => expect_same_stdout("status", "a\n", "b\n", "x"), "watch 아닌 명령은 항상 엄격");
});

test("A1 플래그 없음: 읽기·보고서 명령의 출력·종료 코드·만든 파일이 v0.15(03fc81b)와 같고 DB는 불변", async () => {
  const base = baseline_dir();
  assert.notEqual(base, null, "기준 커밋 03fc81b 가 이 저장소에 없다 (얕은 복제? actions/checkout 에 fetch-depth: 0 필요)");
  if (base === null) return;
  const now = await make_cli_env();
  const old = await make_cli_env();
  try {
    for (const c of [now, old]) {
      write_legacy(c.folder, rich_legacy(SLUG));
      write_pending_answer(c.folder, "plan-R1-20260301-100000.json");
    }
    const signature = state_signature(now.env.db);
    const old_py = join(base, "scripts", "pes.py");
    const roots_now = [now.env.home.root, `/private${now.env.home.root}`, join(import.meta.dirname, "..")];
    const roots_old = [old.env.home.root, `/private${old.env.home.root}`, base, `/private${base}`];
    const steps: string[][] = [
      ["status", SLUG],
      ["status", "no-such-project"],
      ["pending", SLUG],
      ["digest", SLUG, "plan"],
      ["digest", SLUG, "plan", "--round", "1"],
      ["digest", SLUG, "nope"],
      ["show", SLUG, "plan"],
      ["show", SLUG, "plan", "1", "--fields", "title,status"],
      ["show", SLUG, "plan", "99"],
      ["list"],
      ["which", "no-such-tool-sel49"],
      ["watch", SLUG],
      ["report", SLUG, "plan"],
      ["report", SLUG, "nope"],
      ["assemble", SLUG],
      ["web", SLUG],
      ["web", SLUG, "--assemble"],
    ];
    for (const args of steps) {
      const a = run_py(now, args, { ...OFF });
      const b = run_py(old, args, { ...OFF, script: old_py });
      const label = args.join(" ");
      assert.equal(a.status, b.status, `${label}: 종료 코드`);
      expect_same_stdout(args[0]!, normalize(a.stdout, roots_now), normalize(b.stdout, roots_old), label);
      const last = (s: string, r: string[]) => normalize(s, r).trim().split("\n").pop() ?? "";
      assert.equal(last(a.stderr, roots_now), last(b.stderr, roots_old), `${label}: stderr 마지막 줄`);
    }
    // doctor: 도구·연결 그룹은 이 컴퓨터에 깔린 실제 CLI(ego-browser 등)에 따라 달라지므로 빼고, 환경·프로젝트 그룹만 비교한다.
    const doctor = (c: CliEnv, script: string | undefined, roots: string[]) => {
      const res = run_py(c, ["doctor", SLUG, "--json"], { ...OFF, ...(script === undefined ? {} : { script }) });
      const rows = (JSON.parse(res.stdout) as Array<{ group: string; level: string; title: string; detail: string }>).filter((r) => !["도구", "연결", "서버"].includes(r.group) && !/PES_OWNER|ego-browser|kosis|vworld|korean-law/.test(r.title));
      return normalize(JSON.stringify(rows, null, 1), roots);
    };
    assert.equal(doctor(now, undefined, roots_now), doctor(old, old_py, roots_old), "doctor --json (환경·프로젝트 행)");
    for (const rel of ["project.json", "reports/plan/report.md", "reports/plan/report.html", "out/report.md", "out/sources.json", "out/report.html", "index.html"]) {
      const a = existsSync(join(now.folder, rel)) ? normalize(readFileSync(join(now.folder, rel), "utf8"), roots_now) : null;
      const b = existsSync(join(old.folder, rel)) ? normalize(readFileSync(join(old.folder, rel), "utf8"), roots_old) : null;
      assert.notEqual(a, null, `${rel} 를 v0.15 처럼 만든다`);
      assert.equal(a, b, `${rel}: 내용`);
    }
    assert.equal(state_signature(now.env.db), signature, "플래그 없음 — DB 불변");
  } finally {
    now.close();
    old.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test("A2 PES_DB_CORE 가 1이 아니면(0·빈 문자열·true) 읽기는 project.json 을 읽는다", () =>
  with_cli(async (c) => {
    // DB 의 주제는 '합성 파일 주제', 폴더의 옛 project.json 의 주제는 '합성 옛 주제'
    for (const value of ["0", "", "true", "yes", " 1"]) {
      const res = ok(run_py(c, ["status", SLUG], { flag: value }), `PES_DB_CORE=${JSON.stringify(value)}`);
      assert.match(res.stdout, /주제: 합성 옛 주제/, `PES_DB_CORE=${JSON.stringify(value)}: 옛 방식`);
    }
    assert.match(ok(run_py(c, ["status", SLUG]), "PES_DB_CORE=1").stdout, /주제: 합성 파일 주제/, "플래그 1 은 DB 의 주제");
  }));

// ---------------------------------------------------------------------------
// 2 · 플래그 켜짐 + DB 프로젝트: 읽기는 DB, project.json 은 건드리지 않는다

test("DB 프로젝트의 status 는 DB 에서 읽고 project.json 은 바이트·mtime 이 그대로다", () =>
  with_cli(async (c) => {
    const sig = c.sig(c.project_json);
    const listing = c.listing(c.folder);
    const signature = state_signature(c.env.db);
    const res = ok(run_py(c, ["status", SLUG]), "status");
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
  const now = await make_cli_env();
  const old = await make_cli_env();
  try {
    write_legacy(old.folder, plain_legacy(SLUG));
    seed(now, "1");
    seed(old, undefined);
    const roots_now = [now.env.home.root, `/private${now.env.home.root}`];
    const roots_old = [old.env.home.root, `/private${old.env.home.root}`];
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
      const a = run_py(now, args);
      const b = run_py(old, args, { ...OFF });
      const label = args.join(" ");
      assert.equal(a.status, b.status, `${label}: 종료 코드`);
      assert.doesNotMatch(a.stderr, /Traceback/, label);
      assert.equal(normalize(a.stdout, roots_now), normalize(b.stdout, roots_old), `${label}: DB 쪽 출력 = v0.15 출력`);
    }
    // 단계 전체 요약(show <stage>)의 항목 목록·상태 필드
    const a = JSON.parse(run_py(now, ["show", SLUG, "plan"]).stdout);
    const b = JSON.parse(run_py(old, ["show", SLUG, "plan"], { ...OFF }).stdout);
    for (const key of ["items", "round", "status", "approved_at", "stale"]) assert.deepEqual(a[key], b[key], `show plan: ${key}`);
  } finally {
    now.close();
    old.close();
  }
});

test("pending 은 DB 의 처리 안 한 답을 옛 파일 이름 모양으로 보이고, mark 하면 사라진다 (해석 3)", () =>
  with_cli(async (c) => {
    const dir = join(c.env.home.env.PES_HOME as string, "synthetic-legacy-full");
    cpSync(join(FIXTURES, "full"), dir, { recursive: true });
    const api = await legacy();
    const mig = await migration();
    const imp = await api.import_project(c.env.service, dir, { owner_actor_id: owner_of(c.env) });
    assert.equal(imp.state, "staging");
    const origin = run_py(c, ["pending", "synthetic-legacy-full"], { ...OFF });
    const origin_names = origin.stdout.trim().split("\n").map((l) => l.trim().split(/[\\/]/).pop());
    assert.deepEqual(origin_names, ["research-R1-20260105-130000.json", "research-R1-20260105-140000.json"], "fixture: 처리 안 한 답 2개");
    // staging 은 아직 legacy 경로 — 출력은 v0.15 와 같다
    assert.equal(run_py(c, ["pending", "synthetic-legacy-full"]).stdout, origin.stdout, "staging 프로젝트는 project.json 을 읽는다 (해석 1)");
    const val = await mig.validate_import(c.env.service, imp.batch_id, { owner_actor_id: owner_of(c.env), source_dir: dir });
    assert.equal(val.ok, true, JSON.stringify(val.report.problems));
    await mig.activate_import(c.env.service, imp.batch_id, { owner_actor_id: owner_of(c.env), backup_dir: backup_dir_of(c.env, "read-pending"), pes_home: pes_home_of(c.env) });
    const json_sig = c.sig(join(dir, "project.json"));
    const db_pending = ok(run_py(c, ["pending", "synthetic-legacy-full"]), "pending (DB)");
    const names = db_pending.stdout.trim().split("\n").map((l) => l.trim().split(/[\\/]/).pop());
    assert.deepEqual(names, origin_names, "DB 에서 읽은 처리 안 한 답 = 옛 파일 이름");
    ok(run_py(c, ["mark", "synthetic-legacy-full", origin_names[0]!]), "mark");
    const after = run_py(c, ["pending", "synthetic-legacy-full"]).stdout.trim().split("\n").map((l) => l.trim().split(/[\\/]/).pop());
    assert.deepEqual(after, [origin_names[1]], "표시한 답은 더는 처리 대기가 아니다");
    const status = ok(run_py(c, ["status", "synthetic-legacy-full"]), "status");
    assert.match(status.stdout, /^주제: 합성 도서관 운영 연구/m);
    assert.match(status.stdout, /^현재 단계: 조사/m);
    assert.match(status.stdout, /^처리 안 한 답: 1개/m);
    assert.deepEqual(c.sig(join(dir, "project.json")), json_sig, "활성화된 프로젝트의 읽기·mark 는 옛 project.json 을 건드리지 않는다");
  }));

test("list: DB 프로젝트와 project.json 만 있는 프로젝트가 한 번씩 나온다 (같은 슬러그는 중복되지 않음)", () =>
  with_cli(async (c) => {
    write_legacy(join(c.env.home.env.PES_HOME as string, "legacy-only"), plain_legacy("legacy-only"));
    const out = ok(run_py(c, ["list"]), "list").stdout;
    const count = (slug: string) => out.split("\n").filter((l) => l.includes(`(${slug})`)).length;
    assert.equal(count(SLUG), 1, `DB 프로젝트는 한 번 (폴더에 옛 project.json 이 같이 있어도): ${out}`);
    assert.equal(count("legacy-only"), 1, "옛 프로젝트도 목록에 나온다");
    assert.match(out, /합성 파일 주제/, "DB 프로젝트의 제목은 DB 의 주제");
    assert.doesNotMatch(out, /합성 옛 주제/);
  }));

// ---------------------------------------------------------------------------
// 3 · legacy (DB에 없는 프로젝트): 읽기는 v0.15 와 같고 쓰기는 이전 안내로 막힌다

test("legacy 읽기: DB 에 없는 프로젝트는 플래그가 켜져 있어도 v0.15 출력이고 바이트·mtime 이 불변이다", () =>
  with_cli(async (c) => {
    const folder = folder_of(c, "legacy-only");
    const json = write_legacy(folder, rich_legacy("legacy-only"));
    write_pending_answer(folder, "plan-R1-20260301-100000.json");
    const sig = c.sig(json);
    const tree = tree_digest(folder);
    const signature = state_signature(c.env.db);
    const roots = [c.env.home.root, `/private${c.env.home.root}`];
    for (const args of [["status", "legacy-only"], ["pending", "legacy-only"], ["digest", "legacy-only", "plan"], ["show", "legacy-only", "plan"], ["show", "legacy-only", "plan", "1"], ["watch", "legacy-only"], ["doctor", "legacy-only", "--json"]]) {
      const on = run_py(c, args);
      const off = run_py(c, args, { ...OFF });
      const label = args.join(" ");
      assert.equal(on.status, off.status, `${label}: 종료 코드`);
      assert.equal(normalize(on.stdout, roots), normalize(off.stdout, roots), `${label}: 출력이 플래그 없을 때와 같다`);
    }
    assert.deepEqual(c.sig(json), sig, "project.json 바이트·mtime 불변");
    assert.equal(tree_digest(folder), tree, "읽기는 폴더에 아무것도 만들지 않는다");
    assert.equal(state_signature(c.env.db), signature, "DB 불변");
  }));

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
      const res = run_py(c, args, { extra });
      expect_rejected(res, args[0]!);
      assert.match(res.stderr, /이전/, `${args[0]}: '이전' 안내 한국어 메시지: ${res.stderr}`);
      assert.deepEqual(c.sig(json), sig, `${args[0]}: project.json 불변`);
      assert.equal(tree_digest(folder), tree, `${args[0]}: 폴더에 reports/·out/·feedback/ 등을 만들지 않는다`);
    }
    assert.equal(state_signature(c.env.db), signature, "DB 불변");
  }));

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
    ok(run_py(c, ["round-start", SLUG, "plan"]), "round-start");
    ok(run_py(c, ["merge", SLUG, "plan", write_json(c, "r-items.json", PLAN_ITEMS)]), "merge");
    const json_sig = c.sig(c.project_json);

    const first = ok(run_py(c, ["report", SLUG, "plan"]), "report 1");
    assert.match(first.stdout, /^기획보고서:/m, "옛 출력의 머리말 '<이름>:' 유지");
    const object_id = report_object(c, "report", "plan");
    assert.ok(object_id, "기획 단계의 보고서 artifact (kind report)");
    const v1 = versions_of(c, object_id);
    assert.equal(v1.length, 1);
    assert.ok(first.stdout.includes(v1[0]!.id), `출력에 새 버전 id: ${first.stdout}`);
    const files1 = rendered_of(c, v1[0]!.id);
    const blob_rows = c.env.db.all<{ id: string; original_name: string }>("SELECT b.id, b.original_name FROM version_files vf JOIN blobs b ON b.id = vf.blob_id WHERE vf.version_id = ?", v1[0]!.id);
    for (const b of blob_rows) assert.ok(first.stdout.includes(b.original_name) && first.stdout.includes(b.id), `출력에 파일 이름과 위치(blob id): ${b.original_name}`);
    assert.ok(!existsSync(join(c.folder, "reports")), "DB 모드는 프로젝트 폴더 reports/ 에 쓰지 않는다 (원본은 DB·객체 저장소)");
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
    ok(run_py(c, ["merge", SLUG, "plan", write_json(c, "r-items2.json", [{ id: 1, sources: [{ title: "합성 출처 D", url: "https://example.invalid/d", method: "kosis" }] }])]), "merge 2");
    ok(run_py(c, ["report", SLUG, "plan"]), "report 2");
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
    ok(run_py(c, ["round-start", SLUG, "plan"]), "round-start");
    ok(run_py(c, ["merge", SLUG, "plan", write_json(c, "b-items.json", PLAN_ITEMS)]), "merge");
    const n = c.commits().length;
    ok(run_py(c, ["report", SLUG, "plan"]), "report");
    const added = c.commits_since(n);
    const actions = added.map((m) => m.action);
    // 영수증 action 은 명령 이름이 아니라 definition.action(사건 이름)이다: content.append_version → content.version_appended 등.
    // 첫 실행은 report artifact 를 만든다(content.artifact_added, 버전 1개 — 첫 report 시험과 같은 계약).
    for (const want of ["content.artifact_added", "file.upload_reserved", "file.upload_completed", "file.version_attached"]) {
      assert.ok(actions.includes(want), `${want} 영수증: [${actions}]`);
    }
    // 두 번째 실행은 같은 객체에 새 버전을 쌓는다(content.version_appended) — 덮어쓰기 없음.
    const n2 = c.commits().length;
    ok(run_py(c, ["report", SLUG, "plan"]), "report 2");
    const again = c.commits_since(n2).map((m) => m.action);
    for (const want of ["content.version_appended", "file.upload_reserved", "file.upload_completed", "file.version_attached"]) {
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
    ok(run_py(c, ["round-start", SLUG, "plan"]), "round-start");
    ok(run_py(c, ["merge", SLUG, "plan", write_json(c, "s-items.json", [PLAN_ITEMS[0]])]), "merge");
    ok(run_py(c, ["report", SLUG, "plan"]), "report");
    const rendered = ok(run_py(c, ["render", SLUG, "plan"]), "render");
    assert.match(rendered.stdout, /기획 R1 봉인.*항목 1개/, `보고서가 봉인 항목으로 세어지면 안 된다: ${rendered.stdout}`);
    const approved = ok(run_py(c, ["approve", SLUG, "plan"]), "approve");
    assert.match(approved.stdout, /조사 항목 1개 생성/, `인계는 기획 항목만: ${approved.stdout}`);
  }));

test("report 권한: 범위가 모자란 토큰·lease 없는 토큰·다른 세션의 잠금은 거부되고 아무것도 쓰지 않는다", () =>
  with_cli(async (c) => {
    ok(run_py(c, ["round-start", SLUG, "plan"]), "round-start");
    ok(run_py(c, ["merge", SLUG, "plan", write_json(c, "p-items.json", PLAN_ITEMS)]), "merge");
    const reader = await c.agent("report-reader", ["context:read"]);
    const bare = await c.agent("report-bare");
    const signature = state_signature(c.env.db);
    expect_rejected(run_py(c, ["report", SLUG, "plan"], { extra: { PES_TOKEN: reader.token } }), "읽기 범위 토큰");
    expect_rejected(run_py(c, ["report", SLUG, "plan"], { extra: { PES_TOKEN: bare.token } }), "claim 안 한 토큰");
    expect_rejected(run_py(c, ["report", SLUG, "plan"], { extra: { PES_TOKEN: "garbage-token" } }), "엉터리 토큰");
    assert.equal(state_signature(c.env.db), signature, "거부는 영수증·행을 남기지 않는다");
    ok(run_py(c, ["lock", SLUG], { extra: { PES_OWNER: "sess-report001" } }), "lock");
    const other = run_py(c, ["report", SLUG, "plan"], { extra: { PES_OWNER: "sess-report002" } });
    assert.equal(other.status, 3, "다른 세션이 쥔 lease: 종료 3");
    assert.equal(report_object(c, "report", "plan"), undefined);
    ok(run_py(c, ["report", SLUG, "plan"], { extra: { PES_OWNER: "sess-report001" } }), "같은 세션");
    assert.ok(report_object(c, "report", "plan"));
  }));

// ---------------------------------------------------------------------------
// 5 · assemble · web: 같은 문구, 각주 다시 매김, 새 버전

test("assemble: 각주를 출처 순서로 다시 매기고(같은 URL·제목은 한 번) 실행마다 새 버전을 쌓는다", () =>
  with_cli(async (c) => {
    ok(run_py(c, ["merge", SLUG, "write", write_json(c, "w-items.json", WRITE_ITEMS)]), "merge write");
    const json_sig = c.sig(c.project_json);
    const n = c.commits().length;
    const res = ok(run_py(c, ["assemble", SLUG]), "assemble");
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
    ok(run_py(c, ["merge", SLUG, "write", write_json(c, "w-items2.json", [{ id: 2, kind: "section", title: "2장", order: 2, status: "done", details: "둘째 장 [^1] [^2]", sources: [{ title: "합성 출처 C", url: "https://example.invalid/c", method: "search" }, { title: "합성 출처 A", url: "https://example.invalid/a", method: "law" }] }])]), "merge write 2");
    const again = ok(run_py(c, ["assemble", SLUG]), "assemble 2");
    assert.match(again.stdout, /\(장·절 2개, 각주 2개\)\s*$/m);
    const v2 = versions_of(c, object_id);
    assert.equal(v2.length, 2, "덮어쓰지 않고 새 버전");
    assert.deepEqual(v2[0], v1[0]);
    const md2 = file_named(rendered_of(c, v2[1]!.id), "report.md").text;
    assert.match(md2, /둘째 장 \[\^2\] \[\^1\]/, "장 안의 번호는 전체 각주 번호로 바뀐다 (C=2, A=1)");
    assert.equal(file_named(rendered_of(c, v1[0]!.id), "report.md").text, md, "버전 1 파일은 그대로");
    ok(run_py(c, ["assemble", SLUG]), "assemble 3 (내용 같음)");
    assert.equal(versions_of(c, object_id).length, 3, "내용이 같아도 실행마다 새 버전 (보고서처럼)");
    assert.ok(!existsSync(join(c.folder, "out")), "DB 모드는 프로젝트 폴더 out/ 에 쓰지 않는다");
    assert.deepEqual(c.sig(c.project_json), json_sig, "project.json 불변");
  }));

test("web: 최종 웹 보고서를 새 버전의 report.html 로 쌓고 출력 문구를 유지한다 (assemble 안 했으면 먼저 조립)", () =>
  with_cli(async (c) => {
    ok(run_py(c, ["merge", SLUG, "write", write_json(c, "web-items.json", WRITE_ITEMS)]), "merge write");
    const n = c.commits().length;
    const res = ok(run_py(c, ["web", SLUG]), "web");
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
    ok(run_py(c, ["web", SLUG, "--assemble"]), "web --assemble");
    assert.ok(versions_of(c, object_id).length > count, "--assemble 은 새 조립본(새 버전)을 만든다");
    const before = versions_of(c, object_id).length;
    ok(run_py(c, ["web", SLUG]), "web 다시 (내용 같음)");
    assert.equal(versions_of(c, object_id).length, before + 1, "web 도 내용이 같아도 실행마다 새 버전");
    assert.ok(!existsSync(join(c.folder, "out")), "DB 모드는 프로젝트 폴더 out/ 에 쓰지 않는다");
  }));

// ---------------------------------------------------------------------------
// 6 · watch: 같은 출력 형식, 따옴표 처리

test("watch: 한 줄 `tail -n0 -F <경로>/feedback.log | grep --line-buffered FEEDBACK` 형식 유지, 공백·따옴표 경로도 한 단어로 묶인다", () =>
  with_cli(async (c) => {
    const parent = "pes home (공백)'s";
    const home = join(c.env.home.root, parent);
    const signature = state_signature(c.env.db);
    for (const flag of ["1", undefined]) {
      const res = ok(run_py(c, ["watch", "some-project"], { flag, extra: { PES_HOME: home } }), `watch (flag ${flag})`);
      assert.equal(res.stdout.trim().split("\n").length, 1, "한 줄");
      const words = shell_words(res.stdout.trim());
      const expected = join(realpathSync.native(c.env.home.root), parent, "some-project", "feedback.log");
      assert.deepEqual(words.slice(0, 3), ["tail", "-n0", "-F"], `flag ${flag}`);
      assert.equal(words[3]!.split("\\").join("/"), expected.split("\\").join("/"), `경로가 따옴표로 한 단어: ${res.stdout}`);
      assert.deepEqual(words.slice(4), ["|", "grep", "--line-buffered", "FEEDBACK"]);
    }
    assert.ok(!existsSync(home), "watch 는 아무것도 만들지 않는다");
    assert.equal(state_signature(c.env.db), signature);
  }));

test("watch: DB 에만 있고 project.json 이 없는 프로젝트(init 으로 만든)도 같은 형식으로 출력한다", () =>
  with_cli(async (c) => {
    ok(run_py(c, ["init", "synthetic-init", "--topic", "합성 새 주제"]), "init");
    const res = ok(run_py(c, ["watch", "synthetic-init"]), "watch");
    const words = shell_words(res.stdout.trim());
    assert.deepEqual([words[0], words[1], words[2]], ["tail", "-n0", "-F"]);
    assert.match(words[3]!.split("\\").join("/"), /\/synthetic-init\/feedback\.log$/);
    assert.deepEqual(words.slice(4), ["|", "grep", "--line-buffered", "FEEDBACK"]);
  }));

// ---------------------------------------------------------------------------
// 7 · doctor: 기본 진단과 --fix 분리, 임시 홈만, DB·포트·경로 quoting

interface Row {
  group: string;
  level: "ok" | "info" | "warn" | "bad";
  title: string;
  detail: string;
  fixable?: boolean;
  fixed?: boolean;
}

function doctor_rows(res: CliResult, what: string): Row[] {
  assert.doesNotMatch(res.stderr, /Traceback/, `${what}: 스택 추적 없음`);
  try {
    return JSON.parse(res.stdout) as Row[];
  } catch {
    assert.fail(`${what}: doctor --json 은 JSON 배열이어야 한다\n${res.stdout}\n${res.stderr}`);
  }
}

test("doctor 기본 진단은 아무것도 고치지 않고, --fix 만 고친다: 임시 홈 안에서만", () =>
  with_cli(async (c) => {
    const folder = folder_of(c, "doc-legacy");
    const json = write_legacy(folder, plain_legacy("doc-legacy"));
    const tmp = join(folder, "project.json.tmp");
    writeFileSync(tmp, "{", "utf8");
    const fresh = join(c.env.home.root, "fresh pes home");
    const sig = c.sig(json);
    const signature = state_signature(c.env.db);
    const roots = [c.env.home.root, `/private${c.env.home.root}`];
    for (const flag of ["1", undefined]) {
      const plain = run_py(c, ["doctor", "--json"], { flag, extra: { PES_HOME: fresh } });
      const rows = doctor_rows(plain, `doctor (flag ${flag})`);
      assert.ok(!existsSync(fresh), `기본 진단은 PES 홈을 만들지 않는다 (flag ${flag})`);
      assert.ok(rows.some((r) => r.fixable === true), "고칠 수 있는 항목은 fixable 로 알린다");
      assert.ok(rows.every((r) => r.fixed !== true), "기본 진단은 고치지 않는다");
      const shown = normalize(plain.stdout + plain.stderr, roots);
      for (const real of [join(homedir(), ".pes"), join(homedir(), "pes-projects")]) {
        assert.equal(shown.includes(real), false, `실제 ${real} 를 읽거나 보이지 않는다 (임시 HOME·PES_HOME 만)`);
      }
    }
    const folder_rows = doctor_rows(run_py(c, ["doctor", "doc-legacy", "--json"]), "doctor doc-legacy");
    assert.ok(folder_rows.some((r) => r.title.includes("임시 파일") && r.fixable === true));
    assert.ok(existsSync(tmp), "기본 진단 뒤에도 임시 파일이 그대로");
    assert.deepEqual(c.sig(json), sig);
    assert.equal(state_signature(c.env.db), signature, "기본 진단은 DB 에 쓰지 않는다");

    const fixed = doctor_rows(run_py(c, ["doctor", "doc-legacy", "--fix", "--json"]), "doctor --fix");
    assert.ok(fixed.some((r) => r.title.includes("임시 파일") && r.fixed === true), "--fix 가 고친 항목을 알린다");
    assert.ok(!existsSync(tmp), "--fix 는 임시 파일을 지운다");
    assert.deepEqual(c.sig(json), sig, "--fix 도 project.json 은 건드리지 않는다");
    assert.equal(state_signature(c.env.db), signature, "--fix 도 DB 업무 행을 건드리지 않는다");

    const home_fix = run_py(c, ["doctor", "--fix", "--json"], { extra: { PES_HOME: fresh } });
    doctor_rows(home_fix, "doctor --fix (홈 없음)");
    assert.ok(existsSync(fresh), "--fix 는 (임시 홈 안의) PES 홈을 만든다");
  }));

test("doctor: DB 프로젝트(project.json 없음)를 '문제'로 보지 않고 데이터베이스 상태를 알린다", () =>
  with_cli(async (c) => {
    ok(run_py(c, ["init", "synthetic-init", "--topic", "합성 새 주제"]), "init");
    assert.ok(!existsSync(join(folder_of(c, "synthetic-init"), "project.json")));
    const signature = state_signature(c.env.db);
    const one = run_py(c, ["doctor", "synthetic-init", "--json"]);
    const rows = doctor_rows(one, "doctor synthetic-init");
    assert.ok(!rows.some((r) => r.group === "synthetic-init" && r.level === "bad"), `project.json 없음을 문제로 올리면 안 된다: ${JSON.stringify(rows.filter((r) => r.level === "bad"))}`);
    assert.ok(rows.some((r) => r.group === "synthetic-init" && r.level === "ok"), "DB 프로젝트 정상 행");
    const all = doctor_rows(run_py(c, ["doctor", "--json"]), "doctor");
    assert.ok(all.some((r) => r.group === "데이터베이스" && r.level === "ok"), "데이터베이스 그룹의 정상 행");
    assert.ok(all.some((r) => r.group === SLUG), "DB 에 있는 프로젝트가 진단 대상에 든다 (project.json 이 없어도)");
    assert.ok(all.some((r) => r.group === "synthetic-init"));
    assert.equal(state_signature(c.env.db), signature, "doctor 는 DB 를 읽기만 한다");
  }));

test("doctor: 깨진 DB 는 문제로 알리고(스택 추적 없음) --fix 로도 DB 를 건드리지 않는다", () => {
  const home = isolated_home("pes-sel49-doc-");
  try {
    const like: HomeLike = { env: { home } };
    const db = join(home.root, "home", ".pes", "pes.db");
    mkdirSync(join(home.root, "home", ".pes"), { recursive: true });
    writeFileSync(db, "이것은 SQLite 파일이 아니다 ".repeat(40), "utf8");
    const before = readFileSync(db);
    for (const args of [["doctor", "--json"], ["doctor", "--fix", "--json"]]) {
      const res = run_py(like, args);
      const rows = doctor_rows(res, args.join(" "));
      assert.equal(res.status, 1, "문제가 있으면 종료 1");
      assert.ok(rows.some((r) => r.group === "데이터베이스" && r.level === "bad"), `데이터베이스 문제 행: ${res.stdout}`);
      assert.ok(rows.every((r) => !(r.group === "데이터베이스" && r.fixable === true)), "DB 는 doctor 가 스스로 고치지 않는다");
      assert.ok(readFileSync(db).equals(before), "DB 파일 바이트 불변");
    }
  } finally {
    home.cleanup();
  }
});

test("doctor: 서버 포트를 PES 가 아닌 프로그램이 쥐고 있으면 소유 프로세스(pid)와 함께 알린다", async (t) => {
  const holder = spawn(
    process.execPath,
    [
      "-e",
      `const net=require("node:net");const held=[];let left=5;const done=()=>{if(--left===0)console.log("HELD "+JSON.stringify(held));};
for(const p of [8760,8761,8762,8763,8764]){const s=net.createServer(k=>k.end("not http\\r\\n"));s.once("error",done);s.listen(p,"127.0.0.1",()=>{held.push(p);done();});}
setInterval(()=>{},1000);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const tool = process.platform === "darwin" ? ["lsof", ["-v"]] : process.platform === "win32" ? ["netstat", ["-h"]] : ["ss", ["--version"]];
  const probe = spawnSync(tool[0] as string, tool[1] as string[], { encoding: "utf8" });
  const owner_tool_missing = probe.error !== undefined && (probe.error as NodeJS.ErrnoException).code === "ENOENT";
  const c = await make_cli_env();
  try {
    const held: number[] = await new Promise((resolve, reject) => {
      let buf = "";
      holder.stdout!.on("data", (d: Buffer) => {
        buf += d.toString();
        const m = buf.match(/HELD (\[.*\])/);
        if (m) resolve(JSON.parse(m[1]!) as number[]);
      });
      holder.once("error", reject);
      setTimeout(() => reject(new Error("포트 점유 도우미가 응답하지 않음")), 15_000);
    });
    if (held.length === 0) {
      t.skip("8760~8764 가 모두 이미 쓰이고 있어 시험용 점유를 만들 수 없다");
      return;
    }
    const rows = doctor_rows(run_py(c, ["doctor", "--json"], { timeout: 120_000 }), "doctor");
    for (const port of held) {
      const row = rows.find((r) => r.group === "서버" && r.title.includes(`:${port}`));
      assert.ok(row, `포트 ${port} 점유 행: ${JSON.stringify(rows.filter((r) => r.group === "서버"))}`);
      assert.equal(row.level, "warn", "PES 가 아닌 프로그램이 쥔 포트는 주의");
      if (owner_tool_missing) assert.ok(row.detail.includes(String(holder.pid)) || row.detail.includes("확인 불가"), `소유 도구가 없으면 '확인 불가' 허용: ${row.detail}`);
      else assert.ok(row.detail.includes(String(holder.pid)), `소유 프로세스 pid ${holder.pid} 를 알린다: ${row.detail}`);
    }
  } finally {
    holder.kill();
    c.close();
  }
});

test("doctor: 공백·따옴표·괄호가 든 PES 홈 경로는 명령 quoting 위험으로 알리고, 깨끗한 경로는 알리지 않는다", () =>
  with_cli(async (c) => {
    const risky = join(c.env.home.root, "pes home (공백)'s");
    mkdirSync(risky, { recursive: true });
    const rows = doctor_rows(run_py(c, ["doctor", "--json"], { extra: { PES_HOME: risky } }), "doctor (위험한 경로)");
    const hit = rows.find((r) => r.group === "환경" && /경로/.test(r.title) && /공백|따옴표|괄호|특수/.test(r.title));
    assert.ok(hit, `경로 quoting 경고 행: ${JSON.stringify(rows.filter((r) => r.group === "환경").map((r) => r.title))}`);
    assert.equal(hit.level, "warn");
    assert.ok(hit.fixable !== true, "경로는 doctor --fix 가 바꾸지 않는다");
    const clean = doctor_rows(run_py(c, ["doctor", "--json"]), "doctor (깨끗한 경로)");
    assert.ok(!clean.some((r) => r.group === "환경" && /경로/.test(r.title) && /공백|따옴표|괄호|특수/.test(r.title)), "깨끗한 경로에는 경고가 없다");
  }));

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
    const stamp = md.match(/^- 작성 (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · PES$/m)?.[1];
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

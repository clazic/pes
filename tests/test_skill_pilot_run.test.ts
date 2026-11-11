/**
 * SEL-50 PR17 — core+plan 파일럿 합성 1회 (tester, 작성 모드).
 *
 * 완료 조건: "core+plan 파일럿이 합성 1회를 통과한 뒤 전체 스킬로 넓힌다" · "업무 경로별 검증 명령 사용을 확인한다(문자열 0건만이 아님)".
 * 이 시험은 LLM 을 돌리지 않는다. skills/core·skills/plan 문서가 지시하는 pes 명령 열(시작 → 질문 → 라운드 → 결과 병합 →
 * 화면 → 독립 검토 → 승인 → 보고서)을 문서에서 확인하고, 그 열을 임시 HOME·PES_HOME 의 합성 프로젝트에 차례로 실행한다.
 * 플래그 없음(v0.15)과 PES_DB_CORE=1(새 DB 경로) 둘 다 성공해야 한다 — 문서는 플래그를 말하지 않아도 같은 명령이다.
 *
 * 파일을 나눈 이유: 명령마다 Python 을 띄워 느리다(Windows 는 3~10배). CI 는 시험 파일을 8조각으로 나눠 돈다.
 * Windows 점검표: python -X utf8 (-I 는 PYTHONIOENCODING 을 무시), 출력은 CRLF→LF 정규화, 경로 비교는 realpath.native.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { disk_path } from "./helpers/blob_env.ts";
import { make_cli_env, type CliEnv } from "./helpers/cli_write_env.ts";
import { mentioned_commands, pes_cmds, REPO, repo_doc } from "./helpers/skill_docs.ts";
import { run_cli } from "./helpers/cli_read_env.ts";

const SLUG = "pilot-synth";
const CMDS = pes_cmds();

interface Step {
  /** 문서가 지시해야 하는 pes 명령 이름. */
  command: string;
  args: (ctx: Ctx) => string[];
  env?: Record<string, string | undefined>;
}

interface Ctx {
  c: CliEnv;
  spec: string;
  items: string;
  qa: string;
  summary: string;
}

/** 문서(core·plan)가 말하는 기획 한 바퀴. 순서는 core 「단계 생명주기」: 시작 질문 → 라운드 → 병합 → 화면 → 독립 검토 → 승인 → 보고서. */
const PILOT: Step[] = [
  { command: "init", args: () => ["init", SLUG, "--topic", "합성 파일럿 주제"] },
  { command: "lock", args: () => ["lock", SLUG] },
  { command: "ask-prep", args: () => ["ask-prep", SLUG, "plan"] },
  { command: "ask", args: (x) => ["ask", SLUG, x.spec] },
  { command: "round-start", args: () => ["round-start", SLUG, "plan"] },
  { command: "merge", args: (x) => ["merge", SLUG, "plan", x.items] },
  { command: "render", args: () => ["render", SLUG, "plan"] },
  { command: "digest", args: () => ["digest", SLUG, "plan", "--round", "1"] },
  { command: "show", args: () => ["show", SLUG, "plan", "1"] },
  // SEL-50: 단계 요약은 note 가 아니라 전용 명령 set 으로 (보고서 '1. 요약' 의 재료). 플래그 켜짐에서는 코어 대응이 없으면 분명한 거부도 허용.
  { command: "set", args: (x) => ["set", SLUG, "plan", "summary", x.summary] },
  { command: "qa-brief", args: () => ["qa-brief", SLUG, "plan"] },
  { command: "qa", args: (x) => ["qa", SLUG, "plan", "--file", x.qa] },
  { command: "note", args: () => ["note", SLUG, "합성 인계 메모"] },
  { command: "approve", args: () => ["approve", SLUG, "plan"] },
  { command: "report", args: () => ["report", SLUG, "plan"] },
  { command: "status", args: () => ["status", SLUG] },
  { command: "unlock", args: () => ["unlock", SLUG] },
];

const ITEMS = [
  { id: 1, kind: "rq", title: "합성 연구 질문", summary: "왜 필요한가", status: "done", depth: 0, updated_round: 1 },
  { id: 2, kind: "chapter", title: "합성 장", summary: "장 요약", details: "절 구성", order: 1, links: { plan: [1] }, status: "done" },
  { id: 3, kind: "topic", title: "합성 조사 항목", summary: "조사 요약", question: "무엇을 조사하나", links: { plan: [2, 1] }, status: "done" },
];

const SUMMARY_TEXT = "합성 파일럿 기획 요약 (근거: 기획 #1·#3)";

const QA = { verdict: "pass", summary: "합성 검토", qc: [], qa: [], spot_checks: [], missed_by_self_review: [], evidence_gaps: [] };

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function run_pes(c: CliEnv, args: string[], extra: Record<string, string | undefined>) {
  const res = run_cli(c, args, { extra, timeout: 90_000 }); // 가드 아래 node scripts/pes.ts, 격리된 HOME·USERPROFILE·PES_HOME
  return { status: res.status, stdout: normalize(res.stdout), stderr: normalize(res.stderr) };
}

function prepare(c: CliEnv): Ctx {
  const root = c.env.home.root;
  const spec = join(root, "pilot-ask-spec.json");
  copyFileSync(join(REPO, "questions", "plan.json"), spec);
  const items = join(root, "pilot-items.json");
  writeFileSync(items, JSON.stringify(ITEMS), "utf8");
  const qa = join(root, "pilot-qa.json");
  writeFileSync(qa, JSON.stringify(QA), "utf8");
  const summary = join(root, "pilot-summary.txt");
  writeFileSync(summary, SUMMARY_TEXT, "utf8");
  return { c, spec, items, qa, summary };
}

// ---------------------------------------------------------------------------
// 문서 쪽: 파일럿 명령 열은 core+plan 문서가 실제로 지시하는 것이다

test("파일럿: 명령 열의 모든 명령이 pes.ts 명령표(CMDS)에 있고 core+plan 문서가 지시한다", () => {
  const docs = new Set([...mentioned_commands(repo_doc("skills/core/SKILL.md"), CMDS), ...mentioned_commands(repo_doc("skills/plan/SKILL.md"), CMDS)]);
  const missing_from_cli = PILOT.filter((s) => !CMDS.includes(s.command)).map((s) => s.command);
  assert.deepEqual(missing_from_cli, [], "pes.ts 명령표에 없는 명령");
  const missing_from_docs = PILOT.filter((s) => !docs.has(s.command)).map((s) => s.command);
  assert.deepEqual(missing_from_docs, [], `core·plan 문서가 지시하지 않는 명령 (문서가 가진 명령: ${[...docs].sort().join(" ")})`);
});

test("파일럿: 기획 항목을 만드는 길은 직접 쓰기가 아니라 merge(또는 submit) 로 문서에 적혀 있다", () => {
  const plan = repo_doc("skills/plan/SKILL.md");
  const here = mentioned_commands(plan, CMDS);
  assert.ok(here.has("merge") || here.has("submit"), `plan 스킬이 항목 입력에 merge/submit 을 지시하지 않는다 (지시: ${[...here].sort().join(" ")})`);
  assert.doesNotMatch(plan, /Python으로 `stages\.plan\.items`에 직접 쓴다/);
});

// ---------------------------------------------------------------------------
// 실행 쪽: 그 열을 합성 프로젝트에 차례로 돌린다 (SEL-74: 플래그 없음(v0.15) 열과 PES_DB_CORE=1 열은 하나가 됐다 — 늘 DB)

async function drive(): Promise<void> {
  const c = await make_cli_env();
  try {
    const x = prepare(c);
    // core 문서 「여러 프로젝트」: 세션 처음에 정한 ID 를 모든 pes 호출에 PES_OWNER 로 붙인다.
    const extra_flag: Record<string, string | undefined> = { PES_OWNER: "sess-pilot0001" };
    for (const step of PILOT) {
      const args = step.args(x);
      const res = run_pes(c, args, { ...extra_flag, ...(step.env ?? {}) });
      assert.equal(res.status, 0, `pes ${args.join(" ")} → 종료 ${res.status}\n${res.stderr}${res.stdout}`);
      assert.doesNotMatch(res.stderr, /Traceback|SyntaxError|ModuleNotFoundError|UnicodeEncodeError/, `${step.command}: 충돌이 아니라 정상 종료여야 한다`);
      if (["status", "digest", "show", "report", "approve"].includes(step.command)) {
        assert.ok(res.stdout.trim().length > 0, `${step.command}: 출력이 있다`);
      }
    }
    const folder = join(c.env.home.env.PES_HOME as string, SLUG);
    assert.ok(!existsSync(join(folder, "project.json")), "project.json 을 만들지 않는다 (직접 쓰기 0)");
    const projects = c.env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM projects WHERE slug = ?", SLUG);
    assert.equal(projects?.n, 1n, "프로젝트가 DB 에 생겼다");
    const row = c.env.db.get<{ storage_key: string }>(
      `SELECT b.storage_key FROM artifacts a
         JOIN object_versions ov ON ov.object_id = a.object_id
         JOIN version_files vf ON vf.version_id = ov.id
         JOIN blobs b ON b.project_id = vf.project_id AND b.id = vf.blob_id
        WHERE a.project_id = (SELECT id FROM projects WHERE slug = ?) AND a.kind = 'report' AND b.original_name = 'report.md'
        ORDER BY ov.version_no DESC`,
      SLUG,
    );
    assert.ok(row, "DB 단계 보고서 report.md");
    const md = normalize(readFileSync(disk_path(c.env, row), "utf8"));
    assert.ok(md.includes(`## 1. 요약\n\n${SUMMARY_TEXT}`), "보고서 '요약' 이 note 가 아니라 set 한 값으로 채워졌다");
    assert.doesNotMatch(md, /\(요약 없음/, "빈 요약 안내가 없다");
    // pes.ts 는 0.15 호환으로 폴더에도 같은 보고서를 둔다
    const report = normalize(readFileSync(join(folder, "reports", "plan", "report.md"), "utf8"));
    assert.ok(report.includes(`## 1. 요약\n\n${SUMMARY_TEXT}`), "폴더 보고서의 '요약' 도 set 한 값");
    const actions = c.commits().map((m) => m.action);
    for (const want of ["project.created", "round.started", "round.sealed", "stage.approved"]) {
      assert.ok(actions.includes(want), `영수증 ${want} 이 남아야 한다 (실제: ${actions.join(",")})`);
    }
    const status = run_pes(c, ["status", SLUG], extra_flag);
    assert.match(status.stdout, /기획 .*approved|승인/, "기획이 승인됐다");
  } finally {
    c.close();
  }
}

test("파일럿 합성 1회: 문서의 명령 열이 끝까지 성공한다 (project.json 직접 쓰기 0, 영수증이 남는다)", async () => {
  await drive();
});

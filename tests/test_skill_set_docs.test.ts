/**
 * SEL-50 PR17 — 스킬 문서가 단계 요약·변경점·남은 일·설정·점검·최종 요약/결론을 `pes set` 으로 지시한다 (tester, 작성 모드).
 * 구현 전이므로 새 시험은 실패하는 것이 정상이다. CLI 계약은 test_cli_set_*.test.ts, 업무 경로별 명령 존재는 test_skill_lint.test.ts 의 ROUTES.
 *
 * 문제: mid 구현은 이 값들을 쓸 전용 명령이 없어 note·section 으로 돌렸고(문서 곳곳의 "`note`로 남긴다"), v0.15 보고서가 읽는 필드가 비었다.
 *
 * 해석 12 문서가 지시해야 하는 모양: 코드 조각이나 명령 예제에 `set <dir> <stage> <field> <파일|->` (단계 필드 5개) 또는
 *         `set <dir> project <field> <파일|->` (executive_summary·conclusion). core 에는 일곱 필드가 모두 있고, 단계 스킬(plan·research·
 *         analyze·write·verify)은 각자 단계 요약(summary)을 set 으로 쓰게 한다. 최종 요약·결론은 core·write·verify·publish 중에 있다.
 * 해석 13 우회 금지: 단계 요약·변경점·남은 일(carry_over)을 `note` 로 남기라는 줄이 문서에 없다. 인계 메모(note) 자체는 그대로 쓴다.
 *         한 줄에 `set` 명령도 함께 있으면(둘의 역할을 구분해서 설명하는 줄) 통과한다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { code_segments, doc, fence, make_tree, mentioned_commands, PES_USAGE, pes_cmds, read_text, repo_doc, run_lint, target_docs } from "./helpers/skill_docs.ts";

const CMDS = pes_cmds();
const STAGE_FIELDS = ["summary", "changes", "carry_over", "settings", "review"];
const PROJECT_FIELDS = ["executive_summary", "conclusion"];

/** 문서의 코드 조각에서 `set <dir> <대상> <필드>` 로 부른 (대상, 필드) 쌍. 대상은 단계 이름·`<stage>`·`<단계>`·project 어느 것이든 그대로 둔다. */
function set_calls(markdown: string): Array<{ target: string; field: string }> {
  const out: Array<{ target: string; field: string }> = [];
  for (const seg of code_segments(markdown)) {
    for (const raw of seg.text.split("\n")) {
      for (const piece of raw.split(/&&|\|\||;/)) {
        const m = /(?:^|\s)set\s+(?:"[^"]*"|'[^']*'|\S+)\s+(\S+)\s+([a-z_]+)(?=\s|$|`)/.exec(piece.trim().replace(/^[$>]\s+/, ""));
        if (m !== null) out.push({ target: m[1]!.replace(/[`"']/g, ""), field: m[2]! });
      }
    }
  }
  return out;
}

const is_project = (t: string) => t === "project";

test("pes.ts 명령표(CMDS)에 set 이 있다", () => {
  assert.ok(CMDS.includes("set"), "scripts/pes_core/cli_main.ts CMDS 에 set 명령");
});

test("pes.ts 사용법에 set 두 꼴이 적혀 있다", () => {
  const usage = PES_USAGE;
  assert.match(usage, /^\s*set <dir> <stage> <field>/m, "사용법: set <dir> <stage> <field> …");
  assert.match(usage, /set <dir> project <field>/, "사용법: set <dir> project <field> …");
});

test("core 스킬: 단계 필드 5개와 project 필드 2개를 모두 set 으로 쓰게 한다", () => {
  const calls = set_calls(repo_doc("skills/core/SKILL.md"));
  const stage_seen = new Set(calls.filter((c) => !is_project(c.target)).map((c) => c.field));
  const project_seen = new Set(calls.filter((c) => is_project(c.target)).map((c) => c.field));
  for (const f of STAGE_FIELDS) assert.ok(stage_seen.has(f), `core: set <dir> <단계> ${f} 예제가 없다 (본 것: ${[...stage_seen].join(",")})`);
  for (const f of PROJECT_FIELDS) assert.ok(project_seen.has(f), `core: set <dir> project ${f} 예제가 없다 (본 것: ${[...project_seen].join(",")})`);
});

test("core 명령표에 set 행이 있다 (첫 칸 `set …`)", () => {
  const rows = repo_doc("skills/core/SKILL.md")
    .split("\n")
    .filter((l) => l.startsWith("|"));
  assert.ok(rows.some((r) => /^\|\s*`set\s/.test(r)), "명령표(첫 칸)에 `set <dir> …` 행");
});

for (const stage of ["plan", "research", "analyze", "write", "verify"] as const) {
  test(`${stage} 스킬: 단계 요약을 set summary 로 쓰게 한다`, () => {
    const text = repo_doc(`skills/${stage}/SKILL.md`);
    assert.ok(mentioned_commands(text, CMDS).has("set"), `${stage}: set 명령을 지시하지 않는다`);
    const hit = set_calls(text).filter((c) => c.field === "summary" && !is_project(c.target));
    assert.ok(hit.length > 0, `${stage}: set <dir> ${stage} summary 예제가 없다`);
    assert.ok(hit.every((c) => c.target === stage || c.target.startsWith("<")), `${stage}: 대상이 이 단계(또는 <stage> 자리표시)다 (본 것: ${hit.map((c) => c.target).join(",")})`);
  });
}

test("최종 요약·결론(project executive_summary·conclusion)을 core·write·verify·publish 중 어디서든 set 으로 쓰게 한다", () => {
  const seen = new Set<string>();
  for (const rel of ["skills/core/SKILL.md", "skills/write/SKILL.md", "skills/verify/SKILL.md", "skills/publish/SKILL.md"]) {
    for (const c of set_calls(repo_doc(rel))) if (is_project(c.target)) seen.add(c.field);
  }
  for (const f of PROJECT_FIELDS) assert.ok(seen.has(f), `set <dir> project ${f} 를 지시하는 문서가 없다 (본 것: ${[...seen].join(",")})`);
});

test("우회 금지: 단계 요약·변경점·남은 일을 note 로 남기라는 줄이 없다 (해석 13)", () => {
  const WORKAROUND = /변경점|단계 요약|기획 요약|쟁점 3~5줄|carry_over|남은 일|요약\(`note`\)/;
  const bad: string[] = [];
  for (const rel of target_docs()) {
    repo_doc(rel)
      .split("\n")
      .forEach((line, i) => {
        if (!line.includes("`note`") || !WORKAROUND.test(line)) return;
        if (/(^|[\s`(])set\s/.test(line) || line.includes("`set")) return; // 역할을 구분해 설명하는 줄
        bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
      });
  }
  assert.deepEqual(bad, [], "set 으로 써야 할 값을 note 로 남기라는 줄");
});

test("우회 금지: 전용 명령이 없다는 안내(한계 문구)가 문서·어댑터 노트에서 사라졌다", () => {
  const stale = /전용\s*(?:pes\s*)?명령(?:이|은)\s*(?:아직\s*|지금\s*)?없/;
  const bad = target_docs().filter((rel) => stale.test(repo_doc(rel)));
  assert.deepEqual(bad, [], "'전용 명령이 없다' 는 옛 한계 문구가 남은 문서");
});

test("우회 금지: 최종 요약·결론을 제목이 '요약'·'결론'인 section 항목으로 병합하라는 문구가 없다 — executive_summary·conclusion 필드로 간다", () => {
  const bad: string[] = [];
  for (const rel of target_docs()) {
    repo_doc(rel)
      .split("\n")
      .forEach((line, i) => {
        if (/제목이\s*`?요약`?[·,\s]*`?결론`?인\s*section/.test(line) || /제목이 `요약`·`결론`인 section/.test(line)) bad.push(`${rel}:${i + 1}`);
      });
  }
  assert.deepEqual(bad, [], "요약·결론을 section 항목으로 돌리는 문구");
});

test("lint 는 set 예제를 거짓 양성으로 막지 않는다 (직접 쓰기가 아니다)", () => {
  const tree = make_tree({
    "skills/core/SKILL.md": doc(
      fence(
        "bash",
        '$PES set "$DIR" plan summary "$DIR/rounds/plan-R1/summary.txt"',
        '$PES set "$DIR" plan carry_over "$DIR/rounds/plan-R1/carry.json"',
        '$PES set "$DIR" project conclusion -',
      ),
      "인라인 예: `set <dir> research changes <파일>`.",
    ),
  });
  try {
    const res = run_lint(tree.root);
    assert.equal(res.status, 0, res.out);
  } finally {
    tree.cleanup();
  }
});

test("lint 는 set 이 있어도 project.json 직접 쓰기는 여전히 막는다", () => {
  const tree = make_tree({
    "skills/core/SKILL.md": doc(
      fence(
        "bash",
        '$PES set "$DIR" plan summary file.txt',
        `python3 -I - "$DIR" <<'EOF'`,
        "import json, sys; from pathlib import Path",
        'f = Path(sys.argv[1]) / "project.json"; p = json.loads(f.read_text())',
        "f.write_text(json.dumps(p, ensure_ascii=False, indent=1))",
        "EOF",
      ),
    ),
  });
  try {
    const res = run_lint(tree.root);
    assert.notEqual(res.status, 0, "직접 쓰기는 set 이 있어도 위반");
    assert.match(res.out, /skills\/core\/SKILL\.md/);
  } finally {
    tree.cleanup();
  }
});

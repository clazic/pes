/**
 * SEL-50 PR17 r1-1 필수 2·4·5 (문서 쪽) — 스킬 문서가 지시하는 길이 실제로 동작하는 길이고, 옛 절차가 약해지지 않았다 (tester, 작성 모드 회귀).
 *
 * 해석 R4 (필수 4, leader 결정 4)
 *   (가) `context`·`claim`·`submit`·`wait`·`complete` 는 PES_DB_CORE=1 에서만 동작한다(플래그 없이는 종료 2). 그러므로 이 다섯 명령을 코드로 부른
 *        문서 줄(인라인 코드 첫 낱말, 표 칸, 코드 블록)은 같은 줄(코드 블록은 바로 앞 두 줄)에 "DB" 또는 "PES_DB_CORE" 또는 "토큰"을 말해 구분한다.
 *   (나) 기본 경로의 답 읽기는 `pending` 으로 얻은 답 파일(feedback/…json)을 읽는 것이다: core·plan·research 문서에 `pending` 과 답 파일 읽기가 한 문장에 있다.
 *   (다) core 는 다섯 명령을 한곳에서 "DB 경로에서 쓰는 명령"으로 구분해 적는다(한 줄에 셋 이상 + DB).
 *   (라) 플래그 없이 `context` 를 부르면 한국어 거부와 종료 2 — 문서가 구분해 적는 이유다(CLI 계약, 파일럿 열의 `context` 는 모드별로 고정).
 * 해석 R2 (필수 2) research 문서에 user_links 의 상태 추적 절차가 있다: user_links 근처에서 병합(merge)·status·done·failed 를 모두 말한다.
 * 해석 R5 (필수 5) `changes` 에 "한 줄 더하기"를 지시하는 모든 줄은 (그 줄과 이어지는 두 줄 안에서) 읽는 길 `--fields changes` 또는 "전체 배열"을 함께 말한다.
 *        core 에는 읽는 길(`show <dir> <단계> --fields changes`)과 '이미 쓴 줄을 포함한 전체 배열을 다시 쓴다'가 있다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { OWNER, open_mode, ok } from "./helpers/state_modes.ts";
import { code_segments, explicit_command, repo_doc, target_docs } from "./helpers/skill_docs.ts";

const DB_ONLY = ["context", "claim", "submit", "wait", "complete"];
const DB_MARK = /DB|PES_DB_CORE|토큰/;

function first_word(text: string): string {
  return (/^\s*(?:\$\{?PES\}?\s+)?([a-z][a-z-]*)(?=\s|$)/.exec(text.trim().replace(/^[$>]\s+/, ""))?.[1] ?? "");
}

/** 인라인 코드가 인자까지 가진 호출(`claim <dir> …`)인 경우만 센다. 낱말 하나(`claim`, kind=`claim`)는 이름 언급이라 지시가 아니다. */
function db_only_calls(text: string): string[] {
  const out: string[] = [];
  for (const seg of code_segments(text)) {
    for (const raw of seg.text.split("\n")) {
      for (const piece of raw.split(/&&|\|\||;/)) {
        const name = explicit_command(piece) ?? first_word(piece);
        if (DB_ONLY.includes(name) && /^\s*(?:\$\{?PES\}?\s+)?[a-z][a-z-]*\s+\S/.test(piece.trim().replace(/^[$>]\s+/, ""))) out.push(name);
      }
    }
  }
  return out;
}

/** 줄 번호(0부터) 별로 DB 전용 명령을 코드로 부른 줄을 찾는다. 코드 블록 줄은 펜스 앞 두 줄까지 구분 말을 찾는다. */
function undistinguished_db_calls(markdown: string): string[] {
  const lines = markdown.split("\n");
  const bad: string[] = [];
  let in_fence = false;
  let fence_ctx = "";
  lines.forEach((line, i) => {
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      in_fence = !in_fence;
      if (in_fence) fence_ctx = lines.slice(Math.max(0, i - 2), i).join("\n");
      return;
    }
    if (in_fence) {
      const hit = line.split(/&&|\|\||;/).some((piece) => DB_ONLY.includes(explicit_command(piece) ?? first_word(piece)));
      if (hit && !DB_MARK.test(line) && !DB_MARK.test(fence_ctx)) bad.push(`${i + 1}: ${line.trim().slice(0, 100)}`);
      return;
    }
    if (db_only_calls(line).length > 0 && !DB_MARK.test(line)) bad.push(`${i + 1}: ${line.trim().slice(0, 100)}`);
  });
  return bad;
}

// ---------------------------------------------------------------------------
// 필수 4

for (const rel of target_docs()) {
  test(`${rel}: DB 전용 명령(context·claim·submit·wait·complete)을 부른 줄은 DB 경로라고 구분한다`, () => {
    const bad = undistinguished_db_calls(repo_doc(rel));
    assert.deepEqual(bad, [], "플래그 없이는 거부되는 명령을 기본 경로처럼 지시하는 줄");
  });
}

for (const stage of ["core", "plan", "research"] as const) {
  test(`${stage} 스킬: 기본 경로의 답 읽기는 pending 으로 얻은 답 파일을 읽는 것이라고 적는다`, () => {
    const text = repo_doc(`skills/${stage}/SKILL.md`);
    const lines = text.split("\n");
    const hit = lines.some((l, i) => /`pending[^`]*`/.test(l) && /(답 파일|feedback|답을 읽|파일을 읽|읽는다|읽어)/.test(`${l}\n${lines[i + 1] ?? ""}`));
    assert.ok(hit, `${stage}: \`pending\` 으로 답 파일을 얻어 읽는다는 문장이 없다`);
  });
}

test("core 스킬: 다섯 DB 전용 명령을 한곳에서 'DB 경로에서 쓰는 명령'으로 구분해 적는다", () => {
  const lines = repo_doc("skills/core/SKILL.md").split("\n");
  const row = lines.some((l) => DB_MARK.test(l) && DB_ONLY.filter((c) => l.includes(`\`${c}`)).length >= 3);
  const each = DB_ONLY.every((c) => lines.some((l) => l.includes(`\`${c}`) && DB_MARK.test(l)));
  assert.ok(row || each, "core: context·claim·submit·wait·complete 를 DB 경로 명령으로 구분한 줄(한 줄에 셋 이상, 또는 각각)이 없다");
});

test("plan·research·core 가 받은 답 읽기를 context 로 시키지 않는다 (DB 구분 없는 줄 0)", () => {
  const bad: string[] = [];
  for (const rel of ["skills/core/SKILL.md", "skills/plan/SKILL.md", "skills/research/SKILL.md"]) {
    repo_doc(rel)
      .split("\n")
      .forEach((l, i) => {
        if (/`context\b/.test(l) && !DB_MARK.test(l)) bad.push(`${rel}:${i + 1}: ${l.trim().slice(0, 100)}`);
      });
  }
  assert.deepEqual(bad, []);
});

// (the test "플래그 없이 context 는 한국어로 거부되고 종료 2" is gone: there is no flag any more — pes.ts `context` always runs on the database; its arguments and exit codes are test_sel74_b_db_commands.)
// ---------------------------------------------------------------------------
// 필수 2 (문서)

test("research 스킬: user_links 상태 추적 절차(병합 → done/failed)가 있다", () => {
  const lines = repo_doc("skills/research/SKILL.md").split("\n");
  const windows = lines.map((_, i) => lines.slice(i, i + 3).join("\n")).filter((w, i) => lines[i]!.includes("user_links"));
  assert.ok(windows.length > 0, "research 가 user_links 를 말하지 않는다");
  const ok_window = windows.some((w) => /merge|병합/.test(w) && /status/.test(w) && /done/.test(w) && /failed/.test(w));
  assert.ok(ok_window, "user_links 근처에서 병합 후 status 를 done/failed 로 바꾸는 절차를 말해야 한다");
});

test("plan 스킬: topic 의 reuse 를 제안 파일에 담아 merge 로 넘기라고 지시한다 (옛 직접 쓰기 아님)", () => {
  const text = repo_doc("skills/plan/SKILL.md");
  assert.match(text, /`reuse`/);
  const lines = text.split("\n");
  assert.ok(lines.some((l) => /reuse/.test(l) && /merge/.test(l)), "reuse 와 merge 를 함께 말하는 줄");
  assert.doesNotMatch(text, /stages\.plan\.items.{0,40}직접/);
});

test("core 명령표: merge 설명에 request·reuse·model·user_links 의 병합 규칙이 있다", () => {
  const row = repo_doc("skills/core/SKILL.md")
    .split("\n")
    .find((l) => /^\|\s*`merge\s/.test(l));
  assert.ok(row, "merge 행");
  for (const word of ["request", "reuse", "model", "user_links"]) assert.ok(row!.includes(word), `merge 행에 ${word} 규칙이 있어야 한다`);
});

// ---------------------------------------------------------------------------
// 필수 5 (문서)

test("core 스킬: 현재 changes 를 읽는 길(show … --fields changes)과 '전체 배열을 다시 쓴다'가 있다", () => {
  const text = repo_doc("skills/core/SKILL.md");
  const reads = code_segments(text).some((s) => /\bshow\b[^\n]*--fields\s+[a-z_,]*changes/.test(s.text));
  assert.ok(reads, "show <dir> <단계> --fields changes 를 코드로 보인 곳이 없다");
  assert.match(text, /전체 (?:배열|목록)[^\n]*(?:다시|통째)|(?:다시|통째)[^\n]*전체 (?:배열|목록)/, "이미 쓴 줄을 포함한 전체 배열을 다시 쓴다는 지시");
  assert.match(text, /이미 쓴 줄/);
});

test("changes 에 '한 줄 더하기'를 지시하는 모든 줄이 읽는 길 또는 전체 배열 규칙을 함께 말한다", () => {
  const bad: string[] = [];
  for (const rel of target_docs()) {
    const lines = repo_doc(rel).split("\n");
    lines.forEach((l, i) => {
      const adds = /(?:변경점|changes)(?:\(`[^`]*`\))?에\s*한 줄/.test(l);
      if (!adds) return;
      const near = lines.slice(i, i + 3).join("\n");
      if (!/--fields\s+[a-z_,]*changes|전체 (?:배열|목록)/.test(near)) bad.push(`${rel}:${i + 1}: ${l.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(bad, [], "읽고 다시 쓰는 방법 없이 '변경점에 한 줄'만 시키는 줄 (set 은 통째로 바꾼다)");
});

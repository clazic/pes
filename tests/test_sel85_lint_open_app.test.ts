/**
 * SEL-85 — 스킬 lint 가 스킬·에이전트·명령 문서의 `pes open … --app` 호출을 거절한다 (tester, 작성 모드). 구현 전이라 거절 시험은 실패가 정상.
 *
 * 해석: 기존 lint 처럼 코드 블록·인라인 코드(명령 예제)만 본다 — 산문 문장("… --app 을 부르지 않는다")은 보지 않는다.
 * 막는 꼴: open 하위 명령과 `--app` 옵션이 한 명령 안에 같이 있는 것(옵션이 slug 앞뒤 어느 쪽이든, `pes`·`node scripts/pes.ts`·경로 붙은 pes 모두).
 * 검사 대상(기존과 같음): skills/*\/SKILL.md, agents/*.md, commands/*.md, docs/adapters/*.md. 위반 출력에 `경로:줄` 이 있고 종료 코드 != 0.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { REPO, doc, fence, make_tree, run_lint } from "./helpers/skill_docs.ts";

const bad = (rel: string, body: string, line_hint?: number): void => {
  const tree = make_tree({ [rel]: body });
  try {
    const res = run_lint(tree.root);
    assert.notEqual(res.status, 0, `${rel}: ${body.slice(0, 80)}`);
    assert.ok(res.out.includes(rel), `output names ${rel}: ${res.out}`);
    if (line_hint !== undefined) assert.match(res.out, new RegExp(`${rel.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}:${line_hint}\\b`), res.out);
    assert.match(res.out, /--app|open/, "the message says what is refused");
  } finally {
    tree.cleanup();
  }
};
const ok = (rel: string, body: string): void => {
  const tree = make_tree({ [rel]: body });
  try {
    const res = run_lint(tree.root);
    assert.equal(res.status, 0, `${rel}: ${body.slice(0, 80)} → ${res.out}`);
  } finally {
    tree.cleanup();
  }
};

test("펜스 코드 블록의 pes open <slug> --app 을 거절한다 (스킬·에이전트·명령·어댑터 문서 모두)", () => {
  for (const rel of ["skills/core/SKILL.md", "agents/researcher.md", "commands/start.md", "docs/adapters/claude-code.md"]) {
    bad(rel, doc(fence("sh", "pes open demo --app")));
  }
});

test("줄 번호를 알려 준다", () => {
  const body = doc("앞 문단이다.", "", fence("sh", "pes status demo", "pes open demo --app"));
  // doc(): 1 제목, 2 빈, 3 설명, 4 빈, 5 앞 문단, 6 빈, 7 ```, 8 pes status, 9 pes open --app
  bad("skills/core/SKILL.md", body, 9);
});

test("인라인 코드의 pes open <slug> --app 도 거절한다", () => {
  bad("skills/plan/SKILL.md", doc("대시보드는 `pes open demo --app` 으로 연다."));
});

test("다른 꼴의 호출도 거절한다 — 옵션이 앞, node 경로, 경로 붙은 pes, 변수 slug, 줄 이어쓰기", () => {
  const calls = [
    "pes open --app demo",
    "node scripts/pes.ts open demo --app",
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/pes.ts" open "$SLUG" --app',
    "/usr/local/bin/pes open <프로젝트> --app",
    "PES_NO_BROWSER=1 pes open demo --app",
    "pes open demo --app && echo done",
    "pes open demo \\\n  --app",
  ];
  for (const call of calls) bad("agents/writer.md", doc(fence("sh", call)));
});

test("거짓 양성 0: 일반 pes open, 다른 명령의 --app, 산문 설명은 막지 않는다", () => {
  ok("skills/core/SKILL.md", doc(fence("sh", "pes open demo", "pes serve demo", "pes status demo")));
  ok("skills/core/SKILL.md", doc("대시보드는 `pes open demo` 으로 연다."));
  ok("skills/core/SKILL.md", doc("에이전트와 스킬은 pes open --app 을 부르지 않는다. 사람이 터미널에서 연다."));
  ok("commands/start.md", doc("`--app` 옵션은 사람 전용이다.", "", fence("sh", "echo --app", "pes open demo --apple")));
});

test("저장소의 실제 문서는 lint 를 통과한다 (npm run lint:skills 와 같은 검사)", () => {
  const res = run_lint(REPO);
  assert.equal(res.status, 0, res.out);
});

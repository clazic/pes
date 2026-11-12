// SEL-129 — 앱 show_if 조건 모델이 여러 값(in:[a,b])을 다룬다: 순수 규칙 (Vitest, 합성 값만).
// 서버 판정(scripts/pes_core/commands/questions.ts judge_questions · applicable)과 같아야 한다 — 같은 입력 표 대조는 tests/test_sel129_show_if_contract.test.ts.
// 구현은 아직 없다 — 실패해야 정상(없는 모듈 app/src/api/show-if.ts 때문에).
//
// ═══ [정한 인터페이스] ═══
//  1. app/src/api/types.ts
//       interface ShowIf { question_id: string; in: string[] }          // equals 를 없앤다. in 의 값 하나라도 고르면 보임(서버 {id, in:[…]} 와 같은 뜻)
//       QuestionView.show_if_unsupported?: boolean                       // 서버 조건이 앱이 다루지 못하는 모양이면 true (정직 표시용)
//       QuestionInput.show_if_unsupported?: boolean                      // true 면 보내는 쪽(spec)은 show_if 키를 아예 싣지 않는다 — 모르는 조건을 null 로 지우지 않는다
//  2. app/src/api/show-if.ts  (다른 모듈을 import 하지 않는 순수 모듈 — `import type` 만 허용. node(tests/)에서도 읽는다)
//       showIfFromWire(raw: unknown): { show_if: ShowIf | null; unsupported: boolean }
//           raw 가 null · undefined → { null, false }
//           정확히 {id: string, in: string[]} 만 → { {question_id: id, in: […]}, false }     (in 빈 배열도 지원 — 항상 숨김)
//           id 가 문자열이고 in 이 배열인데 (in 에 문자열 아닌 값이 섞였거나 모르는 키가 더 있으면) → { {question_id, in: 문자열 항목만}, true }  (판정은 서버처럼 문자열 항목으로)
//           그 밖의 모양(문자열 · 배열 · id 없음 · in 이 배열 아님 …) → { null, true }
//       showIfToWire(s: ShowIf): { id: string; in: string[] }
//       showIfApplies(s: ShowIf | null | undefined, chosen: readonly string[] | null | undefined): boolean
//           s 없음 → true. chosen = 조건 질문의 지금 답 값들(하나 고르기 · 글 = 값 1개, 여러 개 = 고른 id 전부, 답 없음 = null · undefined · []).
//           s 있으면: chosen 중 s.in 에 든 것이 하나라도 있어야 true. 답 없음 · 빈 in → false.
//  3. app/src/features/workspace/question-model.ts
//       EditorValue: show_equals: string → show_in: string[] (선택지 id, 조건 질문의 선택지 순서로 정렬해 보낸다) + show_unsupported: boolean
//       showIfLine(q, all): 값이 하나면 지금 문구 그대로 `질문 21에서 ‘이어 보기’를 고르면 보임`, 둘 이상이면 `질문 21에서 ‘이어 보기’ 또는 ‘따로 보기’를 고르면 보임`(셋은 ‘가’, ‘나’ 또는 ‘다’),
//                          지원하지 않는 조건이면 `지원하지 않는 조건이라 앱에서 고칠 수 없어요` 꼴(아래 화면 시험)

import { describe, expect, it } from "vitest";

type ShowIf = { question_id: string; in: string[] };
type Mod = {
  showIfFromWire(raw: unknown): { show_if: ShowIf | null; unsupported: boolean };
  showIfToWire(s: ShowIf): { id: string; in: string[] };
  showIfApplies(s: ShowIf | null | undefined, chosen: readonly string[] | null | undefined): boolean;
};
const modules = import.meta.glob<Mod>("/src/api/show-if.{ts,tsx}");
const load = async (): Promise<Mod> => {
  const loader = Object.values(modules)[0];
  if (!loader) throw new Error("src/api/show-if.ts 가 없다");
  return loader();
};

describe("[SEL-129] showIfFromWire — 서버 {id, in:[…]} 를 모든 값으로", () => {
  it("in 의 값을 하나도 버리지 않는다 (a, b, c 순서 유지)", async () => {
    const m = await load();
    expect(m.showIfFromWire({ id: "qst-1", in: ["a", "b", "c"] })).toEqual({ show_if: { question_id: "qst-1", in: ["a", "b", "c"] }, unsupported: false });
  });

  it("값 하나도 같은 모양 (in 배열)", async () => {
    const m = await load();
    expect(m.showIfFromWire({ id: "qst-1", in: ["a"] })).toEqual({ show_if: { question_id: "qst-1", in: ["a"] }, unsupported: false });
  });

  it("조건 없음: null · undefined → show_if null, 지원 안 함 아님", async () => {
    const m = await load();
    expect(m.showIfFromWire(null)).toEqual({ show_if: null, unsupported: false });
    expect(m.showIfFromWire(undefined)).toEqual({ show_if: null, unsupported: false });
  });

  it("빈 in 은 지원하는 모양이다 (항상 숨김 — 서버와 같다)", async () => {
    const m = await load();
    expect(m.showIfFromWire({ id: "qst-1", in: [] })).toEqual({ show_if: { question_id: "qst-1", in: [] }, unsupported: false });
  });

  it("in 에 문자열 아닌 값이 섞이면 문자열 항목만 남기고 지원 안 함으로 표시한다", async () => {
    const m = await load();
    expect(m.showIfFromWire({ id: "qst-1", in: ["a", 1, null, "b"] })).toEqual({ show_if: { question_id: "qst-1", in: ["a", "b"] }, unsupported: true });
  });

  it("모르는 키가 더 있으면 id · in 은 서버처럼 읽되 지원 안 함으로 표시한다", async () => {
    const m = await load();
    expect(m.showIfFromWire({ id: "qst-1", in: ["a"], not: ["b"] })).toEqual({ show_if: { question_id: "qst-1", in: ["a"] }, unsupported: true });
  });

  it.each([
    ["문자열", "a"],
    ["배열", ["a"]],
    ["id 없음", { in: ["a"] }],
    ["id 가 숫자", { id: 3, in: ["a"] }],
    ["in 없음", { id: "qst-1" }],
    ["in 이 문자열", { id: "qst-1", in: "a" }],
    ["숫자", 7],
    ["빈 객체", {}],
  ])("그 밖의 모양(%s)은 show_if null + 지원 안 함", async (_n, raw) => {
    const m = await load();
    expect(m.showIfFromWire(raw)).toEqual({ show_if: null, unsupported: true });
  });
});

describe("[SEL-129] showIfToWire", () => {
  it("모든 값을 {id, in} 으로 돌려준다 — 값 하나만 남기지 않는다", async () => {
    const m = await load();
    expect(m.showIfToWire({ question_id: "qst-1", in: ["a", "b"] })).toEqual({ id: "qst-1", in: ["a", "b"] });
  });

  it("읽고 다시 쓰면 같다 (왕복)", async () => {
    const m = await load();
    const wire = { id: "qst-1", in: ["x", "y", "z"] };
    expect(m.showIfToWire(m.showIfFromWire(wire).show_if!)).toEqual(wire);
  });
});

describe("[SEL-129] showIfApplies — a · b · 그 밖의 값", () => {
  const cond: ShowIf = { question_id: "qst-1", in: ["a", "b"] };

  it("조건 없음 → 항상 보임", async () => {
    const m = await load();
    expect(m.showIfApplies(null, null)).toBe(true);
    expect(m.showIfApplies(undefined, ["z"])).toBe(true);
  });

  it.each([
    ["a", ["a"], true],
    ["b", ["b"], true],
    ["그 밖의 값 c", ["c"], false],
    ["답 없음 null", null, false],
    ["답 없음 undefined", undefined, false],
    ["답 없음 빈 배열", [], false],
    ["여러 개 고름: a 와 c", ["a", "c"], true],
    ["여러 개 고름: b 와 a", ["b", "a"], true],
    ["여러 개 고름: c 와 d", ["c", "d"], false],
  ])("in:[a,b] · 답 %s → 보임 %s", async (_n, chosen, shown) => {
    const m = await load();
    expect(m.showIfApplies(cond, chosen as string[] | null | undefined)).toBe(shown);
  });

  it("값 하나 조건은 그 값일 때만", async () => {
    const m = await load();
    const one: ShowIf = { question_id: "qst-1", in: ["a"] };
    expect(m.showIfApplies(one, ["a"])).toBe(true);
    expect(m.showIfApplies(one, ["b"])).toBe(false);
  });

  it("빈 in 은 어떤 답에도 숨김", async () => {
    const m = await load();
    expect(m.showIfApplies({ question_id: "qst-1", in: [] }, ["a"])).toBe(false);
  });

  it("대소문자 · 앞뒤 공백을 다르게 본다 (서버는 정확히 같은 값만)", async () => {
    const m = await load();
    expect(m.showIfApplies(cond, ["A"])).toBe(false);
    expect(m.showIfApplies(cond, [" a"])).toBe(false);
    expect(m.showIfApplies(cond, ["ab"])).toBe(false);
  });
});

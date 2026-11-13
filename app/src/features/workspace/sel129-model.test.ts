// SEL-129 — 화면 쪽 순수 규칙이 in:[a,b] 의 모든 값을 쓴다 (Vitest, 합성 값만).
//  answer-model.makePlan: 조건 질문의 답이 in 안의 어느 값이든 적용(필수 판정 포함), 그 밖의 값 · 답 없음이면 적용 안 됨 — 서버(hidden_questions)와 같다.
//    지원 안 하는 조건(show_if null + show_if_unsupported true)은 서버처럼 '적용됨'.
//  question-model: editorValueOf · toInput · showIfLine · blockReason 의 새 모양 (정한 인터페이스: src/api/sel129-show-if.test.ts 머리말 3번)
//    EditorValue.show_in: string[], show_unsupported: boolean / toInput → show_if {question_id, in} (조건 질문의 선택지 순서) · show_if_unsupported
import { describe, expect, it } from "vitest";
import type { QuestionView } from "@/api/types";
import { makePlan, type RawDraft } from "./answer-model";
import { blockReason, editorValueOf, showIfLine, toInput } from "./question-model";

const OPTS = [
  { id: "a", label: "가" },
  { id: "b", label: "나" },
  { id: "c", label: "다" },
];
const base = { source: "ai", status: "open", direction: "ask_human", needs_recheck: false, previous_answer: null, recommendation: null, default_value: null } as const;
const parent = (extra: Partial<QuestionView> = {}): QuestionView => ({ ...base, id: "q-1", number: 1, version: 1, required: false, importance: "normal", text: "부모", kind: "single_choice", options: OPTS, show_if: null, ...extra }) as QuestionView;
const child = (show_if: QuestionView["show_if"], extra: Partial<QuestionView> = {}): QuestionView =>
  ({ ...base, id: "q-2", number: 2, version: 1, required: true, importance: "normal", text: "자식", kind: "free_text", options: [], show_if, ...extra }) as QuestionView;

const planWith = (qs: QuestionView[], drafts: Record<string, RawDraft>) =>
  makePlan({ open: qs, draftOf: (q) => drafts[q.id] ?? { answer: "", opinion: "" }, confirmed: () => true, defaultUsed: () => undefined });
const IN_AB = { question_id: "q-1", in: ["a", "b"] };

describe("[SEL-129] makePlan — 적용 · 필수 판정", () => {
  it.each([
    ["a", true],
    ["b", true],
    ["c", false],
  ])("하나 고르기 부모의 초안이 %s → 자식 적용 %s", (picked, applies) => {
    const p = planWith([parent(), child(IN_AB)], { "q-1": { answer: picked, opinion: "" } });
    expect(p.applicable.get("q-2")).toBe(applies);
    // 필수 자식은 적용될 때만 '비어 있는 필수'로 센다
    expect(p.missing.map((q) => q.id).includes("q-2")).toBe(applies);
  });

  it("부모 답 없음 → 적용 안 됨, 필수로 세지 않음", () => {
    const p = planWith([parent(), child(IN_AB)], {});
    expect(p.applicable.get("q-2")).toBe(false);
    expect(p.missing.map((q) => q.id)).not.toContain("q-2");
  });

  it("여러 개 고르기 부모: 고른 것 중 하나라도 in 에 있으면 적용 (a,c → 적용 / c 만 → 안 됨)", () => {
    const multi = parent({ kind: "multi_choice" });
    expect(planWith([multi, child(IN_AB)], { "q-1": { answer: "a\nc", opinion: "" } }).applicable.get("q-2")).toBe(true);
    expect(planWith([multi, child(IN_AB)], { "q-1": { answer: "c", opinion: "" } }).applicable.get("q-2")).toBe(false);
  });

  it("이미 보낸 부모 답(sent)도 같은 규칙: 글 ‘나’(= b) → 적용, ‘다’(= c) → 안 됨", () => {
    const sent = (answer: string) => parent({ sent: { answer, receipt_no: "0001", committed_at: "2026-11-13T09:00:00+09:00" } as QuestionView["sent"] });
    expect(planWith([sent("나"), child(IN_AB)], {}).applicable.get("q-2")).toBe(true);
    expect(planWith([sent("다"), child(IN_AB)], {}).applicable.get("q-2")).toBe(false);
  });

  it("글로 답하는 부모: 글이 in 의 값과 정확히 같을 때만", () => {
    const text = parent({ kind: "free_text", options: [] });
    expect(planWith([text, child(IN_AB)], { "q-1": { answer: "b", opinion: "" } }).applicable.get("q-2")).toBe(true);
    expect(planWith([text, child(IN_AB)], { "q-1": { answer: "B", opinion: "" } }).applicable.get("q-2")).toBe(false);
  });

  it("값 하나 조건은 지금처럼 그 값일 때만", () => {
    const one = { question_id: "q-1", in: ["a"] };
    expect(planWith([parent(), child(one)], { "q-1": { answer: "a", opinion: "" } }).applicable.get("q-2")).toBe(true);
    expect(planWith([parent(), child(one)], { "q-1": { answer: "b", opinion: "" } }).applicable.get("q-2")).toBe(false);
  });

  it("숨은 자식의 초안은 보내지 않고(inapplicable) 지우지도 않는다 — 값 b 로 바꾸면 보낸다", () => {
    const qs = [parent(), child(IN_AB, { required: false })];
    const hidden = planWith(qs, { "q-1": { answer: "c", opinion: "" }, "q-2": { answer: "초안", opinion: "" } });
    expect(hidden.skipped.map((x) => [x.q.id, x.reason])).toEqual([["q-2", "inapplicable"]]);
    const shown = planWith(qs, { "q-1": { answer: "b", opinion: "" }, "q-2": { answer: "초안", opinion: "" } });
    expect(shown.items.map((i) => i.q.id)).toEqual(["q-1", "q-2"]);
  });

  it("지원 안 하는 조건(show_if null + show_if_unsupported)은 서버처럼 적용된다 — 필수면 비어 있는 필수로 센다", () => {
    const p = planWith([parent(), child(null, { show_if_unsupported: true })], {});
    expect(p.applicable.get("q-2")).toBe(true);
    expect(p.missing.map((q) => q.id)).toContain("q-2");
  });

  it("빈 in 은 어떤 답에도 적용 안 됨", () => {
    const p = planWith([parent(), child({ question_id: "q-1", in: [] })], { "q-1": { answer: "a", opinion: "" } });
    expect(p.applicable.get("q-2")).toBe(false);
  });
});

describe("[SEL-129] showIfLine — 값이 여러 개여도 말한다", () => {
  const all = [parent(), child(null)];
  const line = (inn: string[], unsupported = false) => showIfLine(child(inn.length ? { question_id: "q-1", in: inn } : null, unsupported ? { show_if_unsupported: true } : {}), all);

  it("값 하나: 지금 문구 그대로", () => {
    expect(line(["a"])).toBe("질문 1에서 ‘가’를 고르면 보임");
  });

  it("값 둘: ‘가’ 또는 ‘나’", () => {
    expect(line(["a", "b"])).toBe("질문 1에서 ‘가’ 또는 ‘나’를 고르면 보임");
  });

  it("값 셋: ‘가’, ‘나’ 또는 ‘다’", () => {
    expect(line(["a", "b", "c"])).toBe("질문 1에서 ‘가’, ‘나’ 또는 ‘다’를 고르면 보임");
  });

  it("조건 질문의 선택지에 없는 값은 값 그대로", () => {
    expect(line(["a", "old-id"])).toBe("질문 1에서 ‘가’ 또는 ‘old-id’를 고르면 보임");
  });

  it("조건 없음 → null (줄 없음)", () => {
    expect(line([])).toBeNull();
  });

  it("지원 안 하는 조건 → 정직한 문장 ‘지원하지 않는 조건’ (조건 없음처럼 감추지 않는다)", () => {
    expect(line([], true)).toMatch(/지원하지 않는 조건/);
  });
});

describe("[SEL-129] 고치기 form 값 — show_in", () => {
  it("editorValueOf: in 의 모든 값이 show_in 에 (조건 질문 id 는 show_question)", () => {
    const v = editorValueOf(child(IN_AB, { required: false }));
    expect(v.show_question).toBe("q-1");
    expect(v.show_in).toEqual(["a", "b"]);
    expect(v.show_unsupported).toBe(false);
  });

  it("editorValueOf: 조건 없음 → show_question '' · show_in []", () => {
    const v = editorValueOf(child(null));
    expect([v.show_question, v.show_in, v.show_unsupported]).toEqual(["", [], false]);
  });

  it("editorValueOf: 지원 안 하는 조건 → show_unsupported true, 조건 칸은 비어 있다", () => {
    const v = editorValueOf(child(null, { show_if_unsupported: true }));
    expect([v.show_question, v.show_in, v.show_unsupported]).toEqual(["", [], true]);
  });

  it("toInput: show_in 전부가 show_if.in 으로 (값 하나로 줄지 않는다)", () => {
    expect(toInput(editorValueOf(child(IN_AB))).show_if).toEqual(IN_AB);
  });

  it("toInput: 순서는 조건 질문의 선택지 순서가 아니라 고른 값 그대로여도 같은 집합 — 같은 값 두 번 담지 않는다", () => {
    const v = { ...editorValueOf(child(IN_AB)), show_in: ["b", "a", "b"] };
    const out = toInput(v).show_if!;
    expect([...out.in].sort()).toEqual(["a", "b"]);
    expect(out.in).toHaveLength(2);
  });

  it("toInput: 조건 질문이 있어도 고른 값이 없으면 show_if null", () => {
    expect(toInput({ ...editorValueOf(child(IN_AB)), show_in: [] }).show_if).toBeNull();
  });

  it("toInput: 지원 안 하는 조건은 show_if_unsupported true + show_if null — http 가 키를 싣지 않는다", () => {
    const input = toInput(editorValueOf(child(null, { show_if_unsupported: true })));
    expect(input.show_if).toBeNull();
    expect(input.show_if_unsupported).toBe(true);
  });

  it("toInput: 지원하는 조건이면 show_if_unsupported 가 true 가 아니다", () => {
    expect(toInput(editorValueOf(child(IN_AB))).show_if_unsupported).not.toBe(true);
  });

  it("blockReason: 조건 질문을 골랐는데 조건 답이 하나도 없으면 막는다", () => {
    const v = { ...editorValueOf(child(IN_AB)), show_in: [] };
    expect(blockReason(toInput(v), v, true)).toBe("조건 답을 골라 주세요.");
  });

  it("blockReason: 조건 답이 둘이어도 막지 않는다", () => {
    const v = editorValueOf(child(IN_AB));
    expect(blockReason(toInput(v), v, true)).toBeNull();
  });
});

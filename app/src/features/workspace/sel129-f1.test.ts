// SEL-129 최종 리뷰 1 (F1) — 앱 판정 == 서버 판정 (Vitest, 합성 값만).
//  1) 숨은 부모의 미제출 초안은 판정에 쓰지 않는다(연쇄) · 개별 제출은 그 요청과 저장 답만 본다
//  2) 숫자 조건 값 · 숫자 답은 타입을 지켜 비교한다(서버는 JSON 값 그대로 비교)
//  3) CLI 가 만드는 {id, in, position} 은 지원(편집 가능) — 모르는 키는 보존, 조건 질문을 바꾸면 버린다
//  4) 빈 in:[] 조건은 편집에서 유지된다(문장만 바꿔도 저장 가능, null 로 바뀌지 않음)
import { describe, expect, it } from "vitest";
import type { QuestionView } from "@/api/types";
import { showIfApplies, showIfFromWire, showIfToWire } from "@/api/show-if";
import { makePlan, sentValues, type RawDraft } from "./answer-model";
import { blockReason, editorValueOf, inputOf, showIfLine, toInput } from "./question-model";

const OPTS = [
  { id: "a", label: "가" },
  { id: "b", label: "나" },
  { id: "c", label: "다" },
];
const base = { source: "ai", status: "open", direction: "ask_human", needs_recheck: false, previous_answer: null, recommendation: null, default_value: null } as const;
const mk = (id: string, number: number, extra: Partial<QuestionView> = {}): QuestionView =>
  ({ ...base, id, number, version: 1, required: false, importance: "normal", text: `질문 ${number}`, kind: "single_choice", options: OPTS, show_if: null, ...extra }) as QuestionView;
const AB = (from: string) => ({ question_id: from, in: ["a", "b"] });
const sentOf = (answer: string, value?: unknown): QuestionView["sent"] => ({ answer, receipt_no: "0001", tx_id: "tx", committed_at: "2026-11-13T09:00:00+09:00", ...(value === undefined ? {} : { value }) }) as QuestionView["sent"];
const planWith = (qs: QuestionView[], drafts: Record<string, string>) =>
  makePlan({ open: qs, draftOf: (q) => ({ answer: drafts[q.id] ?? "", opinion: "" }) satisfies RawDraft, confirmed: () => true, defaultUsed: () => undefined });
const ids = (xs: { q: QuestionView }[]) => xs.map((x) => x.q.id);

describe("[F1-1] 숨은 부모 연쇄 — 적용되는 답만 판정에 쓴다", () => {
  const chain = (extraC: Partial<QuestionView> = {}) => [mk("A", 1), mk("B", 2, { show_if: AB("A") }), mk("C", 3, { show_if: AB("B"), ...extraC })];

  it("리뷰 재현: A=c · B=b · C=a → B 숨김, C 숨김(B 초안은 제출되지 않으니), 보내는 것은 A 만", () => {
    const p = planWith(chain({ required: true }), { A: "c", B: "b", C: "a" });
    expect(p.applicable.get("B")).toBe(false);
    expect(p.applicable.get("C")).toBe(false);
    expect(ids(p.items)).toEqual(["A"]);
    expect(p.missing.map((q) => q.id)).not.toContain("C"); // 서버도 C 를 숨김으로 보니 필수 누락이 아니다
  });

  it("A=a · B=b · C=a → 전부 보낸다", () => {
    const p = planWith(chain(), { A: "a", B: "b", C: "a" });
    expect(ids(p.items)).toEqual(["A", "B", "C"]);
  });

  it("A=b · B=c · C=a → B 는 보이고 보내지만 C 는 숨김", () => {
    const p = planWith(chain(), { A: "b", B: "c", C: "a" });
    expect(ids(p.items)).toEqual(["A", "B"]);
    expect(p.applicable.get("C")).toBe(false);
  });

  it("보낸(저장) 숨은 부모의 답은 유지한다: B 가 지금 숨겨져도 서버에 있는 B 답 a 로 C 가 보인다", () => {
    const qs = [mk("A", 1, { sent: sentOf("다", "c") }), mk("B", 2, { show_if: AB("A"), sent: sentOf("가", "a") }), mk("C", 3, { show_if: AB("B") })];
    const p = planWith(qs, { C: "a" });
    expect(p.applicable.get("B")).toBe(false);
    expect(p.applicable.get("C")).toBe(true);
    expect(ids(p.items)).toEqual(["C"]);
  });

  it("부모가 뒤 순서에 있어도 같은 결과(질문 순서에 기대지 않는다)", () => {
    const qs = [mk("C", 3, { show_if: AB("B") }), mk("B", 2, { show_if: AB("A") }), mk("A", 1)];
    const p = planWith(qs, { A: "c", B: "b", C: "a" });
    expect(ids(p.items)).toEqual(["A"]);
  });

  it("순환 참조(A↔B)는 멈추고 둘 다 숨김", () => {
    const qs = [mk("A", 1, { show_if: AB("B") }), mk("B", 2, { show_if: AB("A") })];
    const p = planWith(qs, { A: "a", B: "a" });
    expect(p.applicable.get("A")).toBe(false);
    expect(p.applicable.get("B")).toBe(false);
    expect(p.items).toEqual([]);
  });

  it("개별 제출: 부모가 미제출 초안(b)뿐이면 자식 ‘이 답만 보내기’는 막는다(서버가 not_applicable 로 거절)", () => {
    const qs = [mk("A", 1), mk("B", 2, { show_if: AB("A") })];
    const p = planWith(qs, { A: "b", B: "a" });
    expect(p.applicable.get("B")).toBe(true); // 묶음으로는 같이 간다
    expect(p.single.has("A")).toBe(true);
    expect(p.single.has("B")).toBe(false); // 혼자는 못 간다
    expect(p.singleBlocked.has("B")).toBe(true);
  });

  it("개별 제출: 부모 답이 이미 보내졌으면 혼자 보낼 수 있다", () => {
    const qs = [mk("A", 1, { sent: sentOf("가", "a") }), mk("B", 2, { show_if: AB("A") })];
    const p = planWith(qs, { B: "a" });
    expect(p.single.has("B")).toBe(true);
    expect(p.singleBlocked.has("B")).toBe(false);
  });
});

describe("[F1-2] 숫자 조건 값 — 서버처럼 JSON 값 그대로 비교", () => {
  const num = (answer: unknown) => mk("N", 1, { kind: "free_text", options: [], sent: sentOf(String(answer), answer) });
  const applies = (inn: unknown[], answer: unknown) => {
    const wire = showIfFromWire({ id: "N", in: inn });
    const cond = wire.judge ?? wire.show_if;
    return showIfApplies(cond, sentValues(num(answer)));
  };

  it.each([
    [[1], 1, true],
    [[1, "x"], 1, true],
    [["1"], 1, false],
    [[2], 1, false],
    [["1"], "1", true],
    [[1], "1", false],
  ])("in %j · 답 %j → 보임 %s", (inn, answer, expected) => {
    expect(applies(inn as unknown[], answer)).toBe(expected);
  });

  it("makePlan 도 같다: 숫자 부모의 저장 답 1 + in:[1] → 자식 보임, in:[\"1\"] → 숨김", () => {
    const child = (inn: unknown[]) => {
      const wire = showIfFromWire({ id: "N", in: inn });
      return mk("K", 2, { show_if: wire.show_if, ...(wire.judge ? { show_if_judge: wire.judge } : {}), ...(wire.unsupported ? { show_if_unsupported: true } : {}), required: true });
    };
    expect(planWith([num(1), child([1])], {}).applicable.get("K")).toBe(true);
    expect(planWith([num(1), child(["1"])], {}).applicable.get("K")).toBe(false);
    expect(planWith([num(1), child([1, "x"])], {}).missing.map((q) => q.id)).toContain("K");
  });

  it("숫자 조건 값은 편집 불가(잠금)이지만 버려지지 않고 판정에 쓰인다", () => {
    const wire = showIfFromWire({ id: "N", in: [1] });
    expect(wire.unsupported).toBe(true);
    expect(wire.judge).toEqual({ question_id: "N", in: [1] });
  });

  it("글/선택지 문자열 판정은 그대로(회귀)", () => {
    const wire = showIfFromWire({ id: "A", in: ["a", "b"] });
    expect(wire.judge).toBeUndefined();
    expect(showIfApplies(wire.show_if, ["b"])).toBe(true);
    expect(showIfApplies(wire.show_if, ["c"])).toBe(false);
  });
});

describe("[F1-3] CLI 모양 {id, in, position} — 지원, 모르는 키는 보존", () => {
  const raw = { id: "scope", in: ["a", "b"], position: 0 };

  it("지원하는 모양으로 읽는다 (unsupported false)", () => {
    const w = showIfFromWire(raw);
    expect(w.unsupported).toBe(false);
    expect(w.show_if).toMatchObject({ question_id: "scope", in: ["a", "b"] });
  });

  it("그대로 되돌려 보낸다 (position 보존)", () => {
    const w = showIfFromWire(raw);
    expect(showIfToWire(w.show_if!)).toEqual(raw);
  });

  it("편집기: 값만 바꾸면 id · position 은 그대로 간다", () => {
    const q = mk("K", 2, { show_if: showIfFromWire(raw).show_if });
    const v = editorValueOf(q);
    expect(v.show_unsupported).toBe(false);
    const out = toInput({ ...v, show_in: ["a"] }).show_if!;
    expect(out.question_id).toBe("scope");
    expect(out.in).toEqual(["a"]);
    expect(showIfToWire(out)).toEqual({ id: "scope", in: ["a"], position: 0 });
  });

  it("편집기: 조건 질문을 바꾸면 옛 position 은 버린다", () => {
    const q = mk("K", 2, { show_if: showIfFromWire(raw).show_if });
    const v = editorValueOf(q);
    const out = toInput({ ...v, show_question: "q-real", show_in: ["a"] }).show_if!;
    expect(showIfToWire(out)).toEqual({ id: "q-real", in: ["a"] });
  });

  it("문장만 바꿔 저장해도 조건이 그대로 간다", () => {
    const q = mk("K", 2, { show_if: showIfFromWire(raw).show_if });
    const v = editorValueOf(q);
    const out = toInput({ ...v, text: "새 문장" });
    expect(showIfToWire(out.show_if!)).toEqual(raw);
    expect(out.show_if_unsupported).not.toBe(true);
  });

  it("정말 모르는 모양(in 이 문자열 아닌 값 섞임)은 여전히 unsupported", () => {
    expect(showIfFromWire({ id: "x", in: ["a", 2], position: 1 }).unsupported).toBe(true);
    expect(showIfFromWire({ id: 3, in: ["a"] }).unsupported).toBe(true);
  });
});

describe("[F1-4] 빈 in:[] 조건 — 편집에서 유지", () => {
  const empty = { question_id: "A", in: [] as string[] };
  const kid = (extra: Partial<QuestionView> = {}) => mk("K", 2, { show_if: empty, ...extra });

  it("문장만 바꿔도 저장이 막히지 않고 in:[] 이 그대로 간다", () => {
    const q = kid();
    const v = { ...editorValueOf(q), text: "바뀐 문장" };
    const input = toInput(v);
    expect(input.show_if).toEqual({ question_id: "A", in: [] });
    expect(blockReason(input, v, true)).toBeNull();
  });

  it("inputOf(q) 도 빈 조건을 null 로 바꾸지 않는다", () => {
    expect(inputOf(kid()).show_if).toEqual({ question_id: "A", in: [] });
  });

  it("새 조건에서 전부 해제하면 여전히 막는다(조건 답을 골라 주세요)", () => {
    const q = mk("K", 2, { show_if: { question_id: "A", in: ["a"] } });
    const v = { ...editorValueOf(q), show_in: [] };
    expect(blockReason(toInput(v), v, true)).toBe("조건 답을 골라 주세요.");
  });

  it("표시 문구가 깨지지 않는다: 항상 숨김이라고 말한다", () => {
    const line = showIfLine(kid(), [mk("A", 1), kid()]);
    expect(line).toBe("질문 1의 조건 답이 비어 있어 항상 숨김");
  });

  it("조건 질문을 바꾸면 더는 빈 조건을 유지하지 않는다", () => {
    const v = { ...editorValueOf(kid()), show_question: "B" };
    expect(toInput(v).show_if).toBeNull();
    expect(blockReason(toInput(v), v, true)).toBe("조건 답을 골라 주세요.");
  });
});

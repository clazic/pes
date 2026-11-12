import type { Importance, QuestionDirection, QuestionInput, QuestionKind, QuestionOption, QuestionStatus, QuestionView, ShowIf } from "@/api/types";

/**
 * 질문 카드의 읽기 규칙(U2b) — 서버가 안 준 칸은 정해진 기본으로 읽는다(이전된 합성 프로젝트가 깨지지 않게).
 * 중요도는 기본을 만들지 않는다(없으면 미정).
 */
export const kindOf = (q: Pick<QuestionView, "kind">): QuestionKind => q.kind ?? "free_text";
export const directionOf = (q: Pick<QuestionView, "direction">): QuestionDirection => q.direction ?? "ask_human";
export const statusOf = (q: Pick<QuestionView, "status">): QuestionStatus => q.status ?? "open";
export const isChoice = (kind: QuestionKind) => kind !== "free_text";
export const isOpen = (q: QuestionView) => statusOf(q) === "open";

export type QuestionFilter = "all" | "high" | "recheck" | "ask_ai";
export const FILTERS: { value: QuestionFilter; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "high", label: "높음" },
  { value: "recheck", label: "재확인" },
  { value: "ask_ai", label: "내가 AI에게" },
];

export function matchesFilter(q: QuestionView, f: QuestionFilter): boolean {
  if (f === "high") return q.importance === "high";
  if (f === "recheck") return q.needs_recheck === true;
  if (f === "ask_ai") return directionOf(q) === "ask_ai";
  return true;
}

/** 선택지 id → 글. 선택지에 없으면 값 그대로(글 답 · 모르는 id) */
export const optionLabel = (options: QuestionOption[] | undefined, value: string) => options?.find((o) => o.id === value)?.label ?? value;

/** “질문 21에서 ‘이어 보기’를 고르면 보임” */
export function showIfLine(q: QuestionView, all: QuestionView[]): string | null {
  const s = q.show_if;
  if (!s) return null;
  const from = all.find((x) => x.id === s.question_id);
  const number = from ? from.number : s.question_id.replace(/^q-/, "");
  return `질문 ${number}에서 ‘${optionLabel(from?.options, s.equals)}’를 고르면 보임`;
}

/* ───────────── 고치기 form 의 값 ───────────── */

export interface EditorValue {
  text: string;
  kind: QuestionKind;
  options: QuestionOption[];
  importance: Importance | "";
  required: boolean;
  default_value: string;
  show_question: string;
  show_equals: string;
  help: string;
  direction: QuestionDirection;
}

export function editorValueOf(q: QuestionView): EditorValue {
  const kind = kindOf(q);
  return {
    text: q.text,
    kind,
    options: (q.options ?? []).map((o) => ({ ...o })),
    importance: q.importance ?? "",
    required: q.required,
    default_value: q.default_value ?? "",
    show_question: q.show_if?.question_id ?? "",
    show_equals: q.show_if?.equals ?? "",
    help: q.help ?? "",
    direction: directionOf(q),
  };
}

/** 보낼 값. 선택지는 글이 있는 것만, 유형이 글이면 선택지 · 가리키는 기본값이 없다 */
export function toInput(v: EditorValue): QuestionInput {
  const choice = isChoice(v.kind);
  const options = choice ? v.options.map((o) => ({ id: o.id, label: o.label.trim() })).filter((o) => o.label) : [];
  let def: string | null = v.default_value.trim() ? v.default_value : null;
  if (choice && def !== null && !options.some((o) => o.id === def)) def = null;
  const showIf: ShowIf | null = v.show_question && v.show_equals ? { question_id: v.show_question, equals: v.show_equals } : null;
  return {
    text: v.text.trim(),
    kind: v.kind,
    options,
    importance: v.importance === "" ? null : v.importance,
    required: v.required,
    default_value: def,
    show_if: showIf,
    help: v.help.trim() ? v.help.trim() : null,
    direction: v.direction,
  };
}

export const inputOf = (q: QuestionView): QuestionInput => toInput(editorValueOf(q));

/** 의미가 바뀌는 칸(문장 · 유형 · 선택지)을 고쳤는가 — 중요도 · 필수 · 기본값 · 조건 · 도움말 · 방향은 뜻을 바꾸지 않는다 */
export function meaningChanged(now: QuestionInput, was: QuestionInput): boolean {
  return now.text !== was.text || now.kind !== was.kind || JSON.stringify(now.options.map((o) => o.label)) !== JSON.stringify(was.options.map((o) => o.label));
}

export const sameInput = (a: QuestionInput, b: QuestionInput) => JSON.stringify(a) === JSON.stringify(b);

/** 새 선택지 id — 겹치지 않게 */
export function newOptionId(options: QuestionOption[]): string {
  let n = options.length + 1;
  while (options.some((o) => o.id === `opt-${n}`)) n += 1;
  return `opt-${n}`;
}

/** 저장할 수 없는 이유(없으면 null). 보내는 단추의 aria-describedby 글 */
export function blockReason(input: QuestionInput, value: EditorValue, changed: boolean): string | null {
  if (!input.text) return "질문 문장을 적어 주세요.";
  if (isChoice(input.kind) && input.options.length < 2) return "선택지를 2개 이상 적어 주세요.";
  if (value.show_question && !value.show_equals) return "조건 답을 골라 주세요.";
  if (!changed) return "바꾼 것이 없어요.";
  return null;
}

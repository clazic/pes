import type { AnswerItemInput, QuestionView } from "@/api/types";
import { judgeApplicable, type JudgeQuestion } from "@/api/show-if";
import { isChoice, kindOf, optionLabel } from "./question-model";

/**
 * 답 초안 → 보낼 값(U2c) — 화면 초안(글 칸 · 선택지)을 서버 계약(AnswerItemInput)으로 바꾸는 순수 규칙.
 *  - 초안 글: 하나 고르기 = 선택지 id · 여러 개 = 줄바꿈으로 이은 선택지 id · 글 = 글.
 *  - 앞뒤 공백만 있는 초안은 빈 초안이다.
 *  - 기본값을 쓴 답은 “쓴 그대로”일 때만 used_default (바꾸면 false). 추천은 기본값이 아니다.
 *  - 재확인 필요(needs_recheck)이고 보낸 답이 없는 질문은 ‘새 문구를 확인했어요’ 전에는 보내지 않는다.
 *  - show_if 가 안 맞는 질문은 적용되지 않는다: 필수로 치지 않고 보내지 않는다(초안은 지우지 않는다).
 *    서버처럼 판정한다 — 조건 질문의 답은 저장된 답, 없으면 보낼 초안인데 숨은 질문의 초안은 요청에 실리지 않으니 쓰지 않는다(연쇄).
 *    ‘이 답만 보내기’는 그 요청 하나만 가므로 저장된 답만 본다(부모가 미제출 초안이면 서버가 not_applicable 로 거절한다).
 *  - 의견 칸 글만 있는 항목은 질문이 allow_comment_as_answer 일 때만 보낸다(value null + comment).
 */

export interface RawDraft {
  answer: string;
  opinion: string;
}

/** 초안 글 → 보낼 값. 비었으면 null */
export function valueOfDraft(q: QuestionView, raw: string): string | string[] | null {
  const kind = kindOf(q);
  if (kind === "multi_choice") {
    const picked = raw.split("\n").filter((x) => x.trim() !== "");
    return picked.length ? picked : null;
  }
  const one = kind === "single_choice" ? raw.split("\n")[0]!.trim() : raw.trim();
  return one === "" ? null : one;
}

/**
 * 보낸 답에서 조건 판단용 값을 되찾는다. 서버가 준 원래 값(q.sent.value)이 있으면 그 JSON 값 그대로(숫자는 숫자) —
 * 없으면(이전 합성 자료) 화면 글(q.sent.answer)에서: 선택지는 글 → id, 글 유형은 그대로.
 */
export function sentValues(q: QuestionView): unknown[] {
  if (!q.sent) return [];
  if (q.sent.value !== undefined && q.sent.value !== null) return Array.isArray(q.sent.value) ? [...q.sent.value] : [q.sent.value];
  const text = q.sent.answer;
  if (!isChoice(kindOf(q))) return [text];
  const options = q.options ?? [];
  const whole = options.find((o) => o.label === text);
  if (whole) return [whole.id];
  return text.split(", ").flatMap((part) => options.find((o) => o.label === part)?.id ?? []);
}

export interface PlanItem {
  q: QuestionView;
  value: string | string[] | null;
  comment: string | null;
  usedDefault: boolean;
  /** 이 항목이 비우지 않는 초안 키(보낸 뒤 지울 것)는 화면이 q 로 찾는다 */
}

export type SkipReason = "recheck" | "inapplicable" | "opinion_only";

export interface Plan {
  /** 지금 묶음으로 보낼 항목 (적용되고 · 확인이 끝났고 · 내용이 있는 것) */
  items: PlanItem[];
  /** 적용되는데 아직 비어 있는 필수 질문 */
  missing: QuestionView[];
  /** 초안은 있지만 보내지 않는 것과 그 까닭 */
  skipped: { q: QuestionView; reason: SkipReason }[];
  /** 질문 id → 적용되는가 */
  applicable: Map<string, boolean>;
  /** 질문 id → 개별 제출 항목(혼자 보낼 수 있으면) */
  single: Map<string, PlanItem>;
  /** 묶음으로는 가지만 혼자는 못 가는 질문 — 조건 질문의 답이 아직 서버에 없다 */
  singleBlocked: Set<string>;
}

export interface PlanInput {
  open: QuestionView[];
  draftOf: (q: QuestionView) => RawDraft;
  confirmed: (q: QuestionView) => boolean;
  /** 이 질문의 기본값 채택 기록(‘기본값 쓰기’로 채운 글) — 현재 초안과 같으면 used_default */
  defaultUsed: (q: QuestionView) => string | undefined;
}

export function makePlan({ open, draftOf, confirmed, defaultUsed }: PlanInput): Plan {
  const hasText = (s: string) => s.trim() !== "";
  const candidate = (q: QuestionView): { item: PlanItem | null; skip: SkipReason | null; has: boolean } => {
    if (q.sent) return { item: null, skip: null, has: false };
    const d = draftOf(q);
    const value = valueOfDraft(q, d.answer);
    const comment = hasText(d.opinion) ? d.opinion.trim() : null;
    const has = value !== null || comment !== null;
    if (!has) return { item: null, skip: null, has };
    if (q.needs_recheck && !confirmed(q)) return { item: null, skip: "recheck", has };
    if (value === null && !q.allow_comment_as_answer) return { item: null, skip: "opinion_only", has };
    return { item: { q, value, comment, usedDefault: value !== null && defaultUsed(q) === d.answer }, skip: null, has };
  };
  const cands = new Map(open.map((q) => [q.id, candidate(q)]));
  // 조건 판단은 서버와 같게: 저장된 답 · (적용되는) 보낼 초안
  const judged: JudgeQuestion[] = open.map((q) => {
    const c = cands.get(q.id)!;
    const s = q.show_if_judge ?? q.show_if;
    return {
      id: q.id,
      cond: s,
      ...(q.sent ? { stored: sentValues(q) } : {}),
      ...(!q.sent && c.item && c.item.value !== null ? { draft: Array.isArray(c.item.value) ? c.item.value : [c.item.value] } : {}),
    };
  });
  const applicable = judgeApplicable(judged, "bundle");
  const aloneOk = judgeApplicable(judged, "single");
  const items: PlanItem[] = [];
  const skipped: Plan["skipped"] = [];
  const single = new Map<string, PlanItem>();
  const singleBlocked = new Set<string>();
  for (const q of open) {
    const c = cands.get(q.id)!;
    if (!c.has) continue;
    if (!applicable.get(q.id)) {
      skipped.push({ q, reason: "inapplicable" });
      continue;
    }
    if (c.item) {
      items.push(c.item);
      if (aloneOk.get(q.id)) single.set(q.id, c.item);
      else singleBlocked.add(q.id);
    } else if (c.skip) skipped.push({ q, reason: c.skip });
  }
  const filledNow = new Set(items.map((i) => i.q.id));
  const missing = open.filter((q) => q.required && applicable.get(q.id) && !q.sent && !filledNow.has(q.id));
  return { items, missing, skipped, applicable, single, singleBlocked };
}

/** 서버로 보낼 항목 */
export function toAnswerItem(it: PlanItem): AnswerItemInput {
  return {
    question_id: it.q.id,
    question_version: it.q.version,
    ...(it.q.version_id ? { question_version_id: it.q.version_id } : {}),
    value: it.value,
    ...(it.comment ? { comment: it.comment } : {}),
    used_default: it.usedDefault,
  };
}

/** 검토 대화 상자에 보이는 답 요약 */
export function summary(it: PlanItem): string {
  const v = it.value;
  if (v === null) return "(답 대신 의견만)";
  const one = (x: string) => optionLabel(it.q.options, x);
  return Array.isArray(v) ? v.map(one).join(", ") : isChoice(kindOf(it.q)) ? one(v) : v;
}

export const SKIP_TEXT: Record<SkipReason, string> = {
  recheck: "새 문구를 확인했다고 체크하지 않아 보내지 않아요.",
  inapplicable: "지금은 답하지 않는 질문이라 보내지 않아요. 초안은 그대로 둬요.",
  opinion_only: "의견만 있어서 보내지 않아요. 이 질문은 답이 있어야 해요.",
};

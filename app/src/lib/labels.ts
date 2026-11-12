import type { Importance, QuestionDirection, QuestionKind, QuestionSource, StageKey } from "@/api/types";

/**
 * 화면 이름표 — 서버는 기계 값만 싣고 화면이 이름을 만든다(승인 시안 api/types.ts 의 STAGE_LABEL 과 같은 이름).
 */
export const STAGE_LABEL: Record<StageKey, string> = {
  plan: "기획",
  research: "조사",
  analyze: "분석",
  write: "집필",
  verify: "검증",
  publish: "산출",
};

/** 단계 시작(round_id = null)은 “단계 시작” — 가짜 R0 을 만들지 않는다 */
export const roundLabel = (roundId: number | null) => (roundId === null ? "단계 시작" : `R${roundId}`);

/** 화면 제목: “조사 R2” · “조사 단계 시작” */
export const placeLabel = (stage: StageKey, roundId: number | null) => `${STAGE_LABEL[stage]} ${roundLabel(roundId)}`;

export const IMPORTANCE_LABEL: Record<Importance, string> = { high: "높음", normal: "보통", low: "낮음" };
/** 중요도 말 — 없으면 “미정”(이전된 프로젝트의 중요도를 지어내지 않는다) */
export const importanceLabel = (i: Importance | undefined) => (i ? IMPORTANCE_LABEL[i] : "미정");
export const KIND_LABEL: Record<QuestionKind, string> = { single_choice: "하나 고르기", multi_choice: "여러 개 고르기", free_text: "글로 답하기" };
/** 카드 칩의 방향 말 */
export const DIRECTION_CHIP: Record<QuestionDirection, string> = { ask_human: "AI가 나에게", ask_ai: "내가 AI에게" };
/** 고치기 칸의 방향 말 */
export const DIRECTION_OPTION: Record<QuestionDirection, string> = { ask_human: "AI가 사람에게 묻기", ask_ai: "사람이 AI에게 묻기" };
export const SOURCE_LABEL: Record<QuestionSource, string> = { ai: "AI 점검", bank: "질문 은행", human: "사람" };

const dateFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** ISO 시각 → “11월 2일 10:12”(한국 시각). 읽을 수 없는 값은 그대로 보이지 않고 “시각 미상” */
export function formatAt(iso: string, withTime = true): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "시각 미상";
  return withTime ? `${dateFmt.format(t)} ${timeFmt.format(t)}` : dateFmt.format(t);
}

/** 첨언 해결 · 후속의 종류 이름(U4b) — 해결 메뉴 · 후속 카드가 같은 말을 쓴다 */
export const FOLLOWUP_KIND_LABEL: Record<"edit_text" | "next_round_task" | "reopen_stage" | "none", string> = {
  edit_text: "글 수정",
  next_round_task: "다음 라운드 할 일",
  reopen_stage: "앞 단계 다시 열기",
  none: "그냥 닫기",
};

/** 결과 글 머리글 아래 한 줄("v3 · 채택본 · 2026. 11. 13.") — 값이 있는 것만 잇고, 하나도 없으면 null(줄을 그리지 않는다). 값을 지어내지 않는다 */
export function resultMetaText(r: { version: number | null; status: "adopted" | "draft" | null; updated_at: string | null }): string | null {
  const parts: string[] = [];
  if (r.version !== null) parts.push(`v${r.version}`);
  if (r.status !== null) parts.push(r.status === "adopted" ? "채택본" : "초안");
  if (r.updated_at !== null) parts.push(formatAt(r.updated_at, false));
  return parts.length === 0 ? null : parts.join(" · ");
}

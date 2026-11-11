import type { Importance, QuestionSource, StageKey } from "@/api/types";

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
export const SOURCE_LABEL: Record<QuestionSource, string> = { ai: "AI 점검", bank: "질문 은행", human: "사람" };

const dateFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** ISO 시각 → “11월 2일 10:12”(한국 시각). 읽을 수 없는 값은 그대로 보이지 않고 “시각 미상” */
export function formatAt(iso: string, withTime = true): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "시각 미상";
  return withTime ? `${dateFmt.format(t)} ${timeFmt.format(t)}` : dateFmt.format(t);
}

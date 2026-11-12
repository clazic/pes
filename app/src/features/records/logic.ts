import type { Actor, AssumptionRow, DecisionRow, FollowupView, ReflectionEntry, ReflectionView } from "@/api/types";

/**
 * 가정 · 결정 · 반영의 화면 규칙(U3b) — 서버는 기계 값만 싣고, 어떤 낱말로 보일지는 여기서 정한다(상태 사전 status-registry.ts 의 키).
 * 원칙: 사람 판단이 없는데 “확인” · “채택”으로 보이지 않는다. 증거가 모자란 “적용” · “부분”은 성공으로 보이지 않는다.
 */

export const isHuman = (a: Actor | null): a is Actor => a !== null && a.kind === "human";

export type AssumptionKey = "proposed" | "confirmed" | "rejected" | "revised" | "review" | "no_human";
export type DecisionKey = "proposed" | "adopted" | "superseded" | "revoked" | "no_human";

/** 가정 행의 주 낱말과, 덧붙여 보일 “재확인 필요” 여부 */
export function assumptionWords(row: AssumptionRow): { main: AssumptionKey; review: boolean } {
  if (row.state === "confirmed") {
    if (!isHuman(row.assessed_by)) return { main: "no_human", review: row.needs_review };
    return row.needs_review ? { main: "review", review: false } : { main: "confirmed", review: false };
  }
  return { main: row.state, review: row.needs_review };
}

export function decisionWord(row: DecisionRow): DecisionKey {
  if (row.state === "adopted" && !isHuman(row.decided_by)) return "no_human";
  return row.state;
}

/** 사람이 다시 판단해야 하는 가정(판단 전 · 재확인 필요 · 사람 판단 없는 확인) */
export const assumptionNeedsJudging = (row: AssumptionRow): boolean => row.state === "proposed" || row.needs_review || (row.state === "confirmed" && !isHuman(row.assessed_by));

export type Evidence = "ok" | "missing" | "none";

const followupApplied = (f: FollowupView | null): boolean => !!f && f.state === "applied" && (f.kind !== "edit_text" || f.result_version !== null);

/**
 * 반영 줄의 증거 — 거절 · 유예는 증거를 요구하지 않는다(none).
 * 적용 · 부분은 적용 tx 가 있고, 결과 버전이나 실제로 적용된 후속이 있어야 ok. 하나라도 모자라면 missing(성공으로 세지 않음).
 */
export function evidenceOf(e: ReflectionEntry): Evidence {
  if (e.disposition === "rejected" || e.disposition === "deferred") return "none";
  return e.applied_tx_id !== null && (e.result_version !== null || followupApplied(e.followup)) ? "ok" : "missing";
}

export type ReflectionWord = "applied" | "partial" | "deferred" | "rejected" | "missing";
export const reflectionWord = (e: ReflectionEntry): ReflectionWord => (evidenceOf(e) === "missing" ? "missing" : e.disposition);

export const SEG_ORDER: { seg: "applied" | "partial" | "deferred" | "rejected" | "unverified"; word: ReflectionWord }[] = [
  { seg: "applied", word: "applied" },
  { seg: "partial", word: "partial" },
  { seg: "deferred", word: "deferred" },
  { seg: "rejected", word: "rejected" },
  { seg: "unverified", word: "missing" },
];

export function countByWord(entries: ReflectionEntry[]): Record<ReflectionWord, number> {
  const out: Record<ReflectionWord, number> = { applied: 0, partial: 0, deferred: 0, rejected: 0, missing: 0 };
  for (const e of entries) out[reflectionWord(e)] += 1;
  return out;
}

/** 요약 한 줄이 말하는 경우 — 미제출 · 처리 0건 · 기록 없음은 서로 다른 말이다 */
export type ReflectionCase = "unavailable" | "not_submitted" | "none_processed" | "entries";
export function reflectionCase(view: ReflectionView | null): ReflectionCase {
  if (view === null) return "unavailable";
  if (view.entries.length > 0) return "entries";
  return view.submission === "none" ? "not_submitted" : "none_processed";
}

export const FOLLOWUP_KIND: Record<FollowupView["kind"], string> = { edit_text: "글 수정", next_round_task: "다음 라운드 할 일", reopen_stage: "앞 단계 다시 열기", none: "할 일 없음" };
export const FOLLOWUP_STATE: Record<FollowupView["state"], string> = { proposed: "제안", accepted: "받아들임", running: "진행 중", applied: "적용", deferred: "유예", rejected: "거절", cancelled: "취소" };
export const SCOPE_LABEL = { project: "프로젝트", edition: "이 판" } as const;

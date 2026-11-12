import { PesApiError, type Receipt, type ReferenceRow, type ReferenceSnapshot } from "@/api/types";

/**
 * 참고 프로젝트 화면 규칙(REF1b) — 서버는 기계 값만 싣고, 화면이 낱말을 만든다(상태 사전 status-registry.ts 의 reference · reference_ai).
 * 원칙: 모르는 값을 지어내지 않는다. 처음 보는 이유는 찍지 않고, 서버가 안 준 AI 전달은 “가능”으로 읽지 않는다.
 */

/** 붙인 범위 낱말 — 알려진 키만 말하고, 처음 보는 키는 개수로만 알린다 */
const SCOPE_LABEL: Record<string, string> = { final_report: "최종 보고서", sources: "조사 출처" };
export const SCOPE_KEYS = ["final_report", "sources"] as const;
export const scopeLabel = (key: string): string => SCOPE_LABEL[key] ?? key;

export function scopeWords(scope: string[] | null): string {
  if (scope === null) return "범위 정보 없음";
  const known = scope.filter((k) => k in SCOPE_LABEL).map((k) => SCOPE_LABEL[k]);
  const other = scope.length - known.length;
  const parts = [...known, ...(other > 0 ? [`그 밖 ${other}개`] : [])];
  return parts.length ? parts.join(" · ") : "범위 없음";
}

/** AI 전달 이유 — 아는 값만 문장으로. 처음 보는 값은 null(그대로 찍지 않는다) */
const AI_REASON: Record<string, string> = {
  source_go_off: "원본 프로젝트의 Go 가 꺼져 있어요",
  project_go_off: "이 프로젝트의 Go 가 꺼져 있어요",
  source_missing: "원본 없음",
};

export type AiDeliveryKey = "allowed" | "withheld" | "unknown";

export function aiDeliveryOf(row: ReferenceRow): { key: AiDeliveryKey; reason: string | null } {
  const d = row.ai_delivery;
  if (d === null) return { key: "unknown", reason: null };
  if (d.allowed) return { key: "allowed", reason: null };
  return { key: "withheld", reason: d.withheld_reason !== null ? (AI_REASON[d.withheld_reason] ?? null) : null };
}

/** 내용 보기 · 다시 고정을 할 수 있는 줄 — 원본이 없거나 권한이 없으면 서버가 내용을 안 준다(다시 고정은 서버가 409) */
export const hasLiveSource = (row: ReferenceRow): boolean => row.access === "ok" && row.state !== "source_missing" && row.state !== "no_permission";

/** 줄의 사람 이름 — 권한 없는 줄은 서버가 이름을 안 준다 */
export const NO_PERMISSION_NAME = "권한 없는 참고 프로젝트";
export const nameOf = (row: ReferenceRow): string => (row.access === "no_permission" ? NO_PERMISSION_NAME : (row.source_label ?? row.referenced_project_key ?? "이름 없는 참고 프로젝트"));

/** 영수증 말 — 서버가 번호를 안 줬으면(numbered false) 번호를 지어내지 않는다 */
export const receiptWord = (r: Receipt): string => (r.numbered === false ? "접수됨" : `접수 ${r.receipt_no}`);

/** 서버가 끝까지 거절한 것(다시 보내도 같은 결과). retryable 이면 서버가 이미 받았을 수 있어 거절로 치지 않는다 */
export const isFinalRejection = (e: unknown): e is PesApiError => e instanceof PesApiError && !e.body.error.retryable;

/** 다른 곳에서 먼저 바뀌어 낡은 값으로 보낸 거절 — 목록을 다시 읽어야 한다 */
export const isStaleRejection = (e: unknown): boolean => e instanceof PesApiError && (e.body.error.code === "conflict" || e.body.error.code === "rev_conflict");

/** 처음 고를 스냅숏 — 추천, 없으면 승인된 첫 것, 없으면 고르지 않음(고르지 않은 채 붙일 수 없다) */
export const defaultSnapshot = (snaps: ReferenceSnapshot[]): string | null => (snaps.find((s) => s.recommended) ?? snaps.find((s) => s.approved))?.id ?? null;

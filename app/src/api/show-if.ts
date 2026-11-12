// 질문 조건(show_if) 순수 규칙 — 서버 {id, in:[…]} 와 같은 뜻. 다른 모듈을 import 하지 않는다(node 시험도 읽는다).
// 서버 판정(scripts/pes_core/commands/questions.ts): 조건 질문의 현재 답 값 중 in 에 든 것이 하나라도 있으면 보임. 답 없음 → 숨김.

import type { ShowIf } from "./types";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 서버 조건 → 앱 조건. 앱이 다루지 못하는 모양이면 unsupported(조용히 값을 지어내지 않는다). */
export function showIfFromWire(raw: unknown): { show_if: ShowIf | null; unsupported: boolean } {
  if (raw === null || raw === undefined) return { show_if: null, unsupported: false };
  if (!isRecord(raw) || typeof raw.id !== "string" || !Array.isArray(raw.in)) return { show_if: null, unsupported: true };
  const values = raw.in.filter((v): v is string => typeof v === "string");
  const exact = values.length === raw.in.length && Object.keys(raw).length === 2;
  return { show_if: { question_id: raw.id, in: values }, unsupported: !exact };
}

export function showIfToWire(s: ShowIf): { id: string; in: string[] } {
  return { id: s.question_id, in: [...s.in] };
}

/** chosen = 조건 질문의 지금 답 값들(하나 고르기 · 글 = 1개, 여러 개 = 고른 전부, 답 없음 = null · undefined · []) */
export function showIfApplies(s: ShowIf | null | undefined, chosen: readonly string[] | null | undefined): boolean {
  if (!s) return true;
  return (chosen ?? []).some((v) => s.in.includes(v));
}

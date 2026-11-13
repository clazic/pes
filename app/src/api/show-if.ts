// 질문 조건(show_if) 순수 규칙 — 서버 {id, in:[…]} 와 같은 뜻. 다른 모듈을 import 하지 않는다(node 시험도 읽는다).
// 서버 판정(scripts/pes_core/commands/questions.ts judge_questions · applicable):
//  - 조건 질문의 현재 답 값(여러 개면 전부) 중 하나라도 in 에 든 것이 있으면 보임. 답 없음 → 숨김. 빈 in → 숨김.
//  - 값 비교는 JSON 값 그대로(JSON.stringify 같음) — 숫자 1 과 글 "1" 은 다르다.
//  - 모르는 모양(JSON 아님 · id 문자열 아님 · in 배열 아님)은 조건 없음 = 보임.
//  - 조건 질문의 답은 이번 요청의 항목 → 없으면 저장된(제출된) 답. 숨은 질문의 항목은 요청에 못 실리니 그 초안은 판정에 쓰이지 않는다.

import type { ShowIf } from "./types";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 판정에 쓰는 조건 모양 — 값이 문자열이 아닐 수도 있다(숫자 답 등) */
export interface ShowIfJudge {
  question_id: string;
  in: readonly unknown[];
}

export interface ShowIfWire {
  show_if: ShowIf | null;
  /** 앱이 고칠 수 없는 모양인가(모르는 모양이거나 in 에 문자열이 아닌 값이 있다) */
  unsupported: boolean;
  /** in 에 문자열이 아닌 값이 있을 때만: 서버처럼 값 그대로 판정하기 위한 원래 조건 */
  judge?: ShowIfJudge;
}

/**
 * 서버 조건 → 앱 조건. 앱이 다루지 못하는 모양이면 unsupported(조용히 값을 지어내지 않는다).
 * {id, in:[문자열…]} 이면 지원한다 — 그 밖의 키(예: `pes ask` 가 붙이는 position)는 extra 로 보존해 되돌려 보낸다.
 */
export function showIfFromWire(raw: unknown): ShowIfWire {
  if (raw === null || raw === undefined) return { show_if: null, unsupported: false };
  if (!isRecord(raw) || typeof raw.id !== "string" || !Array.isArray(raw.in)) return { show_if: null, unsupported: true };
  const values = raw.in.filter((v): v is string => typeof v === "string");
  if (values.length !== raw.in.length) {
    return { show_if: { question_id: raw.id, in: values }, unsupported: true, judge: { question_id: raw.id, in: [...raw.in] } };
  }
  const { id: _id, in: _in, ...rest } = raw;
  return { show_if: { question_id: raw.id, in: values, ...(Object.keys(rest).length ? { extra: rest } : {}) }, unsupported: false };
}

export function showIfToWire(s: ShowIf): { id: string; in: string[] } & Record<string, unknown> {
  return { ...s.extra, id: s.question_id, in: [...s.in] };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** chosen = 조건 질문의 지금 답 값들(하나 고르기 · 글 = 1개, 여러 개 = 고른 전부, 답 없음 = null · undefined · []). 값은 서버에 낸 JSON 값 그대로 */
export function showIfApplies(s: ShowIfJudge | null | undefined, chosen: readonly unknown[] | null | undefined): boolean {
  if (!s) return true;
  return (chosen ?? []).some((v) => s.in.some((w) => same(v, w)));
}

export interface JudgeQuestion {
  id: string;
  /** 판정에 쓸 조건(없으면 늘 적용) */
  cond: ShowIfJudge | null | undefined;
  /** 서버에 있는 이 질문의 제출된 답 값들(없으면 undefined) */
  stored?: readonly unknown[];
  /** 이번에 보낼 수 있는 초안 값들(없으면 undefined) */
  draft?: readonly unknown[];
}

/**
 * 질문마다 지금 적용되는가 — 서버의 judge_questions 와 같은 규칙.
 *  - bundle: 조건 질문의 답 = 저장된 답, 없으면 그 질문이 적용될 때의 초안(숨은 질문의 초안은 요청에 안 실리니 쓰지 않는다 — 연쇄).
 *  - single: 그 요청 하나만 가므로 조건 질문의 답 = 저장된 답뿐(초안은 가지 않는다).
 * 질문 순서에 기대지 않는다. 서로를 가리키는 순환은 숨김으로 끊는다.
 */
export function judgeApplicable(questions: readonly JudgeQuestion[], mode: "bundle" | "single"): Map<string, boolean> {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();
  const valuesOf = (id: string): readonly unknown[] | undefined => {
    const q = byId.get(id);
    if (!q) return undefined;
    if (q.stored) return q.stored;
    if (mode === "single" || !q.draft) return undefined;
    return applicable(id) ? q.draft : undefined;
  };
  const applicable = (id: string): boolean => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return false;
    const q = byId.get(id);
    if (!q) return true;
    visiting.add(id);
    const result = !q.cond || showIfApplies(q.cond, valuesOf(q.cond.question_id));
    visiting.delete(id);
    memo.set(id, result);
    return result;
  };
  for (const q of questions) applicable(q.id);
  return memo;
}

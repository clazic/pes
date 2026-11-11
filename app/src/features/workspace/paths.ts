import type { StageKey } from "@/api/types";

/** 라운드 주소 — 단계 시작(round_id = null)은 `r/start` */
export const roundHref = (slug: string, edition: number, stage: StageKey | string, roundId: number | null) =>
  `/p/${slug}/e/${edition}/s/${stage}/r/${roundId === null ? "start" : roundId}`;

export type View = "nav" | "body" | "ask";
/** 모르는 값은 기본(본문) */
export const parseView = (v: string | null): View => (v === "nav" || v === "ask" ? v : "body");

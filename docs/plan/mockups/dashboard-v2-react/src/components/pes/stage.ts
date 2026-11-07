import type { StageView } from "@/api/types";
import { STATUS, type Shape } from "./status-registry";

/**
 * 단계 모양(설계 3.4) — 사이드바 단계 나무·좁은 화면 탐색·목록 단계 칸이 함께 쓴다. 뜻은 옆 글자가 전달한다.
 * 글자는 상태 사전(stage)에서 가져온다 — “현재 · 나의 할 일”·“현재 · AI가 하는 중”을 화면마다 따로 쓰지 않는다(4차).
 * 목록 단계 칸(cell)은 현재 단계만 옅은 바탕으로 칠한다.
 */
export const STAGE_MARK: Record<StageView, { shape: Shape; cls: string; cell: string; text: string }> = {
  approved: { shape: "circle", cls: "text-ok", cell: "text-ok", text: "승인" },
  current_you: { shape: "diamond", cls: "text-primary-ink", cell: "bg-primary-soft text-primary-ink", text: STATUS.stage.current_you!.label },
  current_ai: { shape: "ring", cls: "text-primary-ink", cell: "bg-primary-soft text-primary-ink", text: STATUS.stage.current_ai!.label },
  current_blocked: { shape: "square", cls: "text-bad", cell: "bg-bad-soft text-bad", text: STATUS.stage.current_blocked!.label },
  stale: { shape: "tri", cls: "text-warn", cell: "bg-warn-soft text-warn", text: "다시 확인 필요" },
  pending: { shape: "dash", cls: "text-control", cell: "text-muted-foreground", text: "아직" },
};

/** 라운드 이름 → 주소 조각(단계 시작 = start) */
export const roundKey = (label: string) => (label === "단계 시작" ? "start" : label.replace("R", ""));

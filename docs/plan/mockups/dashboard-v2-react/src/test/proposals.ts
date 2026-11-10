import { pes } from "@/api/mock-client";
import type { ProposalView } from "@/api/types";
import { mockSettings } from "@/lib/mock-settings";

/**
 * 시험 도구(UI7-4b) — 합성 가정·결정 제안을 목 서버 저장소에 더하고, “가정 확인 한 건 실패” 목 설정을 건다.
 * 화면 코드와 목 서버는 고치지 않는다: 저장소에는 시험이 직접 넣고, 실패 고르기는 worker 가 만든 설정을 쓴다.
 *
 * 정한 목 설정 이름(worker 가 mock-settings.ts 에 만든다):
 *   failAssumption: string | null  — 기본 null. 값이 제안 id 이면 그 제안의 decision.record(verdict "accept") 한 건을
 *   version_conflict 로 거절한다(저장소는 바꾸지 않음 → 그 제안은 판단 전 그대로). reset() 은 null 로 되돌린다.
 */
export const SLUG = "dolbom-insight";

type Store = { research: Record<string, { proposals: ProposalView[] }> };
const store = () => (pes as unknown as { store: Store }).store;

export function addProposal(p: { id: string; kind: "assumption" | "decision"; text: string; basis?: string; state?: ProposalView["state"] }) {
  store().research[SLUG].proposals.push({
    id: p.id,
    kind: p.kind,
    text: p.text,
    basis: p.basis ?? "합성 근거 v1",
    by: "합성 AI",
    at: "09:00",
    state: p.state ?? { domain: "proposal", value: "proposed" },
  });
}

/** 판단 전 제안 목록(저장소 기준) */
export function pendingIds(kind?: "assumption" | "decision") {
  return store()
    .research[SLUG].proposals.filter((p) => p.state.value === "proposed" && (!kind || p.kind === kind))
    .map((p) => p.id);
}

/** 가정 확인 한 건을 버전 충돌로(null 이면 끔). 설정 이름은 위 주석 */
export function failAssumption(id: string | null) {
  (mockSettings as unknown as { set(p: Record<string, unknown>): void }).set({ failAssumption: id });
}

/** 다른 사람이 먼저 판단한 것처럼 저장소에서 바로 받아들임 처리 */
export function judgeElsewhere(id: string) {
  const p = store().research[SLUG].proposals.find((x) => x.id === id);
  if (p) p.state = { domain: "proposal", value: "accepted", label: "받아들임 · 박검토 09:30" };
}

export function decisionCalls() {
  return pes.calls.filter((c) => c.name === "decision.record" && !c.replayed).length;
}

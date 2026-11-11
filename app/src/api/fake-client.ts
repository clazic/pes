import { ROUNDS, WORKSPACE } from "./fixture";
import type { PesClient, Receipt, RoundView } from "./types";

/**
 * 가짜 클라이언트(U1a) — 앱 안 메모리에서 합성 자료를 돌려준다. 네트워크를 쓰지 않는다.
 * 앱(루트 레이아웃)마다 하나씩 만들어 상태(오류 확인)가 시험 사이에 새지 않는다.
 * 돌려주는 값은 복사본이다(화면이 고쳐도 원본이 바뀌지 않음).
 */
export function createFakeClient(): PesClient {
  const rounds: RoundView[] = structuredClone(ROUNDS);
  let seq = 900;
  const copy = <T,>(v: T) => Promise.resolve(structuredClone(v));
  const find = (slug: string, edition: number) => (slug === WORKSPACE.slug && edition === WORKSPACE.edition ? WORKSPACE : null);

  return {
    listProjects: () => copy([{ slug: WORKSPACE.slug, edition: WORKSPACE.edition, current: WORKSPACE.current }]),
    getWorkspace: (slug, edition) => copy(find(slug, edition)),
    getRound(slug, edition, stage, round) {
      if (!find(slug, edition)) return copy(null);
      // 단계 시작은 "start"(round_id = null). 숫자는 1 이상의 정수만 — "0" · "01" · 그 밖은 없는 라운드
      const roundId = round === "start" ? null : /^[1-9]\d*$/.test(round) ? Number(round) : undefined;
      if (roundId === undefined) return copy(null);
      return copy(rounds.find((r) => r.stage === stage && r.round_id === roundId) ?? null);
    },
    acknowledgeAlert(slug, edition, alertId) {
      const alert = find(slug, edition) ? rounds.flatMap((r) => r.alerts).find((a) => a.id === alertId) : undefined;
      if (!alert) return Promise.reject(new Error("알림을 찾을 수 없습니다"));
      const receipt: Receipt = alert.acknowledged ?? { receipt_no: `접수 ${++seq}`, at: "방금" };
      alert.acknowledged = receipt;
      return copy(receipt);
    },
  };
}

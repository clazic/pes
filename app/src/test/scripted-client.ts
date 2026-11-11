import { createFakeClient } from "@/api/fake-client";
import { FORMAT_VERSION, PesApiError, type ApiErrorCode, type PesClient, type RoundView } from "@/api/types";

/**
 * SEL-83 U1c 시험 도구 — 가짜 클라이언트를 감싸 (1) 모든 호출을 기록하고 (2) getChanges 응답을 시험이 정하고 (3) 라운드 읽기를 바꿔 끼운다.
 * 계약 모양은 src/test/contract.ts 머리말 "PesClient 확장". 구현의 types.ts 가 getChanges 를 갖기 전에도 typecheck 가 되도록 느슨한 타입을 쓴다.
 */
export interface ChangesRead {
  cursor: string;
  txs: { tx_id: string; touched: string[] }[];
}
export interface Call {
  method: string;
  args: unknown[];
  /** 가짜 시계 시각(ms) */
  at: number;
}
type Step = ChangesRead | Error | "hang";

export function createScriptedClient() {
  const base = createFakeClient();
  const calls: Call[] = [];
  const queue: Step[] = [];
  const roundPatch = new Map<string, (r: RoundView) => RoundView>();
  let n = 0;
  const log = (method: string, args: unknown[]) => calls.push({ method, args, at: Date.now() });

  const client = {
    listProjects: () => (log("listProjects", []), base.listProjects()),
    getWorkspace: (slug: string, edition: number) => (log("getWorkspace", [slug, edition]), base.getWorkspace(slug, edition)),
    async getRound(slug: string, edition: number, stage: string, round: string) {
      log("getRound", [slug, edition, stage, round]);
      const r = await base.getRound(slug, edition, stage, round);
      const patch = roundPatch.get(`${stage}/${round}`);
      return r && patch ? patch(structuredClone(r)) : r;
    },
    acknowledgeAlert: (...a: Parameters<PesClient["acknowledgeAlert"]>) => (log("acknowledgeAlert", a), base.acknowledgeAlert(...a)),
    getChanges(slug: string, edition: number, cursor: string | null): Promise<ChangesRead> {
      log("getChanges", [slug, edition, cursor]);
      const step = queue.shift();
      if (step === "hang") return new Promise(() => {});
      if (step instanceof Error) return Promise.reject(step);
      return Promise.resolve(step ?? { cursor: `c${++n}`, txs: [] });
    },
  };

  const count = (method: string) => calls.filter((c) => c.method === method).length;
  return {
    client: client as unknown as PesClient,
    calls,
    count,
    /** 지금까지 기록을 비운다(화면이 처음 그려진 뒤 "그다음부터"만 보려고) */
    reset: () => void calls.splice(0),
    /** 다음 getChanges 응답을 줄 세운다 */
    queueChanges: (...steps: Step[]) => void queue.push(...steps),
    /** 이 라운드 읽기에 덧씌운다(예: 질문 버전을 올림). key = "research/2" */
    patchRound: (key: string, fn: (r: RoundView) => RoundView) => void roundPatch.set(key, fn),
    changesCalls: () => calls.filter((c) => c.method === "getChanges"),
    /** 읽기 목록 밖 메서드가 불렸는가(다른 쓰기·전송 감시) */
    unexpected: () => calls.filter((c) => !["listProjects", "getWorkspace", "getRound", "getChanges"].includes(c.method)),
  };
}

export const apiError = (code: string, message = "시험용 오류") =>
  new PesApiError({ format_version: FORMAT_VERSION, error: { code: code as unknown as ApiErrorCode, message, retryable: false }, request_id: "req-test" });

export const timeoutError = () => Object.assign(new Error("시간 초과"), { name: "TimeoutError" });

import { DEMO_HUMAN, demoU3, ROUNDS, WORKSPACE, type U3Data } from "./fixture";
import { FORMAT_VERSION, PesApiError, type ApiError, type ApiErrorCode, type ChangeTx, type CommandResult, type JudgeResult, type PesClient, type Receipt, type RoundView, type WorkspaceView } from "./types";

/**
 * 가짜 클라이언트(U1a) — 앱 안 메모리에서 합성 자료를 돌려준다. 네트워크를 쓰지 않는다.
 * 모양은 API 계약 그대로(types.ts): 쓰기는 멱등 키 필수 · CommandResult · 영수증 · 거절은 ApiError 봉투.
 * 앱(루트 레이아웃)마다 하나씩 만들어 상태(오류 확인 · 멱등 기록)가 시험 사이에 새지 않는다.
 * 돌려주는 값은 복사본이다(화면이 고쳐도 원본이 바뀌지 않음).
 * workspace 를 주면 그 작업 공간을 쓴다(앱은 U1d 칸이 있는 DEMO_WORKSPACE, 계약 시험은 WORKSPACE).
 * 가정 · 결정 · 반영(U3b)은 u3 자료를 읽고, 사람 판단 쓰기는 서버처럼 행을 바꾼다(다시 읽으면 반영 · 같은 멱등 키는 처음 영수증을 replayed 로).
 */

/** 오류 문장 — 2단계 코어(scripts/pes_core/api_support.ts)의 문장·다음 할 일과 같다 */
const ERRORS: Record<ApiErrorCode, { message: string; next_action: string }> = {
  not_found: { message: "요청한 대상을 찾을 수 없습니다.", next_action: "reread_context" },
  invalid_payload: { message: "요청 내용이 올바르지 않습니다.", next_action: "fix_request" },
  idempotency_key_reuse: { message: "같은 Idempotency-Key로 다른 요청을 보냈습니다.", next_action: "use_new_key" },
  conflict: { message: "현재 상태에서는 처리할 수 없는 요청입니다.", next_action: "reread_context" },
  not_supported: { message: "아직 서버에서 지원하지 않습니다.", next_action: "reread_context" },
  cursor_expired: { message: "변경 기록이 너무 오래되어 이어 받을 수 없습니다.", next_action: "reread_context" },
  cursor_invalid: { message: "변경 커서가 올바르지 않습니다.", next_action: "reread_context" },
};

export function createFakeClient(workspace: WorkspaceView = WORKSPACE, u3Data: U3Data = demoU3()): PesClient {
  const rounds: RoundView[] = structuredClone(ROUNDS);
  const u3 = structuredClone(u3Data);
  /** 사람 판단 쓰기의 멱등 기록 */
  const judged = new Map<string, { request: string; result: JudgeResult }>();
  let nextDecision = 1 + Math.max(0, ...u3.decisions.map((x) => Number(/^dec-(\d+)$/.exec(x.object_id)?.[1] ?? 0)));
  /** 멱등 기록: 키 → (요청 지문, 처음 결과) */
  const commits = new Map<string, { request: string; result: CommandResult<{ alert_id: string }> }>();
  let seq = 900;
  /** 공개 tx 기록(변경분 읽기) — 커서는 이 목록의 길이를 감싼 불투명 글자 */
  const txLog: ChangeTx[] = [];
  let req = 0;
  const copy = <T,>(v: T) => Promise.resolve(structuredClone(v));
  const find = (slug: string, edition: number) => (slug === workspace.slug && edition === workspace.edition ? workspace : null);
  const requestId = () => `req-${++req}`;
  const reject = (code: ApiErrorCode, target?: string) => {
    const body: ApiError = {
      format_version: FORMAT_VERSION,
      error: { code, message: ERRORS[code].message, retryable: false, ...(target ? { target } : {}), next_action: ERRORS[code].next_action },
      request_id: requestId(),
    };
    return Promise.reject(new PesApiError(body));
  };

  /** 사람 판단 쓰기 공통 — 순서(API 결정 4): 요청 검사 → 완료 영수증 재생 → 대상 검사 · 변경 */
  function judge(name: string, slug: string, edition: number, objectId: string, input: unknown, idempotencyKey: string | undefined, apply: () => string | null): Promise<JudgeResult> {
    if (!idempotencyKey) return reject("invalid_payload", "$.headers.idempotency-key");
    const request = JSON.stringify([name, slug, edition, objectId, input]);
    const done = judged.get(idempotencyKey);
    if (done) {
      if (done.request !== request) return reject("idempotency_key_reuse", "$.headers.idempotency-key");
      return copy({ ...done.result, request_id: requestId(), receipt: { ...done.result.receipt, replayed: true } });
    }
    if (!find(slug, edition)) return reject("not_found", "$.project");
    const outId = apply();
    if (outId === null) return reject("conflict");
    const n = String(++seq).padStart(4, "0");
    const receipt: Receipt = { receipt_no: n, tx_id: `tx-${n}`, committed_at: new Date().toISOString(), idempotency_key: idempotencyKey, replayed: false };
    txLog.push({ tx_id: receipt.tx_id, touched: ["workspace"] });
    const result: JudgeResult = { format_version: FORMAT_VERSION, request_id: requestId(), receipt, data: { object_id: outId, version_id: `${outId}-v${seq}` } };
    judged.set(idempotencyKey, { request, result });
    return copy(result);
  }

  return {
    listProjects: () => copy([{ slug: workspace.slug, edition: workspace.edition, current: workspace.current }]),
    getWorkspace: (slug, edition) => copy(find(slug, edition)),
    getRound(slug, edition, stage, round) {
      if (!find(slug, edition)) return copy(null);
      // 단계 시작은 "start"(round_id = null). 숫자는 1 이상의 정수만 — "0" · "01" · 그 밖은 없는 라운드
      const roundId = round === "start" ? null : /^[1-9]\d*$/.test(round) ? Number(round) : undefined;
      if (roundId === undefined) return copy(null);
      return copy(rounds.find((r) => r.stage === stage && r.round_id === roundId) ?? null);
    },
    acknowledgeAlert(slug, edition, alertId, idempotencyKey) {
      // 순서(API 결정 4): 요청 검사 → 완료 영수증 재생 → 대상 검사 · 변경
      if (!idempotencyKey) return reject("invalid_payload", "$.headers.idempotency-key");
      const request = JSON.stringify(["alert.acknowledge", slug, edition, alertId]);
      const done = commits.get(idempotencyKey);
      if (done) {
        if (done.request !== request) return reject("idempotency_key_reuse", "$.headers.idempotency-key");
        return copy({ ...done.result, request_id: requestId(), receipt: { ...done.result.receipt, replayed: true } });
      }
      const alert = find(slug, edition) ? rounds.flatMap((r) => r.alerts).find((a) => a.id === alertId) : undefined;
      if (!alert) return reject("not_found", "$.alert_id");
      const n = String(++seq).padStart(4, "0");
      const receipt: Receipt = { receipt_no: n, tx_id: `tx-${n}`, committed_at: new Date().toISOString(), idempotency_key: idempotencyKey, replayed: false };
      alert.acknowledged ??= { receipt_no: receipt.receipt_no, tx_id: receipt.tx_id, committed_at: receipt.committed_at };
      const owner = rounds.find((r) => r.alerts.includes(alert));
      txLog.push({ tx_id: receipt.tx_id, touched: owner ? [`round:${owner.stage}/${owner.round_id ?? "start"}`] : [] });
      const result: CommandResult<{ alert_id: string }> = { format_version: FORMAT_VERSION, request_id: requestId(), receipt, data: { alert_id: alertId } };
      commits.set(idempotencyKey, { request, result });
      return copy(result);
    },
    getAssumptions: (slug, edition) => copy(find(slug, edition) ? u3.assumptions : []),
    getDecisions: (slug, edition) => copy(find(slug, edition) ? u3.decisions : []),
    getReflections: (slug, edition, stage, round) => copy(find(slug, edition) ? (u3.reflections[`${stage}/${round}`] ?? null) : null),
    assessAssumption: (slug, edition, objectId, input, key) =>
      judge("assessAssumption", slug, edition, objectId, input, key, () => {
        const row = u3.assumptions.find((x) => x.object_id === objectId);
        // 판단 전이거나 다시 봐야 하는 가정만 판단할 수 있다 — 이미 끝난 가정은 거절(덮어쓰지 않음)
        if (!row || !(row.state === "proposed" || row.needs_review)) return null;
        if (input.verdict === "revise") {
          row.original ??= { version_id: row.version_id, statement: row.statement };
          row.statement = input.statement ?? row.statement;
        }
        row.state = input.verdict === "confirm" ? "confirmed" : input.verdict === "reject" ? "rejected" : "revised";
        row.assessed_by = DEMO_HUMAN;
        row.assessed_at = new Date().toISOString();
        row.needs_review = false;
        row.rationale = input.rationale;
        row.version += 1;
        return objectId;
      }),
    adoptDecision: (slug, edition, objectId, input, key) =>
      judge("adoptDecision", slug, edition, objectId, input, key, () => {
        const row = u3.decisions.find((x) => x.object_id === objectId);
        if (!row || row.state !== "proposed") return null;
        row.state = "adopted";
        row.decided_by = DEMO_HUMAN;
        row.rationale = input.rationale;
        row.version += 1;
        return objectId;
      }),
    supersedeDecision: (slug, edition, objectId, input, key) =>
      judge("supersedeDecision", slug, edition, objectId, input, key, () => {
        const old = u3.decisions.find((x) => x.object_id === objectId);
        if (!old || old.state !== "adopted") return null;
        const id = `dec-${nextDecision++}`;
        old.state = "superseded";
        old.superseded_by = id;
        u3.decisions.push({
          object_id: id,
          version_id: `${id}-v1`,
          version: 1,
          statement: input.statement,
          state: "adopted",
          scope: old.scope,
          proposed_by: DEMO_HUMAN,
          decided_by: DEMO_HUMAN,
          rationale: input.rationale,
          supersedes: { object_id: objectId, statement: old.statement },
          superseded_by: null,
          originated_from: null,
          source: null,
        });
        return id;
      }),
    revokeDecision: (slug, edition, objectId, input, key) =>
      judge("revokeDecision", slug, edition, objectId, input, key, () => {
        const row = u3.decisions.find((x) => x.object_id === objectId);
        if (!row || row.state !== "adopted") return null;
        row.state = "revoked";
        row.decided_by = DEMO_HUMAN;
        row.rationale = input.rationale;
        row.version += 1;
        return objectId;
      }),
    getChanges(slug, edition, cursor) {
      if (!find(slug, edition)) return reject("not_found", "$.project");
      const head = `fake-${txLog.length}`;
      if (cursor === null) return copy({ cursor: head, txs: [] });
      const m = /^fake-(\d+)$/.exec(cursor);
      const at = m ? Number(m[1]) : NaN;
      if (!(at >= 0 && at <= txLog.length)) return reject("cursor_invalid", "$.cursor");
      return copy({ cursor: head, txs: txLog.slice(at) });
    },
  };
}

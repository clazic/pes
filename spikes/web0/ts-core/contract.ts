// WEB0 spike contract primitives. Not product code; do not import from web/.
// The contract is defined by docs/plan/fixtures/api-v1/ and stage-1-api.md 3·6.

export const FORMAT_VERSION = "1.0" as const;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface SuccessEnvelope<T = unknown> {
  format_version: typeof FORMAT_VERSION;
  data: T;
  meta: { request_id: string; [key: string]: unknown };
}

export interface ErrorDetail {
  code: string;
  message: string;
  retryable: boolean;
  target: string;
  details: Record<string, unknown>;
  next_action: string;
}

export interface ErrorEnvelope {
  format_version: typeof FORMAT_VERSION;
  request_id: string;
  error: ErrorDetail;
}

export class PesError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly target: string;
  readonly details: Record<string, unknown>;
  readonly nextAction: string;

  constructor(input: {
    code: string;
    status: number;
    message: string;
    retryable?: boolean;
    target?: string;
    details?: Record<string, unknown>;
    nextAction?: string;
  }) {
    super(input.message);
    this.name = "PesError";
    this.code = input.code;
    this.status = input.status;
    this.retryable = input.retryable ?? false;
    this.target = input.target ?? "$";
    this.details = input.details ?? {};
    this.nextAction = input.nextAction ?? "none";
  }

  toEnvelope(requestId: string): ErrorEnvelope {
    return {
      format_version: FORMAT_VERSION,
      request_id: requestId,
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        target: this.target,
        details: this.details,
        next_action: this.nextAction,
      },
    };
  }
}

export const errors = {
  unauthorized: (details: Record<string, unknown> = { reason: "missing_bearer_token" }) =>
    new PesError({
      code: "unauthorized",
      status: 401,
      message: "인증 정보가 없거나 만료되었습니다.",
      target: "$.headers.Authorization",
      details,
      nextAction: "reauthenticate",
    }),
  forbidden: (details: Record<string, unknown> = {}) =>
    new PesError({
      code: "forbidden",
      status: 403,
      message: "이 작업을 수행할 권한이 없습니다.",
      target: "$.headers.Authorization",
      details,
      nextAction: "check_permission",
    }),
  projectNotFound: (projectId: string) =>
    new PesError({
      code: "project_not_found",
      status: 404,
      message: "프로젝트를 찾을 수 없습니다.",
      target: "$.path.project_id",
      details: { project_id: projectId },
      nextAction: "check_project_id",
    }),
  versionNotFound: (objectId: string, versionId: string) =>
    new PesError({
      code: "version_not_found",
      status: 404,
      message: "요청한 객체 버전을 찾을 수 없습니다.",
      target: "$.path.version_id",
      details: { object_id: objectId, version_id: versionId },
      nextAction: "reread_object_versions",
    }),
  runNotFound: (runId: string) =>
    new PesError({
      code: "run_not_found",
      status: 404,
      message: "실행을 찾을 수 없습니다.",
      target: "$.path.run_id",
      details: { run_id: runId },
      nextAction: "check_run_id",
    }),
  leaseHeld: (holderRunId: string, expiresAt: number, retryAfterMs: number) =>
    new PesError({
      code: "lease_held",
      status: 409,
      message: "다른 실행이 프로젝트 실행 담당(lease)을 가지고 있습니다.",
      retryable: true,
      target: "$.body.run_id",
      details: { holder_run_id: holderRunId, expires_at: expiresAt, retry_after_ms: retryAfterMs },
      nextAction: "retry_after_lease",
    }),
  notLeaseHolder: (runId: string, currentLeaseId: string | null) =>
    new PesError({
      code: "not_lease_holder",
      status: 409,
      message: "이 실행의 lease 보유자가 아닙니다.",
      target: "$.body.lease_id",
      details: { run_id: runId, current_lease_id: currentLeaseId },
      nextAction: "use_current_lease",
    }),
  leaseLost: (runId: string) =>
    new PesError({
      code: "lease_lost",
      status: 409,
      message: "실행 담당(lease)이 만료되었거나 회수되었습니다.",
      target: "$.body.lease_id",
      details: { run_id: runId },
      nextAction: "reclaim_run",
    }),
  revConflict: (input: {
    expected: string;
    current: string;
    objectId?: string;
    target?: string;
  }) =>
    new PesError({
      code: "rev_conflict",
      status: 409,
      message: "요청한 기반 버전이 현재 버전과 다릅니다.",
      target: input.target ?? "$.body.results[0].base_version_id",
      details: {
        expected: input.expected,
        current: input.current,
        ...(input.objectId ? { object_id: input.objectId } : {}),
      },
      nextAction: "reread_context",
    }),
  runTerminal: (runId: string, status: string) =>
    new PesError({
      code: "run_terminal",
      status: 409,
      message: "이미 끝난 실행입니다.",
      target: "$.path.run_id",
      details: { run_id: runId, status },
      nextAction: "create_new_run",
    }),
  validationFailed: (target: string, details: Record<string, unknown> = {}) =>
    new PesError({
      code: "validation_failed",
      status: 422,
      message: "요청 본문이 계약과 다릅니다.",
      target,
      details,
      nextAction: "fix_request",
    }),
  idempotencyKeyReused: () =>
    new PesError({
      code: "idempotency_key_reused",
      status: 409,
      message: "같은 멱등 키로 다른 요청을 보냈습니다.",
      target: "$.headers.Idempotency-Key",
      details: {},
      nextAction: "use_new_idempotency_key",
    }),
  missingIdempotencyKey: () =>
    new PesError({
      code: "validation_failed",
      status: 422,
      message: "쓰기 요청에는 Idempotency-Key가 필요합니다.",
      target: "$.headers.Idempotency-Key",
      details: { required: true },
      nextAction: "add_idempotency_key",
    }),
  routeNotFound: (method: string, pathname: string) =>
    new PesError({
      code: "route_not_found",
      status: 404,
      message: "요청한 경로를 찾을 수 없습니다.",
      target: "$.path",
      details: { method, path: pathname },
      nextAction: "check_route",
    }),
  methodNotAllowed: (method: string, pathname: string) =>
    new PesError({
      code: "method_not_allowed",
      status: 405,
      message: "이 경로에서 허용하지 않는 메서드입니다.",
      target: "$.method",
      details: { method, path: pathname },
      nextAction: "check_method",
    }),
  internal: (message: string) =>
    new PesError({
      code: "internal_error",
      status: 500,
      message,
      target: "$",
      details: {},
      nextAction: "contact_operator",
    }),
};

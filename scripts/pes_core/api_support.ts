// Pure helpers for the HTTP API (stage 2 PR14): the finished error envelope,
// signed opaque cursors, and the in-memory request budgets. Nothing here
// touches the database.

import { createHmac, timingSafeEqual } from "node:crypto";

import { ApiError } from "./errors.ts";

// ---------------------------------------------------------------------------
// errors

/** An error with everything the envelope needs; thrown by the API layer. */
export class Fail extends Error {
  readonly code: string;
  readonly target: string | null;
  readonly details: Record<string, unknown> | null;
  readonly next_action: string | null;
  readonly headers: Record<string, string>;

  constructor(
    code: string,
    opts: {
      target?: string | null;
      details?: Record<string, unknown> | null;
      next_action?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    super(code);
    this.name = "Fail";
    this.code = code;
    this.target = opts.target ?? null;
    this.details = opts.details ?? null;
    this.next_action = opts.next_action ?? null;
    this.headers = opts.headers ?? {};
  }
}

export const ERROR_STATUS: Readonly<Record<string, number>> = Object.freeze({
  unauthenticated: 401,
  forbidden: 403,
  human_required: 403,
  owner_required: 403,
  policy_blocked: 403,
  input_not_visible: 403,
  not_found: 404,
  method_not_allowed: 405,
  invalid_payload: 400,
  cursor_invalid: 400,
  validation_failed: 422,
  evidence_required: 422,
  payload_too_large: 413,
  idempotency_key_reuse: 409,
  rev_conflict: 409,
  conflict: 409,
  supersedes_conflict: 409,
  lease_lost: 409,
  run_terminal: 409,
  question_version_changed: 409,
  stale_stage: 409,
  stage_not_active: 409,
  already_sealed: 409,
  thread_closed: 409,
  already_resolved: 409,
  basis_changed: 409,
  cursor_expired: 410,
  rate_limited: 429,
  not_supported: 501,
  internal_error: 500,
  schema_not_ready: 503,
});

export const ERROR_CODES: readonly string[] = Object.freeze(Object.keys(ERROR_STATUS));

const MESSAGE: Readonly<Record<string, string>> = Object.freeze({
  unauthenticated: "인증이 필요합니다. 올바른 자격으로 다시 요청해 주세요.",
  forbidden: "이 요청을 할 권한이 없습니다.",
  human_required: "이 작업은 소유자 사람만 할 수 있습니다.",
  owner_required: "이 작업은 프로젝트 소유자만 할 수 있습니다.",
  policy_blocked: "프로젝트 정책이 이 요청을 막고 있습니다.",
  input_not_visible: "이 실행이 받을 수 있는 입력이 아닙니다.",
  not_found: "요청한 대상을 찾을 수 없습니다.",
  method_not_allowed: "이 경로에서 쓸 수 없는 메서드입니다.",
  invalid_payload: "요청 내용이 올바르지 않습니다.",
  cursor_invalid: "커서가 올바르지 않습니다.",
  validation_failed: "입력 값이 규칙에 맞지 않습니다.",
  evidence_required: "적용 증거(결과 버전 또는 적용 tx)가 없습니다.",
  payload_too_large: "요청 본문이 너무 큽니다.",
  idempotency_key_reuse: "같은 Idempotency-Key로 다른 요청을 보냈습니다.",
  rev_conflict: "기준 버전이 현재와 다릅니다.",
  conflict: "현재 상태에서는 처리할 수 없는 요청입니다.",
  supersedes_conflict: "대체 대상 결정이 현재 결정과 맞지 않습니다.",
  lease_lost: "실행 권한(lease)을 잃었습니다. 다시 claim해야 합니다.",
  run_terminal: "이미 끝난 실행입니다.",
  question_version_changed: "질문이 그사이 바뀌었습니다. 새 질문을 다시 읽어 주세요.",
  stale_stage: "단계가 그사이 바뀌었습니다. 다시 읽어 주세요.",
  stage_not_active: "진행 중이 아닌 단계입니다.",
  already_sealed: "이미 봉인된 라운드입니다.",
  thread_closed: "닫힌 스레드에는 답글을 남길 수 없습니다.",
  already_resolved: "이미 처리된 스레드입니다.",
  basis_changed: "후속 조치의 기반 버전이 바뀌었습니다.",
  cursor_expired: "변경분 커서가 만료되었습니다. 전체 읽기 모델을 다시 받아야 합니다.",
  rate_limited: "요청이 너무 잦습니다. 잠시 뒤 다시 시도해 주세요.",
  not_supported: "2단계에서 지원하지 않는 기능입니다.",
  internal_error: "서버 안에서 문제가 생겼습니다. 잠시 뒤 다시 시도해 주세요.",
  schema_not_ready: "PES 데이터베이스가 아직 준비되지 않았습니다.",
});

export const NEXT_ACTION: Readonly<Record<string, string>> = Object.freeze({
  unauthenticated: "authenticate",
  forbidden: "use_owner_session",
  human_required: "use_owner_session",
  owner_required: "use_owner_session",
  policy_blocked: "owner_enable_policy",
  input_not_visible: "check_run_targets",
  not_found: "reread_context",
  method_not_allowed: "fix_request",
  invalid_payload: "fix_request",
  cursor_invalid: "reread_context",
  validation_failed: "fix_request",
  evidence_required: "add_evidence",
  payload_too_large: "fix_request",
  idempotency_key_reuse: "use_new_key",
  rev_conflict: "reread_context",
  conflict: "reread_context",
  supersedes_conflict: "reread_decisions",
  lease_lost: "reclaim_run",
  run_terminal: "create_new_run",
  question_version_changed: "reread_question",
  stale_stage: "reread_stage",
  stage_not_active: "reread_stage",
  already_sealed: "reread_round",
  thread_closed: "open_new_thread",
  already_resolved: "reread_thread",
  basis_changed: "reread_followup",
  cursor_expired: "resync",
  rate_limited: "retry_after",
  not_supported: "see_capabilities",
  internal_error: "retry_later",
  schema_not_ready: "migrate_database",
});

export function message_for(code: string, target: string | null): string {
  const base = MESSAGE[code] ?? MESSAGE.internal_error!;
  if ((code === "invalid_payload" || code === "validation_failed") && target !== null) {
    return `${base} (${target})`;
  }
  return base;
}

export function retryable_for(code: string): boolean {
  return code === "rate_limited" || code === "schema_not_ready";
}

/** Details from a core ApiError, kept only when they are plain strings/numbers/booleans (or a list of strings, e.g. question ids). */
function plain_details(details: unknown): Record<string, unknown> | null {
  if (details === null || typeof details !== "object" || Array.isArray(details)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    if (typeof value === "bigint") out[key] = value.toString();
    else if (typeof value === "number") out[key] = String(value);
    else if (typeof value === "string" || typeof value === "boolean" || value === null) out[key] = value;
    else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) out[key] = [...value];
  }
  return out;
}

/**
 * invalid_payload reasons that are 422 validation_failed over HTTP: the body is well formed, the content is
 * not acceptable (a value outside the options, a bundle with a required question missing, ...).
 */
const VALIDATION_REASONS: ReadonlySet<string> = new Set([
  "value_not_allowed",
  "required_missing",
  "not_applicable",
  "single_requires_one_item",
  "self_merge",
]);

/** Map a core ApiError (or anything else) to a Fail. Route code may refine it afterwards. */
export function fail_from(error: unknown): Fail {
  if (error instanceof Fail) return error;
  if (!(error instanceof ApiError)) return new Fail("internal_error");
  let code = error.code;
  const details = plain_details(error.details);
  if (code === "policy_denied") code = "policy_blocked";
  if (code === "unknown_command") code = "invalid_payload";
  if (code === "conflict" && details !== null && typeof details.reason === "string") {
    const { reason, ...rest } = details;
    if (["stale_stage", "stage_not_active", "already_sealed", "question_version_changed", "run_terminal", "thread_closed", "already_resolved", "basis_changed"].includes(reason as string)) {
      return new Fail(reason as string, { details: rest });
    }
  }
  if (!(code in ERROR_STATUS)) return new Fail("internal_error");
  if (code === "invalid_payload" && details !== null && VALIDATION_REASONS.has(details.reason as string)) {
    return new Fail("validation_failed", { details });
  }
  return new Fail(code, { details: code === "rev_conflict" ? details : null });
}

// ---------------------------------------------------------------------------
// cursors

export interface CursorBody {
  /** project id */
  p: string;
  /** scope binding (caller kind, run, ...) */
  s: string;
  /** database_instance_id */
  d: string;
  /** cursor_epoch as a decimal string */
  e: string;
  /** position (event_seq / row position) as a decimal string */
  q: string;
}

function b64(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export function make_cursor(secret: string, body: CursorBody): string {
  const payload = b64(Buffer.from(JSON.stringify([body.p, body.s, body.d, body.e, body.q]), "utf8"));
  const sig = b64(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

/** Returns the body, or null when the text is not a cursor this server made. */
export function read_cursor(secret: string, text: string): CursorBody | null {
  const dot = text.indexOf(".");
  if (dot < 1 || text.indexOf(".", dot + 1) !== -1) return null;
  const payload = text.slice(0, dot);
  const given = Buffer.from(text.slice(dot + 1), "utf8");
  const want = Buffer.from(b64(createHmac("sha256", secret).update(payload).digest()), "utf8");
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 5 ||
      !parsed.every((entry) => typeof entry === "string")
    ) {
      return null;
    }
    const [p, s, d, e, q] = parsed as string[];
    if (!/^(0|[1-9][0-9]*)$/.test(q!)) return null;
    return { p: p!, s: s!, d: d!, e: e!, q: q! };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// request budgets (in memory, per process)

export const WINDOW_MS = 60_000;

export class Budgets {
  readonly #hits = new Map<string, number[]>();
  readonly #polls = new Map<string, number>();

  /** Count one request; returns retry_after_ms when the budget is spent, else null. */
  take(key: string, limit: number, now: number): number | null {
    const list = (this.#hits.get(key) ?? []).filter((at) => at > now - WINDOW_MS);
    if (list.length >= limit) {
      this.#hits.set(key, list);
      return Math.min(WINDOW_MS, Math.max(1, list[0]! + WINDOW_MS - now));
    }
    list.push(now);
    this.#hits.set(key, list);
    return null;
  }

  /** Give a slot back (a request refused for its own bad input is not "served"). */
  refund(key: string, at: number): void {
    const list = this.#hits.get(key);
    if (list === undefined) return;
    const i = list.lastIndexOf(at);
    if (i >= 0) list.splice(i, 1);
  }

  /** retry_after_ms when the last empty poll of this key is younger than the gap. */
  poll_wait(key: string, gap_ms: number, now: number): number | null {
    const last = this.#polls.get(key);
    if (last === undefined) return null;
    const left = last + gap_ms - now;
    return left > 0 ? Math.min(gap_ms, left) : null;
  }

  mark_empty_poll(key: string, now: number): void {
    this.#polls.set(key, now);
  }

  clear_poll(key: string): void {
    this.#polls.delete(key);
  }
}

const BUDGETS_OF_DB = new WeakMap<object, Budgets>();

/**
 * One budget per open database handle: ApiApp instances built over the same handle in one process share it,
 * so a rebuilt ApiApp does not reset the minute window. Across processes (the serve.py bridge starts one per
 * request) serve.py applies the same limits itself.
 */
export function budgets_for(db: object): Budgets {
  let budgets = BUDGETS_OF_DB.get(db);
  if (budgets === undefined) {
    budgets = new Budgets();
    BUDGETS_OF_DB.set(db, budgets);
  }
  return budgets;
}

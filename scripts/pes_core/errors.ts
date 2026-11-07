// Typed API errors and the language-neutral JSON error envelope (stage 2 PR4).
//
// The codes below are the contract shared with
// tests/fixtures/contracts/commands/*.json. Callers must not invent SQL/table
// error codes outside this closed list.

export type ApiErrorCode =
  | "unknown_command"
  | "invalid_payload"
  | "forbidden"
  | "not_found"
  | "policy_denied"
  | "idempotency_key_reuse"
  | "rev_conflict"
  | "conflict";

export interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface ErrorEnvelope {
  error: ErrorBody;
}

export class ApiError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }
}

/** Serialize an ApiError as `{error: {code, message, details?}}`; omit absent details. */
export function error_envelope(error: ApiError): ErrorEnvelope {
  const body: ErrorBody = { code: error.code, message: error.message };
  if (error.details !== undefined) {
    body.details = error.details;
  }
  return { error: body };
}

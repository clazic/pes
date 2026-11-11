// A small client for the PES HTTP API, shared by the method-B adapters (stage 2 PR20a, SEL-53).
//
// `api` is anything with `handle({method, path, headers, body})` that answers like ApiApp.handle: the in-process
// ApiApp (tests, the desktop process) or an HTTP bridge to a running local server (see http_api.ts). The client
// holds no credential of its own: each call names the headers it needs, and nothing here logs them.

export interface ApiRequestLike {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | Uint8Array | null;
}

export interface ApiResponseLike {
  status: number;
  headers: Record<string, string>;
  json: unknown;
  bytes: Uint8Array | null;
}

export interface ApiLike {
  handle(request: ApiRequestLike): Promise<ApiResponseLike>;
}

/** The error object of an API envelope (or one made here when the answer is not an envelope). */
export interface ApiErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
  target: string | null;
  details: unknown;
  next_action: string;
}

export type ApiResult =
  | { ok: true; status: number; data: unknown; replayed: boolean }
  | { ok: false; status: number; error: ApiErrorInfo };

function is_record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function broken(status: number): ApiResult {
  return {
    ok: false,
    status,
    error: {
      code: "internal_error",
      message: "PES 서버의 답을 읽을 수 없습니다. 잠시 뒤 다시 시도해 주세요.",
      retryable: true,
      target: null,
      details: null,
      next_action: "retry_later",
    },
  };
}

/** Send one request and read the envelope. A transport failure becomes an `internal_error` result, never a throw. */
export async function api_request(api: ApiLike, request: ApiRequestLike): Promise<ApiResult> {
  let response: ApiResponseLike;
  try {
    response = await api.handle(request);
  } catch {
    return {
      ok: false,
      status: 0,
      error: {
        code: "unavailable",
        message: "PES 서버에 연결하지 못했습니다. 서버가 켜져 있는지 확인해 주세요.",
        retryable: true,
        target: null,
        details: null,
        next_action: "retry_later",
      },
    };
  }
  const body = response.json;
  if (!is_record(body)) return broken(response.status);
  if (response.status >= 200 && response.status < 300 && "data" in body) {
    return { ok: true, status: response.status, data: body.data, replayed: body.replayed === true };
  }
  const error = body.error;
  if (!is_record(error) || typeof error.code !== "string") return broken(response.status);
  return {
    ok: false,
    status: response.status,
    error: {
      code: error.code,
      message: typeof error.message === "string" ? error.message : "요청을 처리하지 못했습니다.",
      retryable: error.retryable === true,
      target: typeof error.target === "string" ? error.target : null,
      details: error.details ?? null,
      next_action: typeof error.next_action === "string" ? error.next_action : "retry_later",
    },
  };
}

export function project_path(project_id: string, rest = ""): string {
  return `/api/v1/projects/${encodeURIComponent(project_id)}${rest}`;
}

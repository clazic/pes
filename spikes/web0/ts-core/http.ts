// Shared HTTP mapping for the Node/Vercel handler and the Worker entry.

import { PesError, type ErrorEnvelope, type SuccessEnvelope } from "./contract.ts";
import type { Auth, CoreRequest, CoreResponse, Envelope, RequestContext } from "./service.ts";
import { dispatch, requestId } from "./service.ts";
import type { Db } from "./db.ts";
import { IDS, type Ids } from "./store.ts";

export interface HttpRequestLike {
  method: string;
  pathname: string;
  headers: Record<string, string>;
  body?: unknown;
}

export function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export function authFromHeaders(headers: Record<string, string>): Auth {
  const authorization = headers.Authorization ?? headers.authorization ?? "";
  if (authorization.includes("PES_AGENT_TOKEN") || authorization.startsWith("Bearer pes_")) {
    return { kind: "agent", actorId: "act_01J9Z3K7Q7", projectId: "prj_01J9Z3K7Q2" };
  }
  if (authorization.includes("PES_SESSION") || authorization.startsWith("Bearer ses_")) {
    return { kind: "human", actorId: "act_01J9Z3K7Q8", projectId: "prj_01J9Z3K7Q2" };
  }
  return { kind: "anonymous", actorId: "", projectId: null };
}

export interface HandleOptions {
  db: Db;
  now?: number;
  requireCapabilitiesAuth?: boolean;
  ids?: Ids;
}

export async function handleCore(
  options: HandleOptions,
  request: HttpRequestLike,
): Promise<{ status: number; envelope: Envelope }> {
  const ctx: RequestContext = {
    db: options.db,
    auth: authFromHeaders(request.headers),
    now: options.now ?? Date.now(),
    ids: options.ids ?? IDS,
    requireCapabilitiesAuth: options.requireCapabilitiesAuth,
  };
  try {
    const result: CoreResponse = await dispatch(ctx, request as CoreRequest);
    return { status: result.status, envelope: result.body };
  } catch (error) {
    if (error instanceof PesError) {
      return { status: error.status, envelope: error.toEnvelope(requestId()) };
    }
    const internal = new PesError({
      code: "internal_error",
      status: 500,
      message: "시험 구현 내부 오류입니다.",
      target: "$",
      details: { reason: error instanceof Error ? error.name : "unknown" },
      nextAction: "contact_operator",
    });
    return { status: 500, envelope: internal.toEnvelope(requestId()) };
  }
}

export function parseJsonBody(text: string): unknown {
  if (text.trim().length === 0) return undefined;
  return JSON.parse(text) as unknown;
}

export function isErrorEnvelope(value: Envelope): value is ErrorEnvelope {
  return "error" in value;
}

export function isSuccessEnvelope<T>(value: Envelope): value is SuccessEnvelope<T> {
  return "data" in value;
}

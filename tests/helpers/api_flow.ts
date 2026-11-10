// SEL-47 (stage 2 PR14) shared pieces for the HTTP API tests. Everything is synthetic.
//
// What PR14 decides (the worker implements it; the tests below pin it):
//
//   Error envelope (completes PR13): { format_version, error: { code, message, retryable, target,
//   details, next_action }, request_id }
//     code        English snake_case. The HTTP name for the Go-OFF refusal is `policy_blocked`
//                 (stage-1-api.md 3절/2절 #15; the core ApiError keeps `policy_denied` internally).
//     message     Korean (contains Hangul), never SQL/table/stack text.
//     retryable   true only for rate_limited and 503; every other code is false.
//     target      JSON path of the faulty field ("$.body.snapshot_id", "$.query.cursor",
//                 "$.headers.idempotency-key") or null when no single field is at fault.
//     next_action a short English token, never null: see NEXT_ACTION below.
//   Credential order: the request is authenticated BEFORE the project is looked up, so an
//   unauthenticated caller cannot tell a missing project from an existing one (401 first, 404 after).

import assert from "node:assert/strict";

import { ApiApp } from "../../scripts/pes_core/api.ts";
import {
  SESSION_SECRET,
  assert_error,
  project_path,
  type ApiEnv,
  type ApiResponse,
} from "./api_env.ts";

export const P = (env: ApiEnv, rest = ""): string => project_path(env, rest);

/** The tokens `next_action` takes for the codes the tests pin. */
export const NEXT_ACTION = {
  unauthenticated: "authenticate",
  forbidden_human_only: "use_owner_session",
  rev_conflict: "reread_context",
  conflict: "reread_context",
  not_found: "reread_context",
  policy_blocked: "owner_enable_policy",
  invalid_payload: "fix_request",
  rate_limited: "retry_after",
  cursor_invalid: "resync",
  idempotency_key_reuse: "use_new_key",
  not_supported: "see_capabilities",
} as const;

const HANGUL = /[가-힣]/;

/** assert_error plus the PR14 error-envelope rules: Korean message, next_action present, retryable value. */
export function assert_final_error(
  res: ApiResponse,
  status: number,
  code: string,
  expect: { retryable?: boolean; next_action?: string; target?: string | RegExp | null } = {},
): any {
  const error = assert_error(res, status, code);
  assert.match(error.message, HANGUL, `the message of ${code} is Korean: ${error.message}`);
  assert.equal(typeof error.next_action, "string", `${code} carries a next_action token`);
  assert.ok(error.next_action.length > 0);
  assert.match(error.next_action, /^[a-z][a-z0-9_]*$/, "next_action is a snake_case token");
  assert.equal(error.retryable, expect.retryable ?? false, `${code} retryable`);
  if (expect.next_action !== undefined) assert.equal(error.next_action, expect.next_action);
  if (expect.target === null) assert.equal(error.target, null);
  else if (typeof expect.target === "string") assert.equal(error.target, expect.target);
  else if (expect.target instanceof RegExp) {
    assert.equal(typeof error.target, "string", `${code} names the faulty field`);
    assert.match(error.target, expect.target);
  }
  return error;
}

/** A new ApiApp over the same database: what a server restart looks like to a client. */
export function restart_app(env: ApiEnv): void {
  env.app = new ApiApp({
    db: env.db,
    clock: env.clock,
    objects_dir: env.objects,
    local_session_secret: SESSION_SECRET,
    sleep: (ms: number) =>
      env.hold_sleep
        ? new Promise<void>((done) => {
            env.gates.push({ ms, release: done });
          })
        : Promise.resolve(),
  });
}

/** Wait until the app under test has reached its (held) sleep; then the long-poll is really waiting. */
export async function until_gate(env: ApiEnv, count = 1): Promise<void> {
  for (let i = 0; i < 200 && env.gates.length < count; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(env.gates.length >= count, "the request never reached its wait");
}

/**
 * The closed list of 2단계 HTTP routes (docs/plan/stage-2.md 4.2.1), written out by hand on purpose:
 * the OpenAPI paths, the capabilities `routes`, and this list must be the same set.
 * {id} = project, {r} = run, {o} {v} = object/version, {b} = blob, {s} = stage, {q} = question,
 * {rd} = round, {op} = operation, {key} = Idempotency-Key.
 */
export const EXPECTED_ROUTES: readonly string[] = [
  "GET /api/v1/capabilities",
  "POST /api/v1/project-registrations",
  "POST /api/v1/projects",
  "GET /api/v1/projects/{id}/changes",
  "GET /api/v1/projects/{id}/context",
  "GET /api/v1/projects/{id}/files/{b}/content",
  "GET /api/v1/projects/{id}/objects/{o}/versions/{v}",
  "GET /api/v1/projects/{id}/operations/{op}",
  "GET /api/v1/projects/{id}/requests/{key}",
  "GET /api/v1/projects/{id}/runs/{r}/inputs",
  "POST /api/v1/projects/{id}/claims",
  "POST /api/v1/projects/{id}/policies/opencode-go/revisions",
  "POST /api/v1/projects/{id}/questions",
  "POST /api/v1/projects/{id}/questions/{q}/revisions",
  "POST /api/v1/projects/{id}/rounds/{rd}/seal",
  "POST /api/v1/projects/{id}/runs",
  "POST /api/v1/projects/{id}/runs/{r}/cancel",
  "POST /api/v1/projects/{id}/runs/{r}/complete",
  "POST /api/v1/projects/{id}/runs/{r}/handoffs",
  "POST /api/v1/projects/{id}/runs/{r}/heartbeat",
  "POST /api/v1/projects/{id}/runs/{r}/input-receipts",
  "POST /api/v1/projects/{id}/runs/{r}/interrupt",
  "POST /api/v1/projects/{id}/runs/{r}/release",
  "POST /api/v1/projects/{id}/runs/{r}/results",
  "POST /api/v1/projects/{id}/runs/{r}/wait",
  "POST /api/v1/projects/{id}/stages/{s}/approve",
  "POST /api/v1/projects/{id}/stages/{s}/reopen",
  "POST /api/v1/projects/{id}/stages/{s}/rounds",
  "POST /api/v1/projects/{id}/submissions",
  "POST /api/v1/projects/{id}/uploads",
  "POST /api/v1/projects/{id}/uploads/{b}/complete",
  "PUT /api/v1/projects/{id}/uploads/{b}",
].sort();

/** Routes the closed 2단계 list does NOT have and capabilities must say are unsupported (no fake success). */
export const EXPECTED_UNSUPPORTED: readonly string[] = [
  "POST /api/v1/projects/{id}/exports",
  "POST /api/v1/projects/{id}/threads",
  "POST /api/v1/projects/{id}/threads/{t}/messages",
  "POST /api/v1/projects/{id}/assumptions",
  "POST /api/v1/projects/{id}/decisions",
  "POST /api/v1/projects/{id}/reflections",
];

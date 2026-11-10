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
//     next_action a short English token, never null: see NEXT_ACTION below (names from docs/plan/fixtures/api-v1).
//   Request bodies may carry "format_version": "1.0" (the documents' examples do); any other value is 400.
//   Credential order: the request is authenticated BEFORE the project is looked up, so an
//   unauthenticated caller cannot tell a missing project from an existing one (401 first, 404 after).

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { ApiApp } from "../../scripts/pes_core/api.ts";
import {
  SESSION_SECRET,
  assert_error,
  project_path,
  type ApiEnv,
  type ApiResponse,
} from "./api_env.ts";

export const P = (env: ApiEnv, rest = ""): string => project_path(env, rest);

/**
 * The tokens `next_action` takes. Names follow docs/plan/fixtures/api-v1 (the language-neutral contract);
 * the few the documents do not name (conflict, key reuse, 501, 429) are this suite's choice.
 */
export const NEXT_ACTION = {
  unauthenticated: "authenticate",
  human_required: "use_owner_session", // 403 human_required / owner_required / forbidden on owner-only actions
  forbidden_holder: "use_current_holder", // handoffs by someone who is not the lease holder
  rev_conflict: "reread_context",
  conflict: "reread_context",
  not_found: "reread_context",
  policy_blocked: "owner_enable_policy",
  invalid_payload: "fix_request",
  validation_failed: "fix_request",
  rate_limited: "retry_after",
  cursor_invalid: "reread_context",
  cursor_expired: "resync",
  idempotency_key_reuse: "use_new_key",
  not_supported: "see_capabilities",
  lease_lost: "reclaim_run",
  run_terminal: "create_new_run",
  question_version_changed: "reread_question",
  question_rev_conflict: "reread_question",
  stale_stage: "reread_stage",
  stage_not_active: "reread_stage",
  already_sealed: "reread_round",
  input_not_visible: "check_run_targets",
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

/**
 * The documents' own contract: every docs/plan/fixtures/api-v1/*.json with its operation name, method and
 * path (project id normalised to {id}). capabilities must say supported:true exactly for the operations whose
 * route is in the closed 2단계 list, and false for the rest.
 */
export function doc_operations(): Array<{ operation: string; route: string }> {
  const dir = new URL("../../docs/plan/fixtures/api-v1/", import.meta.url);
  const out: Array<{ operation: string; route: string }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const doc = JSON.parse(readFileSync(new URL(name, dir), "utf8")) as { operation: string; method: string; path: string };
    const path = doc.path.replace("/api/v1/projects/{project_id}", "/api/v1/projects/{id}").replace(/\/api\/v1\/projects\/\{project_id\}$/, "/api/v1/projects/{id}");
    out.push({ operation: doc.operation, route: `${doc.method} ${path}` });
  }
  return out;
}

/**
 * DOCUMENT FIXES FOR THE IMPLEMENTER (leader decision on D1~D12): the merged PR13 routes and the merged core
 * are the reference. Where docs/plan/fixtures/api-v1 or its README disagree, the implementer edits the
 * DOCUMENTS in this PR (the tests were never changed to follow them). Listed file by file:
 *
 *  D1  README.md 2절 1번 (success envelope)            {format_version, data, meta:{request_id}}
 *        -> {format_version, request_id, data, replayed?}  (request_id at the top level, like errors;
 *        `replayed` only on POST). In EVERY *.json: `normal.response.body.meta.request_id` -> top-level
 *        `request_id`, drop `meta`; `replay.response` likewise (results.json). README section 1 example too.
 *  D2  README.md 2절 5번 and 3절 table                 `idempotency_key_reused` -> `idempotency_key_reuse`.
 *  D3  capabilities.json error: code `unauthorized` -> `unauthenticated`, target/next_action kept. context.json
 *        error `project_not_found` -> `not_found`; versions.json error `version_not_found` -> `not_found`
 *        (also the README 3절 table cells for capability·context·versions). capabilities.json `auth`: `any`
 *        stays, and its `error` example (401) is removed (capabilities is open; no credential is needed).
 *  D5  claims.json normal status 201 -> 200 (POST P/claims is 200, `run_id` + `lease` + `replayed`);
 *        results.json normal status 201 -> 200 and its replay status 200; wait.json error `not_lease_holder`
 *        -> `conflict` (details kept); claims.json error `lease_held` -> `conflict` (retryable false,
 *        next_action stays `retry_after_lease` only if the implementation keeps details.retry_after_ms);
 *        complete.json / cancel.json error `run_terminal` stays for cancel/interrupt (PR14) and becomes
 *        `conflict` for complete (PR13). Request bodies: README 2절 2번 text "format_version in bodies" ->
 *        PR13 routes reject unknown fields, so remove `format_version` from the PR13 request examples
 *        (claims, results, wait, complete, runs, uploads, uploads-complete) and from README 1절's example;
 *        PR14 routes (this PR) accept an optional `"format_version": "1.0"`, any other value is 400.
 *  D6  uploads-put.json: path `PUT /api/v1/uploads/{upload_id}` (+auth upload_token) ->
 *        `PUT /api/v1/projects/{project_id}/uploads/{blob_id}` with the agent/owner credential; uploads.json
 *        response `upload.put_url` -> the PR13 reserve answer (blob_id, state, deduplicated); README 2절 8번 text
 *        and 3절 table row for uploads.
 *  D9  handoffs.json normal.response: 201 {parent_run_id,new_run_id,...} -> 200 {run_id, status:"queued",
 *        lease:{released:true, fence}, pending_input_count, target_mode, target_actor_id}; request body
 *        {target_mode, target_actor_id, reason, include_pending_inputs} stays; the error example stays.
 *  (D4, D7, D8, D10, D11, D12 need no document edit besides what the tests already follow: D7 questions.json
 *   types are the core's `single` ... and `comment` maps to the core `other`; D8 round-seal.json request gains
 *   `manifest_blob_id` + `versions` beside expected_round_rev/snapshot_scope; D10 stage-1-api.md 6절 row
 *   "답·의견 제출" says E cannot submit; D11 interrupt.json normal.response gains nothing; D12 none.)
 */
export const DOCUMENT_FIXES_FOR_IMPLEMENTER = "see the comment above";

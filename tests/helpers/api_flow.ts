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
  // SEL-93 U3a: assumptions / decisions / reflections (POST writes, GET reads)
  "GET /api/v1/projects/{id}/assumptions",
  "POST /api/v1/projects/{id}/assumptions",
  "GET /api/v1/projects/{id}/decisions",
  "POST /api/v1/projects/{id}/decisions",
  "GET /api/v1/projects/{id}/reflections",
  "POST /api/v1/projects/{id}/reflections",
  // SEL-113 REF1a: reference material from earlier projects
  "GET /api/v1/projects/{id}/references",
  "POST /api/v1/projects/{id}/references",
  "GET /api/v1/projects/{id}/references/{ref}",
  "POST /api/v1/projects/{id}/references/{ref}/refresh",
  "POST /api/v1/projects/{id}/references/{ref}/detach",
  "GET /api/v1/projects/{id}/context",
  "GET /api/v1/projects/{id}/files/{b}/content",
  "GET /api/v1/projects/{id}/objects/{o}/versions/{v}",
  "GET /api/v1/projects/{id}/operations/{op}",
  "GET /api/v1/projects/{id}/requests/{key}",
  "GET /api/v1/projects/{id}/runs/{r}/inputs",
  // SEL-82 U1b: the workspace read model joins the contract (OpenAPI path + capabilities route + route table)
  "GET /api/v1/projects/{id}/workspace",
  "POST /api/v1/projects/{id}/claims",
  "POST /api/v1/projects/{id}/policies/opencode-go/revisions",
  "POST /api/v1/projects/{id}/questions",
  "POST /api/v1/projects/{id}/questions/{q}/defer",
  "POST /api/v1/projects/{id}/questions/{q}/merge",
  "POST /api/v1/projects/{id}/questions/{q}/revisions",
  "POST /api/v1/projects/{id}/questions/{q}/withdraw",
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
  // SEL-90 U2a: question comments (annotation context stays 501 until U4a)
  "POST /api/v1/projects/{id}/threads",
  "POST /api/v1/projects/{id}/threads/{t}/messages",
  "POST /api/v1/projects/{id}/uploads",
  "POST /api/v1/projects/{id}/uploads/{b}/complete",
  "PUT /api/v1/projects/{id}/uploads/{b}",
].sort();

/** Routes the closed 2단계 list does NOT have and capabilities must say are unsupported (no fake success). */
export const EXPECTED_UNSUPPORTED: readonly string[] = [
  "POST /api/v1/projects/{id}/exports",
  "POST /api/v1/projects/{id}/threads/{t}/resolutions",
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
 * STATUS OF THE DOCUMENT FIXES D1~D12 (leader decision: the merged PR13 routes and the merged core are the
 * reference; where docs/plan/fixtures/api-v1 or its README disagree, the DOCUMENTS are edited, the tests are
 * not changed to follow them). Re-stated after the first review (r1) of SEL-47:
 *
 *  DONE (nothing of the old wording is left in the fixtures):
 *    D1  success envelope {format_version, request_id, data, replayed?} (no `meta`)
 *    D2  `idempotency_key_reuse` (not `idempotency_key_reused`)
 *    D3  `unauthenticated` / `not_found` instead of `unauthorized` / `project_not_found` / `version_not_found`
 *    D5  status codes (claims 200, results 200) and `conflict` instead of `lease_held` / `not_lease_holder`
 *    D9  handoffs.json answers 200 with the run put back to `queued` (the same run, no child run)
 *
 *  NOT DONE — the request bodies, error details and next_action values in the fixtures still differ from what the
 *  routes accept and return. tests/test_api_fixture_contract.test.ts sends every fixture request to the real
 *  ApiApp and lists, case by case, what is still different (its failing cases ARE the remaining list). Known
 *  groups: D5 request bodies (`lease_ttl_ms`, `question_ids`, `base_control_rev`, `result_version_ids` ... are
 *  unknown fields), D6 uploads (`filename`/`size_bytes`, `sha256:` prefix, `hash_mismatch`, `not_ready`),
 *  D7 questions types/importance (`single_choice`, `medium`), D8 round-seal.json lacks `manifest_blob_id` and
 *  `versions`, and the next_action/details of the claims, complete, wait, context, versions and uploads errors.
 *
 *  D4, D10, D11, D12 need no fixture edit; D10 (an agent cannot submit answers) still has to be written into
 *  stage-1-api.md section 6 (the row "답·의견 제출").
 *
 * Kept as a constant so a test can import the pointer; it holds no data.
 */
export const DOCUMENT_FIXES_FOR_IMPLEMENTER = "see tests/test_api_fixture_contract.test.ts: its failing cases are the fixtures still to fix";

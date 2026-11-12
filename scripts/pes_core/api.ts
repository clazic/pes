// HTTP/JSON API v1 (stage 2 PR13 + PR14).
//
// ApiApp is a framework-free request handler: a closed route table, one
// response envelope, and the CommandService for every business write. There
// is no table CRUD, no arbitrary SQL route, and no business write in this
// file; reads are short read transactions or the helpers of commands/api_reads.ts.
//
// Order of checks on a project route: route and method (404/405) -> credential
// (401) -> request budget (429) -> project (404) -> kind of actor and scope
// (403) -> Idempotency-Key and body (400/413) -> state (409). Credentials are
// resolved on every request; long-poll sleeps happen after the read
// transaction has ended, so a held response never keeps a transaction open.

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname } from "node:path";

import { AGENT_SCOPE_NAMES, read_credential_actor, resolve_actor, verify_agent_token, type ResolvedActor } from "./actors.ts";
import { register_project } from "./bootstrap.ts";
import type { Clock } from "./clock.ts";
import { COMMANDS, CommandService, type CommandOutcome, type MutationContext } from "./commands.ts";
import {
  approval_row,
  assumption_rows,
  changes_page,
  decision_rows,
  db_meta,
  edition_id_by_no,
  edition_no_of,
  input_visible,
  inputs_page,
  latest_approval_id,
  lease_info,
  current_place,
  max_event_seq,
  operation_receipt,
  owner_user_id,
  pending_input_count,
  question_state,
  receipt_of_request,
  reflection_round,
  reflection_round_ids,
  replacing_decision_id,
  round_id_by_number,
  request_receipt,
  run_info,
  snapshot_through_seq,
  stage_view,
  submission_received_at,
  type ReceiptRow,
} from "./commands/api_reads.ts";
import { HANDOFF_APPS } from "./commands/handoff_import.ts";
import { read_tx } from "./commands/read_tx.ts";
import { GO_MODEL_PREFIX, GO_PROVIDER, require_internal_ai_for_go_run } from "./commands/shared.ts";
import { submit_results } from "./content.ts";
import type { Db } from "./db.ts";
import { needs_document_sandbox } from "./document_sandbox.ts";
import { ApiError } from "./errors.ts";
import { approve_stage, reopen_stage, seal_round, start_round } from "./editions.ts";
import { complete_upload, get_blob, is_safe_media_type, reserve_upload, store_blob } from "./files.ts";
import { new_id as default_new_id } from "./ids.ts";
import {
  check_go_allowed,
  current_policy,
  DbPolicyChecker,
  set_policy,
  type PolicySnapshot,
} from "./policy.ts";
import { build_prompt, blob_ai_denied, question_statuses, type PromptTarget, type RedactLiterals } from "./prompt_reads.ts";
import { publish_set, revise_question, submit_answers } from "./questions.ts";
import {
  cancel as run_cancel,
  claim as run_claim,
  complete as run_complete,
  create_run,
  handoff as run_handoff,
  heartbeat as run_heartbeat,
  interrupt as run_interrupt,
  record_receipt as run_record_receipt,
  release as run_release,
  wait as run_wait,
} from "./runs.ts";
import {
  Budgets,
  WINDOW_MS,
  budgets_for,
  ERROR_CODES,
  ERROR_STATUS,
  Fail,
  NEXT_ACTION,
  fail_from,
  make_cursor,
  message_for,
  read_cursor,
  retryable_for,
} from "./api_support.ts";

export interface ApiRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | Uint8Array | null;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  json: unknown;
  bytes: Uint8Array | null;
  /**
   * Internal: true only when this request's credential (agent token or local
   * session) passed verification. The bridge passes it to serve.py beside the
   * response (never as a header); serve.py uses it to move the credential out
   * of the server-wide unverified bucket. Pre-auth refusals (404 route, 405,
   * 401, malformed input before the credential check) leave it false; a 429
   * from the per-credential budget comes after the check, so it is true.
   */
  credential_verified?: boolean;
}

export interface ApiAppOptions {
  db: Db;
  clock: Clock;
  objects_dir: string;
  local_session_secret: string;
  sleep?: (ms: number) => Promise<void>;
  new_id?: () => string;
}

interface RouteRequest {
  method: string;
  path: string;
  params: string[];
  query: URLSearchParams;
  headers: Record<string, string>;
  body: string | Uint8Array | null;
  request_id: string;
  key: string | null;
}

interface HandlerResult {
  status: number;
  data?: unknown;
  replayed?: boolean;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
}

interface ProjectRow {
  id: string;
  slug: string;
  topic: string;
  owner_user_id: string;
  control_rev: bigint;
  status: string;
  active_edition_id: string | null;
  current_policy_id: string | null;
}

interface AuthInfo {
  actor_id: string;
  kind: string;
  session: boolean;
  scopes: string[] | null;
  token_id: string | null;
}

interface Credential {
  session: boolean;
  actor_id: string | null;
  kind: string | null;
  scopes: string[] | null;
  token_id: string | null;
}

interface EditionRow {
  id: string;
  edition_no: bigint;
  status: string;
  current_stage_id: string | null;
}

interface StageRow {
  id: string;
  key: string;
  ordinal: bigint;
  status: string;
  rev: bigint;
  stale_since_event_seq: bigint | null;
}

interface ManifestRow {
  object_id: string;
  kind: string;
  version_id: string;
  version_no: bigint;
}

interface LeaseRow {
  lease_id: string;
  run_id: string;
  fence: bigint;
  expires_at: bigint;
}

/**
 * Who may call a route (after the credential is valid):
 *   any        owner session, or a token with `scope`
 *   agent      a token only (a session is 403 forbidden)
 *   human      the owner session only; a token is 403 human_required
 *   owner      the owner session only; a token is 403 owner_required
 *   session    the owner session only; a token is 403 forbidden
 */
type Who = "any" | "agent" | "human" | "owner" | "session";
type Bucket = "general" | "control";

/** Why an operation refuses a caller; null = it does not. One rule for the real check (#bind) and the screen's `enabled` (#action_refusal). */
type Denial =
  | { by: "session_is_not_agent" }
  | { by: "human_required" | "owner_required" | "session_only" }
  | { by: "scope"; scope: string };

/** The permission rule of an operation (who may call it): pure, no database, no side effect. */
function permission_denial(op: { who: Who; scope?: string }, caller: { session: boolean; scopes: readonly string[] | null }): Denial | null {
  if (caller.session) return op.who === "agent" ? { by: "session_is_not_agent" } : null;
  if (op.who === "human") return { by: "human_required" };
  if (op.who === "owner") return { by: "owner_required" };
  if (op.who === "session") return { by: "session_only" };
  if (op.scope !== undefined && !(caller.scopes ?? []).includes(op.scope)) return { by: "scope", scope: op.scope };
  return null;
}

interface Op {
  who: Who;
  scope?: string;
  bucket?: Bucket;
  /** an internal_ai caller is stopped while Go is OFF */
  go?: boolean;
  act(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult>;
}

interface RouteSpec {
  method: string;
  path: string;
  operation: string;
  /** "global": no project, owner session only. "open": no credential. "unsupported": 501 after auth. */
  kind: "open" | "global" | "project" | "unsupported";
  op?: Op;
}

/** A JSON column (checked json_valid by the schema); a damaged value reads as null. */
function parse_json_or_null(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

const FORMAT_VERSION = "1.0";
/** SEL-102: a stored type outside the short safe list (see document_sandbox.ts — the same judgement as serve.ts static answers) is sent with this sandbox. */
const FILE_DOCUMENT_CSP = "sandbox allow-scripts allow-popups allow-modals allow-downloads";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_WAIT_MS = 25_000;
const MIN_POLL_INTERVAL_MS = 1000;
const AGENT_REQUESTS_PER_MINUTE = 60;
const AGENT_CONTROL_REQUESTS_PER_MINUTE = 120;
const OWNER_REQUESTS_PER_MINUTE = 600;
const LIST_MAX_ITEMS = 100;
/** Work-space read: only the newest this many dispatches and runs are sent (SEL-87); older ones are left out. */
const WORKSPACE_LIST_MAX = 50;
/** A request refused for its own malformed input was not served: it does not use up the budget. */
const REFUNDED_CODES: readonly string[] = ["invalid_payload", "validation_failed", "payload_too_large", "cursor_invalid"];
const MAX_RESULTS_PER_BATCH = 20;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SCOPES = AGENT_SCOPE_NAMES;
const QUESTION_TYPES = ["single", "multi", "text", "textarea", "number", "scale", "file"];
const QUESTION_PURPOSES = ["stage_start", "review", "resume"];
/** SEL-118: the form a human_to_agent question lives in (its own, so the human's "main" form never carries a question for an AI). */
const ASK_AI_FORM_KEY = "ask_ai";
/** SEL-118: limits of one prompt build (the body limit is 256 KiB anyway). */
const PROMPT_MAX_CHARS = 20_000;
const PROMPT_MAX_DRAFTS = 20;
const QUESTION_FIELDS = [
  "text",
  "type",
  "required",
  "allow_comment_as_answer",
  "default_value",
  "options",
  "show_if",
  "help",
  "importance",
];
/** The operations the workspace read model reports as actions (names are the route table's operation names). */
const ACTION_OPERATIONS: readonly string[] = [
  "submissions.create",
  "questions.create",
  "questions.revise",
  "questions.withdraw",
  "questions.defer",
  "questions.merge",
  "threads.create",
  "threads.messages.create",
  "rounds.create",
  "rounds.seal",
  "stages.approve",
  "stages.reopen",
  "runs.create",
  "uploads.create",
  "policies.opencode_go.revise",
];
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

/** HTTP status first returned for a receipt's action (for GET requests/{key}). */
const CREATED_ACTIONS = new Set([
  "project.created",
  "project.registered",
  "run.created",
  "question.set_published",
  "question.revised",
  "question.retracted",
  "question.deferred",
  "question.merged",
  "question.commented",
  "answer.submitted",
  "round.started",
  "policy.changed",
  "assumption.proposed",
  "assumption.assessed",
  "decision.proposed",
  "decision.adopted",
  "decision.superseded",
  "decision.revoked",
  "reflection.created",
]);
const ACCEPTED_ACTIONS = new Set(["run.interrupted", "run.cancelled"]);

const COMMAND_OF_ACTION: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [name, definition] of COMMANDS) {
    if (!map.has(definition.action)) map.set(definition.action, name);
  }
  return map;
})();

function invalid(target: string | null, details?: Record<string, unknown>): never {
  throw new Fail("invalid_payload", { target, details: details ?? null });
}

function invalid_field(field: string): never {
  return invalid(`$.body.${field}`);
}

function validation(target: string, details?: Record<string, unknown>): never {
  throw new Fail("validation_failed", { target, details: details ?? null });
}

/** Constant-time comparison; a length difference is an immediate rejection. */
function secret_matches(presented: string | undefined, expected: string): boolean {
  if (typeof presented !== "string") return false;
  const left = createHash("sha256").update(presented, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return left.equals(right) && presented.length === expected.length;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function lower_headers(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value === "string") out[name.toLowerCase()] = value;
  }
  return out;
}

function json_safe(value: unknown): unknown {
  const text = JSON.stringify(value, (_key, entry) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  );
  return text === undefined ? null : JSON.parse(text);
}

/**
 * Reject a body key outside `allowed`. Every route also takes an optional
 * "format_version": "1.0" (any other value is a 400 on $.body.format_version).
 */
function reject_unknown(body: Record<string, unknown>, allowed: readonly string[]): void {
  const known = new Set(allowed);
  for (const key of Object.keys(body)) {
    if (key === "format_version") {
      if (body[key] !== FORMAT_VERSION) invalid("$.body.format_version");
      continue;
    }
    if (!known.has(key)) invalid_field(key);
  }
}

function require_text(body: Record<string, unknown>, field: string, base = "$.body"): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0 || !value.isWellFormed()) {
    invalid(`${base}.${field}`);
  }
  return value;
}

function optional_text(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()) {
    invalid_field(field);
  }
  return value;
}

function parse_decimal(value: unknown, target: string): string {
  if (typeof value !== "string" || !DECIMAL.test(value)) invalid(target);
  return value;
}

function optional_decimal(body: Record<string, unknown>, field: string): string | undefined {
  if (!Object.hasOwn(body, field) || body[field] === undefined) return undefined;
  return parse_decimal(body[field], `$.body.${field}`);
}

function parse_fence(value: unknown): number {
  const text = parse_decimal(value, "$.body.fence");
  const fence = Number(text);
  if (!Number.isSafeInteger(fence) || fence < 1) invalid("$.body.fence");
  return fence;
}

function require_mode(body: Record<string, unknown>, field = "mode"): "A" | "B" {
  const value = body[field];
  if (value !== "A" && value !== "B") invalid_field(field);
  return value;
}

function decimal_text(value: unknown): string | null {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && DECIMAL.test(value)) return value;
  return null;
}

function result_record(result: unknown): Record<string, unknown> {
  return is_record(result) ? result : {};
}

/** Give a core refusal the JSON path of the field at fault. */
function targeted(error: unknown, targets: Record<string, string>, next?: Record<string, string>): Fail {
  const failure = fail_from(error);
  const target = targets[failure.code];
  if (target === undefined && next?.[failure.code] === undefined) return failure;
  return new Fail(failure.code, {
    target: target ?? failure.target,
    details: failure.details,
    next_action: next?.[failure.code] ?? failure.next_action ?? undefined,
    headers: failure.headers,
  });
}

/** Check one question object (a full one for publish, a partial one for revise). */
function check_question(value: unknown, partial: boolean): Record<string, unknown> {
  const base = "$.body.question";
  if (!is_record(value)) invalid(base);
  for (const key of Object.keys(value)) {
    if (!QUESTION_FIELDS.includes(key)) validation(`${base}.${key}`, { reason: "unknown_field" });
  }
  if (partial && Object.keys(value).length === 0) validation(base, { reason: "empty" });
  if (!partial || "text" in value) {
    const text = value.text;
    if (typeof text !== "string" || text.trim().length === 0 || !text.isWellFormed()) {
      validation(`${base}.text`, { reason: "required_text" });
    }
  }
  if (!partial || "type" in value) {
    if (typeof value.type !== "string" || !QUESTION_TYPES.includes(value.type)) {
      validation(`${base}.type`, { reason: "unknown_type" });
    }
  }
  if ("importance" in value && !["high", "normal", "low"].includes(String(value.importance))) {
    validation(`${base}.importance`, { reason: "unknown_importance" });
  }
  for (const flag of ["required", "allow_comment_as_answer"]) {
    if (flag in value && typeof value[flag] !== "boolean") {
      validation(`${base}.${flag}`, { reason: "boolean_required" });
    }
  }
  if ("help" in value && value.help !== null && typeof value.help !== "string") {
    validation(`${base}.help`, { reason: "text_required" });
  }
  if ("options" in value && value.options !== null) {
    const options = value.options;
    if (!Array.isArray(options)) validation(`${base}.options`, { reason: "array_required" });
    const seen = new Set<string>();
    (options as unknown[]).forEach((option, i) => {
      const at = `${base}.options[${i}]`;
      if (!is_record(option)) validation(at, { reason: "object_required" });
      for (const key of Object.keys(option)) {
        if (!["value", "label", "recommended"].includes(key)) {
          validation(`${at}.${key}`, { reason: "unknown_field" });
        }
      }
      const v = option.value;
      if (typeof v !== "string" || v.length === 0 || !v.isWellFormed()) {
        validation(`${at}.value`, { reason: "required_text" });
      }
      if (typeof option.label !== "string" || !option.label.isWellFormed()) {
        validation(`${at}.label`, { reason: "text_required" });
      }
      if (option.recommended !== undefined && typeof option.recommended !== "boolean") {
        validation(`${at}.recommended`, { reason: "boolean_required" });
      }
      if (seen.has(v as string)) validation(`${at}.value`, { reason: "duplicate_value", value: v });
      seen.add(v as string);
    });
  }
  return value;
}

export class ApiApp {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #objects_dir: string;
  readonly #secret: string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #new_id: () => string;
  readonly #service: CommandService;
  readonly #budgets: Budgets;
  readonly #table: RouteSpec[];
  readonly #patterns: RegExp[];

  constructor(options: ApiAppOptions) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("ApiApp options are required");
    }
    if (typeof options.local_session_secret !== "string" || options.local_session_secret.length === 0) {
      throw new TypeError("local_session_secret must be a non-empty string");
    }
    if (typeof options.objects_dir !== "string" || options.objects_dir.length === 0) {
      throw new TypeError("objects_dir must be a non-empty string");
    }
    this.#db = options.db;
    this.#budgets = budgets_for(options.db);
    this.#clock = options.clock;
    this.#objects_dir = options.objects_dir;
    this.#secret = options.local_session_secret;
    this.#sleep =
      options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.#new_id = options.new_id ?? default_new_id;
    this.#service = new CommandService(this.#db, {
      clock: this.#clock,
      policy: new DbPolicyChecker(),
      objects_dir: this.#objects_dir,
      new_id: this.#new_id,
    });
    this.#table = this.#build_table();
    this.#patterns = this.#table.map(
      (spec) =>
        new RegExp(
          `^${spec.path
            .split("/")
            .map((part) => (part.startsWith("{") ? "([^/]+)" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
            .join("/")}$`,
        ),
    );
  }

  /** The closed route table: every route the server answers, and nothing else. */
  #build_table(): RouteSpec[] {
    const P = "/api/v1/projects/{id}";
    const route = (method: string, path: string, operation: string, op: Op): RouteSpec => ({
      method,
      path,
      operation,
      kind: "project",
      op,
    });
    const unsupported = (method: string, path: string, operation: string): RouteSpec => ({
      method,
      path,
      operation,
      kind: "unsupported",
    });
    return [
      { method: "GET", path: "/api/v1/capabilities", operation: "capabilities.get", kind: "open" },
      { method: "POST", path: "/api/v1/projects", operation: "projects.create", kind: "global" },
      {
        method: "POST",
        path: "/api/v1/project-registrations",
        operation: "project_registrations.create",
        kind: "global",
      },
      route("GET", `${P}/context`, "context.get", {
        who: "any", scope: "context:read", go: true,
        act: async (_r, project) => this.#context(project),
      }),
      route("GET", `${P}/objects/{o}/versions/{v}`, "object.version.get", {
        who: "any", scope: "context:read", go: true,
        act: async (r, project, auth) => this.#version_read(r, project, auth),
      }),
      route("GET", `${P}/changes`, "changes.list", {
        who: "any", scope: "context:read", go: true,
        act: async (r, project, auth) => this.#changes(r, project, auth),
      }),
      route("GET", `${P}/workspace`, "workspace.get", {
        who: "any", scope: "context:read", go: true,
        act: async (_r, project, auth) => this.#workspace(project, auth),
      }),
      route("POST", `${P}/runs`, "runs.create", {
        who: "session",
        act: async (r, project, auth) => this.#runs_create(r, project, auth),
      }),
      route("POST", `${P}/claims`, "runs.claim", {
        who: "any", scope: "run:claim",
        act: async (r, project, auth) => this.#claims(r, project, auth),
      }),
      route("POST", `${P}/runs/{r}/wait`, "runs.wait", {
        who: "any", scope: "run:submit",
        act: async (r, project, auth) => this.#wait(r, project, auth),
      }),
      route("POST", `${P}/runs/{r}/results`, "results.submit", {
        who: "agent", scope: "run:submit",
        act: async (r, project, auth) => this.#results(r, project, auth),
      }),
      route("POST", `${P}/runs/{r}/complete`, "runs.complete", {
        who: "any", scope: "run:submit",
        act: async (r, project, auth) => this.#complete(r, project, auth),
      }),
      route("POST", `${P}/runs/{r}/heartbeat`, "runs.heartbeat", {
        who: "agent", scope: "run:submit", bucket: "control",
        act: async (r, project, auth) => this.#heartbeat(r, project, auth),
      }),
      route("POST", `${P}/runs/{r}/release`, "runs.release", {
        who: "agent", scope: "run:submit",
        act: async (r, project, auth) => this.#release(r, project, auth),
      }),
      route("POST", `${P}/runs/{r}/handoffs`, "runs.handoff", {
        who: "any", scope: "run:submit",
        act: async (r, project, auth) => this.#handoffs(r, project, auth),
      }),
      route("POST", `${P}/runs/{r}/interrupt`, "runs.interrupt", {
        who: "any", scope: "run:submit", bucket: "control",
        act: async (r, project, auth) => this.#interrupt(r, project, auth),
      }),
      route("POST", `${P}/runs/{r}/cancel`, "runs.cancel", {
        who: "any", scope: "run:submit", bucket: "control",
        act: async (r, project, auth) => this.#cancel(r, project, auth),
      }),
      route("GET", `${P}/runs/{r}/inputs`, "runs.inputs", {
        who: "agent", scope: "context:read", go: true,
        act: async (r, project, auth) => this.#inputs(r, project, auth),
      }),
      route("POST", `${P}/runs/{r}/input-receipts`, "runs.input_receipts", {
        who: "agent", scope: "run:submit",
        act: async (r, project, auth) => this.#input_receipts(r, project, auth),
      }),
      route("GET", `${P}/operations/{op}`, "operations.get", {
        who: "any", bucket: "control",
        act: async (r, project, auth) => this.#operation_get(r, project, auth),
      }),
      route("GET", `${P}/requests/{key}`, "requests.get", {
        who: "any", bucket: "control",
        act: async (r, project, auth) => this.#request_get(r, project, auth),
      }),
      route("POST", `${P}/questions`, "questions.create", {
        who: "any", scope: "run:submit",
        act: async (r, project, auth) => this.#question_publish(r, project, auth),
      }),
      route("POST", `${P}/questions/{q}/revisions`, "questions.revise", {
        who: "any", scope: "run:submit",
        act: async (r, project, auth) => this.#question_revise(r, project, auth),
      }),
      route("POST", `${P}/questions/{q}/withdraw`, "questions.withdraw", {
        who: "any", scope: "run:submit",
        act: async (r, project, auth) => this.#question_state(r, project, auth, "withdraw"),
      }),
      route("POST", `${P}/questions/{q}/defer`, "questions.defer", {
        who: "any", scope: "run:submit",
        act: async (r, project, auth) => this.#question_state(r, project, auth, "defer"),
      }),
      route("POST", `${P}/questions/{q}/merge`, "questions.merge", {
        who: "any", scope: "run:submit",
        act: async (r, project, auth) => this.#question_state(r, project, auth, "merge"),
      }),
      // SEL-118 U5a: the prompt a human copies (a read — POST only because an unsubmitted draft exists in the client alone)
      // and the state of the human -> AI questions. Neither writes; A starts "ask the AI" with the runs + claims above.
      route("POST", `${P}/prompt-builds`, "prompts.build", {
        who: "any", scope: "context:read", go: true,
        act: async (r, project) => this.#prompt_build(r, project),
      }),
      route("GET", `${P}/question-statuses`, "question_statuses.list", {
        who: "any", scope: "context:read", go: true,
        act: async (r, project) => this.#question_statuses(r, project),
      }),
      route("POST", `${P}/threads`, "threads.create", {
        who: "any", scope: "run:submit",
        act: async (r, project, auth) => this.#thread_create(r, project, auth),
      }),
      route("POST", `${P}/threads/{t}/messages`, "threads.messages.create", {
        who: "any", scope: "run:submit",
        act: async (r, project, auth) => this.#thread_message(r, project, auth),
      }),
      route("POST", `${P}/submissions`, "submissions.create", {
        who: "human",
        act: async (r, project, auth) => this.#submissions(r, project, auth),
      }),
      // SEL-93 U3a: assumptions / decisions / reflections. A token may only propose or write a reflection; judging,
      // adopting, superseding and revoking are the owner session's (403 human_required for a token).
      route("POST", `${P}/assumptions`, "assumptions.create", {
        who: "any", scope: "run:submit",
        act: async (r, project, auth) => this.#assumption_write(r, project, auth),
      }),
      route("GET", `${P}/assumptions`, "assumptions.list", {
        who: "any", scope: "context:read", go: true,
        act: async (r, project) => this.#assumptions_read(r, project),
      }),
      route("POST", `${P}/decisions`, "decisions.create", {
        who: "any", scope: "run:submit",
        act: async (r, project, auth) => this.#decision_write(r, project, auth),
      }),
      route("GET", `${P}/decisions`, "decisions.list", {
        who: "any", scope: "context:read", go: true,
        act: async (r, project) => this.#decisions_read(r, project),
      }),
      route("POST", `${P}/reflections`, "reflections.create", {
        who: "any", scope: "run:submit",
        act: async (r, project, auth) => this.#reflection_write(r, project, auth),
      }),
      route("GET", `${P}/reflections`, "reflections.list", {
        who: "any", scope: "context:read", go: true,
        act: async (r, project) => this.#reflections_read(r, project),
      }),
      route("POST", `${P}/stages/{s}/rounds`, "rounds.create", {
        who: "any", scope: "run:submit",
        act: async (r, project, auth) => this.#round_start(r, project, auth),
      }),
      route("POST", `${P}/rounds/{rd}/seal`, "rounds.seal", {
        who: "any", scope: "run:submit",
        act: async (r, project, auth) => this.#round_seal(r, project, auth),
      }),
      route("POST", `${P}/stages/{s}/approve`, "stages.approve", {
        who: "human",
        act: async (r, project, auth) => this.#stage_approve(r, project, auth),
      }),
      route("POST", `${P}/stages/{s}/reopen`, "stages.reopen", {
        who: "human",
        act: async (r, project, auth) => this.#stage_reopen(r, project, auth),
      }),
      route("POST", `${P}/policies/opencode-go/revisions`, "policies.opencode_go.revise", {
        who: "owner",
        act: async (r, project, auth) => this.#policy_revise(r, project, auth),
      }),
      route("POST", `${P}/uploads`, "uploads.create", {
        who: "any", scope: "file:write",
        act: async (r, project, auth) => this.#uploads_reserve(r, project, auth),
      }),
      route("PUT", `${P}/uploads/{b}`, "uploads.put", {
        who: "any", scope: "file:write",
        act: async (r, project) => this.#upload_put(r, project),
      }),
      route("POST", `${P}/uploads/{b}/complete`, "uploads.complete", {
        who: "any", scope: "file:write",
        act: async (r, project, auth) => this.#upload_complete(r, project, auth),
      }),
      route("GET", `${P}/files/{b}/content`, "files.content", {
        who: "any", scope: "file:read", go: true,
        act: async (r, project, auth) => this.#file_read(r, project, auth),
      }),
      unsupported("POST", `${P}/exports`, "exports.create"),
      unsupported("POST", `${P}/threads/{t}/resolutions`, "threads.resolutions.create"),
      unsupported("POST", `${P}/editions`, "editions.create"),
      unsupported("POST", `${P}/agent-tokens`, "agent_tokens.create"),
      unsupported("POST", `${P}/followups/{f}/apply`, "followups.apply"),
      unsupported("DELETE", P, "projects.delete"),
    ];
  }

  async handle(request: ApiRequest): Promise<ApiResponse> {
    const headers = lower_headers(request.headers);
    const supplied = headers["x-request-id"];
    const request_id =
      typeof supplied === "string" && supplied.length > 0 ? supplied : this.#new_id();
    const seen = { verified: false };
    try {
      const [path, ...rest] = request.path.split("?");
      const method = request.method.toUpperCase();
      const matched: Array<{ spec: RouteSpec; params: string[] }> = [];
      for (const [i, pattern] of this.#patterns.entries()) {
        const m = (path ?? "").match(pattern);
        if (m !== null) matched.push({ spec: this.#table[i]!, params: m.slice(1) });
      }
      if (matched.length === 0) throw new Fail("not_found");
      const hit = matched.find((entry) => entry.spec.method === method);
      if (hit === undefined) {
        const allow = [...new Set(matched.map((entry) => entry.spec.method))].join(", ");
        throw new Fail("method_not_allowed", { headers: { allow } });
      }
      const key_header = headers["idempotency-key"];
      const route_request: RouteRequest = {
        method,
        path: path ?? "",
        params: hit.params,
        query: new URLSearchParams(rest.join("?")),
        headers,
        body: request.body,
        request_id,
        key: typeof key_header === "string" && key_header.length > 0 ? key_header : null,
      };
      const result = await this.#dispatch(hit.spec, route_request, seen);
      return { ...this.#success(request_id, result), credential_verified: seen.verified };
    } catch (error) {
      return { ...this.#error(error, request_id), credential_verified: seen.verified };
    }
  }

  async #dispatch(spec: RouteSpec, request: RouteRequest, seen: { verified: boolean }): Promise<HandlerResult> {
    if (spec.kind === "open") return this.#capabilities();
    if (spec.kind === "global") {
      this.#require_session(request);
      seen.verified = true;
      return spec.operation === "projects.create"
        ? this.#create_project(request)
        : this.#register(request);
    }
    const project_id = request.params[0] as string;
    const op: Op =
      spec.kind === "unsupported"
        ? { who: "any", act: async () => { throw new Fail("not_supported"); } }
        : (spec.op as Op);
    const credential = this.#credential(request, project_id);
    seen.verified = true;
    const refund = this.#spend(credential, op.bucket ?? "general");
    try {
      const project = this.#project(project_id);
      const auth = this.#bind(project, credential, op);
      if (op.go === true && auth.kind === "internal_ai") this.#require_go(project.id);
      return await op.act(request, project, auth);
    } catch (error) {
      // A request refused for its own malformed input was not served: it does not use up the budget.
      if (error instanceof Fail && REFUNDED_CODES.includes(error.code)) {
        refund();
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // response envelopes

  #success(request_id: string, result: HandlerResult): ApiResponse {
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-request-id": request_id,
      ...(result.headers ?? {}),
    };
    if (result.bytes !== undefined) {
      return { status: result.status, headers, json: null, bytes: result.bytes };
    }
    const body: Record<string, unknown> = {
      format_version: FORMAT_VERSION,
      request_id,
      data: result.data ?? null,
    };
    if (result.replayed !== undefined) body.replayed = result.replayed;
    return { status: result.status, headers, json: json_safe(body), bytes: null };
  }

  #error(error: unknown, request_id: string): ApiResponse {
    const failure = fail_from(error);
    const status = ERROR_STATUS[failure.code] ?? 500;
    const body = {
      format_version: FORMAT_VERSION,
      error: {
        code: failure.code,
        message: message_for(failure.code, failure.target),
        retryable: retryable_for(failure.code),
        target: failure.target,
        details: failure.details,
        next_action: failure.next_action ?? NEXT_ACTION[failure.code] ?? "retry_later",
      },
      request_id,
    };
    return {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
        "x-request-id": request_id,
        ...failure.headers,
      },
      json: json_safe(body),
      bytes: null,
    };
  }

  // -------------------------------------------------------------------------
  // request helpers

  #now(): number {
    const value = this.#clock.now_ms();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("the clock must return a non-negative safe integer");
    }
    return value;
  }

  #require_key(request: RouteRequest): string {
    const key = request.key;
    if (key === null || key.length === 0 || !key.isWellFormed()) {
      invalid("$.headers.idempotency-key");
    }
    return key;
  }

  #json_body(request: RouteRequest): Record<string, unknown> {
    const body = request.body;
    if (body === null) invalid(null);
    const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    if (bytes.byteLength > MAX_BODY_BYTES) {
      throw new Fail("payload_too_large", { details: { max_bytes: MAX_BODY_BYTES } });
    }
    if (bytes.byteLength === 0) invalid(null);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return invalid(null);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return invalid(null);
    }
    if (!is_record(parsed)) invalid(null);
    return parsed;
  }

  #raw_bytes(request: RouteRequest): Uint8Array {
    const body = request.body;
    if (body === null) invalid(null);
    if (typeof body === "string") return Buffer.from(body, "utf8");
    if (body instanceof Uint8Array) return body;
    return invalid(null);
  }

  #project(project_id: string): ProjectRow {
    const project = this.#db.get<ProjectRow>(
      `SELECT id, slug, topic, owner_user_id, control_rev, status,
              active_edition_id, current_policy_id
         FROM projects WHERE id = ?`,
      project_id,
    );
    if (project === undefined) throw new Fail("not_found");
    return project;
  }

  #owner_actor(project_id: string): string {
    const row = this.#db.get<{ actor_id: string }>(
      `SELECT a.id AS actor_id
         FROM actors a
         JOIN project_members m ON m.user_id = a.user_id
         JOIN users u ON u.id = a.user_id
        WHERE m.project_id = ? AND m.role = 'owner' AND a.kind = 'human'
          AND a.disabled_at IS NULL AND u.disabled_at IS NULL
        ORDER BY a.id
        LIMIT 1`,
      project_id,
    );
    if (row === undefined) throw new Fail("unauthenticated");
    return row.actor_id;
  }

  #require_session(request: RouteRequest): void {
    if (!secret_matches(request.headers["x-pes-session"], this.#secret)) {
      throw new Fail("unauthenticated");
    }
  }

  /** Who is calling, without looking at the project: a wrong credential is 401 for any project id. */
  #credential(request: RouteRequest, project_id: string): Credential {
    const session = request.headers["x-pes-session"];
    if (session !== undefined) {
      if (!secret_matches(session, this.#secret)) throw new Fail("unauthenticated");
      return { session: true, actor_id: null, kind: "human", scopes: null, token_id: null };
    }
    const authorization = request.headers["authorization"];
    const match =
      typeof authorization === "string" ? authorization.trim().match(/^Bearer\s+(\S+)$/i) : null;
    if (match === null) throw new Fail("unauthenticated");
    const token = match[1] as string;

    let verified;
    try {
      verified = verify_agent_token(this.#db, token, {
        project_id,
        now_ms: this.#now(),
      });
    } catch {
      throw new Fail("unauthenticated");
    }
    let resolved: ResolvedActor;
    try {
      resolved = resolve_actor(
        this.#db,
        { project_id, actor_id: verified.actor_id },
        this.#now(),
      );
    } catch (error) {
      // A token that verifies but whose actor is not a project member is a
      // permission problem, not an invalid credential.
      if (error instanceof ApiError && error.code === "forbidden") throw new Fail("forbidden");
      throw new Fail("unauthenticated");
    }
    return {
      session: false,
      actor_id: resolved.actor_id,
      kind: resolved.kind,
      scopes: verified.scopes,
      token_id: verified.token_id,
    };
  }

  /** Per-token (and per-session) request budget; a refused request has run nothing. */
  #spend(credential: Credential, bucket: Bucket): () => void {
    const now = this.#now();
    const [key, limit] = credential.session
      ? ["session", OWNER_REQUESTS_PER_MINUTE]
      : [
          `${credential.token_id}:${bucket}`,
          bucket === "control" ? AGENT_CONTROL_REQUESTS_PER_MINUTE : AGENT_REQUESTS_PER_MINUTE,
        ];
    const wait = this.#budgets.take(key as string, limit as number, now);
    if (wait !== null) this.#rate_limited(wait, bucket);
    return () => this.#budgets.refund(key as string, now);
  }

  #rate_limited(retry_after_ms: number, scope: string): never {
    throw new Fail("rate_limited", {
      details: { retry_after_ms, scope },
      headers: { "retry-after": String(Math.max(1, Math.ceil(retry_after_ms / 1000))) },
    });
  }

  #bind(project: ProjectRow, credential: Credential, op: Op): AuthInfo {
    const denial = permission_denial(op, { session: credential.session, scopes: credential.scopes });
    if (denial !== null) {
      const actor_kind = credential.kind as string;
      switch (denial.by) {
        case "session_is_not_agent":
          throw new Fail("forbidden", { target: "$.headers.x-pes-session", next_action: "use_agent_token" });
        case "human_required":
        case "owner_required":
          throw new Fail(denial.by, {
            target: "$.headers.Authorization",
            details: { actor_kind, required: denial.by === "human_required" ? "human_owner" : "owner_human" },
          });
        case "session_only":
          throw new Fail("forbidden", { target: "$.headers.Authorization", details: { actor_kind } });
        case "scope":
          throw new Fail("forbidden", {
            target: "$.headers.Authorization",
            details: { required_scope: denial.scope },
            next_action: "request_scope",
          });
      }
    }
    if (credential.session) {
      return {
        actor_id: this.#owner_actor(project.id),
        kind: "human",
        session: true,
        scopes: null,
        token_id: null,
      };
    }
    return {
      actor_id: credential.actor_id as string,
      kind: credential.kind as string,
      session: false,
      scopes: credential.scopes,
      token_id: credential.token_id,
    };
  }

  #require_go(project_id: string): void {
    const decision = check_go_allowed(this.#db, project_id);
    if (!decision.allowed) throw new Fail("policy_blocked");
  }

  /**
   * SEL-68: the shared actor rule as an API refusal — 403 forbidden with target `$.body.<field>` (the field that
   * carries the Go label, or `run_id`) and details.actor_kind (the kind that was refused), before any write.
   */
  #require_internal_for_go(
    kind: string,
    run: { mode: unknown; provider: unknown; model: unknown },
    field?: string,
  ): void {
    try {
      require_internal_ai_for_go_run(kind, run, field);
    } catch (error) {
      if (error instanceof ApiError && error.code === "forbidden") {
        const detail = error.details as { actor_kind: string; field: string };
        throw new Fail("forbidden", { target: `$.body.${detail.field}`, details: { actor_kind: detail.actor_kind } });
      }
      throw error;
    }
  }

  #run_mode(project_id: string, run_id: string): string | null {
    return run_info(this.#db, project_id, run_id)?.mode ?? null;
  }

  #require_go_for_run(project_id: string, run_id: string): void {
    if (this.#run_mode(project_id, run_id) === "A") this.#require_go(project_id);
  }

  #ctx(
    project: ProjectRow,
    auth: AuthInfo,
    key: string,
    base?: number | string,
  ): MutationContext {
    const ctx: MutationContext = {
      project_id: project.id,
      actor_id: auth.actor_id,
      via: "http",
      client_request_id: key,
    };
    if (base !== undefined) ctx.base_control_rev = base;
    return ctx;
  }

  /** Run one command; a core refusal becomes the envelope error (optionally refined). */
  async #exec<T extends CommandOutcome>(
    call: () => Promise<T>,
    refine?: (error: unknown) => Fail,
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw refine === undefined ? fail_from(error) : refine(error);
    }
  }

  #normalize_run_result(result: unknown): unknown {
    if (!is_record(result)) return result;
    const out: Record<string, unknown> = { ...result };
    if (typeof out.fence === "number") out.fence = String(out.fence);
    return out;
  }

  /** The guard fields of a lease-bound call: all three or none. */
  #guard_fields(body: Record<string, unknown>): { run_id: string; lease_id: string; fence: number } | null {
    const given = ["run_id", "lease_id", "fence"].filter(
      (field) => body[field] !== undefined && body[field] !== null,
    );
    if (given.length === 0) return null;
    for (const field of ["run_id", "lease_id", "fence"]) {
      if (!given.includes(field)) invalid_field(field);
    }
    return {
      run_id: require_text(body, "run_id"),
      lease_id: require_text(body, "lease_id"),
      fence: parse_fence(body.fence),
    };
  }

  /** The current lease is shown only to the actor that holds it; anyone else learns nothing about it. */
  #lease_lost(project_id: string, fence_text: string, auth: AuthInfo): Fail {
    const lease = lease_info(this.#db, project_id);
    const live =
      lease !== undefined &&
      lease.state === "active" &&
      this.#now() < Number(lease.expires_at) &&
      lease.owner_actor_id === auth.actor_id;
    return new Fail("lease_lost", {
      target: "$.body.fence",
      details: {
        expected_fence: fence_text,
        current_fence: live ? lease.fence.toString() : null,
        current_lease_id: live ? lease.lease_id : null,
      },
    });
  }

  #live_lease_of_run(project_id: string, run_id: string) {
    const lease = lease_info(this.#db, project_id);
    if (
      lease === undefined ||
      lease.state !== "active" ||
      this.#now() >= Number(lease.expires_at) ||
      lease.run_id !== run_id
    ) {
      return undefined;
    }
    return lease;
  }

  #query_limit(request: RouteRequest, field: string, min: number, max: number, fallback: number): number {
    if (!request.query.has(field)) return fallback;
    const text = request.query.get(field) as string;
    if (!/^[0-9]+$/.test(text)) invalid(`$.query.${field}`);
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`$.query.${field}`);
    return value;
  }

  // -------------------------------------------------------------------------
  // capabilities, project create / register

  #capabilities(): HandlerResult {
    const routes: string[] = [];
    const unsupported: string[] = [];
    const operations: Record<string, { supported: boolean }> = {};
    const human_only: string[] = [];
    for (const spec of this.#table) {
      const label = `${spec.method} ${spec.path}`;
      if (spec.kind === "unsupported") {
        unsupported.push(label);
        operations[spec.operation] = { supported: false };
        continue;
      }
      routes.push(label);
      operations[spec.operation] = { supported: true };
      if (spec.kind === "global" && spec.operation !== "capabilities.get") human_only.push(label);
      if (spec.op !== undefined && ["human", "owner", "session"].includes(spec.op.who)) human_only.push(label);
    }
    const limits = {
      max_body_bytes: MAX_BODY_BYTES,
      max_results_per_batch: MAX_RESULTS_PER_BATCH,
      list_max_items: LIST_MAX_ITEMS,
      long_poll_max_ms: MAX_WAIT_MS,
      min_poll_interval_ms: MIN_POLL_INTERVAL_MS,
      agent_requests_per_minute: AGENT_REQUESTS_PER_MINUTE,
      owner_requests_per_minute: OWNER_REQUESTS_PER_MINUTE,
    };
    return {
      status: 200,
      data: {
        format_version: FORMAT_VERSION,
        server: "pes-local",
        api_version: "v1",
        routes,
        unsupported,
        scopes: [...SCOPES],
        human_only,
        limits,
        capabilities: {
          operations,
          // The document form (fixtures/api-v1/capabilities.json) renames a few keys of the same numbers.
          limits: {
            long_poll_max_ms: limits.long_poll_max_ms,
            request_body_max_bytes: limits.max_body_bytes,
            results_per_submit: limits.max_results_per_batch,
            list_max_items: limits.list_max_items,
            min_poll_interval_ms: limits.min_poll_interval_ms,
            agent_requests_per_minute: limits.agent_requests_per_minute,
          },
          error_codes: [...ERROR_CODES],
        },
      },
    };
  }

  /**
   * The request-budget rules in one serializable value. serve.py (the one long-lived process) applies them
   * before it hands a request to the per-request bridge, so the numbers and the control/poll routes live
   * here only.
   */
  budget_policy(): Record<string, unknown> {
    const templates = (match: (spec: RouteSpec) => boolean): string[] =>
      this.#table.filter((spec) => spec.kind === "project" && match(spec)).map((spec) => `${spec.method} ${spec.path}`);
    return {
      window_ms: WINDOW_MS,
      agent_requests_per_minute: AGENT_REQUESTS_PER_MINUTE,
      agent_control_requests_per_minute: AGENT_CONTROL_REQUESTS_PER_MINUTE,
      owner_requests_per_minute: OWNER_REQUESTS_PER_MINUTE,
      // Shared by all credential-less requests, and per credential by refunded (malformed) requests.
      coarse_requests_per_minute: AGENT_REQUESTS_PER_MINUTE * 5,
      min_poll_interval_ms: MIN_POLL_INTERVAL_MS,
      control_routes: templates((spec) => spec.op?.bucket === "control"),
      poll_routes: templates((spec) => spec.operation === "runs.inputs"),
      refund_codes: [...REFUNDED_CODES],
    };
  }

  async #create_project(request: RouteRequest): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["slug", "topic", "owner_display_name"]);
    const slug = require_text(body, "slug");
    if (!SLUG.test(slug)) invalid_field("slug");
    const payload = {
      slug,
      topic: require_text(body, "topic"),
      owner_display_name: require_text(body, "owner_display_name"),
    };
    const out = await this.#exec(() =>
      this.#service.execute(
        { project_id: null, actor_id: null, via: "http", client_request_id: key },
        "project.bootstrap",
        payload,
      ),
    );
    return { status: 201, data: out.result, replayed: out.replayed };
  }

  async #register(request: RouteRequest): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["slug", "topic", "owner_display_name", "device_label", "scopes"]);
    const slug = require_text(body, "slug");
    if (!SLUG.test(slug)) invalid_field("slug");
    const payload: Record<string, unknown> = {
      slug,
      topic: require_text(body, "topic"),
      owner_display_name: require_text(body, "owner_display_name"),
      device_label: require_text(body, "device_label"),
    };
    if (Object.hasOwn(body, "scopes")) {
      const scopes = body.scopes;
      if (!Array.isArray(scopes) || scopes.length === 0) invalid_field("scopes");
      scopes.forEach((scope, i) => {
        if (typeof scope !== "string" || !(SCOPES as readonly string[]).includes(scope)) {
          invalid(`$.body.scopes[${i}]`);
        }
      });
      if (new Set(scopes).size !== scopes.length) invalid_field("scopes");
      payload.scopes = scopes;
    }
    const out = await this.#exec(() =>
      register_project(
        this.#service,
        { project_id: null, actor_id: null, via: "http", client_request_id: key },
        payload,
      ),
    );
    // A replay never repeats the raw token; say so, so a client that lost the
    // first response knows to ask the owner for a new device token.
    const data = out.replayed
      ? { ...result_record(out.result), token_issued_before: true }
      : out.result;
    return { status: 201, data, replayed: out.replayed };
  }

  // -------------------------------------------------------------------------
  // context, versions, changes

  async #context(project: ProjectRow): Promise<HandlerResult> {
    const data = read_tx(this.#db, () => this.#context_data(this.#project(project.id)));
    return { status: 200, data };
  }

  #version_content(project_id: string, kind: string, version_id: string): unknown {
    if (kind === "artifact") {
      const row = this.#db.get<{ title: string; summary: string; body_md: string | null }>(
        `SELECT title, summary, body_md FROM artifact_versions
          WHERE project_id = ? AND version_id = ?`,
        project_id,
        version_id,
      );
      return row === undefined
        ? null
        : { title: row.title, summary: row.summary, body_md: row.body_md };
    }
    if (kind === "source") {
      const row = this.#db.get<{
        title: string;
        url: string | null;
        quote: string | null;
        locator: string;
        method: string;
        verification_state: string;
        source_kind: string | null;
      }>(
        `SELECT sv.title AS title, sv.url AS url, sv.quote AS quote, sv.locator AS locator,
                sv.method AS method, sv.verification_state AS verification_state,
                s.kind AS source_kind
           FROM source_versions sv
           LEFT JOIN sources s ON s.project_id = sv.project_id AND s.object_id = sv.object_id
          WHERE sv.project_id = ? AND sv.version_id = ?`,
        project_id,
        version_id,
      );
      if (row === undefined) return null;
      let locator: unknown = {};
      try {
        locator = JSON.parse(row.locator);
      } catch {
        locator = {};
      }
      return {
        title: row.title,
        url: row.url,
        quote: row.quote,
        locator,
        source_kind: row.source_kind,
        method: row.method,
        verification_state: row.verification_state,
      };
    }
    if (kind === "answer") {
      const row = this.#db.get<{ question_id: string; question_version_id: string; value: string; state: string }>(
        `SELECT question_id, question_version_id, value, state FROM answer_versions
          WHERE project_id = ? AND version_id = ?`,
        project_id,
        version_id,
      );
      if (row === undefined) return null;
      // The comment sent with this answer version: the message of the same submission (same transaction)
      // on the question version's comment thread, at its current version.
      const comment = this.#db.get<{ body_md: string }>(
        `SELECT mv.body_md AS body_md
           FROM object_versions ov
           JOIN submissions s ON s.project_id = ov.project_id AND s.tx_id = ov.tx_id
           JOIN messages m ON m.project_id = s.project_id AND m.submission_id = s.id
           JOIN threads t ON t.project_id = m.project_id AND t.object_id = m.thread_id
           JOIN objects mo ON mo.project_id = m.project_id AND mo.id = m.object_id
           JOIN message_versions mv ON mv.project_id = m.project_id AND mv.version_id = mo.current_version_id
          WHERE ov.project_id = ? AND ov.id = ?
            AND t.context_kind = 'question_comment'
            AND t.target_object_id = ? AND t.target_version_id = ?
          ORDER BY m.rowid
          LIMIT 1`,
        project_id,
        version_id,
        row.question_id,
        row.question_version_id,
      );
      return {
        question_version_id: row.question_version_id,
        value: parse_json_or_null(row.value),
        state: row.state,
        comment: comment?.body_md ?? null,
      };
    }
    if (kind === "message") {
      const row = this.#db.get<{ thread_id: string; body_md: string; state: string; reply_to: string | null }>(
        `SELECT mv.thread_id AS thread_id, mv.body_md AS body_md, mv.state AS state, m.reply_to AS reply_to
           FROM message_versions mv
           JOIN messages m ON m.project_id = mv.project_id AND m.object_id = mv.object_id
          WHERE mv.project_id = ? AND mv.version_id = ?`,
        project_id,
        version_id,
      );
      if (row === undefined) return null;
      return { thread_id: row.thread_id, body_md: row.body_md, state: row.state, reply_to: row.reply_to };
    }
    if (kind === "thread") {
      const row = this.#db.get<{
        target_object_id: string;
        target_version_id: string | null;
        context_kind: string;
        state: string;
      }>(
        `SELECT t.target_object_id AS target_object_id, t.target_version_id AS target_version_id,
                t.context_kind AS context_kind, tv.state AS state
           FROM thread_versions tv
           JOIN threads t ON t.project_id = tv.project_id AND t.object_id = tv.object_id
          WHERE tv.project_id = ? AND tv.version_id = ?`,
        project_id,
        version_id,
      );
      if (row === undefined) return null;
      return {
        target_object_id: row.target_object_id,
        target_version_id: row.target_version_id,
        context_kind: row.context_kind,
        state: row.state,
      };
    }
    if (kind === "question") {
      const row = this.#db.get<{
        text: string;
        type: string;
        state: string;
        importance: string;
        required: bigint;
        allow_comment_as_answer: bigint;
        default_value: string;
        options: string;
        show_if: string;
        help: string | null;
      }>(
        `SELECT text, type, state, importance, required, allow_comment_as_answer,
                default_value, options, show_if, help
           FROM question_versions WHERE project_id = ? AND version_id = ?`,
        project_id,
        version_id,
      );
      if (row === undefined) return null;
      return {
        text: row.text,
        type: row.type,
        state: row.state,
        importance: row.importance,
        required: Number(row.required) === 1,
        allow_comment_as_answer: Number(row.allow_comment_as_answer) === 1,
        default_value: parse_json_or_null(row.default_value),
        options: parse_json_or_null(row.options) ?? [],
        show_if: parse_json_or_null(row.show_if),
        help: row.help,
      };
    }
    return null;
  }

  async #version_read(
    request: RouteRequest,
    project: ProjectRow,
    auth: AuthInfo,
  ): Promise<HandlerResult> {
    const data = read_tx(this.#db, () => {
      const object_id = request.params[1] as string;
      const version_id = request.params[2] as string;
      const row = this.#db.get<{
        object_id: string;
        kind: string;
        version_id: string;
        version_no: bigint;
        content_hash: string;
        is_current: bigint;
      }>(
        `SELECT o.id AS object_id, o.kind AS kind, v.id AS version_id,
                v.version_no AS version_no, v.content_hash AS content_hash,
                (o.current_version_id = v.id) AS is_current
           FROM object_versions v
           JOIN objects o ON o.project_id = v.project_id AND o.id = v.object_id
          WHERE v.project_id = ? AND v.object_id = ? AND v.id = ?`,
        project.id,
        object_id,
        version_id,
      );
      if (row === undefined) throw new Fail("not_found");
      const files = this.#db.all<{ blob_id: string; role: string }>(
        `SELECT blob_id, role FROM version_files
          WHERE project_id = ? AND version_id = ? ORDER BY role, blob_id`,
        project.id,
        version_id,
      );
      const visible = auth.kind === "human" ? files : files.filter((f) => !this.#blob_denied(project.id, f.blob_id));
      return {
        project_id: project.id,
        object_id: row.object_id,
        kind: row.kind,
        version_id: row.version_id,
        version_no: Number(row.version_no),
        is_current: Number(row.is_current) === 1,
        content_hash: row.content_hash,
        content: this.#version_content(project.id, row.kind, version_id),
        files: visible.map((file) => ({ blob_id: file.blob_id, role: file.role })),
      };
    });
    return { status: 200, data };
  }

  #context_data(project: ProjectRow): unknown {
    const policy: PolicySnapshot = current_policy(this.#db, project.id);
    if (project.active_edition_id === null) {
      throw new ApiError("conflict", "the project has no active edition");
    }
    const edition = this.#db.get<EditionRow>(
      "SELECT id, edition_no, status, current_stage_id FROM editions WHERE project_id = ? AND id = ?",
      project.id,
      project.active_edition_id,
    );
    if (edition === undefined) {
      throw new ApiError("conflict", "the project has no active edition");
    }
    const stages = this.#db.all<StageRow>(
      `SELECT id, key, ordinal, status, rev, stale_since_event_seq
         FROM stages WHERE project_id = ? AND edition_id = ? ORDER BY ordinal`,
      project.id,
      edition.id,
    );
    const manifest = this.#db.all<ManifestRow>(
      `SELECT o.id AS object_id, o.kind AS kind, v.id AS version_id, v.version_no AS version_no
         FROM objects o
         JOIN object_versions v
           ON v.project_id = o.project_id AND v.object_id = o.id
          AND v.id = o.current_version_id
        WHERE o.project_id = ? AND o.archived_at IS NULL
        ORDER BY o.id`,
      project.id,
    );
    const lease = this.#db.get<LeaseRow>(
      `SELECT lease_id, run_id, fence, expires_at
         FROM project_leases
        WHERE project_id = ? AND state = 'active' AND expires_at > ?
        ORDER BY rowid DESC LIMIT 1`,
      project.id,
      this.#now(),
    );

    const digest_source = JSON.stringify({
      project_id: project.id,
      control_rev: project.control_rev.toString(),
      policy_rev: String(policy.policy_rev),
      edition_id: edition.id,
      stages: stages.map((stage) => [
        stage.id,
        stage.key,
        stage.status,
        stage.rev.toString(),
        stage.stale_since_event_seq === null ? null : stage.stale_since_event_seq.toString(),
      ]),
      manifest: manifest.map((entry) => [
        entry.object_id,
        entry.version_id,
        entry.kind,
        entry.version_no.toString(),
      ]),
    });
    const digest = createHash("sha256").update(digest_source, "utf8").digest("hex");

    return {
      project_id: project.id,
      topic: project.topic,
      control_rev: project.control_rev.toString(),
      policy: {
        policy_id: policy.policy_id,
        policy_rev: String(policy.policy_rev),
        allow_opencode_go: policy.allow_opencode_go,
        mode_a_model: policy.mode_a_model,
        go_usage_stop_percent: policy.go_usage_stop_percent,
      },
      edition: {
        edition_id: edition.id,
        edition_no: edition.edition_no.toString(),
        status: edition.status,
        current_stage_id: edition.current_stage_id,
      },
      stages: stages.map((stage) => ({
        stage_id: stage.id,
        key: stage.key,
        ordinal: Number(stage.ordinal),
        status: stage.status,
        rev: stage.rev.toString(),
        stale_since_event_seq:
          stage.stale_since_event_seq === null ? null : stage.stale_since_event_seq.toString(),
      })),
      manifest: manifest.map((entry) => ({
        object_id: entry.object_id,
        kind: entry.kind,
        version_id: entry.version_id,
        version_no: Number(entry.version_no),
      })),
      digest,
      lease:
        lease === undefined
          ? null
          : {
              run_id: lease.run_id,
              lease_id: lease.lease_id,
              fence: lease.fence.toString(),
              expires_at: Number(lease.expires_at),
            },
    };
  }

  // workspace (SEL-82 U1b): the one read model the app's work-space screens read. Read-only: no write, no new table, and the
  // only new SQL of U1 lives in #workspace_data. Machine values only; the screen makes its own words.

  async #workspace(project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const data = read_tx(this.#db, () => this.#workspace_data(this.#project(project.id), auth));
    return { status: 200, data };
  }

  /** Can this caller run the operation? null = yes; otherwise the reason, in Korean (the rule #bind enforces — permission_denial; display only). */
  #action_refusal(operation: string, auth: AuthInfo): string | null {
    const op = this.#table.find((spec) => spec.operation === operation)?.op;
    if (op === undefined) return "이 서버가 지원하지 않는 동작입니다.";
    const denial = permission_denial(op, { session: auth.session, scopes: auth.scopes });
    if (denial === null) return null;
    switch (denial.by) {
      case "session_is_not_agent":
        return "에이전트 토큰으로만 할 수 있는 동작입니다.";
      case "scope":
        return `이 토큰에는 ${denial.scope} 권한이 없습니다.`;
      default:
        return "소유자 본인(사람)만 할 수 있는 동작입니다.";
    }
  }

  #workspace_data(project: ProjectRow, auth: AuthInfo): unknown {
    if (project.active_edition_id === null) throw new ApiError("conflict", "the project has no active edition");
    const edition = this.#db.get<EditionRow>(
      "SELECT id, edition_no, status, current_stage_id FROM editions WHERE project_id = ? AND id = ?",
      project.id,
      project.active_edition_id,
    );
    if (edition === undefined) throw new ApiError("conflict", "the project has no active edition");
    const stage_rows = this.#db.all<StageRow>(
      `SELECT id, key, ordinal, status, rev, stale_since_event_seq
         FROM stages WHERE project_id = ? AND edition_id = ? ORDER BY ordinal`,
      project.id,
      edition.id,
    );
    const round_rows = this.#db.all<{ stage_id: string; round_no: bigint; state: string }>(
      `SELECT stage_id, round_no, state FROM rounds
        WHERE project_id = ? AND edition_id = ? ORDER BY stage_id, round_no`,
      project.id,
      edition.id,
    );
    // the newest run of each stage tells whose turn it is while the stage is active
    const run_rows = this.#db.all<{ stage_id: string; status: string; mode: string }>(
      `SELECT r.stage_id AS stage_id, r.status AS status, r.mode AS mode
         FROM runs r
        WHERE r.project_id = ? AND r.edition_id = ?
          AND r.rowid = (SELECT MAX(r2.rowid) FROM runs r2
                          WHERE r2.project_id = r.project_id AND r2.edition_id = r.edition_id AND r2.stage_id = r.stage_id)`,
      project.id,
      edition.id,
    );
    const latest_run = this.#db.get<{ mode: string }>(
      "SELECT mode FROM runs WHERE project_id = ? ORDER BY rowid DESC LIMIT 1",
      project.id,
    );
    // SEL-93: assumptions of this edition, decisions of this edition and the project-wide ones, and every comment message
    const counts = this.#db.all<{ kind: string; n: bigint }>(
      `SELECT o.kind AS kind, COUNT(*) AS n
         FROM objects o LEFT JOIN decisions d ON d.project_id = o.project_id AND d.object_id = o.id
        WHERE o.project_id = ? AND o.archived_at IS NULL
          AND (o.kind = 'message'
               OR (o.kind = 'assumption' AND o.edition_id = ?)
               OR (o.kind = 'decision' AND (o.edition_id = ? OR d.scope = 'project')))
        GROUP BY o.kind`,
      project.id,
      edition.id,
      edition.id,
    );
    const count_of = (kind: string): number => Number(counts.find((row) => row.kind === kind)?.n ?? 0n);

    const run_of = new Map(run_rows.map((row) => [row.stage_id, row.status]));
    const place = current_place(edition.current_stage_id, stage_rows, round_rows);
    if (place === undefined) throw new ApiError("conflict", "the project has no stages");
    const current_stage = place.stage;

    const view_of = (stage: StageRow): string => {
      if (stage.status === "approved") return stage.stale_since_event_seq === null ? "approved" : "stale";
      if (stage.id !== current_stage.id) return "pending";
      if (stage.status === "asking") return "current_you";
      const run = run_of.get(stage.id);
      if (run === "running" || run === "queued") return "current_ai";
      if (run === "blocked_usage") return "current_blocked";
      return "current_you";
    };

    // the newest approval of each stage (U1d past approval): it stays even while the stage is stale. at = the commit time
    // (mutation_commits.created_at, ms) or null when the old approval has no time (0)
    const approval_rows = this.#db.all<{ stage_id: string; assurance: string; created_at: bigint }>(
      `SELECT a.stage_id AS stage_id, a.assurance AS assurance, c.created_at AS created_at
         FROM approvals a JOIN mutation_commits c ON c.project_id = a.project_id AND c.id = a.tx_id
        WHERE a.project_id = ? AND a.rowid = (SELECT MAX(a2.rowid) FROM approvals a2 WHERE a2.project_id = a.project_id AND a2.stage_id = a.stage_id)`,
      project.id,
    );
    const approval_of = new Map(approval_rows.map((row) => [row.stage_id, row]));

    const stages = stage_rows.map((stage) => {
      const mine = round_rows.filter((round) => round.stage_id === stage.id);
      const open = mine.some((round) => round.state === "open");
      const rounds: Array<{ round_id: number | null; state: "closed" | "current" }> = [];
      // the stage-start questions are the round_id = null place (no made-up R0); a stage not started yet has none
      if (stage.status !== "pending" || mine.length > 0) {
        rounds.push({ round_id: null, state: stage.status === "asking" && !open ? "current" : "closed" });
      }
      for (const round of mine) rounds.push({ round_id: Number(round.round_no), state: round.state === "open" ? "current" : "closed" });
      const approval = approval_of.get(stage.id);
      if (approval === undefined) return { key: stage.key, view: view_of(stage), rounds };
      const ms = Number(approval.created_at);
      const past_approval = {
        // a damaged time (not a safe integer, or past the Date range 8.64e15) is shown as unknown, never thrown
        at: Number.isSafeInteger(ms) && ms > 0 && ms <= 8.64e15 ? new Date(ms).toISOString() : null,
        origin: approval.assurance === "verified" ? "verified" : "legacy_unverified",
      };
      return { key: stage.key, view: view_of(stage), past_approval, rounds };
    });

    const open_round = place.open_round;
    const current_round_id = place.round_id;

    const everything_approved = stage_rows.every((stage) => stage.status === "approved" && stage.stale_since_event_seq === null);
    const current_view = stages.find((stage) => stage.key === current_stage.key)?.view ?? "pending";
    const side = everything_approved ? "done" : current_view === "current_ai" ? "ai" : current_view === "current_blocked" ? "waiting" : "you";

    const policy_mode = ((): string => {
      try {
        return current_policy(this.#db, project.id).allow_opencode_go ? "A" : "B";
      } catch {
        return "B";
      }
    })();

    // which actions this caller can take (display only: the server still checks every write), and why not
    const has_open_round = open_round !== undefined;
    const state_refusal = (operation: string): string | null => {
      switch (operation) {
        case "submissions.create":
          return current_stage.status === "asking" || has_open_round ? null : "지금 답할 질문이 없습니다.";
        case "stages.approve":
          return current_stage.status === "active" ? null : "승인할 수 있는 상태의 단계가 아닙니다.";
        case "stages.reopen":
          return stage_rows.some((stage) => stage.status === "approved") ? null : "다시 열 수 있는 승인된 단계가 없습니다.";
        case "rounds.seal":
          return has_open_round ? null : "열려 있는 라운드가 없습니다.";
        default:
          return null;
      }
    };
    const actions = ACTION_OPERATIONS.map((operation) => {
      const reason = this.#action_refusal(operation, auth) ?? state_refusal(operation);
      return { action: operation, enabled: reason === null, disabled_reason: reason };
    });

    const assumptions = count_of("assumption");
    const decisions = count_of("decision");
    const comments = count_of("message");

    // U1d AI connection: the policy is the allow_opencode_go bit alone (null pointer = missing, any other damage = corrupt).
    // "pending", cancel_state, external_stop and run_permissions are not sent: the DB has no evidence for them.
    const policy_state = ((): "allowed" | "denied" | "missing" | "corrupt" => {
      if (project.current_policy_id === null) return "missing";
      try {
        return current_policy(this.#db, project.id).allow_opencode_go ? "allowed" : "denied";
      } catch {
        return "corrupt";
      }
    })();
    // The newest WORKSPACE_LIST_MAX of each list (largest rowid first), then shown oldest-first.
    // runs are narrowed to the ACTIVE edition (a run is work of one edition). Dispatches are NOT: what was sent out and
    // what must be settled (billing, recall) are facts of the whole project and stay true after a new edition, so the
    // newest 50 dispatches of the project are sent whatever edition their run belongs to. In both lists the inner query
    // picks the newest rows from one table (ORDER BY rowid DESC LIMIT), and the resolution / stage joins run on those rows only.
    const dispatches = this.#db
      .all<{ id: string; run_id: string; state: string; resolution: string | null }>(
        `SELECT n.id AS id, n.run_id AS run_id, n.state AS state, x.outcome AS resolution
           FROM (
             SELECT d.rowid AS rid, d.id AS id, d.run_id AS run_id, d.state AS state
               FROM outbound_dispatches d WHERE d.project_id = ? ORDER BY d.rowid DESC LIMIT ${WORKSPACE_LIST_MAX}
           ) n LEFT JOIN dispatch_resolutions x ON x.dispatch_id = n.id
          ORDER BY n.rid ASC`,
        project.id,
      )
      .map((row) => (row.resolution === null ? { id: row.id, run_id: row.run_id, state: row.state } : { id: row.id, run_id: row.run_id, state: row.state, resolution: row.resolution }));
    const handoff_runtimes: string[] = Object.values(HANDOFF_APPS).map((app) => app.runtime);
    const runs = this.#db
      .all<{ id: string; stage: string | null; mode: string; status: string; runtime: string; actor_kind: string | null }>(
        `SELECT n.id AS id, s.key AS stage, n.mode AS mode, n.status AS status, n.runtime AS runtime, a.kind AS actor_kind
           FROM (
             SELECT r.rowid AS rid, r.id AS id, r.project_id AS project_id, r.stage_id AS stage_id, r.mode AS mode, r.status AS status, r.runtime AS runtime, r.actor_id AS actor_id
               FROM runs r WHERE r.project_id = ? AND r.edition_id = ? ORDER BY r.rowid DESC LIMIT ${WORKSPACE_LIST_MAX}
           ) n LEFT JOIN stages s ON s.project_id = n.project_id AND s.id = n.stage_id
               LEFT JOIN actors a ON a.id = n.actor_id
          ORDER BY n.rid ASC`,
        project.id,
        edition.id,
      )
      .map((row) => ({
        id: row.id,
        stage: row.stage,
        mode: row.mode,
        // handed_off is only the hand-off import run's shape (commands/handoff_import.ts): runtime *_app_handoff, a human
        // owner actor, status succeeded. runtime is a free string an agent may send on claim, so the name alone proves nothing.
        status: handoff_runtimes.includes(row.runtime) && row.status === "succeeded" && row.actor_kind === "human" ? "handed_off" : row.status,
      }));
    return {
      slug: project.slug,
      title: project.topic,
      edition: Number(edition.edition_no),
      mode: latest_run?.mode ?? policy_mode,
      current: { stage: current_stage.key, round_id: current_round_id },
      stages,
      turn: { side },
      actions,
      ai_connection: { policy: policy_state, dispatches },
      runs,
      records: {
        assumptions: { count: assumptions },
        decisions: { count: decisions },
        comments: { count: comments },
        empty: assumptions + decisions + comments === 0,
      },
    };
  }

  async #changes(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const limit = this.#query_limit(request, "limit", 1, LIST_MAX_ITEMS, LIST_MAX_ITEMS);
    const scope = auth.session ? "owner" : "agent";
    let given: ReturnType<typeof read_cursor> = null;
    if (request.query.get("cursor") === "head") {
      // SEL-82: "just the head" — no event is read; the cursor a full read would end on (every event of the project is scanned, hidden ones too)
      const data = read_tx(this.#db, () => {
        const meta = db_meta(this.#db);
        return {
          events: [],
          next_cursor: make_cursor(this.#secret, {
            p: project.id,
            s: scope,
            d: meta.database_instance_id,
            e: meta.cursor_epoch,
            q: max_event_seq(this.#db, project.id).toString(),
          }),
          has_more: false,
          epoch: meta.cursor_epoch,
        };
      });
      return { status: 200, data };
    }
    if (request.query.has("cursor")) {
      given = read_cursor(this.#secret, request.query.get("cursor") as string);
      if (given === null || given.p !== project.id || given.s !== scope) {
        throw new Fail("cursor_invalid", { target: "$.query.cursor" });
      }
    }
    const data = read_tx(this.#db, () => {
      const meta = db_meta(this.#db);
      if (given !== null && (given.d !== meta.database_instance_id || given.e !== meta.cursor_epoch)) {
        const fresh = this.#project(project.id);
        const context = this.#context_data(fresh) as {
          control_rev: string;
          digest: string;
          stages: Array<{ stage_id: string; key: string; status: string; rev: string }>;
        };
        throw new Fail("cursor_expired", {
          target: "$.query.cursor",
          details: {
            database_instance_id: meta.database_instance_id,
            cursor_epoch: given.e,
            current_epoch: meta.cursor_epoch,
            reason: given.d !== meta.database_instance_id ? "database_changed" : "epoch_changed",
            next_cursor: make_cursor(this.#secret, {
              p: project.id,
              s: scope,
              d: meta.database_instance_id,
              e: meta.cursor_epoch,
              q: max_event_seq(this.#db, project.id).toString(),
            }),
            snapshot: {
              control_rev: context.control_rev,
              digest: context.digest,
              stages: context.stages.map((stage) => ({
                stage_id: stage.stage_id,
                key: stage.key,
                status: stage.status,
                rev: stage.rev,
              })),
            },
            keep_unsubmitted_answers: true,
          },
        });
      }
      const page = changes_page(
        this.#db,
        project.id,
        given === null ? 0n : BigInt(given.q),
        limit,
        !auth.session && auth.kind !== "human",
      );
      return {
        events: page.events,
        next_cursor: make_cursor(this.#secret, {
          p: project.id,
          s: scope,
          d: meta.database_instance_id,
          e: meta.cursor_epoch,
          q: page.last_seq.toString(),
        }),
        has_more: page.has_more,
        epoch: meta.cursor_epoch,
      };
    });
    return { status: 200, data };
  }

  // -------------------------------------------------------------------------
  // runs (PR13)

  /**
   * An explicit hand-off import (PR20a): the owner session records a result the human pasted back from an AI
   * app that has no connection to PES. It creates the owner's own run, appends the results and ends the run,
   * all in one step, as an import (via 'import'). It is the only way a result is written without a lease.
   */
  async #handoff_import(
    project: ProjectRow,
    auth: AuthInfo,
    key: string,
    body: Record<string, unknown>,
  ): Promise<HandlerResult> {
    reject_unknown(body, ["import"]);
    const source = body.import;
    if (!is_record(source)) invalid_field("import");
    const at = "$.body.import";
    for (const field of Object.keys(source)) {
      if (!["results", "request_id", "stage_id", "round_id", "claimed_tool", "claimed_model", "expected_control_rev", "expected_heads", "app"].includes(field)) {
        invalid(`${at}.${field}`);
      }
    }
    if (!Array.isArray(source.results) || source.results.length < 1 || source.results.length > MAX_RESULTS_PER_BATCH) {
      invalid(`${at}.results`);
    }
    const request_id = require_text(source, "request_id", at);
    // One bundle is imported once: its Idempotency-Key is the bundle's own request id, so another key for the
    // same request_id is refused here instead of importing the bundle a second time.
    if (key !== `import-${request_id}`) invalid("$.headers.idempotency-key");
    for (const field of ["stage_id", "round_id", "claimed_tool", "claimed_model"]) {
      const value = source[field];
      if (value !== undefined && value !== null && (typeof value !== "string" || value.length === 0 || !value.isWellFormed())) {
        invalid(`${at}.${field}`);
      }
    }
    // The app the paste comes from, a closed list (PR20c). Absent is the Claude app; anything else is refused here
    // and again by the command, before a row is written.
    if (Object.hasOwn(source, "app") && (typeof source.app !== "string" || !Object.hasOwn(HANDOFF_APPS, source.app))) {
      invalid(`${at}.app`);
    }
    const base = Object.hasOwn(source, "expected_control_rev")
      ? parse_decimal(source.expected_control_rev, `${at}.expected_control_rev`)
      : undefined;
    const { expected_control_rev: _base, ...payload } = source;
    const ctx = { ...this.#ctx(project, auth, key, base), via: "import" as const };
    const out = await this.#exec(() => create_run(this.#service, ctx, { import: payload }));
    return { status: 201, data: { ...result_record(out.result), mode: "B" }, replayed: out.replayed };
  }

  async #runs_create(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    if (Object.hasOwn(body, "import")) return this.#handoff_import(project, auth, key, body);
    reject_unknown(body, ["actor_id", "mode", "runtime", "provider", "model"]);
    const actor_id = require_text(body, "actor_id");
    const mode = require_mode(body);
    const runtime = require_text(body, "runtime");
    const provider = require_text(body, "provider");
    const model = require_text(body, "model");
    // SEL-68: a mode A / Go-labelled run is made for an internal_ai actor only — refused before any write.
    const target = read_credential_actor(this.#db, actor_id);
    if (target !== undefined) this.#require_internal_for_go(target.kind, { mode, provider, model });
    if (mode === "A" && (provider !== GO_PROVIDER || !model.startsWith(GO_MODEL_PREFIX))) {
      invalid_field("provider");
    }
    if (mode === "A") this.#require_go(project.id);
    const out = await this.#exec(() =>
      create_run(this.#service, this.#ctx(project, auth, key), {
        actor_id,
        mode,
        runtime,
        provider,
        model,
      }),
    );
    return { status: 201, data: { ...result_record(out.result), mode }, replayed: out.replayed };
  }

  /**
   * A claim that names a run PES does not have is answered as not_found even when the Idempotency-Key is
   * missing: the thing asked for is looked at before the shape of the request. (Nothing is written either way.)
   */
  #unknown_claim_target(request: RouteRequest, project: ProjectRow): void {
    if (request.key !== null || request.body === null) return;
    try {
      const bytes = typeof request.body === "string" ? Buffer.from(request.body, "utf8") : request.body;
      if (bytes.byteLength > MAX_BODY_BYTES) return;
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (is_record(parsed) && typeof parsed.run_id === "string" && run_info(this.#db, project.id, parsed.run_id) === undefined) {
        throw new Fail("not_found");
      }
    } catch (error) {
      if (error instanceof Fail) throw error;
    }
  }

  async #claims(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    this.#unknown_claim_target(request, project);
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    const has_run = Object.hasOwn(body, "run_id");
    reject_unknown(
      body,
      has_run
        ? ["run_id", "expected_control_rev"]
        : ["mode", "runtime", "provider", "model", "expected_control_rev"],
    );
    const base = Object.hasOwn(body, "expected_control_rev")
      ? parse_decimal(body.expected_control_rev, "$.body.expected_control_rev")
      : undefined;

    let payload: Record<string, unknown>;
    if (has_run) {
      const run_id = require_text(body, "run_id");
      // SEL-68: the caller's kind, not only the run's mode, decides first (the Go policy follows for internal_ai).
      const held = this.#db.get<{ mode: string | null; provider: string | null; model: string | null }>(
        "SELECT mode, provider, model FROM runs WHERE project_id = ? AND id = ?",
        project.id,
        run_id,
      );
      if (held !== undefined) this.#require_internal_for_go(auth.kind, held, "run_id");
      if (held?.mode === "A") this.#require_go(project.id);
      payload = { run_id };
    } else {
      const mode = require_mode(body);
      const runtime = require_text(body, "runtime");
      const provider = require_text(body, "provider");
      const model = require_text(body, "model");
      // SEL-68: mode A and a Go label belong to an internal_ai caller; any other kind is 403 before a write.
      this.#require_internal_for_go(auth.kind, { mode, provider, model });
      if (mode === "A" && (provider !== GO_PROVIDER || !model.startsWith(GO_MODEL_PREFIX))) {
        invalid_field("provider");
      }
      if (mode === "A") this.#require_go(project.id);
      payload = { mode, runtime, provider, model };
    }
    const out = await this.#exec(() =>
      run_claim(this.#service, this.#ctx(project, auth, key, base), payload),
    );
    return { status: 200, data: this.#normalize_run_result(out.result), replayed: out.replayed };
  }

  async #wait(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["lease_id", "fence", "reason", "wait_ms"]);
    const run_id = request.params[1] as string;
    const lease_id = require_text(body, "lease_id");
    const fence = parse_fence(body.fence);
    let wait_ms: number | undefined;
    if (Object.hasOwn(body, "wait_ms")) {
      const value = body.wait_ms;
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > MAX_WAIT_MS
      ) {
        invalid_field("wait_ms");
      }
      wait_ms = value;
    }
    const reason = optional_text(body, "reason");
    this.#require_go_for_run(project.id, run_id);

    const payload: Record<string, unknown> = { run_id, lease_id, fence };
    if (reason !== undefined) payload.reason = reason;
    const out = await this.#exec(() =>
      run_wait(this.#service, this.#ctx(project, auth, key), payload),
    );
    const data = this.#normalize_run_result(out.result);
    if (!out.replayed && wait_ms !== undefined && wait_ms > 0) await this.#sleep(wait_ms);
    return { status: 200, data, replayed: out.replayed };
  }

  async #results(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["run_id", "lease_id", "fence", "results", "expected_control_rev"]);
    const run_id = request.params[1] as string;
    if (Object.hasOwn(body, "run_id") && body.run_id !== run_id) invalid_field("run_id");
    const lease_id = require_text(body, "lease_id");
    const fence = parse_fence(body.fence);
    // Payload shape (including the non-empty list) wins over a stale rev.
    if (!Array.isArray(body.results) || body.results.length < 1 || body.results.length > MAX_RESULTS_PER_BATCH) {
      invalid_field("results");
    }
    const base = Object.hasOwn(body, "expected_control_rev")
      ? parse_decimal(body.expected_control_rev, "$.body.expected_control_rev")
      : undefined;
    this.#require_go_for_run(project.id, run_id);

    const out = await this.#exec(() =>
      submit_results(this.#service, this.#ctx(project, auth, key, base), {
        run_id,
        lease_id,
        fence,
        results: body.results,
      }),
    );
    return { status: 200, data: out.result, replayed: out.replayed };
  }

  async #complete(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["lease_id", "fence", "status"]);
    const run_id = request.params[1] as string;
    const lease_id = require_text(body, "lease_id");
    const fence = parse_fence(body.fence);
    const payload: Record<string, unknown> = { run_id, lease_id, fence };
    if (Object.hasOwn(body, "status")) {
      const status = body.status;
      if (status !== "succeeded" && status !== "failed") invalid_field("status");
      payload.status = status;
    }
    this.#require_go_for_run(project.id, run_id);
    const out = await this.#exec(() =>
      run_complete(this.#service, this.#ctx(project, auth, key), payload),
    );
    return { status: 200, data: this.#normalize_run_result(out.result), replayed: out.replayed };
  }

  // -------------------------------------------------------------------------
  // runs (PR14): heartbeat, release, handoffs, interrupt, cancel, inputs, receipts

  async #heartbeat(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["lease_id", "fence", "progress"]);
    const run_id = request.params[1] as string;
    const lease_id = require_text(body, "lease_id");
    const fence = parse_fence(body.fence);
    if (Object.hasOwn(body, "progress")) {
      const progress = body.progress;
      if (!is_record(progress)) invalid_field("progress");
      for (const field of Object.keys(progress)) {
        if (field !== "phase" && field !== "observed_at") invalid(`$.body.progress.${field}`);
      }
      if (typeof progress.phase !== "string" || progress.phase.length === 0) invalid("$.body.progress.phase");
      if (
        progress.observed_at !== undefined &&
        (typeof progress.observed_at !== "number" || !Number.isSafeInteger(progress.observed_at) || progress.observed_at < 0)
      ) {
        invalid("$.body.progress.observed_at");
      }
    }
    if (run_info(this.#db, project.id, run_id) === undefined) throw new Fail("not_found");
    const out = await this.#exec(
      () =>
        run_heartbeat(this.#service, this.#ctx(project, auth, key), {
          run_id,
          lease_id,
          fence,
          ...(Object.hasOwn(body, "progress") ? { progress: body.progress } : {}),
        }),
      (error) => {
        const failure = fail_from(error);
        return failure.code === "conflict" ? this.#lease_lost(project.id, String(body.fence), auth) : failure;
      },
    );
    const result = result_record(out.result);
    return {
      status: 200,
      data: {
        run_id,
        lease: {
          lease_id,
          fence: String(result.fence ?? fence),
          expires_at: Number(result.expires_at),
        },
        server_time: this.#now(),
        // the stored note, so a replay and the event agree with what was saved
        ...(is_record(result.progress) ? { progress: result.progress } : {}),
      },
      replayed: out.replayed,
    };
  }

  async #release(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["lease_id", "fence"]);
    const run_id = request.params[1] as string;
    const lease_id = require_text(body, "lease_id");
    const fence = parse_fence(body.fence);
    if (run_info(this.#db, project.id, run_id) === undefined) throw new Fail("not_found");
    const out = await this.#exec(
      () => run_release(this.#service, this.#ctx(project, auth, key), { run_id, lease_id, fence }),
      (error) => {
        const failure = fail_from(error);
        return failure.code === "conflict" ? this.#lease_lost(project.id, String(body.fence), auth) : failure;
      },
    );
    return { status: 200, data: { run_id, status: result_record(out.result).status }, replayed: out.replayed };
  }

  /** The owner, or the actor the run belongs to; anyone else is refused. */
  #own_run_or_owner(project: ProjectRow, auth: AuthInfo, run_id: string) {
    const run = run_info(this.#db, project.id, run_id);
    if (run === undefined) throw new Fail("not_found");
    if (!auth.session && run.actor_id !== auth.actor_id) {
      throw new Fail("forbidden", {
        target: "$.path.run_id",
        next_action: "use_owner_session",
        details: { allowed: "own_run_or_owner", actor_kind: auth.kind },
      });
    }
    return run;
  }

  #operation_location(project: ProjectRow, receipt: ReceiptRow | undefined): { operation_id: string; headers: Record<string, string> } {
    if (receipt === undefined) throw new Error("the accepted command left no receipt");
    return {
      operation_id: receipt.id,
      headers: { location: `/api/v1/projects/${project.id}/operations/${receipt.id}` },
    };
  }

  /**
   * The receipt this request replays, if any. A key already spent on another command, or on the same command
   * for another run, is not a replay: 409 idempotency_key_reuse, before anything is written. That holds across
   * actors too: a key another actor of this project already spent (say on another run, which the owner or the
   * next holder now targets) is a reuse, never a fresh request.
   */
  #lease_replay(project: ProjectRow, auth: AuthInfo, key: string | null, action: string, run_id: string): ReceiptRow | undefined {
    if (key === null) return undefined;
    const prior = receipt_of_request(this.#db, project.id, auth.actor_id, key);
    if (prior === undefined) {
      const elsewhere = this.#db.get<{ id: string }>(
        `SELECT id FROM mutation_commits WHERE project_id = ? AND client_request_id = ? LIMIT 1`,
        project.id,
        key,
      );
      if (elsewhere !== undefined) throw new Fail("idempotency_key_reuse", { target: "$.headers.idempotency-key" });
      return undefined;
    }
    let target: unknown = null;
    try {
      const result: unknown = JSON.parse(prior.result_json);
      if (is_record(result)) target = result.run_id;
    } catch {
      target = null;
    }
    if (prior.action !== action || target !== run_id || prior.lease_id === null || prior.fence === null) {
      throw new Fail("idempotency_key_reuse", { target: "$.headers.idempotency-key" });
    }
    return prior;
  }

  async #handoffs(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const run_id = request.params[1] as string;
    const run = run_info(this.#db, project.id, run_id);
    if (run === undefined) throw new Fail("not_found");
    const lease = this.#live_lease_of_run(project.id, run_id);
    const holder = auth.session || (lease !== undefined && lease.owner_actor_id === auth.actor_id);
    let replaying = false;
    if (!holder && request.key !== null) {
      // A stranger's foreign key is just forbidden; only a true replay of its own handoff passes.
      try {
        replaying = this.#lease_replay(project, auth, request.key, "run.handed_off", run_id) !== undefined;
      } catch {
        replaying = false;
      }
    }
    if (!replaying && !holder) {
      throw new Fail("forbidden", {
        target: "$.path.run_id",
        next_action: "use_current_holder",
        details: { allowed: "current_lease_holder_or_owner", actor_id: auth.actor_id },
      });
    }
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["target_mode", "target_actor_id", "reason", "include_pending_inputs"]);
    const target_mode = body.target_mode === undefined || body.target_mode === null ? undefined : require_mode(body, "target_mode");
    const target_actor_id = optional_text(body, "target_actor_id");
    const reason = optional_text(body, "reason");
    if (body.include_pending_inputs !== undefined && typeof body.include_pending_inputs !== "boolean") {
      invalid_field("include_pending_inputs");
    }
    // A handoff gives the SAME run back to the queue: its actor and mode do not change, so a target that
    // names another actor or mode could never take effect and is refused rather than answered with a false 200.
    if (target_actor_id !== undefined && target_actor_id !== run.actor_id) invalid_field("target_actor_id");
    if (target_mode !== undefined && target_mode !== run.mode) invalid_field("target_mode");
    const prior = this.#lease_replay(project, auth, key, "run.handed_off", run_id);
    const guard = prior ?? lease;
    if (guard === undefined || guard.lease_id === null || guard.fence === null) throw new Fail("conflict");
    const fence_value = guard.fence;
    const payload: Record<string, unknown> = {
      run_id,
      lease_id: guard.lease_id,
      fence: Number(fence_value),
    };
    if (target_mode !== undefined) payload.target_mode = target_mode;
    if (target_actor_id !== undefined) payload.target_actor_id = target_actor_id;
    if (reason !== undefined) payload.reason = reason;
    if (body.include_pending_inputs !== undefined) payload.include_pending_inputs = body.include_pending_inputs;
    const out = await this.#exec(() =>
      run_handoff(this.#service, this.#ctx(project, auth, key), payload),
    );
    return {
      status: 200,
      data: {
        run_id,
        status: "queued",
        lease: { released: true, fence: String(fence_value) },
        pending_input_count: pending_input_count(this.#db, project.id, run_id, run.actor_id),
        target_mode: target_mode ?? run.mode,
        target_actor_id: target_actor_id ?? null,
      },
      replayed: out.replayed,
    };
  }

  async #interrupt(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const run_id = request.params[1] as string;
    const run = this.#own_run_or_owner(project, auth, run_id);
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["reason", "mode"]);
    const reason = optional_text(body, "reason");
    if (body.mode !== undefined && body.mode !== "graceful") invalid_field("mode");
    const prior = this.#lease_replay(project, auth, key, "run.interrupted", run_id);
    const lease = this.#live_lease_of_run(project.id, run_id);
    if (prior === undefined && TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new Fail("run_terminal", {
        target: "$.path.run_id",
        details: { run_id, status: run.status },
      });
    }
    // A replay names the lease the first request used, so the stored receipt matches.
    const guard = prior ?? lease;
    if (guard === undefined || guard.lease_id === null || guard.fence === null) throw new Fail("conflict");
    const payload: Record<string, unknown> = {
      run_id,
      lease_id: guard.lease_id,
      fence: Number(guard.fence),
    };
    if (reason !== undefined) payload.reason = reason;
    const out = await this.#exec(() =>
      run_interrupt(this.#service, this.#ctx(project, auth, key), payload),
    );
    const accepted = this.#operation_location(project, receipt_of_request(this.#db, project.id, auth.actor_id, key));
    return {
      status: 202,
      data: { operation_id: accepted.operation_id, run_id, state: "pending", accepted: true },
      replayed: out.replayed,
      headers: accepted.headers,
    };
  }

  async #cancel(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const run_id = request.params[1] as string;
    this.#own_run_or_owner(project, auth, run_id);
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["reason", "confirm"]);
    const reason = optional_text(body, "reason");
    if (body.confirm !== true) invalid_field("confirm");
    const payload: Record<string, unknown> = { run_id };
    if (reason !== undefined) payload.reason = reason;
    const out = await this.#exec(
      () => run_cancel(this.#service, this.#ctx(project, auth, key), payload),
      (error) => targeted(error, { run_terminal: "$.path.run_id" }),
    );
    const accepted = this.#operation_location(project, receipt_of_request(this.#db, project.id, auth.actor_id, key));
    return {
      status: 202,
      data: {
        operation_id: accepted.operation_id,
        run_id,
        state: "cancel_requested",
        db_adoption_blocked: true,
        external_cancel_state: "pending",
      },
      replayed: out.replayed,
      headers: accepted.headers,
    };
  }

  async #inputs(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const run_id = request.params[1] as string;
    const wait_ms = this.#query_limit(request, "wait_ms", 0, MAX_WAIT_MS, 0);
    const limit = this.#query_limit(request, "limit", 1, LIST_MAX_ITEMS, LIST_MAX_ITEMS);
    const scope = `run:${run_id}:${auth.actor_id}`;
    const given = request.query.has("cursor") ? read_cursor(this.#secret, request.query.get("cursor") as string) : undefined;
    const op = this.#table.find((spec) => spec.operation === "runs.inputs")?.op as Op;
    /**
     * One short read transaction per look at the inputs. Inside it the caller is checked again (token, actor,
     * membership, scope), the run must still be the caller's, a mode A run (a Go destination) needs Go ON
     * whoever calls, and the cursor is checked against the database metadata of that same boundary. So a
     * credential revoked or a Go policy turned OFF while the request waited ends that request like a new one.
     */
    const at_boundary = (read_page: boolean) =>
      read_tx(this.#db, () => {
        const current = this.#project(project.id);
        const now_auth = this.#bind(current, this.#credential(request, current.id), op);
        if (now_auth.actor_id !== auth.actor_id) throw new Fail("unauthenticated");
        if (now_auth.kind === "internal_ai") this.#require_go(current.id);
        const run = run_info(this.#db, current.id, run_id);
        if (run === undefined) throw new Fail("not_found");
        if (run.actor_id !== now_auth.actor_id) {
          throw new Fail("forbidden", { target: "$.path.run_id", details: { actor_kind: now_auth.kind } });
        }
        if (run.mode === "A") this.#require_go(current.id);
        const meta = db_meta(this.#db);
        let after = 0n;
        if (given !== undefined) {
          if (given === null || given.p !== current.id || given.s !== scope || given.d !== meta.database_instance_id) {
            throw new Fail("cursor_invalid", { target: "$.query.cursor" });
          }
          if (given.e !== meta.cursor_epoch) {
            throw new Fail("cursor_invalid", {
              target: "$.query.cursor",
              details: { reason: "epoch_changed", current_epoch: meta.cursor_epoch },
            });
          }
          after = BigInt(given.q);
        }
        const page = read_page
          ? inputs_page(this.#db, current.id, run_id, run.actor_id, after, limit)
          : { items: [], has_more: false };
        return { meta, after, page };
      });

    // The caller, run, Go policy and cursor are checked before the poll budget is spent.
    at_boundary(false);
    const poll_key = `${auth.token_id}:${run_id}`;
    const wait = this.#budgets.poll_wait(poll_key, MIN_POLL_INTERVAL_MS, this.#now());
    if (wait !== null) this.#rate_limited(wait, "poll");

    let seen = at_boundary(true);
    if (seen.page.items.length === 0 && wait_ms > 0) {
      // No transaction is open while the request waits.
      await this.#sleep(wait_ms);
      seen = at_boundary(true);
    }
    const { meta, after, page } = seen;
    if (page.items.length === 0) this.#budgets.mark_empty_poll(poll_key, this.#now());
    else this.#budgets.clear_poll(poll_key);
    const last = page.items.length === 0 ? after : page.items[page.items.length - 1]!.pos;
    return {
      status: 200,
      data: {
        inputs: page.items.map((item) => ({
          input_version_id: item.input_version_id,
          object_id: item.object_id,
          kind: "answer",
          question_id: item.question_id,
          available_at: item.available_at,
          state: item.state,
        })),
        next_cursor: make_cursor(this.#secret, {
          p: project.id,
          s: scope,
          d: meta.database_instance_id,
          e: meta.cursor_epoch,
          q: last.toString(),
        }),
        has_more: page.has_more,
        epoch: meta.cursor_epoch,
      },
    };
  }

  async #input_receipts(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const run_id = request.params[1] as string;
    const run = run_info(this.#db, project.id, run_id);
    if (run === undefined) throw new Fail("not_found");
    if (run.actor_id !== auth.actor_id) {
      throw new Fail("forbidden", { target: "$.path.run_id", details: { actor_kind: auth.kind } });
    }
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["lease_id", "fence", "receipts"]);
    const lease_id = require_text(body, "lease_id");
    const fence = parse_fence(body.fence);
    const list = body.receipts;
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_RESULTS_PER_BATCH) {
      invalid_field("receipts");
    }
    const receipts = list.map((entry, i) => {
      const at = `$.body.receipts[${i}]`;
      if (!is_record(entry)) invalid(at);
      for (const field of Object.keys(entry)) {
        if (!["input_version_id", "state", "reason", "applied_tx_id"].includes(field)) invalid(`${at}.${field}`);
      }
      const input_version_id = require_text(entry, "input_version_id", at);
      if (entry.state !== "seen" && entry.state !== "applied" && entry.state !== "ignored") {
        invalid(`${at}.state`);
      }
      const item: Record<string, unknown> = { input_version_id, state: entry.state };
      if (entry.reason !== undefined && entry.reason !== null) item.reason = require_text(entry, "reason", at);
      if (entry.state === "applied") item.applied_tx_id = require_text(entry, "applied_tx_id", at);
      return item;
    });
    receipts.forEach((item, i) => {
      if (!input_visible(this.#db, project.id, run.actor_id, item.input_version_id as string)) {
        throw new Fail("input_not_visible", {
          target: `$.body.receipts[${i}].input_version_id`,
          details: { run_id, reason: "not_in_run_targets" },
        });
      }
    });
    const out = await this.#exec(
      () =>
        run_record_receipt(this.#service, this.#ctx(project, auth, key), {
          run_id,
          lease_id,
          fence,
          receipts,
        }),
      (error) => {
        const failure = fail_from(error);
        return failure.code === "conflict" ? this.#lease_lost(project.id, String(body.fence), auth) : failure;
      },
    );
    const accepted = (result_record(out.result).accepted as Array<Record<string, unknown>>) ?? [];
    return {
      status: 200,
      data: {
        accepted: accepted.map((item) => ({ input_version_id: item.input_version_id, state: item.state })),
      },
      replayed: out.replayed,
    };
  }

  // -------------------------------------------------------------------------
  // operation and request lookups (the mutation receipt is the durable record)

  async #operation_get(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const row = operation_receipt(this.#db, project.id, request.params[1] as string);
    if (row === undefined || (!auth.session && row.actor_id !== auth.actor_id)) throw new Fail("not_found");
    const result = JSON.parse(row.result_json) as Record<string, unknown>;
    const cancelled = row.action === "run.cancelled";
    return {
      status: 200,
      data: {
        operation_id: row.id,
        run_id: result.run_id,
        action: cancelled ? "run.cancel" : "run.interrupt",
        state: cancelled ? "cancel_requested" : "pending",
        accepted_at: Number(row.created_at),
      },
    };
  }

  async #request_get(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    let key: string;
    try {
      key = decodeURIComponent(request.params[1] as string);
    } catch {
      throw new Fail("not_found");
    }
    // Keys belong to (actor, key): the owner's own receipt comes first, any other receipt only when there is none.
    const row =
      request_receipt(this.#db, project.id, key, auth.actor_id) ??
      (auth.session ? request_receipt(this.#db, project.id, key, null) : undefined);
    if (row === undefined) throw new Fail("not_found");
    const result = JSON.parse(row.result_json) as Record<string, unknown>;
    const status = ACCEPTED_ACTIONS.has(row.action)
      ? 202
      : CREATED_ACTIONS.has(row.action) || (row.action === "file.upload_reserved" && result.deduplicated !== true)
        ? 201
        : 200;
    return {
      status: 200,
      data: {
        key: row.client_request_id,
        state: "completed",
        action: COMMAND_OF_ACTION.get(row.action) ?? row.action,
        status,
        operation_id: ACCEPTED_ACTIONS.has(row.action) ? row.id : null,
        tx_id: row.id,
        run_id: row.run_id,
      },
    };
  }

  // -------------------------------------------------------------------------
  // questions and answers

  /** POST P/prompt-builds — the prompt of one question about one exact version. A read: nothing is written, no key is needed. */
  async #prompt_build(request: RouteRequest, project: ProjectRow): Promise<HandlerResult> {
    const body = this.#json_body(request);
    reject_unknown(body, ["question", "selection", "drafts", "target"]);
    const piece = (value: unknown, target: string): string => {
      if (typeof value !== "string" || !value.isWellFormed() || value.length > PROMPT_MAX_CHARS) invalid(target);
      return value;
    };
    const question = require_text(body, "question");
    piece(question, "$.body.question");
    const selection = body.selection;
    if (!is_record(selection)) invalid_field("selection");
    for (const key of Object.keys(selection)) {
      if (key !== "version_id" && key !== "quote") invalid(`$.body.selection.${key}`);
    }
    const version_id = require_text(selection, "version_id", "$.body.selection");
    const quote =
      selection.quote === undefined || selection.quote === null || selection.quote === ""
        ? null
        : piece(selection.quote, "$.body.selection.quote");
    const drafts: string[] = [];
    if (body.drafts !== undefined && body.drafts !== null) {
      const list = body.drafts;
      if (!Array.isArray(list) || list.length > PROMPT_MAX_DRAFTS) invalid_field("drafts");
      list.forEach((entry, i) => {
        const at = `$.body.drafts[${i}]`;
        if (!is_record(entry)) invalid(at);
        for (const key of Object.keys(entry)) if (key !== "text") invalid(`${at}.${key}`);
        drafts.push(piece(entry.text, `${at}.text`));
      });
    }
    let target: PromptTarget = "B";
    if (body.target !== undefined) {
      if (body.target !== "A" && body.target !== "B") invalid_field("target");
      target = body.target;
    }
    const literals: RedactLiterals = {
      secrets: [this.#secret],
      paths: [
        homedir(),
        tmpdir(),
        process.env.HOME ?? "",
        process.env.USERPROFILE ?? "",
        process.env.PES_HOME ?? "",
        this.#objects_dir,
        dirname(this.#objects_dir),
      ],
    };
    try {
      literals.paths = [...literals.paths, realpathSync(tmpdir())];
    } catch {
      // the folder name stays as the plain one
    }
    const built = read_tx(this.#db, () =>
      build_prompt(
        this.#db,
        {
          slug: this.#project(project.id).slug,
          project_id: project.id,
          literals,
          content_of: (kind, id) => this.#version_content(project.id, kind, id),
        },
        { question, version_id, quote, drafts, target },
      ),
    );
    if (built === null) throw new Fail("not_found", { target: "$.body.selection.version_id" });
    return { status: 200, data: built };
  }

  /** GET P/question-statuses[?question_id=] — what is known of each human -> AI question (accepted / received / read / answered). */
  async #question_statuses(request: RouteRequest, project: ProjectRow): Promise<HandlerResult> {
    const only = request.query.get("question_id");
    if (only !== null && only.length === 0) invalid("$.query.question_id");
    const items = read_tx(this.#db, () => question_statuses(this.#db, project.id, this.#now(), only));
    if (items === null) throw new Fail("not_found", { target: "$.query.question_id" });
    return { status: 200, data: { items } };
  }

  async #question_publish(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(
      body,
      ["stage_id", "round_id", "purpose", "question", "direction", "intended_actor_id", "form_key", "run_id", "lease_id", "fence"]);
    const stage_id = require_text(body, "stage_id");
    const round_id = optional_text(body, "round_id") ?? null;
    if (typeof body.purpose !== "string" || !QUESTION_PURPOSES.includes(body.purpose)) invalid_field("purpose");
    // A question is agent_to_human (asked by the caller, no intended actor) unless the owner session files it for an
    // AI (SEL-118 U5a: human_to_agent + intended_actor_id). A token never files one; filing only records the question
    // (no run, no waiting_human), and it stays out of the human's form: its own form_key unless the caller names one.
    if (body.direction !== undefined && body.direction !== "agent_to_human" && body.direction !== "human_to_agent") invalid_field("direction");
    const human_to_agent = body.direction === "human_to_agent";
    if (human_to_agent && !auth.session) throw new Fail("human_required");
    if (human_to_agent) {
      // a human_to_agent question without the AI it is for is refused as a whole (the direction is what cannot stand alone)
      if (typeof body.intended_actor_id !== "string" || body.intended_actor_id.length === 0) invalid_field("direction");
    } else if (body.intended_actor_id !== undefined && body.intended_actor_id !== null) {
      invalid_field("intended_actor_id");
    }
    const form_key = body.form_key === undefined ? (human_to_agent ? ASK_AI_FORM_KEY : "main") : require_text(body, "form_key");
    const guard = this.#guard_fields(body);
    const question = check_question(body.question, false);
    // SEL-90: adding a question to a form keeps the form's earlier open questions, in order, and puts the new one
    // last (the new set is a new version of the whole form). The core does it (extend_latest); a form with no set
    // yet starts with this question alone.
    const payload: Record<string, unknown> = {
      stage_id,
      round_id,
      purpose: body.purpose,
      form_key,
      questions: [question],
      extend_latest: true,
    };
    if (human_to_agent) {
      payload.direction = "human_to_agent";
      payload.intended_actor_id = body.intended_actor_id;
    }
    if (guard !== null && !auth.session) Object.assign(payload, guard);
    const out = await this.#exec(() => publish_set(this.#service, this.#ctx(project, auth, key), payload));
    const result = result_record(out.result);
    const members = result.members as Array<Record<string, unknown>>;
    const member = members[members.length - 1] as Record<string, unknown>;
    return {
      status: 201,
      data: {
        question_set_id: result.set_id,
        question: {
          id: member.question_id,
          version_id: member.question_version_id,
          version_no: "1",
          state: "open",
          asked_by_actor_id: auth.actor_id,
          intended_actor_id: human_to_agent ? (body.intended_actor_id as string) : null,
        },
      },
      replayed: out.replayed,
    };
  }

  async #question_revise(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["base_version_id", "question", "run_id", "lease_id", "fence"]);
    const base_version_id = require_text(body, "base_version_id");
    const guard = this.#guard_fields(body);
    const question = check_question(body.question, true);
    const question_id = request.params[1] as string;
    const payload: Record<string, unknown> = { question_id, base_version_id, ...question };
    if (guard !== null && !auth.session) Object.assign(payload, guard);
    const out = await this.#exec(
      () => revise_question(this.#service, this.#ctx(project, auth, key), payload),
      (error) => targeted(error, { rev_conflict: "$.body.base_version_id" }, { rev_conflict: "reread_question" }),
    );
    const result = result_record(out.result);
    const version_id = result.question_version_id as string;
    return {
      status: 201,
      data: {
        question: {
          id: question_id,
          version_id,
          version_no: String(result.version_no),
          state: question_state(this.#db, project.id, version_id) ?? "open",
        },
        recheck_required: true,
        previous_answers_preserved: true,
      },
      replayed: out.replayed,
    };
  }

  async #submissions(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["set_id", "answers", "mode", "submitted_via", "client_request_id"]);
    const set_id = require_text(body, "set_id");
    if (body.mode !== undefined && body.mode !== "bundle" && body.mode !== "single") invalid_field("mode");
    const answers = body.answers;
    if (!Array.isArray(answers) || answers.length < 1) invalid_field("answers");
    const items = answers.map((entry, i) => {
      const at = `$.body.answers[${i}]`;
      if (!is_record(entry)) invalid(at);
      for (const field of Object.keys(entry)) {
        if (!["question_id", "question_version_id", "value", "comment", "used_default"].includes(field)) {
          invalid(`${at}.${field}`);
        }
      }
      const item: Record<string, unknown> = { question_id: require_text(entry, "question_id", at) };
      if (entry.question_version_id !== undefined) item.question_version_id = require_text(entry, "question_version_id", at);
      if (entry.value !== undefined) item.value = entry.value;
      if (entry.comment !== undefined && entry.comment !== null) {
        if (typeof entry.comment !== "string") invalid(`${at}.comment`);
        item.other = entry.comment;
      }
      if (entry.used_default !== undefined) {
        if (typeof entry.used_default !== "boolean") invalid(`${at}.used_default`);
        item.used_default = entry.used_default;
      }
      return item;
    });
    const index_of = (question_id: unknown): number =>
      Math.max(0, items.findIndex((item) => item.question_id === question_id));
    const out = await this.#exec(
      () =>
        submit_answers(this.#service, this.#ctx(project, auth, key), {
          set_id,
          answers: items,
          ...(body.mode === undefined ? {} : { mode: body.mode }),
        }),
      (error) => {
        const failure = fail_from(error);
        const question_id = failure.details?.question_id;
        if (failure.code === "question_version_changed") {
          const { reason: _reason, ...details } = failure.details ?? {};
          return new Fail(failure.code, {
            target: `$.body.answers[${index_of(question_id)}].question_version_id`,
            details,
          });
        }
        if (failure.code === "validation_failed") {
          const reason = failure.details?.reason;
          // a rule about the whole bundle points at the list; one about a single item points at that item
          if (reason === "required_missing" || reason === "single_requires_one_item") {
            return new Fail(failure.code, { target: "$.body.answers", details: failure.details });
          }
          if (reason === "not_applicable") {
            return new Fail(failure.code, { target: `$.body.answers[${index_of(question_id)}]`, details: failure.details });
          }
          return new Fail(failure.code, {
            target: `$.body.answers[${index_of(question_id)}].${String(failure.details?.field ?? "value")}`,
            details: failure.details,
          });
        }
        return failure;
      },
    );
    const result = result_record(out.result);
    const submission_id = result.submission_id as string;
    const entries = (result.answers as Array<Record<string, unknown>>) ?? [];
    return {
      status: 201,
      data: {
        submission: {
          id: submission_id,
          received_at: submission_received_at(this.#db, project.id, submission_id) ?? 0,
          state: "accepted",
        },
        answers: entries.map((entry) => ({
          question_id: entry.question_id,
          answer_version_id: entry.version_id,
          state: entry.version_id === null ? "comment_only" : "submitted",
        })),
        form_complete: result.form_complete === true,
        missing_required: Array.isArray(result.missing_required) ? result.missing_required : [],
      },
      replayed: out.replayed,
    };
  }

  /** SEL-90: POST P/questions/{q}/withdraw | defer | merge — a new question version in state withdrawn | deferred | merged. */
  async #question_state(
    request: RouteRequest,
    project: ProjectRow,
    auth: AuthInfo,
    kind: "withdraw" | "defer" | "merge",
  ): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(
      body,
      [
        "base_version_id",
        "reason",
        ...(kind === "defer" ? ["defer_until"] : []),
        ...(kind === "merge" ? ["merged_into_question_id"] : []),
        "run_id",
        "lease_id",
        "fence",
      ]);
    const question_id = request.params[1] as string;
    const payload: Record<string, unknown> = { question_id };
    const base_version_id = optional_text(body, "base_version_id");
    if (base_version_id !== undefined) payload.base_version_id = base_version_id;
    if (body.reason !== undefined && body.reason !== null) {
      if (typeof body.reason !== "string" || !body.reason.isWellFormed()) invalid_field("reason");
      payload.reason = body.reason;
    }
    if (kind === "defer" && body.defer_until !== undefined && body.defer_until !== null) {
      // a time in ms: a JSON integer or (like the other large numbers of this API) a decimal string
      const text = typeof body.defer_until === "number" ? decimal_text(body.defer_until) : parse_decimal(body.defer_until, "$.body.defer_until");
      const until = text === null ? Number.NaN : Number(text);
      if (!Number.isSafeInteger(until)) invalid_field("defer_until");
      payload.defer_until = until;
    }
    if (kind === "merge") payload.merged_into_question_id = require_text(body, "merged_into_question_id");
    const guard = this.#guard_fields(body);
    if (guard !== null && !auth.session) Object.assign(payload, guard);
    const out = await this.#exec(
      () => this.#service.execute(this.#ctx(project, auth, key), `question.${kind}`, payload),
      (error) => {
        const failure = targeted(error, { rev_conflict: "$.body.base_version_id" }, { rev_conflict: "reread_question" });
        if (failure.code === "validation_failed" && typeof failure.details?.field === "string") {
          return new Fail(failure.code, { target: `$.body.${failure.details.field}`, details: failure.details });
        }
        return failure;
      },
    );
    const result = result_record(out.result);
    const question: Record<string, unknown> = {
      id: question_id,
      version_id: result.question_version_id,
      version_no: String(result.version_no),
      state: result.state,
    };
    if (kind === "merge") question.merged_into_question_id = result.merged_into_question_id;
    return {
      status: 201,
      data: { question, previous_answers_preserved: true },
      replayed: out.replayed,
    };
  }

  // -------------------------------------------------------------------------
  // SEL-93 U3a: assumptions, decisions, reflections

  /** The active edition id of a project row (the records routes read and write that edition). */
  #edition_of(project: ProjectRow): string {
    const current = this.#project(project.id);
    if (current.active_edition_id === null) throw new ApiError("conflict", "the project has no active edition");
    return current.active_edition_id;
  }

  /** A required text of a record body: a string (else 400), not blank (else 422 with the documented reason). */
  #record_text(body: Record<string, unknown>, field: string): string {
    const value = body[field];
    if (typeof value !== "string" || !value.isWellFormed()) invalid_field(field);
    if (value.trim().length === 0) validation(`$.body.${field}`, { reason: "empty", min_length: 1 });
    return value;
  }

  /** An optional text of a record body: absent or null reads as none; a string may be blank. */
  #optional_record_text(body: Record<string, unknown>, field: string): string | undefined {
    const value = body[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || !value.isWellFormed()) invalid_field(field);
    return value;
  }

  /** A text that a state needs (the reason of a judgement): absent or blank is a content problem (422). */
  #needed_text(body: Record<string, unknown>, field: string, why: string): string {
    const value = body[field];
    if (value === undefined || value === null) validation(`$.body.${field}`, { reason: why });
    if (typeof value !== "string" || !value.isWellFormed()) invalid_field(field);
    if (value.trim().length === 0) validation(`$.body.${field}`, { reason: why });
    return value;
  }

  #needed_id(body: Record<string, unknown>, field: string): string {
    const value = body[field];
    if (value === undefined || value === null) validation(`$.body.${field}`, { reason: "required" });
    if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()) invalid_field(field);
    return value;
  }

  /** The reasons a core refusal carries (reason, index, field) become the documented API error. */
  #record_failure(error: unknown, fields: Record<string, string> = {}): Fail {
    if (error instanceof ApiError) {
      const info = is_record(error.details) ? error.details : {};
      const index = typeof info.index === "number" ? info.index : null;
      const field = typeof info.field === "string" ? info.field : null;
      const at = (name: string): string => (index === null ? `$.body.${name}` : `$.body.entries[${index}].${name}`);
      if (error.code === "invalid_payload" && info.reason === "evidence_required") {
        return new Fail("evidence_required", {
          target: at("result_version_id"),
          details: { disposition: String(info.disposition ?? ""), required: "result_version_id or evidence_tx_id" },
          next_action: "add_evidence",
        });
      }
      if (error.code === "invalid_payload" && info.reason === "evidence_not_allowed") {
        return new Fail("validation_failed", { target: at(field ?? "result_version_id"), details: { reason: "evidence_not_allowed" } });
      }
      if (error.code === "conflict" && info.reason === "evidence_mismatch") {
        return new Fail("validation_failed", { target: at(field ?? "evidence_tx_id"), details: { reason: "evidence_mismatch" } });
      }
      if (error.code === "not_found" && field !== null) {
        return new Fail("not_found", { target: fields[field] ?? at(field) });
      }
      if (error.code === "rev_conflict") return new Fail("rev_conflict", { target: "$.body.base_version_id", next_action: "reread_context" });
      if (error.code === "conflict" && info.reason === "edition_not_active") {
        return new Fail("conflict", { target: "$.body.scope", details: { reason: "edition_not_active" }, next_action: "reread_decisions" });
      }
    }
    return fail_from(error);
  }

  /** POST P/assumptions — state "proposed" proposes (session or token); confirmed / rejected / revised judge (the owner session only). */
  async #assumption_write(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["statement", "state", "rationale", "scope", "assumption_id", "base_version_id"]);
    const state = body.state;
    if (typeof state !== "string" || !["proposed", "confirmed", "rejected", "revised"].includes(state)) validation("$.body.state");
    if (body.scope !== undefined && body.scope !== null && body.scope !== "edition" && body.scope !== "project") validation("$.body.scope");
    if (state !== "proposed" && !auth.session) throw new Fail("human_required");
    if (state === "proposed") {
      if (body.assumption_id !== undefined) invalid_field("assumption_id");
      if (body.base_version_id !== undefined) invalid_field("base_version_id");
      const statement = this.#record_text(body, "statement");
      const rationale = this.#optional_record_text(body, "rationale");
      const out = await this.#exec(
        () => this.#service.execute(this.#ctx(project, auth, key), "assumption.propose", { statement, ...(rationale === undefined ? {} : { rationale }) }),
        (error) => this.#record_failure(error),
      );
      const result = result_record(out.result);
      return {
        status: 201,
        data: { assumption: { id: result.object_id, version_id: result.version_id, state: result.state, needs_review: true, assessed_by_actor_id: null } },
        replayed: out.replayed,
      };
    }
    const assumption_id = this.#needed_id(body, "assumption_id");
    const base_version_id = this.#needed_id(body, "base_version_id");
    const payload: Record<string, unknown> = { assumption_id, base_version_id, state };
    if (state === "revised") {
      payload.statement = this.#needed_text(body, "statement", "required");
      payload.rationale = this.#needed_text(body, "rationale", "required");
    } else {
      if (body.statement !== undefined && body.statement !== null) validation("$.body.statement", { reason: "revised_only" });
      if (state === "rejected") payload.rationale = this.#needed_text(body, "rationale", "required");
      else {
        const rationale = this.#optional_record_text(body, "rationale");
        if (rationale !== undefined) payload.rationale = rationale;
      }
    }
    const out = await this.#exec(
      () => this.#service.execute(this.#ctx(project, auth, key), "assumption.assess", payload),
      (error) => this.#record_failure(error, { assumption_id: "$.body.assumption_id" }),
    );
    const result = result_record(out.result);
    return {
      status: 201,
      data: {
        assumption: {
          id: result.assumption_id,
          version_id: result.version_id,
          state: result.state,
          needs_review: false,
          assessed_by_actor_id: result.assessment_actor_id,
        },
      },
      replayed: out.replayed,
    };
  }

  /** The state of a decision's current version, or undefined when it is not a decision of this project. */
  #decision_state(project_id: string, decision_id: string): string | undefined {
    return this.#db.get<{ state: string }>(
      `SELECT v.state AS state FROM objects o
         JOIN decision_versions v ON v.project_id = o.project_id AND v.version_id = o.current_version_id
        WHERE o.project_id = ? AND o.id = ? AND o.kind = 'decision'`,
      project_id,
      decision_id,
    )?.state;
  }

  /** The sentence of a decision's current version, or undefined when it is not a decision of this project. */
  #decision_statement(project_id: string, decision_id: string): string | undefined {
    return this.#db.get<{ statement: string }>(
      `SELECT v.statement AS statement FROM objects o
         JOIN decision_versions v ON v.project_id = o.project_id AND v.version_id = o.current_version_id
        WHERE o.project_id = ? AND o.id = ? AND o.kind = 'decision'`,
      project_id,
      decision_id,
    )?.statement;
  }

  /** The scope a decision was written with, or undefined when it is not a decision of this project. */
  #decision_scope(project_id: string, decision_id: string): string | undefined {
    return this.#db.get<{ scope: string }>(
      `SELECT d.scope AS scope FROM objects o
         JOIN decisions d ON d.project_id = o.project_id AND d.object_id = o.id
        WHERE o.project_id = ? AND o.id = ? AND o.kind = 'decision'`,
      project_id,
      decision_id,
    )?.scope;
  }

  #supersedes_conflict(project_id: string, decision_id: string, target_state: string): Fail {
    return new Fail("supersedes_conflict", {
      target: "$.body.supersedes",
      details: { target_state, current_decision_id: replacing_decision_id(this.#db, project_id, decision_id) },
      next_action: "reread_decisions",
    });
  }

  /**
   * POST P/decisions — state "proposed" proposes (session or token); "adopted" adopts a proposal, or, with `supersedes`,
   * replaces an adopted decision; "revoked" revokes. Everything but a proposal is the owner session's.
   */
  async #decision_write(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["scope", "statement", "state", "supersedes", "rationale", "decision_id", "base_version_id"]);
    const state = body.state;
    if (typeof state !== "string" || !["proposed", "adopted", "revoked"].includes(state)) validation("$.body.state");
    const scope = body.scope;
    if (scope !== "project" && scope !== "edition") validation("$.body.scope");
    if (state !== "proposed" && !auth.session) throw new Fail("human_required");
    const supersedes = body.supersedes;
    if (supersedes !== undefined && supersedes !== null && (typeof supersedes !== "string" || supersedes.length === 0 || !supersedes.isWellFormed())) {
      invalid_field("supersedes");
    }
    // replacing a decision is the owner's act whatever `state` says: a token learns nothing about the target (not its state, not its replacement)
    if (typeof supersedes === "string" && !auth.session) throw new Fail("human_required");
    const exec = async (command: string, payload: Record<string, unknown>) =>
      this.#exec(
        () => this.#service.execute(this.#ctx(project, auth, key), command, payload),
        (error) => {
          if (error instanceof ApiError && error.code === "conflict" && is_record(error.details) && error.details.reason === "supersedes_conflict") {
            return this.#supersedes_conflict(project.id, String(supersedes), String(error.details.target_state));
          }
          return this.#record_failure(error, { decision_id: "$.body.decision_id" });
        },
      );
    const shape = (result: Record<string, unknown>, id: unknown, version_id: unknown, decision_state: string): Record<string, unknown> => ({
      decision: { id, version_id, state: decision_state, scope: result.scope ?? scope },
    });

    if (typeof supersedes === "string") {
      if (state === "revoked") validation("$.body.supersedes", { reason: "revoke_has_no_replacement" });
      if (body.decision_id !== undefined) invalid_field("decision_id");
      // a replacement is only checked against the decision it names; the same answer for a proposal and for an adoption
      // order of API decision 4: a receipt this key already left is replayed (or refused as a key reuse) by the command layer, before the
      // target is looked at - the first request made the target `superseded`, so the preview would turn its own retry into a 409
      if (receipt_of_request(this.#db, project.id, auth.actor_id, key) === undefined) {
        const target_state = this.#decision_state(project.id, supersedes);
        if (target_state === undefined) throw new Fail("not_found", { target: "$.body.supersedes" });
        if (target_state !== "adopted") throw this.#supersedes_conflict(project.id, supersedes, target_state);
      }
      if (state === "proposed") validation("$.body.state", { reason: "supersede_with_adopted" });
      const statement = this.#record_text(body, "statement");
      const base_version_id = this.#needed_id(body, "base_version_id");
      const rationale = this.#needed_text(body, "rationale", "required");
      const out = await exec("decision.supersede", { decision_id: supersedes, base_version_id, statement, rationale, scope });
      const result = result_record(out.result);
      return { status: 201, data: shape(result, result.decision_id, result.version_id, "adopted"), replayed: out.replayed };
    }

    if (state === "proposed") {
      if (body.decision_id !== undefined) invalid_field("decision_id");
      if (body.base_version_id !== undefined) invalid_field("base_version_id");
      const statement = this.#record_text(body, "statement");
      const rationale = this.#optional_record_text(body, "rationale");
      const out = await exec("decision.propose", { statement, scope, ...(rationale === undefined ? {} : { rationale }) });
      const result = result_record(out.result);
      return { status: 201, data: shape(result, result.object_id, result.version_id, "proposed"), replayed: out.replayed };
    }

    const decision_id = this.#needed_id(body, "decision_id");
    const base_version_id = this.#needed_id(body, "base_version_id");
    // `scope` is required on every write; for an adoption / revocation it must name the scope the decision really has
    const actual_scope = this.#decision_scope(project.id, decision_id);
    if (actual_scope !== undefined && actual_scope !== scope) validation("$.body.scope", { reason: "scope_mismatch" });
    // adopting or revoking does not change the sentence (to change it, replace the decision): a different statement is refused,
    // the same sentence or none passes
    if (body.statement !== undefined && body.statement !== null) {
      if (typeof body.statement !== "string" || !body.statement.isWellFormed()) invalid_field("statement");
      const current_statement = this.#decision_statement(project.id, decision_id);
      if (current_statement !== undefined && body.statement !== current_statement) validation("$.body.statement", { reason: "statement_changed" });
    }
    if (state === "adopted") {
      const rationale = this.#optional_record_text(body, "rationale");
      const out = await exec("decision.adopt", { decision_id, base_version_id, ...(rationale === undefined ? {} : { rationale }) });
      const result = result_record(out.result);
      return { status: 201, data: shape(result, result.decision_id, result.version_id, "adopted"), replayed: out.replayed };
    }
    const rationale = this.#needed_text(body, "rationale", "required");
    const out = await exec("decision.revoke", { decision_id, base_version_id, rationale });
    const result = result_record(out.result);
    return { status: 201, data: shape(result, result.decision_id, result.version_id, "revoked"), replayed: out.replayed };
  }

  /** POST P/reflections — the reflection of a round. The shape is checked here (422 with the entry's path); the evidence's meaning is the core's. */
  async #reflection_write(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["target_round_id", "entries"]);
    const target_round_id = require_text(body, "target_round_id");
    if (!Array.isArray(body.entries)) invalid_field("entries");
    if (body.entries.length > 200) invalid_field("entries");
    const entries = body.entries.map((raw, index): Record<string, unknown> => {
      const at = `$.body.entries[${index}]`;
      if (!is_record(raw)) invalid(at);
      for (const field of Object.keys(raw)) {
        if (!["source_version_id", "disposition", "rationale", "result_version_id", "followup_id", "evidence_tx_id", "supersedes_entry_id"].includes(field)) {
          invalid(`${at}.${field}`);
        }
      }
      require_text(raw, "source_version_id", at);
      if (typeof raw.disposition !== "string" || !["applied", "partial", "rejected", "deferred"].includes(raw.disposition)) {
        validation(`${at}.disposition`);
      }
      if (typeof raw.rationale !== "string" || !raw.rationale.isWellFormed()) invalid(`${at}.rationale`);
      if (raw.rationale.trim().length === 0) validation(`${at}.rationale`, { reason: "empty" });
      for (const field of ["result_version_id", "followup_id", "evidence_tx_id", "supersedes_entry_id"]) {
        const value = raw[field];
        if (value !== undefined && value !== null && (typeof value !== "string" || value.length === 0 || !value.isWellFormed())) invalid(`${at}.${field}`);
      }
      if (raw.disposition === "rejected" || raw.disposition === "deferred") {
        for (const field of ["result_version_id", "followup_id", "evidence_tx_id"]) {
          if (raw[field] !== undefined && raw[field] !== null) validation(`${at}.${field}`, { reason: "evidence_not_allowed" });
        }
      }
      return raw;
    });
    const out = await this.#exec(
      () => this.#service.execute(this.#ctx(project, auth, key), "reflection.create", { target_round_id, entries }),
      (error) => this.#record_failure(error, { target_round_id: "$.body.target_round_id" }),
    );
    const result = result_record(out.result);
    return {
      status: 201,
      data: {
        reflection: {
          id: result.reflection_id,
          target_round_id: result.target_round_id,
          applied_count: result.applied_count,
          partial_count: result.partial_count,
        },
      },
      replayed: out.replayed,
    };
  }

  /**
   * The edition a records read is about: `?edition=<edition_no>` names one (any status), no `edition` is the active one.
   * A number that is not a positive integer is 400, a number this project does not have is 404.
   */
  #read_edition(request: RouteRequest, project: ProjectRow): { edition_id: string; edition: number } {
    if (!request.query.has("edition")) {
      const edition_id = this.#edition_of(project);
      return { edition_id, edition: read_tx(this.#db, () => edition_no_of(this.#db, project.id, edition_id)) ?? 0 };
    }
    const text = request.query.get("edition") as string;
    if (!/^[0-9]+$/.test(text)) invalid("$.query.edition");
    const edition = Number(text);
    if (!Number.isSafeInteger(edition) || edition < 1) invalid("$.query.edition");
    const edition_id = read_tx(this.#db, () => edition_id_by_no(this.#db, project.id, edition));
    if (edition_id === null) throw new Fail("not_found", { target: "$.query.edition" });
    return { edition_id, edition };
  }

  async #assumptions_read(request: RouteRequest, project: ProjectRow): Promise<HandlerResult> {
    const { edition_id, edition } = this.#read_edition(request, project);
    return { status: 200, data: { edition, assumptions: read_tx(this.#db, () => assumption_rows(this.#db, project.id, edition_id)) } };
  }

  async #decisions_read(request: RouteRequest, project: ProjectRow): Promise<HandlerResult> {
    const { edition_id, edition } = this.#read_edition(request, project);
    return { status: 200, data: { edition, decisions: read_tx(this.#db, () => decision_rows(this.#db, project.id, edition_id)) } };
  }

  /**
   * GET P/reflections — by `round_id`, or by `?edition=&stage=&round_no=` (edition optional: the active one), or with neither the rounds
   * that have a reflection. "Not submitted" and "0 entries" are different answers. Giving both ways is 400.
   */
  async #reflections_read(request: RouteRequest, project: ProjectRow): Promise<HandlerResult> {
    const round_id = request.query.get("round_id");
    const by_number = request.query.has("stage") || request.query.has("round_no") || request.query.has("edition");
    if (round_id !== null && by_number) invalid("$.query.round_id");
    if (round_id === null && !by_number) {
      const reflections = read_tx(this.#db, () => reflection_round_ids(this.#db, project.id).map((id) => reflection_round(this.#db, project.id, id)));
      return { status: 200, data: { reflections } };
    }
    if (round_id !== null) {
      if (round_id.length === 0) invalid("$.query.round_id");
      const round = read_tx(this.#db, () =>
        this.#db.get("SELECT 1 FROM rounds WHERE project_id = ? AND id = ?", project.id, round_id) === undefined
          ? null
          : reflection_round(this.#db, project.id, round_id),
      );
      if (round === null) throw new Fail("not_found", { target: "$.query.round_id" });
      return { status: 200, data: round };
    }
    const stage = request.query.get("stage");
    if (stage === null || stage.length === 0) invalid("$.query.stage");
    const round_text = request.query.get("round_no");
    if (round_text === null || !/^[0-9]+$/.test(round_text)) invalid("$.query.round_no");
    const round_no = Number(round_text);
    if (!Number.isSafeInteger(round_no) || round_no < 1) invalid("$.query.round_no");
    const { edition_id } = this.#read_edition(request, project);
    const round = read_tx(this.#db, () => {
      const id = round_id_by_number(this.#db, project.id, edition_id, stage, round_no);
      return id === null ? null : reflection_round(this.#db, project.id, id);
    });
    if (round === null) throw new Fail("not_found", { target: "$.query.round_no" });
    return { status: 200, data: round };
  }

  /** The text of a comment body: a string; blank is a content problem (422), not a shape problem. */
  #comment_body(value: unknown, target: string): string {
    if (typeof value !== "string" || !value.isWellFormed()) invalid(target);
    if (value.trim().length === 0) validation(target);
    return value;
  }

  /** SEL-90: POST P/threads — a comment thread on a question (annotation threads stay 501 until U4a). */
  async #thread_create(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    if (body.context_kind === "annotation") throw new Fail("not_supported");
    reject_unknown(
      body,
      ["target_object_id", "target_version_id", "context_kind", "initial_message", "run_id", "lease_id", "fence"]);
    const target_object_id = require_text(body, "target_object_id");
    const target_version_id = optional_text(body, "target_version_id");
    if (body.context_kind === undefined) invalid_field("context_kind");
    if (body.context_kind !== "question_comment") validation("$.body.context_kind");
    const initial = body.initial_message;
    if (!is_record(initial)) invalid("$.body.initial_message");
    for (const field of Object.keys(initial)) {
      if (field !== "body_md") invalid(`$.body.initial_message.${field}`);
    }
    const body_md = this.#comment_body(initial.body_md, "$.body.initial_message.body_md");
    const guard = this.#guard_fields(body);
    const payload: Record<string, unknown> = { question_id: target_object_id, body_md };
    if (target_version_id !== undefined) payload.question_version_id = target_version_id;
    if (guard !== null && !auth.session) Object.assign(payload, guard);
    const out = await this.#exec(() => this.#service.execute(this.#ctx(project, auth, key), "question.comment_add", payload));
    const result = result_record(out.result);
    return {
      status: 201,
      data: {
        thread: { id: result.thread_id, state: "open" },
        message: { id: result.message_id, version_no: "1", thread_id: result.thread_id },
      },
      replayed: out.replayed,
    };
  }

  /** SEL-90: POST P/threads/{t}/messages — one more message in a question's comment thread. */
  async #thread_message(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["body_md", "reply_to", "run_id", "lease_id", "fence"]);
    const thread_id = request.params[1] as string;
    const body_md = this.#comment_body(body.body_md, "$.body.body_md");
    const reply_to = optional_text(body, "reply_to");
    const guard = this.#guard_fields(body);
    const thread = this.#db.get<{ target_object_id: string; context_kind: string }>(
      "SELECT target_object_id, context_kind FROM threads WHERE project_id = ? AND object_id = ?",
      project.id,
      thread_id,
    );
    if (thread === undefined || thread.context_kind !== "question_comment") throw new Fail("not_found");
    const payload: Record<string, unknown> = { question_id: thread.target_object_id, thread_id, body_md };
    if (reply_to !== undefined) payload.reply_to = reply_to;
    if (guard !== null && !auth.session) Object.assign(payload, guard);
    const out = await this.#exec(() => this.#service.execute(this.#ctx(project, auth, key), "question.comment_add", payload));
    const result = result_record(out.result);
    return {
      status: 201,
      data: { message: { id: result.message_id, version_no: "1", thread_id } },
      replayed: out.replayed,
    };
  }

  // -------------------------------------------------------------------------
  // rounds, stages, policy

  async #round_start(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    // round.start stores neither a purpose nor a question-set link; accepting
    // them would drop them silently, so they are refused.
    reject_unknown(body, ["base_stage_rev"]);
    const base_stage_rev = optional_decimal(body, "base_stage_rev");
    const stage_id = request.params[1] as string;
    const payload: Record<string, unknown> = { stage_id };
    if (base_stage_rev !== undefined) payload.base_stage_rev = base_stage_rev;
    const out = await this.#exec(
      () => start_round(this.#service, this.#ctx(project, auth, key), payload),
      (error) => targeted(error, { stale_stage: "$.body.base_stage_rev", stage_not_active: "$.path.stage_id" }),
    );
    const result = result_record(out.result);
    return {
      status: 201,
      data: {
        round: {
          id: result.round_id,
          round_no: String(result.round_no),
          state: "open",
          stage_id,
        },
      },
      replayed: out.replayed,
    };
  }

  async #round_seal(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(
      body,
      ["manifest_blob_id", "versions", "run_id", "lease_id", "fence", "snapshot_scope", "expected_round_rev"]);
    const manifest_blob_id = require_text(body, "manifest_blob_id");
    if (!Array.isArray(body.versions)) invalid_field("versions");
    if (body.snapshot_scope !== undefined && body.snapshot_scope !== "round") invalid_field("snapshot_scope");
    const expected = optional_decimal(body, "expected_round_rev");
    const guard = this.#guard_fields(body);
    const round_id = request.params[1] as string;
    const payload: Record<string, unknown> = { round_id, manifest_blob_id, versions: body.versions };
    if (expected !== undefined) payload.expected_round_rev = expected;
    if (guard !== null && !auth.session) Object.assign(payload, guard);
    const out = await this.#exec(
      () => seal_round(this.#service, this.#ctx(project, auth, key), payload),
      (error) =>
        targeted(error, { already_sealed: "$.path.round_id", rev_conflict: "$.body.expected_round_rev" }),
    );
    const snapshot_id = result_record(out.result).snapshot_id as string;
    return {
      status: 200,
      data: {
        round: {
          id: round_id,
          state: "sealed",
          sealed_snapshot_id: snapshot_id,
          through_event_seq: (snapshot_through_seq(this.#db, project.id, snapshot_id) ?? 0n).toString(),
        },
      },
      replayed: out.replayed,
    };
  }

  async #stage_approve(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["snapshot_id", "expected_stage_rev", "confirm"]);
    const snapshot_id = require_text(body, "snapshot_id");
    if (body.confirm !== undefined && body.confirm !== "owner") invalid_field("confirm");
    const expected = optional_decimal(body, "expected_stage_rev");
    const stage_id = request.params[1] as string;
    const payload: Record<string, unknown> = { stage_id, snapshot_id };
    if (expected !== undefined) payload.expected_stage_rev = expected;
    const out = await this.#exec(
      () => approve_stage(this.#service, this.#ctx(project, auth, key), payload),
      (error) => targeted(error, { stale_stage: "$.body.expected_stage_rev" }),
    );
    const result = result_record(out.result);
    const approval = approval_row(this.#db, project.id, result.approval_id as string);
    return {
      status: 200,
      data: {
        stage: { id: stage_id, status: "approved", approved_snapshot_id: result.snapshot_id },
        approval: {
          id: result.approval_id,
          assurance: approval?.assurance ?? "verified",
          human_user_id: approval?.human_user_id ?? null,
        },
      },
      replayed: out.replayed,
    };
  }

  async #stage_reopen(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["reason", "expected_stage_rev"]);
    const reason = optional_text(body, "reason");
    const expected = optional_decimal(body, "expected_stage_rev");
    const stage_id = request.params[1] as string;
    const payload: Record<string, unknown> = { stage_id };
    if (reason !== undefined) payload.reason = reason;
    if (expected !== undefined) payload.expected_stage_rev = expected;
    const out = await this.#exec(
      () => reopen_stage(this.#service, this.#ctx(project, auth, key), payload),
      (error) => targeted(error, { stale_stage: "$.body.expected_stage_rev" }),
    );
    const stage = stage_view(this.#db, project.id, stage_id);
    return {
      status: 200,
      data: {
        stage: {
          id: stage_id,
          status: stage?.status ?? "active",
          current_round_id: stage?.current_round_id ?? null,
        },
        reopened: {
          prior_approval_id: latest_approval_id(this.#db, project.id, stage_id),
          stale_after_stage_ordinal: Number(stage?.ordinal ?? 0n),
        },
      },
      replayed: out.replayed,
    };
  }

  async #policy_revise(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(
      body,
      ["reason", "allow_opencode_go", "go_usage_stop_percent", "mode_a_model", "expected_policy_rev"]);
    const payload: Record<string, unknown> = { reason: require_text(body, "reason") };
    if (body.allow_opencode_go !== undefined) {
      if (typeof body.allow_opencode_go !== "boolean") invalid_field("allow_opencode_go");
      payload.allow_opencode_go = body.allow_opencode_go;
    }
    if (body.go_usage_stop_percent !== undefined) {
      const percent = body.go_usage_stop_percent;
      if (typeof percent !== "number" || !Number.isSafeInteger(percent)) invalid_field("go_usage_stop_percent");
      payload.go_usage_stop_percent = percent;
    }
    if (body.mode_a_model !== undefined) payload.mode_a_model = require_text(body, "mode_a_model");
    const expected = optional_decimal(body, "expected_policy_rev");
    if (expected !== undefined) payload.expected_policy_rev = expected;
    const out = await this.#exec(
      () => set_policy(this.#service, this.#ctx(project, auth, key), payload),
      (error) => targeted(error, { rev_conflict: "$.body.expected_policy_rev" }),
    );
    const result = result_record(out.result);
    return {
      status: 201,
      data: {
        policy: {
          id: result.policy_id,
          policy_rev: String(result.policy_rev),
          allow_opencode_go: result.allow_opencode_go,
          changed_by_user_id: owner_user_id(this.#db, project.id) ?? null,
        },
      },
      replayed: out.replayed,
    };
  }

  // -------------------------------------------------------------------------
  // files (PR13)

  async #uploads_reserve(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["sha256", "size", "media_type", "original_name"]);
    const { format_version: _format, ...payload } = body;
    const out = await this.#exec(() => reserve_upload(this.#service, this.#ctx(project, auth, key), payload));
    const data = is_record(out.result) ? out.result : {};
    const status = data.deduplicated === true ? 200 : 201;
    return { status, data, replayed: out.replayed };
  }

  async #upload_put(request: RouteRequest, project: ProjectRow): Promise<HandlerResult> {
    const blob_id = request.params[1] as string;
    const bytes = this.#raw_bytes(request);
    await this.#exec(async () => {
      await store_blob({ db: this.#db, objects_dir: this.#objects_dir }, project.id, blob_id, bytes);
      return { result: null, replayed: false };
    });
    const row = this.#db.get<{ state: string }>(
      "SELECT state FROM blobs WHERE project_id = ? AND id = ?",
      project.id,
      blob_id,
    );
    return {
      status: 200,
      data: { project_id: project.id, blob_id, state: row?.state ?? "staging" },
    };
  }

  async #upload_complete(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, []);
    const blob_id = request.params[1] as string;
    const out = await this.#exec(() =>
      complete_upload(
        this.#service,
        { db: this.#db, objects_dir: this.#objects_dir },
        this.#ctx(project, auth, key),
        { blob_id },
      ),
    );
    return { status: 200, data: out.result, replayed: out.replayed };
  }

  /** A deny in the current policy or in the latest history row blocks AI access. */
  #blob_denied(project_id: string, blob_id: string): boolean {
    return blob_ai_denied(this.#db, project_id, blob_id);
  }

  async #file_read(request: RouteRequest, project: ProjectRow, auth: AuthInfo): Promise<HandlerResult> {
    read_tx(this.#db, () => {
      if (auth.kind !== "human" && this.#blob_denied(project.id, request.params[1] as string)) {
        throw new Fail("forbidden", { target: "$.path.blob_id" });
      }
    });
    const blob = await this.#exec(async () => ({
      result: await get_blob(
        { db: this.#db, objects_dir: this.#objects_dir },
        project.id,
        request.params[1] as string,
      ),
      replayed: false,
    }));
    const found = blob.result;
    const media_type = is_safe_media_type(found.media_type)
      ? found.media_type
      : "application/octet-stream";
    // SEL-102: a stored page / SVG / XML opened from this address runs its scripts on the app's origin — same sandbox as the static answer
    // (opaque origin, no allow-same-origin); every type says nosniff so a file cannot turn into a page by guessing.
    const headers: Record<string, string> = {
      "content-type": media_type,
      "x-content-type-options": "nosniff",
    };
    if (needs_document_sandbox(media_type)) {
      headers["content-security-policy"] = FILE_DOCUMENT_CSP;
    }
    return { status: 200, bytes: found.bytes, headers };
  }
}

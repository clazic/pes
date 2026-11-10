// HTTP/JSON API v1 (stage 2 PR13).
//
// ApiApp is a framework-free request handler: a closed route table, one
// response envelope, and the PR4 CommandService for every business write.
// There is no table CRUD, no arbitrary SQL route, and no SQL in this file.
// Credentials are resolved on every request (PR10 verify_agent_token /
// resolve_actor); long-poll sleeps happen after the command transaction has
// committed, so a held response never keeps a database transaction open.

import { createHash, timingSafeEqual } from "node:crypto";

import { resolve_actor, verify_agent_token, type ResolvedActor } from "./actors.ts";
import type { Clock } from "./clock.ts";
import { CommandService, type MutationContext } from "./commands.ts";
import { read_tx } from "./commands/read_tx.ts";
import { submit_results } from "./content.ts";
import type { Db } from "./db.ts";
import { ApiError } from "./errors.ts";
import { complete_upload, get_blob, is_safe_media_type, reserve_upload, store_blob } from "./files.ts";
import { new_id as default_new_id } from "./ids.ts";
import { check_go_allowed, current_policy, DbPolicyChecker, type PolicySnapshot } from "./policy.ts";
import {
  claim as run_claim,
  complete as run_complete,
  create_run,
  wait as run_wait,
} from "./runs.ts";

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
}

export interface ApiAppOptions {
  db: Db;
  clock: Clock;
  objects_dir: string;
  local_session_secret: string;
  sleep?: (ms: number) => Promise<void>;
  new_id?: () => string;
}

type Handler = (request: RouteRequest) => Promise<HandlerResult>;

interface RouteDefinition {
  pattern: RegExp;
  methods: Record<string, Handler>;
}

interface RouteRequest {
  method: string;
  path: string;
  params: string[];
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

const FORMAT_VERSION = "1.0";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_WAIT_MS = 25_000;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

const ERROR_STATUS: Readonly<Record<string, number>> = Object.freeze({
  unauthenticated: 401,
  forbidden: 403,
  policy_denied: 403,
  not_found: 404,
  method_not_allowed: 405,
  invalid_payload: 400,
  unknown_command: 400,
  payload_too_large: 413,
  idempotency_key_reuse: 409,
  rev_conflict: 409,
  conflict: 409,
  internal_error: 500,
});

function invalid(message: string): never {
  throw new ApiError("invalid_payload", message);
}

function unauthenticated(): never {
  throw new ApiError("unauthenticated", "authentication is required");
}

/** Constant-time comparison; a length difference is an immediate rejection. */
function secret_matches(presented: string | undefined, expected: string): boolean {
  if (typeof presented !== "string") return false;
  const left = Buffer.from(presented, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
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

function reject_unknown(body: Record<string, unknown>, allowed: readonly string[]): void {
  const known = new Set(allowed);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) invalid(`unknown field: ${key}`);
  }
}

function require_text(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0 || !value.isWellFormed()) {
    invalid(`${field} must be a non-empty string`);
  }
  return value;
}

function optional_text(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()) {
    invalid(`${field} must be a non-empty string or null`);
  }
  return value;
}

function parse_decimal(value: unknown, field: string): string {
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    invalid(`${field} must be a normalized decimal string`);
  }
  return value;
}

function parse_fence(value: unknown): number {
  const text = parse_decimal(value, "fence");
  const fence = Number(text);
  if (!Number.isSafeInteger(fence) || fence < 1) {
    invalid("fence must be a positive safe integer decimal string");
  }
  return fence;
}

/**
 * One decimal revision rule for claims and results: a normalized decimal
 * string is passed through unchanged and compared as BigInt inside the
 * command, so values beyond 2^53 and beyond int64 never round. Any other form
 * is invalid_payload here.
 */
function parse_rev_decimal(value: unknown): string {
  return parse_decimal(value, "expected_control_rev");
}

function require_mode(body: Record<string, unknown>): "A" | "B" {
  if (body.mode !== "A" && body.mode !== "B") invalid('mode must be "A" or "B"');
  return body.mode;
}

function decimal_text(value: unknown): string | null {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "string" && DECIMAL.test(value)) return value;
  return null;
}

function rev_details(details: unknown): { expected: string | null; current: string | null } {
  if (!is_record(details)) return { expected: null, current: null };
  return {
    expected: decimal_text(details.expected),
    current: decimal_text(details.current ?? details.actual),
  };
}

function message_for(error: ApiError, display_code: string): string {
  if (display_code === "internal_error") return "internal error";
  if (display_code === "not_found") return "the requested resource was not found";
  if (display_code === "rev_conflict") return "the revision is stale";
  const text = error.message.length > 0 ? error.message : "request failed";
  // Never let a table name, SQL fragment, path, or stack text reach a client.
  if (/SELECT |INSERT |UPDATE |DELETE |sqlite|node_modules|\.ts:\d|at \S+ \(/i.test(text)) {
    return "the request is not valid";
  }
  return text;
}

export class ApiApp {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #objects_dir: string;
  readonly #secret: string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #new_id: () => string;
  readonly #service: CommandService;
  readonly #routes: RouteDefinition[];

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

    const route = (pattern: RegExp, method: string, handler: Handler): RouteDefinition => ({
      pattern,
      methods: { [method]: handler },
    });
    const project = "([^/]+)";
    const run = "([^/]+)";
    const blob = "([^/]+)";
    this.#routes = [
      route(/^\/api\/v1\/capabilities$/, "GET", (request) => this.#capabilities(request)),
      route(/^\/api\/v1\/projects$/, "POST", (request) => this.#create_project(request)),
      route(
        new RegExp(`^/api/v1/projects/${project}/context$`),
        "GET",
        (request) => this.#context(request),
      ),
      route(
        new RegExp(`^/api/v1/projects/${project}/objects/${blob}/versions/${blob}$`),
        "GET",
        (request) => this.#version_read(request),
      ),
      route(
        new RegExp(`^/api/v1/projects/${project}/runs$`),
        "POST",
        (request) => this.#runs_create(request),
      ),
      route(
        new RegExp(`^/api/v1/projects/${project}/claims$`),
        "POST",
        (request) => this.#claims(request),
      ),
      route(
        new RegExp(`^/api/v1/projects/${project}/runs/${run}/wait$`),
        "POST",
        (request) => this.#wait(request),
      ),
      route(
        new RegExp(`^/api/v1/projects/${project}/runs/${run}/results$`),
        "POST",
        (request) => this.#results(request),
      ),
      route(
        new RegExp(`^/api/v1/projects/${project}/runs/${run}/complete$`),
        "POST",
        (request) => this.#complete(request),
      ),
      route(
        new RegExp(`^/api/v1/projects/${project}/uploads$`),
        "POST",
        (request) => this.#uploads_reserve(request),
      ),
      route(
        new RegExp(`^/api/v1/projects/${project}/uploads/${blob}$`),
        "PUT",
        (request) => this.#upload_put(request),
      ),
      route(
        new RegExp(`^/api/v1/projects/${project}/uploads/${blob}/complete$`),
        "POST",
        (request) => this.#upload_complete(request),
      ),
      route(
        new RegExp(`^/api/v1/projects/${project}/files/${blob}/content$`),
        "GET",
        (request) => this.#file_read(request),
      ),
    ];
  }

  async handle(request: ApiRequest): Promise<ApiResponse> {
    const headers = lower_headers(request.headers);
    const supplied = headers["x-request-id"];
    const request_id =
      typeof supplied === "string" && supplied.length > 0 ? supplied : this.#new_id();
    try {
      const path = request.path.split("?")[0] ?? "";
      const method = request.method.toUpperCase();
      for (const route of this.#routes) {
        const match = path.match(route.pattern);
        if (match === null) continue;
        const allow = Object.keys(route.methods);
        const handler = route.methods[method];
        if (handler === undefined) {
          return this.#error(new ApiError("method_not_allowed", "method not allowed"), request_id, {
            allow: allow.join(", "),
          });
        }
        const key_header = headers["idempotency-key"];
        const key =
          typeof key_header === "string" && key_header.length > 0 ? key_header : null;
        const result = await handler({
          method,
          path,
          params: match.slice(1),
          headers,
          body: request.body,
          request_id,
          key,
        });
        return this.#success(request_id, result);
      }
      return this.#error(new ApiError("not_found", "route not found"), request_id);
    } catch (error) {
      return this.#error(error, request_id);
    }
  }

  // -------------------------------------------------------------------------
  // response envelopes

  #success(request_id: string, result: HandlerResult): ApiResponse {
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
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

  #error(error: unknown, request_id: string, extra: Record<string, string> = {}): ApiResponse {
    const api =
      error instanceof ApiError ? error : new ApiError("internal_error", "internal error");
    let code = api.code;
    if (code === "unknown_command") code = "invalid_payload";
    const status = ERROR_STATUS[code] ?? 500;
    const display_code = ERROR_STATUS[code] === undefined ? "internal_error" : code;
    const details = display_code === "rev_conflict" ? rev_details(api.details) : null;
    const body = {
      format_version: FORMAT_VERSION,
      error: {
        code: display_code,
        message: message_for(api, display_code),
        retryable: false,
        target: null,
        details,
        next_action: null,
      },
      request_id,
    };
    return {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-request-id": request_id,
        ...extra,
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
      invalid("Idempotency-Key is required");
    }
    return key;
  }

  #json_body(request: RouteRequest): Record<string, unknown> {
    const body = request.body;
    if (body === null) invalid("a JSON request body is required");
    const bytes =
      typeof body === "string" ? Buffer.from(body, "utf8") : body;
    if (bytes.byteLength > MAX_BODY_BYTES) {
      throw new ApiError("payload_too_large", "the request body is too large");
    }
    if (bytes.byteLength === 0) invalid("a JSON request body is required");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      invalid("the request body is not valid UTF-8");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      invalid("the request body is not valid JSON");
    }
    if (!is_record(parsed)) invalid("the request body must be a JSON object");
    return parsed;
  }

  #raw_bytes(request: RouteRequest): Uint8Array {
    const body = request.body;
    if (body === null) invalid("a raw request body is required");
    if (typeof body === "string") return Buffer.from(body, "utf8");
    if (body instanceof Uint8Array) return body;
    invalid("a raw request body is required");
  }

  #project(project_id: string): ProjectRow {
    const project = this.#db.get<ProjectRow>(
      `SELECT id, slug, topic, owner_user_id, control_rev, status,
              active_edition_id, current_policy_id
         FROM projects WHERE id = ?`,
      project_id,
    );
    if (project === undefined) {
      throw new ApiError("not_found", "project not found");
    }
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
    if (row === undefined) unauthenticated();
    return row.actor_id;
  }

  #auth_project(project: ProjectRow, request: RouteRequest, scope?: string): AuthInfo {
    const session = request.headers["x-pes-session"];
    if (session !== undefined) {
      if (!secret_matches(session, this.#secret)) unauthenticated();
      return {
        actor_id: this.#owner_actor(project.id),
        kind: "human",
        session: true,
        scopes: null,
      };
    }

    const authorization = request.headers["authorization"];
    const match =
      typeof authorization === "string" ? authorization.trim().match(/^Bearer\s+(\S+)$/i) : null;
    if (match === null) unauthenticated();
    const token = match[1] as string;

    let verified;
    try {
      verified = verify_agent_token(this.#db, token, {
        project_id: project.id,
        now_ms: this.#now(),
      });
    } catch {
      unauthenticated();
    }
    let resolved: ResolvedActor;
    try {
      resolved = resolve_actor(
        this.#db,
        { project_id: project.id, actor_id: verified.actor_id },
        this.#now(),
      );
    } catch (error) {
      // A token that verifies but whose actor is not a project member is a
      // permission problem, not an invalid credential.
      if (error instanceof ApiError && error.code === "forbidden") throw error;
      unauthenticated();
    }
    if (scope !== undefined && !verified.scopes.includes(scope)) {
      throw new ApiError("forbidden", `the token lacks the ${scope} scope`);
    }
    return {
      actor_id: resolved.actor_id,
      kind: resolved.kind,
      session: false,
      scopes: verified.scopes,
    };
  }

  #require_session(request: RouteRequest): void {
    if (!secret_matches(request.headers["x-pes-session"], this.#secret)) unauthenticated();
  }

  #require_go(project_id: string): void {
    const decision = check_go_allowed(this.#db, project_id);
    if (!decision.allowed) {
      throw new ApiError("policy_denied", decision.reason);
    }
  }

  #run_mode(project_id: string, run_id: string): string | null {
    const row = this.#db.get<{ mode: string }>(
      "SELECT mode FROM runs WHERE project_id = ? AND id = ?",
      project_id,
      run_id,
    );
    return row?.mode ?? null;
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

  #normalize_run_result(result: unknown): unknown {
    if (!is_record(result)) return result;
    const out: Record<string, unknown> = { ...result };
    if (typeof out.fence === "number") out.fence = String(out.fence);
    return out;
  }

  // -------------------------------------------------------------------------
  // handlers

  async #capabilities(_request: RouteRequest): Promise<HandlerResult> {
    return {
      status: 200,
      data: {
        format_version: FORMAT_VERSION,
        routes: [
          "GET /api/v1/capabilities",
          "GET /api/v1/projects/{id}/context",
          "GET /api/v1/projects/{id}/objects/{o}/versions/{v}",
          "POST /api/v1/projects",
          "POST /api/v1/projects/{id}/runs",
          "POST /api/v1/projects/{id}/claims",
          "POST /api/v1/projects/{id}/runs/{run}/wait",
          "POST /api/v1/projects/{id}/runs/{run}/results",
          "POST /api/v1/projects/{id}/runs/{run}/complete",
          "POST /api/v1/projects/{id}/uploads",
          "PUT /api/v1/projects/{id}/uploads/{blob}",
          "POST /api/v1/projects/{id}/uploads/{blob}/complete",
          "GET /api/v1/projects/{id}/files/{blob}/content",
        ],
        scopes: ["context:read", "run:claim", "run:submit", "file:write", "file:read"],
        limits: {
          max_body_bytes: MAX_BODY_BYTES,
          max_results_per_batch: 20,
          long_poll_max_ms: MAX_WAIT_MS,
        },
      },
    };
  }

  async #create_project(request: RouteRequest): Promise<HandlerResult> {
    this.#require_session(request);
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["slug", "topic", "owner_display_name"]);
    const slug = require_text(body, "slug");
    if (!SLUG.test(slug)) {
      invalid("slug must be 1-64 lowercase letters, digits, or hyphens and start with a letter or digit");
    }
    const payload = {
      slug,
      topic: require_text(body, "topic"),
      owner_display_name: require_text(body, "owner_display_name"),
    };
    const out = await this.#service.execute(
      { project_id: null, actor_id: null, via: "http", client_request_id: key },
      "project.bootstrap",
      payload,
    );
    return { status: 201, data: out.result, replayed: out.replayed };
  }

  async #context(request: RouteRequest): Promise<HandlerResult> {
    const data = read_tx(this.#db, () => {
      const project = this.#project(request.params[0] as string);
      const auth = this.#auth_project(project, request, "context:read");
      if (auth.kind === "internal_ai") this.#require_go(project.id);
      return this.#context_data(project);
    });
    return { status: 200, data };
  }

  async #version_read(request: RouteRequest): Promise<HandlerResult> {
    const data = read_tx(this.#db, () => {
      const project = this.#project(request.params[0] as string);
      const auth = this.#auth_project(project, request, "context:read");
      if (auth.kind === "internal_ai") this.#require_go(project.id);
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
      if (row === undefined) throw new ApiError("not_found", "version not found");
      const files = this.#db.all<{ blob_id: string; role: string }>(
        `SELECT blob_id, role FROM version_files
          WHERE project_id = ? AND version_id = ? ORDER BY role, blob_id`,
        project.id,
        version_id,
      );
      return {
        project_id: project.id,
        object_id: row.object_id,
        kind: row.kind,
        version_id: row.version_id,
        version_no: Number(row.version_no),
        is_current: Number(row.is_current) === 1,
        content_hash: row.content_hash,
        files: files.map((file) => ({ blob_id: file.blob_id, role: file.role })),
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

  async #runs_create(request: RouteRequest): Promise<HandlerResult> {
    const project = this.#project(request.params[0] as string);
    const auth = this.#auth_project(project, request);
    if (!auth.session) {
      throw new ApiError("forbidden", "only the owner's local session may start a run");
    }
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["actor_id", "mode", "runtime", "provider", "model"]);
    const actor_id = require_text(body, "actor_id");
    const mode = require_mode(body);
    const runtime = require_text(body, "runtime");
    const provider = require_text(body, "provider");
    const model = require_text(body, "model");
    if (mode === "A" && (provider !== "opencode-go" || !model.startsWith("opencode-go/"))) {
      invalid("mode A requires the opencode-go provider and model prefix");
    }
    if (mode === "A") this.#require_go(project.id);
    const out = await create_run(this.#service, this.#ctx(project, auth, key), {
      actor_id,
      mode,
      runtime,
      provider,
      model,
    });
    const result = is_record(out.result) ? out.result : {};
    return { status: 201, data: { ...result, mode }, replayed: out.replayed };
  }

  async #claims(request: RouteRequest): Promise<HandlerResult> {
    const project = this.#project(request.params[0] as string);
    const auth = this.#auth_project(project, request, "run:claim");
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
      ? parse_rev_decimal(body.expected_control_rev)
      : undefined;

    let payload: Record<string, unknown>;
    if (has_run) {
      const run_id = require_text(body, "run_id");
      if (this.#run_mode(project.id, run_id) === "A") this.#require_go(project.id);
      payload = { run_id };
    } else {
      const mode = require_mode(body);
      const runtime = require_text(body, "runtime");
      const provider = require_text(body, "provider");
      const model = require_text(body, "model");
      if (mode === "A" && (provider !== "opencode-go" || !model.startsWith("opencode-go/"))) {
        invalid("mode A requires the opencode-go provider and model prefix");
      }
      if (mode === "A") this.#require_go(project.id);
      payload = { mode, runtime, provider, model };
    }
    const out = await run_claim(
      this.#service,
      this.#ctx(project, auth, key, base),
      payload,
    );
    return { status: 200, data: this.#normalize_run_result(out.result), replayed: out.replayed };
  }

  async #wait(request: RouteRequest): Promise<HandlerResult> {
    const project = this.#project(request.params[0] as string);
    const auth = this.#auth_project(project, request, "run:submit");
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
        invalid(`wait_ms must be an integer from 0 to ${MAX_WAIT_MS}`);
      }
      wait_ms = value;
    }
    const reason = optional_text(body, "reason");
    this.#require_go_for_run(project.id, run_id);

    const payload: Record<string, unknown> = { run_id, lease_id, fence };
    if (reason !== undefined) payload.reason = reason;
    const out = await run_wait(this.#service, this.#ctx(project, auth, key), payload);
    const data = this.#normalize_run_result(out.result);
    if (!out.replayed && wait_ms !== undefined && wait_ms > 0) await this.#sleep(wait_ms);
    return { status: 200, data, replayed: out.replayed };
  }

  async #results(request: RouteRequest): Promise<HandlerResult> {
    const project = this.#project(request.params[0] as string);
    const auth = this.#auth_project(project, request, "run:submit");
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["lease_id", "fence", "results", "expected_control_rev"]);
    const run_id = request.params[1] as string;
    const lease_id = require_text(body, "lease_id");
    const fence = parse_fence(body.fence);
    // Payload shape (including the non-empty list) wins over a stale rev.
    if (!Array.isArray(body.results) || body.results.length < 1 || body.results.length > 20) {
      invalid("results must be an array of 1 to 20 items");
    }
    const base = Object.hasOwn(body, "expected_control_rev")
      ? parse_rev_decimal(body.expected_control_rev)
      : undefined;
    this.#require_go_for_run(project.id, run_id);

    const out = await submit_results(this.#service, this.#ctx(project, auth, key, base), {
      run_id,
      lease_id,
      fence,
      results: body.results,
    });
    return { status: 200, data: out.result, replayed: out.replayed };
  }

  async #complete(request: RouteRequest): Promise<HandlerResult> {
    const project = this.#project(request.params[0] as string);
    const auth = this.#auth_project(project, request, "run:submit");
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, ["lease_id", "fence", "status"]);
    const run_id = request.params[1] as string;
    const lease_id = require_text(body, "lease_id");
    const fence = parse_fence(body.fence);
    const payload: Record<string, unknown> = { run_id, lease_id, fence };
    if (Object.hasOwn(body, "status")) {
      const status = body.status;
      if (status !== "succeeded" && status !== "failed") {
        invalid('status must be "succeeded" or "failed"');
      }
      payload.status = status;
    }
    this.#require_go_for_run(project.id, run_id);
    const out = await run_complete(this.#service, this.#ctx(project, auth, key), payload);
    return { status: 200, data: this.#normalize_run_result(out.result), replayed: out.replayed };
  }

  async #uploads_reserve(request: RouteRequest): Promise<HandlerResult> {
    const project = this.#project(request.params[0] as string);
    const auth = this.#auth_project(project, request, "file:write");
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    const out = await reserve_upload(this.#service, this.#ctx(project, auth, key), body);
    const data = is_record(out.result) ? out.result : {};
    const status = data.deduplicated === true ? 200 : 201;
    return { status, data, replayed: out.replayed };
  }

  async #upload_put(request: RouteRequest): Promise<HandlerResult> {
    const project = this.#project(request.params[0] as string);
    const auth = this.#auth_project(project, request, "file:write");
    const blob_id = request.params[1] as string;
    const bytes = this.#raw_bytes(request);
    await store_blob(
      { db: this.#db, objects_dir: this.#objects_dir },
      project.id,
      blob_id,
      bytes,
    );
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

  async #upload_complete(request: RouteRequest): Promise<HandlerResult> {
    const project = this.#project(request.params[0] as string);
    const auth = this.#auth_project(project, request, "file:write");
    const key = this.#require_key(request);
    const body = this.#json_body(request);
    reject_unknown(body, []);
    const blob_id = request.params[1] as string;
    const out = await complete_upload(
      this.#service,
      { db: this.#db, objects_dir: this.#objects_dir },
      this.#ctx(project, auth, key),
      { blob_id },
    );
    return { status: 200, data: out.result, replayed: out.replayed };
  }

  async #file_read(request: RouteRequest): Promise<HandlerResult> {
    const project = this.#project(request.params[0] as string);
    const auth = this.#auth_project(project, request, "file:read");
    if (auth.kind === "internal_ai") this.#require_go(project.id);
    const blob = await get_blob(
      { db: this.#db, objects_dir: this.#objects_dir },
      project.id,
      request.params[1] as string,
    );
    return {
      status: 200,
      bytes: blob.bytes,
      headers: {
        "content-type": is_safe_media_type(blob.media_type)
          ? blob.media_type
          : "application/octet-stream",
      },
    };
  }
}

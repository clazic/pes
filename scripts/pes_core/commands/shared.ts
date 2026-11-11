// Shared command plumbing used by commands.ts and command definitions.
//
// This module has no runtime dependency on commands.ts, so command definition
// files (commands/*.ts) can be imported first without a cycle. The service
// keeps the registry, scope, policy, replay, and transaction; the helpers here
// only validate payloads and write the receipt/event rows that every command
// shares.

import type { RunConfig } from "../config.ts";
import type { Db, SqlValue } from "../db.ts";
import { ApiError } from "../errors.ts";
import { read_credential_actor } from "../actors.ts";

export type CommandVia = "web" | "cli" | "http" | "mcp" | "webmcp" | "import";

export interface MutationContext {
  project_id: string | null;
  actor_id: string | null;
  via: CommandVia;
  client_request_id: string;
  /**
   * Optional CAS base. HTTP uses a normalized decimal string so revisions
   * beyond the JS safe integer range are compared exactly; in-process callers
   * may pass a non-negative safe integer.
   */
  base_control_rev?: number | string;
}

export interface ProjectRow {
  id: string;
  control_rev: bigint;
  status: string;
}

export interface CommandRuntime {
  db: Db;
  ctx: MutationContext;
  payload: unknown;
  now_ms: number;
  tx_id: string;
  request_hash: string;
  new_id: () => string;
  project: ProjectRow | null;
  actor_id: string | null;
  run_config: RunConfig;
  /**
   * Absolute objects folder when the caller attached a store, or null. File
   * commands that need stored bytes fail closed when it is null.
   */
  objects_dir: string | null;
}

/**
 * The one canonical objects folder per database connection. A CommandService
 * registers the folder it was constructed with; public store wrappers compare
 * the folder they were handed against this entry and refuse a different one.
 * The map is keyed by the database object, so a wrapped test handle gets its
 * own registration without affecting the real connection.
 */
const canonical_object_stores = new WeakMap<Db, string>();

export function register_object_store(db: Db, objects_dir: string): void {
  const existing = canonical_object_stores.get(db);
  if (existing !== undefined && existing !== objects_dir) {
    // Two different folders on one database would split read and write paths.
    // The message stays fixed: no absolute path and no store folder.
    throw new ApiError("conflict", "the object store does not match the service");
  }
  canonical_object_stores.set(db, objects_dir);
}

export function canonical_object_store_dir(db: Db): string | null {
  return canonical_object_stores.get(db) ?? null;
}

export interface EventDraft {
  type: string;
  payload: unknown;
  before_rev?: number;
  after_rev?: number;
  run_id?: string | null;
}

export interface CommandResult {
  result: unknown;
  events: EventDraft[];
}

export interface CommandDefinition {
  /** mutation_commits.action for this command. */
  action: string;
  /**
   * "project" commands require an existing project and actor; bootstrap creates
   * them; "owner" commands run before a project exists but still require a
   * human owner actor (legacy import).
   */
  scope: "project" | "bootstrap" | "owner";
  rev_bearing: boolean;
  run(runtime: CommandRuntime): CommandResult;
}

export function require_well_formed(value: string, field: string): string {
  if (!value.isWellFormed()) {
    throw new ApiError("invalid_payload", `${field} must be well-formed Unicode`);
  }
  return value;
}

/**
 * Strip comments and whitespace and decide whether `sql` is exactly one
 * SELECT / WITH statement. String and quoted-identifier literals are skipped
 * so a ";" inside them is not a statement separator. Anything else (PRAGMA,
 * ATTACH, BEGIN, writes, several statements, empty text) is refused; the
 * SQLite connection additionally runs with query_only=ON while a checker
 * holds the handle, so a write hidden behind WITH still fails.
 */
export function assert_single_read_statement(sql: unknown): void {
  if (typeof sql !== "string") {
    throw new Error("the policy checker handle accepts only a SELECT/WITH text");
  }
  let code = "";
  let i = 0;
  let statements_end = -1;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
      code += " ";
    } else if (ch === "/" && next === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? sql.length : close + 2;
      code += " ";
    } else if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const closer = ch === "[" ? "]" : ch;
      let j = i + 1;
      for (;;) {
        const at = sql.indexOf(closer, j);
        if (at === -1) {
          j = sql.length;
          break;
        }
        if (closer !== "]" && sql[at + 1] === closer) {
          j = at + 2;
          continue;
        }
        j = at + 1;
        break;
      }
      code += "x";
      i = j;
    } else if (ch === ";") {
      if (statements_end !== -1) {
        throw new Error("the policy checker handle accepts a single statement only");
      }
      statements_end = code.length;
      code += ";";
      i += 1;
    } else {
      code += ch;
      i += 1;
    }
  }
  const trimmed = code.trim();
  if (statements_end !== -1) {
    const after = code.slice(statements_end + 1).trim();
    if (after.length > 0) {
      throw new Error("the policy checker handle accepts a single statement only");
    }
  }
  if (!/^(select|with)(?![A-Za-z0-9_$])/i.test(trimmed)) {
    throw new Error("the policy checker handle accepts only SELECT/WITH statements");
  }
  if (/^with(?![A-Za-z0-9_$])/i.test(trimmed)) {
    assert_with_ends_in_select(trimmed);
  }
}

/**
 * A WITH statement is read-only only when the statement after the CTE list is
 * a SELECT. Walk the text at parenthesis depth 0: the first
 * SELECT/INSERT/UPDATE/DELETE/REPLACE/VALUES keyword there is the final one.
 */
function assert_with_ends_in_select(code: string): void {
  let depth = 0;
  const word = /[A-Za-z_][A-Za-z0-9_$]*/y;
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "(") {
      depth += 1;
      i += 1;
    } else if (ch === ")") {
      depth -= 1;
      i += 1;
    } else if (/[A-Za-z_]/.test(ch)) {
      word.lastIndex = i;
      const match = word.exec(code);
      const text = (match === null ? ch : match[0]).toLowerCase();
      i += text.length;
      if (depth === 0 && ["select", "insert", "update", "delete", "replace", "values"].includes(text)) {
        if (text !== "select") {
          throw new Error("a WITH statement must end in a SELECT for the policy checker handle");
        }
        return;
      }
    } else {
      i += 1;
    }
  }
  throw new Error("a WITH statement must end in a SELECT for the policy checker handle");
}

function restore_query_only(db: Db, previous: bigint): void {
  try {
    db.exec(`PRAGMA query_only = ${previous === 0n ? "OFF" : "ON"}`);
  } catch {
    // nothing more can be done; the next command re-checks the guard
  }
}

export interface ReadonlyDbHandle extends Pick<Db, "get" | "all"> {}

/**
 * Run `fn` with the checker's view of a transaction: get/all only, single
 * SELECT/WITH statements only, SQLite query_only=ON while it is open (restored
 * afterwards, also when fn throws), and a handle that is dead once fn returns.
 */
export function with_readonly_db<T>(db: Db, fn: (handle: ReadonlyDbHandle) => T): T {
  let open = true;
  const guarded = <R>(sql: string, run: () => R): R => {
    if (!open) {
      throw new Error("the policy checker handle is closed");
    }
    assert_single_read_statement(sql);
    return run();
  };
  const handle: ReadonlyDbHandle = Object.freeze({
    get: <R = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]) =>
      guarded(sql, () => db.get<R>(sql, ...params)),
    all: <R = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]) =>
      guarded(sql, () => db.all<R>(sql, ...params)),
  });

  // Fail closed: the statement check alone is not read-only (WITH ... UPDATE
  // was once let through), so the checker never runs unless query_only can be
  // read, set, and read back as ON.
  const unavailable = (): never => {
    throw new ApiError("policy_denied", "the read-only database guard is not available");
  };
  let previous: bigint;
  try {
    const row = db.get<{ query_only: bigint | number }>("PRAGMA query_only");
    if (row === undefined) return unavailable();
    previous = BigInt(row.query_only);
  } catch {
    return unavailable();
  }
  let engaged = false;
  try {
    db.exec("PRAGMA query_only = ON");
    engaged = true;
    const after = db.get<{ query_only: bigint | number }>("PRAGMA query_only");
    if (after === undefined || BigInt(after.query_only) !== 1n) return unavailable();
  } catch {
    open = false;
    if (engaged || previous === 0n) restore_query_only(db, previous);
    return unavailable();
  }
  try {
    return fn(handle);
  } finally {
    open = false;
    restore_query_only(db, previous);
  }
}

export function is_record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function require_record(payload: unknown): Record<string, unknown> {
  if (!is_record(payload)) {
    throw new ApiError("invalid_payload", "payload must be a JSON object");
  }
  return payload;
}

const NORMALIZED_DECIMAL = /^(0|[1-9][0-9]*)$/;

/**
 * One CAS-base parser shared by every command that accepts
 * ctx.base_control_rev. A normalized decimal string is compared as BigInt, so
 * values at or beyond 2^53 (and beyond int64) are still exact; an in-process
 * caller may pass a non-negative safe integer. Null/undefined means no check.
 */
export function parse_base_control_rev(value: unknown): bigint | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ApiError("invalid_payload", "base_control_rev must be a non-negative safe integer");
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    if (!NORMALIZED_DECIMAL.test(value)) {
      throw new ApiError("invalid_payload", "base_control_rev must be a normalized decimal string");
    }
    return BigInt(value);
  }
  throw new ApiError("invalid_payload", "base_control_rev must be a decimal string or safe integer");
}

/**
 * Compare an optional base with the project's control_rev in the command's own
 * transaction (after receipt replay). A mismatch is rev_conflict with exact
 * decimal text on both sides. Returns the parsed base for the receipt, or null
 * when no check was requested.
 */
export function require_base_control_rev(runtime: CommandRuntime, value: unknown): bigint | null {
  const expected = parse_base_control_rev(value);
  if (expected === null) return null;
  const project = runtime.project;
  if (project === null) {
    throw new Error("a base_control_rev check requires a project");
  }
  if (expected !== project.control_rev) {
    throw new ApiError("rev_conflict", "base_control_rev is stale", {
      expected: expected.toString(),
      current: project.control_rev.toString(),
    });
  }
  return expected;
}

export function require_non_empty_string(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError("invalid_payload", `${field} must be a non-empty string`);
  }
  // A lone surrogate cannot be stored faithfully in SQLite TEXT: the receipt
  // would keep the code unit while the column gets U+FFFD. Reject it up front.
  if (!value.isWellFormed()) {
    throw new ApiError("invalid_payload", `${field} must be well-formed Unicode`);
  }
  return value;
}

/** Reject a payload key that the command does not define (closed command surface). */
export function reject_unknown_fields(
  payload: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const known = new Set(allowed);
  for (const key of Object.keys(payload)) {
    if (!known.has(key)) {
      throw new ApiError("invalid_payload", `unknown field: ${key}`);
    }
  }
}

/**
 * The command's actor must be a human project member with role "owner". The
 * service has already checked membership and disabled state; this adds the
 * kind/role rule that an agent sharing the owner's user must still fail.
 */
export function require_human_owner_actor(runtime: CommandRuntime): string {
  const project = runtime.project;
  const actor_id = runtime.actor_id;
  if (project === null || actor_id === null) {
    throw new ApiError("forbidden", "a human project owner is required");
  }
  const actor = read_credential_actor(runtime.db, actor_id);
  if (actor === undefined || actor.kind !== "human") {
    throw new ApiError("forbidden", "a human project owner is required");
  }
  const member = runtime.db.get<{ role: string }>(
    "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
    project.id,
    actor.user_id,
  );
  if (member === undefined || member.role !== "owner") {
    throw new ApiError("forbidden", "a human project owner is required");
  }
  return actor_id;
}

/** The provider and model prefix of a Go (OpenCode Go) destination. */
export const GO_PROVIDER = "opencode-go";
export const GO_MODEL_PREFIX = "opencode-go/";

/**
 * Folds a label for the Go test: trimmed, Unicode compatibility folding (full-width letters), format characters
 * removed (zero-width, soft hyphen, BOM), lower case, every hyphen-like character, underscore and space read as one
 * separator, leading separators dropped. A look-alike from another script stays unfolded. The one fold both the
 * server rule below and adapters/opencode_tui.ts `on_go_route` use; only the test applied to the folded text differs.
 */
export function fold_go_label(value: string): string {
  return value
    .trim()
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .toLowerCase()
    .replace(/[\p{Pd}\u2212_\s]+/gu, "-")
    .replace(/^-+/, "");
}

/**
 * Which field of a run carries the Go label: "mode" for mode A, else "provider" (folded `opencode-go`) or "model"
 * (folded `opencode-go/` prefix), or null. Only this test folds; the mode A shape check stays on the exact spelling.
 */
export function go_label_field(run: { mode: unknown; provider: unknown; model: unknown }): "mode" | "provider" | "model" | null {
  if (run.mode === "A") return "mode";
  if (typeof run.provider === "string" && fold_go_label(run.provider) === GO_PROVIDER) return "provider";
  if (typeof run.model === "string" && fold_go_label(run.model).startsWith(GO_MODEL_PREFIX)) return "model";
  return null;
}

/** A Go label: provider `opencode-go` or a model starting with `opencode-go/`, compared after folding. */
export function is_go_label(provider: unknown, model: unknown): boolean {
  const field = go_label_field({ mode: null, provider, model });
  return field === "provider" || field === "model";
}

/**
 * SEL-68: a mode A run (the PES built-in runner) and any Go-labelled run belong to an internal_ai actor only.
 * A claim, a run_id claim, or a run created for any other actor kind (external_agent, human) is 403 forbidden
 * before anything is written. One rule for the HTTP API and the core commands (the CLI calls the commands).
 * `details` is `{ actor_kind, field }`: the kind that was refused and the run field that carries the label.
 */
export function require_internal_ai_for_go_run(
  actor_kind: string | null | undefined,
  run: { mode: unknown; provider: unknown; model: unknown },
  field_override?: string,
): void {
  const field = go_label_field(run);
  if (field !== null && actor_kind !== "internal_ai") {
    throw new ApiError("forbidden", "a mode A or OpenCode Go run belongs to an internal AI actor only", {
      actor_kind: actor_kind ?? null,
      field: field_override ?? field,
    });
  }
}

/** True when the command's actor is the project's human owner (no throw). */
export function is_human_owner_actor(runtime: CommandRuntime): boolean {
  try {
    require_human_owner_actor(runtime);
    return true;
  } catch (error) {
    // Only "not a human owner" means false; a database error must surface.
    if (error instanceof ApiError && error.code === "forbidden") return false;
    throw error;
  }
}

/**
 * An optional revision field given as a normalized decimal string (or a safe
 * integer in-process). Absent/null means "no check".
 */
export function optional_rev(payload: Record<string, unknown>, field: string): bigint | null {
  const value = payload[field];
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && NORMALIZED_DECIMAL.test(value)) return BigInt(value);
  throw new ApiError("invalid_payload", `${field} must be a normalized decimal string`);
}

export interface LeaseGuard {
  run_id: string;
  lease_id: string;
  fence: number;
}

/**
 * Parse the optional run_id/lease_id/fence triple used by commands that an
 * agent may run only while it holds the project lease. Absent (or null) means
 * "no guard"; a partial triple is invalid rather than silently ignored.
 */
export function optional_lease_guard(payload: Record<string, unknown>): LeaseGuard | null {
  const present = (field: string): boolean =>
    payload[field] !== undefined && payload[field] !== null;
  const fields = ["run_id", "lease_id", "fence"];
  const given = fields.filter(present);
  if (given.length === 0) return null;
  if (given.length !== fields.length) {
    throw new ApiError("invalid_payload", "run_id, lease_id and fence must be given together");
  }
  const run_id = require_non_empty_string(payload, "run_id");
  const lease_id = require_non_empty_string(payload, "lease_id");
  const fence = payload.fence;
  if (typeof fence !== "number" || !Number.isSafeInteger(fence) || fence < 1) {
    throw new ApiError("invalid_payload", "fence must be a positive safe integer");
  }
  return { run_id, lease_id, fence };
}

/**
 * The project's active, unexpired lease with the exact id, fence, run, and
 * owner. The same rule as the run and dispatch commands (PR5/PR10); a stale
 * fence or a released/expired lease is a conflict and never revived.
 */
export function require_current_lease(runtime: CommandRuntime, guard: LeaseGuard): void {
  const project = runtime.project;
  const actor_id = runtime.actor_id;
  if (project === null || actor_id === null) {
    throw new Error("a lease-guarded command must resolve a project and actor first");
  }
  const lease = runtime.db.get<{
    lease_id: string;
    run_id: string | null;
    owner_actor_id: string | null;
    fence: bigint;
    state: string;
    expires_at: bigint;
  }>(
    `SELECT lease_id, run_id, owner_actor_id, fence, state, expires_at
       FROM project_leases WHERE project_id = ?`,
    project.id,
  );
  if (
    lease === undefined ||
    lease.state !== "active" ||
    runtime.now_ms >= Number(lease.expires_at) ||
    lease.lease_id !== guard.lease_id ||
    Number(lease.fence) !== guard.fence ||
    lease.run_id !== guard.run_id ||
    lease.owner_actor_id !== actor_id
  ) {
    throw new ApiError("conflict", "the lease is not current");
  }
}

export function insert_receipt(
  runtime: CommandRuntime,
  fields: {
    project_id: string;
    actor_id: string;
    action: string;
    base_control_rev: number | bigint | null;
    result: unknown;
    run_id?: string | null;
    lease_id?: string | null;
    fence?: number | null;
  },
): void {
  const written = runtime.db.run(
    `INSERT INTO mutation_commits
       (id, project_id, actor_id, via, client_request_id, request_hash, action,
        base_control_rev, run_id, lease_id, fence, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    runtime.tx_id,
    fields.project_id,
    fields.actor_id,
    runtime.ctx.via,
    runtime.ctx.client_request_id,
    runtime.request_hash,
    fields.action,
    fields.base_control_rev,
    fields.run_id ?? null,
    fields.lease_id ?? null,
    fields.fence ?? null,
    JSON.stringify(fields.result),
    runtime.now_ms,
  );
  if (written.changes !== 1n) {
    throw new Error("the mutation receipt was not written");
  }
}

export function write_events(runtime: CommandRuntime, project_id: string, events: EventDraft[]): void {
  if (events.length === 0) {
    throw new Error("every command must leave at least one event");
  }
  for (const [index, event] of events.entries()) {
    const written = runtime.db.run(
      `INSERT INTO events
         (id, project_id, run_id, tx_id, tx_index, tx_size, type, object_id, before_rev,
          after_rev, payload, schema_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?)`,
      runtime.new_id(),
      project_id,
      event.run_id ?? null,
      runtime.tx_id,
      index,
      events.length,
      event.type,
      event.before_rev ?? null,
      event.after_rev ?? null,
      JSON.stringify(event.payload ?? {}),
      runtime.now_ms,
    );
    if (written.changes !== 1n) {
      throw new Error("the event was not written");
    }
  }
}

export interface KeyedStage {
  id: string;
  key: string;
  edition_id: string;
  latest_round_no: number;
}

/**
 * A stage of the project's active edition, found by its key ("plan" ...). With
 * no key the edition's current stage is used. Used by the CLI record commands
 * that name a stage the way the old CLI did.
 */
export function resolve_stage_key(
  runtime: CommandRuntime,
  project_id: string,
  key: unknown,
): KeyedStage {
  const edition = runtime.db.get<{ id: string; current_stage_id: string | null }>(
    `SELECT e.id AS id, e.current_stage_id AS current_stage_id
       FROM projects p JOIN editions e ON e.project_id = p.id AND e.id = p.active_edition_id
      WHERE p.id = ?`,
    project_id,
  );
  if (edition === undefined) {
    throw new ApiError("conflict", "the project has no active edition");
  }
  let stage: { id: string; key: string } | undefined;
  if (key === undefined || key === null) {
    stage =
      edition.current_stage_id === null
        ? undefined
        : runtime.db.get<{ id: string; key: string }>(
            "SELECT id, key FROM stages WHERE project_id = ? AND id = ?",
            project_id,
            edition.current_stage_id,
          );
  } else {
    if (typeof key !== "string" || key.length === 0) {
      throw new ApiError("invalid_payload", "stage must be a stage key");
    }
    stage = runtime.db.get<{ id: string; key: string }>(
      "SELECT id, key FROM stages WHERE project_id = ? AND edition_id = ? AND key = ?",
      project_id,
      edition.id,
      key,
    );
  }
  if (stage === undefined) {
    throw new ApiError("not_found", "stage not found");
  }
  const round = runtime.db.get<{ n: bigint | null }>(
    "SELECT max(round_no) AS n FROM rounds WHERE project_id = ? AND stage_id = ?",
    project_id,
    stage.id,
  );
  return {
    id: stage.id,
    key: stage.key,
    edition_id: edition.id,
    latest_round_no: Number(round?.n ?? 0n),
  };
}

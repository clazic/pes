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
  base_control_rev?: number;
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
  /** "project" commands require an existing project and actor; bootstrap creates them. */
  scope: "project" | "bootstrap";
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

  let previous: bigint | null = null;
  try {
    const row = db.get<{ query_only: bigint }>("PRAGMA query_only");
    previous = row === undefined ? null : BigInt(row.query_only);
  } catch {
    previous = null; // not a SQLite connection: the statement check still applies
  }
  if (previous !== null) {
    db.exec("PRAGMA query_only = ON");
  }
  try {
    return fn(handle);
  } finally {
    open = false;
    if (previous !== null) {
      db.exec(`PRAGMA query_only = ${previous === 0n ? "OFF" : "ON"}`);
    }
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

export function insert_receipt(
  runtime: CommandRuntime,
  fields: {
    project_id: string;
    actor_id: string;
    action: string;
    base_control_rev: number | null;
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

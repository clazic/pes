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
 * The policy checker's view of a transaction: reads only. The object exposes
 * get/all and no run/exec/prepare, so a checker cannot write through it even
 * though it is called inside the transaction.
 */
export function readonly_db(db: Db): Pick<Db, "get" | "all"> {
  return Object.freeze({
    get: <T = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]) =>
      db.get<T>(sql, ...params),
    all: <T = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]) =>
      db.all<T>(sql, ...params),
  });
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
  const row = runtime.db.get<{ kind: string; role: string | null }>(
    `SELECT a.kind AS kind, m.role AS role
       FROM actors a
       LEFT JOIN project_members m
         ON m.project_id = ? AND m.user_id = a.user_id
      WHERE a.id = ?`,
    project.id,
    actor_id,
  );
  if (row === undefined || row.kind !== "human" || row.role !== "owner") {
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

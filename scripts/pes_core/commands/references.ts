// Reference-material commands (stage 3 REF1a, SEL-113): a read-only pointer from this project to ONE snapshot of an
// earlier project. No new table — the rows are project_references (DDL 001).
//
//   reference.attach       the human owner pins a snapshot of another project (default: its newest) as reference material
//   reference.detach       the human owner removes the reference (the row is deleted; the history is the receipt and event)
//   reference.refresh      the human owner moves the pin to another snapshot of the same source (default: the newest)
//   reference.source_gone  the SOURCE project's human owner says a snapshot (or the whole project) is going away: every
//                          reference to it is emptied EXPLICITLY in the same transaction (source_snapshot_id / latest_snapshot_id
//                          = NULL, and referenced_project_id = NULL when the project goes) and left as a tombstone
//                          (status 'source_missing'); key, label and scope stay, so the reader can still say what was lost.
//                          A named snapshot must belong to the source and be deletable (not sealed, not approved); the result is
//                          {released_count} — the source's receipt and events never carry the id of the referencing project (SEL-123)
//
// The source is never written: attach, refresh and detach only touch this project's own rows. Attaching needs the human to
// be a member of BOTH projects. One source can be attached once (a different version is a refresh); a tombstone can be
// detached but not refreshed. A refusal writes nothing (the command service rolls the transaction back).
//
// The "new version available" notice is not stored: a GET computes it (references.ts). So nothing here runs on a read.

import { read_credential_actor } from "../actors.ts";
import { ApiError } from "../errors.ts";
import { DEFAULT_REFERENCE_SCOPE, REFERENCE_SCOPE_ITEMS, is_member, newest_snapshot_id, pinnable_snapshot_id, reference_row } from "../references.ts";
import {
  insert_receipt,
  optional_rev,
  reject_unknown_fields,
  require_human_owner_actor,
  require_record,
  type CommandDefinition,
  type CommandResult,
  type CommandRuntime,
} from "./shared.ts";

const MAX_ID = 200;
const MAX_LABEL = 200;

function invalid(message: string): never {
  throw new ApiError("invalid_payload", message);
}

function required_id(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID || !value.isWellFormed()) invalid(`${field} must be a non-empty string`);
  return value;
}

function optional_id(payload: Record<string, unknown>, field: string): string | undefined {
  return payload[field] === undefined ? undefined : required_id(payload, field);
}

function parse_scope(payload: Record<string, unknown>): string[] {
  const value = payload.scope;
  if (value === undefined) return [...DEFAULT_REFERENCE_SCOPE];
  if (!Array.isArray(value) || value.length === 0) invalid("scope must be a non-empty list of items");
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !REFERENCE_SCOPE_ITEMS.includes(entry)) invalid("scope has an unknown item");
    if (seen.has(entry)) invalid("scope has a duplicated item");
    seen.add(entry);
  }
  return [...value] as string[];
}

function parse_label(payload: Record<string, unknown>): string | undefined {
  const value = payload.source_label;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_LABEL || !value.isWellFormed()) invalid("source_label must be a non-empty text");
  return value;
}

function scope_of(runtime: CommandRuntime): { project_id: string; actor_id: string; user_id: string } {
  const project = runtime.project;
  const actor_id = runtime.actor_id;
  if (project === null || actor_id === null) throw new Error("a reference command must resolve a project and actor first");
  const actor = read_credential_actor(runtime.db, actor_id);
  if (actor === undefined) throw new ApiError("forbidden", "the actor is not allowed in this project");
  return { project_id: project.id, actor_id, user_id: actor.user_id };
}

/** Wrong project, or no membership in it: the same answer, so a refusal does not tell whether the project exists. */
function not_visible(): never {
  throw new ApiError("not_found", "project not found");
}

// ---------------------------------------------------------------------------
// reference.attach

function run_attach(runtime: CommandRuntime): CommandResult {
  require_human_owner_actor(runtime);
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["referenced_project_id", "source_snapshot_id", "scope", "source_label"]);
  const referenced_project_id = required_id(payload, "referenced_project_id");
  const wanted_snapshot = optional_id(payload, "source_snapshot_id");
  const scope = parse_scope(payload);
  const given_label = parse_label(payload);
  const me = scope_of(runtime);
  if (referenced_project_id === me.project_id) invalid("a project cannot reference itself");

  const source = runtime.db.get<{ id: string; slug: string; topic: string }>("SELECT id, slug, topic FROM projects WHERE id = ?", referenced_project_id);
  if (source === undefined || !is_member(runtime.db, source.id, me.user_id)) not_visible();

  let snapshot_id: string;
  if (wanted_snapshot !== undefined) {
    const found = pinnable_snapshot_id(runtime.db, source.id, wanted_snapshot);
    if (found === undefined) throw new ApiError("not_found", "snapshot not found");
    snapshot_id = found;
  } else {
    const newest = newest_snapshot_id(runtime.db, source.id);
    if (newest === null) throw new ApiError("conflict", "the source has no snapshot to pin");
    snapshot_id = newest;
  }
  const already = runtime.db.get<{ id: string }>("SELECT id FROM project_references WHERE project_id = ? AND referenced_project_key = ?", me.project_id, source.id);
  if (already !== undefined) throw new ApiError("conflict", "this project is already attached as reference material");

  const reference_id = runtime.new_id();
  const source_label = given_label ?? (source.topic.trim().length > 0 ? source.topic : source.slug);
  const result = {
    reference_id,
    referenced_project_id: source.id,
    source_snapshot_id: snapshot_id,
    source_snapshot_key: snapshot_id,
    source_label,
    scope,
    status: "active",
    rev: 0,
  };
  insert_receipt(runtime, { project_id: me.project_id, actor_id: me.actor_id, action: "reference.attached", base_control_rev: null, result });
  runtime.db.run(
    `INSERT INTO project_references
       (id, project_id, referenced_project_id, referenced_project_key, source_snapshot_id, source_snapshot_key, source_label,
        latest_snapshot_id, scope_json, status, attached_by_actor_id, attached_by_user_id, attached_at, refreshed_at, rev)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, 0)`,
    reference_id,
    me.project_id,
    source.id,
    source.id,
    snapshot_id,
    snapshot_id,
    source_label,
    snapshot_id,
    JSON.stringify(scope),
    me.actor_id,
    me.user_id,
    runtime.now_ms,
  );
  return {
    result,
    events: [{ type: "reference.attached", payload: { reference_id, referenced_project_id: source.id, source_snapshot_id: snapshot_id, scope } }],
  };
}

// ---------------------------------------------------------------------------
// reference.detach

function run_detach(runtime: CommandRuntime): CommandResult {
  require_human_owner_actor(runtime);
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["reference_id"]);
  const reference_id = required_id(payload, "reference_id");
  const me = scope_of(runtime);
  const row = reference_row(runtime.db, me.project_id, reference_id);
  if (row === undefined) throw new ApiError("not_found", "reference not found");

  const result = { reference_id, detached: true };
  insert_receipt(runtime, { project_id: me.project_id, actor_id: me.actor_id, action: "reference.detached", base_control_rev: null, result });
  const removed = runtime.db.run("DELETE FROM project_references WHERE project_id = ? AND id = ?", me.project_id, reference_id);
  if (removed.changes !== 1n) throw new ApiError("conflict", "the reference was not removed");
  return {
    result,
    events: [{ type: "reference.detached", payload: { reference_id, referenced_project_id: row.referenced_project_id, source_snapshot_id: row.source_snapshot_id } }],
  };
}

// ---------------------------------------------------------------------------
// reference.refresh

function run_refresh(runtime: CommandRuntime): CommandResult {
  require_human_owner_actor(runtime);
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["reference_id", "source_snapshot_id", "base_rev"]);
  const reference_id = required_id(payload, "reference_id");
  const wanted_snapshot = optional_id(payload, "source_snapshot_id");
  const base_rev = optional_rev(payload, "base_rev");
  const me = scope_of(runtime);
  const row = reference_row(runtime.db, me.project_id, reference_id);
  if (row === undefined) throw new ApiError("not_found", "reference not found");
  if (row.status === "source_missing" || row.referenced_project_id === null || row.source_snapshot_id === null) {
    throw new ApiError("conflict", "the original is gone: a reference without an original cannot be refreshed");
  }
  if (!is_member(runtime.db, row.referenced_project_id, me.user_id)) throw new ApiError("forbidden", "no permission for this reference");
  if (base_rev !== null && base_rev !== row.rev) {
    throw new ApiError("rev_conflict", "base_rev is not the current revision", { expected: base_rev.toString(), actual: row.rev.toString() });
  }

  let snapshot_id: string;
  if (wanted_snapshot !== undefined) {
    const found = pinnable_snapshot_id(runtime.db, row.referenced_project_id, wanted_snapshot);
    if (found === undefined) throw new ApiError("not_found", "snapshot not found");
    snapshot_id = found;
  } else {
    const newest = newest_snapshot_id(runtime.db, row.referenced_project_id);
    if (newest === null) throw new ApiError("conflict", "the source has no snapshot to pin");
    snapshot_id = newest;
  }
  if (snapshot_id === row.source_snapshot_id) throw new ApiError("conflict", "the reference already points at this snapshot");

  const rev = Number(row.rev) + 1;
  const result = { reference_id, source_snapshot_id: snapshot_id, source_snapshot_key: snapshot_id, previous_snapshot_id: row.source_snapshot_id, rev };
  insert_receipt(runtime, { project_id: me.project_id, actor_id: me.actor_id, action: "reference.refreshed", base_control_rev: null, result });
  const moved = runtime.db.run(
    `UPDATE project_references
        SET source_snapshot_id = ?, source_snapshot_key = ?, latest_snapshot_id = ?, refreshed_at = ?, rev = rev + 1
      WHERE project_id = ? AND id = ? AND rev = ?`,
    snapshot_id,
    snapshot_id,
    snapshot_id,
    runtime.now_ms,
    me.project_id,
    reference_id,
    row.rev,
  );
  if (moved.changes !== 1n) throw new ApiError("rev_conflict", "the reference changed meanwhile");
  return {
    result,
    events: [{ type: "reference.refreshed", payload: { reference_id, source_snapshot_id: snapshot_id, previous_snapshot_id: row.source_snapshot_id, rev } }],
  };
}

// ---------------------------------------------------------------------------
// reference.source_gone

function run_source_gone(runtime: CommandRuntime): CommandResult {
  require_human_owner_actor(runtime);
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["referenced_project_id", "snapshot_id"]);
  const referenced_project_id = required_id(payload, "referenced_project_id");
  const snapshot_id = optional_id(payload, "snapshot_id");
  const me = scope_of(runtime);
  // only the source's own owner may say the source is going away: this project is the one named
  if (referenced_project_id !== me.project_id) throw new ApiError("forbidden", "only the owner of the source project can release references to it");

  // A named snapshot must be one of THIS (source) project's, and one that may go away: a sealed round snapshot (scope other than
  // 'edition') or an approved one is permanent (stage-1-db.md "승인·봉인 스냅숏은 영구 보존"). Releasing the whole project has no such condition.
  if (snapshot_id !== undefined) {
    const snapshot = runtime.db.get<{ scope: string }>("SELECT scope FROM snapshots WHERE project_id = ? AND id = ?", me.project_id, snapshot_id);
    if (snapshot === undefined) throw new ApiError("not_found", "snapshot not found");
    const approved = runtime.db.get("SELECT 1 AS ok FROM approvals WHERE project_id = ? AND snapshot_id = ?", me.project_id, snapshot_id) !== undefined;
    if (snapshot.scope !== "edition" || approved) throw new ApiError("conflict", "a sealed or approved snapshot is permanent and cannot be released");
  }

  const rows =
    snapshot_id === undefined
      ? runtime.db.all<{ id: string }>("SELECT id FROM project_references WHERE referenced_project_id = ? AND status <> 'source_missing' ORDER BY rowid", me.project_id)
      : runtime.db.all<{ id: string }>(
          `SELECT id FROM project_references
            WHERE referenced_project_id = ? AND status <> 'source_missing' AND (source_snapshot_id = ? OR latest_snapshot_id = ?) ORDER BY rowid`,
          me.project_id,
          snapshot_id,
          snapshot_id,
        );
  // The receipt and the events live on the SOURCE project: they carry a count and this project's own ids, never the id of the
  // project that holds the reference (that project's own history is its business).
  const released_ids = rows.map((row) => row.id);
  const result = { released_count: released_ids.length };
  insert_receipt(runtime, { project_id: me.project_id, actor_id: me.actor_id, action: "reference.source_released", base_control_rev: null, result });
  // the pointers are emptied here, by the service — never left to a foreign-key action
  for (const row of rows) {
    const emptied = runtime.db.run(
      snapshot_id === undefined
        ? `UPDATE project_references SET referenced_project_id = NULL, source_snapshot_id = NULL, latest_snapshot_id = NULL,
                  status = 'source_missing', rev = rev + 1 WHERE id = ?`
        : `UPDATE project_references SET source_snapshot_id = NULL, latest_snapshot_id = NULL,
                  status = 'source_missing', rev = rev + 1 WHERE id = ?`,
      row.id,
    );
    if (emptied.changes !== 1n) throw new ApiError("conflict", "the reference was not released");
  }
  return {
    result,
    events:
      released_ids.length === 0
        ? [{ type: "reference.source_gone", payload: { referenced_project_id: me.project_id, snapshot_id: snapshot_id ?? null, released: 0 } }]
        : released_ids.map((reference_id) => ({
            type: "reference.source_missing",
            payload: { reference_id, referenced_project_id: me.project_id, snapshot_id: snapshot_id ?? null },
          })),
  };
}

// ---------------------------------------------------------------------------
// registry

function definition(action: string, run: (runtime: CommandRuntime) => CommandResult): CommandDefinition {
  return Object.freeze({ action, scope: "project", rev_bearing: false, run });
}

const REFERENCE_COMMAND_INPUTS: ReadonlyArray<readonly [string, CommandDefinition]> = [
  ["reference.attach", definition("reference.attached", run_attach)],
  ["reference.detach", definition("reference.detached", run_detach)],
  ["reference.refresh", definition("reference.refreshed", run_refresh)],
  ["reference.source_gone", definition("reference.source_released", run_source_gone)],
];

/** Registry entries merged into COMMANDS by commands.ts (names, not actions); frozen like the other command modules. */
export const REFERENCE_COMMAND_ENTRIES: ReadonlyArray<readonly [string, CommandDefinition]> = Object.freeze(
  REFERENCE_COMMAND_INPUTS.map((entry) => Object.freeze([entry[0], entry[1]] as const)),
);

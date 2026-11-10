// Edition, stage, and round command definitions (stage 2 PR6).
//
// These definitions hold the only business-table SQL for the eight edition
// commands. The public functions in scripts/pes_core/editions.ts call
// CommandService.execute once each, so every write still passes the registry,
// project/actor check, policy, receipt replay, lease guard, change, and events
// + receipt in one transaction.
//
// complete (run.complete, PR5), round.seal, and stage.approve are three
// different events. Sealing a round does not approve a stage, and a run that
// ends does not seal or approve anything.
//
// stage.reopen points later stages at its own event_seq. SQLite checks that
// foreign key immediately, while the event itself is written by the service
// after run() returns, so the command defers foreign-key checks to COMMIT for
// this transaction only (the same pragma the backup restore uses). The event
// sequence is predicted from the append-only events table: no row is ever
// deleted, so the next AUTOINCREMENT value is max(event_seq) + 1.

import { createHash } from "node:crypto";

import { read_credential_actor, type CredentialActor } from "../actors.ts";
import { ApiError } from "../errors.ts";
import {
  insert_receipt,
  is_record,
  optional_lease_guard,
  reject_unknown_fields,
  require_current_lease,
  require_human_owner_actor,
  require_non_empty_string,
  require_record,
  type CommandDefinition,
  type CommandResult,
  type CommandRuntime,
  type EventDraft,
  type LeaseGuard,
} from "./shared.ts";

const STAGE_KEYS = ["plan", "research", "analyze", "write", "verify", "publish"] as const;

const CANCELLABLE_RUN_STATUSES = new Set([
  "queued",
  "waiting_human",
  "blocked_usage",
  "interrupted",
]);

interface StageRow {
  id: string;
  edition_id: string;
  ordinal: bigint;
  status: string;
  current_round_id: string | null;
  approved_snapshot_id: string | null;
  stale_since_event_seq: bigint | null;
}

interface RoundRow {
  id: string;
  edition_id: string;
  stage_id: string;
  round_no: bigint;
  state: string;
  sealed_snapshot_id: string | null;
}

interface VersionRef {
  object_id: string;
  version_id: string;
}

interface FollowupCurrentRow {
  followup_id: string;
  from_version_id: string;
  state: string;
  description: string;
  base_artifact_version_id: string | null;
  proposed_artifact_version_id: string | null;
  version_no: bigint;
}

function invalid_payload(message: string): never {
  throw new ApiError("invalid_payload", message);
}

function command_project(runtime: CommandRuntime): { id: string; control_rev: bigint } {
  const project = runtime.project;
  if (project === null) {
    throw new Error("an edition command must resolve a project first");
  }
  return { id: project.id, control_rev: project.control_rev };
}

function command_actor(runtime: CommandRuntime): CredentialActor {
  const actor_id = runtime.actor_id;
  if (actor_id === null) {
    throw new Error("an edition command must resolve an actor first");
  }
  const actor = read_credential_actor(runtime.db, actor_id);
  if (actor === undefined) {
    throw new ApiError("forbidden", "the actor is not allowed in this project");
  }
  return actor;
}

/**
 * A human member needs no guard; an agent may act only while it holds the
 * project's active, unexpired lease. A human-supplied guard is validated for
 * shape but ignored: a human never needs one.
 */
function member_actor_with_guard(
  runtime: CommandRuntime,
  payload: Record<string, unknown>,
): { actor: CredentialActor; guard: LeaseGuard | null } {
  const actor = command_actor(runtime);
  const supplied = optional_lease_guard(payload);
  if (actor.kind === "human") return { actor, guard: null };
  if (supplied === null) {
    throw new ApiError("forbidden", "an agent must hold the lease for this command");
  }
  require_current_lease(runtime, supplied);
  return { actor, guard: supplied };
}

function guard_fields(guard: LeaseGuard | null): {
  run_id?: string;
  lease_id?: string;
  fence?: number;
} {
  if (guard === null) return {};
  return { run_id: guard.run_id, lease_id: guard.lease_id, fence: guard.fence };
}

function optional_text(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.isWellFormed()) {
    return invalid_payload(`${field} must be a string or null`);
  }
  return value;
}

/** The next events.event_seq. Events are append-only, so max + 1 is exact. */
function next_event_seq(runtime: CommandRuntime): number {
  const row = runtime.db.get<{ n: bigint | null }>(
    "SELECT max(event_seq) AS n FROM events",
  );
  const next = Number(row?.n ?? 0n) + 1;
  if (!Number.isSafeInteger(next) || next < 1) {
    throw new Error("the event sequence is exhausted");
  }
  return next;
}

/** The last event_seq that existed when this command ran (or null). */
function last_event_seq(runtime: CommandRuntime, project_id: string): number | null {
  const row = runtime.db.get<{ n: bigint | null }>(
    "SELECT max(event_seq) AS n FROM events WHERE project_id = ?",
    project_id,
  );
  if (row === undefined || row.n === null) return null;
  return Number(row.n);
}

/**
 * Deterministic hash of the exact version list in its exact order. The same
 * list always hashes the same; another version of an object changes it.
 */
function content_hash(versions: VersionRef[]): string {
  const text = versions
    .map((version) => JSON.stringify([version.object_id, version.version_id]))
    .join("\n");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function parse_versions(
  runtime: CommandRuntime,
  project_id: string,
  payload: Record<string, unknown>,
): VersionRef[] {
  const raw = payload.versions;
  if (!Array.isArray(raw)) return invalid_payload("versions must be an array");
  const seen = new Set<string>();
  const versions: VersionRef[] = [];
  for (const entry of raw) {
    if (!is_record(entry)) return invalid_payload("every version must be a JSON object");
    for (const key of Object.keys(entry)) {
      if (key !== "object_id" && key !== "version_id") {
        return invalid_payload(`unknown version field: ${key}`);
      }
    }
    const object_id = require_non_empty_string(entry, "object_id");
    const version_id = require_non_empty_string(entry, "version_id");
    const version = runtime.db.get<{ object_id: string }>(
      "SELECT object_id FROM object_versions WHERE project_id = ? AND id = ?",
      project_id,
      version_id,
    );
    if (version === undefined) {
      throw new ApiError("not_found", "version not found");
    }
    if (version.object_id !== object_id) {
      throw new ApiError("conflict", "the version belongs to another object");
    }
    if (seen.has(object_id)) {
      return invalid_payload("an object appears twice in versions");
    }
    seen.add(object_id);
    versions.push({ object_id, version_id });
  }
  return versions;
}

function require_ready_manifest(
  runtime: CommandRuntime,
  project_id: string,
  manifest_blob_id: string,
): void {
  const blob = runtime.db.get<{ state: string }>(
    "SELECT state FROM blobs WHERE project_id = ? AND id = ?",
    project_id,
    manifest_blob_id,
  );
  if (blob === undefined) {
    throw new ApiError("not_found", "manifest blob not found");
  }
  if (blob.state !== "ready") {
    throw new ApiError("conflict", "the manifest blob is not ready");
  }
}

function take_display_no(
  runtime: CommandRuntime,
  project_id: string,
  namespace: string,
): number {
  const counter = runtime.db.get<{ next_no: bigint }>(
    "SELECT next_no FROM counters WHERE project_id = ? AND namespace = ?",
    project_id,
    namespace,
  );
  if (counter === undefined) {
    throw new Error(`the counter namespace is missing: ${namespace}`);
  }
  const display_no = Number(counter.next_no);
  if (!Number.isSafeInteger(display_no) || display_no < 1) {
    throw new Error("the display counter is out of range");
  }
  const advanced = runtime.db.run(
    "UPDATE counters SET next_no = next_no + 1 WHERE project_id = ? AND namespace = ? AND next_no = ?",
    project_id,
    namespace,
    counter.next_no,
  );
  if (advanced.changes !== 1n) {
    throw new ApiError("conflict", "the display counter changed concurrently");
  }
  return display_no;
}

function read_stage(
  runtime: CommandRuntime,
  project_id: string,
  stage_id: string,
): StageRow {
  const stage = runtime.db.get<StageRow>(
    `SELECT id, edition_id, ordinal, status, current_round_id, approved_snapshot_id,
            stale_since_event_seq
       FROM stages WHERE project_id = ? AND id = ?`,
    project_id,
    stage_id,
  );
  if (stage === undefined) {
    throw new ApiError("not_found", "stage not found");
  }
  return stage;
}

function read_round(
  runtime: CommandRuntime,
  project_id: string,
  round_id: string,
): RoundRow {
  const round = runtime.db.get<RoundRow>(
    `SELECT id, edition_id, stage_id, round_no, state, sealed_snapshot_id
       FROM rounds WHERE project_id = ? AND id = ?`,
    project_id,
    round_id,
  );
  if (round === undefined) {
    throw new ApiError("not_found", "round not found");
  }
  return round;
}

// ---------------------------------------------------------------------------
// edition.create

function run_edition_create(runtime: CommandRuntime): CommandResult {
  require_human_owner_actor(runtime);
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["parent_edition_id"]);
  const project = command_project(runtime);

  let parent_edition_id: string | null = null;
  const raw_parent = payload.parent_edition_id;
  if (raw_parent !== undefined && raw_parent !== null) {
    if (typeof raw_parent !== "string" || raw_parent.trim().length === 0 || !raw_parent.isWellFormed()) {
      return invalid_payload("parent_edition_id must be a non-empty string or null");
    }
    const parent = runtime.db.get<{ id: string }>(
      "SELECT id FROM editions WHERE project_id = ? AND id = ?",
      project.id,
      raw_parent,
    );
    if (parent === undefined) {
      throw new ApiError("not_found", "parent edition not found");
    }
    parent_edition_id = parent.id;
  }

  const last = runtime.db.get<{ n: bigint | null }>(
    "SELECT max(edition_no) AS n FROM editions WHERE project_id = ?",
    project.id,
  );
  const edition_no = Number(last?.n ?? 0n) + 1;
  if (!Number.isSafeInteger(edition_no) || edition_no < 1) {
    throw new Error("the edition number is exhausted");
  }
  const edition_id = runtime.new_id();
  const stage_ids = {} as Record<string, string>;
  for (const key of STAGE_KEYS) stage_ids[key] = runtime.new_id();
  const result = { project_id: project.id, edition_id, edition_no, stage_ids };

  insert_receipt(runtime, {
    project_id: project.id,
    actor_id: command_actor(runtime).actor_id,
    action: "edition.created",
    base_control_rev: null,
    result,
  });

  runtime.db.run(
    `INSERT INTO editions (id, project_id, edition_no, parent_edition_id, status)
     VALUES (?, ?, ?, ?, 'draft')`,
    edition_id,
    project.id,
    edition_no,
    parent_edition_id,
  );
  for (const [index, key] of STAGE_KEYS.entries()) {
    runtime.db.run(
      "INSERT INTO stages (id, project_id, edition_id, key, ordinal) VALUES (?, ?, ?, ?, ?)",
      stage_ids[key],
      project.id,
      edition_id,
      key,
      index + 1,
    );
  }
  const pointer = runtime.db.run(
    "UPDATE editions SET current_stage_id = ? WHERE project_id = ? AND id = ?",
    stage_ids.plan,
    project.id,
    edition_id,
  );
  if (pointer.changes !== 1n) {
    throw new Error("the new edition current stage was not set");
  }

  return {
    result,
    events: [
      {
        type: "edition.created",
        payload: { edition_id, edition_no, parent_edition_id, stage_ids },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// round.start

function run_round_start(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["stage_id"]);
  const project = command_project(runtime);
  const stage_id = require_non_empty_string(payload, "stage_id");
  const stage = read_stage(runtime, project.id, stage_id);

  const active = runtime.db.get<{ active_edition_id: string | null }>(
    "SELECT active_edition_id FROM projects WHERE id = ?",
    project.id,
  );
  if (active === undefined || active.active_edition_id === null) {
    throw new ApiError("conflict", "the project has no active edition");
  }
  if (stage.edition_id !== active.active_edition_id) {
    throw new ApiError("conflict", "the stage is not in the active edition");
  }
  const edition = runtime.db.get<{ current_stage_id: string | null; status: string }>(
    "SELECT current_stage_id, status FROM editions WHERE project_id = ? AND id = ?",
    project.id,
    stage.edition_id,
  );
  if (edition === undefined) {
    throw new ApiError("not_found", "edition not found");
  }
  if (edition.status !== "active") {
    throw new ApiError("conflict", "the edition is not active");
  }
  if (stage.status === "approved" && stage.stale_since_event_seq === null) {
    throw new ApiError("conflict", "the stage is already approved");
  }
  const open = runtime.db.get<{ ok: bigint }>(
    "SELECT 1 AS ok FROM rounds WHERE project_id = ? AND stage_id = ? AND state = 'open'",
    project.id,
    stage_id,
  );
  if (open !== undefined) {
    throw new ApiError("conflict", "the stage already has an open round");
  }

  const ordinal = Number(stage.ordinal);
  if (ordinal > 1) {
    const previous = runtime.db.get<{ status: string }>(
      "SELECT status FROM stages WHERE project_id = ? AND edition_id = ? AND ordinal = ?",
      project.id,
      stage.edition_id,
      ordinal - 1,
    );
    if (previous === undefined || previous.status !== "approved") {
      throw new ApiError("conflict", "the previous stage is not approved");
    }
  }
  if (stage.id !== edition.current_stage_id) {
    const earlier = runtime.db.get<{ ok: bigint }>(
      `SELECT 1 AS ok FROM stages
        WHERE project_id = ? AND edition_id = ? AND ordinal < ? AND status <> 'approved'
        LIMIT 1`,
      project.id,
      stage.edition_id,
      ordinal,
    );
    if (earlier !== undefined) {
      throw new ApiError("conflict", "an earlier stage is not approved");
    }
  }

  const base = runtime.db.get<{ sealed_snapshot_id: string | null }>(
    `SELECT sealed_snapshot_id FROM rounds
      WHERE project_id = ? AND stage_id = ? AND state = 'sealed'
      ORDER BY round_no DESC LIMIT 1`,
    project.id,
    stage_id,
  );
  const base_snapshot_id = base?.sealed_snapshot_id ?? null;
  const last = runtime.db.get<{ n: bigint | null }>(
    "SELECT max(round_no) AS n FROM rounds WHERE project_id = ? AND stage_id = ?",
    project.id,
    stage_id,
  );
  const round_no = Number(last?.n ?? 0n) + 1;
  if (!Number.isSafeInteger(round_no) || round_no < 1) {
    throw new Error("the round number is exhausted");
  }
  const round_id = runtime.new_id();
  const result = {
    project_id: project.id,
    edition_id: stage.edition_id,
    stage_id,
    round_id,
    round_no,
  };

  insert_receipt(runtime, {
    project_id: project.id,
    actor_id: command_actor(runtime).actor_id,
    action: "round.started",
    base_control_rev: null,
    result,
  });
  runtime.db.run(
    `INSERT INTO rounds
       (id, project_id, edition_id, stage_id, round_no, state, base_snapshot_id)
     VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    round_id,
    project.id,
    stage.edition_id,
    stage_id,
    round_no,
    base_snapshot_id,
  );
  const updated = runtime.db.run(
    "UPDATE stages SET current_round_id = ?, status = 'active', rev = rev + 1 WHERE project_id = ? AND id = ?",
    round_id,
    project.id,
    stage_id,
  );
  if (updated.changes !== 1n) {
    throw new Error("the stage current round was not set");
  }

  return {
    result,
    events: [
      {
        type: "round.started",
        payload: {
          edition_id: stage.edition_id,
          stage_id,
          round_id,
          round_no,
          base_snapshot_id,
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// round.seal

function run_round_seal(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, [
    "round_id",
    "manifest_blob_id",
    "versions",
    "run_id",
    "lease_id",
    "fence",
  ]);
  const project = command_project(runtime);
  const { guard } = member_actor_with_guard(runtime, payload);
  const round_id = require_non_empty_string(payload, "round_id");
  const manifest_blob_id = require_non_empty_string(payload, "manifest_blob_id");
  const round = read_round(runtime, project.id, round_id);
  if (round.state !== "open") {
    throw new ApiError("conflict", "the round is not open");
  }
  require_ready_manifest(runtime, project.id, manifest_blob_id);
  const versions = parse_versions(runtime, project.id, payload);
  const snapshot_id = runtime.new_id();
  const hash = content_hash(versions);
  const result = {
    project_id: project.id,
    round_id,
    snapshot_id,
    versions,
    content_hash: hash,
  };

  insert_receipt(runtime, {
    project_id: project.id,
    actor_id: command_actor(runtime).actor_id,
    action: "round.sealed",
    base_control_rev: null,
    result,
    ...guard_fields(guard),
  });

  runtime.db.run(
    `INSERT INTO snapshots
       (id, project_id, edition_id, stage_id, round_id, scope, manifest_blob_id,
        through_event_seq, control_rev, content_hash)
     VALUES (?, ?, ?, ?, ?, 'round', ?, ?, ?, ?)`,
    snapshot_id,
    project.id,
    round.edition_id,
    round.stage_id,
    round_id,
    manifest_blob_id,
    last_event_seq(runtime, project.id),
    Number(project.control_rev),
    hash,
  );
  for (const [position, version] of versions.entries()) {
    runtime.db.run(
      `INSERT INTO round_contents
         (project_id, round_id, object_id, version_id, position, role)
       VALUES (?, ?, ?, ?, ?, 'result')`,
      project.id,
      round_id,
      version.object_id,
      version.version_id,
      position,
    );
  }
  const sealed = runtime.db.run(
    `UPDATE rounds SET state = 'sealed', sealed_snapshot_id = ?, rev = rev + 1
      WHERE project_id = ? AND id = ? AND state = 'open'`,
    snapshot_id,
    project.id,
    round_id,
  );
  if (sealed.changes !== 1n) {
    throw new ApiError("conflict", "the round is not open");
  }

  return {
    result,
    events: [
      {
        type: "round.sealed",
        run_id: guard?.run_id ?? null,
        payload: { round_id, snapshot_id, versions, content_hash: hash },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// stage.approve

function run_stage_approve(runtime: CommandRuntime): CommandResult {
  require_human_owner_actor(runtime);
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["stage_id", "snapshot_id", "note"]);
  const project = command_project(runtime);
  const actor = command_actor(runtime);
  const stage_id = require_non_empty_string(payload, "stage_id");
  const snapshot_id = require_non_empty_string(payload, "snapshot_id");
  const note = optional_text(payload, "note");
  const stage = read_stage(runtime, project.id, stage_id);

  if (stage.status === "approved" && stage.stale_since_event_seq === null) {
    throw new ApiError("conflict", "the stage is already approved");
  }
  if (stage.current_round_id === null) {
    throw new ApiError("conflict", "the stage has no current round");
  }
  const round = runtime.db.get<{
    stage_id: string;
    state: string;
    sealed_snapshot_id: string | null;
  }>(
    "SELECT stage_id, state, sealed_snapshot_id FROM rounds WHERE project_id = ? AND id = ?",
    project.id,
    stage.current_round_id,
  );
  if (
    round === undefined ||
    round.stage_id !== stage.id ||
    round.state !== "sealed" ||
    round.sealed_snapshot_id !== snapshot_id
  ) {
    throw new ApiError("conflict", "the snapshot is not the sealed snapshot of the current round");
  }

  const next = runtime.db.get<{ id: string; status: string }>(
    "SELECT id, status FROM stages WHERE project_id = ? AND edition_id = ? AND ordinal = ?",
    project.id,
    stage.edition_id,
    Number(stage.ordinal) + 1,
  );
  const approval_id = runtime.new_id();
  const edition_completed = next === undefined;
  const result = {
    project_id: project.id,
    stage_id,
    approval_id,
    snapshot_id,
    next_stage_id: next?.id ?? null,
    edition_completed,
  };

  insert_receipt(runtime, {
    project_id: project.id,
    actor_id: actor.actor_id,
    action: "stage.approved",
    base_control_rev: null,
    result,
  });
  runtime.db.run(
    `INSERT INTO approvals
       (id, project_id, stage_id, snapshot_id, actor_id, actor_kind, human_user_id,
        origin, assurance, tx_id, note)
     VALUES (?, ?, ?, ?, ?, 'human', ?, 'new', 'verified', ?, ?)`,
    approval_id,
    project.id,
    stage_id,
    snapshot_id,
    actor.actor_id,
    actor.user_id,
    runtime.tx_id,
    note,
  );
  const approved = runtime.db.run(
    `UPDATE stages
        SET status = 'approved', approved_snapshot_id = ?, stale_since_event_seq = NULL,
            rev = rev + 1
      WHERE project_id = ? AND id = ?`,
    snapshot_id,
    project.id,
    stage_id,
  );
  if (approved.changes !== 1n) {
    throw new Error("the stage was not approved");
  }
  if (next === undefined) {
    runtime.db.run(
      "UPDATE editions SET status = 'completed', rev = rev + 1 WHERE project_id = ? AND id = ?",
      project.id,
      stage.edition_id,
    );
  } else {
    if (next.status === "pending") {
      runtime.db.run(
        "UPDATE stages SET status = 'asking', rev = rev + 1 WHERE project_id = ? AND id = ? AND status = 'pending'",
        project.id,
        next.id,
      );
    }
    runtime.db.run(
      "UPDATE editions SET current_stage_id = ?, rev = rev + 1 WHERE project_id = ? AND id = ?",
      next.id,
      project.id,
      stage.edition_id,
    );
  }

  return {
    result,
    events: [
      {
        type: "stage.approved",
        payload: {
          stage_id,
          approval_id,
          snapshot_id,
          next_stage_id: next?.id ?? null,
          edition_completed,
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// stage.reopen

function run_stage_reopen(runtime: CommandRuntime): CommandResult {
  require_human_owner_actor(runtime);
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["stage_id", "reason"]);
  const project = command_project(runtime);
  const stage_id = require_non_empty_string(payload, "stage_id");
  const reason = optional_text(payload, "reason");
  const stage = read_stage(runtime, project.id, stage_id);
  if (stage.status !== "approved") {
    throw new ApiError("conflict", "the stage is not approved");
  }
  const edition = runtime.db.get<{ status: string }>(
    "SELECT status FROM editions WHERE project_id = ? AND id = ?",
    project.id,
    stage.edition_id,
  );
  if (edition === undefined) {
    throw new ApiError("not_found", "edition not found");
  }
  if (edition.status === "completed") {
    const active = runtime.db.get<{ ok: bigint }>(
      "SELECT 1 AS ok FROM editions WHERE project_id = ? AND status = 'active' AND id <> ?",
      project.id,
      stage.edition_id,
    );
    if (active !== undefined) {
      throw new ApiError("conflict", "another edition is active");
    }
  }

  const later = runtime.db.all<{ id: string; status: string }>(
    `SELECT id, status FROM stages
      WHERE project_id = ? AND edition_id = ? AND ordinal > ?
      ORDER BY ordinal`,
    project.id,
    stage.edition_id,
    Number(stage.ordinal),
  );
  const stale_stage_ids = later
    .filter((laterStage) => laterStage.status !== "pending")
    .map((laterStage) => laterStage.id);
  const runs = runtime.db.all<{ id: string; status: string }>(
    `SELECT id, status FROM runs
      WHERE project_id = ?
        AND stage_id IN (
          SELECT id FROM stages
           WHERE project_id = ? AND edition_id = ? AND ordinal > ?
        )
      ORDER BY rowid`,
    project.id,
    project.id,
    stage.edition_id,
    Number(stage.ordinal),
  );
  const cancelled = runs.filter((run) => CANCELLABLE_RUN_STATUSES.has(run.status));
  const cancelled_run_ids = cancelled.map((run) => run.id);
  const next_seq = next_event_seq(runtime);
  const edition_status = edition.status === "completed" ? "active" : edition.status;
  const result = {
    project_id: project.id,
    stage_id,
    stale_stage_ids,
    cancelled_run_ids,
    edition_status,
  };

  insert_receipt(runtime, {
    project_id: project.id,
    actor_id: command_actor(runtime).actor_id,
    action: "stage.reopened",
    base_control_rev: null,
    result,
  });

  // Later stages point at this command's own event_seq; defer the immediate
  // foreign-key check until the service has written that event before COMMIT.
  runtime.db.exec("PRAGMA defer_foreign_keys = ON");
  const reopened = runtime.db.run(
    `UPDATE stages
        SET status = 'active', approved_snapshot_id = NULL,
            stale_since_event_seq = NULL, rev = rev + 1
      WHERE project_id = ? AND id = ?`,
    project.id,
    stage_id,
  );
  if (reopened.changes !== 1n) {
    throw new Error("the stage was not reopened");
  }
  for (const laterStage of later) {
    if (laterStage.status === "pending") continue;
    runtime.db.run(
      "UPDATE stages SET stale_since_event_seq = ? WHERE project_id = ? AND id = ?",
      next_seq,
      project.id,
      laterStage.id,
    );
  }
  runtime.db.run(
    "UPDATE editions SET current_stage_id = ?, status = ?, rev = rev + 1 WHERE project_id = ? AND id = ?",
    stage_id,
    edition_status,
    project.id,
    stage.edition_id,
  );

  const events: EventDraft[] = [
    {
      type: "stage.reopened",
      payload: { stage_id, reason, stale_stage_ids, cancelled_run_ids, edition_status },
    },
  ];
  for (const run of cancelled) {
    const cancelled_run = runtime.db.run(
      `UPDATE runs
          SET status = 'cancelled', ended_at = ?,
              go_block_reason = NULL, go_blocked_at = NULL, go_block_reset_at = NULL
        WHERE project_id = ? AND id = ?
          AND status IN ('queued', 'waiting_human', 'blocked_usage', 'interrupted')`,
      runtime.now_ms,
      project.id,
      run.id,
    );
    if (cancelled_run.changes !== 1n) {
      throw new ApiError("conflict", "the run was not cancelled");
    }
    events.push({
      type: "run.invalidated",
      run_id: run.id,
      payload: { run_id: run.id, reason: "stage_reopened", stage_id },
    });
  }

  return { result, events };
}

// ---------------------------------------------------------------------------
// edition.release_completion

function run_release_completion(runtime: CommandRuntime): CommandResult {
  require_human_owner_actor(runtime);
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["edition_id"]);
  const project = command_project(runtime);
  const edition_id = require_non_empty_string(payload, "edition_id");
  const edition = runtime.db.get<{ status: string }>(
    "SELECT status FROM editions WHERE project_id = ? AND id = ?",
    project.id,
    edition_id,
  );
  if (edition === undefined) {
    throw new ApiError("not_found", "edition not found");
  }
  if (edition.status !== "completed") {
    throw new ApiError("conflict", "the edition is not completed");
  }
  const active = runtime.db.get<{ ok: bigint }>(
    "SELECT 1 AS ok FROM editions WHERE project_id = ? AND status = 'active' AND id <> ?",
    project.id,
    edition_id,
  );
  if (active !== undefined) {
    throw new ApiError("conflict", "another edition is active");
  }
  const result = { project_id: project.id, edition_id, status: "active" };

  insert_receipt(runtime, {
    project_id: project.id,
    actor_id: command_actor(runtime).actor_id,
    action: "edition.completion_released",
    base_control_rev: null,
    result,
  });
  const released = runtime.db.run(
    "UPDATE editions SET status = 'active', rev = rev + 1 WHERE project_id = ? AND id = ? AND status = 'completed'",
    project.id,
    edition_id,
  );
  if (released.changes !== 1n) {
    throw new ApiError("conflict", "the edition is not completed");
  }

  return {
    result,
    events: [
      {
        type: "edition.completion_released",
        payload: { edition_id, status: "active" },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// edition.snapshot

function run_edition_snapshot(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, [
    "scope",
    "stage_id",
    "manifest_blob_id",
    "versions",
    "run_id",
    "lease_id",
    "fence",
  ]);
  const project = command_project(runtime);
  const { guard } = member_actor_with_guard(runtime, payload);
  const scope = payload.scope;
  if (scope !== "edition" && scope !== "stage") {
    return invalid_payload('scope must be "edition" or "stage"');
  }
  const manifest_blob_id = require_non_empty_string(payload, "manifest_blob_id");

  let edition_id: string;
  let stage_id: string | null = null;
  if (scope === "stage") {
    if (payload.stage_id === undefined || payload.stage_id === null) {
      return invalid_payload("stage_id is required for a stage snapshot");
    }
    stage_id = require_non_empty_string(payload, "stage_id");
    const stage = runtime.db.get<{ edition_id: string }>(
      "SELECT edition_id FROM stages WHERE project_id = ? AND id = ?",
      project.id,
      stage_id,
    );
    if (stage === undefined) {
      throw new ApiError("not_found", "stage not found");
    }
    edition_id = stage.edition_id;
  } else {
    if (payload.stage_id !== undefined && payload.stage_id !== null) {
      return invalid_payload("an edition snapshot has no stage_id");
    }
    const active = runtime.db.get<{ active_edition_id: string | null }>(
      "SELECT active_edition_id FROM projects WHERE id = ?",
      project.id,
    );
    if (active === undefined || active.active_edition_id === null) {
      throw new ApiError("conflict", "the project has no active edition");
    }
    edition_id = active.active_edition_id;
  }

  require_ready_manifest(runtime, project.id, manifest_blob_id);
  const versions = parse_versions(runtime, project.id, payload);
  const snapshot_id = runtime.new_id();
  const hash = content_hash(versions);
  const result = { project_id: project.id, snapshot_id, scope, versions, content_hash: hash };

  insert_receipt(runtime, {
    project_id: project.id,
    actor_id: command_actor(runtime).actor_id,
    action: "edition.snapshotted",
    base_control_rev: null,
    result,
    ...guard_fields(guard),
  });
  runtime.db.run(
    `INSERT INTO snapshots
       (id, project_id, edition_id, stage_id, round_id, scope, manifest_blob_id,
        through_event_seq, control_rev, content_hash)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    snapshot_id,
    project.id,
    edition_id,
    stage_id,
    scope,
    manifest_blob_id,
    last_event_seq(runtime, project.id),
    Number(project.control_rev),
    hash,
  );

  return {
    result,
    events: [
      {
        type: "edition.snapshotted",
        run_id: guard?.run_id ?? null,
        payload: { snapshot_id, scope, stage_id, versions, content_hash: hash },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// edition.carry_over

function carry_topic(
  runtime: CommandRuntime,
  payload: Record<string, unknown>,
): CommandResult {
  reject_unknown_fields(payload, [
    "kind",
    "source_version_id",
    "stage_id",
    "title",
    "question",
  ]);
  const project = command_project(runtime);
  const actor = command_actor(runtime);
  const source_version_id = require_non_empty_string(payload, "source_version_id");
  const stage_id = require_non_empty_string(payload, "stage_id");
  const title = require_non_empty_string(payload, "title");
  const question = optional_text(payload, "question");

  const source = runtime.db.get<{ object_id: string }>(
    "SELECT object_id FROM object_versions WHERE project_id = ? AND id = ?",
    project.id,
    source_version_id,
  );
  if (source === undefined) {
    throw new ApiError("not_found", "source version not found");
  }
  const artifact = runtime.db.get<{ kind: string }>(
    "SELECT kind FROM artifacts WHERE project_id = ? AND object_id = ?",
    project.id,
    source.object_id,
  );
  if (artifact === undefined || artifact.kind !== "topic") {
    throw new ApiError("conflict", "the source version is not a topic");
  }
  const stage = runtime.db.get<{ id: string }>(
    "SELECT id FROM stages WHERE project_id = ? AND id = ?",
    project.id,
    stage_id,
  );
  if (stage === undefined) {
    throw new ApiError("not_found", "stage not found");
  }

  const object_id = runtime.new_id();
  const version_id = runtime.new_id();
  const result = {
    project_id: project.id,
    object_id,
    version_id,
    origin_version_id: source_version_id,
  };
  insert_receipt(runtime, {
    project_id: project.id,
    actor_id: actor.actor_id,
    action: "edition.carried_over",
    base_control_rev: null,
    result,
  });

  const display_no = take_display_no(runtime, project.id, "artifact");
  runtime.db.run(
    "INSERT INTO objects (id, project_id, kind, display_no) VALUES (?, ?, 'artifact', ?)",
    object_id,
    project.id,
    display_no,
  );
  const hash = createHash("sha256")
    .update(JSON.stringify({ kind: "artifact", title, question }), "utf8")
    .digest("hex");
  runtime.db.run(
    `INSERT INTO object_versions
       (id, project_id, object_id, kind, version_no, based_on_version_id,
        created_in_round_id, actor_id, run_id, tx_id, content_hash, created_at)
     VALUES (?, ?, ?, 'artifact', 1, NULL, NULL, ?, NULL, ?, ?, ?)`,
    version_id,
    project.id,
    object_id,
    actor.actor_id,
    runtime.tx_id,
    hash,
    runtime.now_ms,
  );
  runtime.db.run(
    `INSERT INTO artifacts (project_id, object_id, kind, stage_id, origin_version_id)
     VALUES (?, ?, 'topic', ?, ?)`,
    project.id,
    object_id,
    stage_id,
    source_version_id,
  );
  runtime.db.run(
    `INSERT INTO artifact_versions
       (project_id, version_id, object_id, object_kind, title, question, summary,
        body_md, status, stats, conflicts, verify, metadata_json)
     VALUES (?, ?, ?, 'artifact', ?, ?, '', NULL, 'new', '[]', '[]', 'null', '{}')`,
    project.id,
    version_id,
    object_id,
    title,
    question,
  );
  const current = runtime.db.run(
    "UPDATE objects SET current_version_id = ? WHERE project_id = ? AND id = ?",
    version_id,
    project.id,
    object_id,
  );
  if (current.changes !== 1n) {
    throw new Error("the new topic current version was not set");
  }
  runtime.db.run(
    `INSERT INTO version_relations (project_id, from_version_id, to_version_id, kind)
     VALUES (?, ?, ?, 'derived_from')`,
    project.id,
    version_id,
    source_version_id,
  );

  return {
    result,
    events: [
      {
        type: "edition.carried_over",
        payload: {
          kind: "topic",
          object_id,
          version_id,
          origin_version_id: source_version_id,
          stage_id,
        },
      },
    ],
  };
}

function carry_tasks(
  runtime: CommandRuntime,
  payload: Record<string, unknown>,
): CommandResult {
  reject_unknown_fields(payload, ["kind", "from_stage_id", "to_stage_id"]);
  const project = command_project(runtime);
  const actor = command_actor(runtime);
  const from_stage_id = require_non_empty_string(payload, "from_stage_id");
  const to_stage_id = require_non_empty_string(payload, "to_stage_id");
  const from = runtime.db.get<{ ordinal: bigint }>(
    "SELECT ordinal FROM stages WHERE project_id = ? AND id = ?",
    project.id,
    from_stage_id,
  );
  const to = runtime.db.get<{ ordinal: bigint }>(
    "SELECT ordinal FROM stages WHERE project_id = ? AND id = ?",
    project.id,
    to_stage_id,
  );
  if (from === undefined || to === undefined) {
    throw new ApiError("not_found", "stage not found");
  }
  if (Number(to.ordinal) <= Number(from.ordinal)) {
    throw new ApiError("conflict", "the target stage is not later than the source stage");
  }

  const rows = runtime.db.all<FollowupCurrentRow>(
    `SELECT o.id AS followup_id,
            o.current_version_id AS from_version_id,
            fv.state AS state,
            fv.description AS description,
            fv.base_artifact_version_id AS base_artifact_version_id,
            fv.proposed_artifact_version_id AS proposed_artifact_version_id,
            ov.version_no AS version_no
       FROM followups f
       JOIN objects o ON o.project_id = f.project_id AND o.id = f.object_id
       JOIN followup_versions fv
         ON fv.project_id = o.project_id AND fv.version_id = o.current_version_id
       JOIN object_versions ov
         ON ov.project_id = o.project_id AND ov.id = o.current_version_id
      WHERE f.project_id = ?
        AND fv.kind = 'next_round_task'
        AND fv.target_stage_id = ?
        AND fv.state IN ('proposed', 'accepted', 'running', 'deferred')
      ORDER BY o.id`,
    project.id,
    from_stage_id,
  );

  const carried = rows.map((row) => ({
    followup_id: row.followup_id,
    from_version_id: row.from_version_id,
    version_id: runtime.new_id(),
  }));
  const result = { project_id: project.id, carried };
  insert_receipt(runtime, {
    project_id: project.id,
    actor_id: actor.actor_id,
    action: "edition.carried_over",
    base_control_rev: null,
    result,
  });

  for (const [index, row] of rows.entries()) {
    const version_id = carried[index]!.version_id;
    const version_no = Number(row.version_no) + 1;
    if (!Number.isSafeInteger(version_no) || version_no < 2) {
      throw new Error("the follow-up version number is exhausted");
    }
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          followup_id: row.followup_id,
          version_no,
          state: row.state,
          description: row.description,
          target_stage_id: to_stage_id,
        }),
        "utf8",
      )
      .digest("hex");
    runtime.db.run(
      `INSERT INTO object_versions
         (id, project_id, object_id, kind, version_no, based_on_version_id,
          created_in_round_id, actor_id, run_id, tx_id, content_hash, created_at)
       VALUES (?, ?, ?, 'followup', ?, ?, NULL, ?, NULL, ?, ?, ?)`,
      version_id,
      project.id,
      row.followup_id,
      version_no,
      row.from_version_id,
      actor.actor_id,
      runtime.tx_id,
      hash,
      runtime.now_ms,
    );
    runtime.db.run(
      `INSERT INTO followup_versions
         (project_id, version_id, object_id, kind, state, description,
          target_stage_id, target_round_id, base_artifact_version_id,
          proposed_artifact_version_id)
       VALUES (?, ?, ?, 'next_round_task', ?, ?, ?, NULL, ?, ?)`,
      project.id,
      version_id,
      row.followup_id,
      row.state,
      row.description,
      to_stage_id,
      row.base_artifact_version_id,
      row.proposed_artifact_version_id,
    );
    const moved = runtime.db.run(
      `UPDATE objects SET current_version_id = ?, rev = rev + 1
        WHERE project_id = ? AND id = ? AND current_version_id = ?`,
      version_id,
      project.id,
      row.followup_id,
      row.from_version_id,
    );
    if (moved.changes !== 1n) {
      throw new ApiError("conflict", "the follow-up moved concurrently");
    }
  }

  return {
    result,
    events: [
      {
        type: "edition.carried_over",
        payload: { kind: "tasks", from_stage_id, to_stage_id, carried },
      },
    ],
  };
}

function run_edition_carry_over(runtime: CommandRuntime): CommandResult {
  require_human_owner_actor(runtime);
  const payload = require_record(runtime.payload);
  const kind = payload.kind;
  if (kind === "topic") return carry_topic(runtime, payload);
  if (kind === "tasks") return carry_tasks(runtime, payload);
  return invalid_payload('kind must be "topic" or "tasks"');
}

// ---------------------------------------------------------------------------
// registry

function definition(
  action: string,
  run: (runtime: CommandRuntime) => CommandResult,
): CommandDefinition {
  return Object.freeze({ action, scope: "project", rev_bearing: false, run });
}

const EDITION_COMMAND_INPUTS: ReadonlyArray<readonly [string, CommandDefinition]> = [
  ["edition.create", definition("edition.created", run_edition_create)],
  ["round.start", definition("round.started", run_round_start)],
  ["round.seal", definition("round.sealed", run_round_seal)],
  ["stage.approve", definition("stage.approved", run_stage_approve)],
  ["stage.reopen", definition("stage.reopened", run_stage_reopen)],
  ["edition.release_completion", definition("edition.completion_released", run_release_completion)],
  ["edition.carry_over", definition("edition.carried_over", run_edition_carry_over)],
  ["edition.snapshot", definition("edition.snapshotted", run_edition_snapshot)],
];

/**
 * Registry entries merged into COMMANDS by commands.ts (names, not actions).
 * The array and each name/definition tuple are frozen, so importing this module
 * before commands.ts cannot inject or replace a command.
 */
export const EDITION_COMMAND_ENTRIES: ReadonlyArray<readonly [string, CommandDefinition]> =
  Object.freeze(EDITION_COMMAND_INPUTS.map((entry) => Object.freeze([entry[0], entry[1]] as const)));

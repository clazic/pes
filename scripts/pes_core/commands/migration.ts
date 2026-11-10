// Migration command definitions (stage 2 PR12): validate, activate, roll back,
// restore. This file holds every business-table write of those steps; the public
// wrappers in scripts/pes_core/migration.ts only prepare input (the source plan,
// the verified bundle) and call CommandService.execute once per step.
//
// All four are "owner" scope commands: the actor must be a human, and here also
// the owner of the project the batch (or the restore target) belongs to. They
// run inside the service transaction, so a refusal or a late failure leaves no
// row, receipt or event behind.
//
// State table (import_batches.state / projects.status):
//
//   validate_import (clean)       staging|validated   -> validated / staging
//   validate_import (problems)    staging|validated   -> staging   / staging
//   activate_import               validated           -> activated / active
//   rollback_before_write         staging|validated|activated(no write) -> failed / archived
//   restore_project               any                 -> the state of the bundle
//   anything else                                     -> conflict, nothing changes

import { read_credential_actor } from "../actors.ts";
import {
  BackupError,
  export_project_in_tx,
  foreign_keys_hold,
  replace_project_rows_in_tx,
  verify_bundle,
  type PreparedProjectRestore,
} from "../backup.ts";
import { ApiError } from "../errors.ts";
import {
  delete_project_file,
  read_storage_bytes,
  scan_project_files,
  write_storage_bytes,
} from "../files.ts";
import {
  assert_backup_location,
  build_validation_report,
  take_prepared_restore,
  take_prepared_validation,
  type LostWrite,
} from "../migration.ts";
import {
  insert_receipt,
  reject_unknown_fields,
  require_non_empty_string,
  require_record,
  type CommandDefinition,
  type CommandResult,
  type CommandRuntime,
} from "./shared.ts";

interface BatchRow {
  id: string;
  project_id: string;
  state: string;
  source_fingerprint: string;
  source_manifest_blob_id: string;
  report_blob_id: string | null;
}

interface ProjectOwnerRow {
  id: string;
  status: string;
  owner_user_id: string;
}

/** The runtime's actor must be the human owner of this project; anything else is forbidden. */
function require_project_owner(runtime: CommandRuntime, project: ProjectOwnerRow): string {
  const actor_id = runtime.actor_id;
  if (actor_id === null) throw new ApiError("forbidden", "a human owner is required");
  const actor = read_credential_actor(runtime.db, actor_id);
  if (actor === undefined || actor.kind !== "human" || actor.user_id !== project.owner_user_id) {
    throw new ApiError("forbidden", "only the human owner of the project may do this");
  }
  return actor_id;
}

function load_batch(
  runtime: CommandRuntime,
  batch_id: string,
): { batch: BatchRow; project: ProjectOwnerRow; actor_id: string } {
  const batch = runtime.db.get<BatchRow>(
    `SELECT id, project_id, state, source_fingerprint, source_manifest_blob_id, report_blob_id
       FROM import_batches WHERE id = ?`,
    batch_id,
  );
  if (batch === undefined) throw new ApiError("not_found", "the import batch was not found");
  const project = runtime.db.get<ProjectOwnerRow>(
    "SELECT id, status, owner_user_id FROM projects WHERE id = ?",
    batch.project_id,
  );
  if (project === undefined) throw new ApiError("not_found", "the import batch has no project");
  const actor_id = require_project_owner(runtime, project);
  return { batch: { ...batch }, project: { ...project }, actor_id };
}

function set_batch_state(runtime: CommandRuntime, batch: BatchRow, from: string, to: string): void {
  const changed = runtime.db.run(
    "UPDATE import_batches SET state = ? WHERE id = ? AND state = ?",
    to,
    batch.id,
    from,
  );
  if (changed.changes !== 1n) throw new ApiError("conflict", "the import batch changed concurrently");
}

function set_project_status(runtime: CommandRuntime, project_id: string, from: string, to: string): void {
  const changed = runtime.db.run(
    "UPDATE projects SET status = ? WHERE id = ? AND status = ?",
    to,
    project_id,
    from,
  );
  if (changed.changes !== 1n) throw new ApiError("conflict", "the project changed concurrently");
}

function require_objects_dir(runtime: CommandRuntime): string {
  if (runtime.objects_dir === null) {
    throw new ApiError("conflict", "no object store is configured for this migration step");
  }
  return runtime.objects_dir;
}

// ---------------------------------------------------------------------------
// legacy.validate_import

const MAX_EVENT_PROBLEMS = 50;

function run_validate_import(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["batch_id", "source_token"]);
  const batch_id = require_non_empty_string(payload, "batch_id");
  const token = require_non_empty_string(payload, "source_token");
  const owner_actor_id = runtime.actor_id;
  if (owner_actor_id === null) throw new ApiError("forbidden", "a human owner is required");

  const { batch, project, actor_id } = load_batch(runtime, batch_id);
  if (batch.state !== "staging" && batch.state !== "validated") {
    throw new ApiError("conflict", `a ${batch.state} import batch cannot be validated`);
  }
  const prepared = take_prepared_validation(owner_actor_id, token);
  if (prepared === undefined) {
    throw new ApiError("invalid_payload", "the source folder was not prepared for validation");
  }
  const objects_dir = require_objects_dir(runtime);

  const report = build_validation_report(runtime.db, {
    objects_dir,
    project_id: project.id,
    batch,
    prepared,
  });
  const ok = report.problems.length === 0;
  const state: "staging" | "validated" = ok ? "validated" : "staging";
  if (state !== batch.state) set_batch_state(runtime, batch, batch.state, state);

  const result = { batch_id: batch.id, project_id: project.id, ok, state, report };
  insert_receipt(runtime, {
    project_id: project.id,
    actor_id,
    action: "legacy.validate_import",
    base_control_rev: null,
    result,
  });
  return {
    result,
    events: [
      {
        type: ok ? "legacy.import_validated" : "legacy.import_validation_failed",
        payload: {
          batch_id: batch.id,
          project_id: project.id,
          ok,
          state,
          from_state: batch.state,
          problem_count: report.problems.length,
          problems: report.problems
            .slice(0, MAX_EVENT_PROBLEMS)
            .map((problem) => ({ check: problem.check, path: problem.path })),
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// legacy.activate_import

function run_activate_import(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["batch_id", "backup_dir", "pes_home"]);
  const batch_id = require_non_empty_string(payload, "batch_id");
  const backup_dir = require_non_empty_string(payload, "backup_dir");
  const pes_home = require_non_empty_string(payload, "pes_home");

  const { batch, project, actor_id } = load_batch(runtime, batch_id);
  if (batch.state !== "validated") {
    throw new ApiError("conflict", `only a validated import batch can be activated (it is ${batch.state})`);
  }
  if (project.status !== "staging") {
    throw new ApiError("conflict", `only a staging project can be activated (it is ${project.status})`);
  }
  const objects_dir = require_objects_dir(runtime);
  assert_backup_location(backup_dir, pes_home, objects_dir);

  // The backup comes first and is read from this very transaction: it shows the
  // project exactly as it is before the state changes. If it cannot be written
  // and verified, nothing is activated.
  try {
    export_project_in_tx(runtime.db, objects_dir, project.id, backup_dir);
  } catch (error) {
    if (error instanceof BackupError) {
      throw new ApiError("conflict", `the pre-activation backup could not be written: ${error.code}`);
    }
    throw error;
  }
  if (!verify_bundle(backup_dir).ok) {
    throw new ApiError("conflict", "the pre-activation backup did not verify");
  }

  set_batch_state(runtime, batch, "validated", "activated");
  set_project_status(runtime, project.id, "staging", "active");

  const result = { batch_id: batch.id, project_id: project.id, state: "activated" as const, backup_dir };
  insert_receipt(runtime, {
    project_id: project.id,
    actor_id,
    action: "legacy.activate_import",
    base_control_rev: null,
    result,
  });
  return {
    result,
    events: [
      {
        type: "legacy.import_activated",
        payload: { batch_id: batch.id, project_id: project.id, from_state: "validated" },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// legacy.rollback_before_write

/** True when the project has a business write after its activation. */
function has_write_after_activation(runtime: CommandRuntime, project_id: string): boolean {
  const activation = runtime.db.get<{ rid: bigint }>(
    `SELECT max(rowid) AS rid FROM mutation_commits
      WHERE project_id = ? AND action = 'legacy.activate_import'`,
    project_id,
  );
  const after = activation?.rid ?? null;
  // Without an activation receipt (a state that came back from a bundle) only
  // writes that did not come from the importer count.
  const written = runtime.db.get<{ n: bigint }>(
    `SELECT count(*) AS n FROM mutation_commits
      WHERE project_id = ? AND rowid > ? AND action NOT LIKE 'legacy.%'
        AND (? = 1 OR via <> 'import')`,
    project_id,
    after ?? 0n,
    after === null ? 0 : 1,
  );
  return (written?.n ?? 0n) > 0n;
}

function run_rollback_before_write(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["batch_id"]);
  const batch_id = require_non_empty_string(payload, "batch_id");

  const { batch, project, actor_id } = load_batch(runtime, batch_id);
  if (batch.state !== "staging" && batch.state !== "validated" && batch.state !== "activated") {
    throw new ApiError("conflict", `a ${batch.state} import batch cannot be rolled back`);
  }
  if (batch.state === "activated" && has_write_after_activation(runtime, project.id)) {
    throw new ApiError(
      "conflict",
      "the project has new writes after activation; use restore_project with the pre-activation bundle",
    );
  }
  const from_state = batch.state;
  set_batch_state(runtime, batch, from_state, "failed");
  set_project_status(runtime, project.id, project.status, "archived");

  const result = {
    batch_id: batch.id,
    project_id: project.id,
    state: "failed" as const,
    serving: "legacy_json" as const,
    from_state,
  };
  insert_receipt(runtime, {
    project_id: project.id,
    actor_id,
    action: "legacy.rollback_before_write",
    base_control_rev: null,
    result,
  });
  return {
    result,
    events: [
      {
        type: "legacy.import_rolled_back",
        payload: { batch_id: batch.id, project_id: project.id, from_state },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// legacy.restore_project

const SAFE_SEGMENT = /^[0-9A-Za-z._-]+$/;
const MAX_LOST_LISTED = 200;

/** Every object file of the bundle must land below this project's own folder. */
function assert_restorable_keys(prepared: PreparedProjectRestore, project_id: string): void {
  for (const object of prepared.objects) {
    const parts = object.storage_key.split("/");
    if (parts.length < 2 || parts[0] !== project_id || !parts.every((part) => SAFE_SEGMENT.test(part) && part !== "." && part !== "..")) {
      throw new ApiError("conflict", "the bundle holds an object file outside the project folder");
    }
  }
}

function iso_time(ms: bigint | number): string {
  try {
    return new Date(Number(ms)).toISOString();
  } catch {
    return String(ms);
  }
}

function same_bytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

/** Put the project's object files exactly as the bundle has them (PR9 file helpers). */
function restore_object_files(objects_dir: string, project_id: string, prepared: PreparedProjectRestore): void {
  const keep = new Set<string>();
  for (const object of prepared.objects) {
    keep.add(object.storage_key);
    let current: Uint8Array | undefined;
    try {
      current = read_storage_bytes(objects_dir, project_id, object.storage_key);
    } catch {
      current = undefined;
    }
    if (current === undefined || !same_bytes(current, object.bytes)) {
      write_storage_bytes(objects_dir, project_id, object.storage_key, object.bytes);
    }
  }
  // Files written after the bundle (and stray temporary files) are not part of it.
  for (const file of scan_project_files(objects_dir, project_id)) {
    if (!keep.has(file.key)) delete_project_file(objects_dir, project_id, file);
  }
}

function run_restore_project(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["project_id", "bundle_dir", "bundle_token"]);
  const project_id = require_non_empty_string(payload, "project_id");
  const bundle_dir = require_non_empty_string(payload, "bundle_dir");
  const token = require_non_empty_string(payload, "bundle_token");
  const owner_actor_id = runtime.actor_id;
  if (owner_actor_id === null) throw new ApiError("forbidden", "a human owner is required");

  const project = runtime.db.get<ProjectOwnerRow>(
    "SELECT id, status, owner_user_id FROM projects WHERE id = ?",
    project_id,
  );
  if (project === undefined) throw new ApiError("not_found", "the project was not found");
  const actor_id = require_project_owner(runtime, project);

  const handed = take_prepared_restore(owner_actor_id, token);
  if (handed === undefined || handed.project_id !== project_id) {
    throw new ApiError("invalid_payload", "the bundle was not prepared for this restore");
  }
  const prepared = handed.prepared;
  if (prepared.manifest.project_id !== project_id) {
    throw new ApiError("conflict", "the bundle belongs to another project");
  }
  const objects_dir = require_objects_dir(runtime);
  assert_restorable_keys(prepared, project_id);

  // What the restore takes away: commits that exist now but not in the bundle.
  const bundle_commits = new Set(prepared.commit_ids);
  const later = runtime.db
    .all<{ id: string; action: string; created_at: bigint }>(
      "SELECT id, action, created_at FROM mutation_commits WHERE project_id = ? ORDER BY rowid",
      project_id,
    )
    .filter((row) => !bundle_commits.has(row.id));
  const lost_writes: LostWrite[] = later
    .filter((row) => !row.action.startsWith("legacy."))
    .map((row) => ({ action: row.action, created_at: iso_time(row.created_at) }));
  const reverted_steps = later.filter((row) => row.action.startsWith("legacy.")).map((row) => row.action);

  const before = runtime.db.get<{ cursor_epoch: bigint }>("SELECT cursor_epoch FROM db_meta WHERE id = 1");
  if (before === undefined) throw new Error("db_meta row with id = 1 is missing");

  let epoch_after: bigint;
  try {
    epoch_after = replace_project_rows_in_tx(runtime.db, prepared, project_id);
  } catch (error) {
    if (error instanceof BackupError) {
      throw new ApiError("conflict", `the project cannot be restored from this bundle: ${error.code}`);
    }
    throw error;
  }
  // Rows that other projects keep pointing at must still exist; otherwise the
  // whole restore is refused here, before any file is touched.
  if (!foreign_keys_hold(runtime.db)) {
    throw new ApiError("conflict", "the restore would break references from other rows");
  }

  const result = {
    project_id,
    bundle_dir,
    cursor_epoch_before: before.cursor_epoch.toString(),
    cursor_epoch_after: epoch_after.toString(),
    lost_writes,
    reverted_steps,
  };
  insert_receipt(runtime, {
    project_id,
    actor_id,
    action: "legacy.restore_project",
    base_control_rev: null,
    result,
  });

  // Files last: they cannot be rolled back with the transaction.
  restore_object_files(objects_dir, project_id, prepared);

  return {
    result,
    events: [
      {
        type: "legacy.project_restored",
        payload: {
          project_id,
          lost_writes: lost_writes.length,
          lost: lost_writes.slice(0, MAX_LOST_LISTED),
          reverted_steps,
          cursor_epoch_before: before.cursor_epoch.toString(),
          cursor_epoch: epoch_after.toString(),
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Registry entries (merged into COMMANDS by commands.ts)

function owner_command(action: string, run: (runtime: CommandRuntime) => CommandResult): CommandDefinition {
  return Object.freeze({ action, scope: "owner", rev_bearing: false, run });
}

const MIGRATION_COMMAND_INPUTS: ReadonlyArray<readonly [string, CommandDefinition]> = [
  ["legacy.validate_import", owner_command("legacy.validate_import", run_validate_import)],
  ["legacy.activate_import", owner_command("legacy.activate_import", run_activate_import)],
  ["legacy.rollback_before_write", owner_command("legacy.rollback_before_write", run_rollback_before_write)],
  ["legacy.restore_project", owner_command("legacy.restore_project", run_restore_project)],
];

export const MIGRATION_COMMAND_ENTRIES: ReadonlyArray<readonly [string, CommandDefinition]> =
  Object.freeze(MIGRATION_COMMAND_INPUTS.map((entry) => Object.freeze([entry[0], entry[1]] as const)));

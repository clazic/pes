// File and object storage command definitions (stage 2 PR9).
//
// These definitions hold the only SQL for blobs, file_policies and
// version_files. The public functions in scripts/pes_core/files.ts call
// CommandService.execute once per command, so every write still passes the
// registry, project/actor check, policy, receipt replay, change, and events +
// receipt in one transaction.
//
// Rules:
// - storage_key is computed here from the project id and sha256; a caller never
//   supplies a path, URL or key.
// - A blob moves staging -> ready only after the public wrapper has re-read the
//   stored bytes and measured them. A mismatch quarantines it instead.
// - The same (project, sha256, size) is one blobs row; lineage stays in
//   version_files, one row per (version, blob, role).
// - A linked ready blob is never quarantined or deleted. Orphan/quarantined
//   rows are removed only by file.gc_orphans; bytes are deleted by the wrapper
//   after this transaction commits.
//
// file.gc_orphans also receives the objects folder from its public wrapper so
// the command can report missing ready files and count stale orphan files. The
// folder is never placed in a result, an event or a receipt.

import { isAbsolute } from "node:path";

import { ApiError } from "../errors.ts";
import {
  require_safe_id,
  scan_project_files,
  storage_file_is_regular,
} from "../files.ts";
import {
  insert_receipt,
  reject_unknown_fields,
  require_non_empty_string,
  require_record,
  type CommandDefinition,
  type CommandResult,
  type CommandRuntime,
} from "./shared.ts";

const ROLES = new Set(["attachment", "image", "source", "rendered", "manifest"]);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const RESERVE_FIELDS = ["sha256", "size", "media_type", "original_name"] as const;
const COMPLETE_FIELDS = ["blob_id", "sha256", "size"] as const;
const ATTACH_FIELDS = ["version_id", "blob_id", "role"] as const;
const QUARANTINE_FIELDS = ["blob_id", "reason"] as const;
const GC_FIELDS = ["grace_ms", "objects_dir"] as const;

const RESERVED_EVENT = "file.upload_reserved";

interface FileScope {
  project_id: string;
  actor_id: string;
}

interface BlobRow {
  id: string;
  project_id: string;
  storage_key: string;
  sha256: string;
  size: bigint;
  media_type: string;
  original_name: string | null;
  state: string;
}

function invalid(message: string): never {
  throw new ApiError("invalid_payload", message);
}

function scope_of(runtime: CommandRuntime): FileScope {
  const project = runtime.project;
  const actor_id = runtime.actor_id;
  if (project === null || actor_id === null) {
    throw new Error("a file command must resolve a project and actor first");
  }
  return { project_id: project.id, actor_id };
}

function require_blob_id(payload: Record<string, unknown>): string {
  if (!("blob_id" in payload)) invalid("blob_id is required");
  return require_safe_id(payload.blob_id, "blob_id");
}

function require_sha256(payload: Record<string, unknown>): string {
  const value = payload.sha256;
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    return invalid("sha256 must be 64 lowercase hexadecimal characters");
  }
  return value;
}

function require_size(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalid(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function optional_text(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.isWellFormed()) {
    throw new ApiError("invalid_payload", `${field} must be a string or null`);
  }
  return value;
}

function read_blob(
  runtime: CommandRuntime,
  project_id: string,
  blob_id: string,
): BlobRow | undefined {
  return runtime.db.get<BlobRow>(
    `SELECT id, project_id, storage_key, sha256, size, media_type, original_name, state
       FROM blobs WHERE project_id = ? AND id = ?`,
    project_id,
    blob_id,
  );
}

function find_version(runtime: CommandRuntime, project_id: string, version_id: string): void {
  const version = runtime.db.get<{ ok: bigint }>(
    "SELECT 1 AS ok FROM object_versions WHERE project_id = ? AND id = ?",
    project_id,
    version_id,
  );
  if (version === undefined) {
    throw new ApiError("not_found", "version not found");
  }
}

// ---------------------------------------------------------------------------
// file.reserve_upload

function run_reserve_upload(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, RESERVE_FIELDS);
  const sha256 = require_sha256(payload);
  const size = require_size(payload.size, "size");
  const media_type = require_non_empty_string(payload, "media_type");
  const original_name = optional_text(payload, "original_name");
  const scope = scope_of(runtime);

  const existing = runtime.db.get<BlobRow>(
    `SELECT id, project_id, storage_key, sha256, size, media_type, original_name, state
       FROM blobs WHERE project_id = ? AND sha256 = ? AND size = ?`,
    scope.project_id,
    sha256,
    size,
  );

  const result =
    existing === undefined
      ? {
          project_id: scope.project_id,
          blob_id: runtime.new_id(),
          state: "staging",
          deduplicated: false,
        }
      : {
          project_id: scope.project_id,
          blob_id: existing.id,
          state: existing.state,
          deduplicated: existing.state !== "staging",
        };

  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "file.upload_reserved",
    base_control_rev: null,
    result,
  });

  if (existing === undefined) {
    const written = runtime.db.run(
      `INSERT INTO blobs
         (id, project_id, storage_key, sha256, size, media_type, original_name, state, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'staging', ?)`,
      result.blob_id,
      scope.project_id,
      `${scope.project_id}/${sha256}`,
      sha256,
      size,
      media_type,
      original_name,
      scope.actor_id,
    );
    if (written.changes !== 1n) {
      throw new Error("the blob reservation was not written");
    }
  }

  return {
    result,
    events: [
      {
        type: RESERVED_EVENT,
        payload: {
          blob_id: result.blob_id,
          state: result.state,
          deduplicated: result.deduplicated,
          sha256,
          size,
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// file.complete_upload

function run_complete_upload(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, COMPLETE_FIELDS);
  const blob_id = require_blob_id(payload);
  const observed_sha256 = require_sha256(payload);
  const observed_size = require_size(payload.size, "size");
  const scope = scope_of(runtime);

  const blob = read_blob(runtime, scope.project_id, blob_id);
  if (blob === undefined) {
    throw new ApiError("not_found", "blob not found");
  }
  if (blob.state !== "staging") {
    throw new ApiError("conflict", "the blob is not staging");
  }

  const matches = blob.sha256 === observed_sha256 && Number(blob.size) === observed_size;
  const next_state = matches ? "ready" : "quarantined";
  const result = { project_id: scope.project_id, blob_id, state: next_state };

  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "file.upload_completed",
    base_control_rev: null,
    result,
  });
  const written = runtime.db.run(
    "UPDATE blobs SET state = ? WHERE project_id = ? AND id = ? AND state = 'staging'",
    next_state,
    scope.project_id,
    blob_id,
  );
  if (written.changes !== 1n) {
    throw new ApiError("conflict", "the blob is not staging");
  }

  return {
    result,
    events: [
      {
        type: matches ? "file.upload_completed" : "file.upload_quarantined",
        payload: {
          blob_id,
          state: next_state,
          declared_sha256: blob.sha256,
          declared_size: Number(blob.size),
          observed_sha256,
          observed_size,
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// file.attach_version

function run_attach_version(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ATTACH_FIELDS);
  const version_id = require_safe_id(payload.version_id, "version_id");
  const blob_id = require_blob_id(payload);
  const role = payload.role;
  if (typeof role !== "string" || !ROLES.has(role)) {
    invalid("role is not an allowed file role");
  }
  const scope = scope_of(runtime);

  find_version(runtime, scope.project_id, version_id);
  const blob = read_blob(runtime, scope.project_id, blob_id);
  if (blob === undefined) {
    throw new ApiError("not_found", "blob not found");
  }
  if (blob.state !== "ready") {
    throw new ApiError("conflict", "only a ready blob can be attached");
  }
  const duplicate = runtime.db.get<{ ok: bigint }>(
    `SELECT 1 AS ok FROM version_files
      WHERE project_id = ? AND version_id = ? AND blob_id = ? AND role = ?`,
    scope.project_id,
    version_id,
    blob_id,
    role,
  );
  if (duplicate !== undefined) {
    throw new ApiError("conflict", "the version already has this blob in this role");
  }

  const existing_policy = runtime.db.get<{ id: string }>(
    "SELECT id FROM file_policies WHERE project_id = ? AND blob_id = ?",
    scope.project_id,
    blob_id,
  );
  const file_policy_id = existing_policy?.id ?? runtime.new_id();
  const result = {
    project_id: scope.project_id,
    version_id,
    blob_id,
    role,
    file_policy_id,
  };

  // The policy row references this receipt through tx_id, so the receipt is
  // written first. The blob's one policy is shared by every role and version.
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "file.version_attached",
    base_control_rev: null,
    result,
  });

  if (existing_policy === undefined) {
    const actor = runtime.db.get<{ user_id: string }>(
      "SELECT user_id FROM actors WHERE id = ?",
      scope.actor_id,
    );
    if (actor === undefined) throw new Error("the actor user was not found");
    const policy = runtime.db.run(
      `INSERT INTO file_policies
         (id, project_id, blob_id, ai_access, rev, changed_by_actor_id, changed_by_user_id,
          changed_at, reason, tx_id)
       VALUES (?, ?, ?, 'allow', 1, ?, ?, ?, NULL, ?)`,
      file_policy_id,
      scope.project_id,
      blob_id,
      scope.actor_id,
      actor.user_id,
      runtime.now_ms,
      runtime.tx_id,
    );
    if (policy.changes !== 1n) throw new Error("the file policy was not written");
  }

  const written = runtime.db.run(
    `INSERT INTO version_files (project_id, version_id, blob_id, role, file_policy_id)
     VALUES (?, ?, ?, ?, ?)`,
    scope.project_id,
    version_id,
    blob_id,
    role,
    file_policy_id,
  );
  if (written.changes !== 1n) throw new Error("the version file was not written");

  return {
    result,
    events: [
      {
        type: "file.version_attached",
        payload: { version_id, blob_id, role, file_policy_id },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// file.quarantine

function run_quarantine(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, QUARANTINE_FIELDS);
  const blob_id = require_blob_id(payload);
  const reason = require_non_empty_string(payload, "reason");
  const scope = scope_of(runtime);

  const blob = read_blob(runtime, scope.project_id, blob_id);
  if (blob === undefined) {
    throw new ApiError("not_found", "blob not found");
  }
  if (blob.state === "quarantined") {
    throw new ApiError("conflict", "the blob is already quarantined");
  }
  if (blob.state === "ready") {
    const linked = runtime.db.get<{ ok: bigint }>(
      "SELECT 1 AS ok FROM version_files WHERE project_id = ? AND blob_id = ?",
      scope.project_id,
      blob_id,
    );
    if (linked !== undefined) {
      throw new ApiError("conflict", "a linked ready blob is never quarantined");
    }
  }
  if (blob.state !== "staging" && blob.state !== "ready") {
    throw new ApiError("conflict", "the blob cannot be quarantined in its current state");
  }

  const result = { project_id: scope.project_id, blob_id, state: "quarantined" };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "file.blob_quarantined",
    base_control_rev: null,
    result,
  });
  const written = runtime.db.run(
    "UPDATE blobs SET state = 'quarantined' WHERE project_id = ? AND id = ? AND state = ?",
    scope.project_id,
    blob_id,
    blob.state,
  );
  if (written.changes !== 1n) {
    throw new ApiError("conflict", "the blob cannot be quarantined in its current state");
  }

  return {
    result,
    events: [
      {
        type: "file.blob_quarantined",
        payload: { blob_id, reason, previous_state: blob.state },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// file.gc_orphans

function optional_objects_dir(payload: Record<string, unknown>): string | null {
  const value = payload.objects_dir;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
    return invalid("objects_dir must be an absolute path");
  }
  return value;
}

function reservation_time(
  runtime: CommandRuntime,
  project_id: string,
  blob_id: string,
): number | null {
  const row = runtime.db.get<{ created_at: bigint | null }>(
    `SELECT MIN(created_at) AS created_at FROM events
      WHERE project_id = ? AND type = ? AND json_extract(payload, '$.blob_id') = ?`,
    project_id,
    RESERVED_EVENT,
    blob_id,
  );
  if (row === undefined || row.created_at === null) return null;
  return Number(row.created_at);
}

function run_gc_orphans(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, GC_FIELDS);
  const grace_ms = require_size(payload.grace_ms, "grace_ms");
  if (grace_ms < 1) invalid("grace_ms must be a positive safe integer");
  const objects_dir = optional_objects_dir(payload);
  const scope = scope_of(runtime);
  const project_id = scope.project_id;

  // The claimed set is taken before any deletion: a file whose blob row is
  // removed in this call is not counted as an orphan file.
  const claimed = new Set<string>();
  for (const row of runtime.db.all<{ storage_key: string }>(
    "SELECT storage_key FROM blobs WHERE project_id = ?",
    project_id,
  )) {
    claimed.add(row.storage_key);
  }

  const deleted_blob_ids: string[] = [];
  const candidates = runtime.db.all<{ id: string; state: string }>(
    `SELECT id, state FROM blobs
      WHERE project_id = ? AND state IN ('staging', 'quarantined')
      ORDER BY rowid`,
    project_id,
  );
  for (const candidate of candidates) {
    const linked = runtime.db.get<{ ok: bigint }>(
      "SELECT 1 AS ok FROM version_files WHERE project_id = ? AND blob_id = ?",
      project_id,
      candidate.id,
    );
    if (linked !== undefined) continue;
    const policy = runtime.db.get<{ ok: bigint }>(
      "SELECT 1 AS ok FROM file_policies WHERE project_id = ? AND blob_id = ?",
      project_id,
      candidate.id,
    );
    if (policy !== undefined) continue;
    const created_at = reservation_time(runtime, project_id, candidate.id);
    if (created_at === null) continue;
    if (runtime.now_ms - created_at <= grace_ms) continue;
    const removed = runtime.db.run(
      "DELETE FROM blobs WHERE project_id = ? AND id = ? AND state IN ('staging', 'quarantined')",
      project_id,
      candidate.id,
    );
    if (removed.changes !== 1n) {
      throw new Error("a stale blob was not removed");
    }
    deleted_blob_ids.push(candidate.id);
  }

  const missing_file_blob_ids: string[] = [];
  let orphan_files_removed = 0;
  if (objects_dir !== null) {
    for (const row of runtime.db.all<{ id: string; storage_key: string }>(
      "SELECT id, storage_key FROM blobs WHERE project_id = ? AND state = 'ready' ORDER BY rowid",
      project_id,
    )) {
      if (!storage_file_is_regular(objects_dir, project_id, row.storage_key)) {
        missing_file_blob_ids.push(row.id);
      }
    }
    for (const file of scan_project_files(objects_dir, project_id)) {
      if (claimed.has(file.key)) continue;
      if (runtime.now_ms - file.mtime_ms > grace_ms) orphan_files_removed += 1;
    }
  }

  const result = {
    project_id,
    deleted_blob_ids,
    orphan_files_removed,
    missing_file_blob_ids,
  };
  insert_receipt(runtime, {
    project_id,
    actor_id: scope.actor_id,
    action: "file.orphans_collected",
    base_control_rev: null,
    result,
  });

  return {
    result,
    events: [
      {
        type: "file.orphans_collected",
        payload: {
          grace_ms,
          deleted_blob_ids,
          orphan_files_removed,
          missing_file_blob_ids,
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// registry

function definition(
  action: string,
  run: (runtime: CommandRuntime) => CommandResult,
): CommandDefinition {
  return Object.freeze({ action, scope: "project", rev_bearing: false, run });
}

const FILE_COMMAND_INPUTS: ReadonlyArray<readonly [string, CommandDefinition]> = [
  ["file.reserve_upload", definition("file.upload_reserved", run_reserve_upload)],
  ["file.complete_upload", definition("file.upload_completed", run_complete_upload)],
  ["file.attach_version", definition("file.version_attached", run_attach_version)],
  ["file.quarantine", definition("file.blob_quarantined", run_quarantine)],
  ["file.gc_orphans", definition("file.orphans_collected", run_gc_orphans)],
];

/** Registry entries merged into COMMANDS by commands.ts (names, not actions). */
export const FILE_COMMAND_ENTRIES: ReadonlyArray<readonly [string, CommandDefinition]> =
  Object.freeze(FILE_COMMAND_INPUTS.map((entry) => Object.freeze([entry[0], entry[1]] as const)));

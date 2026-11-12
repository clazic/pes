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
// - A blob moves staging -> ready only after the command has re-read the
//   stored bytes from its injected object store and measured them. A mismatch
//   quarantines it instead, and a command without a store fails closed.
// - The same (project, sha256, size) is one blobs row; lineage stays in
//   version_files, one row per (version, blob, role).
// - A linked ready blob is never quarantined or deleted. Orphan/quarantined
//   rows are removed only by file.gc_orphans; bytes are deleted by the wrapper
//   after this transaction commits.
//
// file.gc_orphans scans the objects folder injected at CommandService
// construction so the command can report missing ready files and count stale
// orphan files. The folder is never placed in a result, an event or a receipt.

import { createRequire } from "node:module";

import { ApiError } from "../errors.ts";
import {
  is_safe_media_type,
  read_storage_bytes,
  require_safe_id,
  scan_project_files,
  sha256_hex,
  storage_file_is_regular,
  write_storage_bytes,
} from "../files.ts";
import {
  content_digest,
  set_first_current_version,
  source_digest_fields,
  write_object,
  write_object_version,
  write_source_version,
  type SourceFacts,
} from "./content.ts";
import { access_state_of_blob, access_state_of_policy, material_object_denied } from "./file_access.ts";
import {
  EXTRACTOR,
  EXTRACTOR_VERSION,
  MAX_SOURCE_BYTES,
  format_of,
  too_large_outcome,
  type ExtractOutcome,
} from "../file_extract.ts";
import {
  closed_to_ai,
  event_payload,
  existing_extraction,
  extraction_result,
  hide_closed_text,
  find_target,
  require_id_field,
  text_name_of,
} from "./file_extractions.ts";
import {
  insert_receipt,
  reject_unknown_fields,
  require_human_owner_actor,
  require_non_empty_string,
  require_record,
  type CommandDefinition,
  type CommandResult,
  type CommandRuntime,
  is_human_actor,
} from "./shared.ts";

const ROLES = new Set(["attachment", "image", "source", "rendered", "manifest"]);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const RESERVE_FIELDS = ["sha256", "size", "media_type", "original_name"] as const;
const COMPLETE_FIELDS = ["blob_id", "sha256", "size"] as const;
const ATTACH_FIELDS = ["version_id", "blob_id", "role"] as const;
const QUARANTINE_FIELDS = ["blob_id", "reason"] as const;
const GC_FIELDS = ["grace_ms"] as const;
const UPLOAD_FIELDS = ["blob_id", "title", "object_id", "role"] as const;
const ACCESS_FIELDS = ["file_policy_id", "ai_access", "reason"] as const;
const AI_ACCESS_VALUES = new Set(["allow", "deny"]);
const MAX_TITLE_CHARS = 300;
const MAX_REASON_CHARS = 1000;

const RESERVED_EVENT = "file.upload_reserved";

/**
 * Every table in 001_initial.sql whose foreign key points at blobs. A blob
 * referenced by any of these is "linked": gc must not delete it and quarantine
 * must refuse it. Checking all of them also keeps gc from failing on a
 * RESTRICT foreign key after a row the command did not know about appears.
 */
const BLOB_REFERENCES: ReadonlyArray<readonly [table: string, column: string]> = [
  ["version_files", "blob_id"],
  ["file_policies", "blob_id"],
  ["snapshots", "manifest_blob_id"],
  ["artifact_versions", "body_blob_id"],
  ["source_versions", "evidence_blob_id"],
  ["file_extractions", "blob_id"],
  ["file_extractions", "text_blob_id"],
  ["sync_items", "blob_id"],
  ["submissions", "raw_blob_id"],
  ["outbound_dispatches", "manifest_blob_id"],
  ["outbound_dispatches", "response_blob_id"],
  ["import_batches", "source_manifest_blob_id"],
  ["import_batches", "report_blob_id"],
];

const BLOB_LINKED_SQL = `SELECT (${BLOB_REFERENCES.map(
  ([table, column]) => `EXISTS (SELECT 1 FROM ${table} WHERE project_id = ? AND ${column} = ?)`,
).join(" OR ")}) AS linked`;

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

/** An optional caller claim. It can only force quarantine, never make a blob ready. */
function optional_sha256(payload: Record<string, unknown>): string | null {
  const value = payload.sha256;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    return invalid("sha256 must be 64 lowercase hexadecimal characters");
  }
  return value;
}

/** An optional caller claim, checked the same way as optional_sha256. */
function optional_size(payload: Record<string, unknown>): number | null {
  const value = payload.size;
  if (value === undefined || value === null) return null;
  return require_size(value, "size");
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

/** True when any table that references blobs points at this blob. */
function blob_is_linked(runtime: CommandRuntime, project_id: string, blob_id: string): boolean {
  const params: string[] = [];
  for (let index = 0; index < BLOB_REFERENCES.length; index += 1) {
    params.push(project_id, blob_id);
  }
  const row = runtime.db.get<{ linked: bigint }>(BLOB_LINKED_SQL, ...params);
  return Number(row?.linked ?? 0n) !== 0;
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
// A ready blob written inside another command's transaction (input.record_chat with `web`, PR18)

/**
 * Add a blob row that is already `ready` (its bytes are in the object store and were measured by the caller).
 * Used only by the one command that stores a screen answer's raw file in the same commit as its submission;
 * every blob table write stays in this module. Returns the existing blob id when the project already has these bytes.
 */
export function insert_ready_blob(
  runtime: CommandRuntime,
  fields: { project_id: string; actor_id: string; sha256: string; size: number; media_type: string; original_name: string },
): { blob_id: string; created: boolean } {
  const known = runtime.db.get<{ id: string }>(
    "SELECT id FROM blobs WHERE project_id = ? AND sha256 = ? AND size = ?",
    fields.project_id,
    fields.sha256,
    fields.size,
  );
  if (known !== undefined) return { blob_id: known.id, created: false };
  const blob_id = runtime.new_id();
  const written = runtime.db.run(
    `INSERT INTO blobs
       (id, project_id, storage_key, sha256, size, media_type, original_name, state, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?)`,
    blob_id,
    fields.project_id,
    `${fields.project_id}/${fields.sha256}`,
    fields.sha256,
    fields.size,
    fields.media_type,
    fields.original_name,
    fields.actor_id,
  );
  if (written.changes !== 1n) throw new Error("the blob was not recorded");
  return { blob_id, created: true };
}

// ---------------------------------------------------------------------------
// file.reserve_upload

function run_reserve_upload(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, RESERVE_FIELDS);
  const sha256 = require_sha256(payload);
  const size = require_size(payload.size, "size");
  const media_type = require_non_empty_string(payload, "media_type");
  if (!is_safe_media_type(media_type)) {
    throw new ApiError("invalid_payload", "media_type must be a plain MIME type such as text/plain");
  }
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

function write_complete_state(
  runtime: CommandRuntime,
  scope: FileScope,
  blob_id: string,
  next_state: "ready" | "quarantined",
  reason: string | null,
): CommandResult {
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
        type: next_state === "ready" ? "file.upload_completed" : "file.upload_quarantined",
        payload:
          reason === null
            ? { blob_id, state: next_state }
            : { blob_id, state: next_state, reason },
      },
    ],
  };
}

function run_complete_upload(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, COMPLETE_FIELDS);
  const blob_id = require_blob_id(payload);
  const claimed_sha256 = optional_sha256(payload);
  const claimed_size = optional_size(payload);
  const scope = scope_of(runtime);

  const blob = read_blob(runtime, scope.project_id, blob_id);
  if (blob === undefined) {
    throw new ApiError("not_found", "blob not found");
  }
  if (blob.state !== "staging") {
    throw new ApiError("conflict", "the blob is not staging");
  }

  // A caller-supplied hash or size is an untrusted claim. It can only force
  // quarantine; stored bytes are still measured below before anything is ready.
  if (
    (claimed_sha256 !== null && claimed_sha256 !== blob.sha256) ||
    (claimed_size !== null && claimed_size !== Number(blob.size))
  ) {
    return write_complete_state(runtime, scope, blob_id, "quarantined", "claim_mismatch");
  }

  const objects_dir = runtime.objects_dir;
  if (objects_dir === null) {
    // Fail closed: without the store the command cannot verify the bytes, so it
    // must not let a caller's numbers make the blob ready.
    throw new ApiError("conflict", "no object store is configured for file.complete_upload");
  }
  let bytes: Uint8Array;
  try {
    bytes = read_storage_bytes(objects_dir, scope.project_id, blob.storage_key);
  } catch {
    throw new ApiError("conflict", "the stored bytes of the blob are not readable");
  }
  const observed_sha256 = sha256_hex(bytes);
  const observed_size = bytes.byteLength;
  const matches = observed_sha256 === blob.sha256 && observed_size === Number(blob.size);
  return write_complete_state(
    runtime,
    scope,
    blob_id,
    matches ? "ready" : "quarantined",
    matches ? null : "stored_bytes_mismatch",
  );
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
// file.upload — a user's own material (SEL-115 MAT1a)
//
// A "material" is a source object of kind file. Its current version carries one ready blob through version_files.
// The blob has ONE policy row shared by every use: the first attach creates it as allow (rev 1), a later upload of
// the same bytes reuses it, so a re-upload can never reset a deny. No new table: objects, sources, object_versions,
// source_versions, version_files and file_policies already exist.

interface MaterialObjectRow {
  id: string;
  kind: string;
  source_kind: string | null;
  current_version_id: string | null;
  rev: bigint;
}

function upload_role(value: unknown): string {
  if (value === undefined || value === null) return "attachment";
  if (typeof value !== "string" || !ROLES.has(value)) invalid("role is not an allowed file role");
  return value;
}

function upload_title(payload: Record<string, unknown>): string | null {
  const text = optional_text(payload, "title");
  if (text === null || text.trim().length === 0) return null;
  if (text.length > MAX_TITLE_CHARS) invalid(`title must be at most ${MAX_TITLE_CHARS} characters`);
  return text;
}

/** Cut to at most `max` UTF-16 units without splitting a surrogate pair (an emoji at the boundary is dropped whole). */
function truncate_code_points(text: string, max: number): string {
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function run_upload(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, UPLOAD_FIELDS);
  const blob_id = require_blob_id(payload);
  const role = upload_role(payload.role);
  const given_title = upload_title(payload);
  const target_object_id =
    payload.object_id === undefined || payload.object_id === null ? null : require_safe_id(payload.object_id, "object_id");
  const scope = scope_of(runtime);

  const blob = read_blob(runtime, scope.project_id, blob_id);
  if (blob === undefined) throw new ApiError("not_found", "blob not found");
  // SEL-115 review 2 N1: a caller that is not human goes through the same decision as every read exit (file_ai_denied).
  // A closed blob (or a material object that carries one) answers exactly like an unknown one — before any receipt or write —
  // so a reserved duplicate (same bytes → blob_id) cannot be turned into the file's name, policy id or deny state.
  const human = is_human_actor(runtime);
  if (!human) {
    const closed = access_state_of_blob(runtime.db, scope.project_id, blob_id)?.effective === "deny";
    if (closed) throw new ApiError("not_found", "blob not found");
    if (target_object_id !== null && material_object_denied(runtime.db, scope.project_id, target_object_id)) {
      throw new ApiError("not_found", "object not found");
    }
  }
  if (blob.state !== "ready") throw new ApiError("conflict", "only a ready blob can become a material");

  let object: MaterialObjectRow | null = null;
  let version_no = 1;
  let title = given_title ?? blob.original_name ?? "자료";
  if (target_object_id !== null) {
    const found = runtime.db.get<MaterialObjectRow>(
      `SELECT o.id AS id, o.kind AS kind, s.kind AS source_kind, o.current_version_id AS current_version_id, o.rev AS rev
         FROM objects o
         LEFT JOIN sources s ON s.project_id = o.project_id AND s.object_id = o.id
        WHERE o.project_id = ? AND o.id = ?`,
      scope.project_id,
      target_object_id,
    );
    if (found === undefined) throw new ApiError("not_found", "object not found");
    if (found.kind !== "source" || found.source_kind !== "file" || found.current_version_id === null) {
      throw new ApiError("conflict", "the object is not a material");
    }
    const duplicate = runtime.db.get<{ ok: bigint }>(
      `SELECT 1 AS ok FROM version_files vf
         JOIN object_versions ov ON ov.project_id = vf.project_id AND ov.id = vf.version_id
        WHERE ov.project_id = ? AND ov.object_id = ? AND vf.blob_id = ? AND vf.role = ?`,
      scope.project_id,
      target_object_id,
      blob_id,
      role,
    );
    if (duplicate !== undefined) {
      throw new ApiError("conflict", "the material already has this file in this role");
    }
    const latest = runtime.db.get<{ max_no: bigint | null }>(
      "SELECT MAX(version_no) AS max_no FROM object_versions WHERE project_id = ? AND object_id = ?",
      scope.project_id,
      target_object_id,
    );
    version_no = Number(latest?.max_no ?? 0n) + 1;
    if (given_title === null) {
      const current = runtime.db.get<{ title: string }>(
        "SELECT title FROM source_versions WHERE project_id = ? AND version_id = ?",
        scope.project_id,
        found.current_version_id,
      );
      title = current?.title ?? title;
    }
    object = found;
  }
  if (title.length > MAX_TITLE_CHARS) title = truncate_code_points(title, MAX_TITLE_CHARS);

  const known_policy = access_state_of_blob(runtime.db, scope.project_id, blob_id);
  const file_policy_id = known_policy?.policy_id ?? runtime.new_id();
  const ai_access = known_policy?.effective ?? "allow";
  const object_id = object?.id ?? runtime.new_id();
  const version_id = runtime.new_id();
  // `ai_access` is the human's view of the switch; an AI caller never gets the key (MaterialDto). The receipt stores what this
  // caller was given, and a replay is the same caller's.
  const result = {
    object_id,
    version_id,
    version_no,
    blob_id,
    file_policy_id,
    role,
    ...(human ? { ai_access } : {}),
    original_name: blob.original_name,
    media_type: blob.media_type,
    size: Number(blob.size),
    sha256: blob.sha256,
  };

  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "file.material_uploaded",
    base_control_rev: null,
    result,
  });

  if (object === null) {
    write_object(runtime, scope.project_id, object_id, "source", null, null);
  }
  const facts: SourceFacts = {
    title,
    url: null,
    locator: {},
    retrieved_at: runtime.now_ms,
    method: "import",
    verification_state: "unverified",
    quote: null,
    verified_by_actor_id: null,
  };
  write_object_version(runtime, {
    project_id: scope.project_id,
    object_id,
    kind: "source",
    version_id,
    version_no,
    based_on_version_id: object?.current_version_id ?? null,
    actor_id: scope.actor_id,
    content_hash: content_digest("source", {
      ...source_digest_fields(facts),
      file: { sha256: blob.sha256, size: Number(blob.size), role },
    }),
  });
  if (object === null) {
    const side = runtime.db.run(
      "INSERT INTO sources (project_id, object_id, kind, canonical_locator) VALUES (?, ?, 'file', NULL)",
      scope.project_id,
      object_id,
    );
    if (side.changes !== 1n) throw new Error("the material source was not written");
  }
  write_source_version(runtime, { project_id: scope.project_id, object_id, version_id, facts });

  if (known_policy === undefined) {
    const actor = runtime.db.get<{ user_id: string }>("SELECT user_id FROM actors WHERE id = ?", scope.actor_id);
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
  const linked = runtime.db.run(
    `INSERT INTO version_files (project_id, version_id, blob_id, role, file_policy_id)
     VALUES (?, ?, ?, ?, ?)`,
    scope.project_id,
    version_id,
    blob_id,
    role,
    file_policy_id,
  );
  if (linked.changes !== 1n) throw new Error("the version file was not written");

  if (object === null) {
    set_first_current_version(runtime, scope.project_id, object_id, version_id);
  } else {
    const moved = runtime.db.run(
      "UPDATE objects SET current_version_id = ?, rev = rev + 1 WHERE project_id = ? AND id = ? AND rev = ?",
      version_id,
      scope.project_id,
      object_id,
      object.rev,
    );
    if (moved.changes !== 1n) throw new ApiError("conflict", "the material moved concurrently");
  }

  return {
    result,
    events: [
      {
        type: "file.material_uploaded",
        payload: { object_id, version_id, version_no, blob_id, file_policy_id, role, new_material: object === null },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// file.ai_access_set — the AI-reference switch of one file (human owner only)
//
// The history (file_ai_access_versions) only grows: a change adds one row with rev = (newest rev) + 1 and puts the
// same value and rev on the policy row. Setting the value already in force writes no history row and changes no rev.
// "In force" is the strict side: a deny in the policy row or the newest history row counts as deny (file_access.ts).

function run_ai_access_set(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ACCESS_FIELDS);
  const file_policy_id = require_safe_id(payload.file_policy_id, "file_policy_id");
  const wanted = payload.ai_access;
  if (typeof wanted !== "string" || !AI_ACCESS_VALUES.has(wanted)) invalid('ai_access must be "allow" or "deny"');
  const reason = optional_text(payload, "reason");
  if (reason !== null && reason.length > MAX_REASON_CHARS) invalid(`reason must be at most ${MAX_REASON_CHARS} characters`);
  const scope = scope_of(runtime);
  const actor_id = require_human_owner_actor(runtime);

  const state = access_state_of_policy(runtime.db, scope.project_id, file_policy_id);
  if (state === undefined) throw new ApiError("not_found", "file policy not found");

  const changed = state.effective !== wanted;
  const next_rev = Math.max(state.rev, state.latest_rev) + 1;
  const result = {
    file_policy_id,
    blob_id: state.blob_id,
    ai_access: wanted,
    rev: changed ? next_rev : state.rev,
    changed,
  };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id,
    action: "file.ai_access_changed",
    base_control_rev: null,
    result,
  });

  if (changed) {
    const actor = runtime.db.get<{ user_id: string }>("SELECT user_id FROM actors WHERE id = ?", actor_id);
    if (actor === undefined) throw new Error("the actor user was not found");
    const history = runtime.db.run(
      `INSERT INTO file_ai_access_versions
         (id, project_id, file_policy_id, ai_access, changed_by_actor_id, changed_by_user_id,
          changed_at, reason, rev, tx_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      runtime.new_id(),
      scope.project_id,
      file_policy_id,
      wanted,
      actor_id,
      actor.user_id,
      runtime.now_ms,
      reason,
      next_rev,
      runtime.tx_id,
    );
    if (history.changes !== 1n) throw new Error("the access history row was not written");
    const policy = runtime.db.run(
      `UPDATE file_policies
          SET ai_access = ?, rev = ?, changed_by_actor_id = ?, changed_by_user_id = ?,
              changed_at = ?, reason = ?, tx_id = ?
        WHERE project_id = ? AND id = ? AND rev = ?`,
      wanted,
      next_rev,
      actor_id,
      actor.user_id,
      runtime.now_ms,
      reason,
      runtime.tx_id,
      scope.project_id,
      file_policy_id,
      state.rev,
    );
    if (policy.changes !== 1n) throw new ApiError("conflict", "the file policy moved concurrently");
  }

  return {
    result,
    events: [
      {
        type: changed ? "file.ai_access_changed" : "file.ai_access_confirmed",
        payload: { file_policy_id, blob_id: state.blob_id, ai_access: wanted, rev: result.rev, changed },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// file.extract — text and tables out of the file of one material version (SEL-116 MAT1b)
//
// Reads the stored bytes, runs the pure extractor (scripts/pes_core/file_extract.ts), stores the text as a blob of its own
// with its OWN policy (allow, rev 1 — never inherited from the source) and records one file_extractions row, one receipt and
// one event for every attempt. One blob has one policy, so text that is byte-for-byte the source points at the source blob and
// policy. The reads and the "closed to AI" rule are in file_extractions.ts / file_access.ts.

const EXTRACT_FIELDS = ["version_id", "blob_id"] as const;
const EXTRACT_DB_STATUS: Record<ExtractOutcome["status"], string> = {
  extracted: "ready",
  partial: "partial",
  unsupported: "unsupported",
  failed: "failed",
};

// The thread machinery (file_extract_isolated.ts) is loaded the first time an extraction really runs, not when this module is
// loaded: other code that loads this module (the legacy importer, every command table) never starts a thread and never pays for it.
const load_module = createRequire(import.meta.url);
let isolated: typeof import("../file_extract_isolated.ts") | undefined;
function extract_in_thread(original_name: string | null, bytes: Uint8Array): ExtractOutcome {
  isolated ??= load_module("../file_extract_isolated.ts") as typeof import("../file_extract_isolated.ts");
  return isolated.extract_text_isolated(original_name, bytes);
}

function run_extract(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, EXTRACT_FIELDS);
  const version_id = require_id_field(payload, "version_id");
  const blob_id = require_id_field(payload, "blob_id");
  const project = runtime.project;
  const actor_id = runtime.actor_id;
  if (project === null || actor_id === null) throw new Error("a file command must resolve a project and actor first");
  const project_id = project.id;

  const target = find_target(runtime.db, project_id, version_id, blob_id);
  if (target === undefined) throw new ApiError("not_found", "version file not found");
  // A caller that is not human gets a plain refusal for a closed file, before any receipt or write and without any name, id or hash.
  if (!is_human_actor(runtime) && closed_to_ai(runtime.db, project_id, blob_id, target.object_id)) {
    throw new ApiError("forbidden", "this file is closed to AI");
  }
  if (target.state !== "ready") throw new ApiError("conflict", "only a ready blob can be extracted");

  // Asked again for the same version file and extractor: no new row, blob, policy or text — the same answer, said so.
  const known = existing_extraction(runtime.db, project_id, version_id, blob_id);
  if (known !== undefined) {
    const result = extraction_result(runtime.db, project_id, known, false, is_human_actor(runtime));
    insert_receipt(runtime, { project_id, actor_id, action: "file.extracted", base_control_rev: null, result });
    return { result, events: [{ type: "file.extract_confirmed", payload: event_payload(known, target.file_policy_id, false) }] };
  }

  const format = format_of(target.original_name);
  let outcome: ExtractOutcome;
  if (Number(target.size) > MAX_SOURCE_BYTES) {
    outcome = too_large_outcome();
  } else {
    const objects_dir = runtime.objects_dir;
    if (objects_dir === null) throw new ApiError("conflict", "no object store is configured for file.extract");
    let bytes: Uint8Array;
    try {
      bytes = read_storage_bytes(objects_dir, project_id, target.storage_key);
    } catch {
      throw new ApiError("conflict", "the stored bytes of the blob are not readable");
    }
    if (bytes.byteLength !== Number(target.size) || sha256_hex(bytes) !== target.sha256) {
      throw new ApiError("conflict", "the stored bytes do not match the blob");
    }
    // in a worker thread with a heap and a time limit: a hostile file may end the extraction, never the server
    outcome = extract_in_thread(target.original_name, bytes);
  }

  const extraction_id = runtime.new_id();
  const actor = runtime.db.get<{ user_id: string }>("SELECT user_id FROM actors WHERE id = ?", actor_id);
  if (actor === undefined) throw new Error("the actor user was not found");

  // The receipt is written first: the text policy row points at this transaction (tx_id).
  let text_blob_id: string | null = null;
  let text_policy_id: string | null = null;
  let text_hash: string | null = null;
  const text_bytes = outcome.text === null ? null : new TextEncoder().encode(outcome.text);
  if (text_bytes !== null) {
    text_hash = sha256_hex(text_bytes);
    text_blob_id = runtime.new_id();
    text_policy_id = runtime.new_id();
  }
  const draft = {
    extraction_id,
    version_id,
    blob_id,
    source_file_policy_id: target.file_policy_id,
    source_format: format,
    extractor: EXTRACTOR,
    extractor_version: EXTRACTOR_VERSION,
    status: outcome.status,
    reason: outcome.reason,
    text_hash,
    page_count: outcome.page_count,
    table_count: outcome.table_count,
    warnings: outcome.warnings,
    changed: true,
  };

  // Where does the text live? (1) the source itself when the bytes are identical, (2) a blob this project already has with
  // these bytes, (3) a new blob. Each blob has exactly one policy; the extraction never copies the source's.
  if (text_bytes !== null && text_hash !== null) {
    if (text_hash === target.sha256 && text_bytes.byteLength === Number(target.size)) {
      text_blob_id = blob_id;
      text_policy_id = target.file_policy_id;
    } else {
      const same = runtime.db.get<{ id: string; storage_key: string; state: string }>(
        "SELECT id, storage_key, state FROM blobs WHERE project_id = ? AND sha256 = ? AND size = ?",
        project_id,
        text_hash,
        text_bytes.byteLength,
      );
      const objects_dir = runtime.objects_dir;
      if (objects_dir === null) throw new ApiError("conflict", "no object store is configured for file.extract");
      if (same !== undefined && same.state !== "ready") throw new ApiError("conflict", "the text blob is not ready");
      if (same === undefined) {
        const media_type = "text/plain; charset=utf-8";
        const storage_key = `${project_id}/${text_hash}`;
        write_storage_bytes(objects_dir, project_id, storage_key, text_bytes);
        const written = runtime.db.run(
          `INSERT INTO blobs (id, project_id, storage_key, sha256, size, media_type, original_name, state, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?)`,
          text_blob_id,
          project_id,
          storage_key,
          text_hash,
          text_bytes.byteLength,
          media_type,
          text_name_of(target.original_name),
          actor_id,
        );
        if (written.changes !== 1n) throw new Error("the text blob was not recorded");
      } else {
        text_blob_id = same.id;
        if (!storage_file_is_regular(objects_dir, project_id, same.storage_key)) {
          write_storage_bytes(objects_dir, project_id, same.storage_key, text_bytes);
        }
      }
      const policy = runtime.db.get<{ id: string }>(
        "SELECT id FROM file_policies WHERE project_id = ? AND blob_id = ?",
        project_id,
        text_blob_id,
      );
      // a blob that has no policy yet gets one below, after the receipt (its tx_id points at the receipt)
      text_policy_id = policy?.id ?? (text_policy_id as string);
    }
  }

  // What the caller is told (and what its receipt keeps) follows the one rule for non-human callers: a text that is, byte for byte,
  // a closed file's text is not named (hide_closed_text). The stored file_extractions row below keeps the real ids.
  const result = hide_closed_text(
    runtime.db,
    project_id,
    { ...draft, text_blob_id, text_file_policy_id: text_policy_id },
    is_human_actor(runtime),
  );
  insert_receipt(runtime, { project_id, actor_id, action: "file.extracted", base_control_rev: null, result: { ...result, reason: outcome.reason ?? null } });

  if (text_blob_id !== null && text_policy_id !== null) {
    const has_policy = runtime.db.get<{ ok: bigint }>("SELECT 1 AS ok FROM file_policies WHERE project_id = ? AND id = ?", project_id, text_policy_id);
    if (has_policy === undefined) {
      const policy = runtime.db.run(
        `INSERT INTO file_policies
           (id, project_id, blob_id, ai_access, rev, changed_by_actor_id, changed_by_user_id, changed_at, reason, tx_id)
         VALUES (?, ?, ?, 'allow', 1, ?, ?, ?, NULL, ?)`,
        text_policy_id,
        project_id,
        text_blob_id,
        actor_id,
        actor.user_id,
        runtime.now_ms,
        runtime.tx_id,
      );
      if (policy.changes !== 1n) throw new Error("the text file policy was not written");
    }
  }

  const written = runtime.db.run(
    `INSERT INTO file_extractions
       (id, project_id, version_id, blob_id, source_file_policy_id, source_format, extractor, extractor_version, status,
        text_blob_id, text_file_policy_id, text_hash, page_count, table_count, warnings_json, created_at, tx_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    extraction_id,
    project_id,
    version_id,
    blob_id,
    target.file_policy_id,
    format,
    EXTRACTOR,
    EXTRACTOR_VERSION,
    EXTRACT_DB_STATUS[outcome.status],
    text_blob_id,
    text_policy_id,
    text_hash,
    outcome.page_count,
    outcome.table_count,
    JSON.stringify(outcome.warnings),
    runtime.now_ms,
    runtime.tx_id,
  );
  if (written.changes !== 1n) throw new Error("the extraction was not recorded");

  return {
    result: { ...result, reason: outcome.reason ?? null },
    events: [
      {
        type: "file.extracted",
        payload: {
          extraction_id,
          status: outcome.status,
          source_format: format,
          page_count: outcome.page_count,
          table_count: outcome.table_count,
          warning_count: outcome.warnings.length,
          // the SOURCE policy only: it lets the change feed hide this fact from a caller who may not see the source file
          file_policy_id: target.file_policy_id,
          changed: true,
        },
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
  if (blob.state !== "staging" && blob.state !== "ready") {
    throw new ApiError("conflict", "the blob cannot be quarantined in its current state");
  }
  if (blob_is_linked(runtime, scope.project_id, blob_id)) {
    throw new ApiError("conflict", "a linked blob is never quarantined");
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

function reservation_time(
  runtime: CommandRuntime,
  project_id: string,
  blob_id: string,
): number | null {
  // The last reservation is the beginning of the current upload attempt. A
  // client that re-reserved after the grace period gets the same staging row;
  // measuring from the first reservation would collect the file it is writing.
  const row = runtime.db.get<{ created_at: bigint | null }>(
    `SELECT MAX(created_at) AS created_at FROM events
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
  const objects_dir = runtime.objects_dir;
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
    if (blob_is_linked(runtime, project_id, candidate.id)) continue;
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
  ["file.upload", definition("file.material_uploaded", run_upload)],
  ["file.ai_access_set", definition("file.ai_access_changed", run_ai_access_set)],
  ["file.extract", definition("file.extracted", run_extract)],
  ["file.quarantine", definition("file.blob_quarantined", run_quarantine)],
  ["file.gc_orphans", definition("file.orphans_collected", run_gc_orphans)],
];

/** Registry entries merged into COMMANDS by commands.ts (names, not actions). */
export const FILE_COMMAND_ENTRIES: ReadonlyArray<readonly [string, CommandDefinition]> =
  Object.freeze(FILE_COMMAND_INPUTS.map((entry) => Object.freeze([entry[0], entry[1]] as const)));

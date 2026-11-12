// file.extract — pull the text and tables out of the file of one material version (SEL-116 MAT1b).
//
// The extractor itself is pure (scripts/pes_core/file_extract.ts). This command reads the stored bytes, runs it, stores
// the text as a blob of its own, gives that blob its OWN file policy (allow, rev 1 — an extraction never inherits the
// source policy), and records one file_extractions row plus one receipt and one event. Every attempt is recorded:
// extracted, partial, unsupported and failed alike, so "we tried" stays visible.
//
// One blob has one policy (SEL-115). So when the extracted text is byte-for-byte the source (a plain UTF-8 txt/md/csv
// without a BOM or CRLF), no second blob can exist: text_blob_id / text_file_policy_id then point at the source blob
// and policy. The read rule is unchanged — source allow AND text allow — and with one policy it is just that policy.
//
// Reading the text later is the same decision as every other exit (file_access.ts, file_ai_denied): a text blob is
// closed to AI when its own policy is closed OR the policy of the source it was extracted from is closed.

import { ApiError } from "../errors.ts";
import {
  is_safe_media_type,
  read_storage_bytes,
  require_safe_id,
  sha256_hex,
  storage_file_is_regular,
  write_storage_bytes,
} from "../files.ts";
import {
  EXTRACTOR,
  EXTRACTOR_VERSION,
  MAX_SOURCE_BYTES,
  extract_text,
  format_of,
  too_large_outcome,
  type ExtractOutcome,
  type ExtractWarning,
} from "../file_extract.ts";
import { access_state_of_blob, material_object_denied } from "./file_access.ts";
import {
  insert_receipt,
  is_human_actor,
  reject_unknown_fields,
  require_record,
  type CommandResult,
  type CommandRuntime,
} from "./shared.ts";

const EXTRACT_FIELDS = ["version_id", "blob_id"] as const;
const DB_STATUS: Record<ExtractOutcome["status"], string> = {
  extracted: "ready",
  partial: "partial",
  unsupported: "unsupported",
  failed: "failed",
};

export type ExtractionApiStatus = "extracted" | "partial" | "unsupported" | "failed";

function api_status(db_status: string): ExtractionApiStatus {
  if (db_status === "ready") return "extracted";
  if (db_status === "partial" || db_status === "unsupported" || db_status === "failed") return db_status;
  // 'pending' is in the table's CHECK but this command never writes it; show it as not done.
  return "failed";
}

export interface ExtractionRow {
  id: string;
  version_id: string;
  blob_id: string;
  source_file_policy_id: string;
  source_format: string;
  extractor: string;
  extractor_version: string;
  status: string;
  text_blob_id: string | null;
  text_file_policy_id: string | null;
  text_hash: string | null;
  page_count: bigint | null;
  table_count: bigint | null;
  warnings_json: string;
}

export const EXTRACTION_COLUMNS = `id, version_id, blob_id, source_file_policy_id, source_format, extractor, extractor_version, status,
       text_blob_id, text_file_policy_id, text_hash, page_count, table_count, warnings_json`;

export function parse_warnings(json: string): ExtractWarning[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((w): w is Record<string, unknown> => typeof w === "object" && w !== null)
      .map((w) => ({ code: String(w.code ?? ""), message: String(w.message ?? "") }));
  } catch {
    return [];
  }
}

/** Why the result is not a clean "extracted": the first warning's code (failed, unsupported, partial), else null. */
export function reason_of(status: ExtractionApiStatus, warnings: ExtractWarning[]): string | null {
  return status === "extracted" ? null : (warnings[0]?.code ?? null);
}

/** The command result for a stored extraction. */
export function extraction_result(row: ExtractionRow, changed: boolean): Record<string, unknown> {
  const status = api_status(row.status);
  const warnings = parse_warnings(row.warnings_json);
  return {
    extraction_id: row.id,
    version_id: row.version_id,
    blob_id: row.blob_id,
    source_file_policy_id: row.source_file_policy_id,
    source_format: row.source_format,
    extractor: row.extractor,
    extractor_version: row.extractor_version,
    status,
    reason: reason_of(status, warnings),
    text_blob_id: row.text_blob_id,
    text_file_policy_id: row.text_file_policy_id,
    text_hash: row.text_hash,
    page_count: row.page_count === null ? null : Number(row.page_count),
    table_count: Number(row.table_count ?? 0n),
    warnings,
    changed,
  };
}

function invalid(message: string): never {
  throw new ApiError("invalid_payload", message);
}

function require_id_field(payload: Record<string, unknown>, field: string): string {
  if (!(field in payload)) invalid(`${field} is required`);
  return require_safe_id(payload[field], field);
}

/** "name.docx" -> "name.txt"; a name without an extension gets ".txt". */
function text_name_of(original_name: string | null): string {
  const base = (original_name ?? "").trim();
  if (base === "") return "추출 글자.txt";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${stem}.txt`;
}

interface TargetFile {
  storage_key: string;
  sha256: string;
  size: bigint;
  original_name: string | null;
  state: string;
  file_policy_id: string;
  object_id: string;
}

/**
 * The file of one material version (version_id + blob_id must be attached together), or undefined. Shared by the command and
 * the HTTP route's "already extracted" shortcut so both answer a wrong target the same way.
 */
export function find_target(
  db: CommandRuntime["db"],
  project_id: string,
  version_id: string,
  blob_id: string,
): TargetFile | undefined {
  return db.get<TargetFile>(
    `SELECT b.storage_key AS storage_key, b.sha256 AS sha256, b.size AS size, b.original_name AS original_name, b.state AS state,
            vf.file_policy_id AS file_policy_id, ov.object_id AS object_id
       FROM version_files vf
       JOIN blobs b ON b.project_id = vf.project_id AND b.id = vf.blob_id
       JOIN object_versions ov ON ov.project_id = vf.project_id AND ov.id = vf.version_id
      WHERE vf.project_id = ? AND vf.version_id = ? AND vf.blob_id = ?
      LIMIT 1`,
    project_id,
    version_id,
    blob_id,
  );
}

/** True when a caller that is not the human owner must not touch this file (closed blob or a material object that carries one). */
export function closed_to_ai(db: CommandRuntime["db"], project_id: string, blob_id: string, object_id: string): boolean {
  return access_state_of_blob(db, project_id, blob_id)?.effective === "deny" || material_object_denied(db, project_id, object_id);
}

export function existing_extraction(
  db: CommandRuntime["db"],
  project_id: string,
  version_id: string,
  blob_id: string,
): ExtractionRow | undefined {
  return db.get<ExtractionRow>(
    `SELECT ${EXTRACTION_COLUMNS} FROM file_extractions
      WHERE project_id = ? AND version_id = ? AND blob_id = ? AND extractor = ? AND extractor_version = ?`,
    project_id,
    version_id,
    blob_id,
    EXTRACTOR,
    EXTRACTOR_VERSION,
  );
}

export function run_extract(runtime: CommandRuntime): CommandResult {
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
    const result = extraction_result(known, false);
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
    outcome = extract_text(target.original_name, bytes);
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
        const media_type = is_safe_media_type("text/plain; charset=utf-8") ? "text/plain; charset=utf-8" : "text/plain";
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

  const result = { ...draft, text_blob_id, text_file_policy_id: text_policy_id };
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
    DB_STATUS[outcome.status],
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

function event_payload(row: ExtractionRow, source_policy_id: string, changed: boolean): Record<string, unknown> {
  return {
    extraction_id: row.id,
    status: api_status(row.status),
    source_format: row.source_format,
    page_count: row.page_count === null ? null : Number(row.page_count),
    table_count: Number(row.table_count ?? 0n),
    warning_count: parse_warnings(row.warnings_json).length,
    file_policy_id: source_policy_id,
    changed,
  };
}

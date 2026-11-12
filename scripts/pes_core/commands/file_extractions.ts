// Reads for file.extract (SEL-116 MAT1b): the shape of a stored extraction and the lookups the command and the HTTP route share.
// The command itself (the writes) is run_extract in commands/files.ts, the only writer of blobs and file_policies.
//
// The extractor itself is pure (scripts/pes_core/file_extract.ts). The command reads the stored bytes, runs it, stores
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
import { require_safe_id } from "../files.ts";
import { EXTRACTOR, EXTRACTOR_VERSION, TRANSIENT_REASONS, type ExtractWarning } from "../file_extract.ts";
import { access_state_of_blob, file_ai_denied, material_object_denied } from "./file_access.ts";
import type { CommandRuntime } from "./shared.ts";

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

/**
 * THE rule for what an extraction answer tells a caller who is not human: when the text blob is closed to AI (file_ai_denied —
 * its own policy, or the policy of any file it was extracted from), the ids and the hash of that blob are not given out. The text
 * can be the bytes of a file the caller may not know about (the project stores identical bytes once), so its id, its policy id
 * and its hash would let a caller test guesses against a closed file. Reads (file_access.ts extraction_of) follow the same rule;
 * every answer of file.extract goes through here — the command's new and known branches and the HTTP shortcut alike.
 */
export function hide_closed_text<T extends { text_blob_id: unknown; text_file_policy_id: unknown; text_hash: unknown }>(
  db: CommandRuntime["db"],
  project_id: string,
  result: T,
  human: boolean,
): T {
  if (human || typeof result.text_blob_id !== "string") return result;
  if (!file_ai_denied(db, project_id, result.text_blob_id)) return result;
  return { ...result, text_blob_id: null, text_file_policy_id: null, text_hash: null };
}

/** The command result for a stored extraction, as the caller may see it (see hide_closed_text). */
export function extraction_result(
  db: CommandRuntime["db"],
  project_id: string,
  row: ExtractionRow,
  changed: boolean,
  human: boolean,
): Record<string, unknown> {
  const status = api_status(row.status);
  const warnings = parse_warnings(row.warnings_json);
  return hide_closed_text(db, project_id, {
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
  }, human);
}

function invalid(message: string): never {
  throw new ApiError("invalid_payload", message);
}

export function require_id_field(payload: Record<string, unknown>, field: string): string {
  if (!(field in payload)) invalid(`${field} is required`);
  return require_safe_id(payload[field], field);
}

/** "name.docx" -> "name.txt"; a name without an extension gets ".txt". */
export function text_name_of(original_name: string | null): string {
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

/**
 * The extraction that already answers this (version, blob, extractor, extractor_version), if any. An attempt that failed for a
 * reason about the moment, not the file (TRANSIENT_REASONS: time limit, unexpected error; a thread still running and workers not
 * allowed are refused by file.extract and never stored) does NOT count — it stays in the table as the record of that attempt, and
 * the next request for the file tries again (a new row, receipt and event). Final answers (extracted, partial, unsupported, failed/too_large and the damaged-file reasons)
 * are returned as before. When there are several rows, the newest counted one answers.
 */
export function existing_extraction(
  db: CommandRuntime["db"],
  project_id: string,
  version_id: string,
  blob_id: string,
): ExtractionRow | undefined {
  const marks = TRANSIENT_REASONS.map(() => "?").join(", ");
  return db.get<ExtractionRow>(
    `SELECT ${EXTRACTION_COLUMNS} FROM file_extractions
      WHERE project_id = ? AND version_id = ? AND blob_id = ? AND extractor = ? AND extractor_version = ?
        AND (status <> 'failed' OR COALESCE(json_extract(warnings_json, '$[0].code'), '') NOT IN (${marks}))
      ORDER BY rowid DESC LIMIT 1`,
    project_id,
    version_id,
    blob_id,
    EXTRACTOR,
    EXTRACTOR_VERSION,
    ...TRANSIENT_REASONS,
  );
}

export function event_payload(row: ExtractionRow, source_policy_id: string, changed: boolean): Record<string, unknown> {
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

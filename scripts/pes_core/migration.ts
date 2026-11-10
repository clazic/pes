// Migration validation, activation, rollback and project restore (stage 2 PR12).
//
// A legacy project moves in steps (docs/plan/migration-map.md sections 8-9):
//
//   import (PR11)  -> staging
//   validate_import -> validated         (counts, bodies, ids, links, footnotes, files,
//                                         unprocessed answers, report regeneration, source)
//   activate_import -> activated         (a verified backup of that ONE project first)
//   rollback_before_write -> failed      (project archived; the old JSON path serves again)
//   restore_project                      (after new writes: back to a bundle, loss reported,
//                                         cursor_epoch + 1)
//
// Every write below is ONE CommandService.execute call: the owner-scoped
// commands in commands/migration.ts hold all SQL. This module only reads (the
// source folder, the bundle, the database through a read handle) and prepares
// the input that a command consumes in the same process. Nothing here reads the
// environment or the real home: every path comes from the caller.

import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { BackupError, prepare_project_restore, type PreparedProjectRestore } from "./backup.ts";
import type { CommandService } from "./commands.ts";
import type { Db } from "./db.ts";
import { ApiError } from "./errors.ts";
import { read_storage_bytes, sha256_hex } from "./files.ts";
import { new_id } from "./ids.ts";
import { feedback_entries, normalize_project, stage_report, without_report_time, type Dict, type FeedbackEntry } from "./report.ts";
import {
  build_validation_plan,
  is_regenerable_source_path,
  LEGACY_STAGE_KEYS,
  type ImportPlan,
  type LegacyStageKey,
  type PlanObjectRow,
  type PreparedImport,
} from "./legacy.ts";

// ---------------------------------------------------------------------------
// Public shapes (the test interface lives in tests/helpers/migration_env.ts)

export type CheckName =
  | "counts"
  | "bodies"
  | "ids"
  | "links"
  | "footnotes"
  | "files"
  | "unprocessed_answers"
  | "reports_regeneration"
  | "source_changed";

export const CHECK_NAMES: readonly CheckName[] = [
  "counts",
  "bodies",
  "ids",
  "links",
  "footnotes",
  "files",
  "unprocessed_answers",
  "reports_regeneration",
  "source_changed",
];

export interface ValidationProblem {
  check: CheckName;
  path?: string;
  detail?: unknown;
}

export interface RegeneratedReport {
  path: string;
  matches: boolean;
}

export interface ValidationReport {
  checked: Record<CheckName, number>;
  problems: ValidationProblem[];
  regenerated_reports: RegeneratedReport[];
  /**
   * PR16: the regeneration uses the real report generator (report.ts), so a
   * difference is a `reports_regeneration` problem. "generator" names that format.
   */
  regeneration_format: "generator";
}

export interface ValidateOptions {
  owner_actor_id: string;
  source_dir: string;
}

export interface ValidateResult {
  batch_id: string;
  project_id: string;
  ok: boolean;
  state: "staging" | "validated";
  report: ValidationReport;
}

export interface ActivateOptions {
  owner_actor_id: string;
  backup_dir: string;
  pes_home: string;
}

export interface ActivateResult {
  batch_id: string;
  project_id: string;
  state: "activated";
  backup_dir: string;
}

export interface RollbackOptions {
  owner_actor_id: string;
}

export interface RollbackResult {
  batch_id: string;
  project_id: string;
  state: "failed";
  serving: "legacy_json";
  from_state: "staging" | "validated" | "activated";
}

export interface RestoreOptions {
  owner_actor_id: string;
  project_id: string;
  bundle_dir: string;
}

export interface LostWrite {
  action: string;
  created_at: string;
}

export interface RestoreResult {
  project_id: string;
  bundle_dir: string;
  cursor_epoch_before: string;
  cursor_epoch_after: string;
  lost_writes: LostWrite[];
  reverted_steps: string[];
}

/** The most problems one validation lists (a damaged source can produce thousands). */
export const MAX_PROBLEMS = 500;

// ---------------------------------------------------------------------------
// Hand-over of prepared input to the commands (same process, like PR11)
//
// A command payload carries only ids and an opaque token, so the request hash
// never contains a folder, a bundle or the bytes read from them.

interface PreparedValidation {
  owner_actor_id: string;
  prepared: PreparedImport;
}

/**
 * The object files of a restore, prepared inside the transaction and settled by
 * the wrapper once the transaction is over: `commit` puts them in place and
 * returns the storage keys it could not; `discard` throws them away.
 */
export interface StagedRestoreFiles {
  commit(): string[];
  discard(): void;
}

export interface PreparedRestore {
  owner_actor_id: string;
  project_id: string;
  prepared: PreparedProjectRestore;
  files?: StagedRestoreFiles;
}

const prepared_validations = new Map<string, PreparedValidation>();
const prepared_restores = new Map<string, PreparedRestore>();

export function take_prepared_validation(owner_actor_id: string, token: string): PreparedImport | undefined {
  const entry = prepared_validations.get(token);
  if (entry === undefined || entry.owner_actor_id !== owner_actor_id) return undefined;
  return entry.prepared;
}

export function take_prepared_restore(
  owner_actor_id: string,
  token: string,
): PreparedRestore | undefined {
  const entry = prepared_restores.get(token);
  if (entry === undefined || entry.owner_actor_id !== owner_actor_id) return undefined;
  return entry;
}

// ---------------------------------------------------------------------------
// Input checks shared by the wrappers

function require_string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || !value.isWellFormed()) {
    throw new ApiError("invalid_payload", `${field} must be a non-empty string`);
  }
  return value;
}

function require_options(opts: unknown): Record<string, unknown> {
  if (opts === null || typeof opts !== "object" || Array.isArray(opts)) {
    throw new ApiError("invalid_payload", "options must be an object");
  }
  return opts as Record<string, unknown>;
}

function require_absolute(value: string, field: string): string {
  if (!isAbsolute(value)) {
    throw new ApiError("invalid_payload", `${field} must be an absolute path`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Public wrappers: one command execution per write

export async function validate_import(
  service: CommandService,
  batch_id: string,
  opts: ValidateOptions,
): Promise<ValidateResult> {
  const options = require_options(opts);
  const owner_actor_id = require_string(options.owner_actor_id, "owner_actor_id");
  const source_dir = require_string(options.source_dir, "source_dir");
  const id = require_string(batch_id, "batch_id");

  let prepared: PreparedImport;
  try {
    // Read only: scans and reads the folder, never changes it.
    prepared = build_validation_plan(source_dir);
  } catch {
    throw new ApiError("invalid_payload", "the source folder cannot be read");
  }
  const token = new_id();
  prepared_validations.set(token, { owner_actor_id, prepared });
  try {
    const outcome = await service.execute(
      {
        project_id: null,
        actor_id: owner_actor_id,
        via: "import",
        client_request_id: `legacy-validate:${id}:${token}`,
      },
      "legacy.validate_import",
      { batch_id: id, source_token: token },
    );
    return outcome.result as ValidateResult;
  } finally {
    prepared_validations.delete(token);
  }
}

export async function activate_import(
  service: CommandService,
  batch_id: string,
  opts: ActivateOptions,
): Promise<ActivateResult> {
  const options = require_options(opts);
  const owner_actor_id = require_string(options.owner_actor_id, "owner_actor_id");
  const backup_dir = require_absolute(require_string(options.backup_dir, "backup_dir"), "backup_dir");
  const pes_home = require_absolute(require_string(options.pes_home, "pes_home"), "pes_home");
  const id = require_string(batch_id, "batch_id");
  const outcome = await service.execute(
    {
      project_id: null,
      actor_id: owner_actor_id,
      via: "import",
      client_request_id: `legacy-activate:${id}:${new_id()}`,
    },
    "legacy.activate_import",
    { batch_id: id, backup_dir, pes_home },
  );
  return outcome.result as ActivateResult;
}

export async function rollback_before_write(
  service: CommandService,
  batch_id: string,
  opts: RollbackOptions,
): Promise<RollbackResult> {
  const options = require_options(opts);
  const owner_actor_id = require_string(options.owner_actor_id, "owner_actor_id");
  const id = require_string(batch_id, "batch_id");
  const outcome = await service.execute(
    {
      project_id: null,
      actor_id: owner_actor_id,
      via: "import",
      client_request_id: `legacy-rollback:${id}:${new_id()}`,
    },
    "legacy.rollback_before_write",
    { batch_id: id },
  );
  return outcome.result as RollbackResult;
}

export async function restore_project(
  service: CommandService,
  opts: RestoreOptions,
): Promise<RestoreResult> {
  const options = require_options(opts);
  const owner_actor_id = require_string(options.owner_actor_id, "owner_actor_id");
  const project_id = require_string(options.project_id, "project_id");
  const bundle_dir = require_absolute(require_string(options.bundle_dir, "bundle_dir"), "bundle_dir");

  let prepared: PreparedProjectRestore;
  try {
    prepared = prepare_project_restore(bundle_dir);
  } catch (error) {
    throw bundle_error(error);
  }
  if (prepared.manifest.project_id !== project_id) {
    throw new ApiError("conflict", "the bundle belongs to another project");
  }
  const token = new_id();
  const entry: PreparedRestore = { owner_actor_id, project_id, prepared };
  prepared_restores.set(token, entry);
  try {
    // Order: the files are prepared inside the transaction (any failure rolls the
    // rows back and removes them) -> the rows commit -> only then are the files
    // swapped in. A swap that fails after the commit is reported, never hidden.
    let outcome: Awaited<ReturnType<CommandService["execute"]>>;
    try {
      outcome = await service.execute(
        {
          project_id: null,
          actor_id: owner_actor_id,
          via: "import",
          client_request_id: `legacy-restore:${project_id}:${token}`,
        },
        "legacy.restore_project",
        { project_id, bundle_dir, bundle_token: token },
      );
    } catch (error) {
      entry.files?.discard();
      throw error;
    }
    const result = outcome.result as RestoreResult;
    const failed = entry.files?.commit() ?? [];
    if (failed.length > 0) {
      // The rows are final and the epoch is raised: say what the restore took away
      // and where the cursor stands. A second run of the same restore only finishes
      // the files, and then reports no loss of its own.
      throw new ApiError(
        "conflict",
        `the project rows were restored, but ${failed.length} object file(s) could not be put in place or removed; run the same restore again to finish`,
        {
          rows_restored: true,
          failed_files: failed,
          lost_writes: result.lost_writes,
          reverted_steps: result.reverted_steps,
          cursor_epoch_before: result.cursor_epoch_before,
          cursor_epoch_after: result.cursor_epoch_after,
        },
      );
    }
    return result;
  } finally {
    prepared_restores.delete(token);
  }
}

/** Which path serves this project now: the database only once the project is active. */
export function serving_path(db: Pick<Db, "get">, project_id: string): "legacy_json" | "database" {
  const row = db.get<{ status: string }>("SELECT status FROM projects WHERE id = ?", project_id);
  if (row === undefined) throw new ApiError("not_found", "project not found");
  return row.status === "active" ? "database" : "legacy_json";
}

/** Turn a bundle failure into the closed error codes; no absolute path in the message. */
export function bundle_error(error: unknown): ApiError | unknown {
  if (!(error instanceof BackupError)) return error;
  if (error.problems.some((problem) => problem.code === "manifest_missing")) {
    return new ApiError("not_found", "the bundle was not found");
  }
  const problems = error.problems.map((problem) => ({ code: problem.code, path: problem.path }));
  if (error.code === "bundle_invalid") {
    return new ApiError("invalid_payload", "the bundle failed verification", { problems });
  }
  return new ApiError("conflict", `the bundle cannot be used: ${error.code}`);
}

// ---------------------------------------------------------------------------
// Backup location rule (migration-map.md section 8 step 1, stage-2.md 2.2)
//
// The pre-activation backup must live outside the PES home (the project
// folders) and outside a synced OneDrive folder, and must not sit in the object
// store it describes.

/**
 * The real spelling of a path: symbolic links resolved and, on a disk that
 * ignores case, the spelling the disk itself reports (realpathSync.native).
 * For a path that does not exist yet, the nearest existing ancestor is
 * normalised and the missing tail is kept as given.
 */
function resolve_real(path: string): string {
  const absolute = resolve(path);
  const rest: string[] = [];
  let current = absolute;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return absolute;
    rest.unshift(current.slice(parent.length).replace(/^[\\/]+/, ""));
    current = parent;
  }
  let real: string;
  try {
    real = realpathSync.native(current);
  } catch {
    real = current;
  }
  return rest.length === 0 ? real : join(real, ...rest);
}

/**
 * True when the disk holding `dir` treats names that differ only in case as the
 * same entry. Nothing is written: an existing folder is looked up under a
 * case-swapped spelling and compared by identity (device + inode).
 */
function disk_ignores_case(dir: string): boolean {
  let probe = dir;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const platform_default = process.platform === "win32" || process.platform === "darwin";
  const swapped = probe
    .split("")
    .map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()))
    .join("");
  if (swapped === probe) return platform_default; // no letters to swap (for example the root)
  try {
    const here = statSync(probe, { bigint: true });
    const there = statSync(swapped, { bigint: true });
    return here.dev === there.dev && here.ino === there.ino;
  } catch {
    return false; // the swapped spelling does not exist: names are case-sensitive here
  }
}

function is_inside(parent: string, child: string): boolean {
  let left = parent;
  let right = child;
  if (disk_ignores_case(parent) || disk_ignores_case(child)) {
    left = left.toLowerCase();
    right = right.toLowerCase();
  }
  const rel = relative(left, right);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function has_onedrive_segment(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => /^onedrive(\b|[\s_-]|$)/i.test(segment));
}

/** Throws invalid_payload when the backup folder is somewhere a backup must not be. */
export function assert_backup_location(
  backup_dir: string,
  pes_home: string,
  objects_dir: string | null,
): void {
  const target = resolve_real(backup_dir);
  const home = resolve_real(pes_home);
  if (is_inside(home, target) || is_inside(target, home)) {
    throw new ApiError("invalid_payload", "the backup folder must be outside the PES home");
  }
  if (has_onedrive_segment(resolve(backup_dir)) || has_onedrive_segment(target)) {
    throw new ApiError("invalid_payload", "the backup folder must not be inside an OneDrive folder");
  }
  if (objects_dir !== null) {
    const store = resolve_real(objects_dir);
    if (is_inside(store, target) || is_inside(target, store)) {
      throw new ApiError("invalid_payload", "the backup folder must be outside the object store");
    }
  }
}

// ---------------------------------------------------------------------------
// Validation (read only; the command calls this inside its transaction)

type ReadDb = Pick<Db, "get" | "all">;

export interface ValidationInput {
  objects_dir: string;
  project_id: string;
  batch: {
    id: string;
    source_fingerprint: string;
    source_manifest_blob_id: string;
    report_blob_id: string | null;
  };
  prepared: PreparedImport;
}

function empty_checked(): Record<CheckName, number> {
  return {
    counts: 0,
    bodies: 0,
    ids: 0,
    links: 0,
    footnotes: 0,
    files: 0,
    unprocessed_answers: 0,
    reports_regeneration: 0,
    source_changed: 0,
  };
}

function text_hash(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return sha256_hex(new TextEncoder().encode(value));
}

function num(value: bigint | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function same_json(left: string, right: unknown): boolean {
  return left === JSON.stringify(right);
}

interface ObjectRef {
  id: string;
  kind: string;
  display_no: number;
}

interface VersionRef {
  id: string;
  object_id: string;
  version_no: number;
  content_hash: string;
}

interface BlobRef {
  id: string;
  storage_key: string;
  sha256: string;
  size: number;
  state: string;
  original_name: string | null;
}

class Collector {
  readonly checked = empty_checked();
  readonly problems: ValidationProblem[] = [];
  dropped = 0;

  add(check: CheckName, path?: string, detail?: unknown): void {
    if (this.problems.length >= MAX_PROBLEMS) {
      this.dropped += 1;
      return;
    }
    const problem: ValidationProblem = { check };
    if (path !== undefined) problem.path = path;
    if (detail !== undefined) problem.detail = detail;
    this.problems.push(problem);
  }
}

function source_manifest(db: ReadDb, input: ValidationInput): Map<string, string> | undefined {
  const blob = db.get<{ storage_key: string; sha256: string; size: bigint }>(
    "SELECT storage_key, sha256, size FROM blobs WHERE project_id = ? AND id = ?",
    input.project_id,
    input.batch.source_manifest_blob_id,
  );
  if (blob === undefined) return undefined;
  try {
    const bytes = read_storage_bytes(input.objects_dir, input.project_id, blob.storage_key);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { files?: unknown };
    if (!Array.isArray(parsed.files)) return undefined;
    const out = new Map<string, string>();
    for (const file of parsed.files as Array<{ path?: unknown; sha256?: unknown }>) {
      if (typeof file.path === "string" && typeof file.sha256 === "string") out.set(file.path, file.sha256);
    }
    return out;
  } catch {
    return undefined;
  }
}

function check_source(db: ReadDb, input: ValidationInput, out: Collector): boolean {
  const plan = input.prepared.plan;
  out.checked.source_changed = plan.manifest_files.length;
  if (plan.fingerprint === input.batch.source_fingerprint) return true;

  // The folder is not what was imported. Say which files moved when the stored
  // manifest can be read; the fingerprint alone already says that it did.
  const recorded = source_manifest(db, input);
  let listed = 0;
  if (recorded !== undefined) {
    const current = new Map<string, string>();
    for (const file of plan.manifest_files) {
      if (!is_regenerable_source_path(file.path)) current.set(file.path, file.sha256);
    }
    for (const [path, sha] of recorded) {
      if (is_regenerable_source_path(path)) continue;
      const now = current.get(path);
      if (now === undefined) {
        out.add("source_changed", path, { change: "removed" });
        listed += 1;
      } else if (now !== sha) {
        out.add("source_changed", path, { change: "modified" });
        listed += 1;
      }
    }
    for (const path of current.keys()) {
      if (!recorded.has(path)) {
        out.add("source_changed", path, { change: "added" });
        listed += 1;
      }
    }
  }
  if (listed === 0) out.add("source_changed", undefined, { change: "fingerprint_differs" });
  return false;
}

/** Everything validate_import compares, read from the transaction the command runs in. */
export function build_validation_report(db: ReadDb, input: ValidationInput): ValidationReport {
  const out = new Collector();
  const regenerated: RegeneratedReport[] = [];
  const unchanged = check_source(db, input, out);
  if (unchanged) {
    check_content(db, input, out, regenerated);
  }
  if (out.dropped > 0) {
    out.problems.push({ check: "counts", detail: { more_problems_not_listed: out.dropped } });
  }
  return {
    checked: out.checked,
    problems: out.problems,
    regenerated_reports: regenerated,
    regeneration_format: "generator",
  };
}

function check_content(
  db: ReadDb,
  input: ValidationInput,
  out: Collector,
  regenerated: RegeneratedReport[],
): void {
  const plan = input.prepared.plan;
  const bytes = input.prepared.bytes;
  const pid = input.project_id;

  // --- database side lookups -------------------------------------------------
  const object_rows = db.all<{ id: string; kind: string; display_no: bigint }>(
    "SELECT id, kind, display_no FROM objects WHERE project_id = ?",
    pid,
  );
  const object_by_slot = new Map<string, ObjectRef>();
  const object_by_id = new Map<string, ObjectRef>();
  for (const row of object_rows) {
    const ref = { id: row.id, kind: row.kind, display_no: num(row.display_no) };
    object_by_slot.set(`${row.kind}:${ref.display_no}`, ref);
    object_by_id.set(row.id, ref);
  }
  const version_rows = db.all<{ id: string; object_id: string; version_no: bigint; content_hash: string }>(
    "SELECT id, object_id, version_no, content_hash FROM object_versions WHERE project_id = ?",
    pid,
  );
  const version_by_slot = new Map<string, VersionRef>();
  const version_by_id = new Map<string, VersionRef>();
  for (const row of version_rows) {
    const ref = { id: row.id, object_id: row.object_id, version_no: num(row.version_no), content_hash: row.content_hash };
    version_by_slot.set(`${row.object_id}:${ref.version_no}`, ref);
    version_by_id.set(row.id, ref);
  }
  const blob_rows = db.all<{
    id: string;
    storage_key: string;
    sha256: string;
    size: bigint;
    state: string;
    original_name: string | null;
  }>("SELECT id, storage_key, sha256, size, state, original_name FROM blobs WHERE project_id = ?", pid);
  const blobs: BlobRef[] = blob_rows.map((row) => ({ ...row, size: num(row.size) }));
  const blob_by_sha = new Map<string, BlobRef>();
  const blob_by_id = new Map<string, BlobRef>();
  for (const blob of blobs) {
    blob_by_sha.set(`${blob.sha256}:${blob.size}`, blob);
    blob_by_id.set(blob.id, blob);
  }

  // --- plan side: which database slot each plan key must be at ----------------
  // The importer takes one display number per kind in plan order, so the n-th
  // plan object of a kind is the object with display_no n.
  const plan_object_id = new Map<string, string | undefined>();
  const plan_version = new Map<
    string,
    { object_key: string; version_no: number; content_hash: string; id: string | undefined }
  >();
  const kind_counter = new Map<string, number>();
  const plan_kind_counts = new Map<string, number>();
  for (const row of plan.objects) {
    const display_no = (kind_counter.get(row.kind) ?? 0) + 1;
    kind_counter.set(row.kind, display_no);
    plan_kind_counts.set(row.kind, display_no);
    const object = object_by_slot.get(`${row.kind}:${display_no}`);
    plan_object_id.set(row.key, object?.id);
    const versions = [...(row.earlier ?? []).map((entry) => entry.version), row.version];
    for (const version of versions) {
      plan_version.set(version.key, {
        object_key: row.key,
        version_no: version.version_no,
        content_hash: version.content_hash,
        id: object === undefined ? undefined : version_by_slot.get(`${object.id}:${version.version_no}`)?.id,
      });
    }
  }
  const version_id_of = (key: string): string | undefined => plan_version.get(key)?.id;
  const blob_of_path = (path: string): BlobRef | undefined => {
    const content = bytes.get(path);
    if (content === undefined) return undefined;
    return blob_by_sha.get(`${sha256_hex(content)}:${content.byteLength}`);
  };

  check_counts(db, input, out, plan_kind_counts);
  check_ids(db, input, out, {
    plan_object_id,
    version_id_of,
    blob_of_path,
    blob_by_id,
    version_by_id,
    object_by_id,
  });
  check_bodies(db, input, out, plan_object_id, version_by_id);
  check_links(db, input, out, { plan_object_id, version_id_of, blob_of_path });
  check_footnotes(db, input, out, version_id_of);
  check_files(db, input, out, { blobs, blob_by_id, blob_of_path, version_id_of });
  check_unprocessed_answers(db, input, out, blob_of_path);
  check_reports(plan, bytes, out, regenerated);
}

// ---------------------------------------------------------------------------
// counts

function count_of(db: ReadDb, sql: string, ...params: string[]): number {
  return num(db.get<{ n: bigint }>(sql, ...params)?.n);
}

function compare_count(out: Collector, check: CheckName, path: string, expected: number, actual: number): void {
  out.checked[check] += 1;
  if (expected !== actual) out.add(check, path, { expected, actual });
}

function check_counts(
  db: ReadDb,
  input: ValidationInput,
  out: Collector,
  plan_kind_counts: Map<string, number>,
): void {
  const plan = input.prepared.plan;
  const pid = input.project_id;
  const kinds = ["artifact", "source", "question", "answer", "thread", "message", "followup"];
  const plan_rows = (kind: string): PlanObjectRow[] => plan.objects.filter((row) => row.kind === kind);
  const version_total = (rows: PlanObjectRow[]): number =>
    rows.reduce((sum, row) => sum + 1 + (row.earlier?.length ?? 0), 0);

  for (const kind of kinds) {
    compare_count(
      out,
      "counts",
      `objects/${kind}`,
      plan_kind_counts.get(kind) ?? 0,
      count_of(db, "SELECT count(*) AS n FROM objects WHERE project_id = ? AND kind = ?", pid, kind),
    );
  }
  compare_count(
    out,
    "counts",
    "object_versions",
    version_total(plan.objects),
    count_of(db, "SELECT count(*) AS n FROM object_versions WHERE project_id = ?", pid),
  );

  const artifacts = plan_rows("artifact");
  const sources = plan_rows("source");
  const detail: Array<[string, number, string]> = [
    ["artifacts", artifacts.length, "SELECT count(*) AS n FROM artifacts WHERE project_id = ?"],
    ["artifact_versions", version_total(artifacts), "SELECT count(*) AS n FROM artifact_versions WHERE project_id = ?"],
    ["sources", sources.length, "SELECT count(*) AS n FROM sources WHERE project_id = ?"],
    ["source_versions", version_total(sources), "SELECT count(*) AS n FROM source_versions WHERE project_id = ?"],
    ["questions", plan_rows("question").length, "SELECT count(*) AS n FROM questions WHERE project_id = ?"],
    ["question_versions", version_total(plan_rows("question")), "SELECT count(*) AS n FROM question_versions WHERE project_id = ?"],
    ["answers", plan_rows("answer").length, "SELECT count(*) AS n FROM answers WHERE project_id = ?"],
    ["answer_versions", version_total(plan_rows("answer")), "SELECT count(*) AS n FROM answer_versions WHERE project_id = ?"],
    ["threads", plan_rows("thread").length, "SELECT count(*) AS n FROM threads WHERE project_id = ?"],
    ["messages", plan_rows("message").length, "SELECT count(*) AS n FROM messages WHERE project_id = ?"],
    ["message_versions", version_total(plan_rows("message")), "SELECT count(*) AS n FROM message_versions WHERE project_id = ?"],
    ["followups", plan_rows("followup").length, "SELECT count(*) AS n FROM followups WHERE project_id = ?"],
    ["followup_versions", version_total(plan_rows("followup")), "SELECT count(*) AS n FROM followup_versions WHERE project_id = ?"],
    ["citations", plan.citations.length, "SELECT count(*) AS n FROM citations WHERE project_id = ?"],
    ["version_relations", plan.relations.length, "SELECT count(*) AS n FROM version_relations WHERE project_id = ?"],
    ["round_contents", plan.round_contents.length, "SELECT count(*) AS n FROM round_contents WHERE project_id = ?"],
    ["question_sets", plan.question_sets.length, "SELECT count(*) AS n FROM question_sets WHERE project_id = ?"],
    [
      "question_set_members",
      plan.question_sets.reduce((sum, set) => sum + set.members.length, 0),
      "SELECT count(*) AS n FROM question_set_members WHERE project_id = ?",
    ],
    ["snapshots", plan.snapshots.length, "SELECT count(*) AS n FROM snapshots WHERE project_id = ?"],
    ["approvals", plan.approvals.length, "SELECT count(*) AS n FROM approvals WHERE project_id = ?"],
    [
      "rounds",
      plan.stages.reduce((sum, stage) => sum + stage.rounds.length, 0),
      "SELECT count(*) AS n FROM rounds WHERE project_id = ?",
    ],
    ["stages", plan.stages.length, "SELECT count(*) AS n FROM stages WHERE project_id = ?"],
  ];
  for (const [name, expected, sql] of detail) {
    compare_count(out, "counts", name, expected, count_of(db, sql, pid));
  }

  // items per stage = artifacts per stage
  for (const stage_key of LEGACY_STAGE_KEYS) {
    compare_count(
      out,
      "counts",
      `artifacts/${stage_key}`,
      artifacts.filter((row) => row.artifact?.stage_key === stage_key).length,
      count_of(
        db,
        `SELECT count(*) AS n FROM artifacts a JOIN stages s ON s.project_id = a.project_id AND s.id = a.stage_id
          WHERE a.project_id = ? AND s.key = ?`,
        pid,
        stage_key,
      ),
    );
  }

  // images and every other attached file role
  const roles = new Map<string, number>();
  for (const file of plan.version_files) roles.set(file.role, (roles.get(file.role) ?? 0) + 1);
  const db_roles = db.all<{ role: string; n: bigint }>(
    "SELECT role, count(*) AS n FROM version_files WHERE project_id = ? GROUP BY role",
    pid,
  );
  for (const row of db_roles) if (!roles.has(row.role)) roles.set(row.role, 0);
  for (const [role, expected] of roles) {
    const actual = num(db_roles.find((row) => row.role === role)?.n);
    compare_count(out, "counts", `version_files/${role}`, expected, actual);
  }

  // blobs of the whole project and submissions: nothing the plan does not know
  // about may be there. The importer stores each distinct file once (same hash and
  // size = one blob), plus the source manifest, the import report and the inline
  // snapshot documents.
  const blob_keys = new Set<string>();
  for (const blob of plan.blobs) {
    const content = input.prepared.bytes.get(blob.path);
    if (content !== undefined) blob_keys.add(`${sha256_hex(content)}:${content.byteLength}`);
  }
  for (const snapshot of plan.snapshots) {
    if (snapshot.source.kind !== "inline") continue;
    const content = new TextEncoder().encode(snapshot.source.json);
    blob_keys.add(`${sha256_hex(content)}:${content.byteLength}`);
  }
  for (const blob_id of [input.batch.source_manifest_blob_id, input.batch.report_blob_id]) {
    if (blob_id === null) continue;
    const stored = db.get<{ sha256: string; size: bigint }>(
      "SELECT sha256, size FROM blobs WHERE project_id = ? AND id = ?",
      pid,
      blob_id,
    );
    if (stored !== undefined) blob_keys.add(`${stored.sha256}:${num(stored.size)}`);
  }
  compare_count(
    out,
    "counts",
    "blobs",
    blob_keys.size,
    count_of(db, "SELECT count(*) AS n FROM blobs WHERE project_id = ?", pid),
  );
  compare_count(
    out,
    "counts",
    "submissions",
    plan.submissions.filter((entry) => input.prepared.bytes.has(entry.raw_blob_path)).length,
    count_of(db, "SELECT count(*) AS n FROM submissions WHERE project_id = ?", pid),
  );

  // legacy_mappings the importer could resolve
  const resolvable = plan.mappings.filter((mapping) => mapping_resolvable(plan, input.prepared, mapping)).length;
  compare_count(
    out,
    "counts",
    "legacy_mappings",
    resolvable,
    count_of(db, "SELECT count(*) AS n FROM legacy_mappings WHERE import_batch_id = ?", input.batch.id),
  );
}

type PlanMapping = ImportPlan["mappings"][number];

function mapping_resolvable(plan: ImportPlan, prepared: PreparedImport, mapping: PlanMapping): boolean {
  if (mapping.object_key !== null) return true;
  if (mapping.row === null) return false;
  if (mapping.row.kind === "blob") return prepared.bytes.has(mapping.row.path);
  if (mapping.row.kind === "snapshot") return true;
  const key = mapping.row.key;
  const submission = plan.submissions.find((entry) => entry.key === key);
  return submission !== undefined && prepared.bytes.has(submission.raw_blob_path);
}

// ---------------------------------------------------------------------------
// ids

interface IdLookups {
  plan_object_id: Map<string, string | undefined>;
  version_id_of: (key: string) => string | undefined;
  blob_of_path: (path: string) => BlobRef | undefined;
  blob_by_id: Map<string, BlobRef>;
  version_by_id: Map<string, VersionRef>;
  object_by_id: Map<string, ObjectRef>;
}

function check_ids(db: ReadDb, input: ValidationInput, out: Collector, lookups: IdLookups): void {
  const plan = input.prepared.plan;
  const pid = input.project_id;
  const rows = db.all<{
    legacy_kind: string;
    legacy_scope: string;
    legacy_key: string;
    content_hash: string;
    new_object_id: string | null;
    new_version_id: string | null;
    new_row_id: string | null;
  }>(
    `SELECT legacy_kind, legacy_scope, legacy_key, content_hash, new_object_id, new_version_id, new_row_id
       FROM legacy_mappings WHERE import_batch_id = ?`,
    input.batch.id,
  );
  const slot = (kind: string, scope: string, key: string, hash: string): string =>
    JSON.stringify([kind, scope, key, hash]);
  const by_slot = new Map(rows.map((row) => [slot(row.legacy_kind, row.legacy_scope, row.legacy_key, row.content_hash), row]));

  const submission_rows = db.all<{ id: string; raw_blob_id: string | null }>(
    "SELECT id, raw_blob_id FROM submissions WHERE project_id = ?",
    pid,
  );
  const submission_by_id = new Map(submission_rows.map((row) => [row.id, row]));
  const snapshot_ids = new Set(
    db.all<{ id: string }>("SELECT id FROM snapshots WHERE project_id = ?", pid).map((row) => row.id),
  );

  // Every plan mapping must be there and point at the slot the plan expects.
  for (const mapping of plan.mappings) {
    if (!mapping_resolvable(plan, input.prepared, mapping)) continue;
    out.checked.ids += 1;
    const label = `${mapping.kind}/${mapping.scope}/${mapping.key}`;
    const row = by_slot.get(slot(mapping.kind, mapping.scope, mapping.key, mapping.content_hash));
    if (row === undefined) {
      out.add("ids", label, { problem: "mapping_missing" });
      continue;
    }
    if (mapping.object_key !== null) {
      const expected_object = lookups.plan_object_id.get(mapping.object_key);
      if (expected_object === undefined || row.new_object_id !== expected_object) {
        out.add("ids", label, { problem: "object_differs" });
        continue;
      }
      const expected_version = mapping.version_key === null ? null : lookups.version_id_of(mapping.version_key) ?? null;
      if (row.new_version_id !== expected_version) {
        out.add("ids", label, { problem: "version_differs" });
        continue;
      }
    }
    if (mapping.row !== null) {
      if (mapping.row.kind === "blob") {
        const blob = lookups.blob_of_path(mapping.row.path);
        if (blob === undefined || row.new_row_id !== blob.id) out.add("ids", label, { problem: "blob_differs" });
      } else if (mapping.row.kind === "submission") {
        const raw_path = plan.submissions.find((entry) => entry.key === (mapping.row as { key: string }).key)?.raw_blob_path;
        const expected_blob = raw_path === undefined ? undefined : lookups.blob_of_path(raw_path);
        const submission = row.new_row_id === null ? undefined : submission_by_id.get(row.new_row_id);
        if (submission === undefined || expected_blob === undefined || submission.raw_blob_id !== expected_blob.id) {
          out.add("ids", label, { problem: "submission_differs" });
        }
      } else if (row.new_row_id === null || !snapshot_ids.has(row.new_row_id)) {
        out.add("ids", label, { problem: "snapshot_differs" });
      }
    }
  }

  // Every mapping row of the batch must resolve to a row that exists.
  for (const row of rows) {
    const label = `${row.legacy_kind}/${row.legacy_scope}/${row.legacy_key}`;
    out.checked.ids += 1;
    if (row.new_object_id !== null && !lookups.object_by_id.has(row.new_object_id)) {
      out.add("ids", label, { problem: "object_missing" });
    }
    if (row.new_version_id !== null) {
      const version = lookups.version_by_id.get(row.new_version_id);
      if (version === undefined || version.object_id !== row.new_object_id) {
        out.add("ids", label, { problem: "version_missing" });
      }
    }
    if (
      row.new_row_id !== null &&
      !lookups.blob_by_id.has(row.new_row_id) &&
      !submission_by_id.has(row.new_row_id) &&
      !snapshot_ids.has(row.new_row_id)
    ) {
      out.add("ids", label, { problem: "row_missing" });
    }
  }
}

// ---------------------------------------------------------------------------
// bodies

function compare_text(
  out: Collector,
  path: string,
  field: string,
  version_no: number,
  expected: string | null | undefined,
  actual: string | null | undefined,
): void {
  out.checked.bodies += 1;
  const left = text_hash(expected);
  const right = text_hash(actual);
  if (left !== right) out.add("bodies", path, { field, version_no, expected_sha256: left, actual_sha256: right });
}

function check_bodies(
  db: ReadDb,
  input: ValidationInput,
  out: Collector,
  plan_object_id: Map<string, string | undefined>,
  version_by_id: Map<string, VersionRef>,
): void {
  const plan = input.prepared.plan;
  const pid = input.project_id;
  const artifact_rows = new Map(
    db
      .all<{ version_id: string; title: string; question: string | null; summary: string; body_md: string | null }>(
        "SELECT version_id, title, question, summary, body_md FROM artifact_versions WHERE project_id = ?",
        pid,
      )
      .map((row) => [row.version_id, row]),
  );
  const source_rows = new Map(
    db
      .all<{ version_id: string; title: string; url: string | null }>(
        "SELECT version_id, title, url FROM source_versions WHERE project_id = ?",
        pid,
      )
      .map((row) => [row.version_id, row]),
  );
  const question_rows = new Map(
    db
      .all<{ version_id: string; text: string }>("SELECT version_id, text FROM question_versions WHERE project_id = ?", pid)
      .map((row) => [row.version_id, row]),
  );
  const answer_rows = new Map(
    db
      .all<{ version_id: string; value: string }>("SELECT version_id, value FROM answer_versions WHERE project_id = ?", pid)
      .map((row) => [row.version_id, row]),
  );
  const message_rows = new Map(
    db
      .all<{ version_id: string; body_md: string }>("SELECT version_id, body_md FROM message_versions WHERE project_id = ?", pid)
      .map((row) => [row.version_id, row]),
  );
  const followup_rows = new Map(
    db
      .all<{ version_id: string; description: string }>(
        "SELECT version_id, description FROM followup_versions WHERE project_id = ?",
        pid,
      )
      .map((row) => [row.version_id, row]),
  );

  // Versions are found by slot, not by id: ids are random.
  const version_ids = new Map<string, string>();
  for (const version of version_by_id.values()) version_ids.set(`${version.object_id}:${version.version_no}`, version.id);

  for (const row of plan.objects) {
    const object_id = plan_object_id.get(row.key);
    const versions: Array<{ version: PlanObjectRow["version"]; artifact?: PlanObjectRow["artifact"] }> = [
      ...(row.earlier ?? []).map((entry) => ({ version: entry.version, artifact: entry.artifact })),
      { version: row.version, artifact: row.artifact },
    ];
    for (const entry of versions) {
      const version_no = entry.version.version_no;
      const version_id = object_id === undefined ? undefined : version_ids.get(`${object_id}:${version_no}`);
      if (version_id === undefined) {
        out.checked.bodies += 1;
        out.add("bodies", row.key, { problem: "version_missing", version_no });
        continue;
      }
      const stored = version_by_id.get(version_id);
      out.checked.bodies += 1;
      if (stored?.content_hash !== entry.version.content_hash) {
        out.add("bodies", row.key, { field: "content_hash", version_no });
      }
      if (row.kind === "artifact" && entry.artifact !== undefined) {
        const stored_artifact = artifact_rows.get(version_id);
        compare_text(out, row.key, "title", version_no, entry.artifact.title, stored_artifact?.title);
        compare_text(out, row.key, "question", version_no, entry.artifact.question, stored_artifact?.question);
        compare_text(out, row.key, "summary", version_no, entry.artifact.summary, stored_artifact?.summary);
        compare_text(out, row.key, "body_md", version_no, entry.artifact.body_md, stored_artifact?.body_md);
      } else if (row.source !== undefined) {
        const stored_source = source_rows.get(version_id);
        compare_text(out, row.key, "title", version_no, row.source.title, stored_source?.title);
        compare_text(out, row.key, "url", version_no, row.source.url, stored_source?.url);
      } else if (row.question !== undefined) {
        compare_text(out, row.key, "text", version_no, row.question.text, question_rows.get(version_id)?.text);
      } else if (row.answer !== undefined) {
        out.checked.bodies += 1;
        const stored_answer = answer_rows.get(version_id);
        if (stored_answer === undefined || !same_json(stored_answer.value, row.answer.value)) {
          out.add("bodies", row.key, { field: "value", version_no });
        }
      } else if (row.message !== undefined) {
        compare_text(out, row.key, "body_md", version_no, row.message.body_md, message_rows.get(version_id)?.body_md);
      } else if (row.followup !== undefined) {
        compare_text(out, row.key, "description", version_no, row.followup.description, followup_rows.get(version_id)?.description);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// links

interface LinkLookups {
  plan_object_id: Map<string, string | undefined>;
  version_id_of: (key: string) => string | undefined;
  blob_of_path: (path: string) => BlobRef | undefined;
}

function check_links(db: ReadDb, input: ValidationInput, out: Collector, lookups: LinkLookups): void {
  const plan = input.prepared.plan;
  const pid = input.project_id;
  const version_id_of = lookups.version_id_of;
  check_planned_links(db, input, out, lookups);
  const relation_rows = db.all<{ from_version_id: string; to_version_id: string; kind: string }>(
    "SELECT from_version_id, to_version_id, kind FROM version_relations WHERE project_id = ?",
    pid,
  );
  const relations = new Set(relation_rows.map((row) => `${row.from_version_id}|${row.to_version_id}|${row.kind}`));
  for (const relation of plan.relations) {
    out.checked.links += 1;
    const from = version_id_of(relation.from_version_key);
    const to = version_id_of(relation.to_version_key);
    if (from === undefined || to === undefined || !relations.has(`${from}|${to}|${relation.kind}`)) {
      out.add("links", `${relation.kind}`, { problem: "relation_missing" });
    }
  }

  // Nothing may point at a row that is not in this project. Each query counts
  // the links of one table that have no target.
  const dangling: Array<[string, string, string | null]> = [
    [
      "citations",
      "SELECT count(*) AS n FROM citations c WHERE c.project_id = ? AND NOT EXISTS (SELECT 1 FROM artifact_versions v WHERE v.project_id = c.project_id AND v.version_id = c.artifact_version_id)",
      "SELECT count(*) AS n FROM citations WHERE project_id = ?",
    ],
    [
      "citations/source",
      "SELECT count(*) AS n FROM citations c WHERE c.project_id = ? AND NOT EXISTS (SELECT 1 FROM source_versions v WHERE v.project_id = c.project_id AND v.version_id = c.source_version_id)",
      null,
    ],
    [
      "version_relations/from",
      "SELECT count(*) AS n FROM version_relations r WHERE r.project_id = ? AND NOT EXISTS (SELECT 1 FROM object_versions v WHERE v.project_id = r.project_id AND v.id = r.from_version_id)",
      "SELECT count(*) AS n FROM version_relations WHERE project_id = ?",
    ],
    [
      "version_relations/to",
      "SELECT count(*) AS n FROM version_relations r WHERE r.project_id = ? AND NOT EXISTS (SELECT 1 FROM object_versions v WHERE v.project_id = r.project_id AND v.id = r.to_version_id)",
      null,
    ],
    [
      "round_contents",
      "SELECT count(*) AS n FROM round_contents r WHERE r.project_id = ? AND NOT EXISTS (SELECT 1 FROM object_versions v WHERE v.project_id = r.project_id AND v.object_id = r.object_id AND v.id = r.version_id)",
      "SELECT count(*) AS n FROM round_contents WHERE project_id = ?",
    ],
    [
      "followup_versions/base",
      "SELECT count(*) AS n FROM followup_versions f WHERE f.project_id = ? AND f.base_artifact_version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM artifact_versions v WHERE v.project_id = f.project_id AND v.version_id = f.base_artifact_version_id)",
      "SELECT count(*) AS n FROM followup_versions WHERE project_id = ? AND base_artifact_version_id IS NOT NULL",
    ],
    [
      "threads/target",
      "SELECT count(*) AS n FROM threads t WHERE t.project_id = ? AND NOT EXISTS (SELECT 1 FROM objects o WHERE o.project_id = t.project_id AND o.id = t.target_object_id)",
      "SELECT count(*) AS n FROM threads WHERE project_id = ?",
    ],
    [
      "messages/thread",
      "SELECT count(*) AS n FROM messages m WHERE m.project_id = ? AND NOT EXISTS (SELECT 1 FROM threads t WHERE t.project_id = m.project_id AND t.object_id = m.thread_id)",
      "SELECT count(*) AS n FROM messages WHERE project_id = ?",
    ],
    [
      "question_set_members",
      "SELECT count(*) AS n FROM question_set_members m WHERE m.project_id = ? AND NOT EXISTS (SELECT 1 FROM question_versions v WHERE v.project_id = m.project_id AND v.object_id = m.question_id AND v.version_id = m.question_version_id)",
      "SELECT count(*) AS n FROM question_set_members WHERE project_id = ?",
    ],
  ];
  for (const [label, broken_sql, examined_sql] of dangling) {
    if (examined_sql !== null) out.checked.links += count_of(db, examined_sql, pid);
    const broken = count_of(db, broken_sql, pid);
    if (broken > 0) out.add("links", label, { broken });
  }
}

/**
 * Every link the source plan names must point at the object, version, round,
 * stage or submission the plan key resolves to; that a target merely exists is
 * not enough (another valid question, thread or stage would pass that).
 * A plan key that does not resolve compares as "missing", never as a match.
 */
function check_planned_links(db: ReadDb, input: ValidationInput, out: Collector, lookups: LinkLookups): void {
  const plan = input.prepared.plan;
  const pid = input.project_id;
  const MISSING = "\u0000missing";
  const object_of = (key: string): string => lookups.plan_object_id.get(key) ?? `${MISSING}:${key}`;
  const version_of = (key: string): string => lookups.version_id_of(key) ?? `${MISSING}:${key}`;
  const optional_version = (key: string | null): string | null => (key === null ? null : version_of(key));
  const link = (path: string, problem: string, same: boolean): void => {
    out.checked.links += 1;
    if (!same) out.add("links", path, { problem });
  };

  // stages and rounds by their plan keys
  const stage_id = new Map<string, string>();
  for (const row of db.all<{ id: string; key: string }>("SELECT id, key FROM stages WHERE project_id = ?", pid)) {
    stage_id.set(row.key, row.id);
  }
  const stage_of = (key: string): string => stage_id.get(key) ?? `${MISSING}:${key}`;
  const round_id = new Map<string, string>();
  for (const row of db.all<{ id: string; key: string; round_no: bigint }>(
    `SELECT r.id, s.key, r.round_no FROM rounds r JOIN stages s ON s.project_id = r.project_id AND s.id = r.stage_id
      WHERE r.project_id = ?`,
    pid,
  )) {
    round_id.set(`${row.key}:${num(row.round_no)}`, row.id);
  }
  const round_of = (key: string): string => round_id.get(key) ?? `${MISSING}:${key}`;

  // submissions by the blob of their raw file (a plan submission key is that file)
  const submissions_by_blob = new Map<string, Set<string>>();
  for (const row of db.all<{ id: string; raw_blob_id: string | null }>(
    "SELECT id, raw_blob_id FROM submissions WHERE project_id = ?",
    pid,
  )) {
    if (row.raw_blob_id === null) continue;
    const ids = submissions_by_blob.get(row.raw_blob_id) ?? new Set<string>();
    ids.add(row.id);
    submissions_by_blob.set(row.raw_blob_id, ids);
  }
  const submission_path = new Map(plan.submissions.map((entry) => [entry.key, entry.raw_blob_path]));
  // The importer writes a submission only when its raw file was read; a link to
  // one that was not written stays empty (as the importer leaves it).
  const submission_matches = (key: string | null, actual: string | null): boolean => {
    const path = key === null ? undefined : submission_path.get(key);
    const written = path !== undefined && input.prepared.bytes.has(path);
    if (!written) return actual === null;
    const blob = lookups.blob_of_path(path);
    if (blob === undefined || actual === null) return false;
    return submissions_by_blob.get(blob.id)?.has(actual) ?? false;
  };

  const answers = new Map(
    db
      .all<{ object_id: string; question_id: string; submission_id: string | null }>(
        "SELECT object_id, question_id, submission_id FROM answers WHERE project_id = ?",
        pid,
      )
      .map((row) => [row.object_id, row]),
  );
  const answer_versions = new Map(
    db
      .all<{ version_id: string; object_id: string; question_id: string; question_version_id: string }>(
        "SELECT version_id, object_id, question_id, question_version_id FROM answer_versions WHERE project_id = ?",
        pid,
      )
      .map((row) => [row.version_id, row]),
  );
  const threads = new Map(
    db
      .all<{ object_id: string; target_object_id: string; target_version_id: string | null; context_kind: string }>(
        "SELECT object_id, target_object_id, target_version_id, context_kind FROM threads WHERE project_id = ?",
        pid,
      )
      .map((row) => [row.object_id, row]),
  );
  const messages = new Map(
    db
      .all<{ object_id: string; thread_id: string; submission_id: string | null }>(
        "SELECT object_id, thread_id, submission_id FROM messages WHERE project_id = ?",
        pid,
      )
      .map((row) => [row.object_id, row]),
  );
  const message_versions = new Map(
    db
      .all<{ version_id: string; object_id: string; thread_id: string }>(
        "SELECT version_id, object_id, thread_id FROM message_versions WHERE project_id = ?",
        pid,
      )
      .map((row) => [row.version_id, row]),
  );
  const followup_versions = new Map(
    db
      .all<{
        version_id: string;
        object_id: string;
        target_stage_id: string | null;
        base_artifact_version_id: string | null;
      }>(
        "SELECT version_id, object_id, target_stage_id, base_artifact_version_id FROM followup_versions WHERE project_id = ?",
        pid,
      )
      .map((row) => [row.version_id, row]),
  );

  for (const row of plan.objects) {
    const object_id = object_of(row.key);
    const version_id = version_of(row.version.key);
    if (row.answer !== undefined) {
      const answer = row.answer;
      const stored = answers.get(object_id);
      link(`answers/${row.key}/question`, "answer_question_differs", stored?.question_id === object_of(answer.question_key));
      link(
        `answers/${row.key}/submission`,
        "answer_submission_differs",
        stored !== undefined && submission_matches(answer.submission_key, stored.submission_id),
      );
      const version = answer_versions.get(version_id);
      link(
        `answer_versions/${row.key}/question`,
        "answer_version_question_differs",
        version !== undefined &&
          version.object_id === object_id &&
          version.question_id === object_of(answer.question_key) &&
          version.question_version_id === version_of(answer.question_version_key),
      );
    } else if (row.thread !== undefined) {
      const thread = row.thread;
      const stored = threads.get(object_id);
      link(
        `threads/${row.key}/target`,
        "thread_target_differs",
        stored !== undefined &&
          stored.target_object_id === object_of(thread.target_object_key) &&
          stored.target_version_id === optional_version(thread.target_version_key) &&
          stored.context_kind === thread.context_kind,
      );
    } else if (row.message !== undefined) {
      const message = row.message;
      const stored = messages.get(object_id);
      const thread_id = object_of(message.thread_key);
      link(`messages/${row.key}/thread`, "message_thread_differs", stored?.thread_id === thread_id);
      link(
        `messages/${row.key}/submission`,
        "message_submission_differs",
        stored !== undefined && submission_matches(message.submission_key, stored.submission_id),
      );
      const version = message_versions.get(version_id);
      link(
        `message_versions/${row.key}/thread`,
        "message_version_thread_differs",
        version !== undefined && version.object_id === object_id && version.thread_id === thread_id,
      );
    } else if (row.followup !== undefined) {
      const followup = row.followup;
      const version = followup_versions.get(version_id);
      link(
        `followup_versions/${row.key}/target`,
        "followup_target_differs",
        version !== undefined &&
          version.object_id === object_id &&
          version.target_stage_id === (followup.target_stage_key === null ? null : stage_of(followup.target_stage_key)) &&
          version.base_artifact_version_id === optional_version(followup.base_version_key),
      );
    }
  }

  // round contents: the same (round, object, version, position, role) rows, no more, no less
  const expected_contents = new Map<string, number>();
  for (const content of plan.round_contents) {
    const key = JSON.stringify([
      round_of(content.round_key),
      object_of(content.object_key),
      version_of(content.version_key),
      content.position,
      content.role,
    ]);
    expected_contents.set(key, (expected_contents.get(key) ?? 0) + 1);
  }
  const actual_contents = new Map<string, number>();
  for (const row of db.all<{ round_id: string; object_id: string; version_id: string; position: bigint; role: string }>(
    "SELECT round_id, object_id, version_id, position, role FROM round_contents WHERE project_id = ?",
    pid,
  )) {
    const key = JSON.stringify([row.round_id, row.object_id, row.version_id, num(row.position), row.role]);
    actual_contents.set(key, (actual_contents.get(key) ?? 0) + 1);
  }
  for (const [key, count] of expected_contents) {
    link("round_contents", "round_content_differs", actual_contents.get(key) === count);
  }
  for (const key of actual_contents.keys()) {
    if (!expected_contents.has(key)) link("round_contents", "round_content_unexpected", false);
  }

  // question sets: each plan set is there (stage, round, form, version) with exactly its members
  const sets = db.all<{
    id: string;
    stage_id: string;
    round_id: string | null;
    purpose: string;
    form_key: string;
    version_no: bigint;
  }>("SELECT id, stage_id, round_id, purpose, form_key, version_no FROM question_sets WHERE project_id = ?", pid);
  const members_of = new Map<string, string[]>();
  for (const row of db.all<{ set_id: string; question_id: string; question_version_id: string; position: bigint }>(
    "SELECT set_id, question_id, question_version_id, position FROM question_set_members WHERE project_id = ?",
    pid,
  )) {
    const list = members_of.get(row.set_id) ?? [];
    list.push(JSON.stringify([row.question_id, row.question_version_id, num(row.position)]));
    members_of.set(row.set_id, list);
  }
  const used_sets = new Set<string>();
  for (const set of plan.question_sets) {
    const wanted_members = set.members
      .map((member) => JSON.stringify([object_of(member.question_key), version_of(member.question_version_key), member.position]))
      .sort();
    const wanted_round = set.round_key === null ? null : round_of(set.round_key);
    const found = sets.find(
      (row) =>
        !used_sets.has(row.id) &&
        row.stage_id === stage_of(set.stage_key) &&
        row.round_id === wanted_round &&
        row.purpose === set.purpose &&
        row.form_key === set.form_key &&
        num(row.version_no) === set.version_no &&
        JSON.stringify([...(members_of.get(row.id) ?? [])].sort()) === JSON.stringify(wanted_members),
    );
    if (found !== undefined) used_sets.add(found.id);
    link(`question_sets/${set.key}`, "question_set_differs", found !== undefined);
  }
}

// ---------------------------------------------------------------------------
// footnotes

function check_footnotes(
  db: ReadDb,
  input: ValidationInput,
  out: Collector,
  version_id_of: (key: string) => string | undefined,
): void {
  const plan = input.prepared.plan;
  const rows = db.all<{ artifact_version_id: string; citation_no: bigint; source_version_id: string }>(
    "SELECT artifact_version_id, citation_no, source_version_id FROM citations WHERE project_id = ?",
    input.project_id,
  );
  const actual = new Map<string, Array<[number, string]>>();
  for (const row of rows) {
    const list = actual.get(row.artifact_version_id) ?? [];
    list.push([num(row.citation_no), row.source_version_id]);
    actual.set(row.artifact_version_id, list);
  }
  const expected = new Map<string, Array<[number, string | undefined]>>();
  for (const citation of plan.citations) {
    const artifact_version = version_id_of(citation.artifact_version_key) ?? `missing:${citation.artifact_version_key}`;
    const list = expected.get(artifact_version) ?? [];
    list.push([citation.citation_no, version_id_of(citation.source_version_key)]);
    expected.set(artifact_version, list);
  }
  const ordered = <T>(list: Array<[number, T]>): Array<[number, T]> => [...list].sort((a, b) => a[0] - b[0]);
  for (const [artifact_version, list] of expected) {
    out.checked.footnotes += list.length;
    const found = ordered(actual.get(artifact_version) ?? []);
    const wanted = ordered(list);
    const same =
      found.length === wanted.length &&
      wanted.every((entry, index) => entry[0] === found[index]![0] && entry[1] === found[index]![1]);
    if (!same) {
      out.add("footnotes", undefined, {
        problem: "numbering_differs",
        expected: wanted.map((entry) => entry[0]),
        actual: found.map((entry) => entry[0]),
      });
    }
  }
  for (const [artifact_version, list] of actual) {
    if (!expected.has(artifact_version)) {
      out.checked.footnotes += list.length;
      out.add("footnotes", undefined, { problem: "unexpected_citations", count: list.length });
    }
  }
}

// ---------------------------------------------------------------------------
// files

interface FileLookups {
  blobs: BlobRef[];
  blob_by_id: Map<string, BlobRef>;
  blob_of_path: (path: string) => BlobRef | undefined;
  version_id_of: (key: string) => string | undefined;
}

function check_files(db: ReadDb, input: ValidationInput, out: Collector, lookups: FileLookups): void {
  const plan = input.prepared.plan;
  const bytes = input.prepared.bytes;
  const pid = input.project_id;

  // The state a blob must have: quarantined when any plan path with the same bytes is.
  const quarantined = new Set<string>();
  for (const blob of plan.blobs) {
    const content = bytes.get(blob.path);
    if (content !== undefined && blob.state === "quarantined") {
      quarantined.add(`${sha256_hex(content)}:${content.byteLength}`);
    }
  }
  for (const blob of plan.blobs) {
    const content = bytes.get(blob.path);
    if (content === undefined) continue;
    out.checked.files += 1;
    const sha = sha256_hex(content);
    const found = lookups.blob_of_path(blob.path);
    if (found === undefined) {
      out.add("files", blob.path, { problem: "blob_missing" });
      continue;
    }
    const expected_state = quarantined.has(`${sha}:${content.byteLength}`) ? "quarantined" : "ready";
    if (found.state !== expected_state) {
      out.add("files", blob.path, { problem: "state_differs", expected: expected_state, actual: found.state });
    }
  }

  // Every stored blob: the bytes on disk are the bytes the row says.
  for (const blob of lookups.blobs) {
    out.checked.files += 1;
    const label = blob.original_name ?? blob.id;
    try {
      const disk = read_storage_bytes(input.objects_dir, pid, blob.storage_key);
      if (disk.byteLength !== blob.size || sha256_hex(disk) !== blob.sha256) {
        out.add("files", label, { problem: "disk_differs" });
      }
    } catch {
      out.add("files", label, { problem: "disk_unreadable" });
    }
  }

  // The batch's own manifest and report blobs.
  for (const [role, blob_id] of [
    ["source_manifest", input.batch.source_manifest_blob_id],
    ["report", input.batch.report_blob_id],
  ] as const) {
    if (blob_id === null) continue;
    out.checked.files += 1;
    if (!lookups.blob_by_id.has(blob_id)) out.add("files", role, { problem: "blob_missing" });
  }

  // Attached files: each plan attachment is there with the same blob and role.
  const attached = new Set(
    db
      .all<{ version_id: string; blob_id: string; role: string }>(
        "SELECT version_id, blob_id, role FROM version_files WHERE project_id = ?",
        pid,
      )
      .map((row) => `${row.version_id}|${row.blob_id}|${row.role}`),
  );
  for (const file of plan.version_files) {
    out.checked.files += 1;
    const version = lookups.version_id_of(file.version_key);
    const blob = lookups.blob_of_path(file.blob_path);
    if (version === undefined || blob === undefined || !attached.has(`${version}|${blob.id}|${file.role}`)) {
      out.add("files", file.blob_path, { problem: "attachment_missing", role: file.role });
    }
  }
}

// ---------------------------------------------------------------------------
// unprocessed answers

function processed_names(bytes: Map<string, Uint8Array>): Set<string> {
  const content = bytes.get("project.json");
  const names = new Set<string>();
  if (content === undefined) return names;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(content)) as { processed?: unknown };
    if (Array.isArray(parsed.processed)) {
      for (const name of parsed.processed) if (typeof name === "string") names.add(name);
    }
  } catch {
    // A damaged project.json never gets here (the batch would be failed).
  }
  return names;
}

function check_unprocessed_answers(
  db: ReadDb,
  input: ValidationInput,
  out: Collector,
  blob_of_path: (path: string) => BlobRef | undefined,
): void {
  const plan = input.prepared.plan;
  const bytes = input.prepared.bytes;
  const pid = input.project_id;
  const processed = processed_names(bytes);

  const answers_per_submission = new Map<string, number>();
  for (const row of plan.objects) {
    if (row.answer === undefined) continue;
    const key = row.answer.submission_key;
    answers_per_submission.set(key, (answers_per_submission.get(key) ?? 0) + 1);
  }

  for (const submission of plan.submissions) {
    const path = submission.raw_blob_path;
    if (!path.startsWith("feedback/") || !path.endsWith(".json")) continue;
    if (processed.has(path.slice("feedback/".length))) continue;
    out.checked.unprocessed_answers += 1;
    const blob = blob_of_path(path);
    if (blob === undefined) {
      out.add("unprocessed_answers", path, { problem: "raw_file_missing" });
      continue;
    }
    // Same bytes share one blob: compare the whole group, not one row.
    const group = plan.submissions.filter((other) => blob_of_path(other.raw_blob_path)?.id === blob.id);
    const expected_submissions = group.length;
    const expected_answers = group.reduce((sum, other) => sum + (answers_per_submission.get(other.key) ?? 0), 0);
    const actual_submissions = count_of(
      db,
      "SELECT count(*) AS n FROM submissions WHERE project_id = ? AND raw_blob_id = ?",
      pid,
      blob.id,
    );
    const actual_answers = count_of(
      db,
      `SELECT count(*) AS n FROM answers a
        WHERE a.project_id = ? AND a.submission_id IN
              (SELECT s.id FROM submissions s WHERE s.project_id = a.project_id AND s.raw_blob_id = ?)`,
      pid,
      blob.id,
    );
    if (actual_submissions !== expected_submissions || actual_answers !== expected_answers) {
      out.add("unprocessed_answers", path, {
        problem: "answers_differ",
        expected: { submissions: expected_submissions, answers: expected_answers },
        actual: { submissions: actual_submissions, answers: actual_answers },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// report regeneration (PR16: the real generator; a difference is a problem)
//
// The old tool rebuilt reports/<stage>/report.md and report.html from project.json
// (and feedback/*.json). report.ts is the port of that generator: the report is
// regenerated from the very files the import read and compared with the report the
// old tool left behind. The "작성 <시각>" line and the page's built time are not
// compared. Other report files (pdf, eli5, docx ...) are not regenerated.

const REPORT_PATH = /^reports\/([a-z0-9_-]+)\/report\.(md|html)$/;

function legacy_project_from_bytes(bytes: Map<string, Uint8Array>): Dict | null {
  const raw = bytes.get("project.json");
  if (raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    let library: Dict | null = null;
    const library_bytes = bytes.get("library.json");
    if (library_bytes !== undefined) {
      try {
        const lib: unknown = JSON.parse(new TextDecoder().decode(library_bytes));
        if (lib !== null && typeof lib === "object" && !Array.isArray(lib)) library = lib as Dict;
      } catch {
        library = null;
      }
    }
    return normalize_project(parsed as Dict, library);
  } catch {
    return null;
  }
}

function legacy_feedback(bytes: Map<string, Uint8Array>, processed: ReadonlySet<string>): FeedbackEntry[] {
  const files: Array<{ name: string; text: string }> = [];
  for (const [path, content] of bytes) {
    if (!/^feedback\/[^/]+\.json$/.test(path)) continue;
    files.push({ name: path.slice("feedback/".length), text: new TextDecoder().decode(content) });
  }
  return feedback_entries(files, processed);
}

function check_reports(
  plan: ImportPlan,
  bytes: Map<string, Uint8Array>,
  out: Collector,
  regenerated: RegeneratedReport[],
): void {
  const stages = new Set<string>(LEGACY_STAGE_KEYS);
  let project: Dict | null | undefined;
  let feedback: FeedbackEntry[] = [];
  for (const file of plan.manifest_files) {
    const match = file.path.match(REPORT_PATH);
    if (match === null || !stages.has(match[1]!)) continue;
    const original = bytes.get(file.path);
    if (original === undefined) continue;
    if (project === undefined) {
      project = legacy_project_from_bytes(bytes);
      if (project !== null) feedback = legacy_feedback(bytes, new Set(Array.isArray(project.processed) ? project.processed.filter((n: unknown): n is string => typeof n === "string") : []));
    }
    const stage_key = match[1] as LegacyStageKey;
    out.checked.reports_regeneration += 1;
    let matches = false;
    if (project !== null) {
      const made = stage_report(project, stage_key, feedback, "0000-00-00 00:00");
      const text = match[2] === "md" ? made.markdown : made.html;
      matches = without_report_time(new TextDecoder().decode(original)) === without_report_time(text);
    }
    regenerated.push({ path: file.path, matches });
    if (!matches) out.add("reports_regeneration", file.path, { problem: "differs_from_regenerated" });
  }
}

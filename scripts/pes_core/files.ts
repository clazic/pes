// Public object-storage functions (stage 2 PR9).
//
// The command definitions in scripts/pes_core/commands/files.ts hold all SQL
// for blobs, file_policies and version_files. The functions here are the public
// seam: each state-changing function calls CommandService.execute exactly once,
// while byte movements happen outside the transaction.
//
// Rules that matter here:
// - A blob id is the only public handle. Storage keys, absolute paths and
//   signed URLs are never accepted in its place and never leave this module.
// - complete_upload reads stored bytes only through the objects folder injected
//   at CommandService construction, and compares their measured sha256/size
//   with the reservation; the caller's numbers are not proof.
// - A public wrapper handed a different objects folder refuses before reading
//   or writing anything.
// - store_blob only writes a staging blob of the same project, derives the
//   path from the database storage_key, and refuses every symlink or escape.
// - gc_orphans deletes rows in one transaction and removes bytes only after it
//   has committed. A failed transaction leaves the disk untouched, and the next
//   gc reconciles whatever a failed unlink left behind.

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type { CommandOutcome, CommandService, MutationContext } from "./commands.ts";
import { canonical_object_store_dir } from "./commands/shared.ts";
import type { Db } from "./db.ts";
import { ApiError } from "./errors.ts";

/** The object store a command wrapper works with: the database plus its objects folder. */
export interface FileStore {
  db: Db;
  objects_dir: string;
}

interface BlobRow {
  id: string;
  project_id: string;
  storage_key: string;
  sha256: string;
  size: bigint;
  media_type: string;
  state: string;
}

export interface StoredBlob {
  blob_id: string;
  project_id: string;
  sha256: string;
  size: number;
  media_type: string;
  bytes: Uint8Array;
}

/** A regular file below the project's folder in the objects dir. */
export interface ProjectFile {
  key: string;
  path: string;
  mtime_ms: number;
}

const SAFE_ID = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;
const SAFE_SEGMENT = /^[0-9A-Za-z._-]+$/;

function invalid(message: string): never {
  throw new ApiError("invalid_payload", message);
}

function not_found(message: string): never {
  throw new ApiError("not_found", message);
}

function unsafe(message = "the storage location is not safe"): never {
  throw new ApiError("conflict", message);
}

function is_record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A server-made id: no path separator, URL scheme, drive letter or dot segment. */
export function require_safe_id(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !value.isWellFormed() ||
    !SAFE_ID.test(value)
  ) {
    throw invalid(`${field} must be a safe id`);
  }
  return value;
}

const MEDIA_TYPE_TOKEN = "[A-Za-z0-9!#$&^_.+-]+";
const SAFE_MEDIA_TYPE = new RegExp(
  `^${MEDIA_TYPE_TOKEN}/${MEDIA_TYPE_TOKEN}(?:[ \\t]*;[\\x20-\\x7e]*)?$`,
);

/**
 * True when a media type is plain MIME syntax (type/subtype plus optional
 * printable-ASCII parameters). Control characters, CR/LF and non-ASCII text
 * are never allowed, so a stored value can be sent as a header value safely.
 */
export function is_safe_media_type(value: unknown): value is string {
  return typeof value === "string" && value.length <= 255 && SAFE_MEDIA_TYPE.test(value);
}

export function sha256_hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function resolve_objects_dir(objects_dir: unknown): string {
  if (typeof objects_dir !== "string" || objects_dir.length === 0 || !isAbsolute(objects_dir)) {
    throw unsafe("the object store path must be absolute");
  }
  return resolve(objects_dir);
}

/**
 * The one canonical store for this database, and the store handed to a public
 * wrapper. A different folder is refused before any read or write. Both
 * errors carry a fixed message: no absolute path, no store folder.
 */
function require_canonical_store(store: FileStore): string {
  const registered = canonical_object_store_dir(store.db);
  if (registered === null) {
    throw new ApiError("conflict", "no canonical object store is configured");
  }
  const given = resolve_objects_dir(store.objects_dir);
  if (given !== registered) {
    throw new ApiError("conflict", "the object store does not match the service");
  }
  return registered;
}

/** The service is the authority; the store must be its folder and its database's registration. */
function require_service_store(service: CommandService, store: FileStore): string {
  const canonical = service.object_store_dir;
  if (canonical === null) {
    throw new ApiError("conflict", "no canonical object store is configured");
  }
  const given = resolve_objects_dir(store.objects_dir);
  if (given !== canonical) {
    throw new ApiError("conflict", "the object store does not match the service");
  }
  if (canonical_object_store_dir(store.db) !== canonical) {
    throw new ApiError("conflict", "the object store does not match the service");
  }
  return canonical;
}

function lstat_or_undefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Split a database storage_key into path segments. It must be a relative POSIX
 * path below this project's own folder; absolute paths, "..", backslashes,
 * drive letters and empty segments are refused.
 */
function storage_segments(storage_key: unknown, project_id: string): string[] {
  if (typeof storage_key !== "string" || storage_key.length === 0 || storage_key.includes("\0")) {
    throw unsafe("the storage key is not a safe relative path");
  }
  if (storage_key.startsWith("/") || storage_key.includes("\\") || /^[A-Za-z]:/.test(storage_key)) {
    throw unsafe("the storage key is not a safe relative path");
  }
  const parts = storage_key.split("/");
  if (parts.length < 2) throw unsafe("the storage key is not below the project folder");
  for (const part of parts) {
    if (part.length === 0 || part === "." || part === ".." || !SAFE_SEGMENT.test(part)) {
      throw unsafe("the storage key is not a safe relative path");
    }
  }
  if (parts[0] !== project_id) throw unsafe("the storage key is outside the project folder");
  return parts;
}

/** Create the objects root when missing; an existing symlink or file is refused. */
function ensure_objects_root(objects_dir: string): string {
  const root = resolve_objects_dir(objects_dir);
  const stat = lstat_or_undefined(root);
  if (stat === undefined) {
    mkdirSync(root, { recursive: true });
    const created = lstat_or_undefined(root);
    if (created === undefined || created.isSymbolicLink() || !created.isDirectory()) {
      throw unsafe("the objects folder could not be created safely");
    }
    return root;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw unsafe("the objects folder is not a real directory");
  }
  return root;
}

/** Write bytes to the path derived from storage_key, atomically, without following links. */
function write_storage_bytes_inner(
  objects_dir: string,
  project_id: string,
  storage_key: string,
  bytes: Uint8Array,
): void {
  const parts = storage_segments(storage_key, project_id);
  let current = ensure_objects_root(objects_dir);
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = join(current, parts[index]!);
    const stat = lstat_or_undefined(current);
    if (stat === undefined) {
      mkdirSync(current);
      const created = lstat_or_undefined(current);
      if (created === undefined || created.isSymbolicLink() || !created.isDirectory()) {
        throw unsafe("a storage folder could not be created safely");
      }
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw unsafe("a storage folder is not a real directory");
    }
  }
  const target = join(current, parts[parts.length - 1]!);
  const existing = lstat_or_undefined(target);
  if (existing !== undefined) {
    if (existing.isSymbolicLink()) throw unsafe("the storage target is a symbolic link");
    if (!existing.isFile()) throw unsafe("the storage target is not a regular file");
  }

  // A same-directory temporary file plus rename keeps a failed write from
  // leaving a partial blob behind. The temporary file is always removed.
  const temporary = join(current, `.upload-${globalThis.crypto.randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes, { flag: "wx" });
    renameSync(temporary, target);
  } finally {
    // A cleanup failure must not turn a successful rename into an error; a
    // leftover temp file is swept by a later gc like any other stray file.
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Best effort.
    }
  }
}

export function write_storage_bytes(
  objects_dir: string,
  project_id: string,
  storage_key: string,
  bytes: Uint8Array,
): void {
  try {
    write_storage_bytes_inner(objects_dir, project_id, storage_key, bytes);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // EACCES/ENOSPC/... must not reach a caller with a raw path-bearing message.
    throw new ApiError("conflict", "the object store is not writable");
  }
}

/** Read exactly the bytes of a storage_key, refusing missing files and every symlink. */
function read_storage_bytes_inner(
  objects_dir: string,
  project_id: string,
  storage_key: string,
): Uint8Array {
  const parts = storage_segments(storage_key, project_id);
  const root = resolve_objects_dir(objects_dir);
  const root_stat = lstat_or_undefined(root);
  if (root_stat === undefined) not_found("the objects folder is missing");
  if (root_stat.isSymbolicLink() || !root_stat.isDirectory()) {
    throw new ApiError("conflict", "the objects folder is not a real directory");
  }
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    const stat = lstat_or_undefined(current);
    if (stat === undefined) not_found("the stored file is missing");
    if (stat.isSymbolicLink()) {
      throw new ApiError("conflict", "the stored file is a symbolic link");
    }
    if (index === parts.length - 1) {
      if (!stat.isFile()) throw new ApiError("conflict", "the stored file is not a regular file");
    } else if (!stat.isDirectory()) {
      throw new ApiError("conflict", "the stored file path is not a directory");
    }
  }
  return new Uint8Array(readFileSync(current));
}

export function read_storage_bytes(
  objects_dir: string,
  project_id: string,
  storage_key: string,
): Uint8Array {
  try {
    return read_storage_bytes_inner(objects_dir, project_id, storage_key);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("conflict", "the stored file is not readable");
  }
}

/** True only for a regular file at a safe storage path (no symlink at any level). */
export function storage_file_is_regular(
  objects_dir: string,
  project_id: string,
  storage_key: string,
): boolean {
  try {
    const parts = storage_segments(storage_key, project_id);
    const root = resolve_objects_dir(objects_dir);
    const root_stat = lstatSync(root);
    if (root_stat.isSymbolicLink() || !root_stat.isDirectory()) return false;
    let current = root;
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index]!);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) return false;
      if (index === parts.length - 1) return stat.isFile();
      if (!stat.isDirectory()) return false;
    }
  } catch {
    return false;
  }
  return false;
}

/** Every regular file below this project's folder, without following symlinks. */
function scan_project_files_inner(objects_dir: string, project_id: string): ProjectFile[] {
  let root: string;
  try {
    root = resolve_objects_dir(objects_dir);
  } catch {
    return [];
  }
  const root_stat = lstat_or_undefined(root);
  if (root_stat === undefined || root_stat.isSymbolicLink() || !root_stat.isDirectory()) return [];
  const project_dir = join(root, project_id);
  const stat = lstat_or_undefined(project_dir);
  if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) return [];

  const files: ProjectFile[] = [];
  const walk = (directory: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      let entry_stat: ReturnType<typeof lstatSync>;
      try {
        entry_stat = lstatSync(full);
      } catch {
        continue;
      }
      if (entry_stat.isSymbolicLink()) continue;
      if (entry_stat.isDirectory()) walk(full, relative);
      else if (entry_stat.isFile()) {
        files.push({ key: `${project_id}/${relative}`, path: full, mtime_ms: entry_stat.mtimeMs });
      }
    }
  };
  walk(project_dir, "");
  files.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return files;
}

/**
 * Every regular file below this project's folder, without following symlinks.
 * Any file-system error (missing folder, EACCES, ...) yields no candidates, so
 * gc never reports or removes a file it could not inspect.
 */
export function scan_project_files(objects_dir: string, project_id: string): ProjectFile[] {
  try {
    return scan_project_files_inner(objects_dir, project_id);
  } catch {
    return [];
  }
}

/**
 * Remove one file returned by scan_project_files. The objects root, the
 * project folder and every intermediate directory are re-checked with lstat
 * so a symlink that appeared after the scan is never followed.
 */
export function delete_project_file(
  objects_dir: string,
  project_id: string,
  file: ProjectFile,
): void {
  if (!storage_file_is_regular(objects_dir, project_id, file.key)) return;
  try {
    const root = resolve_objects_dir(objects_dir);
    const target = join(root, ...file.key.split("/"));
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) return;
    rmSync(target, { force: true });
  } catch {
    // Best effort; the next gc reconciles the DB and the disk.
  }
}

/** Remove the file of a blob by its storage key, refusing every unsafe path. */
export function delete_storage_file(
  objects_dir: string,
  project_id: string,
  storage_key: string,
): void {
  try {
    const parts = storage_segments(storage_key, project_id);
    const root = resolve_objects_dir(objects_dir);
    const root_stat = lstatSync(root);
    if (root_stat.isSymbolicLink() || !root_stat.isDirectory()) return;
    let current = root;
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index]!);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) return;
      if (index === parts.length - 1) {
        if (!stat.isFile()) return;
        rmSync(current, { force: true });
        return;
      }
      if (!stat.isDirectory()) return;
    }
  } catch {
    // Best effort; the next gc reconciles the DB and the disk.
  }
}

/** True when any blobs row still names this storage_key (same synchronous check before unlink). */
function storage_key_is_claimed(db: Db, storage_key: string): boolean {
  return (
    db.get<{ ok: bigint }>("SELECT 1 AS ok FROM blobs WHERE storage_key = ?", storage_key) !==
    undefined
  );
}

function context_project(ctx: MutationContext): string {
  if (ctx.project_id === null) not_found("project not found");
  return require_safe_id(ctx.project_id, "project_id");
}

function complete_input(input: unknown): string {
  if (!is_record(input)) throw invalid("complete_upload needs a payload object");
  for (const key of Object.keys(input)) {
    if (key !== "blob_id") throw invalid(`unknown payload field: ${key}`);
  }
  if (!("blob_id" in input)) throw invalid("blob_id is required");
  return require_safe_id(input.blob_id, "blob_id");
}

function gc_input(input: unknown): number {
  if (!is_record(input)) throw invalid("gc_orphans needs a payload object");
  for (const key of Object.keys(input)) {
    if (key !== "grace_ms") throw invalid(`unknown payload field: ${key}`);
  }
  const grace_ms = input.grace_ms;
  if (typeof grace_ms !== "number" || !Number.isSafeInteger(grace_ms) || grace_ms < 1) {
    throw invalid("grace_ms must be a positive safe integer");
  }
  return grace_ms;
}

// ---------------------------------------------------------------------------
// public command wrappers

export function reserve_upload(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "file.reserve_upload", input);
}

/**
 * Run complete_upload on the service's canonical store. The command re-reads
 * and measures the stored bytes, so a caller cannot make a blob ready by
 * supplying its own hash or size or by pointing at another folder.
 */
export async function complete_upload(
  service: CommandService,
  store: FileStore,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  const blob_id = complete_input(input);
  require_service_store(service, store);
  return service.execute(ctx, "file.complete_upload", { blob_id });
}

export function attach_version(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "file.attach_version", input);
}

export function quarantine(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "file.quarantine", input);
}

/**
 * One gc transaction, then byte deletion outside it. Rows and bytes are
 * reconciled by the next gc if an unlink fails or a crash happens between the
 * commit and the disk work.
 */
export async function gc_orphans(
  service: CommandService,
  store: FileStore,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  const grace_ms = gc_input(input);
  const project_id = context_project(ctx);
  const objects_dir = require_service_store(service, store);

  const blob_keys = new Map<string, string>();
  for (const row of store.db.all<{ id: string; storage_key: string }>(
    "SELECT id, storage_key FROM blobs WHERE project_id = ?",
    project_id,
  )) {
    blob_keys.set(row.id, row.storage_key);
  }

  const outcome = await service.execute(ctx, "file.gc_orphans", { grace_ms });
  if (outcome.replayed) return outcome;

  const result = outcome.result as {
    deleted_blob_ids: string[];
    orphan_files_removed: number;
  };
  for (const blob_id of result.deleted_blob_ids) {
    const storage_key = blob_keys.get(blob_id);
    if (storage_key === undefined) continue;
    // The gc transaction is already committed. Another connection may have
    // created a new ready blob with the same (project, sha256) storage_key in
    // the meantime. Re-check the DB in the same synchronous segment as the
    // unlink and keep the file when a row now claims it.
    if (storage_key_is_claimed(store.db, storage_key)) continue;
    delete_storage_file(objects_dir, project_id, storage_key);
  }

  const receipt =
    ctx.actor_id === null
      ? undefined
      : store.db.get<{ created_at: bigint }>(
          `SELECT created_at FROM mutation_commits
            WHERE project_id = ? AND actor_id = ? AND client_request_id = ?`,
          project_id,
          ctx.actor_id,
          ctx.client_request_id,
        );
  if (receipt === undefined) return outcome;

  const now_ms = Number(receipt.created_at);
  const claimed = new Set<string>();
  for (const row of store.db.all<{ storage_key: string }>(
    "SELECT storage_key FROM blobs WHERE project_id = ?",
    project_id,
  )) {
    claimed.add(row.storage_key);
  }
  for (const file of scan_project_files(objects_dir, project_id)) {
    if (claimed.has(file.key)) continue;
    if (now_ms - file.mtime_ms <= grace_ms) continue;
    // Re-check every file right before the unlink: a row created after the
    // claimed-set read above makes this file live, not an orphan.
    if (storage_key_is_claimed(store.db, file.key)) continue;
    delete_project_file(objects_dir, project_id, file);
  }
  return outcome;
}

/** True only for a blob of this project; unknown ids and other projects' blobs are not_found. */
export function assert_project_access(db: Db, project_id: string, blob_id: string): void {
  const project = require_safe_id(project_id, "project_id");
  const id = require_safe_id(blob_id, "blob_id");
  const row = db.get<{ ok: bigint }>(
    "SELECT 1 AS ok FROM blobs WHERE project_id = ? AND id = ?",
    project,
    id,
  );
  if (row === undefined) not_found("blob not found");
}

/** Read a ready blob of this project and verify its bytes against the recorded sha256/size. */
export async function get_blob(
  store: FileStore,
  project_id: string,
  blob_id: string,
): Promise<StoredBlob> {
  const objects_dir = require_canonical_store(store);
  const project = require_safe_id(project_id, "project_id");
  const id = require_safe_id(blob_id, "blob_id");
  const row = store.db.get<BlobRow>(
    `SELECT id, project_id, storage_key, sha256, size, media_type, state
       FROM blobs WHERE project_id = ? AND id = ?`,
    project,
    id,
  );
  if (row === undefined) not_found("blob not found");
  if (row.state !== "ready") {
    throw new ApiError("conflict", "the blob is not ready");
  }
  const bytes = read_storage_bytes(objects_dir, project, row.storage_key);
  if (bytes.byteLength !== Number(row.size) || sha256_hex(bytes) !== row.sha256) {
    throw new ApiError("conflict", "the stored bytes do not match the blob");
  }
  return {
    blob_id: row.id,
    project_id: row.project_id,
    sha256: row.sha256,
    size: Number(row.size),
    media_type: row.media_type,
    bytes,
  };
}

/**
 * Write the bytes of a staging blob of this project to the path derived from
 * its database storage_key. The bytes must match the reservation (length and
 * sha256) before anything touches the disk; no database write happens here.
 */
export async function store_blob(
  store: FileStore,
  project_id: string,
  blob_id: string,
  bytes: Uint8Array,
): Promise<void> {
  const objects_dir = require_canonical_store(store);
  const project = require_safe_id(project_id, "project_id");
  const id = require_safe_id(blob_id, "blob_id");
  if (!(bytes instanceof Uint8Array)) throw invalid("bytes must be a Uint8Array");
  const row = store.db.get<{ storage_key: string; state: string; sha256: string; size: bigint }>(
    "SELECT storage_key, state, sha256, size FROM blobs WHERE project_id = ? AND id = ?",
    project,
    id,
  );
  if (row === undefined) not_found("blob not found");
  if (row.state !== "staging" && row.state !== "ready") {
    throw new ApiError("conflict", "only a staging blob takes bytes");
  }
  if (row.state === "ready" && storage_file_is_regular(objects_dir, project, row.storage_key)) {
    // A ready blob with its file present is immutable; only a missing file may
    // be recovered by writing the reserved bytes again.
    throw new ApiError("conflict", "only a staging blob takes bytes");
  }
  if (bytes.byteLength !== Number(row.size)) {
    throw invalid("the bytes do not match the reservation");
  }
  if (sha256_hex(bytes) !== row.sha256) {
    throw invalid("the bytes do not match the reservation");
  }
  write_storage_bytes(objects_dir, project, row.storage_key, bytes);
}

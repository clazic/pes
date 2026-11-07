// New-format project backup: export, verify, and import (stage 2 PR3).
//
// One project is exported as a directory bundle:
//
//   manifest.json        format version, source identity, file inventory, counts
//   rows/project.json    the project's rows (plus the users/actors they reference)
//   objects/<key>        opaque byte copies of the project's blobs
//
// Rules that matter here:
// - Rows are read inside ONE tx() so the bundle sees a consistent snapshot. The
//   database file itself is never copied, attached, vacuumed, or checkpointed.
// - Import verifies the whole bundle before writing anything, refuses when the
//   project id, a unique key, or a target object path collides, and then inserts
//   rows in one tx while raising db_meta.cursor_epoch.
// - Object bytes are opaque. Ready/orphan/quarantine judgement is PR9/PR12 work.
//
// Project membership is derived from the schema: every table with a project_id
// column belongs to the project, `projects` is its own row, and `users`/`actors`
// are included when the project rows reference them. A short hardcoded table
// list would silently miss tables added by later migrations.

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { tx, type Db, type SqlValue } from "./db.ts";

export const BACKUP_FORMAT_VERSION = 1;

const MANIFEST_FILE = "manifest.json";
const ROWS_FILE = "rows/project.json";

const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^\d+$/;
const INTEGER_VALUE = /^-?\d+$/;

export interface BundleFile {
  path: string;
  sha256: string;
  size: number;
}

export interface Manifest {
  format_version: 1;
  database_instance_id: string;
  cursor_epoch: string;
  project_id: string;
  files: BundleFile[];
  table_counts: Record<string, number>;
}

export type ProblemCode =
  | "manifest_missing"
  | "manifest_invalid"
  | "path_unsafe"
  | "file_missing"
  | "size_mismatch"
  | "hash_mismatch"
  | "extra_file"
  | "row_count_mismatch";

export interface BundleProblem {
  code: ProblemCode;
  path?: string;
  message: string;
}

export class BackupError extends Error {
  code: string;
  problems: BundleProblem[];

  constructor(code: string, message?: string, problems: BundleProblem[] = []) {
    super(message ?? code);
    this.name = "BackupError";
    this.code = code;
    this.problems = problems;
  }
}

interface ColumnInfo {
  name: string;
  type: string;
}

interface RowsTable {
  name: string;
  columns: ColumnInfo[];
  rows: unknown[][];
}

interface RowsDoc {
  format_version: number;
  project_id: string;
  tables: RowsTable[];
}

interface SnapshotTable {
  name: string;
  columns: ColumnInfo[];
  rows: Record<string, SqlValue>[];
}

interface ExportSnapshot {
  database_instance_id: string;
  cursor_epoch: bigint;
  tables: SnapshotTable[];
  table_counts: Record<string, number>;
  blob_storage_keys: string[];
}

export interface ExportResult {
  bundle_dir: string;
  manifest: Manifest;
}

export interface ImportResult {
  project_id: string;
  cursor_epoch: bigint;
}

export interface VerifyResult {
  ok: boolean;
  problems: BundleProblem[];
}

function sha256_hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function message_of(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bigint_replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Encode one SQLite value for the rows JSON. Integers become decimal strings
 * (restored from the declared column type), and BLOBs become a tagged base64
 * object so JSON.stringify cannot flatten them into `{"0":..}`.
 */
function encode_value(value: SqlValue | undefined): unknown {
  if (value instanceof Uint8Array) return { $blob: Buffer.from(value).toString("base64") };
  return value ?? null;
}

function escape_identifier(name: string): string {
  return name.replace(/"/g, '""');
}

/** True for a non-empty relative POSIX path with no `.`/`..` segments. */
function is_safe_bundle_path(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    return false;
  }
  if (/^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function list_data_tables(db: Db): string[] {
  return db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'db_meta' ORDER BY name",
    )
    .map((row) => row.name);
}

function table_columns(db: Db, table: string): ColumnInfo[] {
  return db
    .all<{ name: string; type: string | null }>(`PRAGMA table_info("${escape_identifier(table)}")`)
    .map((row) => ({ name: row.name, type: typeof row.type === "string" ? row.type : "" }));
}

function collect_referenced_ids(
  db: Db,
  table: string,
  rows: Record<string, SqlValue>[],
  parent_table: string,
  parent_column: string,
  out: Set<string>,
): void {
  if (rows.length === 0) return;
  const foreign_keys = db.all<{ table: string; from: string; to: string | null }>(
    `PRAGMA foreign_key_list("${escape_identifier(table)}")`,
  );
  const targets = foreign_keys.filter(
    (foreign_key) => foreign_key.table === parent_table && foreign_key.to === parent_column,
  );
  if (targets.length === 0) return;
  for (const row of rows) {
    for (const target of targets) {
      const value = row[target.from];
      if (typeof value === "string") out.add(value);
    }
  }
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

function assert_out_dir_usable(out_dir: string): void {
  if (!existsSync(out_dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(out_dir);
  } catch {
    throw new BackupError("out_dir_not_empty", `${out_dir} exists and is not a usable empty directory`);
  }
  if (entries.length > 0) {
    throw new BackupError("out_dir_not_empty", `${out_dir} exists and is not empty`);
  }
}

function read_snapshot(db: Db, project_id: string): ExportSnapshot {
  const meta = db.get<{ database_instance_id: string; cursor_epoch: bigint }>(
    "SELECT database_instance_id, cursor_epoch FROM db_meta WHERE id = 1",
  );
  if (meta === undefined) throw new Error("db_meta row with id = 1 is missing");

  const project = db.get<Record<string, SqlValue>>('SELECT * FROM "projects" WHERE id = ?', project_id);
  if (project === undefined) {
    throw new BackupError("project_not_found", `project ${project_id} does not exist`);
  }

  const by_table = new Map<string, { columns: ColumnInfo[]; rows: Record<string, SqlValue>[] }>();
  for (const name of list_data_tables(db)) {
    const columns = table_columns(db, name);
    if (name === "projects") {
      by_table.set(name, { columns, rows: [project] });
    } else if (columns.some((column) => column.name === "project_id")) {
      by_table.set(name, {
        columns,
        rows: db.all<Record<string, SqlValue>>(
          `SELECT * FROM "${escape_identifier(name)}" WHERE project_id = ? ORDER BY rowid`,
          project_id,
        ),
      });
    }
  }

  // The project references users and actors through many tables. Follow the
  // declared foreign keys to gather them, then include every actor of an
  // included user (and any user those actors point back to).
  const user_ids = new Set<string>();
  const actor_ids = new Set<string>();
  const owner = project.owner_user_id;
  if (typeof owner === "string") user_ids.add(owner);
  for (const [name, table] of by_table) {
    collect_referenced_ids(db, name, table.rows, "users", "id", user_ids);
    collect_referenced_ids(db, name, table.rows, "actors", "id", actor_ids);
  }

  const all_actors = db.all<Record<string, SqlValue>>('SELECT * FROM "actors" ORDER BY rowid');
  let actor_rows: Record<string, SqlValue>[] = [];
  for (let changed = true; changed; ) {
    changed = false;
    actor_rows = all_actors.filter(
      (row) =>
        (typeof row.id === "string" && actor_ids.has(row.id)) ||
        (typeof row.user_id === "string" && user_ids.has(row.user_id)),
    );
    for (const row of actor_rows) {
      if (typeof row.user_id === "string" && !user_ids.has(row.user_id)) {
        user_ids.add(row.user_id);
        changed = true;
      }
    }
  }
  const user_rows = db
    .all<Record<string, SqlValue>>('SELECT * FROM "users" ORDER BY rowid')
    .filter((row) => typeof row.id === "string" && user_ids.has(row.id));

  by_table.set("actors", { columns: table_columns(db, "actors"), rows: actor_rows });
  by_table.set("users", { columns: table_columns(db, "users"), rows: user_rows });

  const tables: SnapshotTable[] = [...by_table.keys()]
    .sort()
    .map((name) => ({ name, ...by_table.get(name)! }));

  const table_counts: Record<string, number> = {};
  for (const table of tables) {
    if (table.rows.length > 0) table_counts[table.name] = table.rows.length;
  }

  const blob_storage_keys: string[] = [];
  for (const row of by_table.get("blobs")?.rows ?? []) {
    const storage_key = row.storage_key;
    if (typeof storage_key !== "string" || !is_safe_bundle_path(storage_key)) {
      throw new BackupError(
        "object_path_unsafe",
        `blobs.storage_key is not a safe relative path: ${String(storage_key)}`,
      );
    }
    blob_storage_keys.push(storage_key);
  }

  return {
    database_instance_id: meta.database_instance_id,
    cursor_epoch: meta.cursor_epoch,
    tables,
    table_counts,
    blob_storage_keys,
  };
}

function write_bundle_file(root: string, relative_path: string, bytes: Uint8Array): void {
  const target = join(root, ...relative_path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

function cleanup_bundle(out_dir: string, existed: boolean, relative_paths: string[]): void {
  if (!existed) {
    rmSync(out_dir, { recursive: true, force: true });
    return;
  }
  for (const relative_path of relative_paths) {
    try {
      rmSync(join(out_dir, ...relative_path.split("/")), { force: true });
    } catch {
      // Best effort: the original out_dir was empty by contract.
    }
  }
}

/**
 * Export one project (rows + referenced users/actors + every blobs file) into a
 * new bundle directory. The bundle itself never contains a copied SQLite file.
 */
export function export_project(
  db: Db,
  objects_dir: string,
  project_id: string,
  out_dir: string,
): ExportResult {
  assert_out_dir_usable(out_dir);

  const snapshot = tx(db, () => read_snapshot(db, project_id));

  const doc: RowsDoc = {
    format_version: BACKUP_FORMAT_VERSION,
    project_id,
    tables: snapshot.tables.map((table) => ({
      name: table.name,
      columns: table.columns.map((column) => ({ name: column.name, type: column.type })),
      rows: table.rows.map((row) => table.columns.map((column) => encode_value(row[column.name]))),
    })),
  };
  const payloads: Array<{ path: string; bytes: Uint8Array }> = [
    { path: ROWS_FILE, bytes: new TextEncoder().encode(`${JSON.stringify(doc, bigint_replacer, 2)}\n`) },
  ];

  for (const storage_key of snapshot.blob_storage_keys) {
    const source = join(objects_dir, ...storage_key.split("/"));
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(source);
    } catch (error) {
      throw new BackupError("object_missing", `blob file is missing: ${storage_key} (${message_of(error)})`);
    }
    payloads.push({ path: `objects/${storage_key}`, bytes });
  }

  const manifest: Manifest = {
    format_version: BACKUP_FORMAT_VERSION,
    database_instance_id: snapshot.database_instance_id,
    cursor_epoch: snapshot.cursor_epoch.toString(),
    project_id,
    files: payloads.map((payload) => ({
      path: payload.path,
      sha256: sha256_hex(payload.bytes),
      size: payload.bytes.byteLength,
    })),
    table_counts: snapshot.table_counts,
  };

  const existed = existsSync(out_dir);
  mkdirSync(out_dir, { recursive: true });
  try {
    for (const payload of payloads) write_bundle_file(out_dir, payload.path, payload.bytes);
    write_bundle_file(
      out_dir,
      MANIFEST_FILE,
      new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
    );
  } catch (error) {
    cleanup_bundle(out_dir, existed, [...payloads.map((payload) => payload.path), MANIFEST_FILE]);
    throw error;
  }

  return { bundle_dir: out_dir, manifest };
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

function manifest_shape_errors(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return ["manifest.json must be a JSON object"];
  }
  const manifest = value as Record<string, unknown>;
  const errors: string[] = [];

  if (manifest.format_version !== BACKUP_FORMAT_VERSION) {
    errors.push(`format_version must be ${BACKUP_FORMAT_VERSION}`);
  }
  if (typeof manifest.database_instance_id !== "string" || manifest.database_instance_id.length === 0) {
    errors.push("database_instance_id must be a non-empty string");
  }
  if (typeof manifest.cursor_epoch !== "string" || !DECIMAL.test(manifest.cursor_epoch)) {
    errors.push("cursor_epoch must be a decimal string");
  }
  if (typeof manifest.project_id !== "string" || manifest.project_id.length === 0) {
    errors.push("project_id must be a non-empty string");
  }

  if (!Array.isArray(manifest.files)) {
    errors.push("files must be an array");
  } else {
    const paths = new Set<string>();
    for (const [index, raw] of manifest.files.entries()) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        errors.push(`files[${index}] must be an object`);
        continue;
      }
      const file = raw as Record<string, unknown>;
      if (typeof file.path !== "string" || file.path.length === 0) {
        errors.push(`files[${index}].path must be a non-empty string`);
      } else if (paths.has(file.path)) {
        errors.push(`files[${index}].path is duplicated: ${file.path}`);
      } else {
        paths.add(file.path);
      }
      if (typeof file.sha256 !== "string" || !HEX64.test(file.sha256)) {
        errors.push(`files[${index}].sha256 must be 64 lowercase hex characters`);
      }
      if (typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0) {
        errors.push(`files[${index}].size must be a non-negative integer`);
      }
    }
  }

  if (manifest.table_counts === null || typeof manifest.table_counts !== "object" || Array.isArray(manifest.table_counts)) {
    errors.push("table_counts must be an object");
  } else {
    for (const [table, count] of Object.entries(manifest.table_counts as Record<string, unknown>)) {
      if (table.length === 0 || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
        errors.push(`table_counts.${table} must be a non-negative integer`);
      }
    }
  }

  return errors;
}

function walk_files(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
      else files.push(relative);
    }
  };
  walk(root, "");
  files.sort();
  return files;
}

function parse_rows_doc(text: string): RowsDoc {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("rows file must be a JSON object");
  }
  const doc = value as Record<string, unknown>;
  if (doc.format_version !== BACKUP_FORMAT_VERSION) {
    throw new Error(`rows format_version must be ${BACKUP_FORMAT_VERSION}`);
  }
  if (typeof doc.project_id !== "string" || doc.project_id.length === 0) {
    throw new Error("rows project_id must be a non-empty string");
  }
  if (!Array.isArray(doc.tables)) throw new Error("rows tables must be an array");

  const seen = new Set<string>();
  const tables: RowsTable[] = doc.tables.map((raw_table, table_index) => {
    if (raw_table === null || typeof raw_table !== "object" || Array.isArray(raw_table)) {
      throw new Error(`rows tables[${table_index}] must be an object`);
    }
    const table = raw_table as Record<string, unknown>;
    if (typeof table.name !== "string" || table.name.length === 0) {
      throw new Error(`rows tables[${table_index}].name must be a non-empty string`);
    }
    if (seen.has(table.name)) throw new Error(`rows table ${table.name} is duplicated`);
    seen.add(table.name);
    if (!Array.isArray(table.columns)) {
      throw new Error(`rows table ${table.name} must have a columns array`);
    }
    const columns: ColumnInfo[] = table.columns.map((raw_column, column_index) => {
      if (raw_column === null || typeof raw_column !== "object" || Array.isArray(raw_column)) {
        throw new Error(`rows table ${table.name} columns[${column_index}] must be an object`);
      }
      const column = raw_column as Record<string, unknown>;
      if (
        typeof column.name !== "string" ||
        column.name.length === 0 ||
        typeof column.type !== "string"
      ) {
        throw new Error(`rows table ${table.name} columns[${column_index}] is invalid`);
      }
      return { name: column.name, type: column.type };
    });
    if (!Array.isArray(table.rows)) {
      throw new Error(`rows table ${table.name} must have a rows array`);
    }
    const rows: unknown[][] = table.rows.map((raw_row, row_index) => {
      if (!Array.isArray(raw_row) || raw_row.length !== columns.length) {
        throw new Error(`rows table ${table.name} row ${row_index} does not match its columns`);
      }
      return raw_row;
    });
    return { name: table.name, columns, rows };
  });

  return { format_version: BACKUP_FORMAT_VERSION, project_id: doc.project_id, tables };
}

/**
 * Verify a bundle without side effects. Reports every problem it can find
 * (never stops at the first one) and never throws for a bad bundle.
 */
export function verify_bundle(bundle_dir: string): VerifyResult {
  const manifest_path = join(bundle_dir, MANIFEST_FILE);
  let manifest_text: string;
  try {
    manifest_text = readFileSync(manifest_path, "utf8");
  } catch {
    return {
      ok: false,
      problems: [
        { code: "manifest_missing", path: MANIFEST_FILE, message: "manifest.json is missing or unreadable" },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest_text);
  } catch (error) {
    return {
      ok: false,
      problems: [
        {
          code: "manifest_invalid",
          path: MANIFEST_FILE,
          message: `manifest.json is not valid JSON: ${message_of(error)}`,
        },
      ],
    };
  }

  const shape_errors = manifest_shape_errors(parsed);
  if (shape_errors.length > 0) {
    return {
      ok: false,
      problems: [
        { code: "manifest_invalid", path: MANIFEST_FILE, message: shape_errors.join("; ") },
      ],
    };
  }
  const manifest = parsed as unknown as Manifest;

  const problems: BundleProblem[] = [];
  for (const file of manifest.files) {
    if (!is_safe_bundle_path(file.path)) {
      problems.push({
        code: "path_unsafe",
        path: file.path,
        message: `manifest path is not a safe relative path: ${file.path}`,
      });
      continue;
    }
    const full_path = join(bundle_dir, ...file.path.split("/"));
    let size: number;
    try {
      // lstat: a symlink is not a regular bundle file even if it resolves to
      // matching bytes outside the bundle.
      const stat = lstatSync(full_path);
      if (stat.isSymbolicLink()) {
        problems.push({
          code: "path_unsafe",
          path: file.path,
          message: `manifest file is a symbolic link, not a regular file: ${file.path}`,
        });
        continue;
      }
      if (!stat.isFile()) {
        problems.push({
          code: "file_missing",
          path: file.path,
          message: `manifest file is not a regular file: ${file.path}`,
        });
        continue;
      }
      size = stat.size;
    } catch {
      problems.push({
        code: "file_missing",
        path: file.path,
        message: `file listed in the manifest is missing: ${file.path}`,
      });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(full_path);
    } catch {
      problems.push({
        code: "file_missing",
        path: file.path,
        message: `file listed in the manifest is unreadable: ${file.path}`,
      });
      continue;
    }
    if (size !== file.size) {
      problems.push({
        code: "size_mismatch",
        path: file.path,
        message: `size mismatch for ${file.path}: manifest says ${file.size}, file is ${size}`,
      });
    }
    if (sha256_hex(bytes) !== file.sha256) {
      problems.push({
        code: "hash_mismatch",
        path: file.path,
        message: `sha256 mismatch for ${file.path}`,
      });
    }
  }

  const listed_paths = new Set(manifest.files.map((file) => file.path));
  for (const relative_path of walk_files(bundle_dir)) {
    if (relative_path === MANIFEST_FILE) continue;
    if (!listed_paths.has(relative_path)) {
      problems.push({
        code: "extra_file",
        path: relative_path,
        message: `file is not listed in manifest.json: ${relative_path}`,
      });
    }
  }

  const rows_entries = manifest.files.filter((file) => file.path.startsWith("rows/"));
  if (rows_entries.length === 0) {
    if (Object.keys(manifest.table_counts).length > 0) {
      problems.push({
        code: "row_count_mismatch",
        message: "bundle has no rows/ file to compare with table_counts",
      });
    }
  } else {
    const counts = new Map<string, number>();
    const count_paths = new Map<string, string>();
    let row_files_valid = true;
    for (const entry of rows_entries) {
      let doc: RowsDoc;
      try {
        doc = parse_rows_doc(readFileSync(join(bundle_dir, ...entry.path.split("/")), "utf8"));
      } catch (error) {
        row_files_valid = false;
        problems.push({
          code: "row_count_mismatch",
          path: entry.path,
          message: `rows file is invalid: ${message_of(error)}`,
        });
        continue;
      }
      for (const table of doc.tables) {
        counts.set(table.name, (counts.get(table.name) ?? 0) + table.rows.length);
        if (!count_paths.has(table.name)) count_paths.set(table.name, entry.path);
      }
    }
    if (row_files_valid) {
      for (const [table, count] of counts) {
        const expected = manifest.table_counts[table] ?? 0;
        if (count !== expected) {
          problems.push({
            code: "row_count_mismatch",
            path: count_paths.get(table) ?? rows_entries[0]!.path,
            message: `table ${table}: rows file has ${count} rows, manifest says ${expected}`,
          });
        }
      }
      for (const [table, expected] of Object.entries(manifest.table_counts)) {
        if (!counts.has(table) && expected !== 0) {
          problems.push({
            code: "row_count_mismatch",
            path: rows_entries[0]!.path,
            message: `table ${table}: manifest says ${expected} rows but the rows file has none`,
          });
        }
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

function read_manifest(bundle_dir: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(bundle_dir, MANIFEST_FILE), "utf8"));
  } catch (error) {
    throw new BackupError("bundle_invalid", `manifest.json is unreadable: ${message_of(error)}`, [
      { code: "manifest_invalid", path: MANIFEST_FILE, message: message_of(error) },
    ]);
  }
  const errors = manifest_shape_errors(parsed);
  if (errors.length > 0) {
    throw new BackupError("bundle_invalid", errors.join("; "), [
      { code: "manifest_invalid", path: MANIFEST_FILE, message: errors.join("; ") },
    ]);
  }
  return parsed as unknown as Manifest;
}

function read_bundle_rows(bundle_dir: string, manifest: Manifest): RowsTable[] {
  const entries = manifest.files.filter((file) => file.path.startsWith("rows/"));
  if (entries.length === 0) {
    throw new BackupError("bundle_invalid", "bundle has no rows/ file", [
      { code: "row_count_mismatch", message: "bundle has no rows/ file" },
    ]);
  }
  const by_name = new Map<string, RowsTable>();
  for (const entry of entries) {
    let doc: RowsDoc;
    try {
      doc = parse_rows_doc(readFileSync(join(bundle_dir, ...entry.path.split("/")), "utf8"));
    } catch (error) {
      throw new BackupError("bundle_invalid", message_of(error), [
        { code: "row_count_mismatch", path: entry.path, message: message_of(error) },
      ]);
    }
    if (doc.project_id !== manifest.project_id) {
      throw new BackupError("bundle_invalid", "rows project_id does not match the manifest", [
        {
          code: "manifest_invalid",
          path: entry.path,
          message: "rows project_id does not match manifest.project_id",
        },
      ]);
    }
    for (const table of doc.tables) {
      if (by_name.has(table.name)) {
        throw new BackupError("bundle_invalid", `rows table ${table.name} is duplicated`, [
          { code: "row_count_mismatch", path: entry.path, message: `rows table ${table.name} is duplicated` },
        ]);
      }
      by_name.set(table.name, table);
    }
  }
  return [...by_name.values()];
}

function invalid_row(message: string): BackupError {
  return new BackupError("bundle_invalid", message, [{ code: "row_count_mismatch", message }]);
}

function decode_value(value: unknown, type: string): SqlValue {
  if (value === null) return null;
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) throw invalid_row("found an array where a column value was expected");
    const tagged = value as Record<string, unknown>;
    if (typeof tagged.$blob === "string") {
      if (!BASE64.test(tagged.$blob)) throw invalid_row("blob value is not valid base64");
      return Uint8Array.from(Buffer.from(tagged.$blob, "base64"));
    }
    throw invalid_row("unsupported object value in the rows file");
  }
  const integer_column = type.toUpperCase().includes("INT");
  if (typeof value === "string") {
    if (!integer_column) return value;
    if (!INTEGER_VALUE.test(value)) throw invalid_row(`expected an integer but found ${JSON.stringify(value)}`);
    return BigInt(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid_row(`found a non-finite number`);
    if (!integer_column) return value;
    if (!Number.isInteger(value)) throw invalid_row(`expected an integer but found ${String(value)}`);
    return BigInt(value);
  }
  throw invalid_row(`unsupported value in the rows file: ${String(value)}`);
}

function value_matches(left: SqlValue | undefined, right: SqlValue | undefined): boolean {
  const a = left ?? null;
  const b = right ?? null;
  if (a === null || b === null) return a === b;
  if (typeof a === "bigint" || typeof b === "bigint") {
    try {
      return BigInt(String(a)) === BigInt(String(b));
    } catch {
      return false;
    }
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
    return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
  }
  return a === b;
}

function row_matches(
  existing: Record<string, SqlValue>,
  values: SqlValue[],
  columns: string[],
): boolean {
  return columns.every((name, index) => value_matches(existing[name], values[index]));
}

function insert_rows(db: Db, table: RowsTable): void {
  const names = table.columns.map((column) => column.name);
  const quoted_names = names.map((name) => `"${escape_identifier(name)}"`).join(", ");
  const placeholders = names.map(() => "?").join(", ");
  const sql = `INSERT INTO "${escape_identifier(table.name)}" (${quoted_names}) VALUES (${placeholders})`;
  const id_index = names.indexOf("id");
  const skippable = (table.name === "users" || table.name === "actors") && id_index >= 0;

  for (const raw of table.rows) {
    const values = table.columns.map((column, index) => decode_value(raw[index], column.type));
    if (skippable) {
      const existing = db.get<Record<string, SqlValue>>(
        `SELECT * FROM "${escape_identifier(table.name)}" WHERE id = ?`,
        values[id_index]!,
      );
      if (existing !== undefined) {
        if (row_matches(existing, values, names)) continue;
        throw new BackupError("project_conflict", `${table.name} id ${String(values[id_index])} already exists with different values`);
      }
    }
    db.run(sql, ...values);
  }
}

function require_project_row(tables: RowsTable[], project_id: string): Map<string, SqlValue> {
  const table = tables.find((candidate) => candidate.name === "projects");
  if (table === undefined || table.rows.length !== 1) {
    throw invalid_row("bundle must contain exactly one projects row");
  }
  const values = new Map<string, SqlValue>();
  table.columns.forEach((column, index) => {
    values.set(column.name, decode_value(table.rows[0]![index], column.type));
  });
  if (values.get("id") !== project_id) {
    throw invalid_row("projects.id does not match manifest.project_id");
  }
  return values;
}

interface PendingObjectFile {
  target: string;
  bytes: Uint8Array;
}

function lstat_or_undefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function manifest_object_keys(manifest: Manifest): Set<string> {
  const keys = new Set<string>();
  for (const file of manifest.files) {
    if (file.path.startsWith("objects/")) keys.add(file.path.slice("objects/".length));
  }
  return keys;
}

/**
 * Re-check the blobs rows themselves. The manifest inventory only proves that
 * the listed files are self-consistent; a rewritten rows file could still point
 * a storage_key outside the objects folder or disagree with that inventory.
 */
function validate_bundle_blob_rows(tables: RowsTable[], manifest: Manifest): void {
  const blobs = tables.find((table) => table.name === "blobs");
  const row_keys = new Set<string>();
  if (blobs !== undefined) {
    const index = blobs.columns.findIndex((column) => column.name === "storage_key");
    if (index < 0) throw invalid_row("blobs table has no storage_key column");
    for (const row of blobs.rows) {
      const key = row[index];
      if (typeof key !== "string" || !is_safe_bundle_path(key)) {
        throw new BackupError(
          "bundle_invalid",
          `blobs.storage_key is not a safe relative path: ${String(key)}`,
          [{ code: "path_unsafe", message: `blobs.storage_key is not a safe relative path: ${String(key)}` }],
        );
      }
      if (row_keys.has(key)) throw invalid_row(`duplicate blobs.storage_key: ${key}`);
      row_keys.add(key);
    }
  }

  const object_keys = manifest_object_keys(manifest);
  for (const key of row_keys) {
    if (!object_keys.has(key)) {
      throw new BackupError("bundle_invalid", `blobs row has no object file: ${key}`, [
        { code: "file_missing", path: `objects/${key}`, message: `blobs row has no object file: ${key}` },
      ]);
    }
  }
  for (const key of object_keys) {
    if (!row_keys.has(key)) {
      throw new BackupError("bundle_invalid", `object file has no blobs row: ${key}`, [
        { code: "extra_file", path: `objects/${key}`, message: `object file has no blobs row: ${key}` },
      ]);
    }
  }
}

/**
 * Refuse to write through a symlinked directory between objects_dir and the
 * target file. Components that do not exist yet are safe: they are created by
 * this import and tracked for rollback.
 */
function assert_safe_target_ancestors(objects_dir: string, target: string): void {
  const root = resolve(objects_dir);
  const root_stat = lstat_or_undefined(root);
  let root_real = root;
  if (root_stat !== undefined) {
    if (!root_stat.isSymbolicLink() && !root_stat.isDirectory()) {
      throw new BackupError("object_conflict", `objects folder is not a directory: ${objects_dir}`);
    }
    root_real = realpathSync(root);
  }

  const parent = resolve(dirname(target));
  const rel = relative(root, parent);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new BackupError("object_path_unsafe", `object path escapes the objects folder: ${target}`);
  }
  const segments = rel === "" ? [] : rel.split(sep);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const stat = lstat_or_undefined(current);
    if (stat === undefined) break;
    if (stat.isSymbolicLink()) {
      throw new BackupError("object_path_unsafe", `object path crosses a symbolic link: ${current}`);
    }
    if (!stat.isDirectory()) {
      throw new BackupError("object_conflict", `object path parent is not a directory: ${current}`);
    }
    const real = realpathSync(current);
    if (real !== root_real && !real.startsWith(root_real + sep)) {
      throw new BackupError("object_path_unsafe", `object path escapes the objects folder: ${current}`);
    }
  }
}

/** Create missing directories below objects_dir and remember them for rollback. */
function ensure_directory_under(objects_dir: string, directory: string, created: string[]): void {
  const root = resolve(objects_dir);
  const target = resolve(directory);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new BackupError("object_path_unsafe", `object path escapes the objects folder: ${directory}`);
  }
  const segments = rel === "" ? [] : rel.split(sep);
  let current = root;
  const paths = [root];
  for (const segment of segments) {
    current = join(current, segment);
    paths.push(current);
  }

  for (const path of paths) {
    const stat = lstat_or_undefined(path);
    if (stat !== undefined) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new BackupError("object_path_unsafe", `object path parent is not a real directory: ${path}`);
      }
      continue;
    }
    if (path === root) mkdirSync(path, { recursive: true });
    else mkdirSync(path);
    created.push(path);
  }
}

function preflight_object_files(
  bundle_dir: string,
  objects_dir: string,
  manifest: Manifest,
): PendingObjectFile[] {
  const pending: PendingObjectFile[] = [];
  for (const file of manifest.files) {
    if (!file.path.startsWith("objects/")) continue;
    const storage_key = file.path.slice("objects/".length);
    if (!is_safe_bundle_path(storage_key)) {
      throw new BackupError("bundle_invalid", `unsafe object path: ${file.path}`, [
        { code: "path_unsafe", path: file.path, message: `unsafe object path: ${file.path}` },
      ]);
    }
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(join(bundle_dir, ...file.path.split("/")));
    } catch {
      throw new BackupError("bundle_invalid", `object file is missing: ${file.path}`, [
        { code: "file_missing", path: file.path, message: `object file is missing: ${file.path}` },
      ]);
    }
    if (sha256_hex(bytes) !== file.sha256) {
      throw new BackupError("bundle_invalid", `object hash changed: ${file.path}`, [
        { code: "hash_mismatch", path: file.path, message: `object hash changed: ${file.path}` },
      ]);
    }

    const target = join(objects_dir, ...storage_key.split("/"));
    assert_safe_target_ancestors(objects_dir, target);
    const existing_stat = lstat_or_undefined(target);
    if (existing_stat !== undefined) {
      if (existing_stat.isSymbolicLink()) {
        throw new BackupError("object_path_unsafe", `target object path is a symbolic link: ${storage_key}`);
      }
      if (!existing_stat.isFile()) {
        throw new BackupError("object_conflict", `target object path is not a regular file: ${storage_key}`);
      }
      let existing: Uint8Array;
      try {
        existing = readFileSync(target);
      } catch {
        throw new BackupError("object_conflict", `target object path is not a readable file: ${storage_key}`);
      }
      if (Buffer.compare(Buffer.from(existing), Buffer.from(bytes)) !== 0) {
        throw new BackupError("object_conflict", `target already has different bytes for ${storage_key}`);
      }
      continue;
    }
    pending.push({ target, bytes });
  }
  return pending;
}

function insert_bundle(db: Db, tables: RowsTable[], manifest: Manifest): bigint {
  // Rows contain cycles (projects <-> project_members/editions, editions <->
  // stages), so per-statement foreign key checks cannot work with any single
  // insertion order. Deferring enforcement until COMMIT keeps the whole restore
  // atomic; the pragma resets with the transaction.
  db.exec("PRAGMA defer_foreign_keys = ON");

  const existing_tables = new Set(
    db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => row.name),
  );
  for (const table of tables) {
    if (table.name === "db_meta" || !existing_tables.has(table.name)) {
      throw invalid_row(`target schema has no table ${table.name}`);
    }
    const target_columns = new Set(table_columns(db, table.name).map((column) => column.name));
    for (const column of table.columns) {
      if (!target_columns.has(column.name)) {
        throw invalid_row(`target table ${table.name} has no column ${column.name}`);
      }
    }
    insert_rows(db, table);
  }

  const meta = db.get<{ cursor_epoch: bigint }>("SELECT cursor_epoch FROM db_meta WHERE id = 1");
  if (meta === undefined) throw new Error("target db_meta row with id = 1 is missing");
  const manifest_epoch = BigInt(manifest.cursor_epoch);
  const next_epoch = (meta.cursor_epoch > manifest_epoch ? meta.cursor_epoch : manifest_epoch) + 1n;
  const updated = db.run("UPDATE db_meta SET cursor_epoch = ? WHERE id = 1", next_epoch);
  if (updated.changes !== 1n) throw new Error("failed to raise the target cursor_epoch");
  return next_epoch;
}

function translate_import_error(error: unknown): unknown {
  if (error instanceof BackupError) return error;
  const message = message_of(error);
  if (/constraint failed/i.test(message)) {
    if (/UNIQUE|PRIMARY KEY/i.test(message)) return new BackupError("project_conflict", message);
    return invalid_row(`a row was rejected by the target schema: ${message}`);
  }
  return error;
}

/**
 * Verify a bundle, refuse conflicts without writing, then restore the project
 * rows and files. The target database identity is kept; its cursor_epoch
 * becomes max(target epoch, manifest epoch) + 1.
 */
export function import_bundle(db: Db, objects_dir: string, bundle_dir: string): ImportResult {
  const report = verify_bundle(bundle_dir);
  if (!report.ok) {
    throw new BackupError("bundle_invalid", "bundle failed verification", report.problems);
  }

  const manifest = read_manifest(bundle_dir);
  const tables = read_bundle_rows(bundle_dir, manifest);
  const project = require_project_row(tables, manifest.project_id);
  validate_bundle_blob_rows(tables, manifest);

  if (db.get("SELECT 1 AS present FROM projects WHERE id = ?", manifest.project_id) !== undefined) {
    throw new BackupError("project_exists", `project ${manifest.project_id} already exists in the target database`);
  }
  const slug = project.get("slug");
  if (typeof slug === "string" && db.get("SELECT id FROM projects WHERE slug = ?", slug) !== undefined) {
    throw new BackupError("project_conflict", `slug ${slug} is already used by another project`);
  }

  const pending = preflight_object_files(bundle_dir, objects_dir, manifest);
  const created_files: string[] = [];
  const created_dirs: string[] = [];
  try {
    for (const file of pending) {
      ensure_directory_under(objects_dir, dirname(file.target), created_dirs);
      writeFileSync(file.target, file.bytes, { flag: "wx" });
      created_files.push(file.target);
    }
    const cursor_epoch = tx(db, () => insert_bundle(db, tables, manifest));
    return { project_id: manifest.project_id, cursor_epoch };
  } catch (error) {
    for (const path of created_files.reverse()) {
      try {
        rmSync(path, { force: true });
      } catch {
        // Best effort: the rows transaction rolls back independently.
      }
    }
    for (const path of created_dirs.reverse()) {
      try {
        rmdirSync(path);
      } catch {
        // Keep a non-empty directory; it existed before or holds other work.
      }
    }
    throw translate_import_error(error);
  }
}

// ---------------------------------------------------------------------------
// cursor epoch
// ---------------------------------------------------------------------------

/**
 * Minimal cursor check: accept only the target database's current epoch.
 * Non-decimal input is invalid; any other value is stale.
 */
export function assert_cursor_epoch(db: Db, epoch: bigint | string): void {
  let requested: bigint;
  if (typeof epoch === "bigint") {
    requested = epoch;
  } else if (typeof epoch === "string" && DECIMAL.test(epoch)) {
    requested = BigInt(epoch);
  } else {
    throw new BackupError("cursor_epoch_invalid", `cursor epoch must be a decimal integer: ${String(epoch)}`);
  }

  const meta = db.get<{ cursor_epoch: bigint }>("SELECT cursor_epoch FROM db_meta WHERE id = 1");
  if (meta === undefined) throw new Error("db_meta row with id = 1 is missing");
  if (meta.cursor_epoch !== requested) {
    throw new BackupError(
      "cursor_epoch_stale",
      `cursor epoch ${requested.toString()} does not match the current epoch ${meta.cursor_epoch.toString()}`,
    );
  }
}

// SQLite connection, transaction, and migration helpers.
//
// Design rules for stage 2 PR1:
// - node:sqlite only; no driver dependency.
// - Every INTEGER is read as bigint so 2^53+1 survives a round trip.
// - Foreign keys are enabled and verified before any work.
// - File databases use WAL; the parent directory is created but no other file
//   is touched.
// - SQLite version and JSON function support are checked at connect time.

import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { new_id } from "./ids.ts";

// Minimum rationale (docs/plan/stage-2-db-guarantees.md):
// JSON functions are part of the default SQLite build from 3.38.0, and the
// DDL relies on json_valid/json_type. Partial UNIQUE indexes need only 3.8.0.
// Node 26 bundles SQLite 3.54.x, so the floor is well below the supported runtime.
export const SQLITE_MIN_VERSION = "3.38.0";
export const BUSY_TIMEOUT_MS = 5000;

// The initial switch to WAL does not consult busy_timeout in SQLite: another
// connection holding a lock makes `PRAGMA journal_mode = WAL` return
// SQLITE_BUSY immediately. Retry that specific failure with a short backoff.
const WAL_RETRY_INITIAL_MS = 10;
const WAL_RETRY_MAX_MS = 100;
const SQLITE_BUSY = 5;

export type SqlValue = null | number | bigint | string | Uint8Array;

export interface RunResult {
  changes: bigint;
  last_insert_rowid: bigint;
}

export interface Db {
  readonly path: string;
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  run(sql: string, ...params: SqlValue[]): RunResult;
  get<T = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): T[];
  close(): void;
}

export class SqliteDb implements Db {
  readonly path: string;
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    this.#db = new DatabaseSync(path);
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  prepare(sql: string): StatementSync {
    const statement = this.#db.prepare(sql);
    statement.setReadBigInts(true);
    return statement;
  }

  run(sql: string, ...params: SqlValue[]): RunResult {
    const result = this.prepare(sql).run(...params);
    return {
      changes: BigInt(result.changes),
      last_insert_rowid: BigInt(result.lastInsertRowid),
    };
  }

  get<T = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): T[] {
    return this.prepare(sql).all(...params) as T[];
  }

  close(): void {
    this.#db.close();
  }
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/** Pure version comparison used by connect() and by tests with synthetic versions. */
export function sqlite_version_at_least(version: string, minimum: string = SQLITE_MIN_VERSION): boolean {
  const actual = VERSION_PATTERN.exec(version.trim());
  const floor = VERSION_PATTERN.exec(minimum.trim());
  if (actual === null || floor === null) return false;
  const actual_parts = [BigInt(actual[1]), BigInt(actual[2]), BigInt(actual[3])];
  const floor_parts = [BigInt(floor[1]), BigInt(floor[2]), BigInt(floor[3])];
  for (let index = 0; index < 3; index += 1) {
    if (actual_parts[index] > floor_parts[index]) return true;
    if (actual_parts[index] < floor_parts[index]) return false;
  }
  return true;
}

function is_memory_path(path: string): boolean {
  return path === ":memory:" || path === "file::memory:" || /[?&]mode=memory(&|$)/.test(path);
}

function assert_foreign_keys(db: Db): void {
  db.exec("PRAGMA foreign_keys = ON");
  const row = db.get<{ foreign_keys: bigint }>("PRAGMA foreign_keys");
  if (row === undefined || Number(row.foreign_keys) !== 1) {
    throw new Error("failed to enable SQLite foreign key enforcement");
  }
}

function assert_busy_timeout(db: Db): void {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  const row = db.get<{ timeout: bigint }>("PRAGMA busy_timeout");
  if (row === undefined || Number(row.timeout) !== BUSY_TIMEOUT_MS) {
    throw new Error("failed to set the SQLite busy timeout");
  }
}

function assert_wal(db: Db, path: string, busy_timeout_ms: number): void {
  if (is_memory_path(path)) return;
  const current = db.get<{ journal_mode: string }>("PRAGMA journal_mode");
  if (current !== undefined && current.journal_mode.toLowerCase() === "wal") return;

  const deadline = Date.now() + busy_timeout_ms;
  let delay_ms = WAL_RETRY_INITIAL_MS;
  for (;;) {
    try {
      const row = db.get<{ journal_mode: string }>("PRAGMA journal_mode = WAL");
      if (row === undefined || row.journal_mode.toLowerCase() !== "wal") {
        throw new Error("failed to enable SQLite WAL mode for a file database");
      }
      return;
    } catch (error) {
      if (!is_sqlite_busy_error(error)) throw error;
      const remaining_ms = deadline - Date.now();
      if (remaining_ms <= 0) {
        throw new Error(
          `failed to enable SQLite WAL mode within ${busy_timeout_ms}ms: the database is locked by another connection`,
          { cause: error },
        );
      }
      // Synchronous retry: connect() is synchronous, so the timer queue cannot
      // release another connection in this process. A cross-process holder
      // releases independently, and same-process holders fail the budget.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(delay_ms, remaining_ms));
      delay_ms = Math.min(delay_ms * 2, WAL_RETRY_MAX_MS);
    }
  }
}

function is_sqlite_busy_error(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { errcode?: unknown };
  if (candidate.errcode === SQLITE_BUSY) return true;
  return /database is locked/i.test(candidate.message);
}

function assert_sqlite_runtime(db: Db): void {
  const version_row = db.get<{ version: string }>("SELECT sqlite_version() AS version");
  const version = version_row?.version;
  if (typeof version !== "string" || !sqlite_version_at_least(version, SQLITE_MIN_VERSION)) {
    throw new Error(
      `SQLite ${String(version)} is older than the required ${SQLITE_MIN_VERSION} (node:sqlite runtime check)`,
    );
  }

  let json_row: { valid: bigint; object_type: string; array_type: string } | undefined;
  try {
    json_row = db.get<{ valid: bigint; object_type: string; array_type: string }>(
      "SELECT json_valid(?) AS valid, json_type(?) AS object_type, json_type(?) AS array_type",
      '{"a":1}',
      '{"a":1}',
      "[1]",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SQLite JSON functions are unavailable: ${message}`);
  }
  if (
    json_row === undefined ||
    Number(json_row.valid) !== 1 ||
    json_row.object_type !== "object" ||
    json_row.array_type !== "array"
  ) {
    throw new Error("SQLite JSON functions are unavailable or returned unexpected results");
  }
}

export interface ConnectOptions {
  /**
   * Total time to keep retrying the initial switch to WAL while another
   * connection holds a lock. Defaults to BUSY_TIMEOUT_MS; tests shorten it to
   * exercise the timeout without waiting five seconds.
   */
  wal_busy_timeout_ms?: number;
}

export function connect(path: string, options: ConnectOptions = {}): SqliteDb {
  const wal_busy_timeout_ms = options.wal_busy_timeout_ms ?? BUSY_TIMEOUT_MS;
  if (!Number.isFinite(wal_busy_timeout_ms) || wal_busy_timeout_ms < 0) {
    throw new RangeError("wal_busy_timeout_ms must be a non-negative finite number");
  }
  if (!is_memory_path(path)) {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }
  const db = new SqliteDb(path);
  try {
    assert_foreign_keys(db);
    assert_busy_timeout(db);
    assert_wal(db, path, wal_busy_timeout_ms);
    assert_sqlite_runtime(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const active_transactions = new WeakSet<Db>();

function is_thenable(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  return typeof (value as { then?: unknown }).then === "function";
}

function is_native_async_function(fn: unknown): boolean {
  if (typeof fn !== "function") return false;
  const constructor = (fn as { constructor?: { name?: string } }).constructor;
  return (
    constructor?.name === "AsyncFunction" ||
    Object.prototype.toString.call(fn) === "[object AsyncFunction]"
  );
}

function ignore_native_promise_rejection(value: unknown): void {
  // The callback has already run, so its writes are rolled back. Attach a
  // rejection handler so a native Promise cannot surface as an unhandled
  // rejection after tx() reports the contract violation. Only a real Promise
  // is touched: assimilating an arbitrary thenable would call its then() after
  // the rollback and let it write outside the transaction. The built-in
  // method is called directly so a Promise subclass cannot override then().
  if (!(value instanceof Promise)) return;
  void Promise.prototype.then.call(value, undefined, () => undefined);
}

/**
 * Short synchronous transaction. Nested calls are rejected. A native async
 * callback is rejected before BEGIN, and a synchronous callback that still
 * returns a thenable is rolled back and reported as an error. The parameter
 * type turns Promise-like return values into `never`, so these cases also fail
 * at compile time.
 */
export function tx<T>(db: Db, fn: () => T extends PromiseLike<unknown> ? never : T): T {
  if (active_transactions.has(db)) {
    throw new Error("nested tx() is not allowed");
  }
  if (is_native_async_function(fn)) {
    throw new Error("tx() callback must be synchronous; async functions are not allowed");
  }
  db.exec("BEGIN IMMEDIATE");
  active_transactions.add(db);
  try {
    const result: unknown = fn();
    if (result instanceof Promise || is_thenable(result)) {
      ignore_native_promise_rejection(result);
      throw new Error("tx() callback must be synchronous; it returned a Promise");
    }
    db.exec("COMMIT");
    return result as T;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Keep the original failure; SQLite may already have rolled the tx back.
    }
    throw error;
  } finally {
    active_transactions.delete(db);
  }
}

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export interface MigrateOptions {
  /** Test seam: lets a test supply an intentionally broken migration list. */
  migrations?: Migration[];
}

export interface MigrateResult {
  applied: boolean;
  schema_version: bigint;
}

const MIGRATION_FILE = /^(\d+)_([A-Za-z0-9_-]+)\.sql$/;

export function migrations_dir(): string {
  return fileURLToPath(new URL("./migrations/", import.meta.url));
}

export function load_migrations(directory: string = migrations_dir()): Migration[] {
  const entries = readdirSync(directory, { withFileTypes: true }).filter(
    (entry) => entry.isFile() && MIGRATION_FILE.test(entry.name),
  );
  const migrations: Migration[] = entries.map((entry) => {
    const match = MIGRATION_FILE.exec(entry.name);
    if (match === null) throw new Error(`invalid migration file name: ${entry.name}`);
    return {
      version: Number(match[1]),
      name: entry.name,
      sql: readFileSync(join(directory, entry.name), "utf8"),
    };
  });
  migrations.sort((left, right) => left.version - right.version);
  return migrations;
}

function ordered_migrations(migrations: Migration[]): Migration[] {
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  if (ordered.length === 0) {
    throw new Error("no database migrations were found");
  }
  for (const [index, migration] of ordered.entries()) {
    if (migration.version !== index + 1) {
      throw new Error(`database migrations must be numbered 1..N without gaps: ${migration.name}`);
    }
  }
  return ordered;
}

interface MetaRow {
  schema_version: bigint;
  database_instance_id: string;
  cursor_epoch: bigint;
}

function has_db_meta(db: Db): boolean {
  return (
    db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'db_meta'") !==
    undefined
  );
}

/**
 * Apply numbered migrations in order. All schema checks and the application
 * itself run under one BEGIN IMMEDIATE, so a concurrent initializer either sees
 * a completed schema (and reports `applied: false`) or waits for the lock. A
 * fresh database gets its db_meta row in the same transaction. An already-
 * current database is left untouched; a database from a newer schema is refused.
 */
export function migrate(db: Db, options: MigrateOptions = {}): MigrateResult {
  const migrations = ordered_migrations(options.migrations ?? load_migrations());
  const newest = migrations[migrations.length - 1];
  const newest_version = BigInt(newest.version);

  return tx<MigrateResult>(db, () => {
    if (!has_db_meta(db)) {
      const existing_tables = db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      );
      if (existing_tables.length > 0) {
        throw new Error("database has tables but no db_meta; refusing to apply migrations");
      }
      for (const migration of migrations) {
        db.exec(migration.sql);
      }
      db.prepare(
        "INSERT INTO db_meta (id, schema_version, database_instance_id, cursor_epoch) VALUES (1, ?, ?, 1)",
      ).run(newest_version, new_id());
      return { applied: true, schema_version: newest_version };
    }

    const meta = db.get<MetaRow>(
      "SELECT schema_version, database_instance_id, cursor_epoch FROM db_meta WHERE id = 1",
    );
    if (meta === undefined) {
      throw new Error("db_meta exists but has no row with id = 1");
    }
    if (meta.schema_version > newest_version) {
      throw new Error(
        `database schema_version ${String(meta.schema_version)} is newer than the newest known migration ${String(newest_version)}`,
      );
    }
    if (meta.schema_version === newest_version) {
      return { applied: false, schema_version: meta.schema_version };
    }

    const current_version = meta.schema_version;
    for (const migration of migrations) {
      if (BigInt(migration.version) > current_version) {
        db.exec(migration.sql);
      }
    }
    db.prepare("UPDATE db_meta SET schema_version = ? WHERE id = 1").run(newest_version);
    return { applied: true, schema_version: newest_version };
  });
}

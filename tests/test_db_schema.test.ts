import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  connect,
  load_migrations,
  migrate,
  sqlite_version_at_least,
  SQLITE_MIN_VERSION,
  type Db,
  type MigrateResult,
  type SqlValue,
} from "../scripts/pes_core/db.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { run_node_async } from "./helpers/cli.ts";
import { isolated_home, type IsolatedHome } from "./helpers/isolated_home.ts";

const DDL_PATH = fileURLToPath(
  new URL("../docs/plan/schemas/stage-1-ddl-draft.sql", import.meta.url),
);

function read_ddl(): string {
  return readFileSync(DDL_PATH, "utf8");
}

function sql_statements(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter((statement) => statement.length > 0);
}

function ddl_table_names(sql: string): string[] {
  const names: string[] = [];
  for (const match of sql.matchAll(/CREATE TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    names.push(match[1]);
  }
  return names.sort();
}

/**
 * Table names the full migration chain must leave: the DDL draft (= migration 001) plus what each later migration
 * creates, renames, or drops. Read from the migration files themselves (not hard-coded), so a new migration only
 * needs its own tests — but 001 is still pinned to the draft by its own test below.
 */
function expected_table_names(): string[] {
  const names = new Set(ddl_table_names(read_ddl()));
  for (const migration of load_migrations().filter((m) => m.version > 1)) {
    for (const statement of sql_statements(migration.sql)) {
      let m: RegExpMatchArray | null;
      if ((m = /^CREATE TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/i.exec(statement))) names.add(m[1]!);
      else if ((m = /^DROP TABLE\s+(?:IF EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(statement))) names.delete(m[1]!);
      else if ((m = /^ALTER TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+RENAME TO\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(statement))) {
        names.delete(m[1]!);
        names.add(m[2]!);
      }
    }
  }
  return [...names].sort();
}

/** newest migration number = db_meta.schema_version after a full migrate */
const SCHEMA_VERSION = 2n;
/** 61 tables of 001 + 8 AI-connection tables of 002 (runs is rebuilt, not added) */
const TABLE_COUNT = 69;

function open_migrated(home: IsolatedHome) {
  const db = connect(db_path(home.env));
  migrate(db);
  return db;
}

test("migrate creates all 69 tables (61 DDL + 8 of migration 002) with foreign keys and JSON support", () => {
  const home = isolated_home();
  const db = open_migrated(home);
  try {
    const names = db
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .map((row) => row.name);
    const expected = expected_table_names();

    assert.equal(expected.length, TABLE_COUNT);
    assert.equal(load_migrations().at(-1)!.version, Number(SCHEMA_VERSION), "the pinned schema version is the newest migration");
    assert.deepEqual(names, expected);

    const foreign_keys = db.get<{ foreign_keys: bigint }>("PRAGMA foreign_keys");
    assert.equal(foreign_keys?.foreign_keys, 1n);
    assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
    assert.equal(
      db.get<{ integrity_check: string }>("PRAGMA integrity_check")?.integrity_check,
      "ok",
    );

    const json = db.get<{ valid: bigint; object_type: string; array_type: string }>(
      "SELECT json_valid(?) AS valid, json_type(?) AS object_type, json_type(?) AS array_type",
      '{"a":1}',
      '{"a":1}',
      "[1]",
    );
    assert.equal(json?.valid, 1n);
    assert.equal(json?.object_type, "object");
    assert.equal(json?.array_type, "array");

    assert.equal(db.get<{ count: bigint }>("SELECT count(*) AS count FROM db_meta")?.count, 1n);
    const meta = db.get<{
      id: bigint;
      schema_version: bigint;
      database_instance_id: string;
      cursor_epoch: bigint;
    }>("SELECT id, schema_version, database_instance_id, cursor_epoch FROM db_meta");
    assert.equal(meta?.id, 1n);
    assert.equal(meta?.schema_version, SCHEMA_VERSION);
    assert.equal(meta?.cursor_epoch, 1n);
    assert.match(
      meta?.database_instance_id ?? "",
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    assert.equal(db.get<{ triggers: bigint }>("SELECT count(*) AS triggers FROM sqlite_master WHERE type = 'trigger'")?.triggers, 0n);
  } finally {
    db.close();
    home.cleanup();
  }
});

test("migrate is idempotent and keeps the database instance id", () => {
  const home = isolated_home();
  const db = open_migrated(home);
  try {
    const first = db.get<{ database_instance_id: string; schema_version: bigint }>(
      "SELECT database_instance_id, schema_version FROM db_meta WHERE id = 1",
    );
    const table_count = db.get<{ count: bigint }>(
      "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );

    const second = migrate(db);
    assert.equal(second.applied, false);
    assert.equal(second.schema_version, SCHEMA_VERSION);

    const after = db.get<{ database_instance_id: string; schema_version: bigint }>(
      "SELECT database_instance_id, schema_version FROM db_meta WHERE id = 1",
    );
    assert.equal(after?.database_instance_id, first?.database_instance_id);
    assert.equal(after?.schema_version, SCHEMA_VERSION);
    assert.equal(
      db.get<{ count: bigint }>(
        "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )?.count,
      table_count?.count,
    );
  } finally {
    db.close();
    home.cleanup();
  }
});

test("migrate checks schema state under the write lock when another connection wins first", () => {
  const home = isolated_home();
  const path = db_path(home.env);
  const a = connect(path);
  const b = connect(path);
  try {
    const events: string[] = [];
    let raced = false;
    let winner: MigrateResult | undefined;
    const wrapped: Db = {
      path: a.path,
      exec: (sql) => {
        if (sql === "BEGIN IMMEDIATE") {
          events.push("begin");
          if (!raced) {
            raced = true;
            // Simulate another process completing initialization after A
            // decided to migrate but before A acquired the write lock. The
            // old code checked db_meta before this point and misdiagnosed the
            // now-initialized database; the fixed code rechecks under the lock.
            winner = migrate(b);
          }
        }
        a.exec(sql);
      },
      prepare: (sql) => a.prepare(sql),
      run: (sql, ...params) => a.run(sql, ...params),
      get: <T>(sql: string, ...params: SqlValue[]) => {
        if (sql.includes("'db_meta'")) events.push("has-db-meta");
        if (sql.includes("FROM db_meta")) events.push("read-meta");
        return a.get<T>(sql, ...params);
      },
      all: <T>(sql: string, ...params: SqlValue[]) => a.all<T>(sql, ...params),
      close: () => a.close(),
    };

    const result = migrate(wrapped);
    assert.deepEqual(winner, { applied: true, schema_version: SCHEMA_VERSION });
    assert.deepEqual(result, { applied: false, schema_version: SCHEMA_VERSION });
    // Since migration 002 migrate() peeks at db_meta once BEFORE the lock (only to decide whether foreign keys must be
    // switched off for a table rebuild; on the not-yet-initialised database it finds no db_meta and reads nothing).
    // The authoritative has-db-meta + read-meta check must still happen AFTER BEGIN IMMEDIATE.
    const begin_at = events.indexOf("begin");
    assert.deepEqual(events.slice(0, begin_at), ["has-db-meta"], "the only thing before the lock is the db_meta existence peek");
    assert.deepEqual(events.slice(begin_at), ["begin", "has-db-meta", "read-meta"], "the recheck happens under the write lock");
    assert.equal(
      a.get<{ count: bigint }>(
        "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )?.count,
      BigInt(TABLE_COUNT),
    );
    assert.equal(a.get<{ count: bigint }>("SELECT count(*) AS count FROM db_meta")?.count, 1n);
  } finally {
    a.close();
    b.close();
    home.cleanup();
  }
});

test("connect retries the initial WAL switch until another process releases its lock", async () => {
  const home = isolated_home();
  const path = db_path(home.env);
  mkdirSync(dirname(path), { recursive: true });
  const holder = new DatabaseSync(path);
  let release: NodeJS.Timeout | undefined;
  try {
    holder.exec("CREATE TABLE lock_probe (id INTEGER)");
    assert.equal(
      holder.prepare("PRAGMA journal_mode").get()?.journal_mode,
      "delete",
      "the fresh database must not be in WAL mode before the race",
    );
    holder.exec("BEGIN IMMEDIATE");

    // The holder is a real write lock in this process, but the release timer
    // can only fire while this test awaits the child. The child therefore
    // retries from another process and succeeds once the lock is gone.
    release = setTimeout(() => {
      holder.exec("ROLLBACK");
    }, 500);

    const child = fileURLToPath(new URL("./helpers/wal_connect_child.ts", import.meta.url));
    const run = await run_node_async(home.env, [child]);
    assert.equal(run.status, 0, run.stderr);
    const line = run.stdout.trim().split(/\r?\n/).at(-1);
    assert.ok(line, `child must print a JSON result: ${run.stdout}`);
    const result = JSON.parse(line) as {
      journal_mode?: string;
      error?: string;
      waited_ms?: number;
    };
    assert.equal(result.error, undefined);
    assert.equal(result.journal_mode, "wal");
  } finally {
    if (release !== undefined) clearTimeout(release);
    holder.close();
    home.cleanup();
  }
});

test("connect reports a clear error when the WAL lock lasts past its retry budget", () => {
  const home = isolated_home();
  const path = db_path(home.env);
  mkdirSync(dirname(path), { recursive: true });
  const holder = new DatabaseSync(path);
  try {
    holder.exec("CREATE TABLE lock_probe (id INTEGER)");
    holder.exec("BEGIN IMMEDIATE");

    const started = Date.now();
    assert.throws(
      () => connect(path, { wal_busy_timeout_ms: 50 }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /failed to enable SQLite WAL mode within 50ms/);
        assert.ok(error.cause instanceof Error, "the original busy error must be kept as the cause");
        assert.match(error.cause.message, /database is locked/);
        return true;
      },
    );
    assert.ok(
      Date.now() - started >= 25,
      "connect must retry until the budget is spent instead of failing on the first BUSY",
    );
  } finally {
    try {
      holder.exec("ROLLBACK");
    } catch {
      // No active transaction if the setup failed before BEGIN.
    }
    holder.close();
    home.cleanup();
  }
});

test("connect keeps the WAL mode read inside the retry budget under an exclusive lock", async () => {
  const home = isolated_home();
  const path = db_path(home.env);
  mkdirSync(dirname(path), { recursive: true });
  const holder = new DatabaseSync(path);
  try {
    holder.exec("CREATE TABLE lock_probe (id INTEGER)");
    assert.equal(
      holder.prepare("PRAGMA journal_mode").get()?.journal_mode,
      "delete",
      "the fresh database must not be in WAL mode before the race",
    );
    holder.exec("BEGIN EXCLUSIVE");

    // The holder keeps an exclusive lock for the whole child run. The mode
    // read itself would wait on the default busy_timeout and push connect()
    // past its own deadline; the whole WAL stage must fail within the budget.
    const child = fileURLToPath(new URL("./helpers/wal_connect_child.ts", import.meta.url));
    const budget_ms = 200;
    const run = await run_node_async(home.env, [child, String(budget_ms)]);
    assert.equal(run.status, 1, run.stderr);
    const line = run.stdout.trim().split(/\r?\n/).at(-1);
    assert.ok(line, `child must print a JSON result: ${run.stdout}`);
    const result = JSON.parse(line) as { error?: string; cause?: string; waited_ms?: number };
    assert.match(
      result.error ?? "",
      new RegExp(`failed to enable SQLite WAL mode within ${budget_ms}ms`),
    );
    assert.match(result.cause ?? "", /database is locked/i);
    assert.ok(
      (result.waited_ms ?? 0) >= budget_ms / 2,
      `connect must retry until the budget is spent instead of failing on the first BUSY: ${String(result.waited_ms)}ms`,
    );
    assert.ok(
      (result.waited_ms ?? 0) < budget_ms + 1500,
      `the WAL stage must stay near its own budget: ${String(result.waited_ms)}ms`,
    );
  } finally {
    try {
      holder.exec("ROLLBACK");
    } catch {
      // No active transaction if the setup failed before BEGIN.
    }
    holder.close();
    home.cleanup();
  }
});

test("connect fails within a short budget after an exclusive lock becomes a write lock", async () => {
  const home = isolated_home();
  const path = db_path(home.env);
  mkdirSync(dirname(path), { recursive: true });
  const holder = new DatabaseSync(path);
  let switch_lock: NodeJS.Timeout | undefined;
  try {
    holder.exec("CREATE TABLE lock_probe (id INTEGER)");
    holder.exec("BEGIN EXCLUSIVE");

    // The holder keeps a write lock after an exclusive phase, as in the
    // review reproduction. A blocking mode read would spend the holder's
    // exclusive interval before the switch budget even starts.
    const child = fileURLToPath(new URL("./helpers/wal_connect_child.ts", import.meta.url));
    const budget_ms = 800;
    const run_promise = run_node_async(home.env, [child, String(budget_ms)]);
    switch_lock = setTimeout(() => {
      holder.exec("COMMIT; BEGIN IMMEDIATE");
    }, 1800);
    const run = await run_promise;
    assert.equal(run.status, 1, run.stderr);
    const line = run.stdout.trim().split(/\r?\n/).at(-1);
    assert.ok(line, `child must print a JSON result: ${run.stdout}`);
    const result = JSON.parse(line) as { error?: string; cause?: string; waited_ms?: number };
    assert.match(
      result.error ?? "",
      new RegExp(`failed to enable SQLite WAL mode within ${budget_ms}ms`),
    );
    assert.match(result.cause ?? "", /database is locked/i);
    assert.ok(
      (result.waited_ms ?? 0) >= budget_ms / 2,
      `connect must spend its budget instead of failing on the first BUSY: ${String(result.waited_ms)}ms`,
    );
    assert.ok(
      (result.waited_ms ?? 0) < budget_ms + 1500,
      `connect must not wait for the holder's lock transition: ${String(result.waited_ms)}ms`,
    );
  } finally {
    if (switch_lock !== undefined) clearTimeout(switch_lock);
    try {
      holder.exec("ROLLBACK");
    } catch {
      // No active transaction if the setup failed before BEGIN.
    }
    holder.close();
    home.cleanup();
  }
});

test("two child processes migrating the same database apply exactly once", async () => {
  const child = fileURLToPath(new URL("./helpers/migrate_child.ts", import.meta.url));
  for (let iteration = 1; iteration <= 10; iteration += 1) {
    const home = isolated_home();
    try {
      const runs = await Promise.all([
        run_node_async(home.env, [child]),
        run_node_async(home.env, [child]),
      ]);
      for (const run of runs) {
        assert.equal(run.status, 0, `iteration ${iteration}: ${run.stderr}`);
      }
      const results = runs.map((run) => {
        const line = run.stdout.trim().split(/\r?\n/).at(-1);
        assert.ok(line, `iteration ${iteration}: child must print a JSON result: ${run.stdout}`);
        return JSON.parse(line) as { applied: boolean; schema_version: string; error?: string };
      });
      for (const result of results) {
        assert.equal(result.error, undefined, `iteration ${iteration}`);
        assert.equal(result.schema_version, String(SCHEMA_VERSION), `iteration ${iteration}`);
      }
      assert.deepEqual(
        results.map((result) => result.applied).sort(),
        [false, true],
        `iteration ${iteration}`,
      );

      const db = connect(db_path(home.env));
      try {
        assert.equal(
          db.get<{ count: bigint }>(
            "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )?.count,
          BigInt(TABLE_COUNT),
          `iteration ${iteration}`,
        );
        assert.equal(
          db.get<{ count: bigint }>("SELECT count(*) AS count FROM db_meta")?.count,
          1n,
          `iteration ${iteration}`,
        );
        assert.equal(
          db.get<{ schema_version: bigint }>("SELECT schema_version FROM db_meta WHERE id = 1")
            ?.schema_version,
          SCHEMA_VERSION,
          `iteration ${iteration}`,
        );
      } finally {
        db.close();
      }
    } finally {
      home.cleanup();
    }
  }
});

test("migrate refuses a database from a newer schema", () => {
  const home = isolated_home();
  const db = open_migrated(home);
  try {
    db.run("UPDATE db_meta SET schema_version = 99 WHERE id = 1");
    assert.throws(() => migrate(db), /newer than the newest known migration/);
    assert.equal(
      db.get<{ schema_version: bigint }>("SELECT schema_version FROM db_meta WHERE id = 1")
        ?.schema_version,
      99n,
    );
  } finally {
    db.close();
    home.cleanup();
  }
});

test("migration 001 statements match the DDL draft after comment/space normalization", () => {
  const migrations = load_migrations();
  const initial = migrations.find((migration) => migration.version === 1);
  assert.ok(initial, "migration 001 must exist");

  const draft = sql_statements(read_ddl());
  const applied = sql_statements(initial.sql);
  assert.deepEqual(applied, draft);
  assert.equal(draft.filter((statement) => /^CREATE TABLE /i.test(statement)).length, 61);

  const executable = initial.sql.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(executable, /\bPRAGMA\b/i);
  assert.doesNotMatch(executable, /\bBEGIN\b/i);
  assert.doesNotMatch(executable, /\bATTACH\b/i);
  assert.doesNotMatch(executable, /\bTRIGGER\b/i);
  assert.doesNotMatch(executable, /\bVIRTUAL TABLE\b/i);
});

test("a failing later migration rolls back every table", () => {
  const home = isolated_home();
  const db = connect(db_path(home.env));
  try {
    const migrations = load_migrations();
    const broken = [
      ...migrations,
      {
        version: migrations.length + 1,
        name: "003_broken.sql",
        sql: "CREATE TABLE should_not_survive (id TEXT); THIS IS NOT SQL;",
      },
    ];
    assert.throws(() => migrate(db, { migrations: broken }));
    assert.deepEqual(
      db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      ),
      [],
    );

    const recovery = migrate(db);
    assert.equal(recovery.applied, true);
    assert.equal(
      db.get<{ count: bigint }>(
        "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )?.count,
      BigInt(TABLE_COUNT),
    );
  } finally {
    db.close();
    home.cleanup();
  }
});

test("the pure SQLite version check rejects old and malformed versions", () => {
  const runtime = connect(":memory:");
  try {
    const version = runtime.get<{ version: string }>("SELECT sqlite_version() AS version");
    assert.ok(version);
    assert.equal(sqlite_version_at_least(version.version, SQLITE_MIN_VERSION), true);
  } finally {
    runtime.close();
  }

  assert.equal(sqlite_version_at_least("3.38.0", "3.38.0"), true);
  assert.equal(sqlite_version_at_least("3.54.1", "3.38.0"), true);
  assert.equal(sqlite_version_at_least("3.54.1-node", "3.38.0"), true);
  assert.equal(sqlite_version_at_least("3.37.9", "3.38.0"), false);
  assert.equal(sqlite_version_at_least("2.99.99", "3.38.0"), false);
  assert.equal(sqlite_version_at_least("3.38", "3.38.0"), false);
  assert.equal(sqlite_version_at_least("", "3.38.0"), false);
  assert.equal(sqlite_version_at_least("not-a-version", "3.38.0"), false);
  assert.equal(sqlite_version_at_least("3.38.0", "3.38.1"), false);
});

// Migration 002 rebuilds `runs` (12-step: new table, copy, drop, rename). A database that already holds 001 data must
// come out with the same runs rows, the same foreign keys (own and from other tables), and the same indexes.
test("migration 002 on a 001 database keeps every runs row, foreign key and index (synthetic data)", () => {
  const home = isolated_home();
  const db = connect(db_path(home.env));
  try {
    const first = load_migrations().find((m) => m.version === 1)!;
    assert.equal(migrate(db, { migrations: [first] }).schema_version, 1n);

    db.exec("BEGIN"); // projects <-> project_members is a deferred cycle
    db.run("INSERT INTO users (id, display_name) VALUES ('u1', '합성 사용자')");
    db.run("INSERT INTO actors (id, kind, user_id, display_name) VALUES ('a-human', 'human', 'u1', '합성 사람')");
    db.run("INSERT INTO actors (id, kind, display_name) VALUES ('a-ai', 'internal_ai', '합성 AI')");
    db.run("INSERT INTO projects (id, slug, topic, owner_user_id) VALUES ('p1', 'synthetic', '합성 주제', 'u1')");
    db.run("INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u1', 'owner')");
    db.run("INSERT INTO editions (id, project_id, edition_no) VALUES ('e1', 'p1', 1)");
    // a legacy Go run, a blocked run, and a retry that points at the first through the self-referencing key
    db.run(
      `INSERT INTO runs (id, project_id, edition_id, actor_id, mode, runtime, provider, model, status, base_control_rev, started_at, ended_at, usage_json)
       VALUES ('r1', 'p1', 'e1', 'a-ai', 'A', 'opencode', 'opencode-go', 'opencode-go/synthetic', 'succeeded', 0, 10, 20, '{"input_tokens":5}')`,
    );
    db.run(
      `INSERT INTO runs (id, project_id, edition_id, actor_id, mode, runtime, provider, model, status, go_block_reason, go_blocked_at, go_block_reset_at, base_control_rev, retry_of, workflow_version)
       VALUES ('r2', 'p1', 'e1', 'a-ai', 'A', 'opencode', 'opencode-go', 'opencode-go/synthetic', 'blocked_usage', 'usage_limit', 30, 99, 3, 'r1', 'wf-x')`,
    );
    db.run(
      `INSERT INTO runs (id, project_id, edition_id, actor_id, mode, runtime, provider, model, status, base_control_rev)
       VALUES ('r3', 'p1', 'e1', 'a-human', 'B', 'external', 'any', 'any', 'queued', 0)`,
    );
    db.run(
      `INSERT INTO project_leases (project_id, lease_id, run_id, owner_actor_id, fence, state, acquired_at, heartbeat_at, expires_at)
       VALUES ('p1', 'lease-1', 'r3', 'a-human', 1, 'active', 1, 2, 3)`,
    );
    db.exec("COMMIT");

    const runs_rows = () =>
      JSON.stringify(db.all("SELECT * FROM runs ORDER BY id"), (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
    const own_fks = (table: string) =>
      db
        .all<{ table: string; from: string; to: string; on_delete: string }>(`PRAGMA foreign_key_list(${table})`)
        .map((r) => `${r.from}->${r.table}.${r.to}:${r.on_delete}`)
        .sort();
    const index_defs = () =>
      db
        .all<{ name: string; sql: string | null }>(
          "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'runs' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name",
        )
        .map((r) => `${r.name}|${r.sql}`);
    // tables that point at runs: every one must still be declared against `runs` (not the temporary name)
    const pointing = db
      .all<{ name: string; sql: string }>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql LIKE '%REFERENCES runs(%' ORDER BY name",
      );
    assert.ok(pointing.length >= 4, "001 has several tables with a key into runs");

    const before = {
      rows: runs_rows(),
      own: own_fks("runs"),
      indexes: index_defs(),
      children: pointing.map((r) => `${r.name}:${own_fks(r.name).filter((f) => f.includes("->runs.")).join(",")}`),
      lease: JSON.stringify(db.get("SELECT * FROM project_leases"), (_k, v) => (typeof v === "bigint" ? `${v}n` : v)),
    };
    assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
    assert.ok(before.indexes.some((d) => d.startsWith("runs_by_status|")));

    const result = migrate(db);
    assert.deepEqual(result, { applied: true, schema_version: SCHEMA_VERSION });

    assert.equal(runs_rows(), before.rows, "every runs row is copied unchanged (all columns)");
    assert.deepEqual(own_fks("runs"), before.own, "runs keeps its own foreign keys, incl. retry_of / parent_run_id");
    assert.deepEqual(index_defs(), before.indexes, "runs keeps its indexes");
    const pointing_after = db.all<{ name: string; sql: string }>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql LIKE '%REFERENCES runs(%' ORDER BY name",
    );
    assert.deepEqual(
      pointing_after.filter((r) => pointing.some((p) => p.name === r.name)).map((r) => r.name),
      pointing.map((r) => r.name),
    );
    assert.deepEqual(
      pointing.map((r) => `${r.name}:${own_fks(r.name).filter((f) => f.includes("->runs.")).join(",")}`),
      before.children,
      "other tables still point at runs",
    );
    assert.equal(db.all("SELECT name FROM sqlite_master WHERE name = 'runs_new'").length, 0, "no leftover temporary table");
    assert.doesNotMatch(
      db.all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").map((r) => r.sql).join("\n"),
      /runs_new/,
      "no table or index definition mentions the temporary name",
    );
    assert.equal(
      JSON.stringify(db.get("SELECT * FROM project_leases"), (_k, v) => (typeof v === "bigint" ? `${v}n` : v)),
      before.lease,
    );
    assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
    assert.equal(db.get<{ foreign_keys: bigint }>("PRAGMA foreign_keys")?.foreign_keys, 1n, "foreign keys are back ON");

    // the keys still bite
    assert.throws(
      () =>
        db.run(
          `INSERT INTO runs (id, project_id, edition_id, actor_id, mode, runtime, provider, model, status, base_control_rev)
           VALUES ('r-bad', 'nope', 'e1', 'a-ai', 'B', 'x', 'x', 'x', 'queued', 0)`,
        ),
      /FOREIGN KEY/i,
    );
    assert.throws(() => db.run("DELETE FROM runs WHERE id = 'r1'"), /FOREIGN KEY/i, "r2.retry_of still protects r1");
    assert.throws(() => db.run("DELETE FROM runs WHERE id = 'r3'"), /FOREIGN KEY/i, "the lease still protects r3");

    // and what 002 widened works, while the old rule stays closed
    db.run(
      `INSERT INTO runs (id, project_id, edition_id, actor_id, mode, runtime, provider, model, status, go_block_reason, go_blocked_at, base_control_rev)
       VALUES ('r4', 'p1', 'e1', 'a-ai', 'A', 'pes_builtin', 'synthetic-provider', 'synthetic-model', 'blocked_usage', 'cost_cap', 40, 0)`,
    );
    assert.throws(
      () =>
        db.run(
          `INSERT INTO runs (id, project_id, edition_id, actor_id, mode, runtime, provider, model, status, go_block_reason, go_blocked_at, base_control_rev)
           VALUES ('r5', 'p1', 'e1', 'a-ai', 'A', 'pes_builtin', 'p', 'm', 'blocked_usage', 'made_up_reason', 40, 0)`,
        ),
      /CHECK/i,
    );
    assert.throws(
      () =>
        db.run(
          `INSERT INTO runs (id, project_id, edition_id, actor_id, mode, runtime, provider, model, status, go_block_reason, go_blocked_at, base_control_rev)
           VALUES ('r6', 'p1', 'e1', 'a-ai', 'A', 'pes_builtin', 'p', 'm', 'running', 'cost_cap', 40, 0)`,
        ),
      /CHECK/i,
      "a block reason still needs status blocked_usage",
    );
  } finally {
    db.close();
    home.cleanup();
  }
});

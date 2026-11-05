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

function open_migrated(home: IsolatedHome) {
  const db = connect(db_path(home.env));
  migrate(db);
  return db;
}

test("migrate creates all 61 DDL tables with foreign keys and JSON support", () => {
  const home = isolated_home();
  const db = open_migrated(home);
  try {
    const names = db
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .map((row) => row.name);
    const expected = ddl_table_names(read_ddl());

    assert.equal(expected.length, 61);
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
    assert.equal(meta?.schema_version, 1n);
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
    assert.equal(second.schema_version, 1n);

    const after = db.get<{ database_instance_id: string; schema_version: bigint }>(
      "SELECT database_instance_id, schema_version FROM db_meta WHERE id = 1",
    );
    assert.equal(after?.database_instance_id, first?.database_instance_id);
    assert.equal(after?.schema_version, 1n);
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
    assert.deepEqual(winner, { applied: true, schema_version: 1n });
    assert.deepEqual(result, { applied: false, schema_version: 1n });
    assert.deepEqual(events, ["begin", "has-db-meta", "read-meta"]);
    assert.equal(
      a.get<{ count: bigint }>(
        "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )?.count,
      61n,
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
        assert.equal(result.schema_version, "1", `iteration ${iteration}`);
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
          61n,
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
          1n,
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
        name: "002_broken.sql",
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
      61n,
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

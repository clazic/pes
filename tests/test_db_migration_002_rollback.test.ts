// SEL-52 (PR19) migration 002 rebuilds `runs` with foreign keys switched off. If it stops half way, or leaves a row whose
// foreign key points nowhere, the database must be exactly the 001 database again (synthetic data only).

import assert from "node:assert/strict";
import { test } from "node:test";

import { connect, load_migrations, migrate, type Db } from "../scripts/pes_core/db.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { isolated_home } from "./helpers/isolated_home.ts";

function json(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
}

function seed_001(db: Db): void {
  db.exec("BEGIN");
  db.run("INSERT INTO users (id, display_name) VALUES ('u1', '합성 사용자')");
  db.run("INSERT INTO actors (id, kind, user_id, display_name) VALUES ('a-human', 'human', 'u1', '합성 사람')");
  db.run("INSERT INTO actors (id, kind, display_name) VALUES ('a-ai', 'internal_ai', '합성 AI')");
  db.run("INSERT INTO projects (id, slug, topic, owner_user_id) VALUES ('p1', 'synthetic', '합성 주제', 'u1')");
  db.run("INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u1', 'owner')");
  db.run("INSERT INTO editions (id, project_id, edition_no) VALUES ('e1', 'p1', 1)");
  db.run(
    `INSERT INTO runs (id, project_id, edition_id, actor_id, mode, runtime, provider, model, status, base_control_rev)
     VALUES ('r1', 'p1', 'e1', 'a-ai', 'A', 'opencode', 'opencode-go', 'opencode-go/synthetic', 'succeeded', 0)`,
  );
  db.run(
    `INSERT INTO runs (id, project_id, edition_id, actor_id, mode, runtime, provider, model, status, base_control_rev, retry_of)
     VALUES ('r2', 'p1', 'e1', 'a-ai', 'A', 'opencode', 'opencode-go', 'opencode-go/synthetic', 'failed', 0, 'r1')`,
  );
  db.exec("COMMIT");
}

interface Shape {
  version: bigint | undefined;
  tables: string[];
  runs: string;
  schema: string;
  foreign_keys: bigint | undefined;
}

function shape(db: Db): Shape {
  return {
    version: db.get<{ v: bigint }>("SELECT schema_version AS v FROM db_meta WHERE id = 1")?.v,
    tables: db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .map((r) => r.name),
    runs: json(db.all("SELECT * FROM runs ORDER BY id")),
    schema: json(db.all("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")),
    foreign_keys: db.get<{ foreign_keys: bigint }>("PRAGMA foreign_keys")?.foreign_keys,
  };
}

function with_001<T>(fn: (db: Db) => T): T {
  const home = isolated_home();
  const db = connect(db_path(home.env));
  try {
    const first = load_migrations().find((m) => m.version === 1)!;
    migrate(db, { migrations: [first] });
    seed_001(db);
    return fn(db);
  } finally {
    db.close();
    home.cleanup();
  }
}

function broken_002(replace: (sql: string) => string) {
  const all = load_migrations();
  const second = all.find((m) => m.version === 2)!;
  const sql = replace(second.sql);
  assert.notEqual(sql, second.sql, "the test really changed migration 002");
  return all.map((m) => (m.version === 2 ? { ...m, sql } : m));
}

function assert_back_to_001(db: Db, before: Shape, label: string, orphans = 0): void {
  const after = shape(db);
  assert.equal(after.version, 1n, `${label}: still schema version 1`);
  assert.equal(after.tables.length, 61, `${label}: no table of 002 survived`);
  assert.equal(after.tables.includes("runs_new"), false);
  assert.equal(after.tables.includes("ai_connections"), false);
  assert.equal(after.runs, before.runs, `${label}: runs rows unchanged`);
  assert.equal(after.schema, before.schema, `${label}: every table, index and its SQL unchanged`);
  assert.equal(after.foreign_keys, 1n, `${label}: foreign keys are switched back ON`);
  assert.equal(db.all("PRAGMA foreign_key_check").length, orphans);
}

test("002 that fails at its very end leaves the 001 database untouched", () => {
  with_001((db) => {
    const before = shape(db);
    assert.throws(() => migrate(db, { migrations: broken_002((sql) => `${sql}\nTHIS IS NOT SQL;`) }));
    assert_back_to_001(db, before, "error at the end");
  });
});

test("002 that fails right AFTER dropping the old runs table gets runs back with all rows", () => {
  with_001((db) => {
    const before = shape(db);
    assert.throws(() =>
      migrate(db, { migrations: broken_002((sql) => sql.replace("ALTER TABLE runs_new RENAME TO runs;", "ALTER TABLE no_such_table RENAME TO whatever;")) }),
    );
    assert_back_to_001(db, before, "error after DROP TABLE runs");
    // and a correct 002 still applies afterwards, with the rows intact
    const result = migrate(db);
    assert.deepEqual(result, { applied: true, schema_version: 2n });
    assert.equal(json(db.all("SELECT * FROM runs ORDER BY id")), before.runs);
  });
});

test("002 that fails before it copies anything also leaves 001", () => {
  with_001((db) => {
    const before = shape(db);
    assert.throws(() => migrate(db, { migrations: broken_002((sql) => sql.replace("CREATE TABLE ai_connections (", "CREATE TABLE ai_connections (\n    id TEXT PRIMARY KEY NOT NULL, id TEXT,")) }));
    assert_back_to_001(db, before, "error in the first CREATE TABLE");
  });
});

test("a 001 database with a row whose foreign key points nowhere is refused, rolled back, and foreign keys come back ON", () => {
  with_001((db) => {
    db.exec("PRAGMA foreign_keys = OFF");
    db.run(
      `INSERT INTO runs (id, project_id, edition_id, actor_id, mode, runtime, provider, model, status, base_control_rev)
       VALUES ('r-orphan', 'p1', 'e-missing', 'a-ai', 'B', 'x', 'x', 'x', 'queued', 0)`,
    );
    db.exec("PRAGMA foreign_keys = ON");
    const before = shape(db);
    assert.throws(() => migrate(db), /foreign key|rolled back/i);
    assert_back_to_001(db, before, "orphan row", 1);
    assert.equal(db.all("SELECT id FROM runs WHERE id = 'r-orphan'").length, 1, "the orphan is left for a person to look at, not deleted");
  });
});

test("a database from before 002 is not changed by merely reading it, and migrate twice after a failure applies once", () => {
  with_001((db) => {
    const before = shape(db);
    assert.throws(() => migrate(db, { migrations: broken_002((sql) => `${sql}\nTHIS IS NOT SQL;`) }));
    assert.throws(() => migrate(db, { migrations: broken_002((sql) => `${sql}\nTHIS IS NOT SQL;`) }));
    assert_back_to_001(db, before, "two failures in a row");
    assert.equal(migrate(db).applied, true);
    assert.equal(migrate(db).applied, false);
    assert.equal(shape(db).version, 2n);
  });
});

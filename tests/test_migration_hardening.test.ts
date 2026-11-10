// SEL-45 (stage 2 PR12) hardening: tries to break validate / activate / rollback / restore.
// All data is synthetic (tests/fixtures/legacy/ copied into an isolated HOME/PES_HOME per test).
// Nothing reads or writes the real ~/.pes or ~/pes-projects.
//
// Areas (numbers follow the hardening brief):
//   1  restore is all-or-nothing: insert failure mid-bundle, foreign key violation, object file write failure
//   2  other projects, users/actors, db_meta identity, same-bytes blob of another project
//   3  lost_writes equals exactly the commits that disappear; audit rows are replaced only inside the project
//   4  cursor_epoch rises on every successful restore, never on a refused one; old cursors are stale
//   5  CommandService.read cannot write (statements, pragmas, transactions, stale handles)
//   6  every wrong state transition is refused without a trace; repeating a step is safe
//   7  backup location rules (PES home, OneDrive, symlink escapes, object store)
//   8  the source folder never changes

import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { assert_cursor_epoch, export_project, verify_bundle } from "../scripts/pes_core/backup.ts";
import type { Db } from "../scripts/pes_core/db.ts";
import {
  activated,
  add_agent,
  age_tree,
  backup_dir_of,
  batch_row,
  copy_fixture,
  cursor_epoch,
  domain_counts,
  events_of,
  instance_id,
  object_files,
  owner_of,
  pes_home_of,
  project_status,
  rejects_any,
  rejects_api,
  run_import,
  stage,
  state_signature,
  tree_stamps,
  validated,
  with_migration,
  write_topic,
  type ActivateResult,
  type Env,
  type LegacyApi,
  type MigrationApi,
  type Staged,
} from "./helpers/migration_env.ts";
import { blob_row_must, disk_path, put_ready, second_project } from "./helpers/blob_env.ts";
import { wrap_db } from "./helpers/blob_env.ts";
import { project_row } from "./helpers/legacy_env.ts";
import { list_tree } from "./helpers/backup_fixture.ts";

// ---------------------------------------------------------------------------
// helpers

function topic_of(env: Env, project_id: string): string {
  return project_row(env.db, project_id).topic;
}

/** path -> content hash ("dir" for a folder, "link" for a symlink): sees a rewrite, a delete, a swap. */
function fs_digest(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const st = lstatSync(full);
      const key = full.slice(root.length + 1).replace(/\\/g, "/");
      if (st.isSymbolicLink()) out[key] = "link";
      else if (st.isDirectory()) {
        out[key] = "dir";
        walk(full);
      } else out[key] = `${st.size}:${readFileSync(full).toString("base64")}`;
    }
  };
  walk(root);
  return out;
}

function pragma_int(db: Db, name: string): bigint {
  const row = db.get<Record<string, bigint | number>>(`PRAGMA ${name}`);
  assert.ok(row, `PRAGMA ${name} answers`);
  return BigInt(Object.values(row)[0] as bigint | number);
}

/** Everything a restore of `project_id` must not touch: other projects' rows, users, actors, db_meta identity. */
function others_signature(db: Db, project_id: string): string {
  const tables = db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .map((row) => row.name);
  const parts: string[] = [];
  const replacer = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? `${v.toString()}n` : v);
  for (const table of tables) {
    const columns = db.all<{ name: string }>(`PRAGMA table_info("${table}")`).map((c) => c.name);
    let rows: unknown[];
    if (table === "db_meta") {
      rows = db
        .all<Record<string, unknown>>(`SELECT * FROM "${table}"`)
        .map((r) => ({ ...r, cursor_epoch: "*" }));
    } else if (table === "projects") {
      rows = db.all(`SELECT * FROM "${table}" WHERE id <> ? ORDER BY rowid`, project_id);
    } else if (columns.includes("project_id")) {
      rows = db.all(`SELECT * FROM "${table}" WHERE project_id <> ? ORDER BY rowid`, project_id);
    } else {
      rows = db.all(`SELECT * FROM "${table}" ORDER BY rowid`);
    }
    parts.push(`${table}:${JSON.stringify(rows, replacer)}`);
  }
  return parts.join("\n");
}

async function activated_with_writes(
  env: Env,
  legacy: LegacyApi,
  mig: MigrationApi,
  name: string,
  writes = 2,
): Promise<Staged & { act: ActivateResult }> {
  const a = await activated(env, legacy, mig, "full", name);
  for (let i = 1; i <= writes; i += 1) {
    await write_topic(env, a.imp.project_id, `${name} 쓰기 ${i}`, `${name}-w${i}`);
  }
  return a;
}

/** A service whose Nth bundle INSERT (a quoted table name) throws. Receipts and events are not counted. */
function failing_on_nth_insert(env: Env, n: number) {
  let count = 0;
  return env.with_db(
    wrap_db(env.db, (sql) => {
      if (/^\s*INSERT INTO "/.test(sql)) {
        count += 1;
        if (count === n) throw new Error("injected insert failure");
      }
    }),
  );
}

function restore_opts(env: Env, project_id: string, bundle_dir: string) {
  return { owner_actor_id: owner_of(env), project_id, bundle_dir };
}

function activate_opts(env: Env, backup_dir: string) {
  return { owner_actor_id: owner_of(env), backup_dir, pes_home: pes_home_of(env) };
}

// ---------------------------------------------------------------------------
// 1. restore is all-or-nothing

for (const n of [1, 6, 30]) {
  test(`restore: a failure at bundle insert #${n} leaves rows, object files and pragmas exactly as before`, async () => {
    await with_migration(async (env, legacy, mig) => {
      const a = await activated_with_writes(env, legacy, mig, `aon${n}`);
      const id = a.imp.project_id;
      const before_db = state_signature(env.db);
      const before_files = fs_digest(env.objects);
      const epoch = cursor_epoch(env.db);
      const fk_before = pragma_int(env.db, "foreign_keys");

      await rejects_any(mig.restore_project(failing_on_nth_insert(env, n), restore_opts(env, id, a.act.backup_dir)));

      assert.equal(state_signature(env.db), before_db, "no row changed (the deletes were rolled back too)");
      assert.deepEqual(fs_digest(env.objects), before_files, "no object file changed");
      assert.equal(cursor_epoch(env.db), epoch, "a failed restore does not move the cursor epoch");
      assert.equal(pragma_int(env.db, "defer_foreign_keys"), 0n, "deferred foreign keys did not leak out of the transaction");
      assert.equal(pragma_int(env.db, "foreign_keys"), fk_before, "foreign key enforcement is unchanged");
      assert.equal(env.db.all("PRAGMA foreign_key_check").length, 0);

      // the connection is still usable: a normal write and a real restore both work afterwards
      await write_topic(env, id, `aon${n} 뒤 쓰기`, `aon${n}-after`);
      const out = await mig.restore_project(env.service, restore_opts(env, id, a.act.backup_dir));
      assert.equal(out.lost_writes.length, 3, "two earlier writes and the one made after the failed attempt");
    });
  });
}

test("restore: a foreign key violation from another project (its reference needs a row the bundle lacks) is refused with nothing changed", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated(env, legacy, mig, "full", "fk-refuse");
    const id = a.imp.project_id;
    const bystander = env.p;
    // A snapshot made in A AFTER the bundle, and a reference from the bystander project to exactly it.
    const blob = env.db.get<{ id: string }>("SELECT id FROM blobs WHERE project_id = ? ORDER BY id LIMIT 1", id);
    const edition = env.db.get<{ id: string }>("SELECT id FROM editions WHERE project_id = ? ORDER BY id LIMIT 1", id);
    assert.ok(blob && edition, "the imported project has a blob and an edition");
    const user = env.db.get<{ user_id: string }>("SELECT user_id FROM actors WHERE id = ?", bystander.actor_id);
    assert.ok(user?.user_id);
    env.db.run(
      `INSERT INTO snapshots (id, project_id, edition_id, scope, manifest_blob_id, control_rev, content_hash)
       VALUES ('synthetic-snap-1', ?, ?, 'edition', ?, 0, ?)`,
      id,
      edition.id,
      blob.id,
      "a".repeat(64),
    );
    env.db.run(
      `INSERT INTO project_references (id, project_id, referenced_project_id, referenced_project_key, source_snapshot_id,
         source_label, attached_by_actor_id, attached_by_user_id)
       VALUES ('synthetic-ref-1', ?, ?, 'synthetic-key', 'synthetic-snap-1', '합성 참조', ?, ?)`,
      bystander.project_id,
      id,
      bystander.actor_id,
      user.user_id,
    );
    const before_db = state_signature(env.db);
    const before_files = fs_digest(env.objects);

    await rejects_api(mig.restore_project(env.service, restore_opts(env, id, a.act.backup_dir)), "conflict");

    assert.equal(state_signature(env.db), before_db, "all-or-nothing: not one row changed");
    assert.deepEqual(fs_digest(env.objects), before_files, "files were not touched before the refusal");
    assert.equal(pragma_int(env.db, "defer_foreign_keys"), 0n);
    assert.equal(env.db.all("PRAGMA foreign_key_check").length, 0);
  });
});

test("restore: a reference from another project to the restored project's row (no snapshot) survives untouched", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated_with_writes(env, legacy, mig, "fk-keep");
    const id = a.imp.project_id;
    const bystander = env.p;
    const user = env.db.get<{ user_id: string }>("SELECT user_id FROM actors WHERE id = ?", bystander.actor_id);
    assert.ok(user?.user_id);
    env.db.run(
      `INSERT INTO project_references (id, project_id, referenced_project_id, referenced_project_key,
         source_label, attached_by_actor_id, attached_by_user_id)
       VALUES ('synthetic-ref-2', ?, ?, 'synthetic-key-2', '합성 참조', ?, ?)`,
      bystander.project_id,
      id,
      bystander.actor_id,
      user.user_id,
    );
    const others = others_signature(env.db, id);
    await mig.restore_project(env.service, restore_opts(env, id, a.act.backup_dir));
    assert.equal(others_signature(env.db, id), others, "the bystander's reference row is the same row");
    assert.equal(env.db.all("PRAGMA foreign_key_check").length, 0);
    assert.ok(env.db.get("SELECT 1 FROM projects WHERE id = ?", id), "the referenced project exists again");
  });
});

test("restore: when an object file cannot be written, the database and ALL object files stay as they were (no half-restored folder)", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated_with_writes(env, legacy, mig, "file-fail");
    const id = a.imp.project_id;
    const keys = readdirSync(join(a.act.backup_dir, "objects", id), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(join(a.act.backup_dir, "objects").length + 1));
    assert.ok(keys.length >= 2, "the bundle holds at least two object files");

    // Every restorable file is damaged on disk; the LAST one cannot even be rewritten (a folder sits on its path).
    for (const key of keys) writeFileSync(join(env.objects, ...key.split("/")), "damaged-by-test");
    const blocked = join(env.objects, ...keys[keys.length - 1]!.split("/"));
    rmSync(blocked);
    mkdirSync(blocked);
    writeFileSync(join(blocked, "inside"), "x");
    const before_db = state_signature(env.db);
    const before_files = fs_digest(env.objects);

    await rejects_any(mig.restore_project(env.service, restore_opts(env, id, a.act.backup_dir)));

    assert.equal(state_signature(env.db), before_db, "the transaction rolled back");
    assert.deepEqual(
      fs_digest(env.objects),
      before_files,
      "all-or-nothing for the files too: the files written before the failing one must be put back",
    );
    assert.equal(pragma_int(env.db, "defer_foreign_keys"), 0n);
  });
});

// ---------------------------------------------------------------------------
// 2. other projects, global rows, shared bytes

test("restore: other projects' rows (incl. events and receipts), users, actors and the database identity are identical afterwards", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated_with_writes(env, legacy, mig, "others");
    const c = await activated(env, legacy, mig, "complete", "others-c");
    await write_topic(env, c.imp.project_id, "다른 이전 프로젝트 쓰기", "others-cw");
    await write_topic(env, env.p.project_id, "방관자 쓰기", "others-bw");
    const before = others_signature(env.db, a.imp.project_id);
    const files_c = list_tree(join(env.objects, c.imp.project_id));
    const files_b = list_tree(join(env.objects, env.p.project_id));
    const instance = instance_id(env.db);
    const other_events = events_of(env.db, c.imp.project_id);

    await mig.restore_project(env.service, restore_opts(env, a.imp.project_id, a.act.backup_dir));

    assert.equal(others_signature(env.db, a.imp.project_id), before);
    assert.deepEqual(list_tree(join(env.objects, c.imp.project_id)), files_c);
    assert.deepEqual(list_tree(join(env.objects, env.p.project_id)), files_b);
    assert.equal(instance_id(env.db), instance);
    assert.deepEqual(events_of(env.db, c.imp.project_id), other_events);
  });
});

test("restore: another project's file with the very same bytes (same sha256) keeps its blob row and its file", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated_with_writes(env, legacy, mig, "shared");
    const id = a.imp.project_id;
    const blob_id = env.db.get<{ id: string }>(
      "SELECT id FROM blobs WHERE project_id = ? AND state = 'ready' ORDER BY id LIMIT 1",
      id,
    )?.id;
    assert.ok(blob_id, "the imported project has a ready blob");
    const mine = blob_row_must(env.db, blob_id);
    const bytes = new Uint8Array(readFileSync(disk_path(env, mine)));
    const other = await put_ready(env, bytes, "shared-bytes"); // the bystander project uploads identical bytes
    const other_row = blob_row_must(env.db, other.blob_id);
    assert.equal(other_row.sha256, mine.sha256, "same content hash in two projects");
    assert.notEqual(other_row.storage_key, mine.storage_key, "but each project has its own file");
    const other_path = disk_path(env, other_row);
    const other_bytes = readFileSync(other_path);

    // the restored project loses its copy; the restore must bring it back and leave the other copy alone
    rmSync(disk_path(env, mine));
    await mig.restore_project(env.service, restore_opts(env, id, a.act.backup_dir));

    assert.ok(existsSync(other_path), "the other project's file still exists");
    assert.deepEqual(readFileSync(other_path), other_bytes);
    assert.ok(existsSync(disk_path(env, mine)), "the restored project's own file is back");
    assert.equal(blob_row_must(env.db, other.blob_id).state, "ready");
  });
});

test("restore: a stray file in the project folder is removed but the bystander's folder with the same file name is not", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated(env, legacy, mig, "full", "stray");
    const id = a.imp.project_id;
    const other_dir = join(env.objects, env.p.project_id);
    mkdirSync(other_dir, { recursive: true });
    writeFileSync(join(other_dir, "stray.bin"), "bystander-owned");
    writeFileSync(join(env.objects, id, "stray.bin"), "left over after the bundle");

    await mig.restore_project(env.service, restore_opts(env, id, a.act.backup_dir));

    assert.equal(existsSync(join(env.objects, id, "stray.bin")), false, "the project's stray file is gone");
    assert.equal(readFileSync(join(other_dir, "stray.bin"), "utf8"), "bystander-owned");
  });
});

// ---------------------------------------------------------------------------
// 3. lost_writes is exact

test("restore from a LATER bundle: lost_writes lists exactly the commits that disappear (not the ones the bundle holds), oldest first", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated(env, legacy, mig, "full", "lost-exact");
    const id = a.imp.project_id;
    await write_topic(env, id, "번들에 들어가는 쓰기", "le-w1");
    const bundle = backup_dir_of(env, "manual-later");
    export_project(env.db, env.objects, id, bundle);
    const mark = env.db.get<{ r: bigint }>("SELECT max(rowid) AS r FROM mutation_commits WHERE project_id = ?", id)?.r ?? 0n;
    await write_topic(env, id, "번들 뒤 쓰기 1", "le-w2");
    env.clock.advance(5_000);
    await write_topic(env, id, "번들 뒤 쓰기 2", "le-w3");
    await write_topic(env, id, "번들 뒤 쓰기 3", "le-w4");
    const gone = env.db.all<{ id: string; action: string; created_at: bigint }>(
      "SELECT id, action, created_at FROM mutation_commits WHERE project_id = ? AND rowid > ? ORDER BY rowid",
      id,
      mark,
    );
    assert.equal(gone.length, 3);
    const kept_before = env.db.all<{ id: string }>(
      "SELECT id FROM mutation_commits WHERE project_id = ? AND rowid <= ? ORDER BY rowid",
      id,
      mark,
    );

    const out = await mig.restore_project(env.service, restore_opts(env, id, bundle));

    assert.deepEqual(
      out.lost_writes,
      gone.map((row) => ({ action: row.action, created_at: new Date(Number(row.created_at)).toISOString() })),
      "the list equals the commits that existed after the bundle, with their real times",
    );
    assert.deepEqual(out.reverted_steps, [], "no migration step happened after this bundle");
    assert.equal(topic_of(env, id), "번들에 들어가는 쓰기", "the write inside the bundle survived");
    const now = env.db.all<{ id: string; action: string }>(
      "SELECT id, action FROM mutation_commits WHERE project_id = ? ORDER BY rowid",
      id,
    );
    assert.deepEqual(
      now.filter((row) => row.action !== "legacy.restore_project").map((row) => row.id),
      kept_before.map((row) => row.id),
      "the commits of the bundle are all there, the lost ones are all gone, and only the restore receipt is new",
    );
    for (const lost of gone) {
      assert.equal(env.db.get("SELECT 1 FROM mutation_commits WHERE id = ?", lost.id), undefined, "lost commit is gone");
    }
    const event = events_of(env.db, id).filter((e) => e.type === "legacy.project_restored");
    assert.equal(event.length, 1);
    assert.equal(event[0]!.payload.lost_writes, 3);
  });
});

test("restore: receipts and events of the project are replaced by the bundle's, and only inside that project", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated_with_writes(env, legacy, mig, "audit");
    const id = a.imp.project_id;
    const other_commits = env.db.all("SELECT * FROM mutation_commits WHERE project_id <> ? ORDER BY rowid", id);
    const other_events = env.db.all("SELECT * FROM events WHERE project_id <> ? ORDER BY event_seq", id);
    const types_before = events_of(env.db, id).map((e) => e.type);
    assert.ok(types_before.includes("legacy.import_activated"));

    await mig.restore_project(env.service, restore_opts(env, id, a.act.backup_dir));

    const types_after = events_of(env.db, id).map((e) => e.type);
    assert.ok(!types_after.includes("legacy.import_activated"), "the activation event belongs to a later state");
    assert.ok(!types_after.includes("project.topic_set"), "events of lost writes are gone");
    assert.equal(types_after[types_after.length - 1], "legacy.project_restored", "the restore event is the newest");
    assert.deepEqual(env.db.all("SELECT * FROM mutation_commits WHERE project_id <> ? ORDER BY rowid", id), other_commits);
    assert.deepEqual(env.db.all("SELECT * FROM events WHERE project_id <> ? ORDER BY event_seq", id), other_events);
  });
});

test("restore from the same bundle twice: the second finds no business write to lose and ends in the same project state", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated_with_writes(env, legacy, mig, "twice");
    const id = a.imp.project_id;
    const first = await mig.restore_project(env.service, restore_opts(env, id, a.act.backup_dir));
    assert.equal(first.lost_writes.length, 2);
    const counts = domain_counts(env.db, id);
    const files = fs_digest(join(env.objects, id));
    const second = await mig.restore_project(env.service, restore_opts(env, id, a.act.backup_dir));
    assert.deepEqual(second.lost_writes, [], "nothing business-wise was written between the two restores");
    assert.deepEqual(domain_counts(env.db, id), counts);
    assert.deepEqual(fs_digest(join(env.objects, id)), files);
    assert.equal(project_status(env.db, id), "staging");
    assert.equal(batch_row(env.db, a.imp.batch_id).state, "validated");
  });
});

test("restore then activate again with a new backup works: the cycle can be repeated", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated_with_writes(env, legacy, mig, "recycle");
    const id = a.imp.project_id;
    await mig.restore_project(env.service, restore_opts(env, id, a.act.backup_dir));
    const again = await mig.activate_import(env.service, a.imp.batch_id, activate_opts(env, backup_dir_of(env, "recycle-2")));
    assert.equal(again.state, "activated");
    assert.equal(project_status(env.db, id), "active");
    assert.equal(verify_bundle(again.backup_dir).ok, true);
  });
});

// rollback_before_write must look at what is really in the project after a restore, not at old ids.

test("after restoring a bundle that already holds a business write, rollback_before_write is still refused", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated(env, legacy, mig, "full", "rb-after-restore");
    const id = a.imp.project_id;
    await write_topic(env, id, "번들에 들어가는 쓰기", "rbr-w1");
    const bundle = backup_dir_of(env, "manual-with-write");
    export_project(env.db, env.objects, id, bundle);
    await write_topic(env, id, "번들 뒤 쓰기", "rbr-w2");
    await mig.restore_project(env.service, restore_opts(env, id, bundle));
    const before = state_signature(env.db);
    await rejects_api(mig.rollback_before_write(env.service, a.imp.batch_id, { owner_actor_id: owner_of(env) }), "conflict");
    assert.equal(state_signature(env.db), before);
    assert.equal(project_status(env.db, id), "active");
  });
});

test("after restoring an activated-but-unwritten bundle, rollback_before_write is allowed (the later write was lost)", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated(env, legacy, mig, "full", "rb-no-write");
    const id = a.imp.project_id;
    const bundle = backup_dir_of(env, "manual-activated");
    export_project(env.db, env.objects, id, bundle);
    await write_topic(env, id, "번들 뒤 쓰기", "rbn-w1");
    await mig.restore_project(env.service, restore_opts(env, id, bundle));
    const out = await mig.rollback_before_write(env.service, a.imp.batch_id, { owner_actor_id: owner_of(env) });
    assert.equal(out.state, "failed");
    assert.equal(out.from_state, "activated");
    assert.equal(project_status(env.db, id), "archived");
  });
});

// ---------------------------------------------------------------------------
// 4. cursor epoch

test("cursor_epoch: +1 per successful restore, unchanged by refusals, and every older cursor is stale", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated_with_writes(env, legacy, mig, "epoch");
    const id = a.imp.project_id;
    const e0 = cursor_epoch(env.db);

    // refusals do not count
    await rejects_any(mig.restore_project(env.service, restore_opts(env, id, backup_dir_of(env, "missing"))));
    await rejects_any(mig.restore_project(failing_on_nth_insert(env, 4), restore_opts(env, id, a.act.backup_dir)));
    assert.equal(cursor_epoch(env.db), e0);

    const r1 = await mig.restore_project(env.service, restore_opts(env, id, a.act.backup_dir));
    assert.equal(r1.cursor_epoch_before, e0.toString());
    assert.equal(r1.cursor_epoch_after, (e0 + 1n).toString());
    const r2 = await mig.restore_project(env.service, restore_opts(env, id, a.act.backup_dir));
    assert.equal(r2.cursor_epoch_before, (e0 + 1n).toString());
    assert.equal(r2.cursor_epoch_after, (e0 + 2n).toString());
    assert.equal(typeof r2.cursor_epoch_after, "string", "a decimal string, not a JSON number");

    for (const old of [e0, e0 + 1n]) {
      await assert.rejects(
        async () => assert_cursor_epoch(env.db, old),
        (error: unknown) => (error as { code?: string }).code === "cursor_epoch_stale",
      );
    }
    assert_cursor_epoch(env.db, e0 + 2n); // the current epoch is accepted
  });
});

test("cursor_epoch: a restore from a bundle made AFTER an earlier restore never goes backwards", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated_with_writes(env, legacy, mig, "epoch2");
    const id = a.imp.project_id;
    await mig.restore_project(env.service, restore_opts(env, id, a.act.backup_dir)); // epoch e0+1
    const later = backup_dir_of(env, "manual-after-restore");
    export_project(env.db, env.objects, id, later); // manifest epoch e0+1
    const now = cursor_epoch(env.db);
    const out = await mig.restore_project(env.service, restore_opts(env, id, later));
    assert.equal(BigInt(out.cursor_epoch_after), now + 1n);
    assert.ok(cursor_epoch(env.db) > now);
  });
});

// ---------------------------------------------------------------------------
// 5. CommandService.read is read only

const WRITE_STATEMENTS = [
  "UPDATE projects SET topic = 'x'",
  "UPDATE db_meta SET cursor_epoch = 99",
  "INSERT INTO users (id, display_name) VALUES ('u-x', 'x')",
  "REPLACE INTO users (id, display_name) VALUES ('u-y', 'y')",
  "DELETE FROM users",
  "DELETE FROM mutation_commits",
  "DROP TABLE users",
  "CREATE TABLE t_x (a)",
  "ALTER TABLE users ADD COLUMN zz TEXT",
  "PRAGMA query_only = OFF",
  "PRAGMA query_only = 0",
  "PRAGMA foreign_keys = OFF",
  "PRAGMA defer_foreign_keys = ON",
  "PRAGMA writable_schema = ON",
  "PRAGMA user_version = 7",
  "PRAGMA journal_mode = DELETE",
  "BEGIN",
  "BEGIN IMMEDIATE",
  "COMMIT",
  "END",
  "ROLLBACK",
  "SAVEPOINT s1",
  "RELEASE s1",
  "ATTACH DATABASE ':memory:' AS other",
  "DETACH DATABASE other",
  "VACUUM",
  "WITH x AS (SELECT 1) UPDATE projects SET topic = 'z'",
  "WITH x AS (SELECT 1) DELETE FROM users",
  "WITH x AS (SELECT 1) INSERT INTO users (id, display_name) VALUES ('u-z', 'z')",
  "SELECT 1; UPDATE projects SET topic = 'y'",
  "SELECT 1; SELECT 2",
  "/* note */ UPDATE projects SET topic = 'c'",
  "-- note\nUPDATE projects SET topic = 'c'",
  "  \n\t UPDATE projects SET topic = 'c'",
  "select 1 ; delete from users",
  "UPDATE projects SET topic = 'x' RETURNING id",
  "EXPLAIN UPDATE projects SET topic = 'x'",
  "",
  "   ",
];

test("CommandService.read: no write statement, pragma or transaction control gets through, and nothing changes", async () => {
  await with_migration(async (env) => {
    const before = state_signature(env.db);
    const qo = pragma_int(env.db, "query_only");
    for (const sql of WRITE_STATEMENTS) {
      assert.throws(
        () =>
          env.service.read((db) => {
            db.get(sql);
            db.all(sql);
          }),
        () => true,
        `refused: ${JSON.stringify(sql)}`,
      );
      assert.equal(state_signature(env.db), before, `unchanged after ${JSON.stringify(sql)}`);
      assert.equal(pragma_int(env.db, "query_only"), qo, `query_only restored after ${JSON.stringify(sql)}`);
      assert.equal(pragma_int(env.db, "foreign_keys"), 1n);
    }
    // the connection can write again right after the refusals
    env.db.run("UPDATE projects SET topic = ? WHERE id = ?", "다시 쓸 수 있다", env.p.project_id);
    assert.equal(topic_of(env, env.p.project_id), "다시 쓸 수 있다");
  });
});

test("CommandService.read: a SELECT works, and the handle's methods are the only way in (no db, run, exec, prepare)", async () => {
  await with_migration(async (env) => {
    const topic = env.service.read((db) => db.get<{ topic: string }>("SELECT topic FROM projects WHERE id = ?", env.p.project_id));
    assert.equal(topic?.topic, topic_of(env, env.p.project_id));
    const rows = env.service.read((db) => db.all("WITH x AS (SELECT 1 AS n) SELECT n FROM x"));
    assert.equal(rows.length, 1);
    env.service.read((handle) => {
      const keys = Object.keys(handle).sort();
      assert.deepEqual(keys, ["all", "get"]);
      assert.equal(Object.isFrozen(handle), true);
      assert.equal((handle as unknown as { run?: unknown }).run, undefined);
      assert.equal((handle as unknown as { exec?: unknown }).exec, undefined);
      assert.equal((handle as unknown as { prepare?: unknown }).prepare, undefined);
      assert.throws(() => {
        (handle as unknown as { run: (sql: string) => void }).run("UPDATE projects SET topic = 'x'");
      });
    });
  });
});

test("CommandService.read: a handle kept after read() returns is dead — also while a new read() is running, and after an error", async () => {
  await with_migration(async (env) => {
    const before = state_signature(env.db);
    const leaked = env.service.read((db) => db);
    assert.throws(() => leaked.get("SELECT 1"));
    assert.throws(() => leaked.all("SELECT 1"));
    // a second read() opens a NEW handle; the old one must stay dead even though query_only is on again
    env.service.read(() => {
      assert.throws(() => leaked.get("SELECT 1"));
    });
    // read() whose callback throws: handle dead, query_only back
    let leaked_on_error: { get: (sql: string) => unknown } | undefined;
    assert.throws(
      () =>
        env.service.read((db) => {
          leaked_on_error = db;
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.ok(leaked_on_error);
    assert.throws(() => leaked_on_error!.get("SELECT 1"));
    assert.equal(pragma_int(env.db, "query_only"), 0n);
    assert.equal(state_signature(env.db), before);
  });
});

test("CommandService.read: an async callback cannot use the handle after its first await, and cannot leave query_only on", async () => {
  await with_migration(async (env) => {
    const before = state_signature(env.db);
    const pending = env.service.read(async (db) => {
      await Promise.resolve();
      return db.get("SELECT 1 AS one");
    });
    await rejects_any(pending as unknown as Promise<unknown>);
    assert.equal(pragma_int(env.db, "query_only"), 0n, "query_only is restored when read() returns");
    assert.equal(state_signature(env.db), before);
    // and a normal write through the service still works afterwards
    await write_topic(env, env.p.project_id, "읽기 뒤 쓰기", "read-then-write");
    assert.equal(topic_of(env, env.p.project_id), "읽기 뒤 쓰기");
  });
});

test("CommandService.read: statement text and parameters of the wrong type are refused", async () => {
  await with_migration(async (env) => {
    env.service.read((db) => {
      for (const bad of [undefined, null, 1, {}, ["SELECT 1"], Symbol.for("x")]) {
        assert.throws(() => db.get(bad as unknown as string), () => true, `refused: ${String(bad)}`);
        assert.throws(() => db.all(bad as unknown as string));
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 6. state transitions

type StateName = "staging" | "validated" | "activated" | "activated_written" | "failed";
type CommandName = "validate" | "activate" | "rollback";

const MATRIX: Record<CommandName, Record<StateName, "ok" | "conflict">> = {
  validate: { staging: "ok", validated: "ok", activated: "conflict", activated_written: "conflict", failed: "conflict" },
  activate: { staging: "conflict", validated: "ok", activated: "conflict", activated_written: "conflict", failed: "conflict" },
  rollback: { staging: "ok", validated: "ok", activated: "ok", activated_written: "conflict", failed: "conflict" },
};

async function build_state(env: Env, legacy: LegacyApi, mig: MigrationApi, state: StateName) {
  switch (state) {
    case "staging": {
      const s = await stage(env, legacy);
      return { imp: s.imp, dir: s.dir };
    }
    case "validated": {
      const v = await validated(env, legacy, mig);
      return { imp: v.imp, dir: v.dir };
    }
    case "activated": {
      const v = await activated(env, legacy, mig, "full", "matrix-pre");
      return { imp: v.imp, dir: v.dir };
    }
    case "activated_written": {
      const v = await activated(env, legacy, mig, "full", "matrix-pre");
      await write_topic(env, v.imp.project_id, "행렬 쓰기", "matrix-w");
      return { imp: v.imp, dir: v.dir };
    }
    case "failed": {
      const v = await validated(env, legacy, mig);
      await mig.rollback_before_write(env.service, v.imp.batch_id, { owner_actor_id: owner_of(env) });
      return { imp: v.imp, dir: v.dir };
    }
  }
}

for (const command of Object.keys(MATRIX) as CommandName[]) {
  for (const state of Object.keys(MATRIX[command]) as StateName[]) {
    const expected = MATRIX[command][state];
    test(`transition: ${command} from ${state} -> ${expected}${expected === "conflict" ? " and leaves no trace" : ""}`, async () => {
      await with_migration(async (env, legacy, mig) => {
        const s = await build_state(env, legacy, mig, state);
        const before_db = state_signature(env.db);
        const before_files = fs_digest(env.objects);
        const backup = backup_dir_of(env, "matrix-attempt");
        const run = () => {
          if (command === "validate") {
            return mig.validate_import(env.service, s.imp.batch_id, { owner_actor_id: owner_of(env), source_dir: s.dir });
          }
          if (command === "activate") return mig.activate_import(env.service, s.imp.batch_id, activate_opts(env, backup));
          return mig.rollback_before_write(env.service, s.imp.batch_id, { owner_actor_id: owner_of(env) });
        };
        if (expected === "conflict") {
          await rejects_api(run(), "conflict");
          assert.equal(state_signature(env.db), before_db, "not one row, receipt or event was written");
          assert.deepEqual(fs_digest(env.objects), before_files);
          assert.equal(existsSync(backup), false, "no backup folder was created by a refused step");
        } else {
          await run();
          assert.notEqual(state_signature(env.db), before_db);
        }
      });
    });
  }
}

test("repeating a step: validate twice gives the same report; activate and rollback twice are refused the second time without a trace", async () => {
  await with_migration(async (env, legacy, mig) => {
    const s = await stage(env, legacy);
    const opts = { owner_actor_id: owner_of(env), source_dir: s.dir };
    const first = await mig.validate_import(env.service, s.imp.batch_id, opts);
    const second = await mig.validate_import(env.service, s.imp.batch_id, opts);
    assert.deepEqual(second.report, first.report);
    assert.equal(second.state, "validated");

    const act = await mig.activate_import(env.service, s.imp.batch_id, activate_opts(env, backup_dir_of(env, "rep-1")));
    const bundle_before = fs_digest(act.backup_dir);
    const sig = state_signature(env.db);
    await rejects_api(mig.activate_import(env.service, s.imp.batch_id, activate_opts(env, backup_dir_of(env, "rep-1"))), "conflict");
    await rejects_api(mig.activate_import(env.service, s.imp.batch_id, activate_opts(env, backup_dir_of(env, "rep-2"))), "conflict");
    assert.equal(state_signature(env.db), sig);
    assert.deepEqual(fs_digest(act.backup_dir), bundle_before, "the first backup was not overwritten");
    assert.equal(existsSync(backup_dir_of(env, "rep-2")), false);
    assert.equal(events_of(env.db, s.imp.project_id).filter((e) => e.type === "legacy.import_activated").length, 1);

    await mig.rollback_before_write(env.service, s.imp.batch_id, { owner_actor_id: owner_of(env) });
    const after_rollback = state_signature(env.db);
    await rejects_api(mig.rollback_before_write(env.service, s.imp.batch_id, { owner_actor_id: owner_of(env) }), "conflict");
    assert.equal(state_signature(env.db), after_rollback);
    assert.equal(events_of(env.db, s.imp.project_id).filter((e) => e.type === "legacy.import_rolled_back").length, 1);
  });
});

test("a project whose status does not match the batch (changed behind the batch's back) cannot be activated", async () => {
  for (const status of ["active", "archived"]) {
    await with_migration(async (env, legacy, mig) => {
      const v = await validated(env, legacy, mig);
      env.db.run("UPDATE projects SET status = ? WHERE id = ?", status, v.imp.project_id);
      const before = state_signature(env.db);
      await rejects_api(mig.activate_import(env.service, v.imp.batch_id, activate_opts(env, backup_dir_of(env, "status-x"))), "conflict");
      assert.equal(state_signature(env.db), before);
      assert.equal(existsSync(backup_dir_of(env, "status-x")), false);
    });
  }
});

test("a failed batch stays failed: validate / activate / rollback all refuse, and re-importing the source does not revive it", async () => {
  await with_migration(async (env, legacy, mig) => {
    const v = await validated(env, legacy, mig);
    await mig.rollback_before_write(env.service, v.imp.batch_id, { owner_actor_id: owner_of(env) });
    const before = state_signature(env.db);
    const again = await run_import(env, legacy, v.dir);
    assert.equal(again.state, "failed");
    assert.equal(again.batch_id, v.imp.batch_id);
    assert.equal(state_signature(env.db), before, "importing again wrote nothing");
    assert.equal(batch_row(env.db, v.imp.batch_id).state, "failed");
    assert.equal(project_status(env.db, v.imp.project_id), "archived");
  });
});

test("serving_path: only an active project is served from the database, every other status keeps the JSON path", async () => {
  await with_migration(async (env, legacy, mig) => {
    const v = await validated(env, legacy, mig);
    const id = v.imp.project_id;
    assert.equal(mig.serving_path(env.db, id), "legacy_json");
    await mig.activate_import(env.service, v.imp.batch_id, activate_opts(env, backup_dir_of(env, "serve")));
    assert.equal(mig.serving_path(env.db, id), "database");
    const before = state_signature(env.db);
    await rejects_api(Promise.resolve().then(() => mig.serving_path(env.db, "no-such-project")), "not_found");
    assert.equal(state_signature(env.db), before, "serving_path only reads");
  });
});

// ---------------------------------------------------------------------------
// 7. backup location rules

async function expect_location_refused(
  env: Env,
  legacy: LegacyApi,
  mig: MigrationApi,
  backup_dir: string,
  why: string,
): Promise<void> {
  const v = await validated(env, legacy, mig);
  const before = state_signature(env.db);
  const home_before = fs_digest(pes_home_of(env));
  await rejects_any(mig.activate_import(env.service, v.imp.batch_id, activate_opts(env, backup_dir)));
  assert.equal(state_signature(env.db), before, `${why}: the database is unchanged`);
  assert.equal(batch_row(env.db, v.imp.batch_id).state, "validated", `${why}: still validated`);
  assert.equal(project_status(env.db, v.imp.project_id), "staging", `${why}: still staging`);
  assert.deepEqual(fs_digest(pes_home_of(env)), home_before, `${why}: nothing written into the PES home`);
}

test("backup location: the PES home itself, a folder inside it, its parent and a ..-detour into it are all refused", async () => {
  const cases: Array<[string, (env: Env) => string]> = [
    ["pes_home itself", (env) => pes_home_of(env)],
    ["inside pes_home", (env) => join(pes_home_of(env), "bk")],
    ["deep inside pes_home", (env) => join(pes_home_of(env), "a", "b", "bk")],
    ["parent of pes_home", (env) => dirname(pes_home_of(env))],
    ["dotdot detour", (env) => join(pes_home_of(env), "..", "pes-projects", "bk")],
    ["inside the object store", (env) => join(env.objects, "bk")],
  ];
  for (const [why, pick] of cases) {
    await with_migration(async (env, legacy, mig) => {
      await expect_location_refused(env, legacy, mig, pick(env), why);
    });
  }
});

test("backup location: OneDrive folders in any spelling are refused", async () => {
  for (const segment of ["OneDrive", "onedrive", "ONEDRIVE", "OneDrive - Contoso", "OneDrive-Personal", "OneDrive_work"]) {
    await with_migration(async (env, legacy, mig) => {
      await expect_location_refused(env, legacy, mig, join(env.home.root, "elsewhere", segment, "bk"), segment);
    });
  }
});

test("backup location: a relative path is refused", async () => {
  await with_migration(async (env, legacy, mig) => {
    const v = await validated(env, legacy, mig);
    const before = state_signature(env.db);
    await rejects_api(
      mig.activate_import(env.service, v.imp.batch_id, { owner_actor_id: owner_of(env), backup_dir: "relative/bk", pes_home: pes_home_of(env) }),
      "invalid_payload",
    );
    await rejects_api(
      mig.activate_import(env.service, v.imp.batch_id, { owner_actor_id: owner_of(env), backup_dir: backup_dir_of(env, "ok"), pes_home: "pes-projects" }),
      "invalid_payload",
    );
    assert.equal(state_signature(env.db), before);
  });
});

test("backup location: a symlink that leads into the PES home cannot be used to hide the backup there", async () => {
  await with_migration(async (env, legacy, mig) => {
    mkdirSync(join(pes_home_of(env), "inner"), { recursive: true });
    const links = join(env.home.root, "links");
    mkdirSync(links, { recursive: true });
    symlinkSync(pes_home_of(env), join(links, "to-home"));
    await expect_location_refused(env, legacy, mig, join(links, "to-home", "bk"), "symlinked parent into pes_home");
  });
});

test("backup location: a symlink to a not-yet-existing folder inside the PES home (dangling) cannot be used either", async () => {
  await with_migration(async (env, legacy, mig) => {
    mkdirSync(pes_home_of(env), { recursive: true });
    const links = join(env.home.root, "links2");
    mkdirSync(links, { recursive: true });
    symlinkSync(join(pes_home_of(env), "not-yet"), join(links, "dangling"));
    await expect_location_refused(env, legacy, mig, join(links, "dangling"), "dangling symlink into pes_home");
    assert.equal(existsSync(join(pes_home_of(env), "not-yet")), false, "nothing was created through the link");
  });
});

test("backup location: a symlink whose real target is an OneDrive folder is refused", async () => {
  await with_migration(async (env, legacy, mig) => {
    const real = join(env.home.root, "elsewhere", "OneDrive - Test", "backups");
    mkdirSync(real, { recursive: true });
    const links = join(env.home.root, "links3");
    mkdirSync(links, { recursive: true });
    symlinkSync(real, join(links, "safe-looking"));
    await expect_location_refused(env, legacy, mig, join(links, "safe-looking", "bk"), "symlink to OneDrive");
    assert.deepEqual(readdirSync(real), [], "nothing was written into the OneDrive folder");
  });
});

test("backup location: a case-variant spelling of the PES home is the same folder on a case-insensitive disk and is refused", async () => {
  await with_migration(async (env, legacy, mig) => {
    mkdirSync(pes_home_of(env), { recursive: true });
    const upper = join(pes_home_of(env).toUpperCase(), "bk");
    if (!existsSync(dirname(upper))) return; // case-sensitive file system: a different folder, nothing to test
    await expect_location_refused(env, legacy, mig, upper, "upper-case spelling of pes_home");
  });
});

test("backup location: a sibling folder that merely starts with the PES home's name is allowed", async () => {
  await with_migration(async (env, legacy, mig) => {
    const v = await validated(env, legacy, mig);
    const sibling = `${pes_home_of(env)}-backup`;
    const out = await mig.activate_import(env.service, v.imp.batch_id, activate_opts(env, join(sibling, "bk")));
    assert.equal(out.state, "activated");
    assert.equal(verify_bundle(join(sibling, "bk")).ok, true);
  });
});

test("backup location: a non-empty existing folder is not overwritten and activation does not happen", async () => {
  await with_migration(async (env, legacy, mig) => {
    const v = await validated(env, legacy, mig);
    const target = backup_dir_of(env, "occupied");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "keep.txt"), "precious");
    const before = state_signature(env.db);
    await rejects_any(mig.activate_import(env.service, v.imp.batch_id, activate_opts(env, target)));
    assert.equal(state_signature(env.db), before);
    assert.equal(readFileSync(join(target, "keep.txt"), "utf8"), "precious");
    assert.deepEqual(readdirSync(target), ["keep.txt"]);
  });
});

test("the pre-activation backup of ONE project holds only that project and verifies", async () => {
  await with_migration(async (env, legacy, mig) => {
    await write_topic(env, env.p.project_id, "방관자의 비밀 주제", "bundle-only-bystander");
    const v = await validated(env, legacy, mig);
    const out = await mig.activate_import(env.service, v.imp.batch_id, activate_opts(env, backup_dir_of(env, "only-one")));
    assert.equal(verify_bundle(out.backup_dir).ok, true);
    const rows = readdirSync(out.backup_dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => readFileSync(join(entry.parentPath, entry.name)).toString("utf8"));
    assert.equal(rows.some((text) => text.includes(env.p.project_id)), false, "the bystander project id is nowhere in the bundle");
    assert.equal(rows.some((text) => text.includes("방관자의 비밀 주제")), false);
  });
});

// ---------------------------------------------------------------------------
// 8. the source folder does not change

for (const fixture of ["complete", "broken-parts"]) {
  test(`source folder (${fixture}): validate, activate, write, restore, rollback and refusals leave every file and folder stamp as it was`, async () => {
    await with_migration(async (env, legacy, mig) => {
      const dir = copy_fixture(env, fixture);
      const imp = await run_import(env, legacy, dir);
      age_tree(dir);
      const stamps = tree_stamps(dir);

      await mig.validate_import(env.service, imp.batch_id, { owner_actor_id: owner_of(env), source_dir: dir });
      // a second, wrong source: the validation reports it and still does not touch either folder
      const other = copy_fixture(env, "full");
      age_tree(other);
      const other_stamps = tree_stamps(other);
      const wrong = await mig.validate_import(env.service, imp.batch_id, { owner_actor_id: owner_of(env), source_dir: other });
      assert.equal(wrong.ok, false);
      assert.deepEqual(tree_stamps(other), other_stamps);

      const batch = batch_row(env.db, imp.batch_id);
      if (batch.state === "validated") {
        const act = await mig.activate_import(env.service, imp.batch_id, activate_opts(env, backup_dir_of(env, `src-${fixture}`)));
        await write_topic(env, imp.project_id, "원본 불변 쓰기", `src-${fixture}-w`);
        await mig.restore_project(env.service, restore_opts(env, imp.project_id, act.backup_dir));
        await mig.rollback_before_write(env.service, imp.batch_id, { owner_actor_id: owner_of(env) });
      } else {
        await mig.rollback_before_write(env.service, imp.batch_id, { owner_actor_id: owner_of(env) });
      }
      assert.deepEqual(tree_stamps(dir), stamps, "no file, folder, size or mtime of the source changed");
    });
  });
}

test("refused steps (non-owner agent, unknown batch) never create a backup folder or touch the objects", async () => {
  await with_migration(async (env, legacy, mig) => {
    const v = await validated(env, legacy, mig);
    const agent = add_agent(env);
    const files_of_project = fs_digest(join(env.objects, v.imp.project_id));
    await rejects_api(mig.activate_import(env.service, v.imp.batch_id, { ...activate_opts(env, backup_dir_of(env, "agent-bk")), owner_actor_id: agent }), "forbidden");
    await rejects_api(mig.activate_import(env.service, "no-such-batch", activate_opts(env, backup_dir_of(env, "nb"))), "not_found");
    const other = await second_project(env, "synthetic-other-owner");
    await rejects_api(
      mig.activate_import(env.service, v.imp.batch_id, { ...activate_opts(env, backup_dir_of(env, "other-bk")), owner_actor_id: other.actor_id }),
      "forbidden",
    );
    // second_project wrote its own rows; compare only the imported project's world
    assert.equal(batch_row(env.db, v.imp.batch_id).state, "validated");
    assert.equal(existsSync(backup_dir_of(env, "agent-bk")), false);
    assert.equal(existsSync(backup_dir_of(env, "other-bk")), false);
    assert.equal(existsSync(backup_dir_of(env, "nb")), false);
    assert.deepEqual(fs_digest(join(env.objects, v.imp.project_id)), files_of_project);
  });
});

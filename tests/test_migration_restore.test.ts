// SEL-45 (stage 2 PR12): activation, rollback before the first write, project restore after writes.
// Interface under test: scripts/pes_core/migration.ts (see tests/helpers/migration_env.ts for the
// exact signatures). Everything is synthetic: fixtures in tests/fixtures/legacy/, one copy per test
// inside an isolated HOME/PES_HOME. Nothing reads or writes the real ~/.pes or ~/pes-projects.
//
// Completion conditions of the issue ("PR12: 이전 검증·되돌리기") covered here:
//   1  copy -> staging -> validated -> activated applies to ONE project only
//   2  the source folder does not change (hash, mtime, no new file)
//   3  before the first new write: reconnect to the source JSON (rollback_before_write);
//      after a new write: restore the project (DB + object files) from the PR3 bundle
//   4  other projects are not affected (rows and object files)
//   5  the restore tells the loss scope (writes after the bundle) and resets cursors (cursor_epoch + 1)
//   7  no real pilot: nothing outside the isolated home is used
//
// State table (import_batches.state uses only the schema values staging|validated|activated|failed;
// projects.status uses staging|active|archived):
//
//   command                      from batch state              result batch / project
//   validate_import (clean)      staging, validated            validated / staging
//   validate_import (mismatch)   staging, validated            unchanged (no throw, ok=false, problems)
//   activate_import              validated                     activated / active
//   rollback_before_write        staging|validated|activated   failed / archived   (activated only if no write yet)
//   restore_project              activated (with writes)       back to the bundle: validated / staging
//   anything else                                              ApiError "conflict", nothing changes

import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assert_cursor_epoch, verify_bundle } from "../scripts/pes_core/backup.ts";
import {
  activated,
  add_agent,
  age_tree,
  backup_dir_of,
  batch_row,
  blob_by_name,
  bystander_signature,
  copy_fixture,
  cursor_epoch,
  domain_counts,
  events_of,
  instance_id,
  object_files,
  other_human,
  owner_of,
  pes_home_of,
  project_status,
  rejects_any,
  rejects_api,
  run_import,
  stage,
  state_signature,
  table_counts,
  tree_digest,
  tree_entries,
  tree_stamps,
  validated,
  with_migration,
  write_topic,
  type Env,
} from "./helpers/migration_env.ts";
import { disk_path } from "./helpers/blob_env.ts";
import { project_row } from "./helpers/legacy_env.ts";

function topic_of(env: Env, project_id: string): string {
  return project_row(env.db, project_id).topic;
}

// ---------------------------------------------------------------------------
// 1 + 4: one project only

test("validate -> activate changes only the imported project; other projects and global settings stay identical", async () => {
  await with_migration(async (env, legacy, mig) => {
    const bystander = env.p.project_id;
    const other = await stage(env, legacy, "complete"); // a second imported project that stays in staging
    const by_before = bystander_signature(env, bystander);
    const other_before = bystander_signature(env, other.imp.project_id);
    const other_batch = batch_row(env.db, other.imp.batch_id);
    const meta = { instance: instance_id(env.db), epoch: cursor_epoch(env.db) };

    const target = await activated(env, legacy, mig, "full");

    assert.equal(project_status(env.db, target.imp.project_id), "active");
    assert.equal(batch_row(env.db, target.imp.batch_id).state, "activated");
    assert.ok(project_row(env.db, target.imp.project_id).active_edition_id !== null, "the active edition is set");
    assert.equal(mig.serving_path(env.db, target.imp.project_id), "database");

    // the bystander, the other staged import and the global settings did not move
    assert.deepEqual(bystander_signature(env, bystander), by_before);
    assert.deepEqual(bystander_signature(env, other.imp.project_id), other_before);
    assert.deepEqual(batch_row(env.db, other.imp.batch_id), other_batch);
    assert.equal(project_status(env.db, other.imp.project_id), "staging");
    assert.equal(mig.serving_path(env.db, other.imp.project_id), "legacy_json");
    assert.equal(instance_id(env.db), meta.instance);
    assert.equal(cursor_epoch(env.db), meta.epoch, "activating is not a restore: cursors stay valid");
  });
});

test("activate_import writes a verified pre-activation backup of that project into backup_dir, then flips the state", async () => {
  await with_migration(async (env, legacy, mig) => {
    const v = await validated(env, legacy, mig);
    const pre = project_row(env.db, v.imp.project_id);
    const backup_dir = backup_dir_of(env, "b1");
    const act = await mig.activate_import(env.service, v.imp.batch_id, {
      owner_actor_id: owner_of(env),
      backup_dir,
      pes_home: pes_home_of(env),
    });
    assert.equal(act.backup_dir, backup_dir);
    assert.equal(verify_bundle(backup_dir).ok, true, "the backup is a valid PR3 bundle");
    const manifest = JSON.parse(readFileSync(join(backup_dir, "manifest.json"), "utf8")) as {
      project_id: string;
      table_counts: Record<string, number>;
    };
    assert.equal(manifest.project_id, v.imp.project_id, "the bundle is of the imported project only");
    // the bundle shows the state BEFORE activation (batch validated / project staging)
    const rows = JSON.parse(readFileSync(join(backup_dir, "rows", "project.json"), "utf8")) as {
      tables: Array<{ name: string; columns: Array<{ name: string }>; rows: unknown[][] }>;
    };
    const batches = rows.tables.find((t) => t.name === "import_batches");
    assert.ok(batches, "import_batches is in the bundle");
    const state_col = batches.columns.findIndex((c) => c.name === "state");
    assert.deepEqual(batches.rows.map((r) => r[state_col]), ["validated"]);
    const projects = rows.tables.find((t) => t.name === "projects");
    assert.ok(projects);
    const status_col = projects.columns.findIndex((c) => c.name === "status");
    assert.deepEqual(projects.rows.map((r) => r[status_col]), [pre.status]);
    // the events recorded the activation
    const types = events_of(env.db, v.imp.project_id).map((e) => e.type);
    assert.ok(types.includes("legacy.import_activated"));
  });
});

test("activate_import refuses a backup_dir inside the PES home or an OneDrive folder; nothing is written and the batch stays validated", async () => {
  await with_migration(async (env, legacy, mig) => {
    const v = await validated(env, legacy, mig);
    const before = state_signature(env.db);
    const bad = [
      join(pes_home_of(env), "backups", "b"), // inside the PES home (project folders)
      join(env.home.root, "home", "OneDrive", "pes-backup"), // a synced folder
      join(pes_home_of(env), "synthetic-project", "b"),
    ];
    for (const backup_dir of bad) {
      await rejects_any(
        mig.activate_import(env.service, v.imp.batch_id, {
          owner_actor_id: owner_of(env),
          backup_dir,
          pes_home: pes_home_of(env),
        }),
      );
      assert.equal(existsSync(backup_dir), false, `no bundle was written to ${backup_dir}`);
    }
    assert.equal(state_signature(env.db), before, "a refused activation leaves the whole database untouched");
    assert.equal(batch_row(env.db, v.imp.batch_id).state, "validated");
    assert.equal(project_status(env.db, v.imp.project_id), "staging");
  });
});

test("a failed backup (backup_dir already holds a file) keeps the batch validated and the project staging", async () => {
  await with_migration(async (env, legacy, mig) => {
    const v = await validated(env, legacy, mig);
    const backup_dir = backup_dir_of(env, "occupied");
    // a file where the bundle folder must go
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(backup_dir, ".."), { recursive: true });
    writeFileSync(backup_dir, "not a folder", "utf8");
    const before = state_signature(env.db);
    await rejects_any(
      mig.activate_import(env.service, v.imp.batch_id, {
        owner_actor_id: owner_of(env),
        backup_dir,
        pes_home: pes_home_of(env),
      }),
    );
    assert.equal(state_signature(env.db), before);
    assert.equal(batch_row(env.db, v.imp.batch_id).state, "validated");
  });
});

// ---------------------------------------------------------------------------
// 2: the source folder never changes

test("the source folder is identical (hash, mtime, no new file) after validate, activate, writes, restore and rollback", async () => {
  await with_migration(async (env, legacy, mig) => {
    const dir = copy_fixture(env, "full");
    age_tree(dir);
    const digest = tree_digest(dir);
    const stamps = tree_stamps(dir);
    const files = tree_entries(dir).map((entry) => entry.path);

    const imp = await run_import(env, legacy, dir);
    const check = (where: string): void => {
      assert.equal(tree_digest(dir), digest, `content unchanged ${where}`);
      assert.deepEqual(tree_stamps(dir), stamps, `mtimes and folders unchanged ${where}`);
      assert.deepEqual(tree_entries(dir).map((e) => e.path), files, `no new or missing file ${where}`);
    };
    check("after import");
    const val = await mig.validate_import(env.service, imp.batch_id, { owner_actor_id: owner_of(env), source_dir: dir });
    assert.equal(val.ok, true);
    check("after validate_import");
    const act = await mig.activate_import(env.service, imp.batch_id, {
      owner_actor_id: owner_of(env),
      backup_dir: backup_dir_of(env, "src-check"),
      pes_home: pes_home_of(env),
    });
    check("after activate_import");
    await write_topic(env, imp.project_id, "원본은 그대로", "src-w1");
    check("after a new write");
    await mig.restore_project(env.service, {
      owner_actor_id: owner_of(env),
      project_id: imp.project_id,
      bundle_dir: act.backup_dir,
    });
    check("after restore_project");
    await mig.rollback_before_write(env.service, imp.batch_id, { owner_actor_id: owner_of(env) });
    check("after rollback_before_write");
  });
});

// ---------------------------------------------------------------------------
// 3a: before the first write -> reconnect to the source JSON

for (const stop_at of ["staging", "validated", "activated"] as const) {
  test(`rollback_before_write from ${stop_at}: batch failed, project archived, the old JSON path serves again, others untouched`, async () => {
    await with_migration(async (env, legacy, mig) => {
      const bystander = env.p.project_id;
      const by_before = bystander_signature(env, bystander);
      const meta = { instance: instance_id(env.db), epoch: cursor_epoch(env.db) };

      let ids: { batch_id: string; project_id: string };
      let dir: string;
      if (stop_at === "staging") {
        const s = await stage(env, legacy);
        ids = s.imp;
        dir = s.dir;
      } else if (stop_at === "validated") {
        const v = await validated(env, legacy, mig);
        ids = v.imp;
        dir = v.dir;
      } else {
        const a = await activated(env, legacy, mig);
        ids = a.imp;
        dir = a.dir;
        assert.equal(mig.serving_path(env.db, ids.project_id), "database");
      }
      const digest = tree_digest(dir);

      const out = await mig.rollback_before_write(env.service, ids.batch_id, { owner_actor_id: owner_of(env) });

      assert.equal(out.state, "failed");
      assert.equal(out.from_state, stop_at);
      assert.equal(out.serving, "legacy_json");
      assert.equal(batch_row(env.db, ids.batch_id).state, "failed");
      assert.equal(project_status(env.db, ids.project_id), "archived");
      assert.equal(mig.serving_path(env.db, ids.project_id), "legacy_json");
      assert.equal(
        env.db.get("SELECT 1 AS x FROM projects WHERE id = ? AND active_edition_id IS NOT NULL AND status = 'active'", ids.project_id),
        undefined,
        "no active project is left for this source",
      );
      const events = events_of(env.db, ids.project_id).filter((e) => e.type === "legacy.import_rolled_back");
      assert.equal(events.length, 1, "the rollback is recorded as an event");
      assert.equal(events[0]!.payload.from_state, stop_at);
      // the evidence stays: staging rows and mappings are archived, not deleted
      assert.ok(env.db.all("SELECT 1 FROM legacy_mappings WHERE import_batch_id = ?", ids.batch_id).length > 0);

      assert.equal(tree_digest(dir), digest, "the source folder is untouched");
      assert.deepEqual(bystander_signature(env, bystander), by_before);
      assert.equal(instance_id(env.db), meta.instance);
      assert.equal(cursor_epoch(env.db), meta.epoch, "a rollback before any write needs no cursor reset");
    });
  });
}

test("rollback_before_write is refused once the activated project has a new write; restore_project is the way back", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated(env, legacy, mig);
    await write_topic(env, a.imp.project_id, "첫 새 쓰기", "rb-w1");
    const before = state_signature(env.db);
    const error = await rejects_api(
      mig.rollback_before_write(env.service, a.imp.batch_id, { owner_actor_id: owner_of(env) }),
      "conflict",
    );
    assert.match(error.message, /restore/i, "the message points to restore_project");
    assert.equal(state_signature(env.db), before, "nothing changed");
    assert.equal(batch_row(env.db, a.imp.batch_id).state, "activated");
    assert.equal(project_status(env.db, a.imp.project_id), "active");
  });
});

test("rollback_before_write cannot be applied twice, and a failed batch cannot be validated or activated again", async () => {
  await with_migration(async (env, legacy, mig) => {
    const s = await stage(env, legacy);
    await mig.rollback_before_write(env.service, s.imp.batch_id, { owner_actor_id: owner_of(env) });
    const before = state_signature(env.db);
    await rejects_api(mig.rollback_before_write(env.service, s.imp.batch_id, { owner_actor_id: owner_of(env) }), "conflict");
    await rejects_api(
      mig.validate_import(env.service, s.imp.batch_id, { owner_actor_id: owner_of(env), source_dir: s.dir }),
      "conflict",
    );
    await rejects_api(
      mig.activate_import(env.service, s.imp.batch_id, {
        owner_actor_id: owner_of(env),
        backup_dir: backup_dir_of(env, "never"),
        pes_home: pes_home_of(env),
      }),
      "conflict",
    );
    assert.equal(state_signature(env.db), before);
  });
});

test("importing the same unchanged source again after a rollback returns the failed batch and writes nothing new", async () => {
  await with_migration(async (env, legacy, mig) => {
    const s = await stage(env, legacy);
    await mig.rollback_before_write(env.service, s.imp.batch_id, { owner_actor_id: owner_of(env) });
    const counts = table_counts(env.db);
    const again = await run_import(env, legacy, s.dir);
    assert.equal(again.replayed, true);
    assert.equal(again.batch_id, s.imp.batch_id);
    assert.equal(again.state, "failed", "the rolled-back batch is not silently revived");
    assert.deepEqual(table_counts(env.db), counts);
    assert.equal(project_status(env.db, s.imp.project_id), "archived");
  });
});

// ---------------------------------------------------------------------------
// 3b + 5: after a write -> restore the project; tell the loss and reset cursors

test("restore_project after writes: the project goes back to its pre-activation state, others stay, the loss and the cursor reset are reported", async () => {
  await with_migration(async (env, legacy, mig) => {
    const bystander = env.p.project_id;
    const v = await validated(env, legacy, mig);
    const id = v.imp.project_id;
    const original_topic = topic_of(env, id);
    const files_at_bundle = object_files(env, id);
    const act = await mig.activate_import(env.service, v.imp.batch_id, {
      owner_actor_id: owner_of(env),
      backup_dir: backup_dir_of(env, "restore-main"),
      pes_home: pes_home_of(env),
    });
    const a = { imp: v.imp, act };

    // two real business writes after activation
    await write_topic(env, id, "활성화 뒤 첫 쓰기", "rs-w1");
    await write_topic(env, id, "활성화 뒤 둘째 쓰기", "rs-w2");
    assert.equal(topic_of(env, id), "활성화 뒤 둘째 쓰기");
    const by_before = bystander_signature(env, bystander);
    const epoch_before = cursor_epoch(env.db);
    const instance = instance_id(env.db);

    const out = await mig.restore_project(env.service, {
      owner_actor_id: owner_of(env),
      project_id: id,
      bundle_dir: a.act.backup_dir,
    });

    // back to the state at the bundle (the batch was validated and the project staging then)
    assert.equal(topic_of(env, id), original_topic);
    assert.equal(project_status(env.db, id), "staging");
    assert.equal(batch_row(env.db, a.imp.batch_id).state, "validated");
    assert.equal(mig.serving_path(env.db, id), "legacy_json", "the old JSON path serves the project until it is activated again");
    assert.deepEqual(object_files(env, id), files_at_bundle, "the object files are exactly those of the bundle");

    // loss scope
    assert.deepEqual(out.lost_writes.map((w) => w.action), ["project.topic_set", "project.topic_set"]);
    assert.deepEqual(out.reverted_steps, ["legacy.activate_import"]);
    assert.equal(out.project_id, id);

    // cursors
    assert.equal(out.cursor_epoch_before, epoch_before.toString());
    assert.equal(out.cursor_epoch_after, (epoch_before + 1n).toString());
    assert.equal(cursor_epoch(env.db), epoch_before + 1n);
    assert.equal(instance_id(env.db), instance, "the database identity is kept");
    await assert.rejects(
      async () => assert_cursor_epoch(env.db, epoch_before),
      (error: unknown) => (error as { code?: string }).code === "cursor_epoch_stale",
      "a cursor from before the restore is stale",
    );

    // the event survives the restore and says what was lost
    const event = events_of(env.db, id).filter((e) => e.type === "legacy.project_restored");
    assert.equal(event.length, 1);
    assert.equal(event[0]!.payload.lost_writes, 2);
    assert.equal(event[0]!.payload.cursor_epoch, (epoch_before + 1n).toString());

    // others
    assert.deepEqual(bystander_signature(env, bystander), by_before, "the other project is untouched");
  });
});

test("restore_project keeps the same rows as before activation (counts per table), not a mix of old and new", async () => {
  await with_migration(async (env, legacy, mig) => {
    const v = await validated(env, legacy, mig);
    const id = v.imp.project_id;
    const counts = domain_counts(env.db, id);
    const batch = batch_row(env.db, v.imp.batch_id);
    const act = await mig.activate_import(env.service, v.imp.batch_id, {
      owner_actor_id: owner_of(env),
      backup_dir: backup_dir_of(env, "counts"),
      pes_home: pes_home_of(env),
    });
    await write_topic(env, id, "되돌릴 쓰기", "rc-w1");
    await mig.restore_project(env.service, { owner_actor_id: owner_of(env), project_id: id, bundle_dir: act.backup_dir });
    assert.deepEqual(domain_counts(env.db, id), counts);
    assert.deepEqual(batch_row(env.db, v.imp.batch_id), batch);
  });
});

test("restore_project with no writes after the bundle: empty loss list, but the cursors are still reset", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated(env, legacy, mig);
    const epoch = cursor_epoch(env.db);
    const out = await mig.restore_project(env.service, {
      owner_actor_id: owner_of(env),
      project_id: a.imp.project_id,
      bundle_dir: a.act.backup_dir,
    });
    assert.deepEqual(out.lost_writes, []);
    assert.deepEqual(out.reverted_steps, ["legacy.activate_import"]);
    assert.equal(cursor_epoch(env.db), epoch + 1n);
  });
});

test("restore_project repairs object files: a deleted and a damaged blob file come back from the bundle", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated(env, legacy, mig);
    const id = a.imp.project_id;
    const shot = blob_by_name(env, id, "shot-1.png");
    const report = blob_by_name(env, id, "report.md");
    const original_shot = readFileSync(disk_path(env, shot));
    const original_report = readFileSync(disk_path(env, report));
    rmSync(disk_path(env, shot));
    writeFileSync(disk_path(env, report), "damaged", "utf8");
    await write_topic(env, id, "손상 뒤 쓰기", "ro-w1");

    await mig.restore_project(env.service, { owner_actor_id: owner_of(env), project_id: id, bundle_dir: a.act.backup_dir });

    assert.deepEqual(readFileSync(disk_path(env, shot)), original_shot, "the deleted file is back");
    assert.deepEqual(readFileSync(disk_path(env, report)), original_report, "the damaged file has its bytes back");
  });
});

// ---------------------------------------------------------------------------
// 4: only this project is restored

test("restore_project of one project leaves another imported project and the bystander byte-identical", async () => {
  await with_migration(async (env, legacy, mig) => {
    const bystander = env.p.project_id;
    const a = await activated(env, legacy, mig, "full", "full-b");
    const c = await activated(env, legacy, mig, "complete", "complete-b");
    await write_topic(env, a.imp.project_id, "A 쓰기", "rp-a1");
    await write_topic(env, c.imp.project_id, "C 쓰기", "rp-c1");

    const by_before = bystander_signature(env, bystander);
    const c_before = bystander_signature(env, c.imp.project_id);
    const c_topic = topic_of(env, c.imp.project_id);

    await mig.restore_project(env.service, {
      owner_actor_id: owner_of(env),
      project_id: a.imp.project_id,
      bundle_dir: a.act.backup_dir,
    });

    assert.deepEqual(bystander_signature(env, bystander), by_before);
    assert.deepEqual(bystander_signature(env, c.imp.project_id), c_before, "C keeps its own later write");
    assert.equal(topic_of(env, c.imp.project_id), c_topic);
    assert.equal(project_status(env.db, c.imp.project_id), "active");
    assert.equal(batch_row(env.db, c.imp.batch_id).state, "activated");
  });
});

// ---------------------------------------------------------------------------
// restore refusals: nothing changes

test("restore_project refuses a bundle of another project, a damaged bundle, and a missing bundle without changing anything", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated(env, legacy, mig, "full", "ra");
    const c = await activated(env, legacy, mig, "complete", "rc");
    await write_topic(env, a.imp.project_id, "쓰기", "rr-w1");
    const before = state_signature(env.db);
    const files = object_files(env, a.imp.project_id);

    // a bundle of project C used for project A
    await rejects_any(
      mig.restore_project(env.service, {
        owner_actor_id: owner_of(env),
        project_id: a.imp.project_id,
        bundle_dir: c.act.backup_dir,
      }),
    );
    // a missing bundle folder
    await rejects_any(
      mig.restore_project(env.service, {
        owner_actor_id: owner_of(env),
        project_id: a.imp.project_id,
        bundle_dir: backup_dir_of(env, "no-such-bundle"),
      }),
    );
    // a damaged bundle: one object file is overwritten (PR3 verify_bundle reports hash_mismatch)
    const damaged = tree_entries(a.act.backup_dir).find((entry) => entry.path.startsWith("objects/"));
    assert.ok(damaged, "the bundle holds object files");
    writeFileSync(join(a.act.backup_dir, ...damaged.path.split("/")), "tampered", "utf8");
    assert.equal(verify_bundle(a.act.backup_dir).ok, false);
    await rejects_any(
      mig.restore_project(env.service, {
        owner_actor_id: owner_of(env),
        project_id: a.imp.project_id,
        bundle_dir: a.act.backup_dir,
      }),
    );

    assert.equal(state_signature(env.db), before, "all-or-nothing: the database is exactly as before");
    assert.deepEqual(object_files(env, a.imp.project_id), files, "the object files are exactly as before");
    assert.equal(topic_of(env, a.imp.project_id), "쓰기");
  });
});

test("restore_project is for the human owner only (agent, legacy actor, another project's human, unknown actor)", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated(env, legacy, mig);
    await write_topic(env, a.imp.project_id, "쓰기", "rf-w1");
    const stranger = await other_human(env);
    const agent = add_agent(env);
    env.db.run("INSERT INTO actors (id, kind, user_id, display_name) VALUES ('legacy-y', 'legacy_unknown', NULL, '옛 작성자')");
    const before = state_signature(env.db);
    for (const actor of [agent, "legacy-y", stranger.actor_id, "no-such-actor"]) {
      await rejects_api(
        mig.restore_project(env.service, { owner_actor_id: actor, project_id: a.imp.project_id, bundle_dir: a.act.backup_dir }),
        "forbidden",
        "not_found",
      );
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("activate_import and rollback_before_write are for the human owner only", async () => {
  await with_migration(async (env, legacy, mig) => {
    const v = await validated(env, legacy, mig);
    const stranger = await other_human(env);
    const agent = add_agent(env);
    const before = state_signature(env.db);
    for (const actor of [agent, stranger.actor_id, "no-such-actor"]) {
      await rejects_api(
        mig.activate_import(env.service, v.imp.batch_id, {
          owner_actor_id: actor,
          backup_dir: backup_dir_of(env, "nope"),
          pes_home: pes_home_of(env),
        }),
        "forbidden",
        "not_found",
      );
      await rejects_api(
        mig.rollback_before_write(env.service, v.imp.batch_id, { owner_actor_id: actor }),
        "forbidden",
        "not_found",
      );
    }
    assert.equal(state_signature(env.db), before);
    assert.equal(existsSync(backup_dir_of(env, "nope")), false);
  });
});

// ---------------------------------------------------------------------------
// 7: no real pilot, no real home

test("the migration module never reaches for the real home, the process environment or a real project folder", async () => {
  const source = readFileSync(new URL("../scripts/pes_core/migration.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /homedir\s*\(/, "no os.homedir()");
  assert.doesNotMatch(source, /process\.env/, "no process.env: paths come from arguments");
  assert.doesNotMatch(source, /pes-projects/, "no hard-coded project folder");
  assert.doesNotMatch(source, /["'`]~\//, "no ~/ path");
});

test("every path a migration call returns or creates stays inside the isolated test home", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated(env, legacy, mig);
    assert.ok(a.act.backup_dir.startsWith(env.home.root), "the backup bundle is inside the isolated home");
    assert.ok(existsSync(join(env.home.root, "home", ".pes", "pes.db")), "the database is the isolated one");
    assert.equal(env.home.env.HOME, join(env.home.root, "home"));
    assert.equal(env.home.env.PES_HOME, join(env.home.root, "pes-projects"));
  });
});

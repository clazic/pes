// SEL-45 (stage 2 PR12) regression tests for the first review (logs/SEL-45-r1-1.md, leader decision
// in the ledger 'SEL-45 r1 CHANGES'). Synthetic fixtures only (tests/fixtures/legacy/), one copy per
// test in an isolated HOME/PES_HOME. Nothing reads or writes the real ~/.pes or ~/pes-projects.
//
//  R1  after activation only users/actors rows changed (display name, disabled_at): restore still
//      succeeds and those rows stay exactly as they are now (they are not compared or replaced)
//  R2  the rows are committed but a file swap fails: ApiError conflict whose details carry
//      rows_restored, failed_files, lost_writes, cursor_epoch_before/after; the restore event keeps
//      lost_writes; unblocking and restoring the same bundle again puts the files right
//  S1  a business write on the staging project after validate: activate is a conflict
//      (validate again), after a new validate it works
//  S4a the database holds a blob / a submission that the plan does not: validate reports `counts`
//  S4b the regenerated reports carry the "provisional format" mark. KEY CHOSEN BY THESE TESTS:
//      `report.regeneration_format === "provisional"` (on ValidationReport, next to
//      `regenerated_reports`); PR16 replaces the generator and may then drop or change the value.
//  S5  (removed — see the note at the S5 section)
//  S6  importing an already validated / activated source again: the replayed answer shows the
//      CURRENT batch state

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { ApiError } from "../scripts/pes_core/errors.ts";
import type { Db } from "../scripts/pes_core/db.ts";
import {
  activated,
  backup_dir_of,
  batch_row,
  events_of,
  has_problem,
  owner_of,
  pes_home_of,
  project_status,
  rejects_api,
  run_import,
  stage,
  state_signature,
  validated,
  write_topic,
  with_migration,
  cursor_epoch,
  type Env,
  type MigrationApi,
  type ValidateResult,
} from "./helpers/migration_env.ts";
import { wrap_db } from "./helpers/blob_env.ts";

// ---------------------------------------------------------------------------
// helpers

async function validate(env: Env, mig: MigrationApi, batch_id: string, source_dir: string): Promise<ValidateResult> {
  return mig.validate_import(env.service, batch_id, { owner_actor_id: owner_of(env), source_dir });
}

function activate_opts(env: Env, backup_name: string) {
  return { owner_actor_id: owner_of(env), backup_dir: backup_dir_of(env, backup_name), pes_home: pes_home_of(env) };
}

function restore_opts(env: Env, project_id: string, bundle_dir: string) {
  return { owner_actor_id: owner_of(env), project_id, bundle_dir };
}

/** Relative key ("<project_id>/...") of every object file in a bundle. */
function bundle_keys(bundle_dir: string, project_id: string): string[] {
  const root = join(bundle_dir, "objects");
  return readdirSync(join(root, project_id), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1).replace(/\\/g, "/"))
    .sort();
}

function users_and_actors(db: Db): string {
  const replacer = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? `${v.toString()}n` : v);
  return JSON.stringify(
    {
      users: db.all("SELECT * FROM users ORDER BY id"),
      actors: db.all("SELECT * FROM actors ORDER BY id"),
    },
    replacer,
  );
}

// ---------------------------------------------------------------------------
// R1

test("R1 restore after activation succeeds when only users/actors rows changed (display name, disabled_at), and those rows stay as they are now", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated(env, legacy, mig, "full", "r1-users");
    const id = a.imp.project_id;
    await write_topic(env, id, "R1 활성화 뒤 쓰기", "r1-w1");

    // The everyday changes that happen between the backup and a restore.
    env.db.run("UPDATE users SET display_name = display_name || ' (이름 바꿈)'");
    env.db.run(
      "UPDATE actors SET disabled_at = 1700000000000, display_name = display_name || ' (바꿈)' WHERE id <> ?",
      owner_of(env),
    );
    const changed = users_and_actors(env.db);

    const out = await mig.restore_project(env.service, restore_opts(env, id, a.act.backup_dir));

    assert.equal(out.project_id, id);
    assert.equal(out.lost_writes.length, 1, "the one business write after the bundle is reported as lost");
    assert.equal(
      users_and_actors(env.db),
      changed,
      "users and actors are neither compared nor replaced: the current rows stay exactly as they are",
    );
    assert.equal(env.db.all("PRAGMA foreign_key_check").length, 0);
  });
});

// ---------------------------------------------------------------------------
// R2

test("R2 a file swap that fails after the commit: conflict with rows_restored, failed_files, lost_writes and the cursor epochs; the event keeps lost_writes; restoring again fixes the file", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated(env, legacy, mig, "full", "r2-rename");
    const id = a.imp.project_id;
    await write_topic(env, id, "R2 첫 쓰기", "r2-w1");
    await write_topic(env, id, "R2 둘째 쓰기", "r2-w2");

    const keys = bundle_keys(a.act.backup_dir, id);
    assert.ok(keys.length >= 1, "the bundle holds object files");
    const target = join(env.objects, ...keys[0]!.split("/"));
    const original = readFileSync(join(a.act.backup_dir, "objects", ...keys[0]!.split("/")));
    // Damaged on disk, so the restore has to swap exactly this file in.
    writeFileSync(target, "damaged-by-test");

    // Seam: right after the restore transaction COMMITs (rows are final, the file swap has not started),
    // the file's path becomes a folder. Renaming a file onto a non-empty folder fails on every platform.
    let armed = false;
    let fired = 0;
    const base = wrap_db(env.db, () => undefined);
    const blocking = env.with_db({
      ...base,
      exec: (sql: string) => {
        env.db.exec(sql);
        if (armed && sql.trim().toUpperCase() === "COMMIT") {
          armed = false;
          fired += 1;
          rmSync(target, { force: true });
          mkdirSync(target);
          writeFileSync(join(target, "blocker"), "x");
        }
      },
    });

    const epoch_before = cursor_epoch(env.db);
    armed = true;
    const error = await rejects_api(mig.restore_project(blocking, restore_opts(env, id, a.act.backup_dir)), "conflict");
    armed = false;
    assert.equal(fired, 1, "the seam fired once, right after the commit");

    // The rows really were restored (the commit happened) ...
    assert.equal(cursor_epoch(env.db), epoch_before + 1n);
    const details = error.details as Record<string, unknown> | undefined;
    assert.ok(details && typeof details === "object", "the conflict carries details");
    assert.equal(details.rows_restored, true);
    assert.ok(Array.isArray(details.failed_files) && details.failed_files.length >= 1, "the failed file(s) are listed");
    assert.ok(Array.isArray(details.lost_writes), "the lost writes are reported even though the swap failed");
    assert.equal((details.lost_writes as unknown[]).length, 2, "both business writes after the bundle");
    assert.equal(details.cursor_epoch_before, epoch_before.toString());
    assert.equal(details.cursor_epoch_after, (epoch_before + 1n).toString());

    // ... and the restore event keeps the loss, too.
    const event = events_of(env.db, id).filter((e) => e.type === "legacy.project_restored");
    assert.equal(event.length, 1);
    assert.equal(event[0]!.payload.lost_writes, 2);
    assert.equal(event[0]!.payload.cursor_epoch, (epoch_before + 1n).toString());

    // The blocked path is still in the way: nothing pretends the file was fixed.
    assert.ok(lstatSync(target).isDirectory());

    // Remove the blocker and restore the same bundle again: the file comes back right.
    rmSync(target, { recursive: true, force: true });
    const again = await mig.restore_project(env.service, restore_opts(env, id, a.act.backup_dir));
    assert.equal(again.project_id, id);
    assert.ok(lstatSync(target).isFile());
    assert.deepEqual(readFileSync(target), original, "the file has the bundle's bytes again");
  });
});

// ---------------------------------------------------------------------------
// S1

test("S1 a business write on the staging project after validate: activate is a conflict and changes nothing; after a new validate it works", async () => {
  await with_migration(async (env, legacy, mig) => {
    const v = await validated(env, legacy, mig, "full");
    const id = v.imp.project_id;
    await write_topic(env, id, "검증 뒤 staging 쓰기", "s1-w1");

    const before = state_signature(env.db);
    const target = backup_dir_of(env, "s1-denied");
    await rejects_api(
      mig.activate_import(env.service, v.imp.batch_id, {
        owner_actor_id: owner_of(env),
        backup_dir: target,
        pes_home: pes_home_of(env),
      }),
      "conflict",
    );
    assert.equal(state_signature(env.db), before, "a refused activation leaves no trace");
    assert.equal(existsSync(target), false, "and no backup folder");
    assert.equal(project_status(env.db, id), "staging");
    assert.equal(batch_row(env.db, v.imp.batch_id).state, "validated");

    // Validate again (the database now differs from what was checked): activation works.
    const again = await validate(env, mig, v.imp.batch_id, v.dir);
    assert.equal(again.ok, true, JSON.stringify(again.report.problems));
    const act = await mig.activate_import(env.service, v.imp.batch_id, activate_opts(env, "s1-ok"));
    assert.equal(act.state, "activated");
    assert.equal(project_status(env.db, id), "active");
  });
});

// ---------------------------------------------------------------------------
// S4a

test("S4a a blob the plan does not have is reported as a counts problem; the batch stays staging", async () => {
  await with_migration(async (env, legacy, mig) => {
    const s = await stage(env, legacy, "full");
    const id = s.imp.project_id;
    // A real file with matching bytes, so the only thing wrong is that the plan does not know this blob.
    const bytes = Buffer.from("abc");
    writeFileSync(join(env.objects, id, "synthetic-extra-blob"), bytes);
    env.db.run(
      `INSERT INTO blobs (id, project_id, storage_key, sha256, size, media_type, original_name, state, created_by)
       VALUES ('synthetic-extra-blob', ?, ?, ?, 3, 'text/plain', 'extra.txt', 'ready', ?)`,
      id,
      `${id}/synthetic-extra-blob`,
      createHash("sha256").update(bytes).digest("hex"),
      owner_of(env),
    );
    const out = await validate(env, mig, s.imp.batch_id, s.dir);
    assert.equal(out.ok, false);
    assert.equal(out.state, "staging");
    assert.ok(has_problem(out.report, "counts"), JSON.stringify(out.report.problems));
    assert.equal(batch_row(env.db, s.imp.batch_id).state, "staging");
  });
});

test("S4a a submission the plan does not have is reported as a counts problem; the batch stays staging", async () => {
  await with_migration(async (env, legacy, mig) => {
    const s = await stage(env, legacy, "full");
    const id = s.imp.project_id;
    const commit = env.db.get<{ id: string }>("SELECT id FROM mutation_commits WHERE project_id = ? ORDER BY rowid LIMIT 1", id);
    assert.ok(commit, "the import left a receipt to point the extra submission at");
    env.db.run(
      "INSERT INTO submissions (id, project_id, actor_id, via, tx_id) VALUES ('synthetic-extra-submission', ?, ?, 'import', ?)",
      id,
      owner_of(env),
      commit.id,
    );
    const out = await validate(env, mig, s.imp.batch_id, s.dir);
    assert.equal(out.ok, false);
    assert.equal(out.state, "staging");
    assert.ok(has_problem(out.report, "counts"), JSON.stringify(out.report.problems));
    assert.equal(batch_row(env.db, s.imp.batch_id).state, "staging");
  });
});

// ---------------------------------------------------------------------------
// S4b

test("S4b the report regeneration result is marked as a provisional format (until PR16 brings the real generator)", async () => {
  await with_migration(async (env, legacy, mig) => {
    const s = await stage(env, legacy, "full");
    const out = await validate(env, mig, s.imp.batch_id, s.dir);
    assert.ok(out.report.regenerated_reports.length >= 1);
    const mark = (out.report as unknown as Record<string, unknown>).regeneration_format;
    assert.equal(mark, "provisional", "report.regeneration_format tells the reader these comparisons are not final");
  });
});

// ---------------------------------------------------------------------------
// S5 (removed by leader): the service only knows objects_dir, which has no fixed relation to the PES home
// (stage-2 2.7), so it cannot tell a right pes_home from a wrong one. The calling layer (PR14 API / CLI) must fill
// pes_home from its settings; docs/plan/stage-2-db-guarantees.md 8.10 says so.

// S6

test("S6 importing the same source again reports the batch's CURRENT state (validated, then activated)", async () => {
  await with_migration(async (env, legacy, mig) => {
    const v = await validated(env, legacy, mig, "full");

    const when_validated = await run_import(env, legacy, v.dir);
    assert.equal(when_validated.replayed, true);
    assert.equal(when_validated.batch_id, v.imp.batch_id);
    assert.equal(when_validated.project_id, v.imp.project_id);
    assert.equal(when_validated.state as string, "validated");

    await mig.activate_import(env.service, v.imp.batch_id, activate_opts(env, "s6-act"));
    const before = state_signature(env.db);
    const when_activated = await run_import(env, legacy, v.dir);
    assert.equal(when_activated.replayed, true);
    assert.equal(when_activated.state as string, "activated");
    assert.equal(state_signature(env.db), before, "the replay writes nothing");
  });
});

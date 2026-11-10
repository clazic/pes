// SEL-45 (stage 2 PR12) regression tests for the final review 1/2 (logs/SEL-45-final-review-1.md).
// Synthetic fixtures only (tests/fixtures/legacy/), one copy per test in an isolated HOME/PES_HOME.
// Nothing reads or writes the real ~/.pes or ~/pes-projects.
//
//  F1  validate_import compares the LINKS with the plan, not only that the target row exists:
//      (a) a thread's target object/version changed to another object/version of the project
//      (b) an answer's question / question version changed to another question/version
//          (validate: `links` problem, batch stays staging; activate is refused)
//      (c) a message's thread, a round_contents row, a question set member, a next_round_task target
//  F2  object bytes are checked against the blobs row (sha256 + size), not only against the manifest
//      (a) a file overwritten after validate: activate is refused, nothing changes
//      (b) a bundle whose manifest and files agree but differ from the blobs row: restore is refused,
//          database, files and cursor are unchanged
//  S1  a restore that cannot remove an entry outside the bundle is NOT a success: ApiError conflict whose
//      details carry rows_restored and failed_files (the file's storage key)
//
// The state changes use a deferred-foreign-key transaction (PRAGMA defer_foreign_keys) so the changed
// rows still satisfy every foreign key: `PRAGMA foreign_key_check` stays empty, as in the review.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { verify_bundle } from "../scripts/pes_core/backup.ts";
import { ApiError } from "../scripts/pes_core/errors.ts";
import {
  activated,
  backup_dir_of,
  batch_row,
  blob_by_name,
  copy_fixture,
  cursor_epoch,
  disk_path,
  has_problem,
  object_files,
  owner_of,
  pes_home_of,
  project_status,
  rejects_any,
  rejects_api,
  run_import,
  state_signature,
  validated,
  with_migration,
  write_topic,
  type Env,
  type MigrationApi,
  type ValidateResult,
} from "./helpers/migration_env.ts";
import type { LegacyApi } from "./helpers/legacy_env.ts";

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

/** One transaction that may leave foreign keys unchecked until COMMIT, then verifies they hold. */
function tamper(env: Env, change: () => void): void {
  env.db.exec("BEGIN");
  try {
    env.db.exec("PRAGMA defer_foreign_keys = ON");
    change();
    env.db.exec("COMMIT");
  } catch (error) {
    env.db.exec("ROLLBACK");
    throw error;
  }
  assert.equal(env.db.all("PRAGMA foreign_key_check").length, 0, "the tampered state satisfies every foreign key");
}

type Id = { object_id: string; version_id: string };

/** A version of an artifact object of the project, other than the given objects. */
function other_artifact(env: Env, project_id: string, not_objects: string[]): Id {
  const rows = env.db.all<{ object_id: string; version_id: string }>(
    "SELECT object_id, version_id FROM artifact_versions WHERE project_id = ? ORDER BY object_id, version_id",
    project_id,
  );
  const found = rows.find((row) => !not_objects.includes(row.object_id));
  assert.ok(found, "the project has another artifact version to point at");
  return found;
}

/** Validation must fail with a `links` problem and leave the batch in staging. */
async function assert_links_problem(
  env: Env,
  mig: MigrationApi,
  batch_id: string,
  dir: string,
  what: string,
): Promise<ValidateResult> {
  const out = await validate(env, mig, batch_id, dir);
  assert.equal(out.ok, false, `${what}: validate_import rejects it`);
  assert.equal(out.state, "staging", `${what}: the batch stays staging`);
  assert.ok(has_problem(out.report, "links"), `${what}: a links problem is reported: ${JSON.stringify(out.report.problems)}`);
  assert.equal(batch_row(env.db, batch_id).state, "staging", `${what}: the stored batch state is staging`);
  return out;
}

// ---------------------------------------------------------------------------
// F1a threads

for (const [label, which] of [
  ["general thread", "general"],
  ["question_comment thread", "question_comment"],
] as const) {
  test(`F1a a ${label}'s target object and version changed to another object/version of the project: links problem, staging`, async () => {
    await with_migration(async (env, legacy, mig) => {
      const s = await (async () => {
        const dir = copy_fixture(env, "full");
        const imp = await run_import(env, legacy, dir);
        return { dir, imp };
      })();
      const id = s.imp.project_id;
      const thread = env.db.get<{ object_id: string; target_object_id: string }>(
        "SELECT object_id, target_object_id FROM threads WHERE project_id = ? AND context_kind = ?",
        id,
        which,
      );
      assert.ok(thread, `the fixture has a ${which} thread`);
      const target = other_artifact(env, id, [thread.target_object_id]);
      tamper(env, () => {
        env.db.run(
          "UPDATE threads SET target_object_id = ?, target_version_id = ? WHERE project_id = ? AND object_id = ?",
          target.object_id,
          target.version_id,
          id,
          thread.object_id,
        );
      });
      await assert_links_problem(env, mig, s.imp.batch_id, s.dir, `${label} target`);
    });
  });
}

// ---------------------------------------------------------------------------
// F1b answers

test("F1b an answer's question and question version changed to another question: links problem, staging, and activation is refused", async () => {
  await with_migration(async (env, legacy, mig) => {
    const dir = copy_fixture(env, "full");
    const imp = await run_import(env, legacy, dir);
    const id = imp.project_id;
    const answer = env.db.get<{ object_id: string; question_id: string }>(
      "SELECT object_id, question_id FROM answers WHERE project_id = ? ORDER BY object_id LIMIT 1",
      id,
    );
    assert.ok(answer, "the fixture has an answer");
    const other = env.db.get<{ object_id: string; version_id: string }>(
      "SELECT object_id, version_id FROM question_versions WHERE project_id = ? AND object_id <> ? ORDER BY object_id, version_id LIMIT 1",
      id,
      answer.question_id,
    );
    assert.ok(other, "the fixture has another question to point at");

    tamper(env, () => {
      env.db.run(
        "UPDATE answers SET question_id = ? WHERE project_id = ? AND object_id = ?",
        other.object_id,
        id,
        answer.object_id,
      );
      env.db.run(
        "UPDATE answer_versions SET question_id = ?, question_version_id = ? WHERE project_id = ? AND object_id = ?",
        other.object_id,
        other.version_id,
        id,
        answer.object_id,
      );
    });
    await assert_links_problem(env, mig, imp.batch_id, dir, "answer question");

    // The refused batch cannot be activated, and the refusal leaves no trace.
    const before = state_signature(env.db);
    const target = backup_dir_of(env, "f1b-denied");
    await rejects_any(
      mig.activate_import(env.service, imp.batch_id, {
        owner_actor_id: owner_of(env),
        backup_dir: target,
        pes_home: pes_home_of(env),
      }),
    );
    assert.equal(state_signature(env.db), before, "a refused activation leaves no trace");
    assert.equal(existsSync(target), false, "and no backup folder");
    assert.equal(project_status(env.db, id), "staging");
    assert.equal(batch_row(env.db, imp.batch_id).state, "staging");
  });
});

// ---------------------------------------------------------------------------
// F1c messages, round contents, set members, next-round tasks

test("F1c a message moved to another thread: links problem, staging", async () => {
  await with_migration(async (env, legacy, mig) => {
    const dir = copy_fixture(env, "full");
    const imp = await run_import(env, legacy, dir);
    const id = imp.project_id;
    const message = env.db.get<{ object_id: string; thread_id: string }>(
      "SELECT object_id, thread_id FROM messages WHERE project_id = ? ORDER BY object_id LIMIT 1",
      id,
    );
    assert.ok(message, "the fixture has a message");
    const other_thread = env.db.get<{ object_id: string }>(
      "SELECT object_id FROM threads WHERE project_id = ? AND object_id <> ? LIMIT 1",
      id,
      message.thread_id,
    );
    assert.ok(other_thread, "the fixture has another thread");
    tamper(env, () => {
      env.db.run(
        "UPDATE messages SET thread_id = ? WHERE project_id = ? AND object_id = ?",
        other_thread.object_id,
        id,
        message.object_id,
      );
      env.db.run(
        "UPDATE message_versions SET thread_id = ? WHERE project_id = ? AND object_id = ?",
        other_thread.object_id,
        id,
        message.object_id,
      );
    });
    await assert_links_problem(env, mig, imp.batch_id, dir, "message thread");
  });
});

/** The `full` fixture with a snapshot in the form that carries items: the import then writes round_contents. */
async function stage_with_round_contents(env: Env, legacy: LegacyApi) {
  const dir = copy_fixture(env, "full");
  const path = join(dir, "snapshots", "plan-R1.json");
  const old = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const project = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as {
    stages: { plan: { items: Array<Record<string, unknown>> } };
  };
  const items = project.stages.plan.items.map((item) => ({ ...item }));
  writeFileSync(path, JSON.stringify({ ...old, time: "2026-01-05 10:00", state: { status: "active", round: 1, items } }));
  const imp = await run_import(env, legacy, dir);
  assert.equal(imp.state, "staging");
  const rows = env.db.all<{ round_id: string; object_id: string; version_id: string }>(
    "SELECT round_id, object_id, version_id FROM round_contents WHERE project_id = ? ORDER BY round_id, position",
    imp.project_id,
  );
  assert.ok(rows.length >= 1, "the snapshot fixture writes round_contents rows");
  return { dir, imp, rows };
}

test("F1c a round_contents row pointing at another object/version (same round): links problem, staging", async () => {
  await with_migration(async (env, legacy, mig) => {
    const { dir, imp, rows } = await stage_with_round_contents(env, legacy);
    const id = imp.project_id;
    const row = rows[0]!;
    const target = other_artifact(env, id, rows.map((r) => r.object_id));
    tamper(env, () => {
      env.db.run(
        "UPDATE round_contents SET object_id = ?, version_id = ? WHERE project_id = ? AND round_id = ? AND object_id = ?",
        target.object_id,
        target.version_id,
        id,
        row.round_id,
        row.object_id,
      );
    });
    await assert_links_problem(env, mig, imp.batch_id, dir, "round_contents object");
  });
});

test("F1c a round_contents row moved to another round: links problem, staging", async () => {
  await with_migration(async (env, legacy, mig) => {
    const { dir, imp, rows } = await stage_with_round_contents(env, legacy);
    const id = imp.project_id;
    const row = rows[0]!;
    const other_round = env.db.get<{ id: string }>(
      "SELECT id FROM rounds WHERE project_id = ? AND id <> ? ORDER BY id LIMIT 1",
      id,
      row.round_id,
    );
    assert.ok(other_round, "the project has another round");
    tamper(env, () => {
      env.db.run(
        "UPDATE round_contents SET round_id = ? WHERE project_id = ? AND round_id = ? AND object_id = ?",
        other_round.id,
        id,
        row.round_id,
        row.object_id,
      );
    });
    await assert_links_problem(env, mig, imp.batch_id, dir, "round_contents round");
  });
});

test("F1c a question set member pointing at another question/version: links problem, staging", async () => {
  await with_migration(async (env, legacy, mig) => {
    const dir = copy_fixture(env, "full");
    const imp = await run_import(env, legacy, dir);
    const id = imp.project_id;
    const members = env.db.all<{ set_id: string; question_id: string }>(
      "SELECT set_id, question_id FROM question_set_members WHERE project_id = ? ORDER BY set_id, position",
      id,
    );
    assert.ok(members.length >= 1, "the fixture has a question set with members");
    const member = members[0]!;
    const other = env.db.get<{ object_id: string; version_id: string }>(
      `SELECT object_id, version_id FROM question_versions
        WHERE project_id = ? AND object_id NOT IN (SELECT question_id FROM question_set_members WHERE project_id = ? AND set_id = ?)
        ORDER BY object_id, version_id LIMIT 1`,
      id,
      id,
      member.set_id,
    );
    assert.ok(other, "a question outside the set exists");
    tamper(env, () => {
      env.db.run(
        "UPDATE question_set_members SET question_id = ?, question_version_id = ? WHERE project_id = ? AND set_id = ? AND question_id = ?",
        other.object_id,
        other.version_id,
        id,
        member.set_id,
        member.question_id,
      );
    });
    await assert_links_problem(env, mig, imp.batch_id, dir, "question set member");
  });
});

test("F1c a next_round_task whose target stage was changed to another stage: links problem, staging", async () => {
  await with_migration(async (env, legacy, mig) => {
    const dir = copy_fixture(env, "full");
    const imp = await run_import(env, legacy, dir);
    const id = imp.project_id;
    const task = env.db.get<{ version_id: string; target_stage_id: string }>(
      "SELECT version_id, target_stage_id FROM followup_versions WHERE project_id = ? AND kind = 'next_round_task' ORDER BY version_id LIMIT 1",
      id,
    );
    assert.ok(task, "the fixture has a next_round_task");
    const stage = env.db.get<{ id: string }>(
      "SELECT id FROM stages WHERE project_id = ? AND id <> ? ORDER BY id LIMIT 1",
      id,
      task.target_stage_id,
    );
    assert.ok(stage, "the project has another stage");
    tamper(env, () => {
      env.db.run(
        "UPDATE followup_versions SET target_stage_id = ? WHERE project_id = ? AND version_id = ?",
        stage.id,
        id,
        task.version_id,
      );
    });
    await assert_links_problem(env, mig, imp.batch_id, dir, "next_round_task target");
  });
});

// ---------------------------------------------------------------------------
// F2a: a file overwritten after validate

test("F2a an object file overwritten with other bytes after validate: activation is refused and nothing changes", async () => {
  await with_migration(async (env, legacy, mig) => {
    const v = await validated(env, legacy, mig, "full");
    const id = v.imp.project_id;
    const blob = blob_by_name(env, id, "shot-1.png");
    const path = disk_path(env, blob);
    const other = Buffer.from("synthetic other bytes, not the shot");
    assert.notEqual(other.byteLength, blob.size, "the replacement differs in size too");
    writeFileSync(path, other);

    const rows_before = state_signature(env.db);
    const files_before = object_files(env, id);
    const target = backup_dir_of(env, "f2a-denied");
    await rejects_any(mig.activate_import(env.service, v.imp.batch_id, activate_opts(env, "f2a-denied")));

    assert.equal(state_signature(env.db), rows_before, "a refused activation leaves no trace in the database");
    assert.deepEqual(object_files(env, id), files_before, "and no file is touched");
    assert.deepEqual(readFileSync(path), other, "the file keeps the bytes it has now (nothing pretends it was fixed)");
    assert.equal(existsSync(target), false, "and no backup folder");
    assert.equal(batch_row(env.db, v.imp.batch_id).state, "validated");
    assert.equal(project_status(env.db, id), "staging");
  });
});

test("F2a the same size but different bytes (hash only differs) is refused too", async () => {
  await with_migration(async (env, legacy, mig) => {
    const v = await validated(env, legacy, mig, "full");
    const id = v.imp.project_id;
    const blob = blob_by_name(env, id, "shot-1.png");
    const path = disk_path(env, blob);
    const bytes = Buffer.from(readFileSync(path));
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    writeFileSync(path, bytes);

    const before = state_signature(env.db);
    await rejects_any(mig.activate_import(env.service, v.imp.batch_id, activate_opts(env, "f2a-same-size")));
    assert.equal(state_signature(env.db), before);
    assert.equal(batch_row(env.db, v.imp.batch_id).state, "validated");
    assert.equal(existsSync(backup_dir_of(env, "f2a-same-size")), false);
  });
});

// ---------------------------------------------------------------------------
// F2b: a bundle whose manifest and files agree but differ from the blobs row

/**
 * Copy a good bundle and replace one object file with other bytes, rewriting the manifest entry
 * (sha256 + size) so manifest and file agree. The blobs row in the bundle's rows still has the
 * original sha256 and size.
 */
function forge_consistent_bundle(good: string, forged: string, storage_key: string, bytes: Uint8Array): void {
  cpSync(good, forged, { recursive: true });
  const file = join(forged, "objects", ...storage_key.split("/"));
  writeFileSync(file, bytes);
  const manifest_path = join(forged, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifest_path, "utf8")) as {
    files: Array<{ path: string; sha256: string; size: number }>;
  };
  const entry = manifest.files.find((f) => f.path === `objects/${storage_key}`);
  assert.ok(entry, `the manifest lists objects/${storage_key}`);
  entry.sha256 = createHash("sha256").update(bytes).digest("hex");
  entry.size = bytes.byteLength;
  writeFileSync(manifest_path, JSON.stringify(manifest, null, 2));
}

test("F2b a bundle whose manifest and files agree but differ from the blobs row: restore is refused; database, files and cursor are unchanged", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated(env, legacy, mig, "full", "f2b-good");
    const id = a.imp.project_id;
    await write_topic(env, id, "F2b 활성화 뒤 쓰기", "f2b-w1");
    const blob = blob_by_name(env, id, "shot-1.png");

    const forged = join(env.home.root, "forged-bundle");
    forge_consistent_bundle(a.act.backup_dir, forged, blob.storage_key, Buffer.from("synthetic forged bytes"));
    // Precondition: the forgery is invisible to the manifest-only check (that is the point of the test).
    assert.equal(verify_bundle(forged).ok, true, "manifest and files agree");

    const rows_before = state_signature(env.db);
    const files_before = object_files(env, id);
    const epoch_before = cursor_epoch(env.db);
    await rejects_any(mig.restore_project(env.service, restore_opts(env, id, forged)));

    assert.equal(state_signature(env.db), rows_before, "the database is unchanged");
    assert.deepEqual(object_files(env, id), files_before, "the object files are unchanged");
    assert.equal(cursor_epoch(env.db), epoch_before, "the cursor epoch is unchanged");
    assert.equal(env.db.all("PRAGMA foreign_key_check").length, 0);

    // The good bundle still restores.
    const ok = await mig.restore_project(env.service, restore_opts(env, id, a.act.backup_dir));
    assert.equal(ok.project_id, id);
  });
});

test("F2b a bundle whose object has the right size but other bytes (blobs row hash differs) is refused", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated(env, legacy, mig, "full", "f2b-good2");
    const id = a.imp.project_id;
    await write_topic(env, id, "F2b 둘째 쓰기", "f2b-w2");
    const blob = blob_by_name(env, id, "shot-1.png");
    const original = readFileSync(join(a.act.backup_dir, "objects", ...blob.storage_key.split("/")));
    const flipped = Buffer.from(original);
    flipped[0] = flipped[0]! ^ 0xff;

    const forged = join(env.home.root, "forged-bundle-2");
    forge_consistent_bundle(a.act.backup_dir, forged, blob.storage_key, flipped);
    assert.equal(verify_bundle(forged).ok, true);

    const rows_before = state_signature(env.db);
    const files_before = object_files(env, id);
    const epoch_before = cursor_epoch(env.db);
    await rejects_any(mig.restore_project(env.service, restore_opts(env, id, forged)));
    assert.equal(state_signature(env.db), rows_before);
    assert.deepEqual(object_files(env, id), files_before);
    assert.equal(cursor_epoch(env.db), epoch_before);
  });
});

// ---------------------------------------------------------------------------
// S1: a restore that cannot remove a file outside the bundle

test("S1 an entry outside the bundle that cannot be removed: conflict with rows_restored and its storage key in failed_files (not a success)", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated(env, legacy, mig, "full", "s1-extra");
    const id = a.imp.project_id;
    await write_topic(env, id, "S1 활성화 뒤 쓰기", "s1-w1");

    // Platform independent block: the place of a leftover file is a NON-EMPTY FOLDER of the same name,
    // so unlinking it fails on every OS (EISDIR / EPERM). The bundle has nothing at this key.
    const extra = join(env.objects, id, "synthetic-extra.bin");
    const extra_key = `${id}/synthetic-extra.bin`;
    mkdirSync(extra, { recursive: true });
    writeFileSync(join(extra, "inner"), "synthetic leftover");
    try {
      const epoch_before = cursor_epoch(env.db);
      const error = await rejects_api(mig.restore_project(env.service, restore_opts(env, id, a.act.backup_dir)), "conflict");
      const details = error.details as Record<string, unknown> | undefined;
      assert.ok(details && typeof details === "object", "the conflict carries details");
      assert.equal(details.rows_restored, true, "the rows were restored (the commit happened)");
      assert.ok(Array.isArray(details.failed_files), "failed_files is a list");
      assert.ok((details.failed_files as unknown[]).includes(extra_key), `failed_files names ${extra_key}: ${JSON.stringify(details.failed_files)}`);
      assert.equal(details.cursor_epoch_before, epoch_before.toString());
      assert.equal(details.cursor_epoch_after, (epoch_before + 1n).toString());
      assert.ok(Array.isArray(details.lost_writes) && (details.lost_writes as unknown[]).length === 1);
      assert.ok(existsSync(extra), "the entry is still there: nothing pretends it was removed");
    } finally {
      rmSync(extra, { recursive: true, force: true });
    }
  });
});

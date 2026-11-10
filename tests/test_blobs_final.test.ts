// SEL-42 (stage 2 PR9) final-review regression tests. Synthetic bytes only; every test runs in a
// temporary HOME/PES_HOME (tests/helpers/blob_env.ts). Decisions under test (leader, final review 1):
//   required) A gc that has committed must not delete the file of a blob that became ready in the
//             meantime (a second connection to the same DB and the same objects folder). The
//             orphan-file loop re-checks for a row right before each unlink as well.
//   recovery) A ready blob whose file is gone takes the reserved bytes again via store_blob (same
//             sha256 and size only), after which get_blob works.
//   rec. 1)   The gc grace period counts from the LAST reservation of a blob.
//   rec. 2)   A second CommandService on one DB with a different objects folder throws at creation.
//   rec. 5a)  "Linked" for gc and quarantine means referenced by ANY table that points at blobs.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { FakeClock } from "../scripts/pes_core/clock.ts";
import { CommandService, type CommandOutcome } from "../scripts/pes_core/commands.ts";
import { connect, type Db, type SqlValue } from "../scripts/pes_core/db.ts";
import { ApiError } from "../scripts/pes_core/errors.ts";
import {
  complete_upload,
  gc_orphans,
  get_blob,
  quarantine,
  reserve_upload,
  store_blob,
} from "../scripts/pes_core/files.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { sha256_hex } from "./helpers/backup_fixture.ts";
import {
  MEDIA_TYPE,
  blob_row,
  blob_row_must,
  bytes_of,
  complete,
  ctx_for,
  disk_path,
  exists_on_disk,
  plant_bytes,
  put_ready,
  put_staging,
  reserve,
  rejects_any,
  with_env,
  type CompleteResult,
  type Env,
  type GcResult,
  type ReserveResult,
} from "./helpers/blob_env.ts";

const GRACE = 3_600_000;

function set_mtime(path: string, ms: number): void {
  utimesSync(path, ms / 1000, ms / 1000);
}

function must_be_api_error(error: unknown): ApiError {
  assert.ok(error instanceof ApiError, `expected an ApiError, got ${String(error)}`);
  return error;
}

// ---------------------------------------------------------------------------
// required: gc vs. a second connection

interface Second {
  db: Db;
  service: CommandService;
  store: { db: Db; objects_dir: string };
  close(): void;
}

function second_connection(env: Env): Second {
  const db = connect(db_path(env.home.env));
  const service = new CommandService(db, { clock: env.clock, policy: env.policy, objects_dir: env.objects });
  return { db, service, store: { db, objects_dir: env.objects }, close: () => db.close() };
}

async function ready_through(second: Second, env: Env, bytes: Uint8Array, key: string): Promise<string> {
  const out = await reserve_upload(second.service, ctx_for(env.p, `${key}-r`), {
    sha256: sha256_hex(bytes),
    size: bytes.byteLength,
    media_type: MEDIA_TYPE,
    original_name: "합성.bin",
  });
  const r = out.result as ReserveResult;
  assert.equal(r.state, "staging", "the stale row is gone, so this is a fresh reservation");
  await store_blob(second.store, env.p.project_id, r.blob_id, bytes);
  const done = (await complete_upload(second.service, second.store, ctx_for(env.p, `${key}-c`), {
    blob_id: r.blob_id,
  })).result as CompleteResult;
  assert.equal(done.state, "ready");
  return r.blob_id;
}

test("gc commit, then another connection makes the same bytes ready: the new blob's file survives", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("final-race", 24);
    const stale = await put_staging(env, bytes, "race");
    const stale_path = disk_path(env, blob_row_must(env.db, stale.blob_id));
    await quarantine(env.service, env.ctx("race-q"), { blob_id: stale.blob_id, reason: "synthetic" });
    env.clock.advance(10 * GRACE);

    const second = second_connection(env);
    try {
      let new_blob_id: string | null = null;
      const original = env.service.execute.bind(env.service);
      env.service.execute = (async (ctx, command, payload) => {
        const out = await original(ctx, command, payload);
        if (command === "file.gc_orphans" && new_blob_id === null) {
          // The gc transaction is committed; the wrapper has not yet touched the disk.
          new_blob_id = await ready_through(second, env, bytes, "race-b");
        }
        return out;
      }) as typeof env.service.execute;

      const out = (await gc_orphans(env.service, env.store, env.ctx("race-gc"), { grace_ms: GRACE }))
        .result as GcResult;
      assert.deepEqual(out.deleted_blob_ids, [stale.blob_id], "the stale row itself was collected");
      assert.ok(new_blob_id !== null, "the second connection ran");
      assert.equal(blob_row_must(env.db, new_blob_id).state, "ready");
      assert.equal(blob_row(env.db, stale.blob_id), undefined);

      assert.ok(existsSync(stale_path), "the file now belongs to a ready blob and must not be deleted");
      const read = await get_blob(env.store, env.p.project_id, new_blob_id);
      assert.deepEqual(Array.from(read.bytes), Array.from(bytes));
    } finally {
      second.close();
    }
  });
});

test("a plain gc still deletes the file of the row it collected (control)", async () => {
  await with_env(async (env) => {
    const stale = await put_staging(env, bytes_of("final-control", 8), "ctl");
    const path = disk_path(env, blob_row_must(env.db, stale.blob_id));
    env.clock.advance(10 * GRACE);
    const out = (await gc_orphans(env.service, env.store, env.ctx("ctl-gc"), { grace_ms: GRACE })).result as GcResult;
    assert.deepEqual(out.deleted_blob_ids, [stale.blob_id]);
    assert.equal(existsSync(path), false);
  });
});

test("the orphan-file loop does not delete a file whose row appeared after the claimed set was read", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("final-orphan-race", 12);
    const sha = sha256_hex(bytes);
    const storage_key = `${env.p.project_id}/${sha}`;
    // A file without any row, old enough to be a collectable orphan.
    const path = plant_bytes(env, { storage_key }, bytes);
    env.clock.advance(10 * GRACE);
    set_mtime(path, env.clock.now_ms() - 10 * GRACE);

    // After the command returns, the wrapper reads the claimed set once. Right after that read a
    // row for the same storage_key appears (a concurrent reserve), before the wrapper unlinks.
    const db = env.db;
    const original_all = db.all.bind(db);
    const original_run = db.run.bind(db);
    let armed = false;
    let inserted = false;
    const original_exec = env.service.execute.bind(env.service);
    env.service.execute = (async (ctx, command, payload) => {
      const out: CommandOutcome = await original_exec(ctx, command, payload);
      if (command === "file.gc_orphans") armed = true;
      return out;
    }) as typeof env.service.execute;
    db.all = (<T>(sql: string, ...params: SqlValue[]): T[] => {
      const rows = original_all<T>(sql, ...params);
      if (armed && !inserted && sql.includes("SELECT storage_key FROM blobs")) {
        inserted = true;
        original_run(
          `INSERT INTO blobs (id, project_id, storage_key, sha256, size, media_type, original_name, state, created_by)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 'staging', ?)`,
          "final-orphan-late-row",
          env.p.project_id,
          storage_key,
          sha,
          bytes.byteLength,
          MEDIA_TYPE,
          env.p.actor_id,
        );
      }
      return rows;
    }) as typeof db.all;

    try {
      await gc_orphans(env.service, env.store, env.ctx("orf-gc"), { grace_ms: GRACE });
    } finally {
      db.all = original_all;
    }
    assert.ok(inserted, "the hook fired (the wrapper read the claimed set after the command)");
    assert.ok(blob_row(env.db, "final-orphan-late-row"), "the late row exists");
    assert.ok(existsSync(path), "a file that a row now claims is not deleted");
  });
});

// ---------------------------------------------------------------------------
// recovery: ready row, file missing

test("a ready blob whose file is gone takes the reserved bytes again and is readable", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("final-recover", 40);
    const r = await put_ready(env, bytes, "rec");
    const path = disk_path(env, blob_row_must(env.db, r.blob_id));
    unlinkSync(path);
    must_be_api_error(await rejects_any(get_blob(env.store, env.p.project_id, r.blob_id)));

    await store_blob(env.store, env.p.project_id, r.blob_id, bytes);
    assert.ok(existsSync(path));
    assert.equal(blob_row_must(env.db, r.blob_id).state, "ready");
    const read = await get_blob(env.store, env.p.project_id, r.blob_id);
    assert.equal(read.sha256, sha256_hex(bytes));
    assert.deepEqual(Array.from(read.bytes), Array.from(bytes));
  });
});

test("recovery of a ready blob refuses other bytes: same size, other size, empty", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("final-recover-bad", 40);
    const r = await put_ready(env, bytes, "recbad");
    const path = disk_path(env, blob_row_must(env.db, r.blob_id));
    unlinkSync(path);

    const same_size = Uint8Array.from(bytes);
    same_size[same_size.length - 1] = (same_size[same_size.length - 1]! ^ 1) & 0xff;
    const candidates = [same_size, bytes.slice(0, bytes.byteLength - 1), new Uint8Array(0), new Uint8Array([...bytes, 0])];
    for (const wrong of candidates) {
      must_be_api_error(await rejects_any(store_blob(env.store, env.p.project_id, r.blob_id, wrong)));
      assert.equal(exists_on_disk(path), false, "nothing was written");
    }
    must_be_api_error(await rejects_any(get_blob(env.store, env.p.project_id, r.blob_id)));
    // the right bytes still recover it afterwards
    await store_blob(env.store, env.p.project_id, r.blob_id, bytes);
    assert.equal((await get_blob(env.store, env.p.project_id, r.blob_id)).sha256, sha256_hex(bytes));
  });
});

// ---------------------------------------------------------------------------
// recommendation 1: grace counts from the last reservation

test("gc grace is measured from the last reservation: a re-reserved, just-uploaded blob survives", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("final-grace", 16);
    const first = await reserve(env, bytes, "gr-r1");
    assert.equal(first.state, "staging");
    env.clock.advance(60_000); // well past the 30 s grace of the first reservation
    const again = await reserve(env, bytes, "gr-r2");
    assert.equal(again.blob_id, first.blob_id, "the abandoned staging row is reused");
    assert.equal(again.state, "staging");
    await store_blob(env.store, env.p.project_id, first.blob_id, bytes);
    const path = disk_path(env, blob_row_must(env.db, first.blob_id));
    env.clock.advance(1_000);

    const out = (await gc_orphans(env.service, env.store, env.ctx("gr-gc"), { grace_ms: 30_000 })).result as GcResult;
    assert.deepEqual(out.deleted_blob_ids, []);
    assert.ok(blob_row(env.db, first.blob_id), "the row stays");
    assert.ok(existsSync(path), "the file stays");
    const done = (await complete(env, first.blob_id, "gr-c")).result as CompleteResult;
    assert.equal(done.state, "ready", "the upload can still complete");
  });
});

test("gc collects a re-reserved blob once the grace has passed since its LAST reservation (control)", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("final-grace-late", 16);
    const first = await reserve(env, bytes, "grl-r1");
    env.clock.advance(60_000);
    await reserve(env, bytes, "grl-r2");
    env.clock.advance(31_000);
    const out = (await gc_orphans(env.service, env.store, env.ctx("grl-gc"), { grace_ms: 30_000 })).result as GcResult;
    assert.deepEqual(out.deleted_blob_ids, [first.blob_id]);
  });
});

// ---------------------------------------------------------------------------
// recommendation 2: one DB, one objects folder

test("a second CommandService on one DB with another objects folder throws; the same folder is fine", async () => {
  await with_env(async (env) => {
    const other = join(env.home.root, "final-other-objects");
    mkdirSync(other, { recursive: true });
    const clock = new FakeClock(env.clock.now_ms());
    assert.throws(
      () => new CommandService(env.db, { clock, policy: env.policy, objects_dir: other }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError || error instanceof Error);
        const text = String((error as Error).message);
        assert.equal(text.includes(other), false, "no path in the message");
        assert.equal(text.includes(env.objects), false, "no path in the message");
        return true;
      },
    );
    // The failed construction changed nothing: the original canonical folder still works.
    const bytes = bytes_of("final-one-folder", 8);
    const r = await put_ready(env, bytes, "of");
    assert.equal((await get_blob(env.store, env.p.project_id, r.blob_id)).sha256, sha256_hex(bytes));

    // The same folder (even spelled differently) is allowed.
    assert.doesNotThrow(() => new CommandService(env.db, { clock, policy: env.policy, objects_dir: env.objects }));
    assert.doesNotThrow(
      () => new CommandService(env.db, { clock, policy: env.policy, objects_dir: join(env.objects, ".", "") }),
    );
  });
});

// ---------------------------------------------------------------------------
// recommendation 5a: every table that references blobs counts as "linked"

interface Ref {
  name: string;
  table: string;
  seed(db: Db, blob_id: string, project_id: string, tag: string): void;
}

/** Insert a row straight into a table, filling every other NOT NULL column with a neutral value. */
function seed_row(db: Db, table: string, project_id: string, values: Record<string, SqlValue>): void {
  const info = db.all<{ name: string; type: string; notnull: bigint; dflt_value: string | null }>(
    `PRAGMA table_info(${table})`,
  );
  const row: Record<string, SqlValue> = { ...values };
  if (info.some((c) => c.name === "project_id")) row.project_id = project_id;
  for (const col of info) {
    if (col.name in row) continue;
    if (col.notnull === 0n || col.dflt_value !== null) continue;
    row[col.name] = /INT/i.test(col.type) ? 0 : `final-${table}-${col.name}`;
  }
  const names = Object.keys(row);
  // The seed stands in for a future writer; it only needs the rows that reference the blob to
  // exist, not their other parents, so foreign keys are off while seeding.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.run(
      `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      ...names.map((n) => row[n]!),
    );
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

const REFS: Ref[] = [
  {
    name: "snapshots.manifest_blob_id",
    table: "snapshots",
    seed: (db, blob_id, project_id, tag) =>
      seed_row(db, "snapshots", project_id, {
        id: `snap-${tag}`,
        scope: "edition",
        manifest_blob_id: blob_id,
        content_hash: "0".repeat(64),
        control_rev: 0,
        stage_id: null,
        round_id: null,
        through_event_seq: null,
      }),
  },
  {
    name: "source_versions.evidence_blob_id",
    table: "source_versions",
    seed: (db, blob_id, project_id, tag) =>
      seed_row(db, "source_versions", project_id, {
        version_id: `sv-${tag}`,
        method: "unknown",
        verification_state: "unverified",
        evidence_blob_id: blob_id,
      }),
  },
  {
    name: "artifact_versions.body_blob_id",
    table: "artifact_versions",
    seed: (db, blob_id, project_id, tag) =>
      seed_row(db, "artifact_versions", project_id, {
        version_id: `av-${tag}`,
        body_blob_id: blob_id,
      }),
  },
  {
    name: "file_extractions.blob_id",
    table: "file_extractions",
    seed: (db, blob_id, project_id, tag) =>
      seed_row(db, "file_extractions", project_id, { id: `fe-${tag}`, status: "pending", blob_id }),
  },
  {
    name: "file_extractions.text_blob_id",
    table: "file_extractions",
    seed: (db, blob_id, project_id, tag) =>
      seed_row(db, "file_extractions", project_id, {
        id: `fet-${tag}`,
        status: "pending",
        text_blob_id: blob_id,
        blob_id: `final-other-${tag}`,
      }),
  },
  {
    name: "import_batches.source_manifest_blob_id",
    table: "import_batches",
    seed: (db, blob_id, project_id, tag) =>
      seed_row(db, "import_batches", project_id, {
        id: `ib-${tag}`,
        source_fingerprint: `fp-${tag}`,
        state: "staging",
        source_manifest_blob_id: blob_id,
      }),
  },
  {
    name: "import_batches.report_blob_id",
    table: "import_batches",
    seed: (db, blob_id, project_id, tag) =>
      seed_row(db, "import_batches", project_id, {
        id: `ibr-${tag}`,
        source_fingerprint: `fpr-${tag}`,
        state: "staging",
        source_manifest_blob_id: `final-other-${tag}`,
        report_blob_id: blob_id,
      }),
  },
];

for (const ref of REFS) {
  for (const state of ["staging", "quarantined"] as const) {
    test(`gc keeps a ${state} blob referenced by ${ref.name} and does not stop on the foreign key`, async () => {
      await with_env(async (env) => {
        const held = await put_staging(env, bytes_of(`final-ref-${ref.name}-${state}`, 8), "held");
        const stale = await put_staging(env, bytes_of(`final-ref-stale-${ref.name}-${state}`, 8), "stale");
        if (state === "quarantined") {
          await quarantine(env.service, env.ctx("held-q"), { blob_id: held.blob_id, reason: "synthetic" });
        }
        ref.seed(env.db, held.blob_id, env.p.project_id, "a");
        const held_path = disk_path(env, blob_row_must(env.db, held.blob_id));
        const stale_path = disk_path(env, blob_row_must(env.db, stale.blob_id));
        env.clock.advance(10 * GRACE);

        const out = (await gc_orphans(env.service, env.store, env.ctx("ref-gc"), { grace_ms: GRACE })).result as GcResult;
        assert.ok(!out.deleted_blob_ids.includes(held.blob_id), "the referenced blob is not collected");
        assert.ok(blob_row(env.db, held.blob_id), "its row is still there");
        assert.ok(existsSync(held_path), "its file is still there");
        // the gc was not blocked: the unreferenced stale blob went in the same call
        assert.deepEqual(out.deleted_blob_ids, [stale.blob_id]);
        assert.equal(existsSync(stale_path), false);
      });
    });
  }

  test(`quarantine refuses a ready blob referenced by ${ref.name}`, async () => {
    await with_env(async (env) => {
      const r = await put_ready(env, bytes_of(`final-q-${ref.name}`, 8), "qr");
      ref.seed(env.db, r.blob_id, env.p.project_id, "q");
      must_be_api_error(
        await rejects_any(quarantine(env.service, env.ctx("qr-q"), { blob_id: r.blob_id, reason: "synthetic" })),
      );
      assert.equal(blob_row_must(env.db, r.blob_id).state, "ready");
      assert.equal((await get_blob(env.store, env.p.project_id, r.blob_id)).sha256.length, 64);
    });
  });
}

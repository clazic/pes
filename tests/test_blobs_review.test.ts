// SEL-42 (stage 2 PR9) first-review regression tests. Synthetic bytes only; every test runs in a
// temporary HOME/PES_HOME (tests/helpers/blob_env.ts). Decisions under test (leader, review r1):
//   1. The objects folder given to CommandService is the one canonical store. A store handed to
//      complete_upload / get_blob / store_blob / gc_orphans whose objects_dir differs is refused,
//      and nothing is written.
//   2. file.gc_orphans takes no objects_dir in its payload; it scans the injected store only.
//   4. store_blob refuses bytes whose length or sha256 differ from the reservation.
//   5. A file-system failure surfaces as an ApiError with a fixed message: no absolute path and no
//      objects folder in message or details.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { ApiError } from "../scripts/pes_core/errors.ts";
import { complete_upload, gc_orphans, get_blob, store_blob } from "../scripts/pes_core/files.ts";
import { sha256_hex } from "./helpers/backup_fixture.ts";
import {
  blob_row,
  blob_row_must,
  bytes_of,
  complete,
  ctx_for,
  disk_path,
  list_files,
  plant_bytes,
  put_ready,
  put_staging,
  receipts,
  reserve,
  rejects_any,
  rejects_api,
  with_env,
  type CompleteResult,
  type Env,
  type GcResult,
} from "./helpers/blob_env.ts";

const GRACE = 3_600_000;
const can_chmod = process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;

function other_store(env: Env, name = "other-objects"): { db: Env["db"]; objects_dir: string } {
  const dir = join(env.home.root, name);
  mkdirSync(dir, { recursive: true });
  return { db: env.db, objects_dir: dir };
}

function set_mtime(path: string, ms: number): void {
  utimesSync(path, ms / 1000, ms / 1000);
}

function api_text(error: unknown): string {
  assert.ok(error instanceof ApiError, `expected an ApiError, got ${String(error)}`);
  return JSON.stringify({ message: error.message, details: error.details });
}

function assert_no_paths(env: Env, error: unknown): void {
  const text = api_text(error);
  assert.equal(text.includes(env.objects), false, `objects folder leaked: ${text}`);
  assert.equal(text.includes(env.home.root), false, `absolute path leaked: ${text}`);
  assert.equal(text.includes("objects_dir"), false, `objects_dir leaked: ${text}`);
  assert.equal(/EACCES|ENOENT|EPERM|errno|syscall/i.test(text), false, `raw fs error leaked: ${text}`);
}

// ---------------------------------------------------------------------------
// 1. One canonical store per service

test("review repro: complete_upload with another folder holding the same bytes never makes a blob ready", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("canon-complete", 32);
    const r = await reserve(env, bytes, "cc-r");
    const foreign = other_store(env);
    // the same bytes sit in the other folder under the same project/key, none in the real store
    plant_bytes({ ...env, objects: foreign.objects_dir }, blob_row_must(env.db, r.blob_id), bytes);
    const before_receipts = receipts(env.db, env.p.project_id, "file.upload_completed");
    const error = await rejects_any(
      complete_upload(env.service, foreign, ctx_for(env.p, "cc-c"), { blob_id: r.blob_id }),
    );
    assert.ok(error instanceof ApiError);
    assert.equal(blob_row_must(env.db, r.blob_id).state, "staging", "the blob stays staging");
    assert.equal(receipts(env.db, env.p.project_id, "file.upload_completed"), before_receipts);
    assert.deepEqual(list_files(env.objects), [], "nothing was written into the real store");
    // the honest path through the canonical store still works afterwards, with the same key
    await store_blob(env.store, env.p.project_id, r.blob_id, bytes);
    const done = (await complete_upload(env.service, env.store, ctx_for(env.p, "cc-c"), { blob_id: r.blob_id })).result as CompleteResult;
    assert.equal(done.state, "ready");
  });
});

test("get_blob refuses another folder even when it holds the right bytes", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("canon-get", 16);
    const r = await put_ready(env, bytes, "cg");
    const foreign = other_store(env);
    plant_bytes({ ...env, objects: foreign.objects_dir }, blob_row_must(env.db, r.blob_id), bytes);
    const error = await rejects_any(get_blob(foreign, env.p.project_id, r.blob_id));
    assert.ok(error instanceof ApiError);
    const control = await get_blob(env.store, env.p.project_id, r.blob_id);
    assert.equal(control.sha256, sha256_hex(bytes));
  });
});

test("store_blob refuses another folder and writes nothing anywhere", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("canon-store", 16);
    const r = await reserve(env, bytes, "cs-r");
    const foreign = other_store(env);
    const error = await rejects_any(store_blob(foreign, env.p.project_id, r.blob_id, bytes));
    assert.ok(error instanceof ApiError);
    assert.deepEqual(list_files(foreign.objects_dir), []);
    assert.deepEqual(list_files(env.objects), []);
    assert.equal(blob_row_must(env.db, r.blob_id).state, "staging");
  });
});

test("gc_orphans refuses another folder: no receipt, no row removed, no file removed in either folder", async () => {
  await with_env(async (env) => {
    const stale = await put_staging(env, bytes_of("canon-gc-stale"), "cgc");
    const real_path = disk_path(env, blob_row_must(env.db, stale.blob_id));
    const foreign = other_store(env);
    const orphan = join(foreign.objects_dir, env.p.project_id, sha256_hex(bytes_of("canon-gc-orphan")));
    mkdirSync(dirname(orphan), { recursive: true });
    writeFileSync(orphan, "x");
    env.clock.advance(10 * GRACE);
    set_mtime(orphan, env.clock.now_ms() - 10 * GRACE);
    set_mtime(real_path, env.clock.now_ms() - 10 * GRACE);
    const before = receipts(env.db, env.p.project_id, "file.orphans_collected");
    const error = await rejects_any(gc_orphans(env.service, foreign, env.ctx("cgc-gc"), { grace_ms: GRACE }));
    assert.ok(error instanceof ApiError);
    assert.equal(receipts(env.db, env.p.project_id, "file.orphans_collected"), before);
    assert.ok(blob_row(env.db, stale.blob_id), "the stale blob row is still there");
    assert.ok(existsSync(orphan), "the foreign orphan file is untouched");
    assert.ok(existsSync(real_path), "the real stale file is untouched");
    // control: the canonical store collects it
    const out = (await gc_orphans(env.service, env.store, env.ctx("cgc-gc"), { grace_ms: GRACE })).result as GcResult;
    assert.deepEqual(out.deleted_blob_ids, [stale.blob_id]);
  });
});

test("a fresh store object for the same canonical folder is accepted", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("canon-same", 8);
    const same = { db: env.db, objects_dir: env.objects };
    const r = await reserve(env, bytes, "csm-r");
    await store_blob(same, env.p.project_id, r.blob_id, bytes);
    const done = (await complete_upload(env.service, same, env.ctx("csm-c"), { blob_id: r.blob_id })).result as CompleteResult;
    assert.equal(done.state, "ready");
    assert.equal((await get_blob(same, env.p.project_id, r.blob_id)).sha256, sha256_hex(bytes));
  });
});

// ---------------------------------------------------------------------------
// 2. file.gc_orphans takes no objects_dir

test("file.gc_orphans refuses an objects_dir field of any kind and changes nothing", async () => {
  await with_env(async (env) => {
    const stale = await put_staging(env, bytes_of("gcp-stale"), "gcp");
    env.clock.advance(10 * GRACE);
    const foreign = other_store(env);
    const files = list_files(env.objects);
    const before = receipts(env.db, env.p.project_id, "file.orphans_collected");
    for (const [i, value] of [env.objects, foreign.objects_dir, "relative/dir", 42, null, ""].entries()) {
      await rejects_api(
        env.service.execute(env.ctx(`gcp-${i}`), "file.gc_orphans", { grace_ms: GRACE, objects_dir: value }),
        "invalid_payload",
      );
    }
    assert.equal(receipts(env.db, env.p.project_id, "file.orphans_collected"), before);
    assert.ok(blob_row(env.db, stale.blob_id));
    assert.deepEqual(list_files(env.objects), files);
  });
});

test("a direct file.gc_orphans scans the injected store: missing files and orphan files are reported", async () => {
  await with_env(async (env) => {
    const ready = await put_ready(env, bytes_of("gcs-ready"), "gcs-ready");
    const path = disk_path(env, blob_row_must(env.db, ready.blob_id));
    const orphan = join(env.objects, env.p.project_id, sha256_hex(bytes_of("gcs-orphan")));
    writeFileSync(orphan, "x");
    env.clock.advance(10 * GRACE);
    set_mtime(orphan, env.clock.now_ms() - 10 * GRACE);
    // a lookalike orphan in some other folder is never counted
    const foreign = other_store(env);
    const elsewhere = join(foreign.objects_dir, env.p.project_id, sha256_hex(bytes_of("gcs-elsewhere")));
    mkdirSync(dirname(elsewhere), { recursive: true });
    writeFileSync(elsewhere, "x");
    set_mtime(elsewhere, env.clock.now_ms() - 10 * GRACE);
    const out = (await env.service.execute(env.ctx("gcs-1"), "file.gc_orphans", { grace_ms: GRACE })).result as GcResult;
    assert.equal(out.orphan_files_removed, 1, "only the injected store's orphan is seen");
    assert.deepEqual(out.missing_file_blob_ids, []);
    // now the ready blob's file disappears: the injected store reports it as missing
    unlinkSync(path);
    const again = (await env.service.execute(env.ctx("gcs-2"), "file.gc_orphans", { grace_ms: GRACE })).result as GcResult;
    assert.deepEqual(again.missing_file_blob_ids, [ready.blob_id]);
  });
});

// ---------------------------------------------------------------------------
// 4. store_blob checks length and sha256 against the reservation

test("store_blob refuses bytes that differ from the reservation and leaves no file behind", async () => {
  await with_env(async (env) => {
    const declared = bytes_of("sb-declared", 48);
    const same_len_other = Uint8Array.from(declared).map((b) => b ^ 0x5a);
    const variants: [string, Uint8Array][] = [
      ["same length, other bytes", same_len_other],
      ["shorter", declared.slice(0, declared.byteLength - 1)],
      ["longer", Uint8Array.from([...declared, 0])],
      ["empty", new Uint8Array(0)],
      ["garbage", bytes_of("sb-garbage")],
    ];
    const r = await reserve(env, declared, "sb-r");
    const row = blob_row_must(env.db, r.blob_id);
    for (const [label, bad] of variants) {
      const error = await rejects_any(store_blob(env.store, env.p.project_id, r.blob_id, bad));
      assert.ok(error instanceof ApiError, `${label}: refused with an ApiError`);
      assert.equal(existsSync(disk_path(env, row)), false, `${label}: no file at the storage location`);
      assert.deepEqual(list_files(env.objects), [], `${label}: no temp or partial file anywhere`);
      assert.equal(blob_row_must(env.db, r.blob_id).state, "staging", `${label}: the blob stays staging`);
    }
    // the right bytes are still accepted after all those refusals
    await store_blob(env.store, env.p.project_id, r.blob_id, declared);
    const done = (await complete(env, r.blob_id, "sb-c")).result as CompleteResult;
    assert.equal(done.state, "ready");
  });
});

test("review repro 5: garbage bytes can no longer poison a (sha256, size) so the honest upload is blocked", async () => {
  await with_env(async (env) => {
    const honest = bytes_of("poison", 24);
    const first = await reserve(env, honest, "po-r1");
    await rejects_any(store_blob(env.store, env.p.project_id, first.blob_id, bytes_of("poison-garbage", 24)));
    // completing without valid bytes does not quarantine either: nothing was stored
    await complete(env, first.blob_id, "po-c1").then(
      () => undefined,
      () => undefined,
    );
    assert.notEqual(blob_row_must(env.db, first.blob_id).state, "quarantined", "no quarantined row from garbage");
    // another reservation of the same (sha, size) is a normal staging blob and becomes ready
    const again = await reserve(env, honest, "po-r2");
    assert.equal(again.state, "staging");
    await store_blob(env.store, env.p.project_id, again.blob_id, honest);
    const done = (await complete(env, again.blob_id, "po-c2")).result as CompleteResult;
    assert.equal(done.state, "ready");
    assert.equal((await get_blob(env.store, env.p.project_id, again.blob_id)).sha256, sha256_hex(honest));
  });
});

// ---------------------------------------------------------------------------
// 5. File-system errors do not leak paths

test("store_blob into an unwritable project folder fails with a fixed ApiError that names no path", { skip: !can_chmod }, async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("fs-store", 8);
    const r = await reserve(env, bytes, "fs-r");
    const row = blob_row_must(env.db, r.blob_id);
    const dir = dirname(disk_path(env, row));
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    try {
      const error = await rejects_any(store_blob(env.store, env.p.project_id, r.blob_id, bytes));
      assert_no_paths(env, error);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

test("store_blob under an unwritable objects folder fails with a fixed ApiError that names no path", { skip: !can_chmod }, async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("fs-root", 8);
    const r = await reserve(env, bytes, "fsr-r");
    chmodSync(env.objects, 0o500);
    try {
      const error = await rejects_any(store_blob(env.store, env.p.project_id, r.blob_id, bytes));
      assert_no_paths(env, error);
    } finally {
      chmodSync(env.objects, 0o700);
    }
  });
});

test("get_blob and complete_upload on an unreadable file fail with a fixed ApiError that names no path", { skip: !can_chmod }, async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("fs-read", 8);
    const ready = await put_ready(env, bytes, "fsd-ok");
    const ready_path = disk_path(env, blob_row_must(env.db, ready.blob_id));
    const staged = await put_staging(env, bytes_of("fs-read-staged", 8), "fsd-stg");
    const staged_path = disk_path(env, blob_row_must(env.db, staged.blob_id));
    chmodSync(ready_path, 0o000);
    chmodSync(staged_path, 0o000);
    try {
      assert_no_paths(env, await rejects_any(get_blob(env.store, env.p.project_id, ready.blob_id)));
      assert_no_paths(env, await rejects_any(complete(env, staged.blob_id, "fsd-c")));
      assert.notEqual(blob_row_must(env.db, staged.blob_id).state, "ready");
    } finally {
      chmodSync(ready_path, 0o600);
      chmodSync(staged_path, 0o600);
    }
  });
});

test("gc_orphans over an unreadable project folder either succeeds or fails with a path-free ApiError", { skip: !can_chmod }, async () => {
  await with_env(async (env) => {
    await put_ready(env, bytes_of("fs-gc", 8), "fsg-ok");
    const dir = join(env.objects, env.p.project_id);
    env.clock.advance(10 * GRACE);
    chmodSync(dir, 0o000);
    try {
      try {
        await gc_orphans(env.service, env.store, env.ctx("fsg-gc"), { grace_ms: GRACE });
      } catch (error) {
        assert_no_paths(env, error);
      }
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

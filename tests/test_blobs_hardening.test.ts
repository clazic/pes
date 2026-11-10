// SEL-42 (stage 2 PR9) hardening: tests that try to break the passed implementation.
// Synthetic bytes only; every test uses a temporary HOME/PES_HOME (see tests/helpers/blob_env.ts).
// Interface: see the comment at the top of tests/test_blobs.test.ts.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { ApiError } from "../scripts/pes_core/errors.ts";
import {
  attach_version,
  complete_upload,
  gc_orphans,
  get_blob,
  quarantine,
  reserve_upload,
  store_blob,
} from "../scripts/pes_core/files.ts";
import { sha256_hex } from "./helpers/backup_fixture.ts";
import {
  MEDIA_TYPE,
  attach,
  blob_row,
  blob_row_must,
  bytes_of,
  complete,
  ctx_for,
  disk_path,
  exists_on_disk,
  list_files,
  new_artifact,
  put_ready,
  put_staging,
  reserve,
  rejects_any,
  rejects_api,
  second_project,
  with_env,
  wrap_db,
  type CompleteResult,
  type Env,
  type GcResult,
  type ReserveResult,
} from "./helpers/blob_env.ts";

const GRACE = 3_600_000;

function set_mtime(path: string, ms: number): void {
  utimesSync(path, ms / 1000, ms / 1000);
}

async function gc_result(env: Env, key: string, grace_ms = GRACE, p = env.p): Promise<GcResult> {
  return (await gc_orphans(env.service, env.store, ctx_for(p, key), { grace_ms })).result as GcResult;
}

/** Same length, one byte different. */
function flipped(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes);
  out[out.byteLength - 1] = out[out.byteLength - 1]! ^ 0xff;
  return out;
}

function outside_dir(): string {
  return mkdtempSync(join(tmpdir(), "pes-sel42-outside-"));
}

function dump_everything(env: Env): string {
  const events = env.db.all<{ type: string; payload: string }>("SELECT type, payload FROM events");
  const receipts = env.db.all<{ action: string; result: string | null }>(
    "SELECT action, * FROM mutation_commits",
  );
  return JSON.stringify({ events, receipts }, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
}

// ---------------------------------------------------------------------------
// 1. The leader's suspicion: file.complete_upload executed directly (no wrapper re-read)

test("direct file.complete_upload with the reserved sha256/size never makes a blob ready when no bytes were stored", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("direct-nobytes");
    const r = await reserve(env, bytes, "d1-r");
    const out = await env.service
      .execute(env.ctx("d1-c"), "file.complete_upload", {
        blob_id: r.blob_id,
        sha256: sha256_hex(bytes),
        size: bytes.byteLength,
      })
      .then(
        (o) => o,
        (e) => e,
      );
    assert.notEqual(blob_row_must(env.db, r.blob_id).state, "ready", "no stored bytes -> never ready");
    void out;
    await rejects_api(get_blob(env.store, env.p.project_id, r.blob_id), "not_found", "conflict");
  });
});

test("direct file.complete_upload with the reserved sha256/size never makes a blob ready when other bytes are stored", async () => {
  await with_env(async (env) => {
    const declared = bytes_of("direct-declared", 64);
    const evil = flipped(declared);
    assert.equal(evil.byteLength, declared.byteLength);
    const r = await reserve(env, declared, "d2-r");
    await store_blob(env.store, env.p.project_id, r.blob_id, evil);
    await env.service
      .execute(env.ctx("d2-c"), "file.complete_upload", {
        blob_id: r.blob_id,
        sha256: sha256_hex(declared),
        size: declared.byteLength,
      })
      .then(
        () => undefined,
        () => undefined,
      );
    const row = blob_row_must(env.db, r.blob_id);
    assert.notEqual(row.state, "ready", "stored bytes differ from the declaration -> never ready");
    await rejects_api(get_blob(env.store, env.p.project_id, r.blob_id), "conflict", "not_found");
  });
});

test("direct file.complete_upload with a wrong hash or size quarantines (control for the two bypass tests)", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("direct-wrong");
    const r = await reserve(env, bytes, "d3-r");
    await store_blob(env.store, env.p.project_id, r.blob_id, bytes);
    const out = await env.service.execute(env.ctx("d3-c"), "file.complete_upload", {
      blob_id: r.blob_id,
      sha256: sha256_hex(bytes_of("other")),
      size: bytes.byteLength,
    });
    assert.equal((out.result as CompleteResult).state, "quarantined");
    assert.equal(blob_row_must(env.db, r.blob_id).state, "quarantined");
  });
});

// ---------------------------------------------------------------------------
// 2. Other projects' blobs: every public door and direct commands

test("a second project cannot attach, complete, quarantine, get or store another project's blob (direct commands included)", async () => {
  await with_env(async (env) => {
    const b = await second_project(env);
    const bytes = bytes_of("xproj");
    const staging = await put_staging(env, bytes, "x-stg");
    const ready = await put_ready(env, bytes_of("xproj-ready"), "x-rdy");
    const b_art = await new_artifact({ ...env, p: b, ctx: (k: string) => ctx_for(b, k) } as Env, "x-bart");

    const before = JSON.stringify(blob_row_must(env.db, staging.blob_id), (_k, v) => (typeof v === "bigint" ? Number(v) : v));
    const bctx = (k: string) => ctx_for(b, k);

    await rejects_api(attach_version(env.service, bctx("x1"), { version_id: b_art.version_id, blob_id: ready.blob_id, role: "image" }), "not_found");
    await rejects_api(complete_upload(env.service, env.store, bctx("x2"), { blob_id: staging.blob_id }), "not_found");
    await rejects_api(quarantine(env.service, bctx("x3"), { blob_id: staging.blob_id, reason: "synthetic" }), "not_found");
    await rejects_api(quarantine(env.service, bctx("x4"), { blob_id: ready.blob_id, reason: "synthetic" }), "not_found");
    await rejects_api(get_blob(env.store, b.project_id, ready.blob_id), "not_found");
    await rejects_api(store_blob(env.store, b.project_id, staging.blob_id, bytes), "not_found");
    await rejects_api(
      env.service.execute(bctx("x5"), "file.complete_upload", {
        blob_id: staging.blob_id,
        sha256: sha256_hex(bytes),
        size: bytes.byteLength,
      }),
      "not_found",
    );
    // own version, other project's blob via direct command
    await rejects_api(
      env.service.execute(bctx("x6"), "file.attach_version", { version_id: b_art.version_id, blob_id: ready.blob_id, role: "source" }),
      "not_found",
    );
    // the other project's version with this project's ctx
    const a_art = await new_artifact(env, "x-aart");
    await rejects_api(
      attach_version(env.service, env.ctx("x7"), { version_id: b_art.version_id, blob_id: ready.blob_id, role: "source" }),
      "not_found",
    );
    void a_art;
    assert.equal(
      JSON.stringify(blob_row_must(env.db, staging.blob_id), (_k, v) => (typeof v === "bigint" ? Number(v) : v)),
      before,
    );
    assert.equal(blob_row_must(env.db, ready.blob_id).state, "ready");
    assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM version_files")?.n, 0n);
  });
});

// ---------------------------------------------------------------------------
// 3. Same sha256 in two projects: no cross effect

test("one project's gc never removes the bytes of the other project that uploaded the same sha256", async () => {
  await with_env(async (env) => {
    const b = await second_project(env);
    const bytes = bytes_of("same-sha-both");
    const a_r = await reserve(env, bytes, "s-a");
    const b_r = await reserve(env, bytes, "s-b", {}, b);
    assert.notEqual(a_r.blob_id, b_r.blob_id);
    await store_blob(env.store, env.p.project_id, a_r.blob_id, bytes);
    await store_blob(env.store, b.project_id, b_r.blob_id, bytes);
    const b_done = (await complete(env, b_r.blob_id, "s-b-c", b)).result as CompleteResult;
    assert.equal(b_done.state, "ready");
    const b_row = blob_row_must(env.db, b_r.blob_id);
    const b_path = disk_path(env, b_row);
    assert.ok(exists_on_disk(b_path));

    env.clock.advance(GRACE + 1);
    const out = await gc_result(env, "s-gc-a");
    assert.deepEqual(out.deleted_blob_ids, [a_r.blob_id]);
    assert.equal(blob_row(env.db, a_r.blob_id), undefined);
    assert.ok(exists_on_disk(b_path), "the other project's identical bytes stay");
    assert.equal((await get_blob(env.store, b.project_id, b_r.blob_id)).sha256, sha256_hex(bytes));
    assert.notEqual(
      disk_path(env, blob_row_must(env.db, b_r.blob_id)),
      join(env.objects, env.p.project_id, sha256_hex(bytes)),
    );
  });
});

test("gc of one project reports and removes nothing in another project's folder, even a stale stray file", async () => {
  await with_env(async (env) => {
    const b = await second_project(env);
    const stray = join(env.objects, b.project_id, sha256_hex(bytes_of("stray-b")));
    mkdirSync(dirname(stray), { recursive: true });
    writeFileSync(stray, bytes_of("stray-b"));
    set_mtime(stray, env.clock.now_ms() - 10 * GRACE);
    const out = await gc_result(env, "s-gc-stray");
    assert.equal(out.orphan_files_removed, 0);
    assert.ok(existsSync(stray));
  });
});

// ---------------------------------------------------------------------------
// 4. Concurrency

test("two concurrent reserves of the same bytes in one project give one blobs row", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("conc-reserve");
    const results = await Promise.allSettled([reserve(env, bytes, "c-1"), reserve(env, bytes, "c-2")]);
    const ok = results.filter((r): r is PromiseFulfilledResult<ReserveResult> => r.status === "fulfilled");
    assert.ok(ok.length >= 1);
    const n = env.db.get<{ n: bigint }>(
      "SELECT count(*) AS n FROM blobs WHERE project_id = ? AND sha256 = ?",
      env.p.project_id,
      sha256_hex(bytes),
    )?.n;
    assert.equal(n, 1n);
    for (const r of ok) assert.equal(r.value.blob_id, ok[0]!.value.blob_id);
  });
});

test("two concurrent completes of one staging blob end ready exactly once, with consistent receipts", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("conc-complete");
    const r = await put_staging(env, bytes, "cc");
    const results = await Promise.allSettled([complete(env, r.blob_id, "cc-1"), complete(env, r.blob_id, "cc-2")]);
    for (const res of results) {
      if (res.status === "rejected") {
        assert.ok(res.reason instanceof ApiError, String(res.reason));
        assert.equal(res.reason.code, "conflict");
      }
    }
    assert.ok(results.some((x) => x.status === "fulfilled"));
    assert.equal(blob_row_must(env.db, r.blob_id).state, "ready");
    const completed = env.db.get<{ n: bigint }>(
      "SELECT count(*) AS n FROM events WHERE type = 'file.upload_completed'",
    )?.n;
    assert.equal(completed, results.filter((x) => x.status === "fulfilled").length === 2 ? 2n : 1n);
    assert.equal((await get_blob(env.store, env.p.project_id, r.blob_id)).sha256, sha256_hex(bytes));
  });
});

test("a complete racing with a quarantine ends in exactly one terminal state and never ready-and-quarantined", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("conc-quarantine");
    const r = await put_staging(env, bytes, "cq");
    await Promise.allSettled([
      complete(env, r.blob_id, "cq-c"),
      quarantine(env.service, env.ctx("cq-q"), { blob_id: r.blob_id, reason: "synthetic" }),
    ]);
    const state = blob_row_must(env.db, r.blob_id).state;
    assert.ok(state === "ready" || state === "quarantined", state);
    if (state === "quarantined") {
      await rejects_api(get_blob(env.store, env.p.project_id, r.blob_id), "conflict", "not_found");
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Path escapes through the objects folder and storage_key

test("a symlinked project folder redirects no store, read, complete or gc to the outside", async () => {
  await with_env(async (env) => {
    const outside = outside_dir();
    try {
      const bytes = bytes_of("link-project");
      const r = await reserve(env, bytes, "l-r");
      symlinkSync(outside, join(env.objects, env.p.project_id));
      await rejects_any(store_blob(env.store, env.p.project_id, r.blob_id, bytes));
      assert.deepEqual(list_files(outside), [], "nothing was written through the link");
      writeFileSync(join(outside, sha256_hex(bytes)), bytes);
      const done = await complete(env, r.blob_id, "l-c").then(
        (o) => (o.result as CompleteResult).state,
        () => "rejected",
      );
      assert.notEqual(done, "ready", "bytes reachable only through a link are not accepted");
      env.clock.advance(GRACE + 1);
      set_mtime(join(outside, sha256_hex(bytes)), env.clock.now_ms() - 10 * GRACE);
      await gc_result(env, "l-gc");
      assert.ok(existsSync(join(outside, sha256_hex(bytes))), "gc never deletes through a link");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("a symlinked objects folder is refused by store, read and gc, and nothing outside changes", async () => {
  await with_env(async (env) => {
    const outside = outside_dir();
    try {
      const bytes = bytes_of("link-root");
      const ready = await put_ready(env, bytes, "lr-ok");
      const stg = await reserve(env, bytes_of("link-root-stg"), "lr-stg");
      const victim = join(outside, env.p.project_id, "victim.bin");
      mkdirSync(dirname(victim), { recursive: true });
      writeFileSync(victim, "x");
      set_mtime(victim, env.clock.now_ms() - 10 * GRACE);
      const linked = { db: env.db, objects_dir: join(outside, "objects-link") };
      symlinkSync(outside, linked.objects_dir);
      await rejects_any(store_blob(linked, env.p.project_id, stg.blob_id, bytes_of("link-root-stg")));
      await rejects_any(get_blob(linked, env.p.project_id, ready.blob_id));
      env.clock.advance(GRACE + 1);
      await gc_orphans(env.service, linked, env.ctx("lr-gc"), { grace_ms: GRACE }).then(
        () => undefined,
        () => undefined,
      );
      assert.ok(existsSync(victim), "gc through a symlinked objects folder deletes nothing");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("a tampered storage_key (parent dir, absolute, backslash, nested, other project) is refused everywhere and touches nothing outside", async () => {
  await with_env(async (env) => {
    const b = await second_project(env);
    const outside = outside_dir();
    try {
      const secret = join(outside, "secret.bin");
      writeFileSync(secret, "keep");
      const b_ready = await put_ready({ ...env, p: b } as Env, bytes_of("tamper-b"), "t-b");
      const b_path = disk_path(env, blob_row_must(env.db, b_ready.blob_id));
      const keys = [
        `../${sha256_hex(bytes_of("t"))}`,
        `${env.p.project_id}/../escape`,
        secret,
        `${env.p.project_id}\\evil`,
        `${env.p.project_id}/sub/..//x`,
        blob_row_must(env.db, b_ready.blob_id).storage_key, // another project's file
        "relative-only",
      ];
      for (const [i, key] of keys.entries()) {
        const bytes = bytes_of(`tamper-${i}`);
        const r = await reserve(env, bytes, `t-${i}`);
        env.db.run("DROP TRIGGER IF EXISTS _none"); // keep the handle used; trigger absent is fine
        try {
          env.db.run("UPDATE blobs SET storage_key = ? WHERE id = ?", key, r.blob_id);
        } catch {
          continue; // the schema itself refuses this key: even better
        }
        await rejects_any(store_blob(env.store, env.p.project_id, r.blob_id, bytes));
        const done = await complete(env, r.blob_id, `t-c-${i}`).then(
          (o) => (o.result as CompleteResult).state,
          () => "rejected",
        );
        assert.notEqual(done, "ready", `key ${key} must not become ready`);
      }
      assert.equal(readFileSync(secret, "utf8"), "keep");
      assert.deepEqual(list_files(outside), ["secret.bin"]);
      assert.ok(existsSync(b_path), "the other project's file is untouched");
      env.clock.advance(GRACE + 1);
      await gc_result(env, "t-gc");
      assert.equal(readFileSync(secret, "utf8"), "keep", "gc with a tampered key deletes nothing outside");
      assert.ok(existsSync(b_path), "gc of project A never deletes project B's file via a tampered key");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("a symlinked intermediate folder inside the project folder is never followed for a nested storage_key", async () => {
  await with_env(async (env) => {
    const outside = outside_dir();
    try {
      const bytes = bytes_of("nested-link");
      const r = await reserve(env, bytes, "n-r");
      const pdir = join(env.objects, env.p.project_id);
      mkdirSync(pdir, { recursive: true });
      symlinkSync(outside, join(pdir, "sub"));
      env.db.run("UPDATE blobs SET storage_key = ? WHERE id = ?", `${env.p.project_id}/sub/${sha256_hex(bytes)}`, r.blob_id);
      await rejects_any(store_blob(env.store, env.p.project_id, r.blob_id, bytes));
      assert.deepEqual(list_files(outside), []);
      writeFileSync(join(outside, sha256_hex(bytes)), bytes);
      const done = await complete(env, r.blob_id, "n-c").then(
        (o) => (o.result as CompleteResult).state,
        () => "rejected",
      );
      assert.notEqual(done, "ready");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("a ready blob whose stored path is replaced by a symlink to identical outside bytes is not served and is reported missing by gc", async () => {
  await with_env(async (env) => {
    const outside = outside_dir();
    try {
      const bytes = bytes_of("ready-link");
      const r = await put_ready(env, bytes, "rl");
      const path = disk_path(env, blob_row_must(env.db, r.blob_id));
      unlinkSync(path);
      const target = join(outside, "same.bin");
      writeFileSync(target, bytes);
      symlinkSync(target, path);
      await rejects_api(get_blob(env.store, env.p.project_id, r.blob_id), "conflict");
      const out = await gc_result(env, "rl-gc");
      assert.deepEqual(out.missing_file_blob_ids, [r.blob_id]);
      assert.equal(blob_row_must(env.db, r.blob_id).state, "ready", "gc only reports");
      assert.equal(readFileSync(target, "utf8"), new TextDecoder().decode(bytes));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("store_blob leaves no temp file and no blob of a stale key behind when the target is a directory", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("target-dir");
    const r = await reserve(env, bytes, "td-r");
    const target = disk_path(env, blob_row_must(env.db, r.blob_id));
    mkdirSync(target, { recursive: true });
    await rejects_any(store_blob(env.store, env.p.project_id, r.blob_id, bytes));
    assert.deepEqual(
      list_files(env.objects).filter((f) => f.includes(".upload-")),
      [],
    );
    assert.equal(blob_row_must(env.db, r.blob_id).state, "staging");
  });
});

// ---------------------------------------------------------------------------
// 6. gc boundaries

test("gc keeps a stale blob at exactly grace_ms and deletes it one millisecond later", async () => {
  await with_env(async (env) => {
    const stg = await put_staging(env, bytes_of("edge-stg"), "e-stg");
    const path = disk_path(env, blob_row_must(env.db, stg.blob_id));
    env.clock.advance(GRACE);
    const at = await gc_result(env, "e-at");
    assert.deepEqual(at.deleted_blob_ids, [], "exactly at the deadline it is still kept");
    assert.ok(blob_row(env.db, stg.blob_id));
    assert.ok(existsSync(path));
    env.clock.advance(1);
    const after = await gc_result(env, "e-after");
    assert.deepEqual(after.deleted_blob_ids, [stg.blob_id]);
    assert.equal(blob_row(env.db, stg.blob_id), undefined);
    assert.equal(existsSync(path), false);
  });
});

test("gc keeps a stray file whose mtime is exactly grace_ms old and removes it one millisecond later", async () => {
  await with_env(async (env) => {
    const path = join(env.objects, env.p.project_id, sha256_hex(bytes_of("edge-orphan")));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes_of("edge-orphan"));
    set_mtime(path, env.clock.now_ms() - GRACE);
    const at = await gc_result(env, "eo-at");
    assert.equal(at.orphan_files_removed, 0);
    assert.ok(existsSync(path));
    set_mtime(path, env.clock.now_ms() - GRACE - 1);
    const after = await gc_result(env, "eo-after");
    assert.equal(after.orphan_files_removed, 1);
    assert.equal(existsSync(path), false);
  });
});

test("gc never removes a ready blob (linked or not), its row, or its bytes, however old", async () => {
  await with_env(async (env) => {
    const art = await new_artifact(env, "g-art");
    const linked = await put_ready(env, bytes_of("g-linked"), "g-l");
    await attach(env, art.version_id, linked.blob_id, "rendered", "g-la");
    const unlinked = await put_ready(env, bytes_of("g-unlinked"), "g-u");
    env.clock.advance(1000 * GRACE);
    const out = await gc_result(env, "g-gc");
    assert.deepEqual(out.deleted_blob_ids, []);
    assert.deepEqual(out.missing_file_blob_ids, []);
    assert.equal(out.orphan_files_removed, 0);
    for (const r of [linked, unlinked]) {
      assert.equal(blob_row_must(env.db, r.blob_id).state, "ready");
      assert.ok(exists_on_disk(disk_path(env, blob_row_must(env.db, r.blob_id))));
      await get_blob(env.store, env.p.project_id, r.blob_id);
    }
  });
});

test("a stale quarantined blob that has a version link or a file policy is not collected", async () => {
  await with_env(async (env) => {
    const art = await new_artifact(env, "q-art");
    const r = await put_ready(env, bytes_of("q-linked"), "q-l");
    await attach(env, art.version_id, r.blob_id, "source", "q-la");
    // force the state the guard exists for: a linked blob that is no longer ready
    env.db.run("UPDATE blobs SET state = 'quarantined' WHERE id = ?", r.blob_id);
    env.clock.advance(10 * GRACE);
    const out = await gc_result(env, "q-gc");
    assert.deepEqual(out.deleted_blob_ids, []);
    assert.ok(blob_row(env.db, r.blob_id));
    assert.ok(exists_on_disk(disk_path(env, blob_row_must(env.db, r.blob_id))));
  });
});

test("gc only reports a ready blob whose file is missing, and keeps reporting it; the row survives", async () => {
  await with_env(async (env) => {
    const r = await put_ready(env, bytes_of("m-ready"), "m");
    unlinkSync(disk_path(env, blob_row_must(env.db, r.blob_id)));
    env.clock.advance(10 * GRACE);
    const one = await gc_result(env, "m-1");
    const two = await gc_result(env, "m-2");
    assert.deepEqual(one.missing_file_blob_ids, [r.blob_id]);
    assert.deepEqual(two.missing_file_blob_ids, [r.blob_id]);
    assert.deepEqual(one.deleted_blob_ids, []);
    assert.equal(blob_row_must(env.db, r.blob_id).state, "ready");
  });
});

test("gc of a stale unlinked blob also sweeps it when its file was already missing or is a directory", async () => {
  await with_env(async (env) => {
    const none = await reserve(env, bytes_of("gone"), "gm-1");
    const dir = await reserve(env, bytes_of("dir"), "gm-2");
    mkdirSync(disk_path(env, blob_row_must(env.db, dir.blob_id)), { recursive: true });
    env.clock.advance(GRACE + 1);
    const out = await gc_result(env, "gm-gc");
    assert.deepEqual([...out.deleted_blob_ids].sort(), [none.blob_id, dir.blob_id].sort());
  });
});

test("a failing gc transaction deletes no row and no file, and the same key works afterwards", async () => {
  await with_env(async (env) => {
    const stg = await put_staging(env, bytes_of("gcf"), "gcf");
    const path = disk_path(env, blob_row_must(env.db, stg.blob_id));
    env.clock.advance(GRACE + 1);
    const failing = env.with_db(
      wrap_db(env.db, (sql) => {
        if (/delete\s+from\s+blobs/i.test(sql)) throw new Error("injected delete failure");
        return undefined;
      }),
    );
    await rejects_any(gc_orphans(failing, env.store, env.ctx("gcf-k"), { grace_ms: GRACE }));
    assert.ok(blob_row(env.db, stg.blob_id));
    assert.ok(existsSync(path));
    const retry = await gc_result(env, "gcf-k");
    assert.deepEqual(retry.deleted_blob_ids, [stg.blob_id]);
    assert.equal(existsSync(path), false);
  });
});

test("a replayed gc does not delete files created after the first run", async () => {
  await with_env(async (env) => {
    await gc_result(env, "rp-gc");
    const path = join(env.objects, env.p.project_id, sha256_hex(bytes_of("late-stray")));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes_of("late-stray"));
    set_mtime(path, env.clock.now_ms() - 10 * GRACE);
    const again = await gc_orphans(env.service, env.store, env.ctx("rp-gc"), { grace_ms: GRACE });
    assert.equal(again.replayed, true);
    assert.ok(existsSync(path), "a replay is a no-op on disk");
  });
});

// ---------------------------------------------------------------------------
// 7. quarantined / terminal states cannot be revived

test("a quarantined blob cannot become ready again by complete (public or direct), attach, store or quarantine", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("revive");
    const r = await put_staging(env, bytes, "rv");
    await quarantine(env.service, env.ctx("rv-q"), { blob_id: r.blob_id, reason: "synthetic" });
    const art = await new_artifact(env, "rv-art");
    await rejects_api(complete(env, r.blob_id, "rv-c"), "conflict");
    await rejects_api(
      env.service.execute(env.ctx("rv-d"), "file.complete_upload", {
        blob_id: r.blob_id,
        sha256: sha256_hex(bytes),
        size: bytes.byteLength,
      }),
      "conflict",
    );
    await rejects_api(attach_version(env.service, env.ctx("rv-a"), { version_id: art.version_id, blob_id: r.blob_id, role: "image" }), "conflict");
    await rejects_api(store_blob(env.store, env.p.project_id, r.blob_id, bytes), "conflict");
    await rejects_api(quarantine(env.service, env.ctx("rv-q2"), { blob_id: r.blob_id, reason: "again" }), "conflict");
    // re-reserving the same bytes must not hand out a usable ready blob
    const again = await reserve(env, bytes, "rv-r2");
    assert.notEqual(again.state, "ready");
    assert.equal(blob_row_must(env.db, r.blob_id).state, "quarantined");
    await rejects_api(get_blob(env.store, env.p.project_id, r.blob_id), "conflict", "not_found");
  });
});

test("a quarantined mismatch is collected by gc and the same honest bytes can then be uploaded as a fresh ready blob", async () => {
  await with_env(async (env) => {
    const declared = bytes_of("fresh-declared", 16);
    const evil = flipped(declared);
    const r = await reserve(env, declared, "f-r");
    await store_blob(env.store, env.p.project_id, r.blob_id, evil);
    const done = await complete(env, r.blob_id, "f-c").then(
      (o) => (o.result as CompleteResult).state,
      () => "rejected",
    );
    assert.notEqual(done, "ready");
    if (blob_row_must(env.db, r.blob_id).state === "staging") {
      await quarantine(env.service, env.ctx("f-q"), { blob_id: r.blob_id, reason: "synthetic" });
    }
    env.clock.advance(GRACE + 1);
    const out = await gc_result(env, "f-gc");
    assert.deepEqual(out.deleted_blob_ids, [r.blob_id]);
    const good = await put_ready(env, declared, "f-good");
    assert.notEqual(good.blob_id, r.blob_id);
    assert.equal((await get_blob(env.store, env.p.project_id, good.blob_id)).sha256, sha256_hex(declared));
  });
});

test("a ready unlinked blob can be quarantined, and then is no longer attachable or served", async () => {
  await with_env(async (env) => {
    const r = await put_ready(env, bytes_of("rq"), "rq");
    const art = await new_artifact(env, "rq-art");
    await quarantine(env.service, env.ctx("rq-q"), { blob_id: r.blob_id, reason: "synthetic" });
    await rejects_api(attach_version(env.service, env.ctx("rq-a"), { version_id: art.version_id, blob_id: r.blob_id, role: "image" }), "conflict");
    await rejects_api(get_blob(env.store, env.p.project_id, r.blob_id), "conflict");
  });
});

// ---------------------------------------------------------------------------
// 8. DB failure after the bytes were written

test("bytes written before a failing attach, quarantine or complete transaction keep the DB and files consistent", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("fail-after-bytes");
    const r = await put_staging(env, bytes, "fb");
    const files = list_files(env.objects);
    const failing = env.with_db(
      wrap_db(env.db, (sql) => {
        if (/update\s+blobs/i.test(sql)) throw new Error("injected update failure");
        return undefined;
      }),
    );
    await rejects_any(complete_upload(failing, env.store, env.ctx("fb-c"), { blob_id: r.blob_id }));
    assert.equal(blob_row_must(env.db, r.blob_id).state, "staging");
    assert.deepEqual(list_files(env.objects), files);
    await rejects_any(quarantine(failing, env.ctx("fb-q"), { blob_id: r.blob_id, reason: "synthetic" }));
    assert.equal(blob_row_must(env.db, r.blob_id).state, "staging");
    const done = (await complete(env, r.blob_id, "fb-c")).result as CompleteResult;
    assert.equal(done.state, "ready");
  });
});

// ---------------------------------------------------------------------------
// 9. Nothing leaks a file path

test("errors, results, events and receipts never contain the objects folder, the temp HOME, or a storage_key", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("leak");
    const r = await put_ready(env, bytes, "lk");
    const row = blob_row_must(env.db, r.blob_id);
    const art = await new_artifact(env, "lk-art");
    await attach(env, art.version_id, r.blob_id, "image", "lk-a");

    const messages: string[] = [];
    const collect = async (p: Promise<unknown>) => {
      const e = await rejects_any(p);
      messages.push(e instanceof Error ? `${e.message} ${JSON.stringify(e)}` : String(e));
    };
    // missing file, tampered bytes, symlink, unknown blob, unsafe key
    const miss = await reserve(env, bytes_of("leak-miss"), "lk-m");
    await collect(complete(env, miss.blob_id, "lk-mc"));
    unlinkSync(disk_path(env, row));
    await collect(get_blob(env.store, env.p.project_id, r.blob_id));
    writeFileSync(disk_path(env, row), bytes_of("leak-evil"));
    await collect(get_blob(env.store, env.p.project_id, r.blob_id));
    unlinkSync(disk_path(env, row));
    symlinkSync(join(env.home.root, "nowhere"), disk_path(env, row));
    await collect(get_blob(env.store, env.p.project_id, r.blob_id));
    await collect(get_blob(env.store, env.p.project_id, "nope"));
    env.db.run("UPDATE blobs SET storage_key = '../escape' WHERE id = ?", miss.blob_id);
    await collect(store_blob(env.store, env.p.project_id, miss.blob_id, bytes_of("leak-miss")));
    await collect(complete(env, miss.blob_id, "lk-mc2"));

    const gc_out = await gc_orphans(env.service, env.store, env.ctx("lk-gc"), { grace_ms: GRACE });
    messages.push(JSON.stringify(gc_out));
    messages.push(dump_everything(env));

    const needles = [env.objects, row.storage_key, "../escape", env.home.root].filter(
      (n): n is string => typeof n === "string" && n.length > 0,
    );
    for (const text of messages) {
      for (const needle of needles) {
        assert.equal(text.includes(needle), false, `leaked ${needle} in: ${text.slice(0, 200)}`);
      }
    }
  });
});

test("the objects folder given to gc is never recorded in an event or a receipt", async () => {
  await with_env(async (env) => {
    await put_ready(env, bytes_of("gc-rec"), "gr");
    await gc_orphans(env.service, env.store, env.ctx("gr-gc"), { grace_ms: GRACE });
    const text = dump_everything(env);
    assert.equal(text.includes(env.objects), false);
    assert.equal(text.includes("objects_dir"), false);
    void MEDIA_TYPE;
  });
});

test("reserve_upload with a direct objects_dir or storage_key in the payload is rejected, as is a gc payload with a relative objects_dir", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("payload-dir");
    await rejects_api(
      reserve_upload(env.service, env.ctx("pd-1"), {
        sha256: sha256_hex(bytes),
        size: bytes.byteLength,
        media_type: MEDIA_TYPE,
        storage_key: "x/y",
      }),
      "invalid_payload",
    );
    await rejects_api(
      env.service.execute(env.ctx("pd-2"), "file.gc_orphans", { grace_ms: GRACE, objects_dir: "relative/dir" }),
      "invalid_payload",
    );
    await rejects_api(
      env.service.execute(env.ctx("pd-3"), "file.gc_orphans", { grace_ms: GRACE, objects_dir: 42 }),
      "invalid_payload",
    );
  });
});

test("a direct file.gc_orphans with an objects_dir elsewhere never deletes files there", async () => {
  await with_env(async (env) => {
    const outside = outside_dir();
    try {
      const victim = join(outside, env.p.project_id, "victim.bin");
      mkdirSync(dirname(victim), { recursive: true });
      writeFileSync(victim, "x");
      set_mtime(victim, env.clock.now_ms() - 10 * GRACE);
      await env.service.execute(env.ctx("dg-1"), "file.gc_orphans", { grace_ms: GRACE, objects_dir: outside });
      assert.ok(existsSync(victim), "the command only counts; byte deletion is the wrapper's job inside its own store");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

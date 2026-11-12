// SEL-42 (stage 2 PR9): result/object storage (blobs, version_files, file_policies), tests written
// before the implementation. Synthetic bytes only; every test uses a temporary HOME/PES_HOME and a FakeClock.
//
// ---------------------------------------------------------------------------------------------------
// INTERFACE THE WORKER MUST MATCH (leader decision; names/shapes below are what these tests call)
//
// DB writes live ONLY in the command definitions of scripts/pes_core/commands/files.ts, which exports a
// frozen CONTENT-style array FILE_COMMAND_ENTRIES of frozen [name, definition] tuples, spread into
// COMMANDS by commands.ts (like CONTENT_COMMAND_ENTRIES). All are scope "project", NOT rev-bearing,
// distinct `action`s. Unknown / missing payload fields -> ApiError "invalid_payload"; an id that does
// not exist OR belongs to another project -> "not_found"; a state that forbids the step -> "conflict".
// A rejection writes nothing (no row, no event, no receipt). The command set is closed (5 names):
//
//   file.reserve_upload   {sha256: 64 lowercase hex, size: integer >= 0, media_type: string,
//                          original_name?: string|null}
//                         Declares the bytes that will be uploaded and creates a `blobs` row in state
//                         'staging' (storage_key computed by the server, never given by the caller).
//                         Same project + same (sha256,size): NO second row. An existing 'staging' row is
//                         returned as is; an existing 'ready' row is returned with deduplicated: true.
//                         original_name is only a label: it never influences the disk location.
//                         result {project_id, blob_id, state: 'staging'|'ready', deduplicated: boolean}
//   file.complete_upload  {blob_id}   (public wrapper reads the stored bytes from disk, hashes them, and
//                          runs ONE service.execute; the command is the only DB writer)
//                         The stored file must match the declared sha256 AND size -> state 'ready'.
//                         A mismatch never becomes ready: the call either resolves with state
//                         'quarantined' (preferred) or rejects; afterwards the blob is 'quarantined' or
//                         still 'staging' (these tests accept both), never 'ready'.
//                         A blob that is already ready is a replay-style no-op or "conflict".
//                         result {project_id, blob_id, state: 'ready'|'quarantined'}
//   file.attach_version   {version_id, blob_id, role: attachment|image|source|rendered|manifest}
//                         blob must be 'ready' (else "conflict"), same project as the version (else
//                         "not_found"). Creates the blob's single `file_policies` row if it has none
//                         (every later attach of the same blob reuses it) and one `version_files` row.
//                         The same (version, blob, role) twice -> "conflict". Same blob on other versions
//                         or other roles is fine: one version_files row each (lineage per version).
//                         result {project_id, version_id, blob_id, role, file_policy_id}
//   file.quarantine       {blob_id, reason: string}   staging -> quarantined. A 'ready' blob that is
//                         linked by version_files is never quarantined ("conflict").
//                         result {project_id, blob_id, state: 'quarantined'}
//   file.gc_orphans       {grace_ms: integer >= 1}    one tx, project-scoped (ctx.project_id only).
//                         Removes (a) blobs rows in 'staging'/'quarantined' that no version_files row
//                         references, older than grace_ms by the command clock (age is measured from the
//                         command time of the reserving tx, i.e. the FakeClock; strictly older than
//                         grace_ms is deleted, younger is kept; the exact boundary is not tested),
//                         with their disk files (also when the file is already missing); (b) files under
//                         this project's folder in the objects dir that no blobs row names and whose
//                         mtime is older than grace_ms (compared with the command clock). Files are
//                         deleted only AFTER the transaction commits. A 'ready' blob is never deleted,
//                         linked or not. A 'ready' blob whose file is missing is NOT deleted: it is
//                         reported in missing_file_blob_ids.
//                         result {project_id, deleted_blob_ids: string[], orphan_files_removed: number,
//                                 missing_file_blob_ids: string[]}
//
// scripts/pes_core/files.ts (public functions; `FileStore = { db: Db; objects_dir: string }`):
//   reserve_upload(service, ctx, input)                 -> Promise<CommandOutcome>   one service.execute
//   complete_upload(service, store, ctx, {blob_id})     -> Promise<CommandOutcome>   one service.execute
//   attach_version(service, ctx, input)                 -> Promise<CommandOutcome>   one service.execute
//   quarantine(service, ctx, input)                     -> Promise<CommandOutcome>   one service.execute
//   gc_orphans(service, store, ctx, {grace_ms})         -> Promise<CommandOutcome>   one service.execute
//   store_blob(store, project_id, blob_id, bytes)       -> Promise<void|object>
//        writes the bytes of a 'staging' blob of THAT project to the path derived from the DB
//        storage_key. No DB write. Rejects: unknown / other-project / non-id input -> ApiError
//        "invalid_payload" or "not_found"; blob not 'staging' -> "conflict" (the file is untouched);
//        any unsafe location (symlinked objects dir or project folder, storage_key escaping the objects
//        dir, absolute key) -> rejects and writes nothing outside the objects dir; a failing write
//        leaves no stray temp file and the blob stays 'staging'.
//   get_blob(store, project_id, blob_id)                -> Promise<{blob_id, project_id, sha256, size,
//                                                          media_type, bytes: Uint8Array}>
//        only 'ready' blobs of that project (else "not_found"/"conflict"); re-hashes what it reads and
//        rejects when the file is missing, a symlink, or no longer matches sha256/size.
//   assert_project_access(db, project_id, blob_id)      -> sync; returns normally for an own blob,
//        throws ApiError "not_found" for an unknown id or another project's blob.
// Public results never contain a file path, storage_key, objects dir or URL.
// ---------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { COMMANDS, type CommandOutcome } from "../scripts/pes_core/commands.ts";
import { FILE_COMMAND_ENTRIES } from "../scripts/pes_core/commands/files.ts";
import {
  assert_project_access,
  attach_version,
  complete_upload,
  gc_orphans,
  get_blob,
  quarantine,
  reserve_upload,
  store_blob,
} from "../scripts/pes_core/files.ts";
import { sha256_hex, BINARY_BYTES, EMPTY_BYTES } from "./helpers/backup_fixture.ts";
import {
  MEDIA_TYPE,
  START_MS,
  attach,
  blob_row,
  blob_row_must,
  bytes_of,
  complete,
  disk_path,
  exists_on_disk,
  list_files,
  more_version,
  new_artifact,
  plant_bytes,
  put_ready,
  put_staging,
  receipts,
  reserve,
  rejects_any,
  rejects_api,
  second_project,
  with_env,
  wrap_db,
  type AttachResult,
  type CompleteResult,
  type Env,
  type GcResult,
} from "./helpers/blob_env.ts";
import { EXPECTED_COMMAND_NAMES, NAME_SHAPE_EXEMPT } from "./helpers/command_names.ts";
import { state_signature } from "./helpers/state_signature.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "..", "scripts", "pes_core");
const REPO = resolve(HERE, "..");
const GRACE = 3_600_000; // 1 hour
const ROLES = ["attachment", "image", "source", "rendered", "manifest"] as const;
const FILE_COMMANDS = [
  "file.ai_access_set",
  "file.attach_version",
  "file.complete_upload",
  "file.gc_orphans",
  "file.quarantine",
  "file.reserve_upload",
  "file.upload",
] as const;

function gc(env: Env, key: string, grace_ms = GRACE, svc = env.service): Promise<CommandOutcome> {
  return gc_orphans(svc, env.store, env.ctx(key), { grace_ms });
}

async function gc_result(env: Env, key: string, grace_ms = GRACE): Promise<GcResult> {
  return (await gc(env, key, grace_ms)).result as GcResult;
}

/** Files of this project's folder in the objects dir (relative to the objects dir). */
function project_files(env: Env): string[] {
  return list_files(env.objects).filter((f) => f.startsWith(`${env.p.project_id}/`));
}

function blob_count(env: Env, project_id = env.p.project_id): number {
  return Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM blobs WHERE project_id = ?", project_id)?.n ?? 0n);
}

function set_mtime(path: string, ms: number): void {
  utimesSync(path, ms / 1000, ms / 1000);
}

/** Write a file the DB knows nothing about, in this project's folder. */
function write_orphan_file(env: Env, label: string, mtime_ms: number): string {
  const bytes = bytes_of(`orphan-${label}`);
  const path = join(env.objects, env.p.project_id, sha256_hex(bytes));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  set_mtime(path, mtime_ms);
  return path;
}

/** Try the declared/stored mismatch path; return the final row. Accepts "rejected" or "quarantined". */
async function upload_mismatch(env: Env, declared: Uint8Array, stored: Uint8Array, key: string) {
  const r = await reserve(env, declared, `${key}-r`);
  // store_blob refuses mismatching bytes (SEL-42 review 1), so plant them as an outside writer would.
  plant_bytes(env, blob_row_must(env.db, r.blob_id), stored);
  try {
    const out = (await complete(env, r.blob_id, `${key}-c`)).result as CompleteResult;
    assert.notEqual(out.state, "ready");
  } catch (error) {
    assert.ok(error instanceof Error);
  }
  const row = blob_row_must(env.db, r.blob_id);
  assert.ok(row.state === "staging" || row.state === "quarantined", `mismatch must not be ready, got ${row.state}`);
  return { r, row };
}

// ---------------------------------------------------------------------------
// 1. Paths and signed URLs are never ids

test("honest upload round trip: reserve -> store -> complete -> get_blob returns the exact bytes", async () => {
  await with_env(async (env) => {
    for (const [label, bytes] of [
      ["text", bytes_of("rt-text")],
      ["binary", BINARY_BYTES],
      ["empty", EMPTY_BYTES],
      ["large", bytes_of("rt-large", 300_000)],
    ] as const) {
      const r = await reserve(env, bytes, `rt-${label}-r`);
      assert.equal(r.state, "staging");
      assert.equal(r.deduplicated, false);
      assert.equal(r.project_id, env.p.project_id);
      let row = blob_row_must(env.db, r.blob_id);
      assert.equal(row.state, "staging");
      assert.equal(row.sha256, sha256_hex(bytes));
      assert.equal(Number(row.size), bytes.byteLength);
      assert.equal(row.project_id, env.p.project_id);
      assert.equal(row.media_type, MEDIA_TYPE);

      await store_blob(env.store, env.p.project_id, r.blob_id, bytes);
      assert.equal(blob_row_must(env.db, r.blob_id).state, "staging", "storing bytes alone does not make a blob ready");

      const done = (await complete(env, r.blob_id, `rt-${label}-c`)).result as CompleteResult;
      assert.equal(done.state, "ready");
      row = blob_row_must(env.db, r.blob_id);
      assert.equal(row.state, "ready");
      assert.deepEqual(new Uint8Array(readFileSync(disk_path(env, row))), bytes, "the disk file is the exact bytes");

      const got = await get_blob(env.store, env.p.project_id, r.blob_id);
      assert.deepEqual(new Uint8Array(got.bytes), bytes);
      assert.equal(got.sha256, sha256_hex(bytes));
      assert.equal(Number(got.size), bytes.byteLength);
      assert.equal(got.media_type, MEDIA_TYPE);
    }
  });
});

test("public results never expose a file path, storage_key, objects folder or URL", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("nopath");
    const art = await new_artifact(env, "np-a");
    const r = await put_ready(env, bytes, "np");
    const row = blob_row_must(env.db, r.blob_id);
    const att = await attach(env, art.version_id, r.blob_id, "attachment", "np-att");
    const got = await get_blob(env.store, env.p.project_id, r.blob_id);
    const { bytes: _bytes, ...got_meta } = got as unknown as Record<string, unknown>;
    const old = await put_staging(env, bytes_of("np-old"), "np-old");
    env.clock.advance(GRACE + 10_000);
    const swept = await gc_result(env, "np-gc");
    assert.deepEqual(swept.deleted_blob_ids, [old.blob_id]);

    const forbidden = [row.storage_key, env.objects, env.home.root, "file://", "http://", "https://", "X-Amz", "signature="];
    const shown: Record<string, unknown> = { r, att, got_meta, swept };
    const text = JSON.stringify(shown);
    for (const needle of forbidden) assert.ok(!text.includes(needle), `public results must not contain ${needle}`);

    const bad_keys = new Set(["storage_key", "path", "file_path", "url", "signed_url", "objects_dir", "location"]);
    const walk = (value: unknown, where: string): void => {
      if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${where}[${i}]`));
      else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          assert.ok(!bad_keys.has(k), `${where}.${k} must not exist`);
          walk(v, `${where}.${k}`);
        }
      }
    };
    walk(shown, "result");

    assert.notEqual(r.blob_id, row.storage_key);
    assert.ok(!r.blob_id.includes(row.sha256), "the public id is not derived from the hash either");
    assert.ok(!r.blob_id.includes("/") && !r.blob_id.includes("\\"));
  });
});

test("a path, file URL, signed URL, or traversal string is rejected where a blob id is expected", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("pathid");
    const art = await new_artifact(env, "pi-a");
    const r = await put_ready(env, bytes, "pi");
    const row = blob_row_must(env.db, r.blob_id);
    const absolute = disk_path(env, row);
    const fake_ids = [
      row.storage_key,
      absolute,
      `file://${absolute}`,
      `https://example.test/blob/${r.blob_id}?X-Amz-Signature=abc123`,
      `../${row.storage_key}`,
      `${r.blob_id}/../${r.blob_id}`,
      "",
    ];
    const before = state_signature(env.db);
    const files_before = list_files(env.objects);
    for (const bad of fake_ids) {
      await rejects_api(get_blob(env.store, env.p.project_id, bad), "invalid_payload", "not_found");
      await rejects_api(store_blob(env.store, env.p.project_id, bad, bytes), "invalid_payload", "not_found");
      await rejects_api(complete(env, bad, `pi-c-${fake_ids.indexOf(bad)}`), "invalid_payload", "not_found");
      await rejects_api(
        attach_version(env.service, env.ctx(`pi-att-${fake_ids.indexOf(bad)}`), {
          version_id: art.version_id,
          blob_id: bad,
          role: "attachment",
        }),
        "invalid_payload",
        "not_found",
      );
      assert.throws(
        () => assert_project_access(env.db, env.p.project_id, bad),
        (e: unknown) => ["invalid_payload", "not_found"].includes((e as { code?: string } | null)?.code ?? ""),
      );
    }
    assert.equal(state_signature(env.db), before, "rejected calls change nothing");
    assert.deepEqual(list_files(env.objects), files_before);
  });
});

test("reserve_upload refuses caller-supplied locations and malformed declarations, writing nothing", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("resv-bad");
    const ok = { sha256: sha256_hex(bytes), size: bytes.byteLength, media_type: MEDIA_TYPE };
    const before = state_signature(env.db);
    const bad_payloads: unknown[] = [
      { ...ok, storage_key: "x/y" },
      { ...ok, path: "/tmp/x" },
      { ...ok, url: "https://example.test/x" },
      { ...ok, blob_id: "abc" },
      { ...ok, state: "ready" },
      { ...ok, sha256: ok.sha256.toUpperCase() },
      { ...ok, sha256: ok.sha256.slice(1) },
      { ...ok, sha256: `${ok.sha256.slice(0, 63)}g` },
      { ...ok, size: -1 },
      { ...ok, size: 1.5 },
      { ...ok, size: "3" },
      { sha256: ok.sha256, size: ok.size },
      { size: ok.size, media_type: MEDIA_TYPE },
      null,
      "not an object",
    ];
    for (const [i, payload] of bad_payloads.entries()) {
      await rejects_api(reserve_upload(env.service, env.ctx(`rb-${i}`), payload), "invalid_payload");
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("original_name is only a label: path-like names never move the file", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("label");
    const r = await reserve(env, bytes, "lbl-r", { original_name: "../../../evil/../../escape.txt" });
    const row = blob_row_must(env.db, r.blob_id);
    assert.ok(!row.storage_key.includes("escape") && !row.storage_key.includes(".."));
    assert.ok(!row.storage_key.startsWith("/") && !row.storage_key.includes("\\") && !/^[A-Za-z]:/.test(row.storage_key));
    await store_blob(env.store, env.p.project_id, r.blob_id, bytes);
    await complete(env, r.blob_id, "lbl-c");
    const inside = relative(env.objects, disk_path(env, row));
    assert.ok(!inside.startsWith("..") && !inside.startsWith("/"), "the stored file is inside the objects folder");
    const everything = list_files(env.home.root);
    assert.ok(!everything.some((f) => f.includes("escape.txt")), "nothing named after original_name exists");
  });
});

// ---------------------------------------------------------------------------
// 2. Corrupt bytes never become ready; other projects' blobs are unreachable

test("swapped bytes (same size, other content) never become ready and cannot be read or attached", async () => {
  await with_env(async (env) => {
    const declared = bytes_of("swap-a");
    const evil = Uint8Array.from(declared).map((b) => b ^ 0x5a);
    const art = await new_artifact(env, "sw-a");
    const { r, row } = await upload_mismatch(env, declared, evil, "sw");
    assert.equal(row.sha256, sha256_hex(declared), "the declared hash is kept, not replaced by the actual one");
    await rejects_api(get_blob(env.store, env.p.project_id, r.blob_id), "conflict", "not_found");
    await rejects_api(
      attach_version(env.service, env.ctx("sw-att"), { version_id: art.version_id, blob_id: r.blob_id, role: "attachment" }),
      "conflict",
    );
    assert.equal(version_files_count(env), 0);
    assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM file_policies")?.n, 0n);
  });
});

function version_files_count(env: Env): number {
  return Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM version_files")?.n ?? 0n);
}

test("a size mismatch (truncated, padded, empty) never becomes ready", async () => {
  await with_env(async (env) => {
    const declared = bytes_of("size", 64);
    const variants: [string, Uint8Array][] = [
      ["trunc", declared.slice(0, declared.byteLength - 1)],
      ["pad", Uint8Array.from([...declared, 0])],
      ["empty", new Uint8Array(0)],
    ];
    for (const [label, stored] of variants) {
      const bytes = bytes_of(`size-${label}`, 64);
      const { row } = await upload_mismatch(env, bytes, stored, `size-${label}`);
      assert.notEqual(row.state, "ready");
    }
    // the declared size is real too: a declaration of the right hash but a wrong size cannot be completed by right bytes
    const honest = bytes_of("size-lie", 10);
    const r = await reserve(env, honest, "size-lie-r", { size: honest.byteLength + 1 });
    await store_blob(env.store, env.p.project_id, r.blob_id, honest).catch(() => undefined);
    await complete(env, r.blob_id, "size-lie-c").catch(() => undefined);
    assert.notEqual(blob_row_must(env.db, r.blob_id).state, "ready");
  });
});

test("a mismatch is not retained as a ready copy under the real hash either", async () => {
  await with_env(async (env) => {
    const declared = bytes_of("noreuse-a");
    const other = bytes_of("noreuse-b");
    await upload_mismatch(env, declared, other, "nr");
    // uploading the honest bytes of `other` afterwards is a normal new blob, ready, and distinct
    const good = await put_ready(env, other, "nr-good");
    assert.equal(blob_row_must(env.db, good.blob_id).sha256, sha256_hex(other));
    // declaring `declared` again never yields a ready blob without matching bytes
    const again = await reserve(env, declared, "nr-again");
    assert.notEqual(again.state, "ready");
  });
});

test("bytes tampered on disk after ready are never served", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("tamper", 40);
    const r = await put_ready(env, bytes, "tp");
    const row = blob_row_must(env.db, r.blob_id);
    const path = disk_path(env, row);

    writeFileSync(path, Uint8Array.from(bytes).map((b, i) => (i === 3 ? b ^ 1 : b)));
    await rejects_any(get_blob(env.store, env.p.project_id, r.blob_id));

    writeFileSync(path, bytes.slice(0, bytes.byteLength - 2));
    await rejects_any(get_blob(env.store, env.p.project_id, r.blob_id));

    unlinkSync(path);
    await rejects_any(get_blob(env.store, env.p.project_id, r.blob_id));

    writeFileSync(path, bytes);
    const got = await get_blob(env.store, env.p.project_id, r.blob_id);
    assert.deepEqual(new Uint8Array(got.bytes), bytes, "restoring the exact bytes serves them again");
  });
});

test("a write failure while storing leaves the blob staging, no stray file, and a retry can succeed", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("wfail", 20);
    const r = await reserve(env, bytes, "wf-r");
    const row = blob_row_must(env.db, r.blob_id);
    const target = disk_path(env, row);
    mkdirSync(target, { recursive: true }); // a directory where the file must go: the write fails
    const files_before = list_files(env.objects);
    await rejects_any(store_blob(env.store, env.p.project_id, r.blob_id, bytes));
    assert.deepEqual(list_files(env.objects), files_before, "no partial or temporary file is left behind");
    assert.equal(blob_row_must(env.db, r.blob_id).state, "staging");
    await rejects_any(complete(env, r.blob_id, "wf-c"));
    assert.notEqual(blob_row_must(env.db, r.blob_id).state, "ready");

    rmSync(target, { recursive: true, force: true });
    await store_blob(env.store, env.p.project_id, r.blob_id, bytes);
    assert.equal(((await complete(env, r.blob_id, "wf-c2")).result as CompleteResult).state, "ready");
  });
});

test("complete_upload without any stored file never becomes ready", async () => {
  await with_env(async (env) => {
    const r = await reserve(env, bytes_of("nofile"), "nf-r");
    try {
      const out = (await complete(env, r.blob_id, "nf-c")).result as CompleteResult;
      assert.notEqual(out.state, "ready");
    } catch (error) {
      assert.ok(error instanceof Error);
    }
    assert.notEqual(blob_row_must(env.db, r.blob_id).state, "ready");
  });
});

test("store_blob only writes into a staging blob; a ready blob's file is never overwritten", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("immut");
    const r = await put_ready(env, bytes, "im");
    const row = blob_row_must(env.db, r.blob_id);
    await rejects_api(store_blob(env.store, env.p.project_id, r.blob_id, bytes_of("immut-evil")), "conflict");
    assert.deepEqual(new Uint8Array(readFileSync(disk_path(env, row))), bytes);
  });
});

test("another project's blob cannot be read, written, completed, attached, or checked", async () => {
  await with_env(async (env) => {
    const b = await second_project(env);
    const bytes = bytes_of("cross");
    const mine = await put_ready(env, bytes, "x-mine");
    const staged = await put_staging(env, bytes_of("cross-staged"), "x-stg");
    const art_b = await new_artifact({ ...env, ctx: (key) => ({ project_id: b.project_id, actor_id: b.actor_id, via: "cli", client_request_id: key }), p: b } as Env, "x-b");

    const before = state_signature(env.db);
    const files_before = list_files(env.objects);
    await rejects_api(get_blob(env.store, b.project_id, mine.blob_id), "not_found");
    await rejects_api(store_blob(env.store, b.project_id, staged.blob_id, bytes_of("cross-staged")), "not_found");
    await rejects_api(complete(env, staged.blob_id, "x-comp", b), "not_found");
    await rejects_api(
      attach_version(env.service, { project_id: b.project_id, actor_id: b.actor_id, via: "cli", client_request_id: "x-att" }, {
        version_id: art_b.version_id,
        blob_id: mine.blob_id,
        role: "attachment",
      }),
      "not_found",
    );
    assert.throws(() => assert_project_access(env.db, b.project_id, mine.blob_id), (e: unknown) => (e as { code?: string }).code === "not_found");
    assert.doesNotThrow(() => assert_project_access(env.db, env.p.project_id, mine.blob_id));
    assert.equal(state_signature(env.db), before, "denied cross-project calls change nothing");
    assert.deepEqual(list_files(env.objects), files_before);

    // my version cannot take B's blob either
    const art_a = await new_artifact(env, "x-a");
    const theirs = await put_ready(env, bytes_of("cross-theirs"), "x-theirs", b);
    await rejects_api(attach_version(env.service, env.ctx("x-att2"), { version_id: art_a.version_id, blob_id: theirs.blob_id, role: "attachment" }), "not_found");
    await rejects_api(get_blob(env.store, env.p.project_id, theirs.blob_id), "not_found");
    assert.equal(version_files_count(env), 0);
  });
});

test("symlinks and escaping storage keys are refused: nothing is written or read outside the objects folder", async () => {
  await with_env(async (env) => {
    const outside = join(env.home.root, "outside");
    mkdirSync(outside, { recursive: true });

    // (a) the project folder inside the objects dir is a symlink to somewhere else
    const bytes = bytes_of("sym-a");
    const r = await reserve(env, bytes, "sym-a-r");
    const row = blob_row_must(env.db, r.blob_id);
    const first = row.storage_key.split("/")[0]!;
    mkdirSync(env.objects, { recursive: true });
    symlinkSync(outside, join(env.objects, first), "dir");
    await rejects_any(store_blob(env.store, env.p.project_id, r.blob_id, bytes));
    assert.deepEqual(list_files(outside), [], "nothing was written through the symlinked folder");
    unlinkSync(join(env.objects, first));

    // (b) the objects dir itself is a symlink
    rmSync(env.objects, { recursive: true, force: true });
    symlinkSync(outside, env.objects, "dir");
    await rejects_any(store_blob(env.store, env.p.project_id, r.blob_id, bytes));
    assert.deepEqual(list_files(outside), []);
    unlinkSync(env.objects);
    mkdirSync(env.objects, { recursive: true });

    // (c) a tampered storage_key (traversal / absolute) is never followed
    for (const [i, key] of ["../../escape.bin", join(env.home.root, "abs-escape.bin"), "a/../../escape2.bin"].entries()) {
      const b2 = bytes_of(`sym-c-${i}`);
      const r2 = await reserve(env, b2, `sym-c-${i}-r`);
      env.db.run("UPDATE blobs SET storage_key = ? WHERE id = ?", key, r2.blob_id);
      await rejects_any(store_blob(env.store, env.p.project_id, r2.blob_id, b2));
      const stray = list_files(env.home.root).filter((f) => /escape/.test(f));
      assert.deepEqual(stray, [], `nothing was written outside the objects folder for key ${key}`);
    }

    // (d) a ready blob whose file became a symlink to an identical outside copy is not served
    const good = bytes_of("sym-d");
    const rd = await put_ready(env, good, "sym-d");
    const rowd = blob_row_must(env.db, rd.blob_id);
    const path = disk_path(env, rowd);
    const copy = join(outside, "copy.bin");
    writeFileSync(copy, good);
    unlinkSync(path);
    symlinkSync(copy, path, "file");
    await rejects_any(get_blob(env.store, env.p.project_id, rd.blob_id));
  });
});

// ---------------------------------------------------------------------------
// 3. Same bytes are stored once; lineage is per version

test("the same bytes are stored once in a project, while every version keeps its own version_files row", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("dedupe", 50);
    const first = await reserve(env, bytes, "dd-r1");
    const again_staging = await reserve(env, bytes, "dd-r2");
    assert.equal(again_staging.blob_id, first.blob_id, "a second reservation of staging bytes is the same blob");
    assert.equal(again_staging.state, "staging");
    assert.equal(blob_count(env), 1);

    await store_blob(env.store, env.p.project_id, first.blob_id, bytes);
    await complete(env, first.blob_id, "dd-c");
    const third = await reserve(env, bytes, "dd-r3");
    assert.equal(third.blob_id, first.blob_id);
    assert.equal(third.state, "ready");
    assert.equal(third.deduplicated, true);
    assert.equal(blob_count(env), 1, "one blobs row for the same sha256 and size");
    assert.equal(project_files(env).length, 1, "exactly one file on disk");
    await rejects_api(store_blob(env.store, env.p.project_id, third.blob_id, bytes), "conflict");
    assert.equal(project_files(env).length, 1);

    const a = await new_artifact(env, "dd-a");
    const a2 = await more_version(env, "dd-a2", a.object_id);
    const other = await new_artifact(env, "dd-b");
    const att1 = await attach(env, a.version_id, first.blob_id, "attachment", "dd-att1");
    const att2 = await attach(env, a2.version_id, first.blob_id, "attachment", "dd-att2");
    const att3 = await attach(env, other.version_id, first.blob_id, "image", "dd-att3");
    const att4 = await attach(env, a.version_id, first.blob_id, "source", "dd-att4"); // same version, other role
    const rows = env.db.all<{ version_id: string; role: string; file_policy_id: string }>(
      "SELECT version_id, role, file_policy_id FROM version_files WHERE blob_id = ? ORDER BY version_id, role",
      first.blob_id,
    );
    assert.equal(rows.length, 4, "one lineage row per (version, role)");
    assert.deepEqual(
      new Set(rows.map((r) => `${r.version_id}/${r.role}`)),
      new Set([`${a.version_id}/attachment`, `${a2.version_id}/attachment`, `${other.version_id}/image`, `${a.version_id}/source`]),
    );
    assert.equal(new Set([att1, att2, att3, att4].map((x: AttachResult) => x.file_policy_id)).size, 1, "all uses share the blob's one policy");
    assert.equal(
      env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM file_policies WHERE blob_id = ?", first.blob_id)?.n,
      1n,
      "a single file_policies row per blob",
    );
    assert.equal(project_files(env).length, 1, "attaching never copies bytes");

    await rejects_api(attach_version(env.service, env.ctx("dd-att-dup"), { version_id: a.version_id, blob_id: first.blob_id, role: "attachment" }), "conflict");
    assert.equal(
      env.db.all("SELECT 1 FROM version_files WHERE blob_id = ?", first.blob_id).length,
      4,
      "a duplicate (version, blob, role) writes nothing",
    );
  });
});

test("the same bytes in two projects are two blobs and two files; neither project sees the other", async () => {
  await with_env(async (env) => {
    const b = await second_project(env);
    const bytes = bytes_of("twoproj");
    const mine = await put_ready(env, bytes, "tp-a");
    const theirs = await put_ready(env, bytes, "tp-b", b);
    assert.notEqual(mine.blob_id, theirs.blob_id);
    assert.equal(theirs.deduplicated, false);
    const ra = blob_row_must(env.db, mine.blob_id);
    const rb = blob_row_must(env.db, theirs.blob_id);
    assert.notEqual(ra.storage_key, rb.storage_key);
    assert.notEqual(disk_path(env, ra), disk_path(env, rb));
    assert.equal(list_files(env.objects).length, 2);
    assert.equal(ra.project_id, env.p.project_id);
    assert.equal(rb.project_id, b.project_id);
  });
});

test("attach_version validates version, role and blob state", async () => {
  await with_env(async (env) => {
    const art = await new_artifact(env, "av-a");
    const ready = await put_ready(env, bytes_of("av-ready"), "av-ready");
    const staging = await put_staging(env, bytes_of("av-staging"), "av-staging");
    const before = state_signature(env.db);
    const call = (key: string, payload: unknown) => attach_version(env.service, env.ctx(key), payload);
    await rejects_api(call("av-1", { version_id: art.version_id, blob_id: ready.blob_id, role: "thumbnail" }), "invalid_payload");
    await rejects_api(call("av-2", { version_id: art.version_id, blob_id: ready.blob_id }), "invalid_payload");
    await rejects_api(call("av-3", { version_id: art.version_id, blob_id: ready.blob_id, role: "image", file_policy_id: "x" }), "invalid_payload");
    await rejects_api(call("av-4", { version_id: "no-such-version", blob_id: ready.blob_id, role: "image" }), "not_found");
    await rejects_api(call("av-5", { version_id: art.version_id, blob_id: "no-such-blob", role: "image" }), "not_found");
    await rejects_api(call("av-6", { version_id: art.version_id, blob_id: staging.blob_id, role: "image" }), "conflict");
    assert.equal(state_signature(env.db), before);
    const ok = await attach(env, art.version_id, ready.blob_id, "image", "av-ok");
    assert.equal(ok.role, "image");
    assert.equal(ok.version_id, art.version_id);
    assert.equal(ok.blob_id, ready.blob_id);
    assert.equal(ok.project_id, env.p.project_id);
  });
});

test("quarantine moves a staging blob aside and refuses to touch a ready linked blob", async () => {
  await with_env(async (env) => {
    const staged = await put_staging(env, bytes_of("q-stg"), "q-stg");
    const out = (await quarantine(env.service, env.ctx("q-1"), { blob_id: staged.blob_id, reason: "합성 사유" })).result as {
      state: string;
      blob_id: string;
    };
    assert.equal(out.state, "quarantined");
    assert.equal(blob_row_must(env.db, staged.blob_id).state, "quarantined");
    await rejects_api(get_blob(env.store, env.p.project_id, staged.blob_id), "conflict", "not_found");

    const art = await new_artifact(env, "q-a");
    const ready = await put_ready(env, bytes_of("q-ready"), "q-ready");
    await attach(env, art.version_id, ready.blob_id, "attachment", "q-att");
    const before = state_signature(env.db);
    await rejects_api(quarantine(env.service, env.ctx("q-2"), { blob_id: ready.blob_id, reason: "x" }), "conflict");
    assert.equal(state_signature(env.db), before);
    assert.equal(blob_row_must(env.db, ready.blob_id).state, "ready");
    await rejects_api(quarantine(env.service, env.ctx("q-3"), { blob_id: "no-such-blob", reason: "x" }), "not_found");
  });
});

// ---------------------------------------------------------------------------
// 4. Orphan and quarantined files are cleaned; ready+linked are never touched

test("gc keeps everything before the deadline, deletes stale unlinked files after it, and never touches ready+linked blobs", async () => {
  await with_env(async (env) => {
    const b = await second_project(env);
    const t0 = env.clock.now_ms();

    // things that exist at t0
    const staging_old = await put_staging(env, bytes_of("gc-stg-old"), "gc-stg-old");
    const nofile_old = await reserve(env, bytes_of("gc-nofile"), "gc-nofile"); // row, no file
    const { r: corrupt_old } = await upload_mismatch(env, bytes_of("gc-corrupt"), bytes_of("gc-corrupt-evil"), "gc-corrupt");
    const art = await new_artifact(env, "gc-art");
    const linked = await put_ready(env, bytes_of("gc-linked"), "gc-linked");
    await attach(env, art.version_id, linked.blob_id, "attachment", "gc-linked-att");
    const missing = await put_ready(env, bytes_of("gc-missing"), "gc-missing");
    await attach(env, art.version_id, missing.blob_id, "image", "gc-missing-att");
    unlinkSync(disk_path(env, blob_row_must(env.db, missing.blob_id)));
    const orphan_old = write_orphan_file(env, "old", t0);
    const b_stage = await reserve(env, bytes_of("gc-b"), "gc-b", {}, b);
    await store_blob(env.store, b.project_id, b_stage.blob_id, bytes_of("gc-b"));

    const staging_old_path = disk_path(env, blob_row_must(env.db, staging_old.blob_id));
    const old_ids = [staging_old.blob_id, nofile_old.blob_id, corrupt_old.blob_id];
    const linked_row = blob_row_must(env.db, linked.blob_id);
    const linked_bytes = new Uint8Array(readFileSync(disk_path(env, linked_row)));

    // before the deadline: nothing is removed
    env.clock.advance(GRACE - 5_000);
    const early = await gc_result(env, "gc-early");
    assert.deepEqual(early.deleted_blob_ids, []);
    assert.equal(early.orphan_files_removed, 0);
    for (const id of old_ids) assert.ok(blob_row(env.db, id), `${id} is kept before the deadline`);
    assert.ok(exists_on_disk(orphan_old), "a young-enough orphan file is kept");

    // fresh things created just before the deadline
    const staging_young = await put_staging(env, bytes_of("gc-stg-young"), "gc-stg-young");
    const orphan_young = write_orphan_file(env, "young", env.clock.now_ms());

    // after the deadline of the t0 things
    env.clock.advance(10_000);
    const late = await gc_result(env, "gc-late");
    assert.deepEqual([...late.deleted_blob_ids].sort(), [...old_ids].sort());
    assert.equal(late.orphan_files_removed, 1);
    for (const id of old_ids) assert.equal(blob_row(env.db, id), undefined, "the stale row is gone");
    assert.ok(!exists_on_disk(orphan_old), "the stale orphan file is gone");
    assert.ok(!exists_on_disk(staging_old_path), "its disk file is gone too");

    // young things and ready ones stay
    assert.ok(blob_row(env.db, staging_young.blob_id));
    assert.ok(exists_on_disk(orphan_young));
    assert.equal(blob_row_must(env.db, linked.blob_id).state, "ready");
    assert.deepEqual(new Uint8Array(readFileSync(disk_path(env, linked_row))), linked_bytes);
    assert.ok(blob_row(env.db, missing.blob_id), "a ready blob with a missing file is reported, never deleted");
    assert.ok(late.missing_file_blob_ids.includes(missing.blob_id));
    assert.ok(!late.missing_file_blob_ids.includes(linked.blob_id));
    await rejects_any(get_blob(env.store, env.p.project_id, missing.blob_id));

    // another project is never swept by this project's gc
    assert.ok(blob_row(env.db, b_stage.blob_id), "project B's old staging blob is not touched by project A's gc");
    assert.ok(exists_on_disk(disk_path(env, blob_row_must(env.db, b_stage.blob_id))));

    // running it again is a no-op
    const again = await gc_result(env, "gc-again");
    assert.deepEqual(again.deleted_blob_ids, []);
    assert.equal(again.orphan_files_removed, 0);

    // much later the young ones go too; the ready linked blob still stays, bytes intact
    env.clock.advance(100 * GRACE);
    const much_later = await gc_result(env, "gc-much-later");
    assert.deepEqual(much_later.deleted_blob_ids, [staging_young.blob_id]);
    assert.equal(much_later.orphan_files_removed, 1);
    assert.ok(!exists_on_disk(orphan_young));
    assert.equal(blob_row_must(env.db, linked.blob_id).state, "ready");
    const got = await get_blob(env.store, env.p.project_id, linked.blob_id);
    assert.deepEqual(new Uint8Array(got.bytes), linked_bytes);
    assert.equal(version_files_count(env), 2);
  });
});

test("gc handles a row without a file and a file without a row independently", async () => {
  await with_env(async (env) => {
    const row_only = await reserve(env, bytes_of("rowonly"), "ro-r");
    const file_only = write_orphan_file(env, "fileonly", env.clock.now_ms());
    const both = await put_staging(env, bytes_of("both"), "both");
    const both_path = disk_path(env, blob_row_must(env.db, both.blob_id));
    env.clock.advance(GRACE + 10_000);
    const out = await gc_result(env, "ro-gc");
    assert.deepEqual([...out.deleted_blob_ids].sort(), [row_only.blob_id, both.blob_id].sort());
    assert.equal(out.orphan_files_removed, 1);
    assert.ok(!exists_on_disk(file_only));
    assert.ok(!exists_on_disk(both_path));
    assert.deepEqual(project_files(env), []);
    assert.equal(blob_count(env), 0);
  });
});

test("gc validates grace_ms and an invalid call deletes nothing", async () => {
  await with_env(async (env) => {
    await put_staging(env, bytes_of("gcv"), "gcv");
    env.clock.advance(100 * GRACE);
    const before = state_signature(env.db);
    const files = list_files(env.objects);
    for (const [i, bad] of [{}, { grace_ms: 0 }, { grace_ms: -5 }, { grace_ms: 1.5 }, { grace_ms: "60" }, { grace_ms: GRACE, extra: 1 }, null].entries()) {
      await rejects_api(gc_orphans(env.service, env.store, env.ctx(`gcv-${i}`), bad), "invalid_payload");
    }
    assert.equal(state_signature(env.db), before);
    assert.deepEqual(list_files(env.objects), files);
  });
});

// ---------------------------------------------------------------------------
// 5. Adopted / saved / shared / printed versions are all preserved

test("every kind of version file (all five roles, current and older versions) survives gc for ever", async () => {
  await with_env(async (env) => {
    const art = await new_artifact(env, "keep-a");
    const kept: { id: string; bytes: Uint8Array }[] = [];
    let version_id = art.version_id;
    for (const [i, role] of ROLES.entries()) {
      if (i > 0) version_id = (await more_version(env, `keep-v${i}`, art.object_id)).version_id; // older versions stay linked
      const bytes = bytes_of(`keep-${role}`, 10 + i);
      const r = await put_ready(env, bytes, `keep-${role}`);
      await attach(env, version_id, r.blob_id, role, `keep-att-${role}`);
      kept.push({ id: r.blob_id, bytes });
    }
    // a ready blob linked to two versions of two objects
    const other = await new_artifact(env, "keep-b");
    await attach(env, other.version_id, kept[0]!.id, "image", "keep-shared");

    env.clock.advance(400 * 24 * 3_600_000);
    for (const grace of [1, GRACE]) {
      const out = await gc_result(env, `keep-gc-${grace}`, grace);
      assert.deepEqual(out.deleted_blob_ids, []);
      assert.equal(out.orphan_files_removed, 0);
      assert.deepEqual(out.missing_file_blob_ids, []);
    }
    for (const { id, bytes } of kept) {
      assert.equal(blob_row_must(env.db, id).state, "ready");
      const got = await get_blob(env.store, env.p.project_id, id);
      assert.deepEqual(new Uint8Array(got.bytes), bytes);
    }
    assert.equal(version_files_count(env), ROLES.length + 1);
    assert.equal(project_files(env).length, ROLES.length);
  });
});

// ---------------------------------------------------------------------------
// 6. The PR4 rules for the new commands, and disk-write-then-DB-failure leftovers

interface Case {
  name: (typeof FILE_COMMANDS)[number];
  prepare(env: Env): Promise<Record<string, string>>;
  call(env: Env, ids: Record<string, string>, key: string, svc?: Env["service"]): Promise<CommandOutcome>;
  other(env: Env, ids: Record<string, string>, key: string): Promise<CommandOutcome>;
  /** Extra checks after a failed attempt (disk must be unchanged). */
}

function decl(bytes: Uint8Array) {
  return { sha256: sha256_hex(bytes), size: bytes.byteLength, media_type: MEDIA_TYPE };
}

const CASES: Case[] = [
  {
    name: "file.reserve_upload",
    prepare: async () => ({}),
    call: (env, _ids, key, svc = env.service) => reserve_upload(svc, env.ctx(key), decl(bytes_of("m-res-a"))),
    other: (env, _ids, key) => reserve_upload(env.service, env.ctx(key), decl(bytes_of("m-res-b"))),
  },
  {
    name: "file.complete_upload",
    prepare: async (env) => ({
      a: (await put_staging(env, bytes_of("m-comp-a"), "m-comp-a")).blob_id,
      b: (await put_staging(env, bytes_of("m-comp-b"), "m-comp-b")).blob_id,
    }),
    call: (env, ids, key, svc = env.service) => complete_upload(svc, env.store, env.ctx(key), { blob_id: ids.a! }),
    other: (env, ids, key) => complete_upload(env.service, env.store, env.ctx(key), { blob_id: ids.b! }),
  },
  {
    name: "file.attach_version",
    prepare: async (env) => ({
      blob: (await put_ready(env, bytes_of("m-att"), "m-att")).blob_id,
      version: (await new_artifact(env, "m-att-a")).version_id,
    }),
    call: (env, ids, key, svc = env.service) =>
      attach_version(svc, env.ctx(key), { version_id: ids.version!, blob_id: ids.blob!, role: "attachment" }),
    other: (env, ids, key) => attach_version(env.service, env.ctx(key), { version_id: ids.version!, blob_id: ids.blob!, role: "image" }),
  },
  {
    name: "file.quarantine",
    prepare: async (env) => ({
      a: (await put_staging(env, bytes_of("m-q-a"), "m-q-a")).blob_id,
      b: (await put_staging(env, bytes_of("m-q-b"), "m-q-b")).blob_id,
    }),
    call: (env, ids, key, svc = env.service) => quarantine(svc, env.ctx(key), { blob_id: ids.a!, reason: "합성 사유" }),
    other: (env, ids, key) => quarantine(env.service, env.ctx(key), { blob_id: ids.b!, reason: "합성 사유" }),
  },
  {
    name: "file.gc_orphans",
    prepare: async (env) => {
      const stale = await put_staging(env, bytes_of("m-gc-stale"), "m-gc-stale");
      env.clock.advance(GRACE + 10_000);
      return { stale: stale.blob_id };
    },
    call: (env, _ids, key, svc = env.service) => gc(env, key, GRACE, svc),
    other: (env, _ids, key) => gc(env, key, GRACE + 1),
  },
];

function receipt_action(env: Env, key: string): string | undefined {
  return env.db.get<{ action: string }>(
    "SELECT action FROM mutation_commits WHERE project_id = ? AND client_request_id = ?",
    env.p.project_id,
    key,
  )?.action;
}

for (const c of CASES) {
  test(`${c.name}: success leaves exactly one receipt with this action and at least one event in the same tx`, async () => {
    await with_env(async (env) => {
      const ids = await c.prepare(env);
      const before = receipts(env.db, env.p.project_id, COMMANDS.get(c.name)!.action);
      const out = await c.call(env, ids, "k-1");
      assert.equal(out.replayed, false);
      assert.equal((out.result as { project_id: string }).project_id, env.p.project_id);
      assert.equal(receipts(env.db, env.p.project_id, COMMANDS.get(c.name)!.action), before + 1);
      assert.equal(receipt_action(env, "k-1"), COMMANDS.get(c.name)!.action);
      const tx = env.db.get<{ id: string }>(
        "SELECT id FROM mutation_commits WHERE project_id = ? AND client_request_id = ?",
        env.p.project_id,
        "k-1",
      );
      assert.ok(tx);
      const events = env.db.all("SELECT 1 FROM events WHERE tx_id = ?", tx.id);
      assert.ok(events.length >= 1, "the change recorded an event in its tx");
    });
  });

  test(`${c.name}: the same key and request replays without writing; a different request under that key is rejected`, async () => {
    await with_env(async (env) => {
      const ids = await c.prepare(env);
      const first = await c.call(env, ids, "k-1");
      const sig = state_signature(env.db);
      const files = list_files(env.objects);
      const replay = await c.call(env, ids, "k-1");
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.result, first.result);
      assert.equal(state_signature(env.db), sig);
      assert.deepEqual(list_files(env.objects), files, "a replay touches no file");
      await rejects_api(c.other(env, ids, "k-1"), "idempotency_key_reuse");
      assert.equal(state_signature(env.db), sig);
    });
  });

  test(`${c.name}: the policy check runs before replay and before any write`, async () => {
    await with_env(async (env) => {
      const ids = await c.prepare(env);
      const before = state_signature(env.db);
      const files = list_files(env.objects);
      env.policy.allowed = false;
      env.policy.calls = 0;
      await rejects_api(c.call(env, ids, "k-denied"), "policy_denied");
      assert.equal(env.policy.calls, 1);
      assert.equal(state_signature(env.db), before, "a denied command writes nothing");
      assert.deepEqual(list_files(env.objects), files, "a denied command touches no file");
      env.policy.allowed = true;

      await c.call(env, ids, "k-1");
      const sig = state_signature(env.db);
      env.policy.allowed = false;
      await rejects_api(c.call(env, ids, "k-1"), "policy_denied"); // no replay of a finished request once OFF
      await rejects_api(c.other(env, ids, "k-1"), "policy_denied"); // not key-reuse either
      assert.equal(state_signature(env.db), sig);
    });
  });

  test(`${c.name}: an unknown or missing payload field is rejected and leaves no receipt`, async () => {
    await with_env(async (env) => {
      await c.prepare(env);
      const before = state_signature(env.db);
      await rejects_api(env.service.execute(env.ctx("k-bad"), c.name, { unexpected_field: 1 }), "invalid_payload");
      await rejects_api(env.service.execute(env.ctx("k-bad"), c.name, null), "invalid_payload");
      assert.equal(state_signature(env.db), before);
      assert.equal(receipt_action(env, "k-bad"), undefined);
    });
  });

  for (const [label, table] of [
    ["event insert", "events"],
    ["receipt insert", "mutation_commits"],
  ] as const) {
    test(`${c.name}: a failing ${label} rolls everything back, leaves the disk as it was, and the key stays usable`, async () => {
      await with_env(async (env) => {
        const ids = await c.prepare(env);
        const before = state_signature(env.db);
        const files = list_files(env.objects);
        const re = new RegExp(`insert\\s+into\\s+${table}`, "i");
        const failing = env.with_db(
          wrap_db(env.db, (sql) => {
            if (re.test(sql)) throw new Error(`injected ${label} failure`);
            return undefined;
          }),
        );
        await rejects_any(c.call(env, ids, "k-fail", failing));
        assert.equal(state_signature(env.db), before, "no business row, event or receipt remains");
        assert.equal(receipt_action(env, "k-fail"), undefined);
        assert.deepEqual(list_files(env.objects), files, "a failed transaction deletes or creates no file (gc files go only after commit)");
        const retry = await c.call(env, ids, "k-fail");
        assert.equal(retry.replayed, false);
      });
    });
  }
}

test("bytes written to disk before a failed complete transaction stay staging, and gc later sweeps them", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("leftover", 30);
    const r = await reserve(env, bytes, "lo-r");
    await store_blob(env.store, env.p.project_id, r.blob_id, bytes); // disk write happened
    const before = state_signature(env.db);
    const failing = env.with_db(
      wrap_db(env.db, (sql) => {
        if (/update\s+blobs/i.test(sql) || /insert\s+into\s+events/i.test(sql)) throw new Error("injected tx failure");
        return undefined;
      }),
    );
    await rejects_any(complete_upload(failing, env.store, env.ctx("lo-c"), { blob_id: r.blob_id }));
    assert.equal(state_signature(env.db), before, "the failed tx left the DB exactly as before");
    const row = blob_row_must(env.db, r.blob_id);
    assert.equal(row.state, "staging", "the blob is still staging, never half ready");
    assert.ok(exists_on_disk(disk_path(env, row)), "the written file is still there");

    // before the deadline gc keeps it (a retry may still come) ...
    env.clock.advance(GRACE - 5_000);
    assert.deepEqual((await gc_result(env, "lo-gc1")).deleted_blob_ids, []);
    assert.ok(exists_on_disk(disk_path(env, row)));
    // ... after the deadline it is swept together with its file
    env.clock.advance(10_000);
    const swept = await gc_result(env, "lo-gc2");
    assert.deepEqual(swept.deleted_blob_ids, [r.blob_id]);
    assert.equal(blob_row(env.db, r.blob_id), undefined);
    assert.ok(!exists_on_disk(disk_path(env, row)));
    assert.deepEqual(project_files(env), []);
  });
});

test("after a failed complete transaction the same bytes can still be completed (retry reaches ready)", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("retry", 30);
    const r = await reserve(env, bytes, "rt-r");
    await store_blob(env.store, env.p.project_id, r.blob_id, bytes);
    const failing = env.with_db(
      wrap_db(env.db, (sql) => {
        if (/insert\s+into\s+mutation_commits/i.test(sql)) throw new Error("injected receipt failure");
        return undefined;
      }),
    );
    await rejects_any(complete_upload(failing, env.store, env.ctx("rt-c"), { blob_id: r.blob_id }));
    const retry = await complete(env, r.blob_id, "rt-c");
    assert.equal(retry.replayed, false);
    assert.equal((retry.result as CompleteResult).state, "ready");
  });
});

test("a failing reserve transaction leaves no blobs row and the same declaration can be reserved again", async () => {
  await with_env(async (env) => {
    const bytes = bytes_of("resv-fail");
    const before = state_signature(env.db);
    const failing = env.with_db(
      wrap_db(env.db, (sql) => {
        if (/insert\s+into\s+blobs/i.test(sql)) throw new Error("injected blobs failure");
        return undefined;
      }),
    );
    await rejects_any(reserve_upload(failing, env.ctx("rf-r"), decl(bytes)));
    assert.equal(state_signature(env.db), before);
    assert.equal(blob_count(env), 0);
    const ok = await reserve(env, bytes, "rf-r");
    assert.equal(ok.state, "staging");
    assert.equal(blob_count(env), 1);
  });
});

// ---------------------------------------------------------------------------
// Registry and static checks

test("the file commands are registered, project-scoped, not rev-bearing, with distinct actions, and nothing else is file.*", () => {
  const actions = new Set<string>();
  for (const name of FILE_COMMANDS) {
    const def = COMMANDS.get(name);
    assert.ok(def, `${name} is registered`);
    assert.equal(def.scope, "project");
    assert.equal(def.rev_bearing, false);
    actions.add(def.action);
  }
  assert.equal(actions.size, FILE_COMMANDS.length);
  const extra = [...COMMANDS.keys()].filter((k) => k.startsWith("file.") && !(FILE_COMMANDS as readonly string[]).includes(k));
  assert.deepEqual(extra, [], "the file command set is closed");
});

test("file command entries are a frozen list of frozen tuples, and COMMANDS hands out those very definitions", () => {
  assert.equal(Object.isFrozen(FILE_COMMAND_ENTRIES), true);
  assert.deepEqual(FILE_COMMAND_ENTRIES.map((e: readonly [string, unknown]) => e[0]).sort(), [...FILE_COMMANDS]);
  for (const entry of FILE_COMMAND_ENTRIES) {
    assert.equal(Object.isFrozen(entry), true, `${entry[0]} tuple is frozen`);
    assert.equal(Object.isFrozen(entry[1]), true, `${entry[0]} definition is frozen`);
    assert.equal(COMMANDS.get(entry[0]), entry[1]);
  }
  assert.throws(() => (FILE_COMMAND_ENTRIES as unknown as unknown[]).push(["x", {}]), TypeError);
});

test("the full registry lists exactly the expected names, file.* included", () => {
  assert.deepEqual([...COMMANDS.keys()].sort(), [...EXPECTED_COMMAND_NAMES]);
  for (const name of FILE_COMMANDS) assert.ok(EXPECTED_COMMAND_NAMES.includes(name), `${name} is in the expected list`);
});

test("there is no command that deletes, rewrites, or exposes paths of blobs, file policies or version files", () => {
  const bad = /(update|delete|remove|overwrite|replace|rewrite|patch|truncate|purge|path|url|sign).*(blob|file_polic|version_file)|\.(insert|update|delete|upsert|sql|exec|crud)$/i;
  assert.deepEqual([...COMMANDS.keys()].filter((k) => !NAME_SHAPE_EXEMPT.includes(k) && bad.test(k)), []); // exempt: see command_names.ts
});

function ts_files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...ts_files(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

function strip_comments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("only commands/files.ts (and the backup importer) write the blobs, version_files and file_policies tables", () => {
  const re = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+["`[]?(?:blobs|version_files|file_policies|file_ai_access_versions)\b/gi;
  const allowed = new Set(["commands/files.ts", "backup.ts"]);
  const violations: string[] = [];
  const files = ts_files(CORE_DIR);
  assert.ok(files.some((f) => relative(CORE_DIR, f).replace(/\\/g, "/") === "commands/files.ts"), "commands/files.ts exists");
  for (const file of files) {
    const rel = relative(CORE_DIR, file).replace(/\\/g, "/");
    if (allowed.has(rel)) continue;
    const source = strip_comments(readFileSync(file, "utf8"));
    for (const m of source.matchAll(re)) violations.push(`${rel}: ${m[0].replace(/\s+/g, " ")}`);
  }
  assert.deepEqual(violations, []);
});

test("scripts/pes_core/files.ts holds no SQL writes, and each state-changing function is exactly one service.execute", () => {
  const source = strip_comments(readFileSync(join(CORE_DIR, "files.ts"), "utf8"));
  assert.doesNotMatch(source, /\b(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|REPLACE\s+INTO)\b/i);
  for (const fn of ["reserve_upload", "store_blob", "complete_upload", "get_blob", "gc_orphans", "assert_project_access", "attach_version", "quarantine"]) {
    assert.match(source, new RegExp(`export\\s+(async\\s+)?function\\s+${fn}\\b`), `${fn} is exported`);
  }
  assert.equal((source.match(/\.execute\(/g) ?? []).length, 5, "exactly one service.execute per command wrapper");
});

test("the repository's frozen file command names stay in sync with the shared expected list", () => {
  const listed = EXPECTED_COMMAND_NAMES.filter((n) => n.startsWith("file."));
  assert.deepEqual([...listed], [...FILE_COMMANDS]);
  assert.equal(START_MS, 1_760_000_000_000);
  assert.ok(REPO.length > 0);
});

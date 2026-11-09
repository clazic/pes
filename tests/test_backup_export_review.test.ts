// SEL-36 (stage 2 PR3) regression tests for the final review (.ai-review-final.md):
//   1. rejected manifest paths must never be opened/read (no outside-file read, no content leak)
//   2. DB-global events.event_seq must be re-numbered on import (and event references remapped)
//   3. project_references to a project missing in the target become source_missing
//   4. partially written object files are cleaned up on failure; EEXIST files are kept
//   5. export out_dir that is a symlink is refused as object_path_unsafe
// Synthetic data only, isolated temp root.

import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { BackupError, export_project, import_bundle, verify_bundle, type Manifest } from "../scripts/pes_core/backup.ts";
import type { BootstrapResult } from "../scripts/pes_core/bootstrap.ts";
import type { Db } from "../scripts/pes_core/db.ts";
import {
  close_world,
  list_tree,
  make_world,
  meta_of,
  project_rows,
  source_rows_in_target_numbering,
  type World,
} from "./helpers/backup_fixture.ts";
import { isolated_home } from "./helpers/isolated_home.ts";
import { state_signature } from "./helpers/state_signature.ts";

function with_world(fn: (world: World) => void): void {
  const home = isolated_home("pes-sel36r-");
  const world = make_world(home);
  try {
    fn(world);
  } finally {
    close_world(world);
    home.cleanup();
  }
}

function export_project_to(world: World, project: BootstrapResult, name: string): { dir: string; manifest: Manifest } {
  const dir = join(world.bundles, name);
  const result = export_project(world.src, world.src_objects, project.project_id, dir);
  return { dir, manifest: result.manifest };
}

function target_state(world: World) {
  return { signature: state_signature(world.tgt), meta: meta_of(world.tgt), objects: list_tree(world.tgt_objects) };
}

function error_of(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Every entry (files and folders) below dir, relative POSIX paths. */
function all_entries(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      out.push(rel);
      if (entry.isDirectory()) walk(join(current, entry.name), rel);
    }
  };
  walk(dir, "");
  return out.sort();
}

type FsKey = "readFileSync" | "openSync" | "writeFileSync" | "writeSync";

/** Replace fs functions (and the ESM named exports) until restore() is called. */
function patch_fs(replacements: Partial<Record<FsKey, (...args: any[]) => unknown>>): () => void {
  const target = fs as unknown as Record<string, unknown>;
  const originals: Partial<Record<FsKey, unknown>> = {};
  for (const [name, replacement] of Object.entries(replacements)) {
    originals[name as FsKey] = target[name];
    target[name] = replacement;
  }
  syncBuiltinESMExports();
  return () => {
    for (const [name, original] of Object.entries(originals)) target[name] = original;
    syncBuiltinESMExports();
  };
}

// ---------------------------------------------------------------------------
// 1. rejected rows path is never read
// ---------------------------------------------------------------------------

const CANARY = "SYNTHETIC_PRIVATE_CANARY";

function bundle_with_escaping_rows_path(world: World): { dir: string; outside: string } {
  const { dir, manifest } = export_project_to(world, world.a, "escape");
  const outside = join(world.bundles, "outside.json"); // = <dir>/rows/../../outside.json
  writeFileSync(outside, `${CANARY} not json at all`);
  manifest.files.push({ path: "rows/../../outside.json", sha256: "0".repeat(64), size: 24 });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { dir, outside };
}

function count_outside_reads(outside: string, fn: () => void): number {
  const target = resolve(outside);
  let reads = 0;
  const original_read = fs.readFileSync;
  const original_open = fs.openSync;
  const touches = (path: unknown): boolean => {
    if (typeof path === "number") return false;
    try {
      return resolve(String(path)) === target;
    } catch {
      return false;
    }
  };
  const restore = patch_fs({
    readFileSync: (path: unknown, ...rest: unknown[]) => {
      if (touches(path)) reads += 1;
      return (original_read as (...args: unknown[]) => unknown)(path, ...rest);
    },
    openSync: (path: unknown, ...rest: unknown[]) => {
      if (touches(path)) reads += 1;
      return (original_open as (...args: unknown[]) => unknown)(path, ...rest);
    },
  });
  try {
    fn();
  } finally {
    restore();
  }
  return reads;
}

test("verify_bundle reports path_unsafe for rows/../../outside.json without ever reading the outside file or leaking its content", () => {
  with_world((world) => {
    const { dir, outside } = bundle_with_escaping_rows_path(world);
    let result: ReturnType<typeof verify_bundle> | undefined;
    const reads = count_outside_reads(outside, () => {
      result = verify_bundle(dir);
    });
    assert.ok(result);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.code === "path_unsafe"), JSON.stringify(result.problems));
    assert.equal(reads, 0, "the file outside the bundle must not be opened or read");
    assert.ok(!JSON.stringify(result.problems).includes(CANARY), "problem messages must not contain outside file content");
    assert.ok(!JSON.stringify(result.problems).includes("SYNTHETIC_"), "not even a prefix of the outside content");
  });
});

test("import_bundle with a rejected rows path never reads the outside file, leaks nothing, and changes nothing", () => {
  with_world((world) => {
    const { dir, outside } = bundle_with_escaping_rows_path(world);
    const before = target_state(world);
    let error: unknown;
    const reads = count_outside_reads(outside, () => {
      error = error_of(() => import_bundle(world.tgt, world.tgt_objects, dir));
    });
    assert.ok(error instanceof BackupError, String(error));
    assert.equal(reads, 0, "the file outside the bundle must not be opened or read");
    const text = `${error.message} ${JSON.stringify(error.problems)}`;
    assert.ok(!text.includes("SYNTHETIC_"), `error text leaked outside content: ${text}`);
    assert.ok(error.problems.some((problem) => problem.code === "path_unsafe") || error.code === "path_unsafe" || /path_unsafe/.test(text));
    assert.deepEqual(target_state(world), before);
  });
});

// ---------------------------------------------------------------------------
// 2. event_seq is DB-global: renumber on import, remap references
// ---------------------------------------------------------------------------

function insert_event(db: Db, project: BootstrapResult, tx_index: number, tx_size: number, type: string): { id: string; seq: bigint } {
  const id = globalThis.crypto.randomUUID();
  db.run(
    `INSERT INTO events (id, project_id, tx_id, tx_index, tx_size, type, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1760000000000)`,
    id,
    project.project_id,
    project.tx_id,
    tx_index + 1, // index 0 of the project's tx is the bootstrap project.created event
    tx_size + 1,
    type,
  );
  const row = db.get<{ event_seq: bigint }>("SELECT event_seq FROM events WHERE id = ?", id);
  assert.ok(row);
  return { id, seq: BigInt(row.event_seq) };
}

function insert_snapshot(db: Db, project: BootstrapResult, blob_id: string, through: bigint | null): string {
  const id = globalThis.crypto.randomUUID();
  db.run(
    `INSERT INTO snapshots (id, project_id, edition_id, scope, manifest_blob_id, through_event_seq, control_rev, content_hash)
     VALUES (?, ?, ?, 'edition', ?, ?, 0, ?)`,
    id,
    project.project_id,
    project.edition_id,
    blob_id,
    through,
    "a".repeat(64),
  );
  return id;
}

test("A imports alone when source and target both have events with overlapping event_seq; new numbers are assigned and event references follow", () => {
  with_world((world) => {
    // Source: B has event 1, A has events 2 and 3 (A's second event is referenced by a stage, first by a snapshot).
    // (bootstrap already wrote one project.created event per project on each side)
    insert_event(world.src, world.b, 0, 1, "synthetic.b");
    const a1 = insert_event(world.src, world.a, 0, 2, "synthetic.a1");
    const a2 = insert_event(world.src, world.a, 1, 2, "synthetic.a2");
    assert.ok(a1.seq > 1n && a2.seq > a1.seq);
    world.src.run("UPDATE stages SET stale_since_event_seq = ? WHERE id = ?", a2.seq, world.a.stage_ids.research);
    const snapshot_id = insert_snapshot(world.src, world.a, world.a_blobs[0]!.id, a1.seq);

    // Target: C already has its bootstrap event (1) plus three more, so source numbers collide with C's.
    const c_events = [0, 1, 2].map((i) => insert_event(world.tgt, world.c, i, 3, `synthetic.c${i}`));
    assert.deepEqual(c_events.map((e) => e.seq), [2n, 3n, 4n]);

    const { dir } = export_project_to(world, world.a, "events");
    assert.equal(verify_bundle(dir).ok, true);

    const a_source_rows = project_rows(world.src, world.a.project_id, world.a.owner_user_id);
    const c_before = project_rows(world.tgt, world.c.project_id, world.c.owner_user_id);
    const c_event_rows_before = JSON.stringify(world.tgt.all("SELECT * FROM events WHERE project_id = ? ORDER BY event_seq", world.c.project_id), (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
    const epoch_before = meta_of(world.tgt).cursor_epoch;

    const result = import_bundle(world.tgt, world.tgt_objects, dir);
    assert.equal(result.project_id, world.a.project_id);
    assert.ok(meta_of(world.tgt).cursor_epoch > epoch_before, "epoch must still rise");

    // Imported events: same ids, new numbers that do not collide with C's, order preserved.
    const imported = world.tgt.all<{ id: string; event_seq: bigint }>(
      "SELECT id, event_seq FROM events WHERE project_id = ? ORDER BY event_seq",
      world.a.project_id,
    );
    const src_ids = world.src
      .all<{ id: string }>("SELECT id FROM events WHERE project_id = ? ORDER BY event_seq", world.a.project_id)
      .map((row) => row.id);
    assert.equal(src_ids.length, 3, "bootstrap event plus two synthetic ones");
    assert.deepEqual(imported.map((row) => row.id), src_ids, "all of A's events imported, source order preserved");
    const new1 = imported.find((row) => row.id === a1.id)!.event_seq;
    const new2 = imported.find((row) => row.id === a2.id)!.event_seq;
    const target_max_before = c_events[c_events.length - 1]!.seq;
    for (const row of imported) {
      const seq = BigInt(row.event_seq);
      assert.ok(!c_events.some((e) => e.seq === seq) && seq !== 1n, `new seq ${seq} collides with an existing target event`);
      assert.ok(seq > target_max_before, `new number ${seq} comes after the target's existing ones`);
    }

    // References follow the same mapping.
    const stage = world.tgt.get<{ stale_since_event_seq: bigint | null }>(
      "SELECT stale_since_event_seq FROM stages WHERE id = ?",
      world.a.stage_ids.research,
    );
    assert.equal(stage?.stale_since_event_seq === null ? null : BigInt(stage!.stale_since_event_seq!), BigInt(new2));
    const snapshot = world.tgt.get<{ through_event_seq: bigint | null }>("SELECT through_event_seq FROM snapshots WHERE id = ?", snapshot_id);
    assert.equal(snapshot?.through_event_seq === null ? null : BigInt(snapshot!.through_event_seq!), BigInt(new1));

    // Whole project: order-preserving mapping; every event_seq reference follows it; other columns strictly equal.
    const moved = source_rows_in_target_numbering(a_source_rows, project_rows(world.tgt, world.a.project_id, world.a.owner_user_id));
    assert.equal(moved.mapping.get(a1.seq), BigInt(new1));
    assert.equal(moved.mapping.get(a2.seq), BigInt(new2));
    assert.deepEqual(moved.actual, moved.expected);

    // The target's own events are untouched.
    const c_event_rows_after = JSON.stringify(world.tgt.all("SELECT * FROM events WHERE project_id = ? ORDER BY event_seq", world.c.project_id), (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
    assert.equal(c_event_rows_after, c_event_rows_before, "existing event numbers and rows are unchanged");
    assert.deepEqual(project_rows(world.tgt, world.c.project_id, world.c.owner_user_id), c_before);
    assert.deepEqual(world.tgt.all("PRAGMA foreign_key_check"), []);

    // B never arrives.
    assert.equal(world.tgt.get("SELECT id FROM projects WHERE id = ?", world.b.project_id), undefined);
  });
});

test("the bootstrap-only overlap case (one event on each side, both event_seq 1) imports", () => {
  with_world((world) => {
    const a_boot = world.src.get<{ event_seq: bigint }>("SELECT event_seq FROM events WHERE project_id = ?", world.a.project_id);
    const c_boot = world.tgt.get<{ event_seq: bigint }>("SELECT event_seq FROM events WHERE project_id = ?", world.c.project_id);
    assert.equal(BigInt(a_boot!.event_seq), 1n);
    assert.equal(BigInt(c_boot!.event_seq), 1n, "only the two bootstrap events exist, both numbered 1");
    const a_source_rows = project_rows(world.src, world.a.project_id, world.a.owner_user_id);
    const { dir } = export_project_to(world, world.a, "events-min");
    assert.equal(verify_bundle(dir).ok, true);
    import_bundle(world.tgt, world.tgt_objects, dir);
    const seqs = world.tgt.all<{ event_seq: bigint; project_id: string }>("SELECT event_seq, project_id FROM events ORDER BY event_seq");
    assert.equal(seqs.length, 2);
    assert.equal(new Set(seqs.map((row) => BigInt(row.event_seq))).size, 2);
    assert.equal(BigInt(seqs.find((row) => row.project_id === world.c.project_id)!.event_seq), 1n, "C keeps number 1");
    assert.ok(BigInt(seqs.find((row) => row.project_id === world.a.project_id)!.event_seq) > 1n, "A gets a new number");
    const moved = source_rows_in_target_numbering(a_source_rows, project_rows(world.tgt, world.a.project_id, world.a.owner_user_id));
    assert.deepEqual(moved.actual, moved.expected);
  });
});

// ---------------------------------------------------------------------------
// 3. project_references to a project missing in the target
// ---------------------------------------------------------------------------
// Contract (docs/plan/stage-1-db.md:141, :189 and issue table row PR3): when A alone is
// moved and B is not in the destination, B's data is NOT copied; the reference keeps its
// source identity (referenced_project_key, source_snapshot_key, source_label) and becomes
// referenced_project_id = NULL, source_snapshot_id = NULL, latest_snapshot_id = NULL,
// status = 'source_missing'. Source DB and other target projects are not modified.
// When B *is* in the destination (same project UUID, imported earlier), the doc only
// speaks of the "missing" case ("이때") and says a later transfer of B relinks "by key";
// so nothing is degraded: the reference stays linked and keeps its status.

interface ReferenceRow {
  id: string;
  project_id: string;
  referenced_project_id: string | null;
  referenced_project_key: string;
  source_snapshot_id: string | null;
  source_snapshot_key: string | null;
  source_label: string;
  latest_snapshot_id: string | null;
  scope_json: string;
  status: string;
  attached_by_actor_id: string;
  attached_by_user_id: string;
}

function insert_reference(
  db: Db,
  from: BootstrapResult,
  to: BootstrapResult,
  snapshot_id: string | null,
): string {
  const id = globalThis.crypto.randomUUID();
  db.run(
    `INSERT INTO project_references
       (id, project_id, referenced_project_id, referenced_project_key, source_snapshot_id, source_snapshot_key,
        source_label, latest_snapshot_id, scope_json, status, attached_by_actor_id, attached_by_user_id, attached_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '["findings"]', 'active', ?, ?, 1760000000000)`,
    id,
    from.project_id,
    to.project_id,
    `synthetic-key:${to.project_id}`,
    snapshot_id,
    snapshot_id === null ? null : "synthetic-snapshot-key-1",
    "합성 참조 라벨",
    snapshot_id,
    from.owner_actor_id,
    from.owner_user_id,
  );
  return id;
}

function reference_of(db: Db, id: string): ReferenceRow | undefined {
  return db.get<ReferenceRow>("SELECT * FROM project_references WHERE id = ?", id);
}

test("A->B reference with B absent in the target: A imports alone, reference becomes source_missing with identity kept (NULL snapshot pointers)", () => {
  with_world((world) => {
    const ref_id = insert_reference(world.src, world.a, world.b, null);
    assert.deepEqual(world.src.all("PRAGMA foreign_key_check"), []);
    const src_before = state_signature(world.src);
    const { dir } = export_project_to(world, world.a, "ref-null");
    assert.equal(verify_bundle(dir).ok, true);

    const c_before = project_rows(world.tgt, world.c.project_id, world.c.owner_user_id);
    import_bundle(world.tgt, world.tgt_objects, dir);

    const row = reference_of(world.tgt, ref_id);
    assert.ok(row, "reference row is imported");
    assert.equal(row.project_id, world.a.project_id);
    assert.equal(row.referenced_project_id, null);
    assert.equal(row.source_snapshot_id, null);
    assert.equal(row.latest_snapshot_id, null);
    assert.equal(row.status, "source_missing");
    assert.equal(row.referenced_project_key, `synthetic-key:${world.b.project_id}`);
    assert.equal(row.source_label, "합성 참조 라벨");
    assert.equal(row.scope_json, '["findings"]');
    assert.equal(row.attached_by_actor_id, world.a.owner_actor_id);

    assert.equal(world.tgt.get("SELECT id FROM projects WHERE id = ?", world.b.project_id), undefined, "B is not copied");
    assert.deepEqual(project_rows(world.tgt, world.c.project_id, world.c.owner_user_id), c_before);
    assert.deepEqual(world.tgt.all("PRAGMA foreign_key_check"), []);
    assert.equal(state_signature(world.src), src_before, "source DB is not modified");
  });
});

test("A->B reference whose snapshot pointers point into B: pointers are NULLed, snapshot key and label survive, status source_missing", () => {
  with_world((world) => {
    const b_snapshot = insert_snapshot(world.src, world.b, world.b_blobs[0]!.id, null);
    const ref_id = insert_reference(world.src, world.a, world.b, b_snapshot);
    assert.deepEqual(world.src.all("PRAGMA foreign_key_check"), []);
    const { dir } = export_project_to(world, world.a, "ref-snap");
    assert.equal(verify_bundle(dir).ok, true);

    import_bundle(world.tgt, world.tgt_objects, dir);

    const row = reference_of(world.tgt, ref_id);
    assert.ok(row);
    assert.equal(row.referenced_project_id, null);
    assert.equal(row.source_snapshot_id, null);
    assert.equal(row.latest_snapshot_id, null);
    assert.equal(row.status, "source_missing");
    assert.equal(row.source_snapshot_key, "synthetic-snapshot-key-1");
    assert.equal(row.referenced_project_key, `synthetic-key:${world.b.project_id}`);
    assert.equal(world.tgt.get("SELECT id FROM snapshots WHERE id = ?", b_snapshot), undefined, "B's snapshot is not copied");
    assert.deepEqual(world.tgt.all("PRAGMA foreign_key_check"), []);
  });
});

test("A->B reference when B already exists in the target (same project id): the link and status are kept", () => {
  with_world((world) => {
    const ref_id = insert_reference(world.src, world.a, world.b, null);
    const b_bundle = export_project_to(world, world.b, "ref-b-first");
    import_bundle(world.tgt, world.tgt_objects, b_bundle.dir);
    const a_bundle = export_project_to(world, world.a, "ref-a-second");

    import_bundle(world.tgt, world.tgt_objects, a_bundle.dir);

    const row = reference_of(world.tgt, ref_id);
    assert.ok(row);
    assert.equal(row.referenced_project_id, world.b.project_id, "B is present, so the local pointer is kept");
    assert.equal(row.status, "active");
    assert.equal(row.referenced_project_key, `synthetic-key:${world.b.project_id}`);
    assert.deepEqual(world.tgt.all("PRAGMA foreign_key_check"), []);
  });
});

// ---------------------------------------------------------------------------
// 4. object file write failure after some bytes: clean up what this import created
// ---------------------------------------------------------------------------

function enospc(): Error {
  return Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", errno: -28, syscall: "write" });
}

/**
 * Inject ENOSPC on the first write of >= 2 bytes to a file under `root`, after really
 * writing only the first byte. Works whether the implementation uses
 * writeFileSync(path, ...) , writeFileSync(fd, ...) or openSync + writeSync(fd, ...).
 */
function inject_partial_write(root: string): { restore: () => void; injected: () => string | null } {
  const fd_paths = new Map<number, string>();
  let injected_path: string | null = null;
  const original_open = fs.openSync;
  const original_write_file = fs.writeFileSync;
  const original_write = fs.writeSync;
  const under_root = (path: unknown): path is string => typeof path === "string" && resolve(path).startsWith(resolve(root));
  const as_buffer = (data: unknown): Buffer | null => {
    if (typeof data === "string") return Buffer.from(data);
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return null;
  };

  const restore = patch_fs({
    openSync: (path: unknown, ...rest: unknown[]) => {
      const fd = (original_open as (...args: unknown[]) => number)(path, ...rest);
      if (under_root(path)) fd_paths.set(fd, resolve(path));
      return fd;
    },
    writeFileSync: (target: unknown, data: unknown, ...rest: unknown[]) => {
      const path = typeof target === "number" ? fd_paths.get(target) : under_root(target) ? resolve(target) : undefined;
      const bytes = as_buffer(data);
      if (path !== undefined && injected_path === null && bytes !== null && bytes.byteLength >= 2) {
        (original_write_file as (...args: unknown[]) => void)(target, bytes.subarray(0, 1), ...rest); // may throw EEXIST: natural
        injected_path = path;
        throw enospc();
      }
      return (original_write_file as (...args: unknown[]) => void)(target, data, ...rest);
    },
    writeSync: (fd: number, data: unknown, ...rest: unknown[]) => {
      const path = fd_paths.get(fd);
      const bytes = as_buffer(data);
      if (path !== undefined && injected_path === null && bytes !== null && bytes.byteLength >= 2) {
        (original_write as (...args: unknown[]) => number)(fd, bytes.subarray(0, 1));
        injected_path = path;
        throw enospc();
      }
      return (original_write as (...args: unknown[]) => number)(fd, data, ...rest);
    },
  });
  return { restore, injected: () => injected_path };
}

test("an ENOSPC after some bytes of an object file removes the partial file and new folders; DB and epoch are unchanged; the same bundle then imports", () => {
  with_world((world) => {
    const { dir } = export_project_to(world, world.a, "partial");
    const before = target_state(world);
    const entries_before = all_entries(world.tgt_objects);

    const hook = inject_partial_write(world.tgt_objects);
    let error: unknown;
    try {
      error = error_of(() => import_bundle(world.tgt, world.tgt_objects, dir));
    } finally {
      hook.restore();
    }
    assert.ok(hook.injected() !== null, "the injection must have fired on an object file write");
    assert.ok(error !== undefined, "import must fail");

    assert.deepEqual(target_state(world), before, "DB rows, epoch/instance and object files are as before");
    assert.deepEqual(all_entries(world.tgt_objects), entries_before, "no partial file and no new (empty) folder remain");
    assert.equal(existsSync(join(world.tgt_objects, world.a.project_id)), false);

    // Retry with the same bundle succeeds.
    const result = import_bundle(world.tgt, world.tgt_objects, dir);
    assert.equal(result.project_id, world.a.project_id);
    assert.ok(meta_of(world.tgt).cursor_epoch > before.meta.cursor_epoch);
    for (const blob of world.a_blobs) {
      const file = join(world.tgt_objects, ...blob.storage_key.split("/"));
      assert.deepEqual(new Uint8Array(readFileSync(file)), blob.bytes, `${blob.storage_key} restored byte for byte`);
    }
  });
});

test("an object file that already exists (EEXIST) is preserved when a later write fails; only this import's files are removed", () => {
  with_world((world) => {
    const text_blob = world.a_blobs[0]!; // TEXT_BYTES
    const existing = join(world.tgt_objects, ...text_blob.storage_key.split("/"));
    mkdirSync(join(world.tgt_objects, world.a.project_id), { recursive: true });
    writeFileSync(existing, text_blob.bytes);

    const { dir } = export_project_to(world, world.a, "partial-eexist");
    const before = target_state(world);
    const entries_before = all_entries(world.tgt_objects);
    assert.ok(entries_before.includes(`${world.a.project_id}/${text_blob.sha256}`));

    const hook = inject_partial_write(world.tgt_objects);
    let error: unknown;
    try {
      error = error_of(() => import_bundle(world.tgt, world.tgt_objects, dir));
    } finally {
      hook.restore();
    }
    assert.ok(hook.injected() !== null, "a new (non-existing) object file must have been written and failed");
    assert.notEqual(hook.injected(), resolve(existing), "the pre-existing file is not the failing one");
    assert.ok(error !== undefined, "import must fail");

    assert.deepEqual(target_state(world), before);
    assert.deepEqual(all_entries(world.tgt_objects), entries_before, "the pre-existing file and its folder stay; nothing else remains");
    assert.deepEqual(new Uint8Array(readFileSync(existing)), text_blob.bytes);

    const result = import_bundle(world.tgt, world.tgt_objects, dir);
    assert.equal(result.project_id, world.a.project_id);
  });
});

// ---------------------------------------------------------------------------
// 5. export out_dir that is a symlink
// ---------------------------------------------------------------------------

test("export into an out_dir that is a symlink (even to an empty directory) is refused as object_path_unsafe and writes nothing", () => {
  with_world((world) => {
    const real = join(world.bundles, "real-empty");
    mkdirSync(real, { recursive: true });
    const link = join(world.bundles, "link-out");
    symlinkSync(real, link, "dir");

    const error = error_of(() => export_project(world.src, world.src_objects, world.a.project_id, link));
    assert.ok(error instanceof BackupError, String(error));
    assert.equal(error.code, "object_path_unsafe");
    assert.deepEqual(all_entries(real), [], "the symlink target stays empty");
  });
});

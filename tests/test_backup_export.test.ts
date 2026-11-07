// SEL-36 (stage 2 PR3): new-format backup, export, verify, and import.
//
// ---------------------------------------------------------------------------
// API contract for scripts/pes_core/backup.ts (the worker implements exactly this)
// ---------------------------------------------------------------------------
//
//   export const BACKUP_FORMAT_VERSION = 1;
//
//   export interface BundleFile { path: string; sha256: string; size: number }
//   export interface Manifest {
//     format_version: 1;                  // number
//     database_instance_id: string;       // source db_meta.database_instance_id
//     cursor_epoch: string;               // source db_meta.cursor_epoch as a decimal string
//     project_id: string;
//     files: BundleFile[];                // EVERY file in the bundle except manifest.json;
//                                         // path = relative POSIX path, sha256 = lowercase hex, size = bytes (number)
//     table_counts: Record<string, number>; // rows per table exported (users/actors included); tables with 0 rows may be omitted
//   }                                     // no timestamps: exporting the same unchanged project twice gives byte-identical files
//
//   export type ProblemCode =
//     | "manifest_missing" | "manifest_invalid" | "path_unsafe"
//     | "file_missing" | "size_mismatch" | "hash_mismatch" | "extra_file" | "row_count_mismatch";
//   export interface BundleProblem { code: ProblemCode; path?: string; message: string }
//
//   export class BackupError extends Error {
//     code: string;                       // see below
//     problems: BundleProblem[];          // filled for code "bundle_invalid", otherwise []
//   }
//
//   // Synchronous, like the rest of pes_core. Reads inside ONE tx() (a consistent snapshot);
//   // never copies the DB file and never uses VACUUM INTO / ATTACH / backup / wal_checkpoint.
//   // out_dir must not exist or must be empty, otherwise BackupError("out_dir_not_empty") and nothing is written.
//   // Unknown project_id -> BackupError("project_not_found"), out_dir is not created.
//   // Bundle layout (tests find files through manifest.files, never by fixed name):
//   //   manifest.json
//   //   rows/<anything>             JSON rows of the project (the DB part)
//   //   objects/<blob.storage_key>  byte-identical copy of objects_dir/<blob.storage_key> for every blobs row of the project
//   export function export_project(db: Db, objects_dir: string, project_id: string, out_dir: string):
//     { bundle_dir: string; manifest: Manifest };
//
//   // Never throws for a bad bundle; reports ALL problems (none silently dropped).
//   export function verify_bundle(bundle_dir: string): { ok: boolean; problems: BundleProblem[] };
//
//   // Verifies first; any problem -> BackupError("bundle_invalid") with .problems, and NOTHING is written
//   // (no rows, no files, no temp leftovers, cursor_epoch unchanged).
//   // Other refusals, also writing nothing: "project_exists" (same project id already in db),
//   // "project_conflict" (slug or another unique key collides). Rows go in one tx(); files are copied
//   // to objects_dir/<storage_key> only so that a failure leaves both db and objects_dir as before.
//   // On success: the project's rows (plus the users/actors it references, unless an identical row already exists)
//   // are inserted, files are copied byte-for-byte, and target db_meta.cursor_epoch becomes
//   //   max(target epoch, manifest.cursor_epoch) + 1. database_instance_id of the target is NOT changed.
//   export function import_bundle(db: Db, objects_dir: string, bundle_dir: string):
//     { project_id: string; cursor_epoch: bigint };
//
//   // Minimal cursor check: passes when `epoch` (bigint or decimal string) equals the current
//   // db_meta.cursor_epoch; otherwise BackupError("cursor_epoch_stale"); non-decimal input -> BackupError("cursor_epoch_invalid").
//   export function assert_cursor_epoch(db: Db, epoch: bigint | string): void;
//
// Not tested here (PR9 / PR12): ready/orphan blob rules, full restore verification, backup-inside-PES-home refusal.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  assert_cursor_epoch,
  BACKUP_FORMAT_VERSION,
  BackupError,
  export_project,
  import_bundle,
  verify_bundle,
  type Manifest,
} from "../scripts/pes_core/backup.ts";
import type { Db, SqlValue } from "../scripts/pes_core/db.ts";
import {
  all_rows_except_meta,
  close_world,
  list_tree,
  make_world,
  meta_of,
  project_rows,
  source_rows_in_target_numbering,
  sha256_hex,
  type World,
} from "./helpers/backup_fixture.ts";
import { isolated_home } from "./helpers/isolated_home.ts";
import { state_signature } from "./helpers/state_signature.ts";

function with_world(fn: (world: World) => void): void {
  const home = isolated_home("pes-sel36-");
  const world = make_world(home);
  try {
    fn(world);
  } finally {
    close_world(world);
    home.cleanup();
  }
}

function export_a(world: World, name = "a"): { dir: string; manifest: Manifest } {
  const dir = join(world.bundles, name);
  const result = export_project(world.src, world.src_objects, world.a.project_id, dir);
  assert.equal(result.bundle_dir, dir);
  return { dir, manifest: result.manifest };
}

function read_manifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
}

function write_manifest(dir: string, manifest: unknown): void {
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

function object_entry(manifest: Manifest, index = 0) {
  const entries = manifest.files.filter((file) => file.path.startsWith("objects/"));
  const entry = entries[index];
  assert.ok(entry, "bundle should contain object files");
  return entry;
}

function codes(problems: { code: string }[]): string[] {
  return problems.map((problem) => problem.code).sort();
}

/** Snapshot of everything an import is not allowed to touch when it is refused. */
function target_state(world: World) {
  return {
    signature: state_signature(world.tgt),
    meta: meta_of(world.tgt),
    objects: list_tree(world.tgt_objects),
  };
}

function assert_import_rejected(world: World, bundle_dir: string, code: string): BackupError {
  const before = target_state(world);
  let caught: unknown;
  try {
    import_bundle(world.tgt, world.tgt_objects, bundle_dir);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof BackupError, `import should throw BackupError(${code}), got ${String(caught)}`);
  assert.equal(caught.code, code);
  assert.deepEqual(target_state(world), before, "a refused import must not change the target db or objects folder");
  return caught;
}

// ---------------------------------------------------------------------------
// 1. export one of two projects -> import into a new db
// ---------------------------------------------------------------------------

test("export writes a manifest with the required fields, hashes every file, and omits other projects", () => {
  with_world((world) => {
    const { dir, manifest } = export_a(world);
    const meta = meta_of(world.src);

    assert.equal(BACKUP_FORMAT_VERSION, 1);
    assert.equal(manifest.format_version, 1);
    assert.equal(manifest.project_id, world.a.project_id);
    assert.equal(manifest.database_instance_id, meta.database_instance_id);
    assert.equal(manifest.cursor_epoch, meta.cursor_epoch.toString());
    assert.deepEqual(read_manifest(dir), manifest, "returned manifest equals manifest.json on disk");

    // files[] is the complete, honest inventory of the bundle.
    const on_disk = list_tree(dir);
    delete on_disk["manifest.json"];
    assert.deepEqual(
      Object.fromEntries(manifest.files.map((file) => [file.path, file.sha256]).sort(([x], [y]) => (x! < y! ? -1 : 1))),
      on_disk,
    );
    for (const file of manifest.files) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
      assert.equal(file.size, statSync(join(dir, ...file.path.split("/"))).size);
      assert.ok(!file.path.startsWith("/") && !file.path.includes(".."), file.path);
    }
    assert.ok(manifest.files.some((file) => file.path.startsWith("rows/")), "DB rows part present");
    assert.equal(manifest.files.filter((file) => file.path.startsWith("objects/")).length, world.a_blobs.length);

    // Per-table counts match the rows the project really has in the source.
    const expected = project_rows(world.src, world.a.project_id, world.a.owner_user_id);
    for (const [table, rows] of Object.entries(expected)) {
      if (rows.length > 0) assert.equal(manifest.table_counts[table], rows.length, table);
    }
    for (const [table, count] of Object.entries(manifest.table_counts)) {
      assert.equal(count, expected[table]?.length ?? -1, `unexpected count for ${table}`);
    }
    assert.equal(manifest.table_counts.blobs, 3);
    assert.equal(manifest.table_counts.stages, 6);
    assert.equal(manifest.table_counts.objects, 1);

    // Nothing of project B is in the bundle.
    for (const file of manifest.files) {
      const text = readFileSync(join(dir, ...file.path.split("/")));
      assert.ok(!text.includes(world.b.project_id), `${file.path} mentions project B`);
      assert.ok(!text.includes("synthetic-beta"), `${file.path} mentions project B slug`);
      assert.ok(!file.path.includes(world.b.project_id));
    }
    assert.equal(verify_bundle(dir).ok, true);
    assert.deepEqual(verify_bundle(dir).problems, []);
  });
});

test("export is deterministic: the same unchanged project yields identical bundle bytes", () => {
  with_world((world) => {
    const first = export_a(world, "first");
    const second = export_a(world, "second");
    assert.deepEqual(list_tree(first.dir), list_tree(second.dir));
  });
});

test("export then import into a new db restores the project rows and files; other target data is untouched", () => {
  with_world((world) => {
    const { dir } = export_a(world);

    const source_before = {
      signature: state_signature(world.src),
      meta: meta_of(world.src),
      objects: list_tree(world.src_objects),
    };
    const target_rows_before = all_rows_except_meta(world.tgt);
    const target_meta_before = meta_of(world.tgt);
    const target_objects_before = list_tree(world.tgt_objects);

    const result = import_bundle(world.tgt, world.tgt_objects, dir);
    assert.equal(result.project_id, world.a.project_id);

    // Project A: every row is equal to the source (ids, rev, timestamps, bigint values).
    // event_seq is re-assigned by the target (order and references preserved); every other column is strictly equal.
    const moved = source_rows_in_target_numbering(
      project_rows(world.src, world.a.project_id, world.a.owner_user_id),
      project_rows(world.tgt, world.a.project_id, world.a.owner_user_id),
    );
    assert.deepEqual(moved.actual, moved.expected);
    assert.deepEqual(world.tgt.all("PRAGMA foreign_key_check"), []);
    assert.equal(world.tgt.get<{ integrity_check: string }>("PRAGMA integrity_check")?.integrity_check, "ok");

    // Files: same relative names, byte-identical content.
    const target_objects_after = list_tree(world.tgt_objects);
    for (const blob of world.a_blobs) {
      assert.equal(target_objects_after[blob.storage_key], blob.sha256, blob.storage_key);
      assert.deepEqual(
        new Uint8Array(readFileSync(join(world.tgt_objects, ...blob.storage_key.split("/")))),
        blob.bytes,
      );
    }

    // Target's other data: every row it had is still there, unchanged; the only new rows are project A's.
    const target_rows_after = all_rows_except_meta(world.tgt);
    const a_rows = project_rows(world.src, world.a.project_id, world.a.owner_user_id);
    for (const [table, rows] of Object.entries(target_rows_before)) {
      const after = new Set(target_rows_after[table]);
      for (const row of rows) assert.ok(after.has(row), `row of ${table} changed or vanished`);
      assert.equal(
        target_rows_after[table]!.length,
        rows.length + (a_rows[table]?.length ?? 0),
        `${table}: only project A rows may be added`,
      );
    }
    assert.deepEqual(
      Object.fromEntries(Object.entries(target_objects_after).filter(([key]) => !key.startsWith(`${world.a.project_id}/`))),
      target_objects_before,
      "files of other projects in the target objects folder are untouched",
    );
    assert.equal(
      world.tgt.get("SELECT 1 AS x FROM projects WHERE id = ?", world.c.project_id) !== undefined,
      true,
    );
    // Project B (never exported) did not arrive.
    for (const table of ["projects", "users", "blobs", "objects"]) {
      const rows = (target_rows_after[table] ?? []).join("\n");
      assert.ok(!rows.includes(world.b.project_id) && !rows.includes(world.b.owner_user_id), `${table} contains project B`);
    }
    assert.equal(target_objects_after[world.b_blobs[0]!.storage_key], undefined);

    // Target identity is kept; only the epoch moved.
    assert.equal(meta_of(world.tgt).database_instance_id, target_meta_before.database_instance_id);
    assert.notEqual(meta_of(world.tgt).database_instance_id, meta_of(world.src).database_instance_id);

    // The source db and its objects are unchanged by export + import.
    assert.equal(state_signature(world.src), source_before.signature);
    assert.deepEqual(meta_of(world.src), source_before.meta);
    assert.deepEqual(list_tree(world.src_objects), source_before.objects);
  });
});

test("importing the same project twice is refused and changes nothing", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    import_bundle(world.tgt, world.tgt_objects, dir);
    assert_import_rejected(world, dir, "project_exists");
  });
});

test("import is refused (and rolls back fully) when the target already has another project with the same slug", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    world.tgt.run("UPDATE projects SET slug = 'synthetic-alpha' WHERE id = ?", world.c.project_id);
    assert_import_rejected(world, dir, "project_conflict");
    assert.deepEqual(list_tree(join(world.tgt_objects, world.a.project_id)), {}, "no copied files left behind");
  });
});

test("export refuses an unknown project and a non-empty out_dir without writing", () => {
  with_world((world) => {
    const missing_out = join(world.bundles, "missing");
    assert.throws(
      () => export_project(world.src, world.src_objects, "00000000-0000-4000-8000-000000000000", missing_out),
      (error: unknown) => error instanceof BackupError && error.code === "project_not_found",
    );
    assert.equal(existsSync(missing_out), false);

    const busy = join(world.bundles, "busy");
    mkdirSync(busy, { recursive: true });
    writeFileSync(join(busy, "keep.txt"), "keep");
    assert.throws(
      () => export_project(world.src, world.src_objects, world.a.project_id, busy),
      (error: unknown) => error instanceof BackupError && error.code === "out_dir_not_empty",
    );
    assert.deepEqual(Object.keys(list_tree(busy)), ["keep.txt"]);
  });
});

// ---------------------------------------------------------------------------
// 2. damaged bundles: verify reports each problem, import refuses and writes nothing
// ---------------------------------------------------------------------------

test("corrupt hash (same size) is reported as hash_mismatch only, and import refuses", () => {
  with_world((world) => {
    const { dir, manifest } = export_a(world);
    const entry = object_entry(manifest, 1);
    const file = join(dir, ...entry.path.split("/"));
    const bytes = Uint8Array.from(readFileSync(file));
    bytes[0] = (bytes[0]! ^ 0xff) & 0xff;
    writeFileSync(file, bytes);

    const report = verify_bundle(dir);
    assert.equal(report.ok, false);
    assert.deepEqual(codes(report.problems), ["hash_mismatch"]);
    assert.equal(report.problems[0]!.path, entry.path);

    const error = assert_import_rejected(world, dir, "bundle_invalid");
    assert.deepEqual(codes(error.problems), ["hash_mismatch"]);
  });
});

test("a damaged DB rows file is detected too", () => {
  with_world((world) => {
    const { dir, manifest } = export_a(world);
    const rows_entry = manifest.files.find((file) => file.path.startsWith("rows/"))!;
    appendFileSync(join(dir, ...rows_entry.path.split("/")), " ");
    const report = verify_bundle(dir);
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => problem.path === rows_entry.path));
    assert_import_rejected(world, dir, "bundle_invalid");
  });
});

test("a missing file is reported as file_missing, and import refuses", () => {
  with_world((world) => {
    const { dir, manifest } = export_a(world);
    const entry = object_entry(manifest, 0);
    rmSync(join(dir, ...entry.path.split("/")));

    const report = verify_bundle(dir);
    assert.equal(report.ok, false);
    assert.deepEqual(codes(report.problems), ["file_missing"]);
    assert.equal(report.problems[0]!.path, entry.path);
    assert_import_rejected(world, dir, "bundle_invalid");
  });
});

test("an extra file that the manifest does not list is reported as extra_file, and import refuses", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    mkdirSync(join(dir, "objects", "stray"), { recursive: true });
    writeFileSync(join(dir, "objects", "stray", "unlisted.bin"), "unlisted");

    const report = verify_bundle(dir);
    assert.equal(report.ok, false);
    assert.deepEqual(codes(report.problems), ["extra_file"]);
    assert.equal(report.problems[0]!.path, "objects/stray/unlisted.bin");
    assert_import_rejected(world, dir, "bundle_invalid");
  });
});

test("a recorded size that does not match the file is reported as size_mismatch", () => {
  with_world((world) => {
    const { dir, manifest } = export_a(world);
    const entry = object_entry(manifest, 0);
    const edited = { ...manifest, files: manifest.files.map((file) => (file === entry ? { ...file, size: file.size + 1 } : file)) };
    write_manifest(dir, edited);

    const report = verify_bundle(dir);
    assert.equal(report.ok, false);
    assert.deepEqual(codes(report.problems), ["size_mismatch"]);
    assert_import_rejected(world, dir, "bundle_invalid");
  });
});

test("a truncated file is reported (size_mismatch and hash_mismatch are both acceptable signals, never ok)", () => {
  with_world((world) => {
    const { dir, manifest } = export_a(world);
    const entry = object_entry(manifest, 1);
    const file = join(dir, ...entry.path.split("/"));
    writeFileSync(file, readFileSync(file).subarray(0, entry.size - 1));
    const report = verify_bundle(dir);
    assert.equal(report.ok, false);
    assert.ok(codes(report.problems).includes("size_mismatch"));
    assert.ok(report.problems.every((problem) => problem.path === entry.path));
  });
});

test("verify reports every problem at once instead of stopping at the first", () => {
  with_world((world) => {
    const { dir, manifest } = export_a(world);
    const missing = object_entry(manifest, 0);
    const corrupt = object_entry(manifest, 1);
    rmSync(join(dir, ...missing.path.split("/")));
    const corrupt_file = join(dir, ...corrupt.path.split("/"));
    const bytes = Uint8Array.from(readFileSync(corrupt_file));
    bytes[1] = (bytes[1]! ^ 0x01) & 0xff;
    writeFileSync(corrupt_file, bytes);
    writeFileSync(join(dir, "objects", "extra.bin"), "x");

    const report = verify_bundle(dir);
    assert.equal(report.ok, false);
    assert.deepEqual(codes(report.problems), ["extra_file", "file_missing", "hash_mismatch"]);
    const by_code = Object.fromEntries(report.problems.map((problem) => [problem.code, problem.path]));
    assert.equal(by_code.file_missing, missing.path);
    assert.equal(by_code.hash_mismatch, corrupt.path);
    assert.equal(by_code.extra_file, "objects/extra.bin");
    for (const problem of report.problems) assert.ok(problem.message.length > 0);
    assert_import_rejected(world, dir, "bundle_invalid");
  });
});

test("manifest problems are reported, not thrown: missing, not JSON, wrong shape, unknown version, unsafe path", () => {
  with_world((world) => {
    const { dir, manifest } = export_a(world);
    const manifest_file = join(dir, "manifest.json");
    const original = readFileSync(manifest_file, "utf8");

    // Not a bundle at all.
    assert.deepEqual(codes(verify_bundle(join(world.bundles, "does-not-exist")).problems), ["manifest_missing"]);

    rmSync(manifest_file);
    assert.deepEqual(codes(verify_bundle(dir).problems), ["manifest_missing"]);
    assert_import_rejected(world, dir, "bundle_invalid");

    writeFileSync(manifest_file, "{ not json");
    assert.deepEqual(codes(verify_bundle(dir).problems), ["manifest_invalid"]);
    assert_import_rejected(world, dir, "bundle_invalid");

    for (const field of ["format_version", "database_instance_id", "cursor_epoch", "project_id", "files", "table_counts"] as const) {
      const broken: Record<string, unknown> = { ...manifest };
      delete broken[field];
      write_manifest(dir, broken);
      const report = verify_bundle(dir);
      assert.equal(report.ok, false, `missing ${field}`);
      assert.ok(codes(report.problems).includes("manifest_invalid"), `missing ${field}`);
    }

    write_manifest(dir, { ...manifest, format_version: 2 });
    assert.ok(codes(verify_bundle(dir).problems).includes("manifest_invalid"));

    write_manifest(dir, { ...manifest, files: [...manifest.files, { path: "../outside.bin", sha256: "0".repeat(64), size: 0 }] });
    assert.ok(codes(verify_bundle(dir).problems).includes("path_unsafe"));
    assert_import_rejected(world, dir, "bundle_invalid");

    write_manifest(dir, { ...manifest, files: manifest.files.map((file, index) => (index === 0 ? { ...file, sha256: "XYZ" } : file)) });
    assert.ok(codes(verify_bundle(dir).problems).includes("manifest_invalid"));

    writeFileSync(manifest_file, original);
    assert.equal(verify_bundle(dir).ok, true, "restoring the manifest makes the bundle valid again");
  });
});

test("a manifest row count that disagrees with the rows file is reported as row_count_mismatch", () => {
  with_world((world) => {
    const { dir, manifest } = export_a(world);
    write_manifest(dir, { ...manifest, table_counts: { ...manifest.table_counts, blobs: 99 } });
    const report = verify_bundle(dir);
    assert.equal(report.ok, false);
    assert.ok(codes(report.problems).includes("row_count_mismatch"));
    assert_import_rejected(world, dir, "bundle_invalid");
  });
});

// ---------------------------------------------------------------------------
// 3. epoch rises on restore; old cursors are refused
// ---------------------------------------------------------------------------

test("restoring raises the target cursor_epoch and the old cursor epoch is refused", () => {
  with_world((world) => {
    const { dir, manifest } = export_a(world);
    const before = meta_of(world.tgt).cursor_epoch;
    assert_cursor_epoch(world.tgt, before);
    assert_cursor_epoch(world.tgt, before.toString());

    const result = import_bundle(world.tgt, world.tgt_objects, dir);
    const after = meta_of(world.tgt).cursor_epoch;
    assert.ok(after > before, "epoch must rise");
    assert.equal(result.cursor_epoch, after);

    assert.throws(
      () => assert_cursor_epoch(world.tgt, before),
      (error: unknown) => error instanceof BackupError && error.code === "cursor_epoch_stale",
    );
    assert.throws(
      () => assert_cursor_epoch(world.tgt, before.toString()),
      (error: unknown) => error instanceof BackupError && error.code === "cursor_epoch_stale",
    );
    assert.throws(
      () => assert_cursor_epoch(world.tgt, BigInt(manifest.cursor_epoch)),
      (error: unknown) => error instanceof BackupError && error.code === "cursor_epoch_stale",
      "a cursor from the source db's epoch is not valid in the restored db either",
    );
    assert_cursor_epoch(world.tgt, after);
  });
});

test("new epoch is max(target, manifest) + 1, so a source with a higher epoch cannot leave the target lower", () => {
  with_world((world) => {
    world.src.run("UPDATE db_meta SET cursor_epoch = 7 WHERE id = 1");
    const { dir, manifest } = export_a(world);
    assert.equal(manifest.cursor_epoch, "7");
    const result = import_bundle(world.tgt, world.tgt_objects, dir);
    assert.equal(result.cursor_epoch, 8n);
    assert.equal(meta_of(world.tgt).cursor_epoch, 8n);
    assert.equal(meta_of(world.src).cursor_epoch, 7n, "export and import never change the source epoch");
  });
});

test("a refused import does not raise the epoch", () => {
  with_world((world) => {
    const { dir, manifest } = export_a(world);
    rmSync(join(dir, ...object_entry(manifest).path.split("/")));
    const before = meta_of(world.tgt).cursor_epoch;
    assert_import_rejected(world, dir, "bundle_invalid");
    assert.equal(meta_of(world.tgt).cursor_epoch, before);
  });
});

test("assert_cursor_epoch rejects input that is not a decimal epoch", () => {
  with_world((world) => {
    for (const bad of ["", "abc", "1.5", "-1", " 1"]) {
      assert.throws(
        () => assert_cursor_epoch(world.tgt, bad),
        (error: unknown) => error instanceof BackupError && error.code === "cursor_epoch_invalid",
        JSON.stringify(bad),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 4. files are copied as opaque bytes
// ---------------------------------------------------------------------------

test("object files are copied byte-for-byte (NUL, CRLF, invalid UTF-8, empty) in the bundle and after import", () => {
  with_world((world) => {
    const { dir, manifest } = export_a(world);
    for (const blob of world.a_blobs) {
      const entry = manifest.files.find((file) => file.path === `objects/${blob.storage_key}`);
      assert.ok(entry, `manifest lists objects/${blob.storage_key}`);
      assert.equal(entry.sha256, blob.sha256);
      assert.equal(entry.size, blob.size);
      assert.deepEqual(new Uint8Array(readFileSync(join(dir, ...entry.path.split("/")))), blob.bytes);
      assert.equal(sha256_hex(readFileSync(join(dir, ...entry.path.split("/")))), blob.sha256);
    }
    import_bundle(world.tgt, world.tgt_objects, dir);
    for (const blob of world.a_blobs) {
      assert.deepEqual(
        new Uint8Array(readFileSync(join(world.tgt_objects, ...blob.storage_key.split("/")))),
        blob.bytes,
      );
    }
  });
});

test("export copies files without interpreting them: a file whose bytes disagree with the blobs row hash is still copied verbatim", () => {
  with_world((world) => {
    // PR3 does not judge ready/orphan/consistency (that is PR9/PR12): content is opaque.
    const blob = world.a_blobs[0]!;
    const file = join(world.src_objects, ...blob.storage_key.split("/"));
    writeFileSync(file, Uint8Array.from([9, 9, 9]));
    const { dir, manifest } = export_a(world);
    const entry = manifest.files.find((candidate) => candidate.path === `objects/${blob.storage_key}`)!;
    assert.equal(entry.sha256, sha256_hex(Uint8Array.from([9, 9, 9])), "manifest records the real bytes, not the row's hash");
    assert.deepEqual(new Uint8Array(readFileSync(join(dir, ...entry.path.split("/")))), Uint8Array.from([9, 9, 9]));
  });
});

test("import does not overwrite an existing different file in the target objects folder", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    const blob = world.a_blobs[1]!;
    const squatter = join(world.tgt_objects, ...blob.storage_key.split("/"));
    mkdirSync(dirname(squatter), { recursive: true });
    writeFileSync(squatter, "someone else's bytes");
    assert_import_rejected(world, dir, "object_conflict");
    assert.equal(readFileSync(squatter, "utf8"), "someone else's bytes");
  });
});

// ---------------------------------------------------------------------------
// 5. a live DB is never synchronised by copying its file
// ---------------------------------------------------------------------------

/** Db wrapper that records every SQL string so a test can inspect how export reads. */
function recording_db(db: Db, log: string[]): Db {
  return {
    path: db.path,
    exec: (sql) => {
      log.push(sql);
      db.exec(sql);
    },
    prepare: (sql) => {
      log.push(sql);
      return db.prepare(sql);
    },
    run: (sql, ...params: SqlValue[]) => {
      log.push(sql);
      return db.run(sql, ...params);
    },
    get: <T>(sql: string, ...params: SqlValue[]) => {
      log.push(sql);
      return db.get<T>(sql, ...params);
    },
    all: <T>(sql: string, ...params: SqlValue[]) => {
      log.push(sql);
      return db.all<T>(sql, ...params);
    },
    close: () => db.close(),
  };
}

test("export reads rows inside one transaction and never copies the DB file or uses a backup primitive", () => {
  with_world((world) => {
    const log: string[] = [];
    const dir = join(world.bundles, "tx");
    export_project(recording_db(world.src, log), world.src_objects, world.a.project_id, dir);

    const begin = log.findIndex((sql) => /^\s*BEGIN\b/i.test(sql));
    const end = log.findLastIndex((sql) => /^\s*(COMMIT|ROLLBACK|END)\b/i.test(sql));
    const first_read = log.findIndex((sql) => /\bFROM\s+"?(projects|blobs|stages)\b/i.test(sql));
    assert.ok(begin >= 0, "export must open a transaction");
    assert.ok(first_read > begin, "project rows are read after BEGIN");
    assert.ok(end > first_read, "transaction is closed after the last read");
    assert.equal(log.filter((sql) => /^\s*BEGIN\b/i.test(sql)).length, 1, "a single snapshot, not one per table");
    assert.equal(
      log.filter((sql) => /VACUUM|ATTACH|wal_checkpoint|sqlite3_backup|\.backup|journal_mode|writable_schema/i.test(sql)).length,
      0,
      "no DB-file-level operations",
    );
    assert.equal(
      log.filter((sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql)).length,
      0,
      "export writes nothing to the source db",
    );
  });
});

test("the bundle contains no SQLite database file, journal, or WAL, even while the source DB is open in WAL mode", () => {
  with_world((world) => {
    const reader_row = world.src.get<{ journal_mode: string }>("PRAGMA journal_mode");
    assert.equal(reader_row?.journal_mode, "wal");
    const { dir, manifest } = export_a(world);

    const magic = new TextEncoder().encode("SQLite format 3\0");
    for (const file of manifest.files) {
      const path = join(dir, ...file.path.split("/"));
      assert.ok(!/\.(db|sqlite3?|db-wal|db-shm|wal|shm)$/i.test(file.path), file.path);
      const head = new Uint8Array(readFileSync(path)).subarray(0, magic.length);
      assert.notDeepEqual(head, magic, `${file.path} looks like a copied SQLite file`);
    }
    const names = Object.keys(list_tree(dir));
    assert.ok(names.every((name) => name === "manifest.json" || name.startsWith("rows/") || name.startsWith("objects/")), names.join(","));
  });
});

test("import runs its row writes inside a single transaction on the target", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    const log: string[] = [];
    import_bundle(recording_db(world.tgt, log), world.tgt_objects, dir);
    assert.equal(log.filter((sql) => /^\s*BEGIN\b/i.test(sql)).length, 1);
    assert.equal(log.filter((sql) => /^\s*(COMMIT|END)\b/i.test(sql)).length, 1);
    assert.equal(log.filter((sql) => /VACUUM|ATTACH|wal_checkpoint|writable_schema/i.test(sql)).length, 0);
  });
});

// SEL-36 (stage 2 PR3) hardening round 3: direct tests for the three review
// fixes made in 8eb0f58 (export folder cleanup, row ownership check, objects
// root symlink). Synthetic data only, isolated temp root.

import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";

import { BackupError, export_project, import_bundle, verify_bundle, type Manifest } from "../scripts/pes_core/backup.ts";
import { close_world, list_tree, make_world, meta_of, sha256_hex, type World } from "./helpers/backup_fixture.ts";
import { isolated_home } from "./helpers/isolated_home.ts";
import { state_signature } from "./helpers/state_signature.ts";

function with_world(fn: (world: World) => void): void {
  const home = isolated_home("pes-sel36j-");
  const world = make_world(home);
  try {
    fn(world);
  } finally {
    close_world(world);
    home.cleanup();
  }
}

interface RowsDocShape {
  tables: { name: string; columns: { name: string; type: string }[]; rows: unknown[][] }[];
}

function export_a(world: World, name = "a"): { dir: string; manifest: Manifest } {
  const dir = join(world.bundles, name);
  const result = export_project(world.src, world.src_objects, world.a.project_id, dir);
  return { dir, manifest: result.manifest };
}

function read_manifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
}

/** Edit the rows file, then repair manifest hash/size/counts so only the edit is "wrong". */
function rewrite_rows(dir: string, mutate: (doc: RowsDocShape) => void): void {
  const manifest = read_manifest(dir);
  const entry = manifest.files.find((file) => file.path.startsWith("rows/"));
  assert.ok(entry);
  const path = join(dir, ...entry.path.split("/"));
  const doc = JSON.parse(readFileSync(path, "utf8")) as RowsDocShape;
  mutate(doc);
  const bytes = new TextEncoder().encode(`${JSON.stringify(doc, null, 2)}\n`);
  writeFileSync(path, bytes);
  entry.sha256 = sha256_hex(bytes);
  entry.size = bytes.byteLength;
  const counts: Record<string, number> = {};
  for (const table of doc.tables) if (table.rows.length > 0) counts[table.name] = table.rows.length;
  manifest.table_counts = counts;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

function target_state(world: World) {
  return { signature: state_signature(world.tgt), meta: meta_of(world.tgt), objects: list_tree(world.tgt_objects) };
}

function import_error(world: World, objects_dir: string, dir: string): unknown {
  try {
    import_bundle(world.tgt, objects_dir, dir);
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Every entry (files and folders) below dir, relative POSIX paths. */
function all_entries(dir: string): string[] {
  const out: string[] = [];
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

// ---------------------------------------------------------------------------
// 1. export write failure leaves a pre-existing empty out_dir completely empty
// ---------------------------------------------------------------------------

test("export write failure on the last file leaves a pre-existing empty out_dir completely empty, subfolders included", () => {
  with_world((world) => {
    const out = join(world.bundles, "pre-empty");
    mkdirSync(out, { recursive: true });
    assert.deepEqual(readdirSync(out), []);

    const original = fs.writeFileSync;
    let writes = 0;
    fs.writeFileSync = ((path: unknown, ...rest: unknown[]) => {
      if (String(path).startsWith(out)) {
        writes += 1;
        if (String(path).endsWith("manifest.json")) throw new Error("injected write failure");
      }
      return (original as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();
    try {
      assert.throws(() => export_project(world.src, world.src_objects, world.a.project_id, out), /injected write failure/);
    } finally {
      fs.writeFileSync = original;
      syncBuiltinESMExports();
    }
    assert.ok(writes >= 3, `rows and object files should have been written before the failure (writes=${writes})`);
    assert.ok(existsSync(out), "a pre-existing out_dir stays");
    assert.deepEqual(all_entries(out), [], "no file and no leftover subfolder (rows/, objects/...)");

    // And a retry into the same folder works.
    const result = export_project(world.src, world.src_objects, world.a.project_id, out);
    assert.equal(verify_bundle(out).ok, true);
    assert.ok(result.manifest.files.length >= 4);
  });
});

test("export write failure when out_dir did not exist removes it entirely", () => {
  with_world((world) => {
    const out = join(world.bundles, "not-yet");
    const original = fs.writeFileSync;
    fs.writeFileSync = ((path: unknown, ...rest: unknown[]) => {
      if (String(path).startsWith(out) && String(path).endsWith("manifest.json")) throw new Error("injected write failure");
      return (original as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();
    try {
      assert.throws(() => export_project(world.src, world.src_objects, world.a.project_id, out), /injected write failure/);
    } finally {
      fs.writeFileSync = original;
      syncBuiltinESMExports();
    }
    assert.equal(existsSync(out), false);
  });
});

// ---------------------------------------------------------------------------
// 2. row ownership: every row must belong to the manifest project
// ---------------------------------------------------------------------------

test("a rows-file row whose project_id was changed to another project (hash/size repaired) is bundle_invalid with nothing changed", () => {
  with_world((world) => {
    // Pick a project-owned table that actually has rows and a project_id column.
    const { dir } = export_a(world);
    rewrite_rows(dir, (doc) => {
      const table = doc.tables.find((t) => t.name === "objects" && t.rows.length > 0);
      assert.ok(table, "fixture must export at least one objects row");
      const index = table.columns.findIndex((column) => column.name === "project_id");
      assert.ok(index >= 0);
      table.rows[0]![index] = world.b.project_id;
    });
    assert.equal(verify_bundle(dir).ok, true, "hash/size/counts were repaired, so verify alone does not see it");
    const before = target_state(world);
    const error = import_error(world, world.tgt_objects, dir);
    assert.ok(error instanceof BackupError, String(error));
    assert.equal(error.code, "bundle_invalid");
    assert.deepEqual(target_state(world), before);
    assert.equal(world.tgt.get("SELECT 1 AS x FROM projects WHERE id = ?", world.a.project_id), undefined);
  });
});

test("every project-owned table is checked: changing project_id in the blobs rows is also bundle_invalid", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    rewrite_rows(dir, (doc) => {
      const table = doc.tables.find((t) => t.name === "blobs");
      assert.ok(table);
      const index = table.columns.findIndex((column) => column.name === "project_id");
      table.rows[table.rows.length - 1]![index] = "00000000-0000-0000-0000-000000000000";
    });
    const before = target_state(world);
    const error = import_error(world, world.tgt_objects, dir);
    assert.ok(error instanceof BackupError, String(error));
    assert.equal(error.code, "bundle_invalid");
    assert.deepEqual(target_state(world), before);
  });
});

test("a table outside the allowed set (schema_migrations row, hash repaired) is refused as bundle_invalid with nothing changed", () => {
  with_world((world) => {
    const ddl = "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT)";
    world.tgt.exec(ddl);
    const { dir } = export_a(world);
    rewrite_rows(dir, (doc) => {
      doc.tables.push({
        name: "schema_migrations",
        columns: [
          { name: "version", type: "INTEGER" },
          { name: "name", type: "TEXT" },
        ],
        rows: [[99, "injected"]],
      });
    });
    const before = target_state(world);
    const error = import_error(world, world.tgt_objects, dir);
    assert.ok(error instanceof BackupError, String(error));
    assert.equal(error.code, "bundle_invalid");
    assert.deepEqual(target_state(world), before);
    assert.equal(world.tgt.get("SELECT 1 AS x FROM schema_migrations"), undefined, "the injected row must not be inserted");
  });
});

test("a project-scoped table whose rows file lacks the project_id column is refused", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    rewrite_rows(dir, (doc) => {
      const table = doc.tables.find((t) => t.name === "objects" && t.rows.length > 0);
      assert.ok(table);
      const index = table.columns.findIndex((column) => column.name === "project_id");
      table.columns.splice(index, 1);
      for (const row of table.rows) row.splice(index, 1);
    });
    const before = target_state(world);
    const error = import_error(world, world.tgt_objects, dir);
    assert.ok(error instanceof Error, "import must be refused");
    assert.deepEqual(target_state(world), before);
  });
});

// ---------------------------------------------------------------------------
// 3. a storage_key segment such as "..a" is a legal name, not a parent reference
// ---------------------------------------------------------------------------

test("storage_key segments that merely start with two dots (..a, ..b/c, a..b) export and import fine", () => {
  with_world((world) => {
    const pid = world.a.project_id;
    const names = [`${pid}/..a`, `${pid}/..b/c`, `${pid}/x..y`];
    const payloads = new Map<string, Uint8Array>();
    for (const [index, key] of names.entries()) {
      const bytes = new TextEncoder().encode(`dotted ${index}`);
      payloads.set(key, bytes);
      const target = join(world.src_objects, ...key.split("/"));
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, bytes);
      world.src.run(
        `INSERT INTO blobs (id, project_id, storage_key, sha256, size, media_type, original_name, state, created_by)
         VALUES (?, ?, ?, ?, ?, 'application/octet-stream', ?, 'ready', ?)`,
        globalThis.crypto.randomUUID(),
        pid,
        key,
        sha256_hex(bytes),
        bytes.byteLength,
        `dotted-${index}`,
        world.a.owner_actor_id,
      );
    }
    const { dir, manifest } = export_a(world, "dotted");
    for (const key of names) assert.ok(manifest.files.some((file) => file.path === `objects/${key}`), key);
    assert.equal(verify_bundle(dir).ok, true);

    import_bundle(world.tgt, world.tgt_objects, dir);
    for (const [key, bytes] of payloads) {
      const copied = readFileSync(join(world.tgt_objects, ...key.split("/")));
      assert.deepEqual(Array.from(copied), Array.from(bytes), key);
    }
    assert.ok(world.tgt.get("SELECT 1 AS x FROM projects WHERE id = ?", pid) !== undefined);
  });
});

// ---------------------------------------------------------------------------
// 4. objects_dir root that is a valid symlink is refused with nothing written
// ---------------------------------------------------------------------------

test("a valid symlink as the objects folder root is refused as object_path_unsafe and nothing is written", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    const real = join(world.home.root, "real-objects");
    mkdirSync(real);
    const link = join(world.home.root, "link-objects");
    symlinkSync(real, link, "dir");
    const before = target_state(world);
    const error = import_error(world, link, dir);
    assert.ok(error instanceof BackupError, String(error));
    assert.equal(error.code, "object_path_unsafe");
    assert.deepEqual(all_entries(real), [], "nothing may be written through the link");
    assert.equal(world.tgt.get("SELECT 1 AS x FROM projects WHERE id = ?", world.a.project_id), undefined);
    assert.deepEqual(target_state(world), before);
  });
});

test("a symlink objects root is refused even when the bundle has no object files", () => {
  with_world((world) => {
    world.src.run("DELETE FROM blobs WHERE project_id = ?", world.a.project_id);
    const { dir } = export_a(world, "noblobs");
    const real = join(world.home.root, "real-objects2");
    mkdirSync(real);
    const link = join(world.home.root, "link-objects2");
    symlinkSync(real, link, "dir");
    const before = target_state(world);
    const error = import_error(world, link, dir);
    // Either refused with the same code, or imported without touching the link; never written through it.
    assert.deepEqual(all_entries(real), []);
    if (error !== undefined) {
      assert.ok(error instanceof BackupError, String(error));
      assert.equal(error.code, "object_path_unsafe");
      assert.deepEqual(target_state(world), before);
    }
  });
});

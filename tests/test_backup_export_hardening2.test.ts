// SEL-36 (stage 2 PR3) hardening round 2: attacks on the fixes made in 0d73a2c
// (BLOB tag, storage_key vs manifest cross-check, symlinked objects folder,
// rollback of created folders). Synthetic data only, isolated temp root.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { BackupError, export_project, import_bundle, verify_bundle, type Manifest } from "../scripts/pes_core/backup.ts";
import { close_world, list_tree, make_world, meta_of, sha256_hex, type World } from "./helpers/backup_fixture.ts";
import { isolated_home } from "./helpers/isolated_home.ts";
import { state_signature } from "./helpers/state_signature.ts";

function with_world(fn: (world: World) => void): void {
  const home = isolated_home("pes-sel36i-");
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
  return { dir, manifest: result.manifest };
}

interface RowsDocShape {
  tables: { name: string; columns: { name: string; type: string }[]; rows: unknown[][] }[];
}

function read_manifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
}

function write_manifest(dir: string, manifest: unknown): void {
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
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
  write_manifest(dir, manifest);
}

function blobs_of(doc: RowsDocShape) {
  const blobs = doc.tables.find((table) => table.name === "blobs");
  assert.ok(blobs);
  return { blobs, key_index: blobs.columns.findIndex((column) => column.name === "storage_key") };
}

function target_state(world: World) {
  return { signature: state_signature(world.tgt), meta: meta_of(world.tgt), objects: list_tree(world.tgt_objects) };
}

function import_error(world: World, dir: string): unknown {
  try {
    import_bundle(world.tgt, world.tgt_objects, dir);
  } catch (error) {
    return error;
  }
  return undefined;
}

function assert_refused_cleanly(world: World, dir: string): unknown {
  const before = target_state(world);
  const error = import_error(world, dir);
  assert.ok(error instanceof Error, "import must be refused");
  assert.deepEqual(target_state(world), before, "refused import must leave db, epoch and files untouched");
  assert.equal(world.tgt.get("SELECT 1 AS x FROM projects WHERE id = ?", world.a.project_id), undefined);
  return error;
}

const EXTRA_DDL = "CREATE TABLE zz_extra (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), t TEXT, b BLOB)";

// ---------------------------------------------------------------------------
// BLOB tag collisions
// ---------------------------------------------------------------------------

test("TEXT values shaped like the BLOB tag stay TEXT through export and import", () => {
  with_world((world) => {
    world.src.exec(EXTRA_DDL);
    world.tgt.exec(EXTRA_DDL);
    const lookalikes = ['{"$blob":"AAAA"}', '{"$blob":""}', "$blob", '{"$blob":"AA==","x":1}', "[]", "{}", "null"];
    lookalikes.forEach((text, index) => {
      world.src.run("INSERT INTO zz_extra (id, project_id, t) VALUES (?, ?, ?)", index + 1, world.a.project_id, text);
    });
    const { dir } = export_a(world);
    import_bundle(world.tgt, world.tgt_objects, dir);
    const rows = world.tgt.all<{ t: unknown }>("SELECT t FROM zz_extra WHERE project_id = ? ORDER BY id", world.a.project_id);
    assert.deepEqual(
      rows.map((row) => row.t),
      lookalikes,
    );
    for (const row of rows) assert.equal(typeof row.t, "string");
  });
});

test("a BLOB whose bytes are the ASCII of a tag object stays a BLOB, and a TEXT column keeps its type", () => {
  with_world((world) => {
    world.src.exec(EXTRA_DDL);
    world.tgt.exec(EXTRA_DDL);
    const bytes = new TextEncoder().encode('{"$blob":"AAAA"}');
    world.src.run("INSERT INTO zz_extra (id, project_id, b) VALUES (1, ?, ?)", world.a.project_id, bytes);
    world.src.run("INSERT INTO zz_extra (id, project_id, b) VALUES (2, ?, ?)", world.a.project_id, new Uint8Array(0));
    const { dir } = export_a(world);
    import_bundle(world.tgt, world.tgt_objects, dir);
    const rows = world.tgt.all<{ b: unknown; typ: string }>(
      "SELECT b, typeof(b) AS typ FROM zz_extra WHERE project_id = ? ORDER BY id",
      world.a.project_id,
    );
    assert.deepEqual(rows.map((row) => row.typ), ["blob", "blob"]);
    assert.deepEqual(Array.from(rows[0]!.b as Uint8Array), Array.from(bytes));
    assert.equal((rows[1]!.b as Uint8Array).byteLength, 0);
  });
});

test("malformed tagged values in the rows file are refused cleanly (non-string, whitespace, non-base64, array, other object)", () => {
  const bad: unknown[] = [{ $blob: 123 }, { $blob: "AA==\n" }, { $blob: "A" }, { $blob: "A===" }, { $blob: " AA==" }, ["x"], { other: 1 }, { $blob: null }];
  for (const value of bad) {
    with_world((world) => {
      world.src.exec(EXTRA_DDL);
      world.tgt.exec(EXTRA_DDL);
      world.src.run("INSERT INTO zz_extra (id, project_id, b) VALUES (1, ?, X'00')", world.a.project_id);
      const { dir } = export_a(world);
      rewrite_rows(dir, (doc) => {
        const table = doc.tables.find((t) => t.name === "zz_extra")!;
        table.rows[0]![table.columns.findIndex((c) => c.name === "b")] = value;
      });
      assert_refused_cleanly(world, dir);
    });
  }
});

// ---------------------------------------------------------------------------
// objects_dir itself a symlink
// ---------------------------------------------------------------------------

test("objects_dir that is a symlink to a real folder: import either succeeds fully or refuses with nothing written", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    const real = join(world.home.root, "real-objects");
    mkdirSync(real);
    const link = join(world.home.root, "link-objects");
    symlinkSync(real, link);
    const error = (() => {
      try {
        import_bundle(world.tgt, link, dir);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    const row = world.tgt.get("SELECT 1 AS x FROM projects WHERE id = ?", world.a.project_id);
    if (error === undefined) {
      assert.ok(row !== undefined);
      for (const blob of world.a_blobs) assert.ok(existsSync(join(real, ...blob.storage_key.split("/"))));
    } else {
      assert.ok(error instanceof BackupError, String(error));
      assert.equal(row, undefined);
      assert.deepEqual(readdirSync(real), [], "nothing written through the link when refused");
    }
  });
});

test("objects_dir that is a dangling symlink is refused as a BackupError with no rows written", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    const link = join(world.home.root, "dangling-objects");
    symlinkSync(join(world.home.root, "does-not-exist"), link);
    const before = target_state(world);
    let caught: unknown;
    try {
      import_bundle(world.tgt, link, dir);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof BackupError, `expected BackupError, got ${String(caught)}`);
    assert.equal(world.tgt.get("SELECT 1 AS x FROM projects WHERE id = ?", world.a.project_id), undefined);
    assert.deepEqual(target_state(world), before);
    assert.equal(existsSync(join(world.home.root, "does-not-exist")), false, "must not create the link target");
  });
});

test("objects_dir that is a regular file is refused with nothing written", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    const file = join(world.home.root, "objects-is-a-file");
    writeFileSync(file, "x");
    let caught: unknown;
    try {
      import_bundle(world.tgt, file, dir);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Error);
    assert.equal(world.tgt.get("SELECT 1 AS x FROM projects WHERE id = ?", world.a.project_id), undefined);
    assert.equal(readFileSync(file, "utf8"), "x");
  });
});

// ---------------------------------------------------------------------------
// storage_key spelling: case, unicode normalisation, separators
// ---------------------------------------------------------------------------

test("storage_key spelling variants in the rows file (case, NFD suffix, backslash, trailing slash, dot segment) are refused", () => {
  const variants: Array<(key: string) => string> = [
    (key) => key.toUpperCase(),
    (key) => `${key}́`,
    (key) => key.replace("/", "\\"),
    (key) => `${key}/`,
    (key) => key.replace("/", "/./"),
    (key) => key.replace("/", "//"),
    (key) => `./${key}`,
  ];
  for (const [index, variant] of variants.entries()) {
    with_world((world) => {
      const { dir } = export_a(world);
      rewrite_rows(dir, (doc) => {
        const { blobs, key_index } = blobs_of(doc);
        blobs.rows[0]![key_index] = variant(String(blobs.rows[0]![key_index]));
      });
      assert_refused_cleanly(world, dir);
      void index;
    });
  }
});

test("manifest object path with a backslash or drive letter is refused by verify and import", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    const manifest = read_manifest(dir);
    const object = manifest.files.find((file) => file.path.startsWith("objects/"))!;
    object.path = object.path.replace("/", "\\");
    write_manifest(dir, manifest);
    assert.ok(verify_bundle(dir).problems.some((p) => p.code === "path_unsafe"));
    assert_refused_cleanly(world, dir);
  });
});

// ---------------------------------------------------------------------------
// rollback must not delete what existed before
// ---------------------------------------------------------------------------

function force_commit_failure(dir: string): void {
  rewrite_rows(dir, (doc) => {
    const projects = doc.tables.find((table) => table.name === "projects")!;
    projects.rows[0]![projects.columns.findIndex((column) => column.name === "owner_user_id")] = "no-such-user";
  });
}

test("rollback keeps a pre-existing project folder, its unrelated file, and a pre-existing empty folder", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    const project_folder = join(world.tgt_objects, world.a.project_id);
    mkdirSync(project_folder, { recursive: true });
    writeFileSync(join(project_folder, "unrelated.txt"), "keep me");
    const empty_sibling = join(world.tgt_objects, "pre-existing-empty");
    mkdirSync(empty_sibling);
    force_commit_failure(dir);
    assert_refused_cleanly(world, dir);
    assert.equal(readFileSync(join(project_folder, "unrelated.txt"), "utf8"), "keep me");
    assert.ok(existsSync(empty_sibling));
    assert.deepEqual(readdirSync(project_folder), ["unrelated.txt"], "only the copied files were removed");
  });
});

test("rollback keeps a pre-existing EMPTY project folder (it existed before the import)", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    const project_folder = join(world.tgt_objects, world.a.project_id);
    mkdirSync(project_folder, { recursive: true });
    force_commit_failure(dir);
    assert_refused_cleanly(world, dir);
    assert.ok(existsSync(project_folder), "an empty folder that existed before must survive the rollback");
  });
});

test("rollback keeps a pre-existing identical object file that the import skipped", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    const blob = world.a_blobs[0]!;
    const target = join(world.tgt_objects, ...blob.storage_key.split("/"));
    mkdirSync(join(world.tgt_objects, world.a.project_id), { recursive: true });
    writeFileSync(target, blob.bytes);
    force_commit_failure(dir);
    assert_refused_cleanly(world, dir);
    assert.deepEqual(new Uint8Array(readFileSync(target)), blob.bytes);
  });
});

test("after a rolled-back import the same bundle imports fine (no leftovers block a retry)", () => {
  with_world((world) => {
    const { dir } = export_a(world, "retry");
    const good = join(world.bundles, "retry-good");
    export_project(world.src, world.src_objects, world.a.project_id, good);
    force_commit_failure(dir);
    assert_refused_cleanly(world, dir);
    const result = import_bundle(world.tgt, world.tgt_objects, good);
    assert.equal(result.project_id, world.a.project_id);
    for (const blob of world.a_blobs) {
      assert.deepEqual(new Uint8Array(readFileSync(join(world.tgt_objects, ...blob.storage_key.split("/")))), blob.bytes);
    }
  });
});

// ---------------------------------------------------------------------------
// manifest objects vs blobs rows: missing / extra / duplicate combinations
// ---------------------------------------------------------------------------

test("a blobs row removed from the rows file (object still in manifest) is refused", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    rewrite_rows(dir, (doc) => {
      blobs_of(doc).blobs.rows.pop();
    });
    assert.deepEqual(verify_bundle(dir).problems, []);
    assert_refused_cleanly(world, dir);
  });
});

test("all blobs rows removed (empty table) while objects remain is refused", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    rewrite_rows(dir, (doc) => {
      blobs_of(doc).blobs.rows.length = 0;
    });
    assert_refused_cleanly(world, dir);
  });
});

test("blobs table dropped from the rows file while objects remain is refused", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    rewrite_rows(dir, (doc) => {
      doc.tables = doc.tables.filter((table) => table.name !== "blobs");
    });
    assert_refused_cleanly(world, dir);
  });
});

test("an extra object file listed in the manifest without a blobs row is refused", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    const bytes = new TextEncoder().encode("orphan");
    const sha = sha256_hex(bytes);
    const relative = `objects/${world.a.project_id}/${sha}`;
    writeFileSync(join(dir, ...relative.split("/")), bytes);
    const manifest = read_manifest(dir);
    manifest.files.push({ path: relative, sha256: sha, size: bytes.byteLength });
    write_manifest(dir, manifest);
    assert_refused_cleanly(world, dir);
  });
});

test("two blobs rows pointing at one object (duplicate storage_key) are refused", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    rewrite_rows(dir, (doc) => {
      const { blobs, key_index } = blobs_of(doc);
      const copy = [...blobs.rows[0]!];
      const id_index = blobs.columns.findIndex((column) => column.name === "id");
      copy[id_index] = "00000000-0000-4000-8000-000000000001";
      assert.equal(copy[key_index], blobs.rows[0]![key_index]);
      blobs.rows.push(copy);
    });
    assert_refused_cleanly(world, dir);
  });
});

test("a blobs row whose key points at ANOTHER listed object (two rows swapped onto one key, one object unreferenced) is refused", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    rewrite_rows(dir, (doc) => {
      const { blobs, key_index } = blobs_of(doc);
      assert.ok(blobs.rows.length >= 2);
      blobs.rows[1]![key_index] = blobs.rows[0]![key_index];
    });
    assert_refused_cleanly(world, dir);
  });
});

test("a blobs row key that equals another project's object path (not in the manifest) is refused", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    rewrite_rows(dir, (doc) => {
      const { blobs, key_index } = blobs_of(doc);
      blobs.rows[0]![key_index] = `${world.b.project_id}/${world.b_blobs[0]!.sha256}`;
    });
    assert_refused_cleanly(world, dir);
  });
});

test("export then import of a project with no blobs works (no objects folder is invented)", () => {
  with_world((world) => {
    world.src.run("DELETE FROM blobs WHERE project_id = ?", world.a.project_id);
    const { dir, manifest } = export_a(world, "noblobs");
    assert.equal(manifest.files.filter((file) => file.path.startsWith("objects/")).length, 0);
    const result = import_bundle(world.tgt, world.tgt_objects, dir);
    assert.equal(result.project_id, world.a.project_id);
    assert.equal(existsSync(join(world.tgt_objects, world.a.project_id)), false);
  });
});

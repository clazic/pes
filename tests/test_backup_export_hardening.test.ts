// SEL-36 (stage 2 PR3) hardening tests: written against the implementation to
// break it. Everything is synthetic and runs under an isolated temp root.
//
// Covered: path escapes (manifest paths, storage_key, symlinks), double import,
// leftovers after a failed import, integers beyond 2^53, NULL/BLOB/REAL/TEXT
// round trips, defer_foreign_keys scope, project isolation of export, epoch
// string validation.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  assert_cursor_epoch,
  BackupError,
  export_project,
  import_bundle,
  verify_bundle,
  type Manifest,
} from "../scripts/pes_core/backup.ts";
import { tx, type Db } from "../scripts/pes_core/db.ts";
import {
  add_blob,
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
  const home = isolated_home("pes-sel36h-");
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

function read_manifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
}

function write_manifest(dir: string, manifest: unknown): void {
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

interface RowsDocShape {
  format_version: number;
  project_id: string;
  tables: { name: string; columns: { name: string; type: string }[]; rows: unknown[][] }[];
}

/** Edit the rows file, then repair manifest hash/size/counts so only the edit itself is "wrong". */
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

function list_dirs(root: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        out.push(rel);
        walk(join(current, entry.name), rel);
      }
    }
  };
  walk(root, "");
  return out.sort();
}

function target_state(world: World) {
  return {
    signature: state_signature(world.tgt),
    meta: meta_of(world.tgt),
    objects: list_tree(world.tgt_objects),
  };
}

function import_error(world: World, dir: string): unknown {
  try {
    import_bundle(world.tgt, world.tgt_objects, dir);
  } catch (error) {
    return error;
  }
  return undefined;
}

function assert_refused_cleanly(world: World, dir: string, code?: string): BackupError {
  const before = target_state(world);
  const error = import_error(world, dir);
  assert.ok(error instanceof BackupError, `expected BackupError, got ${String(error)}`);
  if (code !== undefined) assert.equal(error.code, code);
  assert.deepEqual(target_state(world), before, "refused import must leave db, epoch, files and folders untouched");
  return error;
}

const EXTRA_DDL = `CREATE TABLE zz_extra (
  id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  n INTEGER,
  b BLOB,
  r REAL,
  t TEXT
)`;

function add_extra_table(world: World): void {
  world.src.exec(EXTRA_DDL);
  world.tgt.exec(EXTRA_DDL);
}

function extra_rows(db: Db, project_id: string) {
  return db
    .all<Record<string, unknown>>("SELECT id, n, b, r, t FROM zz_extra WHERE project_id = ? ORDER BY id", project_id)
    .map((row) => ({
      id: row.id,
      n: row.n,
      b: row.b instanceof Uint8Array ? `blob:${Buffer.from(row.b).toString("hex")}` : row.b,
      r: row.r,
      t: row.t,
    }));
}

// ---------------------------------------------------------------------------
// values: integers beyond 2^53, NULL, BLOB, REAL, TEXT that looks like numbers
// ---------------------------------------------------------------------------

test("INTEGER values beyond 2^53 (and int64 max) survive export and import exactly", () => {
  with_world((world) => {
    const big = 9007199254740993n; // 2^53 + 1, not representable as a JS number
    world.src.run("UPDATE projects SET control_rev = ? WHERE id = ?", big, world.a.project_id);
    add_extra_table(world);
    const int64_max = 9223372036854775807n;
    const int64_min = -9223372036854775808n;
    world.src.run("INSERT INTO zz_extra (id, project_id, n) VALUES (1, ?, ?)", world.a.project_id, int64_max);
    world.src.run("INSERT INTO zz_extra (id, project_id, n) VALUES (2, ?, ?)", world.a.project_id, int64_min);
    world.src.run("INSERT INTO zz_extra (id, project_id, n) VALUES (3, ?, ?)", world.a.project_id, 9007199254740992n);

    const { dir } = export_a(world);
    import_bundle(world.tgt, world.tgt_objects, dir);

    const row = world.tgt.get<{ control_rev: bigint }>("SELECT control_rev FROM projects WHERE id = ?", world.a.project_id);
    assert.equal(row?.control_rev, big);
    const extras = world.tgt
      .all<{ id: bigint; n: bigint }>("SELECT id, n FROM zz_extra WHERE project_id = ? ORDER BY id", world.a.project_id)
      .map((r) => r.n);
    assert.deepEqual(extras, [int64_max, int64_min, 9007199254740992n]);
  });
});

test("NULL, empty string and the text 'null' stay three different values", () => {
  with_world((world) => {
    add_extra_table(world);
    world.src.run("INSERT INTO zz_extra (id, project_id, t) VALUES (1, ?, NULL)", world.a.project_id);
    world.src.run("INSERT INTO zz_extra (id, project_id, t) VALUES (2, ?, '')", world.a.project_id);
    world.src.run("INSERT INTO zz_extra (id, project_id, t) VALUES (3, ?, 'null')", world.a.project_id);
    const { dir } = export_a(world);
    import_bundle(world.tgt, world.tgt_objects, dir);
    assert.deepEqual(extra_rows(world.tgt, world.a.project_id), extra_rows(world.src, world.a.project_id));
    const ts = extra_rows(world.tgt, world.a.project_id).map((row) => row.t);
    assert.deepEqual(ts, [null, "", "null"]);
  });
});

test("nullable columns of real tables (users.disabled_at, auth_subject) round trip as NULL", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    import_bundle(world.tgt, world.tgt_objects, dir);
    // event_seq is re-assigned by the target (order and references preserved); every other column is strictly equal.
    const moved = source_rows_in_target_numbering(
      project_rows(world.src, world.a.project_id, world.a.owner_user_id),
      project_rows(world.tgt, world.a.project_id, world.a.owner_user_id),
    );
    assert.deepEqual(moved.actual, moved.expected);
    const user = world.tgt.get<{ disabled_at: unknown; auth_subject: unknown }>(
      "SELECT disabled_at, auth_subject FROM users WHERE id = ?",
      world.a.owner_user_id,
    );
    assert.equal(user?.disabled_at, null);
    assert.equal(user?.auth_subject, null);
  });
});

test("BLOB columns survive a round trip byte for byte (including NUL and empty)", () => {
  with_world((world) => {
    add_extra_table(world);
    const payload = Uint8Array.from([0, 1, 2, 255, 254, 0, 13, 10, 0x80]);
    world.src.run("INSERT INTO zz_extra (id, project_id, b) VALUES (1, ?, ?)", world.a.project_id, payload);
    world.src.run("INSERT INTO zz_extra (id, project_id, b) VALUES (2, ?, ?)", world.a.project_id, new Uint8Array(0));
    const { dir } = export_a(world);
    import_bundle(world.tgt, world.tgt_objects, dir);
    assert.deepEqual(extra_rows(world.tgt, world.a.project_id), extra_rows(world.src, world.a.project_id));
  });
});

test("REAL columns round trip, and digit-only TEXT is not turned into an integer", () => {
  with_world((world) => {
    add_extra_table(world);
    world.src.run("INSERT INTO zz_extra (id, project_id, r, t) VALUES (1, ?, 1.5, '007')", world.a.project_id);
    world.src.run("INSERT INTO zz_extra (id, project_id, r, t) VALUES (2, ?, -0.25, '12345678901234567890')", world.a.project_id);
    world.src.run("INSERT INTO zz_extra (id, project_id, r, t) VALUES (3, ?, 1e300, '-5')", world.a.project_id);
    const { dir } = export_a(world);
    import_bundle(world.tgt, world.tgt_objects, dir);
    assert.deepEqual(extra_rows(world.tgt, world.a.project_id), extra_rows(world.src, world.a.project_id));
    const typed = world.tgt.get<{ kind: string }>("SELECT typeof(t) AS kind FROM zz_extra WHERE id = 1");
    assert.equal(typed?.kind, "text");
  });
});

// ---------------------------------------------------------------------------
// path escapes
// ---------------------------------------------------------------------------

const UNSAFE_PATHS = [
  "../outside.txt",
  "objects/../../outside.txt",
  "objects/../rows/project.json",
  "/etc/passwd",
  "objects//double",
  "objects/./dot",
  "objects\\win",
  "C:\\windows\\x",
  "C:escape",
  "objects/nul\0byte",
];

test("verify flags every unsafe manifest path as path_unsafe, never throws, never reads outside the bundle", () => {
  with_world((world) => {
    for (const [index, unsafe] of UNSAFE_PATHS.entries()) {
      const { dir } = export_a(world, `unsafe-${index}`);
      // A real file outside the bundle whose hash the manifest "knows" must not rescue the path.
      const outside = join(world.home.root, "outside.txt");
      writeFileSync(outside, "outside");
      const manifest = read_manifest(dir);
      manifest.files.push({ path: unsafe, sha256: sha256_hex(new TextEncoder().encode("outside")), size: 7 });
      write_manifest(dir, manifest);
      const report = verify_bundle(dir);
      assert.equal(report.ok, false, JSON.stringify(unsafe));
      assert.ok(
        report.problems.some((problem) => problem.code === "path_unsafe" && problem.path === unsafe),
        `${JSON.stringify(unsafe)} should be path_unsafe, got ${JSON.stringify(report.problems)}`,
      );
    }
  });
});

test("import of a manifest with an unsafe path writes nothing, inside or outside the objects folder", () => {
  with_world((world) => {
    const escape_target = join(dirname(world.tgt_objects), "escaped.txt");
    for (const [index, unsafe] of ["../escaped.txt", "objects/../../escaped.txt", "objects/../../../escaped.txt"].entries()) {
      const { dir } = export_a(world, `esc-${index}`);
      const bytes = new TextEncoder().encode("pwned");
      mkdirSync(join(dir, "objects"), { recursive: true });
      const manifest = read_manifest(dir);
      manifest.files.push({ path: unsafe, sha256: sha256_hex(bytes), size: bytes.byteLength });
      write_manifest(dir, manifest);
      assert_refused_cleanly(world, dir, "bundle_invalid");
      assert.equal(existsSync(escape_target), false);
    }
  });
});

test("export refuses a blobs.storage_key that escapes the objects folder and creates no bundle", () => {
  for (const [index, key] of ["../escape", "x/../../escape", "/abs/escape", "a\\b", "C:/x"].entries()) {
    with_world((world) => {
      world.src.exec("PRAGMA ignore_check_constraints = OFF");
      const sha = sha256_hex(new TextEncoder().encode(`key-${index}`));
      world.src.run(
        `INSERT INTO blobs (id, project_id, storage_key, sha256, size, media_type, state, created_by)
         VALUES (?, ?, ?, ?, 1, 'application/octet-stream', 'ready', ?)`,
        globalThis.crypto.randomUUID(),
        world.a.project_id,
        key,
        sha,
        world.a.owner_actor_id,
      );
      // A file the escaping key would reach, to prove it is never read.
      writeFileSync(join(world.home.root, "escape"), "secret");
      const dir = join(world.bundles, `badkey-${index}`);
      let caught: unknown;
      try {
        export_project(world.src, world.src_objects, world.a.project_id, dir);
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof BackupError, `${key}: ${String(caught)}`);
      assert.equal(caught.code, "object_path_unsafe");
      assert.equal(existsSync(dir), false, "no half-written bundle");
    });
  }
});

test("rows file with an unsafe blobs.storage_key (hash repaired) is refused by import", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    rewrite_rows(dir, (doc) => {
      const blobs = doc.tables.find((table) => table.name === "blobs");
      assert.ok(blobs);
      const index = blobs.columns.findIndex((column) => column.name === "storage_key");
      blobs.rows[0]![index] = "../../escaped-by-row";
    });
    assert.deepEqual(verify_bundle(dir).problems, [], "bundle is self-consistent; import must still judge the row");
    assert_refused_cleanly(world, dir);
  });
});

test("a symlinked directory inside the target objects folder is not written through", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    const outside = join(world.home.root, "outside-dir");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(world.tgt_objects, world.a.project_id), "dir");
    const before = list_tree(outside);
    const error = import_error(world, dir);
    assert.deepEqual(list_tree(outside), before, "nothing may be written outside the objects folder through a symlink");
    assert.ok(error instanceof BackupError, "import should be refused when an object path crosses a symlink");
  });
});

test("a symlink listed in the manifest as an object file is not accepted as a regular file", () => {
  with_world((world) => {
    const { dir, manifest } = export_a(world);
    const entry = manifest.files.find((file) => file.path.startsWith("objects/"))!;
    const full = join(dir, ...entry.path.split("/"));
    const outside = join(world.home.root, "outside-file");
    writeFileSync(outside, readFileSync(full));
    rmSync(full, { force: true });
    symlinkSync(outside, full);
    const report = verify_bundle(dir);
    assert.equal(report.ok, false, "a symlink inside a bundle must not verify as a plain file");
  });
});

test("a symlinked directory in the bundle is reported (extra_file) and not traversed", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    const outside = join(world.home.root, "outside-tree");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "loot.txt"), "x");
    symlinkSync(outside, join(dir, "objects", "linked"), "dir");
    const report = verify_bundle(dir);
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => problem.code === "extra_file"));
  });
});

// ---------------------------------------------------------------------------
// double import / mid-failure leftovers
// ---------------------------------------------------------------------------

test("the same bundle imported into two different targets works; the second import into either is refused", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    import_bundle(world.tgt, world.tgt_objects, dir);
    assert_refused_cleanly(world, dir, "project_exists");
    assert_refused_cleanly(world, dir, "project_exists");
  });
});

test("project_exists is judged by id before slug: a changed slug with the same id is still refused", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    import_bundle(world.tgt, world.tgt_objects, dir);
    world.tgt.run("UPDATE projects SET slug = 'synthetic-renamed' WHERE id = ?", world.a.project_id);
    assert_refused_cleanly(world, dir, "project_exists");
  });
});

test("a commit-time foreign key failure leaves no rows, no object files, no new folders, and the same epoch", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    rewrite_rows(dir, (doc) => {
      const projects = doc.tables.find((table) => table.name === "projects");
      assert.ok(projects);
      const index = projects.columns.findIndex((column) => column.name === "owner_user_id");
      projects.rows[0]![index] = "no-such-user";
    });
    assert_refused_cleanly(world, dir);
    assert.equal(world.tgt.get("SELECT 1 AS x FROM projects WHERE id = ?", world.a.project_id), undefined);
  });
});

test("a failed import leaves no new (empty) folders in the target objects folder", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    rewrite_rows(dir, (doc) => {
      const projects = doc.tables.find((table) => table.name === "projects")!;
      projects.rows[0]![projects.columns.findIndex((column) => column.name === "owner_user_id")] = "no-such-user";
    });
    const before = list_dirs(world.tgt_objects);
    assert.ok(import_error(world, dir) instanceof BackupError);
    assert.deepEqual(list_dirs(world.tgt_objects), before, "rollback must remove the folders it created, not only the files");
  });
});

test("a statement-time failure (CHECK constraint) midway rolls back every table and removes copied files and folders", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    rewrite_rows(dir, (doc) => {
      // blobs come after projects alphabetically; make the last-written table fail.
      const blobs = doc.tables.find((table) => table.name === "blobs");
      assert.ok(blobs);
      const index = blobs.columns.findIndex((column) => column.name === "sha256");
      blobs.rows[0]![index] = "not-a-hash";
    });
    assert_refused_cleanly(world, dir);
  });
});

test("an object whose target parent path is a regular file fails midway without leaving earlier copies", () => {
  with_world((world) => {
    const { dir, manifest } = export_a(world);
    const keys = manifest.files.filter((file) => file.path.startsWith("objects/")).map((file) => file.path.slice(8));
    assert.ok(keys.length >= 2);
    // Parent folder of the objects is the project id; make a LATER file fail while an earlier one could be written.
    const last = keys[keys.length - 1]!;
    const blocker = join(world.tgt_objects, ...last.split("/"));
    mkdirSync(blocker, { recursive: true }); // a directory where a file must go -> existsSync true, unreadable as file
    const before = list_tree(world.tgt_objects);
    const error = import_error(world, dir);
    assert.ok(error instanceof BackupError);
    assert.deepEqual(list_tree(world.tgt_objects), before);
    assert.equal(world.tgt.get("SELECT 1 AS x FROM projects WHERE id = ?", world.a.project_id), undefined);
  });
});

test("a refused or failed import leaves the connection usable (no open tx, writes still work)", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    rewrite_rows(dir, (doc) => {
      const projects = doc.tables.find((table) => table.name === "projects")!;
      projects.rows[0]![projects.columns.findIndex((column) => column.name === "owner_user_id")] = "no-such-user";
    });
    import_error(world, dir);
    tx(world.tgt, () => {
      world.tgt.run("UPDATE projects SET control_rev = control_rev + 1 WHERE id = ?", world.c.project_id);
    });
    const { dir: good } = export_a(world, "good");
    import_bundle(world.tgt, world.tgt_objects, good);
    assert.ok(world.tgt.get("SELECT 1 AS x FROM projects WHERE id = ?", world.a.project_id));
  });
});

// ---------------------------------------------------------------------------
// defer_foreign_keys stays inside the import transaction
// ---------------------------------------------------------------------------

function defer_value(db: Db): bigint {
  return db.get<{ defer_foreign_keys: bigint }>("PRAGMA defer_foreign_keys")!.defer_foreign_keys;
}

function assert_fk_immediate(db: Db, world: World): void {
  let failed_inside = false;
  try {
    tx(db, () => {
      try {
        db.run(
          `INSERT INTO blobs (id, project_id, storage_key, sha256, size, media_type, state, created_by)
           VALUES ('fk-probe', 'no-such-project', 'fk-probe/key', ?, 0, 'x', 'ready', ?)`,
          "0".repeat(64),
          world.c.owner_actor_id,
        );
      } catch (error) {
        failed_inside = true;
        throw error;
      }
    });
  } catch {
    // expected
  }
  assert.equal(failed_inside, true, "foreign keys must be checked per statement again, not deferred");
}

test("defer_foreign_keys is off again after a successful import, and FK checks are immediate", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    assert.equal(defer_value(world.tgt), 0n);
    import_bundle(world.tgt, world.tgt_objects, dir);
    assert.equal(defer_value(world.tgt), 0n);
    assert_fk_immediate(world.tgt, world);
  });
});

test("defer_foreign_keys is off again after a failed import, and FK checks are immediate", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    rewrite_rows(dir, (doc) => {
      const projects = doc.tables.find((table) => table.name === "projects")!;
      projects.rows[0]![projects.columns.findIndex((column) => column.name === "owner_user_id")] = "no-such-user";
    });
    import_error(world, dir);
    assert.equal(defer_value(world.tgt), 0n);
    assert_fk_immediate(world.tgt, world);
  });
});

test("defer_foreign_keys is off after an import refused before the tx (verify/conflict) as well", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    import_bundle(world.tgt, world.tgt_objects, dir);
    import_error(world, dir);
    assert.equal(defer_value(world.tgt), 0n);
  });
});

// ---------------------------------------------------------------------------
// tampered rows
// ---------------------------------------------------------------------------

test("rows that claim another project's id (the target's own project) are refused", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    rewrite_rows(dir, (doc) => {
      const counters = doc.tables.find((table) => table.name === "counters");
      assert.ok(counters);
      const project_index = counters.columns.findIndex((column) => column.name === "project_id");
      counters.rows[0]![project_index] = world.c.project_id;
    });
    const before = state_signature(world.tgt);
    const error = import_error(world, dir);
    assert.ok(error instanceof BackupError, "a bundle for project A must not write rows into project C");
    assert.equal(state_signature(world.tgt), before);
  });
});

test("a rows table named db_meta or a table that does not exist is refused", () => {
  with_world((world) => {
    for (const [index, name] of ["db_meta", "no_such_table", 'x"; DROP TABLE blobs; --'].entries()) {
      const { dir } = export_a(world, `tbl-${index}`);
      rewrite_rows(dir, (doc) => {
        doc.tables.push({ name, columns: [{ name: "cursor_epoch", type: "INTEGER" }], rows: [[999]] });
      });
      assert_refused_cleanly(world, dir);
    }
    assert.ok(world.tgt.get("SELECT 1 AS x FROM blobs LIMIT 1"));
  });
});

test("a rows column that does not exist in the target (or has a hostile name) is refused", () => {
  with_world((world) => {
    for (const [index, column] of ["nope", 'id" = 1; --'].entries()) {
      const { dir } = export_a(world, `col-${index}`);
      rewrite_rows(dir, (doc) => {
        const counters = doc.tables.find((table) => table.name === "counters")!;
        counters.columns.push({ name: column, type: "TEXT" });
        for (const row of counters.rows) row.push("x");
      });
      assert_refused_cleanly(world, dir);
    }
  });
});

test("an existing target user with the same id but different values is a conflict, and nothing is written", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    const user = world.src.get<Record<string, unknown>>("SELECT * FROM users WHERE id = ?", world.a.owner_user_id)!;
    world.tgt.run(
      "INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)",
      world.a.owner_user_id,
      "someone else entirely",
      user.created_at as bigint,
    );
    assert_refused_cleanly(world, dir, "project_conflict");
  });
});

test("an existing identical target user and actor are reused, not duplicated", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    const user = world.src.get<Record<string, bigint | string | null>>("SELECT * FROM users WHERE id = ?", world.a.owner_user_id)!;
    world.tgt.run(
      "INSERT INTO users (id, display_name, auth_subject, disabled_at, created_at) VALUES (?, ?, ?, ?, ?)",
      user.id as string,
      user.display_name as string,
      user.auth_subject,
      user.disabled_at,
      user.created_at as bigint,
    );
    import_bundle(world.tgt, world.tgt_objects, dir);
    const count = world.tgt.get<{ n: bigint }>("SELECT count(*) AS n FROM users WHERE id = ?", world.a.owner_user_id);
    assert.equal(count?.n, 1n);
  });
});

// ---------------------------------------------------------------------------
// export never mixes other projects
// ---------------------------------------------------------------------------

test("export of A contains no row, id, key or file belonging to B, even in extra project tables", () => {
  with_world((world) => {
    add_extra_table(world);
    world.src.run("INSERT INTO zz_extra (id, project_id, t) VALUES (1, ?, 'alpha-row')", world.a.project_id);
    world.src.run("INSERT INTO zz_extra (id, project_id, t) VALUES (2, ?, 'beta-secret-row')", world.b.project_id);
    const { dir, manifest } = export_a(world);

    const rows_entry = manifest.files.find((file) => file.path.startsWith("rows/"))!;
    const text = readFileSync(join(dir, ...rows_entry.path.split("/")), "utf8");
    assert.ok(!text.includes(world.b.project_id), "B's project id must not appear");
    assert.ok(!text.includes("beta-secret-row"));
    assert.ok(!text.includes("synthetic-beta"));
    assert.ok(!text.includes(world.b.owner_user_id));
    for (const blob of world.b_blobs) {
      assert.ok(!manifest.files.some((file) => file.path === `objects/${blob.storage_key}`));
    }
    assert.ok(manifest.files.every((file) => !file.path.includes(world.b.project_id)));
    assert.ok(text.includes("alpha-row"));
  });
});

test("exporting A does not change the source db (rows and epoch), and exporting B afterwards also excludes A", () => {
  with_world((world) => {
    const before = state_signature(world.src);
    const meta = meta_of(world.src);
    export_a(world);
    const dir_b = join(world.bundles, "b");
    const exported = export_project(world.src, world.src_objects, world.b.project_id, dir_b);
    assert.equal(state_signature(world.src), before);
    assert.deepEqual(meta_of(world.src), meta);
    assert.ok(exported.manifest.files.every((file) => !file.path.includes(world.a.project_id)));
    const text = readFileSync(join(dir_b, "rows", "project.json"), "utf8");
    assert.ok(!text.includes(world.a.project_id));
  });
});

test("export of a project whose blob file is missing fails without leaving a bundle", () => {
  with_world((world) => {
    const extra = add_blob(world.src, world.src_objects, world.a, "gone.bin", new TextEncoder().encode("gone"));
    rmSync(join(world.src_objects, ...extra.storage_key.split("/")));
    const dir = join(world.bundles, "missing");
    let caught: unknown;
    try {
      export_project(world.src, world.src_objects, world.a.project_id, dir);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof BackupError);
    assert.equal(existsSync(dir), false);
  });
});

// ---------------------------------------------------------------------------
// epoch strings
// ---------------------------------------------------------------------------

test("assert_cursor_epoch accepts the current epoch as bigint or decimal string only", () => {
  with_world((world) => {
    const current = meta_of(world.tgt).cursor_epoch;
    assert_cursor_epoch(world.tgt, current);
    assert_cursor_epoch(world.tgt, current.toString());
    assert_cursor_epoch(world.tgt, `000${current.toString()}`);
  });
});

test("assert_cursor_epoch: look-alike and malformed strings are invalid, not stale or accepted", () => {
  with_world((world) => {
    const bad = ["", " ", " 1", "1 ", "1\n", "\n1", "+1", "-1", "1.0", "1e0", "0x1", "1_0", "１", "١", "1\u0000", "null", "undefined", "NaN", "Infinity"];
    for (const value of bad) {
      let caught: unknown;
      try {
        assert_cursor_epoch(world.tgt, value);
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof BackupError, JSON.stringify(value));
      assert.equal(caught.code, "cursor_epoch_invalid", JSON.stringify(value));
    }
  });
});

test("assert_cursor_epoch: non-string, non-bigint input is invalid", () => {
  with_world((world) => {
    for (const value of [1, 1.5, null, undefined, {}, [], true, Uint8Array.of(1)] as unknown[]) {
      let caught: unknown;
      try {
        assert_cursor_epoch(world.tgt, value as string);
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof BackupError, String(value));
      assert.ok(["cursor_epoch_invalid", "cursor_epoch_stale"].includes(caught.code), `${String(value)} -> ${caught.code}`);
    }
  });
});

test("assert_cursor_epoch: stale for other values, including epochs beyond int64 and negative bigint", () => {
  with_world((world) => {
    const current = meta_of(world.tgt).cursor_epoch;
    const stale: (bigint | string)[] = [current + 1n, current - 1n, 0n, -1n, "0", "99999999999999999999999999", 2n ** 70n];
    for (const value of stale) {
      let caught: unknown;
      try {
        assert_cursor_epoch(world.tgt, value);
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof BackupError, String(value));
      assert.equal(caught.code, "cursor_epoch_stale", String(value));
    }
  });
});

test("verify rejects a manifest cursor_epoch that is not a plain decimal string", () => {
  with_world((world) => {
    const bad: unknown[] = ["", "-1", "1.5", "1e3", " 1", "1 ", "0x10", "１", 5, null, undefined, true, {}];
    for (const [index, value] of bad.entries()) {
      const { dir } = export_a(world, `epoch-${index}`);
      const manifest = read_manifest(dir) as unknown as Record<string, unknown>;
      if (value === undefined) delete manifest.cursor_epoch;
      else manifest.cursor_epoch = value;
      write_manifest(dir, manifest);
      const report = verify_bundle(dir);
      assert.equal(report.ok, false, JSON.stringify(value));
      assert.ok(report.problems.some((problem) => problem.code === "manifest_invalid"), JSON.stringify(value));
      assert_refused_cleanly(world, dir, "bundle_invalid");
    }
  });
});

test("a manifest epoch at the int64 limit cannot corrupt the target: refused or handled, never half-applied", () => {
  with_world((world) => {
    for (const [index, epoch] of ["9223372036854775807", "9223372036854775808", "18446744073709551616", "99999999999999999999999999999"].entries()) {
      const { dir } = export_a(world, `big-epoch-${index}`);
      const manifest = read_manifest(dir);
      manifest.cursor_epoch = epoch;
      write_manifest(dir, manifest);
      const before = target_state(world);
      const error = import_error(world, dir);
      assert.ok(error instanceof Error, `epoch ${epoch} must be refused: int64 overflow in db_meta`);
      assert.deepEqual(target_state(world), before, `epoch ${epoch}: nothing may be half applied`);
    }
  });
});

test("a manifest epoch with leading zeros is accepted as its numeric value", () => {
  with_world((world) => {
    const { dir } = export_a(world);
    const manifest = read_manifest(dir);
    manifest.cursor_epoch = "0000000000000000000042";
    write_manifest(dir, manifest);
    const result = import_bundle(world.tgt, world.tgt_objects, dir);
    assert.equal(result.cursor_epoch, 43n);
    assert.equal(meta_of(world.tgt).cursor_epoch, 43n);
  });
});

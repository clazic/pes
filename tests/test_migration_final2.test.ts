// SEL-45 (stage 2 PR12) regression tests for the final review 2/2 (logs/SEL-45-final-review-2.md, F3):
// sweep_project_files_strict followed a symlink at the OBJECTS ROOT and deleted a file outside the store,
// and restore_project reported success (an object-less bundle never goes through the PR9 root checks).
// Everything is synthetic, inside the test's isolated HOME; every link target is inside the temporary root.
//
//  (a) object-less bundle + objects root is a symlink to a folder outside the store:
//      restore is refused (not a success); the outside file, the database and the cursor are unchanged
//  (b) objects root is a regular file / does not exist (lstat fails): refused too (all OS, no symlink needed)
//  (c) the same rules for a bundle that has objects
//  (d) sweep_project_files_strict called directly with a link / non-directory root: deletes nothing, reports failure
//  (e) control: a normal root behaves as before (restore succeeds, a stray file is removed, kept files stay)
//  (f) objects/<project_id> itself is a link, and a link in a sub folder: never followed, outside files stay
//  (g) the old cleanup path (scan_project_files + delete_project_file) and the new sweep follow the same root rule
//
// Tests that need a symlink are skipped where symlinks cannot be created (e.g. Windows without the privilege).

import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { export_project } from "../scripts/pes_core/backup.ts";
import { delete_project_file, scan_project_files, sweep_project_files_strict } from "../scripts/pes_core/files.ts";
import {
  activated,
  cursor_epoch,
  object_files,
  rejects_any,
  state_signature,
  with_migration,
  write_topic,
  type Env,
} from "./helpers/migration_env.ts";
import { list_tree } from "./helpers/backup_fixture.ts";

// ---------------------------------------------------------------------------
// helpers

function can_symlink(): boolean {
  const base = join(tmpdir(), `pes-symlink-probe-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(base, { recursive: true });
    mkdirSync(join(base, "target"));
    symlinkSync(join(base, "target"), join(base, "link"), "dir");
    return lstatSync(join(base, "link")).isSymbolicLink();
  } catch {
    return false;
  } finally {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

const SYMLINKS = can_symlink();
const link_opts = { skip: SYMLINKS ? false : "symbolic links cannot be created here" };

const OUTSIDE_TEXT = "synthetic outside file: must remain";

/** A folder outside the store (inside the test's temporary root) holding <project_id>/must-remain.txt. */
function make_outside(env: Env, project_id: string, name = "synthetic-outside-store"): { dir: string; file: string; snapshot: () => Record<string, string> } {
  const dir = join(env.home.root, name);
  mkdirSync(join(dir, project_id), { recursive: true });
  const file = join(dir, project_id, "must-remain.txt");
  writeFileSync(file, OUTSIDE_TEXT);
  return { dir, file, snapshot: () => list_tree(dir) };
}

function assert_outside_intact(outside: { file: string; snapshot: () => Record<string, string> }, before: Record<string, string>, what: string): void {
  assert.ok(existsSync(outside.file), `${what}: the file outside the store still exists`);
  assert.equal(readFileSync(outside.file, "utf8"), OUTSIDE_TEXT, `${what}: and has the same bytes`);
  assert.deepEqual(outside.snapshot(), before, `${what}: nothing was added or removed outside the store`);
}

/** Move the real objects root away and put `replace` in its place. Returns the moved folder. */
function swap_root(env: Env, replace: (root: string) => void): string {
  const moved = `${env.objects}-moved`;
  renameSync(env.objects, moved);
  replace(env.objects);
  return moved;
}

function restore_opts(env: Env, project_id: string, bundle_dir: string) {
  return { owner_actor_id: env.p.actor_id, project_id, bundle_dir };
}

/** A good bundle of the (object-less) bootstrap project, plus one later write so the restore has work to do. */
async function empty_bundle(env: Env, name: string): Promise<{ project_id: string; bundle: string }> {
  const project_id = env.p.project_id;
  const bundle = join(env.home.root, name);
  export_project(env.db, env.objects, project_id, bundle);
  await write_topic(env, project_id, `${name} 쓰기`, `${name}-w`);
  return { project_id, bundle };
}

type Snap = { rows: string; epoch: bigint };
function snap(env: Env): Snap {
  return { rows: state_signature(env.db), epoch: cursor_epoch(env.db) };
}
function assert_snap(env: Env, before: Snap, what: string): void {
  assert.equal(state_signature(env.db), before.rows, `${what}: the database is unchanged`);
  assert.equal(cursor_epoch(env.db), before.epoch, `${what}: the cursor epoch is unchanged`);
}

// ---------------------------------------------------------------------------
// (e) control

test("F3e control: an object-less bundle restores through a normal objects root", async () => {
  await with_migration(async (env, _legacy, mig) => {
    const { project_id, bundle } = await empty_bundle(env, "f3e-empty");
    const before = cursor_epoch(env.db);
    const out = await mig.restore_project(env.service, restore_opts(env, project_id, bundle));
    assert.equal(out.project_id, project_id);
    assert.equal(out.cursor_epoch_after, (before + 1n).toString());
  });
});

test("F3e control: sweep_project_files_strict on a normal root removes a stray file and keeps the kept one", async () => {
  await with_migration(async (env) => {
    const id = env.p.project_id;
    const dir = join(env.objects, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "kept.bin"), "keep");
    writeFileSync(join(dir, "stray.bin"), "stray");
    const failed = sweep_project_files_strict(env.objects, id, new Set([`${id}/kept.bin`]));
    assert.deepEqual(failed, [], "nothing is out of line");
    assert.equal(existsSync(join(dir, "kept.bin")), true);
    assert.equal(existsSync(join(dir, "stray.bin")), false);
  });
});

// ---------------------------------------------------------------------------
// (a) object-less bundle + root link

test("F3a an object-less bundle and an objects root that is a symlink to a folder outside the store: restore is refused; outside file, database and cursor unchanged", link_opts, async () => {
  await with_migration(async (env, _legacy, mig) => {
    const { project_id, bundle } = await empty_bundle(env, "f3a-empty");
    const outside = make_outside(env, project_id);
    const outside_before = outside.snapshot();
    const moved = swap_root(env, (root) => symlinkSync(outside.dir, root, "dir"));
    try {
      const before = snap(env);
      await rejects_any(mig.restore_project(env.service, restore_opts(env, project_id, bundle)));
      assert_outside_intact(outside, outside_before, "F3a");
      assert_snap(env, before, "F3a");
      assert.equal(lstatSync(env.objects).isSymbolicLink(), true, "the link itself is left as it is");
    } finally {
      rmSync(env.objects, { force: true });
      renameSync(moved, env.objects);
    }
    // With the real root back the same bundle restores (the refusal did not poison anything).
    const ok = await mig.restore_project(env.service, restore_opts(env, project_id, bundle));
    assert.equal(ok.project_id, project_id);
  });
});

// ---------------------------------------------------------------------------
// (b) root is not a directory / lstat fails (every OS)

test("F3b an object-less bundle and an objects root that is a regular file: restore is refused; database and cursor unchanged", async () => {
  await with_migration(async (env, _legacy, mig) => {
    const { project_id, bundle } = await empty_bundle(env, "f3b-file");
    const moved = swap_root(env, (root) => writeFileSync(root, "synthetic: a file where the store should be"));
    try {
      const before = snap(env);
      await rejects_any(mig.restore_project(env.service, restore_opts(env, project_id, bundle)));
      assert_snap(env, before, "F3b");
      assert.equal(lstatSync(env.objects).isFile(), true, "the file is left as it is");
      assert.equal(readFileSync(env.objects, "utf8"), "synthetic: a file where the store should be");
    } finally {
      rmSync(env.objects, { force: true });
      renameSync(moved, env.objects);
    }
  });
});

test("F3b an object-less bundle and an objects root that does not exist (lstat fails): restore is refused; database and cursor unchanged", async () => {
  await with_migration(async (env, _legacy, mig) => {
    const { project_id, bundle } = await empty_bundle(env, "f3b-missing");
    const moved = swap_root(env, () => undefined);
    try {
      const before = snap(env);
      await rejects_any(mig.restore_project(env.service, restore_opts(env, project_id, bundle)));
      assert_snap(env, before, "F3b missing");
      assert.equal(existsSync(env.objects), false, "no store was created on the way");
    } finally {
      rmSync(env.objects, { recursive: true, force: true });
      renameSync(moved, env.objects);
    }
  });
});

// ---------------------------------------------------------------------------
// (c) a bundle that has objects

test("F3c a bundle with objects and an objects root that is a symlink to a folder outside the store: restore is refused; outside file, database, cursor unchanged", link_opts, async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated(env, legacy, mig, "full", "f3c-link");
    const id = a.imp.project_id;
    await write_topic(env, id, "F3c 활성화 뒤 쓰기", "f3c-w1");
    assert.ok(Object.keys(object_files(env, id)).length > 0, "the bundle has objects");
    const outside = make_outside(env, id);
    const outside_before = outside.snapshot();
    const moved = swap_root(env, (root) => symlinkSync(outside.dir, root, "dir"));
    try {
      const before = snap(env);
      await rejects_any(mig.restore_project(env.service, restore_opts(env, id, a.act.backup_dir)));
      assert_outside_intact(outside, outside_before, "F3c");
      assert_snap(env, before, "F3c");
    } finally {
      rmSync(env.objects, { force: true });
      renameSync(moved, env.objects);
    }
  });
});

test("F3c a bundle with objects and an objects root that is a regular file: restore is refused; database and cursor unchanged", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated(env, legacy, mig, "full", "f3c-file");
    const id = a.imp.project_id;
    await write_topic(env, id, "F3c 둘째 쓰기", "f3c-w2");
    const moved = swap_root(env, (root) => writeFileSync(root, "synthetic: a file where the store should be"));
    try {
      const before = snap(env);
      await rejects_any(mig.restore_project(env.service, restore_opts(env, id, a.act.backup_dir)));
      assert_snap(env, before, "F3c file");
      assert.equal(lstatSync(env.objects).isFile(), true);
    } finally {
      rmSync(env.objects, { force: true });
      renameSync(moved, env.objects);
    }
  });
});

// ---------------------------------------------------------------------------
// (d) sweep_project_files_strict called directly

test("F3d sweep_project_files_strict with a root that is a symlink: deletes nothing, reports a failure", link_opts, async () => {
  await with_migration(async (env) => {
    const id = env.p.project_id;
    const outside = make_outside(env, id);
    const outside_before = outside.snapshot();
    const link = join(env.home.root, "synthetic-root-link");
    symlinkSync(outside.dir, link, "dir");
    const failed = sweep_project_files_strict(link, id, new Set());
    assert.ok(failed.length > 0, "the failure is reported, not hidden");
    assert.ok(failed.every((key) => key === id || key.startsWith(`${id}/`)), `failed keys name the project: ${JSON.stringify(failed)}`);
    assert_outside_intact(outside, outside_before, "F3d");
    // Also with a kept key: still nothing is deleted and a failure is reported.
    const failed_keep = sweep_project_files_strict(link, id, new Set([`${id}/other.bin`]));
    assert.ok(failed_keep.length > 0);
    assert_outside_intact(outside, outside_before, "F3d keep");
  });
});

test("F3d sweep_project_files_strict with a root that is a regular file or missing: reports a failure, changes nothing", async () => {
  await with_migration(async (env) => {
    const id = env.p.project_id;
    const file_root = join(env.home.root, "synthetic-root-file");
    writeFileSync(file_root, "synthetic");
    assert.ok(sweep_project_files_strict(file_root, id, new Set()).length > 0, "a file root fails");
    assert.equal(readFileSync(file_root, "utf8"), "synthetic");
    const missing = join(env.home.root, "synthetic-root-missing");
    assert.ok(sweep_project_files_strict(missing, id, new Set()).length > 0, "a missing root fails");
    assert.equal(existsSync(missing), false, "and is not created");
  });
});

// ---------------------------------------------------------------------------
// (f) project folder link, sub folder link

test("F3f objects/<project_id> is a symlink to a folder outside the store: never followed; outside files stay (sweep and restore)", link_opts, async () => {
  await with_migration(async (env, _legacy, mig) => {
    const { project_id, bundle } = await empty_bundle(env, "f3f-project-link");
    const outside = make_outside(env, "inner");
    const outside_before = outside.snapshot();
    rmSync(join(env.objects, project_id), { recursive: true, force: true });
    symlinkSync(outside.dir, join(env.objects, project_id), "dir");

    const failed = sweep_project_files_strict(env.objects, project_id, new Set());
    assert.ok(failed.length > 0, "sweep reports the linked project folder");
    assert_outside_intact(outside, outside_before, "F3f sweep");

    await rejects_any(mig.restore_project(env.service, restore_opts(env, project_id, bundle)));
    assert_outside_intact(outside, outside_before, "F3f restore");
    assert.equal(lstatSync(join(env.objects, project_id)).isSymbolicLink(), true, "the link is left as it is");
  });
});

test("F3f a link in a sub folder of objects/<project_id> that points outside: sweep and restore report it and do not follow it", link_opts, async () => {
  await with_migration(async (env, _legacy, mig) => {
    const { project_id, bundle } = await empty_bundle(env, "f3f-sub-link");
    const outside = make_outside(env, "sub");
    const outside_before = outside.snapshot();
    const project_dir = join(env.objects, project_id);
    mkdirSync(project_dir, { recursive: true });
    const link = join(project_dir, "sublink");
    symlinkSync(outside.dir, link, "dir");

    const failed = sweep_project_files_strict(env.objects, project_id, new Set());
    assert.ok(failed.includes(`${project_id}/sublink`), `sweep names the link: ${JSON.stringify(failed)}`);
    assert_outside_intact(outside, outside_before, "F3f sweep sub");
    assert.equal(lstatSync(link).isSymbolicLink(), true);

    // Even when the bundle expects a file below that link name, nothing outside is touched.
    const failed_keep = sweep_project_files_strict(env.objects, project_id, new Set([`${project_id}/sublink/x.bin`]));
    assert.ok(failed_keep.length > 0);
    assert_outside_intact(outside, outside_before, "F3f sweep sub keep");

    await rejects_any(mig.restore_project(env.service, restore_opts(env, project_id, bundle)));
    assert_outside_intact(outside, outside_before, "F3f restore sub");
    assert.equal(lstatSync(link).isSymbolicLink(), true, "the link is kept and reported");
  });
});

// ---------------------------------------------------------------------------
// (g) old and new cleanup paths follow the same root rule

test("F3g scan_project_files + delete_project_file and sweep_project_files_strict all leave the outside file alone when the root is a symlink", link_opts, async () => {
  await with_migration(async (env) => {
    const id = env.p.project_id;
    const outside = make_outside(env, id);
    const outside_before = outside.snapshot();
    const link = join(env.home.root, "synthetic-root-link-g");
    symlinkSync(outside.dir, link, "dir");

    assert.deepEqual(scan_project_files(link, id), [], "old path: nothing is scanned below a linked root");
    delete_project_file(link, id, { key: `${id}/must-remain.txt`, path: outside.file, mtime_ms: 0 });
    assert_outside_intact(outside, outside_before, "F3g old path");

    const failed = sweep_project_files_strict(link, id, new Set());
    assert.ok(failed.length > 0, "new path: failure reported");
    assert_outside_intact(outside, outside_before, "F3g new path");
  });
});

test("F3g scan_project_files + delete_project_file and sweep_project_files_strict all do nothing when the root is a regular file", async () => {
  await with_migration(async (env) => {
    const id = env.p.project_id;
    const root = join(env.home.root, "synthetic-root-file-g");
    writeFileSync(root, "synthetic");
    assert.deepEqual(scan_project_files(root, id), []);
    delete_project_file(root, id, { key: `${id}/x.bin`, path: join(root, id, "x.bin"), mtime_ms: 0 });
    assert.equal(readFileSync(root, "utf8"), "synthetic");
    assert.ok(sweep_project_files_strict(root, id, new Set()).length > 0);
    assert.equal(readFileSync(root, "utf8"), "synthetic");
  });
});

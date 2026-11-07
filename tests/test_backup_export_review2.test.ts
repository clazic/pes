// SEL-36 (stage 2 PR3) regression tests for final review 2/2 (필수 1):
//   verify_bundle / import_bundle must not follow a symlinked INTERMEDIATE directory
//   (rows/linked -> outside, objects/linked -> outside) or a symlinked manifest.json to
//   read a file outside the bundle, and must not leak its content in results or errors.
// Expected problem codes (chosen from the existing ProblemCode list):
//   - intermediate symlink: "path_unsafe" (same code the existing last-component symlink check uses)
//   - manifest.json symlink: "path_unsafe" or "manifest_invalid" (the manifest is not a trusted regular file)
// Synthetic data only, isolated temp root. The read counter resolves every path with realpath,
// so a read through a link is counted no matter which fs entry point is used.

import assert from "node:assert/strict";
import fs, { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";

import { BackupError, export_project, import_bundle, verify_bundle, type Manifest } from "../scripts/pes_core/backup.ts";
import { close_world, list_tree, make_world, meta_of, type World } from "./helpers/backup_fixture.ts";
import { isolated_home } from "./helpers/isolated_home.ts";
import { state_signature } from "./helpers/state_signature.ts";

const CANARY = "SYNTHETIC_PRIVATE_CANARY";

function with_world(fn: (world: World) => void): void {
  const home = isolated_home("pes-sel36r2-");
  const world = make_world(home);
  try {
    fn(world);
  } finally {
    close_world(world);
    home.cleanup();
  }
}

function export_a(world: World, name: string): { dir: string; manifest: Manifest } {
  const dir = join(world.bundles, name);
  const result = export_project(world.src, world.src_objects, world.a.project_id, dir);
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

/** Counts every readFileSync/openSync/createReadStream whose realpath is the outside file. */
function count_outside_reads(outside: string, fn: () => void): number {
  const target = realpathSync(outside);
  const real = fs.realpathSync.native ?? fs.realpathSync;
  let reads = 0;
  const touches = (path: unknown): boolean => {
    if (typeof path === "number") return false;
    try {
      return real(String(path)) === target;
    } catch {
      return false;
    }
  };
  const target_fs = fs as unknown as Record<string, unknown>;
  const names = ["readFileSync", "openSync", "createReadStream"];
  const originals: Record<string, unknown> = {};
  for (const name of names) {
    const original = target_fs[name] as (...args: unknown[]) => unknown;
    originals[name] = original;
    target_fs[name] = (path: unknown, ...rest: unknown[]) => {
      if (touches(path)) reads += 1;
      return original(path, ...rest);
    };
  }
  syncBuiltinESMExports();
  try {
    fn();
  } finally {
    for (const name of names) target_fs[name] = originals[name];
    syncBuiltinESMExports();
  }
  return reads;
}

function write_manifest(dir: string, manifest: Manifest): void {
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

/** Bundle whose manifest lists <prefix>/linked/canary.json, with <bundle>/<prefix>/linked -> outside dir. */
function bundle_with_linked_dir(world: World, prefix: "rows" | "objects"): { dir: string; outside: string } {
  const { dir, manifest } = export_a(world, `linked-${prefix}`);
  const outside_dir = join(world.bundles, `outside-${prefix}`);
  mkdirSync(outside_dir, { recursive: true });
  const outside = join(outside_dir, "canary.json");
  writeFileSync(outside, CANARY);
  mkdirSync(join(dir, prefix), { recursive: true });
  symlinkSync(outside_dir, join(dir, prefix, "linked"), "dir");
  manifest.files.push({ path: `${prefix}/linked/canary.json`, sha256: "0".repeat(64), size: 24 });
  write_manifest(dir, manifest);
  return { dir, outside };
}

function bundle_with_manifest_symlink(world: World): { dir: string; outside: string } {
  const { dir, manifest } = export_a(world, "linked-manifest");
  const outside = join(world.bundles, "outside-manifest.txt");
  writeFileSync(outside, CANARY);
  fs.rmSync(join(dir, "manifest.json"));
  symlinkSync(outside, join(dir, "manifest.json"), "file");
  void manifest;
  return { dir, outside };
}

const UNSAFE_CODES = ["path_unsafe", "manifest_invalid"];

for (const prefix of ["rows", "objects"] as const) {
  test(`verify_bundle: ${prefix}/linked (directory symlink) is path_unsafe, with 0 outside reads and no content leak`, () => {
    with_world((world) => {
      const { dir, outside } = bundle_with_linked_dir(world, prefix);
      let result: ReturnType<typeof verify_bundle> | undefined;
      const reads = count_outside_reads(outside, () => {
        result = verify_bundle(dir);
      });
      assert.ok(result);
      assert.equal(reads, 0, "the file behind the symlinked directory must not be opened or read");
      assert.equal(result.ok, false);
      assert.ok(
        result.problems.some((p) => p.code === "path_unsafe" && p.path === `${prefix}/linked/canary.json`),
        JSON.stringify(result.problems),
      );
      assert.ok(!JSON.stringify(result.problems).includes("SYNTHETIC_"), "no content (not even a prefix) in problems");
    });
  });

  test(`import_bundle: ${prefix}/linked (directory symlink) is refused with 0 outside reads, no leak, target unchanged`, () => {
    with_world((world) => {
      const { dir, outside } = bundle_with_linked_dir(world, prefix);
      const before = target_state(world);
      let error: unknown;
      const reads = count_outside_reads(outside, () => {
        error = error_of(() => import_bundle(world.tgt, world.tgt_objects, dir));
      });
      assert.equal(reads, 0, "the file behind the symlinked directory must not be opened or read");
      assert.ok(error instanceof BackupError, String(error));
      const text = `${error.message} ${JSON.stringify(error.problems)}`;
      assert.ok(!text.includes("SYNTHETIC_"), `error text leaked outside content: ${text}`);
      assert.ok(error.problems.some((p) => p.code === "path_unsafe"), text);
      assert.deepEqual(target_state(world), before);
    });
  });
}

test("verify_bundle: manifest.json symlink is not followed (0 outside reads, no leak, unsafe/invalid code)", () => {
  with_world((world) => {
    const { dir, outside } = bundle_with_manifest_symlink(world);
    let result: ReturnType<typeof verify_bundle> | undefined;
    const reads = count_outside_reads(outside, () => {
      result = verify_bundle(dir);
    });
    assert.ok(result);
    assert.equal(reads, 0, "the symlink target must not be opened or read");
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => UNSAFE_CODES.includes(p.code)), JSON.stringify(result.problems));
    assert.ok(!JSON.stringify(result.problems).includes("SYNTHETIC_"), "no content (not even a prefix) in problems");
  });
});

test("import_bundle: manifest.json symlink is refused with 0 outside reads, no leak, target unchanged", () => {
  with_world((world) => {
    const { dir, outside } = bundle_with_manifest_symlink(world);
    const before = target_state(world);
    let error: unknown;
    const reads = count_outside_reads(outside, () => {
      error = error_of(() => import_bundle(world.tgt, world.tgt_objects, dir));
    });
    assert.equal(reads, 0, "the symlink target must not be opened or read");
    assert.ok(error instanceof BackupError, String(error));
    const text = `${error.message} ${JSON.stringify(error.problems)}`;
    assert.ok(!text.includes("SYNTHETIC_"), `error text leaked outside content: ${text}`);
    assert.ok(error.problems.some((p) => UNSAFE_CODES.includes(p.code)), text);
    assert.deepEqual(target_state(world), before);
  });
});

test("a normal bundle (no symlinks) still verifies and imports", () => {
  with_world((world) => {
    const { dir } = export_a(world, "normal");
    const report = verify_bundle(dir);
    assert.deepEqual(report.problems, []);
    assert.equal(report.ok, true);
    const result = import_bundle(world.tgt, world.tgt_objects, dir);
    assert.ok(result);
  });
});

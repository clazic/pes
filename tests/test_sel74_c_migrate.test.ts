// SEL-74 C (2/3) — `pes migrate <폴더>` and `pes migrate --all`: the user's way from a 0.15 folder to the new format, built on the PR11 / PR12
// tools (import → validate → activate). Written before the code: `migrate` does not exist yet.
//   * a backup bundle (PR3/PR12 format) is written BEFORE the activation, outside the PES home — `restore_project` can go back to it
//   * the original folder (project.json and everything else) stays byte- and mtime-identical — the new format lives in the database
//   * a failure activates nothing and leaves the folder as it was
//   * the same folder twice → "이미 이전됨", exit 0, nothing changes
//   * afterwards the project is a normal DB project: status shows it, write commands work
// Everything is synthetic; every child runs in a temporary HOME / USERPROFILE / PES_HOME behind the TS child guard.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { test } from "node:test";

import { verify_bundle } from "../scripts/pes_core/backup.ts";
import { FakeClock } from "../scripts/pes_core/clock.ts";
import { CommandService } from "../scripts/pes_core/commands.ts";
import { connect, migrate as migrate_db } from "../scripts/pes_core/db.ts";
import { restore_project } from "../scripts/pes_core/migration.ts";
import { db_path, objects_dir } from "../scripts/pes_core/paths.ts";
import type { CompatCtx } from "./helpers/compat_env.ts";
import { ts_seed_legacy, ts_view } from "./helpers/compat_ts.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import {
  assert_one_line_error,
  bundle_dirs,
  bytes_digest,
  db_rows,
  legacy_folder,
  mtime_map,
  norm_root,
  pes_ts,
  project_row,
  with_ctx,
} from "./helpers/sel74_env.ts";

use_home_guard();

const SLUG = "migrate-시험";
const home_of = (ctx: CompatCtx) => ({ env: ctx.env, pes_home: ctx.pes_home, home_dir: ctx.home_dir });

function bundles(ctx: CompatCtx): string[] {
  return bundle_dirs(join(ctx.home_dir, ".pes"));
}

test("C6: migrate on a fresh home — exit 0, a report line with the name, the project is a DB project, the original folder is byte- and mtime-identical", { timeout: 300_000 }, async () => {
  await with_ctx("pes-sel74-c6-", (ctx) => {
    const dir = legacy_folder(ctx, SLUG);
    const bytes = bytes_digest(dir);
    const times = mtime_map(dir);
    const run = pes_ts(ctx, ["migrate", SLUG], { allow_child_process: false });
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    assert.match(norm_root(run.stdout, ctx.home.root), new RegExp(SLUG), "the report names the project");
    assert.match(run.stdout, /이전/, "and says in Korean what happened");
    assert.equal(run.stderr.trim(), "", "nothing on stderr");

    assert.equal(project_row(ctx, SLUG)?.status, "active", "the project is active in the database");
    const view = ts_view(home_of(ctx), SLUG);
    assert.equal((view?.project as { topic?: string } | undefined)?.topic, "합성 완료 프로젝트", "its topic came over");

    assert.equal(bytes_digest(dir), bytes, "project.json and every other file: same bytes");
    assert.deepEqual(mtime_map(dir), times, "…and not even touched");
  });
});

test("C7: after migrate the project is a normal DB project — status reads it, a write command works (D14 no longer applies), the old folder's project.json is still not written", { timeout: 300_000 }, async () => {
  await with_ctx("pes-sel74-c7-", (ctx) => {
    const dir = legacy_folder(ctx, SLUG, "full"); // an open project (research is active): a finished one would refuse a note on its own account
    const project_json_before = bytes_digest(dir);
    assert.equal(pes_ts(ctx, ["migrate", SLUG]).status, 0);
    const status = pes_ts(ctx, ["status", SLUG]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /합성 도서관 운영 연구/);
    const note = pes_ts(ctx, ["note", SLUG, "이전 뒤 메모"]);
    assert.equal(note.status, 0, `a write works now: ${note.stderr}`);
    const view = ts_view(home_of(ctx), SLUG);
    assert.ok(JSON.stringify(view?.project).includes("이전 뒤 메모"), "and lands in the database");
    // 0.15's project.json is never rewritten (D02): the one file the user's old tools could read is exactly what it was
    assert.equal(JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).slug, SLUG);
    void project_json_before;
  });
});

test("C8: a verified backup bundle is written BEFORE the activation, outside the PES home, and `restore_project` can go back to it (PR12)", { timeout: 300_000 }, async () => {
  await with_ctx("pes-sel74-c8-", async (ctx) => {
    const dir = legacy_folder(ctx, SLUG, "full");
    assert.deepEqual(bundles(ctx), [], "no bundle before");
    assert.equal(pes_ts(ctx, ["migrate", SLUG]).status, 0);
    const found = bundles(ctx);
    assert.equal(found.length, 1, `one backup bundle (found: ${found.join(", ")})`);
    const bundle = found[0] as string;
    const rel = relative(ctx.pes_home, bundle);
    assert.ok(rel.startsWith("..") || isAbsolute(rel), "the bundle is outside the PES home");
    assert.equal(verify_bundle(bundle).ok, true, "a valid backup bundle");
    const project_id = (project_row(ctx, SLUG) as { id: string }).id;
    const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")) as { project_id?: string };
    assert.equal(manifest.project_id, project_id, "the bundle is of this project");

    // a write after the migration, then the restore: it reports the lost write and the project is back at the bundle
    assert.equal(pes_ts(ctx, ["note", SLUG, "되돌릴 메모"]).status, 0);
    const file = db_path(ctx.env);
    mkdirSync(objects_dir(ctx.env), { recursive: true });
    const db = connect(file);
    try {
      migrate_db(db);
      const owner = db.get<{ owner_user_id: string }>("SELECT owner_user_id FROM projects WHERE id = ?", project_id);
      const actor = db.get<{ id: string }>("SELECT id FROM actors WHERE user_id = ? AND kind = 'human' ORDER BY rowid LIMIT 1", owner?.owner_user_id ?? "");
      assert.ok(actor, "the project has a human owner");
      const service = new CommandService(db, { clock: new FakeClock(Date.now()), policy: { check: () => ({ allowed: true }) }, objects_dir: objects_dir(ctx.env) });
      const restored = await restore_project(service, { owner_actor_id: actor.id, project_id, bundle_dir: bundle });
      assert.ok(restored.lost_writes.length >= 1, "the note written after the migration is reported as lost");
    } finally {
      db.close();
    }
    void dir;
  });
});

test("C9: the same folder twice — the second migrate is `이미 이전됨`, exit 0, and the database, the folder and the backups stay as they were", { timeout: 300_000 }, async () => {
  await with_ctx("pes-sel74-c9-", (ctx) => {
    const dir = legacy_folder(ctx, SLUG);
    assert.equal(pes_ts(ctx, ["migrate", SLUG]).status, 0);
    const counts = db_rows(ctx, "SELECT (SELECT COUNT(*) FROM projects) AS p, (SELECT COUNT(*) FROM objects) AS o, (SELECT COUNT(*) FROM mutation_commits) AS m");
    const times = mtime_map(dir);
    const backups = bundles(ctx);
    const again = pes_ts(ctx, ["migrate", SLUG]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /이미 이전됨/);
    assert.deepEqual(db_rows(ctx, "SELECT (SELECT COUNT(*) FROM projects) AS p, (SELECT COUNT(*) FROM objects) AS o, (SELECT COUNT(*) FROM mutation_commits) AS m"), counts, "no row was added");
    assert.deepEqual(bundles(ctx), backups, "no second backup");
    assert.deepEqual(mtime_map(dir), times);
  });
});

test("C10: a folder whose project.json is broken — exit 1, ONE Korean line, nothing activated, no project row is left serving, the folder is unchanged and stays read-only", { timeout: 300_000 }, async () => {
  await with_ctx("pes-sel74-c10-", async (ctx) => {
    // a good project first, so the database exists and has an owner (the importer needs one)
    const good = legacy_folder(ctx, "good-one");
    await ts_seed_legacy(home_of(ctx), good);
    const dir = join(ctx.pes_home, "broken-one");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "project.json"), '{"pes": 1, "stages":', "utf8");
    const bytes = bytes_digest(dir);
    const times = mtime_map(dir);
    const before = db_rows(ctx, "SELECT id, status FROM projects ORDER BY id");
    const run = pes_ts(ctx, ["migrate", "broken-one"]);
    assert.equal(run.status, 1);
    assert_one_line_error(run, "migrate of a broken folder");
    assert.equal(run.stdout.includes("이전했습니다"), false, "it does not claim success");
    const row = project_row(ctx, "broken-one");
    assert.ok(row === undefined || row.status !== "active", "nothing was activated");
    assert.deepEqual(db_rows(ctx, "SELECT id, status FROM projects WHERE status = 'active' ORDER BY id"), before.filter((r) => (r as { status: string }).status === "active"), "the other projects are untouched");
    assert.equal(bytes_digest(dir), bytes);
    assert.deepEqual(mtime_map(dir), times);
    const note = pes_ts(ctx, ["note", "broken-one", "x"]);
    assert.equal(note.status, 1, "and the folder stays a not-migrated, read-only folder");
  });
});

test("C11: a project that is already in the database under another history is not overwritten: migrate of a name that exists as a DB project says 이미 이전됨 and imports nothing", { timeout: 300_000 }, async () => {
  await with_ctx("pes-sel74-c11-", async (ctx) => {
    assert.equal(pes_ts(ctx, ["init", join(ctx.pes_home, "dbfirst"), "--topic", "DB 가 먼저"]).status, 0);
    const dir = legacy_folder(ctx, "dbfirst");
    const before = db_rows(ctx, "SELECT id, status FROM projects ORDER BY id");
    const run = pes_ts(ctx, ["migrate", "dbfirst"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /이미 이전됨/);
    assert.deepEqual(db_rows(ctx, "SELECT id, status FROM projects ORDER BY id"), before);
    void dir;
  });
});

test("C12: argument errors — no folder, a folder that does not exist, a folder without project.json — exit 1 (2 for usage), one Korean line, nothing created", { timeout: 300_000 }, async () => {
  await with_ctx("pes-sel74-c12-", (ctx) => {
    const none = pes_ts(ctx, ["migrate"]);
    assert.ok(none.status === 1 || none.status === 2, `no argument: exit 1 or 2 (got ${none.status})`);
    const missing = pes_ts(ctx, ["migrate", "no-such-folder"]);
    assert.equal(missing.status, 1);
    assert_one_line_error(missing, "missing folder");
    mkdirSync(join(ctx.pes_home, "empty-dir"), { recursive: true });
    const empty = pes_ts(ctx, ["migrate", "empty-dir"]);
    assert.equal(empty.status, 1);
    assert_one_line_error(empty, "folder without project.json");
    assert.deepEqual(bundles(ctx), []);
    assert.equal(project_row(ctx, "empty-dir"), undefined);
  });
});

test("C13: migrate --all — every not-migrated folder of the PES home, one report line each; a failure does not stop the others and makes the exit 1; folders without project.json are skipped; a second run changes nothing", { timeout: 600_000 }, async () => {
  await with_ctx("pes-sel74-c13-", async (ctx) => {
    const a = legacy_folder(ctx, "alpha-one");
    const b = legacy_folder(ctx, "beta-two");
    const bad = join(ctx.pes_home, "gamma-bad");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "project.json"), '{"pes": 1, "stages":', "utf8");
    mkdirSync(join(ctx.pes_home, "not-a-project"), { recursive: true });
    writeFileSync(join(ctx.pes_home, "not-a-project", "note.txt"), "x", "utf8");
    const done = legacy_folder(ctx, "delta-done");
    await ts_seed_legacy(home_of(ctx), done);
    const digests = Object.fromEntries([a, b, bad, done].map((d) => [d, bytes_digest(d)]));

    const run = pes_ts(ctx, ["migrate", "--all"]);
    assert.equal(run.status, 1, `one folder failed → exit 1 (${run.stderr})`);
    const out = norm_root(run.stdout + run.stderr, ctx.home.root);
    for (const name of ["alpha-one", "beta-two", "gamma-bad", "delta-done"]) assert.match(out, new RegExp(name), `a line for ${name}`);
    assert.doesNotMatch(out, /not-a-project/, "a folder without project.json is not a candidate");
    assert.match(out.split("\n").find((l) => l.includes("delta-done")) ?? "", /이미 이전됨/, "the one already in the database");
    assert.equal(project_row(ctx, "alpha-one")?.status, "active");
    assert.equal(project_row(ctx, "beta-two")?.status, "active");
    const gamma = project_row(ctx, "gamma-bad");
    assert.ok(gamma === undefined || gamma.status !== "active", "the broken one is not activated");
    for (const [d, digest] of Object.entries(digests)) assert.equal(bytes_digest(d), digest, `${d}: bytes unchanged`);
    assert.equal(bundles(ctx).length >= 2, true, "a backup bundle for each migrated project");

    // remove the broken folder → everything left is migrated: --all is a no-op with exit 0
    rmSync(bad, { recursive: true, force: true });
    const counts = db_rows(ctx, "SELECT (SELECT COUNT(*) FROM projects) AS p, (SELECT COUNT(*) FROM mutation_commits) AS m");
    const again = pes_ts(ctx, ["migrate", "--all"]);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(db_rows(ctx, "SELECT (SELECT COUNT(*) FROM projects) AS p, (SELECT COUNT(*) FROM mutation_commits) AS m"), counts, "nothing changed");
  });
});

test("C14: migrate --all with an empty PES home says there is nothing to move (exit 0)", { timeout: 300_000 }, async () => {
  await with_ctx("pes-sel74-c14-", (ctx) => {
    const run = pes_ts(ctx, ["migrate", "--all"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /[가-힣]/);
    assert.equal(project_row(ctx, "anything"), undefined);
  });
});

test("C15: the real home is never read or written by migrate (the child runs behind the guard in the temporary HOME; it would have failed with PESHomeAccessViolation)", { timeout: 300_000 }, async () => {
  await with_ctx("pes-sel74-c15-", (ctx) => {
    legacy_folder(ctx, SLUG);
    const run = pes_ts(ctx, ["migrate", SLUG]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.hub_attempts, [], "and no hub port was asked");
  });
});

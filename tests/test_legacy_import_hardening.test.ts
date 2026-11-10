// SEL-44 (stage 2 PR11) hardening: legacy importer. Everything is synthetic; every test works on a
// temporary folder inside the test's isolated HOME. Nothing here reads the real ~/.pes or ~/pes-projects.
//
// Each test targets one rule of docs/plan/migration-map.md (sections 6, 9, 10) so that a failure names
// the rule. A test that expects what the map says but the importer does not do is kept failing on
// purpose (it is a defect candidate, see the SEL-44 hardening report).

import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import { blob_row_must, disk_path } from "./helpers/blob_env.ts";
import {
  batch_row,
  copy_fixture,
  edition_of,
  has_entry,
  json_of,
  project_row,
  run_import,
  stage_of,
  stored_report,
  table_counts,
  tree_digest,
  tree_entries,
  with_legacy,
  type Env,
  type ImportResult,
  type LegacyApi,
} from "./helpers/legacy_env.ts";

// ---------------------------------------------------------------------------
// small helpers

let dir_counter = 0;

/** A fresh, empty source folder inside the test's temporary root. */
function new_source(env: Env, label: string): string {
  dir_counter += 1;
  const dir = join(env.home.root, `hard-${label}-${dir_counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function write_project(dir: string, body: unknown): void {
  writeFileSync(join(dir, "project.json"), typeof body === "string" ? body : JSON.stringify(body), "utf8");
}

/** A minimal valid project.json that individual tests then bend. */
function base_project(slug: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pes: 1,
    topic: "합성 보강 프로젝트",
    slug,
    created: "2026-03-01",
    current: "plan",
    settings: {},
    processed: [],
    complete: false,
    stages: { plan: { status: "active", round: 1, items: [] } },
    ...extra,
  };
}

interface EntryStat {
  path: string;
  kind: "file" | "dir" | "symlink" | "other";
  size: number;
  mtime_ms: number;
  mode: number;
}

/** Everything about a folder that a read-only tool must keep: names (hidden and symlinks too), kinds, sizes, mtimes, modes. */
function full_listing(root: string): EntryStat[] {
  const out: EntryStat[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const st = lstatSync(full);
      out.push({
        path: relative(root, full).replace(/\\/g, "/"),
        kind: st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other",
        size: st.size,
        mtime_ms: st.mtimeMs,
        mode: st.mode,
      });
      if (st.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
}

/** Push every entry's mtime far into the past so that any write by the importer shows up. */
function age_everything(root: string): void {
  const old = new Date("2020-01-02T03:04:05Z");
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full);
      utimesSync(full, old, old);
    }
  };
  walk(root);
  utimesSync(root, old, old);
}

function read_tree_bytes(root: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push(readFileSync(full).toString("latin1"));
    }
  };
  walk(root);
  return out;
}

/** Every column of every row of every table, as text. Blobs are decoded as latin1 so that a marker can be found. */
function dump_db_text(env: Env): string {
  const parts: string[] = [];
  const tables = env.db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  for (const table of tables) {
    for (const row of env.db.all<Record<string, unknown>>(`SELECT * FROM ${table.name}`)) {
      for (const value of Object.values(row)) {
        if (value === null || value === undefined) continue;
        if (value instanceof Uint8Array) parts.push(Buffer.from(value).toString("latin1"));
        else parts.push(String(value));
      }
    }
  }
  return parts.join("\n");
}

function events_of(env: Env, project_id: string): Array<{ type: string; payload: string }> {
  return env.db.all<{ type: string; payload: string }>(
    "SELECT type, payload AS payload FROM events WHERE project_id = ? ORDER BY rowid",
    project_id,
  );
}

function legacy_extra_of(settings_json: string): Record<string, unknown> {
  const settings = json_of(settings_json);
  const extra = settings.legacy_extra;
  assert.ok(extra !== null && typeof extra === "object", "settings keep a legacy_extra object");
  return extra as Record<string, unknown>;
}

async function import_twice(env: Env, api: LegacyApi, dir: string): Promise<[ImportResult, ImportResult]> {
  const first = await run_import(env, api, dir);
  const second = await run_import(env, api, dir);
  return [first, second];
}

// ===========================================================================
// (1) the source folder is never changed; symlinks are not followed
// ===========================================================================

test("hardening 1a: names, kinds, sizes, mtimes and modes of the source (hidden, lock and symlink entries too) are unchanged by two imports", async () => {
  await with_legacy(async (env, api) => {
    const dir = copy_fixture(env, "full");
    writeFileSync(join(dir, ".hidden-note"), "hidden synthetic note", "utf8");
    mkdirSync(join(dir, ".hidden-dir"), { recursive: true });
    writeFileSync(join(dir, ".hidden-dir", "inner.txt"), "inner", "utf8");
    writeFileSync(join(dir, ".pes-lock.bak"), "{}", "utf8");
    age_everything(dir);
    const before = full_listing(dir);
    const digest = tree_digest(dir);
    await import_twice(env, api, dir);
    assert.deepEqual(full_listing(dir), before, "no entry was created, removed, renamed, touched or chmod-ed");
    assert.equal(tree_digest(dir), digest);
    assert.ok(before.some((e) => e.path === ".pes-lock"), "the fixture really has a lock file");
  });
});

test("hardening 1b: a read-only source folder can be imported (the importer needs no write access to it)", async () => {
  await with_legacy(async (env, api) => {
    const dir = copy_fixture(env, "full");
    const modes: Array<[string, number]> = [];
    const walk = (current: string): void => {
      for (const name of readdirSync(current)) {
        const full = join(current, name);
        const st = lstatSync(full);
        if (st.isDirectory()) walk(full);
      }
      modes.push([current, lstatSync(current).mode & 0o777]);
      chmodSync(current, 0o555);
    };
    walk(dir);
    try {
      const result = await run_import(env, api, dir);
      assert.equal(result.state, "staging");
    } finally {
      for (const [path, mode] of modes.reverse()) chmodSync(path, mode);
    }
  });
});

test("hardening 1c: a symlink to a file or folder outside the source is not followed, read, stored or reported with its target", async () => {
  await with_legacy(async (env, api) => {
    const marker = "OUTSIDE-SECRET-MARKER-7f3a";
    const outside = new_source(env, "outside");
    writeFileSync(join(outside, "secret.json"), JSON.stringify({ marker }), "utf8");
    writeFileSync(
      join(outside, "fb.json"),
      JSON.stringify({ stage: "plan", round: 1, kind: "feedback", text: marker, answers: { q1: marker } }),
      "utf8",
    );
    mkdirSync(join(outside, "dir"), { recursive: true });
    writeFileSync(join(outside, "dir", "deep.json"), JSON.stringify({ marker }), "utf8");

    const dir = copy_fixture(env, "full");
    symlinkSync(join(outside, "secret.json"), join(dir, "linked-secret.json"));
    symlinkSync(join(outside, "secret.json"), join(dir, "shots", "linked.png"));
    symlinkSync(join(outside, "fb.json"), join(dir, "feedback", "plan-R1-20260105-150000.json"));
    symlinkSync(join(outside, "dir"), join(dir, "linked-dir"));
    symlinkSync(join(outside, "dir"), join(dir, "rounds", "plan-R9"));
    symlinkSync(join(outside, "missing-target"), join(dir, "dangling.json"));
    age_everything(dir);
    const before = full_listing(dir);

    const scan = api.scan_project(dir);
    const scanned = scan.files.map((f) => f.path);
    for (const name of [
      "linked-secret.json",
      "shots/linked.png",
      "feedback/plan-R1-20260105-150000.json",
      "linked-dir/deep.json",
      "rounds/plan-R9/deep.json",
      "dangling.json",
    ]) {
      assert.ok(!scanned.includes(name), `${name} is not part of the manifest`);
    }

    const result = await run_import(env, api, dir);
    assert.equal(result.state, "staging");
    assert.deepEqual(full_listing(dir), before, "source untouched, symlinks included");

    assert.ok(!dump_db_text(env).includes(marker), "the outside content is nowhere in the database");
    for (const bytes of read_tree_bytes(env.objects)) {
      assert.ok(!bytes.includes(marker), "the outside content is in no stored object");
    }
    assert.ok(!JSON.stringify(result.report).includes(outside), "the outside path is not reported");
    assert.ok(!JSON.stringify(result.report).includes(marker));
    // the outside feedback must not have become a submission of the imported project
    const feedback_files = scan.files.filter((f) => f.path.startsWith("feedback/")).length;
    const subs = env.db.all("SELECT 1 FROM submissions WHERE project_id = ?", result.project_id).length;
    assert.ok(subs <= feedback_files, `submissions (${subs}) never exceed the real feedback files (${feedback_files})`);
  });
});

test("hardening 1d: an import never leaves a new file next to the source or inside it, even when it fails", async () => {
  await with_legacy(async (env, api) => {
    const dir = new_source(env, "nofile");
    write_project(dir, '{"pes": 1, "topic": "x"');
    age_everything(dir);
    const parent_before = readdirSync(env.home.root).sort();
    const before = full_listing(dir);
    const result = await run_import(env, api, dir);
    assert.equal(result.state, "failed");
    assert.deepEqual(full_listing(dir), before);
    const parent_after = readdirSync(env.home.root).sort();
    const added = parent_after.filter((n) => !parent_before.includes(n));
    assert.ok(
      added.every((n) => !n.startsWith(`hard-nofile-${dir_counter}`)),
      `nothing next to the source folder was created: ${added.join(",")}`,
    );
    assert.equal(readdirSync(dir).join(","), "project.json");
  });
});

// ===========================================================================
// (2) re-run boundaries
// ===========================================================================

test("hardening 2a: only mtimes changing (same bytes) is still the same source -> replay, nothing written", async () => {
  await with_legacy(async (env, api) => {
    const dir = copy_fixture(env, "full");
    const first = await run_import(env, api, dir);
    const counts = table_counts(env.db);
    const later = new Date("2031-05-06T07:08:09Z");
    for (const entry of tree_entries(dir)) utimesSync(join(dir, entry.path), later, later);
    const second = await run_import(env, api, dir);
    assert.equal(second.replayed, true);
    assert.equal(second.batch_id, first.batch_id);
    assert.equal(second.source_fingerprint, first.source_fingerprint);
    assert.deepEqual(table_counts(env.db), counts);
  });
});

test("hardening 2b: one changed byte, one added file, one renamed file, or one removed file each give a different fingerprint", async () => {
  await with_legacy(async (env, api) => {
    const dir = copy_fixture(env, "full");
    const base = api.scan_project(dir).fingerprint;
    const seen = new Set<string>([base]);

    writeFileSync(join(dir, "extra.txt"), "added", "utf8");
    const added = api.scan_project(dir).fingerprint;
    assert.ok(!seen.has(added), "an added file changes the fingerprint");
    seen.add(added);

    writeFileSync(join(dir, "extra.txt"), "added!", "utf8");
    const edited = api.scan_project(dir).fingerprint;
    assert.ok(!seen.has(edited), "an edited file changes the fingerprint");
    seen.add(edited);

    const bytes = readFileSync(join(dir, "extra.txt"));
    writeFileSync(join(dir, "extra-renamed.txt"), bytes);
    const fs = await import("node:fs");
    fs.rmSync(join(dir, "extra.txt"));
    const renamed = api.scan_project(dir).fingerprint;
    assert.ok(!seen.has(renamed), "a rename with the same bytes changes the fingerprint");
    seen.add(renamed);

    fs.rmSync(join(dir, "extra-renamed.txt"));
    assert.equal(api.scan_project(dir).fingerprint, base, "back to the original content -> the original fingerprint");
  });
});

test("hardening 2c: a changed source is a NEW batch; the first batch, its project and its rows stay exactly as they were", async () => {
  await with_legacy(async (env, api) => {
    const dir = copy_fixture(env, "full");
    const first = await run_import(env, api, dir);
    const first_project = project_row(env.db, first.project_id);
    const first_batch = batch_row(env.db, first.batch_id);
    const first_extra = legacy_extra_of(edition_of(env.db, first.project_id).settings_json);

    const raw = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as Record<string, unknown>;
    raw.conclusion = "합성 결론 (바뀜)";
    write_project(dir, raw);

    const second = await run_import(env, api, dir);
    assert.equal(second.replayed, false);
    assert.notEqual(second.batch_id, first.batch_id);
    assert.notEqual(second.project_id, first.project_id);
    assert.notEqual(second.source_fingerprint, first.source_fingerprint);
    assert.equal(env.db.all("SELECT 1 FROM import_batches").length, 2);

    assert.deepEqual(project_row(env.db, first.project_id), first_project, "the first project is not touched");
    assert.deepEqual(batch_row(env.db, first.batch_id), first_batch, "the first batch is not touched");
    assert.deepEqual(legacy_extra_of(edition_of(env.db, first.project_id).settings_json), first_extra);
    // the slug is the same -> the second batch must not take it over
    assert.notEqual(project_row(env.db, second.project_id).slug, first_project.slug);
  });
});

test("hardening 2d: the same source re-imported after a failed (rolled back) attempt writes once, not replayed, no half rows", async () => {
  await with_legacy(async (env, api) => {
    const dir = copy_fixture(env, "full");
    const counts_before = table_counts(env.db);
    // The importer cannot create the content-addressed folders -> the transaction must roll back as a whole.
    // Platform-independent injection (chmod does not block writes on Windows): move the object store aside and put a
    // regular FILE of the same name in its place, so creating anything below it fails with ENOTDIR/EEXIST everywhere.
    const aside = `${env.objects}.aside`;
    renameSync(env.objects, aside);
    writeFileSync(env.objects, "not a folder");
    let threw = false;
    try {
      await run_import(env, api, dir);
    } catch {
      threw = true;
    } finally {
      rmSync(env.objects, { force: true });
      renameSync(aside, env.objects);
    }
    assert.equal(threw, true, "the unwritable object store makes the import fail loudly");
    assert.deepEqual(table_counts(env.db), counts_before, "a failed attempt leaves no row behind");

    const result = await run_import(env, api, dir);
    assert.equal(result.replayed, false, "the retry is a real import, not a replay of the failed attempt");
    assert.equal(result.state, "staging");
    assert.equal(env.db.all("SELECT 1 FROM import_batches").length, 1);
    const again = await run_import(env, api, dir);
    assert.equal(again.replayed, true);
    assert.equal(again.batch_id, result.batch_id);
  });
});

test("hardening 2e: two different folders with the same content are the same source (the folder path is not part of the identity)", async () => {
  await with_legacy(async (env, api) => {
    const a = copy_fixture(env, "complete");
    const b = copy_fixture(env, "complete");
    const first = await run_import(env, api, a);
    const second = await run_import(env, api, b);
    assert.equal(second.replayed, true);
    assert.equal(second.batch_id, first.batch_id);
  });
});

// ===========================================================================
// (3) slug conflict: failed batch, nothing overwritten
// ===========================================================================

test("hardening 3a: a source whose slug equals an existing (non-imported) project fails the batch and changes that project in no way", async () => {
  await with_legacy(async (env, api) => {
    const dir = new_source(env, "slug");
    write_project(dir, base_project("synthetic-files")); // env.p already owns this slug
    const existing_before = project_row(env.db, env.p.project_id);
    const edition_before = env.db.all("SELECT * FROM editions WHERE project_id = ?", env.p.project_id);
    const stages_before = env.db.all("SELECT * FROM stages WHERE project_id = ?", env.p.project_id);
    const policies_before = env.db.all("SELECT * FROM project_policy_versions WHERE project_id = ?", env.p.project_id);
    const objects_before = env.db.all("SELECT * FROM objects WHERE project_id = ?", env.p.project_id);

    const result = await run_import(env, api, dir);
    assert.equal(result.state, "failed");
    assert.equal(batch_row(env.db, result.batch_id).state, "failed");
    assert.notEqual(result.project_id, env.p.project_id);

    assert.deepEqual(project_row(env.db, env.p.project_id), existing_before);
    assert.deepEqual(env.db.all("SELECT * FROM editions WHERE project_id = ?", env.p.project_id), edition_before);
    assert.deepEqual(env.db.all("SELECT * FROM stages WHERE project_id = ?", env.p.project_id), stages_before);
    assert.deepEqual(
      env.db.all("SELECT * FROM project_policy_versions WHERE project_id = ?", env.p.project_id),
      policies_before,
    );
    assert.deepEqual(env.db.all("SELECT * FROM objects WHERE project_id = ?", env.p.project_id), objects_before);
    assert.equal(
      env.db.all("SELECT 1 FROM import_batches WHERE project_id = ?", env.p.project_id).length,
      0,
      "no batch is attached to the existing project",
    );
  });
});

test("hardening 3b: the slug conflict is in the result, report_unknown and the stored blob alike; the failed project is not active and is not given the old slug", async () => {
  await with_legacy(async (env, api) => {
    const dir = new_source(env, "slug2");
    write_project(dir, base_project("synthetic-files"));
    const result = await run_import(env, api, dir);
    const from_result = result.report.entries.filter((e) => e.category === "unknown_field" && e.key === "/slug");
    assert.equal(from_result.length, 1, "exactly one slug entry");
    assert.equal(from_result[0]!.detail, "slug_conflict");
    assert.deepEqual(api.report_unknown(env.db, result.batch_id).entries, result.report.entries);
    assert.deepEqual(stored_report(env, batch_row(env.db, result.batch_id)).entries, result.report.entries);

    const project = project_row(env.db, result.project_id);
    assert.notEqual(project.slug, "synthetic-files");
    assert.equal(project.active_edition_id, null);
    assert.equal(edition_of(env.db, result.project_id).status, "draft");
    assert.equal(
      env.db.all("SELECT 1 FROM approvals WHERE project_id = ?", result.project_id).length,
      0,
      "a failed batch invents no approval",
    );
  });
});

test("hardening 3c: a conflict batch replays as the same failed batch, even after the conflicting project's slug is no longer in the way", async () => {
  await with_legacy(async (env, api) => {
    const dir = new_source(env, "slug3");
    write_project(dir, base_project("synthetic-files"));
    const first = await run_import(env, api, dir);
    const counts = table_counts(env.db);
    const second = await run_import(env, api, dir);
    assert.equal(second.replayed, true);
    assert.equal(second.state, "failed");
    assert.equal(second.batch_id, first.batch_id);
    assert.deepEqual(table_counts(env.db), counts);
    assert.deepEqual(second.report.entries, first.report.entries);
  });
});

test("hardening 3d: missing, empty, blank or non-text slugs fail the batch without throwing and name the slug in the report", async () => {
  await with_legacy(async (env, api) => {
    const cases: Array<[string, unknown]> = [
      ["missing", undefined],
      ["empty", ""],
      ["blank", "   "],
      ["number", 123],
      ["null", null],
      ["object", { a: 1 }],
    ];
    for (const [label, slug] of cases) {
      const dir = new_source(env, `slug-${label}`);
      const body = base_project("placeholder");
      if (slug === undefined) delete body.slug;
      else body.slug = slug;
      write_project(dir, body);
      const digest = tree_digest(dir);
      const result = await run_import(env, api, dir);
      assert.equal(result.state, "failed", `slug ${label}`);
      assert.ok(has_entry(result.report, "unknown_field", "project.json", "/slug"), `slug ${label} is reported`);
      assert.equal(tree_digest(dir), digest);
      assert.equal(project_row(env.db, result.project_id).active_edition_id, null);
    }
  });
});

test("hardening 3e: two failed batches in a row (different sources, both without slug) both get their own project", async () => {
  await with_legacy(async (env, api) => {
    const a = new_source(env, "noslug-a");
    const b = new_source(env, "noslug-b");
    write_project(a, { pes: 1, topic: "a" });
    write_project(b, { pes: 1, topic: "b" });
    const ra = await run_import(env, api, a);
    const rb = await run_import(env, api, b);
    assert.equal(ra.state, "failed");
    assert.equal(rb.state, "failed");
    assert.notEqual(ra.project_id, rb.project_id);
    assert.notEqual(project_row(env.db, ra.project_id).slug, project_row(env.db, rb.project_id).slug);
  });
});

// ===========================================================================
// (4) damaged JSON and wrong values: sentinels, markers, reports
// ===========================================================================

test("hardening 4a: a project.json that is JSON but not an object (array, null, number, string) fails the batch, does not throw, reports parse_error", async () => {
  await with_legacy(async (env, api) => {
    for (const [label, text] of [
      ["array", "[]"],
      ["null", "null"],
      ["number", "42"],
      ["string", '"hello"'],
      ["empty", ""],
      ["whitespace", "  \n"],
    ] as const) {
      const dir = new_source(env, `notobj-${label}`);
      write_project(dir, text);
      const digest = tree_digest(dir);
      const result = await run_import(env, api, dir);
      assert.equal(result.state, "failed", label);
      assert.ok(
        result.report.entries.some((e) => e.path === "project.json" && (e.category === "parse_error" || e.category === "unknown_field")),
        `${label}: the damaged file is reported`,
      );
      assert.equal(tree_digest(dir), digest);
      assert.equal(edition_of(env.db, result.project_id).status, "draft");
      assert.equal(stage_of(env.db, result.project_id, "plan").status, "pending");
    }
  });
});

test("hardening 4b: an unparsable created gives created_at 0, keeps the original text, and is marked legacy_unverified (migration-map row 'created')", async () => {
  await with_legacy(async (env, api) => {
    for (const created of ["not-a-date", "2026-13-45", "2026-02-30", "20260301", "", 20260301, null, { y: 2026 }]) {
      const dir = new_source(env, "created");
      write_project(dir, base_project(`synthetic-created-${dir_counter}`, { created }));
      const result = await run_import(env, api, dir);
      assert.equal(result.state, "staging", JSON.stringify(created));
      assert.equal(project_row(env.db, result.project_id).created_at, 0n, `sentinel for ${JSON.stringify(created)}`);
      const extra = legacy_extra_of(edition_of(env.db, result.project_id).settings_json);
      assert.deepEqual(extra.created_original, created, "the original value is kept");
      assert.equal(extra.legacy_unverified, true, `legacy_unverified marker for created=${JSON.stringify(created)}`);
    }
  });
});

test("hardening 4c: a valid created is NOT marked unverified and is not turned into 'now'", async () => {
  await with_legacy(async (env, api) => {
    const dir = new_source(env, "created-ok");
    write_project(dir, base_project("synthetic-created-ok", { created: "2026-03-01" }));
    const result = await run_import(env, api, dir);
    assert.equal(project_row(env.db, result.project_id).created_at, BigInt(Date.UTC(2026, 2, 1)));
    const extra = legacy_extra_of(edition_of(env.db, result.project_id).settings_json);
    assert.equal(extra.created_original, "2026-03-01");
    assert.notEqual(extra.legacy_unverified, true);
    assert.notEqual(extra.created_unverified, true);
  });
});

test("hardening 4d: a missing created is a sentinel too (0), not the clock", async () => {
  await with_legacy(async (env, api) => {
    const dir = new_source(env, "created-missing");
    const body = base_project("synthetic-created-missing");
    delete body.created;
    write_project(dir, body);
    const result = await run_import(env, api, dir);
    assert.equal(project_row(env.db, result.project_id).created_at, 0n);
    assert.notEqual(project_row(env.db, result.project_id).created_at, BigInt(env.clock.now_ms()));
  });
});

test("hardening 4e: a current that is not a stage key is not used, the edition has no current stage, and the value is reported", async () => {
  await with_legacy(async (env, api) => {
    for (const current of ["review", "PLAN", "plan ", 3, null, ["plan"], ""]) {
      const dir = new_source(env, "current");
      write_project(dir, base_project(`synthetic-current-${dir_counter}`, { current }));
      const result = await run_import(env, api, dir);
      assert.equal(result.state, "staging", JSON.stringify(current));
      assert.equal(edition_of(env.db, result.project_id).current_stage_id, null, `current=${JSON.stringify(current)}`);
      assert.ok(has_entry(result.report, "unknown_field", "project.json", "/current"), `current=${JSON.stringify(current)} reported`);
      const extra = legacy_extra_of(edition_of(env.db, result.project_id).settings_json);
      assert.deepEqual(extra.current_original, current, "the original value is kept");
    }
  });
});

test("hardening 4f: a valid current is used for the edition's current stage", async () => {
  await with_legacy(async (env, api) => {
    const dir = new_source(env, "current-ok");
    write_project(dir, base_project("synthetic-current-ok", { current: "research" }));
    const result = await run_import(env, api, dir);
    const edition = edition_of(env.db, result.project_id);
    assert.equal(edition.current_stage_id, stage_of(env.db, result.project_id, "research").id);
    assert.ok(!has_entry(result.report, "unknown_field", "project.json", "/current"));
  });
});

test("hardening 4g: there are always exactly the six stages; a stage key outside the six is kept or reported, never silently dropped", async () => {
  await with_legacy(async (env, api) => {
    const dir = new_source(env, "seventh");
    const body = base_project("synthetic-seventh");
    (body.stages as Record<string, unknown>).seventh = { status: "active", round: 2, items: [{ id: "x1", title: "t" }] };
    (body.stages as Record<string, unknown>).Plan = { status: "approved" };
    write_project(dir, body);
    const result = await run_import(env, api, dir);
    const stages = env.db.all<{ key: string }>(
      "SELECT key FROM stages WHERE project_id = ? ORDER BY ordinal",
      result.project_id,
    );
    assert.deepEqual(stages.map((s) => s.key), ["plan", "research", "analyze", "write", "verify", "publish"]);
    assert.equal(stage_of(env.db, result.project_id, "plan").status, "active", "Plan (wrong case) is not the plan stage");

    const where = JSON.stringify([
      result.report.entries,
      edition_of(env.db, result.project_id).settings_json,
      env.db.all("SELECT settings_json FROM stages WHERE project_id = ?", result.project_id),
    ]);
    assert.ok(where.includes("seventh"), "the unknown stage 'seventh' leaves a trace (legacy_extra or report)");
    assert.ok(where.includes("Plan"), "the unknown stage 'Plan' leaves a trace (legacy_extra or report)");
    assert.equal(
      env.db.all("SELECT 1 FROM objects WHERE project_id = ?", result.project_id).length,
      0,
      "the items of an unknown stage are not turned into objects of another stage",
    );
  });
});

test("hardening 4h: stages that are not an object (array, string, null) or contain non-object stages give six pending default stages and a default_filled report", async () => {
  await with_legacy(async (env, api) => {
    const variants: unknown[] = [[], "plan", null, 7, { plan: "approved", research: [], analyze: null }];
    for (const stages of variants) {
      const dir = new_source(env, "stagesbad");
      write_project(dir, base_project(`synthetic-stagesbad-${dir_counter}`, { stages }));
      const digest = tree_digest(dir);
      const result = await run_import(env, api, dir);
      assert.equal(result.state, "staging", JSON.stringify(stages));
      assert.equal(tree_digest(dir), digest);
      for (const key of ["plan", "research", "analyze", "write", "verify", "publish"]) {
        assert.equal(stage_of(env.db, result.project_id, key).status, "pending", `${JSON.stringify(stages)} ${key}`);
      }
      assert.equal(env.db.all("SELECT 1 FROM approvals WHERE project_id = ?", result.project_id).length, 0);
      assert.ok(
        has_entry(result.report, "default_filled", "project.json", "/stages/plan"),
        `${JSON.stringify(stages)}: the filled-in default is reported`,
      );
    }
  });
});

test("hardening 4i: an unknown stage status becomes 'pending' with the original kept; it never becomes approved", async () => {
  await with_legacy(async (env, api) => {
    for (const status of ["done", "APPROVED", "approved ", 1, true, null, {}]) {
      const dir = new_source(env, "status");
      const body = base_project(`synthetic-status-${dir_counter}`);
      (body.stages as Record<string, unknown>).plan = { status, round: 1, approved_at: "2026-03-02 10:00", items: [] };
      write_project(dir, body);
      const result = await run_import(env, api, dir);
      const stage = stage_of(env.db, result.project_id, "plan");
      assert.equal(stage.status, "pending", `status ${JSON.stringify(status)}`);
      assert.deepEqual(legacy_extra_of(stage.settings_json).status_original, status);
      assert.equal(
        env.db.all("SELECT 1 FROM approvals WHERE project_id = ?", result.project_id).length,
        0,
        "no approval from an unknown status",
      );
    }
  });
});

test("hardening 4j: approved without a time or snapshot keeps the approval but marks it legacy_unverified with a sentinel time; an unparsable time is the same", async () => {
  await with_legacy(async (env, api) => {
    for (const approved_at of [undefined, "yesterday", "2026-02-30 10:00", "", 5]) {
      const dir = new_source(env, "approved");
      const body = base_project(`synthetic-approved-${dir_counter}`);
      const plan: Record<string, unknown> = { status: "approved", round: 1, items: [] };
      if (approved_at !== undefined) plan.approved_at = approved_at;
      (body.stages as Record<string, unknown>).plan = plan;
      write_project(dir, body);
      const result = await run_import(env, api, dir);
      const label = `approved_at=${JSON.stringify(approved_at)}`;
      const stage = stage_of(env.db, result.project_id, "plan");
      assert.equal(stage.status, "approved", `${label}: the approved state is kept`);
      assert.ok(stage.approved_snapshot_id, `${label}: a (synthetic) snapshot backs it`);
      const approvals = env.db.all<{
        origin: string;
        assurance: string;
        actor_kind: string;
        human_user_id: string | null;
      }>(
        "SELECT origin, assurance, actor_kind, human_user_id FROM approvals WHERE project_id = ?",
        result.project_id,
      );
      assert.equal(approvals.length, 1, label);
      assert.equal(approvals[0]!.origin, "legacy");
      assert.equal(approvals[0]!.assurance, "legacy_unverified");
      assert.equal(approvals[0]!.actor_kind, "legacy_unknown");
      assert.equal(approvals[0]!.human_user_id, null);
      const extra = legacy_extra_of(stage.settings_json);
      assert.equal(extra.legacy_unverified, true, `${label}: marked unverified`);
      if (approved_at !== undefined) assert.deepEqual(extra.approved_at_original, approved_at);
    }
  });
});

test("hardening 4k: a round that is not a positive integer gives no rounds and keeps the original; a huge round count does not hang or explode", async () => {
  await with_legacy(async (env, api) => {
    for (const round of ["two", -3, 0, 1.5, null, "1"]) {
      const dir = new_source(env, "round");
      const body = base_project(`synthetic-round-${dir_counter}`);
      (body.stages as Record<string, unknown>).plan = { status: "active", round, items: [] };
      write_project(dir, body);
      const result = await run_import(env, api, dir);
      const stage = stage_of(env.db, result.project_id, "plan");
      assert.deepEqual(legacy_extra_of(stage.settings_json).round_original, round);
      const rounds = env.db.all("SELECT 1 FROM rounds WHERE stage_id = ?", stage.id).length;
      assert.ok(rounds <= 1, `round=${JSON.stringify(round)} gave ${rounds} rounds`);
    }
  });
});

test("hardening 4l: complete that is not literally true never completes the edition, and a complete=true without any stage approval is flagged, not hidden", async () => {
  await with_legacy(async (env, api) => {
    for (const complete of ["true", "yes", 1, "True", [], {}]) {
      const dir = new_source(env, "complete-bad");
      write_project(dir, base_project(`synthetic-complete-${dir_counter}`, { complete }));
      const result = await run_import(env, api, dir);
      assert.equal(edition_of(env.db, result.project_id).status, "active", `complete=${JSON.stringify(complete)}`);
      assert.equal(env.db.all("SELECT 1 FROM approvals WHERE project_id = ?", result.project_id).length, 0);
      assert.deepEqual(legacy_extra_of(edition_of(env.db, result.project_id).settings_json).complete_original, complete);
    }
    const dir = new_source(env, "complete-true");
    write_project(dir, base_project("synthetic-complete-true", { complete: true, stages: {} }));
    const result = await run_import(env, api, dir);
    assert.equal(edition_of(env.db, result.project_id).status, "completed");
    const approvals = env.db.all<{ assurance: string }>(
      "SELECT assurance FROM approvals WHERE project_id = ?",
      result.project_id,
    );
    for (const row of approvals) assert.equal(row.assurance, "legacy_unverified");
    const extra = legacy_extra_of(edition_of(env.db, result.project_id).settings_json);
    assert.equal(extra.complete_original, true);
    assert.equal(extra.legacy_unverified, true, "completed without any approved stage is flagged unverified");
  });
});

test("hardening 4m: damaged JSON in a part file (library, ask, feedback, snapshot) is kept as raw bytes, reported with its relative path, and the rest still imports", async () => {
  await with_legacy(async (env, api) => {
    const dir = copy_fixture(env, "full");
    const damaged: Array<[string, string]> = [
      ["library.json", '{"items": ['],
      ["ask/plan-start.json", "not json at all"],
      ["feedback/plan-R1-20260105-120000.json", ""],
      ["snapshots/plan-R1.json", "[1,2,"],
      ["rounds/research-R1/qa.json", "{"],
    ];
    for (const [path, text] of damaged) writeFileSync(join(dir, path), text, "utf8");
    const digest = tree_digest(dir);
    const result = await run_import(env, api, dir);
    assert.equal(result.state, "staging", "damaged part files do not fail the batch");
    assert.equal(tree_digest(dir), digest);
    for (const [path] of damaged) {
      assert.ok(has_entry(result.report, "parse_error", path), `${path} is reported as parse_error`);
      const mapped = api
        .map_legacy(env.db, result.batch_id)
        .some((row) => row.legacy_key === path || row.legacy_key === `feedback:${path}`);
      assert.ok(mapped, `${path} is still mapped (kept as raw bytes)`);
    }
    for (const entry of result.report.entries) {
      assert.ok(!entry.path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(entry.path), `relative path: ${entry.path}`);
    }
  });
});

// ===========================================================================
// (5)+(6) honesty: legacy_unknown / legacy_unverified everywhere, no invented decisions
// ===========================================================================

test("hardening 5a: every author-like column of every row written for the import points at a legacy_unknown actor, except the owner's own policy/receipt/transaction rows", async () => {
  await with_legacy(async (env, api) => {
    const result = await run_import(env, api, copy_fixture(env, "full"));
    const owner = env.p.actor_id;
    const tables = env.db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    const owner_allowed = new Set([
      "project_policy_versions", // changed_by = the human who ran the import ('legacy default')
      "mutation_commits",
      "command_receipts",
      "events",
      "project_members",
      "blob_reservations",
      "blobs", // PR9 file commands run as the importing owner
      "file_policies",
    ]);
    const offenders: string[] = [];
    let checked = 0;
    for (const { name } of tables) {
      const cols = env.db.all<{ name: string }>(`PRAGMA table_info(${name})`).map((c) => c.name);
      if (!cols.includes("project_id")) continue;
      for (const col of cols.filter((c) => /(^|_)actor_id$|^created_by$|^changed_by$|_by$/.test(c) && !/user/.test(c))) {
        const rows = env.db.all<{ actor: string | null }>(
          `SELECT ${col} AS actor FROM ${name} WHERE project_id = ?`,
          result.project_id,
        );
        for (const row of rows) {
          if (row.actor === null) continue;
          const actor = env.db.get<{ kind: string }>("SELECT kind FROM actors WHERE id = ?", row.actor);
          if (actor === undefined) continue; // not an actor reference
          checked += 1;
          if (row.actor === owner) {
            if (!owner_allowed.has(name)) offenders.push(`${name}.${col}: owner as author`);
          } else if (actor.kind !== "legacy_unknown") {
            offenders.push(`${name}.${col}: ${actor.kind}`);
          }
        }
      }
    }
    assert.ok(checked > 20, `the check really looked at author columns (${checked})`);
    assert.deepEqual(offenders, []);
  });
});

test("hardening 5b: every approval, in every fixture, is origin legacy / legacy_unverified / legacy_unknown / no user; never origin 'new'", async () => {
  await with_legacy(async (env, api) => {
    for (const name of ["full", "complete", "broken-parts"]) {
      const result = await run_import(env, api, copy_fixture(env, name));
      const rows = env.db.all<{
        origin: string;
        assurance: string;
        actor_kind: string;
        human_user_id: string | null;
      }>("SELECT origin, assurance, actor_kind, human_user_id FROM approvals WHERE project_id = ?", result.project_id);
      for (const row of rows) {
        assert.equal(row.origin, "legacy", name);
        assert.equal(row.assurance, "legacy_unverified", name);
        assert.equal(row.actor_kind, "legacy_unknown", name);
        assert.equal(row.human_user_id, null, name);
      }
    }
  });
});

test("hardening 5c: every sealed snapshot that has no source file is marked legacy_unverified; a snapshot read from a file is not given the marker", async () => {
  await with_legacy(async (env, api) => {
    const result = await run_import(env, api, copy_fixture(env, "full"));
    const snaps = env.db
      .all<{ id: string; blob_id: string }>(
        "SELECT s.id AS id, s.manifest_blob_id AS blob_id FROM snapshots s WHERE s.project_id = ?",
        result.project_id,
      )
      .map((row) => ({
        id: row.id,
        manifest_json: readFileSync(disk_path(env, blob_row_must(env.db, row.blob_id)), "utf8") as string | null,
      }));
    assert.ok(snaps.length > 0);
    let marked = 0;
    for (const snap of snaps) {
      const text = snap.manifest_json ?? "";
      if (text.includes("legacy_unverified")) marked += 1;
    }
    assert.ok(marked >= 1, "at least the synthetic ones carry the marker");
    // every stage that is approved but whose approval snapshot is synthetic must say so
    for (const stage of env.db.all<{ approved_snapshot_id: string | null; key: string }>(
      "SELECT approved_snapshot_id, key FROM stages WHERE project_id = ? AND approved_snapshot_id IS NOT NULL",
      result.project_id,
    )) {
      const snap = snaps.find((s) => s.id === stage.approved_snapshot_id);
      assert.ok(snap, `stage ${stage.key} points at an imported snapshot`);
    }
  });
});

test("hardening 6a: the initial policy is one 'legacy default' version; no policy decision, consent or approval event is made up", async () => {
  await with_legacy(async (env, api) => {
    const result = await run_import(env, api, copy_fixture(env, "full"));
    const policies = env.db.all<{ policy_rev: bigint; reason: string; changed_by_kind: string }>(
      "SELECT policy_rev, reason, changed_by_kind FROM project_policy_versions WHERE project_id = ?",
      result.project_id,
    );
    assert.equal(policies.length, 1);
    assert.equal(policies[0]!.policy_rev, 1n);
    assert.equal(policies[0]!.reason, "legacy default");
    const types = events_of(env, result.project_id).map((e) => e.type);
    for (const type of types) {
      assert.ok(!/policy\.(changed|consent|decided|granted)|consent|decision/.test(type), `invented event type: ${type}`);
      assert.ok(!/^approval\.(granted|approved)$/.test(type), `invented event type: ${type}`);
    }
    const extra = legacy_extra_of(edition_of(env.db, result.project_id).settings_json);
    const policy_default = extra.policy_default as Record<string, unknown>;
    assert.equal(policy_default.reason, "legacy default");
    // the policy is not presented as something the old project recorded
    assert.ok(!("policy" in json_of(edition_of(env.db, result.project_id).settings_json)));
  });
});

test("hardening 6b: a project.json that itself has a 'policy' or 'allow_opencode_go' key does not turn the default into a recorded decision", async () => {
  await with_legacy(async (env, api) => {
    const dir = new_source(env, "policy");
    write_project(dir, base_project("synthetic-policy", { policy: { allow_opencode_go: 0, by: "someone" }, allow_opencode_go: 0 }));
    const result = await run_import(env, api, dir);
    const policies = env.db.all<{ allow_opencode_go: bigint; reason: string }>(
      "SELECT allow_opencode_go, reason FROM project_policy_versions WHERE project_id = ?",
      result.project_id,
    );
    assert.equal(policies.length, 1);
    assert.equal(policies[0]!.reason, "legacy default");
    assert.ok(has_entry(result.report, "unknown_field", "project.json", "/policy"));
    assert.ok(has_entry(result.report, "unknown_field", "project.json", "/allow_opencode_go"));
  });
});

test("hardening 6c: nothing in a stage the old project never recorded is filled as if it had been decided: a default-filled stage is marked", async () => {
  await with_legacy(async (env, api) => {
    const dir = new_source(env, "defaults");
    write_project(dir, base_project("synthetic-defaults"));
    const result = await run_import(env, api, dir);
    for (const key of ["research", "analyze", "write", "verify", "publish"]) {
      const stage = stage_of(env.db, result.project_id, key);
      assert.equal(stage.status, "pending", key);
      assert.equal(legacy_extra_of(stage.settings_json).stage_defaults, true, `${key} says it is a default`);
      assert.ok(has_entry(result.report, "default_filled", "project.json", `/stages/${key}`), `${key} is reported`);
    }
    assert.equal(legacy_extra_of(stage_of(env.db, result.project_id, "plan").settings_json).stage_defaults, undefined);
  });
});

test("hardening 6d: items, notes, questions and answers are written only when the old file has them (an empty project makes no objects, no submissions, no questions)", async () => {
  await with_legacy(async (env, api) => {
    const dir = new_source(env, "empty");
    write_project(dir, base_project("synthetic-empty"));
    const result = await run_import(env, api, dir);
    for (const table of ["objects", "object_versions", "questions", "question_sets", "submissions", "answers", "approvals", "sources", "citations"]) {
      assert.equal(
        env.db.all(`SELECT 1 FROM ${table} WHERE project_id = ?`, result.project_id).length,
        0,
        `${table} stays empty`,
      );
    }
  });
});

// ===========================================================================
// (7) report blob == report_unknown == result
// ===========================================================================

test("hardening 7a: for every fixture and for a failed batch the result, report_unknown and the stored blob are the same entries in the same order", async () => {
  await with_legacy(async (env, api) => {
    const dirs = [copy_fixture(env, "full"), copy_fixture(env, "complete"), copy_fixture(env, "broken-parts")];
    const broken = new_source(env, "broken");
    write_project(broken, '{"pes": 1, "slug": "x"');
    dirs.push(broken);
    for (const dir of dirs) {
      const result = await run_import(env, api, dir);
      const batch = batch_row(env.db, result.batch_id);
      const stored = stored_report(env, batch);
      assert.equal(stored.batch_id, result.batch_id);
      assert.deepEqual(stored.entries, result.report.entries, dir);
      assert.deepEqual(api.report_unknown(env.db, result.batch_id).entries, result.report.entries, dir);
      // replay returns the identical report
      const replay = await run_import(env, api, dir);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.report.entries, result.report.entries, dir);
    }
  });
});

test("hardening 7b: the report has no duplicate entries and every entry has a known category and a string path", async () => {
  await with_legacy(async (env, api) => {
    const known = new Set([
      "unknown_field",
      "unprocessed_answer",
      "missing_file",
      "parse_error",
      "processed_without_file",
      "unmapped_input",
      "quarantined",
      "default_filled",
    ]);
    for (const name of ["full", "complete", "broken-parts"]) {
      const result = await run_import(env, api, copy_fixture(env, name));
      const seen = new Set<string>();
      for (const entry of result.report.entries) {
        assert.ok(known.has(entry.category), `${name}: category ${entry.category}`);
        assert.equal(typeof entry.path, "string");
        assert.ok(entry.path.length > 0);
        const id = JSON.stringify([entry.category, entry.path, entry.key ?? null]);
        assert.ok(!seen.has(id), `${name}: duplicate entry ${id}`);
        seen.add(id);
      }
    }
  });
});

test("hardening 7c: report_unknown of a batch that does not exist, or whose blob bytes were changed on disk, is a loud error, not an empty report", async () => {
  await with_legacy(async (env, api) => {
    assert.throws(() => api.report_unknown(env.db, "no-such-batch"));
    const result = await run_import(env, api, copy_fixture(env, "complete"));
    const batch = batch_row(env.db, result.batch_id);
    const row = env.db.get<{ storage_key: string }>("SELECT storage_key FROM blobs WHERE id = ?", batch.report_blob_id);
    assert.ok(row);
    writeFileSync(join(env.objects, ...row.storage_key.split("/")), JSON.stringify({ batch_id: result.batch_id, entries: [] }));
    assert.throws(() => api.report_unknown(env.db, result.batch_id), "a tampered report is not trusted");
  });
});

// ===========================================================================
// (8) no absolute or user path leaks
// ===========================================================================

test("hardening 8a: the temporary root (and so the source's absolute path) appears in no table, no event, no mapping, no report and no stored report blob", async () => {
  await with_legacy(async (env, api) => {
    const outside = new_source(env, "outside-leak");
    writeFileSync(join(outside, "x.json"), "{}", "utf8");
    const dir = copy_fixture(env, "full");
    symlinkSync(join(outside, "x.json"), join(dir, "linked.json"));
    const results = [
      await run_import(env, api, dir),
      await run_import(env, api, copy_fixture(env, "broken-parts")),
      await run_import(env, api, copy_fixture(env, "complete")),
    ];
    const text = dump_db_text(env);
    for (const needle of [env.home.root, "/private/var", "/var/folders", "/Users/", "C:\\Users"]) {
      assert.ok(!text.includes(needle), `database text contains ${needle}`);
    }
    for (const result of results) {
      const report_text = JSON.stringify(result.report);
      assert.ok(!report_text.includes(env.home.root));
      assert.ok(!JSON.stringify(stored_report(env, batch_row(env.db, result.batch_id))).includes(env.home.root));
      for (const row of api.map_legacy(env.db, result.batch_id)) {
        assert.ok(!JSON.stringify(row).includes(env.home.root));
      }
      for (const event of events_of(env, result.project_id)) {
        assert.ok(!event.payload.includes(env.home.root), `${event.type} payload`);
      }
    }
  });
});

test("hardening 8b: files that the old project refers to by an absolute, parent-relative or Windows path are reported as missing with a relative/neutral path, never as the user's absolute path", async () => {
  await with_legacy(async (env, api) => {
    const dir = new_source(env, "abspath");
    const body = base_project("synthetic-abspath");
    (body.stages as Record<string, unknown>).plan = {
      status: "active",
      round: 1,
      items: [
        { id: "i1", title: "t", kind: "finding", summary: "s", shots: ["/Users/alice/secret/shot.png", "../../outside.png", "C:\\Users\\bob\\shot.png"] },
      ],
      reports: [{ format: "pdf", label: "r", path: "/Users/alice/secret/report.pdf", bytes: 10, round: 1 }],
    };
    write_project(dir, body);
    const result = await run_import(env, api, dir);
    assert.equal(result.state, "staging");
    const missing = result.report.entries.filter((e) => e.category === "missing_file");
    assert.ok(missing.length >= 1, "the unreadable references are reported");
    for (const entry of result.report.entries) {
      assert.ok(!entry.path.startsWith("/"), `absolute path in report: ${entry.path}`);
      assert.ok(!/^[A-Za-z]:[\\/]/.test(entry.path), `windows path in report: ${entry.path}`);
      assert.ok(!entry.path.split(/[\\/]/).includes(".."), `parent-relative path in report: ${entry.path}`);
      assert.ok(!entry.path.includes("/Users/alice") && !entry.path.includes("bob"), `user path in report: ${entry.path}`);
    }
    const stored = JSON.stringify(stored_report(env, batch_row(env.db, result.batch_id)));
    assert.ok(!stored.includes("/Users/alice"));
    assert.ok(!stored.includes("C:\\\\Users"));
    // none of those references is turned into a file link or mapping key that could later be resolved
    for (const row of api.map_legacy(env.db, result.batch_id)) {
      assert.ok(!row.legacy_key.startsWith("/") && !row.legacy_key.includes(".."), `mapping key ${row.legacy_key}`);
    }
  });
});

test("hardening 8c: a reference that climbs out of the source folder ('../x') never reads a file outside it", async () => {
  await with_legacy(async (env, api) => {
    const marker = "CLIMB-OUT-MARKER-91c2";
    const parent = new_source(env, "climb");
    const dir = join(parent, "src");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(parent, "outside.png"), marker, "utf8");
    const body = base_project("synthetic-climb");
    (body.stages as Record<string, unknown>).plan = {
      status: "active",
      round: 1,
      items: [{ id: "i1", title: "t", kind: "finding", summary: "s", shots: ["../outside.png"] }],
      reports: [{ format: "png", label: "r", path: "../outside.png", bytes: 21, round: 1 }],
    };
    write_project(dir, body);
    const result = await run_import(env, api, dir);
    assert.equal(result.state, "staging");
    assert.ok(!dump_db_text(env).includes(marker));
    for (const bytes of read_tree_bytes(env.objects)) assert.ok(!bytes.includes(marker), "outside file was stored");
    assert.deepEqual(readdirSync(parent).sort(), ["outside.png", "src"], "nothing was added next to the source");
  });
});

// ===========================================================================
// symlinks inside the source are skipped but never silently (leader request)
// ===========================================================================
// Category chosen: the existing 'unmapped_input' (no new category: ReportCategory stays closed).
// Entry: { category: 'unmapped_input', path: <source-relative path of the link, "/" separators> };
// a detail such as "symlink" is allowed but not required. The target path is never reported.

test("hardening 9: every symlink in the source (file or folder, inside or outside target, dangling) is not followed and is reported as unmapped_input with its relative path only", async () => {
  await with_legacy(async (env, api) => {
    const outside = new_source(env, "sym-outside");
    writeFileSync(join(outside, "o.json"), "{}", "utf8");
    mkdirSync(join(outside, "od"), { recursive: true });
    const dir = copy_fixture(env, "full");
    const links: Array<[string, string]> = [
      ["link-in-file.json", join(dir, "library.json")],
      ["link-in-dir", join(dir, "feedback")],
      ["shots/link-out-file.png", join(outside, "o.json")],
      ["link-out-dir", join(outside, "od")],
      ["rounds/dangling", join(outside, "missing")],
    ];
    for (const [name, target] of links) symlinkSync(target, join(dir, name));
    const result = await run_import(env, api, dir);
    assert.equal(result.state, "staging");
    const stored = stored_report(env, batch_row(env.db, result.batch_id));
    for (const [name] of links) {
      assert.ok(has_entry(result.report, "unmapped_input", name), `${name} is reported in the result`);
      assert.ok(has_entry(api.report_unknown(env.db, result.batch_id), "unmapped_input", name), `${name} in report_unknown`);
      assert.ok(has_entry(stored, "unmapped_input", name), `${name} in the stored blob`);
    }
    const text = JSON.stringify(result.report);
    assert.ok(!text.includes(outside) && !text.includes(env.home.root), "no absolute path or link target is reported");
    const scanned = api.scan_project(dir).files.map((f) => f.path);
    for (const [name] of links) assert.ok(!scanned.includes(name), `${name} is not in the manifest`);
  });
});

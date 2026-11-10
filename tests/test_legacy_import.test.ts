// SEL-44 (stage 2 PR11): legacy importer, safety / idempotency / report / approvals / carry-over.
// Tests written before the implementation; the worker matches these names and shapes.
// The content mapping (items, sources, stages, questions, answers) is in test_legacy_import_content.test.ts.
// Everything is synthetic: tests/fixtures/legacy/** (hand made), a temporary HOME/PES_HOME, a FakeClock,
// a COPY of each fixture per test. Nothing touches the real ~/.pes or ~/pes-projects.
//
// ---------------------------------------------------------------------------------------------------
// INTERFACE (decided here, because the issue gives names but no shapes)
//
// scripts/pes_core/legacy.ts   (public module; NO SQL writes in it — they live in the command below)
//   scan_project(dir: string): LegacyScan
//       Read-only. Every regular file below dir -> {path ("/"-relative), size, sha256}, sorted by path;
//       `fingerprint` = sha256 over that manifest (same content -> same value, any edit -> new value);
//       project_json_ok = project.json exists and is valid JSON. Never writes, never throws for a damaged
//       project.json. (types: tests/helpers/legacy_env.ts)
//   import_project(service: CommandService, dir: string, opts: { owner_actor_id: string }): Promise<ImportResult>
//       DEVIATION from the leader's "import_project(db, dir, opts)": writes must go through the
//       command service, so the first argument is the CommandService (the tests keep their own Db handle
//       for reads). Reads dir only (never writes/deletes there), copies files into the object store
//       (reserve -> store -> complete, so blobs rows are ready) and writes ONE new project in the same
//       database as import_batches(state='staging') + legacy_mappings.
//       owner_actor_id = the current human owner who runs the import (migration-map 1절, "프로젝트
//       소유자·초기 정책"): it becomes projects.owner_user_id / project_members(owner) / the author of the
//       initial policy. A damaged project.json -> returns state 'failed' (batch row state 'failed'; it does
//       NOT throw and does NOT activate anything). Same source_fingerprint -> the existing batch is
//       returned with replayed=true and nothing new is written (a failed batch replays as failed too).
//       result.report is the same report that report_unknown returns.
//   map_legacy(db: Db, batch_id: string): MappingRow[]
//       Read-only: every legacy_mappings row of the batch (columns as in DDL).
//   report_unknown(db: Db, batch_id: string): UnknownReport
//       Read-only: {batch_id, entries: [{category, path, key?, detail?}]}; the same JSON is stored in the
//       blob import_batches.report_blob_id points at. Categories (fixed here):
//         unknown_field          key = JSON pointer inside `path` ("/unknown_top", "/stages/plan/mystery_stage_key",
//                                "/stages/plan/items/0/weird_item_key", library.json "/library_unknown_key")
//         unprocessed_answer     path = feedback/<file> that project.json `processed` does not list
//         processed_without_file path = feedback/<name> listed in `processed` but absent
//         missing_file           path = the referenced file that does not exist (shots/…, reports/…)
//         parse_error            path = a file that is not valid JSON (kept as a raw blob, import goes on)
//         unmapped_input         path = a file no rule knows (kept as a raw blob)
//         quarantined            path = project.json.tmp whose content differs from project.json
//       The report never contains an absolute path or the source folder's real location.
//   mapping kinds (legacy_mappings.legacy_kind), fixed here: project_json, library_json, feedback_file,
//       feedback_log, ask_file, snapshot_file, round_file, report_file, out_file, shot_file,
//       library_shot_file, item (scope = stage key or "library", key = old numeric id as text),
//       question (scope = stage key, key = old question id). For file kinds legacy_key = the
//       source-relative path ("/"); for feedback_file it is the file name or the relative path (both accepted).
//
// NEW COMMAND (one; registered in COMMANDS; added to tests/helpers/command_names.ts, sorted):
//   legacy.import_project   scope: not project-bound (like project.bootstrap) except the owner actor;
//                           via 'import'. The worker may add more legacy.* commands (keep EXPECTED sorted).
//
// INTERPRETATIONS (migration-map.md is the contract; where it is silent, decided here)
//  1  One imported folder = one NEW project (status 'staging'), its own edition 1 + six stages. The
//     host project that already exists in the test database is not touched.
//  2  Import never activates: import_batches.state stays 'staging' (PR12 validates/activates),
//     projects.status 'staging'. complete=false -> editions.status 'active' + active_edition_id set;
//     complete=true -> editions.status 'completed', active_edition_id NULL (map 8절 4번).
//  3  Actor: all imported object versions are authored by ONE actor of kind 'legacy_unknown' (user_id
//     NULL); every mutation_commits row of the project has via 'import'. No user and no human actor
//     is created from feedback `who` (fake humans are forbidden).
//  4  Old approvals (approved_at / status approved) -> approvals(origin 'legacy', assurance
//     'legacy_unverified', actor_kind 'legacy_unknown', human_user_id NULL); never origin 'new'.
//  5  carry_over[] -> followups/followup_versions kind 'next_round_task', state 'proposed' (past
//     acceptance cannot be proven), description = request, target_stage_id = the NEXT stage (in the fixed
//     order plan, research, analyze, write, verify, publish) after the stage that CARRIES the entry,
//     target_round_id NULL (so it shows in EVERY round of that stage, PR6 open_tasks_for_round),
//     base_artifact_version_id = the imported version of item `item` of the carrying stage. `from` is NOT
//     the target (corrected after R1-1 required 4: the skill carries the entry in the approved stage and
//     processes it "in the next stage's first round"); its original text stays in legacy_extra. A
//     carry_over held by the last stage (publish) has no next stage: no followup row, kept and reported.
//  6  Initial policy = ONE project_policy_versions row, policy_rev 1, reason 'legacy default',
//     allow_opencode_go 1, authored by the owner (human, forced by the schema), tx via 'import',
//     projects.current_policy_id points at it; editions.settings_json.legacy_extra.policy_default marks it
//     as a default. It is NOT recorded as a past consent: no decision/assumption rows, no 'new' approval.
//  7  Regenerable / volatile files (ask-*.html, index.html, report.html, report.md under reports/,
//     eli5.html, out/report.html, digest.txt, qa-brief.md, .pes-lock) are not mapped; they appear (path +
//     sha256) in the source manifest blob (import_batches.source_manifest_blob_id).
//  8  Unknown top-level / stage / item keys are kept under legacy_extra.<key> (editions.settings_json,
//     stages.settings_json, artifact_versions.metadata_json) AND listed in the report.
// ---------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import test from "node:test";

import { open_tasks_for_round } from "../scripts/pes_core/editions.ts";
import { current_policy } from "../scripts/pes_core/policy.ts";
import { blob_row_must, disk_path } from "./helpers/blob_env.ts";
import { EXPECTED_COMMAND_NAMES } from "./helpers/command_names.ts";
import {
  batch_row,
  copy_fixture,
  edition_of,
  has_entry,
  json_of,
  make_broken_project,
  make_large_project,
  mappings_of,
  project_row,
  rounds_of,
  run_import,
  sha256_of,
  stage_of,
  stored_report,
  table_counts,
  tree_digest,
  tree_entries,
  with_legacy,
} from "./helpers/legacy_env.ts";

const FULL_SLUG = "synthetic-legacy-full";

// Files nothing maps (map 6.2); they only live in the source manifest.
const REGENERABLE = new Set([
  "index.html",
  "ask-plan-start.html",
  ".pes-lock",
  "rounds/research-R1/digest.txt",
  "rounds/research-R1/qa-brief.md",
  "reports/plan/report.md",
  "reports/plan/report.html",
  "reports/plan/eli5.html",
  "out/report.html",
]);

// ---------------------------------------------------------------------------
// registry

test("legacy.import_project is in the expected command list", () => {
  assert.ok(EXPECTED_COMMAND_NAMES.includes("legacy.import_project"));
  assert.deepEqual([...EXPECTED_COMMAND_NAMES], [...EXPECTED_COMMAND_NAMES].sort());
});

// ---------------------------------------------------------------------------
// scan_project: read-only list + hashes

test("scan_project lists every file with its size and sha256, and a stable fingerprint", async () => {
  await with_legacy(async (env, api) => {
    const dir = copy_fixture(env, "full");
    const before = tree_digest(dir);
    const scan = api.scan_project(dir);
    assert.equal(scan.project_json_ok, true);
    assert.deepEqual(
      scan.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
      tree_entries(dir),
    );
    assert.match(scan.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(api.scan_project(dir).fingerprint, scan.fingerprint);
    assert.equal(tree_digest(dir), before, "scanning does not change the folder");
    // an edited byte -> a different fingerprint
    const other = copy_fixture(env, "full");
    writeFileSync(`${other}/out/cover.json`, '{"authors":"다른 연구진"}', "utf8");
    assert.notEqual(api.scan_project(other).fingerprint, scan.fingerprint);
  });
});

test("scan_project does not throw on a damaged project.json and says so", async () => {
  await with_legacy(async (env, api) => {
    const dir = make_broken_project(env);
    const before = tree_digest(dir);
    const scan = api.scan_project(dir);
    assert.equal(scan.project_json_ok, false);
    assert.ok(scan.files.some((f) => f.path === "project.json"));
    assert.ok(scan.files.some((f) => f.path === "feedback/plan-R1-20260301-100000.json"));
    assert.equal(tree_digest(dir), before);
  });
});

// ---------------------------------------------------------------------------
// completion 1: the source hash never changes (broken / 2 MB / fully synthetic)

for (const name of ["full", "complete", "broken-parts"]) {
  test(`importing fixture '${name}' (twice) leaves every source file byte-identical`, async () => {
    await with_legacy(async (env, api) => {
      const dir = copy_fixture(env, name);
      const before = tree_digest(dir);
      const first = await run_import(env, api, dir);
      assert.equal(first.state, "staging");
      assert.equal(tree_digest(dir), before, "first import");
      await run_import(env, api, dir);
      assert.equal(tree_digest(dir), before, "second import");
    });
  });
}

test("a truncated project.json fails the batch and leaves the source untouched", async () => {
  await with_legacy(async (env, api) => {
    const dir = make_broken_project(env);
    const before = tree_digest(dir);
    const result = await run_import(env, api, dir);
    assert.equal(tree_digest(dir), before);
    assert.equal(result.state, "failed");
    assert.equal(result.replayed, false);
    const batch = batch_row(env.db, result.batch_id);
    assert.equal(batch.state, "failed");
    assert.equal(batch.project_id, result.project_id);
    assert.ok(has_entry(result.report, "parse_error", "project.json"), "the damage is reported");
    assert.notEqual(project_row(env.db, result.project_id).status, "active", "nothing is activated");
    assert.equal(
      env.db.all("SELECT 1 FROM approvals WHERE project_id = ?", result.project_id).length,
      0,
      "no approval is invented from a damaged file",
    );
  });
});

test("a failed import replays as failed without new rows, and the source stays identical", async () => {
  await with_legacy(async (env, api) => {
    const dir = make_broken_project(env);
    const before = tree_digest(dir);
    const first = await run_import(env, api, dir);
    const counts = table_counts(env.db);
    const second = await run_import(env, api, dir);
    assert.equal(second.replayed, true);
    assert.equal(second.state, "failed");
    assert.equal(second.batch_id, first.batch_id);
    assert.deepEqual(table_counts(env.db), counts);
    assert.equal(tree_digest(dir), before);
  });
});

test("a valid 2 MB project.json imports, keeps its payload, and the source hash is unchanged", async () => {
  await with_legacy(async (env, api) => {
    const dir = make_large_project(env);
    const before = tree_digest(dir);
    const size = tree_entries(dir).find((e) => e.path === "project.json")!.size;
    assert.ok(size > 2 * 1024 * 1024, "the fixture really is over 2 MB");
    const result = await run_import(env, api, dir);
    assert.equal(tree_digest(dir), before);
    assert.equal(result.state, "staging");
    assert.ok(has_entry(result.report, "unknown_field", "project.json", "/synthetic_payload"));
    const extra = json_of(edition_of(env.db, result.project_id).settings_json).legacy_extra as Record<string, unknown>;
    assert.equal((extra.synthetic_payload as string).length, 2 * 1024 * 1024, "the unknown key is kept whole");
    const again = await run_import(env, api, dir);
    assert.equal(again.replayed, true);
    assert.equal(tree_digest(dir), before);
  });
});

// ---------------------------------------------------------------------------
// staging batch

test("import_project writes a staging batch, a staging project, and the source manifest", async () => {
  await with_legacy(async (env, api) => {
    const dir = copy_fixture(env, "full");
    const scan = api.scan_project(dir);
    const result = await run_import(env, api, dir);
    assert.equal(result.state, "staging");
    assert.equal(result.replayed, false);
    assert.equal(result.source_fingerprint, scan.fingerprint);

    const batch = batch_row(env.db, result.batch_id);
    assert.equal(batch.state, "staging");
    assert.equal(batch.source_fingerprint, scan.fingerprint);
    assert.ok(batch.source_schema.length > 0);
    assert.ok(batch.importer_version.length > 0);
    assert.equal(batch.project_id, result.project_id);

    const project = project_row(env.db, result.project_id);
    assert.equal(project.slug, FULL_SLUG);
    assert.equal(project.topic, "합성 도서관 운영 연구");
    assert.equal(project.status, "staging", "the importer never activates");
    assert.equal(project.created_at, BigInt(Date.UTC(2026, 0, 5)), "created: 2026-01-05 as UTC midnight");
    assert.notEqual(project.id, env.p.project_id, "a new project, not the host project");

    const edition = edition_of(env.db, result.project_id);
    assert.equal(edition.status, "active");
    assert.equal(project.active_edition_id, edition.id);
    assert.equal(edition.current_stage_id, stage_of(env.db, result.project_id, "research").id);
    assert.equal(env.db.all("SELECT 1 FROM stages WHERE edition_id = ?", edition.id).length, 6);

    // the manifest blob lists every file (regenerable ones too) with its hash
    const manifest = blob_row_must(env.db, batch.source_manifest_blob_id);
    assert.equal(manifest.state, "ready");
    const text = new TextDecoder().decode(readFileSync(disk_path(env, manifest)));
    for (const entry of tree_entries(dir)) {
      assert.ok(text.includes(entry.path), `manifest lists ${entry.path}`);
      assert.ok(text.includes(entry.sha256), `manifest has the hash of ${entry.path}`);
    }
  });
});

test("a complete=true project becomes a completed edition with no active pointer", async () => {
  await with_legacy(async (env, api) => {
    const result = await run_import(env, api, copy_fixture(env, "complete"));
    assert.equal(result.state, "staging");
    const project = project_row(env.db, result.project_id);
    const edition = edition_of(env.db, result.project_id);
    assert.equal(edition.status, "completed");
    assert.equal(project.active_edition_id, null);
    const publish = stage_of(env.db, result.project_id, "publish");
    const approvals = env.db.all<{ origin: string; assurance: string; actor_kind: string; human_user_id: string | null }>(
      "SELECT origin, assurance, actor_kind, human_user_id FROM approvals WHERE stage_id = ?",
      publish.id,
    );
    assert.equal(approvals.length, 1, "the completion is one legacy approval of the publish stage");
    assert.deepEqual({ ...approvals[0]! }, {
      origin: "legacy",
      assurance: "legacy_unverified",
      actor_kind: "legacy_unknown",
      human_user_id: null,
    });
  });
});

// ---------------------------------------------------------------------------
// completion 2: idempotent re-run

test("importing the same source twice writes nothing the second time", async () => {
  await with_legacy(async (env, api) => {
    const dir = copy_fixture(env, "full");
    const first = await run_import(env, api, dir);
    const counts = table_counts(env.db);
    const mappings = api.map_legacy(env.db, first.batch_id);
    assert.ok(mappings.length > 0);

    const second = await run_import(env, api, dir);
    assert.equal(second.replayed, true);
    assert.equal(second.batch_id, first.batch_id);
    assert.equal(second.project_id, first.project_id);
    assert.equal(second.state, "staging");
    assert.deepEqual(table_counts(env.db), counts, "no row of any table was added");
    assert.deepEqual(api.map_legacy(env.db, first.batch_id), mappings);
    assert.deepEqual(second.report, first.report);

    const third = await run_import(env, api, dir);
    assert.equal(third.batch_id, first.batch_id);
    assert.deepEqual(table_counts(env.db), counts);
  });
});

test("a re-run is idempotent even with another project imported in between", async () => {
  await with_legacy(async (env, api) => {
    const full = copy_fixture(env, "full");
    const first = await run_import(env, api, full);
    const other = await run_import(env, api, copy_fixture(env, "complete"));
    assert.notEqual(other.project_id, first.project_id);
    assert.notEqual(other.batch_id, first.batch_id);
    const counts = table_counts(env.db);
    const again = await run_import(env, api, full);
    assert.equal(again.batch_id, first.batch_id);
    assert.equal(again.replayed, true);
    assert.deepEqual(table_counts(env.db), counts);
  });
});

test("no mapping appears twice and every old key keeps one new object", async () => {
  await with_legacy(async (env, api) => {
    const result = await run_import(env, api, copy_fixture(env, "full"));
    await run_import(env, api, copy_fixture(env, "full"));
    const rows = api.map_legacy(env.db, result.batch_id);
    const keys = rows.map((r) => [r.legacy_kind, r.legacy_scope, r.legacy_key, r.content_hash].join("\u0000"));
    assert.equal(new Set(keys).size, keys.length, "legacy_mappings primary key is never violated");
    const objects = rows.filter((r) => r.new_object_id !== null).map((r) => r.new_object_id!);
    for (const id of objects) {
      const row = env.db.get<{ project_id: string }>("SELECT project_id FROM objects WHERE id = ?", id);
      assert.ok(row, "the mapped object exists");
      assert.equal(row.project_id, result.project_id, "and belongs to the imported project");
    }
  });
});

// ---------------------------------------------------------------------------
// the host project is not affected

test("the project that already exists is not changed by an import", async () => {
  await with_legacy(async (env, api) => {
    const host = env.p.project_id;
    const snapshot = () =>
      JSON.stringify([
        env.db.all("SELECT * FROM projects WHERE id = ?", host),
        env.db.all("SELECT id, kind, display_no, current_version_id, rev FROM objects WHERE project_id = ?", host),
        env.db.all("SELECT id, status, current_round_id FROM stages WHERE project_id = ?", host),
        env.db.all("SELECT id, project_id, policy_rev FROM project_policy_versions WHERE project_id = ?", host),
        env.db.all("SELECT event_seq FROM events WHERE project_id = ?", host),
        env.db.all("SELECT id FROM mutation_commits WHERE project_id = ?", host),
      ], (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    const before = snapshot();
    await run_import(env, api, copy_fixture(env, "full"));
    assert.equal(snapshot(), before);
  });
});

// ---------------------------------------------------------------------------
// completion 3: unknown fields, unprocessed answers, missing files go to the report

test("the report names unknown fields, unprocessed answers, and missing files", async () => {
  await with_legacy(async (env, api) => {
    const result = await run_import(env, api, copy_fixture(env, "full"));
    const report = api.report_unknown(env.db, result.batch_id);
    assert.equal(report.batch_id, result.batch_id);

    // unknown fields (project / stage / item / library level)
    assert.ok(has_entry(report, "unknown_field", "project.json", "/unknown_top"));
    assert.ok(has_entry(report, "unknown_field", "project.json", "/stages/plan/mystery_stage_key"));
    assert.ok(has_entry(report, "unknown_field", "project.json", "/stages/plan/items/0/weird_item_key"));
    assert.ok(has_entry(report, "unknown_field", "library.json", "/library_unknown_key"));
    assert.ok(!has_entry(report, "unknown_field", "project.json", "/topic"), "a known key is not 'unknown'");

    // answers that `processed` does not list
    assert.ok(has_entry(report, "unprocessed_answer", "feedback/research-R1-20260105-130000.json"));
    assert.ok(has_entry(report, "unprocessed_answer", "feedback/research-R1-20260105-140000.json"));
    assert.ok(!has_entry(report, "unprocessed_answer", "feedback/plan-R1-20260105-110000.json"));
    assert.ok(!has_entry(report, "unprocessed_answer", "feedback/plan-R1-20260105-120000.json"));
    assert.ok(has_entry(report, "processed_without_file", "feedback/ghost-R1-20260101-000000.json"));

    // files that are referenced but absent
    assert.ok(has_entry(report, "missing_file", "shots/missing.png"));
    assert.ok(has_entry(report, "missing_file", "reports/research/report.docx"));
    assert.ok(!has_entry(report, "missing_file", "shots/shot-1.png"), "a present file is not missing");

    // damaged / unknown / quarantined files
    assert.ok(has_entry(report, "parse_error", "snapshots/analyze-R1.json"));
    assert.ok(has_entry(report, "unmapped_input", "mystery.dat"));
    assert.ok(has_entry(report, "quarantined", "project.json.tmp"));
  });
});

test("the report is the same in the result, report_unknown, and the stored blob, and has no absolute path", async () => {
  await with_legacy(async (env, api) => {
    const dir = copy_fixture(env, "full");
    const result = await run_import(env, api, dir);
    const read = api.report_unknown(env.db, result.batch_id);
    assert.deepEqual(read, result.report);
    assert.deepEqual(stored_report(env, batch_row(env.db, result.batch_id)), read);
    const text = JSON.stringify(read);
    assert.ok(!text.includes(dir), "the report does not carry the source folder's location");
    assert.ok(!text.includes(env.home.root));
    assert.ok(!/\/Users\/|\/home\/|[A-Z]:\\\\/.test(text), "no user path");
  });
});

test("damaged parts are reported and kept as raw blobs while the import goes on", async () => {
  await with_legacy(async (env, api) => {
    const dir = copy_fixture(env, "broken-parts");
    const result = await run_import(env, api, dir);
    assert.equal(result.state, "staging", "only project.json damage fails a batch");
    for (const path of [
      "library.json",
      "feedback/plan-R1-20260301-100000.json",
      "ask/plan-start.json",
      "snapshots/plan-R1.json",
    ]) {
      assert.ok(has_entry(result.report, "parse_error", path), `${path} is reported`);
      const sha = tree_entries(dir).find((e) => e.path === path)!.sha256;
      const blob = env.db.get<{ state: string }>(
        "SELECT state FROM blobs WHERE project_id = ? AND sha256 = ?",
        result.project_id,
        sha,
      );
      assert.ok(blob, `${path} is kept byte-for-byte as a blob`);
    }
    // the readable part of the project still came over
    const items = mappings_of(api.map_legacy(env.db, result.batch_id), "item");
    assert.equal(items.length, 1);
    assert.equal(project_row(env.db, result.project_id).slug, "synthetic-legacy-broken-parts");
  });
});

// ---------------------------------------------------------------------------
// completion 4: old approvals are legacy_unknown / NULL user / legacy_unverified

test("an old approval is a legacy approval by a legacy_unknown actor with no user", async () => {
  await with_legacy(async (env, api) => {
    const users_before = Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM users")!.n);
    const humans_before = Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM actors WHERE kind = 'human'")!.n);
    const result = await run_import(env, api, copy_fixture(env, "full"));

    const rows = env.db.all<{ stage_id: string; actor_id: string; actor_kind: string; human_user_id: string | null; origin: string; assurance: string; tx_id: string }>(
      "SELECT stage_id, actor_id, actor_kind, human_user_id, origin, assurance, tx_id FROM approvals WHERE project_id = ?",
      result.project_id,
    );
    assert.equal(rows.length, 1, "only plan carried an approved_at");
    const plan = stage_of(env.db, result.project_id, "plan");
    const approval = { ...rows[0]! };
    assert.equal(approval.stage_id, plan.id);
    assert.equal(approval.origin, "legacy");
    assert.equal(approval.assurance, "legacy_unverified");
    assert.equal(approval.actor_kind, "legacy_unknown");
    assert.equal(approval.human_user_id, null);
    assert.equal(plan.status, "approved");
    assert.ok(plan.approved_snapshot_id, "the approved stage points at a (possibly synthesized) snapshot");

    const actor = env.db.get<{ kind: string; user_id: string | null }>("SELECT kind, user_id FROM actors WHERE id = ?", approval.actor_id);
    assert.deepEqual({ ...actor! }, { kind: "legacy_unknown", user_id: null });
    const tx = env.db.get<{ via: string }>("SELECT via FROM mutation_commits WHERE id = ?", approval.tx_id);
    assert.equal(tx?.via, "import");

    // no "new" approval, no fake person
    assert.equal(env.db.all("SELECT 1 FROM approvals WHERE project_id = ? AND origin <> 'legacy'", result.project_id).length, 0);
    assert.equal(Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM users")!.n), users_before);
    assert.equal(Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM actors WHERE kind = 'human'")!.n), humans_before);
    for (const a of env.db.all<{ user_id: string | null }>("SELECT user_id FROM actors WHERE kind = 'legacy_unknown'")) {
      assert.equal(a.user_id, null);
    }
  });
});

test("everything the importer wrote is attributed to legacy_unknown and an import transaction", async () => {
  await with_legacy(async (env, api) => {
    const result = await run_import(env, api, copy_fixture(env, "full"));
    const authors = env.db.all<{ kind: string }>(
      "SELECT DISTINCT a.kind AS kind FROM object_versions ov JOIN actors a ON a.id = ov.actor_id WHERE ov.project_id = ?",
      result.project_id,
    );
    assert.deepEqual(authors.map((r) => r.kind), ["legacy_unknown"]);
    const vias = env.db.all<{ via: string }>(
      "SELECT DISTINCT via FROM mutation_commits WHERE project_id = ?",
      result.project_id,
    );
    assert.deepEqual(vias.map((r) => r.via), ["import"]);
    assert.ok(
      env.db.all("SELECT 1 FROM events WHERE project_id = ?", result.project_id).length > 0,
      "the import leaves events",
    );
  });
});

// ---------------------------------------------------------------------------
// completion 5: carry_over survives as next_round_task and shows up in the next R1

test("carry_over becomes a next_round_task with its request, the NEXT stage as target, and the carrying item as base (corrected after R1-1 required 4)", async () => {
  await with_legacy(async (env, api) => {
    const result = await run_import(env, api, copy_fixture(env, "full"));
    const rows = env.db.all<{
      description: string;
      state: string;
      kind: string;
      target_stage_id: string | null;
      target_round_id: string | null;
      base_artifact_version_id: string | null;
    }>(
      `SELECT fv.description, fv.state, fv.kind, fv.target_stage_id, fv.target_round_id, fv.base_artifact_version_id
         FROM followup_versions fv WHERE fv.project_id = ? ORDER BY fv.description`,
      result.project_id,
    ).map((r) => ({ ...r }));

    const research = stage_of(env.db, result.project_id, "research");
    const analyze = stage_of(env.db, result.project_id, "analyze");
    const mappings = api.map_legacy(env.db, result.batch_id);
    const item = (scope: string, key: string) =>
      mappings.find((m) => m.legacy_kind === "item" && m.legacy_scope === scope && m.legacy_key === key);

    // plan carries it; the next stage after plan is research
    const from_plan = rows.find((r) => r.description === "다음 단계에서 표를 보강한다");
    assert.ok(from_plan, "plan's carry_over is a follow-up");
    assert.equal(from_plan.kind, "next_round_task");
    assert.equal(from_plan.state, "proposed", "past acceptance cannot be proven");
    assert.equal(from_plan.target_stage_id, research.id);
    assert.equal(from_plan.target_round_id, null);
    assert.equal(from_plan.base_artifact_version_id, item("plan", "1")?.new_version_id);

    // research carries it; the next stage after research is analyze
    const from_research = rows.find((r) => r.description === "분석 단계에서 수치를 다시 확인한다");
    assert.ok(from_research, "research's carry_over is a follow-up");
    assert.equal(from_research.kind, "next_round_task");
    assert.equal(from_research.target_stage_id, analyze.id);
    assert.equal(from_research.base_artifact_version_id, item("research", "1")?.new_version_id);

    // a carry_over without `from` is no longer special: the target does not depend on `from`
    const no_from = rows.find((r) => r.description === "대상을 알 수 없는 남은 일");
    assert.ok(no_from, "the entry without `from` is a follow-up too (target = the stage after plan)");
    assert.equal(no_from.target_stage_id, research.id);
    assert.equal(no_from.base_artifact_version_id, item("plan", "2")?.new_version_id);
    assert.equal(rows.length, 3);
  });
});

test("the carried-over tasks show up in the NEXT stage's rounds (PR6 open_tasks_for_round)", async () => {
  await with_legacy(async (env, api) => {
    const result = await run_import(env, api, copy_fixture(env, "full"));
    const pid = result.project_id;
    const plan = stage_of(env.db, pid, "plan");
    const research = stage_of(env.db, pid, "research");
    const analyze = stage_of(env.db, pid, "analyze");

    // research R1 sees both of plan's entries (the one with `from` and the one without)
    const research_rounds = rounds_of(env.db, research.id);
    assert.deepEqual(research_rounds.map((r) => [Number(r.round_no), r.state]), [[1, "open"]]);
    const r1 = open_tasks_for_round(env.db, pid, research_rounds[0]!.id);
    assert.deepEqual(r1.map((t) => t.description).sort(), ["다음 단계에서 표를 보강한다", "대상을 알 수 없는 남은 일"].sort());
    for (const task of r1) assert.equal(task.state, "proposed");

    // analyze shows research's entry in every one of its rounds
    const analyze_rounds = rounds_of(env.db, analyze.id);
    assert.deepEqual(analyze_rounds.map((r) => [Number(r.round_no), r.state]), [[1, "sealed"], [2, "open"]]);
    for (const round of analyze_rounds) {
      const tasks = open_tasks_for_round(env.db, pid, round.id);
      assert.deepEqual(tasks.map((t) => t.description), ["분석 단계에서 수치를 다시 확인한다"]);
    }

    // not shown in the carrying stage itself
    for (const round of rounds_of(env.db, plan.id)) {
      assert.deepEqual(open_tasks_for_round(env.db, pid, round.id), []);
    }
    for (const round of research_rounds) {
      assert.ok(
        !open_tasks_for_round(env.db, pid, round.id).some((t) => t.description === "분석 단계에서 수치를 다시 확인한다"),
        "research's own entry is not a task of research",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// completion 6: the new policy default is not a past consent

test("the initial policy is a 'legacy default' version, not a recorded consent", async () => {
  await with_legacy(async (env, api) => {
    const result = await run_import(env, api, copy_fixture(env, "full"));
    const pid = result.project_id;
    const project = project_row(env.db, pid);

    const versions = env.db.all<{
      id: string;
      policy_rev: bigint;
      allow_opencode_go: bigint;
      changed_by: string;
      changed_by_user_id: string;
      changed_by_kind: string;
      reason: string;
      tx_id: string;
    }>("SELECT * FROM project_policy_versions WHERE project_id = ?", pid).map((r) => ({ ...r }));
    assert.equal(versions.length, 1, "exactly one policy version, no history of earlier choices");
    const policy = versions[0]!;
    assert.equal(project.current_policy_id, policy.id);
    assert.equal(Number(policy.policy_rev), 1);
    assert.equal(policy.reason, "legacy default");
    assert.equal(Number(policy.allow_opencode_go), 1);
    assert.equal(policy.changed_by, env.p.actor_id, "the owner who ran the import, not an old user");
    assert.equal(policy.changed_by_user_id, project.owner_user_id);
    assert.equal(policy.changed_by_kind, "human");
    const tx = env.db.get<{ via: string }>("SELECT via FROM mutation_commits WHERE id = ?", policy.tx_id);
    assert.equal(tx?.via, "import");

    // the row is a coherent, readable policy for the PR10 checker
    const current = current_policy(env.db, pid);
    assert.equal(current.policy_rev, 1);
    assert.equal(current.allow_opencode_go, true);

    // marked as a default in the edition's legacy_extra; no consent trace anywhere
    const extra = json_of(edition_of(env.db, pid).settings_json).legacy_extra as Record<string, unknown>;
    assert.ok(extra && "policy_default" in extra, "legacy_extra.policy_default marks the default");
    for (const table of ["decisions", "assumptions"]) {
      assert.equal(env.db.all(`SELECT 1 FROM ${table} WHERE project_id = ?`, pid).length, 0, `${table}: none`);
    }
    assert.equal(
      env.db.all(
        "SELECT 1 FROM answer_versions av JOIN answers a ON a.object_id = av.object_id WHERE a.project_id = ? AND av.value LIKE '%opencode%'",
        pid,
      ).length,
      0,
      "no answer is made up for the policy",
    );
    assert.equal(
      env.db.all("SELECT 1 FROM approvals WHERE project_id = ? AND origin = 'new'", pid).length,
      0,
    );
  });
});

test("the owner is the human who ran the import and is the only member", async () => {
  await with_legacy(async (env, api) => {
    const result = await run_import(env, api, copy_fixture(env, "full"));
    const owner = env.db.get<{ user_id: string }>("SELECT user_id FROM actors WHERE id = ?", env.p.actor_id);
    const members = env.db.all<{ user_id: string; role: string }>(
      "SELECT user_id, role FROM project_members WHERE project_id = ?",
      result.project_id,
    ).map((r) => ({ ...r }));
    assert.deepEqual(members, [{ user_id: owner!.user_id, role: "owner" }]);
    assert.equal(project_row(env.db, result.project_id).owner_user_id, owner!.user_id);
  });
});

test("without a usable owner nothing is written", async () => {
  await with_legacy(async (env, api) => {
    const dir = copy_fixture(env, "full");
    const counts = table_counts(env.db);
    const before = tree_digest(dir);
    let failed = false;
    try {
      await api.import_project(env.service, dir, { owner_actor_id: "no-such-actor" });
    } catch {
      failed = true;
    }
    assert.ok(failed, "an unknown owner is refused");
    assert.deepEqual(table_counts(env.db), counts);
    assert.equal(tree_digest(dir), before);
    // an agent / legacy actor is not a human owner either
    env.db.run(
      "INSERT INTO actors (id, kind, user_id, display_name) VALUES ('legacy-x', 'legacy_unknown', NULL, '옛 작성자')",
    );
    let refused = false;
    try {
      await api.import_project(env.service, dir, { owner_actor_id: "legacy-x" });
    } catch {
      refused = true;
    }
    assert.ok(refused, "a non-human actor cannot own the imported project");
    assert.equal(tree_digest(dir), before);
  });
});

// ---------------------------------------------------------------------------
// completion 7: every input is mapped or reported

const INPUT_GROUPS: Array<[string, string]> = [
  ["project.json", "project.json"],
  ["library.json", "library.json"],
  ["feedback/", "feedback/plan-R1-20260105-110000.json"],
  ["feedback.log", "feedback.log"],
  ["snapshots/", "snapshots/plan-R1.json"],
  ["reports/", "reports/plan/eli5.json"],
  ["out/", "out/cover.json"],
  ["shots/", "shots/shot-1.png"],
  ["ask/", "ask/plan-start.json"],
  ["rounds/", "rounds/research-R1/1.json"],
  ["library/", "library/shots/lib-1.png"],
];

function is_mapped(rows: { legacy_key: string }[], path: string): boolean {
  return rows.some((r) => r.legacy_key === path || r.legacy_key === basename(path));
}

for (const [group, path] of INPUT_GROUPS) {
  test(`input ${group} (${path}) is mapped`, async () => {
    await with_legacy(async (env, api) => {
      const result = await run_import(env, api, copy_fixture(env, "full"));
      const rows = api.map_legacy(env.db, result.batch_id);
      assert.ok(is_mapped(rows, path), `${path} has a legacy_mappings row`);
      const row = rows.find((r) => r.legacy_key === path || r.legacy_key === basename(path))!;
      assert.match(row.content_hash, /^[0-9a-f]{64}$/);
      assert.ok(row.new_object_id !== null || row.new_row_id !== null);
    });
  });
}

test("every source file is mapped, reported, or listed as regenerable — none is silently dropped", async () => {
  await with_legacy(async (env, api) => {
    const dir = copy_fixture(env, "full");
    const result = await run_import(env, api, dir);
    const rows = api.map_legacy(env.db, result.batch_id);
    const report = api.report_unknown(env.db, result.batch_id);
    const missing: string[] = [];
    for (const entry of tree_entries(dir)) {
      if (REGENERABLE.has(entry.path)) continue;
      const accounted = is_mapped(rows, entry.path) || report.entries.some((e) => e.path === entry.path);
      if (!accounted) missing.push(entry.path);
    }
    assert.deepEqual(missing, []);
    // the sha256 of a mapped file is what the mapping and its blob say
    const cover = rows.find((r) => r.legacy_key === "out/cover.json")!;
    const bytes = readFileSync(`${dir}/out/cover.json`);
    assert.equal(cover.content_hash, sha256_of(bytes));
    assert.ok(
      env.db.get("SELECT 1 FROM blobs WHERE project_id = ? AND sha256 = ?", result.project_id, sha256_of(bytes)),
      "the file itself was stored",
    );
  });
});

test("feedback.log lines and processed names become events, none dropped", async () => {
  await with_legacy(async (env, api) => {
    const result = await run_import(env, api, copy_fixture(env, "full"));
    const count = (type: string) =>
      env.db.all("SELECT 1 FROM events WHERE project_id = ? AND type = ?", result.project_id, type).length;
    assert.equal(count("legacy.feedback_log"), 4, "four log lines, including the one nobody can parse");
    assert.equal(count("legacy.processed"), 3, "three processed names, including the one with no file");
    const raw = env.db
      .all<{ payload: string }>(
        "SELECT payload FROM events WHERE project_id = ? AND type = 'legacy.feedback_log'",
        result.project_id,
      )
      .map((e) => e.payload)
      .join("\n");
    assert.ok(raw.includes("이 줄은 해석할 수 없는 합성 로그"), "an unreadable line is kept verbatim");
  });
});

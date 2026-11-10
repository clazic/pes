// SEL-44 (stage 2 PR11) regression tests for the final Codex review 1/2 (logs/SEL-44-final-review-1.md).
// The rows of docs/plan/migration-map.md are the answer. Everything is synthetic and built in a
// temporary folder inside the test's isolated HOME; nothing here reads the real ~/.pes or ~/pes-projects.
//
//   F1  a normal snapshot (state.items) -> the items AS THEY WERE (also versions that differ from the
//       current one), their sources and links, and round_contents of that round pointing at them
//   F2  the same question id in two different ask files: neither form is changed by the other;
//       equal content must not fail the batch; set members and legacy_mappings = each form's version
//   F3  review.questions are indexed: review/resume answers and addenda attach to the question the
//       person really saw (set member version), the submission gets that set
//   F4  items[].path: existing file -> version_files(rendered); missing -> missing_file +
//       legacy_extra.missing_paths; unsafe path -> neutral report, never read
//   F5  rounds/<stage>-R<n>/qa.json -> review artifact + metadata.qa; result JSON -> source link when
//       its hash matches the item version, otherwise raw blob + unmapped_input
//   F6  unknown sub-fields of a source (and of user_links) -> locator.legacy_extra + unknown_field
//
// Interpretation fixed here (the map leaves room):
//   - "hash matches" (F5) = the result file's canonical JSON hash equals the legacy record hash of the
//     item version in project.json (i.e. the file is that item record). A file with other content, or
//     for an id without an item, is "not matching".
//   - A snapshot item with the same canonical record as the current item reuses the current version
//     (no duplicate version); a different record becomes an older version of the same object.
//   - Past-only mapping rows are allowed: tests that need "the current version" pick the mapping row
//     whose version carries the current title.
//
// If this contradicts an earlier test, the earlier test is corrected where it is written and
// the correction is named in the commit message.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  json_of,
  rounds_of,
  run_import,
  sha256_of,
  stage_of,
  with_legacy,
  type Env,
  type ImportResult,
  type LegacyApi,
  type MappingRow,
  type UnknownReport,
} from "./helpers/legacy_env.ts";

// ---------------------------------------------------------------------------
// helpers

let dir_counter = 0;

function new_source(env: Env, label: string): string {
  dir_counter += 1;
  const dir = join(env.home.root, `final1-${label}-${dir_counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function write_file(dir: string, rel: string, body: unknown): void {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, typeof body === "string" ? body : JSON.stringify(body), "utf8");
}

function base_project(slug: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pes: 1,
    topic: "합성 최종 리뷰 프로젝트",
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

interface Imported {
  dir: string;
  result: ImportResult;
  mappings: MappingRow[];
  pid: string;
}

async function import_body(
  env: Env,
  api: LegacyApi,
  label: string,
  body: Record<string, unknown>,
  files: Record<string, unknown> = {},
  setup?: (dir: string) => void,
): Promise<Imported> {
  const dir = new_source(env, label);
  write_file(dir, "project.json", body);
  for (const [rel, content] of Object.entries(files)) write_file(dir, rel, content);
  setup?.(dir);
  const result = await run_import(env, api, dir);
  assert.equal(result.state, "staging", `${label}: the import itself must not fail`);
  return { dir, result, mappings: api.map_legacy(env.db, result.batch_id), pid: result.project_id };
}

function rows_of(mappings: MappingRow[], kind: string, scope: string, key: string): MappingRow[] {
  return mappings.filter((m) => m.legacy_kind === kind && m.legacy_scope === scope && m.legacy_key === key);
}

interface ArtifactVersion {
  version_id: string;
  title: string;
  version_no: number;
}

function versions_of(env: Env, object_id: string): ArtifactVersion[] {
  return env.db
    .all<{ version_id: string; title: string; version_no: bigint }>(
      `SELECT av.version_id AS version_id, av.title AS title, ov.version_no AS version_no
         FROM artifact_versions av JOIN object_versions ov ON ov.id = av.version_id
        WHERE av.object_id = ? ORDER BY ov.version_no`,
      object_id,
    )
    .map((row) => ({ version_id: row.version_id, title: row.title, version_no: Number(row.version_no) }));
}

function title_of(env: Env, version_id: string): string {
  const row = env.db.get<{ title: string }>("SELECT title FROM artifact_versions WHERE version_id = ?", version_id);
  assert.ok(row, `artifact version ${version_id} exists`);
  return row.title;
}

/** Item mapping rows (one per version the importer made for that old item). */
function item_version_rows(env: Env, mappings: MappingRow[], scope: string, key: string): MappingRow[] {
  const rows = rows_of(mappings, "item", scope, key).filter((m) => m.new_object_id && m.new_version_id);
  assert.ok(rows.length > 0, `mapping for ${scope} item ${key}`);
  return rows;
}

function current_item_row(env: Env, mappings: MappingRow[], scope: string, key: string, title: string): MappingRow {
  const row = item_version_rows(env, mappings, scope, key).find((m) => title_of(env, m.new_version_id!) === title);
  assert.ok(row, `${scope} item ${key} has a mapped version titled "${title}"`);
  return row;
}

function files_of(env: Env, version_id: string): Array<{ role: string; sha256: string }> {
  return env.db
    .all<{ role: string; sha256: string }>(
      `SELECT vf.role AS role, b.sha256 AS sha256 FROM version_files vf
         JOIN blobs b ON b.id = vf.blob_id WHERE vf.version_id = ?`,
      version_id,
    )
    .map((row) => ({ role: row.role, sha256: row.sha256 }));
}

function metadata_of(env: Env, version_id: string): Record<string, unknown> {
  const row = env.db.get<{ metadata_json: string }>(
    "SELECT metadata_json FROM artifact_versions WHERE version_id = ?",
    version_id,
  );
  assert.ok(row);
  return json_of(row.metadata_json);
}

function legacy_extra_of_version(env: Env, version_id: string): Record<string, unknown> {
  const extra = metadata_of(env, version_id).legacy_extra;
  assert.ok(extra !== null && typeof extra === "object", "legacy_extra object exists");
  return extra as Record<string, unknown>;
}

function citation_titles(env: Env, version_id: string): string[] {
  return env.db
    .all<{ title: string }>(
      `SELECT sv.title AS title FROM citations c JOIN source_versions sv ON sv.version_id = c.source_version_id
        WHERE c.artifact_version_id = ? ORDER BY c.citation_no`,
      version_id,
    )
    .map((row) => row.title);
}

function has_report(report: UnknownReport, category: string, path: string, key?: string): boolean {
  return report.entries.some((e) => e.category === category && e.path === path && (key === undefined || e.key === key));
}

function dump_db_text(env: Env): string {
  const parts: string[] = [];
  const tables = env.db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  for (const table of tables) {
    for (const row of env.db.all<Record<string, unknown>>(`SELECT * FROM ${table.name}`)) {
      for (const value of Object.values(row)) {
        if (value === null || value === undefined) continue;
        parts.push(value instanceof Uint8Array ? Buffer.from(value).toString("latin1") : String(value));
      }
    }
  }
  return parts.join("\n");
}

// ===========================================================================
// F1: a normal snapshot -> past item versions, their sources, and round_contents
// ===========================================================================

const SAME_ITEM = { id: 3, title: "unchanged item", kind: "rq", status: "new", summary: "same everywhere" };

function f1_project(): Record<string, unknown> {
  const body = base_project("synthetic-final1-snapshot");
  (body.stages as Record<string, unknown>).plan = {
    status: "active",
    round: 2,
    items: [
      {
        id: 1,
        title: "current title",
        kind: "rq",
        status: "done",
        summary: "current summary",
        sources: [{ title: "current source", url: "https://example.invalid/cur", method: "fetch" }],
      },
      SAME_ITEM,
    ],
  };
  return body;
}

function f1_snapshot(): Record<string, unknown> {
  return {
    stage: "plan",
    round: 1,
    time: "2026-03-01 10:00",
    state: {
      status: "active",
      round: 1,
      items: [
        {
          id: 1,
          title: "old snapshot version",
          kind: "rq",
          status: "new",
          summary: "old summary",
          sources: [{ title: "old source", url: "https://example.invalid/old", method: "search" }],
        },
        SAME_ITEM,
      ],
    },
  };
}

test("F1a: a normal snapshot gives the old item version (different from the current one), its source, and round_contents that point at it", async () => {
  await with_legacy(async (env, api) => {
    const { pid, mappings } = await import_body(env, api, "f1a", f1_project(), {
      "snapshots/plan-R1.json": f1_snapshot(),
    });
    const stage = stage_of(env.db, pid, "plan");
    const rounds = rounds_of(env.db, stage.id);
    assert.deepEqual(rounds.map((r) => [Number(r.round_no), r.state]), [[1, "sealed"], [2, "open"]]);

    const current = current_item_row(env, mappings, "plan", "1", "current title");
    const versions = versions_of(env, current.new_object_id!);
    assert.deepEqual(
      versions.map((v) => v.title),
      ["old snapshot version", "current title"],
      "the same object keeps the old version first and the current version last",
    );
    const old = versions[0]!;

    // round 1 shows exactly the two snapshot items, each at its snapshot-time version
    const contents = env.db.all<{ object_id: string; version_id: string }>(
      "SELECT object_id, version_id FROM round_contents WHERE round_id = ?",
      rounds[0]!.id,
    );
    assert.equal(contents.length, 2, "one round_contents row per snapshot item");
    const first = contents.find((c) => c.object_id === current.new_object_id);
    assert.equal(first?.version_id, old.version_id, "round 1 points at the OLD version, not the current one");

    // the old version carries its own source and citation number
    assert.deepEqual(citation_titles(env, old.version_id), ["old source"]);
    assert.deepEqual(citation_titles(env, current.new_version_id!), ["current source"]);
  });
});

test("F1b: a snapshot item equal to the current item reuses the current version (no duplicate version) and round_contents points at it", async () => {
  await with_legacy(async (env, api) => {
    const { pid, mappings } = await import_body(env, api, "f1b", f1_project(), {
      "snapshots/plan-R1.json": f1_snapshot(),
    });
    const same = item_version_rows(env, mappings, "plan", "3");
    const object_id = same[0]!.new_object_id!;
    const versions = versions_of(env, object_id);
    assert.equal(versions.length, 1, "identical content is one version");
    const round1 = rounds_of(env.db, stage_of(env.db, pid, "plan").id)[0]!;
    const row = env.db.get<{ version_id: string }>(
      "SELECT version_id FROM round_contents WHERE round_id = ? AND object_id = ?",
      round1.id,
      object_id,
    );
    assert.equal(row?.version_id, versions[0]!.version_id);
  });
});

test("F1c: the snapshot manifest blob is still kept and the sealed snapshot points at it", async () => {
  await with_legacy(async (env, api) => {
    const snapshot = f1_snapshot();
    const { pid, dir } = await import_body(env, api, "f1c", f1_project(), { "snapshots/plan-R1.json": snapshot });
    assert.ok(dir.length > 0);
    const round1 = rounds_of(env.db, stage_of(env.db, pid, "plan").id)[0]!;
    assert.ok(round1.sealed_snapshot_id, "round 1 is sealed with a snapshot");
    const snap = env.db.get<{ scope: string; manifest_blob_id: string }>(
      "SELECT scope, manifest_blob_id FROM snapshots WHERE id = ?",
      round1.sealed_snapshot_id,
    );
    assert.equal(snap?.scope, "round");
    const blob = env.db.get<{ sha256: string }>("SELECT sha256 FROM blobs WHERE id = ?", snap!.manifest_blob_id);
    assert.equal(blob?.sha256, sha256_of(JSON.stringify(snapshot)), "the manifest is the snapshot file byte for byte");
  });
});

test("F1d: a damaged snapshot still gives no round_contents (nothing is guessed) while the batch stays staging", async () => {
  await with_legacy(async (env, api) => {
    const { pid } = await import_body(env, api, "f1d", f1_project(), { "snapshots/plan-R1.json": "{not json" });
    const round1 = rounds_of(env.db, stage_of(env.db, pid, "plan").id)[0]!;
    assert.equal(env.db.all("SELECT 1 FROM round_contents WHERE round_id = ?", round1.id).length, 0);
  });
});

// ===========================================================================
// F2: the same question id in different ask files
// ===========================================================================

function ask_file(id: string, kind: string, round: number, label: string): Record<string, unknown> {
  return {
    id,
    kind,
    stage: "plan",
    round,
    title: id,
    inherited: [],
    questions: [{ id: "scope", label, type: "text", required: false }],
  };
}

function set_member_texts(env: Env, pid: string, form_key: string): Array<{ version_id: string; text: string }> {
  const set = env.db.get<{ id: string }>("SELECT id FROM question_sets WHERE project_id = ? AND form_key = ?", pid, form_key);
  assert.ok(set, `question set ${form_key} exists`);
  return env.db
    .all<{ version_id: string; text: string }>(
      `SELECT qv.version_id AS version_id, qv.text AS text
         FROM question_set_members m JOIN question_versions qv ON qv.version_id = m.question_version_id
        WHERE m.set_id = ? ORDER BY m.position`,
      set.id,
    )
    .map((row) => ({ version_id: row.version_id, text: row.text }));
}

test("F2a: two ask files that reuse a question id with different content keep each form's own question; mappings point at each form's version", async () => {
  await with_legacy(async (env, api) => {
    const { pid, mappings } = await import_body(env, api, "f2a", base_project("synthetic-final1-ask-diff"), {
      "ask/a.json": ask_file("a", "stage_start", 0, "question 0"),
      "ask/b.json": ask_file("b", "resume", 1, "question 1"),
    });
    const a = set_member_texts(env, pid, "ask/a");
    const b = set_member_texts(env, pid, "ask/b");
    assert.deepEqual(a.map((m) => m.text), ["question 0"], "form a was not changed by form b");
    assert.deepEqual(b.map((m) => m.text), ["question 1"]);
    assert.notEqual(a[0]!.version_id, b[0]!.version_id);

    const mapped = new Set(rows_of(mappings, "question", "plan", "scope").map((m) => m.new_version_id));
    assert.ok(mapped.has(a[0]!.version_id), "legacy_mappings has form a's version");
    assert.ok(mapped.has(b[0]!.version_id), "legacy_mappings has form b's version");
  });
});

test("F2b: two ask files with an identical question do not fail the batch; both sets use a version that is mapped", async () => {
  await with_legacy(async (env, api) => {
    const { pid, mappings } = await import_body(env, api, "f2b", base_project("synthetic-final1-ask-same"), {
      "ask/a.json": ask_file("a", "stage_start", 0, "same question"),
      "ask/b.json": ask_file("b", "resume", 1, "same question"),
    });
    const a = set_member_texts(env, pid, "ask/a");
    const b = set_member_texts(env, pid, "ask/b");
    assert.deepEqual(a.map((m) => m.text), ["same question"]);
    assert.deepEqual(b.map((m) => m.text), ["same question"]);
    const mapped = new Set(rows_of(mappings, "question", "plan", "scope").map((m) => m.new_version_id));
    assert.ok(mapped.has(a[0]!.version_id) && mapped.has(b[0]!.version_id), "both versions are mapped");
    assert.equal(
      env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM import_batches WHERE project_id = ?", pid)?.n,
      1n,
      "the batch exists",
    );
  });
});

// ===========================================================================
// F3: review.questions are the questions that review / resume answers attach to
// ===========================================================================

function review_project(): Record<string, unknown> {
  const body = base_project("synthetic-final1-review");
  (body.stages as Record<string, unknown>).plan = {
    status: "active",
    round: 2,
    items: [],
    review: {
      round: 2,
      summary: "review summary",
      questions: [{ id: "rq1", label: "original review question", type: "text" }],
    },
  };
  return body;
}

function feedback_file(kind: string, spec: string, round: number, answers: Record<string, string>): Record<string, unknown> {
  return {
    stage: "plan",
    round,
    time: "20260302-100000",
    kind,
    text: "",
    answers,
    spec,
    via: "html",
    origin: "http://127.0.0.1:8760",
    who: "",
  };
}

function single_submission(env: Env, pid: string): { id: string; set_id: string | null } {
  const rows = env.db.all<{ id: string; set_id: string | null }>(
    "SELECT id, set_id FROM submissions WHERE project_id = ?",
    pid,
  );
  assert.equal(rows.length, 1, "one feedback file = one submission");
  return { id: rows[0]!.id, set_id: rows[0]!.set_id };
}

function answer_versions_of(env: Env, submission_id: string): Array<{ question_version_id: string; value: string }> {
  return env.db
    .all<{ question_version_id: string; value: string }>(
      `SELECT av.question_version_id AS question_version_id, av.value AS value
         FROM answer_versions av JOIN answers a ON a.object_id = av.object_id
        WHERE a.submission_id = ?`,
      submission_id,
    )
    .map((row) => ({ question_version_id: row.question_version_id, value: row.value }));
}

test("F3a: a review answer and its addendum attach to the original review question and the submission gets the review set", async () => {
  await with_legacy(async (env, api) => {
    const { pid, mappings } = await import_body(env, api, "f3a", review_project(), {
      "feedback/plan-R2-20260302-100000.json": feedback_file("review", "plan-R2-review", 2, {
        rq1: "review answer",
        rq1__other: "review addendum",
        ghost: "answer to a question nobody can find",
      }),
    });
    const review_set = env.db.get<{ id: string }>(
      "SELECT id FROM question_sets WHERE project_id = ? AND purpose = 'review'",
      pid,
    );
    assert.ok(review_set, "the review question set exists");
    const members = env.db.all<{ question_id: string; question_version_id: string }>(
      "SELECT question_id, question_version_id FROM question_set_members WHERE set_id = ?",
      review_set.id,
    );
    assert.equal(members.length, 1);
    const original = members[0]!;

    const submission = single_submission(env, pid);
    assert.equal(submission.set_id, review_set.id, "the submission is linked to the review set");

    const answers = answer_versions_of(env, submission.id);
    const to_original = answers.filter((a) => a.question_version_id === original.question_version_id);
    assert.equal(to_original.length, 1, "exactly one answer sits on the original review question version");
    assert.ok(to_original[0]!.value.includes("review answer"));

    // no placeholder for rq1; only the really-unknown 'ghost' gets an import question
    const imports = env.db.all<{ bank_key: string | null; text: string }>(
      `SELECT q.bank_key AS bank_key, qv.text AS text FROM questions q
         JOIN question_versions qv ON qv.object_id = q.object_id
        WHERE q.project_id = ? AND q.origin = 'import'`,
      pid,
    );
    assert.equal(imports.length, 1, "only one import placeholder");
    assert.ok(
      imports[0]!.bank_key === "ghost" || imports[0]!.text.includes("ghost"),
      "the placeholder is for ghost, not rq1",
    );
    assert.ok(rows_of(mappings, "question", "plan", "ghost").length > 0);

    // the addendum is a message on the original question version, tied to the same submission
    const thread = env.db.get<{ object_id: string; target_object_id: string; target_version_id: string | null }>(
      "SELECT object_id, target_object_id, target_version_id FROM threads WHERE project_id = ? AND context_kind = 'question_comment' AND target_version_id = ?",
      pid,
      original.question_version_id,
    );
    assert.ok(thread, "a question_comment thread targets the original review question version");
    assert.equal(thread.target_object_id, original.question_id);
    const message = env.db.get<{ submission_id: string | null; body_md: string }>(
      `SELECT m.submission_id AS submission_id, mv.body_md AS body_md
         FROM messages m JOIN message_versions mv ON mv.object_id = m.object_id WHERE m.thread_id = ?`,
      thread.object_id,
    );
    assert.equal(message?.submission_id, submission.id);
    assert.equal(message?.body_md, "review addendum");
  });
});

test("F3b: a resume answer is linked to the resume set and the version the form showed", async () => {
  await with_legacy(async (env, api) => {
    const { pid } = await import_body(env, api, "f3b", base_project("synthetic-final1-resume"), {
      "ask/plan-resume.json": {
        id: "plan-resume",
        kind: "resume",
        stage: "plan",
        round: 1,
        title: "resume",
        inherited: [],
        questions: [{ id: "rs1", label: "resume question", type: "text" }],
      },
      "feedback/plan-R1-20260302-100000.json": feedback_file("resume", "plan-resume", 1, { rs1: "resume answer" }),
    });
    const set = env.db.get<{ id: string; purpose: string }>(
      "SELECT id, purpose FROM question_sets WHERE project_id = ? AND form_key = 'ask/plan-resume'",
      pid,
    );
    assert.equal(set?.purpose, "resume");
    const member = env.db.get<{ question_version_id: string }>(
      "SELECT question_version_id FROM question_set_members WHERE set_id = ?",
      set!.id,
    );
    const submission = single_submission(env, pid);
    assert.equal(submission.set_id, set!.id, "the submission is linked to the resume set");
    const answers = answer_versions_of(env, submission.id);
    assert.equal(answers.length, 1);
    assert.equal(answers[0]!.question_version_id, member!.question_version_id);
    assert.equal(
      env.db.all("SELECT 1 FROM questions WHERE project_id = ? AND origin = 'import'", pid).length,
      0,
      "no placeholder question was needed",
    );
  });
});

// ===========================================================================
// F4: items[].path
// ===========================================================================

test("F4: items[].path links an existing file as rendered, reports a missing one, and reports unsafe ones neutrally without reading them", async () => {
  await with_legacy(async (env, api) => {
    const parent = new_source(env, "f4");
    const dir = join(parent, "src");
    mkdirSync(dir, { recursive: true });
    const outside_marker = "F4-OUTSIDE-MARKER-7d41";
    writeFileSync(join(parent, "outside-item.pdf"), outside_marker, "utf8");
    const file_text = "F4 synthetic deliverable bytes";
    write_file(dir, "deliverables/item.pdf", file_text);
    const body = base_project("synthetic-final1-path");
    (body.stages as Record<string, unknown>).plan = {
      status: "active",
      round: 1,
      items: [
        { id: 1, title: "has file", kind: "output", status: "done", path: "deliverables/item.pdf" },
        { id: 2, title: "no file", kind: "output", status: "done", path: "deliverables/missing-item.pdf" },
        { id: 3, title: "climbs out", kind: "output", status: "done", path: "../outside-item.pdf" },
        { id: 4, title: "absolute", kind: "output", status: "done", path: "/Users/alice/secret/item.pdf" },
      ],
    };
    write_file(dir, "project.json", body);
    const result = await run_import(env, api, dir);
    assert.equal(result.state, "staging");
    const mappings = api.map_legacy(env.db, result.batch_id);
    const version = (key: string) => item_version_rows(env, mappings, "plan", key)[0]!.new_version_id!;

    // existing file: rendered link to the exact bytes, original path kept in legacy_extra
    const linked = files_of(env, version("1")).filter((f) => f.role === "rendered");
    assert.equal(linked.length, 1);
    assert.equal(linked[0]!.sha256, sha256_of(file_text));
    assert.equal(legacy_extra_of_version(env, version("1")).path, "deliverables/item.pdf");

    // missing file: reported and listed in legacy_extra.missing_paths, no file link
    assert.deepEqual(files_of(env, version("2")), []);
    assert.ok(has_report(result.report, "missing_file", "deliverables/missing-item.pdf"));
    const missing = legacy_extra_of_version(env, version("2")).missing_paths;
    assert.ok(Array.isArray(missing) && missing.includes("deliverables/missing-item.pdf"), "missing_paths lists it");

    // unsafe references: no link, a neutral missing_file entry, never read
    for (const key of ["3", "4"]) assert.deepEqual(files_of(env, version(key)), [], `item ${key} has no file`);
    assert.ok(result.report.entries.filter((e) => e.category === "missing_file").length >= 3);
    for (const entry of result.report.entries) {
      assert.ok(!entry.path.startsWith("/"), `absolute path in report: ${entry.path}`);
      assert.ok(!entry.path.split(/[\\/]/).includes(".."), `parent-relative path in report: ${entry.path}`);
      assert.ok(!entry.path.includes("/Users/alice"), `user path in report: ${entry.path}`);
    }
    for (const row of mappings) assert.ok(!row.legacy_key.includes("/Users/alice") && !row.legacy_key.includes(".."));
    assert.equal(
      env.db.all("SELECT 1 FROM blobs WHERE sha256 = ?", sha256_of(outside_marker)).length,
      0,
      "the file outside the source folder was never stored",
    );
    assert.ok(!dump_db_text(env).includes(outside_marker));
  });
});

// ===========================================================================
// F5: rounds/<stage>-R<n>/qa.json and result files
// ===========================================================================

test("F5: qa.json becomes the round's review artifact with metadata.qa; a matching result links as source; others stay raw blobs and are reported", async () => {
  await with_legacy(async (env, api) => {
    const item1 = { id: 1, title: "matched item", kind: "topic", status: "new", summary: "s1" };
    const item2 = { id: 2, title: "second item", kind: "topic", status: "new", summary: "s2" };
    const qa = { round: 1, verdict: "pass", reviewer_note: "F5-QA-MARK" };
    const body = base_project("synthetic-final1-rounds", { current: "research" });
    (body.stages as Record<string, unknown>) = { research: { status: "active", round: 1, items: [item1, item2] } };
    const files = {
      "rounds/research-R1/qa.json": qa,
      "rounds/research-R1/1.json": item1, // the item record itself: hash matches
      "rounds/research-R1/2.json": { ...item2, title: "second item, as a result file said" }, // other content
      "rounds/research-R1/9.json": { id: 9, title: "no counterpart" }, // no item 9
    };
    const { pid, result, mappings } = await import_body(env, api, "f5", body, files);
    const round1 = rounds_of(env.db, stage_of(env.db, pid, "research").id)[0]!;

    // qa.json -> review artifact of that round, QA object kept whole in metadata.qa
    const reviews = env.db
      .all<{ metadata_json: string; created_in_round_id: string | null }>(
        `SELECT av.metadata_json AS metadata_json, ov.created_in_round_id AS created_in_round_id
           FROM artifact_versions av
           JOIN artifacts a ON a.object_id = av.object_id
           JOIN object_versions ov ON ov.id = av.version_id
          WHERE a.project_id = ? AND a.kind = 'review' AND av.metadata_json LIKE '%F5-QA-MARK%'`,
        pid,
      )
      .filter((row) => JSON.stringify(json_of(row.metadata_json).qa) === JSON.stringify(qa));
    assert.equal(reviews.length, 1, "exactly one review artifact version carries metadata.qa = qa.json");
    assert.equal(reviews[0]!.created_in_round_id, round1.id, "it belongs to research round 1");
    assert.ok(!has_report(result.report, "unmapped_input", "rounds/research-R1/qa.json"), "qa.json is mapped");

    // the matching result is linked as source to the item version
    const v1 = item_version_rows(env, mappings, "research", "1")[0]!.new_version_id!;
    const source = files_of(env, v1).filter((f) => f.role === "source");
    assert.equal(source.length, 1);
    assert.equal(source[0]!.sha256, sha256_of(JSON.stringify(item1)));
    assert.ok(!has_report(result.report, "unmapped_input", "rounds/research-R1/1.json"));

    // the others: raw blob kept, no source link, reported, no new versions or objects invented
    for (const [name, content] of [
      ["2.json", files["rounds/research-R1/2.json"]],
      ["9.json", files["rounds/research-R1/9.json"]],
    ] as const) {
      const path = `rounds/research-R1/${name}`;
      assert.equal(env.db.all("SELECT 1 FROM blobs WHERE project_id = ? AND sha256 = ?", pid, sha256_of(JSON.stringify(content))).length, 1, `${path} is kept as a blob`);
      assert.ok(has_report(result.report, "unmapped_input", path), `${path} is reported as unmapped_input`);
      assert.equal(env.db.all("SELECT 1 FROM version_files WHERE project_id = ? AND role = 'source' AND blob_id IN (SELECT id FROM blobs WHERE sha256 = ?)", pid, sha256_of(JSON.stringify(content))).length, 0, `${path} is linked to no version`);
    }
    const v2 = item_version_rows(env, mappings, "research", "2");
    assert.equal(versions_of(env, v2[0]!.new_object_id!).length, 1, "item 2 got no extra version from its result file");
    assert.equal(env.db.all("SELECT 1 FROM artifact_versions WHERE project_id = ? AND title = 'no counterpart'", pid).length, 0);
  });
});

// ===========================================================================
// F6: unknown sub-fields of sources / user_links
// ===========================================================================

test("F6: unknown keys inside sources[] and user_links[] are kept in locator.legacy_extra and reported with their JSON pointer", async () => {
  await with_legacy(async (env, api) => {
    const body = base_project("synthetic-final1-source-extra");
    (body.stages as Record<string, unknown>).plan = {
      status: "active",
      round: 1,
      items: [
        {
          id: 1,
          title: "item with odd sources",
          kind: "rq",
          status: "new",
          sources: [
            {
              title: "src with extra",
              url: "https://example.invalid/x",
              method: "fetch",
              date: "2025-01-01",
              note: "n",
              orgId: "o",
              tblId: "t",
              custom_locator: "synthetic locator 42",
              nested_extra: { a: 1 },
            },
          ],
          user_links: [
            {
              url: "https://example.invalid/u",
              memo: "m",
              added: "2026-03-01",
              status: "todo",
              extra_user: "synthetic user extra",
            },
          ],
        },
      ],
    };
    const { pid, result } = await import_body(env, api, "f6", body);

    const locator_of = (sql: string, value: string): Record<string, unknown> => {
      const row = env.db.get<{ locator: string }>(sql, pid, value);
      assert.ok(row, `source version for ${value}`);
      return json_of(row.locator);
    };
    const src = locator_of("SELECT locator FROM source_versions WHERE project_id = ? AND title = ?", "src with extra");
    const src_extra = src.legacy_extra as Record<string, unknown>;
    assert.equal(src_extra.custom_locator, "synthetic locator 42");
    assert.deepEqual(src_extra.nested_extra, { a: 1 });

    const link = locator_of("SELECT locator FROM source_versions WHERE project_id = ? AND url = ?", "https://example.invalid/u");
    assert.equal((link.legacy_extra as Record<string, unknown>).extra_user, "synthetic user extra");

    const base = "/stages/plan/items/0";
    for (const key of [`${base}/sources/0/custom_locator`, `${base}/sources/0/nested_extra`, `${base}/user_links/0/extra_user`]) {
      assert.ok(has_report(result.report, "unknown_field", "project.json", key), `${key} is reported`);
    }
    // known keys are not reported as unknown
    for (const key of ["title", "url", "method", "date", "note", "orgId", "tblId"]) {
      assert.ok(!has_report(result.report, "unknown_field", "project.json", `${base}/sources/0/${key}`), `sources key ${key}`);
    }
    for (const key of ["url", "memo", "added", "status"]) {
      assert.ok(!has_report(result.report, "unknown_field", "project.json", `${base}/user_links/0/${key}`), `user_links key ${key}`);
    }
  });
});

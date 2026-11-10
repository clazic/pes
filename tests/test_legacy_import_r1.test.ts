// SEL-44 (stage 2 PR11) R1 correction / regression tests: legacy importer.
// Source: first review logs/SEL-44-r1-1.md and the leader's decisions (ledger "SEL-44 r1 CHANGES").
// Everything is synthetic and built in a temporary folder inside the test's isolated HOME; nothing
// here reads the real ~/.pes or ~/pes-projects. Each test names the review item it pins:
//
//   required 1  known keys (review, suggestions, reports_built, user_links, library.suggestions,
//               item.request, reuse, links) are mapped as migration-map rows 76-79, 87, 125, 128, 139,
//               140, 193 say, or reported - never silently lost
//   required 2  array elements that are not objects, and duplicate ids, are reported (unknown_field,
//               JSON pointer + raw value); of two items with one id only the first becomes an object
//   required 3  .pes-lock / .pes-port / .pes-server are never blobs (manifest path + sha256 only)
//   required 4  carry_over target = the stage AFTER the carrying stage; base = the carrying stage's item;
//               `from` stays as the old text; the last stage (publish) makes no row but keeps + reports it
//   required 5  default-filled values carry a mark (stage status, topic, question type/required/label/
//               allow_comment_as_answer) and placeholder / other / gap are kept in the report
//   advised 6   deeply nested JSON -> failed batch with parse_error, never a thrown RangeError
//   advised 7   volatile (.pes-*) and regenerable files do not change the fingerprint and are not blobs
//   advised 10  the same folder asked for by another owner is not answered with the first owner's result
//
// Where the map allows "mapped OR reported" (the leader's wording for required 1) a test accepts
// either, but a key that is neither mapped nor reported fails.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { open_tasks_for_round } from "../scripts/pes_core/editions.ts";
import { blob_row_must, disk_path, second_project } from "./helpers/blob_env.ts";
import {
  copy_fixture,
  edition_of,
  json_of,
  project_row,
  rounds_of,
  run_import,
  sha256_of,
  stage_of,
  tree_entries,
  tree_digest,
  with_legacy,
  type Env,
  type ImportResult,
  type LegacyApi,
  type MappingRow,
  type UnknownReport,
} from "./helpers/legacy_env.ts";

// ---------------------------------------------------------------------------
// helpers

const STAGE_ORDER = ["plan", "research", "analyze", "write", "verify", "publish"] as const;

let dir_counter = 0;

function new_source(env: Env, label: string): string {
  dir_counter += 1;
  const dir = join(env.home.root, `r1-${label}-${dir_counter}`);
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
    topic: "합성 R1 프로젝트",
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

/** A source folder whose project.json is `body` (stages may be overridden per test). */
async function import_body(
  env: Env,
  api: LegacyApi,
  label: string,
  body: Record<string, unknown>,
  files: Record<string, unknown> = {},
): Promise<{ dir: string; result: ImportResult; mappings: MappingRow[]; pid: string }> {
  const dir = new_source(env, label);
  write_file(dir, "project.json", body);
  for (const [rel, content] of Object.entries(files)) write_file(dir, rel, content);
  const result = await run_import(env, api, dir);
  assert.equal(result.state, "staging", `${label}: the import itself must not fail`);
  return { dir, result, mappings: api.map_legacy(env.db, result.batch_id), pid: result.project_id };
}

function item_row(mappings: MappingRow[], scope: string, key: string): MappingRow {
  const row = mappings.find((m) => m.legacy_kind === "item" && m.legacy_scope === scope && m.legacy_key === key);
  assert.ok(row?.new_object_id && row.new_version_id, `mapping for ${scope} item ${key}`);
  return row;
}

function legacy_extra_of(settings_json: string): Record<string, unknown> {
  const extra = json_of(settings_json).legacy_extra;
  assert.ok(extra !== null && typeof extra === "object", "a legacy_extra object exists");
  return extra as Record<string, unknown>;
}

/** Every column of every table (not the object-store bytes) as one text. */
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

/** Report entries about `pointer` (the pointer itself or anything below it) inside `path`. */
function reported_at(report: UnknownReport, path: string, pointer: string) {
  return report.entries.filter(
    (e) => e.path === path && typeof e.key === "string" && (e.key === pointer || e.key.startsWith(`${pointer}/`)),
  );
}

function entry_text(entry: { key?: string; detail?: unknown }): string {
  return JSON.stringify([entry.key ?? null, entry.detail ?? null]);
}

function count(env: Env, sql: string, ...params: string[]): number {
  return env.db.all(sql, ...params).length;
}

function text_mapped_as_question(env: Env, pid: string, needle: string): { state: string; origin: string } | undefined {
  const row = env.db.get<{ state: string; origin: string }>(
    `SELECT qv.state AS state, q.origin AS origin
       FROM question_versions qv JOIN questions q ON q.object_id = qv.object_id
      WHERE qv.project_id = ? AND qv.text LIKE ?`,
    pid,
    `%${needle}%`,
  );
  return row === undefined ? undefined : { ...row };
}

function text_mapped_as_message(env: Env, pid: string, needle: string): boolean {
  return count(env, "SELECT 1 FROM message_versions WHERE project_id = ? AND body_md LIKE ?", pid, `%${needle}%`) > 0;
}

// ===========================================================================
// required 1: known keys are mapped or reported
// ===========================================================================

test("R1 required 1a: stage review (summary + questions) is a review artifact and a review question set, or is reported", async () => {
  await with_legacy(async (env, api) => {
    const body = base_project("synthetic-r1-review");
    (body.stages as Record<string, unknown>).plan = {
      status: "active",
      round: 1,
      items: [],
      review: {
        round: 1,
        summary: "합성 점검 요약 RV-SUM",
        questions: [{ id: "rv1", label: "합성 점검 질문 RV-Q", type: "text", gap: { note: "합성 부족 RV-GAP" } }],
      },
    };
    const { result, pid } = await import_body(env, api, "review", body);

    const summary_mapped =
      count(
        env,
        `SELECT 1 FROM artifact_versions av JOIN artifacts a ON a.object_id = av.object_id
          WHERE av.project_id = ? AND a.kind = 'review' AND av.summary = ?`,
        pid,
        "합성 점검 요약 RV-SUM",
      ) > 0;
    const question_mapped =
      count(
        env,
        `SELECT 1 FROM question_set_members m
           JOIN question_sets s ON s.id = m.set_id AND s.project_id = m.project_id
           JOIN question_versions qv ON qv.version_id = m.question_version_id
          WHERE s.project_id = ? AND s.purpose = 'review' AND qv.text = ?`,
        pid,
        "합성 점검 질문 RV-Q",
      ) > 0;
    const reported = reported_at(result.report, "project.json", "/stages/plan/review").length > 0;
    assert.ok(summary_mapped || reported, "review.summary is a 'review' artifact summary (map row 77) or is reported");
    assert.ok(question_mapped || reported, "review.questions[] is a review question (map row 78) or is reported");
  });
});

test("R1 required 1b: stage suggestions ('[#id] question' and plain) and reports_built are mapped or reported", async () => {
  await with_legacy(async (env, api) => {
    const body = base_project("synthetic-r1-suggest");
    (body.stages as Record<string, unknown>).plan = {
      status: "active",
      round: 1,
      items: [],
      suggestions: ["[#q_scope] 합성 남은 질문 SG-Q", "합성 일반 제안 SG-MSG"],
      reports_built: "2026-03-01 10:00 RB-MARK",
    };
    const { result, pid } = await import_body(env, api, "suggest", body);

    const asked = text_mapped_as_question(env, pid, "합성 남은 질문 SG-Q");
    if (asked !== undefined) {
      assert.equal(asked.origin, "import", "a suggestion question is origin 'import' (map row 79)");
      assert.equal(asked.state, "deferred", "and deferred");
    }
    const suggestions_reported = reported_at(result.report, "project.json", "/stages/plan/suggestions").length > 0;
    assert.ok(asked !== undefined || suggestions_reported, "'[#id] question' suggestion is a question or is reported");
    assert.ok(
      text_mapped_as_message(env, pid, "합성 일반 제안 SG-MSG") || suggestions_reported,
      "a plain suggestion is a thread message or is reported",
    );

    const built_mapped =
      count(
        env,
        `SELECT 1 FROM artifact_versions
          WHERE project_id = ? AND (json_extract(metadata_json, '$.reports_built') = ?
                                 OR json_extract(metadata_json, '$.legacy_extra.reports_built') = ?)`,
        pid,
        "2026-03-01 10:00 RB-MARK",
        "2026-03-01 10:00 RB-MARK",
      ) > 0;
    assert.ok(
      built_mapped || reported_at(result.report, "project.json", "/stages/plan/reports_built").length > 0,
      "reports_built is kept on an artifact version (map row 87) or is reported",
    );
  });
});

test("R1 required 1c: item user_links become 'import' sources with memo / added / user_status in the locator, or are reported", async () => {
  await with_legacy(async (env, api) => {
    const body = base_project("synthetic-r1-userlinks");
    (body.stages as Record<string, unknown>).plan = {
      status: "active",
      round: 1,
      items: [
        {
          id: 1,
          title: "합성 링크 항목",
          kind: "rq",
          status: "new",
          user_links: [
            { url: "https://example.invalid/ul1", memo: "합성 메모 UL-MEMO", added: "2026-03-01", status: "done" },
            { url: "https://example.invalid/ul2", status: "failed" },
            { url: "https://example.invalid/ul3", status: "todo" },
          ],
        },
      ],
    };
    const { result, pid } = await import_body(env, api, "userlinks", body);
    const source = (url: string) =>
      env.db.get<{ method: string; verification_state: string; locator: string; title: string }>(
        "SELECT method, verification_state, locator, title FROM source_versions WHERE project_id = ? AND url = ?",
        pid,
        url,
      );
    const all = ["https://example.invalid/ul1", "https://example.invalid/ul2", "https://example.invalid/ul3"].map(source);
    if (all.every((s) => s !== undefined)) {
      for (const s of all) {
        assert.equal(s!.method, "import", "the method is 'import' (map row 140)");
        assert.notEqual(s!.verification_state, "verified", "a user's own link is never 'verified'");
        assert.notEqual(s!.title, "", "the NOT NULL title is filled");
      }
      assert.equal(all[0]!.verification_state, "unverified", "'done' (user confirmed) is still unverified as a source");
      assert.equal(all[1]!.verification_state, "unreachable", "'failed' -> unreachable");
      assert.equal(all[2]!.verification_state, "unverified", "'todo' -> unverified");
      const locator = json_of(all[0]!.locator);
      assert.equal(locator.memo, "합성 메모 UL-MEMO");
      assert.equal(locator.added, "2026-03-01");
      assert.equal(locator.user_status, "done");
    } else {
      assert.ok(
        reported_at(result.report, "project.json", "/stages/plan/items/0/user_links").length > 0,
        "user_links that are not mapped are reported",
      );
    }
  });
});

test("R1 required 1d: library.json suggestions are questions / messages or are reported", async () => {
  await with_legacy(async (env, api) => {
    const { result, pid } = await import_body(env, api, "libsug", base_project("synthetic-r1-libsug"), {
      "library.json": {
        source: "synthetic-source",
        imported: "2026-01-04 08:00",
        items: [],
        suggestions: ["[#q9] 합성 라이브러리 질문 LS-Q", "합성 라이브러리 제안 LS-MSG"],
      },
    });
    const reported = reported_at(result.report, "library.json", "/suggestions").length > 0;
    const asked = text_mapped_as_question(env, pid, "합성 라이브러리 질문 LS-Q");
    if (asked !== undefined) {
      assert.equal(asked.origin, "import");
      assert.equal(asked.state, "deferred");
    }
    assert.ok(asked !== undefined || reported, "a library suggestion question is mapped or reported (map row 193)");
    assert.ok(
      text_mapped_as_message(env, pid, "합성 라이브러리 제안 LS-MSG") || reported,
      "a plain library suggestion is a message or is reported",
    );
  });
});

test("R1 required 1e: item.request becomes a next_round_task follow-up (description = the request) or is reported", async () => {
  await with_legacy(async (env, api) => {
    const body = base_project("synthetic-r1-request");
    (body.stages as Record<string, unknown>).plan = {
      status: "active",
      round: 1,
      items: [{ id: 1, title: "합성 요청 항목", kind: "rq", status: "deepen", request: "합성 항목 요청 RQ-MARK" }],
    };
    const { result, pid } = await import_body(env, api, "request", body);
    const task = env.db.get<{ kind: string; state: string; target_stage_id: string | null }>(
      "SELECT kind, state, target_stage_id FROM followup_versions WHERE project_id = ? AND description = ?",
      pid,
      "합성 항목 요청 RQ-MARK",
    );
    if (task !== undefined) {
      assert.equal(task.kind, "next_round_task");
      assert.equal(task.state, "proposed", "no proof it was applied (map row 128)");
      assert.notEqual(task.target_stage_id, null, "the DDL needs a target stage for next_round_task");
    } else {
      assert.ok(
        reported_at(result.report, "project.json", "/stages/plan/items/0/request").length > 0,
        "without a follow-up the request is reported",
      );
    }
  });
});

test("R1 required 1f: reuse and links to items that exist become reuses / supports relations", async () => {
  await with_legacy(async (env, api) => {
    const body = base_project("synthetic-r1-relations");
    (body.stages as Record<string, unknown>).plan = {
      status: "active",
      round: 1,
      items: [
        { id: 1, title: "합성 재사용 항목", kind: "rq", status: "new", reuse: 5 },
        { id: 3, title: "합성 연결 항목", kind: "rq", status: "new", links: { research: [2], library: [5] } },
      ],
    };
    (body.stages as Record<string, unknown>).research = {
      status: "active",
      round: 1,
      items: [{ id: 2, title: "합성 조사 대상", kind: "topic", status: "new" }],
    };
    const { mappings, pid } = await import_body(env, api, "relations", body, {
      "library.json": {
        source: "synthetic-source",
        imported: "2026-01-04 08:00",
        items: [{ id: 5, title: "합성 참고 대상", kind: "topic", status: "done" }],
      },
    });
    const relation = (from: MappingRow, to: MappingRow, kind: string) =>
      count(
        env,
        "SELECT 1 FROM version_relations WHERE project_id = ? AND from_version_id = ? AND to_version_id = ? AND kind = ?",
        pid,
        from.new_version_id!,
        to.new_version_id!,
        kind,
      );
    const reuse_from = item_row(mappings, "plan", "1");
    const links_from = item_row(mappings, "plan", "3");
    const library_5 = item_row(mappings, "library", "5");
    const research_2 = item_row(mappings, "research", "2");
    assert.equal(relation(reuse_from, library_5, "reuses"), 1, "reuse: 5 -> reuses the library item 5 (map row 125)");
    assert.equal(relation(links_from, research_2, "supports"), 1, "links.research [2] -> supports research item 2 (map row 139)");
    assert.equal(relation(links_from, library_5, "supports"), 1, "links.library [5] -> supports library item 5");
    assert.equal(count(env, "SELECT 1 FROM version_relations WHERE project_id = ?", pid), 3, "no other relation is made up");
  });
});

test("R1 required 1g: reuse / links to items that do not exist make no relation and are reported", async () => {
  await with_legacy(async (env, api) => {
    const body = base_project("synthetic-r1-dangling");
    (body.stages as Record<string, unknown>).plan = {
      status: "active",
      round: 1,
      items: [
        { id: 1, title: "합성 끊긴 재사용", kind: "rq", status: "new", reuse: 99 },
        { id: 2, title: "합성 끊긴 연결", kind: "rq", status: "new", links: { research: [77], nowhere: [1] } },
      ],
    };
    const { result, pid } = await import_body(env, api, "dangling", body);
    assert.equal(count(env, "SELECT 1 FROM version_relations WHERE project_id = ?", pid), 0, "no relation without a target");
    assert.ok(
      reported_at(result.report, "project.json", "/stages/plan/items/0/reuse").length > 0,
      "the unresolved reuse is reported with its pointer",
    );
    assert.ok(
      reported_at(result.report, "project.json", "/stages/plan/items/1/links").length > 0,
      "the unresolved links are reported with their pointer",
    );
  });
});

// ===========================================================================
// required 2: nothing odd is dropped silently
// ===========================================================================

test("R1 required 2a: array elements that are not objects are reported (unknown_field, JSON pointer, raw value) and the rest still imports", async () => {
  await with_legacy(async (env, api) => {
    const body = base_project("synthetic-r1-nonobject", {
      notes: [5, "합성잘못메모7", { time: "2026-03-01 09:00", stage: "plan", text: "합성 정상 메모" }],
    });
    (body.stages as Record<string, unknown>).plan = {
      status: "active",
      round: 1,
      items: [
        "합성잘못원소1",
        {
          id: 1,
          title: "합성 정상 항목",
          kind: "rq",
          status: "new",
          sources: ["합성잘못출처2", { title: "합성 정상 출처", url: "https://example.invalid/ok", method: "fetch" }],
        },
        7,
      ],
      carry_over: ["합성잘못남음3"],
      reports: ["합성잘못보고4"],
      qa: ["합성잘못QA5"],
      review_log: ["합성잘못로그6"],
    };
    const { result, mappings, pid } = await import_body(env, api, "nonobject", body);

    const expect_reported = (pointer: string, marker: string | null) => {
      const entry = result.report.entries.find(
        (e) => e.category === "unknown_field" && e.path === "project.json" && e.key === pointer,
      );
      assert.ok(entry, `${pointer} is reported as unknown_field`);
      assert.notEqual(entry.detail, undefined, `${pointer} keeps the raw value`);
      if (marker !== null) assert.ok(entry_text(entry).includes(marker), `${pointer} detail has the raw text`);
    };
    expect_reported("/stages/plan/items/0", "합성잘못원소1");
    expect_reported("/stages/plan/items/2", null);
    expect_reported("/stages/plan/items/1/sources/0", "합성잘못출처2");
    expect_reported("/stages/plan/carry_over/0", "합성잘못남음3");
    expect_reported("/stages/plan/reports/0", "합성잘못보고4");
    expect_reported("/stages/plan/qa/0", "합성잘못QA5");
    expect_reported("/stages/plan/review_log/0", "합성잘못로그6");
    expect_reported("/notes/0", null);
    expect_reported("/notes/1", "합성잘못메모7");

    // the well-formed neighbours are still imported
    item_row(mappings, "plan", "1");
    assert.equal(count(env, "SELECT 1 FROM source_versions WHERE project_id = ? AND title = ?", pid, "합성 정상 출처"), 1);
    assert.equal(count(env, "SELECT 1 FROM artifact_versions WHERE project_id = ? AND body_md = ?", pid, "합성 정상 메모"), 1);
  });
});

test("R1 required 2b: two items with one id -> only the first becomes an object; the second is reported with its raw content", async () => {
  await with_legacy(async (env, api) => {
    const body = base_project("synthetic-r1-dupid");
    (body.stages as Record<string, unknown>).plan = {
      status: "active",
      round: 1,
      items: [
        { id: 1, title: "합성첫째 DUP-FIRST", kind: "rq", status: "new", summary: "첫째 요약" },
        { id: 1, title: "합성둘째 DUP-SECOND", kind: "rq", status: "new", summary: "둘째 요약" },
        { id: 2, title: "합성 셋째", kind: "rq", status: "new" },
      ],
    };
    const { result, mappings, pid } = await import_body(env, api, "dupid", body);
    const plan_items = mappings.filter((m) => m.legacy_kind === "item" && m.legacy_scope === "plan");
    assert.deepEqual(plan_items.map((m) => m.legacy_key).sort(), ["1", "2"], "one object per distinct id");
    const first = item_row(mappings, "plan", "1");
    const title = env.db.get<{ title: string }>("SELECT title FROM artifact_versions WHERE version_id = ?", first.new_version_id!);
    assert.equal(title?.title, "합성첫째 DUP-FIRST", "the first one wins");
    assert.equal(
      count(env, "SELECT 1 FROM artifact_versions WHERE project_id = ? AND title LIKE '%DUP-SECOND%'", pid),
      0,
      "the second is not an object",
    );
    const entry = result.report.entries.find(
      (e) => e.category === "unknown_field" && e.path === "project.json" && e.key === "/stages/plan/items/1",
    );
    assert.ok(entry, "the duplicate is reported at its pointer");
    assert.ok(entry_text(entry).includes("합성둘째 DUP-SECOND"), "with its raw content");
  });
});

// ===========================================================================
// required 3: volatile files are never blobs
// ===========================================================================

const VOLATILE_FILES: Array<[string, string]> = [
  [".pes-lock", '{"owner":"synthetic-session-ABC123","at":1760000000,"since":1760000000}'],
  [".pes-port", "PORT-MARK-8765"],
  [".pes-server", '{"pid":4242,"note":"SERVER-MARK"}'],
];

test("R1 required 3: .pes-lock, .pes-port and .pes-server have no blob row, no mapping and no bytes in the object store; the manifest lists path + sha256", async () => {
  await with_legacy(async (env, api) => {
    const dir = copy_fixture(env, "full");
    for (const [name, body] of VOLATILE_FILES) writeFileSync(join(dir, name), body, "utf8");
    const result = await run_import(env, api, dir);
    const batch = env.db.get<{ source_manifest_blob_id: string }>(
      "SELECT source_manifest_blob_id FROM import_batches WHERE id = ?",
      result.batch_id,
    );
    const manifest_row = blob_row_must(env.db, batch!.source_manifest_blob_id);
    const manifest = new TextDecoder().decode(readFileSync(disk_path(env, manifest_row)));

    const mappings = api.map_legacy(env.db, result.batch_id);
    for (const [name, body] of VOLATILE_FILES) {
      const sha = sha256_of(body);
      assert.equal(
        count(env, "SELECT 1 FROM blobs WHERE project_id = ? AND sha256 = ?", result.project_id, sha),
        0,
        `${name} is not a blob`,
      );
      assert.ok(manifest.includes(name) && manifest.includes(sha), `${name}: path and sha256 are in the manifest`);
      assert.ok(!mappings.some((m) => m.legacy_key === name), `${name} has no legacy_mappings row`);
    }
    // the session identifier inside .pes-lock is nowhere: not in a blob's bytes, not in a table, not in the report
    const every_blob = env.db.all<{ id: string }>("SELECT id FROM blobs WHERE project_id = ?", result.project_id);
    for (const { id } of every_blob) {
      const bytes = Buffer.from(readFileSync(disk_path(env, blob_row_must(env.db, id)))).toString("latin1");
      for (const marker of ["synthetic-session-ABC123", "PORT-MARK-8765", "SERVER-MARK"]) {
        assert.ok(!bytes.includes(marker), `blob ${id} does not carry ${marker}`);
      }
    }
    const tables = dump_db_text(env);
    const report_text = JSON.stringify(result.report);
    for (const marker of ["synthetic-session-ABC123", "PORT-MARK-8765", "SERVER-MARK"]) {
      assert.ok(!tables.includes(marker), `no table carries ${marker}`);
      assert.ok(!report_text.includes(marker), `the report does not carry ${marker}`);
    }
  });
});

// ===========================================================================
// required 4: carry_over target = the stage after the carrying stage
// ===========================================================================

function followups_of(env: Env, pid: string) {
  return env.db
    .all<{
      description: string;
      state: string;
      kind: string;
      target_stage_id: string | null;
      target_round_id: string | null;
      base_artifact_version_id: string | null;
    }>(
      `SELECT description, state, kind, target_stage_id, target_round_id, base_artifact_version_id
         FROM followup_versions WHERE project_id = ? ORDER BY description`,
      pid,
    )
    .map((r) => ({ ...r }));
}

test("R1 required 4a: every stage's carry_over targets the stage after it, whatever `from` says; the base is the carrying stage's item", async () => {
  await with_legacy(async (env, api) => {
    const body = base_project("synthetic-r1-carry-chain", { current: "plan" });
    const stages: Record<string, unknown> = {};
    // `from` is deliberately wrong/odd on purpose: it must not decide the target
    const odd_from: Record<string, unknown> = {
      plan: "plan",
      research: "plan",
      analyze: "publish",
      write: "합성출발값-WRITE",
      verify: undefined,
    };
    for (const key of STAGE_ORDER.slice(0, 5)) {
      const entry: Record<string, unknown> = { item: 1, title: `합성 ${key} 항목`, request: `합성 남은 일 CO-${key}` };
      if (odd_from[key] !== undefined) entry.from = odd_from[key];
      stages[key] = {
        status: "active",
        round: 1,
        items: [{ id: 1, title: `합성 ${key} 항목`, kind: "rq", status: "new" }],
        carry_over: [entry],
      };
    }
    stages.publish = { status: "pending", round: 0 };
    body.stages = stages;
    const { pid, mappings } = await import_body(env, api, "carry-chain", body);

    const rows = followups_of(env, pid);
    assert.equal(rows.length, 5, "one follow-up per carry_over entry of a stage that has a next stage");
    for (let i = 0; i < 5; i += 1) {
      const carrier = STAGE_ORDER[i]!;
      const next = STAGE_ORDER[i + 1]!;
      const row = rows.find((r) => r.description === `합성 남은 일 CO-${carrier}`);
      assert.ok(row, `${carrier}'s entry is a follow-up`);
      assert.equal(row.kind, "next_round_task");
      assert.equal(row.state, "proposed");
      assert.equal(row.target_round_id, null, "no fixed round: it shows in every round of the target stage");
      assert.equal(row.target_stage_id, stage_of(env.db, pid, next).id, `${carrier} -> ${next}`);
      assert.equal(row.base_artifact_version_id, item_row(mappings, carrier, "1").new_version_id, "base = the carrying stage's item");
    }
    // the old text of `from` is kept (it is only no longer the target)
    assert.ok(dump_db_text(env).includes("합성출발값-WRITE"), "the old `from` text is kept in legacy_extra");
  });
});

test("R1 required 4b: a research carry_over (even with from: 'plan') is visible in analyze R1 via open_tasks_for_round and not in research", async () => {
  await with_legacy(async (env, api) => {
    const body = base_project("synthetic-r1-carry-visible", { current: "research" });
    body.stages = {
      plan: { status: "approved", round: 1, approved_at: "2026-03-02 10:00", items: [] },
      research: {
        status: "active",
        round: 1,
        items: [{ id: 1, title: "합성 조사 항목", kind: "topic", status: "new" }],
        carry_over: [{ item: 1, title: "합성 조사 항목", request: "합성 분석에서 먼저 처리 CO-VIS", from: "plan" }],
      },
      analyze: { status: "pending", round: 1, items: [] },
    };
    const { pid } = await import_body(env, api, "carry-visible", body);
    const analyze_rounds = rounds_of(env.db, stage_of(env.db, pid, "analyze").id);
    assert.equal(analyze_rounds.length, 1);
    assert.deepEqual(
      open_tasks_for_round(env.db, pid, analyze_rounds[0]!.id).map((t) => t.description),
      ["합성 분석에서 먼저 처리 CO-VIS"],
      "the task is the first thing analyze R1 must handle",
    );
    for (const key of ["plan", "research"]) {
      for (const round of rounds_of(env.db, stage_of(env.db, pid, key).id)) {
        assert.deepEqual(open_tasks_for_round(env.db, pid, round.id), [], `not a task of ${key}`);
      }
    }
  });
});

test("R1 required 4c: a carry_over held by publish has no next stage -> no follow-up row, but it is kept and reported", async () => {
  await with_legacy(async (env, api) => {
    const body = base_project("synthetic-r1-carry-publish", { current: "publish" });
    body.stages = {
      publish: {
        status: "active",
        round: 1,
        items: [{ id: 1, title: "합성 산출 항목", kind: "output", status: "new" }],
        carry_over: [{ item: 1, title: "합성 산출 항목", request: "합성 마지막 남은 일 CO-PUB", from: "verify" }],
      },
    };
    const { result, pid } = await import_body(env, api, "carry-publish", body);
    assert.equal(followups_of(env, pid).length, 0, "no row without a next stage (DDL needs a target)");
    assert.ok(
      reported_at(result.report, "project.json", "/stages/publish/carry_over").length > 0,
      "the unplaceable entry is reported at its pointer",
    );
    assert.ok(
      result.report.entries.some((e) => entry_text(e).includes("합성 마지막 남은 일 CO-PUB")) ||
        stage_of(env.db, pid, "publish").settings_json.includes("합성 마지막 남은 일 CO-PUB"),
      "and its raw text is in the report or in the stage's legacy_extra",
    );
    assert.ok(dump_db_text(env).includes("합성 마지막 남은 일 CO-PUB") || JSON.stringify(result.report).includes("CO-PUB"));
  });
});

// ===========================================================================
// required 5: default-filled values are marked
// ===========================================================================

test("R1 required 5a: an unknown stage status becomes pending AND carries legacy_unverified (the original stays)", async () => {
  await with_legacy(async (env, api) => {
    for (const status of ["weird", "done", "APPROVED", 1, true, null]) {
      const body = base_project(`synthetic-r1-status-${dir_counter + 1}`);
      (body.stages as Record<string, unknown>).plan = { status, round: 1, items: [] };
      const { pid } = await import_body(env, api, "status", body);
      const stage = stage_of(env.db, pid, "plan");
      assert.equal(stage.status, "pending", `status ${JSON.stringify(status)}`);
      const extra = legacy_extra_of(stage.settings_json);
      assert.deepEqual(extra.status_original, status);
      assert.equal(extra.legacy_unverified, true, `status ${JSON.stringify(status)} is marked legacy_unverified`);
    }
  });
});

test("R1 required 5b: a normal stage status is not marked unverified", async () => {
  await with_legacy(async (env, api) => {
    const body = base_project("synthetic-r1-status-ok");
    (body.stages as Record<string, unknown>).plan = { status: "active", round: 1, items: [] };
    const { pid } = await import_body(env, api, "status-ok", body);
    const settings = json_of(stage_of(env.db, pid, "plan").settings_json);
    const extra = (settings.legacy_extra ?? {}) as Record<string, unknown>;
    assert.notEqual(extra.legacy_unverified, true);
  });
});

test("R1 required 5c: a missing / empty / blank / non-text topic becomes '(주제 없음)' with legacy_unverified and a report entry; a real topic does not", async () => {
  await with_legacy(async (env, api) => {
    for (const topic of [undefined, "", "   ", null, 42, { t: 1 }]) {
      const body = base_project(`synthetic-r1-topic-${dir_counter + 1}`);
      if (topic === undefined) delete body.topic;
      else body.topic = topic;
      const { result, pid } = await import_body(env, api, "topic", body);
      assert.equal(project_row(env.db, pid).topic, "(주제 없음)", `topic ${JSON.stringify(topic)}`);
      assert.equal(
        legacy_extra_of(edition_of(env.db, pid).settings_json).legacy_unverified,
        true,
        `topic ${JSON.stringify(topic)}: the sentinel is marked`,
      );
      assert.ok(
        result.report.entries.some((e) => e.path === "project.json" && e.key === "/topic"),
        `topic ${JSON.stringify(topic)}: reported at /topic`,
      );
    }
    const ok = await import_body(env, api, "topic-ok", base_project("synthetic-r1-topic-ok"));
    const ok_extra = (json_of(edition_of(env.db, ok.pid).settings_json).legacy_extra ?? {}) as Record<string, unknown>;
    assert.notEqual(ok_extra.legacy_unverified, true, "a real topic and a real created date raise no mark");
    assert.ok(!ok.result.report.entries.some((e) => e.path === "project.json" && e.key === "/topic"));
  });
});

test("R1 required 5d: question defaults (type / required / label / allow_comment_as_answer) are reported; placeholder, other and gap are kept in the report", async () => {
  await with_legacy(async (env, api) => {
    const ask = {
      id: "s1",
      kind: "stage_start",
      stage: "plan",
      round: 0,
      title: "합성 기본값 질문",
      inherited: [],
      questions: [
        { id: "qa1", placeholder: "합성 자리표시 PH-MARK", other: "합성 기타 안내 OT-MARK", gap: { note: "합성 부족 GAP-MARK" } },
        { id: "qa2", label: "합성 이상한 형식", type: "weird", required: true },
        { id: "qa3", label: "합성 정상 질문", type: "text", required: false },
      ],
    };
    const { result, mappings, pid } = await import_body(env, api, "askdefaults", base_project("synthetic-r1-askdefaults"), {
      "ask/s1.json": ask,
    });

    const has_default = (qid: string, idx: number, field: string) =>
      result.report.entries.some((e) => {
        if (e.category !== "default_filled" || e.path !== "ask/s1.json") return false;
        const text = entry_text(e);
        return text.includes(field) && (text.includes(qid) || new RegExp(`/questions/${idx}(/|"|$)`).test(text));
      });

    // values the old file did not give
    for (const field of ["label", "type", "required", "allow_comment_as_answer"]) {
      assert.ok(has_default("qa1", 0, field), `qa1: ${field} was default-filled and is reported`);
    }
    // an unusable value the old file did give
    assert.ok(has_default("qa2", 1, "type"), "qa2: type 'weird' became a default and is reported");
    // the old file never has allow_comment_as_answer, so every question got the default
    for (const [qid, idx] of [["qa2", 1], ["qa3", 2]] as const) {
      assert.ok(has_default(qid, idx, "allow_comment_as_answer"), `${qid}: allow_comment_as_answer default is reported`);
    }

    // the raw text of fields with no column is in the report
    const report_text = JSON.stringify(result.report.entries.filter((e) => e.path === "ask/s1.json"));
    for (const marker of ["PH-MARK", "OT-MARK", "GAP-MARK"]) {
      assert.ok(report_text.includes(marker), `${marker} is kept in the report`);
    }

    // the stored values are what the map says
    const q1 = mappings.find((m) => m.legacy_kind === "question" && m.legacy_key === "qa1");
    const v = env.db.get<{ text: string; type: string; required: bigint; allow_comment_as_answer: bigint }>(
      "SELECT text, type, required, allow_comment_as_answer FROM question_versions WHERE version_id = ?",
      q1!.new_version_id!,
    );
    assert.deepEqual(
      { text: v!.text, type: v!.type, required: Number(v!.required), allow: Number(v!.allow_comment_as_answer) },
      { text: "(질문 없음)", type: "text", required: 0, allow: 1 },
    );
    assert.ok(pid.length > 0);
  });
});

// ===========================================================================
// advised 6: deep nesting
// ===========================================================================

test("R1 advised 6: very deeply nested JSON gives a failed batch with parse_error, never a thrown error, and the source is unchanged", async () => {
  await with_legacy(async (env, api) => {
    const depth = 100_000;
    for (const where of ["settings", "verify"] as const) {
      const dir = new_source(env, `deep-${where}`);
      const nested = `${"[".repeat(depth)}${"]".repeat(depth)}`;
      const text =
        where === "settings"
          ? `{"pes":1,"topic":"합성 깊은 중첩","slug":"synthetic-r1-deep-settings","settings":{"a":${nested}},"stages":{}}`
          : `{"pes":1,"topic":"합성 깊은 중첩","slug":"synthetic-r1-deep-verify","stages":{"plan":{"status":"active","round":1,"items":[{"id":1,"title":"t","kind":"rq","status":"new","verify":${nested}}]}}}`;
      write_file(dir, "project.json", text);
      const before = tree_digest(dir);
      const result = await run_import(env, api, dir); // must not throw
      assert.equal(result.state, "failed", `${where}: the batch is failed`);
      assert.ok(
        result.report.entries.some((e) => e.category === "parse_error" && e.path === "project.json"),
        `${where}: parse_error for project.json`,
      );
      assert.equal(tree_digest(dir), before, "the source is untouched");
      assert.deepEqual(
        api.report_unknown(env.db, result.batch_id).entries,
        result.report.entries,
        "the stored report is the same",
      );
    }
  });
});

// ===========================================================================
// advised 7: volatile and regenerable files are outside the fingerprint and outside the blobs
// ===========================================================================

const REGENERATED_FILES = [
  ".pes-lock",
  "index.html",
  "ask-plan-start.html",
  "reports/plan/report.html",
  "reports/plan/report.md",
  "reports/plan/eli5.html",
  "out/report.html",
];

test("R1 advised 7a: changing or adding .pes-* and regenerated files keeps the fingerprint, and the re-import is a replay", async () => {
  await with_legacy(async (env, api) => {
    const dir = copy_fixture(env, "full");
    const base = api.scan_project(dir).fingerprint;
    const first = await run_import(env, api, dir);
    assert.equal(first.source_fingerprint, base);

    for (const rel of REGENERATED_FILES) writeFileSync(join(dir, rel), `changed ${rel} ${"x".repeat(7)}`, "utf8");
    writeFileSync(join(dir, ".pes-port"), "8761", "utf8");
    writeFileSync(join(dir, ".pes-server"), '{"pid":1}', "utf8");
    assert.equal(api.scan_project(dir).fingerprint, base, "volatile and regenerated files are not part of the identity");
    // they are still listed (manifest) - only the identity ignores them
    const listed = api.scan_project(dir).files.map((f) => f.path);
    for (const rel of [".pes-lock", ".pes-port", ".pes-server", "index.html"]) assert.ok(listed.includes(rel), `${rel} stays in the file list`);

    const second = await run_import(env, api, dir);
    assert.equal(second.replayed, true);
    assert.equal(second.batch_id, first.batch_id);

    // a real change still changes it
    writeFileSync(join(dir, "out/cover.json"), '{"authors":"다른 연구진 R1"}', "utf8");
    assert.notEqual(api.scan_project(dir).fingerprint, base);
  });
});

test("R1 advised 7b: regenerated files are not blobs (manifest hash only)", async () => {
  await with_legacy(async (env, api) => {
    const dir = copy_fixture(env, "full");
    const entries = tree_entries(dir);
    const result = await run_import(env, api, dir);
    const shared_with_kept = new Set(entries.filter((e) => !REGENERATED_FILES.includes(e.path)).map((e) => e.sha256));
    for (const rel of REGENERATED_FILES) {
      const entry = entries.find((e) => e.path === rel);
      assert.ok(entry, `${rel} exists in the fixture`);
      if (shared_with_kept.has(entry.sha256)) continue; // same bytes as a kept file: a blob row may exist for that one
      assert.equal(
        count(env, "SELECT 1 FROM blobs WHERE project_id = ? AND sha256 = ?", result.project_id, entry.sha256),
        0,
        `${rel} is not a blob`,
      );
    }
    // and the files that ARE kept are still stored byte-for-byte
    for (const rel of ["out/cover.json", "reports/plan/report.pdf", "shots/shot-1.png"]) {
      const entry = entries.find((e) => e.path === rel)!;
      assert.equal(
        count(env, "SELECT 1 FROM blobs WHERE project_id = ? AND sha256 = ? AND state = 'ready'", result.project_id, entry.sha256),
        1,
        `${rel} is a ready blob`,
      );
    }
  });
});

// ===========================================================================
// advised 10: another owner is not answered with the first owner's result
// ===========================================================================

test("R1 advised 10: the same folder asked for by another owner does not replay the first owner's batch or project", async () => {
  await with_legacy(async (env, api) => {
    const dir = copy_fixture(env, "full");
    const first = await run_import(env, api, dir);
    const owner_one = project_row(env.db, first.project_id).owner_user_id;
    const members_before = count(env, "SELECT 1 FROM project_members WHERE project_id = ?", first.project_id);
    const counts_before = count(env, "SELECT 1 FROM import_batches");

    const other = await second_project(env, "synthetic-r1-owner-two");
    const other_user = env.db.get<{ user_id: string | null }>("SELECT user_id FROM actors WHERE id = ?", other.actor_id);
    assert.ok(other_user?.user_id && other_user.user_id !== owner_one, "a really different human owner");

    let second: ImportResult | undefined;
    try {
      second = await api.import_project(env.service, dir, { owner_actor_id: other.actor_id });
    } catch {
      second = undefined; // refusing is a correct answer
    }
    if (second !== undefined) {
      assert.notEqual(second.project_id, first.project_id, "the first owner's project is not handed out");
      assert.notEqual(second.batch_id, first.batch_id, "nor the first owner's batch");
      assert.equal(project_row(env.db, second.project_id).owner_user_id, other_user.user_id, "whatever is returned belongs to the asker");
    }
    // the first owner's project is untouched
    assert.equal(project_row(env.db, first.project_id).owner_user_id, owner_one);
    assert.equal(count(env, "SELECT 1 FROM project_members WHERE project_id = ?", first.project_id), members_before);
    assert.ok(count(env, "SELECT 1 FROM import_batches") >= counts_before);

    // the first owner still gets the replay
    const again = await run_import(env, api, dir);
    assert.equal(again.replayed, true);
    assert.equal(again.batch_id, first.batch_id);
  });
});

// SEL-44 (stage 2 PR11): legacy importer, content mapping (items, sources, notes, stages, rounds,
// questions, answers). Interface and interpretations: see the header of test_legacy_import.test.ts.
// Written before the implementation; migration-map.md (sections 2-6) is the contract, and where it is
// silent the choice is stated in the test.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { blob_row_must, disk_path } from "./helpers/blob_env.ts";
import {
  copy_fixture,
  edition_of,
  json_of,
  mappings_of,
  rounds_of,
  run_import,
  sha256_of,
  stage_of,
  tree_entries,
  with_legacy,
  type LegacyApi,
  type MappingRow,
} from "./helpers/legacy_env.ts";
import type { Env } from "./helpers/legacy_env.ts";

async function imported(env: Env, api: LegacyApi) {
  const dir = copy_fixture(env, "full");
  const result = await run_import(env, api, dir);
  const mappings = api.map_legacy(env.db, result.batch_id);
  return { dir, result, mappings, pid: result.project_id };
}

function item_of(mappings: MappingRow[], scope: string, key: string): MappingRow {
  const row = mappings.find((m) => m.legacy_kind === "item" && m.legacy_scope === scope && m.legacy_key === key);
  assert.ok(row, `mapping for ${scope} item ${key}`);
  assert.ok(row.new_object_id && row.new_version_id, "an item maps to an object and a version");
  return row;
}

function version_of(env: Env, version_id: string) {
  const row = env.db.get<{
    kind: string;
    title: string;
    summary: string;
    body_md: string | null;
    status: string;
    confidence: string | null;
    metadata_json: string;
    object_id: string;
  }>(
    `SELECT a.kind AS kind, av.title, av.summary, av.body_md, av.status, av.confidence, av.metadata_json, av.object_id
       FROM artifact_versions av JOIN artifacts a ON a.object_id = av.object_id WHERE av.version_id = ?`,
    version_id,
  );
  assert.ok(row, "the artifact version exists");
  return { ...row };
}

function extra_of(metadata_json: string): Record<string, unknown> {
  const extra = json_of(metadata_json).legacy_extra;
  assert.ok(extra && typeof extra === "object", "metadata_json.legacy_extra exists");
  return extra as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// items

test("every old item becomes its own object; the old id is a mapping, not a number reused", async () => {
  await with_legacy(async (env, api) => {
    const { mappings } = await imported(env, api);
    const counts: Record<string, number> = {};
    for (const m of mappings_of(mappings, "item")) counts[m.legacy_scope] = (counts[m.legacy_scope] ?? 0) + 1;
    assert.deepEqual(counts, { plan: 2, research: 2, analyze: 1, library: 2 });

    // item #1 exists in both plan and research: two different objects
    const a = item_of(mappings, "plan", "1");
    const b = item_of(mappings, "research", "1");
    assert.notEqual(a.new_object_id, b.new_object_id);

    const plan1 = version_of(env, a.new_version_id!);
    assert.equal(plan1.kind, "rq");
    assert.equal(plan1.title, "합성 항목 하나");
    assert.equal(plan1.summary, "합성 요약 1");
    assert.equal(plan1.body_md, "합성 본문 1");
    assert.equal(plan1.status, "done");
    assert.equal(plan1.confidence, "high");
    assert.equal(extra_of(plan1.metadata_json).legacy_id, 1, "the old number is kept in legacy_extra");
    assert.equal(extra_of(plan1.metadata_json).weird_item_key, "x", "an unknown item key is kept, not dropped");
  });
});

test("an unknown kind is kept as a neutral note, an empty confidence stays NULL", async () => {
  await with_legacy(async (env, api) => {
    const { mappings } = await imported(env, api);
    const plan2 = version_of(env, item_of(mappings, "plan", "2").new_version_id!);
    assert.equal(plan2.kind, "note", "no meaning is guessed for 'alien'");
    const extra = extra_of(plan2.metadata_json);
    assert.equal(extra.kind_original, "alien");
    assert.equal(extra.legacy_unverified, true);
    assert.equal(plan2.confidence, null, "'' is NULL, not 'medium'");
    assert.equal(plan2.status, "deepen");
    assert.equal(plan2.summary, "");
  });
});

test("removed items are kept (status removed + archived), project items before library items alike", async () => {
  await with_legacy(async (env, api) => {
    const { mappings } = await imported(env, api);
    for (const [scope, key] of [["research", "2"], ["library", "2"]] as const) {
      const row = item_of(mappings, scope, key);
      assert.equal(version_of(env, row.new_version_id!).status, "removed");
      const obj = env.db.get<{ archived_at: bigint | null }>("SELECT archived_at FROM objects WHERE id = ?", row.new_object_id!);
      assert.ok(obj && obj.archived_at !== null, `${scope} #${key} is archived, not deleted`);
    }
  });
});

test("library items belong to the project, not to the edition", async () => {
  await with_legacy(async (env, api) => {
    const { mappings } = await imported(env, api);
    const lib = item_of(mappings, "library", "1");
    const row = env.db.get<{ edition_id: string | null }>("SELECT edition_id FROM objects WHERE id = ?", lib.new_object_id!);
    assert.equal(row?.edition_id, null);
    const plan = item_of(mappings, "plan", "1");
    const edition = env.db.get<{ edition_id: string | null }>("SELECT edition_id FROM objects WHERE id = ?", plan.new_object_id!);
    assert.notEqual(edition?.edition_id, null);
    assert.equal(version_of(env, lib.new_version_id!).title, "합성 참고 하나");
  });
});

// ---------------------------------------------------------------------------
// sources

test("two sources with the same URL stay two sources, in citation order, never verified", async () => {
  await with_legacy(async (env, api) => {
    const { mappings, pid } = await imported(env, api);
    const plan1 = item_of(mappings, "plan", "1");
    const sources = env.db.all<{ object_id: string; url: string | null; method: string; verification_state: string; title: string; locator: string }>(
      "SELECT object_id, url, method, verification_state, title, locator FROM source_versions WHERE project_id = ? AND url = 'https://example.invalid/a' ORDER BY title",
      pid,
    ).map((r) => ({ ...r }));
    assert.equal(sources.length, 2, "the same URL is not merged");
    assert.notEqual(sources[0]!.object_id, sources[1]!.object_id);
    assert.deepEqual(sources.map((s) => s.method).sort(), ["fetch", "search"]);
    for (const s of env.db.all<{ verification_state: string }>("SELECT verification_state FROM source_versions WHERE project_id = ?", pid)) {
      assert.equal(s.verification_state, "legacy_unknown", "an old source is not 'verified'");
    }
    const first = sources.find((s) => s.title === "합성 출처 A")!;
    assert.equal(json_of(first.locator).date, "2025-12-01", "the reference date is kept in the locator, not as retrieval time");

    const citations = env.db.all<{ citation_no: bigint; title: string }>(
      `SELECT c.citation_no, sv.title FROM citations c JOIN source_versions sv ON sv.version_id = c.source_version_id
        WHERE c.artifact_version_id = ? ORDER BY c.citation_no`,
      plan1.new_version_id!,
    ).map((r) => ({ no: Number(r.citation_no), title: r.title }));
    assert.deepEqual(citations, [
      { no: 1, title: "합성 출처 A" },
      { no: 2, title: "합성 출처 A 복제" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// project.json top level

test("notes, the executive summary, and unknown top-level keys are kept", async () => {
  await with_legacy(async (env, api) => {
    const { pid } = await imported(env, api);
    const note = env.db.get<{ body_md: string | null; stage_id: string | null }>(
      `SELECT av.body_md, a.stage_id FROM artifact_versions av JOIN artifacts a ON a.object_id = av.object_id
        WHERE av.project_id = ? AND a.kind = 'note' AND av.body_md = '합성 메모 하나'`,
      pid,
    );
    assert.ok(note, "the memo is a note artifact");
    assert.equal(note.stage_id, stage_of(env.db, pid, "plan").id);

    const report = env.db.get<{ summary: string }>(
      `SELECT av.summary FROM artifact_versions av JOIN artifacts a ON a.object_id = av.object_id
        WHERE av.project_id = ? AND a.kind = 'report' AND av.summary = '합성 요약문'`,
      pid,
    );
    assert.ok(report, "executive_summary lives on a report version");

    const extra = json_of(edition_of(env.db, pid).settings_json).legacy_extra as Record<string, unknown>;
    assert.deepEqual(extra.unknown_top, { x: 1 });
    assert.equal(extra.pes, 1, "pes: 1 is kept as a plain value, not as a compatibility proof");
  });
});

test("a settings value the importer does not know is kept in place", async () => {
  await with_legacy(async (env, api) => {
    const { pid } = await imported(env, api);
    const settings = json_of(edition_of(env.db, pid).settings_json);
    assert.deepEqual(settings.mystery_setting, { a: 1 }, "settings stay as written");
    assert.equal(settings.depth, "standard");
  });
});

// ---------------------------------------------------------------------------
// stages and rounds

test("stages keep their status; six rows always; unknown stage keys go to legacy_extra", async () => {
  await with_legacy(async (env, api) => {
    const { pid } = await imported(env, api);
    const keys = env.db.all<{ key: string; status: string }>(
      "SELECT key, status FROM stages WHERE project_id = ? ORDER BY ordinal",
      pid,
    ).map((r) => [r.key, r.status]);
    assert.deepEqual(keys, [
      ["plan", "approved"],
      ["research", "active"],
      ["analyze", "active"],
      ["write", "pending"],
      ["verify", "pending"],
      ["publish", "pending"],
    ]);
    const plan = stage_of(env.db, pid, "plan");
    assert.equal((json_of(plan.settings_json).legacy_extra as Record<string, unknown>).mystery_stage_key, 7);
  });
});

test("rounds: past rounds are sealed, the current one is open, a missing/damaged snapshot is marked", async () => {
  await with_legacy(async (env, api) => {
    const { pid, dir } = await imported(env, api);
    const plan = stage_of(env.db, pid, "plan");
    const plan_rounds = rounds_of(env.db, plan.id);
    assert.deepEqual(plan_rounds.map((r) => [Number(r.round_no), r.state]), [[1, "sealed"]]);
    assert.equal(plan.current_round_id, null, "an approved stage with only a sealed round has no open round");

    const research = stage_of(env.db, pid, "research");
    assert.deepEqual(rounds_of(env.db, research.id).map((r) => [Number(r.round_no), r.state]), [[1, "open"]]);
    assert.equal(research.current_round_id, rounds_of(env.db, research.id)[0]!.id);

    const write = stage_of(env.db, pid, "write");
    assert.deepEqual(rounds_of(env.db, write.id), [], "round 0 means no rounds");

    // plan R1 has a real snapshot file: the manifest blob is that file
    const plan_snap = env.db.get<{ scope: string; manifest_blob_id: string }>(
      "SELECT scope, manifest_blob_id FROM snapshots WHERE id = ?",
      plan_rounds[0]!.sealed_snapshot_id!,
    );
    assert.equal(plan_snap?.scope, "round");
    const file = readFileSync(`${dir}/snapshots/plan-R1.json`);
    assert.equal(blob_row_must(env.db, plan_snap!.manifest_blob_id).sha256, sha256_of(file));

    // analyze R1 has a damaged snapshot file: sealed with an empty manifest marked legacy_unverified
    const analyze = stage_of(env.db, pid, "analyze");
    const analyze_rounds = rounds_of(env.db, analyze.id);
    assert.equal(analyze_rounds[0]!.state, "sealed");
    assert.ok(analyze_rounds[0]!.sealed_snapshot_id);
    const snap = env.db.get<{ manifest_blob_id: string }>(
      "SELECT manifest_blob_id FROM snapshots WHERE id = ?",
      analyze_rounds[0]!.sealed_snapshot_id!,
    );
    const manifest = JSON.parse(
      new TextDecoder().decode(readFileSync(disk_path(env, blob_row_must(env.db, snap!.manifest_blob_id)))),
    ) as { legacy_unverified?: boolean };
    assert.equal(manifest.legacy_unverified, true);
    assert.equal(
      env.db.all("SELECT 1 FROM round_contents WHERE round_id = ?", analyze_rounds[0]!.id).length,
      0,
      "contents are not guessed for a round whose snapshot is gone",
    );
  });
});

// ---------------------------------------------------------------------------
// files (blobs, shots, reports, rounds)

test("shots, reports, round results, and out files are stored byte-for-byte and linked", async () => {
  await with_legacy(async (env, api) => {
    const { pid, dir, mappings } = await imported(env, api);
    const sha = (path: string) => tree_entries(dir).find((e) => e.path === path)!.sha256;
    for (const path of [
      "shots/shot-1.png",
      "library/shots/lib-1.png",
      "reports/plan/report.pdf",
      "reports/plan/eli5.json",
      "rounds/research-R1/1.json",
      "rounds/research-R1/qa.json",
      "out/cover.json",
      "out/appendix.md",
      "out/sources.json",
      "out/report.md",
    ]) {
      const blob = env.db.get<{ id: string; state: string; size: bigint }>(
        "SELECT id, state, size FROM blobs WHERE project_id = ? AND sha256 = ?",
        pid,
        sha(path),
      );
      assert.ok(blob, `${path} is stored`);
      assert.equal(blob.state, "ready");
    }
    // the screenshot is attached to the item that names it, as an image
    const plan1 = item_of(mappings, "plan", "1");
    const image = env.db.get<{ role: string }>(
      `SELECT vf.role FROM version_files vf JOIN blobs b ON b.id = vf.blob_id
        WHERE vf.version_id = ? AND b.sha256 = ?`,
      plan1.new_version_id!,
      sha("shots/shot-1.png"),
    );
    assert.equal(image?.role, "image");
    // the project.json.tmp that differs from project.json is quarantined, never adopted
    const tmp = env.db.get<{ state: string }>(
      "SELECT state FROM blobs WHERE project_id = ? AND sha256 = ?",
      pid,
      sha("project.json.tmp"),
    );
    assert.equal(tmp?.state, "quarantined");
    // stored bytes really equal the source bytes
    const stored = env.db.get<{ id: string }>("SELECT id FROM blobs WHERE project_id = ? AND sha256 = ?", pid, sha("out/cover.json"));
    const row = blob_row_must(env.db, stored!.id);
    assert.equal(sha256_of(readFileSync(disk_path(env, row))), row.sha256);
  });
});

// ---------------------------------------------------------------------------
// questions and answers

test("an ask file becomes a stage_start question set with the questions in order", async () => {
  await with_legacy(async (env, api) => {
    const { pid, mappings } = await imported(env, api);
    const plan = stage_of(env.db, pid, "plan");
    const set = env.db.get<{ id: string; purpose: string; form_key: string; version_no: bigint; round_id: string | null }>(
      "SELECT id, purpose, form_key, version_no, round_id FROM question_sets WHERE project_id = ? AND stage_id = ? AND form_key = 'ask/plan-start'",
      pid,
      plan.id,
    );
    assert.ok(set, "ask/plan-start.json is a question set");
    assert.equal(set.purpose, "stage_start");
    assert.equal(Number(set.version_no), 1);

    const members = env.db.all<{ question_id: string; position: bigint }>(
      "SELECT question_id, position FROM question_set_members WHERE set_id = ? ORDER BY position",
      set.id,
    );
    const scope = mappings.find((m) => m.legacy_kind === "question" && m.legacy_scope === "plan" && m.legacy_key === "q_scope");
    const note = mappings.find((m) => m.legacy_kind === "question" && m.legacy_scope === "plan" && m.legacy_key === "q_note");
    assert.ok(scope?.new_object_id && note?.new_object_id);
    assert.deepEqual(members.map((m) => [m.question_id, Number(m.position)]), [
      [scope.new_object_id, 0],
      [note.new_object_id, 1],
    ]);

    const q = env.db.get<{ direction: string; origin: string; bank_key: string | null }>(
      "SELECT direction, origin, bank_key FROM questions WHERE object_id = ?",
      scope.new_object_id,
    );
    assert.deepEqual({ ...q! }, { direction: "agent_to_human", origin: "bank", bank_key: "q_scope" });
    const v = env.db.get<{ text: string; type: string; required: bigint; options: string; state: string }>(
      "SELECT text, type, required, options, state FROM question_versions WHERE version_id = ?",
      scope.new_version_id!,
    );
    assert.equal(v?.text, "합성 범위");
    assert.equal(v?.type, "single");
    assert.equal(Number(v?.required), 1, "a required question is not lowered to optional");
    assert.equal((JSON.parse(v!.options) as unknown[]).length, 2);
    assert.equal(v?.state, "open");
  });
});

test("each feedback file is one 'import' submission with its raw bytes kept and no invented person", async () => {
  await with_legacy(async (env, api) => {
    const { pid, dir, mappings } = await imported(env, api);
    const subs = env.db.all<{ id: string; via: string; raw_blob_id: string | null; actor_id: string }>(
      "SELECT id, via, raw_blob_id, actor_id FROM submissions WHERE project_id = ?",
      pid,
    ).map((r) => ({ ...r }));
    assert.equal(subs.length, 4, "one submission per feedback file, processed or not");
    const feedback_hashes = new Set(
      tree_entries(dir).filter((e) => e.path.startsWith("feedback/")).map((e) => e.sha256),
    );
    for (const s of subs) {
      assert.equal(s.via, "import");
      assert.ok(s.raw_blob_id);
      assert.ok(feedback_hashes.has(blob_row_must(env.db, s.raw_blob_id).sha256), "the raw blob is the file");
      const actor = env.db.get<{ kind: string }>("SELECT kind FROM actors WHERE id = ?", s.actor_id);
      assert.equal(actor?.kind, "legacy_unknown", "who was empty: no fake human");
    }
    const files = mappings_of(mappings, "feedback_file");
    assert.equal(files.length, 4);
    assert.deepEqual(
      files.map((f) => f.new_row_id).sort(),
      subs.map((s) => s.id).sort(),
      "the mapping points each file at its submission",
    );
  });
});

test("an answer keeps its value; the 'other' text is a comment on the question, never the answer", async () => {
  await with_legacy(async (env, api) => {
    const { pid, mappings } = await imported(env, api);
    const q = mappings.find((m) => m.legacy_kind === "question" && m.legacy_scope === "plan" && m.legacy_key === "q_scope")!;
    const answers = env.db.all<{ value: string; state: string }>(
      `SELECT av.value, av.state FROM answers a
         JOIN answer_versions av ON av.object_id = a.object_id
        WHERE a.project_id = ? AND a.question_id = ?`,
      pid,
      q.new_object_id!,
    ).map((r) => ({ value: JSON.parse(r.value) as unknown, state: r.state }));
    assert.deepEqual(answers, [{ value: "narrow", state: "submitted" }]);

    // the extra sentence is a question_comment thread on that question, tied to the same submission
    const comment = env.db.get<{ target_object_id: string; context_kind: string; body_md: string; submission_id: string | null }>(
      `SELECT t.target_object_id, t.context_kind, mv.body_md, m.submission_id
         FROM threads t JOIN messages m ON m.thread_id = t.object_id
         JOIN message_versions mv ON mv.object_id = m.object_id
        WHERE t.project_id = ? AND mv.body_md LIKE '%합성 덧붙임 문장%'`,
      pid,
    );
    assert.ok(comment, "the 'other' sentence is preserved");
    assert.equal(comment.context_kind, "question_comment");
    assert.equal(comment.target_object_id, q.new_object_id);
    assert.ok(comment.submission_id);

    // it never became an answer value
    for (const r of env.db.all<{ value: string }>(
      "SELECT av.value FROM answer_versions av JOIN answers a ON a.object_id = av.object_id WHERE a.project_id = ?",
      pid,
    )) {
      assert.notEqual(JSON.parse(r.value), "합성 덧붙임 문장");
    }
  });
});

test("an answer to a question that has no ask file is kept on an 'import' question; free opinion is kept", async () => {
  await with_legacy(async (env, api) => {
    const { pid } = await imported(env, api);
    const q = env.db.get<{ object_id: string; origin: string }>(
      "SELECT object_id, origin FROM questions WHERE project_id = ? AND bank_key = 'q_gone'",
      pid,
    );
    assert.ok(q, "the unknown question id gets a question row");
    assert.equal(q.origin, "import");
    const answer = env.db.get<{ value: string }>(
      `SELECT av.value FROM answers a JOIN answer_versions av ON av.object_id = a.object_id
        WHERE a.project_id = ? AND a.question_id = ?`,
      pid,
      q.object_id,
    );
    assert.equal(JSON.parse(answer!.value), "합성 답 값", "the answer is not dropped");

    const opinion = env.db.get<{ body_md: string }>(
      `SELECT mv.body_md FROM message_versions mv WHERE mv.project_id = ? AND mv.body_md LIKE '%합성 자유 의견%'`,
      pid,
    );
    assert.ok(opinion, "a free opinion without answers is kept as a message");
  });
});

test("the old approve request is an event, not a new-style approval", async () => {
  await with_legacy(async (env, api) => {
    const { pid } = await imported(env, api);
    const origins = env.db.all<{ origin: string }>("SELECT DISTINCT origin FROM approvals WHERE project_id = ?", pid);
    assert.deepEqual(origins.map((o) => o.origin), ["legacy"]);
    // the approve request file is still a submission (see the 4-submission count) and shows in the log events
    assert.ok(
      env.db.all("SELECT 1 FROM events WHERE project_id = ? AND type LIKE 'legacy.%'", pid).length >= 7,
      "log lines + processed names + request events are recorded",
    );
  });
});

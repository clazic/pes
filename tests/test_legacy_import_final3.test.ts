// SEL-44 (stage 2 PR11) regression tests for the final code review 3 (logs/SEL-44-final-review-3.md).
// Everything is synthetic, built in a temporary folder inside the test's isolated HOME.
//
//   S1 (필수 1)   a snapshot's state.review whose round differs from the snapshot round (or has no round) is
//                 NOT registered as a form of the snapshot round. Its questions never receive the answers /
//                 addenda / submission set of the snapshot round; those go to an import placeholder and the
//                 mismatch is reported. A review whose round is proven by feedback of THAT round still links.
//                 Variants: (a) R2 snapshot, review.round=1; (b) R1 snapshot, review.round=2;
//                 (c) R2 snapshot, review without round.
//   S2 (권장 spec) a spec that names one form restricts the candidates to that form: a question that only
//                 another form has goes to a placeholder (no other form's question / form_key mixed in).
//   S3 (권장 1)   the same digest of an old item reused by several rounds: the version is reused (one
//                 version), but the round context the shared version cannot express (links to a different
//                 target per round) is reported as unknown_field (snapshot path, pointer, raw record).
//
// Interpretation: the same as test_legacy_import_final2.test.ts. A mismatch report is "an entry on the
// feedback file that is not just unprocessed_answer", or an entry on the snapshot's /state/review pointer.
// No earlier test contradicts these; none was changed.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { run_import, with_legacy, type Env, type LegacyApi, type UnknownReport } from "./helpers/legacy_env.ts";

let dir_counter = 0;

function write_file(dir: string, rel: string, body: unknown): void {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, typeof body === "string" ? body : JSON.stringify(body), "utf8");
}

type Stages = Record<string, { round: number; items?: unknown[]; review?: unknown }>;

function project(slug: string, stages: Stages): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stages)) out[key] = { status: "active", items: [], ...value };
  return {
    pes: 1,
    topic: "합성 최종 3 프로젝트",
    slug,
    created: "2026-03-01",
    current: "plan",
    settings: {},
    processed: [],
    complete: false,
    stages: out,
  };
}

function snapshot(stage: string, round: number, items: unknown[], review?: unknown): Record<string, unknown> {
  const state: Record<string, unknown> = { status: "active", round, items };
  if (review !== undefined) state.review = review;
  return { stage, round, time: "2026-03-01 10:00", state };
}

async function import_body(env: Env, api: LegacyApi, label: string, body: Record<string, unknown>, files: Record<string, unknown> = {}) {
  dir_counter += 1;
  const dir = join(env.home.root, `final3-${label}-${dir_counter}`);
  mkdirSync(dir, { recursive: true });
  write_file(dir, "project.json", body);
  for (const [rel, content] of Object.entries(files)) write_file(dir, rel, content);
  const result = await run_import(env, api, dir);
  assert.equal(result.state, "staging", `${label}: the import itself must not fail`);
  return { result, pid: result.project_id };
}

function feedback(kind: string, round: number, answers: Record<string, string>, spec?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    stage: "plan",
    round,
    time: `20260302-10000${round}`,
    kind,
    text: "",
    answers,
    via: "html",
    origin: "http://127.0.0.1:8760",
    who: "",
  };
  if (spec !== undefined) body.spec = spec;
  return body;
}

function plain(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

interface SubmissionView {
  set_id: string | null;
  form_key: string | null;
  answers: Array<{ text: string; origin: string; value: string }>;
  addenda: Array<{ text: string; body: string }>;
}

function submissions_view(env: Env, pid: string): SubmissionView[] {
  const subs = env.db.all<{ id: string; set_id: string | null; form_key: string | null }>(
    `SELECT s.id AS id, s.set_id AS set_id, qs.form_key AS form_key FROM submissions s
       LEFT JOIN question_sets qs ON qs.id = s.set_id WHERE s.project_id = ? ORDER BY s.received_at, s.id`,
    pid,
  );
  return subs.map((sub) => {
    const answers = env.db
      .all<{ text: string; origin: string; value: string }>(
        `SELECT qv.text AS text, q.origin AS origin, av.value AS value
           FROM answers a
           JOIN answer_versions av ON av.object_id = a.object_id
           JOIN question_versions qv ON qv.version_id = av.question_version_id
           JOIN questions q ON q.object_id = qv.object_id
          WHERE a.submission_id = ? ORDER BY qv.text`,
        sub.id,
      )
      .map((r) => ({ text: r.text, origin: r.origin, value: plain(r.value) }));
    const addenda = env.db
      .all<{ text: string; body: string }>(
        `SELECT qv.text AS text, mv.body_md AS body
           FROM messages m
           JOIN message_versions mv ON mv.object_id = m.object_id
           JOIN threads t ON t.object_id = m.thread_id
           JOIN question_versions qv ON qv.version_id = t.target_version_id
          WHERE m.submission_id = ? AND t.context_kind = 'question_comment' ORDER BY qv.text`,
        sub.id,
      )
      .map((r) => ({ text: r.text, body: r.body }));
    return { set_id: sub.set_id, form_key: sub.form_key, answers, addenda };
  });
}

function set_member_texts(env: Env, set_id: string | null): string[] {
  if (set_id === null) return [];
  return env.db
    .all<{ text: string }>(
      `SELECT qv.text AS text FROM question_set_members m
         JOIN question_versions qv ON qv.version_id = m.question_version_id WHERE m.set_id = ?`,
      set_id,
    )
    .map((r) => r.text);
}

function mismatch_reported(report: UnknownReport, feedback_path: string, snapshot_path: string): boolean {
  return report.entries.some(
    (e) =>
      (e.path === feedback_path && e.category !== "unprocessed_answer") ||
      (e.path === snapshot_path && typeof e.key === "string" && e.key.startsWith("/state/review")),
  );
}

/** The wrong-round question text must be nowhere on the submission: not an answer, an addendum, nor a set member. */
function assert_not_attached(view: SubmissionView, wrong_text: string, answer: string, comment: string): void {
  assert.equal(view.answers.length, 1);
  assert.equal(view.answers[0]!.origin, "import", "an import placeholder");
  assert.equal(view.answers[0]!.value, answer);
  assert.notEqual(view.answers[0]!.text, wrong_text);
  assert.equal(view.addenda.length, 1);
  assert.equal(view.addenda[0]!.text, view.answers[0]!.text, "answer and addendum use the same placeholder");
  assert.equal(view.addenda[0]!.body, comment);
  assert.ok(view.addenda.every((a) => a.text !== wrong_text));
}

const R1_PATH = "feedback/plan-R1-20260302-100001.json";
const R2_PATH = "feedback/plan-R2-20260302-100002.json";

// ===========================================================================
// S1: a snapshot review whose round is not the snapshot round
// ===========================================================================

const STALE_REVIEW_R1 = { round: 1, summary: "old R1", questions: [{ id: "q", label: "R1 stale question", type: "text" }] };

test("S1a: R2 snapshot holding a review of round 1: the R2 answer, addendum and set are not attached to the R1 question; mismatch reported", async () => {
  await with_legacy(async (env, api) => {
    const { result, pid } = await import_body(env, api, "s1a", project("synthetic-final3-a", { plan: { round: 3 } }), {
      "snapshots/plan-R2.json": snapshot("plan", 2, [], STALE_REVIEW_R1),
      [R2_PATH]: feedback("review", 2, { q: "R2 answer", q__other: "R2 comment" }, "plan-R2-review"),
    });
    const views = submissions_view(env, pid);
    assert.equal(views.length, 1);
    const view = views[0]!;
    assert_not_attached(view, "R1 stale question", "R2 answer", "R2 comment");
    assert.ok(!set_member_texts(env, view.set_id).includes("R1 stale question"), "the set is not the stale review's set");
    assert.notEqual(view.form_key, "review/plan@R2", "the submission is not linked to a R2 form built from the round-1 review");
    assert.ok(mismatch_reported(result.report, R2_PATH, "snapshots/plan-R2.json"), "the mismatch is reported");
  });
});

test("S1b: control: the same stale review IS proven for round 1 when a round-1 feedback exists: R1 attaches, R2 does not", async () => {
  await with_legacy(async (env, api) => {
    const { pid } = await import_body(env, api, "s1b", project("synthetic-final3-b", { plan: { round: 3 } }), {
      "snapshots/plan-R2.json": snapshot("plan", 2, [], STALE_REVIEW_R1),
      [R1_PATH]: feedback("review", 1, { q: "R1 answer", q__other: "R1 comment" }, "plan-R1-review"),
      [R2_PATH]: feedback("review", 2, { q: "R2 answer", q__other: "R2 comment" }, "plan-R2-review"),
    });
    const views = submissions_view(env, pid);
    assert.equal(views.length, 2);
    const [r1, r2] = views;
    assert.deepEqual(r1!.answers.map((a) => [a.text, a.value]), [["R1 stale question", "R1 answer"]], "the proven round attaches exactly");
    assert.deepEqual(r1!.addenda, [{ text: "R1 stale question", body: "R1 comment" }]);
    assert.deepEqual(set_member_texts(env, r1!.set_id), ["R1 stale question"]);
    assert_not_attached(r2!, "R1 stale question", "R2 answer", "R2 comment");
    assert.ok(!set_member_texts(env, r2!.set_id).includes("R1 stale question"));
  });
});

test("S1c: R1 snapshot holding a review of round 2: the R1 answer, addendum and set are not attached to the round-2 question", async () => {
  await with_legacy(async (env, api) => {
    const { result, pid } = await import_body(env, api, "s1c", project("synthetic-final3-c", { plan: { round: 3 } }), {
      "snapshots/plan-R1.json": snapshot("plan", 1, [], {
        round: 2,
        summary: "later review",
        questions: [{ id: "q", label: "R2 question in R1 snapshot", type: "text" }],
      }),
      [R1_PATH]: feedback("review", 1, { q: "R1 answer", q__other: "R1 comment" }, "plan-R1-review"),
    });
    const views = submissions_view(env, pid);
    assert.equal(views.length, 1);
    const view = views[0]!;
    assert_not_attached(view, "R2 question in R1 snapshot", "R1 answer", "R1 comment");
    assert.ok(!set_member_texts(env, view.set_id).includes("R2 question in R1 snapshot"));
    assert.notEqual(view.form_key, "review/plan@R1");
    assert.ok(mismatch_reported(result.report, R1_PATH, "snapshots/plan-R1.json"), "the mismatch is reported");
  });
});

test("S1d: snapshot review without a round: not assumed to be the snapshot round; placeholder, nothing attached, reported", async () => {
  await with_legacy(async (env, api) => {
    const { result, pid } = await import_body(env, api, "s1d", project("synthetic-final3-d", { plan: { round: 3 } }), {
      "snapshots/plan-R2.json": snapshot("plan", 2, [], {
        summary: "no round",
        questions: [{ id: "q", label: "Roundless question", type: "text" }],
      }),
      [R2_PATH]: feedback("review", 2, { q: "R2 answer", q__other: "R2 comment" }, "plan-R2-review"),
    });
    const views = submissions_view(env, pid);
    assert.equal(views.length, 1);
    const view = views[0]!;
    assert_not_attached(view, "Roundless question", "R2 answer", "R2 comment");
    assert.ok(!set_member_texts(env, view.set_id).includes("Roundless question"));
    assert.notEqual(view.form_key, "review/plan@R2");
    assert.ok(mismatch_reported(result.report, R2_PATH, "snapshots/plan-R2.json"), "the unprovable round is reported");
  });
});

// ===========================================================================
// S2: a spec that names one form restricts the candidates to that form
// ===========================================================================

function resume_ask(id: string, qid: string, label: string): Record<string, unknown> {
  return {
    id,
    kind: "resume",
    stage: "plan",
    round: 2,
    title: id,
    inherited: [],
    questions: [{ id: qid, label, type: "text" }],
  };
}

test("S2a: spec names formA but the question exists only in formB: placeholder, no formB question, set or form_key mixed in", async () => {
  await with_legacy(async (env, api) => {
    const { pid } = await import_body(env, api, "s2a", project("synthetic-final3-spec", { plan: { round: 3 } }), {
      "ask/formA.json": resume_ask("formA", "p", "Form A question"),
      "ask/formB.json": resume_ask("formB", "q", "Form B question"),
      [R2_PATH]: feedback("resume", 2, { q: "answer for q", q__other: "comment for q" }, "formA"),
    });
    const views = submissions_view(env, pid);
    assert.equal(views.length, 1);
    const view = views[0]!;
    assert_not_attached(view, "Form B question", "answer for q", "comment for q");
    assert.notEqual(view.form_key, "ask/formB");
    assert.ok(!set_member_texts(env, view.set_id).includes("Form B question"));
  });
});

test("S2b: control: spec names formA and the question is in formA: it attaches to formA's question and set", async () => {
  await with_legacy(async (env, api) => {
    const { pid } = await import_body(env, api, "s2b", project("synthetic-final3-spec-ok", { plan: { round: 3 } }), {
      "ask/formA.json": resume_ask("formA", "p", "Form A question"),
      "ask/formB.json": resume_ask("formB", "q", "Form B question"),
      [R2_PATH]: feedback("resume", 2, { p: "answer for p" }, "formA"),
    });
    const [view] = submissions_view(env, pid);
    assert.ok(view);
    assert.deepEqual(view.answers.map((a) => [a.text, a.value]), [["Form A question", "answer for p"]]);
    assert.equal(view.form_key, "ask/formA");
  });
});

// ===========================================================================
// S3: the same digest reused by several rounds, with a different link target per round
// ===========================================================================

const A_CUR = { id: 1, title: "A current", kind: "rq", status: "done", summary: "a cur", links: { plan: [2] } };
const B_CUR = { id: 2, title: "B current", kind: "rq", status: "done", summary: "b cur" };
const A_SAME = { id: 1, title: "A same", kind: "rq", status: "new", summary: "a same", links: { plan: [2] } };

test("S3: identical old item in R1 and R2 with different link targets: one shared version, and the round context it cannot express is reported", async () => {
  await with_legacy(async (env, api) => {
    const { result, pid } = await import_body(env, api, "s3", project("synthetic-final3-digest", { plan: { round: 3, items: [A_CUR, B_CUR] } }), {
      "snapshots/plan-R1.json": snapshot("plan", 1, [A_SAME, { id: 2, title: "B r1", kind: "rq", status: "new", summary: "b r1" }]),
      "snapshots/plan-R2.json": snapshot("plan", 2, [A_SAME, { id: 2, title: "B r2", kind: "rq", status: "new", summary: "b r2" }]),
    });
    const same = env.db.all(
      `SELECT av.version_id FROM artifact_versions av JOIN objects o ON o.id = av.object_id
        WHERE o.project_id = ? AND av.title = 'A same'`,
      pid,
    );
    assert.equal(same.length, 1, "the version is still shared (reuse kept)");
    const relations = env.db
      .all<{ to_title: string | null }>(
        `SELECT tv.title AS to_title FROM version_relations r
           LEFT JOIN artifact_versions tv ON tv.version_id = r.to_version_id
          WHERE r.project_id = ? AND r.from_version_id = ?`,
        pid,
        (same[0] as { version_id: string }).version_id,
      )
      .map((r) => r.to_title);
    assert.ok(relations.includes("B r1") || relations.includes("B r2"), "at least one round's link is kept");
    // The round whose link the shared version cannot express is reported, at its own snapshot path and pointer.
    const unexpressed = relations.includes("B r1") ? "snapshots/plan-R2.json" : "snapshots/plan-R1.json";
    const hits = result.report.entries.filter(
      (e) =>
        e.category === "unknown_field" &&
        e.path === unexpressed &&
        typeof e.key === "string" &&
        (e.key === "/state/items/0" || e.key.startsWith("/state/items/0/")),
    );
    assert.ok(hits.length >= 1, `the links of the other round are reported at ${unexpressed} /state/items/0`);
    assert.ok(JSON.stringify(hits).includes("A same"), "the raw record is kept in the report");
  });
});

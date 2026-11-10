// SEL-44 (stage 2 PR11) regression tests for the final code review 2/2 (logs/SEL-44-final-review-2.md)
// and the leader's widening of F1 / F3 to their other variants. Everything is synthetic, built in a
// temporary folder inside the test's isolated HOME.
//
//   N1 (필수 1)  links / reuse of an OLD item version (an item of a snapshot) link to the version the
//                SAME snapshot selects for the target (its round_contents version), never to the current
//                version. A target that is not in that snapshot (other snapshot, no snapshot, other stage,
//                library) is not guessed: no relation, the raw links are kept and reported with the
//                snapshot-relative path and the JSON pointer. Current items still link current versions.
//   N2 (필수 2)  a review / resume / stage_start answer attaches only to a form proven by kind + stage +
//                round (+ spec). A form of another round or another kind is never a substitute. With the
//                R1 snapshot's own review question present the answer sits on it; otherwise on an
//                import placeholder, and the round mismatch is reported.
//   N3 (권장 1)  a duplicated id in a snapshot's state.items: the second record and later are not objects;
//                they are reported as unknown_field (snapshot path, /state/items/<index>, raw record).
//
// Interpretation: the same as test_legacy_import_final1.test.ts. Relation kinds: links -> 'supports',
// reuse -> 'reuses'. Where the report entry for a mismatch sits is only fixed as "an entry on the feedback
// file that is not just unprocessed_answer".
//
// No earlier test contradicts these; none was changed.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  run_import,
  with_legacy,
  type Env,
  type LegacyApi,
  type UnknownReport,
} from "./helpers/legacy_env.ts";

let dir_counter = 0;

function new_source(env: Env, label: string): string {
  dir_counter += 1;
  const dir = join(env.home.root, `final2-${label}-${dir_counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function write_file(dir: string, rel: string, body: unknown): void {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, typeof body === "string" ? body : JSON.stringify(body), "utf8");
}

type Stages = Record<string, { round: number; items?: unknown[]; review?: unknown }>;

function project(slug: string, stages: Stages): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stages)) {
    out[key] = { status: "active", items: [], ...value };
  }
  return {
    pes: 1,
    topic: "합성 최종 2 프로젝트",
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

async function import_body(
  env: Env,
  api: LegacyApi,
  label: string,
  body: Record<string, unknown>,
  files: Record<string, unknown> = {},
) {
  const dir = new_source(env, label);
  write_file(dir, "project.json", body);
  for (const [rel, content] of Object.entries(files)) write_file(dir, rel, content);
  const result = await run_import(env, api, dir);
  assert.equal(result.state, "staging", `${label}: the import itself must not fail`);
  return { result, pid: result.project_id };
}

function version_id_of(env: Env, pid: string, title: string): string {
  const rows = env.db.all<{ version_id: string }>(
    `SELECT av.version_id AS version_id FROM artifact_versions av JOIN objects o ON o.id = av.object_id
      WHERE o.project_id = ? AND av.title = ?`,
    pid,
    title,
  );
  assert.equal(rows.length, 1, `exactly one artifact version titled "${title}"`);
  return rows[0]!.version_id;
}

/** "kind: to-title" strings of the relations that leave the version titled `title`. */
function relations_from(env: Env, pid: string, title: string): string[] {
  return env.db
    .all<{ kind: string; to_title: string | null }>(
      `SELECT r.kind AS kind, tv.title AS to_title FROM version_relations r
         LEFT JOIN artifact_versions tv ON tv.version_id = r.to_version_id
        WHERE r.project_id = ? AND r.from_version_id = ?`,
      pid,
      version_id_of(env, pid, title),
    )
    .map((row) => `${row.kind}: ${row.to_title}`)
    .sort();
}

function reported_at(report: UnknownReport, path: string, pointer: string, category = "unknown_field") {
  return report.entries.filter(
    (e) =>
      e.category === category &&
      e.path === path &&
      typeof e.key === "string" &&
      (e.key === pointer || e.key.startsWith(`${pointer}/`)),
  );
}

// ===========================================================================
// N1: links / reuse of snapshot (past) items
// ===========================================================================

const A_CUR = { id: 1, title: "A current", kind: "rq", status: "done", summary: "a cur", links: { plan: [2] } };
const B_CUR = { id: 2, title: "B current", kind: "rq", status: "done", summary: "b cur" };

test("N1a: an old item's links point at the target version of the SAME snapshot, not at the current version", async () => {
  await with_legacy(async (env, api) => {
    const { pid } = await import_body(env, api, "n1a", project("synthetic-final2-links", { plan: { round: 2, items: [A_CUR, B_CUR] } }), {
      "snapshots/plan-R1.json": snapshot("plan", 1, [
        { id: 1, title: "A old", kind: "rq", status: "new", summary: "a old", links: { plan: [2] } },
        { id: 2, title: "B old", kind: "rq", status: "new", summary: "b old" },
      ]),
    });
    assert.deepEqual(relations_from(env, pid, "A old"), ["supports: B old"], "A old -> B old only");
    assert.deepEqual(relations_from(env, pid, "A current"), ["supports: B current"], "current links stay current");
  });
});

test("N1b: two snapshots (R1 and R2) with different target versions: each old item links its own round's target", async () => {
  await with_legacy(async (env, api) => {
    const { pid } = await import_body(env, api, "n1b", project("synthetic-final2-links-two", { plan: { round: 3, items: [A_CUR, B_CUR] } }), {
      "snapshots/plan-R1.json": snapshot("plan", 1, [
        { id: 1, title: "A r1", kind: "rq", status: "new", summary: "a r1", links: { plan: [2] } },
        { id: 2, title: "B r1", kind: "rq", status: "new", summary: "b r1" },
      ]),
      "snapshots/plan-R2.json": snapshot("plan", 2, [
        { id: 1, title: "A r2", kind: "rq", status: "new", summary: "a r2", links: { plan: [2] } },
        { id: 2, title: "B r2", kind: "rq", status: "new", summary: "b r2" },
      ]),
    });
    assert.deepEqual(relations_from(env, pid, "A r1"), ["supports: B r1"]);
    assert.deepEqual(relations_from(env, pid, "A r2"), ["supports: B r2"]);
    assert.deepEqual(relations_from(env, pid, "A current"), ["supports: B current"]);
  });
});

test("N1c: a snapshot target equal to the current item IS the current version, so the old item links to it", async () => {
  await with_legacy(async (env, api) => {
    const { pid } = await import_body(env, api, "n1c", project("synthetic-final2-links-same", { plan: { round: 2, items: [A_CUR, B_CUR] } }), {
      "snapshots/plan-R1.json": snapshot("plan", 1, [
        { id: 1, title: "A old", kind: "rq", status: "new", summary: "a old", links: { plan: [2] } },
        B_CUR,
      ]),
    });
    assert.deepEqual(relations_from(env, pid, "A old"), ["supports: B current"], "the exact version that snapshot selected");
  });
});

test("N1d: the target exists only in ANOTHER snapshot: no guess, no relation, the links are reported at the snapshot path", async () => {
  await with_legacy(async (env, api) => {
    const { result, pid } = await import_body(env, api, "n1d", project("synthetic-final2-links-other", { plan: { round: 3, items: [A_CUR, B_CUR] } }), {
      "snapshots/plan-R1.json": snapshot("plan", 1, [
        { id: 1, title: "A r1", kind: "rq", status: "new", summary: "a r1", links: { plan: [2] } },
      ]),
      "snapshots/plan-R2.json": snapshot("plan", 2, [
        { id: 2, title: "B r2", kind: "rq", status: "new", summary: "b r2" },
      ]),
    });
    assert.deepEqual(relations_from(env, pid, "A r1"), [], "neither B current nor B r2 is guessed");
    assert.ok(
      reported_at(result.report, "snapshots/plan-R1.json", "/state/items/0/links").length > 0,
      "the unresolved links are reported with the snapshot-relative path and pointer",
    );
    assert.deepEqual(relations_from(env, pid, "A current"), ["supports: B current"]);
  });
});

test("N1e: the target is in no snapshot (only in project.json): no relation to the current version, reported", async () => {
  await with_legacy(async (env, api) => {
    const { result, pid } = await import_body(env, api, "n1e", project("synthetic-final2-links-none", { plan: { round: 2, items: [A_CUR, B_CUR] } }), {
      "snapshots/plan-R1.json": snapshot("plan", 1, [
        { id: 1, title: "A old", kind: "rq", status: "new", summary: "a old", links: { plan: [2] } },
      ]),
    });
    assert.deepEqual(relations_from(env, pid, "A old"), [], "not guessed from the current B");
    assert.ok(reported_at(result.report, "snapshots/plan-R1.json", "/state/items/0/links").length > 0);
  });
});

test("N1f: links to another stage's key: the old item does not link the current research version; resolvable keys still link; the rest is reported", async () => {
  await with_legacy(async (env, api) => {
    const body = project("synthetic-final2-links-stage", {
      plan: {
        round: 2,
        items: [
          { id: 1, title: "A current", kind: "rq", status: "done", summary: "a cur", links: { plan: [2], research: [5] } },
          B_CUR,
        ],
      },
      research: { round: 2, items: [{ id: 5, title: "R5 current", kind: "topic", status: "done", summary: "r5 cur" }] },
    });
    const { result, pid } = await import_body(env, api, "n1f", body, {
      "snapshots/plan-R1.json": snapshot("plan", 1, [
        { id: 1, title: "A old", kind: "rq", status: "new", summary: "a old", links: { plan: [2], research: [5] } },
        { id: 2, title: "B old", kind: "rq", status: "new", summary: "b old" },
      ]),
      "snapshots/research-R1.json": snapshot("research", 1, [
        { id: 5, title: "R5 old", kind: "topic", status: "new", summary: "r5 old" },
      ]),
    });
    const from_old = relations_from(env, pid, "A old");
    assert.ok(from_old.includes("supports: B old"), "the same-snapshot target links");
    assert.ok(!from_old.includes("supports: R5 current"), "the current research version is never guessed");
    assert.ok(!from_old.includes("supports: B current"));
    assert.ok(
      reported_at(result.report, "snapshots/plan-R1.json", "/state/items/0/links").length > 0,
      "the part that could not be resolved is reported",
    );
    assert.deepEqual(
      relations_from(env, pid, "A current"),
      ["supports: B current", "supports: R5 current"],
      "current links are current versions",
    );
  });
});

test("N1g: reuse of an old item: no 'reuses' to the (undated) current library item; reported; the current item still reuses it", async () => {
  await with_legacy(async (env, api) => {
    const body = project("synthetic-final2-reuse", {
      plan: {
        round: 2,
        items: [{ id: 1, title: "A current", kind: "rq", status: "done", summary: "a cur", reuse: 5 }],
      },
    });
    const { result, pid } = await import_body(env, api, "n1g", body, {
      "library.json": {
        source: "synthetic-source",
        imported: "2026-01-04 08:00",
        items: [{ id: 5, title: "Library five", kind: "topic", status: "done" }],
      },
      "snapshots/plan-R1.json": snapshot("plan", 1, [
        { id: 1, title: "A old", kind: "rq", status: "new", summary: "a old", reuse: 5 },
      ]),
    });
    assert.deepEqual(relations_from(env, pid, "A old"), [], "a library item has no snapshot version to pick");
    assert.ok(reported_at(result.report, "snapshots/plan-R1.json", "/state/items/0/reuse").length > 0);
    assert.deepEqual(relations_from(env, pid, "A current"), ["reuses: Library five"]);
  });
});

test("N1h: importing the same folder twice gives the same old-version relations (idempotent)", async () => {
  await with_legacy(async (env, api) => {
    const body = project("synthetic-final2-links-twice", { plan: { round: 2, items: [A_CUR, B_CUR] } });
    const files = {
      "snapshots/plan-R1.json": snapshot("plan", 1, [
        { id: 1, title: "A old", kind: "rq", status: "new", summary: "a old", links: { plan: [2] } },
        { id: 2, title: "B old", kind: "rq", status: "new", summary: "b old" },
      ]),
    };
    const first = await import_body(env, api, "n1h1", body, files);
    const second = await import_body(env, api, "n1h2", body, files);
    for (const { pid } of [first, second]) {
      assert.deepEqual(relations_from(env, pid, "A old"), ["supports: B old"]);
    }
  });
});

// ===========================================================================
// N2: review / resume / stage_start answers attach only to a proven form
// ===========================================================================

const R2_REVIEW = {
  round: 2,
  summary: "r2 summary",
  questions: [{ id: "q", label: "R2 changed question", type: "text" }],
};

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

const R1_PATH = "feedback/plan-R1-20260302-100000.json";

/** Answer values are stored as JSON text. */
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
  /** question text (as the answer's question version shows it) -> [origin of the question, answer value] */
  answers: Array<{ text: string; origin: string; value: string }>;
  /** question text -> addendum bodies attached to that question version */
  addenda: Array<{ text: string; body: string }>;
}

function submissions_view(env: Env, pid: string): SubmissionView[] {
  const subs = env.db.all<{ id: string; set_id: string | null }>(
    "SELECT id, set_id FROM submissions WHERE project_id = ? ORDER BY received_at, id",
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
    return { set_id: sub.set_id, answers, addenda };
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

function mismatch_reported(report: UnknownReport, path: string): boolean {
  return report.entries.some((e) => e.path === path && e.category !== "unprocessed_answer");
}

function review_repro_project(slug: string): Record<string, unknown> {
  return project(slug, { plan: { round: 3, review: R2_REVIEW } });
}

const R1_FEEDBACK = feedback("review", 1, { q: "R1 answer", q__other: "R1 comment" }, "plan-R1-review");

test("N2a: the R1 snapshot's review question exists: the R1 answer, addendum and submission set all use it, not the R2 question", async () => {
  await with_legacy(async (env, api) => {
    const { pid } = await import_body(env, api, "n2a", review_repro_project("synthetic-final2-review-snap"), {
      "snapshots/plan-R1.json": snapshot("plan", 1, [], {
        round: 1,
        summary: "r1 summary",
        questions: [{ id: "q", label: "R1 original question", type: "text" }],
      }),
      [R1_PATH]: R1_FEEDBACK,
    });
    const [view] = submissions_view(env, pid);
    assert.ok(view);
    assert.deepEqual(view.answers.map((a) => [a.text, a.value]), [["R1 original question", "R1 answer"]]);
    assert.deepEqual(view.addenda, [{ text: "R1 original question", body: "R1 comment" }]);
    assert.ok(view.set_id !== null, "the submission is linked to the R1 review set");
    assert.deepEqual(set_member_texts(env, view.set_id), ["R1 original question"]);
  });
});

test("N2b: no R1 form at all: the answer and addendum go to ONE import placeholder, never to the R2 question; the mismatch is reported", async () => {
  await with_legacy(async (env, api) => {
    const { result, pid } = await import_body(env, api, "n2b", review_repro_project("synthetic-final2-review-nosnap"), {
      [R1_PATH]: R1_FEEDBACK,
    });
    const [view] = submissions_view(env, pid);
    assert.ok(view);
    assert.equal(view.answers.length, 1);
    assert.notEqual(view.answers[0]!.text, "R2 changed question");
    assert.equal(view.answers[0]!.origin, "import", "an import placeholder");
    assert.equal(view.answers[0]!.value, "R1 answer");
    assert.equal(view.addenda.length, 1);
    assert.equal(view.addenda[0]!.text, view.answers[0]!.text, "answer and addendum use the same placeholder");
    assert.equal(view.addenda[0]!.body, "R1 comment");
    assert.ok(!set_member_texts(env, view.set_id).includes("R2 changed question"), "the submission set is not the R2 review set");
    assert.ok(mismatch_reported(result.report, R1_PATH), "the round mismatch is reported on the feedback file");
  });
});

test("N2c: the same-round feedback (review round 2, no spec) still attaches to the R2 review question (control)", async () => {
  await with_legacy(async (env, api) => {
    const { pid } = await import_body(env, api, "n2c", review_repro_project("synthetic-final2-review-control"), {
      "feedback/plan-R2-20260302-100002.json": feedback("review", 2, { q: "R2 answer", q__other: "R2 comment" }),
    });
    const [view] = submissions_view(env, pid);
    assert.ok(view);
    assert.deepEqual(view.answers.map((a) => [a.text, a.origin, a.value]), [["R2 changed question", "review", "R2 answer"]]);
    assert.deepEqual(view.addenda, [{ text: "R2 changed question", body: "R2 comment" }]);
    assert.deepEqual(set_member_texts(env, view.set_id), ["R2 changed question"]);
  });
});

test("N2d: no spec and another round (review round 1, only the R2 form exists): not attached to R2, placeholder, reported", async () => {
  await with_legacy(async (env, api) => {
    const { result, pid } = await import_body(env, api, "n2d", review_repro_project("synthetic-final2-review-nospec"), {
      [R1_PATH]: feedback("review", 1, { q: "R1 answer" }),
    });
    const [view] = submissions_view(env, pid);
    assert.ok(view);
    assert.equal(view.answers.length, 1);
    assert.equal(view.answers[0]!.origin, "import");
    assert.notEqual(view.answers[0]!.text, "R2 changed question");
    assert.ok(!set_member_texts(env, view.set_id).includes("R2 changed question"));
    assert.ok(mismatch_reported(result.report, R1_PATH));
  });
});

test("N2e: a spec that names no form (and another round) does not fall back to the R2 form", async () => {
  await with_legacy(async (env, api) => {
    const { pid } = await import_body(env, api, "n2e", review_repro_project("synthetic-final2-review-badspec"), {
      [R1_PATH]: feedback("review", 1, { q: "R1 answer" }, "some-unknown-spec"),
    });
    const [view] = submissions_view(env, pid);
    assert.ok(view);
    assert.deepEqual(view.answers.map((a) => a.origin), ["import"]);
    assert.ok(!set_member_texts(env, view.set_id).includes("R2 changed question"));
  });
});

test("N2f: R1 and R2 snapshots both have a review: each round's feedback attaches to its own question version, none to the current R3 one", async () => {
  await with_legacy(async (env, api) => {
    const body = project("synthetic-final2-review-rounds", {
      plan: { round: 4, review: { round: 3, summary: "r3", questions: [{ id: "q", label: "R3 question", type: "text" }] } },
    });
    const { pid } = await import_body(env, api, "n2f", body, {
      "snapshots/plan-R1.json": snapshot("plan", 1, [], { round: 1, summary: "r1", questions: [{ id: "q", label: "R1 question", type: "text" }] }),
      "snapshots/plan-R2.json": snapshot("plan", 2, [], { round: 2, summary: "r2", questions: [{ id: "q", label: "R2 question", type: "text" }] }),
      "feedback/plan-R1-20260302-100001.json": feedback("review", 1, { q: "a1" }, "plan-R1-review"),
      "feedback/plan-R2-20260302-100002.json": feedback("review", 2, { q: "a2" }, "plan-R2-review"),
    });
    const views = submissions_view(env, pid);
    assert.equal(views.length, 2);
    assert.deepEqual(views[0]!.answers.map((a) => [a.text, a.value]), [["R1 question", "a1"]]);
    assert.deepEqual(views[1]!.answers.map((a) => [a.text, a.value]), [["R2 question", "a2"]]);
    assert.deepEqual(set_member_texts(env, views[0]!.set_id), ["R1 question"]);
    assert.deepEqual(set_member_texts(env, views[1]!.set_id), ["R2 question"]);
  });
});

test("N2g: only some of the questions are in the R1 snapshot: those attach exactly, the others go to placeholders, none to the R2 questions", async () => {
  await with_legacy(async (env, api) => {
    const body = project("synthetic-final2-review-partial", {
      plan: {
        round: 3,
        review: {
          round: 2,
          summary: "r2",
          questions: [
            { id: "q1", label: "R2 q1", type: "text" },
            { id: "q2", label: "R2 q2", type: "text" },
          ],
        },
      },
    });
    const { pid } = await import_body(env, api, "n2g", body, {
      "snapshots/plan-R1.json": snapshot("plan", 1, [], {
        round: 1,
        summary: "r1",
        questions: [{ id: "q1", label: "R1 q1", type: "text" }],
      }),
      [R1_PATH]: feedback("review", 1, { q1: "a-one", q2: "a-two", q2__other: "c-two" }, "plan-R1-review"),
    });
    const [view] = submissions_view(env, pid);
    assert.ok(view);
    const by_value = new Map(view.answers.map((a) => [a.value, a]));
    assert.equal(by_value.get("a-one")?.text, "R1 q1", "the question that the snapshot has is exact");
    assert.equal(by_value.get("a-two")?.origin, "import", "the one it lacks is a placeholder");
    assert.notEqual(by_value.get("a-two")?.text, "R2 q2");
    assert.equal(view.addenda.length, 1);
    assert.equal(view.addenda[0]!.text, by_value.get("a-two")!.text, "the addendum follows its own question");
    assert.ok(!set_member_texts(env, view.set_id).some((t) => t.startsWith("R2 ")), "the set is not the R2 review set");
  });
});

function resume_form(round: number, label: string): Record<string, unknown> {
  return {
    id: "plan-resume",
    kind: "resume",
    stage: "plan",
    round,
    title: "resume",
    inherited: [],
    questions: [{ id: "rs", label, type: "text" }],
  };
}

test("N2h: a resume answer of round 1 does not attach to the round-2 resume form; the same round does (control)", async () => {
  await with_legacy(async (env, api) => {
    const files = {
      "ask/plan-resume.json": resume_form(2, "R2 resume question"),
      "feedback/plan-R1-20260302-100001.json": feedback("resume", 1, { rs: "old resume answer" }, "plan-resume-R1"),
      "feedback/plan-R2-20260302-100002.json": feedback("resume", 2, { rs: "new resume answer" }, "plan-resume"),
    };
    const { result, pid } = await import_body(env, api, "n2h", project("synthetic-final2-resume", { plan: { round: 3 } }), files);
    const [old_view, new_view] = submissions_view(env, pid);
    assert.ok(old_view && new_view);
    assert.deepEqual(old_view.answers.map((a) => a.origin), ["import"], "round 1 answer: placeholder");
    assert.ok(!set_member_texts(env, old_view.set_id).includes("R2 resume question"));
    assert.ok(mismatch_reported(result.report, "feedback/plan-R1-20260302-100001.json"));
    assert.deepEqual(new_view.answers.map((a) => [a.text, a.value]), [["R2 resume question", "new resume answer"]]);
    assert.deepEqual(set_member_texts(env, new_view.set_id), ["R2 resume question"]);
  });
});

test("N2i: another kind is no proof: a 'resume' answer is not attached to a review or stage_start form with the same question id", async () => {
  await with_legacy(async (env, api) => {
    const files = {
      "ask/plan-start.json": {
        id: "plan-start",
        kind: "stage_start",
        stage: "plan",
        round: 2,
        title: "start",
        inherited: [],
        questions: [{ id: "rs", label: "start question", type: "text" }],
      },
      "feedback/plan-R2-20260302-100002.json": feedback("resume", 2, { rs: "resume answer" }),
    };
    const body = project("synthetic-final2-kinds", {
      plan: { round: 3, review: { round: 2, summary: "r2", questions: [{ id: "rs", label: "review question", type: "text" }] } },
    });
    const { pid } = await import_body(env, api, "n2i", body, files);
    const [view] = submissions_view(env, pid);
    assert.ok(view);
    assert.deepEqual(view.answers.map((a) => a.origin), ["import"], "no resume form exists: placeholder");
    const members = set_member_texts(env, view.set_id);
    assert.ok(!members.includes("start question") && !members.includes("review question"));
  });
});

test("N2j: a stage_start answer attaches to the stage_start ask form of its round; a form of another stage is no proof", async () => {
  await with_legacy(async (env, api) => {
    const ask = (stage: string, label: string) => ({
      id: `${stage}-start`,
      kind: "stage_start",
      stage,
      round: 0,
      title: "start",
      inherited: [],
      questions: [{ id: "scope", label, type: "text" }],
    });
    const body = project("synthetic-final2-start", { plan: { round: 1 }, research: { round: 1 } });
    const { pid } = await import_body(env, api, "n2j", body, {
      "ask/plan-start.json": ask("plan", "plan scope"),
      "ask/research-start.json": ask("research", "research scope"),
      "feedback/plan-R0-20260302-100000.json": { ...feedback("stage_start", 0, { scope: "plan answer" }, "plan-start") },
    });
    const [view] = submissions_view(env, pid);
    assert.ok(view);
    assert.deepEqual(view.answers.map((a) => [a.text, a.value]), [["plan scope", "plan answer"]]);
    assert.deepEqual(set_member_texts(env, view.set_id), ["plan scope"]);
  });
});

// ===========================================================================
// N3: duplicated id inside a snapshot's state.items
// ===========================================================================

test("N3: a duplicated id in a snapshot: the second record is not an object and is reported with path, pointer and raw record", async () => {
  await with_legacy(async (env, api) => {
    const { result, pid } = await import_body(env, api, "n3", project("synthetic-final2-dup", { plan: { round: 2, items: [A_CUR, B_CUR] } }), {
      "snapshots/plan-R1.json": snapshot("plan", 1, [
        { id: 1, title: "A first", kind: "rq", status: "new", summary: "first" },
        { id: 1, title: "A duplicate only here", kind: "rq", status: "new", summary: "dup" },
        { id: 2, title: "B old", kind: "rq", status: "new", summary: "b old" },
      ]),
    });
    const rows = env.db.all(
      `SELECT 1 FROM artifact_versions av JOIN objects o ON o.id = av.object_id
        WHERE o.project_id = ? AND av.title = 'A duplicate only here'`,
      pid,
    );
    assert.equal(rows.length, 0, "no object / version for the duplicate");
    assert.equal(version_id_of(env, pid, "A first").length > 0, true, "the first record is loaded");
    const hits = reported_at(result.report, "snapshots/plan-R1.json", "/state/items/1");
    assert.equal(hits.length, 1, "one unknown_field entry for the second record");
    assert.ok(JSON.stringify(hits[0]).includes("A duplicate only here"), "the raw record is kept in the report");
    assert.equal(reported_at(result.report, "snapshots/plan-R1.json", "/state/items/0").length, 0, "the first record is not reported");
  });
});

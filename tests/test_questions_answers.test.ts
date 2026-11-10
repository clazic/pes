// SEL-41 (stage 2 PR8): questions and answers, tests written before the implementation.
// The worker matches these names and shapes. Everything is synthetic (FakeClock, temporary HOME).
// Rows from db.get() are null-prototype objects: compare them as { ...row }.
//
// Files (leader decision):
//   scripts/pes_core/commands/questions.ts  frozen QUESTION_COMMAND_ENTRIES (command definitions, all SQL writes);
//                                           commands.ts spreads it into COMMANDS like the other *_COMMAND_ENTRIES.
//   scripts/pes_core/questions.ts           public functions:
//     publish_set / revise_question / submit_answers (service, ctx, input) -> Promise<CommandOutcome>,
//       each exactly ONE service.execute (no SQL writes);
//     validate_submission(db, ctx, input) -> {ok, errors}   read-only, never writes, never throws for a bad
//       input (a bad input is reported in `errors`: [{question_id: string | null, code: ApiError code}]);
//     resume_ready(db, project_id, round_id) -> {ready, missing}   read-only (the PR5/14 shared contract).
//   tests/helpers/command_names.ts          EXPECTED_COMMAND_NAMES gets the 3 names below (kept sorted).
//
// Commands (scope "project", NOT rev-bearing: no base_control_rev). Receipt action == event type.
//   command               action / event type      who
//   question.publish_set  question.set_published   human member, or an agent that holds the lease (guard)
//   question.revise       question.revised         human member, or an agent that holds the lease (guard)
//   answer.submit         answer.submitted         HUMAN member ONLY (an agent -> ApiError "forbidden", with or
//                                                  without a lease guard)
//   Unknown payload fields -> "invalid_payload"; a missing id (or an id of another project) -> "not_found";
//   a wrong state / a stale form -> "conflict". A rejection writes nothing (not even a receipt).
//   "Guard" = {run_id, lease_id, fence} of the agent's active lease (PR5): no guard -> "forbidden", stale fence
//   -> "conflict"; a human needs none. A guarded call's receipt carries run_id, lease_id, fence.
//   "Human" = PR10 rule: actor.kind 'human' (read_credential_actor). An agent that shares the owner's user is
//   still refused.
//
//   question.publish_set  {stage_id, round_id? (null/absent = the stage, no round), purpose: 'stage_start'|
//                          'review'|'resume', form_key, questions: [QuestionSpec, ...] (at least one),
//                          run_id?, lease_id?, fence?}
//     QuestionSpec is EITHER {question_id}  = an existing question included at its CURRENT version,
//                  OR a new question {text, type: single|multi|text|textarea|number|scale|file, required?,
//                    allow_comment_as_answer?, default_value? (JSON, default null), options? (array of
//                    {value, label, recommended?}), show_if?, help?, importance?}; it gets an objects row
//                    (kind 'question') + questions row (asked_by_actor_id = the caller) + version 1 (current,
//                    state 'open'). The tests always send allow_comment_as_answer explicitly.
//     One tx: a question_sets row (version_no = max + 1 per (stage, form_key), previous_set_id = the former
//     latest set of that (stage, form_key) or NULL, published_at = now) + one question_set_members row per spec
//     (position = list index, question_version_id = the version the human will SEE).
//     result {project_id, set_id, set_version_no, stage_id, round_id, form_key,
//             members: [{question_id, question_version_id, position}]}
//
//   question.revise       {question_id, <any of: text, type, required, allow_comment_as_answer, default_value,
//                          options, show_if, help, importance>, run_id?, lease_id?, fence?}
//     appends version_no + 1, the unchanged fields are carried over from the current version, and
//     objects.current_version_id moves to it. The old version row and every answer stay exactly as they were.
//     result {project_id, question_id, question_version_id, version_no}
//
//   answer.submit         {set_id, answers: [{question_id, value?, other?, used_default?}, ...] (at least one)}
//     The questions must be members of THAT set (else "invalid_payload"); a question id twice -> "invalid_payload".
//     A member whose version is no longer the question's CURRENT version (the question was revised after the
//     set was published) -> "conflict" (a stale form: re-publish the set). All-or-nothing: if ANY item is bad
//     nothing is written (no submission, answer, comment, receipt or event).
//       value          the human's choice. single: a string in options; multi: an array of option values;
//                      text/textarea: a string; number/scale: a finite number. Anything else -> "invalid_payload".
//       other          the "__other" / free-comment text (legacy answers[qid + "__other"]). Never a choice.
//       used_default   true only when the human pressed "use the default": the value must then equal the
//                      question's default_value, else "invalid_payload". Not sent -> stored 0 (never inferred).
//     An item needs a value or a non-empty `other`.
//     One tx: ONE submissions row (actor_id = the human, set_id, via = ctx.via, received_at = now, tx_id = the
//     receipt id). Per item with a value (or with `other` on a question whose current version has
//     allow_comment_as_answer = 1): the question's answers row (created on the first answer; ONE answers object
//     per question) + a new answer_versions row (object_versions version_no + 1, question_version_id = the member's
//     version, value = JSON, state 'submitted', used_default 0/1, supersedes_version_id = the former current
//     version or NULL); objects.current_version_id moves. A comment-only item (no value) stores value JSON null.
//     A comment-only item on a question with allow_comment_as_answer = 0 creates NO answer: the text is only kept
//     as a comment (nothing the human wrote is lost, but it is not an answer).
//     Per item with `other`: a minimal threads row (context_kind 'question_comment', target_object_id = the
//     question, target_version_id = the version the human saw) + messages row (submission_id = this submission)
//     + message_versions (body_md = the text, state 'published'). The comment never changes the answer value.
//     result {project_id, submission_id, set_id,
//             answers: [{question_id, answer_id|null, version_id|null, question_version_id, thread_id|null,
//                        message_id|null}]}  one entry per item, in the input order.
//
//   resume_ready(db, project_id, round_id) -> {ready, missing: [{question_id, question_version_id, reason}]}
//     The required questions of a round = the questions that are members of the LATEST set version of each
//     (stage, form_key) whose round_id is this round, judged by the question's CURRENT version: required = 1 and
//     state 'open'. A question is satisfied only when the current version of its answer is 'submitted' AND is
//     pinned to the question's CURRENT version. reason 'unanswered' (no usable answer at all) or
//     'needs_reconfirmation' (the only answers belong to an older question version). question_version_id is the
//     question's current version. A round without sets requires nothing (ready true). Unknown round ->
//     ApiError "not_found". Writes nothing.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { COMMANDS } from "../scripts/pes_core/commands.ts";
import {
  publish_set,
  resume_ready,
  revise_question,
  submit_answers,
  validate_submission,
} from "../scripts/pes_core/questions.ts";
import { EXPECTED_COMMAND_NAMES } from "./helpers/command_names.ts";
import {
  OPTIONS,
  add_agent,
  agent_claim,
  agent_ctx,
  answer_objects_of,
  answer_versions_of,
  comments_of,
  counts,
  events_of,
  members_of,
  number_spec,
  open_round,
  publish,
  question_current,
  question_version,
  receipt_of,
  rejects_api,
  single_spec,
  submit,
  text_spec,
  with_env,
  wrap_db,
  type Env,
  type Guard,
  type PublishResult,
  type ReviseResult,
} from "./helpers/questions_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const QUESTION_COMMANDS = [
  ["question.publish_set", "question.set_published"],
  ["question.revise", "question.revised"],
  ["answer.submit", "answer.submitted"],
] as const;

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "..", "scripts", "pes_core");

function readiness(env: Env, round_id: string) {
  return resume_ready(env.db, env.p.project_id, round_id);
}

function missing_ids(env: Env, round_id: string): string[] {
  return readiness(env, round_id)
    .missing.map((m) => m.question_id)
    .sort();
}

async function revise(env: Env, question_id: string, fields: Record<string, unknown>, key: string): Promise<ReviseResult> {
  const out = await revise_question(env.service, env.ctx(key), { question_id, ...fields });
  assert.equal(out.replayed, false);
  return out.result as ReviseResult;
}

// ---------------------------------------------------------------------------
// Registry

test("the three question/answer commands are registered under their own distinct actions", () => {
  const actions = new Set<string>();
  for (const [name, action] of QUESTION_COMMANDS) {
    const def = COMMANDS.get(name);
    assert.ok(def, `${name} is registered`);
    assert.equal(def.scope, "project");
    assert.equal(def.rev_bearing, false);
    assert.equal(def.action, action);
    actions.add(def.action);
    assert.ok(EXPECTED_COMMAND_NAMES.includes(name), `${name} is in EXPECTED_COMMAND_NAMES`);
  }
  assert.equal(actions.size, QUESTION_COMMANDS.length);
});

// ---------------------------------------------------------------------------
// Publishing a set

test("publish_set stores the set, its members and the first question versions the human will see", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    env.clock.advance(5_000);
    const set = await publish(env, where, [single_spec("합성 질문 1"), text_spec("합성 질문 2", { help: "합성 도움말" })], "pub-1");

    assert.equal(set.set_version_no, 1);
    assert.equal(set.stage_id, where.stage_id);
    assert.equal(set.round_id, where.round_id);
    assert.equal(set.form_key, "main");
    assert.deepEqual(set.members.map((m) => m.position), [0, 1]);

    const row = env.db.get<{
      purpose: string; form_key: string; version_no: bigint; previous_set_id: string | null;
      published_at: bigint; stage_id: string; round_id: string | null;
    }>("SELECT * FROM question_sets WHERE id = ?", set.set_id)!;
    assert.equal(row.purpose, "stage_start");
    assert.equal(row.form_key, "main");
    assert.equal(row.version_no, 1n);
    assert.equal(row.previous_set_id, null);
    assert.equal(row.published_at, BigInt(env.clock.now_ms()));
    assert.equal(row.stage_id, where.stage_id);
    assert.equal(row.round_id, where.round_id);
    assert.deepEqual(members_of(env.db, set.set_id), set.members);

    const [m1, m2] = set.members as [PublishResult["members"][number], PublishResult["members"][number]];
    const q1 = question_version(env.db, m1.question_version_id);
    assert.equal(q1.object_id, m1.question_id);
    assert.equal(q1.text, "합성 질문 1");
    assert.equal(q1.type, "single");
    assert.equal(q1.state, "open");
    assert.equal(q1.required, 1n);
    assert.equal(q1.allow_comment_as_answer, 0n);
    assert.deepEqual(JSON.parse(q1.options), OPTIONS);
    assert.equal(JSON.parse(q1.default_value), "b");
    const q2 = question_version(env.db, m2.question_version_id);
    assert.equal(q2.type, "text");
    assert.equal(q2.required, 0n);
    assert.equal(q2.help, "합성 도움말");

    for (const m of set.members) {
      const obj = env.db.get<{ kind: string; current_version_id: string }>("SELECT kind, current_version_id FROM objects WHERE id = ?", m.question_id)!;
      assert.equal(obj.kind, "question");
      assert.equal(obj.current_version_id, m.question_version_id);
      const q = env.db.get<{ asked_by_actor_id: string; original_version_id: string }>("SELECT asked_by_actor_id, original_version_id FROM questions WHERE object_id = ?", m.question_id)!;
      assert.equal(q.asked_by_actor_id, env.p.actor_id);
      assert.equal(q.original_version_id, m.question_version_id);
    }

    // nothing was answered by publishing
    const c = counts(env.db);
    assert.equal(c.submissions, 0n);
    assert.equal(c.answers, 0n);
    assert.equal(c.answer_versions, 0n);

    const receipt = receipt_of(env.db, env.p.project_id, "pub-1")!;
    assert.equal(receipt.action, "question.set_published");
    assert.equal(events_of(env.db, receipt.id)[0]!.type, "question.set_published");
  });
});

// ---------------------------------------------------------------------------
// 1. An answer is pinned to the form (set) and the question version the human actually saw

test("an answer is pinned to the exact set and question versions that were shown; the submission is the human's receipt", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [single_spec("합성 질문 1"), text_spec("합성 질문 2")], "pub-1");
    const [m1, m2] = set.members as [PublishResult["members"][number], PublishResult["members"][number]];
    env.clock.advance(60_000);

    const done = await submit(env, set.set_id, [
      { question_id: m1.question_id, value: "c" },
      { question_id: m2.question_id, value: "합성 자유 답" },
    ], "sub-1");
    assert.equal(done.set_id, set.set_id);
    assert.deepEqual(done.answers.map((a) => a.question_id), [m1.question_id, m2.question_id]);

    const sub = env.db.get<{ actor_id: string; set_id: string; via: string; received_at: bigint; tx_id: string }>(
      "SELECT actor_id, set_id, via, received_at, tx_id FROM submissions WHERE id = ?", done.submission_id)!;
    const receipt = receipt_of(env.db, env.p.project_id, "sub-1")!;
    assert.equal(sub.actor_id, env.p.actor_id, "the human submitted");
    assert.equal(sub.set_id, set.set_id);
    assert.equal(sub.via, "cli");
    assert.equal(sub.received_at, BigInt(env.clock.now_ms()));
    assert.equal(sub.tx_id, receipt.id);
    assert.equal(receipt.action, "answer.submitted");
    assert.equal(events_of(env.db, receipt.id)[0]!.type, "answer.submitted");

    for (const [i, m] of [m1, m2].entries()) {
      const versions = answer_versions_of(env.db, m.question_id);
      assert.equal(versions.length, 1);
      const v = versions[0]!;
      assert.equal(v.question_version_id, m.question_version_id, "pinned to the version shown in the set");
      assert.equal(v.state, "submitted");
      assert.equal(v.supersedes_version_id, null);
      assert.equal(v.version_no, 1n);
      assert.equal(v.actor_id, env.p.actor_id);
      assert.equal(done.answers[i]!.version_id, v.version_id);
      assert.equal(done.answers[i]!.question_version_id, m.question_version_id);
      const objs = answer_objects_of(env.db, m.question_id);
      assert.equal(objs.length, 1);
      assert.equal(objs[0]!.submission_id, done.submission_id);
      assert.equal(objs[0]!.respondent_actor_id, env.p.actor_id);
      assert.equal(objs[0]!.current_version_id, v.version_id);
    }
    assert.equal(answer_versions_of(env.db, m1.question_id)[0]!.value, JSON.stringify("c"));
    assert.equal(answer_versions_of(env.db, m2.question_id)[0]!.value, JSON.stringify("합성 자유 답"));
    assert.equal(counts(env.db).submissions, 1n, "one bundle is one submission");
  });
});

test("a second submission supersedes the first answer but keeps it", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [single_spec("합성 질문 1")], "pub-1");
    const q = set.members[0]!;
    await submit(env, set.set_id, [{ question_id: q.question_id, value: "a" }], "sub-1");
    env.clock.advance(1_000);
    await submit(env, set.set_id, [{ question_id: q.question_id, value: "c" }], "sub-2");

    assert.equal(answer_objects_of(env.db, q.question_id).length, 1, "one answer object per question");
    const [v1, v2] = answer_versions_of(env.db, q.question_id) as [ReturnType<typeof answer_versions_of>[number], ReturnType<typeof answer_versions_of>[number]];
    assert.equal(v1.value, JSON.stringify("a"), "the first answer is kept");
    assert.equal(v1.version_no, 1n);
    assert.equal(v2.value, JSON.stringify("c"));
    assert.equal(v2.version_no, 2n);
    assert.equal(v2.supersedes_version_id, v1.version_id);
    assert.equal(answer_objects_of(env.db, q.question_id)[0]!.current_version_id, v2.version_id);
    assert.equal(counts(env.db).submissions, 2n);
    assert.equal(readiness(env, where.round_id).ready, true);
  });
});

// ---------------------------------------------------------------------------
// 2. A new question version does not inherit the old answer and asks for reconfirmation

test("revising a question keeps the old answer, does not carry it over, and asks for reconfirmation", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set1 = await publish(env, where, [single_spec("합성 질문 1"), text_spec("합성 질문 2")], "pub-1");
    const [m1, m2] = set1.members as [PublishResult["members"][number], PublishResult["members"][number]];
    await submit(env, set1.set_id, [
      { question_id: m1.question_id, value: "a" },
      { question_id: m2.question_id, value: "합성 답" },
    ], "sub-1");
    assert.equal(readiness(env, where.round_id).ready, true);

    const old_version = { ...question_version(env.db, m1.question_version_id) };
    const answers_before = JSON.stringify(answer_versions_of(env.db, m1.question_id));
    const members_before = JSON.stringify(members_of(env.db, set1.set_id));

    const revised = await revise(env, m1.question_id, {
      text: "합성 질문 1 (고침)",
      options: [...OPTIONS, { value: "d", label: "합성 선택 D" }],
    }, "rev-1");
    assert.equal(revised.version_no, 2);
    assert.notEqual(revised.question_version_id, m1.question_version_id);
    assert.equal(question_current(env.db, m1.question_id), revised.question_version_id);

    const fresh = question_version(env.db, revised.question_version_id);
    assert.equal(fresh.text, "합성 질문 1 (고침)");
    assert.equal(fresh.type, "single", "unchanged fields are carried over");
    assert.equal(fresh.required, 1n);
    assert.equal(JSON.parse(fresh.options).length, 4);
    assert.deepEqual({ ...question_version(env.db, m1.question_version_id) }, old_version, "the old version row is untouched");
    assert.equal(JSON.stringify(answer_versions_of(env.db, m1.question_id)), answers_before, "the old answer is preserved as it was");
    assert.equal(JSON.stringify(members_of(env.db, set1.set_id)), members_before, "the old set still lists the version the human saw");

    // the old answer is not inherited
    const r = readiness(env, where.round_id);
    assert.equal(r.ready, false);
    assert.deepEqual(r.missing.map((m) => ({ ...m })), [
      { question_id: m1.question_id, question_version_id: revised.question_version_id, reason: "needs_reconfirmation" },
    ]);

    const receipt = receipt_of(env.db, env.p.project_id, "rev-1")!;
    assert.equal(receipt.action, "question.revised");
    assert.equal(events_of(env.db, receipt.id)[0]!.type, "question.revised");
  });
});

test("a set published before a revision is stale: answering it is refused, a re-published set restores the flow", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set1 = await publish(env, where, [single_spec("합성 질문 1"), text_spec("합성 질문 2")], "pub-1");
    const [m1, m2] = set1.members as [PublishResult["members"][number], PublishResult["members"][number]];
    await submit(env, set1.set_id, [
      { question_id: m1.question_id, value: "a" },
      { question_id: m2.question_id, value: "합성 답" },
    ], "sub-1");
    const revised = await revise(env, m1.question_id, { text: "합성 질문 1 (고침)" }, "rev-1");

    // the human still looks at the old form: refused, nothing written
    const before = state_signature(env.db);
    await rejects_api(
      submit_answers(env.service, env.ctx("sub-stale"), { set_id: set1.set_id, answers: [{ question_id: m1.question_id, value: "c" }] }),
      "conflict",
    );
    assert.equal(state_signature(env.db), before);

    // re-publish: the revised question at its new version, the unchanged one at its current version
    const set2 = await publish(env, where, [{ question_id: m1.question_id }, { question_id: m2.question_id }], "pub-2");
    assert.equal(set2.set_version_no, 2);
    const row = env.db.get<{ previous_set_id: string | null }>("SELECT previous_set_id FROM question_sets WHERE id = ?", set2.set_id)!;
    assert.equal(row.previous_set_id, set1.set_id);
    assert.deepEqual(set2.members.map((m) => [m.question_id, m.question_version_id]), [
      [m1.question_id, revised.question_version_id],
      [m2.question_id, m2.question_version_id],
    ]);
    assert.deepEqual(members_of(env.db, set1.set_id).map((m) => m.question_version_id), [m1.question_version_id, m2.question_version_id]);
    assert.deepEqual(missing_ids(env, where.round_id), [m1.question_id], "still unconfirmed until the human answers the new form");

    await submit(env, set2.set_id, [{ question_id: m1.question_id, value: "c" }], "sub-2");
    const [old_answer, new_answer] = answer_versions_of(env.db, m1.question_id) as [ReturnType<typeof answer_versions_of>[number], ReturnType<typeof answer_versions_of>[number]];
    assert.equal(old_answer.question_version_id, m1.question_version_id, "the old answer stays pinned to the old version");
    assert.equal(new_answer.question_version_id, revised.question_version_id);
    assert.equal(new_answer.supersedes_version_id, old_answer.version_id);
    assert.equal(readiness(env, where.round_id).ready, true);
  });
});

// ---------------------------------------------------------------------------
// 3. A comment alone is not an answer, except for questions that allow it

test("a comment alone is kept but is not an answer unless the question allows comment-as-answer", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [
      single_spec("합성 질문 닫힘", { allow_comment_as_answer: false }),
      single_spec("합성 질문 열림", { allow_comment_as_answer: true }),
    ], "pub-1");
    const [closed, open] = set.members as [PublishResult["members"][number], PublishResult["members"][number]];

    // closed: the comment is saved as a comment, no answer exists, the round is not ready
    const first = await submit(env, set.set_id, [{ question_id: closed.question_id, other: "합성 덧붙임 (닫힘)" }], "sub-1");
    assert.equal(first.answers[0]!.answer_id, null);
    assert.equal(first.answers[0]!.version_id, null);
    assert.ok(first.answers[0]!.thread_id);
    assert.ok(first.answers[0]!.message_id);
    assert.equal(answer_objects_of(env.db, closed.question_id).length, 0);
    assert.equal(answer_versions_of(env.db, closed.question_id).length, 0);
    const kept = comments_of(env.db, closed.question_id);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.body_md, "합성 덧붙임 (닫힘)");
    assert.deepEqual(missing_ids(env, where.round_id), [closed.question_id, open.question_id].sort());
    assert.ok(readiness(env, where.round_id).missing.every((m) => m.reason === "unanswered"));

    // open: the comment alone counts as the answer, but its value is null (not a choice)
    const second = await submit(env, set.set_id, [{ question_id: open.question_id, other: "합성 덧붙임 (열림)" }], "sub-2");
    assert.ok(second.answers[0]!.version_id);
    const versions = answer_versions_of(env.db, open.question_id);
    assert.equal(versions.length, 1);
    assert.equal(versions[0]!.value, "null");
    assert.equal(versions[0]!.state, "submitted");
    assert.equal(versions[0]!.question_version_id, open.question_version_id);
    assert.equal(comments_of(env.db, open.question_id).length, 1);
    assert.deepEqual(missing_ids(env, where.round_id), [closed.question_id], "only the question that allows it was satisfied by a comment");

    // a real choice plus a comment satisfies the closed question
    await submit(env, set.set_id, [{ question_id: closed.question_id, value: "c", other: "합성 덧붙임 (선택과 함께)" }], "sub-3");
    assert.equal(answer_versions_of(env.db, closed.question_id)[0]!.value, JSON.stringify("c"));
    assert.equal(readiness(env, where.round_id).ready, true);
  });
});

// ---------------------------------------------------------------------------
// 4. Defaults and recommendations are never filled in as answers

test("a default value or a recommendation is never turned into an answer; used_default only when the human chose it", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [
      single_spec("합성 질문 1"),
      single_spec("합성 질문 2"),
      single_spec("합성 질문 3"),
      single_spec("합성 질문 4", { default_value: null }),
      single_spec("합성 질문 5"),
    ], "pub-1");
    const q = set.members.map((m) => m.question_id) as [string, string, string, string, string];

    // published, nothing submitted: no answer of any kind, the round waits
    let c = counts(env.db);
    assert.equal(c.submissions, 0n);
    assert.equal(c.answers, 0n);
    assert.equal(c.answer_versions, 0n);
    assert.equal(readiness(env, where.round_id).ready, false);
    assert.deepEqual(missing_ids(env, where.round_id), [...q].sort());
    assert.ok(readiness(env, where.round_id).missing.every((m) => m.reason === "unanswered"));

    // the human presses "use the default" on 1 (recorded), picks the same value on 2 (not a default use),
    // and picks the recommended option on 5 (an ordinary choice)
    await submit(env, set.set_id, [{ question_id: q[0], value: "b", used_default: true }], "sub-1");
    await submit(env, set.set_id, [{ question_id: q[1], value: "b" }], "sub-2");
    await submit(env, set.set_id, [{ question_id: q[4], value: "a" }], "sub-5");
    assert.equal(answer_versions_of(env.db, q[0])[0]!.used_default, 1n);
    assert.equal(answer_versions_of(env.db, q[1])[0]!.used_default, 0n);
    assert.equal(answer_versions_of(env.db, q[4])[0]!.used_default, 0n);

    // not sent -> not answered, however obvious the default or recommendation is
    assert.equal(answer_versions_of(env.db, q[2]).length, 0);
    assert.equal(answer_versions_of(env.db, q[3]).length, 0);
    assert.deepEqual(missing_ids(env, where.round_id), [q[2], q[3]].sort());

    // used_default must really be the default; there must be a default
    const before = state_signature(env.db);
    await rejects_api(
      submit_answers(env.service, env.ctx("bad-1"), { set_id: set.set_id, answers: [{ question_id: q[2], value: "c", used_default: true }] }),
      "invalid_payload",
    );
    await rejects_api(
      submit_answers(env.service, env.ctx("bad-2"), { set_id: set.set_id, answers: [{ question_id: q[3], value: "a", used_default: true }] }),
      "invalid_payload",
    );
    assert.equal(state_signature(env.db), before);
    c = counts(env.db);
    assert.equal(c.answers, 3n);
  });
});

// ---------------------------------------------------------------------------
// 5. A bundle submission is all or nothing

test("a bundle with one bad item in the middle writes nothing at all", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [single_spec("합성 질문 1"), number_spec("합성 질문 2"), text_spec("합성 질문 3")], "pub-1");
    const other = await publish(env, where, [text_spec("합성 다른 폼 질문")], "pub-2", { form_key: "extra" });
    const [qs, qn, qt] = set.members.map((m) => m.question_id) as [string, string, string];
    const outsider = other.members[0]!.question_id;
    const before = state_signature(env.db);

    const bad_inputs: [string, Record<string, unknown>[], string[]][] = [
      ["a number question gets text", [{ question_id: qs, value: "a" }, { question_id: qn, value: "not a number" }, { question_id: qt, value: "x" }], ["invalid_payload"]],
      ["a single choice outside the options", [{ question_id: qt, value: "x" }, { question_id: qs, value: "zzz" }, { question_id: qn, value: 3 }], ["invalid_payload"]],
      ["a question of another set", [{ question_id: qs, value: "a" }, { question_id: outsider, value: "x" }], ["invalid_payload"]],
      ["the same question twice", [{ question_id: qs, value: "a" }, { question_id: qs, value: "b" }], ["invalid_payload"]],
      ["an item with neither value nor comment", [{ question_id: qs, value: "a" }, { question_id: qt }], ["invalid_payload"]],
    ];
    for (const [label, answers, codes] of bad_inputs) {
      await rejects_api(submit_answers(env.service, env.ctx(`bad-${label}`), { set_id: set.set_id, answers }), ...codes);
      assert.equal(state_signature(env.db), before, `${label}: nothing changed (no submission, answer, comment, receipt or event)`);
    }
    await rejects_api(submit_answers(env.service, env.ctx("bad-empty"), { set_id: set.set_id, answers: [] }), "invalid_payload");
    await rejects_api(submit_answers(env.service, env.ctx("bad-set"), { set_id: "no-such-set", answers: [{ question_id: qs, value: "a" }] }), "not_found");
    assert.equal(state_signature(env.db), before);

    // the good bundle goes through whole, and a rejected key can be used again
    const done = await submit(env, set.set_id, [
      { question_id: qs, value: "a" },
      { question_id: qn, value: 3 },
      { question_id: qt, value: "x" },
    ], "bad-the same question twice");
    assert.equal(done.answers.length, 3);
    assert.equal(counts(env.db).submissions, 1n);
    assert.equal(counts(env.db).answer_versions, 3n);
  });
});

test("a failure after some answers were written rolls the whole bundle back", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [
      single_spec("합성 질문 1", { allow_comment_as_answer: true }),
      number_spec("합성 질문 2"),
      text_spec("합성 질문 3"),
    ], "pub-1");
    const [a, b, c] = set.members.map((m) => m.question_id) as [string, string, string];
    const answers = [
      { question_id: a, value: "a", other: "합성 기타 의견" },
      { question_id: b, value: 3 },
      { question_id: c, value: "x" },
    ];
    const before = state_signature(env.db);

    let versions = 0;
    const second_version_fails = wrap_db(env.db, (sql) => {
      if (/INSERT INTO answer_versions/i.test(sql)) {
        versions += 1;
        if (versions === 2) throw new Error("injected failure");
      }
    });
    await assert.rejects(submit_answers(env.with_db(second_version_fails), env.ctx("sub-1"), { set_id: set.set_id, answers }));
    assert.equal(state_signature(env.db), before, "the first answer, the submission and the comment are gone");

    let messages = 0;
    const second_step_fails = wrap_db(env.db, (sql) => {
      if (/INSERT INTO message_versions/i.test(sql)) {
        messages += 1;
        throw new Error("injected failure");
      }
    });
    await assert.rejects(submit_answers(env.with_db(second_step_fails), env.ctx("sub-1"), { set_id: set.set_id, answers }));
    assert.ok(messages >= 1, "the comment path was reached");
    assert.equal(state_signature(env.db), before);

    const ok = await submit_answers(env.service, env.ctx("sub-1"), { set_id: set.set_id, answers });
    assert.equal(ok.replayed, false, "the same key can run again after a rollback");
    assert.equal(counts(env.db).answer_versions, 3n);
  });
});

test("validate_submission reports problems without writing and agrees with submit_answers", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [single_spec("합성 질문 1"), number_spec("합성 질문 2")], "pub-1");
    const [qs, qn] = set.members.map((m) => m.question_id) as [string, string];
    const before = state_signature(env.db);

    const good = validate_submission(env.db, env.ctx("v-1"), { set_id: set.set_id, answers: [{ question_id: qs, value: "a" }, { question_id: qn, value: 2 }] });
    assert.equal(good.ok, true);
    assert.deepEqual(good.errors, []);

    const bad_input = { set_id: set.set_id, answers: [{ question_id: qs, value: "a" }, { question_id: qn, value: "abc" }] };
    const bad = validate_submission(env.db, env.ctx("v-2"), bad_input);
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.errors.map((e) => ({ ...e })), [{ question_id: qn, code: "invalid_payload" }]);
    assert.equal(state_signature(env.db), before, "validation writes nothing");

    await rejects_api(submit_answers(env.service, env.ctx("v-3"), bad_input), bad.errors[0]!.code);
    assert.equal(state_signature(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// 6. "__other" never turns into agreement with the recommendation

test("an __other text is kept as a minimal thread and message and never becomes the recommended choice", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [
      single_spec("합성 질문 1", { allow_comment_as_answer: true }),
      single_spec("합성 질문 2"),
    ], "pub-1");
    const [m1, m2] = set.members as [PublishResult["members"][number], PublishResult["members"][number]];
    const question_before = JSON.stringify([question_version(env.db, m1.question_version_id), question_version(env.db, m2.question_version_id)], (_k, v) => (typeof v === "bigint" ? `${v}n` : v));

    // "other" alone: "a" is the recommended option and "b" the default, the answer is neither
    const done = await submit(env, set.set_id, [{ question_id: m1.question_id, other: "합성 기타: 둘 다 아님" }], "sub-1");
    const answer = answer_versions_of(env.db, m1.question_id);
    assert.equal(answer.length, 1);
    assert.equal(answer[0]!.value, "null", "the value is empty, not the recommendation and not the default");
    assert.notEqual(JSON.parse(answer[0]!.value), "a");
    assert.notEqual(JSON.parse(answer[0]!.value), "b");
    assert.equal(answer[0]!.used_default, 0n);

    const comments = comments_of(env.db, m1.question_id);
    assert.equal(comments.length, 1);
    const note = comments[0]!;
    assert.equal(note.body_md, "합성 기타: 둘 다 아님");
    assert.equal(note.context_kind, "question_comment");
    assert.equal(note.target_object_id, m1.question_id);
    assert.equal(note.target_version_id, m1.question_version_id, "the comment points at the version the human saw");
    assert.equal(note.submission_id, done.submission_id);
    assert.equal(note.message_state, "published");
    assert.equal(note.actor_id, env.p.actor_id);
    assert.equal(done.answers[0]!.thread_id, note.thread_id);
    assert.equal(done.answers[0]!.message_id, note.message_id);

    // a choice plus "other": the choice is the answer, the text stays a separate comment
    await submit(env, set.set_id, [{ question_id: m2.question_id, value: "c", other: "합성 기타: 선택에 덧붙임" }], "sub-2");
    assert.equal(answer_versions_of(env.db, m2.question_id)[0]!.value, JSON.stringify("c"));
    assert.equal(comments_of(env.db, m2.question_id)[0]!.body_md, "합성 기타: 선택에 덧붙임");

    // the question versions (options, recommendation, default) were never touched
    const question_after = JSON.stringify([question_version(env.db, m1.question_version_id), question_version(env.db, m2.question_version_id)], (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
    assert.equal(question_after, question_before);
    // only the two comment threads exist
    assert.equal(counts(env.db).threads, 2n);
    assert.equal(counts(env.db).messages, 2n);
  });
});

// ---------------------------------------------------------------------------
// resume_ready (shared PR5/14 contract)

test("resume_ready counts only the latest set of each form of the round, required questions, and writes nothing", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const empty = readiness(env, where.round_id);
    assert.deepEqual({ ready: empty.ready, missing: empty.missing }, { ready: true, missing: [] }, "a round without sets requires nothing");

    const main = await publish(env, where, [single_spec("합성 필수 A"), text_spec("합성 선택 O")], "pub-main");
    const extra = await publish(env, where, [single_spec("합성 필수 B")], "pub-extra", { form_key: "extra", purpose: "review" });
    const [qa, qo] = main.members.map((m) => m.question_id) as [string, string];
    const qb = extra.members[0]!.question_id;
    assert.deepEqual(missing_ids(env, where.round_id), [qa, qb].sort(), "the optional question never blocks");

    const before = state_signature(env.db);
    resume_ready(env.db, env.p.project_id, where.round_id);
    assert.equal(state_signature(env.db), before, "reading writes nothing");

    await submit(env, main.set_id, [{ question_id: qa, value: "a" }], "sub-a");
    assert.deepEqual(missing_ids(env, where.round_id), [qb]);
    assert.equal(readiness(env, where.round_id).ready, false);
    await submit(env, extra.set_id, [{ question_id: qb, value: "c" }], "sub-b");
    const done = readiness(env, where.round_id);
    assert.deepEqual({ ready: done.ready, missing: done.missing }, { ready: true, missing: [] });
    assert.equal(answer_versions_of(env.db, qo).length, 0, "the optional question stays unanswered");

    const settled = state_signature(env.db);
    await assert.rejects(async () => resume_ready(env.db, env.p.project_id, "no-such-round"), (e: unknown) => (e as { code?: string }).code === "not_found");
    assert.equal(state_signature(env.db), settled, "a failed read writes nothing either");
  });
});

// ---------------------------------------------------------------------------
// 7. Who may do what (PR10 / PR5 rules)

test("an agent that holds the lease may publish and revise questions; without a guard or with a stale fence it may not", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const base = add_agent(env);
    const lease = await agent_claim(env, base, "agent-claim");
    const guard: Guard = { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence };

    const before = state_signature(env.db);
    await rejects_api(publish(env, where, [single_spec("합성 질문")], "agent-noguard", {}, agent_ctx(base, "agent-noguard")), "forbidden");
    await rejects_api(
      publish(env, where, [single_spec("합성 질문")], "agent-stale", { ...guard, fence: guard.fence + 1 }, agent_ctx(base, "agent-stale")),
      "conflict",
    );
    assert.equal(state_signature(env.db), before, "refused agent commands write nothing, not even a receipt");

    const set = await publish(env, where, [single_spec("합성 질문")], "agent-pub", { ...guard }, agent_ctx(base, "agent-pub"));
    const q = set.members[0]!;
    const receipt = receipt_of(env.db, env.p.project_id, "agent-pub")!;
    assert.equal(receipt.run_id, lease.run_id);
    assert.equal(receipt.lease_id, lease.lease_id);
    assert.equal(receipt.fence, BigInt(lease.fence));
    assert.equal(events_of(env.db, receipt.id)[0]!.run_id, lease.run_id);
    const asked = env.db.get<{ asked_by_actor_id: string; direction: string }>("SELECT asked_by_actor_id, direction FROM questions WHERE object_id = ?", q.question_id)!;
    assert.equal(asked.asked_by_actor_id, base.actor_id, "the question is the agent's");
    assert.equal(asked.direction, "agent_to_human");
    const ver = env.db.get<{ actor_id: string; run_id: string | null }>("SELECT actor_id, run_id FROM object_versions WHERE id = ?", q.question_version_id)!;
    assert.equal(ver.actor_id, base.actor_id);
    assert.equal(ver.run_id, lease.run_id);

    // revising: same guard rule
    const mid = state_signature(env.db);
    await rejects_api(revise_question(env.service, agent_ctx(base, "agent-rev-noguard"), { question_id: q.question_id, text: "고침" }), "forbidden");
    assert.equal(state_signature(env.db), mid);
    const out = await revise_question(env.service, agent_ctx(base, "agent-rev"), { question_id: q.question_id, text: "합성 질문 (에이전트가 고침)", ...guard });
    assert.equal((out.result as ReviseResult).version_no, 2);
    assert.equal(receipt_of(env.db, env.p.project_id, "agent-rev")!.lease_id, lease.lease_id);
    assert.equal(counts(env.db).answers, 0n, "asking is not answering");
  });
});

test("an agent cannot answer, with or without a lease guard; only the human can", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const base = add_agent(env);
    const lease = await agent_claim(env, base, "agent-claim");
    const guard: Guard = { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence };
    const set = await publish(env, where, [single_spec("합성 질문")], "agent-pub", { ...guard }, agent_ctx(base, "agent-pub"));
    const q = set.members[0]!;

    const before = state_signature(env.db);
    const answers = [{ question_id: q.question_id, value: "a" }];
    await rejects_api(submit_answers(env.service, agent_ctx(base, "agent-ans-1"), { set_id: set.set_id, answers }), "forbidden");
    await rejects_api(submit_answers(env.service, agent_ctx(base, "agent-ans-2"), { set_id: set.set_id, answers, ...guard }), "forbidden");
    assert.equal(state_signature(env.db), before);
    assert.equal(counts(env.db).answers, 0n);
    assert.equal(readiness(env, where.round_id).ready, false);

    await submit(env, set.set_id, answers, "human-ans");
    assert.equal(answer_versions_of(env.db, q.question_id)[0]!.actor_id, env.p.actor_id);
    assert.equal(readiness(env, where.round_id).ready, true);
  });
});

// ---------------------------------------------------------------------------
// PR4 rules for the new commands: policy first, replay, rollback, receipt + events in one tx

test("policy is checked first and a denied command writes nothing", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [single_spec("합성 질문")], "pub-1");
    const q = set.members[0]!;
    await submit(env, set.set_id, [{ question_id: q.question_id, value: "a" }], "sub-1");

    env.policy.allowed = false;
    const before = state_signature(env.db);
    const calls = [
      () => publish_set(env.service, env.ctx("p-pub"), { stage_id: where.stage_id, round_id: where.round_id, purpose: "review", form_key: "x", questions: [single_spec("합성")] }),
      () => revise_question(env.service, env.ctx("p-rev"), { question_id: q.question_id, text: "고침" }),
      () => submit_answers(env.service, env.ctx("p-sub"), { set_id: set.set_id, answers: [{ question_id: q.question_id, value: "c" }] }),
    ];
    for (const call of calls) await rejects_api(call(), "policy_denied");
    assert.equal(state_signature(env.db), before);

    // a reply stored while policy was ON is not replayed while policy is OFF
    await rejects_api(submit_answers(env.service, env.ctx("sub-1"), { set_id: set.set_id, answers: [{ question_id: q.question_id, value: "a" }] }), "policy_denied");
    env.policy.allowed = true;
  });
});

test("the same key and request replays the stored result and writes nothing; the same key with another request is refused", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const spec = { stage_id: where.stage_id, round_id: where.round_id, purpose: "stage_start", form_key: "main", questions: [single_spec("합성 질문")] };
    const first = await publish_set(env.service, env.ctx("k-pub"), spec);
    const set = first.result as PublishResult;
    const q = set.members[0]!;
    const after_publish = counts(env.db);
    const again = await publish_set(env.service, env.ctx("k-pub"), spec);
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, first.result);
    assert.deepEqual(counts(env.db), after_publish, "a replay writes no second set, question, receipt or event");
    await rejects_api(publish_set(env.service, env.ctx("k-pub"), { ...spec, form_key: "other" }), "idempotency_key_reuse");

    const answers = [{ question_id: q.question_id, value: "a" }];
    const s1 = await submit_answers(env.service, env.ctx("k-sub"), { set_id: set.set_id, answers });
    const after_submit = counts(env.db);
    const s2 = await submit_answers(env.service, env.ctx("k-sub"), { set_id: set.set_id, answers });
    assert.equal(s2.replayed, true);
    assert.deepEqual(s2.result, s1.result);
    assert.deepEqual(counts(env.db), after_submit, "a duplicate submission creates no second answer");
    assert.equal(answer_versions_of(env.db, q.question_id).length, 1);
    await rejects_api(submit_answers(env.service, env.ctx("k-sub"), { set_id: set.set_id, answers: [{ question_id: q.question_id, value: "c" }] }), "idempotency_key_reuse");

    const r1 = await revise_question(env.service, env.ctx("k-rev"), { question_id: q.question_id, text: "고침" });
    const after_revise = counts(env.db);
    const r2 = await revise_question(env.service, env.ctx("k-rev"), { question_id: q.question_id, text: "고침" });
    assert.equal(r2.replayed, true);
    assert.deepEqual(r2.result, r1.result);
    assert.deepEqual(counts(env.db), after_revise);
    assert.equal(question_current(env.db, q.question_id), (r1.result as ReviseResult).question_version_id);
  });
});

test("an event, receipt or middle-of-command failure rolls the whole command back and the same key can run again", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const spec = {
      stage_id: where.stage_id, round_id: where.round_id, purpose: "stage_start", form_key: "main",
      questions: [single_spec("합성 질문 1"), text_spec("합성 질문 2"), text_spec("합성 질문 3")],
    };

    // publish: fails at the second question version -> no set, no question, no member
    const before_pub = state_signature(env.db);
    let q_inserts = 0;
    const fail_mid = wrap_db(env.db, (sql) => {
      if (/INSERT INTO question_versions/i.test(sql)) {
        q_inserts += 1;
        if (q_inserts === 2) throw new Error("injected failure");
      }
    });
    await assert.rejects(publish_set(env.with_db(fail_mid), env.ctx("pub-1"), spec));
    assert.equal(state_signature(env.db), before_pub);
    const fail_events = wrap_db(env.db, (sql) => {
      if (/INSERT INTO events/i.test(sql)) throw new Error("injected failure");
    });
    await assert.rejects(publish_set(env.with_db(fail_events), env.ctx("pub-1"), spec));
    assert.equal(state_signature(env.db), before_pub);
    const set = (await publish_set(env.service, env.ctx("pub-1"), spec)).result as PublishResult;
    const q = set.members[0]!;

    // revise: fails at the receipt insert -> still version 1, still current
    const before_rev = state_signature(env.db);
    const fail_receipt = wrap_db(env.db, (sql) => {
      if (/INSERT INTO mutation_commits/i.test(sql)) throw new Error("injected failure");
    });
    await assert.rejects(revise_question(env.with_db(fail_receipt), env.ctx("rev-1"), { question_id: q.question_id, text: "고침" }));
    assert.equal(state_signature(env.db), before_rev);
    assert.equal(question_current(env.db, q.question_id), q.question_version_id);
    await assert.rejects(revise_question(env.with_db(fail_events), env.ctx("rev-1"), { question_id: q.question_id, text: "고침" }));
    assert.equal(state_signature(env.db), before_rev);
    const ok = await revise_question(env.service, env.ctx("rev-1"), { question_id: q.question_id, text: "고침" });
    assert.equal(ok.replayed, false);
  });
});

test("every successful command leaves its receipt and its events in one transaction", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [single_spec("합성 질문", { allow_comment_as_answer: true })], "k-pub");
    const q = set.members[0]!;
    await revise(env, q.question_id, { text: "합성 질문 (고침)" }, "k-rev");
    const set2 = await publish(env, where, [{ question_id: q.question_id }], "k-pub-2");
    await submit(env, set2.set_id, [{ question_id: q.question_id, value: "a", other: "합성 덧붙임" }], "k-sub");

    for (const [key, action] of [
      ["k-pub", "question.set_published"],
      ["k-rev", "question.revised"],
      ["k-pub-2", "question.set_published"],
      ["k-sub", "answer.submitted"],
    ] as const) {
      const receipt = receipt_of(env.db, env.p.project_id, key);
      assert.ok(receipt, `${key} has a receipt`);
      assert.equal(receipt.action, action);
      const events = events_of(env.db, receipt.id);
      assert.ok(events.length >= 1, `${key} has an event in the same tx`);
      assert.equal(events[0]!.type, action);
    }
    const receipt = receipt_of(env.db, env.p.project_id, "k-sub")!;
    const sizes = env.db.all<{ tx_size: bigint }>("SELECT tx_size FROM events WHERE tx_id = ?", receipt.id);
    for (const row of sizes) assert.equal(row.tx_size, BigInt(sizes.length));
    // the whole submission (answer, comment) hangs on that one receipt
    const tx_rows = env.db.all<{ n: bigint }>("SELECT count(*) AS n FROM object_versions WHERE tx_id = ?", receipt.id);
    assert.ok(tx_rows[0]!.n >= 3n, "answer version, thread version and message version share the receipt");
  });
});

// ---------------------------------------------------------------------------
// Input checks

test("malformed or unknown input is refused before anything is written", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [single_spec("합성 질문")], "pub-1");
    const q = set.members[0]!;
    const before = state_signature(env.db);
    const base = { stage_id: where.stage_id, round_id: where.round_id, purpose: "stage_start", form_key: "main2", questions: [single_spec("합성")] };

    const publishes: [string, Record<string, unknown>, string][] = [
      ["unknown field", { ...base, extra_field: 1 }, "invalid_payload"],
      ["no questions", { ...base, questions: [] }, "invalid_payload"],
      ["empty text", { ...base, questions: [single_spec("")] }, "invalid_payload"],
      ["unknown type", { ...base, questions: [single_spec("합성", { type: "slider" })] }, "invalid_payload"],
      ["unknown purpose", { ...base, purpose: "whenever" }, "invalid_payload"],
      ["empty form_key", { ...base, form_key: "" }, "invalid_payload"],
      ["unknown stage", { ...base, stage_id: "no-such-stage", round_id: null }, "not_found"],
      ["unknown question", { ...base, questions: [{ question_id: "no-such-question" }] }, "not_found"],
    ];
    for (const [label, payload, code] of publishes) {
      await rejects_api(publish_set(env.service, env.ctx(`k-${label}`), payload), code);
    }
    await rejects_api(revise_question(env.service, env.ctx("k-rev-1"), { question_id: q.question_id, extra_field: 1 }), "invalid_payload");
    await rejects_api(revise_question(env.service, env.ctx("k-rev-2"), { question_id: "no-such-question", text: "고침" }), "not_found");
    await rejects_api(revise_question(env.service, env.ctx("k-rev-3"), { question_id: q.question_id, text: "" }), "invalid_payload");
    await rejects_api(submit_answers(env.service, env.ctx("k-sub-1"), { set_id: set.set_id, answers: [{ question_id: q.question_id, value: "a" }], extra_field: 1 }), "invalid_payload");
    await rejects_api(submit_answers(env.service, env.ctx("k-sub-2"), { set_id: set.set_id, answers: "a" }), "invalid_payload");
    await rejects_api(submit_answers(env.service, env.ctx("k-sub-3"), null), "invalid_payload");
    assert.equal(state_signature(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// Source shape

function ts_files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...ts_files(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function strip_comments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("scripts/pes_core/questions.ts holds no SQL writes and each command function is one service.execute", () => {
  const source = strip_comments(readFileSync(join(CORE_DIR, "questions.ts"), "utf8"));
  assert.doesNotMatch(source, /\b(INSERT|UPDATE|DELETE|REPLACE)\b\s+(INTO|FROM|OR)?/i);
  for (const fn of ["publish_set", "revise_question", "submit_answers", "validate_submission", "resume_ready"]) {
    assert.match(source, new RegExp(`export\\s+(async\\s+)?function\\s+${fn}\\b`), `${fn} is exported`);
  }
  assert.equal((source.match(/\.execute\(/g) ?? []).length, 3, "exactly one service.execute per command function");
});

test("no source file updates or deletes question/answer history rows", () => {
  const names = ["question_versions", "question_set_members", "answer_versions", "message_versions", "submissions"].join("|");
  const re = new RegExp(
    `\\bUPDATE\\s+(?:OR\\s+\\w+\\s+)?["\`\\[]?(?:${names})\\b|\\bDELETE\\s+FROM\\s+["\`\\[]?(?:${names})\\b|\\bINSERT\\s+OR\\s+REPLACE\\b|\\bREPLACE\\s+INTO\\b`,
    "gi",
  );
  const files = ts_files(CORE_DIR);
  assert.ok(
    files.some((f) => relative(CORE_DIR, f).replace(/\\/g, "/") === "commands/questions.ts"),
    "scripts/pes_core/commands/questions.ts exists",
  );
  const violations: string[] = [];
  for (const file of files) {
    const source = strip_comments(readFileSync(file, "utf8"));
    for (const m of source.matchAll(re)) violations.push(`${relative(CORE_DIR, file)}: ${m[0].replace(/\s+/g, " ")}`);
  }
  assert.deepEqual(violations, []);
});

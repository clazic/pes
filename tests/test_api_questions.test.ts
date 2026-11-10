/**
 * SEL-47 PR14 — HTTP API: question publish / revise and the answer submission (tester, 작성 모드).
 * Shapes follow docs/plan/fixtures/api-v1 (questions.json, question-revisions.json, submissions.json).
 *
 *   POST P/questions     body {stage_id, round_id|null, purpose, question:{text,type,required,
 *                         allow_comment_as_answer,options,default_value,importance?,...}, direction?,
 *                         form_key? (default "main"), format_version?, run_id?, lease_id?, fence? (decimal STRING)}
 *        owner session: no lease fields. Agent token (scope run:submit): must hold the lease and send
 *        {run_id, lease_id, fence}. One question per call (it becomes the latest set of that form).
 *        -> 201 data {question:{id, version_id, version_no ("1", a decimal string), state:"open",
 *                      asked_by_actor_id, intended_actor_id|null}, question_set_id}
 *        A question that breaks the question rules (bad type, duplicate option value, empty text) is
 *        422 `validation_failed` with the JSON path in `target`; an unknown / missing top-level field is
 *        400 `invalid_payload`. (Question types stay the PR8 core names: single, multi, text, ...;
 *        the documents' "single_choice" is a documented contradiction, see the report.)
 *   POST P/questions/{q}/revisions   body {base_version_id, question:{<fields to change>}, format_version?,
 *                         run_id?, lease_id?, fence?}
 *        -> 201 data {question:{id, version_id, version_no ("2"), state}, recheck_required: true,
 *                      previous_answers_preserved: true}; a stale base_version_id is 409 `rev_conflict`,
 *                      target "$.body.base_version_id", details {expected, current}, next_action "reread_question".
 *   POST P/submissions   body {set_id, answers:[{question_id, question_version_id?, value?, comment?,
 *                         used_default?}], submitted_via?, client_request_id?, format_version?}
 *        owner session ONLY: an agent token is 403 `human_required` (even with every scope and the owner's user).
 *        -> 201 data {submission:{id, received_at, state:"accepted"}, answers:[{question_id,
 *                      answer_version_id, state:"submitted"}]}. submitted_via / client_request_id are accepted
 *        and ignored: the server fixes the channel (`via` = http) and the actor.
 *        A question_version_id that is no longer current: 409 `question_version_changed`, target
 *        "$.body.answers[i].question_version_id", details {expected, current, question_id}, next_action "reread_question".
 *        A value the question does not allow: 422 `validation_failed`, target "$.body.answers[i].value".
 *
 * A refusal writes nothing, not even a receipt.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agent_claims,
  assert_ok,
  call,
  make_agent,
  with_api,
  type ApiEnv,
} from "./helpers/api_env.ts";
import { P, assert_final_error, NEXT_ACTION } from "./helpers/api_flow.ts";
import { open_round, single_spec } from "./helpers/questions_env.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

async function publish_body(env: ApiEnv, extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const { stage_id, round_id } = await open_round(env, `q${env.seq++}`);
  return {
    format_version: "1.0",
    stage_id,
    round_id,
    purpose: "stage_start",
    form_key: "main",
    question: single_spec("합성 질문 하나"),
    ...extra,
  };
}

interface Posted {
  set_id: string;
  question_id: string;
  question_version_id: string;
  stage_id: string;
  round_id: string;
}

async function owner_publishes(env: ApiEnv, extra: Record<string, unknown> = {}): Promise<Posted> {
  const body = await publish_body(env, extra);
  const res = await call(env, { method: "POST", path: P(env, "/questions"), auth: "owner", body });
  const data = assert_ok(res, 201);
  return {
    set_id: data.question_set_id,
    question_id: data.question.id,
    question_version_id: data.question.version_id,
    stage_id: body.stage_id,
    round_id: body.round_id,
  };
}

const answer_body = (q: Posted, extra: Record<string, unknown> = {}, value: unknown = "a") => ({
  set_id: q.set_id,
  answers: [{ question_id: q.question_id, question_version_id: q.question_version_id, value, ...extra }],
});

// ---------------------------------------------------------------------------
// publish

test("the owner publishes a question: 201, the documented shape, one set row asked by the owner", async () => {
  await with_api(async (env) => {
    const body = await publish_body(env);
    const before = table_counts(env.db);
    const res = await call(env, { method: "POST", path: P(env, "/questions"), auth: "owner", body });
    const data = assert_ok(res, 201);
    assert.equal(res.json.replayed, false);
    assert.equal(typeof data.question_set_id, "string");
    assert.equal(typeof data.question.id, "string");
    assert.equal(typeof data.question.version_id, "string");
    assert.equal(data.question.version_no, "1", "version_no is a decimal string");
    assert.equal(data.question.state, "open");
    assert.equal(data.question.asked_by_actor_id, env.p.actor_id);
    assert.ok(data.question.intended_actor_id === null || typeof data.question.intended_actor_id === "string");
    const after = table_counts(env.db);
    assert.equal(after.question_sets - before.question_sets, 1n);
    assert.equal(after.questions - before.questions, 1n);
    assert.equal(after.question_set_members - before.question_set_members, 1n);
    assert.equal(after.mutation_commits - before.mutation_commits, 1n);
    const q = env.db.get<{ asked_by_actor_id: string }>("SELECT asked_by_actor_id FROM questions WHERE object_id = ?", data.question.id);
    assert.equal(q?.asked_by_actor_id, env.p.actor_id);
  });
});

test("an agent publishes only while it holds the lease and names it: lease fields in the body, fence as a string", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "asker");
    const lease = await agent_claims(env, agent);
    const body = await publish_body(env, { direction: "agent_to_human" });
    const guard = { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence };

    const data = assert_ok(await call(env, { method: "POST", path: P(env, "/questions"), auth: { token: agent.token }, body: { ...body, ...guard } }), 201);
    assert.equal(data.question.asked_by_actor_id, agent.actor_id, "the actor is the token's actor, never a body field");
    const receipt = env.db.get<{ run_id: string; lease_id: string; fence: bigint }>(
      "SELECT run_id, lease_id, fence FROM mutation_commits WHERE project_id = ? AND action = 'question.set_published' ORDER BY rowid DESC LIMIT 1",
      env.p.project_id,
    );
    assert.equal(receipt?.run_id, lease.run_id);
    assert.equal(receipt?.lease_id, lease.lease_id);
    assert.equal(String(receipt?.fence), lease.fence);

    const second = { ...body, form_key: "other" };
    const sig = state_signature(env.db);
    assert_final_error(await call(env, { method: "POST", path: P(env, "/questions"), auth: { token: agent.token }, body: second }), 403, "forbidden");
    assert_final_error(
      await call(env, { method: "POST", path: P(env, "/questions"), auth: { token: agent.token }, body: { ...second, ...guard, fence: "999" } }),
      409,
      "conflict",
      { next_action: NEXT_ACTION.conflict },
    );
    assert_final_error(
      await call(env, { method: "POST", path: P(env, "/questions"), auth: { token: agent.token }, body: { ...second, ...guard, fence: Number(lease.fence) } }),
      400,
      "invalid_payload",
      { target: "$.body.fence", next_action: NEXT_ACTION.invalid_payload },
    );
    assert.equal(state_signature(env.db), sig, "refusals write nothing");
  });
});

test("publish credentials: none -> 401, a wrong session -> 401, a token without run:submit -> 403", async () => {
  await with_api(async (env) => {
    const body = await publish_body(env);
    // Make the reader before measuring: creating it writes actor/token rows by itself.
    const reader = await make_agent(env, "reader-only", ["context:read"]);
    const sig = state_signature(env.db);
    assert_final_error(await call(env, { method: "POST", path: P(env, "/questions"), body }), 401, "unauthenticated", { next_action: NEXT_ACTION.unauthenticated });
    assert_final_error(await call(env, { method: "POST", path: P(env, "/questions"), headers: { "x-pes-session": "wrong" }, body }), 401, "unauthenticated");
    assert_final_error(await call(env, { method: "POST", path: P(env, "/questions"), auth: { token: reader.token }, body }), 403, "forbidden");
    assert.equal(state_signature(env.db), sig);
  });
});

test("publish: unknown / missing top-level fields are 400; a question that breaks the rules is 422 validation_failed with a JSON path", async () => {
  await with_api(async (env) => {
    const body = await publish_body(env);
    const sig = state_signature(env.db);
    const post = (b: unknown, key?: string | null) => call(env, { method: "POST", path: P(env, "/questions"), auth: "owner", body: b, key });
    for (const field of ["asked_by_actor_id", "actor_id", "human_id", "via", "questions"]) {
      assert_final_error(await post({ ...body, [field]: "x" }), 400, "invalid_payload", { target: `$.body.${field}`, next_action: NEXT_ACTION.invalid_payload });
    }
    assert_final_error(await post({ ...body, format_version: "2.0" }), 400, "invalid_payload", { target: "$.body.format_version" });
    const { question: _q, ...no_question } = body;
    assert_final_error(await post(no_question), 400, "invalid_payload", { target: "$.body.question" });
    assert_final_error(await post(body, null), 400, "invalid_payload", { target: /idempotency-key/i });
    assert_final_error(await call(env, { method: "POST", path: P(env, "/questions"), auth: "owner", raw: "{not json" }), 400, "invalid_payload");

    const dup = { ...body.question, options: [{ value: "A", label: "첫째" }, { value: "A", label: "둘째" }], default_value: "A" };
    const e = assert_final_error(await post({ ...body, question: dup }), 422, "validation_failed", {
      target: "$.body.question.options[1].value",
      next_action: NEXT_ACTION.validation_failed,
    });
    assert.equal(e.details.reason, "duplicate_value");
    assert.equal(e.details.value, "A");
    assert_final_error(await post({ ...body, question: { ...body.question, type: "single_choice" } }), 422, "validation_failed", { target: "$.body.question.type" });
    assert_final_error(await post({ ...body, question: { ...body.question, text: "" } }), 422, "validation_failed", { target: "$.body.question.text" });
    assert_final_error(await post({ ...body, stage_id: "no-such-stage" }), 404, "not_found");
    assert.equal(state_signature(env.db), sig, "no refusal left a row, a receipt, or an event");
  });
});

test("publishing again with the same key replays the first answer; the same key with another body is 409 idempotency_key_reuse", async () => {
  await with_api(async (env) => {
    const body = await publish_body(env);
    const a = assert_ok(await call(env, { method: "POST", path: P(env, "/questions"), auth: "owner", body, key: "pub-1" }), 201);
    const sig = state_signature(env.db);
    const again = await call(env, { method: "POST", path: P(env, "/questions"), auth: "owner", body, key: "pub-1" });
    assert.equal(again.json.replayed, true);
    assert.deepEqual(assert_ok(again, 201), a);
    assert.equal(state_signature(env.db), sig);
    assert_final_error(
      await call(env, { method: "POST", path: P(env, "/questions"), auth: "owner", body: { ...body, form_key: "changed" }, key: "pub-1" }),
      409,
      "idempotency_key_reuse",
      { next_action: NEXT_ACTION.idempotency_key_reuse },
    );
    assert.equal(state_signature(env.db), sig);
  });
});

// ---------------------------------------------------------------------------
// revise

test("revising appends version 2, keeps version 1 and every answer; the answer is flagged for re-check", async () => {
  await with_api(async (env) => {
    const q = await owner_publishes(env);
    assert_ok(await call(env, { method: "POST", path: P(env, "/submissions"), auth: "owner", body: answer_body(q) }), 201);
    const counts = table_counts(env.db);
    const path = P(env, `/questions/${q.question_id}/revisions`);

    const res = await call(env, {
      method: "POST",
      path,
      auth: "owner",
      body: { format_version: "1.0", base_version_id: q.question_version_id, question: { text: "합성 질문 하나(수정)", importance: "low" } },
    });
    const data = assert_ok(res, 201);
    assert.equal(data.question.id, q.question_id);
    assert.equal(data.question.version_no, "2");
    assert.equal(data.question.state, "open");
    assert.notEqual(data.question.version_id, q.question_version_id);
    assert.equal(data.recheck_required, true);
    assert.equal(data.previous_answers_preserved, true);
    const after = table_counts(env.db);
    assert.equal(after.question_versions - counts.question_versions, 1n);
    assert.equal(after.answer_versions, counts.answer_versions, "the earlier answer stays as it was");
    const old = env.db.get<{ text: string }>("SELECT text FROM question_versions WHERE version_id = ?", q.question_version_id);
    assert.notEqual(old?.text, "합성 질문 하나(수정)");

    // The same base again is stale now: 409 rev_conflict naming the base version.
    const stale = await call(env, { method: "POST", path, auth: "owner", body: { base_version_id: q.question_version_id, question: { text: "또 수정" } } });
    const error = assert_final_error(stale, 409, "rev_conflict", { target: "$.body.base_version_id", next_action: NEXT_ACTION.question_rev_conflict });
    assert.equal(error.details.expected, q.question_version_id);
    assert.equal(error.details.current, data.question.version_id);

    assert_final_error(await call(env, { method: "POST", path, auth: "owner", body: { question: { text: "x" } } }), 400, "invalid_payload", { target: "$.body.base_version_id" });
    assert_final_error(
      await call(env, { method: "POST", path, auth: "owner", body: { question_id: q.question_id, base_version_id: data.question.version_id, question: { text: "x" } } }),
      400,
      "invalid_payload",
      { target: "$.body.question_id" },
    );
    assert_final_error(
      await call(env, { method: "POST", path, auth: "owner", body: { base_version_id: data.question.version_id, question: { type: "single_choice" } } }),
      422,
      "validation_failed",
      { target: "$.body.question.type" },
    );
    assert_final_error(
      await call(env, { method: "POST", path: P(env, "/questions/no-such-question/revisions"), auth: "owner", body: { base_version_id: "x", question: { text: "x" } } }),
      404,
      "not_found",
    );
  });
});

test("an agent revises only while it holds the lease", async () => {
  await with_api(async (env) => {
    const q = await owner_publishes(env);
    const agent = await make_agent(env, "reviser");
    const lease = await agent_claims(env, agent);
    const path = P(env, `/questions/${q.question_id}/revisions`);
    const base = { base_version_id: q.question_version_id, question: { text: "허가된 수정" } };
    assert_final_error(await call(env, { method: "POST", path, auth: { token: agent.token }, body: base }), 403, "forbidden");
    const ok = await call(env, { method: "POST", path, auth: { token: agent.token }, body: { ...base, run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence } });
    assert.equal(assert_ok(ok, 201).question.version_no, "2");
  });
});

// ---------------------------------------------------------------------------
// submissions

test("the owner submits an answer: 201, documented shape, pinned to the question version the form showed, channel fixed by the server", async () => {
  await with_api(async (env) => {
    const q = await owner_publishes(env);
    const before = table_counts(env.db);
    const res = await call(env, {
      method: "POST",
      path: P(env, "/submissions"),
      auth: "owner",
      body: { format_version: "1.0", ...answer_body(q, { comment: "합성 의견" }), submitted_via: "web", client_request_id: "subreq-synthetic-1" },
    });
    const data = assert_ok(res, 201);
    assert.equal(typeof data.submission.id, "string");
    assert.ok(Number.isSafeInteger(data.submission.received_at));
    assert.equal(data.submission.state, "accepted");
    assert.equal(data.answers.length, 1);
    assert.equal(data.answers[0].question_id, q.question_id);
    assert.equal(typeof data.answers[0].answer_version_id, "string");
    assert.equal(data.answers[0].state, "submitted");
    const after = table_counts(env.db);
    assert.equal(after.submissions - before.submissions, 1n);
    assert.equal(after.answers - before.answers, 1n);
    const submission = env.db.get<{ actor_id: string; via: string }>("SELECT actor_id, via FROM submissions WHERE id = ?", data.submission.id);
    assert.equal(submission?.actor_id, env.p.actor_id);
    assert.equal(submission?.via, "http", "submitted_via is informational; the server fixes the channel");
    const pinned = env.db.get<{ question_version_id: string }>("SELECT question_version_id FROM answer_versions WHERE version_id = ?", data.answers[0].answer_version_id);
    assert.equal(pinned?.question_version_id, q.question_version_id);
  });
});

test("an agent token cannot submit answers — 403 human_required even with every scope and the owner's user; nothing is written", async () => {
  await with_api(async (env) => {
    const q = await owner_publishes(env);
    const agent = await make_agent(env, "answerer");
    const lease = await agent_claims(env, agent);
    const sig = state_signature(env.db);
    for (const extra of [{}, { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence }]) {
      const res = await call(env, { method: "POST", path: P(env, "/submissions"), auth: { token: agent.token }, body: { ...answer_body(q), ...extra } });
      const error = assert_final_error(res, 403, "human_required", { next_action: NEXT_ACTION.human_required, target: "$.headers.Authorization" });
      assert.equal(error.details.required, "human_owner");
      assert.equal(error.details.actor_kind, "external_agent");
    }
    assert_final_error(await call(env, { method: "POST", path: P(env, "/submissions"), body: answer_body(q) }), 401, "unauthenticated");
    assert_final_error(
      await call(env, { method: "POST", path: P(env, "/submissions"), auth: { token: agent.token }, headers: { "x-pes-session": "not-the-secret" }, body: answer_body(q) }),
      401,
      "unauthenticated",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

test("a stale question version is 409 question_version_changed; a bad value is 422 with the answer's JSON path; unknown fields 400; all write nothing", async () => {
  await with_api(async (env) => {
    const q = await owner_publishes(env);
    const rev = await call(env, {
      method: "POST",
      path: P(env, `/questions/${q.question_id}/revisions`),
      auth: "owner",
      body: { base_version_id: q.question_version_id, question: { text: "합성 질문(수정)" } },
    });
    const current = assert_ok(rev, 201).question.version_id as string;
    const sig = state_signature(env.db);
    const post = (b: unknown) => call(env, { method: "POST", path: P(env, "/submissions"), auth: "owner", body: b });

    const stale = await post(answer_body(q));
    const error = assert_final_error(stale, 409, "question_version_changed", {
      target: "$.body.answers[0].question_version_id",
      next_action: NEXT_ACTION.question_version_changed,
    });
    assert.deepEqual({ ...error.details }, { expected: q.question_version_id, current, question_id: q.question_id });

    const fresh = { ...q, question_version_id: current };
    assert_final_error(await post(answer_body(fresh, {}, "not-an-option")), 422, "validation_failed", { target: "$.body.answers[0].value" });
    assert_final_error(await post({ set_id: "no-such-set", answers: answer_body(fresh).answers }), 404, "not_found");
    assert_final_error(await post({ ...answer_body(fresh), format_version: "2.0" }), 400, "invalid_payload", { target: "$.body.format_version" });
    for (const field of ["actor_id", "human_id", "via"]) {
      assert_final_error(await post({ ...answer_body(fresh), [field]: "x" }), 400, "invalid_payload", { target: `$.body.${field}` });
    }
    assert_final_error(await post({ set_id: q.set_id, answers: [] }), 400, "invalid_payload", { target: "$.body.answers" });
    assert.equal(state_signature(env.db), sig, "nothing was saved");
  });
});

test("a submission replays under the same key and is rejected for another body under that key", async () => {
  await with_api(async (env) => {
    const q = await owner_publishes(env);
    const body = answer_body(q, { used_default: true }, "b");
    const a = assert_ok(await call(env, { method: "POST", path: P(env, "/submissions"), auth: "owner", body, key: "sub-1" }), 201);
    const sig = state_signature(env.db);
    const again = await call(env, { method: "POST", path: P(env, "/submissions"), auth: "owner", body, key: "sub-1" });
    assert.equal(again.json.replayed, true);
    assert.deepEqual(assert_ok(again, 201), a);
    assert.equal(state_signature(env.db), sig);
    assert_final_error(
      await call(env, { method: "POST", path: P(env, "/submissions"), auth: "owner", body: answer_body(q, {}, "c"), key: "sub-1" }),
      409,
      "idempotency_key_reuse",
    );
  });
});

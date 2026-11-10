/**
 * SEL-47 PR14 — HTTP API: question publish / revise and the answer submission (tester, 작성 모드).
 *
 *   POST P/questions                    body = the question.publish_set payload
 *                                        {stage_id, round_id|null, purpose, form_key, questions[],
 *                                         run_id?, lease_id?, fence?}      (fence is a decimal STRING)
 *        owner session: no lease fields. Agent token (scope run:submit): must hold the lease and send
 *        {run_id, lease_id, fence}. -> 201 data = the core result
 *        {project_id, set_id, set_version_no, stage_id, round_id, form_key,
 *         members:[{question_id, question_version_id, position}]}
 *   POST P/questions/{q}/revisions      body = question.revise payload WITHOUT question_id (the path names it)
 *        -> 201 data {project_id, question_id, question_version_id, version_no}
 *   POST P/submissions                  body {set_id, answers:[{question_id, value?, other?, used_default?}]}
 *        owner session ONLY (an agent token is 403 even when its user is the owner)
 *        -> 201 data {project_id, submission_id, set_id, answers:[{question_id, answer_id, version_id,
 *                      question_version_id, thread_id, message_id}]}
 *
 * Envelope: the PR13 success body ({format_version, request_id, data, replayed}) and the PR14 error body
 * (Korean message, retryable, target = JSON path, next_action). A refusal writes nothing, not even a receipt.
 * A stale form (the question was revised after the set was published) is 409 `conflict`, target
 * "$.body.answers[i].question_id", details.question_id.
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
import { open_round, single_spec, text_spec } from "./helpers/questions_env.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

async function publish_body(env: ApiEnv, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { stage_id, round_id } = await open_round(env, `q${env.seq++}`);
  return {
    stage_id,
    round_id,
    purpose: "stage_start",
    form_key: "main",
    questions: [single_spec("합성 질문 하나"), text_spec("합성 질문 둘")],
    ...extra,
  };
}

async function owner_publishes(env: ApiEnv): Promise<{ set_id: string; members: any[]; stage_id: string; round_id: string }> {
  const body = await publish_body(env);
  const res = await call(env, { method: "POST", path: P(env, "/questions"), auth: "owner", body });
  const data = assert_ok(res, 201);
  return { ...data, stage_id: body.stage_id as string, round_id: body.round_id as string };
}

// ---------------------------------------------------------------------------
// publish

test("the owner publishes a question set: 201, the core result shape, one set row asked by the owner", async () => {
  await with_api(async (env) => {
    const before = table_counts(env.db);
    const body = await publish_body(env);
    const res = await call(env, { method: "POST", path: P(env, "/questions"), auth: "owner", body });
    const data = assert_ok(res, 201);
    assert.equal(res.json.replayed, false);
    assert.equal(data.project_id, env.p.project_id);
    assert.equal(data.stage_id, body.stage_id);
    assert.equal(data.round_id, body.round_id);
    assert.equal(data.form_key, "main");
    assert.equal(data.set_version_no, 1);
    assert.equal(data.members.length, 2);
    assert.deepEqual(
      data.members.map((m: any) => m.position),
      [0, 1],
    );
    for (const m of data.members) {
      assert.equal(typeof m.question_id, "string");
      assert.equal(typeof m.question_version_id, "string");
    }
    const after = table_counts(env.db);
    assert.equal(after.question_sets - before.question_sets, 1n);
    assert.equal(after.questions - before.questions, 2n);
    assert.equal(after.question_set_members - before.question_set_members, 2n);
    assert.equal(after.mutation_commits - before.mutation_commits - 1n /* the round start of the setup */, 1n);
    const q = env.db.get<{ asked_by_actor_id: string }>("SELECT asked_by_actor_id FROM questions WHERE object_id = ?", data.members[0].question_id);
    assert.equal(q?.asked_by_actor_id, env.p.actor_id);
  });
});

test("an agent publishes only while it holds the lease and names it: lease fields in the body, fence as a string", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "asker");
    const lease = await agent_claims(env, agent);
    const body = await publish_body(env);

    const guarded = await call(env, {
      method: "POST",
      path: P(env, "/questions"),
      auth: { token: agent.token },
      body: { ...body, run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence },
    });
    const data = assert_ok(guarded, 201);
    const q = env.db.get<{ asked_by_actor_id: string }>("SELECT asked_by_actor_id FROM questions WHERE object_id = ?", data.members[0].question_id);
    assert.equal(q?.asked_by_actor_id, agent.actor_id, "the actor is the token's actor, never a body field");
    const receipt = env.db.get<{ run_id: string; lease_id: string; fence: bigint }>(
      "SELECT run_id, lease_id, fence FROM mutation_commits WHERE project_id = ? AND action = 'question.set_published' ORDER BY rowid DESC LIMIT 1",
      env.p.project_id,
    );
    assert.equal(receipt?.run_id, lease.run_id);
    assert.equal(receipt?.lease_id, lease.lease_id);
    assert.equal(String(receipt?.fence), lease.fence);

    // No lease fields: 403 forbidden. Stale fence: 409 conflict. A numeric fence: 400.
    const second = { ...body, form_key: "other" };
    const sig = state_signature(env.db);
    assert_final_error(
      await call(env, { method: "POST", path: P(env, "/questions"), auth: { token: agent.token }, body: second }),
      403,
      "forbidden",
    );
    assert_final_error(
      await call(env, {
        method: "POST",
        path: P(env, "/questions"),
        auth: { token: agent.token },
        body: { ...second, run_id: lease.run_id, lease_id: lease.lease_id, fence: "999" },
      }),
      409,
      "conflict",
      { next_action: NEXT_ACTION.conflict },
    );
    assert_final_error(
      await call(env, {
        method: "POST",
        path: P(env, "/questions"),
        auth: { token: agent.token },
        body: { ...second, run_id: lease.run_id, lease_id: lease.lease_id, fence: Number(lease.fence) },
      }),
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
    const sig = state_signature(env.db);
    assert_final_error(
      await call(env, { method: "POST", path: P(env, "/questions"), body }),
      401,
      "unauthenticated",
      { next_action: NEXT_ACTION.unauthenticated },
    );
    assert_final_error(
      await call(env, { method: "POST", path: P(env, "/questions"), headers: { "x-pes-session": "wrong" }, body }),
      401,
      "unauthenticated",
    );
    const reader = await make_agent(env, "reader-only", ["context:read"]);
    assert_final_error(
      await call(env, { method: "POST", path: P(env, "/questions"), auth: { token: reader.token }, body }),
      403,
      "forbidden",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

test("publish rejects unknown fields, spoofed actors, a missing key, and bad questions with a field-level target", async () => {
  await with_api(async (env) => {
    const body = await publish_body(env);
    const sig = state_signature(env.db);
    for (const field of ["asked_by_actor_id", "actor_id", "human_id", "via", "direction"]) {
      const res = await call(env, { method: "POST", path: P(env, "/questions"), auth: "owner", body: { ...body, [field]: "x" } });
      assert_final_error(res, 400, "invalid_payload", { target: `$.body.${field}`, next_action: NEXT_ACTION.invalid_payload });
    }
    assert_final_error(
      await call(env, { method: "POST", path: P(env, "/questions"), auth: "owner", body, key: null }),
      400,
      "invalid_payload",
      { target: /idempotency-key/i },
    );
    assert_final_error(
      await call(env, { method: "POST", path: P(env, "/questions"), auth: "owner", body: { ...body, questions: [] } }),
      400,
      "invalid_payload",
      { target: "$.body.questions" },
    );
    assert_final_error(
      await call(env, {
        method: "POST",
        path: P(env, "/questions"),
        auth: "owner",
        body: { ...body, questions: [{ text: "합성", type: "single_choice", allow_comment_as_answer: false }] },
      }),
      400,
      "invalid_payload",
      { target: /^\$\.body\.questions\[0\]/ },
    );
    assert_final_error(
      await call(env, { method: "POST", path: P(env, "/questions"), auth: "owner", body: { ...body, stage_id: "no-such-stage" } }),
      404,
      "not_found",
    );
    assert.equal(state_signature(env.db), sig, "no refusal left a row, a receipt, or an event");
  });
});

test("publishing again with the same key replays the first answer; the same key with another body is 409 idempotency_key_reuse", async () => {
  await with_api(async (env) => {
    const body = await publish_body(env);
    const first = await call(env, { method: "POST", path: P(env, "/questions"), auth: "owner", body, key: "pub-1" });
    const a = assert_ok(first, 201);
    const sig = state_signature(env.db);
    const again = await call(env, { method: "POST", path: P(env, "/questions"), auth: "owner", body, key: "pub-1" });
    const b = assert_ok(again, 201);
    assert.equal(again.json.replayed, true);
    assert.deepEqual(b, a);
    assert.equal(state_signature(env.db), sig);
    const other = await call(env, {
      method: "POST",
      path: P(env, "/questions"),
      auth: "owner",
      body: { ...body, form_key: "changed" },
      key: "pub-1",
    });
    assert_final_error(other, 409, "idempotency_key_reuse", { next_action: NEXT_ACTION.idempotency_key_reuse });
    assert.equal(state_signature(env.db), sig);
  });
});

// ---------------------------------------------------------------------------
// revise

test("revising a question appends version 2, keeps version 1 and every answer, and the path names the question", async () => {
  await with_api(async (env) => {
    const set = await owner_publishes(env);
    const q = set.members[0];
    const answered = await call(env, {
      method: "POST",
      path: P(env, "/submissions"),
      auth: "owner",
      body: { set_id: set.set_id, answers: [{ question_id: q.question_id, value: "a" }] },
    });
    const sub = assert_ok(answered, 201);
    const counts = table_counts(env.db);

    const res = await call(env, {
      method: "POST",
      path: P(env, `/questions/${q.question_id}/revisions`),
      auth: "owner",
      body: { text: "합성 질문 하나(수정)" },
    });
    const data = assert_ok(res, 201);
    assert.equal(data.question_id, q.question_id);
    assert.equal(data.version_no, 2);
    assert.notEqual(data.question_version_id, q.question_version_id);
    const after = table_counts(env.db);
    assert.equal(after.question_versions - counts.question_versions, 1n);
    assert.equal(after.answer_versions, counts.answer_versions, "the earlier answer stays as it was");
    const old = env.db.get<{ text: string }>("SELECT text FROM question_versions WHERE version_id = ?", q.question_version_id);
    assert.ok(old);
    assert.notEqual(old.text, "합성 질문 하나(수정)");
    assert.ok(sub.answers[0].version_id);

    // The path wins: a question_id in the body is an unknown field; an unknown question is 404.
    assert_final_error(
      await call(env, {
        method: "POST",
        path: P(env, `/questions/${q.question_id}/revisions`),
        auth: "owner",
        body: { question_id: q.question_id, text: "x" },
      }),
      400,
      "invalid_payload",
      { target: "$.body.question_id" },
    );
    assert_final_error(
      await call(env, { method: "POST", path: P(env, "/questions/no-such-question/revisions"), auth: "owner", body: { text: "x" } }),
      404,
      "not_found",
    );
  });
});

test("an agent revises only while it holds the lease", async () => {
  await with_api(async (env) => {
    const set = await owner_publishes(env);
    const q = set.members[0];
    const agent = await make_agent(env, "reviser");
    const lease = await agent_claims(env, agent);
    const path = P(env, `/questions/${q.question_id}/revisions`);
    assert_final_error(await call(env, { method: "POST", path, auth: { token: agent.token }, body: { text: "무허가" } }), 403, "forbidden");
    const ok = await call(env, {
      method: "POST",
      path,
      auth: { token: agent.token },
      body: { text: "허가된 수정", run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence },
    });
    assert.equal(assert_ok(ok, 201).version_no, 2);
  });
});

// ---------------------------------------------------------------------------
// submissions

test("the owner submits answers: 201, each answer pinned to the question version the form showed", async () => {
  await with_api(async (env) => {
    const set = await owner_publishes(env);
    const [q1, q2] = set.members;
    const before = table_counts(env.db);
    const res = await call(env, {
      method: "POST",
      path: P(env, "/submissions"),
      auth: "owner",
      body: {
        set_id: set.set_id,
        answers: [
          { question_id: q1.question_id, value: "a", other: "합성 의견" },
          { question_id: q2.question_id, value: "합성 서술" },
        ],
      },
    });
    const data = assert_ok(res, 201);
    assert.equal(data.set_id, set.set_id);
    assert.equal(data.answers.length, 2);
    assert.equal(data.answers[0].question_version_id, q1.question_version_id);
    assert.equal(data.answers[1].question_version_id, q2.question_version_id);
    const after = table_counts(env.db);
    assert.equal(after.submissions - before.submissions, 1n);
    assert.equal(after.answers - before.answers, 2n);
    const submission = env.db.get<{ actor_id: string; via: string }>("SELECT actor_id, via FROM submissions WHERE id = ?", data.submission_id);
    assert.equal(submission?.actor_id, env.p.actor_id);
    assert.equal(submission?.via, "http", "the server fixes the channel; the body cannot");
  });
});

test("an agent token cannot submit answers — 403 forbidden even with every scope and the owner's user; nothing is written", async () => {
  await with_api(async (env) => {
    const set = await owner_publishes(env);
    const agent = await make_agent(env, "answerer");
    const lease = await agent_claims(env, agent);
    const sig = state_signature(env.db);
    const answers = [{ question_id: set.members[0].question_id, value: "a" }];
    for (const extra of [{}, { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence }]) {
      const res = await call(env, {
        method: "POST",
        path: P(env, "/submissions"),
        auth: { token: agent.token },
        body: { set_id: set.set_id, answers, ...extra },
      });
      const error = assert_final_error(res, 403, "forbidden", { next_action: NEXT_ACTION.forbidden_human_only });
      assert.equal(error.details.required, "human_owner");
    }
    // No credential at all is 401, and a session header with the wrong secret is 401 too (no fallback to a token).
    assert_final_error(await call(env, { method: "POST", path: P(env, "/submissions"), body: { set_id: set.set_id, answers } }), 401, "unauthenticated");
    assert_final_error(
      await call(env, {
        method: "POST",
        path: P(env, "/submissions"),
        auth: { token: agent.token },
        headers: { "x-pes-session": "not-the-secret" },
        body: { set_id: set.set_id, answers },
      }),
      401,
      "unauthenticated",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

test("a stale form is 409 conflict naming the question; a bad value is 400 with the answer's JSON path; both write nothing", async () => {
  await with_api(async (env) => {
    const set = await owner_publishes(env);
    const [q1, q2] = set.members;
    const rev = await call(env, {
      method: "POST",
      path: P(env, `/questions/${q2.question_id}/revisions`),
      auth: "owner",
      body: { text: "합성 서술(수정)" },
    });
    assert_ok(rev, 201);
    const sig = state_signature(env.db);

    const stale = await call(env, {
      method: "POST",
      path: P(env, "/submissions"),
      auth: "owner",
      body: { set_id: set.set_id, answers: [{ question_id: q1.question_id, value: "a" }, { question_id: q2.question_id, value: "서술" }] },
    });
    const error = assert_final_error(stale, 409, "conflict", { target: "$.body.answers[1].question_id", next_action: NEXT_ACTION.conflict });
    assert.equal(error.details.question_id, q2.question_id);

    const bad = await call(env, {
      method: "POST",
      path: P(env, "/submissions"),
      auth: "owner",
      body: { set_id: set.set_id, answers: [{ question_id: q1.question_id, value: "not-an-option" }] },
    });
    assert_final_error(bad, 400, "invalid_payload", { target: "$.body.answers[0].value" });

    assert_final_error(
      await call(env, { method: "POST", path: P(env, "/submissions"), auth: "owner", body: { set_id: "no-such-set", answers: [{ question_id: q1.question_id, value: "a" }] } }),
      404,
      "not_found",
    );
    for (const field of ["actor_id", "human_id", "via", "submitted_via", "client_request_id"]) {
      assert_final_error(
        await call(env, {
          method: "POST",
          path: P(env, "/submissions"),
          auth: "owner",
          body: { set_id: set.set_id, answers: [{ question_id: q1.question_id, value: "a" }], [field]: "x" },
        }),
        400,
        "invalid_payload",
        { target: `$.body.${field}` },
      );
    }
    assert.equal(state_signature(env.db), sig, "the good item of a bundle is not saved either");
  });
});

test("a submission replays under the same key and is rejected for another body under that key", async () => {
  await with_api(async (env) => {
    const set = await owner_publishes(env);
    const body = { set_id: set.set_id, answers: [{ question_id: set.members[0].question_id, value: "b", used_default: true }] };
    const first = await call(env, { method: "POST", path: P(env, "/submissions"), auth: "owner", body, key: "sub-1" });
    const a = assert_ok(first, 201);
    const sig = state_signature(env.db);
    const again = await call(env, { method: "POST", path: P(env, "/submissions"), auth: "owner", body, key: "sub-1" });
    assert.equal(again.json.replayed, true);
    assert.deepEqual(assert_ok(again, 201), a);
    assert.equal(state_signature(env.db), sig);
    assert_final_error(
      await call(env, {
        method: "POST",
        path: P(env, "/submissions"),
        auth: "owner",
        body: { ...body, answers: [{ question_id: set.members[0].question_id, value: "c" }] },
        key: "sub-1",
      }),
      409,
      "idempotency_key_reuse",
    );
  });
});

/**
 * SEL-47 PR14 — one full round through the HTTP surface, PR13 + PR14 together (tester, 작성 모드).
 *
 *   owner starts the round (POST P/stages/{s}/rounds) and queues a run (POST P/runs)
 *   agent claims it (POST P/claims), reads context, asks a question (POST P/questions, with its lease),
 *     waits (POST P/runs/{r}/wait: waiting_human, lease released)
 *   owner reads the change feed (GET P/changes), answers (POST P/submissions)
 *   agent reads the answer as an input (GET P/runs/{r}/inputs), claims again (fence 2), acknowledges it
 *     (POST P/runs/{r}/input-receipts: seen, then applied with the receipt of its own result),
 *     submits a result (POST P/runs/{r}/results), completes the run (POST P/runs/{r}/complete)
 *   owner seals the round (POST P/rounds/{rd}/seal): complete is NOT approval, seal is NOT approval
 *   agent tries to approve: 403; owner approves (POST P/stages/{s}/approve): the stage is approved
 *
 * Nothing but the project's creation (done by the harness) and the manifest blob of the seal is set up
 * outside HTTP. The test also restarts the app in the middle: nothing the flow needs lives in memory.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DECIMAL, assert_ok, call, make_agent, with_api } from "./helpers/api_env.ts";
import { P, assert_final_error, restart_app, NEXT_ACTION } from "./helpers/api_flow.ts";
import { new_artifact } from "./helpers/blob_env.ts";
import { manifest_blob, stage_ids } from "./helpers/editions_env.ts";
import { single_spec } from "./helpers/questions_env.ts";
import { table_counts } from "./helpers/state_signature.ts";

test("one round from the question to the approval, over HTTP only", async () => {
  await with_api(async (env) => {
    const s = stage_ids(env.db, env.p.edition_id);
    const agent = await make_agent(env, "round-agent");
    const art = await new_artifact(env, "flow-artifact");
    const gap = assert_ok(await call(env, { method: "GET", path: "/api/v1/capabilities" })).limits.min_poll_interval_ms as number;

    // -- the owner opens the round and queues the run
    const round = assert_ok(await call(env, { method: "POST", path: P(env, `/stages/${s.plan}/rounds`), auth: "owner", body: {} }), 201);
    const queued = assert_ok(
      await call(env, {
        method: "POST",
        path: P(env, "/runs"),
        auth: "owner",
        body: { actor_id: agent.actor_id, mode: "B", runtime: "synthetic-runtime", provider: "synthetic", model: "synthetic-model" },
      }),
      201,
    );

    // -- the agent claims, reads the context, asks
    const claim1 = assert_ok(await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: agent.token }, body: { run_id: queued.run_id } }));
    assert.equal(claim1.run_id, queued.run_id);
    assert.equal(claim1.fence, "1");
    const context1 = assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: { token: agent.token } }));
    assert.equal(context1.lease.lease_id, claim1.lease_id);
    assert.match(context1.digest, /^[0-9a-f]{64}$/);
    const guard1 = { run_id: claim1.run_id, lease_id: claim1.lease_id, fence: claim1.fence };

    const start_feed = assert_ok(await call(env, { method: "GET", path: P(env, "/changes"), auth: "owner" }));
    const asked = assert_ok(
      await call(env, {
        method: "POST",
        path: P(env, "/questions"),
        auth: { token: agent.token },
        body: { stage_id: s.plan, round_id: round.round_id, purpose: "review", form_key: "flow", questions: [single_spec("흐름 시험 질문")], ...guard1 },
      }),
      201,
    );
    const waiting = assert_ok(await call(env, { method: "POST", path: P(env, `/runs/${claim1.run_id}/wait`), auth: { token: agent.token }, body: { lease_id: claim1.lease_id, fence: claim1.fence } }));
    assert.equal(waiting.status, "waiting_human");
    assert.equal(assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: "owner" })).lease, null, "waiting releases the lease");

    // -- the server restarts while the human thinks; the owner sees the question in the feed and answers
    restart_app(env);
    const feed = assert_ok(await call(env, { method: "GET", path: P(env, `/changes?cursor=${encodeURIComponent(start_feed.next_cursor)}`), auth: "owner" }));
    assert.ok(feed.events.some((e: any) => e.type === "question.set_published"));
    assert.ok(feed.events.some((e: any) => e.type === "run.waiting_human"));
    const submission = assert_ok(
      await call(env, {
        method: "POST",
        path: P(env, "/submissions"),
        auth: "owner",
        body: { set_id: asked.set_id, answers: [{ question_id: asked.members[0].question_id, value: "a", other: "합성 의견" }] },
      }),
      201,
    );
    const input_version_id = submission.answers[0].version_id as string;

    // -- the agent reads the answer without any lease (a pure read), then resumes with a new fence
    const inputs = assert_ok(await call(env, { method: "GET", path: P(env, `/runs/${queued.run_id}/inputs?wait_ms=0`), auth: { token: agent.token } }));
    assert.equal(inputs.inputs.length, 1);
    assert.equal(inputs.inputs[0].input_version_id, input_version_id);
    assert.equal(inputs.inputs[0].kind, "answer");
    assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", queued.run_id)?.status, "waiting_human", "reading inputs moves nothing");

    const claim2 = assert_ok(await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: agent.token }, body: { run_id: queued.run_id } }));
    assert.equal(claim2.fence, "2", "a resume is a new claim with a new fence");
    const guard2 = { lease_id: claim2.lease_id, fence: claim2.fence };
    const receipts_path = P(env, `/runs/${queued.run_id}/input-receipts`);
    assert_ok(await call(env, { method: "POST", path: receipts_path, auth: { token: agent.token }, body: { ...guard2, receipts: [{ input_version_id, state: "seen" }] } }));
    // the old lease can no longer write
    assert_final_error(
      await call(env, { method: "POST", path: P(env, `/runs/${queued.run_id}/results`), auth: { token: agent.token }, body: { ...guard1, results: [{ op: "append_version", object_id: art.object_id, title: "옛 열쇠" }] } }),
      409,
      "conflict",
      { next_action: NEXT_ACTION.conflict },
    );

    // -- the agent submits a result; its receipt is the evidence for "applied"
    const result = assert_ok(
      await call(env, {
        method: "POST",
        path: P(env, `/runs/${queued.run_id}/results`),
        auth: { token: agent.token },
        body: { ...guard2, results: [{ op: "append_version", object_id: art.object_id, title: "라운드 결과" }] },
        key: "flow-result",
      }),
    );
    const version_id = result.results[0].version_id as string;
    const request = assert_ok(await call(env, { method: "GET", path: P(env, "/requests/flow-result"), auth: { token: agent.token } }));
    assert.equal(request.state, "completed");
    assert.equal(request.status, 200);
    assert.equal(typeof request.tx_id, "string");
    const applied = assert_ok(
      await call(env, { method: "POST", path: receipts_path, auth: { token: agent.token }, body: { ...guard2, receipts: [{ input_version_id, state: "applied", applied_tx_id: request.tx_id }] } }),
    );
    assert.deepEqual(applied.accepted, [{ input_version_id, state: "applied", already_applied: false }]);

    const done = assert_ok(await call(env, { method: "POST", path: P(env, `/runs/${queued.run_id}/complete`), auth: { token: agent.token }, body: { ...guard2, status: "succeeded" } }));
    assert.equal(done.status, "succeeded");
    assert.notEqual(env.db.get<{ status: string }>("SELECT status FROM stages WHERE id = ?", s.plan)?.status, "approved", "complete is not approval");
    assert.equal(table_counts(env.db).approvals, 0n);

    // -- the owner seals; the agent cannot approve; the owner can
    const versions = [{ object_id: art.object_id, version_id }];
    const manifest_blob_id = await manifest_blob(env, versions, "flow-manifest");
    const sealed = assert_ok(await call(env, { method: "POST", path: P(env, `/rounds/${round.round_id}/seal`), auth: "owner", body: { manifest_blob_id, versions } }));
    assert.equal(table_counts(env.db).approvals, 0n, "sealing is not approving");
    const approve_path = P(env, `/stages/${s.plan}/approve`);
    assert_final_error(await call(env, { method: "POST", path: approve_path, auth: { token: agent.token }, body: { snapshot_id: sealed.snapshot_id } }), 403, "forbidden", {
      next_action: NEXT_ACTION.forbidden_human_only,
    });
    const approved = assert_ok(await call(env, { method: "POST", path: approve_path, auth: "owner", body: { snapshot_id: sealed.snapshot_id } }));
    assert.equal(approved.stage_id, s.plan);
    assert.equal(approved.next_stage_id, s.research);

    // -- the context and the feed agree with what happened
    const final = assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: { token: agent.token } }));
    assert.equal(final.stages.find((st: any) => st.key === "plan").status, "approved");
    assert.match(final.control_rev, DECIMAL);
    assert.equal(final.lease, null);
    const all = assert_ok(await call(env, { method: "GET", path: P(env, "/changes?limit=100"), auth: "owner" }));
    const types = all.events.map((e: any) => e.type);
    for (const expected of ["round.started", "run.created", "run.claimed", "question.set_published", "run.waiting_human", "answer.submitted", "run.input_receipt_recorded", "result.submitted", "run.completed", "round.sealed", "stage.approved"]) {
      assert.ok(types.includes(expected), `the feed has ${expected}`);
    }
    const order = (t: string) => types.indexOf(t);
    assert.ok(order("question.set_published") < order("answer.submitted"));
    assert.ok(order("answer.submitted") < order("result.submitted"));
    assert.ok(order("run.completed") < order("round.sealed"));
    assert.ok(order("round.sealed") < order("stage.approved"));
    for (let i = 1; i < all.events.length; i += 1) {
      assert.ok(BigInt(all.events[i].event_seq) > BigInt(all.events[i - 1].event_seq));
    }
    assert.ok(all.events.every((e: any) => e.type !== "stage.approved" || e.run_id === null), "an approval belongs to no run");
    assert.ok(gap > 0);
  });
});

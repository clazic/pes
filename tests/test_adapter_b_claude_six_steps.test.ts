/**
 * SEL-53 PR20a — Claude Code runs the synthetic six steps through the MCP tools (tester, 작성 모드).
 * The fake MCP client speaks stdio JSON-RPC (tests/helpers/adapter_b_env.ts); the MCP server talks to a
 * real in-memory ApiApp over a temporary database. Nothing here starts Claude or reads any Claude config.
 *
 * The six steps are the closed tool order of the issue: context → claim → ask → wait → submit → complete
 * (with the answer, the resume claim and the input receipts between wait and submit).
 *
 * 해석 (continued from test_adapter_b_claude_mcp.test.ts, numbered on):
 *  해석 6  Every tool except pes_context requires `idempotency_key` (sent as the API Idempotency-Key); without
 *          it the tool answers isError code `invalid_payload` (target "$.arguments.idempotency_key") and makes
 *          NO API call. The same key + same arguments replays the first answer (`replayed: true`, no new rows);
 *          the same key with other arguments is `idempotency_key_reuse`.
 *  해석 7  The server remembers the guard {run_id, lease_id, fence} of its last successful claim, so submit /
 *          ask / wait / complete / heartbeat / release / cancel / receipt need not repeat it; explicit
 *          `run_id`, `lease_id`, `fence` arguments override the remembered ones (that is how a NEW connection
 *          continues after a restart: pes_context first, then explicit ids). With no remembered or explicit
 *          guard the tool answers isError `claim_required` with next_action "claim" and makes no API call.
 *          pes_release / pes_wait / pes_complete / pes_cancel forget the remembered lease.
 *  해석 8  pes_context returns the API context data unchanged (project_id, control_rev, digest, lease, stages,
 *          manifest, ...). When the server knows a run (remembered, or the `run_id` argument), it adds
 *          `inputs` — an ARRAY of the run's answers (the `inputs` list of GET .../runs/{r}/inputs) — read with
 *          no lease, a pure read.
 *  해석 9  pes_claim {run_id?, ...} returns {run_id, lease_id, fence, ...}; with no run_id it uses
 *          claim_defaults {runtime, provider, model} as a mode B claim. pes_wait posts the API wait
 *          (waiting_human, lease released) and returns {status:"waiting_human", ...}.
 *  해석 10 pes_receipt takes {receipts:[{input_version_id, state, reason?, applied_by_key?}]}; for
 *          state "applied" the adapter turns `applied_by_key` (the idempotency_key of the pes_submit that
 *          used the input) into the API's applied_tx_id by reading GET .../requests/{key}. Unknown key → isError
 *          `not_found`, nothing written.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ask_args, owner_answers, wire } from "./helpers/adapter_b_env.ts";
import { claim_fresh, events_of_type, with_cleanup } from "./helpers/adapter_b_flow.ts";
import { assert_ok, call } from "./helpers/api_env.ts";
import { P, restart_app } from "./helpers/api_flow.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

test("six steps: context, claim, ask, wait, (answer, resume), submit, complete — all through MCP tools", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());

    // 1 context
    const ctx0 = await client.ok("pes_context", {});
    assert.equal(ctx0.project_id, env.p.project_id);
    assert.equal(ctx0.lease, null);
    assert.match(ctx0.digest, /^[0-9a-f]{64}$/);
    assert.match(ctx0.control_rev, /^(0|[1-9][0-9]*)$/);
    assert.equal(ctx0.inputs, undefined, "no run known yet, so no inputs");

    // 2 claim
    const claim = await client.ok("pes_claim", { idempotency_key: "c-claim" });
    assert.equal(claim.fence, "1");
    const run = env.db.get<{ mode: string; runtime: string; provider: string; model: string; actor_id: string }>(
      "SELECT mode, runtime, provider, model, actor_id FROM runs WHERE id = ?",
      claim.run_id,
    )!;
    assert.deepEqual(
      { mode: run.mode, runtime: run.runtime, provider: run.provider, model: run.model },
      { mode: "B", runtime: "claude_code", provider: "anthropic", model: "synthetic-model" },
    );
    assert.equal(run.actor_id, env.agent.actor_id, "the run belongs to the connected agent, not to the owner");
    env.tick();
    const ctx1 = await client.ok("pes_context", {});
    assert.equal(ctx1.lease.lease_id, claim.lease_id);
    assert.deepEqual(ctx1.inputs, [], "the known run has no answers yet");

    // 3 ask
    const asked = await client.ok("pes_ask", ask_args(env, "six"));
    assert.equal(typeof asked.question_set_id, "string");
    assert.equal(typeof asked.question.id, "string");

    // 4 wait: waiting_human, the lease is released in the same step
    const waiting = await client.ok("pes_wait", { idempotency_key: "c-wait" });
    assert.equal(waiting.status, "waiting_human");
    assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", claim.run_id)?.status, "waiting_human");
    env.tick();
    assert.equal((await client.ok("pes_context", {})).lease, null, "wait released the lease");
    await client.fails("pes_submit", { idempotency_key: "c-after-wait", results: [] }, "claim_required");

    // the human answers (not the agent)
    const input_version_id = await owner_answers(env, asked, "a");
    env.tick();
    const ctx2 = await client.ok("pes_context", {});
    const inputs = ctx2.inputs as any[];
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].input_version_id, input_version_id);
    assert.equal(inputs[0].kind, "answer");

    // resume: a NEW claim with a new fence, then acknowledge the input
    const claim2 = await client.ok("pes_claim", { run_id: claim.run_id, idempotency_key: "c-claim-2" });
    assert.equal(claim2.run_id, claim.run_id);
    assert.equal(claim2.fence, "2");
    await client.ok("pes_receipt", { receipts: [{ input_version_id, state: "seen" }], idempotency_key: "c-seen" });

    // 5 submit
    const submitted = await client.ok("pes_submit", {
      results: [{ op: "append_version", object_id: env.object_id, title: "여섯 단계 결과" }],
      idempotency_key: "c-submit",
    });
    assert.equal(typeof submitted.results[0].version_id, "string");
    const applied = await client.ok("pes_receipt", {
      receipts: [{ input_version_id, state: "applied", applied_by_key: "c-submit" }],
      idempotency_key: "c-applied",
    });
    assert.deepEqual(applied.accepted, [{ input_version_id, state: "applied" }]);

    // 6 complete — a run ends; the stage is not approved and nothing is sealed
    const done = await client.ok("pes_complete", { status: "succeeded", idempotency_key: "c-complete" });
    assert.equal(done.status, "succeeded");
    assert.equal(table_counts(env.db).approvals, 0n, "complete is not approval");
    assert.notEqual(env.db.get<{ status: string }>("SELECT status FROM stages WHERE id = ?", env.stage.plan)?.status, "approved");

    // the feed shows the whole story, every agent write by the agent actor, the answer by the human
    const types = (await (async () => {
      const feed = assert_ok(await call(env, { method: "GET", path: P(env, "/changes?limit=100"), auth: "owner" }));
      return feed.events.map((e: any) => e.type as string);
    })());
    for (const expected of ["run.claimed", "question.set_published", "run.waiting_human", "answer.submitted", "run.input_receipt_recorded", "result.submitted", "run.completed"]) {
      assert.ok(types.includes(expected), `the feed has ${expected}`);
    }
    const actors = env.db.all<{ actor_id: string }>(
      "SELECT DISTINCT m.actor_id AS actor_id FROM mutation_commits m JOIN events e ON e.tx_id = m.id AND e.project_id = m.project_id WHERE m.project_id = ? AND e.type IN ('run.claimed','question.set_published','run.waiting_human','result.submitted','run.completed')",
      env.p.project_id,
    );
    assert.deepEqual(actors.map((a) => a.actor_id), [env.agent.actor_id]);
  });
});

test("a missing idempotency_key is refused by the tool before any API call; nothing is written", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const before = state_signature(env.db);
    for (const [tool, args] of [
      ["pes_claim", {}],
      ["pes_submit", { results: [{ op: "append_version", object_id: env.object_id, title: "x" }] }],
      ["pes_ask", { ...ask_args(env, "nokey"), idempotency_key: undefined }],
      ["pes_wait", {}],
      ["pes_complete", { status: "succeeded" }],
      ["pes_heartbeat", {}],
      ["pes_release", {}],
      ["pes_cancel", { confirm: true }],
      ["pes_receipt", { receipts: [] }],
    ] as Array<[string, Record<string, unknown>]>) {
      const error = await client.fails(tool, args, "invalid_payload");
      assert.equal(error.target, "$.arguments.idempotency_key", tool);
      assert.equal(error.next_action, "fix_request", tool);
    }
    await client.fails("pes_claim", { idempotency_key: "" }, "invalid_payload");
    await client.fails("pes_claim", { idempotency_key: 7 }, "invalid_payload");
    assert.equal(state_signature(env.db), before);
  });
});

test("the same key replays the first answer; the same key with other arguments is refused", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    await claim_fresh(client);
    const args = { results: [{ op: "append_version", object_id: env.object_id, title: "한 번만" }], idempotency_key: "once" };
    const first = await client.ok("pes_submit", args);
    assert.notEqual(first.replayed, true);
    const sig = state_signature(env.db);
    const again = await client.ok("pes_submit", args);
    assert.equal(again.replayed, true);
    assert.deepEqual(again.results, first.results, "the same version id, not a second version");
    assert.equal(state_signature(env.db), sig, "a replay writes nothing");

    const other = await client.fails(
      "pes_submit",
      { results: [{ op: "append_version", object_id: env.object_id, title: "다른 내용" }], idempotency_key: "once" },
      "idempotency_key_reuse",
    );
    assert.equal(other.next_action, "use_new_key");
    assert.equal(state_signature(env.db), sig);
    assert.equal(events_of_type(env, "result.submitted").length, 1);
  });
});

test("reconnect after a server restart: context first, then explicit ids; a bare connection has no guard", async () => {
  await with_cleanup(async (env, open) => {
    const first = open(await env.client());
    const claim = await claim_fresh(first);

    // the PES server restarts and the MCP server process is a brand-new one with no memory
    restart_app(env);
    const second = open(await env.client());
    env.tick();
    const ctx = await second.ok("pes_context", {});
    assert.equal(ctx.lease.lease_id, claim.lease_id, "the lease survived: it lives in the database");
    await second.fails("pes_heartbeat", { idempotency_key: "hb-bare" }, "claim_required");
    const beat = await second.ok("pes_heartbeat", {
      run_id: claim.run_id,
      lease_id: ctx.lease.lease_id,
      fence: ctx.lease.fence,
      idempotency_key: "hb-explicit",
    });
    assert.equal(beat.run_id, claim.run_id);
    assert.equal(beat.lease.fence, claim.fence);
    // a wrong explicit fence is the API's lease_lost, with the reread hint
    const lost = await second.fails(
      "pes_heartbeat",
      { run_id: claim.run_id, lease_id: claim.lease_id, fence: "99", idempotency_key: "hb-wrong" },
      "lease_lost",
    );
    assert.equal(lost.next_action, "reclaim_run");
  });
});

test("release gives the run back and forgets the lease; an old connection's fence is lease_lost after a reclaim", async () => {
  await with_cleanup(async (env, open) => {
    const a = open(await env.client());
    const claim = await claim_fresh(a);
    const released = await a.ok("pes_release", { idempotency_key: "rel" });
    assert.equal(released.status, "queued");
    env.tick();
    assert.equal((await a.ok("pes_context", {})).lease, null);
    await a.fails("pes_submit", { results: [], idempotency_key: "after-release" }, "claim_required");

    const reclaim = await a.ok("pes_claim", { run_id: claim.run_id, idempotency_key: "reclaim" });
    assert.equal(reclaim.fence, "2");
    // another connection that still holds the OLD guard cannot write
    const stale = open(await env.client());
    const error = await stale.fails(
      "pes_submit",
      { run_id: claim.run_id, lease_id: claim.lease_id, fence: claim.fence, results: [{ op: "append_version", object_id: env.object_id, title: "옛 열쇠" }], idempotency_key: "stale-submit" },
      "conflict",
    );
    assert.equal(error.next_action, "reread_context");
    assert.equal(events_of_type(env, "result.submitted").length, 0);
  });
});

test("cancel needs confirm:true; the holder cancels its own run and the lease is forgotten", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const claim = await claim_fresh(client);
    const sig = state_signature(env.db);
    await client.fails("pes_cancel", { idempotency_key: "cancel-1" }, "invalid_payload");
    await client.fails("pes_cancel", { confirm: "yes", idempotency_key: "cancel-2" }, "invalid_payload");
    assert.equal(state_signature(env.db), sig);
    const out = await client.ok("pes_cancel", { confirm: true, reason: "합성 취소", idempotency_key: "cancel-3" });
    assert.equal(out.run_id, claim.run_id);
    assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", claim.run_id)?.status, "cancelled");
    await client.fails("pes_complete", { status: "succeeded", idempotency_key: "after-cancel" }, "claim_required");
  });
});

test("receipts: an unknown applied_by_key is not_found and writes nothing; applied needs a real submit", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const claim = await claim_fresh(client);
    const asked = await client.ok("pes_ask", ask_args(env, "rcpt"));
    await client.ok("pes_wait", { idempotency_key: "w" });
    const input_version_id = await owner_answers(env, asked);
    await client.ok("pes_claim", { run_id: claim.run_id, idempotency_key: "c2" });
    const sig = state_signature(env.db);
    const error = await client.fails(
      "pes_receipt",
      { receipts: [{ input_version_id, state: "applied", applied_by_key: "never-used" }], idempotency_key: "r1" },
      "not_found",
    );
    assert.equal(typeof error.next_action, "string");
    await client.fails("pes_receipt", { receipts: [{ input_version_id, state: "applied" }], idempotency_key: "r2" }, "invalid_payload");
    assert.equal(state_signature(env.db), sig);
    assert.equal(events_of_type(env, "run.input_receipt_recorded").length, 0);
  });
});

test("nothing the tools return or the database stores contains the agent token", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const claim = await claim_fresh(client);
    const outputs = [
      await client.ok("pes_context", {}),
      await client.ok("pes_heartbeat", { idempotency_key: "hb" }),
      await client.ok("pes_submit", { results: [{ op: "append_version", object_id: env.object_id, title: "토큰 없음" }], idempotency_key: "s" }),
      await client.ok("pes_complete", { status: "succeeded", idempotency_key: "done" }),
    ];
    assert.ok(claim.run_id.length > 0);
    for (const out of outputs) assert.ok(!wire(out).includes(env.agent.token));
    const dump = (env.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'") as Array<{ name: string }>)
      .map((t) => wire(env.db.all(`SELECT * FROM "${t.name}"`)))
      .join("\n");
    assert.ok(!dump.includes(env.agent.token), "the raw token is stored nowhere");
  });
});

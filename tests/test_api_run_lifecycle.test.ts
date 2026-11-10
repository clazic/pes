/**
 * SEL-47 PR14 — HTTP API: the run lifecycle routes, inputs long-poll, receipts, 202 operations, and
 * the request lookup (tester, 작성 모드). Shapes and error names follow docs/plan/fixtures/api-v1
 * (heartbeat, handoffs, interrupt, cancel, inputs, input-receipts); routes the documents do not cover
 * (release, GET operations, GET requests) are this suite's choice and are listed in the report.
 *
 *   Agent token routes (scope run:submit):
 *     POST P/runs/{r}/heartbeat   {lease_id, fence (decimal STRING), progress?:{phase, observed_at}}
 *        -> 200 {run_id, lease:{lease_id, fence, expires_at}, server_time}  (extends the LEASE, never the
 *        token; its own request budget). A stale fence, a released or expired lease: 409 `lease_lost`,
 *        target "$.body.fence", next_action "reclaim_run", details {expected_fence, current_fence|null,
 *        current_lease_id|null}.
 *     POST P/runs/{r}/release     {lease_id, fence} -> 200 {run_id, status:"queued"}; a stale lease is 409 `lease_lost`.
 *     POST P/runs/{r}/handoffs    {target_mode, target_actor_id?, reason?, include_pending_inputs?}
 *        no lease fields: the server reads the current lease. Caller: the lease holder (token actor) or
 *        the owner session (a human may hand off any run; that is the "forced" case). Anyone else: 403
 *        `forbidden`, target "$.path.run_id", next_action "use_current_holder", details {allowed:
 *        "current_lease_holder_or_owner", actor_id}.
 *        -> 201 {parent_run_id, new_run_id, status:"queued", lease:{released:true, fence}, pending_input_count}
 *        (a NEW run whose parent_run_id is the old one; the old lease is gone). `/handoff` singular is 404.
 *     POST P/runs/{r}/interrupt   {reason?, mode?:"graceful"}   -> 202
 *        {operation_id, run_id, state:"pending", accepted:true}
 *     POST P/runs/{r}/cancel      {reason?, confirm: true}      -> 202
 *        {operation_id, run_id, state:"cancel_requested", db_adoption_blocked:true, external_cancel_state:"pending"}
 *        Callers: the owner session, or the token actor that holds the run's lease; no lease fields. Others
 *        403 `forbidden` (target "$.path.run_id", next_action "use_owner_session", details {allowed:
 *        "own_run_or_owner", actor_kind}). A finished run: 409 `run_terminal` (target "$.path.run_id",
 *        next_action "create_new_run", details {run_id, status}). cancel is a NEW core command `run.cancel`
 *        (queued runs too; status 'cancelled'). 202 = durably accepted only: the run is already
 *        interrupted/cancelled in the database, the header `location` = "/api/v1/projects/{id}/operations/{operation_id}",
 *        and a failed commit is never 202.
 *     GET P/operations/{id}   -> 200 {operation_id, run_id, action ("run.interrupt"|"run.cancel"), state (the
 *        202's state), accepted_at}; the owner and the actor that asked may read it, anyone else and unknown ids 404.
 *     GET P/requests/{key}    -> 200 {key, state:"completed", action, status (HTTP status first returned),
 *        operation_id|null, tx_id}; same visibility; unknown 404.
 *     GET P/runs/{r}/inputs?cursor=&wait_ms=   scope context:read, the run's own actor
 *        -> 200 {inputs:[{input_version_id, kind:"answer", question_id, available_at (ms), state:"new"}],
 *                next_cursor, has_more, epoch}. A cursor from another epoch: 400 `cursor_invalid`
 *                (details {reason:"epoch_changed", current_epoch}, next_action "reread_context").
 *        The inputs a run sees are the answers to questions that the run's actor asked. Pure read: no
 *        receipt, no heartbeat, no transition. wait_ms 0..25000 (default 0); with nothing new the server
 *        waits through the injected sleep AFTER the read, holding no transaction, then reads once more.
 *     POST P/runs/{r}/input-receipts  {lease_id, fence, receipts:[{input_version_id, state:"seen"|"applied"|
 *        "ignored", reason?, applied_tx_id?}] (1..20, all-or-nothing)} -> 200 {accepted:[{input_version_id,
 *        state}]} (an already applied input answers state "applied"). An input that is not this run's:
 *        403 `input_not_visible` (target "$.body.receipts[i].input_version_id", next_action
 *        "check_run_targets", details {run_id, reason:"not_in_run_targets"}); applied without applied_tx_id is 400;
 *        a stale lease is 409 `lease_lost`.
 *
 * The 429/min-interval rules are in test_api_errors_capabilities.test.ts; everything here keeps the fake
 * clock moving past the poll gap announced by capabilities (limits.min_poll_interval_ms).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DECIMAL,
  agent_claims,
  assert_ok,
  call,
  go_off,
  make_agent,
  owner_creates_run,
  with_api,
  type Agent,
  type ApiEnv,
  type Lease,
} from "./helpers/api_env.ts";
import { P, assert_final_error, restart_app, until_gate, NEXT_ACTION } from "./helpers/api_flow.ts";
import { wrap_db } from "./helpers/blob_env.ts";
import { open_round, single_spec } from "./helpers/questions_env.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

const guard = (lease: Lease) => ({ lease_id: lease.lease_id, fence: lease.fence });

async function min_poll_gap(env: ApiEnv): Promise<number> {
  const caps = assert_ok(await call(env, { method: "GET", path: "/api/v1/capabilities" }));
  const gap = caps.limits.min_poll_interval_ms;
  assert.ok(Number.isSafeInteger(gap) && gap > 0 && gap <= 10_000, "capabilities announces a sane min poll interval");
  return gap;
}

interface Asked {
  set_id: string;
  question_id: string;
  question_version_id: string;
}

/** The agent publishes one question under its lease; returns the ids. */
async function agent_asks(env: ApiEnv, agent: Agent, lease: Lease): Promise<Asked> {
  const { stage_id, round_id } = await open_round(env, `ask${env.seq++}`);
  const res = await call(env, {
    method: "POST",
    path: P(env, "/questions"),
    auth: { token: agent.token },
    body: {
      stage_id,
      round_id,
      purpose: "review",
      form_key: "ask",
      question: single_spec("에이전트의 합성 질문"),
      run_id: lease.run_id,
      lease_id: lease.lease_id,
      fence: lease.fence,
    },
  });
  const data = assert_ok(res, 201);
  return { set_id: data.question_set_id, question_id: data.question.id, question_version_id: data.question.version_id };
}

/** The owner answers; returns the answer version id (the "input_version_id" the agent sees). */
async function owner_answers(env: ApiEnv, q: Asked, value = "a"): Promise<string> {
  const res = await call(env, {
    method: "POST",
    path: P(env, "/submissions"),
    auth: "owner",
    body: { set_id: q.set_id, answers: [{ question_id: q.question_id, question_version_id: q.question_version_id, value }] },
  });
  return assert_ok(res, 201).answers[0].answer_version_id as string;
}

// ---------------------------------------------------------------------------
// heartbeat / release / handoffs

test("heartbeat extends the lease, not the token; stale fence is lease_lost, numeric fence 400, expired lease lease_lost", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "beater");
    const lease = await agent_claims(env, agent);
    const token_before = env.db.get<{ expires_at: bigint }>("SELECT expires_at FROM agent_tokens WHERE id = ?", agent.token_id)!.expires_at;
    const path = P(env, `/runs/${lease.run_id}/heartbeat`);
    const ctx0 = assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: { token: agent.token } }));
    env.clock.advance(20_000);
    const res = await call(env, {
      method: "POST",
      path,
      auth: { token: agent.token },
      body: { ...guard(lease), progress: { phase: "reading_context", observed_at: env.clock.now_ms() } },
    });
    const data = assert_ok(res);
    assert.equal(data.run_id, lease.run_id);
    assert.equal(data.lease.lease_id, lease.lease_id);
    assert.equal(data.lease.fence, lease.fence);
    assert.match(data.lease.fence, DECIMAL);
    assert.ok(Number.isSafeInteger(data.lease.expires_at));
    assert.ok(data.lease.expires_at > ctx0.lease.expires_at, "the lease deadline moved forward");
    assert.equal(data.server_time, env.clock.now_ms());
    const token_after = env.db.get<{ expires_at: bigint }>("SELECT expires_at FROM agent_tokens WHERE id = ?", agent.token_id)!.expires_at;
    assert.equal(token_after, token_before, "a heartbeat never lengthens the token");

    const sig = state_signature(env.db);
    const lost = assert_final_error(
      await call(env, { method: "POST", path, auth: { token: agent.token }, body: { ...guard(lease), fence: "99" } }),
      409,
      "lease_lost",
      { target: "$.body.fence", next_action: NEXT_ACTION.lease_lost },
    );
    assert.equal(lost.details.expected_fence, "99");
    assert.equal(lost.details.current_fence, lease.fence);
    assert.equal(lost.details.current_lease_id, lease.lease_id);
    assert_final_error(await call(env, { method: "POST", path, auth: { token: agent.token }, body: { ...guard(lease), fence: Number(lease.fence) } }), 400, "invalid_payload", {
      target: "$.body.fence",
    });
    assert_final_error(await call(env, { method: "POST", path, auth: { token: agent.token }, body: { fence: lease.fence } }), 400, "invalid_payload", {
      target: "$.body.lease_id",
    });
    assert_final_error(await call(env, { method: "POST", path, auth: { token: agent.token }, body: { ...guard(lease), extra: 1 } }), 400, "invalid_payload", {
      target: "$.body.extra",
    });
    assert_final_error(await call(env, { method: "POST", path, body: guard(lease) }), 401, "unauthenticated");
    assert_final_error(await call(env, { method: "POST", path, auth: "owner", body: guard(lease) }), 403, "forbidden");
    assert.equal(state_signature(env.db), sig);

    env.clock.advance(data.lease.expires_at - env.clock.now_ms() + 1);
    assert_final_error(await call(env, { method: "POST", path, auth: { token: agent.token }, body: guard(lease) }), 409, "lease_lost", {
      target: "$.body.fence",
      next_action: NEXT_ACTION.lease_lost,
    });
  });
});

test("release returns the run to the queue and drops the lease; the old lease is lost; a replay answers the same", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "releaser");
    const lease = await agent_claims(env, agent);
    const path = P(env, `/runs/${lease.run_id}/release`);
    const first = await call(env, { method: "POST", path, auth: { token: agent.token }, body: guard(lease), key: "rel-1" });
    assert.equal(assert_ok(first).status, "queued");
    const run = env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", lease.run_id);
    assert.equal(run?.status, "queued");
    const ctx = assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: { token: agent.token } }));
    assert.equal(ctx.lease, null);

    const sig = state_signature(env.db);
    const replay = await call(env, { method: "POST", path, auth: { token: agent.token }, body: guard(lease), key: "rel-1" });
    assert.equal(replay.json.replayed, true);
    assert.equal(state_signature(env.db), sig);
    assert_final_error(await call(env, { method: "POST", path, auth: { token: agent.token }, body: guard(lease), key: "rel-2" }), 409, "lease_lost", {
      next_action: NEXT_ACTION.lease_lost,
    });
    assert_final_error(
      await call(env, { method: "POST", path: P(env, `/runs/${lease.run_id}/results`), auth: { token: agent.token }, body: { ...guard(lease), results: [{ op: "append_version", object_id: "x", title: "t" }] } }),
      409,
      "conflict",
    );
  });
});

test("handoffs: the holder or the owner creates a child run (201); anyone else is 403; singular /handoff is not a route", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "hander");
    const target = await make_agent(env, "handee");
    const lease = await agent_claims(env, agent);
    const path = P(env, `/runs/${lease.run_id}/handoffs`);
    const body = { target_mode: "B", target_actor_id: target.actor_id, reason: "합성 인계", include_pending_inputs: true };
    const sig = state_signature(env.db);

    assert_final_error(await call(env, { method: "POST", path: P(env, `/runs/${lease.run_id}/handoff`), auth: { token: agent.token }, body }), 404, "not_found");
    const denied = assert_final_error(await call(env, { method: "POST", path, auth: { token: target.token }, body }), 403, "forbidden", {
      target: "$.path.run_id",
      next_action: NEXT_ACTION.forbidden_holder,
    });
    assert.equal(denied.details.allowed, "current_lease_holder_or_owner");
    assert.equal(denied.details.actor_id, target.actor_id);
    assert_final_error(await call(env, { method: "POST", path, auth: { token: agent.token }, body: { ...body, target_mode: "C" } }), 400, "invalid_payload", { target: "$.body.target_mode" });
    assert_final_error(await call(env, { method: "POST", path, auth: { token: agent.token }, body: { ...body, lease_id: lease.lease_id } }), 400, "invalid_payload", { target: "$.body.lease_id" });
    assert_final_error(await call(env, { method: "POST", path, body }), 401, "unauthenticated");
    assert.equal(state_signature(env.db), sig);

    const handed = assert_ok(await call(env, { method: "POST", path, auth: { token: agent.token }, body }), 201);
    assert.equal(handed.parent_run_id, lease.run_id);
    assert.equal(typeof handed.new_run_id, "string");
    assert.notEqual(handed.new_run_id, lease.run_id);
    assert.equal(handed.status, "queued");
    assert.equal(handed.lease.released, true);
    assert.equal(handed.lease.fence, lease.fence);
    assert.ok(Number.isSafeInteger(handed.pending_input_count) && handed.pending_input_count >= 0);
    const child = env.db.get<{ parent_run_id: string; status: string; actor_id: string }>("SELECT parent_run_id, status, actor_id FROM runs WHERE id = ?", handed.new_run_id);
    assert.equal(child?.parent_run_id, lease.run_id);
    assert.equal(child?.status, "queued");
    assert.equal(child?.actor_id, target.actor_id);
    assert.notEqual(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", lease.run_id)?.status, "running");
    assert.equal(assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: "owner" })).lease, null);
    assert_final_error(await call(env, { method: "POST", path: P(env, `/runs/${lease.run_id}/heartbeat`), auth: { token: agent.token }, body: guard(lease) }), 409, "lease_lost");

    // The owner (a human) may hand off a run that another agent holds.
    const held = await agent_claims(env, target);
    const forced = assert_ok(await call(env, { method: "POST", path: P(env, `/runs/${held.run_id}/handoffs`), auth: "owner", body: { target_mode: "B", target_actor_id: agent.actor_id, reason: "합성 강제 인계" } }), 201);
    assert.equal(forced.parent_run_id, held.run_id);
    assert.equal(assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: "owner" })).lease, null);
  });
});

// ---------------------------------------------------------------------------
// interrupt / cancel / 202 / operations / requests

const NOT_ALLOWED = { target: "$.path.run_id", next_action: NEXT_ACTION.human_required } as const;

test("interrupt and cancel answer 202 only after the database has changed; operation and request lookups agree", async () => {
  await with_api(async (env) => {
    const holder = await make_agent(env, "interrupted");
    const lease = await agent_claims(env, holder);
    const stranger = await make_agent(env, "stranger");
    const interrupt_path = P(env, `/runs/${lease.run_id}/interrupt`);

    const sig = state_signature(env.db);
    const forbidden = assert_final_error(await call(env, { method: "POST", path: interrupt_path, auth: { token: stranger.token }, body: {} }), 403, "forbidden", NOT_ALLOWED);
    assert.equal(forbidden.details.allowed, "own_run_or_owner");
    assert.equal(forbidden.details.actor_kind, "external_agent");
    assert_final_error(await call(env, { method: "POST", path: P(env, `/runs/${lease.run_id}/cancel`), auth: { token: stranger.token }, body: { confirm: true } }), 403, "forbidden", NOT_ALLOWED);
    assert_final_error(await call(env, { method: "POST", path: interrupt_path, body: {} }), 401, "unauthenticated");
    assert_final_error(await call(env, { method: "POST", path: interrupt_path, auth: { token: holder.token }, body: { mode: "forceful" } }), 400, "invalid_payload", { target: "$.body.mode" });
    assert_final_error(await call(env, { method: "POST", path: interrupt_path, auth: { token: holder.token }, body: { lease_id: lease.lease_id } }), 400, "invalid_payload", { target: "$.body.lease_id" });
    assert.equal(state_signature(env.db), sig);

    const res = await call(env, {
      method: "POST",
      path: interrupt_path,
      auth: { token: holder.token },
      body: { format_version: "1.0", reason: "합성 중단", mode: "graceful" },
      key: "int-1",
    });
    const data = assert_ok(res, 202);
    assert.equal(data.run_id, lease.run_id);
    assert.equal(data.state, "pending");
    assert.equal(data.accepted, true);
    assert.equal(typeof data.operation_id, "string");
    assert.equal(res.headers["location"], P(env, `/operations/${data.operation_id}`));
    // Accepted means durable: the run is already interrupted and the lease is gone.
    assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", lease.run_id)?.status, "interrupted");
    assert.equal(assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: "owner" })).lease, null);

    const op = assert_ok(await call(env, { method: "GET", path: P(env, `/operations/${data.operation_id}`), auth: "owner" }));
    assert.equal(op.operation_id, data.operation_id);
    assert.equal(op.run_id, lease.run_id);
    assert.equal(op.action, "run.interrupt");
    assert.equal(op.state, data.state);
    assert.ok(Number.isSafeInteger(op.accepted_at));
    assert.deepEqual(assert_ok(await call(env, { method: "GET", path: P(env, `/operations/${data.operation_id}`), auth: { token: holder.token } })), op);

    const req = assert_ok(await call(env, { method: "GET", path: P(env, "/requests/int-1"), auth: { token: holder.token } }));
    assert.equal(req.key, "int-1");
    assert.equal(req.state, "completed");
    assert.equal(req.status, 202);
    assert.equal(req.operation_id, data.operation_id);
    assert.equal(req.action, "run.interrupt");

    const sig2 = state_signature(env.db);
    const again = await call(env, { method: "POST", path: interrupt_path, auth: { token: holder.token }, body: { format_version: "1.0", reason: "합성 중단", mode: "graceful" }, key: "int-1" });
    assert.equal(again.status, 202);
    assert.equal(again.json.replayed, true);
    assert.equal(again.json.data.operation_id, data.operation_id);
    assert.equal(state_signature(env.db), sig2);
    // A finished run cannot be cancelled or interrupted again: 409 run_terminal.
    const done = assert_final_error(await call(env, { method: "POST", path: P(env, `/runs/${lease.run_id}/cancel`), auth: "owner", body: { confirm: true } }), 409, "run_terminal", {
      target: "$.path.run_id",
      next_action: NEXT_ACTION.run_terminal,
    });
    assert.deepEqual({ ...done.details }, { run_id: lease.run_id, status: "interrupted" });
  });
});

test("cancel: the owner cancels a queued run (202, no lease needed, confirm required); a finished run is run_terminal; the holder may cancel its own run", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "cancelee");
    const queued = await owner_creates_run(env, agent);
    const path = P(env, `/runs/${queued}/cancel`);
    assert_final_error(await call(env, { method: "POST", path, auth: "owner", body: { reason: "확인 없음" } }), 400, "invalid_payload", { target: "$.body.confirm" });
    assert_final_error(await call(env, { method: "POST", path, auth: "owner", body: { confirm: "yes" } }), 400, "invalid_payload", { target: "$.body.confirm" });
    assert.notEqual(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", queued)?.status, "cancelled");
    const res = await call(env, { method: "POST", path, auth: "owner", body: { format_version: "1.0", reason: "합성 취소", confirm: true } });
    const data = assert_ok(res, 202);
    assert.equal(data.run_id, queued);
    assert.equal(data.state, "cancel_requested");
    assert.equal(data.db_adoption_blocked, true);
    assert.equal(data.external_cancel_state, "pending");
    assert.equal(res.headers["location"], P(env, `/operations/${data.operation_id}`));
    assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", queued)?.status, "cancelled");
    const op = assert_ok(await call(env, { method: "GET", path: P(env, `/operations/${data.operation_id}`), auth: "owner" }));
    assert.equal(op.action, "run.cancel");
    assert.equal(op.state, "cancel_requested");
    const done = assert_final_error(await call(env, { method: "POST", path, auth: "owner", body: { confirm: true } }), 409, "run_terminal", {
      target: "$.path.run_id",
      next_action: NEXT_ACTION.run_terminal,
    });
    assert.deepEqual({ ...done.details }, { run_id: queued, status: "cancelled" });

    const lease = await agent_claims(env, agent);
    const own = await call(env, { method: "POST", path: P(env, `/runs/${lease.run_id}/cancel`), auth: { token: agent.token }, body: { confirm: true } });
    assert_ok(own, 202);
    assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", lease.run_id)?.status, "cancelled");
    assert_final_error(await call(env, { method: "POST", path: P(env, "/runs/no-such-run/cancel"), auth: "owner", body: { confirm: true } }), 404, "not_found");
  });
});

test("the owner interrupts a running run without naming its lease: 202, the lease is released", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "victim");
    const lease = await agent_claims(env, agent);
    const res = await call(env, { method: "POST", path: P(env, `/runs/${lease.run_id}/interrupt`), auth: "owner", body: { reason: "합성 사람 중단" } });
    assert.equal(assert_ok(res, 202).state, "pending");
    assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", lease.run_id)?.status, "interrupted");
    assert.equal(assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: "owner" })).lease, null);
    assert_final_error(await call(env, { method: "POST", path: P(env, `/runs/${lease.run_id}/heartbeat`), auth: { token: agent.token }, body: guard(lease) }), 409, "lease_lost");
    // A queued run cannot be "interrupted" — only cancelled.
    const queued = await owner_creates_run(env, agent);
    assert_final_error(await call(env, { method: "POST", path: P(env, `/runs/${queued}/interrupt`), auth: "owner", body: {} }), 409, "conflict");
  });
});

test("a commit that fails is never 202, and no operation exists for it", async () => {
  let armed = false;
  await with_api(
    async (env) => {
      const agent = await make_agent(env, "unlucky");
      const lease = await agent_claims(env, agent);
      armed = true;
      const sig = state_signature(env.db);
      const res = await call(env, { method: "POST", path: P(env, `/runs/${lease.run_id}/interrupt`), auth: "owner", body: { reason: "x" }, key: "fail-1" });
      assert.equal(res.status, 500);
      assert.equal(res.json.error.code, "internal_error");
      assert.equal(res.json.data, undefined);
      assert.equal(state_signature(env.db), sig, "all or nothing");
      armed = false;
      assert_final_error(await call(env, { method: "GET", path: P(env, "/requests/fail-1"), auth: "owner" }), 404, "not_found");
      const retry = await call(env, { method: "POST", path: P(env, `/runs/${lease.run_id}/interrupt`), auth: "owner", body: { reason: "x" }, key: "fail-1" });
      assert_ok(retry, 202);
      assert.equal(retry.json.replayed, false);
    },
    {
      wrap: (db) =>
        wrap_db(db, (sql) => {
          if (armed && /^\s*INSERT INTO mutation_commits\b/i.test(sql)) throw new Error("boom: disk full");
        }),
    },
  );
});

test("operation and request lookups hide other callers' and unknown things as 404 and survive a server restart", async () => {
  await with_api(async (env) => {
    const asker = await make_agent(env, "asker-op");
    const other = await make_agent(env, "other-op");
    const lease = await agent_claims(env, asker);
    const accepted = await call(env, { method: "POST", path: P(env, `/runs/${lease.run_id}/interrupt`), auth: { token: asker.token }, body: { reason: "합성" }, key: "op-key" });
    const op_id = assert_ok(accepted, 202).operation_id as string;
    const claim_key_req = await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: other.token }, body: { mode: "B", runtime: "r", provider: "p", model: "m" }, key: "other-claim" });
    assert_ok(claim_key_req);

    for (const [path, auth] of [
      [P(env, `/operations/${op_id}`), { token: other.token }],
      [P(env, "/requests/op-key"), { token: other.token }],
      [P(env, "/operations/no-such-operation"), "owner"],
      [P(env, "/requests/no-such-key"), "owner"],
    ] as const) {
      assert_final_error(await call(env, { method: "GET", path, auth }), 404, "not_found");
    }
    assert_final_error(await call(env, { method: "GET", path: P(env, `/operations/${op_id}`) }), 401, "unauthenticated");
    // Another project's operation is not found here either.
    const created = await call(env, { method: "POST", path: "/api/v1/projects", auth: "owner", body: { slug: "op-other", topic: "합성", owner_display_name: "합성 둘" } });
    const other_project = assert_ok(created, 201).project_id as string;
    assert_final_error(await call(env, { method: "GET", path: `/api/v1/projects/${other_project}/operations/${op_id}`, auth: "owner" }), 404, "not_found");

    const before_op = assert_ok(await call(env, { method: "GET", path: P(env, `/operations/${op_id}`), auth: "owner" }));
    const before_req = assert_ok(await call(env, { method: "GET", path: P(env, "/requests/op-key"), auth: "owner" }));
    restart_app(env);
    assert.deepEqual(assert_ok(await call(env, { method: "GET", path: P(env, `/operations/${op_id}`), auth: "owner" })), before_op);
    assert.deepEqual(assert_ok(await call(env, { method: "GET", path: P(env, "/requests/op-key"), auth: "owner" })), before_req);
    assert.deepEqual(assert_ok(await call(env, { method: "GET", path: P(env, `/operations/${op_id}`), auth: { token: asker.token } })), before_op);
    // The same key after the restart is still a replay of the first answer, with the same operation.
    const replay = await call(env, { method: "POST", path: P(env, `/runs/${lease.run_id}/interrupt`), auth: { token: asker.token }, body: { reason: "합성" }, key: "op-key" });
    assert.equal(replay.status, 202);
    assert.equal(replay.json.replayed, true);
    assert.equal(replay.json.data.operation_id, op_id);
  });
});

// ---------------------------------------------------------------------------
// inputs (long-poll) and receipts

test("inputs: the answers to the run's own questions, pure read, resumable by cursor; another run's actor sees none", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "poller");
    const lease = await agent_claims(env, agent);
    const gap = await min_poll_gap(env);
    const set = await agent_asks(env, agent, lease);
    const path = P(env, `/runs/${lease.run_id}/inputs`);

    const empty = assert_ok(await call(env, { method: "GET", path, auth: { token: agent.token } }));
    assert.deepEqual(empty.inputs, []);
    assert.equal(empty.has_more, false);
    assert.equal(typeof empty.next_cursor, "string");
    assert.match(empty.epoch, DECIMAL);
    assert.equal(empty.waited_ms, undefined);

    const answered = await owner_answers(env, set);
    env.clock.advance(gap);
    const counts = table_counts(env.db);
    const sig_before = state_signature(env.db);
    const res = await call(env, { method: "GET", path: `${path}?cursor=${encodeURIComponent(empty.next_cursor)}`, auth: { token: agent.token } });
    const data = assert_ok(res);
    assert.equal(data.inputs.length, 1);
    const { available_at, ...item } = data.inputs[0];
    assert.deepEqual(item, { input_version_id: answered, kind: "answer", question_id: set.question_id, state: "new" });
    assert.ok(Number.isSafeInteger(available_at));
    assert.equal(state_signature(env.db), sig_before, "reading inputs writes nothing: no receipt, no heartbeat");
    assert.deepEqual(table_counts(env.db), counts);

    // Resuming from the new cursor returns nothing more; from the old cursor the same input again.
    env.clock.advance(gap);
    const tail = assert_ok(await call(env, { method: "GET", path: `${path}?cursor=${encodeURIComponent(data.next_cursor)}`, auth: { token: agent.token } }));
    assert.deepEqual(tail.inputs, []);
    env.clock.advance(gap);
    const again = assert_ok(await call(env, { method: "GET", path: `${path}?cursor=${encodeURIComponent(empty.next_cursor)}`, auth: { token: agent.token } }));
    assert.deepEqual(again.inputs, data.inputs);

    // An actor whose run did not ask the question sees no input, and cannot read this run's inputs.
    // (the project has ONE lease at a time, so the other actor's run is only queued)
    const other = await make_agent(env, "not-asker");
    const other_run = await owner_creates_run(env, other);
    env.clock.advance(gap);
    const none = assert_ok(await call(env, { method: "GET", path: P(env, `/runs/${other_run}/inputs`), auth: { token: other.token } }));
    assert.deepEqual(none.inputs, []);
    assert_final_error(await call(env, { method: "GET", path, auth: { token: other.token } }), 403, "forbidden");
    assert_final_error(await call(env, { method: "GET", path: P(env, "/runs/no-such-run/inputs"), auth: { token: agent.token } }), 404, "not_found");
    assert_final_error(await call(env, { method: "GET", path }), 401, "unauthenticated");
    for (const bad of ["-1", "25001", "abc", "1.5", ""]) {
      env.clock.advance(gap);
      assert_final_error(await call(env, { method: "GET", path: `${path}?wait_ms=${bad}`, auth: { token: agent.token } }), 400, "invalid_payload", {
        target: "$.query.wait_ms",
      });
    }
    env.clock.advance(gap);
    assert_final_error(await call(env, { method: "GET", path: `${path}?cursor=garbage`, auth: { token: agent.token } }), 400, "cursor_invalid", {
      target: "$.query.cursor",
      next_action: NEXT_ACTION.cursor_invalid,
    });
    // A cursor from before an epoch change is cursor_invalid with the reason (the documents' inputs.json).
    env.db.run("UPDATE db_meta SET cursor_epoch = cursor_epoch + 1 WHERE id = 1");
    env.clock.advance(gap);
    const epoch = env.db.get<{ cursor_epoch: bigint }>("SELECT cursor_epoch FROM db_meta WHERE id = 1")!.cursor_epoch;
    const stale = assert_final_error(
      await call(env, { method: "GET", path: `${path}?cursor=${encodeURIComponent(data.next_cursor)}`, auth: { token: agent.token } }),
      400,
      "cursor_invalid",
      { target: "$.query.cursor", next_action: NEXT_ACTION.cursor_invalid },
    );
    assert.equal(stale.details.reason, "epoch_changed");
    assert.equal(stale.details.current_epoch, epoch.toString());
  });
});

test("long-poll: with nothing new the request waits through the injected sleep holding no transaction, and returns what arrives meanwhile", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "waiter");
    const lease = await agent_claims(env, agent);
    const gap = await min_poll_gap(env);
    const set = await agent_asks(env, agent, lease);
    const path = P(env, `/runs/${lease.run_id}/inputs`);
    const start = assert_ok(await call(env, { method: "GET", path, auth: { token: agent.token } }));
    env.clock.advance(gap);

    env.hold_sleep = true;
    const pending = call(env, { method: "GET", path: `${path}?cursor=${encodeURIComponent(start.next_cursor)}&wait_ms=25000`, auth: { token: agent.token } });
    await until_gate(env);
    assert.equal(env.gates[0]!.ms, 25_000);
    // While it waits, the database is free: a write (an owner's answer) goes through at once.
    env.hold_sleep = false;
    const answered = await owner_answers(env, set);
    env.gates[0]!.release();
    const res = await pending;
    const data = assert_ok(res);
    assert.equal(data.inputs.length, 1);
    assert.equal(data.inputs[0].input_version_id, answered);

    // Nothing arrives: the wait ends with an empty answer (200), not an error, and the cursor is usable.
    env.clock.advance(gap);
    env.hold_sleep = true;
    const idle = call(env, { method: "GET", path: `${path}?cursor=${encodeURIComponent(data.next_cursor)}&wait_ms=1000`, auth: { token: agent.token } });
    await until_gate(env, 2);
    assert.equal(env.gates[1]!.ms, 1_000);
    env.gates[1]!.release();
    const idle_data = assert_ok(await idle);
    assert.deepEqual(idle_data.inputs, []);
    assert.equal(typeof idle_data.next_cursor, "string");
  });
});

test("long-poll does not wait when something is already there, and wait_ms=0 never sleeps", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "eager");
    const lease = await agent_claims(env, agent);
    const gap = await min_poll_gap(env);
    const set = await agent_asks(env, agent, lease);
    await owner_answers(env, set);
    const path = P(env, `/runs/${lease.run_id}/inputs`);
    env.hold_sleep = true;
    const ready = assert_ok(await call(env, { method: "GET", path: `${path}?wait_ms=25000`, auth: { token: agent.token } }));
    assert.equal(ready.inputs.length, 1);
    env.clock.advance(gap);
    assert_ok(await call(env, { method: "GET", path: `${path}?cursor=${encodeURIComponent(ready.next_cursor)}&wait_ms=0`, auth: { token: agent.token } }));
    assert.equal(env.gates.length, 0, "no sleep was requested");
  });
});

test("input receipts: seen then applied with a real mutation receipt; all-or-nothing; replay; not-visible inputs are refused", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "receipter");
    const lease = await agent_claims(env, agent);
    const set = await agent_asks(env, agent, lease);
    const input = await owner_answers(env, set);
    const path = P(env, `/runs/${lease.run_id}/input-receipts`);
    const post = (body: unknown, key?: string) => call(env, { method: "POST", path, auth: { token: agent.token }, body, key });

    const seen = await post({ ...guard(lease), receipts: [{ input_version_id: input, state: "seen" }] }, "rec-1");
    assert.deepEqual(assert_ok(seen).accepted, [{ input_version_id: input, state: "seen" }]);
    assert.equal(env.db.get<{ state: string }>("SELECT state FROM run_input_receipts WHERE run_id = ? AND input_version_id = ?", lease.run_id, input)?.state, "seen");
    const replay = await post({ ...guard(lease), receipts: [{ input_version_id: input, state: "seen" }] }, "rec-1");
    assert.equal(replay.json.replayed, true);

    const sig = state_signature(env.db);
    assert_final_error(await post({ ...guard(lease), receipts: [{ input_version_id: input, state: "applied" }] }), 400, "invalid_payload", {
      target: "$.body.receipts[0].applied_tx_id",
    });
    assert_final_error(await post({ ...guard(lease), receipts: [] }), 400, "invalid_payload", { target: "$.body.receipts" });
    assert_final_error(await post({ ...guard(lease), receipts: Array.from({ length: 21 }, () => ({ input_version_id: input, state: "seen" })) }), 400, "invalid_payload", {
      target: "$.body.receipts",
    });
    assert_final_error(await post({ ...guard(lease), receipts: [{ input_version_id: input, state: "done" }] }), 400, "invalid_payload", {
      target: "$.body.receipts[0].state",
    });
    assert_final_error(await post({ ...guard(lease), fence: "999", receipts: [{ input_version_id: input, state: "seen" }] }), 409, "lease_lost", {
      target: "$.body.fence",
      next_action: NEXT_ACTION.lease_lost,
    });
    const not_mine = await post({
      ...guard(lease),
      receipts: [
        { input_version_id: input, state: "ignored", reason: "합성" },
        { input_version_id: set.question_version_id, state: "seen" },
      ],
    });
    const error = assert_final_error(not_mine, 403, "input_not_visible", {
      target: "$.body.receipts[1].input_version_id",
      next_action: NEXT_ACTION.input_not_visible,
    });
    assert.equal(error.details.run_id, lease.run_id);
    assert.equal(error.details.reason, "not_in_run_targets");
    assert.equal(state_signature(env.db), sig, "the good item of a refused bundle is not saved");

    const tx = env.db.get<{ id: string }>("SELECT id FROM mutation_commits WHERE project_id = ? ORDER BY rowid DESC LIMIT 1", env.p.project_id)!.id;
    const applied = await post({ ...guard(lease), receipts: [{ input_version_id: input, state: "applied", applied_tx_id: tx }] });
    assert.deepEqual(assert_ok(applied).accepted, [{ input_version_id: input, state: "applied" }]);
    const twice = await post({ ...guard(lease), receipts: [{ input_version_id: input, state: "seen" }] });
    assert.deepEqual(assert_ok(twice).accepted, [{ input_version_id: input, state: "applied" }], "an applied input stays applied");
    assert_final_error(await call(env, { method: "POST", path, auth: "owner", body: { ...guard(lease), receipts: [{ input_version_id: input, state: "seen" }] } }), 403, "forbidden");
  });
});

test("after a server restart the same lease keeps working: inputs by an old cursor, a receipt replay, and a heartbeat", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "survivor");
    const lease = await agent_claims(env, agent);
    const gap = await min_poll_gap(env);
    const set = await agent_asks(env, agent, lease);
    const path = P(env, `/runs/${lease.run_id}/inputs`);
    const start = assert_ok(await call(env, { method: "GET", path, auth: { token: agent.token } }));
    const input = await owner_answers(env, set);
    const receipt_body = { ...guard(lease), receipts: [{ input_version_id: input, state: "seen" }] };
    const first = await call(env, { method: "POST", path: P(env, `/runs/${lease.run_id}/input-receipts`), auth: { token: agent.token }, body: receipt_body, key: "rr-1" });
    assert_ok(first);

    restart_app(env);
    env.clock.advance(gap);
    const inputs = assert_ok(await call(env, { method: "GET", path: `${path}?cursor=${encodeURIComponent(start.next_cursor)}`, auth: { token: agent.token } }));
    assert.equal(inputs.inputs.length, 1);
    const replay = await call(env, { method: "POST", path: P(env, `/runs/${lease.run_id}/input-receipts`), auth: { token: agent.token }, body: receipt_body, key: "rr-1" });
    assert.equal(replay.json.replayed, true);
    assert_ok(await call(env, { method: "POST", path: P(env, `/runs/${lease.run_id}/heartbeat`), auth: { token: agent.token }, body: guard(lease) }));
  });
});

test("Go OFF stops an internal_ai run's inputs as policy_blocked; an external agent is unaffected", async () => {
  await with_api(async (env) => {
    const internal = await make_agent(env, "go-int", undefined, "internal_ai");
    const internal_run = await owner_creates_run(env, internal);
    const external = await make_agent(env, "go-ext");
    const ext_lease = await agent_claims(env, external);
    await go_off(env);
    const gap = await min_poll_gap(env);
    assert_final_error(await call(env, { method: "GET", path: P(env, `/runs/${internal_run}/inputs`), auth: { token: internal.token } }), 403, "policy_blocked", {
      next_action: NEXT_ACTION.policy_blocked,
    });
    env.clock.advance(gap);
    assert_ok(await call(env, { method: "GET", path: P(env, `/runs/${ext_lease.run_id}/inputs`), auth: { token: external.token } }));
    assert_ok(await call(env, { method: "POST", path: P(env, `/runs/${ext_lease.run_id}/heartbeat`), auth: { token: external.token }, body: guard(ext_lease) }));
  });
});

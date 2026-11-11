/**
 * SEL-56 PR21 — A·B 교차 계약, unknown 편 (tester, 작성 모드). 완료 조건 5:
 *   unknown 예약(전송했을 수 있는 dispatch)은 자동 해제하지 않는다 — 인계·재시작·OFF/ON 뒤에도 unknown 그대로.
 * "unknown" here is the PR19 meaning: a model call whose outcome PES does not know (lost reply, timeout, an answer it could
 * not record). It keeps counting against the connection's usage (the 'reservation') and keeps the run from resuming until
 * a human owner settles it with dispatch.resolve_unknown. Settling is recorded BESIDE the call (dispatch_resolutions); the
 * call row itself stays 'unknown' (docs/plan/stage-2-db-guarantees.md 8.16).
 *
 * The thing nothing but a human may change is the settlement. So each test freezes the call row and the settlement table
 * and walks it through B taking over, A taking over again, Go OFF/ON, a restart of the executor and a month of clock.
 *
 * 해석:
 *  해석 17  '자동 해제하지 않는다' = (a) 호출 행(state·unknown_at·unknown_reason·sent_at·usage)이 한 글자도 안 바뀐다,
 *           (b) dispatch_resolutions 에 행이 생기지 않는다, (c) 예약이 계속 한도에 잡혀 새 A 시작을 막는다, (d) 그 run 의
 *           재개가 막힌다. 사람이 정리하면 (b)만 한 줄 생기고 (a)는 그대로다(한 번 더 정리하면 conflict).
 *  해석 18  B(외부 에이전트)는 unknown 을 만들 수도, 정리할 수도 없다: B run 에는 dispatch 가 없고, 에이전트 actor 의
 *           dispatch.resolve_unknown 은 forbidden 이다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BuiltinExecutor } from "../scripts/pes_core/a_runtime/loop.ts";
import { AiConnectionService } from "../scripts/pes_core/a_runtime/connections.ts";
import { Driver, type Side } from "./helpers/cross_driver.ts";
import {
  B_TOOLS,
  dispatch_count,
  lease_row,
  make_cross_env,
  ready_cross,
  unknown_dispatches,
  with_cross_env,
  type CrossEnv,
} from "./helpers/cross_env.ts";
import {
  FINISH,
  MONTH,
  dispatches,
  next_key,
  open_stage,
  policy_off,
  policy_on,
  ready_project,
  resume_outcome,
  set_script,
  start_outcome,
  start_run,
  type ExecResult,
} from "./helpers/a_builtin_env.ts";

const B: Side = { kind: "B", tool: B_TOOLS[2]! };
const A: Side = { kind: "A" };
const NARROW = 20_000;
const BIG = 1_000_000_000;
const BIG_CALL = 8_000; // one call fits under 90% of NARROW, a second one does not (docs: PR19 F5)

interface Frozen {
  run_id: string;
  dispatch_id: string;
  row: string;
}

/** A model call whose reply is lost, on a connection whose monthly line is narrow enough for the reservation to matter. */
async function make_unknown(env: CrossEnv): Promise<Frozen & { opened: Awaited<ReturnType<typeof open_stage>>; res: ExecResult }> {
  await ready_project(env, { subscription_limits: { five_hour_tokens: BIG, weekly_tokens: BIG, monthly_tokens: NARROW } });
  const opened = await open_stage(env, "plan");
  env.opened = opened;
  set_script(env, [{ drop: true }]);
  const res = await start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id, max_output_tokens: BIG_CALL });
  assert.equal(res.status, "blocked_usage");
  assert.equal(res.block_reason, "usage_unknown");
  const rows = unknown_dispatches(env);
  assert.equal(rows.length, 1, "one unknown call");
  return { run_id: res.run_id, dispatch_id: rows[0]!.id, row: snapshot(env, rows[0]!.id), opened, res };
}

function snapshot(env: CrossEnv, dispatch_id: string): string {
  const row = env.db.get<Record<string, unknown>>("SELECT * FROM outbound_dispatches WHERE id = ?", dispatch_id);
  assert.ok(row, "the dispatch row still exists");
  return JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

function settlements(env: CrossEnv): number {
  return Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM dispatch_resolutions")!.n);
}

/** (a) the row is untouched, (b) nobody settled it, (d) the run cannot resume, and no model call left. */
async function assert_still_unknown(env: CrossEnv, f: Frozen, why: string, expected_code: "conflict" | "policy_denied" = "conflict"): Promise<void> {
  assert.equal(snapshot(env, f.dispatch_id), f.row, `${why}: the call row is byte-for-byte what it was`);
  assert.equal(settlements(env), 0, `${why}: nobody settled it`);
  assert.equal(unknown_dispatches(env).length, 1, `${why}: still exactly one unknown call`);
  const calls = env.fake.calls.length;
  set_script(env, [FINISH]);
  const resume = await resume_outcome(env, f.run_id);
  assert.ok(resume.error, `${why}: the run cannot resume`);
  assert.equal(resume.error!.code, expected_code, `${why}: refused (${resume.error!.code})`);
  assert.equal(env.fake.calls.length, calls, `${why}: and nothing was sent`);
}

test("an unknown call survives B taking over, finishing and the clock running a month: row unchanged, nobody settled it, A still cannot resume, the reservation still counts", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const f = await make_unknown(env);
    assert.equal(lease_row(env)!.state, "released");
    await assert_still_unknown(env, f, "right after the loss");

    // B takes over and finishes; its work has nothing to do with the open call
    const b = new Driver(env, B);
    assert.equal((await b.step({ op: "claim" })).ok, true);
    assert.equal((await b.step({ op: "submit", title: "B 의 작업" })).versions_added, 1);
    await b.step({ op: "complete" });
    assert.equal(dispatch_count(env, b.previous!.run_id), 0);
    await assert_still_unknown(env, f, "after B finished");

    // a month later: still unknown
    env.clock.advance(MONTH + 3_600_000);
    await assert_still_unknown(env, f, "a month later");

    // the reservation still counts: a NEW built-in run with a big call is not sent
    const calls = env.fake.calls.length;
    set_script(env, [FINISH]);
    const second = await start_outcome(env, { stage_id: f.opened.stage_id, round_id: f.opened.round_id, max_output_tokens: BIG_CALL });
    if (second.result !== null) assert.notEqual(second.result.status, "succeeded", "a new run must not go ahead while the reservation counts");
    assert.equal(second.result === null && second.error === null, false);
    assert.equal(env.fake.calls.length, calls, "no request left");
    assert.equal(snapshot(env, f.dispatch_id), f.row);

    // control: it is the reservation that held the run back - once a person writes the call off the same start goes through
    await env.service.execute(env.ctx(next_key(env, "control-settle")), "dispatch.resolve_unknown", { dispatch_id: f.dispatch_id, outcome: "not_charged", note: "합성" });
    set_script(env, [FINISH]);
    const freed = await start_outcome(env, { stage_id: f.opened.stage_id, round_id: f.opened.round_id, max_output_tokens: BIG_CALL });
    assert.equal(freed.result?.status, "succeeded", "after the person's settlement the reservation is gone");
  });
});

test("an unknown call survives A→B→A→B turns on the same project", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const f = await make_unknown(env);
    const order: Side[] = [B, A, B, A];
    for (const [i, side] of order.entries()) {
      const d = new Driver(env, side);
      assert.equal((await d.step({ op: "claim" })).ok, true, `turn ${i}`);
      await d.step({ op: "heartbeat" });
      await d.step({ op: "release" });
      await assert_still_unknown(env, f, `after turn ${i} (${d.label})`);
    }
  });
});

test("an unknown call survives Go OFF and Go ON: row unchanged, still refused to resume both times", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const f = await make_unknown(env);
    await policy_off(env);
    await assert_still_unknown(env, f, "Go OFF", "policy_denied");
    await policy_on(env);
    await assert_still_unknown(env, f, "Go ON again");
    await policy_off(env);
    await policy_on(env);
    await assert_still_unknown(env, f, "OFF/ON twice");
  });
});

test("an unknown call survives a restart (a new executor and connection service on the same database)", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const f = await make_unknown(env);
    env.exec = new BuiltinExecutor(env.deps);
    env.conns = new AiConnectionService(env.deps);
    await assert_still_unknown(env, f, "after the restart");
    // a startup scan of the old runs must not tidy the call away either
    env.clock.advance(MONTH + 3_600_000);
    env.exec = new BuiltinExecutor(env.deps);
    await assert_still_unknown(env, f, "after the restart and a month");
  });
});

test("a call the dead process left 'sent' is not auto-closed by B's takeover, Go OFF/ON or a restart", async () => {
  let dead = false;
  const env = await make_cross_env("openai_compatible", {
    save_retries: 0,
    wrap: (db) => ({
      path: db.path,
      exec: (sql) => {
        if (dead && !/^\s*(SELECT|PRAGMA)/i.test(sql)) throw new Error("synthetic: the process died");
        return db.exec(sql);
      },
      prepare: (sql) => db.prepare(sql),
      run: (sql, ...params) => {
        if (dead) throw new Error("synthetic: the process died");
        return db.run(sql, ...params);
      },
      get: (sql, ...params) => db.get(sql, ...params),
      all: (sql, ...params) => db.all(sql, ...params),
      close: () => db.close(),
    }),
  });
  try {
    const opened = await ready_cross(env);
    set_script(env, [{ text: "완료" }]);
    env.fake.on_call = () => {
      dead = true;
    };
    await assert.rejects(start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id }));
    dead = false;
    env.fake.on_call = undefined;
    const run_id = env.db.get<{ id: string }>("SELECT id FROM runs WHERE mode = 'A'")!.id;
    const left = dispatches(env, run_id);
    assert.equal(left.length, 1);
    assert.equal(left[0]!.state, "sent");
    const frozen = snapshot(env, left[0]!.id);

    env.clock.advance(125_000);
    const b = new Driver(env, B);
    assert.equal((await b.step({ op: "claim" })).ok, true);
    await b.step({ op: "release" });
    await policy_off(env);
    await policy_on(env);
    env.exec = new BuiltinExecutor(env.deps);
    env.clock.advance(MONTH);
    assert.equal(snapshot(env, left[0]!.id), frozen, "해석 17: the 'sent' call is exactly as the dead process left it");
    assert.equal(settlements(env), 0);
    const calls = env.fake.calls.length;
    set_script(env, [FINISH]);
    const resume = await resume_outcome(env, run_id);
    assert.equal(resume.error?.code, "conflict", "and it still blocks the resume");
    assert.equal(env.fake.calls.length, calls);
  } finally {
    await env.close_cross();
  }
});

test("only a human owner settles it: both agent kinds are forbidden, the owner's settlement is one line beside the call and a second settlement is refused", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const f = await make_unknown(env);
    const payload = { dispatch_id: f.dispatch_id, outcome: "not_charged", note: "합성: 콘솔에서 확인함" };
    // B's agent actor (external_agent) and A's actor (internal_ai)
    await assert.rejects(env.service.execute(env.agent_ctx(env.agent.actor_id, "b-settle"), "dispatch.resolve_unknown", payload), (e: any) => e?.code === "forbidden");
    await assert.rejects(env.service.execute(env.agent_ctx(env.ai_actor_id, "a-settle"), "dispatch.resolve_unknown", payload), (e: any) => e?.code === "forbidden");
    await assert_still_unknown(env, f, "after the refused attempts");

    await env.service.execute(env.ctx(next_key(env, "owner-settle")), "dispatch.resolve_unknown", payload);
    assert.equal(settlements(env), 1, "one settlement line");
    assert.equal(snapshot(env, f.dispatch_id), f.row, "the call row itself is not rewritten");
    await assert.rejects(
      env.service.execute(env.ctx(next_key(env, "owner-settle-2")), "dispatch.resolve_unknown", { ...payload, outcome: "charged" }),
      (e: any) => e?.code === "conflict",
    );
    assert.equal(settlements(env), 1);

    // settled: the run can go on, with exactly one new call
    const calls = env.fake.calls.length;
    set_script(env, [FINISH]);
    const resumed = await resume_outcome(env, f.run_id);
    assert.equal(resumed.error, null);
    assert.equal(resumed.result?.status, "succeeded");
    assert.equal(env.fake.calls.length, calls + 1);
    assert.equal(snapshot(env, f.dispatch_id), f.row, "even now the old call row says unknown");
  });
});

test("B can neither make nor see an unknown: its runs carry no dispatch, and no B tool answer mentions one", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const f = await make_unknown(env);
    const client = await env.mcp_client(B_TOOLS[2]!);
    const claim = await client.ok("pes_claim", { idempotency_key: "u-claim" });
    const seen = [claim, await client.ok("pes_context", {}), await client.ok("pes_heartbeat", { idempotency_key: "u-hb" })];
    for (const answer of seen) assert.doesNotMatch(JSON.stringify(answer), /unknown|dispatch|reservation|usage_unknown/i, "no B answer shows A's call bookkeeping");
    assert.equal(dispatch_count(env, claim.run_id), 0);
    await client.ok("pes_release", { idempotency_key: "u-release" });
    assert.equal(snapshot(env, f.dispatch_id), f.row);
  });
});

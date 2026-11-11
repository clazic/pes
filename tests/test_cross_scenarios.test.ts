/**
 * SEL-56 PR21 — A·B 교차 계약, 시나리오편 (tester, 작성 모드). 완료 조건 4:
 *   지연 응답(가짜 AI 서버가 늦게 답함) · 프로세스 종료(실행 중 중단·재시작 뒤 재개) · Go OFF(실행 중 OFF → A lease 해제·
 *   run interrupted → B 가 이어받음) · 사용량 문턱(비용 상한 도달 → 멈추고 인계)
 * Real built-in executor + PR19 fake HTTP AI server on one side, the 20a fake MCP client on the other, ONE database.
 * No real model, no external call.
 *
 * 해석:
 *  해석 14  "프로세스 종료" = 실행기가 죽어 그 뒤로 아무것도 쓰지 못하는 상태. 같은 프로세스 안이라 진짜 kill 은 못 하므로,
 *           서비스가 쓰는 DB 핸들이 `dead` 켜지면 모든 쓰기/BEGIN 에서 예외를 던지게 해 '그 시점까지 커밋된 것만 남는' 상태를
 *           만든다(실행기의 정리 코드도 못 쓴다). '재시작'은 dead 를 끄고 시계를 lease TTL 너머로 보낸 뒤 새
 *           BuiltinExecutor 를 같은 DB 위에 만드는 것이다.
 *  해석 15  죽은 실행기가 남긴 sent 호출은 '전송했을 수 있는' 호출이다: 자동으로 failed/해제되지 않고 사람이 정리하기 전까지
 *           재개를 막는다(docs 8.16: 실행기가 죽어 남은 prepared·authorized·sent 호출도 사람이 정리).
 *  해석 16  B 는 A 를 막는 것(Go OFF·사용량·비용 상한)에 영향받지 않는다 — 막힌 A 의 lease 는 풀려 있어서 B 가 바로 이어받는다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BuiltinExecutor } from "../scripts/pes_core/a_runtime/loop.ts";
import type { Db } from "../scripts/pes_core/db.ts";
import { ApiError } from "../scripts/pes_core/errors.ts";
import { Driver, type Side } from "./helpers/cross_driver.ts";
import {
  B_TOOLS,
  dispatch_count,
  lease_row,
  make_cross_env,
  ready_cross,
  run_info,
  unknown_dispatches,
  versions_of,
  with_cross_env,
  type CrossEnv,
} from "./helpers/cross_env.ts";
import {
  FINISH,
  all_runs,
  context_turn,
  dispatches,
  events_by_type,
  next_key,
  num,
  open_stage,
  policy_off,
  policy_on,
  ready_project,
  register_connection,
  resume_outcome,
  resume_run,
  run_row,
  select_model,
  set_price,
  set_script,
  start_outcome,
  start_run,
  submit_turn,
  type ExecResult,
} from "./helpers/a_builtin_env.ts";

const B: Side = { kind: "B", tool: B_TOOLS[0]! };

/** B finishes the stage's work from a cold start: claim, submit, complete. Returns the run id. */
async function b_takes_over_and_finishes(env: CrossEnv, title: string): Promise<{ run_id: string; fence: number }> {
  const b = new Driver(env, B);
  const claim = await b.step({ op: "claim" });
  assert.equal(claim.ok, true, `B claims right away (got ${claim.code})`);
  assert.equal((await b.step({ op: "submit", title })).versions_added, 1);
  assert.equal((await b.step({ op: "complete" })).run_status, "succeeded");
  return { run_id: b.previous!.run_id, fence: b.previous!.fence };
}

// ---------------------------------------------------------------------------------------------------------
// 지연 응답

test("delay: an answer that comes inside the timeout is an ordinary answer", async () => {
  const env = await make_cross_env("openai_compatible", { request_timeout_ms: 2_000 });
  try {
    const opened = await ready_cross(env);
    set_script(env, [{ ...context_turn(), delay_ms: 120 }, submit_turn(opened.object_id, "느리지만 제때 온 답"), FINISH]);
    const res = await start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id });
    assert.equal(res.status, "succeeded");
    assert.equal(unknown_dispatches(env).length, 0);
  } finally {
    await env.close_cross();
  }
});

test("delay: an answer that comes AFTER the timeout is never adopted; the run is blocked, the lease is free, B takes over and finishes meanwhile", async () => {
  const env = await make_cross_env("openai_compatible", { request_timeout_ms: 80 });
  try {
    const opened = await ready_cross(env);
    // the late answer would write a result if it were ever used
    set_script(env, [{ ...submit_turn(opened.object_id, "너무 늦게 온 답"), delay_ms: 500 }, FINISH]);
    const res = await start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id });
    assert.equal(res.status, "blocked_usage");
    assert.equal(res.block_reason, "usage_unknown");
    assert.equal(lease_row(env)!.state, "released", "해석 16: the lease is already free");
    const a_fence = lease_row(env)!.fence;

    // B does the whole job while the model's late answer is still on its way
    const b = await b_takes_over_and_finishes(env, "B 가 먼저 끝낸 장");
    assert.equal(b.fence, a_fence + 1);

    await new Promise((r) => setTimeout(r, 700)); // the late answer arrives now
    assert.equal(env.fake.calls.length, 1, "no second request, no retry");
    assert.equal(unknown_dispatches(env).length, 1, "the late call is still unknown, not adopted");
    assert.equal(dispatches(env, res.run_id)[0]!.adopted_version_id, null);
    const chain = versions_of(env, opened.object_id);
    assert.deepEqual(chain.map((v) => v.run_id), [null, b.run_id], "only B's version exists; the late answer wrote nothing");
    assert.equal(run_info(env, res.run_id).status, "blocked_usage", "and A's run did not come back to life by itself");
  } finally {
    await env.close_cross();
  }
});

// ---------------------------------------------------------------------------------------------------------
// 프로세스 종료 · 재시작

interface Mortal {
  env: CrossEnv;
  die(): void;
  revive(): void;
}

async function mortal_env(): Promise<Mortal> {
  let dead = false;
  const gate = (db: Db): Db => {
    const stop = (): void => {
      if (dead) throw new Error("synthetic: the process died");
    };
    return {
      path: db.path,
      exec: (sql) => {
        if (!/^\s*(SELECT|PRAGMA)/i.test(sql)) stop();
        return db.exec(sql);
      },
      prepare: (sql) => db.prepare(sql),
      run: (sql, ...params) => {
        stop();
        return db.run(sql, ...params);
      },
      get: (sql, ...params) => db.get(sql, ...params),
      all: (sql, ...params) => db.all(sql, ...params),
      close: () => db.close(),
    };
  };
  const env = await make_cross_env("openai_compatible", { wrap: gate, save_retries: 0 });
  return { env, die: () => void (dead = true), revive: () => void (dead = false) };
}

test("process death mid-run: the dead run's sent call is not auto-released; B takes over after the lease TTL; a restart cannot resume until a person settles the call", async () => {
  const { env, die, revive } = await mortal_env();
  try {
    const opened = await ready_cross(env);
    set_script(env, [context_turn(), submit_turn(opened.object_id, "죽기 전 계획"), FINISH]);
    env.fake.on_call = (n) => {
      if (n === 1) die(); // the process dies while the first model call is in flight
    };
    let thrown: unknown = null;
    let result: ExecResult | null = null;
    try {
      result = await start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id });
    } catch (error) {
      thrown = error;
    }
    assert.equal(result, null, "the dead process returned nothing");
    assert.ok(thrown instanceof Error, "its drive was cut off");
    revive();

    // what the dead process left: a run that still says running, an active lease, and a call that may have gone out
    const run = all_runs(env)[0]!;
    const left = dispatches(env, run.id);
    assert.equal(left.length, 1);
    assert.equal(left[0]!.state, "sent", "해석 15: the call that may have gone out is still 'sent', not closed by anyone");
    assert.equal(run.status, "running");
    assert.equal(lease_row(env)!.state, "active", "the dead holder's lease was not given back by anyone");
    const left_row = { ...left[0]! };
    assert.equal(env.fake.calls.length, 1);

    // B cannot barge in while the dead holder's lease is still live...
    const early = await new Driver(env, B).step({ op: "claim" });
    assert.equal(early.ok, false, "a live lease is not taken before it runs out");
    assert.equal(early.code, "conflict");

    // ...but once the TTL has passed, B takes over and finishes
    env.clock.advance(125_000);
    const b = await b_takes_over_and_finishes(env, "B 가 이어 쓴 장");
    assert.equal(run_info(env, run.id).status, "interrupted", "the dead run is ended, with its own event, when its lease is replaced");
    assert.ok(events_by_type(env, "run.interrupted").some((e) => e.run_id === run.id && /lease_expired/.test(e.payload)));
    assert.deepEqual(dispatches(env, run.id).map((d) => d.state), [left_row.state], "the dead run's call is exactly as it was");

    // restart: a NEW executor on the same database
    const restarted = new BuiltinExecutor(env.deps);
    env.exec = restarted;
    set_script(env, [FINISH]);
    const before = env.fake.calls.length;
    const refused = await resume_outcome(env, run.id);
    assert.ok(refused.error instanceof ApiError, "resume is refused");
    assert.equal(refused.error!.code, "conflict");
    assert.equal(env.fake.calls.length, before, "and nothing is sent");

    // a person settles the call; only then the restart can resume, with a new fence above B's
    const open_call = dispatches(env, run.id)[0]!;
    await env.service.execute(env.ctx(next_key(env, "settle")), "dispatch.resolve_unknown", { dispatch_id: open_call.id, outcome: "not_charged", note: "합성: 콘솔 확인" });
    assert.equal(dispatches(env, run.id)[0]!.state, left_row.state, "settling is recorded beside the call, the call itself is not rewritten");
    const resumed = await resume_run(env, run.id);
    assert.equal(resumed.status, "succeeded");
    assert.ok(lease_row(env)!.fence > b.fence, "the resume is a new claim above B's");
    assert.equal(env.fake.calls.length, before + 1, "exactly one new request");
    assert.equal(dispatch_count(env, b.run_id), 0, "B's run added no dispatch");
  } finally {
    await env.close_cross();
  }
});

test("process death of B: a restarted client claims a NEW run after the lease TTL (the dead run is interrupted); the dead client's guard is refused", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const opened = await ready_cross(env);
    const tool = B_TOOLS[2]!;
    const first = await env.mcp_client(tool);
    const claimed = await first.ok("pes_claim", { idempotency_key: "restart-claim" });
    await first.ok("pes_submit", { idempotency_key: "restart-submit", results: [{ op: "append_version", object_id: opened.object_id, title: "죽기 전 B" }] });
    // the process dies: the client is gone, nothing is released
    env.clock.advance(125_000);
    const second = await env.mcp_client(tool);
    const fresh = await second.ok("pes_claim", { idempotency_key: "restart-claim-2" });
    assert.notEqual(fresh.run_id, claimed.run_id);
    assert.equal(Number(fresh.fence), Number(claimed.fence) + 1);
    assert.equal(run_info(env, claimed.run_id).status, "interrupted", "the dead client's run is ended with its own event");
    await second.ok("pes_submit", { idempotency_key: "restart-submit-2", results: [{ op: "append_version", object_id: opened.object_id, title: "다시 켠 B" }] });
    const ghost = await first.tool("pes_submit", {
      idempotency_key: "ghost-submit",
      run_id: claimed.run_id,
      lease_id: claimed.lease_id,
      fence: claimed.fence,
      results: [{ op: "append_version", object_id: opened.object_id, title: "유령" }],
    });
    assert.equal(ghost.is_error, true);
    assert.equal(ghost.data.error.code, "conflict");
    assert.deepEqual(versions_of(env, opened.object_id).map((v) => v.version_no), [1, 2, 3]);
    // a built-in run can only start once B lets go
    const a = new Driver(env, { kind: "A" });
    assert.equal((await a.step({ op: "claim" })).ok, false);
    await second.ok("pes_release", { idempotency_key: "restart-release" });
    assert.equal((await a.step({ op: "claim" })).ok, true);
  });
});

// [결함 후보 F1] "재시작 뒤 재개": a run whose holder died is still `running` with an expired lease. Nothing but ANOTHER claim
// (which interrupts it) or an owner's cancel (which ends it for good) moves it. So the restarted holder itself cannot
// resume its own run: B's pes_claim {run_id} and the built-in runner's resume are both refused with a status conflict,
// even after the lease ran out and (for A) a person settled the open call. Expected: a run whose lease has expired may
// be re-claimed / resumed by its own actor (the new claim interrupts the stale lease first).

test("[결함 후보 F1] B: a restarted client can take its own run back by run_id after the lease expired (new fence, same run)", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const opened = await ready_cross(env);
    const tool = B_TOOLS[2]!;
    const first = await env.mcp_client(tool);
    const claimed = await first.ok("pes_claim", { idempotency_key: "f1-claim" });
    await first.ok("pes_submit", { idempotency_key: "f1-submit", results: [{ op: "append_version", object_id: opened.object_id, title: "죽기 전 B" }] });
    env.clock.advance(125_000);
    const second = await env.mcp_client(tool);
    const again = await second.tool("pes_claim", { idempotency_key: "f1-claim-2", run_id: claimed.run_id });
    assert.equal(again.is_error, false, `the same run can be re-claimed after a restart (got ${JSON.stringify(again.data)})`);
    assert.equal(again.data.run_id, claimed.run_id);
    assert.equal(Number(again.data.fence), Number(claimed.fence) + 1);
    assert.notEqual(again.data.lease_id, claimed.lease_id);
  });
});

test("[결함 후보 F1] A: after the process died, the lease ran out and a person settled the open call, the restarted runner resumes the SAME run (new fence)", async () => {
  const { env, die, revive } = await mortal_env();
  try {
    const opened = await ready_cross(env);
    set_script(env, [context_turn(), submit_turn(opened.object_id, "죽기 전"), FINISH]);
    env.fake.on_call = (n) => {
      if (n === 1) die();
    };
    await assert.rejects(start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id }));
    revive();
    const run = all_runs(env)[0]!;
    env.clock.advance(125_000);
    const open_call = dispatches(env, run.id)[0]!;
    assert.equal(open_call.state, "sent");
    await env.service.execute(env.ctx(next_key(env, "settle")), "dispatch.resolve_unknown", { dispatch_id: open_call.id, outcome: "not_charged", note: "합성" });
    env.exec = new BuiltinExecutor(env.deps);
    set_script(env, [submit_turn(opened.object_id, "다시 켠 뒤"), FINISH]);
    const resumed = await resume_outcome(env, run.id);
    assert.equal(resumed.error, null, `the restarted runner can resume its own dead run (got ${resumed.error?.code}: ${resumed.error?.message})`);
    assert.equal(resumed.result?.status, "succeeded");
    assert.equal(resumed.result?.run_id, run.id, "the same run, not a new one");
    assert.equal(lease_row(env)!.fence, 2);
  } finally {
    await env.close_cross();
  }
});

// ---------------------------------------------------------------------------------------------------------
// Go OFF

test("Go OFF mid-run: A's run is interrupted and its lease released, B takes over at once, A stays refused while OFF and resumes after ON", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const opened = await ready_cross(env);
    set_script(env, [context_turn(), submit_turn(opened.object_id, "A 의 계획"), FINISH]);
    env.fake.on_call = async (n) => {
      if (n === 1) await policy_off(env);
    };
    const res = await start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id });
    assert.equal(res.status, "interrupted");
    assert.equal(env.fake.calls.length, 1, "the second call never left");
    assert.notEqual(lease_row(env)!.state, "active", "A's lease is released");
    const interrupted = events_by_type(env, "run.interrupted").filter((e) => e.run_id === res.run_id);
    assert.match(interrupted[0]!.payload, /policy_off/);
    const a_fence = lease_row(env)!.fence;

    // B is not governed by the Go switch: it takes over immediately and finishes
    const b = await b_takes_over_and_finishes(env, "Go 가 꺼진 동안 B 가 한 일");
    assert.equal(b.fence, a_fence + 1, "B's claim is a new fence above A's");

    // A cannot come back while OFF; nothing is sent
    env.fake.on_call = undefined;
    const calls = env.fake.calls.length;
    const retry = await resume_outcome(env, res.run_id);
    assert.equal(retry.error?.code, "policy_denied");
    assert.equal(env.fake.calls.length, calls);

    // ON again: the owner resumes A, a new claim above B's
    await policy_on(env);
    set_script(env, [submit_turn(opened.object_id, "다시 켠 뒤 A"), FINISH]);
    const back = await resume_run(env, res.run_id);
    assert.equal(back.status, "succeeded");
    assert.ok(lease_row(env)!.fence > b.fence);
    assert.deepEqual(
      versions_of(env, opened.object_id).map((v) => v.run_id),
      [null, b.run_id, res.run_id],
      "B's version and A's later version are both there, in order, none lost",
    );
  });
});

test("Go OFF while B holds the lease: B is not interrupted and keeps writing; only a new A start is refused", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const opened = await ready_cross(env);
    const b = new Driver(env, B);
    await b.step({ op: "claim" });
    await policy_off(env);
    assert.equal((await b.step({ op: "heartbeat" })).ok, true);
    assert.equal((await b.step({ op: "submit", title: "Go 꺼진 뒤 B" })).versions_added, 1);
    assert.equal(run_info(env, b.guard!.run_id).status, "running");
    await b.step({ op: "release" });
    const refused = await start_outcome(env, { stage_id: opened.stage_id, round_id: opened.round_id });
    assert.equal(refused.error?.code, "policy_denied");
    assert.equal(env.fake.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 사용량 문턱 · 비용 상한

test("cost cap reached: A stops BEFORE the next call (blocked_usage cost_cap), its lease is free, B takes over, A stays stopped until a person acts", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const dto = await register_connection(env, { billing: "pay_per_use", cost_cap: { currency: "USD", amount_micros: 10_000 } });
    await set_price(env, dto.connection_id, { input_per_mtok_micros: 1_000_000, output_per_mtok_micros: 2_000_000 });
    await select_model(env, dto.connection_id);
    const opened = await open_stage(env, "plan");
    env.opened = opened;
    set_script(env, [context_turn({ input: 1_000, output: 1_000 }), submit_turn(opened.object_id, "합성"), FINISH]);
    const res = await start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id, max_output_tokens: 3_600 });
    assert.equal(res.status, "blocked_usage");
    assert.equal(res.block_reason, "cost_cap");
    assert.equal(env.fake.calls.length, 1, "the next request was never sent");
    assert.equal(lease_row(env)!.state, "released");
    const a_dispatches = dispatch_count(env, res.run_id);
    const spent = dispatches(env, res.run_id).map((d) => JSON.parse(d.cost_json ?? "null")?.amount_micros ?? 0);
    assert.equal(spent.reduce((x: number, y: number) => x + y, 0), 3_000);

    // B continues the work; its work costs PES nothing and is not counted against the cap
    const b = await b_takes_over_and_finishes(env, "상한 때문에 B 가 이어받음");
    assert.equal(dispatch_count(env, res.run_id), a_dispatches, "A's dispatch rows did not move");
    assert.equal(dispatch_count(env, b.run_id), 0);
    const spent_after = dispatches(env).map((d) => JSON.parse(d.cost_json ?? "null")?.amount_micros ?? 0).reduce((x: number, y: number) => x + y, 0);
    assert.equal(spent_after, 3_000, "B's work added no cost to the connection's total");

    // a human resume goes through the cap again: still over, nothing sent
    set_script(env, [FINISH]);
    const again = await resume_outcome(env, res.run_id, { max_output_tokens: 3_600 });
    if (again.result !== null) assert.equal(again.result.status, "blocked_usage");
    else assert.ok(again.error);
    assert.equal(env.fake.calls.length, 1);
    assert.equal(num(run_row(env, res.run_id).go_blocked_at) !== null, true);
  });
});

test("subscription threshold reached: A stops before the call that would pass the line, B takes over; usage is A's alone", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    await ready_project(env, { subscription_limits: { five_hour_tokens: 10_000, weekly_tokens: 1_000_000, monthly_tokens: 4_000_000 } });
    const opened = await open_stage(env, "plan");
    env.opened = opened;
    set_script(env, [context_turn({ input: 8_000, output: 900 }), submit_turn(opened.object_id, "합성"), FINISH]);
    const res = await start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id, max_output_tokens: 500 });
    assert.equal(res.status, "blocked_usage");
    assert.equal(res.block_reason, "usage_limit");
    assert.equal(env.fake.calls.length, 1);
    assert.equal(lease_row(env)!.state, "released");
    assert.ok((res.reset_at ?? 0) > 0, "the reset time is recorded for the person");

    const b = await b_takes_over_and_finishes(env, "구독 문턱 때문에 B 가 이어받음");
    assert.equal(dispatch_count(env, b.run_id), 0, "B sent nothing through PES");
    assert.equal(env.fake.calls.length, 1, "and the model was not called by anyone");
    const row = run_row(env, res.run_id);
    assert.equal(row.status, "blocked_usage", "B's success does not unblock A's run");
    assert.equal(row.go_block_reason, "usage_limit");
  });
});

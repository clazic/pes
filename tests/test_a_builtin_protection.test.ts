// SEL-52 (PR19) protections around every model call: the AI-connection policy switch (checked per call),
// subscription usage estimates (threshold, provider limit errors, unknown = closed), pay-per-use cost caps
// (price required, reservation counted, stop BEFORE sending), and the blocked_usage / lease / human-resume rules.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FIVE_HOURS,
  MODEL_A,
  context_turn,
  dispatches,
  events_by_type,
  ready_project,
  register_connection,
  reauth,
  resume_outcome,
  resume_run,
  run_row,
  all_runs,
  close_stage,
  lease_state,
  num,
  open_stage,
  policy_off,
  policy_on,
  select_model,
  set_script,
  set_price,
  start_outcome,
  start_run,
  submit_turn,
  next_key,
  with_a_env,
  FINISH,
  type AEnv,
  type Format,
} from "./helpers/a_builtin_env.ts";

const FORMATS: Format[] = ["openai_compatible", "anthropic"];
const NOT_STARTED = ["policy_denied", "conflict", "invalid_payload"];

async function plan_round(env: AEnv) {
  return open_stage(env, "plan");
}

function assert_not_started(out: Awaited<ReturnType<typeof start_outcome>>, env: AEnv, calls_before = 0): void {
  if (out.error !== null) assert.ok(NOT_STARTED.includes(out.error.code), `refusal code ${out.error.code}`);
  else assert.equal(out.result?.status, "blocked_usage", "a start that is not refused must be a blocked run");
  assert.equal(env.fake.calls.length, calls_before, "nothing was sent to the model");
}

// ---------------------------------------------------------------------------------------------------------
// AI-connection policy switch: checked on every call

test("policy OFF before the start: refused, no run, no dispatch, no request", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await plan_round(env);
    await policy_off(env);
    // registering the connection already made its one connection-test GET; count only what the start adds
    const requests_before = env.fake.all.length;
    const out = await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.ok(out.error, "a start with the switch OFF throws");
    assert.equal(out.error!.code, "policy_denied");
    assert.equal(env.fake.all.length, requests_before, "the refused start sent no request at all");
    assert.deepEqual(all_runs(env), []);
    assert.deepEqual(dispatches(env), []);
  });
});

test("policy turned OFF while a call is in flight: the next call is blocked, the run is interrupted", async () => {
  for (const format of FORMATS) {
    await with_a_env(format, async (env) => {
      await ready_project(env);
      const o = await plan_round(env);
      set_script(env, [context_turn(), submit_turn(o.object_id, "합성"), FINISH]);
      env.fake.on_call = async (n) => {
        if (n === 1) await policy_off(env);
      };
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(res.status, "interrupted", format);
      assert.equal(env.fake.calls.length, 1, `${format}: the second call was never sent`);
      const row = run_row(env, res.run_id);
      assert.equal(row.status, "interrupted");
      assert.notEqual(lease_state(env)?.state, "active");
      const interrupted = events_by_type(env, "run.interrupted").filter((e) => e.run_id === res.run_id);
      assert.ok(interrupted.length >= 1);
      assert.match(interrupted[0]!.payload, /policy_off/);
      for (const d of dispatches(env, res.run_id)) {
        assert.ok(!["prepared", "authorized"].includes(d.state), `no dispatch is left ready to go: ${d.state}`);
      }

      // a human resume with the switch still OFF is refused and sends nothing
      const retry = await resume_outcome(env, res.run_id);
      assert.ok(retry.error, "resume while OFF throws");
      assert.equal(retry.error!.code, "policy_denied");
      assert.equal(env.fake.calls.length, 1);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------
// subscription billing

test("subscription: tokens are counted from the provider's usage and stored per call", async () => {
  for (const format of FORMATS) {
    await with_a_env(format, async (env) => {
      await ready_project(env);
      const o = await plan_round(env);
      set_script(env, [
        context_turn({ input: 120, output: 30 }),
        submit_turn(o.object_id, "합성", { input: 200, output: 40 }),
        { text: "완료", usage: { input: 50, output: 5 } },
      ]);
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(res.status, "succeeded", format);
      const rows = dispatches(env, res.run_id);
      assert.equal(rows.length, 3, "one dispatch per model call");
      const used = rows.map((r) => JSON.parse(r.usage_json ?? "null"));
      assert.deepEqual(used.map((u) => [u.input_tokens, u.output_tokens]), [[120, 30], [200, 40], [50, 5]]);
      for (const r of rows) assert.ok(["response", "adopted"].includes(r.state), r.state);
    });
  }
});

test("subscription: a reply without a usage field is still counted (never zero)", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await plan_round(env);
    set_script(env, [{ tools: [{ name: "context.get", args: {} }], omit_usage: true }, { text: "완료", omit_usage: true }]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "succeeded");
    for (const r of dispatches(env, res.run_id)) {
      const usage = JSON.parse(r.usage_json ?? "null");
      assert.ok(usage !== null, "usage is recorded even when the provider omitted it");
      assert.ok(usage.input_tokens > 0, "an estimated input count, not 0");
    }
  });
});

test("subscription with no known limit never starts (fail-closed)", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const o = await plan_round(env);
    let registered = true;
    let dto;
    try {
      dto = await register_connection(env, { subscription_limits: null });
    } catch (error) {
      // refusing an unknown limit already at registration is as safe as refusing the start
      registered = false;
      assert.equal((error as { code?: string }).code, "invalid_payload");
    }
    if (!registered) return;
    await select_model(env, dto!.connection_id);
    assert_not_started(await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id }), env);
    assert.deepEqual(all_runs(env).filter((r) => r.status === "running"), []);
  });
});

test("subscription: the run stops before a call that would pass the 90% line (blocked_usage, lease released)", async () => {
  for (const format of FORMATS) {
    await with_a_env(format, async (env) => {
      await ready_project(env, { subscription_limits: { five_hour_tokens: 10_000, weekly_tokens: 1_000_000, monthly_tokens: 4_000_000 } });
      const o = await plan_round(env);
      set_script(env, [context_turn({ input: 8_000, output: 900 }), submit_turn(o.object_id, "합성"), FINISH]);
      const t0 = Number(env.clock.now_ms());
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: 500 });
      assert.equal(res.status, "blocked_usage", format);
      assert.equal(res.block_reason, "usage_limit");
      assert.equal(env.fake.calls.length, 1, `${format}: call 2 was refused before it was sent`);

      const row = run_row(env, res.run_id);
      assert.equal(row.status, "blocked_usage", "a usage stop is blocked_usage, never waiting_human");
      assert.equal(row.go_block_reason, "usage_limit");
      assert.equal(num(row.go_blocked_at), t0);
      assert.ok(num(row.go_block_reset_at)! > t0, "the window's reset time is recorded");
      assert.equal(lease_state(env)?.state, "released", "the lease is released so nothing else is held up");
      assert.equal(dispatches(env, res.run_id).filter((d) => ["sent", "response", "adopted"].includes(d.state)).length, 1);
    });
  }
});

test("subscription: stop_percent is the user's line — 50% stops where 90% goes on", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const limits = { five_hour_tokens: 10_000, weekly_tokens: 1_000_000, monthly_tokens: 4_000_000 };
    await ready_project(env, { stop_percent: 50, subscription_limits: limits });
    const o = await plan_round(env);
    set_script(env, [context_turn({ input: 4_500, output: 500 }), FINISH]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: 500 });
    assert.equal(res.status, "blocked_usage");
    assert.equal(res.block_reason, "usage_limit");
  });
  await with_a_env("openai_compatible", async (env) => {
    const limits = { five_hour_tokens: 10_000, weekly_tokens: 1_000_000, monthly_tokens: 4_000_000 };
    await ready_project(env, { subscription_limits: limits });
    const o = await plan_round(env);
    set_script(env, [context_turn({ input: 4_500, output: 500 }), FINISH]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: 500 });
    assert.equal(res.status, "succeeded", "5,000 of 10,000 is well under the default 90%");
  });
});

test("subscription: usage from earlier runs counts, and a window frees when its time is over", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env, { subscription_limits: { five_hour_tokens: 10_000, weekly_tokens: 1_000_000, monthly_tokens: 4_000_000 } });
    const o1 = await plan_round(env);
    set_script(env, [{ text: "완료", usage: { input: 8_000, output: 900 } }]);
    const first = await start_run(env, { stage_id: o1.stage_id, round_id: o1.round_id, max_output_tokens: 500 });
    assert.equal(first.status, "succeeded");
    await close_stage(env, o1, "plan");

    // a different run of the same connection sees the 8,900 already used in the 5-hour window
    const o2 = await open_stage(env, "research");
    const before = env.fake.calls.length;
    const blocked = await start_outcome(env, { stage_id: o2.stage_id, round_id: o2.round_id, max_output_tokens: 500 });
    assert_not_started(blocked, env, before);

    // 5 hours later the window has moved on and the human can go ahead
    env.clock.advance(FIVE_HOURS + 60_000);
    set_script(env, [{ text: "완료", usage: { input: 100, output: 10 } }]);
    const again = await start_run(env, { stage_id: o2.stage_id, round_id: o2.round_id, max_output_tokens: 500 });
    assert.equal(again.status, "succeeded");
  });
});

test("subscription: the weekly window still holds after the 5-hour one is free; a human resume stays blocked", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env, { subscription_limits: { five_hour_tokens: 10_000_000, weekly_tokens: 10_000, monthly_tokens: 40_000_000 } });
    const o = await plan_round(env);
    set_script(env, [context_turn({ input: 8_000, output: 900 }), FINISH]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: 500 });
    assert.equal(res.status, "blocked_usage");
    assert.equal(res.block_reason, "usage_limit");
    const blocked_calls = env.fake.calls.length;

    env.clock.advance(FIVE_HOURS + 60_000);
    const retry = await resume_outcome(env, res.run_id);
    if (retry.error !== null) assert.ok(NOT_STARTED.includes(retry.error.code));
    else assert.equal(retry.result?.status, "blocked_usage");
    assert.equal(env.fake.calls.length, blocked_calls, "the weekly limit is still full: no call");
    assert.equal(run_row(env, res.run_id).status, "blocked_usage");
  });
});

for (const format of FORMATS) {
  test(`${format}: a provider limit error stops at once, keeps the reset time, and never retries`, async () => {
    await with_a_env(format, async (env) => {
      await ready_project(env);
      const o = await plan_round(env);
      const headers = { "retry-after": "3600" };
      const body =
        format === "anthropic"
          ? { type: "error", error: { type: "rate_limit_error", message: "limit reached" } }
          : { error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } };
      set_script(env, [{ http: { status: 429, headers, body } }, context_turn(), FINISH]);
      const now = Number(env.clock.now_ms());
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(res.status, "blocked_usage");
      assert.equal(res.block_reason, "usage_limit");
      assert.equal(res.reset_at, now + 3_600_000, "retry-after seconds become the recorded reset time");
      assert.equal(env.fake.calls.length, 1, "no automatic second try after a limit error");

      const row = run_row(env, res.run_id);
      assert.equal(row.status, "blocked_usage");
      assert.equal(row.go_block_reason, "usage_limit");
      assert.equal(num(row.go_block_reset_at), now + 3_600_000);
      assert.equal(lease_state(env)?.state, "released");
      const d = dispatches(env, res.run_id);
      assert.equal(d.length, 1);
      assert.equal(d[0]!.state, "failed", "an answered 429 is a failure, not an unknown");

      // the human resumes after the reset: same run, new claim, old attempt kept as history
      env.clock.advance(3_600_000 + 1_000);
      set_script(env, [context_turn(), submit_turn(o.object_id, "합성"), FINISH]);
      const fence_before = lease_state(env)!.fence;
      const resumed = await resume_run(env, res.run_id);
      assert.equal(resumed.run_id, res.run_id);
      assert.equal(resumed.status, "succeeded");
      assert.ok(lease_state(env)!.fence > fence_before);
      const after = run_row(env, res.run_id);
      assert.equal(after.go_block_reason, null, "a resume clears the block");
      assert.equal(after.go_block_reset_at, null);
      const all = dispatches(env, res.run_id);
      assert.equal(all[0]!.state, "failed", "the failed attempt is history, never rewritten");
      assert.equal(new Set(all.map((x) => x.request_key)).size, all.length, "every attempt has its own correlation key");
    });
  });
}

test("a limit error without retry-after records an unknown reset time (null), still blocked", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await plan_round(env);
    set_script(env, [{ http: { status: 429, body: { error: { message: "quota", type: "insufficient_quota", code: "insufficient_quota" } } } }]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "blocked_usage");
    assert.equal(res.reset_at, null);
    assert.equal(run_row(env, res.run_id).go_block_reset_at, null);
  });
});

test("a human resume goes through the policy switch again", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await plan_round(env);
    set_script(env, [{ http: { status: 429, headers: { "retry-after": "60" }, body: { error: { message: "q", type: "insufficient_quota", code: "x" } } } }]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "blocked_usage");
    await policy_off(env);
    env.clock.advance(120_000);
    const out = await resume_outcome(env, res.run_id);
    assert.ok(out.error);
    assert.equal(out.error!.code, "policy_denied");
    assert.equal(env.fake.calls.length, 1);
    await policy_on(env);
    set_script(env, [FINISH]);
    const ok = await resume_run(env, res.run_id);
    assert.equal(ok.status, "succeeded");
  });
});

// ---------------------------------------------------------------------------------------------------------
// pay-per-use billing

const CAP = { currency: "USD", amount_micros: 10_000 };

test("pay_per_use without a price for the model never starts, and 0 is not assumed", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const o = await plan_round(env);
    const dto = await register_connection(env, { billing: "pay_per_use", cost_cap: CAP });
    await select_model(env, dto.connection_id, MODEL_A);
    assert_not_started(await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id }), env);
    assert.deepEqual(dispatches(env), []);

    // a price for a DIFFERENT model does not help
    await set_price(env, dto.connection_id, { model: "synthetic-other-model" });
    assert_not_started(await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id }), env);
  });
});

test("pay_per_use: cost = tokens x price, kept per call with currency", async () => {
  for (const format of FORMATS) {
    await with_a_env(format, async (env) => {
      const dto = await register_connection(env, { billing: "pay_per_use", cost_cap: { currency: "USD", amount_micros: 1_000_000 } });
      await set_price(env, dto.connection_id, { input_per_mtok_micros: 3_000_000, output_per_mtok_micros: 15_000_000 });
      await select_model(env, dto.connection_id);
      const o = await plan_round(env);
      set_script(env, [
        context_turn({ input: 1_000, output: 500 }),
        submit_turn(o.object_id, "합성", { input: 1_000, output: 500 }),
        { text: "완료", usage: { input: 1_000, output: 500 } },
      ]);
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(res.status, "succeeded", format);
      const costs = dispatches(env, res.run_id).map((d) => JSON.parse(d.cost_json ?? "null"));
      for (const c of costs) {
        assert.equal(c.currency, "USD");
        assert.equal(c.amount_micros, 3_000 + 7_500, "1000 in x $3/M + 500 out x $15/M = 10,500 micro-USD");
      }
      assert.equal(costs.length, 3);
    });
  }
});

test("pay_per_use: the next call's reservation is counted — over the cap means stop BEFORE sending", async () => {
  for (const format of FORMATS) {
    await with_a_env(format, async (env) => {
      const dto = await register_connection(env, { billing: "pay_per_use", cost_cap: CAP });
      await set_price(env, dto.connection_id, { input_per_mtok_micros: 1_000_000, output_per_mtok_micros: 2_000_000 });
      await select_model(env, dto.connection_id);
      const o = await plan_round(env);
      set_script(env, [context_turn({ input: 1_000, output: 1_000 }), submit_turn(o.object_id, "합성"), FINISH]);
      // spent after call 1 = 3,000; reserving 3,000 output tokens x 2 = 6,000 (plus the request itself, one token per character of an
      // English body, so every tool the runner offers counts) for call 2 passes the 10,000 cap — and call 1's own reservation stays under it
      // (leader 승인: SEL-99 U4a 가 도구 둘을 더해 요청이 커져 3,600 이면 첫 호출의 예약부터 상한을 넘었다 — 준비 숫자만 3,600→3,000)
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: 3_000 });
      assert.equal(res.status, "blocked_usage", format);
      assert.equal(res.block_reason, "cost_cap");
      assert.equal(env.fake.calls.length, 1, `${format}: the second request was never sent`);
      const row = run_row(env, res.run_id);
      assert.equal(row.status, "blocked_usage");
      assert.equal(row.go_block_reason, "cost_cap");
      assert.equal(lease_state(env)?.state, "released");
    });
  }
});

test("pay_per_use: the cap is cumulative across runs; raising it is a human act, then a resume works", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const dto = await register_connection(env, { billing: "pay_per_use", cost_cap: CAP });
    await set_price(env, dto.connection_id, { input_per_mtok_micros: 1_000_000, output_per_mtok_micros: 2_000_000 });
    await select_model(env, dto.connection_id);
    const o1 = await plan_round(env);
    set_script(env, [context_turn({ input: 1_000, output: 1_000 }), { text: "완료", usage: { input: 1_000, output: 1_000 } }]);
    const first = await start_run(env, { stage_id: o1.stage_id, round_id: o1.round_id, max_output_tokens: 500 });
    assert.equal(first.status, "succeeded"); // 6,000 micro-USD spent
    await close_stage(env, o1, "plan");

    const o2 = await open_stage(env, "research");
    const before = env.fake.calls.length;
    // 6,000 spent + 5,000 reserved > 10,000: refused before the first request of the new run
    const out = await start_outcome(env, { stage_id: o2.stage_id, round_id: o2.round_id, max_output_tokens: 2_500 });
    assert_not_started(out, env, before);

    // raise the cap (re-authenticated human update) and the same request now goes through
    await env.conns.update(env.ctx(next_key(env)), {
      reauth_code: await reauth(env),
      connection_id: dto.connection_id,
      cost_cap: { currency: "USD", amount_micros: 100_000 },
    });
    set_script(env, [{ text: "완료", usage: { input: 10, output: 10 } }]);
    const again = await start_run(env, { stage_id: o2.stage_id, round_id: o2.round_id, max_output_tokens: 2_500 });
    assert.equal(again.status, "succeeded");
  });
});

test("a price change reaches the next run only; a running run keeps the price it started with", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const dto = await register_connection(env, { billing: "pay_per_use", cost_cap: { currency: "USD", amount_micros: 10_000_000 } });
    await set_price(env, dto.connection_id, { input_per_mtok_micros: 1_000_000, output_per_mtok_micros: 1_000_000 });
    await select_model(env, dto.connection_id);
    const o1 = await plan_round(env);
    env.fake.on_call = async (n) => {
      if (n === 1) await set_price(env, dto.connection_id, { input_per_mtok_micros: 10_000_000, output_per_mtok_micros: 10_000_000 });
    };
    set_script(env, [context_turn({ input: 1_000, output: 1_000 }), { text: "완료", usage: { input: 1_000, output: 1_000 } }]);
    const first = await start_run(env, { stage_id: o1.stage_id, round_id: o1.round_id });
    assert.equal(first.status, "succeeded");
    assert.deepEqual(
      dispatches(env, first.run_id).map((d) => JSON.parse(d.cost_json!).amount_micros),
      [2_000, 2_000],
      "both calls of the first run use the price taken at its start",
    );
    await close_stage(env, o1, "plan");

    env.fake.on_call = undefined;
    const o2 = await open_stage(env, "research");
    set_script(env, [{ text: "완료", usage: { input: 1_000, output: 1_000 } }]);
    const second = await start_run(env, { stage_id: o2.stage_id, round_id: o2.round_id });
    assert.deepEqual(dispatches(env, second.run_id).map((d) => JSON.parse(d.cost_json!).amount_micros), [20_000]);
  });
});

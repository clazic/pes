// SEL-52 (PR19) hardening: tries to get around the cost / usage protection, to feed the loop hostile replies, to
// leak the key, to reuse a re-authentication code, and to run two things at once. Fake servers only, synthetic data.

import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { read_connection_facts, read_run_settings, usage_gate, type ConnectionFacts, type RunSettings } from "../scripts/pes_core/a_runtime/usage.ts";
import { cost_micros, estimate_tokens, REAUTH_TTL_MS } from "../scripts/pes_core/a_runtime/spec.ts";
import { ApiError } from "../scripts/pes_core/errors.ts";
import { export_project } from "../scripts/pes_core/backup.ts";
import { ctx_for, second_project } from "./helpers/blob_env.ts";
import {
  FakeAi,
  FINISH,
  KEY_MIDDLE,
  MODEL_A,
  MODEL_B,
  SYNTHETIC_KEY,
  all_runs,
  assert_no_key,
  context_turn,
  dispatches,
  everything_stored,
  lease_state,
  next_key,
  open_stage,
  policy_off,
  ready_project,
  reauth,
  register_connection,
  rejects_one_of,
  resume_run,
  run_row,
  select_model,
  set_price,
  set_script,
  start_outcome,
  start_run,
  submit_turn,
  versions_of_run,
  with_a_env,
  type AEnv,
  type ExecResult,
  type Format,
} from "./helpers/a_builtin_env.ts";

const FORMATS: Format[] = ["openai_compatible", "anthropic"];

async function pay_per_use(env: AEnv, cap_micros: number, price = 1_000_000) {
  const dto = await register_connection(env, { billing: "pay_per_use", cost_cap: { currency: "USD", amount_micros: cap_micros } });
  await set_price(env, dto.connection_id, { input_per_mtok_micros: price, output_per_mtok_micros: price });
  await select_model(env, dto.connection_id);
  return dto;
}

function gate_inputs(env: AEnv, run_id: string): { settings: RunSettings; connection: ConnectionFacts } {
  const settings = read_run_settings(env.db, run_id);
  assert.ok(settings, "run settings");
  const connection = read_connection_facts(env.db, settings.connection_id);
  assert.ok(connection, "connection facts");
  return { settings, connection };
}

function only_run_id(env: AEnv): string {
  const runs = all_runs(env);
  assert.equal(runs.length, 1);
  return runs[0]!.id;
}

// ---------------------------------------------------------------------------------------------------------
// cost / usage protection

test("an in-flight call counts against the cap and the limits: a second reservation cannot slip in beside it", async () => {
  for (const format of FORMATS) {
    // pay per use: cap 100,000 micro-USD, 1 micro-USD per token. The call in flight reserves R; a probe that only fits
    // when R is ignored must be refused.
    await with_a_env(format, async (env) => {
      await pay_per_use(env, 100_000);
      const o = await open_stage(env, "plan");
      let probe: ReturnType<typeof usage_gate> | undefined;
      let reserved = 0;
      env.fake.on_call = (n, rec) => {
        if (n !== 1) return;
        reserved = estimate_tokens(rec.text) + 500;
        const { settings, connection } = gate_inputs(env, only_run_id(env));
        probe = usage_gate(env.db, settings, connection, env.clock.now_ms(), { input_tokens: 100_000 - reserved + 1, output_tokens: 0 });
      };
      set_script(env, [FINISH]);
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: 500 });
      assert.equal(res.status, "succeeded");
      assert.ok(reserved > 0);
      assert.ok(probe, "the probe ran while the call was in flight");
      assert.equal(probe!.ok, false, `${format}: ${reserved} micro-USD are in flight, so one more that passes the cap must be refused`);
    });
    // subscription: 90% of 10,000 = 9,000 tokens in the 5-hour window
    await with_a_env(format, async (env) => {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      let probe: ReturnType<typeof usage_gate> | undefined;
      env.fake.on_call = (n, rec) => {
        if (n !== 1) return;
        const reserved = estimate_tokens(rec.text) + 500;
        const { settings, connection } = gate_inputs(env, only_run_id(env));
        probe = usage_gate(env.db, settings, connection, env.clock.now_ms(), { input_tokens: 9_000 - reserved + 1, output_tokens: 0 });
      };
      set_script(env, [FINISH]);
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: 500 });
      assert.equal(res.status, "succeeded");
      assert.equal(probe?.ok, false, `${format}: tokens in flight count against the window`);
    });
  }
});

test("two starts with the same request key are one run and one model call", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    set_script(env, [FINISH]);
    const ctx = env.ctx("same-start-key");
    const input = { owner_ctx: ctx, actor_id: env.ai_actor_id, stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: 500 };
    const settled = await Promise.allSettled([env.exec.start(input), env.exec.start(input)]);
    assert.equal(all_runs(env).length, 1, "one request key, one run");
    assert.equal(env.fake.calls.length, 1, "the model was called once");
    assert.equal(dispatches(env).length, 1);
    for (const s of settled) {
      if (s.status === "rejected") assert.ok(s.reason instanceof ApiError, `unexpected ${String(s.reason)}`);
    }
  });
});

test("two different starts at once: only the lease holder talks to the model", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    let in_flight = 0;
    let max_in_flight = 0;
    env.fake.on_call = async () => {
      in_flight += 1;
      max_in_flight = Math.max(max_in_flight, in_flight);
      await new Promise((r) => setTimeout(r, 40));
      in_flight -= 1;
    };
    set_script(env, [FINISH]);
    const start = (key: string) =>
      env.exec.start({ owner_ctx: env.ctx(key), actor_id: env.ai_actor_id, stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: 500 });
    const settled = await Promise.allSettled([start("race-a"), start("race-b")]);
    assert.ok(max_in_flight <= 1, `never two model calls in flight for one project (saw ${max_in_flight})`);
    assert.ok(settled.some((s) => s.status === "fulfilled"));
    for (const s of settled) if (s.status === "rejected") assert.ok(s.reason instanceof ApiError, String(s.reason));
    assert.ok(lease_state(env)?.state !== "active", "the lease is not left held");
  });
});

test("a reply with a usage that is negative, a string, fractional, absurdly large, or half missing is never counted as zero", async () => {
  const bad: Array<[string, any]> = [
    ["negative", { input: -5, output: 10 }],
    ["string", { input: "100", output: 5 }],
    ["fraction", { input: 1.5, output: 2 }],
    ["huge", { input: 1e300, output: 1 }],
    ["not a number", { input: Number.NaN, output: 1 }],
    ["beyond safe integers", { input: 9_007_199_254_740_993, output: 1 }],
  ];
  for (const format of FORMATS) {
    for (const [label, usage] of bad) {
      await with_a_env(format, async (env) => {
        await ready_project(env);
        const o = await open_stage(env, "plan");
        set_script(env, [{ text: "완료", usage }]);
        const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: 500 });
        assert.equal(res.status, "succeeded", `${format}/${label}`);
        const rows = dispatches(env, res.run_id);
        assert.equal(rows.length, 1);
        const stored = JSON.parse(rows[0]!.usage_json ?? "null");
        assert.ok(stored, `${format}/${label}: usage is stored`);
        assert.equal(stored.estimated, true, `${format}/${label}: a reply that cannot be trusted is estimated`);
        assert.ok(Number.isSafeInteger(stored.input_tokens) && stored.input_tokens > 0, `${format}/${label}: input ${stored.input_tokens}`);
        assert.ok(Number.isSafeInteger(stored.output_tokens) && stored.output_tokens >= 0);
      });
    }
  }
});

test("a reply that claims an enormous usage cannot slip out of the accounting (no dispatch left half-sent, no crash)", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await pay_per_use(env, Number.MAX_SAFE_INTEGER);
    const o = await open_stage(env, "plan");
    const big = 9_007_199_254_740_000;
    set_script(env, [{ text: "완료", usage: { input: big, output: big } }]);
    const out = await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: 500 });
    if (out.error !== null) assert.ok(out.error instanceof ApiError);
    for (const d of dispatches(env)) {
      assert.ok(!["prepared", "authorized", "sent"].includes(d.state), `the call is accounted for, not left ${d.state}`);
    }
    for (const r of all_runs(env)) assert.notEqual(r.status, "running", "the run is not left running");
    assert.notEqual(lease_state(env)?.state, "active", "the lease is not left held");
  });
});

test("a price so large that one reservation overflows is refused before any request", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const dto = await register_connection(env, { billing: "pay_per_use", cost_cap: { currency: "USD", amount_micros: 1_000_000 } });
    await set_price(env, dto.connection_id, { input_per_mtok_micros: Number.MAX_SAFE_INTEGER, output_per_mtok_micros: Number.MAX_SAFE_INTEGER });
    await select_model(env, dto.connection_id);
    const o = await open_stage(env, "plan");
    const before = env.fake.all.length;
    const out = await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: 200_000 });
    assert.ok(out.error, "refused");
    assert.ok(["conflict", "invalid_payload"].includes(out.error!.code), out.error!.code);
    assert.equal(env.fake.all.length, before);
    assert.deepEqual(all_runs(env), []);
  });
});

test("the price of one model in another currency than the cap never starts a run", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const dto = await register_connection(env, { billing: "pay_per_use", cost_cap: { currency: "USD", amount_micros: 1_000_000 } });
    let refused_early = false;
    try {
      await set_price(env, dto.connection_id, { currency: "EUR" });
    } catch (error) {
      assert.ok(error instanceof ApiError);
      refused_early = true;
    }
    await select_model(env, dto.connection_id).catch(() => undefined);
    const o = await open_stage(env, "plan");
    const before = env.fake.all.length;
    const out = await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.ok(out.error, refused_early ? "no price at all" : "a EUR price against a USD cap");
    assert.equal(out.error!.code, "conflict");
    assert.equal(env.fake.all.length, before);
    assert.deepEqual(all_runs(env), []);

    // a good USD price entered first, a EUR price entered later: the newer one is what a new run would use
    if (!refused_early) {
      await set_price(env, dto.connection_id, { currency: "USD" });
      await set_price(env, dto.connection_id, { currency: "EUR" });
      const again = await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.ok(again.error, "the newest price (EUR) decides, so the currencies still differ");
    }
  });
});

test("a price of 0 is a real price: the cost is 0, nothing divides or crashes, and the cost is still recorded", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const dto = await register_connection(env, { billing: "pay_per_use", cost_cap: { currency: "USD", amount_micros: 5 } });
    await set_price(env, dto.connection_id, { input_per_mtok_micros: 0, output_per_mtok_micros: 0 });
    await select_model(env, dto.connection_id);
    const o = await open_stage(env, "plan");
    set_script(env, [{ text: "완료", usage: { input: 1_000_000, output: 1_000_000 } }]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "succeeded");
    const cost = JSON.parse(dispatches(env, res.run_id)[0]!.cost_json ?? "null");
    assert.deepEqual(cost, { currency: "USD", amount_micros: 0 });
  });
});

test("cost arithmetic: rounds up, exact for big safe integers, refuses what does not fit", () => {
  assert.equal(cost_micros(0, 0, 5, 5), 0);
  assert.equal(cost_micros(1, 0, 1, 0), 1, "a single token at the smallest price costs one micro-unit, never 0");
  assert.equal(cost_micros(1_000_000, 0, 1, 0), 1);
  assert.equal(cost_micros(1_000_001, 0, 1, 0), 2);
  assert.equal(cost_micros(Number.MAX_SAFE_INTEGER, 0, 1_000_000, 0), Number.MAX_SAFE_INTEGER);
  assert.throws(() => cost_micros(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1_000_000, 1_000_000), (e: unknown) => e instanceof ApiError);
});

test("stop_percent and cap boundaries: at the line is allowed, one more is not (floor for the line, no rounding in favour of the user)", async () => {
  await with_a_env("openai_compatible", async (env) => {
    // a real connection: a subscription is gated on its OFF confirmation and baseline (recorded by ready_project)
    const real = await ready_project(env);
    const now = env.clock.now_ms();
    const base: ConnectionFacts = {
      id: real.connection_id,
      name: "synthetic",
      kind: "openai_compatible",
      request_format: "openai_compatible",
      base_url: "http://127.0.0.1:1",
      billing: "subscription",
      key_ref: "k",
      stop_percent: 90,
      limits: { five_hour_tokens: 1001, weekly_tokens: 1_000_000, monthly_tokens: 1_000_000 },
      cap: null,
      removed: false,
    };
    const sub = (stop: number): RunSettings => ({
      run_id: "r",
      project_id: "p",
      connection_id: base.id,
      model: MODEL_A,
      request_format: "openai_compatible",
      billing: "subscription",
      stop_percent: stop,
      price_currency: null,
      price_input: null,
      price_output: null,
    });
    const at = (stop: number, limits: ConnectionFacts["limits"], tokens: number) =>
      usage_gate(env.db, sub(stop), { ...base, stop_percent: stop, limits }, now, { input_tokens: tokens, output_tokens: 0 }).ok;
    assert.equal(at(90, base.limits, 900), true, "floor(1001 x 90%) = 900 is allowed");
    assert.equal(at(90, base.limits, 901), false);
    assert.equal(at(100, base.limits, 1001), true, "100% is the whole limit");
    assert.equal(at(100, base.limits, 1002), false);
    assert.equal(at(50, base.limits, 500), true);
    assert.equal(at(50, base.limits, 501), false);
    // the tightest window decides
    const weekly = { five_hour_tokens: 1_000_000, weekly_tokens: 100, monthly_tokens: 1_000_000 };
    assert.equal(at(91, weekly, 91), true);
    assert.equal(at(91, weekly, 92), false);
    const monthly = { five_hour_tokens: 1_000_000, weekly_tokens: 1_000_000, monthly_tokens: 10 };
    assert.equal(at(100, monthly, 10), true);
    assert.equal(at(100, monthly, 11), false);
    // an absurd reservation is refused, not wrapped around
    assert.equal(at(100, base.limits, Number.MAX_SAFE_INTEGER), false);
    // a missing line never lets a call through
    assert.equal(usage_gate(env.db, sub(90), { ...base, limits: null }, now, { input_tokens: 1, output_tokens: 0 }).ok, false);
    assert.equal(usage_gate(env.db, { ...sub(90), stop_percent: null }, base, now, { input_tokens: 1, output_tokens: 0 }).ok, false);

    const ppu = (cap: number, currency = "USD", price_currency = "USD"): [RunSettings, ConnectionFacts] => [
      { ...sub(90), billing: "pay_per_use", stop_percent: null, price_currency, price_input: 1_000_000, price_output: 1_000_000 },
      { ...base, billing: "pay_per_use", stop_percent: null, limits: null, cap: { currency, amount_micros: cap } },
    ];
    const [s1, c1] = ppu(1000);
    assert.equal(usage_gate(env.db, s1, c1, now, { input_tokens: 600, output_tokens: 400 }).ok, true, "exactly the cap");
    assert.equal(usage_gate(env.db, s1, c1, now, { input_tokens: 600, output_tokens: 401 }).ok, false, "one micro over");
    const [s2, c2] = ppu(1000, "USD", "EUR");
    assert.equal(usage_gate(env.db, s2, c2, now, { input_tokens: 1, output_tokens: 0 }).ok, false, "currencies differ");
  });
});

test("a limit error (429) is never counted as spent, but a call whose answer was lost is, in full", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env, { subscription_limits: { five_hour_tokens: 10_000, weekly_tokens: 1_000_000, monthly_tokens: 4_000_000 } });
    const o = await open_stage(env, "plan");
    set_script(env, [{ http: { status: 429, headers: { "retry-after": "60" } } }]);
    const first = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: 500 });
    assert.equal(first.status, "blocked_usage");
    assert.equal(dispatches(env, first.run_id)[0]!.state, "failed");
    const { settings, connection } = gate_inputs(env, first.run_id);
    assert.equal(
      usage_gate(env.db, settings, connection, env.clock.now_ms(), { input_tokens: 9_000, output_tokens: 0 }).ok,
      true,
      "a refused call used nothing, so the whole 90% line is still free",
    );
  });
});

test("an unknown call keeps counting until a person says 'not charged'; 'charged' keeps it counting", async () => {
  for (const outcome of ["not_charged", "charged"] as const) {
    await with_a_env("openai_compatible", async (env) => {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      set_script(env, [{ drop: true }]);
      const first = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: 500 });
      assert.equal(first.status, "blocked_usage");
      const [row] = dispatches(env, first.run_id);
      assert.equal(row!.state, "unknown");
      const counted = JSON.parse(row!.usage_json!) as { input_tokens: number; output_tokens: number };
      const total = counted.input_tokens + counted.output_tokens;
      assert.ok(total >= 500, "the estimate includes the full output reservation");
      const { settings, connection } = gate_inputs(env, first.run_id);
      const probe = () =>
        usage_gate(env.db, settings, connection, env.clock.now_ms(), { input_tokens: 9_000 - total + 1, output_tokens: 0 }).ok;
      assert.equal(probe(), false, "unsettled: counted");

      // resolve rules
      await rejects_one_of(
        env.service.execute(env.ctx(next_key(env)), "dispatch.resolve_unknown", { dispatch_id: row!.id, outcome: "maybe" }),
        "invalid_payload",
      );
      await rejects_one_of(
        env.service.execute(env.ctx(next_key(env)), "dispatch.resolve_unknown", { dispatch_id: "nope", outcome }),
        "not_found",
      );
      await env.service.execute(env.ctx(next_key(env)), "dispatch.resolve_unknown", { dispatch_id: row!.id, outcome });
      await rejects_one_of(
        env.service.execute(env.ctx(next_key(env)), "dispatch.resolve_unknown", { dispatch_id: row!.id, outcome: "not_charged" }),
        "conflict",
      );
      assert.equal(probe(), outcome === "not_charged", `${outcome}: ${outcome === "charged" ? "still counted" : "freed"}`);
    });
  }
});

test("only an unknown dispatch can be resolved, only by the human owner, only inside its own project", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    set_script(env, [FINISH]);
    const ok_run = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    const answered = dispatches(env, ok_run.run_id)[0]!;
    assert.equal(answered.state, "response");
    await rejects_one_of(
      env.service.execute(env.ctx(next_key(env)), "dispatch.resolve_unknown", { dispatch_id: answered.id, outcome: "not_charged" }),
      "conflict",
    );
    // an answered call cannot be written off, so its tokens stay counted
    const { settings, connection } = gate_inputs(env, ok_run.run_id);
    assert.equal(usage_gate(env.db, settings, connection, env.clock.now_ms(), { input_tokens: 9_000, output_tokens: 0 }).ok, false);

    // an unknown one: an agent actor and a person of another project are refused
    set_script(env, [{ drop: true }]);
    const lost = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    const unknown = dispatches(env, lost.run_id)[0]!;
    assert.equal(unknown.state, "unknown");
    await rejects_one_of(
      env.service.execute(env.agent_ctx(env.ai_actor_id, next_key(env)), "dispatch.resolve_unknown", { dispatch_id: unknown.id, outcome: "not_charged" }),
      "forbidden",
    );
    const other = await second_project(env);
    await rejects_one_of(
      env.service.execute(ctx_for(other, next_key(env)), "dispatch.resolve_unknown", { dispatch_id: unknown.id, outcome: "not_charged" }),
      "not_found",
      "forbidden",
    );
    assert.equal(env.db.all("SELECT 1 FROM dispatch_resolutions").length, 0, "nothing was written by a refused attempt");
  });
});

// ---------------------------------------------------------------------------------------------------------
// one run, one model — also across a resume

test("a blocked run that is resumed after the person switched models keeps its own model", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const dto = await ready_project(env, {}, MODEL_A);
    const o = await open_stage(env, "plan");
    set_script(env, [{ http: { status: 429, headers: { "retry-after": "1" } } }]);
    const first = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(first.status, "blocked_usage");
    await select_model(env, dto.connection_id, MODEL_B);
    env.clock.advance(5_000);
    set_script(env, [FINISH]);
    const second = await resume_run(env, first.run_id);
    assert.equal(second.run_id, first.run_id);
    assert.equal(second.status, "succeeded");
    assert.deepEqual(env.fake.bodies().map((b: any) => b.model), [MODEL_A, MODEL_A], "no switch inside one run");
    assert.equal(run_row(env, first.run_id).model, MODEL_A);
  });
});

// ---------------------------------------------------------------------------------------------------------
// hostile replies

test("a redirect is never followed: the key is not re-sent to another host, and the call is 'unknown'", async () => {
  for (const format of FORMATS) {
    await with_a_env(format, async (env) => {
      const decoy = await FakeAi.start(format);
      try {
        // the purpose here is "no redirect is followed"; a wide line keeps the larger token estimate from stopping the 4 starts
        await ready_project(env, { subscription_limits: { five_hour_tokens: 100_000_000, weekly_tokens: 1_000_000_000, monthly_tokens: 1_000_000_000 } });
        const o = await open_stage(env, "plan");
        const target = `${decoy.origin}${format === "anthropic" ? "/v1/messages" : "/v1/chat/completions"}`;
        for (const status of [301, 302, 307, 308]) {
          set_script(env, [{ http: { status, headers: { location: target }, body: {} } }]);
          const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
          assert.equal(res.status, "blocked_usage", `${format}/${status}`);
          assert.equal(decoy.all.length, 0, `${format}/${status}: nothing reached the other host`);
          const last = dispatches(env, res.run_id)[0]!;
          assert.ok(["unknown", "failed"].includes(last.state), `${format}/${status}: ${last.state}`);
        }
      } finally {
        await decoy.close();
      }
    });
  }
});

test("a reply that is cut off, empty, an event stream, HTML, or the wrong shape is 'unknown': one request, counted, never retried", async () => {
  const bodies: Array<[string, string, string?]> = [
    ["cut-off json", '{"id":"x","choices":[{"message":{"role":"assistant","content":"반쯤'],
    ["empty", ""],
    ["event stream", 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', "text/event-stream"],
    ["html", "<html><body>proxy error</body></html>", "text/html"],
    ["json null", "null"],
    ["json array", "[]"],
    ["no choices", '{"choices":[]}'],
    ["no content", '{"content":"not an array"}'],
  ];
  for (const format of FORMATS) {
    for (const [label, text, content_type] of bodies) {
      await with_a_env(format, async (env) => {
        await ready_project(env);
        const o = await open_stage(env, "plan");
        set_script(env, [{ raw_body: { text, ...(content_type === undefined ? {} : { content_type }) } }]);
        const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
        assert.equal(res.status, "blocked_usage", `${format}/${label}`);
        assert.equal(res.block_reason, "usage_unknown");
        assert.equal(env.fake.calls.length, 1, `${format}/${label}: no second request`);
        const rows = dispatches(env, res.run_id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.state, "unknown");
        const counted = JSON.parse(rows[0]!.usage_json ?? "null");
        assert.ok(counted && counted.input_tokens > 0 && counted.output_tokens > 0, `${format}/${label}: counted by estimate`);
        assert.notEqual(lease_state(env)?.state, "active");
        // a resume is refused until a person settles it
        await rejects_one_of(resume_run(env, res.run_id), "conflict");
        assert.equal(env.fake.calls.length, 1);
      });
    }
  }
});

test("a successful reply with no usage and no finish reason is still counted by estimate", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    set_script(env, [{ raw_body: { text: JSON.stringify({ choices: [{ message: { content: "끝" } }] }) } }]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "succeeded");
    const usage = JSON.parse(dispatches(env, res.run_id)[0]!.usage_json!);
    assert.equal(usage.estimated, true);
    assert.ok(usage.input_tokens > 0);
  });
});

test("an answer cut off by the token cap fails the run and is still counted", async () => {
  for (const [format, finish] of [["openai_compatible", "length"], ["anthropic", "max_tokens"]] as const) {
    await with_a_env(format, async (env) => {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      set_script(env, [{ text: "반쯤 쓰다", finish, usage: { input: 70, output: 30 } }]);
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(res.status, "failed", format);
      assert.equal(env.fake.calls.length, 1);
      assert.equal(versions_of_run(env, res.run_id).length, 0);
      assert.deepEqual(JSON.parse(dispatches(env, res.run_id)[0]!.usage_json!), { input_tokens: 70, output_tokens: 30 });
    });
  }
});

test("forged tool names, odd arguments and huge arguments do nothing, and the loop goes on", async () => {
  for (const format of FORMATS) {
    await with_a_env(format, async (env) => {
      await ready_project(env, { subscription_limits: { five_hour_tokens: 100_000_000, weekly_tokens: 1_000_000_000, monthly_tokens: 1_000_000_000 } });
      const o = await open_stage(env, "plan");
      const names = [
        "result.submit ",
        " result.submit",
        "RESULT.SUBMIT",
        "result.submit\u0000",
        "result.submit.",
        "context.get",
        "__proto__",
        "constructor",
        "toString",
        "hasOwnProperty",
        "../result.submit",
        "run.complete",
        "token.issue",
        "ai_connection.remove",
        "",
        "x".repeat(10_000),
      ];
      // 1.2M bytes each, ~5 MB of reply in all: big, but under the 8 MiB body limit (over it: next test)
      const huge = "가".repeat(400_000);
      const calls = [
        ...names.map((name) => ({ name, args: { results: [{ op: "append_version", object_id: o.object_id, title: "위조" }] } })),
        { name: "result.submit", args: { results: Array.from({ length: 3000 }, () => ({ op: "append_version", object_id: "x", title: "t" })) } },
        { name: "result.submit", args: { results: [{ op: "append_version", object_id: "no-such-object", title: huge, summary: huge, body_md: huge }] } },
        { name: "result.submit", args: [] },
        { name: "result.submit", args: "문자열" },
        // anthropic 의 tool_use input:null 은 깨진 블록 → unknown+blocked(final2_settle N6, leader 결정) 이라 이 "계속 진행" 시험에서는 openai 형식에서만 거부를 본다
        ...(format === "anthropic" ? [] : [{ name: "result.submit", args: null }]),
        { name: "result.submit", args: 5 },
        { name: "followup.propose", args: { text: huge } },
        { name: "question.ask", args: { questions: "not an array" } },
        { name: "thread.reply", args: { thread_id: "nope", text: "x" } },
      ];
      set_script(env, [{ tools: calls }, FINISH]);
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(res.status, "succeeded", `${format}: ${JSON.stringify(res)}`);
      assert.equal(env.fake.calls.length, 2, "every refusal is reported back and the model is asked once more");
      assert.equal(versions_of_run(env, res.run_id).length, 0, `${format}: no forged or oversized call wrote a version`);
      assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM object_versions WHERE object_id = ?", o.object_id)!.n, 1n);
      assert.equal(lease_state(env)?.state, "released");
    });
  }
});

test("a reply body over the 8 MiB limit is 'unknown': blocked usage_unknown, reservation kept, one request, no retry", async () => {
  for (const format of FORMATS) {
    await with_a_env(format, async (env) => {
      await ready_project(env, { subscription_limits: { five_hour_tokens: 100_000_000, weekly_tokens: 1_000_000_000, monthly_tokens: 1_000_000_000 } });
      const o = await open_stage(env, "plan");
      const huge = "가".repeat(2_000_000);
      set_script(env, [
        { tools: [{ name: "followup.propose", args: { text: huge } }, { name: "followup.propose", args: { text: huge } }, { name: "followup.propose", args: { text: huge } }] },
        FINISH,
      ]);
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(res.status, "blocked_usage", `${format}: ${JSON.stringify(res)}`);
      assert.equal(res.block_reason, "usage_unknown");
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(env.fake.calls.length, 1, "no automatic second call");
      const rows = dispatches(env, res.run_id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.state, "unknown");
      const usage = JSON.parse(rows[0]!.usage_json!) as { input_tokens: number; output_tokens: number };
      assert.ok(usage.input_tokens > 0 && usage.output_tokens >= 500, "the reservation stays counted");
      assert.equal(versions_of_run(env, res.run_id).length, 0);
      assert.equal(lease_state(env)?.state, "released");
    });
  }
});

test("a model that echoes huge tool arguments is stopped by the usage line before the next request, not by memory", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const huge = "가".repeat(200_000);
    set_script(env, [{ tools: [{ name: "followup.propose", args: { text: huge } }] }, FINISH]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "blocked_usage");
    assert.equal(res.block_reason, "usage_limit");
    assert.equal(env.fake.calls.length, 1, "the second request (which would carry the huge arguments back) was never sent");
    assert.notEqual(lease_state(env)?.state, "active");
  });
});

test("openai: cut-off or odd tool arguments (not JSON) are refused as a tool result, not a crash", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    set_script(env, [
      {
        tools: [
          { name: "result.submit", args: {} },
          { name: "result.submit", args: {} },
          { name: "context.get", args: {} },
          { name: "result.submit", args: {} },
        ],
        raw_arguments: ['{"results":[{"op":"append_ver', "{{{{", "", "[1,2"],
      },
      FINISH,
    ]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "succeeded");
    assert.equal(versions_of_run(env, res.run_id).length, 0);
    const tool_messages = (env.fake.bodies()[1] as any).messages.filter((m: any) => m.role === "tool");
    assert.equal(tool_messages.length, 4);
    assert.match(tool_messages[0].content, /not valid JSON/);
    assert.match(tool_messages[1].content, /not valid JSON/);
    assert.match(tool_messages[2].content, /"ok":true/, "an empty arguments string is an empty object: context.get works");
    assert.match(tool_messages[3].content, /not valid JSON/);
    void o;
  });
});

test("max_turns and max_output_tokens cannot be set past their limits", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    for (const bad of [0, -1, 1.5, 201, Number.NaN, Number.MAX_SAFE_INTEGER]) {
      await rejects_one_of(start_run(env, { stage_id: o.stage_id, round_id: o.round_id, max_turns: bad }), "invalid_payload");
    }
    for (const bad of [0, -5, 1.5, 200_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      await rejects_one_of(start_run(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: bad }), "invalid_payload");
    }
    assert.equal(env.fake.all.length, 1 /* the registration test GET */);
    assert.deepEqual(all_runs(env), []);
  });
});

// ---------------------------------------------------------------------------------------------------------
// policy switch inside a run

test("the switch turned OFF while a call is in flight: that answer is not written either", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    env.fake.on_call = async (n) => {
      if (n === 1) await policy_off(env);
    };
    set_script(env, [submit_turn(o.object_id, "스위치가 꺼진 뒤"), FINISH]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "interrupted");
    assert.equal(env.fake.calls.length, 1);
    assert.equal(versions_of_run(env, res.run_id).length, 0, "the AI wrote nothing after the person switched it off");
  });
});

// ---------------------------------------------------------------------------------------------------------
// the key

test("the key stays out of everything: requests' bodies, logs, results, errors, tables, files and an export", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const echo = `bad key ${SYNTHETIC_KEY} / Bearer ${SYNTHETIC_KEY} / ${KEY_MIDDLE}`;
    const seen: string[] = [];
    const note = (value: unknown): void => {
      seen.push(typeof value === "string" ? value : JSON.stringify(value));
    };
    const scripts = [
      { http: { status: 500, body: { error: { message: echo, type: "server_error", code: "boom" } } } },
      { http: { status: 429, headers: { "retry-after": "30" }, body: { error: { message: echo, type: echo, code: echo } } } },
      { raw_body: { text: echo } },
      { raw_body: { text: JSON.stringify({ choices: [{ message: { content: echo }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) } },
      { drop: true },
    ];
    for (const turn of scripts) {
      set_script(env, [turn as any]);
      const out = await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id });
      note(out.result);
      if (out.error !== null) note({ code: out.error.code, message: out.error.message, details: (out.error as any).details });
    }
    // management errors
    for (const call of [
      () => env.conns.register(env.ctx(next_key(env)), { name: "x", kind: "openai_compatible", base_url: env.fake.base_url, api_key: SYNTHETIC_KEY, billing: "subscription" }),
      () => env.conns.update(env.ctx(next_key(env)), { reauth_code: "x", connection_id: "nope", api_key: SYNTHETIC_KEY }),
    ]) {
      try {
        await call();
      } catch (error) {
        note(error instanceof ApiError ? { code: error.code, message: error.message, details: (error as any).details } : String(error));
      }
    }
    note(await env.conns.list(env.ctx(next_key(env))));
    note(env.logs);
    note(env.fake.all.map((r) => `${r.method} ${r.path}\n${r.text}`));
    assert_no_key(seen.join("\n"), "results, errors, DTOs, logs, request bodies");
    assert_no_key(everything_stored(env), "any table or object file");
    assert.ok(everything_stored(env).includes("5b60"), "only the last four characters are kept (sanity)");

    const out_dir = join(env.home.root, "export-out");
    mkdirSync(out_dir, { recursive: true });
    const bundle = join(out_dir, "bundle");
    export_project(env.db, env.objects, env.p.project_id, bundle);
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : [readFileSync(full).toString("latin1")];
      });
    assert_no_key(walk(bundle).join("\n"), "an exported bundle");
  });
});

// ---------------------------------------------------------------------------------------------------------
// re-authentication codes

test("a re-authentication code expires exactly at its time limit", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const base = (code: string) => ({
      reauth_code: code,
      name: "합성",
      kind: "openai_compatible",
      base_url: env.fake.base_url,
      api_key: SYNTHETIC_KEY,
      billing: "subscription",
      subscription_limits: { five_hour_tokens: 1000, weekly_tokens: 1000, monthly_tokens: 1000 },
    });
    const late = await reauth(env);
    env.clock.advance(REAUTH_TTL_MS);
    await rejects_one_of(env.conns.register(env.ctx(next_key(env)), base(late)), "forbidden");
    const on_time = await reauth(env);
    env.clock.advance(REAUTH_TTL_MS - 1);
    const dto = await env.conns.register(env.ctx(next_key(env)), base(on_time));
    assert.equal(typeof dto.connection_id, "string");
    assert.equal(env.keys.keys.size, 1);
  });
});

test("a code issued to a person of another project, or to nobody, opens nothing here; no code is stored in clear", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const other = await second_project(env);
    const foreign = (await env.conns.issue_reauth(ctx_for(other, next_key(env)))).reauth_code;
    const input = (code: string) => ({
      reauth_code: code,
      name: "합성",
      kind: "openai_compatible",
      base_url: env.fake.base_url,
      api_key: SYNTHETIC_KEY,
      billing: "subscription",
      subscription_limits: { five_hour_tokens: 1000, weekly_tokens: 1000, monthly_tokens: 1000 },
    });
    await rejects_one_of(env.conns.register(env.ctx(next_key(env)), input(foreign)), "forbidden");
    for (const nonsense of ["", " ", "x", "A".repeat(10_000), "' OR 1=1 --"]) {
      await rejects_one_of(env.conns.register(env.ctx(next_key(env)), input(nonsense)), "forbidden", "invalid_payload");
    }
    assert.equal(env.keys.keys.size, 0, "nothing was stored by a refused request");
    assert.equal(env.fake.all.length, 0, "and no request left");
    const mine = await reauth(env);
    assert.equal(everything_stored(env).includes(mine), false, "the code itself is never stored, only its hash");
    assert.equal(everything_stored(env).includes(foreign), false);
  });
});

test("the same code used twice at the same time: one connection, one stored key, the loser leaves nothing behind", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const code = await reauth(env);
    const input = {
      reauth_code: code,
      name: "합성",
      kind: "openai_compatible",
      base_url: env.fake.base_url,
      api_key: SYNTHETIC_KEY,
      billing: "subscription",
      subscription_limits: { five_hour_tokens: 1000, weekly_tokens: 1000, monthly_tokens: 1000 },
    };
    const settled = await Promise.allSettled([
      env.conns.register(env.ctx(next_key(env)), input),
      env.conns.register(env.ctx(next_key(env)), input),
    ]);
    assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1);
    const loser = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
    assert.ok(loser.reason instanceof ApiError);
    assert.equal((await env.conns.list(env.ctx(next_key(env)))).length, 1);
    assert.equal(env.keys.keys.size, 1, "the key the loser stored was taken back");
  });
});

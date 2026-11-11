// SEL-52 (PR19) regressions of the final code review 1/2 (~/hc-work/pes/logs/SEL-52-final-review-1.md, the seven
// required findings F1..F7). Written BEFORE the fix: each block fails on the tree that review read and passes only
// when the finding is really closed. Fake servers, a fake key store and a FakeClock only; no real provider, no OS
// keychain, no real money. Synthetic keys.
//
//   F1  the tool names sent to a provider obey the provider rule; the answer's tool call runs as the internal tool
//   F2  an error code / type the provider echoes (a key, a piece of it) is never stored, logged or exported
//   F3  a successful answer that echoes the key (tool arguments, text) runs no business command, enters no history
//       and no next request: the call is kept as unknown and the run is blocked
//   F4  subscription protection: "extra charge OFF" confirmation + usage baseline (human only), expiry, billing hints
//   F5  an unsettled unknown call keeps its reservation past the 5 hour / 7 day / 30 day windows
//   F6  a failing save of the dispatch settlement is retried (same key) and, when it never works, kept as unknown
//   F7  two overlapping key changes where one fails in the database never drop the key of the one that worked

import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { ApiError } from "../scripts/pes_core/errors.ts";
import { export_project } from "../scripts/pes_core/backup.ts";
import { wrap_db } from "./helpers/blob_env.ts";
import {
  A_TOOLS,
  FINISH,
  FIVE_HOURS,
  GUARD_COMMANDS,
  KEY_MIDDLE,
  MONTH,
  PROVIDER_TOOL_NAME,
  SYNTHETIC_KEY,
  WEEK,
  assert_no_key,
  confirm_off,
  context_turn,
  dispatches,
  everything_stored,
  invalid_tool_names,
  make_a_env,
  next_key,
  offered_tools,
  offered_wire_names,
  open_stage,
  reauth,
  record_baseline,
  register_connection,
  ready_project,
  rejects_one_of,
  request_text,
  resume_outcome,
  run_row,
  select_model,
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
const INTERNAL_TOOLS = (A_TOOLS as readonly string[]).filter((name) => name !== "thread.reply").sort();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let export_no = 0;

/** Everything an export of the project would carry, as one searchable string. */
function exported_text(env: AEnv): string {
  export_no += 1;
  const dir = join(env.home.root, `final1-export-${export_no}`);
  mkdirSync(dir, { recursive: true });
  const bundle = join(dir, "bundle");
  export_project(env.db, env.objects, env.p.project_id, bundle);
  const walk = (path: string): string[] =>
    readdirSync(path).flatMap((name) => {
      const full = join(path, name);
      return statSync(full).isDirectory() ? walk(full) : [readFileSync(full).toString("latin1")];
    });
  return walk(bundle).join("\n");
}

/** The key (or a piece of it) is in no table, file, log, result, outgoing request or export. */
function assert_key_nowhere(env: AEnv, res: unknown, where: string): void {
  assert_no_key(everything_stored(env), `${where}: any table row or stored file`);
  assert_no_key(env.logs.join("\n"), `${where}: the log lines`);
  assert_no_key(JSON.stringify(res), `${where}: the executor result`);
  assert_no_key(exported_text(env), `${where}: an export`);
  assert_no_key(env.fake.body_text_without_auth(), `${where}: what PES sent next`);
}

function count_rows(env: AEnv, table: string): number {
  return Number(env.db.get<{ n: bigint }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0n);
}

/** a start that did not run a model call at all: it threw, or it ended blocked / failed - never succeeded */
function assert_refused(env: AEnv, outcome: { result: ExecResult | null; error: ApiError | null }, calls_before: number, why: string): void {
  if (outcome.result !== null) assert.notEqual(outcome.result.status, "succeeded", `${why}: the run must not succeed`);
  assert.equal(outcome.result === null && outcome.error === null, false);
  assert.equal(env.fake.calls.length, calls_before, `${why}: no model call may leave`);
}

// =========================================================================================================
// F1 — tool names obey the provider rule

for (const format of FORMATS) {
  test(`F1 ${format}: every tool name on the wire matches ^[a-zA-Z0-9_-]{1,64}$ and the answer's tool calls run`, async () => {
    await with_a_env(format, async (env) => {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      set_script(env, [context_turn(), submit_turn(o.object_id, "합성 제목"), FINISH]);
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });

      // the fake server answers 400 to a name a real provider would refuse: that would have ended the run
      assert.equal(res.status, "succeeded");
      assert.equal(env.fake.calls.length, 3, "three model calls, none of them refused");
      for (const [index, body] of env.fake.bodies().entries()) {
        const wire = offered_wire_names(body);
        assert.equal(wire.length, INTERNAL_TOOLS.length, `request ${index + 1} offers ${INTERNAL_TOOLS.length} tools`);
        for (const name of wire) assert.match(name, PROVIDER_TOOL_NAME, `request ${index + 1}: tool name ${JSON.stringify(name)}`);
        assert.deepEqual(invalid_tool_names(body), [], `request ${index + 1}: offered tools and earlier tool calls`);
        assert.deepEqual(offered_tools(body), INTERNAL_TOOLS, "the same seven tools, only spelled for the wire");
      }
      assert.equal(versions_of_run(env, res.run_id).length, 1, "result.submit ran under its internal name");

      // the earlier assistant tool calls (the history of the 2nd and 3rd request) use the wire names too
      const third = env.fake.bodies()[2];
      const history =
        format === "anthropic"
          ? third.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "tool_use").map((b: any) => b.name) : []))
          : third.messages.flatMap((m: any) => (m.tool_calls ?? []).map((c: any) => c.function.name));
      assert.equal(history.length, 2, "two earlier tool calls are in the history");
      for (const name of history) assert.match(name, PROVIDER_TOOL_NAME);
    });
  });

  test(`F1 ${format}: the prompt does not tell the model a dotted tool name it was not offered`, async () => {
    await with_a_env(format, async (env) => {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      set_script(env, [context_turn(), FINISH]);
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(res.status, "succeeded");
      for (const body of env.fake.bodies()) {
        const text = request_text(body);
        for (const name of INTERNAL_TOOLS) assert.equal(text.includes(name), false, `the request text must not name ${name}`);
      }
    });
  });
}

// =========================================================================================================
// F2 — an echoed error code / type

const REFLECTIONS: Array<{ label: string; value: string; status: number }> = [
  { label: "the whole key", value: SYNTHETIC_KEY, status: 401 },
  { label: "the middle of the key", value: KEY_MIDDLE, status: 401 },
  { label: "a piece of the key inside a code-like word", value: `err_${KEY_MIDDLE}_x`, status: 401 },
  { label: "the whole key, status 500", value: SYNTHETIC_KEY, status: 500 },
  { label: "the whole key, status 429", value: SYNTHETIC_KEY, status: 429 },
];

for (const format of FORMATS) {
  for (const field of ["code", "type"] as const) {
    for (const reflection of REFLECTIONS) {
      test(`F2 ${format}: error.${field} echoing ${reflection.label} (HTTP ${reflection.status}) is stored, logged and exported nowhere`, async () => {
        await with_a_env(format, async (env) => {
          await ready_project(env);
          const o = await open_stage(env, "plan");
          const type = field === "type" ? reflection.value : "invalid_request_error";
          const code = field === "code" ? reflection.value : "invalid_api_key";
          const body =
            format === "anthropic"
              ? { type: "error", error: { type, code, message: "synthetic refusal" } }
              : { error: { message: "synthetic refusal", type, code } };
          set_script(env, [{ http: { status: reflection.status, body } }, FINISH]);
          const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
          assert.notEqual(res.status, "succeeded");
          assert.equal(env.fake.calls.length, 1, "a refused call is not retried");
          assert_key_nowhere(env, res, `error.${field}`);
          // the failure itself is still recorded (a code of PES's own choosing, whatever it is)
          assert.equal(dispatches(env, res.run_id)[0]!.state, "failed");
        });
      });
    }
  }
}

// =========================================================================================================
// F3 — a successful answer that echoes the key

type Echo = { label: string; turn: (artifact_id: string) => import("./helpers/a_builtin_env.ts").ScriptedTurn };

const ECHOES: Echo[] = [
  { label: "decision.propose text = the key", turn: () => ({ tools: [{ name: "decision.propose", args: { text: SYNTHETIC_KEY } }] }) },
  { label: "reflection.write text with the middle of the key", turn: () => ({ tools: [{ name: "reflection.write", args: { text: `메모 ${KEY_MIDDLE} 끝` } }] }) },
  { label: "result.submit title = the key", turn: (id) => submit_turn(id, `제목 ${SYNTHETIC_KEY}`) },
  { label: "answer text = the key, next to a tool call", turn: () => ({ text: `키는 ${SYNTHETIC_KEY} 입니다`, tools: [{ name: "context.get", args: {} }] }) },
  { label: "a nested argument holds the key", turn: () => ({ tools: [{ name: "question.ask", args: { questions: [{ id: "q1", text: `질문 ${SYNTHETIC_KEY}` }] } }] }) },
];

for (const format of FORMATS) {
  for (const echo of ECHOES) {
    test(`F3 ${format}: ${echo.label} -> no business command, no history, no next request; unknown + blocked`, async () => {
      await with_a_env(format, async (env) => {
        await ready_project(env);
        const o = await open_stage(env, "plan");
        const objects_before = count_rows(env, "objects");
        const versions_before = count_rows(env, "object_versions");
        const questions_before = count_rows(env, "question_sets");
        set_script(env, [echo.turn(o.object_id), FINISH]);
        const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });

        assert.equal(res.status, "blocked_usage");
        assert.equal(res.block_reason, "usage_unknown");
        await sleep(40);
        assert.equal(env.fake.calls.length, 1, "no next request was built from the polluted history");
        const [row] = dispatches(env, res.run_id);
        assert.equal(row!.state, "unknown", "the call is kept as unknown for a person to settle");
        assert.match(row!.response_hash ?? "", /^[0-9a-f]{64}$/, "its answer is still recorded as a hash");
        assert.notEqual(row!.usage_json, null, "and its usage is accounted for");

        assert.equal(count_rows(env, "objects"), objects_before, "no note / question / artifact object was created");
        assert.equal(count_rows(env, "object_versions"), versions_before, "no version was appended");
        assert.equal(count_rows(env, "question_sets"), questions_before, "no question set was published");
        assert.equal(versions_of_run(env, res.run_id).length, 0);
        assert_key_nowhere(env, res, "an echoing answer");
        assert.equal(run_row(env, res.run_id).status, "blocked_usage");
      });
    });
  }
}

// =========================================================================================================
// F4 — subscription protection

for (const format of FORMATS) {
  test(`F4 ${format}: without the "extra charge OFF" confirmation the first call never leaves`, async () => {
    await with_a_env(format, async (env) => {
      await ready_project(env, { no_guard: true });
      const o = await open_stage(env, "plan");
      set_script(env, [FINISH]);
      const out = await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert_refused(env, out, 0, "no confirmation");
      assert.equal(dispatches(env).length, 0, "no dispatch row either");
    });
  });
}

test("F4: the confirmation alone, or the baseline alone, is not enough; both together start the run", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const dto = await ready_project(env, { no_guard: true });
    const o = await open_stage(env, "plan");
    set_script(env, [FINISH]);
    const base = { stage_id: o.stage_id, round_id: o.round_id };

    await confirm_off(env, dto.connection_id);
    assert_refused(env, await start_outcome(env, base), 0, "confirmation without a usage baseline");

    // a fresh connection with only the baseline
    const other = await register_connection(env, { name: "다른 연결", no_guard: true });
    await select_model(env, other.connection_id);
    await record_baseline(env, other.connection_id);
    assert_refused(env, await start_outcome(env, base), 0, "baseline without a confirmation");

    await confirm_off(env, other.connection_id);
    const started = await start_outcome(env, base);
    assert.equal(started.result?.status, "succeeded", "both recorded: the run goes");
    assert.equal(env.fake.calls.length, 1);
  });
});

test("F4: the confirmation belongs to ONE connection", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const first = await ready_project(env);
    const second = await register_connection(env, { name: "두번째", no_guard: true });
    await select_model(env, second.connection_id);
    const o = await open_stage(env, "plan");
    set_script(env, [FINISH]);
    assert_refused(env, await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id }), 0, "second connection is not confirmed");
    assert.notEqual(first.connection_id, second.connection_id);
  });
});

test("F4: an expired confirmation blocks the next call", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const dto = await register_connection(env, { no_guard: true });
    await select_model(env, dto.connection_id);
    await confirm_off(env, dto.connection_id, { valid_ms: 3_600_000 });
    await record_baseline(env, dto.connection_id);
    const o = await open_stage(env, "plan");
    env.clock.advance(3_600_000 + 1);
    set_script(env, [FINISH]);
    assert_refused(env, await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id }), 0, "expired confirmation");
    assert.equal(dispatches(env).length, 0);
  });
});

test("F4: a confirmation that runs out in the middle of a run stops the NEXT call", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const dto = await register_connection(env, { no_guard: true });
    await select_model(env, dto.connection_id);
    await confirm_off(env, dto.connection_id, { valid_ms: 60_000 });
    await record_baseline(env, dto.connection_id);
    const o = await open_stage(env, "plan");
    env.fake.on_call = (n) => {
      if (n === 1) env.clock.advance(61_000);
    };
    set_script(env, [context_turn(), FINISH]);
    const out = await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(env.fake.calls.length, 1, "the second call never leaves: the confirmation ran out");
    if (out.result !== null) assert.notEqual(out.result.status, "succeeded");
  });
});

test("F4: confirming and recording the baseline are human-only commands (an agent is forbidden)", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const dto = await register_connection(env, { no_guard: true });
    const agent = env.agent_ctx(env.ai_actor_id, next_key(env, "agent"));
    await rejects_one_of(confirm_off(env, dto.connection_id, {}, agent), "forbidden");
    await rejects_one_of(record_baseline(env, dto.connection_id, 0, env.agent_ctx(env.ai_actor_id, next_key(env, "agent"))), "forbidden");
    // and without a re-authentication code even the human owner is refused
    await rejects_one_of(
      env.service.execute(env.ctx(next_key(env)), GUARD_COMMANDS.confirm_off, { connection_id: dto.connection_id, account_scope: "synthetic-account", valid_for_ms: 1000 }),
      "forbidden",
      "invalid_payload",
    );
    assert.equal(count_rows(env, "ai_connections") >= 1, true);
  });
});

for (const format of FORMATS) {
  test(`F4 ${format}: an answer that reports pay-per-use billing stops the run and is recorded as observed`, async () => {
    await with_a_env(format, async (env) => {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      set_script(env, [{ ...context_turn(), extra_body: { billing_source: "pay_per_use", cost: 12 } }, FINISH]);
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(env.fake.calls.length, 1, "no second call after the billing hint");
      assert.notEqual(res.status, "succeeded");
      assert.equal(res.status, "blocked_usage", "the run is held for a person");
      const [row] = env.db.all<{ billing_source: string | null }>("SELECT billing_source FROM outbound_dispatches WHERE run_id = ?", res.run_id);
      assert.equal(row!.billing_source, "pay_per_use", "the billing source is what the provider reported, not what was configured");
    });
  });
}

test("F4: an answer that reports subscription billing is not a reason to stop (control)", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    set_script(env, [{ ...context_turn(), extra_body: { billing_source: "subscription" } }, FINISH]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "succeeded");
    assert.equal(env.fake.calls.length, 2);
  });
});

test("F4: without any billing hint the configured billing is not written down as an observed source", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    set_script(env, [FINISH]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "succeeded");
    const [row] = env.db.all<{ billing_source: string | null }>("SELECT billing_source FROM outbound_dispatches WHERE run_id = ?", res.run_id);
    assert.notEqual(row!.billing_source, "subscription", "a setting a person typed is no observation");
  });
});

// =========================================================================================================
// F5 — an unsettled unknown call keeps counting

const WINDOWS = [
  { label: "5 hours", ms: FIVE_HOURS, key: "five_hour_tokens" },
  { label: "7 days", ms: WEEK, key: "weekly_tokens" },
  { label: "30 days", ms: MONTH, key: "monthly_tokens" },
] as const;

const BIG = 1_000_000_000;
const NARROW = 20_000;
const BIG_CALL = 8_000; // max output tokens: one call fits under 90% of NARROW, two do not

function limits_for(key: (typeof WINDOWS)[number]["key"]) {
  return { five_hour_tokens: BIG, weekly_tokens: BIG, monthly_tokens: BIG, [key]: NARROW };
}

for (const window of WINDOWS) {
  test(`F5: an unsettled unknown call still reserves after ${window.label}; not_charged frees it`, async () => {
    await with_a_env("openai_compatible", async (env) => {
      await ready_project(env, { subscription_limits: limits_for(window.key) });
      const o = await open_stage(env, "plan");
      set_script(env, [{ drop: true }]);
      const first = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: BIG_CALL });
      assert.equal(first.status, "blocked_usage");
      assert.equal(first.block_reason, "usage_unknown");
      const unknown = dispatches(env, first.run_id)[0]!;
      assert.equal(unknown.state, "unknown");
      assert.equal(env.fake.calls.length, 1);

      // right away: refused (the reservation counts)
      set_script(env, [FINISH]);
      assert_refused(env, await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: BIG_CALL }), 1, "inside the window");

      // just inside the window and just past it: still refused, nobody settled it
      env.clock.advance(window.ms - 1_000);
      assert_refused(env, await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: BIG_CALL }), 1, "just inside the window");
      env.clock.advance(1_001);
      assert_refused(env, await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: BIG_CALL }), 1, `past ${window.label}`);
      assert.equal(count_rows(env, "dispatch_resolutions"), 0, "nobody settled it");

      // a person writes it off: now it is free
      await env.service.execute(env.ctx(next_key(env)), "dispatch.resolve_unknown", { dispatch_id: unknown.id, outcome: "not_charged" });
      const again = await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: BIG_CALL });
      assert.equal(again.result?.status, "succeeded", "after not_charged the reservation is gone");
      assert.equal(env.fake.calls.length, 2);
    });
  });

  test(`F5: an unknown call a person settled as charged follows the ${window.label} window rule`, async () => {
    await with_a_env("openai_compatible", async (env) => {
      await ready_project(env, { subscription_limits: limits_for(window.key) });
      const o = await open_stage(env, "plan");
      set_script(env, [{ drop: true }]);
      const first = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: BIG_CALL });
      const unknown = dispatches(env, first.run_id)[0]!;
      assert.equal(unknown.state, "unknown");
      await env.service.execute(env.ctx(next_key(env)), "dispatch.resolve_unknown", { dispatch_id: unknown.id, outcome: "charged" });

      set_script(env, [FINISH]);
      env.clock.advance(window.ms - 1_000);
      assert_refused(env, await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: BIG_CALL }), 1, "charged, inside the window");
      env.clock.advance(1_001 + 1_000);
      const later = await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: BIG_CALL });
      assert.equal(later.result?.status, "succeeded", `charged usage leaves the ${window.label} window like any settled call`);
    });
  });
}

// =========================================================================================================
// F6 — saving the settlement of a model call fails

const SETTLE_RESPONSE = /UPDATE\s+outbound_dispatches\s+SET\s+state\s*=\s*'response'/i;
const SETTLE_ADOPTED = /UPDATE\s+outbound_dispatches\s+SET\s+state\s*=\s*'adopted'/i;

function failing_settle(pattern: RegExp, failures: number) {
  const state = { attempts: 0, left: failures };
  const wrap = (db: import("../scripts/pes_core/db.ts").Db) =>
    wrap_db(db, (sql) => {
      if (!pattern.test(sql)) return undefined;
      state.attempts += 1;
      if (state.left > 0) {
        state.left -= 1;
        throw new Error("synthetic: the disk is full");
      }
      return undefined;
    });
  return { state, wrap };
}

test("F6: the settlement of the answer fails once: the same request key is retried, one model call", async () => {
  const hook = failing_settle(SETTLE_RESPONSE, 1);
  const env = await make_a_env("openai_compatible", { wrap: hook.wrap });
  try {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    set_script(env, [FINISH]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "succeeded");
    assert.equal(hook.state.attempts, 2, "the failed save and its retry");
    assert.equal(env.fake.calls.length, 1, "the model was called once");
    const rows = dispatches(env, res.run_id);
    assert.equal(rows.length, 1, "no second dispatch row");
    assert.equal(rows[0]!.state, "response");
    assert.match(rows[0]!.response_hash ?? "", /^[0-9a-f]{64}$/);
  } finally {
    await env.close_all();
  }
});

test("F6: the adoption settlement fails once: retried, the result is adopted, the run goes on", async () => {
  const hook = failing_settle(SETTLE_ADOPTED, 1);
  const env = await make_a_env("openai_compatible", { wrap: hook.wrap });
  try {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    set_script(env, [submit_turn(o.object_id, "합성"), FINISH]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "succeeded");
    assert.equal(hook.state.attempts, 2);
    assert.equal(env.fake.calls.length, 2, "one call for the result, one to finish");
    assert.equal(versions_of_run(env, res.run_id).length, 1);
    assert.equal(dispatches(env, res.run_id)[0]!.state, "adopted");
  } finally {
    await env.close_all();
  }
});

test("F6: the answer can never be settled: unknown + usage_unknown, the reservation and the answer hash stay, one model call", async () => {
  const hook = failing_settle(SETTLE_RESPONSE, Number.POSITIVE_INFINITY);
  const env = await make_a_env("openai_compatible", { wrap: hook.wrap });
  try {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    set_script(env, [FINISH]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "blocked_usage", "the error is not thrown at the caller and the run is not simply failed");
    assert.equal(res.block_reason, "usage_unknown");
    assert.ok(hook.state.attempts >= 2, "it was retried before giving up");
    await sleep(40);
    assert.equal(env.fake.calls.length, 1, "the model is not called again");
    const [row] = dispatches(env, res.run_id);
    assert.equal(row!.state, "unknown");
    assert.match(row!.response_hash ?? "", /^[0-9a-f]{64}$/, "the answer's hash is kept");
    const allowance = env.db.get<{ allowance_json: string | null }>("SELECT allowance_json FROM outbound_dispatches WHERE id = ?", row!.id);
    assert.ok(allowance?.allowance_json?.includes("reservation"), "the reservation is kept");
    // and a person has to settle it before the run can go on
    const refused = await resume_outcome(env, res.run_id);
    assert.ok(refused.error, "resume with an unsettled unknown call is refused");
    assert.equal(env.fake.calls.length, 1);
  } finally {
    await env.close_all();
  }
});

test("F6: the adoption can never be settled: no throw, no failed run, no second model call", async () => {
  const hook = failing_settle(SETTLE_ADOPTED, Number.POSITIVE_INFINITY);
  const env = await make_a_env("openai_compatible", { wrap: hook.wrap });
  try {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    set_script(env, [submit_turn(o.object_id, "합성"), FINISH]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "blocked_usage");
    assert.equal(res.block_reason, "usage_unknown");
    assert.ok(hook.state.attempts >= 2);
    await sleep(40);
    assert.equal(env.fake.calls.length, 1, "the next turn is not asked while the books are open");
    assert.equal(versions_of_run(env, res.run_id).length, 1, "the saved result stays");
    assert.notEqual(dispatches(env, res.run_id)[0]!.state, "sent", "the dispatch is not left as an orphan 'sent'");
  } finally {
    await env.close_all();
  }
});

// =========================================================================================================
// F7 — two overlapping key changes, one fails in the database

const KEY_A = "sk-synthetic-canary-aaaa1111bbbb2222";
const KEY_B = "sk-synthetic-canary-cccc3333dddd4444";

interface Race {
  a: Promise<unknown>;
  b: Promise<unknown>;
}

/**
 * Starts change A, holds A right after its secret reached the key store (at most `hold_ms`, or until B is done),
 * lets change B run completely meanwhile, then lets A go on. A fix that serializes the two changes makes B wait
 * for A instead; the hold then simply times out, so the test works either way.
 */
async function overlapping_changes(
  env: AEnv,
  connection_id: string,
  a_extra: Record<string, unknown>,
  b_extra: Record<string, unknown>,
  hold_ms = 250,
): Promise<{ a: unknown; b: unknown }> {
  env.fake.accepted_keys.add(KEY_A);
  env.fake.accepted_keys.add(KEY_B);
  const code_a = await reauth(env);
  const code_b = await reauth(env);
  let stored!: () => void;
  const a_stored = new Promise<void>((resolve) => {
    stored = resolve;
  });
  let b_finished!: () => void;
  const b_done = new Promise<void>((resolve) => {
    b_finished = resolve;
  });
  env.keys.after_put = async (_ref, secret) => {
    if (secret !== KEY_A) return;
    stored();
    await Promise.race([b_done, sleep(hold_ms)]);
  };
  const settle = (p: Promise<unknown>): Promise<unknown> => p.then((value) => ({ ok: value }), (error) => ({ error }));
  const a = settle(env.conns.update(env.ctx(next_key(env, "ka")), { reauth_code: code_a, connection_id, api_key: KEY_A, ...a_extra }));
  // B starts once A's secret is in the store (or A is already over, e.g. refused up front)
  await Promise.race([a_stored, a.then(() => undefined)]);
  const b = settle(env.conns.update(env.ctx(next_key(env, "kb")), { reauth_code: code_b, connection_id, api_key: KEY_B, ...b_extra })).finally(b_finished);
  return { a: await a, b: await b };
}

async function stored_key_of(env: AEnv, connection_id: string): Promise<{ stored: string | undefined; last4: string }> {
  const row = env.db.get<{ key_ref: string; key_last4: string }>("SELECT key_ref, key_last4 FROM ai_connections WHERE id = ?", connection_id);
  assert.ok(row);
  return { stored: env.keys.keys.get(row.key_ref), last4: row.key_last4 };
}

test("F7: change A fails in the database after change B worked: B's key stays in the key store, last 4 agree", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const dto = await register_connection(env);
    const out = await overlapping_changes(env, dto.connection_id, { stop_percent: 101 }, {});
    const a = out.a as { ok?: unknown; error?: unknown };
    const b = out.b as { ok?: { key_last4?: string }; error?: unknown };
    assert.ok(a.error instanceof ApiError, "A is refused");
    assert.equal(b.error, undefined, `B worked: ${String(b.error)}`);
    const now = await stored_key_of(env, dto.connection_id);
    assert.equal(now.stored, KEY_B, "the key B was reported as saved is the one in the key store");
    assert.equal(now.last4, "4444");
    assert.equal(Array.from(now.stored ?? "").slice(-4).join(""), now.last4, "key store and database agree");
    assert.equal(env.keys.keys.size, 1, "no stray secret");
    assert_no_key(everything_stored(env), "the tables after the overlap");
    assert.equal(everything_stored(env).includes(KEY_A), false);
    assert.equal(everything_stored(env).includes(KEY_B), false);
  });
});

test("F7: both overlapping changes work: the key in the key store is the one whose last 4 the database holds", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const dto = await register_connection(env);
    const out = await overlapping_changes(env, dto.connection_id, {}, {});
    assert.equal((out.a as { error?: unknown }).error, undefined, "A worked");
    assert.equal((out.b as { error?: unknown }).error, undefined, "B worked");
    const now = await stored_key_of(env, dto.connection_id);
    assert.ok(now.stored === KEY_A || now.stored === KEY_B, "one of the two new keys won");
    assert.equal(Array.from(now.stored ?? "").slice(-4).join(""), now.last4, "key store and database agree");
    assert.equal(env.keys.keys.size, 1);
  });
});

test("F7: a later failing change puts back the key of the earlier one that worked, not an older key", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const dto = await register_connection(env);
    env.fake.accepted_keys.add(KEY_A);
    env.fake.accepted_keys.add(KEY_B);
    await env.conns.update(env.ctx(next_key(env)), { reauth_code: await reauth(env), connection_id: dto.connection_id, api_key: KEY_A });
    await rejects_one_of(
      env.conns.update(env.ctx(next_key(env)), { reauth_code: await reauth(env), connection_id: dto.connection_id, api_key: KEY_B, stop_percent: 101 }),
      "invalid_payload",
    );
    const now = await stored_key_of(env, dto.connection_id);
    assert.equal(now.stored, KEY_A);
    assert.equal(now.last4, "2222");
  });
});

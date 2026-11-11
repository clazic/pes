// SEL-52 (PR19) 1차 리뷰(r1-1) 권장 항목의 회귀 시험. Fake servers and in-memory key stores only; synthetic data.
//   R1  an orphan call left 'sent' by a dead executor can be settled by a person, counts until then, an agent cannot
//   R2  an unknown call with no usage on record counts as its reservation, never as 0
//   R3  an answer without a usage field counts at least the reserved output tokens
//   R7  a connection's key_ref is always pes-ai-<its id>: no one connection can point at another's key
//   R8  a very large answer body is not read to the end; the call is 'unknown'
//   R9  the model is not offered thread.reply (the allowlist keeps it); Korean text is not under-estimated
// R5 / R6 (the OS key stores) are in test_a_builtin_keystore*.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";

import { BuiltinExecutor } from "../scripts/pes_core/a_runtime/loop.ts";
import { http_json } from "../scripts/pes_core/a_runtime/http.ts";
import { estimate_tokens } from "../scripts/pes_core/a_runtime/spec.ts";
import { A_TOOL_ALLOWLIST, TOOL_SPECS } from "../scripts/pes_core/a_runtime/tools.ts";
import { read_connection_facts, read_run_settings, usage_gate, type ConnectionFacts, type RunSettings } from "../scripts/pes_core/a_runtime/usage.ts";
import {
  A_TOOLS,
  DEFAULT_LIMITS,
  FINISH,
  SYNTHETIC_KEY,
  context_turn,
  dispatches,
  lease_state,
  next_key,
  offered_tools,
  open_stage,
  ready_project,
  reauth,
  register_connection,
  rejects_one_of,
  resume_outcome,
  run_row,
  select_model,
  set_price,
  set_script,
  start_run,
  with_a_env,
  type AEnv,
  type Format,
} from "./helpers/a_builtin_env.ts";

const FORMATS: Format[] = ["openai_compatible", "anthropic"];
const TOKENS_LIMIT_5H = DEFAULT_LIMITS.five_hour_tokens; // 10 000 -> the 90% line is 9 000
const LINE = Math.floor((TOKENS_LIMIT_5H * 90) / 100);

function gate_inputs(env: AEnv, run_id: string): { settings: RunSettings; connection: ConnectionFacts } {
  const settings = read_run_settings(env.db, run_id);
  assert.ok(settings, "run settings");
  const connection = read_connection_facts(env.db, settings.connection_id);
  assert.ok(connection, "connection facts");
  return { settings, connection };
}

function reservation_of(env: AEnv, dispatch_id: string): { input_tokens: number; output_tokens: number } {
  const row = env.db.get<{ allowance_json: string | null }>("SELECT allowance_json FROM outbound_dispatches WHERE id = ?", dispatch_id);
  assert.ok(row?.allowance_json, "the dispatch row keeps the reservation it was prepared with");
  const parsed = JSON.parse(row.allowance_json) as { reservation: { input_tokens: number; output_tokens: number } };
  return parsed.reservation;
}

/** is a call of this many (input) tokens still allowed? */
function allowed(env: AEnv, run_id: string, tokens: number): boolean {
  const { settings, connection } = gate_inputs(env, run_id);
  return usage_gate(env.db, settings, connection, env.clock.now_ms(), { input_tokens: tokens, output_tokens: 0 }).ok;
}

async function pay_per_use(env: AEnv, cap_micros: number) {
  const dto = await register_connection(env, { billing: "pay_per_use", cost_cap: { currency: "USD", amount_micros: cap_micros } });
  await set_price(env, dto.connection_id, { input_per_mtok_micros: 1_000_000, output_per_mtok_micros: 1_000_000 });
  await select_model(env, dto.connection_id);
  return dto;
}

/**
 * Leaves a call behind exactly as an executor that died during the HTTP request would: the dispatch row is 'sent',
 * with no answer, no usage, no cost and no unknown mark. (The row of a lost reply is rewound; nothing else in the
 * run is touched. This is a test fixture, the one place a table is written directly.)
 */
function make_orphan_sent(env: AEnv, dispatch_id: string): void {
  env.db.run(
    `UPDATE outbound_dispatches
        SET state = 'sent', usage_json = NULL, cost_json = NULL, unknown_at = NULL, unknown_reason = NULL,
            response_hash = NULL, response_at = NULL
      WHERE id = ?`,
    dispatch_id,
  );
  assert.equal(dispatches(env).find((d) => d.id === dispatch_id)?.state, "sent");
}

// ---------------------------------------------------------------------------------------------------------
// R1 — an orphan 'sent' call

for (const outcome of ["not_charged", "charged"] as const) {
  test(`R1: an orphan 'sent' call counts until a person settles it as ${outcome}`, async () => {
    await with_a_env("openai_compatible", async (env) => {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      set_script(env, [{ drop: true }]);
      const first = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: 500 });
      const [row] = dispatches(env, first.run_id);
      assert.ok(row);
      make_orphan_sent(env, row.id);
      const reserved = reservation_of(env, row.id);
      const total = reserved.input_tokens + reserved.output_tokens;
      assert.ok(total >= 500);

      // until it is settled the reservation keeps counting, exactly up to the line
      assert.equal(allowed(env, first.run_id, LINE - total), true, "just under the line");
      assert.equal(allowed(env, first.run_id, LINE - total + 1), false, "one token more passes the line: the orphan counts");

      // the run cannot go on while a call of it is unaccounted for (closed, not open)
      const refused = await resume_outcome(env, first.run_id);
      assert.ok(refused.error, "resume with an unsettled orphan throws");
      assert.equal(refused.error!.code, "conflict");
      assert.equal(env.fake.calls.length, 1, "nothing was sent");

      // an agent cannot settle it; nothing is written by the refusal
      await rejects_one_of(
        env.service.execute(env.agent_ctx(env.ai_actor_id, next_key(env)), "dispatch.resolve_unknown", { dispatch_id: row.id, outcome }),
        "forbidden",
      );
      assert.equal(env.db.all("SELECT 1 FROM dispatch_resolutions").length, 0);
      assert.equal(allowed(env, first.run_id, LINE - total + 1), false, "still counted after the refused attempt");

      // the human owner can; once
      await env.service.execute(env.ctx(next_key(env)), "dispatch.resolve_unknown", { dispatch_id: row.id, outcome, note: "합성: 실행기가 죽었다" });
      await rejects_one_of(
        env.service.execute(env.ctx(next_key(env)), "dispatch.resolve_unknown", { dispatch_id: row.id, outcome: "not_charged" }),
        "conflict",
      );
      assert.equal(env.db.all("SELECT outcome FROM dispatch_resolutions").length, 1);
      if (outcome === "not_charged") {
        assert.equal(allowed(env, first.run_id, LINE), true, "written off: the whole line is free again");
      } else {
        assert.equal(allowed(env, first.run_id, LINE - total + 1), false, "charged: it keeps counting");
        assert.equal(allowed(env, first.run_id, LINE - total), true);
      }
    });
  });
}

test("R1: after the person has settled an orphan 'sent' call, the run can be resumed and sends a NEW call", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    set_script(env, [{ drop: true }, FINISH]);
    const first = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    const [row] = dispatches(env, first.run_id);
    make_orphan_sent(env, row!.id);
    await env.service.execute(env.ctx(next_key(env)), "dispatch.resolve_unknown", { dispatch_id: row!.id, outcome: "not_charged" });
    const resumed = await resume_outcome(env, first.run_id);
    assert.ok(!resumed.error, "resume goes through once the orphan is accounted for");
    assert.equal(env.fake.calls.length, 2, "one new call; the orphan was never repeated");
    assert.equal(dispatches(env, first.run_id).length, 2);
    assert.notEqual(lease_state(env)?.state, undefined);
  });
});

test("R1: only a call that is lost can be settled by a person — an answered one cannot be written off", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    set_script(env, [FINISH]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    const [answered] = dispatches(env, res.run_id);
    assert.ok(answered && ["response", "adopted"].includes(answered.state));
    await rejects_one_of(
      env.service.execute(env.ctx(next_key(env)), "dispatch.resolve_unknown", { dispatch_id: answered.id, outcome: "not_charged" }),
      "conflict",
    );
    assert.equal(env.db.all("SELECT 1 FROM dispatch_resolutions").length, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------
// R2 — an unknown call with no usage on record counts as its reservation

test("R2: subscription — an unknown call with no usage counts as its reservation (not 0 tokens)", async () => {
  for (const settled of [false, true]) {
    await with_a_env("openai_compatible", async (env) => {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      set_script(env, [{ drop: true }]);
      const first = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: 500 });
      const [row] = dispatches(env, first.run_id);
      assert.equal(row!.state, "unknown");
      // a settle that came without usage (dispatch.settle accepts that): the record has no usage and no cost
      env.db.run("UPDATE outbound_dispatches SET usage_json = NULL, cost_json = NULL WHERE id = ?", row!.id);
      const reserved = reservation_of(env, row!.id);
      const total = reserved.input_tokens + reserved.output_tokens;
      assert.ok(total >= 500, "the reservation includes the full output cap");

      assert.equal(allowed(env, first.run_id, LINE - total), true);
      assert.equal(allowed(env, first.run_id, LINE - total + 1), false, "counted as the reservation, not as 0");

      if (settled) {
        await env.service.execute(env.ctx(next_key(env)), "dispatch.resolve_unknown", { dispatch_id: row!.id, outcome: "not_charged" });
        assert.equal(allowed(env, first.run_id, LINE), true, "a person wrote it off: free again");
      }
    });
  }
});

test("R2: pay_per_use — an unknown call with no usage and no cost counts as the cost of its reservation", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const cap = 20_000;
    await pay_per_use(env, cap);
    const o = await open_stage(env, "plan");
    set_script(env, [{ drop: true }]);
    const first = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: 500 });
    const [row] = dispatches(env, first.run_id);
    assert.equal(row!.state, "unknown");
    env.db.run("UPDATE outbound_dispatches SET usage_json = NULL, cost_json = NULL WHERE id = ?", row!.id);
    const reserved = reservation_of(env, row!.id);
    const spent = reserved.input_tokens + reserved.output_tokens; // price 1 micro per token
    assert.ok(spent >= 500);
    assert.equal(allowed(env, first.run_id, cap - spent), true);
    assert.equal(allowed(env, first.run_id, cap - spent + 1), false, "spent counts the reservation, not 0");
  });
});

// ---------------------------------------------------------------------------------------------------------
// R3 — no usage in the answer: output tokens are at least the reserved output

for (const format of FORMATS) {
  test(`R3 ${format}: an answer without usage counts at least the reserved output tokens (never less)`, async () => {
    await with_a_env(format, async (env) => {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      set_script(env, [{ text: "짧다", omit_usage: true }]);
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: 500 });
      assert.notEqual(res.status, "failed");
      const [row] = dispatches(env, res.run_id);
      assert.ok(row && ["response", "adopted"].includes(row.state), `answered, got ${row?.state}`);
      const usage = JSON.parse(row.usage_json!) as { input_tokens: number; output_tokens: number };
      assert.ok(usage.output_tokens >= 500, `output counted ${usage.output_tokens}, below the 500 reserved`);
      assert.ok(usage.input_tokens >= 1);
    });
  });
}

test("R3: the same in money — a pay_per_use answer without usage is charged at least the reserved output", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await pay_per_use(env, 1_000_000);
    const o = await open_stage(env, "plan");
    set_script(env, [{ text: "짧다", omit_usage: true }]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: 500 });
    const [row] = dispatches(env, res.run_id);
    const cost = JSON.parse(row!.cost_json!) as { currency: string; amount_micros: number };
    assert.equal(cost.currency, "USD");
    assert.ok(cost.amount_micros >= 500, `cost ${cost.amount_micros} micro-USD is below 500 output tokens at 1 micro each`);
  });
});

// ---------------------------------------------------------------------------------------------------------
// R7 — key_ref is pes-ai-<connection id>

test("R7: the register command refuses a key_ref that is not pes-ai-<its own connection id>", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const first = await register_connection(env, { name: "첫 연결" });
    const own_ref = `pes-ai-${first.connection_id}`;
    assert.deepEqual([...env.keys.keys.keys()], [own_ref]);

    const payload = async (connection_id: string, key_ref: string) => ({
      reauth_code: await reauth(env),
      connection_id,
      name: "둘째 연결",
      kind: "openai_compatible",
      base_url: env.fake.base_url,
      billing: "subscription",
      subscription_limits: DEFAULT_LIMITS,
      key_ref,
      key_last4: "5b60",
      key_storage: "fake-memory-store",
    });

    // the key of another connection, a made-up reference, a different prefix, an empty-ish one
    for (const bad_ref of [own_ref, "pes-ai-someone-else", "other-ref", "pes-ai-", `${own_ref}x`]) {
      await rejects_one_of(
        env.service.execute(env.ctx(next_key(env)), "ai_connection.register", await payload("conn-r7-second", bad_ref)),
        "invalid_payload",
        "conflict",
      );
    }
    assert.equal(env.db.all("SELECT 1 FROM ai_connections WHERE id = ?", "conn-r7-second").length, 0, "nothing was registered");

    // control: the same payload with its own reference goes through, so the refusals above were about key_ref
    await env.service.execute(env.ctx(next_key(env)), "ai_connection.register", await payload("conn-r7-second", "pes-ai-conn-r7-second"));
    assert.equal(env.db.all("SELECT 1 FROM ai_connections WHERE id = ?", "conn-r7-second").length, 1);
  });
});

test("R7: removing a connection deletes only its own key", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const a = await register_connection(env, { name: "가" });
    const b = await register_connection(env, { name: "나" });
    assert.equal(env.keys.keys.size, 2);
    await env.conns.remove(env.ctx(next_key(env)), { reauth_code: await reauth(env), connection_id: a.connection_id });
    assert.deepEqual([...env.keys.keys.keys()], [`pes-ai-${b.connection_id}`], "the other connection's key is untouched");
    assert.equal(env.keys.get(`pes-ai-${b.connection_id}`), SYNTHETIC_KEY);
  });
});

// ---------------------------------------------------------------------------------------------------------
// R8 — a huge answer body

const MIB = 1024 * 1024;

/** a Response whose body would be `total` bytes long; counts how much of it anyone pulled */
function endless_response(total: number, extra_headers: Record<string, string> = {}): { response: Response; pulled: () => number } {
  const chunk = new Uint8Array(MIB).fill(0x20); // spaces: valid leading whitespace, never a complete JSON value
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= total) {
        controller.close();
        return;
      }
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return { response: new Response(body, { status: 200, headers: { "content-type": "application/json", ...extra_headers } }), pulled: () => pulled };
}

test("R8: http_json stops reading a body that is far too long and reports no answer (not a reply)", async () => {
  const total = 256 * MIB;
  const { response, pulled } = endless_response(total);
  const outcome = await http_json({ method: "POST", url: "http://127.0.0.1:1/never", headers: {}, body: "{}" }, 30_000, async () => response);
  assert.notEqual(outcome.kind, "reply", "a body that cannot be read in full is not an answer");
  assert.ok(pulled() < total / 2, `read ${pulled() / MIB} MiB of ${total / MIB}: the memory was not filled`);
});

test("R8: a body that announces a huge content-length is refused before it is read", async () => {
  const { response, pulled } = endless_response(512 * MIB, { "content-length": String(4_000_000_000) });
  const outcome = await http_json({ method: "POST", url: "http://127.0.0.1:1/never", headers: {}, body: "{}" }, 30_000, async () => response);
  assert.notEqual(outcome.kind, "reply");
  assert.ok(pulled() <= 4 * MIB, `${pulled() / MIB} MiB were read although the length was announced`);
});

test("R8: an ordinary answer, even a big one (1 MiB), is still read in full", async () => {
  const text = JSON.stringify({ ok: true, pad: "x".repeat(MIB) });
  const outcome = await http_json(
    { method: "GET", url: "http://127.0.0.1:1/models", headers: {} },
    30_000,
    async () => new Response(text, { status: 200, headers: { "content-type": "application/json" } }),
  );
  assert.equal(outcome.kind, "reply");
  if (outcome.kind === "reply") {
    assert.equal(outcome.status, 200);
    assert.equal((outcome.json as { ok: boolean }).ok, true);
    assert.equal(outcome.text_bytes, Buffer.byteLength(text, "utf8"));
  }
});

test("R8: in a run, an endless answer body leaves the call 'unknown': one request, blocked, never repeated", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const total = 256 * MIB;
    let sends = 0;
    let pulled_of_last = () => 0;
    const fetch_fn = async (_url: string, _init: RequestInit): Promise<Response> => {
      sends += 1;
      const made = endless_response(total);
      pulled_of_last = made.pulled;
      return made.response;
    };
    const executor = new BuiltinExecutor({ ...env.deps, fetch: fetch_fn } as ConstructorParameters<typeof BuiltinExecutor>[0]);
    const res = (await executor.start({
      owner_ctx: env.ctx(next_key(env, "start")),
      actor_id: env.ai_actor_id,
      stage_id: o.stage_id,
      round_id: o.round_id,
      max_output_tokens: 500,
    })) as { run_id: string; status: string; block_reason: string | null };
    assert.equal(res.status, "blocked_usage");
    assert.equal(res.block_reason, "usage_unknown");
    assert.equal(sends, 1, "no automatic second call");
    assert.ok(pulled_of_last() < total / 2, "the body was not read to the end");
    const [row] = dispatches(env, res.run_id);
    assert.equal(dispatches(env, res.run_id).length, 1);
    assert.equal(row!.state, "unknown");
    assert.ok(row!.usage_json !== null, "the reservation is kept as the usage of the unknown call");
    assert.equal(run_row(env, res.run_id).go_block_reason, "usage_unknown");
  });
});

// ---------------------------------------------------------------------------------------------------------
// R9 — thread.reply is not offered; Korean is not under-estimated

test("R9: the allowlist still names the 8 commands, but the model is offered 7 — no thread.reply", () => {
  assert.deepEqual([...A_TOOL_ALLOWLIST].sort(), [...A_TOOLS].sort());
  assert.equal(A_TOOL_ALLOWLIST.length, 8);
  assert.ok(A_TOOL_ALLOWLIST.includes("thread.reply"), "the allowlist keeps the name (decision 0013)");
  const offered = TOOL_SPECS.map((t) => t.name).sort();
  assert.deepEqual(offered, (A_TOOLS as readonly string[]).filter((n) => n !== "thread.reply").sort());
  assert.equal(offered.includes("thread.reply"), false);
  for (const name of offered) assert.ok(A_TOOL_ALLOWLIST.includes(name), `${name} is on the allowlist`);
});

for (const format of FORMATS) {
  test(`R9 ${format}: the request really sent carries no thread.reply tool`, async () => {
    await with_a_env(format, async (env) => {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      set_script(env, [context_turn(), FINISH]);
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(res.status, "succeeded");
      for (const body of env.fake.bodies()) {
        const names = offered_tools(body);
        assert.equal(names.includes("thread.reply"), false);
        assert.deepEqual(names, (A_TOOLS as readonly string[]).filter((n) => n !== "thread.reply").sort());
      }
    });
  });
}

test("R9: a model that calls thread.reply anyway gets an error result and the run is not damaged", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    set_script(env, [{ tools: [{ name: "thread.reply", args: { thread_id: "none", text: "x" } }] }, FINISH]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "succeeded");
    const second = env.fake.bodies()[1] as { messages: Array<{ role: string; content?: string }> };
    const tool_message = second.messages.find((m) => m.role === "tool");
    assert.ok(tool_message, "the model got a tool message back");
    assert.match(String(tool_message.content), /error|오류|not|없|불가|못/i);
    assert.equal(dispatches(env, res.run_id).length, 2);
  });
});

test("R9: estimate_tokens is not lower for Korean than the real cost — at least 1.5 tokens per Hangul syllable", () => {
  const hangul = "가나다라마바사아자차카타파하".repeat(40); // 560 syllables
  assert.ok(estimate_tokens(hangul) >= 1.5 * Array.from(hangul).length, `estimated ${estimate_tokens(hangul)}`);
  const mixed = "프로젝트 설명 Project description: 한글과 English 가 섞인 문장입니다. ".repeat(30);
  const syllables = (mixed.match(/[가-힣]/g) ?? []).length;
  assert.ok(estimate_tokens(mixed) >= 1.5 * syllables);
  // never less than one token per character, plain text included, and never below 1
  assert.ok(estimate_tokens("a".repeat(300)) >= 100);
  assert.equal(estimate_tokens(""), 1);
  // 4-byte characters (emoji) are not cheaper than their bytes allow
  assert.ok(estimate_tokens("😀".repeat(100)) >= 100);
});

test("R9: the reservation of a real request with Korean in it is at least 1.5 tokens per Hangul syllable of the body", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    set_script(env, [FINISH]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id, max_output_tokens: 500 });
    assert.equal(res.status, "succeeded");
    const [row] = dispatches(env, res.run_id);
    const sent = env.fake.calls[0]!.text;
    const syllables = (sent.match(/[가-힣]/g) ?? []).length;
    assert.ok(syllables > 0, "the synthetic request has Korean text in it");
    const reserved = reservation_of(env, row!.id);
    assert.ok(reserved.input_tokens >= 1.5 * syllables, `reserved ${reserved.input_tokens} input tokens for ${syllables} Hangul syllables`);
    assert.equal(reserved.output_tokens, 500);
  });
});

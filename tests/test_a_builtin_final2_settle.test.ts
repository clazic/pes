// SEL-52 final review 2/2 (~/hc-work/pes/logs/SEL-52-final-review-2.md), required N5 and N6, with their variants.
// Written BEFORE the fix.
//   N5  every path that settles a call as `unknown` (answer could not be saved, adoption could not be saved, key
//       echoed, unreadable answer) keeps the billing signal the answer carried (billing_source pay_per_use / cost):
//       the subscription connection stops and its "extra charge OFF" confirmation is void until a person records it
//       again - settling the call as charged OR not_charged does not bring the old confirmation back
//   N6  nulls / wrong shapes inside the arrays of an answer (choices, content, tool_calls, ...) are an unreadable
//       answer: unknown + usage_unknown + blocked, never a thrown TypeError and never a failed run
// Windows: no child process, no paths.

import assert from "node:assert/strict";
import { test } from "node:test";

import { wrap_db } from "./helpers/blob_env.ts";
import {
  FINISH,
  confirm_off,
  dispatches,
  make_a_env,
  next_key,
  open_stage,
  ready_project,
  record_baseline,
  resume_outcome,
  run_row,
  set_script,
  start_outcome,
  start_run,
  type AEnv,
  type ExecResult,
  type Format,
  type ScriptedTurn,
} from "./helpers/a_builtin_env.ts";
import { b64, sleep, uni } from "./helpers/a_leak.ts";
import { SYNTHETIC_KEY } from "./helpers/a_builtin_env.ts";
import { assert_key_nowhere } from "./helpers/a_leak.ts";
import type { ApiError } from "../scripts/pes_core/errors.ts";

const FORMATS: Format[] = ["openai_compatible", "anthropic"];
const HINT = { billing_source: "pay_per_use", cost: 12 };

const SETTLE_RESPONSE = /UPDATE\s+outbound_dispatches\s+SET\s+state\s*=\s*'response'/i;
const SETTLE_ADOPTED = /UPDATE\s+outbound_dispatches\s+SET\s+state\s*=\s*'adopted'/i;

function failing_settle(pattern: RegExp) {
  const state = { left: Number.POSITIVE_INFINITY };
  const wrap = (db: import("../scripts/pes_core/db.ts").Db) =>
    wrap_db(db, (sql) => {
      if (pattern.test(sql) && state.left > 0) {
        state.left -= 1;
        throw new Error("synthetic: the disk is full");
      }
      return undefined;
    });
  return { state, wrap };
}

function refused_or_stopped(out: { result: ExecResult | null; error: ApiError | null }, why: string): void {
  if (out.result !== null) assert.notEqual(out.result.status, "succeeded", `${why}: the run must not succeed`);
  assert.equal(out.result === null && out.error === null, false, why);
}

// =========================================================================================================
// N5

interface Path {
  label: string;
  formats: Format[];
  /** the turns the fake server answers (the first carries the billing hint) */
  turns: (format: Format, object_id: string) => ScriptedTurn[];
  /** an in-database failure that makes the settlement an unknown one */
  fail?: RegExp;
}

const PATHS: Path[] = [
  { label: "the answer cannot be saved", formats: ["openai_compatible"], fail: SETTLE_RESPONSE, turns: () => [{ text: "완료", extra_body: HINT }] },
  {
    label: "the adoption cannot be saved",
    formats: ["openai_compatible"],
    fail: SETTLE_ADOPTED,
    turns: (_f, id) => [
      { tools: [{ name: "result.submit", args: { results: [{ op: "append_version", object_id: id, title: "합성" }] } }], extra_body: HINT },
      FINISH,
    ],
  },
  { label: "the answer text echoes the key", formats: FORMATS, turns: () => [{ text: `키 ${SYNTHETIC_KEY}`, extra_body: HINT }, FINISH] },
  {
    label: "a tool argument echoes the key (base64)",
    formats: FORMATS,
    turns: () => [{ tools: [{ name: "decision.propose", args: { text: b64(SYNTHETIC_KEY) } }], extra_body: HINT }, FINISH],
  },
  {
    label: "a tool argument echoes the key (\\u escapes inside the arguments string)",
    formats: ["openai_compatible"],
    turns: () => [
      { tools: [{ name: "decision.propose", args: { text: "x" } }], raw_arguments: [`{"text":"${uni(SYNTHETIC_KEY)}"}`], extra_body: HINT },
      FINISH,
    ],
  },
  {
    label: "the answer has a null inside its arrays",
    formats: FORMATS,
    turns: (format) => [
      {
        raw_body: {
          text: JSON.stringify(
            format === "anthropic"
              ? { id: "m", type: "message", role: "assistant", content: [null], usage: { input_tokens: 10, output_tokens: 5 }, ...HINT }
              : { id: "c", choices: [null], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, ...HINT },
          ),
        },
      },
      FINISH,
    ],
  },
];

for (const path of PATHS) {
  for (const format of path.formats) {
    for (const outcome of ["not_charged", "charged"] as const) {
      test(`N5 ${format}: ${path.label}, hint pay_per_use -> unknown keeps it; settled as ${outcome} still needs a new OFF confirmation`, async () => {
        const hook = path.fail === undefined ? undefined : failing_settle(path.fail);
        const env: AEnv = await make_a_env(format, hook === undefined ? {} : { wrap: hook.wrap });
        try {
          const dto = await ready_project(env);
          const o = await open_stage(env, "plan");
          set_script(env, path.turns(format, o.object_id));
          const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
          assert.equal(res.status, "blocked_usage");
          assert.equal(res.block_reason, "usage_unknown");
          await sleep(40);
          assert.equal(env.fake.calls.length, 1, "no second request");
          const [row] = dispatches(env, res.run_id);
          assert.equal(row!.state, "unknown");
          const seen = env.db.get<{ billing_source: string | null }>("SELECT billing_source FROM outbound_dispatches WHERE id = ?", row!.id);
          assert.equal(seen?.billing_source, "pay_per_use", "the billing signal of the answer is kept on the unknown call");
          await assert_key_nowhere(env, res, path.label);

          // a person settles the call; the account's OFF confirmation is still void because the answer said it was charged
          await env.service.execute(env.ctx(next_key(env)), "dispatch.resolve_unknown", { dispatch_id: row!.id, outcome, note: "합성" });
          if (hook !== undefined) hook.state.left = 0; // the disk works again
          const calls = env.fake.calls.length;
          refused_or_stopped(await resume_outcome(env, res.run_id), "resume on the old confirmation");
          assert.equal(env.fake.calls.length, calls, "no call from the resume");
          refused_or_stopped(await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id }), "a new start on the old confirmation");
          assert.equal(env.fake.calls.length, calls, "no call from a new start");

          // a person looks at the account again and records both: it goes on
          env.clock.advance(1);
          await confirm_off(env, dto.connection_id);
          await record_baseline(env, dto.connection_id);
          set_script(env, [FINISH]);
          const again = await resume_outcome(env, res.run_id);
          assert.equal(again.error, null, "resume is allowed after a new confirmation");
          assert.equal(again.result?.status, "succeeded");
          assert.equal(env.fake.calls.length, calls + 1);
        } finally {
          await env.close_all();
        }
      });
    }
  }
}

for (const format of FORMATS) {
  test(`N5 ${format}: control - an unknown call WITHOUT a billing signal keeps the old confirmation after a person settles it`, async () => {
    await (async () => {
      const env = await make_a_env(format);
      try {
        await ready_project(env);
        const o = await open_stage(env, "plan");
        set_script(env, [{ drop: true }]);
        const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
        assert.equal(res.status, "blocked_usage");
        const [row] = dispatches(env, res.run_id);
        const seen = env.db.get<{ billing_source: string | null }>("SELECT billing_source FROM outbound_dispatches WHERE id = ?", row!.id);
        assert.equal(seen?.billing_source, null);
        await env.service.execute(env.ctx(next_key(env)), "dispatch.resolve_unknown", { dispatch_id: row!.id, outcome: "not_charged", note: "합성" });
        set_script(env, [FINISH]);
        const again = await resume_outcome(env, res.run_id);
        assert.equal(again.result?.status, "succeeded");
      } finally {
        await env.close_all();
      }
    })();
  });
}

// =========================================================================================================
// N6 — nulls and wrong shapes inside the arrays of an answer

const USAGE_OPENAI = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const USAGE_ANTHROPIC = { input_tokens: 10, output_tokens: 5 };

const openai = (choices: unknown): unknown => ({ id: "c1", object: "chat.completion", model: "m", choices, usage: USAGE_OPENAI });
const openai_msg = (message: unknown): unknown => openai([{ index: 0, message, finish_reason: "stop" }]);
const anthropic = (content: unknown): unknown => ({ id: "m1", type: "message", role: "assistant", model: "m", content, stop_reason: "end_turn", usage: USAGE_ANTHROPIC });

const SHAPES: Array<{ format: Format; label: string; body: unknown }> = [
  { format: "openai_compatible", label: "choices: [null]", body: openai([null]) },
  { format: "openai_compatible", label: "choices: [1]", body: openai([1]) },
  { format: "openai_compatible", label: "choices: [[]]", body: openai([[]]) },
  { format: "openai_compatible", label: "choices: {} (not an array)", body: openai({}) },
  { format: "openai_compatible", label: "message: null", body: openai_msg(null) },
  { format: "openai_compatible", label: "message: []", body: openai_msg([]) },
  { format: "openai_compatible", label: "tool_calls: [null]", body: openai_msg({ role: "assistant", content: null, tool_calls: [null] }) },
  { format: "openai_compatible", label: "tool_calls: [1]", body: openai_msg({ role: "assistant", content: null, tool_calls: [1] }) },
  { format: "openai_compatible", label: "tool_calls: [[]]", body: openai_msg({ role: "assistant", content: null, tool_calls: [[]] }) },
  { format: "openai_compatible", label: "tool_calls: 'x' (not an array)", body: openai_msg({ role: "assistant", content: null, tool_calls: "x" }) },
  { format: "openai_compatible", label: "tool call with function: null", body: openai_msg({ role: "assistant", content: null, tool_calls: [{ id: "t", type: "function", function: null }] }) },
  {
    format: "openai_compatible",
    label: "tool call with name and arguments null",
    body: openai_msg({ role: "assistant", content: null, tool_calls: [{ id: "t", type: "function", function: { name: null, arguments: null } }] }),
  },
  { format: "openai_compatible", label: "content: [null] (content parts)", body: openai_msg({ role: "assistant", content: [null] }) },
  { format: "anthropic", label: "content: [null]", body: anthropic([null]) },
  { format: "anthropic", label: "content: [1]", body: anthropic([1]) },
  { format: "anthropic", label: "content: [[]]", body: anthropic([[]]) },
  { format: "anthropic", label: "content: null", body: anthropic(null) },
  { format: "anthropic", label: "content: 'x' (not an array)", body: anthropic("x") },
  { format: "anthropic", label: "content: [{}]", body: anthropic([{}]) },
  { format: "anthropic", label: "text block with text: null", body: anthropic([{ type: "text", text: null }]) },
  { format: "anthropic", label: "tool_use with input: null", body: anthropic([{ type: "tool_use", id: "t", name: "decision.propose", input: null }]) },
  { format: "anthropic", label: "tool_use with name: null", body: anthropic([{ type: "tool_use", id: "t", name: null, input: {} }]) },
  { format: "anthropic", label: "a good block followed by null", body: anthropic([{ type: "text", text: "안녕" }, null]) },
];

for (const shape of SHAPES) {
  test(`N6 ${shape.format}: ${shape.label} -> unknown + usage_unknown + blocked, no throw, no failed run`, async () => {
    const env = await make_a_env(shape.format);
    try {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      set_script(env, [{ raw_body: { text: JSON.stringify(shape.body) } }, FINISH]);
      let res: ExecResult | undefined;
      try {
        res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      } catch (error) {
        assert.fail(`the executor threw instead of settling the call as unknown: ${String(error)}`);
      }
      assert.equal(res.status, "blocked_usage");
      assert.equal(res.block_reason, "usage_unknown");
      assert.notEqual(run_row(env, res.run_id).status, "failed");
      await sleep(40);
      assert.equal(env.fake.calls.length, 1, "no second request");
      const rows = dispatches(env, res.run_id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.state, "unknown");
      assert.match(rows[0]!.response_hash ?? "", /^[0-9a-f]{64}$/, "the answer's hash is kept");
      assert.ok(rows[0]!.usage_json !== null, "the call's usage is accounted for");
      const allowance = env.db.get<{ allowance_json: string | null }>("SELECT allowance_json FROM outbound_dispatches WHERE id = ?", rows[0]!.id);
      assert.ok(allowance?.allowance_json?.includes("reservation"), "the reservation stays");
      // a person can settle it, and the run can then go on (a failed run could not)
      const refused = await resume_outcome(env, res.run_id);
      assert.ok(refused.error, "resume with an unsettled call is refused");
      await env.service.execute(env.ctx(next_key(env)), "dispatch.resolve_unknown", { dispatch_id: rows[0]!.id, outcome: "not_charged", note: "합성" });
      const again = await resume_outcome(env, res.run_id);
      assert.equal(again.error, null);
      assert.equal(again.result?.status, "succeeded");
    } finally {
      await env.close_all();
    }
  });
}

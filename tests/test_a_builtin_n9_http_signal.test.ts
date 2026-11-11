// SEL-52 final review 3 (~/hc-work/pes/logs/SEL-52-final-review-3.md), N9: an HTTP ERROR answer (4xx / 5xx / 429 with
// Retry-After) that carries a billing signal (billing_source 'pay_per_use', or a positive cost at the top or in usage)
// must not be thrown away as a plain 'failed' call. The dispatch keeps the signal, the usage and the reservation
// (not 'failed', not 'sent'), the run is held, the subscription connection's "extra charge OFF" confirmation is void,
// and nothing is sent again - resume, new start, the next call - until a person records the confirmation anew
// (settling the call as charged or not_charged does not bring the old one back). Errors WITHOUT a signal keep today's
// handling (control tests). Truncated / event-stream / lost answers: no throw, never left 'sent', no extra request.
// Written BEFORE the fix. Synthetic only; no child process, no path comparison (Windows safe).

import assert from "node:assert/strict";
import { test } from "node:test";

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
import { sleep } from "./helpers/a_leak.ts";
import type { ApiError } from "../scripts/pes_core/errors.ts";

const FORMATS: Format[] = ["openai_compatible", "anthropic"];
const STATUSES = [400, 402, 403, 409, 429, 500, 503];

function error_body(format: Format, status: number, extra: Record<string, unknown>): unknown {
  return format === "anthropic"
    ? { type: "error", error: { type: status === 429 ? "rate_limit_error" : "api_error", message: "synthetic" }, ...extra }
    : { error: { message: "synthetic", type: status === 429 ? "rate_limit_error" : "api_error", code: status === 429 ? "rate_limit_exceeded" : "synthetic_code" }, ...extra };
}

function http_turn(format: Format, status: number, extra: Record<string, unknown>): ScriptedTurn {
  return { http: { status, ...(status === 429 ? { headers: { "retry-after": "1" } } : {}), body: error_body(format, status, extra) } };
}

const SIGNALS: Array<{ label: string; extra: Record<string, unknown> }> = [
  { label: "billing_source pay_per_use + cost 12", extra: { billing_source: "pay_per_use", cost: 12 } },
  { label: "billing_source pay_per_use only", extra: { billing_source: "pay_per_use" } },
  { label: "positive cost only", extra: { cost: 12 } },
  { label: "positive usage.cost only", extra: { usage: { cost: 7 } } },
];

function refused_or_stopped(out: { result: ExecResult | null; error: ApiError | null }, why: string): void {
  if (out.result !== null) assert.notEqual(out.result.status, "succeeded", `${why}: the run must not succeed`);
  assert.equal(out.result === null && out.error === null, false, why);
}

function billing_of(env: AEnv, dispatch_id: string): { billing_source: string | null; allowance_json: string | null } | undefined {
  return env.db.get("SELECT billing_source, allowance_json FROM outbound_dispatches WHERE id = ?", dispatch_id);
}

// ---------------------------------------------------------------------------------------------------------
// the signal is kept; the next call waits for a new OFF confirmation

for (const format of FORMATS) {
  for (const status of STATUSES) {
    for (const signal of SIGNALS) {
      if (signal.label !== SIGNALS[0]!.label && status !== 429 && status !== 500) continue; // keep the matrix small
      for (const outcome of ["not_charged", "charged"] as const) {
        if (outcome === "charged" && signal.label !== SIGNALS[0]!.label) continue;
        test(`N9 ${format}: HTTP ${status} with ${signal.label} -> signal and reservation kept, no call until a new OFF confirmation (person settles: ${outcome})`, async () => {
          const env = await make_a_env(format);
          try {
            const dto = await ready_project(env);
            const o = await open_stage(env, "plan");
            set_script(env, [http_turn(format, status, signal.extra), FINISH]);
            const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
            assert.equal(res.status, "blocked_usage", "held, not failed");
            assert.equal(run_row(env, res.run_id).status, "blocked_usage");
            await sleep(30);
            assert.equal(env.fake.calls.length, 1, "no second request");
            const rows = dispatches(env, res.run_id);
            assert.equal(rows.length, 1);
            const row = rows[0]!;
            assert.equal(row.state, "unknown", "the call is kept for a person to settle, not thrown away as failed");
            assert.notEqual(row.usage_json, null, "its usage is accounted for");
            const seen = billing_of(env, row.id);
            assert.equal(seen?.billing_source, "pay_per_use", "the billing signal of the error answer is kept");
            assert.ok(seen?.allowance_json?.includes("reservation"), "the reservation stays");

            // the 429 wait is over, but the old OFF confirmation is void: nothing goes out
            env.clock.advance(1_100);
            const calls = env.fake.calls.length;
            refused_or_stopped(await resume_outcome(env, res.run_id), "resume while the signal is unconfirmed");
            assert.equal(env.fake.calls.length, calls, "no call from the resume");
            refused_or_stopped(await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id }), "a new start while the signal is unconfirmed");
            assert.equal(env.fake.calls.length, calls, "no call from a new start");

            // a person settles the call; the old confirmation stays void
            await env.service.execute(env.ctx(next_key(env)), "dispatch.resolve_unknown", { dispatch_id: row.id, outcome, note: "합성" });
            refused_or_stopped(await resume_outcome(env, res.run_id), "resume after the call was settled by a person");
            refused_or_stopped(await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id }), "a new start after the call was settled");
            assert.equal(env.fake.calls.length, calls, "still no call");

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
}

// ---------------------------------------------------------------------------------------------------------
// controls: no billing signal -> today's handling

for (const format of FORMATS) {
  for (const status of STATUSES) {
    test(`N9 ${format}: control - HTTP ${status} WITHOUT a billing signal is handled as today`, async () => {
      const env = await make_a_env(format);
      try {
        await ready_project(env);
        const o = await open_stage(env, "plan");
        // cost 0 and no billing_source: nothing was charged
        set_script(env, [http_turn(format, status, { cost: 0 }), FINISH]);
        const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
        const rows = dispatches(env, res.run_id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.state, "failed");
        assert.equal(billing_of(env, rows[0]!.id)?.billing_source, null);
        if (status === 429) {
          assert.equal(res.status, "blocked_usage");
          assert.equal(res.block_reason, "usage_limit");
          env.clock.advance(1_100);
          set_script(env, [FINISH]);
          const again = await resume_outcome(env, res.run_id);
          assert.equal(again.result?.status, "succeeded", "after the wait the old confirmation still holds");
          assert.equal(env.fake.calls.length, 2);
        } else {
          assert.equal(res.status, "failed");
          assert.equal(env.fake.calls.length, 1);
        }
      } finally {
        await env.close_all();
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------------------
// the other branches of an HTTP error: truncated body, event stream, lost answer

interface Odd {
  label: string;
  turn: (format: Format, status: number) => ScriptedTurn;
}
const SIGNAL_TEXT = '"billing_source":"pay_per_use","cost":12';
const ODD: Odd[] = [
  { label: "truncated JSON body", turn: (_f, status) => ({ raw_body: { status, text: `{"error":{"code":"x"},${SIGNAL_TEXT.slice(0, 30)}` } }) },
  { label: "event-stream body", turn: (_f, status) => ({ raw_body: { status, content_type: "text/event-stream", text: `data: {${SIGNAL_TEXT}}\n\ndata: [DONE]\n\n` } }) },
  { label: "empty body", turn: (_f, status) => ({ raw_body: { status, text: "" } }) },
  { label: "HTML body", turn: (_f, status) => ({ raw_body: { status, content_type: "text/html", text: "<html>bad gateway</html>" } }) },
];

for (const format of FORMATS) {
  for (const status of [400, 429, 500, 502]) {
    for (const odd of ODD) {
      test(`N9 ${format}: HTTP ${status}, ${odd.label} -> no throw, never left 'sent', no further request`, async () => {
        const env = await make_a_env(format);
        try {
          await ready_project(env);
          const o = await open_stage(env, "plan");
          set_script(env, [odd.turn(format, status), FINISH]);
          let res: ExecResult | undefined;
          try {
            res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
          } catch (error) {
            assert.fail(`the executor threw: ${String(error)}`);
          }
          await sleep(30);
          assert.equal(env.fake.calls.length, 1, "one attempt, no next request");
          for (const row of dispatches(env, res.run_id)) assert.notEqual(row.state, "sent", "the dispatch is left as 'sent'");
          assert.notEqual(run_row(env, res.run_id).status, "running");
          assert.notEqual(res.status, "succeeded");
        } finally {
          await env.close_all();
        }
      });
    }
  }

  test(`N9 ${format}: the answer is lost (connection closed) -> unknown, run held, no further request (stays as today)`, async () => {
    const env = await make_a_env(format);
    try {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      set_script(env, [{ drop: true }, FINISH]);
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(res.status, "blocked_usage");
      assert.equal(res.block_reason, "usage_unknown");
      assert.equal(dispatches(env, res.run_id)[0]?.state, "unknown");
      await sleep(30);
      assert.equal(env.fake.calls.length, 1);
    } finally {
      await env.close_all();
    }
  });
}

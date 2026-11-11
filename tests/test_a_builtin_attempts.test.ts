// SEL-52 (PR19) call attempts: every model call is written down BEFORE it is sent, a lost or timed-out
// response is 'unknown' and is never called again by itself, and re-saving an already received answer is
// not a second model call.

import assert from "node:assert/strict";
import { test } from "node:test";

import { wrap_db } from "./helpers/blob_env.ts";
import {
  FINISH,
  context_turn,
  dispatches,
  events_by_type,
  lease_state,
  make_a_env,
  next_key,
  open_stage,
  ready_project,
  resume_outcome,
  resume_run,
  run_row,
  set_script,
  start_run,
  submit_turn,
  versions_of_run,
  with_a_env,
  type DispatchRow,
  type Format,
} from "./helpers/a_builtin_env.ts";

const FORMATS: Format[] = ["openai_compatible", "anthropic"];

test("each call is a dispatch row that already exists, in state 'sent', when the request arrives", async () => {
  for (const format of FORMATS) {
    await with_a_env(format, async (env) => {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      const seen: Array<{ n: number; rows: DispatchRow[] }> = [];
      env.fake.on_call = (n) => {
        seen.push({ n, rows: dispatches(env) });
      };
      set_script(env, [context_turn(), submit_turn(o.object_id, "합성"), FINISH]);
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(res.status, "succeeded", format);
      assert.equal(seen.length, 3);
      for (const { n, rows } of seen) {
        assert.equal(rows.length, n, `${format}: ${n} attempt(s) were written before request ${n} was handled`);
        const current = rows[n - 1]!;
        assert.equal(current.state, "sent", `${format}: the attempt for request ${n} is 'sent' while in flight`);
        assert.notEqual(current.sent_at, null);
        assert.equal(current.response_hash, null, "no answer yet");
        assert.match(current.payload_hash, /^[0-9a-f]{64}$/);
        assert.ok(current.request_key.length > 0, "a correlation key exists before sending");
        for (const earlier of rows.slice(0, n - 1)) {
          assert.ok(["response", "adopted"].includes(earlier.state), `earlier attempts are settled: ${earlier.state}`);
        }
      }
      const final = dispatches(env, res.run_id);
      assert.equal(new Set(final.map((d) => d.request_key)).size, 3, "a correlation key per attempt");
      for (const d of final) {
        assert.match(d.response_hash ?? "", /^[0-9a-f]{64}$/, "the received answer is hashed");
      }
      assert.ok(final.some((d) => d.state === "adopted" && d.adopted_version_id !== null), "the answer that wrote a result is adopted");
    });
  }
});

test("a lost response is 'unknown': one request, no automatic second call, blocked until a human settles it", async () => {
  for (const format of FORMATS) {
    await with_a_env(format, async (env) => {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      set_script(env, [{ drop: true }, context_turn(), FINISH]);
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(res.status, "blocked_usage", format);
      assert.equal(res.block_reason, "usage_unknown");
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(env.fake.calls.length, 1, `${format}: the lost call was not repeated`);

      const [d] = dispatches(env, res.run_id);
      assert.equal(dispatches(env, res.run_id).length, 1);
      assert.equal(d!.state, "unknown");
      assert.notEqual(d!.unknown_at, null);
      assert.ok((d!.unknown_reason ?? "").length > 0);
      assert.notEqual(d!.sent_at, null, "the evidence that it may have gone out is kept");
      const row = run_row(env, res.run_id);
      assert.equal(row.status, "blocked_usage");
      assert.equal(row.go_block_reason, "usage_unknown");
      assert.equal(lease_state(env)?.state, "released");
    });
  }
});

test("a timeout is the same: unknown, one request, no retry", async () => {
  const env = await make_a_env("openai_compatible", { request_timeout_ms: 80 });
  try {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    set_script(env, [{ delay_ms: 600, text: "늦은 답" }, FINISH]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "blocked_usage");
    assert.equal(res.block_reason, "usage_unknown");
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(env.fake.calls.length, 1);
    assert.equal(dispatches(env, res.run_id)[0]!.state, "unknown");
  } finally {
    await env.close_all();
  }
});

test("an unknown attempt blocks the resume until a human settles it; then a NEW attempt is sent", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    set_script(env, [{ drop: true }]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "blocked_usage");
    const unknown = dispatches(env, res.run_id)[0]!;

    // not settled: a resume sends nothing
    const refused = await resume_outcome(env, res.run_id);
    assert.ok(refused.error, "resume with an unsettled attempt throws");
    assert.equal(refused.error!.code, "conflict");
    assert.equal(env.fake.calls.length, 1);

    // an agent cannot settle it; the human owner can
    await assert.rejects(
      env.service.execute(env.agent_ctx(env.ai_actor_id, "ai-settle"), "dispatch.resolve_unknown", {
        dispatch_id: unknown.id,
        outcome: "not_charged",
        note: "합성",
      }),
      (e: any) => e?.code === "forbidden",
    );
    await env.service.execute(env.ctx(next_key(env)), "dispatch.resolve_unknown", {
      dispatch_id: unknown.id,
      outcome: "not_charged",
      note: "합성: 콘솔에서 확인함",
    });
    assert.ok(events_by_type(env, "dispatch.unknown_resolved").length >= 1, "the settlement is an audited event");
    assert.equal(dispatches(env, res.run_id)[0]!.state, "unknown", "the old attempt stays as it was");

    set_script(env, [FINISH]);
    const resumed = await resume_run(env, res.run_id);
    assert.equal(resumed.status, "succeeded");
    assert.equal(env.fake.calls.length, 2, "exactly one new request");
    const all = dispatches(env, res.run_id);
    assert.equal(all.length, 2);
    assert.notEqual(all[0]!.request_key, all[1]!.request_key, "a new attempt, a new correlation key");
  });
});

test("a server error answer is not retried by itself", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    set_script(env, [{ http: { status: 500, body: { error: { message: "boom", type: "server_error", code: null } } } }, FINISH]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.ok(["failed", "blocked_usage"].includes(res.status), res.status);
    assert.equal(env.fake.calls.length, 1);
    assert.ok(["failed", "unknown"].includes(dispatches(env, res.run_id)[0]!.state));
  });
});

test("saving the answer fails twice: the save is retried, the model is called once", async () => {
  let failures = 2;
  let attempts = 0;
  const env = await make_a_env("openai_compatible", {
    save_retries: 2,
    wrap: (db) =>
      wrap_db(db, (sql) => {
        if (/INSERT INTO object_versions/i.test(sql)) {
          attempts += 1;
          if (failures > 0) {
            failures -= 1;
            throw new Error("synthetic: disk is full");
          }
        }
        return undefined;
      }),
  });
  try {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    set_script(env, [submit_turn(o.object_id, "합성"), FINISH]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "succeeded");
    assert.equal(attempts, 3, "two failed saves and one that worked");
    assert.equal(env.fake.calls.length, 2, "one model call for the result, one to finish — the save retries added none");
    assert.equal(versions_of_run(env, res.run_id).length, 1);
    const first = dispatches(env, res.run_id)[0]!;
    assert.equal(first.state, "adopted");
    assert.equal(first.request_key.length > 0, true);
  } finally {
    await env.close_all();
  }
});

test("saving keeps failing: the answer is kept as unknown, the model is not called again", async () => {
  let attempts = 0;
  const env = await make_a_env("openai_compatible", {
    save_retries: 2,
    wrap: (db) =>
      wrap_db(db, (sql) => {
        if (/INSERT INTO object_versions/i.test(sql)) {
          attempts += 1;
          throw new Error("synthetic: disk is full");
        }
        return undefined;
      }),
  });
  try {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    set_script(env, [submit_turn(o.object_id, "합성"), FINISH]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "blocked_usage");
    assert.equal(res.block_reason, "usage_unknown");
    assert.equal(attempts, 3, "first try plus save_retries");
    assert.equal(env.fake.calls.length, 1, "the already received answer is never fetched again");
    assert.equal(versions_of_run(env, res.run_id).length, 0);
    const d = dispatches(env, res.run_id)[0]!;
    assert.equal(d.state, "unknown");
    assert.match(d.response_hash ?? "", /^[0-9a-f]{64}$/, "the received answer is still recorded");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(env.fake.calls.length, 1);
  } finally {
    await env.close_all();
  }
});

test("a workflow that repeats the same step does not repeat the model call", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    set_script(env, [context_turn(), submit_turn(o.object_id, "합성"), FINISH]);
    const owner_ctx = env.ctx("workflow-step-1");
    const input = {
      owner_ctx,
      actor_id: env.ai_actor_id,
      stage_id: o.stage_id,
      round_id: o.round_id,
      max_output_tokens: 500,
    };
    const first = await env.exec.start(input);
    const calls = env.fake.calls.length;
    const rows = dispatches(env).length;
    const second = await env.exec.start(input);
    assert.equal(second.run_id, first.run_id, "the same request key gives the same run back");
    assert.equal(env.fake.calls.length, calls, "no new model call");
    assert.equal(dispatches(env).length, rows, "no new attempt");
    assert.equal(versions_of_run(env, first.run_id).length, 1, "and no second result");
  });
});

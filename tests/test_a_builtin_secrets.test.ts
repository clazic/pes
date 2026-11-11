// SEL-52 (PR19) the api key goes to the provider in one header and nowhere else: not the screen DTOs, logs,
// events, receipts, tables, stored blobs, prompts, error messages — and a provider that echoes it back in an
// error text does not put it there either. A key that is missing or removed stops the next call (closed).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FINISH,
  SYNTHETIC_KEY,
  assert_no_key,
  context_turn,
  dispatches,
  everything_stored,
  lease_state,
  next_key,
  open_stage,
  ready_project,
  reauth,
  rejects_one_of,
  run_row,
  set_script,
  start_outcome,
  start_run,
  submit_turn,
  with_a_env,
  type Format,
} from "./helpers/a_builtin_env.ts";

const FORMATS: Format[] = ["openai_compatible", "anthropic"];

for (const format of FORMATS) {
  test(`${format}: a whole run leaves the key only in the one auth header`, async () => {
    await with_a_env(format, async (env) => {
      const dto = await ready_project(env);
      const o = await open_stage(env, "plan");
      set_script(env, [context_turn(), submit_turn(o.object_id, "합성"), FINISH]);
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(res.status, "succeeded");

      // what PES sent: key only in the auth header, never in a body or a path
      for (const call of env.fake.all) {
        assert.equal(call.text.includes(SYNTHETIC_KEY), false, "no request body carries the key");
        assert.equal(call.path.includes(SYNTHETIC_KEY), false, "no url carries the key");
        const carriers = Object.entries(call.headers).filter(([, v]) => v.includes(SYNTHETIC_KEY)).map(([k]) => k);
        assert.deepEqual(carriers, [format === "anthropic" ? "x-api-key" : "authorization"]);
      }

      assert_no_key(JSON.stringify(res), "the executor result");
      assert_no_key(JSON.stringify(await env.conns.list(env.ctx(next_key(env)))), "the connection list");
      assert_no_key(JSON.stringify(dto), "the register result");
      assert_no_key(env.logs.join("\n"), "the log lines");
      assert_no_key(everything_stored(env), "any table row, event, receipt, or stored file");
      assert.deepEqual([...env.keys.keys.values()], [SYNTHETIC_KEY], "the key store still holds it");
    });
  });
}

test("a provider that echoes the key in an error text does not get it stored or logged", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    set_script(env, [
      { http: { status: 401, body: { error: { message: `Incorrect API key provided: ${SYNTHETIC_KEY}.`, type: "invalid_request_error", code: "invalid_api_key" } } } },
    ]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.ok(["failed", "blocked_usage"].includes(res.status), res.status);
    assert_no_key(JSON.stringify(res), "the executor result");
    assert_no_key(env.logs.join("\n"), "the log lines");
    assert_no_key(everything_stored(env), "any table row, event, receipt, or stored file");
    assert.equal(env.fake.calls.length, 1, "a rejected key is not retried");
  });
});

test("a refused start or a refused management call never repeats the key in its error", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const dto = await ready_project(env);
    const o = await open_stage(env, "plan");
    // wrong re-authentication with the key in the payload
    const err = await rejects_one_of(
      env.conns.update(env.ctx(next_key(env)), { reauth_code: "nope", connection_id: dto.connection_id, api_key: SYNTHETIC_KEY }),
      "forbidden",
    );
    assert_no_key(`${err.message} ${JSON.stringify(err.details ?? null)}`, "the error");
    // a raw command carrying the key is refused and does not quote it
    const raw = await rejects_one_of(
      env.service.execute(env.ctx(next_key(env)), "ai_connection.update", { connection_id: dto.connection_id, api_key: SYNTHETIC_KEY }),
      "invalid_payload",
    );
    assert_no_key(`${raw.message} ${JSON.stringify(raw.details ?? null)}`, "the error");
    assert_no_key(everything_stored(env), "any table row");
    void o;
  });
});

test("a key that is missing from the key store stops the start before any request", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    env.keys.keys.clear();
    const out = await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id });
    if (out.error !== null) assert.ok(["policy_denied", "conflict", "not_found"].includes(out.error.code), out.error.code);
    else assert.ok(["blocked_usage", "failed"].includes(out.result!.status));
    assert.equal(env.fake.all.length, 0 + env.fake.all.filter((r) => r.method === "GET").length, "no completion request");
    assert.equal(env.fake.calls.length, 0);
  });
});

test("removing the connection while a run is in flight stops the next call; the run is not left holding the lease", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const dto = await ready_project(env);
    const o = await open_stage(env, "plan");
    set_script(env, [context_turn(), submit_turn(o.object_id, "합성"), FINISH]);
    env.fake.on_call = async (n) => {
      if (n === 1) {
        await env.conns.remove(env.ctx(next_key(env)), { reauth_code: await reauth(env), connection_id: dto.connection_id });
      }
    };
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.notEqual(res.status, "succeeded");
    assert.equal(env.fake.calls.length, 1, "no second call without a key");
    assert.notEqual(run_row(env, res.run_id).status, "running");
    assert.notEqual(lease_state(env)?.state, "active");
    assert.equal(env.keys.keys.size, 0);
    for (const d of dispatches(env, res.run_id)) {
      assert.ok(!["prepared", "authorized"].includes(d.state), d.state);
    }
  });
});

// SEL-52 n7 (~/hc-work/pes/logs/SEL-52-r1-3.md): the MODEL LIST (GET models) and an ERROR BODY hold one huge run of
// base64 characters (1 / 5 / 7 MiB), both formats. Written BEFORE the fix.
//   model list: test() never throws; a key in the list -> ok false, no models handed on, a fixed code, nothing kept;
//     no key -> ok, or a refusal with a fixed code (never a raw exception); register / key change with a key -> refused
//     with 'conflict', nothing saved.
//   error body (HTTP 500): never a throw, never a success, one attempt, the call is not left 'sent'; a key in it is kept
//     nowhere.
// Own file: each file stays under 25 s.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FINISH,
  MODEL_A,
  dispatches,
  next_key,
  open_stage,
  ready_project,
  reauth,
  register_connection,
  run_row,
  set_script,
  start_run,
  with_a_env,
  type Format,
} from "./helpers/a_builtin_env.ts";
import { BIG_SHAPES, SIZES, assert_key_not_kept, run_timed } from "./helpers/a_big.ts";
import { count_rows, error_text } from "./helpers/a_leak.ts";

const FORMATS: Format[] = ["openai_compatible", "anthropic"];

for (const format of FORMATS) {
  for (const size of SIZES) {
    for (const shape of BIG_SHAPES) {
      const label = `${format} ${size.label} ${shape.label}`;

      test(`N7 ${format}: test() with a model id of ${size.label}, ${shape.label}`, { timeout: 25_000 }, async () => {
        await with_a_env(format, async (env) => {
          const dto = await register_connection(env);
          env.fake.models = [MODEL_A, shape.build(size.bytes)];
          const t0 = Date.now();
          let listing: Awaited<ReturnType<typeof env.conns.test>> | undefined;
          try {
            listing = await env.conns.test(env.ctx(next_key(env)), { reauth_code: await reauth(env), connection_id: dto.connection_id });
          } catch (error) {
            assert.fail(`${label}: test() threw instead of failing with a fixed code: ${error_text(error)}`);
          }
          assert.ok((Date.now() - t0) / 1000 < 10, `${label}: took too long`);
          if (shape.has_key) {
            assert.equal(listing.ok, false, `${label}: the connection test fails`);
            assert.deepEqual(listing.models, [], `${label}: no echoed id is handed on`);
          }
          if (!listing.ok) assert.match(String(listing.error_code), /^[a-z][a-z0-9_]*$/, `${label}: a fixed code`);
          assert_key_not_kept(env, undefined, label, listing);
        });
      });

      if (!shape.has_key) continue;

      test(`N7 ${format}: register with a model id of ${size.label}, ${shape.label} -> refused, nothing saved`, { timeout: 25_000 }, async () => {
        await with_a_env(format, async (env) => {
          env.fake.models = [MODEL_A, shape.build(size.bytes)];
          let thrown: unknown;
          try {
            await register_connection(env);
          } catch (error) {
            thrown = error;
          }
          assert.ok(thrown !== undefined, `${label}: the registration is refused`);
          assert.equal((thrown as { code?: string }).code, "conflict", `${label}: ${error_text(thrown).slice(0, 200)}`);
          assert.equal(count_rows(env, "ai_connections"), 0, "no connection row");
          assert.equal(env.keys.keys.size, 0, "no secret was stored for a refused registration");
          assert_key_not_kept(env, undefined, label, error_text(thrown));
        });
      });
    }

    for (const shape of BIG_SHAPES) {
      test(`N7 ${format}: HTTP 500 error body of ${size.label}, ${shape.label}`, { timeout: 25_000 }, async () => {
        await with_a_env(format, async (env) => {
          await ready_project(env);
          const o = await open_stage(env, "plan");
          const label = `${format} ${size.label} ${shape.label}`;
          const message = shape.build(size.bytes);
          const body = format === "anthropic" ? { type: "error", error: { type: "api_error", message } } : { error: { message, type: "api_error", code: "synthetic_code" } };
          set_script(env, [{ http: { status: 500, body } }, FINISH]);
          const { res } = await run_timed(label, () => start_run(env, { stage_id: o.stage_id, round_id: o.round_id }));
          assert.notEqual(res.status, "succeeded", `${label}: an error body is never a success`);
          assert.equal(env.fake.calls.length, 1, `${label}: one attempt, no next request`);
          // a 500 may end the run as failed (that is the normal handling); what must not happen is an orphan 'sent'
          for (const row of dispatches(env, res.run_id)) assert.notEqual(row.state, "sent", `${label}: the dispatch is left as 'sent'`);
          assert.notEqual(run_row(env, res.run_id).status, "running", label);
          if (shape.has_key) assert_key_not_kept(env, res, label);
        });
      });
    }
  }
}

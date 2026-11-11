// SEL-52 final review 3, N8: the MODEL LIST holds a pathological model id (20k chars), both formats. test() never
// throws and answers in time with a fixed code when it fails; a key behind the run -> ok false, no ids handed on,
// nothing kept; register / key change with a key -> refused with 'conflict', nothing saved. Written BEFORE the fix.

// SEL-76: no wall-clock limit on the whole run here (fake server, DB and CI load made it flaky on Windows). The
// run is only guarded against a hang (run_timed, test timeout); the scan time is judged in test_a_builtin_n8_scan_time.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";

import { MODEL_A, next_key, reauth, register_connection, with_a_env, type Format } from "./helpers/a_builtin_env.ts";
import { assert_key_not_kept } from "./helpers/a_big.ts";
import { count_rows, error_text } from "./helpers/a_leak.ts";
import { PATHOLOGIES, with_hidden_key, with_plain_key } from "./helpers/a_pathology.ts";

const FORMATS: Format[] = ["openai_compatible", "anthropic"];
const N = 20_000;

for (const format of FORMATS) {
  for (const p of PATHOLOGIES) {
    const shapes = [
      { name: "no key", id: p.build(N), has_key: false },
      { name: "key as \\u escapes behind it", id: with_hidden_key(p.build(N)), has_key: true },
      { name: "plain key behind it", id: with_plain_key(p.build(N)), has_key: true },
    ];
    for (const shape of shapes) {
      const label = `${format} ${p.label} ${shape.name}`;
      test(`N8 ${format}: test() with a model id of ${N}, ${p.label}, ${shape.name}`, { timeout: 25_000 }, async () => {
        await with_a_env(format, async (env) => {
          const dto = await register_connection(env);
          env.fake.models = [MODEL_A, shape.id];
          let listing: Awaited<ReturnType<typeof env.conns.test>> | undefined;
          try {
            listing = await env.conns.test(env.ctx(next_key(env)), { reauth_code: await reauth(env), connection_id: dto.connection_id });
          } catch (error) {
            assert.fail(`${label}: test() threw instead of failing with a fixed code: ${error_text(error)}`);
          }
          if (shape.has_key) {
            assert.equal(listing.ok, false, `${label}: the connection test fails`);
            assert.deepEqual(listing.models, [], `${label}: no echoed id is handed on`);
          }
          if (!listing.ok) assert.match(String(listing.error_code), /^[a-z][a-z0-9_]*$/, `${label}: a fixed code`);
          assert_key_not_kept(env, undefined, label, listing);
        });
      });

      if (!shape.has_key) continue;
      test(`N8 ${format}: register with a model id of ${N}, ${p.label}, ${shape.name} -> refused, nothing saved`, { timeout: 25_000 }, async () => {
        await with_a_env(format, async (env) => {
          env.fake.models = [MODEL_A, shape.id];
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
  }
}

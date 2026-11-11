// SEL-52 final review 3, N8: HUGE pathological answers (200k and 3M chars; 3M doubled by JSON stays under the 8 MiB
// body limit), both formats, answer text and tool argument. Same expectations as the small files, whole run in
// MAX_SECONDS (CI is slow; a square would take minutes). Written BEFORE the fix: with today's code these runs take
// minutes or hours - run with a shell timeout, a hang IS the failure. Own file.

import assert from "node:assert/strict";
import { test } from "node:test";

import { FINISH, open_stage, ready_project, set_script, start_run, with_a_env, type Format, type ScriptedTurn } from "./helpers/a_builtin_env.ts";
import { assert_held_unknown, assert_key_not_kept, assert_settled_not_sent, business_rows, run_timed } from "./helpers/a_big.ts";
import { MAX_HUGE_SECONDS, PATHOLOGIES, with_hidden_key } from "./helpers/a_pathology.ts";

const FORMATS: Format[] = ["openai_compatible", "anthropic"];
const SIZES = [200_000, 3_000_000];

function turn_with_argument(format: Format, text: string): ScriptedTurn {
  return format === "openai_compatible"
    ? { tools: [{ name: "decision.propose", args: { text: "x" } }], raw_arguments: [JSON.stringify({ text })] }
    : { tools: [{ name: "decision.propose", args: { text } }] };
}

for (const format of FORMATS) {
  for (const n of SIZES) {
    for (const p of PATHOLOGIES) {
      for (const surface of ["text", "argument"] as const) {
        for (const has_key of [false, true]) {
          if (has_key && n > 200_000 && surface === "argument") continue; // keep the file under 25 s once fixed
          const name = `${format} ${surface} ${n} ${p.label} ${has_key ? "key behind it" : "no key"}`;
          test(`N8 huge ${name}`, { timeout: 30_000 }, async () => {
            await with_a_env(format, async (env) => {
              await ready_project(env);
              const o = await open_stage(env, "plan");
              const before = business_rows(env);
              const body = has_key ? with_hidden_key(p.build(n)) : p.build(n);
              set_script(env, [surface === "text" ? { text: body } : turn_with_argument(format, body), FINISH]);
              const { res, seconds } = await run_timed(name, () => start_run(env, { stage_id: o.stage_id, round_id: o.round_id }));
            assert.ok(seconds < MAX_HUGE_SECONDS, `${name}: took ${seconds.toFixed(1)}s (limit ${MAX_HUGE_SECONDS}s)`);
              if (has_key) {
                assert_held_unknown(env, res, name);
                assert.deepEqual(business_rows(env), before, `${name}: no business command ran`);
                assert_key_not_kept(env, res, name);
              } else {
                assert_settled_not_sent(env, res, name);
              }
            });
          });
        }
      }
    }
  }
}

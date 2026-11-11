// SEL-52 final review 3, N8: a TOOL ARGUMENT is a pathological run (5k / 20k chars), both formats, whole executor run.
// No key: settled in time, never left 'sent' (not failed, not running). Key hidden behind the run (\u escapes or
// plain): unknown + blocked_usage, reservation kept, no business command, key kept nowhere. Written BEFORE the fix.
// Huge sizes (200k / 3M) live in test_a_builtin_n8_huge.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";

import { FINISH, open_stage, ready_project, set_script, start_run, with_a_env, type Format, type ScriptedTurn } from "./helpers/a_builtin_env.ts";
import { assert_held_unknown, assert_key_not_kept, assert_settled_not_sent, business_rows, run_timed } from "./helpers/a_big.ts";
import { MAX_SMALL_SECONDS, PATHOLOGIES, with_hidden_key, with_plain_key } from "./helpers/a_pathology.ts";

const FORMATS: Format[] = ["openai_compatible", "anthropic"];
const SIZES = [5_000, 20_000];

/** openai: the `arguments` STRING is sent as is (the text goes in as a JSON string value); anthropic: the `input` object */
function turn_with_argument(format: Format, text: string): ScriptedTurn {
  return format === "openai_compatible"
    ? { tools: [{ name: "decision.propose", args: { text: "x" } }], raw_arguments: [JSON.stringify({ text })] }
    : { tools: [{ name: "decision.propose", args: { text } }] };
}

for (const format of FORMATS) {
  for (const n of SIZES) {
    for (const p of PATHOLOGIES) {
      const shapes = [
        { name: "no key", text: p.build(n), has_key: false },
        { name: "key as \\u escapes behind it", text: with_hidden_key(p.build(n)), has_key: true },
        { name: "plain key behind it", text: with_plain_key(p.build(n)), has_key: true },
      ];
      for (const shape of shapes) {
        test(`N8 ${format}: tool argument ${n}, ${p.label}, ${shape.name}`, { timeout: 25_000 }, async () => {
          await with_a_env(format, async (env) => {
            await ready_project(env);
            const o = await open_stage(env, "plan");
            const before = business_rows(env);
            const label = `${format} ${n} ${p.label} ${shape.name}`;
            set_script(env, [turn_with_argument(format, shape.text), FINISH]);
            const { res, seconds } = await run_timed(label, () => start_run(env, { stage_id: o.stage_id, round_id: o.round_id }));
            assert.ok(seconds < MAX_SMALL_SECONDS, `${label}: took ${seconds.toFixed(1)}s (limit ${MAX_SMALL_SECONDS}s)`);
            if (shape.has_key) {
              assert_held_unknown(env, res, label);
              assert.deepEqual(business_rows(env), before, `${label}: no business command ran`);
              assert_key_not_kept(env, res, label);
            } else {
              assert_settled_not_sent(env, res, label);
            }
          });
        });
      }
    }
  }
}

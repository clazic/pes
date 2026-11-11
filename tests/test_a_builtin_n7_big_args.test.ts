// SEL-52 n7 (~/hc-work/pes/logs/SEL-52-r1-3.md): a TOOL ARGUMENT holds one huge run of base64 characters
// (1 / 5 / 7 MiB), both formats. openai: the `arguments` STRING (sent as is); anthropic: the `input` object.
// Written BEFORE the fix. Key present (or the check cannot finish) -> unknown + blocked_usage, one dispatch row
// 'unknown', reservation kept, no business command. No key -> never left 'sent', never a failed run, never a throw.
// Own file: each file stays under 25 s.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FINISH,
  open_stage,
  ready_project,
  set_script,
  start_run,
  with_a_env,
  type Format,
  type ScriptedTurn,
} from "./helpers/a_builtin_env.ts";
import { BIG_SHAPES, SIZES, assert_held_unknown, assert_key_not_kept, assert_settled_not_sent, business_rows, run_timed } from "./helpers/a_big.ts";

const FORMATS: Format[] = ["openai_compatible", "anthropic"];

function turn_with_argument(format: Format, text: string): ScriptedTurn {
  return format === "openai_compatible"
    ? { tools: [{ name: "decision.propose", args: { text: "x" } }], raw_arguments: [`{"text":"${text}"}`] }
    : { tools: [{ name: "decision.propose", args: { text } }] };
}

for (const format of FORMATS) {
  for (const size of SIZES) {
    for (const shape of BIG_SHAPES) {
      test(`N7 ${format}: tool argument, ${size.label}, ${shape.label}`, { timeout: 25_000 }, async () => {
        await with_a_env(format, async (env) => {
          await ready_project(env);
          const o = await open_stage(env, "plan");
          const before = business_rows(env);
          const label = `${format} ${size.label} ${shape.label}`;
          set_script(env, [turn_with_argument(format, shape.build(size.bytes)), FINISH]);
          const { res } = await run_timed(label, () => start_run(env, { stage_id: o.stage_id, round_id: o.round_id }));
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

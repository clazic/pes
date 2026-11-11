// SEL-52 n7 (~/hc-work/pes/logs/SEL-52-r1-3.md): the ANSWER TEXT holds one huge run of base64 characters
// (1 / 5 / 7 MiB, under the 8 MiB body limit), both formats. Written BEFORE the fix: 5 and 7 MiB throw a RangeError
// in the key check today. Key present (or the check cannot finish) -> unknown + blocked_usage, one dispatch row
// 'unknown', reservation kept, no business command. No key -> not blocked, or blocked but never left 'sent'.
// Never an exception, and each answer is read and settled in under MAX_SECONDS. Own file: each file stays under 25 s.

import assert from "node:assert/strict";
import { test } from "node:test";

import { FINISH, open_stage, ready_project, set_script, start_run, with_a_env, type Format } from "./helpers/a_builtin_env.ts";
import { BIG_SHAPES, SIZES, assert_held_unknown, assert_key_not_kept, assert_settled_not_sent, business_rows, run_timed } from "./helpers/a_big.ts";

const FORMATS: Format[] = ["openai_compatible", "anthropic"];

for (const format of FORMATS) {
  for (const size of SIZES) {
    for (const shape of BIG_SHAPES) {
      test(`N7 ${format}: answer text, ${size.label}, ${shape.label}`, { timeout: 25_000 }, async () => {
        await with_a_env(format, async (env) => {
          await ready_project(env);
          const o = await open_stage(env, "plan");
          const before = business_rows(env);
          const label = `${format} ${size.label} ${shape.label}`;
          set_script(env, [{ text: shape.build(size.bytes) }, FINISH]);
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

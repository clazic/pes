// SEL-52 final review 3, N8: the key check itself. A ~40 KB pathological text must be checked in well under a second,
// and doubling the input twice (x4) must not grow the time by a square (quadratic ~16x, linear ~4x). Written BEFORE
// the fix: `\\`.repeat(20000) already takes ~1.1 s today. Direct calls of reply_key_check: no server, no clock.

import assert from "node:assert/strict";
import { test } from "node:test";

import { reply_key_check } from "../scripts/pes_core/a_runtime/formats.ts";
import { SYNTHETIC_KEY } from "./helpers/a_builtin_env.ts";
import { PATHOLOGIES, with_hidden_key, with_plain_key } from "./helpers/a_pathology.ts";

const SMALL = 10_000;
const LARGE = 40_000;
/** absolute limit for the 40 KB input; the lead's aim is 100 ms, this leaves room for a slow Windows runner */
const ABSOLUTE_MS = 400;
/** linear is ~4, quadratic ~16; 9 leaves room for noise */
const MAX_RATIO = 9;
const FLOOR_MS = 8;

function best_of_three(go: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i += 1) {
    const t0 = process.hrtime.bigint();
    go();
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return best;
}

/** the answer body the way a provider sends it: the text inside a JSON string */
function check(text: string): () => string {
  const body = { id: "x", choices: [{ message: { role: "assistant", content: text } }] };
  const raw = JSON.stringify(body);
  return () => reply_key_check(SYNTHETIC_KEY, raw, body);
}

for (const pathology of PATHOLOGIES) {
  test(`N8 perf: ${pathology.label} - 40 KB checked fast, time grows about linearly`, () => {
    const small = best_of_three(check(pathology.build(SMALL)));
    const large = best_of_three(check(pathology.build(LARGE)));
    assert.ok(large < ABSOLUTE_MS, `${pathology.label}: ${LARGE} chars took ${large.toFixed(0)} ms (limit ${ABSOLUTE_MS} ms)`);
    const ratio = large / Math.max(small, FLOOR_MS);
    assert.ok(ratio < MAX_RATIO, `${pathology.label}: x4 input took x${ratio.toFixed(1)} the time (${small.toFixed(1)} -> ${large.toFixed(1)} ms): quadratic growth`);
  });

  test(`N8 perf: ${pathology.label} - a key hidden behind the run is still found (never 'none')`, () => {
    for (const [name, build] of [["\\u escapes", with_hidden_key], ["plain", with_plain_key]] as const) {
      const text = build(pathology.build(SMALL));
      const t0 = Date.now();
      const verdict = check(text)();
      assert.notEqual(verdict, "none", `${pathology.label} + ${name} key: the key was missed`);
      assert.ok(Date.now() - t0 < ABSOLUTE_MS, `${pathology.label} + ${name} key: too slow`);
    }
  });

  test(`N8 perf: ${pathology.label} - no key: the check answers (none or check_failed), never throws`, () => {
    assert.ok(["none", "check_failed"].includes(check(pathology.build(LARGE))()));
  });
}

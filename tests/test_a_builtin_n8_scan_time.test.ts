// SEL-76: the N8 time limits moved from whole executor runs (fake server, database, CI load: flaky on Windows) to the key
// scanner itself. For every surface the whole-run files cover (answer text, tool argument, model list) and every
// pathology, the scan alone is timed by CPU time (best of three, SEL-78): the 20k input stays under an absolute limit and x4 input
// does not take about x16 (a square). The huge sizes (200k, 3M) are judged by growth only. A deliberately quadratic
// scanner must FAIL the same meter (mutation check), so the meter cannot silently go blind.

import assert from "node:assert/strict";
import { test } from "node:test";

import { PATHOLOGIES, with_hidden_key } from "./helpers/a_pathology.ts";
import { assert_not_quadratic, best_ms, measure_growth, quadratic_scan, scan_answer_text, scan_model_list, scan_tool_argument } from "./helpers/a_scan_time.ts";

const SURFACES = [
  { name: "answer text", scan: scan_answer_text },
  { name: "tool argument", scan: scan_tool_argument },
  { name: "model list", scan: scan_model_list },
];
/** the whole-run files use 5k and 20k; the scan of 20k must be far under this (today: a few ms; room for a slow runner) */
const MAX_SCAN_MS = 400;

/** set by the first 20k failure: the huge cases then fail at once, without even the cheap gate */
let slow_scanner_seen: string | null = null;

for (const surface of SURFACES) {
  for (const p of PATHOLOGIES) {
    test(`N8 scan time: ${surface.name}, ${p.label} - 20k scanned fast, time grows about linearly`, () => {
      // once one case showed a slow scanner, the rest fail at once (each slow case would cost seconds)
      if (slow_scanner_seen !== null) assert.fail(`not measured, an earlier case already failed: ${slow_scanner_seen}`);
      const g = measure_growth(surface.scan, p.build, 5_000, 20_000);
      try {
        assert_not_quadratic(`${surface.name} ${p.label}`, g, MAX_SCAN_MS);
      } catch (error) {
        slow_scanner_seen ??= String(error);
        throw error;
      }
    });
  }
}

// the huge whole-run files (200k / 3M chars): the scan alone. Each case first runs the cheap 5k -> 20k gate itself: a
// scanner that has gone quadratic fails HERE at once, with the reason, instead of freezing the process for minutes at
// 800k (a synchronous loop cannot be cut by a test timeout). Then 200k -> 800k growth, then one 3M run under a loose limit.
const HUGE_SURFACES = [
  { name: "answer text", scan: scan_answer_text },
  { name: "tool argument", scan: scan_tool_argument },
];
const MAX_3M_MS = 10_000;

for (const surface of HUGE_SURFACES) {
  for (const p of PATHOLOGIES) {
    for (const has_key of [false, true]) {
      const build = (n: number) => (has_key ? with_hidden_key(p.build(n)) : p.build(n));
      test(`N8 scan time: huge ${surface.name}, ${p.label}, ${has_key ? "key hidden behind it" : "no key"} - linear to 800k, 3M under a loose limit`, () => {
        try {
          if (slow_scanner_seen !== null) throw new Error(slow_scanner_seen);
          assert_not_quadratic("gate (5k to 20k)", measure_growth(surface.scan, build, 5_000, 20_000), MAX_SCAN_MS);
        } catch (error) {
          slow_scanner_seen ??= String(error);
          assert.fail(`huge input NOT tried, the scanner already looks quadratic at 20k (a huge run would freeze for minutes): ${String(error)}`);
        }
        const g = measure_growth(surface.scan, build, 200_000, 800_000);
        assert_not_quadratic(`huge ${surface.name} ${p.label}`, g, 10_000);
        const text = build(3_000_000);
        const ms = best_ms(() => surface.scan(text), 1);
        assert.ok(ms < MAX_3M_MS, `3M chars took ${ms.toFixed(0)} ms (loose limit ${MAX_3M_MS} ms)`);
      });
    }
  }
}

test("N8 scan time: mutation - a quadratic scanner fails the meter", () => {
  const g = measure_growth(quadratic_scan, (n) => "\\".repeat(n), 4_000, 16_000);
  assert.ok(g.ratio >= 9, `the fake square scanner must look quadratic to the meter (ratio ${g.ratio.toFixed(1)})`);
  assert.throws(() => assert_not_quadratic("fake square", g, 1_000_000), /quadratic growth/);
});

test("N8 scan time: mutation - a slow linear scanner fails the absolute limit", () => {
  const slow = { small_ms: 100, large_ms: 450, ratio: 4.5 };
  assert.throws(() => assert_not_quadratic("fake slow", slow, MAX_SCAN_MS), /limit/);
});

test("N8 scan time: the real scanner passes the meter that the fake square fails (same input, same sizes)", () => {
  const real = measure_growth(scan_answer_text, (n) => "\\".repeat(n), 4_000, 16_000);
  assert_not_quadratic("real", real, MAX_SCAN_MS);
});

// SEL-78: a coarse OS clock (Windows, one tick ~15 ms) rounds a CPU reading down to whole ticks. Model it (tick_ms hook) and
// show the meter still catches a square and still passes the real scanner.
test("N8 scan time: mutation - on a 15 ms tick clock a quadratic scanner still fails the meter", () => {
  // 6k → 24k (not 4k → 16k): on a 15 ms tick the small run is only a few ticks, so rounding could pull a true ×16 under ×9
  // (windows-latest saw ×8.3, PR #58 run 43100106530). Bigger inputs keep the square well above the tick noise; the bar stays 9.
  const g = measure_growth(quadratic_scan, (n) => "\\".repeat(n), 6_000, 24_000, 3, 15);
  assert.ok(g.ratio >= 9, `the fake square scanner must look quadratic on a coarse clock (ratio ${g.ratio.toFixed(1)})`);
  assert.throws(() => assert_not_quadratic("fake square, coarse clock", g, 1_000_000), /quadratic growth/);
});

test("N8 scan time: on a 15 ms tick clock the real scanner still passes", () => {
  const real = measure_growth(scan_answer_text, (n) => "\\".repeat(n), 4_000, 16_000, 3, 15);
  assert_not_quadratic("real, coarse clock", real, MAX_SCAN_MS);
});

test("N8 scan time: a small scan is repeated until the reading is longer than a tick (never reads 0)", () => {
  const ms = best_ms(() => scan_answer_text("\\".repeat(200)), 3, 15);
  assert.ok(ms > 0, `a tiny scan read as ${ms} ms on a coarse clock`);
});

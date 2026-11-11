// SEL-76: the N8 time limits moved from whole executor runs (fake server, database, CI load: flaky on Windows) to the key
// scanner itself. For every surface the whole-run files cover (answer text, tool argument, model list) and every
// pathology, the scan alone is timed by hrtime (best of three): the 20k input stays under an absolute limit and x4 input
// does not take about x16 (a square). The huge sizes (200k, 3M) are judged by growth only. A deliberately quadratic
// scanner must FAIL the same meter (mutation check), so the meter cannot silently go blind.

import assert from "node:assert/strict";
import { test } from "node:test";

import { PATHOLOGIES, with_hidden_key } from "./helpers/a_pathology.ts";
import { assert_not_quadratic, measure_growth, quadratic_scan, scan_answer_text, scan_model_list, scan_tool_argument } from "./helpers/a_scan_time.ts";

const SURFACES = [
  { name: "answer text", scan: scan_answer_text },
  { name: "tool argument", scan: scan_tool_argument },
  { name: "model list", scan: scan_model_list },
];
/** the whole-run files use 5k and 20k; the scan of 20k must be far under this (today: a few ms; room for a slow runner) */
const MAX_SCAN_MS = 400;

for (const surface of SURFACES) {
  for (const p of PATHOLOGIES) {
    test(`N8 scan time: ${surface.name}, ${p.label} - 20k scanned fast, time grows about linearly`, () => {
      const g = measure_growth(surface.scan, p.build, 5_000, 20_000);
      assert_not_quadratic(`${surface.name} ${p.label}`, g, MAX_SCAN_MS);
    });
  }
}

// the huge whole-run files (200k / 3M chars): the scan alone, growth only (3M against 200k is x15 in size)
for (const p of PATHOLOGIES) {
  test(`N8 scan time: huge ${p.label} - 200k to 800k grows about linearly, key hidden behind it`, () => {
    const g = measure_growth(scan_answer_text, (n) => with_hidden_key(p.build(n)), 200_000, 800_000);
    assert_not_quadratic(`huge ${p.label}`, g, 10_000);
  });
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

// SEL-76: the N8 time limits judge the KEY SCANNER (reply_key_check), not a whole executor run. A whole run adds a fake
// server round trip, the database and CI load (Windows runner: 3.0 s against a 3 s limit although the scan took ms).
// Here only the scan is timed: best of a few runs by CPU time (SEL-78: not wall time), and growth is judged by a RATIO of a small and a 4x input
// (linear ~4, quadratic ~16). Synthetic only; no server, no clock other than process.cpuUsage, no path.

import assert from "node:assert/strict";

import { reply_key_check, type ModelReply } from "../../scripts/pes_core/a_runtime/formats.ts";
import { SYNTHETIC_KEY } from "./a_builtin_env.ts";

/** linear is ~4, quadratic ~16; 9 leaves room for noise */
export const MAX_RATIO = 9;
/** below this a time is noise, not growth (the ratio divides by at least this) */
export const FLOOR_MS = 8;

/**
 * best (smallest) CPU time of `runs` calls, in ms: process.cpuUsage() user + system.
 *
 * SEL-78: wall time lied under the load of a parallel `npm test`. A 5 ms scan fits in one scheduler slice, a 100 ms scan
 * is preempted again and again, so its wall time grew by the waiting, not by the work: a linear scanner showed x10..x15
 * (reproduced with 3 busy loops per core). CPU time counts only the work. Where the OS clock is coarse (Windows, one tick
 * ~15 ms) a reading is rounded to ticks, which the FLOOR_MS floor and the "lowest of several runs" absorb; a square
 * (x16) is far above that.
 */
export function best_ms(go: () => unknown, runs = 3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i += 1) {
    const before = process.cpuUsage();
    go();
    const used = process.cpuUsage(before);
    best = Math.min(best, (used.user + used.system) / 1000);
  }
  return best;
}

export interface Growth {
  small_ms: number;
  large_ms: number;
  ratio: number;
}

/**
 * time `scan` on `build(small)` and `build(large)`; the scan takes the text and does the whole check.
 *
 * SEL-78: under the load of a parallel `npm test` one slow run of the LARGE input (a preempted core, a GC pause) made a
 * linear scanner look like x12.8. Noise only ever makes a time longer, and a square grows on EVERY run, so a ratio at or
 * above MAX_RATIO is measured again (at most `attempts` times in all) and the LOWEST ratio seen counts, with the
 * lowest time of each size. A real quadratic scanner stays high on every attempt and still fails; a linear one passes
 * as soon as one attempt is undisturbed.
 */
export function measure_growth(
  scan: (text: string) => unknown,
  build: (n: number) => string,
  small: number,
  large: number,
  attempts = 3,
): Growth {
  const small_text = build(small);
  const large_text = build(large);
  let best: Growth | null = null;
  let small_min = Number.POSITIVE_INFINITY;
  let large_min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < attempts; i += 1) {
    small_min = Math.min(small_min, best_ms(() => scan(small_text)));
    large_min = Math.min(large_min, best_ms(() => scan(large_text)));
    const g: Growth = { small_ms: small_min, large_ms: large_min, ratio: large_min / Math.max(small_min, FLOOR_MS) };
    if (best === null || g.ratio < best.ratio) best = g;
    if (g.ratio < MAX_RATIO) break;
  }
  return best as Growth;
}

/** fails when the time grew by about a square (ratio) or the large input took longer than `max_large_ms` */
export function assert_not_quadratic(label: string, g: Growth, max_large_ms: number): void {
  assert.ok(g.ratio < MAX_RATIO, `${label}: x4 input took x${g.ratio.toFixed(1)} the time (${g.small_ms.toFixed(1)} -> ${g.large_ms.toFixed(1)} ms): quadratic growth`);
  assert.ok(g.large_ms < max_large_ms, `${label}: the scan took ${g.large_ms.toFixed(0)} ms (limit ${max_large_ms} ms)`);
}

/** the answer body the way a provider sends it, with `text` as the answer text */
export function scan_answer_text(text: string): string {
  const body = { id: "x", choices: [{ message: { role: "assistant", content: text } }] };
  return reply_key_check(SYNTHETIC_KEY, JSON.stringify(body), body);
}

/** the same, with `text` as a tool call argument: the raw body, the parsed body and the parsed reply PES acts on */
export function scan_tool_argument(text: string): string {
  const args = { text };
  const body = { id: "x", choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "decision_propose", arguments: JSON.stringify(args) } }] } }] };
  const reply: ModelReply = { text: null, calls: [{ id: "c1", name: "decision.propose", args }], usage: null, truncated: false };
  return reply_key_check(SYNTHETIC_KEY, JSON.stringify(body), body, reply);
}

/** the same, with `text` as a model id in the model list */
export function scan_model_list(text: string): string {
  const body = { data: [{ id: "model-a" }, { id: text }] };
  return reply_key_check(SYNTHETIC_KEY, JSON.stringify(body), body);
}

/**
 * A scanner made to be slow on purpose: it compares every character with every other one (time ~ n squared).
 * Used only to show that measure_growth + assert_not_quadratic really fail on a square.
 */
export function quadratic_scan(text: string): number {
  let hits = 0;
  for (let i = 0; i < text.length; i += 1) {
    const a = text.charCodeAt(i);
    for (let j = 0; j < text.length; j += 1) if (text.charCodeAt(j) === a) hits += 1;
  }
  return hits;
}

// SEL-52 final review 3 (~/hc-work/pes/logs/SEL-52-final-review-3.md, N8): answers whose text is a long run of
// characters that a backtracking pattern re-reads from every start (backslashes with no valid \uXXXX behind them,
// short \\u12 tails, %, =, \", mixed layers). Synthetic only: no real provider, key, keychain or money.
// Windows: no child process, no path comparison. Times are generous; growth is judged by a RATIO of two sizes.

import { SYNTHETIC_KEY } from "./a_builtin_env.ts";
import { uni } from "./a_leak.ts";

export interface Pathology {
  label: string;
  /** a text of about `n` characters */
  build: (n: number) => string;
}

function repeated(unit: string, n: number): string {
  return unit.repeat(Math.max(1, Math.ceil(n / unit.length))).slice(0, n);
}

// String.raw keeps every backslash exactly as written
export const PATHOLOGIES: Pathology[] = [
  { label: "backslashes only", build: (n) => "\\".repeat(n) },
  { label: "two backslashes + u12 short tail, repeated", build: (n) => repeated(String.raw`\\u12`, n) },
  { label: "backslash run, then a bad tail", build: (n) => "\\".repeat(n - 4) + "u12x" },
  { label: "percent signs", build: (n) => "%".repeat(n) },
  { label: "percent + one hex digit, repeated", build: (n) => repeated("%4", n) },
  { label: "equals padding only", build: (n) => "=".repeat(n) },
  { label: "escaped quotes (long JSON escapes)", build: (n) => repeated('\\"', n) },
  { label: "mixed layers: valid \\u0041, short tails, %, =, quotes", build: (n) => repeated(String.raw`\\A\\u12%%%4==\"` + "QUJD", n) },
];

/** the pathological text, then (after a space) the key spelled as \uXXXX escapes: a key a person could read back */
export function with_hidden_key(text: string): string {
  return `${text} ${uni(SYNTHETIC_KEY)}`;
}
export function with_plain_key(text: string): string {
  return `${text} ${SYNTHETIC_KEY}`;
}

/** the time one answer of up to 20k pathological characters may take, whole run (today's code: 1-8 s; fixed: well under 0.5 s) */
export const MAX_SMALL_SECONDS = 3;
/** the time for the huge answers (200k / 3M chars); a square would take minutes */
export const MAX_HUGE_SECONDS = 10;

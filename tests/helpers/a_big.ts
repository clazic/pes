// SEL-52 1st check of final review 2 (~/hc-work/pes/logs/SEL-52-r1-3.md, required N7): a provider answer that holds one
// huge run of base64-looking characters (1 MiB, 5 MiB, 7 MiB; the body limit is 8 MiB). The key check must not throw
// (a RangeError used to leave the call 'sent' and the run 'failed'); it either finds a key hidden in the run or it
// fails closed. Synthetic only: no real provider, key, keychain or money. No child process, no path comparison.

import assert from "node:assert/strict";

import { KEY_MIDDLE, SYNTHETIC_KEY, dispatches, everything_stored, run_row, type AEnv, type ExecResult } from "./a_builtin_env.ts";

const MIB = 1024 * 1024;
/** sizes of the one run: 1, 5 and 7 MiB (7 MiB plus a wrapper stays under the 8 MiB body limit) */
export const SIZES: Array<{ label: string; bytes: number }> = [
  { label: "1MiB", bytes: 1 * MIB },
  { label: "5MiB", bytes: 5 * MIB },
  { label: "7MiB", bytes: 7 * MIB },
];

/** the time one answer may take to be read, checked and settled (a run of the old regex took far longer or threw) */
export const MAX_SECONDS = 10;

/** `bytes` characters of valid base64 ("ABC" repeated; a multiple of 4 long) */
export function filler(bytes: number): string {
  return "QUJD".repeat(Math.floor(bytes / 4));
}

/** the key as base64; the key is 36 bytes (a multiple of 3), so there is no '=' and the text keeps one run */
export const KEY_B64 = Buffer.from(SYNTHETIC_KEY, "utf8").toString("base64");

export interface BigShape {
  label: string;
  /** the text of a given total size; `has_key` says whether it carries the key (in a form a person could read back) */
  build: (bytes: number) => string;
  has_key: boolean;
}

export const BIG_SHAPES: BigShape[] = [
  { label: "one run, no key", build: (n) => filler(n), has_key: false },
  {
    label: "the key as base64 INSIDE the one run (aligned)",
    build: (n) => filler(Math.floor(n / 8) * 4) + KEY_B64 + filler(Math.floor(n / 8) * 4),
    has_key: true,
  },
  {
    label: "the key as base64 right after the run, split by a space",
    build: (n) => `${filler(n)} ${KEY_B64}`,
    has_key: true,
  },
  {
    label: "the plain key right after the run",
    build: (n) => `${filler(n)} ${SYNTHETIC_KEY}`,
    has_key: true,
  },
];

/** only plain substring checks: a regex over a multi-megabyte text would be the very thing under test */
function light_key_forms(text: string): string[] {
  const forms: Array<[string, string]> = [
    ["the key", SYNTHETIC_KEY],
    ["a piece of the key", KEY_MIDDLE],
    ["base64 of the key", KEY_B64],
    ["base64 of a piece", Buffer.from(KEY_MIDDLE, "utf8").toString("base64")],
  ];
  return forms.filter(([, needle]) => text.includes(needle)).map(([name]) => name);
}

/** the key is in no table row, stored file, log line, executor result or request PES sent (plain checks only) */
export function assert_key_not_kept(env: AEnv, res: unknown, where: string, ...extra: unknown[]): void {
  const surfaces: Array<[string, string]> = [
    ["any table row or stored file", everything_stored(env)],
    ["the log lines", env.logs.join("\n")],
    ["the executor result", JSON.stringify(res ?? null)],
    ["what PES sent", env.fake.body_text_without_auth()],
    ...extra.map((value, i): [string, string] => [`extra value ${i + 1}`, typeof value === "string" ? value : JSON.stringify(value ?? null)]),
  ];
  for (const [name, text] of surfaces) assert.deepEqual(light_key_forms(text), [], `${where}: the api key must not appear in ${name}`);
}

/** run the executor once; it must come back with a result (not throw) within MAX_SECONDS */
export async function run_timed(label: string, go: () => Promise<ExecResult>): Promise<{ res: ExecResult; seconds: number }> {
  const t0 = Date.now();
  let res: ExecResult | undefined;
  try {
    res = await go();
  } catch (error) {
    assert.fail(`${label}: the executor threw instead of settling the call: ${String(error)}`);
  }
  const seconds = (Date.now() - t0) / 1000;
  assert.ok(seconds < MAX_SECONDS, `${label}: took ${seconds.toFixed(1)}s (limit ${MAX_SECONDS}s)`);
  return { res, seconds };
}

/** the answer carried the key (or could not be checked): unknown + blocked_usage, reservation kept, nothing more sent */
export function assert_held_unknown(env: AEnv, res: ExecResult, label: string): void {
  assert.equal(res.status, "blocked_usage", `${label}: the run is held for a person`);
  assert.equal(res.block_reason, "usage_unknown", label);
  assert.equal(run_row(env, res.run_id).status, "blocked_usage", label);
  assert.equal(env.fake.calls.length, 1, `${label}: no next request was built from the answer`);
  const rows = dispatches(env, res.run_id);
  assert.equal(rows.length, 1, label);
  assert.equal(rows[0]!.state, "unknown", `${label}: the call is kept as unknown for a person to settle`);
  const allowance = env.db.get<{ allowance_json: string | null }>("SELECT allowance_json FROM outbound_dispatches WHERE id = ?", rows[0]!.id);
  assert.ok(allowance?.allowance_json?.includes("reservation"), `${label}: the reservation stays`);
}

/** a harmless answer (no key): never left as an orphan 'sent', never a failed or still-running run */
export function assert_settled_not_sent(env: AEnv, res: ExecResult, label: string): void {
  for (const row of dispatches(env, res.run_id)) assert.notEqual(row.state, "sent", `${label}: a dispatch is left as 'sent'`);
  assert.notEqual(res.status, "failed", `${label}: the run is not failed`);
  const status = run_row(env, res.run_id).status;
  assert.notEqual(status, "failed", label);
  assert.notEqual(status, "running", label);
}

/** business tables that a held answer must leave alone */
export function business_rows(env: AEnv): number[] {
  return ["objects", "object_versions", "question_sets"].map((t) => Number(env.db.get<{ n: bigint }>(`SELECT count(*) AS n FROM ${t}`)?.n ?? 0n));
}

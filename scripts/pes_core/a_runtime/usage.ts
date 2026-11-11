// Usage and cost protection of the built-in runner (stage 2 PR19). Reads only; nothing is written here.
//
// Two kinds of connection, two rules (decision 0019):
//   * subscription  - PES counts the tokens of its own calls in three rolling windows (5 hours, 7 days, 30 days)
//                     and compares them with the limits the person entered. A call is allowed only when the
//                     tokens already used plus the reservation for THIS call stay at or under stop_percent of the
//                     limit in every window. The provider's own usage API is not used (none is documented for
//                     these plans); PES only knows its own calls.
//   * pay_per_use   - cost = tokens x the person-entered price. A call is allowed only when everything already
//                     spent on the connection plus the cost of the reservation stays at or under the cost cap.
//                     The cap is cumulative; a missing price never means 0 (the run does not start).
//
// The reservation of a call is its estimated input tokens plus its full max output tokens. An attempt whose
// outcome is unknown, or whose executor died, keeps counting - in every window, however much time passes - until
// a person settles it: "not charged" drops it, "charged" makes it count like an answered call (by the time it was
// sent). With no stored usage it counts with its reservation, never as 0.
//
// A subscription connection is also used only while a person's "extra charge is OFF" confirmation for it is valid
// (ai_extra_charge_off_confirmations: which account, when, until when) AND a usage baseline exists
// (ai_usage_baselines: the account's tokens used, as read from the provider, at a moment). No confirmation, an
// expired one, no baseline, or a reply on the connection since the confirmation that said the call was charged
// (or said something about billing PES cannot read) stops every call: reason extra_usage_off. Such a reply keeps
// voiding the confirmation however a person later settles that call (charged or not charged): the account itself
// has to be looked at again. Records made before a change of the key or the address do not count (credential_rev).
// The baseline counts
// as usage at its recording time in every window that still contains it; PES's own earlier calls are part of it.

import type { Db } from "../db.ts";
import { ApiError } from "../errors.ts";
import { WINDOW_MS, cost_micros } from "./spec.ts";

type ReadDb = Pick<Db, "get" | "all">;

export type BlockReason = "usage_limit" | "cost_cap" | "extra_usage_off";

export type Verdict = { ok: true } | { ok: false; reason: BlockReason; reset_at: number | null };

export interface RunSettings {
  run_id: string;
  project_id: string;
  connection_id: string;
  model: string;
  request_format: string;
  billing: "subscription" | "pay_per_use";
  stop_percent: number | null;
  price_currency: string | null;
  price_input: number | null;
  price_output: number | null;
}

export interface ConnectionFacts {
  id: string;
  name: string;
  kind: string;
  request_format: string;
  base_url: string;
  billing: "subscription" | "pay_per_use";
  key_ref: string;
  /** the last 4 characters of the key the database expects in the key store (always set when read from the database) */
  key_last4?: string;
  /** goes up by one whenever the key or the address changes (records made for an earlier one do not count) */
  credential_rev?: number;
  stop_percent: number | null;
  limits: { five_hour_tokens: number; weekly_tokens: number; monthly_tokens: number } | null;
  cap: { currency: string; amount_micros: number } | null;
  removed: boolean;
}

interface SettingsRow {
  run_id: string;
  project_id: string;
  connection_id: string;
  model: string;
  request_format: string;
  billing: "subscription" | "pay_per_use";
  stop_percent: bigint | null;
  price_currency: string | null;
  price_input_per_mtok_micros: bigint | null;
  price_output_per_mtok_micros: bigint | null;
}

const num = (value: bigint | null): number | null => (value === null ? null : Number(value));

export function read_run_settings(db: ReadDb, run_id: string): RunSettings | undefined {
  const row = db.get<SettingsRow>(
    `SELECT run_id, project_id, connection_id, model, request_format, billing, stop_percent, price_currency,
            price_input_per_mtok_micros, price_output_per_mtok_micros
       FROM ai_run_settings WHERE run_id = ?`,
    run_id,
  );
  if (row === undefined) return undefined;
  return {
    run_id: row.run_id,
    project_id: row.project_id,
    connection_id: row.connection_id,
    model: row.model,
    request_format: row.request_format,
    billing: row.billing,
    stop_percent: num(row.stop_percent),
    price_currency: row.price_currency,
    price_input: num(row.price_input_per_mtok_micros),
    price_output: num(row.price_output_per_mtok_micros),
  };
}

interface ConnectionRow {
  id: string;
  name: string;
  kind: string;
  request_format: string;
  base_url: string;
  billing: "subscription" | "pay_per_use";
  key_ref: string;
  key_last4: string;
  credential_rev: bigint;
  stop_percent: bigint | null;
  limit_five_hour_tokens: bigint | null;
  limit_weekly_tokens: bigint | null;
  limit_monthly_tokens: bigint | null;
  cost_cap_currency: string | null;
  cost_cap_micros: bigint | null;
  removed_at: bigint | null;
}

export function read_connection_facts(db: ReadDb, connection_id: string): ConnectionFacts | undefined {
  const row = db.get<ConnectionRow>(
    `SELECT id, name, kind, request_format, base_url, billing, key_ref, key_last4, credential_rev, stop_percent, limit_five_hour_tokens, limit_weekly_tokens,
            limit_monthly_tokens, cost_cap_currency, cost_cap_micros, removed_at
       FROM ai_connections WHERE id = ?`,
    connection_id,
  );
  if (row === undefined) return undefined;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    request_format: row.request_format,
    base_url: row.base_url,
    billing: row.billing,
    key_ref: row.key_ref,
    key_last4: row.key_last4,
    credential_rev: Number(row.credential_rev),
    stop_percent: num(row.stop_percent),
    limits:
      row.limit_five_hour_tokens === null || row.limit_weekly_tokens === null || row.limit_monthly_tokens === null
        ? null
        : {
            five_hour_tokens: Number(row.limit_five_hour_tokens),
            weekly_tokens: Number(row.limit_weekly_tokens),
            monthly_tokens: Number(row.limit_monthly_tokens),
          },
    cap:
      row.cost_cap_currency === null || row.cost_cap_micros === null
        ? null
        : { currency: row.cost_cap_currency, amount_micros: Number(row.cost_cap_micros) },
    removed: row.removed_at !== null,
  };
}

/**
 * The settings a run created now would get (used to refuse a start before any run exists). A pay-per-use
 * connection with no price for the model, or a price in another currency than its cap, is refused here.
 */
export function current_run_settings(db: ReadDb, connection: ConnectionFacts, model: string): RunSettings {
  const base: RunSettings = {
    run_id: "",
    project_id: "",
    connection_id: connection.id,
    model,
    request_format: connection.request_format,
    billing: connection.billing,
    stop_percent: connection.stop_percent,
    price_currency: null,
    price_input: null,
    price_output: null,
  };
  if (connection.billing === "subscription") return base;
  const price = db.get<{ currency: string; input_per_mtok_micros: bigint; output_per_mtok_micros: bigint }>(
    `SELECT currency, input_per_mtok_micros, output_per_mtok_micros FROM ai_connection_prices
      WHERE connection_id = ? AND model = ? ORDER BY rowid DESC LIMIT 1`,
    connection.id,
    model,
  );
  if (price === undefined) throw new ApiError("conflict", "no price is entered for this model");
  if (connection.cap === null || price.currency !== connection.cap.currency) {
    throw new ApiError("conflict", "the price and the cost cap use different currencies");
  }
  return {
    ...base,
    price_currency: price.currency,
    price_input: Number(price.input_per_mtok_micros),
    price_output: Number(price.output_per_mtok_micros),
  };
}

interface CountedRow {
  sent_at: bigint | null;
  state: string;
  /** A person's note on the call ("not_charged" rows are never selected). */
  outcome: string | null;
  allowance_json: string | null;
  usage_json: string | null;
  cost_json: string | null;
  price_input: bigint | null;
  price_output: bigint | null;
}

/**
 * Every call of the connection that may have used tokens or money: answered calls, calls still in flight, and
 * calls whose outcome is unknown or abandoned (prepared / authorized / sent with a dead executor) that no person
 * has settled as "not charged". Failed, blocked and never-sent attempts used nothing. Calls no person has settled
 * are selected whatever their age; answered calls and calls settled as "charged" only inside the longest window.
 */
function counted_rows(db: ReadDb, connection_id: string, since: number): CountedRow[] {
  return db.all<CountedRow>(
    `SELECT COALESCE(d.sent_at, d.unknown_at, x.resolved_at) AS sent_at, d.state AS state, x.outcome AS outcome,
            d.allowance_json AS allowance_json, d.usage_json AS usage_json, d.cost_json AS cost_json,
            s.price_input_per_mtok_micros AS price_input, s.price_output_per_mtok_micros AS price_output
       FROM outbound_dispatches d
       JOIN ai_run_settings s ON s.project_id = d.project_id AND s.run_id = d.run_id
       LEFT JOIN dispatch_resolutions x ON x.dispatch_id = d.id
      WHERE s.connection_id = ?
        AND (
              (d.state IN ('prepared', 'authorized', 'sent') AND x.dispatch_id IS NULL)
           OR (d.state IN ('prepared', 'authorized', 'sent', 'unknown') AND x.outcome = 'charged'
               AND COALESCE(d.sent_at, d.unknown_at, x.resolved_at) >= ?)
           OR (d.state = 'unknown' AND x.dispatch_id IS NULL)
           OR (d.state IN ('response', 'adopted') AND d.sent_at IS NOT NULL AND d.sent_at >= ?)
        )
      ORDER BY d.rowid`,
    connection_id,
    since,
    since,
  );
}

/**
 * A call no person has settled yet - still in flight, abandoned, or unknown. It counts in every window whatever
 * its age, and the passing of time frees nothing of it.
 */
function held(row: CountedRow): boolean {
  return (row.state === "prepared" || row.state === "authorized" || row.state === "sent" || row.state === "unknown") && row.outcome === null;
}

export interface SubscriptionGuard {
  confirmation_id: string;
  account_scope: string;
  confirmed_at: number;
  valid_until: number;
  /** the newest usage baseline: the account's tokens used, as a person read them, at recorded_at */
  baseline: { baseline_id: string; used_tokens: number; recorded_at: number };
}

/**
 * The newest "extra charge is OFF" confirmation and the newest usage baseline of a connection, when both exist
 * AND both were made for the connection's current key and address (its credential_rev): a change of the key or
 * of the address may mean another account or another service, so the records made before it do not count - not
 * even when the change and the records happen within the same millisecond.
 */
export function latest_subscription_guard(db: ReadDb, connection_id: string): SubscriptionGuard | undefined {
  const confirmation = db.get<{ id: string; account_scope: string; confirmed_at: bigint; valid_until: bigint }>(
    `SELECT id, account_scope, confirmed_at, valid_until FROM ai_extra_charge_off_confirmations
      WHERE connection_id = ? AND credential_rev = (SELECT credential_rev FROM ai_connections WHERE id = ?)
      ORDER BY rowid DESC LIMIT 1`,
    connection_id,
    connection_id,
  );
  const baseline = db.get<{ id: string; used_tokens: bigint; recorded_at: bigint }>(
    `SELECT id, used_tokens, recorded_at FROM ai_usage_baselines
      WHERE connection_id = ? AND credential_rev = (SELECT credential_rev FROM ai_connections WHERE id = ?)
      ORDER BY rowid DESC LIMIT 1`,
    connection_id,
    connection_id,
  );
  if (confirmation === undefined || baseline === undefined) return undefined;
  return {
    confirmation_id: confirmation.id,
    account_scope: confirmation.account_scope,
    confirmed_at: Number(confirmation.confirmed_at),
    valid_until: Number(confirmation.valid_until),
    baseline: { baseline_id: baseline.id, used_tokens: Number(baseline.used_tokens), recorded_at: Number(baseline.recorded_at) },
  };
}

/** A reply on the connection, at or after `since`, that said the call was charged or that PES could not read. */
function charge_seen_since(db: ReadDb, connection_id: string, since: number): boolean {
  return (
    db.get<{ ok: bigint }>(
      `SELECT 1 AS ok
         FROM outbound_dispatches d
         JOIN ai_run_settings s ON s.project_id = d.project_id AND s.run_id = d.run_id
        WHERE s.connection_id = ? AND d.billing_source IN ('pay_per_use', 'unrecognized')
          AND COALESCE(d.response_at, d.sent_at) >= ?
        LIMIT 1`,
      connection_id,
      since,
    ) !== undefined
  );
}

/**
 * The subscription connection's guard when it is good right now: a confirmation that has not run out, a baseline,
 * and no reply since the confirmation that said the call was charged. null otherwise (also when unreadable).
 */
export function valid_subscription_guard(db: ReadDb, connection_id: string, now_ms: number): SubscriptionGuard | null {
  let guard: SubscriptionGuard | undefined;
  try {
    guard = latest_subscription_guard(db, connection_id);
  } catch {
    // a confirmation that cannot be read is no confirmation
    return null;
  }
  if (guard === undefined || !(now_ms < guard.valid_until) || now_ms < guard.confirmed_at || now_ms < guard.baseline.recorded_at) return null;
  if (charge_seen_since(db, connection_id, guard.confirmed_at)) return null;
  return guard;
}

function reserved_usage(row: CountedRow): { input_tokens: number; output_tokens: number } {
  if (row.allowance_json === null) return { input_tokens: 0, output_tokens: 0 };
  const parsed = JSON.parse(row.allowance_json) as { reservation?: { input_tokens?: number; output_tokens?: number } };
  return { input_tokens: parsed.reservation?.input_tokens ?? 0, output_tokens: parsed.reservation?.output_tokens ?? 0 };
}

/** The usage stored with the call, or, when none was stored (never 0), the reservation made for it. */
function usage_of(row: CountedRow): { input_tokens?: number; output_tokens?: number } {
  return row.usage_json !== null ? (JSON.parse(row.usage_json) as { input_tokens?: number; output_tokens?: number }) : reserved_usage(row);
}

function tokens_of(row: CountedRow): number {
  const usage = usage_of(row);
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
}

/** cost_micros that never throws: a cost that does not fit is "more than any cap". */
function safe_cost(input: number, output: number, price_in: number, price_out: number): number {
  try {
    return cost_micros(input, output, price_in, price_out);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export interface Reservation {
  input_tokens: number;
  output_tokens: number;
}

/**
 * Would one more call stay under the line? `reset_at` of a refusal is the first moment the oldest counted calls
 * have rolled out of the blocking window(s) far enough, or null when that will not happen by itself.
 */
export function usage_gate(
  db: ReadDb,
  settings: RunSettings,
  connection: ConnectionFacts,
  now_ms: number,
  reservation: Reservation,
): Verdict {
  if (settings.billing === "subscription") {
    const limits = connection.limits;
    if (limits === null || settings.stop_percent === null) return { ok: false, reason: "usage_limit", reset_at: null };
    const guard = valid_subscription_guard(db, connection.id, now_ms);
    if (guard === null) return { ok: false, reason: "extra_usage_off", reset_at: null };
    const reserve = reservation.input_tokens + reservation.output_tokens;
    const baseline = guard.baseline;
    const windows = [
      { length: WINDOW_MS.five_hour, limit: limits.five_hour_tokens },
      { length: WINDOW_MS.weekly, limit: limits.weekly_tokens },
      { length: WINDOW_MS.monthly, limit: limits.monthly_tokens },
    ];
    const rows = counted_rows(db, connection.id, now_ms - WINDOW_MS.monthly);
    const held_tokens = rows.filter(held).reduce((sum, row) => sum + tokens_of(row), 0);
    let refused = false;
    let reset: number | null = now_ms;
    for (const window of windows) {
      const threshold = Math.floor((window.limit * settings.stop_percent) / 100);
      const start = now_ms - window.length;
      // the baseline is the account's usage at its observation time: PES's own earlier calls are part of it
      const baseline_inside = baseline.recorded_at > start;
      const timed: Array<{ at: number; tokens: number }> = [];
      for (const row of rows) {
        if (held(row) || row.sent_at === null) continue;
        const at = Number(row.sent_at);
        // a call at the same moment as the baseline is counted on top of it (too much rather than too little)
        if (at <= start || (baseline_inside && at < baseline.recorded_at)) continue;
        timed.push({ at, tokens: tokens_of(row) });
      }
      if (baseline_inside && baseline.used_tokens > 0) timed.push({ at: baseline.recorded_at, tokens: baseline.used_tokens });
      timed.sort((a, b) => a.at - b.at);
      let used = held_tokens + timed.reduce((sum, entry) => sum + entry.tokens, 0);
      if (used + reserve <= threshold) continue;
      refused = true;
      // calls nobody has settled free nothing by the passing of time; only the timed usage rolls out
      let free_at: number | null = null;
      for (const entry of timed) {
        used -= entry.tokens;
        if (used + reserve <= threshold) {
          free_at = entry.at + window.length;
          break;
        }
      }
      reset = free_at === null || reset === null ? null : Math.max(reset, free_at);
    }
    return refused ? { ok: false, reason: "usage_limit", reset_at: reset } : { ok: true };
  }

  const cap = connection.cap;
  if (
    cap === null ||
    settings.price_input === null ||
    settings.price_output === null ||
    settings.price_currency !== cap.currency
  ) {
    return { ok: false, reason: "cost_cap", reset_at: null };
  }
  let spent = 0;
  for (const row of counted_rows(db, connection.id, 0)) {
    if (row.cost_json !== null) {
      const cost = JSON.parse(row.cost_json) as { currency?: string; amount_micros?: number };
      if (cost.currency !== cap.currency || typeof cost.amount_micros !== "number") {
        return { ok: false, reason: "cost_cap", reset_at: null };
      }
      spent += cost.amount_micros;
    } else if (row.price_input !== null && row.price_output !== null) {
      const usage = usage_of(row);
      spent += safe_cost(usage.input_tokens ?? 0, usage.output_tokens ?? 0, Number(row.price_input), Number(row.price_output));
    }
  }
  const reserved = safe_cost(reservation.input_tokens, reservation.output_tokens, settings.price_input, settings.price_output);
  return spent + reserved <= cap.amount_micros ? { ok: true } : { ok: false, reason: "cost_cap", reset_at: null };
}

/**
 * Dispatches of a run whose outcome nobody has settled: prepared / authorized / sent but never answered (the
 * executor died), or unknown, and in every case not settled by a person.
 */
export function unsettled_dispatches(db: ReadDb, project_id: string, run_id: string): string[] {
  return db
    .all<{ id: string }>(
      `SELECT d.id AS id
         FROM outbound_dispatches d
         LEFT JOIN dispatch_resolutions x ON x.dispatch_id = d.id
        WHERE d.project_id = ? AND d.run_id = ?
          AND d.state IN ('prepared', 'authorized', 'sent', 'unknown') AND x.dispatch_id IS NULL
        ORDER BY d.rowid`,
      project_id,
      run_id,
    )
    .map((row) => row.id);
}

// Shared, pure rules for AI connections (stage 2 PR19). No database, no network, no clock.
//
// The command definitions (commands/ai.ts), the connection facade (connections.ts) and the executor (loop.ts)
// all read their rules from here, so "what a valid connection is" has one spelling. Nothing in this file
// ever sees an api key.

import { ApiError } from "../errors.ts";

export const CONNECTION_KINDS = ["subscription_api", "openai_compatible", "anthropic", "google", "custom"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

/** The request formats a connection can speak. `google` is stored but has no executor (docs/adapters/a-builtin.md). */
export type RequestFormat = "openai_compatible" | "anthropic" | "google";

export type Billing = "subscription" | "pay_per_use";

export const BILLINGS: readonly Billing[] = ["subscription", "pay_per_use"];

/** The provider value of a built-in run's dispatches. */
export const AI_PROVIDER = "ai_connection";
/** The runtime value of a built-in run. */
export const BUILTIN_RUNTIME = "pes_builtin";

export const DEFAULT_STOP_PERCENT = 90;
export const MIN_STOP_PERCENT = 50;
export const MAX_STOP_PERCENT = 100;

/** Rolling usage windows of a subscription connection (leader decision: 5 hours / 7 days / 30 days). */
export const WINDOW_MS = Object.freeze({
  five_hour: 5 * 3_600_000,
  weekly: 7 * 24 * 3_600_000,
  monthly: 30 * 24 * 3_600_000,
});

/** A single-use re-authentication code lives this long. */
export const REAUTH_TTL_MS = 5 * 60_000;

const NAME_MAX = 120;
const URL_MAX = 500;
const CURRENCY = /^[A-Za-z0-9_-]{1,12}$/;
const MODEL_MAX = 200;
const MAX_MICROS = Number.MAX_SAFE_INTEGER;

export interface SubscriptionLimits {
  five_hour_tokens: number;
  weekly_tokens: number;
  monthly_tokens: number;
}

export interface CostCap {
  currency: string;
  amount_micros: number;
}

export function request_format_of(kind: ConnectionKind): RequestFormat {
  switch (kind) {
    case "anthropic":
      return "anthropic";
    case "google":
      return "google";
    default:
      return "openai_compatible";
  }
}

/** Only these formats have an executor. */
export function is_supported_format(format: string): boolean {
  return format === "openai_compatible" || format === "anthropic";
}

function bad(message: string): never {
  throw new ApiError("invalid_payload", message);
}

export function is_plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function text_field(input: Record<string, unknown>, field: string, max: number): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim().length === 0 || !value.isWellFormed()) {
    return bad(`${field} must be a non-empty string`);
  }
  if (value.length > max) return bad(`${field} is too long`);
  return value;
}

export function parse_name(input: Record<string, unknown>): string {
  return text_field(input, "name", NAME_MAX).trim();
}

export function parse_model(input: Record<string, unknown>, field = "model"): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim().length === 0 || !value.isWellFormed()) {
    return bad(`${field} must be a non-empty string`);
  }
  if (value.length > MODEL_MAX || /[\u0000-\u001f\u007f]/.test(value)) return bad(`${field} is not a valid model id`);
  return value;
}

export function parse_kind(input: Record<string, unknown>): ConnectionKind {
  const value = input["kind"];
  if (typeof value !== "string" || !(CONNECTION_KINDS as readonly string[]).includes(value)) {
    return bad(`kind must be one of ${CONNECTION_KINDS.join(", ")}`);
  }
  return value as ConnectionKind;
}

export function parse_billing(input: Record<string, unknown>): Billing {
  const value = input["billing"];
  if (value !== "subscription" && value !== "pay_per_use") {
    return bad('billing must be "subscription" or "pay_per_use"');
  }
  return value;
}

function is_loopback_host(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1" || h.endsWith(".localhost");
}

/**
 * The base URL a user types. https anywhere, http only for this machine (a local model). No credentials,
 * query or fragment in it: a key never travels in a URL. Returned without a trailing slash.
 */
export function parse_base_url(input: Record<string, unknown>): string {
  const raw = text_field(input, "base_url", URL_MAX).trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return bad("base_url must be an absolute http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return bad("base_url must be an http(s) URL");
  if (url.protocol === "http:" && !is_loopback_host(url.hostname)) {
    return bad("base_url must use https unless it points at this machine");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return bad("base_url must not carry credentials, a query or a fragment");
  }
  return raw.replace(/\/+$/, "");
}

function safe_positive(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return bad(`${field} must be a positive integer`);
  }
  return value;
}

export function parse_stop_percent(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < MIN_STOP_PERCENT || value > MAX_STOP_PERCENT) {
    return bad(`stop_percent must be an integer between ${MIN_STOP_PERCENT} and ${MAX_STOP_PERCENT}`);
  }
  return value;
}

export function parse_limits(value: unknown): SubscriptionLimits {
  if (!is_plain(value)) return bad("subscription_limits must be an object");
  const known = ["five_hour_tokens", "weekly_tokens", "monthly_tokens"];
  for (const key of Object.keys(value)) if (!known.includes(key)) return bad(`unknown field: subscription_limits.${key}`);
  return {
    five_hour_tokens: safe_positive(value["five_hour_tokens"], "subscription_limits.five_hour_tokens"),
    weekly_tokens: safe_positive(value["weekly_tokens"], "subscription_limits.weekly_tokens"),
    monthly_tokens: safe_positive(value["monthly_tokens"], "subscription_limits.monthly_tokens"),
  };
}

export function parse_currency(value: unknown, field = "currency"): string {
  if (typeof value !== "string" || !CURRENCY.test(value)) return bad(`${field} must be a short currency code`);
  return value;
}

export function parse_cap(value: unknown): CostCap {
  if (!is_plain(value)) return bad("cost_cap must be an object");
  for (const key of Object.keys(value)) {
    if (key !== "currency" && key !== "amount_micros") return bad(`unknown field: cost_cap.${key}`);
  }
  const amount = value["amount_micros"];
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 1) {
    return bad("cost_cap.amount_micros must be a positive integer");
  }
  return { currency: parse_currency(value["currency"], "cost_cap.currency"), amount_micros: amount };
}

export function parse_price_micros(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_MICROS) {
    return bad(`${field} must be a non-negative integer`);
  }
  return value;
}

export interface BillingRules {
  billing: Billing;
  stop_percent: number | null;
  limits: SubscriptionLimits | null;
  cap: CostCap | null;
}

/**
 * Billing-dependent fields of a new connection. A pay-per-use connection without a cost cap is refused; a
 * subscription connection without its three limits is refused (an unknown limit never starts a run).
 */
export function parse_billing_rules(input: Record<string, unknown>): BillingRules {
  const billing = parse_billing(input);
  if (billing === "subscription") {
    if (input["cost_cap"] !== undefined && input["cost_cap"] !== null) return bad("cost_cap belongs to pay_per_use");
    if (input["subscription_limits"] === undefined || input["subscription_limits"] === null) {
      return bad("a subscription connection needs subscription_limits");
    }
    return {
      billing,
      stop_percent: input["stop_percent"] === undefined ? DEFAULT_STOP_PERCENT : parse_stop_percent(input["stop_percent"]),
      limits: parse_limits(input["subscription_limits"]),
      cap: null,
    };
  }
  if (input["subscription_limits"] !== undefined && input["subscription_limits"] !== null) {
    return bad("subscription_limits belongs to subscription billing");
  }
  if (input["stop_percent"] !== undefined) return bad("stop_percent belongs to subscription billing");
  if (input["cost_cap"] === undefined || input["cost_cap"] === null) return bad("a pay_per_use connection needs a cost_cap");
  return { billing, stop_percent: null, limits: null, cap: parse_cap(input["cost_cap"]) };
}

export function parse_connection_id(input: Record<string, unknown>): string {
  const value = input["connection_id"];
  if (typeof value !== "string" || value.trim().length === 0 || !value.isWellFormed() || value.length > 100) {
    return bad("connection_id must be a non-empty string");
  }
  return value;
}

export function parse_reauth_code(input: Record<string, unknown>): string {
  const value = input["reauth_code"];
  if (typeof value !== "string" || value.length === 0 || value.length > 200 || !value.isWellFormed()) {
    return bad("reauth_code must be a non-empty string");
  }
  return value;
}

/** The only fields a key may leave behind: the last four characters, never more. */
export function key_last4_of(key: string): string {
  return Array.from(key).slice(-4).join("");
}

// ---------------------------------------------------------------------------
// token and cost arithmetic (integers only)

/**
 * A deliberately high guess of the tokens in a text: the larger of one token per 2 UTF-8 bytes (rounded up; Korean
 * and other 3-byte text costs about that much or more) and one token per character (plain English costs far less),
 * at least 1.
 */
export function estimate_tokens(text: string): number {
  const by_bytes = Math.ceil(Buffer.byteLength(text, "utf8") / 2);
  return Math.max(1, by_bytes, text.length);
}

/** ceil(tokens x price_per_million / 1,000,000) in micro-units, exact for any safe integers. */
export function cost_micros(input_tokens: number, output_tokens: number, input_price: number, output_price: number): number {
  const total = BigInt(input_tokens) * BigInt(input_price) + BigInt(output_tokens) * BigInt(output_price);
  const million = 1_000_000n;
  const value = (total + million - 1n) / million;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ApiError("conflict", "the cost is out of range");
  return Number(value);
}

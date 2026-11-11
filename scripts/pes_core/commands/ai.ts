// AI connection, selection, dispatch-settlement and usage-block commands (stage 2 PR19).
//
// The only business-table SQL for the user-registered AI connections lives here. The facade in
// a_runtime/connections.ts and the executor in a_runtime/loop.ts call these through CommandService.execute, so
// every write passes the registry, project/actor check, receipt replay, change and events + receipt in one
// transaction.
//
//   * An api key is never a command field: `api_key` is an unknown field and is refused without being quoted.
//     The facade puts the key into the key store (OS keychain) and sends only the last four characters, the
//     key store's name and a reference.
//   * Registering, changing, removing, testing and pricing a connection are human-only (the project's owner) and
//     each request consumes one single-use re-authentication code (ai_connection.issue_reauth).
//   * Dispatch settlement (dispatch.settle) records what happened to an outbound model call; run.block_usage
//     stops a run on a usage / cost / unknown block and releases its lease.

import { createHash } from "node:crypto";

import { ApiError } from "../errors.ts";
import {
  REAUTH_TTL_MS,
  is_plain,
  is_supported_format,
  parse_base_url,
  parse_billing_rules,
  parse_cap,
  parse_connection_id,
  parse_currency,
  parse_kind,
  parse_limits,
  parse_model,
  parse_name,
  parse_price_micros,
  parse_reauth_code,
  parse_stop_percent,
  request_format_of,
  text_field,
  type Billing,
} from "../a_runtime/spec.ts";
import { INTERNAL_ERROR_CODES } from "../a_runtime/formats.ts";
import { read_connection_facts, read_run_settings, usage_gate } from "../a_runtime/usage.ts";
import {
  insert_receipt,
  reject_unknown_fields,
  require_current_lease,
  require_human_owner_actor,
  require_non_empty_string,
  require_record,
  type CommandDefinition,
  type CommandResult,
  type CommandRuntime,
  type LeaseGuard,
} from "./shared.ts";

interface Scope {
  project_id: string;
  actor_id: string;
}

function scope_of(runtime: CommandRuntime): Scope {
  const project = runtime.project;
  const actor_id = runtime.actor_id;
  if (project === null || actor_id === null) {
    throw new Error("an ai command must resolve a project and actor first");
  }
  return { project_id: project.id, actor_id };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The human owner's user id (connections belong to the user, so every project of the owner can use them). */
function owner_user_of(runtime: CommandRuntime, scope: Scope): string {
  const row = runtime.db.get<{ owner_user_id: string }>(
    "SELECT owner_user_id FROM projects WHERE id = ?",
    scope.project_id,
  );
  if (row === undefined) throw new ApiError("not_found", "project not found");
  return row.owner_user_id;
}

/**
 * Consume the single-use code of a management request. The code must have been issued to this actor for this
 * project, be unused and be unexpired; anything else is `forbidden` with one fixed message.
 */
function consume_reauth(runtime: CommandRuntime, scope: Scope, payload: Record<string, unknown>): void {
  const code = parse_reauth_code(payload);
  const row = runtime.db.get<{ id: string; actor_id: string; project_id: string; expires_at: bigint; used_at: bigint | null }>(
    "SELECT id, actor_id, project_id, expires_at, used_at FROM ai_reauth_codes WHERE code_hash = ?",
    sha256(code),
  );
  if (
    row === undefined ||
    row.actor_id !== scope.actor_id ||
    row.project_id !== scope.project_id ||
    row.used_at !== null ||
    runtime.now_ms >= Number(row.expires_at)
  ) {
    throw new ApiError("forbidden", "re-authentication is required");
  }
  const used = runtime.db.run(
    "UPDATE ai_reauth_codes SET used_at = ? WHERE id = ? AND used_at IS NULL",
    runtime.now_ms,
    row.id,
  );
  if (used.changes !== 1n) throw new ApiError("forbidden", "re-authentication is required");
}

interface ConnectionRow {
  id: string;
  owner_user_id: string;
  name: string;
  kind: string;
  request_format: string;
  base_url: string;
  billing: Billing;
  key_ref: string;
  credential_rev: bigint;
  stop_percent: bigint | null;
  limit_five_hour_tokens: bigint | null;
  limit_weekly_tokens: bigint | null;
  limit_monthly_tokens: bigint | null;
  cost_cap_currency: string | null;
  cost_cap_micros: bigint | null;
  removed_at: bigint | null;
}

const CONNECTION_COLUMNS = `id, owner_user_id, name, kind, request_format, base_url, billing, key_ref, credential_rev, stop_percent,
  limit_five_hour_tokens, limit_weekly_tokens, limit_monthly_tokens, cost_cap_currency, cost_cap_micros, removed_at`;

function live_connection(runtime: CommandRuntime, scope: Scope, connection_id: string): ConnectionRow {
  const row = runtime.db.get<ConnectionRow>(
    `SELECT ${CONNECTION_COLUMNS} FROM ai_connections WHERE id = ?`,
    connection_id,
  );
  if (row === undefined || row.removed_at !== null || row.owner_user_id !== owner_user_of(runtime, scope)) {
    throw new ApiError("not_found", "connection not found");
  }
  return row;
}

function parse_key_facts(payload: Record<string, unknown>): { key_last4: string; key_storage: string } {
  const key_last4 = text_field(payload, "key_last4", 4);
  if (Array.from(key_last4).length > 4) throw new ApiError("invalid_payload", "key_last4 is too long");
  return { key_last4, key_storage: text_field(payload, "key_storage", 200) };
}

function as_int(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

// ---------------------------------------------------------------------------
// ai_connection.issue_reauth

function run_issue_reauth(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  const scope = scope_of(runtime);
  require_human_owner_actor(runtime);
  reject_unknown_fields(payload, ["code_hash"]);
  const code_hash = require_non_empty_string(payload, "code_hash");
  if (!/^[0-9a-f]{64}$/.test(code_hash)) throw new ApiError("invalid_payload", "code_hash must be 64 hexadecimal characters");

  const reauth_id = runtime.new_id();
  const expires_at = runtime.now_ms + REAUTH_TTL_MS;
  runtime.db.run(
    `INSERT INTO ai_reauth_codes (id, project_id, actor_id, code_hash, issued_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    reauth_id,
    scope.project_id,
    scope.actor_id,
    code_hash,
    runtime.now_ms,
    expires_at,
  );
  const result = { project_id: scope.project_id, reauth_id, expires_at };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "ai_connection.reauth_issued",
    base_control_rev: null,
    result,
  });
  return { result, events: [{ type: "ai_connection.reauth_issued", payload: { reauth_id, expires_at } }] };
}

// ---------------------------------------------------------------------------
// ai_connection.register

const REGISTER_FIELDS = [
  "reauth_code",
  "connection_id",
  "name",
  "kind",
  "base_url",
  "billing",
  "stop_percent",
  "subscription_limits",
  "cost_cap",
  "key_ref",
  "key_last4",
  "key_storage",
] as const;

function run_register(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  const scope = scope_of(runtime);
  require_human_owner_actor(runtime);
  reject_unknown_fields(payload, REGISTER_FIELDS);
  const name = parse_name(payload);
  const kind = parse_kind(payload);
  const base_url = parse_base_url(payload);
  const rules = parse_billing_rules(payload);
  const connection_id = require_non_empty_string(payload, "connection_id");
  const key_ref = text_field(payload, "key_ref", 200);
  // A connection may only name its own key: a reference to another connection's key would let remove delete it.
  if (key_ref !== `pes-ai-${connection_id}`) {
    throw new ApiError("invalid_payload", 'key_ref must be "pes-ai-" followed by the connection_id');
  }
  const key = parse_key_facts(payload);
  consume_reauth(runtime, scope, payload);

  const owner_user_id = owner_user_of(runtime, scope);
  const request_format = request_format_of(kind);
  runtime.db.run(
    `INSERT INTO ai_connections
       (id, owner_user_id, name, kind, request_format, base_url, billing, key_ref, key_last4, key_storage,
        key_set_at, key_set_by, stop_percent, limit_five_hour_tokens, limit_weekly_tokens, limit_monthly_tokens,
        cost_cap_currency, cost_cap_micros, created_at, updated_at, removed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    connection_id,
    owner_user_id,
    name,
    kind,
    request_format,
    base_url,
    rules.billing,
    key_ref,
    key.key_last4,
    key.key_storage,
    runtime.now_ms,
    scope.actor_id,
    rules.stop_percent,
    rules.limits?.five_hour_tokens ?? null,
    rules.limits?.weekly_tokens ?? null,
    rules.limits?.monthly_tokens ?? null,
    rules.cap?.currency ?? null,
    rules.cap?.amount_micros ?? null,
    runtime.now_ms,
    runtime.now_ms,
  );

  const result = { project_id: scope.project_id, connection_id };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "ai_connection.registered",
    base_control_rev: null,
    result,
  });
  return {
    result,
    events: [
      {
        type: "ai_connection.registered",
        payload: {
          connection_id,
          name,
          kind,
          request_format,
          billing: rules.billing,
          key_last4: key.key_last4,
          key_storage: key.key_storage,
          supported: is_supported_format(request_format),
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// ai_connection.update

const UPDATE_FIELDS = [
  "reauth_code",
  "connection_id",
  "name",
  "base_url",
  "stop_percent",
  "subscription_limits",
  "cost_cap",
  "key_last4",
  "key_storage",
] as const;

function run_update(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  const scope = scope_of(runtime);
  require_human_owner_actor(runtime);
  reject_unknown_fields(payload, UPDATE_FIELDS);
  const connection_id = parse_connection_id(payload);

  const changes: string[] = [];
  const params: Array<string | number | null> = [];
  const set = (column: string, value: string | number | null): void => {
    changes.push(`${column} = ?`);
    params.push(value);
  };
  const changed: string[] = [];

  if (payload["name"] !== undefined) {
    set("name", parse_name(payload));
    changed.push("name");
  }
  if (payload["base_url"] !== undefined) {
    set("base_url", parse_base_url(payload));
    changed.push("base_url");
  }
  const has_key = payload["key_last4"] !== undefined || payload["key_storage"] !== undefined;
  const key = has_key ? parse_key_facts(payload) : null;
  consume_reauth(runtime, scope, payload);
  const row = live_connection(runtime, scope, connection_id);

  if (payload["stop_percent"] !== undefined) {
    if (row.billing !== "subscription") throw new ApiError("invalid_payload", "stop_percent belongs to subscription billing");
    set("stop_percent", parse_stop_percent(payload["stop_percent"]));
    changed.push("stop_percent");
  }
  if (payload["subscription_limits"] !== undefined) {
    if (row.billing !== "subscription") throw new ApiError("invalid_payload", "subscription_limits belongs to subscription billing");
    const limits = parse_limits(payload["subscription_limits"]);
    set("limit_five_hour_tokens", limits.five_hour_tokens);
    set("limit_weekly_tokens", limits.weekly_tokens);
    set("limit_monthly_tokens", limits.monthly_tokens);
    changed.push("subscription_limits");
  }
  if (payload["cost_cap"] !== undefined) {
    if (row.billing !== "pay_per_use") throw new ApiError("invalid_payload", "cost_cap belongs to pay_per_use billing");
    const cap = parse_cap(payload["cost_cap"]);
    set("cost_cap_currency", cap.currency);
    set("cost_cap_micros", cap.amount_micros);
    changed.push("cost_cap");
  }
  if (key !== null) {
    set("key_last4", key.key_last4);
    set("key_storage", key.key_storage);
    set("key_set_at", runtime.now_ms);
    set("key_set_by", scope.actor_id);
    changed.push("key");
  }
  if (changes.length === 0) throw new ApiError("invalid_payload", "at least one field to change is required");
  // A new key or a new address may be another account or another service: the "extra charge OFF" confirmations
  // and usage baselines recorded so far stop counting (a_runtime/usage.ts latest_subscription_guard).
  if (key !== null || payload["base_url"] !== undefined) changes.push("credential_rev = credential_rev + 1");
  set("updated_at", runtime.now_ms);

  const written = runtime.db.run(
    `UPDATE ai_connections SET ${changes.join(", ")} WHERE id = ? AND removed_at IS NULL`,
    ...params,
    connection_id,
  );
  if (written.changes !== 1n) throw new ApiError("not_found", "connection not found");

  const result = { project_id: scope.project_id, connection_id, changed };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "ai_connection.updated",
    base_control_rev: null,
    result,
  });
  return {
    result,
    events: [
      {
        type: "ai_connection.updated",
        payload: { connection_id, changed, ...(key === null ? {} : { key_last4: key.key_last4 }) },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// ai_connection.remove

function run_remove(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  const scope = scope_of(runtime);
  require_human_owner_actor(runtime);
  reject_unknown_fields(payload, ["reauth_code", "connection_id"]);
  const connection_id = parse_connection_id(payload);
  consume_reauth(runtime, scope, payload);
  const row = live_connection(runtime, scope, connection_id);

  // The row is kept (runs, dispatches and prices refer to it); it is only marked removed.
  const written = runtime.db.run(
    "UPDATE ai_connections SET removed_at = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL",
    runtime.now_ms,
    runtime.now_ms,
    row.id,
  );
  if (written.changes !== 1n) throw new ApiError("not_found", "connection not found");
  const result = { project_id: scope.project_id, connection_id, removed: true, key_ref: row.key_ref };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "ai_connection.removed",
    base_control_rev: null,
    result,
  });
  return { result, events: [{ type: "ai_connection.removed", payload: { connection_id, name: row.name } }] };
}

// ---------------------------------------------------------------------------
// ai_connection.test (the audit record of a connection test; the HTTP call is the facade's)

function run_test(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  const scope = scope_of(runtime);
  require_human_owner_actor(runtime);
  reject_unknown_fields(payload, ["reauth_code", "connection_id", "ok", "error_code", "model_count"]);
  const connection_id = parse_connection_id(payload);
  if (typeof payload["ok"] !== "boolean") throw new ApiError("invalid_payload", "ok must be a boolean");
  const ok = payload["ok"];
  let error_code: string | null = null;
  if (payload["error_code"] !== undefined && payload["error_code"] !== null) {
    error_code = text_field(payload, "error_code", 80);
  }
  const model_count = payload["model_count"];
  if (model_count !== undefined && (typeof model_count !== "number" || !Number.isSafeInteger(model_count) || model_count < 0)) {
    throw new ApiError("invalid_payload", "model_count must be a non-negative integer");
  }
  consume_reauth(runtime, scope, payload);
  live_connection(runtime, scope, connection_id);

  const result = { project_id: scope.project_id, connection_id, ok, error_code };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "ai_connection.tested",
    base_control_rev: null,
    result,
  });
  return {
    result,
    events: [{ type: "ai_connection.tested", payload: { connection_id, ok, error_code, model_count: model_count ?? null } }],
  };
}

// ---------------------------------------------------------------------------
// ai_connection.set_price

function run_set_price(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  const scope = scope_of(runtime);
  require_human_owner_actor(runtime);
  reject_unknown_fields(payload, [
    "reauth_code",
    "connection_id",
    "model",
    "currency",
    "input_per_mtok_micros",
    "output_per_mtok_micros",
  ]);
  const connection_id = parse_connection_id(payload);
  const model = parse_model(payload);
  const currency = parse_currency(payload["currency"]);
  const input_price = parse_price_micros(payload["input_per_mtok_micros"], "input_per_mtok_micros");
  const output_price = parse_price_micros(payload["output_per_mtok_micros"], "output_per_mtok_micros");
  consume_reauth(runtime, scope, payload);
  live_connection(runtime, scope, connection_id);

  const price_id = runtime.new_id();
  runtime.db.run(
    `INSERT INTO ai_connection_prices
       (id, connection_id, model, currency, input_per_mtok_micros, output_per_mtok_micros, entered_by, entered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    price_id,
    connection_id,
    model,
    currency,
    input_price,
    output_price,
    scope.actor_id,
    runtime.now_ms,
  );
  const result = {
    project_id: scope.project_id,
    price_id,
    connection_id,
    model,
    currency,
    input_per_mtok_micros: input_price,
    output_per_mtok_micros: output_price,
    entered_by: scope.actor_id,
    entered_at: runtime.now_ms,
  };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "ai_connection.price_set",
    base_control_rev: null,
    result,
  });
  return {
    result,
    events: [
      {
        type: "ai_connection.price_set",
        payload: { price_id, connection_id, model, currency, input_per_mtok_micros: input_price, output_per_mtok_micros: output_price },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// ai_connection.confirm_extra_charge_off / ai_connection.record_usage_baseline (subscription connections only)
//
// A person states that the account behind the connection cannot be charged beyond its plan ("extra charge" is
// off), for which account and for how long; and, separately, how many tokens the account had already used (the
// baseline, read from the provider's own page). The runner calls a subscription connection only while it has a
// valid confirmation and a baseline (a_runtime/usage.ts). Rows are append-only.

/** The longest a confirmation is good for. */
export const EXTRA_CHARGE_OFF_MAX_MS = 400 * 24 * 60 * 60 * 1000;

/** The connection's current credential_rev; the record is made for that key and address only. */
function subscription_connection(runtime: CommandRuntime, scope: Scope, connection_id: string): number {
  const connection = live_connection(runtime, scope, connection_id);
  if (connection.billing !== "subscription") {
    throw new ApiError("conflict", "only a subscription connection takes this record");
  }
  return Number(connection.credential_rev);
}

function run_confirm_extra_charge_off(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  const scope = scope_of(runtime);
  require_human_owner_actor(runtime);
  reject_unknown_fields(payload, ["reauth_code", "connection_id", "account_scope", "valid_for_ms"]);
  const connection_id = parse_connection_id(payload);
  const account_scope = text_field(payload, "account_scope", 200);
  const valid_for_ms = payload["valid_for_ms"];
  if (typeof valid_for_ms !== "number" || !Number.isSafeInteger(valid_for_ms) || valid_for_ms < 1 || valid_for_ms > EXTRA_CHARGE_OFF_MAX_MS) {
    throw new ApiError("invalid_payload", "valid_for_ms must be an integer between 1 and 400 days");
  }
  consume_reauth(runtime, scope, payload);
  const credential_rev = subscription_connection(runtime, scope, connection_id);

  const confirmation_id = runtime.new_id();
  const valid_until = runtime.now_ms + valid_for_ms;
  runtime.db.run(
    `INSERT INTO ai_extra_charge_off_confirmations (id, connection_id, project_id, account_scope, confirmed_by, confirmed_at, valid_until, credential_rev)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    confirmation_id,
    connection_id,
    scope.project_id,
    account_scope,
    scope.actor_id,
    runtime.now_ms,
    valid_until,
    credential_rev,
  );
  const result = {
    project_id: scope.project_id,
    confirmation_id,
    connection_id,
    account_scope,
    confirmed_by: scope.actor_id,
    confirmed_at: runtime.now_ms,
    valid_until,
  };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "ai_connection.extra_charge_off_confirmed",
    base_control_rev: null,
    result,
  });
  return {
    result,
    events: [
      {
        type: "ai_connection.extra_charge_off_confirmed",
        payload: { confirmation_id, connection_id, account_scope, confirmed_at: runtime.now_ms, valid_until },
      },
    ],
  };
}

function run_record_usage_baseline(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  const scope = scope_of(runtime);
  require_human_owner_actor(runtime);
  reject_unknown_fields(payload, ["reauth_code", "connection_id", "account_used_tokens"]);
  const connection_id = parse_connection_id(payload);
  const used = payload["account_used_tokens"];
  if (typeof used !== "number" || !Number.isSafeInteger(used) || used < 0) {
    throw new ApiError("invalid_payload", "account_used_tokens must be a non-negative integer");
  }
  consume_reauth(runtime, scope, payload);
  const credential_rev = subscription_connection(runtime, scope, connection_id);

  const baseline_id = runtime.new_id();
  runtime.db.run(
    `INSERT INTO ai_usage_baselines (id, connection_id, project_id, used_tokens, recorded_by, recorded_at, credential_rev)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    baseline_id,
    connection_id,
    scope.project_id,
    used,
    scope.actor_id,
    runtime.now_ms,
    credential_rev,
  );
  const result = {
    project_id: scope.project_id,
    baseline_id,
    connection_id,
    account_used_tokens: used,
    recorded_by: scope.actor_id,
    recorded_at: runtime.now_ms,
  };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "ai_connection.usage_baseline_recorded",
    base_control_rev: null,
    result,
  });
  return {
    result,
    events: [
      {
        type: "ai_connection.usage_baseline_recorded",
        payload: { baseline_id, connection_id, account_used_tokens: used, recorded_at: runtime.now_ms },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// project.set_ai_connection

function run_set_ai_connection(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  const scope = scope_of(runtime);
  require_human_owner_actor(runtime);
  reject_unknown_fields(payload, ["connection_id", "model"]);
  const connection_id = parse_connection_id(payload);
  const model = parse_model(payload);
  live_connection(runtime, scope, connection_id);

  const selection_id = runtime.new_id();
  runtime.db.run(
    `INSERT INTO project_ai_selections (id, project_id, connection_id, model, selected_by, selected_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    selection_id,
    scope.project_id,
    connection_id,
    model,
    scope.actor_id,
    runtime.now_ms,
  );
  const result = { project_id: scope.project_id, connection_id, model, selection_id };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "project.ai_connection_set",
    base_control_rev: null,
    result,
  });
  return { result, events: [{ type: "project.ai_connection_set", payload: { connection_id, model, selection_id } }] };
}

// ---------------------------------------------------------------------------
// dispatch.resolve_unknown

const RESOLVABLE_STATES = new Set(["unknown", "prepared", "authorized", "sent"]);

function run_resolve_unknown(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  const scope = scope_of(runtime);
  require_human_owner_actor(runtime);
  reject_unknown_fields(payload, ["dispatch_id", "outcome", "note"]);
  const dispatch_id = require_non_empty_string(payload, "dispatch_id");
  const outcome = payload["outcome"];
  if (outcome !== "not_charged" && outcome !== "charged") {
    throw new ApiError("invalid_payload", 'outcome must be "not_charged" or "charged"');
  }
  let note: string | null = null;
  if (payload["note"] !== undefined && payload["note"] !== null) note = text_field(payload, "note", 1000);

  const dispatch = runtime.db.get<{ id: string; run_id: string; state: string }>(
    "SELECT id, run_id, state FROM outbound_dispatches WHERE project_id = ? AND id = ?",
    scope.project_id,
    dispatch_id,
  );
  if (dispatch === undefined) throw new ApiError("not_found", "dispatch not found");
  // unknown: the answer was lost. prepared / authorized / sent: the executor died before it could settle the call.
  if (!RESOLVABLE_STATES.has(dispatch.state)) {
    throw new ApiError("conflict", "only a dispatch without a settled outcome can be settled by a person");
  }
  if (dispatch.state !== "unknown") {
    // A call whose run still holds a live lease may yet be settled by its own executor.
    const live = runtime.db.get<{ ok: bigint }>(
      "SELECT 1 AS ok FROM project_leases WHERE project_id = ? AND run_id = ? AND state = 'active' AND expires_at > ?",
      scope.project_id,
      dispatch.run_id,
      runtime.now_ms,
    );
    if (live !== undefined) throw new ApiError("conflict", "the run is still working; its model call is not abandoned");
  }
  const already = runtime.db.get<{ ok: bigint }>("SELECT 1 AS ok FROM dispatch_resolutions WHERE dispatch_id = ?", dispatch_id);
  if (already !== undefined) throw new ApiError("conflict", "the dispatch was already settled");

  runtime.db.run(
    `INSERT INTO dispatch_resolutions (dispatch_id, project_id, outcome, note, resolved_by, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    dispatch_id,
    scope.project_id,
    outcome,
    note,
    scope.actor_id,
    runtime.now_ms,
  );
  const result = { project_id: scope.project_id, dispatch_id, run_id: dispatch.run_id, outcome };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "dispatch.unknown_resolved",
    base_control_rev: null,
    result,
  });
  return {
    result,
    events: [{ type: "dispatch.unknown_resolved", run_id: dispatch.run_id, payload: { dispatch_id, outcome } }],
  };
}

// ---------------------------------------------------------------------------
// dispatch.settle (what happened to an outbound model call)

const SETTLE_FIELDS = [
  "dispatch_id",
  "outcome",
  "response_hash",
  "usage",
  "cost",
  "billing_source",
  "reason",
  "error_status",
  "error_code",
  "adopted_version_id",
] as const;

function optional_usage(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!is_plain(value)) throw new ApiError("invalid_payload", "usage must be an object");
  const input = value["input_tokens"];
  const output = value["output_tokens"];
  for (const [field, number] of [["input_tokens", input], ["output_tokens", output]] as const) {
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
      throw new ApiError("invalid_payload", `usage.${field} must be a non-negative integer`);
    }
  }
  return JSON.stringify(value);
}

function optional_cost(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!is_plain(value)) throw new ApiError("invalid_payload", "cost must be an object");
  parse_currency(value["currency"], "cost.currency");
  const amount = value["amount_micros"];
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) {
    throw new ApiError("invalid_payload", "cost.amount_micros must be a non-negative integer");
  }
  return JSON.stringify(value);
}

/** What a reply said about how the call was paid for (a_runtime/formats.ts billing_signal_of). */
const BILLING_SOURCES = new Set(["pay_per_use", "subscription", "unrecognized", "not_reported"]);

function optional_billing_source(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !BILLING_SOURCES.has(value)) {
    throw new ApiError("invalid_payload", "billing_source must be pay_per_use, subscription, unrecognized or not_reported");
  }
  return value;
}

function run_settle(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  const scope = scope_of(runtime);
  reject_unknown_fields(payload, SETTLE_FIELDS);
  const dispatch_id = require_non_empty_string(payload, "dispatch_id");
  const outcome = payload["outcome"];
  if (outcome !== "response" && outcome !== "failed" && outcome !== "unknown" && outcome !== "adopted") {
    throw new ApiError("invalid_payload", "outcome must be response, failed, unknown or adopted");
  }
  const response_hash = payload["response_hash"];
  if (response_hash !== undefined && response_hash !== null && (typeof response_hash !== "string" || !/^[0-9a-f]{64}$/.test(response_hash))) {
    throw new ApiError("invalid_payload", "response_hash must be 64 hexadecimal characters");
  }

  const dispatch = runtime.db.get<{ id: string; run_id: string; state: string; response_hash: string | null; run_actor: string }>(
    `SELECT d.id AS id, d.run_id AS run_id, d.state AS state, d.response_hash AS response_hash, r.actor_id AS run_actor
       FROM outbound_dispatches d JOIN runs r ON r.project_id = d.project_id AND r.id = d.run_id
      WHERE d.project_id = ? AND d.id = ?`,
    scope.project_id,
    dispatch_id,
  );
  if (dispatch === undefined) throw new ApiError("not_found", "dispatch not found");
  if (dispatch.run_actor !== scope.actor_id) throw new ApiError("forbidden", "only the run's own actor settles its dispatches");

  const usage_json = optional_usage(payload["usage"]);
  const cost_json = optional_cost(payload["cost"]);
  const from = dispatch.state;
  let written: bigint;
  let event_type: string;
  const event_payload: Record<string, unknown> = { dispatch_id };

  if (outcome === "response") {
    if (typeof response_hash !== "string") throw new ApiError("invalid_payload", "response_hash is required");
    if (usage_json === null) throw new ApiError("invalid_payload", "usage is required");
    if (from !== "sent") throw new ApiError("conflict", "the dispatch is not waiting for a response");
    const billing_source = optional_billing_source(payload["billing_source"]);
    written = runtime.db.run(
      `UPDATE outbound_dispatches
          SET state = 'response', response_hash = ?, response_at = ?, usage_json = ?, cost_json = ?, billing_source = ?
        WHERE project_id = ? AND id = ? AND state = 'sent'`,
      response_hash,
      runtime.now_ms,
      usage_json,
      cost_json,
      billing_source,
      scope.project_id,
      dispatch_id,
    ).changes;
    event_type = "dispatch.response_recorded";
  } else if (outcome === "failed") {
    if (from !== "sent") throw new ApiError("conflict", "the dispatch is not waiting for a response");
    const status = payload["error_status"];
    if (status !== undefined && status !== null && (typeof status !== "number" || !Number.isSafeInteger(status))) {
      throw new ApiError("invalid_payload", "error_status must be an integer");
    }
    written = runtime.db.run(
      "UPDATE outbound_dispatches SET state = 'failed' WHERE project_id = ? AND id = ? AND state = 'sent'",
      scope.project_id,
      dispatch_id,
    ).changes;
    event_type = "dispatch.failed";
    event_payload["error_status"] = status ?? null;
    // only PES's fixed internal codes: a provider's own strings may echo the key (a_runtime/formats.ts)
    const error_code = payload["error_code"] === undefined || payload["error_code"] === null ? null : payload["error_code"];
    if (error_code !== null && (typeof error_code !== "string" || !INTERNAL_ERROR_CODES.includes(error_code))) {
      throw new ApiError("invalid_payload", "error_code must be one of PES's internal error codes");
    }
    event_payload["error_code"] = error_code;
  } else if (outcome === "unknown") {
    if (from !== "sent" && from !== "response") throw new ApiError("conflict", "the dispatch cannot become unknown from its state");
    const reason = text_field(payload, "reason", 200);
    // What the received answer said about billing is kept on the unknown call too (usage.ts: a charge it reported
    // voids the subscription's "extra charge OFF" confirmation whatever a person later settles the call as).
    const billing_source = optional_billing_source(payload["billing_source"]);
    // A received answer keeps its hash and usage; an estimate is stored only when nothing better is known.
    written = runtime.db.run(
      `UPDATE outbound_dispatches
          SET state = 'unknown', unknown_at = ?, unknown_reason = ?,
              response_hash = COALESCE(response_hash, ?),
              response_at = CASE WHEN response_hash IS NULL AND ? IS NOT NULL THEN ? ELSE response_at END,
              usage_json = COALESCE(usage_json, ?),
              cost_json = COALESCE(cost_json, ?),
              billing_source = COALESCE(billing_source, ?)
        WHERE project_id = ? AND id = ? AND state IN ('sent', 'response')`,
      runtime.now_ms,
      reason,
      typeof response_hash === "string" ? response_hash : null,
      typeof response_hash === "string" ? response_hash : null,
      runtime.now_ms,
      usage_json,
      cost_json,
      billing_source,
      scope.project_id,
      dispatch_id,
    ).changes;
    event_type = "dispatch.unknown";
    event_payload["reason"] = reason;
  } else {
    const version_id = require_non_empty_string(payload, "adopted_version_id");
    if (from !== "response") throw new ApiError("conflict", "only a received answer can be adopted");
    const version = runtime.db.get<{ ok: bigint }>(
      "SELECT 1 AS ok FROM object_versions WHERE project_id = ? AND id = ?",
      scope.project_id,
      version_id,
    );
    if (version === undefined) throw new ApiError("invalid_payload", "adopted_version_id is not a version of this project");
    written = runtime.db.run(
      `UPDATE outbound_dispatches SET state = 'adopted', adopted_version_id = ?, adopted_at = ?
        WHERE project_id = ? AND id = ? AND state = 'response'`,
      version_id,
      runtime.now_ms,
      scope.project_id,
      dispatch_id,
    ).changes;
    event_type = "dispatch.adopted";
    event_payload["adopted_version_id"] = version_id;
  }
  if (written !== 1n) throw new ApiError("conflict", "the dispatch changed state");

  const result = { project_id: scope.project_id, dispatch_id, run_id: dispatch.run_id, state: outcome === "response" ? "response" : outcome };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: event_type,
    base_control_rev: null,
    run_id: dispatch.run_id,
    result,
  });
  return { result, events: [{ type: event_type, run_id: dispatch.run_id, payload: event_payload }] };
}

// ---------------------------------------------------------------------------
// run.block_usage

const BLOCK_REASONS = new Set(["usage_limit", "cost_cap", "usage_unknown", "manual_hold", "extra_usage_off"]);

function run_block_usage(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  const scope = scope_of(runtime);
  reject_unknown_fields(payload, ["run_id", "lease_id", "fence", "reason", "reset_at"]);
  const guard: LeaseGuard = {
    run_id: require_non_empty_string(payload, "run_id"),
    lease_id: require_non_empty_string(payload, "lease_id"),
    fence: (() => {
      const fence = payload["fence"];
      if (typeof fence !== "number" || !Number.isSafeInteger(fence) || fence < 1) {
        throw new ApiError("invalid_payload", "fence must be a positive safe integer");
      }
      return fence;
    })(),
  };
  const reason = payload["reason"];
  if (typeof reason !== "string" || !BLOCK_REASONS.has(reason)) {
    throw new ApiError("invalid_payload", "reason must be usage_limit, cost_cap, usage_unknown, manual_hold or extra_usage_off");
  }
  const reset_at = payload["reset_at"];
  if (reset_at !== undefined && reset_at !== null && (typeof reset_at !== "number" || !Number.isSafeInteger(reset_at) || reset_at < 0)) {
    throw new ApiError("invalid_payload", "reset_at must be a non-negative integer or null");
  }
  require_current_lease(runtime, guard);

  const run = runtime.db.get<{ status: string }>(
    "SELECT status FROM runs WHERE project_id = ? AND id = ?",
    scope.project_id,
    guard.run_id,
  );
  if (run === undefined || run.status !== "running") throw new ApiError("conflict", "only a running run can be blocked");
  const blocked = runtime.db.run(
    `UPDATE runs SET status = 'blocked_usage', go_block_reason = ?, go_blocked_at = ?, go_block_reset_at = ?
      WHERE project_id = ? AND id = ? AND status = 'running'`,
    reason,
    runtime.now_ms,
    reset_at ?? null,
    scope.project_id,
    guard.run_id,
  );
  if (blocked.changes !== 1n) throw new ApiError("conflict", "the run was not blocked");
  const released = runtime.db.run(
    "UPDATE project_leases SET state = 'released' WHERE project_id = ? AND lease_id = ? AND fence = ? AND state = 'active'",
    scope.project_id,
    guard.lease_id,
    guard.fence,
  );
  if (released.changes !== 1n) throw new ApiError("conflict", "the lease is not current");

  const result = { project_id: scope.project_id, run_id: guard.run_id, status: "blocked_usage", reason, reset_at: reset_at ?? null };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "run.blocked_usage",
    base_control_rev: null,
    run_id: guard.run_id,
    lease_id: guard.lease_id,
    fence: guard.fence,
    result,
  });
  return {
    result,
    events: [{ type: "run.blocked_usage", run_id: guard.run_id, payload: { reason, reset_at: reset_at ?? null } }],
  };
}

// ---------------------------------------------------------------------------
// helpers used by run.create for a built-in (pes_builtin) run

interface SelectionRow {
  connection_id: string;
  model: string;
}

export interface BuiltinRunSettings {
  connection_id: string;
  request_format: string;
  billing: Billing;
  stop_percent: number | null;
  price_id: string | null;
  price_currency: string | null;
  price_input: number | null;
  price_output: number | null;
}

/**
 * Validate the connection of a built-in run and take its settings. The connection must be the project's
 * current selection, be registered by the project owner, not removed, speak a supported format, and (for pay per
 * use) have a price for the model in the currency of its cap. Throws before any row is written.
 */
export function builtin_run_settings(
  runtime: CommandRuntime,
  project_id: string,
  connection_id: string,
  provider: string,
  model: string,
): BuiltinRunSettings {
  const owner = runtime.db.get<{ owner_user_id: string }>("SELECT owner_user_id FROM projects WHERE id = ?", project_id);
  const row = runtime.db.get<ConnectionRow>(`SELECT ${CONNECTION_COLUMNS} FROM ai_connections WHERE id = ?`, connection_id);
  if (owner === undefined || row === undefined || row.removed_at !== null || row.owner_user_id !== owner.owner_user_id) {
    throw new ApiError("not_found", "connection not found");
  }
  const selected = runtime.db.get<SelectionRow>(
    "SELECT connection_id, model FROM project_ai_selections WHERE project_id = ? ORDER BY rowid DESC LIMIT 1",
    project_id,
  );
  if (selected === undefined || selected.connection_id !== connection_id || selected.model !== model) {
    throw new ApiError("conflict", "the project has not selected this connection and model");
  }
  if (provider !== row.request_format) {
    throw new ApiError("invalid_payload", "provider must be the connection's request format");
  }
  if (!is_supported_format(row.request_format)) {
    throw new ApiError("conflict", "this connection's request format is not supported yet");
  }
  const settings: BuiltinRunSettings = {
    connection_id,
    request_format: row.request_format,
    billing: row.billing,
    stop_percent: as_int(row.stop_percent),
    price_id: null,
    price_currency: null,
    price_input: null,
    price_output: null,
  };
  if (row.billing === "pay_per_use") {
    // The newest entry for this model is the current price; a missing one is "unknown", never 0.
    const price = runtime.db.get<{ id: string; currency: string; input_per_mtok_micros: bigint; output_per_mtok_micros: bigint }>(
      `SELECT id, currency, input_per_mtok_micros, output_per_mtok_micros FROM ai_connection_prices
        WHERE connection_id = ? AND model = ? ORDER BY rowid DESC LIMIT 1`,
      connection_id,
      model,
    );
    if (price === undefined) throw new ApiError("conflict", "no price is entered for this model");
    if (price.currency !== row.cost_cap_currency) throw new ApiError("conflict", "the price and the cost cap use different currencies");
    settings.price_id = price.id;
    settings.price_currency = price.currency;
    settings.price_input = Number(price.input_per_mtok_micros);
    settings.price_output = Number(price.output_per_mtok_micros);
  }
  return settings;
}

export function write_builtin_run_settings(
  runtime: CommandRuntime,
  project_id: string,
  run_id: string,
  model: string,
  settings: BuiltinRunSettings,
): void {
  runtime.db.run(
    `INSERT INTO ai_run_settings
       (run_id, project_id, connection_id, model, request_format, billing, stop_percent, price_id, price_currency,
        price_input_per_mtok_micros, price_output_per_mtok_micros, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    run_id,
    project_id,
    settings.connection_id,
    model,
    settings.request_format,
    settings.billing,
    settings.stop_percent,
    settings.price_id,
    settings.price_currency,
    settings.price_input,
    settings.price_output,
    runtime.now_ms,
  );
}

/**
 * The gate of a built-in dispatch, judged inside the prepare transaction. Returns the allowance JSON to store on
 * the dispatch row (the reservation that keeps counting while the call is in flight). Refuses with `conflict`
 * (details.reason = usage_limit | cost_cap, details.reset_at) when this call would pass the line.
 */
export function gate_builtin_dispatch(runtime: CommandRuntime, project_id: string, run_id: string, raw: unknown): string {
  const settings = read_run_settings(runtime.db, run_id);
  if (settings === undefined || settings.project_id !== project_id) {
    throw new ApiError("invalid_payload", "the run has no AI connection settings");
  }
  if (!is_plain(raw)) throw new ApiError("invalid_payload", "reservation is required");
  const reservation = { input_tokens: raw["input_tokens"], output_tokens: raw["output_tokens"] };
  for (const [field, value] of Object.entries(reservation)) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new ApiError("invalid_payload", `reservation.${field} must be a non-negative integer`);
    }
  }
  const connection = read_connection_facts(runtime.db, settings.connection_id);
  if (connection === undefined || connection.removed) throw new ApiError("conflict", "the AI connection was removed");
  const verdict = usage_gate(runtime.db, settings, connection, runtime.now_ms, reservation as { input_tokens: number; output_tokens: number });
  if (!verdict.ok) {
    throw new ApiError("conflict", gate_message(verdict.reason), {
      reason: verdict.reason,
      reset_at: verdict.reset_at,
    });
  }
  return JSON.stringify({ reservation });
}

export function gate_message(reason: string): string {
  if (reason === "cost_cap") return "the cost cap would be passed";
  if (reason === "extra_usage_off") return "this subscription connection has no valid extra-charge-off confirmation and usage baseline";
  return "the usage limit would be passed";
}

function definition(action: string, run: (runtime: CommandRuntime) => CommandResult): CommandDefinition {
  return Object.freeze({ action, scope: "project", rev_bearing: false, run });
}

const AI_COMMAND_INPUTS: ReadonlyArray<readonly [string, CommandDefinition]> = [
  ["ai_connection.issue_reauth", definition("ai_connection.reauth_issued", run_issue_reauth)],
  ["ai_connection.register", definition("ai_connection.registered", run_register)],
  ["ai_connection.update", definition("ai_connection.updated", run_update)],
  ["ai_connection.remove", definition("ai_connection.removed", run_remove)],
  ["ai_connection.test", definition("ai_connection.tested", run_test)],
  ["ai_connection.set_price", definition("ai_connection.price_set", run_set_price)],
  ["ai_connection.confirm_extra_charge_off", definition("ai_connection.extra_charge_off_confirmed", run_confirm_extra_charge_off)],
  ["ai_connection.record_usage_baseline", definition("ai_connection.usage_baseline_recorded", run_record_usage_baseline)],
  ["project.set_ai_connection", definition("project.ai_connection_set", run_set_ai_connection)],
  ["dispatch.resolve_unknown", definition("dispatch.unknown_resolved", run_resolve_unknown)],
  ["dispatch.settle", definition("dispatch.settled", run_settle)],
  ["run.block_usage", definition("run.blocked_usage", run_block_usage)],
];

/** Registry entries merged into COMMANDS by commands.ts (names, not actions). */
export const AI_COMMAND_ENTRIES: ReadonlyArray<readonly [string, CommandDefinition]> = Object.freeze(
  AI_COMMAND_INPUTS.map((entry) => Object.freeze([entry[0], entry[1]] as const)),
);

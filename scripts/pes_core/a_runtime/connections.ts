// The facade over the ai_connection.* commands (stage 2 PR19).
//
// A command runs inside a database transaction and cannot do network work or touch a key store, so the
// facade does those parts and sends the command only what may be stored:
//
//   register / update  1. only the human owner (forbidden otherwise, before any work)
//                      2. the input is checked without any network call (invalid_payload)
//                      3. the single-use re-authentication code is checked (forbidden), not yet used up
//                      4. the PES server tests the connection (GET the model list) - a failure saves nothing
//                      5. the key goes to the key store, then the command stores the connection (last 4 only)
//                      6. a failed command puts the key store back as it was
//   remove             the command first, then the key is deleted from the key store
//
// Changing or removing a connection's key or address is serialised per connection (one at a time, from the first
// key-store read to the end of the command or its rollback), and a rollback only undoes this request's own change:
// it puts the earlier key back only when the store still holds the key this request wrote (compare-and-swap), so a
// failed request can never overwrite or delete a key another request has since stored.
//
// Whoever SENDS the key (the executor before each model call, the connection test) takes the address and the key
// together under the same per-connection lock (connection_snapshot), so a change in progress is never seen half
// done: never the new key with the old address, never the old key with the new address. Within one process the
// lock alone guarantees it; across processes the key's last 4 characters are compared with the database's, and a
// mismatch (a change half done elsewhere) sends nothing.
//
// A model list is an answer too: one that carries the key (in any disguise, formats.ts reply_carries_key) is a
// failed test with the fixed code key_in_reply, and none of its ids is handed on. A list the check could not finish
// on fails the same way with key_check_failed (fail closed).
//
// The api key lives in the key store and, for the length of one request, in memory. It is never returned,
// logged, or written to a table, event or receipt; error texts here are fixed strings.

import { createHash, randomBytes } from "node:crypto";

import { read_credential_actor } from "../actors.ts";
import type { CommandService, MutationContext } from "../commands.ts";
import type { Clock } from "../clock.ts";
import type { Db } from "../db.ts";
import { ApiError } from "../errors.ts";
import { new_id } from "../ids.ts";
import { auth_headers, models_url, parse_models, reply_key_check, ReplyShapeError } from "./formats.ts";
import { http_json, type FetchFn } from "./http.ts";
import { KeyStoreTimeoutError, type KeyStore } from "./keystore.ts";
import {
  is_plain,
  is_supported_format,
  key_last4_of,
  parse_base_url,
  parse_billing_rules,
  parse_cap,
  parse_connection_id,
  parse_kind,
  parse_limits,
  parse_name,
  parse_reauth_code,
  parse_stop_percent,
  request_format_of,
  type RequestFormat,
} from "./spec.ts";
import { read_connection_facts, type ConnectionFacts } from "./usage.ts";

export interface AiDeps {
  service: CommandService;
  db: Db;
  clock: Clock;
  key_store: KeyStore;
  /** One line per notable event. Never carries a key or a provider's message text. */
  log?: (line: string) => void;
  /** How many times a failed save of an answer is retried (the model is not called again). Default 2. */
  save_retries?: number;
  /** Time limit of one outbound request. Default 30,000 ms. */
  request_timeout_ms?: number;
  /** Test/composition seam for the HTTP client. */
  fetch?: FetchFn;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_SAVE_RETRIES = 2;

export interface PriceDto {
  model: string;
  currency: string;
  input_per_mtok_micros: number;
  output_per_mtok_micros: number;
  entered_by: string;
  entered_at: number;
}

export interface ConnectionDto {
  connection_id: string;
  name: string;
  kind: string;
  request_format: string;
  supported: boolean;
  base_url: string;
  billing: string;
  key_last4: string;
  key_storage: string;
  key_set_at: number;
  key_set_by: string;
  stop_percent: number | null;
  subscription_limits: { five_hour_tokens: number; weekly_tokens: number; monthly_tokens: number } | null;
  cost_cap: { currency: string; amount_micros: number } | null;
  prices: PriceDto[];
}

interface DtoRow {
  id: string;
  name: string;
  kind: string;
  request_format: string;
  base_url: string;
  billing: string;
  key_last4: string;
  key_storage: string;
  key_set_at: bigint;
  key_set_by: string;
  stop_percent: bigint | null;
  limit_five_hour_tokens: bigint | null;
  limit_weekly_tokens: bigint | null;
  limit_monthly_tokens: bigint | null;
  cost_cap_currency: string | null;
  cost_cap_micros: bigint | null;
  key_ref: string;
  owner_user_id: string;
}

type ReadDb = Pick<Db, "get" | "all">;

const DTO_COLUMNS = `id, name, kind, request_format, base_url, billing, key_last4, key_storage, key_set_at, key_set_by,
  stop_percent, limit_five_hour_tokens, limit_weekly_tokens, limit_monthly_tokens, cost_cap_currency, cost_cap_micros,
  key_ref, owner_user_id`;

function dto_of(db: ReadDb, row: DtoRow): ConnectionDto {
  const prices = db
    .all<{ model: string; currency: string; input_per_mtok_micros: bigint; output_per_mtok_micros: bigint; entered_by: string; entered_at: bigint }>(
      `SELECT model, currency, input_per_mtok_micros, output_per_mtok_micros, entered_by, entered_at
         FROM ai_connection_prices WHERE connection_id = ? ORDER BY rowid`,
      row.id,
    )
    .map((p) => ({
      model: p.model,
      currency: p.currency,
      input_per_mtok_micros: Number(p.input_per_mtok_micros),
      output_per_mtok_micros: Number(p.output_per_mtok_micros),
      entered_by: p.entered_by,
      entered_at: Number(p.entered_at),
    }));
  return {
    connection_id: row.id,
    name: row.name,
    kind: row.kind,
    request_format: row.request_format,
    supported: is_supported_format(row.request_format),
    base_url: row.base_url,
    billing: row.billing,
    key_last4: row.key_last4,
    key_storage: row.key_storage,
    key_set_at: Number(row.key_set_at),
    key_set_by: row.key_set_by,
    stop_percent: row.stop_percent === null ? null : Number(row.stop_percent),
    subscription_limits:
      row.limit_five_hour_tokens === null || row.limit_weekly_tokens === null || row.limit_monthly_tokens === null
        ? null
        : {
            five_hour_tokens: Number(row.limit_five_hour_tokens),
            weekly_tokens: Number(row.limit_weekly_tokens),
            monthly_tokens: Number(row.limit_monthly_tokens),
          },
    cost_cap:
      row.cost_cap_currency === null || row.cost_cap_micros === null
        ? null
        : { currency: row.cost_cap_currency, amount_micros: Number(row.cost_cap_micros) },
    prices,
  };
}

const API_KEY_MAX = 512;

function parse_api_key(input: Record<string, unknown>): string {
  const key = input["api_key"];
  if (typeof key !== "string" || key.length < 8 || key.length > API_KEY_MAX || !key.isWellFormed() || /[\u0000-\u001f\u007f\s]/.test(key)) {
    throw new ApiError("invalid_payload", "api_key must be a single-line string of 8 to 512 characters");
  }
  return key;
}

/** One key or address change (or removal, or snapshot read) per connection at a time, within this process. */
const CONNECTION_LOCKS = new Map<string, Promise<void>>();

async function with_connection_lock<T>(connection_id: string, work: () => Promise<T>): Promise<T> {
  const previous = CONNECTION_LOCKS.get(connection_id) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => mine);
  CONNECTION_LOCKS.set(connection_id, queued);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (CONNECTION_LOCKS.get(connection_id) === queued) CONNECTION_LOCKS.delete(connection_id);
  }
}

export type ConnectionSnapshot =
  | { ok: true; connection: ConnectionFacts; key: string }
  | { ok: false; reason: "gone" | "key_missing" | "key_changing" };

/**
 * The connection's address and its key, read together: under the per-connection lock that every key or address
 * change holds, and checked against each other (the key's last 4 characters must be the ones the database has).
 */
export async function connection_snapshot(db: Pick<Db, "get" | "all">, key_store: KeyStore, connection_id: string): Promise<ConnectionSnapshot> {
  return with_connection_lock(connection_id, async () => {
    const connection = read_connection_facts(db, connection_id);
    if (connection === undefined || connection.removed) return { ok: false as const, reason: "gone" as const };
    let key: string | undefined;
    try {
      key = await key_store.get(connection.key_ref);
    } catch {
      key = undefined;
    }
    if (key === undefined) return { ok: false as const, reason: "key_missing" as const };
    // read the row again after the (awaited) key read: both have to belong to the same change
    const again = read_connection_facts(db, connection_id);
    if (
      again === undefined ||
      again.removed ||
      again.base_url !== connection.base_url ||
      again.credential_rev !== connection.credential_rev ||
      key_last4_of(key) !== again.key_last4
    ) {
      return { ok: false as const, reason: "key_changing" as const };
    }
    return { ok: true as const, connection: again, key };
  });
}

export interface ModelListing {
  ok: boolean;
  models: string[];
  error_code: string | null;
}

export class AiConnectionService {
  readonly #deps: AiDeps;

  constructor(deps: AiDeps) {
    this.#deps = deps;
  }

  #log(line: string): void {
    this.#deps.log?.(line);
  }

  // ---------------------------------------------------------------------
  // checks that run before any work

  /** Only the project's human owner. Fixed message; nothing is read beyond the actor and the membership. */
  #require_human(ctx: MutationContext): void {
    const allowed = this.#deps.service.read((db) => {
      if (ctx.project_id === null || ctx.actor_id === null) return false;
      const actor = read_credential_actor(db, ctx.actor_id);
      if (actor === undefined || actor.kind !== "human") return false;
      const member = db.get<{ role: string }>(
        "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
        ctx.project_id,
        actor.user_id,
      );
      return member !== undefined && member.role === "owner";
    });
    if (!allowed) throw new ApiError("forbidden", "a human project owner is required");
  }

  /** A code that is still good for this actor and project. It is only looked at; the command uses it up. */
  #peek_reauth(ctx: MutationContext, input: Record<string, unknown>): void {
    const code = parse_reauth_code_for_peek(input);
    const now = this.#deps.clock.now_ms();
    const good = this.#deps.service.read((db) => {
      const row = db.get<{ actor_id: string; project_id: string; expires_at: bigint; used_at: bigint | null }>(
        "SELECT actor_id, project_id, expires_at, used_at FROM ai_reauth_codes WHERE code_hash = ?",
        sha256(code),
      );
      return (
        row !== undefined &&
        row.actor_id === ctx.actor_id &&
        row.project_id === ctx.project_id &&
        row.used_at === null &&
        now < Number(row.expires_at)
      );
    });
    if (!good) throw new ApiError("forbidden", "re-authentication is required");
  }

  #read_connection(ctx: MutationContext, connection_id: string): DtoRow {
    const row = this.#deps.service.read((db) => {
      const owner = db.get<{ owner_user_id: string }>("SELECT owner_user_id FROM projects WHERE id = ?", ctx.project_id ?? "");
      const found = db.get<DtoRow & { removed_at: bigint | null }>(
        `SELECT ${DTO_COLUMNS}, removed_at FROM ai_connections WHERE id = ?`,
        connection_id,
      );
      if (owner === undefined || found === undefined || found.removed_at !== null || found.owner_user_id !== owner.owner_user_id) {
        return undefined;
      }
      return found;
    });
    if (row === undefined) throw new ApiError("not_found", "connection not found");
    return row;
  }

  // ---------------------------------------------------------------------
  // the HTTP side

  /** GET the model list. The reply text is never kept: only model ids and a short code. */
  async fetch_models(format: RequestFormat, base_url: string, key: string): Promise<ModelListing> {
    if (!is_supported_format(format)) return { ok: false, models: [], error_code: "unsupported" };
    const outcome = await http_json(
      { method: "GET", url: models_url(format, base_url), headers: auth_headers(format, key) },
      this.#deps.request_timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS,
      this.#deps.fetch,
    );
    if (outcome.kind === "timeout") return { ok: false, models: [], error_code: "timeout" };
    if (outcome.kind === "lost") return { ok: false, models: [], error_code: "unreachable" };
    if (outcome.status === 401 || outcome.status === 403) return { ok: false, models: [], error_code: "auth_failed" };
    if (outcome.status < 200 || outcome.status >= 300) return { ok: false, models: [], error_code: `http_${outcome.status}` };
    // a model list that hands the key back is refused as a whole: none of its ids goes further
    // (a check that could not finish refuses it too: fail closed)
    const key_check = reply_key_check(key, outcome.text, outcome.json);
    if (key_check !== "none") {
      this.#log(
        key_check === "key"
          ? "ai connection test: the model list came back with the key in it; refused"
          : "ai connection test: the model list could not be checked for the key; refused",
      );
      return { ok: false, models: [], error_code: key_check === "key" ? "key_in_reply" : "key_check_failed" };
    }
    let models: string[];
    try {
      models = parse_models(outcome.json);
    } catch (error) {
      if (error instanceof ReplyShapeError) return { ok: false, models: [], error_code: "bad_reply" };
      throw error;
    }
    return { ok: true, models, error_code: null };
  }

  async #test_or_refuse(format: RequestFormat, base_url: string, key: string): Promise<void> {
    if (!is_supported_format(format)) return;
    const listing = await this.fetch_models(format, base_url, key);
    if (!listing.ok) {
      this.#log(`ai connection test failed: ${listing.error_code ?? "unknown"}`);
      throw new ApiError("conflict", `the connection test failed (${listing.error_code ?? "unknown"})`);
    }
  }

  // ---------------------------------------------------------------------
  // key store, with fixed error texts

  async #put_key(ref: string, key: string): Promise<void> {
    try {
      await this.#deps.key_store.put(ref, key);
    } catch (error) {
      // the fixed texts below never carry the key or the tool's output
      if (error instanceof KeyStoreTimeoutError) throw new ApiError("conflict", "the key store did not answer in time; the key was not saved");
      throw new ApiError("conflict", "the key store could not save the key");
    }
  }

  async #get_key(ref: string): Promise<string | undefined> {
    try {
      return await this.#deps.key_store.get(ref);
    } catch {
      return undefined;
    }
  }

  async #delete_key(ref: string): Promise<void> {
    try {
      await this.#deps.key_store.delete(ref);
    } catch {
      this.#log("ai connection: the key store could not delete a key; remove it by hand");
    }
  }

  // ---------------------------------------------------------------------
  // public operations

  async issue_reauth(ctx: MutationContext): Promise<{ reauth_code: string }> {
    this.#require_human(ctx);
    const reauth_code = randomBytes(24).toString("base64url");
    await this.#deps.service.execute(ctx, "ai_connection.issue_reauth", { code_hash: sha256(reauth_code) });
    return { reauth_code };
  }

  async register(ctx: MutationContext, input: unknown): Promise<ConnectionDto> {
    this.#require_human(ctx);
    const fields = require_input(input);
    const name = parse_name(fields);
    const kind = parse_kind(fields);
    const base_url = parse_base_url(fields);
    const rules = parse_billing_rules(fields);
    const key = parse_api_key(fields);
    this.#peek_reauth(ctx, fields);

    const format = request_format_of(kind);
    await this.#test_or_refuse(format, base_url, key);

    const connection_id = new_id();
    const key_ref = `pes-ai-${connection_id}`;
    await this.#put_key(key_ref, key);
    try {
      await this.#deps.service.execute(ctx, "ai_connection.register", {
        reauth_code: fields["reauth_code"],
        connection_id,
        name,
        kind,
        base_url,
        billing: rules.billing,
        ...(rules.stop_percent === null ? {} : { stop_percent: rules.stop_percent }),
        ...(rules.limits === null ? {} : { subscription_limits: rules.limits }),
        ...(rules.cap === null ? {} : { cost_cap: rules.cap }),
        key_ref,
        key_last4: key_last4_of(key),
        key_storage: this.#deps.key_store.where(),
      });
    } catch (error) {
      await this.#delete_key(key_ref);
      throw error;
    }
    return this.#dto(ctx, connection_id);
  }

  async update(ctx: MutationContext, input: unknown): Promise<ConnectionDto> {
    this.#require_human(ctx);
    const fields = require_input(input);
    const connection_id = parse_connection_id(fields);
    const new_key = fields["api_key"] === undefined ? null : parse_api_key(fields);
    const base_url = fields["base_url"] === undefined ? null : parse_base_url(fields);
    if (fields["name"] !== undefined) parse_name(fields);
    this.#peek_reauth(ctx, fields);
    const first = this.#read_connection(ctx, connection_id);
    // every field is checked before anything is tested or stored, so a bad field never leaves a key behind
    check_update_fields(fields, first.billing);

    const payload: Record<string, unknown> = { reauth_code: fields["reauth_code"], connection_id };
    for (const field of ["name", "stop_percent", "subscription_limits", "cost_cap"] as const) {
      if (fields[field] !== undefined) payload[field] = fields[field];
    }
    if (base_url !== null) payload["base_url"] = base_url;
    if (new_key === null && base_url === null) {
      await this.#deps.service.execute(ctx, "ai_connection.update", payload);
      return this.#dto(ctx, connection_id);
    }

    return with_connection_lock(connection_id, async () => {
      // read again under the lock: an earlier request may have changed the connection meanwhile
      const current = this.#read_connection(ctx, connection_id);
      const key = new_key ?? (await this.#get_key(current.key_ref));
      if (key === undefined) throw new ApiError("conflict", "the stored key is missing; enter the key again");
      await this.#test_or_refuse(current.request_format as RequestFormat, base_url ?? current.base_url, key);

      let previous_key: string | undefined;
      if (new_key !== null) {
        previous_key = await this.#get_key(current.key_ref);
        await this.#put_key(current.key_ref, new_key);
        payload["key_last4"] = key_last4_of(new_key);
        payload["key_storage"] = this.#deps.key_store.where();
      }
      try {
        await this.#deps.service.execute(ctx, "ai_connection.update", payload);
      } catch (error) {
        if (new_key !== null) await this.#undo_key_change(current.key_ref, new_key, previous_key);
        throw error;
      }
      return this.#dto(ctx, connection_id);
    });
  }

  /** Puts the earlier key back, but only while the store still holds the key this request wrote. */
  async #undo_key_change(ref: string, written: string, previous: string | undefined): Promise<void> {
    const stored = await this.#get_key(ref);
    if (stored !== written) {
      this.#log("ai connection: the key changed again meanwhile; the failed change was not rolled back over it");
      return;
    }
    if (previous !== undefined) await this.#put_key(ref, previous).catch(() => undefined);
    else await this.#delete_key(ref);
  }

  async remove(ctx: MutationContext, input: unknown): Promise<{ connection_id: string; removed: true }> {
    this.#require_human(ctx);
    const fields = require_input(input);
    const connection_id = parse_connection_id(fields);
    this.#peek_reauth(ctx, fields);
    return with_connection_lock(connection_id, async () => {
      const out = await this.#deps.service.execute(ctx, "ai_connection.remove", {
        reauth_code: fields["reauth_code"],
        connection_id,
      });
      const key_ref = (out.result as { key_ref: string }).key_ref;
      await this.#delete_key(key_ref);
      return { connection_id, removed: true as const };
    });
  }

  /** Tests the saved connection against the provider and records that it was tested. */
  async test(ctx: MutationContext, input: unknown): Promise<ModelListing> {
    this.#require_human(ctx);
    const fields = require_input(input);
    const connection_id = parse_connection_id(fields);
    this.#peek_reauth(ctx, fields);
    const row = this.#read_connection(ctx, connection_id);
    // the address and the key are read together, never half way through a change (connection_snapshot)
    const snapshot = await connection_snapshot(this.#deps.db, this.#deps.key_store, row.id);
    const listing: ModelListing = !snapshot.ok
      ? { ok: false, models: [], error_code: snapshot.reason === "gone" ? "not_found" : snapshot.reason }
      : await this.fetch_models(snapshot.connection.request_format as RequestFormat, snapshot.connection.base_url, snapshot.key);
    await this.#deps.service.execute(ctx, "ai_connection.test", {
      reauth_code: fields["reauth_code"],
      connection_id,
      ok: listing.ok,
      error_code: listing.error_code,
      model_count: listing.models.length,
    });
    return listing;
  }

  async set_price(
    ctx: MutationContext,
    input: unknown,
  ): Promise<{ price_id: string; connection_id: string; model: string; entered_by: string; entered_at: number }> {
    this.#require_human(ctx);
    const fields = require_input(input);
    this.#peek_reauth(ctx, fields);
    const out = await this.#deps.service.execute(ctx, "ai_connection.set_price", {
      reauth_code: fields["reauth_code"],
      connection_id: fields["connection_id"],
      model: fields["model"],
      currency: fields["currency"],
      input_per_mtok_micros: fields["input_per_mtok_micros"],
      output_per_mtok_micros: fields["output_per_mtok_micros"],
    });
    const r = out.result as { price_id: string; connection_id: string; model: string; entered_by: string; entered_at: number };
    return { price_id: r.price_id, connection_id: r.connection_id, model: r.model, entered_by: r.entered_by, entered_at: r.entered_at };
  }

  /** project.set_ai_connection: the project's connection and model. Affects the next run, never a running one. */
  async select(ctx: MutationContext, input: unknown): Promise<{ project_id: string; connection_id: string; model: string }> {
    this.#require_human(ctx);
    const fields = require_input(input);
    const out = await this.#deps.service.execute(ctx, "project.set_ai_connection", {
      connection_id: fields["connection_id"],
      model: fields["model"],
    });
    const r = out.result as { project_id: string; connection_id: string; model: string };
    return { project_id: r.project_id, connection_id: r.connection_id, model: r.model };
  }

  /** The owner's connections (no secret in them). Open to any member of the project. */
  async list(ctx: MutationContext): Promise<ConnectionDto[]> {
    return this.#deps.service.read((db) => {
      if (ctx.project_id === null || ctx.actor_id === null) throw new ApiError("forbidden", "an actor is required");
      const actor = read_credential_actor(db, ctx.actor_id);
      const member =
        actor === undefined
          ? undefined
          : db.get<{ ok: bigint }>("SELECT 1 AS ok FROM project_members WHERE project_id = ? AND user_id = ?", ctx.project_id, actor.user_id);
      if (member === undefined) throw new ApiError("forbidden", "the actor is not a member of the project");
      const owner = db.get<{ owner_user_id: string }>("SELECT owner_user_id FROM projects WHERE id = ?", ctx.project_id);
      if (owner === undefined) throw new ApiError("not_found", "project not found");
      return db
        .all<DtoRow>(
          `SELECT ${DTO_COLUMNS} FROM ai_connections WHERE owner_user_id = ? AND removed_at IS NULL ORDER BY rowid`,
          owner.owner_user_id,
        )
        .map((row) => dto_of(db, row));
    });
  }

  #dto(ctx: MutationContext, connection_id: string): ConnectionDto {
    return this.#deps.service.read((db) => {
      const row = db.get<DtoRow>(`SELECT ${DTO_COLUMNS} FROM ai_connections WHERE id = ?`, connection_id);
      if (row === undefined) throw new ApiError("not_found", "connection not found");
      void ctx;
      return dto_of(db, row);
    });
  }
}

/** The checks ai_connection.update makes on the billing fields, made here before any side effect. */
function check_update_fields(fields: Record<string, unknown>, billing: string): void {
  if (fields["stop_percent"] !== undefined) {
    if (billing !== "subscription") throw new ApiError("invalid_payload", "stop_percent belongs to subscription billing");
    parse_stop_percent(fields["stop_percent"]);
  }
  if (fields["subscription_limits"] !== undefined) {
    if (billing !== "subscription") throw new ApiError("invalid_payload", "subscription_limits belongs to subscription billing");
    parse_limits(fields["subscription_limits"]);
  }
  if (fields["cost_cap"] !== undefined) {
    if (billing !== "pay_per_use") throw new ApiError("invalid_payload", "cost_cap belongs to pay_per_use billing");
    parse_cap(fields["cost_cap"]);
  }
}

function require_input(input: unknown): Record<string, unknown> {
  if (!is_plain(input)) throw new ApiError("invalid_payload", "the input must be an object");
  return input;
}

function parse_reauth_code_for_peek(input: Record<string, unknown>): string {
  // A missing or malformed code is a re-authentication failure here, not a payload error.
  try {
    return parse_reauth_code(input);
  } catch {
    throw new ApiError("forbidden", "re-authentication is required");
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

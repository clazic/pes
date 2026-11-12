// SEL-52 (stage 2 PR19, "A 내장 실행기") shared harness. Everything is synthetic: invented keys, invented
// model ids, a temporary HOME/PES_HOME, a FakeClock, an in-memory key store (the real OS keychain is never
// touched) and a FAKE HTTP server on 127.0.0.1 that speaks the two request formats the leader fixed
// (openai_compatible = Chat Completions, anthropic = Messages). No real provider, key, or money is involved.
//
// ---------------------------------------------------------------------------------------------------------
// INTERFACE THE TESTS PIN (the worker implements it; docs/plan/decisions/0019 leaves the names open, the
// leader's ledger '## SEL-52' fixes the rules, this file fixes the spelling). Every spelling lives in this
// header and in the ONE adapter section below ("pinned names"), so a disagreement is a one-place fix.
//
//   scripts/pes_core/a_runtime/tools.ts
//     A_TOOL_ALLOWLIST: readonly string[]   exactly the 8 names below, nothing else
//       context.get result.submit question.ask assumption.propose decision.propose reflection.write
//       thread.reply followup.propose
//
//   scripts/pes_core/a_runtime/connections.ts
//     class AiConnectionService(deps: AiDeps)         (the facade over the ai_connection.* commands; the
//                                                       api key goes to deps.key_store, never into a command
//                                                       payload, receipt, event, or table)
//       issue_reauth(ctx)                -> { reauth_code }                      human owner only; single use
//       register(ctx, input)             -> ConnectionDto
//       update(ctx, input)               -> ConnectionDto
//       remove(ctx, input)               -> { connection_id, removed: true }
//       test(ctx, input)                 -> { ok: boolean, models: string[], error_code: string | null }
//       set_price(ctx, input)            -> { price_id, connection_id, model, entered_by, entered_at }
//       select(ctx, input)               -> { project_id, connection_id, model }   (= project.set_ai_connection)
//       list(ctx)                        -> ConnectionDto[]
//     registry commands (service.execute): ai_connection.register / update / remove / test / set_price,
//       project.set_ai_connection, dispatch.resolve_unknown.  A payload with an `api_key` field is invalid_payload.
//
//   scripts/pes_core/a_runtime/loop.ts
//     class BuiltinExecutor(deps: AiDeps)
//       start(input)   -> ExecResult     owner creates the run (run.create, mode A, runtime pes_builtin, model =
//                                        the project's selected model), the executor claims it as the internal_ai
//                                        actor and loops until succeeded / waiting_human / blocked_usage /
//                                        failed / interrupted.
//       resume(input)  -> ExecResult     the human owner resumes a waiting_human / blocked_usage run (new claim,
//                                        new fence, readiness + policy + usage re-checked).
//
//   AiDeps = { service, db, clock, key_store, log?: (line) => void, save_retries?: number (default 2),
//              request_timeout_ms?: number (default 30_000) }
//   KeyStore = { put(ref, secret), get(ref) -> string | undefined, delete(ref), where() -> string }
//   ConnectionDto = { connection_id, name, kind, request_format, supported, base_url, billing, key_last4,
//                     key_storage, key_set_at, key_set_by, stop_percent | null, subscription_limits | null,
//                     cost_cap | null, prices: [{model, currency, input_per_mtok_micros, output_per_mtok_micros,
//                     entered_by, entered_at}] }
//   ExecResult = { run_id, status, block_reason: string | null, interrupt_reason: string | null,
//                  reset_at: number | null, question_set_id: string | null }
//
// Rules the tests pin (from the leader's decision and 0019/0013):
//   * request formats: kind openai_compatible | subscription_api | custom -> openai_compatible; anthropic ->
//     anthropic; google -> registered but NOT executable (unsupported). Model list: GET <base>/models
//     (openai base ends in /v1) or <base>/v1/models (anthropic). Chat: POST .../chat/completions, .../v1/messages.
//   * the connection test is done by the PES server against the (fake) HTTP server, before the connection is saved.
//   * subscription billing: stop at stop_percent (default 90) of the human-entered limits (5h / week / month
//     windows) counted from PES's own token counts + a reservation for the next call; unknown limit -> no start.
//   * pay_per_use billing: cost_cap and a price for the model are mandatory; cost = tokens x price (integer
//     micro-units per million tokens); spent + reservation for the next call over the cap -> stop BEFORE sending;
//     no price -> no start. Price/stop settings are snapshotted at run start.
//   * one run = one model, no fallback. runs.runtime = pes_builtin, runs.model = the real model id.
//   * every model call = one outbound_dispatches row, written BEFORE the HTTP request. A lost response, a
//     timeout, or a failed save leaves state 'unknown' and the executor never calls the model again for it.
//   * block (usage / cap / unknown) -> runs.status blocked_usage (+go_block_reason, go_blocked_at,
//     go_block_reset_at), the lease is released, and only a human resume continues.
// ---------------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { AiConnectionService } from "../../scripts/pes_core/a_runtime/connections.ts";
import { BuiltinExecutor } from "../../scripts/pes_core/a_runtime/loop.ts";
import type { Db } from "../../scripts/pes_core/db.ts";
import type { MutationContext } from "../../scripts/pes_core/commands.ts";
import { ApiError } from "../../scripts/pes_core/errors.ts";
import { set_policy } from "../../scripts/pes_core/policy.ts";
import { make_env, new_artifact, type Env } from "./blob_env.ts";
import { start as start_round_for, approve, seal, stage_ids, type StageKey } from "./editions_env.ts";

export { with_env, wrap_db, rejects_api, START_MS } from "./blob_env.ts";

// ---------------------------------------------------------------------------
// types of the pinned interface

export type Format = "openai_compatible" | "anthropic";

export interface KeyStore {
  put(ref: string, secret: string): void | Promise<void>;
  get(ref: string): string | undefined | Promise<string | undefined>;
  delete(ref: string): void | Promise<void>;
  where(): string;
}

export interface AiDeps {
  service: Env["service"];
  db: Db;
  clock: Env["clock"];
  key_store: KeyStore;
  log?: (line: string) => void;
  save_retries?: number;
  request_timeout_ms?: number;
}

export interface ExecResult {
  run_id: string;
  status: "succeeded" | "waiting_human" | "blocked_usage" | "failed" | "interrupted";
  block_reason: string | null;
  /** interrupted only: the reason on the run.interrupted event (SEL-113 F2: reference_withdrawn), else null */
  interrupt_reason: string | null;
  reset_at: number | null;
  question_set_id: string | null;
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
  prices: Array<{
    model: string;
    currency: string;
    input_per_mtok_micros: number;
    output_per_mtok_micros: number;
    entered_by: string;
    entered_at: number;
  }>;
}

// ---------------------------------------------------------------------------
// synthetic constants

/** Looks like a key; the middle part is what the leak scans search for (never printed by a test). */
export const SYNTHETIC_KEY = "sk-synthetic-canary-8f3a91c7d2e45b60";
export const KEY_MIDDLE = "8f3a91c7d2e4";
export const KEY_LAST4 = "5b60";
export const MODEL_A = "synthetic-model-a";
export const MODEL_B = "synthetic-model-b";
export const FIVE_HOURS = 5 * 3_600_000;
export const WEEK = 7 * 24 * 3_600_000;
export const MONTH = 30 * 24 * 3_600_000;

export const A_TOOLS = [
  "context.get",
  "result.submit",
  "question.ask",
  "assumption.propose",
  "decision.propose",
  "reflection.write",
  "thread.reply",
  "followup.propose",
] as const;

// ---------------------------------------------------------------------------
// in-memory key store (the OS keychain is never used by a test)

export class FakeKeyStore implements KeyStore {
  readonly keys = new Map<string, string>();
  puts = 0;
  deletes = 0;
  /** runs right AFTER a secret was stored (a test can hold one writer here while another request goes through) */
  after_put?: (ref: string, secret: string) => Promise<void>;
  put(ref: string, secret: string): void | Promise<void> {
    this.puts += 1;
    this.keys.set(ref, secret);
    return this.after_put === undefined ? undefined : this.after_put(ref, secret);
  }
  get(ref: string): string | undefined {
    return this.keys.get(ref);
  }
  delete(ref: string): void {
    this.deletes += 1;
    this.keys.delete(ref);
  }
  where(): string {
    return "fake-memory-store";
  }
}

// ---------------------------------------------------------------------------
// the fake HTTP server

export interface ScriptedTurn {
  /** tool calls the "model" makes in this turn (rendered in the format's own shape) */
  tools?: Array<{ name: string; args: unknown }>;
  text?: string;
  usage?: { input: number; output: number };
  /** answer with this HTTP error instead of a completion (e.g. 429 with retry-after) */
  http?: { status: number; headers?: Record<string, string>; body?: unknown };
  /** close the socket without any reply (a lost response) */
  drop?: boolean;
  /** wait this long before replying (a timeout when longer than request_timeout_ms) */
  delay_ms?: number;
  /** leave the usage field out of the reply (a provider that does not report it) */
  omit_usage?: boolean;
  /** answer 200 (or `status`) with exactly this body text — a truncated JSON, an event stream, an empty body */
  raw_body?: { text: string; content_type?: string; status?: number };
  /** openai_compatible only: the `arguments` string of each tool call, sent as is (e.g. cut-off JSON) */
  raw_arguments?: string[];
  /** override the finish reason (openai finish_reason / anthropic stop_reason), e.g. "length" / "max_tokens" */
  finish?: string;
  /** extra top-level fields of the reply body (a provider's own billing hints, e.g. { billing_source, cost }) */
  extra_body?: Record<string, unknown>;
}

export interface Recorded {
  n: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  text: string;
  json: any;
}

export class FakeAi {
  readonly format: Format;
  expected_key: string;
  models: string[] = [MODEL_A, MODEL_B];
  /** every request, models listing included */
  readonly all: Recorded[] = [];
  /** only chat/messages requests, in arrival order */
  readonly calls: Recorded[] = [];
  script: ScriptedTurn[] | ((n: number, rec: Recorded) => ScriptedTurn) = [];
  /** runs after the request arrived and before the reply; n is the 1-based call number */
  on_call?: (n: number, rec: Recorded) => void | Promise<void>;
  /** 401 on models listing (a wrong key) */
  models_status = 200;
  /** more keys the server accepts besides expected_key (two key changes in flight) */
  readonly accepted_keys = new Set<string>();
  /**
   * Like the real providers (OpenAI Chat Completions, Anthropic Messages): a tool name must match
   * ^[a-zA-Z0-9_-]{1,64}$ — in the offered tools AND in earlier assistant tool calls of the history. A request
   * that breaks it is answered 400 and never reaches the script. (SEL-52 final review F1.) Set
   * A_FAKE_LOOSE_TOOL_NAMES=1 only to look at a pre-fix tree; never in a committed run.
   */
  strict_tool_names = process.env["A_FAKE_LOOSE_TOOL_NAMES"] !== "1";
  #server: Server;
  #sockets = new Set<import("node:net").Socket>();
  #origin = "";

  private constructor(format: Format, expected_key: string, server: Server) {
    this.format = format;
    this.expected_key = expected_key;
    this.#server = server;
  }

  static async start(format: Format, expected_key = SYNTHETIC_KEY): Promise<FakeAi> {
    const server = createServer();
    const fake = new FakeAi(format, expected_key, server);
    server.on("connection", (socket) => {
      fake.#sockets.add(socket);
      socket.on("close", () => fake.#sockets.delete(socket));
    });
    server.on("request", (req, res) => {
      void fake.#handle(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    fake.#origin = `http://127.0.0.1:${address.port}`;
    return fake;
  }

  /** the base_url a user types: openai bases end in /v1, anthropic bases do not */
  get base_url(): string {
    return this.format === "anthropic" ? this.#origin : `${this.#origin}/v1`;
  }

  get origin(): string {
    return this.#origin;
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  /** request bodies of the calls, parsed */
  bodies(): any[] {
    return this.calls.map((c) => c.json);
  }

  /** the whole traffic as one string (headers + bodies), for leak scans of what PES SENT */
  body_text_without_auth(): string {
    return this.all.map((r) => `${r.method} ${r.path}\n${r.text}`).join("\n");
  }

  #auth_ok(headers: Record<string, string>): boolean {
    const keys = [this.expected_key, ...this.accepted_keys];
    if (this.format === "anthropic") {
      return keys.includes(headers["x-api-key"] ?? "") && typeof headers["anthropic-version"] === "string";
    }
    return keys.some((key) => headers["authorization"] === `Bearer ${key}`);
  }

  #error_body(status: number, message: string): unknown {
    return this.format === "anthropic"
      ? { type: "error", error: { type: status === 401 ? "authentication_error" : "api_error", message } }
      : { error: { message, type: status === 401 ? "invalid_request_error" : "server_error", code: null } };
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : (v ?? "");
    let json: any = null;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const path = (req.url ?? "").split("?")[0] ?? "";
    // SEL-78: every reply closes its connection. PES never retries a model call, so a reused keep-alive socket that the
    // server closes at the very moment the client reuses it (a runner that stalls for seconds, Windows CI) would look
    // like a lost answer and block the run as usage_unknown. A fresh connection per request removes that race.
    res.setHeader("connection", "close");
    const rec: Recorded = { n: 0, method: req.method ?? "", path, headers, text, json };
    this.all.push(rec);
    const send = (status: number, body: unknown, extra: Record<string, string> = {}): void => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", ...extra });
      res.end(payload);
    };
    if (!this.#auth_ok(headers)) {
      send(401, this.#error_body(401, "invalid api key"));
      return;
    }
    if (req.method === "GET" && path.endsWith("/models")) {
      if (this.models_status !== 200) {
        send(this.models_status, this.#error_body(this.models_status, "models unavailable"));
        return;
      }
      if (this.format === "anthropic") {
        send(200, {
          data: this.models.map((id) => ({ type: "model", id, display_name: id, created_at: "2025-01-01T00:00:00Z" })),
          has_more: false,
          first_id: this.models[0] ?? null,
          last_id: this.models[this.models.length - 1] ?? null,
        });
      } else {
        send(200, { object: "list", data: this.models.map((id) => ({ id, object: "model", created: 0, owned_by: "synthetic" })) });
      }
      return;
    }
    const chat_path = this.format === "anthropic" ? "/messages" : "/chat/completions";
    if (req.method === "POST" && path.endsWith(chat_path)) {
      this.calls.push(rec);
      rec.n = this.calls.length;
      const bad_names = this.strict_tool_names ? invalid_tool_names(rec.json) : [];
      if (bad_names.length > 0) {
        send(400, this.#error_body(400, `invalid tool name: ${JSON.stringify(bad_names)} must match ^[a-zA-Z0-9_-]{1,64}$`));
        return;
      }
      if (this.on_call !== undefined) await this.on_call(rec.n, rec);
      const turn = typeof this.script === "function" ? this.script(rec.n, rec) : (this.script[rec.n - 1] ?? { text: "완료" });
      if (turn.delay_ms !== undefined) await new Promise((r) => setTimeout(r, turn.delay_ms));
      if (turn.drop === true) {
        req.socket.destroy();
        return;
      }
      if (turn.raw_body !== undefined) {
        res.writeHead(turn.raw_body.status ?? 200, { "content-type": turn.raw_body.content_type ?? "application/json" });
        res.end(turn.raw_body.text);
        return;
      }
      if (turn.http !== undefined) {
        send(turn.http.status, turn.http.body ?? this.#error_body(turn.http.status, "synthetic error"), turn.http.headers ?? {});
        return;
      }
      send(200, this.#render(turn, rec));
      return;
    }
    send(404, this.#error_body(404, "not found"));
  }

  #render(turn: ScriptedTurn, rec: Recorded): unknown {
    const usage = turn.usage ?? { input: 100, output: 50 };
    const tools = turn.tools ?? [];
    const model = rec.json?.model ?? "unknown";
    const extra = turn.extra_body ?? {};
    const wire_names = offered_wire_names(rec.json);
    // the "model" answers with the name it was OFFERED (the wire name); scripts keep writing PES's internal names
    // only the exact internal names are translated; a forged or odd name goes out as the script spelled it
    const wire = (internal: string): string =>
      (A_TOOLS as readonly string[]).includes(internal) ? (wire_names.find((w) => name_key(w) === name_key(internal)) ?? internal) : internal;
    if (this.format === "anthropic") {
      const content: unknown[] = [];
      if (turn.text !== undefined) content.push({ type: "text", text: turn.text });
      tools.forEach((t, i) => content.push({ type: "tool_use", id: `toolu_${rec.n}_${i}`, name: wire(t.name), input: t.args }));
      return {
        id: `msg_${rec.n}`,
        type: "message",
        role: "assistant",
        model,
        content,
        stop_reason: turn.finish ?? (tools.length > 0 ? "tool_use" : "end_turn"),
        stop_sequence: null,
        ...(turn.omit_usage === true ? {} : { usage: { input_tokens: usage.input, output_tokens: usage.output } }),
        ...extra,
      };
    }
    return {
      id: `chatcmpl-${rec.n}`,
      object: "chat.completion",
      created: 0,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: turn.text ?? null,
            ...(tools.length > 0
              ? {
                  tool_calls: tools.map((t, i) => ({
                    id: `call_${rec.n}_${i}`,
                    type: "function",
                    function: { name: wire(t.name), arguments: turn.raw_arguments?.[i] ?? JSON.stringify(t.args) },
                  })),
                }
              : {}),
          },
          finish_reason: turn.finish ?? (tools.length > 0 ? "tool_calls" : "stop"),
        },
      ],
      ...(turn.omit_usage === true
        ? {}
        : { usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output } }),
      ...extra,
    };
  }
}

/** a name compared without its separators: "context.get" and "context_get" are the same tool */
function name_key(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** the tool names exactly as a request carried them (the provider's own spelling), in either format */
export function offered_wire_names(body: any): string[] {
  const tools: any[] = body?.tools ?? [];
  return tools.map((t) => (t.function !== undefined ? t.function.name : t.name));
}

/** tool names a request offered to the model, mapped back to PES's internal names (A_TOOLS), sorted */
export function offered_tools(body: any): string[] {
  return offered_wire_names(body)
    .map((wire) => (A_TOOLS as readonly string[]).find((internal) => name_key(internal) === name_key(wire)) ?? wire)
    .sort();
}

export const PROVIDER_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** every tool name of a request (offered tools and earlier assistant tool calls) that a provider would refuse */
export function invalid_tool_names(body: any): string[] {
  const names: unknown[] = [...offered_wire_names(body)];
  for (const message of body?.messages ?? []) {
    for (const call of message?.tool_calls ?? []) names.push(call?.function?.name);
    if (Array.isArray(message?.content)) {
      for (const block of message.content) if (block?.type === "tool_use") names.push(block.name);
    }
  }
  return names.filter((n) => typeof n !== "string" || !PROVIDER_TOOL_NAME.test(n)).map(String);
}

/** max output tokens a request allowed (openai max_tokens / max_completion_tokens, anthropic max_tokens) */
export function max_tokens_of(body: any): number | undefined {
  return body?.max_tokens ?? body?.max_completion_tokens;
}

// ---------------------------------------------------------------------------
// the environment

export interface AEnv extends Env {
  format: Format;
  fake: FakeAi;
  keys: FakeKeyStore;
  logs: string[];
  deps: AiDeps;
  exec: BuiltinExecutor;
  conns: AiConnectionService;
  ai_actor_id: string;
  seq: number;
  /** a ctx for an agent (non-human) actor of the project */
  agent_ctx(actor_id: string, key: string): MutationContext;
  close_all(): Promise<void>;
}

export interface MakeAOptions {
  save_retries?: number;
  request_timeout_ms?: number;
  wrap?: (db: Db) => Db;
}

export async function make_a_env(format: Format = "openai_compatible", options: MakeAOptions = {}): Promise<AEnv> {
  const base = await make_env();
  const fake = await FakeAi.start(format);
  const keys = new FakeKeyStore();
  const logs: string[] = [];
  const user = base.db.get<{ owner_user_id: string }>("SELECT owner_user_id FROM projects WHERE id = ?", base.p.project_id);
  assert.ok(user);
  const ai_actor_id = "actor-ai-builtin";
  base.db.run(
    "INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, 'internal_ai', ?, '합성 내장 AI')",
    ai_actor_id,
    user.owner_user_id,
  );
  const service = options.wrap === undefined ? base.service : base.with_db(options.wrap(base.db));
  const deps: AiDeps = {
    service,
    db: base.db,
    clock: base.clock,
    key_store: keys,
    log: (line: string) => {
      logs.push(line);
    },
    ...(options.save_retries === undefined ? {} : { save_retries: options.save_retries }),
    ...(options.request_timeout_ms === undefined ? {} : { request_timeout_ms: options.request_timeout_ms }),
  };
  const env = base as AEnv;
  env.format = format;
  env.fake = fake;
  env.keys = keys;
  env.logs = logs;
  env.deps = deps;
  env.exec = new BuiltinExecutor(deps);
  env.conns = new AiConnectionService(deps);
  env.ai_actor_id = ai_actor_id;
  env.seq = 0;
  env.agent_ctx = (actor_id, key) => ({
    project_id: base.p.project_id,
    actor_id,
    via: "cli",
    client_request_id: key,
  });
  const original_close = base.close;
  env.close_all = async () => {
    await fake.close();
    original_close();
  };
  return env;
}

export async function with_a_env(
  format: Format,
  fn: (env: AEnv) => Promise<void> | void,
  options: MakeAOptions = {},
): Promise<void> {
  const env = await make_a_env(format, options);
  try {
    await fn(env);
  } finally {
    await env.close_all();
  }
}

export function next_key(env: AEnv, tag = "k"): string {
  env.seq += 1;
  return `${tag}-${env.seq}`;
}

// ---------------------------------------------------------------------------
// connection setup

export interface RegisterOverrides {
  name?: string;
  kind?: string;
  base_url?: string;
  api_key?: string;
  billing?: "subscription" | "pay_per_use";
  stop_percent?: number;
  subscription_limits?: { five_hour_tokens: number; weekly_tokens: number; monthly_tokens: number } | null;
  cost_cap?: { currency: string; amount_micros: number } | null;
  extra?: Record<string, unknown>;
  /** subscription only: do NOT record the "extra charge is OFF" confirmation and the usage baseline */
  no_guard?: boolean;
}

export const DEFAULT_LIMITS = { five_hour_tokens: 10_000, weekly_tokens: 100_000, monthly_tokens: 400_000 };
export const DEFAULT_CAP = { currency: "USD", amount_micros: 10_000 };

export async function reauth(env: AEnv, ctx: MutationContext = env.ctx(next_key(env, "reauth"))): Promise<string> {
  const out = await env.conns.issue_reauth(ctx);
  assert.equal(typeof out.reauth_code, "string");
  return out.reauth_code;
}

/** Register a connection to the fake server (subscription billing with limits by default). */
export async function register_connection(env: AEnv, o: RegisterOverrides = {}): Promise<ConnectionDto> {
  const billing = o.billing ?? "subscription";
  const kind = o.kind ?? (env.format === "anthropic" ? "anthropic" : "openai_compatible");
  const input: Record<string, unknown> = {
    reauth_code: await reauth(env),
    name: o.name ?? "합성 연결",
    kind,
    base_url: o.base_url ?? env.fake.base_url,
    api_key: o.api_key ?? SYNTHETIC_KEY,
    billing,
    ...(o.stop_percent === undefined ? {} : { stop_percent: o.stop_percent }),
    ...(billing === "subscription"
      ? { subscription_limits: o.subscription_limits === undefined ? DEFAULT_LIMITS : o.subscription_limits }
      : { cost_cap: o.cost_cap === undefined ? DEFAULT_CAP : o.cost_cap }),
    ...(o.extra ?? {}),
  };
  if (input["subscription_limits"] === null) delete input["subscription_limits"];
  if (input["cost_cap"] === null) delete input["cost_cap"];
  const dto = (await env.conns.register(env.ctx(next_key(env, "reg")), input)) as ConnectionDto;
  if (billing === "subscription" && o.no_guard !== true) await record_guard(env, dto.connection_id);
  return dto;
}

// ---------------------------------------------------------------------------
// subscription protection (SEL-52 final review F4): a person records, per connection, that the provider's
// "extra charge" option is OFF (with an account scope and a validity period) and the account's usage baseline.
// A subscription call needs both, still valid. THE COMMAND NAMES AND PAYLOAD FIELDS ARE NOT FIXED YET: they live
// ONLY in this block (GUARD_COMMANDS + the two payload builders); every test goes through confirm_off() /
// record_baseline() / record_guard(). Renaming the senior's commands = editing this block, nothing else.

export const GUARD_COMMANDS = {
  confirm_off: "ai_connection.confirm_extra_charge_off",
  record_baseline: "ai_connection.record_usage_baseline",
} as const;

/** "valid for" of a default confirmation: longer than every window a test advances the clock over */
export const GUARD_VALID_MS = 400 * 24 * 3_600_000;

export interface ConfirmOffInput {
  /** how long the confirmation lasts from now */
  valid_ms?: number;
  /** the account the person looked at */
  account_scope?: string;
}

function confirm_off_payload(connection_id: string, reauth_code: string, o: ConfirmOffInput): Record<string, unknown> {
  return {
    reauth_code,
    connection_id,
    account_scope: o.account_scope ?? "synthetic-account",
    valid_for_ms: o.valid_ms ?? GUARD_VALID_MS,
  };
}

function baseline_payload(connection_id: string, reauth_code: string, used_tokens: number): Record<string, unknown> {
  return { reauth_code, connection_id, account_used_tokens: used_tokens };
}

/** the human owner records "extra charge is OFF" for a connection (the context may be replaced to try other actors) */
export async function confirm_off(
  env: AEnv,
  connection_id: string,
  o: ConfirmOffInput = {},
  ctx: MutationContext = env.ctx(next_key(env, "off")),
): Promise<unknown> {
  return env.service.execute(ctx, GUARD_COMMANDS.confirm_off, confirm_off_payload(connection_id, await reauth(env), o));
}

/** the human owner records the account's usage baseline */
export async function record_baseline(
  env: AEnv,
  connection_id: string,
  used_tokens = 0,
  ctx: MutationContext = env.ctx(next_key(env, "base")),
): Promise<unknown> {
  return env.service.execute(ctx, GUARD_COMMANDS.record_baseline, baseline_payload(connection_id, await reauth(env), used_tokens));
}

/**
 * Both records, long valid. Until the commands exist a missing command is skipped so the older tests keep
 * running; the F4 tests call confirm_off / record_baseline directly and fail loudly instead.
 */
export async function record_guard(env: AEnv, connection_id: string): Promise<void> {
  for (const step of [() => confirm_off(env, connection_id), () => record_baseline(env, connection_id)]) {
    try {
      await step();
    } catch (error) {
      if (error instanceof ApiError && error.code === "unknown_command") return;
      throw error;
    }
  }
}

export interface PriceInput {
  model?: string;
  currency?: string;
  input_per_mtok_micros?: number;
  output_per_mtok_micros?: number;
}

export async function set_price(env: AEnv, connection_id: string, p: PriceInput = {}): Promise<any> {
  return env.conns.set_price(env.ctx(next_key(env, "price")), {
    reauth_code: await reauth(env),
    connection_id,
    model: p.model ?? MODEL_A,
    currency: p.currency ?? "USD",
    input_per_mtok_micros: p.input_per_mtok_micros ?? 1_000_000,
    output_per_mtok_micros: p.output_per_mtok_micros ?? 2_000_000,
  });
}

export async function select_model(env: AEnv, connection_id: string, model: string = MODEL_A): Promise<any> {
  return env.conns.select(env.ctx(next_key(env, "sel")), { connection_id, model });
}

/** register + (price for pay_per_use) + select: a project ready to start a run. */
export async function ready_project(env: AEnv, o: RegisterOverrides = {}, model: string = MODEL_A): Promise<ConnectionDto> {
  const dto = await register_connection(env, o);
  if ((o.billing ?? "subscription") === "pay_per_use") await set_price(env, dto.connection_id, { model });
  await select_model(env, dto.connection_id, model);
  return dto;
}

// ---------------------------------------------------------------------------
// starting / reading runs

export interface StartOverrides {
  stage_id?: string;
  round_id?: string | null;
  max_output_tokens?: number;
  max_turns?: number;
}

export async function start_run(env: AEnv, o: StartOverrides = {}): Promise<ExecResult> {
  const stage = o.stage_id ?? stage_of(env, "plan");
  return (await env.exec.start({
    owner_ctx: env.ctx(next_key(env, "start")),
    actor_id: env.ai_actor_id,
    stage_id: stage,
    round_id: o.round_id === undefined ? open_round_id(env, stage) : o.round_id,
    max_output_tokens: o.max_output_tokens ?? 500,
    ...(o.max_turns === undefined ? {} : { max_turns: o.max_turns }),
  })) as ExecResult;
}

export async function resume_run(env: AEnv, run_id: string, o: { max_output_tokens?: number } = {}): Promise<ExecResult> {
  return (await env.exec.resume({
    owner_ctx: env.ctx(next_key(env, "resume")),
    run_id,
    max_output_tokens: o.max_output_tokens ?? 500,
  })) as ExecResult;
}

export function stage_of(env: AEnv, key: string): string {
  const row = env.db.get<{ id: string }>(
    "SELECT id FROM stages WHERE edition_id = ? AND key = ?",
    env.p.edition_id,
    key,
  );
  assert.ok(row, `stage ${key}`);
  return row.id;
}

/** the latest open round of a stage (none -> null; the tests start rounds with round.start first) */
export function open_round_id(env: AEnv, stage_id: string): string | null {
  const row = env.db.get<{ id: string }>(
    "SELECT id FROM rounds WHERE stage_id = ? ORDER BY round_no DESC LIMIT 1",
    stage_id,
  );
  return row?.id ?? null;
}

export interface RunRow {
  id: string;
  status: string;
  mode: string;
  runtime: string;
  provider: string;
  model: string;
  stage_id: string | null;
  round_id: string | null;
  actor_id: string;
  go_block_reason: string | null;
  go_blocked_at: bigint | null;
  go_block_reset_at: bigint | null;
}

export function run_row(env: AEnv, run_id: string): RunRow {
  const row = env.db.get<RunRow>("SELECT * FROM runs WHERE id = ?", run_id);
  assert.ok(row, "run row");
  return row;
}

export function all_runs(env: AEnv): RunRow[] {
  return env.db.all<RunRow>("SELECT * FROM runs ORDER BY rowid");
}

export interface DispatchRow {
  id: string;
  run_id: string;
  state: string;
  request_key: string;
  payload_hash: string;
  external_request_id: string | null;
  sent_at: bigint | null;
  response_hash: string | null;
  adopted_version_id: string | null;
  usage_json: string | null;
  cost_json: string | null;
  unknown_at: bigint | null;
  unknown_reason: string | null;
}

export function dispatches(env: AEnv, run_id?: string): DispatchRow[] {
  return run_id === undefined
    ? env.db.all<DispatchRow>("SELECT * FROM outbound_dispatches ORDER BY rowid")
    : env.db.all<DispatchRow>("SELECT * FROM outbound_dispatches WHERE run_id = ? ORDER BY rowid", run_id);
}

export function lease_state(env: AEnv): { state: string; run_id: string | null; fence: bigint } | undefined {
  return env.db.get("SELECT state, run_id, fence FROM project_leases WHERE project_id = ?", env.p.project_id);
}

export function events_by_type(env: AEnv, type: string): Array<{ run_id: string | null; payload: string }> {
  return env.db.all("SELECT run_id, payload FROM events WHERE project_id = ? AND type = ? ORDER BY event_seq", env.p.project_id, type);
}

export async function policy_off(env: AEnv, tag = "off"): Promise<void> {
  await set_policy(env.service, env.ctx(next_key(env, tag)), { allow_opencode_go: false, reason: "합성: AI 연결 끄기" });
}

export async function policy_on(env: AEnv, tag = "on"): Promise<void> {
  await set_policy(env.service, env.ctx(next_key(env, tag)), { allow_opencode_go: true, reason: "합성: AI 연결 켜기" });
}

/** a scripted turn that reads the context and then a turn that finishes */
export const FINISH: ScriptedTurn = { text: "완료" };

// ---------------------------------------------------------------------------
// assertion helpers

export async function rejects_one_of(p: Promise<unknown> | unknown, ...codes: string[]): Promise<ApiError> {
  try {
    await p;
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError ${codes.join("|")}, got ${String(error)}`);
    assert.ok(codes.includes(error.code), `expected ${codes.join("|")}, got ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected the call to be rejected with ${codes.join("|")}`);
}

/** Replaces bigint so a table dump can be searched as text. */
function plain(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("latin1");
  return value;
}

/** Every row of every table, plus every file under the objects folder, as one searchable string. */
export function everything_stored(env: AEnv): string {
  const parts: string[] = [];
  const tables = env.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  for (const t of tables) {
    for (const row of env.db.all<Record<string, unknown>>(`SELECT * FROM "${t.name}"`)) {
      parts.push(`${t.name} ${JSON.stringify(row, (_k, v) => plain(v))}`);
    }
  }
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else parts.push(`file ${name} ${readFileSync(full).toString("latin1")}`);
    }
  };
  walk(env.objects);
  return parts.join("\n");
}

export function assert_no_key(text: string, where: string): void {
  assert.equal(text.includes(SYNTHETIC_KEY), false, `the api key must not appear in ${where}`);
  assert.equal(text.includes(KEY_MIDDLE), false, `a piece of the api key must not appear in ${where}`);
}

/** The model ids of the chat requests, in order. */
export function models_sent(env: AEnv): string[] {
  return env.fake.bodies().map((b) => b.model);
}

/** result.submit tool call that appends one version to an artifact object (the command's own item shape). */
export function submit_turn(object_id: string, title: string, usage?: { input: number; output: number }): ScriptedTurn {
  return {
    tools: [{ name: "result.submit", args: { results: [{ op: "append_version", object_id, title }] } }],
    ...(usage === undefined ? {} : { usage }),
  };
}

export function context_turn(usage?: { input: number; output: number }): ScriptedTurn {
  return { tools: [{ name: "context.get", args: {} }], ...(usage === undefined ? {} : { usage }) };
}

// ---------------------------------------------------------------------------
// stage driving (the human owner opens a round; the executor works inside it; the owner seals and approves)

export interface Opened {
  stage_id: string;
  round_id: string;
  object_id: string;
  base_version_id: string;
}

/** Owner starts a round of the stage and a chapter object (with its first version) for the model to extend. */
export async function open_stage(env: AEnv, key: StageKey, tag: string = key): Promise<Opened> {
  const stage_id = stage_ids(env.db, env.p.edition_id)[key];
  const round = await start_round_for(env, stage_id, `${tag}-round`);
  const art = await new_artifact(env, `${tag}-art`);
  return { stage_id, round_id: round.round_id, object_id: art.object_id, base_version_id: art.version_id };
}

/** Versions the run appended (result.submit) to an object, newest last. */
export function versions_of_run(env: AEnv, run_id: string): Array<{ object_id: string; version_id: string }> {
  return env.db
    .all<{ object_id: string; id: string }>("SELECT object_id, id FROM object_versions WHERE run_id = ? ORDER BY version_no", run_id)
    .map((r) => ({ object_id: r.object_id, version_id: r.id }));
}

/**
 * Only the artifact versions a run appended. Under a lease, question.publish_set also stamps run_id on the
 * question object's version (PR8 behaviour), so a run that asked a human owns more than its result versions.
 */
export function artifact_versions_of_run(env: AEnv, run_id: string): Array<{ object_id: string; version_id: string }> {
  return env.db
    .all<{ object_id: string; id: string }>(
      `SELECT v.object_id AS object_id, v.id AS id FROM object_versions v JOIN objects o ON o.id = v.object_id
        WHERE v.run_id = ? AND o.kind = 'artifact' ORDER BY v.version_no`,
      run_id,
    )
    .map((r) => ({ object_id: r.object_id, version_id: r.id }));
}

/** Owner seals the round with the given versions and approves the stage. */
export async function seal_and_approve(
  env: AEnv,
  o: Opened,
  versions: Array<{ object_id: string; version_id: string }>,
  tag: string,
): Promise<void> {
  const sealed = (await seal(env, o.round_id, versions, `${tag}-seal`)).result as { snapshot_id: string };
  await approve(env, o.stage_id, sealed.snapshot_id, `${tag}-approve`);
}

/**
 * Close an opened stage so the NEXT stage can start a round (round.start needs the stage before it approved).
 * Seals the artifact's base version (or the run's own versions when given) and approves the stage.
 */
export async function close_stage(
  env: AEnv,
  o: Opened,
  tag: string,
  versions: Array<{ object_id: string; version_id: string }> = [{ object_id: o.object_id, version_id: o.base_version_id }],
): Promise<void> {
  await seal_and_approve(env, o, versions, `${tag}-close`);
}

/** Script the fake server for the NEXT calls only (call numbers keep counting across stages). */
export function set_script(env: AEnv, turns: ScriptedTurn[]): void {
  const base = env.fake.calls.length;
  env.fake.script = (n: number) => turns[n - base - 1] ?? FINISH;
}

/** Messages of a chat request as plain text (system/user/tool turns), for "did the model see X" checks. */
export function request_text(body: any): string {
  return JSON.stringify(body?.messages ?? []) + JSON.stringify(body?.system ?? "");
}

/** start() that may refuse (a thrown ApiError) or return a result: both are "not started" outcomes for a block test. */
export async function start_outcome(
  env: AEnv,
  o: StartOverrides = {},
): Promise<{ result: ExecResult | null; error: ApiError | null }> {
  try {
    return { result: await start_run(env, o), error: null };
  } catch (error) {
    assert.ok(error instanceof ApiError, `unexpected ${String(error)}`);
    return { result: null, error };
  }
}

export async function resume_outcome(
  env: AEnv,
  run_id: string,
  o: { max_output_tokens?: number } = {},
): Promise<{ result: ExecResult | null; error: ApiError | null }> {
  try {
    return { result: await resume_run(env, run_id, o), error: null };
  } catch (error) {
    assert.ok(error instanceof ApiError, `unexpected ${String(error)}`);
    return { result: null, error };
  }
}

/** The Number() of a nullable bigint column. */
export function num(value: bigint | number | null): number | null {
  return value === null ? null : Number(value);
}

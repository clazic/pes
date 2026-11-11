// Request formats of the built-in runner (stage 2 PR19): openai_compatible (Chat Completions) and anthropic
// (Messages). Pure functions: they build the JSON a provider expects and read its reply. No network, no key.
//
// google is a registered kind but has no executor (docs/adapters/a-builtin.md): nothing here speaks it.
//
// Model list, as documented by each provider:
//   openai_compatible  GET  <base>/models                      (a base ends in /v1)       -> {data:[{id}]}
//   anthropic          GET  <base>/v1/models?limit=1000        (a base has no /v1)        -> {data:[{id}]}
// Chat:
//   openai_compatible  POST <base>/chat/completions            Authorization: Bearer <key>
//   anthropic          POST <base>/v1/messages                 x-api-key: <key>, anthropic-version: 2023-06-01

import { createHash } from "node:crypto";

import type { RequestFormat } from "./spec.ts";

export const ANTHROPIC_VERSION = "2023-06-01";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
  /** Set when the provider's arguments were not valid JSON. */
  args_error?: string;
}

export interface ToolResult {
  call_id: string;
  name: string;
  content: string;
  is_error: boolean;
}

/** A conversation turn in the runner's own neutral shape; each format renders it its own way. */
export type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string | null; calls: ToolCall[] }
  | { role: "tool_results"; results: ToolResult[] };

export interface ModelRequest {
  model: string;
  system: string;
  turns: Turn[];
  tools: readonly ToolSpec[];
  max_output_tokens: number;
}

export interface ModelReply {
  text: string | null;
  calls: ToolCall[];
  /** null when the provider did not report token counts */
  usage: { input_tokens: number; output_tokens: number } | null;
  /** true when the provider says the answer was cut off by the token cap */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// tool names on the wire
//
// PES's own tool names have a dot (context.get), but providers only accept [a-zA-Z0-9_-] in a tool name
// (OpenAI Chat Completions tools.function.name, Anthropic tools.name). The two spellings are mapped by this
// fixed table, in both directions: the tools offered, the earlier assistant tool calls sent back, and the tool
// calls read from a reply. The prompt names the wire spelling too. A name read from a reply that is not in the
// table stays as it is, so the allowlist refuses it like any other unknown tool; when such a call is sent back
// in the conversation, its name is made wire-safe (other characters become "_", at most 64 characters).

export const TOOL_WIRE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "context.get": "context_get",
  "result.submit": "result_submit",
  "question.ask": "question_ask",
  "assumption.propose": "assumption_propose",
  "decision.propose": "decision_propose",
  "reflection.write": "reflection_write",
  "thread.reply": "thread_reply",
  "followup.propose": "followup_propose",
});

// Maps, not property lookups: a model may send "__proto__" or "constructor" as a tool name.
const TOOL_WIRE_MAP: ReadonlyMap<string, string> = new Map(Object.entries(TOOL_WIRE_NAMES));
const TOOL_INTERNAL_NAMES: ReadonlyMap<string, string> = new Map(Object.entries(TOOL_WIRE_NAMES).map(([internal, wire]) => [wire, internal]));

/** The name a provider sees for a PES tool. */
export function wire_tool_name(internal: string): string {
  const mapped = TOOL_WIRE_MAP.get(internal);
  if (mapped !== undefined) return mapped;
  const safe = internal.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return safe.length > 0 ? safe : "unknown_tool";
}

/** The PES tool a provider's tool name stands for; an unknown name comes back unchanged (and is refused later). */
export function internal_tool_name(wire: string): string {
  return TOOL_INTERNAL_NAMES.get(wire) ?? wire;
}

export class ReplyShapeError extends Error {
  override name = "ReplyShapeError";
  constructor(message: string) {
    super(message);
  }
}

function join_url(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function anthropic_base(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export function auth_headers(format: RequestFormat, key: string): Record<string, string> {
  if (format === "anthropic") {
    return { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" };
  }
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

export function models_url(format: RequestFormat, base: string): string {
  if (format === "anthropic") return `${anthropic_base(base)}/models?limit=1000`;
  return join_url(base, "/models");
}

export function chat_url(format: RequestFormat, base: string): string {
  if (format === "anthropic") return `${anthropic_base(base)}/messages`;
  return join_url(base, "/chat/completions");
}

export function parse_models(json: unknown): string[] {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new ReplyShapeError("the model list has no data array");
  const ids: string[] = [];
  for (const entry of data) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id.length > 0) ids.push(id);
  }
  return ids;
}

function openai_message(turn: Turn): unknown[] {
  if (turn.role === "user") return [{ role: "user", content: turn.text }];
  if (turn.role === "assistant") {
    return [
      {
        role: "assistant",
        content: turn.text,
        ...(turn.calls.length === 0
          ? {}
          : {
              tool_calls: turn.calls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: wire_tool_name(call.name), arguments: JSON.stringify(call.args ?? {}) },
              })),
            }),
      },
    ];
  }
  return turn.results.map((result) => ({ role: "tool", tool_call_id: result.call_id, content: result.content }));
}

function anthropic_message(turn: Turn): unknown {
  if (turn.role === "user") return { role: "user", content: turn.text };
  if (turn.role === "assistant") {
    const content: unknown[] = [];
    if (turn.text !== null && turn.text.length > 0) content.push({ type: "text", text: turn.text });
    for (const call of turn.calls) {
      content.push({ type: "tool_use", id: call.id, name: wire_tool_name(call.name), input: call.args ?? {} });
    }
    return { role: "assistant", content };
  }
  return {
    role: "user",
    content: turn.results.map((result) => ({
      type: "tool_result",
      tool_use_id: result.call_id,
      content: result.content,
      ...(result.is_error ? { is_error: true } : {}),
    })),
  };
}

export function build_body(format: RequestFormat, request: ModelRequest): Record<string, unknown> {
  if (format === "anthropic") {
    return {
      model: request.model,
      max_tokens: request.max_output_tokens,
      system: request.system,
      messages: request.turns.map(anthropic_message),
      tools: request.tools.map((tool) => ({ name: wire_tool_name(tool.name), description: tool.description, input_schema: tool.parameters })),
    };
  }
  return {
    model: request.model,
    max_tokens: request.max_output_tokens,
    messages: [{ role: "system", content: request.system }, ...request.turns.flatMap(openai_message)],
    tools: request.tools.map((tool) => ({
      type: "function",
      function: { name: wire_tool_name(tool.name), description: tool.description, parameters: tool.parameters },
    })),
  };
}

function token_count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parse_args(raw: unknown): { args: unknown; args_error?: string } {
  if (raw === undefined) return { args: {} };
  // not a text (the documented shape): handed on as it is; the tool refuses what is not an object
  if (typeof raw !== "string") return { args: raw };
  if (raw.trim().length === 0) return { args: {} };
  try {
    return { args: JSON.parse(raw) as unknown };
  } catch {
    return { args: {}, args_error: "the arguments are not valid JSON" };
  }
}

/** A plain JSON object (not null, not an array). */
function is_object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function array_of_objects(value: unknown, what: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new ReplyShapeError(`${what} is not an array`);
  for (const entry of value) if (!is_object(entry)) throw new ReplyShapeError(`${what} has an entry that is not an object`);
  return value as Array<Record<string, unknown>>;
}

function a_string(value: unknown, what: string): string {
  if (typeof value !== "string") throw new ReplyShapeError(`${what} is not a text`);
  return value;
}

/**
 * Reads a provider's reply. Every array element and every object PES reads is checked for its shape first: a
 * null, a number, an array or a missing field where an object or a text belongs is a ReplyShapeError (the
 * executor keeps such an answer as unknown), never a TypeError.
 */
export function parse_reply(format: RequestFormat, json: unknown): ModelReply {
  if (!is_object(json)) throw new ReplyShapeError("the reply is not an object");
  const usage_of = (value: unknown): Record<string, unknown> => (is_object(value) ? value : {});
  if (format === "anthropic") {
    const blocks = array_of_objects(json["content"], "the reply's content");
    let text: string | null = null;
    const calls: ToolCall[] = [];
    for (const block of blocks) {
      const type = block["type"];
      if (typeof type !== "string") throw new ReplyShapeError("a content block has no type");
      if (type === "text") {
        if (typeof block["text"] !== "string") throw new ReplyShapeError("a text block has no text");
        text = (text ?? "") + block["text"];
      } else if (type === "tool_use") {
        const id = a_string(block["id"], "a tool_use block's id");
        const name = a_string(block["name"], "a tool_use block's name");
        // a missing input is no arguments; a null one is a broken block. Any other value is handed to the tool as
        // it is, and the tool refuses what is not an object (a refusal the model is told about).
        if (block["input"] === null) throw new ReplyShapeError("a tool_use block's input is null");
        calls.push({ id, name: internal_tool_name(name), args: block["input"] === undefined ? {} : block["input"] });
      }
      // other block types (thinking, ...) carry nothing PES uses; they are still covered by the key check
    }
    const usage = usage_of(json["usage"]);
    const input = token_count(usage["input_tokens"]);
    const output = token_count(usage["output_tokens"]);
    return {
      text,
      calls,
      usage: input !== null && output !== null ? { input_tokens: input, output_tokens: output } : null,
      truncated: json["stop_reason"] === "max_tokens",
    };
  }
  const choices = array_of_objects(json["choices"], "the reply's choices");
  const choice = choices[0];
  if (choice === undefined) throw new ReplyShapeError("the reply has no choice");
  const message = choice["message"];
  if (!is_object(message)) throw new ReplyShapeError("the reply has no message");
  let text: string | null;
  const content = message["content"];
  if (content === undefined || content === null) text = null;
  else if (typeof content === "string") text = content;
  else {
    // content parts: only text parts are read, and every part has to be an object with a type
    text = null;
    for (const part of array_of_objects(content, "the message's content")) {
      if (typeof part["type"] !== "string") throw new ReplyShapeError("a content part has no type");
      if (part["type"] === "text") {
        if (typeof part["text"] !== "string") throw new ReplyShapeError("a text part has no text");
        text = (text ?? "") + part["text"];
      }
    }
  }
  const calls: ToolCall[] = [];
  const raw_calls = message["tool_calls"];
  if (raw_calls !== undefined && raw_calls !== null) {
    for (const entry of array_of_objects(raw_calls, "the message's tool_calls")) {
      const id = a_string(entry["id"], "a tool call's id");
      const fn = entry["function"];
      if (!is_object(fn)) throw new ReplyShapeError("a tool call has no function");
      const name = a_string(fn["name"], "a tool call's name");
      calls.push({ id, name: internal_tool_name(name), ...parse_args(fn["arguments"] === null ? undefined : fn["arguments"]) });
    }
  }
  const usage = usage_of(json["usage"]);
  const input = token_count(usage["prompt_tokens"]);
  const output = token_count(usage["completion_tokens"]);
  return {
    text,
    calls,
    usage: input !== null && output !== null ? { input_tokens: input, output_tokens: output } : null,
    truncated: choice["finish_reason"] === "length",
  };
}

/** The hash of what is sent (without any header), used as the dispatch's payload_hash. */
export function payload_hash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
}

/** Plain text of a reply, for the cheap output-token estimate when a provider reports no usage. */
export function reply_text(reply: ModelReply): string {
  return `${reply.text ?? ""}${reply.calls.map((call) => `${call.name}${JSON.stringify(call.args ?? {})}`).join("")}`;
}

// ---------------------------------------------------------------------------
// provider errors
//
// A provider's error body is never stored, not even its `code` or `type`: a provider may echo the request's key
// in them, and a key is a short string of letters, digits and dashes like any code. Only the fixed internal codes
// below are ever stored. The provider's strings are looked up in this table (compared, never copied); anything
// else becomes a code chosen from the HTTP status alone.

const PROVIDER_ERROR_CODES: ReadonlyMap<string, string> = new Map([
  ["rate_limit_error", "rate_limited"],
  ["rate_limit_exceeded", "rate_limited"],
  ["insufficient_quota", "quota_exceeded"],
  ["billing_error", "quota_exceeded"],
  ["authentication_error", "auth_failed"],
  ["invalid_api_key", "auth_failed"],
  ["permission_error", "forbidden"],
  ["not_found_error", "not_found"],
  ["model_not_found", "not_found"],
  ["invalid_request_error", "invalid_request"],
  ["context_length_exceeded", "context_too_long"],
  ["request_too_large", "request_too_large"],
  ["overloaded_error", "overloaded"],
  ["api_error", "server_error"],
  ["server_error", "server_error"],
]);

/** The internal error codes that can ever be stored for a failed model call. */
export const INTERNAL_ERROR_CODES: readonly string[] = Object.freeze([
  ...new Set([...PROVIDER_ERROR_CODES.values(), "rate_limited", "auth_failed", "forbidden", "not_found", "request_too_large", "client_error", "server_error", "provider_error"]),
]);

function code_from_status(status: number): string {
  if (status === 429) return "rate_limited";
  if (status === 401) return "auth_failed";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 413) return "request_too_large";
  if (status >= 400 && status < 500) return "client_error";
  if (status >= 500 && status < 600) return "server_error";
  return "provider_error";
}

/** A fixed, key-free internal error code for a provider's error reply. The provider's own strings are never returned. */
export function error_code_of(status: number, json: unknown): string {
  const error = (json as { error?: { type?: unknown; code?: unknown } } | null)?.error;
  for (const value of [error?.code, error?.type]) {
    if (typeof value === "string") {
      const mapped = PROVIDER_ERROR_CODES.get(value);
      if (mapped !== undefined) return mapped;
    }
  }
  return code_from_status(status);
}

// ---------------------------------------------------------------------------
// the key in a reply
//
// A reply that carries the key it was sent with must not reach a PES command, a table, a DTO or the next request.
// "Carries" means: the whole key, or any piece of it KEY_PIECE characters long that looks random (it has a digit,
// or both upper- and lower-case letters) - also when the provider hid it. Pieces that are plain words
// ("synthet", "sk-proj-") are not looked for: a model writes such words all the time, and they say nothing about
// the secret part of a key.
//
// Every text of the reply is looked at through every layer a provider (or a model) can wrap the key in, in any
// order and up to KEY_DECODE_DEPTH layers deep:
//   * JSON \uXXXX escapes, with any number of backslashes in front (a JSON text inside a JSON string, again and
//     again - the OpenAI tool call `arguments` string is such a text)
//   * URL %xx escapes
//   * base64 and base64url (padded or not, read from each of the first four positions of a run)
// The texts looked at are: the raw reply body, every name and value of the parsed JSON (JSON escapes resolved),
// and every name and value of what PES would act on (the parsed reply: text, tool names, tool arguments after
// their own JSON parse). The check runs before anything else reads the reply.
//
// The check fails closed and runs in bounded time. Every layer is undone by a plain one-pass character scan (no
// regular expression: no backtracking, no stack overflow on a run of millions of characters). One check of a
// reply has one work budget (KEY_CHECK_WORK characters), shared by all its texts and charged BEFORE each costly
// step: looking for the pieces in a text costs its length, undoing the layers of a text costs five times its
// length (the most the three decoders together can read and write). Any error, a spent budget or a text longer
// than KEY_CHECK_MAX_TEXT counts as "the reply may carry the key" (reply_key_check -> "check_failed"; the caller
// keeps the reply as unknown with the fixed reason key_check_failed).

export const KEY_PIECE = 8;
const KEY_DECODE_DEPTH = 6;
const KEY_DECODE_VARIANTS = 256;
const KEY_CHECK_WORK = 384 * 1024 * 1024;
const KEY_CHECK_MAX_TEXT = 32 * 1024 * 1024;
const BASE64_RUN_MIN = 11;

/** The work budget of one check ran out (or a text is too long): the check cannot say the reply is clean. */
class KeyCheckBudgetError extends Error {}

/** The work left for one key check; charge() throws before the work is done when there is not enough left. */
class KeyCheckWork {
  #left = KEY_CHECK_WORK;
  charge(amount: number): void {
    this.#left -= amount;
    if (this.#left < 0) throw new KeyCheckBudgetError("key check work budget spent");
  }
}

function key_pieces(key: string): string[] {
  if (key.length <= KEY_PIECE) return [key];
  const pieces = new Set<string>();
  pieces.add(key);
  for (let i = 0; i + KEY_PIECE <= key.length; i += 1) {
    const piece = key.slice(i, i + KEY_PIECE);
    if (/[0-9]/.test(piece) || (/[a-z]/.test(piece) && /[A-Z]/.test(piece))) pieces.add(piece);
  }
  return [...pieces];
}

function has_piece(text: string, pieces: readonly string[]): boolean {
  return pieces.some((piece) => text.includes(piece));
}

function is_hex(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

function hex_value(text: string, at: number, digits: number): number {
  return parseInt(text.slice(at, at + digits), 16);
}

/**
 * Undo JSON \\uXXXX escapes with any number of backslashes in front (the whole run of backslashes and the
 * escape become the one character). One pass: each run of backslashes is read once. Returns `text` itself when
 * there is nothing to undo.
 */
function unescape_unicode(text: string): string {
  if (!text.includes("\\")) return text;
  const out: string[] = [];
  const length = text.length;
  let copied = 0;
  let i = 0;
  while (i < length) {
    if (text.charCodeAt(i) !== 0x5c) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < length && text.charCodeAt(i) === 0x5c) i += 1; // the whole run of backslashes, once
    if (
      i + 4 < length &&
      text.charCodeAt(i) === 0x75 && // u
      is_hex(text.charCodeAt(i + 1)) &&
      is_hex(text.charCodeAt(i + 2)) &&
      is_hex(text.charCodeAt(i + 3)) &&
      is_hex(text.charCodeAt(i + 4))
    ) {
      out.push(text.slice(copied, start), String.fromCharCode(hex_value(text, i + 1, 4)));
      i += 5;
      copied = i;
    }
  }
  if (copied === 0) return text;
  out.push(text.slice(copied));
  return out.join("");
}

/** Undo URL %xx escapes in one pass. Returns `text` itself when there is nothing to undo. */
function unescape_percent(text: string): string {
  if (!text.includes("%")) return text;
  const out: string[] = [];
  const length = text.length;
  let copied = 0;
  let i = 0;
  while (i < length) {
    if (text.charCodeAt(i) === 0x25 && i + 2 < length && is_hex(text.charCodeAt(i + 1)) && is_hex(text.charCodeAt(i + 2))) {
      out.push(text.slice(copied, i), String.fromCharCode(hex_value(text, i + 1, 2)));
      i += 3;
      copied = i;
    } else {
      i += 1;
    }
  }
  if (copied === 0) return text;
  out.push(text.slice(copied));
  return out.join("");
}

function is_base64_char(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2b || // +
    code === 0x2f || // /
    code === 0x5f || // _
    code === 0x2d // -
  );
}

/** Every run of BASE64_RUN_MIN or more base64/base64url characters (plus up to two "=" after it), by a linear scan. */
function base64_runs(text: string): string[] {
  const runs: string[] = [];
  const length = text.length;
  let i = 0;
  while (i < length) {
    if (!is_base64_char(text.charCodeAt(i))) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < length && is_base64_char(text.charCodeAt(i))) i += 1;
    let end = i;
    if (end - start >= BASE64_RUN_MIN) {
      while (end < length && end - i < 2 && text.charCodeAt(end) === 0x3d) end += 1; // =
      runs.push(text.slice(start, end));
    }
    i = end;
  }
  return runs;
}

function decode_base64_runs(text: string): string {
  const out: string[] = [];
  for (const run of base64_runs(text)) {
    for (let offset = 0; offset < 4 && run.length - offset >= 8; offset += 1) {
      out.push(Buffer.from(run.slice(offset), "base64").toString("latin1"));
    }
  }
  return out.join("\n");
}

/**
 * true when `text`, or any decoding of it (\\u, %xx, base64 - layered), contains the key or a piece of it.
 * Throws KeyCheckBudgetError when `work` runs out (charged before each step) or a text is too long.
 */
function text_carries_pieces(text: string, pieces: readonly string[], work: KeyCheckWork): boolean {
  const seen = new Set<string>();
  let frontier = [text];
  for (let depth = 0; depth <= KEY_DECODE_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const candidate of frontier) {
      if (candidate.length > KEY_CHECK_MAX_TEXT) throw new KeyCheckBudgetError("key check text too long");
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      work.charge(candidate.length);
      if (has_piece(candidate, pieces)) return true;
      if (seen.size >= KEY_DECODE_VARIANTS || depth === KEY_DECODE_DEPTH) continue;
      work.charge(candidate.length * 5);
      for (const decoded of [unescape_unicode(candidate), unescape_percent(candidate), decode_base64_runs(candidate)]) {
        if (decoded.length > 0 && decoded !== candidate && !seen.has(decoded)) next.push(decoded);
      }
    }
    frontier = next;
  }
  return false;
}

/** Every name and string value inside a JSON value, as one text (one per line). */
function strings_of(value: unknown): string {
  const out: string[] = [];
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === "string") out.push(item);
    else if (Array.isArray(item)) for (const entry of item) stack.push(entry);
    else if (item !== null && typeof item === "object") {
      for (const [name, entry] of Object.entries(item as Record<string, unknown>)) {
        out.push(name);
        stack.push(entry);
      }
    }
  }
  return out.join("\n");
}

/** true when `text` (in any of the disguises above) contains the key or a piece of it - or the check could not finish. */
export function text_carries_key(key: string, text: string): boolean {
  try {
    return text_carries_pieces(text, key_pieces(key), new KeyCheckWork());
  } catch {
    return true; // fail closed
  }
}

/**
 * What the key check says about a reply:
 *   "none"          no text of the reply carries the key
 *   "key"           its raw text, a string inside its parsed JSON, or a string of the parsed reply PES would act
 *                   on (tool arguments after their own JSON parse) carries the key, in some disguise
 *   "check_failed"  the check did not finish (an error, or the decode budget ran out); the reply is treated as one
 *                   that may carry the key
 */
export type ReplyKeyCheck = "none" | "key" | "check_failed";

export function reply_key_check(key: string, raw_text: string, json: unknown, reply: ModelReply | null = null): ReplyKeyCheck {
  try {
    const pieces = key_pieces(key);
    const work = new KeyCheckWork(); // one budget for every text of the reply
    if (text_carries_pieces(raw_text, pieces, work)) return "key";
    if (text_carries_pieces(strings_of(json), pieces, work)) return "key";
    if (reply !== null) {
      const acted_on = [reply.text ?? "", ...reply.calls.flatMap((call) => [call.id, call.name, strings_of(call.args)])].join("\n");
      if (text_carries_pieces(acted_on, pieces, work)) return "key";
    }
    return "none";
  } catch {
    return "check_failed";
  }
}

/** true when the reply carries the key, or the check could not say it does not (reply_key_check is not "none"). */
export function reply_carries_key(key: string, raw_text: string, json: unknown, reply: ModelReply | null = null): boolean {
  return reply_key_check(key, raw_text, json, reply) !== "none";
}

// ---------------------------------------------------------------------------
// billing signals in a reply
//
// Some providers say in the reply how a call was paid for. PES reads only these shapes (none of them is a
// standard, so an unrecognised value counts as "might be charged"):
//   billing_source: "<text>"   top level or inside usage
//   cost: <number>             top level or inside usage (any amount above 0 means the call was charged)
// What PES stores as the dispatch's billing_source is what the reply said, never the connection's setting:
//   "pay_per_use"   the reply says the call was charged
//   "subscription"  the reply says the call was covered by a plan
//   "unrecognized"  the reply has a billing_source PES does not know
//   "not_reported"  the reply says nothing about billing

const PLAN_SOURCES = new Set(["subscription", "plan", "included", "free", "free_tier"]);
const CHARGED_SOURCES = new Set(["pay_per_use", "pay-as-you-go", "pay_as_you_go", "metered", "usage", "usage_based", "overage", "extra_usage", "credits", "paid", "billed"]);

export type BillingSignal = "pay_per_use" | "subscription" | "unrecognized" | "not_reported";

export function billing_signal_of(json: unknown): BillingSignal {
  const body = json !== null && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const usage = body["usage"] !== null && typeof body["usage"] === "object" ? (body["usage"] as Record<string, unknown>) : {};
  let signal: BillingSignal = "not_reported";
  for (const value of [body["cost"], usage["cost"]]) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) signal = signal === "pay_per_use" ? signal : "unrecognized";
    else if (value > 0) signal = "pay_per_use";
  }
  for (const value of [body["billing_source"], usage["billing_source"]]) {
    if (value === undefined || value === null) continue;
    const text = typeof value === "string" ? value.trim().toLowerCase() : null;
    if (text !== null && CHARGED_SOURCES.has(text)) signal = "pay_per_use";
    else if (text !== null && PLAN_SOURCES.has(text)) signal = signal === "not_reported" ? "subscription" : signal;
    else if (signal !== "pay_per_use") signal = "unrecognized";
  }
  return signal;
}

/** A billing field name in a body PES could not parse as JSON (a cut-off body, a non-JSON error page). */
const BILLING_FIELD_IN_TEXT = /"(?:billing_source|cost)"[ \t\r\n]*:/;

/**
 * The billing signal of any reply body - a success, an HTTP error, or the part of a body that arrived before the
 * stream broke. Read before the status decides anything. A body that is not JSON but names a billing field
 * cannot be read: "unrecognized" (counts as "might be charged").
 */
export function billing_signal_of_body(json: unknown, text: string | undefined): BillingSignal {
  if (json !== null && json !== undefined) return billing_signal_of(json);
  if (text !== undefined && text.length > 0) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
    if (parsed !== null) return billing_signal_of(parsed);
    if (BILLING_FIELD_IN_TEXT.test(text)) return "unrecognized";
  }
  return "not_reported";
}

/** true when a signal says the call was (or may have been) charged. */
export function signals_charge(signal: BillingSignal): boolean {
  return signal === "pay_per_use" || signal === "unrecognized";
}

// SEL-53 (stage 2 PR20a) shared pieces for the method-B Claude adapter tests. Everything is synthetic:
// an in-memory API app over a temporary HOME/PES_HOME, a FakeClock, invented slugs and tokens.
//
// Interface the tests pin (the worker implements it; see the 해석 list in the first test file):
//
//   scripts/pes_core/mcp_server.ts
//     new McpServer({ api, project_id, token, claim_defaults? })
//        api      anything with `handle({method,path,headers,body}) -> {status,headers,json,bytes}` (an ApiApp)
//        token    the project agent token (Bearer). It is held in memory only and never echoed to the client.
//     await server.handle_message(msg) -> JSON-RPC response object, or null for a notification
//     await serve_stdio(server, { input, output }) -> resolves when input ends. One JSON-RPC message per
//        line, newline-delimited, nothing else ever written to `output`.
//
// The fake MCP client below speaks that wire format itself (initialize, tools/list, tools/call) — no real
// Claude Code, no `claude -p`, and no ~/.claude or app config is read or written.

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { McpServer, serve_stdio } from "../../scripts/pes_core/mcp_server.ts";
import { new_artifact } from "./blob_env.ts";
import {
  assert_ok,
  call,
  make_agent,
  make_api_env,
  type Agent,
  type ApiEnv,
} from "./api_env.ts";
import { P } from "./api_flow.ts";
import { stage_ids } from "./editions_env.ts";
import { single_spec } from "./questions_env.ts";

export const TOOLS = [
  "pes_context",
  "pes_claim",
  "pes_submit",
  "pes_ask",
  "pes_wait",
  "pes_complete",
  "pes_heartbeat",
  "pes_release",
  "pes_cancel",
  "pes_receipt",
] as const;

export type ToolName = (typeof TOOLS)[number];

export interface ToolOutcome {
  /** tools/call result.isError */
  is_error: boolean;
  /** result.structuredContent (the same JSON as the single text block) */
  data: any;
  /** the raw tools/call result */
  raw: any;
}

/** A fake MCP client: it writes newline-delimited JSON-RPC to the server's stdin and reads its stdout. */
export class FakeMcpClient {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  /** Every raw line the server ever wrote (the server must write JSON-RPC and nothing else). */
  readonly lines: string[] = [];
  private buffer = "";
  private next_id = 1;
  private waiting = new Map<number | string | null, (message: any) => void>();
  private ended: Promise<void>;

  constructor(server: McpServer) {
    this.output.setEncoding("utf8");
    this.output.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const nl = this.buffer.indexOf("\n");
        if (nl < 0) break;
        const line = this.buffer.slice(0, nl).replace(/\r$/, "");
        this.buffer = this.buffer.slice(nl + 1);
        if (line.length === 0) continue;
        this.lines.push(line);
        const message = JSON.parse(line);
        const resolve = this.waiting.get(message.id ?? null);
        if (resolve !== undefined) {
          this.waiting.delete(message.id ?? null);
          resolve(message);
        }
      }
    });
    this.ended = serve_stdio(server, { input: this.input, output: this.output });
  }

  /** Send a request and wait for the response with the same id. */
  request(method: string, params?: unknown): Promise<any> {
    const id = this.next_id++;
    const reply = new Promise<any>((resolve) => this.waiting.set(id, resolve));
    this.input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return reply;
  }

  /** Send raw text as one line (malformed JSON on purpose). The reply (id null) is awaited. */
  raw_line(text: string): Promise<any> {
    const reply = new Promise<any>((resolve) => this.waiting.set(null, resolve));
    this.input.write(`${text}\n`);
    return reply;
  }

  notify(method: string, params?: unknown): void {
    this.input.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async initialize(): Promise<any> {
    const res = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "synthetic-claude-code", version: "0.0.0" },
    });
    this.notify("notifications/initialized");
    return res;
  }

  async tool(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
    const res = await this.request("tools/call", { name, arguments: args });
    assert.equal(res.jsonrpc, "2.0");
    assert.equal(res.error, undefined, `tools/call ${name} is a tool result, not a protocol error: ${JSON.stringify(res.error)}`);
    const raw = res.result;
    assert.ok(Array.isArray(raw.content) && raw.content.length >= 1, "content blocks");
    assert.equal(raw.content[0].type, "text");
    const data = raw.structuredContent;
    assert.deepEqual(JSON.parse(raw.content[0].text), data, "the text block and structuredContent are the same JSON");
    return { is_error: raw.isError === true, data, raw };
  }

  /** A tool call that must succeed. */
  async ok(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const out = await this.tool(name, args);
    assert.equal(out.is_error, false, `${name} failed: ${JSON.stringify(out.data)}`);
    return out.data;
  }

  /** A tool call that must fail as a tool error; returns the error object {code, message, next_action, ...}. */
  async fails(name: string, args: Record<string, unknown>, code: string): Promise<any> {
    const out = await this.tool(name, args);
    assert.equal(out.is_error, true, `${name} should fail with ${code}: ${JSON.stringify(out.data)}`);
    assert.equal(out.data.error.code, code, JSON.stringify(out.data));
    assert.equal(typeof out.data.error.message, "string");
    assert.match(out.data.error.message, /[가-힣]/, "the message is Korean");
    return out.data.error;
  }

  async close(): Promise<void> {
    this.input.end();
    await this.ended;
  }
}

export interface AdapterEnv extends ApiEnv {
  agent: Agent;
  stage: Record<"plan" | "research" | "analyze" | "write" | "verify" | "publish", string>;
  round_id: string;
  object_id: string;
  version_id: string;
  /** A new MCP server (a fresh connection) for the given agent token. */
  server(token?: string): McpServer;
  /** A fresh fake client on a fresh server, already initialized. */
  client(token?: string): Promise<FakeMcpClient>;
  /** Move the fake clock past the API's minimum poll interval. */
  tick(): void;
}

export async function make_adapter_env(): Promise<AdapterEnv> {
  const env = (await make_api_env()) as AdapterEnv;
  env.agent = await make_agent(env, "claude-code");
  env.stage = stage_ids(env.db, env.p.edition_id) as AdapterEnv["stage"];
  const round = assert_ok(
    await call(env, { method: "POST", path: P(env, `/stages/${env.stage.plan}/rounds`), auth: "owner", body: {} }),
    201,
  ).round;
  env.round_id = round.id as string;
  const art = await new_artifact(env, "adapter-artifact");
  env.object_id = art.object_id;
  env.version_id = art.version_id;
  env.server = (token = env.agent.token) =>
    new McpServer({
      api: env.app,
      project_id: env.p.project_id,
      token,
      claim_defaults: { runtime: "claude_code", provider: "anthropic", model: "synthetic-model" },
    });
  env.client = async (token) => {
    const c = new FakeMcpClient(env.server(token));
    await c.initialize();
    return c;
  };
  env.tick = () => env.clock.advance(10_001);
  return env;
}

/** The ask arguments the tools take: one synthetic single-choice question for the open plan round. */
export function ask_args(env: AdapterEnv, key: string, text = "어댑터 합성 질문"): Record<string, unknown> {
  return {
    stage_id: env.stage.plan,
    round_id: env.round_id,
    purpose: "review",
    form_key: key,
    question: single_spec(text),
    idempotency_key: `ask-${key}`,
  };
}

/** The owner (human) answers the question an agent asked. Returns the answer version id. */
export async function owner_answers(env: AdapterEnv, asked: any, value = "a"): Promise<string> {
  const res = await call(env, {
    method: "POST",
    path: P(env, "/submissions"),
    auth: "owner",
    body: {
      set_id: asked.question_set_id,
      answers: [{ question_id: asked.question.id, question_version_id: asked.question.version_id, value }],
    },
  });
  return assert_ok(res, 201).answers[0].answer_version_id as string;
}

/** Serialize a value exactly as a client would put it on the wire, to scan for secrets. */
export function wire(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

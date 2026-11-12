// The PES MCP server for method-B adapters (stage 2 PR20a, SEL-53).
//
// An AI tool that runs on its own (Claude Code, and later Codex CLI / OpenCode TUI) talks to PES through
// fourteen MCP tools. The server is a thin, closed bridge over the PES HTTP API:
//
//   pes_context  pes_read  pes_claim  pes_submit  pes_ask  pes_wait  pes_complete  pes_heartbeat
//   pes_release  pes_cancel  pes_receipt  pes_assumption_propose  pes_decision_propose  pes_reflection_write
//
// - There is no tool for approving, reopening, sealing, changing policy, registering a project or minting a
//   token: those are the human's. The same goes for judging an assumption and for adopting, superseding or
//   revoking a decision (SEL-93): the three SEL-93 tools only PROPOSE or WRITE a reflection; PES refuses a
//   token anything more (403 human_required). The tools can only do what the project agent token is allowed to do, and PES
//   (not this file) decides that.
// - The server holds the agent token in memory and puts it only in the Authorization header of its own API
//   calls. It never echoes it, and writes nothing but JSON-RPC lines to its output.
// - pes_context and pes_read only read. pes_read is the existing version read (GET objects/{o}/versions/{v}):
//   the human's answer (value, comment) and question, or a work item's body, under the API's own rules.
//   pes_context pages through the run's inputs and hands back the next cursor so nothing past a page is lost.
// - Every tool but pes_context and pes_read takes an `idempotency_key`, sent as the API Idempotency-Key. The same key with the
//   same arguments replays the first answer; the same key with other arguments is idempotency_key_reuse.
// - The server remembers the guard {run_id, lease_id, fence} of its last successful claim so the later tools need
//   not repeat it. Explicit run_id / lease_id / fence arguments override it: that is how a brand-new connection
//   continues after a restart (pes_context first, then explicit ids). wait, complete, release and cancel make the
//   server forget the lease, but each remembers the guard it sent under its key: the same call sent again with
//   the same key goes to PES with that guard, so PES checks it and replays its first answer (never claim_required).
//   That memory only answers a repeat of a key; it never brings the forgotten lease back for a new key.
// - A PES refusal is a tool result with isError:true and the API error object, never a protocol error.
//   When a tool cannot even be built (no key, no guard), PES is still asked first with a request that cannot write,
//   so a credential or scope refusal comes before the tool's own input complaint.

import { api_request, project_path, type ApiLike, type ApiRequestLike, type ApiResult } from "./adapters/api_client.ts";

export const TOOL_NAMES = [
  "pes_context",
  "pes_read",
  "pes_claim",
  "pes_submit",
  "pes_ask",
  "pes_wait",
  "pes_complete",
  "pes_heartbeat",
  "pes_release",
  "pes_cancel",
  "pes_receipt",
  // SEL-93 U3a: proposals and a round's reflection (no lease needed: they take the project token's run:submit scope)
  "pes_assumption_propose",
  "pes_decision_propose",
  "pes_reflection_write",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** The closed list of progress phases a heartbeat may carry (start, stage change, done, failed, waiting, planned). */
export const PROGRESS_PHASES = ["started", "stage", "completed", "failed", "waiting", "scheduled"] as const;

export interface ClaimDefaults {
  runtime: string;
  provider: string;
  model: string;
}

export interface McpServerOptions {
  api: ApiLike;
  project_id: string;
  token: string;
  claim_defaults?: ClaimDefaults;
}

interface ToolError {
  code: string;
  message: string;
  retryable: boolean;
  target: string | null;
  details: unknown;
  next_action: string;
}

type Outcome = { ok: true; data: Record<string, unknown> } | { ok: false; error: ToolError };

interface Guard {
  run_id: string;
  lease_id: string;
  fence: string;
}

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0] as string;
const MAX_KEY_CHARS = 200;
/**
 * One pes_context call reads one page of answers (the API's `limit`), so the reply stays far below a client's tool
 * output limit: a page of 50 is about 10 KB of JSON, and it goes out twice (text and structuredContent).
 */
const INPUTS_PER_CALL = 50;
/** If the page's serialized `inputs` is bigger than this, the same cursor is read again with half the `limit`. */
const INPUTS_BYTES_PER_CALL = 16 * 1024;
/** How many keys of lease-ending calls the server remembers for a repeat. */
const MAX_REMEMBERED_KEYS = 256;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
/** PES refusals about who is asking: they answer before the tool's own input complaints. */
const CREDENTIAL_CODES = new Set(["unauthenticated", "forbidden", "human_required", "owner_required"]);

function is_record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function local_error(code: string, message: string, target: string | null, next_action: string): Outcome {
  return { ok: false, error: { code, message, retryable: false, target, details: null, next_action } };
}

function invalid(target: string, message: string): Outcome {
  return local_error("invalid_payload", `${message} (${target})`, target, "fix_request");
}

function claim_required(): Outcome {
  return local_error(
    "claim_required",
    "이 도구는 실행 권한(lease)이 필요합니다. 먼저 pes_claim으로 실행을 시작하거나, run_id·lease_id·fence를 직접 주세요.",
    null,
    "claim",
  );
}

const KEY_PROPERTY = { type: "string", minLength: 1, maxLength: MAX_KEY_CHARS, description: "같은 요청을 다시 보낼 때 같은 값을 쓴다. 다른 내용에 같은 값을 쓰면 거부된다." };
const GUARD_PROPERTIES = {
  run_id: { type: "string", description: "생략하면 마지막 claim의 run_id" },
  lease_id: { type: "string", description: "생략하면 마지막 claim의 lease_id" },
  fence: { type: "string", pattern: "^(0|[1-9][0-9]*)$", description: "생략하면 마지막 claim의 fence (10진수 문자열)" },
};

interface ToolSpec {
  name: ToolName;
  description: string;
  properties: Record<string, unknown>;
  required: string[];
  /** The tool takes idempotency_key (every tool but pes_context and pes_read). */
  keyed: boolean;
}

function schema_of(spec: ToolSpec): { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false } {
  return {
    type: "object",
    properties: spec.keyed ? { ...spec.properties, idempotency_key: KEY_PROPERTY } : spec.properties,
    required: spec.keyed ? [...spec.required, "idempotency_key"] : spec.required,
    additionalProperties: false,
  };
}

const TOOLS: readonly ToolSpec[] = [
  {
    name: "pes_context",
    description:
      "프로젝트의 현재 상태(control_rev, digest, 단계, 자료 목록, 현재 lease)를 읽는다. 읽기만 한다. 실행을 아는 경우 그 실행에 온 답(inputs)도 한 번에 한 쪽(최대 50개) 함께 준다. 답이 더 있으면 inputs_has_more가 true이고, inputs_next_cursor를 inputs_cursor로 다시 주면 이어 읽는다. 답의 본문은 pes_read로 읽는다.",
    properties: {
      run_id: { type: "string", description: "답(inputs)을 읽을 실행. 생략하면 마지막으로 아는 실행" },
      inputs_cursor: { type: "string", description: "앞선 pes_context가 준 inputs_next_cursor. 생략하면 처음부터" },
    },
    required: [],
    keyed: false,
  },
  {
    name: "pes_read",
    description:
      "자료 한 버전의 내용을 읽는다. 읽기만 한다. 사람의 답(inputs의 object_id·input_version_id)이면 content.value·content.comment·content.question_version_id를, 질문(inputs의 question_id와 그 question_version_id)이면 질문 글과 선택지를, 작업 자료면 제목·요약·본문을 준다. version_id를 생략하면 현재 버전을 읽는다.",
    properties: {
      object_id: { type: "string", description: "읽을 자료(답이면 inputs의 object_id, 질문이면 question_id)" },
      version_id: { type: "string", description: "읽을 버전(답이면 input_version_id). 생략하면 현재 버전" },
    },
    required: ["object_id"],
    keyed: false,
  },
  {
    name: "pes_claim",
    description:
      "작업을 시작한다(lease를 받는다). run_id를 주면 기다리던 그 실행을 이어받고(새 fence), 생략하면 새 실행을 만든다.",
    properties: {
      run_id: { type: "string" },
      expected_control_rev: { type: "string", pattern: "^(0|[1-9][0-9]*)$", description: "이 값이 현재와 다르면 거부한다" },
    },
    required: [],
    keyed: true,
  },
  {
    name: "pes_submit",
    description: "결과(새 버전)를 제출한다. 한 번에 1~20개. 제출은 승인이 아니다.",
    properties: {
      ...GUARD_PROPERTIES,
      results: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          properties: { op: { const: "append_version" }, object_id: { type: "string" } },
          required: ["op", "object_id"],
        },
      },
      expected_control_rev: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
    },
    required: ["results"],
    keyed: true,
  },
  {
    name: "pes_ask",
    description: "사람에게 질문 하나를 낸다. 답은 사람이 로컬 화면에서 한다.",
    properties: {
      ...GUARD_PROPERTIES,
      stage_id: { type: "string" },
      round_id: { type: ["string", "null"] },
      purpose: { type: "string", enum: ["stage_start", "review", "resume"] },
      form_key: { type: "string" },
      question: { type: "object" },
    },
    required: ["stage_id", "purpose", "question"],
    keyed: true,
  },
  {
    name: "pes_wait",
    description: "사람의 답을 기다린다(waiting_human). lease를 내려놓는다. 답이 오면 pes_claim으로 이어받는다.",
    properties: {
      ...GUARD_PROPERTIES,
      reason: { type: "string" },
      wait_ms: { type: "integer", minimum: 0, maximum: 25000 },
    },
    required: [],
    keyed: true,
  },
  {
    name: "pes_complete",
    description: "실행을 끝낸다(succeeded 또는 failed). 단계 승인이 아니며 아무것도 봉인하지 않는다.",
    properties: { ...GUARD_PROPERTIES, status: { type: "string", enum: ["succeeded", "failed"] } },
    required: [],
    keyed: true,
  },
  {
    name: "pes_heartbeat",
    description: "lease를 연장하고, 진행 알림(progress.phase)을 남긴다. 시작·단계 전환·완료·실패·대기·예약이 모두 같은 형식이다.",
    properties: {
      ...GUARD_PROPERTIES,
      progress: {
        type: "object",
        properties: {
          phase: { type: "string", enum: [...PROGRESS_PHASES] },
          observed_at: { type: "integer", minimum: 0, description: "생략하면 서버 시계" },
        },
        required: ["phase"],
        additionalProperties: false,
      },
    },
    required: [],
    keyed: true,
  },
  {
    name: "pes_release",
    description: "실행을 대기열로 돌려놓고 lease를 내려놓는다.",
    properties: { ...GUARD_PROPERTIES },
    required: [],
    keyed: true,
  },
  {
    name: "pes_cancel",
    description: "자기 실행을 취소한다. confirm:true가 있어야 한다.",
    properties: { run_id: { type: "string" }, confirm: { const: true }, reason: { type: "string" } },
    required: ["confirm"],
    keyed: true,
  },
  {
    name: "pes_receipt",
    description:
      "받은 입력(사람의 답)을 봤다/반영했다/무시했다고 영수증을 남긴다. applied는 그 입력을 쓴 pes_submit의 idempotency_key를 applied_by_key로 준다.",
    properties: {
      ...GUARD_PROPERTIES,
      receipts: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          properties: {
            input_version_id: { type: "string" },
            state: { type: "string", enum: ["seen", "applied", "ignored"] },
            reason: { type: "string" },
            applied_by_key: { type: "string" },
          },
          required: ["input_version_id", "state"],
          additionalProperties: false,
        },
      },
    },
    required: ["receipts"],
    keyed: true,
  },
  {
    name: "pes_assumption_propose",
    description:
      "가정 하나를 사람이 검토하도록 제안한다. 제안은 확정이 아니다(needs_review). 확인·반려·수정은 사람만 한다. lease가 필요 없다.",
    properties: {
      statement: { type: "string", minLength: 1, description: "가정 문장" },
      rationale: { type: "string", description: "왜 그렇게 가정하는지(선택)" },
    },
    required: ["statement"],
    keyed: true,
  },
  {
    name: "pes_decision_propose",
    description:
      "결정 하나를 사람이 채택하도록 제안한다. 제안은 채택이 아니다. 채택·대체·폐기는 사람만 한다. lease가 필요 없다.",
    properties: {
      statement: { type: "string", minLength: 1, description: "결정 문장" },
      scope: { type: "string", enum: ["project", "edition"], description: "프로젝트 전체인지 이번 판인지" },
      rationale: { type: "string", description: "근거(선택)" },
    },
    required: ["statement", "scope"],
    keyed: true,
  },
  {
    name: "pes_reflection_write",
    description:
      "한 라운드의 반영 내역을 쓴다. 항목마다 disposition(applied·partial·rejected·deferred)과 이유. applied·partial은 증거(결과 버전과 그것을 만든 tx, 또는 적용된 후속)가 있어야 한다. entries가 빈 배열이면 '0건 제출'이다. lease가 필요 없다.",
    properties: {
      target_round_id: { type: "string", minLength: 1 },
      entries: {
        type: "array",
        maxItems: 200,
        items: {
          type: "object",
          properties: {
            source_version_id: { type: "string" },
            disposition: { type: "string", enum: ["applied", "partial", "rejected", "deferred"] },
            rationale: { type: "string" },
            result_version_id: { type: ["string", "null"] },
            followup_id: { type: ["string", "null"] },
            evidence_tx_id: { type: ["string", "null"] },
            supersedes_entry_id: { type: ["string", "null"] },
          },
          required: ["source_version_id", "disposition", "rationale"],
        },
      },
    },
    required: ["target_round_id", "entries"],
    keyed: true,
  },
];

const SPEC_BY_NAME: ReadonlyMap<string, ToolSpec> = new Map(TOOLS.map((spec) => [spec.name, spec]));

export class McpServer {
  readonly #api: ApiLike;
  readonly #project_id: string;
  readonly #token: string;
  readonly #claim_defaults: ClaimDefaults;
  #guard: Guard | null = null;
  #last_run_id: string | null = null;
  /** The guard each lease-ending call sent, by tool and key, so a repeat of that call can be replayed by PES. */
  readonly #sent = new Map<string, Guard>();

  constructor(options: McpServerOptions) {
    if (options === null || typeof options !== "object") throw new TypeError("McpServer options are required");
    if (typeof options.project_id !== "string" || options.project_id.length === 0) {
      throw new TypeError("project_id must be a non-empty string");
    }
    if (typeof options.token !== "string" || options.token.length === 0) {
      throw new TypeError("token must be a non-empty string");
    }
    this.#api = options.api;
    this.#project_id = options.project_id;
    this.#token = options.token;
    this.#claim_defaults = options.claim_defaults ?? { runtime: "mcp", provider: "unknown", model: "unknown" };
  }

  // -------------------------------------------------------------------------
  // JSON-RPC

  /** One JSON-RPC message in, one response out; null for a notification (no reply is ever sent for one). */
  async handle_message(message: unknown): Promise<Record<string, unknown> | null> {
    if (!is_record(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      const id = is_record(message) && (typeof message.id === "string" || typeof message.id === "number") ? message.id : null;
      return this.#rpc_error(id, -32600, "올바른 JSON-RPC 요청이 아닙니다.");
    }
    const has_id = Object.hasOwn(message, "id");
    // A JSON-RPC id is a string, a number or null. Anything else is an invalid request and is never echoed.
    if (has_id && message.id !== null && typeof message.id !== "string" && typeof message.id !== "number") {
      return this.#rpc_error(null, -32600, "id는 문자열, 숫자 또는 null이어야 합니다.");
    }
    const id = has_id ? (message.id as string | number | null) : null;
    const method = message.method;
    const params = message.params;

    try {
      if (!has_id) {
        // notifications/initialized, notifications/cancelled, ...: nothing to answer
        return null;
      }
      switch (method) {
        case "initialize": {
          const asked = is_record(params) && typeof params.protocolVersion === "string" ? params.protocolVersion : "";
          return this.#rpc_result(id, {
            protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "pes", version: "0.0.0" },
            instructions:
              "PES 프로젝트 도구입니다. pes_context로 읽고 pes_claim으로 시작합니다. 승인·봉인·정책·등록은 사람만 합니다.",
          });
        }
        case "ping":
          return this.#rpc_result(id, {});
        case "tools/list":
          return this.#rpc_result(id, {
            tools: TOOLS.map((spec) => ({ name: spec.name, description: spec.description, inputSchema: schema_of(spec) })),
          });
        case "tools/call":
          return await this.#tools_call(id, params);
        default:
          return this.#rpc_error(id, -32601, `지원하지 않는 메서드입니다: ${method}`);
      }
    } catch {
      return this.#rpc_error(id, -32603, "서버 안에서 문제가 생겼습니다.");
    }
  }

  #rpc_result(id: string | number | null, result: unknown): Record<string, unknown> {
    return { jsonrpc: "2.0", id, result };
  }

  #rpc_error(id: string | number | null, code: number, message: string): Record<string, unknown> {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }

  async #tools_call(id: string | number | null, params: unknown): Promise<Record<string, unknown>> {
    if (!is_record(params) || typeof params.name !== "string") {
      return this.#rpc_error(id, -32602, "도구 이름(name)이 필요합니다.");
    }
    const spec = SPEC_BY_NAME.get(params.name);
    if (spec === undefined) return this.#rpc_error(id, -32602, `알 수 없는 도구입니다: ${params.name}`);
    const raw = params.arguments;
    if (raw !== undefined && !is_record(raw)) {
      return this.#rpc_error(id, -32602, "arguments는 객체여야 합니다.");
    }
    const args: Record<string, unknown> = raw ?? {};
    let outcome: Outcome;
    try {
      outcome = await this.#run_tool(spec, args);
    } catch {
      outcome = {
        ok: false,
        error: {
          code: "internal_error",
          message: "도구를 실행하는 중 문제가 생겼습니다. 잠시 뒤 다시 시도해 주세요.",
          retryable: true,
          target: null,
          details: null,
          next_action: "retry_later",
        },
      };
    }
    const payload = outcome.ok ? outcome.data : { error: outcome.error };
    return this.#rpc_result(id, {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: !outcome.ok,
    });
  }

  // -------------------------------------------------------------------------
  // API calls

  async #send(method: string, rest: string, body: unknown, key: string | null): Promise<ApiResult> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}` };
    let payload: string | null = null;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    if (key !== null) headers["idempotency-key"] = key;
    const request: ApiRequestLike = { method, path: project_path(this.#project_id, rest), headers, body: payload };
    return api_request(this.#api, request);
  }

  #from_api(result: ApiResult): Outcome {
    if (!result.ok) return { ok: false, error: { ...result.error } };
    const data: Record<string, unknown> = is_record(result.data) ? { ...result.data } : { value: result.data };
    if (result.replayed) data.replayed = true;
    return { ok: true, data };
  }

  /**
   * A tool could not be built from its arguments (no key, no guard). Ask PES the same question in a form that
   * cannot write; a refusal about the credential (or, for a claim, an unknown run) is the answer. Otherwise the
   * tool's own complaint is.
   */
  async #refuse(
    local: Outcome,
    probe: { method: string; rest: string; body: unknown; key: string | null },
    also: readonly string[] = [],
  ): Promise<Outcome> {
    const result = await this.#send(probe.method, probe.rest, probe.body, probe.key);
    if (!result.ok && (CREDENTIAL_CODES.has(result.error.code) || also.includes(result.error.code))) {
      return { ok: false, error: { ...result.error } };
    }
    return local;
  }

  // -------------------------------------------------------------------------
  // arguments

  #key_of(args: Record<string, unknown>): string | null {
    const key = args.idempotency_key;
    if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_CHARS || !key.isWellFormed()) return null;
    return key;
  }

  #unknown_arguments(spec: ToolSpec, args: Record<string, unknown>): Outcome | null {
    const known = new Set(Object.keys(schema_of(spec).properties));
    for (const name of Object.keys(args)) {
      if (!known.has(name)) return invalid(`$.arguments.${name}`, "알 수 없는 인자입니다.");
    }
    return null;
  }

  /** Optional string-valued arguments: absent is fine, any other type is an input error. */
  #strings(args: Record<string, unknown>, names: readonly string[]): Outcome | null {
    for (const name of names) {
      const value = args[name];
      if (value !== undefined && (typeof value !== "string" || value.length === 0 || !value.isWellFormed())) {
        return invalid(`$.arguments.${name}`, "비어 있지 않은 문자열이어야 합니다.");
      }
    }
    return null;
  }

  #decimal(args: Record<string, unknown>, name: string): Outcome | null {
    const value = args[name];
    if (value === undefined) return null;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return null;
    if (typeof value === "string" && DECIMAL.test(value)) return null;
    return invalid(`$.arguments.${name}`, "10진수 문자열이어야 합니다.");
  }

  /**
   * The guard for a lease-bound tool: explicit arguments over the remembered guard; null when incomplete.
   * `sent` is the guard a lease-ending call already sent under the same key: a repeat uses it, not the
   * current lease, so PES sees the first request again and replays its answer.
   */
  #guard_of(args: Record<string, unknown>, sent: Guard | null = null): Guard | null {
    const remembered = sent ?? this.#guard;
    const run_id = typeof args.run_id === "string" ? args.run_id : undefined;
    const base = remembered !== null && (run_id === undefined || run_id === remembered.run_id) ? remembered : null;
    const lease_id = typeof args.lease_id === "string" ? args.lease_id : base?.lease_id;
    const fence_arg = args.fence;
    const fence =
      typeof fence_arg === "string"
        ? fence_arg
        : typeof fence_arg === "number" && Number.isSafeInteger(fence_arg) && fence_arg >= 0
          ? String(fence_arg)
          : base?.fence;
    const run = run_id ?? base?.run_id;
    if (run === undefined || lease_id === undefined || fence === undefined) return null;
    return { run_id: run, lease_id, fence };
  }

  // -------------------------------------------------------------------------
  // tools

  async #run_tool(spec: ToolSpec, args: Record<string, unknown>): Promise<Outcome> {
    if (spec.name === "pes_context") return this.#context(spec, args);
    if (spec.name === "pes_read") return this.#read(spec, args);
    const key = this.#key_of(args);
    if (key === null) return this.#without_key(spec, args);
    const unknown_arg = this.#unknown_arguments(spec, args);
    if (unknown_arg !== null) return unknown_arg;
    const guard_fields = this.#strings(args, ["run_id", "lease_id"]) ?? this.#decimal(args, "fence");
    if (guard_fields !== null) return guard_fields;
    switch (spec.name) {
      case "pes_claim":
        return this.#claim(args, key);
      case "pes_submit":
        return this.#submit(args, key);
      case "pes_ask":
        return this.#ask(args, key);
      case "pes_wait":
        return this.#wait(args, key);
      case "pes_complete":
        return this.#complete(args, key);
      case "pes_heartbeat":
        return this.#heartbeat(args, key);
      case "pes_release":
        return this.#release(args, key);
      case "pes_cancel":
        return this.#cancel(args, key);
      case "pes_receipt":
        return this.#receipt(args, key);
      case "pes_assumption_propose":
        return this.#assumption_propose(args, key);
      case "pes_decision_propose":
        return this.#decision_propose(args, key);
      case "pes_reflection_write":
        return this.#reflection_write(args, key);
      default:
        return invalid("$.arguments", "알 수 없는 도구입니다.");
    }
  }

  async #without_key(spec: ToolSpec, args: Record<string, unknown>): Promise<Outcome> {
    const local = invalid("$.arguments.idempotency_key", "idempotency_key(비어 있지 않은 문자열)가 필요합니다.");
    if (spec.name === "pes_claim") {
      const target = typeof args.run_id === "string" ? args.run_id : null;
      // an empty body (or only the run asked for) is never a valid claim, so the probe cannot create a run or lease
      return this.#refuse(local, { method: "POST", rest: "/claims", body: target === null ? {} : { run_id: target }, key: null }, ["not_found"]);
    }
    const run = typeof args.run_id === "string" ? args.run_id : (this.#guard?.run_id ?? this.#last_run_id ?? "-");
    return this.#refuse(local, this.#probe_of(spec.name, run, null));
  }

  /**
   * A request of the tool's own route with an empty body: it can only fail, so it can never write.
   * Invariant: all ten probes (the nine here and the claim probe in #without_key, whose body is {} or only
   * {run_id}) fail the route's required-field or Idempotency-Key check in every state of the project.
   */
  #probe_of(name: ToolName, run: string, key: string | null): { method: string; rest: string; body: unknown; key: string | null } {
    const run_path = encodeURIComponent(run);
    switch (name) {
      case "pes_submit":
        return { method: "POST", rest: `/runs/${run_path}/results`, body: {}, key };
      case "pes_ask":
        return { method: "POST", rest: "/questions", body: {}, key };
      case "pes_wait":
        return { method: "POST", rest: `/runs/${run_path}/wait`, body: {}, key };
      case "pes_complete":
        return { method: "POST", rest: `/runs/${run_path}/complete`, body: {}, key };
      case "pes_heartbeat":
        return { method: "POST", rest: `/runs/${run_path}/heartbeat`, body: {}, key };
      case "pes_release":
        return { method: "POST", rest: `/runs/${run_path}/release`, body: {}, key };
      case "pes_cancel":
        return { method: "POST", rest: `/runs/${run_path}/cancel`, body: {}, key };
      case "pes_receipt":
        return { method: "POST", rest: `/runs/${run_path}/input-receipts`, body: {}, key };
      case "pes_assumption_propose":
        return { method: "POST", rest: "/assumptions", body: {}, key };
      case "pes_decision_propose":
        return { method: "POST", rest: "/decisions", body: {}, key };
      case "pes_reflection_write":
        return { method: "POST", rest: "/reflections", body: {}, key };
      default:
        return { method: "POST", rest: "/claims", body: {}, key };
    }
  }

  /** A lease-bound tool with nothing to bind to: PES first (credential, scope), then claim_required. */
  async #no_guard(name: ToolName, args: Record<string, unknown>, key: string): Promise<Outcome> {
    const run = typeof args.run_id === "string" ? args.run_id : (this.#guard?.run_id ?? this.#last_run_id ?? "-");
    return this.#refuse(claim_required(), this.#probe_of(name, run, key));
  }

  #fresh_claim_body(): Record<string, unknown> {
    return { mode: "B", ...this.#claim_defaults };
  }

  async #context(spec: ToolSpec, args: Record<string, unknown>): Promise<Outcome> {
    const unknown_arg = this.#unknown_arguments(spec, args);
    if (unknown_arg !== null) return unknown_arg;
    const bad = this.#strings(args, ["run_id", "inputs_cursor"]);
    if (bad !== null) return bad;
    const context = this.#from_api(await this.#send("GET", "/context", undefined, null));
    if (!context.ok) return context;
    const run = typeof args.run_id === "string" ? args.run_id : (this.#guard?.run_id ?? this.#last_run_id);
    if (run === null) {
      if (typeof args.inputs_cursor === "string") return invalid("$.arguments.inputs_cursor", "답을 이어 읽을 실행(run_id)이 없습니다.");
      return context;
    }
    const cursor = typeof args.inputs_cursor === "string" ? args.inputs_cursor : null;
    let limit = INPUTS_PER_CALL;
    let previous = Number.POSITIVE_INFINITY;
    for (;;) {
      const query = new URLSearchParams();
      if (cursor !== null) query.set("cursor", cursor);
      query.set("limit", String(limit));
      const read = await this.#send("GET", `/runs/${encodeURIComponent(run)}/inputs?${query.toString()}`, undefined, null);
      if (!read.ok) return { ok: true, data: { ...context.data, inputs: null, inputs_error: read.error } };
      const data = is_record(read.data) ? read.data : {};
      const inputs: unknown[] = Array.isArray(data.inputs) ? data.inputs : [];
      // Too big for one reply: take fewer from the same cursor (the next cursor follows the last answer given).
      // A page that did not shrink after the retry (the API ignored `limit`) is taken as it is.
      if (inputs.length > 1 && inputs.length < previous && Buffer.byteLength(JSON.stringify(inputs)) > INPUTS_BYTES_PER_CALL) {
        previous = inputs.length;
        limit = Math.max(1, Math.floor(Math.min(limit, inputs.length) / 2));
        continue;
      }
      const has_more = data.has_more === true && typeof data.next_cursor === "string";
      // The cursor fields come first, so a reply cut short by a client still shows where to go on.
      return {
        ok: true,
        data: {
          inputs_has_more: has_more,
          inputs_next_cursor: has_more ? data.next_cursor : null,
          ...context.data,
          inputs,
        },
      };
    }
  }

  /** One version of one object, through the existing version read: the API decides what this token may see. */
  async #read(spec: ToolSpec, args: Record<string, unknown>): Promise<Outcome> {
    const unknown_arg = this.#unknown_arguments(spec, args);
    if (unknown_arg !== null) return unknown_arg;
    const bad = this.#strings(args, ["object_id", "version_id"]);
    if (bad !== null) return bad;
    if (typeof args.object_id !== "string") {
      // PES answers who is asking first; a read of the context cannot write
      const probe = await this.#send("GET", "/context", undefined, null);
      if (!probe.ok && CREDENTIAL_CODES.has(probe.error.code)) return { ok: false, error: { ...probe.error } };
      return invalid("$.arguments.object_id", "object_id가 필요합니다.");
    }
    const object_id = args.object_id;
    let version_id = typeof args.version_id === "string" ? args.version_id : null;
    if (version_id === null) {
      const context = this.#from_api(await this.#send("GET", "/context", undefined, null));
      if (!context.ok) return context;
      const manifest = Array.isArray(context.data.manifest) ? context.data.manifest : [];
      const entry = manifest.find((item) => is_record(item) && item.object_id === object_id);
      if (!is_record(entry) || typeof entry.version_id !== "string") {
        return local_error("not_found", "그 자료의 현재 버전을 찾을 수 없습니다. version_id를 주세요.", "$.arguments.object_id", "reread_context");
      }
      version_id = entry.version_id;
    }
    return this.#from_api(
      await this.#send("GET", `/objects/${encodeURIComponent(object_id)}/versions/${encodeURIComponent(version_id)}`, undefined, null),
    );
  }

  /** The guard a lease-ending tool already sent under this key, if any. */
  #sent_guard(name: ToolName, key: string): Guard | null {
    return this.#sent.get(`${name} ${key}`) ?? null;
  }

  /** Remember the guard a lease-ending tool sent, so a repeat of the same key reaches PES's replay. */
  #remember_sent(name: ToolName, key: string, guard: Guard): void {
    const slot = `${name} ${key}`;
    this.#sent.delete(slot);
    this.#sent.set(slot, guard);
    while (this.#sent.size > MAX_REMEMBERED_KEYS) {
      const oldest = this.#sent.keys().next().value;
      if (oldest === undefined) break;
      this.#sent.delete(oldest);
    }
  }

  async #claim(args: Record<string, unknown>, key: string): Promise<Outcome> {
    const bad = this.#decimal(args, "expected_control_rev");
    if (bad !== null) return bad;
    const body: Record<string, unknown> = typeof args.run_id === "string" ? { run_id: args.run_id } : this.#fresh_claim_body();
    if (args.expected_control_rev !== undefined) body.expected_control_rev = String(args.expected_control_rev);
    const out = this.#from_api(await this.#send("POST", "/claims", body, key));
    if (out.ok) {
      const { run_id, lease_id, fence } = out.data;
      if (typeof run_id === "string" && typeof lease_id === "string" && fence !== undefined) {
        this.#guard = { run_id, lease_id, fence: String(fence) };
        this.#last_run_id = run_id;
      }
    }
    return out;
  }

  async #submit(args: Record<string, unknown>, key: string): Promise<Outcome> {
    const bad = this.#decimal(args, "expected_control_rev");
    if (bad !== null) return bad;
    if (!Array.isArray(args.results)) return invalid("$.arguments.results", "results는 배열이어야 합니다.");
    const guard = this.#guard_of(args);
    if (guard === null) return this.#no_guard("pes_submit", args, key);
    const body: Record<string, unknown> = { lease_id: guard.lease_id, fence: guard.fence, results: args.results };
    if (args.expected_control_rev !== undefined) body.expected_control_rev = String(args.expected_control_rev);
    return this.#from_api(await this.#send("POST", `/runs/${encodeURIComponent(guard.run_id)}/results`, body, key));
  }

  async #ask(args: Record<string, unknown>, key: string): Promise<Outcome> {
    const bad = this.#strings(args, ["stage_id", "purpose", "form_key"]);
    if (bad !== null) return bad;
    if (!is_record(args.question)) return invalid("$.arguments.question", "question은 객체여야 합니다.");
    const guard = this.#guard_of(args);
    if (guard === null) return this.#no_guard("pes_ask", args, key);
    const body: Record<string, unknown> = {
      stage_id: args.stage_id,
      round_id: args.round_id ?? null,
      purpose: args.purpose,
      question: args.question,
      run_id: guard.run_id,
      lease_id: guard.lease_id,
      fence: guard.fence,
    };
    if (args.form_key !== undefined) body.form_key = args.form_key;
    return this.#from_api(await this.#send("POST", "/questions", body, key));
  }

  async #wait(args: Record<string, unknown>, key: string): Promise<Outcome> {
    const bad = this.#strings(args, ["reason"]);
    if (bad !== null) return bad;
    const guard = this.#guard_of(args, this.#sent_guard("pes_wait", key));
    if (guard === null) return this.#no_guard("pes_wait", args, key);
    const body: Record<string, unknown> = { lease_id: guard.lease_id, fence: guard.fence };
    if (args.reason !== undefined) body.reason = args.reason;
    if (args.wait_ms !== undefined) body.wait_ms = args.wait_ms;
    const out = this.#from_api(await this.#send("POST", `/runs/${encodeURIComponent(guard.run_id)}/wait`, body, key));
    if (out.ok) this.#lease_ended("pes_wait", key, guard, out.data.replayed === true);
    return out;
  }

  async #complete(args: Record<string, unknown>, key: string): Promise<Outcome> {
    if (args.status !== undefined && args.status !== "succeeded" && args.status !== "failed") {
      return invalid("$.arguments.status", 'status는 "succeeded" 또는 "failed"여야 합니다.');
    }
    const guard = this.#guard_of(args, this.#sent_guard("pes_complete", key));
    if (guard === null) return this.#no_guard("pes_complete", args, key);
    const body: Record<string, unknown> = { lease_id: guard.lease_id, fence: guard.fence };
    if (args.status !== undefined) body.status = args.status;
    const out = this.#from_api(await this.#send("POST", `/runs/${encodeURIComponent(guard.run_id)}/complete`, body, key));
    if (out.ok) this.#lease_ended("pes_complete", key, guard, out.data.replayed === true);
    return out;
  }

  async #heartbeat(args: Record<string, unknown>, key: string): Promise<Outcome> {
    let progress: Record<string, unknown> | undefined;
    if (args.progress !== undefined) {
      const given = args.progress;
      if (!is_record(given)) return invalid("$.arguments.progress", "progress는 객체여야 합니다.");
      for (const name of Object.keys(given)) {
        if (name !== "phase" && name !== "observed_at") return invalid(`$.arguments.progress.${name}`, "알 수 없는 인자입니다.");
      }
      if (typeof given.phase !== "string" || !(PROGRESS_PHASES as readonly string[]).includes(given.phase)) {
        return invalid("$.arguments.progress.phase", `phase는 ${PROGRESS_PHASES.join(", ")} 중 하나여야 합니다.`);
      }
      if (given.observed_at !== undefined && (typeof given.observed_at !== "number" || !Number.isSafeInteger(given.observed_at) || given.observed_at < 0)) {
        return invalid("$.arguments.progress.observed_at", "observed_at은 0 이상의 정수(ms)여야 합니다.");
      }
      progress = given.observed_at === undefined ? { phase: given.phase } : { phase: given.phase, observed_at: given.observed_at };
    }
    const guard = this.#guard_of(args);
    if (guard === null) return this.#no_guard("pes_heartbeat", args, key);
    const body: Record<string, unknown> = { lease_id: guard.lease_id, fence: guard.fence };
    if (progress !== undefined) body.progress = progress;
    // The API answer carries the stored note (a replay carries the first one), so it is returned as it is.
    return this.#from_api(await this.#send("POST", `/runs/${encodeURIComponent(guard.run_id)}/heartbeat`, body, key));
  }

  async #release(args: Record<string, unknown>, key: string): Promise<Outcome> {
    const guard = this.#guard_of(args, this.#sent_guard("pes_release", key));
    if (guard === null) return this.#no_guard("pes_release", args, key);
    const body = { lease_id: guard.lease_id, fence: guard.fence };
    const out = this.#from_api(await this.#send("POST", `/runs/${encodeURIComponent(guard.run_id)}/release`, body, key));
    if (out.ok) this.#lease_ended("pes_release", key, guard, out.data.replayed === true);
    return out;
  }

  async #cancel(args: Record<string, unknown>, key: string): Promise<Outcome> {
    if (args.confirm !== true) return invalid("$.arguments.confirm", "취소하려면 confirm:true가 필요합니다.");
    const bad = this.#strings(args, ["reason"]);
    if (bad !== null) return bad;
    // a repeat of this key cancels the run the first call named, not whatever lease is held now
    const run = typeof args.run_id === "string" ? args.run_id : (this.#sent_guard("pes_cancel", key)?.run_id ?? this.#guard?.run_id);
    if (run === undefined) return this.#no_guard("pes_cancel", args, key);
    const body: Record<string, unknown> = { confirm: true };
    if (args.reason !== undefined) body.reason = args.reason;
    const out = this.#from_api(await this.#send("POST", `/runs/${encodeURIComponent(run)}/cancel`, body, key));
    if (out.ok) this.#lease_ended("pes_cancel", key, { run_id: run, lease_id: "", fence: "" }, out.data.replayed === true);
    return out;
  }

  /** The fields a SEL-93 tool forwards: every argument but the idempotency key. The API decides what is acceptable (types, blanks, evidence). */
  #record_body(args: Record<string, unknown>): Record<string, unknown> {
    const { idempotency_key: _key, ...rest } = args;
    return rest;
  }

  /** A proposal needs no lease: the project token's run:submit scope is the whole permission, and it can only propose. */
  async #assumption_propose(args: Record<string, unknown>, key: string): Promise<Outcome> {
    return this.#from_api(await this.#send("POST", "/assumptions", { ...this.#record_body(args), state: "proposed" }, key));
  }

  async #decision_propose(args: Record<string, unknown>, key: string): Promise<Outcome> {
    return this.#from_api(await this.#send("POST", "/decisions", { ...this.#record_body(args), state: "proposed", supersedes: null }, key));
  }

  async #reflection_write(args: Record<string, unknown>, key: string): Promise<Outcome> {
    return this.#from_api(await this.#send("POST", "/reflections", this.#record_body(args), key));
  }

  async #receipt(args: Record<string, unknown>, key: string): Promise<Outcome> {
    const list = args.receipts;
    if (!Array.isArray(list) || list.length < 1 || list.length > 20) {
      return invalid("$.arguments.receipts", "receipts는 1~20개의 배열이어야 합니다.");
    }
    const items: Array<{ input_version_id: string; state: string; reason?: string; applied_by_key?: string }> = [];
    for (const [i, entry] of list.entries()) {
      const at = `$.arguments.receipts[${i}]`;
      if (!is_record(entry)) return invalid(at, "객체여야 합니다.");
      for (const name of Object.keys(entry)) {
        if (!["input_version_id", "state", "reason", "applied_by_key"].includes(name)) return invalid(`${at}.${name}`, "알 수 없는 인자입니다.");
      }
      if (typeof entry.input_version_id !== "string" || entry.input_version_id.length === 0) return invalid(`${at}.input_version_id`, "input_version_id가 필요합니다.");
      if (entry.state !== "seen" && entry.state !== "applied" && entry.state !== "ignored") return invalid(`${at}.state`, "state는 seen, applied, ignored 중 하나여야 합니다.");
      if (entry.reason !== undefined && (typeof entry.reason !== "string" || entry.reason.length === 0)) return invalid(`${at}.reason`, "비어 있지 않은 문자열이어야 합니다.");
      if (entry.state === "applied" && (typeof entry.applied_by_key !== "string" || entry.applied_by_key.length === 0)) {
        return invalid(`${at}.applied_by_key`, "applied는 입력을 쓴 pes_submit의 idempotency_key(applied_by_key)가 필요합니다.");
      }
      items.push({
        input_version_id: entry.input_version_id,
        state: entry.state,
        ...(entry.reason === undefined ? {} : { reason: entry.reason }),
        ...(typeof entry.applied_by_key === "string" ? { applied_by_key: entry.applied_by_key } : {}),
      });
    }
    const guard = this.#guard_of(args);
    if (guard === null) return this.#no_guard("pes_receipt", args, key);
    const receipts: Array<Record<string, unknown>> = [];
    for (const item of items) {
      const out: Record<string, unknown> = { input_version_id: item.input_version_id, state: item.state };
      if (item.reason !== undefined) out.reason = item.reason;
      if (item.state === "applied") {
        // the receipt the PES API wants is the transaction of the submit that used the input
        const found = await this.#send("GET", `/requests/${encodeURIComponent(item.applied_by_key as string)}`, undefined, null);
        if (!found.ok) return { ok: false, error: { ...found.error } };
        const tx = is_record(found.data) ? found.data.tx_id : undefined;
        // only a result submission is evidence that an input was used; a heartbeat, ask, wait or claim key is not
        const action = is_record(found.data) ? found.data.action : undefined;
        if (action !== "result.submit" || (is_record(found.data) && found.data.run_id !== guard.run_id)) {
          return local_error("not_found", "그 키는 이 실행의 결과 제출(pes_submit)이 아니어서 입력을 썼다는 증거가 될 수 없습니다.", `$.arguments.receipts`, "reread_context");
        }
        if (typeof tx !== "string" || tx.length === 0) return local_error("not_found", "그 키로 낸 제출을 찾을 수 없습니다.", `$.arguments.receipts`, "reread_context");
        out.applied_tx_id = tx;
      }
      receipts.push(out);
    }
    const body = { lease_id: guard.lease_id, fence: guard.fence, receipts };
    return this.#from_api(await this.#send("POST", `/runs/${encodeURIComponent(guard.run_id)}/input-receipts`, body, key));
  }

  /**
   * A lease-ending call succeeded: remember what this key sent for a repeat. The remembered guard is cleared only by
   * a real success (not a replay) whose run_id, lease_id and fence all equal the remembered one; a replay of an old
   * call must not forget a lease taken since (same run, newer fence). A cancel names only the run, which cannot be
   * re-claimed, so for it the run_id decides.
   */
  #lease_ended(name: ToolName, key: string, guard: Guard, replayed: boolean): void {
    this.#remember_sent(name, key, guard);
    if (replayed) return;
    const held = this.#guard;
    if (held === null || held.run_id !== guard.run_id) return;
    if (guard.lease_id === "" || (held.lease_id === guard.lease_id && held.fence === guard.fence)) this.#guard = null;
  }
}

// ---------------------------------------------------------------------------
// stdio transport: newline-delimited JSON-RPC, nothing else on the output

export interface StdioStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

const MAX_LINE_CHARS = 4 * 1024 * 1024;

/** Serve until `input` ends (or the peer closes the output). Messages are handled one at a time, in order. */
export function serve_stdio(server: McpServer, streams: StdioStreams): Promise<void> {
  const { input, output } = streams;
  return new Promise<void>((resolve) => {
    let buffer = "";
    let skipping = false;
    let closed = false;
    let finished = false;
    let chain: Promise<void> = Promise.resolve();
    input.setEncoding("utf8");

    const finish = (): void => {
      if (finished) return;
      finished = true;
      void chain.then(() => resolve());
    };
    const write = (message: Record<string, unknown>): void => {
      if (closed) return;
      output.write(`${JSON.stringify(message)}\n`);
    };
    // The peer closed its end (EPIPE): stop writing and end like an ended input instead of crashing.
    output.on("error", () => {
      closed = true;
      finish();
    });
    const too_long = (): void => {
      chain = chain.then(() => {
        write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "요청 한 줄이 너무 깁니다." } });
      });
    };
    const line = (text: string): void => {
      const trimmed = text.replace(/\r$/, "");
      if (trimmed.trim().length === 0) return;
      chain = chain.then(async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON을 읽을 수 없습니다." } });
          return;
        }
        if (Array.isArray(parsed)) {
          write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "배치 요청은 지원하지 않습니다." } });
          return;
        }
        const reply = await server.handle_message(parsed);
        if (reply !== null) write(reply);
      });
    };

    input.on("data", (chunk: string | Buffer) => {
      if (closed) return;
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const text = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (skipping) {
          // the end of a line that was already reported as too long
          skipping = false;
          continue;
        }
        // The limit is per line: a whole oversized line that arrives in one chunk is refused, once, too.
        if (text.length > MAX_LINE_CHARS) {
          too_long();
          continue;
        }
        line(text);
      }
      if (buffer.length > MAX_LINE_CHARS) {
        buffer = "";
        // while the rest of the oversized line is dropped, the error is reported only once
        if (!skipping) {
          skipping = true;
          too_long();
        }
      }
    });
    input.on("end", () => {
      if (!skipping && !closed && buffer.length > 0) line(buffer);
      buffer = "";
      finish();
    });
    input.on("error", () => {
      finish();
    });
  });
}

// ---------------------------------------------------------------------------
// process entry: node mcp_server.ts, configured by the environment the MCP client passes

async function main(): Promise<void> {
  const { HttpApi } = await import("./adapters/http_api.ts");
  const project_id = process.env.PES_PROJECT_ID ?? "";
  const base_url = process.env.PES_API_BASE_URL ?? "";
  const token = process.env.PES_AGENT_TOKEN ?? "";
  if (project_id.length === 0 || base_url.length === 0 || token.length === 0) {
    process.stderr.write("PES_PROJECT_ID, PES_API_BASE_URL, PES_AGENT_TOKEN 환경변수가 필요합니다.\n");
    process.exitCode = 2;
    return;
  }
  let api;
  try {
    api = new HttpApi(base_url);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "PES_API_BASE_URL이 올바르지 않습니다."}\n`);
    process.exitCode = 2;
    return;
  }
  const server = new McpServer({
    api,
    project_id,
    token,
    claim_defaults: {
      // No guess about the tool: an adapter entry names its runtime (PES_RUNTIME, PES_PROVIDER, PES_MODEL).
      runtime: process.env.PES_RUNTIME ?? "mcp",
      provider: process.env.PES_PROVIDER ?? "unknown",
      model: process.env.PES_MODEL ?? "unknown",
    },
  });
  await serve_stdio(server, { input: process.stdin, output: process.stdout });
}

if (import.meta.main) {
  await main();
}

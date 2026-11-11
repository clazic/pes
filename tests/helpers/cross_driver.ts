// SEL-56: one abstract step language, two drivers. The same step ("claim", "submit", "ask", ...) is run on path A
// (internal_ai actor, the built-in runner's own tool path + the same run commands the loop issues) or on path B
// (external_agent over MCP, one of the six tools), and each step returns the SAME normalised outcome:
//
//   { ok, code, message, events, receipts, lease, run_status, versions }
//
// ids, actor, runtime, mode, clock and the Korean-vs-English wording of a message are NOT part of the comparison; the
// event types, the receipt actions, the error code (core spelling), the lease/run state and the number of versions the
// step added are.

import assert from "node:assert/strict";

import { run_tool, type RunHandle } from "../../scripts/pes_core/a_runtime/tools.ts";
import { ApiError } from "../../scripts/pes_core/errors.ts";
import { single_spec } from "./questions_env.ts";
import {
  core_code,
  event_types_since,
  last_event_seq,
  last_receipt_rowid,
  lease_row,
  next_key,
  receipt_actions_since,
  run_info,
  versions_of,
  type BTool,
  type CrossEnv,
} from "./cross_env.ts";
import type { FakeMcpClient } from "./adapter_b_env.ts";

export interface Guard {
  run_id: string;
  lease_id: string;
  fence: number;
}

export interface Step {
  op: string;
  /** submit: "base" (the artifact object) | "missing" */
  object?: "base" | "missing";
  /** submit: "normal" | "empty" | "not_array" */
  results?: "normal" | "empty" | "not_array" | "partial";
  /** which guard the step presents: "current" (default) | "previous" (the one that ended) | "fence_plus_one" */
  guard?: "current" | "previous" | "fence_plus_one";
  title?: string;
  status?: string;
  /** present exactly this guard (an older one kept by the test), whatever the driver holds */
  guard_value?: Guard;
  /** use this idempotency key / request key instead of a fresh one (a retry of an earlier step) */
  key?: string;
}

export interface StepResult {
  ok: boolean;
  code: string | null;
  message: string | null;
  events: string[];
  receipts: string[];
  lease: string | null;
  run_status: string | null;
  versions_added: number;
  data: any;
  /** the error code as the path spelled it (B: the HTTP/MCP name; A: the core name, or null for a bare sentence) */
  raw_code: string | null;
}

/** B's own spelling of the refusal of an OLD guard, per tool (decision 0020, interpretation 3) */
export function b_stale_guard_raw_code(op: string): string {
  return op === "heartbeat" || op === "release" ? "lease_lost" : "conflict";
}

export type Side = { kind: "A" } | { kind: "B"; tool: BTool };

const GUARD_OPS = new Set(["submit", "ask", "wait", "release", "complete", "heartbeat"]);

export class Driver {
  readonly env: CrossEnv;
  readonly side: Side;
  guard: Guard | null = null;
  previous: Guard | null = null;
  client: FakeMcpClient | null = null;

  constructor(env: CrossEnv, side: Side) {
    this.env = env;
    this.side = side;
  }

  get label(): string {
    return this.side.kind === "A" ? "A" : `B:${this.side.tool.id}`;
  }

  /** unique per ENV (not per driver): two drivers of the same side must never replay each other's receipts */
  #key(tag: string): string {
    return next_key(this.env, `drv-${this.label}-${tag}`);
  }

  async #mcp(): Promise<FakeMcpClient> {
    assert.equal(this.side.kind, "B");
    if (this.client === null) this.client = await this.env.mcp_client((this.side as { tool: BTool }).tool);
    return this.client;
  }

  #guard_for(step: Step): Guard {
    if (step.guard_value !== undefined) return step.guard_value;
    const current = this.guard;
    const previous = this.previous;
    const pick = step.guard ?? "current";
    if (pick === "previous") {
      assert.ok(previous, "a previous guard");
      return previous;
    }
    assert.ok(current ?? previous, "a guard");
    const base = current ?? previous!;
    return pick === "fence_plus_one" ? { ...base, fence: base.fence + 1 } : base;
  }

  async step(step: Step): Promise<StepResult> {
    const env = this.env;
    const ev = last_event_seq(env);
    const rc = last_receipt_rowid(env);
    const versions_before = this.#versions_count();
    let ok = true;
    let code: string | null = null;
    let message: string | null = null;
    let data: any = null;
    let raw_code: string | null = null;
    try {
      data = this.side.kind === "A" ? await this.#a(step) : await this.#b(step);
    } catch (error) {
      if (error instanceof StepFailure) {
        ok = false;
        code = core_code(error.code);
        message = error.message;
        raw_code = error.raw_code;
      } else if (error instanceof ApiError) {
        ok = false;
        code = core_code(error.code);
        message = error.message;
        raw_code = error.code;
      } else {
        throw error;
      }
    }
    const lease = lease_row(env);
    const run_id = this.guard?.run_id ?? this.previous?.run_id ?? null;
    return {
      ok,
      code,
      message,
      events: event_types_since(env, ev),
      receipts: receipt_actions_since(env, rc),
      lease: lease === undefined ? null : lease.state,
      run_status: run_id === null ? null : run_info(env, run_id).status,
      versions_added: this.#versions_count() - versions_before,
      data,
      raw_code,
    };
  }

  #versions_count(): number {
    const opened = this.env.opened;
    return opened === undefined ? 0 : versions_of(this.env, opened.object_id).length;
  }

  // ------------------------------------------------------------------ path A

  #handle(guard: Guard): RunHandle {
    const opened = this.env.opened!;
    return {
      project_id: this.env.p.project_id,
      actor_id: this.env.ai_actor_id,
      run_id: guard.run_id,
      lease_id: guard.lease_id,
      fence: guard.fence,
      stage_id: opened.stage_id,
      round_id: opened.round_id,
    };
  }

  async #a_tool(guard: Guard, name: string, args: unknown, key?: string): Promise<any> {
    const out = await run_tool(
      { service: this.env.service, db: this.env.db, run: this.#handle(guard), request_key: key ?? this.#key("tool"), save_retries: 2 },
      { id: "call", name, args },
      0,
    );
    const body = JSON.parse(out.result.content) as { ok: boolean; error?: string; [k: string]: unknown };
    if (!body.ok) {
      const text = String(body.error ?? "");
      const at = text.indexOf(": ");
      // A tool-level argument check answers with a bare sentence (no "code: " prefix): that is an invalid_payload.
      throw new StepFailure(at < 0 ? "invalid_payload" : text.slice(0, at), at < 0 ? text : text.slice(at + 2), at < 0 ? null : text.slice(0, at));
    }
    return body;
  }

  #results_arg(step: Step): unknown {
    const opened = this.env.opened!;
    const kind = step.results ?? "normal";
    if (kind === "empty") return [];
    if (kind === "not_array") return "not-an-array";
    if (kind === "partial") {
      // one good item, then one for an object that does not exist: all or nothing
      return [
        { op: "append_version", object_id: opened.object_id, title: step.title ?? "합성 교차 결과" },
        { op: "append_version", object_id: "00000000-0000-4000-8000-000000000000", title: "없는 자료" },
      ];
    }
    const object_id = (step.object ?? "base") === "base" ? opened.object_id : "00000000-0000-4000-8000-000000000000";
    return [{ op: "append_version", object_id, title: step.title ?? "합성 교차 결과" }];
  }

  async #a(step: Step): Promise<any> {
    const env = this.env;
    const opened = env.opened!;
    switch (step.op) {
      case "claim": {
        const selection = env.db.get<{ connection_id: string; model: string }>(
          "SELECT connection_id, model FROM project_ai_selections WHERE project_id = ? ORDER BY rowid DESC LIMIT 1",
          env.p.project_id,
        )!;
        const created = await env.service.execute(env.ctx(this.#key("create")), "run.create", {
          actor_id: env.ai_actor_id,
          mode: "A",
          runtime: "pes_builtin",
          provider: env.format,
          model: selection.model,
          ai_connection_id: selection.connection_id,
          stage_id: opened.stage_id,
          round_id: opened.round_id,
        });
        const run_id = (created.result as { run_id: string }).run_id;
        const control = env.db.get<{ control_rev: bigint }>("SELECT control_rev FROM projects WHERE id = ?", env.p.project_id);
        const claimed = await env.service.execute(
          { ...env.agent_ctx(env.ai_actor_id, this.#key("claim")), base_control_rev: Number(control?.control_rev ?? 0n) },
          "run.claim",
          { run_id },
        );
        const lease = claimed.result as { lease_id: string; fence: number };
        if (this.guard !== null) this.previous = this.guard;
        this.guard = { run_id, lease_id: lease.lease_id, fence: lease.fence };
        return { run_id };
      }
      case "submit":
        return this.#a_tool(this.#guard_for(step), "result.submit", { results: this.#results_arg(step) }, step.key);
      case "ask": {
        const out = await this.#a_tool(this.#guard_for(step), "question.ask", { questions: [single_spec("합성 교차 질문")] });
        return out;
      }
      case "wait":
      case "release":
      case "complete":
      case "heartbeat": {
        const guard = this.#guard_for(step);
        const command = { wait: "run.wait", release: "run.release", complete: "run.complete", heartbeat: "run.heartbeat" }[step.op]!;
        const payload: Record<string, unknown> = { ...guard };
        if (step.op === "complete" && step.status !== undefined) payload.status = step.status;
        const out = await env.service.execute(env.agent_ctx(env.ai_actor_id, this.#key(step.op)), command, payload);
        if (step.op !== "heartbeat" && step.guard_value === undefined && (step.guard ?? "current") === "current") {
          this.previous = this.guard;
          this.guard = null;
        }
        return out.result;
      }
      case "human_only_approve": {
        await env.service.execute(env.agent_ctx(env.ai_actor_id, this.#key("approve")), "stage.approve", {
          stage_id: opened.stage_id,
          snapshot_id: "00000000-0000-4000-8000-000000000000",
        });
        return null;
      }
      case "human_only_policy": {
        await env.service.execute(env.agent_ctx(env.ai_actor_id, this.#key("policy")), "policy.set", {
          allow_opencode_go: false,
          reason: "합성: 에이전트가 정책을 바꾸려 함",
        });
        return null;
      }
      default:
        throw new Error(`unknown step ${step.op}`);
    }
  }

  // ------------------------------------------------------------------ path B

  async #b(step: Step): Promise<any> {
    const env = this.env;
    const opened = env.opened!;
    const client = await this.#mcp();
    const must = async (name: string, args: Record<string, unknown>): Promise<any> => {
      const out = await client.tool(name, args);
      if (out.is_error) throw new StepFailure(String(out.data.error.code), String(out.data.error.message));
      return out.data;
    };
    const explicit = (g: Guard): Record<string, unknown> => ({ run_id: g.run_id, lease_id: g.lease_id, fence: String(g.fence) });
    switch (step.op) {
      case "claim": {
        const out = await must("pes_claim", { idempotency_key: this.#key("claim") });
        if (this.guard !== null) this.previous = this.guard;
        this.guard = { run_id: out.run_id, lease_id: out.lease_id, fence: Number(out.fence) };
        return out;
      }
      case "submit":
        return must("pes_submit", {
          idempotency_key: step.key ?? this.#key("submit"),
          ...explicit(this.#guard_for(step)),
          results: this.#results_arg(step),
        });
      case "ask":
        return must("pes_ask", {
          ...explicit(this.#guard_for(step)),
          stage_id: opened.stage_id,
          round_id: opened.round_id,
          purpose: "review",
          form_key: `drv-${this.label}-ask-${this.env.seq}`,
          question: single_spec("합성 교차 질문"),
          idempotency_key: this.#key("ask"),
        });
      case "wait":
      case "release":
      case "complete":
      case "heartbeat": {
        const guard = this.#guard_for(step);
        const tool = { wait: "pes_wait", release: "pes_release", complete: "pes_complete", heartbeat: "pes_heartbeat" }[step.op]!;
        const args: Record<string, unknown> = { ...explicit(guard) };
        args.idempotency_key = this.#key(step.op);
        if (step.op === "complete" && step.status !== undefined) args.status = step.status;
        const out = await must(tool, args);
        if (step.op !== "heartbeat" && step.guard_value === undefined && (step.guard ?? "current") === "current") {
          this.previous = this.guard;
          this.guard = null;
        }
        return out;
      }
      case "human_only_approve":
        return this.#http(env, "POST", `/stages/${opened.stage_id}/approve`, { stage_id: opened.stage_id, snapshot_id: "00000000-0000-4000-8000-000000000000" });
      case "human_only_policy":
        return this.#http(env, "POST", "/policies/opencode-go/revisions", { allow_opencode_go: false, reason: "합성: 에이전트가 정책을 바꾸려 함" });
      default:
        throw new Error(`unknown step ${step.op}`);
    }
  }

  /** The same human-only action over HTTP with the tool's own agent token (the MCP server has no such tool). */
  async #http(env: CrossEnv, method: string, rest: string, body: unknown): Promise<any> {
    const res = await env.app.handle({
      method,
      path: `/api/v1/projects/${env.p.project_id}${rest}`,
      headers: { authorization: `Bearer ${env.agent.token}`, "content-type": "application/json", "idempotency-key": this.#key("http") },
      body: JSON.stringify(body),
    });
    if (res.status >= 400) {
      const body = res.json as { error: { code: string; message: string } };
      throw new StepFailure(String(body.error.code), String(body.error.message));
    }
    return res.json;
  }
}

export class StepFailure extends Error {
  readonly code: string;
  /** the code exactly as the path spelled it (null when it spelled none) */
  readonly raw_code: string | null;
  constructor(code: string, message: string, raw_code: string | null = code) {
    super(message);
    this.code = code;
    this.raw_code = raw_code;
  }
}

export function is_guard_op(op: string): boolean {
  return GUARD_OPS.has(op);
}

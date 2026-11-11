// SEL-56 (stage 2 PR21, "A·B 교차 계약") shared harness. Everything is synthetic: invented keys, slugs, model ids,
// a temporary HOME/PES_HOME, a FakeClock, the PR19 fake AI HTTP server on 127.0.0.1, and the PR20a fake MCP client.
// No real model, no external call, no app setting (~/.claude, ~/.codex, ~/.config/opencode) is read or written.
//
// ONE database, TWO ways in:
//   path A  (internal_ai actor)   the PR19 built-in runner: `BuiltinExecutor` against the fake AI server, or - for the
//                                 comparison table - the runner's own tool path (`run_tool`) after the same
//                                 `run.create` + `run.claim` the loop issues.
//   path B  (external_agent)      the MCP server (`McpServer`) over the HTTP API app, driven by the fake MCP client,
//                                 once per tool entry (Claude Code, Codex CLI, OpenCode TUI, Codex app, OpenCode app
//                                 direct connections; the Claude app and the explicit hand-off of the three apps through
//                                 the hand-off adapter).
// Both reach the same CommandService and the same tables, so a contract test can compare what the two paths leave
// behind (events, receipt actions, error codes, run/lease rows) from the same start state.

import assert from "node:assert/strict";

import { ApiApp } from "../../scripts/pes_core/api.ts";
import { claude_code_mcp_entry } from "../../scripts/pes_core/adapters/claude_code.ts";
import { codex_app_mcp_entry } from "../../scripts/pes_core/adapters/codex_app.ts";
import { codex_cli_mcp_entry } from "../../scripts/pes_core/adapters/codex_cli.ts";
import { opencode_app_mcp_entry } from "../../scripts/pes_core/adapters/opencode_app.ts";
import { opencode_tui_mcp_entry } from "../../scripts/pes_core/adapters/opencode_tui.ts";
import { McpServer } from "../../scripts/pes_core/mcp_server.ts";
import { run_tool, type RunHandle, type ToolOutcome } from "../../scripts/pes_core/a_runtime/tools.ts";
import { ApiError } from "../../scripts/pes_core/errors.ts";
import {
  SESSION_SECRET,
  make_agent,
  type Agent,
  type ApiEnv,
} from "./api_env.ts";
import {
  make_a_env,
  next_key,
  open_stage,
  ready_project,
  type AEnv,
  type Format,
  type MakeAOptions,
  type Opened,
} from "./a_builtin_env.ts";
import { FakeMcpClient } from "./adapter_b_env.ts";

export { with_a_env, START_MS } from "./a_builtin_env.ts";

/** The B tools of the issue: runtime/provider as the adapters' MCP entries name them (PES_RUNTIME, PES_PROVIDER). */
export interface BTool {
  /** table key */
  id: "claude_code" | "claude_app" | "codex_cli" | "opencode_tui" | "codex_app" | "opencode_app";
  /** direct connection (MCP): the claim defaults the adapter's entry puts in the server's environment. null = none */
  direct: { runtime: string; provider: string; model: string } | null;
  /** explicit hand-off through the owner (import); the app name the import takes. null = none */
  handoff: "claude_app" | "codex_app" | "opencode_app" | null;
}

const ENTRY_INPUT = {
  command: "/synthetic/node",
  server_script: "/synthetic/mcp_server.ts",
  project_id: "synthetic-project",
  api_base_url: "http://127.0.0.1:8760",
} as const;

function defaults_of(env: Record<string, string | undefined>): { runtime: string; provider: string; model: string } {
  // exactly what mcp_server.ts main() reads from the entry's environment
  return { runtime: env["PES_RUNTIME"] ?? "mcp", provider: env["PES_PROVIDER"] ?? "unknown", model: env["PES_MODEL"] ?? "unknown" };
}

/**
 * The claim defaults of each direct connection come from the adapters' OWN entries (not copied by hand), so a change
 * of an adapter's runtime/provider label changes this table with it. The Claude app has no direct connection.
 */
export const B_TOOLS: readonly BTool[] = Object.freeze([
  { id: "claude_code", direct: defaults_of(claude_code_mcp_entry(ENTRY_INPUT).env), handoff: null },
  { id: "claude_app", direct: null, handoff: "claude_app" },
  { id: "codex_cli", direct: defaults_of(codex_cli_mcp_entry(ENTRY_INPUT).env), handoff: null },
  { id: "opencode_tui", direct: defaults_of(opencode_tui_mcp_entry(ENTRY_INPUT).environment), handoff: null },
  { id: "codex_app", direct: defaults_of(codex_app_mcp_entry(ENTRY_INPUT).env), handoff: "codex_app" },
  { id: "opencode_app", direct: defaults_of(opencode_app_mcp_entry(ENTRY_INPUT).environment), handoff: "opencode_app" },
]);

export interface CrossEnv extends AEnv, ApiEnv {
  /** an external_agent of the owner's user (the default B actor) */
  agent: Agent;
  /** a project opened to the plan stage with one artifact object (see `open_plan`) */
  opened?: Opened;
  /** a fresh MCP server on the shared API app for the given token and claim defaults */
  mcp_server(token: string, defaults: { runtime: string; provider: string; model: string }): McpServer;
  /** a fresh, initialized fake MCP client */
  mcp_client(tool: BTool, token?: string): Promise<FakeMcpClient>;
  /** every client opened through mcp_client is closed by close_cross */
  clients: FakeMcpClient[];
  close_cross(): Promise<void>;
}

export async function make_cross_env(format: Format = "openai_compatible", options: MakeAOptions = {}): Promise<CrossEnv> {
  const base = (await make_a_env(format, options)) as CrossEnv;
  // The API app sits on the very same database handle the built-in runner uses.
  base.hold_sleep = false;
  base.gates = [];
  base.agents = new Map();
  base.begin_count = () => 0;
  base.app = new ApiApp({
    db: base.db,
    clock: base.clock,
    objects_dir: base.objects,
    local_session_secret: SESSION_SECRET,
    sleep: () => Promise.resolve(),
  });
  base.agent = await make_agent(base, "cross-b");
  base.clients = [];
  base.mcp_server = (token, defaults) =>
    new McpServer({ api: base.app, project_id: base.p.project_id, token, claim_defaults: defaults });
  base.mcp_client = async (tool, token = base.agent.token) => {
    const defaults = tool.direct ?? { runtime: "mcp", provider: "unknown", model: "unknown" };
    const client = new FakeMcpClient(base.mcp_server(token, defaults));
    await client.initialize();
    base.clients.push(client);
    return client;
  };
  base.close_cross = async () => {
    for (const client of base.clients) await client.close();
    base.clients.length = 0;
    await base.close_all();
  };
  return base;
}

export async function with_cross_env(
  format: Format,
  fn: (env: CrossEnv) => Promise<void> | void,
  options: MakeAOptions = {},
): Promise<void> {
  const env = await make_cross_env(format, options);
  try {
    await fn(env);
  } finally {
    await env.close_cross();
  }
}

/** register the AI connection, select the model, open the plan stage with a round and one artifact object. */
export async function ready_cross(env: CrossEnv): Promise<Opened> {
  await ready_project(env);
  const opened = await open_stage(env, "plan");
  env.opened = opened;
  return opened;
}

// ---------------------------------------------------------------------------
// path A, tool level: the runner's own tool path with a claim made exactly like the loop makes it

export interface AClaim {
  handle: RunHandle;
  call: (name: string, args: unknown, index?: number) => Promise<ToolOutcome>;
}

/** run.create (owner) + run.claim (the internal_ai actor) as BuiltinExecutor does, without any model call. */
export async function a_claim(env: CrossEnv, key = "cross-a"): Promise<AClaim> {
  const opened = env.opened;
  assert.ok(opened, "ready_cross first");
  const selection = env.db.get<{ connection_id: string; model: string }>(
    "SELECT connection_id, model FROM project_ai_selections WHERE project_id = ? ORDER BY rowid DESC LIMIT 1",
    env.p.project_id,
  );
  assert.ok(selection, "a selected AI connection");
  const created = await env.service.execute(env.ctx(`${key}-create`), "run.create", {
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
    { ...env.agent_ctx(env.ai_actor_id, `${key}-claim`), base_control_rev: Number(control?.control_rev ?? 0n) },
    "run.claim",
    { run_id },
  );
  const lease = claimed.result as { lease_id: string; fence: number };
  const handle: RunHandle = {
    project_id: env.p.project_id,
    actor_id: env.ai_actor_id,
    run_id,
    lease_id: lease.lease_id,
    fence: lease.fence,
    stage_id: opened.stage_id,
    round_id: opened.round_id,
  };
  let n = 0;
  return {
    handle,
    call: (name, args, index) => {
      n += 1;
      return run_tool(
        { service: env.service, db: env.db, run: handle, request_key: `${key}-t${n}`, save_retries: 2 },
        { id: `call-${n}`, name, args },
        index ?? 0,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// reading the shared tables

export function lease_row(env: CrossEnv): { state: string; run_id: string | null; owner_actor_id: string | null; lease_id: string; fence: number } | undefined {
  const row = env.db.get<{ state: string; run_id: string | null; owner_actor_id: string | null; lease_id: string; fence: bigint }>(
    "SELECT state, run_id, owner_actor_id, lease_id, fence FROM project_leases WHERE project_id = ?",
    env.p.project_id,
  );
  return row === undefined ? undefined : { ...row, fence: Number(row.fence) };
}

export function run_info(env: CrossEnv, run_id: string): { id: string; status: string; mode: string; runtime: string; provider: string; model: string; actor_id: string; parent_run_id: string | null } {
  const row = env.db.get<any>(
    "SELECT id, status, mode, runtime, provider, model, actor_id, parent_run_id FROM runs WHERE project_id = ? AND id = ?",
    env.p.project_id,
    run_id,
  );
  assert.ok(row, `run ${run_id}`);
  return row;
}

export function event_types_since(env: CrossEnv, seq: number): string[] {
  return env.db
    .all<{ type: string }>("SELECT type FROM events WHERE project_id = ? AND event_seq > ? ORDER BY event_seq", env.p.project_id, seq)
    .map((r) => r.type);
}

export function last_event_seq(env: CrossEnv): number {
  const row = env.db.get<{ n: bigint | null }>("SELECT max(event_seq) AS n FROM events WHERE project_id = ?", env.p.project_id);
  return Number(row?.n ?? 0n);
}

export function receipt_actions_since(env: CrossEnv, since_rowid: number): string[] {
  return env.db
    .all<{ action: string }>(
      "SELECT action FROM mutation_commits WHERE project_id = ? AND rowid > ? ORDER BY rowid",
      env.p.project_id,
      since_rowid,
    )
    .map((r) => r.action);
}

export function last_receipt_rowid(env: CrossEnv): number {
  const row = env.db.get<{ n: bigint | null }>("SELECT max(rowid) AS n FROM mutation_commits WHERE project_id = ?", env.p.project_id);
  return Number(row?.n ?? 0n);
}

/** versions of an object, oldest first, with who wrote them (run) */
export function versions_of(env: CrossEnv, object_id: string): Array<{ id: string; version_no: number; run_id: string | null }> {
  return env.db
    .all<{ id: string; version_no: bigint; run_id: string | null }>(
      "SELECT id, version_no, run_id FROM object_versions WHERE object_id = ? ORDER BY version_no",
      object_id,
    )
    .map((r) => ({ id: r.id, version_no: Number(r.version_no), run_id: r.run_id }));
}

export function dispatch_count(env: CrossEnv, run_id?: string): number {
  const row =
    run_id === undefined
      ? env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM outbound_dispatches WHERE project_id = ?", env.p.project_id)
      : env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM outbound_dispatches WHERE project_id = ? AND run_id = ?", env.p.project_id, run_id);
  return Number(row?.n ?? 0n);
}

export function unknown_dispatches(env: CrossEnv): Array<{ id: string; run_id: string; state: string; unknown_reason: string | null }> {
  return env.db.all<any>(
    "SELECT id, run_id, state, unknown_reason FROM outbound_dispatches WHERE project_id = ? AND state = 'unknown' ORDER BY rowid",
    env.p.project_id,
  );
}

// ---------------------------------------------------------------------------
// normalisation: what a comparison keeps and what it drops (ids, actor, runtime, mode, clock-dependent values)

export interface Outcome {
  ok: boolean;
  /** the stable error code, core spelling (policy_blocked is the HTTP name of policy_denied) */
  code: string | null;
  /** the English core message when the path exposes it; Korean API messages are compared by `code` only */
  message: string | null;
  events: string[];
  receipts: string[];
}

/**
 * The HTTP/MCP names of three refusals, in the core spelling the built-in runner shows: Go OFF is `policy_blocked`
 * over HTTP (`policy_denied` in the core), a human-only action is `human_required` / `owner_required` (`forbidden`),
 * and a stale guard on heartbeat / release is `lease_lost` (input-receipts is not tested, decision 0020 note 3) (the other lease routes say `conflict`).
 * The comparison is by meaning; the raw B spelling is pinned separately by the fixture (`b_raw_code`).
 */
export const HTTP_TO_CORE_CODE: Record<string, string> = {
  policy_blocked: "policy_denied",
  human_required: "forbidden",
  owner_required: "forbidden",
  lease_lost: "conflict",
};

export function core_code(code: string): string {
  return HTTP_TO_CORE_CODE[code] ?? code;
}

export function is_api_error(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export { next_key, SESSION_SECRET };

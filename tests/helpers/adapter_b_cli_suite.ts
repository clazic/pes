// SEL-54 (stage 2 PR20b) shared suite for the two method-B CLI adapters: Codex CLI and OpenCode TUI.
// Everything is synthetic: the 20a fake MCP client over the real in-memory ApiApp, a temporary HOME, an
// in-memory fake key store, invented slugs and tokens. No codex or opencode process is ever started, and no
// ~/.codex or ~/.config/opencode is read or written.
//
// Interface the tests pin (the worker implements it; 해석 numbers are in tests/test_adapter_b_codex.test.ts):
//
//   scripts/pes_core/adapters/codex_cli.ts
//     codex_cli_mcp_entry({command, server_script, project_id, api_base_url, model?})
//         -> {command, args:[server_script], env:{PES_PROJECT_ID, PES_API_BASE_URL, PES_RUNTIME:"codex_cli",
//             PES_PROVIDER:"openai", PES_MODEL: model ?? "unknown"}, env_vars:["PES_AGENT_TOKEN"]}
//         (the [mcp_servers.pes] table of ~/.codex/config.toml; the token is forwarded BY NAME, never by value)
//     codex_cli_launch_env({key_store, project_id}) -> Promise<{PES_AGENT_TOKEN}>
//   scripts/pes_core/adapters/opencode_tui.ts
//     opencode_tui_mcp_entry({command, server_script, project_id, api_base_url, model?})
//         -> {type:"local", command:[command, server_script], environment:{PES_PROJECT_ID, PES_API_BASE_URL,
//             PES_RUNTIME:"opencode_tui", PES_PROVIDER:"unknown", PES_MODEL: model ?? "unknown",
//             PES_AGENT_TOKEN:"{env:PES_AGENT_TOKEN}"}, enabled:true}
//         (the mcp.pes entry of opencode.json; OpenCode expands {env:VAR}; a model on the Go route is refused)
//     opencode_tui_launch_env({key_store, project_id}) -> Promise<{PES_AGENT_TOKEN}>
//
//   key store (the PR19 interface, here a fake): { put(ref, secret), get(ref), delete(ref), where() }, each sync or
//     async; get gives string | null. The adapter calls get(ref) with ONE argument,
//     ref = "pes-agent-token-<runtime>-<project_id>" (runtime = codex_cli / opencode_tui).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { McpServer } from "../../scripts/pes_core/mcp_server.ts";
import { ask_args, FakeMcpClient, make_adapter_env, owner_answers, TOOLS, wire, type AdapterEnv } from "./adapter_b_env.ts";
import { events_of_type } from "./adapter_b_flow.ts";
import { ALL_AGENT_SCOPES, assert_ok, call, make_agent, project_path, type Agent } from "./api_env.ts";
import { isolated_home } from "./isolated_home.ts";
import { state_signature, table_counts } from "./state_signature.ts";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SERVER_SCRIPT = join(REPO, "scripts", "pes_core", "mcp_server.ts");
export const API_BASE_URL = "http://127.0.0.1:8760";
export const GO_MODEL = "opencode-go/deepseek-v4.1-flash";

/** The fake key store in the PR19 shape: put(ref, secret) / get(ref) / delete(ref) / where(). It never touches an OS keychain. */
export class FakeKeyStore {
  readonly secrets = new Map<string, string>();
  /** every call as "name" plus the exact argument list it got, e.g. ["get", ["ref"]] */
  readonly calls: Array<[string, unknown[]]> = [];
  async put(...args: unknown[]): Promise<void> {
    this.calls.push(["put", args]);
    this.secrets.set(String(args[0]), String(args[1]));
  }
  async get(...args: unknown[]): Promise<string | null> {
    this.calls.push(["get", args]);
    return this.secrets.get(String(args[0])) ?? null;
  }
  async delete(...args: unknown[]): Promise<void> {
    this.calls.push(["delete", args]);
    this.secrets.delete(String(args[0]));
  }
  where(): string {
    this.calls.push(["where", []]);
    return "fake";
  }
}
export interface CliSpec {
  /** Test title prefix and actor slug. */
  label: string;
  runtime: "codex_cli" | "opencode_tui";
  provider: string;
  /** the adapter functions under test */
  entry(input: { command: string; server_script: string; project_id: string; api_base_url: string; model?: string }): any;
  launch_env(input: { key_store: unknown; project_id: string }): Promise<Record<string, string>>;
  /** environment variables of the entry, as the tool's config names them */
  env_of(entry: any): Record<string, string>;
  /** the adapter source (for the no-file / no-process guard) */
  source: string;
  doc: string;
  /** info string of the fenced config example in the note */
  config_info: string;
  /** parse the fenced config text; return the server entry (the pes server) as the tool would read it */
  parse_config(text: string): any;
  config_file: string;
  forbidden_home_dirs: string[];
}

export interface CliEnv extends AdapterEnv {
  cli_agent: Agent;
  spec: CliSpec;
  /** a new MCP server connection as the tool starts it: claim defaults come from the entry's env, like mcp_server.ts main() */
  cli_server(token?: string): McpServer;
  cli_client(token?: string): Promise<FakeMcpClient>;
}

export async function make_cli_env(spec: CliSpec): Promise<CliEnv> {
  const env = (await make_adapter_env()) as CliEnv;
  env.spec = spec;
  env.cli_agent = await make_agent(env, spec.label);
  const vars = spec.env_of(spec.entry({ command: process.execPath, server_script: SERVER_SCRIPT, project_id: env.p.project_id, api_base_url: API_BASE_URL }));
  env.cli_server = (token = env.cli_agent.token) =>
    new McpServer({
      api: env.app,
      project_id: env.p.project_id,
      token,
      claim_defaults: { runtime: vars.PES_RUNTIME ?? "mcp", provider: vars.PES_PROVIDER ?? "unknown", model: vars.PES_MODEL ?? "unknown" },
    });
  env.cli_client = async (token) => {
    const client = new FakeMcpClient(env.cli_server(token));
    await client.initialize();
    return client;
  };
  return env;
}

export async function with_cli(spec: CliSpec, fn: (env: CliEnv, open: <T extends FakeMcpClient>(c: T) => T) => Promise<void>): Promise<void> {
  const env = await make_cli_env(spec);
  const opened: FakeMcpClient[] = [];
  try {
    await fn(env, (c) => {
      opened.push(c);
      return c;
    });
  } finally {
    for (const c of opened) await c.close();
    env.close();
  }
}

function fenced(path: string, info: string): string[] {
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const out: string[] = [];
  const re = /^```([^\n`]*)\n([\s\S]*?)\n```[ \t]*$/gm;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if ((m[1] ?? "").trim() === info) out.push(m[2] ?? "");
  }
  return out;
}

/** every key of `expected` is present and equal in `actual` (arrays and scalars exactly). */
function assert_subset(actual: any, expected: any, where: string): void {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    assert.ok(actual !== null && typeof actual === "object" && !Array.isArray(actual), `${where} is an object`);
    for (const key of Object.keys(expected)) assert_subset(actual[key], expected[key], `${where}.${key}`);
  } else assert.deepEqual(actual, expected, where);
}

function a_run_row(env: CliEnv, run_id: string): string {
  return wire(env.db.get("SELECT * FROM runs WHERE id = ?", run_id));
}

function a_side_counts(env: CliEnv): Record<string, bigint> {
  // every table that belongs to the built-in (mode A) runner: dispatches, usage, Go gauges, connections
  const names = env.db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE '%dispatch%' OR name LIKE '%usage%' OR name LIKE 'go_%' OR name LIKE '%connection%') ORDER BY name")
    .map((r) => r.name);
  const out: Record<string, bigint> = {};
  for (const name of names) out[name] = (env.db.get<{ n: bigint }>(`SELECT COUNT(*) AS n FROM ${name}`)?.n ?? 0n) as bigint;
  return out;
}

export function define_cli_suite(spec: CliSpec): void {
  const t = (name: string, fn: () => Promise<void> | void) => test(`${spec.label}: ${name}`, fn);

  t("identity: runtime, mode B, external_agent actor; model and usage are unknown, not guessed", async () => {
    await with_cli(spec, async (env, open) => {
      const client = open(await env.cli_client());
      const claim = await client.ok("pes_claim", { idempotency_key: "id-claim" });
      const run = env.db.get<{ mode: string; runtime: string; provider: string; model: string; actor_id: string; usage_json: string | null }>(
        "SELECT mode, runtime, provider, model, actor_id, usage_json FROM runs WHERE id = ?",
        claim.run_id,
      )!;
      assert.equal(run.mode, "B");
      assert.equal(run.runtime, spec.runtime);
      assert.equal(run.provider, spec.provider);
      assert.equal(run.model, "unknown", "the tool's model is not reported to PES, so PES does not guess one");
      assert.equal(run.actor_id, env.cli_agent.actor_id);
      assert.equal(env.db.get<{ kind: string }>("SELECT kind FROM actors WHERE id = ?", run.actor_id)?.kind, "external_agent");
      // usage: nothing invented. Either no usage is stored or every figure is the literal "unknown".
      if (run.usage_json !== null) {
        assert.doesNotMatch(run.usage_json, /:\s*-?\d/, "no made-up numbers in the usage of a B run");
      }
      await client.ok("pes_complete", { status: "succeeded", idempotency_key: "id-done" });
      const events = events_of_type(env, "run.claimed");
      assert.equal(events.length, 1);
      assert.doesNotMatch(wire(events), /tokens?_(in|out)put|cost|price/i, "no usage or cost is recorded for a B run");
    });
  });

  t("one synthetic round and a resume through the MCP tools (context, claim, ask, wait, answer, claim, submit, complete)", async () => {
    await with_cli(spec, async (env, open) => {
      const client = open(await env.cli_client());
      const ctx0 = await client.ok("pes_context", {});
      assert.equal(ctx0.project_id, env.p.project_id);
      assert.equal(ctx0.lease, null);
      const claim = await client.ok("pes_claim", { idempotency_key: "r-claim" });
      assert.equal(claim.fence, "1");
      const asked = await client.ok("pes_ask", ask_args(env, "cli-round"));
      assert.equal((await client.ok("pes_wait", { idempotency_key: "r-wait" })).status, "waiting_human");
      await client.fails("pes_submit", { results: [], idempotency_key: "r-after-wait" }, "claim_required");

      const input_version_id = await owner_answers(env, asked, "a");
      env.tick();
      // the tool restarts between the question and the answer: a NEW connection resumes the SAME run
      const second = open(await env.cli_client());
      const inputs = (await second.ok("pes_context", { run_id: claim.run_id })).inputs as any[];
      assert.equal(inputs.length, 1);
      assert.equal(inputs[0].input_version_id, input_version_id);
      const read = await second.ok("pes_read", { object_id: inputs[0].object_id, version_id: input_version_id });
      assert.equal(read.content.value, "a");
      const resumed = await second.ok("pes_claim", { run_id: claim.run_id, idempotency_key: "r-resume" });
      assert.equal(resumed.run_id, claim.run_id);
      assert.equal(resumed.fence, "2", "a resume takes a new fence");
      await second.ok("pes_receipt", { receipts: [{ input_version_id, state: "seen" }], idempotency_key: "r-seen" });
      const submitted = await second.ok("pes_submit", {
        results: [{ op: "append_version", object_id: env.object_id, title: `${spec.label} 결과` }],
        idempotency_key: "r-submit",
      });
      assert.equal(typeof submitted.results[0].version_id, "string");
      await second.ok("pes_receipt", { receipts: [{ input_version_id, state: "applied", applied_by_key: "r-submit" }], idempotency_key: "r-applied" });
      assert.equal((await second.ok("pes_complete", { status: "succeeded", idempotency_key: "r-done" })).status, "succeeded");

      const run = env.db.get<{ status: string; runtime: string; mode: string }>("SELECT status, runtime, mode FROM runs WHERE id = ?", claim.run_id)!;
      assert.deepEqual({ ...run }, { status: "succeeded", runtime: spec.runtime, mode: "B" }, "one run carried the whole round, across a restart");
      assert.equal(table_counts(env.db).runs, 1n);
      assert.equal(table_counts(env.db).approvals, 0n, "complete is not approval");
      // the old connection's fence is dead after the resume
      for (const line of [...client.lines, ...second.lines]) assert.ok(!line.includes(env.cli_agent.token), "the agent token never reaches the client");
    });
  });

  t("a duplicate submit replays; the same key with another request is refused; the version count stays", async () => {
    await with_cli(spec, async (env, open) => {
      const client = open(await env.cli_client());
      await client.ok("pes_claim", { idempotency_key: "d-claim" });
      const args = { results: [{ op: "append_version", object_id: env.object_id, title: "한 번만" }], idempotency_key: "d-submit" };
      const first = await client.ok("pes_submit", args);
      const versions = table_counts(env.db).object_versions;
      const sig = state_signature(env.db);
      const again = await client.ok("pes_submit", args);
      assert.equal(again.replayed, true);
      assert.deepEqual(again.results, first.results, "the replay answers with the first versions");
      assert.equal(table_counts(env.db).object_versions, versions);
      assert.equal(state_signature(env.db), sig, "a replay writes nothing");

      const reuse = await client.fails(
        "pes_submit",
        { results: [{ op: "append_version", object_id: env.object_id, title: "다른 내용" }], idempotency_key: "d-submit" },
        "idempotency_key_reuse",
      );
      assert.equal(reuse.next_action, "use_new_key");
      await client.fails("pes_heartbeat", { progress: { phase: "stage" }, idempotency_key: "d-submit" }, "idempotency_key_reuse");
      assert.equal(state_signature(env.db), sig, "the refusals wrote nothing");

      // a second claim with the same key but another target is also the same key with another request
      await client.ok("pes_heartbeat", { progress: { phase: "started" }, idempotency_key: "d-hb" });
      await client.fails("pes_claim", { run_id: "no-such-run", idempotency_key: "d-claim" }, "idempotency_key_reuse");
    });
  });

  t("the tool list is the closed 11 of the Claude adapter: nothing to approve, reopen, set policy, mint tokens, delete or export", async () => {
    await with_cli(spec, async (env, open) => {
      const client = open(await env.cli_client());
      const listed = (await client.request("tools/list")).result.tools as Array<{ name: string }>;
      assert.deepEqual(listed.map((x) => x.name).sort(), [...TOOLS].sort());
      assert.equal(listed.length, 11);
      for (const word of ["approve", "approval", "reopen", "seal", "policy", "token", "delete", "remove", "export", "register", "backup", "key", "connection"]) {
        assert.ok(!listed.some((x) => x.name.toLowerCase().includes(word)), `no tool named like ${word}`);
      }
      for (const name of ["pes_approve", "pes_reopen", "pes_set_policy", "pes_issue_token", "pes_delete", "pes_export"]) {
        const res = await client.request("tools/call", { name, arguments: {} });
        assert.equal(res.error.code, -32602, `${name} does not exist`);
      }
      // and the agent token cannot do the human's work through the API either
      const sig = state_signature(env.db);
      for (const [method, path] of [
        ["POST", `/stages/${env.stage.plan}/approve`],
        ["POST", `/stages/${env.stage.plan}/reopen`],
        ["POST", `/rounds/${env.round_id}/seal`],
        ["POST", "/policies/opencode-go/revisions"],
        ["POST", "/agent-tokens"],
        ["POST", "/exports"],
        ["DELETE", ""],
      ] as const) {
        const res = await call(env, { method, path: project_path(env, path), auth: { token: env.cli_agent.token }, body: {} });
        assert.ok(res.status >= 400, `${method} ${path} is refused or unsupported for the agent token: ${res.status}`);
      }
      assert.equal(state_signature(env.db), sig, "nothing was written");
    });
  });

  t("the built-in runner (mode A, pes_builtin) and this tool never take each other's lease, run or dispatch", async () => {
    await with_cli(spec, async (env, open) => {
      const builtin = await make_agent(env, "pes-builtin", ALL_AGENT_SCOPES, "internal_ai");
      const claim_a = async () =>
        call(env, {
          method: "POST",
          path: project_path(env, "/claims"),
          auth: { token: builtin.token },
          body: { mode: "A", runtime: "pes_builtin", provider: "opencode-go", model: GO_MODEL },
        });
      const client = open(await env.cli_client());

      // 1. A holds the lease: the B claim is refused as a conflict and touches neither A's run, lease nor side tables
      const a = assert_ok(await claim_a());
      const a_run = a_run_row(env, a.run_id);
      const a_side = a_side_counts(env);
      const before = state_signature(env.db);
      const refused = await client.fails("pes_claim", { idempotency_key: "x-claim-1" }, "conflict");
      assert.equal(typeof refused.next_action, "string");
      assert.equal(state_signature(env.db), before, "a refused B claim writes nothing");
      assert.equal(a_run_row(env, a.run_id), a_run);

      // 2. the A run finishes; now B holds the lease and a new A start is the one refused
      assert_ok(
        await call(env, {
          method: "POST",
          path: project_path(env, `/runs/${a.run_id}/complete`),
          auth: { token: builtin.token },
          body: { lease_id: a.lease_id, fence: a.fence, status: "succeeded" },
        }),
      );
      const done_a = a_run_row(env, a.run_id);
      const b = await client.ok("pes_claim", { idempotency_key: "x-claim-2" });
      assert.notEqual(b.run_id, a.run_id);
      const b_run = a_run_row(env, b.run_id);
      const b_lease = wire(env.db.all("SELECT * FROM project_leases"));
      const mid = state_signature(env.db);
      const refused_a = await claim_a();
      assert.equal(refused_a.status, 409, `A start while B holds the lease: ${wire(refused_a.json)}`);
      assert.equal(refused_a.json.error.code, "conflict");
      assert.equal(state_signature(env.db), mid, "a refused A start writes nothing");
      assert.equal(a_run_row(env, b.run_id), b_run, "B's run is untouched");
      assert.equal(wire(env.db.all("SELECT * FROM project_leases")), b_lease);
      assert.equal(a_run_row(env, a.run_id), done_a, "A's finished run is untouched");

      // 3. a whole B round never writes the A-only tables (dispatches, usage, Go gauges, connections)
      await client.ok("pes_submit", { results: [{ op: "append_version", object_id: env.object_id, title: "B 결과" }], idempotency_key: "x-submit" });
      await client.ok("pes_complete", { status: "succeeded", idempotency_key: "x-done" });
      assert.deepEqual(a_side_counts(env), a_side, "the B round did not touch the built-in runner's tables");
      assert.equal(env.db.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM runs WHERE mode = 'A'")?.n, 1n);
      assert.equal(a_run_row(env, a.run_id), done_a);
    });
  });

  t("a B connection never claims on the Go route: the run provider/model are not opencode-go", async () => {
    await with_cli(spec, async (env, open) => {
      const client = open(await env.cli_client());
      const claim = await client.ok("pes_claim", { idempotency_key: "go-claim" });
      const run = env.db.get<{ provider: string; model: string; mode: string }>("SELECT provider, model, mode FROM runs WHERE id = ?", claim.run_id)!;
      assert.equal(run.mode, "B");
      assert.notEqual(run.provider, "opencode-go");
      assert.ok(!run.model.startsWith("opencode-go/"));
      // no tool argument turns a B claim into an A (Go) claim
      await client.tool("pes_complete", { status: "succeeded", idempotency_key: "go-done" });
      const sneaky = await client.tool("pes_claim", { mode: "A", provider: "opencode-go", model: GO_MODEL, idempotency_key: "go-claim-2" });
      const rows = env.db.all<{ mode: string }>("SELECT mode FROM runs");
      assert.ok(rows.every((r) => r.mode === "B"), `a B connection never creates an A run (${wire(sneaky.data)})`);
    });
  });

  t(`${spec.doc}: the config example, written into a temporary directory, parses and points at this repository's MCP server`, async () => {
    const home = isolated_home("pes-sel54-cfg-");
    try {
      const doc = join(REPO, "docs", "adapters", spec.doc);
      assert.ok(existsSync(doc), `${spec.doc} exists`);
      const blocks = fenced(doc, spec.config_info);
      assert.equal(blocks.length, 1, `${spec.doc} carries exactly one \`${spec.config_info}\` example`);
      const project_id = "synthetic-project-id";
      const filled = blocks[0]!
        .replace('"/path/to/node"', JSON.stringify(process.execPath))
        .replace('"/path/to/pes/scripts/pes_core/mcp_server.ts"', JSON.stringify(SERVER_SCRIPT))
        .replace("<프로젝트 id>", project_id);
      assert.ok(!filled.includes("/path/to/"), "every placeholder path is one the note names and the reader replaces");
      assert.ok(!filled.includes("<프로젝트 id>"));

      // the temporary tool config directory lives under the isolated HOME, never under the real one
      const dir = join(home.root, "tool-config");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, spec.config_file);
      writeFileSync(file, filled, "utf8");
      const parsed = spec.parse_config(readFileSync(file, "utf8"));

      const wanted = spec.entry({ command: process.execPath, server_script: SERVER_SCRIPT, project_id, api_base_url: API_BASE_URL });
      assert_subset(parsed, wanted, "pes server entry");
      // the command path is real: the node executable and this repository's server script exist
      const command = Array.isArray(parsed.command) ? parsed.command : [parsed.command, ...(parsed.args ?? [])];
      assert.equal(realpathSync.native(command[0]), realpathSync.native(process.execPath));
      assert.ok(existsSync(command[1]), "the server script named by the note exists");
      assert.match(command[1], /mcp_server\.ts$/);
      assert.equal(command.length, 2, "node and one script, nothing else");
      // no secret, no real path of a person, nothing but a reference to the token
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /Bearer|sk-[A-Za-z0-9]|session/i);
      for (const m of text.matchAll(/PES_AGENT_TOKEN"?\s*[:=]\s*"([^"]*)"/g)) {
        assert.match(m[1] ?? "", /^(\$\{PES_AGENT_TOKEN\}|\{env:PES_AGENT_TOKEN\})$/, "the token is only ever a reference");
      }
      assert.doesNotMatch(blocks[0]!, /\/Users\/|\\Users\\|C:\\|\/home\//, "the note names no one's absolute path");
      for (const dir_name of spec.forbidden_home_dirs) assert.ok(!existsSync(join(home.env.HOME!, dir_name)), `${dir_name} was not created in the isolated HOME`);
    } finally {
      home.cleanup();
    }
  });

  t(`${spec.doc}: states what is unverified and carries no claim of an unrun real session`, () => {
    const text = readFileSync(join(REPO, "docs", "adapters", spec.doc), "utf8").replace(/\r\n/g, "\n");
    assert.match(text, /미확인/, "the real tool session is stated as unverified");
    assert.match(text, /PES_AGENT_TOKEN/, "the note says how the token reaches the server");
    assert.match(text, /adapter-contract\.md/, "the note links the common contract");
    assert.match(text, /pes_context/, "the note names the first tool of the flow");
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]{8,}/);
    assert.doesNotMatch(text, /\/Users\/|\/home\/[a-z]/, "no personal absolute path in a public note");
  });

  t(`${spec.doc}: every pes-example block runs as written on this tool's connection`, async () => {
    const blocks = fenced(join(REPO, "docs", "adapters", spec.doc), "json pes-example");
    assert.ok(blocks.length >= 1, "the note carries a runnable example");
    for (const text of blocks) {
      const example = JSON.parse(text) as { name: string; steps: Array<{ tool: string; arguments?: Record<string, unknown>; expect: string }> };
      await with_cli(spec, async (env, open) => {
        const client = open(await env.cli_client());
        const fill = (value: unknown): unknown =>
          JSON.parse(JSON.stringify(value).replaceAll("${object_id}", env.object_id).replaceAll("${stage_plan}", env.stage.plan).replaceAll("${round_id}", env.round_id));
        for (const step of example.steps) {
          const args = fill(step.arguments ?? {}) as Record<string, unknown>;
          if (step.expect === "ok") await client.ok(step.tool, args);
          else await client.fails(step.tool, args, step.expect);
        }
        assert.equal(env.db.get<{ runtime: string }>("SELECT runtime FROM runs LIMIT 1")?.runtime ?? spec.runtime, spec.runtime);
      });
    }
  });

  t("the token comes from the key store only at launch, and is written nowhere", async () => {
    const token = "synthetic-token-not-real-0123456789";
    const project_id = "synthetic-project-id";
    const ref = `pes-agent-token-${spec.runtime}-${project_id}`;
    const store = new FakeKeyStore();
    await store.put(ref, token);
    const other = new FakeKeyStore();
    await other.put(`pes-agent-token-${spec.runtime === "codex_cli" ? "opencode_tui" : "codex_cli"}-${project_id}`, "other-tool-token");
    store.calls.length = 0;
    other.calls.length = 0;

    const out = await spec.launch_env({ key_store: store, project_id });
    assert.equal(out.PES_AGENT_TOKEN, token, "the launch environment carries the token for the process, in memory");
    assert.deepEqual(store.calls, [["get", [ref]]], "one read, get(ref) with the single argument; no put, no delete");
    const entry = spec.entry({ command: process.execPath, server_script: SERVER_SCRIPT, project_id, api_base_url: API_BASE_URL });
    assert.ok(!wire(entry).includes(token), "the connection entry never holds the token value");

    // the other tool's token is not this tool's: a missing ref is refused and nothing is written
    try {
      await spec.launch_env({ key_store: other, project_id });
      assert.fail("a missing token must be refused");
    } catch (error: any) {
      assert.equal(error.code, "token_missing");
      assert.match(String(error.message), /[가-힣]/, "the message is Korean");
      assert.ok(!String(error.message).includes("other-tool-token"));
    }
    assert.deepEqual(other.calls, [["get", [ref]]]);
  });

  t("the adapter source reads and writes no file, starts no process and names no tool config directory", () => {
    const code = readFileSync(join(REPO, "scripts", "pes_core", "adapters", spec.source), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    assert.doesNotMatch(code, /node:fs|node:child_process|node:os|writeFile|readFile|homedir|execFile|spawn\(|exec\(/);
    assert.doesNotMatch(code, /\.codex|\.config\/opencode|\.config[\\/]+opencode|APPDATA/);
    assert.doesNotMatch(code, /codex exec|opencode run/);
  });
}


/**
 * SEL-54 PR20b 보강 — Codex CLI adapter under forged input, a race between the tools and the built-in runner,
 * and strict reading of the note's config. 해석 28~33 are in tests/helpers/adapter_b_cli_harden.ts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { codex_cli_launch_env, codex_cli_mcp_entry } from "../scripts/pes_core/adapters/codex_cli.ts";
import { opencode_tui_mcp_entry } from "../scripts/pes_core/adapters/opencode_tui.ts";
import { GO_MODEL, SERVER_SCRIPT } from "./helpers/adapter_b_cli_suite.ts";
import { define_cli_harden } from "./helpers/adapter_b_cli_harden.ts";
import { FakeMcpClient, make_adapter_env, wire } from "./helpers/adapter_b_env.ts";
import { ALL_AGENT_SCOPES, assert_ok, call, make_agent, project_path } from "./helpers/api_env.ts";
import { parse_toml } from "./helpers/mini_toml.ts";
import { McpServer } from "../scripts/pes_core/mcp_server.ts";
import { state_signature } from "./helpers/state_signature.ts";

define_cli_harden({
  label: "codex",
  runtime: "codex_cli",
  provider: "openai",
  entry: (input) => codex_cli_mcp_entry(input),
  launch_env: (input) => codex_cli_launch_env(input as any),
  env_of: (entry) => entry.env,
  source: "codex_cli.ts",
  doc: "codex.md",
  config_info: "toml pes-config",
  config_file: "config.toml",
  parse_config: (text) => {
    const servers = (parse_toml(text) as any).mcp_servers;
    assert.deepEqual(Object.keys(servers), ["pes"]);
    return servers.pes;
  },
  forbidden_home_dirs: [".codex"],
});

test("race: Codex CLI, OpenCode TUI and the built-in runner claim at once — exactly one holds the project, nobody else leaves a run", async () => {
  const env = await make_adapter_env();
  const opened: FakeMcpClient[] = [];
  try {
    const codex = await make_agent(env, "race-codex");
    const opencode = await make_agent(env, "race-opencode");
    const builtin = await make_agent(env, "race-builtin", ALL_AGENT_SCOPES, "internal_ai");
    const mk = (token: string, runtime: string, provider: string) => {
      const c = new FakeMcpClient(new McpServer({ api: env.app, project_id: env.p.project_id, token, claim_defaults: { runtime, provider, model: "unknown" } }));
      opened.push(c);
      return c;
    };
    const cx = mk(codex.token, "codex_cli", "openai");
    const oc = mk(opencode.token, "opencode_tui", "unknown");
    await cx.initialize();
    await oc.initialize();
    const claim_a = () =>
      call(env, {
        method: "POST",
        path: project_path(env, "/claims"),
        auth: { token: builtin.token },
        body: { mode: "A", runtime: "pes_builtin", provider: "opencode-go", model: GO_MODEL },
      });

    for (let round = 0; round < 6; round += 1) {
      const attempts: Array<Promise<{ who: string; ok: boolean; code?: string; run_id?: string; lease_id?: string; fence?: string }>> = [
        cx.tool("pes_claim", { idempotency_key: `rc-${round}` }).then((r) => ({ who: "codex", ok: !r.is_error, code: r.data.error?.code, ...r.data })),
        oc.tool("pes_claim", { idempotency_key: `ro-${round}` }).then((r) => ({ who: "opencode", ok: !r.is_error, code: r.data.error?.code, ...r.data })),
        claim_a().then((r) => ({ who: "builtin", ok: r.status === 200 || r.status === 201, code: r.json?.error?.code, ...(r.json?.data ?? {}) })),
      ];
      // rotate who is asked first by delaying nothing: the in-memory API serialises, the order differs by round
      if (round % 2 === 1) attempts.reverse();
      const results = await Promise.all(attempts);
      const winners = results.filter((r) => r.ok);
      assert.equal(winners.length, 1, `round ${round}: one winner, got ${wire(results)}`);
      for (const loser of results.filter((r) => !r.ok)) assert.equal(loser.code, "conflict", `round ${round}: ${loser.who}`);
      assert.equal(env.db.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM project_leases WHERE state = 'active'")?.n, 1n);
      assert.equal(env.db.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'")?.n, 1n, "one running run");
      // the winner lets go; the next round starts from an empty lease table
      const w = winners[0]!;
      const sig_before = state_signature(env.db);
      void sig_before;
      if (w.who === "codex") assert_ok_tool(await cx.tool("pes_complete", { status: "succeeded", idempotency_key: `rcd-${round}` }));
      else if (w.who === "opencode") assert_ok_tool(await oc.tool("pes_complete", { status: "succeeded", idempotency_key: `rod-${round}` }));
      else
        assert_ok(
          await call(env, {
            method: "POST",
            path: project_path(env, `/runs/${w.run_id}/complete`),
            auth: { token: builtin.token },
            body: { lease_id: w.lease_id, fence: w.fence, status: "succeeded" },
          }),
        );
      assert.equal(env.db.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM project_leases WHERE state = 'active'")?.n, 0n, `round ${round}: lease released`);
    }
    // every run row says who it is, and the three never share a label
    const rows = env.db.all<{ mode: string; runtime: string; provider: string }>("SELECT mode, runtime, provider FROM runs");
    assert.equal(rows.length, 6, "failed claims left no run behind");
    for (const row of rows) {
      const ok =
        (row.runtime === "codex_cli" && row.mode === "B" && row.provider === "openai") ||
        (row.runtime === "opencode_tui" && row.mode === "B" && row.provider === "unknown") ||
        (row.runtime === "pes_builtin" && row.mode === "A" && row.provider === "opencode-go");
      assert.ok(ok, wire(row));
    }
  } finally {
    for (const c of opened) await c.close();
    env.close();
  }
});

function assert_ok_tool(out: { is_error: boolean; data: any }): void {
  assert.equal(out.is_error, false, wire(out.data));
}

test("the two adapters give one project two different tools two different labels from the same inputs", () => {
  const input = { command: process.execPath, server_script: SERVER_SCRIPT, project_id: "p", api_base_url: "http://127.0.0.1:8760" };
  const c = codex_cli_mcp_entry(input);
  const o = opencode_tui_mcp_entry(input);
  assert.notEqual(c.env.PES_RUNTIME, o.environment.PES_RUNTIME);
  assert.equal(c.env.PES_RUNTIME, "codex_cli");
  assert.equal(o.environment.PES_RUNTIME, "opencode_tui");
});

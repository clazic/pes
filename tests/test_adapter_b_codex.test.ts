/**
 * SEL-54 PR20b — Codex CLI as a method-B client of the 20a MCP server (tester, 작성 모드).
 * Source: Linear SEL-54 / docs/plan/issues/stage-2-linear.md "PR20b", the 20a contract
 * (docs/adapters/adapter-contract.md, claude-code.md), docs/plan/stage-2-db-guarantees.md 8.17 (8.18 is this
 * PR), decision 0012 (Codex CLI / OpenCode TUI in stage 2) and 0019 (the built-in runner and its AI
 * connections are off limits). The fake MCP client of 20a drives the real McpServer; no codex process runs,
 * and nothing under ~/.codex is read or written.
 *
 * 해석 (numbered on from the 20a tests, which end at 해석 20; each is pinned by a test below or in
 * tests/helpers/adapter_b_cli_suite.ts):
 *  해석 21 `scripts/pes_core/adapters/codex_cli.ts` exports `codex_cli_mcp_entry({command, server_script,
 *          project_id, api_base_url, model?})` → {command, args:[server_script], env:{PES_PROJECT_ID,
 *          PES_API_BASE_URL, PES_RUNTIME:"codex_cli", PES_PROVIDER:"openai", PES_MODEL}, env_vars:
 *          ["PES_AGENT_TOKEN"]}: the `[mcp_servers.pes]` table of Codex's config.toml. The token is forwarded
 *          BY NAME (`env_vars`, Codex's list of variables to pass on), never put in `env`. PES_MODEL is the
 *          given model, else "unknown". The module reads and writes no file and starts no process.
 *  해석 22 The provider of a Codex CLI run is "openai" (the tool's vendor); the model of the run is "unknown"
 *          unless the entry was given one (the tool does not tell PES what it runs). The OpenCode TUI provider
 *          is "unknown" (OpenCode is multi-provider). Usage: a B run stores no figures.
 *  해석 23 The token reaches the server process only at launch: `codex_cli_launch_env({key_store, project_id})`
 *          reads it from the PR19 key-store interface (`get(service, account)`, account = project_id; the
 *          service name is the adapter's choice) and returns {PES_AGENT_TOKEN} in memory. It only reads (no
 *          set/delete). A missing token is an error with code `token_missing` and a Korean message.
 *  해석 24 Interference with the built-in runner (decision 0019): a mode-A claim (runtime `pes_builtin`,
 *          provider `opencode-go`) and a B claim share the one project lease. Whoever holds it, the other's
 *          claim is `conflict` and writes nothing; neither run row, nor the lease, nor any dispatch / usage / Go
 *          / connection table of the A side is changed by a B round. A B connection can never create a mode-A
 *          run.
 *  해석 25 The note docs/adapters/codex.md carries ONE fenced ```toml pes-config``` block (the config.toml
 *          example) with the placeholders "/path/to/node", "/path/to/pes/scripts/pes_core/mcp_server.ts" and
 *          <프로젝트 id>, a `json pes-example` flow block, a 「미확인」 statement for the real Codex session, the
 *          PES_AGENT_TOKEN hand-over, and a link to adapter-contract.md. The block, with placeholders filled
 *          in and written to a temporary directory, parses (TOML subset of tests/helpers/mini_toml.ts) and its
 *          [mcp_servers.pes] equals the entry function's output for the same inputs (extra keys allowed).
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { codex_cli_launch_env, codex_cli_mcp_entry } from "../scripts/pes_core/adapters/codex_cli.ts";
import { API_BASE_URL, define_cli_suite, SERVER_SCRIPT } from "./helpers/adapter_b_cli_suite.ts";
import { wire } from "./helpers/adapter_b_env.ts";
import { parse_toml } from "./helpers/mini_toml.ts";

define_cli_suite({
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
    assert.ok(servers && typeof servers === "object", "the example has an [mcp_servers] table");
    assert.deepEqual(Object.keys(servers), ["pes"], "one server, named pes");
    return servers.pes;
  },
  forbidden_home_dirs: [".codex"],
});

test("codex: the config entry forwards the token by name and names the tool; it writes no file", () => {
  const entry = codex_cli_mcp_entry({
    command: process.execPath,
    server_script: join(SERVER_SCRIPT),
    project_id: "synthetic-project-id",
    api_base_url: API_BASE_URL,
  });
  assert.equal(entry.command, process.execPath, "the node path is given, never looked up with which");
  assert.deepEqual(entry.args, [SERVER_SCRIPT]);
  assert.deepEqual(Object.keys(entry.env).sort(), ["PES_API_BASE_URL", "PES_MODEL", "PES_PROJECT_ID", "PES_PROVIDER", "PES_RUNTIME"]);
  assert.equal(entry.env.PES_RUNTIME, "codex_cli");
  assert.equal(entry.env.PES_PROVIDER, "openai");
  assert.equal(entry.env.PES_MODEL, "unknown", "the model is unknown unless the caller knows it");
  assert.equal(entry.env.PES_PROJECT_ID, "synthetic-project-id");
  assert.equal(entry.env.PES_API_BASE_URL, API_BASE_URL);
  assert.deepEqual(entry.env_vars, ["PES_AGENT_TOKEN"], "by name: Codex passes the variable on from the user's environment");
  assert.ok(!("PES_AGENT_TOKEN" in entry.env), "never a token value in env");
  assert.doesNotMatch(wire(entry), /Bearer|session/i);

  const known = codex_cli_mcp_entry({ command: "n", server_script: "s", project_id: "p", api_base_url: API_BASE_URL, model: "synthetic-model" });
  assert.equal(known.env.PES_MODEL, "synthetic-model");
});

test("codex: the entry refuses a missing field, and a non-loopback base URL (the token must not leave this computer)", () => {
  const ok = { command: process.execPath, server_script: SERVER_SCRIPT, project_id: "p", api_base_url: API_BASE_URL };
  for (const field of ["command", "server_script", "project_id", "api_base_url"] as const) {
    for (const bad of ["", undefined, 3] as const) {
      assert.throws(() => codex_cli_mcp_entry({ ...ok, [field]: bad } as any), TypeError, `${field}=${String(bad)}`);
    }
  }
  for (const url of ["https://example.com", "http://192.0.2.1:8760", "http://example.com:8760", "ftp://127.0.0.1"]) {
    assert.throws(() => codex_cli_mcp_entry({ ...ok, api_base_url: url }), /./, url);
  }
});

test("codex: the TOML reader of the tests rejects what it cannot read (a guard for the doc example)", () => {
  assert.deepEqual(parse_toml('[mcp_servers.pes]\ncommand = "n" # c\nargs = ["a", "b"]\nenv = { K = "v" }\nenv_vars = ["T"]\n'), {
    mcp_servers: { pes: { command: "n", args: ["a", "b"], env: { K: "v" }, env_vars: ["T"] } },
  });
  assert.throws(() => parse_toml("[[mcp_servers]]\n"));
  assert.throws(() => parse_toml('key = "unterminated\n'));
});

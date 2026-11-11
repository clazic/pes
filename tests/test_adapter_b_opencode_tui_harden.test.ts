/**
 * SEL-54 PR20b 보강 — OpenCode TUI adapter: Go-route bypass attempts and config-expansion injection.
 * 해석 28~33 are in tests/helpers/adapter_b_cli_harden.ts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { opencode_tui_launch_env, opencode_tui_mcp_entry } from "../scripts/pes_core/adapters/opencode_tui.ts";
import { API_BASE_URL, SERVER_SCRIPT } from "./helpers/adapter_b_cli_suite.ts";
import { define_cli_harden } from "./helpers/adapter_b_cli_harden.ts";

define_cli_harden({
  label: "opencode-tui",
  runtime: "opencode_tui",
  provider: "unknown",
  entry: (input) => opencode_tui_mcp_entry(input),
  launch_env: (input) => opencode_tui_launch_env(input as any),
  env_of: (entry) => entry.environment,
  source: "opencode_tui.ts",
  doc: "opencode-tui.md",
  config_info: "json pes-config",
  config_file: "opencode.json",
  parse_config: (text) => {
    const parsed = JSON.parse(text);
    assert.ok(parsed.mcp && typeof parsed.mcp === "object", "the example has an mcp object");
    // current OpenCode form: mcp.servers.<name> (not the old mcp.<name>)
    assert.deepEqual(Object.keys(parsed.mcp), ["servers"], "server names live under mcp.servers, nothing else under mcp");
    assert.deepEqual(Object.keys(parsed.mcp.servers), ["pes"], "one server, named pes");
    const server = parsed.mcp.servers.pes;
    assert.ok(!("enabled" in server), "the old `enabled` key is not used; OpenCode's switch is `disabled`");
    assert.ok(server.disabled === undefined || server.disabled === false, "the server is not disabled");
    return server;
  },
  forbidden_home_dirs: [".config", ".local", ".opencode"],
});

const BASE = { command: process.execPath, server_script: SERVER_SCRIPT, project_id: "synthetic-project-id", api_base_url: API_BASE_URL };

test("opencode-tui harden: Go-route model labels cannot be disguised (해석 31)", () => {
  const disguised = [
    "opencode-go/x",
    "OpenCode-Go/x",
    "OPENCODE-GO/deepseek-v4.1-flash",
    " opencode-go/x",
    "opencode-go ",
    "opencode-go",
    "opencode-go /x",
    "opencode go/x",
    "opencode_go/x",
    "opencode\u2010go/x", // U+2010 hyphen
    "opencode\u2011go/x", // non-breaking hyphen
    "opencode\u2212go/x", // minus sign
    "opencode-go\u200b/x", // zero width space
    "opencode\u200b-go/x",
    "opencode\u00ad-go/x", // soft hyphen
    "opencode-go\ufeff/x", // BOM
    "ｏｐｅｎｃｏｄｅ-ｇｏ/x", // fullwidth
    "opencode-go\n/x",
    "opencode-go\t/x",
    "\u202eopencode-go/x", // right-to-left override
  ];
  for (const model of disguised) {
    assert.throws(
      () => opencode_tui_mcp_entry({ ...BASE, model }),
      (error: any) => (error as { code?: string }).code === "go_route_blocked" || error instanceof TypeError,
      JSON.stringify(model),
    );
  }
  // the folded Go forms must be the Go error itself (not just any refusal) for the printable ones
  for (const model of ["opencode_go/x", "opencode go/x", "opencode\u2010go/x", "ｏｐｅｎｃｏｄｅ-ｇｏ/x"]) {
    assert.throws(() => opencode_tui_mcp_entry({ ...BASE, model }), (error: any) => error.code === "go_route_blocked", JSON.stringify(model));
  }
  // models that merely contain the letters elsewhere are labels of other providers
  for (const model of ["opencode/big-pickle", "anthropic/claude-sonnet-5-5", "openai/gpt-5", "my-opencode-gold/x", "go/x", "unknown"]) {
    assert.equal(opencode_tui_mcp_entry({ ...BASE, model }).environment.PES_MODEL, model);
  }
  // the Go refusal is a Korean message that names the way out and never echoes a secret
  try {
    opencode_tui_mcp_entry({ ...BASE, model: "opencode-go/x" });
    assert.fail("must throw");
  } catch (error: any) {
    assert.match(String(error.message), /방식 A|내장 실행기/);
  }
});

test("opencode-tui harden: {env:...} / {file:...} in any field is refused, because OpenCode expands them in the whole config (해석 32)", () => {
  const injections = ["{env:PES_AGENT_TOKEN}", "x{env:HOME}y", "{file:~/.ssh/id_ed25519}", "{file:/etc/hosts}", "a{file:b}"];
  for (const field of ["command", "server_script", "project_id", "model"] as const) {
    for (const value of injections) {
      assert.throws(() => opencode_tui_mcp_entry({ ...BASE, [field]: value }), /./, `${field}=${value}`);
    }
  }
  // the one allowed reference is the adapter's own fixed token reference, and it appears once
  const text = JSON.stringify(opencode_tui_mcp_entry(BASE));
  assert.equal(text.split("{env:").length - 1, 1);
  assert.equal(text.includes("{file:"), false);
  // plain braces that are not a reference stay data
  assert.equal(opencode_tui_mcp_entry({ ...BASE, model: "weird{name}" }).environment.PES_MODEL, "weird{name}");
});

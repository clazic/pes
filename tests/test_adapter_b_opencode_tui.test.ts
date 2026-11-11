/**
 * SEL-54 PR20b — OpenCode TUI (the screen a person starts themselves) as a method-B client (tester, 작성 모드).
 * Same suite as the Codex CLI (tests/helpers/adapter_b_cli_suite.ts; 해석 21~25 are in
 * tests/test_adapter_b_codex.test.ts) plus what is special to OpenCode:
 *
 *  해석 26 `scripts/pes_core/adapters/opencode_tui.ts` exports `opencode_tui_mcp_entry({command, server_script,
 *          project_id, api_base_url, model?})` → {type:"local", command:[command, server_script], environment:
 *          {PES_PROJECT_ID, PES_API_BASE_URL, PES_RUNTIME:"opencode_tui", PES_PROVIDER:"unknown", PES_MODEL,
 *          PES_AGENT_TOKEN:"{env:PES_AGENT_TOKEN}"}} (no `enabled`; `disabled` absent or false): the `mcp.servers.pes` entry of opencode.json (current OpenCode form, docs opencode.ai/docs/mcp-servers).
 *          OpenCode expands `{env:VAR}`, so the token is a reference, never a value. Reads/writes no file.
 *  해석 27 OpenCode TUI is NOT the built-in runner and not the Go route: the entry refuses a model or provider on
 *          the Go route (`opencode-go/...`, error code `go_route_blocked`, Korean message) — PES cannot see or
 *          cap what a person's TUI spends, and the Go subscription meter belongs to mode A only. The note
 *          docs/adapters/opencode-tui.md says so in a 「Go」 limits section (차단/한계), says OpenCode TUI is not the
 *          A 내장 실행기, and carries ONE ```json pes-config``` block: {"mcp": {"servers": {"pes": {...}}}} with the same
 *          placeholders as the Codex note.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { opencode_tui_launch_env, opencode_tui_mcp_entry } from "../scripts/pes_core/adapters/opencode_tui.ts";
import { API_BASE_URL, define_cli_suite, GO_MODEL, REPO, SERVER_SCRIPT } from "./helpers/adapter_b_cli_suite.ts";
import { wire } from "./helpers/adapter_b_env.ts";

define_cli_suite({
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

test("opencode-tui: the config entry is a local server with the token as a {env:VAR} reference", () => {
  const entry = opencode_tui_mcp_entry({
    command: process.execPath,
    server_script: SERVER_SCRIPT,
    project_id: "synthetic-project-id",
    api_base_url: API_BASE_URL,
  });
  assert.equal(entry.type, "local");
  assert.deepEqual(entry.command, [process.execPath, SERVER_SCRIPT], "the node path is given, never looked up with which");
  assert.ok(!("enabled" in entry), "no `enabled` key: current OpenCode uses `disabled` (default false)");
  assert.ok(!("disabled" in entry) || entry.disabled === false, "the server is on");
  assert.deepEqual(Object.keys(entry.environment).sort(), ["PES_AGENT_TOKEN", "PES_API_BASE_URL", "PES_MODEL", "PES_PROJECT_ID", "PES_PROVIDER", "PES_RUNTIME"]);
  assert.equal(entry.environment.PES_RUNTIME, "opencode_tui");
  assert.equal(entry.environment.PES_PROVIDER, "unknown");
  assert.equal(entry.environment.PES_MODEL, "unknown");
  assert.equal(entry.environment.PES_AGENT_TOKEN, "{env:PES_AGENT_TOKEN}", "by reference, not by value");
  assert.doesNotMatch(wire(entry), /Bearer|session|opencode-go/i);
  assert.equal(opencode_tui_mcp_entry({ command: "n", server_script: "s", project_id: "p", api_base_url: API_BASE_URL, model: "synthetic-model" }).environment.PES_MODEL, "synthetic-model");
});

test("opencode-tui: the Go route is refused in the B entry; a normal model passes", () => {
  const ok = { command: process.execPath, server_script: SERVER_SCRIPT, project_id: "p", api_base_url: API_BASE_URL };
  for (const model of [GO_MODEL, "opencode-go/other", "OPENCODE-GO/x"]) {
    assert.throws(
      () => opencode_tui_mcp_entry({ ...ok, model }),
      (error: any) => {
        assert.equal(error.code, "go_route_blocked", model);
        assert.match(String(error.message), /[가-힣]/);
        return true;
      },
      model,
    );
  }
  for (const model of ["anthropic/synthetic-model", "synthetic-model", "unknown"]) {
    assert.equal(opencode_tui_mcp_entry({ ...ok, model }).environment.PES_MODEL, model);
  }
});

test("opencode-tui: the entry refuses a missing field and a non-loopback base URL", () => {
  const ok = { command: process.execPath, server_script: SERVER_SCRIPT, project_id: "p", api_base_url: API_BASE_URL };
  for (const field of ["command", "server_script", "project_id", "api_base_url"] as const) {
    for (const bad of ["", undefined, 3] as const) {
      assert.throws(() => opencode_tui_mcp_entry({ ...ok, [field]: bad } as any), TypeError, `${field}=${String(bad)}`);
    }
  }
  for (const url of ["https://example.com", "http://192.0.2.1:8760", "http://example.com:8760"]) {
    assert.throws(() => opencode_tui_mcp_entry({ ...ok, api_base_url: url }), /./, url);
  }
});

test("opencode-tui: the note says the Go route is blocked / limited and that the TUI is not the built-in runner", () => {
  const text = readFileSync(join(REPO, "docs", "adapters", "opencode-tui.md"), "utf8").replace(/\r\n/g, "\n");
  assert.match(text, /Go/);
  assert.match(text, /차단|한계/, "the Go limit is stated");
  assert.match(text, /내장 실행기/, "the TUI is told apart from the built-in runner");
  assert.match(text, /방식 A|mode A/i);
  assert.match(text, /opencode\.json/);
  assert.match(text, /\{env:PES_AGENT_TOKEN\}/);
  // the old OpenCode note (docs/adapters/opencode.md, the skills-only note) keeps existing and is not the TUI note
  assert.notEqual(text.split("\n")[0], readFileSync(join(REPO, "docs", "adapters", "opencode.md"), "utf8").split("\n")[0]);
});

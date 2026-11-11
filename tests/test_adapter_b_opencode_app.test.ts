/**
 * SEL-55 PR20c — OpenCode app as a method-B client (tester, 작성 모드). Same sources and same shared suites as
 * tests/test_adapter_b_codex_app.test.ts (해석 34~37 there, read with "OpenCode" for "Codex"), plus:
 *
 *  해석 38 `scripts/pes_core/adapters/opencode_app.ts` exports `opencode_app_mcp_entry` / `opencode_app_launch_env`
 *          with the shape of opencode_tui.ts (type:"local", command:[command, server_script], environment:
 *          {PES_PROJECT_ID, PES_API_BASE_URL, PES_RUNTIME:"opencode_app", PES_PROVIDER:"unknown", PES_MODEL,
 *          PES_AGENT_TOKEN:"{env:PES_AGENT_TOKEN}"}; ref `pes-agent-token-opencode_app-<project_id>`) and the class
 *          `OpencodeAppAdapter` (hand-off run: runtime "opencode_app_handoff", provider "unknown", model "unknown").
 *  해석 39 Like the TUI (해석 27) the app is not the built-in runner and not the Go route: an entry for a model on the
 *          Go route (`opencode-go/...`) is refused with `go_route_blocked`. The note docs/adapters/opencode-app.md
 *          says the app reuses neither the profile nor the server of the A 내장 실행기 and stops none of them
 *          (Agent notes: "OpenCode 앱은 A의 프로필·서버를 재사용하거나 중단하지 않는다"), and carries ONE
 *          ```json pes-config``` block {"mcp":{"servers":{"pes":{...}}}}. Whether the app shares the MCP settings
 *          with the TUI is 미확인 (시험 결과로만).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { OpencodeAppAdapter, opencode_app_launch_env, opencode_app_mcp_entry } from "../scripts/pes_core/adapters/opencode_app.ts";
import { define_app_suite } from "./helpers/adapter_b_app_suite.ts";
import { API_BASE_URL, define_cli_suite, GO_MODEL, REPO, SERVER_SCRIPT } from "./helpers/adapter_b_cli_suite.ts";
import { wire } from "./helpers/adapter_b_env.ts";

const cli = {
  label: "opencode-app",
  runtime: "opencode_app",
  provider: "unknown",
  skip_mode_a_probe: true,
  entry: (input: any) => opencode_app_mcp_entry(input),
  launch_env: (input: any) => opencode_app_launch_env(input),
  env_of: (entry: any) => entry.environment,
  source: "opencode_app.ts",
  doc: "opencode-app.md",
  config_info: "json pes-config",
  config_file: "opencode.json",
  parse_config: (text: string) => {
    const parsed = JSON.parse(text);
    assert.ok(parsed.mcp && typeof parsed.mcp === "object", "the example has an mcp object");
    assert.deepEqual(Object.keys(parsed.mcp), ["servers"], "server names live under mcp.servers");
    assert.deepEqual(Object.keys(parsed.mcp.servers), ["pes"], "one server, named pes");
    const server = parsed.mcp.servers.pes;
    assert.ok(!("enabled" in server), "OpenCode's switch is `disabled`, not `enabled`");
    assert.ok(server.disabled === undefined || server.disabled === false, "the server is not disabled");
    return server;
  },
  forbidden_home_dirs: [".config", ".local", ".opencode", "Library", "AppData"],
} as const;

define_cli_suite(cli as any);

define_app_suite({
  label: "opencode-app",
  runtime: "opencode_app",
  handoff_runtime: "opencode_app_handoff",
  provider: "unknown",
  sibling: { runtime: "opencode_tui", provider: "unknown" },
  make_adapter: (options) => new OpencodeAppAdapter(options),
  cli: cli as any,
  module: "opencode_app",
  doc: "opencode-app.md",
});

test("opencode-app: the connection entry is a local server with the token as a {env:VAR} reference", () => {
  const entry = opencode_app_mcp_entry({ command: process.execPath, server_script: SERVER_SCRIPT, project_id: "synthetic-project-id", api_base_url: API_BASE_URL });
  assert.equal(entry.type, "local");
  assert.deepEqual(entry.command, [process.execPath, SERVER_SCRIPT]);
  assert.ok(!("enabled" in entry));
  assert.equal(entry.environment.PES_RUNTIME, "opencode_app");
  assert.equal(entry.environment.PES_PROVIDER, "unknown");
  assert.equal(entry.environment.PES_MODEL, "unknown");
  assert.equal(entry.environment.PES_AGENT_TOKEN, "{env:PES_AGENT_TOKEN}", "by reference, not by value");
  assert.doesNotMatch(wire(entry), /Bearer|session|opencode-go/i);
});

test("opencode-app: the Go route is refused in the entry; a normal model passes", () => {
  const ok = { command: process.execPath, server_script: SERVER_SCRIPT, project_id: "p", api_base_url: API_BASE_URL };
  for (const model of [GO_MODEL, "OPENCODE-GO/x"]) {
    assert.throws(
      () => opencode_app_mcp_entry({ ...ok, model }),
      (error: any) => {
        assert.equal(error.code, "go_route_blocked", model);
        assert.match(String(error.message), /[가-힣]/);
        return true;
      },
      model,
    );
  }
  assert.equal(opencode_app_mcp_entry({ ...ok, model: "anthropic/synthetic-model" }).environment.PES_MODEL, "anthropic/synthetic-model");
});

test("opencode-app: the note keeps the app apart from the built-in runner: no reuse and no stop of its profile or server", () => {
  const text = readFileSync(join(REPO, "docs", "adapters", "opencode-app.md"), "utf8").replace(/\r\n/g, "\n");
  assert.match(text, /내장 실행기/);
  assert.match(text, /방식 A|mode A/i);
  assert.match(text, /프로필/);
  const lines = text.split("\n").filter((line) => /프로필/.test(line) && /서버/.test(line));
  assert.ok(lines.length >= 1, "a sentence names both the profile and the server");
  assert.ok(lines.some((line) => /재사용하지|중단하지|재사용도 중단도|건드리지/.test(line)), "it says they are neither reused nor stopped");
  assert.match(text, /Go/);
  assert.match(text, /차단|한계/);
  assert.match(text, /\{env:PES_AGENT_TOKEN\}/);
  assert.match(text, /opencode\.json/);
});

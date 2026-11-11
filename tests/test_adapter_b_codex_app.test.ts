/**
 * SEL-55 PR20c — Codex app as a method-B client (tester, 작성 모드). Source: Linear SEL-55, docs/plan/issues/
 * stage-2-linear.md "PR20c" (Agent notes), docs/plan/stage-2-db-guarantees.md 8.17 (20a) and 8.18 (20b), decision
 * 0014 (Codex app / OpenCode app in method B). The 20a fake MCP client drives the real McpServer and the real
 * ApiApp; the explicit hand-off goes through the real import route. No Codex app or CLI runs, nothing under
 * ~/.codex is read or written, no `codex exec`.
 *
 * 해석 (numbered on from 20b, which ends at 해석 33; the shared pieces are pinned in tests/helpers/adapter_b_app_suite.ts
 * and the 20b suite tests/helpers/adapter_b_cli_suite.ts, reused here with runtime codex_app):
 *  해석 34 `scripts/pes_core/adapters/codex_app.ts` exports THE DIRECT-CONNECTION pair with the shape of codex_cli.ts:
 *          `codex_app_mcp_entry({command, server_script, project_id, api_base_url, model?})` → {command, args:
 *          [server_script], env:{PES_PROJECT_ID, PES_API_BASE_URL, PES_RUNTIME:"codex_app", PES_PROVIDER:"openai",
 *          PES_MODEL: model ?? "unknown"}, env_vars:["PES_AGENT_TOKEN"]} (the same `[mcp_servers.pes]` table; the
 *          token is named, never a value) and `codex_app_launch_env({key_store, project_id})` reading ONE ref
 *          `pes-agent-token-codex_app-<project_id>` (token_missing otherwise). Same input checks as the CLI entry.
 *  해석 35 ... and THE EXPLICIT HAND-OFF: class `CodexAppAdapter({api, project_id, owner_session})` with the methods
 *          and refusal codes of ClaudeAppAdapter (export_bundle / import_result; bundle_invalid, bundle_hash_mismatch,
 *          bundle_wrong_project, bundle_stale, duplicate_import, result_out_of_scope, attachment_*). The run an import
 *          creates is the owner's: mode B, runtime "codex_app_handoff", provider "openai", model "unknown";
 *          the receipt actor is the human owner and via = "import"; claims of the app are provenance, verified=false.
 *          A direct run is runtime "codex_app", actor kind external_agent, receipt via is not "import".
 *  해석 36 When the direct connection cannot be made (no token), the `token_missing` message names the 명시적 전달 as
 *          the way that always works; docs/adapters/codex-app.md says in one paragraph that 직접 연결 may not work and
 *          the 명시적 전달 is the 보장 경로. It carries ONE ```toml pes-config``` block and a ```json pes-example```
 *          (same placeholders as codex.md), 「미확인」 for the real app session, and for whether the app and the CLI
 *          share ~/.codex/config.toml: 미확인, recorded as a 시험 결과, every sentence about sharing denies a promise.
 *  해석 37 A hand-off import never writes the mode-A tables (dispatch, usage, Go, connection) or touches an A run;
 *          the adapter module imports nothing from a_runtime except types. The mode-A claim refusal of an
 *          external_agent is SEL-68's and is not tested here.
 */

import assert from "node:assert/strict";

import { CodexAppAdapter, codex_app_launch_env, codex_app_mcp_entry } from "../scripts/pes_core/adapters/codex_app.ts";
import { define_app_suite } from "./helpers/adapter_b_app_suite.ts";
import { define_cli_suite } from "./helpers/adapter_b_cli_suite.ts";
import { parse_toml } from "./helpers/mini_toml.ts";

const cli = {
  label: "codex-app",
  runtime: "codex_app",
  provider: "openai",
  skip_mode_a_probe: true,
  entry: (input: any) => codex_app_mcp_entry(input),
  launch_env: (input: any) => codex_app_launch_env(input),
  env_of: (entry: any) => entry.env,
  source: "codex_app.ts",
  doc: "codex-app.md",
  config_info: "toml pes-config",
  config_file: "config.toml",
  parse_config: (text: string) => {
    const servers = (parse_toml(text) as any).mcp_servers;
    assert.ok(servers && typeof servers === "object", "the example has an [mcp_servers] table");
    assert.deepEqual(Object.keys(servers), ["pes"], "one server, named pes");
    return servers.pes;
  },
  forbidden_home_dirs: [".codex", "Library", "AppData"],
} as const;

define_cli_suite(cli as any);

define_app_suite({
  label: "codex-app",
  runtime: "codex_app",
  handoff_runtime: "codex_app_handoff",
  provider: "openai",
  sibling: { runtime: "codex_cli", provider: "openai" },
  make_adapter: (options) => new CodexAppAdapter(options),
  cli: cli as any,
  module: "codex_app",
  doc: "codex-app.md",
});

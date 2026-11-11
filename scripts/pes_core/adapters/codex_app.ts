// The Codex app side of method B (stage 2 PR20c, SEL-55).
//
// Two paths, and the second one is the one that always works:
//
//   direct connection   The Codex app reaches PES through the MCP server (scripts/pes_core/mcp_server.ts), the same
//                       one Codex CLI uses (PR20b). `codex_app_mcp_entry` describes the [mcp_servers.pes] table and
//                       `codex_app_launch_env` reads the agent token. Whether the app and the CLI share one Codex
//                       configuration is not verified here (docs/adapters/codex-app.md), so nothing relies on it.
//                       The run is `runtime = codex_app`, the actor is the external_agent.
//   explicit hand-off   `CodexAppAdapter` (the 20a hand-off, unchanged): the person copies a bundle to the app and
//                       pastes its answer back. The run is the owner's own, `runtime = codex_app_handoff`, the
//                       receipt's via is `import`, the actor is the human owner.
//
// This file reads and writes no file and starts no process; the app's own settings are not looked at.

import { ClaudeAppAdapter, type ClaudeAppAdapterOptions, type HandoffApp } from "./claude_app.ts";
import { check_entry_input, read_launch_env, type CliLaunchEnvInput, type CliMcpEntryInput } from "./cli_common.ts";

export type { CliLaunchEnvInput, CliMcpEntryInput, TokenKeyStore } from "./cli_common.ts";
export type { BundleBaseVersion, HandoffBundle, ImportInput, ImportOutcome } from "./claude_app.ts";
export { HandoffError } from "./claude_app.ts";

export interface CodexAppMcpEntry {
  command: string;
  args: [string];
  env: {
    PES_PROJECT_ID: string;
    PES_API_BASE_URL: string;
    PES_RUNTIME: "codex_app";
    PES_PROVIDER: "openai";
    PES_MODEL: string;
  };
  /** Variables the app forwards from its own environment to the server. The token is only ever named here. */
  env_vars: ["PES_AGENT_TOKEN"];
}

export function codex_app_mcp_entry(input: CliMcpEntryInput): CodexAppMcpEntry {
  const { model, api_base_url } = check_entry_input(input);
  return {
    command: input.command,
    args: [input.server_script],
    env: {
      PES_PROJECT_ID: input.project_id,
      PES_API_BASE_URL: api_base_url,
      PES_RUNTIME: "codex_app",
      PES_PROVIDER: "openai",
      PES_MODEL: model,
    },
    env_vars: ["PES_AGENT_TOKEN"],
  };
}

/** {PES_AGENT_TOKEN} for the environment of the process that starts the app. Read from the key store, kept in memory. */
export function codex_app_launch_env(input: CliLaunchEnvInput): Promise<{ PES_AGENT_TOKEN: string }> {
  return read_launch_env("codex_app", input);
}

export type CodexAppAdapterOptions = ClaudeAppAdapterOptions;

/**
 * The explicit hand-off for the Codex app: export_bundle / import_result as for the Claude app. The import names
 * `app = codex_app`, so PES records the owner's run as `codex_app_handoff` (provider openai, model unknown).
 */
export class CodexAppAdapter extends ClaudeAppAdapter {
  protected override handoff_app(): HandoffApp {
    return "codex_app";
  }
}

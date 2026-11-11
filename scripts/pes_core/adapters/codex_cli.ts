// The Codex CLI side of method B (stage 2 PR20b, SEL-54).
//
// Codex CLI reaches PES through the MCP server (scripts/pes_core/mcp_server.ts), the same one Claude Code uses
// (PR20a). This file only describes the one table a person puts into Codex's MCP configuration ([mcp_servers.pes]
// of its config.toml). It reads and writes no file and starts no process: the caller decides where the entry goes.
//
// The token is passed by NAME (`env_vars`: Codex passes those variables on from the environment it was started
// in), never as a value in the configuration. Codex does not tell PES which model it runs, so the model of the run
// is "unknown" unless the caller knows it. A B run stores no usage figures.

import { check_entry_input, read_launch_env, type CliLaunchEnvInput, type CliMcpEntryInput } from "./cli_common.ts";

export type { CliLaunchEnvInput, CliMcpEntryInput, TokenKeyStore } from "./cli_common.ts";

export interface CodexCliMcpEntry {
  command: string;
  args: [string];
  env: {
    PES_PROJECT_ID: string;
    PES_API_BASE_URL: string;
    PES_RUNTIME: "codex_cli";
    PES_PROVIDER: "openai";
    PES_MODEL: string;
  };
  /** Variables Codex forwards from its own environment to the server. The token is only ever named here. */
  env_vars: ["PES_AGENT_TOKEN"];
}

export function codex_cli_mcp_entry(input: CliMcpEntryInput): CodexCliMcpEntry {
  const { model, api_base_url } = check_entry_input(input);
  return {
    command: input.command,
    args: [input.server_script],
    env: {
      PES_PROJECT_ID: input.project_id,
      PES_API_BASE_URL: api_base_url,
      PES_RUNTIME: "codex_cli",
      PES_PROVIDER: "openai",
      PES_MODEL: model,
    },
    env_vars: ["PES_AGENT_TOKEN"],
  };
}

/** {PES_AGENT_TOKEN} for the environment of the process that starts Codex. Read from the key store, kept in memory. */
export function codex_cli_launch_env(input: CliLaunchEnvInput): Promise<{ PES_AGENT_TOKEN: string }> {
  return read_launch_env("codex_cli", input);
}

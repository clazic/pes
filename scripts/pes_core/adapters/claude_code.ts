// The Claude Code side of method B (stage 2 PR20a, SEL-53).
//
// Claude Code reaches PES through the MCP server (scripts/pes_core/mcp_server.ts). This file only describes the
// one entry a user (or `pes link`) puts into Claude Code's MCP configuration. It reads and writes no file: the
// caller decides where the entry goes, and the agent token is passed by reference (Claude Code's ${VAR} expansion
// of the environment), never by value, so the token is not written into any configuration file.

export interface ClaudeCodeMcpEntryInput {
  /** Absolute path of the node executable. It is given, never looked up with `which` (Git Bash paths on Windows). */
  command: string;
  /** Absolute path of scripts/pes_core/mcp_server.ts. */
  server_script: string;
  project_id: string;
  /** The loopback address of the local PES server, e.g. http://127.0.0.1:8760 */
  api_base_url: string;
}

export interface ClaudeCodeMcpEntry {
  command: string;
  args: [string];
  env: {
    PES_PROJECT_ID: string;
    PES_API_BASE_URL: string;
    PES_AGENT_TOKEN: "${PES_AGENT_TOKEN}";
    /** The entry names who is connecting; the server itself guesses nothing (its default is mcp/unknown). */
    PES_RUNTIME: "claude_code";
    PES_PROVIDER: "anthropic";
  };
}

export function claude_code_mcp_entry(input: ClaudeCodeMcpEntryInput): ClaudeCodeMcpEntry {
  for (const field of ["command", "server_script", "project_id", "api_base_url"] as const) {
    const value = input?.[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`${field} must be a non-empty string`);
    }
  }
  return {
    command: input.command,
    args: [input.server_script],
    env: {
      PES_PROJECT_ID: input.project_id,
      PES_API_BASE_URL: input.api_base_url,
      // by reference: Claude Code expands ${PES_AGENT_TOKEN} from the user's environment when it starts the server
      PES_AGENT_TOKEN: "${PES_AGENT_TOKEN}",
      PES_RUNTIME: "claude_code",
      PES_PROVIDER: "anthropic",
    },
  };
}

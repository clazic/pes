// The OpenCode TUI side of method B (stage 2 PR20b, SEL-54).
//
// OpenCode TUI is the screen a person starts themselves. It is NOT the built-in runner (mode A): PES neither
// starts it nor sees or caps what it spends, and the Go subscription meter belongs to mode A only. So this adapter
// refuses a model on the Go route (`opencode-go/...`); a person who wants Go through PES uses mode A.
//
// Like the Codex adapter, this file only describes the `mcp.pes` entry of opencode.json. It reads and writes no
// file and starts no process. OpenCode expands `{env:VAR}` itself, so the token is a reference, never a value.
// OpenCode is multi-provider, so the provider is "unknown"; the model is "unknown" unless the caller knows it.

import { AdapterError, check_entry_input, read_launch_env, type CliLaunchEnvInput, type CliMcpEntryInput } from "./cli_common.ts";

export type { CliLaunchEnvInput, CliMcpEntryInput, TokenKeyStore } from "./cli_common.ts";

export interface OpencodeTuiMcpEntry {
  type: "local";
  command: [string, string];
  environment: {
    PES_PROJECT_ID: string;
    PES_API_BASE_URL: string;
    PES_RUNTIME: "opencode_tui";
    PES_PROVIDER: "unknown";
    PES_MODEL: string;
    PES_AGENT_TOKEN: "{env:PES_AGENT_TOKEN}";
  };
  enabled: true;
}

function on_go_route(model: string): boolean {
  const name = model.trim().toLowerCase();
  return name === "opencode-go" || name.startsWith("opencode-go/");
}

export function opencode_tui_mcp_entry(input: CliMcpEntryInput): OpencodeTuiMcpEntry {
  const model = check_entry_input(input);
  if (on_go_route(model)) {
    throw new AdapterError(
      "go_route_blocked",
      "OpenCode TUI 연결에는 Go 경로(opencode-go/…) 모델을 쓸 수 없습니다. PES는 사람이 직접 켠 화면의 사용량을 볼 수도 막을 수도 없고, Go 구독 계량은 방식 A(내장 실행기) 전용입니다.",
    );
  }
  return {
    type: "local",
    command: [input.command, input.server_script],
    environment: {
      PES_PROJECT_ID: input.project_id,
      PES_API_BASE_URL: input.api_base_url,
      PES_RUNTIME: "opencode_tui",
      PES_PROVIDER: "unknown",
      PES_MODEL: model,
      // by reference: OpenCode expands {env:PES_AGENT_TOKEN} from the environment it was started in
      PES_AGENT_TOKEN: "{env:PES_AGENT_TOKEN}",
    },
    enabled: true,
  };
}

/** {PES_AGENT_TOKEN} for the environment of the process that starts OpenCode. Read from the key store, kept in memory. */
export function opencode_tui_launch_env(input: CliLaunchEnvInput): Promise<{ PES_AGENT_TOKEN: string }> {
  return read_launch_env("opencode_tui", input);
}

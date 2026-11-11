// The OpenCode app side of method B (stage 2 PR20c, SEL-55).
//
// Like the OpenCode TUI, the app is NOT the built-in runner (mode A) and not the Go route: PES neither starts it nor
// sees or caps what it spends, it reuses neither the profile nor the server of the built-in runner and stops none
// of them. So `opencode_app_mcp_entry` refuses a model on the Go route (`opencode-go/...`).
//
// Two paths, and the second one is the one that always works:
//
//   direct connection   the `mcp.servers.pes` entry of opencode.json (same form as the TUI entry, 20b) and the agent
//                       token by reference. The run is `runtime = opencode_app`, the actor is the external_agent.
//                       Whether the app shares its MCP settings with the TUI is not verified (docs/adapters/
//                       opencode-app.md), so nothing relies on it.
//   explicit hand-off   `OpencodeAppAdapter` (the 20a hand-off): copy a bundle, talk to the app, paste the answer.
//                       The run is the owner's own, `runtime = opencode_app_handoff` (provider unknown), the
//                       receipt's via is `import`, the actor is the human owner.
//
// This file reads and writes no file and starts no process; the app's own settings are not looked at.

import { ClaudeAppAdapter, type ClaudeAppAdapterOptions } from "./claude_app.ts";
import { on_go_route } from "./opencode_tui.ts";
import { AdapterError, api_naming_app, check_entry_input, InputError, read_launch_env, type CliLaunchEnvInput, type CliMcpEntryInput } from "./cli_common.ts";

export type { CliLaunchEnvInput, CliMcpEntryInput, TokenKeyStore } from "./cli_common.ts";
export type { BundleBaseVersion, HandoffBundle, ImportInput, ImportOutcome } from "./claude_app.ts";
export { HandoffError } from "./claude_app.ts";

export interface OpencodeAppMcpEntry {
  type: "local";
  command: [string, string];
  environment: {
    PES_PROJECT_ID: string;
    PES_API_BASE_URL: string;
    PES_RUNTIME: "opencode_app";
    PES_PROVIDER: "unknown";
    PES_MODEL: string;
    PES_AGENT_TOKEN: "{env:PES_AGENT_TOKEN}";
  };
}

export function opencode_app_mcp_entry(input: CliMcpEntryInput): OpencodeAppMcpEntry {
  const { model, api_base_url } = check_entry_input(input);
  if (on_go_route(model)) {
    throw new AdapterError(
      "go_route_blocked",
      "OpenCode 앱 연결에는 Go 경로(opencode-go/…) 모델을 쓸 수 없습니다. PES는 사람이 직접 켠 앱의 사용량을 볼 수도 막을 수도 없고, Go 구독 계량은 방식 A(내장 실행기) 전용입니다.",
    );
  }
  if (/[\s\p{Cf}]/u.test(model)) {
    throw new InputError("field_invalid", "model 값에 공백이나 보이지 않는 서식 문자를 쓸 수 없습니다.");
  }
  return {
    type: "local",
    command: [input.command, input.server_script],
    environment: {
      PES_PROJECT_ID: input.project_id,
      PES_API_BASE_URL: api_base_url,
      PES_RUNTIME: "opencode_app",
      PES_PROVIDER: "unknown",
      PES_MODEL: model,
      // by reference: OpenCode expands {env:PES_AGENT_TOKEN} from the environment it was started in
      PES_AGENT_TOKEN: "{env:PES_AGENT_TOKEN}",
    },
  };
}

/** {PES_AGENT_TOKEN} for the environment of the process that starts the app. Read from the key store, kept in memory. */
export function opencode_app_launch_env(input: CliLaunchEnvInput): Promise<{ PES_AGENT_TOKEN: string }> {
  return read_launch_env("opencode_app", input);
}

export type OpencodeAppAdapterOptions = ClaudeAppAdapterOptions;

/**
 * The explicit hand-off for the OpenCode app: export_bundle / import_result as for the Claude app. The import names
 * `app = opencode_app`, so PES records the owner's run as `opencode_app_handoff` (provider unknown, model unknown).
 */
export class OpencodeAppAdapter extends ClaudeAppAdapter {
  constructor(options: OpencodeAppAdapterOptions) {
    super(
      options !== null && typeof options === "object"
        ? { ...options, api: api_naming_app(options.api, options.project_id, "opencode_app") }
        : options,
    );
  }
}

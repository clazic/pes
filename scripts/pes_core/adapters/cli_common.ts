// Shared by the two method-B terminal adapters (stage 2 PR20b, SEL-54): Codex CLI and OpenCode TUI.
//
// Neither adapter reads or writes a file, starts a process, or looks at a tool's own configuration folder. They
// only build the entry a person puts into the tool's MCP configuration, and read the agent token from the key
// store at launch. The key store type below has the same shape as the PR19 KeyStore (put/get/delete/where), kept
// here as a minimal structural type so this PR does not depend on PR19's file. The adapters only call get(ref).

export interface TokenKeyStore {
  get(ref: string): string | null | undefined | Promise<string | null | undefined>;
}

export interface CliMcpEntryInput {
  /** Absolute path of the node executable. It is given, never looked up with `which` (Git Bash paths on Windows). */
  command: string;
  /** Absolute path of scripts/pes_core/mcp_server.ts. */
  server_script: string;
  project_id: string;
  /** The loopback address of the local PES server, e.g. http://127.0.0.1:8760 */
  api_base_url: string;
  /** The model the person runs, when they know it. Otherwise "unknown": the tool does not tell PES. */
  model?: string;
}

export interface CliLaunchEnvInput {
  key_store: TokenKeyStore;
  project_id: string;
}

export type CliRuntime = "codex_cli" | "opencode_tui";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export class AdapterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
  }
}

/** Checks the four required fields and the loopback base URL; returns the model ("unknown" if not given). */
export function check_entry_input(input: CliMcpEntryInput): string {
  for (const field of ["command", "server_script", "project_id", "api_base_url"] as const) {
    const value = input?.[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`${field} must be a non-empty string`);
    }
  }
  let url: URL;
  try {
    url = new URL(input.api_base_url);
  } catch {
    throw new TypeError("api_base_url must be a URL such as http://127.0.0.1:8760");
  }
  // the agent token is sent to this address, so it must be this computer
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new TypeError("api_base_url must be a loopback http address (127.0.0.1): the token must not leave this computer");
  }
  const model = input.model;
  if (model === undefined) return "unknown";
  if (typeof model !== "string" || model.length === 0) {
    throw new TypeError("model must be a non-empty string when given");
  }
  return model;
}

/** The key-store name of the agent token of one tool in one project. */
export function token_ref(runtime: CliRuntime, project_id: string): string {
  return `pes-agent-token-${runtime}-${project_id}`;
}

/**
 * Reads the agent token for the process the tool is about to start. It is held in memory only: the caller puts it
 * into the environment of the launch and writes it nowhere. The key store is only read, once, with one argument.
 */
export async function read_launch_env(runtime: CliRuntime, input: CliLaunchEnvInput): Promise<{ PES_AGENT_TOKEN: string }> {
  const project_id = input?.project_id;
  if (typeof project_id !== "string" || project_id.length === 0) {
    throw new TypeError("project_id must be a non-empty string");
  }
  if (input.key_store === null || typeof input.key_store !== "object" || typeof input.key_store.get !== "function") {
    throw new TypeError("key_store must have get(ref)");
  }
  const token = await input.key_store.get(token_ref(runtime, project_id));
  if (typeof token !== "string" || token.length === 0) {
    throw new AdapterError(
      "token_missing",
      "이 프로젝트의 에이전트 토큰이 키 저장소에 없습니다. 사람이 PES 화면에서 이 도구를 연결해 토큰을 저장한 뒤 다시 시작하세요.",
    );
  }
  return { PES_AGENT_TOKEN: token };
}

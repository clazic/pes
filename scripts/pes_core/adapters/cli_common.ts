// Shared by the two method-B terminal adapters (stage 2 PR20b, SEL-54): Codex CLI and OpenCode TUI.
//
// Neither adapter reads or writes a file, starts a process, or looks at a tool's own configuration folder. They
// only build the entry a person puts into the tool's MCP configuration, and read the agent token from the key
// store at launch. The key store is the PR19 KeyStore (scripts/pes_core/a_runtime/keystore.ts), imported as a TYPE
// only (no run-time dependency, nothing of the built-in runner is loaded): the adapters need get(ref) and nothing
// else, so a change of that signature fails to compile here.

import type { KeyStore } from "../a_runtime/keystore.ts";

export type TokenKeyStore = Pick<KeyStore, "get">;

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

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class AdapterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
  }
}

/**
 * A refused input. It is a TypeError (a wrong argument) with a fixed `code` and a Korean message. The message names
 * the field but never repeats the value, so a forged value cannot reach a log through the error.
 */
export class InputError extends TypeError {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "InputError";
    this.code = code;
  }
}

// Control characters (NUL, tab, CR, LF, DEL, C1) and the Unicode line/paragraph separators would break a
// hand-assembled configuration or smuggle a second variable into it. Spaces and quotes are path data and pass.
const CONTROL = /[\p{Cc}\u2028\u2029]/u;
// OpenCode expands {env:NAME} and {file:path} in the whole configuration text. A value carrying one would pull a
// secret or a file into the entry. Both tools share the rule so the two entries refuse the same input.
const SUBSTITUTION = /\{\s*(?:env|file)\s*:/i;

function check_text_field(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InputError("field_invalid", `${name} 값은 비어 있지 않은 문자열이어야 합니다.`);
  }
  if (CONTROL.test(value)) {
    throw new InputError("field_invalid", `${name} 값에 줄바꿈·탭·NUL 같은 제어 문자를 쓸 수 없습니다.`);
  }
  if (SUBSTITUTION.test(value) || SUBSTITUTION.test(value.normalize("NFKC"))) {
    throw new InputError("substitution_blocked", `${name} 값에 {env:…}·{file:…} 같은 설정 치환 표기를 쓸 수 없습니다.`);
  }
  return value;
}

/**
 * The canonical origin of a loopback http address (scheme://host[:port]) and nothing else: no user info, query,
 * fragment, path, backslash, space or control character. The entry stores the normalised origin, so what the tool
 * reads is exactly what was checked. (The server's own HttpApi would silently normalise such a string.)
 */
function canonical_loopback_origin(value: unknown): string {
  const bad = () => new InputError("api_base_url_invalid", "api_base_url은 이 컴퓨터의 http 주소(예: http://127.0.0.1:8760)만 쓸 수 있습니다. 토큰이 이 컴퓨터를 떠나면 안 됩니다.");
  if (typeof value !== "string" || value.length === 0) throw bad();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw bad();
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) throw bad();
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") throw bad();
  // the text must already be the origin, with at most one trailing slash: this rules out spaces, backslashes,
  // control characters, upper case, default-port spelling and every other way of writing the same address
  if (value !== url.origin && value !== `${url.origin}/`) throw bad();
  return url.origin;
}

/** Checks the four required fields and the loopback base URL; returns the model ("unknown" if not given) and the origin. */
export function check_entry_input(input: CliMcpEntryInput): { model: string; api_base_url: string } {
  if (input === null || typeof input !== "object") throw new InputError("field_invalid", "연결 항목 입력이 객체가 아닙니다.");
  check_text_field("command", input.command);
  check_text_field("server_script", input.server_script);
  check_text_field("project_id", input.project_id);
  const api_base_url = canonical_loopback_origin(input.api_base_url);
  const model = input.model === undefined ? "unknown" : check_text_field("model", input.model);
  return { model, api_base_url };
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
  const ref = token_ref(runtime, project_id);
  // the real key store accepts only this alphabet; refuse early with the adapter's own code instead of a store error
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(ref)) {
    throw new InputError("field_invalid", "project_id에 키 저장소 이름으로 쓸 수 없는 문자가 있거나 너무 깁니다.");
  }
  const token = await input.key_store.get(ref);
  if (typeof token !== "string" || token.length === 0) {
    throw new AdapterError(
      "token_missing",
      "이 프로젝트의 에이전트 토큰이 키 저장소에 없습니다. 토큰을 키 저장소에 넣는 PES 명령은 아직 없습니다. 등록으로 받은 토큰을 도구를 켜는 셸의 환경변수 PES_AGENT_TOKEN으로 직접 넘겨 다시 시작하세요.",
    );
  }
  return { PES_AGENT_TOKEN: token };
}

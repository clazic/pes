// PES install helper — checks and installs the tools PES uses (CLI, skill, MCP) and registers API keys received on a local web form.
// TypeScript twin of scripts/setup.py:  node scripts/setup.ts <command>   (Node 26 strips the types; no build step, no extra package)
//
// The seven commands (check, install, upgrade, keys, keys-serve, mark, needed) print what setup.py printed, byte for byte, except
// (docs/plan/migration-ts-equivalence.md, D12): `check` has no `python` row (PES TS runs no Python) and the usage names this command.
// Installing and upgrading the EXTERNAL tools (kosis, vworld, korean-law, ego lite) stays what it was: their own installers run as
// programs (curl | sh, PowerShell irm | iex, npm). A tool that cannot be run counts as missing, as in setup.py (its run() turned every
// failure into code -1).
//
// Where things go (the same as 0.15, and they follow HOME / USERPROFILE, so a test with a temporary home never touches a real one):
//   ~/.pes/setup.json (mark)  ·  ~/.pes/setup.log, setup-keys.json, setup-keys.out (key screen)  ·  ~/.claude/settings.json (LAW_OC)
// The key screen listens on 127.0.0.1:8759, or on the port in PES_KEYS_PORT (an integer 1~65535) when that variable is set.
// Key values go screen → this program → each tool; the output shows masked values only.
import "./node_guard.ts"; // first: Node 26 미만이면 한국어 한 줄로 끝낸다 (exit 1)
import { spawn, spawnSync } from "node:child_process";
import { accessSync, appendFileSync, closeSync, constants, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const HOME = homedir();
const PESDIR = join(HOME, ".pes");
const LOG = join(PESDIR, "setup.log");
const MARK = join(PESDIR, "setup.json");
const SETTINGS = join(HOME, ".claude", "settings.json");
const WIN = process.platform === "win32";
const DEFAULT_KEY_PORT = 8759;
const KEYS_PORT_ENV = "PES_KEYS_PORT";
const VERSION: string = (() => {
  try {
    const version = (JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : "";
  } catch {
    return "";
  }
})();

const DOC = `PES 설치 도우미 — 필요한 도구(CLI·스킬·MCP)를 확인·설치하고, API 키를 로컬 웹 폼으로 받아 등록한다.

사용: node scripts/setup.ts <명령>
  check [--json]            설치·키 상태 (항목마다 ok|missing|user|optional)
  install <이름…|missing>    설치: kosis vworld korean-law korean-law-mcp ego-browser  (missing = 빠진 것 전부)
  upgrade [이름…|all]        이미 설치된 것을 최신으로: kosis(CLI+스킬) vworld(CLI+스킬) korean-law(CLI·MCP 공용 npm)
                            ego-browser(ego lite 앱) — 줄마다 "UPGRADED|OK|FAIL|SKIP <이름> <버전>"
  keys [--no-open] [--wait] API 키 입력 화면(127.0.0.1:8759)을 띄우고 주소 출력. 결과는 ~/.pes/setup.log 에
                            "SETUP keys …" 한 줄로 남는다 (Monitor 로 기다린다). 키 값은 Claude 대화로 오지 않는다.
  mark                      설치 완료 표시 (~/.pes/setup.json) — 다른 PES 명령이 이것을 보고 setup 필요 여부를 안다
  needed                    setup 이 필요하면 이유를 출력하고 종료 코드 1, 아니면 0

키 값은 화면 → 이 프로그램 → 각 도구(kosis·vworld 설정, Claude Code 설정 env)로만 간다. 출력에는 가린 값만.
`;

type Env = Record<string, string | undefined>;
type State = "ok" | "missing" | "user" | "optional" | "key";
interface Row {
  name: string;
  state: State;
  label: string;
  detail: string;
  group: string;
}

class Exit extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- small helpers
const pad = (n: number): string => String(n).padStart(2, "0");

/** time.strftime in local time: only the formats this file uses. */
function stamp(kind: "log" | "mark" | "file" = "log"): string {
  const d = new Date();
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (kind === "mark") return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (kind === "file") return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Python's json.dumps(obj, ensure_ascii=False): separators ", " and ": ". */
function py_dumps(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(py_dumps).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${JSON.stringify(key)}: ${py_dumps(item)}`)
      .join(", ")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function mask(value: unknown): string {
  const v = value === null || value === undefined || value === false ? "" : String(value);
  return v.length > 4 ? v.slice(0, 2) + "*".repeat(Math.max(0, v.length - 4)) + v.slice(-2) : "****";
}

function is_object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function is_file(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/** shutil.which: first match on PATH, nothing when it cannot be looked at.
 * Windows (as shutil.which with mode X_OK): a name that does not already end in a PATHEXT extension is looked up only as `name + ext`,
 * never as the bare file — npm's cmd-shim puts an extensionless sh script (`npm`, `claude`, `korean-law`) next to each `.cmd`, and
 * that script cannot be started there. Elsewhere: a file with the execute permission. */
function which(name: string): string | null {
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter((dir) => dir !== "");
  const pathext = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext !== "");
  const exts = !WIN ? [""] : pathext.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase())) ? [""] : pathext;
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (!is_file(candidate)) continue;
      try {
        if (!WIN) accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // present but not executable here
      }
    }
  }
  return null;
}

function find_tool(name: string): string | null {
  const found = which(name);
  if (found !== null) return found;
  const candidates = [join(HOME, ".local", "bin", name)];
  if (process.platform === "darwin") {
    candidates.push(join("/opt/homebrew/bin", name), join("/usr/local/bin", name));
    if (name === "vworld") candidates.push(join(HOME, ".claude", "skills", "vworld", "app", "vworld-macos"));
  }
  if (WIN) {
    const la = process.env.LOCALAPPDATA ?? join(HOME, "AppData", "Local");
    const ap = process.env.APPDATA ?? join(HOME, "AppData", "Roaming");
    candidates.push(
      join(la, "Programs", name, `${name}.exe`),
      join(la, name, `${name}.exe`),
      join(HOME, ".local", "bin", `${name}.exe`),
      join(ap, "npm", `${name}.cmd`),
      join(la, "Programs", "ego lite", `${name}.exe`),
    );
    if (name === "vworld") candidates.push(join(HOME, ".claude", "skills", "vworld", "app", "vworld-windows.exe"));
  }
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

const tool = (name: string): string | null => find_tool(name);

function settings_env(): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(readFileSync(SETTINGS, "utf8"));
    if (!is_object(data)) return {};
    return is_object(data.env) ? data.env : {};
  } catch {
    return {};
  }
}

function node_env(extra?: Env): Env {
  const env: Env = { ...process.env };
  const found = settings_env();
  for (const key of ["LAW_OC", "NODE_EXTRA_CA_CERTS"]) {
    const value = found[key];
    if (!env[key] && typeof value === "string" && value !== "") env[key] = value;
  }
  return { ...env, ...(extra ?? {}) };
}

const quote_cmd = (arg: string): string => (/^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`);

/** subprocess.run(capture_output): [exit code, stdout + stderr]; any failure (cannot start, timeout) is [-1, message]. */
function run(cmd: string[], timeout_s = 600, env?: Env): [number, string] {
  try {
    const [program, ...args] = cmd as [string, ...string[]];
    const batch = WIN && /\.(cmd|bat)$/i.test(program);
    const result = batch
      ? spawnSync([program, ...args].map(quote_cmd).join(" "), { shell: true, encoding: "utf8", timeout: timeout_s * 1000, env: env as NodeJS.ProcessEnv | undefined, maxBuffer: 256 * 1024 * 1024 })
      : spawnSync(program, args, { encoding: "utf8", timeout: timeout_s * 1000, env: env as NodeJS.ProcessEnv | undefined, maxBuffer: 256 * 1024 * 1024 });
    if (result.error !== undefined) return [-1, String(result.error.message)];
    if (result.status === null) return [-1, `Command '${program}' timed out or was stopped (${result.signal ?? "?"})`];
    return [result.status, (result.stdout ?? "") + (result.stderr ?? "")];
  } catch (error) {
    return [-1, error instanceof Error ? error.message : String(error)];
  }
}

const last_lines = (text: string, count: number): string[] =>
  text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-count);

/** webbrowser.open: best effort, never an error. */
function open_url(url: string): void {
  try {
    const [program, args]: [string, string[]] = WIN ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    spawn(program, args, { stdio: "ignore", detached: true, windowsHide: true })
      .on("error", () => undefined)
      .unref();
  } catch {
    // no browser to open
  }
}

/** connect_ex == 0: something accepts connections on the port. The probe leaves politely (reads until the other side closes). */
function port_accepts(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let busy = false;
    const finish = (): void => {
      socket.destroy();
      done(busy);
    };
    socket.setTimeout(1000, finish);
    socket.once("connect", () => {
      busy = true;
      socket.resume();
      socket.end();
    });
    socket.once("error", finish);
    socket.once("close", finish);
  });
}

/**
 * Is the port taken by something else? Binding it for a moment answers without touching the program that holds it (a program that
 * answers every connection can be hit by the reset of a probe that connects and leaves). When the bind works, a connection check
 * still catches a holder bound to another address. Only for the moment BEFORE the screen is started (the bind would race its listen).
 */
function port_taken(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") done(true);
      else void port_accepts(port).then(done);
    });
    probe.listen({ port, host: "127.0.0.1" }, () => probe.close(() => void port_accepts(port).then(done)));
  });
}

function key_port(): number {
  const text = process.env[KEYS_PORT_ENV];
  if (text === undefined || text === "") return DEFAULT_KEY_PORT;
  const port = /^\d{1,5}$/.test(text) ? Number(text) : 0;
  if (port < 1 || port > 65535) throw new Exit(2, `${KEYS_PORT_ENV}: 1~65535 사이의 정수여야 합니다 (받은 값: ${JSON.stringify(text)})`);
  return port;
}

// ---------------------------------------------------------------- state
function kosis_keys(): number {
  const t = tool("kosis");
  if (t === null) return 0;
  const [, out] = run([t, "config", "key-list"], 20);
  return (out.match(/^\s*\[\d+\]/gm) ?? []).length || (process.env.KOSIS_API_KEY ? 1 : 0);
}

function vworld_keys(): number {
  const t = tool("vworld");
  if (t === null) return 0;
  const [, out] = run([t, "config", "list-keys"], 20);
  return out.split('"masked"').length - 1;
}

/** ego-browser skill: it lives inside the ego lite app; ~/.claude/skills/ego-browser is a link to it. → [state, text, skill version, app guide version] */
function ego_skill(): [State, string, string | null, string | null] {
  const sk = join(HOME, ".claude", "skills", "ego-browser", "SKILL.md");
  const t = tool("ego-browser");
  let sv: string | null = null;
  if (exists(sk)) {
    const m = /version:\s*"?([\d.]+)/.exec(readFileSync(sk, "utf8"));
    sv = m !== null ? (m[1] as string) : "?";
  }
  let gv: string | null = null;
  if (t !== null) {
    const [, out] = run([t, "skill"], 30);
    const m = /usage guide v([\d.]+)/.exec(out);
    gv = m !== null ? (m[1] as string) : null;
  }
  if (t === null) return ["user", "ego lite 설치 후 생김", sv, gv];
  if (sv === null) {
    return ["missing", "스킬 연결이 없음 — ego lite 앱을 열어 첫 실행 안내(온보딩)를 다시 진행하면 연결된다. PES 는 `ego-browser skill` 출력으로도 쓸 수 있다", sv, gv];
  }
  if (gv !== null && sv !== gv) return ["missing", `스킬 ${sv} ≠ 앱 안내 ${gv} — 연결이 옛 버전을 가리킴. ego lite 앱을 다시 열거나 재설치`, sv, gv];
  let real = "";
  try {
    real = realpathSync(join(HOME, ".claude", "skills", "ego-browser"));
  } catch {
    real = "";
  }
  return ["ok", `v${sv}${real.toLowerCase().includes("ego") ? " (앱과 연결)" : ""}`, sv, gv];
}

function gitbash(): string | null {
  if (!WIN) return which("bash");
  for (const candidate of [which("bash"), "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe", join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe")]) {
    if (candidate !== null && exists(candidate)) return candidate;
  }
  return null;
}

/** null = unknown (no claude CLI: only Desktop installed) */
function mcp_status(): boolean | null {
  const c = which("claude");
  if (c === null) return null;
  const [code, out] = run([c, "mcp", "get", "korean-law"], 30);
  return code === 0 && out.includes("korean-law");
}

const norm = (v: string | null | undefined): string | null => (v ? `v${v.replace(/^v+/, "")}` : null);

/** Installed skill's version — kosis: the VERSION file; vworld: the binary inside the skill's app/ folder. */
function skill_version(name: string): string | null {
  const d = join(HOME, ".claude", "skills", name);
  if (!exists(join(d, "SKILL.md"))) return null;
  if (name === "kosis") {
    try {
      return norm(readFileSync(join(d, "VERSION"), "utf8").trim());
    } catch {
      return "?";
    }
  }
  if (name === "vworld") {
    const exe = join(d, "app", WIN ? "vworld-windows.exe" : process.platform === "darwin" ? "vworld-macos" : "vworld-linux");
    if (exists(exe)) {
      const [, out] = run([exe, "--version"], 30);
      const m = /(\d+\.\d+\.\d+)/.exec(out);
      return m !== null ? norm(m[1]) : "?";
    }
  }
  return "?";
}

function check(): Row[] {
  const S: Row[] = [];
  const add = (name: string, state: State, label: string, detail = "", group = "도구"): void => {
    S.push({ name, state, label, detail, group });
  };
  // no `python` row (D12): PES TS runs no Python
  const git = which("git");
  add("git", git !== null ? "ok" : "missing", "Git", git !== null ? "" : "bootstrap 으로 설치", "기본");
  if (WIN) {
    const gb = gitbash();
    add("gitbash", gb !== null ? "ok" : "missing", "Git Bash", gb ?? "답 자동 수신(Monitor)에 필요 — Git for Windows", "기본");
  }
  const npm = which("npm");
  add("node", which("node") !== null && npm !== null ? "ok" : "missing", "Node.js·npm", npm !== null ? "" : "korean-law 설치에 필요", "기본");

  const ego = tool("ego-browser");
  add("ego-browser", ego !== null ? "ok" : "user", "ego lite (ego-browser)", ego ?? "앱 설치 + 첫 실행 안내(온보딩)는 사용자가 직접");
  const [ego_state, why] = ego_skill();
  add("ego-browser-skill", ego_state !== "user" ? ego_state : "optional", "ego-browser 스킬", why);
  for (const [name, what] of [["kosis", "통계청 KOSIS"], ["vworld", "국가공간정보"]] as const) {
    const t = tool(name);
    const sv = skill_version(name);
    let cv: string | null = null;
    if (t !== null) {
      const [, o] = run([t, "--version"], 20);
      const m = /(\d+\.\d+\.\d+)/.exec(o);
      cv = m !== null ? norm(m[1]) : null;
    }
    if (t !== null && sv && cv && sv !== "?" && sv !== cv) {
      add(name, "missing", `${name} CLI + 스킬`, `CLI ${cv} · 스킬 ${sv} — 버전이 다름 (설치 도우미가 맞춘다)`);
    } else {
      add(name, t !== null && sv ? "ok" : "missing", `${name} CLI + 스킬`, t !== null ? `CLI ${cv || "-"} · 스킬 ${sv || "없음"}` : what);
    }
  }
  const law = tool("korean-law");
  add("korean-law", law !== null ? "ok" : "missing", "korean-law CLI", law ?? "법령 조회");
  const m = mcp_status();
  add("korean-law-mcp", m ? "ok" : "optional", "korean-law MCP (선택)", m === null ? "claude CLI 가 없어 확인 생략 — CLI 만으로 충분" : m ? "" : "Claude 에 MCP 로도 등록");

  let n = kosis_keys();
  add("key-kosis", n ? "ok" : "key", "KOSIS API 키", n ? `${n}개` : "https://kosis.kr/openapi/", "API 키");
  n = vworld_keys();
  add("key-vworld", n ? "ok" : "key", "VWorld API 키", n ? `${n}개` : "https://www.vworld.kr", "API 키");
  const oc = process.env.LAW_OC || settings_env().LAW_OC;
  add("key-law", oc ? "ok" : "key", "법령 LAW_OC", oc ? mask(oc) : "https://open.law.go.kr", "API 키");
  return S;
}

// ---------------------------------------------------------------- install
function sh_pipe(url: string, envs: Record<string, string>): [number, string] {
  const ev = Object.entries(envs).map(([k, v]) => `${k}=${v}`).join(" ");
  const shell = url.endsWith(".sh") && url.includes("vworld") ? "bash" : "sh";
  return run(["sh", "-c", `curl -fsSL ${url} | ${ev} ${shell}`], 900);
}

function ps_pipe(url: string, envs: Record<string, string>): [number, string] {
  const ev = Object.entries(envs).map(([k, v]) => `$env:${k}='${v}'`).join("; ");
  return run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `${ev}${ev ? "; " : ""}irm ${url} | iex`], 900);
}

function npm_global(args: string[]): [number, string] {
  const npm = which("npm") as string;
  const cmd = [npm, "install", "-g", ...args, "--ignore-scripts", "--omit=optional"];
  const env = node_env();
  const ca = env.NODE_EXTRA_CA_CERTS;
  if (ca && exists(ca)) cmd.push("--cafile", ca);
  return run(cmd, 900, env);
}

function install_one(name: string): [number, string] {
  if (name === "kosis") {
    const envs = { KOSIS_TARGET: "claude", KOSIS_CLAUDE_SCOPE: "global" };
    return WIN ? ps_pipe("https://raw.githubusercontent.com/clazic/kosis/master/scripts/install.ps1", envs) : sh_pipe("https://raw.githubusercontent.com/clazic/kosis/master/scripts/install.sh", envs);
  }
  if (name === "vworld") {
    return WIN
      ? ps_pipe("https://raw.githubusercontent.com/clazic/vworld/main/scripts/install.ps1", {})
      : sh_pipe("https://raw.githubusercontent.com/clazic/vworld/main/scripts/install.sh", { VWORLD_SCOPE: "user" });
  }
  if (name === "korean-law") {
    if (which("npm") === null) return [1, "npm 없음 — bootstrap 으로 Node.js 먼저 설치"];
    return npm_global(["korean-law-mcp"]);
  }
  if (name === "korean-law-mcp") return register_mcp();
  if (name === "ego-browser") {
    const sc = join(HOME, ".claude", "skills", "ego-browser", "scripts", "install.sh");
    if (process.platform === "darwin" && exists(sc)) {
      const [code, out] = run(["sh", sc], 900);
      return [code === 0 ? 2 : code, `${out}\nUSER ego lite 앱에서 첫 실행 안내(온보딩)를 마쳐 주세요.`];
    }
    open_url("https://lite.ego.app/");
    return [2, `USER https://lite.ego.app/ 에서 ego lite 를 내려받아 설치하고, 앱을 열어 첫 실행 안내(온보딩)를 마쳐 주세요.${WIN ? " Windows SmartScreen 이 막으면 '추가 정보 → 실행'." : ""}`];
  }
  return [1, `알 수 없는 항목: ${name}`];
}

function register_mcp(law_oc?: string): [number, string] {
  const c = which("claude");
  const srv = tool("korean-law-mcp");
  if (c === null) return [3, "claude CLI 가 없어 MCP 등록을 건너뜀 (PES 는 korean-law CLI 를 쓰므로 없어도 됨)"];
  if (srv === null) return [1, "korean-law-mcp 실행 파일 없음 — korean-law 먼저 설치"];
  const e = node_env();
  const oc = law_oc || e.LAW_OC;
  run([c, "mcp", "remove", "korean-law", "-s", "user"], 60);
  const cmd = [c, "mcp", "add", "korean-law", "-s", "user"];
  if (oc) cmd.push("-e", `LAW_OC=${oc}`);
  if (e.NODE_EXTRA_CA_CERTS) cmd.push("-e", `NODE_EXTRA_CA_CERTS=${e.NODE_EXTRA_CA_CERTS}`);
  cmd.push("--", srv);
  const [code, out] = run(cmd, 60);
  const text = code === 0 ? "MCP 등록됨" : out.slice(-300);
  return [code, oc ? text.split(oc).join(mask(oc)) : text];
}

function cmd_install(args: string[]): void {
  let names = args;
  if (names.length === 0 || (names.length === 1 && names[0] === "missing")) {
    names = check()
      .filter((x) => (x.state === "missing" || x.state === "user") && ["kosis", "vworld", "korean-law", "korean-law-mcp", "ego-browser"].includes(x.name))
      .map((x) => x.name);
    if (names.length === 0) {
      console.log("OK 설치할 것 없음");
      return;
    }
  }
  for (const n of names) {
    console.log(`... ${n} 설치 중`);
    const [code, out] = install_one(n);
    const tail = last_lines(out, 3);
    const state = code === 0 ? "OK" : code === 2 ? "USER" : code === 3 ? "SKIP" : "FAIL";
    console.log(`${state} ${n}${state !== "OK" && tail.length > 0 ? ` — ${tail.join(" / ")}` : ""}`);
  }
}

// ---------------------------------------------------------------- upgrade
function versions(out: string): [string | null, string | null] {
  const cur = /현재 버전:\s*(\S+)/.exec(out);
  const latest = /최신 버전:\s*(\S+)/.exec(out);
  return [cur !== null ? (cur[1] as string) : null, latest !== null ? (latest[1] as string) : null];
}

/** kosis / vworld: CLI and skill are checked apart; when either is behind, the official installer runs again. */
function upgrade_cli_skill(name: string): [string, string] {
  const t = tool(name);
  if (t === null) return ["SKIP", "설치되어 있지 않음"];
  const [code, out] = run([t, "update", "--check"], 120);
  const [cur0, new0] = versions(out);
  const cur = norm(cur0);
  const latest = norm(new0);
  if (code !== 0 || latest === null) return ["FAIL", `최신 버전 확인 실패: ${(last_lines(out, 1)[0] ?? "응답 없음").slice(0, 120)}`];
  const sk = skill_version(name);
  if (cur === latest && sk === latest) return ["OK", `CLI ${cur} · 스킬 ${sk} (최신)`];
  let note = "";
  const skill_dir = join(HOME, ".claude", "skills", "kosis");
  if (name === "kosis" && exists(skill_dir)) {
    const bak = join(PESDIR, "backup", `kosis-skill-${stamp("file")}`);
    mkdirSync(dirname(bak), { recursive: true });
    cpSync(skill_dir, bak, { recursive: true, verbatimSymlinks: true, filter: (source) => basename(source) !== "apps" });
    note = ` · 이전 스킬 백업 ${bak}`;
  }
  const [, out2] = install_one(name);
  const [c2raw] = versions(run([tool(name) ?? t, "update", "--check"], 120)[1]);
  const c2 = norm(c2raw);
  const sk2 = skill_version(name);
  if (c2 === latest && sk2 === latest) return ["UPGRADED", `CLI ${cur} → ${c2} · 스킬 ${sk || "없음"} → ${sk2}${note}`];
  return ["FAIL", `CLI ${cur} → ${c2} · 스킬 ${sk} → ${sk2} (최신 ${latest}) — ${(last_lines(out2, 1)[0] ?? "?").slice(0, 120)}${note}`];
}

function upgrade_korean_law(): [string, string] {
  const npm = which("npm");
  if (npm === null || tool("korean-law") === null) return ["SKIP", "설치되어 있지 않음"];
  let [, out] = run([npm, "ls", "-g", "korean-law-mcp", "--json"], 60);
  let cur: string | null = null;
  try {
    const found = (JSON.parse(out) as { dependencies?: { "korean-law-mcp"?: { version?: string } } }).dependencies?.["korean-law-mcp"]?.version;
    cur = typeof found === "string" ? found : null;
  } catch {
    cur = null;
  }
  let code: number;
  [code, out] = run([npm, "view", "korean-law-mcp", "version"], 60, node_env());
  const latest = code === 0 ? (out.trim().split(/\r?\n/).pop() ?? "").trim() : null;
  if (latest === null || !/^\d+(\.\d+)*$/.test(latest)) return ["FAIL", "최신 버전 확인 실패 (인증서 오류면 NODE_EXTRA_CA_CERTS)"];
  if (cur === latest) return ["OK", `${cur} (최신)`];
  [code, out] = npm_global([`korean-law-mcp@${latest}`]);
  return code === 0 ? ["UPGRADED", `${cur} → ${latest} (CLI·MCP 함께)`] : ["FAIL", out.trim().slice(-160)];
}

function upgrade_ego(): [string, string] {
  const t = tool("ego-browser");
  if (t === null) return ["SKIP", "설치되어 있지 않음"];
  const second = (text: string): string => text.split(/\s+/).filter((x) => x !== "")[1] ?? "";
  const cur = second(run([t, "--version"], 30)[1]);
  const sk0 = ego_skill()[2];
  const [code, out] = run([t, "upgrade"], 600);
  const latest = second(run([t, "--version"], 30)[1]);
  const last = (last_lines(out, 1)[0] ?? "").slice(0, 140);
  if (code !== 0) {
    if (out.includes("Unknown command")) return ["FAIL", "이 ego lite 는 너무 오래되어 자동 업그레이드가 안 됨 — https://lite.ego.app/ 에서 다시 설치"];
    return ["FAIL", last || "업그레이드 실패 (진행 중인 브라우저 작업이 있으면 ego lite 창의 확인 대화상자를 보세요)"];
  }
  const [state, why, sk1] = ego_skill();
  const skill = sk0 !== sk1 ? ` · 스킬 ${sk0} → ${sk1}` : ` · 스킬 v${sk1}`;
  if (state !== "ok") return ["FAIL", `앱 ${cur} → ${latest || cur}, 그러나 스킬 문제: ${why}`];
  if (latest && latest !== cur) return ["UPGRADED", `앱 ${cur} → ${latest}${skill} (앱이 스킬도 함께 갱신)`];
  return ["OK", `앱 ${cur}${skill} (${last || "최신"})`];
}

const UPGRADERS: Record<string, () => [string, string]> = {
  kosis: () => upgrade_cli_skill("kosis"),
  vworld: () => upgrade_cli_skill("vworld"),
  "korean-law": upgrade_korean_law,
  "ego-browser": upgrade_ego,
};

function cmd_upgrade(args: string[]): void {
  const given = args.filter((a) => a !== "all");
  const names = given.length > 0 ? given : Object.keys(UPGRADERS);
  for (const n of names) {
    const upgrader = Object.hasOwn(UPGRADERS, n) ? UPGRADERS[n] : undefined;
    if (upgrader === undefined) {
      console.log(`FAIL ${n} 알 수 없는 항목`);
      continue;
    }
    console.log(`... ${n} 최신 버전 확인`);
    let result: [string, string];
    try {
      result = upgrader();
    } catch (error) {
      result = ["FAIL", (error instanceof Error ? error.message : String(error)).slice(0, 160)];
    }
    console.log(`${result[0]} ${n} ${result[1]}`);
  }
}

// ---------------------------------------------------------------- API key screen
function test_kosis(k: string): [boolean, string] {
  const t = tool("kosis");
  if (t === null) return [false, "kosis 미설치"];
  const [code, out] = run([t, "s", "인구", "-n", "1"], 60, node_env({ KOSIS_API_KEY: k }));
  return [code === 0, code === 0 ? "" : (last_lines(out, 1)[0] ?? "응답 없음").slice(0, 160)];
}

function reg_kosis(k: string): [boolean, string] {
  const [ok, why] = test_kosis(k);
  if (!ok) return [false, `키 확인 실패: ${why}`];
  const [code, out] = run([tool("kosis") as string, "config", "add-key", k], 30);
  return [code === 0, code === 0 ? "등록·확인 완료" : out.slice(-200)];
}

function reg_vworld(k: string): [boolean, string] {
  const t = tool("vworld");
  if (t === null) return [false, "vworld 미설치"];
  let [code, out] = run([t, "config", "add-key", k, "--alias", "pes"], 30);
  if (code !== 0 && !out.includes("중복") && !out.toLowerCase().includes("exist")) return [false, out.trim().slice(-200).split(k).join(mask(k))];
  [code, out] = run([t, "config", "test-keys"], 120);
  let verdict: string | null = null;
  try {
    const results = (JSON.parse(out.slice(out.indexOf("{"))) as { results?: Array<{ key?: unknown; verdict?: unknown }> }).results ?? [];
    for (const r of results) {
      const mk = String(r.key ?? "");
      if (mk.slice(0, 4) === k.slice(0, 4) && mk.slice(-4) === k.slice(-4)) verdict = typeof r.verdict === "string" ? r.verdict : null;
    }
  } catch {
    verdict = null;
  }
  if (verdict !== "유효") {
    run([t, "config", "remove-key", k], 30);
    return [false, `VWorld 확인 결과: ${verdict ?? "알 수 없음"} — 등록하지 않음 (발급 직후면 몇 분 뒤 다시)`];
  }
  return [true, "등록·확인 완료"];
}

function reg_law(k: string): [boolean, string] {
  const t = tool("korean-law");
  if (t !== null) {
    const [, out] = run([t, "search_law", "--query", "민법"], 90, node_env({ LAW_OC: k }));
    if (!out.includes("검색 결과")) {
      const why = out.includes("CERT") ? "인증서 오류 — NODE_EXTRA_CA_CERTS 확인" : (last_lines(out, 1)[0] ?? "응답 없음").slice(0, 160);
      return [false, `확인 실패: ${why}`.split(k).join(mask(k))];
    }
  }
  mkdirSync(dirname(SETTINGS), { recursive: true });
  let d: unknown = {};
  if (exists(SETTINGS)) {
    copyFileSync(SETTINGS, `${SETTINGS}.bak-pes`);
    d = JSON.parse(readFileSync(SETTINGS, "utf8"));
  }
  if (!is_object(d)) throw new Error("settings.json 의 맨 위가 객체가 아닙니다");
  if (!Object.hasOwn(d, "env")) d.env = {};
  if (!is_object(d.env)) throw new Error("settings.json 의 env 가 객체가 아닙니다");
  d.env.LAW_OC = k;
  writeFileSync(SETTINGS, JSON.stringify(d, null, 2), "utf8");
  const msg = t !== null
    ? "Claude Code 설정(env)에 등록 · 법령 API 접속 정상 (법령 API 는 틀린 값에도 응답해 값 자체는 확인할 수 없음 — 발급받은 이메일 ID 앞부분이 맞는지 한 번 더 보세요)"
    : "Claude Code 설정(env)에 등록 (korean-law 미설치라 접속 확인은 나중에)";
  if (t !== null && which("claude") !== null && tool("korean-law-mcp") !== null) {
    const [c] = register_mcp(k);
    return [true, msg + (c === 0 ? " · MCP 갱신" : "")];
  }
  return [true, msg];
}

interface KeySpec {
  id: string;
  label: string;
  check: string;
  reg: (k: string) => [boolean, string];
  url: string;
  steps: string[];
}

const KEYS: KeySpec[] = [
  {
    id: "kosis",
    label: "KOSIS (통계청 국가통계포털) API 키",
    check: "key-kosis",
    reg: reg_kosis,
    url: "https://kosis.kr/openapi/",
    steps: ["kosis.kr/openapi 접속 → 로그인(회원가입)", "상단 '활용신청' → 활용 목적 입력 후 신청", "마이페이지 → 인증키 확인 → 복사"],
  },
  {
    id: "vworld",
    label: "VWorld (국가공간정보) API 키",
    check: "key-vworld",
    reg: reg_vworld,
    url: "https://www.vworld.kr/dev/v4dv_apikey_s001.do",
    steps: ["vworld.kr 로그인(회원가입)", "오픈API → 인증키 발급", "서비스 URL 없이(무도메인) · 활용 API 전체 선택 → 발급된 키 복사"],
  },
  {
    id: "law",
    label: "법령 API (국가법령정보 공동활용) — LAW_OC",
    check: "key-law",
    reg: reg_law,
    url: "https://open.law.go.kr/LSO/openApi/cuAskList.do",
    steps: ["open.law.go.kr 로그인(회원가입)", "OPEN API → 활용 신청 (법령·판례 등 체크)", "승인 후 이메일 ID 앞부분(@ 앞)이 LAW_OC 값 — 그 값을 입력"],
  },
];

const PAGE = `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PES 설치 — API 키</title><style>
:root{--bg:#f7f7f4;--fg:#1f2328;--muted:#6a737d;--card:#fff;--line:#e2e2dc;--accent:#2f6fde;--ok:#2e8b57;--bad:#c0392b;--chip:#efefea}
@media (prefers-color-scheme: dark){:root{--bg:#16181c;--fg:#e6e6e6;--muted:#9aa0a6;--card:#1f2227;--line:#33373d;--accent:#6ea0ff;--ok:#5fcf8f;--bad:#ff7a6b;--chip:#2a2e34;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif}
main{max-width:860px;margin:0 auto;padding:28px 20px 60px}h1{font-size:22px;margin:0 0 4px}.meta{color:var(--muted);font-size:13px}
.st{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 16px;margin:16px 0;display:grid;grid-template-columns:1fr 90px 1.4fr;gap:4px 12px;font-size:13px}
.st b{font-weight:600}.ok{color:var(--ok);font-weight:600}.no{color:var(--bad);font-weight:600}.mu{color:var(--muted)}
.key{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:12px 0}
.key h2{font-size:16px;margin:0 0 6px}.key ol{margin:6px 0 10px;padding-left:20px;font-size:13px;color:var(--muted)}
.row{display:flex;gap:8px}.row input{flex:1;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}.res{font-size:13px;margin-top:6px;min-height:1em}
.bar{display:flex;gap:10px;justify-content:flex-end;margin-top:18px}.done{border:2px solid var(--ok)}
</style></head><body><main id="app"></main>
<script id="data" type="application/json">__DATA__</script><script>
const D=JSON.parse(document.getElementById('data').textContent);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ST={ok:['정상','ok'],missing:['없음','no'],user:['직접 설치','no'],optional:['선택','mu'],key:['키 필요','no']};
function render(){document.getElementById('app').innerHTML=\`<h1>PES 설치 — API 키 등록</h1>
<div class="meta">키는 이 화면에서 이 컴퓨터의 각 도구 설정으로 바로 등록됩니다. Claude 대화로는 전달되지 않습니다. 필요 없는 기능은 비워 두고 '마치기'를 누르세요.</div>
<div class="st">\${D.status.map(s=>\`<b>\${esc(s.label)}</b><span class="\${ST[s.state][1]}">\${ST[s.state][0]}</span><span class="mu">\${esc(s.detail)}</span>\`).join('')}</div>
\${D.keys.map(k=>\`<div class="key \${k.has?'done':''}" id="k-\${k.id}"><h2>\${esc(k.label)} \${k.has?'<span class="ok">· 등록되어 있음</span>':''}</h2>
<ol>\${k.steps.map(s=>\`<li>\${esc(s)}</li>\`).join('')}</ol><div class="meta" style="margin:-4px 0 8px"><a href="\${esc(k.url)}" target="_blank" rel="noopener">발급 페이지 열기</a></div>
<div class="row"><input type="password" autocomplete="off" spellcheck="false" placeholder="\${k.has?'새 키를 추가하려면 입력':'발급받은 키 붙여넣기'}" data-k="\${k.id}"><button data-show="\${k.id}">보기</button><button class="primary" data-reg="\${k.id}">등록·확인</button></div>
<div class="res" id="r-\${k.id}"></div></div>\`).join('')}
<div class="bar"><button class="primary" id="fin">마치기 — Claude 에게 알리기</button></div>\`;}
async function post(path,body){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:D.token,...body})});return r.json();}
document.addEventListener('click',async e=>{
 const s=e.target.closest('[data-show]');if(s){const i=document.querySelector(\`[data-k="\${s.dataset.show}"]\`);i.type=i.type==='password'?'text':'password';return;}
 const b=e.target.closest('[data-reg]');if(b){const id=b.dataset.reg,i=document.querySelector(\`[data-k="\${id}"]\`),r=document.getElementById('r-'+id);
  if(!i.value.trim()){r.textContent='키를 입력하세요.';return;}b.disabled=true;r.textContent='확인 중… (최대 1분)';
  try{const j=await post('/key',{id,value:i.value.trim()});r.innerHTML=j.ok?\`<span class="ok">\${esc(j.msg)}</span>\`:\`<span class="no">\${esc(j.msg)}</span>\`;if(j.ok){i.value='';document.getElementById('k-'+id).classList.add('done');}}
  catch{r.innerHTML='<span class="no">보내기 실패</span>';}b.disabled=false;return;}
 if(e.target.id==='fin'){e.target.disabled=true;try{await post('/finish',{});document.getElementById('app').innerHTML='<h1>완료</h1><p>Claude 가 이어서 점검(/pes:doctor)을 진행합니다. 이 창은 닫아도 됩니다.</p>';}catch{e.target.disabled=false;}}
});render();
</script></body></html>`;

function log(line: string): void {
  mkdirSync(PESDIR, { recursive: true });
  appendFileSync(LOG, `${stamp()} ${line}\n`, "utf8");
}

/** str(value or "") of a JSON value, for the key the person typed. */
function key_text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return value === 0 ? "" : String(value);
  if (value === true) return "True";
  return "";
}

function cmd_keys_serve(args: string[]): Promise<void> {
  const token = args[0];
  if (token === undefined) {
    process.stdout.write(`${DOC}\n`);
    process.exitCode = 1;
    return Promise.resolve();
  }
  const port = key_port();
  const results = new Map<string, string>();

  const send = (res: ServerResponse, code: number, body: string, type = "application/json; charset=utf-8"): void => {
    const bytes = Buffer.from(body, "utf8");
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "Content-Length": bytes.length });
    res.end(bytes);
  };

  const do_get = (req: IncomingMessage, res: ServerResponse): void => {
    const target = req.url ?? "/";
    if (target.split("?")[0] === "/ping") return send(res, 200, '{"ok":true}');
    if (target !== `/?t=${token}`) return send(res, 403, "주소가 바뀌었습니다. Claude 가 알려 준 주소로 다시 여세요.", "text/plain; charset=utf-8");
    const st = check();
    const have = new Map(st.map((x) => [x.name, x.state === "ok"]));
    const data = {
      token,
      status: st,
      keys: KEYS.map(({ reg: _reg, ...rest }) => ({ ...rest, has: have.get(rest.check) ?? false })),
    };
    return send(res, 200, PAGE.replace("__DATA__", () => py_dumps(data).replace(/<\//g, "<\\/")), "text/html; charset=utf-8");
  };

  const do_post = (req: IncomingMessage, res: ServerResponse): void => {
    const origin = String(req.headers.origin ?? "");
    if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return send(res, 403, '{"ok":false}');
    const length_text = String(req.headers["content-length"] ?? "");
    const n = /^\d+$/.test(length_text) ? Number(length_text) : 0;
    const finish = (raw: Buffer): void => {
      let d: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(raw.toString("utf8"));
        if (is_object(parsed)) d = parsed;
      } catch {
        d = {};
      }
      if (d.token !== token) return send(res, 403, '{"ok":false}');
      const target = req.url ?? "/";
      if (target === "/key") {
        const k = KEYS.find((x) => x.id === d.id);
        const v = key_text(d.value).trim();
        if (k === undefined || !/^[A-Za-z0-9+/=_.@-]{2,200}$/.test(v)) return send(res, 200, py_dumps({ ok: false, msg: "형식이 맞지 않습니다" }));
        let ok: boolean;
        let msg: string;
        try {
          [ok, msg] = k.reg(v);
        } catch (error) {
          ok = false;
          msg = `오류: ${error instanceof Error ? error.message : String(error)}`;
        }
        msg = msg.split(v).join(mask(v));
        results.set(k.id, ok ? "ok" : "fail");
        log(`KEY ${k.id} ${ok ? "ok" : "fail"}`);
        return send(res, 200, py_dumps({ ok, msg }));
      }
      if (target === "/finish") {
        const summary = [...results].map(([a, b]) => `${a}=${b}`).join(" ") || "none";
        log(`SETUP keys ${summary}`);
        send(res, 200, '{"ok":true}');
        setTimeout(() => process.exit(0), 300);
        return;
      }
      return send(res, 404, '{"ok":false}');
    };
    // a body of 8192 bytes or more is not read: it counts as {} (token mismatch)
    if (n <= 0 || n >= 8192) return finish(Buffer.from("{}"));
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.once("end", () => finish(Buffer.concat(chunks)));
  };

  const server = createServer((req, res) => {
    try {
      if (req.method === "GET") do_get(req, res);
      else if (req.method === "POST") do_post(req, res);
      else send(res, 501, "Unsupported method", "text/plain; charset=utf-8");
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      if (!res.headersSent) send(res, 500, '{"ok":false}');
    }
  });
  return new Promise<void>((done) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      process.stderr.write(`포트 ${port} 에서 키 화면을 시작하지 못했습니다 (${error.code ?? error.message})\n`);
      process.exit(1);
    });
    server.listen({ port, host: "127.0.0.1" });
    // the screen stays up for 3 hours, then it says so in the log and ends
    setTimeout(() => {
      log("SETUP keys timeout");
      server.close();
      done();
      process.exit(0);
    }, 3 * 3600 * 1000);
  });
}

function file_size(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

async function cmd_keys(args: string[]): Promise<void> {
  const port = key_port();
  mkdirSync(PESDIR, { recursive: true });
  if (await port_taken(port)) {
    try {
      // a screen started earlier is still there: end it
      const info = JSON.parse(readFileSync(join(PESDIR, "setup-keys.json"), "utf8")) as { pid?: unknown };
      const pid = info.pid;
      // only a real process id: 0 / negative would signal a whole process group
      if (typeof pid === "number" && Number.isInteger(pid) && pid > 1) {
        process.kill(pid);
        await sleep(500);
      }
    } catch {
      // not ours / already gone
    }
  }
  if (await port_taken(port)) throw new Exit(1, `포트 ${port} 사용 중 — 다른 프로그램을 끄거나 잠시 뒤 다시`);
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
  const out = openSync(join(PESDIR, "setup-keys.out"), "a");
  let pid: number | undefined;
  try {
    // the screen is this same program (same node flags) run as `keys-serve <token>`, detached from this command
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "keys-serve", token], {
      stdio: ["ignore", out, out],
      detached: true,
      windowsHide: true,
    });
    child.once("error", () => undefined);
    child.unref();
    pid = child.pid;
  } finally {
    closeSync(out);
  }
  if (pid === undefined) throw new Exit(1, "키 화면을 띄우지 못했습니다");
  writeFileSync(join(PESDIR, "setup-keys.json"), py_dumps({ pid }), "utf8");
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  for (let i = 0; i < 40; i += 1) {
    if (await port_accepts(port)) break;
    await sleep(100);
  }
  const start = file_size(LOG);
  if (!args.includes("--no-open")) open_url(url);
  console.log(url);
  if (!args.includes("--wait")) {
    console.log(`WATCH tail -n0 -F ${LOG.split("\\").join("/")} | grep --line-buffered 'SETUP keys'`);
    return;
  }
  console.log("브라우저의 API 키 화면에서 '마치기'를 누르면 이어서 진행합니다 (건너뛰려면 Ctrl+C).");
  process.once("SIGINT", () => {
    console.log("API 키 입력을 건너뜀 — 나중에 /pes:setup keys");
    process.exit(0);
  });
  for (;;) {
    await sleep(1000);
    if (file_size(LOG) > start) {
      const fd = openSync(LOG, "r");
      let text = "";
      try {
        const size = file_size(LOG);
        const buffer = Buffer.alloc(size - start);
        readSync(fd, buffer, 0, buffer.length, start);
        text = buffer.toString("utf8");
      } finally {
        closeSync(fd);
      }
      const fresh = text.split(/\r?\n/).filter((line) => line.includes("SETUP keys"));
      const last = fresh[fresh.length - 1];
      if (last !== undefined) {
        console.log(last.split(" ").slice(2).join(" "));
        return;
      }
    }
  }
}

// ---------------------------------------------------------------- the small commands
function cmd_check(args: string[]): void {
  const st = check();
  if (args.includes("--json")) {
    console.log(JSON.stringify(st, null, 1));
    return;
  }
  const M: Record<State, string> = { ok: "[정상]", missing: "[없음]", user: "[직접]", optional: "[선택]", key: "[키 필요]" };
  let group: string | null = null;
  for (const x of st) {
    if (x.group !== group) {
      group = x.group;
      console.log(`■ ${group}`);
    }
    console.log(`  ${M[x.state]} ${x.label}${x.detail ? ` — ${x.detail}` : ""}`);
  }
}

function cmd_mark(): void {
  mkdirSync(PESDIR, { recursive: true });
  const st = check();
  writeFileSync(MARK, JSON.stringify({ version: VERSION, time: stamp("mark"), state: Object.fromEntries(st.map((x) => [x.name, x.state])) }, null, 1), "utf8");
  console.log(`설치 완료 표시: ${MARK} (PES ${VERSION})`);
}

function cmd_needed(): void {
  let m: unknown;
  try {
    m = JSON.parse(readFileSync(MARK, "utf8"));
  } catch {
    m = undefined;
  }
  if (!is_object(m)) {
    console.log("PES 설치 점검을 한 적이 없습니다 — /pes:setup");
    process.exitCode = 1;
    return;
  }
  if (m.version !== VERSION) {
    console.log(`PES 가 ${m.version === undefined ? "None" : String(m.version)} → ${VERSION} 로 바뀌었습니다 — /pes:setup 으로 다시 점검`);
    process.exitCode = 1;
    return;
  }
  console.log("OK");
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  switch (command) {
    case "check":
      return cmd_check(args);
    case "install":
      return cmd_install(args);
    case "upgrade":
      return cmd_upgrade(args);
    case "keys":
      return cmd_keys(args);
    case "keys-serve":
      return cmd_keys_serve(args);
    case "mark":
      return cmd_mark();
    case "needed":
      return cmd_needed();
    default:
      process.stdout.write(`${DOC}\n`);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof Exit) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.code;
    return;
  }
  throw error;
});

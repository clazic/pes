// pes.ts: the PES home (`home`), the allowed remote origins (`remote`), the screen server probes (`stop`, the status line) — SEL-71.
// The server itself (serve / hub / open) is not started by this file; it only asks the hub ports "who are you" like pes.py does.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative, isAbsolute } from "node:path";

import { Die, bridge, config_path, die, pdir, pes_home, read_config, resolve_path, say, write_config, write_text } from "./cli_support.ts";

/** Hub ports of one PES home (HUB_PORTS in pes.py); 8765~8775 were the per-project servers of older versions. */
export const DEFAULT_HUB_PORTS: readonly number[] = [8760, 8761, 8762, 8763, 8764];

/**
 * The hub port range: 8760~8764, or the inclusive range of PES_HUB_PORTS="<first>-<last>" (a test or a second PES home that must not
 * touch the real ports). A value that is not a range ends the command — silently falling back to the real ports would defeat its purpose.
 */
export function hub_ports(): readonly number[] {
  const given = process.env.PES_HUB_PORTS;
  if (given === undefined || given === "") return DEFAULT_HUB_PORTS;
  const m = given.match(/^\s*(\d{1,5})\s*-\s*(\d{1,5})\s*$/);
  const first = m === null ? 0 : Number(m[1]);
  const last = m === null ? 0 : Number(m[2]);
  if (m === null || first < 1 || last > 65535 || first > last || last - first > 63) {
    die(`PES_HUB_PORTS 는 "<첫 포트>-<끝 포트>" 형식이어야 합니다 (예: 49200-49204, 최대 64개): ${given}`, 1);
  }
  return Array.from({ length: last - first + 1 }, (_x, i) => first + i);
}
const OLD_PORTS: readonly number[] = Array.from({ length: 11 }, (_x, i) => 8765 + i);

/** The ports of the per-project servers of older versions (8765~8775). With an injected hub range nothing of the real range is asked. */
export function legacy_ports(): readonly number[] {
  return process.env.PES_HUB_PORTS !== undefined && process.env.PES_HUB_PORTS !== "" ? [] : OLD_PORTS;
}

/** `GET http://127.0.0.1:<port>/whoami` as JSON, or null when nothing answers (a refused connection is the normal "server off"). */
export async function whoami_info(port: number): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/whoami`, { signal: AbortSignal.timeout(1000) });
    const data: unknown = await response.json();
    return data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function whoami(port: number): Promise<string | null> {
  const root = (await whoami_info(port))?.root;
  return typeof root === "string" ? root : null;
}

async function project_slugs(): Promise<Set<string>> {
  try {
    return new Set(((await bridge("slugs")).slugs as string[] | undefined) ?? []);
  } catch (error) {
    if (error instanceof Die) return new Set();
    throw error;
  }
}

async function is_served(d: string): Promise<boolean> {
  return (await project_slugs()).has(basename(d));
}

/** The server root of `d`: a project's parent (the home), anything else itself. */
export async function serve_root(d: string): Promise<string> {
  return existsSync(join(d, "project.json")) || (await is_served(d)) ? dirname(d) : d;
}

export async function root_port(root: string): Promise<number | null> {
  for (const port of hub_ports()) {
    const info = (await whoami_info(port)) ?? {};
    if (info.root === root && info.single) return port;
  }
  return null;
}

/** The address of `d` (a project or the home) when its server is on, else null. */
export async function server_url(d: string): Promise<string | null> {
  const root = await serve_root(d);
  const port = await root_port(root);
  if (port === null) return null;
  return `http://127.0.0.1:${port}/${d === root ? "" : `${basename(d)}/`}`;
}

/**
 * A pid read from a record file (`.pes-hub-server`, `.pes-server`) is signalled only when it is a safe integer > 1: null / 0 would hit
 * our own process group, -1 every process of the user, 1 init — a stale or hand-made record must never reach those (R1 필수 1).
 */
export function signalable_pid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1;
}

function kill_pid(pid: unknown): boolean {
  if (!signalable_pid(pid)) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/**
 * A server record (`.pes-hub-server` of a home, `.pes-server` of an old per-project server) is only a note: after a crash or a reboot
 * its pid may belong to any other program now. The pid is signalled only when the port the record names (else `fallback_port`, the
 * old `.pes-port`) answers `/whoami` on 127.0.0.1 with exactly `owner` — this home (or this project for an old server). Nothing
 * answering, or another root answering, means the record is stale: nothing is signalled, the caller just forgets the record
 * (final review 1 필수 1; the same rule on Windows, where pids are reused often).
 */
async function kill_recorded(record: Record<string, unknown> | undefined, owner: string, fallback_port?: unknown): Promise<boolean> {
  if (record === undefined || !signalable_pid(record.pid)) return false;
  const port = valid_port(record.port) ?? valid_port(fallback_port);
  if (port === null || (await whoami(port)) !== owner) return false;
  return kill_pid(record.pid);
}

function valid_port(value: unknown): number | null {
  const n = typeof value === "string" && /^\s*\d{1,5}\s*$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

function read_text_quiet(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function read_json_quiet(file: string): Record<string, unknown> | undefined {
  try {
    const data: unknown = JSON.parse(readFileSync(file, "utf8"));
    return data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function unlink_quiet(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // missing_ok
  }
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** True when `d` is a folder inside the PES home (not the home itself): only such a root answered by an old server is ours to stop. */
export function inside_pes_home(d: string): boolean {
  const rel = relative(resolve_path(pes_home()), resolve_path(d));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** The old per-project server (8765~): stop it by its record, forget the record. */
export async function stop_legacy(d: string): Promise<void> {
  await kill_recorded(read_json_quiet(join(d, ".pes-server")), d, read_text_quiet(join(d, ".pes-port")));
  for (const name of [".pes-server", ".pes-port"]) unlink_quiet(join(d, name));
  for (const port of legacy_ports()) {
    if ((await whoami(port)) === d) {
      if (process.platform !== "win32") {
        await pkill(`serve.py ${d} `);
        await pkill(`serve.ts ${d} `);
      }
      break;
    }
  }
}

async function pkill(pattern: string): Promise<void> {
  // only reached when a server really answers on a hub port; a quiet best effort, as in pes.py
  try {
    const { spawnSync } = await import("node:child_process");
    spawnSync("pkill", ["-f", pattern], { stdio: "ignore" });
  } catch {
    // no child process allowed or no pkill: the pid file already had its chance
  }
}

/** Stops the home's server by its pid file; true when no server of that root answers any more. */
export async function stop_server(root: string, old = false): Promise<boolean> {
  const alive = async (): Promise<boolean> => {
    if (old) {
      for (const port of hub_ports()) if ((await whoami(port)) === root) return true;
      return false;
    }
    return (await root_port(root)) !== null;
  };
  const file = join(root, ".pes-hub-server");
  await kill_recorded(read_json_quiet(file), root);
  unlink_quiet(file);
  for (let i = 0; i < 20; i += 1) {
    if (!(await alive())) return true;
    await sleep(100);
  }
  if (process.platform !== "win32") {
    await pkill(`serve.py ${root} `);
    await pkill(`serve.ts ${root} `);
  }
  return !(await alive());
}

// ---------------------------------------------------------------- stop

export async function cmd_stop(args: string[]): Promise<void> {
  const rest = args.filter((a) => a !== "--");
  const d = rest.length > 0 ? pdir(rest[0] as string) : pes_home();
  let root = d;
  if (rest.length > 0 && (existsSync(join(d, "project.json")) || (await is_served(d)))) {
    root = dirname(d);
    await stop_legacy(d);
  }
  await stop_server(root, true);
  say(`서버 종료 (${root} — 이 홈의 모든 프로젝트 화면이 함께 꺼집니다)`);
}

// ---------------------------------------------------------------- remote

export async function cmd_remote(args: string[]): Promise<void> {
  const rest = args.filter((a) => a !== "--");
  const cfg = read_config();
  let cur: string[] = Array.isArray(cfg.trusted_origins) ? (cfg.trusted_origins as unknown[]).map(String) : [];
  if (rest.length === 0 || rest[0] === "list") {
    say(`답을 보낼 수 있는 다른 주소: ${cur.length > 0 ? cur.join(", ") : "없음 (이 컴퓨터의 127.0.0.1·localhost 만)"}`);
    return;
  }
  const op = rest[0] as string;
  const vals = rest.slice(1).map((v) => v.replace(/\/+$/, ""));
  for (const v of vals) {
    if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(v)) die(`주소 형식이 아닙니다: ${v} (예: https://m5.example.ts.net)`, 1);
  }
  if (op === "add") cur = [...cur, ...vals.filter((v) => !cur.includes(v))];
  else if (op === "remove" || op === "rm") cur = cur.filter((v) => !vals.includes(v));
  else if (op === "clear") cur = [];
  else die("사용: remote [list|add <주소>|remove <주소>|clear]", 1);
  cfg.trusted_origins = cur;
  write_config(cfg);
  say(`답을 보낼 수 있는 다른 주소: ${cur.length > 0 ? cur.join(", ") : "없음"}`);
}

// ---------------------------------------------------------------- home

/** The project folders below a home: the ones with an old project.json plus the ones the database serves. */
async function project_dirs(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const slugs = await project_slugs();
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && (existsSync(join(root, e.name, "project.json")) || slugs.has(e.name)))
    .map((e) => join(root, e.name))
    .sort();
}

function inside(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function move_folder(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

export async function cmd_home(args: string[]): Promise<void> {
  const rest = args.filter((a) => a !== "--");
  const cur = pes_home();
  if (rest.length === 0 || (rest[0] as string).startsWith("--")) {
    const source = process.env.PES_HOME ? "PES_HOME 환경변수" : existsSync(config_path()) ? `설정 파일 ${config_path()}` : "기본값";
    say(`PES 홈: ${cur}  (${source}) · 프로젝트 ${(await project_dirs(cur)).length}개`);
    return;
  }
  const next = resolve_path(rest[0] as string);
  const from_at = rest.indexOf("--from");
  const old = from_at >= 0 ? resolve_path(rest[from_at + 1] ?? "") : cur;
  const force = rest.includes("--force");
  if (next === old) {
    say(`이미 PES 홈입니다: ${next}`);
    return;
  }
  if (inside(next, old) || inside(old, next)) die("새 폴더와 옛 폴더가 서로 안에 들어 있으면 옮길 수 없습니다", 1);
  const projects = await project_dirs(old);
  const clash = projects.filter((d) => existsSync(join(next, basename(d)))).map((d) => basename(d));
  if (clash.length > 0) die(`새 폴더에 같은 이름이 이미 있습니다: ${clash.join(", ")} — 아무것도 옮기지 않았습니다`, 1);
  const me = process.env.PES_OWNER ?? "";
  const locks = ((await bridge("live_locks")).locks as Record<string, string> | undefined) ?? {};
  const busy = projects.filter((d) => basename(d) in locks && locks[basename(d)] !== me).map((d) => basename(d));
  if (busy.length > 0 && !force) die(`다른 Claude 세션이 쓰는 프로젝트가 있습니다: ${busy.join(", ")} — 그 세션을 닫고 다시 하거나 --force`, 3);
  for (const d of projects) await stop_legacy(d);
  if (existsSync(old)) await stop_server(old, true);
  mkdirSync(next, { recursive: true });
  const moved: string[] = [];
  for (const d of projects) {
    const target = join(next, basename(d));
    move_folder(d, target);
    moved.push(basename(d));
    const log = join(target, "feedback.log");
    if (existsSync(log)) write_text(log, readFileSync(log, "utf8").split(d).join(target));
    for (const junk of [".pes-port", ".pes-server"]) unlink_quiet(join(target, junk));
  }
  if (existsSync(old)) {
    for (const junk of ["index.html", ".pes-hub", ".pes-hub.out", ".pes-hub-server"]) unlink_quiet(join(old, junk));
    for (const junk of [".DS_Store", "Thumbs.db", "desktop.ini"]) unlink_quiet(join(old, junk));
    if (readdirSync(old).length === 0) rmdirSync(old);
  }
  const cfg = read_config();
  cfg.home = next;
  write_config(cfg);
  say(`PES 홈 변경: ${old} → ${next}  (프로젝트 ${moved.length}개 이동${moved.length > 0 ? `: ${moved.join(", ")}` : ""})`);
  if (process.env.PES_HOME && resolve_path(process.env.PES_HOME) !== next) say("주의: PES_HOME 환경변수가 설정 파일보다 우선합니다 — 환경변수도 바꾸거나 지우세요");
  say("Monitor 가 옛 경로의 feedback.log 를 보고 있었다면 새 경로로 다시 거세요.");
}


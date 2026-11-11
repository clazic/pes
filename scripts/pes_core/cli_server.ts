// pes.ts: the screen server and the places a person looks things up — serve, hub, open, list, watch, which (SEL-77 / PR26b-2).
// The server is scripts/serve.ts started as a detached child (one per PES home, one port, 0.15's contract: <home>/.pes-hub-server =
// {"pid","port"}, /whoami answers {root, single}); this file only starts it, asks it "who are you" and stops it (cli_home.ts).
// Port range: 8760~8764, or PES_HUB_PORTS="<first>-<last>"; PES_NO_BROWSER=1 makes `open` print the address and start nothing.

import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { hub_ports, kill_pid, root_port, server_url, stop_legacy, stop_server, whoami, whoami_info } from "./cli_home.ts";
import { need_project, project_exists, slug_of } from "./cli_records.ts";
import { load_legacy } from "./cli_legacy_read.ts";
import { build_index, fill, legacy_project } from "./cli_screens.ts";
import { LABEL, ROOT, STAGES, Die, arg_at, bridge, bridge_soft, die, expanduser, home_dir, is_record, missing_args, now, pdir, pes_home, resolve_path, say, write_text } from "./cli_support.ts";

type Dict = Record<string, any>;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// ---------------------------------------------------------------- ports and the server process

/** True when something accepts a connection on 127.0.0.1:<port> (the 0.15 `port_busy`). */
function port_busy(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (busy: boolean): void => {
      socket.destroy();
      done(busy);
    };
    socket.setTimeout(1000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Starts scripts/serve.ts for `root` on `port`, detached from this process (its output goes to <root>/.pes-hub.out). */
function spawn_server(root: string, port: number): number {
  const log = openSync(join(root, ".pes-hub.out"), "a");
  try {
    // the node flags this process runs with (the permission allow-list and the guard of a test run) go to the server too; a bare `node scripts/pes.ts` has none
    const child = spawn(process.execPath, [...process.execArgv, join(ROOT, "scripts", "serve.ts"), root, String(port)], {
      detached: true,
      stdio: ["ignore", log, log],
      windowsHide: true,
    });
    child.on("error", () => undefined);
    child.unref();
    if (child.pid === undefined) die("서버를 시작하지 못했습니다 (프로세스를 만들 수 없음)", 1);
    return child.pid;
  } finally {
    closeSync(log);
  }
}

/** The port of the server of `root`: the one that is on, else a new one on the first free hub port. Dies when none is free. */
export async function ensure_server(root: string): Promise<number> {
  mkdirSync(root, { recursive: true });
  const on = await root_port(root);
  if (on !== null) return on;
  const ports = hub_ports();
  for (const port of ports) {
    if ((await whoami(port)) === root) {
      await stop_server(root, true); // a list-only server of an older version
      break;
    }
  }
  let free: number | null = null;
  for (const port of ports) {
    if ((await whoami(port)) === null && !(await port_busy(port))) {
      free = port;
      break;
    }
  }
  if (free === null) return die(`${ports[0]}~${ports[ports.length - 1]} 포트가 모두 사용 중 — 다른 PES 홈의 서버나 다른 프로그램을 끄세요`, 1);
  const pid = spawn_server(root, free);
  const record = join(root, ".pes-hub-server");
  writeFileSync(record, JSON.stringify({ pid, port: free }), "utf8");
  // the server needs a moment to start: wait until it answers as this home's server (or has died)
  for (let i = 0; i < 200; i += 1) {
    if ((await whoami(free)) === root) return free;
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    await sleep(100);
  }
  if ((await whoami(free)) !== root) {
    // the record of a server that never answered would outlive it and point at a pid some other program may get (final review 1 권장 4);
    // SEL-74 G2: the child itself is ended too — a server that cannot answer must not outlive the failed command
    kill_pid(pid);
    rmSync(record, { force: true });
    die(`서버가 시작되지 않았습니다 — ${join(root, ".pes-hub.out")} 를 보세요`, 1);
  }
  return free;
}

// ---------------------------------------------------------------- the project list (hub)

export function projects_root(args: string[]): string {
  let root = args.length > 0 && !(args[0] as string).startsWith("--") ? resolve_path(expanduser(args[0] as string)) : pes_home();
  if (existsSync(join(root, "project.json"))) root = dirname(root);
  return root;
}

function brief_of(slug: string, path: string, p: Dict, npend: number, lock: Dict | null, updated: string, outs: string): Dict {
  const cur = String(p.current ?? "plan");
  const x = (p.stages?.[cur] ?? {}) as Dict;
  const L = LABEL[cur] ?? cur;
  const review = is_record(x.review) ? x.review : null;
  let who: string;
  let todo: string;
  if (p.complete) [who, todo] = ["done", `완료 — 최종 결과물: ${outs}`];
  else if (npend > 0) [who, todo] = ["ai", `받은 답 ${npend}개 처리 대기`];
  else if (x.status === "asking") [who, todo] = ["you", `${L} 시작 질문에 답하기`];
  else if (x.status === "active" && review !== null && Object.keys(review).length > 0 && Number(review.round || 0) === x.round) {
    [who, todo] = ["you", `${L} R${x.round} 결과 확인 · 점검 질문 ${Array.isArray(review.questions) ? review.questions.length : 0}개에 답하기`];
  } else if (x.status === "active") [who, todo] = ["ai", `${L} R${x.round || 1} 작업 중`];
  else [who, todo] = ["you", `${L} 시작`];
  return {
    slug,
    path,
    topic: p.topic ?? slug,
    created: p.created ?? "",
    current: cur,
    stages: STAGES.map(([key, label]) => {
      const st = (p.stages?.[key] ?? {}) as Dict;
      return { key, label, status: st.status, round: st.round, stale: st.stale ?? null, reports: (Array.isArray(st.reports) ? st.reports : []).map((r: Dict) => r.format) };
    }),
    complete: Boolean(p.complete),
    who,
    todo,
    pending: npend,
    updated,
    lock,
  };
}

/** 0.15 `time.strftime("%Y-%m-%d %H:%M", localtime)`. */
function stamp(ms: number): string {
  const d = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** An old project.json folder the database does not serve (not migrated, or staging / failed / archived): read from its file, once. */
function legacy_brief(root: string, slug: string): Dict {
  const d = join(root, slug);
  try {
    const state = load_legacy(d);
    const times = [join(d, "project.json"), ...state.pending.map((x) => x.name)].map((p) => {
      try {
        return statSync(p).mtimeMs;
      } catch {
        return 0;
      }
    });
    const outs = existsSync(join(d, "out")) ? readdirSync(join(d, "out"), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort().join(", ") : "-";
    return brief_of(slug, d, legacy_project(state.project) as Dict, state.pending.length, null, stamp(Math.max(...times)), outs === "" ? "-" : outs);
  } catch (error) {
    if (!(error instanceof Die)) throw error;
    return { slug, topic: slug, error: error.message.slice(0, 200), stages: [], who: "err", todo: "읽기 실패 — 폴더를 확인하세요" };
  }
}

/** The projects of a home: the ones the database serves; an old project.json folder the database does not serve yet is listed as an error row. */
export async function all_briefs(root: string): Promise<Dict[]> {
  const out: Dict[] = [];
  const at_home = existsSync(root) && resolve_path(root) === pes_home();
  // active_slugs leaves out the project that only holds the owner of a fresh database (OWNER_STUB_SLUG, made by `migrate`)
  const served = new Set<string>(at_home ? (((await bridge("active_slugs")).slugs as string[] | undefined) ?? []) : []);
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!entry.isDirectory() || served.has(entry.name) || !existsSync(join(root, entry.name, "project.json"))) continue;
      out.push(legacy_brief(root, entry.name));
    }
  }
  for (const slug of [...served].sort()) {
    const data = await bridge_soft("read_project", slug);
    if (data === undefined) {
      out.push({ slug, topic: slug, error: "DB 읽기 실패", stages: [], who: "err", todo: "읽기 실패" });
      continue;
    }
    const lock = data.lock as Dict | null | undefined;
    out.push(
      brief_of(slug, join(root, slug), data.project as Dict, ((data.pending as unknown[] | undefined) ?? []).length, lock === null || lock === undefined ? null : lock, String(data.updated ?? ""), "-"),
    );
  }
  const rank: Record<string, number> = { you: 0, ai: 1, err: 2, done: 3 };
  out.sort((a, b) => (String(a.updated ?? "") < String(b.updated ?? "") ? 1 : String(a.updated ?? "") > String(b.updated ?? "") ? -1 : 0));
  out.sort((a, b) => (rank[a.who] ?? 9) - (rank[b.who] ?? 9));
  return out;
}

/** The home page of the projects the database serves, built on every request. */
export async function db_hub_html(root: string): Promise<string> {
  const briefs = await all_briefs(root);
  return fill("hub.html", "PES 프로젝트", { projects: briefs, root, built: now(), stages: STAGES.map(([key, label]) => ({ key, label })) });
}

export async function build_hub(root: string): Promise<string> {
  const briefs = await all_briefs(root);
  const data = { projects: briefs, root, built: now(), stages: STAGES.map(([key, label]) => ({ key, label })) };
  const file = join(root, "index.html");
  write_text(file, fill("hub.html", "PES 프로젝트", data));
  write_text(join(root, ".pes-hub"), "1");
  return file;
}

export async function cmd_list(args: string[]): Promise<void> {
  const root = projects_root(args);
  const briefs = await all_briefs(root);
  if (briefs.length === 0) {
    say(`프로젝트 없음: ${root}`);
    return;
  }
  const W: Record<string, string> = { you: "내 차례", ai: "Claude", done: "완료", err: "오류" };
  const url = await server_url(root);
  briefs.forEach((b, k) => {
    const cur = (b.stages as Dict[]).find((x) => x.key === b.current);
    say(`${k + 1}. [${W[b.who] ?? b.who}] ${b.topic}  (${b.slug})`);
    say(`   ${cur !== undefined ? `${cur.label} R${cur.round}` : "-"} · ${b.todo} · 갱신 ${b.updated ?? ""} · ${url !== null ? `${url}${b.slug}/` : "서버 꺼짐"}${b.lock ? ` · 사용 중 세션 ${b.lock.owner}` : ""}`);
  });
}

// ---------------------------------------------------------------- serve, hub, open

export async function cmd_serve(args: string[]): Promise<void> {
  const d = pdir(arg_at(args, 0, "serve"));
  const slug = await need_project(d, "serve");
  await stop_legacy(d);
  if (!existsSync(join(d, "index.html"))) await build_index(d, slug);
  const root = dirname(d);
  if (existsSync(join(root, ".pes-hub")) || !existsSync(join(root, "index.html"))) await build_hub(root);
  const port = await ensure_server(root);
  say(`http://127.0.0.1:${port}/${slug_of(d)}/`);
}

export async function cmd_hub(args: string[]): Promise<void> {
  const root = projects_root(args);
  mkdirSync(root, { recursive: true });
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const d = join(root, entry.name);
    if (existsSync(join(d, ".pes-server")) || existsSync(join(d, ".pes-port"))) await stop_legacy(d);
  }
  await build_hub(root);
  await ensure_server(root);
  say((await server_url(root)) ?? `http://127.0.0.1:${(await root_port(root)) ?? ""}/`);
}

/** The default browser, started and let go (macOS `open`, Windows `start`, elsewhere `xdg-open`). A failure is not an error: the address is printed anyway. */
function open_browser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // no browser to start (or a child process is not allowed here)
  }
}

export async function cmd_open(args: string[]): Promise<void> {
  let target = arg_at(args, 0, "open");
  if (!target.startsWith("http")) {
    const d = pdir(target);
    const url = await server_url(d);
    if (url !== null) target = url;
    else {
      // without a server the dashboard is opened as a file: the file is the database's state at the moment of opening
      if (await project_exists(d)) {
        try {
          await build_index(d, slug_of(d));
        } catch (error) {
          if (!(error instanceof Die) && !(error as NodeJS.ErrnoException).code) throw error;
        }
      }
      target = pathToFileURL(join(d, "index.html")).href;
    }
  }
  if (process.env.PES_NO_BROWSER !== "1") open_browser(target);
  say(target);
}

// ---------------------------------------------------------------- watch, which

const SHELL_SAFE = /^[\w@%+=:,./~-]+$/u;

function shell_quote(text: string): string {
  return SHELL_SAFE.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

export async function cmd_watch(args: string[]): Promise<void> {
  const d = pdir(arg_at(args, 0, "watch"));
  if (!existsSync(join(d, "project.json")) && !(await project_exists(d))) die(`project.json 없음: ${d}`, 1);
  say(`tail -n0 -F ${shell_quote(join(d, "feedback.log"))} | grep --line-buffered FEEDBACK`);
}

function is_executable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Python's `shutil.which`: the PATH folders in order (on Windows with the PATHEXT endings), no child process. */
export function which_in_path(name: string): string | null {
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter((x) => x !== "");
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((x) => x !== "") : [""];
  const has_ext = process.platform === "win32" && exts.some((e) => name.toLowerCase().endsWith(e.toLowerCase()));
  for (const dir of dirs) {
    for (const ext of has_ext ? [""] : exts) {
      const file = join(dir, `${name}${ext}`);
      if (is_executable(file)) return file;
    }
  }
  return null;
}

function exists_quiet(file: string): boolean {
  try {
    return existsSync(file);
  } catch {
    return false;
  }
}

/** pes.py `find_tool`: PATH, then the places the installers put a tool. */
export function find_tool(name: string): string | null {
  const found = which_in_path(name);
  if (found !== null) return found;
  const H = home_dir();
  const candidates = [join(H, ".local", "bin", name)];
  if (process.platform === "darwin") {
    candidates.push(join("/opt/homebrew/bin", name), join("/usr/local/bin", name));
    if (name === "vworld") candidates.push(join(H, ".claude", "skills", "vworld", "app", "vworld-macos"));
  }
  if (process.platform === "win32") {
    const la = process.env.LOCALAPPDATA ?? join(H, "AppData", "Local");
    const ap = process.env.APPDATA ?? join(H, "AppData", "Roaming");
    candidates.push(
      join(la, "Programs", name, `${name}.exe`),
      join(la, name, `${name}.exe`),
      join(H, ".local", "bin", `${name}.exe`),
      join(ap, "npm", `${name}.cmd`),
      join(la, "Programs", "ego lite", `${name}.exe`),
    );
    if (name === "vworld") candidates.push(join(H, ".claude", "skills", "vworld", "app", "vworld-windows.exe"));
  }
  return candidates.find(exists_quiet) ?? null;
}

export function cmd_which(args: string[]): Promise<void> {
  const name = args[0] === undefined ? missing_args("which") : args[0];
  const tool = find_tool(name);
  if (tool === null) die(`${name} 를 찾지 못함 — /pes:doctor 로 설치 상태 확인`, 1);
  say(tool);
  return Promise.resolve();
}


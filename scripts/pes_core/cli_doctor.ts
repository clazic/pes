// pes.ts doctor (SEL-77 / PR26b-2): the diagnosis of 0.15's `pes.py doctor` — environment, tools, server, one group per project.
// Same groups, levels, titles and details as 0.15 (D08: the Python row is a Node row — PES TS runs no Python — and the template check
// is the TS runtime's). Reading only, unless --fix: the safe repairs (a missing home folder, a stale dashboard, old server records).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";

import { hub_ports, inside_pes_home, legacy_ports, root_port, server_url, stop_legacy, whoami, whoami_info } from "./cli_home.ts";
import { build_hub, find_tool, which_in_path } from "./cli_server.ts";
import { build_index } from "./cli_screens.ts";
import {
  KEYS,
  LABEL,
  TPL,
  ROOT,
  bridge,
  bridge_soft,
  config_path,
  home_dir,
  is_record,
  pdir,
  pes_home,
  py_json_error,
  read_config,
  resolve_path,
  say,
} from "./cli_support.ts";

type Dict = Record<string, any>;
type Level = "ok" | "info" | "warn" | "bad";

interface Row {
  group: string;
  level: Level;
  title: string;
  detail: string;
  fix?: () => void | Promise<void>;
  /** an old project.json project: the repair is shown but --fix leaves it alone */
  ro?: boolean;
  fixed?: boolean;
  skipped?: string;
}

class Report {
  readonly rows: Row[] = [];
  no_fix = false;
  ro = false;
  add(group: string, level: Level, title: string, detail = "", fix?: () => void | Promise<void>): void {
    const f = this.no_fix ? undefined : fix;
    const row: Row = { group, level, title, detail };
    if (f !== undefined) row.fix = f;
    if (this.ro && f !== undefined) row.ro = true;
    this.rows.push(row);
  }
}

function run_quiet(cmd: string, args: string[], timeout = 15): [number, string] {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeout * 1000, windowsHide: true });
    if (r.error !== undefined) return [-1, r.error.message];
    return [r.status ?? -1, `${r.stdout ?? ""}${r.stderr ?? ""}`];
  } catch (error) {
    return [-1, (error as Error).message];
  }
}

function exists(file: string): boolean {
  try {
    return existsSync(file);
  } catch {
    return false;
  }
}

/** True only when the file is certainly not there; a refusal to look (a permission) is not "missing". */
function missing_for_sure(file: string): boolean {
  try {
    accessSync(file, constants.F_OK);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR";
  }
}

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function read_text_quiet(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- environment and tools

function skill_version(name: string): string | null {
  const dir = join(home_dir(), ".claude", "skills", name);
  if (!exists(join(dir, "SKILL.md"))) return null;
  const norm = (v: string): string => (v.startsWith("v") ? v : `v${v}`);
  if (name === "kosis") {
    const text = read_text_quiet(join(dir, "VERSION"));
    return text === null ? "?" : norm(text.trim());
  }
  if (name === "vworld") {
    const exe = join(dir, "app", process.platform === "win32" ? "vworld-windows.exe" : process.platform === "darwin" ? "vworld-macos" : "vworld-linux");
    if (exists(exe)) {
      const [, out] = run_quiet(exe, ["--version"], 30);
      const m = out.match(/(\d+\.\d+\.\d+)/);
      return m === null ? "?" : norm(m[1] as string);
    }
  }
  return "?";
}

function doctor_env(R: Report, net: boolean): void {
  const major = Number(process.versions.node.split(".")[0]);
  R.add("환경", major >= 26 ? "ok" : "bad", `Node ${process.versions.node}`, major >= 26 ? "" : "26 이상 필요");
  R.add("환경", "ok", `PES 플러그인 ${ROOT}`, "");
  const missing = ["dashboard.html", "ask.html", "_questions.html", "hub.html", "stage-report.html", "eli5.html", "final-report.html"].filter((t) => !exists(join(TPL, t)));
  R.add("환경", missing.length > 0 ? "bad" : "ok", "템플릿", missing.length > 0 ? `없음: ${missing.join(", ")}` : "");
  const h = pes_home();
  const src = process.env.PES_HOME ? "PES_HOME 환경변수" : exists(config_path()) ? "설정 파일" : "기본값";
  if (!exists(h)) {
    R.add("환경", "warn", `PES 홈 ${h} (${src})`, "폴더가 아직 없음 — 첫 /pes:start 때 생김", () => void mkdirSync(h, { recursive: true }));
  } else {
    const ok = writable(h);
    R.add("환경", ok ? "ok" : "bad", `PES 홈 ${h} (${src})`, ok ? "" : "쓰기 권한 없음");
    const cloud = ["OneDrive", "CloudStorage", "iCloud", "Mobile Documents", "Dropbox", "Google Drive"].find((c) => h.toLowerCase().includes(c.toLowerCase()));
    if (cloud !== undefined) {
      R.add("환경", "info", `PES 홈이 클라우드 동기화 폴더(${cloud}) 안에 있음`, "한 번에 한 컴퓨터에서만 작업, 폴더는 '항상 이 장치에 유지', 다른 컴퓨터로 옮기기 전 동기화 완료 확인 (README 「OneDrive」)");
    }
  }
  if (exists(config_path())) {
    const text = read_text_quiet(config_path());
    const broken = text === null ? "읽을 수 없음" : py_json_error(text);
    if (broken !== null) R.add("환경", "bad", "설정 파일 읽기 실패", `${config_path()}: ${broken}`);
    else {
      const cfg = read_config();
      if (process.env.PES_HOME && typeof cfg.home === "string" && cfg.home !== "" && resolve_path(cfg.home) !== h) {
        R.add("환경", "warn", "PES_HOME 환경변수와 설정 파일이 다름", `환경변수가 우선: ${h} (설정 파일: ${cfg.home})`);
      }
    }
  }
  if (!process.env.PES_OWNER) R.add("환경", "warn", "PES_OWNER 없음", "Claude 세션 표시가 없어 잠금이 동작하지 않음 (pes:core 「여러 프로젝트」)");
  doctor_tools(R, net);
}

function doctor_tools(R: Report, net: boolean): void {
  let t = find_tool("ego-browser");
  if (t !== null) {
    const [, out] = run_quiet(t, ["--version"]);
    const words = out.split(/\s+/).filter((x) => x !== "");
    R.add("도구", "ok", `ego-browser ${words.length > 1 ? words[1] : ""}`.trim(), which_in_path("ego-browser") !== null ? "" : `PATH 밖: ${t}`);
    const sk = join(home_dir(), ".claude", "skills", "ego-browser", "SKILL.md");
    if (exists(sk)) {
      const m = (read_text_quiet(sk) ?? "").match(/version:\s*"?([\d.]+)/);
      R.add("도구", "ok", "ego-browser 스킬", `v${m === null ? "?" : m[1]}`);
    } else {
      R.add("도구", "warn", "ego-browser 스킬", "스킬 연결이 없음 — ego lite 앱을 열어 첫 실행 안내(온보딩)를 다시 진행하면 연결된다. PES 는 `ego-browser skill` 출력으로도 쓸 수 있다");
    }
  } else {
    R.add("도구", "warn", "ego-browser 없음", "브라우저 조사 불가 — ego-browser 스킬의 설치 안내");
  }
  t = find_tool("kosis");
  if (t !== null) {
    const [, out] = run_quiet(t, ["config", "key-list"]);
    const n = (out.match(/^\s*\[\d+\]/gm) ?? []).length;
    R.add("도구", n > 0 || process.env.KOSIS_API_KEY ? "ok" : "warn", `kosis (API 키 ${n}개)`, n > 0 ? (which_in_path("kosis") !== null ? "" : `PATH 밖: ${t}`) : "키 없음 — https://kosis.kr/openapi/");
  } else {
    R.add("도구", "warn", "kosis 없음", "통계 API 불가 — npm install -g @clazic/kosis");
  }
  for (const name of ["kosis", "vworld"]) {
    const sv = skill_version(name);
    const tool = find_tool(name);
    if (tool !== null && sv === null) R.add("도구", "warn", `${name} 스킬 없음`, "CLI 만 있음 — /pes:setup 이 스킬을 설치");
    else if (sv !== null) {
      const cv = tool === null ? null : run_quiet(tool, ["--version"])[1].match(/v?(\d+\.\d+\.\d+)/);
      if (cv !== null && sv !== "?" && sv !== `v${cv[1]}`) R.add("도구", "warn", `${name} 스킬 ${sv} ≠ CLI v${cv[1]}`, "/pes:setup 으로 맞추기");
      else R.add("도구", "ok", `${name} 스킬 ${sv}${cv !== null ? " (CLI 와 같음)" : ""}`, "");
    }
  }
  t = find_tool("korean-law");
  if (t !== null) {
    let from_settings: unknown = null;
    try {
      const settings = JSON.parse(readFileSync(join(home_dir(), ".claude", "settings.json"), "utf8")) as Dict;
      from_settings = is_record(settings.env) ? settings.env.LAW_OC : null;
    } catch {
      from_settings = null;
    }
    if (process.env.LAW_OC) R.add("도구", "ok", "korean-law (LAW_OC 있음)", "");
    else if (from_settings) R.add("도구", "info", "korean-law (LAW_OC: Claude Code 설정에 등록됨)", "새 Claude Code 세션부터 적용 — 지금 세션은 다시 시작해야 함");
    else R.add("도구", "warn", "korean-law", "LAW_OC 없음 — ~/.claude/settings.json 의 env 에 LAW_OC 를 등록 (Windows 포함 모든 세션에 적용)");
  } else {
    R.add("도구", "warn", "korean-law 없음", "법령 조회 불가");
  }
  t = find_tool("vworld");
  if (t !== null) {
    const [, out] = run_quiet(t, ["config", "list-keys"]);
    const n = out.split('"masked"').length - 1;
    R.add("도구", n > 0 ? "ok" : "warn", `vworld (키 ${n}개)`, n > 0 ? (which_in_path("vworld") !== null ? "" : `PATH 밖: ${t}`) : "키 없음");
  } else {
    R.add("도구", "info", "vworld 없음", "공간정보가 필요할 때만 (조사 시작 질문에서 설치 여부를 묻는다)");
  }
  const ca = process.env.NODE_EXTRA_CA_CERTS;
  if (ca && missing_for_sure(ca)) R.add("도구", "bad", "NODE_EXTRA_CA_CERTS 파일 없음", ca);
  if (net) {
    const law = find_tool("korean-law");
    if (law !== null) {
      const [, out] = run_quiet(law, ["search_law", "--query", "민법"], 40);
      const ok = out.includes("검색 결과");
      const last = out.trim().split(/\r?\n/).pop() ?? "";
      R.add("연결", ok ? "ok" : "bad", "법령 API (law.go.kr)", ok ? "" : out.includes("CERT") ? "인증서 오류 — 회사·기관 망이면 NODE_EXTRA_CA_CERTS 에 루트 인증서 파일을 등록 (~/.claude/settings.json env)" : last !== "" ? last.slice(0, 160) : "응답 없음");
    }
    const kosis = find_tool("kosis");
    if (kosis !== null) {
      const [code, out] = run_quiet(kosis, ["s", "인구", "-n", "1"], 40);
      const last = out.trim().split(/\r?\n/).pop() ?? "";
      R.add("연결", code === 0 ? "ok" : "bad", "통계 API (kosis.kr)", code === 0 ? "" : last !== "" ? last.slice(0, 160) : "응답 없음");
    }
  }
  // the screen's answers are followed by a `tail -F … | grep` the Monitor runs: missing is a warning, the program itself needs neither
  for (const tool of ["tail", "grep"]) {
    if (which_in_path(tool) === null) R.add("도구", "warn", `${tool} 없음`, "답 자동 수신(Monitor)에 필요 — Windows는 Git Bash");
  }
}

// ---------------------------------------------------------------- servers

/** { port: [[pid, name]] } of the programs listening on `ports`; asked once, no connection is made to them (a program that is surprised by one may die). */
function listening_owners(ports: readonly number[]): Map<number, Array<[string, string]>> {
  const found = new Map<number, Array<[string, string]>>();
  const add = (port: number, pid: string, name: string): void => {
    if (!ports.includes(port)) return;
    const list = found.get(port) ?? [];
    if (!list.some(([p, n]) => p === pid && n === name)) list.push([pid, name]);
    found.set(port, list);
  };
  const lo = Math.min(...ports);
  const hi = Math.max(...ports);
  try {
    if (process.platform === "darwin" && which_in_path("lsof") !== null) {
      const [, out] = run_quiet("lsof", ["-nP", `-iTCP:${lo}-${hi}`, "-sTCP:LISTEN", "-Fpcn"], 20);
      let pid: string | null = null;
      let name = "";
      for (const line of out.split(/\r?\n/)) {
        if (line.startsWith("p") && /^\d+$/.test(line.slice(1))) [pid, name] = [line.slice(1), ""];
        else if (line.startsWith("c") && pid !== null) name = line.slice(1);
        else if (line.startsWith("n") && pid !== null) {
          const m = line.match(/:(\d+)$/);
          if (m !== null) add(Number(m[1]), pid, name);
        }
      }
    } else if (process.platform === "win32" && which_in_path("netstat") !== null) {
      const [, out] = run_quiet("netstat", ["-ano", "-p", "TCP"], 15);
      for (const m of out.matchAll(/^\s*TCP\s+\S+:(\d+)\s+(?:0\.0\.0\.0:0|\[::\]:0)\s+\S+\s+(\d+)/gm)) {
        let name = "";
        if (which_in_path("tasklist") !== null) {
          const tm = run_quiet("tasklist", ["/FI", `PID eq ${m[2]}`, "/FO", "CSV", "/NH"], 10)[1].trim().match(/^"([^"]+)"/);
          name = tm === null ? "" : (tm[1] as string);
        }
        add(Number(m[1]), m[2] as string, name);
      }
    } else if (process.platform !== "win32" && which_in_path("ss") !== null) {
      const [, out] = run_quiet("ss", ["-ltnpH"], 10);
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/:(\d+)\s/);
        if (m === null) continue;
        for (const um of line.matchAll(/\("([^"]+)",pid=(\d+)/g)) add(Number(m[1]), um[2] as string, um[1] as string);
      }
    }
  } catch {
    return new Map();
  }
  return found;
}

function port_owner_text(owners: Array<[string, string]> | undefined): string {
  if (owners === undefined || owners.length === 0) return "PES 가 아닌 프로그램이 쓰는 중 — 소유 프로세스 확인 불가 (lsof·ss·netstat 이 없거나 권한이 없음)";
  return `PES 가 아닌 프로그램이 쓰는 중 — 소유 프로세스 ${owners.map(([pid, name]) => `pid ${pid}${name !== "" ? ` (${name})` : ""}`).join(", ")}`;
}

async function port_in_use(port: number): Promise<boolean> {
  const { createConnection } = await import("node:net");
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

async function doctor_server(R: Report, h: string): Promise<void> {
  const ports = hub_ports();
  const hubs: Array<[number, string | null]> = [];
  for (const pt of ports) hubs.push([pt, await whoami(pt)]);
  for (const [pt, root] of hubs) {
    if (root !== null && !exists(root)) R.add("서버", "warn", `:${pt} 고아 서버`, `폴더가 없는 서버가 떠 있음: ${root} — 필요 없으면 끄세요`);
    else if (root !== null && resolve_path(root) !== h) R.add("서버", "info", `:${pt} 다른 폴더를 서빙 중`, root);
    else if (root !== null && !(await whoami_info(pt))?.single) R.add("서버", "warn", `:${pt} 예전 방식 목록 서버`, "프로젝트 화면이 안 열림 — /pes:list 로 다시 켜면 바뀜");
  }
  const old: Array<[number, string]> = [];
  for (const pt of legacy_ports()) {
    const r = await whoami(pt);
    if (r !== null) old.push([pt, r]);
  }
  if (old.length > 0) {
    R.add("서버", "warn", `예전 방식 프로젝트별 서버 ${old.length}개`, `${old.map(([pt]) => `:${pt}`).join(", ")} — 이제 포트 하나로 충분`, async () => {
      // any local program can answer /whoami with any path: only a root inside the PES home is an old PES server to stop (R1 권장 9)
      for (const [, r] of old) if (inside_pes_home(r)) await stop_legacy(r);
    });
  }
  const free_ports: number[] = [];
  const busy_ports: number[] = [];
  for (const [pt, root] of hubs) {
    if (root !== null) continue;
    if (await port_in_use(pt)) busy_ports.push(pt);
    else free_ports.push(pt);
  }
  if (busy_ports.length > 0) {
    const owners = listening_owners(ports);
    for (const pt of busy_ports) R.add("서버", "warn", `:${pt} 다른 프로그램이 사용 중`, port_owner_text(owners.get(pt)));
  }
  const on = await root_port(h);
  if (on === null && free_ports.length === 0) R.add("서버", "bad", `포트 ${ports[0]}~${ports[ports.length - 1]} 모두 사용 중`, "다른 프로그램이 쓰고 있음");
  R.add("서버", on !== null ? "ok" : "info", `PES 서버 ${on !== null ? `http://127.0.0.1:${on}/ (목록과 모든 프로젝트)` : "꺼짐"}`, on !== null ? "" : "/pes:list 로 켜기");
}

// ---------------------------------------------------------------- projects

function describe_stage_order(R: Report, tag: string, p: Dict): void {
  const cur = p.current;
  if (!KEYS.includes(cur)) {
    R.add(tag, "bad", "현재 단계 값이 잘못됨", String(cur));
    return;
  }
  const ci = KEYS.indexOf(cur);
  for (const k of KEYS.slice(0, ci)) {
    if (p.stages?.[k]?.status !== "approved") R.add(tag, "warn", `${LABEL[k]}이(가) 승인되지 않았는데 뒤 단계가 현재`, `${LABEL[k]}: ${p.stages?.[k]?.status}`);
  }
  for (const k of KEYS.slice(ci + 1)) {
    const st = p.stages?.[k];
    if ((st?.status === "active" || st?.status === "approved") && !st?.stale) R.add(tag, "warn", `${LABEL[k]}이(가) 현재 단계보다 앞서 있음`, String(st.status));
  }
}

function report_formats(p: Dict): string[] {
  const f = is_record(p.settings) ? p.settings.stage_reports : undefined;
  return Array.isArray(f) && f.length > 0 ? f.map(String) : ["md", "html", "eli5"];
}

async function doctor_project_db(R: Report, d: string, h: string): Promise<void> {
  const tag = d.split(/[\\/]/).pop() as string;
  const data = await bridge_soft("read_project", tag);
  if (data === undefined) {
    R.add(tag, "bad", "DB 에서 프로젝트를 읽지 못함", "");
    return;
  }
  const p = data.project as Dict;
  const pend = (data.pending as unknown[]) ?? [];
  R.add(tag, "ok", String(p.topic ?? ""), `현재 ${LABEL[p.current] ?? String(p.current)}`);
  describe_stage_order(R, tag, p);
  for (const k of KEYS) {
    const st = (p.stages?.[k] ?? {}) as Dict;
    if (st.status === "approved") {
      const reps = Array.isArray(st.reports) ? st.reports : [];
      if (reps.length === 0) R.add(tag, "warn", `${LABEL[k]} 승인됐는데 단계 보고서 없음`, `report ${tag} ${k}`);
      else {
        const want = new Set(report_formats(p));
        for (const r of reps) want.delete(String((r as Dict).format));
        if (want.size > 0) R.add(tag, "info", `${LABEL[k]} 보고서 형식 빠짐`, [...want].sort().join(", "));
      }
    }
  }
  if (pend.length > 0) R.add(tag, "warn", `처리 안 한 답 ${pend.length}개`, `/pes:run ${tag}`);
  const lock = data.lock as Dict | null | undefined;
  if (lock !== null && lock !== undefined && lock.owner !== process.env.PES_OWNER) {
    R.add(tag, "info", "다른 세션이 사용 중", `${Array.from(String(lock.owner)).slice(0, 8).join("")}… · ${lock.since}부터`);
  }
  for (const name of [".pes-port", ".pes-server"]) {
    if (exists(join(d, name))) R.add(tag, "info", `예전 방식 서버 기록 파일 ${name}`, "", () => stop_legacy(d));
  }
  const index = join(d, "index.html");
  let stale = !exists(index);
  if (!stale) stale = statSync(index).mtimeMs + 1000 < Number(data.updated_ms ?? 0);
  if (stale) R.add(tag, "info", "대시보드가 최신 상태보다 오래됨", "", async () => void (await build_index(d, tag)));
  const url = await server_url(d);
  R.add(tag, url !== null ? "ok" : "info", `대시보드 ${url ?? "서버 꺼짐"}`, url !== null ? "" : `/pes:status ${tag}`);
  void h;
}

/** An old project.json project the database does not serve (yet): diagnosed from the file, never written, never repaired by --fix. */
function doctor_project_legacy(R: Report, d: string): void {
  const tag = d.split(/[\\/]/).pop() as string;
  const text = read_text_quiet(join(d, "project.json"));
  const broken = text === null ? "읽을 수 없음" : py_json_error(text);
  if (broken !== null || text === null) {
    R.add(tag, "bad", "project.json 읽기 실패", (broken ?? "읽을 수 없음").slice(0, 200));
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    R.add(tag, "bad", "project.json 읽기 실패", "지원하지 않는 값(NaN·Infinity)이 있습니다");
    return;
  }
  if (!is_record(parsed)) {
    R.add(tag, "bad", "project.json 읽기 실패", "project.json 은 JSON 객체여야 합니다");
    return;
  }
  const p = parsed as Dict;
  R.add(tag, "ok", String(p.topic ?? ""), `현재 ${LABEL[p.current] ?? String(p.current)}`);
  // SEL-74 C: guidance only — never fixable (--fix does not migrate; only the user does)
  R.add(tag, "warn", "이전 필요 — 새 형식으로 옮기지 않은 0.15 프로젝트", `읽기만 됩니다. 쓰려면 먼저 이전하세요: pes migrate ${tag}`);
  R.ro = true;
  try {
    const stale_tmp = readdirSync(d).filter((n) => /^project\.json\.tmp/.test(n)).sort();
    if (stale_tmp.length > 0) R.add(tag, "warn", "저장 중 끊긴 임시 파일", stale_tmp.join(", "), () => stale_tmp.forEach((n) => unlinkSync(join(d, n))));
  } finally {
    R.ro = false;
  }
  if (is_record(p.stages)) describe_stage_order(R, tag, p);
}

// ---------------------------------------------------------------- doctor

export async function cmd_doctor(args: string[]): Promise<void> {
  const net = args.includes("--net");
  const fix = args.includes("--fix");
  const as_json = args.includes("--json");
  const tgt = args.filter((a) => !a.startsWith("--"));
  const R = new Report();
  doctor_env(R, net);
  const h = pes_home();
  const st = await bridge_soft("db_status");
  if (st === undefined) R.add("데이터베이스", "bad", "데이터베이스를 점검하지 못함", "코어를 실행하지 못했습니다");
  else if (st.state === "broken") R.add("데이터베이스", "bad", "데이터베이스를 열 수 없음", `${String(st.message ?? "")} — doctor 는 DB 를 고치지 않습니다. 백업에서 복원하거나 파일을 옮겨 두고 다시 시작하세요`);
  else if (st.state !== "missing" && !st.schema_current) R.add("데이터베이스", "warn", "데이터베이스 스키마가 최신이 아님", "새 코어 버전으로 DB 를 올려야 합니다");
  await doctor_server(R, h);
  const served = new Set<string>(((await bridge_soft("active_slugs"))?.slugs as string[] | undefined) ?? []);
  let dirs: string[];
  if (tgt.length > 0) dirs = [pdir(tgt[0] as string)];
  else {
    const names = new Set<string>(served);
    if (exists(h)) for (const e of readdirSync(h, { withFileTypes: true })) if (e.isDirectory() && exists(join(h, e.name, "project.json"))) names.add(e.name);
    dirs = [...names].sort().map((n) => join(h, n));
  }
  for (const d of dirs) {
    const name = d.split(/[\\/]/).pop() as string;
    if (served.has(name)) {
      await doctor_project_db(R, d, h);
      continue;
    }
    if (!exists(join(d, "project.json"))) {
      R.add(name, "bad", "project.json 없음", d);
      continue;
    }
    doctor_project_legacy(R, d);
  }
  if (tgt.length === 0 && exists(h)) {
    const stray = readdirSync(h, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !exists(join(h, e.name, "project.json")) && !e.name.startsWith(".") && !served.has(e.name))
      .map((e) => e.name)
      .sort();
    if (stray.length > 0) R.add("환경", "info", "PES 홈에 프로젝트가 아닌 폴더", stray.join(", "));
  }
  const fixed: string[] = [];
  if (fix) {
    for (const r of R.rows) {
      if (r.fix !== undefined && r.ro === true) r.skipped = "이전 전 프로젝트라 고치지 않음 — 먼저 이전하세요";
      else if (r.fix !== undefined) {
        try {
          await r.fix();
          r.fixed = true;
          fixed.push(`${r.group}: ${r.title}`);
        } catch (error) {
          r.detail += ` (고치기 실패: ${(error as Error).message})`;
        }
      }
    }
    if (exists(join(h, ".pes-hub"))) {
      try {
        await build_hub(h);
      } catch {
        // the hub page is a view, not a state
      }
    }
  }
  const bad = R.rows.some((r) => r.level === "bad");
  if (as_json) {
    say(
      JSON.stringify(
        R.rows.map((r) => {
          const out: Dict = { group: r.group, level: r.level, title: r.title, detail: r.detail, fixable: r.fix !== undefined };
          if (r.fixed) out.fixed = true;
          if (r.skipped !== undefined) out.skipped = r.skipped;
          return out;
        }),
        null,
        1,
      ),
    );
    return; // 0.15: --json ends with exit 0 whatever the rows say
  }
  const MARK: Record<Level, string> = { ok: "[정상]", info: "[참고]", warn: "[주의]", bad: "[문제]" };
  let last: string | null = null;
  for (const r of R.rows) {
    if (r.group !== last) {
      say(`\n■ ${r.group}`);
      last = r.group;
    }
    const tail = r.fixed ? " → 고침" : r.skipped !== undefined ? ` (${r.skipped})` : r.fix !== undefined && r.ro ? " (이전 후 --fix 로 고칠 수 있음)" : r.fix !== undefined ? " (--fix 로 고칠 수 있음)" : "";
    say(`  ${MARK[r.level]} ${r.title}${r.detail !== "" ? ` — ${r.detail}` : ""}${tail}`);
  }
  const cnt = (level: Level): number => R.rows.filter((r) => r.level === level).length;
  const nfix = R.rows.filter((r) => r.fix !== undefined && !r.fixed && !r.ro).length;
  const nlater = R.rows.filter((r) => r.fix !== undefined && r.ro).length;
  say(`\n요약: 문제 ${cnt("bad")} · 주의 ${cnt("warn")} · 참고 ${cnt("info")} · 정상 ${cnt("ok")}${fix ? ` · 고친 것 ${fixed.length}` : nfix > 0 ? ` · --fix 로 고칠 수 있는 것 ${nfix}` : ""}${nlater > 0 ? ` · 이전 후 고칠 수 있는 것 ${nlater}` : ""}`);
  if (bad) process.exitCode = 1;
}

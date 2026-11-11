// Dual-run harness core (SEL-70, PR26a): the same synthetic input goes to the 0.15 Python CLI ("py") or to the TypeScript
// target ("ts"); stdout / stderr kind / exit / produced files / state DTO are normalised (N1~N10) and compared.
//
// Targets
//   py  python -I -X utf8 scripts/pes.py | serve.py | setup.py       (no PES_DB_CORE: pure v0.15)
//   ts  scripts/pes.ts                                               (does not exist yet: every run answers "not_yet")
//
// A target that cannot run a command says so with { kind: "not_yet" } — a case is never skipped silently; the list of not-yet
// cases must equal tests/fixtures/compat/cases.json exactly (tests/test_compat_harness.test.ts), so implementing a command
// forces the table entry to be removed.
//
// Isolation: every child gets HOME, USERPROFILE and PES_HOME inside one temp folder (assert_isolated_env), and the py side runs
// with a narrowed PATH when the case asks for it. The Windows list: -X utf8, CRLF → LF, realpath.native, doubled backslashes,
// no `which` / `sh` / `tar`.

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assert_isolated_env, assert_no_real_path } from "./home_guard.ts";
import { isolated_home, type IsolatedHome } from "./isolated_home.ts";
import { n1_json, n1_time, n2_paths, n7_text, n9_text_hash, stderr_kind, lines, n8_console, type KnownDiff, type Roots } from "./compat_normalize.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..");
export const FIXTURES = join(REPO, "tests", "fixtures", "compat");
export const PES_PY = join(REPO, "scripts", "pes.py");
export const SERVE_PY = join(REPO, "scripts", "serve.py");
export const SETUP_PY = join(REPO, "scripts", "setup.py");
export const PES_TS = join(REPO, "scripts", "pes.ts");

export type Target = "py" | "ts";
export const STAGES = ["plan", "research", "analyze", "write", "verify", "publish"] as const;
export type Stage = (typeof STAGES)[number];

/** Absolute interpreter, resolved once with the parent PATH, so a narrowed PATH in the child cannot lose it. */
export const PYTHON: string = (() => {
  for (const name of ["python3", "python"]) {
    const probe = spawnSync(name, ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
    if (probe.status === 0 && probe.stdout.trim() !== "") return probe.stdout.trim();
  }
  throw new Error("python3 not found: the 0.15 compat target needs Python 3.9+");
})();

/** `-I` (ignore PYTHON* and the user site) + `-X utf8` (UTF-8 stdio even on a Windows pipe; -I ignores PYTHONIOENCODING). */
export const PY_FLAGS = ["-I", "-X", "utf8"] as const;

export function target_from_env(fallback: Target = "py"): Target {
  const value = process.env.PES_COMPAT_TARGET;
  if (value === undefined || value === "") return fallback;
  assert.ok(value === "py" || value === "ts", `PES_COMPAT_TARGET must be py or ts (got ${value})`);
  return value;
}

export function ts_available(): boolean {
  return existsSync(PES_TS);
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type TargetRun = ({ kind: "ran" } & RunResult) | { kind: "not_yet"; reason: string };

export interface CompatCtx {
  readonly home: IsolatedHome;
  /** isolated HOME */
  readonly home_dir: string;
  /** PES_HOME (the projects root) */
  readonly pes_home: string;
  /** scratch folder of the case (spec files, restore targets) */
  readonly tmp: string;
  readonly env: Record<string, string | undefined>;
  roots(project?: string): Roots;
  project(name?: string): string;
  /** PATH with only an empty folder: external tools are "missing" */
  readonly narrow_bin: string;
  cleanup(): void;
}

/** Variables that would make a child depend on the machine or on a real account. */
const SCRUBBED = ["PES_OWNER", "PES_TOKEN", "PES_DB_CORE", "PES_API_BUDGET_TEST_OVERRIDE", "PES_LOCAL_SESSION_SECRET", "LAW_OC", "KOSIS_API_KEY", "VWORLD_API_KEY", "VWORLD_KEY", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP"];

export const DEFAULT_PROJECT_NAME = "합성 프로젝트";

export function make_ctx(prefix = "pes-compat-"): CompatCtx {
  const home = isolated_home(prefix);
  const home_dir = home.env.HOME as string;
  const pes_home = home.env.PES_HOME as string;
  const tmp = join(home.root, "work");
  const narrow_bin = join(home.root, "bin");
  mkdirSync(tmp, { recursive: true });
  mkdirSync(narrow_bin, { recursive: true });
  const env: Record<string, string | undefined> = { ...home.env };
  for (const key of SCRUBBED) delete env[key];
  assert_isolated_env(env);
  return {
    home,
    home_dir,
    pes_home,
    tmp,
    env,
    narrow_bin,
    roots: (project) => ({ PES: REPO, PROJECT: project, HOME: home_dir, TMP: home.root }),
    project: (name = DEFAULT_PROJECT_NAME) => join(tmp, name),
    cleanup: () => home.cleanup(),
  };
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  /** replace PATH by the empty folder of the ctx (+ on Windows the system folder, which python needs) */
  narrow_path?: boolean;
  timeout_ms?: number;
  input?: string;
  cwd?: string;
}

function child_env(ctx: CompatCtx, options: RunOptions): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...ctx.env, ...(options.env ?? {}) };
  if (options.narrow_path === true) {
    const extra = process.platform === "win32" ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32")] : [];
    env.PATH = [ctx.narrow_bin, ...extra].join(process.platform === "win32" ? ";" : ":");
    env.Path = env.PATH;
  }
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  // PES_OWNER is the one variable a case may add on purpose (lock tests); everything else must be the isolated set.
  // A case may leave PES_HOME unset on purpose (to see the default <HOME>/pes-projects); HOME is still checked.
  assert_isolated_env({ ...env, PES_OWNER: undefined, PES_HOME: env.PES_HOME ?? join(env.HOME ?? "", "pes-projects") });
  return env as NodeJS.ProcessEnv;
}

function spawn_python(script: string, args: string[], ctx: CompatCtx, options: RunOptions): RunResult {
  const env = child_env(ctx, options);
  const result = spawnSync(PYTHON, [...PY_FLAGS, script, ...args], {
    env,
    cwd: options.cwd ?? ctx.home.root,
    encoding: "utf8",
    input: options.input,
    timeout: options.timeout_ms ?? 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  // N7: a Windows text-mode pipe turns "\n" into "\r\n"; every comparison sees LF.
  const out = { status: result.status, stdout: n7_text(result.stdout ?? ""), stderr: n7_text(result.stderr ?? "") };
  assert_no_real_path(out.stdout, "stdout");
  assert_no_real_path(out.stderr, "stderr");
  return out;
}

/** Runs one `pes` CLI command on a target. PES_OWNER may be passed through options.env (the lock tests need it). */
export function run_pes(target: Target, ctx: CompatCtx, args: (string | number)[], options: RunOptions = {}): TargetRun {
  const argv = args.map(String);
  if (target === "ts") {
    if (!ts_available()) return { kind: "not_yet", reason: "scripts/pes.ts 없음 (PR26 3~4단계)" };
    throw new Error("scripts/pes.ts exists: wire the ts target in compat_env.run_pes and remove the not_yet entries");
  }
  return { kind: "ran", ...spawn_python(PES_PY, argv, ctx, options) };
}

/** Runs a short inline snippet with the same flags and isolation (for the few in-process checks of tests/*.py that have no CLI form). */
export function run_py_code(ctx: CompatCtx, code: string, args: string[] = [], options: RunOptions = {}): RunResult {
  const env = child_env(ctx, options);
  const result = spawnSync(PYTHON, [...PY_FLAGS, "-c", code, ...args], { env, cwd: options.cwd ?? ctx.home.root, encoding: "utf8", timeout: options.timeout_ms ?? 60_000 });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: n7_text(result.stdout ?? ""), stderr: n7_text(result.stderr ?? "") };
}

export function run_setup(target: Target, ctx: CompatCtx, args: string[], options: RunOptions = {}): TargetRun {
  if (target === "ts") return { kind: "not_yet", reason: "scripts/setup.ts 없음 (PR26 4단계)" };
  return { kind: "ran", ...spawn_python(SETUP_PY, args, ctx, options) };
}

/** py-only convenience for the ported pytest files: the 0.15 CLI, exit / stdout / stderr, never "not_yet". */
export function pes(ctx: CompatCtx, ...args: (string | number)[]): RunResult & { code: number | null; out: string; err: string } {
  const run = run_pes("py", ctx, args) as { kind: "ran" } & RunResult;
  return { ...run, code: run.status, out: run.stdout, err: run.stderr };
}

export function pes_as(ctx: CompatCtx, owner: string, ...args: (string | number)[]): ReturnType<typeof pes> {
  const run = run_pes("py", ctx, args, { env: { PES_OWNER: owner } }) as { kind: "ran" } & RunResult;
  return { ...run, code: run.status, out: run.stdout, err: run.stderr };
}

// ---------------------------------------------------------------- files
export function write_json(path: string, data: unknown, indent: number | undefined = 1): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, indent), "utf8");
  return path;
}

export function read_json(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function project_json(project: string): any {
  return read_json(join(project, "project.json"));
}

export function edit_project(project: string, mutate: (data: any) => void): any {
  const data = project_json(project);
  mutate(data);
  write_json(join(project, "project.json"), data);
  return data;
}

export function init_project(ctx: CompatCtx, name = DEFAULT_PROJECT_NAME, topic = "합성 주제", source?: string): string {
  const project = ctx.project(name);
  const args = ["init", project, "--topic", topic, ...(source === undefined ? [] : ["--import", source])];
  const run = pes(ctx, ...args);
  assert.equal(run.code, 0, `${run.out}${run.err}`);
  return project;
}

let merge_seq = 0;
export function merge(ctx: CompatCtx, project: string, stage: string, results: unknown[], name = `result-${++merge_seq}`): string {
  const files = results.map((result, index) => write_json(join(ctx.tmp, "results", name, `${index}.json`), result));
  const run = pes(ctx, "merge", project, stage, ...files);
  assert.equal(run.code, 0, `${run.out}${run.err}`);
  return run.out;
}

export function approve(ctx: CompatCtx, project: string, stage: string): string {
  const run = pes(ctx, "approve", project, stage);
  assert.equal(run.code, 0, `${run.out}${run.err}`);
  return run.out;
}

/** The four synthetic project shapes of tests/fixtures/generate.py (a TS port: same bytes). */
let synthetic_seq = 0;
export function synthetic_project(ctx: CompatCtx, kind: "legacy" | "broken" | "large"): string {
  // a fresh folder per call (pytest gave every test its own tmp_path)
  const dir = join(ctx.tmp, `${kind}-${++synthetic_seq}`);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "project.json");
  if (kind === "broken") writeFileSync(target, '{"pes": 1, "stages":', "utf8");
  else if (kind === "legacy") writeFileSync(target, JSON.stringify({ pes: 1, topic: "합성 주제", stages: { plan: { items: [{ id: 1, title: "합성 항목" }] } } }), "utf8");
  else writeFileSync(target, JSON.stringify({ pes: 1, topic: "합성 주제", stages: {}, synthetic_payload: "x".repeat(2 * 1024 * 1024) }), "utf8");
  return dir;
}

export function listing(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** Every file below `dir` (relative, `/`-separated, sorted), without the volatile ones (pid temp files). */
export function walk_files(dir: string): string[] {
  const out: string[] = [];
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) visit(full);
      else out.push(relative(dir, full).split("\\").join("/"));
    }
  };
  if (existsSync(dir)) visit(dir);
  return out.filter((rel) => !/\.tmp(\.\d+)?$/.test(rel));
}

export function copy_dir(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

export function move_dir(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
}

export function touch(path: string, epoch_s: number): void {
  utimesSync(path, epoch_s, epoch_s);
}

// ---------------------------------------------------------------- state DTO (test-only, not a product contract)
const ITEM_KEYS = ["id", "title", "kind", "status", "summary", "details", "sources", "stats", "links", "updated_round", "depth", "reuse", "request", "conflicts", "confidence", "order", "question"];
const STAGE_KEYS = ["status", "round", "settings", "review", "suggestions", "warnings", "changes", "summary", "approved_at", "stale", "reports", "history", "carry_over", "qa", "review_log", "reports_built"];

export interface StateDto {
  topic: unknown;
  slug: unknown;
  created: unknown;
  current: unknown;
  complete: unknown;
  settings: unknown;
  processed: unknown;
  notes: unknown;
  executive_summary: unknown;
  conclusion: unknown;
  library: unknown;
  stages: Record<string, unknown>;
}

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in source) out[key] = source[key];
  return out;
}

/** Same DTO from a 0.15 project.json (+ library.json). The TS side builds it from the migrated DB (not yet). */
export function dto_from_project_json(data: any, library?: any): StateDto {
  const stages: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries<any>(data.stages ?? {})) {
    const stage = pick(raw, STAGE_KEYS);
    stage.items = (raw.items ?? []).map((item: any) => pick(item, ITEM_KEYS));
    stages[name] = stage;
  }
  return {
    topic: data.topic,
    slug: data.slug,
    created: data.created,
    current: data.current,
    complete: data.complete,
    settings: data.settings,
    processed: data.processed,
    notes: data.notes,
    executive_summary: data.executive_summary,
    conclusion: data.conclusion,
    library: library ?? data.library ?? null,
    stages,
  };
}

export function read_state_dto(target: Target, ctx: CompatCtx, project: string): ({ kind: "ran"; dto: StateDto } | { kind: "not_yet"; reason: string }) {
  if (target === "ts") return { kind: "not_yet", reason: "TS 상태 DTO 는 이전 결과 DB(PR11)에서 만든다 — 대상 CLI 가 없다" };
  const data = project_json(project);
  const library_path = join(project, "library.json");
  const library = existsSync(library_path) ? read_json(library_path) : undefined;
  return { kind: "ran", dto: dto_from_project_json(data, library) };
}

/** DTO → N1/N2 normalised plain object, ready for deepEqual against a stored baseline. */
export function normalized_dto(dto: StateDto, roots: Roots): unknown {
  return n1_json(dto, roots);
}

// ---------------------------------------------------------------- intended differences (7.5) — shown in the case table
export const KNOWN_DIFFS: Record<string, KnownDiff> = {
  D01: { id: "D01", title: "새 ID(UUID·tx·event·lease) vs 0.15 정수 item id", reason: "새 코어가 DB·버전·사건을 쓴다 (N5 로 치환, 참조만 비교)", drop: ["stages.*.items.*.id"] },
  D02: { id: "D02", title: "project.json 단일 원본 → SQLite 원본", reason: "상태 DTO 로 비교한다. project.json 은 legacy 읽기 전용" },
  D03: { id: "D03", title: "feedback/*.json 파일 → submissions/answers", reason: "/feedback 호환 응답·영수증 의미를 비교한다", drop: ["processed"] },
  D04: { id: "D04", title: ".pes-lock·PES_OWNER → project_leases/토큰", reason: "CLI exit·owner 의미만 비교한다" },
  D05: { id: "D05", title: "watch tail 명령 → long-poll/이벤트", reason: "출력 형식 호환 또는 새 대기 방식을 명시한다" },
  D06: { id: "D06", title: "merge depth 재제출 증가 (0.15 결함 ②, SEL-12)", reason: "0.15 는 같은 병합을 다시 보내면 depth 가 또 오른다 — 새 코어는 고친 동작이 정답이다", drop: ["stages.*.items.*.depth"] },
  D07: { id: "D07", title: "같은 라운드 snapshot (대응표 7.5 '덮어쓰기' — 0.15 는 이미 첫 상태를 지킨다)", reason: "0.15 현재 동작은 snapshot 의 첫 상태를 기본 파일에 두고 이후 상태는 snapshots/<단계>-R<n>/<k>.json 에 모은다(덮어쓰기 결함은 고쳐졌다). 새 코어는 DB 판(editions)으로 보관하므로 파일 이름·위치는 비교하지 않고 '첫 상태 보존·이후 상태 유실 0'만 비교한다" },
  D08: { id: "D08", title: "doctor 의 Python/템플릿 검사", reason: "런타임 변경 — TS 런타임 검사로 바꾸고 섹션·exit 를 유지한다" },
  D09: { id: "D09", title: "hub/serve 정적 HTML 생성 → DB/API 서버", reason: "URL·포트·응답 계약은 같고 내부 구현은 다르다" },
};

// ---------------------------------------------------------------- HTTP server (serve.py) harness
export function free_port(): Promise<number> {
  return new Promise((resolve_port, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve_port(port));
    });
  });
}

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  text(): string;
  json(): any;
}

export interface ServeOptions {
  /** executable instead of the python interpreter (a missing one exercises the spawn-error path) */
  command?: string;
  /** server script instead of scripts/serve.py (a missing one makes python exit at once) */
  script?: string;
  /** whoami root the readiness probe expects (default: the root given to the constructor) */
  expected_root?: string;
  ready_timeout_ms?: number;
  /** text appended to a generated sitecustomize.py (test-only injection) — placed on PYTHONPATH, so -I is dropped for the child */
  sitecustomize?: string;
  extra_env?: Record<string, string | undefined>;
}

export class ServeProcess {
  port = 0;
  proc: ChildProcess | undefined;
  log = "";
  /** every child this object ever spawned (start-failure tests check that all of them are gone) */
  readonly children: ChildProcess[] = [];
  private spawn_error: Error | undefined;
  readonly ctx: CompatCtx;
  readonly root: string;
  readonly options: ServeOptions;
  constructor(ctx: CompatCtx, root: string, options: ServeOptions = {}) {
    this.ctx = ctx;
    this.root = root;
    this.options = options;
  }

  origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<this> {
    const errors: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      this.port = await free_port();
      this.log = "";
      const startup = join(this.ctx.tmp, `serve-startup-${attempt}`);
      const env: Record<string, string | undefined> = { ...this.ctx.env, ...(this.options.extra_env ?? {}) };
      const flags: string[] = ["-X", "utf8"];
      if (this.options.sitecustomize !== undefined) {
        mkdirSync(startup, { recursive: true });
        writeFileSync(join(startup, "sitecustomize.py"), this.options.sitecustomize, "utf8");
        env.PYTHONPATH = startup;
      } else {
        flags.unshift("-I");
      }
      env.PYTHONIOENCODING = "utf-8";
      for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
      this.spawn_error = undefined;
      const proc = spawn(this.options.command ?? PYTHON, [...flags, this.options.script ?? SERVE_PY, this.root, String(this.port)], { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], cwd: this.ctx.home.root });
      this.proc = proc;
      this.children.push(proc);
      proc.once("error", (error) => {
        this.spawn_error = error;
      });
      this.proc.stdout?.on("data", (chunk: Buffer) => (this.log += chunk.toString("utf8")));
      this.proc.stderr?.on("data", (chunk: Buffer) => (this.log += chunk.toString("utf8")));
      if (await this.wait_ready()) return this;
      errors.push(`port ${this.port}: readiness timeout\n${this.log}`);
      await this.stop();
    }
    throw new Error(`serve.py did not start after 3 attempts:\n${errors.join("\n")}`);
  }

  private async wait_ready(): Promise<boolean> {
    const deadline = Date.now() + (this.options.ready_timeout_ms ?? 15_000);
    while (Date.now() < deadline) {
      if (this.spawn_error !== undefined || this.proc === undefined || this.proc.exitCode !== null || this.proc.signalCode !== null) return false;
      try {
        const response = await fetch(`${this.origin()}/whoami`, { signal: AbortSignal.timeout(500) });
        const info = (await response.json()) as { root?: string; single?: boolean };
        // A port taken by another PES home's server is not "ready".
        if (info.single === true && info.root !== undefined && same_path(info.root, this.options.expected_root ?? this.root)) return true;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    if (proc === undefined || proc.exitCode !== null || proc.signalCode !== null || this.spawn_error !== undefined) return;
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
      }, 10_000);
      proc.once("exit", () => {
        clearTimeout(timer);
        done();
      });
      proc.kill();
    });
  }

  async restart(): Promise<this> {
    await this.stop();
    return this.start();
  }

  async request(path: string, init: { method?: string; body?: string | Uint8Array; headers?: Record<string, string>; redirect?: "manual" | "follow" } = {}): Promise<HttpResult> {
    const response = await fetch(`${this.origin()}${path}`, {
      method: init.method ?? "GET",
      body: init.body as any,
      headers: init.headers,
      redirect: init.redirect ?? "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const body = Buffer.from(await response.arrayBuffer());
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    return {
      status: response.status,
      headers,
      body,
      text: () => body.toString("utf8"),
      json: () => JSON.parse(body.toString("utf8")),
    };
  }

  /** POST a JSON object (or raw bytes); `origin` null sends no Origin header. */
  async post(path: string, payload: unknown, origin: string | null = this.origin()): Promise<HttpResult> {
    const body = payload instanceof Uint8Array ? payload : Buffer.from(JSON.stringify(payload), "utf8");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (origin !== null) headers.origin = origin;
    return this.request(path, { method: "POST", body, headers });
  }
}

function same_path(a: string, b: string): boolean {
  const norm = (value: string): string => value.split("\\").join("/").replace(/\/+$/, "").toLowerCase();
  if (norm(a) === norm(b)) return true;
  try {
    return norm(realpathSync.native(a)) === norm(realpathSync.native(b));
  } catch {
    return false;
  }
}

/** The home layout of tests/test_serve.py::_make_home, in the isolated PES_HOME. */
export function make_serve_home(ctx: CompatCtx): string {
  mkdirSync(ctx.pes_home, { recursive: true });
  const root = realpathSync.native(ctx.pes_home);
  const project = join(root, "synthetic");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "project.json"), JSON.stringify({ pes: 1, topic: "합성 주제", stages: {} }), "utf8");
  writeFileSync(join(project, "index.html"), "<html>synthetic</html>", "utf8");
  writeFileSync(join(project, "ask-plan.html"), "<html>ask</html>", "utf8");
  writeFileSync(join(root, "index.html"), "<html>home</html>", "utf8");
  return root;
}

export { n1_time, n7_text, n8_console, n9_text_hash, stderr_kind, lines };

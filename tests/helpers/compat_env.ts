// Dual-run harness core (SEL-70, PR26a): the same synthetic input goes to the 0.15 Python CLI ("py") or to the TypeScript
// target ("ts"); stdout / stderr kind / exit / produced files / state DTO are normalised (N1~N10) and compared.
//
// Targets
//   py  python -I -X utf8 -c "<conftest GUARD>; runpy.run_path(scripts/pes.py | serve.py | setup.py)"   (no PES_DB_CORE: pure v0.15)
//   ts  node [--permission --import ts_child_guard.ts] scripts/pes.ts | serve.ts | setup.ts   (pes.ts: compat_ts.ts, SEL-71; serve.ts / setup.ts:
//       compat_ts_srv.ts, SEL-72; a missing file answers "not_yet")
//
// A target that cannot run a command says so with { kind: "not_yet" } — a case is never skipped silently. The ratchet is PER CASE
// (SEL-71): cases.json `ts.status` says whether the ts target must match 0.15 (implemented) or answers not_yet (and is not run at all,
// scripts/*.ts or not — compat_cases.run_case). All three kinds are wired (cli → pes.ts, http → serve.ts, setup → setup.ts); `ts_gate`
// only reports the missing file of a kind.
//
// Isolation: every child gets HOME, USERPROFILE and PES_HOME inside one temp folder (assert_isolated_env), and the py side runs
// with a narrowed PATH when the case asks for it. The py child also runs the audit hook of tests/conftest.py (reads included,
// see home_guard.ts). The Windows list: -X utf8, CRLF → LF, realpath.native, doubled backslashes, no `which` / `sh` / `tar`.

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { account_home, assert_isolated_env, assert_no_real_path, assert_no_violation } from "./home_guard.ts";
import { hub_block_code } from "./hub_block.ts";
import { run_ts_cli, ts_cli_exists, ts_view } from "./compat_ts.ts";
import { adapt_ts_doctor_stdout, adapt_ts_setup_stdout, run_ts_setup } from "./compat_ts_srv.ts";
import { isolated_home, type IsolatedHome } from "./isolated_home.ts";
import { n1_json, n1_time, n2_paths, n7_text, n9_text_hash, stderr_kind, lines, n8_console, type KnownDiff, type Roots } from "./compat_normalize.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..");
export const FIXTURES = join(REPO, "tests", "fixtures", "compat");
export const PES_PY = join(REPO, "scripts", "pes.py");
export const SERVE_PY = join(REPO, "scripts", "serve.py");
export const SETUP_PY = join(REPO, "scripts", "setup.py");
export const PES_TS = join(REPO, "scripts", "pes.ts");
export const SERVE_TS = join(REPO, "scripts", "serve.ts");
export const SETUP_TS = join(REPO, "scripts", "setup.ts");
export const CONFTEST_PY = join(REPO, "tests", "conftest.py");

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

export type CaseKind = "cli" | "http" | "setup";
export const TS_FILES: Record<CaseKind, string> = { cli: PES_TS, http: SERVE_TS, setup: SETUP_TS };

export function ts_available(kind: CaseKind = "cli", exists: (path: string) => boolean = existsSync): boolean {
  return exists(TS_FILES[kind]);
}

/**
 * The one gate of the ts target. The file of a kind does not exist → `not_yet` (counted absence). All three kinds are wired (pes.ts
 * SEL-71, serve.ts / setup.ts SEL-72), so an existing file is not the gate's business and it never throws. Whether a CASE may run on
 * ts is decided per case by cases.json `ts.status` (compat_cases.run_case). `exists` is injectable so the gate can be tested without
 * creating a file under scripts/.
 */
export function ts_gate(kind: CaseKind, _exists: (path: string) => boolean = existsSync): { kind: "not_yet"; reason: string } {
  const reasons: Record<CaseKind, string> = {
    cli: "scripts/pes.ts 없음 (PR26 3~4단계)",
    http: "scripts/serve.ts 없음 (SEL-72, PR26c)",
    setup: "scripts/setup.ts 없음 (SEL-72, PR26c)",
  };
  return { kind: "not_yet", reason: reasons[kind] };
}

// ---------------------------------------------------------------- the guarded Python child (audit hook of tests/conftest.py)
let guard_source: string | undefined;
/** The GUARD string of tests/conftest.py (the r'''…''' literal), read once. No second copy of the hook exists. */
export function py_guard_source(): string {
  if (guard_source === undefined) {
    const match = /^GUARD = r'''\n([\s\S]*?)\n'''$/m.exec(readFileSync(CONFTEST_PY, "utf8").replace(/\r\n/g, "\n"));
    assert.ok(match !== null, "tests/conftest.py: the GUARD literal moved — update py_guard_source");
    guard_source = match[1] as string;
  }
  return guard_source;
}

/**
 * `python -I -X utf8 -c "<GUARD>; <extra>; runpy.run_path(argv[1], run_name='__main__')" <script> <args…>`: the child behaves as if
 * `python -I -X utf8 <script> <args…>` was run (argv, __file__, __main__, exit code), with the audit hook installed first.
 * `extra` is test-only code that runs after the hook and before the script (the sitecustomize-style injections).
 */
export function guarded_script_argv(script: string, args: string[], extra = "", allow_hub_port?: number | readonly number[]): string[] {
  // every guarded child also gets the hub block (no real PES hub is ever contacted); only `allow_hub_port` stays open
  const code = `${py_guard_source()}\n${hub_block_code(allow_hub_port)}\n${extra}\nimport runpy as _pes_runpy, sys as _pes_sys\n_pes_sys.argv = _pes_sys.argv[1:]\n_pes_runpy.run_path(_pes_sys.argv[0], run_name="__main__")\n`;
  return [...PY_FLAGS, "-c", code, script, ...args];
}

/** Variables that switch the hook on and name the home it protects. A case/option env may override them (the guard self-test does). */
function guard_env(): Record<string, string> {
  return { PES_TEST_GUARD: "1", PES_TEST_REAL_HOME: account_home() };
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
  // pes.py find_tool also looks below %LOCALAPPDATA% / %APPDATA% (Windows) — point them into the temp home, or an ego-browser
  // installed on the developer's PC would change E14 / E15.
  if (process.platform === "win32") {
    env.LOCALAPPDATA = join(home_dir, "AppData", "Local");
    env.APPDATA = join(home_dir, "AppData", "Roaming");
  }
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

export { HUB_BLOCK, hub_block_code } from "./hub_block.ts";

export interface RunOptions {
  /** test-only Python run after the audit hook and before the script (after HUB_BLOCK) */
  extra?: string;
  /** the ONE hub port (of 8760~8775) that stays open — only for a test that starts its own stand-in hub; the other ports stay blocked */
  allow_hub_port?: number | readonly number[];
  env?: Record<string, string | undefined>;
  /** replace PATH by the empty folder of the ctx (+ on Windows the system folder, which python needs) */
  narrow_path?: boolean;
  timeout_ms?: number;
  input?: string;
  cwd?: string;
}

function child_env(ctx: CompatCtx, options: RunOptions): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...ctx.env, ...guard_env(), ...(options.env ?? {}) };
  // A case / option env must never switch the audit hook off (only PES_TEST_REAL_HOME may be replaced — the guard self-test does).
  assert.equal(env.PES_TEST_GUARD, "1", "a case env turned the home guard off (PES_TEST_GUARD)");
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
  const result = spawnSync(PYTHON, guarded_script_argv(script, args, options.extra ?? "", options.allow_hub_port), {
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
  assert_no_violation(out.stderr, `${relative(REPO, script)} ${args.join(" ")}`);
  assert_no_real_path(out.stdout, "stdout");
  assert_no_real_path(out.stderr, "stderr");
  return out;
}

/** Runs one `pes` CLI command on a target. PES_OWNER may be passed through options.env (the lock tests need it). */
export function run_pes(target: Target, ctx: CompatCtx, args: (string | number)[], options: RunOptions = {}): TargetRun {
  const argv = args.map(String);
  if (target === "ts") {
    // pes.ts missing → "not_yet" (a counted absence). Whether a CASE may run it is decided per case by cases.json (compat_cases).
    if (!ts_cli_exists()) return ts_gate("cli", () => false);
    const { PES_OWNER, ...rest } = options.env ?? {};
    // doctor looks for external tools (a child process per tool, PATH narrowed by the case): the permission model must let it try —
    // a denied spawn would hide the "tool missing" answer behind ERR_ACCESS_DENIED
    const run = run_ts_cli(ctx, argv, { env: PES_OWNER === undefined ? rest : { ...rest, PES_OWNER }, narrow_path: options.narrow_path, timeout_ms: options.timeout_ms, input: options.input, cwd: options.cwd, extra_read: options.narrow_path === true ? [ctx.narrow_bin] : [], allow_child_process: argv[0] === "doctor" });
    return { kind: "ran", ...run, stdout: argv[0] === "doctor" ? adapt_ts_doctor_stdout(argv, run.stdout) : run.stdout };
  }
  return { kind: "ran", ...spawn_python(PES_PY, argv, ctx, options) };
}

/** Runs a short inline snippet with the same flags, isolation and audit hook (for the few in-process checks of tests/*.py that have no CLI form). */
export function run_py_code(ctx: CompatCtx, code: string, args: string[] = [], options: RunOptions = {}): RunResult {
  const env = child_env(ctx, options);
  const result = spawnSync(PYTHON, [...PY_FLAGS, "-c", `${py_guard_source()}\n${code}`, ...args], { env, cwd: options.cwd ?? ctx.home.root, encoding: "utf8", timeout: options.timeout_ms ?? 60_000 });
  if (result.error !== undefined) throw result.error;
  const out = { status: result.status, stdout: n7_text(result.stdout ?? ""), stderr: n7_text(result.stderr ?? "") };
  assert_no_violation(out.stderr, "inline python snippet");
  return out;
}

export function run_setup(target: Target, ctx: CompatCtx, args: string[], options: RunOptions = {}): TargetRun {
  if (target === "ts") {
    if (!ts_available("setup")) return ts_gate("setup", () => false);
    // guarded `node scripts/setup.ts` (permission allow-list without the real home + ts_child_guard.ts); a case env may add variables
    // (PES_OWNER is not one of them: setup has no owner), the narrowed PATH hides every external tool from the child
    const run = run_ts_setup(ctx, args, { env: options.env, narrow_path: options.narrow_path, timeout_ms: options.timeout_ms, input: options.input, cwd: options.cwd });
    return { kind: "ran", status: run.status, stdout: adapt_ts_setup_stdout(args, run.stdout), stderr: run.stderr };
  }
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

/**
 * The synthetic project shapes of tests/fixtures/generate.py, ported: the same content (`pes`, topic, one plan item / truncated
 * JSON / a 2 MB payload). Not the same bytes: Python json.dumps writes ", " and ": " separators, JSON.stringify none — pes.py
 * reads both as the same JSON.
 */
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
// Every top-level / stage / item key of a 0.15 project.json is either mapped into the DTO or listed in an explicit exclusion list.
// `unmapped_keys` reports the rest, and `read_state_dto` throws on any: a new 0.15 field is a decision, never a silent drop.
// (pes.py: new_stage() / blank_item() / cmd_init; the rest are keys other commands add: review_log, reports_built, carry_over, qa,
// reuse, order, recommended …)
export const TOP_KEYS = ["pes", "topic", "slug", "created", "current", "complete", "settings", "processed", "notes", "executive_summary", "conclusion", "library"] as const;
export const STAGE_KEYS = ["status", "round", "settings", "review", "suggestions", "warnings", "changes", "summary", "approved_at", "stale", "reports", "history", "carry_over", "qa", "review_log", "reports_built"] as const;
export const ITEM_KEYS = ["id", "title", "kind", "question", "status", "request", "depth", "updated_round", "summary", "details", "sources", "stats", "shots", "confidence", "conflicts", "verify", "links", "user_links", "reuse", "order", "recommended"] as const;
/**
 * Keys deliberately left out of the DTO, with the reason.
 *   top.synthetic_payload — a 2 MB filler that synthetic_project() (the large-project fixture) adds; it is no 0.15 state (its content hash is
 *   still compared through the `files` digest of project.json).
 */
export const EXCLUDED_KEYS: { top: string[]; stage: string[]; item: string[] } = { top: ["synthetic_payload"], stage: [], item: [] };

/** Keys of a 0.15 project.json that the DTO neither maps nor excludes ("top", "stages.<name>", "stages.<name>.items.<id>" prefix). */
export function unmapped_keys(data: any): string[] {
  const out: string[] = [];
  const known = (keys: readonly string[], excluded: string[], value: any, where: string): void => {
    for (const key of Object.keys(value ?? {})) if (!keys.includes(key) && !excluded.includes(key)) out.push(`${where}.${key}`);
  };
  known([...TOP_KEYS, "stages"], EXCLUDED_KEYS.top, data, "top");
  for (const [name, stage] of Object.entries<any>(data?.stages ?? {})) {
    known([...STAGE_KEYS, "items"], EXCLUDED_KEYS.stage, stage, `stages.${name}`);
    for (const item of stage?.items ?? []) known(ITEM_KEYS, EXCLUDED_KEYS.item, item, `stages.${name}.items.${item?.id}`);
  }
  return out;
}

export interface StateDto {
  pes: unknown;
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
    pes: data.pes,
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
  if (target === "ts") {
    if (!ts_cli_exists()) return { kind: "not_yet", reason: "TS 상태 DTO 는 DB 에서 만든다 — 대상 CLI(scripts/pes.ts)가 없다" };
    // D02: the DB is the source (slug = the folder name, the 0.15 `pdir` rule); a folder the DB does not serve is read as the old project.json
    const view = ts_view({ env: ctx.env, pes_home: ctx.pes_home, home_dir: ctx.home_dir }, basename(project));
    if (view !== undefined) return { kind: "ran", dto: dto_from_project_json(view.project, view.project.library ?? undefined) };
    const legacy_path = join(project, "project.json");
    assert.ok(existsSync(legacy_path), `ts: neither the database (slug ${basename(project)}) nor ${legacy_path} holds the project`);
    const legacy = project_json(project);
    const library_file = join(project, "library.json");
    return { kind: "ran", dto: dto_from_project_json(legacy, existsSync(library_file) ? read_json(library_file) : undefined) };
  }
  const data = project_json(project);
  const library_path = join(project, "library.json");
  const library = existsSync(library_path) ? read_json(library_path) : undefined;
  const unmapped = unmapped_keys(data);
  assert.deepEqual(unmapped, [], "0.15 project.json keys the state DTO neither maps nor excludes — add them to TOP_KEYS / STAGE_KEYS / ITEM_KEYS or EXCLUDED_KEYS");
  return { kind: "ran", dto: dto_from_project_json(data, library) };
}

/** DTO → N1/N2 normalised plain object, ready for deepEqual against a stored baseline. */
export function normalized_dto(dto: StateDto, roots: Roots): unknown {
  return n1_json(dto, roots);
}

// ---------------------------------------------------------------- intended differences (7.5) — shown in the case table
export const KNOWN_DIFFS: Record<string, KnownDiff> = {
  D01: { id: "D01", title: "새 ID(UUID·tx·event·lease) vs 0.15 정수 item id", reason: "새 코어가 DB·버전·사건을 쓴다 (N5 로 치환, 참조만 비교)", drop: ["stages.*.items.*.id"], checks: ["ids_distinct"] },
  D02: { id: "D02", title: "project.json 단일 원본 → SQLite 원본", reason: "상태 DTO 로 비교한다(ts 는 DB 에서 읽고 — DB 에 없으면 폴더의 옛 project.json 에서 — 같은 DTO 를 만든다, compat_env.read_state_dto). project.json·library.json 의 파일 내용은 비교하지 않는다: 옛 형식 파일은 ts 가 쓰지 않는다. 그 대신 폴더의 나머지 파일(index.html·보고서·out…)은 그대로 비교한다", drop_files: ["project.json", "library.json"] },
  D03: { id: "D03", title: "feedback/*.json 파일 → submissions/answers", reason: "/feedback 호환 응답·영수증 의미를 비교한다: 답은 파일 이름·시각이 아니라 {단계, 라운드, 종류, 글} 의 모음(multiset)으로 견주고(record.answers), `chat` 이 찍는 답 식별자 줄과 `pending` 이 찍는 이름은 공통 부분만 본다", drop: ["processed"], drop_files: ["feedback/**"], checks: ["processed_count"], answers_check: true },
  D04: { id: "D04", title: ".pes-lock·PES_OWNER → project_leases/토큰", reason: "CLI exit·stdout·stderr 는 그대로 견주고, 잠금 파일 대신 '지금 누가 쥐었나'(record 의 각 단계 lock.owner)를 견준다 — 옛 .pes-lock 의 owner 와 DB 의 살아 있는 lease 라벨", drop_files: [".pes-lock"], lock_check: true },
  D05: { id: "D05", title: "watch tail 명령 → long-poll/이벤트", reason: "출력 형식 호환 또는 새 대기 방식을 명시한다" },
  D06: { id: "D06", title: "merge depth 재제출 증가 (0.15 결함 ②, SEL-12)", reason: "0.15 는 같은 병합을 다시 보내면 depth 가 또 오른다 — 새 코어는 고친 동작이 정답이다 (E03: 같은 결과를 다시 보낸 항목 7 의 depth 는 0.15 의 3 이 아니라 2). 같은 값을 담는 산출 파일(index.html 의 data JSON·snapshots/**)에도 같은 규칙: ts 쪽 항목 7 의 depth 만 0.15 값으로 되돌린(+1) 뒤 비교하고 나머지 필드는 그대로 비교한다", override: { E03: { "stages.research.items.2.depth": 2 } }, file_depth: { E03: { item_id: 7, delta: 1 } } },
  D07: { id: "D07", title: "같은 라운드 snapshot (대응표 7.5 '덮어쓰기' — 0.15 는 이미 첫 상태를 지킨다)", reason: "0.15 현재 동작은 snapshot 의 첫 상태를 기본 파일에 두고 이후 상태는 snapshots/<단계>-R<n>/<k>.json 에 모은다(덮어쓰기 결함은 고쳐졌다). 새 코어는 DB 판(editions)으로 보관하므로 파일 이름·위치는 비교하지 않고 '첫 상태 보존·이후 상태 유실 0'만 비교한다 (ts 기록기는 보관한 판을 snapshots/** 아래에 모으고, 그 내용 해시가 하나도 빠지지 않아야 한다 — compat_cases.compare_ts_record)", drop_files: ["snapshots/**"], files_check: "snapshot_contents" },
  D08: { id: "D08", title: "doctor 의 Python/템플릿 검사 (SEL-77 해석)", reason: "런타임 변경 — TS 런타임 검사로 바꾸고 섹션·level·exit 를 유지한다. `doctor --json` 에서 환경 그룹의 `Python <버전>` 행은 없고(PES TS 는 Python 을 실행하지 않는다, migration-ts-equivalence 9.1) 그 자리에 `Node <버전>` 행(그룹 환경·level ok·detail 빈 문자열·fixable false)이 정확히 하나 있다. 그 밖의 모든 행(템플릿·PES 홈·PES_OWNER·서버·프로젝트 그룹)은 0.15 와 group·level·title·detail·fixable 이 같다 — 하네스가 두 사실을 먼저 단언한 뒤 0.15 철자로 되돌려 한 번에 견준다 (compat_ts_srv.adapt_ts_doctor_stdout)" },
  D09: { id: "D09", title: "hub/serve 정적 HTML 생성 → DB/API 서버", reason: "URL·포트·응답 계약은 같고 내부 구현은 다르다" },
  D10: { id: "D10", title: "Windows 0.15 차이 W1·W2 (SEL-71 결정 2026-11-11): ts 는 저장 경로 `/`·생성 텍스트 LF", reason: "0.15 는 Windows 에서 보고서 경로를 역슬래시로 저장하고 파일을 CRLF 로 써서 bytes 가 커진다(W1·W2, tests/README.md). ts 는 어느 OS 에서나 `/` 와 LF 로 통일한다 — 그래서 ts 대상은 win32 os_overrides 를 쓰지 않고 macOS/Linux 기준값(`/`·LF 바이트)과 같아야 하며, 폴더의 생성 텍스트에 CR 이 없어야 한다. 옛 데이터(역슬래시·CRLF 가 든 project.json)는 두 철자를 모두 읽는다(test_pes_ts_win_data)", posix_storage: true },
  D11: { id: "D11", title: "0.15 Python traceback → 분명한 한국어 한 줄 오류 (PR26a 관찰 3건, SEL-71 결정)", reason: "0.15 는 없는 결과 파일(merge·ask)·깨진 project.json·`current` 없는 큰 프로젝트(status)에서 traceback 으로 죽는다. 이것은 결함이지 계약이 아니다: ts 는 같은 종료 코드와 스택 추적 없는 한국어 한 줄 오류를 낸다(stdout 은 비교하지 않는다). 결함을 고쳐 성공해도 되는 단계는 표에 `fixable` 로 적는다", traceback_fix: { fixable: { E12: [["status", "{T}/large"]] } } },
  D13: { id: "D13", title: "순서 없는 approve · 승인된 단계의 round-start 는 거절 (SEL-71 1차 리뷰 필수 1, 선택지 b)", reason: "0.15 는 앞 단계가 승인되지 않아도 approve 를 받고, 승인된 단계에도 round-start 로 라운드를 +1 한다. 스킬은 승인을 순서대로 하고 승인된 단계는 reopen 뒤에 round-start 한다(skills/core/SKILL.md). DB 보장(앞 단계 승인 필요·승인된 단계 잠금)을 CLI 호환 때문에 풀지 않으므로 ts 는 exit 1 과 스택·영어 code 없는 한국어 한 줄로 거절하고 아무것도 바꾸지 않는다. 그 단계의 0.15 결과(exit 0)는 기준값에, ts 의 기대 문구는 ts_steps 에 둘 다 고정하고, 끝 상태는 0.15 를 그 단계 없이 돌린 기록(baseline.ts_end)과 같아야 한다", ts_steps: { X08: [{ step: ["approve", "{P}", "research"], exit: 1, stdout: [], stderr: ["approve: 앞 단계(기획)가 아직 승인되지 않았습니다"] }], X09: [{ step: ["round-start", "{P}", "plan"], exit: 1, stdout: [], stderr: ["round-start: 기획은 이미 승인됐습니다 — 먼저 reopen 하세요"] }] } },
  D12: { id: "D12", title: "setup 의 Python 행·실행 명령 표기 (SEL-72)", reason: "PES TS 는 Python 을 쓰지 않는다(migration-ts-equivalence 9.1): `setup.ts check` 에는 python 행이 없고(node 행이 런타임 점검), 사용법 첫 줄은 `사용: node scripts/setup.ts <명령>` 이다. 그 밖의 행·상태 이름·그룹·종료 코드·문구는 0.15 와 같아야 한다 — 하네스가 두 사실을 먼저 단언한 뒤 0.15 표기로 되돌려 한 번에 견준다 (compat_ts_srv.adapt_ts_setup_stdout)" },
  D14: { id: "D14", title: "옛 0.15 폴더(DB 로 안 옮긴 것)는 TS 에서 읽기 전용 (SEL-77 leader 결정 2026-11-11)", reason: "TS 는 project.json 을 쓰지 않는다(D02). 그래서 DB 로 옮기지 않은 옛 폴더에서 status·digest·show·pending 같은 읽기 명령은 0.15 와 같게 답하지만, render·report·assemble·web 같은 생성 명령은 exit 1 과 한국어 한 줄('이 프로젝트는 아직 새 형식으로 옮기지 않았습니다 — 먼저 이전하세요')로 거절하고 폴더의 바이트·mtime 을 바꾸지 않는다. 0.15 는 같은 명령으로 project.json 과 보고서를 바로 갱신한다" },
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
  /** test-only Python code run in the child after the audit hook and before serve.py (the old sitecustomize injection; -I stays) */
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
      const env: Record<string, string | undefined> = { ...this.ctx.env, ...guard_env(), ...(this.options.extra_env ?? {}) };
      assert.equal(env.PES_TEST_GUARD, "1", "a server env turned the home guard off (PES_TEST_GUARD)");
      env.PYTHONIOENCODING = "utf-8";
      for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
      assert_isolated_env({ ...env, PES_HOME: env.PES_HOME ?? join(env.HOME ?? "", "pes-projects") });
      this.spawn_error = undefined;
      // -I always stays: the test-only injection (options.sitecustomize) runs inside the -c code, after the audit hook and before
      // serve.py, so no PYTHONPATH / sitecustomize.py is needed any more.
      const argv = guarded_script_argv(this.options.script ?? SERVE_PY, [this.root, String(this.port)], this.options.sitecustomize ?? "");
      const proc = spawn(this.options.command ?? PYTHON, argv, { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], cwd: this.ctx.home.root });
      this.proc = proc;
      this.children.push(proc);
      proc.once("error", (error) => {
        this.spawn_error = error;
      });
      this.proc.stdout?.on("data", (chunk: Buffer) => (this.log += chunk.toString("utf8")));
      this.proc.stderr?.on("data", (chunk: Buffer) => (this.log += chunk.toString("utf8")));
      if (await this.wait_ready()) return this;
      assert_no_violation(this.log, "serve.py start-up");
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
    if (proc === undefined || proc.exitCode !== null || proc.signalCode !== null || this.spawn_error !== undefined) {
      assert_no_violation(this.log, "serve.py");
      return;
    }
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
    assert_no_violation(this.log, "serve.py");
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

// The TypeScript targets of the HTTP and setup kinds (SEL-72, PR26c): how `scripts/serve.ts` and `scripts/setup.ts` are run, guarded and
// observed, and how their results are read back into the 0.15-shaped record the compat cases compare.
//
// RUN METHOD (fixed by tests/test_serve_ts_contract.test.ts and tests/test_setup_ts_contract.test.ts):
//
//     node [--permission …] [--import tests/helpers/ts_child_guard.ts] scripts/serve.ts <PES 홈> [포트]
//     node [--permission …] [--import tests/helpers/ts_child_guard.ts] scripts/setup.ts <명령> [인자…]
//
//   Node >= 26 strips the types itself (no tsx / build / loader). The bare form `node scripts/serve.ts …` is what users and skills run.
//
// GUARD (the TS counterpart of the Python audit hook; same design as pes.ts, SEL-71 — `ts_child_guard.ts` is the same file):
//   * `--permission`: reads only below the repo and the case's temp root, writes only below the temp root, sockets allowed (the hub
//     ports 8760~8775 are refused by the loader), no child process unless a case asks (`allow_child_process`). Because the allow-list
//     holds neither /opt/homebrew nor /usr/local nor the real home, a developer PC's installed kosis / vworld / ego-browser is INVISIBLE
//     to the child: `setup.ts check` sees the same "no tools" machine everywhere.
//   * `--import ts_child_guard.ts`: reports `PESHomeAccessViolation` on stderr and blocks the hub ports (connect / fetch).
//   * the shared layers: assert_isolated_env before the spawn, assert_no_real_path on stdout / stderr, the before / after snapshot of
//     the real home (use_home_guard in each test file).
//
// DB SIDE (D02/D03): the TS server keeps no answer files. `srv_seed_project` puts a 0.15 project folder into the DB with the PR11
// importer (the way the user's migration does); `srv_answer_docs` reads the answers back from the submissions.

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FakeClock } from "../../scripts/pes_core/clock.ts";
import { CommandService } from "../../scripts/pes_core/commands.ts";
import { connect, connect_read_only, migrate } from "../../scripts/pes_core/db.ts";
import { read_storage_bytes } from "../../scripts/pes_core/files.ts";
import { db_path, objects_dir } from "../../scripts/pes_core/paths.ts";
import { assert_isolated_env, assert_no_real_path, assert_no_violation, real_homes } from "./home_guard.ts";
import { n7_text } from "./compat_normalize.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
export const SERVE_TS_FILE = join(REPO_ROOT, "scripts", "serve.ts");
export const SETUP_TS_FILE = join(REPO_ROOT, "scripts", "setup.ts");
export const TS_GUARD_MODULE = join(HERE, "ts_child_guard.ts");
export const NO_REVERSE_DNS_MODULE = join(HERE, "ts_no_reverse_dns.ts");

/** The one documented way users and skills run the TS server / installer (a test runs them bare too). */
export const BARE_SERVE = ["node", "scripts/serve.ts"] as const;
export const BARE_SETUP = ["node", "scripts/setup.ts"] as const;

/** Variable that moves the API-key screen off its fixed port 8759 (test-injected; default 8759 like setup.py KEY_PORT). */
export const KEYS_PORT_ENV = "PES_KEYS_PORT";

export interface TsSrvCtx {
  readonly home: { readonly root: string };
  readonly env: Record<string, string | undefined>;
  readonly narrow_bin: string;
  readonly pes_home: string;
  readonly home_dir: string;
}

export interface TsSrvOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  timeout_ms?: number;
  input?: string;
  /** PATH = only the case's empty folder (+ the system folder on Windows): external tools are "missing" */
  narrow_path?: boolean;
  /** default false: the child cannot spawn a process (a case that starts the key screen child says so) */
  allow_child_process?: boolean;
  /** extra readable folders (besides the repo and the case root) */
  extra_read?: string[];
  /** test-only `--import` modules after the guard */
  imports?: string[];
  /** the ONE hub port that stays open (a stand-in hub of a test) */
  allow_hub_port?: number | readonly number[];
  /** replace the script (guard self-tests run a stub instead of the real file) */
  script?: string;
  /** the protected "real homes" the guard watches; default = this account's real homes (a self-test passes a fake one) */
  real_homes?: readonly string[];
  /** guard self-test only: do not fail on a `PESHomeAccessViolation` line */
  expect_violation?: boolean;
  /** do not add `--permission` (the loader guard alone — guard self-test only) */
  no_permission?: boolean;
}

function spellings(path: string): string[] {
  const out = new Set<string>([resolve(path)]);
  try {
    out.add(realpathSync.native(path));
  } catch {
    // not created yet
  }
  return [...out];
}

/** `--allow-fs-*` values: the folder itself and everything below it, in every spelling (macOS /private, Windows 8.3 names). */
function allow(path: string): string[] {
  return spellings(path).flatMap((p) => [p, join(p, "*")]);
}

export function ts_srv_permission_flags(ctx: Pick<TsSrvCtx, "home">, options: TsSrvOptions = {}): string[] {
  const read = [REPO_ROOT, ctx.home.root, ...(options.extra_read ?? [])].flatMap(allow);
  const write = allow(ctx.home.root);
  const flags = [...read.map((p) => `--allow-fs-read=${p}`), ...write.map((p) => `--allow-fs-write=${p}`)];
  if (options.allow_child_process === true) flags.push("--allow-child-process", "--disable-warning=SecurityWarning");
  // `--allow-net` is experimental and warns on stderr (a compared value): silenced here; the user's bare command has neither flag
  flags.push("--allow-net", "--disable-warning=ExperimentalWarning");
  return ["--permission", ...flags];
}

/** `[...node flags, script, ...args]` — the argv after the node executable. */
export function ts_srv_argv(ctx: Pick<TsSrvCtx, "home">, script: string, args: string[], options: TsSrvOptions = {}): string[] {
  const imports = [TS_GUARD_MODULE, ...(options.imports ?? [])].flatMap((m) => ["--import", pathToFileURL(m).href]);
  const permission = options.no_permission === true ? [] : ts_srv_permission_flags(ctx, options);
  return [...permission, ...imports, script, ...args];
}

function guarded_homes(homes: readonly string[]): string[] {
  return [...new Set(homes.flatMap((home) => spellings(home)))];
}

export function ts_srv_env(ctx: TsSrvCtx, options: TsSrvOptions = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    ...ctx.env,
    PES_TEST_GUARD: "1",
    PES_TEST_REAL_HOME: guarded_homes(options.real_homes ?? real_homes()).join(delimiter),
    ...(options.env ?? {}),
  };
  assert.equal(env.PES_TEST_GUARD, "1", "a case env turned the home guard off (PES_TEST_GUARD)");
  for (const key of ["PES_TOKEN", "PES_DB_CORE", "NODE_OPTIONS", "NODE_PATH"]) delete env[key];
  if (options.allow_hub_port !== undefined) env.PES_TEST_ALLOW_HUB_PORT = (typeof options.allow_hub_port === "number" ? [options.allow_hub_port] : [...options.allow_hub_port]).join(",");
  if (options.narrow_path === true) {
    const extra = process.platform === "win32" ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32")] : [];
    env.PATH = [ctx.narrow_bin, ...extra].join(delimiter);
    env.Path = env.PATH;
  }
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  assert_isolated_env({ ...env, PES_OWNER: undefined, PES_HOME: env.PES_HOME ?? join(env.HOME ?? "", "pes-projects") }, options.real_homes);
  return env as NodeJS.ProcessEnv;
}

export interface TsSrvRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

let run_seq = 0;

function finish(result: { error?: Error; status: number | null; signal: NodeJS.Signals | null; stdout: unknown; stderr: unknown }, what: string, options: TsSrvOptions): TsSrvRun {
  if (result.error !== undefined) throw result.error;
  const out = { status: result.status, signal: result.signal, stdout: n7_text(String(result.stdout ?? "")), stderr: n7_text(String(result.stderr ?? "")) };
  if (options.expect_violation !== true) assert_no_violation(out.stderr, what);
  assert_no_real_path(out.stdout, "stdout", options.real_homes);
  if (options.expect_violation !== true) assert_no_real_path(out.stderr, "stderr", options.real_homes);
  return out;
}

/** Runs `node <flags> scripts/setup.ts <args…>` once, guarded. */
export function run_ts_setup(ctx: TsSrvCtx, args: (string | number)[], options: TsSrvOptions = {}): TsSrvRun {
  const argv = args.map(String);
  const script = options.script ?? SETUP_TS_FILE;
  const result = spawnSync(process.execPath, ts_srv_argv(ctx, script, argv, options), {
    env: ts_srv_env(ctx, options),
    cwd: options.cwd ?? ctx.home.root,
    encoding: "utf8",
    input: options.input,
    timeout: options.timeout_ms ?? 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return finish(result, `${relative(REPO_ROOT, script)} ${argv.join(" ")}`, options);
}

export interface TsSrvLive {
  readonly proc: ChildProcess;
  /** everything written so far, stdout and stderr kept apart */
  out(): string;
  err(): string;
  /** resolves with the exit status when the child ends */
  exited: Promise<{ status: number | null; signal: NodeJS.Signals | null }>;
  kill(): void;
}

/** Async twin for a child that lives on (the key screen, `keys --wait`). The caller kills it. */
export function spawn_ts_setup(ctx: TsSrvCtx, args: (string | number)[], options: TsSrvOptions = {}): TsSrvLive {
  const argv = args.map(String);
  const script = options.script ?? SETUP_TS_FILE;
  const proc = spawn(process.execPath, ts_srv_argv(ctx, script, argv, options), { env: ts_srv_env(ctx, options), cwd: options.cwd ?? ctx.home.root, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  proc.stdout?.setEncoding("utf8").on("data", (c: string) => (out += c));
  proc.stderr?.setEncoding("utf8").on("data", (c: string) => (err += c));
  const exited = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((done) => {
    proc.once("close", (status, signal) => done({ status, signal }));
    proc.once("error", () => done({ status: null, signal: null }));
  });
  return { proc, out: () => n7_text(out), err: () => n7_text(err), exited, kill: () => void proc.kill() };
}

/** Runs the bare, unguarded user form `node scripts/<file>.ts …` (cwd = repo, so the relative path is true). Isolated env only. */
export function run_ts_bare(ctx: TsSrvCtx, bare: readonly string[], args: string[], options: Pick<TsSrvOptions, "env" | "timeout_ms" | "narrow_path"> = {}): TsSrvRun {
  const env = ts_srv_env(ctx, { env: options.env, narrow_path: options.narrow_path });
  const result = spawnSync(process.execPath, [bare[1] as string, ...args], { env, cwd: REPO_ROOT, encoding: "utf8", timeout: options.timeout_ms ?? 60_000 });
  return finish(result, `${bare.join(" ")} ${args.join(" ")}`, {});
}

// ---------------------------------------------------------------- the server child
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

export interface TsServeOptions {
  /** executable instead of node (a missing one exercises the spawn-error path) */
  command?: string;
  script?: string;
  expected_root?: string;
  ready_timeout_ms?: number;
  extra_env?: Record<string, string | undefined>;
  imports?: string[];
  real_homes?: readonly string[];
  expect_violation?: boolean;
  /** use this port instead of a free one (the port must not be in the hub range 8760~8775) */
  port?: number;
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

/** Same surface as the Python harness's ServeProcess (start / stop / request / post / origin), for `scripts/serve.ts`. */
export class TsServeProcess {
  port = 0;
  proc: ChildProcess | undefined;
  log = "";
  readonly children: ChildProcess[] = [];
  private spawn_error: Error | undefined;
  readonly ctx: TsSrvCtx;
  readonly root: string;
  readonly options: TsServeOptions;
  readonly hub_log: string;
  readonly dns_log: string;
  constructor(ctx: TsSrvCtx, root: string, options: TsServeOptions = {}) {
    this.ctx = ctx;
    this.root = root;
    this.options = options;
    const n = run_seq++;
    this.hub_log = join(ctx.home.root, `hub-attempts-${n}.log`);
    this.dns_log = join(ctx.home.root, `dns-attempts-${n}.log`);
  }

  origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** hub ports (8760~8775) the child tried to reach and was refused */
  hub_attempts(): number[] {
    return existsSync(this.hub_log) ? readFileSync(this.hub_log, "utf8").split("\n").filter((x) => x !== "").map(Number) : [];
  }

  /** reverse-DNS / host-name lookups the child made (must stay empty) */
  dns_attempts(): string[] {
    return existsSync(this.dns_log) ? readFileSync(this.dns_log, "utf8").split("\n").filter((x) => x !== "") : [];
  }

  /** the argv this object spawns for a port (a unit test pins the guard flags) */
  argv(port: number): string[] {
    const script = this.options.script ?? SERVE_TS_FILE;
    return ts_srv_argv(this.ctx, script, [this.root, String(port)], { imports: [NO_REVERSE_DNS_MODULE, ...(this.options.imports ?? [])] });
  }

  async start(): Promise<this> {
    const errors: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      this.port = this.options.port ?? (await free_port());
      this.log = "";
      const env = ts_srv_env(this.ctx, { env: { ...(this.options.extra_env ?? {}), PES_TEST_HUB_LOG: this.hub_log, PES_TEST_DNS_LOG: this.dns_log }, real_homes: this.options.real_homes });
      this.spawn_error = undefined;
      const proc = spawn(this.options.command ?? process.execPath, this.argv(this.port), { env, stdio: ["ignore", "pipe", "pipe"], cwd: this.ctx.home.root });
      this.proc = proc;
      this.children.push(proc);
      proc.once("error", (error) => {
        this.spawn_error = error;
      });
      proc.stdout?.on("data", (chunk: Buffer) => (this.log += chunk.toString("utf8")));
      proc.stderr?.on("data", (chunk: Buffer) => (this.log += chunk.toString("utf8")));
      if (await this.wait_ready()) return this;
      if (this.options.expect_violation !== true) assert_no_violation(this.log, "serve.ts start-up");
      errors.push(`port ${this.port}: readiness timeout\n${this.log}`);
      await this.stop();
      if (this.options.port !== undefined || this.options.expect_violation === true) break;
    }
    throw new Error(`serve.ts did not start:\n${errors.join("\n")}`);
  }

  private async wait_ready(): Promise<boolean> {
    const deadline = Date.now() + (this.options.ready_timeout_ms ?? 15_000);
    while (Date.now() < deadline) {
      if (this.spawn_error !== undefined || this.proc === undefined || this.proc.exitCode !== null || this.proc.signalCode !== null) return false;
      try {
        const response = await fetch(`${this.origin()}/whoami`, { signal: AbortSignal.timeout(500) });
        const info = (await response.json()) as { root?: string; single?: boolean };
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
      if (this.options.expect_violation !== true) assert_no_violation(this.log, "serve.ts");
      return;
    }
    await new Promise<void>((done) => {
      const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
      proc.once("exit", () => {
        clearTimeout(timer);
        done();
      });
      proc.kill();
    });
    if (this.options.expect_violation !== true) assert_no_violation(this.log, "serve.ts");
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
    return { status: response.status, headers, body, text: () => body.toString("utf8"), json: () => JSON.parse(body.toString("utf8")) };
  }

  /** POST a JSON object (or raw bytes); `origin` null sends no Origin header. */
  async post(path: string, payload: unknown, origin: string | null = this.origin(), extra_headers: Record<string, string> = {}): Promise<HttpResult> {
    const body = payload instanceof Uint8Array ? payload : Buffer.from(JSON.stringify(payload), "utf8");
    const headers: Record<string, string> = { "content-type": "application/json", ...extra_headers };
    if (origin !== null) headers.origin = origin;
    return this.request(path, { method: "POST", body, headers });
  }
}

// ---------------------------------------------------------------- DB side: seed (legacy folder → DB) and read the answers back
export const OWNER_SLUG = "pes-compat-owner";

function open_service(ctx: TsSrvCtx): { service: CommandService; close(): void; owner_actor_id: string } {
  const file = db_path(ctx.env);
  mkdirSync(dirname(file), { recursive: true });
  const db = connect(file);
  migrate(db);
  const objects = objects_dir(ctx.env);
  mkdirSync(objects, { recursive: true });
  const service = new CommandService(db, { clock: new FakeClock(Date.now()), policy: { check: () => ({ allowed: true }) }, objects_dir: objects });
  const row = db.get<{ owner_user_id: string }>("SELECT owner_user_id FROM projects WHERE slug = ?", OWNER_SLUG);
  return {
    service,
    close: () => db.close(),
    owner_actor_id: row === undefined ? "" : (db.get<{ id: string }>("SELECT id FROM actors WHERE user_id = ? AND kind = 'human' ORDER BY rowid LIMIT 1", row.owner_user_id)?.id ?? ""),
  };
}

let copy_seq = 0;

/** The importer needs `slug` in project.json (0.15 init always wrote it; a hand-written fixture may not): such a folder is imported from a copy. */
function importable_copy(ctx: TsSrvCtx, folder: string): string {
  const slug = folder.split(/[\\/]/).filter((x) => x !== "").pop() as string;
  let data: { slug?: unknown } | undefined;
  try {
    data = JSON.parse(readFileSync(join(folder, "project.json"), "utf8")) as { slug?: unknown };
  } catch {
    return folder;
  }
  if (data !== null && typeof data === "object" && data.slug === slug) return folder;
  const copy = join(dirname(ctx.pes_home), "ts-seed-copy", String(copy_seq++), slug);
  mkdirSync(dirname(copy), { recursive: true });
  cpSync(folder, copy, { recursive: true });
  writeFileSync(join(copy, "project.json"), JSON.stringify({ ...(data as object), slug }), "utf8");
  return copy;
}

/**
 * Puts a 0.15 project folder into the DB of the ctx's isolated home, the way the user's migration does (import → validate → activate,
 * PR11/PR12), under the slug = the folder name. The folder is not changed. A hidden owner project is created when the DB has none.
 */
export async function srv_seed_project(ctx: TsSrvCtx, folder: string): Promise<{ project_id: string; slug: string }> {
  const source = importable_copy(ctx, folder);
  const legacy = await import("../../scripts/pes_core/legacy.ts");
  const migration = await import("../../scripts/pes_core/migration.ts");
  let opened = open_service(ctx);
  try {
    if (opened.owner_actor_id === "") {
      const out = await opened.service.execute({ project_id: null, actor_id: null, via: "cli", client_request_id: "compat-owner" }, "project.bootstrap", { slug: OWNER_SLUG, topic: "합성 소유자 프로젝트", owner_display_name: "합성 소유자" });
      opened.close();
      opened = open_service(ctx);
      assert.equal((out.result as { owner_actor_id: string }).owner_actor_id, opened.owner_actor_id);
    }
    const imp = await legacy.import_project(opened.service, source, { owner_actor_id: opened.owner_actor_id });
    assert.equal(imp.state, "staging", `seed: ${folder} did not import cleanly (${JSON.stringify(imp.report.entries.slice(0, 3))})`);
    const val = await migration.validate_import(opened.service, imp.batch_id, { owner_actor_id: opened.owner_actor_id, source_dir: source });
    assert.equal(val.ok, true, `seed: validation failed ${JSON.stringify(val.report.problems.slice(0, 3))}`);
    const backup = join(dirname(db_path(ctx.env)), "backups", `compat-${imp.batch_id}`);
    await migration.activate_import(opened.service, imp.batch_id, { owner_actor_id: opened.owner_actor_id, backup_dir: backup, pes_home: ctx.pes_home });
    return { project_id: imp.project_id, slug: folder.split(/[\\/]/).filter((x) => x !== "").pop() as string };
  } finally {
    opened.close();
  }
}

export interface AnswerDoc {
  /** the name the DB gave the answer (what `file` in the HTTP answer says) */
  name: string;
  /** the raw record the server stored: stage, round, time, kind, text, answers, spec, via, origin, who (+ id, set_id) */
  doc: Record<string, any>;
}

/** Every web answer of a project, in arrival order, read from the DB (read-only connection) — D03: submissions instead of feedback/*.json. */
export function srv_answer_docs(ctx: TsSrvCtx, slug: string): AnswerDoc[] {
  const file = db_path(ctx.env);
  if (!existsSync(file)) return [];
  const db = connect_read_only(file);
  try {
    const project = db.get<{ id: string }>("SELECT id FROM projects WHERE slug = ?", slug);
    if (project === undefined) return [];
    const rows = db.all<{ name: string | null; storage_key: string | null }>(
      `SELECT b.original_name AS name, b.storage_key AS storage_key FROM submissions s
         JOIN blobs b ON b.project_id = s.project_id AND b.id = s.raw_blob_id
        WHERE s.project_id = ? ORDER BY s.rowid`,
      project.id,
    );
    return rows
      .filter((row) => row.name !== null && row.storage_key !== null)
      .map((row) => ({ name: row.name as string, doc: JSON.parse(new TextDecoder().decode(read_storage_bytes(objects_dir(ctx.env), project.id, row.storage_key as string))) as Record<string, any> }));
  } finally {
    db.close();
  }
}

/** The DB-only parts of a stored answer that 0.15's file never had (D03): dropped before the file digest is compared. */
export function strip_db_ids(doc: Record<string, any>): Record<string, any> {
  const { id: _id, set_id: _set, ...rest } = doc;
  return rest;
}

// ---------------------------------------------------------------- adapting a ts setup.ts result to the 0.15 record (D12)
export const TS_SETUP_USAGE_LINE = "사용: node scripts/setup.ts <명령>";
export const PY_SETUP_USAGE_LINE = "사용: python3 -I setup.py <명령>";

/**
 * D12 — the two places where setup.ts is not a copy of setup.py, written down once:
 *   1. the usage text names the TS command (`node scripts/setup.ts`) instead of `python3 -I setup.py`;
 *   2. `check` has no `python` row: PES TS needs no Python (docs/plan/migration-ts-equivalence.md 9.1); the `node` row is the runtime check.
 * Everything else must be 0.15's. The adapter ASSERTS both facts first (so a worker cannot fake them away), then writes the 0.15
 * spelling back so the one comparison with the 0.15 baseline stays byte-for-byte.
 */
export function adapt_ts_setup_stdout(args: readonly string[], stdout: string): string {
  if (stdout.includes(TS_SETUP_USAGE_LINE)) return stdout.replace(TS_SETUP_USAGE_LINE, PY_SETUP_USAGE_LINE);
  if (args[0] === "check" && args.includes("--json")) {
    const rows = JSON.parse(stdout) as Array<Record<string, unknown>>;
    assert.ok(!rows.some((row) => row.name === "python"), "setup.ts check must not report a python row (D12)");
    const py = { name: "python", state: "ok", label: "Python 3.9", detail: "", group: "기본" };
    return `${JSON.stringify([py, ...rows], null, 1)}\n`;
  }
  return stdout;
}

/** D03 — feedback.log of the TS server names the answer (`FEEDBACK plan R2 feedback plan-R2-<time>.json`); 0.15 wrote the path. */
export function adapt_ts_feedback_log(text: string, project_dir: string): string {
  return text
    .split("\n")
    .map((line) => {
      const m = /^(FEEDBACK \S+ R-?\d+ \S+ )(\S+)$/.exec(line);
      if (m === null) return line;
      assert.ok(!/[\\/]/.test(m[2] as string), `feedback.log line must name the answer, not a path: ${line}`);
      return `${m[1]}${join(project_dir, "feedback", m[2] as string)}`;
    })
    .join("\n");
}

/**
 * D08 — the one place `doctor --json` is not a copy of 0.15, written down once: the environment group has no `Python <version>` row
 * (PES TS runs no Python) and has exactly one `Node <version>` row (level ok, empty detail, not fixable) instead. The adapter ASSERTS
 * that first (so a worker cannot fake it away), then writes the 0.15 row back at the same place so one comparison with the baseline
 * stays whole. The tool rows (`도구`) are per PC and are dropped by the case's `doctor_schema` post-processor.
 */
export function adapt_ts_doctor_stdout(args: readonly string[], stdout: string): string {
  if (!args.includes("--json")) return stdout;
  assert.ok(stdout.trim() !== "", "doctor --json printed nothing (exit code / stderr tell why)");
  const rows = JSON.parse(stdout) as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(rows), "doctor --json prints an array of rows");
  assert.ok(!rows.some((row) => /^Python\b/.test(String(row.title))), "doctor (ts) must not report a Python row (D08)");
  const node = rows.filter((row) => row.group === "환경" && /^Node \d+\.\d+\.\d+/.test(String(row.title)));
  assert.equal(node.length, 1, `doctor (ts) reports exactly one "Node <version>" row in the environment group (D08), got ${JSON.stringify(rows.map((r) => r.title))}`);
  assert.deepEqual({ level: node[0]?.level, detail: node[0]?.detail, fixable: node[0]?.fixable }, { level: "ok", detail: "", fixable: false }, "the Node row is a plain ok row (D08)");
  const back = rows.map((row) => (row === node[0] ? { ...row, title: "Python 3.9.0" } : row));
  return `${JSON.stringify(back, null, 1)}\n`;
}

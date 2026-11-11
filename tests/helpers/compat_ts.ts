// The TypeScript target of the compat harness (SEL-71, PR26b): how `scripts/pes.ts` is run, guarded and observed.
//
// RUN METHOD (fixed by tests/test_pes_ts_contract.test.ts — decided in SEL-71, no other runner is allowed):
//
//     node [--permission …] [--import tests/helpers/ts_child_guard.ts] scripts/pes.ts <command> <args…>
//
//   Node >= 26 strips the types itself: no tsx, no build step, no loader, no shebang trick. Under `npm test` the guard flags are
//   added by `ts_child_argv`; users and skills call the bare `node scripts/pes.ts …`, which the same test also runs (usage + exit).
//
// GUARD (the TS counterpart of the Python audit hook, PR26a README "TS 자식 가드는 PR26b 몫"):
//   * `--permission` with an allow-list that does NOT contain the real home: reads only below the repo and the case's temp root,
//     writes only below the temp root, sockets allowed (the hub ports are refused by the loader), no child processes / workers / addons (a case that needs a child says so with
//     `allow_child_process`). A read of the real ~/.pes or ~/pes-projects is denied by Node itself (ERR_ACCESS_DENIED).
//   * `--import tests/helpers/ts_child_guard.ts` — REPORTS an attempt (stderr `PESHomeAccessViolation`) even when the product code
//     catches the denial, and blocks the hub ports 8760~8775 (HUB_BLOCK, Python parity). `assert_no_violation` turns the stderr line
//     into a test failure; the hub attempts are counted through PES_TEST_HUB_LOG.
//   * the three layers shared with Python children: assert_isolated_env before the spawn, the before/after snapshot of the real
//     home (use_home_guard) and assert_no_real_path on stdout / stderr.
//
// STATE (D02/D03/D04 devices): the TS side has no project.json. `ts_seed_legacy` puts a 0.15 project folder into the DB with the PR11
// importer (the design of docs/plan/migration-ts-equivalence.md 7.1); `ts_view` reads the project back from the DB with the
// production read model (`build_project_view`, the same one the DB-mode CLI prints from) and returns the state DTO (D02), the
// answers (D03: `feedback/*.json` ↔ submissions) and the lock owner (D04: `.pes-lock` ↔ project_leases).

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FakeClock } from "../../scripts/pes_core/clock.ts";
import { CommandService } from "../../scripts/pes_core/commands.ts";
import { connect, connect_read_only, migrate } from "../../scripts/pes_core/db.ts";
import { db_path, objects_dir } from "../../scripts/pes_core/paths.ts";
import { build_project_view } from "../../scripts/pes_core/legacy_view.ts";
import { account_home, assert_isolated_env, assert_no_real_path, assert_no_violation, real_homes } from "./home_guard.ts";
import { HUB_PORT_FIRST, HUB_PORT_LAST } from "./hub_block.ts";
import { n7_text } from "./compat_normalize.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
export const TS_GUARD_MODULE = join(HERE, "ts_child_guard.ts");
export const TS_INJECT_MODULE = join(HERE, "ts_inject_fs.ts");
export const PES_TS_FILE = join(REPO_ROOT, "scripts", "pes.ts");

/** The one documented way users and skills run the TS CLI (a test runs it unguarded too). */
export const BARE_COMMAND = ["node", "scripts/pes.ts"] as const;

export interface TsRunOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  timeout_ms?: number;
  input?: string;
  /** PATH = only the case's empty folder (+ the system folder on Windows): external tools are "missing" */
  narrow_path?: boolean;
  /** folders (besides the repo and the case root) the child may read — e.g. the narrowed PATH entries */
  extra_read?: string[];
  /** a case that must start a process (serve / open) says so; default: the child cannot spawn */
  allow_child_process?: boolean;
  /** `--allow-net` (default true): Node's permission model denies sockets otherwise, which would hide the hub block behind ERR_ACCESS_DENIED; the hub ports are refused by ts_child_guard.ts either way */
  allow_net?: boolean;
  /** the ONE hub port that stays open (stand-in hub of a test) */
  allow_hub_port?: number | readonly number[];
  /** test-only `--import` modules after the guard (the SEL-75 injection) */
  imports?: string[];
  /** replace the script (guard self-tests run a stub instead of scripts/pes.ts) */
  script?: string;
  /** do not add `--permission` (the loader guard alone — only the guard self-test compares both nets) */
  no_permission?: boolean;
  /** the protected "real homes" the guard watches; default = this account's real homes (a self-test passes a fake one) */
  real_homes?: readonly string[];
  /** guard self-test only: do not fail on a `PESHomeAccessViolation` line — the test reads it from stderr itself */
  expect_violation?: boolean;
}

export interface TsCtxLike {
  readonly home: { readonly root: string };
  readonly env: Record<string, string | undefined>;
  readonly narrow_bin: string;
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

/** `--allow-fs-read` / `--allow-fs-write` values: the folder itself and everything below it, in every spelling (macOS /private, 8.3 names). */
function allow(path: string): string[] {
  return spellings(path).flatMap((p) => [p, join(p, "*")]);
}

export function ts_permission_flags(ctx: TsCtxLike, options: TsRunOptions = {}): string[] {
  const read = [REPO_ROOT, ctx.home.root, ...(options.extra_read ?? [])].flatMap(allow);
  const write = [ctx.home.root].flatMap(allow);
  const flags = [...read.map((p) => `--allow-fs-read=${p}`), ...write.map((p) => `--allow-fs-write=${p}`)];
  if (options.allow_child_process === true) flags.push("--allow-child-process", "--disable-warning=SecurityWarning");
  // `--allow-net` is experimental and prints a warning on stderr; the stderr of a case is a compared value, so the warning is silenced
  // (test-only flags — the user's bare `node scripts/pes.ts` has neither flag, and test_pes_ts_contract runs it bare and expects clean stderr)
  if (options.allow_net !== false) flags.push("--allow-net", "--disable-warning=ExperimentalWarning");
  return ["--permission", ...flags];
}

/** `[...node flags, script, ...args]` — the argv after the node executable. */
export function ts_child_argv(ctx: TsCtxLike, args: string[], options: TsRunOptions = {}): string[] {
  const imports = [TS_GUARD_MODULE, ...(options.imports ?? [])].flatMap((m) => ["--import", pathToFileURL(m).href]);
  const permission = options.no_permission === true ? [] : ts_permission_flags(ctx, options);
  return [...permission, ...imports, options.script ?? PES_TS_FILE, ...args];
}

/** Every spelling of the protected homes, resolved HERE: under `--permission` the child cannot realpath a folder outside its allow-list. */
function guarded_homes(homes: readonly string[]): string[] {
  return [...new Set(homes.flatMap((home) => spellings(home)))];
}

export function ts_child_env(ctx: TsCtxLike, options: TsRunOptions = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    ...ctx.env,
    PES_TEST_GUARD: "1",
    PES_TEST_REAL_HOME: guarded_homes(options.real_homes ?? real_homes()).join(delimiter),
    ...(options.env ?? {}),
  };
  assert.equal(env.PES_TEST_GUARD, "1", "a case env turned the home guard off (PES_TEST_GUARD)");
  // like the Python side: no flag, token or owner leaks in, PES_OWNER only per call through options.env
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

export interface TsRunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** hub ports the child tried to reach and was refused (PES_TEST_HUB_LOG) */
  hub_attempts: number[];
}

let hub_log_seq = 0;

function finish(result: ReturnType<typeof spawnSync>, what: string, hub_log: string, options: TsRunOptions): TsRunResult {
  if (result.error !== undefined) throw result.error;
  const out = { stdout: n7_text(String(result.stdout ?? "")), stderr: n7_text(String(result.stderr ?? "")) };
  if (options.expect_violation !== true) assert_no_violation(out.stderr, what);
  assert_no_real_path(out.stdout, "stdout", options.real_homes);
  if (options.expect_violation !== true) assert_no_real_path(out.stderr, "stderr", options.real_homes);
  const attempts = existsSync(hub_log) ? readFileSync(hub_log, "utf8").split("\n").filter((x) => x !== "").map(Number) : [];
  return { status: result.status, signal: result.signal, ...out, hub_attempts: attempts };
}

/** Runs `node <flags> scripts/pes.ts <args…>` once, guarded. The file must exist (callers check `ts_cli_exists`). */
export function run_ts_cli(ctx: TsCtxLike, args: (string | number)[], options: TsRunOptions = {}): TsRunResult {
  const argv = args.map(String);
  const hub_log = join(ctx.home.root, `hub-attempts-${hub_log_seq++}.log`);
  const env = ts_child_env(ctx, { ...options, env: { ...(options.env ?? {}), PES_TEST_HUB_LOG: hub_log } });
  const result = spawnSync(process.execPath, ts_child_argv(ctx, argv, options), {
    env,
    cwd: options.cwd ?? ctx.home.root,
    encoding: "utf8",
    input: options.input,
    timeout: options.timeout_ms ?? 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return finish(result, `${relative(REPO_ROOT, options.script ?? PES_TS_FILE)} ${argv.join(" ")}`, hub_log, options);
}

/** Async twin for genuinely concurrent children (the SEL-75 concurrent-set scenario). */
export function run_ts_cli_async(ctx: TsCtxLike, args: (string | number)[], options: TsRunOptions = {}): Promise<TsRunResult> {
  const argv = args.map(String);
  const hub_log = join(ctx.home.root, `hub-attempts-${hub_log_seq++}.log`);
  const env = ts_child_env(ctx, { ...options, env: { ...(options.env ?? {}), PES_TEST_HUB_LOG: hub_log } });
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, ts_child_argv(ctx, argv, options), { env, cwd: options.cwd ?? ctx.home.root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status, signal) => {
      try {
        done(finish({ status, signal, stdout, stderr, pid: 0, output: [], error: undefined } as unknown as ReturnType<typeof spawnSync>, `scripts/pes.ts ${argv.join(" ")}`, hub_log, options));
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** The unguarded user-facing form `node scripts/pes.ts …` (cwd = repo, so the relative path of BARE_COMMAND is true). Isolated env only. */
export function run_ts_bare(ctx: TsCtxLike, args: string[], options: Pick<TsRunOptions, "env" | "timeout_ms"> = {}): TsRunResult {
  const env = ts_child_env(ctx, { env: options.env });
  const result = spawnSync(process.execPath, [BARE_COMMAND[1], ...args], { env, cwd: REPO_ROOT, encoding: "utf8", timeout: options.timeout_ms ?? 60_000 });
  return finish(result, `node scripts/pes.ts ${args.join(" ")}`, join(ctx.home.root, "no-hub-log"), {});
}

export function ts_cli_exists(exists: (path: string) => boolean = existsSync): boolean {
  return exists(PES_TS_FILE);
}

// ---------------------------------------------------------------- DB side: seed (legacy folder → DB) and read model

export interface TsHome {
  readonly env: Record<string, string | undefined>;
  readonly pes_home: string;
  readonly home_dir: string;
}

/** The owner project of a seeded database: the importer needs an existing human owner, so one hidden bootstrap project provides it. */
export const OWNER_SLUG = "pes-compat-owner";

function open_service(home: TsHome): { service: CommandService; close(): void; owner_actor_id: string } {
  const file = db_path(home.env);
  mkdirSync(dirname(file), { recursive: true });
  const db = connect(file);
  migrate(db);
  const objects = objects_dir(home.env);
  mkdirSync(objects, { recursive: true });
  const service = new CommandService(db, { clock: new FakeClock(Date.now()), policy: { check: () => ({ allowed: true }) }, objects_dir: objects });
  const row = db.get<{ owner_user_id: string; id: string }>("SELECT id, owner_user_id FROM projects WHERE slug = ?", OWNER_SLUG);
  return {
    service,
    close: () => db.close(),
    owner_actor_id: row === undefined ? "" : (db.get<{ id: string }>("SELECT id FROM actors WHERE user_id = ? AND kind = 'human' ORDER BY rowid LIMIT 1", row.owner_user_id)?.id ?? ""),
  };
}

/**
 * Puts a 0.15 project folder (project.json [+ library.json, feedback/]) into the DB exactly like the user's migration does:
 * import → validate → activate (PR11/PR12), under the slug = the folder's name. The folder is never changed. A hidden owner project
 * (OWNER_SLUG) is created first when the database has none. Cases that print every project (`list`, `hub`, `doctor`) must not seed.
 */
let seed_copy_seq = 0;

/**
 * The importer cannot migrate a project.json without a `slug` (0.15's init always wrote one; the minimal hand-written fixtures of E10 /
 * E12 do not). The folder itself is never touched, so such a fixture is imported from a COPY whose project.json has `slug` = the folder
 * name — the same name the CLI finds the project by (the 0.15 `pdir` rule).
 */
function importable_copy(home: TsHome, folder: string): string {
  const slug = String(folder).split(/[\\/]/).filter((x) => x !== "").pop() as string;
  let data: { slug?: unknown } | undefined;
  try {
    data = JSON.parse(readFileSync(join(folder, "project.json"), "utf8")) as { slug?: unknown };
  } catch {
    return folder; // not JSON: the importer reports it
  }
  if (data !== null && typeof data === "object" && data.slug === slug) return folder;
  const copy = join(dirname(home.pes_home), "ts-seed-copy", String(seed_copy_seq++), slug);
  mkdirSync(dirname(copy), { recursive: true });
  cpSync(folder, copy, { recursive: true });
  writeFileSync(join(copy, "project.json"), JSON.stringify({ ...(data as object), slug }), "utf8");
  return copy;
}

export async function ts_seed_legacy(home: TsHome, original: string): Promise<{ project_id: string; slug: string }> {
  const folder = importable_copy(home, original);
  const legacy = await import("../../scripts/pes_core/legacy.ts");
  const migration = await import("../../scripts/pes_core/migration.ts");
  let opened = open_service(home);
  try {
    if (opened.owner_actor_id === "") {
      const out = await opened.service.execute({ project_id: null, actor_id: null, via: "cli", client_request_id: "compat-owner" }, "project.bootstrap", { slug: OWNER_SLUG, topic: "합성 소유자 프로젝트", owner_display_name: "합성 소유자" });
      opened.close();
      opened = open_service(home);
      assert.equal((out.result as { owner_actor_id: string }).owner_actor_id, opened.owner_actor_id);
    }
    const imp = await legacy.import_project(opened.service, folder, { owner_actor_id: opened.owner_actor_id });
    assert.equal(imp.state, "staging", `ts seed: ${folder} did not import cleanly (${JSON.stringify(imp.report.entries.slice(0, 3))})`);
    const val = await migration.validate_import(opened.service, imp.batch_id, { owner_actor_id: opened.owner_actor_id, source_dir: folder });
    assert.equal(val.ok, true, `ts seed: validation failed ${JSON.stringify(val.report.problems.slice(0, 3))}`);
    const backup = join(dirname(db_path(home.env)), "backups", `compat-${imp.batch_id}`);
    await migration.activate_import(opened.service, imp.batch_id, { owner_actor_id: opened.owner_actor_id, backup_dir: backup, pes_home: home.pes_home });
    return { project_id: imp.project_id, slug: String(original).split(/[\\/]/).filter((x) => x !== "").pop() as string };
  } finally {
    opened.close();
  }
}

export interface TsView {
  /** the 0.15-shaped project (project.json + library) the DB-mode CLI prints from — input of dto_from_project_json */
  project: any;
  /** D03: every answer as {stage, round, kind, text} — what `feedback/*.json` held, minus file names and times */
  answers: Array<{ stage: string; round: number; kind: string; text: string }>;
  /** D03: answer texts not yet processed */
  pending_texts: string[];
  /** D03: the names the DB gave the pending answers (what `mark` takes) */
  pending_names: string[];
  /** D04: the live lock owner label (PES_OWNER session / agent run), or null */
  lock: { owner: string } | null;
}

/** Reads one project from the DB of `home` (read-only connection). Missing project / database → undefined. */
export function ts_view(home: TsHome, slug: string): TsView | undefined {
  const file = db_path(home.env);
  if (!existsSync(file)) return undefined;
  const db = connect_read_only(file);
  try {
    const row = db.get<{ id: string }>("SELECT id FROM projects WHERE slug = ?", slug);
    if (row === undefined) return undefined;
    const view = build_project_view(db, row.id, objects_dir(home.env));
    const project = view.project as any;
    // the live lease and the session label it was claimed with (runs.external_session_ref — PES_OWNER); the read model does not carry it
    const lease = db.get<{ session: string | null; run_id: string }>(
      "SELECT r.external_session_ref AS session, l.run_id AS run_id FROM project_leases l JOIN runs r ON r.project_id = l.project_id AND r.id = l.run_id WHERE l.project_id = ? AND l.state = 'active' AND l.expires_at > ?",
      row.id,
      BigInt(Date.now()),
    );
    const lock = lease === undefined ? null : { owner: lease.session ?? `agent-run:${lease.run_id}` };
    return {
      project,
      answers: view.feedback.map((f: any) => ({ stage: String(f.stage), round: Number(f.round), kind: String(f.kind), text: String(f.text) })),
      pending_texts: view.pending.map((p) => p.text),
      pending_names: view.pending.map((p) => p.name),
      lock,
    };
  } finally {
    db.close();
  }
}

/** Sorted, order-free form of the answers (N4 multiset): file names and write order are not part of the contract. */
export function answers_multiset(answers: ReadonlyArray<{ stage: string; round: number; kind: string; text: string }>): string[] {
  return answers.map((a) => JSON.stringify([a.stage, a.round, a.kind, a.text])).sort();
}

/** Backdates the live lease of a project by `seconds` (the harness plays the clock, like `age_lock` rewrites `.pes-lock`). */
export function ts_age_lease(home: TsHome, slug: string, seconds: number): void {
  const file = db_path(home.env);
  const db = connect(file);
  try {
    const project = db.get<{ id: string }>("SELECT id FROM projects WHERE slug = ?", slug);
    assert.ok(project, `ts_age_lease: no project ${slug}`);
    const lease = db.get<{ acquired_at: bigint; heartbeat_at: bigint; expires_at: bigint }>("SELECT acquired_at, heartbeat_at, expires_at FROM project_leases WHERE project_id = ?", project.id);
    assert.ok(lease, `ts_age_lease: ${slug} holds no lease`);
    const shift = BigInt(Math.round(seconds * 1000));
    db.run("UPDATE project_leases SET acquired_at = ?, heartbeat_at = ?, expires_at = ? WHERE project_id = ?", lease.acquired_at - shift, lease.heartbeat_at - shift, lease.expires_at - shift, project.id);
  } finally {
    db.close();
  }
}

/**
 * D03 seed: an answer a person sent from the browser (`web_feedback` of the production bridge — the same call scripts/serve.py makes for
 * `POST …/feedback`) lands in the DB as a submission. Run as the production child, guarded like pes.ts. The stage/round/kind/text are
 * what the 0.15 `feedback/*.json` file holds.
 */
export function ts_seed_feedback(ctx: TsCtxLike & TsHome, slug: string, answer: { stage: string; round: number; kind: string; text: string }): void {
  const bridge = join(REPO_ROOT, "scripts", "pes_core", "cli_bridge.ts");
  const request = JSON.stringify({ op: "web_feedback", slug, session: null, token: null, args: { stage: answer.stage, round: answer.round, kind: answer.kind, text: answer.text } });
  const result = run_ts_cli(ctx, [], { script: bridge, input: request });
  const reply = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}") as { ok?: boolean; message?: string };
  assert.equal(reply.ok, true, `ts seed: web_feedback for ${slug} failed: ${reply.message ?? result.stderr}`);
}

/** E11: the harness moved a project folder to another name; the DB project follows the folder name (the 0.15 `pdir` rule). */
export function ts_rename_slug(home: TsHome, from: string, to: string): void {
  const file = db_path(home.env);
  if (!existsSync(file)) return;
  const db = connect(file);
  try {
    if (db.get("SELECT 1 AS x FROM projects WHERE slug = ?", from) === undefined) return; // not a DB project (an old project.json folder)
    db.run("UPDATE projects SET slug = ? WHERE slug = ?", to, from);
  } finally {
    db.close();
  }
}

export function write_text(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

export { real_homes };
export const HUB_PORTS = { first: HUB_PORT_FIRST, last: HUB_PORT_LAST } as const;

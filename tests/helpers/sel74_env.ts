// SEL-74 (PR26e) shared test tools. Everything is synthetic; every child runs in a temporary HOME / USERPROFILE / PES_HOME,
// behind the TS child guard (ts_child_guard.ts: real-home reads + hub ports blocked). Nothing here reads the real ~/.pes,
// ~/pes-projects or ~/.claude.

import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { make_ctx, type CompatCtx } from "./compat_env.ts";
import { run_ts_cli, run_ts_cli_async, type TsRunOptions, type TsRunResult } from "./compat_ts.ts";
import { tree_digest, tree_entries } from "./legacy_env.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..");
export const LEGACY_FIXTURES = join(REPO, "tests", "fixtures", "legacy");

export function read_rel(rel: string): string {
  return readFileSync(join(REPO, ...rel.split("/")), "utf8").replace(/\r\n/g, "\n");
}

export function has_rel(rel: string): boolean {
  return existsSync(join(REPO, ...rel.split("/")));
}

/** Every file below `dir` (repo-relative POSIX paths), skipping dependency / VCS / virtualenv folders. */
export function repo_files(dir = "", skip: readonly string[] = ["node_modules", ".git", ".venv", "test-results", "playwright-report"]): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (skip.includes(entry.name)) continue;
      const full = join(abs, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(REPO, full).replace(/\\/g, "/"));
    }
  };
  walk(join(REPO, ...dir.split("/").filter((x) => x !== "")));
  return out.sort();
}

export async function with_ctx(prefix: string, fn: (ctx: CompatCtx) => Promise<void> | void): Promise<void> {
  const ctx = make_ctx(prefix);
  try {
    await fn(ctx);
  } finally {
    ctx.cleanup();
  }
}

/** `node … scripts/pes.ts <args>` behind the guard, in the context's isolated home. */
export function pes_ts(ctx: CompatCtx, args: (string | number)[], options: TsRunOptions = {}): TsRunResult {
  return run_ts_cli(ctx, args, { timeout_ms: 120_000, ...options });
}

/** The async twin: needed whenever the test process itself must answer the child (a stand-in server) — spawnSync would block it. */
export function pes_ts_async(ctx: CompatCtx, args: (string | number)[], options: TsRunOptions = {}): Promise<TsRunResult> {
  return run_ts_cli_async(ctx, args, { timeout_ms: 120_000, ...options });
}

/**
 * A 0.15 project folder (project.json [+ library.json, feedback/, …]) placed under the PES home of the context, named `name`.
 * `project.json`'s `slug` is set to the folder name (the importer needs it); nothing else of the fixture is changed.
 */
export function legacy_folder(ctx: CompatCtx, name: string, fixture: "complete" | "full" = "complete", mutate?: (data: Record<string, unknown>) => void): string {
  const dir = join(ctx.pes_home, name);
  cpSync(join(LEGACY_FIXTURES, fixture), dir, { recursive: true });
  const file = join(dir, "project.json");
  const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  data.slug = name;
  mutate?.(data);
  writeFileSync(file, JSON.stringify(data, null, 1), "utf8");
  return dir;
}

/** bytes of every file + names (no mtimes): changes when anything below `dir` is added, removed or edited. */
export function bytes_digest(dir: string): string {
  return tree_digest(dir);
}

/** name → "size:mtimeMs" of every file below `dir` — the folder must not even be touched. */
export function mtime_map(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of tree_entries(dir)) {
    const st = lstatSync(join(dir, ...e.path.split("/")));
    out[e.path] = `${st.size}:${st.mtimeMs}`;
  }
  return out;
}

/** Every directory below `root` (depth ≤ `depth`) that holds a `manifest.json` — the backup bundles a migration leaves. */
export function bundle_dirs(root: string, depth = 4): string[] {
  const out: string[] = [];
  const walk = (dir: string, left: number): void => {
    if (!existsSync(dir)) return;
    if (existsSync(join(dir, "manifest.json"))) out.push(dir);
    if (left === 0) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) walk(join(dir, entry.name), left - 1);
  };
  walk(root, depth);
  return out;
}

/** Normalises a stdout: CRLF → LF, every spelling of the temporary root → <ROOT> (8.3 names, doubled backslashes). */
export function norm_root(text: string, root: string): string {
  const forms = new Set<string>([root]);
  try {
    forms.add(realpathSync.native(root));
  } catch {
    // gone
  }
  let out = text.replace(/\r\n/g, "\n");
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    out = out.split(form.replace(/\\/g, "\\\\")).join("<ROOT>").split(form).join("<ROOT>");
  }
  return out;
}

/** One Korean line, no stack trace, no Python traceback. */
export function assert_one_line_error(result: TsRunResult, what: string): void {
  const text = result.stderr.replace(/\r\n/g, "\n").trimEnd();
  assert.notEqual(text, "", `${what}: a reason on stderr`);
  assert.equal(text.split("\n").length, 1, `${what}: one line, got ${JSON.stringify(text)}`);
  assert.doesNotMatch(text, /Traceback|\bat \S+ \(|node:internal|ERR_[A-Z_]+/, `${what}: not a stack trace`);
  assert.match(text, /[가-힣]/, `${what}: Korean`);
}

export function ensure_dir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

// ---------------------------------------------------------------------------
// Running pes.ts against a make_cli_env() fixture (a DB project + a folder with a 0.15 project.json that must never change)

import { mkdirSync as mk_dir } from "node:fs";
import type { CliResult } from "./cli_write_env.ts";

/** `node … scripts/pes.ts <args>` for a CliEnv: the same shape as `c.run` (which ran pes.py with PES_DB_CORE=1), no flag needed. */
export function ts_run(c: { env: { home: { root: string; env: Record<string, string | undefined> } } }, args: string[], extra: Record<string, string | undefined> = {}): CliResult {
  const narrow_bin = join(c.env.home.root, "bin");
  mk_dir(narrow_bin, { recursive: true });
  const env: Record<string, string | undefined> = { ...c.env.home.env, PES_OWNER: undefined };
  for (const key of ["PES_TOKEN", "PES_DB_CORE", "PES_HUB_PORTS", "PES_LOCAL_SESSION_SECRET"]) delete env[key];
  const { PES_TOKEN, PES_OWNER, ...rest } = extra;
  const run = run_ts_cli({ home: { root: c.env.home.root }, env, narrow_bin }, args, { env: { ...rest, ...(PES_TOKEN === undefined ? {} : { PES_TOKEN }), ...(PES_OWNER === undefined ? {} : { PES_OWNER }) }, timeout_ms: 120_000 });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

// ---------------------------------------------------------------------------
// Reading the database of a context (read-only) and the core service (for restore)

import { connect_read_only, type Db } from "../../scripts/pes_core/db.ts";
import { db_path } from "../../scripts/pes_core/paths.ts";

/** Rows of the database of the context's HOME, read-only. A missing database → []. */
export function db_rows<T = Record<string, unknown>>(ctx: CompatCtx, sql: string, ...params: (string | number | bigint | null)[]): T[] {
  const file = db_path(ctx.env);
  if (!existsSync(file)) return [];
  const db: Db = connect_read_only(file);
  try {
    return db.all(sql, ...params) as unknown as T[];
  } finally {
    db.close();
  }
}

/** The project row of `slug` (any status), or undefined. */
export function project_row(ctx: CompatCtx, slug: string): { id: string; status: string; slug: string } | undefined {
  return db_rows<{ id: string; status: string; slug: string }>(ctx, "SELECT id, status, slug FROM projects WHERE slug = ?", slug)[0];
}

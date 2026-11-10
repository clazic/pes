// SEL-44 (stage 2 PR11) test harness: legacy importer. Everything is synthetic: fixtures live in
// tests/fixtures/legacy/, each test works on a COPY in a temporary folder (so a buggy importer can
// never change the repository), HOME/PES_HOME are temporary, the clock is fake.
// Nothing here touches the real ~/.pes or ~/pes-projects.
//
// The importer module does not exist yet when these tests are written, so it is loaded with a
// dynamic import: each test fails on its own (not the whole file at import time).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CommandService } from "../../scripts/pes_core/commands.ts";
import type { Db } from "../../scripts/pes_core/db.ts";
import { disk_path, blob_row_must, with_env, type Env } from "./blob_env.ts";

export { with_env, rejects_any, rejects_api, type Env } from "./blob_env.ts";

// ---------------------------------------------------------------------------
// The interface the tests expect from scripts/pes_core/legacy.ts

export type ReportCategory =
  | "unknown_field"
  | "unprocessed_answer"
  | "missing_file"
  | "parse_error"
  | "processed_without_file"
  | "unmapped_input"
  | "quarantined"
  | "default_filled";

export interface ReportEntry {
  category: ReportCategory;
  /** Source-folder-relative path with "/" separators, or the referenced path for a missing file. */
  path: string;
  /** JSON pointer inside `path` for a field-level entry (unknown_field: "/unknown_top"), else absent. */
  key?: string;
  detail?: unknown;
}

export interface UnknownReport {
  batch_id: string;
  entries: ReportEntry[];
}

export interface ScannedFile {
  path: string; // relative, "/" separators
  size: number;
  sha256: string;
}

export interface LegacyScan {
  /** All regular files below the folder (sorted by path), including volatile ones. */
  files: ScannedFile[];
  /** sha256 over the manifest (path, size, sha256 of every file). Same content -> same value. */
  fingerprint: string;
  /** false when project.json is missing or is not valid JSON. */
  project_json_ok: boolean;
}

export interface ImportOptions {
  /** The current human owner who runs the import (an actor of kind 'human' that has a user). */
  owner_actor_id: string;
}

export interface ImportResult {
  batch_id: string;
  project_id: string;
  state: "staging" | "failed";
  /** true when the same source_fingerprint was already imported and nothing new was written. */
  replayed: boolean;
  source_fingerprint: string;
  report: UnknownReport;
}

export interface MappingRow {
  legacy_kind: string;
  legacy_scope: string;
  legacy_key: string;
  content_hash: string;
  new_object_id: string | null;
  new_version_id: string | null;
  new_row_id: string | null;
}

export interface LegacyApi {
  scan_project(dir: string): LegacyScan;
  import_project(service: CommandService, dir: string, opts: ImportOptions): Promise<ImportResult>;
  map_legacy(db: Db, batch_id: string): MappingRow[];
  report_unknown(db: Db, batch_id: string): UnknownReport;
}

export async function legacy(): Promise<LegacyApi> {
  const path = "../../scripts/pes_core/legacy.ts";
  return (await import(path)) as LegacyApi;
}

// ---------------------------------------------------------------------------
// Fixture folders

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = resolve(HERE, "..", "fixtures", "legacy");

let copy_counter = 0;

/** A fresh copy of tests/fixtures/legacy/<name> inside the test's temporary root. */
export function copy_fixture(env: Env, name: string): string {
  copy_counter += 1;
  const target = join(env.home.root, `legacy-${name}-${copy_counter}`);
  cpSync(join(FIXTURES, name), target, { recursive: true });
  return target;
}

/** The truncated project.json of tests/fixtures/generate.py ("broken"), plus a feedback file. */
export function make_broken_project(env: Env): string {
  copy_counter += 1;
  const dir = join(env.home.root, `legacy-broken-${copy_counter}`);
  mkdirSync(join(dir, "feedback"), { recursive: true });
  writeFileSync(join(dir, "project.json"), '{"pes": 1, "stages":', "utf8");
  writeFileSync(
    join(dir, "feedback", "plan-R1-20260301-100000.json"),
    JSON.stringify({ stage: "plan", round: 1, kind: "feedback", text: "합성 답", answers: {} }),
    "utf8",
  );
  return dir;
}

/** A valid ~2 MB project.json (tests/fixtures/generate.py "large"). Generated, never committed. */
export function make_large_project(env: Env): string {
  copy_counter += 1;
  const dir = join(env.home.root, `legacy-large-${copy_counter}`);
  mkdirSync(dir, { recursive: true });
  const body = {
    pes: 1,
    topic: "합성 큰 프로젝트",
    slug: "synthetic-legacy-large",
    stages: {},
    synthetic_payload: "x".repeat(2 * 1024 * 1024),
  };
  writeFileSync(join(dir, "project.json"), JSON.stringify(body), "utf8");
  return dir;
}

// ---------------------------------------------------------------------------
// Source-folder digest (independent of the importer: node:fs + node:crypto only)

export function sha256_of(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface TreeEntry {
  path: string;
  size: number;
  sha256: string;
}

export function tree_entries(dir: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        const bytes = readFileSync(full);
        out.push({
          path: relative(dir, full).replace(/\\/g, "/"),
          size: bytes.byteLength,
          sha256: sha256_of(bytes),
        });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** One string that changes when any file is added, removed, renamed, or edited. */
export function tree_digest(dir: string): string {
  return sha256_of(JSON.stringify(tree_entries(dir)));
}

// ---------------------------------------------------------------------------
// Database reads

/** The tables whose row counts must not grow when the same source is imported again. */
export const COUNTED_TABLES = [
  "projects",
  "import_batches",
  "legacy_mappings",
  "objects",
  "object_versions",
  "artifacts",
  "artifact_versions",
  "sources",
  "source_versions",
  "citations",
  "questions",
  "question_versions",
  "question_sets",
  "submissions",
  "answers",
  "answer_versions",
  "threads",
  "messages",
  "followups",
  "followup_versions",
  "approvals",
  "snapshots",
  "rounds",
  "stages",
  "editions",
  "blobs",
  "version_files",
  "events",
  "mutation_commits",
  "actors",
  "users",
  "project_policy_versions",
] as const;

export function table_counts(db: Db): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    const row = db.get<{ n: bigint }>(`SELECT count(*) AS n FROM ${table}`);
    out[table] = Number(row?.n ?? 0n);
  }
  return out;
}

export interface BatchRow {
  id: string;
  project_id: string;
  source_fingerprint: string;
  source_schema: string;
  importer_version: string;
  source_manifest_blob_id: string;
  state: string;
  report_blob_id: string | null;
}

export function batch_row(db: Db, batch_id: string): BatchRow {
  const row = db.get<BatchRow>("SELECT * FROM import_batches WHERE id = ?", batch_id);
  assert.ok(row, "the import batch row exists");
  return { ...row };
}

export interface ProjectRow {
  id: string;
  slug: string;
  topic: string;
  owner_user_id: string;
  active_edition_id: string | null;
  status: string;
  current_policy_id: string | null;
  created_at: bigint;
}

export function project_row(db: Db, project_id: string): ProjectRow {
  const row = db.get<ProjectRow>("SELECT * FROM projects WHERE id = ?", project_id);
  assert.ok(row, "the imported project row exists");
  return { ...row };
}

export function edition_of(db: Db, project_id: string) {
  const row = db.get<{ id: string; status: string; current_stage_id: string | null; settings_json: string }>(
    "SELECT id, status, current_stage_id, settings_json FROM editions WHERE project_id = ?",
    project_id,
  );
  assert.ok(row, "the imported project has exactly one edition");
  assert.equal(db.all("SELECT 1 FROM editions WHERE project_id = ?", project_id).length, 1);
  return { ...row };
}

export function stage_of(db: Db, project_id: string, key: string) {
  const row = db.get<{
    id: string;
    status: string;
    current_round_id: string | null;
    approved_snapshot_id: string | null;
    settings_json: string;
  }>(
    "SELECT s.id, s.status, s.current_round_id, s.approved_snapshot_id, s.settings_json FROM stages s WHERE s.project_id = ? AND s.key = ?",
    project_id,
    key,
  );
  assert.ok(row, `stage ${key} exists`);
  return { ...row };
}

export function rounds_of(db: Db, stage_id: string) {
  return db
    .all<{ id: string; round_no: bigint; state: string; sealed_snapshot_id: string | null }>(
      "SELECT id, round_no, state, sealed_snapshot_id FROM rounds WHERE stage_id = ? ORDER BY round_no",
      stage_id,
    )
    .map((row) => ({ ...row }));
}

/** Parsed JSON of a TEXT column, with a clear failure when the column is not JSON. */
export function json_of(text: string | null | undefined): Record<string, unknown> {
  assert.equal(typeof text, "string");
  const value = JSON.parse(text as string) as unknown;
  assert.ok(value !== null && typeof value === "object");
  return value as Record<string, unknown>;
}

/** The report JSON stored in the blob that import_batches.report_blob_id points at. */
export function stored_report(env: Env, batch: BatchRow): UnknownReport {
  assert.ok(batch.report_blob_id, "the batch keeps its report in a blob");
  const row = blob_row_must(env.db, batch.report_blob_id);
  const bytes = readFileSync(disk_path(env, row));
  assert.equal(sha256_of(bytes), row.sha256, "the report blob bytes match their recorded hash");
  return JSON.parse(new TextDecoder().decode(bytes)) as UnknownReport;
}

export function has_entry(
  report: UnknownReport,
  category: ReportCategory,
  path: string,
  key?: string,
): boolean {
  return report.entries.some(
    (entry) => entry.category === category && entry.path === path && (key === undefined || entry.key === key),
  );
}

export function mappings_of(rows: MappingRow[], legacy_kind: string): MappingRow[] {
  return rows.filter((row) => row.legacy_kind === legacy_kind);
}

/** The temporary env plus the loaded importer API. */
export async function with_legacy(
  fn: (env: Env, api: LegacyApi) => Promise<void> | void,
): Promise<void> {
  await with_env(async (env) => {
    const api = await legacy();
    await fn(env, api);
  });
}

export async function run_import(env: Env, api: LegacyApi, dir: string): Promise<ImportResult> {
  return api.import_project(env.service, dir, { owner_actor_id: env.p.actor_id });
}

// SEL-45 (stage 2 PR12) test harness: migration validation, activation, rollback, restore.
// Everything is synthetic. It reuses the PR11 harness (tests/helpers/legacy_env.ts: fixtures in
// tests/fixtures/legacy/, one COPY per test inside an isolated HOME/PES_HOME, fake clock) and adds
// the interface the tests expect from scripts/pes_core/migration.ts.
//
// scripts/pes_core/migration.ts does not exist yet when these tests are written, so it is loaded
// with a dynamic import: each test fails on its own (not the whole file at import time).
// Nothing here touches the real ~/.pes or ~/pes-projects.

import assert from "node:assert/strict";
import { lstatSync, readdirSync, utimesSync } from "node:fs";
import { join, relative } from "node:path";

import type { CommandService } from "../../scripts/pes_core/commands.ts";
import type { Db } from "../../scripts/pes_core/db.ts";
import { blob_row_must, second_project, type Env, type Project } from "./blob_env.ts";
import {
  batch_row,
  copy_fixture,
  run_import,
  tree_entries,
  with_legacy,
  type BatchRow,
  type ImportResult,
  type LegacyApi,
} from "./legacy_env.ts";
import { list_tree, project_rows } from "./backup_fixture.ts";

export { with_legacy, run_import, copy_fixture, batch_row, rejects_any, rejects_api } from "./legacy_env.ts";
export { second_project, disk_path, blob_row_must, plant_bytes } from "./blob_env.ts";
export type { Env, Project } from "./blob_env.ts";
export type { ImportResult, LegacyApi, BatchRow } from "./legacy_env.ts";

// ---------------------------------------------------------------------------
// The interface the tests expect from scripts/pes_core/migration.ts
//
// First argument: a write goes through the CommandService (like legacy.import_project in PR11),
// a read takes the Db. Every write runs as the HUMAN OWNER of the imported project
// (`owner_actor_id`); anyone else gets ApiError "forbidden" and nothing changes.

/** The checks of validate_import (migration-map.md section 9). Every name appears in `checked`. */
export type CheckName =
  | "counts" // items/sources/shots/reports per stage vs. objects/versions/version_files
  | "bodies" // summary/details/report body text equals the source (hash)
  | "ids" // every legacy_mappings row resolves to a new object/version/row
  | "links" // relations/citations/followups point at existing rows of the same project
  | "footnotes" // citations.citation_no follows the order of sources[]
  | "files" // blobs.sha256/size equal the source file, the object file on disk matches
  | "unprocessed_answers" // every feedback/*.json absent from `processed` is an answer/submission
  | "reports_regeneration" // regenerated report.md/report.html compared with the original (reported, not fatal)
  | "source_changed"; // the source folder still has the fingerprint recorded at import

export const CHECK_NAMES: readonly CheckName[] = [
  "counts",
  "bodies",
  "ids",
  "links",
  "footnotes",
  "files",
  "unprocessed_answers",
  "reports_regeneration",
  "source_changed",
];

export interface ValidationProblem {
  check: CheckName;
  /** Source-relative path or the legacy key the problem is about, when there is one. */
  path?: string;
  detail?: unknown;
}

export interface RegeneratedReport {
  /** Source-folder-relative path of the original report, e.g. "reports/plan/report.md". */
  path: string;
  /** false = the regenerated text differs from the original; this is REPORTED, never a problem. */
  matches: boolean;
}

export interface ValidationReport {
  /** How many things each check compared (a check that compared nothing has 0). */
  checked: Record<CheckName, number>;
  problems: ValidationProblem[];
  regenerated_reports: RegeneratedReport[];
}

export interface ValidateOptions {
  owner_actor_id: string;
  /** The original (or copied) project folder the batch was imported from. Read only. */
  source_dir: string;
}

export interface ValidateResult {
  batch_id: string;
  project_id: string;
  /** true only when `problems` is empty. */
  ok: boolean;
  /** "validated" when ok, otherwise the batch stays "staging". */
  state: "staging" | "validated";
  report: ValidationReport;
}

export interface ActivateOptions {
  owner_actor_id: string;
  /** New, empty (or not yet existing) folder for the pre-activation backup bundle (PR3 format). */
  backup_dir: string;
  /** The PES home (project folders). A backup_dir inside it, or inside an OneDrive folder, is refused. */
  pes_home: string;
}

export interface ActivateResult {
  batch_id: string;
  project_id: string;
  state: "activated";
  /** The bundle written just BEFORE the state changed (verify_bundle(...).ok). */
  backup_dir: string;
}

export interface RollbackOptions {
  owner_actor_id: string;
}

export interface RollbackResult {
  batch_id: string;
  project_id: string;
  /** schema has no 'rolled_back': the batch ends as "failed" and the project as "archived". */
  state: "failed";
  /** The old JSON path serves the project again. */
  serving: "legacy_json";
  /** The batch state it was rolled back from. */
  from_state: "staging" | "validated" | "activated";
}

export interface RestoreOptions {
  owner_actor_id: string;
  project_id: string;
  /** A PR3 bundle of THIS project (the one activate_import wrote, or any later export). */
  bundle_dir: string;
}

export interface LostWrite {
  /** mutation_commits.action of a write that existed after the bundle and is gone now. */
  action: string;
  created_at: string;
}

export interface RestoreResult {
  project_id: string;
  bundle_dir: string;
  /** Decimal strings (stage 2 rule: no JSON numbers for counters). */
  cursor_epoch_before: string;
  cursor_epoch_after: string;
  /** Business writes after the bundle that the restore removed, oldest first. */
  lost_writes: LostWrite[];
  /** Migration steps after the bundle that were undone too (e.g. "legacy.activate_import"). */
  reverted_steps: string[];
}

export interface MigrationApi {
  validate_import(service: CommandService, batch_id: string, opts: ValidateOptions): Promise<ValidateResult>;
  activate_import(service: CommandService, batch_id: string, opts: ActivateOptions): Promise<ActivateResult>;
  rollback_before_write(service: CommandService, batch_id: string, opts: RollbackOptions): Promise<RollbackResult>;
  restore_project(service: CommandService, opts: RestoreOptions): Promise<RestoreResult>;
  /** Read only: which path serves this project right now. 'database' only when the project is active. */
  serving_path(db: Db, project_id: string): "legacy_json" | "database";
}

export async function migration(): Promise<MigrationApi> {
  const path = "../../scripts/pes_core/migration.ts";
  return (await import(path)) as MigrationApi;
}

export async function with_migration(
  fn: (env: Env, legacy: LegacyApi, mig: MigrationApi) => Promise<void> | void,
): Promise<void> {
  await with_legacy(async (env, legacy) => {
    const mig = await migration();
    await fn(env, legacy, mig);
  });
}

// ---------------------------------------------------------------------------
// Scenarios

export function owner_of(env: Env): string {
  return env.p.actor_id;
}

export function backup_dir_of(env: Env, name: string): string {
  // ~/.pes/backups/<name>: outside the PES home (PES_HOME), as the runbook asks.
  return join(env.home.root, "home", ".pes", "backups", name);
}

export function pes_home_of(env: Env): string {
  const value = env.home.env.PES_HOME;
  assert.ok(typeof value === "string" && value.length > 0, "PES_HOME of the isolated home");
  return value;
}

export interface Staged {
  dir: string;
  imp: ImportResult;
}

export async function stage(env: Env, legacy: LegacyApi, fixture = "full"): Promise<Staged> {
  const dir = copy_fixture(env, fixture);
  const imp = await run_import(env, legacy, dir);
  assert.equal(imp.state, "staging", "the fixture imports into staging");
  return { dir, imp };
}

export async function validated(
  env: Env,
  legacy: LegacyApi,
  mig: MigrationApi,
  fixture = "full",
): Promise<Staged & { val: ValidateResult }> {
  const s = await stage(env, legacy, fixture);
  const val = await mig.validate_import(env.service, s.imp.batch_id, {
    owner_actor_id: owner_of(env),
    source_dir: s.dir,
  });
  assert.equal(val.ok, true, `validate_import accepts the clean ${fixture} fixture: ${JSON.stringify(val.report.problems)}`);
  assert.equal(batch_row(env.db, s.imp.batch_id).state, "validated");
  return { ...s, val };
}

export async function activated(
  env: Env,
  legacy: LegacyApi,
  mig: MigrationApi,
  fixture = "full",
  backup_name = "pre-activation",
): Promise<Staged & { val: ValidateResult; act: ActivateResult }> {
  const v = await validated(env, legacy, mig, fixture);
  const act = await mig.activate_import(env.service, v.imp.batch_id, {
    owner_actor_id: owner_of(env),
    backup_dir: backup_dir_of(env, backup_name),
    pes_home: pes_home_of(env),
  });
  assert.equal(act.state, "activated");
  return { ...v, act };
}

/** A real business write on the imported project (project.set_topic with the current control_rev). */
export async function write_topic(env: Env, project_id: string, topic: string, key: string): Promise<void> {
  const row = env.db.get<{ control_rev: bigint }>("SELECT control_rev FROM projects WHERE id = ?", project_id);
  assert.ok(row, "project exists");
  await env.service.execute(
    {
      project_id,
      actor_id: owner_of(env),
      via: "cli",
      client_request_id: key,
      base_control_rev: Number(row.control_rev),
    },
    "project.set_topic",
    { topic },
  );
}

/** A second human who is NOT the owner of the imported project (own user, own synthetic project). */
export async function other_human(env: Env): Promise<Project> {
  return second_project(env, "synthetic-other-human");
}

/** An AI actor (not human) with a user-less row, for "only humans may do this" checks. */
export function add_agent(env: Env, id = "agent-x"): string {
  env.db.run(
    "INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, 'external_agent', NULL, '합성 에이전트')",
    id,
  );
  return id;
}

// ---------------------------------------------------------------------------
// Observation helpers (independent of the migration module)

export function events_of(db: Db, project_id: string): Array<{ type: string; payload: Record<string, unknown> }> {
  return db
    .all<{ type: string; payload: string }>(
      "SELECT type, payload FROM events WHERE project_id = ? ORDER BY event_seq",
      project_id,
    )
    .map((row) => ({ type: row.type, payload: JSON.parse(row.payload) as Record<string, unknown> }));
}

export function project_status(db: Db, project_id: string): string {
  const row = db.get<{ status: string }>("SELECT status FROM projects WHERE id = ?", project_id);
  assert.ok(row, "project row exists");
  return row.status;
}

export function cursor_epoch(db: Db): bigint {
  const row = db.get<{ cursor_epoch: bigint }>("SELECT cursor_epoch FROM db_meta WHERE id = 1");
  assert.ok(row, "db_meta row exists");
  return row.cursor_epoch;
}

export function instance_id(db: Db): string {
  const row = db.get<{ database_instance_id: string }>("SELECT database_instance_id FROM db_meta WHERE id = 1");
  assert.ok(row, "db_meta row exists");
  return row.database_instance_id;
}

/** Tables that carry a project_id column, except the two that grow with every command. */
export function business_tables(db: Db): string[] {
  const tables = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((row) => row.name);
  return tables.filter((name) => {
    if (name === "events" || name === "mutation_commits") return false;
    const columns = db.all<{ name: string }>(`PRAGMA table_info("${name}")`);
    return columns.some((column) => column.name === "project_id");
  });
}

/** Row count per business table for one project (events and receipts excluded on purpose). */
export function domain_counts(db: Db, project_id: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of business_tables(db)) {
    const row = db.get<{ n: bigint }>(`SELECT count(*) AS n FROM "${table}" WHERE project_id = ?`, project_id);
    out[table] = Number(row?.n ?? 0n);
  }
  return out;
}

/** Everything of a project that the other project's owner could notice: rows + object files. */
export function bystander_signature(env: Env, project_id: string): { rows: Record<string, string[]>; files: Record<string, string> } {
  const owner = env.db.get<{ owner_user_id: string }>("SELECT owner_user_id FROM projects WHERE id = ?", project_id);
  assert.ok(owner, "bystander project exists");
  return {
    rows: project_rows(env.db, project_id, owner.owner_user_id),
    files: list_tree(join(env.objects, project_id)),
  };
}

export function object_files(env: Env, project_id: string): Record<string, string> {
  return list_tree(join(env.objects, project_id));
}

/** One path (relative) -> "size:mtimeMs" for every file AND folder, so a touch is noticed too. */
export function tree_stamps(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const st = lstatSync(full);
      out[relative(dir, full).replace(/\\/g, "/")] = `${st.isDirectory() ? "d" : st.size}:${st.mtimeMs}`;
      if (st.isDirectory()) walk(full);
    }
  };
  walk(dir);
  const root = lstatSync(dir);
  out["."] = `d:${root.mtimeMs}`;
  return out;
}

/** Set every file below dir to an old, fixed mtime so a later write is visible in tree_stamps. */
export function age_tree(dir: string): void {
  const old = new Date("2026-01-01T00:00:00Z");
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full);
      else utimesSync(full, old, old);
    }
  };
  walk(dir);
}

/** Blob of the imported project that came from a source file (by original name suffix). */
export function blob_by_name(env: Env, project_id: string, name_suffix: string) {
  const rows = env.db.all<{ id: string }>(
    "SELECT id FROM blobs WHERE project_id = ? AND original_name LIKE ? ORDER BY id",
    project_id,
    `%${name_suffix}`,
  );
  assert.ok(rows.length >= 1, `a blob named *${name_suffix} exists`);
  return blob_row_must(env.db, rows[0]!.id);
}

export function has_problem(report: ValidationReport, ...checks: CheckName[]): boolean {
  return report.problems.some((problem) => checks.includes(problem.check));
}

export function source_files(dir: string): string[] {
  return tree_entries(dir).map((entry) => entry.path);
}

export { tree_entries, tree_digest, table_counts } from "./legacy_env.ts";
export { list_tree, project_rows } from "./backup_fixture.ts";
export { state_signature } from "./state_signature.ts";

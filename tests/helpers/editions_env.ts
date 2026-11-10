// SEL-39 (stage 2 PR6) test harness: synthetic editions / stages / rounds, built on the PR9 blob
// harness (tests/helpers/blob_env.ts: temporary HOME, FakeClock, FakePolicy, objects folder).
// Everything is invented. Nothing touches the real ~/.pes or ~/pes-projects.

import assert from "node:assert/strict";

import type { CommandOutcome, MutationContext } from "../../scripts/pes_core/commands.ts";
import {
  approve_stage,
  seal_round,
  start_round,
} from "../../scripts/pes_core/editions.ts";
import type { Db } from "../../scripts/pes_core/db.ts";
import { claim } from "../../scripts/pes_core/runs.ts";
import {
  bytes_of,
  ctx_for,
  new_artifact,
  put_ready,
  type Env,
  type VersionResult,
} from "./blob_env.ts";

export { with_env, wrap_db, rejects_api, rejects_any, START_MS, type Env } from "./blob_env.ts";

export const STAGE_KEYS = ["plan", "research", "analyze", "write", "verify", "publish"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

export interface StageRow {
  id: string;
  edition_id: string;
  key: string;
  ordinal: bigint;
  status: string;
  current_round_id: string | null;
  approved_snapshot_id: string | null;
  stale_since_event_seq: bigint | null;
  rev: bigint;
}

export interface RoundRow {
  id: string;
  stage_id: string;
  round_no: bigint;
  state: string;
  base_snapshot_id: string | null;
  sealed_snapshot_id: string | null;
  rev: bigint;
}

export interface EditionRow {
  id: string;
  edition_no: bigint;
  parent_edition_id: string | null;
  status: string;
  current_stage_id: string | null;
  rev: bigint;
}

export interface VersionRef {
  object_id: string;
  version_id: string;
}

export function stage_ids(db: Db, edition_id: string): Record<StageKey, string> {
  const rows = db.all<{ id: string; key: StageKey }>(
    "SELECT id, key FROM stages WHERE edition_id = ? ORDER BY ordinal",
    edition_id,
  );
  assert.equal(rows.length, 6, "an edition has exactly six stages");
  const out = {} as Record<StageKey, string>;
  for (const row of rows) out[row.key] = row.id;
  return out;
}

export function stage_row(db: Db, stage_id: string): StageRow {
  const row = db.get<StageRow>("SELECT * FROM stages WHERE id = ?", stage_id);
  assert.ok(row, "the stage exists");
  return { ...row };
}

export function round_row(db: Db, round_id: string): RoundRow {
  const row = db.get<RoundRow>("SELECT * FROM rounds WHERE id = ?", round_id);
  assert.ok(row, "the round exists");
  return { ...row };
}

export function edition_row(db: Db, edition_id: string): EditionRow {
  const row = db.get<EditionRow>("SELECT * FROM editions WHERE id = ?", edition_id);
  assert.ok(row, "the edition exists");
  return { ...row };
}

export function receipt_of(db: Db, project_id: string, key: string) {
  const row = db.get<{ id: string; action: string; run_id: string | null; lease_id: string | null; fence: bigint | null; result_json: string }>(
    "SELECT id, action, run_id, lease_id, fence, result_json FROM mutation_commits WHERE project_id = ? AND client_request_id = ?",
    project_id,
    key,
  );
  return row === undefined ? undefined : { ...row };
}

export function events_of(db: Db, tx_id: string) {
  return db
    .all<{ event_seq: bigint; type: string; run_id: string | null; payload: string }>(
      "SELECT event_seq, type, run_id, payload FROM events WHERE tx_id = ? ORDER BY tx_index",
      tx_id,
    )
    .map((row) => ({ ...row }));
}

export function approvals_of(db: Db, stage_id: string) {
  return db
    .all<{ id: string; snapshot_id: string; actor_id: string; actor_kind: string; human_user_id: string | null; origin: string; assurance: string; tx_id: string }>(
      "SELECT id, snapshot_id, actor_id, actor_kind, human_user_id, origin, assurance, tx_id FROM approvals WHERE stage_id = ? ORDER BY rowid",
      stage_id,
    )
    .map((row) => ({ ...row }));
}

/** A manifest blob (ready, through the PR9 reserve -> store -> complete path) listing exact versions. */
export async function manifest_blob(env: Env, versions: VersionRef[], key: string): Promise<string> {
  const body = new TextEncoder().encode(JSON.stringify({ versions }));
  const reserved = await put_ready(env, body, `mf-${key}`);
  return reserved.blob_id;
}

export interface SealResult {
  round_id: string;
  snapshot_id: string;
  versions: VersionRef[];
  content_hash: string;
}

export interface RoundStarted {
  round_id: string;
  round_no: number;
  stage_id: string;
}

export interface Approved {
  stage_id: string;
  approval_id: string;
  snapshot_id: string;
  next_stage_id: string | null;
  edition_completed: boolean;
}

export async function start(env: Env, stage_id: string, key: string): Promise<RoundStarted> {
  const out = await start_round(env.service, env.ctx(key), { stage_id });
  assert.equal(out.replayed, false);
  return out.result as RoundStarted;
}

/** One new artifact version for the stage (made with the PR7 commands). */
export async function make_content(env: Env, key: string): Promise<VersionResult> {
  return new_artifact(env, key);
}

export async function seal(
  env: Env,
  round_id: string,
  versions: VersionRef[],
  key: string,
  ctx: MutationContext = env.ctx(key),
  guard: Record<string, unknown> = {},
): Promise<CommandOutcome> {
  const manifest_blob_id = await manifest_blob(env, versions, key);
  return seal_round(env.service, ctx, { round_id, manifest_blob_id, versions, ...guard });
}

export async function approve(env: Env, stage_id: string, snapshot_id: string, key: string): Promise<Approved> {
  const out = await approve_stage(env.service, env.ctx(key), { stage_id, snapshot_id });
  return out.result as Approved;
}

/** start -> content -> seal -> approve for one stage; returns the ids a later check needs. */
export async function drive_stage(env: Env, stage_id: string, tag: string) {
  const round = await start(env, stage_id, `${tag}-start`);
  const content = await make_content(env, tag);
  const versions = [{ object_id: content.object_id, version_id: content.version_id }];
  const sealed = (await seal(env, round.round_id, versions, `${tag}-seal`)).result as SealResult;
  const approved = await approve(env, stage_id, sealed.snapshot_id, `${tag}-approve`);
  return { round, content, versions, sealed, approved };
}

/**
 * A synthetic agent actor (external_agent) acting for the owner's user, so the service scope check
 * passes while it is still never a human owner.
 */
export function add_agent(env: Env, id = "agent-1"): MutationContext {
  const user = env.db.get<{ owner_user_id: string }>(
    "SELECT owner_user_id FROM projects WHERE id = ?",
    env.p.project_id,
  );
  assert.ok(user);
  env.db.run(
    "INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, 'external_agent', ?, '합성 에이전트')",
    id,
    user.owner_user_id,
  );
  return { project_id: env.p.project_id, actor_id: id, via: "cli", client_request_id: "unset" };
}

export function agent_ctx(base: MutationContext, key: string): MutationContext {
  return { ...base, client_request_id: key };
}

export interface AgentLease {
  run_id: string;
  lease_id: string;
  fence: number;
}

/** The agent claims a run (PR5) and gets the lease that authorizes its guarded writes. */
export async function agent_claim(env: Env, base: MutationContext, key: string): Promise<AgentLease> {
  const out = await claim(env.service, agent_ctx(base, key), {
    mode: "B",
    runtime: "synthetic-runtime",
    provider: "synthetic",
    model: "synthetic-model",
  });
  return out.result as AgentLease;
}

/** Point an existing run at a stage / round / context snapshot (fixture: PR5 claim does not take them). */
export function aim_run(env: Env, run_id: string, stage_id: string, round_id: string | null, context_snapshot_id: string | null) {
  env.db.run(
    "UPDATE runs SET stage_id = ?, round_id = ?, context_snapshot_id = ? WHERE id = ?",
    stage_id,
    round_id,
    context_snapshot_id,
    run_id,
  );
}

/** A run row that has no lease (fixture), for invalidation checks. */
export function insert_run(
  env: Env,
  id: string,
  status: "queued" | "waiting_human" | "interrupted" | "succeeded" | "failed",
  stage_id: string,
  round_id: string | null,
  context_snapshot_id: string | null,
): void {
  const edition = env.db.get<{ edition_id: string }>("SELECT edition_id FROM stages WHERE id = ?", stage_id);
  assert.ok(edition);
  env.db.run(
    `INSERT INTO runs (id, project_id, edition_id, stage_id, round_id, actor_id, mode, runtime, provider, model,
        status, base_control_rev, context_snapshot_id, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, 'B', 'synthetic-runtime', 'synthetic', 'synthetic-model', ?, 0, ?, 1, ?)`,
    id,
    env.p.project_id,
    edition.edition_id,
    stage_id,
    round_id,
    env.p.actor_id,
    status,
    context_snapshot_id,
    status === "succeeded" || status === "failed" ? 2n : null,
  );
}

export type FollowupState = "proposed" | "accepted" | "running" | "applied" | "deferred" | "rejected" | "cancelled";

/**
 * Fixture for a "remaining request" (a QA finding or an unfinished task): a followup object with
 * one next_round_task version aimed at `target_stage_id`. The PR8/11 commands that would normally
 * create it do not exist yet, so the rows are written directly (test data only).
 */
export function insert_followup(
  env: Env,
  tag: string,
  target_stage_id: string,
  state: FollowupState,
  description: string,
): { object_id: string; version_id: string } {
  const { project_id, actor_id } = env.p;
  const tx = env.db.get<{ id: string }>("SELECT id FROM mutation_commits WHERE project_id = ? ORDER BY rowid LIMIT 1", project_id);
  assert.ok(tx);
  const object_id = `fu-obj-${tag}`;
  const version_id = `fu-ver-${tag}`;
  env.db.run(
    "INSERT INTO objects (id, project_id, kind, display_no) VALUES (?, ?, 'followup', ?)",
    object_id,
    project_id,
    BigInt(100 + env.db.all("SELECT 1 FROM objects WHERE kind = 'followup'").length),
  );
  env.db.run(
    `INSERT INTO object_versions (id, project_id, object_id, kind, version_no, actor_id, tx_id, content_hash)
     VALUES (?, ?, ?, 'followup', 1, ?, ?, ?)`,
    version_id,
    project_id,
    object_id,
    actor_id,
    tx.id,
    "d".repeat(64),
  );
  env.db.run("INSERT INTO followups (project_id, object_id) VALUES (?, ?)", project_id, object_id);
  env.db.run(
    `INSERT INTO followup_versions (project_id, version_id, object_id, kind, state, description, target_stage_id, applied_tx_id)
     VALUES (?, ?, ?, 'next_round_task', ?, ?, ?, ?)`,
    project_id,
    version_id,
    object_id,
    state,
    description,
    target_stage_id,
    state === "applied" ? tx.id : null,
  );
  env.db.run("UPDATE objects SET current_version_id = ? WHERE id = ?", version_id, object_id);
  return { object_id, version_id };
}

export { bytes_of, ctx_for };

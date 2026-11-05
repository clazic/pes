// Synthetic seed data for the spike. All IDs and strings are invented.
// The fixture IDs are reused so that contract checks compare the same shapes.

import { createHash, randomUUID } from "node:crypto";
import type { Db, SqlStatement } from "./db.ts";
import { incrementDecimal } from "./decimal.ts";

export interface Ids {
  user: string;
  project: string;
  slug: string;
  edition: string;
  stage: string;
  round: string;
  run: string;
  agent: string;
  human: string;
  artifact: string;
  baseVersion: string;
  previousVersion: string;
  question: string;
  lease: string;
  inputObject: string;
  inputVersion: string;
  policy: string;
  manifestBlob: string;
  seedTx: string;
  competingRun: string;
}

/** Fixture-compatible IDs used by the contract checks. */
export const IDS: Ids = {
  user: "usr_01J9Z3K7Q1",
  project: "prj_01J9Z3K7Q2",
  slug: "synthetic-policy-study",
  edition: "edt_01J9Z3K7Q3",
  stage: "stg_01J9Z3K7Q4",
  round: "rnd_01J9Z3K7Q5",
  run: "run_01J9Z3K7Q6",
  agent: "act_01J9Z3K7Q7",
  human: "act_01J9Z3K7Q8",
  artifact: "obj_01J9Z3K7Q9",
  baseVersion: "ver_01J9Z3K7QA",
  previousVersion: "ver_01J9Z3K7Q0",
  question: "qst_01J9Z3K7QB",
  lease: "lea_01J9Z3K7QP",
  inputObject: "obj_01J9Z3K7QC",
  inputVersion: "ver_01J9Z3K7QD",
  policy: "pol_01J9Z3K7QE",
  manifestBlob: "blb_01J9Z3K7QF",
  seedTx: "mut_01J9Z3K7QG",
  competingRun: "run_01J9Z3K7QX",
};

/** Unique namespace per measurement round so one DB can host many rounds. */
export function makeIds(scope: string): Ids {
  return {
    user: `usr_${scope}_u`,
    project: `prj_${scope}`,
    slug: `synthetic-${scope}`,
    edition: `edt_${scope}`,
    stage: `stg_${scope}`,
    round: `rnd_${scope}`,
    run: `run_${scope}`,
    agent: `act_${scope}_a`,
    human: `act_${scope}_h`,
    artifact: `obj_${scope}_art`,
    baseVersion: `ver_${scope}_v3`,
    previousVersion: `ver_${scope}_v2`,
    question: `qst_${scope}_q`,
    lease: `lea_${scope}`,
    inputObject: `obj_${scope}_in`,
    inputVersion: `ver_${scope}_in`,
    policy: `pol_${scope}`,
    manifestBlob: `blb_${scope}`,
    seedTx: `mut_${scope}_seed`,
    competingRun: `run_${scope}_x`,
  };
}

export const FIXED_TIME = 1762311600000;
export const LEASE_TTL_MS = 120000;
export const CONTROL_REV = "12";

const SHA = "0".repeat(64);

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
}

export interface SeedOptions {
  /** Seed an active lease held by another run, to produce lease_held. */
  competingLease?: boolean;
  /** Seed the run as already terminal, to produce run_terminal. */
  runStatus?: "queued" | "running" | "cancelled" | "succeeded";
  /** Start above Number.MAX_SAFE_INTEGER to prove string-only decimal handling. */
  largeDecimals?: boolean;
  ids?: Ids;
}

export interface SeededState {
  ids: Ids;
  projectId: string;
  runId: string;
  artifactObjectId: string;
  baseVersionId: string;
  inputVersionId: string;
}

function eventStatements(input: {
  txId: string;
  projectId: string;
  runId: string | null;
  type: string;
  count: number;
  objectId?: string | null;
  beforeVersionId?: string | null;
  afterVersionId?: string | null;
  createdAt: number;
}): SqlStatement[] {
  return Array.from({ length: input.count }, (_, index) => ({
    sql: `INSERT INTO events
      (id, project_id, run_id, tx_id, tx_index, tx_size, type, object_id,
       before_version_id, after_version_id, payload, schema_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 1, ?)`,
    params: [
      newId("evt"),
      input.projectId,
      input.runId,
      input.txId,
      index,
      input.count,
      input.type,
      input.objectId ?? null,
      input.beforeVersionId ?? null,
      input.afterVersionId ?? null,
      input.createdAt,
    ],
  }));
}

export async function seedBase(db: Db, options: SeedOptions = {}): Promise<SeededState> {
  const ids = options.ids ?? IDS;
  const t = FIXED_TIME;
  const runStatus = options.runStatus ?? "queued";
  const controlRev = options.largeDecimals ? "9007199254740993" : "12";
  const baseFence = options.largeDecimals ? "9007199254740992" : "2";
  const nextFence = incrementDecimal(baseFence);
  const baseVersionNo = options.largeDecimals ? "9007199254740992" : "3";
  const previousVersionNo = options.largeDecimals ? "9007199254740991" : "2";
  const objectRev = options.largeDecimals ? "9007199254740992" : "7";
  const statements: SqlStatement[] = [
    {
      sql: `INSERT INTO users (id, display_name, auth_subject, created_at)
            VALUES (?, ?, NULL, ?)`,
      params: [ids.user, "합성 사용자", t],
    },
    {
      sql: `INSERT INTO actors (id, kind, user_id, runtime, provider, display_name)
            VALUES (?, 'human', ?, NULL, NULL, ?)`,
      params: [ids.human, ids.user, "합성 사람"],
    },
    {
      sql: `INSERT INTO actors (id, kind, user_id, runtime, provider, display_name)
            VALUES (?, 'internal_ai', NULL, 'node', 'opencode-go', ?)`,
      params: [ids.agent, "합성 실행기"],
    },
    {
      sql: `INSERT INTO projects
        (id, slug, topic, owner_user_id, owner_role, active_edition_id, status,
         control_rev, current_policy_id, created_at)
        VALUES (?, ?, ?, ?, 'owner', NULL, 'staging', ?, NULL, ?)`,
      params: [ids.project, ids.slug, "합성 정책 연구", ids.user, controlRev, t],
    },
    {
      sql: `INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')`,
      params: [ids.project, ids.user],
    },
    {
      sql: `INSERT INTO editions (id, project_id, edition_no, status, rev)
            VALUES (?, ?, 2, 'active', 0)`,
      params: [ids.edition, ids.project],
    },
    {
      sql: `INSERT INTO stages (id, project_id, edition_id, key, ordinal, status, rev)
            VALUES (?, ?, ?, 'research', 2, 'active', 0)`,
      params: [ids.stage, ids.project, ids.edition],
    },
    {
      sql: `INSERT INTO rounds (id, project_id, edition_id, stage_id, round_no, state, rev)
            VALUES (?, ?, ?, ?, 2, 'open', 0)`,
      params: [ids.round, ids.project, ids.edition, ids.stage],
    },
    {
      sql: `INSERT INTO mutation_commits
        (id, project_id, edition_id, stage_id, round_id, actor_id, via,
         client_request_id, request_hash, action, guard_ok, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'http', 'seed', ?, 'seed', 1, '{}', ?)`,
      params: [ids.seedTx, ids.project, ids.edition, ids.stage, ids.round, ids.human, SHA, t],
    },
    {
      sql: `INSERT INTO project_policy_versions
        (id, project_id, policy_rev, allow_opencode_go, mode_a_model,
         go_usage_stop_percent, changed_by, changed_by_user_id, changed_by_kind,
         reason, tx_id, created_at)
        VALUES (?, ?, 5, 1, 'opencode-go/deepseek-v4.1-flash', 90, ?, ?, 'human', ?, ?, ?)`,
      params: [ids.policy, ids.project, ids.human, ids.user, "합성 초기 정책", ids.seedTx, t],
    },
    {
      sql: `UPDATE projects SET status = 'active', active_edition_id = ?, current_policy_id = ?
            WHERE id = ?`,
      params: [ids.edition, ids.policy, ids.project],
    },
    {
      sql: `INSERT INTO blobs
        (id, project_id, storage_key, sha256, size, media_type, original_name, state, created_by)
        VALUES (?, ?, ?, ?, 128, 'application/json', 'manifest.json', 'ready', ?)`,
      params: [ids.manifestBlob, ids.project, `synthetic/${ids.project}/manifest.json`, SHA, ids.agent],
    },
    {
      sql: `INSERT INTO objects
        (id, project_id, edition_id, kind, display_no, current_version_id, rev, archived_at)
        VALUES (?, ?, ?, 'artifact', 12, NULL, ?, NULL)`,
      params: [ids.artifact, ids.project, ids.edition, objectRev],
    },
    {
      sql: `INSERT INTO object_versions
        (id, project_id, object_id, kind, version_no, based_on_version_id,
         created_in_round_id, actor_id, run_id, tx_id, content_hash, created_at)
        VALUES (?, ?, ?, 'artifact', ?, NULL, ?, ?, NULL, ?, ?, ?)`,
      params: [ids.previousVersion, ids.project, ids.artifact, previousVersionNo, ids.round, ids.agent, ids.seedTx, SHA, t],
    },
    {
      sql: `INSERT INTO object_versions
        (id, project_id, object_id, kind, version_no, based_on_version_id,
         created_in_round_id, actor_id, run_id, tx_id, content_hash, created_at)
        VALUES (?, ?, ?, 'artifact', ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        ids.baseVersion,
        ids.project,
        ids.artifact,
        baseVersionNo,
        ids.previousVersion,
        ids.round,
        ids.agent,
        null,
        ids.seedTx,
        SHA,
        t,
      ],
    },
    {
      sql: `UPDATE objects SET current_version_id = ? WHERE id = ?`,
      params: [ids.baseVersion, ids.artifact],
    },
    {
      sql: `INSERT INTO artifacts (project_id, object_id, object_kind, stage_id, kind, origin_version_id)
            VALUES (?, ?, 'artifact', ?, 'chapter', ?)`,
      params: [ids.project, ids.artifact, ids.stage, ids.baseVersion],
    },
    {
      sql: `INSERT INTO artifact_versions
        (project_id, version_id, object_id, object_kind, title, summary, body_md, status, stats, conflicts, verify, metadata_json)
        VALUES (?, ?, ?, 'artifact', ?, '', ?, 'draft', '[]', '[]', 'null', '{}')`,
      params: [ids.project, ids.baseVersion, ids.artifact, "2장 합성 정책 분석", "## 2. 합성 정책 분석\n\n합성 본문입니다."],
    },
    {
      sql: `INSERT INTO objects
        (id, project_id, edition_id, kind, display_no, current_version_id, rev, archived_at)
        VALUES (?, ?, ?, 'source', 1, NULL, 1, NULL)`,
      params: [ids.inputObject, ids.project, ids.edition],
    },
    {
      sql: `INSERT INTO object_versions
        (id, project_id, object_id, kind, version_no, based_on_version_id,
         created_in_round_id, actor_id, run_id, tx_id, content_hash, created_at)
        VALUES (?, ?, ?, 'source', 1, NULL, ?, ?, NULL, ?, ?, ?)`,
      params: [ids.inputVersion, ids.project, ids.inputObject, ids.round, ids.agent, ids.seedTx, SHA, t],
    },
    {
      sql: `UPDATE objects SET current_version_id = ? WHERE id = ?`,
      params: [ids.inputVersion, ids.inputObject],
    },
    {
      sql: `INSERT INTO runs
        (id, project_id, edition_id, stage_id, round_id, actor_id, mode, runtime, provider,
         model, role, status, retry_of, parent_run_id, external_session_ref,
         base_control_rev, context_snapshot_id, workflow_version, usage_json,
         started_at, ended_at)
        VALUES (?, ?, ?, ?, ?, ?, 'A', 'node', 'opencode-go',
         'opencode-go/deepseek-v4.1-flash', 'worker', ?, NULL, NULL, NULL,
         ?, NULL, 'spike-1', NULL, NULL, NULL)`,
      params: [ids.run, ids.project, ids.edition, ids.stage, ids.round, ids.agent, runStatus, controlRev],
    },
    {
      sql: `UPDATE object_versions SET run_id = ? WHERE project_id = ? AND id = ?`,
      params: [ids.run, ids.project, ids.baseVersion],
    },
    {
      sql: `INSERT INTO project_leases
        (project_id, lease_id, run_id, owner_actor_id, fence, state,
         acquired_at, heartbeat_at, expires_at)
        VALUES (?, ?, NULL, NULL, ?, 'released', ?, ?, ?)`,
      params: [ids.project, ids.lease, baseFence, t - 1000, t - 1000, t],
    },
  ];

  if (options.largeDecimals) {
    statements.push({
      sql: `INSERT INTO events
        (event_seq, id, project_id, run_id, tx_id, tx_index, tx_size, type,
         payload, schema_version, created_at)
        VALUES (9007199254740992, ?, ?, NULL, ?, 0, 1, 'seed.large', '{}', 1, ?)`,
      params: [newId("evt"), ids.project, ids.seedTx, t],
    });
  }

  if (options.competingLease) {
    statements.push(
      {
        sql: `INSERT INTO runs
          (id, project_id, edition_id, stage_id, round_id, actor_id, mode, runtime, provider,
           model, role, status, retry_of, parent_run_id, external_session_ref,
           base_control_rev, context_snapshot_id, workflow_version, usage_json,
           started_at, ended_at)
          VALUES (?, ?, ?, ?, ?, ?, 'A', 'node', 'opencode-go',
           'opencode-go/deepseek-v4.1-flash', 'worker', 'running', NULL, NULL, NULL,
           ?, NULL, 'spike-1', NULL, NULL, NULL)`,
        params: [
          ids.competingRun,
          ids.project,
          ids.edition,
          ids.stage,
          ids.round,
          ids.agent,
          controlRev,
        ],
      },
      {
        sql: `UPDATE project_leases
              SET lease_id = ?, run_id = ?, owner_actor_id = ?, fence = ?,
                  state = 'active', acquired_at = ?, heartbeat_at = ?, expires_at = ?
              WHERE project_id = ?`,
        params: [
          "lea_01J9Z3K7QX",
          ids.competingRun,
          ids.agent,
          nextFence,
          t,
          t,
          1762311720000,
          ids.project,
        ],
      },
    );
  }

  await db.batch(statements);
  return {
    ids,
    projectId: ids.project,
    runId: ids.run,
    artifactObjectId: ids.artifact,
    baseVersionId: ids.baseVersion,
    inputVersionId: ids.inputVersion,
  };
}

export interface MutationInput {
  projectId: string;
  actorId: string;
  clientRequestId: string;
  requestHash: string;
  action: string;
  editionId?: string | null;
  stageId?: string | null;
  roundId?: string | null;
  runId?: string | null;
  baseControlRev?: string | null;
  leaseId?: string | null;
  fence?: string | null;
  resultJson: string;
  createdAt: number;
}

export function mutationStatement(txId: string, input: MutationInput): SqlStatement {
  return {
    sql: `INSERT INTO mutation_commits
      (id, project_id, edition_id, stage_id, round_id, run_id, actor_id, via,
       client_request_id, request_hash, action, base_control_rev, lease_id, fence,
       guard_ok, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'http', ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    params: [
      txId,
      input.projectId,
      input.editionId ?? null,
      input.stageId ?? null,
      input.roundId ?? null,
      input.runId ?? null,
      input.actorId,
      input.clientRequestId,
      input.requestHash,
      input.action,
      input.baseControlRev ?? null,
      input.leaseId ?? null,
      input.fence ?? null,
      input.resultJson,
      input.createdAt,
    ],
  };
}

export { eventStatements };

// One business-logic implementation. Platform differences live in db.ts adapters only.
// This is a spike: token/scope checks are intentionally simplified and documented as such.

import {
  FORMAT_VERSION,
  PesError,
  errors,
  type ErrorEnvelope,
  type SuccessEnvelope,
} from "./contract.ts";
import type { Db, SqlStatement } from "./db.ts";
import { compareDecimal, incrementDecimal } from "./decimal.ts";
import { validateClaim, validateComplete, validateResults, validateWait } from "./dto.ts";
import {
  eventStatements,
  mutationStatement,
  newId,
  sha256Hex,
  stableStringify,
  type Ids,
} from "./store.ts";

export type ActorKind = "anonymous" | "agent" | "human";

export interface Auth {
  kind: ActorKind;
  actorId: string;
  projectId: string | null;
}

export interface RequestContext {
  db: Db;
  auth: Auth;
  now: number;
  ids: Ids;
  /** Test-only switch: capabilities is `any` in the fixture normal case but 401 in its error case. */
  requireCapabilitiesAuth?: boolean;
}

export interface CoreRequest {
  method: string;
  pathname: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface CoreResponse {
  status: number;
  body: SuccessEnvelope | ErrorEnvelope;
}

export type Envelope = SuccessEnvelope | ErrorEnvelope;

export function requestId(): string {
  return newId("req");
}

export function success<T>(request: string, data: T): SuccessEnvelope<T> {
  return { format_version: FORMAT_VERSION, data, meta: { request_id: request } };
}

export function asEnvelope(result: CoreResponse): Envelope {
  return result.body;
}

function requireAgent(ctx: RequestContext, projectId: string): string {
  if (ctx.auth.kind === "anonymous") throw errors.unauthorized();
  if (ctx.auth.projectId !== null && ctx.auth.projectId !== projectId) throw errors.forbidden();
  return ctx.auth.actorId;
}

function requireKey(headers: Record<string, string>): string {
  const key = headers["Idempotency-Key"] ?? headers["idempotency-key"];
  if (!key) throw errors.missingIdempotencyKey();
  return key;
}

interface StoredMutation {
  request_hash: string;
  result_json: string;
}

async function findMutation(
  ctx: RequestContext,
  projectId: string,
  actorId: string,
  key: string,
): Promise<StoredMutation | null> {
  const rows = await ctx.db.all<StoredMutation>(
    `SELECT request_hash, result_json FROM mutation_commits
     WHERE project_id = ? AND actor_id = ? AND client_request_id = ?`,
    [projectId, actorId, key],
  );
  return rows[0] ?? null;
}

async function replayOrConflict(
  ctx: RequestContext,
  projectId: string,
  actorId: string,
  key: string,
  body: unknown,
): Promise<Record<string, unknown> | null> {
  const existing = await findMutation(ctx, projectId, actorId, key);
  if (!existing) return null;
  if (existing.request_hash !== sha256Hex(stableStringify(body))) {
    throw errors.idempotencyKeyReused();
  }
  return JSON.parse(existing.result_json) as Record<string, unknown>;
}

interface ProjectRow {
  id: string;
  slug: string;
  status: string;
  control_rev: string;
  active_edition_id: string | null;
  current_policy_id: string | null;
}

async function loadProjectFor(ctx: RequestContext, projectId: string): Promise<ProjectRow> {
  const project = await loadProject(ctx, projectId);
  requireAgent(ctx, projectId);
  return project;
}

async function loadProject(ctx: RequestContext, projectId: string): Promise<ProjectRow> {
  const rows = await ctx.db.all<ProjectRow>(
    `SELECT id, slug, status, CAST(control_rev AS TEXT) AS control_rev,
            active_edition_id, current_policy_id
     FROM projects WHERE id = ?`,
    [projectId],
  );
  const row = rows[0];
  if (!row) throw errors.projectNotFound(projectId);
  return row;
}

interface LeaseRow {
  lease_id: string;
  run_id: string | null;
  owner_actor_id: string | null;
  fence: string;
  state: string;
  expires_at: number;
}

async function loadLease(ctx: RequestContext, projectId: string): Promise<LeaseRow | null> {
  const rows = await ctx.db.all<LeaseRow>(
    `SELECT lease_id, run_id, owner_actor_id, CAST(fence AS TEXT) AS fence, state, expires_at
     FROM project_leases WHERE project_id = ?`,
    [projectId],
  );
  return rows[0] ?? null;
}

function assertLeaseHolder(lease: LeaseRow | null, runId: string, leaseId: string, fence: string): void {
  if (!lease || lease.state !== "active" || lease.run_id !== runId) {
    throw errors.notLeaseHolder(runId, lease?.lease_id ?? null);
  }
  if (lease.lease_id !== leaseId || compareDecimal(lease.fence, fence) !== 0) {
    throw errors.notLeaseHolder(runId, lease.lease_id);
  }
}

// ---------------------------------------------------------------------------
// Read paths

export async function getCapabilities(ctx: RequestContext): Promise<CoreResponse> {
  if (ctx.requireCapabilitiesAuth && ctx.auth.kind === "anonymous") {
    throw errors.unauthorized();
  }
  return {
    status: 200,
    body: success(requestId(), {
      server: "pes-web0-spike",
      api_version: "v1",
      capabilities: {
        operations: {
          "capabilities.get": { supported: true },
          "context.get": { supported: true },
          "object.version.get": { supported: true },
          "runs.claim": { supported: true },
          "results.submit": { supported: true },
          "runs.wait": { supported: true },
          "runs.complete": { supported: true },
          "runs.create": { supported: false },
          exports: { supported: false },
          webmcp: { supported: false },
        },
        limits: {
          long_poll_max_ms: 25000,
          request_body_max_bytes: 262144,
          results_per_submit: 20,
          list_max_items: 100,
          agent_requests_per_minute: 60,
        },
        error_codes: ["rev_conflict", "lease_lost", "policy_blocked", "cursor_invalid"],
      },
    }),
  };
}

export async function getContext(
  ctx: RequestContext,
  projectId: string,
): Promise<CoreResponse> {
  const project = await loadProjectFor(ctx, projectId);
  const editions = await ctx.db.all<{ id: string; edition_no: string; status: string }>(
    `SELECT id, CAST(edition_no AS TEXT) AS edition_no, status FROM editions
     WHERE project_id = ? AND id = ?`,
    [projectId, project.active_edition_id],
  );
  const edition = editions[0] ?? null;
  const stages = await ctx.db.all<{
    id: string;
    key: string;
    ordinal: number;
    status: string;
  }>(
    `SELECT id, key, ordinal, status FROM stages
     WHERE project_id = ? AND edition_id = ? ORDER BY ordinal LIMIT 1`,
    [projectId, project.active_edition_id],
  );
  const stage = stages[0] ?? null;
  const rounds = stage
    ? await ctx.db.all<{ id: string; round_no: string; state: string }>(
        `SELECT id, CAST(round_no AS TEXT) AS round_no, state FROM rounds
         WHERE project_id = ? AND stage_id = ? AND state = 'open' LIMIT 1`,
        [projectId, stage.id],
      )
    : [];
  const round = rounds[0] ?? null;
  const policies = await ctx.db.all<{ policy_rev: string; allow_opencode_go: number }>(
    `SELECT CAST(policy_rev AS TEXT) AS policy_rev, allow_opencode_go
     FROM project_policy_versions WHERE project_id = ?
     ORDER BY policy_rev DESC LIMIT 1`,
    [projectId],
  );
  const policy = policies[0] ?? null;
  const counts = await ctx.db.all<{ objects: number; versions: number; event_seq: string }>(
    `SELECT
       (SELECT COUNT(*) FROM objects WHERE project_id = ?) AS objects,
       (SELECT COUNT(*) FROM object_versions WHERE project_id = ?) AS versions,
       (SELECT CAST(COALESCE(MAX(event_seq), 0) AS TEXT) FROM events WHERE project_id = ?) AS event_seq`,
    [projectId, projectId, projectId],
  );
  const count = counts[0] ?? { objects: 0, versions: 0, event_seq: "0" };
  const digest = `sha256:${sha256Hex(
    `${projectId}:${project.control_rev}:${count.objects}:${count.versions}:${count.event_seq}`,
  )}`;
  return {
    status: 200,
    body: success(requestId(), {
      project: {
        id: project.id,
        slug: project.slug,
        status: project.status,
        control_rev: project.control_rev,
      },
      edition: edition
        ? { id: edition.id, edition_no: edition.edition_no, status: edition.status }
        : null,
      stage: stage
        ? { id: stage.id, key: stage.key, ordinal: stage.ordinal, status: stage.status }
        : null,
      round: round ? { id: round.id, round_no: round.round_no, state: round.state } : null,
      policy: policy
        ? { allow_opencode_go: policy.allow_opencode_go === 1, policy_rev: policy.policy_rev }
        : null,
      digest,
      manifest: {
        object_count: count.objects,
        version_count: count.versions,
        through_event_seq: count.event_seq,
      },
      next_cursor: `cur_${sha256Hex(digest).slice(0, 16)}`,
    }),
  };
}

export async function getVersion(
  ctx: RequestContext,
  projectId: string,
  objectId: string,
  versionId: string,
): Promise<CoreResponse> {
  await loadProjectFor(ctx, projectId);
  const objects = await ctx.db.all<{
    id: string;
    kind: string;
    display_no: string;
    current_version_id: string | null;
    rev: string;
  }>(
    `SELECT id, kind, CAST(display_no AS TEXT) AS display_no, current_version_id,
            CAST(rev AS TEXT) AS rev
     FROM objects WHERE project_id = ? AND id = ?`,
    [projectId, objectId],
  );
  const object = objects[0];
  if (!object) throw errors.versionNotFound(objectId, versionId);
  const versions = await ctx.db.all<{
    id: string;
    version_no: string;
    based_on_version_id: string | null;
    content_hash: string;
    created_at: number;
    actor_id: string;
    run_id: string | null;
  }>(
    `SELECT id, CAST(version_no AS TEXT) AS version_no, based_on_version_id,
            content_hash, created_at, actor_id, run_id
     FROM object_versions WHERE project_id = ? AND object_id = ? AND id = ?`,
    [projectId, objectId, versionId],
  );
  const version = versions[0];
  if (!version) throw errors.versionNotFound(objectId, versionId);
  const artifacts = await ctx.db.all<{
    kind: string;
    title: string;
    body_md: string | null;
    status: string;
  }>(
    `SELECT a.kind, av.title, av.body_md, av.status
     FROM artifact_versions av
     JOIN artifacts a ON a.project_id = av.project_id AND a.object_id = av.object_id
     WHERE av.project_id = ? AND av.version_id = ?`,
    [projectId, versionId],
  );
  return {
    status: 200,
    body: success(requestId(), {
      object: {
        id: object.id,
        kind: object.kind,
        display_no: object.display_no,
        current_version_id: object.current_version_id,
        rev: object.rev,
      },
      version: {
        id: version.id,
        version_no: version.version_no,
        based_on_version_id: version.based_on_version_id,
        content_hash: version.content_hash,
        created_at: version.created_at,
        actor_id: version.actor_id,
        run_id: version.run_id,
      },
      artifact: artifacts[0] ?? null,
      files: [],
    }),
  };
}

// ---------------------------------------------------------------------------
// Write paths

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

interface RunRow {
  id: string;
  status: string;
  base_control_rev: string;
}

async function loadRun(ctx: RequestContext, projectId: string, runId: string): Promise<RunRow> {
  const rows = await ctx.db.all<RunRow>(
    `SELECT id, status, CAST(base_control_rev AS TEXT) AS base_control_rev
     FROM runs WHERE project_id = ? AND id = ?`,
    [projectId, runId],
  );
  const run = rows[0];
  if (!run) throw errors.runNotFound(runId);
  return run;
}

export async function claimWithKey(
  ctx: RequestContext,
  projectId: string,
  actorId: string,
  body: unknown,
  idempotencyKey: string,
): Promise<CoreResponse> {
  requireAgent(ctx, projectId);
  if (!idempotencyKey) throw errors.missingIdempotencyKey();
  const input = validateClaim(body);
  const replay = await replayOrConflict(ctx, projectId, actorId, idempotencyKey, body);
  if (replay) {
    return { status: 201, body: success(requestId(), { ...replay, replayed: true }) };
  }
  const project = await loadProject(ctx, projectId);
  if (compareDecimal(input.expected_control_rev, project.control_rev) !== 0) {
    throw errors.revConflict({ expected: input.expected_control_rev, current: project.control_rev });
  }
  const run = await loadRun(ctx, projectId, input.run_id);
  if (TERMINAL.has(run.status)) throw errors.runTerminal(run.id, run.status);

  const lease = await loadLease(ctx, projectId);
  if (lease && lease.state === "active" && lease.expires_at > ctx.now) {
    throw errors.leaseHeld(
      lease.run_id ?? "",
      lease.expires_at,
      Math.max(0, lease.expires_at - ctx.now),
    );
  }
  const fence = incrementDecimal(lease?.fence ?? "0");
  const leaseId = newId("lea");
  const expiresAt = ctx.now + input.lease_ttl_ms;
  const txId = newId("mut");
  const result = {
    run: { id: run.id, status: "running", base_control_rev: project.control_rev },
    lease: { lease_id: leaseId, fence, expires_at: expiresAt },
    context_cursor: `cur_${sha256Hex(`${projectId}:${fence}`).slice(0, 16)}`,
  };
  const statements: SqlStatement[] = [
    {
      sql: `UPDATE project_leases
        SET lease_id = ?, run_id = ?, owner_actor_id = ?, fence = ?, state = 'active',
            acquired_at = ?, heartbeat_at = ?, expires_at = ?
        WHERE project_id = ?`,
      params: [leaseId, run.id, actorId, Number(fence), ctx.now, ctx.now, expiresAt, projectId],
    },
    {
      sql: `UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?`,
      params: [ctx.now, run.id],
    },
    mutationStatement(txId, {
      projectId,
      actorId,
      clientRequestId: idempotencyKey,
      requestHash: sha256Hex(stableStringify(body)),
      action: "runs.claim",
      runId: run.id,
      baseControlRev: Number(project.control_rev),
      leaseId,
      fence: Number(fence),
      resultJson: JSON.stringify(result),
      createdAt: ctx.now,
    }),
    ...eventStatements({
      txId,
      projectId,
      runId: run.id,
      type: "run.claimed",
      count: 2,
      createdAt: ctx.now,
    }),
  ];
  await ctx.db.batch(statements);
  return { status: 201, body: success(requestId(), result) };
}

export async function submitResults(
  ctx: RequestContext,
  projectId: string,
  runId: string,
  body: unknown,
  idempotencyKey: string | undefined,
): Promise<CoreResponse> {
  const actorId = requireAgent(ctx, projectId);
  if (!idempotencyKey) throw errors.missingIdempotencyKey();
  const input = validateResults(body);
  const replay = await replayOrConflict(ctx, projectId, actorId, idempotencyKey, body);
  if (replay) {
    return { status: 201, body: success(requestId(), { ...replay, replayed: true }) };
  }
  const project = await loadProject(ctx, projectId);
  const run = await loadRun(ctx, projectId, runId);
  if (TERMINAL.has(run.status)) throw errors.runTerminal(run.id, run.status);
  const lease = await loadLease(ctx, projectId);
  assertLeaseHolder(lease, runId, input.lease_id, input.fence);

  interface ObjectState {
    id: string;
    current_version_id: string | null;
    rev: string;
    version_no: string;
  }
  const targets: ObjectState[] = [];
  for (const result of input.results) {
    const rows = await ctx.db.all<ObjectState>(
      `SELECT o.id, o.current_version_id, CAST(o.rev AS TEXT) AS rev,
              CAST(COALESCE(MAX(v.version_no), 0) AS TEXT) AS version_no
       FROM objects o LEFT JOIN object_versions v
         ON v.project_id = o.project_id AND v.object_id = o.id
       WHERE o.project_id = ? AND o.id = ?
       GROUP BY o.id`,
      [projectId, result.object_id],
    );
    const target = rows[0];
    if (!target) {
      throw new PesError({
        code: "object_not_found",
        status: 404,
        message: "대상 객체를 찾을 수 없습니다.",
        target: "$.body.results[0].object_id",
        details: { object_id: result.object_id },
        nextAction: "reread_context",
      });
    }
    if (target.current_version_id !== result.base_version_id) {
      throw errors.revConflict({
        expected: result.base_version_id,
        current: target.current_version_id ?? "",
        objectId: result.object_id,
      });
    }
    targets.push(target);
  }

  const txId = newId("mut");
  const eventBaseRows = await ctx.db.all<{ next_seq: number }>(
    `SELECT COALESCE(MAX(event_seq), 0) + 1 AS next_seq FROM events WHERE project_id = ?`,
    [projectId],
  );
  const nextEventSeq = eventBaseRows[0]?.next_seq ?? 1;
  const returnedVersions: { object_id: string; version_id: string; version_no: string }[] = [];
  const objectStatements: SqlStatement[] = [];

  input.results.forEach((result, index) => {
    const target = targets[index];
    if (!target) throw errors.internal("result target lost");
    const versionId = newId("ver");
    const versionNo = incrementDecimal(target.version_no);
    const newRev = incrementDecimal(target.rev);
    returnedVersions.push({
      object_id: result.object_id,
      version_id: versionId,
      version_no: versionNo,
    });
    objectStatements.push(
      {
        sql: `INSERT INTO object_versions
          (id, project_id, object_id, kind, version_no, based_on_version_id,
           created_in_round_id, actor_id, run_id, tx_id, content_hash, created_at)
          VALUES (?, ?, ?, 'artifact', ?, ?, NULL, ?, ?, ?, ?, ?)`,
        params: [
          versionId,
          projectId,
          result.object_id,
          Number(versionNo),
          result.base_version_id,
          actorId,
          runId,
          txId,
          sha256Hex(result.body_md),
          ctx.now,
        ],
      },
      {
        sql: `UPDATE objects SET current_version_id = ?, rev = ? WHERE project_id = ? AND id = ?`,
        params: [versionId, Number(newRev), projectId, result.object_id],
      },
      {
        sql: `INSERT INTO artifact_versions
          (project_id, version_id, object_id, object_kind, title, summary, body_md, status,
           stats, conflicts, verify, metadata_json)
          VALUES (?, ?, ?, 'artifact', ?, '', ?, 'draft', '[]', '[]', 'null', '{}')`,
        params: [projectId, versionId, result.object_id, result.title, result.body_md],
      },
      {
        sql: `UPDATE artifacts SET origin_version_id = ?
              WHERE project_id = ? AND object_id = ?`,
        params: [versionId, projectId, result.object_id],
      },
    );
  });

  const resultData = {
    object_versions: returnedVersions,
    mutation_id: txId,
    event_seq: String(nextEventSeq + 1),
  };
  const statements: SqlStatement[] = [
    mutationStatement(txId, {
      projectId,
      actorId,
      clientRequestId: idempotencyKey,
      requestHash: sha256Hex(stableStringify(body)),
      action: "results.submit",
      runId,
      baseControlRev: Number(project.control_rev),
      leaseId: input.lease_id,
      fence: Number(input.fence),
      resultJson: JSON.stringify(resultData),
      createdAt: ctx.now,
    }),
    ...objectStatements,
  ];

  for (const receipt of input.input_receipts) {
    statements.push({
      sql: `INSERT INTO run_input_receipts
        (project_id, run_id, input_version_id, state, reason, applied_tx_id)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, input_version_id) DO UPDATE SET
          state = excluded.state, reason = excluded.reason, applied_tx_id = excluded.applied_tx_id`,
      params: [
        projectId,
        runId,
        receipt.input_version_id,
        receipt.state,
        null,
        receipt.state === "applied" ? txId : null,
      ],
    });
  }

  statements.push(
    ...eventStatements({
      txId,
      projectId,
      runId,
      type: "results.submitted",
      count: 2,
      objectId: input.results[0]?.object_id ?? null,
      createdAt: ctx.now,
    }),
  );
  await ctx.db.batch(statements);
  return { status: 201, body: success(requestId(), resultData) };
}

export async function wait(
  ctx: RequestContext,
  projectId: string,
  runId: string,
  body: unknown,
): Promise<CoreResponse> {
  const actorId = requireAgent(ctx, projectId);
  const input = validateWait(body);
  const run = await loadRun(ctx, projectId, runId);
  if (TERMINAL.has(run.status)) throw errors.runTerminal(run.id, run.status);
  const lease = await loadLease(ctx, projectId);
  assertLeaseHolder(lease, runId, input.lease_id, input.fence);
  const txId = newId("mut");
  const statements: SqlStatement[] = [
    {
      sql: `UPDATE runs SET status = 'waiting_human' WHERE project_id = ? AND id = ?`,
      params: [projectId, runId],
    },
    {
      sql: `UPDATE project_leases SET state = 'released', heartbeat_at = ?, expires_at = ?
            WHERE project_id = ?`,
      params: [ctx.now, ctx.now + 1, projectId],
    },
    mutationStatement(txId, {
      projectId,
      actorId,
      clientRequestId: `wait:${runId}:${input.fence}:${ctx.now}`,
      requestHash: sha256Hex(stableStringify(body)),
      action: "runs.wait",
      runId,
      leaseId: input.lease_id,
      fence: Number(input.fence),
      resultJson: "{}",
      createdAt: ctx.now,
    }),
    {
      sql: `INSERT INTO run_input_receipts
        (project_id, run_id, input_version_id, state, reason, applied_tx_id)
        VALUES (?, ?, ?, 'seen', 'waiting_human', NULL)
        ON CONFLICT(run_id, input_version_id) DO UPDATE SET state = excluded.state`,
      params: [projectId, runId, ctx.ids.inputVersion],
    },
    ...eventStatements({
      txId,
      projectId,
      runId,
      type: "run.waiting_human",
      count: 2,
      createdAt: ctx.now,
    }),
  ];
  await ctx.db.batch(statements);
  return {
    status: 200,
    body: success(requestId(), {
      run: { id: runId, status: "waiting_human" },
      lease: { released: true, fence: input.fence },
      waiting: { since: ctx.now, question_ids: input.question_ids },
    }),
  };
}

export async function complete(
  ctx: RequestContext,
  projectId: string,
  runId: string,
  body: unknown,
  idempotencyKey: string | undefined,
): Promise<CoreResponse> {
  const actorId = requireAgent(ctx, projectId);
  if (!idempotencyKey) throw errors.missingIdempotencyKey();
  const input = validateComplete(body);
  const replay = await replayOrConflict(ctx, projectId, actorId, idempotencyKey, body);
  if (replay) {
    return { status: 200, body: success(requestId(), { ...replay, replayed: true }) };
  }
  const run = await loadRun(ctx, projectId, runId);
  if (TERMINAL.has(run.status)) throw errors.runTerminal(run.id, run.status);
  const lease = await loadLease(ctx, projectId);
  assertLeaseHolder(lease, runId, input.lease_id, input.fence);
  const txId = newId("mut");
  const result = {
    run: { id: runId, status: input.status, completed_at: ctx.now },
    stage_approved: false,
    note: "complete는 run 종료일 뿐 라운드 봉인·단계 승인이 아닙니다.",
  };
  await ctx.db.batch([
    {
      sql: `UPDATE runs SET status = ?, ended_at = ? WHERE project_id = ? AND id = ?`,
      params: [input.status, ctx.now, projectId, runId],
    },
    {
      sql: `UPDATE project_leases SET state = 'released', heartbeat_at = ?, expires_at = ?
            WHERE project_id = ?`,
      params: [ctx.now, ctx.now + 1, projectId],
    },
    mutationStatement(txId, {
      projectId,
      actorId,
      clientRequestId: idempotencyKey,
      requestHash: sha256Hex(stableStringify(body)),
      action: "runs.complete",
      runId,
      leaseId: input.lease_id,
      fence: Number(input.fence),
      resultJson: JSON.stringify(result),
      createdAt: ctx.now,
    }),
    ...eventStatements({
      txId,
      projectId,
      runId,
      type: "run.completed",
      count: 1,
      createdAt: ctx.now,
    }),
  ]);
  return { status: 200, body: success(requestId(), result) };
}

// ---------------------------------------------------------------------------
// Router

interface Route {
  method: string;
  operation: string;
  segments: string[];
  handler: (
    ctx: RequestContext,
    params: Record<string, string>,
    request: CoreRequest,
  ) => Promise<CoreResponse>;
}

const routes: Route[] = [
  {
    method: "GET",
    operation: "capabilities.get",
    segments: ["api", "v1", "capabilities"],
    handler: (ctx) => getCapabilities(ctx),
  },
  {
    method: "GET",
    operation: "context.get",
    segments: ["api", "v1", "projects", "{project_id}", "context"],
    handler: (ctx, params) => getContext(ctx, params.project_id ?? ""),
  },
  {
    method: "GET",
    operation: "object.version.get",
    segments: [
      "api",
      "v1",
      "projects",
      "{project_id}",
      "objects",
      "{object_id}",
      "versions",
      "{version_id}",
    ],
    handler: (ctx, params) =>
      getVersion(ctx, params.project_id ?? "", params.object_id ?? "", params.version_id ?? ""),
  },
  {
    method: "POST",
    operation: "runs.claim",
    segments: ["api", "v1", "projects", "{project_id}", "claims"],
    handler: (ctx, params, request) =>
      claimWithKey(
        ctx,
        params.project_id ?? "",
        ctx.auth.actorId,
        request.body,
        request.headers["Idempotency-Key"] ?? request.headers["idempotency-key"] ?? "",
      ),
  },
  {
    method: "POST",
    operation: "results.submit",
    segments: ["api", "v1", "projects", "{project_id}", "runs", "{run_id}", "results"],
    handler: (ctx, params, request) =>
      submitResults(
        ctx,
        params.project_id ?? "",
        params.run_id ?? "",
        request.body,
        request.headers["Idempotency-Key"] ?? request.headers["idempotency-key"],
      ),
  },
  {
    method: "POST",
    operation: "runs.wait",
    segments: ["api", "v1", "projects", "{project_id}", "runs", "{run_id}", "wait"],
    handler: (ctx, params, request) =>
      wait(ctx, params.project_id ?? "", params.run_id ?? "", request.body),
  },
  {
    method: "POST",
    operation: "runs.complete",
    segments: ["api", "v1", "projects", "{project_id}", "runs", "{run_id}", "complete"],
    handler: (ctx, params, request) =>
      complete(
        ctx,
        params.project_id ?? "",
        params.run_id ?? "",
        request.body,
        request.headers["Idempotency-Key"] ?? request.headers["idempotency-key"],
      ),
  },
];

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index];
    const value = actual[index];
    if (!expected || value === undefined) return null;
    if (expected.startsWith("{") && expected.endsWith("}")) {
      params[expected.slice(1, -1)] = decodeURIComponent(value);
    } else if (expected !== value) {
      return null;
    }
  }
  return params;
}

export async function dispatch(ctx: RequestContext, request: CoreRequest): Promise<CoreResponse> {
  const pathname = request.pathname.split("?")[0] ?? request.pathname;
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  let pathMatched = false;
  for (const route of routes) {
    const params = matchSegments(route.segments, segments);
    if (!params) continue;
    pathMatched = true;
    if (route.method !== request.method) continue;
    return route.handler(ctx, params, request);
  }
  if (pathMatched) throw errors.methodNotAllowed(request.method, pathname);
  throw errors.routeNotFound(request.method, pathname);
}

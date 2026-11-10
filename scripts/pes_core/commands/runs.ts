// Run, lease, and fence command definitions (stage 2 PR5).
//
// These definitions hold the only business-table SQL for the run commands. The
// public functions in scripts/pes_core/runs.ts are thin wrappers that call
// CommandService.execute once, so every run write still passes the registry,
// project/actor check, policy, receipt replay, rev/lease guard, change, and
// events + receipt in one transaction.
//
// A lease is current only while the project_leases row is the project's active,
// unexpired lease and both lease_id and fence match. An expired lease is never
// revived: it must be replaced by a new claim, which raises the fence by one.

import { read_credential_actor } from "../actors.ts";
import {
  insert_receipt,
  is_human_owner_actor,
  reject_unknown_fields,
  require_base_control_rev,
  require_human_owner_actor,
  require_non_empty_string,
  require_record,
  type CommandDefinition,
  type CommandResult,
  type CommandRuntime,
  type EventDraft,
} from "./shared.ts";
import { ApiError } from "../errors.ts";

const CLAIMABLE_RUN_STATUSES = new Set(["queued", "waiting_human", "blocked_usage", "interrupted"]);
const COMPLETE_RUN_STATUSES = new Set(["succeeded", "failed"]);
const INPUT_RECEIPT_STATES = new Set(["seen", "applied", "ignored"]);

interface RunRow {
  id: string;
  actor_id: string;
  status: string;
  parent_run_id: string | null;
}

interface LeaseRow {
  lease_id: string;
  run_id: string | null;
  owner_actor_id: string | null;
  fence: bigint;
  state: string;
  acquired_at: bigint;
  heartbeat_at: bigint;
  expires_at: bigint;
}

interface LeaseGuard {
  run_id: string;
  lease_id: string;
  fence: number;
}

interface Scope {
  project_id: string;
  actor_id: string;
  control_rev: bigint;
}

function require_scope(runtime: CommandRuntime): Scope {
  const project = runtime.project;
  const actor_id = runtime.actor_id;
  if (project === null || actor_id === null) {
    throw new Error("a run command must resolve a project and actor first");
  }
  return { project_id: project.id, actor_id, control_rev: project.control_rev };
}

function optional_string(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || !value.isWellFormed()) {
    throw new ApiError("invalid_payload", `${field} must be a non-empty well-formed string`);
  }
  return value;
}

function require_guard(payload: Record<string, unknown>): LeaseGuard {
  const run_id = require_non_empty_string(payload, "run_id");
  const lease_id = require_non_empty_string(payload, "lease_id");
  const fence = payload.fence;
  if (typeof fence !== "number" || !Number.isSafeInteger(fence) || fence < 1) {
    throw new ApiError("invalid_payload", "fence must be a positive safe integer");
  }
  return { run_id, lease_id, fence };
}

function read_lease(runtime: CommandRuntime, project_id: string): LeaseRow | undefined {
  return runtime.db.get<LeaseRow>(
    `SELECT lease_id, run_id, owner_actor_id, fence, state, acquired_at, heartbeat_at, expires_at
     FROM project_leases WHERE project_id = ?`,
    project_id,
  );
}

function is_live_lease(lease: LeaseRow, now_ms: number): boolean {
  return lease.state === "active" && now_ms < Number(lease.expires_at);
}

/** The only accepted guard: the project's active, unexpired lease with the exact id and fence. */
function require_current_lease(
  runtime: CommandRuntime,
  guard: LeaseGuard,
  allow_owner = false,
): LeaseRow {
  const scope = require_scope(runtime);
  const lease = read_lease(runtime, scope.project_id);
  if (
    lease === undefined ||
    !is_live_lease(lease, runtime.now_ms) ||
    lease.lease_id !== guard.lease_id ||
    Number(lease.fence) !== guard.fence ||
    lease.run_id !== guard.run_id ||
    (lease.owner_actor_id !== scope.actor_id && !(allow_owner && is_human_owner_actor(runtime)))
  ) {
    throw new ApiError("conflict", "the lease is not current");
  }
  return lease;
}

function write_run_status(
  runtime: CommandRuntime,
  project_id: string,
  run_id: string,
  status: string,
  ended_at: number | null,
): void {
  const written = runtime.db.run(
    "UPDATE runs SET status = ?, ended_at = ? WHERE project_id = ? AND id = ?",
    status,
    ended_at,
    project_id,
    run_id,
  );
  if (written.changes !== 1n) {
    throw new ApiError("conflict", "the run was not updated");
  }
}

/** Release the current lease, keeping its fence for the historical record. */
function release_lease(runtime: CommandRuntime, guard: LeaseGuard): void {
  const scope = require_scope(runtime);
  const written = runtime.db.run(
    "UPDATE project_leases SET state = 'released' WHERE project_id = ? AND lease_id = ? AND fence = ? AND state = 'active' AND expires_at > ?",
    scope.project_id,
    guard.lease_id,
    guard.fence,
    runtime.now_ms,
  );
  if (written.changes !== 1n) {
    throw new ApiError("conflict", "the lease is not current");
  }
}

function guarded_result(
  scope: Scope,
  guard: LeaseGuard,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    project_id: scope.project_id,
    run_id: guard.run_id,
    lease_id: guard.lease_id,
    fence: guard.fence,
    ...extra,
  };
}

/** The root of a hand-off chain (the same run when it has no parent). */
function flow_root(runtime: CommandRuntime, project_id: string, run_id: string): string | null {
  const seen = new Set<string>();
  let current: string | null = run_id;
  let root: string | null = null;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    root = current;
    const parent: { parent_run_id: string | null } | undefined = runtime.db.get<{
      parent_run_id: string | null;
    }>("SELECT parent_run_id FROM runs WHERE project_id = ? AND id = ?", project_id, current);
    current = parent?.parent_run_id ?? null;
  }
  return root;
}

/**
 * Input receipts already applied anywhere in this hand-off flow: the root run
 * found through parent_run_id and every run descended from that root (ancestors,
 * descendants, siblings). Independent roots do not see each other.
 */
function applied_receipt(
  runtime: CommandRuntime,
  project_id: string,
  run_id: string,
  input_version_id: string,
): { applied_tx_id: string | null } | undefined {
  const root = flow_root(runtime, project_id, run_id);
  if (root === null) return undefined;
  return runtime.db.get<{ applied_tx_id: string | null }>(
    `WITH RECURSIVE flow(id) AS (
       SELECT id FROM runs WHERE project_id = ? AND id = ?
       UNION
       SELECT child.id FROM runs child JOIN flow ON child.parent_run_id = flow.id
       WHERE child.project_id = ?
     )
     SELECT applied_tx_id FROM run_input_receipts
     WHERE project_id = ? AND input_version_id = ? AND state = 'applied'
       AND run_id IN (SELECT id FROM flow)
     ORDER BY rowid
     LIMIT 1`,
    project_id,
    root,
    project_id,
    project_id,
    input_version_id,
  );
}

function require_input_version(runtime: CommandRuntime, project_id: string, input_version_id: string): void {
  const version = runtime.db.get<{ ok: bigint }>(
    "SELECT 1 AS ok FROM object_versions WHERE project_id = ? AND id = ?",
    project_id,
    input_version_id,
  );
  if (version === undefined) {
    throw new ApiError("invalid_payload", "input_version_id is not an object version of this project");
  }
}

function claim_runtime_scope(runtime: CommandRuntime): {
  scope: Scope;
  payload: Record<string, unknown>;
} {
  return { scope: require_scope(runtime), payload: require_record(runtime.payload) };
}

function run_claim(runtime: CommandRuntime): CommandResult {
  const { scope, payload } = claim_runtime_scope(runtime);
  // The service has already replayed a matching receipt; this is the in-tx CAS
  // check for a new attempt. A stale base never reaches a run or lease write.
  require_base_control_rev(runtime, runtime.ctx.base_control_rev);
  const requested_run_id = payload.run_id;
  let existing: RunRow | null = null;
  let run_id: string;
  let fresh: { mode: string; runtime: string; provider: string; model: string } | null = null;

  if (requested_run_id !== undefined) {
    if (payload.parent_run_id !== undefined || payload.role !== undefined) {
      throw new ApiError(
        "invalid_payload",
        "a resumed claim does not accept parent_run_id or role",
      );
    }
    if (typeof requested_run_id !== "string" || requested_run_id.trim().length === 0) {
      throw new ApiError("invalid_payload", "run_id must be a non-empty string");
    }
    const run = runtime.db.get<RunRow>(
      "SELECT id, actor_id, status, parent_run_id FROM runs WHERE project_id = ? AND id = ?",
      scope.project_id,
      requested_run_id,
    );
    if (run === undefined) {
      throw new ApiError("not_found", `run not found: ${requested_run_id}`);
    }
    if (!CLAIMABLE_RUN_STATUSES.has(run.status)) {
      throw new ApiError("conflict", "the run cannot be claimed in its current status");
    }
    if (run.actor_id !== scope.actor_id) {
      throw new ApiError("conflict", "the run belongs to another actor");
    }
    existing = run;
    run_id = run.id;
  } else {
    const requested_mode = payload.mode;
    if (requested_mode !== "A" && requested_mode !== "B") {
      throw new ApiError("invalid_payload", 'mode must be "A" or "B"');
    }
    const runtime_name = require_non_empty_string(payload, "runtime");
    const provider = require_non_empty_string(payload, "provider");
    const model = require_non_empty_string(payload, "model");
    if (requested_mode === "A" && (provider !== "opencode-go" || !model.startsWith("opencode-go/"))) {
      throw new ApiError("invalid_payload", "mode A requires the opencode-go provider and model prefix");
    }
    fresh = { mode: requested_mode, runtime: runtime_name, provider, model };
    run_id = runtime.new_id();
  }

  const role = payload.role;
  if (role !== undefined && role !== "worker" && role !== "reviewer") {
    throw new ApiError("invalid_payload", 'role must be "worker" or "reviewer"');
  }
  const parent_run_id = optional_string(payload, "parent_run_id");
  if (parent_run_id !== null) {
    const parent = runtime.db.get<{ id: string }>(
      "SELECT id FROM runs WHERE project_id = ? AND id = ?",
      scope.project_id,
      parent_run_id,
    );
    if (parent === undefined) {
      throw new ApiError("not_found", "parent_run_id is not a run of this project");
    }
  }

  const previous = read_lease(runtime, scope.project_id);
  if (previous !== undefined && is_live_lease(previous, runtime.now_ms)) {
    throw new ApiError("conflict", "the project already has an active lease");
  }

  // fence is stored as a SQLite integer and returned as a JSON number. Refuse
  // the claim before any write when the next value would leave the safe range:
  // a lease that later commands cannot present is never created.
  const next_fence = (previous === undefined ? 0n : previous.fence) + 1n;
  if (next_fence > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ApiError("conflict", "the lease fence is exhausted");
  }
  const fence = Number(next_fence);

  // Replacing an expired lease also ends the displaced run if it is still
  // running, in the same transaction and with its own event. Finished runs
  // (succeeded/failed/interrupted/...) are left untouched.
  const displaced_events: EventDraft[] = [];
  if (
    previous !== undefined &&
    previous.state === "active" &&
    previous.run_id !== null &&
    previous.run_id !== run_id
  ) {
    const displaced = runtime.db.get<{ status: string }>(
      "SELECT status FROM runs WHERE project_id = ? AND id = ?",
      scope.project_id,
      previous.run_id,
    );
    if (displaced !== undefined && displaced.status === "running") {
      const interrupted = runtime.db.run(
        "UPDATE runs SET status = 'interrupted', ended_at = ? WHERE project_id = ? AND id = ?",
        runtime.now_ms,
        scope.project_id,
        previous.run_id,
      );
      if (interrupted.changes !== 1n) {
        throw new Error("the displaced run was not interrupted");
      }
      displaced_events.push({
        type: "run.interrupted",
        run_id: previous.run_id,
        payload: { reason: "lease_expired" },
      });
    }
  }

  const lease_id = runtime.new_id();
  const expires_at = runtime.now_ms + runtime.run_config.lease_ttl_ms;

  if (existing === null) {
    if (fresh === null) {
      throw new Error("a new claim must resolve its mode, runtime, provider, and model");
    }
    const edition = runtime.db.get<{ active_edition_id: string | null }>(
      "SELECT active_edition_id FROM projects WHERE id = ?",
      scope.project_id,
    );
    if (edition === undefined || edition.active_edition_id === null) {
      throw new ApiError("conflict", "the project has no active edition");
    }
    const written = runtime.db.run(
      `INSERT INTO runs
         (id, project_id, edition_id, actor_id, mode, runtime, provider, model, role,
          status, parent_run_id, base_control_rev, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, NULL)`,
      run_id,
      scope.project_id,
      edition.active_edition_id,
      scope.actor_id,
      fresh.mode,
      fresh.runtime,
      fresh.provider,
      fresh.model,
      role ?? "worker",
      parent_run_id,
      Number(scope.control_rev),
      runtime.now_ms,
    );
    if (written.changes !== 1n) {
      throw new Error("the run was not created");
    }
  } else {
    const written = runtime.db.run(
      "UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ?), ended_at = NULL, go_block_reason = NULL, go_blocked_at = NULL, go_block_reset_at = NULL WHERE project_id = ? AND id = ?",
      runtime.now_ms,
      scope.project_id,
      run_id,
    );
    if (written.changes !== 1n) {
      throw new ApiError("conflict", "the run was not claimed");
    }
  }

  if (previous === undefined) {
    runtime.db.run(
      `INSERT INTO project_leases
         (project_id, lease_id, run_id, owner_actor_id, fence, state, acquired_at, heartbeat_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      scope.project_id,
      lease_id,
      run_id,
      scope.actor_id,
      fence,
      runtime.now_ms,
      runtime.now_ms,
      expires_at,
    );
  } else {
    const written = runtime.db.run(
      `UPDATE project_leases
       SET lease_id = ?, run_id = ?, owner_actor_id = ?, fence = ?, state = 'active',
           acquired_at = ?, heartbeat_at = ?, expires_at = ?
       WHERE project_id = ?`,
      lease_id,
      run_id,
      scope.actor_id,
      fence,
      runtime.now_ms,
      runtime.now_ms,
      expires_at,
      scope.project_id,
    );
    if (written.changes !== 1n) {
      throw new Error("the lease was not replaced");
    }
  }

  const result = {
    project_id: scope.project_id,
    run_id,
    lease_id,
    fence,
    expires_at,
    heartbeat_interval_ms: runtime.run_config.heartbeat_interval_ms,
  };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "run.claimed",
    base_control_rev: null,
    run_id,
    lease_id,
    fence,
    result,
  });
  return {
    result,
    events: [
      ...displaced_events,
      {
        type: "run.claimed",
        run_id,
        payload: { run_id, lease_id, fence, expires_at },
      },
    ],
  };
}

const CREATE_RUN_FIELDS = ["actor_id", "mode", "runtime", "provider", "model"] as const;

/**
 * A human owner queues a run for an agent actor. No lease is taken and no
 * fence moves: the first claim of the returned run gets fence 1. The target
 * actor must be an enabled member of this project; the caller never chooses
 * an id, status, edition, or base rev.
 */
function run_create(runtime: CommandRuntime): CommandResult {
  const scope = require_scope(runtime);
  require_human_owner_actor(runtime);
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, CREATE_RUN_FIELDS);

  const actor_id = require_non_empty_string(payload, "actor_id");
  const mode = payload.mode;
  if (mode !== "A" && mode !== "B") {
    throw new ApiError("invalid_payload", 'mode must be "A" or "B"');
  }
  const runtime_name = require_non_empty_string(payload, "runtime");
  const provider = require_non_empty_string(payload, "provider");
  const model = require_non_empty_string(payload, "model");
  if (mode === "A" && (provider !== "opencode-go" || !model.startsWith("opencode-go/"))) {
    throw new ApiError("invalid_payload", "mode A requires the opencode-go provider and model prefix");
  }

  const target = read_credential_actor(runtime.db, actor_id);
  if (target === undefined) {
    throw new ApiError("not_found", "the run actor is not allowed in this project");
  }
  const member = runtime.db.get<{ ok: bigint }>(
    "SELECT 1 AS ok FROM project_members WHERE project_id = ? AND user_id = ?",
    scope.project_id,
    target.user_id,
  );
  if (member === undefined) {
    throw new ApiError("not_found", "the run actor is not a member of the project");
  }

  const edition = runtime.db.get<{ active_edition_id: string | null }>(
    "SELECT active_edition_id FROM projects WHERE id = ?",
    scope.project_id,
  );
  if (edition === undefined || edition.active_edition_id === null) {
    throw new ApiError("conflict", "the project has no active edition");
  }

  const run_id = runtime.new_id();
  const written = runtime.db.run(
    `INSERT INTO runs
       (id, project_id, edition_id, actor_id, mode, runtime, provider, model, role,
        status, parent_run_id, base_control_rev, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'worker', 'queued', NULL, ?, NULL, NULL)`,
    run_id,
    scope.project_id,
    edition.active_edition_id,
    actor_id,
    mode,
    runtime_name,
    provider,
    model,
    scope.control_rev,
  );
  if (written.changes !== 1n) {
    throw new Error("the queued run was not created");
  }

  const result = {
    project_id: scope.project_id,
    run_id,
    actor_id,
    status: "queued",
  };
  // The receipt belongs to the owner who queued the run, while runs.actor_id is
  // the agent that will claim it. mutation_commits' (project_id, run_id,
  // actor_id) FK requires those to agree, so this receipt records the run only
  // in its result and event; the run row itself carries run_id.
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "run.created",
    base_control_rev: null,
    result,
  });
  return {
    result,
    events: [
      {
        type: "run.created",
        run_id,
        payload: { run_id, actor_id, mode },
      },
    ],
  };
}

function run_heartbeat(runtime: CommandRuntime): CommandResult {
  const { scope, payload } = claim_runtime_scope(runtime);
  const guard = require_guard(payload);
  require_current_lease(runtime, guard);

  const expires_at = runtime.now_ms + runtime.run_config.lease_ttl_ms;
  const written = runtime.db.run(
    "UPDATE project_leases SET heartbeat_at = ?, expires_at = ? WHERE project_id = ? AND lease_id = ? AND fence = ? AND state = 'active' AND expires_at > ?",
    runtime.now_ms,
    expires_at,
    scope.project_id,
    guard.lease_id,
    guard.fence,
    runtime.now_ms,
  );
  if (written.changes !== 1n) {
    throw new ApiError("conflict", "the lease is not current");
  }

  const result = guarded_result(scope, guard, { expires_at });
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "run.heartbeat",
    base_control_rev: null,
    run_id: guard.run_id,
    lease_id: guard.lease_id,
    fence: guard.fence,
    result,
  });
  return {
    result,
    events: [{ type: "run.heartbeat", run_id: guard.run_id, payload: { expires_at } }],
  };
}

function run_wait(runtime: CommandRuntime): CommandResult {
  const { scope, payload } = claim_runtime_scope(runtime);
  const guard = require_guard(payload);
  require_current_lease(runtime, guard);
  const reason = optional_string(payload, "reason");

  write_run_status(runtime, scope.project_id, guard.run_id, "waiting_human", null);
  release_lease(runtime, guard);

  const result = guarded_result(scope, guard, { status: "waiting_human" });
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "run.waiting_human",
    base_control_rev: null,
    run_id: guard.run_id,
    lease_id: guard.lease_id,
    fence: guard.fence,
    result,
  });
  return {
    result,
    events: [
      {
        type: "run.waiting_human",
        run_id: guard.run_id,
        payload: { reason },
      },
    ],
  };
}

function run_complete(runtime: CommandRuntime): CommandResult {
  const { scope, payload } = claim_runtime_scope(runtime);
  const guard = require_guard(payload);
  const status = payload.status === undefined ? "succeeded" : payload.status;
  if (typeof status !== "string" || !COMPLETE_RUN_STATUSES.has(status)) {
    throw new ApiError("invalid_payload", 'status must be "succeeded" or "failed"');
  }
  require_current_lease(runtime, guard);

  write_run_status(runtime, scope.project_id, guard.run_id, status, runtime.now_ms);
  release_lease(runtime, guard);

  const result = guarded_result(scope, guard, { status });
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "run.completed",
    base_control_rev: null,
    run_id: guard.run_id,
    lease_id: guard.lease_id,
    fence: guard.fence,
    result,
  });
  return {
    result,
    events: [{ type: "run.completed", run_id: guard.run_id, payload: { status } }],
  };
}

function finish_run(
  runtime: CommandRuntime,
  action: string,
  status: string,
  end_run: boolean,
  allow_owner = false,
): CommandResult {
  const { scope, payload } = claim_runtime_scope(runtime);
  const guard = require_guard(payload);
  const lease = require_current_lease(runtime, guard, allow_owner);
  const by_owner = lease.owner_actor_id !== scope.actor_id;

  // Optional context recorded on the event only.
  const extra: Record<string, unknown> = {};
  if (allow_owner) {
    const reason = optional_string(payload, "reason");
    if (reason !== null) extra.reason = reason;
    if (action === "run.handed_off") {
      const mode = payload.target_mode;
      if (mode !== undefined && mode !== "A" && mode !== "B") {
        throw new ApiError("invalid_payload", 'target_mode must be "A" or "B"');
      }
      if (mode !== undefined) extra.target_mode = mode;
      const target = optional_string(payload, "target_actor_id");
      if (target !== null) {
        const actor = read_credential_actor(runtime.db, target);
        const member =
          actor === undefined
            ? undefined
            : runtime.db.get<{ ok: bigint }>(
                "SELECT 1 AS ok FROM project_members WHERE project_id = ? AND user_id = ?",
                scope.project_id,
                actor.user_id,
              );
        if (member === undefined) {
          throw new ApiError("not_found", "the target actor is not a member of the project");
        }
        extra.target_actor_id = target;
      }
      if (
        payload.include_pending_inputs !== undefined &&
        typeof payload.include_pending_inputs !== "boolean"
      ) {
        throw new ApiError("invalid_payload", "include_pending_inputs must be a boolean");
      }
      if (payload.include_pending_inputs !== undefined) {
        extra.include_pending_inputs = payload.include_pending_inputs;
      }
    }
  }

  write_run_status(
    runtime,
    scope.project_id,
    guard.run_id,
    status,
    end_run ? runtime.now_ms : null,
  );
  release_lease(runtime, guard);

  const result = guarded_result(scope, guard, { status });
  // mutation_commits (project_id, run_id, actor_id) must match runs.actor_id, so
  // an owner acting on an agent's run records the run in the result and event only.
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action,
    base_control_rev: null,
    run_id: by_owner ? null : guard.run_id,
    lease_id: guard.lease_id,
    fence: guard.fence,
    result,
  });
  return {
    result,
    events: [{ type: action, run_id: guard.run_id, payload: { status, ...extra } }],
  };
}

function run_release(runtime: CommandRuntime): CommandResult {
  return finish_run(runtime, "run.released", "queued", false);
}

function run_handoff(runtime: CommandRuntime): CommandResult {
  return finish_run(runtime, "run.handed_off", "queued", false, true);
}

function run_interrupt(runtime: CommandRuntime): CommandResult {
  return finish_run(runtime, "run.interrupted", "interrupted", true, true);
}

const CANCEL_TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

/**
 * Cancel a run: the human owner may cancel any run, an agent only its own
 * (the run's actor). A queued run needs no lease; an active lease of this run
 * is released. A finished run is a conflict that names its status.
 */
function run_cancel(runtime: CommandRuntime): CommandResult {
  const { scope, payload } = claim_runtime_scope(runtime);
  reject_unknown_fields(payload, ["run_id", "reason"]);
  const run_id = require_non_empty_string(payload, "run_id");
  const reason = optional_string(payload, "reason");
  const run = runtime.db.get<RunRow>(
    "SELECT id, actor_id, status, parent_run_id FROM runs WHERE project_id = ? AND id = ?",
    scope.project_id,
    run_id,
  );
  if (run === undefined) throw new ApiError("not_found", "run not found");
  const owner = is_human_owner_actor(runtime);
  if (!owner && run.actor_id !== scope.actor_id) {
    throw new ApiError("forbidden", "only the owner or the run's own actor may cancel it");
  }
  if (CANCEL_TERMINAL_STATUSES.has(run.status)) {
    throw new ApiError("conflict", "the run is already finished", {
      reason: "run_terminal",
      run_id,
      status: run.status,
    });
  }
  write_run_status(runtime, scope.project_id, run_id, "cancelled", runtime.now_ms);
  const lease = read_lease(runtime, scope.project_id);
  let lease_id: string | null = null;
  let fence: number | null = null;
  if (lease !== undefined && lease.run_id === run_id && lease.state === "active") {
    runtime.db.run(
      "UPDATE project_leases SET state = 'released' WHERE project_id = ? AND lease_id = ? AND state = 'active'",
      scope.project_id,
      lease.lease_id,
    );
    lease_id = lease.lease_id;
    fence = Number(lease.fence);
  }
  const result = { project_id: scope.project_id, run_id, status: "cancelled" };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "run.cancelled",
    base_control_rev: null,
    run_id: run.actor_id === scope.actor_id ? run_id : null,
    lease_id,
    fence,
    result,
  });
  return {
    result,
    events: [
      {
        type: "run.cancelled",
        run_id,
        payload: { status: "cancelled", ...(reason === null ? {} : { reason }) },
      },
    ],
  };
}

interface ReceiptOutcome {
  result: Record<string, unknown>;
  event: EventDraft;
}

/** One input receipt inside the caller's transaction (no mutation receipt written here). */
function record_one(
  runtime: CommandRuntime,
  scope: Scope,
  guard: LeaseGuard,
  item: Record<string, unknown>,
): ReceiptOutcome {
  const input_version_id = require_non_empty_string(item, "input_version_id");
  const state = item.state;
  if (typeof state !== "string" || !INPUT_RECEIPT_STATES.has(state)) {
    throw new ApiError("invalid_payload", 'state must be "seen", "applied" or "ignored"');
  }
  const reason = optional_string(item, "reason");
  let applied_tx_id: string | null = null;
  if (state === "applied") {
    applied_tx_id = require_non_empty_string(item, "applied_tx_id");
    const evidence = runtime.db.get<{ ok: bigint }>(
      "SELECT 1 AS ok FROM mutation_commits WHERE project_id = ? AND id = ?",
      scope.project_id,
      applied_tx_id,
    );
    if (evidence === undefined) {
      throw new ApiError("invalid_payload", "applied_tx_id must be a mutation receipt of this project");
    }
  }
  require_input_version(runtime, scope.project_id, input_version_id);
  require_current_lease(runtime, guard);

  const already = applied_receipt(runtime, scope.project_id, guard.run_id, input_version_id);
  if (already !== undefined) {
    return {
      result: {
        project_id: scope.project_id,
        run_id: guard.run_id,
        input_version_id,
        state: "applied",
        applied_tx_id: already.applied_tx_id,
        already_applied: true,
      },
      event: {
        type: "run.input_receipt_recorded",
        run_id: guard.run_id,
        payload: { input_version_id, state: "applied", already_applied: true },
      },
    };
  }

  const existing = runtime.db.get<{ state: string }>(
    "SELECT state FROM run_input_receipts WHERE project_id = ? AND run_id = ? AND input_version_id = ?",
    scope.project_id,
    guard.run_id,
    input_version_id,
  );
  if (existing === undefined) {
    runtime.db.run(
      `INSERT INTO run_input_receipts
         (project_id, run_id, input_version_id, state, reason, applied_tx_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      scope.project_id,
      guard.run_id,
      input_version_id,
      state,
      reason,
      applied_tx_id,
    );
  } else {
    runtime.db.run(
      `UPDATE run_input_receipts
       SET state = ?, reason = ?, applied_tx_id = ?
       WHERE project_id = ? AND run_id = ? AND input_version_id = ?`,
      state,
      reason,
      applied_tx_id,
      scope.project_id,
      guard.run_id,
      input_version_id,
    );
  }
  return {
    result: {
      project_id: scope.project_id,
      run_id: guard.run_id,
      input_version_id,
      state,
      applied_tx_id,
      already_applied: false,
    },
    event: {
      type: "run.input_receipt_recorded",
      run_id: guard.run_id,
      payload: { input_version_id, state, already_applied: false },
    },
  };
}

/**
 * One receipt (fields at the top level) or a bundle (`receipts`, 1..20): all or
 * nothing in one transaction with one mutation receipt.
 */
function run_record_receipt(runtime: CommandRuntime): CommandResult {
  const { scope, payload } = claim_runtime_scope(runtime);
  const guard = require_guard(payload);

  if (payload.receipts !== undefined) {
    reject_unknown_fields(payload, ["run_id", "lease_id", "fence", "receipts"]);
    const list = payload.receipts;
    if (!Array.isArray(list) || list.length < 1 || list.length > 20) {
      throw new ApiError("invalid_payload", "receipts must be an array of 1 to 20 items");
    }
    const items = list.map((entry) => require_record(entry));
    require_current_lease(runtime, guard);
    const outcomes = items.map((item) => record_one(runtime, scope, guard, item));
    const result = {
      project_id: scope.project_id,
      run_id: guard.run_id,
      accepted: outcomes.map((o) => ({
        input_version_id: o.result.input_version_id,
        state: o.result.state,
        already_applied: o.result.already_applied,
      })),
    };
    insert_receipt(runtime, {
      project_id: scope.project_id,
      actor_id: scope.actor_id,
      action: "run.input_receipt_recorded",
      base_control_rev: null,
      run_id: guard.run_id,
      lease_id: guard.lease_id,
      fence: guard.fence,
      result,
    });
    return { result, events: outcomes.map((o) => o.event) };
  }

  // Single form.
  const outcome = record_one(runtime, scope, guard, payload);
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "run.input_receipt_recorded",
    base_control_rev: null,
    run_id: guard.run_id,
    lease_id: guard.lease_id,
    fence: guard.fence,
    result: outcome.result,
  });
  return { result: outcome.result, events: [outcome.event] };
}

function definition(action: string, run: (runtime: CommandRuntime) => CommandResult): CommandDefinition {
  return Object.freeze({ action, scope: "project", rev_bearing: false, run });
}

const RUN_COMMAND_INPUTS: ReadonlyArray<readonly [string, CommandDefinition]> = [
  ["run.create", definition("run.created", run_create)],
  ["run.claim", definition("run.claimed", run_claim)],
  ["run.heartbeat", definition("run.heartbeat", run_heartbeat)],
  ["run.wait", definition("run.waiting_human", run_wait)],
  ["run.complete", definition("run.completed", run_complete)],
  ["run.release", definition("run.released", run_release)],
  ["run.handoff", definition("run.handed_off", run_handoff)],
  ["run.interrupt", definition("run.interrupted", run_interrupt)],
  ["run.record_receipt", definition("run.input_receipt_recorded", run_record_receipt)],
  ["run.cancel", definition("run.cancelled", run_cancel)],
];

/**
 * Registry entries merged into COMMANDS by commands.ts (names, not actions).
 * The array and each name/definition tuple are frozen, so importing this module
 * before commands.ts cannot inject or replace a command.
 */
export const RUN_COMMAND_ENTRIES: ReadonlyArray<readonly [string, CommandDefinition]> = Object.freeze(
  RUN_COMMAND_INPUTS.map((entry) => Object.freeze([entry[0], entry[1]] as const)),
);

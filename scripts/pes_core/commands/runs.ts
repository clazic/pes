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

import {
  insert_receipt,
  require_non_empty_string,
  require_record,
  type CommandDefinition,
  type CommandResult,
  type CommandRuntime,
} from "../commands.ts";
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
function require_current_lease(runtime: CommandRuntime, guard: LeaseGuard): LeaseRow {
  const scope = require_scope(runtime);
  const lease = read_lease(runtime, scope.project_id);
  if (
    lease === undefined ||
    !is_live_lease(lease, runtime.now_ms) ||
    lease.lease_id !== guard.lease_id ||
    Number(lease.fence) !== guard.fence ||
    lease.run_id !== guard.run_id ||
    lease.owner_actor_id !== scope.actor_id
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

/** Input receipts already applied by this run or by an ancestor run in the hand-off chain. */
function applied_receipt(
  runtime: CommandRuntime,
  project_id: string,
  run_id: string,
  input_version_id: string,
): { applied_tx_id: string | null } | undefined {
  const seen = new Set<string>();
  let current: string | null = run_id;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const applied = runtime.db.get<{ applied_tx_id: string | null }>(
      `SELECT applied_tx_id FROM run_input_receipts
       WHERE project_id = ? AND run_id = ? AND input_version_id = ? AND state = 'applied'`,
      project_id,
      current,
      input_version_id,
    );
    if (applied !== undefined) return applied;
    const parent: { parent_run_id: string | null } | undefined = runtime.db.get<{
      parent_run_id: string | null;
    }>("SELECT parent_run_id FROM runs WHERE project_id = ? AND id = ?", project_id, current);
    current = parent?.parent_run_id ?? null;
  }
  return undefined;
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
  const requested_run_id = payload.run_id;
  let existing: RunRow | null = null;
  let run_id: string;
  let fresh: { mode: string; runtime: string; provider: string; model: string } | null = null;

  if (requested_run_id !== undefined) {
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

  const fence = previous === undefined ? 1 : Number(previous.fence) + 1;
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
      "UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ?), ended_at = NULL WHERE project_id = ? AND id = ?",
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
      {
        type: "run.claimed",
        run_id,
        payload: { run_id, lease_id, fence, expires_at },
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
): CommandResult {
  const { scope, payload } = claim_runtime_scope(runtime);
  const guard = require_guard(payload);
  require_current_lease(runtime, guard);

  write_run_status(
    runtime,
    scope.project_id,
    guard.run_id,
    status,
    end_run ? runtime.now_ms : null,
  );
  release_lease(runtime, guard);

  const result = guarded_result(scope, guard, { status });
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action,
    base_control_rev: null,
    run_id: guard.run_id,
    lease_id: guard.lease_id,
    fence: guard.fence,
    result,
  });
  return {
    result,
    events: [{ type: action, run_id: guard.run_id, payload: { status } }],
  };
}

function run_release(runtime: CommandRuntime): CommandResult {
  return finish_run(runtime, "run.released", "queued", false);
}

function run_handoff(runtime: CommandRuntime): CommandResult {
  return finish_run(runtime, "run.handed_off", "queued", false);
}

function run_interrupt(runtime: CommandRuntime): CommandResult {
  return finish_run(runtime, "run.interrupted", "interrupted", true);
}

function run_record_receipt(runtime: CommandRuntime): CommandResult {
  const { scope, payload } = claim_runtime_scope(runtime);
  const guard = require_guard(payload);
  const input_version_id = require_non_empty_string(payload, "input_version_id");
  const state = payload.state;
  if (typeof state !== "string" || !INPUT_RECEIPT_STATES.has(state)) {
    throw new ApiError("invalid_payload", 'state must be "seen", "applied" or "ignored"');
  }
  const reason = optional_string(payload, "reason");
  let applied_tx_id: string | null = null;
  if (state === "applied") {
    applied_tx_id = require_non_empty_string(payload, "applied_tx_id");
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
    const result = {
      project_id: scope.project_id,
      run_id: guard.run_id,
      input_version_id,
      state: "applied",
      applied_tx_id: already.applied_tx_id,
      already_applied: true,
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
    return {
      result,
      events: [
        {
          type: "run.input_receipt_recorded",
          run_id: guard.run_id,
          payload: { input_version_id, state: "applied", already_applied: true },
        },
      ],
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

  const result = {
    project_id: scope.project_id,
    run_id: guard.run_id,
    input_version_id,
    state,
    applied_tx_id,
    already_applied: false,
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
  return {
    result,
    events: [
      {
        type: "run.input_receipt_recorded",
        run_id: guard.run_id,
        payload: { input_version_id, state, already_applied: false },
      },
    ],
  };
}

function definition(action: string, run: (runtime: CommandRuntime) => CommandResult): CommandDefinition {
  return Object.freeze({ action, scope: "project", rev_bearing: false, run });
}

/** Registry entries merged into COMMANDS by commands.ts (names, not actions). */
export const RUN_COMMAND_ENTRIES: ReadonlyArray<readonly [string, CommandDefinition]> = [
  ["run.claim", definition("run.claimed", run_claim)],
  ["run.heartbeat", definition("run.heartbeat", run_heartbeat)],
  ["run.wait", definition("run.waiting_human", run_wait)],
  ["run.complete", definition("run.completed", run_complete)],
  ["run.release", definition("run.released", run_release)],
  ["run.handoff", definition("run.handed_off", run_handoff)],
  ["run.interrupt", definition("run.interrupted", run_interrupt)],
  ["run.record_receipt", definition("run.input_receipt_recorded", run_record_receipt)],
];

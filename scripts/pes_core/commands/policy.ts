// Policy and outbound dispatch command definitions (stage 2 PR10).
//
// These definitions hold the only business-table SQL for policy changes and
// OpenCode Go dispatches. The public functions in scripts/pes_core/policy.ts
// are thin wrappers that call CommandService.execute once, so every write
// still passes the registry, project/actor check, policy, receipt replay, the
// lease guard, change, and events + receipt in one transaction.
//
// Only a human project owner changes the policy. Turning Go OFF blocks every
// prepared or authorized (not yet sent) dispatch in the same transaction and
// writes one dispatch.blocked event each after policy.changed. Sent, response,
// adopted, failed, unknown and already blocked history is never edited.
// Dispatch state changes are guarded by the same live lease as the run
// commands; dispatch.block alone needs no lease. No network call is made:
// mark_sent only records that sending started, and usage/cost stay NULL
// because they are unknown at that point.

import { ApiError } from "../errors.ts";
import { current_policy } from "../policy.ts";
import {
  insert_receipt,
  reject_unknown_fields,
  require_human_owner_actor,
  require_non_empty_string,
  require_record,
  type CommandDefinition,
  type CommandResult,
  type CommandRuntime,
  type EventDraft,
} from "./shared.ts";

const GO_PROVIDER = "opencode-go";
const PAYLOAD_HASH = /^[0-9a-f]{64}$/i;

const POLICY_SET_FIELDS = [
  "reason",
  "allow_opencode_go",
  "go_usage_stop_percent",
  "mode_a_model",
] as const;
const DISPATCH_PREPARE_FIELDS = [
  "run_id",
  "lease_id",
  "fence",
  "provider",
  "manifest_blob_id",
  "payload_hash",
  "request_key",
] as const;
const DISPATCH_AUTHORIZE_FIELDS = ["dispatch_id", "run_id", "lease_id", "fence"] as const;
const DISPATCH_MARK_SENT_FIELDS = [
  "dispatch_id",
  "run_id",
  "lease_id",
  "fence",
  "external_request_id",
] as const;
const DISPATCH_BLOCK_FIELDS = ["dispatch_id", "reason"] as const;

interface Scope {
  project_id: string;
  actor_id: string;
}

interface LeaseGuard {
  run_id: string;
  lease_id: string;
  fence: number;
}

interface LeaseRow {
  lease_id: string;
  run_id: string | null;
  owner_actor_id: string | null;
  fence: bigint;
  state: string;
  expires_at: bigint;
}

interface DispatchRow {
  id: string;
  run_id: string;
  state: string;
}

const BLOCKABLE_STATES = new Set(["prepared", "authorized"]);

function invalid_payload(message: string): never {
  throw new ApiError("invalid_payload", message);
}

function require_scope(runtime: CommandRuntime): Scope {
  const project = runtime.project;
  const actor_id = runtime.actor_id;
  if (project === null || actor_id === null) {
    throw new Error("a policy command must resolve a project and actor first");
  }
  return { project_id: project.id, actor_id };
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

/** The project's active, unexpired lease with the exact id, fence, run, and owner. */
function require_current_lease(runtime: CommandRuntime, scope: Scope, guard: LeaseGuard): void {
  const lease = runtime.db.get<LeaseRow>(
    `SELECT lease_id, run_id, owner_actor_id, fence, state, expires_at
       FROM project_leases WHERE project_id = ?`,
    scope.project_id,
  );
  if (
    lease === undefined ||
    lease.state !== "active" ||
    runtime.now_ms >= Number(lease.expires_at) ||
    lease.lease_id !== guard.lease_id ||
    Number(lease.fence) !== guard.fence ||
    lease.run_id !== guard.run_id ||
    lease.owner_actor_id !== scope.actor_id
  ) {
    throw new ApiError("conflict", "the lease is not current");
  }
}

function read_dispatch(runtime: CommandRuntime, project_id: string, dispatch_id: string): DispatchRow | undefined {
  return runtime.db.get<DispatchRow>(
    "SELECT id, run_id, state FROM outbound_dispatches WHERE project_id = ? AND id = ?",
    project_id,
    dispatch_id,
  );
}

function optional_external_request_id(payload: Record<string, unknown>): string | null {
  const value = payload.external_request_id;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || !value.isWellFormed()) {
    return invalid_payload("external_request_id must be a non-empty string");
  }
  return value;
}

// ---------------------------------------------------------------------------
// policy.set

function run_policy_set(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, POLICY_SET_FIELDS);
  const reason = require_non_empty_string(payload, "reason");

  const has_allow = payload.allow_opencode_go !== undefined;
  const has_percent = payload.go_usage_stop_percent !== undefined;
  const has_model = payload.mode_a_model !== undefined;
  if (!has_allow && !has_percent && !has_model) {
    return invalid_payload("at least one policy field is required");
  }
  if (has_allow && typeof payload.allow_opencode_go !== "boolean") {
    return invalid_payload("allow_opencode_go must be a boolean");
  }
  let requested_percent = 0;
  if (has_percent) {
    const value = payload.go_usage_stop_percent;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 50 || value > 100) {
      return invalid_payload("go_usage_stop_percent must be an integer between 50 and 100");
    }
    requested_percent = value;
  }
  let requested_model = "";
  if (has_model) {
    requested_model = require_non_empty_string(payload, "mode_a_model");
    if (!requested_model.startsWith("opencode-go/")) {
      return invalid_payload('mode_a_model must start with "opencode-go/"');
    }
  }

  const scope = require_scope(runtime);
  require_human_owner_actor(runtime);
  const current = current_policy(runtime.db, scope.project_id);
  const owner = runtime.db.get<{ owner_user_id: string }>(
    "SELECT owner_user_id FROM projects WHERE id = ?",
    scope.project_id,
  );
  if (owner === undefined) {
    throw new Error("the project owner was not found");
  }

  const allow = has_allow ? (payload.allow_opencode_go as boolean) : current.allow_opencode_go;
  const percent = has_percent ? requested_percent : current.go_usage_stop_percent;
  const model = has_model ? requested_model : current.mode_a_model;
  const policy_id = runtime.new_id();
  const policy_rev = current.policy_rev + 1;

  // Collect first so the result can name the blocked dispatches; the updates
  // happen below in the same transaction, after policy.changed.
  const to_block: Array<{ id: string; run_id: string }> = allow
    ? []
    : runtime.db.all<{ id: string; run_id: string }>(
        `SELECT id, run_id FROM outbound_dispatches
          WHERE project_id = ? AND state IN ('prepared', 'authorized')
          ORDER BY rowid`,
        scope.project_id,
      );

  const result = {
    project_id: scope.project_id,
    policy_id,
    policy_rev,
    allow_opencode_go: allow,
    blocked_dispatch_ids: to_block.map((dispatch) => dispatch.id),
  };
  // The receipt id is the transaction id; project_policy_versions references it.
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "policy.changed",
    base_control_rev: null,
    result,
  });

  runtime.db.run(
    `INSERT INTO project_policy_versions
       (id, project_id, policy_rev, allow_opencode_go, mode_a_model,
        go_usage_stop_percent, changed_by, changed_by_user_id, changed_by_kind,
        reason, tx_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'human', ?, ?, ?)`,
    policy_id,
    scope.project_id,
    policy_rev,
    allow ? 1 : 0,
    model,
    percent,
    scope.actor_id,
    owner.owner_user_id,
    reason,
    runtime.tx_id,
    runtime.now_ms,
  );
  const moved = runtime.db.run(
    "UPDATE projects SET current_policy_id = ? WHERE id = ?",
    policy_id,
    scope.project_id,
  );
  if (moved.changes !== 1n) {
    throw new Error("the project policy pointer was not moved");
  }

  const events: EventDraft[] = [
    {
      type: "policy.changed",
      payload: {
        policy_id,
        policy_rev,
        allow_opencode_go: allow,
        mode_a_model: model,
        go_usage_stop_percent: percent,
        reason,
      },
    },
  ];
  for (const dispatch of to_block) {
    const written = runtime.db.run(
      `UPDATE outbound_dispatches SET state = 'blocked'
        WHERE project_id = ? AND id = ? AND state IN ('prepared', 'authorized')`,
      scope.project_id,
      dispatch.id,
    );
    if (written.changes !== 1n) {
      throw new Error("a dispatch was not blocked");
    }
    events.push({
      type: "dispatch.blocked",
      run_id: dispatch.run_id,
      payload: { dispatch_id: dispatch.id, reason: "policy_off" },
    });
  }

  return { result, events };
}

// ---------------------------------------------------------------------------
// dispatch.prepare / authorize / mark_sent / block

function run_dispatch_prepare(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, DISPATCH_PREPARE_FIELDS);
  const guard = require_guard(payload);
  const provider = require_non_empty_string(payload, "provider");
  if (provider !== GO_PROVIDER) {
    return invalid_payload('provider must be "opencode-go"');
  }
  const manifest_blob_id = require_non_empty_string(payload, "manifest_blob_id");
  const payload_hash = payload.payload_hash;
  if (typeof payload_hash !== "string" || !PAYLOAD_HASH.test(payload_hash)) {
    return invalid_payload("payload_hash must be 64 hexadecimal characters");
  }
  const request_key = require_non_empty_string(payload, "request_key");

  const scope = require_scope(runtime);
  require_current_lease(runtime, scope, guard);
  const policy = current_policy(runtime.db, scope.project_id);

  const blob = runtime.db.get<{ ok: bigint }>(
    "SELECT 1 AS ok FROM blobs WHERE project_id = ? AND id = ?",
    scope.project_id,
    manifest_blob_id,
  );
  if (blob === undefined) {
    return invalid_payload("manifest_blob_id is not a blob of this project");
  }
  const reused = runtime.db.get<{ id: string }>(
    "SELECT id FROM outbound_dispatches WHERE project_id = ? AND run_id = ? AND request_key = ?",
    scope.project_id,
    guard.run_id,
    request_key,
  );
  if (reused !== undefined) {
    throw new ApiError("conflict", "request_key was already used for this run");
  }

  const dispatch_id = runtime.new_id();
  runtime.db.run(
    `INSERT INTO outbound_dispatches
       (id, project_id, run_id, provider, policy_version_id, manifest_blob_id,
        payload_hash, state, request_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?)`,
    dispatch_id,
    scope.project_id,
    guard.run_id,
    GO_PROVIDER,
    policy.policy_id,
    manifest_blob_id,
    payload_hash,
    request_key,
  );

  const result = {
    project_id: scope.project_id,
    dispatch_id,
    run_id: guard.run_id,
    state: "prepared",
    policy_version_id: policy.policy_id,
  };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "dispatch.prepared",
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
        type: "dispatch.prepared",
        run_id: guard.run_id,
        payload: {
          dispatch_id,
          provider: GO_PROVIDER,
          policy_version_id: policy.policy_id,
        },
      },
    ],
  };
}

function run_dispatch_authorize(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, DISPATCH_AUTHORIZE_FIELDS);
  const dispatch_id = require_non_empty_string(payload, "dispatch_id");
  const guard = require_guard(payload);

  const scope = require_scope(runtime);
  require_current_lease(runtime, scope, guard);
  const dispatch = read_dispatch(runtime, scope.project_id, dispatch_id);
  if (dispatch === undefined) {
    throw new ApiError("not_found", "dispatch not found");
  }
  if (dispatch.run_id !== guard.run_id || dispatch.state !== "prepared") {
    throw new ApiError("conflict", "the dispatch cannot be authorized in its current state");
  }

  const written = runtime.db.run(
    `UPDATE outbound_dispatches SET state = 'authorized', authorized_at = ?
      WHERE project_id = ? AND id = ? AND state = 'prepared'`,
    runtime.now_ms,
    scope.project_id,
    dispatch_id,
  );
  if (written.changes !== 1n) {
    throw new ApiError("conflict", "the dispatch cannot be authorized in its current state");
  }

  const result = {
    project_id: scope.project_id,
    dispatch_id,
    run_id: guard.run_id,
    state: "authorized",
    authorized_at: runtime.now_ms,
  };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "dispatch.authorized",
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
        type: "dispatch.authorized",
        run_id: guard.run_id,
        payload: { dispatch_id, authorized_at: runtime.now_ms },
      },
    ],
  };
}

function run_dispatch_mark_sent(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, DISPATCH_MARK_SENT_FIELDS);
  const dispatch_id = require_non_empty_string(payload, "dispatch_id");
  const guard = require_guard(payload);
  const external_request_id = optional_external_request_id(payload);

  const scope = require_scope(runtime);
  require_current_lease(runtime, scope, guard);
  const dispatch = read_dispatch(runtime, scope.project_id, dispatch_id);
  if (dispatch === undefined) {
    throw new ApiError("not_found", "dispatch not found");
  }
  if (dispatch.run_id !== guard.run_id || dispatch.state !== "authorized") {
    throw new ApiError("conflict", "the dispatch cannot be sent in its current state");
  }

  // usage_json and cost_json stay NULL: sending has started but the response
  // and its cost are unknown, and an unknown cost is never stored as zero.
  const written = runtime.db.run(
    `UPDATE outbound_dispatches
        SET state = 'sent', sent_at = ?, external_request_id = ?
      WHERE project_id = ? AND id = ? AND state = 'authorized'`,
    runtime.now_ms,
    external_request_id,
    scope.project_id,
    dispatch_id,
  );
  if (written.changes !== 1n) {
    throw new ApiError("conflict", "the dispatch cannot be sent in its current state");
  }

  const result = {
    project_id: scope.project_id,
    dispatch_id,
    run_id: guard.run_id,
    state: "sent",
    sent_at: runtime.now_ms,
    external_request_id,
  };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "dispatch.sent",
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
        type: "dispatch.sent",
        run_id: guard.run_id,
        payload: { dispatch_id, external_request_id },
      },
    ],
  };
}

function run_dispatch_block(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, DISPATCH_BLOCK_FIELDS);
  const dispatch_id = require_non_empty_string(payload, "dispatch_id");
  const reason = require_non_empty_string(payload, "reason");

  const scope = require_scope(runtime);
  const dispatch = read_dispatch(runtime, scope.project_id, dispatch_id);
  if (dispatch === undefined) {
    throw new ApiError("not_found", "dispatch not found");
  }
  if (!BLOCKABLE_STATES.has(dispatch.state)) {
    throw new ApiError("conflict", "the dispatch cannot be blocked in its current state");
  }

  const written = runtime.db.run(
    `UPDATE outbound_dispatches SET state = 'blocked'
      WHERE project_id = ? AND id = ? AND state IN ('prepared', 'authorized')`,
    scope.project_id,
    dispatch_id,
  );
  if (written.changes !== 1n) {
    throw new ApiError("conflict", "the dispatch cannot be blocked in its current state");
  }

  const result = { project_id: scope.project_id, dispatch_id, state: "blocked" };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "dispatch.blocked",
    base_control_rev: null,
    result,
  });
  return {
    result,
    events: [
      {
        type: "dispatch.blocked",
        run_id: dispatch.run_id,
        payload: { dispatch_id, reason },
      },
    ],
  };
}

function definition(
  action: string,
  run: (runtime: CommandRuntime) => CommandResult,
): CommandDefinition {
  return Object.freeze({ action, scope: "project", rev_bearing: false, run });
}

const POLICY_COMMAND_INPUTS: ReadonlyArray<readonly [string, CommandDefinition]> = [
  ["policy.set", definition("policy.changed", run_policy_set)],
  ["dispatch.prepare", definition("dispatch.prepared", run_dispatch_prepare)],
  ["dispatch.authorize", definition("dispatch.authorized", run_dispatch_authorize)],
  ["dispatch.mark_sent", definition("dispatch.sent", run_dispatch_mark_sent)],
  ["dispatch.block", definition("dispatch.blocked", run_dispatch_block)],
];

/** Registry entries merged into COMMANDS by commands.ts (names, not actions). */
export const POLICY_COMMAND_ENTRIES: ReadonlyArray<readonly [string, CommandDefinition]> = Object.freeze(
  POLICY_COMMAND_INPUTS.map((entry) => Object.freeze([entry[0], entry[1]] as const)),
);

// Project policy and OpenCode Go dispatch policy (stage 2 PR10).
//
// The write path lives in commands/policy.ts: set_policy, prepare_dispatch,
// authorize_dispatch, mark_sent, and block_dispatch are thin wrappers that call
// CommandService.execute once. The functions here are read-only. DbPolicyChecker
// is installed into CommandService and reads the current policy row from the
// read-only database handle of the same transaction, before receipt replay.
//
// A damaged or missing policy row fails closed: check_go_allowed never throws
// and never allows, current_policy reports policy_denied. There is no real
// network call here; sending is recorded by dispatch.mark_sent only.

import type { CommandOutcome, CommandService, MutationContext, PolicyDecision, PolicyChecker } from "./commands.ts";
import type { Db } from "./db.ts";
import { ApiError } from "./errors.ts";

type ReadDb = Pick<Db, "get" | "all">;

export interface PolicySnapshot {
  policy_id: string;
  project_id: string;
  policy_rev: number;
  allow_opencode_go: boolean;
  mode_a_model: string;
  go_usage_stop_percent: number;
}

interface PolicyRow {
  id: string;
  project_id: string;
  policy_rev: unknown;
  allow_opencode_go: unknown;
  mode_a_model: unknown;
  go_usage_stop_percent: unknown;
  changed_by_kind: unknown;
}

/** Commands that actually send to OpenCode Go; everything else is not gated. */
const GO_GATED_COMMANDS: ReadonlySet<string> = new Set([
  "dispatch.prepare",
  "dispatch.authorize",
  "dispatch.mark_sent",
]);

function damaged_policy(): never {
  throw new ApiError("policy_denied", "the project policy is missing or damaged");
}

/**
 * The project's current policy row. Unknown project -> not_found. Any damage
 * (NULL pointer, missing/other-project row, rewound pointer, out-of-range or
 * non-integer values, a non-human author) -> policy_denied, fail closed.
 */
export function current_policy(db: ReadDb, project_id: string): PolicySnapshot {
  const project = db.get<{ current_policy_id: string | null }>(
    "SELECT current_policy_id FROM projects WHERE id = ?",
    project_id,
  );
  if (project === undefined) {
    throw new ApiError("not_found", "project not found");
  }
  const pointer = project.current_policy_id;
  if (pointer === null) return damaged_policy();

  const row = db.get<PolicyRow>(
    `SELECT id, project_id, policy_rev, allow_opencode_go, mode_a_model,
            go_usage_stop_percent, changed_by_kind
       FROM project_policy_versions WHERE project_id = ? AND id = ?`,
    project_id,
    pointer,
  );
  if (row === undefined || row.project_id !== project_id) return damaged_policy();

  const newest = db.get<{ max_rev: unknown }>(
    "SELECT max(policy_rev) AS max_rev FROM project_policy_versions WHERE project_id = ?",
    project_id,
  );
  if (newest === undefined || typeof newest.max_rev !== "bigint") return damaged_policy();

  const rev = row.policy_rev;
  if (typeof rev !== "bigint" || rev < 1n || rev > BigInt(Number.MAX_SAFE_INTEGER)) {
    return damaged_policy();
  }
  // The pointer must name the highest revision of this project, so a pointer
  // rewound to an older (allowing) row is damage, not an old policy.
  if (rev !== newest.max_rev) return damaged_policy();

  const allow = row.allow_opencode_go;
  if (allow !== 0n && allow !== 1n) return damaged_policy();

  const model = row.mode_a_model;
  if (typeof model !== "string" || !model.startsWith("opencode-go/")) {
    return damaged_policy();
  }

  const percent = row.go_usage_stop_percent;
  if (
    typeof percent !== "bigint" ||
    percent < 50n ||
    percent > 100n ||
    percent > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return damaged_policy();
  }

  if (row.changed_by_kind !== "human") return damaged_policy();

  return {
    policy_id: row.id,
    project_id: row.project_id,
    policy_rev: Number(rev),
    allow_opencode_go: allow === 1n,
    mode_a_model: model,
    go_usage_stop_percent: Number(percent),
  };
}

/**
 * The Go gate used by the command service. It never throws for a damaged
 * policy: it returns allowed:false with a reason instead.
 */
export function check_go_allowed(db: ReadDb, project_id: string): PolicyDecision {
  let policy: PolicySnapshot;
  try {
    policy = current_policy(db, project_id);
  } catch {
    return { allowed: false, reason: "the project policy is missing or damaged" };
  }
  if (!policy.allow_opencode_go) {
    return { allowed: false, reason: "OpenCode Go is turned off for this project" };
  }
  return { allowed: true };
}

/**
 * The real PolicyChecker. It reads the policy from the read-only handle of the
 * command's own transaction (4th argument), so the check cannot race a policy
 * change and cannot be bypassed with a stale connection.
 */
export class DbPolicyChecker implements PolicyChecker {
  check(
    ctx: MutationContext,
    command: string,
    _payload: unknown,
    db: Pick<Db, "get" | "all">,
  ): PolicyDecision {
    if (!GO_GATED_COMMANDS.has(command)) {
      return { allowed: true };
    }
    if (ctx.project_id === null) {
      return { allowed: false, reason: "a project is required for a Go dispatch" };
    }
    return check_go_allowed(db, ctx.project_id);
  }
}

export function set_policy(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "policy.set", input);
}

export function prepare_dispatch(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "dispatch.prepare", input);
}

export function authorize_dispatch(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "dispatch.authorize", input);
}

export function mark_sent(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "dispatch.mark_sent", input);
}

export function block_dispatch(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "dispatch.block", input);
}

// Public edition, stage, and round command functions (stage 2 PR6).
//
// Each command function is a thin wrapper: exactly one CommandService.execute
// call, no SQL and no direct database access. The registry entry and the
// transaction (policy, receipt replay, lease guard, change, events + receipt)
// live in commands.ts and commands/editions.ts.
//
// open_tasks_for_round is the one read-only query: the current versions of
// follow-ups aimed at a round's stage, used when the next round starts.

import type { CommandOutcome, CommandService, MutationContext } from "./commands.ts";
import type { Db } from "./db.ts";

export interface OpenTask {
  followup_id: string;
  version_id: string;
  state: string;
  description: string;
  based_on_version_id: string | null;
}

export function create_edition(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "edition.create", input);
}

export function start_round(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "round.start", input);
}

export function seal_round(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "round.seal", input);
}

export function approve_stage(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "stage.approve", input);
}

export function reopen_stage(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "stage.reopen", input);
}

export function release_completion(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "edition.release_completion", input);
}

export function carry_over(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "edition.carry_over", input);
}

export function snapshot(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "edition.snapshot", input);
}

/**
 * The current versions of "next round task" follow-ups aimed at the round's
 * stage that have not been applied, rejected, or cancelled. A follow-up with
 * no target round yet is visible in that stage's first round.
 */
export function open_tasks_for_round(
  db: Db,
  project_id: string,
  round_id: string,
): OpenTask[] {
  return db
    .all<OpenTask>(
      `SELECT o.id AS followup_id,
              o.current_version_id AS version_id,
              fv.state AS state,
              fv.description AS description,
              ov.based_on_version_id AS based_on_version_id
         FROM rounds r
         JOIN objects o
           ON o.project_id = r.project_id AND o.kind = 'followup'
         JOIN followups f
           ON f.project_id = o.project_id AND f.object_id = o.id
         JOIN followup_versions fv
           ON fv.project_id = o.project_id AND fv.version_id = o.current_version_id
         JOIN object_versions ov
           ON ov.project_id = o.project_id AND ov.id = o.current_version_id
        WHERE r.project_id = ? AND r.id = ?
          AND fv.kind = 'next_round_task'
          AND fv.target_stage_id = r.stage_id
          AND fv.state IN ('proposed', 'accepted', 'running', 'deferred')
          AND (fv.target_round_id IS NULL OR fv.target_round_id = r.id)
        ORDER BY o.id`,
      project_id,
      round_id,
    )
    .map((row) => ({ ...row }));
}

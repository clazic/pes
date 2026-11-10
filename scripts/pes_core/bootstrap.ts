// Project bootstrap entry point.
//
// All row writes live in commands.ts (the PR4 command service). This module
// keeps the PR1 `bootstrap_project(db, input, deps)` signature for callers and
// re-exports the stage/object constants that helpers and tests import.
//
// Bootstrap has no project policy yet, so it passes an allow-only checker; the
// command still goes through the service's registry, replay, transaction, and
// receipt/event path. It calls the synchronous core (execute_sync) because this
// function must keep its non-Promise signature.

import type { Clock } from "./clock.ts";
import {
  CommandService,
  OBJECT_KINDS,
  type CommandOutcome,
  type MutationContext,
  STAGE_KEYS,
  type PolicyChecker,
  type StageKey,
} from "./commands.ts";
import type { Db } from "./db.ts";
import { new_id } from "./ids.ts";

export { OBJECT_KINDS, STAGE_KEYS };
export type { StageKey };

export interface BootstrapInput {
  slug: string;
  topic: string;
  owner_display_name: string;
}

export interface BootstrapDeps {
  clock: Clock;
  new_id: () => string;
}

export interface BootstrapResult {
  project_id: string;
  owner_user_id: string;
  owner_actor_id: string;
  edition_id: string;
  policy_id: string;
  tx_id: string;
  stage_ids: Record<StageKey, string>;
  counter_namespaces: string[];
}

const BOOTSTRAP_POLICY: PolicyChecker = {
  check: () => ({ allowed: true }),
};

/**
 * Create a synthetic or real project with the confirmed initial policy
 * (OpenCode Go transfer allowed by default, stage-0 section 7-1).
 *
 * The command runs synchronously through CommandService with via='cli' and a
 * freshly generated client_request_id, so the project, receipt, and event share
 * one transaction. deps.new_id is passed through so callers keep controlling
 * identifier allocation order.
 */
export function bootstrap_project(
  db: Db,
  input: BootstrapInput,
  deps: BootstrapDeps,
): BootstrapResult {
  const service = new CommandService(db, {
    clock: deps.clock,
    policy: BOOTSTRAP_POLICY,
    new_id: deps.new_id,
  });
  const outcome = service.execute_sync(
    {
      project_id: null,
      actor_id: null,
      via: "cli",
      client_request_id: new_id(),
    },
    "project.bootstrap",
    {
      slug: input.slug,
      topic: input.topic,
      owner_display_name: input.owner_display_name,
    },
  );
  return outcome.result as BootstrapResult;
}

/**
 * First registration of a project by device approval (stage 2 PR14): the same
 * project/owner/policy/edition as bootstrap plus the approved device actor and
 * its first token, in one command. One service.execute call; no SQL here.
 */
export function register_project(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "project.register", input);
}

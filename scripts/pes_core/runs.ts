// Public run command functions (stage 2 PR5).
//
// Each function is a thin wrapper: exactly one CommandService.execute call, no
// SQL and no direct database access. The registry entry and the transaction
// (policy, receipt replay, lease guard, change, events + receipt) live in
// commands.ts and commands/runs.ts.

import type { CommandOutcome, CommandService, MutationContext } from "./commands.ts";

export function create_run(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "run.create", input);
}

export function claim(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "run.claim", input);
}

export function heartbeat(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "run.heartbeat", input);
}

export function wait(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "run.wait", input);
}

export function complete(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "run.complete", input);
}

export function release(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "run.release", input);
}

export function handoff(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "run.handoff", input);
}

export function interrupt(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "run.interrupt", input);
}

export function record_receipt(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "run.record_receipt", input);
}

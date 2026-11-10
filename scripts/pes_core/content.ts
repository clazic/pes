// Public content command functions (stage 2 PR7).
//
// Each function is a thin wrapper: one CommandService call, no SQL and no
// direct database access. The registry entry and the transaction (policy,
// receipt replay, change, events + receipt) live in commands.ts and
// commands/content.ts.

import type { CommandOutcome, CommandService, MutationContext } from "./commands.ts";

export function create_object(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "content.create_object", input);
}

export function add_artifact(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "content.add_artifact", input);
}

export function add_source(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "content.add_source", input);
}

export function append_version(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "content.append_version", input);
}

export { submit_results } from "./results.ts";

export function set_current(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "content.set_current", input);
}

export function add_citation(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "content.add_citation", input);
}

export function link_relation(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "content.link_relation", input);
}

export function import_library(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "content.import_library", input);
}

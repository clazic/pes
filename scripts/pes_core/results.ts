// Public result submission function (stage 2 PR13).
//
// The command definition (result.submit) lives in commands/content.ts with the
// other content-domain writes. This wrapper is kept in its own module so the
// eight content.* public functions keep their one-service.execute contract; it
// is re-exported from content.ts for callers that import the content domain.

import type { CommandOutcome, CommandService, MutationContext } from "./commands.ts";

export function submit_results(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "result.submit", input);
}

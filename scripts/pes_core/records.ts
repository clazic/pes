// Public record functions for the CLI write path (stage 2 PR15).
//
// Each function is a thin wrapper: exactly one CommandService.execute call, no
// SQL and no direct database access. The definitions live in commands/records.ts
// (and commands/questions.ts for prepare_draft).

import type { CommandOutcome, CommandService, MutationContext } from "./commands.ts";

export function add_note(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "project.add_note", input);
}

export function record_chat(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "input.record_chat", input);
}

export function mark_processed(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "input.mark_processed", input);
}

export function record_qa(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "qa.record", input);
}

export function record_qa_brief(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "qa.record_brief", input);
}

export function prepare_question_draft(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "question.prepare_draft", input);
}

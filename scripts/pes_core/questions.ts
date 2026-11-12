// Public question and answer functions (stage 2 PR8).
//
// publish_set, revise_question, and submit_answers are thin wrappers: one
// CommandService.execute call each, no SQL and no direct database access. The
// registry entries and the transaction (policy, receipt replay, lease guard,
// change, events + receipt) live in commands.ts and commands/questions.ts.
//
// validate_submission and resume_ready are read-only: they take a Db handle
// and only read. Neither writes, and thinking about the form never fills an
// answer in.

import type { CommandOutcome, CommandService, MutationContext } from "./commands.ts";
import { hidden_questions, prepare_submission, type SubmissionError } from "./commands/questions.ts";
import type { Db } from "./db.ts";
import { ApiError } from "./errors.ts";

export interface SubmissionValidation {
  ok: boolean;
  errors: SubmissionError[];
}

export interface MissingAnswer {
  question_id: string;
  question_version_id: string;
  reason: "unanswered" | "needs_reconfirmation";
}

export interface ResumeReadiness {
  ready: boolean;
  missing: MissingAnswer[];
}

export function publish_set(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "question.publish_set", input);
}

export function revise_question(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "question.revise", input);
}

export function submit_answers(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "answer.submit", input);
}

/**
 * Report what is wrong with a bundle submission without changing anything.
 * A bad input is reported in `errors` as `{question_id, code}`; a stale form
 * reports `conflict` for the question that moved.
 */
export function validate_submission(
  db: Db,
  ctx: MutationContext,
  input: unknown,
): SubmissionValidation {
  if (ctx.project_id === null) {
    return { ok: false, errors: [{ question_id: null, code: "invalid_payload" }] };
  }
  const prepared = prepare_submission(db, ctx.project_id, input);
  if (prepared.ok) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: prepared.errors.map((e) => ({ question_id: e.question_id, code: e.code })),
  };
}

interface RequiredQuestionRow {
  question_id: string;
  question_version_id: string;
}

interface CurrentAnswerRow {
  state: string;
  question_version_id: string;
}

/**
 * The required questions of a round judged by each question's current version.
 * A question counts only when the current answer version is submitted and
 * pinned to that same question version. An answer pinned to an older version
 * asks for reconfirmation rather than being carried over.
 */
export function resume_ready(
  db: Db,
  project_id: string,
  round_id: string,
): ResumeReadiness {
  const round = db.get<{ id: string }>(
    "SELECT id FROM rounds WHERE project_id = ? AND id = ?",
    project_id,
    round_id,
  );
  if (round === undefined) {
    throw new ApiError("not_found", "round not found");
  }

  const required = db.all<RequiredQuestionRow>(
    `SELECT DISTINCT m.question_id AS question_id,
            o.current_version_id AS question_version_id
       FROM (
           SELECT stage_id, form_key, MAX(version_no) AS version_no
             FROM question_sets
            WHERE project_id = ?
            GROUP BY stage_id, form_key
       ) latest
       JOIN question_sets s
         ON s.project_id = ?
        AND s.stage_id = latest.stage_id
        AND s.form_key = latest.form_key
        AND s.version_no = latest.version_no
       JOIN question_set_members m
         ON m.project_id = s.project_id AND m.set_id = s.id
       JOIN objects o
         ON o.project_id = m.project_id AND o.id = m.question_id
        AND o.kind = 'question'
       JOIN question_versions qv
         ON qv.project_id = o.project_id AND qv.version_id = o.current_version_id
      WHERE s.round_id = ?
        AND qv.required = 1 AND qv.state = 'open'
      ORDER BY m.question_id`,
    project_id,
    project_id,
    round_id,
  );

  // A question whose show_if is false is not required (form_complete skips it the same way).
  const hidden = hidden_questions(
    db,
    project_id,
    required.map((row) => row.question_id),
  );
  const missing: MissingAnswer[] = [];
  for (const row of required) {
    if (hidden.has(row.question_id)) continue;
    const answer = db.get<CurrentAnswerRow>(
      `SELECT av.state, av.question_version_id
         FROM answers a
         JOIN objects ao
           ON ao.project_id = a.project_id AND ao.id = a.object_id
         JOIN answer_versions av
           ON av.project_id = a.project_id AND av.object_id = a.object_id
          AND av.version_id = ao.current_version_id
        WHERE a.project_id = ? AND a.question_id = ?`,
      project_id,
      row.question_id,
    );
    if (
      answer !== undefined &&
      answer.state === "submitted" &&
      answer.question_version_id === row.question_version_id
    ) {
      continue;
    }
    const older = db.get<{ ok: bigint }>(
      `SELECT 1 AS ok FROM answer_versions
        WHERE project_id = ? AND question_id = ? AND question_version_id <> ?
        LIMIT 1`,
      project_id,
      row.question_id,
      row.question_version_id,
    );
    missing.push({
      question_id: row.question_id,
      question_version_id: row.question_version_id,
      reason: older === undefined ? "unanswered" : "needs_reconfirmation",
    });
  }

  return { ready: missing.length === 0, missing };
}

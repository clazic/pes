// SEL-41 (stage 2 PR8) test harness: synthetic question sets, questions and answers, built on the
// PR6 edition harness (tests/helpers/editions_env.ts: temporary HOME, FakeClock, FakePolicy).
// Everything is invented. Nothing touches the real ~/.pes or ~/pes-projects.

import assert from "node:assert/strict";

import type { CommandOutcome, MutationContext } from "../../scripts/pes_core/commands.ts";
import type { Db } from "../../scripts/pes_core/db.ts";
import { publish_set, submit_answers } from "../../scripts/pes_core/questions.ts";
import { stage_ids, start, type Env } from "./editions_env.ts";

export {
  add_agent,
  agent_claim,
  agent_ctx,
  events_of,
  receipt_of,
  rejects_api,
  rejects_any,
  with_env,
  wrap_db,
  type Env,
} from "./editions_env.ts";

export interface MemberRef {
  question_id: string;
  question_version_id: string;
  position: number;
}

export interface PublishResult {
  project_id: string;
  set_id: string;
  set_version_no: number;
  stage_id: string;
  round_id: string | null;
  form_key: string;
  members: MemberRef[];
}

export interface AnswerEntry {
  question_id: string;
  answer_id: string | null;
  version_id: string | null;
  question_version_id: string;
  thread_id: string | null;
  message_id: string | null;
}

export interface SubmitResult {
  project_id: string;
  submission_id: string;
  set_id: string;
  answers: AnswerEntry[];
}

export interface ReviseResult {
  project_id: string;
  question_id: string;
  question_version_id: string;
  version_no: number;
}

export interface Readiness {
  ready: boolean;
  missing: { question_id: string; question_version_id: string; reason: "unanswered" | "needs_reconfirmation" }[];
}

export interface Guard {
  run_id: string;
  lease_id: string;
  fence: number;
}

/** The plan stage with one open round (the human owner starts it). */
export async function open_round(env: Env, tag = "r"): Promise<{ stage_id: string; round_id: string }> {
  const s = stage_ids(env.db, env.p.edition_id);
  const round = await start(env, s.plan, `${tag}-start`);
  return { stage_id: s.plan, round_id: round.round_id };
}

export const OPTIONS = [
  { value: "a", label: "합성 선택 A", recommended: true },
  { value: "b", label: "합성 선택 B" },
  { value: "c", label: "합성 선택 C" },
];

/** A required single-choice question: "a" is the recommended option, "b" the default value. */
export function single_spec(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text,
    type: "single",
    required: true,
    allow_comment_as_answer: false,
    options: OPTIONS,
    default_value: "b",
    ...extra,
  };
}

export function text_spec(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { text, type: "text", required: false, allow_comment_as_answer: false, ...extra };
}

export function number_spec(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { text, type: "number", required: false, allow_comment_as_answer: false, ...extra };
}

export async function publish(
  env: Env,
  where: { stage_id: string; round_id: string | null },
  questions: Record<string, unknown>[],
  key: string,
  extra: Record<string, unknown> = {},
  ctx: MutationContext = env.ctx(key),
): Promise<PublishResult> {
  const out = await publish_set(env.service, ctx, {
    stage_id: where.stage_id,
    round_id: where.round_id,
    purpose: "stage_start",
    form_key: "main",
    questions,
    ...extra,
  });
  assert.equal(out.replayed, false);
  return out.result as PublishResult;
}

export async function submit(
  env: Env,
  set_id: string,
  answers: Record<string, unknown>[],
  key: string,
  ctx: MutationContext = env.ctx(key),
): Promise<SubmitResult> {
  const out: CommandOutcome = await submit_answers(env.service, ctx, { set_id, answers });
  assert.equal(out.replayed, false);
  return out.result as SubmitResult;
}

export function counts(db: Db): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const table of [
    "question_sets",
    "question_set_members",
    "questions",
    "question_versions",
    "submissions",
    "answers",
    "answer_versions",
    "threads",
    "messages",
    "message_versions",
    "mutation_commits",
    "events",
  ]) {
    out[table] = db.get<{ n: bigint }>(`SELECT count(*) AS n FROM ${table}`)!.n;
  }
  return out;
}

export interface QuestionVersionRow {
  version_id: string;
  object_id: string;
  text: string;
  type: string;
  state: string;
  importance: string;
  required: bigint;
  allow_comment_as_answer: bigint;
  default_value: string;
  options: string;
  show_if: string;
  help: string | null;
}

export function question_version(db: Db, version_id: string): QuestionVersionRow {
  const row = db.get<QuestionVersionRow>("SELECT * FROM question_versions WHERE version_id = ?", version_id);
  assert.ok(row, "the question version exists");
  return { ...row };
}

export function question_current(db: Db, question_id: string): string {
  const row = db.get<{ current_version_id: string | null }>("SELECT current_version_id FROM objects WHERE id = ?", question_id);
  assert.ok(row?.current_version_id, "the question has a current version");
  return row.current_version_id;
}

export interface AnswerVersionRow {
  version_id: string;
  object_id: string;
  question_id: string;
  question_version_id: string;
  value: string;
  state: string;
  used_default: bigint | null;
  supersedes_version_id: string | null;
  version_no: bigint;
  actor_id: string;
}

/** Every answer version of one question, oldest first. */
export function answer_versions_of(db: Db, question_id: string): AnswerVersionRow[] {
  return db
    .all<AnswerVersionRow>(
      `SELECT av.version_id, av.object_id, av.question_id, av.question_version_id, av.value, av.state,
              av.used_default, av.supersedes_version_id, ov.version_no, ov.actor_id
         FROM answer_versions av
         JOIN object_versions ov ON ov.id = av.version_id
        WHERE av.question_id = ?
        ORDER BY ov.version_no`,
      question_id,
    )
    .map((row) => ({ ...row }));
}

export function answer_objects_of(db: Db, question_id: string) {
  return db
    .all<{ object_id: string; respondent_actor_id: string; submission_id: string; current_version_id: string | null }>(
      `SELECT a.object_id, a.respondent_actor_id, a.submission_id, o.current_version_id
         FROM answers a JOIN objects o ON o.id = a.object_id
        WHERE a.question_id = ? ORDER BY a.rowid`,
      question_id,
    )
    .map((row) => ({ ...row }));
}

export function members_of(db: Db, set_id: string): MemberRef[] {
  return db
    .all<MemberRef>(
      "SELECT question_id, question_version_id, position FROM question_set_members WHERE set_id = ? ORDER BY position",
      set_id,
    )
    .map((row) => ({ question_id: row.question_id, question_version_id: row.question_version_id, position: Number(row.position) }));
}

export interface CommentRow {
  thread_id: string;
  context_kind: string;
  target_object_id: string;
  target_version_id: string | null;
  message_id: string;
  submission_id: string | null;
  body_md: string;
  message_state: string;
  actor_id: string;
}

/** Threads whose subject is this question, with their messages (the minimal __other / comment rows). */
export function comments_of(db: Db, question_id: string): CommentRow[] {
  return db
    .all<CommentRow>(
      `SELECT t.object_id AS thread_id, t.context_kind, t.target_object_id, t.target_version_id,
              m.object_id AS message_id, m.submission_id, mv.body_md, mv.state AS message_state,
              ov.actor_id
         FROM threads t
         JOIN messages m ON m.thread_id = t.object_id AND m.project_id = t.project_id
         JOIN message_versions mv ON mv.object_id = m.object_id AND mv.project_id = m.project_id
         JOIN object_versions ov ON ov.id = mv.version_id
        WHERE t.target_object_id = ?
        ORDER BY m.rowid`,
      question_id,
    )
    .map((row) => ({ ...row }));
}

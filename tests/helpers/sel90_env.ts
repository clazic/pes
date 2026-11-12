// SEL-90 (stage 3 U2a) test helpers: synthetic forms, question state rows, API shortcuts.
// Everything is invented. Built on the PR8 question harness (temporary HOME, FakeClock) and the PR14 API harness.

import assert from "node:assert/strict";

import type { CommandOutcome } from "../../scripts/pes_core/commands.ts";
import type { Db } from "../../scripts/pes_core/db.ts";
import { call, assert_ok, type ApiEnv } from "./api_env.ts";
import { P } from "./api_flow.ts";
import {
  open_round,
  publish,
  single_spec,
  text_spec,
  type PublishResult,
} from "./questions_env.ts";

export { open_round, publish, single_spec, text_spec, type PublishResult };

/** Run one registered command as the owner (CLI channel), whatever its name. */
export function cmd(env: ApiEnv, key: string, name: string, payload: Record<string, unknown>): Promise<CommandOutcome> {
  return env.service.execute(env.ctx(key), name, payload);
}

export interface Form {
  stage_id: string;
  round_id: string;
  set: PublishResult;
  ids: string[];
}

/** One open round and one published form with the given questions (member order = array order). */
export async function make_form(
  env: ApiEnv,
  specs: Record<string, unknown>[],
  tag = `f${env.seq++}`,
  form_key = "main",
): Promise<Form> {
  const where = await open_round(env, tag);
  const set = await publish(env, where, specs, `${tag}-pub`, { form_key });
  return { ...where, set, ids: set.members.map((m) => m.question_id) };
}

export interface LatestSet {
  id: string;
  version_no: number;
  members: string[];
}

export function latest_set(db: Db, project_id: string, stage_id: string, form_key = "main"): LatestSet {
  const row = db.get<{ id: string; version_no: bigint }>(
    `SELECT id, version_no FROM question_sets WHERE project_id = ? AND stage_id = ? AND form_key = ?
      ORDER BY version_no DESC LIMIT 1`,
    project_id,
    stage_id,
    form_key,
  );
  assert.ok(row, "the form has a set");
  const members = db
    .all<{ question_id: string }>("SELECT question_id FROM question_set_members WHERE set_id = ? ORDER BY position", row.id)
    .map((m) => m.question_id);
  return { id: row.id, version_no: Number(row.version_no), members };
}

export function set_count(db: Db, stage_id: string, form_key = "main"): number {
  return Number(
    db.get<{ n: bigint }>("SELECT count(*) AS n FROM question_sets WHERE stage_id = ? AND form_key = ?", stage_id, form_key)!.n,
  );
}

export interface QRow {
  version_id: string;
  version_no: number;
  state: string;
  importance: string;
  required: number;
  text: string;
  defer_until: number | null;
  merged_into_question_id: string | null;
  options: string;
  show_if: string;
  allow_comment_as_answer: number;
}

/** Every version of a question, oldest first. */
export function versions_of(db: Db, question_id: string): QRow[] {
  return db
    .all<any>(
      `SELECT qv.version_id, ov.version_no, qv.state, qv.importance, qv.required, qv.text, qv.defer_until,
              qv.merged_into_question_id, qv.options, qv.show_if, qv.allow_comment_as_answer
         FROM question_versions qv JOIN object_versions ov ON ov.id = qv.version_id
        WHERE qv.object_id = ? ORDER BY ov.version_no`,
      question_id,
    )
    .map((r) => ({
      ...r,
      version_no: Number(r.version_no),
      required: Number(r.required),
      allow_comment_as_answer: Number(r.allow_comment_as_answer),
      defer_until: r.defer_until === null ? null : Number(r.defer_until),
    }));
}

export function current_row(db: Db, question_id: string): QRow {
  const o = db.get<{ current_version_id: string }>("SELECT current_version_id FROM objects WHERE id = ?", question_id);
  assert.ok(o?.current_version_id);
  const row = versions_of(db, question_id).find((v) => v.version_id === o.current_version_id);
  assert.ok(row);
  return row;
}

/** Counts of the history tables that a "no hard delete" rule must never shrink. */
export function history_counts(db: Db): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of [
    "objects",
    "object_versions",
    "questions",
    "question_versions",
    "question_sets",
    "question_set_members",
    "submissions",
    "answers",
    "answer_versions",
    "threads",
    "messages",
    "message_versions",
    "mutation_commits",
  ]) {
    out[t] = Number(db.get<{ n: bigint }>(`SELECT count(*) AS n FROM ${t}`)!.n);
  }
  return out;
}

export function receipts_count(db: Db): number {
  return Number(db.get<{ n: bigint }>("SELECT count(*) AS n FROM mutation_commits")!.n);
}

/** The owner posts a JSON body to a project route and returns the raw response. */
export function owner_post(env: ApiEnv, rest: string, body: unknown, key?: string) {
  return call(env, { method: "POST", path: P(env, rest), auth: "owner", body, key });
}

export async function owner_get(env: ApiEnv, rest: string) {
  return call(env, { method: "GET", path: P(env, rest), auth: "owner" });
}

/** Owner submits answers through the API. */
export async function api_submit(env: ApiEnv, set_id: string, answers: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return owner_post(env, "/submissions", { set_id, answers, ...extra });
}

export async function api_submit_ok(env: ApiEnv, set_id: string, answers: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return assert_ok(await api_submit(env, set_id, answers, extra), 201);
}

/** Current answer version (value, state, question version) of a question, or null. */
export function current_answer(db: Db, question_id: string) {
  const row = db.get<{ value: string; state: string; question_version_id: string; used_default: bigint | null; version_id: string }>(
    `SELECT av.value, av.state, av.question_version_id, av.used_default, av.version_id
       FROM answers a JOIN objects o ON o.id = a.object_id
       JOIN answer_versions av ON av.version_id = o.current_version_id
      WHERE a.question_id = ?`,
    question_id,
  );
  return row === undefined ? null : { ...row, value: JSON.parse(row.value), used_default: row.used_default === null ? null : Number(row.used_default) };
}

export function answer_version_count(db: Db): number {
  return Number(db.get<{ n: bigint }>("SELECT count(*) AS n FROM answer_versions")!.n);
}

/** Message rows (body, thread, context) of one question's comment threads, oldest first. */
export function comment_messages(db: Db, question_id: string) {
  return db
    .all<{ thread_id: string; message_id: string; body_md: string; state: string; context_kind: string; actor_id: string; submission_id: string | null }>(
      `SELECT t.object_id AS thread_id, m.object_id AS message_id, mv.body_md, mv.state, t.context_kind,
              ov.actor_id, m.submission_id
         FROM threads t
         JOIN messages m ON m.thread_id = t.object_id
         JOIN message_versions mv ON mv.object_id = m.object_id
         JOIN object_versions ov ON ov.id = mv.version_id
        WHERE t.target_object_id = ? ORDER BY m.rowid`,
      question_id,
    )
    .map((r) => ({ ...r }));
}

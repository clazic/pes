// Read models of selection comments and follow-ups (stage 3 U4a, SEL-99). Read-only: nothing here writes, and a read never adds an
// anchor judgement (the "current" view of an anchor is computed from the stored anchor and the text; only annotation.reanchor stores one).
// Callers wrap these in a read transaction (read_tx) so one answer comes from one database state.

import { cp_slice, judge_anchor, judge_on_origin, type AnchorStatus, type CpRange, type Judgement } from "../anchors.ts";
import type { Db } from "../db.ts";

export const THREAD_STATES: readonly string[] = ["open", "resolved", "archived"];
export const THREAD_CONTEXT_KINDS: readonly string[] = ["annotation", "question_comment", "general"];
export const FOLLOWUP_STATES: readonly string[] = ["proposed", "accepted", "running", "applied", "deferred", "rejected", "cancelled"];
export const FOLLOWUP_KINDS: readonly string[] = ["edit_text", "next_round_task", "reopen_stage", "none"];

function iso(ms: bigint | number): string {
  return new Date(Number(ms)).toISOString();
}

function num_or_null(value: bigint | number | null): number | null {
  return value === null ? null : Number(value);
}

// ---------------------------------------------------------------------------
// anchors

interface AnchorRaw {
  id: string;
  exact_quote: string;
  prefix: string;
  suffix: string;
  text_format_version: bigint;
  start_cp: bigint | null;
  end_cp: bigint | null;
  target_object_id: string;
  target_version_id: string;
}

export interface CurrentAnchor {
  evaluated_version_id: string | null;
  status: AnchorStatus;
  start_cp: number | null;
  end_cp: number | null;
  text: string | null;
  candidates: CpRange[];
  confirmed_by_actor_id: string | null;
}

/**
 * Where an anchor stands in the CURRENT version of its text, without writing anything.
 * - a version a person has re-attached the anchor on (the latest row confirmed by a person, on any version, the origin included): that choice
 * - otherwise the version the anchor was made on: where it stood (exact)
 * - otherwise judged fresh from the text (moved / ambiguous / lost are shown as they are, never hidden)
 */
export function current_anchor(db: Db, project_id: string, anchor: Pick<AnchorRaw, "id" | "exact_quote" | "prefix" | "suffix" | "start_cp" | "target_object_id" | "target_version_id">): CurrentAnchor {
  const object = db.get<{ current_version_id: string | null }>("SELECT current_version_id FROM objects WHERE project_id = ? AND id = ?", project_id, anchor.target_object_id);
  const version_id = object?.current_version_id ?? null;
  const body =
    version_id === null
      ? null
      : (db.get<{ body_md: string | null }>("SELECT body_md FROM artifact_versions WHERE project_id = ? AND object_id = ? AND version_id = ?", project_id, anchor.target_object_id, version_id)?.body_md ?? null);
  const facts = { exact_quote: anchor.exact_quote, prefix: anchor.prefix, suffix: anchor.suffix, start_cp: num_or_null(anchor.start_cp) };
  let judgement: Judgement;
  let confirmed_by_actor_id: string | null = null;
  // A person's choice for this version wins over any automatic judgement, whenever it was made and on whichever version
  // (also the origin version: a person may move an anchor to another repeat of its quote). A later automatic re-judgement
  // (annotation.reanchor without a range, open to a leased agent) adds its row but never hides the person's choice.
  const confirmed =
    version_id === null
      ? undefined
      : db.get<{ status: AnchorStatus; start_cp: bigint | null; end_cp: bigint | null; confirmed_by_actor_id: string }>(
          `SELECT status, start_cp, end_cp, confirmed_by_actor_id FROM anchor_resolutions
            WHERE project_id = ? AND anchor_id = ? AND evaluated_version_id = ? AND confirmed_by_actor_id IS NOT NULL
            ORDER BY rowid DESC LIMIT 1`,
          project_id,
          anchor.id,
          version_id,
        );
  if (confirmed !== undefined) {
    judgement = { status: confirmed.status, start_cp: num_or_null(confirmed.start_cp), end_cp: num_or_null(confirmed.end_cp), candidates: [] };
    confirmed_by_actor_id = confirmed.confirmed_by_actor_id;
  } else if (version_id === anchor.target_version_id) {
    judgement = judge_on_origin(facts);
  } else if (body === null) {
    judgement = { status: "lost", start_cp: null, end_cp: null, candidates: [] };
  } else {
    judgement = judge_anchor(body, facts);
  }
  const text = judgement.start_cp !== null && judgement.end_cp !== null && body !== null ? cp_slice(body, judgement.start_cp, judgement.end_cp) : null;
  return {
    evaluated_version_id: version_id,
    status: judgement.status,
    start_cp: judgement.start_cp,
    end_cp: judgement.end_cp,
    text,
    candidates: judgement.candidates,
    confirmed_by_actor_id,
  };
}

function anchor_raw(db: Db, project_id: string, anchor_id: string): AnchorRaw | undefined {
  return db.get<AnchorRaw>(
    `SELECT id, exact_quote, prefix, suffix, text_format_version, start_cp, end_cp, target_object_id, target_version_id
       FROM anchors WHERE project_id = ? AND id = ?`,
    project_id,
    anchor_id,
  );
}

// ---------------------------------------------------------------------------
// threads

export interface ThreadFilter {
  target_object_id?: string;
  context_kind?: string;
  state?: string;
}

interface ThreadListRaw {
  id: string;
  context_kind: string;
  target_object_id: string;
  target_version_id: string | null;
  anchor_id: string | null;
  state: string;
  summary: string;
  message_count: bigint;
}

export function thread_rows(db: Db, project_id: string, filter: ThreadFilter): Array<Record<string, unknown>> {
  const where: string[] = ["t.project_id = ?"];
  const args: string[] = [project_id];
  if (filter.target_object_id !== undefined) {
    where.push("t.target_object_id = ?");
    args.push(filter.target_object_id);
  }
  if (filter.context_kind !== undefined) {
    where.push("t.context_kind = ?");
    args.push(filter.context_kind);
  }
  if (filter.state !== undefined) {
    where.push("tv.state = ?");
    args.push(filter.state);
  }
  const rows = db.all<ThreadListRaw>(
    `SELECT t.object_id AS id, t.context_kind AS context_kind, t.target_object_id AS target_object_id,
            t.target_version_id AS target_version_id, t.anchor_id AS anchor_id, tv.state AS state, tv.summary AS summary,
            (SELECT count(*) FROM messages m WHERE m.project_id = t.project_id AND m.thread_id = t.object_id) AS message_count
       FROM threads t
       JOIN objects o ON o.project_id = t.project_id AND o.id = t.object_id
       JOIN thread_versions tv ON tv.project_id = o.project_id AND tv.version_id = o.current_version_id
      WHERE ${where.join(" AND ")}
      ORDER BY o.display_no, o.id`,
    ...args,
  );
  return rows.map((row) => {
    const anchor = row.anchor_id === null ? undefined : anchor_raw(db, project_id, row.anchor_id);
    return {
      id: row.id,
      context_kind: row.context_kind,
      state: row.state,
      target_object_id: row.target_object_id,
      target_version_id: row.target_version_id,
      message_count: Number(row.message_count),
      anchor_status: anchor === undefined ? null : current_anchor(db, project_id, anchor).status,
      summary: row.summary,
    };
  });
}

/** The followups raised from one thread, oldest first: {id, kind, state}. */
function thread_followups(db: Db, project_id: string, thread_id: string): Array<{ id: string; kind: string; state: string }> {
  return db.all<{ id: string; kind: string; state: string }>(
    `SELECT f.object_id AS id, fv.kind AS kind, fv.state AS state
       FROM followups f
       JOIN objects o ON o.project_id = f.project_id AND o.id = f.object_id
       JOIN followup_versions fv ON fv.project_id = o.project_id AND fv.version_id = o.current_version_id
      WHERE f.project_id = ? AND f.origin_thread_id = ?
      ORDER BY o.display_no, o.id`,
    project_id,
    thread_id,
  );
}

/** One thread with its anchor (the original and where it stands now), messages and follow-ups; undefined when this project has no such thread. */
export function thread_detail(db: Db, project_id: string, thread_id: string): Record<string, unknown> | undefined {
  const row = db.get<{
    context_kind: string;
    target_object_id: string;
    target_version_id: string | null;
    anchor_id: string | null;
    state: string;
    summary: string;
    resolved_by_message_version_id: string | null;
  }>(
    `SELECT t.context_kind AS context_kind, t.target_object_id AS target_object_id, t.target_version_id AS target_version_id,
            t.anchor_id AS anchor_id, tv.state AS state, tv.summary AS summary,
            tv.resolved_by_message_version_id AS resolved_by_message_version_id
       FROM threads t
       JOIN objects o ON o.project_id = t.project_id AND o.id = t.object_id
       JOIN thread_versions tv ON tv.project_id = o.project_id AND tv.version_id = o.current_version_id
      WHERE t.project_id = ? AND t.object_id = ?`,
    project_id,
    thread_id,
  );
  if (row === undefined) return undefined;

  let resolution: Record<string, unknown> | null = null;
  if (row.resolved_by_message_version_id !== null) {
    const message = db.get<{ body_md: string }>("SELECT body_md FROM message_versions WHERE project_id = ? AND version_id = ?", project_id, row.resolved_by_message_version_id);
    // the follow-up raised together with the closing message names the resolution; none means it was closed with no change
    const raised = db.get<{ id: string; kind: string }>(
      `SELECT f.object_id AS id, fv.kind AS kind
         FROM followups f
         JOIN objects o ON o.project_id = f.project_id AND o.id = f.object_id
         JOIN followup_versions fv ON fv.project_id = o.project_id AND fv.version_id = o.current_version_id
        WHERE f.project_id = ? AND f.origin_message_version_id = ?
        ORDER BY o.display_no LIMIT 1`,
      project_id,
      row.resolved_by_message_version_id,
    );
    resolution = {
      resolution: raised?.kind ?? "none",
      reason: message?.body_md ?? "",
      followup_id: raised?.id ?? null,
      message_version_id: row.resolved_by_message_version_id,
    };
  }

  let anchor: Record<string, unknown> | null = null;
  if (row.anchor_id !== null) {
    const raw = anchor_raw(db, project_id, row.anchor_id);
    if (raw !== undefined) {
      const first = db.get<{ status: string }>("SELECT status FROM anchor_resolutions WHERE project_id = ? AND anchor_id = ? ORDER BY rowid LIMIT 1", project_id, raw.id);
      const current = current_anchor(db, project_id, raw);
      anchor = {
        id: raw.id,
        exact_quote: raw.exact_quote,
        prefix: raw.prefix,
        suffix: raw.suffix,
        text_format_version: Number(raw.text_format_version),
        start_cp: num_or_null(raw.start_cp),
        end_cp: num_or_null(raw.end_cp),
        target_version_id: raw.target_version_id,
        status: first?.status ?? "exact",
        current,
      };
    }
  }

  const messages = db
    .all<{ id: string; version_id: string; body_md: string; state: string; reply_to: string | null; actor_id: string; created_at: bigint }>(
      `SELECT m.object_id AS id, mv.version_id AS version_id, mv.body_md AS body_md, mv.state AS state, m.reply_to AS reply_to,
              ov.actor_id AS actor_id, ov.created_at AS created_at
         FROM messages m
         JOIN objects o ON o.project_id = m.project_id AND o.id = m.object_id
         JOIN message_versions mv ON mv.project_id = o.project_id AND mv.version_id = o.current_version_id
         JOIN object_versions ov ON ov.project_id = mv.project_id AND ov.id = mv.version_id
        WHERE m.project_id = ? AND m.thread_id = ?
        ORDER BY m.rowid`,
      project_id,
      thread_id,
    )
    .map((message) => ({ ...message, created_at: iso(message.created_at) }));

  return {
    thread: {
      id: thread_id,
      context_kind: row.context_kind,
      state: row.state,
      target_object_id: row.target_object_id,
      target_version_id: row.target_version_id,
      summary: row.summary,
      resolution,
    },
    anchor,
    messages,
    followups: thread_followups(db, project_id, thread_id),
  };
}

// ---------------------------------------------------------------------------
// follow-ups

export interface FollowupFilter {
  thread_id?: string;
  state?: string;
  kind?: string;
}

export function followup_rows(db: Db, project_id: string, filter: FollowupFilter): Array<Record<string, unknown>> {
  const where: string[] = ["f.project_id = ?"];
  const args: string[] = [project_id];
  if (filter.thread_id !== undefined) {
    where.push("f.origin_thread_id = ?");
    args.push(filter.thread_id);
  }
  if (filter.state !== undefined) {
    where.push("fv.state = ?");
    args.push(filter.state);
  }
  if (filter.kind !== undefined) {
    where.push("fv.kind = ?");
    args.push(filter.kind);
  }
  const rows = db.all<{
    id: string;
    kind: string;
    state: string;
    description: string;
    version_no: bigint;
    origin_thread_id: string | null;
    origin_version_id: string | null;
    base_version_id: string | null;
    proposed_version_id: string | null;
    proposed_body_md: string | null;
    result_version_id: string | null;
    applied_tx_id: string | null;
    confirmed_by_actor_id: string | null;
    target_stage_id: string | null;
    target_round_id: string | null;
  }>(
    `SELECT f.object_id AS id, fv.kind AS kind, fv.state AS state, fv.description AS description, ov.version_no AS version_no,
            f.origin_thread_id AS origin_thread_id, f.origin_version_id AS origin_version_id,
            fv.base_artifact_version_id AS base_version_id, fv.proposed_artifact_version_id AS proposed_version_id,
            (SELECT av.body_md FROM artifact_versions av WHERE av.project_id = fv.project_id AND av.version_id = fv.proposed_artifact_version_id) AS proposed_body_md,
            fv.result_version_id AS result_version_id, fv.applied_tx_id AS applied_tx_id,
            fv.confirmed_by_actor_id AS confirmed_by_actor_id, fv.target_stage_id AS target_stage_id, fv.target_round_id AS target_round_id
       FROM followups f
       JOIN objects o ON o.project_id = f.project_id AND o.id = f.object_id
       JOIN followup_versions fv ON fv.project_id = o.project_id AND fv.version_id = o.current_version_id
       JOIN object_versions ov ON ov.project_id = fv.project_id AND ov.id = fv.version_id
      WHERE ${where.join(" AND ")}
      ORDER BY o.display_no, o.id`,
    ...args,
  );
  return rows.map((row) => ({ ...row, version_no: String(row.version_no) }));
}

/** The state of the thread a follow-up came from (null when it has none). */
export function thread_state_of(db: Db, project_id: string, thread_id: string | null): string | null {
  if (thread_id === null) return null;
  return (
    db.get<{ state: string }>(
      `SELECT tv.state AS state FROM threads t
         JOIN objects o ON o.project_id = t.project_id AND o.id = t.object_id
         JOIN thread_versions tv ON tv.project_id = o.project_id AND tv.version_id = o.current_version_id
        WHERE t.project_id = ? AND t.object_id = ?`,
      project_id,
      thread_id,
    )?.state ?? null
  );
}

/**
 * The one command a reply to a thread goes through, for every entry (A thread.reply tool, B pes_thread_reply via
 * POST P/threads/{t}/messages): a question comment thread takes question.comment_add (the SEL-90 contract, receipt
 * 'question.commented'), any other thread thread.reply. Both refuse a closed thread (conflict, reason thread_closed).
 * undefined: no such thread in this project.
 */
export function thread_reply_route(
  db: Db,
  project_id: string,
  thread_id: string,
): { command: "question.comment_add"; question_id: string } | { command: "thread.reply" } | undefined {
  const thread = db.get<{ target_object_id: string; context_kind: string }>(
    "SELECT target_object_id, context_kind FROM threads WHERE project_id = ? AND object_id = ?",
    project_id,
    thread_id,
  );
  if (thread === undefined) return undefined;
  return thread.context_kind === "question_comment" ? { command: "question.comment_add", question_id: thread.target_object_id } : { command: "thread.reply" };
}

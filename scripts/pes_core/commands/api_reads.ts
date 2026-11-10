// Read-only queries for the HTTP API (stage 2 PR14): the change feed, a run's
// inputs, operation / request lookups, and the small reads that shape a
// response. Every function takes a Db handle and only SELECTs; no write and no
// business rule lives here. Callers wrap multi-read use in read_tx.

import type { Db } from "../db.ts";

export interface DbMeta {
  database_instance_id: string;
  cursor_epoch: string;
}

export function db_meta(db: Db): DbMeta {
  const row = db.get<{ database_instance_id: string; cursor_epoch: bigint }>(
    "SELECT database_instance_id, cursor_epoch FROM db_meta WHERE id = 1",
  );
  if (row === undefined) throw new Error("db_meta is missing");
  return {
    database_instance_id: row.database_instance_id,
    cursor_epoch: row.cursor_epoch.toString(),
  };
}

// ---------------------------------------------------------------------------
// change feed

export interface EventDto {
  event_seq: string;
  type: string;
  object_id: string | null;
  before_version_id: string | null;
  after_version_id: string | null;
  at: number;
}

interface EventRow {
  event_seq: bigint;
  tx_id: string;
  type: string;
  object_id: string | null;
  before_version_id: string | null;
  after_version_id: string | null;
  created_at: bigint;
}

export function max_event_seq(db: Db, project_id: string): bigint {
  const row = db.get<{ n: bigint | null }>(
    "SELECT max(event_seq) AS n FROM events WHERE project_id = ?",
    project_id,
  );
  return row?.n ?? 0n;
}

/**
 * Events after `after`, whole transactions only. Events the caller may not see
 * are scanned (the cursor moves past them) but not returned. A page ends after
 * the transaction that reaches `limit` visible events.
 */
export function changes_page(
  db: Db,
  project_id: string,
  after: bigint,
  limit: number,
  hide_tokens: boolean,
): { events: EventDto[]; last_seq: bigint; has_more: boolean } {
  const events: EventDto[] = [];
  let cursor = after;
  let has_more = false;
  for (;;) {
    const head = db.get<{ event_seq: bigint; tx_id: string }>(
      "SELECT event_seq, tx_id FROM events WHERE project_id = ? AND event_seq > ? ORDER BY event_seq LIMIT 1",
      project_id,
      cursor,
    );
    if (head === undefined) break;
    if (events.length >= limit) {
      has_more = true;
      break;
    }
    const group = db.all<EventRow>(
      `SELECT event_seq, tx_id, type, object_id, before_version_id, after_version_id, created_at
         FROM events WHERE project_id = ? AND tx_id = ? AND event_seq > ? ORDER BY event_seq`,
      project_id,
      head.tx_id,
      cursor,
    );
    for (const row of group) {
      cursor = row.event_seq;
      if (hide_tokens && row.type.startsWith("token.")) continue;
      events.push({
        event_seq: row.event_seq.toString(),
        type: row.type,
        object_id: row.object_id,
        before_version_id: row.before_version_id,
        after_version_id: row.after_version_id,
        at: Number(row.created_at),
      });
    }
  }
  return { events, last_seq: cursor, has_more };
}

// ---------------------------------------------------------------------------
// runs, leases, inputs

export interface RunInfo {
  id: string;
  actor_id: string;
  status: string;
  mode: string;
}

export function run_info(db: Db, project_id: string, run_id: string): RunInfo | undefined {
  return db.get<RunInfo>(
    "SELECT id, actor_id, status, mode FROM runs WHERE project_id = ? AND id = ?",
    project_id,
    run_id,
  );
}

export interface LeaseInfo {
  lease_id: string;
  run_id: string | null;
  owner_actor_id: string | null;
  fence: bigint;
  state: string;
  expires_at: bigint;
}

export function lease_info(db: Db, project_id: string): LeaseInfo | undefined {
  return db.get<LeaseInfo>(
    `SELECT lease_id, run_id, owner_actor_id, fence, state, expires_at
       FROM project_leases WHERE project_id = ?`,
    project_id,
  );
}

export interface InputRow {
  input_version_id: string;
  question_id: string;
  available_at: number;
  state: string;
  pos: bigint;
}

/** Answer versions to questions that `actor_id` asked, in insertion order after `after`. */
export function inputs_page(
  db: Db,
  project_id: string,
  run_id: string,
  actor_id: string,
  after: bigint,
  limit: number,
): { items: InputRow[]; has_more: boolean } {
  const rows = db.all<{
    input_version_id: string;
    question_id: string;
    created_at: bigint;
    receipt_state: string | null;
    pos: bigint;
  }>(
    `SELECT av.version_id AS input_version_id, av.question_id AS question_id,
            ov.created_at AS created_at, r.state AS receipt_state, av.rowid AS pos
       FROM answer_versions av
       JOIN questions q ON q.project_id = av.project_id AND q.object_id = av.question_id
       JOIN object_versions ov ON ov.project_id = av.project_id AND ov.id = av.version_id
       LEFT JOIN run_input_receipts r
         ON r.project_id = av.project_id AND r.run_id = ? AND r.input_version_id = av.version_id
      WHERE av.project_id = ? AND q.asked_by_actor_id = ? AND av.state = 'submitted'
        AND av.rowid > ?
      ORDER BY av.rowid
      LIMIT ?`,
    run_id,
    project_id,
    actor_id,
    after,
    limit + 1,
  );
  const items = rows.slice(0, limit).map((row) => ({
    input_version_id: row.input_version_id,
    question_id: row.question_id,
    available_at: Number(row.created_at),
    state: row.receipt_state ?? "new",
    pos: row.pos,
  }));
  return { items, has_more: rows.length > limit };
}

/** True when the answer version answers a question the actor asked. */
export function input_visible(
  db: Db,
  project_id: string,
  actor_id: string,
  input_version_id: string,
): boolean {
  const row = db.get<{ ok: bigint }>(
    `SELECT 1 AS ok FROM answer_versions av
       JOIN questions q ON q.project_id = av.project_id AND q.object_id = av.question_id
      WHERE av.project_id = ? AND av.version_id = ? AND q.asked_by_actor_id = ?`,
    project_id,
    input_version_id,
    actor_id,
  );
  return row !== undefined;
}

/** Inputs of the run's actor that have no applied/ignored receipt yet. */
export function pending_input_count(
  db: Db,
  project_id: string,
  run_id: string,
  actor_id: string,
): number {
  const row = db.get<{ n: bigint }>(
    `SELECT count(*) AS n
       FROM answer_versions av
       JOIN questions q ON q.project_id = av.project_id AND q.object_id = av.question_id
       LEFT JOIN run_input_receipts r
         ON r.project_id = av.project_id AND r.run_id = ? AND r.input_version_id = av.version_id
      WHERE av.project_id = ? AND q.asked_by_actor_id = ? AND av.state = 'submitted'
        AND (r.state IS NULL OR r.state = 'seen')`,
    run_id,
    project_id,
    actor_id,
  );
  return Number(row?.n ?? 0n);
}

// ---------------------------------------------------------------------------
// operations and request lookups (the receipt is the durable record)

export interface ReceiptRow {
  id: string;
  actor_id: string;
  client_request_id: string;
  action: string;
  created_at: bigint;
  result_json: string;
  lease_id: string | null;
  fence: bigint | null;
}

export function operation_receipt(db: Db, project_id: string, id: string): ReceiptRow | undefined {
  return db.get<ReceiptRow>(
    `SELECT id, actor_id, client_request_id, action, created_at, result_json, lease_id, fence
       FROM mutation_commits
      WHERE project_id = ? AND id = ? AND action IN ('run.interrupted', 'run.cancelled')`,
    project_id,
    id,
  );
}

export function request_receipt(
  db: Db,
  project_id: string,
  key: string,
  actor_id: string | null,
): ReceiptRow | undefined {
  return actor_id === null
    ? db.get<ReceiptRow>(
        `SELECT id, actor_id, client_request_id, action, created_at, result_json, lease_id, fence
           FROM mutation_commits WHERE project_id = ? AND client_request_id = ?
          ORDER BY rowid LIMIT 1`,
        project_id,
        key,
      )
    : db.get<ReceiptRow>(
        `SELECT id, actor_id, client_request_id, action, created_at, result_json, lease_id, fence
           FROM mutation_commits WHERE project_id = ? AND client_request_id = ? AND actor_id = ?`,
        project_id,
        key,
        actor_id,
      );
}

/** The receipt a given (actor, key) request left, if any. */
export function receipt_of_request(
  db: Db,
  project_id: string,
  actor_id: string,
  key: string,
): ReceiptRow | undefined {
  return request_receipt(db, project_id, key, actor_id);
}

// ---------------------------------------------------------------------------
// small reads that shape responses

export function owner_user_id(db: Db, project_id: string): string | undefined {
  return db.get<{ owner_user_id: string }>(
    "SELECT owner_user_id FROM projects WHERE id = ?",
    project_id,
  )?.owner_user_id;
}

export function question_state(db: Db, project_id: string, version_id: string): string | undefined {
  return db.get<{ state: string }>(
    "SELECT state FROM question_versions WHERE project_id = ? AND version_id = ?",
    project_id,
    version_id,
  )?.state;
}

export function submission_received_at(db: Db, project_id: string, id: string): number | undefined {
  const row = db.get<{ received_at: bigint }>(
    "SELECT received_at FROM submissions WHERE project_id = ? AND id = ?",
    project_id,
    id,
  );
  return row === undefined ? undefined : Number(row.received_at);
}

export function approval_row(
  db: Db,
  project_id: string,
  id: string,
): { id: string; assurance: string; human_user_id: string | null } | undefined {
  return db.get<{ id: string; assurance: string; human_user_id: string | null }>(
    "SELECT id, assurance, human_user_id FROM approvals WHERE project_id = ? AND id = ?",
    project_id,
    id,
  );
}

export function latest_approval_id(db: Db, project_id: string, stage_id: string): string | null {
  return (
    db.get<{ id: string }>(
      "SELECT id FROM approvals WHERE project_id = ? AND stage_id = ? ORDER BY rowid DESC LIMIT 1",
      project_id,
      stage_id,
    )?.id ?? null
  );
}

export function stage_view(
  db: Db,
  project_id: string,
  stage_id: string,
): { id: string; status: string; ordinal: bigint; current_round_id: string | null; approved_snapshot_id: string | null } | undefined {
  return db.get<{
    id: string;
    status: string;
    ordinal: bigint;
    current_round_id: string | null;
    approved_snapshot_id: string | null;
  }>(
    "SELECT id, status, ordinal, current_round_id, approved_snapshot_id FROM stages WHERE project_id = ? AND id = ?",
    project_id,
    stage_id,
  );
}

export function round_view(
  db: Db,
  project_id: string,
  round_id: string,
): { id: string; state: string; stage_id: string; round_no: bigint } | undefined {
  return db.get<{ id: string; state: string; stage_id: string; round_no: bigint }>(
    "SELECT id, state, stage_id, round_no FROM rounds WHERE project_id = ? AND id = ?",
    project_id,
    round_id,
  );
}

export function snapshot_through_seq(db: Db, project_id: string, snapshot_id: string): bigint | null {
  return (
    db.get<{ through_event_seq: bigint | null }>(
      "SELECT through_event_seq FROM snapshots WHERE project_id = ? AND id = ?",
      project_id,
      snapshot_id,
    )?.through_event_seq ?? null
  );
}

export function run_actor_member(db: Db, project_id: string, actor_id: string): boolean {
  const row = db.get<{ ok: bigint }>(
    `SELECT 1 AS ok FROM actors a JOIN project_members m ON m.user_id = a.user_id
      WHERE a.id = ? AND m.project_id = ?`,
    actor_id,
    project_id,
  );
  return row !== undefined;
}

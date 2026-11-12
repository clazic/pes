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
// the current place of an edition (SEL-82): the one rule behind GET P/workspace `current` and the address `pes open <slug> --app` prints

export interface PlaceStage {
  id: string;
  key: string;
  status: string;
}

export interface PlaceRound {
  stage_id: string;
  round_no: bigint;
  state: string;
}

/**
 * The stage an edition is at (its current stage, else the first not approved, else the last) and the round the screen opens there:
 * the open round, else — unless the stage is still asking — the last round; round_id null = the stage-start place (there is no R0).
 * `stages` are in stage order, `rounds` in (stage, round_no) order. Pure: rows in, answer out.
 */
export function current_place<S extends PlaceStage>(
  current_stage_id: string | null,
  stages: readonly S[],
  rounds: readonly PlaceRound[],
): { stage: S; round_id: number | null; open_round: PlaceRound | undefined } | undefined {
  const stage =
    stages.find((candidate) => candidate.id === current_stage_id) ??
    stages.find((candidate) => candidate.status !== "approved") ??
    stages[stages.length - 1];
  if (stage === undefined) return undefined;
  const open_round = rounds.find((round) => round.stage_id === stage.id && round.state === "open");
  const last_round = [...rounds].reverse().find((round) => round.stage_id === stage.id);
  const round_id =
    open_round !== undefined ? Number(open_round.round_no) : stage.status === "asking" || last_round === undefined ? null : Number(last_round.round_no);
  return { stage, round_id, open_round };
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
  /** the answer object the version belongs to (read it at objects/{object_id}/versions/{input_version_id}) */
  object_id: string;
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
    object_id: string;
    question_id: string;
    created_at: bigint;
    receipt_state: string | null;
    pos: bigint;
  }>(
    `SELECT av.version_id AS input_version_id, av.object_id AS object_id, av.question_id AS question_id,
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
    object_id: row.object_id,
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
  run_id: string | null;
}

export function operation_receipt(db: Db, project_id: string, id: string): ReceiptRow | undefined {
  return db.get<ReceiptRow>(
    `SELECT id, actor_id, client_request_id, action, created_at, result_json, lease_id, fence, run_id
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
        `SELECT id, actor_id, client_request_id, action, created_at, result_json, lease_id, fence, run_id
           FROM mutation_commits WHERE project_id = ? AND client_request_id = ?
          ORDER BY rowid LIMIT 1`,
        project_id,
        key,
      )
    : db.get<ReceiptRow>(
        `SELECT id, actor_id, client_request_id, action, created_at, result_json, lease_id, fence, run_id
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

export function snapshot_through_seq(db: Db, project_id: string, snapshot_id: string): bigint | null {
  return (
    db.get<{ through_event_seq: bigint | null }>(
      "SELECT through_event_seq FROM snapshots WHERE project_id = ? AND id = ?",
      project_id,
      snapshot_id,
    )?.through_event_seq ?? null
  );
}

// ---------------------------------------------------------------------------
// assumptions, decisions, reflections (SEL-93 U3a): one current row per object; older versions stay in the tables

function iso_of(ms: bigint | number | null): string | null {
  return ms === null ? null : new Date(Number(ms)).toISOString();
}

export interface AssumptionDto {
  id: string;
  version_id: string;
  version_no: string;
  statement: string;
  state: string;
  needs_review: boolean;
  proposed_by_actor_id: string;
  assessed_by_actor_id: string | null;
  assessed_at: string | null;
  rationale: string;
}

/** The assumptions of one edition, each as its current version (a judged one shows the judgement, not the proposal). */
export function assumption_rows(db: Db, project_id: string, edition_id: string): AssumptionDto[] {
  return db
    .all<{
      id: string;
      version_id: string;
      version_no: bigint;
      statement: string;
      state: string;
      needs_review: bigint;
      proposed_by_actor_id: string;
      assessment_actor_id: string | null;
      assessed_at: bigint | null;
      rationale: string;
    }>(
      `SELECT o.id AS id, o.current_version_id AS version_id, ov.version_no AS version_no, av.statement AS statement,
              av.state AS state, av.needs_review AS needs_review, a.proposed_by_actor_id AS proposed_by_actor_id,
              av.assessment_actor_id AS assessment_actor_id, av.assessed_at AS assessed_at, av.rationale AS rationale
         FROM objects o
         JOIN assumptions a ON a.project_id = o.project_id AND a.object_id = o.id
         JOIN object_versions ov ON ov.project_id = o.project_id AND ov.id = o.current_version_id
         JOIN assumption_versions av ON av.project_id = o.project_id AND av.version_id = o.current_version_id
        WHERE o.project_id = ? AND o.edition_id = ? AND o.kind = 'assumption' AND o.archived_at IS NULL
        ORDER BY o.display_no`,
      project_id,
      edition_id,
    )
    .map((row) => ({
      id: row.id,
      version_id: row.version_id,
      version_no: row.version_no.toString(),
      statement: row.statement,
      state: row.state,
      needs_review: row.needs_review === 1n,
      proposed_by_actor_id: row.proposed_by_actor_id,
      assessed_by_actor_id: row.assessment_actor_id,
      assessed_at: iso_of(row.assessed_at),
      rationale: row.rationale,
    }));
}

export interface DecisionDto {
  id: string;
  version_id: string;
  version_no: string;
  statement: string;
  state: string;
  scope: string;
  decided_by_actor_id: string | null;
  rationale: string;
  supersedes_decision_id: string | null;
}

/** The decisions of one edition plus the project-wide ones, each as its current version (superseded and revoked ones stay as lines). */
export function decision_rows(db: Db, project_id: string, edition_id: string): DecisionDto[] {
  return db
    .all<{
      id: string;
      version_id: string;
      version_no: bigint;
      statement: string;
      state: string;
      scope: string;
      decided_by: string | null;
      rationale: string;
      supersedes_decision_id: string | null;
    }>(
      `SELECT o.id AS id, o.current_version_id AS version_id, ov.version_no AS version_no, dv.statement AS statement,
              dv.state AS state, d.scope AS scope, dv.decided_by AS decided_by, dv.rationale AS rationale,
              dv.supersedes_decision_id AS supersedes_decision_id
         FROM objects o
         JOIN decisions d ON d.project_id = o.project_id AND d.object_id = o.id
         JOIN object_versions ov ON ov.project_id = o.project_id AND ov.id = o.current_version_id
         JOIN decision_versions dv ON dv.project_id = o.project_id AND dv.version_id = o.current_version_id
        WHERE o.project_id = ? AND o.kind = 'decision' AND o.archived_at IS NULL
          AND (o.edition_id = ? OR d.scope = 'project')
        ORDER BY o.display_no`,
      project_id,
      edition_id,
    )
    .map((row) => ({
      id: row.id,
      version_id: row.version_id,
      version_no: row.version_no.toString(),
      statement: row.statement,
      state: row.state,
      scope: row.scope,
      decided_by_actor_id: row.decided_by,
      rationale: row.rationale,
      supersedes_decision_id: row.supersedes_decision_id,
    }));
}

/** The decision that replaced `decision_id` (it names it as the one it supersedes), or null. */
export function replacing_decision_id(db: Db, project_id: string, decision_id: string): string | null {
  const row = db.get<{ object_id: string }>(
    "SELECT object_id FROM decision_versions WHERE project_id = ? AND supersedes_decision_id = ? ORDER BY rowid LIMIT 1",
    project_id,
    decision_id,
  );
  return row?.object_id ?? null;
}

export interface ReflectionEntryDto {
  id: string;
  source_version_id: string;
  disposition: string;
  rationale: string;
  result_version_id: string | null;
  followup_id: string | null;
  applied_tx_id: string | null;
  actor_id: string;
}

export interface ReflectionRoundDto {
  round_id: string;
  submitted: boolean;
  counts: { applied: number; partial: number; rejected: number; deferred: number };
  entries: ReflectionEntryDto[];
}

/** Whether a reflection was submitted for the round: a receipt of reflection.create exists (an empty list is a submission: "0건"). */
export function reflection_submitted(db: Db, project_id: string, round_id: string): boolean {
  return (
    db.get(
      `SELECT 1 FROM mutation_commits
        WHERE project_id = ? AND action = 'reflection.created' AND json_extract(result_json, '$.target_round_id') = ? LIMIT 1`,
      project_id,
      round_id,
    ) !== undefined
  );
}

/** One round's reflection: the entries still standing (a corrected entry is replaced by the one that supersedes it) and the counts. */
export function reflection_round(db: Db, project_id: string, round_id: string): ReflectionRoundDto {
  const entries = db.all<ReflectionEntryDto>(
    `SELECT e.id AS id, e.source_version_id AS source_version_id, e.disposition AS disposition, e.rationale AS rationale,
            e.result_version_id AS result_version_id, e.followup_id AS followup_id, e.applied_tx_id AS applied_tx_id,
            e.actor_id AS actor_id
       FROM reflection_entries e
      WHERE e.project_id = ? AND e.target_round_id = ?
        AND NOT EXISTS (SELECT 1 FROM reflection_entries n WHERE n.project_id = e.project_id AND n.supersedes_entry_id = e.id)
      ORDER BY e.rowid`,
    project_id,
    round_id,
  );
  const counts = { applied: 0, partial: 0, rejected: 0, deferred: 0 };
  for (const entry of entries) counts[entry.disposition as keyof typeof counts] += 1;
  return { round_id, submitted: reflection_submitted(db, project_id, round_id), counts, entries };
}

/** The rounds that have a reflection submission, oldest first (no submission yet: an empty list). */
export function reflection_round_ids(db: Db, project_id: string): string[] {
  return db
    .all<{ round_id: string }>(
      `SELECT json_extract(result_json, '$.target_round_id') AS round_id
         FROM mutation_commits WHERE project_id = ? AND action = 'reflection.created'
        GROUP BY round_id ORDER BY min(rowid)`,
      project_id,
    )
    .map((row) => row.round_id);
}

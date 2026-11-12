// Read-only queries for the HTTP API (stage 2 PR14): the change feed, a run's
// inputs, operation / request lookups, and the small reads that shape a
// response. Every function takes a Db handle and only SELECTs; no write and no
// business rule lives here. Callers wrap multi-read use in read_tx.

import type { Db } from "../db.ts";
import { artifact_version_denied, event_denied, type Audience } from "./file_access.ts";

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
  payload: string;
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
 * `hide_tokens` is true for every non-human caller: it also hides token events and every event about a file closed to AI
 * (commands/file_access.ts event_denied).
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
      `SELECT event_seq, tx_id, type, object_id, before_version_id, after_version_id, created_at, payload
         FROM events WHERE project_id = ? AND tx_id = ? AND event_seq > ? ORDER BY event_seq`,
      project_id,
      head.tx_id,
      cursor,
    );
    for (const row of group) {
      cursor = row.event_seq;
      if (hide_tokens && row.type.startsWith("token.")) continue;
      if (hide_tokens && event_denied(db, project_id, row)) continue;
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

/**
 * True when the version is an input of this actor: an answer to a question the actor asked, or (SEL-118 U5a) a version
 * of a human -> AI question that names the actor as the AI it is for (the receipt that says "I have the question").
 */
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
  if (row !== undefined) return true;
  const ask = db.get<{ ok: bigint }>(
    `SELECT 1 AS ok FROM question_versions qv
       JOIN questions q ON q.project_id = qv.project_id AND q.object_id = qv.object_id
      WHERE qv.project_id = ? AND qv.version_id = ?
        AND q.direction = 'human_to_agent' AND q.intended_actor_id = ?`,
    project_id,
    input_version_id,
    actor_id,
  );
  return ask !== undefined;
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

/** A person or an AI as the screens name them: the actor's id, whether it is a human or an AI, and its display name. */
export interface ActorDto {
  id: string;
  kind: "human" | "ai";
  name: string;
}

/**
 * The actor behind an id, or null when the row is gone. `kind` is "human" for a human actor and "ai" for every other kind
 * (internal_ai, external_agent, browser_agent, and also system / legacy_unknown, which no record route writes).
 */
export function actor_dto(db: Db, actor_id: string | null): ActorDto | null {
  if (actor_id === null) return null;
  const row = db.get<{ kind: string; display_name: string }>("SELECT kind, display_name FROM actors WHERE id = ?", actor_id);
  if (row === undefined) return null;
  return { id: actor_id, kind: row.kind === "human" ? "human" : "ai", name: row.display_name };
}

export interface AssumptionDto {
  id: string;
  version_id: string;
  version_no: string;
  statement: string;
  state: string;
  needs_review: boolean;
  proposed_by_actor_id: string;
  proposed_by: ActorDto | null;
  assessed_by_actor_id: string | null;
  assessed_by: ActorDto | null;
  assessed_at: string | null;
  rationale: string;
  /** Only for a revised assumption: the version that stood before the fix, and its sentence. */
  revised_from_version_id: string | null;
  revised_from_statement: string | null;
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
      based_on_version_id: string | null;
      based_on_statement: string | null;
    }>(
      `SELECT o.id AS id, o.current_version_id AS version_id, ov.version_no AS version_no, av.statement AS statement,
              av.state AS state, av.needs_review AS needs_review, a.proposed_by_actor_id AS proposed_by_actor_id,
              av.assessment_actor_id AS assessment_actor_id, av.assessed_at AS assessed_at, av.rationale AS rationale,
              ov.based_on_version_id AS based_on_version_id, bv.statement AS based_on_statement
         FROM objects o
         JOIN assumptions a ON a.project_id = o.project_id AND a.object_id = o.id
         JOIN object_versions ov ON ov.project_id = o.project_id AND ov.id = o.current_version_id
         JOIN assumption_versions av ON av.project_id = o.project_id AND av.version_id = o.current_version_id
         LEFT JOIN assumption_versions bv ON bv.project_id = o.project_id AND bv.version_id = ov.based_on_version_id
        WHERE o.project_id = ? AND o.edition_id = ? AND o.kind = 'assumption' AND o.archived_at IS NULL
        ORDER BY o.display_no`,
      project_id,
      edition_id,
    )
    .map((row) => {
      const revised = row.state === "revised" && row.based_on_version_id !== null && row.based_on_statement !== null;
      return {
        id: row.id,
        version_id: row.version_id,
        version_no: row.version_no.toString(),
        statement: row.statement,
        state: row.state,
        needs_review: row.needs_review === 1n,
        proposed_by_actor_id: row.proposed_by_actor_id,
        proposed_by: actor_dto(db, row.proposed_by_actor_id),
        assessed_by_actor_id: row.assessment_actor_id,
        assessed_by: actor_dto(db, row.assessment_actor_id),
        assessed_at: iso_of(row.assessed_at),
        rationale: row.rationale,
        revised_from_version_id: revised ? row.based_on_version_id : null,
        revised_from_statement: revised ? row.based_on_statement : null,
      };
    });
}

export interface DecisionDto {
  id: string;
  version_id: string;
  version_no: string;
  statement: string;
  state: string;
  scope: string;
  decided_by_actor_id: string | null;
  decided_by: ActorDto | null;
  /** Whoever wrote the first version of the decision; for a copy into a new edition, the original proposer (the chain of parent versions is followed to its first object). */
  proposed_by: ActorDto | null;
  rationale: string;
  supersedes_decision_id: string | null;
  /** The decision that replaced this one, or null. */
  superseded_by: string | null;
  /** Only for a decision copied into a new edition: the parent's version it came from, that version's number, the parent edition's number. */
  originated_from_version_id: string | null;
  originated_from_version_no: string | null;
  originated_from_edition_no: number | null;
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
      first_actor_id: string | null;
      superseded_by: string | null;
      originated_from_version_id: string | null;
      originated_from_version_no: bigint | null;
      originated_from_edition_no: bigint | null;
    }>(
      `SELECT o.id AS id, o.current_version_id AS version_id, ov.version_no AS version_no, dv.statement AS statement,
              dv.state AS state, d.scope AS scope, dv.decided_by AS decided_by, dv.rationale AS rationale,
              dv.supersedes_decision_id AS supersedes_decision_id,
              (WITH RECURSIVE chain(object_id, depth) AS (
                 SELECT o.id, 0
                 UNION ALL
                 SELECT pv2.object_id, chain.depth + 1
                   FROM chain
                   JOIN decisions cd ON cd.project_id = o.project_id AND cd.object_id = chain.object_id
                   JOIN object_versions pv2 ON pv2.project_id = cd.project_id AND pv2.id = cd.originated_from_version_id
                  WHERE chain.depth < 1000
               )
               SELECT fv.actor_id FROM chain
                 JOIN object_versions fv ON fv.project_id = o.project_id AND fv.object_id = chain.object_id AND fv.version_no = 1
                ORDER BY chain.depth DESC LIMIT 1) AS first_actor_id,
              (SELECT r.object_id FROM decision_versions r WHERE r.project_id = o.project_id AND r.supersedes_decision_id = o.id ORDER BY r.rowid LIMIT 1) AS superseded_by,
              d.originated_from_version_id AS originated_from_version_id,
              pv.version_no AS originated_from_version_no,
              pe.edition_no AS originated_from_edition_no
         FROM objects o
         JOIN decisions d ON d.project_id = o.project_id AND d.object_id = o.id
         JOIN object_versions ov ON ov.project_id = o.project_id AND ov.id = o.current_version_id
         JOIN decision_versions dv ON dv.project_id = o.project_id AND dv.version_id = o.current_version_id
         LEFT JOIN object_versions pv ON pv.project_id = d.project_id AND pv.id = d.originated_from_version_id
         LEFT JOIN objects po ON po.project_id = pv.project_id AND po.id = pv.object_id
         LEFT JOIN editions pe ON pe.project_id = po.project_id AND pe.id = po.edition_id
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
      decided_by: actor_dto(db, row.decided_by),
      proposed_by: actor_dto(db, row.first_actor_id),
      rationale: row.rationale,
      supersedes_decision_id: row.supersedes_decision_id,
      superseded_by: row.superseded_by,
      originated_from_version_id: row.originated_from_version_id,
      originated_from_version_no: row.originated_from_version_id === null || row.originated_from_version_no === null ? null : row.originated_from_version_no.toString(),
      originated_from_edition_no: row.originated_from_version_id === null || row.originated_from_edition_no === null ? null : Number(row.originated_from_edition_no),
    }));
}

/** The edition number of an edition id (for the `edition` the record reads answer with). */
export function edition_no_of(db: Db, project_id: string, edition_id: string): number | null {
  const row = db.get<{ edition_no: bigint }>("SELECT edition_no FROM editions WHERE project_id = ? AND id = ?", project_id, edition_id);
  return row === undefined ? null : Number(row.edition_no);
}

/** The id of the edition with this number in the project, or null. */
export function edition_id_by_no(db: Db, project_id: string, edition_no: number): string | null {
  return db.get<{ id: string }>("SELECT id FROM editions WHERE project_id = ? AND edition_no = ?", project_id, edition_no)?.id ?? null;
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

export interface ReflectionFollowupDto {
  id: string;
  kind: string;
  state: string;
  description: string;
  result_version_id: string | null;
}

export interface ReflectionEntryDto {
  id: string;
  source_version_id: string;
  /** The sentence of the source when it is an assumption / decision / message version; null for anything without a sentence. */
  source_text: string | null;
  disposition: string;
  rationale: string;
  result_version_id: string | null;
  followup_id: string | null;
  followup: ReflectionFollowupDto | null;
  applied_tx_id: string | null;
  actor_id: string;
  actor: ActorDto | null;
}

export interface ReflectionRoundDto {
  round_id: string;
  stage: string;
  round_no: number;
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

/** The round of an edition by stage key and round number, or null. */
export function round_id_by_number(db: Db, project_id: string, edition_id: string, stage_key: string, round_no: number): string | null {
  return (
    db.get<{ id: string }>(
      `SELECT r.id AS id FROM rounds r JOIN stages s ON s.project_id = r.project_id AND s.id = r.stage_id
        WHERE r.project_id = ? AND r.edition_id = ? AND s.key = ? AND r.round_no = ?`,
      project_id,
      edition_id,
      stage_key,
      round_no,
    )?.id ?? null
  );
}

/** One round's reflection: the entries still standing (a corrected entry is replaced by the one that supersedes it) and the counts. */
export function reflection_round(db: Db, project_id: string, round_id: string): ReflectionRoundDto {
  const rows = db.all<{
    id: string;
    source_version_id: string;
    disposition: string;
    rationale: string;
    result_version_id: string | null;
    followup_id: string | null;
    applied_tx_id: string | null;
    actor_id: string;
    source_text: string | null;
    fu_kind: string | null;
    fu_state: string | null;
    fu_description: string | null;
    fu_result_version_id: string | null;
  }>(
    `SELECT e.id AS id, e.source_version_id AS source_version_id, e.disposition AS disposition, e.rationale AS rationale,
            e.result_version_id AS result_version_id, e.followup_id AS followup_id, e.applied_tx_id AS applied_tx_id,
            e.actor_id AS actor_id,
            COALESCE(sa.statement, sd.statement, sm.body_md) AS source_text,
            fv.kind AS fu_kind, fv.state AS fu_state, fv.description AS fu_description, fv.result_version_id AS fu_result_version_id
       FROM reflection_entries e
       LEFT JOIN assumption_versions sa ON sa.project_id = e.project_id AND sa.version_id = e.source_version_id
       LEFT JOIN decision_versions sd ON sd.project_id = e.project_id AND sd.version_id = e.source_version_id
       LEFT JOIN message_versions sm ON sm.project_id = e.project_id AND sm.version_id = e.source_version_id
       LEFT JOIN objects fo ON fo.project_id = e.project_id AND fo.id = e.followup_id
       LEFT JOIN followup_versions fv ON fv.project_id = fo.project_id AND fv.version_id = fo.current_version_id
      WHERE e.project_id = ? AND e.target_round_id = ?
        AND NOT EXISTS (SELECT 1 FROM reflection_entries n WHERE n.project_id = e.project_id AND n.supersedes_entry_id = e.id)
      ORDER BY e.rowid`,
    project_id,
    round_id,
  );
  const entries: ReflectionEntryDto[] = rows.map((row) => ({
    id: row.id,
    source_version_id: row.source_version_id,
    source_text: row.source_text,
    disposition: row.disposition,
    rationale: row.rationale,
    result_version_id: row.result_version_id,
    followup_id: row.followup_id,
    followup:
      row.followup_id === null || row.fu_kind === null || row.fu_state === null || row.fu_description === null
        ? null
        : { id: row.followup_id, kind: row.fu_kind, state: row.fu_state, description: row.fu_description, result_version_id: row.fu_result_version_id },
    applied_tx_id: row.applied_tx_id,
    actor_id: row.actor_id,
    actor: actor_dto(db, row.actor_id),
  }));
  const counts = { applied: 0, partial: 0, rejected: 0, deferred: 0 };
  for (const entry of entries) counts[entry.disposition as keyof typeof counts] += 1;
  const place = db.get<{ key: string; round_no: bigint }>(
    "SELECT s.key AS key, r.round_no AS round_no FROM rounds r JOIN stages s ON s.project_id = r.project_id AND s.id = r.stage_id WHERE r.project_id = ? AND r.id = ?",
    project_id,
    round_id,
  );
  return { round_id, stage: place?.key ?? "", round_no: place === undefined ? 0 : Number(place.round_no), submitted: reflection_submitted(db, project_id, round_id), counts, entries };
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

// ---------------------------------------------------------------------------
// SEL-98: the receipt a write left, and one round's form (questions, current answers) and its comment threads.
// Read-only and without a new table: they join the tables the question and answer commands already write.

export interface ReceiptDto {
  receipt_no: string;
  tx_id: string;
  committed_at: string | null;
}

function iso_of_ms(value: bigint): string | null {
  const ms = Number(value);
  return Number.isSafeInteger(ms) && ms >= 0 && ms <= 8.64e15 ? new Date(ms).toISOString() : null;
}

/**
 * The receipt of one commit: its number in the project (1 = the first write, in commit order — the rowid order of mutation_commits,
 * which is append only), the commit id, and the commit time. A commit that is not there has no receipt (null).
 */
export function receipt_of_tx(db: Db, project_id: string, tx_id: string): ReceiptDto | null {
  const row = db.get<{ n: bigint; created_at: bigint }>(
    `SELECT (SELECT COUNT(*) FROM mutation_commits c2
              WHERE c2.project_id = c.project_id AND c2.rowid <= c.rowid) AS n,
            c.created_at AS created_at
       FROM mutation_commits c WHERE c.project_id = ? AND c.id = ?`,
    project_id,
    tx_id,
  );
  if (row === undefined) return null;
  return { receipt_no: row.n.toString(), tx_id, committed_at: iso_of_ms(row.created_at) };
}

/**
 * The receipts of many commits with ONE pass over the project's commits (a read that shows many answers or messages would otherwise
 * count the commits once per receipt). Same numbers as receipt_of_tx: the rank of the commit in rowid order. A tx that is not there
 * is missing from the map.
 */
export function receipts_of_txs(db: Db, project_id: string, tx_ids: ReadonlyArray<string>): Map<string, ReceiptDto> {
  const out = new Map<string, ReceiptDto>();
  const wanted = [...new Set(tx_ids)];
  if (wanted.length === 0) return out;
  const rows = db.all<{ id: string; n: bigint; created_at: bigint }>(
    `SELECT id, n, created_at FROM (
        SELECT id, created_at, ROW_NUMBER() OVER (ORDER BY rowid) AS n FROM mutation_commits WHERE project_id = ?)
      WHERE id IN (SELECT value FROM json_each(?))`,
    project_id,
    JSON.stringify(wanted),
  );
  for (const row of rows) out.set(row.id, { receipt_no: row.n.toString(), tx_id: row.id, committed_at: iso_of_ms(row.created_at) });
  return out;
}

function json_or_null(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The rounds place a request names: "start" (the stage-start questions, round null) or a round number. null = not a place. */
export interface RoundPlace {
  /** the number of the edition the place belongs to (the active edition) — the same number the work space read reports as `edition` */
  edition_no: number;
  stage_id: string;
  stage_key: string;
  /** rounds.id for a numbered round, null for the stage-start place */
  server_round_id: string | null;
  round_no: number | null;
  state: "current" | "closed";
}

export function round_place(db: Db, project_id: string, edition_id: string, stage_key: string, place: string): RoundPlace | null {
  const stage = db.get<{ id: string; key: string; status: string }>(
    "SELECT id, key, status FROM stages WHERE project_id = ? AND edition_id = ? AND key = ?",
    project_id,
    edition_id,
    stage_key,
  );
  if (stage === undefined) return null;
  const edition = db.get<{ edition_no: bigint }>("SELECT edition_no FROM editions WHERE project_id = ? AND id = ?", project_id, edition_id);
  if (edition === undefined) return null;
  const edition_no = Number(edition.edition_no);
  if (place === "start") {
    const rounds = db.all<{ state: string }>("SELECT state FROM rounds WHERE project_id = ? AND stage_id = ?", project_id, stage.id);
    // the same rule as the work space: a stage not started yet (pending, no round) has no stage-start place — unless a form was
    // already published there (the stage-start questions are then the place's content)
    if (stage.status === "pending" && rounds.length === 0) {
      const published = db.get<{ one: bigint }>(
        "SELECT 1 AS one FROM question_sets WHERE project_id = ? AND stage_id = ? AND form_key = 'main' AND round_id IS NULL LIMIT 1",
        project_id,
        stage.id,
      );
      if (published === undefined) return null;
    }
    const open = rounds.some((round) => round.state === "open");
    return { edition_no, stage_id: stage.id, stage_key: stage.key, server_round_id: null, round_no: null, state: stage.status === "asking" && !open ? "current" : "closed" };
  }
  if (!/^[1-9][0-9]{0,14}$/.test(place)) return null;
  const round = db.get<{ id: string; state: string }>(
    "SELECT id, state FROM rounds WHERE project_id = ? AND stage_id = ? AND round_no = ?",
    project_id,
    stage.id,
    Number(place),
  );
  if (round === undefined) return null;
  return { edition_no, stage_id: stage.id, stage_key: stage.key, server_round_id: round.id, round_no: Number(place), state: round.state === "open" ? "current" : "closed" };
}

/** The newest set of the place's form (form_key "main"), or undefined when no form was published there yet. */
export function place_latest_set(db: Db, project_id: string, place: RoundPlace): { id: string; version_no: bigint } | undefined {
  return db.get<{ id: string; version_no: bigint }>(
    `SELECT id, version_no FROM question_sets
      WHERE project_id = ? AND stage_id = ? AND form_key = 'main' AND round_id IS ?
      ORDER BY version_no DESC LIMIT 1`,
    project_id,
    place.stage_id,
    place.server_round_id,
  );
}

interface RoundQuestionRow {
  question_id: string;
  version_id: string;
  version_no: bigint;
  display_no: bigint;
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
  merged_into_question_id: string | null;
  answer_version_id: string | null;
  answer_value: string | null;
  answer_question_version_id: string | null;
  answer_question_version_no: bigint | null;
  answer_used_default: bigint | null;
  answer_state: string | null;
  answer_tx_id: string | null;
}

/**
 * SEL-126: the round's result text — the first `result` object the round was sealed with (round_contents, role 'result'), at its CURRENT
 * version = the latest appended one (version_no max, the unit the annotation version check uses; not the one the seal held). null = no result: the stage-start place, an open round, a round sealed without one. For a
 * non-human caller a current version that carries a file closed to AI is null with no trace (the same rule as every AI read exit).
 * Read only; two queries at most however many results the round holds.
 */
export function round_result_data(db: Db, project_id: string, place: RoundPlace, audience: Audience): { object_id: string; version_id: string; body_md: string } | null {
  if (place.server_round_id === null) return null;
  const row = db.get<{ object_id: string; version_id: string; body_md: string | null }>(
    `SELECT c.object_id AS object_id, ov.id AS version_id, av.body_md AS body_md
       FROM round_contents c
       JOIN object_versions ov ON ov.project_id = c.project_id AND ov.object_id = c.object_id
        AND ov.version_no = (SELECT MAX(v2.version_no) FROM object_versions v2 WHERE v2.project_id = c.project_id AND v2.object_id = c.object_id)
       JOIN artifact_versions av ON av.project_id = ov.project_id AND av.version_id = ov.id
      WHERE c.project_id = ? AND c.round_id = ? AND c.role = 'result'
      ORDER BY c.position, c.object_id LIMIT 1`,
    project_id,
    place.server_round_id,
  );
  if (row === undefined || row.body_md === null) return null;
  if (audience === "ai" && artifact_version_denied(db, project_id, row.version_id)) return null;
  return { object_id: row.object_id, version_id: row.version_id, body_md: row.body_md };
}

export function round_form_data(db: Db, project_id: string, place: RoundPlace): Record<string, unknown> {
  const set = place_latest_set(db, project_id, place);
  const rows =
    set === undefined
      ? []
      : db.all<RoundQuestionRow>(
          `SELECT m.question_id AS question_id, qv.version_id AS version_id, ov.version_no AS version_no, o.display_no AS display_no,
                  qv.text AS text, qv.type AS type, qv.state AS state, qv.importance AS importance, qv.required AS required,
                  qv.allow_comment_as_answer AS allow_comment_as_answer, qv.default_value AS default_value, qv.options AS options,
                  qv.show_if AS show_if, qv.help AS help, qv.merged_into_question_id AS merged_into_question_id,
                  av.version_id AS answer_version_id, av.value AS answer_value, av.question_version_id AS answer_question_version_id,
                  av.used_default AS answer_used_default, av.state AS answer_state, aov.tx_id AS answer_tx_id, qov.version_no AS answer_question_version_no
             FROM question_set_members m
             JOIN objects o ON o.project_id = m.project_id AND o.id = m.question_id AND o.kind = 'question'
             JOIN question_versions qv ON qv.project_id = o.project_id AND qv.version_id = o.current_version_id
             JOIN object_versions ov ON ov.project_id = qv.project_id AND ov.id = qv.version_id
             LEFT JOIN answers a ON a.project_id = m.project_id AND a.object_id = (
                    SELECT MIN(a2.object_id) FROM answers a2 WHERE a2.project_id = m.project_id AND a2.question_id = m.question_id)
             LEFT JOIN objects ao ON ao.project_id = a.project_id AND ao.id = a.object_id
             LEFT JOIN answer_versions av ON av.project_id = ao.project_id AND av.version_id = ao.current_version_id
             LEFT JOIN object_versions aov ON aov.project_id = av.project_id AND aov.id = av.version_id
             LEFT JOIN object_versions qov ON qov.project_id = av.project_id AND qov.id = av.question_version_id
            WHERE m.project_id = ? AND m.set_id = ?
            ORDER BY m.position`,
          project_id,
          set.id,
        );
  const receipts = receipts_of_txs(db, project_id, rows.flatMap((row) => (row.answer_tx_id === null ? [] : [row.answer_tx_id])));
  const questions = rows.map((row) => {
    let answer: Record<string, unknown> | null = null;
    if (row.answer_version_id !== null) {
      const receipt = row.answer_tx_id === null ? null : (receipts.get(row.answer_tx_id) ?? null);
      answer = {
        version_id: row.answer_version_id,
        value: json_or_null(row.answer_value),
        question_version_id: row.answer_question_version_id,
        question_version: row.answer_question_version_no === null ? null : Number(row.answer_question_version_no),
        used_default: row.answer_used_default === null ? false : Number(row.answer_used_default) === 1,
        state: row.answer_state,
        tx_id: receipt?.tx_id ?? null,
        receipt_no: receipt?.receipt_no ?? null,
        committed_at: receipt?.committed_at ?? null,
      };
    }
    return {
      id: row.question_id,
      version_id: row.version_id,
      version_no: row.version_no.toString(),
      state: row.state,
      type: row.type,
      text: row.text,
      required: Number(row.required) === 1,
      allow_comment_as_answer: Number(row.allow_comment_as_answer) === 1,
      importance: row.importance,
      help: row.help,
      default_value: json_or_null(row.default_value),
      options: json_or_null(row.options) ?? [],
      show_if: json_or_null(row.show_if),
      merged_into_question_id: row.merged_into_question_id,
      display_no: Number(row.display_no),
      answer,
    };
  });
  return {
    // the round paths read the ACTIVE edition: the number lets a client that shows another edition see that and not use this data
    edition: place.edition_no,
    stage: place.stage_key,
    round_id: place.round_no,
    server_round_id: place.server_round_id,
    state: place.state,
    set_id: set?.id ?? null,
    form_version: set === undefined ? null : Number(set.version_no),
    questions,
  };
}

interface ThreadRow {
  thread_id: string;
  target_object_id: string;
  target_version_id: string | null;
  context_kind: string;
  target_version_no: bigint | null;
}

interface ThreadMessageRow {
  thread_id: string;
  message_id: string;
  body_md: string;
  created_at: bigint;
  actor_kind: string;
  tx_id: string;
}

/**
 * The comment threads of the questions that ever stood in the place's form (not only those in its newest set), each with its messages in
 * the order they were written. A thread tied to a question reports that question; a "general" thread (context_kind general) that
 * is about one of those questions reports "__other". The free-form notes a migrated project kept (legacy "이전 의견/제안": a general thread whose
 * target is a note, not a question) are NOT in this read — nothing ties such a note to a place of the form.
 */
export function round_threads_data(db: Db, project_id: string, place: RoundPlace): Record<string, unknown> {
  const threads = db.all<ThreadRow>(
    `SELECT t.object_id AS thread_id, t.target_object_id AS target_object_id, t.target_version_id AS target_version_id,
            t.context_kind AS context_kind, tov.version_no AS target_version_no
       FROM threads t
       LEFT JOIN object_versions tov ON tov.project_id = t.project_id AND tov.id = t.target_version_id
      WHERE t.project_id = ? AND t.context_kind IN ('question_comment', 'general')
        AND t.target_object_id IN (
              SELECT m.question_id FROM question_set_members m
                JOIN question_sets s ON s.project_id = m.project_id AND s.id = m.set_id
               WHERE s.project_id = ? AND s.stage_id = ? AND s.form_key = 'main' AND s.round_id IS ?)
      ORDER BY t.rowid`,
    project_id,
    project_id,
    place.stage_id,
    place.server_round_id,
  );
  const message_rows = threads.map((thread) =>
    db.all<ThreadMessageRow>(
      `SELECT m.thread_id AS thread_id, m.object_id AS message_id, mv.body_md AS body_md, first.created_at AS created_at,
              a.kind AS actor_kind, cur.tx_id AS tx_id
         FROM messages m
         JOIN objects mo ON mo.project_id = m.project_id AND mo.id = m.object_id
         JOIN message_versions mv ON mv.project_id = mo.project_id AND mv.version_id = mo.current_version_id
         JOIN object_versions cur ON cur.project_id = mv.project_id AND cur.id = mv.version_id
         JOIN object_versions first ON first.project_id = m.project_id AND first.object_id = m.object_id AND first.version_no = 1
         JOIN actors a ON a.id = first.actor_id
        WHERE m.project_id = ? AND m.thread_id = ? AND mv.state <> 'withdrawn'
        ORDER BY m.rowid`,
      project_id,
      thread.thread_id,
    ),
  );
  // one pass over the project's commits for every message of every thread
  const receipts = receipts_of_txs(db, project_id, message_rows.flatMap((rows) => rows.map((message) => message.tx_id)));
  const out = threads.map((thread, index) => {
    const messages = (message_rows[index] ?? []).map((message) => {
      const first = receipts.get(message.tx_id);
      return {
        message_id: message.message_id,
        body_md: message.body_md,
        at: iso_of_ms(message.created_at),
        by: message.actor_kind === "human" ? "human" : "ai",
        ...(first === undefined ? {} : { receipt_no: first.receipt_no }),
      };
    });
    return {
      thread_id: thread.thread_id,
      question_id: thread.context_kind === "question_comment" ? thread.target_object_id : "__other",
      question_version_id: thread.target_version_id,
      question_version: thread.target_version_no === null ? null : Number(thread.target_version_no),
      messages,
    };
  });
  return { edition: place.edition_no, threads: out };
}

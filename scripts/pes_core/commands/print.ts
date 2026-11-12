// Range print (stage 3 U6a, SEL-119): print.prepare previews a manifest, print.commit fixes one.
//
// A print is a stored, versioned selection of what a round / a stage / an edition holds, kept in the tables that
// already exist: one `snapshots` row (scope round|stage|edition) that points at a manifest blob, and a second blob
// with the printable document. No new table. Printing never seals a round and never touches round_contents.
//
// - print.prepare: reads and writes only a receipt and one event. The manifest it returns has `output: null`.
// - print.commit: in one transaction it stores the output blob (text/html) and the manifest blob (application/json),
//   one snapshot row, the receipt and one event. A failure at any point rolls the rows back, and the bytes this
//   command wrote to the object store are removed again (runtime.on_rollback).
// - A print snapshot is told from a seal / approval / edition snapshot by its `print.committed` event: the
//   manifest blob alone is not trusted for that.
// - The document is built from the manifest's own content only: no clock, no event number, no key. The same
//   selection therefore gives the same bytes, and a stored print is read back, never rebuilt (GET P/print).
//
// Who may run it: any human member of the project (owner, editor, reader). An agent is forbidden.

import { createHash } from "node:crypto";

import { read_credential_actor } from "../actors.ts";
import type { Db } from "../db.ts";
import { ApiError } from "../errors.ts";
import { delete_unclaimed_storage_file, read_ready_blob, sha256_hex, storage_file_is_regular, write_storage_bytes } from "../files.ts";
import { file_ai_denied, material_object_denied } from "./file_access.ts";
import { insert_ready_blob } from "./files.ts";
import { anchor_on_version } from "./thread_reads.ts";
import {
  insert_receipt,
  is_record,
  reject_unknown_fields,
  require_record,
  type CommandDefinition,
  type CommandResult,
  type CommandRuntime,
} from "./shared.ts";

export const PRINT_CATEGORIES = ["body", "table", "footnote", "comment", "assumption", "decision", "reflection"] as const;
type Category = (typeof PRINT_CATEGORIES)[number];
const SCOPES = ["round", "stage", "edition"] as const;
type Scope = (typeof SCOPES)[number];

const PREPARE_FIELDS = ["scope", "round_id", "stage_id", "edition_id", "all_editions", "confirm_volume", "include"] as const;
const COMMIT_FIELDS = [...PREPARE_FIELDS, "selection_hash"] as const;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const STAGE_LABEL: Readonly<Record<string, string>> = {
  plan: "기획",
  research: "조사",
  analyze: "분석",
  write: "집필",
  verify: "검증",
  publish: "산출·공유",
};
const BASIS_LABEL: Readonly<Record<string, string>> = {
  sealed: "봉인된 라운드",
  approved: "승인된 단계",
  open: "열린 라운드(출력 시점)",
  none: "라운드 없음",
};
const ANCHOR_LABEL: Readonly<Record<string, string>> = {
  exact: "제자리",
  moved: "옮겨짐",
  ambiguous: "위치가 여럿",
  lost: "위치를 잃음",
};
const CATEGORY_LABEL: Readonly<Record<string, string>> = {
  assumption: "가정",
  decision: "결정",
  reflection: "반영",
};

function invalid(message: string): never {
  throw new ApiError("invalid_payload", message);
}

// ---------------------------------------------------------------------------
// request

interface PrintRequest {
  scope: Scope;
  round_id: string | null;
  stage_id: string | null;
  edition_id: string | null;
  all_editions: boolean;
  confirm_volume: number | null;
  include: Category[];
  selection_hash: string | null;
}

function optional_id(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()) invalid(`${field} must be a non-empty string`);
  return value;
}

function parse_request(payload: Record<string, unknown>, commit: boolean): PrintRequest {
  reject_unknown_fields(payload, commit ? COMMIT_FIELDS : PREPARE_FIELDS);
  const scope = payload.scope;
  if (typeof scope !== "string" || !(SCOPES as readonly string[]).includes(scope)) {
    invalid('scope must be "round", "stage" or "edition"');
  }
  const picked = scope as Scope;
  const round_id = optional_id(payload, "round_id");
  const stage_id = optional_id(payload, "stage_id");
  const edition_id = optional_id(payload, "edition_id");
  if (picked !== "round" && round_id !== null) invalid("round_id belongs to scope round");
  if (picked !== "stage" && stage_id !== null) invalid("stage_id belongs to scope stage");
  if (picked !== "edition" && edition_id !== null) invalid("edition_id belongs to scope edition");

  const all = payload.all_editions;
  if (all !== undefined && all !== null && typeof all !== "boolean") invalid("all_editions must be true or false");
  const all_editions = all === true;
  if (all_editions && picked !== "edition") invalid("all_editions is only for scope edition");
  if (all_editions && edition_id !== null) invalid("all_editions and edition_id exclude each other");

  const confirm = payload.confirm_volume;
  let confirm_volume: number | null = null;
  if (confirm !== undefined && confirm !== null) {
    if (typeof confirm !== "number" || !Number.isSafeInteger(confirm) || confirm < 0) invalid("confirm_volume must be a non-negative integer");
    if (!all_editions) invalid("confirm_volume belongs to all_editions");
    confirm_volume = confirm;
  }

  let include: Category[] = [...PRINT_CATEGORIES];
  if (payload.include !== undefined && payload.include !== null) {
    const raw = payload.include;
    if (!Array.isArray(raw) || raw.length === 0) invalid("include must be a non-empty list of categories");
    for (const entry of raw) {
      if (typeof entry !== "string" || !(PRINT_CATEGORIES as readonly string[]).includes(entry)) invalid("include has an unknown category");
    }
    include = PRINT_CATEGORIES.filter((category) => (raw as string[]).includes(category));
  }

  let selection_hash: string | null = null;
  if (commit && payload.selection_hash !== undefined && payload.selection_hash !== null) {
    if (typeof payload.selection_hash !== "string" || !SHA256_HEX.test(payload.selection_hash)) invalid("selection_hash must be 64 lowercase hexadecimal characters");
    selection_hash = payload.selection_hash;
  }
  return { scope: picked, round_id, stage_id, edition_id, all_editions, confirm_volume, include, selection_hash };
}

// ---------------------------------------------------------------------------
// manifest

interface StageEntry {
  stage_id: string;
  stage_key: string;
  round_id: string | null;
  round_no: number | null;
  basis: "sealed" | "approved" | "open" | "none";
  basis_snapshot_id: string | null;
}

interface Target {
  edition_id: string;
  edition_no: number;
  stages: StageEntry[];
}

type Item = Record<string, string | number | null>;

export interface PrintManifest {
  format_version: "1.0";
  kind: "print";
  scope: Scope;
  all_editions: boolean;
  include: Category[];
  targets: Target[];
  items: Item[];
  excluded: Array<Record<string, string>>;
  /** the comment entries of `items` again (the same objects), and whether comments were chosen */
  comments: { included: boolean; items: Item[] };
  output: { blob_id: string; sha256: string; size: number; media_type: "text/html" } | null;
}

interface Footnote {
  no: number;
  title: string;
  url: string | null;
  quote: string | null;
}
interface CommentView {
  thread_id: string;
  thread_state: string;
  /** the anchored quote, and where the anchor stands in the printed version (null for a thread without an anchor) */
  quote: string | null;
  anchor_status: string | null;
  body: string;
  reply: boolean;
}
interface Article {
  category: "body" | "table";
  position: number;
  title: string;
  body: string;
  footnotes: Footnote[];
  comments: CommentView[];
}
interface StageView {
  edition_no: number;
  stage_key: string;
  round_no: number | null;
  basis: StageEntry["basis"];
  articles: Article[];
  reflections: Array<{ disposition: string; rationale: string }>;
}
interface RecordView {
  statement: string;
  state: string;
  rationale: string;
}

interface Built {
  manifest: PrintManifest;
  stages: StageView[];
  assumptions: RecordView[];
  decisions: RecordView[];
  volume: { editions: number; stages: number; items: number; bytes: number };
  selection_hash: string;
  content_hash: string;
  snapshot: { edition_id: string; stage_id: string | null; round_id: string | null };
}

interface EditionRow {
  id: string;
  edition_no: bigint;
  current_stage_id: string | null;
}
interface StageRow {
  id: string;
  edition_id: string;
  key: string;
  status: string;
  current_round_id: string | null;
  approved_snapshot_id: string | null;
}
interface RoundRow {
  id: string;
  edition_id: string;
  stage_id: string;
  round_no: bigint;
  state: string;
  sealed_snapshot_id: string | null;
}
interface Candidate {
  object_id: string;
  version_id: string;
  kind: string;
  title: string;
  body_md: string | null;
  body_blob_id: string | null;
  status: string;
  /** the object's archived time (open basis only; a pinned round content has none). */
  archived_at: bigint | null;
}

/** Deterministic JSON (sorted keys) used for the selection hash. */
function canonical_json(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonical_json(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical_json(record[key])}`)
    .join(",")}}`;
}

export function selection_hash_of(manifest: PrintManifest): string {
  const { output: _output, ...rest } = manifest;
  return createHash("sha256").update(canonical_json(rest), "utf8").digest("hex");
}

function content_hash_of(items: Item[]): string {
  const text = items
    .map((item) => JSON.stringify([item.category, item.object_id ?? item.entry_id, item.version_id ?? item.source_version_id]))
    .join("\n");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function find_edition(db: Db, project_id: string, id: string): EditionRow {
  const row = db.get<EditionRow>("SELECT id, edition_no, current_stage_id FROM editions WHERE project_id = ? AND id = ?", project_id, id);
  if (row === undefined) throw new ApiError("not_found", "edition not found");
  return row;
}

function active_edition(db: Db, project_id: string): EditionRow {
  const project = db.get<{ active_edition_id: string | null }>("SELECT active_edition_id FROM projects WHERE id = ?", project_id);
  if (project === undefined || project.active_edition_id === null) throw new ApiError("conflict", "the project has no active edition");
  return find_edition(db, project_id, project.active_edition_id);
}

function stages_of(db: Db, project_id: string, edition_id: string): StageRow[] {
  return db.all<StageRow>(
    `SELECT id, edition_id, key, status, current_round_id, approved_snapshot_id
       FROM stages WHERE project_id = ? AND edition_id = ? ORDER BY ordinal`,
    project_id,
    edition_id,
  );
}

function find_stage(db: Db, project_id: string, id: string): StageRow {
  const row = db.get<StageRow>(
    "SELECT id, edition_id, key, status, current_round_id, approved_snapshot_id FROM stages WHERE project_id = ? AND id = ?",
    project_id,
    id,
  );
  if (row === undefined) throw new ApiError("not_found", "stage not found");
  return row;
}

function find_round(db: Db, project_id: string, id: string): RoundRow {
  const row = db.get<RoundRow>(
    "SELECT id, edition_id, stage_id, round_no, state, sealed_snapshot_id FROM rounds WHERE project_id = ? AND id = ?",
    project_id,
    id,
  );
  if (row === undefined) throw new ApiError("not_found", "round not found");
  return row;
}

/** Which round a stage prints, and on what basis. `forced` is the round a round-scope print names. */
function stage_entry(db: Db, project_id: string, stage: StageRow, forced: RoundRow | null): StageEntry {
  const entry = (round: RoundRow | null, basis: StageEntry["basis"], basis_snapshot_id: string | null): StageEntry => ({
    stage_id: stage.id,
    stage_key: stage.key,
    round_id: round?.id ?? null,
    round_no: round === null ? null : Number(round.round_no),
    basis,
    basis_snapshot_id,
  });
  if (forced === null && stage.status === "approved" && stage.approved_snapshot_id !== null) {
    const approved = db.get<{ round_id: string | null }>("SELECT round_id FROM snapshots WHERE project_id = ? AND id = ?", project_id, stage.approved_snapshot_id);
    if (approved !== undefined && approved.round_id !== null) {
      return entry(find_round(db, project_id, approved.round_id), "approved", stage.approved_snapshot_id);
    }
  }
  const round = forced ?? (stage.current_round_id === null ? null : find_round(db, project_id, stage.current_round_id));
  if (round === null) return entry(null, "none", null);
  if (round.state === "sealed" && round.sealed_snapshot_id !== null) return entry(round, "sealed", round.sealed_snapshot_id);
  return entry(round, "open", null);
}

function resolve_targets(db: Db, project_id: string, request: PrintRequest): Target[] {
  const target_of = (edition: EditionRow, stages: StageEntry[]): Target => ({ edition_id: edition.id, edition_no: Number(edition.edition_no), stages });
  if (request.scope === "round") {
    let round: RoundRow;
    if (request.round_id !== null) round = find_round(db, project_id, request.round_id);
    else {
      const edition = active_edition(db, project_id);
      const stage = edition.current_stage_id === null ? undefined : find_stage(db, project_id, edition.current_stage_id);
      if (stage === undefined || stage.current_round_id === null) throw new ApiError("not_found", "the current stage has no round");
      round = find_round(db, project_id, stage.current_round_id);
    }
    const stage = find_stage(db, project_id, round.stage_id);
    return [target_of(find_edition(db, project_id, round.edition_id), [stage_entry(db, project_id, stage, round)])];
  }
  if (request.scope === "stage") {
    let stage: StageRow;
    if (request.stage_id !== null) stage = find_stage(db, project_id, request.stage_id);
    else {
      const edition = active_edition(db, project_id);
      if (edition.current_stage_id === null) throw new ApiError("not_found", "the edition has no current stage");
      stage = find_stage(db, project_id, edition.current_stage_id);
    }
    return [target_of(find_edition(db, project_id, stage.edition_id), [stage_entry(db, project_id, stage, null)])];
  }
  const editions = request.all_editions
    ? db.all<EditionRow>("SELECT id, edition_no, current_stage_id FROM editions WHERE project_id = ? ORDER BY edition_no", project_id)
    : [request.edition_id === null ? active_edition(db, project_id) : find_edition(db, project_id, request.edition_id)];
  if (editions.length === 0) throw new ApiError("conflict", "the project has no edition");
  return editions.map((edition) => target_of(edition, stages_of(db, project_id, edition.id).map((stage) => stage_entry(db, project_id, stage, null))));
}

const CANDIDATE_COLUMNS = `a.kind AS kind, av.title AS title, av.body_md AS body_md, av.body_blob_id AS body_blob_id, av.status AS status`;
const CANDIDATE_OPEN_COLUMNS = `${CANDIDATE_COLUMNS}, o.archived_at AS archived_at`;
const CANDIDATE_PINNED_COLUMNS = `${CANDIDATE_COLUMNS}, NULL AS archived_at`;

function candidates_of(db: Db, project_id: string, entry: StageEntry): Candidate[] {
  if (entry.round_id === null) return [];
  if (entry.basis === "open") {
    return db.all<Candidate>(
      `SELECT o.id AS object_id, o.current_version_id AS version_id, ${CANDIDATE_OPEN_COLUMNS}
         FROM artifacts a
         JOIN objects o ON o.project_id = a.project_id AND o.id = a.object_id
         JOIN artifact_versions av ON av.project_id = o.project_id AND av.version_id = o.current_version_id
        WHERE a.project_id = ? AND a.stage_id = ?
        ORDER BY o.display_no`,
      project_id,
      entry.stage_id,
    );
  }
  return db.all<Candidate>(
    `SELECT rc.object_id AS object_id, rc.version_id AS version_id, ${CANDIDATE_PINNED_COLUMNS}
       FROM round_contents rc
       JOIN artifacts a ON a.project_id = rc.project_id AND a.object_id = rc.object_id
       JOIN artifact_versions av ON av.project_id = rc.project_id AND av.version_id = rc.version_id
      WHERE rc.project_id = ? AND rc.round_id = ?
      ORDER BY rc.position`,
    project_id,
    entry.round_id,
  );
}

/**
 * The text of a printed body. A body kept as a file (body_blob_id) must be read whole and match its recorded sha256 and size
 * (the same rule as every other read of a blob, files.ts read_ready_blob). A missing, not ready, unreadable or changed file
 * refuses the print: a fixed print never stands in an empty or wrong body for one it could not read.
 */
function body_text(runtime: CommandRuntime, project_id: string, candidate: Candidate): string {
  if (candidate.body_md !== null) return candidate.body_md;
  if (candidate.body_blob_id === null) return "";
  const unreadable = (): never => {
    throw new ApiError("conflict", "a printed body file cannot be read", { reason: "print_body_unreadable", version_id: candidate.version_id });
  };
  if (runtime.objects_dir === null) unreadable();
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(read_ready_blob(runtime.db, runtime.objects_dir as string, project_id, candidate.body_blob_id).bytes);
  } catch {
    return unreadable();
  }
}

interface ThreadRow {
  thread_id: string;
  thread_version_id: string;
  context_kind: string;
  anchor_id: string | null;
  state: string;
  archived_at: bigint | null;
}
interface MessageRow {
  message_id: string;
  message_version_id: string;
  body_md: string;
  state: string;
  reply_to: string | null;
}
interface AnchorRow {
  id: string;
  exact_quote: string;
  prefix: string;
  suffix: string;
  start_cp: bigint | null;
  target_object_id: string;
  target_version_id: string;
}

/**
 * The comments (SEL-99 threads and their messages) on one printed article, pinned at print time: each thread's current version
 * and each message's current version, and where the thread's anchor stands in the PRINTED version (exact / moved / ambiguous /
 * lost — a lost anchor is shown, never hidden). An archived thread and a withdrawn message are recorded in excluded instead.
 */
function article_comments(
  db: Db,
  project_id: string,
  article: { object_id: string; version_id: string; stage_id: string; body: string | null },
  items: Item[],
  excluded: Array<Record<string, string>>,
): CommentView[] {
  const views: CommentView[] = [];
  for (const thread of db.all<ThreadRow>(
    `SELECT t.object_id AS thread_id, o.current_version_id AS thread_version_id, t.context_kind AS context_kind,
            t.anchor_id AS anchor_id, tv.state AS state, o.archived_at AS archived_at
       FROM threads t
       JOIN objects o ON o.project_id = t.project_id AND o.id = t.object_id
       JOIN thread_versions tv ON tv.project_id = o.project_id AND tv.version_id = o.current_version_id
      WHERE t.project_id = ? AND t.target_object_id = ?
      ORDER BY o.display_no, o.id`,
    project_id,
    article.object_id,
  )) {
    if (thread.state === "archived" || thread.archived_at !== null) {
      excluded.push({ category: "comment", reason: "archived", object_id: thread.thread_id, version_id: thread.thread_version_id });
      continue;
    }
    const anchor =
      thread.anchor_id === null
        ? undefined
        : db.get<AnchorRow>(
            "SELECT id, exact_quote, prefix, suffix, start_cp, target_object_id, target_version_id FROM anchors WHERE project_id = ? AND id = ?",
            project_id,
            thread.anchor_id,
          );
    const anchor_status = anchor === undefined ? null : anchor_on_version(db, project_id, anchor, article.version_id, article.body).status;
    for (const message of db.all<MessageRow>(
      `SELECT m.object_id AS message_id, o.current_version_id AS message_version_id, mv.body_md AS body_md, mv.state AS state, m.reply_to AS reply_to
         FROM messages m
         JOIN objects o ON o.project_id = m.project_id AND o.id = m.object_id
         JOIN message_versions mv ON mv.project_id = o.project_id AND mv.version_id = o.current_version_id
        WHERE m.project_id = ? AND m.thread_id = ?
        ORDER BY m.rowid`,
      project_id,
      thread.thread_id,
    )) {
      if (message.state === "withdrawn") {
        excluded.push({ category: "comment", reason: "withdrawn", object_id: message.message_id, version_id: message.message_version_id });
        continue;
      }
      const reply = views.some((view) => view.thread_id === thread.thread_id);
      items.push({
        category: "comment",
        object_id: message.message_id,
        version_id: message.message_version_id,
        thread_id: thread.thread_id,
        thread_version_id: thread.thread_version_id,
        thread_state: thread.state,
        context_kind: thread.context_kind,
        reply_to: message.reply_to,
        anchor_id: anchor?.id ?? null,
        anchor_status,
        target_object_id: article.object_id,
        target_version_id: article.version_id,
        stage_id: article.stage_id,
        position: items.length,
      });
      views.push({ thread_id: thread.thread_id, thread_state: thread.state, quote: anchor?.exact_quote ?? null, anchor_status, body: message.body_md, reply });
    }
  }
  return views;
}

function build(runtime: CommandRuntime, project_id: string, request: PrintRequest): Built {
  const db = runtime.db;
  const targets = resolve_targets(db, project_id, request);
  const wants = new Set<string>(request.include);

  const bodies: Item[] = [];
  const tables: Item[] = [];
  const footnotes: Item[] = [];
  const reflections: Item[] = [];
  const comments: Item[] = [];
  const comment_excluded: Array<Record<string, string>> = [];
  const drafts: Array<Record<string, string>> = [];
  const dropped: Array<Record<string, string>> = [];
  const stages: StageView[] = [];
  let bytes = 0;

  for (const target of targets) {
    for (const entry of target.stages) {
      const view: StageView = { edition_no: target.edition_no, stage_key: entry.stage_key, round_no: entry.round_no, basis: entry.basis, articles: [], reflections: [] };
      stages.push(view);
      let position = 0;
      for (const candidate of candidates_of(db, project_id, entry)) {
        const category = candidate.kind === "table" ? "table" : "body";
        // removed / archived: recorded with the reason, unless the whole category was not chosen (not_selected comes first)
        const dropped_reason = candidate.status === "removed" ? "removed" : candidate.status === "archived" || candidate.archived_at !== null ? "archived" : null;
        if (dropped_reason !== null) {
          if (wants.has(category)) dropped.push({ category, reason: dropped_reason, object_id: candidate.object_id, version_id: candidate.version_id });
          continue;
        }
        if (candidate.status === "draft") {
          drafts.push({ category: "unsubmitted_draft", reason: "unsubmitted", object_id: candidate.object_id, version_id: candidate.version_id });
          continue;
        }
        // a footnote is printed with its article: no body/table category, no footnote item
        if (!wants.has(category)) continue;
        const at = position;
        position += 1;
        const notes: Footnote[] = [];
        for (const citation of db.all<{ citation_no: bigint; source_object_id: string; source_version_id: string; title: string; url: string | null; quote: string | null }>(
          `SELECT c.citation_no AS citation_no, sv.object_id AS source_object_id, c.source_version_id AS source_version_id,
                  sv.title AS title, sv.url AS url, c.quote AS quote
             FROM citations c
             JOIN source_versions sv ON sv.project_id = c.project_id AND sv.version_id = c.source_version_id
            WHERE c.project_id = ? AND c.artifact_version_id = ?
            ORDER BY c.citation_no`,
          project_id,
          candidate.version_id,
        )) {
          if (wants.has("footnote")) {
            footnotes.push({
              category: "footnote",
              object_id: citation.source_object_id,
              version_id: citation.source_version_id,
              stage_id: entry.stage_id,
              position: footnotes.length,
              cited_by_version_id: candidate.version_id,
              citation_no: Number(citation.citation_no),
            });
            notes.push({ no: Number(citation.citation_no), title: citation.title, url: citation.url, quote: citation.quote });
          }
        }
        const item: Item = { category, object_id: candidate.object_id, version_id: candidate.version_id, stage_id: entry.stage_id, position: at };
        (category === "table" ? tables : bodies).push(item);
        const body = body_text(runtime, project_id, candidate);
        bytes += Buffer.byteLength(candidate.title, "utf8") + Buffer.byteLength(body, "utf8");
        const article_notes = wants.has("comment")
          ? article_comments(
              db,
              project_id,
              { object_id: candidate.object_id, version_id: candidate.version_id, stage_id: entry.stage_id, body: candidate.body_md === null && candidate.body_blob_id === null ? null : body },
              comments,
              comment_excluded,
            )
          : [];
        for (const note of article_notes) bytes += Buffer.byteLength(note.body, "utf8");
        view.articles.push({ category, position: at, title: candidate.title, body, footnotes: notes, comments: article_notes });
      }
      if (wants.has("reflection") && entry.round_id !== null) {
        for (const row of db.all<{ id: string; source_version_id: string; disposition: string; rationale: string }>(
          `SELECT e.id AS id, e.source_version_id AS source_version_id, e.disposition AS disposition, e.rationale AS rationale
             FROM reflection_entries e
            WHERE e.project_id = ? AND e.target_round_id = ?
              AND NOT EXISTS (SELECT 1 FROM reflection_entries n WHERE n.project_id = e.project_id AND n.supersedes_entry_id = e.id)
            ORDER BY e.rowid`,
          project_id,
          entry.round_id,
        )) {
          reflections.push({
            category: "reflection",
            entry_id: row.id,
            source_version_id: row.source_version_id,
            round_id: entry.round_id,
            stage_id: entry.stage_id,
            position: reflections.length,
          });
          view.reflections.push({ disposition: row.disposition, rationale: row.rationale });
          bytes += Buffer.byteLength(row.rationale, "utf8");
        }
      }
    }
  }

  // assumptions and decisions: the whole edition (or editions), pinned at their current version at print time
  const edition_ids = targets.map((target) => target.edition_id);
  const marks = edition_ids.map(() => "?").join(", ");
  const assumptions: Item[] = [];
  const assumption_views: RecordView[] = [];
  if (wants.has("assumption")) {
    for (const row of db.all<{ object_id: string; version_id: string; statement: string; state: string; rationale: string; archived_at: bigint | null }>(
      `SELECT o.id AS object_id, o.current_version_id AS version_id, av.statement AS statement, av.state AS state, av.rationale AS rationale, o.archived_at AS archived_at
         FROM objects o
         JOIN assumption_versions av ON av.project_id = o.project_id AND av.version_id = o.current_version_id
        WHERE o.project_id = ? AND o.kind = 'assumption' AND o.edition_id IN (${marks})
        ORDER BY o.display_no`,
      project_id,
      ...edition_ids,
    )) {
      if (row.archived_at !== null) {
        dropped.push({ category: "assumption", reason: "archived", object_id: row.object_id, version_id: row.version_id });
        continue;
      }
      assumptions.push({ category: "assumption", object_id: row.object_id, version_id: row.version_id, stage_id: null, position: assumptions.length });
      assumption_views.push({ statement: row.statement, state: row.state, rationale: row.rationale });
      bytes += Buffer.byteLength(row.statement, "utf8");
    }
  }
  const decisions: Item[] = [];
  const decision_views: RecordView[] = [];
  if (wants.has("decision")) {
    for (const row of db.all<{ object_id: string; version_id: string; statement: string; state: string; rationale: string; archived_at: bigint | null }>(
      `SELECT o.id AS object_id, o.current_version_id AS version_id, dv.statement AS statement, dv.state AS state, dv.rationale AS rationale, o.archived_at AS archived_at
         FROM objects o
         JOIN decisions d ON d.project_id = o.project_id AND d.object_id = o.id
         JOIN decision_versions dv ON dv.project_id = o.project_id AND dv.version_id = o.current_version_id
        WHERE o.project_id = ? AND o.kind = 'decision'
          AND (o.edition_id IN (${marks}) OR d.scope = 'project')
        ORDER BY o.display_no`,
      project_id,
      ...edition_ids,
    )) {
      if (row.archived_at !== null) {
        dropped.push({ category: "decision", reason: "archived", object_id: row.object_id, version_id: row.version_id });
        continue;
      }
      decisions.push({ category: "decision", object_id: row.object_id, version_id: row.version_id, stage_id: null, position: decisions.length });
      decision_views.push({ statement: row.statement, state: row.state, rationale: row.rationale });
      bytes += Buffer.byteLength(row.statement, "utf8");
    }
  }

  const items = [...bodies, ...tables, ...footnotes, ...comments, ...assumptions, ...decisions, ...reflections];
  const excluded: Array<Record<string, string>> = [];
  for (const category of PRINT_CATEGORIES) {
    if (!wants.has(category)) excluded.push({ category, reason: "not_selected" });
  }
  excluded.push(...dropped);
  excluded.push(...comment_excluded);
  excluded.push(...drafts);
  excluded.push({ category: "token_stream", reason: "default_excluded" });

  const manifest: PrintManifest = {
    format_version: "1.0",
    kind: "print",
    scope: request.scope,
    all_editions: request.all_editions,
    include: request.include,
    targets,
    items,
    excluded,
    comments: { included: wants.has("comment"), items: comments },
    output: null,
  };

  const first = targets[0];
  const last = targets[targets.length - 1];
  if (first === undefined || last === undefined) throw new Error("a print has at least one target");
  let snapshot: Built["snapshot"];
  if (request.scope === "round") {
    snapshot = { edition_id: first.edition_id, stage_id: first.stages[0]?.stage_id ?? null, round_id: first.stages[0]?.round_id ?? null };
  } else if (request.scope === "stage") {
    snapshot = { edition_id: first.edition_id, stage_id: first.stages[0]?.stage_id ?? null, round_id: null };
  } else {
    const active = db.get<{ active_edition_id: string | null }>("SELECT active_edition_id FROM projects WHERE id = ?", project_id);
    const named = targets.find((target) => target.edition_id === active?.active_edition_id);
    snapshot = { edition_id: (named ?? last).edition_id, stage_id: null, round_id: null };
  }

  return {
    manifest,
    stages,
    assumptions: assumption_views,
    decisions: decision_views,
    volume: { editions: targets.length, stages: targets.reduce((sum, target) => sum + target.stages.length, 0), items: items.length, bytes },
    selection_hash: selection_hash_of(manifest),
    content_hash: content_hash_of(items),
    snapshot,
  };
}

// ---------------------------------------------------------------------------
// document

function escape_html(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function paragraphs(text: string): string {
  const clean = text.replace(/\r\n?/g, "\n").trim();
  if (clean.length === 0) return "";
  return clean
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escape_html(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

function record_section(title: string, rows: RecordView[]): string {
  if (rows.length === 0) return "";
  const list = rows
    .map((row) => `<li><p>${escape_html(row.statement)}</p><p class="meta">상태: ${escape_html(row.state)}${row.rationale.length > 0 ? ` · 근거: ${escape_html(row.rationale)}` : ""}</p></li>`)
    .join("\n");
  return `<section class="records"><h2>${title}</h2>\n<ol>\n${list}\n</ol></section>`;
}

/** The printable document: built only from what the manifest names, so the same selection gives the same bytes. */
function render_html(built: Built): string {
  const parts: string[] = [];
  let edition_no = -1;
  for (const stage of built.stages) {
    if (stage.edition_no !== edition_no) {
      edition_no = stage.edition_no;
      parts.push(`<h1>판 ${edition_no}</h1>`);
    }
    const label = STAGE_LABEL[stage.stage_key] ?? stage.stage_key;
    const round = stage.round_no === null ? "" : ` · 라운드 ${stage.round_no}`;
    const articles = [...stage.articles].sort((a, b) => a.position - b.position);
    const reflections = stage.reflections;
    if (articles.length === 0 && reflections.length === 0) continue;
    parts.push(`<section class="stage"><h2>${escape_html(label)}${round} <small>${BASIS_LABEL[stage.basis] ?? stage.basis}</small></h2>`);
    for (const article of articles) {
      const notes = article.footnotes
        .map((note) => {
          const link = note.url === null ? "" : ` ${escape_html(note.url)}`;
          const quote = note.quote === null || note.quote.length === 0 ? "" : ` — “${escape_html(note.quote)}”`;
          return `<li value="${note.no}">${escape_html(note.title)}${link}${quote}</li>`;
        })
        .join("\n");
      const comments = article.comments
        .map((comment) => {
          const where =
            comment.quote === null ? "" : `<q>${escape_html(comment.quote)}</q> <small>${ANCHOR_LABEL[comment.anchor_status ?? ""] ?? escape_html(comment.anchor_status ?? "")}</small> `;
          const state = comment.thread_state === "resolved" ? " <small>해결됨</small>" : "";
          return `<li${comment.reply ? ' class="reply"' : ""}>${comment.reply ? "" : where}${paragraphs(comment.body)}${comment.reply ? "" : state}</li>`;
        })
        .join("\n");
      parts.push(
        `<article class="${article.category}"><h3>${escape_html(article.title)}</h3>\n${paragraphs(article.body)}${
          notes.length > 0 ? `\n<ol class="footnotes">\n${notes}\n</ol>` : ""
        }${comments.length > 0 ? `\n<section class="comments"><h4>첨언</h4>\n<ul>\n${comments}\n</ul></section>` : ""}</article>`,
      );
    }
    if (reflections.length > 0) {
      const rows = reflections.map((row) => `<li>${escape_html(row.disposition)} — ${escape_html(row.rationale)}</li>`).join("\n");
      parts.push(`<section class="reflections"><h3>${CATEGORY_LABEL.reflection}</h3>\n<ul>\n${rows}\n</ul></section>`);
    }
    parts.push("</section>");
  }
  parts.push(record_section(CATEGORY_LABEL.assumption as string, built.assumptions));
  parts.push(record_section(CATEGORY_LABEL.decision as string, built.decisions));
  const body = parts.filter((part) => part.length > 0).join("\n");
  return [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    "<title>인쇄본</title>",
    "<style>body{font-family:serif;line-height:1.6;margin:2rem auto;max-width:42rem}small,.meta{color:#555}article,section{break-inside:avoid-page}</style>",
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// commands

function require_human_member(runtime: CommandRuntime): string {
  const actor_id = runtime.actor_id;
  const project = runtime.project;
  if (actor_id === null || project === null) throw new Error("a print command must resolve a project and actor first");
  const actor = read_credential_actor(runtime.db, actor_id);
  if (actor === undefined || actor.kind !== "human") {
    throw new ApiError("forbidden", "only a person who can read the project may print it");
  }
  return actor_id;
}

function run_prepare(runtime: CommandRuntime): CommandResult {
  const actor_id = require_human_member(runtime);
  const project = runtime.project;
  if (project === null) throw new Error("unreachable");
  const request = parse_request(require_record(runtime.payload), false);
  const built = build(runtime, project.id, request);
  const result = {
    project_id: project.id,
    scope: request.scope,
    manifest: built.manifest,
    selection_hash: built.selection_hash,
    volume: built.volume,
    confirm_required: request.all_editions,
  };
  insert_receipt(runtime, { project_id: project.id, actor_id, action: "print.prepared", base_control_rev: null, result });
  return {
    result,
    events: [{ type: "print.prepared", payload: { scope: request.scope, all_editions: request.all_editions, selection_hash: built.selection_hash, volume: built.volume } }],
  };
}

/**
 * One ready blob row plus its bytes in the object store; a file this call wrote is removed again if the command fails.
 * The removal runs after the ROLLBACK, so it re-checks under the write lock that no blob row (another connection's print of
 * the same bytes, committed in between) now claims the file (files.ts delete_unclaimed_storage_file).
 */
function put_blob(runtime: CommandRuntime, project_id: string, actor_id: string, bytes: Uint8Array, media_type: string, name: string): string {
  const objects_dir = runtime.objects_dir;
  if (objects_dir === null) throw new ApiError("conflict", "no object store is configured");
  const on_rollback = runtime.on_rollback;
  if (on_rollback === undefined) throw new Error("print.commit needs the service's rollback hook");
  const sha256 = sha256_hex(bytes);
  const blob = insert_ready_blob(runtime, { project_id, actor_id, sha256, size: bytes.byteLength, media_type, original_name: name });
  const row = runtime.db.get<{ storage_key: string; state: string }>("SELECT storage_key, state FROM blobs WHERE project_id = ? AND id = ?", project_id, blob.blob_id);
  if (row === undefined || row.state !== "ready") throw new ApiError("conflict", "an equal blob exists but is not ready");
  if (!storage_file_is_regular(objects_dir, project_id, row.storage_key)) {
    write_storage_bytes(objects_dir, project_id, row.storage_key, bytes);
    const db = runtime.db;
    on_rollback(() => delete_unclaimed_storage_file(db, objects_dir, project_id, row.storage_key));
  }
  return blob.blob_id;
}

function run_commit(runtime: CommandRuntime): CommandResult {
  const actor_id = require_human_member(runtime);
  const project = runtime.project;
  if (project === null) throw new Error("unreachable");
  const request = parse_request(require_record(runtime.payload), true);
  const built = build(runtime, project.id, request);
  if (request.all_editions && request.confirm_volume !== built.volume.items) {
    invalid("all_editions needs confirm_volume equal to the previewed volume.items");
  }
  if (request.selection_hash !== null && request.selection_hash !== built.selection_hash) {
    throw new ApiError("conflict", "the content moved since the preview", { reason: "selection_changed" });
  }

  const html = new TextEncoder().encode(render_html(built));
  const output_blob_id = put_blob(runtime, project.id, actor_id, html, "text/html", "print.html");
  const manifest: PrintManifest = {
    ...built.manifest,
    output: { blob_id: output_blob_id, sha256: sha256_hex(html), size: html.byteLength, media_type: "text/html" },
  };
  const manifest_blob_id = put_blob(runtime, project.id, actor_id, new TextEncoder().encode(JSON.stringify(manifest)), "application/json", "print-manifest.json");

  const snapshot_id = runtime.new_id();
  const result = {
    project_id: project.id,
    snapshot_id,
    scope: request.scope,
    manifest_blob_id,
    output_blob_id,
    content_hash: built.content_hash,
    selection_hash: built.selection_hash,
  };
  insert_receipt(runtime, { project_id: project.id, actor_id, action: "print.committed", base_control_rev: null, result });
  const last = runtime.db.get<{ n: bigint | null }>("SELECT max(event_seq) AS n FROM events WHERE project_id = ?", project.id);
  const written = runtime.db.run(
    `INSERT INTO snapshots
       (id, project_id, edition_id, stage_id, round_id, scope, manifest_blob_id, through_event_seq, control_rev, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    snapshot_id,
    project.id,
    built.snapshot.edition_id,
    built.snapshot.stage_id,
    built.snapshot.round_id,
    request.scope,
    manifest_blob_id,
    last?.n === null || last === undefined ? null : Number(last.n),
    Number(project.control_rev),
    built.content_hash,
  );
  if (written.changes !== 1n) throw new Error("the print snapshot was not written");
  return {
    result,
    events: [{ type: "print.committed", payload: { snapshot_id, scope: request.scope, manifest_blob_id, output_blob_id } }],
  };
}

function definition(action: string, run: (runtime: CommandRuntime) => CommandResult): CommandDefinition {
  return Object.freeze({ action, scope: "project", rev_bearing: false, run });
}

/** Registry entries merged into COMMANDS by commands.ts. */
export const PRINT_COMMAND_ENTRIES: ReadonlyArray<readonly [string, CommandDefinition]> = Object.freeze([
  Object.freeze(["print.prepare", definition("print.prepared", run_prepare)] as const),
  Object.freeze(["print.commit", definition("print.committed", run_commit)] as const),
]);

// ---------------------------------------------------------------------------
// reads (GET P/print): stored prints only

export interface PrintSnapshotRow {
  id: string;
  scope: string;
  edition_id: string;
  stage_id: string | null;
  round_id: string | null;
  manifest_blob_id: string;
  content_hash: string;
}

const PRINT_SNAPSHOT_COLUMNS = "s.id AS id, s.scope AS scope, s.edition_id AS edition_id, s.stage_id AS stage_id, s.round_id AS round_id, s.manifest_blob_id AS manifest_blob_id, s.content_hash AS content_hash";
const PRINTED_EVENT = `JOIN events e ON e.project_id = s.project_id AND e.type = 'print.committed' AND json_extract(e.payload, '$.snapshot_id') = s.id`;

/**
 * A stored print of this scope: the named snapshot, or the newest print of the current round / stage / edition.
 * Only a snapshot that a print.committed event names counts; a seal, approval or edition snapshot is not a print.
 * Pure SELECTs.
 */
export function find_print_snapshot(db: Pick<Db, "get">, project_id: string, scope: Scope, snapshot_id: string | null): PrintSnapshotRow | undefined {
  if (snapshot_id !== null) {
    return db.get<PrintSnapshotRow>(
      `SELECT ${PRINT_SNAPSHOT_COLUMNS} FROM snapshots s ${PRINTED_EVENT}
        WHERE s.project_id = ? AND s.id = ? AND s.scope = ?`,
      project_id,
      snapshot_id,
      scope,
    );
  }
  const edition = db.get<{ id: string; current_stage_id: string | null }>(
    `SELECT e.id AS id, e.current_stage_id AS current_stage_id
       FROM projects p JOIN editions e ON e.project_id = p.id AND e.id = p.active_edition_id WHERE p.id = ?`,
    project_id,
  );
  if (edition === undefined) return undefined;
  let where = "s.edition_id = ?";
  let place: string = edition.id;
  if (scope !== "edition") {
    if (edition.current_stage_id === null) return undefined;
    if (scope === "stage") {
      where = "s.stage_id = ?";
      place = edition.current_stage_id;
    } else {
      const stage = db.get<{ current_round_id: string | null }>("SELECT current_round_id FROM stages WHERE project_id = ? AND id = ?", project_id, edition.current_stage_id);
      if (stage === undefined || stage.current_round_id === null) return undefined;
      where = "s.round_id = ?";
      place = stage.current_round_id;
    }
  }
  return db.get<PrintSnapshotRow>(
    `SELECT ${PRINT_SNAPSHOT_COLUMNS} FROM snapshots s ${PRINTED_EVENT}
      WHERE s.project_id = ? AND s.scope = ? AND ${where}
      ORDER BY e.event_seq DESC LIMIT 1`,
    project_id,
    scope,
    place,
  );
}

export function is_print_scope(value: unknown): value is Scope {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

/** Narrow a parsed manifest blob: it must be a print manifest that names its output. */
export function print_output_of(manifest: unknown): { blob_id: string; sha256: string; size: number; media_type: string } | null {
  if (!is_record(manifest) || manifest.kind !== "print" || !is_record(manifest.output)) return null;
  const output = manifest.output;
  if (typeof output.blob_id !== "string" || typeof output.sha256 !== "string" || typeof output.size !== "number" || typeof output.media_type !== "string") return null;
  return { blob_id: output.blob_id, sha256: output.sha256, size: output.size, media_type: output.media_type };
}

// ---------------------------------------------------------------------------
// the AI view of a stored print (GET P/print by a caller that is not human)
//
// A stored print is a human's fixed document: it names every cited source (title, quote) and every body. SEL-115 closes a
// material to AI at every exit with ONE decision (material_object_denied / file_ai_denied), and GET P/print is such an exit.
// The fixed bytes cannot be edited, so a non-human caller never gets them when the decision closes anything the print carries:
// no output, no document, and a manifest without the closed items. A print that carries nothing closed is returned whole.

export interface PrintAiView {
  /** The manifest the caller may see. The very same object when nothing in the print is closed. */
  manifest: unknown;
  /** True when the print carries something closed to AI: the caller must not be given `output` or the document. */
  withheld: boolean;
}

/** True when this artifact version carries a file closed to AI (its body file, or a file attached to the version). */
function artifact_version_denied(db: Pick<Db, "all" | "get">, project_id: string, version_id: string): boolean {
  const body = db.get<{ body_blob_id: string | null }>("SELECT body_blob_id FROM artifact_versions WHERE project_id = ? AND version_id = ?", project_id, version_id);
  if (body?.body_blob_id != null && file_ai_denied(db, project_id, body.body_blob_id)) return true;
  return db
    .all<{ blob_id: string }>("SELECT blob_id FROM version_files WHERE project_id = ? AND version_id = ?", project_id, version_id)
    .some((row) => file_ai_denied(db, project_id, row.blob_id));
}

/** True when this object version (any kind) belongs to a closed file material, or is an artifact version that carries a closed file. */
function version_denied(db: Pick<Db, "all" | "get">, project_id: string, version_id: string): boolean {
  const owner = db.get<{ object_id: string }>("SELECT object_id FROM object_versions WHERE project_id = ? AND id = ?", project_id, version_id);
  if (owner !== undefined && material_object_denied(db, project_id, owner.object_id)) return true;
  return artifact_version_denied(db, project_id, version_id);
}

/**
 * Drop from a stored print manifest what a non-human caller may not see, with the same decision as every other AI exit
 * (SEL-115 material_object_denied / file_ai_denied), over EVERY material reference the manifest carries:
 *   - a body / table whose version carries a closed file, with the footnotes and comments it carries;
 *   - a footnote whose source is a closed material (object unit);
 *   - a reflection whose source version belongs to a closed material or carries a closed file;
 *   - an excluded entry (removed / archived / draft / thread …) that names a closed material or a version carrying a closed file.
 * What stays is renumbered so that no gap in `position` / `citation_no` counts what was dropped. `withheld` is true when a
 * printed item was dropped (the fixed document then carries closed content). Dropping only excluded entries (which are not in
 * the document) changes the manifest but keeps the document.
 */
export function print_ai_view(db: Pick<Db, "all" | "get">, project_id: string, manifest: unknown): PrintAiView {
  if (!is_record(manifest) || !Array.isArray(manifest.items) || !Array.isArray(manifest.excluded)) return { manifest, withheld: true };
  const items = manifest.items as Array<Record<string, unknown>>;
  const excluded = manifest.excluded as Array<Record<string, unknown>>;
  const closed_versions = new Set<string>();
  for (const item of items) {
    if ((item.category === "body" || item.category === "table") && typeof item.version_id === "string" && artifact_version_denied(db, project_id, item.version_id)) {
      closed_versions.add(item.version_id);
    }
  }
  const kept = items.filter((item) => {
    switch (item.category) {
      case "body":
      case "table":
        return !(typeof item.version_id === "string" && closed_versions.has(item.version_id));
      case "footnote":
        if (typeof item.cited_by_version_id === "string" && closed_versions.has(item.cited_by_version_id)) return false;
        return !(typeof item.object_id === "string" && material_object_denied(db, project_id, item.object_id));
      case "comment":
        return !(typeof item.target_version_id === "string" && closed_versions.has(item.target_version_id));
      case "reflection":
        return !(typeof item.source_version_id === "string" && version_denied(db, project_id, item.source_version_id));
      default:
        return true;
    }
  });
  const kept_excluded = excluded.filter((entry) => {
    if (typeof entry.object_id === "string" && material_object_denied(db, project_id, entry.object_id)) return false;
    return !(typeof entry.version_id === "string" && version_denied(db, project_id, entry.version_id));
  });
  if (kept.length === items.length && kept_excluded.length === excluded.length) return { manifest, withheld: false };
  if (kept.length === items.length) return { manifest: { ...manifest, excluded: kept_excluded }, withheld: false };

  const per_stage = new Map<string, number>();
  const per_citing = new Map<string, number>();
  const out = kept.map((item) => ({ ...item }));
  const articles = out
    .filter((item) => item.category === "body" || item.category === "table")
    .sort((a, b) => Number(a.position) - Number(b.position));
  for (const item of articles) {
    const stage = String(item.stage_id);
    const at = per_stage.get(stage) ?? 0;
    per_stage.set(stage, at + 1);
    item.position = at;
  }
  const counters = new Map<string, number>();
  for (const item of out) {
    if (item.category === "body" || item.category === "table") continue;
    const category = String(item.category);
    if (category === "footnote" || category === "comment" || category === "reflection") {
      const at = counters.get(category) ?? 0;
      counters.set(category, at + 1);
      item.position = at;
    }
    if (category === "footnote") {
      const citing = String(item.cited_by_version_id);
      const no = (per_citing.get(citing) ?? 0) + 1;
      per_citing.set(citing, no);
      item.citation_no = no;
    }
  }
  const comments = is_record(manifest.comments)
    ? { ...manifest.comments, items: out.filter((item) => item.category === "comment") }
    : manifest.comments;
  return { manifest: { ...manifest, items: out, excluded: kept_excluded, comments, output: null }, withheld: true };
}

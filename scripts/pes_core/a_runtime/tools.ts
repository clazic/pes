// The tools the built-in runner offers a model (stage 2 PR19): a closed allowlist of PES commands.
//
// There is no file, shell or network tool, and the list is frozen. Whatever a model asks for that is not on it
// is answered with an error and nothing else happens. The model never supplies a run id, lease or fence: the
// runner adds them, so a model cannot write under someone else's lease.

import type { CommandService, MutationContext } from "../commands.ts";
import { ai_material_rows } from "../commands/file_access.ts";
import { ai_thread_row, open_annotation_threads, thread_quote_closed, thread_reply_route, type ThreadQuoteDependency } from "../commands/thread_reads.ts";
import type { Db } from "../db.ts";
import { ApiError } from "../errors.ts";
import { decide, list_references, read_reference, reference_caller, reference_row, type ReferenceContent } from "../references.ts";
import type { ToolCall, ToolResult, ToolSpec } from "./formats.ts";

/** At most this many allowed materials are handed to the model by context.get. */
const MATERIALS_MAX = 50;

export const A_TOOL_ALLOWLIST: readonly string[] = Object.freeze([
  "context.get",
  "result.submit",
  "question.ask",
  "assumption.propose",
  "decision.propose",
  "reflection.write",
  "thread.reply",
  "followup.propose",
]);

const TEXT_ARG = {
  type: "object",
  properties: { title: { type: "string" }, text: { type: "string" } },
  required: ["text"],
};

export const TOOL_SPECS: readonly ToolSpec[] = Object.freeze([
  {
    name: "context.get",
    description:
      // kept as short as before SEL-113: the spec goes out with every request (a few words of the other descriptions were cut in
      // SEL-124 to pay for threads_offset); how to read a reference is said in the reply itself, and only when there is one
      "Read the project, stage, round, objects, materials, questions.",
    parameters: { type: "object", properties: { reference_id: { type: "string" }, references_offset: { type: "integer" }, threads_offset: { type: "integer" } } },
  },
  {
    name: "result.submit",
    description: "Append versions to existing artifacts. Item: op=append_version, object_id, title, summary, body_md.",
    parameters: {
      type: "object",
      properties: { results: { type: "array", items: { type: "object", properties: { op: { type: "string" }, object_id: { type: "string" }, title: { type: "string" } }, required: ["op", "object_id"] } } },
      required: ["results"],
    },
  },
  {
    name: "question.ask",
    description: "Ask the person questions and wait. Question: text, type, required, options.",
    parameters: { type: "object", properties: { questions: { type: "array", items: { type: "object" } } }, required: ["questions"] },
  },
  { name: "assumption.propose", description: "Propose an assumption for a person to review.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  {
    name: "decision.propose",
    description: "Propose a decision. Only a person adopts.",
    parameters: { type: "object", properties: { text: { type: "string" }, scope: { type: "string", enum: ["project", "edition"] } }, required: ["text"] },
  },
  {
    name: "reflection.write",
    description:
      "Write the round reflection. Entry: source_version_id, disposition, rationale; applied/partial add result_version_id, evidence_tx_id.",
    parameters: { type: "object", properties: { entries: { type: "array", items: { type: "object" } } }, required: ["entries"] },
  },
  {
    name: "thread.reply",
    description: "Reply in a comment thread.",
    parameters: { type: "object", properties: { thread_id: { type: "string" }, text: { type: "string" }, reply_to: { type: "string" } }, required: ["thread_id", "text"] },
  },
  {
    name: "followup.propose",
    description: "Propose a follow-up (thread_id: of that thread). edit_text: proposed_body_md; next_round_task/reopen_stage: target_stage_id.",
    parameters: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        text: { type: "string" },
        kind: { type: "string", enum: ["edit_text", "next_round_task", "reopen_stage", "none"] },
        proposed_body_md: { type: "string" },
        target_stage_id: { type: "string" },
      },
      required: ["text"],
    },
  },
]);

const RESULT_TEXT_MAX = 4000;
/**
 * The context reply (context.get with no reference_id) is built object by object inside this JSON budget — topic, stage,
 * round, then questions, objects and the reference rows — so it is always whole JSON: what does not fit is counted in
 * context.omitted, and the rest of the reference list is read with references_offset (context.references_page.next_offset).
 */
const CONTEXT_TEXT_MAX = RESULT_TEXT_MAX;
/** A text field of the context frame (the topic) or of a row (a reference label) longer than this is cut, never the JSON. */
const CONTEXT_FIELD_MAX = 300;
/**
 * A reference read is the point of its call: it gets a larger reply. The reply is built item by item inside this length
 * budget (JSON characters), so it is always valid JSON: a long text field is cut at REFERENCE_FIELD_MAX and named in the
 * item's truncated_fields, and items that do not fit are left out and counted in omitted_items (content.truncated = true).
 */
const REFERENCE_TEXT_MAX = 60_000;
const REFERENCE_FIELD_MAX = 12_000;
const REFERENCE_ITEMS_MAX = 40;
const NOTE_LABEL: Record<string, string> = {
  "followup.propose": "[AI 제안: 후속 작업]",
};

export interface RunHandle {
  project_id: string;
  actor_id: string;
  run_id: string;
  lease_id: string;
  fence: number;
  stage_id: string | null;
  round_id: string | null;
}

export interface ToolEnv {
  service: CommandService;
  db: Db;
  run: RunHandle;
  /** Prefix of every client_request_id this call's tools use (unique per model call). */
  request_key: string;
  save_retries: number;
}

export type ToolEffect =
  | { kind: "none" }
  | { kind: "wait"; question_set_id: string }
  | { kind: "version"; version_id: string };

export interface ToolOutcome {
  result: ToolResult;
  effect: ToolEffect;
  /**
   * Set when the result carries the content of a reference. The runner keeps the result in its history and sends it again
   * with every later request, so it decides again (recheck_reference) before each request and right before the HTTP call;
   * a withdrawal stops the run (reference_withdrawn).
   */
  reference_read?: { reference_id: string };
  /**
   * Set when the result carries anchor quotes of comment threads (SEL-124 F1): what each quote hangs on. Kept and judged again by the
   * runner exactly like reference_read (thread_quote_withdrawn); a quote now closed to the AI stops the run (reference_withdrawn).
   */
  thread_quotes?: ThreadQuoteDependency[];
}

/** The answer could not be saved after every retry; the model call it came from must be kept as unknown. */
export class SaveFailedError extends Error {
  override name = "SaveFailedError";
  constructor() {
    super("the answer could not be saved");
  }
}

function clip(text: string, max: number = RESULT_TEXT_MAX): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function ok(call: ToolCall, body: unknown, effect: ToolEffect = { kind: "none" }, max: number = RESULT_TEXT_MAX): ToolOutcome {
  return { result: { call_id: call.id, name: call.name, content: clip(JSON.stringify({ ok: true, ...(body as object) }), max), is_error: false }, effect };
}

/** The text fields of an item that are cut at REFERENCE_FIELD_MAX. */
const REFERENCE_FIELDS = ["body_md", "summary", "quote", "title"] as const;

/**
 * Keep a reference's content to a size the model can take. Items are added one at a time while the whole reply
 * ({ok, reference, content}) stays within `budget` JSON characters; the first item that does not fit and every item after
 * it are counted in omitted_items. No JSON text is ever cut: the result is an object that still serializes whole.
 */
function bounded_reference_content(reference: unknown, content: ReferenceContent | null, budget: number = REFERENCE_TEXT_MAX): unknown {
  if (content === null) return null;
  // what the reply costs before any item: the frame, the reference row, the status map and the truncation marks
  const frame = JSON.stringify({ ok: true, reference, content: { items: [], items_status: content.items_status, truncated: true, omitted_items: content.items.length } }).length;
  let left = budget - frame;
  const items: Array<Record<string, unknown>> = [];
  let field_cut = false;
  for (const raw of content.items) {
    if (items.length >= REFERENCE_ITEMS_MAX) break;
    const item: Record<string, unknown> = { ...raw };
    const cut: string[] = [];
    for (const field of REFERENCE_FIELDS) {
      const value = item[field];
      if (typeof value === "string" && value.length > REFERENCE_FIELD_MAX) {
        item[field] = value.slice(0, REFERENCE_FIELD_MAX);
        cut.push(field);
      }
    }
    if (cut.length > 0) item["truncated_fields"] = cut;
    const cost = JSON.stringify(item).length + 1; // + the comma
    if (cost > left) break;
    left -= cost;
    items.push(item);
    if (cut.length > 0) field_cut = true;
  }
  const omitted = content.items.length - items.length;
  if (omitted === 0 && !field_cut) return { items, items_status: content.items_status };
  return { items, items_status: content.items_status, truncated: true, omitted_items: omitted };
}

/** A reference reply: bounded content, and an error (never a cut-off string) if the whole reply still does not fit. */
function reference_ok(call: ToolCall, read: { reference: unknown; content: ReferenceContent | null }): ToolOutcome {
  const text = JSON.stringify({ ok: true, reference: read.reference, content: bounded_reference_content(read.reference, read.content) });
  if (text.length > REFERENCE_TEXT_MAX) return refused(call, "the reference reply is too large to give; read fewer items");
  const id = (read.reference as { id?: unknown }).id;
  return {
    result: { call_id: call.id, name: call.name, content: text, is_error: false },
    effect: { kind: "none" },
    ...(read.content !== null && typeof id === "string" ? { reference_read: { reference_id: id } } : {}),
  };
}

/** Why a reference read may no longer be given to the model: decide()'s withheld reason, or no permission / gone. */
export type WithdrawnReason = "no_permission" | "detached" | "actor_forbidden" | "source_missing" | "source_go_off" | "project_go_off" | "ai_denied";

/**
 * Decide again, with the same decide() as every other exit, whether a reference read earlier in this run may still be sent
 * to the model. null = it may; otherwise the reason it is withdrawn. Pure reads.
 */
export function recheck_reference(db: Pick<Db, "get" | "all">, run: RunHandle, reference_id: string): WithdrawnReason | null {
  const row = reference_row(db, run.project_id, reference_id);
  if (row === undefined) return "detached";
  let caller;
  try {
    caller = reference_caller(db, run.actor_id, true);
  } catch {
    return "actor_forbidden";
  }
  const d = decide(db, row, caller);
  if (!d.has_access) return "no_permission";
  if (d.content_allowed) return null;
  return d.delivery.withheld_reason ?? "source_missing";
}

/**
 * A comment-thread quote this run was given, judged again (SEL-124 F1) with the same decision that built the context row
 * (thread_quote_closed: the anchor, its object, the version it was made on, the version it stands on now and the one it stood on when
 * the quote was given). "ai_denied" when the quote may no longer go to the model. Pure reads: no await.
 */
export function thread_quote_withdrawn(db: Pick<Db, "get" | "all">, run: RunHandle, dep: ThreadQuoteDependency): WithdrawnReason | null {
  return thread_quote_closed(db, run.project_id, dep).closed ? "ai_denied" : null;
}

function refused(call: ToolCall, message: string): ToolOutcome {
  return { result: { call_id: call.id, name: call.name, content: clip(JSON.stringify({ ok: false, error: message })), is_error: true }, effect: { kind: "none" } };
}

function ctx_of(env: ToolEnv, key: string): MutationContext {
  return { project_id: env.run.project_id, actor_id: env.run.actor_id, via: "cli", client_request_id: key };
}

function args_record(call: ToolCall): Record<string, unknown> | null {
  const args = call.args;
  return args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// context.get

interface ObjectRow {
  object_id: string;
  version_id: string;
  title: string;
  summary: string;
}

interface QuestionRow {
  set_id: string;
  question_id: string;
  text: string;
  type: string;
}

/** What the model may know about the work, as plain JSON text (bounded). */
export function build_context(db: Pick<Db, "get" | "all">, run: RunHandle): Record<string, unknown> {
  const project = db.get<{ topic: string }>("SELECT topic FROM projects WHERE id = ?", run.project_id);
  const stage =
    run.stage_id === null
      ? undefined
      : db.get<{ key: string; edition_id: string }>("SELECT key, edition_id FROM stages WHERE project_id = ? AND id = ?", run.project_id, run.stage_id);
  const round =
    run.round_id === null
      ? undefined
      : db.get<{ round_no: bigint }>("SELECT round_no FROM rounds WHERE project_id = ? AND id = ?", run.project_id, run.round_id);
  const objects =
    stage === undefined
      ? []
      : db.all<ObjectRow>(
          `SELECT o.id AS object_id, o.current_version_id AS version_id, av.title AS title, substr(av.summary, 1, 300) AS summary
             FROM objects o
             JOIN artifact_versions av ON av.project_id = o.project_id AND av.version_id = o.current_version_id
            WHERE o.project_id = ? AND o.edition_id = ? AND o.kind = 'artifact' AND o.archived_at IS NULL
            ORDER BY o.display_no LIMIT 30`,
          run.project_id,
          stage.edition_id,
        );
  return {
    topic: project?.topic ?? null,
    stage: stage?.key ?? null,
    round_no: round === undefined ? null : Number(round.round_no),
    objects: objects.map((row) => ({ object_id: row.object_id, version_id: row.version_id, title: row.title, summary: row.summary })),
    // SEL-115: the user's own materials, allowed files only — the same rule (commands/file_access.ts) the HTTP API and MCP use.
    materials: ai_material_rows(db, run.project_id, MATERIALS_MAX),
    questions: question_context(db, run),
    // reference material: rows only (name, pinned snapshot, items, whether the text may be given to an AI) — the text is read with reference_id
    references: list_references(db, run.project_id, reference_caller(db, run.actor_id, true)),
  };
}

function cut_text(value: unknown): unknown {
  return typeof value === "string" && value.length > CONTEXT_FIELD_MAX ? value.slice(0, CONTEXT_FIELD_MAX) : value;
}

/** A reference row in the context list: a label longer than CONTEXT_FIELD_MAX is cut and named, so one row always fits a page. */
function context_reference_row(row: Record<string, unknown>): Record<string, unknown> {
  const label = row["source_label"];
  if (typeof label !== "string" || label.length <= CONTEXT_FIELD_MAX) return row;
  return { ...row, source_label: label.slice(0, CONTEXT_FIELD_MAX), truncated_fields: ["source_label"] };
}

/** Said in the context reply only when there is a reference (the tool spec stays short: it goes out with every request). */
const REFERENCES_HELP = "call context.get with reference_id to read one reference";
/** Said in the context reply only when there is an open comment thread (SEL-124 R3; the tool specs stay as they are). */
const THREADS_HELP = "to answer a thread call thread.reply with thread_id = threads[].id";

/** What one context.get returns: everything from the start, or one list's next page (references or open comment threads). */
type ContextPage = { kind: "all" } | { kind: "references" | "threads"; offset: number };

/**
 * context.get without reference_id. page "all": the whole context (frame, questions, objects, the reference list and the open comment
 * threads from the start). page "references" / "threads" with offset n: the next page of that list only. Built object by object inside
 * CONTEXT_TEXT_MAX; the JSON is never cut. context.references_page / threads_page = {offset, returned, total, next_offset} (left out when
 * there is none); when anything is left out, context.truncated = true, context.omitted = {questions, objects, materials (when any),
 * references, threads (when any)} and context.next says how to read on. The threads (SEL-124: the open annotation threads, last
 * activity first) are filled last, after every other list, so a context without threads keeps its sizes exactly.
 */
function context_ok(call: ToolCall, db: Pick<Db, "get" | "all">, run: RunHandle, page: ContextPage): ToolOutcome {
  const whole = page.kind === "all";
  const full = build_context(db, run);
  const all_refs = (full["references"] as Array<Record<string, unknown>>).map(context_reference_row);
  const all_threads = page.kind === "references" ? [] : open_annotation_threads(db, run.project_id, CONTEXT_FIELD_MAX);
  const start = page.kind === "references" ? page.offset : 0;
  const thread_start = page.kind === "threads" ? page.offset : 0;
  const questions = whole ? (full["questions"] as unknown[]) : [];
  const objects = whole ? (full["objects"] as unknown[]) : [];
  // SEL-115: the allowed materials only (build_context already drops a denied file) — first page only, left out when there is none
  const materials = whole ? (full["materials"] as unknown[]) : [];
  const frame: Record<string, unknown> = whole ? { topic: cut_text(full["topic"]), stage: full["stage"], round_no: full["round_no"] } : {};
  const kept = { questions: [] as unknown[], objects: [] as unknown[], materials: [] as unknown[], references: [] as unknown[], threads: [] as unknown[] };
  // the cost of the reply before any list entry, with every mark at its widest
  const total = page.kind === "threads" ? 0 : all_refs.length;
  const thread_total = all_threads.length;
  const has_threads = page.kind !== "references" && !(thread_total === 0 && thread_start === 0);
  const next_text = (refs: number | null, threads: number | null): string =>
    [
      ...(refs === null ? [] : [`call context.get with references_offset: ${refs} for the next page of references`]),
      ...(threads === null ? [] : [`call context.get with threads_offset: ${threads} for the next page of threads`]),
    ].join("; ");
  const marks = {
    truncated: true,
    omitted: { questions: questions.length, objects: objects.length, materials: materials.length, references: total, ...(has_threads ? { threads: thread_total } : {}) },
    next: next_text(page.kind === "threads" ? null : total, has_threads ? thread_total : null),
    ...(page.kind === "threads" ? {} : { references_page: { offset: start, returned: total, total, next_offset: total }, references_help: REFERENCES_HELP }),
    ...(has_threads ? { threads_page: { offset: thread_start, returned: thread_total, total: thread_total, next_offset: thread_total }, threads_help: THREADS_HELP } : {}),
  };
  let left =
    CONTEXT_TEXT_MAX -
    JSON.stringify({ ok: true, context: { ...frame, questions: [], objects: [], materials: [], references: [], ...(has_threads ? { threads: [] } : {}), ...marks } }).length;
  let full_stop = false;
  const take = (entry: unknown, into: unknown[]): boolean => {
    const cost = JSON.stringify(entry).length + 1; // + the comma
    if (cost > left) {
      full_stop = true;
      return false;
    }
    left -= cost;
    into.push(entry);
    return true;
  };
  const fill = (list: unknown[], into: unknown[]): void => {
    for (const entry of list) {
      if (full_stop || !take(entry, into)) return;
    }
  };
  fill(questions, kept.questions);
  fill(objects, kept.objects);
  fill(materials, kept.materials);
  fill(start >= total ? [] : all_refs.slice(start), kept.references);
  // the thread rows are read one by one (their anchors are judged only for the rows that are given); the quotes given are what the
  // runner must judge again before every later request (SEL-124 F1)
  const quotes: ThreadQuoteDependency[] = [];
  if (has_threads) {
    for (const thread of all_threads.slice(thread_start)) {
      if (full_stop) break;
      let built = ai_thread_row(db, run.project_id, thread, CONTEXT_FIELD_MAX);
      // F2: a threads-only page always moves on. Its first row, when it does not fit as it is (the JSON of a short text can be many
      // times longer: control characters), is cut shorter until it does — named in truncated_fields — so next_offset never stays put.
      if (page.kind === "threads" && kept.threads.length === 0 && JSON.stringify(built.row).length + 1 > left) {
        for (let max = CONTEXT_FIELD_MAX >> 1; max >= 0 && JSON.stringify(built.row).length + 1 > left; max = max === 0 ? -1 : max >> 1) {
          built = ai_thread_row(db, run.project_id, thread, max);
        }
      }
      if (!take(built.row, kept.threads)) break;
      if (built.dependency !== null) quotes.push(built.dependency);
    }
  }
  const returned = kept.references.length;
  const after = Math.min(start, total) + returned;
  const next_offset = after < total ? after : null;
  const threads_returned = kept.threads.length;
  const threads_after = Math.min(thread_start, thread_total) + threads_returned;
  const threads_next = has_threads && threads_after < thread_total ? threads_after : null;
  const omitted = {
    questions: questions.length - kept.questions.length,
    objects: objects.length - kept.objects.length,
    ...(materials.length === 0 ? {} : { materials: materials.length - kept.materials.length }),
    references: total - after,
    ...(has_threads ? { threads: thread_total - threads_after } : {}),
  };
  const cut = omitted.questions > 0 || omitted.objects > 0 || (omitted.materials ?? 0) > 0 || next_offset !== null || threads_next !== null;
  const context: Record<string, unknown> = {
    ...frame,
    ...(whole ? { questions: kept.questions, objects: kept.objects } : {}),
    ...(materials.length === 0 ? {} : { materials: kept.materials }),
    // no reference at all: neither the empty list nor the page line is given (they would only add length to every later request)
    ...(page.kind === "threads" || (total === 0 && start === 0)
      ? {}
      : {
          references: kept.references,
          references_page: { offset: start, returned, total, next_offset },
          references_help: REFERENCES_HELP,
        }),
    // no open comment thread at all: no threads field either (same rule)
    ...(has_threads
      ? {
          threads: kept.threads,
          threads_page: { offset: thread_start, returned: threads_returned, total: thread_total, next_offset: threads_next },
          ...(threads_returned > 0 ? { threads_help: THREADS_HELP } : {}),
        }
      : {}),
    ...(cut
      ? {
          truncated: true,
          omitted: page.kind === "threads" ? { threads: omitted.threads } : omitted,
          ...(next_offset === null && threads_next === null ? {} : { next: next_text(next_offset, threads_next) }),
        }
      : {}),
  };
  const text = JSON.stringify({ ok: true, context });
  if (text.length > CONTEXT_TEXT_MAX) return refused(call, "the context reply is too large to give");
  return { result: { call_id: call.id, name: call.name, content: text, is_error: false }, effect: { kind: "none" }, ...(quotes.length > 0 ? { thread_quotes: quotes } : {}) };
}

/** Questions of this stage/round with the people's answers (what a resumed run must see again). */
export function question_context(db: Pick<Db, "get" | "all">, run: RunHandle): Array<Record<string, unknown>> {
  if (run.stage_id === null) return [];
  const rows = db.all<QuestionRow>(
    `SELECT qs.id AS set_id, m.question_id AS question_id, qv.text AS text, qv.type AS type
       FROM question_sets qs
       JOIN question_set_members m ON m.project_id = qs.project_id AND m.set_id = qs.id
       JOIN question_versions qv ON qv.project_id = m.project_id AND qv.object_id = m.question_id AND qv.version_id = m.question_version_id
      WHERE qs.project_id = ? AND qs.stage_id = ? AND ${run.round_id === null ? "qs.round_id IS NULL" : "qs.round_id = ?"}
      ORDER BY qs.published_at, qs.rowid, m.position LIMIT 40`,
    ...(run.round_id === null ? [run.project_id, run.stage_id] : [run.project_id, run.stage_id, run.round_id]),
  );
  return rows.map((row) => {
    const answer = db.get<{ value: string; state: string }>(
      `SELECT av.value AS value, av.state AS state
         FROM answers a
         JOIN objects ao ON ao.project_id = a.project_id AND ao.id = a.object_id
         JOIN answer_versions av ON av.project_id = a.project_id AND av.version_id = ao.current_version_id
        WHERE a.project_id = ? AND a.question_id = ?`,
      run.project_id,
      row.question_id,
    );
    return {
      question_id: row.question_id,
      text: row.text,
      type: row.type,
      answer: answer === undefined ? null : { state: answer.state, value: JSON.parse(answer.value) as unknown },
    };
  });
}

// ---------------------------------------------------------------------------
// the tool runner

async function execute_with_retries(env: ToolEnv, command: string, key: string, payload: unknown): Promise<unknown> {
  let attempt = 0;
  for (;;) {
    try {
      const outcome = await env.service.execute(ctx_of(env, key), command, payload);
      return outcome.result;
    } catch (error) {
      // A PES refusal is the answer (the model is told); only an unexpected failure is retried, with the same
      // request key so a retry can never write twice.
      if (error instanceof ApiError) throw error;
      attempt += 1;
      if (attempt > env.save_retries) throw new SaveFailedError();
    }
  }
}

function note_text(call: ToolCall, args: Record<string, unknown>): string | null {
  const text = args["text"];
  if (typeof text !== "string" || text.trim().length === 0) return null;
  const title = typeof args["title"] === "string" && args["title"].trim().length > 0 ? `${args["title"].trim()}\n` : "";
  return `${NOTE_LABEL[call.name] ?? ""}\n${title}${text.trim()}`.slice(0, 8000);
}

/** The lease of the run: a thread command is written under it (an agent may comment or propose only while it holds the lease). */
function lease_of(env: ToolEnv): { run_id: string; lease_id: string; fence: number } {
  return { run_id: env.run.run_id, lease_id: env.run.lease_id, fence: env.run.fence };
}

/** A plain note (a follow-up without a thread): the older behaviour of followup.propose. */
async function write_note(env: ToolEnv, call: ToolCall, args: Record<string, unknown>, key: string): Promise<ToolOutcome> {
  const text = note_text(call, args);
  if (text === null) return refused(call, "text must be a non-empty string");
  const stage_key =
    env.run.stage_id === null
      ? undefined
      : env.db.get<{ key: string }>("SELECT key FROM stages WHERE project_id = ? AND id = ?", env.run.project_id, env.run.stage_id)?.key;
  const out = (await execute_with_retries(env, "project.add_note", key, {
    text,
    ...(stage_key === undefined ? {} : { stage: stage_key }),
  })) as { object_id: string };
  return ok(call, { recorded_as: out.object_id });
}

/**
 * Run one tool call. A name outside the allowlist, bad arguments or a PES refusal come back as an error result
 * for the model; the loop goes on. Only an unsaveable answer throws (SaveFailedError).
 */
export async function run_tool(env: ToolEnv, call: ToolCall, index: number): Promise<ToolOutcome> {
  if (!A_TOOL_ALLOWLIST.includes(call.name)) return refused(call, "this tool is not available");
  if (call.args_error !== undefined) return refused(call, call.args_error);
  const args = args_record(call);
  if (args === null) return refused(call, "the arguments must be a JSON object");
  const key = `${env.request_key}:tool:${index}`;

  try {
    switch (call.name) {
      case "context.get": {
        const reference_id = args["reference_id"];
        const offset = args["references_offset"];
        const threads_offset = args["threads_offset"];
        if (reference_id !== undefined && (offset !== undefined || threads_offset !== undefined)) return refused(call, "give reference_id or an offset, not both");
        if (offset !== undefined && threads_offset !== undefined) return refused(call, "give references_offset or threads_offset, not both");
        const whole_number = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
        if (offset !== undefined) {
          if (!whole_number(offset)) return refused(call, "references_offset must be a whole number of 0 or more");
          return context_ok(call, env.db, env.run, { kind: "references", offset });
        }
        if (threads_offset !== undefined) {
          if (!whole_number(threads_offset)) return refused(call, "threads_offset must be a whole number of 0 or more");
          return context_ok(call, env.db, env.run, { kind: "threads", offset: threads_offset });
        }
        if (reference_id !== undefined) {
          if (typeof reference_id !== "string" || reference_id.length === 0) return refused(call, "reference_id must be a non-empty string");
          // the same decision as the HTTP read: permission to the source, the stricter Go switch, original gone
          const read = read_reference(env.db, env.run.project_id, reference_id, reference_caller(env.db, env.run.actor_id, true));
          return reference_ok(call, read);
        }
        return context_ok(call, env.db, env.run, { kind: "all" });
      }
      case "result.submit": {
        const results = args["results"];
        if (!Array.isArray(results)) return refused(call, "results must be an array");
        const out = (await execute_with_retries(env, "result.submit", key, {
          run_id: env.run.run_id,
          lease_id: env.run.lease_id,
          fence: env.run.fence,
          results,
        })) as { results: Array<{ object_id: string; version_id: string; version_no: number }> };
        const first = out.results[0];
        return ok(call, { versions: out.results }, first === undefined ? { kind: "none" } : { kind: "version", version_id: first.version_id });
      }
      case "question.ask": {
        const questions = args["questions"];
        if (!Array.isArray(questions) || env.run.stage_id === null) return refused(call, "questions must be a non-empty array");
        const out = (await execute_with_retries(env, "question.publish_set", key, {
          stage_id: env.run.stage_id,
          round_id: env.run.round_id,
          purpose: "review",
          form_key: `ai-${env.run.run_id}`,
          questions,
          run_id: env.run.run_id,
          lease_id: env.run.lease_id,
          fence: env.run.fence,
        })) as { set_id: string };
        return ok(call, { question_set_id: out.set_id, note: "waiting for a person to answer" }, { kind: "wait", question_set_id: out.set_id });
      }
      case "thread.reply": {
        const thread_id = args["thread_id"];
        const text = args["text"];
        if (typeof thread_id !== "string" || thread_id.length === 0) return refused(call, "thread_id must be a non-empty string");
        if (typeof text !== "string") return refused(call, "text must be a string");
        const reply_to = args["reply_to"];
        if (reply_to !== undefined && reply_to !== null && typeof reply_to !== "string") return refused(call, "reply_to must be a string");
        // the same route as B (POST P/threads/{t}/messages): a question comment thread takes question.comment_add
        const route = thread_reply_route(env.db, env.run.project_id, thread_id);
        const out = (await execute_with_retries(env, route?.command ?? "thread.reply", key, {
          ...(route?.command === "question.comment_add" ? { question_id: route.question_id } : {}),
          thread_id,
          body_md: text,
          ...(typeof reply_to === "string" ? { reply_to } : {}),
          ...lease_of(env),
        })) as { message_id: string; message_version_id: string };
        return ok(call, { thread_id, message_id: out.message_id, message_version_id: out.message_version_id });
      }
      case "followup.propose": {
        const thread_id = args["thread_id"];
        // with a thread: a real follow-up (a proposal; the text, the thread and the reflection stay as they are)
        if (thread_id !== undefined && thread_id !== null) {
          if (typeof thread_id !== "string" || thread_id.length === 0) return refused(call, "thread_id must be a non-empty string");
          const text = args["text"];
          if (typeof text !== "string") return refused(call, "text must be a string");
          const kind = args["kind"] === undefined || args["kind"] === null ? "none" : args["kind"];
          const payload: Record<string, unknown> = { origin_thread_id: thread_id, kind, description: text };
          for (const field of ["proposed_body_md", "target_stage_id", "target_round_id"]) {
            const value = args[field];
            if (value !== undefined && value !== null) payload[field] = value;
          }
          const out = (await execute_with_retries(env, "followup.propose", key, { ...payload, ...lease_of(env) })) as {
            followup_id: string;
            version_id: string;
            kind: string;
          };
          return ok(call, { thread_id, followup_id: out.followup_id, kind: out.kind, state: "proposed", note: "a person must adopt it" });
        }
        return await write_note(env, call, args, key);
      }
      case "assumption.propose": {
        const text = args["text"];
        if (typeof text !== "string" || text.trim().length === 0) return refused(call, "text must be a non-empty string");
        if (env.run.stage_id === null) throw new ApiError("not_found", "this run has no stage");
        const out = (await execute_with_retries(env, "assumption.propose", key, { statement: text.trim() })) as { object_id: string; version_id: string };
        return ok(call, { recorded_as: out.object_id, id: out.object_id, version_id: out.version_id, state: "proposed", note: "a person must confirm it" });
      }
      case "decision.propose": {
        const text = args["text"];
        if (typeof text !== "string" || text.trim().length === 0) return refused(call, "text must be a non-empty string");
        if (env.run.stage_id === null) throw new ApiError("not_found", "this run has no stage");
        const scope = args["scope"] === undefined ? "edition" : args["scope"];
        if (scope !== "project" && scope !== "edition") return refused(call, "scope must be project or edition");
        const out = (await execute_with_retries(env, "decision.propose", key, { statement: text.trim(), scope })) as { object_id: string; version_id: string };
        return ok(call, { recorded_as: out.object_id, id: out.object_id, version_id: out.version_id, state: "proposed", note: "a person must adopt it" });
      }
      case "reflection.write": {
        if (env.run.stage_id === null) throw new ApiError("not_found", "this run has no stage");
        const entries = args["entries"];
        if (!Array.isArray(entries)) return refused(call, "entries must be an array");
        // the reflection belongs to this run's own round; the tool has no round argument (naming another round is refused)
        const target = env.run.round_id;
        if (target === null) return refused(call, "this run has no round");
        if (args["target_round_id"] !== undefined && args["target_round_id"] !== target) {
          return refused(call, "the reflection is written to this run's round; leave target_round_id out");
        }
        const out = (await execute_with_retries(env, "reflection.create", key, { target_round_id: target, entries })) as {
          count: number;
          applied_count: number;
          partial_count: number;
        };
        return ok(call, { count: out.count, applied_count: out.applied_count, partial_count: out.partial_count });
      }
      default:
        return refused(call, "this tool is not available");
    }
  } catch (error) {
    if (error instanceof ApiError) return refused(call, `${error.code}: ${error.message}`);
    throw error;
  }
}

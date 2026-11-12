// Selection comments and follow-ups (stage 3 U4a, SEL-99). Six commands, no new table (001 already has anchors,
// anchor_resolutions, threads, thread_versions, messages, message_versions, followups and followup_versions):
//
//   annotation.create    a person or a leased agent comments on a quoted stretch of a text version (thread + anchor + first message)
//   annotation.reanchor  re-judge the anchor against a version of the text (a person or a leased agent) - or, with start_cp/end_cp,
//                        the human owner pins it to a stretch he picks ("다시 붙이기")
//   thread.reply         one more message in a thread of any kind (a person or a leased agent)
//   thread.resolve       the human owner closes a thread with a reason and, for a change to be made, a follow-up (proposed)
//   followup.propose     a person or a leased agent proposes a follow-up (an agent only proposes)
//   followup.apply       the human owner adopts a follow-up: edit_text becomes a new version of the text
//
// Everything is append-only: a judgement, a thread state, a follow-up step is a new row, never an update of an old one (only the
// current-version pointer of an object moves). RESOLVED is not APPLIED: thread.resolve proposes a follow-up and leaves the text and
// the reflection entries alone; followup.apply changes the text and does not resolve the thread or write a reflection entry
// (reflection.create does that, with this apply's commit as its evidence). A refusal leaves no row, receipt or event.

import { read_credential_actor } from "../actors.ts";
import { cp_length, cp_slice, judge_anchor, judge_on_origin, place_anchor, TEXT_FORMAT_VERSION, type Judgement } from "../anchors.ts";
import { ApiError } from "../errors.ts";
import {
  artifact_digest_fields,
  content_digest,
  set_first_current_version,
  write_artifact_version,
  write_object,
  write_object_version,
  type ArtifactFields,
} from "./content.ts";
import {
  insert_receipt,
  is_record,
  optional_lease_guard,
  reject_unknown_fields,
  require_current_lease,
  require_human_owner_actor,
  require_record,
  type CommandDefinition,
  type CommandResult,
  type CommandRuntime,
  type EventDraft,
  type LeaseGuard,
} from "./shared.ts";

const MAX_ID = 200;
const MAX_MESSAGE = 20_000;
const MAX_QUOTE = 20_000;
const MAX_CONTEXT = 2_000;
const MAX_TEXT = 1_000_000;
const MAX_DESCRIPTION = 20_000;
const SUMMARY_CP = 200;
const GUARD_FIELDS = ["run_id", "lease_id", "fence"] as const;
const FOLLOWUP_KINDS: readonly string[] = ["edit_text", "next_round_task", "reopen_stage", "none"];
const RESOLUTIONS: readonly string[] = ["edit_text", "next_round_task", "reopen_stage", "none"];
const APPLIABLE_STATES: readonly string[] = ["proposed", "accepted"];
const DECIMAL = /^(0|[1-9][0-9]*)$/;

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new ApiError("invalid_payload", message, details);
}

// ---------------------------------------------------------------------------
// payload parsing

function required_id(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID || !value.isWellFormed()) {
    invalid(`${field} must be a non-empty string`);
  }
  return value;
}

function optional_id(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  if (value === undefined || value === null) return null;
  return required_id(payload, field);
}

/** A non-blank, well-formed text within `max` UTF-16 units. */
function required_text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(`${field} must be a non-empty string`);
  if (!value.isWellFormed()) invalid(`${field} must be well-formed Unicode`);
  if (value.length > max) invalid(`${field} is too long`);
  return value;
}

function optional_context(raw: Record<string, unknown>, field: string): string {
  const value = raw[field];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || !value.isWellFormed()) invalid(`anchor.${field} must be a well-formed string`);
  if (value.length > MAX_CONTEXT) invalid(`anchor.${field} is too long`);
  return value;
}

function cp_position(raw: Record<string, unknown>, field: string): number | null {
  const value = raw[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(`${field} must be a non-negative integer`);
  return value;
}

interface AnchorInput {
  exact_quote: string;
  prefix: string;
  suffix: string;
  start_cp: number | null;
  end_cp: number | null;
}

function parse_anchor(raw: unknown): AnchorInput {
  if (!is_record(raw)) invalid("anchor must be an object");
  for (const key of Object.keys(raw)) {
    if (!["exact_quote", "prefix", "suffix", "start_cp", "end_cp"].includes(key)) invalid(`unknown field: anchor.${key}`);
  }
  const exact_quote = required_text(raw.exact_quote, "anchor.exact_quote", MAX_QUOTE);
  const prefix = optional_context(raw, "prefix");
  const suffix = optional_context(raw, "suffix");
  const start_cp = cp_position(raw, "start_cp");
  const end_cp = cp_position(raw, "end_cp");
  if ((start_cp === null) !== (end_cp === null)) invalid("start_cp and end_cp must be given together");
  return { exact_quote, prefix, suffix, start_cp, end_cp };
}

function parse_guard_free(payload: Record<string, unknown>, allowed: readonly string[]): void {
  reject_unknown_fields(payload, [...allowed, ...GUARD_FIELDS]);
}

// ---------------------------------------------------------------------------
// who may write

interface Scope {
  project_id: string;
  actor_id: string;
  guard: LeaseGuard | null;
  run_id: string | null;
}

function base_scope(runtime: CommandRuntime): { project_id: string; actor_id: string } {
  const project = runtime.project;
  const actor_id = runtime.actor_id;
  if (project === null || actor_id === null) throw new Error("a thread command must resolve a project and actor first");
  return { project_id: project.id, actor_id };
}

/** A person (any member) or an agent that holds the project lease right now. */
function writer_scope(runtime: CommandRuntime, payload: Record<string, unknown>): Scope {
  const base = base_scope(runtime);
  const actor = read_credential_actor(runtime.db, base.actor_id);
  if (actor === undefined) throw new ApiError("forbidden", "the actor is not allowed in this project");
  const supplied = optional_lease_guard(payload);
  if (actor.kind === "human") return { ...base, guard: null, run_id: null };
  if (supplied === null) throw new ApiError("forbidden", "an agent must hold the lease for this command");
  require_current_lease(runtime, supplied);
  return { ...base, guard: supplied, run_id: supplied.run_id };
}

function guard_fields(guard: LeaseGuard | null): { run_id?: string; lease_id?: string; fence?: number } {
  return guard === null ? {} : { run_id: guard.run_id, lease_id: guard.lease_id, fence: guard.fence };
}

// ---------------------------------------------------------------------------
// reading what is there

interface ThreadHead {
  thread_id: string;
  context_kind: string;
  target_object_id: string;
  target_version_id: string | null;
  anchor_id: string | null;
  version_id: string;
  version_no: number;
  state: string;
  resolved_by_message_version_id: string | null;
}

function read_thread(runtime: CommandRuntime, project_id: string, thread_id: string): ThreadHead {
  const row = runtime.db.get<{
    context_kind: string;
    target_object_id: string;
    target_version_id: string | null;
    anchor_id: string | null;
    version_id: string;
    version_no: bigint;
    state: string;
    resolved_by_message_version_id: string | null;
  }>(
    `SELECT t.context_kind AS context_kind, t.target_object_id AS target_object_id, t.target_version_id AS target_version_id,
            t.anchor_id AS anchor_id, o.current_version_id AS version_id, ov.version_no AS version_no,
            tv.state AS state, tv.resolved_by_message_version_id AS resolved_by_message_version_id
       FROM threads t
       JOIN objects o ON o.project_id = t.project_id AND o.id = t.object_id
       JOIN object_versions ov ON ov.project_id = o.project_id AND ov.id = o.current_version_id
       JOIN thread_versions tv ON tv.project_id = ov.project_id AND tv.version_id = ov.id
      WHERE t.project_id = ? AND t.object_id = ?`,
    project_id,
    thread_id,
  );
  if (row === undefined) throw new ApiError("not_found", "thread not found");
  return { thread_id, ...row, version_no: Number(row.version_no) };
}

/** The object must exist in this project (not_found for anyone); whether it is a text is judged after the permission check. */
function read_object_head(runtime: CommandRuntime, project_id: string, object_id: string): { kind: string; current_version_id: string | null } {
  const row = runtime.db.get<{ kind: string; current_version_id: string | null }>(
    "SELECT kind, current_version_id FROM objects WHERE project_id = ? AND id = ?",
    project_id,
    object_id,
  );
  if (row === undefined) throw new ApiError("not_found", "object not found");
  return row;
}

function require_text_object(object_id: string, head: { kind: string }): void {
  if (head.kind !== "artifact") invalid("only a text (artifact) can be commented on this way", { reason: "target_not_text", target_object_id: object_id });
}

interface ArtifactBody {
  version_id: string;
  body_md: string | null;
}

/** A version of THIS artifact (not_found for any other id, including another object's version). */
function read_artifact_body(runtime: CommandRuntime, project_id: string, object_id: string, version_id: string): ArtifactBody {
  const row = runtime.db.get<{ body_md: string | null }>(
    "SELECT body_md FROM artifact_versions WHERE project_id = ? AND object_id = ? AND version_id = ?",
    project_id,
    object_id,
    version_id,
  );
  if (row === undefined) throw new ApiError("not_found", "version not found");
  return { version_id, body_md: row.body_md };
}

function next_version_no(runtime: CommandRuntime, project_id: string, object_id: string): number {
  const row = runtime.db.get<{ max_no: bigint | null }>(
    "SELECT MAX(version_no) AS max_no FROM object_versions WHERE project_id = ? AND object_id = ?",
    project_id,
    object_id,
  );
  return Number(row?.max_no ?? 0n) + 1;
}

function clip_cp(text: string, max_cp: number): string {
  const points = Array.from(text);
  return points.length <= max_cp ? text : points.slice(0, max_cp).join("");
}

// ---------------------------------------------------------------------------
// writing rows

function move_current(runtime: CommandRuntime, project_id: string, object_id: string, from_version_id: string, to_version_id: string): void {
  const moved = runtime.db.run(
    "UPDATE objects SET current_version_id = ?, rev = rev + 1 WHERE project_id = ? AND id = ? AND current_version_id = ?",
    to_version_id,
    project_id,
    object_id,
    from_version_id,
  );
  if (moved.changes !== 1n) throw new ApiError("conflict", "the object moved concurrently");
}

function write_resolution_row(
  runtime: CommandRuntime,
  input: { id: string; project_id: string; anchor_id: string; target_object_id: string; evaluated_version_id: string; judgement: Pick<Judgement, "status" | "start_cp" | "end_cp">; method: string; confirmed_by: string | null },
): void {
  const id = input.id;
  const written = runtime.db.run(
    `INSERT INTO anchor_resolutions
       (id, project_id, anchor_id, target_object_id, evaluated_version_id, status, start_cp, end_cp, method, checked_at, confirmed_by_actor_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.project_id,
    input.anchor_id,
    input.target_object_id,
    input.evaluated_version_id,
    input.judgement.status,
    input.judgement.start_cp,
    input.judgement.end_cp,
    input.method,
    runtime.now_ms,
    input.confirmed_by,
  );
  if (written.changes !== 1n) throw new Error("the anchor resolution was not written");
}

// ---------------------------------------------------------------------------
// annotation.create

function run_annotation_create(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  parse_guard_free(payload, ["target_object_id", "target_version_id", "anchor", "body_md"]);
  const target_object_id = required_id(payload, "target_object_id");
  const given_version_id = optional_id(payload, "target_version_id");
  const body_md = required_text(payload.body_md, "body_md", MAX_MESSAGE);
  if (payload.anchor === undefined || payload.anchor === null) invalid("anchor is required");
  const anchor = parse_anchor(payload.anchor);

  const { project_id } = base_scope(runtime);
  const head = read_object_head(runtime, project_id, target_object_id);
  const scope = writer_scope(runtime, payload);
  require_text_object(target_object_id, head);
  const target_version_id = given_version_id ?? head.current_version_id;
  if (target_version_id === null) throw new ApiError("not_found", "the text has no version");
  const version = read_artifact_body(runtime, project_id, target_object_id, target_version_id);
  if (version.body_md === null) invalid("the version has no text to quote", { reason: "no_text", target_version_id });
  const placed = place_anchor(version.body_md, anchor);
  if (!placed.ok) {
    const message =
      placed.reason === "quote_not_found"
        ? "the quote is not in the version"
        : placed.reason === "ambiguous_quote"
          ? "the quote stands in more than one place"
          : "the position is not as long as the quote";
    throw new ApiError("invalid_payload", message, { reason: placed.reason, target_version_id });
  }

  const thread_id = runtime.new_id();
  const thread_version_id = runtime.new_id();
  const anchor_id = runtime.new_id();
  const resolution_id = runtime.new_id();
  const message_id = runtime.new_id();
  const message_version_id = runtime.new_id();
  const result = {
    project_id,
    thread_id,
    anchor_id,
    target_object_id,
    target_version_id,
    message_id,
    message_version_id,
    anchor_status: placed.status,
    start_cp: placed.start_cp,
    end_cp: placed.end_cp,
    resolution_id,
  };
  insert_receipt(runtime, { project_id, actor_id: scope.actor_id, action: "annotation.create", base_control_rev: null, result, ...guard_fields(scope.guard) });
  write_object(runtime, project_id, thread_id, "thread", null, null);
  write_object_version(runtime, {
    project_id,
    object_id: thread_id,
    kind: "thread",
    version_id: thread_version_id,
    version_no: 1,
    based_on_version_id: null,
    actor_id: scope.actor_id,
    run_id: scope.run_id,
    content_hash: content_digest("thread", { state: "open", summary: "" }),
  });
  const wrote_anchor = runtime.db.run(
    `INSERT INTO anchors
       (id, project_id, target_object_id, target_version_id, exact_quote, prefix, suffix, text_format_version, start_cp, end_cp, supersedes_anchor_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    anchor_id,
    project_id,
    target_object_id,
    target_version_id,
    anchor.exact_quote,
    anchor.prefix,
    anchor.suffix,
    TEXT_FORMAT_VERSION,
    placed.start_cp,
    placed.end_cp,
  );
  if (wrote_anchor.changes !== 1n) throw new Error("the anchor was not written");
  const wrote_thread = runtime.db.run(
    "INSERT INTO threads (project_id, object_id, target_object_id, target_version_id, context_kind, anchor_id) VALUES (?, ?, ?, ?, 'annotation', ?)",
    project_id,
    thread_id,
    target_object_id,
    target_version_id,
    anchor_id,
  );
  if (wrote_thread.changes !== 1n) throw new Error("the thread was not written");
  const wrote_version = runtime.db.run(
    "INSERT INTO thread_versions (project_id, version_id, object_id, state, summary) VALUES (?, ?, ?, 'open', '')",
    project_id,
    thread_version_id,
    thread_id,
  );
  if (wrote_version.changes !== 1n) throw new Error("the thread version was not written");
  set_first_current_version(runtime, project_id, thread_id, thread_version_id);
  write_resolution_row(runtime, {
    id: resolution_id,
    project_id,
    anchor_id,
    target_object_id,
    evaluated_version_id: target_version_id,
    judgement: { status: placed.status, start_cp: placed.start_cp, end_cp: placed.end_cp },
    method: "create",
    confirmed_by: null,
  });
  write_message(runtime, { project_id, thread_id, actor_id: scope.actor_id, run_id: scope.run_id, body_md, reply_to: null, message_id, message_version_id });
  return {
    result,
    events: [
      {
        type: "annotation.created",
        run_id: scope.run_id,
        payload: { thread_id, message_id, anchor_id, target_object_id, target_version_id, anchor_status: placed.status },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// annotation.reanchor

interface AnchorRow {
  anchor_id: string;
  target_object_id: string;
  target_version_id: string;
  exact_quote: string;
  prefix: string;
  suffix: string;
  start_cp: number | null;
}

function read_anchor(runtime: CommandRuntime, project_id: string, anchor_id: string): AnchorRow {
  const row = runtime.db.get<{
    target_object_id: string;
    target_version_id: string;
    exact_quote: string;
    prefix: string;
    suffix: string;
    start_cp: bigint | null;
  }>(
    "SELECT target_object_id, target_version_id, exact_quote, prefix, suffix, start_cp FROM anchors WHERE project_id = ? AND id = ?",
    project_id,
    anchor_id,
  );
  if (row === undefined) throw new Error("the thread's anchor is missing");
  return { anchor_id, ...row, start_cp: row.start_cp === null ? null : Number(row.start_cp) };
}

function run_annotation_reanchor(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  parse_guard_free(payload, ["thread_id", "version_id", "basis_version_id", "start_cp", "end_cp"]);
  const thread_id = required_id(payload, "thread_id");
  const given_version_id = optional_id(payload, "version_id");
  // the version the caller read when it chose the stretch: a stretch picked on an older text must not be pinned on the new one
  const basis_version_id = optional_id(payload, "basis_version_id");
  const start_cp = cp_position(payload, "start_cp");
  const end_cp = cp_position(payload, "end_cp");
  if ((start_cp === null) !== (end_cp === null)) invalid("start_cp and end_cp must be given together");
  if (start_cp !== null && end_cp !== null && end_cp <= start_cp) invalid("the stretch must not be empty", { reason: "range_empty" });
  const picking = start_cp !== null;

  const { project_id } = base_scope(runtime);
  const thread = read_thread(runtime, project_id, thread_id);
  // pinning an anchor to a stretch is the human owner's choice; judging it again is for anyone who may comment
  let actor_id: string;
  let run_id: string | null = null;
  let guard: LeaseGuard | null = null;
  if (picking) {
    actor_id = require_human_owner_actor(runtime);
  } else {
    const scope = writer_scope(runtime, payload);
    actor_id = scope.actor_id;
    run_id = scope.run_id;
    guard = scope.guard;
  }
  if (thread.anchor_id === null) invalid("the thread has no anchor", { reason: "no_anchor" });
  const anchor = read_anchor(runtime, project_id, thread.anchor_id);
  const head = read_object_head(runtime, project_id, anchor.target_object_id);
  // the current judgement is always on the text's current version, so the basis must be that version (and the one judged, when given)
  if (basis_version_id !== null && (basis_version_id !== head.current_version_id || (given_version_id !== null && given_version_id !== basis_version_id))) {
    throw new ApiError("conflict", "the text has changed since the stretch was chosen", {
      reason: "basis_changed",
      expected: basis_version_id,
      current: head.current_version_id,
    });
  }
  const evaluated_version_id = given_version_id ?? head.current_version_id;
  if (evaluated_version_id === null) throw new ApiError("not_found", "the text has no version");
  const version = read_artifact_body(runtime, project_id, anchor.target_object_id, evaluated_version_id);
  if (version.body_md === null) invalid("the version has no text", { reason: "no_text", target_version_id: evaluated_version_id });

  let judgement: Judgement;
  let method: string;
  let confirmed_by: string | null = null;
  if (picking) {
    const length = cp_length(version.body_md);
    if ((end_cp as number) > length) invalid("the stretch is outside the text", { reason: "range_outside", length });
    const picked = cp_slice(version.body_md, start_cp as number, end_cp as number);
    const same_place = picked === anchor.exact_quote && anchor.start_cp === start_cp;
    judgement = { status: same_place ? "exact" : "moved", start_cp: start_cp as number, end_cp: end_cp as number, candidates: [] };
    method = "manual";
    confirmed_by = actor_id;
  } else {
    judgement = evaluated_version_id === anchor.target_version_id ? judge_on_origin(anchor) : judge_anchor(version.body_md, anchor);
    method = "auto";
  }
  const resolution_id = runtime.new_id();
  const result = {
    project_id,
    thread_id,
    anchor_id: anchor.anchor_id,
    resolution_id,
    evaluated_version_id,
    status: judgement.status,
    start_cp: judgement.start_cp,
    end_cp: judgement.end_cp,
    candidates: judgement.candidates,
    confirmed_by_actor_id: confirmed_by,
  };
  insert_receipt(runtime, { project_id, actor_id, action: "annotation.reanchor", base_control_rev: null, result, ...guard_fields(guard) });
  const written = runtime.db.run(
    `INSERT INTO anchor_resolutions
       (id, project_id, anchor_id, target_object_id, evaluated_version_id, status, start_cp, end_cp, method, checked_at, confirmed_by_actor_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    resolution_id,
    project_id,
    anchor.anchor_id,
    anchor.target_object_id,
    evaluated_version_id,
    judgement.status,
    judgement.start_cp,
    judgement.end_cp,
    method,
    runtime.now_ms,
    confirmed_by,
  );
  if (written.changes !== 1n) throw new Error("the anchor resolution was not written");
  return {
    result,
    events: [
      {
        type: "annotation.reanchored",
        run_id,
        payload: { thread_id, anchor_id: anchor.anchor_id, resolution_id, evaluated_version_id, status: judgement.status, method },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// thread.reply

function run_thread_reply(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  parse_guard_free(payload, ["thread_id", "body_md", "reply_to"]);
  const thread_id = required_id(payload, "thread_id");
  const body_md = required_text(payload.body_md, "body_md", MAX_MESSAGE);
  const reply_to = optional_id(payload, "reply_to");

  const { project_id } = base_scope(runtime);
  const thread = read_thread(runtime, project_id, thread_id);
  const scope = writer_scope(runtime, payload);
  if (thread.state !== "open") {
    throw new ApiError("conflict", "a closed thread takes no more messages; open a new thread", { reason: "thread_closed", thread_id, state: thread.state });
  }
  if (reply_to !== null) {
    const parent = runtime.db.get("SELECT 1 AS found FROM messages WHERE project_id = ? AND thread_id = ? AND object_id = ?", project_id, thread_id, reply_to);
    if (parent === undefined) throw new ApiError("not_found", "reply_to message not found in this thread");
  }
  const message_id = runtime.new_id();
  const message_version_id = runtime.new_id();
  const result = { project_id, thread_id, message_id, message_version_id };
  insert_receipt(runtime, { project_id, actor_id: scope.actor_id, action: "thread.reply", base_control_rev: null, result, ...guard_fields(scope.guard) });
  write_message(runtime, { project_id, thread_id, actor_id: scope.actor_id, run_id: scope.run_id, body_md, reply_to, message_id, message_version_id });
  return { result, events: [{ type: "thread.replied", run_id: scope.run_id, payload: { thread_id, message_id, message_version_id } }] };
}

/** The caller draws the ids first, so the receipt can carry them before the rows exist. */
function write_message(
  runtime: CommandRuntime,
  input: { project_id: string; thread_id: string; actor_id: string; run_id: string | null; body_md: string; reply_to: string | null; message_id: string; message_version_id: string },
): void {
  write_object(runtime, input.project_id, input.message_id, "message", null, null);
  write_object_version(runtime, {
    project_id: input.project_id,
    object_id: input.message_id,
    kind: "message",
    version_id: input.message_version_id,
    version_no: 1,
    based_on_version_id: null,
    actor_id: input.actor_id,
    run_id: input.run_id,
    content_hash: content_digest("message", { body_md: input.body_md, state: "published" }),
  });
  const written = runtime.db.run(
    "INSERT INTO messages (project_id, object_id, thread_id, reply_to, submission_id) VALUES (?, ?, ?, ?, NULL)",
    input.project_id,
    input.message_id,
    input.thread_id,
    input.reply_to,
  );
  if (written.changes !== 1n) throw new Error("the message was not written");
  const version = runtime.db.run(
    "INSERT INTO message_versions (project_id, version_id, object_id, thread_id, body_md, state) VALUES (?, ?, ?, ?, ?, 'published')",
    input.project_id,
    input.message_version_id,
    input.message_id,
    input.thread_id,
    input.body_md,
  );
  if (version.changes !== 1n) throw new Error("the message version was not written");
  set_first_current_version(runtime, input.project_id, input.message_id, input.message_version_id);
}

// ---------------------------------------------------------------------------
// follow-ups

interface FollowupSpec {
  kind: string;
  description: string | null;
  proposed_body_md: string | null;
  /** edit_text: the version the new text is based on (propose: base_version_id, resolve: target_version_id) */
  base_version_id: string | null;
  target_stage_id: string | null;
  target_round_id: string | null;
}

/** The shape of a follow-up (no database): which fields belong to which kind. */
function parse_followup_spec(raw: Record<string, unknown>, base_field: string, where: string, description_required: boolean): FollowupSpec {
  const kind = raw.kind;
  if (typeof kind !== "string" || !FOLLOWUP_KINDS.includes(kind)) invalid(`${where}kind is not a known value`);
  const description = description_required || (raw.description !== undefined && raw.description !== null) ? required_text(raw.description, `${where}description`, MAX_DESCRIPTION) : null;
  const proposed_given = raw.proposed_body_md !== undefined && raw.proposed_body_md !== null;
  const base_given = raw[base_field] !== undefined && raw[base_field] !== null;
  const stage_given = raw.target_stage_id !== undefined && raw.target_stage_id !== null;
  const round_given = raw.target_round_id !== undefined && raw.target_round_id !== null;
  if (kind !== "edit_text") {
    if (proposed_given) invalid(`${where}proposed_body_md is only for edit_text`);
    if (base_given) invalid(`${where}${base_field} is only for edit_text`);
  }
  if (kind === "edit_text" || kind === "none") {
    if (stage_given || round_given) invalid(`${where}target_stage_id and target_round_id are for next_round_task and reopen_stage`);
  } else if (!stage_given) {
    invalid(`${where}target_stage_id is required for ${kind}`);
  }
  if (round_given && !stage_given) invalid(`${where}target_round_id needs target_stage_id`);
  return {
    kind,
    description,
    proposed_body_md: proposed_given ? required_text(raw.proposed_body_md, `${where}proposed_body_md`, MAX_TEXT) : null,
    base_version_id: base_given ? required_id(raw, base_field) : null,
    target_stage_id: stage_given ? required_id(raw, "target_stage_id") : null,
    target_round_id: round_given ? required_id(raw, "target_round_id") : null,
  };
}

interface FollowupPlan {
  kind: string;
  description: string;
  target_stage_id: string | null;
  target_round_id: string | null;
  base_version_id: string | null;
  proposed_version_id: string | null;
  proposal: { fields: ArtifactFields; object_id: string; version_no: number } | null;
}

function parse_artifact_columns(row: {
  title: string;
  question: string | null;
  summary: string;
  body_md: string | null;
  status: string;
  confidence: string | null;
  stats: string;
  conflicts: string;
  verify: string;
  metadata_json: string;
}): ArtifactFields {
  return {
    title: row.title,
    summary: row.summary,
    question: row.question,
    body_md: row.body_md,
    status: row.status,
    confidence: row.confidence,
    stats: JSON.parse(row.stats) as unknown[],
    conflicts: JSON.parse(row.conflicts) as unknown[],
    verify: JSON.parse(row.verify) as unknown,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
  };
}

function read_artifact_fields(runtime: CommandRuntime, project_id: string, object_id: string, version_id: string): ArtifactFields {
  const row = runtime.db.get<Parameters<typeof parse_artifact_columns>[0]>(
    `SELECT title, question, summary, body_md, status, confidence, stats, conflicts, verify, metadata_json
       FROM artifact_versions WHERE project_id = ? AND object_id = ? AND version_id = ?`,
    project_id,
    object_id,
    version_id,
  );
  if (row === undefined) throw new ApiError("not_found", "version not found");
  return parse_artifact_columns(row);
}

/** Database checks of a follow-up spec for a thread: the stage and round exist, a text change has a text to change and a version to base on. */
function plan_followup(runtime: CommandRuntime, project_id: string, thread: ThreadHead, spec: FollowupSpec, description: string): FollowupPlan {
  let base_version_id: string | null = null;
  let proposal: FollowupPlan["proposal"] = null;
  if (spec.kind === "edit_text") {
    const head = read_object_head(runtime, project_id, thread.target_object_id);
    require_text_object(thread.target_object_id, head);
    base_version_id = spec.base_version_id ?? head.current_version_id;
    if (base_version_id === null) throw new ApiError("not_found", "the text has no version");
    read_artifact_body(runtime, project_id, thread.target_object_id, base_version_id);
    if (spec.proposed_body_md !== null) {
      const base_fields = read_artifact_fields(runtime, project_id, thread.target_object_id, base_version_id);
      proposal = {
        fields: { ...base_fields, body_md: spec.proposed_body_md },
        object_id: thread.target_object_id,
        version_no: next_version_no(runtime, project_id, thread.target_object_id),
      };
    }
  }
  if (spec.target_stage_id !== null) {
    if (runtime.db.get("SELECT 1 AS found FROM stages WHERE project_id = ? AND id = ?", project_id, spec.target_stage_id) === undefined) {
      throw new ApiError("not_found", "target_stage_id is not a stage of this project");
    }
    if (spec.target_round_id !== null) {
      const round = runtime.db.get("SELECT 1 AS found FROM rounds WHERE project_id = ? AND stage_id = ? AND id = ?", project_id, spec.target_stage_id, spec.target_round_id);
      if (round === undefined) throw new ApiError("not_found", "target_round_id is not a round of that stage");
    }
  }
  return {
    kind: spec.kind,
    description,
    target_stage_id: spec.target_stage_id,
    target_round_id: spec.target_round_id,
    base_version_id,
    proposed_version_id: proposal === null ? null : runtime.new_id(),
    proposal,
  };
}

function followup_hash(kind: string, state: string, description: string, plan: Pick<FollowupPlan, "target_stage_id" | "target_round_id" | "base_version_id" | "proposed_version_id">, extra: Record<string, unknown> = {}): string {
  return content_digest("followup", {
    kind,
    state,
    description,
    target_stage_id: plan.target_stage_id,
    target_round_id: plan.target_round_id,
    base_artifact_version_id: plan.base_version_id,
    proposed_artifact_version_id: plan.proposed_version_id,
    ...extra,
  });
}

/** Write the proposed text (a new version that is NOT the current one) and the follow-up (object, version 1, state proposed). */
function write_followup(
  runtime: CommandRuntime,
  input: {
    project_id: string;
    actor_id: string;
    run_id: string | null;
    thread: ThreadHead;
    origin_message_version_id: string | null;
    plan: FollowupPlan;
    followup_id: string;
    version_id: string;
  },
): void {
  const { plan } = input;
  if (plan.proposal !== null && plan.proposed_version_id !== null && plan.base_version_id !== null) {
    write_object_version(runtime, {
      project_id: input.project_id,
      object_id: plan.proposal.object_id,
      kind: "artifact",
      version_id: plan.proposed_version_id,
      version_no: plan.proposal.version_no,
      based_on_version_id: plan.base_version_id,
      actor_id: input.actor_id,
      run_id: input.run_id,
      content_hash: content_digest("artifact", artifact_digest_fields(plan.proposal.fields)),
    });
    write_artifact_version(runtime, input.project_id, plan.proposal.object_id, plan.proposed_version_id, plan.proposal.fields);
  }
  write_object(runtime, input.project_id, input.followup_id, "followup", null, null);
  write_object_version(runtime, {
    project_id: input.project_id,
    object_id: input.followup_id,
    kind: "followup",
    version_id: input.version_id,
    version_no: 1,
    based_on_version_id: null,
    actor_id: input.actor_id,
    run_id: input.run_id,
    content_hash: followup_hash(plan.kind, "proposed", plan.description, plan),
  });
  const origin = runtime.db.run(
    "INSERT INTO followups (project_id, object_id, origin_thread_id, origin_message_version_id, origin_version_id) VALUES (?, ?, ?, ?, ?)",
    input.project_id,
    input.followup_id,
    input.thread.thread_id,
    input.origin_message_version_id,
    input.thread.target_version_id,
  );
  if (origin.changes !== 1n) throw new Error("the follow-up was not written");
  const written = runtime.db.run(
    `INSERT INTO followup_versions
       (project_id, version_id, object_id, kind, state, description, target_stage_id, target_round_id,
        base_artifact_version_id, proposed_artifact_version_id, confirmed_by_actor_id, applied_tx_id, result_version_id)
     VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    input.project_id,
    input.version_id,
    input.followup_id,
    plan.kind,
    plan.description,
    plan.target_stage_id,
    plan.target_round_id,
    plan.base_version_id,
    plan.proposed_version_id,
  );
  if (written.changes !== 1n) throw new Error("the follow-up version was not written");
  set_first_current_version(runtime, input.project_id, input.followup_id, input.version_id);
}

function run_followup_propose(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  parse_guard_free(payload, ["origin_thread_id", "kind", "description", "proposed_body_md", "base_version_id", "target_stage_id", "target_round_id"]);
  const thread_id = required_id(payload, "origin_thread_id");
  const spec = parse_followup_spec(payload, "base_version_id", "", true);
  if (spec.kind === "edit_text" && spec.proposed_body_md === null) invalid("proposed_body_md is required for edit_text");

  const { project_id } = base_scope(runtime);
  const thread = read_thread(runtime, project_id, thread_id);
  const scope = writer_scope(runtime, payload);
  const plan = plan_followup(runtime, project_id, thread, spec, spec.description as string);
  const followup_id = runtime.new_id();
  const version_id = runtime.new_id();
  const result = {
    project_id,
    followup_id,
    version_id,
    version_no: 1,
    kind: plan.kind,
    state: "proposed",
    thread_id,
    base_version_id: plan.base_version_id,
    proposed_version_id: plan.proposed_version_id,
  };
  insert_receipt(runtime, { project_id, actor_id: scope.actor_id, action: "followup.propose", base_control_rev: null, result, ...guard_fields(scope.guard) });
  write_followup(runtime, { project_id, actor_id: scope.actor_id, run_id: scope.run_id, thread, origin_message_version_id: null, plan, followup_id, version_id });
  return {
    result,
    events: [{ type: "followup.proposed", run_id: scope.run_id, payload: { followup_id, version_id, kind: plan.kind, thread_id, proposed_version_id: plan.proposed_version_id } }],
  };
}

// ---------------------------------------------------------------------------
// thread.resolve

function run_thread_resolve(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  const actor_id = require_human_owner_actor(runtime);
  reject_unknown_fields(payload, ["thread_id", "resolution", "reason", "followup"]);
  const thread_id = required_id(payload, "thread_id");
  const resolution = payload.resolution;
  if (typeof resolution !== "string" || !RESOLUTIONS.includes(resolution)) invalid("resolution is not a known value");
  const reason = required_text(payload.reason, "reason", MAX_MESSAGE);
  let spec: FollowupSpec | null = null;
  const raw_followup = payload.followup;
  if (resolution === "none") {
    if (raw_followup !== undefined && raw_followup !== null) invalid("a thread closed with no change takes no follow-up", { reason: "followup_not_allowed" });
  } else {
    if (!is_record(raw_followup)) invalid(`followup is required for ${resolution}`, { reason: "followup_required" });
    reject_unknown_fields(raw_followup, ["kind", "description", "proposed_body_md", "target_version_id", "target_stage_id", "target_round_id"]);
    spec = parse_followup_spec(raw_followup, "target_version_id", "followup.", false);
    if (spec.kind !== resolution) invalid("followup.kind must be the same as the resolution", { reason: "followup_kind" });
  }

  const { project_id } = base_scope(runtime);
  const thread = read_thread(runtime, project_id, thread_id);
  if (thread.state !== "open") {
    throw new ApiError("conflict", "the thread is already resolved", {
      reason: "already_resolved",
      thread_id,
      state: thread.state,
      resolution_id: thread.resolved_by_message_version_id,
    });
  }
  const plan = spec === null ? null : plan_followup(runtime, project_id, thread, spec, spec.description ?? reason);
  const message_id = runtime.new_id();
  const message_version_id = runtime.new_id();
  const thread_version_id = runtime.new_id();
  const followup_id = plan === null ? null : runtime.new_id();
  const followup_version_id = plan === null ? null : runtime.new_id();
  const result = {
    project_id,
    thread_id,
    state: "resolved",
    resolution,
    followup_id,
    followup_version_id,
    applied: false,
    resolution_message_version_id: message_version_id,
    thread_version_id,
  };
  insert_receipt(runtime, { project_id, actor_id, action: "thread.resolve", base_control_rev: null, result });
  write_message(runtime, { project_id, thread_id, actor_id, run_id: null, body_md: reason, reply_to: null, message_id, message_version_id });
  const summary = clip_cp(reason, SUMMARY_CP);
  write_object_version(runtime, {
    project_id,
    object_id: thread_id,
    kind: "thread",
    version_id: thread_version_id,
    version_no: thread.version_no + 1,
    based_on_version_id: thread.version_id,
    actor_id,
    run_id: null,
    content_hash: content_digest("thread", { state: "resolved", summary, resolved_by_message_version_id: message_version_id }),
  });
  const written = runtime.db.run(
    "INSERT INTO thread_versions (project_id, version_id, object_id, state, resolved_by_message_version_id, summary) VALUES (?, ?, ?, 'resolved', ?, ?)",
    project_id,
    thread_version_id,
    thread_id,
    message_version_id,
    summary,
  );
  if (written.changes !== 1n) throw new Error("the thread version was not written");
  move_current(runtime, project_id, thread_id, thread.version_id, thread_version_id);
  const events: EventDraft[] = [{ type: "thread.resolved", payload: { thread_id, resolution, resolution_message_version_id: message_version_id, followup_id } }];
  if (plan !== null && followup_id !== null && followup_version_id !== null) {
    write_followup(runtime, { project_id, actor_id, run_id: null, thread, origin_message_version_id: message_version_id, plan, followup_id, version_id: followup_version_id });
    events.push({ type: "followup.proposed", payload: { followup_id, version_id: followup_version_id, kind: plan.kind, thread_id, proposed_version_id: plan.proposed_version_id } });
  }
  return { result, events };
}

// ---------------------------------------------------------------------------
// followup.apply

interface FollowupHead {
  followup_id: string;
  origin_thread_id: string | null;
  origin_version_id: string | null;
  version_id: string;
  version_no: number;
  kind: string;
  state: string;
  description: string;
  target_stage_id: string | null;
  target_round_id: string | null;
  base_version_id: string | null;
  proposed_version_id: string | null;
}

function read_followup(runtime: CommandRuntime, project_id: string, followup_id: string): FollowupHead {
  const row = runtime.db.get<{
    origin_thread_id: string | null;
    origin_version_id: string | null;
    version_id: string;
    version_no: bigint;
    kind: string;
    state: string;
    description: string;
    target_stage_id: string | null;
    target_round_id: string | null;
    base_version_id: string | null;
    proposed_version_id: string | null;
  }>(
    `SELECT f.origin_thread_id AS origin_thread_id, f.origin_version_id AS origin_version_id,
            o.current_version_id AS version_id, ov.version_no AS version_no, fv.kind AS kind, fv.state AS state,
            fv.description AS description, fv.target_stage_id AS target_stage_id, fv.target_round_id AS target_round_id,
            fv.base_artifact_version_id AS base_version_id, fv.proposed_artifact_version_id AS proposed_version_id
       FROM followups f
       JOIN objects o ON o.project_id = f.project_id AND o.id = f.object_id
       JOIN object_versions ov ON ov.project_id = o.project_id AND ov.id = o.current_version_id
       JOIN followup_versions fv ON fv.project_id = ov.project_id AND fv.version_id = ov.id
      WHERE f.project_id = ? AND f.object_id = ?`,
    project_id,
    followup_id,
  );
  if (row === undefined) throw new ApiError("not_found", "followup not found");
  return { followup_id, ...row, version_no: Number(row.version_no) };
}

function run_followup_apply(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  const actor_id = require_human_owner_actor(runtime);
  reject_unknown_fields(payload, ["followup_id", "base_version_id", "expected_rev"]);
  const followup_id = required_id(payload, "followup_id");
  const base_version_id = required_id(payload, "base_version_id");
  const rev_text = typeof payload.expected_rev === "number" && Number.isSafeInteger(payload.expected_rev) && payload.expected_rev >= 0 ? String(payload.expected_rev) : payload.expected_rev;
  if (typeof rev_text !== "string" || !DECIMAL.test(rev_text)) invalid("expected_rev must be a normalized decimal string");
  const expected_rev = BigInt(rev_text);

  const { project_id } = base_scope(runtime);
  const head = read_followup(runtime, project_id, followup_id);
  if (!APPLIABLE_STATES.includes(head.state)) {
    throw new ApiError("conflict", `a follow-up that is ${head.state} cannot be applied`, { reason: "followup_state", state: head.state });
  }
  if (head.kind === "edit_text" && head.proposed_version_id === null) {
    invalid("the follow-up has no proposed text yet; propose one before adopting it", { reason: "no_proposed_text" });
  }
  // the basis: an edit applies only to the very version it was proposed for, and only while that is still the current text
  let current_basis: string | null;
  let basis_ok: boolean;
  if (head.kind === "edit_text") {
    const thread = head.origin_thread_id === null ? null : read_thread(runtime, project_id, head.origin_thread_id);
    const object_id = thread === null ? artifact_of_version(runtime, project_id, head.base_version_id as string) : thread.target_object_id;
    current_basis = read_object_head(runtime, project_id, object_id).current_version_id;
    basis_ok = base_version_id === head.base_version_id && head.base_version_id === current_basis;
  } else {
    current_basis = head.origin_version_id;
    basis_ok = head.origin_version_id === null || base_version_id === head.origin_version_id;
  }
  if (!basis_ok) {
    throw new ApiError("conflict", "the follow-up's basis has changed", {
      reason: "basis_changed",
      expected: base_version_id,
      current: current_basis,
      current_rev: String(head.version_no),
    });
  }
  if (expected_rev !== BigInt(head.version_no)) {
    throw new ApiError("rev_conflict", "expected_rev is not the follow-up's current revision", { expected: rev_text, current: String(head.version_no) });
  }

  const new_version_id = runtime.new_id();
  const followup_version_id = runtime.new_id();
  let result_version_id: string | null = null;
  let artifact: { object_id: string; version_no: number; fields: ArtifactFields } | null = null;
  if (head.kind === "edit_text") {
    const object_id = head.origin_thread_id === null ? artifact_of_version(runtime, project_id, head.base_version_id as string) : read_thread(runtime, project_id, head.origin_thread_id).target_object_id;
    const fields = read_artifact_fields(runtime, project_id, object_id, head.proposed_version_id as string);
    if (fields.body_md === null) invalid("the proposed text is empty", { reason: "no_proposed_text" });
    artifact = { object_id, version_no: next_version_no(runtime, project_id, object_id), fields };
    result_version_id = new_version_id;
  }
  const thread_state = head.origin_thread_id === null ? null : read_thread(runtime, project_id, head.origin_thread_id).state;
  const result = {
    project_id,
    followup_id,
    version_id: followup_version_id,
    version_no: head.version_no + 1,
    kind: head.kind,
    state: "applied",
    applied_tx_id: runtime.tx_id,
    result_version_id,
    thread_id: head.origin_thread_id,
    thread_state,
  };
  insert_receipt(runtime, { project_id, actor_id, action: "followup.apply", base_control_rev: null, result });
  if (artifact !== null) {
    write_object_version(runtime, {
      project_id,
      object_id: artifact.object_id,
      kind: "artifact",
      version_id: new_version_id,
      version_no: artifact.version_no,
      based_on_version_id: head.base_version_id,
      actor_id,
      run_id: null,
      content_hash: content_digest("artifact", artifact_digest_fields(artifact.fields)),
    });
    write_artifact_version(runtime, project_id, artifact.object_id, new_version_id, artifact.fields);
    move_current(runtime, project_id, artifact.object_id, head.base_version_id as string, new_version_id);
  }
  const plan = { target_stage_id: head.target_stage_id, target_round_id: head.target_round_id, base_version_id: head.base_version_id, proposed_version_id: head.proposed_version_id };
  write_object_version(runtime, {
    project_id,
    object_id: followup_id,
    kind: "followup",
    version_id: followup_version_id,
    version_no: head.version_no + 1,
    based_on_version_id: head.version_id,
    actor_id,
    run_id: null,
    content_hash: followup_hash(head.kind, "applied", head.description, plan, { confirmed_by_actor_id: actor_id, applied_tx_id: runtime.tx_id, result_version_id }),
  });
  const written = runtime.db.run(
    `INSERT INTO followup_versions
       (project_id, version_id, object_id, kind, state, description, target_stage_id, target_round_id,
        base_artifact_version_id, proposed_artifact_version_id, confirmed_by_actor_id, applied_tx_id, result_version_id)
     VALUES (?, ?, ?, ?, 'applied', ?, ?, ?, ?, ?, ?, ?, ?)`,
    project_id,
    followup_version_id,
    followup_id,
    head.kind,
    head.description,
    head.target_stage_id,
    head.target_round_id,
    head.base_version_id,
    head.proposed_version_id,
    actor_id,
    runtime.tx_id,
    result_version_id,
  );
  if (written.changes !== 1n) throw new Error("the follow-up version was not written");
  move_current(runtime, project_id, followup_id, head.version_id, followup_version_id);
  return {
    result,
    events: [{ type: "followup.applied", payload: { followup_id, version_id: followup_version_id, kind: head.kind, applied_tx_id: runtime.tx_id, result_version_id, thread_id: head.origin_thread_id } }],
  };
}

/** The text a follow-up edits when it has no origin thread: the artifact of its base version. */
function artifact_of_version(runtime: CommandRuntime, project_id: string, version_id: string): string {
  const row = runtime.db.get<{ object_id: string }>("SELECT object_id FROM artifact_versions WHERE project_id = ? AND version_id = ?", project_id, version_id);
  if (row === undefined) throw new ApiError("not_found", "version not found");
  return row.object_id;
}

// ---------------------------------------------------------------------------
// registry

function definition(action: string, run: (runtime: CommandRuntime) => CommandResult): CommandDefinition {
  return Object.freeze({ action, scope: "project", rev_bearing: false, run });
}

const ANNOTATION_COMMAND_INPUTS: ReadonlyArray<readonly [string, CommandDefinition]> = [
  ["annotation.create", definition("annotation.create", run_annotation_create)],
  ["annotation.reanchor", definition("annotation.reanchor", run_annotation_reanchor)],
  ["thread.reply", definition("thread.reply", run_thread_reply)],
  ["thread.resolve", definition("thread.resolve", run_thread_resolve)],
  ["followup.propose", definition("followup.propose", run_followup_propose)],
  ["followup.apply", definition("followup.apply", run_followup_apply)],
];

/** Registry entries merged into COMMANDS by commands.ts (names, not actions); frozen like the other command modules. */
export const ANNOTATION_COMMAND_ENTRIES: ReadonlyArray<readonly [string, CommandDefinition]> = Object.freeze(
  ANNOTATION_COMMAND_INPUTS.map((entry) => Object.freeze([entry[0], entry[1]] as const)),
);

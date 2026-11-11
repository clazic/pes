// Record command definitions for the CLI write path (stage 2 PR15).
//
// These are the five CLI-facing commands that keep notes, chat inputs, handoff
// reviews and processed-input marks inside the command service instead of
// project.json: input.mark_processed, input.record_chat, project.add_note,
// qa.record, qa.record_brief. They add no table: a note, chat input or review
// is an append-only artifact version (kinds "note" / "review", the role in
// metadata_json.role) and a processed mark is a receipt + event. Public
// wrappers are in scripts/pes_core/records.ts (one service.execute each).

import { ApiError } from "../errors.ts";
import { read_storage_bytes, sha256_hex } from "../files.ts";
import { insert_ready_blob } from "./files.ts";
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
  reject_unknown_fields,
  require_non_empty_string,
  require_record,
  resolve_stage_key,
  type CommandDefinition,
  type CommandResult,
  type CommandRuntime,
  type KeyedStage,
} from "./shared.ts";

const MAX_TEXT = 100_000;
/** A screen answer's text may be as long as the HTTP body allows (v0.15 took it); only the body limit bounds it. */
const MAX_WEB_TEXT = 262_144;
/** ApiError message when the answer's form was revised; the bridge turns exactly this conflict into the screen's 409. */
export const FORM_REVISED = "the form was revised after this answer was written";
const MAX_MARK_NAMES = 200;
const MAX_NAME = 200;

interface Scope {
  project_id: string;
  actor_id: string;
}

function scope_of(runtime: CommandRuntime): Scope {
  const project = runtime.project;
  const actor_id = runtime.actor_id;
  if (project === null || actor_id === null) {
    throw new Error("a record command must resolve a project and actor first");
  }
  return { project_id: project.id, actor_id };
}

function require_text(payload: Record<string, unknown>, field: string, max = MAX_TEXT): string {
  const text = require_non_empty_string(payload, field);
  if (text.trim().length === 0) {
    throw new ApiError("invalid_payload", `${field} must not be blank`);
  }
  if (text.length > max) {
    throw new ApiError("invalid_payload", `${field} is too long`);
  }
  return text;
}

function first_line(text: string, max: number): string {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

interface RecordIds {
  object_id: string;
  version_id: string;
}

function new_ids(runtime: CommandRuntime): RecordIds {
  return { object_id: runtime.new_id(), version_id: runtime.new_id() };
}

/**
 * One new artifact object with a single version (kind note/review), in the active edition.
 * The receipt must already exist: object_versions.tx_id references it. */
function write_record_artifact(
  runtime: CommandRuntime,
  scope: Scope,
  stage: { id: string | null; edition_id: string },
  artifact_kind: "note" | "review",
  fields: ArtifactFields,
  ids: RecordIds,
): void {
  const { object_id, version_id } = ids;
  write_object(runtime, scope.project_id, object_id, "artifact", stage.edition_id, null);
  write_object_version(runtime, {
    project_id: scope.project_id,
    object_id,
    kind: "artifact",
    version_id,
    version_no: 1,
    based_on_version_id: null,
    actor_id: scope.actor_id,
    content_hash: content_digest("artifact", artifact_digest_fields(fields)),
  });
  const written = runtime.db.run(
    "INSERT INTO artifacts (project_id, object_id, kind, stage_id) VALUES (?, ?, ?, ?)",
    scope.project_id,
    object_id,
    artifact_kind,
    stage.id,
  );
  if (written.changes !== 1n) {
    throw new Error("the record artifact was not created");
  }
  write_artifact_version(runtime, scope.project_id, object_id, version_id, fields);
  set_first_current_version(runtime, scope.project_id, object_id, version_id);
}

function record_fields(
  title: string,
  body_md: string | null,
  status: string,
  metadata: Record<string, unknown>,
  summary = "",
): ArtifactFields {
  return {
    title,
    summary,
    question: null,
    body_md,
    status,
    confidence: null,
    stats: [],
    conflicts: [],
    verify: null,
    metadata,
  };
}

function note_count(runtime: CommandRuntime, project_id: string): number {
  const row = runtime.db.get<{ n: bigint }>(
    `SELECT count(*) AS n
       FROM artifact_versions v
       JOIN artifacts a ON a.project_id = v.project_id AND a.object_id = v.object_id
      WHERE v.project_id = ? AND a.kind = 'note'
        AND json_extract(v.metadata_json, '$.role') = 'handoff_note'`,
    project_id,
  );
  return Number(row?.n ?? 0n);
}


/**
 * The stage a note belongs to: the one named, else the current one. A project without a current stage (a hand-written v0.15 file that never
 * named one) keeps the note on no stage, as v0.15 did (`stage: null`) — only when the CLI asks for it (`stage_optional`).
 */
function note_stage(
  runtime: CommandRuntime,
  project_id: string,
  key: unknown,
  stage_optional: boolean,
): { id: string | null; key: string | null; edition_id: string } {
  try {
    return resolve_stage_key(runtime, project_id, key);
  } catch (error) {
    // the relaxation is the CLI's option only (`stage_optional`); every other caller still gets `not_found`, as before SEL-71
    if (!stage_optional || !(error instanceof ApiError) || error.code !== "not_found" || (key !== undefined && key !== null)) throw error;
    const edition = runtime.db.get<{ id: string }>("SELECT active_edition_id AS id FROM projects WHERE id = ?", project_id);
    if (edition === undefined || edition.id === null) throw error;
    return { id: null, key: null, edition_id: edition.id };
  }
}

// ---------------------------------------------------------------------------
// project.add_note

function run_add_note(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["text", "stage", "allow_blank", "stage_optional"]);
  if ("stage_optional" in payload && (payload.stage_optional !== true || runtime.ctx.via !== "cli")) {
    throw new ApiError("invalid_payload", "stage_optional is not accepted here");
  }
  // `allow_blank`: v0.15's `note <dir>` with no text stored an empty note; scripts/pes.ts keeps that (a person-facing CLI rule, not an API one)
  const blank_ok = payload.allow_blank === true && payload.text === "";
  const text = blank_ok ? "" : require_text(payload, "text");
  const scope = scope_of(runtime);
  const stage = note_stage(runtime, scope.project_id, payload.stage, payload.stage_optional === true);
  const ids = new_ids(runtime);
  const result = {
    project_id: scope.project_id,
    object_id: ids.object_id,
    version_id: ids.version_id,
    stage_id: stage.id,
    note_count: note_count(runtime, scope.project_id) + 1,
  };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "project.note_added",
    base_control_rev: null,
    result,
  });
  write_record_artifact(
    runtime,
    scope,
    stage,
    "note",
    record_fields(blank_ok ? "(빈 메모)" : first_line(text, 80), text, "done", { role: "handoff_note", stage: stage.key }),
    ids,
  );
  return {
    result,
    events: [
      {
        type: "project.note_added",
        payload: { ...ids, stage: stage.key, note_count: result.note_count },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// input.record_chat

function run_record_chat(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["stage", "text", "kind", "web", "allow_blank"]);
  // `allow_blank` (scripts/pes.ts `chat`): v0.15 recorded an empty or blank answer (exit 0); the CLI keeps that. Not for the API / a screen.
  if ("allow_blank" in payload && (payload.allow_blank !== true || runtime.ctx.via !== "cli" || payload.web !== undefined)) {
    throw new ApiError("invalid_payload", "allow_blank is not accepted here");
  }
  let text: string;
  if (payload.allow_blank === true && typeof payload.text === "string") {
    if (payload.text.length > MAX_TEXT) throw new ApiError("invalid_payload", "text is too long");
    text = payload.text;
  } else {
    text = require_text(payload, "text", payload.web === undefined ? MAX_TEXT : MAX_WEB_TEXT);
  }
  const kind = payload.kind === undefined ? "feedback" : require_non_empty_string(payload, "kind");
  if (kind.length > 64) throw new ApiError("invalid_payload", "kind is too long");
  if (payload.web !== undefined) return run_web_submission(runtime, payload, kind);
  const scope = scope_of(runtime);
  const stage = resolve_stage_key(runtime, scope.project_id, payload.stage);
  const ids = new_ids(runtime);
  const result = {
    project_id: scope.project_id,
    object_id: ids.object_id,
    version_id: ids.version_id,
    stage_id: stage.id,
    round_no: stage.latest_round_no,
    kind,
  };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "input.chat_recorded",
    base_control_rev: null,
    result,
  });
  write_record_artifact(
    runtime,
    scope,
    stage,
    "note",
    record_fields(first_line(text, 80) || "(빈 답)", text, "done", {
      role: "chat_input",
      stage: stage.key,
      round: stage.latest_round_no,
      input_kind: kind,
      processed: true,
    }),
    ids,
  );
  return {
    result,
    events: [
      {
        type: "input.chat_recorded",
        payload: { ...ids, stage: stage.key, round_no: stage.latest_round_no, kind },
      },
    ],
  };
}


// ---------------------------------------------------------------------------
// input.record_chat with `web`: an answer the human sent from the local screen (stage 2 PR18)
//
// The screen's POST body, as v0.15 saved it in feedback/<name>.json, is the submission's raw file: the bridge stages
// the bytes in the object store first, this command adds the blob row (ready), and one submissions row (via the
// context's channel, 'web') that points at it. That row is what `pending`, the dashboard's "received answers" and
// the report's decision section read. No note artifact is written: the submission itself is the pending item.

const SHA256 = /^[0-9a-f]{64}$/;

function run_web_submission(runtime: CommandRuntime, payload: Record<string, unknown>, kind: string): CommandResult {
  const web = require_record(payload.web);
  reject_unknown_fields(web, ["name", "sha256", "size", "set_id"]);
  const name = require_non_empty_string(web, "name");
  if (name.length > MAX_NAME || !name.isWellFormed() || /[\\/\0]/.test(name)) {
    throw new ApiError("invalid_payload", "name must be a plain file name");
  }
  const sha256 = require_non_empty_string(web, "sha256");
  if (!SHA256.test(sha256)) throw new ApiError("invalid_payload", "sha256 must be 64 hex digits");
  const size = web.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw new ApiError("invalid_payload", "size must be a non-negative integer");
  }
  const set_id = web.set_id === undefined || web.set_id === null ? null : require_non_empty_string(web, "set_id");
  const scope = scope_of(runtime);
  const stage = resolve_stage_key(runtime, scope.project_id, payload.stage);
  if (runtime.objects_dir === null) throw new ApiError("conflict", "no object store is configured");

  // the bytes the bridge staged must be exactly the ones named
  const storage_key = `${scope.project_id}/${sha256}`;
  let bytes: Uint8Array;
  try {
    bytes = read_storage_bytes(runtime.objects_dir, scope.project_id, storage_key);
  } catch {
    throw new ApiError("conflict", "the submitted file is not in the object store");
  }
  if (bytes.byteLength !== size || sha256_hex(bytes) !== sha256) {
    throw new ApiError("invalid_payload", "the submitted bytes do not match sha256/size");
  }

  if (set_id !== null) {
    const set = runtime.db.get<{ stage_id: string; form_key: string; version_no: bigint }>(
      "SELECT stage_id, form_key, version_no FROM question_sets WHERE project_id = ? AND id = ?",
      scope.project_id,
      set_id,
    );
    if (set === undefined || set.stage_id !== stage.id) throw new ApiError("not_found", "question set not found");
    const newest = runtime.db.get<{ n: bigint | null }>(
      "SELECT MAX(version_no) AS n FROM question_sets WHERE project_id = ? AND stage_id = ? AND form_key = ?",
      scope.project_id,
      set.stage_id,
      set.form_key,
    );
    if (Number(newest?.n ?? 0n) !== Number(set.version_no)) {
      throw new ApiError("conflict", FORM_REVISED);
    }
  }
  const taken = runtime.db.get<{ ok: bigint }>(
    `SELECT 1 AS ok FROM submissions s JOIN blobs b ON b.project_id = s.project_id AND b.id = s.raw_blob_id
      WHERE s.project_id = ? AND b.original_name = ?`,
    scope.project_id,
    name,
  );
  if (taken !== undefined) throw new ApiError("conflict", "an answer with this file name already exists");

  const submission_id = runtime.new_id();
  const result = {
    project_id: scope.project_id,
    submission_id,
    name,
    stage_id: stage.id,
    set_id,
    round_no: stage.latest_round_no,
    kind,
    web: true,
  };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "input.chat_recorded",
    base_control_rev: null,
    result,
  });
  const blob = insert_ready_blob(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    sha256,
    size,
    media_type: "application/json",
    original_name: name,
  });
  const submission = runtime.db.run(
    `INSERT INTO submissions (id, project_id, actor_id, drafted_by_actor_id, set_id, received_at, via, raw_blob_id, tx_id)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    submission_id,
    scope.project_id,
    scope.actor_id,
    set_id,
    runtime.now_ms,
    runtime.ctx.via,
    blob.blob_id,
    runtime.tx_id,
  );
  if (submission.changes !== 1n) throw new Error("the submission was not written");
  return {
    result,
    events: [{ type: "input.chat_recorded", payload: { submission_id, name, stage: stage.key, round_no: stage.latest_round_no, kind, set_id, web: true } }],
  };
}

// ---------------------------------------------------------------------------
// input.mark_processed

function run_mark_processed(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["names"]);
  const scope = scope_of(runtime);
  const raw = payload.names;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_MARK_NAMES) {
    throw new ApiError("invalid_payload", `names must be an array of 1 to ${MAX_MARK_NAMES} names`);
  }
  const names: string[] = [];
  for (const entry of raw) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > MAX_NAME ||
      !entry.isWellFormed() ||
      /[\\/\0]/.test(entry)
    ) {
      throw new ApiError("invalid_payload", "each name must be a plain input file name");
    }
    if (!names.includes(entry)) names.push(entry);
  }
  const result = { project_id: scope.project_id, names, count: names.length };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "input.marked_processed",
    base_control_rev: null,
    result,
  });
  return { result, events: [{ type: "input.marked_processed", payload: { names } }] };
}

// ---------------------------------------------------------------------------
// qa.record_brief / qa.record

function run_record_brief(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["stage", "text"]);
  const text = require_text(payload, "text");
  const scope = scope_of(runtime);
  const stage = resolve_stage_key(runtime, scope.project_id, payload.stage);
  const ids = new_ids(runtime);
  const result = {
    project_id: scope.project_id,
    object_id: ids.object_id,
    version_id: ids.version_id,
    stage_id: stage.id,
    round_no: stage.latest_round_no,
  };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "qa.brief_recorded",
    base_control_rev: null,
    result,
  });
  write_record_artifact(
    runtime,
    scope,
    stage,
    "review",
    record_fields(`독립 검토 지시문 ${stage.key} R${stage.latest_round_no}`, text, "draft", {
      role: "qa_brief",
      stage: stage.key,
      round: stage.latest_round_no,
    }),
    ids,
  );
  return {
    result,
    events: [
      {
        type: "qa.brief_recorded",
        payload: { ...ids, stage: stage.key, round_no: stage.latest_round_no },
      },
    ],
  };
}

function run_record_qa(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["stage", "qa"]);
  const qa = payload.qa;
  if (!is_record(qa)) {
    throw new ApiError("invalid_payload", "qa must be a JSON object");
  }
  const verdict = qa.verdict;
  if (typeof verdict !== "string" || verdict.length === 0 || verdict.length > 64) {
    throw new ApiError("invalid_payload", "qa.verdict must be a short non-empty string");
  }
  // The whole qa object is stored in the version's metadata, so it is size-limited.
  if (JSON.stringify(qa).length > MAX_TEXT) {
    throw new ApiError("invalid_payload", "qa is too large");
  }
  const scope = scope_of(runtime);
  const stage = resolve_stage_key(runtime, scope.project_id, payload.stage);
  const round_no =
    typeof qa.round === "number" && Number.isSafeInteger(qa.round) && qa.round >= 0
      ? qa.round
      : stage.latest_round_no;
  const ids = new_ids(runtime);
  const result = {
    project_id: scope.project_id,
    object_id: ids.object_id,
    version_id: ids.version_id,
    stage_id: stage.id,
    round_no,
    verdict,
  };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "qa.recorded",
    base_control_rev: null,
    result,
  });
  write_record_artifact(
    runtime,
    scope,
    stage,
    "review",
    record_fields(
      `독립 검토 ${stage.key} R${round_no}`,
      null,
      "done",
      { role: "qa_result", stage: stage.key, round: round_no, verdict, qa },
      verdict,
    ),
    ids,
  );
  return {
    result,
    events: [
      {
        type: "qa.recorded",
        payload: { ...ids, stage: stage.key, round_no, verdict },
      },
    ],
  };
}

function definition(
  action: string,
  run: (runtime: CommandRuntime) => CommandResult,
): CommandDefinition {
  return Object.freeze({ action, scope: "project", rev_bearing: false, run });
}

const RECORD_COMMAND_INPUTS: ReadonlyArray<readonly [string, CommandDefinition]> = [
  ["input.mark_processed", definition("input.marked_processed", run_mark_processed)],
  ["input.record_chat", definition("input.chat_recorded", run_record_chat)],
  ["project.add_note", definition("project.note_added", run_add_note)],
  ["qa.record", definition("qa.recorded", run_record_qa)],
  ["qa.record_brief", definition("qa.brief_recorded", run_record_brief)],
];

/** Registry entries merged into COMMANDS by commands.ts (names, not actions). */
export const RECORD_COMMAND_ENTRIES: ReadonlyArray<readonly [string, CommandDefinition]> =
  Object.freeze(RECORD_COMMAND_INPUTS.map((entry) => Object.freeze([entry[0], entry[1]] as const)));

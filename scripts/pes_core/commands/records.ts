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

function require_text(payload: Record<string, unknown>, field: string): string {
  const text = require_non_empty_string(payload, field);
  if (text.trim().length === 0) {
    throw new ApiError("invalid_payload", `${field} must not be blank`);
  }
  if (text.length > MAX_TEXT) {
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
  stage: KeyedStage,
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

// ---------------------------------------------------------------------------
// project.add_note

function run_add_note(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["text", "stage"]);
  const text = require_text(payload, "text");
  const scope = scope_of(runtime);
  const stage = resolve_stage_key(runtime, scope.project_id, payload.stage);
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
    record_fields(first_line(text, 80), text, "done", { role: "handoff_note", stage: stage.key }),
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
  reject_unknown_fields(payload, ["stage", "text", "kind"]);
  const text = require_text(payload, "text");
  const kind = payload.kind === undefined ? "feedback" : require_non_empty_string(payload, "kind");
  if (kind.length > 64) throw new ApiError("invalid_payload", "kind is too long");
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
    record_fields(first_line(text, 80), text, "done", {
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

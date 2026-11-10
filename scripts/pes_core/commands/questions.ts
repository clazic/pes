// Question set, question revision, and answer submission command definitions
// (stage 2 PR8).
//
// This file holds the only business-table SQL for question.publish_set,
// question.revise, and answer.submit. The public functions in
// scripts/pes_core/questions.ts call CommandService.execute once each, so
// every write passes the registry, project/actor check, policy, receipt
// replay, lease guard, change, and events + receipt in one transaction.
//
// publish_set and revise_question are human member commands that an agent may
// run only while it holds the project lease (PR5 guard). answer.submit is a
// human-only command: an agent is refused even when it holds the lease.
//
// There is no server-side answer draft path. A default value or a recommended
// option is never written as an answer; `used_default` records only an
// explicit human choice that equals the question's default.
//
// prepare_submission below is shared with the read-only validate_submission
// wrapper. It only reads; the submit command performs every write.

import { createHash } from "node:crypto";

import { read_credential_actor, type CredentialActor } from "../actors.ts";
import type { Db } from "../db.ts";
import { ApiError } from "../errors.ts";
import {
  insert_receipt,
  is_record,
  optional_lease_guard,
  reject_unknown_fields,
  require_current_lease,
  require_non_empty_string,
  require_record,
  resolve_stage_key,
  type CommandDefinition,
  type CommandResult,
  type CommandRuntime,
  type LeaseGuard,
} from "./shared.ts";

const PURPOSES = new Set(["stage_start", "review", "resume"]);
const QUESTION_TYPES = new Set([
  "single",
  "multi",
  "text",
  "textarea",
  "number",
  "scale",
  "file",
]);
const IMPORTANCE_VALUES = new Set(["high", "normal", "low"]);

const PUBLISH_FIELDS = [
  "stage_id",
  "round_id",
  "purpose",
  "form_key",
  "questions",
  "run_id",
  "lease_id",
  "fence",
] as const;

const NEW_QUESTION_FIELDS = [
  "text",
  "type",
  "required",
  "allow_comment_as_answer",
  "default_value",
  "options",
  "show_if",
  "help",
  "importance",
] as const;

const OPTION_FIELDS = new Set(["value", "label", "recommended"]);

const REVISE_FIELDS = [
  "question_id",
  "base_version_id",
  "text",
  "type",
  "required",
  "allow_comment_as_answer",
  "default_value",
  "options",
  "show_if",
  "help",
  "importance",
  "run_id",
  "lease_id",
  "fence",
] as const;

const SUBMIT_FIELDS = ["set_id", "answers"] as const;
const ANSWER_ITEM_FIELDS = new Set([
  "question_id",
  "question_version_id",
  "value",
  "other",
  "used_default",
]);

function invalid_payload(message: string): never {
  throw new ApiError("invalid_payload", message);
}

function has_own(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Deterministic JSON for version content hashes (the payload is a JSON snapshot). */
function canonical_json(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonical_json(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical_json(record[key])}`).join(",")}}`;
}

function content_digest(kind: string, fields: Record<string, unknown>): string {
  return createHash("sha256").update(`${kind}\n${canonical_json(fields)}`).digest("hex");
}

function command_actor(runtime: CommandRuntime): CredentialActor {
  const actor_id = runtime.actor_id;
  if (actor_id === null) {
    throw new Error("a question command must resolve an actor first");
  }
  const actor = read_credential_actor(runtime.db, actor_id);
  if (actor === undefined) {
    throw new ApiError("forbidden", "the actor is not allowed in this project");
  }
  return actor;
}

/**
 * A human member needs no guard. An agent may publish or revise only while it
 * holds the active, unexpired lease (the PR5 rule); a human-supplied guard is
 * validated for shape but ignored because a human never needs one.
 */
function member_actor_with_guard(
  runtime: CommandRuntime,
  payload: Record<string, unknown>,
): { actor: CredentialActor; guard: LeaseGuard | null } {
  const actor = command_actor(runtime);
  const supplied = optional_lease_guard(payload);
  if (actor.kind === "human") return { actor, guard: null };
  if (supplied === null) {
    throw new ApiError("forbidden", "an agent must hold the lease for this command");
  }
  require_current_lease(runtime, supplied);
  return { actor, guard: supplied };
}

function guard_fields(guard: LeaseGuard | null): {
  run_id?: string;
  lease_id?: string;
  fence?: number;
} {
  if (guard === null) return {};
  return { run_id: guard.run_id, lease_id: guard.lease_id, fence: guard.fence };
}

function require_enum_value(
  payload: Record<string, unknown>,
  field: string,
  allowed: Set<string>,
): string {
  const value = payload[field];
  if (typeof value !== "string" || !allowed.has(value)) {
    return invalid_payload(`${field} is not a known value`);
  }
  return value;
}

function optional_boolean(
  payload: Record<string, unknown>,
  field: string,
  fallback: boolean,
): boolean {
  const value = payload[field];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    return invalid_payload(`${field} must be a boolean`);
  }
  return value;
}

function optional_text_or_null(
  payload: Record<string, unknown>,
  field: string,
): string | null {
  const value = payload[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.isWellFormed()) {
    return invalid_payload(`${field} must be a string or null`);
  }
  return value;
}

/** Store a JSON value as its canonical text; an absent field becomes JSON null. */
function json_text(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (value === undefined) return "null";
  const text = JSON.stringify(value);
  if (text === undefined) return "null";
  return text;
}

function parse_options(payload: Record<string, unknown>): string {
  const value = payload.options;
  if (value === undefined || value === null) return "[]";
  if (!Array.isArray(value)) {
    return invalid_payload("options must be an array");
  }
  for (const entry of value) {
    if (!is_record(entry)) {
      return invalid_payload("each option must be an object");
    }
    for (const key of Object.keys(entry)) {
      if (!OPTION_FIELDS.has(key)) {
        return invalid_payload(`unknown option field: ${key}`);
      }
    }
    const option_value = entry.value;
    if (
      typeof option_value !== "string" ||
      option_value.length === 0 ||
      !option_value.isWellFormed()
    ) {
      return invalid_payload("an option value must be a non-empty string");
    }
    const label = entry.label;
    if (typeof label !== "string" || !label.isWellFormed()) {
      return invalid_payload("an option label must be a string");
    }
    if (entry.recommended !== undefined && typeof entry.recommended !== "boolean") {
      return invalid_payload("option recommended must be a boolean");
    }
  }
  return JSON.stringify(value);
}

function take_display_no(runtime: CommandRuntime, project_id: string, namespace: string): number {
  const counter = runtime.db.get<{ next_no: bigint }>(
    "SELECT next_no FROM counters WHERE project_id = ? AND namespace = ?",
    project_id,
    namespace,
  );
  if (counter === undefined) {
    throw new Error(`the counter namespace is missing: ${namespace}`);
  }
  const display_no = Number(counter.next_no);
  if (!Number.isSafeInteger(display_no) || display_no < 1) {
    throw new Error("the display counter is out of range");
  }
  const advanced = runtime.db.run(
    "UPDATE counters SET next_no = next_no + 1 WHERE project_id = ? AND namespace = ? AND next_no = ?",
    project_id,
    namespace,
    counter.next_no,
  );
  if (advanced.changes !== 1n) {
    throw new ApiError("conflict", "the display counter changed concurrently");
  }
  return display_no;
}

function write_object(
  runtime: CommandRuntime,
  project_id: string,
  object_id: string,
  kind: string,
): void {
  const display_no = take_display_no(runtime, project_id, kind);
  const written = runtime.db.run(
    "INSERT INTO objects (id, project_id, edition_id, kind, display_no, archived_at) VALUES (?, ?, NULL, ?, ?, NULL)",
    object_id,
    project_id,
    kind,
    display_no,
  );
  if (written.changes !== 1n) {
    throw new Error("the object was not created");
  }
}

function write_object_version(
  runtime: CommandRuntime,
  input: {
    project_id: string;
    object_id: string;
    kind: string;
    version_id: string;
    version_no: number;
    based_on_version_id: string | null;
    actor_id: string;
    run_id: string | null;
    content_hash: string;
  },
): void {
  const written = runtime.db.run(
    `INSERT INTO object_versions
       (id, project_id, object_id, kind, version_no, based_on_version_id, created_in_round_id,
        actor_id, run_id, tx_id, content_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    input.version_id,
    input.project_id,
    input.object_id,
    input.kind,
    input.version_no,
    input.based_on_version_id,
    input.actor_id,
    input.run_id,
    runtime.tx_id,
    input.content_hash,
    runtime.now_ms,
  );
  if (written.changes !== 1n) {
    throw new Error("the object version was not written");
  }
}

function set_first_current_version(
  runtime: CommandRuntime,
  project_id: string,
  object_id: string,
  version_id: string,
): void {
  const written = runtime.db.run(
    "UPDATE objects SET current_version_id = ?, rev = rev + 1 WHERE project_id = ? AND id = ? AND current_version_id IS NULL",
    version_id,
    project_id,
    object_id,
  );
  if (written.changes !== 1n) {
    throw new ApiError("conflict", "the object already has a current version");
  }
}

function move_current_version(
  runtime: CommandRuntime,
  project_id: string,
  object_id: string,
  from_version_id: string | null,
  to_version_id: string,
): void {
  const written =
    from_version_id === null
      ? runtime.db.run(
          "UPDATE objects SET current_version_id = ?, rev = rev + 1 WHERE project_id = ? AND id = ? AND current_version_id IS NULL",
          to_version_id,
          project_id,
          object_id,
        )
      : runtime.db.run(
          "UPDATE objects SET current_version_id = ?, rev = rev + 1 WHERE project_id = ? AND id = ? AND current_version_id = ?",
          to_version_id,
          project_id,
          object_id,
          from_version_id,
        );
  if (written.changes !== 1n) {
    throw new ApiError("conflict", "the object moved concurrently");
  }
}

function write_question_version(
  runtime: CommandRuntime,
  input: {
    project_id: string;
    object_id: string;
    version_id: string;
    text: string;
    type: string;
    state: string;
    importance: string;
    required: number;
    allow_comment_as_answer: number;
    default_value: string;
    options: string;
    show_if: string;
    help: string | null;
  },
): void {
  const written = runtime.db.run(
    `INSERT INTO question_versions
       (project_id, version_id, object_id, text, type, state, importance, required,
        allow_comment_as_answer, default_value, options, show_if, help)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.project_id,
    input.version_id,
    input.object_id,
    input.text,
    input.type,
    input.state,
    input.importance,
    input.required,
    input.allow_comment_as_answer,
    input.default_value,
    input.options,
    input.show_if,
    input.help,
  );
  if (written.changes !== 1n) {
    throw new Error("the question version was not written");
  }
}

function question_version_digest(input: {
  text: string;
  type: string;
  state: string;
  importance: string;
  required: number;
  allow_comment_as_answer: number;
  default_value: string;
  options: string;
  show_if: string;
  help: string | null;
}): string {
  return content_digest("question", {
    text: input.text,
    type: input.type,
    state: input.state,
    importance: input.importance,
    required: input.required,
    allow_comment_as_answer: input.allow_comment_as_answer,
    default_value: input.default_value,
    options: input.options,
    show_if: input.show_if,
    help: input.help,
  });
}

interface NewQuestionPlan {
  object_id: string;
  version_id: string;
  text: string;
  type: string;
  state: string;
  importance: string;
  required: number;
  allow_comment_as_answer: number;
  default_value: string;
  options: string;
  show_if: string;
  help: string | null;
}

interface MemberPlan {
  question_id: string;
  question_version_id: string;
  position: number;
  new_question: NewQuestionPlan | null;
}

function parse_new_question(
  runtime: CommandRuntime,
  payload: Record<string, unknown>,
): NewQuestionPlan {
  reject_unknown_fields(payload, NEW_QUESTION_FIELDS);
  const text = require_non_empty_string(payload, "text");
  const type = require_enum_value(payload, "type", QUESTION_TYPES);
  const importance =
    payload.importance === undefined
      ? "normal"
      : require_enum_value(payload, "importance", IMPORTANCE_VALUES);
  const required = optional_boolean(payload, "required", false) ? 1 : 0;
  const allow_comment_as_answer = optional_boolean(
    payload,
    "allow_comment_as_answer",
    false,
  )
    ? 1
    : 0;
  return {
    object_id: runtime.new_id(),
    version_id: runtime.new_id(),
    text,
    type,
    state: "open",
    importance,
    required,
    allow_comment_as_answer,
    default_value: json_text(payload, "default_value"),
    options: parse_options(payload),
    show_if: json_text(payload, "show_if"),
    help: optional_text_or_null(payload, "help"),
  };
}

/**
 * The current version of an existing question in this project. A question that
 * is not usable now (deferred, withdrawn, merged, closed, draft) cannot enter
 * a new set; it is conflict, not not_found.
 */
function current_question_version(
  runtime: CommandRuntime,
  project_id: string,
  question_id: string,
): string {
  const row = runtime.db.get<{ current_version_id: string | null; state: string | null }>(
    `SELECT o.current_version_id, qv.state
       FROM objects o
       JOIN questions q ON q.project_id = o.project_id AND q.object_id = o.id
       LEFT JOIN question_versions qv
         ON qv.project_id = o.project_id AND qv.object_id = o.id
        AND qv.version_id = o.current_version_id
      WHERE o.project_id = ? AND o.id = ? AND o.kind = 'question'`,
    project_id,
    question_id,
  );
  if (row === undefined || row.current_version_id === null || row.state === null) {
    throw new ApiError("not_found", "question not found");
  }
  if (row.state !== "open") {
    throw new ApiError("conflict", "the question is not open");
  }
  return row.current_version_id;
}

/**
 * A publish target must be a stage of the project's active edition (PR6 rule),
 * not a stage of a completed, archived, draft, or other edition.
 */
function require_publish_stage(
  runtime: CommandRuntime,
  project_id: string,
  stage_id: string,
): void {
  const stage = runtime.db.get<{ id: string; edition_id: string }>(
    "SELECT id, edition_id FROM stages WHERE project_id = ? AND id = ?",
    project_id,
    stage_id,
  );
  if (stage === undefined) {
    throw new ApiError("not_found", "stage not found");
  }
  const edition = runtime.db.get<{ status: string }>(
    "SELECT status FROM editions WHERE project_id = ? AND id = ?",
    project_id,
    stage.edition_id,
  );
  if (edition === undefined || edition.status !== "active") {
    throw new ApiError("conflict", "the edition is not active");
  }
  const project = runtime.db.get<{ active_edition_id: string | null }>(
    "SELECT active_edition_id FROM projects WHERE id = ?",
    project_id,
  );
  if (project === undefined || project.active_edition_id !== stage.edition_id) {
    throw new ApiError("conflict", "stage is not in the active edition");
  }
}

/** A publish target round must still be open; a sealed round is closed to new forms. */
function require_publish_round(
  runtime: CommandRuntime,
  project_id: string,
  stage_id: string,
  round_id: string,
): void {
  const round = runtime.db.get<{ id: string; state: string }>(
    "SELECT id, state FROM rounds WHERE project_id = ? AND stage_id = ? AND id = ?",
    project_id,
    stage_id,
    round_id,
  );
  if (round === undefined) {
    throw new ApiError("not_found", "round not found");
  }
  if (round.state !== "open") {
    throw new ApiError("conflict", "the round is not open");
  }
}

function run_publish_set(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, PUBLISH_FIELDS);

  const stage_id = require_non_empty_string(payload, "stage_id");
  const raw_round_id = payload.round_id;
  const round_id =
    raw_round_id === undefined || raw_round_id === null
      ? null
      : require_non_empty_string(payload, "round_id");
  const purpose = require_enum_value(payload, "purpose", PURPOSES);
  const form_key = require_non_empty_string(payload, "form_key");
  const raw_questions = payload.questions;
  if (!Array.isArray(raw_questions) || raw_questions.length === 0) {
    return invalid_payload("questions must be a non-empty array");
  }

  const project = runtime.project;
  const actor_id = runtime.actor_id;
  if (project === null || actor_id === null) {
    throw new Error("question.publish_set must resolve a project and actor first");
  }
  const { guard } = member_actor_with_guard(runtime, payload);

  require_publish_stage(runtime, project.id, stage_id);
  if (round_id !== null) {
    require_publish_round(runtime, project.id, stage_id, round_id);
  }

  const plans: MemberPlan[] = [];
  const seen = new Set<string>();
  for (const [position, raw] of raw_questions.entries()) {
    if (!is_record(raw)) {
      return invalid_payload("each question must be an object");
    }
    if (has_own(raw, "question_id")) {
      reject_unknown_fields(raw, ["question_id"]);
      const question_id = require_non_empty_string(raw, "question_id");
      if (seen.has(question_id)) {
        return invalid_payload("a question may appear only once in a set");
      }
      seen.add(question_id);
      const question_version_id = current_question_version(
        runtime,
        project.id,
        question_id,
      );
      plans.push({ question_id, question_version_id, position, new_question: null });
    } else {
      const parsed = parse_new_question(runtime, raw);
      if (seen.has(parsed.object_id)) {
        return invalid_payload("a question may appear only once in a set");
      }
      seen.add(parsed.object_id);
      plans.push({
        question_id: parsed.object_id,
        question_version_id: parsed.version_id,
        position,
        new_question: parsed,
      });
    }
  }

  const latest = runtime.db.get<{ id: string; version_no: bigint }>(
    `SELECT id, version_no FROM question_sets
      WHERE project_id = ? AND stage_id = ? AND form_key = ?
      ORDER BY version_no DESC LIMIT 1`,
    project.id,
    stage_id,
    form_key,
  );
  const set_version_no = Number(latest?.version_no ?? 0n) + 1;
  if (!Number.isSafeInteger(set_version_no) || set_version_no < 1) {
    throw new Error("the question set version number is out of range");
  }
  const set_id = runtime.new_id();
  const members = plans.map((plan) => ({
    question_id: plan.question_id,
    question_version_id: plan.question_version_id,
    position: plan.position,
  }));
  const result = {
    project_id: project.id,
    set_id,
    set_version_no,
    stage_id,
    round_id,
    form_key,
    members,
  };

  insert_receipt(runtime, {
    project_id: project.id,
    actor_id,
    action: "question.set_published",
    base_control_rev: null,
    result,
    ...guard_fields(guard),
  });

  for (const plan of plans) {
    const fresh = plan.new_question;
    if (fresh === null) continue;
    write_object(runtime, project.id, fresh.object_id, "question");
    write_object_version(runtime, {
      project_id: project.id,
      object_id: fresh.object_id,
      kind: "question",
      version_id: fresh.version_id,
      version_no: 1,
      based_on_version_id: null,
      actor_id,
      run_id: guard === null ? null : guard.run_id,
      content_hash: question_version_digest(fresh),
    });
    const asked = runtime.db.run(
      `INSERT INTO questions
         (project_id, object_id, asked_by_actor_id, intended_actor_id, direction, origin,
          bank_key, original_version_id)
       VALUES (?, ?, ?, NULL, 'agent_to_human', 'manual', NULL, ?)`,
      project.id,
      fresh.object_id,
      actor_id,
      fresh.version_id,
    );
    if (asked.changes !== 1n) {
      throw new Error("the question was not created");
    }
    write_question_version(runtime, {
      project_id: project.id,
      object_id: fresh.object_id,
      version_id: fresh.version_id,
      text: fresh.text,
      type: fresh.type,
      state: fresh.state,
      importance: fresh.importance,
      required: fresh.required,
      allow_comment_as_answer: fresh.allow_comment_as_answer,
      default_value: fresh.default_value,
      options: fresh.options,
      show_if: fresh.show_if,
      help: fresh.help,
    });
    set_first_current_version(runtime, project.id, fresh.object_id, fresh.version_id);
  }

  const written_set = runtime.db.run(
    `INSERT INTO question_sets
       (id, project_id, stage_id, round_id, purpose, form_key, version_no,
        previous_set_id, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    set_id,
    project.id,
    stage_id,
    round_id,
    purpose,
    form_key,
    set_version_no,
    latest?.id ?? null,
    runtime.now_ms,
  );
  if (written_set.changes !== 1n) {
    throw new Error("the question set was not written");
  }

  for (const member of members) {
    const written = runtime.db.run(
      `INSERT INTO question_set_members
         (project_id, set_id, question_id, question_version_id, position)
       VALUES (?, ?, ?, ?, ?)`,
      project.id,
      set_id,
      member.question_id,
      member.question_version_id,
      member.position,
    );
    if (written.changes !== 1n) {
      throw new Error("the question set member was not written");
    }
  }

  return {
    result,
    events: [
      {
        type: "question.set_published",
        run_id: guard === null ? null : guard.run_id,
        payload: {
          set_id,
          stage_id,
          round_id,
          purpose,
          form_key,
          version_no: set_version_no,
          members,
        },
      },
    ],
  };
}

interface CurrentQuestionRow {
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
}

function run_revise(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, REVISE_FIELDS);

  const question_id = require_non_empty_string(payload, "question_id");
  const project = runtime.project;
  const actor_id = runtime.actor_id;
  if (project === null || actor_id === null) {
    throw new Error("question.revise must resolve a project and actor first");
  }
  const { guard } = member_actor_with_guard(runtime, payload);

  const row = runtime.db.get<CurrentQuestionRow>(
    `SELECT qv.text, qv.type, qv.state, qv.importance, qv.required,
            qv.allow_comment_as_answer, qv.default_value, qv.options, qv.show_if, qv.help
       FROM questions q
       JOIN objects o
         ON o.project_id = q.project_id AND o.id = q.object_id AND o.kind = 'question'
       JOIN question_versions qv
         ON qv.project_id = o.project_id AND qv.object_id = o.id
        AND qv.version_id = o.current_version_id
      WHERE q.project_id = ? AND q.object_id = ?`,
    project.id,
    question_id,
  );
  if (row === undefined) {
    throw new ApiError("not_found", "question not found");
  }
  const current_version = runtime.db.get<{ current_version_id: string | null }>(
    "SELECT current_version_id FROM objects WHERE project_id = ? AND id = ?",
    project.id,
    question_id,
  );
  if (
    current_version === undefined ||
    current_version.current_version_id === null
  ) {
    throw new ApiError("not_found", "question not found");
  }

  if (has_own(payload, "base_version_id")) {
    const base = require_non_empty_string(payload, "base_version_id");
    if (base !== current_version.current_version_id) {
      throw new ApiError("rev_conflict", "the question version is stale", {
        expected: base,
        current: current_version.current_version_id,
      });
    }
  }

  const text = has_own(payload, "text")
    ? require_non_empty_string(payload, "text")
    : row.text;
  const type = has_own(payload, "type")
    ? require_enum_value(payload, "type", QUESTION_TYPES)
    : row.type;
  const importance = has_own(payload, "importance")
    ? require_enum_value(payload, "importance", IMPORTANCE_VALUES)
    : row.importance;
  const required = has_own(payload, "required")
    ? optional_boolean(payload, "required", false)
      ? 1
      : 0
    : Number(row.required);
  const allow_comment_as_answer = has_own(payload, "allow_comment_as_answer")
    ? optional_boolean(payload, "allow_comment_as_answer", true)
      ? 1
      : 0
    : Number(row.allow_comment_as_answer);
  const default_value = has_own(payload, "default_value")
    ? json_text(payload, "default_value")
    : row.default_value;
  const options = has_own(payload, "options") ? parse_options(payload) : row.options;
  const show_if = has_own(payload, "show_if") ? json_text(payload, "show_if") : row.show_if;
  const help = has_own(payload, "help") ? optional_text_or_null(payload, "help") : row.help;

  const latest = runtime.db.get<{ n: bigint | null }>(
    "SELECT MAX(version_no) AS n FROM object_versions WHERE project_id = ? AND object_id = ?",
    project.id,
    question_id,
  );
  const version_no = Number(latest?.n ?? 0n) + 1;
  if (!Number.isSafeInteger(version_no) || version_no < 1) {
    throw new Error("the question version number is out of range");
  }
  const version_id = runtime.new_id();
  const result = {
    project_id: project.id,
    question_id,
    question_version_id: version_id,
    version_no,
  };

  insert_receipt(runtime, {
    project_id: project.id,
    actor_id,
    action: "question.revised",
    base_control_rev: null,
    result,
    ...guard_fields(guard),
  });

  write_object_version(runtime, {
    project_id: project.id,
    object_id: question_id,
    kind: "question",
    version_id,
    version_no,
    based_on_version_id: current_version.current_version_id,
    actor_id,
    run_id: guard === null ? null : guard.run_id,
    content_hash: question_version_digest({
      text,
      type,
      state: row.state,
      importance,
      required,
      allow_comment_as_answer,
      default_value,
      options,
      show_if,
      help,
    }),
  });
  write_question_version(runtime, {
    project_id: project.id,
    object_id: question_id,
    version_id,
    text,
    type,
    state: row.state,
    importance,
    required,
    allow_comment_as_answer,
    default_value,
    options,
    show_if,
    help,
  });
  move_current_version(
    runtime,
    project.id,
    question_id,
    current_version.current_version_id,
    version_id,
  );

  return {
    result,
    events: [
      {
        type: "question.revised",
        run_id: guard === null ? null : guard.run_id,
        payload: {
          question_id,
          question_version_id: version_id,
          version_no,
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Submission validation (read-only, shared with validate_submission)

export interface SubmissionError {
  question_id: string | null;
  code: string;
  /** Extra machine-readable facts for the HTTP layer; validate_submission drops them. */
  details?: Record<string, unknown>;
}

export interface PlannedAnswer {
  question_id: string;
  question_version_id: string;
  has_value: boolean;
  value: unknown;
  used_default: number;
  other: string | null;
  allow_comment_as_answer: boolean;
  answer_object_id: string | null;
  answer_current_version_id: string | null;
  answer_current_version_no: number;
}

export interface SubmissionPlan {
  project_id: string;
  set_id: string;
  items: PlannedAnswer[];
}

export type SubmissionPreparation =
  | { ok: true; plan: SubmissionPlan }
  | { ok: false; errors: SubmissionError[] };

function problem(
  question_id: string | null,
  code: string,
  details?: Record<string, unknown>,
): SubmissionPreparation {
  return {
    ok: false,
    errors: [details === undefined ? { question_id, code } : { question_id, code, details }],
  };
}

function item_question_id(record: Record<string, unknown>): string | null {
  const value = record.question_id;
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()) {
    return null;
  }
  return value;
}

function option_values(options_text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(options_text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const entry of parsed) {
    if (is_record(entry) && typeof entry.value === "string") out.push(entry.value);
  }
  return out;
}

function value_matches_type(value: unknown, type: string, options_text: string): boolean {
  switch (type) {
    case "single": {
      const values = option_values(options_text);
      return typeof value === "string" && values.includes(value);
    }
    case "multi": {
      const values = option_values(options_text);
      return (
        Array.isArray(value) &&
        value.every((entry) => typeof entry === "string" && values.includes(entry))
      );
    }
    case "text":
    case "textarea":
    case "file":
      return typeof value === "string";
    case "number":
    case "scale":
      return typeof value === "number" && Number.isFinite(value);
    default:
      return false;
  }
}

function value_matches_default(default_text: string, value: unknown): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(default_text);
  } catch {
    return false;
  }
  if (parsed === null) return false;
  return JSON.stringify(parsed) === JSON.stringify(value);
}

interface MemberRow {
  question_version_id: string;
}

interface QuestionVersionRow {
  type: string;
  state: string;
  required: bigint;
  allow_comment_as_answer: bigint;
  default_value: string;
  options: string;
}

interface AnswerRow {
  object_id: string;
  current_version_id: string | null;
}

/**
 * Validate a bundle submission without writing. A bad input is reported in
 * `errors`; a stale set (a member version that is no longer current) is
 * `conflict`.
 */
export function prepare_submission(
  db: Db,
  project_id: string,
  input: unknown,
): SubmissionPreparation {
  if (!is_record(input)) return problem(null, "invalid_payload");
  for (const key of Object.keys(input)) {
    if (!(SUBMIT_FIELDS as readonly string[]).includes(key)) {
      return problem(null, "invalid_payload");
    }
  }
  const set_id_value = input.set_id;
  if (typeof set_id_value !== "string" || set_id_value.length === 0) {
    return problem(null, "invalid_payload");
  }
  if (!set_id_value.isWellFormed()) return problem(null, "invalid_payload");
  const set_id = set_id_value;
  const raw_answers = input.answers;
  if (!Array.isArray(raw_answers) || raw_answers.length === 0) {
    return problem(null, "invalid_payload");
  }

  const set = db.get<{
    id: string;
    stage_id: string;
    round_id: string | null;
    form_key: string;
    version_no: bigint;
  }>(
    `SELECT id, stage_id, round_id, form_key, version_no
       FROM question_sets WHERE project_id = ? AND id = ?`,
    project_id,
    set_id,
  );
  if (set === undefined) return problem(null, "not_found");

  // PR6 boundary: a form lives in a stage of the active edition. A completed,
  // archived, draft, or foreign edition takes no new answers.
  const stage = db.get<{ edition_id: string }>(
    "SELECT edition_id FROM stages WHERE project_id = ? AND id = ?",
    project_id,
    set.stage_id,
  );
  const edition =
    stage === undefined
      ? undefined
      : db.get<{ status: string; active_edition_id: string | null }>(
          `SELECT e.status, p.active_edition_id
             FROM editions e JOIN projects p ON p.id = e.project_id
            WHERE e.project_id = ? AND e.id = ?`,
          project_id,
          stage.edition_id,
        );
  if (
    stage === undefined ||
    edition === undefined ||
    edition.status !== "active" ||
    edition.active_edition_id !== stage.edition_id
  ) {
    return problem(null, "conflict");
  }
  if (set.round_id !== null) {
    const round = db.get<{ state: string }>(
      "SELECT state FROM rounds WHERE project_id = ? AND id = ?",
      project_id,
      set.round_id,
    );
    if (round === undefined || round.state !== "open") {
      return problem(null, "conflict");
    }
  }

  // Only the latest set of a (stage, form_key) is the form the human sees.
  const latest_set = db.get<{ n: bigint | null }>(
    `SELECT MAX(version_no) AS n FROM question_sets
      WHERE project_id = ? AND stage_id = ? AND form_key = ?`,
    project_id,
    set.stage_id,
    set.form_key,
  );
  if (Number(latest_set?.n ?? 0n) !== Number(set.version_no)) {
    return problem(null, "conflict");
  }

  const seen = new Set<string>();
  const items: PlannedAnswer[] = [];
  for (const raw of raw_answers) {
    if (!is_record(raw)) return problem(null, "invalid_payload");
    const question_id = item_question_id(raw);
    for (const key of Object.keys(raw)) {
      if (!ANSWER_ITEM_FIELDS.has(key)) {
        return problem(question_id, "invalid_payload");
      }
    }
    if (question_id === null) return problem(null, "invalid_payload");
    if (seen.has(question_id)) return problem(question_id, "invalid_payload");
    seen.add(question_id);

    const member = db.get<MemberRow>(
      `SELECT question_version_id FROM question_set_members
        WHERE project_id = ? AND set_id = ? AND question_id = ?`,
      project_id,
      set_id,
      question_id,
    );
    if (member === undefined) return problem(question_id, "invalid_payload");

    const current = db.get<{ current_version_id: string | null }>(
      "SELECT current_version_id FROM objects WHERE project_id = ? AND id = ? AND kind = 'question'",
      project_id,
      question_id,
    );
    if (current === undefined || current.current_version_id === null) {
      return problem(question_id, "conflict");
    }
    // The form pins the version it showed. A pinned version that is the current
    // one is accepted even when the set still lists an older version of it;
    // without a pin the set's own version must still be current.
    const pinned =
      typeof raw.question_version_id === "string" ? raw.question_version_id : null;
    const effective_version = pinned ?? member.question_version_id;
    if (effective_version !== current.current_version_id) {
      return problem(question_id, "conflict", {
        reason: "question_version_changed",
        question_id,
        expected: effective_version,
        current: current.current_version_id,
      });
    }

    const version = db.get<QuestionVersionRow>(
      `SELECT type, state, required, allow_comment_as_answer, default_value, options
         FROM question_versions
        WHERE project_id = ? AND object_id = ? AND version_id = ?`,
      project_id,
      question_id,
      effective_version,
    );
    if (version === undefined) return problem(question_id, "conflict");
    if (version.state !== "open") return problem(question_id, "conflict");

    let other: string | null = null;
    if (raw.other !== undefined && raw.other !== null) {
      if (typeof raw.other !== "string" || !raw.other.isWellFormed()) {
        return problem(question_id, "invalid_payload");
      }
      other = raw.other.trim().length > 0 ? raw.other : null;
    }

    let used_default = false;
    if (raw.used_default !== undefined) {
      if (typeof raw.used_default !== "boolean") {
        return problem(question_id, "invalid_payload");
      }
      used_default = raw.used_default;
    }

    const has_value = raw.value !== undefined && raw.value !== null;
    if (!has_value && other === null) {
      return problem(question_id, "invalid_payload");
    }
    if (used_default && !has_value) {
      return problem(question_id, "invalid_payload");
    }
    if (has_value) {
      if (!value_matches_type(raw.value, version.type, version.options)) {
        return problem(question_id, "invalid_payload", {
          reason: "value_not_allowed",
          field: "value",
          question_id,
        });
      }
      if (Number(version.required) === 1) {
        if (typeof raw.value === "string" && raw.value.trim().length === 0) {
          return problem(question_id, "invalid_payload");
        }
        if (Array.isArray(raw.value) && raw.value.length === 0) {
          return problem(question_id, "invalid_payload");
        }
      }
      if (used_default && !value_matches_default(version.default_value, raw.value)) {
        return problem(question_id, "invalid_payload");
      }
    }

    const allow_comment_as_answer = Number(version.allow_comment_as_answer) === 1;
    const answer = db.get<AnswerRow>(
      `SELECT a.object_id, o.current_version_id
         FROM answers a
         JOIN objects o ON o.project_id = a.project_id AND o.id = a.object_id
        WHERE a.project_id = ? AND a.question_id = ?`,
      project_id,
      question_id,
    );
    let answer_current_version_no = 0;
    if (answer !== undefined) {
      const latest = db.get<{ n: bigint | null }>(
        "SELECT MAX(version_no) AS n FROM object_versions WHERE project_id = ? AND object_id = ?",
        project_id,
        answer.object_id,
      );
      answer_current_version_no = Number(latest?.n ?? 0n);
    }

    items.push({
      question_id,
      question_version_id: effective_version,
      has_value,
      value: raw.value,
      used_default: used_default ? 1 : 0,
      other,
      allow_comment_as_answer,
      answer_object_id: answer?.object_id ?? null,
      answer_current_version_id: answer?.current_version_id ?? null,
      answer_current_version_no,
    });
  }

  return { ok: true, plan: { project_id, set_id, items } };
}

// ---------------------------------------------------------------------------
// answer.submit

interface AnswerWrite {
  item: PlannedAnswer;
  answer_id: string | null;
  answer_version_id: string | null;
  answer_is_new: boolean;
  answer_object_version_no: number;
  supersedes_version_id: string | null;
  thread_id: string | null;
  thread_version_id: string | null;
  message_id: string | null;
  message_version_id: string | null;
}

function run_submit_answers(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  const project = runtime.project;
  const actor_id = runtime.actor_id;
  if (project === null || actor_id === null) {
    throw new Error("answer.submit must resolve a project and actor first");
  }

  // PR10 rule: only a human member answers. An agent sharing the owner's user
  // is still refused, with or without lease-like fields in the payload. This
  // check runs before the closed-field check so an agent is always forbidden.
  const actor = command_actor(runtime);
  if (actor.kind !== "human") {
    throw new ApiError("forbidden", "only a human may submit answers");
  }
  reject_unknown_fields(payload, SUBMIT_FIELDS);

  const prepared = prepare_submission(runtime.db, project.id, payload);
  if (!prepared.ok) {
    throw new ApiError(
      prepared.errors[0]!.code,
      "the submission is not valid",
      prepared.errors[0]!.details,
    );
  }
  const plan = prepared.plan;

  const submission_id = runtime.new_id();
  const writes: AnswerWrite[] = [];
  const answer_entries: {
    question_id: string;
    answer_id: string | null;
    version_id: string | null;
    question_version_id: string;
    thread_id: string | null;
    message_id: string | null;
  }[] = [];

  for (const item of plan.items) {
    const needs_answer = item.has_value || (item.other !== null && item.allow_comment_as_answer);
    const answer_is_new = needs_answer && item.answer_object_id === null;
    const answer_id = needs_answer ? item.answer_object_id ?? runtime.new_id() : null;
    const answer_version_id = needs_answer ? runtime.new_id() : null;
    const answer_object_version_no = answer_is_new
      ? 1
      : item.answer_current_version_no + 1;
    const supersedes_version_id =
      needs_answer && !answer_is_new ? item.answer_current_version_id : null;

    const has_comment = item.other !== null;
    const thread_id = has_comment ? runtime.new_id() : null;
    const thread_version_id = has_comment ? runtime.new_id() : null;
    const message_id = has_comment ? runtime.new_id() : null;
    const message_version_id = has_comment ? runtime.new_id() : null;

    writes.push({
      item,
      answer_id,
      answer_version_id,
      answer_is_new,
      answer_object_version_no,
      supersedes_version_id,
      thread_id,
      thread_version_id,
      message_id,
      message_version_id,
    });
    answer_entries.push({
      question_id: item.question_id,
      answer_id,
      version_id: answer_version_id,
      question_version_id: item.question_version_id,
      thread_id,
      message_id,
    });
  }

  const result = {
    project_id: project.id,
    submission_id,
    set_id: plan.set_id,
    answers: answer_entries,
  };

  insert_receipt(runtime, {
    project_id: project.id,
    actor_id,
    action: "answer.submitted",
    base_control_rev: null,
    result,
  });

  const submission = runtime.db.run(
    `INSERT INTO submissions
       (id, project_id, actor_id, set_id, received_at, via, tx_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    submission_id,
    project.id,
    actor_id,
    plan.set_id,
    runtime.now_ms,
    runtime.ctx.via,
    runtime.tx_id,
  );
  if (submission.changes !== 1n) {
    throw new Error("the submission was not written");
  }

  for (const write of writes) {
    const item = write.item;
    if (write.answer_id !== null && write.answer_version_id !== null) {
      const value_text = item.has_value ? JSON.stringify(item.value) : "null";
      if (value_text === undefined) {
        throw new Error("the answer value is not JSON-serializable");
      }
      if (write.answer_is_new) {
        write_object(runtime, project.id, write.answer_id, "answer");
        write_object_version(runtime, {
          project_id: project.id,
          object_id: write.answer_id,
          kind: "answer",
          version_id: write.answer_version_id!,
          version_no: write.answer_object_version_no,
          based_on_version_id: null,
          actor_id,
          run_id: null,
          content_hash: content_digest("answer", {
            question_version_id: item.question_version_id,
            value: value_text,
            state: "submitted",
            used_default: item.used_default,
          }),
        });
        const written_answer = runtime.db.run(
          `INSERT INTO answers
             (project_id, object_id, question_id, respondent_actor_id, submission_id)
           VALUES (?, ?, ?, ?, ?)`,
          project.id,
          write.answer_id,
          item.question_id,
          actor_id,
          submission_id,
        );
        if (written_answer.changes !== 1n) {
          throw new Error("the answer was not created");
        }
      } else {
        write_object_version(runtime, {
          project_id: project.id,
          object_id: write.answer_id,
          kind: "answer",
          version_id: write.answer_version_id!,
          version_no: write.answer_object_version_no,
          based_on_version_id: item.answer_current_version_id,
          actor_id,
          run_id: null,
          content_hash: content_digest("answer", {
            question_version_id: item.question_version_id,
            value: value_text,
            state: "submitted",
            used_default: item.used_default,
          }),
        });
      }
      const written_version = runtime.db.run(
        `INSERT INTO answer_versions
           (project_id, version_id, object_id, question_id, question_version_id, value,
            state, used_default, supersedes_version_id)
         VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?)`,
        project.id,
        write.answer_version_id,
        write.answer_id,
        item.question_id,
        item.question_version_id,
        value_text,
        item.used_default,
        write.supersedes_version_id,
      );
      if (written_version.changes !== 1n) {
        throw new Error("the answer version was not written");
      }
      move_current_version(
        runtime,
        project.id,
        write.answer_id,
        write.answer_is_new ? null : item.answer_current_version_id,
        write.answer_version_id,
      );
    }

    if (
      write.thread_id !== null &&
      write.thread_version_id !== null &&
      write.message_id !== null &&
      write.message_version_id !== null &&
      item.other !== null
    ) {
      write_object(runtime, project.id, write.thread_id, "thread");
      write_object_version(runtime, {
        project_id: project.id,
        object_id: write.thread_id,
        kind: "thread",
        version_id: write.thread_version_id!,
        version_no: 1,
        based_on_version_id: null,
        actor_id,
        run_id: null,
        content_hash: content_digest("thread", { state: "open", summary: "" }),
      });
      const thread = runtime.db.run(
        `INSERT INTO threads
           (project_id, object_id, target_object_id, target_version_id, context_kind)
         VALUES (?, ?, ?, ?, 'question_comment')`,
        project.id,
        write.thread_id,
        item.question_id,
        item.question_version_id,
      );
      if (thread.changes !== 1n) {
        throw new Error("the thread was not written");
      }
      const written_thread = runtime.db.run(
        `INSERT INTO thread_versions
           (project_id, version_id, object_id, state, summary)
         VALUES (?, ?, ?, 'open', '')`,
        project.id,
        write.thread_version_id,
        write.thread_id,
      );
      if (written_thread.changes !== 1n) {
        throw new Error("the thread version was not written");
      }
      set_first_current_version(runtime, project.id, write.thread_id, write.thread_version_id);

      write_object(runtime, project.id, write.message_id, "message");
      write_object_version(runtime, {
        project_id: project.id,
        object_id: write.message_id,
        kind: "message",
        version_id: write.message_version_id!,
        version_no: 1,
        based_on_version_id: null,
        actor_id,
        run_id: null,
        content_hash: content_digest("message", {
          body_md: item.other,
          state: "published",
        }),
      });
      const written_message = runtime.db.run(
        `INSERT INTO messages
           (project_id, object_id, thread_id, submission_id)
         VALUES (?, ?, ?, ?)`,
        project.id,
        write.message_id,
        write.thread_id,
        submission_id,
      );
      if (written_message.changes !== 1n) {
        throw new Error("the message was not written");
      }
      const written_message_version = runtime.db.run(
        `INSERT INTO message_versions
           (project_id, version_id, object_id, thread_id, body_md, state)
         VALUES (?, ?, ?, ?, ?, 'published')`,
        project.id,
        write.message_version_id,
        write.message_id,
        write.thread_id,
        item.other,
      );
      if (written_message_version.changes !== 1n) {
        throw new Error("the message version was not written");
      }
      set_first_current_version(
        runtime,
        project.id,
        write.message_id,
        write.message_version_id,
      );
    }
  }

  return {
    result,
    events: [
      {
        type: "answer.submitted",
        payload: {
          submission_id,
          set_id: plan.set_id,
          answers: answer_entries,
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// registry

function definition(
  action: string,
  run: (runtime: CommandRuntime) => CommandResult,
): CommandDefinition {
  return Object.freeze({ action, scope: "project", rev_bearing: false, run });
}

/**
 * Record that a question-form draft was prepared from the bank for a stage.
 * The draft text itself stays a working file the agent edits; this leaves the
 * receipt and event only. It publishes nothing and fills in no answer.
 */
function run_prepare_draft(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["stage", "bank_key"]);
  const project = runtime.project;
  const actor_id = runtime.actor_id;
  if (project === null || actor_id === null) {
    throw new Error("question.prepare_draft must resolve a project and actor first");
  }
  const bank_key = require_non_empty_string(payload, "bank_key");
  if (bank_key.length > 64 || !/^[A-Za-z0-9_-]+$/.test(bank_key)) {
    return invalid_payload("bank_key must be a short plain key");
  }
  const stage = resolve_stage_key(runtime, project.id, payload.stage);
  const result = {
    project_id: project.id,
    stage_id: stage.id,
    stage: stage.key,
    bank_key,
    round_no: stage.latest_round_no,
  };
  insert_receipt(runtime, {
    project_id: project.id,
    actor_id,
    action: "question.draft_prepared",
    base_control_rev: null,
    result,
  });
  return {
    result,
    events: [
      {
        type: "question.draft_prepared",
        payload: { stage: stage.key, stage_id: stage.id, bank_key, round_no: stage.latest_round_no },
      },
    ],
  };
}

const QUESTION_COMMAND_INPUTS: ReadonlyArray<readonly [string, CommandDefinition]> = [
  ["question.publish_set", definition("question.set_published", run_publish_set)],
  ["question.prepare_draft", definition("question.draft_prepared", run_prepare_draft)],
  ["question.revise", definition("question.revised", run_revise)],
  ["answer.submit", definition("answer.submitted", run_submit_answers)],
];

/** Registry entries merged into COMMANDS by commands.ts (names, not actions). */
export const QUESTION_COMMAND_ENTRIES: ReadonlyArray<readonly [string, CommandDefinition]> =
  Object.freeze(
    QUESTION_COMMAND_INPUTS.map((entry) => Object.freeze([entry[0], entry[1]] as const)),
  );

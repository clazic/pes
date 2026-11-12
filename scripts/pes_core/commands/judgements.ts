// Assumption, decision and reflection commands (stage 3 U3a, SEL-93).
//
// Seven commands, no new table (the DDL of 001 already has assumptions, decisions and reflection_entries):
//
//   assumption.propose   a person or an agent proposes an assumption       (new object, version 1, state proposed)
//   assumption.assess    the human owner confirms / rejects / revises      (a NEW version; the proposal is never rewritten)
//   decision.propose     a person or an agent proposes a decision          (new object, version 1, state proposed)
//   decision.adopt       the human owner adopts a proposal                 (new version, decided_by = the owner)
//   decision.supersede   the human owner replaces an adopted decision      (new decision + a 'superseded' version of the old one)
//   decision.revoke      the human owner revokes an adopted decision       (new 'revoked' version)
//   reflection.create    a person or an agent writes the reflection of a round (applied / partial need real evidence)
//
// An AI never confirms, adopts, supersedes or revokes: those four require the human owner. Every old version stays as it was;
// a change is always a new version. A refusal leaves no row, receipt or event (the command service rolls the transaction back).
//
// applied / partial evidence (the DDL CHECK only sees that the columns are filled; the meaning is checked here):
//   - evidence_tx_id is a commit of this project;
//   - result_version_id, when given, is a version of this project that THAT commit made (object_versions.tx_id), and is not the source;
//   - result_version_id is not a proposal: an assumption / decision version in state 'proposed' is never a result (SEL-100);
//   - followup_id, when given, is a follow-up whose origin_version_id is the entry's source and whose current version is 'applied'
//     with applied_tx_id = that commit (a follow-up with no origin is refused too, SEL-100);
//   - at least one of result / follow-up; when both are given, both must agree.

import { read_credential_actor } from "../actors.ts";
import { ApiError } from "../errors.ts";
import { content_digest, set_first_current_version, write_object, write_object_version } from "./content.ts";
import {
  insert_receipt,
  is_record,
  reject_unknown_fields,
  require_human_owner_actor,
  require_record,
  type CommandDefinition,
  type CommandResult,
  type CommandRuntime,
} from "./shared.ts";

const MAX_STATEMENT = 20_000;
const MAX_RATIONALE = 20_000;
const MAX_ENTRIES = 200;
const MAX_ID = 200;
const ASSESS_STATES: readonly string[] = ["confirmed", "rejected", "revised"];
const DECISION_SCOPES: readonly string[] = ["project", "edition"];
const DISPOSITIONS: readonly string[] = ["applied", "partial", "rejected", "deferred"];

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new ApiError("invalid_payload", message, details);
}

interface Scope {
  project_id: string;
  actor_id: string;
}

function scope_of(runtime: CommandRuntime): Scope {
  const project = runtime.project;
  const actor_id = runtime.actor_id;
  if (project === null || actor_id === null) {
    throw new Error("a judgement command must resolve a project and actor first");
  }
  if (read_credential_actor(runtime.db, actor_id) === undefined) {
    throw new ApiError("forbidden", "the actor is not allowed in this project");
  }
  return { project_id: project.id, actor_id };
}

function active_edition_id(runtime: CommandRuntime, project_id: string): string {
  const row = runtime.db.get<{ id: string | null }>("SELECT active_edition_id AS id FROM projects WHERE id = ?", project_id);
  if (row === undefined || row.id === null) throw new ApiError("conflict", "the project has no active edition");
  return row.id;
}

/** A required text: a non-blank, well-formed string within `max`. */
function required_text(payload: Record<string, unknown>, field: string, max: number): string {
  const value = payload[field];
  if (typeof value !== "string" || value.trim().length === 0) invalid(`${field} must be a non-empty string`);
  if (!value.isWellFormed()) invalid(`${field} must be well-formed Unicode`);
  if (value.length > max) invalid(`${field} is too long`);
  return value;
}

/** An optional text (absent or null = ''): a well-formed string within `max`; it may be blank. */
function optional_text(payload: Record<string, unknown>, field: string, max: number): string {
  const value = payload[field];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || !value.isWellFormed()) invalid(`${field} must be a string`);
  if (value.length > max) invalid(`${field} is too long`);
  return value;
}

/** An id field: a non-empty string. */
function required_id(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID || !value.isWellFormed()) {
    invalid(`${field} must be a non-empty string`);
  }
  return value;
}

/** An optional id: absent or null = null; otherwise a non-empty string. */
function optional_id(record: Record<string, unknown>, field: string, where: string): string | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID || !value.isWellFormed()) {
    invalid(`${where}${field} must be a non-empty string or null`);
  }
  return value;
}

interface CurrentVersion {
  object_id: string;
  current_version_id: string;
  version_no: number;
  edition_id: string | null;
}

/** The object of this kind, with its current version; not_found when the id is not such an object of this project. */
function read_current(runtime: CommandRuntime, project_id: string, object_id: string, kind: string): CurrentVersion {
  const row = runtime.db.get<{ edition_id: string | null; current_version_id: string | null; version_no: bigint | null }>(
    `SELECT o.edition_id AS edition_id, o.current_version_id AS current_version_id, v.version_no AS version_no
       FROM objects o LEFT JOIN object_versions v ON v.project_id = o.project_id AND v.id = o.current_version_id
      WHERE o.project_id = ? AND o.id = ? AND o.kind = ?`,
    project_id,
    object_id,
    kind,
  );
  if (row === undefined || row.current_version_id === null || row.version_no === null) {
    throw new ApiError("not_found", `${kind} not found`);
  }
  return { object_id, current_version_id: row.current_version_id, version_no: Number(row.version_no), edition_id: row.edition_id };
}

function require_base(current: CurrentVersion, base_version_id: string): void {
  if (current.current_version_id !== base_version_id) {
    throw new ApiError("rev_conflict", "base_version_id is not the current version", { current_version_id: current.current_version_id });
  }
}

/**
 * A record of a past edition (completed / archived) is not judged any more. The active edition and a draft one (a new edition being
 * prepared, holding copied records) are open. Callers pass only edition-bound records: a project-scope decision is judged wherever it was made.
 */
function require_open_edition(runtime: CommandRuntime, project_id: string, edition_id: string | null): void {
  if (edition_id === null) return;
  const row = runtime.db.get<{ status: string }>("SELECT status FROM editions WHERE project_id = ? AND id = ?", project_id, edition_id);
  if (row !== undefined && (row.status === "completed" || row.status === "archived")) {
    throw new ApiError("conflict", `the record belongs to a past edition (${row.status})`, { reason: "edition_closed", edition_status: row.status });
  }
}

function move_current_version(runtime: CommandRuntime, project_id: string, object_id: string, from_version_id: string, to_version_id: string): void {
  const moved = runtime.db.run(
    "UPDATE objects SET current_version_id = ?, rev = rev + 1 WHERE project_id = ? AND id = ? AND current_version_id = ?",
    to_version_id,
    project_id,
    object_id,
    from_version_id,
  );
  if (moved.changes !== 1n) throw new ApiError("conflict", "the object moved concurrently");
}

// ---------------------------------------------------------------------------
// assumptions

interface AssumptionVersionInput {
  project_id: string;
  version_id: string;
  object_id: string;
  statement: string;
  state: string;
  assessment_actor_id: string | null;
  assessed_at: number | null;
  needs_review: number;
  rationale: string;
}

function write_assumption_version(runtime: CommandRuntime, input: AssumptionVersionInput): void {
  const written = runtime.db.run(
    `INSERT INTO assumption_versions
       (project_id, version_id, object_id, statement, state, assessment_actor_id, assessed_at, needs_review, rationale)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.project_id,
    input.version_id,
    input.object_id,
    input.statement,
    input.state,
    input.assessment_actor_id,
    input.assessed_at,
    input.needs_review,
    input.rationale,
  );
  if (written.changes !== 1n) throw new Error("the assumption version was not written");
}

function assumption_hash(statement: string, state: string, rationale: string, assessment_actor_id: string | null): string {
  return content_digest("assumption", { statement, state, rationale, assessment_actor_id });
}

function run_assumption_propose(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["statement", "rationale", "target_object_id"]);
  const statement = required_text(payload, "statement", MAX_STATEMENT);
  const rationale = optional_text(payload, "rationale", MAX_RATIONALE);
  const target = optional_id(payload, "target_object_id", "");
  const scope = scope_of(runtime);
  if (target !== null) {
    const found = runtime.db.get<{ id: string }>("SELECT id FROM objects WHERE project_id = ? AND id = ?", scope.project_id, target);
    if (found === undefined) throw new ApiError("not_found", "target_object_id is not an object of this project");
  }
  const edition_id = active_edition_id(runtime, scope.project_id);
  const object_id = runtime.new_id();
  const version_id = runtime.new_id();
  const result = {
    project_id: scope.project_id,
    object_id,
    version_id,
    version_no: 1,
    state: "proposed",
    needs_review: true,
  };
  insert_receipt(runtime, { project_id: scope.project_id, actor_id: scope.actor_id, action: "assumption.proposed", base_control_rev: null, result });
  write_object(runtime, scope.project_id, object_id, "assumption", edition_id, null);
  write_object_version(runtime, {
    project_id: scope.project_id,
    object_id,
    kind: "assumption",
    version_id,
    version_no: 1,
    based_on_version_id: null,
    actor_id: scope.actor_id,
    content_hash: assumption_hash(statement, "proposed", rationale, null),
  });
  runtime.db.run(
    "INSERT INTO assumptions (project_id, object_id, proposed_by_actor_id, target_object_id) VALUES (?, ?, ?, ?)",
    scope.project_id,
    object_id,
    scope.actor_id,
    target,
  );
  write_assumption_version(runtime, {
    project_id: scope.project_id,
    version_id,
    object_id,
    statement,
    state: "proposed",
    assessment_actor_id: null,
    assessed_at: null,
    needs_review: 1,
    rationale,
  });
  set_first_current_version(runtime, scope.project_id, object_id, version_id);
  return { result, events: [{ type: "assumption.proposed", payload: { object_id, version_id, proposed_by_actor_id: scope.actor_id } }] };
}

function run_assumption_assess(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  const actor_id = require_human_owner_actor(runtime);
  reject_unknown_fields(payload, ["assumption_id", "base_version_id", "state", "rationale", "statement"]);
  const assumption_id = required_id(payload, "assumption_id");
  const base_version_id = required_id(payload, "base_version_id");
  const state = payload.state;
  if (typeof state !== "string" || !ASSESS_STATES.includes(state)) invalid("state must be confirmed, rejected or revised");
  const rationale = state === "confirmed" ? optional_text(payload, "rationale", MAX_RATIONALE) : required_text(payload, "rationale", MAX_RATIONALE);
  let revised_statement: string | null = null;
  if (state === "revised") revised_statement = required_text(payload, "statement", MAX_STATEMENT);
  else if (payload.statement !== undefined && payload.statement !== null) invalid("statement is only for a revised assessment");
  const scope = scope_of(runtime);
  const current = read_current(runtime, scope.project_id, assumption_id, "assumption");
  require_open_edition(runtime, scope.project_id, current.edition_id);
  require_base(current, base_version_id);
  const base = runtime.db.get<{ statement: string }>(
    "SELECT statement FROM assumption_versions WHERE project_id = ? AND version_id = ?",
    scope.project_id,
    base_version_id,
  );
  if (base === undefined) throw new ApiError("not_found", "assumption version not found");
  const statement = revised_statement ?? base.statement;
  const version_id = runtime.new_id();
  const version_no = current.version_no + 1;
  const result = {
    project_id: scope.project_id,
    assumption_id,
    version_id,
    version_no,
    state,
    assessment_actor_id: actor_id,
    assessed_at: runtime.now_ms,
  };
  insert_receipt(runtime, { project_id: scope.project_id, actor_id, action: "assumption.assessed", base_control_rev: null, result });
  write_object_version(runtime, {
    project_id: scope.project_id,
    object_id: assumption_id,
    kind: "assumption",
    version_id,
    version_no,
    based_on_version_id: base_version_id,
    actor_id,
    content_hash: assumption_hash(statement, state, rationale, actor_id),
  });
  write_assumption_version(runtime, {
    project_id: scope.project_id,
    version_id,
    object_id: assumption_id,
    statement,
    state,
    assessment_actor_id: actor_id,
    assessed_at: runtime.now_ms,
    needs_review: 0,
    rationale,
  });
  move_current_version(runtime, scope.project_id, assumption_id, base_version_id, version_id);
  return { result, events: [{ type: "assumption.assessed", payload: { object_id: assumption_id, version_id, state, assessment_actor_id: actor_id } }] };
}

// ---------------------------------------------------------------------------
// decisions

interface DecisionVersionInput {
  project_id: string;
  version_id: string;
  object_id: string;
  statement: string;
  state: string;
  decided_by: string | null;
  rationale: string;
  supersedes_decision_id: string | null;
}

function write_decision_version(runtime: CommandRuntime, input: DecisionVersionInput): void {
  const written = runtime.db.run(
    `INSERT INTO decision_versions
       (project_id, version_id, object_id, statement, state, decided_by, rationale, supersedes_decision_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    input.project_id,
    input.version_id,
    input.object_id,
    input.statement,
    input.state,
    input.decided_by,
    input.rationale,
    input.supersedes_decision_id,
  );
  if (written.changes !== 1n) throw new Error("the decision version was not written");
}

function decision_hash(statement: string, state: string, rationale: string, decided_by: string | null, supersedes: string | null): string {
  return content_digest("decision", { statement, state, rationale, decided_by, supersedes_decision_id: supersedes });
}

interface DecisionHead {
  scope: string;
  statement: string;
  state: string;
  rationale: string;
  supersedes_decision_id: string | null;
}

function read_decision_head(runtime: CommandRuntime, project_id: string, decision_id: string, version_id: string): DecisionHead {
  const row = runtime.db.get<DecisionHead>(
    `SELECT d.scope AS scope, v.statement AS statement, v.state AS state, v.rationale AS rationale,
            v.supersedes_decision_id AS supersedes_decision_id
       FROM decisions d JOIN decision_versions v ON v.project_id = d.project_id AND v.object_id = d.object_id
      WHERE d.project_id = ? AND d.object_id = ? AND v.version_id = ?`,
    project_id,
    decision_id,
    version_id,
  );
  if (row === undefined) throw new ApiError("not_found", "decision version not found");
  return row;
}

function insert_decision_object(
  runtime: CommandRuntime,
  input: { project_id: string; actor_id: string; edition_id: string | null; object_id: string; version_id: string; scope: string; originated_from_version_id: string | null; version: Omit<DecisionVersionInput, "project_id" | "version_id" | "object_id"> },
): void {
  write_object(runtime, input.project_id, input.object_id, "decision", input.edition_id, null);
  write_object_version(runtime, {
    project_id: input.project_id,
    object_id: input.object_id,
    kind: "decision",
    version_id: input.version_id,
    version_no: 1,
    based_on_version_id: null,
    actor_id: input.actor_id,
    content_hash: decision_hash(input.version.statement, input.version.state, input.version.rationale, input.version.decided_by, input.version.supersedes_decision_id),
  });
  runtime.db.run(
    "INSERT INTO decisions (project_id, object_id, scope, originated_from_version_id) VALUES (?, ?, ?, ?)",
    input.project_id,
    input.object_id,
    input.scope,
    input.originated_from_version_id,
  );
  write_decision_version(runtime, { project_id: input.project_id, version_id: input.version_id, object_id: input.object_id, ...input.version });
  set_first_current_version(runtime, input.project_id, input.object_id, input.version_id);
}

function append_decision_version(
  runtime: CommandRuntime,
  input: { project_id: string; actor_id: string; object_id: string; base_version_id: string; version_no: number; version_id: string; version: Omit<DecisionVersionInput, "project_id" | "version_id" | "object_id"> },
): void {
  write_object_version(runtime, {
    project_id: input.project_id,
    object_id: input.object_id,
    kind: "decision",
    version_id: input.version_id,
    version_no: input.version_no,
    based_on_version_id: input.base_version_id,
    actor_id: input.actor_id,
    content_hash: decision_hash(input.version.statement, input.version.state, input.version.rationale, input.version.decided_by, input.version.supersedes_decision_id),
  });
  write_decision_version(runtime, { project_id: input.project_id, version_id: input.version_id, object_id: input.object_id, ...input.version });
  move_current_version(runtime, input.project_id, input.object_id, input.base_version_id, input.version_id);
}

function run_decision_propose(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["statement", "scope", "rationale"]);
  const statement = required_text(payload, "statement", MAX_STATEMENT);
  const decision_scope = payload.scope;
  if (typeof decision_scope !== "string" || !DECISION_SCOPES.includes(decision_scope)) invalid("scope must be project or edition");
  const rationale = optional_text(payload, "rationale", MAX_RATIONALE);
  const scope = scope_of(runtime);
  const edition_id = active_edition_id(runtime, scope.project_id);
  const object_id = runtime.new_id();
  const version_id = runtime.new_id();
  const result = { project_id: scope.project_id, object_id, version_id, version_no: 1, state: "proposed", scope: decision_scope };
  insert_receipt(runtime, { project_id: scope.project_id, actor_id: scope.actor_id, action: "decision.proposed", base_control_rev: null, result });
  insert_decision_object(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    edition_id,
    object_id,
    version_id,
    scope: decision_scope,
    originated_from_version_id: null,
    version: { statement, state: "proposed", decided_by: null, rationale, supersedes_decision_id: null },
  });
  return { result, events: [{ type: "decision.proposed", payload: { object_id, version_id, scope: decision_scope } }] };
}

function run_decision_adopt(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  const actor_id = require_human_owner_actor(runtime);
  reject_unknown_fields(payload, ["decision_id", "base_version_id", "rationale"]);
  const decision_id = required_id(payload, "decision_id");
  const base_version_id = required_id(payload, "base_version_id");
  const rationale = optional_text(payload, "rationale", MAX_RATIONALE);
  const scope = scope_of(runtime);
  const current = read_current(runtime, scope.project_id, decision_id, "decision");
  require_base(current, base_version_id);
  const head = read_decision_head(runtime, scope.project_id, decision_id, base_version_id);
  if (head.scope === "edition") require_open_edition(runtime, scope.project_id, current.edition_id);
  if (head.state !== "proposed") {
    throw new ApiError("conflict", `only a proposed decision can be adopted (it is ${head.state})`, { reason: "decision_state", state: head.state });
  }
  const version_id = runtime.new_id();
  const version_no = current.version_no + 1;
  const result = { project_id: scope.project_id, decision_id, version_id, version_no, state: "adopted", decided_by: actor_id, scope: head.scope };
  insert_receipt(runtime, { project_id: scope.project_id, actor_id, action: "decision.adopted", base_control_rev: null, result });
  append_decision_version(runtime, {
    project_id: scope.project_id,
    actor_id,
    object_id: decision_id,
    base_version_id,
    version_no,
    version_id,
    version: { statement: head.statement, state: "adopted", decided_by: actor_id, rationale, supersedes_decision_id: head.supersedes_decision_id },
  });
  return { result, events: [{ type: "decision.adopted", payload: { object_id: decision_id, version_id, decided_by: actor_id } }] };
}

function run_decision_supersede(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  const actor_id = require_human_owner_actor(runtime);
  reject_unknown_fields(payload, ["decision_id", "base_version_id", "statement", "rationale", "scope"]);
  const old_id = required_id(payload, "decision_id");
  const base_version_id = required_id(payload, "base_version_id");
  const statement = required_text(payload, "statement", MAX_STATEMENT);
  const rationale = required_text(payload, "rationale", MAX_RATIONALE);
  let new_scope: string | null = null;
  if (payload.scope !== undefined && payload.scope !== null) {
    if (typeof payload.scope !== "string" || !DECISION_SCOPES.includes(payload.scope)) invalid("scope must be project or edition");
    new_scope = payload.scope;
  }
  const scope = scope_of(runtime);
  const current = read_current(runtime, scope.project_id, old_id, "decision");
  require_base(current, base_version_id);
  const head = read_decision_head(runtime, scope.project_id, old_id, base_version_id);
  if (head.scope === "edition") require_open_edition(runtime, scope.project_id, current.edition_id);
  if (head.state !== "adopted") {
    throw new ApiError("conflict", `only an adopted decision can be superseded (it is ${head.state})`, {
      reason: "supersedes_conflict",
      target_state: head.state,
    });
  }
  // an edition-scope replacement of an edition-scope decision stays in the edition of the decision it replaces (a draft copy's replacement
  // must not appear in the active edition); a project-scope replacement, or a decision without an edition, goes to the active edition
  const resulting_scope = new_scope ?? head.scope;
  // widening a record of a DRAFT edition (a new edition being prepared) to project scope would show it in the active edition at once,
  // because a project-scope decision belongs to no edition: refuse (the draft's work stays in the draft)
  if (head.scope === "edition" && resulting_scope === "project" && current.edition_id !== null && current.edition_id !== active_edition_id(runtime, scope.project_id)) {
    throw new ApiError("conflict", "a decision of an edition that is not the active one cannot be widened to project scope", { reason: "edition_not_active" });
  }
  const edition_id = head.scope === "edition" && resulting_scope === "edition" && current.edition_id !== null ? current.edition_id : active_edition_id(runtime, scope.project_id);
  const decision_id = runtime.new_id();
  const version_id = runtime.new_id();
  const superseded_version_id = runtime.new_id();
  const result = {
    project_id: scope.project_id,
    decision_id,
    version_id,
    version_no: 1,
    state: "adopted",
    decided_by: actor_id,
    scope: new_scope ?? head.scope,
    superseded_decision_id: old_id,
    superseded_version_id,
  };
  insert_receipt(runtime, { project_id: scope.project_id, actor_id, action: "decision.superseded", base_control_rev: null, result });
  insert_decision_object(runtime, {
    project_id: scope.project_id,
    actor_id,
    edition_id,
    object_id: decision_id,
    version_id,
    scope: new_scope ?? head.scope,
    originated_from_version_id: null,
    version: { statement, state: "adopted", decided_by: actor_id, rationale, supersedes_decision_id: old_id },
  });
  append_decision_version(runtime, {
    project_id: scope.project_id,
    actor_id,
    object_id: old_id,
    base_version_id,
    version_no: current.version_no + 1,
    version_id: superseded_version_id,
    version: { statement: head.statement, state: "superseded", decided_by: actor_id, rationale, supersedes_decision_id: head.supersedes_decision_id },
  });
  return {
    result,
    events: [{ type: "decision.superseded", payload: { object_id: old_id, version_id: superseded_version_id, superseded_by: decision_id, replacement_version_id: version_id } }],
  };
}

function run_decision_revoke(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  const actor_id = require_human_owner_actor(runtime);
  reject_unknown_fields(payload, ["decision_id", "base_version_id", "rationale"]);
  const decision_id = required_id(payload, "decision_id");
  const base_version_id = required_id(payload, "base_version_id");
  const rationale = required_text(payload, "rationale", MAX_RATIONALE);
  const scope = scope_of(runtime);
  const current = read_current(runtime, scope.project_id, decision_id, "decision");
  require_base(current, base_version_id);
  const head = read_decision_head(runtime, scope.project_id, decision_id, base_version_id);
  if (head.scope === "edition") require_open_edition(runtime, scope.project_id, current.edition_id);
  if (head.state !== "adopted") {
    throw new ApiError("conflict", `only an adopted decision can be revoked (it is ${head.state})`, { reason: "decision_state", state: head.state });
  }
  const version_id = runtime.new_id();
  const version_no = current.version_no + 1;
  const result = { project_id: scope.project_id, decision_id, version_id, version_no, state: "revoked", decided_by: actor_id, scope: head.scope };
  insert_receipt(runtime, { project_id: scope.project_id, actor_id, action: "decision.revoked", base_control_rev: null, result });
  append_decision_version(runtime, {
    project_id: scope.project_id,
    actor_id,
    object_id: decision_id,
    base_version_id,
    version_no,
    version_id,
    version: { statement: head.statement, state: "revoked", decided_by: actor_id, rationale, supersedes_decision_id: head.supersedes_decision_id },
  });
  return { result, events: [{ type: "decision.revoked", payload: { object_id: decision_id, version_id, decided_by: actor_id } }] };
}

// ---------------------------------------------------------------------------
// reflections

const ENTRY_FIELDS = ["source_version_id", "disposition", "rationale", "result_version_id", "followup_id", "evidence_tx_id", "supersedes_entry_id"];

interface ReflectionEntry {
  source_version_id: string;
  disposition: string;
  rationale: string;
  result_version_id: string | null;
  followup_id: string | null;
  evidence_tx_id: string | null;
  supersedes_entry_id: string | null;
}

function parse_entry(raw: unknown, index: number): ReflectionEntry {
  const where = `entries[${index}].`;
  if (!is_record(raw)) invalid(`entries[${index}] must be an object`);
  for (const key of Object.keys(raw)) {
    if (!ENTRY_FIELDS.includes(key)) invalid(`unknown field: entries[${index}].${key}`);
  }
  const source = raw.source_version_id;
  if (typeof source !== "string" || source.length === 0 || source.length > MAX_ID || !source.isWellFormed()) {
    invalid(`${where}source_version_id must be a non-empty string`);
  }
  const disposition = raw.disposition;
  if (typeof disposition !== "string" || !DISPOSITIONS.includes(disposition)) invalid(`${where}disposition is not a known value`);
  const rationale = raw.rationale;
  if (typeof rationale !== "string" || rationale.trim().length === 0 || !rationale.isWellFormed() || rationale.length > MAX_RATIONALE) {
    invalid(`${where}rationale must be a non-empty string`);
  }
  const result_version_id = optional_id(raw, "result_version_id", where);
  const followup_id = optional_id(raw, "followup_id", where);
  const evidence_tx_id = optional_id(raw, "evidence_tx_id", where);
  const supersedes_entry_id = optional_id(raw, "supersedes_entry_id", where);
  if (disposition === "rejected" || disposition === "deferred") {
    // the evidence columns belong to applied / partial only
    for (const [field, value] of [["result_version_id", result_version_id], ["followup_id", followup_id], ["evidence_tx_id", evidence_tx_id]] as const) {
      if (value !== null) invalid(`${where}${field} is only for applied or partial`, { reason: "evidence_not_allowed", index, field });
    }
  } else if (evidence_tx_id === null || (result_version_id === null && followup_id === null)) {
    throw new ApiError("invalid_payload", `${where}${disposition} needs evidence: a result version or an applied follow-up, and the commit that made it`, {
      reason: "evidence_required",
      index,
      disposition,
    });
  }
  return { source_version_id: source, disposition, rationale, result_version_id, followup_id, evidence_tx_id, supersedes_entry_id };
}

function evidence_mismatch(index: number, field: string, message: string): never {
  throw new ApiError("conflict", message, { reason: "evidence_mismatch", index, field });
}

/** The meaning of an applied / partial entry's evidence: the commit made the result, and an applied follow-up carries the same commit. */
function check_evidence(runtime: CommandRuntime, project_id: string, entry: ReflectionEntry, index: number): void {
  const tx = entry.evidence_tx_id as string;
  if (runtime.db.get("SELECT 1 FROM mutation_commits WHERE project_id = ? AND id = ?", project_id, tx) === undefined) {
    throw new ApiError("not_found", "evidence_tx_id is not a commit of this project", { index, field: "evidence_tx_id" });
  }
  if (entry.result_version_id !== null) {
    const made = runtime.db.get<{ tx_id: string }>("SELECT tx_id FROM object_versions WHERE project_id = ? AND id = ?", project_id, entry.result_version_id);
    if (made === undefined) throw new ApiError("not_found", "result_version_id is not a version of this project", { index, field: "result_version_id" });
    if (entry.result_version_id === entry.source_version_id) evidence_mismatch(index, "result_version_id", "the source itself is not a result");
    if (made.tx_id !== tx) evidence_mismatch(index, "evidence_tx_id", "that commit did not make the result version");
    // Allow list, not a deny list. A version that anyone with a token can make in ONE write (a proposal, a message, a thread, a question, an answer,
    // a source ...) always satisfies "the commit that made it", so it could be offered as proof of itself. Only what can really be the RESULT of
    // handling an opinion counts: a text (artifact) version, a judged assumption (confirmed / rejected / revised: the human owner's assess), or a judged
    // decision (adopted / superseded / revoked: the owner's adopt / supersede / revoke). Everything else is evidence_mismatch.
    const result = runtime.db.get(
      `SELECT 1 FROM object_versions ov
        WHERE ov.project_id = ? AND ov.id = ?
          AND (ov.kind = 'artifact'
               OR (ov.kind = 'assumption' AND EXISTS (SELECT 1 FROM assumption_versions av WHERE av.project_id = ov.project_id AND av.version_id = ov.id AND av.state IN ('confirmed', 'rejected', 'revised')))
               OR (ov.kind = 'decision' AND EXISTS (SELECT 1 FROM decision_versions dv WHERE dv.project_id = ov.project_id AND dv.version_id = ov.id AND dv.state IN ('adopted', 'superseded', 'revoked'))))`,
      project_id,
      entry.result_version_id,
    );
    if (result === undefined) evidence_mismatch(index, "result_version_id", "that version is not a result: only a text or a judged assumption / decision can be one");
  }
  if (entry.followup_id !== null) {
    const row = runtime.db.get<{ state: string | null; applied_tx_id: string | null; origin_version_id: string | null }>(
      `SELECT v.state AS state, v.applied_tx_id AS applied_tx_id, f.origin_version_id AS origin_version_id
         FROM followups f
         JOIN objects o ON o.project_id = f.project_id AND o.id = f.object_id
         LEFT JOIN followup_versions v ON v.project_id = o.project_id AND v.version_id = o.current_version_id
        WHERE f.project_id = ? AND f.object_id = ?`,
      project_id,
      entry.followup_id,
    );
    if (row === undefined) throw new ApiError("not_found", "followup_id is not a follow-up of this project", { index, field: "followup_id" });
    if (row.state !== "applied") evidence_mismatch(index, "evidence_tx_id", "the follow-up is not applied");
    if (row.applied_tx_id !== tx) evidence_mismatch(index, "evidence_tx_id", "the follow-up was applied by another commit");
    // the follow-up must come from this entry's source: an applied follow-up of some other opinion (or of none) is no evidence for it
    if (row.origin_version_id !== entry.source_version_id) evidence_mismatch(index, "followup_id", "the follow-up did not come from this entry's source");
  }
}

function run_reflection_create(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["target_round_id", "entries"]);
  const target_round_id = required_id(payload, "target_round_id");
  const raw_entries = payload.entries;
  if (!Array.isArray(raw_entries)) invalid("entries must be an array");
  if (raw_entries.length > MAX_ENTRIES) invalid(`entries has at most ${MAX_ENTRIES} items`);
  const entries = raw_entries.map((raw, index) => parse_entry(raw, index));
  const scope = scope_of(runtime);
  if (runtime.db.get("SELECT 1 FROM rounds WHERE project_id = ? AND id = ?", scope.project_id, target_round_id) === undefined) {
    throw new ApiError("not_found", "the round is not a round of this project", { field: "target_round_id" });
  }
  const replaced_here = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (runtime.db.get("SELECT 1 FROM object_versions WHERE project_id = ? AND id = ?", scope.project_id, entry.source_version_id) === undefined) {
      throw new ApiError("not_found", "source_version_id is not a version of this project", { index, field: "source_version_id" });
    }
    if (entry.supersedes_entry_id !== null) {
      const older = runtime.db.get<{ target_round_id: string }>(
        "SELECT target_round_id FROM reflection_entries WHERE project_id = ? AND id = ?",
        scope.project_id,
        entry.supersedes_entry_id,
      );
      if (older === undefined) throw new ApiError("not_found", "supersedes_entry_id is not an entry of this project", { index, field: "supersedes_entry_id" });
      if (older.target_round_id !== target_round_id) {
        throw new ApiError("conflict", "supersedes_entry_id belongs to another round", { reason: "entry_round", index, field: "supersedes_entry_id" });
      }
      // an entry is replaced once: by an earlier call or by another entry of this call, a second replacement would leave two live entries
      const replaced_before =
        replaced_here.has(entry.supersedes_entry_id) ||
        runtime.db.get("SELECT 1 FROM reflection_entries WHERE project_id = ? AND supersedes_entry_id = ?", scope.project_id, entry.supersedes_entry_id) !== undefined;
      if (replaced_before) {
        throw new ApiError("conflict", "supersedes_entry_id is already replaced by another entry", { reason: "entry_replaced", index, field: "supersedes_entry_id" });
      }
      replaced_here.add(entry.supersedes_entry_id);
    }
    if (entry.disposition === "applied" || entry.disposition === "partial") check_evidence(runtime, scope.project_id, entry, index);
  }
  const ids = entries.map(() => runtime.new_id());
  const applied_count = entries.filter((entry) => entry.disposition === "applied").length;
  const partial_count = entries.filter((entry) => entry.disposition === "partial").length;
  const result = {
    project_id: scope.project_id,
    reflection_id: runtime.tx_id,
    target_round_id,
    count: entries.length,
    applied_count,
    partial_count,
    entries: entries.map((entry, index) => ({ entry_id: ids[index] as string, disposition: entry.disposition })),
  };
  insert_receipt(runtime, { project_id: scope.project_id, actor_id: scope.actor_id, action: "reflection.created", base_control_rev: null, result });
  for (const [index, entry] of entries.entries()) {
    const written = runtime.db.run(
      `INSERT INTO reflection_entries
         (id, project_id, source_version_id, target_round_id, disposition, rationale, result_version_id, followup_id,
          applied_tx_id, supersedes_entry_id, actor_id, tx_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ids[index],
      scope.project_id,
      entry.source_version_id,
      target_round_id,
      entry.disposition,
      entry.rationale,
      entry.result_version_id,
      entry.followup_id,
      entry.evidence_tx_id,
      entry.supersedes_entry_id,
      scope.actor_id,
      runtime.tx_id,
    );
    if (written.changes !== 1n) throw new Error("the reflection entry was not written");
  }
  return {
    result,
    events: [{ type: "reflection.created", payload: { target_round_id, count: entries.length, applied_count, partial_count } }],
  };
}

// ---------------------------------------------------------------------------
// a new edition inherits the parent's records (called by edition.create)

/**
 * Carry the parent edition's records into a new edition, inside edition.create's transaction (its receipt already exists).
 * - Every current assumption is copied as a NEW object of the new edition: version 1, state 'proposed', needs_review = 1, no assessor —
 *   a person confirmed it for the old edition, not for this one, so nothing is confirmed on its own. The parent's rows are not touched.
 * - Every adopted decision of scope 'edition' is copied as a new object of the new edition (still adopted, by the same decider);
 *   decisions.originated_from_version_id pins the parent's version that stood at this moment. Scope 'project' decisions are not copied:
 *   they are referenced where they are.
 */
export function copy_records_to_edition(runtime: CommandRuntime, project_id: string, actor_id: string, parent_edition_id: string, edition_id: string): void {
  const assumptions = runtime.db.all<{ object_id: string; statement: string; rationale: string; proposed_by_actor_id: string; target_object_id: string | null }>(
    `SELECT o.id AS object_id, v.statement AS statement, v.rationale AS rationale,
            a.proposed_by_actor_id AS proposed_by_actor_id, a.target_object_id AS target_object_id
       FROM objects o
       JOIN assumptions a ON a.project_id = o.project_id AND a.object_id = o.id
       JOIN assumption_versions v ON v.project_id = o.project_id AND v.version_id = o.current_version_id
      WHERE o.project_id = ? AND o.edition_id = ? AND o.kind = 'assumption' AND o.archived_at IS NULL
      ORDER BY o.display_no`,
    project_id,
    parent_edition_id,
  );
  for (const row of assumptions) {
    const object_id = runtime.new_id();
    const version_id = runtime.new_id();
    write_object(runtime, project_id, object_id, "assumption", edition_id, null);
    write_object_version(runtime, {
      project_id,
      object_id,
      kind: "assumption",
      version_id,
      version_no: 1,
      based_on_version_id: null,
      actor_id,
      content_hash: assumption_hash(row.statement, "proposed", row.rationale, null),
    });
    runtime.db.run(
      "INSERT INTO assumptions (project_id, object_id, proposed_by_actor_id, target_object_id) VALUES (?, ?, ?, ?)",
      project_id,
      object_id,
      row.proposed_by_actor_id,
      row.target_object_id,
    );
    write_assumption_version(runtime, {
      project_id,
      version_id,
      object_id,
      statement: row.statement,
      state: "proposed",
      assessment_actor_id: null,
      assessed_at: null,
      needs_review: 1,
      rationale: row.rationale,
    });
    set_first_current_version(runtime, project_id, object_id, version_id);
  }
  const decisions = runtime.db.all<{ version_id: string; statement: string; rationale: string; decided_by: string }>(
    `SELECT v.version_id AS version_id, v.statement AS statement, v.rationale AS rationale, v.decided_by AS decided_by
       FROM objects o
       JOIN decisions d ON d.project_id = o.project_id AND d.object_id = o.id
       JOIN decision_versions v ON v.project_id = o.project_id AND v.version_id = o.current_version_id
      WHERE o.project_id = ? AND o.edition_id = ? AND o.kind = 'decision' AND o.archived_at IS NULL
        AND d.scope = 'edition' AND v.state = 'adopted' AND v.decided_by IS NOT NULL
      ORDER BY o.display_no`,
    project_id,
    parent_edition_id,
  );
  for (const row of decisions) {
    insert_decision_object(runtime, {
      project_id,
      actor_id,
      edition_id,
      object_id: runtime.new_id(),
      version_id: runtime.new_id(),
      scope: "edition",
      originated_from_version_id: row.version_id,
      version: { statement: row.statement, state: "adopted", decided_by: row.decided_by, rationale: row.rationale, supersedes_decision_id: null },
    });
  }
}

// ---------------------------------------------------------------------------
// registry

function definition(action: string, run: (runtime: CommandRuntime) => CommandResult): CommandDefinition {
  return Object.freeze({ action, scope: "project", rev_bearing: false, run });
}

const JUDGEMENT_COMMAND_INPUTS: ReadonlyArray<readonly [string, CommandDefinition]> = [
  ["assumption.propose", definition("assumption.proposed", run_assumption_propose)],
  ["assumption.assess", definition("assumption.assessed", run_assumption_assess)],
  ["decision.propose", definition("decision.proposed", run_decision_propose)],
  ["decision.adopt", definition("decision.adopted", run_decision_adopt)],
  ["decision.supersede", definition("decision.superseded", run_decision_supersede)],
  ["decision.revoke", definition("decision.revoked", run_decision_revoke)],
  ["reflection.create", definition("reflection.created", run_reflection_create)],
];

/** Registry entries merged into COMMANDS by commands.ts (names, not actions); frozen like the other command modules. */
export const JUDGEMENT_COMMAND_ENTRIES: ReadonlyArray<readonly [string, CommandDefinition]> = Object.freeze(
  JUDGEMENT_COMMAND_INPUTS.map((entry) => Object.freeze([entry[0], entry[1]] as const)),
);

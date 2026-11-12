// Content command definitions (stage 2 PR7).
//
// Items, reports, sources, citations, and version relations are append-only.
// These definitions hold the only business-table SQL for the content commands;
// the public functions in scripts/pes_core/content.ts call CommandService once
// each, so every write still passes the registry, project/actor check, policy,
// receipt replay, change, and events + receipt in one transaction.
//
// No command here changes an existing version row. The current pointer moves
// only through content.set_current and only to a version of the same object.

import { createHash } from "node:crypto";

import { ApiError } from "../errors.ts";
import {
  insert_receipt,
  is_record,
  optional_lease_guard,
  reject_unknown_fields,
  require_base_control_rev,
  require_current_lease,
  require_non_empty_string,
  require_record,
  type CommandDefinition,
  type CommandResult,
  type CommandRuntime,
} from "./shared.ts";

const CONTENT_OBJECT_KINDS = new Set(["artifact", "source"]);
const ARTIFACT_KINDS = new Set([
  "rq",
  "chapter",
  "topic",
  "issue",
  "table",
  "section",
  "claim",
  "report",
  "review",
  "note",
  "schedule",
  "insight",
  "output",
]);
const ARTIFACT_STATUSES = new Set([
  "new",
  "deepen",
  "revise",
  "browser",
  "done",
  "removed",
  "failed",
  "draft",
  "published",
  "archived",
]);
const CONFIDENCE_LEVELS = new Set(["high", "medium", "low"]);
const SOURCE_KINDS = new Set(["web", "file", "stat", "law"]);
const SOURCE_METHODS = new Set([
  "search",
  "fetch",
  "browser",
  "kosis",
  "law",
  "vworld",
  "import",
  "unknown",
]);
const VERIFICATION_STATES = new Set([
  "unverified",
  "verified",
  "partial",
  "unreachable",
  "legacy_unknown",
]);
const RELATION_KINDS = new Set([
  "derived_from",
  "supports",
  "supersedes",
  "reuses",
  "related",
]);

const ARTIFACT_COMMON_FIELDS = [
  "title",
  "summary",
  "question",
  "body_md",
  "status",
  "confidence",
  "stats",
  "conflicts",
  "verify",
  "metadata",
] as const;
const SOURCE_COMMON_FIELDS = [
  "title",
  "url",
  "locator",
  "retrieved_at",
  "method",
  "verification_state",
  "quote",
  "verified_by_actor_id",
] as const;

interface ContentScope {
  project_id: string;
  actor_id: string;
}

interface ContentObjectRow {
  id: string;
  kind: string;
  current_version_id: string | null;
  rev: bigint;
}

interface VersionRow {
  id: string;
  object_id: string;
  kind: string;
  version_no: bigint;
}

export interface ArtifactFields {
  title: string;
  summary: string;
  question: string | null;
  body_md: string | null;
  status: string;
  confidence: string | null;
  stats: unknown[];
  conflicts: unknown[];
  verify: unknown;
  metadata: Record<string, unknown>;
}

export interface SourceFacts {
  title: string;
  url: string | null;
  locator: Record<string, unknown>;
  retrieved_at: number | null;
  method: string;
  verification_state: string;
  quote: string | null;
  verified_by_actor_id: string | null;
}

/** Library item id: a safe non-negative integer or a non-empty string. */
type LegacyId = string | number;

interface ImportItem {
  legacy_id: LegacyId;
  object_id: string;
  version_id: string;
}

interface PlannedSource {
  object_id: string;
  version_id: string;
  source_kind: string;
  canonical_locator: string | null;
  title: string;
  url: string | null;
  locator: Record<string, unknown>;
  method: string;
}

interface PlannedItem {
  legacy_id: LegacyId;
  object_id: string;
  version_id: string;
  artifact_kind: string;
  fields: ArtifactFields;
  archived: boolean;
  sources: PlannedSource[];
}

function content_scope(runtime: CommandRuntime): ContentScope {
  const project = runtime.project;
  const actor_id = runtime.actor_id;
  if (project === null || actor_id === null) {
    throw new Error("a content command must resolve a project and actor first");
  }
  return { project_id: project.id, actor_id };
}

function require_fields(payload: Record<string, unknown>, allowed: readonly string[]): void {
  const allowed_set = new Set(allowed);
  for (const key of Object.keys(payload)) {
    if (!allowed_set.has(key)) {
      throw new ApiError("invalid_payload", `unknown payload field: ${key}`);
    }
  }
}

function require_enum(
  payload: Record<string, unknown>,
  field: string,
  allowed: ReadonlySet<string>,
): string {
  const value = payload[field];
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new ApiError("invalid_payload", `${field} is not an allowed value`);
  }
  return value;
}

function optional_text(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.isWellFormed()) {
    throw new ApiError("invalid_payload", `${field} must be a string or null`);
  }
  return value;
}

function text_or(payload: Record<string, unknown>, field: string, fallback: string): string {
  const value = payload[field];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.isWellFormed()) {
    throw new ApiError("invalid_payload", `${field} must be a string`);
  }
  return value;
}

function optional_integer(payload: Record<string, unknown>, field: string): number | null {
  const value = payload[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ApiError("invalid_payload", `${field} must be a non-negative safe integer or null`);
  }
  return value;
}

function json_object(payload: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = payload[field];
  if (value === undefined || value === null) return {};
  if (!is_record(value)) {
    throw new ApiError("invalid_payload", `${field} must be a JSON object`);
  }
  return value;
}

function json_array(payload: Record<string, unknown>, field: string): unknown[] {
  const value = payload[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ApiError("invalid_payload", `${field} must be a JSON array`);
  }
  return value;
}

function optional_stage(
  runtime: CommandRuntime,
  project_id: string,
  payload: Record<string, unknown>,
): string | null {
  const value = payload.stage_id;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || !value.isWellFormed()) {
    throw new ApiError("invalid_payload", "stage_id must be a non-empty string or null");
  }
  const stage = runtime.db.get<{ ok: bigint }>(
    "SELECT 1 AS ok FROM stages WHERE project_id = ? AND id = ?",
    project_id,
    value,
  );
  if (stage === undefined) {
    throw new ApiError("not_found", "stage_id is not a stage of this project");
  }
  return value;
}

function optional_edition(
  runtime: CommandRuntime,
  project_id: string,
  payload: Record<string, unknown>,
): string | null {
  const value = payload.edition_id;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || !value.isWellFormed()) {
    throw new ApiError("invalid_payload", "edition_id must be a non-empty string or null");
  }
  const edition = runtime.db.get<{ ok: bigint }>(
    "SELECT 1 AS ok FROM editions WHERE project_id = ? AND id = ?",
    project_id,
    value,
  );
  if (edition === undefined) {
    throw new ApiError("not_found", "edition_id is not an edition of this project");
  }
  return value;
}

function optional_actor(
  runtime: CommandRuntime,
  project_id: string,
  payload: Record<string, unknown>,
  field: string,
): string | null {
  const value = payload[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || !value.isWellFormed()) {
    throw new ApiError("invalid_payload", `${field} must be a non-empty string or null`);
  }
  const actor = runtime.db.get<{ ok: bigint }>(
    `SELECT 1 AS ok
     FROM actors a
     JOIN users u ON u.id = a.user_id
     JOIN project_members m ON m.user_id = u.id
     WHERE a.id = ? AND m.project_id = ? AND a.disabled_at IS NULL AND u.disabled_at IS NULL`,
    value,
    project_id,
  );
  if (actor === undefined) {
    throw new ApiError("not_found", `${field} is not an actor of this project`);
  }
  return value;
}

function parse_artifact_fields(payload: Record<string, unknown>): ArtifactFields {
  const title = require_non_empty_string(payload, "title");
  const summary = text_or(payload, "summary", "");
  const question = optional_text(payload, "question");
  const body_md = optional_text(payload, "body_md");
  const status = payload.status === undefined ? "new" : require_enum(payload, "status", ARTIFACT_STATUSES);
  const confidence =
    payload.confidence === undefined || payload.confidence === null
      ? null
      : require_enum(payload, "confidence", CONFIDENCE_LEVELS);
  const stats = json_array(payload, "stats");
  const conflicts = json_array(payload, "conflicts");
  const verify = payload.verify === undefined ? null : payload.verify;
  const metadata = json_object(payload, "metadata");
  return { title, summary, question, body_md, status, confidence, stats, conflicts, verify, metadata };
}

function parse_source_facts(
  runtime: CommandRuntime,
  project_id: string,
  payload: Record<string, unknown>,
): SourceFacts {
  const title = require_non_empty_string(payload, "title");
  const url = optional_text(payload, "url");
  const locator = json_object(payload, "locator");
  const retrieved_at = optional_integer(payload, "retrieved_at");
  const method = require_enum(payload, "method", SOURCE_METHODS);
  const verification_state = require_enum(payload, "verification_state", VERIFICATION_STATES);
  const quote = optional_text(payload, "quote");
  const verified_by_actor_id = optional_actor(runtime, project_id, payload, "verified_by_actor_id");
  if (verification_state === "unreachable" && quote !== null) {
    throw new ApiError("invalid_payload", "an unreachable source cannot carry an excerpt");
  }
  return {
    title,
    url,
    locator,
    retrieved_at,
    method,
    verification_state,
    quote,
    verified_by_actor_id,
  };
}

/**
 * Deterministic JSON used only for content hashes. The payload is already a
 * JSON snapshot, so key order is the only normalisation needed.
 */
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

export function artifact_digest_fields(fields: ArtifactFields): Record<string, unknown> {
  return {
    title: fields.title,
    summary: fields.summary,
    question: fields.question,
    body_md: fields.body_md,
    status: fields.status,
    confidence: fields.confidence,
    stats: fields.stats,
    conflicts: fields.conflicts,
    verify: fields.verify,
    metadata: fields.metadata,
  };
}

export function source_digest_fields(facts: SourceFacts): Record<string, unknown> {
  return {
    title: facts.title,
    url: facts.url,
    locator: facts.locator,
    retrieved_at: facts.retrieved_at,
    method: facts.method,
    verification_state: facts.verification_state,
    quote: facts.quote,
    verified_by_actor_id: facts.verified_by_actor_id,
  };
}

export function content_digest(kind: string, fields: Record<string, unknown>): string {
  return createHash("sha256").update(`${kind}\n${canonical_json(fields)}`).digest("hex");
}

function read_object(
  runtime: CommandRuntime,
  project_id: string,
  object_id: string,
): ContentObjectRow {
  const row = runtime.db.get<ContentObjectRow>(
    "SELECT id, kind, current_version_id, rev FROM objects WHERE project_id = ? AND id = ?",
    project_id,
    object_id,
  );
  if (row === undefined) {
    throw new ApiError("not_found", "object not found");
  }
  return row;
}

function read_version(
  runtime: CommandRuntime,
  project_id: string,
  version_id: string,
): VersionRow {
  const row = runtime.db.get<VersionRow>(
    "SELECT id, object_id, kind, version_no FROM object_versions WHERE project_id = ? AND id = ?",
    project_id,
    version_id,
  );
  if (row === undefined) {
    throw new ApiError("not_found", "version not found");
  }
  return row;
}

/** The latest version of the object is the only unsealed one. */
function require_latest_version(
  runtime: CommandRuntime,
  project_id: string,
  version: VersionRow,
): void {
  const latest = runtime.db.get<{ max_no: bigint | null }>(
    "SELECT MAX(version_no) AS max_no FROM object_versions WHERE project_id = ? AND object_id = ?",
    project_id,
    version.object_id,
  );
  if (Number(latest?.max_no ?? 0n) !== Number(version.version_no)) {
    throw new ApiError("conflict", "the version is sealed by a later version");
  }
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

export function write_object(
  runtime: CommandRuntime,
  project_id: string,
  object_id: string,
  kind: string,
  edition_id: string | null,
  archived_at: number | null,
): number {
  const display_no = take_display_no(runtime, project_id, kind);
  const written = runtime.db.run(
    "INSERT INTO objects (id, project_id, edition_id, kind, display_no, archived_at) VALUES (?, ?, ?, ?, ?, ?)",
    object_id,
    project_id,
    edition_id,
    kind,
    display_no,
    archived_at,
  );
  if (written.changes !== 1n) {
    throw new Error("the object was not created");
  }
  return display_no;
}

export function write_object_version(
  runtime: CommandRuntime,
  input: {
    project_id: string;
    object_id: string;
    kind: string;
    version_id: string;
    version_no: number;
    based_on_version_id: string | null;
    actor_id: string;
    /** The run that produced this version, when it came from a run submission. */
    run_id?: string | null;
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
    input.run_id ?? null,
    runtime.tx_id,
    input.content_hash,
    runtime.now_ms,
  );
  if (written.changes !== 1n) {
    throw new Error("the object version was not written");
  }
}

export function write_artifact_version(
  runtime: CommandRuntime,
  project_id: string,
  object_id: string,
  version_id: string,
  fields: ArtifactFields,
): void {
  const written = runtime.db.run(
    `INSERT INTO artifact_versions
       (project_id, version_id, object_id, object_kind, title, question, summary, body_md,
        body_blob_id, status, confidence, stats, conflicts, verify, metadata_json)
     VALUES (?, ?, ?, 'artifact', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    project_id,
    version_id,
    object_id,
    fields.title,
    fields.question,
    fields.summary,
    fields.body_md,
    fields.status,
    fields.confidence,
    JSON.stringify(fields.stats),
    JSON.stringify(fields.conflicts),
    JSON.stringify(fields.verify),
    JSON.stringify(fields.metadata),
  );
  if (written.changes !== 1n) {
    throw new Error("the artifact version was not written");
  }
}

export function write_source_version(
  runtime: CommandRuntime,
  input: {
    project_id: string;
    object_id: string;
    version_id: string;
    facts: SourceFacts;
  },
): void {
  const facts = input.facts;
  const written = runtime.db.run(
    `INSERT INTO source_versions
       (project_id, version_id, object_id, object_kind, title, url, locator, retrieved_at,
        method, verification_state, quote, evidence_blob_id, verified_by_actor_id)
     VALUES (?, ?, ?, 'source', ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    input.project_id,
    input.version_id,
    input.object_id,
    facts.title,
    facts.url,
    JSON.stringify(facts.locator),
    facts.retrieved_at,
    facts.method,
    facts.verification_state,
    facts.quote,
    facts.verified_by_actor_id,
  );
  if (written.changes !== 1n) {
    throw new Error("the source version was not written");
  }
}

/** The first version of a bare object becomes current; later appends do not move it. */
export function set_first_current_version(
  runtime: CommandRuntime,
  project_id: string,
  object_id: string,
  version_id: string,
): void {
  const written = runtime.db.run(
    "UPDATE objects SET current_version_id = ? WHERE project_id = ? AND id = ? AND current_version_id IS NULL",
    version_id,
    project_id,
    object_id,
  );
  if (written.changes !== 1n) {
    throw new ApiError("conflict", "the object already has a current version");
  }
}

/** A content object receives exactly one version 1 and never a second first version. */
function require_bare_object(
  runtime: CommandRuntime,
  project_id: string,
  object: ContentObjectRow,
  kind: "artifact" | "source",
): void {
  if (object.kind !== kind) {
    throw new ApiError("conflict", "the object is not of the expected kind");
  }
  if (object.current_version_id !== null) {
    throw new ApiError("conflict", "the object already has a version");
  }
  const side =
    kind === "artifact"
      ? runtime.db.get<{ ok: bigint }>(
          "SELECT 1 AS ok FROM artifacts WHERE project_id = ? AND object_id = ?",
          project_id,
          object.id,
        )
      : runtime.db.get<{ ok: bigint }>(
          "SELECT 1 AS ok FROM sources WHERE project_id = ? AND object_id = ?",
          project_id,
          object.id,
        );
  if (side !== undefined) {
    throw new ApiError("conflict", "the object already has content");
  }
  const version = runtime.db.get<{ ok: bigint }>(
    "SELECT 1 AS ok FROM object_versions WHERE project_id = ? AND object_id = ?",
    project_id,
    object.id,
  );
  if (version !== undefined) {
    throw new ApiError("conflict", "the object already has a version");
  }
}

function run_create_object(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  require_fields(payload, ["kind", "edition_id"]);
  const kind = payload.kind;
  if (typeof kind !== "string" || !CONTENT_OBJECT_KINDS.has(kind)) {
    throw new ApiError("invalid_payload", 'kind must be "artifact" or "source"');
  }
  const scope = content_scope(runtime);
  const edition_id = optional_edition(runtime, scope.project_id, payload);
  const object_id = runtime.new_id();
  const display_no = write_object(runtime, scope.project_id, object_id, kind, edition_id, null);
  const result = { project_id: scope.project_id, object_id, kind, display_no };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "content.object_created",
    base_control_rev: null,
    result,
  });
  return {
    result,
    events: [
      {
        type: "content.object_created",
        payload: { object_id, kind, display_no, edition_id },
      },
    ],
  };
}

function run_add_artifact(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  require_fields(payload, [
    "object_id",
    "artifact_kind",
    "stage_id",
    ...ARTIFACT_COMMON_FIELDS,
  ]);
  const object_id = require_non_empty_string(payload, "object_id");
  const artifact_kind = require_enum(payload, "artifact_kind", ARTIFACT_KINDS);
  const scope = content_scope(runtime);
  const stage_id = optional_stage(runtime, scope.project_id, payload);
  const fields = parse_artifact_fields(payload);
  const object = read_object(runtime, scope.project_id, object_id);
  require_bare_object(runtime, scope.project_id, object, "artifact");

  const version_id = runtime.new_id();
  const result = { project_id: scope.project_id, object_id, version_id, version_no: 1 };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "content.artifact_added",
    base_control_rev: null,
    result,
  });
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
  runtime.db.run(
    "INSERT INTO artifacts (project_id, object_id, kind, stage_id) VALUES (?, ?, ?, ?)",
    scope.project_id,
    object_id,
    artifact_kind,
    stage_id,
  );
  write_artifact_version(runtime, scope.project_id, object_id, version_id, fields);
  set_first_current_version(runtime, scope.project_id, object_id, version_id);
  return {
    result,
    events: [
      {
        type: "content.artifact_added",
        payload: { object_id, version_id, artifact_kind, title: fields.title, stage_id },
      },
    ],
  };
}

function run_add_source(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  require_fields(payload, [
    "object_id",
    "source_kind",
    "canonical_locator",
    ...SOURCE_COMMON_FIELDS,
  ]);
  const object_id = require_non_empty_string(payload, "object_id");
  const source_kind = require_enum(payload, "source_kind", SOURCE_KINDS);
  const canonical_locator = optional_text(payload, "canonical_locator");
  const scope = content_scope(runtime);
  const facts = parse_source_facts(runtime, scope.project_id, payload);
  const object = read_object(runtime, scope.project_id, object_id);
  require_bare_object(runtime, scope.project_id, object, "source");

  const version_id = runtime.new_id();
  const result = { project_id: scope.project_id, object_id, version_id, version_no: 1 };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "content.source_added",
    base_control_rev: null,
    result,
  });
  write_object_version(runtime, {
    project_id: scope.project_id,
    object_id,
    kind: "source",
    version_id,
    version_no: 1,
    based_on_version_id: null,
    actor_id: scope.actor_id,
    content_hash: content_digest("source", source_digest_fields(facts)),
  });
  runtime.db.run(
    "INSERT INTO sources (project_id, object_id, kind, canonical_locator) VALUES (?, ?, ?, ?)",
    scope.project_id,
    object_id,
    source_kind,
    canonical_locator,
  );
  write_source_version(runtime, {
    project_id: scope.project_id,
    object_id,
    version_id,
    facts,
  });
  set_first_current_version(runtime, scope.project_id, object_id, version_id);
  return {
    result,
    events: [
      {
        type: "content.source_added",
        payload: { object_id, version_id, source_kind, title: facts.title, url: facts.url },
      },
    ],
  };
}

function resolve_based_on(
  runtime: CommandRuntime,
  project_id: string,
  object: ContentObjectRow,
  payload: Record<string, unknown>,
): string | null {
  const raw = payload.based_on_version_id;
  if (raw === undefined || raw === null) {
    if (object.current_version_id === null) {
      throw new ApiError("conflict", "the object has no current version");
    }
    return object.current_version_id;
  }
  if (typeof raw !== "string" || raw.trim().length === 0 || !raw.isWellFormed()) {
    throw new ApiError("invalid_payload", "based_on_version_id must be a non-empty string or null");
  }
  const version = runtime.db.get<{ object_id: string }>(
    "SELECT object_id FROM object_versions WHERE project_id = ? AND id = ?",
    project_id,
    raw,
  );
  if (version === undefined) {
    throw new ApiError("not_found", "based_on_version_id is not a version of this project");
  }
  if (version.object_id !== object.id) {
    throw new ApiError("conflict", "based_on_version_id belongs to another object");
  }
  return raw;
}

function next_version_no(
  runtime: CommandRuntime,
  project_id: string,
  object_id: string,
): number {
  const row = runtime.db.get<{ max_no: bigint | null; total: bigint }>(
    "SELECT MAX(version_no) AS max_no, COUNT(*) AS total FROM object_versions WHERE project_id = ? AND object_id = ?",
    project_id,
    object_id,
  );
  if ((row?.total ?? 0n) === 0n) {
    throw new ApiError("conflict", "the object has no first version to append to");
  }
  return Number(row?.max_no ?? 0n) + 1;
}

export interface AppendPlan {
  object_id: string;
  version_id: string;
  version_no: number;
  kind: "artifact" | "source";
  based_on_version_id: string | null;
  content_hash: string;
  fields: ArtifactFields | null;
  facts: SourceFacts | null;
}

/**
 * Validate one append item and decide its version id/number without writing.
 * Planning before the receipt exists lets result.submit write one receipt and
 * then the version rows that reference its tx_id in the same transaction.
 * `reserved` keeps version numbers of several items for the same object
 * monotonic, and `previous` makes the second item base on the first planned
 * version of that object.
 */
function plan_append_version(
  runtime: CommandRuntime,
  payload: Record<string, unknown>,
  reserved: Map<string, number>,
  previous: Map<string, AppendPlan>,
): AppendPlan {
  const object_id = require_non_empty_string(payload, "object_id");
  const scope = content_scope(runtime);
  const object = read_object(runtime, scope.project_id, object_id);
  if (object.kind !== "artifact" && object.kind !== "source") {
    throw new ApiError("conflict", "only artifacts and sources take versions");
  }

  const prior = previous.get(object_id);
  const explicit_based_on =
    payload.based_on_version_id !== undefined && payload.based_on_version_id !== null;
  const based_on_version_id = explicit_based_on
    ? resolve_based_on(runtime, scope.project_id, object, payload)
    : prior?.version_id ?? resolve_based_on(runtime, scope.project_id, object, payload);
  const version_no =
    reserved.get(object_id) ??
    next_version_no(runtime, scope.project_id, object_id);
  reserved.set(object_id, version_no + 1);
  const version_id = runtime.new_id();

  if (object.kind === "artifact") {
    require_fields(payload, ["object_id", "based_on_version_id", ...ARTIFACT_COMMON_FIELDS]);
    const fields = parse_artifact_fields(payload);
    return {
      object_id,
      version_id,
      version_no,
      kind: "artifact",
      based_on_version_id,
      content_hash: content_digest("artifact", artifact_digest_fields(fields)),
      fields,
      facts: null,
    };
  }

  require_fields(payload, ["object_id", "based_on_version_id", ...SOURCE_COMMON_FIELDS]);
  const facts = parse_source_facts(runtime, scope.project_id, payload);
  return {
    object_id,
    version_id,
    version_no,
    kind: "source",
    based_on_version_id,
    content_hash: content_digest("source", source_digest_fields(facts)),
    fields: null,
    facts,
  };
}

/** Write a planned version; the caller has already written its receipt. */
export function write_append_plan(
  runtime: CommandRuntime,
  plan: AppendPlan,
  actor_id: string,
  run_id: string | null,
): void {
  const scope = content_scope(runtime);
  write_object_version(runtime, {
    project_id: scope.project_id,
    object_id: plan.object_id,
    kind: plan.kind,
    version_id: plan.version_id,
    version_no: plan.version_no,
    based_on_version_id: plan.based_on_version_id,
    actor_id,
    run_id,
    content_hash: plan.content_hash,
  });
  if (plan.kind === "artifact") {
    if (plan.fields === null) throw new Error("an artifact plan must carry its fields");
    write_artifact_version(runtime, scope.project_id, plan.object_id, plan.version_id, plan.fields);
    return;
  }
  if (plan.facts === null) throw new Error("a source plan must carry its facts");
  write_source_version(runtime, {
    project_id: scope.project_id,
    object_id: plan.object_id,
    version_id: plan.version_id,
    facts: plan.facts,
  });
}

function run_append_version(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  const scope = content_scope(runtime);
  const plan = plan_append_version(runtime, payload, new Map(), new Map());
  const result = {
    project_id: scope.project_id,
    object_id: plan.object_id,
    version_id: plan.version_id,
    version_no: plan.version_no,
  };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "content.version_appended",
    base_control_rev: null,
    result,
  });
  write_append_plan(runtime, plan, scope.actor_id, null);
  return {
    result,
    events: [
      {
        type: "content.version_appended",
        payload: {
          object_id: plan.object_id,
          version_id: plan.version_id,
          version_no: plan.version_no,
          kind: plan.kind,
        },
      },
    ],
  };
}

const RESULT_SUBMIT_FIELDS = ["run_id", "lease_id", "fence", "results"] as const;
const RESULT_ITEM_FIELDS = [
  "op",
  "object_id",
  "based_on_version_id",
  ...ARTIFACT_COMMON_FIELDS,
  ...SOURCE_COMMON_FIELDS,
] as const;

/** Validate the shape of a results list (1 to 20 append_version items); returns the items without `op`. */
export function parse_result_items(results: unknown): Record<string, unknown>[] {
  if (!Array.isArray(results) || results.length < 1 || results.length > 20) {
    throw new ApiError("invalid_payload", "results must be an array of 1 to 20 items");
  }
  return results.map((item) => {
    if (!is_record(item)) {
      throw new ApiError("invalid_payload", "each result item must be a JSON object");
    }
    reject_unknown_fields(item, RESULT_ITEM_FIELDS);
    if (item.op !== "append_version") {
      throw new ApiError("invalid_payload", 'result op must be "append_version"');
    }
    const { op: _op, ...fields } = item;
    return fields;
  });
}

/** Plan every item of a validated results list without writing (versions of one object chain in order). */
export function plan_result_items(runtime: CommandRuntime, items: Record<string, unknown>[]): AppendPlan[] {
  const reserved = new Map<string, number>();
  const previous = new Map<string, AppendPlan>();
  return items.map((item) => {
    const plan = plan_append_version(runtime, item, reserved, previous);
    previous.set(plan.object_id, plan);
    return plan;
  });
}

/**
 * Submit a small atomic batch of version appends for one run. The project's
 * current lease (exact run/lease/fence and owner) is required; an optional
 * ctx.base_control_rev is checked before any write. Every item is validated
 * and appended in the same transaction, then one receipt and one event per
 * appended version are written. A failure anywhere rolls the whole batch back.
 */
function run_submit_results(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, RESULT_SUBMIT_FIELDS);
  const guard = optional_lease_guard(payload);
  if (guard === null) {
    throw new ApiError("invalid_payload", "run_id, lease_id and fence are required");
  }
  const scope = content_scope(runtime);

  // An empty list is a payload error and must win over a stale rev.
  const items = parse_result_items(payload.results);

  const base = require_base_control_rev(runtime, runtime.ctx.base_control_rev);
  require_current_lease(runtime, guard);
  const plans = plan_result_items(runtime, items);

  const result = {
    project_id: scope.project_id,
    run_id: guard.run_id,
    results: plans.map((plan) => ({
      object_id: plan.object_id,
      version_id: plan.version_id,
      version_no: plan.version_no,
    })),
  };
  // The receipt must exist before the version rows: object_versions.tx_id
  // references this transaction's mutation_commits row.
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "result.submitted",
    base_control_rev: base ?? null,
    run_id: guard.run_id,
    lease_id: guard.lease_id,
    fence: guard.fence,
    result,
  });
  for (const plan of plans) {
    write_append_plan(runtime, plan, scope.actor_id, guard.run_id);
  }
  return {
    result,
    events: plans.map((plan) => ({
      type: "result.submitted",
      run_id: guard.run_id,
      payload: {
        object_id: plan.object_id,
        version_id: plan.version_id,
        version_no: plan.version_no,
        kind: plan.kind,
      },
    })),
  };
}

function run_set_current(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  require_fields(payload, ["object_id", "version_id"]);
  const object_id = require_non_empty_string(payload, "object_id");
  const version_id = require_non_empty_string(payload, "version_id");
  const scope = content_scope(runtime);
  const object = read_object(runtime, scope.project_id, object_id);
  const version = read_version(runtime, scope.project_id, version_id);
  if (version.object_id !== object.id || version.kind !== object.kind) {
    throw new ApiError("conflict", "the version belongs to another object");
  }

  const rev = Number(object.rev) + 1;
  const result = { project_id: scope.project_id, object_id, version_id, rev };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "content.current_set",
    base_control_rev: null,
    result,
  });
  const written = runtime.db.run(
    "UPDATE objects SET current_version_id = ?, rev = rev + 1 WHERE project_id = ? AND id = ? AND rev = ?",
    version_id,
    scope.project_id,
    object_id,
    object.rev,
  );
  if (written.changes !== 1n) {
    throw new ApiError("conflict", "the object moved concurrently");
  }
  return {
    result,
    events: [
      {
        type: "content.current_set",
        payload: { object_id, version_id, rev },
      },
    ],
  };
}

function run_add_citation(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  require_fields(payload, ["artifact_version_id", "source_version_id", "quote", "locator"]);
  const artifact_version_id = require_non_empty_string(payload, "artifact_version_id");
  const source_version_id = require_non_empty_string(payload, "source_version_id");
  const quote = optional_text(payload, "quote");
  const locator = json_object(payload, "locator");
  const scope = content_scope(runtime);

  const artifact = read_version(runtime, scope.project_id, artifact_version_id);
  if (artifact.kind !== "artifact") {
    throw new ApiError("conflict", "artifact_version_id is not an artifact version");
  }
  require_latest_version(runtime, scope.project_id, artifact);

  const source = read_version(runtime, scope.project_id, source_version_id);
  if (source.kind !== "source") {
    throw new ApiError("conflict", "source_version_id is not a source version");
  }
  const facts = runtime.db.get<{ verification_state: string }>(
    "SELECT verification_state FROM source_versions WHERE project_id = ? AND version_id = ?",
    scope.project_id,
    source_version_id,
  );
  if (facts === undefined) {
    throw new ApiError("conflict", "the source version facts are missing");
  }
  if (quote !== null && facts.verification_state === "unreachable") {
    throw new ApiError("invalid_payload", "an unreachable source cannot carry an excerpt");
  }

  const last = runtime.db.get<{ max_no: bigint | null }>(
    "SELECT MAX(citation_no) AS max_no FROM citations WHERE project_id = ? AND artifact_version_id = ?",
    scope.project_id,
    artifact_version_id,
  );
  const citation_no = Number(last?.max_no ?? 0n) + 1;
  const result = { project_id: scope.project_id, artifact_version_id, citation_no };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "content.citation_added",
    base_control_rev: null,
    result,
  });
  runtime.db.run(
    "INSERT INTO citations (project_id, artifact_version_id, citation_no, source_version_id, quote, locator) VALUES (?, ?, ?, ?, ?, ?)",
    scope.project_id,
    artifact_version_id,
    citation_no,
    source_version_id,
    quote,
    JSON.stringify(locator),
  );
  return {
    result,
    events: [
      {
        type: "content.citation_added",
        payload: { artifact_version_id, source_version_id, citation_no },
      },
    ],
  };
}

function run_link_relation(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  require_fields(payload, ["from_version_id", "to_version_id", "kind"]);
  const from_version_id = require_non_empty_string(payload, "from_version_id");
  const to_version_id = require_non_empty_string(payload, "to_version_id");
  const kind = require_enum(payload, "kind", RELATION_KINDS);
  const scope = content_scope(runtime);

  const from = read_version(runtime, scope.project_id, from_version_id);
  const to = read_version(runtime, scope.project_id, to_version_id);
  if (from.id === to.id) {
    throw new ApiError("invalid_payload", "a version cannot relate to itself");
  }
  require_latest_version(runtime, scope.project_id, from);

  const duplicate = runtime.db.get<{ ok: bigint }>(
    "SELECT 1 AS ok FROM version_relations WHERE project_id = ? AND from_version_id = ? AND to_version_id = ? AND kind = ?",
    scope.project_id,
    from_version_id,
    to_version_id,
    kind,
  );
  if (duplicate !== undefined) {
    throw new ApiError("conflict", "the relation already exists");
  }

  const result = { project_id: scope.project_id, from_version_id, to_version_id, kind };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "content.relation_linked",
    base_control_rev: null,
    result,
  });
  runtime.db.run(
    "INSERT INTO version_relations (project_id, from_version_id, to_version_id, kind) VALUES (?, ?, ?, ?)",
    scope.project_id,
    from_version_id,
    to_version_id,
    kind,
  );
  return {
    result,
    events: [
      {
        type: "content.relation_linked",
        payload: { from_version_id, to_version_id, kind },
      },
    ],
  };
}

function map_artifact_kind(
  item: Record<string, unknown>,
  extras: Record<string, unknown>,
): string {
  const value = item.kind;
  if (typeof value === "string" && ARTIFACT_KINDS.has(value)) return value;
  if (value !== undefined) extras.kind_original = value;
  return "note";
}

function map_library_item(item: Record<string, unknown>): {
  artifact_kind: string;
  fields: ArtifactFields;
} {
  // Null-prototype bag: item keys such as "__proto__" or "constructor" stay
  // ordinary data and reach JSON, and they cannot pollute a prototype.
  const extras = Object.create(null) as Record<string, unknown>;
  const artifact_kind = map_artifact_kind(item, extras);

  // A missing or non-string title gets a sentinel; the original value (null when
  // the key was absent) is kept in legacy_extra.title_original.
  const title = typeof item.title === "string" ? item.title : MISSING_TITLE;
  if (typeof item.title !== "string") extras.title_original = item.title === undefined ? null : item.title;

  const summary = typeof item.summary === "string" ? item.summary : "";
  if (item.summary !== undefined && typeof item.summary !== "string") extras.summary = item.summary;

  const question = typeof item.question === "string" ? item.question : null;
  if (item.question !== undefined && item.question !== null && typeof item.question !== "string") {
    extras.question = item.question;
  }

  const body_md = typeof item.details === "string" ? item.details : null;
  if (item.details !== undefined && item.details !== null && typeof item.details !== "string") {
    extras.details = item.details;
  }

  const status =
    typeof item.status === "string" && ARTIFACT_STATUSES.has(item.status) ? item.status : "new";
  if (item.status !== undefined && (typeof item.status !== "string" || !ARTIFACT_STATUSES.has(item.status))) {
    extras.status = item.status;
  }

  const confidence =
    typeof item.confidence === "string" && CONFIDENCE_LEVELS.has(item.confidence)
      ? item.confidence
      : null;
  if (
    item.confidence !== undefined &&
    item.confidence !== null &&
    (typeof item.confidence !== "string" || !CONFIDENCE_LEVELS.has(item.confidence))
  ) {
    extras.confidence = item.confidence;
  }

  const stats = Array.isArray(item.stats) ? item.stats : [];
  if (item.stats !== undefined && !Array.isArray(item.stats)) extras.stats = item.stats;

  const conflicts = Array.isArray(item.conflicts) ? item.conflicts : [];
  if (item.conflicts !== undefined && !Array.isArray(item.conflicts)) extras.conflicts = item.conflicts;

  const verify = item.verify === undefined ? null : item.verify;

  const mapped = new Set([
    "id",
    "title",
    "kind",
    "question",
    "summary",
    "details",
    "status",
    "confidence",
    "stats",
    "conflicts",
    "verify",
    "sources",
    // The importer owns these two: an item key with the same name is kept in
    // the original event payload, not merged into the bookkeeping.
    "legacy_id",
    "kind_original",
  ]);
  for (const key of Object.keys(item)) {
    if (!mapped.has(key)) extras[key] = item[key];
  }
  // Bookkeeping wins over any item key of the same name (leader decision).
  extras.legacy_id = item.id;
  if (typeof item.kind !== "string" || !ARTIFACT_KINDS.has(item.kind)) {
    extras.kind_original = item.kind;
  }

  return {
    artifact_kind,
    fields: {
      title,
      summary,
      question,
      body_md,
      status,
      confidence,
      stats,
      conflicts,
      verify,
      metadata: { legacy_extra: extras },
    },
  };
}

function plan_library_source(source: Record<string, unknown>): Omit<PlannedSource, "object_id" | "version_id"> {
  const locator: Record<string, unknown> = is_record(source.locator) ? { ...source.locator } : {};
  if (source.date !== undefined) locator.date = source.date;
  if (source.note !== undefined) locator.note = source.note;
  const method =
    typeof source.method === "string" && SOURCE_METHODS.has(source.method) ? source.method : "unknown";
  const source_kind =
    typeof source.kind === "string" && SOURCE_KINDS.has(source.kind) ? source.kind : "web";
  return {
    source_kind,
    canonical_locator: typeof source.canonical_locator === "string" ? source.canonical_locator : null,
    title: typeof source.title === "string" ? source.title : "",
    url: typeof source.url === "string" ? source.url : null,
    locator,
    method,
  };
}

function plan_library_item(runtime: CommandRuntime, raw: Record<string, unknown>): PlannedItem {
  const legacy_id = require_legacy_id(raw.id);
  const sources_value = raw.sources;
  let sources: unknown[] = [];
  if (sources_value === undefined || sources_value === null) sources = [];
  else if (Array.isArray(sources_value)) sources = sources_value;
  else throw new ApiError("invalid_payload", "item.sources must be an array");

  const mapped = map_library_item(raw);
  return {
    legacy_id,
    object_id: runtime.new_id(),
    version_id: runtime.new_id(),
    artifact_kind: mapped.artifact_kind,
    fields: mapped.fields,
    archived: mapped.fields.status === "removed",
    sources: sources.map((source) => {
      if (!is_record(source)) {
        throw new ApiError("invalid_payload", "every library source must be a JSON object");
      }
      return {
        object_id: runtime.new_id(),
        version_id: runtime.new_id(),
        ...plan_library_source(source),
      };
    }),
  };
}

function prior_import_items(value: unknown): ImportItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: ImportItem[] = [];
  for (const entry of value) {
    if (!is_record(entry)) return null;
    const legacy_id = entry.legacy_id;
    const object_id = entry.object_id;
    const version_id = entry.version_id;
    if (
      !is_legacy_id(legacy_id) ||
      typeof object_id !== "string" ||
      typeof version_id !== "string"
    ) {
      return null;
    }
    items.push({ legacy_id, object_id, version_id });
  }
  return items;
}

interface PriorImport {
  library_hash: string | null;
  shell_hash: string | null;
  items: ImportItem[];
  keys: string[];
}

const MISSING_TITLE = "(제목 없음)";

/** Top-level keys that change on every export and are not part of identity. */
const VOLATILE_LIBRARY_KEYS: ReadonlySet<string> = new Set(["items", "imported", "round"]);

function is_legacy_id(value: unknown): value is LegacyId {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0;
  return typeof value === "string" && value.trim().length > 0 && value.isWellFormed();
}

function require_legacy_id(value: unknown): LegacyId {
  if (!is_legacy_id(value)) {
    throw new ApiError("invalid_payload", "every library item needs a safe integer or non-empty string id");
  }
  return value;
}

/** Typed comparison key: 5 and "5" are different items. */
function legacy_key(id: LegacyId): string {
  return typeof id === "number" ? `number:${id}` : `string:${id}`;
}

/** Hash of the library metadata excluding the item list and volatile keys. */
function library_shell_hash(library: Record<string, unknown>): string {
  const shell = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(library)) {
    if (!VOLATILE_LIBRARY_KEYS.has(key)) shell[key] = library[key];
  }
  return createHash("sha256").update(canonical_json(shell)).digest("hex");
}

/**
 * SQLite TEXT cannot store a lone surrogate faithfully. Refuse the whole
 * library before any write instead of silently replacing code units.
 */
function require_well_formed_library(value: unknown): void {
  if (typeof value === "string") {
    if (!value.isWellFormed()) {
      throw new ApiError("invalid_payload", "library text contains a lone surrogate");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) require_well_formed_library(entry);
    return;
  }
  if (is_record(value)) {
    for (const key of Object.keys(value)) {
      require_well_formed_library(key);
      require_well_formed_library(value[key]);
    }
  }
}

function prior_imports(runtime: CommandRuntime, project_id: string): PriorImport[] {
  const rows = runtime.db.all<{ payload: string }>(
    "SELECT payload FROM events WHERE project_id = ? AND type = 'content.library_imported' ORDER BY event_seq",
    project_id,
  );
  const out: PriorImport[] = [];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (!is_record(parsed)) continue;
    const items = prior_import_items(parsed.items);
    if (items === null) continue;
    const library_hash = typeof parsed.library_hash === "string" ? parsed.library_hash : null;
    const shell_hash = typeof parsed.shell_hash === "string" ? parsed.shell_hash : null;
    out.push({ library_hash, shell_hash, items, keys: items.map((entry) => legacy_key(entry.legacy_id)) });
  }
  return out;
}

function legacy_source_facts(source: PlannedSource): SourceFacts {
  return {
    title: source.title,
    url: source.url,
    locator: source.locator,
    retrieved_at: null,
    method: source.method,
    verification_state: "legacy_unknown",
    quote: null,
    verified_by_actor_id: null,
  };
}

/** A new key for the same library writes only a receipt and one skipped event. */
function skip_library_import(
  runtime: CommandRuntime,
  scope: ContentScope,
  items: ImportItem[],
  seen: { library_hash: string; original: Record<string, unknown> | null },
): CommandResult {
  const result = { project_id: scope.project_id, already_imported: true, items };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "content.library_imported",
    base_control_rev: null,
    result,
  });
  return {
    result,
    events: [
      {
        type: "content.library_import_skipped",
        payload:
          seen.original === null
            ? { already_imported: true, items, library_hash: seen.library_hash }
            : { already_imported: true, items, library_hash: seen.library_hash, original: seen.original },
      },
    ],
  };
}

function run_import_library(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  require_fields(payload, ["library"]);
  const library = payload.library;
  if (!is_record(library)) {
    throw new ApiError("invalid_payload", "library must be a JSON object");
  }
  require_well_formed_library(library);
  const raw_items = library.items;
  if (!Array.isArray(raw_items)) {
    throw new ApiError("invalid_payload", "library.items must be an array");
  }
  const seen = new Set<string>();
  for (const item of raw_items) {
    if (!is_record(item)) {
      throw new ApiError("invalid_payload", "every library item must be a JSON object");
    }
    const key = legacy_key(require_legacy_id(item.id));
    if (seen.has(key)) {
      throw new ApiError("invalid_payload", "library item ids must be unique");
    }
    seen.add(key);
    const sources = item.sources;
    if (sources !== undefined && sources !== null) {
      if (!Array.isArray(sources)) {
        throw new ApiError("invalid_payload", "item.sources must be an array");
      }
      for (const source of sources) {
        if (!is_record(source)) {
          throw new ApiError("invalid_payload", "every library source must be a JSON object");
        }
      }
    }
  }

  const scope = content_scope(runtime);
  const library_hash = createHash("sha256").update(canonical_json(library)).digest("hex");

  const prior = prior_imports(runtime, scope.project_id);
  const exact = prior.find((entry) => entry.library_hash === library_hash);
  if (exact !== undefined) {
    return skip_library_import(runtime, scope, exact.items, { library_hash, original: null });
  }

  // Within the same library identity (everything except the item list), each
  // legacy id already imported in this project is reused; only ids that are new
  // are written. The earlier import bundle does not have to be fully contained.
  const shell_hash = library_shell_hash(library);
  const reused = new Map<string, ImportItem>();
  for (const entry of prior) {
    if (entry.shell_hash !== shell_hash) continue;
    entry.items.forEach((item, index) => {
      const key = entry.keys[index]!;
      if (!reused.has(key)) reused.set(key, item);
    });
  }

  const planned: PlannedItem[] = [];
  const items: ImportItem[] = [];
  for (const raw of raw_items) {
    const item = raw as Record<string, unknown>;
    const legacy_id = item.id as LegacyId;
    const known = reused.get(legacy_key(legacy_id));
    if (known !== undefined) {
      items.push(known);
      continue;
    }
    const entry = plan_library_item(runtime, item);
    planned.push(entry);
    items.push({ legacy_id, object_id: entry.object_id, version_id: entry.version_id });
  }

  if (planned.length === 0 && raw_items.length > 0) {
    return skip_library_import(runtime, scope, items, { library_hash, original: library });
  }

  const result = { project_id: scope.project_id, already_imported: false, items };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "content.library_imported",
    base_control_rev: null,
    result,
  });

  for (const item of planned) {
    write_object(
      runtime,
      scope.project_id,
      item.object_id,
      "artifact",
      null,
      item.archived ? runtime.now_ms : null,
    );
    write_object_version(runtime, {
      project_id: scope.project_id,
      object_id: item.object_id,
      kind: "artifact",
      version_id: item.version_id,
      version_no: 1,
      based_on_version_id: null,
      actor_id: scope.actor_id,
      content_hash: content_digest("artifact", artifact_digest_fields(item.fields)),
    });
    runtime.db.run(
      "INSERT INTO artifacts (project_id, object_id, kind, stage_id) VALUES (?, ?, ?, NULL)",
      scope.project_id,
      item.object_id,
      item.artifact_kind,
    );
    write_artifact_version(runtime, scope.project_id, item.object_id, item.version_id, item.fields);
    set_first_current_version(runtime, scope.project_id, item.object_id, item.version_id);

    item.sources.forEach((source, index) => {
      const facts = legacy_source_facts(source);
      write_object(runtime, scope.project_id, source.object_id, "source", null, null);
      write_object_version(runtime, {
        project_id: scope.project_id,
        object_id: source.object_id,
        kind: "source",
        version_id: source.version_id,
        version_no: 1,
        based_on_version_id: null,
        actor_id: scope.actor_id,
        content_hash: content_digest("source", source_digest_fields(facts)),
      });
      runtime.db.run(
        "INSERT INTO sources (project_id, object_id, kind, canonical_locator) VALUES (?, ?, ?, ?)",
        scope.project_id,
        source.object_id,
        source.source_kind,
        source.canonical_locator,
      );
      write_source_version(runtime, {
        project_id: scope.project_id,
        object_id: source.object_id,
        version_id: source.version_id,
        facts,
      });
      set_first_current_version(runtime, scope.project_id, source.object_id, source.version_id);
      runtime.db.run(
        "INSERT INTO citations (project_id, artifact_version_id, citation_no, source_version_id, quote, locator) VALUES (?, ?, ?, ?, NULL, '{}')",
        scope.project_id,
        item.version_id,
        index + 1,
        source.version_id,
      );
    });
  }

  return {
    result,
    events: [
      {
        type: "content.library_imported",
        payload: {
          original: library,
          library_hash,
          shell_hash,
          item_keys: items.map((entry) => legacy_key(entry.legacy_id)),
          items,
        },
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

const CONTENT_COMMAND_INPUTS: ReadonlyArray<readonly [string, CommandDefinition]> = [
  ["content.create_object", definition("content.object_created", run_create_object)],
  ["content.add_artifact", definition("content.artifact_added", run_add_artifact)],
  ["content.add_source", definition("content.source_added", run_add_source)],
  ["content.append_version", definition("content.version_appended", run_append_version)],
  ["content.set_current", definition("content.current_set", run_set_current)],
  ["content.add_citation", definition("content.citation_added", run_add_citation)],
  ["content.link_relation", definition("content.relation_linked", run_link_relation)],
  ["content.import_library", definition("content.library_imported", run_import_library)],
];

const RESULT_COMMAND_INPUTS: ReadonlyArray<readonly [string, CommandDefinition]> = [
  ["result.submit", definition("result.submitted", run_submit_results)],
];

/**
 * Registry entries merged into COMMANDS by commands.ts (names, not actions).
 * The array and each name/definition tuple are frozen, so importing this module
 * before commands.ts cannot inject or replace a command.
 */
export const CONTENT_COMMAND_ENTRIES: ReadonlyArray<readonly [string, CommandDefinition]> =
  Object.freeze(CONTENT_COMMAND_INPUTS.map((entry) => Object.freeze([entry[0], entry[1]] as const)));

/**
 * The result bundle is defined in the content domain but kept in its own
 * frozen entries group so the existing content.* registry view stays exactly
 * the eight content commands.
 */
export const RESULT_COMMAND_ENTRIES: ReadonlyArray<readonly [string, CommandDefinition]> =
  Object.freeze(RESULT_COMMAND_INPUTS.map((entry) => Object.freeze([entry[0], entry[1]] as const)));

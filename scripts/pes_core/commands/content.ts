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

interface ArtifactFields {
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

interface SourceFacts {
  title: string;
  url: string | null;
  locator: Record<string, unknown>;
  retrieved_at: number | null;
  method: string;
  verification_state: string;
  quote: string | null;
  verified_by_actor_id: string | null;
}

interface ImportItem {
  legacy_id: string;
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
  legacy_id: string;
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
  payload: Record<string, unknown>,
  field: string,
): string | null {
  const value = payload[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || !value.isWellFormed()) {
    throw new ApiError("invalid_payload", `${field} must be a non-empty string or null`);
  }
  const actor = runtime.db.get<{ ok: bigint }>("SELECT 1 AS ok FROM actors WHERE id = ?", value);
  if (actor === undefined) {
    throw new ApiError("not_found", `${field} is not an actor`);
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

function parse_source_facts(runtime: CommandRuntime, payload: Record<string, unknown>): SourceFacts {
  const title = require_non_empty_string(payload, "title");
  const url = optional_text(payload, "url");
  const locator = json_object(payload, "locator");
  const retrieved_at = optional_integer(payload, "retrieved_at");
  const method = require_enum(payload, "method", SOURCE_METHODS);
  const verification_state = require_enum(payload, "verification_state", VERIFICATION_STATES);
  const quote = optional_text(payload, "quote");
  const verified_by_actor_id = optional_actor(runtime, payload, "verified_by_actor_id");
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

function artifact_digest_fields(fields: ArtifactFields): Record<string, unknown> {
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

function source_digest_fields(facts: SourceFacts): Record<string, unknown> {
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

function content_digest(kind: string, fields: Record<string, unknown>): string {
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

function write_object(
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
    content_hash: string;
  },
): void {
  const written = runtime.db.run(
    `INSERT INTO object_versions
       (id, project_id, object_id, kind, version_no, based_on_version_id, created_in_round_id,
        actor_id, run_id, tx_id, content_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?)`,
    input.version_id,
    input.project_id,
    input.object_id,
    input.kind,
    input.version_no,
    input.based_on_version_id,
    input.actor_id,
    runtime.tx_id,
    input.content_hash,
    runtime.now_ms,
  );
  if (written.changes !== 1n) {
    throw new Error("the object version was not written");
  }
}

function write_artifact_version(
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

function write_source_version(
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
function set_first_current_version(
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
  const facts = parse_source_facts(runtime, payload);
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

function run_append_version(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  const object_id = require_non_empty_string(payload, "object_id");
  const scope = content_scope(runtime);
  const object = read_object(runtime, scope.project_id, object_id);
  if (object.kind !== "artifact" && object.kind !== "source") {
    throw new ApiError("conflict", "only artifacts and sources take versions");
  }

  const version_id = runtime.new_id();
  let version_no: number;

  if (object.kind === "artifact") {
    require_fields(payload, ["object_id", "based_on_version_id", ...ARTIFACT_COMMON_FIELDS]);
    const fields = parse_artifact_fields(payload);
    const based_on_version_id = resolve_based_on(runtime, scope.project_id, object, payload);
    version_no = next_version_no(runtime, scope.project_id, object_id);
    const result = { project_id: scope.project_id, object_id, version_id, version_no };
    insert_receipt(runtime, {
      project_id: scope.project_id,
      actor_id: scope.actor_id,
      action: "content.version_appended",
      base_control_rev: null,
      result,
    });
    write_object_version(runtime, {
      project_id: scope.project_id,
      object_id,
      kind: "artifact",
      version_id,
      version_no,
      based_on_version_id,
      actor_id: scope.actor_id,
      content_hash: content_digest("artifact", artifact_digest_fields(fields)),
    });
    write_artifact_version(runtime, scope.project_id, object_id, version_id, fields);
    return {
      result,
      events: [
        {
          type: "content.version_appended",
          payload: { object_id, version_id, version_no, kind: object.kind },
        },
      ],
    };
  }

  require_fields(payload, ["object_id", "based_on_version_id", ...SOURCE_COMMON_FIELDS]);
  const facts = parse_source_facts(runtime, payload);
  const based_on_version_id = resolve_based_on(runtime, scope.project_id, object, payload);
  version_no = next_version_no(runtime, scope.project_id, object_id);
  const result = { project_id: scope.project_id, object_id, version_id, version_no };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "content.version_appended",
    base_control_rev: null,
    result,
  });
  write_object_version(runtime, {
    project_id: scope.project_id,
    object_id,
    kind: "source",
    version_id,
    version_no,
    based_on_version_id,
    actor_id: scope.actor_id,
    content_hash: content_digest("source", source_digest_fields(facts)),
  });
  write_source_version(runtime, {
    project_id: scope.project_id,
    object_id,
    version_id,
    facts,
  });
  return {
    result,
    events: [
      {
        type: "content.version_appended",
        payload: { object_id, version_id, version_no, kind: object.kind },
      },
    ],
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
  const extras: Record<string, unknown> = { legacy_id: item.id };
  const artifact_kind = map_artifact_kind(item, extras);

  const title = typeof item.title === "string" ? item.title : "";
  if (item.title !== undefined && typeof item.title !== "string") extras.title = item.title;

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
  ]);
  for (const key of Object.keys(item)) {
    if (!mapped.has(key)) extras[key] = item[key];
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

function plan_library(runtime: CommandRuntime, raw_items: unknown[]): PlannedItem[] {
  return raw_items.map((raw) => {
    if (!is_record(raw)) {
      throw new ApiError("invalid_payload", "every library item must be a JSON object");
    }
    const legacy_id = raw.id;
    if (typeof legacy_id !== "string" || legacy_id.trim().length === 0 || !legacy_id.isWellFormed()) {
      throw new ApiError("invalid_payload", "every library item needs a non-empty id");
    }
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
  });
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
      typeof legacy_id !== "string" ||
      typeof object_id !== "string" ||
      typeof version_id !== "string"
    ) {
      return null;
    }
    items.push({ legacy_id, object_id, version_id });
  }
  return items;
}

function prior_import(
  runtime: CommandRuntime,
  project_id: string,
  library_hash: string,
): ImportItem[] | null {
  const rows = runtime.db.all<{ payload: string }>(
    "SELECT payload FROM events WHERE project_id = ? AND type = 'content.library_imported' ORDER BY event_seq",
    project_id,
  );
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (!is_record(parsed)) continue;
    if (parsed.library_hash !== library_hash) continue;
    const items = prior_import_items(parsed.items);
    if (items !== null) return items;
  }
  return null;
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

function run_import_library(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  require_fields(payload, ["library"]);
  const library = payload.library;
  if (!is_record(library)) {
    throw new ApiError("invalid_payload", "library must be a JSON object");
  }
  const raw_items = library.items;
  if (!Array.isArray(raw_items)) {
    throw new ApiError("invalid_payload", "library.items must be an array");
  }
  const seen = new Set<string>();
  for (const item of raw_items) {
    if (!is_record(item)) {
      throw new ApiError("invalid_payload", "every library item must be a JSON object");
    }
    const legacy_id = item.id;
    if (typeof legacy_id !== "string" || legacy_id.trim().length === 0 || !legacy_id.isWellFormed()) {
      throw new ApiError("invalid_payload", "every library item needs a non-empty id");
    }
    if (seen.has(legacy_id)) {
      throw new ApiError("invalid_payload", "library item ids must be unique");
    }
    seen.add(legacy_id);
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
  const prior = prior_import(runtime, scope.project_id, library_hash);
  if (prior !== null) {
    const result = { project_id: scope.project_id, already_imported: true, items: prior };
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
          payload: { already_imported: true, items: prior },
        },
      ],
    };
  }

  const planned = plan_library(runtime, raw_items);
  const items = planned.map((item) => ({
    legacy_id: item.legacy_id,
    object_id: item.object_id,
    version_id: item.version_id,
  }));
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
        payload: { original: library, library_hash, items },
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

/**
 * Registry entries merged into COMMANDS by commands.ts (names, not actions).
 * The array and each name/definition tuple are frozen, so importing this module
 * before commands.ts cannot inject or replace a command.
 */
export const CONTENT_COMMAND_ENTRIES: ReadonlyArray<readonly [string, CommandDefinition]> =
  Object.freeze(CONTENT_COMMAND_INPUTS.map((entry) => Object.freeze([entry[0], entry[1]] as const)));

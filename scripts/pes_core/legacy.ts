// Legacy project importer (stage 2 PR11).
//
// This module is the read-and-plan side of the importer. It reads a synthetic
// legacy folder, parses every file, and builds a complete plan of the rows the
// command will write. The plan carries references by stable string keys because
// identifiers are allocated by the command service at execution time.
//
// The write path lives in scripts/pes_core/commands/legacy.ts: every business
// table write is there, inside one legacy.import_project command execution.
// This module only reads the source folder and the database; map_legacy and
// report_unknown are strictly read-only.
//
// The source folder is never written, renamed, deleted or locked. Files are
// copied into the service's canonical object store by the command, which
// re-reads and measures the stored bytes before a blob becomes ready (the PR9
// storage rule). A damaged project.json fails the batch without activating
// anything; every other damaged file is kept as a raw blob and reported.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";

import type { CommandService } from "./commands.ts";
import { canonical_object_store_dir } from "./commands/shared.ts";
import type { Db } from "./db.ts";
import { ApiError } from "./errors.ts";
import { read_storage_bytes, sha256_hex } from "./files.ts";

// ---------------------------------------------------------------------------
// Public shapes (the test interface lives in tests/helpers/legacy_env.ts)

export type ReportCategory =
  | "unknown_field"
  | "unprocessed_answer"
  | "missing_file"
  | "parse_error"
  | "processed_without_file"
  | "unmapped_input"
  | "quarantined"
  | "default_filled";

export interface ReportEntry {
  category: ReportCategory;
  path: string;
  key?: string;
  detail?: unknown;
}

export interface UnknownReport {
  batch_id: string;
  entries: ReportEntry[];
}

export interface ScannedFile {
  path: string;
  size: number;
  sha256: string;
}

export interface LegacyScan {
  files: ScannedFile[];
  fingerprint: string;
  project_json_ok: boolean;
}

export interface ImportOptions {
  owner_actor_id: string;
}

export interface ImportResult {
  batch_id: string;
  project_id: string;
  state: "staging" | "failed";
  replayed: boolean;
  source_fingerprint: string;
  report: UnknownReport;
}

export interface MappingRow {
  legacy_kind: string;
  legacy_scope: string;
  legacy_key: string;
  content_hash: string;
  new_object_id: string | null;
  new_version_id: string | null;
  new_row_id: string | null;
}

// ---------------------------------------------------------------------------
// Stage keys (kept local so importing this module cannot create a runtime cycle
// with commands.ts)

export const LEGACY_STAGE_KEYS = [
  "plan",
  "research",
  "analyze",
  "write",
  "verify",
  "publish",
] as const;

export type LegacyStageKey = (typeof LEGACY_STAGE_KEYS)[number];

const STAGE_KEY_SET = new Set<string>(LEGACY_STAGE_KEYS);

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
const QUESTION_TYPES = new Set(["single", "multi", "text", "textarea", "number", "scale", "file"]);

const KNOWN_TOP_LEVEL = new Set([
  "pes",
  "topic",
  "slug",
  "created",
  "current",
  "settings",
  "processed",
  "complete",
  "executive_summary",
  "conclusion",
  "notes",
  "stages",
  "library",
]);

const KNOWN_STAGE_KEYS = new Set([
  "status",
  "round",
  "settings",
  "review",
  "suggestions",
  "warnings",
  "changes",
  "history",
  "summary",
  "approved_at",
  "stale",
  "reports",
  "reports_built",
  "qa",
  "review_log",
  "carry_over",
  "items",
]);

const KNOWN_ITEM_KEYS = new Set([
  "id",
  "title",
  "kind",
  "question",
  "reuse",
  "model",
  "status",
  "request",
  "depth",
  "updated_round",
  "summary",
  "details",
  "sources",
  "stats",
  "shots",
  "confidence",
  "conflicts",
  "verify",
  "links",
  "user_links",
  "verdict",
  "order",
  "path",
]);

const KNOWN_LIBRARY_KEYS = new Set([
  "source",
  "imported",
  "round",
  "topic",
  "settings",
  "items",
  "suggestions",
  "warnings",
]);

const REGENERABLE_EXACT = new Set([
  "index.html",
  ".pes-lock",
  ".pes-port",
  ".pes-server",
  "out/report.html",
]);

const IMPORTER_VERSION = "pes-legacy-import/1";

// ---------------------------------------------------------------------------
// Plan shapes consumed by scripts/pes_core/commands/legacy.ts

export interface PlanBlob {
  path: string;
  sha256: string;
  size: number;
  media_type: string;
  state: "ready" | "quarantined";
}

export interface PlanVersionData {
  key: string;
  version_no: number;
  created_at: number;
  created_in_round_key: string | null;
  content_hash: string;
}

export interface PlanArtifactData {
  artifact_kind: string;
  stage_key: LegacyStageKey | null;
  title: string;
  question: string | null;
  summary: string;
  body_md: string | null;
  status: string;
  confidence: string | null;
  stats: unknown[];
  conflicts: unknown[];
  verify: unknown;
  metadata: Record<string, unknown>;
}

export interface PlanSourceData {
  source_kind: string;
  canonical_locator: string | null;
  title: string;
  url: string | null;
  locator: Record<string, unknown>;
  retrieved_at: number | null;
  method: string;
  verification_state: string;
}

export interface PlanQuestionData {
  bank_key: string | null;
  origin: string;
  direction: string;
  text: string;
  type: string;
  required: boolean;
  options: unknown[];
  default_value: unknown;
  show_if: unknown;
  help: string | null;
  state: string;
}

export interface PlanAnswerData {
  question_key: string;
  question_version_key: string;
  submission_key: string;
  value: unknown;
  state: string;
}

export interface PlanThreadData {
  target_object_key: string;
  target_version_key: string | null;
  context_kind: string;
}

export interface PlanMessageData {
  thread_key: string;
  submission_key: string | null;
  body_md: string;
  state: string;
}

export interface PlanFollowupData {
  kind: string;
  state: string;
  description: string;
  target_stage_key: LegacyStageKey | null;
  base_version_key: string | null;
}

export type PlanObjectKind =
  | "artifact"
  | "source"
  | "question"
  | "answer"
  | "thread"
  | "message"
  | "followup";

export interface PlanObjectRow {
  key: string;
  kind: PlanObjectKind;
  edition: "edition" | null;
  archived: boolean;
  version: PlanVersionData;
  artifact?: PlanArtifactData;
  source?: PlanSourceData;
  question?: PlanQuestionData;
  answer?: PlanAnswerData;
  thread?: PlanThreadData;
  message?: PlanMessageData;
  followup?: PlanFollowupData;
}

export interface PlanCitation {
  artifact_version_key: string;
  source_version_key: string;
  citation_no: number;
  quote: string | null;
  locator: Record<string, unknown>;
}

export interface PlanVersionFile {
  version_key: string;
  blob_path: string;
  role: string;
}

export interface PlanQuestionSet {
  key: string;
  stage_key: LegacyStageKey;
  round_key: string | null;
  purpose: string;
  form_key: string;
  version_no: number;
  published_at: number;
  members: Array<{
    question_key: string;
    question_version_key: string;
    position: number;
  }>;
}

export interface PlanSubmission {
  key: string;
  raw_blob_path: string;
  received_at: number;
  set_key: string | null;
}

export interface PlanSnapshot {
  key: string;
  stage_key: LegacyStageKey;
  round_key: string | null;
  scope: "round" | "stage";
  source: { kind: "file"; path: string } | { kind: "inline"; json: string };
}

export interface PlanApproval {
  stage_key: LegacyStageKey;
  snapshot_key: string;
  approved_at_ms: number | null;
  note: string | null;
}

export interface PlanStageRow {
  key: LegacyStageKey;
  status: "pending" | "asking" | "active" | "approved";
  settings: Record<string, unknown>;
  stale: boolean;
  approved_at_ms: number | null;
  approval_snapshot_key: string | null;
  rounds: Array<{
    round_no: number;
    sealed: boolean;
    snapshot_key: string | null;
  }>;
}

export interface PlanEvent {
  type: string;
  payload: unknown;
}

export interface ImportPlan {
  fingerprint: string;
  project_json_ok: boolean;
  failed: boolean;
  source_schema: string;
  importer_version: string;
  manifest_files: ScannedFile[];
  project: {
    slug: string | null;
    topic: string;
    created_at: number;
    complete: boolean;
    current_stage_key: LegacyStageKey | null;
  };
  edition_settings: Record<string, unknown>;
  edition_status: "draft" | "active" | "completed";
  stages: PlanStageRow[];
  snapshots: PlanSnapshot[];
  approvals: PlanApproval[];
  blobs: PlanBlob[];
  objects: PlanObjectRow[];
  citations: PlanCitation[];
  version_files: PlanVersionFile[];
  question_sets: PlanQuestionSet[];
  submissions: PlanSubmission[];
  mappings: Array<{
    kind: string;
    scope: string;
    key: string;
    content_hash: string;
    object_key: string | null;
    version_key: string | null;
    row:
      | { kind: "blob"; path: string }
      | { kind: "submission"; key: string }
      | { kind: "snapshot"; key: string }
      | null;
  }>;
  events: PlanEvent[];
  report_entries: ReportEntry[];
}

export interface PreparedImport {
  plan: ImportPlan;
  bytes: Map<string, Uint8Array>;
  owner_actor_id: string;
}

// The plan is handed from the public wrapper to the command in this process.
// The payload itself carries only the deterministic fingerprint and owner, so a
// receipt replay compares the same request hash and writes nothing.
const prepared_imports = new Map<string, PreparedImport>();

export function take_prepared_import(fingerprint: string): PreparedImport | undefined {
  return prepared_imports.get(fingerprint);
}

export function drop_prepared_import(fingerprint: string): void {
  prepared_imports.delete(fingerprint);
}

// ---------------------------------------------------------------------------
// Small helpers

function is_record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function as_record(value: unknown): Record<string, unknown> | null {
  return is_record(value) ? value : null;
}

function as_array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text_or_null(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function text_or(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function safe_text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function integer_or(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

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

function digest(value: unknown): string {
  return createHash("sha256").update(canonical_json(value), "utf8").digest("hex");
}

function hash_manifest(files: ScannedFile[]): string {
  return createHash("sha256").update(JSON.stringify(files), "utf8").digest("hex");
}

/** "YYYY-MM-DD" -> UTC midnight; null when missing or invalid. */
function parse_date_utc(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) {
    return null;
  }
  return ms;
}

/** "YYYY-MM-DD HH:MM" or "YYYYMMDD-HHMMSS" -> UTC ms; null when invalid. */
function parse_time_utc(value: unknown): number | null {
  if (typeof value !== "string") return null;
  let match = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (match !== null) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6] ?? "0");
    const ms = Date.UTC(year, month - 1, day, hour, minute, second);
    const check = new Date(ms);
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() + 1 !== month ||
      check.getUTCDate() !== day ||
      check.getUTCHours() !== hour ||
      check.getUTCMinutes() !== minute ||
      check.getUTCSeconds() !== second
    ) {
      return null;
    }
    return ms;
  }
  match = value.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (match !== null) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const ms = Date.UTC(year, month - 1, day, hour, minute, second);
    const check = new Date(ms);
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() + 1 !== month ||
      check.getUTCDate() !== day ||
      check.getUTCHours() !== hour ||
      check.getUTCMinutes() !== minute ||
      check.getUTCSeconds() !== second
    ) {
      return null;
    }
    return ms;
  }
  return null;
}

function json_text(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? "null" : text;
  } catch {
    return "null";
  }
}

function media_type_for(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".json":
      return "application/json";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    case ".md":
      return "text/markdown";
    case ".html":
    case ".htm":
      return "text/html";
    case ".txt":
      return "text/plain";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    default:
      return "application/octet-stream";
  }
}

function reference_basename(path: string): string {
  const parts = path.split(/[\\/]/);
  const last = parts[parts.length - 1] ?? "";
  return last.length > 0 ? last : "(file)";
}

function is_absolute_reference(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * A report never carries a user's absolute path or a parent-relative escape.
 * Absolute/Windows paths become "<absolute>/<basename>", parent-relative paths
 * "<parent>/<basename>" and other backslash forms "<relative>/<basename>".
 * Safe source-relative paths are kept exactly as written.
 */
function safe_reference_path(path: string): string {
  if (is_absolute_reference(path)) return `<absolute>/${reference_basename(path)}`;
  if (path.split(/[\\/]/).includes("..")) return `<parent>/${reference_basename(path)}`;
  if (path.includes("\\")) return `<relative>/${reference_basename(path)}`;
  return path;
}

// ---------------------------------------------------------------------------
// scan_project

function wasm_sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function walk_files(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      return;
    }
    names.sort();
    for (const name of names) {
      const full = join(current, name);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile()) {
        out.push(relative(dir, full).replace(/\\/g, "/"));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** Every symlink below the source, without following one. Targets never leave. */
function list_source_symlinks(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      return;
    }
    names.sort();
    for (const name of names) {
      const full = join(current, name);
      const path = prefix === "" ? name : `${prefix}/${name}`;
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        out.push(path);
      } else if (stat.isDirectory()) {
        walk(full, path);
      }
    }
  };
  walk(dir, "");
  return out;
}

export function scan_project(dir: string): LegacyScan {
  const files: ScannedFile[] = [];
  for (const path of walk_files(dir)) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(join(dir, ...path.split("/"))));
    } catch {
      continue;
    }
    files.push({ path, size: bytes.byteLength, sha256: wasm_sha256(bytes) });
  }
  let project_json_ok = false;
  try {
    const text = readFileSync(join(dir, "project.json"), "utf8");
    JSON.parse(text);
    project_json_ok = true;
  } catch {
    project_json_ok = false;
  }
  return {
    files,
    fingerprint: hash_manifest(files),
    project_json_ok,
  };
}

// ---------------------------------------------------------------------------
// File classification

type FileKind =
  | "project_json"
  | "library_json"
  | "feedback_file"
  | "feedback_log"
  | "ask_file"
  | "snapshot_file"
  | "round_file"
  | "report_file"
  | "out_file"
  | "shot_file"
  | "library_shot_file";

interface FileClass {
  kind: FileKind | null;
  unmapped: boolean;
  regenerable: boolean;
}

function classify_file(path: string): FileClass {
  if (path === "project.json") return { kind: "project_json", unmapped: false, regenerable: false };
  if (path === "library.json") return { kind: "library_json", unmapped: false, regenerable: false };
  if (path === "feedback.log") return { kind: "feedback_log", unmapped: false, regenerable: false };
  if (path.startsWith("feedback/")) {
    return { kind: "feedback_file", unmapped: false, regenerable: false };
  }
  if (path.startsWith("ask/")) return { kind: "ask_file", unmapped: false, regenerable: false };
  if (path.startsWith("snapshots/")) {
    return { kind: "snapshot_file", unmapped: false, regenerable: false };
  }
  if (path.startsWith("rounds/")) {
    if (path.endsWith("/digest.txt") || path.endsWith("/qa-brief.md")) {
      return { kind: null, unmapped: false, regenerable: true };
    }
    return { kind: "round_file", unmapped: false, regenerable: false };
  }
  if (path.startsWith("reports/")) {
    if (path.endsWith(".md") || path.endsWith(".html")) {
      return { kind: null, unmapped: false, regenerable: true };
    }
    return { kind: "report_file", unmapped: false, regenerable: false };
  }
  if (path.startsWith("out/")) {
    if (path === "out/report.html") return { kind: null, unmapped: false, regenerable: true };
    return { kind: "out_file", unmapped: false, regenerable: false };
  }
  if (path.startsWith("shots/")) return { kind: "shot_file", unmapped: false, regenerable: false };
  if (path.startsWith("library/shots/")) {
    return { kind: "library_shot_file", unmapped: false, regenerable: false };
  }
  if (path.startsWith("ask-") && path.endsWith(".html")) {
    return { kind: null, unmapped: false, regenerable: true };
  }
  if (REGENERABLE_EXACT.has(path)) {
    return { kind: null, unmapped: false, regenerable: true };
  }
  return { kind: null, unmapped: true, regenerable: false };
}

// ---------------------------------------------------------------------------
// Plan building

interface BuildContext {
  plan: ImportPlan;
  bytes: Map<string, Uint8Array>;
  parsed: Map<string, unknown>;
  entries: ReportEntry[];
  project_raw: Record<string, unknown> | null;
  items: Map<string, Map<string, { object_key: string; version_key: string }>>;
  questions: Map<string, Map<string, { object_key: string; version_key: string }>>;
  ask_sets: Map<string, string>;
}

function plan_entry_category(
  entries: ReportEntry[],
  category: ReportCategory,
  path: string,
  key?: string,
  detail?: unknown,
): void {
  const entry: ReportEntry = { category, path };
  if (key !== undefined) entry.key = key;
  if (detail !== undefined) entry.detail = detail;
  entries.push(entry);
}

function has_entry(entries: ReportEntry[], category: ReportCategory, path: string, key?: string): boolean {
  return entries.some(
    (entry) => entry.category === category && entry.path === path && (key === undefined || entry.key === key),
  );
}

function add_object(ctx: BuildContext, object: PlanObjectRow): PlanObjectRow {
  ctx.plan.objects.push(object);
  return object;
}

function version_for(key: string, created_at: number, round_key: string | null, payload: unknown): PlanVersionData {
  return {
    key: `${key}:v1`,
    version_no: 1,
    created_at,
    created_in_round_key: round_key,
    content_hash: digest(payload),
  };
}

function add_file_mapping(
  ctx: BuildContext,
  kind: string,
  scope: string,
  key: string,
  path: string,
  row: ImportPlan["mappings"][number]["row"],
): void {
  const bytes = ctx.bytes.get(path);
  if (bytes === undefined) return;
  ctx.plan.mappings.push({
    kind,
    scope,
    key,
    content_hash: wasm_sha256(bytes),
    object_key: null,
    version_key: null,
    row,
  });
}

function stage_raw(ctx: BuildContext, key: LegacyStageKey): Record<string, unknown> {
  if (ctx.project_raw === null) return {};
  const stages = as_record(ctx.project_raw.stages);
  if (stages === null) return {};
  return as_record(stages[key]) ?? {};
}

function project_stages(ctx: BuildContext): Record<string, unknown> | null {
  return ctx.project_raw === null ? null : as_record(ctx.project_raw.stages);
}

function add_top_level_extras(ctx: BuildContext): Record<string, unknown> {
  const extra: Record<string, unknown> = {
    policy_default: { allow_opencode_go: 1, reason: "legacy default" },
  };
  const raw = ctx.project_raw;
  if (raw === null) return extra;
  if ("pes" in raw) extra.pes = raw.pes;
  if ("created" in raw) extra.created_original = raw.created;
  if ("current" in raw) extra.current_original = raw.current;
  if ("complete" in raw) extra.complete_original = raw.complete;
  if ("executive_summary" in raw) extra.executive_summary_original = raw.executive_summary;
  if ("conclusion" in raw) extra.conclusion_original = raw.conclusion;
  for (const key of Object.keys(raw)) {
    if (KNOWN_TOP_LEVEL.has(key)) continue;
    extra[key] = raw[key];
    plan_entry_category(ctx.entries, "unknown_field", "project.json", `/${key}`);
  }
  const inline = as_record(raw.library);
  if (inline !== null) extra.inline_library = inline;
  return extra;
}

function stage_extras(ctx: BuildContext, stage_key: LegacyStageKey, raw: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if ("status" in raw) extra.status_original = raw.status;
  if ("round" in raw) extra.round_original = raw.round;
  if ("approved_at" in raw) extra.approved_at_original = raw.approved_at;
  if ("stale" in raw) extra.stale_original = raw.stale;
  if ("summary" in raw) extra.summary_original = raw.summary;
  for (const key of Object.keys(raw)) {
    if (KNOWN_STAGE_KEYS.has(key)) continue;
    extra[key] = raw[key];
    plan_entry_category(ctx.entries, "unknown_field", "project.json", `/stages/${stage_key}/${key}`);
  }
  return extra;
}

function stage_status(raw: Record<string, unknown>): PlanStageRow["status"] {
  const status = raw.status;
  if (status === "pending" || status === "asking" || status === "active" || status === "approved") {
    return status;
  }
  return "pending";
}

function snapshot_manifest_json(stage_key: LegacyStageKey, round_no: number): string {
  return JSON.stringify({ stage: stage_key, round: round_no, legacy_unverified: true });
}

function build_rounds(
  ctx: BuildContext,
  stage_key: LegacyStageKey,
  raw: Record<string, unknown>,
  approved: boolean,
): PlanStageRow["rounds"] {
  const round_no = integer_or(raw.round, 0);
  if (round_no < 1) return [];
  const rounds: PlanStageRow["rounds"] = [];
  for (let index = 1; index <= round_no; index += 1) {
    const sealed = approved || index < round_no;
    if (!sealed) {
      rounds.push({ round_no: index, sealed: false, snapshot_key: null });
      continue;
    }
    const snapshot_key = `snapshot:${stage_key}:${index}`;
    const source_path = `snapshots/${stage_key}-R${index}.json`;
    let source: PlanSnapshot["source"];
    const parsed = ctx.parsed.get(source_path);
    if (ctx.bytes.has(source_path) && is_record(parsed)) {
      source = { kind: "file", path: source_path };
    } else {
      source = { kind: "inline", json: snapshot_manifest_json(stage_key, index) };
    }
    ctx.plan.snapshots.push({
      key: snapshot_key,
      stage_key,
      round_key: `${stage_key}:${index}`,
      scope: "round",
      source,
    });
    rounds.push({ round_no: index, sealed: true, snapshot_key });
  }
  return rounds;
}

function build_stages(ctx: BuildContext): void {
  const stages_raw = project_stages(ctx);
  if (stages_raw === null) {
    const raw_stages = ctx.project_raw === null ? undefined : ctx.project_raw.stages;
    if (raw_stages !== undefined) {
      const edition_extra = as_record(ctx.plan.edition_settings.legacy_extra);
      if (edition_extra !== null) edition_extra.stages_original = raw_stages;
    }
  } else {
    const unknown: Record<string, unknown> = {};
    for (const key of Object.keys(stages_raw)) {
      if (STAGE_KEY_SET.has(key)) continue;
      unknown[key] = stages_raw[key];
      plan_entry_category(ctx.entries, "unknown_field", "project.json", `/stages/${key}`);
    }
    if (Object.keys(unknown).length > 0) {
      const edition_extra = as_record(ctx.plan.edition_settings.legacy_extra);
      if (edition_extra !== null) edition_extra.unknown_stages = unknown;
    }
  }

  for (const stage_key of LEGACY_STAGE_KEYS) {
    const raw_value = stages_raw === null ? undefined : stages_raw[stage_key];
    const raw = as_record(raw_value);
    const missing = raw === null;
    const stage = raw ?? {};
    const status = stage_status(stage);
    const approved = status === "approved";
    const approved_at_ms = approved ? parse_time_utc(stage.approved_at) : null;
    const rounds = build_rounds(ctx, stage_key, stage, approved);
    let approval_snapshot_key: string | null = null;
    if (approved) {
      const sealed = rounds.filter((round) => round.sealed);
      const approved_snapshot_key =
        sealed.length > 0
          ? sealed[sealed.length - 1]!.snapshot_key ?? `snapshot:${stage_key}:${sealed[sealed.length - 1]!.round_no}`
          : `snapshot:${stage_key}:stage`;
      approval_snapshot_key = approved_snapshot_key;
      if (sealed.length === 0) {
        ctx.plan.snapshots.push({
          key: approved_snapshot_key,
          stage_key,
          round_key: null,
          scope: "stage",
          source: { kind: "inline", json: JSON.stringify({ stage: stage_key, legacy_unverified: true }) },
        });
      }
      ctx.plan.approvals.push({
        stage_key,
        snapshot_key: approved_snapshot_key,
        approved_at_ms,
        note: typeof stage.approved_at === "string" ? stage.approved_at : null,
      });
    }
    const settings = as_record(stage.settings) ?? {};
    const extras = stage_extras(ctx, stage_key, stage);
    if (missing) {
      extras.stage_defaults = true;
      if (raw_value !== undefined) extras.stage_original = raw_value;
      plan_entry_category(ctx.entries, "default_filled", "project.json", `/stages/${stage_key}`);
    }
    if (approved && approved_at_ms === null) {
      extras.legacy_unverified = true;
    }
    ctx.plan.stages.push({
      key: stage_key,
      status,
      settings: { ...settings, legacy_extra: extras },
      stale: stage.stale === true,
      approved_at_ms,
      approval_snapshot_key,
      rounds,
    });
  }
}

function add_artifact(ctx: BuildContext, input: {
  key: string;
  stage_key: LegacyStageKey | null;
  edition: "edition" | null;
  artifact_kind: string;
  title: string;
  summary: string;
  body_md: string | null;
  status: string;
  confidence: string | null;
  stats: unknown[];
  conflicts: unknown[];
  verify: unknown;
  metadata: Record<string, unknown>;
  created_at: number;
  round_key: string | null;
  archived: boolean;
  question?: string | null;
}): { object_key: string; version_key: string } {
  const version = version_for(
    input.key,
    input.created_at,
    input.round_key,
    {
      artifact_kind: input.artifact_kind,
      title: input.title,
      summary: input.summary,
      body_md: input.body_md,
      status: input.status,
      confidence: input.confidence,
      metadata: input.metadata,
    },
  );
  add_object(ctx, {
    key: input.key,
    kind: "artifact",
    edition: input.edition,
    archived: input.archived,
    version,
    artifact: {
      artifact_kind: input.artifact_kind,
      stage_key: input.stage_key,
      title: input.title,
      question: input.question ?? null,
      summary: input.summary,
      body_md: input.body_md,
      status: input.status,
      confidence: input.confidence,
      stats: input.stats,
      conflicts: input.conflicts,
      verify: input.verify,
      metadata: input.metadata,
    },
  });
  return { object_key: input.key, version_key: version.key };
}

function add_source(ctx: BuildContext, input: {
  key: string;
  title: string;
  url: string | null;
  source_kind: string;
  canonical_locator: string | null;
  locator: Record<string, unknown>;
  method: string;
  created_at: number;
}): { object_key: string; version_key: string } {
  const version = version_for(input.key, input.created_at, null, {
    title: input.title,
    url: input.url,
    locator: input.locator,
    method: input.method,
  });
  add_object(ctx, {
    key: input.key,
    kind: "source",
    edition: "edition",
    archived: false,
    version,
    source: {
      source_kind: input.source_kind,
      canonical_locator: input.canonical_locator,
      title: input.title,
      url: input.url,
      locator: input.locator,
      retrieved_at: null,
      method: input.method,
      verification_state: "legacy_unknown",
    },
  });
  return { object_key: input.key, version_key: version.key };
}

function add_citation(
  ctx: BuildContext,
  artifact_version_key: string,
  source_version_key: string,
  citation_no: number,
): void {
  ctx.plan.citations.push({
    artifact_version_key,
    source_version_key,
    citation_no,
    quote: null,
    locator: {},
  });
}

function add_file(ctx: BuildContext, version_key: string, blob_path: string, role: string): void {
  ctx.plan.version_files.push({ version_key, blob_path, role });
}

function item_key(scope: string, legacy_id: string): string {
  return `item:${scope}:${legacy_id}`;
}

function add_item(
  ctx: BuildContext,
  scope: string,
  stage_key: LegacyStageKey | null,
  index: number,
  raw: Record<string, unknown>,
): { object_key: string; version_key: string } | null {
  const raw_id = raw.id;
  const legacy_id = raw_id === undefined || raw_id === null ? String(index + 1) : String(raw_id);
  const scope_map = ctx.items.get(scope) ?? new Map<string, { object_key: string; version_key: string }>();
  ctx.items.set(scope, scope_map);
  if (scope_map.has(legacy_id)) return scope_map.get(legacy_id)!;

  const key = item_key(scope, legacy_id);
  const title_raw = raw.title;
  const title = text_or(title_raw, "(제목 없음)");
  const kind_raw = raw.kind;
  const kind = typeof kind_raw === "string" && ARTIFACT_KINDS.has(kind_raw) ? kind_raw : "note";
  const status_raw = raw.status;
  const status = typeof status_raw === "string" && ARTIFACT_STATUSES.has(status_raw) ? status_raw : "new";
  const confidence_raw = raw.confidence;
  const confidence =
    typeof confidence_raw === "string" && CONFIDENCE_LEVELS.has(confidence_raw) ? confidence_raw : null;
  const summary = typeof raw.summary === "string" ? raw.summary : "";
  const body_md = typeof raw.details === "string" ? raw.details : null;
  const metadata_extra: Record<string, unknown> = {
    legacy_id: raw_id ?? index + 1,
    legacy_unverified: true,
  };
  if (typeof kind_raw === "string") metadata_extra.kind_original = kind_raw;
  if (typeof status_raw === "string") metadata_extra.status_original = status_raw;
  if ("updated_round" in raw) metadata_extra.updated_round = raw.updated_round;
  if ("depth" in raw) metadata_extra.depth = raw.depth;
  if ("order" in raw) metadata_extra.order = raw.order;
  if ("verdict" in raw) metadata_extra.verdict = raw.verdict;
  if ("model" in raw) metadata_extra.model = raw.model;
  if ("request" in raw) metadata_extra.request = raw.request;
  if ("reuse" in raw) metadata_extra.reuse_original = raw.reuse;
  if ("links" in raw) metadata_extra.links = raw.links;
  if ("confidence" in raw) metadata_extra.confidence_original = raw.confidence;
  if ("shots" in raw) metadata_extra.shots = raw.shots;
  for (const field of Object.keys(raw)) {
    if (KNOWN_ITEM_KEYS.has(field)) continue;
    metadata_extra[field] = raw[field];
    const pointer =
      scope === "library"
        ? `/items/${index}/${field}`
        : `/stages/${scope}/items/${index}/${field}`;
    plan_entry_category(ctx.entries, "unknown_field", scope === "library" ? "library.json" : "project.json", pointer);
  }
  if (kind_raw !== kind || status_raw !== status || title_raw === undefined || title_raw === "") {
    metadata_extra.legacy_unverified = true;
  }
  if (typeof confidence_raw === "string" && confidence_raw === "") {
    metadata_extra.legacy_unverified = true;
  }
  const metadata = { legacy_extra: metadata_extra };
  const artifact = add_artifact(ctx, {
    key,
    stage_key,
    edition: scope === "library" ? null : "edition",
    artifact_kind: kind,
    title,
    summary,
    body_md,
    status,
    confidence,
    stats: as_array(raw.stats),
    conflicts: as_array(raw.conflicts),
    verify: raw.verify === undefined ? null : raw.verify,
    metadata,
    created_at: 0,
    round_key: null,
    archived: status === "removed",
    question: typeof raw.question === "string" ? raw.question : null,
  });
  scope_map.set(legacy_id, artifact);
  ctx.plan.mappings.push({
    kind: "item",
    scope,
    key: legacy_id,
    content_hash: digest(raw),
    object_key: artifact.object_key,
    version_key: artifact.version_key,
    row: null,
  });

  // sources / citations
  const sources = as_array(raw.sources);
  for (const [source_index, source_value] of sources.entries()) {
    const source = as_record(source_value);
    if (source === null) continue;
    const url = text_or_null(source.url);
    const method_raw = source.method;
    const method =
      typeof method_raw === "string" && SOURCE_METHODS.has(method_raw) ? method_raw : "unknown";
    const source_kind =
      method === "kosis" ? "stat" : method === "law" ? "law" : url === null ? "file" : "web";
    const source_title = text_or(source.title, "(제목 없음)");
    const locator: Record<string, unknown> = {};
    if (source.date !== undefined) locator.date = source.date;
    if (source.note !== undefined) locator.note = source.note;
    if (source.orgId !== undefined) locator.orgId = source.orgId;
    if (source.tblId !== undefined) locator.tblId = source.tblId;
    const legacy_extra: Record<string, unknown> = { method_original: source.method ?? null };
    if (typeof method_raw === "string" && !SOURCE_METHODS.has(method_raw)) {
      legacy_extra.legacy_unverified = true;
    }
    locator.legacy_extra = legacy_extra;
    const added = add_source(ctx, {
      key: `source:${key}:${source_index}`,
      title: source_title,
      url,
      source_kind,
      canonical_locator: url ?? source_title,
      locator,
      method,
      created_at: 0,
    });
    add_citation(ctx, artifact.version_key, added.version_key, source_index + 1);
  }

  // shots
  for (const shot of as_array(raw.shots)) {
    if (typeof shot !== "string") continue;
    if (ctx.bytes.has(shot)) {
      add_file(ctx, artifact.version_key, shot, "image");
    } else {
      plan_entry_category(ctx.entries, "missing_file", safe_reference_path(shot));
    }
  }

  return artifact;
}

function add_question(
  ctx: BuildContext,
  input: {
    key: string;
    stage_key: LegacyStageKey;
    bank_key: string | null;
    origin: string;
    text: string;
    type: string;
    required: boolean;
    options: unknown[];
    default_value: unknown;
    show_if: unknown;
    help: string | null;
    state: string;
    created_at: number;
    mapping?: { scope: string; key: string; raw: unknown };
  },
): { object_key: string; version_key: string } {
  const version = version_for(input.key, input.created_at, null, {
    text: input.text,
    type: input.type,
    required: input.required,
    options: input.options,
    state: input.state,
  });
  add_object(ctx, {
    key: input.key,
    kind: "question",
    edition: "edition",
    archived: false,
    version,
    question: {
      bank_key: input.bank_key,
      origin: input.origin,
      direction: "agent_to_human",
      text: input.text,
      type: input.type,
      required: input.required,
      options: input.options,
      default_value: input.default_value,
      show_if: input.show_if,
      help: input.help,
      state: input.state,
    },
  });
  if (input.mapping !== undefined) {
    ctx.plan.mappings.push({
      kind: "question",
      scope: input.mapping.scope,
      key: input.mapping.key,
      content_hash: digest(input.mapping.raw),
      object_key: input.key,
      version_key: version.key,
      row: null,
    });
  }
  return { object_key: input.key, version_key: version.key };
}

function question_index(ctx: BuildContext, stage_key: string): Map<string, { object_key: string; version_key: string }> {
  const existing = ctx.questions.get(stage_key);
  if (existing !== undefined) return existing;
  const created = new Map<string, { object_key: string; version_key: string }>();
  ctx.questions.set(stage_key, created);
  return created;
}

function build_ask_files(ctx: BuildContext): void {
  const paths = [...ctx.bytes.keys()].filter((path) => path.startsWith("ask/") && path.endsWith(".json")).sort();
  for (const path of paths) {
    const parsed = as_record(ctx.parsed.get(path));
    if (parsed === null) continue;
    const stage_raw_value = parsed.stage;
    if (typeof stage_raw_value !== "string" || !STAGE_KEY_SET.has(stage_raw_value)) {
      plan_entry_category(ctx.entries, "unmapped_input", path);
      continue;
    }
    const stage_key = stage_raw_value as LegacyStageKey;
    const form_id = text_or(parsed.id, basename(path, ".json"));
    const form_key = `ask/${form_id}`;
    const round_no = integer_or(parsed.round, 0);
    const stage_plan = ctx.plan.stages.find((stage) => stage.key === stage_key);
    const round_key =
      round_no >= 1 && stage_plan !== undefined && stage_plan.rounds.some((round) => round.round_no === round_no)
        ? `${stage_key}:${round_no}`
        : null;
    const purpose =
      parsed.kind === "resume" ? "resume" : parsed.kind === "review" ? "review" : "stage_start";
    const set_key = `ask-set:${path}`;
    const members: PlanQuestionSet["members"] = [];
    const questions = [...as_array(parsed.questions)];
    for (const [position, question_value] of questions.entries()) {
      const question = as_record(question_value);
      if (question === null) continue;
      const question_id = text_or(question.id, `q${position + 1}`);
      const key = `question:${stage_key}:${question_id}`;
      const type_raw = question.type;
      const type = typeof type_raw === "string" && QUESTION_TYPES.has(type_raw) ? type_raw : "text";
      const text = text_or(question.label, "(질문 없음)");
      const options = as_array(question.options);
      const added = add_question(ctx, {
        key,
        stage_key,
        bank_key: typeof question.id === "string" ? question.id : null,
        origin: "bank",
        text,
        type,
        required: question.required === true,
        options,
        default_value: "default" in question ? question.default : null,
        show_if: "show_if" in question ? question.show_if : null,
        help: text_or_null(question.help),
        state: "open",
        created_at: 0,
        mapping: { scope: stage_key, key: question_id, raw: question },
      });
      question_index(ctx, stage_key).set(question_id, added);
      members.push({
        question_key: added.object_key,
        question_version_key: added.version_key,
        position: members.length,
      });
    }
    if (members.length > 0) {
      ctx.plan.question_sets.push({
        key: set_key,
        stage_key,
        round_key,
        purpose,
        form_key,
        version_no: 1,
        published_at: 0,
        members,
      });
      if (purpose === "stage_start" && !ctx.ask_sets.has(stage_key)) {
        ctx.ask_sets.set(stage_key, set_key);
      }
    }
  }
}

function ensure_import_question(
  ctx: BuildContext,
  stage_key: LegacyStageKey | null,
  question_id: string,
): { object_key: string; version_key: string } {
  const scope = stage_key ?? "unknown";
  const index = question_index(ctx, scope);
  const existing = index.get(question_id);
  if (existing !== undefined) return existing;
  const key = `import-question:${scope}:${question_id}`;
  const added = add_question(ctx, {
    key,
    stage_key: stage_key ?? "plan",
    bank_key: question_id,
    origin: "import",
    text: `(이전 답의 질문: ${question_id})`,
    type: "text",
    required: false,
    options: [],
    default_value: null,
    show_if: null,
    help: null,
    state: "open",
    created_at: 0,
  });
  index.set(question_id, added);
  return added;
}

function add_answer(
  ctx: BuildContext,
  submission_key: string,
  received_at: number,
  question: { object_key: string; version_key: string },
  question_id: string,
  value: unknown,
): void {
  const key = `answer:${submission_key}:${question_id}`;
  const version = version_for(key, received_at, null, { value, question: question.object_key });
  add_object(ctx, {
    key,
    kind: "answer",
    edition: "edition",
    archived: false,
    version,
    answer: {
      question_key: question.object_key,
      question_version_key: question.version_key,
      submission_key,
      value,
      state: "submitted",
    },
  });
}

function add_thread(
  ctx: BuildContext,
  input: {
    key: string;
    target_object_key: string;
    target_version_key: string | null;
    context_kind: string;
    created_at: number;
  },
): { object_key: string; version_key: string } {
  const version = version_for(input.key, input.created_at, null, {
    target: input.target_object_key,
    context_kind: input.context_kind,
  });
  add_object(ctx, {
    key: input.key,
    kind: "thread",
    edition: "edition",
    archived: false,
    version,
    thread: {
      target_object_key: input.target_object_key,
      target_version_key: input.target_version_key,
      context_kind: input.context_kind,
    },
  });
  return { object_key: input.key, version_key: version.key };
}

function add_message(
  ctx: BuildContext,
  input: {
    key: string;
    thread_key: string;
    submission_key: string | null;
    body_md: string;
    created_at: number;
  },
): { object_key: string; version_key: string } {
  const version = version_for(input.key, input.created_at, null, { body_md: input.body_md });
  add_object(ctx, {
    key: input.key,
    kind: "message",
    edition: "edition",
    archived: false,
    version,
    message: {
      thread_key: input.thread_key,
      submission_key: input.submission_key,
      body_md: input.body_md,
      state: "published",
    },
  });
  return { object_key: input.key, version_key: version.key };
}

function build_feedback(ctx: BuildContext): void {
  const processed = new Set<string>();
  const raw_processed = ctx.project_raw === null ? [] : as_array(ctx.project_raw.processed);
  for (const name of raw_processed) {
    if (typeof name !== "string") continue;
    processed.add(name);
    const file_path = `feedback/${name}`;
    const matched = ctx.bytes.has(file_path);
    ctx.plan.events.push({
      type: "legacy.processed",
      payload: { name, matched },
    });
    if (!matched) {
      plan_entry_category(ctx.entries, "processed_without_file", file_path);
    }
  }

  const feedback_paths = [...ctx.bytes.keys()]
    .filter((path) => path.startsWith("feedback/") && path.endsWith(".json"))
    .sort();
  for (const path of feedback_paths) {
    const name = basename(path);
    if (!processed.has(name)) {
      plan_entry_category(ctx.entries, "unprocessed_answer", path);
    }
    const submission_key = `feedback:${path}`;
    ctx.plan.submissions.push({ key: submission_key, raw_blob_path: path, received_at: 0, set_key: null });
    const parsed = as_record(ctx.parsed.get(path));
    if (parsed === null) continue;

    const stage_raw_value = parsed.stage;
    const stage_key =
      typeof stage_raw_value === "string" && STAGE_KEY_SET.has(stage_raw_value)
        ? (stage_raw_value as LegacyStageKey)
        : null;
    const kind = typeof parsed.kind === "string" ? parsed.kind : "feedback";
    const name_stamp = name.match(/^([a-z]+)-R\d+-(\d{8})-(\d{6})\.json$/i);
    const received_at =
      parse_time_utc(parsed.time) ??
      (name_stamp === null ? 0 : parse_time_utc(`${name_stamp[2]}-${name_stamp[3]}`) ?? 0);
    const submission = ctx.plan.submissions.find((entry) => entry.key === submission_key);
    if (submission !== undefined) {
      submission.received_at = received_at;
      if (kind === "stage_start" && stage_key !== null) {
        submission.set_key = ctx.ask_sets.get(stage_key) ?? null;
      }
    }
    ctx.plan.events.push({
      type: "legacy.feedback_file",
      payload: { path, kind, stage: stage_key, processed: processed.has(name) },
    });

    const answers = as_record(parsed.answers);
    if (answers !== null) {
      for (const [answer_id, value] of Object.entries(answers)) {
        if (answer_id.endsWith("__other")) {
          const question_id = answer_id.slice(0, -"__other".length);
          if (question_id.length === 0) continue;
          const question = ensure_import_question(ctx, stage_key, question_id);
          const text = safe_text(value);
          if (text.trim().length === 0) continue;
          const thread = add_thread(ctx, {
            key: `thread:${submission_key}:${question_id}:other`,
            target_object_key: question.object_key,
            target_version_key: question.version_key,
            context_kind: "question_comment",
            created_at: received_at,
          });
          add_message(ctx, {
            key: `message:${submission_key}:${question_id}:other`,
            thread_key: thread.object_key,
            submission_key,
            body_md: text,
            created_at: received_at,
          });
          continue;
        }
        const question = ensure_import_question(ctx, stage_key, answer_id);
        add_answer(ctx, submission_key, received_at, question, answer_id, value);
      }
    }

    const text = typeof parsed.text === "string" ? parsed.text : "";
    if (kind === "approve" || kind === "reopen") {
      ctx.plan.events.push({
        type: kind === "approve" ? "legacy.approve_request" : "legacy.reopen_request",
        payload: { path, text, stage: stage_key, raw: parsed },
      });
    } else if (text.trim().length > 0) {
      const note_key = `feedback-note:${submission_key}`;
      const note = add_artifact(ctx, {
        key: note_key,
        stage_key,
        edition: "edition",
        artifact_kind: "note",
        title: "(이전 의견)",
        summary: "",
        body_md: text,
        status: "new",
        confidence: null,
        stats: [],
        conflicts: [],
        verify: null,
        metadata: { legacy_extra: { feedback: parsed, legacy_unverified: true } },
        created_at: received_at,
        round_key: null,
        archived: false,
      });
      const thread = add_thread(ctx, {
        key: `thread:${submission_key}:general`,
        target_object_key: note.object_key,
        target_version_key: note.version_key,
        context_kind: "general",
        created_at: received_at,
      });
      add_message(ctx, {
        key: `message:${submission_key}:general`,
        thread_key: thread.object_key,
        submission_key,
        body_md: text,
        created_at: received_at,
      });
    }
  }
}

function build_library(ctx: BuildContext): void {
  const inline = ctx.project_raw === null ? undefined : ctx.project_raw.library;
  const library = as_record(ctx.parsed.get("library.json")) ?? as_record(inline);
  if (library === null) return;
  const extra: Record<string, unknown> = {
    source: library.source ?? null,
    imported: library.imported ?? null,
    round: library.round ?? null,
    topic: library.topic ?? null,
    settings: library.settings ?? null,
    warnings: library.warnings ?? null,
  };
  for (const key of Object.keys(library)) {
    if (KNOWN_LIBRARY_KEYS.has(key)) continue;
    extra[key] = library[key];
    plan_entry_category(ctx.entries, "unknown_field", "library.json", `/${key}`);
  }
  const edition_extra = as_record(ctx.plan.edition_settings.legacy_extra);
  if (edition_extra !== null) edition_extra.library = extra;
  for (const warning of as_array(library.warnings)) {
    ctx.plan.events.push({ type: "legacy.warning", payload: { source: "library", warning } });
  }
  const items = as_array(library.items);
  for (const [index, value] of items.entries()) {
    const item = as_record(value);
    if (item === null) continue;
    add_item(ctx, "library", null, index, item);
  }
}

function build_notes(ctx: BuildContext): void {
  if (ctx.project_raw === null) return;
  const notes = as_array(ctx.project_raw.notes);
  for (const [index, value] of notes.entries()) {
    const note = as_record(value);
    if (note === null) continue;
    const stage_raw_value = note.stage;
    const stage_key =
      typeof stage_raw_value === "string" && STAGE_KEY_SET.has(stage_raw_value)
        ? (stage_raw_value as LegacyStageKey)
        : null;
    const created_at = parse_time_utc(note.time) ?? 0;
    add_artifact(ctx, {
      key: `note:${index}`,
      stage_key,
      edition: "edition",
      artifact_kind: "note",
      title: "(메모)",
      summary: "",
      body_md: typeof note.text === "string" ? note.text : "",
      status: "new",
      confidence: null,
      stats: [],
      conflicts: [],
      verify: null,
      metadata: { legacy_extra: { note, legacy_unverified: true } },
      created_at,
      round_key: null,
      archived: false,
    });
  }
}

function build_stage_content(ctx: BuildContext): void {
  for (const stage_key of LEGACY_STAGE_KEYS) {
    const raw = stage_raw(ctx, stage_key);

    for (const warning of as_array(raw.warnings)) {
      ctx.plan.events.push({ type: "legacy.warning", payload: { stage: stage_key, warning } });
    }
    for (const change of as_array(raw.changes)) {
      ctx.plan.events.push({ type: "legacy.change", payload: { stage: stage_key, change } });
    }
    for (const history of as_array(raw.history)) {
      ctx.plan.events.push({ type: "legacy.history", payload: { stage: stage_key, line: history } });
    }

    const summary = typeof raw.summary === "string" ? raw.summary : "";
    if (summary.trim().length > 0) {
      add_artifact(ctx, {
        key: `stage-summary:${stage_key}`,
        stage_key,
        edition: "edition",
        artifact_kind: "report",
        title: "(단계 요약)",
        summary,
        body_md: null,
        status: "draft",
        confidence: null,
        stats: [],
        conflicts: [],
        verify: null,
        metadata: { legacy_extra: { stage_summary: summary, legacy_unverified: true } },
        created_at: 0,
        round_key: null,
        archived: false,
      });
    }

    const reports = as_array(raw.reports);
    for (const [index, value] of reports.entries()) {
      const report = as_record(value);
      if (report === null) continue;
      const path = typeof report.path === "string" ? report.path : null;
      const round_no = integer_or(report.round, 0);
      const round_key = round_no >= 1 ? `${stage_key}:${round_no}` : null;
      const label = typeof report.label === "string" ? report.label : null;
      const format = typeof report.format === "string" ? report.format : null;
      const title = label ?? format ?? "(보고서)";
      const key = `stage-report:${stage_key}:${index}`;
      const added = add_artifact(ctx, {
        key,
        stage_key,
        edition: "edition",
        artifact_kind: "report",
        title,
        summary: "",
        body_md: null,
        status: "draft",
        confidence: null,
        stats: [],
        conflicts: [],
        verify: null,
        metadata: {
          format,
          label,
          legacy_extra: { report, legacy_unverified: true },
        },
        created_at: 0,
        round_key,
        archived: false,
      });
      if (path === null) continue;
      if (ctx.bytes.has(path)) {
        add_file(ctx, added.version_key, path, "rendered");
      } else {
        plan_entry_category(ctx.entries, "missing_file", safe_reference_path(path));
      }
    }

    for (const [index, value] of as_array(raw.qa).entries()) {
      const qa = as_record(value);
      if (qa === null) continue;
      const round_no = integer_or(qa.round, 0);
      add_artifact(ctx, {
        key: `stage-qa:${stage_key}:${index}`,
        stage_key,
        edition: "edition",
        artifact_kind: "review",
        title: "(QA)",
        summary: "",
        body_md: null,
        status: "draft",
        confidence: null,
        stats: [],
        conflicts: [],
        verify: null,
        metadata: { qa, legacy_extra: { qa, legacy_unverified: true } },
        created_at: 0,
        round_key: round_no >= 1 ? `${stage_key}:${round_no}` : null,
        archived: false,
      });
    }
    for (const [index, value] of as_array(raw.review_log).entries()) {
      const review = as_record(value);
      if (review === null) continue;
      add_artifact(ctx, {
        key: `stage-review:${stage_key}:${index}`,
        stage_key,
        edition: "edition",
        artifact_kind: "review",
        title: "(검토)",
        summary: "",
        body_md: null,
        status: "draft",
        confidence: null,
        stats: [],
        conflicts: [],
        verify: null,
        metadata: { review_log: review, legacy_extra: { legacy_unverified: true } },
        created_at: 0,
        round_key: null,
        archived: false,
      });
    }

    const items = as_array(raw.items);
    for (const [index, value] of items.entries()) {
      const item = as_record(value);
      if (item === null) continue;
      add_item(ctx, stage_key, stage_key, index, item);
    }

    const carry_over = as_array(raw.carry_over);
    for (const [index, value] of carry_over.entries()) {
      const entry = as_record(value);
      if (entry === null) continue;
      const request = safe_text(entry.request);
      const from = typeof entry.from === "string" && STAGE_KEY_SET.has(entry.from)
        ? (entry.from as LegacyStageKey)
        : null;
      if (from === null) {
        plan_entry_category(
          ctx.entries,
          "unknown_field",
          "project.json",
          `/stages/${stage_key}/carry_over/${index}`,
          { request },
        );
        continue;
      }
      const legacy_item = entry.item === undefined ? null : String(entry.item);
      const base =
        legacy_item === null ? undefined : ctx.items.get(stage_key)?.get(legacy_item);
      const key = `followup:${stage_key}:${index}`;
      const version = version_for(key, 0, null, {
        kind: "next_round_task",
        description: request,
        target_stage: from,
      });
      add_object(ctx, {
        key,
        kind: "followup",
        edition: "edition",
        archived: false,
        version,
        followup: {
          kind: "next_round_task",
          state: "proposed",
          description: request.length > 0 ? request : "(요청 없음)",
          target_stage_key: from,
          base_version_key: base?.version_key ?? null,
        },
      });
    }
  }
}

function build_project(ctx: BuildContext): void {
  const raw = ctx.project_raw;
  if (raw === null) return;
  const pes = raw.pes;
  ctx.plan.source_schema =
    typeof pes === "number" ? `pes-project-json/${pes}` : "pes-project-json/unknown";

  const slug = text_or_null(raw.slug);
  const topic = text_or(raw.topic, "(주제 없음)");
  const created_at = parse_date_utc(raw.created) ?? 0;
  const current_raw = raw.current;
  const current_stage_key =
    typeof current_raw === "string" && STAGE_KEY_SET.has(current_raw)
      ? (current_raw as LegacyStageKey)
      : null;
  if (current_raw !== undefined && current_stage_key === null) {
    plan_entry_category(ctx.entries, "unknown_field", "project.json", "/current");
  }
  if (slug === null || slug.trim().length === 0) {
    ctx.plan.failed = true;
    plan_entry_category(ctx.entries, "unknown_field", "project.json", "/slug");
  }
  ctx.plan.project = {
    slug,
    topic,
    created_at,
    complete: raw.complete === true,
    current_stage_key,
  };
  const settings = as_record(raw.settings) ?? {};
  const legacy_extra = add_top_level_extras(ctx);
  const created_valid = raw.created !== undefined && parse_date_utc(raw.created) !== null;
  if (!created_valid) {
    legacy_extra.legacy_unverified = true;
  }
  ctx.plan.edition_settings = { ...settings, legacy_extra };
  ctx.plan.edition_status = ctx.plan.failed
    ? "draft"
    : raw.complete === true
      ? "completed"
      : "active";

  build_stages(ctx);
  if (raw.complete === true && ctx.plan.approvals.length === 0) {
    legacy_extra.legacy_unverified = true;
  }

  // File mappings for recognised inputs (the source manifest always lists all files).
  for (const file of ctx.plan.manifest_files) {
    if (file.path === "project.json.tmp") continue;
    const classification = classify_file(file.path);
    if (classification.unmapped) {
      plan_entry_category(ctx.entries, "unmapped_input", file.path);
      continue;
    }
    if (classification.kind === null) continue;
    const key = file.path;
    const row =
      classification.kind === "feedback_file"
        ? ({ kind: "submission", key: `feedback:${file.path}` } as const)
        : ({ kind: "blob", path: file.path } as const);
    add_file_mapping(ctx, classification.kind, "", key, file.path, row);
  }

  const feedback_log = ctx.bytes.get("feedback.log");
  if (feedback_log !== undefined) {
    const text = new TextDecoder().decode(feedback_log);
    for (const line of text.split(/\r?\n/)) {
      if (line.length === 0) continue;
      ctx.plan.events.push({ type: "legacy.feedback_log", payload: { line } });
    }
  }

  build_notes(ctx);
  build_stage_content(ctx);
  build_library(ctx);
  build_ask_files(ctx);
  build_feedback(ctx);

  // Executive summary and conclusion live on one edition-scoped report version.
  const summary = typeof raw.executive_summary === "string" ? raw.executive_summary : "";
  const conclusion = typeof raw.conclusion === "string" ? raw.conclusion : "";
  if (summary.trim().length > 0 || conclusion.trim().length > 0) {
    add_artifact(ctx, {
      key: "final-report",
      stage_key: null,
      edition: "edition",
      artifact_kind: "report",
      title: "(최종 보고서)",
      summary,
      body_md: null,
      status: "draft",
      confidence: null,
      stats: [],
      conflicts: [],
      verify: null,
      metadata: {
        conclusion,
        legacy_extra: {
          executive_summary: summary,
          conclusion,
          legacy_unverified: true,
        },
      },
      created_at: 0,
      round_key: null,
      archived: false,
    });
  }
}

function build_failed_project(ctx: BuildContext): void {
  ctx.plan.failed = true;
  ctx.plan.source_schema = "pes-project-json/invalid";
  ctx.plan.project = {
    slug: null,
    topic: "(주제 없음)",
    created_at: 0,
    complete: false,
    current_stage_key: null,
  };
  const legacy_extra = add_top_level_extras(ctx);
  legacy_extra.failed = true;
  ctx.plan.edition_settings = { legacy_extra };
  ctx.plan.edition_status = "draft";
  if (!has_entry(ctx.entries, "parse_error", "project.json")) {
    plan_entry_category(ctx.entries, "parse_error", "project.json");
  }
  // Six pending stages keep the project shape consistent even when the batch fails.
  for (const stage_key of LEGACY_STAGE_KEYS) {
    ctx.plan.stages.push({
      key: stage_key,
      status: "pending",
      settings: { legacy_extra: { stage_defaults: true } },
      stale: false,
      approved_at_ms: null,
      approval_snapshot_key: null,
      rounds: [],
    });
  }
}

function add_blobs(ctx: BuildContext): void {
  const project_json_bytes = ctx.bytes.get("project.json");
  for (const file of ctx.plan.manifest_files) {
    const bytes = ctx.bytes.get(file.path);
    if (bytes === undefined) continue;
    if (file.path === "project.json.tmp") {
      const same =
        project_json_bytes !== undefined &&
        project_json_bytes.byteLength === bytes.byteLength &&
        project_json_bytes.every((value, index) => value === bytes[index]);
      ctx.plan.blobs.push({
        path: file.path,
        sha256: file.sha256,
        size: file.size,
        media_type: media_type_for(file.path),
        state: same ? "ready" : "quarantined",
      });
      if (!same) {
        plan_entry_category(ctx.entries, "quarantined", file.path);
      }
      continue;
    }
    ctx.plan.blobs.push({
      path: file.path,
      sha256: file.sha256,
      size: file.size,
      media_type: media_type_for(file.path),
      state: "ready",
    });
  }
}

function build_plan(dir: string): PreparedImport {
  const scan = scan_project(dir);
  const bytes = new Map<string, Uint8Array>();
  for (const file of scan.files) {
    try {
      bytes.set(file.path, new Uint8Array(readFileSync(join(dir, ...file.path.split("/")))));
    } catch {
      // A file that vanished between the scan and the read is only in the manifest.
    }
  }
  const entries: ReportEntry[] = [];
  for (const path of list_source_symlinks(dir)) {
    plan_entry_category(entries, "unmapped_input", path);
  }
  const parsed = new Map<string, unknown>();
  for (const [path, content] of bytes) {
    if (!path.endsWith(".json")) continue;
    try {
      parsed.set(path, JSON.parse(new TextDecoder().decode(content)));
    } catch {
      plan_entry_category(entries, "parse_error", path);
    }
  }
  const project_raw = as_record(parsed.get("project.json")) ?? null;
  const plan: ImportPlan = {
    fingerprint: scan.fingerprint,
    project_json_ok: scan.project_json_ok,
    failed: !scan.project_json_ok || project_raw === null,
    source_schema: "pes-project-json/unknown",
    importer_version: IMPORTER_VERSION,
    manifest_files: scan.files,
    project: {
      slug: null,
      topic: "(주제 없음)",
      created_at: 0,
      complete: false,
      current_stage_key: null,
    },
    edition_settings: {},
    edition_status: "draft",
    stages: [],
    snapshots: [],
    approvals: [],
    blobs: [],
    objects: [],
    citations: [],
    version_files: [],
    question_sets: [],
    submissions: [],
    mappings: [],
    events: [],
    report_entries: entries,
  };
  const ctx: BuildContext = {
    plan,
    bytes,
    parsed,
    entries,
    project_raw,
    items: new Map(),
    questions: new Map(),
    ask_sets: new Map(),
  };
  add_blobs(ctx);
  if (project_raw === null) {
    build_failed_project(ctx);
  } else {
    build_project(ctx);
  }
  return { plan, bytes, owner_actor_id: "" };
}

/**
 * Read the source folder and build the write plan. The plan is held in this
 * process until the command consumes it; the payload carries only the
 * deterministic fingerprint and owner so a receipt replay writes nothing.
 */
export function prepare_import_plan(dir: string, owner_actor_id: string): PreparedImport {
  const prepared = build_plan(dir);
  prepared.owner_actor_id = owner_actor_id;
  prepared_imports.set(prepared.plan.fingerprint, prepared);
  return prepared;
}

// ---------------------------------------------------------------------------
// Public import wrapper

export async function import_project(
  service: CommandService,
  dir: string,
  opts: ImportOptions,
): Promise<ImportResult> {
  if (opts === null || typeof opts !== "object" || typeof opts.owner_actor_id !== "string") {
    throw new ApiError("invalid_payload", "owner_actor_id is required");
  }
  const owner_actor_id = opts.owner_actor_id;
  if (owner_actor_id.length === 0) {
    throw new ApiError("invalid_payload", "owner_actor_id is required");
  }
  const prepared = prepare_import_plan(dir, owner_actor_id);
  const fingerprint = prepared.plan.fingerprint;
  try {
    const outcome = await service.execute(
      {
        project_id: null,
        actor_id: owner_actor_id,
        via: "import",
        client_request_id: `legacy-import:${fingerprint}`,
      },
      "legacy.import_project",
      { source_fingerprint: fingerprint },
    );
    const result = outcome.result as ImportResult;
    return {
      ...result,
      replayed: outcome.replayed || result.replayed === true,
    };
  } finally {
    drop_prepared_import(fingerprint);
  }
}

// ---------------------------------------------------------------------------
// Read-only views

export function map_legacy(db: Db, batch_id: string): MappingRow[] {
  return db
    .all<MappingRow>(
      `SELECT project_id, import_batch_id, legacy_kind, legacy_scope, legacy_key,
              content_hash, new_object_id, new_version_id, new_row_id
         FROM legacy_mappings
        WHERE import_batch_id = ?
        ORDER BY legacy_kind, legacy_scope, legacy_key, content_hash`,
      batch_id,
    )
    .map((row) => ({ ...row }));
}

export function report_unknown(db: Db, batch_id: string): UnknownReport {
  const batch = db.get<{ project_id: string; report_blob_id: string | null }>(
    "SELECT project_id, report_blob_id FROM import_batches WHERE id = ?",
    batch_id,
  );
  if (batch === undefined || batch.report_blob_id === null) {
    throw new ApiError("not_found", "the import batch has no report");
  }
  const blob = db.get<{ storage_key: string; sha256: string; size: bigint }>(
    "SELECT storage_key, sha256, size FROM blobs WHERE project_id = ? AND id = ?",
    batch.project_id,
    batch.report_blob_id,
  );
  if (blob === undefined) {
    throw new ApiError("not_found", "the import report blob is missing");
  }
  const objects_dir = canonical_object_store_dir(db);
  if (objects_dir === null) {
    throw new ApiError("conflict", "no canonical object store is configured");
  }
  const bytes = read_storage_bytes(objects_dir, batch.project_id, blob.storage_key);
  if (bytes.byteLength !== Number(blob.size) || sha256_hex(bytes) !== blob.sha256) {
    throw new ApiError("conflict", "the import report bytes do not match the blob");
  }
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as UnknownReport;
  return { batch_id, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
}

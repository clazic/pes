// Closed command registry and the single write path for stage 2 (PR4).
//
// Every business write goes through the CommandService core. execute() is an
// async wrapper; execute_sync() is the synchronous core used by
// bootstrap_project. Both share one transaction that enforces this order:
//
//   registry -> project/actor -> current policy -> receipt replay
//   -> rev -> change -> events + receipt
//
// A rejection leaves no business row, event, or receipt behind. Receipts and
// events are append-only: nothing here updates or deletes them after commit.
// There is no table CRUD and no arbitrary SQL command in the registry.

import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import type { Clock } from "./clock.ts";
import { resolve_run_config, type RunConfig } from "./config.ts";
import { tx, type Db } from "./db.ts";
import { ApiError } from "./errors.ts";
import { new_id } from "./ids.ts";
import { read_credential_actor } from "./actors.ts";
import { ACTOR_COMMAND_ENTRIES } from "./commands/actors.ts";
import { CONTENT_COMMAND_ENTRIES, RESULT_COMMAND_ENTRIES } from "./commands/content.ts";
import { EDITION_COMMAND_ENTRIES } from "./commands/editions.ts";
import { FILE_COMMAND_ENTRIES } from "./commands/files.ts";
import { LEGACY_COMMAND_ENTRIES } from "./commands/legacy.ts";
import { MIGRATION_COMMAND_ENTRIES } from "./commands/migration.ts";
import { POLICY_COMMAND_ENTRIES } from "./commands/policy.ts";
import { make_register_command, type BuildHooks, type Created } from "./commands/projects.ts";
import { QUESTION_COMMAND_ENTRIES } from "./commands/questions.ts";
import { RECORD_COMMAND_ENTRIES } from "./commands/records.ts";
import { RUN_COMMAND_ENTRIES } from "./commands/runs.ts";
import {
  insert_receipt,
  is_record,
  register_object_store,
  with_readonly_db,
  type ReadonlyDbHandle,
  require_non_empty_string,
  require_record,
  require_well_formed,
  write_events,
  type CommandDefinition,
  type CommandResult,
  type CommandRuntime,
  type EventDraft,
  type MutationContext,
  type ProjectRow,
} from "./commands/shared.ts";

export type {
  CommandDefinition,
  CommandResult,
  CommandRuntime,
  CommandVia,
  EventDraft,
  MutationContext,
  ProjectRow,
} from "./commands/shared.ts";

/** Stage keys in ordinal order; bootstrap creates exactly these six. */
export const STAGE_KEYS = [
  "plan",
  "research",
  "analyze",
  "write",
  "verify",
  "publish",
] as const;

export type StageKey = (typeof STAGE_KEYS)[number];

/** Object kinds that receive a display number, matching objects.kind in DDL 001. */
export const OBJECT_KINDS = [
  "artifact",
  "source",
  "question",
  "answer",
  "assumption",
  "decision",
  "thread",
  "message",
  "followup",
] as const;

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * The policy seam. The command service calls check() inside the command
 * transaction, before receipt replay, and hands over a read-only database
 * handle (get / all only) from that same transaction so a real checker can
 * read the current project policy without racing another connection.
 * A denial surfaces as ApiError code "policy_denied".
 */
export interface PolicyChecker {
  check(
    ctx: MutationContext,
    command: string,
    payload: unknown,
    db: Pick<Db, "get" | "all">,
  ): PolicyDecision;
}

export interface CommandServiceOptions {
  clock: Clock;
  policy: PolicyChecker;
  /** Test seam; defaults to the shared server identifier generator. */
  new_id?: () => string;
  /** Run/lease timing; omitted -> resolve_run_config() defaults (no env read here). */
  run_config?: RunConfig;
  /**
   * Absolute objects folder for commands that read stored bytes (PR9). A
   * service without one still runs every other command; file.complete_upload
   * fails closed instead of trusting caller-supplied hashes.
   */
  objects_dir?: string;
}

export interface CommandOutcome {
  result: unknown;
  replayed: boolean;
}

interface ResolvedScope {
  project: ProjectRow;
  actor_id: string;
}

const VIAS = new Set<string>(["web", "cli", "http", "mcp", "webmcp", "import"]);


function validate_context(ctx: MutationContext): void {
  if (typeof ctx.client_request_id !== "string" || ctx.client_request_id.length === 0) {
    throw new ApiError("invalid_payload", "client_request_id must be a non-empty string");
  }
  require_well_formed(ctx.client_request_id, "client_request_id");
  if (!VIAS.has(ctx.via)) {
    throw new ApiError("invalid_payload", `via is not a known transport: ${String(ctx.via)}`);
  }
  if (ctx.project_id !== null) {
    if (typeof ctx.project_id !== "string") {
      throw new ApiError("invalid_payload", "project_id must be a string or null");
    }
    require_well_formed(ctx.project_id, "project_id");
  }
  if (ctx.actor_id !== null) {
    if (typeof ctx.actor_id !== "string") {
      throw new ApiError("invalid_payload", "actor_id must be a string or null");
    }
    require_well_formed(ctx.actor_id, "actor_id");
  }
  if (
    ctx.base_control_rev !== undefined &&
    typeof ctx.base_control_rev !== "number" &&
    typeof ctx.base_control_rev !== "string"
  ) {
    throw new ApiError("invalid_payload", "base_control_rev must be a decimal string or safe integer");
  }
}

/** Read each context field exactly once so getters cannot disagree later. */
function snapshot_context(ctx: MutationContext): MutationContext {
  return {
    project_id: ctx.project_id,
    actor_id: ctx.actor_id,
    via: ctx.via,
    client_request_id: ctx.client_request_id,
    ...(ctx.base_control_rev === undefined ? {} : { base_control_rev: ctx.base_control_rev }),
  };
}

/**
 * One JSON round trip at the entry point. JSON.stringify applies toJSON and
 * reads getters once; JSON.parse produces ordinary JSON data (including
 * "__proto__" as an own key). Every later step uses only this snapshot.
 */
function snapshot_payload(payload: unknown): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(payload);
  } catch {
    throw new ApiError("invalid_payload", "payload must be JSON-serializable");
  }
  // JSON.stringify returns undefined for undefined/function/symbol payloads.
  // They are not JSON data; normalize to null so the snapshot is always JSON
  // (validation rejects non-object payloads afterwards).
  if (text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("invalid_payload", "payload must be JSON-serializable");
  }
}

/** A second parse of the snapshot for the policy: own keys, no shared objects. */
function copy_snapshot(snapshot: unknown): unknown {
  return JSON.parse(JSON.stringify(snapshot));
}

/** Contexts are flat, but the policy still gets its own copy. */
function clone_context(ctx: MutationContext): MutationContext {
  return { ...ctx };
}

/** Only an explicit boolean true opens the gate; truthy look-alikes fail closed. */
function policy_allows(decision: unknown): boolean {
  try {
    return (
      decision !== null &&
      typeof decision === "object" &&
      (decision as { allowed?: unknown }).allowed === true
    );
  } catch {
    return false;
  }
}

function policy_denial_reason(decision: unknown): string {
  try {
    if (decision !== null && typeof decision === "object") {
      const reason = (decision as { reason?: unknown }).reason;
      if (typeof reason === "string" && reason.length > 0) return reason;
    }
  } catch {
    // fall through to the default message
  }
  return "policy denied";
}

/**
 * Deterministic JSON used only for request hashing. The input is always the
 * JSON snapshot (never a live caller object), so toJSON and undefined handling
 * are not needed here. Key order is UTF-16 code unit order, matching
 * Array.prototype.sort; see docs/plan/stage-2-db-guarantees.md 8절.
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

/**
 * The receipt hash covers the command and its payload. base_control_rev is
 * deliberately excluded: a retry with a stale base still matches its receipt,
 * and replay happens before the rev check.
 */
function request_hash(command: string, payload: unknown): string {
  let encoded: string;
  try {
    encoded = canonical_json(payload);
  } catch {
    throw new ApiError("invalid_payload", "payload must be JSON-serializable");
  }
  return createHash("sha256").update(`${command}\n${encoded}`).digest("hex");
}

function checked_now_ms(clock: Clock): number {
  const value = clock.now_ms();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("clock.now_ms() must return a non-negative safe integer");
  }
  return value;
}

/** An injected objects folder must already be an absolute path; it is resolved once. */
function checked_objects_dir(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
    throw new TypeError("the object store path must be absolute");
  }
  return resolve(value);
}

function result_project_id(result: unknown): string {
  if (is_record(result) && typeof result.project_id === "string") {
    return result.project_id;
  }
  throw new Error("the command result must include project_id");
}

function build_project(runtime: CommandRuntime, hooks: BuildHooks): CommandResult {
  const payload = require_record(runtime.payload);
  const slug = require_non_empty_string(payload, "slug");
  const topic = require_non_empty_string(payload, "topic");
  const owner_display_name = require_non_empty_string(payload, "owner_display_name");

  const project_id = runtime.new_id();
  const owner_user_id = runtime.new_id();
  const owner_actor_id = runtime.new_id();
  const policy_id = runtime.new_id();
  const edition_id = runtime.new_id();

  runtime.db.run(
    "INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)",
    owner_user_id,
    owner_display_name,
    runtime.now_ms,
  );
  runtime.db.run(
    "INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, 'human', ?, ?)",
    owner_actor_id,
    owner_user_id,
    owner_display_name,
  );
  runtime.db.run(
    `INSERT INTO projects (id, slug, topic, owner_user_id, status, created_at)
     VALUES (?, ?, ?, ?, 'staging', ?)`,
    project_id,
    slug,
    topic,
    owner_user_id,
    runtime.now_ms,
  );
  runtime.db.run(
    "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')",
    project_id,
    owner_user_id,
  );
  runtime.db.run(
    "INSERT INTO editions (id, project_id, edition_no, status) VALUES (?, ?, 1, 'active')",
    edition_id,
    project_id,
  );

  const stage_ids = {} as Record<StageKey, string>;
  for (const [index, key] of STAGE_KEYS.entries()) {
    const stage_id = runtime.new_id();
    stage_ids[key] = stage_id;
    runtime.db.run(
      "INSERT INTO stages (id, project_id, edition_id, key, ordinal) VALUES (?, ?, ?, ?, ?)",
      stage_id,
      project_id,
      edition_id,
      key,
      index + 1,
    );
  }

  for (const namespace of OBJECT_KINDS) {
    runtime.db.run(
      "INSERT INTO counters (project_id, namespace, next_no) VALUES (?, ?, 1)",
      project_id,
      namespace,
    );
  }

  // The receipt id is the transaction id; project_policy_versions references it
  // by FK, so it must exist before the policy row is inserted.
  const result = {
    project_id,
    owner_user_id,
    owner_actor_id,
    edition_id,
    policy_id,
    tx_id: runtime.tx_id,
    stage_ids,
    counter_namespaces: [...OBJECT_KINDS],
    ...hooks.stored_extra,
  };
  insert_receipt(runtime, {
    project_id,
    actor_id: owner_actor_id,
    action: hooks.action,
    base_control_rev: null,
    result,
  });

  runtime.db.run(
    `INSERT INTO project_policy_versions
       (id, project_id, policy_rev, allow_opencode_go, changed_by, changed_by_user_id,
        changed_by_kind, reason, tx_id, created_at)
     VALUES (?, ?, 1, 1, ?, ?, 'human', '초기 정책: OpenCode Go 전송 허용 기본 켜짐', ?, ?)`,
    policy_id,
    project_id,
    owner_actor_id,
    owner_user_id,
    runtime.tx_id,
    runtime.now_ms,
  );

  const edition_pointer = runtime.db.run(
    "UPDATE editions SET current_stage_id = ? WHERE project_id = ? AND id = ?",
    stage_ids.plan,
    project_id,
    edition_id,
  );
  if (edition_pointer.changes !== 1n) {
    throw new Error("bootstrap failed to set the edition current_stage_id pointer");
  }

  const project_pointer = runtime.db.run(
    `UPDATE projects
     SET active_edition_id = ?, current_policy_id = ?, status = 'active'
     WHERE id = ?`,
    edition_id,
    policy_id,
    project_id,
  );
  if (project_pointer.changes !== 1n) {
    throw new Error("bootstrap failed to activate the project");
  }

  hooks.after({ project_id, owner_user_id, owner_actor_id, edition_id, policy_id });

  return {
    result,
    events: [
      {
        type: hooks.event_type,
        payload: {
          slug,
          topic,
          owner_user_id,
          owner_actor_id,
          edition_id,
          policy_id,
          ...hooks.event_extra,
        },
      },
    ],
  };
}


function run_bootstrap(runtime: CommandRuntime): CommandResult {
  return build_project(runtime, {
    action: "project.created",
    event_type: "project.created",
    stored_extra: {},
    event_extra: {},
    after: () => undefined,
  });
}

function run_set_topic(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  const topic = require_non_empty_string(payload, "topic");
  const project = runtime.project;
  const actor_id = runtime.actor_id;
  const base_control_rev = runtime.ctx.base_control_rev;
  if (project === null || actor_id === null || base_control_rev === undefined) {
    throw new ApiError("invalid_payload", "project.set_topic needs a project, actor, and base_control_rev");
  }
  if (typeof base_control_rev !== "number") {
    throw new ApiError("invalid_payload", "project.set_topic needs a numeric base_control_rev");
  }

  const changed = runtime.db.run(
    "UPDATE projects SET topic = ?, control_rev = control_rev + 1 WHERE id = ? AND control_rev = ?",
    topic,
    project.id,
    base_control_rev,
  );
  if (changed.changes !== 1n) {
    throw new ApiError("rev_conflict", "base_control_rev is stale", {
      expected: base_control_rev,
    });
  }

  const control_rev = base_control_rev + 1;
  const result = { project_id: project.id, topic, control_rev };
  insert_receipt(runtime, {
    project_id: project.id,
    actor_id,
    action: "project.topic_set",
    base_control_rev,
    result,
  });

  return {
    result,
    events: [
      {
        type: "project.topic_set",
        before_rev: base_control_rev,
        after_rev: control_rev,
        payload: { topic, control_rev },
      },
    ],
  };
}

const BOOTSTRAP_COMMAND: CommandDefinition = Object.freeze({
  action: "project.created",
  scope: "bootstrap",
  rev_bearing: false,
  run: run_bootstrap,
});

const SET_TOPIC_COMMAND: CommandDefinition = Object.freeze({
  action: "project.topic_set",
  scope: "project",
  rev_bearing: true,
  run: run_set_topic,
});

const REGISTER_COMMAND: CommandDefinition = make_register_command(build_project);

/**
 * The service reads commands from this private table. It is not exported, so
 * changing the exported view (or bypassing it) cannot affect execution.
 */
const COMMAND_TABLE: ReadonlyMap<string, CommandDefinition> = new Map<string, CommandDefinition>([
  ["project.bootstrap", BOOTSTRAP_COMMAND],
  ["project.set_topic", SET_TOPIC_COMMAND],
  ["project.register", REGISTER_COMMAND],
  ...RUN_COMMAND_ENTRIES,
  ...CONTENT_COMMAND_ENTRIES,
  ...RESULT_COMMAND_ENTRIES,
  ...EDITION_COMMAND_ENTRIES,
  ...FILE_COMMAND_ENTRIES,
  ...LEGACY_COMMAND_ENTRIES,
  ...MIGRATION_COMMAND_ENTRIES,
  ...ACTOR_COMMAND_ENTRIES,
  ...POLICY_COMMAND_ENTRIES,
  ...QUESTION_COMMAND_ENTRIES,
  ...RECORD_COMMAND_ENTRIES,
]);

/**
 * A frozen read-only view with read methods only. Command names are own
 * enumerable properties (so Object.keys is the registry); the read methods are
 * prototype methods. There is no set/delete/clear, so neither a caller nor
 * Map.prototype.set.call can mutate the registry.
 */
class ReadonlyCommandRegistry implements ReadonlyMap<string, CommandDefinition> {
  readonly #table: ReadonlyMap<string, CommandDefinition>;

  constructor(table: ReadonlyMap<string, CommandDefinition>) {
    this.#table = table;
    for (const [name, definition] of table) {
      Object.defineProperty(this, name, {
        value: definition,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    Object.freeze(this);
  }

  get size(): number {
    return this.#table.size;
  }

  get(key: string): CommandDefinition | undefined {
    return this.#table.get(key);
  }

  has(key: string): boolean {
    return this.#table.has(key);
  }

  keys() {
    return this.#table.keys();
  }

  values() {
    return this.#table.values();
  }

  entries() {
    return this.#table.entries();
  }

  forEach(
    callbackfn: (value: CommandDefinition, key: string, map: ReadonlyMap<string, CommandDefinition>) => void,
    thisArg?: unknown,
  ): void {
    // Wrap the callback: delegating directly would hand the internal Map to it
    // as the third argument.
    this.#table.forEach((value, key) => {
      callbackfn.call(thisArg, value, key, this);
    });
  }

  [Symbol.iterator]() {
    return this.#table.entries();
  }
}

/** The closed command registry. Adding a table CRUD or arbitrary SQL command is forbidden. */
export const COMMANDS: ReadonlyMap<string, CommandDefinition> = new ReadonlyCommandRegistry(COMMAND_TABLE);

// SQLite extended result codes for uniqueness violations only. Everything else
// (FOREIGN KEY, NOT NULL, CHECK, programming errors) is rethrown unchanged:
// those are not a client-facing "conflict", and the tx has already rolled back.
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_ROWID = 2579;

/**
 * Only uniqueness violations become a client-safe conflict. The raw SQLite
 * message (which names tables and columns) is never exposed, not even in
 * details; other SQLite errors keep their original error for the caller.
 */
function translate_error(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof Error) {
    const candidate = error as Error & { errcode?: unknown };
    const errcode = typeof candidate.errcode === "number" ? candidate.errcode : undefined;
    if (
      errcode === SQLITE_CONSTRAINT_UNIQUE ||
      errcode === SQLITE_CONSTRAINT_PRIMARYKEY ||
      errcode === SQLITE_CONSTRAINT_ROWID
    ) {
      throw new ApiError("conflict", "UNIQUE constraint conflict");
    }
  }
  throw error;
}

export class CommandService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #policy: PolicyChecker;
  readonly #new_id: () => string;
  readonly #run_config: RunConfig;
  readonly #objects_dir: string | null;

  constructor(db: Db, options: CommandServiceOptions) {
    this.#db = db;
    this.#clock = options.clock;
    this.#policy = options.policy;
    this.#new_id = options.new_id ?? new_id;
    // Validate and copy the injected timing once. The service never reads the
    // ambient environment; a composition point resolves env explicitly.
    this.#run_config = Object.freeze(resolve_run_config(options.run_config, {}));
    this.#objects_dir = checked_objects_dir(options.objects_dir);
    if (this.#objects_dir !== null) register_object_store(db, this.#objects_dir);
  }

  /** The objects folder given at construction, or null when none was injected. */
  get object_store_dir(): string | null {
    return this.#objects_dir;
  }

  /**
   * Read-only view of the database for public wrappers that must look at the
   * current state outside a command (for example to tell a replayed receipt
   * from a state that has moved on). SELECT/WITH only; the handle is dead once
   * fn returns, and no write is possible through it.
   *
   * INTERNAL ONLY: this reads any table of any project with no actor or scope
   * check. It is for code that already holds the service. Never expose it through
   * the HTTP API or give it to a caller that acts for a user.
   */
  read<T>(fn: (db: ReadonlyDbHandle) => T): T {
    return with_readonly_db(this.#db, fn);
  }

  /**
   * Public entry point. The async wrapper only turns a synchronous failure into
   * a rejection; execute_sync() runs the whole transaction before this promise
   * settles, so no event-loop turn can interleave inside the tx.
   */
  async execute(
    ctx: MutationContext,
    command: string,
    payload: unknown,
  ): Promise<CommandOutcome> {
    return this.execute_sync(ctx, command, payload);
  }

  /**
   * Synchronous core shared with bootstrap_project (which must keep its
   * non-Promise signature). The registry check runs before any transaction.
   */
  execute_sync(ctx: MutationContext, command: string, payload: unknown): CommandOutcome {
    const definition = COMMAND_TABLE.get(command);
    if (definition === undefined) {
      throw new ApiError("unknown_command", `unknown command: ${command}`);
    }
    // Take one input snapshot before anything can observe or mutate it. All
    // later work (hash, policy copy, validation, execution) uses these values.
    const payload_snapshot = snapshot_payload(payload);
    const ctx_snapshot = snapshot_context(ctx);
    validate_context(ctx_snapshot);
    const hash = request_hash(command, payload_snapshot);
    try {
      return tx(this.#db, () =>
        this.#execute_in_tx(definition, command, ctx_snapshot, payload_snapshot, hash),
      );
    } catch (error) {
      throw translate_error(error);
    }
  }

  #execute_in_tx(
    definition: CommandDefinition,
    command: string,
    ctx: MutationContext,
    payload: unknown,
    hash: string,
  ): CommandOutcome {
    const now_ms = checked_now_ms(this.#clock);

    let project: ProjectRow | null = null;
    let actor_id: string | null = null;
    if (definition.scope === "project") {
      const scope = this.#resolve_scope(ctx);
      project = scope.project;
      actor_id = scope.actor_id;
    } else if (definition.scope === "bootstrap") {
      if (ctx.project_id !== null || ctx.actor_id !== null) {
        throw new ApiError("invalid_payload", "project.bootstrap runs without a project or actor");
      }
    } else {
      // "owner": no project yet, but the caller must still be a human actor.
      if (ctx.project_id !== null) {
        throw new ApiError("invalid_payload", "this command runs without a project");
      }
      if (ctx.actor_id === null) {
        throw new ApiError("forbidden", "a human owner actor is required");
      }
      const actor = read_credential_actor(this.#db, ctx.actor_id);
      if (actor === undefined || actor.kind !== "human") {
        throw new ApiError("forbidden", "a human owner actor is required");
      }
      actor_id = actor.actor_id;
    }

    // The checker is external code: give it copies so a mutation cannot move
    // the receipt key or change what the original payload stores, and treat
    // anything other than an explicit boolean true as a denial. It also gets a
    // read-only handle to this transaction so a real policy reads uncommitted
    // state without being able to write.
    const decision: unknown = with_readonly_db(this.#db, (read_db) =>
      this.#policy.check(clone_context(ctx), command, copy_snapshot(payload), read_db),
    );
    if (!policy_allows(decision)) {
      throw new ApiError("policy_denied", policy_denial_reason(decision));
    }

    const replay = this.#replayed_result(definition, ctx, actor_id, hash);
    if (replay !== undefined) {
      return { result: replay.result, replayed: true };
    }

    if (definition.rev_bearing) {
      if (project === null) {
        throw new Error("a rev-bearing command must have a project scope");
      }
      this.#require_rev(ctx, project);
    }

    const runtime: CommandRuntime = {
      db: this.#db,
      ctx,
      payload,
      now_ms,
      tx_id: this.#new_id(),
      request_hash: hash,
      new_id: this.#new_id,
      project,
      actor_id,
      run_config: this.#run_config,
      objects_dir: this.#objects_dir,
    };
    const outcome = definition.run(runtime);
    write_events(runtime, project?.id ?? result_project_id(outcome.result), outcome.events);
    return { result: outcome.result, replayed: false };
  }

  #resolve_scope(ctx: MutationContext): ResolvedScope {
    if (ctx.project_id === null || ctx.project_id.length === 0) {
      throw new ApiError("not_found", "project not found");
    }
    const project = this.#db.get<ProjectRow>(
      "SELECT id, control_rev, status FROM projects WHERE id = ?",
      ctx.project_id,
    );
    if (project === undefined) {
      throw new ApiError("not_found", `project not found: ${ctx.project_id}`);
    }

    if (ctx.actor_id === null || ctx.actor_id.length === 0) {
      throw new ApiError("forbidden", "an actor is required");
    }
    // One shared credential rule: the actor must exist, be enabled, have a
    // user, and that user must be enabled.
    const actor = read_credential_actor(this.#db, ctx.actor_id);
    if (actor === undefined) {
      throw new ApiError("forbidden", "the actor is not allowed in this project");
    }
    const member = this.#db.get<{ ok: bigint }>(
      "SELECT 1 AS ok FROM project_members WHERE project_id = ? AND user_id = ?",
      project.id,
      actor.user_id,
    );
    if (member === undefined) {
      throw new ApiError("forbidden", "the actor is not a member of the project");
    }
    return { project, actor_id: actor.actor_id };
  }

  #replayed_result(
    definition: CommandDefinition,
    ctx: MutationContext,
    actor_id: string | null,
    hash: string,
  ): { result: unknown } | undefined {
    if (definition.scope === "bootstrap") {
      // Bootstrap has no project scope yet; its receipt is found by request key
      // and action across the database.
      const rows = this.#db.all<{ request_hash: string; result_json: string }>(
        `SELECT request_hash, result_json FROM mutation_commits
         WHERE client_request_id = ? AND action = ?
         ORDER BY created_at, id`,
        ctx.client_request_id,
        definition.action,
      );
      if (rows.length === 0) return undefined;
      const match = rows.find((row) => row.request_hash === hash);
      if (match === undefined) {
        throw new ApiError(
          "idempotency_key_reuse",
          "client_request_id was already used for a different request",
        );
      }
      return { result: JSON.parse(match.result_json) };
    }

    if (definition.scope === "owner") {
      // Owner-scoped commands have no project yet; the same request key from
      // another actor must never replay this actor's result.
      if (actor_id === null) {
        throw new Error("an owner command must resolve its actor first");
      }
      const rows = this.#db.all<{ request_hash: string; result_json: string }>(
        `SELECT request_hash, result_json FROM mutation_commits
         WHERE client_request_id = ? AND action = ? AND actor_id = ?
         ORDER BY created_at, id`,
        ctx.client_request_id,
        definition.action,
        actor_id,
      );
      if (rows.length === 0) return undefined;
      const match = rows.find((row) => row.request_hash === hash);
      if (match === undefined) {
        throw new ApiError(
          "idempotency_key_reuse",
          "client_request_id was already used for a different request",
        );
      }
      return { result: JSON.parse(match.result_json) };
    }

    if (actor_id === null || ctx.project_id === null) {
      throw new Error("a project command must resolve its project and actor first");
    }
    const row = this.#db.get<{ request_hash: string; result_json: string }>(
      `SELECT request_hash, result_json FROM mutation_commits
       WHERE project_id = ? AND actor_id = ? AND client_request_id = ?`,
      ctx.project_id,
      actor_id,
      ctx.client_request_id,
    );
    if (row === undefined) return undefined;
    if (row.request_hash !== hash) {
      throw new ApiError(
        "idempotency_key_reuse",
        "client_request_id was already used for a different request",
      );
    }
    return { result: JSON.parse(row.result_json) };
  }

  #require_rev(ctx: MutationContext, project: ProjectRow): void {
    const base = ctx.base_control_rev;
    if (base === undefined) {
      throw new ApiError("invalid_payload", "base_control_rev is required for this command");
    }
    if (typeof base !== "number" || !Number.isSafeInteger(base) || base < 0) {
      throw new ApiError("invalid_payload", "base_control_rev must be a non-negative safe integer");
    }
    const actual = Number(project.control_rev);
    if (actual !== base) {
      throw new ApiError("rev_conflict", "base_control_rev is stale", {
        expected: base,
        actual,
      });
    }
  }
}

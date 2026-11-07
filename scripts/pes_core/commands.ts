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

import type { Clock } from "./clock.ts";
import { tx, type Db } from "./db.ts";
import { ApiError } from "./errors.ts";
import { new_id } from "./ids.ts";

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

export type CommandVia = "web" | "cli" | "http" | "mcp" | "webmcp" | "import";

export interface MutationContext {
  project_id: string | null;
  actor_id: string | null;
  via: CommandVia;
  client_request_id: string;
  base_control_rev?: number;
}

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * PR4 defines the seam only; PR10 supplies the real policy implementation.
 * A denial surfaces as ApiError code "policy_denied".
 */
export interface PolicyChecker {
  check(ctx: MutationContext, command: string, payload: unknown): PolicyDecision;
}

export interface CommandServiceOptions {
  clock: Clock;
  policy: PolicyChecker;
  /** Test seam; defaults to the shared server identifier generator. */
  new_id?: () => string;
}

export interface CommandOutcome {
  result: unknown;
  replayed: boolean;
}

interface ProjectRow {
  id: string;
  control_rev: bigint;
  status: string;
}

interface ActorRow {
  id: string;
  user_id: string | null;
  disabled_at: bigint | null;
}

interface ResolvedScope {
  project: ProjectRow;
  actor_id: string;
}

interface CommandRuntime {
  db: Db;
  ctx: MutationContext;
  payload: unknown;
  now_ms: number;
  tx_id: string;
  request_hash: string;
  new_id: () => string;
  project: ProjectRow | null;
  actor_id: string | null;
}

interface EventDraft {
  type: string;
  payload: unknown;
  before_rev?: number;
  after_rev?: number;
}

interface CommandResult {
  result: unknown;
  events: EventDraft[];
}

interface CommandDefinition {
  /** mutation_commits.action for this command. */
  action: string;
  /** "project" commands require an existing project and actor; bootstrap creates them. */
  scope: "project" | "bootstrap";
  rev_bearing: boolean;
  run(runtime: CommandRuntime): CommandResult;
}

const VIAS = new Set<string>(["web", "cli", "http", "mcp", "webmcp", "import"]);

function validate_context(ctx: MutationContext): void {
  if (typeof ctx.client_request_id !== "string" || ctx.client_request_id.length === 0) {
    throw new ApiError("invalid_payload", "client_request_id must be a non-empty string");
  }
  if (!VIAS.has(ctx.via)) {
    throw new ApiError("invalid_payload", `via is not a known transport: ${String(ctx.via)}`);
  }
  if (ctx.project_id !== null && typeof ctx.project_id !== "string") {
    throw new ApiError("invalid_payload", "project_id must be a string or null");
  }
  if (ctx.actor_id !== null && typeof ctx.actor_id !== "string") {
    throw new ApiError("invalid_payload", "actor_id must be a string or null");
  }
}

function is_record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function require_record(payload: unknown): Record<string, unknown> {
  if (!is_record(payload)) {
    throw new ApiError("invalid_payload", "payload must be a JSON object");
  }
  return payload;
}

function require_non_empty_string(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError("invalid_payload", `${field} must be a non-empty string`);
  }
  return value;
}

/** Deterministic JSON used only for request hashing. */
function canonical_json(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonical_json(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
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

function result_project_id(result: unknown): string {
  if (is_record(result) && typeof result.project_id === "string") {
    return result.project_id;
  }
  throw new Error("the command result must include project_id");
}

function insert_receipt(
  runtime: CommandRuntime,
  fields: {
    project_id: string;
    actor_id: string;
    action: string;
    base_control_rev: number | null;
    result: unknown;
  },
): void {
  const written = runtime.db.run(
    `INSERT INTO mutation_commits
       (id, project_id, actor_id, via, client_request_id, request_hash, action,
        base_control_rev, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    runtime.tx_id,
    fields.project_id,
    fields.actor_id,
    runtime.ctx.via,
    runtime.ctx.client_request_id,
    runtime.request_hash,
    fields.action,
    fields.base_control_rev,
    JSON.stringify(fields.result),
    runtime.now_ms,
  );
  if (written.changes !== 1n) {
    throw new Error("the mutation receipt was not written");
  }
}

function write_events(runtime: CommandRuntime, project_id: string, events: EventDraft[]): void {
  if (events.length === 0) {
    throw new Error("every command must leave at least one event");
  }
  for (const [index, event] of events.entries()) {
    const written = runtime.db.run(
      `INSERT INTO events
         (id, project_id, tx_id, tx_index, tx_size, type, object_id, before_rev,
          after_rev, payload, schema_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?)`,
      runtime.new_id(),
      project_id,
      runtime.tx_id,
      index,
      events.length,
      event.type,
      event.before_rev ?? null,
      event.after_rev ?? null,
      JSON.stringify(event.payload ?? {}),
      runtime.now_ms,
    );
    if (written.changes !== 1n) {
      throw new Error("the event was not written");
    }
  }
}

function run_bootstrap(runtime: CommandRuntime): CommandResult {
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
  };
  insert_receipt(runtime, {
    project_id,
    actor_id: owner_actor_id,
    action: "project.created",
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

  return {
    result,
    events: [
      {
        type: "project.created",
        payload: {
          slug,
          topic,
          owner_user_id,
          owner_actor_id,
          edition_id,
          policy_id,
        },
      },
    ],
  };
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

const BOOTSTRAP_COMMAND: CommandDefinition = {
  action: "project.created",
  scope: "bootstrap",
  rev_bearing: false,
  run: run_bootstrap,
};

const SET_TOPIC_COMMAND: CommandDefinition = {
  action: "project.topic_set",
  scope: "project",
  rev_bearing: true,
  run: run_set_topic,
};

/** The closed command registry. Adding a table CRUD or arbitrary SQL command is forbidden. */
export const COMMANDS: ReadonlyMap<string, CommandDefinition> = new Map([
  ["project.bootstrap", BOOTSTRAP_COMMAND],
  ["project.set_topic", SET_TOPIC_COMMAND],
]);

function translate_error(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown; errcode?: unknown };
    const errcode = typeof candidate.errcode === "number" ? candidate.errcode : undefined;
    // SQLITE_CONSTRAINT family: UNIQUE, CHECK, FOREIGN KEY, NOT NULL.
    if (errcode !== undefined && (errcode & 0xff) === 19) {
      throw new ApiError("conflict", error.message);
    }
    if (candidate.code === "ERR_SQLITE_ERROR" && /constraint/i.test(error.message)) {
      throw new ApiError("conflict", error.message);
    }
  }
  throw error;
}

export class CommandService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #policy: PolicyChecker;
  readonly #new_id: () => string;

  constructor(db: Db, options: CommandServiceOptions) {
    this.#db = db;
    this.#clock = options.clock;
    this.#policy = options.policy;
    this.#new_id = options.new_id ?? new_id;
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
    const definition = COMMANDS.get(command);
    if (definition === undefined) {
      throw new ApiError("unknown_command", `unknown command: ${command}`);
    }
    validate_context(ctx);
    const hash = request_hash(command, payload);
    try {
      return tx(this.#db, () => this.#execute_in_tx(definition, command, ctx, payload, hash));
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
    } else if (ctx.project_id !== null || ctx.actor_id !== null) {
      throw new ApiError("invalid_payload", "project.bootstrap runs without a project or actor");
    }

    const decision = this.#policy.check(ctx, command, payload);
    if (!decision.allowed) {
      throw new ApiError("policy_denied", decision.reason.length > 0 ? decision.reason : "policy denied");
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
    const actor = this.#db.get<ActorRow>(
      "SELECT id, user_id, disabled_at FROM actors WHERE id = ?",
      ctx.actor_id,
    );
    if (actor === undefined) {
      throw new ApiError("forbidden", `actor not found: ${ctx.actor_id}`);
    }
    if (actor.disabled_at !== null) {
      throw new ApiError("forbidden", "the actor is disabled");
    }
    if (actor.user_id === null) {
      throw new ApiError("forbidden", "the actor has no user");
    }
    const member = this.#db.get<{ ok: bigint }>(
      "SELECT 1 AS ok FROM project_members WHERE project_id = ? AND user_id = ?",
      project.id,
      actor.user_id,
    );
    if (member === undefined) {
      throw new ApiError("forbidden", "the actor is not a member of the project");
    }
    return { project, actor_id: actor.id };
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
    if (!Number.isSafeInteger(base) || base < 0) {
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

// Actors and project-scoped agent tokens (stage 2 PR10).
//
// The write path lives in commands/actors.ts: issue_agent_token and
// revoke_agent_token are thin wrappers that call CommandService.execute once.
// The functions here are read-only: they resolve an actor for a project,
// require a human owner, and verify a presented token. No business table is
// written outside the command service, and no raw token is ever stored,
// logged, or echoed in an error.

import { createHash, randomBytes } from "node:crypto";

import type { CommandOutcome, CommandService, MutationContext } from "./commands.ts";
import type { Db } from "./db.ts";
import { ApiError } from "./errors.ts";

/** Project token lifetime: exactly 30 days in milliseconds. */
export const AGENT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const TOKEN_PREFIX = "pes_";
const MAX_PRESENTED_TOKEN_LENGTH = 4096;

type ReadDb = Pick<Db, "get" | "all">;

export interface ActorLookup {
  project_id: string;
  actor_id?: string | null;
  token?: string | null;
}

export interface ResolvedActor {
  actor_id: string;
  kind: string;
  user_id: string;
  membership_role: string;
  token_id: string | null;
}

export interface TokenOptions {
  project_id: string;
  now_ms: number;
}

export interface VerifiedToken {
  token_id: string;
  actor_id: string;
  project_id: string;
  scopes: string[];
}

interface ActorRow {
  id: string;
  kind: string;
  user_id: string | null;
  disabled_at: bigint | null;
}

interface TokenRow {
  id: string;
  project_id: string;
  actor_id: string;
  scopes: string;
  expires_at: bigint | null;
  revoked_at: bigint | null;
}

function invalid_token(): never {
  // Deliberately carries no token text and no table/column names.
  throw new ApiError("forbidden", "the agent token is not valid");
}

function forbidden_actor(): never {
  throw new ApiError("forbidden", "the actor is not allowed in this project");
}

/** Caller-supplied clock values must be a non-negative safe integer before BigInt(). */
function require_now_ms(now_ms: unknown): number {
  if (typeof now_ms !== "number" || !Number.isSafeInteger(now_ms) || now_ms < 0) {
    throw new ApiError("invalid_payload", "now_ms must be a non-negative safe integer");
  }
  return now_ms;
}

/** Fresh random secret. Only the return value of token.issue carries the raw text. */
export function generate_agent_token(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** One-way hash used as the only persisted form of the token. */
export function agent_token_hash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Verify a presented token for one project. Every failure is the same
 * forbidden error: unknown, malformed, revoked, expired (now >= expires_at),
 * wrong project, disabled actor, or broken scopes JSON.
 */
export function verify_agent_token(db: ReadDb, token: unknown, options: TokenOptions): VerifiedToken {
  const now_ms = require_now_ms(options.now_ms);
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_PRESENTED_TOKEN_LENGTH ||
    !token.isWellFormed()
  ) {
    return invalid_token();
  }
  const row = db.get<TokenRow>(
    `SELECT id, project_id, actor_id, scopes, expires_at, revoked_at
       FROM agent_tokens WHERE token_hash = ?`,
    agent_token_hash(token),
  );
  if (row === undefined) return invalid_token();
  if (row.project_id !== options.project_id) return invalid_token();
  if (row.revoked_at !== null) return invalid_token();
  if (row.expires_at === null || typeof row.expires_at !== "bigint") return invalid_token();
  if (BigInt(now_ms) >= row.expires_at) return invalid_token();

  const actor = db.get<{ disabled_at: bigint | null; user_id: string | null }>(
    "SELECT disabled_at, user_id FROM actors WHERE id = ?",
    row.actor_id,
  );
  if (actor === undefined || actor.disabled_at !== null) return invalid_token();
  // A token of an actor whose user is disabled is dead even while the actor row
  // itself is still enabled.
  if (actor.user_id !== null) {
    const user = db.get<{ disabled_at: bigint | null }>(
      "SELECT disabled_at FROM users WHERE id = ?",
      actor.user_id,
    );
    if (user === undefined || user.disabled_at !== null) return invalid_token();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.scopes);
  } catch {
    return invalid_token();
  }
  if (!Array.isArray(parsed) || parsed.some((scope) => typeof scope !== "string")) {
    return invalid_token();
  }
  return {
    token_id: row.id,
    actor_id: row.actor_id,
    project_id: row.project_id,
    scopes: parsed as string[],
  };
}

/**
 * Resolve exactly one credential (actor id or agent token) to an enabled,
 * member actor of the project. A token resolves to its own actor. The
 * returned membership_role comes from the project member row of the actor's
 * user; an agent sharing the owner's user still has kind != "human".
 */
export function resolve_actor(db: ReadDb, lookup: ActorLookup, now_ms: number): ResolvedActor {
  if (lookup === null || typeof lookup !== "object") {
    throw new ApiError("invalid_payload", "an actor lookup object is required");
  }
  const at = require_now_ms(now_ms);
  const project_id = lookup.project_id;
  if (typeof project_id !== "string" || project_id.length === 0) {
    throw new ApiError("invalid_payload", "project_id must be a non-empty string");
  }
  const has_actor = lookup.actor_id !== undefined && lookup.actor_id !== null;
  const has_token = lookup.token !== undefined && lookup.token !== null;
  if (has_actor === has_token) {
    throw new ApiError("invalid_payload", "exactly one of actor_id or token is required");
  }

  let actor_id: string;
  let token_id: string | null = null;
  if (has_actor) {
    if (
      typeof lookup.actor_id !== "string" ||
      lookup.actor_id.length === 0 ||
      !lookup.actor_id.isWellFormed()
    ) {
      throw new ApiError("invalid_payload", "actor_id must be a non-empty string");
    }
    actor_id = lookup.actor_id;
  } else {
    const verified = verify_agent_token(db, lookup.token, { project_id, now_ms: at });
    actor_id = verified.actor_id;
    token_id = verified.token_id;
  }

  const actor = db.get<ActorRow>(
    "SELECT id, kind, user_id, disabled_at FROM actors WHERE id = ?",
    actor_id,
  );
  if (actor === undefined || actor.disabled_at !== null) return forbidden_actor();
  if (actor.user_id === null) return forbidden_actor();
  const user = db.get<{ disabled_at: bigint | null }>(
    "SELECT disabled_at FROM users WHERE id = ?",
    actor.user_id,
  );
  if (user === undefined || user.disabled_at !== null) return forbidden_actor();
  const member = db.get<{ role: string }>(
    "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
    project_id,
    actor.user_id,
  );
  if (member === undefined) return forbidden_actor();
  return {
    actor_id: actor.id,
    kind: actor.kind,
    user_id: actor.user_id,
    membership_role: member.role,
    token_id,
  };
}

/** Policy changes and token management are reserved for a human owner. */
export function require_human_owner(resolved: ResolvedActor): ResolvedActor {
  if (
    resolved === null ||
    typeof resolved !== "object" ||
    resolved.kind !== "human" ||
    resolved.membership_role !== "owner"
  ) {
    throw new ApiError("forbidden", "a human project owner is required");
  }
  return resolved;
}

export function issue_agent_token(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "token.issue", input);
}

export function revoke_agent_token(
  service: CommandService,
  ctx: MutationContext,
  input: unknown,
): Promise<CommandOutcome> {
  return service.execute(ctx, "token.revoke", input);
}

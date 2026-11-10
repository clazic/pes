// Agent token command definitions (stage 2 PR10).
//
// Only a human project owner may issue or revoke a token. The raw secret exists
// exactly once: in the result of the first token.issue response. The receipt
// stores a result without it, events name the token by id, and the table keeps
// only the SHA-256 hash. A replay returns the stored (hash-free) result.

import {
  AGENT_TOKEN_TTL_MS,
  agent_token_hash,
  generate_agent_token,
  read_credential_actor,
} from "../actors.ts";
import { ApiError } from "../errors.ts";
import {
  insert_receipt,
  reject_unknown_fields,
  require_human_owner_actor,
  require_non_empty_string,
  require_record,
  type CommandDefinition,
  type CommandResult,
  type CommandRuntime,
} from "./shared.ts";

const TOKEN_ISSUE_FIELDS = ["actor_id", "scopes"] as const;
const TOKEN_REVOKE_FIELDS = ["token_id"] as const;

const AGENT_KINDS = new Set([
  "internal_ai",
  "external_agent",
  "browser_agent",
  "system",
  "legacy_unknown",
]);

interface TargetActorRow {
  id: string;
  kind: string;
  disabled_at: bigint | null;
}

function invalid_payload(message: string): never {
  throw new ApiError("invalid_payload", message);
}

function require_scopes(payload: Record<string, unknown>): string[] {
  const value = payload.scopes;
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return invalid_payload("scopes must be an array of non-empty strings");
  }
  return value.map((scope) => {
    if (typeof scope !== "string" || scope.trim().length === 0 || !scope.isWellFormed()) {
      return invalid_payload("scopes must be an array of non-empty strings");
    }
    return scope;
  });
}

function require_scope(runtime: CommandRuntime): { project_id: string; actor_id: string } {
  const project = runtime.project;
  const actor_id = runtime.actor_id;
  if (project === null || actor_id === null) {
    throw new Error("a token command must resolve a project and actor first");
  }
  return { project_id: project.id, actor_id };
}

function run_token_issue(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, TOKEN_ISSUE_FIELDS);
  const target_id = require_non_empty_string(payload, "actor_id");
  const scopes = require_scopes(payload);

  const scope = require_scope(runtime);
  require_human_owner_actor(runtime);

  const target = runtime.db.get<TargetActorRow>(
    "SELECT id, kind, disabled_at FROM actors WHERE id = ?",
    target_id,
  );
  if (target === undefined) {
    throw new ApiError("not_found", "actor not found");
  }
  if (target.kind === "human" || !AGENT_KINDS.has(target.kind)) {
    return invalid_payload("an agent token can only be issued to an agent actor");
  }
  if (target.disabled_at !== null) {
    throw new ApiError("forbidden", "the actor is disabled");
  }
  // Same eligibility rule as token verification: an enabled actor of an
  // enabled user who is a member of this project. Otherwise no row is written.
  const eligible = read_credential_actor(runtime.db, target.id);
  const member =
    eligible === undefined
      ? undefined
      : runtime.db.get<{ role: string }>(
          "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
          scope.project_id,
          eligible.user_id,
        );
  if (eligible === undefined || member === undefined) {
    throw new ApiError("forbidden", "the actor is not allowed in this project");
  }

  const token_id = runtime.new_id();
  const token = generate_agent_token();
  const expires_at = runtime.now_ms + AGENT_TOKEN_TTL_MS;

  runtime.db.run(
    `INSERT INTO agent_tokens
       (id, project_id, actor_id, scopes, token_hash, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    token_id,
    scope.project_id,
    target.id,
    JSON.stringify(scopes),
    agent_token_hash(token),
    runtime.now_ms,
    expires_at,
  );

  // The raw token is returned to the caller but never written to the receipt.
  const result = {
    project_id: scope.project_id,
    token_id,
    actor_id: target.id,
    scopes,
    expires_at,
    token,
  };
  const { token: _raw_token, ...stored_result } = result;
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "token.issued",
    base_control_rev: null,
    result: stored_result,
  });
  return {
    result,
    events: [
      {
        type: "token.issued",
        payload: {
          token_id,
          actor_id: target.id,
          scopes,
          expires_at,
        },
      },
    ],
  };
}

function run_token_revoke(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, TOKEN_REVOKE_FIELDS);
  const token_id = require_non_empty_string(payload, "token_id");

  const scope = require_scope(runtime);
  require_human_owner_actor(runtime);

  const written = runtime.db.run(
    `UPDATE agent_tokens SET revoked_at = COALESCE(revoked_at, ?)
      WHERE project_id = ? AND id = ?`,
    runtime.now_ms,
    scope.project_id,
    token_id,
  );
  if (written.changes !== 1n) {
    throw new ApiError("not_found", "agent token not found");
  }

  const result = { project_id: scope.project_id, token_id };
  insert_receipt(runtime, {
    project_id: scope.project_id,
    actor_id: scope.actor_id,
    action: "token.revoked",
    base_control_rev: null,
    result,
  });
  return {
    result,
    events: [{ type: "token.revoked", payload: { token_id } }],
  };
}

function definition(
  action: string,
  run: (runtime: CommandRuntime) => CommandResult,
): CommandDefinition {
  return Object.freeze({ action, scope: "project", rev_bearing: false, run });
}

const ACTOR_COMMAND_INPUTS: ReadonlyArray<readonly [string, CommandDefinition]> = [
  ["token.issue", definition("token.issued", run_token_issue)],
  ["token.revoke", definition("token.revoked", run_token_revoke)],
];

/** Registry entries merged into COMMANDS by commands.ts (names, not actions). */
export const ACTOR_COMMAND_ENTRIES: ReadonlyArray<readonly [string, CommandDefinition]> = Object.freeze(
  ACTOR_COMMAND_INPUTS.map((entry) => Object.freeze([entry[0], entry[1]] as const)),
);

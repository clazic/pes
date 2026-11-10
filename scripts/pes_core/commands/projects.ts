// Project creation commands: project.bootstrap and project.register.
//
// project.bootstrap makes the project, its owner, the initial policy and the
// first edition in one transaction. project.register does the same and, in
// that same transaction, adds the approved device (an external_agent actor of
// the owner's user) with its first project token. Neither runs inside a
// project. The raw token is returned once and never stored in the receipt.

import {
  AGENT_SCOPE_NAMES,
  AGENT_TOKEN_TTL_MS,
  generate_agent_token,
} from "../actors.ts";
import { insert_agent_token } from "./actors.ts";
import { ApiError } from "../errors.ts";
import {
  reject_unknown_fields,
  require_non_empty_string,
  require_record,
  type CommandDefinition,
  type CommandResult,
  type CommandRuntime,
} from "./shared.ts";


export interface Created {
  project_id: string;
  owner_user_id: string;
  owner_actor_id: string;
  edition_id: string;
  policy_id: string;
}

export interface BuildHooks {
  action: string;
  event_type: string;
  stored_extra: Record<string, unknown>;
  event_extra: Record<string, unknown>;
  after(created: Created): void;
}

export type BuildProject = (runtime: CommandRuntime, hooks: BuildHooks) => CommandResult;

const REGISTER_FIELDS = ["slug", "topic", "owner_display_name", "device_label", "scopes"] as const;

function run_register(runtime: CommandRuntime, build: BuildProject): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, REGISTER_FIELDS);
  const device_label = require_non_empty_string(payload, "device_label");
  let scopes: string[] = [...AGENT_SCOPE_NAMES];
  if (payload.scopes !== undefined) {
    const given = payload.scopes;
    if (!Array.isArray(given) || given.length === 0) {
      throw new ApiError("invalid_payload", "scopes must be a non-empty array");
    }
    for (const scope of given) {
      if (typeof scope !== "string" || !(AGENT_SCOPE_NAMES as readonly string[]).includes(scope)) {
        throw new ApiError("invalid_payload", "scopes contains an unknown scope");
      }
    }
    if (new Set(given).size !== given.length) {
      throw new ApiError("invalid_payload", "scopes must not repeat");
    }
    scopes = given as string[];
  }
  const device_actor_id = runtime.new_id();
  const token_id = runtime.new_id();
  const token = generate_agent_token();
  const expires_at = runtime.now_ms + AGENT_TOKEN_TTL_MS;
  const stored_extra = { device_actor_id, token_id, scopes, expires_at };

  const out = build(runtime, {
    action: "project.registered",
    event_type: "project.registered",
    stored_extra,
    event_extra: { device_actor_id, token_id, scopes, expires_at },
    after: (created: Created) => {
      runtime.db.run(
        "INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, 'external_agent', ?, ?)",
        device_actor_id,
        created.owner_user_id,
        device_label,
      );
      insert_agent_token(runtime.db, {
        id: token_id,
        project_id: created.project_id,
        actor_id: device_actor_id,
        scopes,
        token,
        created_at: runtime.now_ms,
        expires_at,
      });
    },
  });
  // The receipt keeps the hash-free result; only the caller sees the token.
  return { result: { ...(out.result as Record<string, unknown>), token }, events: out.events };
}


/** project.register: the project builder of commands.ts plus the approved device and its token. */
export function make_register_command(build: BuildProject): CommandDefinition {
  return Object.freeze({
    action: "project.registered",
    scope: "bootstrap",
    rev_bearing: false,
    run: (runtime: CommandRuntime) => run_register(runtime, build),
  });
}

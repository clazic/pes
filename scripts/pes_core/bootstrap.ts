// Project bootstrap: owner, initial policy, first edition, six stages, counters,
// and active pointers in one transaction.
//
// This is a PR1 building block, not the PR4 command service. It writes the one
// mutation_commits row that project_policy_versions.tx_id requires by foreign
// key; idempotent replay, receipts, and events remain PR4 work. No round is
// opened here: rounds belong to the edition/round commands (PR6).

import { createHash } from "node:crypto";

import type { Clock } from "./clock.ts";
import { tx, type Db } from "./db.ts";

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

export interface BootstrapInput {
  slug: string;
  topic: string;
  owner_display_name: string;
}

export interface BootstrapDeps {
  clock: Clock;
  new_id: () => string;
}

export interface BootstrapResult {
  project_id: string;
  owner_user_id: string;
  owner_actor_id: string;
  edition_id: string;
  policy_id: string;
  tx_id: string;
  stage_ids: Record<StageKey, string>;
  counter_namespaces: string[];
}

function require_non_empty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function request_hash(project_id: string): string {
  return createHash("sha256").update(`project.created:${project_id}`).digest("hex");
}

/**
 * Create a synthetic or real project with the confirmed initial policy
 * (OpenCode Go transfer allowed by default, stage-0 section 7-1).
 */
export function bootstrap_project(
  db: Db,
  input: BootstrapInput,
  deps: BootstrapDeps,
): BootstrapResult {
  const slug = require_non_empty(input.slug, "slug");
  const topic = require_non_empty(input.topic, "topic");
  const owner_display_name = require_non_empty(input.owner_display_name, "owner_display_name");
  const now_ms = deps.clock.now_ms();
  if (!Number.isSafeInteger(now_ms) || now_ms < 0) {
    throw new TypeError("clock.now_ms() must return a non-negative safe integer");
  }

  return tx(db, () => {
    const project_id = deps.new_id();
    const owner_user_id = deps.new_id();
    const owner_actor_id = deps.new_id();
    const tx_id = deps.new_id();
    const policy_id = deps.new_id();
    const edition_id = deps.new_id();

    db.run(
      "INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)",
      owner_user_id,
      owner_display_name,
      now_ms,
    );
    db.run(
      "INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, 'human', ?, ?)",
      owner_actor_id,
      owner_user_id,
      owner_display_name,
    );
    db.run(
      `INSERT INTO projects (id, slug, topic, owner_user_id, status, created_at)
       VALUES (?, ?, ?, ?, 'staging', ?)`,
      project_id,
      slug,
      topic,
      owner_user_id,
      now_ms,
    );
    db.run(
      "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')",
      project_id,
      owner_user_id,
    );

    db.run(
      `INSERT INTO mutation_commits
         (id, project_id, actor_id, via, client_request_id, request_hash, action,
          base_control_rev, result_json, created_at)
       VALUES (?, ?, ?, 'cli', 'bootstrap', ?, 'project.created', 0, '{}', ?)`,
      tx_id,
      project_id,
      owner_actor_id,
      request_hash(project_id),
      now_ms,
    );
    db.run(
      `INSERT INTO project_policy_versions
         (id, project_id, policy_rev, allow_opencode_go, changed_by, changed_by_user_id,
          changed_by_kind, reason, tx_id, created_at)
       VALUES (?, ?, 1, 1, ?, ?, 'human', '초기 정책: OpenCode Go 전송 허용 기본 켜짐', ?, ?)`,
      policy_id,
      project_id,
      owner_actor_id,
      owner_user_id,
      tx_id,
      now_ms,
    );

    db.run(
      "INSERT INTO editions (id, project_id, edition_no, status) VALUES (?, ?, 1, 'active')",
      edition_id,
      project_id,
    );

    const stage_ids = {} as Record<StageKey, string>;
    for (const [index, key] of STAGE_KEYS.entries()) {
      const stage_id = deps.new_id();
      stage_ids[key] = stage_id;
      db.run(
        "INSERT INTO stages (id, project_id, edition_id, key, ordinal) VALUES (?, ?, ?, ?, ?)",
        stage_id,
        project_id,
        edition_id,
        key,
        index + 1,
      );
    }

    for (const namespace of OBJECT_KINDS) {
      db.run(
        "INSERT INTO counters (project_id, namespace, next_no) VALUES (?, ?, 1)",
        project_id,
        namespace,
      );
    }

    const edition_pointer = db.run(
      "UPDATE editions SET current_stage_id = ? WHERE project_id = ? AND id = ?",
      stage_ids.plan,
      project_id,
      edition_id,
    );
    if (edition_pointer.changes !== 1n) {
      throw new Error("bootstrap failed to set the edition current_stage_id pointer");
    }

    const project_pointer = db.run(
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
      project_id,
      owner_user_id,
      owner_actor_id,
      edition_id,
      policy_id,
      tx_id,
      stage_ids,
      counter_namespaces: [...OBJECT_KINDS],
    } satisfies BootstrapResult;
  });
}

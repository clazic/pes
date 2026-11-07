// Synthetic seed rows for PR1 constraint tests. Every value below is invented.
// Call this inside tx(): questions.original_version_id is a deferred FK and
// needs the surrounding transaction to commit.

import type { BootstrapResult } from "../../scripts/pes_core/bootstrap.ts";
import type { Clock } from "../../scripts/pes_core/clock.ts";
import type { Db } from "../../scripts/pes_core/db.ts";
import { new_id } from "../../scripts/pes_core/ids.ts";

export const SYNTHETIC_HASH = "a".repeat(64);
export const SYNTHETIC_BLOB_HASH = "b".repeat(64);

export interface SeededGraph {
  artifact_object_id: string;
  artifact_version_id: string;
  source_object_id: string;
  source_version_id: string;
  question_object_id: string;
  question_version_id: string;
  question_set_id: string;
  submission_id: string;
  answer_object_id: string;
  answer_version_id: string;
  run_id: string;
  lease_id: string;
  blob_id: string;
  file_policy_id: string;
  event_id: string;
}

export function seed_representative_graph(
  db: Db,
  project: BootstrapResult,
  clock: Clock,
): SeededGraph {
  const now = clock.now_ms();
  const artifact_object_id = new_id();
  const artifact_version_id = new_id();
  const source_object_id = new_id();
  const source_version_id = new_id();
  const question_object_id = new_id();
  const question_version_id = new_id();
  const question_set_id = new_id();
  const submission_id = new_id();
  const answer_object_id = new_id();
  const answer_version_id = new_id();
  const run_id = new_id();
  const lease_id = new_id();
  const blob_id = new_id();
  const file_policy_id = new_id();
  const event_id = new_id();

  // Artifact object + immutable version + current pointer.
  db.run(
    "INSERT INTO objects (id, project_id, edition_id, kind, display_no) VALUES (?, ?, ?, 'artifact', 1)",
    artifact_object_id,
    project.project_id,
    project.edition_id,
  );
  db.run(
    `INSERT INTO object_versions
       (id, project_id, object_id, kind, version_no, actor_id, tx_id, content_hash, created_at)
     VALUES (?, ?, ?, 'artifact', 1, ?, ?, ?, ?)`,
    artifact_version_id,
    project.project_id,
    artifact_object_id,
    project.owner_actor_id,
    project.tx_id,
    SYNTHETIC_HASH,
    now,
  );
  db.run(
    "INSERT INTO artifacts (project_id, object_id, stage_id, kind) VALUES (?, ?, ?, 'section')",
    project.project_id,
    artifact_object_id,
    project.stage_ids.plan,
  );
  db.run(
    `INSERT INTO artifact_versions
       (project_id, version_id, object_id, title, body_md, status)
     VALUES (?, ?, ?, ?, ?, 'done')`,
    project.project_id,
    artifact_version_id,
    artifact_object_id,
    "합성 결과",
    "합성 문장",
  );
  db.run(
    "UPDATE objects SET current_version_id = ?, rev = 1 WHERE project_id = ? AND id = ?",
    artifact_version_id,
    project.project_id,
    artifact_object_id,
  );

  // Source object + version + citation from the artifact version.
  db.run(
    "INSERT INTO objects (id, project_id, edition_id, kind, display_no) VALUES (?, ?, ?, 'source', 1)",
    source_object_id,
    project.project_id,
    project.edition_id,
  );
  db.run(
    `INSERT INTO object_versions
       (id, project_id, object_id, kind, version_no, actor_id, tx_id, content_hash, created_at)
     VALUES (?, ?, ?, 'source', 1, ?, ?, ?, ?)`,
    source_version_id,
    project.project_id,
    source_object_id,
    project.owner_actor_id,
    project.tx_id,
    SYNTHETIC_HASH,
    now,
  );
  db.run(
    "INSERT INTO sources (project_id, object_id, kind) VALUES (?, ?, 'web')",
    project.project_id,
    source_object_id,
  );
  db.run(
    `INSERT INTO source_versions
       (project_id, version_id, object_id, title, url, retrieved_at, method,
        verification_state, quote)
     VALUES (?, ?, ?, ?, ?, ?, 'fetch', 'verified', ?)`,
    project.project_id,
    source_version_id,
    source_object_id,
    "가상 출처",
    "https://example.invalid/synthetic-source",
    now,
    "합성 근거",
  );
  db.run(
    "UPDATE objects SET current_version_id = ?, rev = 1 WHERE project_id = ? AND id = ?",
    source_version_id,
    project.project_id,
    source_object_id,
  );
  db.run(
    `INSERT INTO citations
       (project_id, artifact_version_id, citation_no, source_version_id)
     VALUES (?, ?, 1, ?)`,
    project.project_id,
    artifact_version_id,
    source_version_id,
  );

  // Question identity and first version share the transaction (deferred FK).
  db.run(
    "INSERT INTO objects (id, project_id, edition_id, kind, display_no) VALUES (?, ?, ?, 'question', 1)",
    question_object_id,
    project.project_id,
    project.edition_id,
  );
  db.run(
    `INSERT INTO questions
       (project_id, object_id, asked_by_actor_id, intended_actor_id, direction, origin,
        original_version_id)
     VALUES (?, ?, ?, ?, 'agent_to_human', 'bank', ?)`,
    project.project_id,
    question_object_id,
    project.owner_actor_id,
    project.owner_actor_id,
    question_version_id,
  );
  db.run(
    `INSERT INTO object_versions
       (id, project_id, object_id, kind, version_no, actor_id, tx_id, content_hash, created_at)
     VALUES (?, ?, ?, 'question', 1, ?, ?, ?, ?)`,
    question_version_id,
    project.project_id,
    question_object_id,
    project.owner_actor_id,
    project.tx_id,
    SYNTHETIC_HASH,
    now,
  );
  db.run(
    `INSERT INTO question_versions
       (project_id, version_id, object_id, text, type, required, default_value, options)
     VALUES (?, ?, ?, ?, 'single', 1, 'null', '[]')`,
    project.project_id,
    question_version_id,
    question_object_id,
    "첫 질문",
  );
  db.run(
    "UPDATE objects SET current_version_id = ?, rev = 1 WHERE project_id = ? AND id = ?",
    question_version_id,
    project.project_id,
    question_object_id,
  );

  db.run(
    `INSERT INTO question_sets
       (id, project_id, stage_id, purpose, form_key, version_no, published_at)
     VALUES (?, ?, ?, 'stage_start', 'plan-start', 1, ?)`,
    question_set_id,
    project.project_id,
    project.stage_ids.plan,
    now,
  );
  db.run(
    `INSERT INTO question_set_members
       (project_id, set_id, question_id, question_version_id, position)
     VALUES (?, ?, ?, ?, 0)`,
    project.project_id,
    question_set_id,
    question_object_id,
    question_version_id,
  );

  // Submission envelope + answer identity/version.
  db.run(
    `INSERT INTO submissions
       (id, project_id, actor_id, set_id, received_at, via, tx_id)
     VALUES (?, ?, ?, ?, ?, 'cli', ?)`,
    submission_id,
    project.project_id,
    project.owner_actor_id,
    question_set_id,
    now,
    project.tx_id,
  );
  db.run(
    "INSERT INTO objects (id, project_id, edition_id, kind, display_no) VALUES (?, ?, ?, 'answer', 1)",
    answer_object_id,
    project.project_id,
    project.edition_id,
  );
  db.run(
    `INSERT INTO answers (project_id, object_id, question_id, respondent_actor_id, submission_id)
     VALUES (?, ?, ?, ?, ?)`,
    project.project_id,
    answer_object_id,
    question_object_id,
    project.owner_actor_id,
    submission_id,
  );
  db.run(
    `INSERT INTO object_versions
       (id, project_id, object_id, kind, version_no, actor_id, tx_id, content_hash, created_at)
     VALUES (?, ?, ?, 'answer', 1, ?, ?, ?, ?)`,
    answer_version_id,
    project.project_id,
    answer_object_id,
    project.owner_actor_id,
    project.tx_id,
    SYNTHETIC_HASH,
    now,
  );
  db.run(
    `INSERT INTO answer_versions
       (project_id, version_id, object_id, question_id, question_version_id, value, used_default)
     VALUES (?, ?, ?, ?, ?, 'null', 0)`,
    project.project_id,
    answer_version_id,
    answer_object_id,
    question_object_id,
    question_version_id,
  );
  db.run(
    "UPDATE objects SET current_version_id = ?, rev = 1 WHERE project_id = ? AND id = ?",
    answer_version_id,
    project.project_id,
    answer_object_id,
  );

  // A claimed run with its lease, target, input receipt, and event.
  db.run(
    `INSERT INTO runs
       (id, project_id, edition_id, stage_id, actor_id, mode, runtime, provider, model,
        status, base_control_rev, started_at)
     VALUES (?, ?, ?, ?, ?, 'B', 'claude_code', 'anthropic', 'unknown', 'running', 0, ?)`,
    run_id,
    project.project_id,
    project.edition_id,
    project.stage_ids.plan,
    project.owner_actor_id,
    now,
  );
  db.run(
    `INSERT INTO project_leases
       (project_id, lease_id, run_id, owner_actor_id, fence, state,
        acquired_at, heartbeat_at, expires_at)
     VALUES (?, ?, ?, ?, 1, 'active', ?, ?, ?)`,
    project.project_id,
    lease_id,
    run_id,
    project.owner_actor_id,
    now,
    now,
    now + 60_000,
  );
  db.run(
    `INSERT INTO run_targets (project_id, run_id, object_id, base_version_id, base_rev)
     VALUES (?, ?, ?, ?, 0)`,
    project.project_id,
    run_id,
    artifact_object_id,
    artifact_version_id,
  );
  db.run(
    `INSERT INTO run_input_receipts (project_id, run_id, input_version_id, state)
     VALUES (?, ?, ?, 'seen')`,
    project.project_id,
    run_id,
    answer_version_id,
  );
  db.run(
    `INSERT INTO events
       (id, project_id, run_id, tx_id, tx_index, tx_size, type, object_id,
        after_version_id, created_at)
     VALUES (?, ?, ?, ?, 0, 1, 'fixture.created', ?, ?, ?)`,
    event_id,
    project.project_id,
    run_id,
    project.tx_id,
    artifact_object_id,
    artifact_version_id,
    now,
  );

  // Blob + blob-scoped file policy + version attachment.
  db.run(
    `INSERT INTO blobs
       (id, project_id, storage_key, sha256, size, media_type, state, created_by)
     VALUES (?, ?, ?, ?, 20, 'application/json', 'ready', ?)`,
    blob_id,
    project.project_id,
    `synthetic/${project.project_id}/manifest`,
    SYNTHETIC_BLOB_HASH,
    project.owner_actor_id,
  );
  db.run(
    `INSERT INTO file_policies
       (id, project_id, blob_id, ai_access, rev, changed_by_actor_id,
        changed_by_user_id, changed_at, tx_id)
     VALUES (?, ?, ?, 'allow', 1, ?, ?, ?, ?)`,
    file_policy_id,
    project.project_id,
    blob_id,
    project.owner_actor_id,
    project.owner_user_id,
    now,
    project.tx_id,
  );
  db.run(
    `INSERT INTO version_files (project_id, version_id, blob_id, role, file_policy_id)
     VALUES (?, ?, ?, 'attachment', ?)`,
    project.project_id,
    artifact_version_id,
    blob_id,
    file_policy_id,
  );

  return {
    artifact_object_id,
    artifact_version_id,
    source_object_id,
    source_version_id,
    question_object_id,
    question_version_id,
    question_set_id,
    submission_id,
    answer_object_id,
    answer_version_id,
    run_id,
    lease_id,
    blob_id,
    file_policy_id,
    event_id,
  };
}

// Legacy import command definition (stage 2 PR11).
//
// This file holds every business-table write of the legacy importer. The
// public wrapper in scripts/pes_core/legacy.ts reads and parses the source
// folder and builds a plan; this command writes the plan in one transaction:
// project, edition, six stages, rounds/snapshots, approvals, objects/versions,
// sources/citations, questions/answers, submissions, threads/messages,
// follow-ups, blobs/version_files, import_batches, legacy_mappings, events and
// the command receipt.
//
// The command is registered as legacy.import_project with scope "owner": it has
// no project yet but must be run by a human owner actor, and every receipt and
// event uses via='import'. The importer never activates a project; PR12 owns
// validation and activation.
//
// Source bytes are copied into the service's canonical object store and are
// re-read and measured before a blob becomes ready (the PR9 rule). A mismatched
// measurement quarantines the blob instead of trusting the caller's hash.

import { read_credential_actor } from "../actors.ts";
import { ApiError } from "../errors.ts";
import { sha256_hex, write_storage_bytes } from "../files.ts";
import { FILE_COMMAND_ENTRIES } from "./files.ts";
import {
  take_prepared_import,
  report_unknown,
  LEGACY_STAGE_KEYS,
  type ImportPlan,
  type LegacyStageKey,
  type PlanObjectRow,
  type PreparedImport,
} from "../legacy.ts";
import {
  insert_receipt,
  reject_unknown_fields,
  require_non_empty_string,
  require_record,
  write_events,
  type CommandDefinition,
  type CommandResult,
  type CommandRuntime,
} from "./shared.ts";

const PAYLOAD_FIELDS = ["source_fingerprint"] as const;
const OBJECT_COUNTER_NAMESPACES = [
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

function invalid(message: string): never {
  throw new ApiError("invalid_payload", message);
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

function next_event_seq(runtime: CommandRuntime): number {
  const row = runtime.db.get<{ n: bigint | null }>("SELECT max(event_seq) AS n FROM events");
  const next = Number(row?.n ?? 0n) + 1;
  if (!Number.isSafeInteger(next) || next < 1) {
    throw new Error("the event sequence is exhausted");
  }
  return next;
}

const FILE_COMMANDS = new Map<string, CommandDefinition>(FILE_COMMAND_ENTRIES);

function file_command(name: string): CommandDefinition {
  const definition = FILE_COMMANDS.get(name);
  if (definition === undefined) throw new Error(`the file command is missing: ${name}`);
  return definition;
}

function run_import_project(runtime: CommandRuntime): CommandResult {
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, PAYLOAD_FIELDS);
  const fingerprint = require_non_empty_string(payload, "source_fingerprint");
  const owner_actor_id = runtime.actor_id;
  if (owner_actor_id === null) {
    throw new ApiError("forbidden", "a human owner is required");
  }

  const owner = read_credential_actor(runtime.db, owner_actor_id);
  if (owner === undefined || owner.kind !== "human" || owner.user_id === null) {
    throw new ApiError("forbidden", "a human owner is required");
  }

  const prepared: PreparedImport | undefined = take_prepared_import(owner_actor_id, fingerprint);
  if (prepared === undefined || prepared.plan.fingerprint !== fingerprint) {
    throw new ApiError("invalid_payload", "the legacy import plan is not prepared");
  }
  if (prepared.owner_actor_id !== owner_actor_id) {
    throw new ApiError("forbidden", "the legacy import plan belongs to another owner");
  }
  const plan: ImportPlan = prepared.plan;

  // A second request with the same source fingerprint returns the first batch.
  // The wrapper normally reaches this through the service's receipt replay (no
  // writes at all); this branch also covers another request key.
  const existing = runtime.db.get<{
    id: string;
    project_id: string;
    state: string;
    owner_user_id: string;
  }>(
    `SELECT b.id AS id, b.project_id AS project_id, b.state AS state, p.owner_user_id AS owner_user_id
       FROM import_batches b JOIN projects p ON p.id = b.project_id
      WHERE b.source_fingerprint = ?`,
    fingerprint,
  );
  if (existing !== undefined) {
    if (existing.owner_user_id !== owner.user_id) {
      throw new ApiError("conflict", "the source is already imported by another owner");
    }
    const state = existing.state === "failed" ? "failed" : "staging";
    const result = {
      batch_id: existing.id,
      project_id: existing.project_id,
      state,
      replayed: true,
      source_fingerprint: fingerprint,
      report: report_unknown(runtime.db, existing.id),
    };
    return {
      result,
      events: [
        {
          type: "legacy.project_imported",
          payload: {
            batch_id: existing.id,
            project_id: existing.project_id,
            state,
            source_fingerprint: fingerprint,
            replayed: true,
          },
        },
      ],
    };
  }

  const objects_dir = runtime.objects_dir;
  if (objects_dir === null) {
    throw new ApiError("conflict", "no object store is configured for legacy.import_project");
  }

  // Round/snapshot rows reference each other; defer foreign-key checks to COMMIT
  // for this transaction only, as stage.reopen does.
  runtime.db.exec("PRAGMA defer_foreign_keys = ON");

  const batch_id = runtime.new_id();
  const project_id = runtime.new_id();
  const edition_id = runtime.new_id();
  const policy_id = runtime.new_id();
  const legacy_actor_id = runtime.new_id();

  let failed = plan.failed;
  let slug = plan.project.slug;
  if (slug === null || slug.trim().length === 0) {
    failed = true;
    slug = `legacy-failed-${batch_id}`;
  } else if (
    runtime.db.get<{ ok: bigint }>("SELECT 1 AS ok FROM projects WHERE slug = ?", slug) !== undefined
  ) {
    failed = true;
    plan.report_entries.push({
      category: "unknown_field",
      path: "project.json",
      key: "/slug",
      detail: "slug_conflict",
    });
    slug = `${slug}-legacy-${batch_id.slice(0, 8)}`;
  }

  const report = { batch_id, entries: plan.report_entries };
  const state: "staging" | "failed" = failed ? "failed" : "staging";
  const result = {
    batch_id,
    project_id,
    state,
    replayed: false,
    source_fingerprint: fingerprint,
    report,
  };

  // Project, owner membership, edition, and six stages.
  runtime.db.run(
    `INSERT INTO projects (id, slug, topic, owner_user_id, status, created_at)
     VALUES (?, ?, ?, ?, 'staging', ?)`,
    project_id,
    slug,
    plan.project.topic,
    owner.user_id,
    plan.project.created_at,
  );
  runtime.db.run(
    "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')",
    project_id,
    owner.user_id,
  );
  const edition_status = failed ? "draft" : plan.edition_status;
  runtime.db.run(
    "INSERT INTO editions (id, project_id, edition_no, status, settings_json) VALUES (?, ?, 1, ?, ?)",
    edition_id,
    project_id,
    edition_status,
    JSON.stringify(plan.edition_settings),
  );
  runtime.db.run(
    "INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, 'legacy_unknown', NULL, ?)",
    legacy_actor_id,
    "옛 작성자",
  );

  const stage_ids = new Map<LegacyStageKey, string>();
  for (const [index, stage_key] of LEGACY_STAGE_KEYS.entries()) {
    const stage_id = runtime.new_id();
    stage_ids.set(stage_key, stage_id);
    runtime.db.run(
      `INSERT INTO stages (id, project_id, edition_id, key, ordinal, status, settings_json)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      stage_id,
      project_id,
      edition_id,
      stage_key,
      index + 1,
      JSON.stringify(plan.stages.find((stage) => stage.key === stage_key)?.settings ?? {}),
    );
  }
  for (const namespace of OBJECT_COUNTER_NAMESPACES) {
    runtime.db.run(
      "INSERT INTO counters (project_id, namespace, next_no) VALUES (?, ?, 1)",
      project_id,
      namespace,
    );
  }

  // The receipt must exist before the policy row references its transaction.
  insert_receipt(runtime, {
    project_id,
    actor_id: owner_actor_id,
    action: "legacy.project_imported",
    base_control_rev: null,
    result,
  });
  runtime.db.run(
    `INSERT INTO project_policy_versions
       (id, project_id, policy_rev, allow_opencode_go, changed_by, changed_by_user_id,
        changed_by_kind, reason, tx_id, created_at)
     VALUES (?, ?, 1, 1, ?, ?, 'human', 'legacy default', ?, ?)`,
    policy_id,
    project_id,
    owner_actor_id,
    owner.user_id,
    runtime.tx_id,
    runtime.now_ms,
  );
  const active_edition_id = failed || plan.project.complete ? null : edition_id;
  const pointer = runtime.db.run(
    "UPDATE projects SET active_edition_id = ?, current_policy_id = ? WHERE id = ?",
    active_edition_id,
    policy_id,
    project_id,
  );
  if (pointer.changes !== 1n) throw new Error("the imported project pointers were not set");

  // Blob storage goes through the PR9 file command definitions (the only module
  // that holds SQL for blobs, file_policies and version_files). They run inside
  // this transaction with a per-command receipt/event; the main import receipt
  // remains the legacy transaction every content row points at.
  let file_command_seq = 0;
  const run_file_command = (name: string, command_payload: unknown): unknown => {
    file_command_seq += 1;
    const file_tx_id = runtime.new_id();
    const file_runtime: CommandRuntime = {
      db: runtime.db,
      ctx: {
        project_id,
        actor_id: owner_actor_id,
        via: "import",
        client_request_id: `legacy-file:${batch_id}:${file_command_seq}`,
      },
      payload: command_payload,
      now_ms: runtime.now_ms,
      tx_id: file_tx_id,
      request_hash: sha256_hex(
        new TextEncoder().encode(`${name}\n${batch_id}\n${file_command_seq}`),
      ),
      new_id: runtime.new_id,
      project: { id: project_id, control_rev: 0n, status: "staging" },
      actor_id: owner_actor_id,
      run_config: runtime.run_config,
      objects_dir,
    };
    const outcome = file_command(name).run(file_runtime);
    write_events(file_runtime, project_id, outcome.events);
    return outcome.result;
  };
  /** The synchronous part of PR9 store_blob: reservation check, then bytes. */
  const store_reserved_bytes = (blob_id: string, bytes: Uint8Array): void => {
    const row = runtime.db.get<{
      storage_key: string;
      state: string;
      sha256: string;
      size: bigint;
    }>(
      "SELECT storage_key, state, sha256, size FROM blobs WHERE project_id = ? AND id = ?",
      project_id,
      blob_id,
    );
    if (row === undefined) throw new ApiError("not_found", "blob not found");
    if (row.state !== "staging") throw new ApiError("conflict", "only a staging blob takes bytes");
    if (bytes.byteLength !== Number(row.size) || sha256_hex(bytes) !== row.sha256) {
      throw new ApiError("invalid_payload", "the bytes do not match the reservation");
    }
    write_storage_bytes(objects_dir, project_id, row.storage_key, bytes);
  };
  const create_blob = (
    key: string,
    bytes: Uint8Array,
    media_type: string,
    original_name: string,
    desired_state: "ready" | "quarantined",
    blob_ids: Map<string, string>,
  ): string => {
    const sha256 = sha256_hex(bytes);
    const size = bytes.byteLength;
    const existing = runtime.db.get<{ id: string; state: string }>(
      "SELECT id, state FROM blobs WHERE project_id = ? AND sha256 = ? AND size = ?",
      project_id,
      sha256,
      size,
    );
    if (existing !== undefined) {
      blob_ids.set(key, existing.id);
      if (desired_state === "quarantined" && existing.state !== "quarantined") {
        run_file_command("file.quarantine", {
          blob_id: existing.id,
          reason: "legacy quarantine",
        });
      }
      return existing.id;
    }
    const reserved = run_file_command("file.reserve_upload", {
      sha256,
      size,
      media_type,
      original_name,
    }) as { blob_id: string; state: string };
    blob_ids.set(key, reserved.blob_id);
    if (reserved.state === "staging") {
      store_reserved_bytes(reserved.blob_id, bytes);
      if (desired_state === "quarantined") {
        run_file_command("file.quarantine", {
          blob_id: reserved.blob_id,
          reason: "legacy quarantine",
        });
      } else {
        run_file_command("file.complete_upload", { blob_id: reserved.blob_id });
      }
    } else if (desired_state === "quarantined" && reserved.state !== "quarantined") {
      run_file_command("file.quarantine", {
        blob_id: reserved.blob_id,
        reason: "legacy quarantine",
      });
    }
    return reserved.blob_id;
  };

  // Blobs: every source file plus the manifest and the report.
  const blob_ids = new Map<string, string>();
  for (const blob of plan.blobs) {
    const bytes = prepared.bytes.get(blob.path);
    if (bytes === undefined) continue;
    create_blob(
      blob.path,
      bytes,
      blob.media_type,
      blob.path.split("/").pop() ?? "file",
      blob.state,
      blob_ids,
    );
  }
  const manifest_bytes = new TextEncoder().encode(
    JSON.stringify({
      format_version: 1,
      source_fingerprint: fingerprint,
      files: plan.manifest_files,
    }),
  );
  const manifest_blob_id = create_blob(
    "@manifest",
    manifest_bytes,
    "application/json",
    "manifest.json",
    "ready",
    blob_ids,
  );
  const report_bytes = new TextEncoder().encode(JSON.stringify(report));
  const report_blob_id = create_blob(
    "@report",
    report_bytes,
    "application/json",
    "report.json",
    "ready",
    blob_ids,
  );

  const batch = runtime.db.run(
    `INSERT INTO import_batches
       (id, project_id, source_fingerprint, source_schema, importer_version,
        source_manifest_blob_id, state, report_blob_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    batch_id,
    project_id,
    fingerprint,
    plan.source_schema,
    plan.importer_version,
    manifest_blob_id,
    state,
    report_blob_id,
  );
  if (batch.changes !== 1n) throw new Error("the import batch was not written");

  // Snapshots and rounds. Round ids are allocated first because a round-scope
  // snapshot references its round and the round references the snapshot.
  const round_ids = new Map<string, string>();
  for (const stage of plan.stages) {
    for (const round of stage.rounds) {
      round_ids.set(`${stage.key}:${round.round_no}`, runtime.new_id());
    }
  }
  const snapshot_ids = new Map<string, string>();
  for (const snapshot of plan.snapshots) {
    const snapshot_id = runtime.new_id();
    let bytes: Uint8Array;
    let manifest_blob_id: string;
    if (snapshot.source.kind === "file") {
      const source_bytes = prepared.bytes.get(snapshot.source.path);
      const blob_id = blob_ids.get(snapshot.source.path);
      if (source_bytes === undefined || blob_id === undefined) {
        throw new Error("a snapshot source file is missing from the plan");
      }
      bytes = source_bytes;
      manifest_blob_id = blob_id;
    } else {
      bytes = new TextEncoder().encode(snapshot.source.json);
      manifest_blob_id = create_blob(
        `@snapshot:${snapshot.key}`,
        bytes,
        "application/json",
        "snapshot.json",
        "ready",
        blob_ids,
      );
    }
    const round_id =
      snapshot.round_key === null ? null : round_ids.get(snapshot.round_key) ?? null;
    runtime.db.run(
      `INSERT INTO snapshots
         (id, project_id, edition_id, stage_id, round_id, scope, manifest_blob_id,
          through_event_seq, control_rev, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)`,
      snapshot_id,
      project_id,
      edition_id,
      stage_ids.get(snapshot.stage_key)!,
      round_id,
      snapshot.scope,
      manifest_blob_id,
      sha256_hex(bytes),
    );
    snapshot_ids.set(snapshot.key, snapshot_id);
  }

  for (const stage of plan.stages) {
    for (const round of stage.rounds) {
      const round_id = round_ids.get(`${stage.key}:${round.round_no}`)!;
      const sealed_snapshot_id =
        round.sealed && round.snapshot_key !== null ? snapshot_ids.get(round.snapshot_key) ?? null : null;
      runtime.db.run(
        `INSERT INTO rounds
           (id, project_id, edition_id, stage_id, round_no, state, base_snapshot_id, sealed_snapshot_id)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
        round_id,
        project_id,
        edition_id,
        stage_ids.get(stage.key)!,
        round.round_no,
        round.sealed ? "sealed" : "open",
        sealed_snapshot_id,
      );
    }
    const open_round = stage.rounds.find((round) => !round.sealed);
    const current_round_id = open_round === undefined ? null : round_ids.get(`${stage.key}:${open_round.round_no}`)!;
    const approved_snapshot_id =
      stage.approval_snapshot_key === null ? null : snapshot_ids.get(stage.approval_snapshot_key) ?? null;
    const stale_seq = stage.stale ? next_event_seq(runtime) : null;
    const updated = runtime.db.run(
      `UPDATE stages
          SET status = ?, current_round_id = ?, approved_snapshot_id = ?, stale_since_event_seq = ?
        WHERE project_id = ? AND id = ?`,
      stage.status,
      current_round_id,
      approved_snapshot_id,
      stale_seq,
      project_id,
      stage_ids.get(stage.key)!,
    );
    if (updated.changes !== 1n) throw new Error("the imported stage was not updated");
  }

  for (const approval of plan.approvals) {
    runtime.db.run(
      `INSERT INTO approvals
         (id, project_id, stage_id, snapshot_id, actor_id, actor_kind, human_user_id,
          origin, assurance, tx_id, note)
       VALUES (?, ?, ?, ?, ?, 'legacy_unknown', NULL, 'legacy', 'legacy_unverified', ?, ?)`,
      runtime.new_id(),
      project_id,
      stage_ids.get(approval.stage_key)!,
      snapshot_ids.get(approval.snapshot_key)!,
      legacy_actor_id,
      runtime.tx_id,
      approval.note,
    );
  }

  const current_stage_id =
    plan.project.current_stage_key === null ? null : stage_ids.get(plan.project.current_stage_key)!;
  const edition_pointer = runtime.db.run(
    "UPDATE editions SET current_stage_id = ? WHERE project_id = ? AND id = ?",
    current_stage_id,
    project_id,
    edition_id,
  );
  if (edition_pointer.changes !== 1n) throw new Error("the imported edition pointer was not set");

  // Objects and their versions. Questions come before answers, threads before
  // messages, artifacts before follow-ups: the plan already has that order.
  const object_ids = new Map<string, string>();
  const version_ids = new Map<string, string>();

  function insert_object(row: PlanObjectRow): void {
    const object_id = runtime.new_id();
    const version_id = runtime.new_id();
    object_ids.set(row.key, object_id);
    version_ids.set(row.version.key, version_id);
    const display_no = take_display_no(runtime, project_id, row.kind);
    runtime.db.run(
      `INSERT INTO objects (id, project_id, edition_id, kind, display_no, archived_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      object_id,
      project_id,
      row.edition === "edition" ? edition_id : null,
      row.kind,
      display_no,
      row.archived ? runtime.now_ms : null,
    );
    const created_in_round_id =
      row.version.created_in_round_key === null
        ? null
        : round_ids.get(row.version.created_in_round_key) ?? null;
    runtime.db.run(
      `INSERT INTO object_versions
         (id, project_id, object_id, kind, version_no, based_on_version_id, created_in_round_id,
          actor_id, run_id, tx_id, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)`,
      version_id,
      project_id,
      object_id,
      row.kind,
      row.version.version_no,
      created_in_round_id,
      legacy_actor_id,
      runtime.tx_id,
      row.version.content_hash,
      row.version.created_at,
    );
    runtime.db.run(
      "UPDATE objects SET current_version_id = ? WHERE project_id = ? AND id = ?",
      version_id,
      project_id,
      object_id,
    );

    if (row.artifact !== undefined) {
      const artifact = row.artifact;
      runtime.db.run(
        "INSERT INTO artifacts (project_id, object_id, kind, stage_id) VALUES (?, ?, ?, ?)",
        project_id,
        object_id,
        artifact.artifact_kind,
        artifact.stage_key === null ? null : stage_ids.get(artifact.stage_key)!,
      );
      runtime.db.run(
        `INSERT INTO artifact_versions
           (project_id, version_id, object_id, object_kind, title, question, summary, body_md,
            body_blob_id, status, confidence, stats, conflicts, verify, metadata_json)
         VALUES (?, ?, ?, 'artifact', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        project_id,
        version_id,
        object_id,
        artifact.title,
        artifact.question,
        artifact.summary,
        artifact.body_md,
        artifact.status,
        artifact.confidence,
        JSON.stringify(artifact.stats),
        JSON.stringify(artifact.conflicts),
        JSON.stringify(artifact.verify),
        JSON.stringify(artifact.metadata),
      );
    } else if (row.source !== undefined) {
      const source = row.source;
      runtime.db.run(
        "INSERT INTO sources (project_id, object_id, kind, canonical_locator) VALUES (?, ?, ?, ?)",
        project_id,
        object_id,
        source.source_kind,
        source.canonical_locator,
      );
      runtime.db.run(
        `INSERT INTO source_versions
           (project_id, version_id, object_id, object_kind, title, url, locator, retrieved_at,
            method, verification_state, quote, evidence_blob_id, verified_by_actor_id)
         VALUES (?, ?, ?, 'source', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
        project_id,
        version_id,
        object_id,
        source.title,
        source.url,
        JSON.stringify(source.locator),
        source.retrieved_at,
        source.method,
        source.verification_state,
      );
    } else if (row.question !== undefined) {
      const question = row.question;
      runtime.db.run(
        `INSERT INTO question_versions
           (project_id, version_id, object_id, object_kind, text, type, state, importance,
            required, allow_comment_as_answer, default_value, options, show_if, help)
         VALUES (?, ?, ?, 'question', ?, ?, ?, 'normal', ?, ?, ?, ?, ?, ?)`,
        project_id,
        version_id,
        object_id,
        question.text,
        question.type,
        question.state,
        question.required ? 1 : 0,
        question.allow_comment_as_answer ? 1 : 0,
        JSON.stringify(question.default_value),
        JSON.stringify(question.options),
        JSON.stringify(question.show_if),
        question.help,
      );
      runtime.db.run(
        `INSERT INTO questions
           (project_id, object_id, asked_by_actor_id, intended_actor_id, direction, origin,
            bank_key, original_version_id)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
        project_id,
        object_id,
        legacy_actor_id,
        question.direction,
        question.origin,
        question.bank_key,
        version_id,
      );
    } else if (row.answer !== undefined) {
      const answer = row.answer;
      const question_id = object_ids.get(answer.question_key);
      const submission_id = submission_ids.get(answer.submission_key);
      const question_version_id = version_ids.get(answer.question_version_key);
      if (question_id === undefined || submission_id === undefined || question_version_id === undefined) {
        throw new Error("an imported answer is missing its question or submission");
      }
      runtime.db.run(
        `INSERT INTO answers (project_id, object_id, question_id, respondent_actor_id, submission_id)
         VALUES (?, ?, ?, ?, ?)`,
        project_id,
        object_id,
        question_id,
        legacy_actor_id,
        submission_id,
      );
      runtime.db.run(
        `INSERT INTO answer_versions
           (project_id, version_id, object_id, object_kind, question_id, question_version_id,
            value, state, used_default, supersedes_version_id)
         VALUES (?, ?, ?, 'answer', ?, ?, ?, 'submitted', NULL, NULL)`,
        project_id,
        version_id,
        object_id,
        question_id,
        question_version_id,
        JSON.stringify(answer.value),
      );
    } else if (row.thread !== undefined) {
      const thread = row.thread;
      const target_object_id = object_ids.get(thread.target_object_key);
      const target_version_id =
        thread.target_version_key === null ? null : version_ids.get(thread.target_version_key) ?? null;
      if (target_object_id === undefined) throw new Error("an imported thread target is missing");
      runtime.db.run(
        `INSERT INTO threads
           (project_id, object_id, target_object_id, target_version_id, context_kind, anchor_id)
         VALUES (?, ?, ?, ?, ?, NULL)`,
        project_id,
        object_id,
        target_object_id,
        target_version_id,
        thread.context_kind,
      );
    } else if (row.message !== undefined) {
      const message = row.message;
      const thread_id = object_ids.get(message.thread_key);
      const submission_id =
        message.submission_key === null ? null : submission_ids.get(message.submission_key) ?? null;
      if (thread_id === undefined) throw new Error("an imported message thread is missing");
      runtime.db.run(
        `INSERT INTO messages (project_id, object_id, thread_id, reply_to, submission_id)
         VALUES (?, ?, ?, NULL, ?)`,
        project_id,
        object_id,
        thread_id,
        submission_id,
      );
      runtime.db.run(
        `INSERT INTO message_versions
           (project_id, version_id, object_id, thread_id, body_md, state)
         VALUES (?, ?, ?, ?, ?, 'published')`,
        project_id,
        version_id,
        object_id,
        thread_id,
        message.body_md,
      );
    } else if (row.followup !== undefined) {
      const followup = row.followup;
      const base_version_id =
        followup.base_version_key === null ? null : version_ids.get(followup.base_version_key) ?? null;
      runtime.db.run(
        "INSERT INTO followups (project_id, object_id) VALUES (?, ?)",
        project_id,
        object_id,
      );
      runtime.db.run(
        `INSERT INTO followup_versions
           (project_id, version_id, object_id, object_kind, kind, state, description,
            target_stage_id, target_round_id, base_artifact_version_id)
         VALUES (?, ?, ?, 'followup', ?, ?, ?, ?, NULL, ?)`,
        project_id,
        version_id,
        object_id,
        followup.kind,
        followup.state,
        followup.description,
        followup.target_stage_key === null ? null : stage_ids.get(followup.target_stage_key) ?? null,
        base_version_id,
      );
    }
  }

  // Phase A: artifacts, sources, questions, threads and follow-ups.
  for (const row of plan.objects) {
    if (row.kind === "answer" || row.kind === "message") continue;
    insert_object(row);
  }

  // Question sets (they need the question versions inserted above).
  const set_ids = new Map<string, string>();
  for (const set of plan.question_sets) {
    const set_id = runtime.new_id();
    set_ids.set(set.key, set_id);
    runtime.db.run(
      `INSERT INTO question_sets
         (id, project_id, stage_id, round_id, purpose, form_key, version_no,
          previous_set_id, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      set_id,
      project_id,
      stage_ids.get(set.stage_key)!,
      set.round_key === null ? null : round_ids.get(set.round_key) ?? null,
      set.purpose,
      set.form_key,
      set.version_no,
      set.published_at,
    );
    for (const member of set.members) {
      const question_id = object_ids.get(member.question_key);
      const question_version_id = version_ids.get(member.question_version_key);
      if (question_id === undefined || question_version_id === undefined) {
        throw new Error("an imported question set member is missing");
      }
      runtime.db.run(
        `INSERT INTO question_set_members
           (project_id, set_id, question_id, question_version_id, position)
         VALUES (?, ?, ?, ?, ?)`,
        project_id,
        set_id,
        question_id,
        question_version_id,
        member.position,
      );
    }
  }

  // Submissions (they need the raw blobs and may point at a question set).
  const submission_ids = new Map<string, string>();
  for (const submission of plan.submissions) {
    const raw_blob_id = blob_ids.get(submission.raw_blob_path);
    if (raw_blob_id === undefined) continue;
    const submission_id = runtime.new_id();
    submission_ids.set(submission.key, submission_id);
    runtime.db.run(
      `INSERT INTO submissions
         (id, project_id, actor_id, drafted_by_actor_id, set_id, received_at, via,
          raw_blob_id, tx_id)
       VALUES (?, ?, ?, NULL, ?, ?, 'import', ?, ?)`,
      submission_id,
      project_id,
      legacy_actor_id,
      submission.set_key === null ? null : set_ids.get(submission.set_key) ?? null,
      submission.received_at,
      raw_blob_id,
      runtime.tx_id,
    );
  }

  // Phase B: answers and messages.
  for (const row of plan.objects) {
    if (row.kind !== "answer" && row.kind !== "message") continue;
    insert_object(row);
  }

  for (const relation of plan.relations) {
    const from_version_id = version_ids.get(relation.from_version_key);
    const to_version_id = version_ids.get(relation.to_version_key);
    if (from_version_id === undefined || to_version_id === undefined) {
      throw new Error("an imported relation target is missing");
    }
    runtime.db.run(
      `INSERT INTO version_relations (project_id, from_version_id, to_version_id, kind)
       VALUES (?, ?, ?, ?)`,
      project_id,
      from_version_id,
      to_version_id,
      relation.kind,
    );
  }

  // Citations and attached files.
  for (const citation of plan.citations) {
    const artifact_version_id = version_ids.get(citation.artifact_version_key);
    const source_version_id = version_ids.get(citation.source_version_key);
    if (artifact_version_id === undefined || source_version_id === undefined) {
      throw new Error("an imported citation target is missing");
    }
    runtime.db.run(
      `INSERT INTO citations
         (project_id, artifact_version_id, citation_no, source_version_id, quote, locator)
       VALUES (?, ?, ?, ?, ?, ?)`,
      project_id,
      artifact_version_id,
      citation.citation_no,
      source_version_id,
      citation.quote,
      JSON.stringify(citation.locator),
    );
  }

  for (const file of plan.version_files) {
    const version_id = version_ids.get(file.version_key);
    const blob_id = blob_ids.get(file.blob_path);
    if (version_id === undefined || blob_id === undefined) {
      throw new Error("an imported version file is missing");
    }
    run_file_command("file.attach_version", {
      version_id,
      blob_id,
      role: file.role,
    });
  }

  // Legacy mappings last: every referenced new row now exists.
  for (const mapping of plan.mappings) {
    const object_id = mapping.object_key === null ? null : object_ids.get(mapping.object_key) ?? null;
    const version_id =
      mapping.version_key === null ? null : version_ids.get(mapping.version_key) ?? null;
    let new_row_id: string | null = null;
    if (mapping.row !== null) {
      if (mapping.row.kind === "blob") {
        new_row_id = blob_ids.get(mapping.row.path) ?? null;
      } else if (mapping.row.kind === "submission") {
        new_row_id = submission_ids.get(mapping.row.key) ?? null;
      } else {
        new_row_id = snapshot_ids.get(mapping.row.key) ?? null;
      }
    }
    if (object_id === null && new_row_id === null) continue;
    runtime.db.run(
      `INSERT INTO legacy_mappings
         (project_id, import_batch_id, legacy_kind, legacy_scope, legacy_key,
          content_hash, new_object_id, new_version_id, new_row_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      project_id,
      batch_id,
      mapping.kind,
      mapping.scope,
      mapping.key,
      mapping.content_hash,
      object_id,
      object_id === null ? null : version_id,
      new_row_id,
    );
  }

  return {
    result,
    events: [
      {
        type: "legacy.project_imported",
        payload: {
          batch_id,
          project_id,
          state,
          source_fingerprint: fingerprint,
          replayed: false,
        },
      },
      ...plan.events,
    ],
  };
}

const LEGACY_IMPORT_COMMAND: CommandDefinition = Object.freeze({
  action: "legacy.project_imported",
  scope: "owner",
  rev_bearing: false,
  run: run_import_project,
});

const LEGACY_COMMAND_INPUTS: ReadonlyArray<readonly [string, CommandDefinition]> = [
  ["legacy.import_project", LEGACY_IMPORT_COMMAND],
];

/** Registry entries merged into COMMANDS by commands.ts (names, not actions). */
export const LEGACY_COMMAND_ENTRIES: ReadonlyArray<readonly [string, CommandDefinition]> =
  Object.freeze(LEGACY_COMMAND_INPUTS.map((entry) => Object.freeze([entry[0], entry[1]] as const)));

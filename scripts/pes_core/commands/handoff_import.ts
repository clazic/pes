// Owner import of a pasted result for an explicit hand-off (stage 2 PR20a, SEL-53).
//
// Method B with an AI app that has no connection to PES (the Claude app) works by an explicit hand-off:
// the human copies a bundle out, the app answers in its own window, and the human pastes the answer back.
// That pasted text is not an agent's write. It is the human owner's, recorded as an import:
//
//   - one transaction creates the owner's own hand-off run (runtime claude_app_handoff, model unknown),
//     appends the pasted results and ends the run as succeeded;
//   - the run, the receipt and the versions all belong to the owner (a human actor); the receipt's via is
//     'import', and the events carry the provenance (claimed tool/model, verified:false);
//   - there is no agent claim, no lease, no fence. The owner can only import into a run this very command
//     creates, so the owner never writes into someone else's run;
//   - the generic results route stays agents-only.
//
// This is a branch of the closed `run.create` command (a payload with an `import` object), not a new command:
// the registry and the HTTP route table stay as they were. The branch is reachable only with via 'import'.

import { ApiError } from "../errors.ts";
import { parse_result_items, plan_result_items, write_append_plan } from "./content.ts";
import {
  insert_receipt,
  is_record,
  reject_unknown_fields,
  require_base_control_rev,
  require_human_owner_actor,
  require_non_empty_string,
  require_record,
  type CommandResult,
  type CommandRuntime,
} from "./shared.ts";

export const HANDOFF_RUNTIME = "claude_app_handoff";
export const HANDOFF_PROVIDER = "anthropic";
export const HANDOFF_MODEL = "unknown";

const IMPORT_FIELDS = ["results", "request_id", "stage_id", "round_id", "claimed_tool", "claimed_model", "expected_heads"] as const;
const MAX_CLAIM_CHARS = 200;
/**
 * The most object heads one bundle may pin. One entry is about 105 bytes of JSON, so 1000 are about 105 KB: they leave
 * room for the results inside the 256 KiB request body limit. A bigger list would end in payload_too_large anyway.
 */
export const MAX_EXPECTED_HEADS = 1000;

/**
 * The heads the bundle was copied from ({object_id, version_id} for each object it covers). Absent is null.
 * They are compared with the current heads in the import's own transaction, so a head that moved after the
 * adapter's last read still stops the import before anything is written.
 */
function expected_heads(source: Record<string, unknown>): Array<{ object_id: string; version_id: string }> | null {
  const value = source.expected_heads;
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_EXPECTED_HEADS) {
    throw new ApiError("invalid_payload", `expected_heads must be an array of at most ${MAX_EXPECTED_HEADS} {object_id, version_id}`);
  }
  const seen = new Set<string>();
  const heads: Array<{ object_id: string; version_id: string }> = [];
  for (const entry of value) {
    if (
      !is_record(entry) ||
      Object.keys(entry).length !== 2 ||
      typeof entry.object_id !== "string" ||
      entry.object_id.length === 0 ||
      !entry.object_id.isWellFormed() ||
      typeof entry.version_id !== "string" ||
      entry.version_id.length === 0 ||
      !entry.version_id.isWellFormed()
    ) {
      throw new ApiError("invalid_payload", "each expected_heads entry must be {object_id, version_id}");
    }
    if (seen.has(entry.object_id)) {
      throw new ApiError("invalid_payload", "expected_heads may name each object only once");
    }
    seen.add(entry.object_id);
    heads.push({ object_id: entry.object_id, version_id: entry.version_id });
  }
  return heads;
}

/** A text the pasted result claims about itself. It is stored as a claim, never trusted. */
function optional_claim(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CLAIM_CHARS || !value.isWellFormed()) {
    throw new ApiError("invalid_payload", `${field} must be a short well-formed string`);
  }
  return value;
}

export function run_import_handoff(runtime: CommandRuntime): CommandResult {
  const project = runtime.project;
  const actor_id = runtime.actor_id;
  if (project === null || actor_id === null) {
    throw new Error("a run command must resolve a project and actor first");
  }
  if (runtime.ctx.via !== "import") {
    throw new ApiError("forbidden", "a hand-off import is accepted only through the import path");
  }
  require_human_owner_actor(runtime);
  const payload = require_record(runtime.payload);
  reject_unknown_fields(payload, ["import"]);
  const source = payload.import;
  if (!is_record(source)) {
    throw new ApiError("invalid_payload", "import must be a JSON object");
  }
  reject_unknown_fields(source, IMPORT_FIELDS);

  const request_id = require_non_empty_string(source, "request_id");
  // The import's idempotency key is the bundle's own request id: no other key can bring the same bundle in twice.
  if (runtime.ctx.client_request_id !== `import-${request_id}`) {
    throw new ApiError("invalid_payload", "the import must use the idempotency key import-<request_id>");
  }
  const claimed_tool = optional_claim(source, "claimed_tool");
  const claimed_model = optional_claim(source, "claimed_model");
  const items = parse_result_items(source.results);
  // One bundle names an object once: two versions of one object in a single paste would chain on each other.
  const seen_objects = new Set<unknown>();
  for (const item of items) {
    if (seen_objects.has(item.object_id)) {
      throw new ApiError("invalid_payload", "a hand-off import may name each object only once");
    }
    seen_objects.add(item.object_id);
  }

  // A stale copy never reaches a write: the base is checked in this transaction.
  const base = require_base_control_rev(runtime, runtime.ctx.base_control_rev);

  // The object heads the bundle was copied from, checked in the same transaction as the write. Moving a head
  // (content.set_current) does not change control_rev, so the control_rev check alone cannot see it.
  const heads = expected_heads(source);
  if (heads !== null) {
    for (const head of heads) {
      const row = runtime.db.get<{ current_version_id: string | null; archived_at: unknown }>(
        "SELECT current_version_id, archived_at FROM objects WHERE project_id = ? AND id = ?",
        project.id,
        head.object_id,
      );
      if (row === undefined || row.archived_at !== null || row.current_version_id !== head.version_id) {
        throw new ApiError("rev_conflict", "an object's current version changed after the bundle was copied", {
          object_id: head.object_id,
        });
      }
    }
  }

  const edition = runtime.db.get<{ active_edition_id: string | null }>(
    "SELECT active_edition_id FROM projects WHERE id = ?",
    project.id,
  );
  if (edition === undefined || edition.active_edition_id === null) {
    throw new ApiError("conflict", "the project has no active edition");
  }

  let stage_id: string | null = null;
  let round_id: string | null = null;
  let stage_current_round: string | null = null;
  if (source.stage_id !== undefined && source.stage_id !== null) {
    stage_id = require_non_empty_string(source, "stage_id");
    const stage = runtime.db.get<{ id: string; status: string; current_round_id: string | null }>(
      "SELECT id, status, current_round_id FROM stages WHERE project_id = ? AND edition_id = ? AND id = ?",
      project.id,
      edition.active_edition_id,
      stage_id,
    );
    if (stage === undefined) throw new ApiError("not_found", "the stage is not part of the active edition");
    // Approval is a human decision: an import never writes into an approved stage (reopen it first).
    if (stage.status === "approved") {
      throw new ApiError("conflict", "the stage is approved; reopen it before importing a result");
    }
    stage_current_round = stage.current_round_id;
  }
  if (source.round_id !== undefined && source.round_id !== null) {
    if (stage_id === null) throw new ApiError("invalid_payload", "round_id needs stage_id");
    round_id = require_non_empty_string(source, "round_id");
    const round = runtime.db.get<{ id: string; state: string }>(
      "SELECT id, state FROM rounds WHERE project_id = ? AND stage_id = ? AND id = ?",
      project.id,
      stage_id,
      round_id,
    );
    if (round === undefined) throw new ApiError("not_found", "the round does not belong to the stage");
    // Sealing is a human decision: a sealed round takes no import.
    if (round.state !== "open") {
      throw new ApiError("conflict", "the round is sealed; an import cannot write into it");
    }
  } else if (stage_current_round !== null) {
    const current = runtime.db.get<{ state: string }>(
      "SELECT state FROM rounds WHERE project_id = ? AND stage_id = ? AND id = ?",
      project.id,
      stage_id,
      stage_current_round,
    );
    if (current !== undefined && current.state !== "open") {
      throw new ApiError("conflict", "the stage's round is sealed; an import cannot write into it");
    }
  }

  const plans = plan_result_items(runtime, items);

  const run_id = runtime.new_id();
  const written = runtime.db.run(
    `INSERT INTO runs
       (id, project_id, edition_id, stage_id, round_id, actor_id, mode, runtime, provider, model, role,
        status, parent_run_id, base_control_rev, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, 'B', ?, ?, ?, 'worker', 'succeeded', NULL, ?, ?, ?)`,
    run_id,
    project.id,
    edition.active_edition_id,
    stage_id,
    round_id,
    actor_id,
    HANDOFF_RUNTIME,
    HANDOFF_PROVIDER,
    HANDOFF_MODEL,
    project.control_rev,
    runtime.now_ms,
    runtime.now_ms,
  );
  if (written.changes !== 1n) {
    throw new Error("the hand-off run was not created");
  }

  const provenance = {
    source: "manual_import",
    claimed_tool,
    claimed_model,
    verified: false,
  };
  const results = plans.map((plan) => ({
    object_id: plan.object_id,
    version_id: plan.version_id,
    version_no: plan.version_no,
  }));
  const result = {
    project_id: project.id,
    run_id,
    actor_id,
    status: "succeeded",
    via: "import",
    adopted_by: actor_id,
    request_id,
    results,
    provenance,
  };
  // The owner is both the run's actor and the receipt's actor, so the receipt may name the run. There is no
  // lease and no fence: nothing here was ever claimed.
  insert_receipt(runtime, {
    project_id: project.id,
    actor_id,
    action: "run.created",
    base_control_rev: base ?? null,
    run_id,
    result,
  });
  for (const plan of plans) {
    write_append_plan(runtime, plan, actor_id, run_id);
  }
  return {
    result,
    events: [
      {
        type: "run.created",
        run_id,
        payload: { run_id, actor_id, mode: "B", runtime: HANDOFF_RUNTIME, via: "import", request_id },
      },
      ...plans.map((plan) => ({
        type: "result.submitted",
        run_id,
        payload: {
          object_id: plan.object_id,
          version_id: plan.version_id,
          version_no: plan.version_no,
          kind: plan.kind,
          via: "import",
          provenance,
        },
      })),
      {
        type: "run.completed",
        run_id,
        payload: { status: "succeeded", via: "import" },
      },
    ],
  };
}

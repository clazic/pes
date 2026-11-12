// The tools the built-in runner offers a model (stage 2 PR19): a closed allowlist of PES commands.
//
// There is no file, shell or network tool, and the list is frozen. Whatever a model asks for that is not on it
// is answered with an error and nothing else happens. The model never supplies a run id, lease or fence: the
// runner adds them, so a model cannot write under someone else's lease.

import type { CommandService, MutationContext } from "../commands.ts";
import type { Db } from "../db.ts";
import { ApiError } from "../errors.ts";
import type { ToolCall, ToolResult, ToolSpec } from "./formats.ts";

export const A_TOOL_ALLOWLIST: readonly string[] = Object.freeze([
  "context.get",
  "result.submit",
  "question.ask",
  "assumption.propose",
  "decision.propose",
  "reflection.write",
  "thread.reply",
  "followup.propose",
]);

const TEXT_ARG = {
  type: "object",
  properties: { title: { type: "string" }, text: { type: "string" } },
  required: ["text"],
};

export const TOOL_SPECS: readonly ToolSpec[] = Object.freeze([
  { name: "context.get", description: "Read the project, stage, round, current objects and questions.", parameters: { type: "object", properties: {} } },
  {
    name: "result.submit",
    description: "Append new versions to existing artifact objects. Each item: op=append_version, object_id, title, summary, body_md.",
    parameters: {
      type: "object",
      properties: { results: { type: "array", items: { type: "object", properties: { op: { type: "string" }, object_id: { type: "string" }, title: { type: "string" } }, required: ["op", "object_id"] } } },
      required: ["results"],
    },
  },
  {
    name: "question.ask",
    description: "Ask the person questions and wait for the answers. Each question: text, type, required, options.",
    parameters: { type: "object", properties: { questions: { type: "array", items: { type: "object" } } }, required: ["questions"] },
  },
  { name: "assumption.propose", description: "Propose an assumption for a person to review.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  {
    name: "decision.propose",
    description: "Propose a decision. Only a person adopts.",
    parameters: { type: "object", properties: { text: { type: "string" }, scope: { type: "string", enum: ["project", "edition"] } }, required: ["text"] },
  },
  {
    name: "reflection.write",
    description:
      "Write the round reflection. Entry: source_version_id, disposition, rationale; applied/partial add result_version_id, evidence_tx_id.",
    parameters: { type: "object", properties: { entries: { type: "array", items: { type: "object" } } }, required: ["entries"] },
  },
  // thread.reply stays on the allowlist above (decision 0013) but is NOT offered to a model yet: no PES command backs
  // it, so every call would only come back as an error and waste a turn. Add its spec here when the command exists.
  { name: "followup.propose", description: "Propose a follow-up task for a person.", parameters: TEXT_ARG },
]);

const RESULT_TEXT_MAX = 4000;
const NOTE_LABEL: Record<string, string> = {
  "followup.propose": "[AI 제안: 후속 작업]",
};

export interface RunHandle {
  project_id: string;
  actor_id: string;
  run_id: string;
  lease_id: string;
  fence: number;
  stage_id: string | null;
  round_id: string | null;
}

export interface ToolEnv {
  service: CommandService;
  db: Db;
  run: RunHandle;
  /** Prefix of every client_request_id this call's tools use (unique per model call). */
  request_key: string;
  save_retries: number;
}

export type ToolEffect =
  | { kind: "none" }
  | { kind: "wait"; question_set_id: string }
  | { kind: "version"; version_id: string };

export interface ToolOutcome {
  result: ToolResult;
  effect: ToolEffect;
}

/** The answer could not be saved after every retry; the model call it came from must be kept as unknown. */
export class SaveFailedError extends Error {
  override name = "SaveFailedError";
  constructor() {
    super("the answer could not be saved");
  }
}

function clip(text: string): string {
  return text.length > RESULT_TEXT_MAX ? `${text.slice(0, RESULT_TEXT_MAX)}…` : text;
}

function ok(call: ToolCall, body: unknown, effect: ToolEffect = { kind: "none" }): ToolOutcome {
  return { result: { call_id: call.id, name: call.name, content: clip(JSON.stringify({ ok: true, ...(body as object) })), is_error: false }, effect };
}

function refused(call: ToolCall, message: string): ToolOutcome {
  return { result: { call_id: call.id, name: call.name, content: clip(JSON.stringify({ ok: false, error: message })), is_error: true }, effect: { kind: "none" } };
}

function ctx_of(env: ToolEnv, key: string): MutationContext {
  return { project_id: env.run.project_id, actor_id: env.run.actor_id, via: "cli", client_request_id: key };
}

function args_record(call: ToolCall): Record<string, unknown> | null {
  const args = call.args;
  return args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// context.get

interface ObjectRow {
  object_id: string;
  version_id: string;
  title: string;
  summary: string;
}

interface QuestionRow {
  set_id: string;
  question_id: string;
  text: string;
  type: string;
}

/** What the model may know about the work, as plain JSON text (bounded). */
export function build_context(db: Pick<Db, "get" | "all">, run: RunHandle): Record<string, unknown> {
  const project = db.get<{ topic: string }>("SELECT topic FROM projects WHERE id = ?", run.project_id);
  const stage =
    run.stage_id === null
      ? undefined
      : db.get<{ key: string; edition_id: string }>("SELECT key, edition_id FROM stages WHERE project_id = ? AND id = ?", run.project_id, run.stage_id);
  const round =
    run.round_id === null
      ? undefined
      : db.get<{ round_no: bigint }>("SELECT round_no FROM rounds WHERE project_id = ? AND id = ?", run.project_id, run.round_id);
  const objects =
    stage === undefined
      ? []
      : db.all<ObjectRow>(
          `SELECT o.id AS object_id, o.current_version_id AS version_id, av.title AS title, substr(av.summary, 1, 300) AS summary
             FROM objects o
             JOIN artifact_versions av ON av.project_id = o.project_id AND av.version_id = o.current_version_id
            WHERE o.project_id = ? AND o.edition_id = ? AND o.kind = 'artifact' AND o.archived_at IS NULL
            ORDER BY o.display_no LIMIT 30`,
          run.project_id,
          stage.edition_id,
        );
  return {
    topic: project?.topic ?? null,
    stage: stage?.key ?? null,
    round_no: round === undefined ? null : Number(round.round_no),
    objects: objects.map((row) => ({ object_id: row.object_id, version_id: row.version_id, title: row.title, summary: row.summary })),
    questions: question_context(db, run),
  };
}

/** Questions of this stage/round with the people's answers (what a resumed run must see again). */
export function question_context(db: Pick<Db, "get" | "all">, run: RunHandle): Array<Record<string, unknown>> {
  if (run.stage_id === null) return [];
  const rows = db.all<QuestionRow>(
    `SELECT qs.id AS set_id, m.question_id AS question_id, qv.text AS text, qv.type AS type
       FROM question_sets qs
       JOIN question_set_members m ON m.project_id = qs.project_id AND m.set_id = qs.id
       JOIN question_versions qv ON qv.project_id = m.project_id AND qv.object_id = m.question_id AND qv.version_id = m.question_version_id
      WHERE qs.project_id = ? AND qs.stage_id = ? AND ${run.round_id === null ? "qs.round_id IS NULL" : "qs.round_id = ?"}
      ORDER BY qs.published_at, qs.rowid, m.position LIMIT 40`,
    ...(run.round_id === null ? [run.project_id, run.stage_id] : [run.project_id, run.stage_id, run.round_id]),
  );
  return rows.map((row) => {
    const answer = db.get<{ value: string; state: string }>(
      `SELECT av.value AS value, av.state AS state
         FROM answers a
         JOIN objects ao ON ao.project_id = a.project_id AND ao.id = a.object_id
         JOIN answer_versions av ON av.project_id = a.project_id AND av.version_id = ao.current_version_id
        WHERE a.project_id = ? AND a.question_id = ?`,
      run.project_id,
      row.question_id,
    );
    return {
      question_id: row.question_id,
      text: row.text,
      type: row.type,
      answer: answer === undefined ? null : { state: answer.state, value: JSON.parse(answer.value) as unknown },
    };
  });
}

// ---------------------------------------------------------------------------
// the tool runner

async function execute_with_retries(env: ToolEnv, command: string, key: string, payload: unknown): Promise<unknown> {
  let attempt = 0;
  for (;;) {
    try {
      const outcome = await env.service.execute(ctx_of(env, key), command, payload);
      return outcome.result;
    } catch (error) {
      // A PES refusal is the answer (the model is told); only an unexpected failure is retried, with the same
      // request key so a retry can never write twice.
      if (error instanceof ApiError) throw error;
      attempt += 1;
      if (attempt > env.save_retries) throw new SaveFailedError();
    }
  }
}

function note_text(call: ToolCall, args: Record<string, unknown>): string | null {
  const text = args["text"];
  if (typeof text !== "string" || text.trim().length === 0) return null;
  const title = typeof args["title"] === "string" && args["title"].trim().length > 0 ? `${args["title"].trim()}\n` : "";
  return `${NOTE_LABEL[call.name] ?? ""}\n${title}${text.trim()}`.slice(0, 8000);
}

/**
 * Run one tool call. A name outside the allowlist, bad arguments or a PES refusal come back as an error result
 * for the model; the loop goes on. Only an unsaveable answer throws (SaveFailedError).
 */
export async function run_tool(env: ToolEnv, call: ToolCall, index: number): Promise<ToolOutcome> {
  if (!A_TOOL_ALLOWLIST.includes(call.name)) return refused(call, "this tool is not available");
  if (call.args_error !== undefined) return refused(call, call.args_error);
  const args = args_record(call);
  if (args === null) return refused(call, "the arguments must be a JSON object");
  const key = `${env.request_key}:tool:${index}`;

  try {
    switch (call.name) {
      case "context.get":
        return ok(call, { context: build_context(env.db, env.run) });
      case "result.submit": {
        const results = args["results"];
        if (!Array.isArray(results)) return refused(call, "results must be an array");
        const out = (await execute_with_retries(env, "result.submit", key, {
          run_id: env.run.run_id,
          lease_id: env.run.lease_id,
          fence: env.run.fence,
          results,
        })) as { results: Array<{ object_id: string; version_id: string; version_no: number }> };
        const first = out.results[0];
        return ok(call, { versions: out.results }, first === undefined ? { kind: "none" } : { kind: "version", version_id: first.version_id });
      }
      case "question.ask": {
        const questions = args["questions"];
        if (!Array.isArray(questions) || env.run.stage_id === null) return refused(call, "questions must be a non-empty array");
        const out = (await execute_with_retries(env, "question.publish_set", key, {
          stage_id: env.run.stage_id,
          round_id: env.run.round_id,
          purpose: "review",
          form_key: `ai-${env.run.run_id}`,
          questions,
          run_id: env.run.run_id,
          lease_id: env.run.lease_id,
          fence: env.run.fence,
        })) as { set_id: string };
        return ok(call, { question_set_id: out.set_id, note: "waiting for a person to answer" }, { kind: "wait", question_set_id: out.set_id });
      }
      case "thread.reply":
        return refused(call, "thread.reply is not connected to a PES command in this version");
      case "assumption.propose": {
        const text = args["text"];
        if (typeof text !== "string" || text.trim().length === 0) return refused(call, "text must be a non-empty string");
        if (env.run.stage_id === null) throw new ApiError("not_found", "this run has no stage");
        const out = (await execute_with_retries(env, "assumption.propose", key, { statement: text.trim() })) as { object_id: string; version_id: string };
        return ok(call, { recorded_as: out.object_id, id: out.object_id, version_id: out.version_id, state: "proposed", note: "a person must confirm it" });
      }
      case "decision.propose": {
        const text = args["text"];
        if (typeof text !== "string" || text.trim().length === 0) return refused(call, "text must be a non-empty string");
        if (env.run.stage_id === null) throw new ApiError("not_found", "this run has no stage");
        const scope = args["scope"] === undefined ? "edition" : args["scope"];
        if (scope !== "project" && scope !== "edition") return refused(call, "scope must be project or edition");
        const out = (await execute_with_retries(env, "decision.propose", key, { statement: text.trim(), scope })) as { object_id: string; version_id: string };
        return ok(call, { recorded_as: out.object_id, id: out.object_id, version_id: out.version_id, state: "proposed", note: "a person must adopt it" });
      }
      case "reflection.write": {
        if (env.run.stage_id === null) throw new ApiError("not_found", "this run has no stage");
        const entries = args["entries"];
        if (!Array.isArray(entries)) return refused(call, "entries must be an array");
        // the reflection belongs to this run's own round; the tool has no round argument (naming another round is refused)
        const target = env.run.round_id;
        if (target === null) return refused(call, "this run has no round");
        if (args["target_round_id"] !== undefined && args["target_round_id"] !== target) {
          return refused(call, "the reflection is written to this run's round; leave target_round_id out");
        }
        const out = (await execute_with_retries(env, "reflection.create", key, { target_round_id: target, entries })) as {
          count: number;
          applied_count: number;
          partial_count: number;
        };
        return ok(call, { count: out.count, applied_count: out.applied_count, partial_count: out.partial_count });
      }
      default: {
        const text = note_text(call, args);
        if (text === null) return refused(call, "text must be a non-empty string");
        const stage_key =
          env.run.stage_id === null
            ? undefined
            : env.db.get<{ key: string }>("SELECT key FROM stages WHERE project_id = ? AND id = ?", env.run.project_id, env.run.stage_id)?.key;
        const out = (await execute_with_retries(env, "project.add_note", key, {
          text,
          ...(stage_key === undefined ? {} : { stage: stage_key }),
        })) as { object_id: string };
        return ok(call, { recorded_as: out.object_id });
      }
    }
  } catch (error) {
    if (error instanceof ApiError) return refused(call, `${error.code}: ${error.message}`);
    throw error;
  }
}

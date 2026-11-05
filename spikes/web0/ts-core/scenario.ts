// A-round scenario from docs/plan/spikes/web0-measure.md section 1.
// The same code runs on node:sqlite, the Workers/D1 adapter, and the Vercel-style
// Node handler. Platform differences stay in db.ts.

import { sha256Hex, stableStringify } from "./store.ts";
import type { Db, SqlStatement } from "./db.ts";
import { eventStatements, mutationStatement, newId } from "./store.ts";
import { makeIds, seedBase, type Ids } from "./store.ts";
import { claimWithKey, complete, submitResults, wait } from "./service.ts";
import type { RequestContext } from "./service.ts";
import { goRequestPayload } from "./fake-go.ts";

export interface RunStats {
  ids: Ids;
  wallMs: number;
  dbWriteOps: number;
  dbRowsChanged: number;
  insertedRows: number;
  subrequests: number;
  requestBytes: number;
  responseBytes: number;
  tableDeltas: Record<string, number>;
}

export interface ScenarioOptions {
  fakeGoUrl: string;
  /** Unique ID namespace per round; defaults to a fresh namespace. */
  ids?: Ids;
  /** Optional hook used by the measurement runner to sample CPU around the round. */
  onPhase?: (name: string) => void;
}

const TABLES = [
  "runs",
  "project_leases",
  "mutation_commits",
  "events",
  "outbound_dispatches",
  "objects",
  "object_versions",
  "artifacts",
  "artifact_versions",
  "questions",
  "question_versions",
  "question_sets",
  "question_set_members",
  "submissions",
  "answers",
  "answer_versions",
  "run_input_receipts",
] as const;

export class CountingDb implements Db {
  writeOps = 0;
  rowsChanged = 0;
  insertedRows = 0;
  readonly #inner: Db;

  constructor(inner: Db) {
    this.#inner = inner;
  }

  async all<T = Record<string, unknown>>(sql: string, params?: (string | number | null | Uint8Array)[]): Promise<T[]> {
    return this.#inner.all<T>(sql, params);
  }

  async run(sql: string, params?: (string | number | null | Uint8Array)[]): Promise<number> {
    const changes = await this.#inner.run(sql, params);
    this.writeOps += 1;
    this.rowsChanged += changes;
    if (/^\s*INSERT/i.test(sql)) this.insertedRows += changes;
    return changes;
  }

  async batch(statements: SqlStatement[]): Promise<number[]> {
    const changes = await this.#inner.batch(statements);
    changes.forEach((change, index) => {
      this.writeOps += 1;
      this.rowsChanged += change;
      if (/^\s*INSERT/i.test(statements[index]?.sql ?? "")) this.insertedRows += change;
    });
    return changes;
  }

  resetCounters(): void {
    this.writeOps = 0;
    this.rowsChanged = 0;
    this.insertedRows = 0;
  }
}

async function tableCounts(db: Db): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of TABLES) {
    const rows = await db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`);
    out[table] = rows[0]?.n ?? 0;
  }
  return out;
}

interface GoCallResult {
  responseText: string;
  requestBytes: number;
  responseBytes: number;
}

async function callGo(
  db: Db,
  ctx: RequestContext,
  runId: string,
  callIndex: number,
  requestBytesTarget: number,
  fakeGoUrl: string,
): Promise<GoCallResult & { dispatchId: string }> {
  const dispatchId = newId("obd");
  const payload = goRequestPayload(callIndex, requestBytesTarget);
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  const requestKey = `go:${callIndex}`;
  const startedAt = Date.now();
  await db.run(
    `INSERT INTO outbound_dispatches
      (id, project_id, run_id, provider, policy_version_id, manifest_blob_id, payload_hash,
       state, request_key, usage_json, billing_source, allowance_json, cost_json)
      VALUES (?, ?, ?, 'opencode-go', ?, ?, ?, 'prepared', ?, NULL, NULL, NULL, NULL)`,
    [dispatchId, ctx.ids.project, runId, ctx.ids.policy, ctx.ids.manifestBlob, sha256Hex(payload), requestKey],
  );
  const txSent = newId("mut");
  await db.batch([
    {
      sql: `UPDATE outbound_dispatches SET state = 'sent', sent_at = ? WHERE id = ?`,
      params: [startedAt, dispatchId],
    },
    mutationStatement(txSent, {
      projectId: ctx.ids.project,
      actorId: ctx.ids.agent,
      clientRequestId: `go-sent:${callIndex}:${startedAt}`,
      requestHash: sha256Hex(stableStringify({ callIndex, requestKey })),
      action: "outbound.sent",
      runId,
      resultJson: "{}",
      createdAt: startedAt,
    }),
    ...eventStatements({
      txId: txSent,
      projectId: ctx.ids.project,
      runId,
      type: "outbound.sent",
      count: 1,
      createdAt: startedAt,
    }),
  ]);
  const response = await fetch(fakeGoUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PES-Spike": "web0" },
    body: payload,
  });
  const responseText = await response.text();
  const responseBytes = Buffer.byteLength(responseText, "utf8");
  if (response.status !== 200) throw new Error(`fake Go returned ${response.status}`);
  const respondedAt = Date.now();
  const txResponse = newId("mut");
  await db.batch([
    {
      sql: `UPDATE outbound_dispatches
            SET state = 'response', response_hash = ?, response_at = ?,
                usage_json = ?, billing_source = ?, allowance_json = ?, cost_json = ?
            WHERE id = ?`,
      params: [
        sha256Hex(responseText),
        respondedAt,
        JSON.stringify({ prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 }),
        "synthetic",
        JSON.stringify({ allowance: "unknown" }),
        JSON.stringify({ cost: "unknown" }),
        dispatchId,
      ],
    },
    mutationStatement(txResponse, {
      projectId: ctx.ids.project,
      actorId: ctx.ids.agent,
      clientRequestId: `go-response:${callIndex}:${respondedAt}`,
      requestHash: sha256Hex(stableStringify({ callIndex, responseBytes })),
      action: "outbound.response",
      runId,
      resultJson: "{}",
      createdAt: respondedAt,
    }),
    ...eventStatements({
      txId: txResponse,
      projectId: ctx.ids.project,
      runId,
      type: "outbound.response",
      count: 1,
      createdAt: respondedAt,
    }),
  ]);
  return { responseText, requestBytes: payloadBytes, responseBytes, dispatchId };
}

async function adoptDispatch(db: Db, dispatchId: string, versionId: string): Promise<void> {
  await db.run(
    `UPDATE outbound_dispatches SET state = 'adopted', adopted_version_id = ?, adopted_at = ?
     WHERE id = ?`,
    [versionId, Date.now(), dispatchId],
  );
}

async function askQuestion(
  db: Db,
  ctx: RequestContext,
  runId: string,
): Promise<{ questionId: string; questionVersionId: string }> {
  const questionId = ctx.ids.question;
  const versionId = newId("qsv");
  const setId = newId("qst");
  const txId = newId("mut");
  const text = "합성 2라운드에서 정책 대안 A와 B 중 어느 쪽을 우선할까요?";
  await db.batch([
    mutationStatement(txId, {
      projectId: ctx.ids.project,
      actorId: ctx.ids.agent,
      clientRequestId: `question:${runId}:${ctx.now}`,
      requestHash: sha256Hex(text),
      action: "questions.create",
      runId,
      resultJson: JSON.stringify({ question_id: questionId }),
      createdAt: ctx.now,
    }),
    {
      sql: `INSERT INTO objects
        (id, project_id, edition_id, kind, display_no, current_version_id, rev)
        VALUES (?, ?, ?, 'question', 1, NULL, 1)`,
      params: [questionId, ctx.ids.project, ctx.ids.edition],
    },
    {
      sql: `INSERT INTO object_versions
        (id, project_id, object_id, kind, version_no, based_on_version_id,
         created_in_round_id, actor_id, run_id, tx_id, content_hash, created_at)
        VALUES (?, ?, ?, 'question', 1, NULL, ?, ?, ?, ?, ?, ?)`,
      params: [
        versionId,
        ctx.ids.project,
        questionId,
        ctx.ids.round,
        ctx.ids.agent,
        runId,
        txId,
        sha256Hex(text),
        ctx.now,
      ],
    },
    {
      sql: `UPDATE objects SET current_version_id = ? WHERE id = ?`,
      params: [versionId, questionId],
    },
    {
      sql: `INSERT INTO questions
        (project_id, object_id, object_kind, asked_by_actor_id, intended_actor_id,
         direction, origin, original_version_id)
        VALUES (?, ?, 'question', ?, ?, 'agent_to_human', 'manual', ?)`,
      params: [ctx.ids.project, questionId, ctx.ids.agent, ctx.ids.human, versionId],
    },
    {
      sql: `INSERT INTO question_versions
        (project_id, version_id, object_id, object_kind, text, type, state,
         importance, required, allow_comment_as_answer, default_value, options, show_if)
        VALUES (?, ?, ?, 'question', ?, 'textarea', 'open', 'normal', 1, 1, 'null', '[]', 'null')`,
      params: [ctx.ids.project, versionId, questionId, text],
    },
    {
      sql: `INSERT INTO question_sets
        (id, project_id, stage_id, round_id, purpose, form_key, version_no)
        VALUES (?, ?, ?, ?, 'stage_start', 'round-question', 1)`,
      params: [setId, ctx.ids.project, ctx.ids.stage, ctx.ids.round],
    },
    {
      sql: `INSERT INTO question_set_members
        (project_id, set_id, question_id, question_version_id, position)
        VALUES (?, ?, ?, ?, 0)`,
      params: [ctx.ids.project, setId, questionId, versionId],
    },
    ...eventStatements({
      txId,
      projectId: ctx.ids.project,
      runId,
      type: "question.asked",
      count: 2,
      objectId: questionId,
      afterVersionId: versionId,
      createdAt: ctx.now,
    }),
  ]);
  return { questionId, questionVersionId: versionId };
}

async function submitAnswer(
  db: Db,
  ctx: RequestContext,
  questionId: string,
  questionVersionId: string,
): Promise<void> {
  const submissionId = newId("sub");
  const answerObjectId = newId("ans");
  const answerVersionId = newId("anv");
  const txId = newId("mut");
  const value = JSON.stringify("정책 대안 A를 우선합니다.");
  await db.batch([
    mutationStatement(txId, {
      projectId: ctx.ids.project,
      actorId: ctx.ids.human,
      clientRequestId: `answer:${questionId}:${ctx.now}`,
      requestHash: sha256Hex(value),
      action: "submissions.create",
      resultJson: "{}",
      createdAt: ctx.now,
    }),
    {
      sql: `INSERT INTO objects
        (id, project_id, edition_id, kind, display_no, current_version_id, rev)
        VALUES (?, ?, ?, 'answer', 2, NULL, 1)`,
      params: [answerObjectId, ctx.ids.project, ctx.ids.edition],
    },
    {
      sql: `INSERT INTO object_versions
        (id, project_id, object_id, kind, version_no, based_on_version_id,
         created_in_round_id, actor_id, run_id, tx_id, content_hash, created_at)
        VALUES (?, ?, ?, 'answer', 1, NULL, ?, ?, NULL, ?, ?, ?)`,
      params: [
        answerVersionId,
        ctx.ids.project,
        answerObjectId,
        ctx.ids.round,
        ctx.ids.human,
        txId,
        sha256Hex(value),
        ctx.now,
      ],
    },
    {
      sql: `UPDATE objects SET current_version_id = ? WHERE id = ?`,
      params: [answerVersionId, answerObjectId],
    },
    {
      sql: `INSERT INTO submissions (id, project_id, actor_id, via, tx_id)
        VALUES (?, ?, ?, 'web', ?)`,
      params: [submissionId, ctx.ids.project, ctx.ids.human, txId],
    },
    {
      sql: `INSERT INTO answers (project_id, object_id, object_kind, question_id,
              respondent_actor_id, submission_id)
            VALUES (?, ?, 'answer', ?, ?, ?)`,
      params: [ctx.ids.project, answerObjectId, questionId, ctx.ids.human, submissionId],
    },
    {
      sql: `INSERT INTO answer_versions
        (project_id, version_id, object_id, object_kind, question_id,
         question_version_id, value, state)
        VALUES (?, ?, ?, 'answer', ?, ?, ?, 'submitted')`,
      params: [
        ctx.ids.project,
        answerVersionId,
        answerObjectId,
        questionId,
        questionVersionId,
        value,
      ],
    },
    ...eventStatements({
      txId,
      projectId: ctx.ids.project,
      runId: null,
      type: "submission.created",
      count: 1,
      objectId: answerObjectId,
      afterVersionId: answerVersionId,
      createdAt: ctx.now,
    }),
  ]);
}

export async function runRound(db: Db, options: ScenarioOptions): Promise<RunStats> {
  const started = performance.now();
  const ids = options.ids ?? makeIds(newId("r").slice(2));
  await seedBase(db, { ids });
  const before = await tableCounts(db);
  const counting = new CountingDb(db);
  const now = Date.now();
  const ctx: RequestContext = {
    db: counting,
    auth: { kind: "agent", actorId: ids.agent, projectId: ids.project },
    now,
    ids,
  };

  const claim1 = await claimWithKey(
    ctx,
    ctx.ids.project,
    ctx.ids.agent,
    {
      format_version: "1.0",
      run_id: ctx.ids.run,
      expected_control_rev: "12",
      lease_ttl_ms: 120000,
    },
    "idem_round_claim_1",
  );
  const lease1 = (claim1.body as { data: { lease: { lease_id: string; fence: string } } }).data.lease;

  options.onPhase?.("go-1");
  const call1 = await callGo(counting, ctx, ctx.ids.run, 1, 12 * 1024, options.fakeGoUrl);
  void call1;

  options.onPhase?.("go-2");
  const call2 = await callGo(counting, ctx, ctx.ids.run, 2, 24 * 1024, options.fakeGoUrl);

  options.onPhase?.("results-1");
  const draft = await submitResults(
    ctx,
    ctx.ids.project,
    ctx.ids.run,
    {
      format_version: "1.0",
      lease_id: lease1.lease_id,
      fence: lease1.fence,
      base_control_rev: "12",
      results: [
        {
          client_ref: "r1",
          kind: "artifact",
          object_id: ctx.ids.artifact,
          base_version_id: ctx.ids.baseVersion,
          title: "2장 합성 정책 분석",
          body_md: `## 2. 합성 정책 분석\n\n${call2.responseText.slice(0, 512)}`,
          source_version_ids: [ctx.ids.inputVersion],
        },
      ],
      input_receipts: [{ input_version_id: ctx.ids.inputVersion, state: "applied" }],
    },
    "idem_round_results_1",
  );
  const draftVersion = (
    draft.body as { data: { object_versions: { version_id: string }[] } }
  ).data.object_versions[0]?.version_id;
  if (!draftVersion) throw new Error("draft version missing");
  await adoptDispatch(counting, call2.dispatchId, draftVersion);

  options.onPhase?.("question");
  const question = await askQuestion(counting, ctx, ctx.ids.run);
  options.onPhase?.("wait");
  await wait(ctx, ctx.ids.project, ctx.ids.run, {
    format_version: "1.0",
    lease_id: lease1.lease_id,
    fence: lease1.fence,
    reason: "waiting_human",
    question_ids: [question.questionId],
  });
  options.onPhase?.("answer");
  await submitAnswer(counting, ctx, question.questionId, question.questionVersionId);

  options.onPhase?.("resume");
  const claim2 = await claimWithKey(
    ctx,
    ctx.ids.project,
    ctx.ids.agent,
    {
      format_version: "1.0",
      run_id: ctx.ids.run,
      expected_control_rev: "12",
      lease_ttl_ms: 120000,
    },
    "idem_round_claim_2",
  );
  const lease2 = (claim2.body as { data: { lease: { lease_id: string; fence: string } } }).data.lease;

  options.onPhase?.("go-3");
  const call3 = await callGo(counting, ctx, ctx.ids.run, 3, 28 * 1024, options.fakeGoUrl);

  options.onPhase?.("results-2");
  const revised = await submitResults(
    ctx,
    ctx.ids.project,
    ctx.ids.run,
    {
      format_version: "1.0",
      lease_id: lease2.lease_id,
      fence: lease2.fence,
      base_control_rev: "12",
      results: [
        {
          client_ref: "r2",
          kind: "artifact",
          object_id: ctx.ids.artifact,
          base_version_id: draftVersion,
          title: "2장 합성 정책 분석",
          body_md: `## 2. 합성 정책 분석\n\n답 반영: 정책 대안 A\n\n${call3.responseText.slice(0, 512)}`,
          source_version_ids: [ctx.ids.inputVersion],
        },
      ],
      input_receipts: [{ input_version_id: ctx.ids.inputVersion, state: "applied" }],
    },
    "idem_round_results_2",
  );
  const revisedVersion = (
    revised.body as { data: { object_versions: { version_id: string }[] } }
  ).data.object_versions[0]?.version_id;
  if (!revisedVersion) throw new Error("revised version missing");
  await adoptDispatch(counting, call3.dispatchId, revisedVersion);

  options.onPhase?.("complete");
  await complete(
    ctx,
    ctx.ids.project,
    ctx.ids.run,
    {
      format_version: "1.0",
      lease_id: lease2.lease_id,
      fence: lease2.fence,
      result_version_ids: [revisedVersion],
      status: "succeeded",
      summary: "합성 2라운드 결과 제출 완료",
    },
    "idem_round_complete",
  );

  const after = await tableCounts(db);
  const tableDeltas: Record<string, number> = {};
  for (const table of TABLES) {
    tableDeltas[table] = (after[table] ?? 0) - (before[table] ?? 0);
  }
  return {
    ids,
    wallMs: performance.now() - started,
    dbWriteOps: counting.writeOps,
    dbRowsChanged: counting.rowsChanged,
    insertedRows: counting.insertedRows,
    subrequests: 3,
    requestBytes: (12 + 24 + 28) * 1024,
    responseBytes: (8 + 16 + 12) * 1024,
    tableDeltas,
  };
}

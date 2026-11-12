// SEL-93 U3a 시험 공용 준비물 (tester). 합성 데이터만. 구현을 추측하지 않고, 아래 "정한 해석" 이름만 쓴다.
//
// 정한 명령 이름(서비스 COMMANDS): assumption.propose · assumption.assess · decision.propose · decision.adopt
//   · decision.supersede · decision.revoke · reflection.create
// 명령 입력/결과 모양은 각 시험 파일 머리말에 적는다. 이 파일은 호출을 짧게 하는 도우미와 DB 읽기만 둔다.

import assert from "node:assert/strict";

import type { CommandOutcome, MutationContext } from "../../scripts/pes_core/commands.ts";
import { ApiError } from "../../scripts/pes_core/errors.ts";
import type { Db } from "../../scripts/pes_core/db.ts";
import { new_artifact, type Env } from "./blob_env.ts";
import { add_agent } from "./editions_env.ts";

export interface Out {
  [key: string]: any;
}

export async function run(env: Env, ctx: MutationContext, command: string, payload: Record<string, unknown>): Promise<CommandOutcome> {
  return env.service.execute(ctx, command, payload);
}

/** 성공해야 하는 호출: 결과 객체를 돌려준다. */
export async function ok(env: Env, ctx: MutationContext, command: string, payload: Record<string, unknown>): Promise<Out> {
  const out = await run(env, ctx, command, payload);
  return out.result as Out;
}

/** 거절돼야 하는 호출: ApiError 를 돌려준다(코드는 호출한 쪽이 단언). 다른 오류(미등록 명령 포함)면 시험이 실패한다. */
export async function refused(env: Env, ctx: MutationContext, command: string, payload: Record<string, unknown>, ...codes: string[]): Promise<ApiError> {
  try {
    await env.service.execute(ctx, command, payload);
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected an ApiError from ${command}, got ${String(error)}`);
    if (codes.length > 0) assert.ok(codes.includes(error.code), `${command}: expected ${codes.join("|")}, got ${error.code} (${error.message})`);
    return error;
  }
  assert.fail(`${command} should have been refused`);
}

/** 사람 소유자 외의 행위자(external_agent). 사람만 할 수 있는 명령이 거절하는지 볼 때 쓴다. */
export function agent_of(env: Env, id = "agent-sel93"): MutationContext {
  return add_agent(env, id);
}

export function agent_with_key(base: MutationContext, key: string): MutationContext {
  return { ...base, client_request_id: key };
}

// ---------------------------------------------------------------------------
// DB 읽기 (표 구조는 migrations/001_initial.sql 그대로)

export interface AssumptionVersionRow {
  version_id: string;
  object_id: string;
  version_no: number;
  statement: string;
  state: string;
  assessment_actor_id: string | null;
  assessed_at: number | null;
  needs_review: number;
  rationale: string;
  actor_id: string;
  based_on_version_id: string | null;
}

export function assumption_versions(db: Db, object_id: string): AssumptionVersionRow[] {
  return db
    .all<any>(
      `SELECT a.version_id, a.object_id, v.version_no, a.statement, a.state, a.assessment_actor_id, a.assessed_at,
              a.needs_review, a.rationale, v.actor_id, v.based_on_version_id
         FROM assumption_versions a JOIN object_versions v ON v.project_id = a.project_id AND v.id = a.version_id
        WHERE a.object_id = ? ORDER BY v.version_no`,
      object_id,
    )
    .map((r) => ({ ...r, version_no: Number(r.version_no), assessed_at: r.assessed_at === null ? null : Number(r.assessed_at), needs_review: Number(r.needs_review) }));
}

export interface DecisionVersionRow {
  version_id: string;
  object_id: string;
  version_no: number;
  statement: string;
  state: string;
  decided_by: string | null;
  rationale: string;
  supersedes_decision_id: string | null;
  actor_id: string;
}

export function decision_versions(db: Db, object_id: string): DecisionVersionRow[] {
  return db
    .all<any>(
      `SELECT d.version_id, d.object_id, v.version_no, d.statement, d.state, d.decided_by, d.rationale,
              d.supersedes_decision_id, v.actor_id
         FROM decision_versions d JOIN object_versions v ON v.project_id = d.project_id AND v.id = d.version_id
        WHERE d.object_id = ? ORDER BY v.version_no`,
      object_id,
    )
    .map((r) => ({ ...r, version_no: Number(r.version_no) }));
}

export function decision_scope(db: Db, object_id: string): string | undefined {
  return db.get<{ scope: string }>("SELECT scope FROM decisions WHERE object_id = ?", object_id)?.scope;
}

export function current_version(db: Db, object_id: string): string | null {
  return db.get<{ current_version_id: string | null }>("SELECT current_version_id FROM objects WHERE id = ?", object_id)?.current_version_id ?? null;
}

export interface ReflectionRow {
  id: string;
  source_version_id: string;
  target_round_id: string;
  disposition: string;
  rationale: string;
  result_version_id: string | null;
  followup_id: string | null;
  applied_tx_id: string | null;
  actor_id: string;
  tx_id: string;
}

export function reflection_rows(db: Db, target_round_id?: string): ReflectionRow[] {
  return db.all<ReflectionRow>(
    `SELECT id, source_version_id, target_round_id, disposition, rationale, result_version_id, followup_id, applied_tx_id, actor_id, tx_id
       FROM reflection_entries ${target_round_id === undefined ? "" : "WHERE target_round_id = ?"} ORDER BY rowid`,
    ...(target_round_id === undefined ? [] : [target_round_id]),
  );
}

export function count(db: Db, table: string): number {
  return Number(db.get<{ n: bigint }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0n);
}

export function tx_of_version(db: Db, version_id: string): string {
  const row = db.get<{ tx_id: string }>("SELECT tx_id FROM object_versions WHERE id = ?", version_id);
  assert.ok(row, `version ${version_id} exists`);
  return row.tx_id;
}

/** 새 글 버전 하나(원문/결과 용). 같은 객체의 다음 버전이 아니라 새 객체다. */
export async function artifact_version(env: Env, key: string): Promise<{ object_id: string; version_id: string }> {
  const out = await new_artifact(env, key);
  return { object_id: out.object_id, version_id: out.version_id };
}

export const HANGUL = /[가-힣]/;

// ---------------------------------------------------------------------------
// B(MCP) 도구 이름 — SEL-53 의 mcp_read.ts 와 같은 방식: 이름은 구현(senior)이 정하고, 바뀌면 이 상수만 고친다.
// 지금 후보는 A 도구(assumption.propose·decision.propose·reflection.write)의 이름을 그대로 닮은 MCP 이름이다.
// "B MCP/CLI 는 같은 명령" — 각 도구는 같은 서비스 명령(assumption.propose·decision.propose·reflection.create)을 쓴다.
export const B_TOOL = {
  assumption: "pes_assumption_propose",
  decision: "pes_decision_propose",
  reflection: "pes_reflection_write",
} as const;

/** 사람만 할 수 있는 일(판단·채택·대체·폐기·승인)을 가리키는 도구 이름 모양. MCP 도구 목록에 있으면 안 된다. */
export const HUMAN_ONLY_TOOL_SHAPE = /assess|adopt|confirm|supersede|revoke|approve|reject_assumption|decision_(decide|accept)/i;

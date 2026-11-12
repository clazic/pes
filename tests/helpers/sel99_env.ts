// SEL-99 (stage 3 U4a) 시험 공용 준비물 (tester). 합성 데이터만. 구현을 추측하지 않고, 각 시험 파일 머리말의 "정한 해석" 이름만 쓴다.
//
// 정한 명령 이름(서비스 COMMANDS): annotation.create · annotation.reanchor · thread.reply · thread.resolve · followup.propose · followup.apply
// 표 구조는 migrations/001_initial.sql 그대로(새 표 없음).

import assert from "node:assert/strict";

import { append_version, set_current } from "../../scripts/pes_core/content.ts";
import type { Db } from "../../scripts/pes_core/db.ts";
import { add_artifact, create_object } from "../../scripts/pes_core/content.ts";
import type { Env } from "./blob_env.ts";

/** B(MCP) 도구 이름 — 이름은 구현이 정하고, 바뀌면 이 상수만 고친다. 각 도구는 같은 서비스 명령(thread.reply · followup.propose)을 쓴다. */
export const B99_TOOL = {
  reply: "pes_thread_reply",
  followup: "pes_followup_propose",
} as const;

/** 사람만 하는 U4 일(해결·채택/적용·다시 붙이기)을 가리키는 도구 이름 모양. A allowlist·B MCP 도구 목록에 있으면 안 된다. */
export const HUMAN_ONLY_U4 = /resolve|apply|adopt|reanchor|reopen_apply|approve/i;

export interface Out {
  [key: string]: any;
}

/** code point(유니코드 스칼라) 수 — 시험이 기대값을 계산할 때만 쓴다. */
export function cp_len(s: string): number {
  return Array.from(s).length;
}

/** code point 위치 [start, end) 에서 needle 의 첫(또는 nth) 등장. UTF-16 인덱스가 아니라 code point 위치다. */
export function cp_find(haystack: string, needle: string, nth = 0): { start_cp: number; end_cp: number } {
  const h = Array.from(haystack);
  const n = Array.from(needle);
  let seen = 0;
  for (let i = 0; i + n.length <= h.length; i += 1) {
    let same = true;
    for (let j = 0; j < n.length; j += 1) {
      if (h[i + j] !== n[j]) {
        same = false;
        break;
      }
    }
    if (same) {
      if (seen === nth) return { start_cp: i, end_cp: i + n.length };
      seen += 1;
    }
  }
  assert.fail(`needle not found in haystack: ${needle}`);
}

/** code point 구간 자르기. */
export function cp_slice(s: string, start_cp: number, end_cp: number): string {
  return Array.from(s).slice(start_cp, end_cp).join("");
}

/** 본문이 있는 새 글(객체 + 첫 버전, 첫 버전이 현재 버전). */
export async function text_artifact(env: Env, key: string, body_md: string): Promise<{ object_id: string; version_id: string }> {
  const obj = (await create_object(env.service, env.ctx(`${key}-o`), { kind: "artifact", edition_id: env.p.edition_id })).result as { object_id: string };
  const out = await add_artifact(env.service, env.ctx(`${key}-v`), {
    object_id: obj.object_id,
    artifact_kind: "chapter",
    title: `합성 장 ${key}`,
    summary: "합성 요약",
    body_md,
  });
  return { object_id: obj.object_id, version_id: (out.result as { version_id: string }).version_id };
}

/** 같은 글의 다음 버전(본문 교체). make_current 면 현재 버전으로도 올린다(content.set_current). */
export async function text_version(env: Env, key: string, object_id: string, body_md: string, make_current = true): Promise<{ version_id: string }> {
  const out = await append_version(env.service, env.ctx(key), { object_id, title: `합성 제목 ${key}`, body_md });
  const version_id = (out.result as { version_id: string }).version_id;
  if (make_current) await set_current(env.service, env.ctx(`${key}-cur`), { object_id, version_id });
  return { version_id };
}

export function current_version_of(db: Db, object_id: string): string {
  const row = db.get<{ v: string | null }>("SELECT current_version_id AS v FROM objects WHERE id = ?", object_id);
  assert.ok(row?.v, `object ${object_id} has a current version`);
  return row.v;
}

export function body_of(db: Db, version_id: string): string | null {
  const row = db.get<{ b: string | null }>("SELECT body_md AS b FROM artifact_versions WHERE version_id = ?", version_id);
  assert.ok(row, `artifact version ${version_id} exists`);
  return row.b;
}

export function artifact_version_count(db: Db, object_id: string): number {
  return Number(db.get<{ n: bigint }>("SELECT count(*) AS n FROM artifact_versions WHERE object_id = ?", object_id)!.n);
}

/** anchors 한 줄 전체(불변 검사용: 앞뒤 JSON 이 같아야 한다). */
export function anchor_row(db: Db, anchor_id: string): string {
  const row = db.get<Record<string, unknown>>("SELECT * FROM anchors WHERE id = ?", anchor_id);
  assert.ok(row, `anchor ${anchor_id} exists`);
  return JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
}

export interface ResolutionRow {
  id: string;
  anchor_id: string;
  evaluated_version_id: string;
  status: string;
  start_cp: number | null;
  end_cp: number | null;
  method: string;
  confirmed_by_actor_id: string | null;
}

export function resolutions_of(db: Db, anchor_id: string): ResolutionRow[] {
  return db
    .all<any>(
      `SELECT id, anchor_id, evaluated_version_id, status, start_cp, end_cp, method, confirmed_by_actor_id
         FROM anchor_resolutions WHERE anchor_id = ? ORDER BY rowid`,
      anchor_id,
    )
    .map((r) => ({
      ...r,
      start_cp: r.start_cp === null ? null : Number(r.start_cp),
      end_cp: r.end_cp === null ? null : Number(r.end_cp),
    }));
}

export function all_resolution_count(db: Db): number {
  return Number(db.get<{ n: bigint }>("SELECT count(*) AS n FROM anchor_resolutions")!.n);
}

export interface ThreadRow {
  thread_id: string;
  context_kind: string;
  target_object_id: string;
  target_version_id: string | null;
  anchor_id: string | null;
  state: string;
  summary: string;
  resolved_by_message_version_id: string | null;
}

/** 스레드의 현재 버전(thread_versions)과 고정 칸(threads). */
export function thread_row(db: Db, thread_id: string): ThreadRow {
  const row = db.get<any>(
    `SELECT t.object_id AS thread_id, t.context_kind, t.target_object_id, t.target_version_id, t.anchor_id,
            tv.state, tv.summary, tv.resolved_by_message_version_id
       FROM threads t JOIN objects o ON o.id = t.object_id JOIN thread_versions tv ON tv.version_id = o.current_version_id
      WHERE t.object_id = ?`,
    thread_id,
  );
  assert.ok(row, `thread ${thread_id} has a current thread_versions row`);
  return { ...row };
}

export function thread_version_count(db: Db, thread_id: string): number {
  return Number(db.get<{ n: bigint }>("SELECT count(*) AS n FROM thread_versions WHERE object_id = ?", thread_id)!.n);
}

export interface MessageRow {
  message_id: string;
  version_id: string;
  body_md: string;
  state: string;
  reply_to: string | null;
  actor_id: string;
}

export function messages_of(db: Db, thread_id: string): MessageRow[] {
  return db
    .all<any>(
      `SELECT m.object_id AS message_id, mv.version_id, mv.body_md, mv.state, m.reply_to, ov.actor_id
         FROM messages m JOIN message_versions mv ON mv.object_id = m.object_id
         JOIN object_versions ov ON ov.id = mv.version_id
        WHERE m.thread_id = ? ORDER BY m.rowid, ov.version_no`,
      thread_id,
    )
    .map((r) => ({ ...r }));
}

export interface FollowupRow {
  followup_id: string;
  version_id: string;
  version_no: number;
  origin_thread_id: string | null;
  origin_version_id: string | null;
  kind: string;
  state: string;
  description: string;
  target_stage_id: string | null;
  target_round_id: string | null;
  base_artifact_version_id: string | null;
  proposed_artifact_version_id: string | null;
  confirmed_by_actor_id: string | null;
  applied_tx_id: string | null;
  result_version_id: string | null;
}

/** 후속(followups)의 현재 버전. */
export function followup_row(db: Db, followup_id: string): FollowupRow {
  const row = db.get<any>(
    `SELECT f.object_id AS followup_id, fv.version_id, ov.version_no, f.origin_thread_id, f.origin_version_id, fv.kind, fv.state,
            fv.description, fv.target_stage_id, fv.target_round_id, fv.base_artifact_version_id,
            fv.proposed_artifact_version_id, fv.confirmed_by_actor_id, fv.applied_tx_id, fv.result_version_id
       FROM followups f JOIN objects o ON o.id = f.object_id JOIN followup_versions fv ON fv.version_id = o.current_version_id
       JOIN object_versions ov ON ov.id = fv.version_id
      WHERE f.object_id = ?`,
    followup_id,
  );
  assert.ok(row, `followup ${followup_id} has a current version`);
  return { ...row, version_no: Number(row.version_no) };
}

export function followup_version_count(db: Db, followup_id: string): number {
  return Number(db.get<{ n: bigint }>("SELECT count(*) AS n FROM followup_versions WHERE object_id = ?", followup_id)!.n);
}

export function count_of(db: Db, table: string): number {
  return Number(db.get<{ n: bigint }>(`SELECT count(*) AS n FROM ${table}`)!.n);
}

/** 한 번의 명령이 남긴 영수증(mutation_commits)과 사건(events). */
export function receipt_by_key(db: Db, project_id: string, key: string) {
  return db.get<{ id: string; action: string; actor_id: string }>(
    "SELECT id, action, actor_id FROM mutation_commits WHERE project_id = ? AND client_request_id = ?",
    project_id,
    key,
  );
}

export function event_count(db: Db, tx_id: string): number {
  return Number(db.get<{ n: bigint }>("SELECT count(*) AS n FROM events WHERE tx_id = ?", tx_id)!.n);
}

/** 이 시험 묶음이 쓰는 "거절" 코드(서비스는 invalid_payload·conflict·not_found·forbidden, HTTP 는 validation_failed 등). */
export const REFUSED_PAYLOAD = ["invalid_payload", "validation_failed", "conflict", "not_found"];

// SEL-113 REF1a 시험 공용 준비물 (tester). 합성 데이터만. 구현을 추측하지 않고, 아래 "정한 인터페이스"만 쓴다.
//
// 정한 인터페이스 (표는 각 시험 파일 머리말에도 있다. 구현이 다르게 정하면 이 파일과 머리말만 고친다)
//
//   서비스 명령 (CommandService.execute, ctx = 참고자료를 받는 "현재 프로젝트"의 사람 소유자. reference.source_gone 만 원본 쪽 소유자)
//     reference.attach       {referenced_project_id, source_snapshot_id?, scope?, source_label?}
//     reference.detach       {reference_id}
//     reference.refresh      {reference_id, source_snapshot_id?, base_rev?}
//     reference.source_gone  {referenced_project_id, snapshot_id?}   (원본 프로젝트/스냅숏이 사라질 때: 같은 tx 에서 비우고 tombstone)
//   영수증 action 은 /^reference\./ , 사건 type 도 /^reference\./ (payload.reference_id).
//
//   HTTP (모두 P = /api/v1/projects/{id})
//     GET  P/references                     context:read 토큰 또는 소유자 세션. data.references[]
//     GET  P/references/{ref}               data = {reference, content}
//     POST P/references                     사람(소유자 세션)만. 201 data.reference
//     POST P/references/{ref}/refresh       사람만. 200 data.reference
//     POST P/references/{ref}/detach        사람만. 200 data = {reference_id, detached: true}
//     GET  P/context                        data.references = 목록(본문 없음)
//
//   읽기 줄(REF_KEYS): 아래 REF_KEYS 열여섯 칸. 권한 없는 줄은 REF_NOPERM_KEYS 세 칸뿐.
//   A 도구 context.get {reference_id?} → context.references / context.reference(+content)
//   B MCP pes_context {reference_id?} → data.references / data.reference(+content)  (새 도구를 더하지 않는다)

import assert from "node:assert/strict";

import { append_version, add_artifact, add_source, create_object } from "../../scripts/pes_core/content.ts";
import type { Db } from "../../scripts/pes_core/db.ts";
import { set_policy } from "../../scripts/pes_core/policy.ts";
import { snapshot } from "../../scripts/pes_core/editions.ts";
import { ctx_for, put_ready, second_project, type Env, type Project, type VersionResult } from "./blob_env.ts";
import { ok } from "./sel93_env.ts";

export const REF_KEYS = [
  "access",
  "ai_delivery",
  "attached_at",
  "attached_by_actor_id",
  "id",
  "latest_snapshot_id",
  "new_version_available",
  "referenced_project_id",
  "referenced_project_key",
  "refreshed_at",
  "rev",
  "scope",
  "source_label",
  "source_snapshot_id",
  "source_snapshot_key",
  "state",
];
export const REF_NOPERM_KEYS = ["access", "id", "state"];
/** A 와 B 가 같아야 하는 칸(시각·rev 표기 같은 전송 모양은 뺀다). */
export const REF_COMMON_KEYS = ["id", "state", "access", "source_label", "referenced_project_id", "source_snapshot_id", "scope", "new_version_available", "ai_delivery"];
export const DEFAULT_SCOPE = ["final_report", "sources"];

export interface RefRow {
  id: string;
  project_id: string;
  referenced_project_id: string | null;
  referenced_project_key: string;
  source_snapshot_id: string | null;
  source_snapshot_key: string | null;
  source_label: string;
  latest_snapshot_id: string | null;
  scope_json: string;
  status: string;
  attached_by_actor_id: string;
  attached_by_user_id: string;
  attached_at: number;
  refreshed_at: number | null;
  rev: number;
}

function row_of(r: any): RefRow {
  return { ...r, attached_at: Number(r.attached_at), refreshed_at: r.refreshed_at === null ? null : Number(r.refreshed_at), rev: Number(r.rev) };
}

export function ref_row(db: Db, id: string): RefRow | undefined {
  const r = db.get<any>("SELECT * FROM project_references WHERE id = ?", id);
  return r === undefined ? undefined : row_of(r);
}

export function ref_rows(db: Db, project_id: string): RefRow[] {
  return db.all<any>("SELECT * FROM project_references WHERE project_id = ? ORDER BY rowid", project_id).map(row_of);
}

export function ref_count(db: Db): number {
  return Number(db.get<{ n: bigint }>("SELECT count(*) AS n FROM project_references")?.n ?? 0n);
}

export function owner_user_of(db: Db, project_id: string): string {
  const row = db.get<{ owner_user_id: string }>("SELECT owner_user_id FROM projects WHERE id = ?", project_id);
  assert.ok(row, `project ${project_id} exists`);
  return row.owner_user_id;
}

// ---------------------------------------------------------------------------
// 원본 프로젝트: 보고서(artifact kind=report) + 출처(source) + 결정 하나, 판 스냅숏

export interface Source {
  p: Project;
  /** 원본 소유 사용자 (현재 프로젝트 소유자와 다른 사람). */
  user_id: string;
  tag: string;
  report: VersionResult;
  source: VersionResult;
  snapshot_id: string;
  /** 본문에 들어 있는 표지 글자. 읽기 응답에 나오면 안 되는지/나와야 하는지 가린다. */
  report_marker: string;
  source_marker: string;
}

export const report_marker = (tag: string, n = 1): string => `REF-${tag}-REPORT-V${n}`;
export const source_marker = (tag: string): string => `REF-${tag}-SOURCE`;

async function new_object(env: Env, p: Project, key: string, kind: "artifact" | "source"): Promise<string> {
  const out = await create_object(env.service, ctx_for(p, `${key}-o`), { kind, edition_id: p.edition_id });
  return (out.result as { object_id: string }).object_id;
}

export async function take_snapshot(env: Env, p: Project, key: string, versions: Array<{ object_id: string; version_id: string }>): Promise<string> {
  const body = new TextEncoder().encode(JSON.stringify({ versions }));
  const blob = await put_ready(env, body, `mf-${key}`, p);
  const out = await snapshot(env.service, ctx_for(p, `${key}-snap`), { scope: "edition", manifest_blob_id: blob.blob_id, versions });
  return (out.result as { snapshot_id: string }).snapshot_id;
}

export async function make_source(env: Env, tag: string): Promise<Source> {
  const p = await second_project(env, `ref-src-${tag}`);
  const object_id = await new_object(env, p, `${tag}-rep`, "artifact");
  const report = (await add_artifact(env.service, ctx_for(p, `${tag}-rep-v`), {
    object_id,
    artifact_kind: "report",
    title: `${report_marker(tag)} 제목`,
    summary: `${report_marker(tag)} 요약`,
    body_md: `# 최종 보고서\n\n${report_marker(tag)} 본문 문단.`,
  })).result as VersionResult;
  const source_id = await new_object(env, p, `${tag}-src`, "source");
  const source = (await add_source(env.service, ctx_for(p, `${tag}-src-v`), {
    object_id: source_id,
    source_kind: "web",
    title: `${source_marker(tag)} 제목`,
    url: "https://example.invalid/synthetic-ref",
    quote: `${source_marker(tag)} 발췌`,
    locator: { page: 1 },
    method: "fetch",
    verification_state: "unverified",
  })).result as VersionResult;
  const snapshot_id = await take_snapshot(env, p, `${tag}-s1`, [
    { object_id: report.object_id, version_id: report.version_id },
    { object_id: source.object_id, version_id: source.version_id },
  ]);
  return { p, user_id: owner_user_of(env.db, p.project_id), tag, report, source, snapshot_id, report_marker: report_marker(tag), source_marker: source_marker(tag) };
}

/** 원본에 보고서 새 버전(n판)과 새 스냅숏을 더한다. 옛 스냅숏과 옛 버전은 그대로. */
export async function add_new_version(env: Env, src: Source, n: number): Promise<{ snapshot_id: string; version_id: string; marker: string }> {
  const marker = report_marker(src.tag, n);
  const v = (await append_version(env.service, ctx_for(src.p, `${src.tag}-rep-v${n}`), {
    object_id: src.report.object_id,
    title: `${marker} 제목`,
    summary: `${marker} 요약`,
    body_md: `# 최종 보고서\n\n${marker} 본문 문단.`,
  })).result as VersionResult;
  const snapshot_id = await take_snapshot(env, src.p, `${src.tag}-s${n}`, [
    { object_id: v.object_id, version_id: v.version_id },
    { object_id: src.source.object_id, version_id: src.source.version_id },
  ]);
  return { snapshot_id, version_id: v.version_id, marker };
}

/** 현재 프로젝트 소유자 사용자를 원본 프로젝트의 편집자로 넣는다(두 프로젝트 모두 접근). */
export function grant_access(env: Env, src: Source, role: "owner" | "editor" | "reader" = "editor"): string {
  const user_id = owner_user_of(env.db, env.p.project_id);
  env.db.run("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)", src.p.project_id, user_id, role);
  return user_id;
}

export function revoke_access(env: Env, src: Source): void {
  const user_id = owner_user_of(env.db, env.p.project_id);
  env.db.run("DELETE FROM project_members WHERE project_id = ? AND user_id = ?", src.p.project_id, user_id);
}

export async function attach_ref(env: Env, src: Source, key: string, extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
  return ok(env, env.ctx(key), "reference.attach", { referenced_project_id: src.p.project_id, source_snapshot_id: src.snapshot_id, ...extra });
}

/** 접근을 주고 붙인다. */
export async function attached(env: Env, tag: string, extra: Record<string, unknown> = {}): Promise<{ src: Source; ref: Record<string, any> }> {
  const src = await make_source(env, tag);
  grant_access(env, src);
  const ref = await attach_ref(env, src, `att-${tag}`, extra);
  return { src, ref };
}

export async function source_go(env: Env, src: Source, allow: boolean, key: string): Promise<void> {
  await set_policy(env.service, ctx_for(src.p, key), { allow_opencode_go: allow, reason: allow ? "합성: 원본 Go 켜기" : "합성: 원본 Go 끄기" });
}

export async function current_go(env: Env, allow: boolean, key: string): Promise<void> {
  await set_policy(env.service, env.ctx(key), { allow_opencode_go: allow, reason: allow ? "합성: Go 켜기" : "합성: Go 끄기" });
}

export function receipt_actions(db: Db, project_id: string, like: string): string[] {
  return db
    .all<{ action: string }>("SELECT action FROM mutation_commits WHERE project_id = ? AND client_request_id LIKE ? ORDER BY rowid", project_id, like)
    .map((r) => r.action);
}

export function ref_events(db: Db, project_id: string, since_seq = 0): Array<{ type: string; tx_id: string; payload: any }> {
  return db
    .all<any>("SELECT type, tx_id, payload FROM events WHERE project_id = ? AND type LIKE 'reference.%' AND event_seq > ? ORDER BY event_seq", project_id, since_seq)
    .map((r) => ({ type: r.type, tx_id: r.tx_id, payload: JSON.parse(r.payload) }));
}

export function last_event_seq(db: Db): number {
  return Number(db.get<{ m: bigint | null }>("SELECT max(event_seq) AS m FROM events")?.m ?? 0n);
}

/** 응답/요청 전체 글자에 표지가 있는가 */
export function has_text(value: unknown, marker: string): boolean {
  return (typeof value === "string" ? value : JSON.stringify(value)).includes(marker);
}

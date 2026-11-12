// SEL-115 (3단계 MAT1a) 공용 준비물 — 내 자료 올리기·파일 정책·AI 참조 스위치 시험. 합성 값만 쓴다.
//
// ── 정한 인터페이스 (구현이 이 표를 따른다. 이름이 바뀌면 이 파일과 머리말만 고친다) ──────────────
//
// 이름/존재 표시 정책(결정): deny 파일은 사람이 아닌 모든 호출자(agent 토큰·internal_ai·A 도구·B MCP)에게
//   **이름·blob_id·file_policy_id·sha256·본문·개수** 어디에도 나가지 않는다 — 목록에서 통째로 빠진다(존재 표시 없음).
//   사람(owner 세션)은 모두 보고, 각 자료의 ai_access 를 본다.
//
// 명령 (CommandService.execute 이름 / 영수증 action = 사건 type):
//   file.upload         {blob_id, title?, object_id?, role?="attachment"}
//                       "내 자료" = kind 'source'(source_kind 'file') 객체. object_id 없으면 새 자료 객체+첫 버전,
//                       있으면 그 자료 객체의 새 버전. ready blob 을 version_files 로 붙이고 file_policies(allow, rev 1)를
//                       만든다(같은 blob 이면 기존 정책 재사용). action/event: file.material_uploaded
//                       결과 {object_id, version_id, version_no, blob_id, file_policy_id, role, ai_access:"allow",
//                             original_name, media_type, size, sha256}
//   file.ai_access_set  {file_policy_id, ai_access:"allow"|"deny", reason?}  — 사람 소유자만.
//                       file_ai_access_versions 에 한 줄 **추가**(덮어쓰기 아님, rev = 정책 rev+1), file_policies 를 같은 값·rev 로 맞춘다.
//                       같은 값으로 다시 두면 기록·rev 변화 없이 changed:false. action/event: file.ai_access_changed
//                       결과 {file_policy_id, blob_id, ai_access, rev, changed}
//
// HTTP (모두 /api/v1/projects/{id} 아래, 응답은 Success/Error 봉투):
//   POST /materials                     Idempotency-Key 필수, 소유자 세션 또는 file:write 토큰. 본문 = file.upload 입력.
//                                       201 data = file.upload 결과. 같은 키·본문 다시 = replayed:true. blob 이 ready 아님 409,
//                                       없음/다른 프로젝트 404, 모르는 칸·잘못된 role 400.
//   GET  /materials                     context:read(+Go). data {materials:[{object_id, version_id, version_no, blob_id,
//                                       file_policy_id, role, title, original_name, media_type, size, sha256, ai_access?}]}
//                                       각 자료 객체의 현재 버전 파일. ai_access 칸은 사람에게만. agent 는 allow 파일만.
//   POST /file-policies/{fp}/ai-access  Idempotency-Key 필수, **소유자 세션만**(agent 토큰은 모든 범위여도 403, 인증 없음 401).
//                                       본문 {ai_access, reason?}. 200 data = file.ai_access_set 결과. 모르는 fp·다른 프로젝트 fp 404.
//   GET  /files/{b}/preview             file:read(+Go, deny 규칙은 content 와 같음). 200 원문 바이트 + content-type(안전한 형식만, 아니면
//                                       application/octet-stream) + x-content-type-options: nosniff +
//                                       sandbox 가 필요한 형식(needs_document_sandbox)은 content-security-policy: sandbox …(content 와 같은 값) +
//                                       content-disposition: text/plain·image/png·application/pdf 는 inline, 그 밖은 attachment.
//                                       staging 409, 모르는/다른 프로젝트 blob 404, 바이트 변조 409.
//   GET  /context                       data.materials = GET /materials 의 materials (agent 는 allow 만).
//   MCP  pes_context                    결과 materials = 같은 목록. pes_read 의 files 는 기존 규칙(deny 제외).
//   A    context.get                    결과 context.materials = [{object_id, version_id, title, original_name, media_type, size}] allow 만.

import assert from "node:assert/strict";

import { sha256_hex } from "./backup_fixture.ts";
import { call, project_path, type ApiEnv, type ApiResponse, type Auth } from "./api_env.ts";
import type { Db } from "../../scripts/pes_core/db.ts";

export const P = (env: ApiEnv, rest = ""): string => project_path(env, rest);

export function text_bytes(label: string, marker: string): Uint8Array {
  return new TextEncoder().encode(`합성 자료 ${label}\n본문 표식 ${marker}\n`);
}

export interface Blob {
  blob_id: string;
  sha256: string;
  size: number;
}

/** POST /uploads → PUT → complete, 소유자(또는 토큰)로. 같은 바이트면 dedup 된 같은 blob. */
export async function http_blob(
  env: ApiEnv,
  bytes: Uint8Array,
  opts: { media_type?: string; name?: string; auth?: Auth } = {},
): Promise<Blob> {
  const auth = opts.auth ?? "owner";
  const sha = sha256_hex(bytes);
  const media_type = opts.media_type ?? "text/plain";
  const reserved = await call(env, {
    method: "POST",
    path: P(env, "/uploads"),
    auth,
    body: { sha256: sha, size: bytes.byteLength, media_type, original_name: opts.name ?? "합성자료.txt" },
  });
  assert.ok(reserved.status === 200 || reserved.status === 201, `reserve ${reserved.status} ${JSON.stringify(reserved.json)}`);
  const blob_id = reserved.json.data.blob_id as string;
  if (reserved.json.data.state !== "ready") {
    const put = await call(env, { method: "PUT", path: P(env, `/uploads/${blob_id}`), auth, raw: bytes, headers: { "content-type": media_type } });
    assert.equal(put.status, 200, `put ${JSON.stringify(put.json)}`);
    const done = await call(env, { method: "POST", path: P(env, `/uploads/${blob_id}/complete`), auth, body: {} });
    assert.equal(done.status, 200, `complete ${JSON.stringify(done.json)}`);
    assert.equal(done.json.data.state, "ready");
  }
  return { blob_id, sha256: sha, size: bytes.byteLength };
}

export function upload_material(
  env: ApiEnv,
  body: Record<string, unknown>,
  auth: Auth = "owner",
  key?: string | null,
): Promise<ApiResponse> {
  return call(env, { method: "POST", path: P(env, "/materials"), auth, body, ...(key === undefined ? {} : { key }) });
}

export function set_access(
  env: ApiEnv,
  file_policy_id: string,
  ai_access: unknown,
  auth: Auth = "owner",
  extra: Record<string, unknown> = {},
  key?: string | null,
): Promise<ApiResponse> {
  return call(env, {
    method: "POST",
    path: P(env, `/file-policies/${file_policy_id}/ai-access`),
    auth,
    body: { ai_access, ...extra },
    ...(key === undefined ? {} : { key }),
  });
}

/** blob 하나를 올려 자료로 등록하고 결과 data 를 돌려준다(201 확인). */
export async function new_material(
  env: ApiEnv,
  label: string,
  opts: { media_type?: string; name?: string; marker?: string; extra?: Record<string, unknown> } = {},
): Promise<{ data: any; blob: Blob; marker: string; name: string; bytes: Uint8Array }> {
  const marker = opts.marker ?? `MARK-${label}-7f3a`;
  const name = opts.name ?? `자료-${label}.txt`;
  const bytes = text_bytes(label, marker);
  const blob = await http_blob(env, bytes, { ...(opts.media_type === undefined ? {} : { media_type: opts.media_type }), name });
  const res = await upload_material(env, { blob_id: blob.blob_id, title: `제목 ${label}`, ...(opts.extra ?? {}) });
  assert.equal(res.status, 201, `upload_material ${res.status} ${JSON.stringify(res.json)}`);
  return { data: res.json.data, blob, marker, name, bytes };
}

export interface PolicyRow {
  id: string;
  blob_id: string;
  ai_access: string;
  rev: bigint;
  changed_by_user_id: string;
  changed_by_actor_id: string;
}

export function policy_rows(db: Db, project_id: string): PolicyRow[] {
  return db.all<PolicyRow>(
    `SELECT id, blob_id, ai_access, rev, changed_by_user_id, changed_by_actor_id
       FROM file_policies WHERE project_id = ? ORDER BY rowid`,
    project_id,
  );
}

export interface HistoryRow {
  id: string;
  file_policy_id: string;
  ai_access: string;
  rev: bigint;
  reason: string | null;
  changed_by_user_id: string;
  changed_by_actor_id: string;
  tx_id: string;
}

export function history_rows(db: Db, file_policy_id: string): HistoryRow[] {
  return db.all<HistoryRow>(
    `SELECT id, file_policy_id, ai_access, rev, reason, changed_by_user_id, changed_by_actor_id, tx_id
       FROM file_ai_access_versions WHERE file_policy_id = ? ORDER BY rev`,
    file_policy_id,
  );
}

export function count(db: Db, table: string): number {
  return Number(db.get<{ n: bigint }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0n);
}

export function events_of(db: Db, type: string): Array<{ payload: string }> {
  return db.all<{ payload: string }>("SELECT payload FROM events WHERE type = ? ORDER BY event_seq", type);
}

/** 응답 한 건이 담은 모든 글자(JSON + 원문 바이트) — 새어 나감 검사용. */
export function wire_of(res: ApiResponse): string {
  const bytes = res.bytes === null ? "" : Buffer.from(res.bytes).toString("utf8");
  return JSON.stringify(res.json) + "\n" + bytes;
}

/** deny 파일의 흔적(이름·blob·정책·해시·본문 표식)이 text 어디에도 없어야 한다. */
export function assert_no_trace(
  text: string,
  m: { data: any; blob: Blob; marker: string; name: string },
  where: string,
): void {
  for (const needle of [m.blob.blob_id, m.data.file_policy_id, m.blob.sha256, m.marker, m.name]) {
    assert.ok(!text.includes(needle), `${where}: "${needle}" must not appear`);
  }
}

export function assert_trace(text: string, m: { data: any; blob: Blob; name: string }, where: string): void {
  assert.ok(text.includes(m.blob.blob_id) || text.includes(m.name), `${where}: the allowed file is present`);
}

// SEL-119 U6a 시험 공용 준비물 (tester). 합성 데이터만. 구현을 추측하지 않고 각 시험 파일 머리말의 "정한 인터페이스"만 쓴다.
//
// 이 파일은 (1) 합성 산출물·출처·인용·가정·결정을 기존 명령으로 만드는 도우미, (2) 고정본(snapshot)·manifest·출력물 blob 을
// DB 와 objects 폴더에서 읽는 도우미만 둔다. 인쇄 명령 자체의 호출은 시험 파일이 직접 한다.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { MutationContext } from "../../scripts/pes_core/commands.ts";
import { add_artifact, add_citation, add_source, append_version, create_object, set_current } from "../../scripts/pes_core/content.ts";
import type { Db } from "../../scripts/pes_core/db.ts";
import { ApiError } from "../../scripts/pes_core/errors.ts";
import { blob_row, disk_path, list_files, type Env } from "./blob_env.ts";
import { seal, start, stage_ids } from "./editions_env.ts";

export interface Out {
  [key: string]: any;
}

export const CATEGORIES = ["body", "table", "footnote", "comment", "assumption", "decision", "reflection"] as const;

export const sha256_hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

export async function ok(env: Env, ctx: MutationContext, command: string, payload: Record<string, unknown>): Promise<Out> {
  return (await env.service.execute(ctx, command, payload)).result as Out;
}

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

// ---------------------------------------------------------------------------
// 합성 내용 만들기 (모두 기존 PR7 명령)

export interface Art {
  object_id: string;
  version_id: string;
}

/** 산출물 하나(첫 버전이 현재 버전). stage_id 를 주면 그 단계 산출물(= 열린 라운드의 인쇄 내용). */
export async function art(
  env: Env,
  key: string,
  opts: { stage_id?: string; kind?: string; title?: string; body_md?: string; status?: string; edition_id?: string } = {},
): Promise<Art> {
  const obj = (await create_object(env.service, env.ctx(`${key}-o`), { kind: "artifact", edition_id: opts.edition_id ?? env.p.edition_id })).result as { object_id: string };
  const out = await add_artifact(env.service, env.ctx(`${key}-v`), {
    object_id: obj.object_id,
    artifact_kind: opts.kind ?? "chapter",
    ...(opts.stage_id === undefined ? {} : { stage_id: opts.stage_id }),
    title: opts.title ?? `합성 제목 ${key}`,
    summary: "합성 요약",
    body_md: opts.body_md ?? `합성 본문 ${key}`,
    ...(opts.status === undefined ? {} : { status: opts.status }),
  });
  return { object_id: obj.object_id, version_id: (out.result as { version_id: string }).version_id };
}

/** 같은 산출물의 새 버전. current=true 면 현재 버전으로도 올린다. */
export async function more(env: Env, key: string, object_id: string, opts: { title?: string; body_md?: string; current?: boolean } = {}): Promise<string> {
  const out = await append_version(env.service, env.ctx(key), {
    object_id,
    title: opts.title ?? `합성 제목 ${key}`,
    ...(opts.body_md === undefined ? {} : { body_md: opts.body_md }),
  });
  const version_id = (out.result as { version_id: string }).version_id;
  if (opts.current === true) await set_current(env.service, env.ctx(`${key}-cur`), { object_id, version_id });
  return version_id;
}

/** 출처 하나를 만들어 산출물 버전에 각주(인용)로 붙인다. */
export async function cite(env: Env, key: string, artifact_version_id: string, quote = "합성 발췌"): Promise<Art> {
  const obj = (await create_object(env.service, env.ctx(`${key}-so`), { kind: "source" })).result as { object_id: string };
  const src = await add_source(env.service, env.ctx(`${key}-sv`), {
    object_id: obj.object_id,
    source_kind: "web",
    method: "fetch",
    verification_state: "unverified",
    title: `합성 출처 ${key}`,
    url: "https://example.test/page",
  });
  const version_id = (src.result as { version_id: string }).version_id;
  await add_citation(env.service, env.ctx(`${key}-c`), { artifact_version_id, source_version_id: version_id, quote });
  return { object_id: obj.object_id, version_id };
}

/** 단계 하나를 start → 산출물 → 봉인까지. 승인은 하지 않는다. */
export async function sealed_round(env: Env, stage_id: string, tag: string, body_md = `봉인 본문 ${tag}`) {
  const round = await start(env, stage_id, `${tag}-start`);
  const a = await art(env, `${tag}-a`, { stage_id, body_md, title: `봉인 제목 ${tag}` });
  const versions = [{ object_id: a.object_id, version_id: a.version_id }];
  const sealed = (await seal(env, round.round_id, versions, `${tag}-seal`)).result as { snapshot_id: string; versions: typeof versions; content_hash: string };
  return { round, art: a, versions, snapshot_id: sealed.snapshot_id };
}

export async function propose_assumption(env: Env, key: string, statement: string): Promise<Out> {
  return ok(env, env.ctx(key), "assumption.propose", { statement, rationale: "합성 배경" });
}

export async function propose_decision(env: Env, key: string, statement: string): Promise<Out> {
  return ok(env, env.ctx(key), "decision.propose", { statement, scope: "edition", rationale: "합성 근거" });
}

// ---------------------------------------------------------------------------
// 행위자

/** 사람 행위자(프로젝트 구성원). role: owner 외 editor|reader. */
export function human_member(env: Env, id: string, role: "editor" | "reader"): MutationContext {
  env.db.run("INSERT INTO users (id, display_name) VALUES (?, ?)", `user-${id}`, `합성 ${id}`);
  env.db.run("INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, 'human', ?, ?)", id, `user-${id}`, `합성 ${id}`);
  env.db.run("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)", env.p.project_id, `user-${id}`, role);
  return { project_id: env.p.project_id, actor_id: id, via: "cli", client_request_id: "unset" };
}

/** 이 프로젝트 구성원이 아닌 사람. */
export function human_outsider(env: Env, id = "outsider"): MutationContext {
  env.db.run("INSERT INTO users (id, display_name) VALUES (?, ?)", `user-${id}`, `합성 ${id}`);
  env.db.run("INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, 'human', ?, ?)", id, `user-${id}`, `합성 ${id}`);
  return { project_id: env.p.project_id, actor_id: id, via: "cli", client_request_id: "unset" };
}

export const with_key = (base: MutationContext, key: string): MutationContext => ({ ...base, client_request_id: key });

// ---------------------------------------------------------------------------
// 읽기

export function n(db: Db, table: string): number {
  return Number(db.get<{ c: bigint }>(`SELECT count(*) AS c FROM ${table}`)!.c);
}

/** 고정본·blob·사건·영수증·라운드 내용 수와 객체 폴더 파일 목록 — "순수 조회/롤백" 단언용. */
export function footprint(env: Env): { snapshots: number; blobs: number; events: number; commits: number; round_contents: number; files: string[]; rounds: string } {
  return {
    snapshots: n(env.db, "snapshots"),
    blobs: n(env.db, "blobs"),
    events: n(env.db, "events"),
    commits: n(env.db, "mutation_commits"),
    round_contents: n(env.db, "round_contents"),
    files: list_files(env.objects).sort(),
    rounds: JSON.stringify(env.db.all("SELECT id, state, sealed_snapshot_id, rev FROM rounds ORDER BY id"), (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  };
}

export interface SnapshotRow {
  id: string;
  edition_id: string;
  stage_id: string | null;
  round_id: string | null;
  scope: string;
  manifest_blob_id: string;
  content_hash: string;
}

export function snapshot_row(db: Db, id: string): SnapshotRow {
  const row = db.get<SnapshotRow>("SELECT id, edition_id, stage_id, round_id, scope, manifest_blob_id, content_hash FROM snapshots WHERE id = ?", id);
  assert.ok(row, `snapshot ${id} exists`);
  return { ...row };
}

export function blob_bytes(env: Env, blob_id: string): Uint8Array {
  const row = blob_row(env.db, blob_id);
  assert.ok(row, `blob ${blob_id} exists`);
  return readFileSync(disk_path(env, row));
}

/** 고정본의 manifest blob 을 읽어 JSON 으로. */
export function stored_manifest(env: Env, snapshot_id: string): Out {
  const snap = snapshot_row(env.db, snapshot_id);
  return JSON.parse(new TextDecoder().decode(blob_bytes(env, snap.manifest_blob_id))) as Out;
}

export function stored_html(env: Env, manifest: Out): string {
  assert.ok(manifest.output, "a committed manifest names its output blob");
  return new TextDecoder().decode(blob_bytes(env, manifest.output.blob_id));
}

export function items_of(manifest: Out, category: string): Out[] {
  return (manifest.items as Out[]).filter((i) => i.category === category);
}

export function stage_of(env: Env, key: "plan" | "research" | "analyze" | "write" | "verify" | "publish", edition_id = env.p.edition_id): string {
  return stage_ids(env.db, edition_id)[key];
}

export function round_state(db: Db, round_id: string): { state: string; sealed_snapshot_id: string | null; rev: string } {
  const r = db.get<{ state: string; sealed_snapshot_id: string | null; rev: bigint }>("SELECT state, sealed_snapshot_id, rev FROM rounds WHERE id = ?", round_id)!;
  return { state: r.state, sealed_snapshot_id: r.sealed_snapshot_id, rev: r.rev.toString() };
}

export function commit_rows(db: Db, action: string): Array<{ id: string; client_request_id: string }> {
  return db.all<{ id: string; client_request_id: string }>("SELECT id, client_request_id FROM mutation_commits WHERE action = ? ORDER BY rowid", action).map((r) => ({ ...r }));
}

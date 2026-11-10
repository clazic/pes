// Harness for the object-storage (stage 2 PR9) tests. Everything is synthetic: invented bytes,
// invented project slugs, a temporary HOME/PES_HOME, and a FakeClock. Nothing here touches the real
// ~/.pes or ~/pes-projects.

import assert from "node:assert/strict";
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { FakeClock } from "../../scripts/pes_core/clock.ts";
import {
  CommandService,
  type CommandOutcome,
  type MutationContext,
  type PolicyChecker,
} from "../../scripts/pes_core/commands.ts";
import { add_artifact, append_version, create_object } from "../../scripts/pes_core/content.ts";
import { connect, migrate, type Db, type RunResult, type SqlValue } from "../../scripts/pes_core/db.ts";
import { ApiError } from "../../scripts/pes_core/errors.ts";
import {
  attach_version,
  complete_upload,
  reserve_upload,
  store_blob,
  type FileStore,
} from "../../scripts/pes_core/files.ts";
import { db_path, objects_dir } from "../../scripts/pes_core/paths.ts";
import { sha256_hex } from "./backup_fixture.ts";
import { isolated_home, type IsolatedHome } from "./isolated_home.ts";

export const START_MS = 1_760_000_000_000;
export const MEDIA_TYPE = "application/octet-stream";

export class FakePolicy implements PolicyChecker {
  allowed = true;
  calls = 0;
  check(_ctx: MutationContext, _command: string, _payload: unknown) {
    this.calls += 1;
    return this.allowed
      ? ({ allowed: true } as const)
      : ({ allowed: false, reason: "synthetic policy: file writes are OFF" } as const);
  }
}

export interface Project {
  project_id: string;
  actor_id: string;
  edition_id: string;
}

export interface Env {
  home: IsolatedHome;
  db: Db;
  clock: FakeClock;
  policy: FakePolicy;
  service: CommandService;
  store: FileStore;
  objects: string;
  p: Project;
  ctx(key: string): MutationContext;
  with_db(db: Db): CommandService;
  close(): void;
}

async function bootstrap(service: CommandService, key: string, slug: string): Promise<Project> {
  const out = await service.execute(
    { project_id: null, actor_id: null, via: "cli", client_request_id: key },
    "project.bootstrap",
    { slug, topic: "합성 파일 주제", owner_display_name: "합성 소유자" },
  );
  const r = out.result as { project_id: string; owner_actor_id: string; edition_id: string };
  return { project_id: r.project_id, actor_id: r.owner_actor_id, edition_id: r.edition_id };
}

export function ctx_for(p: Project, key: string): MutationContext {
  return { project_id: p.project_id, actor_id: p.actor_id, via: "cli", client_request_id: key };
}

export async function make_env(): Promise<Env> {
  const home = isolated_home("pes-sel42-");
  const db = connect(db_path(home.env));
  migrate(db);
  const clock = new FakeClock(START_MS);
  const policy = new FakePolicy();
  const objects = objects_dir(home.env);
  mkdirSync(objects, { recursive: true });
  // The objects folder given here is the service's one canonical store (SEL-42 review 1).
  const service = new CommandService(db, { clock, policy, objects_dir: objects });
  const p = await bootstrap(service, "setup-p", "synthetic-files");
  policy.calls = 0;
  return {
    home,
    db,
    clock,
    policy,
    service,
    store: { db, objects_dir: objects },
    objects,
    p,
    ctx: (key) => ctx_for(p, key),
    with_db: (wrapped) => new CommandService(wrapped, { clock, policy, objects_dir: objects }),
    close() {
      db.close();
      home.cleanup();
    },
  };
}

export async function with_env(fn: (env: Env) => Promise<void> | void): Promise<void> {
  const env = await make_env();
  try {
    await fn(env);
  } finally {
    env.close();
  }
}

/** A second project in the same database (its blobs must never be reachable from the first). */
export async function second_project(env: Env, slug = "synthetic-files-b"): Promise<Project> {
  return bootstrap(env.service, `setup-${slug}`, slug);
}

export function wrap_db(db: Db, rule: (sql: string) => RunResult | void): Db {
  return {
    path: db.path,
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    run: (sql, ...params: SqlValue[]) => rule(sql) ?? db.run(sql, ...params),
    get: <T>(sql: string, ...params: SqlValue[]) => db.get<T>(sql, ...params),
    all: <T>(sql: string, ...params: SqlValue[]) => db.all<T>(sql, ...params),
    close: () => db.close(),
  };
}

export async function rejects_api(p: Promise<unknown> | unknown, ...codes: string[]): Promise<ApiError> {
  try {
    await p;
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError ${codes.join("|")}, got ${String(error)}`);
    assert.ok(codes.includes(error.code), `expected ${codes.join("|")}, got ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected the call to be rejected with ${codes.join("|")}`);
}

export async function rejects_any(p: Promise<unknown> | unknown): Promise<unknown> {
  try {
    await p;
  } catch (error) {
    return error;
  }
  assert.fail("expected the call to be rejected");
}

/** Deterministic synthetic bytes, unique per label. */
export function bytes_of(label: string, extra_len = 0): Uint8Array {
  const head = new TextEncoder().encode(`합성 바이트 ${label}\n`);
  const out = new Uint8Array(head.byteLength + extra_len);
  out.set(head);
  for (let i = 0; i < extra_len; i += 1) out[head.byteLength + i] = (i * 31 + 7) & 0xff;
  return out;
}

// ---------------------------------------------------------------------------
// Result shapes (see the interface summary at the top of tests/test_blobs.test.ts)

export interface ReserveResult {
  project_id: string;
  blob_id: string;
  state: "staging" | "ready" | "quarantined";
  deduplicated: boolean;
}
export interface CompleteResult {
  project_id: string;
  blob_id: string;
  state: "ready" | "quarantined";
}
export interface AttachResult {
  project_id: string;
  version_id: string;
  blob_id: string;
  role: string;
  file_policy_id: string;
}
export interface GcResult {
  project_id: string;
  deleted_blob_ids: string[];
  orphan_files_removed: number;
  missing_file_blob_ids: string[];
}

export interface BlobRow {
  id: string;
  project_id: string;
  storage_key: string;
  sha256: string;
  size: bigint;
  media_type: string;
  original_name: string | null;
  state: string;
  created_by: string;
}

export function blob_row(db: Db, id: string): BlobRow | undefined {
  return db.get<BlobRow>("SELECT * FROM blobs WHERE id = ?", id);
}

export function blob_row_must(db: Db, id: string): BlobRow {
  const row = blob_row(db, id);
  assert.ok(row, `blobs row ${id} exists`);
  return row;
}

/** Disk location of a blob: computed from the DB storage_key only. */
export function disk_path(env: Env, row: Pick<BlobRow, "storage_key">): string {
  return join(env.objects, ...row.storage_key.split("/"));
}

/**
 * Put bytes at a blob's storage location without going through store_blob, the way an outside
 * process (or an old, unchecked writer) could. store_blob itself refuses bytes that do not match
 * the reservation, so tests that need mismatching bytes on disk must plant them like this.
 */
export function plant_bytes(env: Env, row: Pick<BlobRow, "storage_key">, bytes: Uint8Array): string {
  const path = disk_path(env, row);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

export function exists_on_disk(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Every regular file below dir, as paths relative to dir with "/" separators. */
export function list_files(dir: string, base = dir): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isDirectory()) out.push(...list_files(full, base));
    else out.push(full.slice(base.length + 1).replace(/\\/g, "/"));
  }
  return out.sort();
}

export async function reserve(
  env: Env,
  bytes: Uint8Array,
  key: string,
  extra: Record<string, unknown> = {},
  p: Project = env.p,
): Promise<ReserveResult> {
  const out = await reserve_upload(env.service, ctx_for(p, key), {
    sha256: sha256_hex(bytes),
    size: bytes.byteLength,
    media_type: MEDIA_TYPE,
    original_name: "합성.bin",
    ...extra,
  });
  return out.result as ReserveResult;
}

export async function complete(env: Env, blob_id: string, key: string, p: Project = env.p): Promise<CommandOutcome> {
  return complete_upload(env.service, env.store, ctx_for(p, key), { blob_id });
}

/** reserve -> store -> complete, asserting the blob is ready. */
export async function put_ready(env: Env, bytes: Uint8Array, key: string, p: Project = env.p): Promise<ReserveResult> {
  const r = await reserve(env, bytes, `${key}-r`, {}, p);
  if (r.state !== "ready") {
    await store_blob(env.store, p.project_id, r.blob_id, bytes);
    const done = (await complete(env, r.blob_id, `${key}-c`, p)).result as CompleteResult;
    assert.equal(done.state, "ready", "put_ready: the honest upload becomes ready");
  }
  assert.equal(blob_row_must(env.db, r.blob_id).state, "ready");
  return r;
}

/** reserve + store only: a staging blob with its bytes on disk. */
export async function put_staging(env: Env, bytes: Uint8Array, key: string): Promise<ReserveResult> {
  const r = await reserve(env, bytes, `${key}-r`);
  assert.equal(r.state, "staging");
  await store_blob(env.store, env.p.project_id, r.blob_id, bytes);
  return r;
}

// ---------------------------------------------------------------------------
// Versions (made with the PR7 content commands)

export interface VersionResult {
  object_id: string;
  version_id: string;
  version_no: number;
}

export async function new_artifact(env: Env, key: string): Promise<VersionResult> {
  const obj = (
    await create_object(env.service, env.ctx(`${key}-o`), { kind: "artifact", edition_id: env.p.edition_id })
  ).result as { object_id: string };
  const out = await add_artifact(env.service, env.ctx(`${key}-v`), {
    object_id: obj.object_id,
    artifact_kind: "chapter",
    title: `합성 장 ${key}`,
    summary: "합성 요약",
  });
  return out.result as VersionResult;
}

export async function more_version(env: Env, key: string, object_id: string): Promise<VersionResult> {
  const out = await append_version(env.service, env.ctx(key), { object_id, title: `합성 제목 ${key}` });
  return out.result as VersionResult;
}

export async function attach(
  env: Env,
  version_id: string,
  blob_id: string,
  role: string,
  key: string,
  p: Project = env.p,
): Promise<AttachResult> {
  const out = await attach_version(env.service, ctx_for(p, key), { version_id, blob_id, role });
  return out.result as AttachResult;
}

export function version_file_rows(db: Db, blob_id: string) {
  return db.all<{ version_id: string; blob_id: string; role: string; file_policy_id: string }>(
    "SELECT version_id, blob_id, role, file_policy_id FROM version_files WHERE blob_id = ? ORDER BY version_id, role",
    blob_id,
  );
}

export function receipts(db: Db, project_id: string, action: string): number {
  const row = db.get<{ n: bigint }>(
    "SELECT count(*) AS n FROM mutation_commits WHERE project_id = ? AND action = ?",
    project_id,
    action,
  );
  return Number(row?.n ?? 0n);
}

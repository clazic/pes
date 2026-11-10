// Thin Node side of scripts/pes.py's DB write path (stage 2 PR15).
//
// scripts/pes.py never imports TypeScript. With PES_DB_CORE=1 it runs this file
// once per CLI call: one JSON request on stdin, one JSON reply on stdout.
//
//   request : { op, slug?, session?, token?, args? }
//   reply   : { ok: true, data } | { ok: false, code, message, exit }
//
// Every business write goes through CommandService (the public wrappers in
// content.ts, editions.ts, files.ts, questions.ts, records.ts, runs.ts, results.ts);
// this file holds no business SQL. The few SELECTs below only look things up
// (project by slug, stage by key, the open round, the live lease, current
// versions for a manifest) — they never write.
//
// Credentials (stage-2 decision, tests/test_cli_write.test.ts):
//   no token  -> the human owner of the project in this computer's database
//   token     -> that agent actor, after verify_agent_token + the needed scope
//   session   -> PES_OWNER, only a lock label; it is never a credential.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

import { resolve_actor, verify_agent_token } from "./actors.ts";
import { ApiApp } from "./api.ts";
import { SystemClock } from "./clock.ts";
import {
  CommandService,
  type CommandOutcome,
  type MutationContext,
} from "./commands.ts";
import {
  add_artifact,
  add_citation,
  add_source,
  append_version,
  create_object,
  import_library,
  link_relation,
  set_current,
  submit_results,
} from "./content.ts";
import { connect, load_migrations, migrate, probe_database, type Db } from "./db.ts";
import { approve_stage, reopen_stage, seal_round, start_round } from "./editions.ts";
import { UnitOfWorkDb } from "./commands/unit.ts";
import { ApiError } from "./errors.ts";
import { attach_version, complete_upload, delete_storage_file, read_storage_bytes, reserve_upload, store_blob, sha256_hex } from "./files.ts";
import { serving_path } from "./migration.ts";
import { build_project_view, not_a_report_sql } from "./legacy_view.ts";
import { db_path, objects_dir, pes_dir, type Environment } from "./paths.ts";
import { DbPolicyChecker } from "./policy.ts";
import { publish_set } from "./questions.ts";
import {
  add_note,
  mark_processed,
  prepare_question_draft,
  record_chat,
  record_qa,
  record_qa_brief,
} from "./records.ts";
import { assemble_manuscript, final_report_html, local_stamp, REPORT_NAME, stage_report, type Dict } from "./report.ts";
import { claim, complete, heartbeat, interrupt, wait } from "./runs.ts";

interface Request {
  op: string;
  slug?: string;
  session?: string;
  token?: string;
  args?: Record<string, unknown>;
}

class Refusal extends Error {
  readonly code: string;
  readonly exit: number;
  constructor(code: string, message: string, exit = 1) {
    super(message);
    this.code = code;
    this.exit = exit;
  }
}

/** The old CLI's 2-hour session lock, now the run lease's lifetime. */
const LOCK_LEASE_MS = 2 * 60 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 30 * 60 * 1000;
/** runs.external_session_ref limit enforced by run.claim. */
const SESSION_MAX = 200;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STAGE_KEYS = ["plan", "research", "analyze", "write", "verify", "publish"];
const VERIFIED_METHODS = new Set(["browser", "kosis", "law", "vworld"]);
const SOURCE_METHODS = new Set(["search", "fetch", "browser", "kosis", "law", "vworld", "import", "unknown"]);
const ARTIFACT_KINDS = new Set([
  "rq", "chapter", "topic", "issue", "table", "section", "claim", "report", "review", "note",
  "schedule", "insight", "output",
]);
const ARTIFACT_STATUSES = new Set([
  "new", "deepen", "revise", "browser", "done", "removed", "failed", "draft", "published", "archived",
]);

interface ProjectInfo {
  id: string;
  slug: string;
  topic: string;
  owner_user_id: string;
  active_edition_id: string | null;
  status: string;
}

interface Auth {
  actor_id: string;
  kind: string;
  scopes: string[] | null;
}

interface StageInfo {
  id: string;
  key: string;
  ordinal: number;
  status: string;
  current_round_id: string | null;
  edition_id: string;
}

interface LeaseInfo {
  lease_id: string;
  run_id: string;
  owner_actor_id: string;
  fence: number;
  heartbeat_at: number;
  expires_at: number;
  session: string | null;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text_arg(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Refusal("invalid_payload", `${field} 값이 필요합니다`, 2);
  }
  return value;
}

class Session {
  readonly env: Environment;
  readonly db: UnitOfWorkDb;
  readonly clock = new SystemClock();
  readonly service: CommandService;
  readonly objects: string;
  /** Object files this run wrote; they are removed again when the run fails (the rows roll back). */
  readonly fresh_files: Array<{ project_id: string; storage_key: string }> = [];

  constructor(env: Environment, db: Db) {
    this.env = env;
    this.db = new UnitOfWorkDb(db);
    this.objects = objects_dir(env);
    mkdirSync(this.objects, { recursive: true });
    this.service = new CommandService(this.db, {
      clock: this.clock,
      policy: new DbPolicyChecker(),
      objects_dir: this.objects,
      run_config: { lease_ttl_ms: LOCK_LEASE_MS, heartbeat_interval_ms: LOCK_HEARTBEAT_MS },
    });
  }

  now(): number {
    return this.clock.now_ms();
  }

  /** After a failed run: delete the object files it wrote unless a committed blob row now claims them. */
  discard_fresh_files(): void {
    for (const file of this.fresh_files) {
      const claimed = this.db.get("SELECT 1 AS ok FROM blobs WHERE storage_key = ?", file.storage_key);
      if (claimed === undefined) delete_storage_file(this.objects, file.project_id, file.storage_key);
    }
    this.fresh_files.length = 0;
  }

  unit<T>(fn: () => Promise<T>): Promise<T> {
    return this.db.unit(fn);
  }

  ctx(project: ProjectInfo | null, auth: Auth | null, base?: number): MutationContext {
    const ctx: MutationContext = {
      project_id: project === null ? null : project.id,
      actor_id: auth === null ? null : auth.actor_id,
      via: "cli",
      client_request_id: `cli-${randomUUID()}`,
    };
    if (base !== undefined) ctx.base_control_rev = base;
    return ctx;
  }

  project(slug: unknown): ProjectInfo {
    if (typeof slug !== "string" || slug.length === 0) {
      throw new Refusal("invalid_payload", "프로젝트 이름이 필요합니다", 2);
    }
    const row = this.db.get<ProjectInfo>(
      "SELECT id, slug, topic, owner_user_id, active_edition_id, status FROM projects WHERE slug = ?",
      slug,
    );
    if (row === undefined) {
      throw new Refusal(
        "not_found",
        `DB에 없는 프로젝트입니다: ${slug} — 옛 project.json 프로젝트는 이전하기 전에는 쓸 수 없습니다`,
      );
    }
    return { ...row };
  }

  /** No token: the project's human owner. Token: that agent, with the needed scope. */
  auth(project: ProjectInfo, token: string | undefined, scope: string | null): Auth {
    if (token === undefined || token.length === 0) {
      const row = this.db.get<{ actor_id: string }>(
        `SELECT a.id AS actor_id
           FROM actors a
           JOIN project_members m ON m.user_id = a.user_id
           JOIN users u ON u.id = a.user_id
          WHERE m.project_id = ? AND m.role = 'owner' AND a.kind = 'human'
            AND a.disabled_at IS NULL AND u.disabled_at IS NULL
          ORDER BY a.id LIMIT 1`,
        project.id,
      );
      if (row === undefined) {
        throw new Refusal("unauthenticated", "이 프로젝트의 사람 소유자를 찾을 수 없습니다");
      }
      return { actor_id: row.actor_id, kind: "human", scopes: null };
    }
    let scopes: string[];
    let actor_id: string;
    try {
      const verified = verify_agent_token(this.db, token, { project_id: project.id, now_ms: this.now() });
      scopes = verified.scopes;
      actor_id = verified.actor_id;
    } catch {
      throw new Refusal("unauthenticated", "PES_TOKEN 이 올바르지 않습니다");
    }
    let kind: string;
    try {
      const resolved = resolve_actor(this.db, { project_id: project.id, actor_id }, this.now());
      kind = resolved.kind;
      actor_id = resolved.actor_id;
    } catch {
      throw new Refusal("forbidden", "이 토큰의 에이전트는 프로젝트 구성원이 아닙니다");
    }
    if (scope !== null && !scopes.includes(scope)) {
      throw new Refusal("forbidden", `토큰에 ${scope} 권한이 없습니다`);
    }
    return { actor_id, kind, scopes };
  }

  stage(project: ProjectInfo, key: unknown): StageInfo {
    if (project.active_edition_id === null) {
      throw new Refusal("conflict", "프로젝트에 활성 판이 없습니다");
    }
    let stage_key = key;
    if (stage_key === undefined || stage_key === null) {
      const row = this.db.get<{ key: string }>(
        `SELECT s.key AS key FROM editions e JOIN stages s
            ON s.project_id = e.project_id AND s.id = e.current_stage_id
          WHERE e.project_id = ? AND e.id = ?`,
        project.id,
        project.active_edition_id,
      );
      stage_key = row?.key;
    }
    if (typeof stage_key !== "string" || !STAGE_KEYS.includes(stage_key)) {
      throw new Refusal("invalid_payload", `단계 이름은 ${STAGE_KEYS.join(", ")} 중 하나`, 2);
    }
    const row = this.db.get<{
      id: string;
      key: string;
      ordinal: bigint;
      status: string;
      current_round_id: string | null;
      edition_id: string;
    }>(
      `SELECT id, key, ordinal, status, current_round_id, edition_id
         FROM stages WHERE project_id = ? AND edition_id = ? AND key = ?`,
      project.id,
      project.active_edition_id,
      stage_key,
    );
    if (row === undefined) throw new Refusal("not_found", "단계를 찾을 수 없습니다");
    return { ...row, ordinal: Number(row.ordinal) };
  }

  lease(project: ProjectInfo): LeaseInfo | null {
    const row = this.db.get<{
      lease_id: string;
      run_id: string | null;
      owner_actor_id: string | null;
      fence: bigint;
      heartbeat_at: bigint;
      expires_at: bigint;
      state: string;
    }>(
      `SELECT lease_id, run_id, owner_actor_id, fence, heartbeat_at, expires_at, state
         FROM project_leases WHERE project_id = ?`,
      project.id,
    );
    if (
      row === undefined ||
      row.state !== "active" ||
      row.run_id === null ||
      row.owner_actor_id === null ||
      this.now() >= Number(row.expires_at)
    ) {
      return null;
    }
    const run = this.db.get<{ external_session_ref: string | null }>(
      "SELECT external_session_ref FROM runs WHERE project_id = ? AND id = ?",
      project.id,
      row.run_id,
    );
    return {
      lease_id: row.lease_id,
      run_id: row.run_id,
      owner_actor_id: row.owner_actor_id,
      fence: Number(row.fence),
      heartbeat_at: Number(row.heartbeat_at),
      expires_at: Number(row.expires_at),
      session: run?.external_session_ref ?? null,
    };
  }

  /** The lease belongs to this caller: same session label, or (no label) the same actor. */
  is_mine(lease: LeaseInfo, auth: Auth, session: string | undefined): boolean {
    if (session !== undefined && session.length > 0) return lease.session === session;
    return lease.session === null && lease.owner_actor_id === auth.actor_id;
  }

  /** The old CLI's implicit lock: a write under PES_OWNER takes the lease when nobody holds it. */
  async take_lock(project: ProjectInfo, auth: Auth, session: string): Promise<Record<string, unknown>> {
    return result_of(
      await claim(this.service, this.ctx(project, auth), {
        mode: "B",
        runtime: "pes-cli",
        provider: "local",
        model: "session-lock",
        external_session_ref: session,
      }),
    );
  }

  /**
   * Every content write passes through here.
   *  - A token agent (kind other than human) writes only while it owns the live
   *    lease; the returned guard (run, lease, fence) goes into the payload of the
   *    commands whose service-side check demands it. No lease is never created for it.
   *  - A human owner needs no lease. With PES_OWNER set the write takes the lease
   *    when nobody holds it (v0.15's implicit lock) and keeps it alive; another
   *    session's live lease refuses the write (exit 3).
   */
  async lock_check(project: ProjectInfo, auth: Auth, session: string | undefined): Promise<Record<string, unknown>> {
    const lease = this.lease(project);
    const labelled = session !== undefined && session.length > 0;
    if (auth.kind !== "human") {
      if (lease === null) {
        throw new Refusal("forbidden", "이 에이전트에게는 이 프로젝트의 잠금(lease)이 없습니다 — claim 먼저 하세요");
      }
      if (lease.owner_actor_id !== auth.actor_id) this.refuse_locked(project, lease);
      return { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence };
    }
    if (lease === null) {
      if (labelled) await this.take_lock(project, auth, session);
      return {};
    }
    if (!this.is_mine(lease, auth, session)) this.refuse_locked(project, lease);
    if (labelled && this.now() - lease.heartbeat_at > LOCK_HEARTBEAT_MS) {
      await heartbeat(this.service, this.ctx(project, auth), {
        run_id: lease.run_id,
        lease_id: lease.lease_id,
        fence: lease.fence,
      });
    }
    return {};
  }

  refuse_locked(project: ProjectInfo, lease: LeaseInfo): never {
    const minutes = Math.max(0, Math.floor((this.now() - lease.heartbeat_at) / 60_000));
    throw new Refusal(
      "locked",
      `다른 세션이 이 프로젝트를 쓰고 있습니다 (세션 ${(lease.session ?? "에이전트 run").slice(0, 8)}…, ` +
        `마지막 기록 ${minutes}분 전). 그 세션을 닫았다면 \`lock ${project.slug} --force\`로 가져오세요.`,
      3,
    );
  }
}

function result_of(out: CommandOutcome): Record<string, unknown> {
  return is_record(out.result) ? out.result : {};
}

function normalize_run_result(result: Record<string, unknown>): Record<string, unknown> {
  const out = { ...result };
  if (typeof out.fence === "number") out.fence = String(out.fence);
  return out;
}

// ---------------------------------------------------------------------------
// op handlers

type Handler = (s: Session, req: Request) => Promise<unknown>;

const WRITE_SCOPE = "run:submit";

async function write_auth(
  s: Session,
  req: Request,
): Promise<{ project: ProjectInfo; auth: Auth; guard: Record<string, unknown> }> {
  const project = s.project(req.slug);
  // A project that is not active yet (still being migrated) is served from project.json: no writes here.
  if (project.status !== "active") {
    throw new Refusal(
      "conflict",
      `이전이 끝나지 않은 프로젝트입니다: ${project.slug} — 옛 project.json 프로젝트는 이전을 마쳐 활성화하기 전에는 쓸 수 없습니다`,
    );
  }
  const auth = s.auth(project, req.token, WRITE_SCOPE);
  const guard = await s.lock_check(project, auth, req.session);
  return { project, auth, guard };
}

const slugs: Handler = async (s) => {
  const rows = s.db.all<{ slug: string }>("SELECT slug FROM projects ORDER BY slug");
  return { slugs: rows.map((row) => row.slug) };
};

const live_locks: Handler = async (s) => {
  const rows = s.db.all<{ slug: string; id: string }>("SELECT slug, id FROM projects");
  const locks: Record<string, string> = {};
  for (const row of rows) {
    const lease = s.lease({ id: row.id, slug: row.slug, topic: "", owner_user_id: "", active_edition_id: null, status: "active" });
    // An agent's lease carries no session label; it still makes the project busy.
    if (lease !== null) locks[row.slug] = lease.session ?? `agent-run:${lease.run_id}`;
  }
  return { locks };
};

const overview: Handler = async (s, req) => {
  const project = s.project(req.slug);
  const stages = s.db.all<{ key: string; status: string; round_no: bigint | null; stale: bigint | null }>(
    `SELECT s.key AS key, s.status AS status, s.stale_since_event_seq AS stale,
            (SELECT max(round_no) FROM rounds r WHERE r.project_id = s.project_id AND r.stage_id = s.id) AS round_no
       FROM stages s WHERE s.project_id = ? AND s.edition_id = ? ORDER BY s.ordinal`,
    project.id,
    project.active_edition_id,
  );
  const current = s.stage(project, undefined).key;
  return {
    topic: project.topic,
    current,
    stages: stages.map((st) => ({
      key: st.key,
      status: st.status,
      round_no: Number(st.round_no ?? 0n),
      stale: st.stale !== null,
    })),
  };
};

const init: Handler = async (s, req) => {
  // init makes a project with a local human owner. A token never takes that path:
  // a project-scoped agent token cannot create projects or owners.
  if (req.token !== undefined && req.token.length > 0) {
    throw new Refusal("forbidden", "init 은 토큰 없이 이 컴퓨터의 사람만 할 수 있습니다 — PES_TOKEN 을 지우고 다시 하세요");
  }
  const args = req.args ?? {};
  const slug = text_arg(args, "slug");
  const topic = text_arg(args, "topic");
  if (!SLUG.test(slug)) {
    throw new Refusal("invalid_payload", "프로젝트 이름은 소문자·숫자·하이픈(1~64자)만 쓸 수 있습니다", 2);
  }
  if (s.db.get("SELECT 1 AS ok FROM projects WHERE slug = ?", slug) !== undefined) {
    throw new Refusal("conflict", `이미 프로젝트가 있습니다: ${slug}`, 2);
  }
  return s.unit(async () => {
    const out = await s.service.execute(s.ctx(null, null), "project.bootstrap", {
      slug,
      topic,
      owner_display_name: "로컬 소유자",
    });
    const created = result_of(out);
    let imported = 0;
    if (is_record(args.library)) {
      const project = s.project(slug);
      const auth = s.auth(project, undefined, null);
      const lib = await import_library(s.service, s.ctx(project, auth), { library: args.library });
      imported = Array.isArray(result_of(lib).items) ? (result_of(lib).items as unknown[]).length : 0;
    }
    return { project_id: created.project_id, imported };
  });
};

const round_start: Handler = async (s, req) => {
  const { project, auth } = await write_auth(s, req);
  const stage = s.stage(project, req.args?.stage);
  const out = await start_round(s.service, s.ctx(project, auth), { stage_id: stage.id });
  return { round_no: result_of(out).round_no, round_id: result_of(out).round_id };
};

interface VersionRef {
  object_id: string;
  version_id: string;
}

/**
 * The current versions that make up one stage's round snapshot: the stage's own
 * content artifacts in the active edition (an artifact with no stage belongs to no
 * stage's snapshot), and the sources those artifacts' current versions cite. Other stages' items never
 * enter this stage's snapshot.
 */
function manifest_versions(s: Session, project: ProjectInfo, stage: StageInfo): VersionRef[] {
  return manifest_parts(s, project, stage).all;
}

function manifest_parts(
  s: Session,
  project: ProjectInfo,
  stage: StageInfo,
): { all: VersionRef[]; items: number } {
  const artifacts = s.db.all<VersionRef>(
    `SELECT o.id AS object_id, o.current_version_id AS version_id
       FROM objects o
       JOIN artifacts a ON a.project_id = o.project_id AND a.object_id = o.id
       JOIN artifact_versions cv ON cv.project_id = o.project_id AND cv.version_id = o.current_version_id
      WHERE o.project_id = ? AND o.edition_id = ? AND a.stage_id = ?
        AND o.kind = 'artifact' AND a.kind NOT IN ('note', 'review')
        AND o.archived_at IS NULL AND o.current_version_id IS NOT NULL
        AND ${not_a_report_sql("cv")}
      ORDER BY o.display_no`,
    project.id,
    stage.edition_id,
    stage.id,
  );
  const sources = s.db.all<VersionRef>(
    `SELECT so.id AS object_id, so.current_version_id AS version_id
       FROM objects so
      WHERE so.project_id = ? AND so.kind = 'source' AND so.archived_at IS NULL
        AND so.current_version_id IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM objects o
            JOIN artifacts a ON a.project_id = o.project_id AND a.object_id = o.id
            JOIN citations c ON c.project_id = o.project_id AND c.artifact_version_id = o.current_version_id
            JOIN source_versions sv ON sv.project_id = c.project_id AND sv.version_id = c.source_version_id
           WHERE o.project_id = so.project_id AND o.edition_id = ? AND a.stage_id = ?
             AND o.kind = 'artifact' AND a.kind NOT IN ('note', 'review') AND o.archived_at IS NULL
             AND sv.object_id = so.id)
      ORDER BY so.display_no`,
    project.id,
    stage.edition_id,
    stage.id,
  );
  return { all: [...artifacts, ...sources].map((row) => ({ ...row })), items: artifacts.length };
}

const render: Handler = async (s, req) => {
  const { project, auth, guard } = await write_auth(s, req);
  const stage = s.stage(project, req.args?.stage);
  const round = s.db.get<{ id: string; round_no: bigint }>(
    "SELECT id, round_no FROM rounds WHERE project_id = ? AND stage_id = ? AND state = 'open'",
    project.id,
    stage.id,
  );
  if (round === undefined) {
    throw new Refusal("conflict", "열린 라운드가 없습니다 — round-start 먼저");
  }
  const parts = manifest_parts(s, project, stage);
  const versions = parts.all;
  if (versions.length === 0) {
    throw new Refusal("conflict", "봉인할 항목이 없습니다 — 결과를 먼저 병합하세요");
  }
  const bytes = new TextEncoder().encode(JSON.stringify({ versions }));
  // reserve -> store -> complete -> seal is one unit: when seal refuses (for
  // example the round was closed meanwhile) no blob row and no receipt remain.
  // The manifest file already written to disk is not rolled back; it has no row
  // pointing at it, so the next gc_orphans removes it.
  const sealed = await s.unit(async () => {
    const reserved = await reserve_upload(s.service, s.ctx(project, auth), {
      sha256: sha256_hex(bytes),
      size: bytes.byteLength,
      media_type: "application/json",
      original_name: "manifest.json",
    });
    const blob = result_of(reserved);
    const blob_id = String(blob.blob_id);
    if (blob.state !== "ready") {
      await store_blob({ db: s.db, objects_dir: s.objects }, project.id, blob_id, bytes);
      await complete_upload(s.service, { db: s.db, objects_dir: s.objects }, s.ctx(project, auth), { blob_id });
    }
    return seal_round(s.service, s.ctx(project, auth), {
      round_id: round.id,
      manifest_blob_id: blob_id,
      versions,
      ...guard,
    });
  });
  return {
    snapshot_id: result_of(sealed).snapshot_id,
    stage: stage.key,
    round_id: round.id,
    round_no: Number(round.round_no),
    versions: versions.length,
    items: parts.items,
  };
};

/**
 * The old `handoff_plan`, read from the approved snapshot (the sealed versions,
 * not whatever was merged after the seal): every plan topic that is not removed and not yet
 * linked from a research item becomes a research item (kind topic, status new,
 * question = the topic's question or summary, links.plan = [topic id, ...]).
 */
async function hand_over_plan(
  s: Session,
  project: ProjectInfo,
  auth: Auth,
  plan: StageInfo,
  snapshot_id: string,
): Promise<number> {
  const research = s.stage(project, "research");
  const topics = s.db.all<{
    title: string;
    question: string | null;
    summary: string;
    status: string;
    metadata_json: string;
  }>(
    `SELECT v.title AS title, v.question AS question, v.summary AS summary, v.status AS status,
            v.metadata_json AS metadata_json
       FROM snapshots sn
       JOIN round_contents rc ON rc.project_id = sn.project_id AND rc.round_id = sn.round_id
       JOIN objects o ON o.project_id = rc.project_id AND o.id = rc.object_id
       JOIN artifacts a ON a.project_id = o.project_id AND a.object_id = o.id
       JOIN artifact_versions v ON v.project_id = rc.project_id AND v.version_id = rc.version_id
      WHERE sn.project_id = ? AND sn.id = ? AND a.stage_id = ? AND o.kind = 'artifact' AND a.kind = 'topic'
      ORDER BY rc.position`,
    project.id,
    snapshot_id,
    plan.id,
  );
  const linked = new Set<string>();
  const existing = s.db.all<{ metadata_json: string }>(
    `SELECT v.metadata_json AS metadata_json
       FROM objects o
       JOIN artifacts a ON a.project_id = o.project_id AND a.object_id = o.id
       JOIN artifact_versions v ON v.project_id = o.project_id AND v.version_id = o.current_version_id
      WHERE o.project_id = ? AND a.stage_id = ? AND o.kind = 'artifact' AND a.kind NOT IN ('note', 'review')`,
    project.id,
    research.id,
  );
  for (const row of existing) {
    const links = (parse_json_field(row.metadata_json, {}) as Record<string, unknown>).links;
    const from_plan = is_record(links) ? links.plan : undefined;
    if (Array.isArray(from_plan)) for (const id of from_plan) linked.add(String(id));
  }
  let next_id = max_legacy_id(s, project, research);
  let made = 0;
  for (const topic of topics) {
    if (topic.status === "removed") continue;
    const meta = parse_json_field(topic.metadata_json, {}) as Record<string, unknown>;
    // The old rule looked at the item's own kind: only a plan item given as "topic".
    if (meta.legacy_kind !== "topic") continue;
    if (meta.legacy_id === undefined || meta.legacy_id === null || linked.has(String(meta.legacy_id))) continue;
    const topic_links = is_record(meta.links) && Array.isArray(meta.links.plan) ? meta.links.plan : [];
    next_id += 1;
    const created = await create_object(s.service, s.ctx(project, auth), {
      kind: "artifact",
      edition_id: research.edition_id,
    });
    await add_artifact(s.service, s.ctx(project, auth), {
      object_id: String(result_of(created).object_id),
      artifact_kind: "topic",
      stage_id: research.id,
      title: topic.title,
      summary: "",
      question: topic.question || topic.summary || "",
      body_md: null,
      status: "new",
      confidence: null,
      stats: [],
      conflicts: [],
      verify: null,
      metadata: {
        legacy_id: next_id,
        legacy_kind: "topic",
        depth: 0,
        stage: "research",
        links: { plan: [meta.legacy_id, ...topic_links.filter((id) => String(id) !== String(meta.legacy_id))] },
      },
    });
    linked.add(String(meta.legacy_id));
    made += 1;
  }
  return made;
}

const approve: Handler = async (s, req) => {
  const { project, auth } = await write_auth(s, req);
  const stage = s.stage(project, req.args?.stage);
  const round =
    stage.current_round_id === null
      ? undefined
      : s.db.get<{ state: string; sealed_snapshot_id: string | null }>(
          "SELECT state, sealed_snapshot_id FROM rounds WHERE project_id = ? AND id = ?",
          project.id,
          stage.current_round_id,
        );
  if (round === undefined || round.state !== "sealed" || round.sealed_snapshot_id === null) {
    throw new Refusal("conflict", "봉인된 라운드가 없어 승인할 수 없습니다 — render 먼저");
  }
  let made: number | null = null;
  const out = await s.unit(async () => {
    const approved = await approve_stage(s.service, s.ctx(project, auth), {
      stage_id: stage.id,
      snapshot_id: round.sealed_snapshot_id as string,
    });
    // Approving the plan hands its research questions to the research stage in
    // the same unit, as the old CLI's handoff_plan did.
    if (stage.key === "plan") made = await hand_over_plan(s, project, auth, stage, round.sealed_snapshot_id as string);
    return approved;
  });
  const result = result_of(out);
  let next: { key: string; status: string } | null = null;
  if (typeof result.next_stage_id === "string") {
    const row = s.db.get<{ key: string; status: string }>(
      "SELECT key, status FROM stages WHERE project_id = ? AND id = ?",
      project.id,
      result.next_stage_id,
    );
    next = row === undefined ? null : { ...row };
  }
  return { next, complete: result.edition_completed === true, handed_over: made };
};

const reopen: Handler = async (s, req) => {
  const { project, auth } = await write_auth(s, req);
  const stage = s.stage(project, req.args?.stage);
  await reopen_stage(s.service, s.ctx(project, auth), { stage_id: stage.id });
  const later = s.db.all<{ key: string }>(
    `SELECT key FROM stages
      WHERE project_id = ? AND edition_id = ? AND ordinal > ? AND status <> 'pending'
        AND stale_since_event_seq IS NOT NULL
      ORDER BY ordinal`,
    project.id,
    stage.edition_id,
    stage.ordinal,
  );
  return { marked: later.map((row) => row.key) };
};

const note: Handler = async (s, req) => {
  const { project, auth } = await write_auth(s, req);
  const out = await add_note(s.service, s.ctx(project, auth), { text: text_arg(req.args ?? {}, "text") });
  return { note_count: result_of(out).note_count };
};

const mark: Handler = async (s, req) => {
  const { project, auth } = await write_auth(s, req);
  const names = req.args?.names;
  const out = await mark_processed(s.service, s.ctx(project, auth), { names });
  return { count: result_of(out).count };
};

const chat: Handler = async (s, req) => {
  const { project, auth } = await write_auth(s, req);
  const args = req.args ?? {};
  const stage = s.stage(project, args.stage);
  const out = await record_chat(s.service, s.ctx(project, auth), {
    stage: stage.key,
    text: text_arg(args, "text"),
    kind: typeof args.kind === "string" && args.kind.length > 0 ? args.kind : "feedback",
  });
  return { object_id: result_of(out).object_id };
};

const ask_prep: Handler = async (s, req) => {
  const { project, auth } = await write_auth(s, req);
  const args = req.args ?? {};
  const out = await prepare_question_draft(s.service, s.ctx(project, auth), {
    stage: s.stage(project, args.stage).key,
    bank_key: text_arg(args, "bank_key"),
  });
  return { round_no: result_of(out).round_no };
};

const ask: Handler = async (s, req) => {
  const { project, auth, guard } = await write_auth(s, req);
  const args = req.args ?? {};
  const stage = s.stage(project, args.stage);
  const open = s.db.get<{ id: string }>(
    "SELECT id FROM rounds WHERE project_id = ? AND stage_id = ? AND state = 'open'",
    project.id,
    stage.id,
  );
  const payload: Record<string, unknown> = {
    stage_id: stage.id,
    purpose: args.purpose,
    form_key: args.form_key,
    questions: args.questions,
    ...guard,
  };
  if (open !== undefined) payload.round_id = open.id;
  const out = await publish_set(s.service, s.ctx(project, auth), payload);
  const result = result_of(out);
  return { set_id: result.set_id, version_no: result.set_version_no };
};

// merge -----------------------------------------------------------------

interface PrevArtifact {
  object_id: string;
  version_id: string;
  title: string;
  question: string | null;
  summary: string;
  body_md: string | null;
  status: string;
  confidence: string | null;
  stats: string;
  conflicts: string;
  verify: string;
  metadata_json: string;
}

function find_previous(s: Session, project: ProjectInfo, stage: StageInfo, legacy_id: unknown): PrevArtifact | undefined {
  if (legacy_id === undefined || legacy_id === null) return undefined;
  return s.db.get<PrevArtifact>(
    `SELECT o.id AS object_id, v.version_id AS version_id, v.title AS title, v.question AS question,
            v.summary AS summary, v.body_md AS body_md, v.status AS status, v.confidence AS confidence,
            v.stats AS stats, v.conflicts AS conflicts, v.verify AS verify, v.metadata_json AS metadata_json
       FROM objects o
       JOIN artifacts a ON a.project_id = o.project_id AND a.object_id = o.id
       JOIN artifact_versions v ON v.project_id = o.project_id AND v.version_id = o.current_version_id
      WHERE o.project_id = ? AND a.stage_id = ? AND o.kind = 'artifact' AND a.kind NOT IN ('note', 'review')
        AND json_extract(v.metadata_json, '$.legacy_id') = ?
      LIMIT 1`,
    project.id,
    stage.id,
    typeof legacy_id === "number" ? legacy_id : String(legacy_id),
  );
}

function clean_text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/<br\s*\/?>/gi, "\n");
}

function parse_json_field(text: string, fallback: unknown): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Highest numeric legacy id among a stage's items (0 when none): the old CLI's `max(items) + 1`. */
function max_legacy_id(s: Session, project: ProjectInfo, stage: StageInfo): number {
  const rows = s.db.all<{ legacy_id: unknown }>(
    `SELECT json_extract(v.metadata_json, '$.legacy_id') AS legacy_id
       FROM objects o
       JOIN artifacts a ON a.project_id = o.project_id AND a.object_id = o.id
       JOIN artifact_versions v ON v.project_id = o.project_id AND v.version_id = o.current_version_id
      WHERE o.project_id = ? AND a.stage_id = ? AND o.kind = 'artifact' AND a.kind NOT IN ('note', 'review')`,
    project.id,
    stage.id,
  );
  let highest = 0;
  for (const row of rows) {
    const value = typeof row.legacy_id === "bigint" ? Number(row.legacy_id) : row.legacy_id;
    if (typeof value === "number" && Number.isSafeInteger(value) && value > highest) highest = value;
  }
  return highest;
}

function same_json(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => same_json(x, b[i]));
  }
  if (is_record(a)) {
    if (!is_record(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => k in b && same_json(a[k], b[k]));
  }
  return false;
}

/** The old merge's accumulation: keep what is there, append what is new (compared as JSON), keep the order. */
function union_json(current: unknown, incoming: unknown[]): unknown[] {
  const out: unknown[] = Array.isArray(current) ? [...current] : [];
  for (const x of incoming) if (!out.some((y) => same_json(x, y))) out.push(x);
  return out;
}

/** links: per key a union; a scalar value counts as a one-element list (the old merge). */
function union_links(current: unknown, incoming: Record<string, unknown>): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  if (is_record(current)) {
    for (const [k, v] of Object.entries(current)) out[k] = Array.isArray(v) ? [...v] : [v];
  }
  for (const [k, v] of Object.entries(incoming)) {
    out[k] = union_json(out[k] ?? [], Array.isArray(v) ? v : [v]);
  }
  return out;
}

const CONFIDENCES = ["high", "medium", "low"];

/** What the old source dictionary carried besides title/url/method (the importer keeps the same four keys in the locator). */
function source_locator(src: Record<string, unknown>): Record<string, unknown> {
  const locator: Record<string, unknown> = {};
  for (const key of ["date", "note", "orgId", "tblId"]) if (src[key] !== undefined) locator[key] = src[key];
  return locator;
}

const merge: Handler = async (s, req) => {
  const { project, auth } = await write_auth(s, req);
  const args = req.args ?? {};
  const stage = s.stage(project, args.stage);
  const results = args.results;
  if (!Array.isArray(results)) throw new Refusal("invalid_payload", "results 배열이 필요합니다", 2);
  // Check every item before the first write; the unit below then makes the
  // whole merge one all-or-nothing change (the old CLI saved once at the end).
  const items: Record<string, unknown>[] = [];
  for (const raw of results) {
    if (!is_record(raw)) throw new Refusal("invalid_payload", "결과 항목은 JSON 객체여야 합니다", 2);
    // v0.15 kept whatever status it was given; an unknown value is refused here
    // instead of being turned into "done" (nothing is written yet at this point).
    const given_status = raw.status;
    if (given_status !== undefined && given_status !== null && given_status !== "") {
      if (typeof given_status !== "string" || !ARTIFACT_STATUSES.has(given_status)) {
        throw new Refusal("invalid_payload", `알 수 없는 status 값입니다: ${String(given_status)}`, 2);
      }
    }
    const given_confidence = raw.confidence;
    if (given_confidence !== undefined && given_confidence !== null && given_confidence !== "") {
      if (typeof given_confidence !== "string" || !CONFIDENCES.includes(given_confidence)) {
        throw new Refusal("invalid_payload", `알 수 없는 confidence 값입니다: ${String(given_confidence)}`, 2);
      }
    }
    items.push(raw);
  }
  let next_id: number | null = null;
  return s.unit(async () => {
  let merged = 0;
  for (const raw of items) {
    let legacy_id: unknown = raw.id;
    if (legacy_id === undefined || legacy_id === null) {
      // The old merge numbered an item without an id as the stage's highest + 1.
      next_id = (next_id ?? max_legacy_id(s, project, stage)) + 1;
      legacy_id = next_id;
    } else if (typeof legacy_id === "number" && next_id !== null && legacy_id > next_id) {
      next_id = legacy_id;
    }
    const prev = find_previous(s, project, stage, legacy_id);
    const prev_meta = prev === undefined ? {} : (parse_json_field(prev.metadata_json, {}) as Record<string, unknown>);
    const prev_fields: Partial<PrevArtifact> = prev ?? {};
    const status = typeof raw.status === "string" && raw.status.length > 0 ? raw.status : "done";
    const metadata: Record<string, unknown> = {
      ...prev_meta,
      legacy_id: legacy_id ?? prev_meta.legacy_id ?? null,
      legacy_kind: typeof raw.kind === "string" ? raw.kind : prev_meta.legacy_kind ?? "",
      depth: Number(prev_meta.depth ?? 0) + 1,
      stage: stage.key,
    };
    for (const key of ["order", "verdict", "path", "open_questions", "request"]) {
      if (raw[key] !== undefined && raw[key] !== null && raw[key] !== "") metadata[key] = raw[key];
    }
    // shots and links accumulate across rounds like the old merge (no duplicates).
    if (Array.isArray(raw.shots) && raw.shots.length > 0) metadata.shots = union_json(prev_meta.shots, raw.shots);
    if (is_record(raw.links) && Object.keys(raw.links).length > 0) metadata.links = union_links(prev_meta.links, raw.links);
    const confidence =
      typeof raw.confidence === "string" && raw.confidence.length > 0 ? raw.confidence : prev_fields.confidence ?? null;
    const fields: Record<string, unknown> = {
      title: clean_text(raw.title) || prev_fields.title || `항목 ${String(legacy_id)}`.trim(),
      summary: clean_text(raw.summary) ?? prev_fields.summary ?? "",
      question: clean_text(raw.question) ?? prev_fields.question ?? null,
      body_md: clean_text(raw.details) ?? prev_fields.body_md ?? null,
      status,
      confidence,
      stats: Array.isArray(raw.stats)
        ? raw.stats.map((x) => (is_record(x) ? { ...x, name: x.name ?? x.label ?? "" } : x))
        : parse_json_field(prev_fields.stats ?? "[]", []),
      conflicts: Array.isArray(raw.conflicts)
        ? union_json(parse_json_field(prev_fields.conflicts ?? "[]", []), raw.conflicts)
        : parse_json_field(prev_fields.conflicts ?? "[]", []),
      verify: raw.verify !== undefined ? raw.verify : parse_json_field(prev_fields.verify ?? "null", null),
      metadata,
    };
    let object_id: string;
    let version_id: string;
    let appended_version = false;
    const replaces_sources =
      (stage.key === "write" || metadata.legacy_kind === "section") && Array.isArray(raw.sources);
    const carried: Array<{ source_version_id: string; quote: string | null; locator: unknown }> = [];
    if (prev === undefined) {
      const kind =
        typeof raw.kind === "string" && ARTIFACT_KINDS.has(raw.kind) && raw.kind !== "note" && raw.kind !== "review"
          ? raw.kind
          : "topic";
      const created = await create_object(s.service, s.ctx(project, auth), {
        kind: "artifact",
        edition_id: stage.edition_id,
      });
      object_id = String(result_of(created).object_id);
      const added = await add_artifact(s.service, s.ctx(project, auth), {
        object_id,
        artifact_kind: kind,
        stage_id: stage.id,
        ...fields,
      });
      version_id = String(result_of(added).version_id);
    } else {
      object_id = prev.object_id;
      // A manuscript's footnotes point at positions in its source list, so a
      // new list replaces the old one; other items accumulate across rounds.
      if (!replaces_sources) {
        const old = s.db.all<{ source_version_id: string; quote: string | null; locator: string }>(
          `SELECT source_version_id, quote, locator FROM citations
            WHERE project_id = ? AND artifact_version_id = ? ORDER BY citation_no`,
          project.id,
          prev.version_id,
        );
        for (const c of old) {
          carried.push({ source_version_id: c.source_version_id, quote: c.quote, locator: parse_json_field(c.locator, {}) });
        }
      }
      const appended = await append_version(s.service, s.ctx(project, auth), {
        object_id,
        based_on_version_id: prev.version_id,
        ...fields,
      });
      version_id = String(result_of(appended).version_id);
      appended_version = true;
    }
    // Sources accumulate across rounds (the old merge de-duplicated by URL).
    const seen = new Set<string>();
    for (const c of carried) {
      const row = s.db.get<{ url: string | null }>(
        "SELECT url FROM source_versions WHERE project_id = ? AND version_id = ?",
        project.id,
        c.source_version_id,
      );
      if (row?.url) seen.add(row.url);
      await add_citation(s.service, s.ctx(project, auth), {
        artifact_version_id: version_id,
        source_version_id: c.source_version_id,
        quote: c.quote,
        locator: c.locator,
      });
    }
    for (const src of Array.isArray(raw.sources) ? raw.sources : []) {
      if (!is_record(src)) continue;
      const url = typeof src.url === "string" && src.url.length > 0 ? src.url : null;
      if (!replaces_sources) {
        if (url !== null && seen.has(url)) continue;
        if (url !== null) seen.add(url);
      }
      const method = typeof src.method === "string" && SOURCE_METHODS.has(src.method) ? src.method : "unknown";
      const verified = VERIFIED_METHODS.has(method);
      const quote = typeof src.quote === "string" && src.quote.length > 0 && verified ? src.quote : null;
      const made = await create_object(s.service, s.ctx(project, auth), {
        kind: "source",
        edition_id: stage.edition_id,
      });
      const source_object = String(result_of(made).object_id);
      const title = typeof src.title === "string" && src.title.length > 0 ? src.title : url ?? "(제목 없음)";
      const added = await add_source(s.service, s.ctx(project, auth), {
        object_id: source_object,
        source_kind: method === "law" ? "law" : method === "kosis" ? "stat" : "web",
        canonical_locator: url,
        title,
        url,
        locator: source_locator(src),
        method,
        verification_state: verified ? "verified" : "unverified",
        quote,
      });
      await add_citation(s.service, s.ctx(project, auth), {
        artifact_version_id: version_id,
        source_version_id: String(result_of(added).version_id),
        quote,
        locator: {},
      });
    }
    if (appended_version) {
      // A new version only becomes the item's current one when set here; render,
      // qa and the next merge all read the current version.
      await set_current(s.service, s.ctx(project, auth), { object_id, version_id });
    }
    merged += 1;
  }
  return { merged };
  });
};

// qa ---------------------------------------------------------------------

const qa_data: Handler = async (s, req) => {
  const project = s.project(req.slug);
  s.auth(project, req.token, null);
  const stage = s.stage(project, req.args?.stage);
  const round = s.db.get<{ n: bigint | null }>(
    "SELECT max(round_no) AS n FROM rounds WHERE project_id = ? AND stage_id = ?",
    project.id,
    stage.id,
  );
  const items = s.db.all<{
    object_id: string;
    display_no: bigint;
    kind: string;
    title: string;
    status: string;
    summary: string;
    confidence: string | null;
    sources: bigint;
    legacy_id: unknown;
  }>(
    `SELECT o.id AS object_id, o.display_no AS display_no, a.kind AS kind, v.title AS title,
            v.status AS status, v.summary AS summary, v.confidence AS confidence,
            (SELECT count(*) FROM citations c WHERE c.project_id = v.project_id AND c.artifact_version_id = v.version_id) AS sources,
            json_extract(v.metadata_json, '$.legacy_id') AS legacy_id
       FROM objects o
       JOIN artifacts a ON a.project_id = o.project_id AND a.object_id = o.id
       JOIN artifact_versions v ON v.project_id = o.project_id AND v.version_id = o.current_version_id
      WHERE o.project_id = ? AND a.stage_id = ? AND o.kind = 'artifact'
        AND a.kind NOT IN ('note', 'review') AND v.status <> 'removed'
        AND ${not_a_report_sql("v")}
      ORDER BY o.display_no`,
    project.id,
    stage.id,
  );
  const notes = s.db.all<{ body_md: string | null }>(
    `SELECT v.body_md AS body_md
       FROM artifacts a JOIN artifact_versions v
         ON v.project_id = a.project_id AND v.object_id = a.object_id
      WHERE a.project_id = ? AND a.kind = 'note'
        AND json_extract(v.metadata_json, '$.role') = 'handoff_note'
      ORDER BY v.rowid DESC LIMIT 5`,
    project.id,
  );
  return {
    topic: project.topic,
    stage: stage.key,
    round_no: Number(round?.n ?? 0n),
    items: items.map((row) => ({
      id: typeof row.legacy_id === "bigint" ? Number(row.legacy_id) : (row.legacy_id ?? Number(row.display_no)),
      kind: row.kind,
      title: row.title,
      status: row.status,
      summary: row.summary,
      confidence: row.confidence,
      sources: Number(row.sources),
    })),
    notes: notes.map((row) => row.body_md ?? "").reverse(),
  };
};

const qa_brief: Handler = async (s, req) => {
  const { project, auth } = await write_auth(s, req);
  const args = req.args ?? {};
  const out = await record_qa_brief(s.service, s.ctx(project, auth), {
    stage: s.stage(project, args.stage).key,
    text: text_arg(args, "text"),
  });
  return { round_no: result_of(out).round_no };
};

const qa: Handler = async (s, req) => {
  const { project, auth } = await write_auth(s, req);
  const args = req.args ?? {};
  const out = await record_qa(s.service, s.ctx(project, auth), {
    stage: s.stage(project, args.stage).key,
    qa: args.qa,
  });
  return { round_no: result_of(out).round_no, verdict: result_of(out).verdict };
};

// lock / unlock -------------------------------------------------------------

const lock: Handler = async (s, req) => {
  const project = s.project(req.slug);
  const session = req.session;
  if (session === undefined || session.length === 0) {
    throw new Refusal("invalid_payload", "PES_OWNER 환경변수(이 세션 ID)가 필요합니다", 2);
  }
  // Checked before anything changes: a refused claim must not leave the
  // interrupt of the old run behind (the whole handler is one unit as well).
  if (session.length > SESSION_MAX) {
    throw new Refusal("invalid_payload", `PES_OWNER 는 ${SESSION_MAX}자 이하여야 합니다`, 2);
  }
  const auth = s.auth(project, req.token, "run:claim");
  const force = req.args?.force === true;
  const lease = s.lease(project);
  if (lease !== null) {
    if (s.is_mine(lease, auth, session)) {
      await heartbeat(s.service, s.ctx(project, auth), {
        run_id: lease.run_id,
        lease_id: lease.lease_id,
        fence: lease.fence,
      });
      return { renewed: true };
    }
    if (!force) {
      throw new Refusal(
        "locked",
        `다른 세션이 사용 중: ${(lease.session ?? "에이전트 run").slice(0, 8)}… ` +
          `(마지막 기록 ${Math.floor((s.now() - lease.heartbeat_at) / 60_000)}분 전). 그 세션이 끝났으면 --force`,
        3,
      );
    }
    if (auth.kind !== "human") {
      throw new Refusal("forbidden", "잠금을 가져오는 --force 는 사람 소유자만 할 수 있습니다");
    }
    // The old CLI let --force take anyone's lock: a human owner also takes over
    // an agent's lease (interrupt ends that run, the claim below is fence + 1).
    await interrupt(s.service, s.ctx(project, auth), {
      run_id: lease.run_id,
      lease_id: lease.lease_id,
      fence: lease.fence,
    });
  }
  const out = await claim(s.service, s.ctx(project, auth), {
    mode: "B",
    runtime: "pes-cli",
    provider: "local",
    model: "session-lock",
    external_session_ref: session,
  });
  return { fence: result_of(out).fence, renewed: false };
};

const unlock: Handler = async (s, req) => {
  const project = s.project(req.slug);
  const auth = s.auth(project, req.token, "run:submit");
  const force = req.args?.force === true;
  const lease = s.lease(project);
  if (lease === null) return { released: false };
  if (!s.is_mine(lease, auth, req.session)) {
    if (!force) throw new Refusal("locked", "다른 세션의 잠금입니다 (--force 로 해제)", 3);
    if (auth.kind !== "human") {
      throw new Refusal("forbidden", "다른 세션의 잠금 해제 --force 는 사람 소유자만 할 수 있습니다");
    }
    await interrupt(s.service, s.ctx(project, auth), {
      run_id: lease.run_id,
      lease_id: lease.lease_id,
      fence: lease.fence,
    });
    return { released: true };
  }
  await complete(s.service, s.ctx(project, auth), {
    run_id: lease.run_id,
    lease_id: lease.lease_id,
    fence: lease.fence,
    status: "succeeded",
  });
  return { released: true };
};

// context / claim / submit / wait / complete ---------------------------------

const context: Handler = async (s, req) => {
  const project = s.project(req.slug);
  // Same auth, scope and data as GET /api/v1/projects/{id}/context (PR13).
  const secret = randomUUID();
  const app = new ApiApp({
    db: s.db,
    clock: s.clock,
    objects_dir: s.objects,
    local_session_secret: secret,
  });
  const headers: Record<string, string> =
    req.token !== undefined && req.token.length > 0
      ? { authorization: `Bearer ${req.token}` }
      : { "x-pes-session": secret };
  const response = await app.handle({
    method: "GET",
    path: `/api/v1/projects/${project.id}/context`,
    headers,
    body: null,
  });
  if (response.status !== 200) {
    const error = is_record(response.json) && is_record(response.json.error) ? response.json.error : {};
    throw new Refusal(
      typeof error.code === "string" ? error.code : "internal_error",
      typeof error.message === "string" ? error.message : "context 를 읽지 못했습니다",
    );
  }
  const body = response.json as { data: unknown };
  return body.data;
};

function guard_of(args: Record<string, unknown>): { run_id: string; lease_id: string; fence: number } {
  const fence = args.fence;
  if (typeof fence !== "number" || !Number.isSafeInteger(fence) || fence < 1) {
    throw new Refusal("invalid_payload", "--fence 는 1 이상의 정수여야 합니다", 2);
  }
  return { run_id: text_arg(args, "run_id"), lease_id: text_arg(args, "lease_id"), fence };
}

const claim_op: Handler = async (s, req) => {
  const project = s.project(req.slug);
  const auth = s.auth(project, req.token, "run:claim");
  const args = req.args ?? {};
  const payload: Record<string, unknown> =
    typeof args.run_id === "string" && args.run_id.length > 0
      ? { run_id: args.run_id }
      : {
          mode: args.mode ?? "B",
          runtime: args.runtime ?? "pes-cli",
          provider: args.provider ?? "local",
          model: args.model ?? "unknown",
        };
  const out = await claim(s.service, s.ctx(project, auth), payload);
  return normalize_run_result(result_of(out));
};

const submit_op: Handler = async (s, req) => {
  const project = s.project(req.slug);
  const auth = s.auth(project, req.token, "run:submit");
  const args = req.args ?? {};
  const out = await submit_results(s.service, s.ctx(project, auth), { ...guard_of(args), results: args.results });
  return result_of(out);
};

const wait_op: Handler = async (s, req) => {
  const project = s.project(req.slug);
  const auth = s.auth(project, req.token, "run:submit");
  const args = req.args ?? {};
  const payload: Record<string, unknown> = guard_of(args);
  if (typeof args.reason === "string" && args.reason.length > 0) payload.reason = args.reason;
  const out = await wait(s.service, s.ctx(project, auth), payload);
  return normalize_run_result(result_of(out));
};

const complete_op: Handler = async (s, req) => {
  const project = s.project(req.slug);
  const auth = s.auth(project, req.token, "run:submit");
  const args = req.args ?? {};
  const payload: Record<string, unknown> = guard_of(args);
  if (args.status !== undefined) payload.status = args.status;
  const out = await complete(s.service, s.ctx(project, auth), payload);
  return normalize_run_result(result_of(out));
};

/**
 * A content write is one unit from its lock check on: the implicit lock, the
 * heartbeat and the command(s) commit together or not at all, so a refused
 * write leaves no lease behind.
 */
// reads: routing, the legacy-shaped view, doctor -------------------------------

/** Which path serves a project: the database only once it is active (PR12 serving_path), else project.json. */
const route: Handler = async (s, req) => {
  if (typeof req.slug !== "string" || req.slug.length === 0) {
    throw new Refusal("invalid_payload", "프로젝트 이름이 필요합니다", 2);
  }
  const row = s.db.get<{ id: string }>("SELECT id FROM projects WHERE slug = ?", req.slug);
  if (row === undefined) return { serving: "none" };
  return { serving: serving_path(s.db, row.id) === "database" ? "database" : "legacy" };
};

const active_slugs: Handler = async (s) => {
  const rows = s.db.all<{ slug: string }>("SELECT slug FROM projects WHERE status = 'active' ORDER BY slug");
  return { slugs: rows.map((row) => row.slug) };
};

function served_project(s: Session, req: Request): ProjectInfo {
  const project = s.project(req.slug);
  if (project.status !== "active") {
    throw new Refusal("conflict", `이전이 끝나지 않은 프로젝트입니다: ${project.slug} — project.json 으로 읽습니다`);
  }
  s.auth(project, req.token, null);
  return project;
}

const read_project: Handler = async (s, req) => {
  const project = served_project(s, req);
  const view = build_project_view(s.db, project.id, s.objects);
  const lease = s.lease(project);
  const last = s.db.get<{ at: bigint | null }>("SELECT max(created_at) AS at FROM mutation_commits WHERE project_id = ?", project.id);
  return {
    project: view.project,
    pending: view.pending,
    lock: lease === null ? null : { owner: lease.session ?? `agent-run:${lease.run_id}`, since: local_stamp(lease.heartbeat_at) },
    updated: local_stamp(Number(last?.at ?? 0n)),
  };
};

// reports: new versions of a report / output artifact --------------------------

interface RenderedFile {
  name: string;
  media_type: string;
  bytes: Uint8Array;
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The artifact object of one report role (stage report of a stage, or the project's final output), if it exists. */
function find_report_object(
  s: Session,
  project: ProjectInfo,
  role: "stage_report" | "final_output",
  stage: StageInfo | null,
  edition_id: string,
): { object_id: string; version_id: string } | undefined {
  const row = s.db.get<{ object_id: string; version_id: string }>(
    `SELECT o.id AS object_id, o.current_version_id AS version_id
       FROM objects o
       JOIN artifacts a ON a.project_id = o.project_id AND a.object_id = o.id
       JOIN artifact_versions v ON v.project_id = o.project_id AND v.version_id = o.current_version_id
      WHERE o.project_id = ? AND o.kind = 'artifact' AND a.kind = ? AND o.edition_id = ?
        AND ((? IS NULL AND a.stage_id IS NULL) OR a.stage_id = ?)
        AND json_extract(v.metadata_json, '$.role') = ?
      ORDER BY o.display_no
      LIMIT 1`,
    project.id,
    role === "stage_report" ? "report" : "output",
    edition_id,
    stage === null ? null : stage.id,
    stage === null ? null : stage.id,
    role,
  );
  return row === undefined ? undefined : { ...row };
}

/** Current versions of the stage's real items (the same set render seals, minus removed ones). */
function item_versions(s: Session, project: ProjectInfo, stage: StageInfo): string[] {
  return s.db
    .all<{ version_id: string }>(
      `SELECT o.current_version_id AS version_id
         FROM objects o
         JOIN artifacts a ON a.project_id = o.project_id AND a.object_id = o.id
         JOIN artifact_versions v ON v.project_id = o.project_id AND v.version_id = o.current_version_id
        WHERE o.project_id = ? AND o.edition_id = ? AND a.stage_id = ? AND o.kind = 'artifact'
          AND a.kind NOT IN ('note', 'review') AND o.archived_at IS NULL AND v.status <> 'removed'
          AND ${not_a_report_sql("v")}
        ORDER BY o.display_no`,
      project.id,
      stage.edition_id,
      stage.id,
    )
    .map((row) => row.version_id);
}

/**
 * One report run: append a version to the report object (create it the first time), point it at the
 * item versions it was written from, and attach the rendered files. All in one unit.
 */
async function write_report_version(
  s: Session,
  project: ProjectInfo,
  auth: Auth,
  input: {
    role: "stage_report" | "final_output";
    stage: StageInfo | null;
    edition_id: string;
    title: string;
    metadata: Record<string, unknown>;
    derived_from: string[];
    files: RenderedFile[];
  },
): Promise<Record<string, unknown>> {
  return s.unit(async () => {
    const existing = find_report_object(s, project, input.role, input.stage, input.edition_id);
    const fields = {
      title: input.title,
      summary: "",
      question: null,
      body_md: null,
      status: "done",
      confidence: null,
      stats: [],
      conflicts: [],
      verify: null,
      metadata: { ...input.metadata, role: input.role },
    };
    let object_id: string;
    let version_id: string;
    let version_no: number;
    if (existing === undefined) {
      const created = await create_object(s.service, s.ctx(project, auth), { kind: "artifact", edition_id: input.edition_id });
      object_id = String(result_of(created).object_id);
      const added = await add_artifact(s.service, s.ctx(project, auth), {
        object_id,
        artifact_kind: input.role === "stage_report" ? "report" : "output",
        stage_id: input.stage === null ? null : input.stage.id,
        ...fields,
      });
      version_id = String(result_of(added).version_id);
      version_no = Number(result_of(added).version_no);
    } else {
      object_id = existing.object_id;
      const appended = await append_version(s.service, s.ctx(project, auth), {
        object_id,
        based_on_version_id: existing.version_id,
        ...fields,
      });
      version_id = String(result_of(appended).version_id);
      version_no = Number(result_of(appended).version_no);
      await set_current(s.service, s.ctx(project, auth), { object_id, version_id });
    }
    for (const target of input.derived_from) {
      await link_relation(s.service, s.ctx(project, auth), { from_version_id: version_id, to_version_id: target, kind: "derived_from" });
    }
    const stored: Array<{ name: string; blob_id: string }> = [];
    for (const file of input.files) {
      const known_before =
        s.db.get("SELECT 1 AS ok FROM blobs WHERE project_id = ? AND sha256 = ? AND size = ?", project.id, sha256_hex(file.bytes), file.bytes.byteLength) !== undefined;
      const reserved = result_of(
        await reserve_upload(s.service, s.ctx(project, auth), {
          sha256: sha256_hex(file.bytes),
          size: file.bytes.byteLength,
          media_type: file.media_type,
          original_name: file.name,
        }),
      );
      const blob_id = String(reserved.blob_id);
      if (reserved.state !== "ready") {
        if (!known_before) s.fresh_files.push({ project_id: project.id, storage_key: `${project.id}/${sha256_hex(file.bytes)}` });
        await store_blob({ db: s.db, objects_dir: s.objects }, project.id, blob_id, file.bytes);
        await complete_upload(s.service, { db: s.db, objects_dir: s.objects }, s.ctx(project, auth), { blob_id });
      }
      await attach_version(s.service, s.ctx(project, auth), { version_id, blob_id, role: "rendered" });
      stored.push({ name: file.name, blob_id });
    }
    return { object_id, version_id, version_no, files: stored };
  });
}

const report: Handler = async (s, req) => {
  const { project, auth } = await write_auth(s, req);
  const stage = s.stage(project, req.args?.stage);
  const view = build_project_view(s.db, project.id, s.objects);
  const eli5 = is_record(req.args?.eli5) ? (req.args?.eli5 as Dict) : null;
  const built = local_stamp(s.now());
  // The report says which version it is, so every run writes distinct bytes (a rerun within the same minute too).
  const next = s.db.get<{ n: bigint | null }>(
    `SELECT max(ov.version_no) AS n FROM object_versions ov JOIN artifacts a ON a.project_id = ov.project_id AND a.object_id = ov.object_id
      WHERE ov.project_id = ? AND a.kind = 'report' AND a.stage_id = ?
        AND json_extract((SELECT metadata_json FROM artifact_versions av WHERE av.project_id = ov.project_id AND av.version_id = ov.id), '$.role') = 'stage_report'`,
    project.id,
    stage.id,
  );
  const made = stage_report(view.project, stage.key, view.feedback, built, eli5, Number(next?.n ?? 0n) + 1);
  const files: RenderedFile[] = [
    { name: "report.md", media_type: "text/markdown", bytes: utf8(made.markdown) },
    { name: "report.html", media_type: "text/html", bytes: utf8(made.html) },
  ];
  if (made.eli5_html !== null) files.push({ name: "eli5.html", media_type: "text/html", bytes: utf8(made.eli5_html) });
  const out = await write_report_version(s, project, auth, {
    role: "stage_report",
    stage,
    edition_id: stage.edition_id,
    title: `${REPORT_NAME[stage.key] ?? stage.key}`,
    metadata: { stage: stage.key, round: (view.project.stages[stage.key] as Dict).round, built },
    derived_from: item_versions(s, project, stage),
    files,
  });
  const formats = (view.project.settings as Dict | undefined)?.stage_reports;
  return { ...out, stage: stage.key, name: REPORT_NAME[stage.key], formats: Array.isArray(formats) && formats.length > 0 ? formats : ["md", "html", "eli5"], eli5: made.eli5_html !== null };
};

/** The bytes of one rendered file (by name) of an output version, or undefined. */
function rendered_bytes(s: Session, project: ProjectInfo, version_id: string, name: string): Uint8Array | undefined {
  const row = s.db.get<{ storage_key: string }>(
    `SELECT b.storage_key AS storage_key
       FROM version_files vf JOIN blobs b ON b.project_id = vf.project_id AND b.id = vf.blob_id
      WHERE vf.project_id = ? AND vf.version_id = ? AND vf.role = 'rendered' AND b.original_name = ?`,
    project.id,
    version_id,
    name,
  );
  return row === undefined ? undefined : read_storage_bytes(s.objects, project.id, row.storage_key);
}

async function output_run(s: Session, req: Request, web: boolean): Promise<Record<string, unknown>> {
  const { project, auth } = await write_auth(s, req);
  const args = req.args ?? {};
  const write = s.stage(project, "write");
  const existing = find_report_object(s, project, "final_output", null, write.edition_id);
  const assemble_now = !web || existing === undefined || args.assemble === true;
  const built = local_stamp(s.now());
  let markdown: Uint8Array;
  let sources_json: Uint8Array;
  let sections = 0;
  let footnotes = 0;
  let warnings: string[] = [];
  let derived: string[] = [];
  if (assemble_now) {
    const view = build_project_view(s.db, project.id, s.objects);
    const asm = assemble_manuscript(view.project);
    markdown = utf8(asm.markdown);
    sources_json = utf8(JSON.stringify(asm.sources, null, 1));
    sections = asm.sections;
    footnotes = asm.footnotes;
    warnings = asm.warnings;
    derived = item_versions(s, project, write);
  } else {
    const found = existing as { object_id: string; version_id: string };
    const md = rendered_bytes(s, project, found.version_id, "report.md");
    const src = rendered_bytes(s, project, found.version_id, "sources.json");
    if (md === undefined) throw new Refusal("conflict", "조립본(report.md)을 찾을 수 없습니다 — web --assemble 로 다시 조립하세요");
    markdown = md;
    sources_json = src ?? utf8("[]");
    derived = [found.version_id]; // the new version builds on the assembly it reuses
  }
  const files: RenderedFile[] = [
    { name: "report.md", media_type: "text/markdown", bytes: markdown },
    { name: "sources.json", media_type: "application/json", bytes: sources_json },
  ];
  let sources: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(sources_json));
    if (Array.isArray(parsed)) sources = parsed;
  } catch {
    sources = [];
  }
  if (web) {
    const html = final_report_html({
      topic: project.topic,
      markdown: new TextDecoder().decode(markdown),
      appendix: typeof args.appendix === "string" ? args.appendix : null,
      sources,
      cover: is_record(args.cover) ? (args.cover as Dict) : {},
      built,
    });
    files.push({ name: "report.html", media_type: "text/html", bytes: utf8(html) });
  }
  const out = await write_report_version(s, project, auth, {
    role: "final_output",
    stage: null,
    edition_id: write.edition_id,
    title: "최종 보고서",
    metadata: { built, assembled: assemble_now, web },
    derived_from: derived,
    files,
  });
  const verified = sources.filter((x) => is_record(x) && x.verified === true).length;
  return { ...out, sections, footnotes, warnings, sources: sources.length, verified };
}

const assemble_op: Handler = (s, req) => output_run(s, req, false);
const web_op: Handler = (s, req) => output_run(s, req, true);

function in_unit(handler: Handler): Handler {
  return (s, req) => s.unit(() => handler(s, req));
}

const HANDLERS: Record<string, Handler> = {
  slugs,
  active_slugs,
  route,
  read_project,
  report: in_unit(report),
  assemble: in_unit(assemble_op),
  web: in_unit(web_op),
  live_locks,
  overview,
  init,
  "round-start": in_unit(round_start),
  render: in_unit(render),
  approve: in_unit(approve),
  reopen: in_unit(reopen),
  note: in_unit(note),
  mark: in_unit(mark),
  chat: in_unit(chat),
  "ask-prep": in_unit(ask_prep),
  ask: in_unit(ask),
  merge: in_unit(merge),
  "qa-data": qa_data,
  "qa-brief": in_unit(qa_brief),
  qa: in_unit(qa),
  lock: in_unit(lock),
  unlock: in_unit(unlock),
  context,
  claim: claim_op,
  submit: submit_op,
  wait: wait_op,
  complete: complete_op,
};

// ---------------------------------------------------------------------------
// entry

function schema_is_current(db: Db): boolean {
  try {
    const migrations = load_migrations();
    const newest = BigInt(migrations[migrations.length - 1]!.version);
    const row = db.get<{ schema_version: bigint }>("SELECT schema_version FROM db_meta WHERE id = 1");
    return row !== undefined && row.schema_version === newest;
  } catch {
    return false;
  }
}

function reply(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  const env = process.env as Environment;
  let request: Request;
  try {
    request = JSON.parse(readFileSync(0, "utf8")) as Request;
  } catch {
    reply({ ok: false, code: "invalid_payload", message: "요청을 읽지 못했습니다", exit: 1 });
    return;
  }
  // Python sends null for "not given".
  for (const field of ["slug", "session", "token"] as const) {
    if (request[field] === null) delete request[field];
  }
  if (request.args === null) delete request.args;
  if (request.op === "db_status") {
    reply({ ok: true, data: probe_database(db_path(env)) });
    return;
  }
  const handler = HANDLERS[request.op];
  if (handler === undefined) {
    reply({ ok: false, code: "unknown_command", message: `알 수 없는 작업: ${String(request.op)}`, exit: 1 });
    return;
  }
  const file = db_path(env);
  const creating = request.op === "init";
  if (!creating && !existsSync(file)) {
    if (request.op === "slugs" || request.op === "live_locks" || request.op === "active_slugs") {
      reply({ ok: true, data: { slugs: [], locks: {} } });
      return;
    }
    if (request.op === "route") {
      reply({ ok: true, data: { serving: "none" } });
      return;
    }
    reply({
      ok: false,
      code: "not_found",
      message: "PES 데이터베이스가 없습니다 — 옛 project.json 프로젝트는 이전하기 전에는 쓸 수 없습니다",
      exit: 1,
    });
    return;
  }
  if (creating) mkdirSync(pes_dir(env), { recursive: true });
  const db = connect(file);
  let session: Session | undefined;
  try {
    if (creating) migrate(db);
    else if (!schema_is_current(db)) {
      reply({ ok: false, code: "schema_not_ready", message: "PES 데이터베이스가 최신이 아닙니다", exit: 1 });
      return;
    }
    session = new Session(env, db);
    const data = await handler(session, request);
    reply({ ok: true, data });
  } catch (error) {
    try {
      session?.discard_fresh_files();
    } catch {
      // best effort: the next gc removes an orphan file
    }
    if (error instanceof Refusal) {
      reply({ ok: false, code: error.code, message: error.message, exit: error.exit });
    } else if (error instanceof ApiError) {
      reply({ ok: false, code: error.code, message: `${error.code}: ${error.message}`, exit: 1 });
    } else {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      reply({ ok: false, code: "internal_error", message: "내부 오류", exit: 1 });
    }
  } finally {
    db.close();
  }
}


main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});

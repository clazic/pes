// SEL-40 (stage 2 PR7): items / versions / sources / citations / relations / library import,
// tests written before the implementation.
//
// Command names (registered in COMMANDS by scripts/pes_core/commands/content.ts; all scope "project",
// NOT rev-bearing: no base_control_rev is sent). Unknown payload fields are rejected with
// ApiError "invalid_payload", as is a malformed/missing field. Missing id (or an id of another
// project) -> "not_found". An id that exists but is the wrong kind / belongs to another object /
// is already used / refers to a sealed version -> "conflict". A rejection writes nothing.
//
//   content.create_object   {kind: 'artifact'|'source', edition_id?: string|null (default null)}
//                           bare objects row, display_no from counters[namespace = kind], no version yet.
//                           result {project_id, object_id, kind, display_no}
//   content.add_artifact    {object_id, artifact_kind, stage_id?, title, summary?, question?, body_md?,
//                            status?, confidence?, stats?, conflicts?, verify?, metadata?}
//                           artifacts row + version 1 (object_versions + artifact_versions); the object's
//                           current_version_id becomes that version. Object must be a bare 'artifact'.
//                           result {project_id, object_id, version_id, version_no}
//   content.add_source      {object_id, source_kind: 'web'|'file'|'stat'|'law', canonical_locator?, title,
//                            url?, locator?, retrieved_at?, method, verification_state, quote?,
//                            verified_by_actor_id?}
//                           sources row + version 1, current = that version. Object must be a bare 'source'.
//                           result {project_id, object_id, version_id, version_no}
//   content.append_version  {object_id, based_on_version_id? (default: current), <the same version fields as
//                            add_artifact / add_source for the object's kind, without the *_kind>}
//                           appends version_no = max + 1. Does NOT move current_version_id.
//                           result {project_id, object_id, version_id, version_no}
//   content.set_current     {object_id, version_id}  moves objects.current_version_id (any version of THAT
//                           object, newer or older) and adds 1 to objects.rev.
//                           result {project_id, object_id, version_id, rev}
//   content.add_citation    {artifact_version_id, source_version_id, quote?, locator?}
//                           citation_no = max + 1 within the artifact version (1, 2, 3 ...). Only the LATEST
//                           version (highest version_no) of an artifact accepts citations; an older version is
//                           sealed -> "conflict". A quote on a citation of an 'unreachable' source version
//                           -> "invalid_payload".
//                           result {project_id, artifact_version_id, citation_no}
//   content.link_relation   {from_version_id, to_version_id, kind: derived_from|supports|supersedes|reuses|related}
//                           the FROM version must be the latest version of its object (sealed otherwise ->
//                           "conflict"); to_version may be any version. Same triple twice -> "conflict".
//                           result {project_id, from_version_id, to_version_id, kind}
//   content.import_library  {library: <parsed library.json object>}   (see tests/fixtures/library_synthetic.json)
//                           one tx: every item -> object (kind 'artifact', edition_id NULL) + version 1 (current);
//                           each item.sources[] -> its OWN source object + version 1 (never merged by URL, not
//                           even across items) and citations 1..n in array order; method kept when allowed,
//                           else 'unknown'; verification_state 'legacy_unknown'; retrieved_at NULL;
//                           locator keeps date/note; unknown item kind -> artifact kind 'note' (original kept in
//                           metadata_json.legacy_extra.kind_original); every other item key is kept under
//                           artifact_versions.metadata_json.legacy_extra.<key> (legacy id = legacy_extra.legacy_id);
//                           status 'removed' items are kept: status 'removed' AND objects.archived_at set.
//                           ORIGINAL PRESERVATION: byte storage (blobs / import_batches) is the PR9/11 border, so
//                           here the whole parsed library JSON is kept in the event payload of the
//                           'content.library_imported' event of the same tx, as payload.original.
//                           Re-running the same library (any new client_request_id) creates no new business
//                           rows and returns {already_imported: true, items} with the first run's ids.
//                           result {project_id, already_imported, items: [{legacy_id, object_id, version_id}]}
//
// scripts/pes_core/content.ts: public functions create_object, add_artifact, add_source, append_version,
//   set_current, add_citation, link_relation, import_library(service, ctx, input) -> Promise<CommandOutcome>;
//   each is exactly one service.execute. No SQL there (writes live in commands/content.ts only).
//
// There is NO command that updates or deletes a version / citation / relation (static + registry checks below).

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FakeClock } from "../scripts/pes_core/clock.ts";
import {
  COMMANDS,
  CommandService,
  type CommandOutcome,
  type MutationContext,
  type PolicyChecker,
} from "../scripts/pes_core/commands.ts";
import {
  add_artifact,
  add_citation,
  add_source,
  append_version,
  create_object,
  import_library,
  link_relation,
  set_current,
} from "../scripts/pes_core/content.ts";
import { connect, migrate, type Db, type RunResult, type SqlValue } from "../scripts/pes_core/db.ts";
import { ApiError } from "../scripts/pes_core/errors.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { isolated_home, type IsolatedHome } from "./helpers/isolated_home.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

const START_MS = 1_760_000_000_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "..", "scripts", "pes_core");
const REPO = resolve(HERE, "..");
const LIBRARY_FIXTURE = join(HERE, "fixtures", "library_synthetic.json");

const CONTENT_COMMANDS = [
  "content.create_object",
  "content.add_artifact",
  "content.add_source",
  "content.append_version",
  "content.set_current",
  "content.add_citation",
  "content.link_relation",
  "content.import_library",
] as const;

const IMMUTABLE_TABLES = [
  "object_versions",
  "artifact_versions",
  "source_versions",
  "citations",
  "version_relations",
  "artifact_components",
] as const;

// ---------------------------------------------------------------------------
// Harness

class FakePolicy implements PolicyChecker {
  allowed = true;
  calls = 0;
  check(_ctx: MutationContext, _command: string, _payload: unknown) {
    this.calls += 1;
    return this.allowed
      ? ({ allowed: true } as const)
      : ({ allowed: false, reason: "synthetic policy: content writes are OFF" } as const);
  }
}

interface Project {
  project_id: string;
  actor_id: string;
  edition_id: string;
}

interface Env {
  home: IsolatedHome;
  db: Db;
  clock: FakeClock;
  policy: FakePolicy;
  service: CommandService;
  p: Project;
  ctx(key: string, via?: MutationContext["via"]): MutationContext;
  with_db(db: Db): CommandService;
  close(): void;
}

async function bootstrap(service: CommandService, key: string, slug: string): Promise<Project> {
  const out = await service.execute(
    { project_id: null, actor_id: null, via: "cli", client_request_id: key },
    "project.bootstrap",
    { slug, topic: "합성 내용 주제", owner_display_name: "합성 소유자" },
  );
  const r = out.result as { project_id: string; owner_actor_id: string; edition_id: string };
  return { project_id: r.project_id, actor_id: r.owner_actor_id, edition_id: r.edition_id };
}

function ctx_for(p: Project, key: string, via: MutationContext["via"] = "cli"): MutationContext {
  return { project_id: p.project_id, actor_id: p.actor_id, via, client_request_id: key };
}

async function make_env(): Promise<Env> {
  const home = isolated_home("pes-sel40-");
  const db = connect(db_path(home.env));
  migrate(db);
  const clock = new FakeClock(START_MS);
  const policy = new FakePolicy();
  const service = new CommandService(db, { clock, policy });
  const p = await bootstrap(service, "setup-p", "synthetic-content");
  policy.calls = 0;
  return {
    home,
    db,
    clock,
    policy,
    service,
    p,
    ctx: (key, via) => ctx_for(p, key, via),
    with_db: (wrapped) => new CommandService(wrapped, { clock, policy }),
    close() {
      db.close();
      home.cleanup();
    },
  };
}

async function with_env(fn: (env: Env) => Promise<void> | void): Promise<void> {
  const env = await make_env();
  try {
    await fn(env);
  } finally {
    env.close();
  }
}

function wrap_db(db: Db, rule: (sql: string) => RunResult | void): Db {
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

async function rejects_api(p: Promise<unknown> | unknown, code: string): Promise<ApiError> {
  try {
    await p;
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError ${code}, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected the command to be rejected with ${code}`);
}

async function rejects_any(p: Promise<unknown> | unknown): Promise<unknown> {
  try {
    await p;
  } catch (error) {
    return error;
  }
  assert.fail("expected the command to be rejected");
}

function json_row(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v.toString()}n` : v));
}

// Result shapes
interface ObjectResult {
  object_id: string;
  kind: string;
  display_no: number;
}
interface VersionResult {
  object_id: string;
  version_id: string;
  version_no: number;
}

async function new_object(env: Env, key: string, kind: "artifact" | "source", edition_id?: string | null) {
  const input = edition_id === undefined ? { kind } : { kind, edition_id };
  const out = await create_object(env.service, env.ctx(key), input);
  return out.result as ObjectResult;
}

const ART_FIELDS = { artifact_kind: "chapter", summary: "합성 요약" } as const;

async function new_artifact(env: Env, key: string, title = "합성 장", extra: Record<string, unknown> = {}) {
  const obj = await new_object(env, `${key}-o`, "artifact", env.p.edition_id);
  const out = await add_artifact(env.service, env.ctx(`${key}-v`), {
    object_id: obj.object_id,
    ...ART_FIELDS,
    title,
    ...extra,
  });
  return out.result as VersionResult;
}

const SRC_FIELDS = {
  source_kind: "web",
  method: "fetch",
  verification_state: "unverified",
} as const;

async function new_source(env: Env, key: string, title = "합성 출처", extra: Record<string, unknown> = {}) {
  const obj = await new_object(env, `${key}-o`, "source");
  const out = await add_source(env.service, env.ctx(`${key}-v`), {
    object_id: obj.object_id,
    ...SRC_FIELDS,
    title,
    url: "https://example.test/page",
    ...extra,
  });
  return out.result as VersionResult;
}

async function more_version(env: Env, key: string, object_id: string, extra: Record<string, unknown> = {}) {
  const out = await append_version(env.service, env.ctx(key), { object_id, title: `합성 제목 ${key}`, ...extra });
  return out.result as VersionResult;
}

interface ObjectRow {
  id: string;
  kind: string;
  display_no: bigint;
  current_version_id: string | null;
  rev: bigint;
  edition_id: string | null;
  archived_at: bigint | null;
}

function object_row(db: Db, id: string): ObjectRow {
  const row = db.get<ObjectRow>("SELECT * FROM objects WHERE id = ?", id);
  assert.ok(row, `object ${id} exists`);
  return row;
}

function receipt_for(db: Db, project_id: string, key: string) {
  return db.get<{ id: string; action: string; actor_id: string; project_id: string }>(
    "SELECT id, action, actor_id, project_id FROM mutation_commits WHERE project_id = ? AND client_request_id = ?",
    project_id,
    key,
  );
}

function events_of(db: Db, tx_id: string) {
  return db.all<{ type: string; tx_index: bigint; tx_size: bigint; payload: string }>(
    "SELECT type, tx_index, tx_size, payload FROM events WHERE tx_id = ? ORDER BY tx_index",
    tx_id,
  );
}

function citations_of(db: Db, artifact_version_id: string) {
  return db.all<{ citation_no: bigint; source_version_id: string; quote: string | null; locator: string }>(
    "SELECT citation_no, source_version_id, quote, locator FROM citations WHERE artifact_version_id = ? ORDER BY citation_no",
    artifact_version_id,
  );
}

// ---------------------------------------------------------------------------
// Registry and static checks: there is no path that changes the past

test("the eight content commands are registered, project-scoped, with distinct actions, and nothing else is content.*", () => {
  const actions = new Set<string>();
  for (const name of CONTENT_COMMANDS) {
    const def = COMMANDS.get(name);
    assert.ok(def, `${name} is registered`);
    assert.equal(def.scope, "project");
    assert.equal(def.rev_bearing, false);
    actions.add(def.action);
  }
  assert.equal(actions.size, CONTENT_COMMANDS.length);
  const extra = [...COMMANDS.keys()].filter((k) => k.startsWith("content.") && !(CONTENT_COMMANDS as readonly string[]).includes(k));
  assert.deepEqual(extra, [], "the content command set is closed");
});

test("the registry has no update/delete/overwrite command for versions, citations, relations or sources, and no table CRUD", () => {
  const bad =
    /(update|delete|remove|edit|overwrite|replace|rewrite|patch|truncate|purge).*(version|citation|relation|component)|(version|citation|relation|component).*(update|delete|remove|edit|overwrite|replace|rewrite|patch|truncate|purge)|\.(insert|update|delete|upsert|sql|exec|ops?|crud)$/i;
  const hits = [...COMMANDS.keys()].filter((k) => bad.test(k));
  assert.deepEqual(hits, []);
});

function ts_files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...ts_files(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

function strip_comments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("no source file updates or deletes rows of the immutable version tables, or overwrites them via REPLACE/upsert", () => {
  const names = IMMUTABLE_TABLES.join("|");
  const re = new RegExp(
    `\\bUPDATE\\s+(?:OR\\s+\\w+\\s+)?["\`\\[]?(?:${names})\\b|\\bDELETE\\s+FROM\\s+["\`\\[]?(?:${names})\\b|\\bINSERT\\s+OR\\s+REPLACE\\b|\\bREPLACE\\s+INTO\\b|\\bON\\s+CONFLICT\\b[^;]*\\bDO\\s+UPDATE\\b`,
    "gi",
  );
  const files = ts_files(CORE_DIR);
  assert.ok(
    files.some((f) => relative(CORE_DIR, f).replace(/\\/g, "/") === "commands/content.ts"),
    "scripts/pes_core/commands/content.ts exists",
  );
  const violations: string[] = [];
  for (const file of files) {
    const source = strip_comments(readFileSync(file, "utf8"));
    for (const m of source.matchAll(re)) violations.push(`${relative(REPO, file)}: ${m[0].replace(/\s+/g, " ")}`);
  }
  assert.deepEqual(violations, []);
});

test("scripts/pes_core/content.ts holds no SQL writes and every public function is one service.execute", () => {
  const source = strip_comments(readFileSync(join(CORE_DIR, "content.ts"), "utf8"));
  assert.doesNotMatch(source, /\b(INSERT|UPDATE|DELETE|REPLACE)\b\s+(INTO|FROM|OR)?/i);
  for (const fn of [
    "create_object",
    "add_artifact",
    "add_source",
    "append_version",
    "set_current",
    "add_citation",
    "link_relation",
    "import_library",
  ]) {
    assert.match(source, new RegExp(`export\\s+(async\\s+)?function\\s+${fn}\\b`), `${fn} is exported`);
  }
  assert.equal((source.match(/\.execute\(/g) ?? []).length, 8, "exactly one service.execute per public function");
});

test("if the schema has triggers on the immutable tables, direct SQL UPDATE/DELETE is blocked too", async () => {
  await with_env(async (env) => {
    const art = await new_artifact(env, "trg-a");
    const src = await new_source(env, "trg-s");
    await add_citation(env.service, env.ctx("trg-c"), { artifact_version_id: art.version_id, source_version_id: src.version_id });
    const triggers = env.db.all<{ tbl_name: string }>("SELECT tbl_name FROM sqlite_master WHERE type = 'trigger'");
    const guarded = new Set(triggers.map((t) => t.tbl_name));
    const before = state_signature(env.db);
    for (const table of IMMUTABLE_TABLES) {
      if (!guarded.has(table)) continue;
      assert.throws(() => env.db.run(`UPDATE ${table} SET project_id = project_id`), `UPDATE on ${table} is blocked`);
      assert.throws(() => env.db.run(`DELETE FROM ${table}`), `DELETE on ${table} is blocked`);
    }
    assert.equal(state_signature(env.db), before, "blocked statements changed nothing");
  });
});

// ---------------------------------------------------------------------------
// 1. Past versions cannot be changed through commands

test("appending a new version leaves the earlier version rows byte-for-byte unchanged", async () => {
  await with_env(async (env) => {
    const a1 = await new_artifact(env, "imm-a", "합성 원본 제목", { body_md: "원본 본문" });
    const rows = (version_id: string) =>
      json_row([
        env.db.get("SELECT * FROM object_versions WHERE id = ?", version_id),
        env.db.get("SELECT * FROM artifact_versions WHERE version_id = ?", version_id),
      ]);
    const before = rows(a1.version_id);
    env.clock.advance(5_000);
    const a2 = await more_version(env, "imm-a2", a1.object_id, { title: "합성 새 제목", body_md: "새 본문" });
    assert.equal(a2.version_no, 2);
    assert.equal(rows(a1.version_id), before);
    // append does not move the pointer; the caller must say so explicitly.
    assert.equal(object_row(env.db, a1.object_id).current_version_id, a1.version_id);
  });
});

test("a payload that tries to overwrite an existing version is rejected as an unknown field and changes nothing", async () => {
  await with_env(async (env) => {
    const a1 = await new_artifact(env, "ovw-a");
    const before = state_signature(env.db);
    for (const payload of [
      { object_id: a1.object_id, version_id: a1.version_id, title: "덮어쓰기" },
      { object_id: a1.object_id, version_no: 1, title: "덮어쓰기" },
      { object_id: a1.object_id, title: "덮어쓰기", content_hash: "f".repeat(64) },
      { object_id: a1.object_id, title: "덮어쓰기", body_blob_id: "blob-x" },
    ]) {
      await rejects_api(append_version(env.service, env.ctx("ovw-1"), payload), "invalid_payload");
    }
    assert.equal(state_signature(env.db), before);
    assert.equal(receipt_for(env.db, env.p.project_id, "ovw-1"), undefined);
  });
});

test("an old artifact version is sealed: citations and relations cannot be added to it", async () => {
  await with_env(async (env) => {
    const a1 = await new_artifact(env, "seal-a");
    const a2 = await more_version(env, "seal-a2", a1.object_id);
    const src = await new_source(env, "seal-s");
    const other = await new_artifact(env, "seal-b");
    const before = state_signature(env.db);
    await rejects_api(
      add_citation(env.service, env.ctx("seal-c"), { artifact_version_id: a1.version_id, source_version_id: src.version_id }),
      "conflict",
    );
    await rejects_api(
      link_relation(env.service, env.ctx("seal-r"), { from_version_id: a1.version_id, to_version_id: other.version_id, kind: "supports" }),
      "conflict",
    );
    assert.equal(state_signature(env.db), before);
    // the latest version still accepts both
    await add_citation(env.service, env.ctx("seal-c2"), { artifact_version_id: a2.version_id, source_version_id: src.version_id });
    await link_relation(env.service, env.ctx("seal-r2"), { from_version_id: a2.version_id, to_version_id: other.version_id, kind: "supports" });
  });
});

test("the same relation twice, and a relation from a version to itself, are rejected", async () => {
  await with_env(async (env) => {
    const a = await new_artifact(env, "rel-a");
    const b = await new_artifact(env, "rel-b");
    await link_relation(env.service, env.ctx("rel-1"), { from_version_id: a.version_id, to_version_id: b.version_id, kind: "derived_from" });
    await link_relation(env.service, env.ctx("rel-2"), { from_version_id: a.version_id, to_version_id: b.version_id, kind: "related" });
    const before = state_signature(env.db);
    await rejects_api(
      link_relation(env.service, env.ctx("rel-3"), { from_version_id: a.version_id, to_version_id: b.version_id, kind: "derived_from" }),
      "conflict",
    );
    await rejects_any(link_relation(env.service, env.ctx("rel-4"), { from_version_id: a.version_id, to_version_id: a.version_id, kind: "related" }));
    await rejects_api(
      link_relation(env.service, env.ctx("rel-5"), { from_version_id: a.version_id, to_version_id: b.version_id, kind: "bogus" }),
      "invalid_payload",
    );
    assert.equal(state_signature(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// 2. The current pointer only points at its own versions

test("set_current moves the pointer among the object's own versions (forward and back) and bumps rev; history stays", async () => {
  await with_env(async (env) => {
    const a1 = await new_artifact(env, "cur-a");
    const a2 = await more_version(env, "cur-a2", a1.object_id);
    const a3 = await more_version(env, "cur-a3", a1.object_id);
    assert.equal(a3.version_no, 3);
    const rev0 = object_row(env.db, a1.object_id).rev;

    const fwd = await set_current(env.service, env.ctx("cur-1"), { object_id: a1.object_id, version_id: a3.version_id });
    assert.equal((fwd.result as { version_id: string }).version_id, a3.version_id);
    let row = object_row(env.db, a1.object_id);
    assert.equal(row.current_version_id, a3.version_id);
    assert.equal(row.rev, rev0 + 1n);

    await set_current(env.service, env.ctx("cur-2"), { object_id: a1.object_id, version_id: a1.version_id });
    row = object_row(env.db, a1.object_id);
    assert.equal(row.current_version_id, a1.version_id);
    assert.equal(row.rev, rev0 + 2n);
    const count = env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM object_versions WHERE object_id = ?", a1.object_id);
    assert.equal(count?.n, 3n, "no version was dropped by moving the pointer");
    assert.ok(a2.version_id);
  });
});

test("set_current rejects another object's version, a source/artifact mix-up, unknown ids and another project's ids", async () => {
  await with_env(async (env) => {
    const a = await new_artifact(env, "pt-a");
    const b = await new_artifact(env, "pt-b");
    const s = await new_source(env, "pt-s");
    const p2 = await bootstrap(env.service, "setup-p2", "synthetic-other");
    const foreign = await (async () => {
      const obj = await create_object(env.service, ctx_for(p2, "f-o"), { kind: "artifact" });
      const oid = (obj.result as ObjectResult).object_id;
      const v = await add_artifact(env.service, ctx_for(p2, "f-v"), { object_id: oid, ...ART_FIELDS, title: "다른 프로젝트" });
      return v.result as VersionResult;
    })();
    const before = state_signature(env.db);
    await rejects_api(set_current(env.service, env.ctx("pt-1"), { object_id: a.object_id, version_id: b.version_id }), "conflict");
    await rejects_api(set_current(env.service, env.ctx("pt-2"), { object_id: s.object_id, version_id: a.version_id }), "conflict");
    await rejects_api(set_current(env.service, env.ctx("pt-3"), { object_id: a.object_id, version_id: s.version_id }), "conflict");
    await rejects_api(set_current(env.service, env.ctx("pt-4"), { object_id: a.object_id, version_id: "no-such-version" }), "not_found");
    await rejects_api(set_current(env.service, env.ctx("pt-5"), { object_id: "no-such-object", version_id: a.version_id }), "not_found");
    await rejects_api(set_current(env.service, env.ctx("pt-6"), { object_id: a.object_id, version_id: foreign.version_id }), "not_found");
    await rejects_api(set_current(env.service, env.ctx("pt-7"), { object_id: foreign.object_id, version_id: foreign.version_id }), "not_found");
    assert.equal(state_signature(env.db), before, "nothing changed, including the other project");
    assert.equal(object_row(env.db, a.object_id).current_version_id, a.version_id);
  });
});

test("add_citation and link_relation refuse versions of the wrong kind or of another project", async () => {
  await with_env(async (env) => {
    const a = await new_artifact(env, "wk-a");
    const s = await new_source(env, "wk-s");
    const p2 = await bootstrap(env.service, "setup-p2", "synthetic-other");
    const fobj = (await create_object(env.service, ctx_for(p2, "wf-o"), { kind: "source" })).result as ObjectResult;
    const fsrc = (
      await add_source(env.service, ctx_for(p2, "wf-v"), { object_id: fobj.object_id, ...SRC_FIELDS, title: "다른 프로젝트 출처" })
    ).result as VersionResult;
    const before = state_signature(env.db);
    await rejects_api(add_citation(env.service, env.ctx("wk-1"), { artifact_version_id: s.version_id, source_version_id: s.version_id }), "conflict");
    await rejects_api(add_citation(env.service, env.ctx("wk-2"), { artifact_version_id: a.version_id, source_version_id: a.version_id }), "conflict");
    await rejects_api(add_citation(env.service, env.ctx("wk-3"), { artifact_version_id: a.version_id, source_version_id: fsrc.version_id }), "not_found");
    await rejects_api(add_citation(env.service, env.ctx("wk-4"), { artifact_version_id: "nope", source_version_id: s.version_id }), "not_found");
    await rejects_api(link_relation(env.service, env.ctx("wk-5"), { from_version_id: a.version_id, to_version_id: fsrc.version_id, kind: "related" }), "not_found");
    assert.equal(state_signature(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// create_object / add_artifact / add_source / append_version basics

test("display numbers count per kind and per project; counters advance; first version becomes current", async () => {
  await with_env(async (env) => {
    const o1 = await new_object(env, "dn-1", "artifact", env.p.edition_id);
    const o2 = await new_object(env, "dn-2", "artifact");
    const s1 = await new_object(env, "dn-3", "source");
    assert.deepEqual([o1.display_no, o2.display_no, s1.display_no], [1, 2, 1]);
    const bare = object_row(env.db, o1.object_id);
    assert.equal(bare.current_version_id, null);
    assert.equal(bare.edition_id, env.p.edition_id);
    assert.equal(object_row(env.db, o2.object_id).edition_id, null, "no edition_id means project-wide (NULL)");
    const next = (ns: string) =>
      env.db.get<{ next_no: bigint }>("SELECT next_no FROM counters WHERE project_id = ? AND namespace = ?", env.p.project_id, ns)?.next_no;
    assert.equal(next("artifact"), 3n);
    assert.equal(next("source"), 2n);

    const p2 = await bootstrap(env.service, "setup-p2", "synthetic-other");
    const other = (await create_object(env.service, ctx_for(p2, "dn-p2"), { kind: "artifact" })).result as ObjectResult;
    assert.equal(other.display_no, 1, "numbering restarts in another project");

    const v = (
      await add_artifact(env.service, env.ctx("dn-4"), { object_id: o1.object_id, ...ART_FIELDS, title: "합성 첫 판" })
    ).result as VersionResult;
    assert.equal(v.version_no, 1);
    assert.equal(object_row(env.db, o1.object_id).current_version_id, v.version_id);
  });
});

test("version rows carry kind, actor, receipt tx id, time, a 64-char content hash, and the artifact fields as given", async () => {
  await with_env(async (env) => {
    const obj = await new_object(env, "vr-o", "artifact", env.p.edition_id);
    const v = (
      await add_artifact(env.service, env.ctx("vr-v"), {
        object_id: obj.object_id,
        artifact_kind: "claim",
        title: "합성 주장",
        question: "합성 질문?",
        summary: "합성 요약",
        body_md: "# 합성 본문",
        status: "draft",
        confidence: "high",
        stats: [{ name: "합성", value: "1" }],
        conflicts: ["합성 상충"],
        verify: { claims: [] },
        metadata: { note: "합성 메모" },
      })
    ).result as VersionResult;
    const ov = env.db.get<{
      kind: string;
      version_no: bigint;
      actor_id: string;
      tx_id: string;
      content_hash: string;
      created_at: bigint;
      based_on_version_id: string | null;
      project_id: string;
    }>("SELECT * FROM object_versions WHERE id = ?", v.version_id);
    assert.ok(ov);
    assert.equal(ov.kind, "artifact");
    assert.equal(ov.version_no, 1n);
    assert.equal(ov.actor_id, env.p.actor_id);
    assert.equal(ov.project_id, env.p.project_id);
    assert.equal(ov.content_hash.length, 64);
    assert.equal(ov.created_at, BigInt(START_MS));
    assert.equal(ov.based_on_version_id, null);
    assert.equal(ov.tx_id, receipt_for(env.db, env.p.project_id, "vr-v")?.id);

    const av = env.db.get<Record<string, unknown>>("SELECT * FROM artifact_versions WHERE version_id = ?", v.version_id);
    assert.ok(av);
    assert.equal(av.title, "합성 주장");
    assert.equal(av.question, "합성 질문?");
    assert.equal(av.summary, "합성 요약");
    assert.equal(av.body_md, "# 합성 본문");
    assert.equal(av.status, "draft");
    assert.equal(av.confidence, "high");
    assert.deepEqual(JSON.parse(av.stats as string), [{ name: "합성", value: "1" }]);
    assert.deepEqual(JSON.parse(av.conflicts as string), ["합성 상충"]);
    assert.deepEqual(JSON.parse(av.verify as string), { claims: [] });
    assert.deepEqual(JSON.parse(av.metadata_json as string), { note: "합성 메모" });
    const art = env.db.get<{ kind: string }>("SELECT kind FROM artifacts WHERE object_id = ?", obj.object_id);
    assert.equal(art?.kind, "claim");

    const v2 = await more_version(env, "vr-v2", obj.object_id, { title: "합성 주장 2판" });
    const ov2 = env.db.get<{ based_on_version_id: string | null; version_no: bigint }>(
      "SELECT based_on_version_id, version_no FROM object_versions WHERE id = ?",
      v2.version_id,
    );
    assert.equal(ov2?.version_no, 2n);
    assert.equal(ov2?.based_on_version_id, v.version_id, "default base is the current version");
  });
});

test("invalid content input is rejected with invalid_payload and leaves no row, event or receipt", async () => {
  await with_env(async (env) => {
    const bare = await new_object(env, "inv-o", "artifact");
    const bare_s = await new_object(env, "inv-os", "source");
    const art = await new_artifact(env, "inv-a");
    const before = state_signature(env.db);
    const cases: Array<[string, () => Promise<unknown>]> = [
      ["kind outside content kinds", () => create_object(env.service, env.ctx("inv-1"), { kind: "question" })],
      ["missing kind", () => create_object(env.service, env.ctx("inv-2"), {})],
      ["unknown artifact_kind", () => add_artifact(env.service, env.ctx("inv-3"), { object_id: bare.object_id, artifact_kind: "bogus", title: "t" })],
      ["empty title", () => add_artifact(env.service, env.ctx("inv-4"), { object_id: bare.object_id, ...ART_FIELDS, title: "  " })],
      ["unknown status", () => add_artifact(env.service, env.ctx("inv-5"), { object_id: bare.object_id, ...ART_FIELDS, title: "t", status: "bogus" })],
      ["unknown confidence", () => add_artifact(env.service, env.ctx("inv-6"), { object_id: bare.object_id, ...ART_FIELDS, title: "t", confidence: "certain" })],
      ["body_blob_id is PR9", () => add_artifact(env.service, env.ctx("inv-7"), { object_id: bare.object_id, ...ART_FIELDS, title: "t", body_blob_id: "b" })],
      ["unknown source method", () => add_source(env.service, env.ctx("inv-8"), { object_id: bare_s.object_id, ...SRC_FIELDS, method: "bogus", title: "t" })],
      ["unknown verification_state", () => add_source(env.service, env.ctx("inv-9"), { object_id: bare_s.object_id, ...SRC_FIELDS, verification_state: "maybe", title: "t" })],
      ["unknown source_kind", () => add_source(env.service, env.ctx("inv-10"), { object_id: bare_s.object_id, ...SRC_FIELDS, source_kind: "radio", title: "t" })],
      ["negative retrieved_at", () => add_source(env.service, env.ctx("inv-11"), { object_id: bare_s.object_id, ...SRC_FIELDS, retrieved_at: -1, title: "t" })],
      ["fractional retrieved_at", () => add_source(env.service, env.ctx("inv-12"), { object_id: bare_s.object_id, ...SRC_FIELDS, retrieved_at: 1.5, title: "t" })],
      ["locator must be an object", () => add_source(env.service, env.ctx("inv-13"), { object_id: bare_s.object_id, ...SRC_FIELDS, locator: "page 3", title: "t" })],
      ["append with unknown status", () => append_version(env.service, env.ctx("inv-14"), { object_id: art.object_id, title: "t", status: "bogus" })],
    ];
    for (const [label, call] of cases) {
      await rejects_api(call(), "invalid_payload").catch((e) => {
        throw new Error(`${label}: ${String(e)}`);
      });
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("add_artifact / add_source / append_version check the object: kind, bare/first-version state, ownership, project", async () => {
  await with_env(async (env) => {
    const art = await new_artifact(env, "ck-a");
    const art2 = await new_artifact(env, "ck-a2");
    const src = await new_source(env, "ck-s");
    const bare_a = await new_object(env, "ck-ba", "artifact");
    const bare_s = await new_object(env, "ck-bs", "source");
    const p2 = await bootstrap(env.service, "setup-p2", "synthetic-other");
    const before = state_signature(env.db);
    await rejects_api(add_source(env.service, env.ctx("ck-1"), { object_id: bare_a.object_id, ...SRC_FIELDS, title: "t" }), "conflict");
    await rejects_api(add_artifact(env.service, env.ctx("ck-2"), { object_id: bare_s.object_id, ...ART_FIELDS, title: "t" }), "conflict");
    await rejects_api(add_artifact(env.service, env.ctx("ck-3"), { object_id: art.object_id, ...ART_FIELDS, title: "again" }), "conflict");
    await rejects_api(add_source(env.service, env.ctx("ck-4"), { object_id: src.object_id, ...SRC_FIELDS, title: "again" }), "conflict");
    await rejects_api(append_version(env.service, env.ctx("ck-5"), { object_id: bare_a.object_id, title: "no first version yet" }), "conflict");
    await rejects_api(append_version(env.service, env.ctx("ck-6"), { object_id: "no-such-object", title: "t" }), "not_found");
    await rejects_api(
      append_version(env.service, env.ctx("ck-7"), { object_id: art.object_id, title: "t", based_on_version_id: art2.version_id }),
      "conflict",
    );
    await rejects_api(
      create_object(env.service, env.ctx("ck-8"), { kind: "artifact", edition_id: "no-such-edition" }),
      "not_found",
    );
    const other_edition = env.db.get<{ id: string }>("SELECT id FROM editions WHERE project_id = ?", p2.project_id);
    assert.ok(other_edition);
    await rejects_api(
      create_object(env.service, env.ctx("ck-9"), { kind: "artifact", edition_id: other_edition.id }),
      "not_found",
    );
    assert.equal(state_signature(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// 3. Footnotes: order, same URL different sources, old links stay on old versions

test("citations keep their order 1..n per artifact version, and each version numbers from 1", async () => {
  await with_env(async (env) => {
    const a1 = await new_artifact(env, "ord-a");
    const s1 = await new_source(env, "ord-s1", "출처 하나");
    const s2 = await new_source(env, "ord-s2", "출처 둘");
    const s3 = await new_source(env, "ord-s3", "출처 셋");
    const cite = async (key: string, artifact: string, source: string) =>
      ((await add_citation(env.service, env.ctx(key), { artifact_version_id: artifact, source_version_id: source })).result as {
        citation_no: number;
      }).citation_no;
    assert.equal(await cite("ord-1", a1.version_id, s2.version_id), 1);
    assert.equal(await cite("ord-2", a1.version_id, s3.version_id), 2);
    assert.equal(await cite("ord-3", a1.version_id, s1.version_id), 3);
    assert.deepEqual(
      citations_of(env.db, a1.version_id).map((c) => [c.citation_no, c.source_version_id]),
      [
        [1n, s2.version_id],
        [2n, s3.version_id],
        [3n, s1.version_id],
      ],
    );
    const a2 = await more_version(env, "ord-a2", a1.object_id);
    assert.equal(await cite("ord-4", a2.version_id, s1.version_id), 1, "a new artifact version numbers its footnotes from 1");
  });
});

test("the same URL under different sources stays as separate sources and separate footnotes", async () => {
  await with_env(async (env) => {
    const a = await new_artifact(env, "url-a");
    const s1 = await new_source(env, "url-s1", "같은 주소 자료 A", { url: "https://example.test/same" });
    const s2 = await new_source(env, "url-s2", "같은 주소 자료 B", { url: "https://example.test/same" });
    assert.notEqual(s1.object_id, s2.object_id);
    assert.notEqual(s1.version_id, s2.version_id);
    const rows = env.db.all<{ object_id: string }>("SELECT object_id FROM source_versions WHERE url = ?", "https://example.test/same");
    assert.equal(rows.length, 2);
    await add_citation(env.service, env.ctx("url-1"), { artifact_version_id: a.version_id, source_version_id: s1.version_id });
    await add_citation(env.service, env.ctx("url-2"), { artifact_version_id: a.version_id, source_version_id: s2.version_id });
    assert.deepEqual(
      citations_of(env.db, a.version_id).map((c) => c.source_version_id),
      [s1.version_id, s2.version_id],
    );
  });
});

test("new versions of both sides leave the old citations and relations pointing at the old versions", async () => {
  await with_env(async (env) => {
    const a1 = await new_artifact(env, "old-a", "합성 보고서");
    const s1 = await new_source(env, "old-s", "합성 출처");
    const t1 = await new_artifact(env, "old-t", "합성 대상");
    await add_citation(env.service, env.ctx("old-c1"), { artifact_version_id: a1.version_id, source_version_id: s1.version_id, quote: "합성 발췌" });
    await link_relation(env.service, env.ctx("old-r1"), { from_version_id: a1.version_id, to_version_id: t1.version_id, kind: "supports" });
    const cit_before = json_row(citations_of(env.db, a1.version_id));
    const rel_before = json_row(env.db.all("SELECT * FROM version_relations ORDER BY from_version_id, to_version_id, kind"));

    // new versions of the artifact, the source and the relation target; all become current
    const a2 = await more_version(env, "old-a2", a1.object_id, { title: "합성 보고서 2판" });
    const s2 = await more_version(env, "old-s2", s1.object_id, { title: "합성 출처 갱신", method: "browser", verification_state: "verified" });
    const t2 = await more_version(env, "old-t2", t1.object_id);
    for (const [key, v] of [
      ["old-sc1", a2],
      ["old-sc2", s2],
      ["old-sc3", t2],
    ] as const) {
      await set_current(env.service, env.ctx(key), { object_id: v.object_id, version_id: v.version_id });
    }
    await add_citation(env.service, env.ctx("old-c2"), { artifact_version_id: a2.version_id, source_version_id: s2.version_id });
    await link_relation(env.service, env.ctx("old-r2"), { from_version_id: a2.version_id, to_version_id: t2.version_id, kind: "supports" });

    assert.equal(json_row(citations_of(env.db, a1.version_id)), cit_before, "version 1 still cites the source's version 1");
    assert.equal(citations_of(env.db, a1.version_id)[0]?.source_version_id, s1.version_id);
    const old_rel = env.db.all<{ from_version_id: string; to_version_id: string }>(
      "SELECT from_version_id, to_version_id FROM version_relations WHERE from_version_id = ?",
      a1.version_id,
    );
    assert.deepEqual(old_rel, [{ from_version_id: a1.version_id, to_version_id: t1.version_id }]);
    assert.equal(citations_of(env.db, a2.version_id)[0]?.source_version_id, s2.version_id);
    const all_rel = json_row(env.db.all("SELECT * FROM version_relations WHERE from_version_id = ?", a1.version_id));
    assert.equal(all_rel, json_row(JSON.parse(rel_before).filter((r: { from_version_id: string }) => r.from_version_id === a1.version_id)));
  });
});

// ---------------------------------------------------------------------------
// 4. Source facts are stored: checked-at, excerpt, location, method / verdict

test("source versions store retrieved_at, quote, locator, method, verification_state, verifier and url as given", async () => {
  await with_env(async (env) => {
    const retrieved = START_MS - 86_400_000;
    const s = await new_source(env, "sf", "합성 통계표", {
      source_kind: "stat",
      canonical_locator: "synthetic-org/synthetic-table",
      url: "https://example.test/stat",
      locator: { page: "3", section: "2.1", orgId: "000", tblId: "T1" },
      retrieved_at: retrieved,
      method: "kosis",
      verification_state: "verified",
      quote: "합성 발췌문",
      verified_by_actor_id: env.p.actor_id,
    });
    const sv = env.db.get<Record<string, unknown>>("SELECT * FROM source_versions WHERE version_id = ?", s.version_id);
    assert.ok(sv);
    assert.equal(sv.retrieved_at, BigInt(retrieved));
    assert.equal(sv.quote, "합성 발췌문");
    assert.deepEqual(JSON.parse(sv.locator as string), { page: "3", section: "2.1", orgId: "000", tblId: "T1" });
    assert.equal(sv.method, "kosis");
    assert.equal(sv.verification_state, "verified");
    assert.equal(sv.verified_by_actor_id, env.p.actor_id);
    assert.equal(sv.url, "https://example.test/stat");
    assert.equal(sv.title, "합성 통계표");
    const src = env.db.get<{ kind: string; canonical_locator: string | null }>("SELECT kind, canonical_locator FROM sources WHERE object_id = ?", s.object_id);
    assert.deepEqual({ ...src }, { kind: "stat", canonical_locator: "synthetic-org/synthetic-table" });

    // a later check is a new version with its own time and verdict; the first stays as it was
    env.clock.advance(60_000);
    const s2 = await more_version(env, "sf2", s.object_id, {
      title: "합성 통계표",
      method: "fetch",
      verification_state: "partial",
      retrieved_at: START_MS,
      quote: "다른 발췌",
      locator: { page: "9" },
    });
    const sv2 = env.db.get<Record<string, unknown>>("SELECT * FROM source_versions WHERE version_id = ?", s2.version_id);
    assert.equal(sv2?.verification_state, "partial");
    assert.equal(sv2?.retrieved_at, BigInt(START_MS));
    assert.equal(sv2?.quote, "다른 발췌");
    const sv1_again = env.db.get<Record<string, unknown>>("SELECT * FROM source_versions WHERE version_id = ?", s.version_id);
    assert.equal(sv1_again?.verification_state, "verified");
    assert.equal(sv1_again?.retrieved_at, BigInt(retrieved));
  });
});

test("a citation stores its own excerpt and location next to the footnote number", async () => {
  await with_env(async (env) => {
    const a = await new_artifact(env, "cq-a");
    const s = await new_source(env, "cq-s");
    await add_citation(env.service, env.ctx("cq-1"), {
      artifact_version_id: a.version_id,
      source_version_id: s.version_id,
      quote: "합성 인용 발췌",
      locator: { page: "12", paragraph: "2" },
    });
    await add_citation(env.service, env.ctx("cq-2"), { artifact_version_id: a.version_id, source_version_id: s.version_id });
    const rows = citations_of(env.db, a.version_id);
    assert.equal(rows[0]?.quote, "합성 인용 발췌");
    assert.deepEqual(JSON.parse(rows[0]!.locator), { page: "12", paragraph: "2" });
    assert.equal(rows[1]?.quote, null);
    assert.deepEqual(JSON.parse(rows[1]!.locator), {});
  });
});

// ---------------------------------------------------------------------------
// 5. Unreadable sources get no excerpt

test("an unreachable source cannot carry an excerpt: add_source, append_version and add_citation reject it", async () => {
  await with_env(async (env) => {
    const bare = await new_object(env, "un-o", "source");
    const art = await new_artifact(env, "un-a");
    const before = state_signature(env.db);
    await rejects_api(
      add_source(env.service, env.ctx("un-1"), { object_id: bare.object_id, ...SRC_FIELDS, verification_state: "unreachable", title: "읽지 못함", quote: "지어낸 발췌" }),
      "invalid_payload",
    );
    assert.equal(state_signature(env.db), before);

    // without an excerpt an unreachable source is fine
    const ok = (
      await add_source(env.service, env.ctx("un-2"), { object_id: bare.object_id, ...SRC_FIELDS, verification_state: "unreachable", title: "읽지 못함" })
    ).result as VersionResult;
    const quote = env.db.get<{ quote: string | null }>("SELECT quote FROM source_versions WHERE version_id = ?", ok.version_id);
    assert.equal(quote?.quote, null);

    const before2 = state_signature(env.db);
    await rejects_api(
      append_version(env.service, env.ctx("un-3"), { object_id: bare.object_id, title: "여전히 못 읽음", verification_state: "unreachable", method: "fetch", quote: "발췌" }),
      "invalid_payload",
    );
    await rejects_api(
      add_citation(env.service, env.ctx("un-4"), { artifact_version_id: art.version_id, source_version_id: ok.version_id, quote: "못 읽은 자료의 발췌" }),
      "invalid_payload",
    );
    assert.equal(state_signature(env.db), before2);

    // citing it without an excerpt is allowed
    await add_citation(env.service, env.ctx("un-5"), { artifact_version_id: art.version_id, source_version_id: ok.version_id });
  });
});

test("an excerpt is still allowed against an earlier, readable version of a source whose latest check failed", async () => {
  await with_env(async (env) => {
    const art = await new_artifact(env, "un2-a");
    const s1 = await new_source(env, "un2-s", "처음엔 읽음", { verification_state: "verified", quote: "처음 발췌" });
    const s2 = await more_version(env, "un2-s2", s1.object_id, { method: "fetch", verification_state: "unreachable" });
    await add_citation(env.service, env.ctx("un2-1"), { artifact_version_id: art.version_id, source_version_id: s1.version_id, quote: "처음 발췌" });
    await rejects_api(
      add_citation(env.service, env.ctx("un2-2"), { artifact_version_id: art.version_id, source_version_id: s2.version_id, quote: "x" }),
      "invalid_payload",
    );
  });
});

// ---------------------------------------------------------------------------
// 6. library.json import

const LIBRARY = JSON.parse(readFileSync(LIBRARY_FIXTURE, "utf8")) as Record<string, unknown>;

interface ImportResult {
  already_imported: boolean;
  items: Array<{ legacy_id: string; object_id: string; version_id: string }>;
}

test("import_library turns items into library objects (edition_id NULL) with current versions, sources and ordered citations", async () => {
  await with_env(async (env) => {
    const out = await import_library(env.service, env.ctx("lib-1", "import"), { library: LIBRARY });
    const r = out.result as ImportResult;
    assert.equal(r.already_imported, false);
    assert.deepEqual(r.items.map((i) => i.legacy_id), ["L1", "L2", "L3"]);

    const objs = env.db.all<ObjectRow>("SELECT * FROM objects WHERE project_id = ? ORDER BY kind, display_no", env.p.project_id);
    assert.equal(objs.filter((o) => o.kind === "artifact").length, 3);
    assert.equal(objs.filter((o) => o.kind === "source").length, 3, "the same URL used 3 times stays 3 sources");
    assert.ok(objs.every((o) => o.edition_id === null && o.current_version_id !== null));

    const [l1, l2, l3] = r.items as [ImportResult["items"][0], ImportResult["items"][0], ImportResult["items"][0]];
    assert.deepEqual(
      r.items.map((i) => object_row(env.db, i.object_id).display_no),
      [1n, 2n, 3n],
      "library items are numbered in file order",
    );
    for (const i of r.items) assert.equal(object_row(env.db, i.object_id).current_version_id, i.version_id);

    const av = (id: string) => env.db.get<Record<string, unknown>>("SELECT * FROM artifact_versions WHERE version_id = ?", id)!;
    const a1 = av(l1.version_id);
    assert.equal(a1.title, "합성 항목 하나");
    assert.equal(a1.question, "합성 질문은 무엇인가?");
    assert.equal(a1.summary, "합성 요약 하나");
    assert.equal(a1.body_md, "합성 본문 하나\n\n둘째 문단");
    assert.equal(a1.status, "done");
    assert.equal(a1.confidence, "medium");
    assert.deepEqual(JSON.parse(a1.stats as string), [{ name: "합성 지표", value: "12", unit: "건" }]);
    assert.deepEqual(JSON.parse(a1.conflicts as string), ["합성 상충 메모"]);
    assert.equal((JSON.parse(a1.verify as string) as { claims: unknown[] }).claims.length, 1);
    assert.equal(
      env.db.get<{ kind: string }>("SELECT kind FROM artifacts WHERE object_id = ?", l1.object_id)?.kind,
      "topic",
    );
    const meta1 = JSON.parse(a1.metadata_json as string) as { legacy_extra: Record<string, unknown> };
    assert.equal(meta1.legacy_extra.legacy_id, "L1");
    assert.equal(meta1.legacy_extra.depth, 2);

    // removed items are kept, not dropped
    const a2 = av(l2.version_id);
    assert.equal(a2.status, "removed");
    assert.ok(object_row(env.db, l2.object_id).archived_at !== null);
    assert.equal(object_row(env.db, l1.object_id).archived_at, null);

    // unknown kind -> note; unknown keys survive under legacy_extra
    assert.equal(env.db.get<{ kind: string }>("SELECT kind FROM artifacts WHERE object_id = ?", l3.object_id)?.kind, "note");
    const meta3 = JSON.parse(av(l3.version_id).metadata_json as string) as { legacy_extra: Record<string, unknown> };
    assert.equal(meta3.legacy_extra.kind_original, "mystery");
    assert.equal(meta3.legacy_extra.custom_field, "합성 임의 값");

    // sources and footnotes
    const cites = citations_of(env.db, l1.version_id);
    assert.equal(cites.length, 2);
    assert.deepEqual(cites.map((c) => c.citation_no), [1n, 2n]);
    const sv = (id: string) => env.db.get<Record<string, unknown>>("SELECT * FROM source_versions WHERE version_id = ?", id)!;
    const sa = sv(cites[0]!.source_version_id);
    const sb = sv(cites[1]!.source_version_id);
    assert.equal(sa.title, "합성 출처 A");
    assert.equal(sb.title, "합성 출처 B");
    assert.notEqual(sa.object_id, sb.object_id, "same URL, two sources");
    assert.equal(sa.url, sb.url);
    assert.equal(sa.method, "fetch");
    assert.equal(sb.method, "search");
    assert.equal(sa.verification_state, "legacy_unknown");
    assert.equal(sa.retrieved_at, null);
    const loc = JSON.parse(sa.locator as string) as Record<string, unknown>;
    assert.equal(loc.date, "2025-12-31");
    assert.equal(loc.note, "합성 메모 A");
    assert.equal(env.db.get<{ kind: string }>("SELECT kind FROM sources WHERE object_id = ?", sa.object_id as string)?.kind, "web");
    assert.equal(citations_of(env.db, l2.version_id).length, 0);
    const c3 = citations_of(env.db, l3.version_id);
    assert.equal(c3.length, 1);
    assert.equal(sv(c3[0]!.source_version_id).url, "https://example.test/shared-page");

    // receipt + events of the import are in the same tx
    const rc = receipt_for(env.db, env.p.project_id, "lib-1");
    assert.ok(rc);
    assert.ok(events_of(env.db, rc.id).length >= 1);
    for (const o of objs) {
      const v = env.db.get<{ tx_id: string }>("SELECT tx_id FROM object_versions WHERE id = ?", o.current_version_id!);
      assert.equal(v?.tx_id, rc.id, "every imported version belongs to the import's tx");
    }
  });
});

test("import_library preserves the original library JSON in the import event payload", async () => {
  await with_env(async (env) => {
    await import_library(env.service, env.ctx("lib-orig", "import"), { library: LIBRARY });
    const rc = receipt_for(env.db, env.p.project_id, "lib-orig");
    assert.ok(rc);
    const evs = events_of(env.db, rc.id);
    const imported = evs.find((e) => e.type === "content.library_imported");
    assert.ok(imported, "a content.library_imported event exists");
    const payload = JSON.parse(imported.payload) as { original: unknown };
    assert.deepEqual(payload.original, LIBRARY, "top-level keys (source, imported, round, topic, settings, suggestions, warnings) and items survive");
  });
});

test("import_library again with the same library creates no duplicates and returns the first run's ids", async () => {
  await with_env(async (env) => {
    const first_out = await import_library(env.service, env.ctx("lib-a", "import"), { library: LIBRARY });
    const first = first_out.result as ImportResult;
    const counts = table_counts(env.db);
    const grouped = (c: Record<string, bigint>) => {
      const { mutation_commits: _m, events: _e, ...rest } = c;
      return rest;
    };
    const next_nos = json_row(env.db.all("SELECT * FROM counters ORDER BY project_id, namespace"));
    const again = await import_library(env.service, env.ctx("lib-b", "import"), { library: structuredClone(LIBRARY) });
    const r = again.result as ImportResult;
    assert.equal(again.replayed, false, "a new key is a new request");
    assert.equal(r.already_imported, true);
    assert.deepEqual(r.items, first.items);
    assert.deepEqual(grouped(table_counts(env.db)), grouped(counts));
    assert.equal(json_row(env.db.all("SELECT * FROM counters ORDER BY project_id, namespace")), next_nos);

    // the same key replays the stored result and writes nothing at all
    const sig = state_signature(env.db);
    const replay = await import_library(env.service, env.ctx("lib-a", "import"), { library: LIBRARY });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, first_out.result);
    assert.equal(state_signature(env.db), sig);
  });
});

test("import_library rejects a malformed library and writes nothing; a mid-import failure rolls everything back", async () => {
  await with_env(async (env) => {
    const before = state_signature(env.db);
    for (const library of [
      null,
      "text",
      [],
      { items: "nope" },
      { items: [{ title: "id 없음" }] },
      { items: [{ id: "L1", title: "t", sources: "nope" }] },
      { items: [{ id: "L1", title: "t" }, { id: "L1", title: "중복 id" }] },
    ]) {
      await rejects_api(import_library(env.service, env.ctx("lib-bad", "import"), { library }), "invalid_payload");
    }
    await rejects_api(import_library(env.service, env.ctx("lib-bad", "import"), { library: LIBRARY, extra: 1 }), "invalid_payload");
    assert.equal(state_signature(env.db), before);

    let hits = 0;
    const failing = env.with_db(
      wrap_db(env.db, (sql) => {
        if (/insert\s+into\s+citations/i.test(sql) && ++hits === 2) throw new Error("injected citation failure");
        return undefined;
      }),
    );
    await rejects_any(import_library(failing, env.ctx("lib-fail", "import"), { library: LIBRARY }));
    assert.ok(hits >= 2, "the failure fired after earlier rows were written");
    assert.equal(state_signature(env.db), before, "objects, versions, sources, events and receipt all rolled back");
    const ok = await import_library(env.service, env.ctx("lib-fail", "import"), { library: LIBRARY });
    assert.equal(ok.replayed, false, "the failed attempt left no receipt, so the key can be used again");
    assert.equal((ok.result as ImportResult).already_imported, false);
  });
});

// ---------------------------------------------------------------------------
// 7. PR4 rules for every content command

interface Ids {
  art_obj: string;
  art_v1: string;
  art_v2: string; // latest, not current
  src_obj: string;
  src_v1: string;
  bare_art: string;
  bare_src: string;
  other_v1: string;
}

async function prepare(env: Env): Promise<Ids> {
  const a1 = await new_artifact(env, "pre-a");
  const a2 = await more_version(env, "pre-a2", a1.object_id);
  const s1 = await new_source(env, "pre-s");
  const other = await new_artifact(env, "pre-o");
  const bare_a = await new_object(env, "pre-ba", "artifact");
  const bare_s = await new_object(env, "pre-bs", "source");
  return {
    art_obj: a1.object_id,
    art_v1: a1.version_id,
    art_v2: a2.version_id,
    src_obj: s1.object_id,
    src_v1: s1.version_id,
    bare_art: bare_a.object_id,
    bare_src: bare_s.object_id,
    other_v1: other.version_id,
  };
}

type Call = (env: Env, ids: Ids, key: string, service?: CommandService) => Promise<CommandOutcome>;

const CASES: Array<{ name: (typeof CONTENT_COMMANDS)[number]; call: Call }> = [
  {
    name: "content.create_object",
    call: (env, _i, key, s = env.service) => create_object(s, env.ctx(key), { kind: "artifact" }),
  },
  {
    name: "content.add_artifact",
    call: (env, i, key, s = env.service) =>
      add_artifact(s, env.ctx(key), { object_id: i.bare_art, ...ART_FIELDS, title: "합성 새 항목" }),
  },
  {
    name: "content.add_source",
    call: (env, i, key, s = env.service) =>
      add_source(s, env.ctx(key), { object_id: i.bare_src, ...SRC_FIELDS, title: "합성 새 출처", url: "https://example.test/new" }),
  },
  {
    name: "content.append_version",
    call: (env, i, key, s = env.service) => append_version(s, env.ctx(key), { object_id: i.art_obj, title: "합성 3판" }),
  },
  {
    name: "content.set_current",
    call: (env, i, key, s = env.service) => set_current(s, env.ctx(key), { object_id: i.art_obj, version_id: i.art_v2 }),
  },
  {
    name: "content.add_citation",
    call: (env, i, key, s = env.service) =>
      add_citation(s, env.ctx(key), { artifact_version_id: i.art_v2, source_version_id: i.src_v1, quote: "합성 발췌" }),
  },
  {
    name: "content.link_relation",
    call: (env, i, key, s = env.service) =>
      link_relation(s, env.ctx(key), { from_version_id: i.art_v2, to_version_id: i.other_v1, kind: "supports" }),
  },
  {
    name: "content.import_library",
    call: (env, _i, key, s = env.service) => import_library(s, env.ctx(key, "import"), { library: LIBRARY }),
  },
];

for (const c of CASES) {
  test(`${c.name}: receipt and events are written in the same tx, with the registered action`, async () => {
    await with_env(async (env) => {
      const ids = await prepare(env);
      const out = await c.call(env, ids, "k-1");
      assert.equal(out.replayed, false);
      const result = out.result as { project_id: string };
      assert.equal(result.project_id, env.p.project_id);
      const rc = receipt_for(env.db, env.p.project_id, "k-1");
      assert.ok(rc, "a receipt exists");
      assert.equal(rc.action, COMMANDS.get(c.name)?.action);
      assert.equal(rc.actor_id, env.p.actor_id);
      const events = events_of(env.db, rc.id);
      assert.ok(events.length >= 1, "at least one event");
      assert.ok(events.every((e) => e.tx_size === BigInt(events.length)));
      assert.deepEqual(
        events.map((e) => Number(e.tx_index)),
        events.map((_e, n) => n),
      );
      assert.ok(events.every((e) => e.type.length > 0));
    });
  });

  test(`${c.name}: the same key and request replays without writing; a different request under that key is rejected`, async () => {
    await with_env(async (env) => {
      const ids = await prepare(env);
      const first = await c.call(env, ids, "k-1");
      const sig = state_signature(env.db);
      const replay = await c.call(env, ids, "k-1");
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.result, first.result);
      assert.equal(state_signature(env.db), sig);

      // another request under the same key: a different payload (same command) or a different command
      const other: Call =
        c.name === "content.create_object"
          ? (e, _i, key) => create_object(e.service, e.ctx(key), { kind: "source" })
          : (e, _i, key) => create_object(e.service, e.ctx(key), { kind: "artifact" });
      await rejects_api(other(env, ids, "k-1"), "idempotency_key_reuse");
      assert.equal(state_signature(env.db), sig);
    });
  });

  test(`${c.name}: the policy check runs before replay and before any write`, async () => {
    await with_env(async (env) => {
      const ids = await prepare(env);
      const before_denied = state_signature(env.db);
      env.policy.allowed = false;
      env.policy.calls = 0;
      await rejects_api(c.call(env, ids, "k-denied"), "policy_denied");
      assert.equal(env.policy.calls, 1);
      assert.equal(state_signature(env.db), before_denied, "a denied command writes nothing");
      env.policy.allowed = true;

      await c.call(env, ids, "k-1");
      const sig = state_signature(env.db);
      env.policy.allowed = false;
      await rejects_api(c.call(env, ids, "k-1"), "policy_denied"); // same request: no replay once OFF
      await rejects_api(create_object(env.service, env.ctx("k-1"), { kind: "source" }), "policy_denied"); // not key-reuse either
      assert.equal(state_signature(env.db), sig);
    });
  });

  test(`${c.name}: an unknown or missing payload field is rejected and leaves no receipt`, async () => {
    await with_env(async (env) => {
      await prepare(env);
      const before = state_signature(env.db);
      await rejects_api(env.service.execute(env.ctx("k-bad"), c.name, { unexpected_field: 1 }), "invalid_payload");
      await rejects_api(env.service.execute(env.ctx("k-bad"), c.name, null), "invalid_payload");
      assert.equal(state_signature(env.db), before);
      assert.equal(receipt_for(env.db, env.p.project_id, "k-bad"), undefined);
    });
  });

  test(`${c.name}: a failing event insert rolls the whole command back and the key stays usable`, async () => {
    await with_env(async (env) => {
      const ids = await prepare(env);
      const before = state_signature(env.db);
      const failing = env.with_db(
        wrap_db(env.db, (sql) => {
          if (/insert\s+into\s+events/i.test(sql)) throw new Error("injected event failure");
          return undefined;
        }),
      );
      await rejects_any(c.call(env, ids, "k-fail", failing));
      assert.equal(state_signature(env.db), before, "no business row, event or receipt remains");
      assert.equal(receipt_for(env.db, env.p.project_id, "k-fail"), undefined);
      const retry = await c.call(env, ids, "k-fail");
      assert.equal(retry.replayed, false);
    });
  });

  test(`${c.name}: a failing receipt insert rolls the whole command back`, async () => {
    await with_env(async (env) => {
      const ids = await prepare(env);
      const before = state_signature(env.db);
      const failing = env.with_db(
        wrap_db(env.db, (sql) => {
          if (/insert\s+into\s+mutation_commits/i.test(sql)) throw new Error("injected receipt failure");
          return undefined;
        }),
      );
      await rejects_any(c.call(env, ids, "k-fail2", failing));
      assert.equal(state_signature(env.db), before);
    });
  });
}

test("a content command by an actor outside the project is forbidden and writes nothing", async () => {
  await with_env(async (env) => {
    const p2 = await bootstrap(env.service, "setup-p2", "synthetic-other");
    const before = state_signature(env.db);
    await rejects_api(
      create_object(env.service, { project_id: env.p.project_id, actor_id: p2.actor_id, via: "cli", client_request_id: "x-1" }, { kind: "artifact" }),
      "forbidden",
    );
    assert.equal(state_signature(env.db), before);
  });
});

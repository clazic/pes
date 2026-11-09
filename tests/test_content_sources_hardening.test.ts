// SEL-40 (stage 2 PR7) hardening: adversarial tests added after the gate passed.
// Interface: see the comment at the top of tests/test_content_sources.test.ts.
// Rows from db.get() are null-prototype objects: compare with { ...row } or JSON.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FakeClock } from "../scripts/pes_core/clock.ts";
import {
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
import { state_signature } from "./helpers/state_signature.ts";

const START_MS = 1_760_000_000_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const LIBRARY = JSON.parse(readFileSync(join(HERE, "fixtures", "library_synthetic.json"), "utf8")) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Harness (same shape as the main test file)

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
    { slug, topic: "합성 보강 주제", owner_display_name: "합성 소유자" },
  );
  const r = out.result as { project_id: string; owner_actor_id: string; edition_id: string };
  return { project_id: r.project_id, actor_id: r.owner_actor_id, edition_id: r.edition_id };
}

function ctx_for(p: Project, key: string, via: MutationContext["via"] = "cli"): MutationContext {
  return { project_id: p.project_id, actor_id: p.actor_id, via, client_request_id: key };
}

async function make_env(): Promise<Env> {
  const home = isolated_home("pes-sel40h-");
  const db = connect(db_path(home.env));
  migrate(db);
  const clock = new FakeClock(START_MS);
  const policy = new FakePolicy();
  const service = new CommandService(db, { clock, policy });
  const p = await bootstrap(service, "setup-p", "synthetic-hardening");
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

function js(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v.toString()}n` : v));
}

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
interface ImportResult {
  project_id: string;
  already_imported: boolean;
  items: Array<{ legacy_id: string; object_id: string; version_id: string }>;
}

const ART_FIELDS = { artifact_kind: "chapter", summary: "합성 요약" } as const;
const SRC_FIELDS = { source_kind: "web", method: "fetch", verification_state: "unverified" } as const;
const SRC_VER = { method: "fetch", verification_state: "unverified" } as const; // append_version takes no source_kind

async function new_object_in(service: CommandService, ctx: MutationContext, kind: "artifact" | "source", edition_id?: string | null) {
  const input = edition_id === undefined ? { kind } : { kind, edition_id };
  return (await create_object(service, ctx, input)).result as ObjectResult;
}

async function new_artifact_in(service: CommandService, p: Project, key: string, title = "합성 장", extra: Record<string, unknown> = {}) {
  const obj = await new_object_in(service, ctx_for(p, `${key}-o`), "artifact", p.edition_id);
  const out = await add_artifact(service, ctx_for(p, `${key}-v`), { object_id: obj.object_id, ...ART_FIELDS, title, ...extra });
  return out.result as VersionResult;
}

async function new_source_in(service: CommandService, p: Project, key: string, title = "합성 출처", extra: Record<string, unknown> = {}) {
  const obj = await new_object_in(service, ctx_for(p, `${key}-o`), "source");
  const out = await add_source(service, ctx_for(p, `${key}-v`), {
    object_id: obj.object_id,
    ...SRC_FIELDS,
    title,
    url: "https://example.test/page",
    ...extra,
  });
  return out.result as VersionResult;
}

const new_artifact = (env: Env, key: string, title?: string, extra?: Record<string, unknown>) =>
  new_artifact_in(env.service, env.p, key, title, extra);
const new_source = (env: Env, key: string, title?: string, extra?: Record<string, unknown>) =>
  new_source_in(env.service, env.p, key, title, extra);

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

function count(db: Db, sql: string, ...params: SqlValue[]): number {
  const row = db.get<{ n: bigint }>(sql, ...params);
  return Number(row?.n ?? 0n);
}

function citation_numbers(db: Db, artifact_version_id: string): number[] {
  return db
    .all<{ citation_no: bigint }>("SELECT citation_no FROM citations WHERE artifact_version_id = ? ORDER BY citation_no", artifact_version_id)
    .map((r) => Number(r.citation_no));
}

const VERSION_TABLES = [
  "objects",
  "object_versions",
  "artifacts",
  "artifact_versions",
  "sources",
  "source_versions",
  "citations",
  "version_relations",
] as const;

/** every row of the content tables, one JSON string per row, per table */
function content_rows(db: Db): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of VERSION_TABLES) out[t] = db.all(`SELECT * FROM ${t} ORDER BY rowid`).map((r) => js({ ...(r as object) }));
  return out;
}

// ---------------------------------------------------------------------------
// 1. The past cannot be changed through any command

test("a long mix of every content command never alters a row that already existed (only objects.current/rev may move)", async () => {
  await with_env(async (env) => {
    const a = await new_artifact(env, "p-a", "첫째");
    const s = await new_source(env, "p-s");
    const s2 = await more_version(env, "p-s2", s.object_id, { ...SRC_VER, verification_state: "unreachable" }).catch(
      () => null,
    );
    void s2;
    await add_citation(env.service, env.ctx("p-c1"), { artifact_version_id: a.version_id, source_version_id: s.version_id, quote: "합성 발췌" });
    const a2 = await more_version(env, "p-a2", a.object_id);
    const before = content_rows(env.db);

    // lots of further activity that must only add rows
    const a3 = await more_version(env, "p-a3", a.object_id, { based_on_version_id: a.version_id });
    await add_citation(env.service, env.ctx("p-c2"), { artifact_version_id: a3.version_id, source_version_id: s.version_id });
    await link_relation(env.service, env.ctx("p-l1"), { from_version_id: a3.version_id, to_version_id: a.version_id, kind: "supersedes" });
    await set_current(env.service, env.ctx("p-sc1"), { object_id: a.object_id, version_id: a2.version_id });
    await set_current(env.service, env.ctx("p-sc2"), { object_id: a.object_id, version_id: a.version_id });
    await import_library(env.service, env.ctx("p-imp", "import"), { library: LIBRARY });
    await more_version(env, "p-s3", s.object_id, { verification_state: "verified", method: "browser", quote: "합성 확인 발췌" });

    const after = content_rows(env.db);
    for (const table of VERSION_TABLES) {
      if (table === "objects") continue;
      const now = new Set(after[table]);
      for (const row of before[table]) assert.ok(now.has(row), `${table}: an old row changed or vanished: ${row.slice(0, 120)}`);
    }
    // objects: the only permitted change to an old row is current_version_id + rev
    const strip = (r: string) => {
      const o = JSON.parse(r) as Record<string, unknown>;
      delete o.current_version_id;
      delete o.rev;
      return JSON.stringify(o);
    };
    const now_objects = new Set(after.objects.map(strip));
    for (const row of before.objects) assert.ok(now_objects.has(strip(row)), "an object row changed beyond current_version_id/rev");
  });
});

test("rev only moves on set_current; append/cite/link/import never touch the pointer or rev of an existing object", async () => {
  await with_env(async (env) => {
    const a = await new_artifact(env, "r-a");
    const s = await new_source(env, "r-s");
    const snap = () => js(env.db.all("SELECT id, current_version_id, rev FROM objects ORDER BY rowid").map((r) => ({ ...r })));
    const s0 = snap();
    const a2 = await more_version(env, "r-a2", a.object_id);
    await more_version(env, "r-s2", s.object_id, SRC_VER);
    assert.equal(snap(), s0, "append_version leaves current and rev alone");
    await add_citation(env.service, env.ctx("r-c"), { artifact_version_id: a2.version_id, source_version_id: s.version_id });
    await link_relation(env.service, env.ctx("r-l"), { from_version_id: a2.version_id, to_version_id: s.version_id, kind: "reuses" });
    assert.equal(snap(), s0, "citation and relation leave current and rev alone");
    const before_ids = new Set(env.db.all<{ id: string }>("SELECT id FROM objects").map((r) => r.id));
    await import_library(env.service, env.ctx("r-i", "import"), { library: LIBRARY });
    const moved = env.db
      .all<{ id: string; current_version_id: string | null; rev: bigint }>("SELECT id, current_version_id, rev FROM objects")
      .filter((r) => before_ids.has(r.id));
    assert.equal(js(moved.map((r) => ({ ...r })).sort((x, y) => x.id.localeCompare(y.id))), js(JSON.parse(s0).sort((x: { id: string }, y: { id: string }) => x.id.localeCompare(y.id))));
  });
});

test("system-owned columns cannot be supplied by any content command (version_no, hash, tx, project, ids, times, actor)", async () => {
  await with_env(async (env) => {
    const a = await new_artifact(env, "sys-a");
    const s = await new_source(env, "sys-s");
    const bare_a = await new_object_in(env.service, env.ctx("sys-ba"), "artifact");
    const bare_s = await new_object_in(env.service, env.ctx("sys-bs"), "source");
    const before = state_signature(env.db);
    const forbidden = {
      version_no: 1,
      content_hash: "0".repeat(64),
      tx_id: "x",
      project_id: env.p.project_id,
      id: "forced-id",
      version_id: "forced-version",
      created_at: 1,
      actor_id: env.p.actor_id,
      object_kind: "artifact",
      current_version_id: a.version_id,
      rev: 99,
      archived_at: 1,
      citation_no: 1,
      display_no: 1,
    };
    let n = 0;
    for (const [k, v] of Object.entries(forbidden)) {
      n += 1;
      const extra = { [k]: v };
      await rejects_api(add_artifact(env.service, env.ctx(`sys-${n}a`), { object_id: bare_a.object_id, ...ART_FIELDS, title: "t", ...extra }), "invalid_payload");
      await rejects_api(add_source(env.service, env.ctx(`sys-${n}b`), { object_id: bare_s.object_id, ...SRC_FIELDS, title: "t", ...extra }), "invalid_payload");
      await rejects_api(append_version(env.service, env.ctx(`sys-${n}c`), { object_id: a.object_id, title: "t", ...extra }), "invalid_payload");
      await rejects_api(append_version(env.service, env.ctx(`sys-${n}d`), { object_id: s.object_id, title: "t", ...extra }), "invalid_payload");
      if (k !== "version_id") await rejects_api(set_current(env.service, env.ctx(`sys-${n}e`), { object_id: a.object_id, version_id: a.version_id, ...extra }), "invalid_payload");
      await rejects_api(
        add_citation(env.service, env.ctx(`sys-${n}f`), { artifact_version_id: a.version_id, source_version_id: s.version_id, ...extra }),
        "invalid_payload",
      );
      await rejects_api(
        link_relation(env.service, env.ctx(`sys-${n}g`), { from_version_id: a.version_id, to_version_id: s.version_id, kind: "related", ...extra }),
        "invalid_payload",
      );
      await rejects_api(create_object(env.service, env.ctx(`sys-${n}h`), { kind: "artifact", ...extra }), "invalid_payload");
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("the content hash changes with every content field and is the same for the same content", async () => {
  await with_env(async (env) => {
    const hash = (id: string) => env.db.get<{ content_hash: string }>("SELECT content_hash FROM object_versions WHERE id = ?", id)?.content_hash;
    const a = await new_artifact(env, "h-a", "제목");
    const base = hash(a.version_id);
    const seen = new Set<string | undefined>([base]);
    const variants: Array<Record<string, unknown>> = [
      { title: "다른 제목" },
      { title: "제목", summary: "다른 요약" },
      { title: "제목", question: "q" },
      { title: "제목", body_md: "b" },
      { title: "제목", status: "done" },
      { title: "제목", confidence: "high" },
      { title: "제목", stats: [{ n: 1 }] },
      { title: "제목", conflicts: ["c"] },
      { title: "제목", verify: { claims: [] } },
      { title: "제목", metadata: { k: 1 } },
    ];
    let i = 0;
    for (const v of variants) {
      i += 1;
      const r = await more_version(env, `h-v${i}`, a.object_id, v);
      const h = hash(r.version_id);
      assert.match(h ?? "", /^[0-9a-f]{64}$/);
      assert.ok(!seen.has(h), `variant ${JSON.stringify(v)} produced a hash already seen`);
      seen.add(h);
    }
    const same = await more_version(env, "h-same", a.object_id, { title: "제목", summary: "합성 요약" });
    assert.equal(hash(same.version_id), base, "identical content has the identical hash");
  });
});

// ---------------------------------------------------------------------------
// 2. set_current: other project / other kind / other object

test("set_current cannot reach across projects, kinds or objects even when the ids are valid somewhere", async () => {
  await with_env(async (env) => {
    const p2 = await bootstrap(env.service, "h-p2", "synthetic-other");
    const a = await new_artifact(env, "sc-a");
    const a_other = await new_artifact(env, "sc-b");
    const s = await new_source(env, "sc-s");
    const bare = await new_object_in(env.service, env.ctx("sc-bare"), "artifact");
    const fa = await new_artifact_in(env.service, p2, "sc-f");
    const before = state_signature(env.db);
    const ctx2 = (key: string) => ctx_for(p2, key);

    // project 1's own ids used from project 2, and the reverse
    await rejects_api(set_current(env.service, ctx2("x1"), { object_id: a.object_id, version_id: a.version_id }), "not_found");
    await rejects_api(set_current(env.service, ctx2("x2"), { object_id: fa.object_id, version_id: a.version_id }), "not_found");
    await rejects_api(set_current(env.service, env.ctx("x3"), { object_id: a.object_id, version_id: fa.version_id }), "not_found");
    // same project: other object, other kind, a bare object with someone else's version
    await rejects_api(set_current(env.service, env.ctx("x4"), { object_id: a.object_id, version_id: a_other.version_id }), "conflict");
    await rejects_api(set_current(env.service, env.ctx("x5"), { object_id: s.object_id, version_id: a.version_id }), "conflict");
    await rejects_api(set_current(env.service, env.ctx("x6"), { object_id: bare.object_id, version_id: a.version_id }), "conflict");
    await rejects_api(set_current(env.service, env.ctx("x7"), { object_id: a.object_id, version_id: ` ${a.version_id}` }), "not_found");
    await rejects_api(set_current(env.service, env.ctx("x8"), { object_id: a.object_id, version_id: a.version_id.toUpperCase() }), "not_found");
    await rejects_api(set_current(env.service, env.ctx("x9"), { object_id: a.object_id, version_id: "" }), "invalid_payload");
    await rejects_api(set_current(env.service, env.ctx("x10"), { object_id: a.object_id, version_id: null }), "invalid_payload");
    await rejects_api(set_current(env.service, env.ctx("x11"), { object_id: a.object_id }), "invalid_payload");
    assert.equal(state_signature(env.db), before, "nothing changed anywhere");
  });
});

test("after set_current back to an old version the old version stays sealed; the new default base is the pointed version", async () => {
  await with_env(async (env) => {
    const a = await new_artifact(env, "sb-a");
    const s = await new_source(env, "sb-s");
    const a2 = await more_version(env, "sb-a2", a.object_id);
    await set_current(env.service, env.ctx("sb-1"), { object_id: a.object_id, version_id: a.version_id });
    await rejects_api(add_citation(env.service, env.ctx("sb-2"), { artifact_version_id: a.version_id, source_version_id: s.version_id }), "conflict");
    await rejects_api(link_relation(env.service, env.ctx("sb-3"), { from_version_id: a.version_id, to_version_id: s.version_id, kind: "related" }), "conflict");
    // appending without based_on uses the current pointer (v1), numbering still moves on to 3
    const a3 = await more_version(env, "sb-4", a.object_id);
    assert.equal(a3.version_no, 3);
    const base = env.db.get<{ based_on_version_id: string | null }>("SELECT based_on_version_id FROM object_versions WHERE id = ?", a3.version_id);
    assert.equal(base?.based_on_version_id, a.version_id);
    // the former latest (v2) is sealed now
    await rejects_api(add_citation(env.service, env.ctx("sb-5"), { artifact_version_id: a2.version_id, source_version_id: s.version_id }), "conflict");
    assert.equal(object_row(env.db, a.object_id).current_version_id, a.version_id, "append did not move the pointer");
  });
});

test("a bare object (no first version) cannot be pointed at, appended to, cited or related", async () => {
  await with_env(async (env) => {
    const bare = await new_object_in(env.service, env.ctx("bo-1"), "artifact");
    const bare_s = await new_object_in(env.service, env.ctx("bo-2"), "source");
    const a = await new_artifact(env, "bo-a");
    const before = state_signature(env.db);
    await rejects_api(append_version(env.service, env.ctx("bo-3"), { object_id: bare.object_id, title: "t" }), "conflict");
    await rejects_api(append_version(env.service, env.ctx("bo-4"), { object_id: bare_s.object_id, title: "t", ...SRC_VER }), "conflict");
    await rejects_api(set_current(env.service, env.ctx("bo-5"), { object_id: bare.object_id, version_id: a.version_id }), "conflict");
    await rejects_api(add_citation(env.service, env.ctx("bo-6"), { artifact_version_id: bare.object_id, source_version_id: a.version_id }), "not_found");
    // a source object cannot receive an artifact first version and vice versa
    await rejects_api(add_artifact(env.service, env.ctx("bo-7"), { object_id: bare_s.object_id, ...ART_FIELDS, title: "t" }), "conflict");
    await rejects_api(add_source(env.service, env.ctx("bo-8"), { object_id: bare.object_id, ...SRC_FIELDS, title: "t" }), "conflict");
    // and an object that already has version 1 cannot be given another "first" version
    await rejects_api(add_artifact(env.service, env.ctx("bo-9"), { object_id: a.object_id, ...ART_FIELDS, title: "다시 처음" }), "conflict");
    assert.equal(state_signature(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// 3. Same URL, different source

test("sources sharing URL, title, canonical_locator never merge, in add_source, append_version and import", async () => {
  await with_env(async (env) => {
    const mk = async (key: string, canonical: string | null) => {
      const obj = await new_object_in(env.service, env.ctx(`${key}-o`), "source");
      const input = { object_id: obj.object_id, ...SRC_FIELDS, title: "같은 제목", url: "https://example.test/same", ...(canonical ? { canonical_locator: canonical } : {}) };
      return (await add_source(env.service, env.ctx(`${key}-v`), input)).result as VersionResult;
    };
    const s1 = await mk("u1", "doi:synthetic/1");
    const s2 = await mk("u2", "doi:synthetic/1");
    const s3 = await mk("u3", null);
    const ids = new Set([s1.object_id, s2.object_id, s3.object_id]);
    assert.equal(ids.size, 3);
    const v = new Set([s1.version_id, s2.version_id, s3.version_id]);
    assert.equal(v.size, 3);
    const displays = env.db.all<{ display_no: bigint }>("SELECT display_no FROM objects WHERE kind = 'source' ORDER BY display_no").map((r) => Number(r.display_no));
    assert.equal(new Set(displays).size, displays.length, "distinct display numbers");

    // a new version of one never touches the other, even with an identical URL
    const s1b = await more_version(env, "u1b", s1.object_id, { ...SRC_VER, url: "https://example.test/same" });
    assert.notEqual(s1b.object_id, s2.object_id);
    assert.equal(count(env.db, "SELECT count(*) AS n FROM object_versions WHERE object_id = ?", s2.object_id), 1);

    // URL spelling variants stay separate too
    for (const [i, url] of ["https://example.test/same/", "HTTPS://EXAMPLE.TEST/same", "https://example.test/same#frag", "https://example.test/same?a=1"].entries()) {
      const r = await new_source(env, `uv${i}`, "같은 제목", { url });
      assert.ok(!ids.has(r.object_id));
    }

    // one artifact citing all three keeps three footnotes with three different source versions
    const art = await new_artifact(env, "u-art");
    for (const [i, s] of [s1, s2, s3].entries()) {
      const r = await add_citation(env.service, env.ctx(`u-c${i}`), { artifact_version_id: art.version_id, source_version_id: s.version_id });
      assert.equal((r.result as { citation_no: number }).citation_no, i + 1);
    }
    const cited = env.db.all<{ source_version_id: string }>("SELECT source_version_id FROM citations WHERE artifact_version_id = ? ORDER BY citation_no", art.version_id);
    assert.deepEqual(cited.map((c) => c.source_version_id), [s1.version_id, s2.version_id, s3.version_id]);
  });
});

test("importing two libraries with the same URLs keeps every source separate across items and across libraries", async () => {
  await with_env(async (env) => {
    const lib2 = structuredClone(LIBRARY) as { items: Array<Record<string, unknown>>; topic: string };
    lib2.topic = "다른 라이브러리";
    const r1 = (await import_library(env.service, env.ctx("ls-1", "import"), { library: LIBRARY })).result as ImportResult;
    const r2 = (await import_library(env.service, env.ctx("ls-2", "import"), { library: lib2 })).result as ImportResult;
    assert.equal(r2.already_imported, false, "a different library is a new import");
    const urls = env.db.all<{ n: bigint }>("SELECT count(*) AS n FROM source_versions WHERE url = 'https://example.test/shared-page'");
    // fixture has 3 sources with that URL; imported twice => 6 separate source objects
    assert.equal(Number(urls[0]?.n), 6);
    const src_objects = count(env.db, "SELECT count(DISTINCT object_id) AS n FROM source_versions WHERE url = 'https://example.test/shared-page'");
    assert.equal(src_objects, 6);
    assert.equal(new Set([...r1.items, ...r2.items].map((i) => i.object_id)).size, r1.items.length + r2.items.length);
  });
});

// ---------------------------------------------------------------------------
// 4. Footnote numbering and order

test("rejected or rolled-back citations never burn a footnote number; numbers stay 1..n without gaps", async () => {
  await with_env(async (env) => {
    const art = await new_artifact(env, "fn-a");
    const ok_src = await new_source(env, "fn-s");
    const dead = await new_source(env, "fn-d", "접속 불가", { verification_state: "unreachable" });
    const other_art = await new_artifact(env, "fn-b");
    const cite = (key: string, source: string, extra: Record<string, unknown> = {}) =>
      add_citation(env.service, env.ctx(key), { artifact_version_id: art.version_id, source_version_id: source, ...extra });
    const no = (o: CommandOutcome) => (o.result as { citation_no: number }).citation_no;

    assert.equal(no(await cite("fn-1", ok_src.version_id)), 1);
    await rejects_api(cite("fn-2", dead.version_id, { quote: "발췌 불가" }), "invalid_payload");
    await rejects_api(cite("fn-3", dead.version_id, { quote: "" }), "invalid_payload");
    await rejects_api(cite("fn-4", other_art.version_id), "conflict");
    await rejects_api(cite("fn-5", "no-such"), "not_found");
    await rejects_api(cite("fn-6", ok_src.version_id, { locator: "text" }), "invalid_payload");
    await rejects_api(cite("fn-7", ok_src.version_id, { quote: 5 }), "invalid_payload");
    assert.equal(no(await cite("fn-8", ok_src.version_id)), 2);

    // a database failure on the INSERT also leaves the number free
    const failing = env.with_db(
      wrap_db(env.db, (sql) => {
        if (/insert\s+into\s+citations/i.test(sql)) throw new Error("injected");
        return undefined;
      }),
    );
    await rejects_any(add_citation(failing, env.ctx("fn-9"), { artifact_version_id: art.version_id, source_version_id: ok_src.version_id }));
    assert.equal(no(await cite("fn-10", dead.version_id)), 3, "no quote on an unreachable source is fine");
    assert.deepEqual(citation_numbers(env.db, art.version_id), [1, 2, 3]);

    // replay of an earlier citation does not take a new number
    const again = await cite("fn-1", ok_src.version_id);
    assert.equal(again.replayed, true);
    assert.deepEqual(citation_numbers(env.db, art.version_id), [1, 2, 3]);
  });
});

test("footnote numbers of an old edition are frozen when a newer edition is cited; the new one starts at 1", async () => {
  await with_env(async (env) => {
    const art = await new_artifact(env, "fo-a");
    const s1 = await new_source(env, "fo-s1");
    const s2 = await new_source(env, "fo-s2", "둘째", { url: "https://example.test/two" });
    await add_citation(env.service, env.ctx("fo-1"), { artifact_version_id: art.version_id, source_version_id: s1.version_id, quote: "가" });
    await add_citation(env.service, env.ctx("fo-2"), { artifact_version_id: art.version_id, source_version_id: s2.version_id });
    const old_rows = js(env.db.all("SELECT * FROM citations WHERE artifact_version_id = ? ORDER BY citation_no", art.version_id));
    const v2 = await more_version(env, "fo-v2", art.object_id);
    // the old edition no longer takes a footnote; the new one numbers from 1 in whatever order is cited
    await rejects_api(add_citation(env.service, env.ctx("fo-3"), { artifact_version_id: art.version_id, source_version_id: s1.version_id }), "conflict");
    assert.equal(((await add_citation(env.service, env.ctx("fo-4"), { artifact_version_id: v2.version_id, source_version_id: s2.version_id })).result as { citation_no: number }).citation_no, 1);
    assert.equal(((await add_citation(env.service, env.ctx("fo-5"), { artifact_version_id: v2.version_id, source_version_id: s1.version_id })).result as { citation_no: number }).citation_no, 2);
    assert.equal(js(env.db.all("SELECT * FROM citations WHERE artifact_version_id = ? ORDER BY citation_no", art.version_id)), old_rows);
    // the source side moving on does not renumber or retarget old footnotes
    const s1b = await more_version(env, "fo-s1b", s1.object_id, SRC_VER);
    const cites = env.db.all<{ source_version_id: string }>("SELECT source_version_id FROM citations WHERE artifact_version_id = ? ORDER BY citation_no", art.version_id);
    assert.deepEqual(cites.map((c) => c.source_version_id), [s1.version_id, s2.version_id]);
    assert.notEqual(s1b.version_id, s1.version_id);
  });
});

test("a long run of citations numbers 1..200 in call order", async () => {
  await with_env(async (env) => {
    const art = await new_artifact(env, "ln-a");
    const s = await new_source(env, "ln-s");
    for (let i = 1; i <= 200; i++) {
      const r = await add_citation(env.service, env.ctx(`ln-${i}`), { artifact_version_id: art.version_id, source_version_id: s.version_id, locator: { n: i } });
      assert.equal((r.result as { citation_no: number }).citation_no, i);
    }
    assert.deepEqual(citation_numbers(env.db, art.version_id), Array.from({ length: 200 }, (_x, i) => i + 1));
    const loc = env.db.get<{ locator: string }>("SELECT locator FROM citations WHERE artifact_version_id = ? AND citation_no = 137", art.version_id);
    assert.deepEqual(JSON.parse(loc?.locator ?? "null"), { n: 137 });
  });
});

// ---------------------------------------------------------------------------
// 5. Unreachable source and excerpts

test("an unreachable verdict cannot be bypassed by a later version, an old base, an empty excerpt, or a citation", async () => {
  await with_env(async (env) => {
    const art = await new_artifact(env, "ur-art");
    const src = await new_source(env, "ur-s", "읽은 자료", { verification_state: "verified", quote: "원래 발췌" });
    // the latest check failed
    const dead = await more_version(env, "ur-dead", src.object_id, { ...SRC_VER, verification_state: "unreachable" });
    const read = (id: string) => env.db.get<{ quote: string | null; verification_state: string }>("SELECT quote, verification_state FROM source_versions WHERE version_id = ?", id);
    assert.equal(read(dead.version_id)?.quote, null, "the failing version did not inherit the old excerpt");

    // even based on the readable version, a new unreachable version carries no excerpt
    const dead2 = await more_version(env, "ur-dead2", src.object_id, { ...SRC_VER, verification_state: "unreachable", based_on_version_id: src.version_id });
    assert.equal(read(dead2.version_id)?.quote, null);

    const before = env.db.all("SELECT * FROM source_versions ORDER BY rowid").length;
    for (const [i, quote] of ["새 발췌", "", " ", "\n", "0"].entries()) {
      await rejects_api(more_version(env, `ur-q${i}`, src.object_id, { ...SRC_VER, verification_state: "unreachable", quote }), "invalid_payload");
      await rejects_api(add_citation(env.service, env.ctx(`ur-c${i}`), { artifact_version_id: art.version_id, source_version_id: dead2.version_id, quote }), "invalid_payload");
    }
    // spelling variants of the state are not accepted as some other, excerpt-friendly state
    for (const [i, state] of ["Unreachable", "unreachable ", "UNREACHABLE", "unreachable\u0000"].entries()) {
      await rejects_api(more_version(env, `ur-s${i}`, src.object_id, { ...SRC_VER, verification_state: state, quote: "x" }), "invalid_payload");
    }
    assert.equal(env.db.all("SELECT * FROM source_versions").length, before);

    // the block does not leak the other way: an older readable version is still citable with an excerpt,
    // and an unreachable version can be cited without one
    const ok_old = await add_citation(env.service, env.ctx("ur-ok1"), { artifact_version_id: art.version_id, source_version_id: src.version_id, quote: "원래 발췌" });
    assert.equal((ok_old.result as { citation_no: number }).citation_no, 1);
    const ok_dead = await add_citation(env.service, env.ctx("ur-ok2"), { artifact_version_id: art.version_id, source_version_id: dead2.version_id });
    assert.equal((ok_dead.result as { citation_no: number }).citation_no, 2);
    const stored = env.db.get<{ quote: string | null }>("SELECT quote FROM citations WHERE artifact_version_id = ? AND citation_no = 2", art.version_id);
    assert.equal(stored?.quote, null);
  });
});

test("the database refuses an unreachable source version with an excerpt even if a command did not (check constraint)", async () => {
  await with_env(async (env) => {
    const s = await new_source(env, "ck-s", "t", { verification_state: "unreachable" });
    assert.throws(() => env.db.run("UPDATE source_versions SET quote = 'x' WHERE version_id = ?", s.version_id));
    const v = env.db.get<{ quote: string | null }>("SELECT quote FROM source_versions WHERE version_id = ?", s.version_id);
    assert.equal(v?.quote, null);
  });
});

test("import_library ignores verification facts inside library sources: they all come out legacy_unknown with no excerpt or time", async () => {
  await with_env(async (env) => {
    const lib = {
      items: [
        {
          id: "V1",
          title: "합성",
          sources: [
            { title: "s", url: "https://example.test/v", method: "fetch", verification_state: "verified", quote: "주장된 발췌", retrieved_at: 123456, verified_by_actor_id: env.p.actor_id, evidence_blob_id: "b" },
            { title: "u", url: "https://example.test/u", verification_state: "unreachable", quote: "발췌" },
          ],
        },
      ],
    };
    await import_library(env.service, env.ctx("vf-1", "import"), { library: lib });
    const rows = env.db.all<{ verification_state: string; quote: string | null; retrieved_at: bigint | null; verified_by_actor_id: string | null; evidence_blob_id: string | null }>(
      "SELECT verification_state, quote, retrieved_at, verified_by_actor_id, evidence_blob_id FROM source_versions",
    );
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.verification_state, "legacy_unknown");
      assert.equal(r.quote, null);
      assert.equal(r.retrieved_at, null);
      assert.equal(r.verified_by_actor_id, null);
      assert.equal(r.evidence_blob_id, null);
    }
    const cites = env.db.all<{ quote: string | null }>("SELECT quote FROM citations");
    assert.ok(cites.every((c) => c.quote === null));
  });
});

// ---------------------------------------------------------------------------
// 6. import_library odd inputs

function parse(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

test("item keys that collide with the importer's own bookkeeping cannot overwrite the legacy id or the original kind", async () => {
  await with_env(async (env) => {
    const lib = parse(
      JSON.stringify({
        items: [
          { id: "K1", title: "충돌", kind: "mystery", legacy_id: "FORGED", kind_original: "FORGED-KIND" },
          { id: "K2", title: "충돌 둘", legacy_extra: { x: 1 }, metadata: { y: 2 } },
        ],
      }),
    );
    const r = (await import_library(env.service, env.ctx("kc-1", "import"), { library: lib })).result as ImportResult;
    const meta = (version_id: string) =>
      JSON.parse(env.db.get<{ metadata_json: string }>("SELECT metadata_json FROM artifact_versions WHERE version_id = ?", version_id)?.metadata_json ?? "{}") as {
        legacy_extra: Record<string, unknown>;
      };
    const m1 = meta(r.items[0]!.version_id);
    assert.equal(m1.legacy_extra.legacy_id, "K1", "legacy id is the item's real id, not an item key named legacy_id");
    assert.equal(m1.legacy_extra.kind_original, "mystery", "original kind is the item's real kind");
    const m2 = meta(r.items[1]!.version_id);
    assert.equal(m2.legacy_extra.legacy_id, "K2");
    assert.deepEqual(m2.legacy_extra.legacy_extra, { x: 1 }, "an item key named legacy_extra is kept as data, not merged");
    assert.deepEqual(m2.legacy_extra.metadata, { y: 2 });
  });
});

test("an own '__proto__' / 'constructor' key in an item or the library survives import (rows and original)", async () => {
  await with_env(async (env) => {
    const text =
      '{"items":[{"id":"__proto__","title":"proto id","__proto__":{"polluted":true},"constructor":{"a":1},"sources":[{"title":"s","__proto__":{"q":1}}]},{"id":"constructor","title":"ctor id"}],"__proto__":{"top":1}}';
    const lib = parse(text);
    const r = (await import_library(env.service, env.ctx("pr-1", "import"), { library: lib })).result as ImportResult;
    assert.deepEqual(r.items.map((i) => i.legacy_id), ["__proto__", "constructor"]);
    assert.equal(({} as Record<string, unknown>).polluted, undefined, "Object.prototype was not polluted");
    const m = JSON.parse(env.db.get<{ metadata_json: string }>("SELECT metadata_json FROM artifact_versions WHERE version_id = ?", r.items[0]!.version_id)?.metadata_json ?? "{}") as {
      legacy_extra: Record<string, unknown>;
    };
    assert.equal(m.legacy_extra.legacy_id, "__proto__");
    assert.equal(Object.hasOwn(m.legacy_extra, "__proto__") ? JSON.stringify(m.legacy_extra["__proto__"]) : "lost", '{"polluted":true}', "the data under the __proto__ key is kept");
    assert.deepEqual(m.legacy_extra.constructor, { a: 1 });
    const rc = env.db.get<{ id: string }>("SELECT id FROM mutation_commits WHERE client_request_id = 'pr-1'");
    const ev = env.db.get<{ payload: string }>("SELECT payload FROM events WHERE tx_id = ? AND type = 'content.library_imported'", rc?.id ?? "");
    const original = (JSON.parse(ev?.payload ?? "{}") as { original: Record<string, unknown> }).original;
    assert.equal(JSON.stringify(original), JSON.stringify(lib), "the original keeps the own __proto__ keys, byte for byte");
  });
});

test("import_library: the original equals the input exactly (odd values, unicode, big text), and the input object is not modified", async () => {
  await with_env(async (env) => {
    const lib = parse(
      JSON.stringify({
        source: "합성 😀   줄",
        imported: null,
        round: 0,
        topic: "",
        settings: { n: 1e21, m: -0.5, big: 9007199254740991, nested: { a: [[], {}, [1, [2, [3]]]] }, empty: "" },
        items: [
          { id: "O1", title: "t".repeat(50_000), details: "\n".repeat(1000) + "끝", stats: [], conflicts: [], extra_null: null, extra_bool: false, extra_zero: 0, sources: [] },
          { id: "O2", title: "둘", verify: { claims: [{ claim: "c", verdict: "weird" }] }, sources: [{ title: "s", url: null, method: null, date: 20251231 }] },
        ],
        suggestions: [{ s: 1 }],
        warnings: ["w"],
      }),
    );
    const snapshot = JSON.stringify(lib);
    await import_library(env.service, env.ctx("or-1", "import"), { library: lib });
    assert.equal(JSON.stringify(lib), snapshot, "the caller's object is untouched");
    const rc = env.db.get<{ id: string }>("SELECT id FROM mutation_commits WHERE client_request_id = 'or-1'");
    const ev = env.db.get<{ payload: string }>("SELECT payload FROM events WHERE tx_id = ? AND type = 'content.library_imported'", rc?.id ?? "");
    assert.equal(JSON.stringify((JSON.parse(ev?.payload ?? "{}") as { original: unknown }).original), snapshot);
    // unmapped keys with falsy values are kept in the row
    const row = env.db.get<{ metadata_json: string; title: string }>(
      "SELECT av.metadata_json, av.title FROM artifact_versions av JOIN object_versions ov ON ov.id = av.version_id WHERE av.title LIKE 'tttt%'",
    );
    assert.equal(row?.title.length, 50_000);
    const extra = (JSON.parse(row?.metadata_json ?? "{}") as { legacy_extra: Record<string, unknown> }).legacy_extra;
    assert.equal(extra.extra_null, null);
    assert.equal(extra.extra_bool, false);
    assert.equal(extra.extra_zero, 0);
  });
});

test("import_library: a source with no usable fields still becomes a source and a footnote, in array order", async () => {
  await with_env(async (env) => {
    const lib = {
      items: [
        {
          id: "E1",
          title: "빈 출처들",
          sources: [{}, { title: "" }, { title: 5, url: 7, method: "FETCH", kind: "stat" }, { title: "정상", url: "", method: "kosis", canonical_locator: "x" }, { title: "마지막" }],
        },
      ],
    };
    const r = (await import_library(env.service, env.ctx("es-1", "import"), { library: lib })).result as ImportResult;
    const cites = env.db.all<{ citation_no: bigint; title: string; method: string; kind: string; url: string | null }>(
      `SELECT c.citation_no, sv.title, sv.method, s.kind, sv.url FROM citations c
       JOIN source_versions sv ON sv.version_id = c.source_version_id JOIN sources s ON s.object_id = sv.object_id
       WHERE c.artifact_version_id = ? ORDER BY c.citation_no`,
      r.items[0]!.version_id,
    );
    assert.deepEqual(cites.map((c) => Number(c.citation_no)), [1, 2, 3, 4, 5]);
    assert.deepEqual(cites.map((c) => c.method), ["unknown", "unknown", "unknown", "kosis", "unknown"], "an unlisted method (even a case variant) becomes 'unknown'");
    assert.equal(cites[2]!.kind, "stat");
    assert.equal(cites[0]!.kind, "web", "default kind");
    assert.equal(cites[2]!.url, null, "a non-string url is not stored as one");
    assert.equal(new Set(cites.map((c) => c.title)).size >= 3, true);
  });
});

test("import_library rejects bad shapes anywhere in the library with nothing written, even after good items", async () => {
  await with_env(async (env) => {
    const good = (n: number) => Array.from({ length: n }, (_x, i) => ({ id: `G${i}`, title: `좋음 ${i}`, sources: [{ title: "s" }] }));
    const before = state_signature(env.db);
    const bad_libs: unknown[] = [
      { items: [...good(30), { id: "G5", title: "중복" }] },
      { items: [...good(30), { id: "" }] },
      { items: [...good(30), { id: "   " }] },
      { items: [...good(30), { id: 7 }] },
      { items: [...good(30), { id: null }] },
      { items: [...good(30), { id: "\ud800" }] },
      { items: [...good(30), null] },
      { items: [...good(30), [] ] },
      { items: [...good(30), "x"] },
      { items: [...good(30), { id: "B1", sources: [{ title: "ok" }, null] }] },
      { items: [...good(30), { id: "B2", sources: [{ title: "ok" }, "text"] }] },
      { items: [...good(30), { id: "B3", sources: {} }] },
      { items: [...good(30), { id: "B4", sources: 3 }] },
      { items: null },
      { items: {} },
      { items: "x" },
      {},
    ];
    let n = 0;
    for (const library of bad_libs) {
      n += 1;
      await rejects_api(import_library(env.service, env.ctx(`bl-${n}`, "import"), { library }), "invalid_payload");
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("import_library with values JSON cannot carry (circular, bigint) is rejected cleanly without writing", async () => {
  await with_env(async (env) => {
    const before = state_signature(env.db);
    const circular: Record<string, unknown> = { id: "C1", title: "순환" };
    circular.self = circular;
    const cases: unknown[] = [{ items: [circular] }, { items: [{ id: "B1", title: "t", n: 10n }] }];
    let n = 0;
    for (const library of cases) {
      n += 1;
      await rejects_api(import_library(env.service, env.ctx(`us-${n}`, "import"), { library }), "invalid_payload");
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("a lone surrogate in any library text is rejected or stored back unchanged; never silently altered", async () => {
  await with_env(async (env) => {
    const bad = "앞\ud83d뒤";
    const lib = { items: [{ id: "SG1", title: bad, summary: bad, details: bad, sources: [{ title: bad, url: `https://example.test/${bad}` }] }] };
    let result: ImportResult | null = null;
    try {
      result = (await import_library(env.service, env.ctx("sg-1", "import"), { library: lib })).result as ImportResult;
    } catch (error) {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "invalid_payload");
    }
    if (result) {
      const row = env.db.get<{ title: string; summary: string; body_md: string }>("SELECT title, summary, body_md FROM artifact_versions");
      assert.equal(row?.title, bad);
      assert.equal(row?.summary, bad);
      assert.equal(row?.body_md, bad);
    } else {
      assert.equal(count(env.db, "SELECT count(*) AS n FROM objects WHERE kind = 'artifact'"), 0);
    }
  });
});

test("import_library with a large library (300 items x 5 sources, 2 MB text) is complete, ordered and numbered without gaps", async () => {
  await with_env(async (env) => {
    const items = Array.from({ length: 300 }, (_x, i) => ({
      id: `BIG-${i}`,
      title: `큰 항목 ${i}`,
      kind: i % 3 === 0 ? "claim" : i % 3 === 1 ? "topic" : "unheard-of",
      status: i % 50 === 0 ? "removed" : "done",
      details: i === 7 ? "가".repeat(2_000_000) : "짧음",
      sources: Array.from({ length: 5 }, (_y, j) => ({ title: `출처 ${i}-${j}`, url: "https://example.test/same", method: j % 2 ? "fetch" : "search" })),
    }));
    const lib = { source: "big", items };
    const out = await import_library(env.service, env.ctx("big-1", "import"), { library: lib });
    const r = out.result as ImportResult;
    assert.equal(r.items.length, 300);
    assert.deepEqual(r.items.map((x) => x.legacy_id), items.map((x) => x.id), "result keeps the library's order");
    assert.equal(count(env.db, "SELECT count(*) AS n FROM objects WHERE kind = 'source'"), 1500);
    assert.equal(count(env.db, "SELECT count(*) AS n FROM citations"), 1500);
    assert.equal(count(env.db, "SELECT count(*) AS n FROM objects WHERE kind = 'artifact' AND archived_at IS NOT NULL"), 6);
    const nos = env.db.all<{ display_no: bigint }>("SELECT display_no FROM objects WHERE kind = 'artifact' ORDER BY display_no").map((x) => Number(x.display_no));
    assert.deepEqual(nos, Array.from({ length: 300 }, (_x, i) => i + 1));
    const snos = env.db.all<{ display_no: bigint }>("SELECT display_no FROM objects WHERE kind = 'source' ORDER BY display_no").map((x) => Number(x.display_no));
    assert.deepEqual(snos, Array.from({ length: 1500 }, (_x, i) => i + 1));
    for (const x of [r.items[0]!, r.items[299]!]) {
      assert.deepEqual(citation_numbers(env.db, x.version_id), [1, 2, 3, 4, 5]);
    }
    const body = env.db.get<{ body_md: string }>("SELECT body_md FROM artifact_versions WHERE version_id = ?", r.items[7]!.version_id);
    assert.equal(body?.body_md.length, 2_000_000);
    // the counters carry on from the import
    const next = await create_object(env.service, env.ctx("big-2"), { kind: "artifact" });
    assert.equal((next.result as ObjectResult).display_no, 301);
    // and the whole import can still be repeated safely
    const again = (await import_library(env.service, env.ctx("big-3", "import"), { library: structuredClone(lib) })).result as ImportResult;
    assert.equal(again.already_imported, true);
    assert.deepEqual(again.items, r.items);
    assert.equal(count(env.db, "SELECT count(*) AS n FROM objects"), 1800 + 1);
  });
});

test("re-importing the same library with keys in another order, or in another project, behaves as the same / a separate library", async () => {
  await with_env(async (env) => {
    const first = (await import_library(env.service, env.ctx("ro-1", "import"), { library: LIBRARY })).result as ImportResult;
    const shuffled = Object.fromEntries(Object.entries(LIBRARY).reverse());
    const items = (shuffled.items as Array<Record<string, unknown>>).map((it) => Object.fromEntries(Object.entries(it).reverse()));
    const again = (await import_library(env.service, env.ctx("ro-2", "import"), { library: { ...shuffled, items } })).result as ImportResult;
    assert.equal(again.already_imported, true, "key order is not content");
    assert.deepEqual(again.items, first.items);

    const p2 = await bootstrap(env.service, "ro-p2", "synthetic-other");
    const other = (await import_library(env.service, ctx_for(p2, "ro-3", "import"), { library: LIBRARY })).result as ImportResult;
    assert.equal(other.already_imported, false, "another project has not imported it");
    assert.equal(other.project_id, p2.project_id);
    const ids1 = new Set(first.items.map((i) => i.object_id));
    assert.ok(other.items.every((i) => !ids1.has(i.object_id)));
    assert.equal(count(env.db, "SELECT count(*) AS n FROM objects WHERE project_id = ?", env.p.project_id), 6, "project 1 got no extra rows from project 2's import");
  });
});

test("importing a library that holds the items of an earlier import (plus new ones) does not duplicate the items already imported", async () => {
  await with_env(async (env) => {
    const base = LIBRARY as { items: Array<Record<string, unknown>> };
    const first_lib = { ...LIBRARY, items: base.items.slice(0, 2) };
    const first = (await import_library(env.service, env.ctx("pa-1", "import"), { library: first_lib })).result as ImportResult;
    const second = (await import_library(env.service, env.ctx("pa-2", "import"), { library: LIBRARY })).result as ImportResult;
    const by_legacy = (id: string) => count(env.db, "SELECT count(*) AS n FROM artifact_versions WHERE json_extract(metadata_json, '$.legacy_extra.legacy_id') = ?", id);
    assert.equal(by_legacy("L1"), 1, "L1 exists once");
    assert.equal(by_legacy("L2"), 1, "L2 exists once");
    assert.equal(by_legacy("L3"), 1);
    const reused = second.items.filter((i) => first.items.some((f) => f.legacy_id === i.legacy_id));
    assert.deepEqual(
      reused.map((i) => i.object_id),
      first.items.map((i) => i.object_id),
      "the items already imported keep their first-run ids",
    );
  });
});

test("an import that failed halfway leaves nothing, and the retry with a new key imports the whole library once", async () => {
  await with_env(async (env) => {
    const before = state_signature(env.db);
    let hits = 0;
    const failing = env.with_db(
      wrap_db(env.db, (sql) => {
        if (/insert\s+into\s+artifact_versions/i.test(sql) && ++hits === 2) throw new Error("injected");
        return undefined;
      }),
    );
    await rejects_any(import_library(failing, env.ctx("hf-1", "import"), { library: LIBRARY }));
    assert.equal(state_signature(env.db), before);
    const ok = (await import_library(env.service, env.ctx("hf-2", "import"), { library: LIBRARY })).result as ImportResult;
    assert.equal(ok.already_imported, false);
    assert.equal(ok.items.length, 3);
    assert.equal(count(env.db, "SELECT count(*) AS n FROM events WHERE type = 'content.library_imported'"), 1);
  });
});

test("imported removed items are archived, only for the exact status 'removed'; odd statuses are kept as data", async () => {
  await with_env(async (env) => {
    const lib = {
      items: [
        { id: "S1", title: "a", status: "removed" },
        { id: "S2", title: "b", status: "Removed" },
        { id: "S3", title: "c", status: " removed" },
        { id: "S4", title: "d", status: 5 },
        { id: "S5", title: "e", status: "done" },
        { id: "S6", title: "f", status: null },
      ],
    };
    const r = (await import_library(env.service, env.ctx("st-1", "import"), { library: lib })).result as ImportResult;
    const archived = r.items.map((i) => object_row(env.db, i.object_id).archived_at !== null);
    assert.deepEqual(archived, [true, false, false, false, false, false]);
    const statuses = r.items.map((i) => env.db.get<{ status: string }>("SELECT status FROM artifact_versions WHERE version_id = ?", i.version_id)?.status);
    assert.equal(statuses[0], "removed");
    assert.equal(statuses[4], "done");
    for (const i of [1, 2, 3]) assert.notEqual(statuses[i], "removed");
    const extra = (i: number) => (JSON.parse(env.db.get<{ metadata_json: string }>("SELECT metadata_json FROM artifact_versions WHERE version_id = ?", r.items[i]!.version_id)?.metadata_json ?? "{}") as { legacy_extra: Record<string, unknown> }).legacy_extra;
    assert.equal(extra(1).status, "Removed", "the unrecognised status is not lost");
    assert.equal(extra(3).status, 5);
    for (const i of r.items) assert.equal(object_row(env.db, i.object_id).current_version_id, i.version_id);
  });
});

test("an imported item can then take new versions, citations and relations like any other item", async () => {
  await with_env(async (env) => {
    const r = (await import_library(env.service, env.ctx("im-1", "import"), { library: LIBRARY })).result as ImportResult;
    const item = r.items[0]!;
    const src = await new_source(env, "im-s", "새 출처", { url: "https://example.test/new" });
    const v1_cites = citation_numbers(env.db, item.version_id);
    const v2 = await more_version(env, "im-2", item.object_id);
    assert.equal(v2.version_no, 2);
    // the imported edition is now sealed
    await rejects_api(add_citation(env.service, env.ctx("im-3"), { artifact_version_id: item.version_id, source_version_id: src.version_id }), "conflict");
    assert.deepEqual(citation_numbers(env.db, item.version_id), v1_cites);
    await add_citation(env.service, env.ctx("im-4"), { artifact_version_id: v2.version_id, source_version_id: src.version_id });
    // imported sources take new versions without touching version 1
    const imported_source = env.db.get<{ object_id: string; version_id: string }>(
      "SELECT sv.object_id, sv.version_id FROM citations c JOIN source_versions sv ON sv.version_id = c.source_version_id WHERE c.artifact_version_id = ? AND c.citation_no = 1",
      item.version_id,
    );
    const before = js(env.db.all("SELECT * FROM source_versions WHERE version_id = ?", imported_source?.version_id ?? ""));
    await more_version(env, "im-5", imported_source?.object_id ?? "", { ...SRC_VER, verification_state: "verified", retrieved_at: 1_760_000_000_000 });
    assert.equal(js(env.db.all("SELECT * FROM source_versions WHERE version_id = ?", imported_source?.version_id ?? "")), before);
    assert.equal(
      env.db.get<{ verification_state: string }>("SELECT verification_state FROM source_versions WHERE version_id = ?", imported_source?.version_id ?? "")?.verification_state,
      "legacy_unknown",
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Mixing ids of another project

test("every content command refuses ids of another project, and neither project changes", async () => {
  await with_env(async (env) => {
    const p2 = await bootstrap(env.service, "mx-p2", "synthetic-other");
    // project 1 holds the ids that project 2 will try to use
    const a = await new_artifact(env, "mx-a");
    const s = await new_source(env, "mx-s");
    const bare_a = await new_object_in(env.service, env.ctx("mx-ba"), "artifact", env.p.edition_id);
    const bare_s = await new_object_in(env.service, env.ctx("mx-bs"), "source");
    const stage = env.db.get<{ id: string }>("SELECT id FROM stages WHERE project_id = ? LIMIT 1", env.p.project_id);
    // project 2's own objects
    const fa = await new_artifact_in(env.service, p2, "mx-fa");
    const fs = await new_source_in(env.service, p2, "mx-fs");
    const fa_bare = await new_object_in(env.service, ctx_for(p2, "mx-fba"), "artifact");
    const fs_bare = await new_object_in(env.service, ctx_for(p2, "mx-fbs"), "source");
    const before = state_signature(env.db);
    const c2 = (key: string) => ctx_for(p2, key);
    const not_found = "not_found";
    const nf = async (fn: () => unknown) => {
      try {
        await fn();
      } catch (e) {
        assert.ok(e instanceof ApiError && e.code === "not_found", `expected not_found, got ${String(e)} for ${fn.toString().slice(0, 140)}`);
        return;
      }
      assert.fail(`accepted: ${fn.toString().slice(0, 160)}`);
    };

    await nf(() => create_object(env.service, c2("m1"), { kind: "artifact", edition_id: env.p.edition_id }));
    if (stage) {
      await nf(() => add_artifact(env.service, c2("m2"), { object_id: fa_bare.object_id, ...ART_FIELDS, title: "t", stage_id: stage.id }));
    }
    await nf(() => add_artifact(env.service, c2("m3"), { object_id: bare_a.object_id, ...ART_FIELDS, title: "t" }));
    await nf(() => add_source(env.service, c2("m4"), { object_id: bare_s.object_id, ...SRC_FIELDS, title: "t" }));
    await nf(() => append_version(env.service, c2("m6"), { object_id: a.object_id, title: "t" }));
    await nf(() => append_version(env.service, c2("m7"), { object_id: fa.object_id, title: "t", based_on_version_id: a.version_id }));
    await nf(() => append_version(env.service, c2("m8"), { object_id: fs.object_id, title: "t", ...SRC_VER, based_on_version_id: s.version_id }));
    await nf(() => set_current(env.service, c2("m9"), { object_id: a.object_id, version_id: a.version_id }));
    await nf(() => add_citation(env.service, c2("m10"), { artifact_version_id: a.version_id, source_version_id: fs.version_id }));
    await nf(() => add_citation(env.service, c2("m11"), { artifact_version_id: fa.version_id, source_version_id: s.version_id }));
    await nf(() => link_relation(env.service, c2("m12"), { from_version_id: fa.version_id, to_version_id: a.version_id, kind: "reuses" }));
    await nf(() => link_relation(env.service, c2("m13"), { from_version_id: a.version_id, to_version_id: fa.version_id, kind: "reuses" }));
    // the same ids used from the right project but pointing at the other side
    await nf(() => add_citation(env.service, env.ctx("m14"), { artifact_version_id: a.version_id, source_version_id: fs.version_id }));
    await nf(() => link_relation(env.service, env.ctx("m15"), { from_version_id: a.version_id, to_version_id: fa.version_id, kind: "related" }));
    await nf(() => append_version(env.service, env.ctx("m16"), { object_id: a.object_id, title: "t", based_on_version_id: fa.version_id }));

    assert.equal(state_signature(env.db), before, "no row anywhere moved");
    assert.equal(count(env.db, "SELECT count(*) AS n FROM citations"), 0);
    assert.equal(count(env.db, "SELECT count(*) AS n FROM version_relations"), 0);
  });
});

test("a verifier from another project cannot be named on a source version", async () => {
  await with_env(async (env) => {
    const p2 = await bootstrap(env.service, "va-p2", "synthetic-other");
    const bare = await new_object_in(env.service, env.ctx("va-o"), "source");
    const before = state_signature(env.db);
    await rejects_any(add_source(env.service, env.ctx("va-1"), { object_id: bare.object_id, ...SRC_FIELDS, title: "t", verified_by_actor_id: p2.actor_id }));
    assert.equal(state_signature(env.db), before, "no source row was written for the foreign verifier");
    // an actor of this project is fine
    const ok = await add_source(env.service, env.ctx("va-2"), { object_id: bare.object_id, ...SRC_FIELDS, title: "t", verified_by_actor_id: env.p.actor_id });
    assert.equal((ok.result as VersionResult).version_no, 1);
  });
});

test("display numbers and counters of one project are not moved by another project's content work", async () => {
  await with_env(async (env) => {
    const p2 = await bootstrap(env.service, "dn-p2", "synthetic-other");
    await new_artifact(env, "dn-a");
    await new_artifact(env, "dn-b");
    const c = (p: Project) => js(env.db.all("SELECT namespace, next_no FROM counters WHERE project_id = ? ORDER BY namespace", p.project_id));
    const c2_before = c(p2);
    await new_artifact(env, "dn-c");
    await new_source(env, "dn-s");
    await import_library(env.service, env.ctx("dn-i", "import"), { library: LIBRARY });
    assert.equal(c(p2), c2_before);
    const f = await new_artifact_in(env.service, p2, "dn-f");
    assert.equal(env.db.get<{ display_no: bigint }>("SELECT display_no FROM objects WHERE id = ?", f.object_id)?.display_no, 1n, "project 2 numbers from 1");
  });
});

// ---------------------------------------------------------------------------
// 8. Rollback at every write, replay, policy order, for every content command

interface Setup {
  art_obj: string;
  art_v1: string;
  art_v2: string;
  src_obj: string;
  src_v1: string;
  bare_art: string;
  bare_src: string;
  other_v1: string;
}

async function prepare(env: Env): Promise<Setup> {
  const a1 = await new_artifact(env, "pre-a");
  const a2 = await more_version(env, "pre-a2", a1.object_id);
  const s1 = await new_source(env, "pre-s");
  const other = await new_artifact(env, "pre-o");
  const bare_a = await new_object_in(env.service, env.ctx("pre-ba"), "artifact");
  const bare_s = await new_object_in(env.service, env.ctx("pre-bs"), "source");
  return { art_obj: a1.object_id, art_v1: a1.version_id, art_v2: a2.version_id, src_obj: s1.object_id, src_v1: s1.version_id, bare_art: bare_a.object_id, bare_src: bare_s.object_id, other_v1: other.version_id };
}

type Call = (env: Env, i: Setup, key: string, service?: CommandService) => Promise<CommandOutcome>;

const CALLS: Array<{ name: string; call: Call }> = [
  { name: "content.create_object", call: (e, _i, k, s = e.service) => create_object(s, e.ctx(k), { kind: "source" }) },
  { name: "content.add_artifact", call: (e, i, k, s = e.service) => add_artifact(s, e.ctx(k), { object_id: i.bare_art, ...ART_FIELDS, title: "새 항목", stats: [{ a: 1 }], metadata: { m: 1 } }) },
  { name: "content.add_source", call: (e, i, k, s = e.service) => add_source(s, e.ctx(k), { object_id: i.bare_src, ...SRC_FIELDS, title: "새 출처", url: "https://example.test/n", verified_by_actor_id: e.p.actor_id, quote: "q", locator: { page: 1 } }) },
  { name: "content.append_version (artifact)", call: (e, i, k, s = e.service) => append_version(s, e.ctx(k), { object_id: i.art_obj, title: "3판" }) },
  { name: "content.append_version (source)", call: (e, i, k, s = e.service) => append_version(s, e.ctx(k), { object_id: i.src_obj, title: "2판", ...SRC_VER }) },
  { name: "content.set_current", call: (e, i, k, s = e.service) => set_current(s, e.ctx(k), { object_id: i.art_obj, version_id: i.art_v2 }) },
  { name: "content.add_citation", call: (e, i, k, s = e.service) => add_citation(s, e.ctx(k), { artifact_version_id: i.art_v2, source_version_id: i.src_v1, quote: "발췌" }) },
  { name: "content.link_relation", call: (e, i, k, s = e.service) => link_relation(s, e.ctx(k), { from_version_id: i.art_v2, to_version_id: i.other_v1, kind: "derived_from" }) },
  { name: "content.import_library", call: (e, _i, k, s = e.service) => import_library(s, e.ctx(k, "import"), { library: LIBRARY }) },
];

for (const c of CALLS) {
  test(`${c.name}: a failure at ANY single write statement rolls everything back and the key stays usable`, async () => {
    // count the writes of a normal run first
    let writes = 0;
    await with_env(async (env) => {
      const ids = await prepare(env);
      const counting = env.with_db(
        wrap_db(env.db, () => {
          writes += 1;
          return undefined;
        }),
      );
      await c.call(env, ids, "w-count", counting);
    });
    assert.ok(writes >= 2, `${c.name} runs at least a receipt and one write (${writes})`);

    await with_env(async (env) => {
      const ids = await prepare(env);
      const before = state_signature(env.db);
      for (let n = 1; n <= writes; n++) {
        let seen = 0;
        const failing = env.with_db(
          wrap_db(env.db, () => {
            seen += 1;
            if (seen === n) throw new Error(`injected failure at write ${n}`);
            return undefined;
          }),
        );
        await rejects_any(c.call(env, ids, "w-fail", failing));
        assert.equal(state_signature(env.db), before, `write ${n}/${writes}: state is exactly as before`);
      }
      const done = await c.call(env, ids, "w-fail");
      assert.equal(done.replayed, false, "the key was never consumed by the failed attempts");
      assert.notEqual(state_signature(env.db), before);
    });
  });

  test(`${c.name}: policy OFF wins over bad payloads, unknown ids and missing fields; nothing is written or consumed`, async () => {
    await with_env(async (env) => {
      const ids = await prepare(env);
      const before = state_signature(env.db);
      env.policy.allowed = false;
      env.policy.calls = 0;
      const short = c.name.replace(/ \(.*\)$/, "");
      await rejects_api(env.service.execute(env.ctx("po-1"), short, { totally: "wrong" }), "policy_denied");
      await rejects_api(env.service.execute(env.ctx("po-2"), short, null), "policy_denied");
      await rejects_api(env.service.execute(env.ctx("po-3"), short, { object_id: "nope", version_id: "nope" }), "policy_denied");
      assert.equal(env.policy.calls, 3);
      await rejects_api(c.call(env, ids, "po-4"), "policy_denied");
      assert.equal(state_signature(env.db), before);
      env.policy.allowed = true;
      const ok = await c.call(env, ids, "po-4");
      assert.equal(ok.replayed, false, "a denied key is not consumed");
    });
  });
}

test("replays return the first result and write nothing even after the data moved on", async () => {
  await with_env(async (env) => {
    const art = await new_artifact(env, "rp-a");
    const src = await new_source(env, "rp-s");
    const first_v = await append_version(env.service, env.ctx("rp-1"), { object_id: art.object_id, title: "둘째" });
    const cit = await add_citation(env.service, env.ctx("rp-2"), { artifact_version_id: (first_v.result as VersionResult).version_id, source_version_id: src.version_id });
    const sc = await set_current(env.service, env.ctx("rp-3"), { object_id: art.object_id, version_id: art.version_id });
    // time moves on: more versions, the pointer moves again
    await more_version(env, "rp-4", art.object_id);
    await set_current(env.service, env.ctx("rp-5"), { object_id: art.object_id, version_id: (first_v.result as VersionResult).version_id });
    const sig = state_signature(env.db);

    const r1 = await append_version(env.service, env.ctx("rp-1"), { object_id: art.object_id, title: "둘째" });
    const r2 = await add_citation(env.service, env.ctx("rp-2"), { artifact_version_id: (first_v.result as VersionResult).version_id, source_version_id: src.version_id });
    const r3 = await set_current(env.service, env.ctx("rp-3"), { object_id: art.object_id, version_id: art.version_id });
    assert.deepEqual([r1.replayed, r2.replayed, r3.replayed], [true, true, true]);
    assert.deepEqual(r1.result, first_v.result);
    assert.deepEqual(r2.result, cit.result);
    assert.deepEqual(r3.result, sc.result);
    assert.equal(state_signature(env.db), sig);
    assert.equal(object_row(env.db, art.object_id).current_version_id, (first_v.result as VersionResult).version_id, "a replayed set_current did not drag the pointer back");

    // another payload under a used key is refused, not executed
    await rejects_api(append_version(env.service, env.ctx("rp-1"), { object_id: art.object_id, title: "다른 제목" }), "idempotency_key_reuse");
    await rejects_api(set_current(env.service, env.ctx("rp-3"), { object_id: art.object_id, version_id: (first_v.result as VersionResult).version_id }), "idempotency_key_reuse");
    assert.equal(state_signature(env.db), sig);
  });
});

test("the same client_request_id in two projects does not collide or replay across them", async () => {
  await with_env(async (env) => {
    const p2 = await bootstrap(env.service, "kp-p2", "synthetic-other");
    const a = await create_object(env.service, env.ctx("same-key"), { kind: "artifact" });
    const b = await create_object(env.service, ctx_for(p2, "same-key"), { kind: "artifact" });
    assert.equal(a.replayed, false);
    assert.equal(b.replayed, false);
    assert.notEqual((a.result as ObjectResult).object_id, (b.result as ObjectResult).object_id);
    assert.equal((b.result as { project_id: string }).project_id, p2.project_id);
  });
});

test("a rejected command in the middle of a sequence leaves the later commands' numbering intact", async () => {
  await with_env(async (env) => {
    const o1 = await new_object_in(env.service, env.ctx("sq-1"), "artifact");
    await rejects_api(create_object(env.service, env.ctx("sq-2"), { kind: "chapter" }), "invalid_payload");
    await rejects_api(create_object(env.service, env.ctx("sq-3"), { kind: "artifact", edition_id: "nope" }), "not_found");
    await rejects_api(create_object(env.service, env.ctx("sq-4"), { kind: "artifact", edition_id: "" }), "invalid_payload");
    const o2 = await new_object_in(env.service, env.ctx("sq-5"), "artifact");
    assert.equal(o2.display_no, o1.display_no + 1, "rejected creates did not use up display numbers");
  });
});

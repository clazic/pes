// SEL-40 (stage 2 PR7) first-review regression tests (r1): non-string legacy ids,
// skipped re-imports keep the new original, re-import without stored originals,
// volatile library keys (imported, round), title sentinel.
// Interface: see tests/test_content_sources.test.ts.
// Rows from db.get() are null-prototype objects: compare with { ...row } or JSON.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FakeClock } from "../scripts/pes_core/clock.ts";
import {
  CommandService,
  type MutationContext,
  type PolicyChecker,
} from "../scripts/pes_core/commands.ts";
import { add_source, append_version, create_object, import_library } from "../scripts/pes_core/content.ts";
import { connect, migrate, type Db, type RunResult, type SqlValue } from "../scripts/pes_core/db.ts";
import { ApiError } from "../scripts/pes_core/errors.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { isolated_home, type IsolatedHome } from "./helpers/isolated_home.ts";
import { state_signature } from "./helpers/state_signature.ts";

const START_MS = 1_760_000_000_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const LIBRARY = JSON.parse(readFileSync(join(HERE, "fixtures", "library_synthetic.json"), "utf8")) as Record<string, unknown>;
const ITEMS = LIBRARY.items as Array<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Harness (same shape as the first hardening file)

class FakePolicy implements PolicyChecker {
  check(_ctx: MutationContext, _command: string, _payload: unknown) {
    return { allowed: true } as const;
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
  const home = isolated_home("pes-sel40r1-");
  const db = connect(db_path(home.env));
  migrate(db);
  const clock = new FakeClock(START_MS);
  const policy = new FakePolicy();
  const service = new CommandService(db, { clock, policy });
  const p = await bootstrap(service, "setup-p", "synthetic-review");
  return {
    home,
    db,
    clock,
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

interface ImportResult {
  project_id: string;
  already_imported: boolean;
  items: Array<{ legacy_id: string | number; object_id: string; version_id: string }>;
}

interface ObjectResult {
  object_id: string;
}

function count(db: Db, sql: string, ...params: SqlValue[]): number {
  const row = db.get<{ n: bigint }>(sql, ...params);
  return Number(row?.n ?? 0n);
}

const lib_with = (items: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  ...structuredClone(LIBRARY),
  ...extra,
  items: structuredClone(items),
});

const pick = (...ids: string[]) => ids.map((id) => ITEMS.find((i) => i.id === id) as Record<string, unknown>);

const imp = async (env: Env, key: string, library: unknown, p: Project = env.p) =>
  (await import_library(env.service, ctx_for(p, key, "import"), { library })).result as ImportResult;

/** how many artifact versions of this project carry the legacy id */
function by_legacy(db: Db, project_id: string, legacy_id: string): number {
  return count(
    db,
    "SELECT count(*) AS n FROM artifact_versions WHERE project_id = ? AND json_extract(metadata_json, '$.legacy_extra.legacy_id') = ?",
    project_id,
    legacy_id,
  );
}

function import_events(db: Db): Array<Record<string, any>> {
  return db
    .all<{ payload: string }>("SELECT payload FROM events WHERE type = 'content.library_imported' ORDER BY event_seq")
    .map((r) => JSON.parse(r.payload) as Record<string, any>);
}

// ---------------------------------------------------------------------------
// helpers

function meta_of(db: Db, version_id: string): { legacy_extra: Record<string, any> } {
  const row = db.get<{ metadata_json: string }>("SELECT metadata_json FROM artifact_versions WHERE version_id = ?", version_id);
  return JSON.parse(row?.metadata_json ?? "{}");
}

function legacy_type(db: Db, version_id: string): { v: unknown; t: string } {
  const row = db.get<{ v: unknown; t: string }>(
    "SELECT json_extract(metadata_json, '$.legacy_extra.legacy_id') AS v, json_type(metadata_json, '$.legacy_extra.legacy_id') AS t FROM artifact_versions WHERE version_id = ?",
    version_id,
  );
  return { v: row?.v, t: String(row?.t) };
}

const artifacts = (db: Db) => count(db, "SELECT count(*) AS n FROM objects WHERE kind = 'artifact'");

const item = (id: unknown, extra: Record<string, unknown> = {}) => ({ id, title: `합성 ${String(id)}`, summary: "요약", sources: [], ...extra });

// ---------------------------------------------------------------------------
// 1. Item ids: safe integers (0 too) and non-empty strings; typed comparison

test("integer item ids (including 0) are accepted; the original value is kept in legacy_extra and in the result", async () => {
  await with_env(async (env) => {
    const r = await imp(env, "i-1", lib_with([item(5), item(0), item("L9")]));
    assert.equal(r.already_imported, false);
    assert.deepEqual(r.items.map((i) => i.legacy_id), [5, 0, "L9"], "result items keep the original id type");
    const t5 = legacy_type(env.db, r.items[0]!.version_id);
    assert.equal(t5.t, "integer", "an integer id stays an integer in metadata");
    assert.equal(Number(t5.v), 5);
    const t0 = legacy_type(env.db, r.items[1]!.version_id);
    assert.equal(t0.t, "integer");
    assert.equal(Number(t0.v), 0);
    assert.equal(legacy_type(env.db, r.items[2]!.version_id).t, "text");
    assert.equal(meta_of(env.db, r.items[0]!.version_id).legacy_extra.legacy_id, 5);
    assert.equal(artifacts(env.db), 3);
  });
});

test("the largest safe integer is accepted as an item id", async () => {
  await with_env(async (env) => {
    const r = await imp(env, "i-2", lib_with([item(Number.MAX_SAFE_INTEGER)]));
    assert.equal(r.items[0]?.legacy_id, Number.MAX_SAFE_INTEGER);
  });
});

test("ids that are not a safe integer or a non-empty string are invalid_payload and write nothing", async () => {
  await with_env(async (env) => {
    const before = state_signature(env.db);
    const bad: unknown[] = [1.5, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2, 2 ** 53, true, false, null, undefined, "", "   ", [], [1], {}, { a: 1 }];
    let n = 0;
    for (const id of bad) {
      n += 1;
      await rejects_api(
        import_library(env.service, ctx_for(env.p, `bad-${n}`, "import"), { library: lib_with([item("OK"), { id, title: "나쁜 id" }]) }),
        "invalid_payload",
      );
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("5 and \"5\" are different items; a repeated integer id inside one library is a duplicate", async () => {
  await with_env(async (env) => {
    const r = await imp(env, "d-1", lib_with([item(5), item("5")]));
    assert.equal(artifacts(env.db), 2, "5 and \"5\" are two items");
    assert.notEqual(r.items[0]?.object_id, r.items[1]?.object_id);
    assert.deepEqual(r.items.map((i) => i.legacy_id), [5, "5"]);
    await rejects_api(
      import_library(env.service, ctx_for(env.p, "d-2", "import"), { library: lib_with([item(7), item(7)]) }),
      "invalid_payload",
    );
    await rejects_api(
      import_library(env.service, ctx_for(env.p, "d-3", "import"), { library: lib_with([item("x"), item("x")]) }),
      "invalid_payload",
    );
    await rejects_api(
      import_library(env.service, ctx_for(env.p, "d-4", "import"), { library: lib_with([item(0), item(0)]) }),
      "invalid_payload",
    );
    assert.equal(artifacts(env.db), 2, "the rejected libraries wrote nothing");
  });
});

test("re-importing a library with integer ids reuses the earlier items and compares the type (5 vs \"5\")", async () => {
  await with_env(async (env) => {
    const first = await imp(env, "r-1", lib_with([item(5), item(0)]));
    const second = await imp(env, "r-2", lib_with([item(0), item(5), item("5")]));
    assert.equal(second.already_imported, false);
    assert.deepEqual(second.items.map((i) => i.legacy_id), [0, 5, "5"]);
    assert.equal(second.items[0]?.object_id, first.items[1]?.object_id, "0 reuses its first-run object");
    assert.equal(second.items[1]?.object_id, first.items[0]?.object_id, "5 reuses its first-run object");
    assert.ok(![first.items[0]?.object_id, first.items[1]?.object_id].includes(second.items[2]?.object_id), "\"5\" is new");
    assert.equal(artifacts(env.db), 3);
    // an exact repeat of the second library adds nothing
    const third = await imp(env, "r-3", lib_with([item(0), item(5), item("5")]));
    assert.equal(third.already_imported, true);
    assert.equal(artifacts(env.db), 3);
    assert.deepEqual(third.items.map((i) => i.legacy_id), [0, 5, "5"], "skipped result also keeps the original id types");
  });
});

test("a string id \"5\" imported first is not reused by an integer 5", async () => {
  await with_env(async (env) => {
    await imp(env, "s-1", lib_with([item("5")]));
    const r = await imp(env, "s-2", lib_with([item(5)]));
    assert.equal(r.already_imported, false);
    assert.equal(artifacts(env.db), 2);
    assert.equal(legacy_type(env.db, r.items[0]!.version_id).t, "integer");
  });
});

// ---------------------------------------------------------------------------
// 2. A changed library skipped as a repeat still keeps its own original

test("same identity and ids but changed content: the skip event keeps that file's original and library_hash", async () => {
  await with_env(async (env) => {
    const first_lib = lib_with([item("A", { summary: "첫 요약" }), item("B")]);
    const first = await imp(env, "k-1", first_lib);
    const changed = lib_with([item("A", { summary: "바뀐 요약" }), item("B", { title: "바뀐 제목" })]);
    const second = await imp(env, "k-2", changed);
    assert.equal(second.already_imported, true);
    assert.deepEqual(second.items.map((i) => i.object_id), first.items.map((i) => i.object_id));
    const ev = env.db.all<{ payload: string }>("SELECT payload FROM events WHERE type = 'content.library_import_skipped' ORDER BY event_seq");
    assert.equal(ev.length, 1);
    const p = JSON.parse(ev[0]!.payload) as Record<string, any>;
    assert.deepEqual(p.original, changed, "the second file is preserved in full");
    assert.match(String(p.library_hash), /^[0-9a-f]{64}$/);
    const imported = import_events(env.db)[0]!;
    assert.notEqual(p.library_hash, imported.library_hash, "a different file has a different hash");
    assert.deepEqual(imported.original, first_lib, "the first original is untouched");
    // stored rows still hold the first content (changes are not applied)
    const row = env.db.get<{ summary: string }>("SELECT summary FROM artifact_versions WHERE version_id = ?", first.items[0]!.version_id);
    assert.equal(row?.summary, "첫 요약");
  });
});

test("an exact repeat skip also records the hash it matched", async () => {
  await with_env(async (env) => {
    const lib = lib_with([item("A")]);
    await imp(env, "e-1", lib);
    await imp(env, "e-2", structuredClone(lib));
    const p = JSON.parse(
      env.db.get<{ payload: string }>("SELECT payload FROM events WHERE type = 'content.library_import_skipped'")!.payload,
    ) as Record<string, any>;
    assert.equal(p.library_hash, import_events(env.db)[0]!.library_hash);
  });
});

// ---------------------------------------------------------------------------
// 3. Re-import detection does not need the stored original

function strip_originals(db: Db): void {
  db.run("UPDATE events SET payload = json_remove(payload, '$.original') WHERE type = 'content.library_imported'");
}

test("re-import still reuses items after the stored original is removed from earlier events", async () => {
  await with_env(async (env) => {
    const first = await imp(env, "o-1", lib_with([item(1), item("B")]));
    strip_originals(env.db);
    assert.equal(import_events(env.db).every((e) => e.original === undefined), true, "the originals are gone");
    const second = await imp(env, "o-2", lib_with([item(1), item("B"), item("C")]));
    assert.equal(second.already_imported, false);
    assert.equal(second.items[0]?.object_id, first.items[0]?.object_id);
    assert.equal(second.items[1]?.object_id, first.items[1]?.object_id);
    assert.equal(artifacts(env.db), 3, "only C was added");
  });
});

test("an exact repeat is still detected without the stored original", async () => {
  await with_env(async (env) => {
    const lib = lib_with([item("A"), item("B")]);
    await imp(env, "x-1", lib);
    strip_originals(env.db);
    const again = await imp(env, "x-2", structuredClone(lib));
    assert.equal(again.already_imported, true);
    assert.equal(artifacts(env.db), 2);
  });
});

test("a different library identity is still a new import after the originals are removed", async () => {
  await with_env(async (env) => {
    await imp(env, "y-1", lib_with([item("A")], { topic: "주제 하나" }));
    strip_originals(env.db);
    const r = await imp(env, "y-2", lib_with([item("A")], { topic: "주제 둘" }));
    assert.equal(r.already_imported, false);
    assert.equal(artifacts(env.db), 2, "different identity, so a separate copy");
  });
});

// ---------------------------------------------------------------------------
// 4. imported / round are not part of the library identity

test("same source and topic with another imported time and round: only new items are added", async () => {
  await with_env(async (env) => {
    const base = { source: "synthetic-source-folder", topic: "합성 주제", settings: { f: true } };
    const first = await imp(env, "v-1", lib_with([item("A"), item("B")], { ...base, imported: "2026-01-02T03:04:05", round: 1 }));
    const second = await imp(env, "v-2", lib_with([item("A"), item("B"), item("C")], { ...base, imported: "2026-02-03T04:05:06", round: 2 }));
    assert.equal(second.already_imported, false);
    assert.equal(second.items[0]?.object_id, first.items[0]?.object_id);
    assert.equal(second.items[1]?.object_id, first.items[1]?.object_id);
    assert.equal(artifacts(env.db), 3, "A and B are not duplicated");
    for (const id of ["A", "B", "C"]) assert.equal(by_legacy(env.db, env.p.project_id, id), 1, `${id} exists once`);
  });
});

test("only imported / round differ and the items are the same: a repeat that adds nothing", async () => {
  await with_env(async (env) => {
    const base = { source: "synthetic-source-folder", topic: "합성 주제" };
    await imp(env, "w-1", lib_with([item("A")], { ...base, imported: "2026-01-02T03:04:05", round: 1 }));
    const r = await imp(env, "w-2", lib_with([item("A")], { ...base, imported: "2027-01-01T00:00:00", round: 9 }));
    assert.equal(r.already_imported, true);
    assert.equal(artifacts(env.db), 1);
  });
});

test("a different topic or source is still a different library even when imported / round match", async () => {
  await with_env(async (env) => {
    const when = { imported: "2026-01-02T03:04:05", round: 1 };
    await imp(env, "z-1", lib_with([item("A")], { source: "s1", topic: "t1", ...when }));
    await imp(env, "z-2", lib_with([item("A")], { source: "s1", topic: "t2", ...when }));
    await imp(env, "z-3", lib_with([item("A")], { source: "s2", topic: "t1", ...when }));
    assert.equal(artifacts(env.db), 3);
  });
});

// ---------------------------------------------------------------------------
// 5. Missing / non-string title

test("a missing title is stored as the sentinel and the original is marked in legacy_extra.title_original", async () => {
  await with_env(async (env) => {
    const r = await imp(env, "t-1", lib_with([{ id: "N1", summary: "제목 없음", sources: [] }]));
    const row = env.db.get<{ title: string }>("SELECT title FROM artifact_versions WHERE version_id = ?", r.items[0]!.version_id);
    assert.equal(row?.title, "(제목 없음)");
    const extra = meta_of(env.db, r.items[0]!.version_id).legacy_extra;
    assert.equal(Object.hasOwn(extra, "title_original"), true, "a marker is left for the missing title");
  });
});

test("a non-string title gets the sentinel and the original value in legacy_extra.title_original", async () => {
  await with_env(async (env) => {
    const values: unknown[] = [42, null, { a: 1 }, ["x"], true, 0];
    const lib = lib_with(values.map((v, i) => ({ id: `T${i}`, title: v, sources: [] })));
    const r = await imp(env, "t-2", lib);
    r.items.forEach((it, i) => {
      const row = env.db.get<{ title: string }>("SELECT title FROM artifact_versions WHERE version_id = ?", it.version_id);
      assert.equal(row?.title, "(제목 없음)", `title of T${i}`);
      assert.deepEqual(meta_of(env.db, it.version_id).legacy_extra.title_original, values[i], `title_original of T${i}`);
    });
  });
});

test("a normal string title is stored as is and gets no title_original", async () => {
  await with_env(async (env) => {
    const r = await imp(env, "t-3", lib_with([{ id: "N2", title: "보통 제목", sources: [] }]));
    const row = env.db.get<{ title: string }>("SELECT title FROM artifact_versions WHERE version_id = ?", r.items[0]!.version_id);
    assert.equal(row?.title, "보통 제목");
    assert.equal(Object.hasOwn(meta_of(env.db, r.items[0]!.version_id).legacy_extra, "title_original"), false);
  });
});

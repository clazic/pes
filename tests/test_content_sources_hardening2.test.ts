// SEL-40 (stage 2 PR7) hardening, second pass: adversarial tests around the
// re-import (legacy item id) logic, the project-scoped verifier check and the
// null-prototype extras. Interface: see tests/test_content_sources.test.ts.
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
  const home = isolated_home("pes-sel40h2-");
  const db = connect(db_path(home.env));
  migrate(db);
  const clock = new FakeClock(START_MS);
  const policy = new FakePolicy();
  const service = new CommandService(db, { clock, policy });
  const p = await bootstrap(service, "setup-p", "synthetic-hardening2");
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
  items: Array<{ legacy_id: string; object_id: string; version_id: string }>;
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
// 1. Supersets, subsets, overlaps, order

test("re-import of a superset in a different item order keeps old ids and follows the new order in the result", async () => {
  await with_env(async (env) => {
    const first = await imp(env, "o-1", lib_with(pick("L1")));
    const second = await imp(env, "o-2", lib_with(pick("L3", "L2", "L1")));
    assert.equal(second.already_imported, false);
    assert.deepEqual(second.items.map((i) => i.legacy_id), ["L3", "L2", "L1"], "result follows the new library order");
    assert.deepEqual(second.items[2], first.items[0], "L1 keeps its first-run object and version ids");
    for (const id of ["L1", "L2", "L3"]) assert.equal(by_legacy(env.db, env.p.project_id, id), 1, `${id} exists once`);
    assert.equal(count(env.db, "SELECT count(*) AS n FROM objects WHERE project_id = ? AND kind = 'artifact'", env.p.project_id), 3);
  });
});

test("re-import of a SUBSET of an earlier import does not create a second copy of any item", async () => {
  await with_env(async (env) => {
    const first = await imp(env, "s-1", lib_with(pick("L1", "L2", "L3")));
    const rows_before = count(env.db, "SELECT count(*) AS n FROM objects");
    const second = await imp(env, "s-2", lib_with(pick("L1", "L2")));
    for (const id of ["L1", "L2", "L3"]) assert.equal(by_legacy(env.db, env.p.project_id, id), 1, `${id} exists once after the subset re-import`);
    assert.equal(count(env.db, "SELECT count(*) AS n FROM objects"), rows_before, "no object was added");
    assert.deepEqual(
      second.items.map((i) => i.object_id),
      first.items.slice(0, 2).map((i) => i.object_id),
      "the subset points at the objects of the first run",
    );
  });
});

test("re-import that only partly overlaps (L1,L2 then L2,L3) imports only L3", async () => {
  await with_env(async (env) => {
    const first = await imp(env, "p-1", lib_with(pick("L1", "L2")));
    const second = await imp(env, "p-2", lib_with(pick("L2", "L3")));
    for (const id of ["L1", "L2", "L3"]) assert.equal(by_legacy(env.db, env.p.project_id, id), 1, `${id} exists once`);
    assert.equal(second.items.find((i) => i.legacy_id === "L2")?.object_id, first.items.find((i) => i.legacy_id === "L2")?.object_id);
    assert.equal(count(env.db, "SELECT count(*) AS n FROM objects WHERE kind = 'artifact'"), 3);
  });
});

test("two disjoint imports followed by one library with all of them reuse both runs and add only the new item", async () => {
  await with_env(async (env) => {
    const a = await imp(env, "d-1", lib_with(pick("L1")));
    const b = await imp(env, "d-2", lib_with(pick("L2")));
    const all = await imp(env, "d-3", lib_with(pick("L1", "L2", "L3")));
    assert.equal(all.already_imported, false);
    assert.equal(all.items[0]?.object_id, a.items[0]?.object_id);
    assert.equal(all.items[1]?.object_id, b.items[0]?.object_id);
    for (const id of ["L1", "L2", "L3"]) assert.equal(by_legacy(env.db, env.p.project_id, id), 1, `${id} exists once`);
    // the sources of L1 / L3 came with their items only once
    assert.equal(count(env.db, "SELECT count(*) AS n FROM objects WHERE kind = 'source'"), 3);
    assert.equal(count(env.db, "SELECT count(*) AS n FROM citations"), 3);
  });
});

test("a re-import that adds nothing new writes a receipt and a skipped event, and no content rows", async () => {
  await with_env(async (env) => {
    await imp(env, "n-1", lib_with(pick("L1", "L2")));
    const before = state_signature(env.db);
    const second = await imp(env, "n-2", lib_with(pick("L2", "L1")));
    assert.equal(second.already_imported, true);
    assert.equal(count(env.db, "SELECT count(*) AS n FROM events WHERE type = 'content.library_import_skipped'"), 1);
    assert.equal(count(env.db, "SELECT count(*) AS n FROM events WHERE type = 'content.library_imported'"), 1);
    for (const t of ["objects", "object_versions", "artifacts", "artifact_versions", "sources", "source_versions", "citations"]) {
      assert.equal(count(env.db, `SELECT count(*) AS n FROM ${t}`) > 0, true);
    }
    assert.notEqual(state_signature(env.db), before, "receipt and event rows exist");
    assert.equal(count(env.db, "SELECT count(*) AS n FROM objects WHERE kind = 'artifact'"), 2);
  });
});

test("ids that differ only by whitespace or case are different items, not a repeat", async () => {
  await with_env(async (env) => {
    await imp(env, "w-1", lib_with(pick("L1")));
    const variant = { ...pick("L1")[0], id: "L1 " };
    const lower = { ...pick("L1")[0], id: "l1" };
    const r = await imp(env, "w-2", lib_with([pick("L1")[0] as Record<string, unknown>, variant, lower]));
    assert.equal(r.already_imported, false);
    assert.equal(count(env.db, "SELECT count(*) AS n FROM objects WHERE kind = 'artifact'"), 3);
    assert.equal(by_legacy(env.db, env.p.project_id, "L1"), 1);
    assert.equal(by_legacy(env.db, env.p.project_id, "L1 "), 1);
    assert.equal(by_legacy(env.db, env.p.project_id, "l1"), 1);
  });
});

// ---------------------------------------------------------------------------
// 2. Same legacy id, changed content

test("same legacy id with changed content never duplicates the item or rewrites the stored version; the changed original is kept in the event", async () => {
  await with_env(async (env) => {
    const first = await imp(env, "c-1", lib_with(pick("L1", "L2")));
    const l1_before = env.db.get<{ title: string; summary: string }>(
      "SELECT title, summary FROM artifact_versions WHERE version_id = ?",
      first.items[0]?.version_id ?? "",
    );
    const changed = pick("L1", "L2", "L3").map((i) => ({ ...i }));
    changed[0] = { ...changed[0], title: "바뀐 제목", summary: "바뀐 요약" };
    const second = await imp(env, "c-2", lib_with(changed));
    assert.equal(by_legacy(env.db, env.p.project_id, "L1"), 1, "L1 is not duplicated");
    assert.equal(second.items[0]?.object_id, first.items[0]?.object_id);
    const l1_after = env.db.get<{ title: string; summary: string }>(
      "SELECT title, summary FROM artifact_versions WHERE version_id = ?",
      first.items[0]?.version_id ?? "",
    );
    assert.deepEqual({ ...l1_after }, { ...l1_before }, "the stored L1 version is untouched");
    assert.equal(count(env.db, "SELECT count(*) AS n FROM artifact_versions WHERE title = '바뀐 제목'"), 0);
    const events = import_events(env.db);
    assert.equal(events.length, 2);
    const original = events[1]?.original as { items: Array<{ title: string }> };
    assert.equal(original.items[0]?.title, "바뀐 제목", "the changed original is preserved in the event");
  });
});

test("an item imported as 'removed' stays archived when the next library lists it as active", async () => {
  await with_env(async (env) => {
    const first = await imp(env, "r-1", lib_with(pick("L2")));
    const revived = { ...pick("L2")[0], status: "done" };
    await imp(env, "r-2", lib_with([revived, pick("L1")[0] as Record<string, unknown>]));
    const row = env.db.get<{ archived_at: bigint | null }>("SELECT archived_at FROM objects WHERE id = ?", first.items[0]?.object_id ?? "");
    assert.notEqual(row?.archived_at, null, "the archived item was not touched");
    assert.equal(by_legacy(env.db, env.p.project_id, "L2"), 1);
  });
});

// ---------------------------------------------------------------------------
// 3. Same library in two projects

test("projects never share imported items: project 2 imports everything, project 1's later superset reuses only its own", async () => {
  await with_env(async (env) => {
    const p2 = await bootstrap(env.service, "x-p2", "synthetic-other-two");
    const a1 = await imp(env, "x-1", lib_with(pick("L1", "L2")));
    const b = await imp(env, "x-2", lib_with(pick("L1", "L2", "L3")), p2);
    assert.equal(b.already_imported, false, "project 2 has not imported anything");
    assert.equal(b.items.length, 3);
    const ids1 = new Set(a1.items.map((i) => i.object_id));
    assert.ok(b.items.every((i) => !ids1.has(i.object_id)), "no object id is shared between projects");
    const a2 = await imp(env, "x-3", lib_with(pick("L1", "L2", "L3")));
    assert.deepEqual(a2.items.slice(0, 2), a1.items, "project 1 reuses its own first run");
    assert.ok(a2.items.every((i) => !b.items.some((o) => o.object_id === i.object_id)), "and nothing of project 2");
    assert.equal(count(env.db, "SELECT count(*) AS n FROM objects WHERE project_id = ? AND kind = 'artifact'", env.p.project_id), 3);
    assert.equal(count(env.db, "SELECT count(*) AS n FROM objects WHERE project_id = ? AND kind = 'artifact'", p2.project_id), 3);
    // the same client key in another project is a separate command
    const again = await imp(env, "x-3", lib_with(pick("L1", "L2", "L3")), p2);
    assert.equal(again.already_imported, true);
    assert.equal(again.project_id, p2.project_id);
  });
});

// ---------------------------------------------------------------------------
// 4. Failure and replay

test("a re-import that fails halfway through the new items rolls back everything, and a retry imports them once", async () => {
  await with_env(async (env) => {
    const first = await imp(env, "f-1", lib_with(pick("L1")));
    const before = state_signature(env.db);
    let hits = 0;
    const failing = env.with_db(
      wrap_db(env.db, (sql) => {
        if (/insert\s+into\s+artifact_versions/i.test(sql) && ++hits === 2) throw new Error("injected");
        return undefined;
      }),
    );
    await rejects_any(import_library(failing, env.ctx("f-2", "import"), { library: lib_with(pick("L1", "L2", "L3")) }));
    assert.equal(hits, 2, "the failure hit the second new item");
    assert.equal(state_signature(env.db), before, "no partial rows, no receipt, no event");
    // same key retried
    const ok = (await import_library(env.service, env.ctx("f-2", "import"), { library: lib_with(pick("L1", "L2", "L3")) })).result as ImportResult;
    assert.equal(ok.already_imported, false);
    assert.deepEqual(ok.items[0], first.items[0]);
    for (const id of ["L1", "L2", "L3"]) assert.equal(by_legacy(env.db, env.p.project_id, id), 1, `${id} exists once`);
  });
});

test("replaying the same key of a partial re-import returns the first result and writes nothing", async () => {
  await with_env(async (env) => {
    await imp(env, "g-1", lib_with(pick("L1")));
    const first = await imp(env, "g-2", lib_with(pick("L1", "L2")));
    const sig = state_signature(env.db);
    const replay = await imp(env, "g-2", lib_with(pick("L1", "L2")));
    assert.deepEqual(replay, first);
    assert.equal(state_signature(env.db), sig, "replay changed no row");
  });
});

// ---------------------------------------------------------------------------
// 5. null-prototype extras reach the stored JSON and the event intact

test("hostile item keys on a NEW item of a re-import reach metadata JSON and the event, and pollute nothing", async () => {
  await with_env(async (env) => {
    await imp(env, "h-1", lib_with(pick("L1")));
    const hostile = JSON.parse(
      '{"id":"H1","title":"적대 항목","kind":"topic","__proto__":{"legacy_id":"evil","polluted":true},' +
        '"constructor":{"prototype":{"polluted":true}},"toString":"s","hasOwnProperty":7,"valueOf":null,' +
        '"legacy_id":"fake","kind_original":"fake-kind","sources":[]}',
    ) as Record<string, unknown>;
    const r = await imp(env, "h-2", lib_with([pick("L1")[0] as Record<string, unknown>, hostile]));
    assert.equal(r.already_imported, false);
    assert.equal(({} as Record<string, unknown>).polluted, undefined, "Object.prototype is clean");
    assert.equal(by_legacy(env.db, env.p.project_id, "H1"), 1, "bookkeeping legacy_id wins over the item's key");
    assert.equal(by_legacy(env.db, env.p.project_id, "evil"), 0);
    assert.equal(by_legacy(env.db, env.p.project_id, "fake"), 0);
    const row = env.db.get<{ metadata_json: string }>(
      "SELECT metadata_json FROM artifact_versions WHERE version_id = ?",
      r.items[1]?.version_id ?? "",
    );
    const extra = (JSON.parse(row?.metadata_json ?? "{}") as { legacy_extra: Record<string, unknown> }).legacy_extra;
    assert.ok(Object.hasOwn(extra, "__proto__"), "the own __proto__ key is stored as data");
    assert.deepEqual(extra["__proto__"], { legacy_id: "evil", polluted: true });
    assert.deepEqual(extra.constructor, { prototype: { polluted: true } });
    assert.equal(extra.toString, "s");
    assert.equal(extra.hasOwnProperty, 7);
    assert.equal(extra.valueOf, null);
    assert.equal(extra.legacy_id, "H1");
    assert.equal(extra.kind_original, undefined, "a valid kind leaves no kind_original in the extras; the item's own kind_original key lives only in the event");
    const original = import_events(env.db)[1]?.original as { items: Array<Record<string, unknown>> };
    const h = original.items[1] as Record<string, unknown>;
    assert.ok(Object.hasOwn(h, "__proto__"), "the event original keeps the own __proto__ key");
    assert.deepEqual(h["__proto__"], { legacy_id: "evil", polluted: true });
    assert.equal(h.legacy_id, "fake", "the event original keeps the item's own legacy_id");
    assert.equal(h.kind_original, "fake-kind");
  });
});

test("the content hash of an imported item is the same whether extras were built from a plain or a hostile object", async () => {
  await with_env(async (env) => {
    const p2 = await bootstrap(env.service, "hh-p2", "synthetic-hash-two");
    const plain = { id: "Z1", title: "같은 항목", kind: "topic", custom: 1, sources: [] };
    const a = await imp(env, "hh-1", lib_with([plain]));
    const b = await imp(env, "hh-2", lib_with([structuredClone(plain)]), p2);
    const hash = (id: string) => env.db.get<{ content_hash: string }>("SELECT content_hash FROM object_versions WHERE id = ?", id)?.content_hash;
    assert.equal(hash(a.items[0]?.version_id ?? ""), hash(b.items[0]?.version_id ?? ""));
    assert.ok(hash(a.items[0]?.version_id ?? ""));
  });
});

// ---------------------------------------------------------------------------
// 6. Verifier actor must belong to the project: bypass attempts

function add_member(env: Env, p: Project, suffix: string, opts: { kind?: string; user?: boolean; role?: string } = {}) {
  const user_id = `u-${suffix}`;
  const actor_id = `a-${suffix}`;
  const kind = opts.kind ?? "human";
  if (opts.user !== false) env.db.run("INSERT INTO users (id, display_name) VALUES (?, ?)", user_id, `합성 사용자 ${suffix}`);
  env.db.run(
    "INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, ?, ?, ?)",
    actor_id,
    kind,
    opts.user === false ? null : user_id,
    `합성 행위자 ${suffix}`,
  );
  if (opts.role !== undefined && opts.user !== false) {
    env.db.run("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)", p.project_id, user_id, opts.role);
  }
  return { user_id, actor_id };
}

async function verify_with(env: Env, key: string, actor_id: string | null) {
  const bare = (await create_object(env.service, env.ctx(`${key}-o`), { kind: "source" })).result as ObjectResult;
  return add_source(env.service, env.ctx(key), {
    object_id: bare.object_id,
    method: "fetch",
    verification_state: "unverified",
    source_kind: "web",
    title: "합성 출처",
    verified_by_actor_id: actor_id,
  });
}

test("a user who is not a member of the project cannot be named as verifier, even with a real actor row", async () => {
  await with_env(async (env) => {
    const outsider = add_member(env, env.p, "out");
    const before = state_signature(env.db);
    await rejects_any(verify_with(env, "v-1", outsider.actor_id));
    // the failed attempt leaves only the object creation made by the helper
    assert.equal(count(env.db, "SELECT count(*) AS n FROM source_versions"), 0);
    assert.notEqual(state_signature(env.db), before);
  });
});

test("a member (editor/reader) is accepted; after the membership row is removed the actor is refused again", async () => {
  await with_env(async (env) => {
    const editor = add_member(env, env.p, "ed", { role: "editor" });
    const reader = add_member(env, env.p, "rd", { role: "reader" });
    await verify_with(env, "m-1", editor.actor_id);
    await verify_with(env, "m-2", reader.actor_id);
    env.db.run("DELETE FROM project_members WHERE user_id = ?", editor.user_id);
    await rejects_any(verify_with(env, "m-3", editor.actor_id));
    assert.equal(count(env.db, "SELECT count(*) AS n FROM source_versions WHERE verified_by_actor_id = ?", editor.actor_id), 1, "the earlier record stays");
  });
});

test("a member of ANOTHER project only is refused; the owner of the other project too", async () => {
  await with_env(async (env) => {
    const p2 = await bootstrap(env.service, "ap-p2", "synthetic-actor-two");
    const only_p2 = add_member(env, p2, "p2", { role: "editor" });
    await rejects_any(verify_with(env, "o-1", only_p2.actor_id));
    await rejects_any(verify_with(env, "o-2", p2.actor_id));
    // the same user in both projects is fine for both
    env.db.run("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'reader')", env.p.project_id, only_p2.user_id);
    await verify_with(env, "o-3", only_p2.actor_id);
  });
});

test("an actor without a user (system / legacy_unknown / agent) is not a project member and is refused", async () => {
  await with_env(async (env) => {
    for (const kind of ["system", "legacy_unknown", "internal_ai", "external_agent", "browser_agent"]) {
      const a = add_member(env, env.p, `k-${kind}`, { kind, user: false });
      await rejects_any(verify_with(env, `k-${kind}`, a.actor_id));
    }
    assert.equal(count(env.db, "SELECT count(*) AS n FROM source_versions"), 0);
  });
});

test("a disabled actor, or an actor of a disabled user, cannot be named as verifier", async () => {
  await with_env(async (env) => {
    const a = add_member(env, env.p, "da", { role: "editor" });
    env.db.run("UPDATE actors SET disabled_at = 1 WHERE id = ?", a.actor_id);
    await rejects_any(verify_with(env, "d-1", a.actor_id));
    const b = add_member(env, env.p, "du", { role: "editor" });
    env.db.run("UPDATE users SET disabled_at = 1 WHERE id = ?", b.user_id);
    await rejects_any(verify_with(env, "d-2", b.actor_id));
    assert.equal(count(env.db, "SELECT count(*) AS n FROM source_versions"), 0);
  });
});

test("the verifier check also covers append_version, and odd id values are refused without a write", async () => {
  await with_env(async (env) => {
    const outsider = add_member(env, env.p, "av");
    const base = await verify_with(env, "av-0", env.p.actor_id);
    const object_id = (base.result as { object_id: string }).object_id;
    const before = state_signature(env.db);
    const bad: unknown[] = [outsider.actor_id, "", "  ", " " + env.p.actor_id, env.p.actor_id + " ", env.p.actor_id.toUpperCase(), 5, true, {}, [], "a-nope", `${env.p.actor_id}' OR '1'='1`];
    for (const value of bad) {
      await rejects_any(
        append_version(env.service, env.ctx("av-1"), {
          object_id,
          method: "fetch",
          verification_state: "unverified",
          title: "새 버전",
          verified_by_actor_id: value,
        }),
      );
    }
    assert.equal(state_signature(env.db), before, "none of the refusals wrote anything");
    const ok = await append_version(env.service, env.ctx("av-2"), {
      object_id,
      method: "fetch",
      verification_state: "unverified",
      title: "새 버전",
      verified_by_actor_id: env.p.actor_id,
    });
    assert.equal((ok.result as { version_no: number }).version_no, 2);
  });
});

test("ApiError codes for the verifier check are api errors, not raw database errors", async () => {
  await with_env(async (env) => {
    const outsider = add_member(env, env.p, "ec");
    const error = await rejects_any(verify_with(env, "ec-1", outsider.actor_id));
    assert.ok(error instanceof ApiError, `got ${String(error)}`);
  });
});

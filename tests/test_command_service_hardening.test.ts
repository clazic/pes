// SEL-37 (stage 2 PR4): hardening tests for the command service.
//
// Written after the implementation passed the gate; the goal is to break it:
// request_hash normalisation, idempotency scope, replay side effects,
// no yielding inside a transaction, cleanup after exceptions, policy
// misbehaviour, receipt/replay equality, event bookkeeping, and the limits of
// the static "no writes outside the command service" check.
//
// The base behaviours live in tests/test_command_service.test.ts. This file
// only adds; it does not change or weaken those tests.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { Clock } from "../scripts/pes_core/clock.ts";
import { FakeClock } from "../scripts/pes_core/clock.ts";
import { connect, migrate, type Db } from "../scripts/pes_core/db.ts";
import { ApiError, error_envelope } from "../scripts/pes_core/errors.ts";
import {
  COMMANDS,
  CommandService,
  type MutationContext,
  type PolicyChecker,
  type PolicyDecision,
} from "../scripts/pes_core/commands.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { isolated_home, type IsolatedHome } from "./helpers/isolated_home.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

const START_MS = 1_760_000_000_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CORE_DIR = join(REPO, "scripts", "pes_core");

// ---------------------------------------------------------------------------
// Harness

class HookPolicy implements PolicyChecker {
  calls = 0;
  decision: unknown = { allowed: true };
  on_check: ((ctx: MutationContext, command: string, payload: unknown) => void) | undefined;
  last: { ctx: MutationContext; command: string; payload: unknown } | undefined;
  check(ctx: MutationContext, command: string, payload: unknown): PolicyDecision {
    this.calls += 1;
    this.last = { ctx, command, payload };
    this.on_check?.(ctx, command, payload);
    return this.decision as PolicyDecision;
  }
}

interface Actor {
  project_id: string;
  actor_id: string;
}

interface Env {
  home: IsolatedHome;
  db: Db;
  clock: FakeClock;
  policy: HookPolicy;
  service: CommandService;
  p1: Actor;
  p2: Actor;
  ctx(p: Actor, key: string, base?: number): MutationContext;
  close(): void;
}

function bootstrap_ctx(key: string): MutationContext {
  return { project_id: null, actor_id: null, via: "cli", client_request_id: key };
}

async function make_env(): Promise<Env> {
  const home = isolated_home("pes-sel37-hard-");
  const db = connect(db_path(home.env));
  migrate(db);
  const clock = new FakeClock(START_MS);
  const policy = new HookPolicy();
  const service = new CommandService(db, { clock, policy });

  async function boot(n: number): Promise<Actor> {
    const out = await service.execute(bootstrap_ctx(`setup-p${n}`), "project.bootstrap", {
      slug: `synthetic-h${n}`,
      topic: `합성 주제 ${n}`,
      owner_display_name: `합성 소유자 ${n}`,
    });
    const r = out.result as { project_id: string; owner_actor_id: string };
    return { project_id: r.project_id, actor_id: r.owner_actor_id };
  }
  const p1 = await boot(1);
  const p2 = await boot(2);
  policy.calls = 0;

  return {
    home,
    db,
    clock,
    policy,
    service,
    p1,
    p2,
    ctx: (p, key, base) => ({
      project_id: p.project_id,
      actor_id: p.actor_id,
      via: "cli",
      client_request_id: key,
      ...(base === undefined ? {} : { base_control_rev: base }),
    }),
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

function rev_of(db: Db, project_id: string): number {
  const row = db.get<{ control_rev: bigint }>("SELECT control_rev FROM projects WHERE id = ?", project_id);
  assert.ok(row, "project row exists");
  return Number(row.control_rev);
}

function count(db: Db, table: string): number {
  return Number(db.get<{ n: bigint }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0n);
}

async function rejects_api(p: Promise<unknown> | (() => unknown), code?: string): Promise<ApiError> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
    if (code !== undefined) assert.equal(error.code, code);
    return error;
  }
  assert.fail("expected the command to be rejected");
}

/** A failed command must not leave a transaction open on the connection. */
function assert_no_open_tx(db: Db): void {
  db.exec("BEGIN IMMEDIATE");
  db.exec("ROLLBACK");
}

function receipt_for(db: Db, project_id: string, key: string) {
  return db.get<{
    id: string;
    actor_id: string;
    request_hash: string;
    result_json: string;
    base_control_rev: bigint | null;
    created_at: bigint;
  }>(
    "SELECT id, actor_id, request_hash, result_json, base_control_rev, created_at FROM mutation_commits WHERE project_id = ? AND client_request_id = ?",
    project_id,
    key,
  );
}

function add_member(env: Env, p: Actor, tag: string): Actor {
  const user_id = `user-extra-${tag}`;
  const actor_id = `actor-extra-${tag}`;
  env.db.run("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)", user_id, `합성 ${tag}`, START_MS);
  env.db.run(
    "INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, 'human', ?, ?)",
    actor_id,
    user_id,
    `합성 ${tag}`,
  );
  env.db.run("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'editor')", p.project_id, user_id);
  return { project_id: p.project_id, actor_id };
}

// ---------------------------------------------------------------------------
// request_hash normalisation

test("hash: object key order does not matter, at any depth", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    const first = await env.service.execute(env.ctx(env.p1, "ko-1", rev0), "project.set_topic", {
      topic: "순서",
      meta: { b: 2, a: { y: [1, { q: 1, p: 2 }], x: null } },
      z: true,
    });
    assert.equal(first.replayed, false);
    const sig = state_signature(env.db);
    const replay = await env.service.execute(env.ctx(env.p1, "ko-1", rev0), "project.set_topic", {
      z: true,
      meta: { a: { x: null, y: [1, { p: 2, q: 1 }] }, b: 2 },
      topic: "순서",
    });
    assert.equal(replay.replayed, true);
    assert.equal(state_signature(env.db), sig);
  });
});

test("hash: array order matters", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    await env.service.execute(env.ctx(env.p1, "ar-1", rev0), "project.set_topic", { topic: "배열", list: [1, 2] });
    const sig = state_signature(env.db);
    await rejects_api(
      env.service.execute(env.ctx(env.p1, "ar-1", rev0), "project.set_topic", { topic: "배열", list: [2, 1] }),
      "idempotency_key_reuse",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

test("hash: number representations that are the same JSON number replay; different types do not", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    await env.service.execute(env.ctx(env.p1, "num-1", rev0), "project.set_topic", { topic: "수", n: 100 });
    for (const same of [100.0, 1e2, 1000e-1]) {
      const replay = await env.service.execute(env.ctx(env.p1, "num-1", rev0), "project.set_topic", {
        topic: "수",
        n: same,
      });
      assert.equal(replay.replayed, true, `n=${same} replays`);
    }
    for (const different of ["100", 101, 100.5, null, true, [100], { v: 100 }]) {
      await rejects_api(
        env.service.execute(env.ctx(env.p1, "num-1", rev0), "project.set_topic", { topic: "수", n: different }),
        "idempotency_key_reuse",
      );
    }
    assert.equal(rev_of(env.db, env.p1.project_id), rev0 + 1);
  });
});

test("hash: an absent key and a key set to undefined are the same JSON; null is not", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    await env.service.execute(env.ctx(env.p1, "und-1", rev0), "project.set_topic", { topic: "정의" });
    const replay = await env.service.execute(env.ctx(env.p1, "und-1", rev0), "project.set_topic", {
      topic: "정의",
      extra: undefined,
    });
    assert.equal(replay.replayed, true);
    await rejects_api(
      env.service.execute(env.ctx(env.p1, "und-1", rev0), "project.set_topic", { topic: "정의", extra: null }),
      "idempotency_key_reuse",
    );
  });
});

test("hash: no Unicode normalisation, case folding, or trimming (different text is a different request)", async () => {
  await with_env(async (env) => {
    const nfc = "café";
    const nfd = "café";
    assert.notEqual(nfc, nfd);
    const rev0 = rev_of(env.db, env.p1.project_id);
    await env.service.execute(env.ctx(env.p1, "uni-1", rev0), "project.set_topic", { topic: nfc });
    for (const other of [nfd, "Café", `${nfc} `, ` ${nfc}`, "café​"]) {
      await rejects_api(
        env.service.execute(env.ctx(env.p1, "uni-1", rev0), "project.set_topic", { topic: other }),
        "idempotency_key_reuse",
      );
    }
    // The stored topic is exactly what was sent.
    assert.equal(env.db.get<{ topic: string }>("SELECT topic FROM projects WHERE id = ?", env.p1.project_id)?.topic, nfc);
  });
});

test("hash: string boundaries cannot be forged (quote/comma injection into another field)", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    await env.service.execute(env.ctx(env.p1, "forge-1", rev0), "project.set_topic", { topic: "t", a: "1", b: "2" });
    await rejects_api(
      env.service.execute(env.ctx(env.p1, "forge-1", rev0), "project.set_topic", { topic: "t", a: '1","b":"2' }),
      "idempotency_key_reuse",
    );
    await rejects_api(
      env.service.execute(env.ctx(env.p1, "forge-1", rev0), "project.set_topic", { topic: "t", "a\":\"1\",\"b": "2" }),
      "idempotency_key_reuse",
    );
  });
});

test("hash: base_control_rev is not part of the hash (replay with stale, different, or missing base)", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    await env.service.execute(env.ctx(env.p1, "base-1", rev0), "project.set_topic", { topic: "베이스" });
    await env.service.execute(env.ctx(env.p1, "base-2", rev0 + 1), "project.set_topic", { topic: "베이스 둘" });
    const sig = state_signature(env.db);
    for (const base of [rev0, rev0 + 1, rev0 + 99, undefined]) {
      const replay = await env.service.execute(env.ctx(env.p1, "base-1", base), "project.set_topic", { topic: "베이스" });
      assert.equal(replay.replayed, true, `base=${base}`);
    }
    assert.equal(state_signature(env.db), sig);
  });
});

test("hash: the command name is part of the hash (project key reused by another command)", async () => {
  await with_env(async (env) => {
    // setup-p1 was the bootstrap key of p1's owner. Reusing it from the owner
    // actor on set_topic must not replay the bootstrap result.
    const sig = state_signature(env.db);
    const rev0 = rev_of(env.db, env.p1.project_id);
    await rejects_api(
      env.service.execute(env.ctx(env.p1, "setup-p1", rev0), "project.set_topic", {
        slug: "synthetic-h1",
        topic: "합성 주제 1",
        owner_display_name: "합성 소유자 1",
      }),
      "idempotency_key_reuse",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

test("hash: a payload that cannot be serialised is invalid_payload before any policy call or write", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    const sig = state_signature(env.db);
    const circular: Record<string, unknown> = { topic: "순환" };
    circular.self = circular;
    for (const bad of [circular, { topic: "큰 정수", n: 10n }, { topic: "중첩", deep: { list: [1n] } }]) {
      await rejects_api(env.service.execute(env.ctx(env.p1, "ser-1", rev0), "project.set_topic", bad), "invalid_payload");
    }
    assert.equal(env.policy.calls, 0, "no policy call for an unreadable payload");
    assert.equal(state_signature(env.db), sig);
  });
});

test("payload shape: non-objects and bad topics are invalid_payload and change nothing", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    const sig = state_signature(env.db);
    const bad_payloads: unknown[] = [
      null,
      undefined,
      [],
      ["topic"],
      "topic",
      5,
      true,
      {},
      { topic: 5 },
      { topic: null },
      { topic: ["x"] },
      { topic: { v: "x" } },
      { topic: "" },
      { topic: "   " },
      { topic: "\t\n" },
    ];
    for (const [i, payload] of bad_payloads.entries()) {
      await rejects_api(
        env.service.execute(env.ctx(env.p1, `bp-${i}`, rev0), "project.set_topic", payload),
        "invalid_payload",
      );
    }
    for (const [i, payload] of [null, [], "x", 1, { slug: "s" }, { slug: "s", topic: "t" }, { slug: " ", topic: "t", owner_display_name: "o" }, { slug: "s", topic: "t", owner_display_name: 7 }].entries()) {
      await rejects_api(env.service.execute(bootstrap_ctx(`bb-${i}`), "project.bootstrap", payload), "invalid_payload");
    }
    assert.equal(state_signature(env.db), sig);
  });
});

test("a stored topic keeps surrounding whitespace verbatim", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    await env.service.execute(env.ctx(env.p1, "ws-1", rev0), "project.set_topic", { topic: "  앞뒤 공백  " });
    assert.equal(env.db.get<{ topic: string }>("SELECT topic FROM projects WHERE id = ?", env.p1.project_id)?.topic, "  앞뒤 공백  ");
  });
});

test("SQL in a payload is data: it is stored as text and no table is touched", async () => {
  await with_env(async (env) => {
    const counts_before = table_counts(env.db);
    const nasty = "x'); DROP TABLE projects; DELETE FROM mutation_commits; --";
    const rev0 = rev_of(env.db, env.p1.project_id);
    await env.service.execute(env.ctx(env.p1, "sqli-1", rev0), "project.set_topic", {
      topic: nasty,
      sql: "DROP TABLE events",
      table: "projects",
      ops: [{ delete: "events" }],
    });
    assert.equal(env.db.get<{ topic: string }>("SELECT topic FROM projects WHERE id = ?", env.p1.project_id)?.topic, nasty);
    const counts_after = table_counts(env.db);
    assert.deepEqual(Object.keys(counts_after), Object.keys(counts_before));
    assert.equal(counts_after.projects, counts_before.projects);
    assert.equal(counts_after.mutation_commits, (counts_before.mutation_commits ?? 0n) + 1n);

    await env.service.execute(bootstrap_ctx("sqli-2"), "project.bootstrap", {
      slug: "x'); DROP TABLE users; --",
      topic: "t",
      owner_display_name: "o'); DELETE FROM actors; --",
    });
    assert.equal(table_counts(env.db).actors, (counts_before.actors ?? 0n) + 1n);
  });
});

// ---------------------------------------------------------------------------
// Registry

test("unusual command names are unknown_command (prototype names, case, whitespace, non-strings)", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    const names: unknown[] = [
      "",
      " ",
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "PROJECT.SET_TOPIC",
      "project.set_topic ",
      " project.set_topic",
      "project.set_topic\n",
      "project.set-topic",
      "project",
      "set_topic",
      undefined,
      null,
      5,
      {},
    ];
    for (const name of names) {
      await rejects_api(
        env.service.execute(env.ctx(env.p1, "cmd-1", 0), name as string, { topic: "x" }),
        "unknown_command",
      );
    }
    assert.equal(env.policy.calls, 0);
    assert.equal(state_signature(env.db), sig);
  });
});

test("the registry cannot be extended at runtime (closed means closed)", () => {
  const registry = COMMANDS as unknown as Map<string, unknown>;
  const before = [...COMMANDS.keys()].sort();
  let added = false;
  try {
    registry.set("evil.run_sql", { action: "evil", scope: "project", rev_bearing: false, run() {} });
    added = true;
  } catch {
    // frozen or otherwise read-only: good
  }
  const leaked = COMMANDS.has("evil.run_sql");
  assert.throws(() => registry.delete("evil.run_sql"), TypeError);
  assert.equal(added || leaked, false, "COMMANDS.set must not be able to register a command at runtime");
  assert.deepEqual([...COMMANDS.keys()].sort(), before);
});

// ---------------------------------------------------------------------------
// Context validation

test("context validation: bad via, key, and ids are invalid_payload; no policy call, no write", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    const sig = state_signature(env.db);
    const base = env.ctx(env.p1, "ctx-1", rev0);
    const bad: unknown[] = [
      { ...base, via: "ftp" },
      { ...base, via: "" },
      { ...base, via: undefined },
      { ...base, via: "CLI" },
      { ...base, client_request_id: "" },
      { ...base, client_request_id: 7 },
      { ...base, client_request_id: null },
      { ...base, client_request_id: undefined },
      { ...base, project_id: 5 },
      { ...base, actor_id: 5 },
    ];
    for (const ctx of bad) {
      await rejects_api(env.service.execute(ctx as MutationContext, "project.set_topic", { topic: "맥락" }), "invalid_payload");
    }
    assert.equal(env.policy.calls, 0);
    assert.equal(state_signature(env.db), sig);
  });
});

test("every accepted transport is stored on the receipt", async () => {
  await with_env(async (env) => {
    let rev = rev_of(env.db, env.p1.project_id);
    for (const via of ["web", "cli", "http", "mcp", "webmcp", "import"] as const) {
      await env.service.execute({ ...env.ctx(env.p1, `via-${via}`, rev), via }, "project.set_topic", { topic: via });
      rev += 1;
      const stored = env.db.get<{ via: string }>(
        "SELECT via FROM mutation_commits WHERE client_request_id = ?",
        `via-${via}`,
      );
      assert.equal(stored?.via, via);
    }
  });
});

test("ids: empty or missing project/actor map to not_found / forbidden", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    const sig = state_signature(env.db);
    const mk = (project_id: string | null, actor_id: string | null): MutationContext => ({
      project_id,
      actor_id,
      via: "cli",
      client_request_id: "id-1",
      base_control_rev: rev0,
    });
    await rejects_api(env.service.execute(mk(null, env.p1.actor_id), "project.set_topic", { topic: "x" }), "not_found");
    await rejects_api(env.service.execute(mk("", env.p1.actor_id), "project.set_topic", { topic: "x" }), "not_found");
    await rejects_api(env.service.execute(mk("nope", env.p1.actor_id), "project.set_topic", { topic: "x" }), "not_found");
    await rejects_api(env.service.execute(mk(env.p1.project_id, null), "project.set_topic", { topic: "x" }), "forbidden");
    await rejects_api(env.service.execute(mk(env.p1.project_id, ""), "project.set_topic", { topic: "x" }), "forbidden");
    await rejects_api(env.service.execute(mk(env.p1.project_id, "ghost"), "project.set_topic", { topic: "x" }), "forbidden");
    assert.equal(state_signature(env.db), sig);
    assert.equal(env.policy.calls, 0, "policy is not asked about a request that has no valid scope");
  });
});

test("an actor without a user (system/agent) is forbidden even if it has a receipt key", async () => {
  await with_env(async (env) => {
    env.db.run("INSERT INTO actors (id, kind, user_id, display_name) VALUES ('sys-1', 'system', NULL, '합성 시스템')");
    const rev0 = rev_of(env.db, env.p1.project_id);
    const sig = state_signature(env.db);
    await rejects_api(
      env.service.execute(
        { project_id: env.p1.project_id, actor_id: "sys-1", via: "cli", client_request_id: "sys-k", base_control_rev: rev0 },
        "project.set_topic",
        { topic: "시스템" },
      ),
      "forbidden",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

test("bootstrap must not carry a project or an actor", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    const payload = { slug: "synthetic-ctx", topic: "t", owner_display_name: "o" };
    for (const ctx of [
      { project_id: env.p1.project_id, actor_id: null },
      { project_id: null, actor_id: env.p1.actor_id },
      { project_id: env.p1.project_id, actor_id: env.p1.actor_id },
      { project_id: "", actor_id: null },
      { project_id: null, actor_id: "" },
    ]) {
      await rejects_api(
        env.service.execute({ ...ctx, via: "cli", client_request_id: "bctx" }, "project.bootstrap", payload),
        "invalid_payload",
      );
    }
    assert.equal(state_signature(env.db), sig);
  });
});

// ---------------------------------------------------------------------------
// Idempotency scope: project and actor

test("the same client_request_id in two projects is two independent requests", async () => {
  await with_env(async (env) => {
    const r1 = rev_of(env.db, env.p1.project_id);
    const r2 = rev_of(env.db, env.p2.project_id);
    const a = await env.service.execute(env.ctx(env.p1, "shared-key", r1), "project.set_topic", { topic: "같은 주제" });
    const b = await env.service.execute(env.ctx(env.p2, "shared-key", r2), "project.set_topic", { topic: "같은 주제" });
    assert.equal(a.replayed, false);
    assert.equal(b.replayed, false, "p2 must not replay p1's receipt");
    assert.equal((a.result as { project_id: string }).project_id, env.p1.project_id);
    assert.equal((b.result as { project_id: string }).project_id, env.p2.project_id);
    assert.equal(rev_of(env.db, env.p1.project_id), r1 + 1);
    assert.equal(rev_of(env.db, env.p2.project_id), r2 + 1);

    // Different payloads under the same key in different projects: no key reuse either.
    const c = await env.service.execute(env.ctx(env.p1, "shared-key-2", r1 + 1), "project.set_topic", { topic: "하나" });
    const d = await env.service.execute(env.ctx(env.p2, "shared-key-2", r2 + 1), "project.set_topic", { topic: "둘" });
    assert.equal(c.replayed, false);
    assert.equal(d.replayed, false);
    // Each replays only its own.
    const c2 = await env.service.execute(env.ctx(env.p1, "shared-key-2", 0), "project.set_topic", { topic: "하나" });
    const d2 = await env.service.execute(env.ctx(env.p2, "shared-key-2", 0), "project.set_topic", { topic: "둘" });
    assert.deepEqual(c2.result, c.result);
    assert.deepEqual(d2.result, d.result);
  });
});

test("the same client_request_id from two actors of one project is two independent requests", async () => {
  await with_env(async (env) => {
    const other = add_member(env, env.p1, "b");
    const rev0 = rev_of(env.db, env.p1.project_id);
    const a = await env.service.execute(env.ctx(env.p1, "dup-actor", rev0), "project.set_topic", { topic: "소유자" });
    assert.equal(a.replayed, false);
    // Different payload under the same key from another actor: not a key reuse, because the key belongs to the actor.
    const b = await env.service.execute(env.ctx(other, "dup-actor", rev0 + 1), "project.set_topic", { topic: "편집자" });
    assert.equal(b.replayed, false);
    assert.equal(rev_of(env.db, env.p1.project_id), rev0 + 2);
    const rows = env.db.all<{ actor_id: string }>(
      "SELECT actor_id FROM mutation_commits WHERE project_id = ? AND client_request_id = 'dup-actor' ORDER BY created_at, rowid",
      env.p1.project_id,
    );
    assert.deepEqual(rows.map((r) => r.actor_id).sort(), [env.p1.actor_id, other.actor_id].sort());

    // Same payload from the other actor must not replay the first actor's result either.
    const c = await env.service.execute(env.ctx(other, "dup-actor-2", rev0 + 2), "project.set_topic", { topic: "동일" });
    const d = await env.service.execute(env.ctx(env.p1, "dup-actor-2", rev0 + 3), "project.set_topic", { topic: "동일" });
    assert.equal(c.replayed, false);
    assert.equal(d.replayed, false);
    assert.equal(rev_of(env.db, env.p1.project_id), rev0 + 4);
  });
});

test("a key used by another actor does not leak that actor's result", async () => {
  await with_env(async (env) => {
    const other = add_member(env, env.p1, "leak");
    const rev0 = rev_of(env.db, env.p1.project_id);
    await env.service.execute(env.ctx(env.p1, "leak-k", rev0), "project.set_topic", { topic: "비밀 주제" });
    const out = await env.service.execute(env.ctx(other, "leak-k", rev0 + 1), "project.set_topic", { topic: "다른 주제" });
    assert.equal(out.replayed, false);
    assert.doesNotMatch(JSON.stringify(out.result), /비밀 주제/);
  });
});

test("keys are compared exactly: case, whitespace, and Unicode forms are different keys", async () => {
  await with_env(async (env) => {
    let rev = rev_of(env.db, env.p1.project_id);
    const keys = ["Key", "key", "key ", " key", "café", "café", "😀", "k​"];
    for (const [i, key] of keys.entries()) {
      const out = await env.service.execute(env.ctx(env.p1, key, rev), "project.set_topic", { topic: "동일 본문" });
      assert.equal(out.replayed, false, `key #${i} ${JSON.stringify(key)} is its own key`);
      rev += 1;
    }
    assert.equal(rev_of(env.db, env.p1.project_id), rev);
    // Each key replays only itself.
    const again = await env.service.execute(env.ctx(env.p1, "café", 0), "project.set_topic", { topic: "동일 본문" });
    assert.equal(again.replayed, true);
    assert.equal((again.result as { control_rev: number }).control_rev, rev_of(env.db, env.p1.project_id) - keys.length + keys.indexOf("café") + 1);
  });
});

test("a very long client_request_id is accepted and replays", async () => {
  await with_env(async (env) => {
    const key = "k".repeat(100_000);
    const rev0 = rev_of(env.db, env.p1.project_id);
    const first = await env.service.execute(env.ctx(env.p1, key, rev0), "project.set_topic", { topic: "긴 키" });
    const replay = await env.service.execute(env.ctx(env.p1, key, rev0), "project.set_topic", { topic: "긴 키" });
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, first.result);
  });
});

test("bootstrap replay: same key and payload returns the same project; nothing new is written", async () => {
  await with_env(async (env) => {
    const payload = { slug: "synthetic-replay", topic: "부트스트랩 재생", owner_display_name: "합성 소유자" };
    const first = await env.service.execute(bootstrap_ctx("boot-rp"), "project.bootstrap", payload);
    const sig = state_signature(env.db);
    const replay = await env.service.execute(bootstrap_ctx("boot-rp"), "project.bootstrap", { ...payload });
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, first.result);
    assert.equal(state_signature(env.db), sig);
  });
});

test("bootstrap key reuse: same key with a different payload is rejected and creates nothing", async () => {
  await with_env(async (env) => {
    await env.service.execute(bootstrap_ctx("boot-ru"), "project.bootstrap", {
      slug: "synthetic-ru",
      topic: "원래",
      owner_display_name: "합성",
    });
    const sig = state_signature(env.db);
    await rejects_api(
      env.service.execute(bootstrap_ctx("boot-ru"), "project.bootstrap", {
        slug: "synthetic-ru-2",
        topic: "원래",
        owner_display_name: "합성",
      }),
      "idempotency_key_reuse",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

test("bootstrap key that equals an existing set_topic key is independent of it", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    await env.service.execute(env.ctx(env.p1, "mixed-k", rev0), "project.set_topic", { topic: "바꿈" });
    const out = await env.service.execute(bootstrap_ctx("mixed-k"), "project.bootstrap", {
      slug: "synthetic-mixed",
      topic: "t",
      owner_display_name: "o",
    });
    assert.equal(out.replayed, false);
  });
});

test("bootstrap with a duplicate slug under a new key is a conflict and leaves nothing behind; a later bootstrap still works", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    const err = await rejects_api(
      env.service.execute(bootstrap_ctx("dup-slug-1"), "project.bootstrap", {
        slug: "synthetic-h1",
        topic: "중복",
        owner_display_name: "합성",
      }),
      "conflict",
    );
    assert.equal(error_envelope(err).error.code, "conflict");
    assert.equal(state_signature(env.db), sig);
    assert_no_open_tx(env.db);
    const ok = await env.service.execute(bootstrap_ctx("dup-slug-2"), "project.bootstrap", {
      slug: "synthetic-fresh",
      topic: "새 것",
      owner_display_name: "합성",
    });
    assert.equal(ok.replayed, false);
    assert.deepEqual(env.db.all("PRAGMA foreign_key_check"), []);
  });
});

test("an id collision from the id generator is a conflict, not a half-built project", async () => {
  await with_env(async (env) => {
    const constant = new CommandService(env.db, { clock: env.clock, policy: env.policy, new_id: () => "same-id" });
    const sig = state_signature(env.db);
    await rejects_api(
      constant.execute(bootstrap_ctx("collide"), "project.bootstrap", {
        slug: "synthetic-collide",
        topic: "t",
        owner_display_name: "o",
      }),
      "conflict",
    );
    assert.equal(state_signature(env.db), sig);
    assert_no_open_tx(env.db);
  });
});

// ---------------------------------------------------------------------------
// Replay and rev

test("replay never bumps rev, adds an event, or adds a receipt, however many times and with any base", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    const first = await env.service.execute(env.ctx(env.p1, "rv-1", rev0), "project.set_topic", { topic: "재생 일" });
    await env.service.execute(env.ctx(env.p1, "rv-2", rev0 + 1), "project.set_topic", { topic: "재생 이" });
    const sig = state_signature(env.db);
    const counts = table_counts(env.db);
    for (let i = 0; i < 25; i += 1) {
      const replay = await env.service.execute(env.ctx(env.p1, "rv-1", i % 2 === 0 ? rev0 : undefined), "project.set_topic", {
        topic: "재생 일",
      });
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.result, first.result);
      env.clock.advance(1000);
    }
    assert.equal(rev_of(env.db, env.p1.project_id), rev0 + 2);
    assert.deepEqual(table_counts(env.db), counts);
    assert.equal(state_signature(env.db), sig);
  });
});

test("replay returns a fresh object each time (mutating one result cannot change the next)", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    const first = await env.service.execute(env.ctx(env.p1, "mut-1", rev0), "project.set_topic", { topic: "불변" });
    (first.result as { topic: string }).topic = "망가뜨림";
    const a = await env.service.execute(env.ctx(env.p1, "mut-1", rev0), "project.set_topic", { topic: "불변" });
    (a.result as { topic: string }).topic = "또 망가뜨림";
    const b = await env.service.execute(env.ctx(env.p1, "mut-1", rev0), "project.set_topic", { topic: "불변" });
    assert.equal((b.result as { topic: string }).topic, "불변");
    assert.notEqual(a.result, b.result);
  });
});

test("rev_conflict carries expected and actual, leaves no receipt, and the same key works with the right base", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    await env.service.execute(env.ctx(env.p1, "rc-1", rev0), "project.set_topic", { topic: "하나" });
    const sig = state_signature(env.db);
    const err = await rejects_api(
      env.service.execute(env.ctx(env.p1, "rc-2", rev0), "project.set_topic", { topic: "낡음" }),
      "rev_conflict",
    );
    assert.deepEqual(error_envelope(err).error.details, { expected: rev0, actual: rev0 + 1 });
    assert.equal(state_signature(env.db), sig);
    assert.equal(receipt_for(env.db, env.p1.project_id, "rc-2"), undefined);
    const ok = await env.service.execute(env.ctx(env.p1, "rc-2", rev0 + 1), "project.set_topic", { topic: "낡음" });
    assert.equal(ok.replayed, false);
    assert.equal(rev_of(env.db, env.p1.project_id), rev0 + 2);
  });
});

test("base_control_rev: a future base is a conflict; non-integers and wrong types are invalid_payload", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    const sig = state_signature(env.db);
    for (const base of [rev0 + 1, rev0 + 1000, Number.MAX_SAFE_INTEGER]) {
      await rejects_api(
        env.service.execute(env.ctx(env.p1, "bv-1", base), "project.set_topic", { topic: "미래" }),
        "rev_conflict",
      );
    }
    for (const base of [-1, -0.5, 0.5, rev0 + 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53, "0", null, true, 0n, [0], {}]) {
      await rejects_api(
        env.service.execute({ ...env.ctx(env.p1, "bv-2"), base_control_rev: base as number }, "project.set_topic", {
          topic: "잘못된 base",
        }),
        "invalid_payload",
      );
    }
    assert.equal(state_signature(env.db), sig);
  });
});

test("a long chain of changes keeps rev and event revisions contiguous", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    for (let i = 0; i < 30; i += 1) {
      const out = await env.service.execute(env.ctx(env.p1, `chain-${i}`, rev0 + i), "project.set_topic", { topic: `연쇄 ${i}` });
      assert.equal((out.result as { control_rev: number }).control_rev, rev0 + i + 1);
    }
    assert.equal(rev_of(env.db, env.p1.project_id), rev0 + 30);
    const events = env.db.all<{ before_rev: bigint; after_rev: bigint }>(
      "SELECT before_rev, after_rev FROM events WHERE project_id = ? AND type = 'project.topic_set' ORDER BY rowid",
      env.p1.project_id,
    );
    assert.equal(events.length, 30);
    events.forEach((e, i) => {
      assert.equal(Number(e.before_rev), rev0 + i);
      assert.equal(Number(e.after_rev), rev0 + i + 1);
    });
  });
});

test("one project's change never moves another project's rev", async () => {
  await with_env(async (env) => {
    const r2 = rev_of(env.db, env.p2.project_id);
    const rev0 = rev_of(env.db, env.p1.project_id);
    await env.service.execute(env.ctx(env.p1, "iso-1", rev0), "project.set_topic", { topic: "격리" });
    assert.equal(rev_of(env.db, env.p2.project_id), r2);
  });
});

// ---------------------------------------------------------------------------
// No yielding inside a transaction

test("execute() runs the whole transaction before it returns its promise", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    const log: string[] = [];
    let inside_tx = false;
    env.policy.on_check = () => {
      log.push("policy");
      try {
        env.db.exec("BEGIN");
      } catch {
        inside_tx = true; // a transaction was already open when the policy ran
      }
      queueMicrotask(() => log.push("microtask"));
      setImmediate(() => log.push("immediate"));
    };
    const pending = env.service.execute(env.ctx(env.p1, "sync-1", rev0), "project.set_topic", { topic: "양보 없음" });
    assert.deepEqual(log, ["policy"], "no other task ran while the command executed");
    assert.equal(rev_of(env.db, env.p1.project_id), rev0 + 1, "the change is already committed when execute() returns");
    assert.equal(inside_tx, true, "the policy check runs inside the write transaction");
    assert_no_open_tx(env.db);
    await pending;
    assert.ok(log.includes("microtask"));
  });
});

test("execute() reports failures as rejections, never as a synchronous throw", async () => {
  await with_env(async (env) => {
    let promise: Promise<unknown> | undefined;
    assert.doesNotThrow(() => {
      promise = env.service.execute(env.ctx(env.p1, "rej-1", 0), "no.such_command", {});
    });
    assert.ok(promise instanceof Promise);
    await rejects_api(promise, "unknown_command");

    assert.doesNotThrow(() => {
      promise = env.service.execute({ ...env.ctx(env.p1, "rej-2", 0), via: "nope" as never }, "project.set_topic", { topic: "x" });
    });
    await rejects_api(promise, "invalid_payload");
  });
});

test("execute_sync throws synchronously and returns a plain outcome, not a promise", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    const out = env.service.execute_sync(env.ctx(env.p1, "es-1", rev0), "project.set_topic", { topic: "동기" });
    assert.ok(!(out instanceof Promise));
    assert.equal(out.replayed, false);
    assert.throws(() => env.service.execute_sync(env.ctx(env.p1, "es-2", rev0), "project.set_topic", { topic: "낡음" }), (e: unknown) => e instanceof ApiError && e.code === "rev_conflict");
  });
});

test("two executes started together on one connection never interleave: same key replays, same base conflicts", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);

    const [a, b] = await Promise.all([
      env.service.execute(env.ctx(env.p1, "cc-1", rev0), "project.set_topic", { topic: "동시" }),
      env.service.execute(env.ctx(env.p1, "cc-1", rev0), "project.set_topic", { topic: "동시" }),
    ]);
    assert.deepEqual([a.replayed, b.replayed].sort(), [false, true]);
    assert.deepEqual(a.result, b.result);
    assert.equal(rev_of(env.db, env.p1.project_id), rev0 + 1);
    assert.equal(env.db.all("SELECT 1 FROM mutation_commits WHERE client_request_id = 'cc-1'").length, 1);

    const settled = await Promise.allSettled([
      env.service.execute(env.ctx(env.p1, "cc-2", rev0 + 1), "project.set_topic", { topic: "경쟁 가" }),
      env.service.execute(env.ctx(env.p1, "cc-3", rev0 + 1), "project.set_topic", { topic: "경쟁 나" }),
    ]);
    assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1);
    const lost = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    assert.ok(lost && lost.reason instanceof ApiError && lost.reason.code === "rev_conflict");
    assert.equal(rev_of(env.db, env.p1.project_id), rev0 + 2);
    assert_no_open_tx(env.db);
  });
});

test("twenty racing changes from one base produce exactly one winner and a consistent event log", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        env.service.execute(env.ctx(env.p1, `race-${i}`, rev0), "project.set_topic", { topic: `경주 ${i}` }),
      ),
    );
    assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1);
    for (const s of settled) {
      if (s.status === "rejected") assert.ok(s.reason instanceof ApiError && s.reason.code === "rev_conflict");
    }
    assert.equal(rev_of(env.db, env.p1.project_id), rev0 + 1);
    assert.equal(
      env.db.all("SELECT 1 FROM events WHERE project_id = ? AND type = 'project.topic_set'", env.p1.project_id).length,
      1,
    );
  });
});

test("racing bootstraps: same key replays, same slug under different keys conflicts", async () => {
  await with_env(async (env) => {
    const payload = { slug: "synthetic-race", topic: "t", owner_display_name: "o" };
    const [a, b] = await Promise.all([
      env.service.execute(bootstrap_ctx("brace-1"), "project.bootstrap", payload),
      env.service.execute(bootstrap_ctx("brace-1"), "project.bootstrap", payload),
    ]);
    assert.deepEqual([a.replayed, b.replayed].sort(), [false, true]);
    assert.equal((a.result as { project_id: string }).project_id, (b.result as { project_id: string }).project_id);

    const settled = await Promise.allSettled([
      env.service.execute(bootstrap_ctx("brace-2"), "project.bootstrap", { ...payload, slug: "synthetic-race-2" }),
      env.service.execute(bootstrap_ctx("brace-3"), "project.bootstrap", { ...payload, slug: "synthetic-race-2" }),
    ]);
    assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1);
    const lost = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    assert.ok(lost && lost.reason instanceof ApiError && lost.reason.code === "conflict");
    assert.equal(env.db.all("SELECT 1 FROM projects WHERE slug = 'synthetic-race-2'").length, 1);
    assert.deepEqual(env.db.all("PRAGMA foreign_key_check"), []);
  });
});

// ---------------------------------------------------------------------------
// Cleanup after exceptions

test("after any kind of failure the connection has no open transaction and the next command works", async () => {
  await with_env(async (env) => {
    let rev = rev_of(env.db, env.p1.project_id);
    const sig = state_signature(env.db);

    // 1) ApiError from the change itself
    await rejects_api(env.service.execute(env.ctx(env.p1, "cl-1", rev + 5), "project.set_topic", { topic: "x" }), "rev_conflict");
    assert_no_open_tx(env.db);
    // 2) plain Error from the policy
    env.policy.on_check = () => {
      throw new Error("policy exploded");
    };
    await assert.rejects(env.service.execute(env.ctx(env.p1, "cl-2", rev), "project.set_topic", { topic: "x" }), /policy exploded/);
    assert.throws(() => env.service.execute_sync(env.ctx(env.p1, "cl-2", rev), "project.set_topic", { topic: "x" }), /policy exploded/);
    assert_no_open_tx(env.db);
    env.policy.on_check = undefined;
    // 3) bad clock
    const bad_clock: Clock = { now_ms: () => 1.5 };
    const svc = new CommandService(env.db, { clock: bad_clock, policy: env.policy });
    await assert.rejects(svc.execute(env.ctx(env.p1, "cl-3", rev), "project.set_topic", { topic: "x" }), TypeError);
    assert.throws(() => svc.execute_sync(env.ctx(env.p1, "cl-3", rev), "project.set_topic", { topic: "x" }), TypeError);
    assert_no_open_tx(env.db);

    assert.equal(state_signature(env.db), sig, "none of the failures wrote anything");
    for (let i = 0; i < 3; i += 1) {
      const out = env.service.execute_sync(env.ctx(env.p1, `cl-ok-${i}`, rev), "project.set_topic", { topic: `정상 ${i}` });
      assert.equal(out.replayed, false);
      rev += 1;
    }
  });
});

test("a failing execute_sync rolls back, a following execute_sync is not 'nested tx'", () => {
  // Uses a throwaway database so the failure can be injected through the id generator.
  const home = isolated_home("pes-sel37-hard-");
  try {
    const db = connect(db_path(home.env));
    migrate(db);
    const policy = new HookPolicy();
    const clock = new FakeClock(START_MS);
    let calls = 0;
    const flaky = new CommandService(db, {
      clock,
      policy,
      new_id: () => {
        calls += 1;
        if (calls === 4) throw new Error("injected id failure");
        return `id-${calls}`;
      },
    });
    const sig = state_signature(db);
    assert.throws(
      () => flaky.execute_sync(bootstrap_ctx("fs-1"), "project.bootstrap", { slug: "s1", topic: "t", owner_display_name: "o" }),
      /injected id failure/,
    );
    assert.equal(state_signature(db), sig);
    assert_no_open_tx(db);
    const ok = flaky.execute_sync(bootstrap_ctx("fs-1"), "project.bootstrap", { slug: "s1", topic: "t", owner_display_name: "o" });
    assert.equal(ok.replayed, false);
    db.close();
  } finally {
    home.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Policy checker misbehaviour

test("policy receives the exact context, command and payload, once per request, replays included", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    const ctx = env.ctx(env.p1, "pa-1", rev0);
    const payload = { topic: "정책 인자", extra: [1, 2] };
    await env.service.execute(ctx, "project.set_topic", payload);
    assert.equal(env.policy.calls, 1);
    assert.equal(env.policy.last?.command, "project.set_topic");
    assert.deepEqual(env.policy.last?.payload, payload);
    assert.equal(env.policy.last?.ctx.client_request_id, "pa-1");
    assert.equal(env.policy.last?.ctx.project_id, env.p1.project_id);
    await env.service.execute(ctx, "project.set_topic", payload);
    assert.equal(env.policy.calls, 2, "also asked on replay");
  });
});

test("a policy that throws aborts the command, writes nothing, and the error is not swallowed or turned into 'allowed'", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    const sig = state_signature(env.db);
    env.policy.on_check = () => {
      throw new RangeError("policy backend unavailable");
    };
    await assert.rejects(
      env.service.execute(env.ctx(env.p1, "pt-1", rev0), "project.set_topic", { topic: "정책 예외" }),
      (e: unknown) => e instanceof RangeError && /unavailable/.test(e.message),
    );
    assert.equal(state_signature(env.db), sig);
    assert_no_open_tx(env.db);

    // An ApiError thrown by the policy keeps its code.
    env.policy.on_check = () => {
      throw new ApiError("forbidden", "custom denial");
    };
    const err = await rejects_api(env.service.execute(env.ctx(env.p1, "pt-2", rev0), "project.set_topic", { topic: "정책 예외" }), "forbidden");
    assert.equal(err.message, "custom denial");

    // Recovery: the same key works once the policy is healthy.
    env.policy.on_check = undefined;
    const ok = await env.service.execute(env.ctx(env.p1, "pt-1", rev0), "project.set_topic", { topic: "정책 예외" });
    assert.equal(ok.replayed, false);
  });
});

test("a policy that throws on bootstrap leaves no project", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    env.policy.on_check = () => {
      throw new Error("policy boom");
    };
    await assert.rejects(
      env.service.execute(bootstrap_ctx("pb-1"), "project.bootstrap", { slug: "synthetic-pb", topic: "t", owner_display_name: "o" }),
      /policy boom/,
    );
    assert.equal(state_signature(env.db), sig);
  });
});

test("a policy that calls back into the service cannot start a nested transaction", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    const sig = state_signature(env.db);
    env.policy.on_check = (_ctx, command) => {
      if (command === "project.set_topic") {
        env.service.execute_sync(env.ctx(env.p2, "reenter", rev_of(env.db, env.p2.project_id)), "project.set_topic", {
          topic: "정책 안에서 쓰기",
        });
      }
    };
    await assert.rejects(env.service.execute(env.ctx(env.p1, "re-1", rev0), "project.set_topic", { topic: "바깥" }), /nested/i);
    env.policy.on_check = undefined;
    assert.equal(state_signature(env.db), sig, "neither the inner nor the outer write survives");
    assert_no_open_tx(env.db);
  });
});

test("a policy that returns a Promise (async checker) fails closed", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    const sig = state_signature(env.db);
    env.policy.decision = Promise.resolve({ allowed: true });
    await assert.rejects(env.service.execute(env.ctx(env.p1, "pp-1", rev0), "project.set_topic", { topic: "비동기 정책" }));
    assert.equal(state_signature(env.db), sig, "an async decision cannot be awaited inside the tx, so nothing is written");
    assert_no_open_tx(env.db);
  });
});

test("a policy that returns nothing, null, or an empty object fails closed", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    const sig = state_signature(env.db);
    for (const decision of [undefined, null, {}, { allowed: undefined }, { allowed: false }, { allowed: false, reason: "" }]) {
      env.policy.decision = decision;
      await assert.rejects(env.service.execute(env.ctx(env.p1, "pn-1", rev0), "project.set_topic", { topic: "정책 없음" }));
    }
    assert.equal(state_signature(env.db), sig);
    assert_no_open_tx(env.db);
  });
});

test("a denial without a usable reason is still policy_denied with a message", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    const sig = state_signature(env.db);
    for (const decision of [{ allowed: false }, { allowed: false, reason: "" }, { allowed: false, reason: undefined }, { allowed: false, reason: 5 }]) {
      env.policy.decision = decision;
      const err = await rejects_api(
        env.service.execute(env.ctx(env.p1, "pd-1", rev0), "project.set_topic", { topic: "사유 없음" }),
        "policy_denied",
      );
      assert.ok(typeof err.message === "string" && err.message.length > 0);
    }
    assert.equal(state_signature(env.db), sig);
  });
});

test("only an explicit allowed:true lets a command through (truthy look-alikes are denied)", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    const sig = state_signature(env.db);
    for (const decision of [{ allowed: "false" }, { allowed: "no" }, { allowed: 1 }, { allowed: {} }, { allowed: [] }]) {
      env.policy.decision = decision;
      await assert.rejects(
        env.service.execute(env.ctx(env.p1, "pl-1", rev0), "project.set_topic", { topic: "닮은 값" }),
        "a non-boolean allowed must not open the gate",
      );
    }
    assert.equal(state_signature(env.db), sig);
  });
});

test("a policy that mutates the payload cannot change what is stored versus what was hashed", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    env.policy.on_check = (_ctx, _command, payload) => {
      (payload as { topic: string }).topic = "정책이 바꿈";
    };
    await env.service.execute(env.ctx(env.p1, "mutating-1", rev0), "project.set_topic", { topic: "원래 주제" });
    const topic = env.db.get<{ topic: string }>("SELECT topic FROM projects WHERE id = ?", env.p1.project_id)?.topic;
    assert.equal(topic, "원래 주제", "the stored topic is the one that was hashed");
  });
});

test("a policy that mutates the context cannot move the receipt to another request key", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    env.policy.on_check = (ctx) => {
      (ctx as { client_request_id: string }).client_request_id = "policy-changed-key";
    };
    await env.service.execute(env.ctx(env.p1, "mutating-2", rev0), "project.set_topic", { topic: "원래 주제" });
    assert.ok(receipt_for(env.db, env.p1.project_id, "mutating-2"), "the receipt is stored under the key the caller sent");
  });
});

// ---------------------------------------------------------------------------
// Clock

test("receipt, events, and rows share one timestamp read once per command", async () => {
  await with_env(async (env) => {
    let reads = 0;
    const counting: Clock = {
      now_ms() {
        reads += 1;
        return START_MS + 12_345;
      },
    };
    const svc = new CommandService(env.db, { clock: counting, policy: env.policy });
    const rev0 = rev_of(env.db, env.p1.project_id);
    await svc.execute(env.ctx(env.p1, "clk-1", rev0), "project.set_topic", { topic: "시계" });
    assert.equal(reads, 1);
    const receipt = receipt_for(env.db, env.p1.project_id, "clk-1");
    assert.equal(Number(receipt?.created_at), START_MS + 12_345);
    const created = env.db.all<{ created_at: bigint }>("SELECT created_at FROM events WHERE tx_id = ?", receipt?.id ?? "");
    assert.ok(created.length >= 1);
    for (const e of created) assert.equal(Number(e.created_at), START_MS + 12_345);
  });
});

test("an invalid clock reading is a TypeError and writes nothing", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    const sig = state_signature(env.db);
    for (const value of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, 2 ** 60, "5" as unknown as number, undefined as unknown as number]) {
      const svc = new CommandService(env.db, { clock: { now_ms: () => value }, policy: env.policy });
      await assert.rejects(svc.execute(env.ctx(env.p1, "badclk", rev0), "project.set_topic", { topic: "시계 이상" }), TypeError);
    }
    assert.equal(state_signature(env.db), sig);
  });
});

// ---------------------------------------------------------------------------
// Receipt result_json and replay equality

test("the stored result_json equals the first result and every replay, for set_topic and bootstrap", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    const first = await env.service.execute(env.ctx(env.p1, "eq-1", rev0), "project.set_topic", { topic: "동일성" });
    const receipt = receipt_for(env.db, env.p1.project_id, "eq-1");
    assert.ok(receipt);
    assert.equal(env.db.get<{ ok: bigint }>("SELECT json_valid(?) AS ok", receipt.result_json)?.ok, 1n);
    assert.deepEqual(JSON.parse(receipt.result_json), JSON.parse(JSON.stringify(first.result)));
    assert.deepEqual(Object.keys(JSON.parse(receipt.result_json)).sort(), ["control_rev", "project_id", "topic"]);
    for (let i = 0; i < 3; i += 1) {
      const replay = await env.service.execute(env.ctx(env.p1, "eq-1", rev0), "project.set_topic", { topic: "동일성" });
      assert.deepEqual(replay.result, first.result);
      assert.equal(JSON.stringify(replay.result), JSON.stringify(JSON.parse(receipt.result_json)));
    }

    const boot = await env.service.execute(bootstrap_ctx("eq-b"), "project.bootstrap", {
      slug: "synthetic-eq",
      topic: "부트스트랩 동일성",
      owner_display_name: "합성",
    });
    const r = boot.result as { project_id: string };
    const stored = receipt_for(env.db, r.project_id, "eq-b");
    assert.ok(stored);
    assert.deepEqual(JSON.parse(stored.result_json), JSON.parse(JSON.stringify(boot.result)));
    const replay = await env.service.execute(bootstrap_ctx("eq-b"), "project.bootstrap", {
      slug: "synthetic-eq",
      topic: "부트스트랩 동일성",
      owner_display_name: "합성",
    });
    assert.deepEqual(replay.result, boot.result);
    assert.equal((boot.result as { tx_id: string }).tx_id, stored.id, "the result names the receipt that holds it");
  });
});

test("awkward topics round-trip: stored column, receipt, and replay all agree", async () => {
  await with_env(async (env) => {
    const topics = [
      'quote " backslash \\ slash /',
      "줄\n바꿈\r\n과\t탭",
      "😀 이모지 👨‍👩‍👧 한글",
      "   line separators",
      "<script>alert(1)</script> & &amp;",
      "{\"json\":\"inside\"}",
      "x".repeat(200_000),
      "%s %d ${not_a_template} `tick`",
      "NULL",
      "0",
    ];
    let rev = rev_of(env.db, env.p1.project_id);
    for (const [i, topic] of topics.entries()) {
      const key = `aw-${i}`;
      const out = await env.service.execute(env.ctx(env.p1, key, rev), "project.set_topic", { topic });
      rev += 1;
      assert.equal(env.db.get<{ topic: string }>("SELECT topic FROM projects WHERE id = ?", env.p1.project_id)?.topic, topic);
      assert.equal((out.result as { topic: string }).topic, topic);
      const replay = await env.service.execute(env.ctx(env.p1, key, 0), "project.set_topic", { topic });
      assert.equal(replay.replayed, true);
      assert.equal((replay.result as { topic: string }).topic, topic);
      const stored = receipt_for(env.db, env.p1.project_id, key);
      assert.equal((JSON.parse(stored?.result_json ?? "{}") as { topic: string }).topic, topic);
    }
  });
});

test("a topic with an embedded NUL is either rejected or stored whole, never truncated", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    const topic = "앞\u0000뒤";
    let outcome: "stored" | "rejected" = "stored";
    try {
      await env.service.execute(env.ctx(env.p1, "nul-1", rev0), "project.set_topic", { topic });
    } catch (error) {
      assert.ok(error instanceof ApiError, `a rejection must be an ApiError, got ${String(error)}`);
      outcome = "rejected";
    }
    const stored = env.db.get<{ topic: string }>("SELECT topic FROM projects WHERE id = ?", env.p1.project_id)?.topic;
    if (outcome === "stored") assert.equal(stored, topic);
    else assert.notEqual(stored, "앞", "a rejected command leaves the old topic");
  });
});

test("a topic with a lone surrogate is either rejected or stored exactly as the receipt says", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    const topic = "깨진\ud800문자";
    let result: { topic: string } | undefined;
    try {
      result = (await env.service.execute(env.ctx(env.p1, "lone-1", rev0), "project.set_topic", { topic })).result as { topic: string };
    } catch (error) {
      assert.ok(error instanceof ApiError, `a rejection must be an ApiError, got ${String(error)}`);
      return;
    }
    const stored = env.db.get<{ topic: string }>("SELECT topic FROM projects WHERE id = ?", env.p1.project_id)?.topic;
    assert.equal(stored, result.topic, "the receipt must not claim a topic the column does not hold");
  });
});

// ---------------------------------------------------------------------------
// Events bookkeeping

test("every transaction's events: tx_size equals the real event count, indexes are 0..n-1, receipt/project/time match", async () => {
  await with_env(async (env) => {
    let rev = rev_of(env.db, env.p1.project_id);
    for (let i = 0; i < 5; i += 1) {
      await env.service.execute(env.ctx(env.p1, `ev-${i}`, rev), "project.set_topic", { topic: `이벤트 ${i}` });
      rev += 1;
      env.clock.advance(7);
    }
    await env.service.execute(bootstrap_ctx("ev-boot"), "project.bootstrap", { slug: "synthetic-ev", topic: "t", owner_display_name: "o" });
    // Failed and replayed attempts in between must not disturb the bookkeeping.
    await rejects_api(env.service.execute(env.ctx(env.p1, "ev-bad", 0), "project.set_topic", { topic: "낡음" }), "rev_conflict");
    await env.service.execute(env.ctx(env.p1, "ev-0", 0), "project.set_topic", { topic: "이벤트 0" });

    const receipts = env.db.all<{ id: string; project_id: string; created_at: bigint }>("SELECT id, project_id, created_at FROM mutation_commits");
    assert.ok(receipts.length >= 8);
    let events_seen = 0;
    for (const receipt of receipts) {
      const events = env.db.all<{
        id: string;
        project_id: string;
        tx_index: bigint;
        tx_size: bigint;
        created_at: bigint;
      }>("SELECT id, project_id, tx_index, tx_size, created_at FROM events WHERE tx_id = ? ORDER BY tx_index", receipt.id);
      assert.ok(events.length >= 1, `receipt ${receipt.id} has at least one event`);
      events_seen += events.length;
      events.forEach((e, i) => {
        assert.equal(Number(e.tx_index), i, "indexes are contiguous from 0");
        assert.equal(Number(e.tx_size), events.length, "tx_size is the real count");
        assert.equal(e.project_id, receipt.project_id);
        assert.equal(e.created_at, receipt.created_at);
      });
    }
    assert.equal(events_seen, count(env.db, "events"), "no orphan events without a receipt");
    const ids = env.db.all<{ id: string }>("SELECT id FROM events").map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, "event ids are unique");
  });
});

test("event payloads carry what changed and nothing from the request envelope", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    await env.service.execute(env.ctx(env.p1, "evp-1", rev0), "project.set_topic", { topic: "페이로드", sql: "DROP TABLE x", secret: "token" });
    const receipt = receipt_for(env.db, env.p1.project_id, "evp-1");
    const ev = env.db.get<{ type: string; payload: string; before_rev: bigint; after_rev: bigint }>(
      "SELECT type, payload, before_rev, after_rev FROM events WHERE tx_id = ?",
      receipt?.id ?? "",
    );
    assert.ok(ev);
    assert.equal(ev.type, "project.topic_set");
    assert.equal(Number(ev.before_rev), rev0);
    assert.equal(Number(ev.after_rev), rev0 + 1);
    const payload = JSON.parse(ev.payload) as Record<string, unknown>;
    assert.equal(payload.topic, "페이로드");
    assert.doesNotMatch(ev.payload, /DROP TABLE|token/);
  });
});

test("a rolled-back command leaves no orphan events even when it fails after the receipt insert", async () => {
  await with_env(async (env) => {
    const rev0 = rev_of(env.db, env.p1.project_id);
    const counts = table_counts(env.db);
    const failing: Db = {
      path: env.db.path,
      exec: (sql) => env.db.exec(sql),
      prepare: (sql) => env.db.prepare(sql),
      run: (sql, ...params) => {
        if (/^\s*INSERT\s+INTO\s+events\b/i.test(sql)) throw new Error("events down");
        return env.db.run(sql, ...params);
      },
      get: (sql, ...params) => env.db.get(sql, ...params),
      all: (sql, ...params) => env.db.all(sql, ...params),
      close: () => env.db.close(),
    };
    const svc = new CommandService(failing, { clock: env.clock, policy: env.policy });
    await assert.rejects(svc.execute(env.ctx(env.p1, "orph-1", rev0), "project.set_topic", { topic: "고아" }), /events down/);
    assert.deepEqual(table_counts(env.db), counts);
    assert.equal(receipt_for(env.db, env.p1.project_id, "orph-1"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Static checks: bypasses of the "no writes outside the command service" scan

const ALLOWED_WRITERS = new Set(["commands.ts", "db.ts", "backup.ts", "d1_smoke.ts"]);

function business_tables(): string[] {
  const sql = readFileSync(join(CORE_DIR, "migrations", "001_initial.sql"), "utf8");
  return [...sql.matchAll(/CREATE\s+TABLE\s+(\w+)/gi)].map((m) => m[1]!).filter((t) => t !== "db_meta");
}

function ts_files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...ts_files(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

/** Drops only whole-line comments; a trailing `//` inside a string never hides code. */
function without_comment_lines(source: string): string {
  let in_block = false;
  return source
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (in_block) {
        if (t.includes("*/")) in_block = false;
        return "";
      }
      if (t.startsWith("/*")) {
        if (!t.includes("*/")) in_block = true;
        return "";
      }
      if (t.startsWith("//") || t.startsWith("*")) return "";
      return line;
    })
    .join("\n");
}

/** Stronger than the base detector: schema prefixes, any quoting, dynamic table names. */
function strong_write_pattern(tables: string[]): RegExp {
  const names = tables.join("|");
  const quote = "[\"`\\[']?";
  const schema = `(?:${quote}\\w+${quote.replace("[", "[").replace("?", "?")}\\s*\\.\\s*)?`;
  return new RegExp(
    [
      `\\b(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|REPLACE\\s+INTO|UPDATE(?:\\s+OR\\s+\\w+)?|DELETE\\s+FROM)\\s+${schema}${quote}(?:${names})\\b`,
      // a write whose table name is not a literal
      "\\b(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|REPLACE\\s+INTO|UPDATE(?:\\s+OR\\s+\\w+)?|DELETE\\s+FROM)\\s+\\$\\{",
      // a write keyword at the end of a string literal that is then concatenated
      "\\b(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|REPLACE\\s+INTO|UPDATE|DELETE\\s+FROM)\\s*[\"'`]\\s*\\+",
      // writes that name the table by a string join: "INSERT " + "INTO"
      "[\"'`]\\s*(?:INSERT|REPLACE|DELETE)\\s*[\"'`]\\s*\\+",
    ].join("|"),
    "gi",
  );
}

test("strong detector: finds qualified, quoted, multi-line, and dynamic writes the base detector misses", () => {
  const re = strong_write_pattern(business_tables());
  const hits = (s: string) => without_comment_lines(s).match(re)?.length ?? 0;
  assert.equal(hits('db.run("INSERT INTO main.projects (id) VALUES (?)")'), 1, "schema-qualified");
  assert.equal(hits('db.run("UPDATE temp.events SET type = 1")'), 1);
  assert.equal(hits('db.run(`DELETE FROM "main"."mutation_commits"`)'), 1);
  assert.equal(hits("db.run(`INSERT INTO\n   projects (id) VALUES (?)`)"), 1, "multi-line");
  assert.equal(hits('db.run("INSERT INTO `projects` (id) VALUES (?)")'), 1);
  assert.equal(hits('db.run("INSERT INTO [projects] (id) VALUES (?)")'), 1);
  assert.equal(hits("db.run(`UPDATE ${table} SET a = 1`)"), 1, "dynamic table name");
  assert.equal(hits('db.run("DELETE FROM " + table)'), 1, "concatenated table name");
  assert.equal(hits('db.run("INSERT " + "INTO projects")'), 1, "split keyword");
  assert.equal(hits('const s = "a//b"; db.run("INSERT INTO projects (id) VALUES (?)")'), 1, "// inside a string does not hide code");
  assert.equal(hits('db.run("SELECT * FROM projects")'), 0);
  assert.equal(hits('db.run("INSERT INTO db_meta (k) VALUES (?)")'), 0);
  assert.equal(hits("// INSERT INTO projects only in a comment"), 0);
  assert.equal(hits("/* UPDATE projects\n   SET a = 1 */"), 0);
});

test("strong scan: files outside the allowed writers contain no business-table writes", () => {
  const re = strong_write_pattern(business_tables());
  const files = ts_files(CORE_DIR);
  assert.ok(files.length >= 5);
  const violations: string[] = [];
  for (const file of files) {
    const rel = relative(CORE_DIR, file);
    if (ALLOWED_WRITERS.has(rel)) continue;
    for (const m of without_comment_lines(readFileSync(file, "utf8")).matchAll(re)) {
      violations.push(`${relative(REPO, file)}: ${m[0].replace(/\s+/g, " ")}`);
    }
  }
  assert.deepEqual(violations, []);
});

test("files outside the allowed writers never call run/exec/prepare on a database", () => {
  const re = /\.(?:run|exec|prepare)\s*(?:<[^>()]*>)?\s*\(/g;
  const violations: string[] = [];
  for (const file of ts_files(CORE_DIR)) {
    const rel = relative(CORE_DIR, file);
    if (ALLOWED_WRITERS.has(rel)) continue;
    for (const m of without_comment_lines(readFileSync(file, "utf8")).matchAll(re)) {
      violations.push(`${relative(REPO, file)}: ${m[0]}`);
    }
  }
  assert.deepEqual(violations, [], "bootstrap.ts and friends must go through CommandService");
});

test("SQL in commands.ts is only ever a literal: no template interpolation, no concatenation", () => {
  const source = without_comment_lines(readFileSync(join(CORE_DIR, "commands.ts"), "utf8"));
  const call = /(?:\bdb|#db)\.(?:run|get|all|exec|prepare)\s*(?:<[^>()]*>)?\s*\(\s*/g;
  let calls = 0;
  const problems: string[] = [];
  for (const m of source.matchAll(call)) {
    calls += 1;
    let i = (m.index ?? 0) + m[0].length;
    const quote = source[i];
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      problems.push(`non-literal SQL argument near: ${source.slice(i, i + 40).replace(/\s+/g, " ")}`);
      continue;
    }
    i += 1;
    let body = "";
    while (i < source.length && source[i] !== quote) {
      if (source[i] === "\\") {
        body += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      body += source[i];
      i += 1;
    }
    if (quote === "`" && body.includes("${")) problems.push(`template interpolation in SQL: ${body.slice(0, 50)}`);
    const next = source.slice(i + 1).trimStart()[0];
    if (next !== "," && next !== ")") problems.push(`SQL literal is concatenated: ${body.slice(0, 50)}`);
  }
  assert.ok(calls >= 10, `the scan found the SQL calls (found ${calls})`);
  assert.deepEqual(problems, []);
});

test("registry commands are named domain actions: no definition exposes SQL or raw table access", () => {
  for (const [name, def] of COMMANDS) {
    const keys = Object.keys(def as unknown as Record<string, unknown>).sort();
    assert.deepEqual(keys, ["action", "rev_bearing", "run", "scope"], `${name} has only the fixed definition shape`);
    assert.doesNotMatch(String((def as { action: string }).action), /sql|exec|raw|table/i);
  }
});

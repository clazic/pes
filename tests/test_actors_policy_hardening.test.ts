// SEL-43 hardening (reinforcement mode): tries to break the actor / token / outbound policy
// implementation from a security point of view. Everything is synthetic. The interface is described
// in the header comment of tests/test_actors_policy.test.ts.
//
// Areas: raw-token leakage, token bypass, human-only operations, Go OFF ordering, damaged policy
// rows (fail-closed and project-local), policy before receipt replay, rollback and replay of every
// new command.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { FakeClock } from "../scripts/pes_core/clock.ts";
import { connect, migrate, type Db, type RunResult, type SqlValue } from "../scripts/pes_core/db.ts";
import { ApiError } from "../scripts/pes_core/errors.ts";
import { CommandService, type MutationContext } from "../scripts/pes_core/commands.ts";
import type { RunConfig } from "../scripts/pes_core/config.ts";
import { claim, release } from "../scripts/pes_core/runs.ts";
import {
  agent_token_hash,
  generate_agent_token,
  issue_agent_token,
  resolve_actor,
  revoke_agent_token,
  verify_agent_token,
} from "../scripts/pes_core/actors.ts";
import {
  DbPolicyChecker,
  authorize_dispatch,
  block_dispatch,
  check_go_allowed,
  current_policy,
  mark_sent,
  prepare_dispatch,
  set_policy,
} from "../scripts/pes_core/policy.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { isolated_home, type IsolatedHome } from "./helpers/isolated_home.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

const START_MS = 1_760_000_000_000;
const DAY_MS = 86_400_000;
const TOKEN_TTL_MS = 30 * DAY_MS;
const TEST_CONFIG: RunConfig = { lease_ttl_ms: 60_000, heartbeat_interval_ms: 20_000 };
const GO_MODEL = "opencode-go/deepseek-v4.1-flash";
/** Any string shaped like an issued token. Used to prove no copy exists outside the first response. */
const TOKEN_SHAPE = /pes_[A-Za-z0-9_-]{20,}/;

// ---------------------------------------------------------------------------
// Harness (a trimmed copy of the one in test_actors_policy.test.ts)

interface Lease {
  run_id: string;
  lease_id: string;
  fence: number;
  expires_at: number;
}

interface Env {
  home: IsolatedHome;
  db: Db;
  clock: FakeClock;
  service: CommandService;
  project_id: string;
  owner_actor_id: string;
  owner_user_id: string;
  agent_id: string;
  blob_id: string;
  ctx(key: string, actor_id?: string): MutationContext;
  close(): void;
}

async function make_env(): Promise<Env> {
  const home = isolated_home("pes-sel43h-");
  const db = connect(db_path(home.env));
  migrate(db);
  const clock = new FakeClock(START_MS);
  const service = new CommandService(db, { clock, policy: new DbPolicyChecker(), run_config: TEST_CONFIG });
  const out = await service.execute(
    { project_id: null, actor_id: null, via: "cli", client_request_id: "setup-p" },
    "project.bootstrap",
    { slug: "synthetic-hardening", topic: "합성 보강 주제", owner_display_name: "합성 소유자" },
  );
  const r = out.result as { project_id: string; owner_actor_id: string; owner_user_id: string };
  db.run(
    "INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, 'external_agent', ?, ?)",
    "agent-1",
    r.owner_user_id,
    "합성 에이전트",
  );
  db.run(
    `INSERT INTO blobs (id, project_id, storage_key, sha256, size, media_type, state, created_by)
     VALUES (?, ?, ?, ?, 10, 'application/json', 'ready', ?)`,
    "blob-manifest-1",
    r.project_id,
    "synthetic/manifest-1",
    "c".repeat(64),
    r.owner_actor_id,
  );
  return {
    home,
    db,
    clock,
    service,
    project_id: r.project_id,
    owner_actor_id: r.owner_actor_id,
    owner_user_id: r.owner_user_id,
    agent_id: "agent-1",
    blob_id: "blob-manifest-1",
    ctx: (key, actor_id) => ({
      project_id: r.project_id,
      actor_id: actor_id ?? r.owner_actor_id,
      via: "cli",
      client_request_id: key,
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

/** Same service/clock over a db wrapper (used to inject a failure into a write). */
function service_over(env: Env, db: Db): CommandService {
  return new CommandService(db, { clock: env.clock, policy: new DbPolicyChecker(), run_config: TEST_CONFIG });
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

async function rejects_with_api_error(p: Promise<unknown> | unknown, code?: string): Promise<ApiError> {
  try {
    await p;
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
    if (code !== undefined) assert.equal(error.code, code);
    return error;
  }
  assert.fail("expected the call to be rejected");
}

function throws_api_error(fn: () => unknown, code?: string): ApiError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
    if (code !== undefined) assert.equal(error.code, code);
    return error;
  }
  assert.fail("expected the call to throw");
}

/** Every text rendering an error can leak through. */
function error_texts(error: unknown): string[] {
  const texts = [String(error), JSON.stringify(error)];
  if (error instanceof Error) {
    texts.push(error.message, error.stack ?? "", JSON.stringify(Object.getOwnPropertyNames(error).map((k) => String((error as unknown as Record<string, unknown>)[k]))));
  }
  if (error instanceof ApiError) {
    texts.push(JSON.stringify(error.details ?? null));
  }
  return texts;
}

function assert_clean(texts: string[], forbidden: string[], label: string): void {
  for (const text of texts) {
    assert.equal(TOKEN_SHAPE.test(text), false, `${label}: no token-shaped text`);
    for (const f of forbidden) {
      assert.equal(text.includes(f), false, `${label}: leaks ${f.slice(0, 6)}...`);
    }
  }
}

/** Fragments of a token body (the shared "pes_" prefix excluded): head, middle and tail pieces. */
function token_fragments(token: string): string[] {
  const body = token.startsWith("pes_") ? token.slice(4) : token;
  return [token, body, body.slice(0, 10), body.slice(10, 20), body.slice(-10)];
}

/** Every text / blob column of every table, as one string list. */
function all_db_text(db: Db): string[] {
  const out: string[] = [];
  const tables = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .map((row) => row.name);
  for (const table of tables) {
    for (const row of db.all<Record<string, unknown>>(`SELECT * FROM "${table}"`)) {
      for (const value of Object.values(row)) {
        if (typeof value === "string") out.push(value);
        else if (value instanceof Uint8Array) out.push(Buffer.from(value).toString("latin1"));
      }
    }
  }
  return out;
}

function guard(l: Lease): { run_id: string; lease_id: string; fence: number } {
  return { run_id: l.run_id, lease_id: l.lease_id, fence: l.fence };
}

async function claim_go_lease(env: Env, key: string, run_id?: string): Promise<Lease> {
  const input =
    run_id === undefined
      ? { mode: "A", runtime: "synthetic-runtime", provider: "opencode-go", model: GO_MODEL }
      : { run_id };
  const out = await claim(env.service, env.ctx(key), input);
  return out.result as Lease;
}

function prepare_payload(env: Env, l: Lease, request_key: string): Record<string, unknown> {
  return {
    ...guard(l),
    provider: "opencode-go",
    manifest_blob_id: env.blob_id,
    payload_hash: createHash("sha256").update(request_key).digest("hex"),
    request_key,
  };
}

async function do_prepare(env: Env, key: string, l: Lease, request_key: string): Promise<string> {
  const out = await prepare_dispatch(env.service, env.ctx(key), prepare_payload(env, l, request_key));
  return (out.result as { dispatch_id: string }).dispatch_id;
}

async function do_authorize(env: Env, key: string, l: Lease, dispatch_id: string): Promise<void> {
  await authorize_dispatch(env.service, env.ctx(key), { dispatch_id, ...guard(l) });
}

async function do_mark_sent(env: Env, key: string, l: Lease, dispatch_id: string): Promise<void> {
  await mark_sent(env.service, env.ctx(key), { dispatch_id, ...guard(l), external_request_id: `ext-${key}` });
}

async function go_off(env: Env, key = "go-off", actor_id?: string) {
  return set_policy(env.service, env.ctx(key, actor_id), { allow_opencode_go: false, reason: "합성: Go 끔" });
}

async function go_on(env: Env, key = "go-on", actor_id?: string) {
  return set_policy(env.service, env.ctx(key, actor_id), { allow_opencode_go: true, reason: "합성: Go 켬" });
}

function dispatch_row(db: Db, id: string): Record<string, unknown> {
  const row = db.get<Record<string, unknown>>("SELECT * FROM outbound_dispatches WHERE id = ?", id);
  assert.ok(row, `dispatch ${id} exists`);
  return { ...row };
}

function dispatch_state(db: Db, id: string): string {
  return String(dispatch_row(db, id).state);
}

function receipt_for(db: Db, project_id: string, key: string) {
  return db.get<{ id: string; action: string; result_json: string; request_hash: string }>(
    "SELECT id, action, result_json, request_hash FROM mutation_commits WHERE project_id = ? AND client_request_id = ?",
    project_id,
    key,
  );
}

function events_of(db: Db, tx_id: string) {
  return db.all<{ type: string; run_id: string | null; tx_index: bigint; tx_size: bigint; payload: string }>(
    "SELECT type, run_id, tx_index, tx_size, payload FROM events WHERE tx_id = ? ORDER BY tx_index",
    tx_id,
  );
}

async function second_project(env: Env): Promise<{ project_id: string; actor_id: string }> {
  const out = await env.service.execute(
    { project_id: null, actor_id: null, via: "cli", client_request_id: "setup-p2" },
    "project.bootstrap",
    { slug: "synthetic-hardening-2", topic: "두 번째 합성 주제", owner_display_name: "합성 소유자 2" },
  );
  const r = out.result as { project_id: string; owner_actor_id: string };
  return { project_id: r.project_id, actor_id: r.owner_actor_id };
}

function ctx_of(project_id: string, actor_id: string, key: string): MutationContext {
  return { project_id, actor_id, via: "cli", client_request_id: key };
}

/** A human member of the project with the given role (never the owner). */
function add_member(env: Env, id: string, role: "editor" | "reader"): string {
  env.db.run("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, 0)", `user-${id}`, `합성 ${id}`);
  env.db.run("INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, 'human', ?, ?)", `actor-${id}`, `user-${id}`, `합성 ${id}`);
  env.db.run("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)", env.project_id, `user-${id}`, role);
  return `actor-${id}`;
}

interface Issued {
  token: string;
  token_id: string;
  expires_at: number;
  scopes: string[];
  actor_id: string;
  project_id: string;
}

async function issue(env: Env, key: string, scopes: string[] = ["run"], actor_id?: string): Promise<Issued> {
  const out = await issue_agent_token(env.service, env.ctx(key), { actor_id: actor_id ?? env.agent_id, scopes });
  assert.equal(out.replayed, false);
  return out.result as Issued;
}

/** A token row written straight into the table (token.issue refuses ineligible actors since the final review). */
function plant_token(env: Env, actor_id: string): { token: string } {
  const token = generate_agent_token();
  env.db.run(
    `INSERT INTO agent_tokens (id, project_id, actor_id, scopes, token_hash, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, '["run"]', ?, ?, ?, NULL)`,
    `planted-${actor_id}`,
    env.project_id,
    actor_id,
    agent_token_hash(token),
    BigInt(env.clock.now_ms()),
    BigInt(env.clock.now_ms() + TOKEN_TTL_MS),
  );
  return { token };
}

function opts(env: Env, now_ms = env.clock.now_ms()) {
  return { project_id: env.project_id, now_ms };
}

function token_hash_of(env: Env, token_id: string): string {
  const row = env.db.get<{ token_hash: string }>("SELECT token_hash FROM agent_tokens WHERE id = ?", token_id);
  assert.ok(row);
  return row.token_hash;
}

// ---------------------------------------------------------------------------
// 1. Raw token leakage

test("H1 no table, receipt, event or replay holds any fragment of the raw token or its hash outside the stored hash column", async () => {
  await with_env(async (env) => {
    const t = await issue(env, "h1-issue", ["run", "content"]);
    const hash = token_hash_of(env, t.token_id);
    // replay, revoke, a second token, and a few failures around them
    await issue_agent_token(env.service, env.ctx("h1-issue"), { actor_id: env.agent_id, scopes: ["run", "content"] });
    await issue(env, "h1-issue-2");
    await rejects_with_api_error(
      issue_agent_token(env.service, env.ctx("h1-bad"), { actor_id: env.owner_actor_id, scopes: [] }),
      "invalid_payload",
    );
    await revoke_agent_token(env.service, env.ctx("h1-revoke"), { token_id: t.token_id });
    await revoke_agent_token(env.service, env.ctx("h1-revoke"), { token_id: t.token_id });

    const fragments = token_fragments(t.token);
    for (const [table, columns] of [
      ["mutation_commits", "request_hash || '|' || result_json"],
      ["events", "payload"],
    ] as const) {
      const rows = env.db.all<{ v: string }>(`SELECT ${columns} AS v FROM ${table}`);
      for (const row of rows) {
        for (const f of fragments) assert.equal(row.v.includes(f), false, `${table} leaks a token fragment`);
        assert.equal(row.v.includes(hash), false, `${table} holds the token hash`);
      }
    }
    // The only persisted form is the hash column of agent_tokens; every other text is token-free.
    const texts = all_db_text(env.db);
    for (const text of texts) {
      if (text === hash) continue;
      assert.equal(TOKEN_SHAPE.test(text), false);
      for (const f of fragments) assert.equal(text.includes(f), false);
    }
    assert.equal(texts.filter((x) => x === hash).length, 1, "the hash appears exactly once");
    // The stored hash is not the token, nor its trivially derived forms.
    assert.notEqual(hash, t.token);
    assert.equal(hash.includes(t.token.slice(4)), false);
  });
});

test("H2 a request payload that carries a token-shaped string is not echoed into receipts or events by the new commands", async () => {
  await with_env(async (env) => {
    // A caller may paste a real secret into a free-text field by mistake; the receipt keeps only a hash
    // of the request, so the text must not be readable from the receipt columns.
    const secret = "pes_SyntheticSecretNeverStoredInPlainText0123456789";
    await set_policy(env.service, env.ctx("h2-reason"), { go_usage_stop_percent: 80, reason: `이유 ${secret}` });
    const rc = receipt_for(env.db, env.project_id, "h2-reason");
    assert.ok(rc);
    assert.equal(rc.request_hash.includes(secret), false);
    assert.equal(rc.result_json.includes(secret), false, "the result does not echo the reason");
  });
});

test("H3 verify_agent_token / resolve_actor errors never contain the presented text, its hash, or a table name", async () => {
  await with_env(async (env) => {
    const t = await issue(env, "h3-issue");
    await revoke_agent_token(env.service, env.ctx("h3-revoke"), { token_id: t.token_id });
    const probes = [
      t.token, // revoked
      `${t.token}x`,
      t.token.toUpperCase(),
      ` ${t.token}`,
      "pes_SyntheticUnknownTokenValue0123456789abcdef",
    ];
    for (const probe of probes) {
      const hash = createHash("sha256").update(probe).digest("hex");
      const e1 = throws_api_error(() => verify_agent_token(env.db, probe, opts(env)), "forbidden");
      const e2 = throws_api_error(
        () => resolve_actor(env.db, { project_id: env.project_id, token: probe }, env.clock.now_ms()),
        "forbidden",
      );
      for (const e of [e1, e2]) {
        for (const text of error_texts(e)) {
          assert.equal(text.includes(probe), false);
          assert.equal(text.includes(hash), false);
          assert.equal(/agent_tokens|token_hash|revoked_at|expires_at/.test(text), false, "no schema names");
        }
      }
      // revoked / unknown / modified all look alike: same code and the same message
      assert.equal(e1.message, e2.message, "token and actor resolution refuse with the same closed message");
    }
    const revoked = throws_api_error(() => verify_agent_token(env.db, t.token, opts(env)), "forbidden");
    const unknown = throws_api_error(() => verify_agent_token(env.db, probes[4]!, opts(env)), "forbidden");
    assert.equal(revoked.message, unknown.message, "a revoked token is indistinguishable from an unknown one");
    assert.equal(JSON.stringify(revoked.details ?? null), JSON.stringify(unknown.details ?? null));
  });
});

test("H4 a token issue that fails after the INSERT rolls back the row; no token-shaped text reaches the error", async () => {
  await with_env(async (env) => {
    const failing = wrap_db(env.db, (sql) => {
      if (sql.includes("INSERT INTO events")) throw new Error("boom-after-token-row");
    });
    const service = service_over(env, failing);
    const before = state_signature(env.db);
    const err = await service
      .execute(env.ctx("h4-issue"), "token.issue", { actor_id: env.agent_id, scopes: ["run"] })
      .then(
        () => assert.fail("expected a rejection"),
        (e: unknown) => e,
      );
    assert_clean(error_texts(err), [], "failed issue");
    assert.equal(state_signature(env.db), before, "no token row, receipt or event survives");
    assert.equal(env.db.all("SELECT 1 FROM agent_tokens").length, 0);
    // the key is still free and the retry is a fresh first response with a fresh secret
    const ok = await issue(env, "h4-issue");
    assert.ok(ok.token.length >= 32);
  });
});

test("H5 token.issue input fuzz: no raw CHECK/FK text, state unchanged, no token produced", async () => {
  await with_env(async (env) => {
    const before = state_signature(env.db);
    const lone = "\ud800";
    const bad: unknown[] = [
      { actor_id: env.agent_id, scopes: [lone] },
      { actor_id: env.agent_id, scopes: ["   "] },
      { actor_id: env.agent_id, scopes: [null] },
      { actor_id: env.agent_id, scopes: {} },
      { actor_id: env.agent_id, scopes: ["run"], token: "pes_pre_chosen_secret_value_0123456789" },
      { actor_id: env.agent_id, scopes: ["run"], token_hash: "a".repeat(64) },
      { actor_id: env.agent_id, scopes: ["run"], expires_at: 9_999_999_999_999 },
      { actor_id: env.agent_id, scopes: ["run"], project_id: "other" },
      { actor_id: 7, scopes: [] },
      { actor_id: [env.agent_id], scopes: [] },
      { actor_id: lone, scopes: [] },
      [],
    ];
    for (const [i, payload] of bad.entries()) {
      const err = await rejects_with_api_error(issue_agent_token(env.service, env.ctx(`h5-${i}`), payload));
      assert.ok(["invalid_payload", "not_found"].includes(err.code), `${i}: ${err.code}`);
      assert.equal(/CHECK|constraint|FOREIGN KEY|SQLITE/i.test(err.message), false, `${i}: raw SQL error text`);
    }
    assert.equal(state_signature(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// 2. Token bypass

test("H6 variants of a valid token are all refused: case, whitespace, truncation, prefix, NUL, lone surrogate, huge input", async () => {
  await with_env(async (env) => {
    const t = await issue(env, "h6-issue");
    const body = t.token.slice(4);
    const variants: unknown[] = [
      t.token.toUpperCase(),
      t.token.toLowerCase() === t.token ? t.token.toUpperCase() : t.token.toLowerCase(),
      ` ${t.token}`,
      `${t.token} `,
      `${t.token}\n`,
      `\t${t.token}`,
      `Bearer ${t.token}`,
      body, // prefix stripped
      `PES_${body}`,
      t.token.slice(0, -1),
      t.token.slice(1),
      `${t.token}\u0000`,
      `${t.token.slice(0, 10)}\u0000${t.token.slice(10)}`,
      `${t.token}\ud800`,
      t.token.normalize("NFD") === t.token ? `${t.token}́` : t.token.normalize("NFD"),
      t.token.repeat(2),
      t.token + "A".repeat(1_000_000),
      "A".repeat(5_000_000),
      "",
      " ",
      "\u0000",
      null,
      undefined,
      0,
      true,
      {},
      [t.token],
      { toString: () => t.token },
      Buffer.from(t.token),
    ];
    for (const [i, v] of variants.entries()) {
      throws_api_error(() => verify_agent_token(env.db, v as string, opts(env)), "forbidden");
      throws_api_error(
        () => resolve_actor(env.db, { project_id: env.project_id, token: v as string }, env.clock.now_ms()),
        i >= 0 && (v === undefined || v === null) ? "invalid_payload" : "forbidden",
      );
    }
    // The real token still works afterwards (nothing in the probing disabled it).
    assert.equal(verify_agent_token(env.db, t.token, opts(env)).token_id, t.token_id);
  });
});

test("H7 expiry boundary is exact for a token issued later, and a token without expires_at fails closed", async () => {
  await with_env(async (env) => {
    env.clock.advance(12_345);
    const t = await issue(env, "h7-issue");
    const issued_at = env.clock.now_ms();
    assert.equal(t.expires_at, issued_at + TOKEN_TTL_MS);
    assert.equal(verify_agent_token(env.db, t.token, opts(env, issued_at + TOKEN_TTL_MS - 1)).token_id, t.token_id);
    throws_api_error(() => verify_agent_token(env.db, t.token, opts(env, issued_at + TOKEN_TTL_MS)), "forbidden");
    // A moment before issue is still "not expired" - the clock is the caller's; no negative-time bypass of revoke:
    await revoke_agent_token(env.service, env.ctx("h7-revoke"), { token_id: t.token_id });
    throws_api_error(() => verify_agent_token(env.db, t.token, opts(env, issued_at - 5)), "forbidden");
    throws_api_error(() => verify_agent_token(env.db, t.token, opts(env, 0)), "forbidden");

    const u = await issue(env, "h7-issue-2");
    env.db.run("UPDATE agent_tokens SET expires_at = NULL WHERE id = ?", u.token_id);
    throws_api_error(() => verify_agent_token(env.db, u.token, opts(env)), "forbidden");
    env.db.run("UPDATE agent_tokens SET expires_at = ? WHERE id = ?", BigInt(env.clock.now_ms() + 1_000), u.token_id);
    assert.equal(verify_agent_token(env.db, u.token, opts(env)).token_id, u.token_id);
  });
});

test("H8 a non-integer or non-finite now_ms never turns into an allow", async () => {
  await with_env(async (env) => {
    const t = await issue(env, "h8-issue");
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1.5, "1" as unknown as number]) {
      let allowed = false;
      try {
        verify_agent_token(env.db, t.token, { project_id: env.project_id, now_ms: now });
        allowed = true;
      } catch (error) {
        // any rejection is fine for a caller bug, but it must still be the closed error type
        assert.ok(error instanceof ApiError, `now_ms=${String(now)} threw ${String(error)}`);
        assert.equal(error_texts(error).some((x) => x.includes(t.token)), false);
      }
      if (now === 1.5) continue; // a fractional "now" inside the window may legitimately be accepted
      assert.equal(allowed, false, `now_ms=${String(now)} must not verify`);
    }
  });
});

test("H9 revoke is permanent and idempotent: a second revoke keeps the first time; revoke never un-revokes; replays stay revoked", async () => {
  await with_env(async (env) => {
    const t = await issue(env, "h9-issue");
    env.clock.advance(1_000);
    await revoke_agent_token(env.service, env.ctx("h9-r1"), { token_id: t.token_id });
    const first = env.db.get<{ revoked_at: bigint }>("SELECT revoked_at FROM agent_tokens WHERE id = ?", t.token_id);
    env.clock.advance(5_000);
    await revoke_agent_token(env.service, env.ctx("h9-r2"), { token_id: t.token_id });
    const second = env.db.get<{ revoked_at: bigint }>("SELECT revoked_at FROM agent_tokens WHERE id = ?", t.token_id);
    assert.equal(second?.revoked_at, first?.revoked_at);
    // replaying the original issue request (same key) must neither return the token nor re-activate it
    const again = await issue_agent_token(env.service, env.ctx("h9-issue"), { actor_id: env.agent_id, scopes: ["run"] });
    assert.equal(again.replayed, true);
    assert.equal((again.result as Partial<Issued>).token, undefined);
    throws_api_error(() => verify_agent_token(env.db, t.token, opts(env)), "forbidden");
    assert.equal(env.db.all("SELECT 1 FROM agent_tokens").length, 1);
  });
});

test("H10 the unique hash blocks a collision row; a duplicate cannot hijack another token or project", async () => {
  await with_env(async (env) => {
    const a = await issue(env, "h10-a");
    const p2 = await second_project(env);
    const hash = token_hash_of(env, a.token_id);
    env.db.run("INSERT INTO actors (id, kind, user_id, display_name) VALUES ('agent-p2', 'external_agent', (SELECT owner_user_id FROM projects WHERE id = ?), '합성 p2 에이전트')", p2.project_id);
    // a second row (other project) with the same hash is impossible
    assert.throws(() =>
      env.db.run(
        `INSERT INTO agent_tokens (id, project_id, actor_id, scopes, token_hash, created_at, expires_at)
         VALUES ('collide', ?, 'agent-p2', '["run"]', ?, ?, ?)`,
        p2.project_id,
        hash,
        BigInt(START_MS),
        BigInt(START_MS + TOKEN_TTL_MS),
      ),
    );
    throws_api_error(() => verify_agent_token(env.db, a.token, { project_id: p2.project_id, now_ms: env.clock.now_ms() }), "forbidden");
    assert.equal(verify_agent_token(env.db, a.token, opts(env)).token_id, a.token_id);
    // a different token cannot be verified by presenting the hash itself
    throws_api_error(() => verify_agent_token(env.db, hash, opts(env)), "forbidden");
    // case variants of the hash text are not accepted either
    throws_api_error(() => verify_agent_token(env.db, hash.toUpperCase(), opts(env)), "forbidden");
  });
});

test("H11 a token stops working when its actor is disabled; other tokens keep working", async () => {
  await with_env(async (env) => {
    const t = await issue(env, "h11-issue");
    env.db.run("INSERT INTO actors (id, kind, user_id, display_name) VALUES ('agent-2', 'internal_ai', ?, '합성 2')", env.owner_user_id);
    const u = await issue(env, "h11-issue-2", ["run"], "agent-2");
    const now_ms = env.clock.now_ms();
    const resolve = (token: string) => resolve_actor(env.db, { project_id: env.project_id, token }, now_ms);
    assert.equal(resolve(t.token).actor_id, env.agent_id);

    env.db.run("UPDATE actors SET disabled_at = ? WHERE id = 'agent-2'", BigInt(START_MS));
    throws_api_error(() => resolve(u.token), "forbidden");
    throws_api_error(() => verify_agent_token(env.db, u.token, opts(env)), "forbidden");
    assert.equal(resolve(t.token).actor_id, env.agent_id, "the other agent's token is unaffected");
  });
});

test("H11b a token and an actor id stop authenticating when their user is disabled (users.disabled_at)", async () => {
  await with_env(async (env) => {
    const t = await issue(env, "h11b-issue");
    const now_ms = env.clock.now_ms();
    env.db.run("UPDATE users SET disabled_at = ? WHERE id = ?", BigInt(START_MS), env.owner_user_id);
    throws_api_error(() => resolve_actor(env.db, { project_id: env.project_id, token: t.token }, now_ms), "forbidden");
    throws_api_error(
      () => resolve_actor(env.db, { project_id: env.project_id, actor_id: env.owner_actor_id }, now_ms),
      "forbidden",
    );
  });
});

test("H12 an agent whose user is not a member of the project cannot authenticate with a token or an id", async () => {
  await with_env(async (env) => {
    const t = await issue(env, "h12-issue");
    env.db.run("INSERT INTO users (id, display_name, created_at) VALUES ('user-out', '합성 외부', 0)");
    env.db.run("INSERT INTO actors (id, kind, user_id, display_name) VALUES ('agent-out', 'external_agent', 'user-out', '합성 외부 에이전트')");
    env.db.run("INSERT INTO actors (id, kind, user_id, display_name) VALUES ('agent-nouser', 'external_agent', NULL, '합성 무사용자')");
    // Final-review R1: token.issue refuses these targets now, so plant the token rows directly
    // to keep testing that verification and resolution never grant access to them.
    const o = plant_token(env, "agent-out");
    const n = plant_token(env, "agent-nouser");
    const now_ms = env.clock.now_ms();
    for (const token of [o.token, n.token]) {
      throws_api_error(() => resolve_actor(env.db, { project_id: env.project_id, token }, now_ms), "forbidden");
    }
    for (const actor_id of ["agent-out", "agent-nouser"]) {
      throws_api_error(() => resolve_actor(env.db, { project_id: env.project_id, actor_id }, now_ms), "forbidden");
      await rejects_with_api_error(
        set_policy(env.service, env.ctx(`h12-${actor_id}`, actor_id), { allow_opencode_go: false, reason: "합성" }),
        "forbidden",
      );
    }
    assert.equal(resolve_actor(env.db, { project_id: env.project_id, token: t.token }, now_ms).actor_id, env.agent_id);
    assert.equal(current_policy(env.db, env.project_id).allow_opencode_go, true);
  });
});

test("H13 resolve_actor input shape: empty ids, both/neither credential, wrong types, other project id", async () => {
  await with_env(async (env) => {
    const t = await issue(env, "h13-issue");
    const p2 = await second_project(env);
    const now_ms = env.clock.now_ms();
    const lookups: Array<[unknown, string]> = [
      [{ project_id: env.project_id, actor_id: "" }, "invalid_payload"],
      [{ project_id: "", actor_id: env.owner_actor_id }, "invalid_payload"],
      [{ project_id: env.project_id, actor_id: 7 }, "invalid_payload"],
      [{ project_id: env.project_id, actor_id: env.owner_actor_id, token: t.token }, "invalid_payload"],
      [{ project_id: env.project_id, actor_id: null, token: null }, "invalid_payload"],
      [{ project_id: env.project_id, token: "" }, "forbidden"],
      [{ project_id: p2.project_id, token: t.token }, "forbidden"],
      [{ project_id: "no-such-project", actor_id: env.owner_actor_id }, "forbidden"],
      [null, "invalid_payload"],
      ["text", "invalid_payload"],
    ];
    for (const [lookup, code] of lookups) {
      throws_api_error(() => resolve_actor(env.db, lookup as never, now_ms), code);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Human-only operations

test("H14 reader and editor humans, a disabled owner, and an owner-user agent cannot set the policy, re-allow or manage tokens", async () => {
  await with_env(async (env) => {
    const editor = add_member(env, "editor", "editor");
    const reader = add_member(env, "reader", "reader");
    const t = await issue(env, "h14-issue");
    await go_off(env, "h14-off");
    const before = state_signature(env.db);
    for (const actor of [editor, reader, env.agent_id]) {
      await rejects_with_api_error(go_on(env, `h14-on-${actor}`, actor), "forbidden");
      await rejects_with_api_error(
        set_policy(env.service, env.ctx(`h14-model-${actor}`, actor), { mode_a_model: "opencode-go/other", reason: "합성" }),
        "forbidden",
      );
      await rejects_with_api_error(
        set_policy(env.service, env.ctx(`h14-pct-${actor}`, actor), { go_usage_stop_percent: 100, reason: "합성" }),
        "forbidden",
      );
      await rejects_with_api_error(
        issue_agent_token(env.service, env.ctx(`h14-issue-${actor}`, actor), { actor_id: env.agent_id, scopes: ["run"] }),
        "forbidden",
      );
      await rejects_with_api_error(
        revoke_agent_token(env.service, env.ctx(`h14-revoke-${actor}`, actor), { token_id: t.token_id }),
        "forbidden",
      );
    }
    assert.equal(state_signature(env.db), before);

    // disabled owner actor
    env.db.run("UPDATE actors SET disabled_at = ? WHERE id = ?", BigInt(START_MS), env.owner_actor_id);
    const disabled_before = state_signature(env.db);
    await rejects_with_api_error(go_on(env, "h14-disabled"), "forbidden");
    await rejects_with_api_error(
      issue_agent_token(env.service, env.ctx("h14-disabled-issue"), { actor_id: env.agent_id, scopes: [] }),
      "forbidden",
    );
    assert.equal(state_signature(env.db), disabled_before);
    assert.equal(current_policy(env.db, env.project_id).allow_opencode_go, false);
  });
});

test("H15 a disabled owner user cannot change the policy even through an enabled human actor", async () => {
  await with_env(async (env) => {
    env.db.run("UPDATE users SET disabled_at = ? WHERE id = ?", BigInt(START_MS), env.owner_user_id);
    const before = state_signature(env.db);
    await rejects_with_api_error(go_off(env, "h15-off"), "forbidden");
    await rejects_with_api_error(
      issue_agent_token(env.service, env.ctx("h15-issue"), { actor_id: env.agent_id, scopes: [] }),
      "forbidden",
    );
    assert.equal(state_signature(env.db), before);
  });
});

test("H16 policy.set cannot be told who changed it or what revision it is: author, kind, rev, ids are rejected", async () => {
  await with_env(async (env) => {
    const before = state_signature(env.db);
    const extras: Array<Record<string, unknown>> = [
      { changed_by: env.agent_id },
      { changed_by_kind: "human" },
      { changed_by_user_id: env.owner_user_id },
      { policy_rev: 99 },
      { project_id: env.project_id },
      { tx_id: "forged" },
      { id: "forged-policy" },
      { actor_id: env.owner_actor_id },
      { created_at: 1 },
    ];
    for (const [i, extra] of extras.entries()) {
      await rejects_with_api_error(
        set_policy(env.service, env.ctx(`h16-${i}`, env.agent_id), { allow_opencode_go: false, reason: "합성", ...extra }),
        undefined,
      );
      await rejects_with_api_error(
        set_policy(env.service, env.ctx(`h16-owner-${i}`), { allow_opencode_go: false, reason: "합성", ...extra }),
        "invalid_payload",
      );
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("H17 a policy row written by the owner always names the owner and a human, even when an agent shares the owner's user", async () => {
  await with_env(async (env) => {
    await go_off(env, "h17-off");
    await go_on(env, "h17-on");
    const rows = env.db.all<{ changed_by: string; changed_by_kind: string; changed_by_user_id: string }>(
      "SELECT changed_by, changed_by_kind, changed_by_user_id FROM project_policy_versions WHERE project_id = ? ORDER BY policy_rev",
      env.project_id,
    );
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.changed_by_kind, "human");
      assert.notEqual(row.changed_by, env.agent_id);
    }
    assert.equal(rows[1]!.changed_by, env.owner_actor_id);
    assert.equal(rows[2]!.changed_by, env.owner_actor_id);
  });
});

// ---------------------------------------------------------------------------
// 4. Go OFF ordering

test("H18 OFF right after prepare: authorize and mark_sent are denied, the dispatch is blocked and stays blocked after ON", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "h18-claim");
    const id = await do_prepare(env, "h18-prep", l, "rk-18");
    const out = await go_off(env, "h18-off");
    assert.deepEqual((out.result as { blocked_dispatch_ids: string[] }).blocked_dispatch_ids, [id]);
    assert.equal(dispatch_state(env.db, id), "blocked");
    const blocked_row = dispatch_row(env.db, id);

    const before = state_signature(env.db);
    await rejects_with_api_error(authorize_dispatch(env.service, env.ctx("h18-auth"), { dispatch_id: id, ...guard(l) }), "policy_denied");
    await rejects_with_api_error(mark_sent(env.service, env.ctx("h18-sent"), { dispatch_id: id, ...guard(l) }), "policy_denied");
    assert.equal(state_signature(env.db), before);

    await go_on(env, "h18-on");
    assert.deepEqual(dispatch_row(env.db, id), blocked_row, "ON does not touch the blocked row");
    for (const attempt of [
      authorize_dispatch(env.service, env.ctx("h18-auth2"), { dispatch_id: id, ...guard(l) }),
      mark_sent(env.service, env.ctx("h18-sent2"), { dispatch_id: id, ...guard(l) }),
      block_dispatch(env.service, env.ctx("h18-block2"), { dispatch_id: id, reason: "합성" }),
    ]) {
      await rejects_with_api_error(attempt, "conflict");
    }
    assert.deepEqual(dispatch_row(env.db, id), blocked_row);
    // the request_key of the blocked dispatch is still burned; a fresh key works
    await rejects_with_api_error(prepare_dispatch(env.service, env.ctx("h18-reuse"), prepare_payload(env, l, "rk-18")), "conflict");
    // Final-review F1: OFF revoked the lease, so a fresh dispatch needs a new claim (new fence).
    await rejects_with_api_error(prepare_dispatch(env.service, env.ctx("h18-old-prep"), prepare_payload(env, l, "rk-18b")), "conflict");
    const l2 = await claim_go_lease(env, "h18-reclaim", l.run_id);
    assert.ok(l2.fence > l.fence);
    const fresh = await do_prepare(env, "h18-fresh", l2, "rk-18b");
    assert.notEqual(fresh, id);
    assert.equal(dispatch_state(env.db, fresh), "prepared");
    assert.equal(dispatch_row(env.db, fresh).policy_version_id, current_policy(env.db, env.project_id).policy_id);
    assert.notEqual(dispatch_row(env.db, id).policy_version_id, current_policy(env.db, env.project_id).policy_id);
  });
});

test("H19 OFF right after authorize: mark_sent is denied, the transport never gets it, ON does not resurrect it", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "h19-claim");
    const id = await do_prepare(env, "h19-prep", l, "rk-19");
    await do_authorize(env, "h19-auth", l, id);
    await go_off(env, "h19-off");
    assert.equal(dispatch_state(env.db, id), "blocked");
    await rejects_with_api_error(mark_sent(env.service, env.ctx("h19-sent"), { dispatch_id: id, ...guard(l) }), "policy_denied");
    await go_on(env, "h19-on");
    const row = dispatch_row(env.db, id);
    await rejects_with_api_error(mark_sent(env.service, env.ctx("h19-sent2"), { dispatch_id: id, ...guard(l) }), "conflict");
    await rejects_with_api_error(authorize_dispatch(env.service, env.ctx("h19-auth2"), { dispatch_id: id, ...guard(l) }), "conflict");
    assert.deepEqual(dispatch_row(env.db, id), row);
    assert.equal(row.sent_at, null);
    assert.equal(row.external_request_id, null);
  });
});

test("H20 OFF right after mark_sent: the sent dispatch is byte-for-byte unchanged and can no longer be blocked", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "h20-claim");
    const id = await do_prepare(env, "h20-prep", l, "rk-20");
    await do_authorize(env, "h20-auth", l, id);
    await do_mark_sent(env, "h20-sent", l, id);
    const sent_row = dispatch_row(env.db, id);
    const out = await go_off(env, "h20-off");
    assert.deepEqual((out.result as { blocked_dispatch_ids: string[] }).blocked_dispatch_ids, []);
    assert.deepEqual(dispatch_row(env.db, id), sent_row);
    await rejects_with_api_error(block_dispatch(env.service, env.ctx("h20-block"), { dispatch_id: id, reason: "합성" }), "conflict");
    await go_on(env, "h20-on");
    assert.deepEqual(dispatch_row(env.db, id), sent_row);
    // the receipt of mark_sent is still the replay source only while Go is ON
    const again = await mark_sent(env.service, env.ctx("h20-sent"), { dispatch_id: id, ...guard(l), external_request_id: "ext-h20-sent" });
    assert.equal(again.replayed, true);
  });
});

test("H21 OFF only touches this project's prepared/authorized dispatches; response/adopted/failed/unknown/blocked are never edited", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "h21-claim");
    const ids: Record<string, string> = {};
    for (const name of ["prepared", "authorized", "response", "adopted", "failed", "unknown", "blocked_by_hand"]) {
      ids[name] = await do_prepare(env, `h21-prep-${name}`, l, `rk-21-${name}`);
    }
    for (const name of ["authorized", "response", "adopted", "failed", "unknown"]) {
      await do_authorize(env, `h21-auth-${name}`, l, ids[name]!);
    }
    for (const name of ["response", "adopted", "failed", "unknown"]) {
      await do_mark_sent(env, `h21-sent-${name}`, l, ids[name]!);
    }
    await block_dispatch(env.service, env.ctx("h21-block"), { dispatch_id: ids.blocked_by_hand!, reason: "합성: 수동" });
    env.db.run("UPDATE outbound_dispatches SET state = 'response', response_hash = ? WHERE id = ?", "d".repeat(64), ids.response!);
    env.db.exec("PRAGMA foreign_keys = OFF"); // the adopted version row is out of scope here
    env.db.run(
      "UPDATE outbound_dispatches SET state = 'adopted', response_hash = ?, adopted_version_id = 'v-synthetic' WHERE id = ?",
      "e".repeat(64),
      ids.adopted!,
    );
    env.db.run("UPDATE outbound_dispatches SET state = 'failed' WHERE id = ?", ids.failed!);
    env.db.run("UPDATE outbound_dispatches SET state = 'unknown', unknown_at = ?, unknown_reason = '합성' WHERE id = ?", BigInt(START_MS), ids.unknown!);

    const p2 = await second_project(env);
    const before_rows = Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, dispatch_row(env.db, v)]));

    const out = await go_off(env, "h21-off");
    assert.deepEqual(
      new Set((out.result as { blocked_dispatch_ids: string[] }).blocked_dispatch_ids),
      new Set([ids.prepared, ids.authorized]),
    );
    for (const name of ["response", "adopted", "failed", "unknown", "blocked_by_hand"]) {
      assert.deepEqual(dispatch_row(env.db, ids[name]!), before_rows[name], `${name} untouched`);
    }
    assert.equal(dispatch_state(env.db, ids.prepared!), "blocked");
    assert.equal(dispatch_state(env.db, ids.authorized!), "blocked");
    // events: policy.changed first, then one dispatch.blocked per blocked dispatch, indices consistent
    const rc = receipt_for(env.db, env.project_id, "h21-off");
    assert.ok(rc);
    const events = events_of(env.db, rc.id);
    // Final-review F1: OFF also revokes the Go run's lease, which adds an audit event to the same transaction.
    assert.equal(events[0]!.type, "policy.changed");
    assert.equal(events.filter((e) => e.type === "dispatch.blocked").length, 2);
    assert.deepEqual(events.map((e) => Number(e.tx_index)), events.map((_, i) => i));
    assert.ok(events.every((e) => Number(e.tx_size) === events.length));
    assert.equal(p2.project_id.length > 0, true);
  });
});

test("H22 another project's OFF never blocks or denies this project; its own OFF does not leak back", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "h22-claim");
    const id = await do_prepare(env, "h22-prep", l, "rk-22");
    const p2 = await second_project(env);
    await set_policy(env.service, ctx_of(p2.project_id, p2.actor_id, "h22-p2-off"), { allow_opencode_go: false, reason: "합성" });
    assert.equal(check_go_allowed(env.db, p2.project_id).allowed, false);
    assert.deepEqual(check_go_allowed(env.db, env.project_id), { allowed: true });
    assert.equal(dispatch_state(env.db, id), "prepared");
    await do_authorize(env, "h22-auth", l, id);
    await do_mark_sent(env, "h22-sent", l, id);
    assert.equal(dispatch_state(env.db, id), "sent");
    // and the reverse: this project OFF leaves the other project's policy alone
    await go_off(env, "h22-off");
    assert.equal(current_policy(env.db, p2.project_id).policy_rev, 2);
    assert.equal(current_policy(env.db, env.project_id).policy_rev, 2);
  });
});

test("H23 OFF twice, then ON twice: revisions increase, nothing is blocked twice, no dispatch revives", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "h23-claim");
    const id = await do_prepare(env, "h23-prep", l, "rk-23");
    const first = await go_off(env, "h23-off-1");
    const second = await go_off(env, "h23-off-2");
    assert.deepEqual((first.result as { blocked_dispatch_ids: string[] }).blocked_dispatch_ids, [id]);
    assert.deepEqual((second.result as { blocked_dispatch_ids: string[] }).blocked_dispatch_ids, []);
    const rc2 = receipt_for(env.db, env.project_id, "h23-off-2");
    assert.ok(rc2);
    assert.deepEqual(events_of(env.db, rc2.id).map((e) => e.type), ["policy.changed"]);
    await go_on(env, "h23-on-1");
    await go_on(env, "h23-on-2");
    assert.equal(current_policy(env.db, env.project_id).policy_rev, 5);
    assert.equal(dispatch_state(env.db, id), "blocked");
    const blocked_events = env.db.all("SELECT 1 FROM events WHERE type = 'dispatch.blocked'");
    assert.equal(blocked_events.length, 1);
  });
});

test("H24 old lease / old fence cannot adopt a dispatch across OFF and ON; the new lease cannot revive a blocked one", async () => {
  await with_env(async (env) => {
    const old = await claim_go_lease(env, "h24-claim");
    const authorized = await do_prepare(env, "h24-prep", old, "rk-24");
    await do_authorize(env, "h24-auth", old, authorized);
    const surviving = await do_prepare(env, "h24-prep-2", old, "rk-24b");
    await release(env.service, env.ctx("h24-release"), guard(old));
    const fresh = await claim_go_lease(env, "h24-claim-2", old.run_id);
    assert.ok(fresh.fence > old.fence);

    // the old lease is stale for every dispatch command even though Go is ON
    await rejects_with_api_error(mark_sent(env.service, env.ctx("h24-old-sent"), { dispatch_id: authorized, ...guard(old) }), "conflict");
    await rejects_with_api_error(authorize_dispatch(env.service, env.ctx("h24-old-auth"), { dispatch_id: surviving, ...guard(old) }), "conflict");
    await rejects_with_api_error(prepare_dispatch(env.service, env.ctx("h24-old-prep"), prepare_payload(env, old, "rk-24c")), "conflict");
    // a forged fence on the current lease id is stale too
    await rejects_with_api_error(
      mark_sent(env.service, env.ctx("h24-forged"), { dispatch_id: authorized, ...guard(fresh), fence: fresh.fence + 1 }),
      "conflict",
    );
    assert.equal(dispatch_state(env.db, authorized), "authorized");

    await go_off(env, "h24-off");
    await go_on(env, "h24-on");
    for (const lease of [old, fresh]) {
      await rejects_with_api_error(mark_sent(env.service, env.ctx(`h24-sent-${lease.fence}`), { dispatch_id: authorized, ...guard(lease) }), "conflict");
      await rejects_with_api_error(authorize_dispatch(env.service, env.ctx(`h24-auth-${lease.fence}`), { dispatch_id: surviving, ...guard(lease) }), "conflict");
    }
    assert.equal(dispatch_state(env.db, authorized), "blocked");
    assert.equal(dispatch_state(env.db, surviving), "blocked");
  });
});

test("H25 a dispatch cannot be moved with another run's lease; another project's dispatch id is not_found", async () => {
  await with_env(async (env) => {
    const a = await claim_go_lease(env, "h25-claim-a");
    const id = await do_prepare(env, "h25-prep", a, "rk-25");
    await release(env.service, env.ctx("h25-release"), guard(a));
    const b = await claim_go_lease(env, "h25-claim-b");
    assert.notEqual(b.run_id, a.run_id);
    await rejects_with_api_error(authorize_dispatch(env.service, env.ctx("h25-auth"), { dispatch_id: id, ...guard(b) }), "conflict");
    assert.equal(dispatch_state(env.db, id), "prepared");

    const p2 = await second_project(env);
    const before = state_signature(env.db);
    await rejects_with_api_error(
      block_dispatch(env.service, ctx_of(p2.project_id, p2.actor_id, "h25-cross"), { dispatch_id: id, reason: "합성" }),
      "not_found",
    );
    assert.equal(state_signature(env.db).includes("h25-cross"), false);
    assert.equal(dispatch_state(env.db, id), "prepared");
    assert.equal(state_signature(env.db), before);
  });
});

test("H26 lease guard values are strictly typed: string / zero / negative / fractional / huge fences write nothing", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "h26-claim");
    const id = await do_prepare(env, "h26-prep", l, "rk-26");
    const before = state_signature(env.db);
    const fences: unknown[] = [String(l.fence), 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2, null, undefined, [l.fence], Number.NaN];
    for (const [i, fence] of fences.entries()) {
      const err = await rejects_with_api_error(
        authorize_dispatch(env.service, env.ctx(`h26-${i}`), { dispatch_id: id, run_id: l.run_id, lease_id: l.lease_id, fence }),
      );
      assert.ok(["invalid_payload", "conflict"].includes(err.code), `${i}: ${err.code}`);
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("H27 smuggled fields in dispatch payloads are rejected: state, policy_version_id, project_id, timestamps", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "h27-claim");
    const id = await do_prepare(env, "h27-prep", l, "rk-27");
    const before = state_signature(env.db);
    const extras: Array<Record<string, unknown>> = [
      { state: "sent" },
      { policy_version_id: "forged" },
      { project_id: "other" },
      { sent_at: 1 },
      { usage_json: "{}" },
      { cost_json: "{\"usd\":0}" },
    ];
    for (const [i, extra] of extras.entries()) {
      await rejects_with_api_error(
        prepare_dispatch(env.service, env.ctx(`h27-prep-${i}`), { ...prepare_payload(env, l, `rk-27-${i}`), ...extra }),
        "invalid_payload",
      );
      await rejects_with_api_error(
        authorize_dispatch(env.service, env.ctx(`h27-auth-${i}`), { dispatch_id: id, ...guard(l), ...extra }),
        "invalid_payload",
      );
      await rejects_with_api_error(
        mark_sent(env.service, env.ctx(`h27-sent-${i}`), { dispatch_id: id, ...guard(l), ...extra }),
        "invalid_payload",
      );
      await rejects_with_api_error(
        block_dispatch(env.service, env.ctx(`h27-block-${i}`), { dispatch_id: id, reason: "합성", ...extra }),
        "invalid_payload",
      );
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("H28 prepare refuses another project's manifest blob and a missing one without leaking a SQL error", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "h28-claim");
    const p2 = await second_project(env);
    env.db.run(
      `INSERT INTO blobs (id, project_id, storage_key, sha256, size, media_type, state, created_by)
       VALUES ('blob-p2', ?, 'synthetic/manifest-p2', ?, 10, 'application/json', 'ready', ?)`,
      p2.project_id,
      "f".repeat(64),
      p2.actor_id,
    );
    const before = state_signature(env.db);
    for (const blob of ["blob-p2", "no-such-blob"]) {
      const err = await rejects_with_api_error(
        prepare_dispatch(env.service, env.ctx(`h28-${blob}`), { ...prepare_payload(env, l, `rk-28-${blob}`), manifest_blob_id: blob }),
        "invalid_payload",
      );
      assert.equal(/FOREIGN KEY|constraint|SQLITE/i.test(err.message), false);
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("H29 mark_sent external_request_id is validated: blank, non-string, lone surrogate write nothing; usage and cost stay NULL", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "h29-claim");
    const id = await do_prepare(env, "h29-prep", l, "rk-29");
    await do_authorize(env, "h29-auth", l, id);
    const before = state_signature(env.db);
    for (const [i, bad] of ["", "   ", 7, {}, "\ud800"].entries()) {
      await rejects_with_api_error(
        mark_sent(env.service, env.ctx(`h29-${i}`), { dispatch_id: id, ...guard(l), external_request_id: bad }),
        "invalid_payload",
      );
    }
    assert.equal(state_signature(env.db), before);
    await mark_sent(env.service, env.ctx("h29-ok"), { dispatch_id: id, ...guard(l) });
    const row = dispatch_row(env.db, id);
    assert.equal(row.state, "sent");
    assert.equal(row.external_request_id, null);
    assert.equal(row.usage_json, null);
    assert.equal(row.cost_json, null);
    assert.equal(row.billing_source, null);
    assert.equal(row.allowance_json, null);
  });
});

// ---------------------------------------------------------------------------
// 5. Damaged policy rows

function damage(env: Env, kind: "pointer_null" | "newer_row_not_pointed" | "foreign_rev_ahead" | "dup_rev"): void {
  switch (kind) {
    case "pointer_null":
      env.db.exec("PRAGMA ignore_check_constraints = ON");
      env.db.run("UPDATE projects SET current_policy_id = NULL WHERE id = ?", env.project_id);
      return;
    case "newer_row_not_pointed":
      // a newer, OFF row exists but the pointer still names the old allowing row
      env.db.exec("PRAGMA foreign_keys = OFF");
      env.db.run(
        `INSERT INTO project_policy_versions
           (id, project_id, policy_rev, allow_opencode_go, mode_a_model, go_usage_stop_percent,
            changed_by, changed_by_user_id, changed_by_kind, reason, tx_id, created_at)
         SELECT 'forged-newer', project_id, 2, 0, mode_a_model, go_usage_stop_percent,
                changed_by, changed_by_user_id, 'human', 'forged', tx_id, created_at
           FROM project_policy_versions WHERE project_id = ?`,
        env.project_id,
      );
      return;
    case "foreign_rev_ahead":
      return;
    case "dup_rev":
      env.db.exec("PRAGMA foreign_keys = OFF");
      assert.throws(() =>
        env.db.run(
          `INSERT INTO project_policy_versions
             (id, project_id, policy_rev, allow_opencode_go, mode_a_model, go_usage_stop_percent,
              changed_by, changed_by_user_id, changed_by_kind, reason, tx_id, created_at)
           SELECT 'forged-dup', project_id, policy_rev, 1, mode_a_model, go_usage_stop_percent,
                  changed_by, changed_by_user_id, 'human', 'forged', tx_id, created_at
             FROM project_policy_versions WHERE project_id = ?`,
          env.project_id,
        ),
      );
  }
}

test("H30 a newer row that the pointer does not name makes the policy damaged (fail-closed), in both directions", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "h30-claim");
    const id = await do_prepare(env, "h30-prep", l, "rk-30");
    damage(env, "newer_row_not_pointed");
    assert.equal(check_go_allowed(env.db, env.project_id).allowed, false);
    throws_api_error(() => current_policy(env.db, env.project_id), "policy_denied");
    await rejects_with_api_error(authorize_dispatch(env.service, env.ctx("h30-auth"), { dispatch_id: id, ...guard(l) }), "policy_denied");
    await rejects_with_api_error(prepare_dispatch(env.service, env.ctx("h30-prep2"), prepare_payload(env, l, "rk-30b")), "policy_denied");
    assert.equal(dispatch_state(env.db, id), "prepared");
  });
});

test("H31 two rows with the same policy_rev cannot exist (UNIQUE), so the pointer cannot be ambiguous", async () => {
  await with_env(async (env) => {
    damage(env, "dup_rev");
    assert.deepEqual(check_go_allowed(env.db, env.project_id), { allowed: true });
    assert.equal(env.db.all("SELECT 1 FROM project_policy_versions WHERE project_id = ?", env.project_id).length, 1);
  });
});

test("H32 another project's higher revision does not affect this project's pointer check", async () => {
  await with_env(async (env) => {
    const p2 = await second_project(env);
    for (let i = 0; i < 4; i += 1) {
      await set_policy(env.service, ctx_of(p2.project_id, p2.actor_id, `h32-${i}`), { go_usage_stop_percent: 60 + i, reason: "합성" });
    }
    assert.equal(current_policy(env.db, p2.project_id).policy_rev, 5);
    assert.equal(current_policy(env.db, env.project_id).policy_rev, 1);
    assert.deepEqual(check_go_allowed(env.db, env.project_id), { allowed: true });
  });
});

test("H33 damage in one project is local: the other project still prepares, authorizes and sends", async () => {
  await with_env(async (env) => {
    const p2 = await second_project(env);
    env.db.exec("PRAGMA foreign_keys = OFF");
    env.db.exec("PRAGMA ignore_check_constraints = ON");
    env.db.run("UPDATE projects SET current_policy_id = NULL WHERE id = ?", env.project_id);
    assert.equal(check_go_allowed(env.db, env.project_id).allowed, false);
    assert.deepEqual(check_go_allowed(env.db, p2.project_id), { allowed: true });

    const claimed = await claim(env.service, ctx_of(p2.project_id, p2.actor_id, "h33-claim"), {
      mode: "A",
      runtime: "synthetic-runtime",
      provider: "opencode-go",
      model: GO_MODEL,
    });
    const l2 = claimed.result as Lease;
    env.db.run(
      `INSERT INTO blobs (id, project_id, storage_key, sha256, size, media_type, state, created_by)
       VALUES ('blob-p2', ?, 'synthetic/manifest-p2', ?, 10, 'application/json', 'ready', ?)`,
      p2.project_id,
      "f".repeat(64),
      p2.actor_id,
    );
    const c = (key: string) => ctx_of(p2.project_id, p2.actor_id, key);
    const prep = await prepare_dispatch(env.service, c("h33-prep"), {
      ...guard(l2),
      provider: "opencode-go",
      manifest_blob_id: "blob-p2",
      payload_hash: "a".repeat(64),
      request_key: "rk-33",
    });
    const id = (prep.result as { dispatch_id: string }).dispatch_id;
    await authorize_dispatch(env.service, c("h33-auth"), { dispatch_id: id, ...guard(l2) });
    await mark_sent(env.service, c("h33-sent"), { dispatch_id: id, ...guard(l2) });
    assert.equal(dispatch_state(env.db, id), "sent");
  });
});

test("H34 under a damaged policy the owner cannot be bypassed: policy.set is refused and writes nothing; an agent cannot repair it either", async () => {
  await with_env(async (env) => {
    damage(env, "pointer_null");
    const before = state_signature(env.db);
    await rejects_with_api_error(go_on(env, "h34-owner"), "policy_denied");
    await rejects_with_api_error(go_on(env, "h34-agent", env.agent_id));
    assert.equal(state_signature(env.db), before);
    assert.equal(check_go_allowed(env.db, env.project_id).allowed, false);
  });
});

test("H35 safety commands still work under a damaged policy: dispatch.block, token.revoke, token.issue", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "h35-claim");
    const id = await do_prepare(env, "h35-prep", l, "rk-35");
    const t = await issue(env, "h35-issue");
    damage(env, "pointer_null");
    await block_dispatch(env.service, env.ctx("h35-block"), { dispatch_id: id, reason: "합성: 손상 중 차단" });
    assert.equal(dispatch_state(env.db, id), "blocked");
    await revoke_agent_token(env.service, env.ctx("h35-revoke"), { token_id: t.token_id });
    throws_api_error(() => verify_agent_token(env.db, t.token, opts(env)), "forbidden");
    const u = await issue(env, "h35-issue-2");
    assert.equal(verify_agent_token(env.db, u.token, opts(env)).token_id, u.token_id);
  });
});

test("H36 a corrupted stored receipt is a closed failure, not a bypass, and stays local to its project", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "h36-claim");
    const input = prepare_payload(env, l, "rk-36");
    await prepare_dispatch(env.service, env.ctx("h36-prep"), input);
    env.db.exec("PRAGMA ignore_check_constraints = ON");
    env.db.run(
      "UPDATE mutation_commits SET result_json = '{not json' WHERE project_id = ? AND client_request_id = 'h36-prep'",
      env.project_id,
    );
    const before = state_signature(env.db);
    const err = await prepare_dispatch(env.service, env.ctx("h36-prep"), input).then(
      () => assert.fail("a corrupted receipt must not replay"),
      (e: unknown) => e,
    );
    assert.ok(err instanceof Error);
    assert.equal(state_signature(env.db), before, "nothing is written while failing");
    assert.equal(env.db.all("SELECT 1 FROM outbound_dispatches").length, 1, "no second dispatch was created");
    // a different key still works for new work in the same project
    const other = await prepare_dispatch(env.service, env.ctx("h36-prep-2"), prepare_payload(env, l, "rk-36b"));
    assert.equal(other.replayed, false);
  });
});

// ---------------------------------------------------------------------------
// 6. Policy before replay, rollback and replay of every new command

test("H37 a request that succeeded while Go was ON is denied (not replayed) after OFF, for all three gated commands, and after damage", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "h37-claim");
    const prep = prepare_payload(env, l, "rk-37");
    const first = await prepare_dispatch(env.service, env.ctx("h37-prep"), prep);
    const id = (first.result as { dispatch_id: string }).dispatch_id;
    const auth = { dispatch_id: id, ...guard(l) };
    await authorize_dispatch(env.service, env.ctx("h37-auth"), auth);
    const sent = { dispatch_id: id, ...guard(l), external_request_id: "ext-37" };
    await mark_sent(env.service, env.ctx("h37-sent"), sent);

    await go_off(env, "h37-off");
    const before = state_signature(env.db);
    await rejects_with_api_error(prepare_dispatch(env.service, env.ctx("h37-prep"), prep), "policy_denied");
    await rejects_with_api_error(authorize_dispatch(env.service, env.ctx("h37-auth"), auth), "policy_denied");
    await rejects_with_api_error(mark_sent(env.service, env.ctx("h37-sent"), sent), "policy_denied");
    assert.equal(state_signature(env.db), before);

    // ON again: replays work again and still return the original results
    await go_on(env, "h37-on");
    const replay = await mark_sent(env.service, env.ctx("h37-sent"), sent);
    assert.equal(replay.replayed, true);

    // damaged: denied again
    damage(env, "pointer_null");
    await rejects_with_api_error(mark_sent(env.service, env.ctx("h37-sent"), sent), "policy_denied");
  });
});

test("H38 an ungated command's replay is not blocked by OFF, and the OFF request itself replays after later ON", async () => {
  await with_env(async (env) => {
    const t = await issue_agent_token(env.service, env.ctx("h38-issue"), { actor_id: env.agent_id, scopes: ["run"] });
    const off = await go_off(env, "h38-off");
    const issue_again = await issue_agent_token(env.service, env.ctx("h38-issue"), { actor_id: env.agent_id, scopes: ["run"] });
    assert.equal(issue_again.replayed, true);
    assert.equal((issue_again.result as Partial<Issued>).token, undefined);
    assert.equal((issue_again.result as Issued).token_id, (t.result as Issued).token_id);
    await go_on(env, "h38-on");
    const off_again = await go_off(env, "h38-off");
    assert.equal(off_again.replayed, true, "the stored OFF result is returned; the policy is not turned off again");
    assert.deepEqual(off_again.result, off.result);
    assert.equal(current_policy(env.db, env.project_id).allow_opencode_go, true, "replaying OFF did not change the live policy");
    assert.equal(current_policy(env.db, env.project_id).policy_rev, 3);
  });
});

interface Step {
  name: string;
  command: string;
  payload(env: Env, w: World): unknown;
  actor?: (env: Env) => string;
  prepare?(env: Env, w: World): Promise<void>;
}

interface World {
  lease: Lease;
  dispatch_prepared: string;
  dispatch_authorized: string;
  token_id: string;
}

async function build_world(env: Env): Promise<World> {
  const lease = await claim_go_lease(env, "w-claim");
  const dispatch_prepared = await do_prepare(env, "w-prep-1", lease, "rk-w1");
  const dispatch_authorized = await do_prepare(env, "w-prep-2", lease, "rk-w2");
  await do_authorize(env, "w-auth-2", lease, dispatch_authorized);
  const t = await issue(env, "w-issue-seed");
  return { lease, dispatch_prepared, dispatch_authorized, token_id: t.token_id };
}

const STEPS: Step[] = [
  { name: "token.issue", command: "token.issue", payload: (env) => ({ actor_id: env.agent_id, scopes: ["run"] }) },
  { name: "token.revoke", command: "token.revoke", payload: (_env, w) => ({ token_id: w.token_id }) },
  {
    name: "policy.set (OFF with blocked dispatches)",
    command: "policy.set",
    payload: () => ({ allow_opencode_go: false, reason: "합성" }),
  },
  {
    name: "dispatch.prepare",
    command: "dispatch.prepare",
    payload: (env, w) => prepare_payload(env, w.lease, "rk-step-new"),
  },
  {
    name: "dispatch.authorize",
    command: "dispatch.authorize",
    payload: (_env, w) => ({ dispatch_id: w.dispatch_prepared, ...guard(w.lease) }),
  },
  {
    name: "dispatch.mark_sent",
    command: "dispatch.mark_sent",
    payload: (_env, w) => ({ dispatch_id: w.dispatch_authorized, ...guard(w.lease), external_request_id: "ext-step" }),
  },
  {
    name: "dispatch.block",
    command: "dispatch.block",
    payload: (_env, w) => ({ dispatch_id: w.dispatch_prepared, reason: "합성" }),
  },
];

for (const step of STEPS) {
  test(`H39 ${step.name}: a failure after its writes rolls everything back; the same key then succeeds once and replays exactly`, async () => {
    await with_env(async (env) => {
      const w = await build_world(env);
      const payload = step.payload(env, w);
      const key = "h39-key";

      // fail at the very end of the transaction (events), after the change and the receipt were written
      const failing = wrap_db(env.db, (sql) => {
        if (sql.includes("INSERT INTO events")) throw new Error("boom-late");
      });
      const before = state_signature(env.db);
      const err = await service_over(env, failing)
        .execute(env.ctx(key), step.command, payload)
        .then(
          () => assert.fail("expected a rollback"),
          (e: unknown) => e,
        );
      assert_clean(error_texts(err), [], step.name);
      assert.equal(state_signature(env.db), before, "nothing survives the rollback (rows, receipt, events, pointer)");
      assert.equal(receipt_for(env.db, env.project_id, key), undefined);

      // the key is still free: first run is fresh, second is a replay with no new rows
      const first = await env.service.execute(env.ctx(key), step.command, payload);
      assert.equal(first.replayed, false);
      const after_first = state_signature(env.db);
      const counts = table_counts(env.db);
      const second = await env.service.execute(env.ctx(key), step.command, payload);
      assert.equal(second.replayed, true);
      assert.equal(state_signature(env.db), after_first, "a replay writes nothing");
      assert.deepEqual(table_counts(env.db), counts);
      const stored = JSON.stringify(first.result);
      if (step.command === "token.issue") {
        const { token: _token, ...rest } = first.result as Record<string, unknown>;
        assert.deepEqual(second.result, rest, "replay returns the stored result minus the secret");
        assert.equal(TOKEN_SHAPE.test(JSON.stringify(second.result)), false);
      } else {
        assert.equal(JSON.stringify(second.result), stored, "replay returns the same result");
      }
      // the same key with a different payload is a key-reuse error and writes nothing
      await rejects_with_api_error(
        env.service.execute(env.ctx(key), step.command, { ...(payload as Record<string, unknown>), reason: "다른 요청", extra_probe: 1 }),
      );
      assert.equal(state_signature(env.db), after_first);
    });
  });
}

test("H40 a partial failure while blocking the second of several dispatches rolls back the policy row, the pointer and the first block", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "h40-claim");
    const a = await do_prepare(env, "h40-prep-a", l, "rk-40a");
    const b = await do_prepare(env, "h40-prep-b", l, "rk-40b");
    await do_authorize(env, "h40-auth-b", l, b);
    let blocks = 0;
    const failing = wrap_db(env.db, (sql) => {
      if (sql.includes("UPDATE outbound_dispatches SET state = 'blocked'")) {
        blocks += 1;
        if (blocks === 2) throw new Error("boom-second-block");
      }
    });
    const before = state_signature(env.db);
    await service_over(env, failing)
      .execute(env.ctx("h40-off"), "policy.set", { allow_opencode_go: false, reason: "합성" })
      .then(
        () => assert.fail("expected a rollback"),
        () => undefined,
      );
    assert.equal(blocks, 2);
    assert.equal(state_signature(env.db), before);
    assert.equal(current_policy(env.db, env.project_id).allow_opencode_go, true);
    assert.equal(dispatch_state(env.db, a), "prepared");
    assert.equal(dispatch_state(env.db, b), "authorized");
    // after the failure the OFF still works as a whole
    const ok = await go_off(env, "h40-off");
    assert.equal((ok.result as { blocked_dispatch_ids: string[] }).blocked_dispatch_ids.length, 2);
  });
});

test("H41 new commands never touch control_rev or the project rows other than the policy pointer", async () => {
  await with_env(async (env) => {
    const rev = () =>
      env.db.get<{ control_rev: bigint; topic: string; status: string; active_edition_id: string | null }>(
        "SELECT control_rev, topic, status, active_edition_id FROM projects WHERE id = ?",
        env.project_id,
      );
    const before = { ...rev()! };
    const l = await claim_go_lease(env, "h41-claim");
    const id = await do_prepare(env, "h41-prep", l, "rk-41");
    await do_authorize(env, "h41-auth", l, id);
    await do_mark_sent(env, "h41-sent", l, id);
    const t = await issue(env, "h41-issue");
    await revoke_agent_token(env.service, env.ctx("h41-revoke"), { token_id: t.token_id });
    await go_off(env, "h41-off");
    await go_on(env, "h41-on");
    const after = { ...rev()! };
    // claim bumps nothing rev-bearing in these tests' sense; the point is that policy/dispatch/token
    // commands add no control_rev movement of their own, topic or status changes.
    assert.equal(after.topic, before.topic);
    assert.equal(after.status, before.status);
    assert.equal(after.active_edition_id, before.active_edition_id);
    assert.equal(after.control_rev, before.control_rev);
  });
});

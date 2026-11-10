// SEL-43 (stage 2 PR10): actors, agent tokens, and outbound (OpenCode Go) policy.
// Written before the implementation; the worker matches these names and shapes.
//
// Files (leader decision; the tests only import the public modules):
//   scripts/pes_core/actors.ts   public wrappers + read-only functions (no SQL writes)
//   scripts/pes_core/policy.ts   public wrappers + read-only functions + DbPolicyChecker (no SQL writes)
//   scripts/pes_core/commands/actors.ts   token.* command definitions (frozen entry array)
//   scripts/pes_core/commands/policy.ts   policy.* and dispatch.* definitions (frozen entry array)
//   (the worker may merge the two command files; the static write check is by folder)
//
// Commands (all scope "project", rev_bearing false, registered in COMMANDS):
//   command             action (receipt + event type)
//   token.issue         token.issued
//   token.revoke        token.revoked
//   policy.set          policy.changed
//   dispatch.prepare    dispatch.prepared
//   dispatch.authorize  dispatch.authorized
//   dispatch.mark_sent  dispatch.sent
//   dispatch.block      dispatch.blocked
//
// Public write functions: fn(service, ctx, input) -> Promise<CommandOutcome>, exactly one
// service.execute each (like scripts/pes_core/runs.ts):
//   issue_agent_token (token.issue) / revoke_agent_token (token.revoke)            [actors.ts]
//   set_policy / prepare_dispatch / authorize_dispatch / mark_sent / block_dispatch [policy.ts]
//
// token.issue   owner-only. payload {actor_id, scopes?: string[]} (default []). The target actor
//               must exist, be an agent kind (not "human"), and not be disabled.
//               result {project_id, token_id, actor_id, scopes, expires_at, token}. `token` is the
//               raw secret (a string of at least 32 characters). It appears ONLY in the first
//               response: the receipt result_json, events, errors and every table hold only a hash
//               (agent_tokens.token_hash, at least 32 characters, never the raw text). A replay of
//               the same key returns the stored result WITHOUT `token`. expires_at =
//               created_at + 30 days (exactly 2_592_000_000 ms). Token scope = ctx.project_id.
// token.revoke  owner-only. payload {token_id}. Sets revoked_at = now; the row is kept.
//               Unknown token_id (or a token of another project) -> ApiError not_found.
// policy.set    owner-only (human actor, project_members role "owner"). payload {reason, and at least
//               one of allow_opencode_go (boolean), go_usage_stop_percent (integer 50..100),
//               mode_a_model (string starting "opencode-go/")}. Appends a project_policy_versions
//               row (policy_rev + 1, unspecified fields copied from the current row, tx_id = the
//               receipt id, changed_by = the owner actor, changed_by_kind "human") and moves
//               projects.current_policy_id. Old policy rows are never changed. When the new row has
//               allow_opencode_go = 0, the SAME tx marks every dispatch of the project whose state
//               is "prepared" or "authorized" as "blocked" and writes one "dispatch.blocked" event
//               each after the "policy.changed" event. Dispatches in sent / response / adopted /
//               failed / unknown / blocked are untouched (never deleted, never edited).
//               Re-allowing (allow_opencode_go true) never revives a blocked dispatch.
//               result {project_id, policy_id, policy_rev, allow_opencode_go, blocked_dispatch_ids}.
// dispatch.*    carry the lease guard {run_id, lease_id, fence} like the run commands (a stale
//               fence, a released lease or an expired lease -> ApiError "conflict", nothing written)
//               except dispatch.block (no guard). Receipts of guarded dispatch commands carry
//               run_id, lease_id and fence; events carry run_id.
//   dispatch.prepare   payload {run_id, lease_id, fence, provider: "opencode-go", manifest_blob_id,
//                      payload_hash (64 hex), request_key}. A provider other than "opencode-go" or a
//                      malformed payload_hash -> invalid_payload (never a raw CHECK error). A reused
//                      (run_id, request_key) -> ApiError conflict. Row state "prepared",
//                      policy_version_id = the current policy id. result {project_id, dispatch_id,
//                      state: "prepared", policy_version_id}.
//   dispatch.authorize payload {dispatch_id, run_id, lease_id, fence}: prepared -> authorized,
//                      authorized_at = now. Any other state -> conflict.
//   dispatch.mark_sent payload {dispatch_id, run_id, lease_id, fence, external_request_id?}:
//                      authorized -> sent, sent_at = now. Usage and cost stay NULL (unknown costs are
//                      never stored as 0).
//   dispatch.block     payload {dispatch_id, reason}: prepared | authorized -> blocked. sent /
//                      response / adopted / unknown / blocked -> conflict. Allowed while Go is OFF.
//   Gating: while Go is OFF (or the policy is damaged), dispatch.prepare / authorize / mark_sent
//   are denied with ApiError "policy_denied". Every other command (including policy.set,
//   dispatch.block, token.*, project.*, run.*) is NOT gated by Go.
//
// Read-only functions (no write, even on failure):
//   resolve_actor(db, {project_id, actor_id?, token?}, now_ms)
//       exactly one of actor_id / token (else invalid_payload). Returns
//       {actor_id, kind, user_id, membership_role, token_id}; token_id is null for actor_id.
//       Unknown / disabled actor, non-member, bad / expired / revoked / other-project token -> forbidden.
//   require_human_owner(resolved) -> resolved; ApiError forbidden unless kind === "human" AND
//       membership_role === "owner". An agent that shares the owner's user_id is still refused.
//   verify_agent_token(db, token, {project_id, now_ms}) -> {token_id, actor_id, project_id, scopes}
//       Any failure (unknown, malformed, revoked, expired, wrong project, disabled actor, broken
//       scopes JSON) -> ApiError forbidden whose message and details never contain the token text.
//       A token is expired when now_ms >= expires_at.
//   current_policy(db, project_id) -> {policy_id, project_id, policy_rev, allow_opencode_go: boolean,
//       mode_a_model, go_usage_stop_percent}. Unknown project -> not_found. Damaged policy -> ApiError
//       "policy_denied".
//   check_go_allowed(db, project_id) -> {allowed: true} | {allowed: false, reason: string}. Never throws
//       for a damaged policy; it fails closed.
//   DbPolicyChecker (implements PolicyChecker). PolicyChecker.check gets a 4th argument: a
//       read-only db handle (get / all only; no run / exec) in the SAME tx.
//       `new DbPolicyChecker()`; install with new CommandService(db, {clock, policy, run_config}).
//
// Fail-closed policy rows (any of these -> not allowed, no bypass): the project pointer is NULL or
// points at a missing row or at another project's row; the pointer is not the highest policy_rev of
// the project; allow_opencode_go is not exactly 0 or 1; mode_a_model does not start "opencode-go/";
// go_usage_stop_percent outside 50..100; changed_by_kind is not "human"; no policy row at all.
// Defaults (stage-0 7-1): policy_rev 1, allow ON, mode_a_model "opencode-go/deepseek-v4.1-flash",
// go_usage_stop_percent 90.
//
// No real Go network call: the tests use a FakeGoTransport that is only reached after
// dispatch.mark_sent succeeds. Everything here is synthetic.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FakeClock } from "../scripts/pes_core/clock.ts";
import { connect, migrate, type Db, type RunResult, type SqlValue } from "../scripts/pes_core/db.ts";
import { ApiError } from "../scripts/pes_core/errors.ts";
import {
  COMMANDS,
  CommandService,
  type MutationContext,
  type PolicyChecker,
} from "../scripts/pes_core/commands.ts";
import type { RunConfig } from "../scripts/pes_core/config.ts";
import { claim, release } from "../scripts/pes_core/runs.ts";
import {
  issue_agent_token,
  require_human_owner,
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
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "..", "scripts", "pes_core");
const GO_MODEL = "opencode-go/deepseek-v4.1-flash";

const NEW_COMMANDS: Record<string, string> = {
  "token.issue": "token.issued",
  "token.revoke": "token.revoked",
  "policy.set": "policy.changed",
  "dispatch.prepare": "dispatch.prepared",
  "dispatch.authorize": "dispatch.authorized",
  "dispatch.mark_sent": "dispatch.sent",
  "dispatch.block": "dispatch.blocked",
};

// ---------------------------------------------------------------------------
// Harness

class FakeGoTransport {
  sent: string[] = [];
  send(dispatch_id: string): void {
    this.sent.push(dispatch_id);
  }
}

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
  with_db(db: Db): CommandService;
  close(): void;
}

async function make_env(): Promise<Env> {
  const home = isolated_home("pes-sel43-");
  const db = connect(db_path(home.env));
  migrate(db);
  const clock = new FakeClock(START_MS);
  const service = new CommandService(db, { clock, policy: new DbPolicyChecker(), run_config: TEST_CONFIG });
  const out = await service.execute(
    { project_id: null, actor_id: null, via: "cli", client_request_id: "setup-p" },
    "project.bootstrap",
    { slug: "synthetic-policy", topic: "합성 정책 주제", owner_display_name: "합성 소유자" },
  );
  const r = out.result as { project_id: string; owner_actor_id: string; owner_user_id: string };
  // A synthetic agent actor acting on behalf of the owner's user (so the service scope check
  // passes); kind external_agent. It must still never count as a human owner.
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
    with_db: (wrapped) =>
      new CommandService(wrapped, { clock, policy: new DbPolicyChecker(), run_config: TEST_CONFIG }),
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

/** True when `needle` appears in any text or blob value of any table (not just JSON-escaped). */
function db_contains(db: Db, needle: string): boolean {
  const tables = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .map((row) => row.name);
  for (const table of tables) {
    for (const row of db.all<Record<string, unknown>>(`SELECT * FROM "${table}"`)) {
      for (const value of Object.values(row)) {
        if (typeof value === "string" && value.includes(needle)) return true;
        if (value instanceof Uint8Array && Buffer.from(value).includes(needle)) return true;
      }
    }
  }
  return false;
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
  const r = out.result as { dispatch_id: string; state: string };
  assert.equal(r.state, "prepared");
  return r.dispatch_id;
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
  return set_policy(env.service, env.ctx(key, actor_id), { allow_opencode_go: true, reason: "합성: Go 다시 켬" });
}

interface DispatchRow {
  id: string;
  state: string;
  policy_version_id: string;
  authorized_at: bigint | null;
  sent_at: bigint | null;
  external_request_id: string | null;
  usage_json: string | null;
  cost_json: string | null;
  unknown_at: bigint | null;
  unknown_reason: string | null;
  run_id: string;
  request_key: string;
}

function dispatch_row(db: Db, id: string): DispatchRow {
  const row = db.get<DispatchRow>("SELECT * FROM outbound_dispatches WHERE id = ?", id);
  assert.ok(row, `dispatch ${id} exists`);
  return row;
}

function dispatch_signature(db: Db, id: string): string {
  return JSON.stringify(dispatch_row(db, id), (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
}

function receipt_for(db: Db, project_id: string, key: string) {
  return db.get<{
    id: string;
    action: string;
    run_id: string | null;
    lease_id: string | null;
    fence: bigint | null;
    actor_id: string;
    result_json: string;
    request_hash: string;
  }>(
    `SELECT id, action, run_id, lease_id, fence, actor_id, result_json, request_hash
     FROM mutation_commits WHERE project_id = ? AND client_request_id = ?`,
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

function policy_row_of_project(db: Db, project_id: string) {
  const row = db.get<{
    id: string;
    policy_rev: bigint;
    allow_opencode_go: bigint;
    mode_a_model: string;
    go_usage_stop_percent: bigint;
    changed_by: string;
    changed_by_kind: string;
    reason: string;
    tx_id: string;
    created_at: bigint;
  }>(
    `SELECT v.* FROM project_policy_versions v
     JOIN projects p ON p.current_policy_id = v.id AND p.id = v.project_id WHERE p.id = ?`,
    project_id,
  );
  assert.ok(row, "the project has a current policy row");
  return row;
}

async function second_project(env: Env): Promise<{ project_id: string; actor_id: string }> {
  const out = await env.service.execute(
    { project_id: null, actor_id: null, via: "cli", client_request_id: "setup-p2" },
    "project.bootstrap",
    { slug: "synthetic-policy-2", topic: "두 번째 합성 주제", owner_display_name: "합성 소유자 2" },
  );
  const r = out.result as { project_id: string; owner_actor_id: string };
  return { project_id: r.project_id, actor_id: r.owner_actor_id };
}

/** A second human member of the project with role editor (never an owner). */
function add_editor(env: Env): string {
  env.db.run("INSERT INTO users (id, display_name, created_at) VALUES ('user-editor', '합성 편집자', 0)");
  env.db.run("INSERT INTO actors (id, kind, user_id, display_name) VALUES ('actor-editor', 'human', 'user-editor', '합성 편집자')");
  env.db.run(
    "INSERT INTO project_members (project_id, user_id, role) VALUES (?, 'user-editor', 'editor')",
    env.project_id,
  );
  return "actor-editor";
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
  const out = await issue_agent_token(env.service, env.ctx(key), {
    actor_id: actor_id ?? env.agent_id,
    scopes,
  });
  assert.equal(out.replayed, false);
  return out.result as Issued;
}

// ---------------------------------------------------------------------------
// Registry

test("the seven new commands are registered, project-scoped, not rev-bearing, with distinct actions", () => {
  const actions = new Set<string>();
  for (const [name, action] of Object.entries(NEW_COMMANDS)) {
    const def = COMMANDS.get(name);
    assert.ok(def, `${name} is registered`);
    assert.equal(def.scope, "project");
    assert.equal(def.rev_bearing, false);
    assert.equal(def.action, action);
    actions.add(def.action);
  }
  assert.equal(actions.size, Object.keys(NEW_COMMANDS).length);
});

test("actors.ts and policy.ts are write-free: the SQL writes live under commands/", () => {
  const write =
    /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?\s+["`[]?\w+["`\]]?\s+SET|DELETE\s+FROM)\b/i;
  for (const file of ["actors.ts", "policy.ts"]) {
    const text = readFileSync(join(CORE_DIR, file), "utf8");
    assert.equal(write.test(text), false, `${file} must not contain SQL writes`);
  }
});

test("public wrappers each run one command (receipt action proves the mapping)", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "w-claim");
    const t = await issue_agent_token(env.service, env.ctx("w-issue"), { actor_id: env.agent_id, scopes: ["run"] });
    await revoke_agent_token(env.service, env.ctx("w-revoke"), { token_id: (t.result as Issued).token_id });
    await set_policy(env.service, env.ctx("w-policy"), { go_usage_stop_percent: 80, reason: "합성" });
    const id = await do_prepare(env, "w-prepare", l, "rk-w1");
    await do_authorize(env, "w-authorize", l, id);
    await do_mark_sent(env, "w-sent", l, id);
    const id2 = await do_prepare(env, "w-prepare2", l, "rk-w2");
    await block_dispatch(env.service, env.ctx("w-block"), { dispatch_id: id2, reason: "합성" });
    const expect: Array<[string, string]> = [
      ["w-issue", "token.issued"],
      ["w-revoke", "token.revoked"],
      ["w-policy", "policy.changed"],
      ["w-prepare", "dispatch.prepared"],
      ["w-authorize", "dispatch.authorized"],
      ["w-sent", "dispatch.sent"],
      ["w-block", "dispatch.blocked"],
    ];
    for (const [key, action] of expect) {
      assert.equal(receipt_for(env.db, env.project_id, key)?.action, action, key);
    }
  });
});

test("the policy checker gets a read-only db handle (4th argument) and runs inside the command", async () => {
  await with_env(async (env) => {
    const seen: { had_db: boolean; read_ok: boolean; wrote: boolean }[] = [];
    class Spy implements PolicyChecker {
      check(ctx: MutationContext, _command: string, _payload: unknown, db: Pick<Db, "get" | "all">) {
        const handle = db as unknown as Record<string, unknown>;
        let read_ok = false;
        let wrote = false;
        if (ctx.project_id !== null) {
          read_ok = db.get("SELECT id FROM projects WHERE id = ?", ctx.project_id) !== undefined;
          try {
            if (typeof handle.run === "function") {
              (handle.run as (sql: string) => unknown)("UPDATE projects SET topic = 'hijack'");
              wrote = true;
            }
          } catch {
            wrote = false;
          }
        }
        seen.push({ had_db: typeof db?.get === "function" && typeof db?.all === "function", read_ok, wrote });
        return { allowed: true } as const;
      }
    }
    const service = new CommandService(env.db, { clock: env.clock, policy: new Spy(), run_config: TEST_CONFIG });
    await service.execute(env.ctx("spy-1"), "policy.set", { go_usage_stop_percent: 70, reason: "합성" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.had_db, true);
    assert.equal(seen[0]!.read_ok, true);
    assert.equal(seen[0]!.wrote, false, "the checker handle cannot write");
    const topic = env.db.get<{ topic: string }>("SELECT topic FROM projects WHERE id = ?", env.project_id);
    assert.equal(topic?.topic, "합성 정책 주제");
  });
});

// ---------------------------------------------------------------------------
// 1. Tokens

test("issue_agent_token: the raw token is in the response once; only a hash is stored", async () => {
  await with_env(async (env) => {
    const t = await issue(env, "t-issue");
    assert.equal(typeof t.token, "string");
    assert.ok(t.token.length >= 32);
    assert.equal(t.actor_id, env.agent_id);
    assert.equal(t.project_id, env.project_id);
    assert.deepEqual(t.scopes, ["run"]);
    assert.equal(t.expires_at, START_MS + TOKEN_TTL_MS);

    const row = env.db.get<{
      project_id: string;
      actor_id: string;
      scopes: string;
      token_hash: string;
      created_at: bigint;
      expires_at: bigint;
      revoked_at: bigint | null;
    }>("SELECT * FROM agent_tokens WHERE id = ?", t.token_id);
    assert.ok(row);
    assert.equal(row.project_id, env.project_id);
    assert.equal(row.actor_id, env.agent_id);
    assert.deepEqual(JSON.parse(row.scopes), ["run"]);
    assert.ok(row.token_hash.length >= 32);
    assert.notEqual(row.token_hash, t.token);
    assert.equal(row.created_at, BigInt(START_MS));
    assert.equal(row.expires_at, BigInt(START_MS + TOKEN_TTL_MS));
    assert.equal(row.revoked_at, null);

    assert.equal(db_contains(env.db, t.token), false, "no table holds the raw token");
    const rc = receipt_for(env.db, env.project_id, "t-issue");
    assert.ok(rc);
    assert.equal(rc.action, "token.issued");
    assert.equal(rc.result_json.includes(t.token), false);
    assert.equal(rc.request_hash.includes(t.token), false);
    const events = events_of(env.db, rc.id);
    assert.deepEqual(events.map((e) => e.type), ["token.issued"]);
    assert.equal(events[0]!.payload.includes(t.token), false);
    assert.ok(events[0]!.payload.includes(t.token_id), "the event names the token by id");
  });
});

test("two issued tokens differ and each verifies only itself", async () => {
  await with_env(async (env) => {
    const a = await issue(env, "t-a");
    const b = await issue(env, "t-b", ["content"]);
    assert.notEqual(a.token, b.token);
    assert.notEqual(a.token_id, b.token_id);
    const opts = { project_id: env.project_id, now_ms: env.clock.now_ms() };
    assert.equal(verify_agent_token(env.db, a.token, opts).token_id, a.token_id);
    assert.deepEqual(verify_agent_token(env.db, b.token, opts).scopes, ["content"]);
    throws_api_error(() => verify_agent_token(env.db, `${a.token}x`, opts), "forbidden");
    throws_api_error(() => verify_agent_token(env.db, a.token.slice(0, -1), opts), "forbidden");
  });
});

test("replaying token.issue with the same key returns the stored result without the raw token", async () => {
  await with_env(async (env) => {
    const input = { actor_id: env.agent_id, scopes: ["run"] };
    const first = await issue_agent_token(env.service, env.ctx("t-replay"), input);
    const first_result = first.result as Issued;
    const before = table_counts(env.db);
    const again = await issue_agent_token(env.service, env.ctx("t-replay"), input);
    assert.equal(again.replayed, true);
    const replay_result = again.result as Partial<Issued>;
    assert.equal(replay_result.token_id, first_result.token_id);
    assert.equal(replay_result.token, undefined, "the secret is never replayed");
    assert.deepEqual(table_counts(env.db), before);
    await rejects_with_api_error(
      issue_agent_token(env.service, env.ctx("t-replay"), { actor_id: env.agent_id, scopes: ["content"] }),
      "idempotency_key_reuse",
    );
    assert.equal(db_contains(env.db, first_result.token), false);
  });
});

test("verify_agent_token: range is the project; a token for another project is refused", async () => {
  await with_env(async (env) => {
    const t = await issue(env, "t-scope");
    const p2 = await second_project(env);
    const now_ms = env.clock.now_ms();
    assert.equal(verify_agent_token(env.db, t.token, { project_id: env.project_id, now_ms }).actor_id, env.agent_id);
    const err = throws_api_error(
      () => verify_agent_token(env.db, t.token, { project_id: p2.project_id, now_ms }),
      "forbidden",
    );
    assert.equal(err.message.includes(t.token), false);
    assert.equal(JSON.stringify(err.details ?? null).includes(t.token), false);
    // And resolve_actor with that token for the other project is refused too.
    throws_api_error(() => resolve_actor(env.db, { project_id: p2.project_id, token: t.token }, now_ms), "forbidden");
  });
});

test("verify_agent_token: 30 days exactly, boundary included (expired when now >= expires_at)", async () => {
  await with_env(async (env) => {
    const t = await issue(env, "t-expiry");
    const opts = (now_ms: number) => ({ project_id: env.project_id, now_ms });
    assert.equal(verify_agent_token(env.db, t.token, opts(START_MS)).token_id, t.token_id);
    assert.equal(verify_agent_token(env.db, t.token, opts(START_MS + TOKEN_TTL_MS - 1)).token_id, t.token_id);
    throws_api_error(() => verify_agent_token(env.db, t.token, opts(START_MS + TOKEN_TTL_MS)), "forbidden");
    throws_api_error(() => verify_agent_token(env.db, t.token, opts(START_MS + TOKEN_TTL_MS + 1)), "forbidden");
    throws_api_error(() => verify_agent_token(env.db, t.token, opts(START_MS + 365 * DAY_MS)), "forbidden");
  });
});

test("an expired token stays expired: a later clock never revives it and nothing is deleted", async () => {
  await with_env(async (env) => {
    const t = await issue(env, "t-expiry2");
    env.clock.advance(TOKEN_TTL_MS);
    throws_api_error(
      () => verify_agent_token(env.db, t.token, { project_id: env.project_id, now_ms: env.clock.now_ms() }),
      "forbidden",
    );
    assert.equal(env.db.get("SELECT 1 FROM agent_tokens WHERE id = ?", t.token_id) !== undefined, true);
  });
});

test("revoke_agent_token: the token is refused afterwards, the row is kept, other tokens still work", async () => {
  await with_env(async (env) => {
    const a = await issue(env, "t-rev-a");
    const b = await issue(env, "t-rev-b");
    env.clock.advance(1_000);
    const out = await revoke_agent_token(env.service, env.ctx("t-revoke"), { token_id: a.token_id });
    assert.equal(out.replayed, false);
    const row = env.db.get<{ revoked_at: bigint | null; token_hash: string }>(
      "SELECT revoked_at, token_hash FROM agent_tokens WHERE id = ?",
      a.token_id,
    );
    assert.equal(row?.revoked_at, BigInt(START_MS + 1_000));
    assert.ok(row && row.token_hash.length >= 32);
    const opts = { project_id: env.project_id, now_ms: env.clock.now_ms() };
    const err = throws_api_error(() => verify_agent_token(env.db, a.token, opts), "forbidden");
    assert.equal(err.message.includes(a.token), false);
    assert.equal(verify_agent_token(env.db, b.token, opts).token_id, b.token_id);
    const rc = receipt_for(env.db, env.project_id, "t-revoke");
    assert.ok(rc);
    assert.equal(rc.action, "token.revoked");
    assert.deepEqual(events_of(env.db, rc.id).map((e) => e.type), ["token.revoked"]);
  });
});

test("revoking an unknown token or a token of another project is not_found and writes nothing", async () => {
  await with_env(async (env) => {
    const p2 = await second_project(env);
    const t = await issue(env, "t-rev-x");
    const before = state_signature(env.db);
    await rejects_with_api_error(
      revoke_agent_token(env.service, env.ctx("t-rev-missing"), { token_id: "no-such-token" }),
      "not_found",
    );
    await rejects_with_api_error(
      revoke_agent_token(
        env.service,
        { project_id: p2.project_id, actor_id: p2.actor_id, via: "cli", client_request_id: "t-rev-cross" },
        { token_id: t.token_id },
      ),
      "not_found",
    );
    assert.equal(state_signature(env.db), before);
    assert.equal(
      env.db.get<{ revoked_at: bigint | null }>("SELECT revoked_at FROM agent_tokens WHERE id = ?", t.token_id)
        ?.revoked_at,
      null,
    );
  });
});

test("verify_agent_token refuses garbage and never echoes the presented text; it never writes", async () => {
  await with_env(async (env) => {
    const t = await issue(env, "t-garbage");
    const before = state_signature(env.db);
    const opts = { project_id: env.project_id, now_ms: env.clock.now_ms() };
    for (const bad of ["", "   ", "pes_garbage_token_value_0123456789abcdef", "x".repeat(10_000), null, undefined, 42, {}, []]) {
      const err = throws_api_error(() => verify_agent_token(env.db, bad as unknown as string, opts), "forbidden");
      if (typeof bad === "string" && bad.length > 0) {
        assert.equal(err.message.includes(bad), false);
        assert.equal(JSON.stringify(err.details ?? null).includes(bad), false);
      }
    }
    // success path is read-only too
    verify_agent_token(env.db, t.token, opts);
    assert.equal(state_signature(env.db), before);
  });
});

test("a token of a disabled agent actor is refused", async () => {
  await with_env(async (env) => {
    const t = await issue(env, "t-disabled");
    env.db.run("UPDATE actors SET disabled_at = ? WHERE id = ?", BigInt(START_MS), env.agent_id);
    throws_api_error(
      () => verify_agent_token(env.db, t.token, { project_id: env.project_id, now_ms: env.clock.now_ms() }),
      "forbidden",
    );
  });
});

test("a token row with broken scopes JSON fails closed instead of granting or crashing", async () => {
  await with_env(async (env) => {
    const a = await issue(env, "t-bad-json-a");
    const b = await issue(env, "t-bad-json-b");
    env.db.exec("PRAGMA ignore_check_constraints = ON");
    env.db.run("UPDATE agent_tokens SET scopes = '{not json' WHERE id = ?", a.token_id);
    env.db.run("UPDATE agent_tokens SET scopes = '{\"run\":true}' WHERE id = ?", b.token_id);
    const opts = { project_id: env.project_id, now_ms: env.clock.now_ms() };
    throws_api_error(() => verify_agent_token(env.db, a.token, opts), "forbidden");
    throws_api_error(() => verify_agent_token(env.db, b.token, opts), "forbidden");
  });
});

test("token.issue input is validated before any CHECK/FK error can leak", async () => {
  await with_env(async (env) => {
    const bad: unknown[] = [
      { actor_id: env.owner_actor_id, scopes: [] }, // a human actor gets no agent token
      { actor_id: "", scopes: [] },
      { scopes: ["run"] },
      { actor_id: env.agent_id, scopes: "run" },
      { actor_id: env.agent_id, scopes: [1] },
      { actor_id: env.agent_id, scopes: [""] },
      "nope",
      null,
    ];
    const before = state_signature(env.db);
    for (const [i, payload] of bad.entries()) {
      await rejects_with_api_error(
        issue_agent_token(env.service, env.ctx(`t-bad-${i}`), payload),
        "invalid_payload",
      );
    }
    assert.equal(state_signature(env.db), before);
    const missing = await rejects_with_api_error(
      issue_agent_token(env.service, env.ctx("t-bad-missing"), { actor_id: "no-such-actor", scopes: [] }),
    );
    assert.ok(["not_found", "invalid_payload"].includes(missing.code), missing.code);
    env.db.run("UPDATE actors SET disabled_at = ? WHERE id = ?", BigInt(START_MS), env.agent_id);
    const disabled_before = state_signature(env.db);
    await rejects_with_api_error(
      issue_agent_token(env.service, env.ctx("t-bad-disabled"), { actor_id: env.agent_id, scopes: [] }),
    );
    assert.equal(state_signature(env.db), disabled_before);
  });
});

// resolve_actor / require_human_owner ----------------------------------------

test("resolve_actor by actor id and by token; require_human_owner accepts only a human owner", async () => {
  await with_env(async (env) => {
    const editor = add_editor(env);
    const t = await issue(env, "t-resolve");
    const now_ms = env.clock.now_ms();

    const owner = resolve_actor(env.db, { project_id: env.project_id, actor_id: env.owner_actor_id }, now_ms);
    assert.equal(owner.actor_id, env.owner_actor_id);
    assert.equal(owner.kind, "human");
    assert.equal(owner.membership_role, "owner");
    assert.equal(owner.token_id, null);
    assert.equal(require_human_owner(owner), owner);

    const agent = resolve_actor(env.db, { project_id: env.project_id, token: t.token }, now_ms);
    assert.equal(agent.actor_id, env.agent_id);
    assert.equal(agent.kind, "external_agent");
    assert.equal(agent.token_id, t.token_id);
    // The agent shares the owner's user_id, so its membership role is "owner" - still not a human owner.
    throws_api_error(() => require_human_owner(agent), "forbidden");

    const ed = resolve_actor(env.db, { project_id: env.project_id, actor_id: editor }, now_ms);
    assert.equal(ed.membership_role, "editor");
    throws_api_error(() => require_human_owner(ed), "forbidden");
  });
});

test("resolve_actor refuses unknown, disabled, non-member, ambiguous and credential-less input", async () => {
  await with_env(async (env) => {
    const now_ms = env.clock.now_ms();
    const t = await issue(env, "t-resolve2");
    const p2 = await second_project(env);
    throws_api_error(() => resolve_actor(env.db, { project_id: env.project_id, actor_id: "ghost" }, now_ms), "forbidden");
    throws_api_error(
      () => resolve_actor(env.db, { project_id: env.project_id, actor_id: p2.actor_id }, now_ms),
      "forbidden",
    );
    throws_api_error(() => resolve_actor(env.db, { project_id: env.project_id }, now_ms), "invalid_payload");
    throws_api_error(
      () => resolve_actor(env.db, { project_id: env.project_id, actor_id: env.owner_actor_id, token: t.token }, now_ms),
      "invalid_payload",
    );
    env.db.run("UPDATE actors SET disabled_at = ? WHERE id = ?", BigInt(START_MS), env.owner_actor_id);
    throws_api_error(
      () => resolve_actor(env.db, { project_id: env.project_id, actor_id: env.owner_actor_id }, now_ms),
      "forbidden",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Only a human owner changes the policy or re-allows

const AGENT_KINDS = ["internal_ai", "external_agent", "browser_agent", "system", "legacy_unknown"] as const;

test("policy.set by any non-human actor (even sharing the owner's user) is refused and writes nothing", async () => {
  await with_env(async (env) => {
    for (const [i, kind] of AGENT_KINDS.entries()) {
      env.db.run(
        "INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, ?, ?, ?)",
        `agent-kind-${i}`,
        kind,
        env.owner_user_id,
        `합성 ${kind}`,
      );
    }
    const before = state_signature(env.db);
    for (const [i] of AGENT_KINDS.entries()) {
      await rejects_with_api_error(
        set_policy(env.service, env.ctx(`p-agent-${i}`, `agent-kind-${i}`), { allow_opencode_go: false, reason: "합성" }),
        "forbidden",
      );
    }
    await rejects_with_api_error(go_off(env, "p-agent-x", env.agent_id), "forbidden");
    assert.equal(state_signature(env.db), before, "no policy, receipt, event or dispatch change");
    assert.equal(current_policy(env.db, env.project_id).allow_opencode_go, true);
  });
});

test("policy.set and re-allow by a human editor (not the owner) are refused", async () => {
  await with_env(async (env) => {
    const editor = add_editor(env);
    await go_off(env, "p-off");
    const before = state_signature(env.db);
    await rejects_with_api_error(go_on(env, "p-editor-on", editor), "forbidden");
    await rejects_with_api_error(go_off(env, "p-editor-off", editor), "forbidden");
    assert.equal(state_signature(env.db), before);
    assert.equal(current_policy(env.db, env.project_id).allow_opencode_go, false);
  });
});

test("an agent cannot re-allow Go after the owner turned it OFF; the owner can", async () => {
  await with_env(async (env) => {
    await go_off(env, "p-off-owner");
    const before = state_signature(env.db);
    await rejects_with_api_error(go_on(env, "p-agent-on", env.agent_id), "forbidden");
    assert.equal(state_signature(env.db), before);
    assert.equal(check_go_allowed(env.db, env.project_id).allowed, false);
    // The owner's re-allow is not itself blocked by the OFF policy.
    const out = await go_on(env, "p-owner-on");
    assert.equal(out.replayed, false);
    assert.equal(check_go_allowed(env.db, env.project_id).allowed, true);
  });
});

test("token.issue and token.revoke are owner-only too", async () => {
  await with_env(async (env) => {
    const editor = add_editor(env);
    const t = await issue(env, "t-owner-only");
    const before = state_signature(env.db);
    for (const actor of [env.agent_id, editor]) {
      await rejects_with_api_error(
        issue_agent_token(env.service, env.ctx(`t-no-issue-${actor}`, actor), { actor_id: env.agent_id, scopes: [] }),
        "forbidden",
      );
      await rejects_with_api_error(
        revoke_agent_token(env.service, env.ctx(`t-no-revoke-${actor}`, actor), { token_id: t.token_id }),
        "forbidden",
      );
    }
    assert.equal(state_signature(env.db), before);
    verify_agent_token(env.db, t.token, { project_id: env.project_id, now_ms: env.clock.now_ms() });
  });
});

// ---------------------------------------------------------------------------
// Policy basics

test("a new project starts with the stage-0 7-1 defaults", async () => {
  await with_env((env) => {
    const p = current_policy(env.db, env.project_id);
    assert.equal(p.policy_rev, 1);
    assert.equal(p.allow_opencode_go, true);
    assert.equal(p.mode_a_model, GO_MODEL);
    assert.equal(p.go_usage_stop_percent, 90);
    assert.equal(p.project_id, env.project_id);
    const pointer = env.db.get<{ current_policy_id: string }>(
      "SELECT current_policy_id FROM projects WHERE id = ?",
      env.project_id,
    );
    assert.equal(p.policy_id, pointer?.current_policy_id);
    assert.deepEqual(check_go_allowed(env.db, env.project_id), { allowed: true });
    throws_api_error(() => current_policy(env.db, "no-such-project"), "not_found");
  });
});

test("policy.set appends a version, moves the pointer, keeps history, and links the receipt", async () => {
  await with_env(async (env) => {
    const old_row = policy_row_of_project(env.db, env.project_id);
    const old_snapshot = env.db.get<Record<string, unknown>>("SELECT * FROM project_policy_versions WHERE id = ?", old_row.id);
    env.clock.advance(5_000);
    const out = await set_policy(env.service, env.ctx("p-set"), {
      allow_opencode_go: false,
      go_usage_stop_percent: 75,
      reason: "합성: 이유",
    });
    const r = out.result as {
      project_id: string;
      policy_id: string;
      policy_rev: number;
      allow_opencode_go: boolean;
      blocked_dispatch_ids: string[];
    };
    assert.equal(r.policy_rev, 2);
    assert.equal(r.allow_opencode_go, false);
    assert.deepEqual(r.blocked_dispatch_ids, []);
    const now = policy_row_of_project(env.db, env.project_id);
    assert.equal(now.id, r.policy_id);
    assert.equal(now.policy_rev, 2n);
    assert.equal(now.allow_opencode_go, 0n);
    assert.equal(now.go_usage_stop_percent, 75n);
    assert.equal(now.mode_a_model, GO_MODEL, "unspecified fields are copied");
    assert.equal(now.changed_by, env.owner_actor_id);
    assert.equal(now.changed_by_kind, "human");
    assert.equal(now.reason, "합성: 이유");
    assert.equal(now.created_at, BigInt(START_MS + 5_000));
    const rc = receipt_for(env.db, env.project_id, "p-set");
    assert.ok(rc);
    assert.equal(now.tx_id, rc.id);
    assert.equal(rc.action, "policy.changed");
    assert.deepEqual(events_of(env.db, rc.id).map((e) => e.type), ["policy.changed"]);
    // history is append-only
    const old_again = env.db.get<Record<string, unknown>>("SELECT * FROM project_policy_versions WHERE id = ?", old_row.id);
    assert.deepEqual(old_again, old_snapshot);
    assert.equal(old_again?.allow_opencode_go, 1n);
    assert.equal(old_again?.policy_rev, 1n);
    assert.equal(env.db.all("SELECT 1 FROM project_policy_versions WHERE project_id = ?", env.project_id).length, 2);
    // go_usage_stop_percent alone keeps the allow flag
    await set_policy(env.service, env.ctx("p-set2"), { go_usage_stop_percent: 60, reason: "합성" });
    const p3 = current_policy(env.db, env.project_id);
    assert.equal(p3.policy_rev, 3);
    assert.equal(p3.allow_opencode_go, false);
    assert.equal(p3.go_usage_stop_percent, 60);
  });
});

test("policy.set validates its input before the table CHECKs can fire", async () => {
  await with_env(async (env) => {
    const before = state_signature(env.db);
    const bad: unknown[] = [
      {},
      { reason: "합성" },
      { allow_opencode_go: false },
      { allow_opencode_go: false, reason: "" },
      { allow_opencode_go: false, reason: "   " },
      { allow_opencode_go: "false", reason: "합성" },
      { allow_opencode_go: 0, reason: "합성" },
      { go_usage_stop_percent: 49, reason: "합성" },
      { go_usage_stop_percent: 101, reason: "합성" },
      { go_usage_stop_percent: 90.5, reason: "합성" },
      { go_usage_stop_percent: "90", reason: "합성" },
      { mode_a_model: "other-provider/model", reason: "합성" },
      { mode_a_model: "", reason: "합성" },
      "text",
      null,
    ];
    for (const [i, payload] of bad.entries()) {
      await rejects_with_api_error(set_policy(env.service, env.ctx(`p-bad-${i}`), payload), "invalid_payload");
    }
    assert.equal(state_signature(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// 3. Go OFF and dispatch history

async function dispatch_world(env: Env) {
  const lease = await claim_go_lease(env, "d-claim");
  const prepared = await do_prepare(env, "d-prep-1", lease, "rk-prepared");
  const authorized = await do_prepare(env, "d-prep-2", lease, "rk-authorized");
  await do_authorize(env, "d-auth-2", lease, authorized);
  const sent = await do_prepare(env, "d-prep-3", lease, "rk-sent");
  await do_authorize(env, "d-auth-3", lease, sent);
  await do_mark_sent(env, "d-sent-3", lease, sent);
  const unknown = await do_prepare(env, "d-prep-4", lease, "rk-unknown");
  await do_authorize(env, "d-auth-4", lease, unknown);
  await do_mark_sent(env, "d-sent-4", lease, unknown);
  env.db.run(
    "UPDATE outbound_dispatches SET state = 'unknown', unknown_at = ?, unknown_reason = '합성: 응답 모름' WHERE id = ?",
    BigInt(START_MS),
    unknown,
  );
  return { lease, prepared, authorized, sent, unknown };
}

test("dispatch lifecycle while Go is ON: prepare, authorize, mark_sent record state, time and lease evidence", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "l-claim");
    const policy = current_policy(env.db, env.project_id);
    env.clock.advance(1_000);
    const id = await do_prepare(env, "l-prep", l, "rk-life");
    const prepared = dispatch_row(env.db, id);
    assert.equal(prepared.state, "prepared");
    assert.equal(prepared.policy_version_id, policy.policy_id);
    assert.equal(prepared.run_id, l.run_id);
    assert.equal(prepared.request_key, "rk-life");
    const rc = receipt_for(env.db, env.project_id, "l-prep");
    assert.ok(rc);
    assert.equal(rc.run_id, l.run_id);
    assert.equal(rc.lease_id, l.lease_id);
    assert.equal(rc.fence, BigInt(l.fence));
    const ev = events_of(env.db, rc.id);
    assert.deepEqual(ev.map((e) => e.type), ["dispatch.prepared"]);
    assert.equal(ev[0]!.run_id, l.run_id);

    env.clock.advance(1_000);
    await do_authorize(env, "l-auth", l, id);
    const authorized = dispatch_row(env.db, id);
    assert.equal(authorized.state, "authorized");
    assert.equal(authorized.authorized_at, BigInt(START_MS + 2_000));
    assert.equal(authorized.sent_at, null);

    env.clock.advance(1_000);
    const transport = new FakeGoTransport();
    await do_mark_sent(env, "l-sent", l, id);
    transport.send(id);
    const sent = dispatch_row(env.db, id);
    assert.equal(sent.state, "sent");
    assert.equal(sent.sent_at, BigInt(START_MS + 3_000));
    assert.equal(sent.external_request_id, "ext-l-sent");
    assert.equal(sent.usage_json, null, "unknown usage is not stored as zero");
    assert.equal(sent.cost_json, null, "unknown cost is not stored as zero");
    assert.deepEqual(transport.sent, [id]);
  });
});

test("dispatch.prepare validates destination and hash, and rejects a reused request_key", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "v-claim");
    await do_prepare(env, "v-ok", l, "rk-dup");
    const before = state_signature(env.db);
    const bad: Array<Record<string, unknown>> = [
      { ...prepare_payload(env, l, "rk-p1"), provider: "other-provider" },
      { ...prepare_payload(env, l, "rk-p2"), provider: "" },
      { ...prepare_payload(env, l, "rk-p3"), payload_hash: "abc" },
      { ...prepare_payload(env, l, "rk-p4"), payload_hash: "z".repeat(64) },
      { ...prepare_payload(env, l, "rk-p5"), request_key: "" },
      { ...prepare_payload(env, l, "rk-p6"), manifest_blob_id: "" },
    ];
    for (const [i, payload] of bad.entries()) {
      await rejects_with_api_error(prepare_dispatch(env.service, env.ctx(`v-bad-${i}`), payload), "invalid_payload");
    }
    await rejects_with_api_error(
      prepare_dispatch(env.service, env.ctx("v-dup"), prepare_payload(env, l, "rk-dup")),
      "conflict",
    );
    assert.equal(state_signature(env.db), before);
  });
});

test("state machine: authorize needs prepared, mark_sent needs authorized, block needs prepared/authorized", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "sm-claim");
    const a = await do_prepare(env, "sm-a", l, "rk-sm-a");
    const before_skip = state_signature(env.db);
    await rejects_with_api_error(
      mark_sent(env.service, env.ctx("sm-skip"), { dispatch_id: a, ...guard(l) }),
      "conflict",
    );
    assert.equal(state_signature(env.db), before_skip, "prepared -> sent is not allowed");
    await do_authorize(env, "sm-auth", l, a);
    await rejects_with_api_error(
      authorize_dispatch(env.service, env.ctx("sm-auth-again"), { dispatch_id: a, ...guard(l) }),
      "conflict",
    );
    await do_mark_sent(env, "sm-sent", l, a);
    await rejects_with_api_error(
      block_dispatch(env.service, env.ctx("sm-block-sent"), { dispatch_id: a, reason: "합성" }),
      "conflict",
    );
    await rejects_with_api_error(
      mark_sent(env.service, env.ctx("sm-sent-again"), { dispatch_id: a, ...guard(l) }),
      "conflict",
    );
    assert.equal(dispatch_row(env.db, a).state, "sent");
    await rejects_with_api_error(
      block_dispatch(env.service, env.ctx("sm-block-missing"), { dispatch_id: "no-such-dispatch", reason: "합성" }),
      "not_found",
    );
    const b = await do_prepare(env, "sm-b", l, "rk-sm-b");
    await block_dispatch(env.service, env.ctx("sm-block-b"), { dispatch_id: b, reason: "합성: 수동 차단" });
    assert.equal(dispatch_row(env.db, b).state, "blocked");
    await rejects_with_api_error(
      authorize_dispatch(env.service, env.ctx("sm-auth-blocked"), { dispatch_id: b, ...guard(l) }),
      "conflict",
    );
    await rejects_with_api_error(
      block_dispatch(env.service, env.ctx("sm-block-b-again"), { dispatch_id: b, reason: "합성" }),
      "conflict",
    );
  });
});

test("Go OFF blocks prepared and authorized-unsent dispatches; sent and unknown history is untouched", async () => {
  await with_env(async (env) => {
    const w = await dispatch_world(env);
    const sent_before = dispatch_signature(env.db, w.sent);
    const unknown_before = dispatch_signature(env.db, w.unknown);
    const dispatch_count = env.db.all("SELECT 1 FROM outbound_dispatches").length;

    env.clock.advance(1_000);
    const out = await go_off(env, "off-1");
    const r = out.result as { blocked_dispatch_ids: string[]; allow_opencode_go: boolean };
    assert.equal(r.allow_opencode_go, false);
    assert.deepEqual([...r.blocked_dispatch_ids].sort(), [w.prepared, w.authorized].sort());

    assert.equal(dispatch_row(env.db, w.prepared).state, "blocked");
    assert.equal(dispatch_row(env.db, w.authorized).state, "blocked");
    assert.equal(dispatch_signature(env.db, w.sent), sent_before, "sent history is unchanged");
    assert.equal(dispatch_signature(env.db, w.unknown), unknown_before, "unknown history is unchanged");
    assert.equal(dispatch_row(env.db, w.sent).state, "sent");
    assert.equal(dispatch_row(env.db, w.unknown).state, "unknown");
    assert.equal(env.db.all("SELECT 1 FROM outbound_dispatches").length, dispatch_count, "nothing is deleted");

    const rc = receipt_for(env.db, env.project_id, "off-1");
    assert.ok(rc);
    const types = events_of(env.db, rc.id).map((e) => e.type);
    assert.equal(types[0], "policy.changed");
    // Final-review F1: the Go run holds an active lease, so OFF interrupts it in this same transaction.
    assert.deepEqual(types, ["policy.changed", "run.interrupted", "dispatch.blocked", "dispatch.blocked"]);
  });
});

test("after Go OFF nothing new leaves: prepare / authorize / mark_sent are policy_denied, transport stays idle", async () => {
  await with_env(async (env) => {
    const w = await dispatch_world(env);
    const transport = new FakeGoTransport();
    await go_off(env, "off-2");
    const before = state_signature(env.db);

    await rejects_with_api_error(
      prepare_dispatch(env.service, env.ctx("n-prep"), prepare_payload(env, w.lease, "rk-after-off")),
      "policy_denied",
    );
    await rejects_with_api_error(
      authorize_dispatch(env.service, env.ctx("n-auth"), { dispatch_id: w.prepared, ...guard(w.lease) }),
      "policy_denied",
    );
    // The gate sits in front of the transport: a denied mark_sent never reaches it.
    try {
      await mark_sent(env.service, env.ctx("n-sent"), { dispatch_id: w.authorized, ...guard(w.lease) });
      transport.send(w.authorized);
    } catch (error) {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "policy_denied");
    }
    assert.deepEqual(transport.sent, []);
    assert.equal(state_signature(env.db), before);
    assert.equal(dispatch_row(env.db, w.authorized).state, "blocked");
  });
});

test("dispatch.block and non-Go commands are not gated by Go: they fail or succeed on their own rules", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "off-claim");
    const sent = await do_prepare(env, "off-prep", l, "rk-off-sent");
    await do_authorize(env, "off-auth", l, sent);
    await do_mark_sent(env, "off-sent", l, sent);
    await go_off(env, "off-3");
    // Not policy_denied: the refusal comes from the state machine (a sent dispatch cannot be blocked).
    await rejects_with_api_error(
      block_dispatch(env.service, env.ctx("off-block"), { dispatch_id: sent, reason: "합성" }),
      "conflict",
    );
    // Topic edits and mode B runs are not Go sends.
    const topic = await env.service.execute(
      { ...env.ctx("off-topic"), base_control_rev: 0 },
      "project.set_topic",
      { topic: "OFF 중에도 되는 변경" },
    );
    assert.equal(topic.replayed, false);
    // Final-review F1: OFF revoked the Go run's lease, so the old guard cannot even release it.
    await rejects_with_api_error(release(env.service, env.ctx("off-release"), guard(l)), "conflict");
    const b = await claim(env.service, env.ctx("off-claim-b"), {
      mode: "B",
      runtime: "synthetic-runtime",
      provider: "synthetic",
      model: "synthetic-model",
    });
    assert.equal(b.replayed, false);
  });
});

test("re-allowing Go never revives a blocked dispatch", async () => {
  await with_env(async (env) => {
    const w = await dispatch_world(env);
    await go_off(env, "rv-off");
    await go_on(env, "rv-on");
    assert.equal(dispatch_row(env.db, w.prepared).state, "blocked");
    assert.equal(dispatch_row(env.db, w.authorized).state, "blocked");
    await rejects_with_api_error(
      authorize_dispatch(env.service, env.ctx("rv-auth"), { dispatch_id: w.prepared, ...guard(w.lease) }),
      "conflict",
    );
    await rejects_with_api_error(
      mark_sent(env.service, env.ctx("rv-sent"), { dispatch_id: w.authorized, ...guard(w.lease) }),
      "conflict",
    );
    // Final-review F1: the old lease died with OFF; a fresh dispatch needs a new claim after the owner re-allows.
    await rejects_with_api_error(
      prepare_dispatch(env.service, env.ctx("rv-old-prep"), prepare_payload(env, w.lease, "rk-fresh")),
      "conflict",
    );
    const lease2 = await claim_go_lease(env, "rv-reclaim", w.lease.run_id);
    const fresh = await do_prepare(env, "rv-fresh", lease2, "rk-fresh");
    assert.equal(dispatch_row(env.db, fresh).policy_version_id, current_policy(env.db, env.project_id).policy_id);
    assert.equal(current_policy(env.db, env.project_id).policy_rev, 3);
  });
});

test("an old lease (older fence) cannot prepare, authorize or send; the current lease can", async () => {
  await with_env(async (env) => {
    const old = await claim_go_lease(env, "ol-claim");
    const id = await do_prepare(env, "ol-prep", old, "rk-old");
    await release(env.service, env.ctx("ol-release"), guard(old));
    const fresh = await claim_go_lease(env, "ol-reclaim", old.run_id);
    assert.equal(fresh.fence, old.fence + 1);

    const before = state_signature(env.db);
    await rejects_with_api_error(
      authorize_dispatch(env.service, env.ctx("ol-auth-old"), { dispatch_id: id, ...guard(old) }),
      "conflict",
    );
    await rejects_with_api_error(
      prepare_dispatch(env.service, env.ctx("ol-prep-old"), prepare_payload(env, old, "rk-old-2")),
      "conflict",
    );
    assert.equal(state_signature(env.db), before, "a stale fence writes nothing");

    await do_authorize(env, "ol-auth-new", fresh, id);
    // the old guard still cannot send, even though the dispatch is authorized now
    await rejects_with_api_error(
      mark_sent(env.service, env.ctx("ol-sent-old"), { dispatch_id: id, ...guard(old) }),
      "conflict",
    );
    assert.equal(dispatch_row(env.db, id).state, "authorized");
    await do_mark_sent(env, "ol-sent-new", fresh, id);
    assert.equal(dispatch_row(env.db, id).state, "sent");
  });
});

test("an old lease is still refused after Go is switched OFF and ON again", async () => {
  await with_env(async (env) => {
    const old = await claim_go_lease(env, "of-claim");
    const id = await do_prepare(env, "of-prep", old, "rk-of");
    await release(env.service, env.ctx("of-release"), guard(old));
    const fresh = await claim_go_lease(env, "of-reclaim", old.run_id);
    await go_off(env, "of-off");
    await go_on(env, "of-on");
    const before = state_signature(env.db);
    const err = await rejects_with_api_error(
      mark_sent(env.service, env.ctx("of-old"), { dispatch_id: id, ...guard(old) }),
    );
    assert.ok(["conflict", "policy_denied"].includes(err.code), err.code);
    assert.equal(state_signature(env.db), before);
    assert.equal(fresh.fence, old.fence + 1);
  });
});

test("an expired lease cannot send: now >= expires_at is a conflict", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "ex-claim");
    const id = await do_prepare(env, "ex-prep", l, "rk-ex");
    await do_authorize(env, "ex-auth", l, id);
    env.clock.advance(TEST_CONFIG.lease_ttl_ms);
    const before = state_signature(env.db);
    await rejects_with_api_error(
      mark_sent(env.service, env.ctx("ex-sent"), { dispatch_id: id, ...guard(l) }),
      "conflict",
    );
    assert.equal(state_signature(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// 4. Damaged policy fails closed

interface CorruptCase {
  name: string;
  /** true when apply() itself runs Go OFF, which blocks the unsent dispatch in the same tx */
  calls_go_off?: boolean;
  apply(env: Env, other_policy_id: string): void | Promise<void>;
}

function corrupt_current(env: Env, sql: string, ...params: SqlValue[]): void {
  env.db.exec("PRAGMA foreign_keys = OFF");
  env.db.exec("PRAGMA ignore_check_constraints = ON");
  env.db.run(
    `UPDATE project_policy_versions SET ${sql}
     WHERE id = (SELECT current_policy_id FROM projects WHERE id = ?)`,
    ...params,
    env.project_id,
  );
}

const CORRUPT_CASES: CorruptCase[] = [
  {
    name: "pointer is NULL",
    apply(env) {
      env.db.exec("PRAGMA ignore_check_constraints = ON");
      env.db.run("UPDATE projects SET current_policy_id = NULL WHERE id = ?", env.project_id);
    },
  },
  {
    name: "pointer targets a missing row",
    apply(env) {
      env.db.exec("PRAGMA foreign_keys = OFF");
      env.db.run("UPDATE projects SET current_policy_id = 'no-such-policy' WHERE id = ?", env.project_id);
    },
  },
  {
    name: "no policy rows at all",
    apply(env) {
      env.db.exec("PRAGMA foreign_keys = OFF");
      env.db.run("DELETE FROM project_policy_versions WHERE project_id = ?", env.project_id);
    },
  },
  {
    name: "pointer targets another project's (allowing) row",
    calls_go_off: true,
    async apply(env, other) {
      await go_off(env, "cp-off");
      env.db.exec("PRAGMA foreign_keys = OFF");
      env.db.run("UPDATE projects SET current_policy_id = ? WHERE id = ?", other, env.project_id);
    },
  },
  {
    name: "pointer rewound to an older allowing version",
    calls_go_off: true,
    async apply(env) {
      const old = policy_row_of_project(env.db, env.project_id).id;
      await go_off(env, "cp-off2");
      env.db.exec("PRAGMA foreign_keys = OFF");
      env.db.run("UPDATE projects SET current_policy_id = ? WHERE id = ?", old, env.project_id);
    },
  },
  { name: "allow flag is 2", apply: (env) => corrupt_current(env, "allow_opencode_go = 2") },
  { name: "allow flag is -1", apply: (env) => corrupt_current(env, "allow_opencode_go = -1") },
  { name: "allow flag is text", apply: (env) => corrupt_current(env, "allow_opencode_go = 'yes'") },
  { name: "model is not an opencode-go model", apply: (env) => corrupt_current(env, "mode_a_model = 'other/model'") },
  { name: "stop percent is 0", apply: (env) => corrupt_current(env, "go_usage_stop_percent = 0") },
  { name: "stop percent is 101", apply: (env) => corrupt_current(env, "go_usage_stop_percent = 101") },
  { name: "stop percent is text", apply: (env) => corrupt_current(env, "go_usage_stop_percent = 'abc'") },
  { name: "changed_by_kind is not human", apply: (env) => corrupt_current(env, "changed_by_kind = 'internal_ai'") },
];

for (const c of CORRUPT_CASES) {
  test(`damaged policy (${c.name}) fails closed for the check, the reader and Go commands`, async () => {
    await with_env(async (env) => {
      const lease = await claim_go_lease(env, "cc-claim");
      const prepared = await do_prepare(env, "cc-prep", lease, "rk-cc");
      const p2 = await second_project(env);
      const other_policy = current_policy(env.db, p2.project_id).policy_id;

      await c.apply(env, other_policy);
      // state of the dispatch after the damage is set up (Go OFF in apply() already blocks it)
      const dispatch_state_before = dispatch_row(env.db, prepared).state;
      assert.equal(dispatch_state_before, c.calls_go_off ? "blocked" : "prepared");

      const decision = check_go_allowed(env.db, env.project_id);
      assert.equal(decision.allowed, false);
      assert.ok("reason" in decision && typeof decision.reason === "string" && decision.reason.length > 0);
      throws_api_error(() => current_policy(env.db, env.project_id), "policy_denied");

      const before = state_signature(env.db);
      await rejects_with_api_error(
        prepare_dispatch(env.service, env.ctx("cc-new"), prepare_payload(env, lease, "rk-cc-2")),
        "policy_denied",
      );
      await rejects_with_api_error(
        authorize_dispatch(env.service, env.ctx("cc-auth"), { dispatch_id: prepared, ...guard(lease) }),
        "policy_denied",
      );
      assert.equal(state_signature(env.db), before, "a denied command writes nothing");
      assert.equal(
        dispatch_row(env.db, prepared).state,
        dispatch_state_before,
        "a denied command does not change the dispatch state",
      );

      // the damage is local to the project
      assert.deepEqual(check_go_allowed(env.db, p2.project_id), { allowed: true });
    });
  });
}

test("check_go_allowed is read-only", async () => {
  await with_env(async (env) => {
    const before = state_signature(env.db);
    check_go_allowed(env.db, env.project_id);
    current_policy(env.db, env.project_id);
    assert.equal(state_signature(env.db), before);
    assert.equal(check_go_allowed(env.db, "no-such-project").allowed, false);
  });
});

// ---------------------------------------------------------------------------
// 5. Policy runs before receipt replay

test("a request that succeeded before OFF is not replayed after OFF, even with the same key", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "rp-claim");
    const prep_input = prepare_payload(env, l, "rk-replay");
    const first = await prepare_dispatch(env.service, env.ctx("rp-prep"), prep_input);
    const id = (first.result as { dispatch_id: string }).dispatch_id;
    const auth_input = { dispatch_id: id, ...guard(l) };
    await authorize_dispatch(env.service, env.ctx("rp-auth"), auth_input);
    const topic = await env.service.execute(
      { ...env.ctx("rp-topic"), base_control_rev: 0 },
      "project.set_topic",
      { topic: "OFF 전 변경" },
    );

    await go_off(env, "rp-off");
    const before = state_signature(env.db);

    // same key + same payload: policy wins over replay
    await rejects_with_api_error(prepare_dispatch(env.service, env.ctx("rp-prep"), prep_input), "policy_denied");
    await rejects_with_api_error(authorize_dispatch(env.service, env.ctx("rp-auth"), auth_input), "policy_denied");
    // same key + different payload: still policy_denied, not idempotency_key_reuse
    await rejects_with_api_error(
      prepare_dispatch(env.service, env.ctx("rp-prep"), { ...prep_input, request_key: "rk-other" }),
      "policy_denied",
    );
    assert.equal(state_signature(env.db), before);

    // a command that Go does not gate still replays from its receipt
    const topic_again = await env.service.execute(
      { ...env.ctx("rp-topic"), base_control_rev: 0 },
      "project.set_topic",
      { topic: "OFF 전 변경" },
    );
    assert.equal(topic_again.replayed, true);
    assert.deepEqual(topic_again.result, topic.result);

    // once the owner re-allows, the old receipts replay again (they were never removed)
    await go_on(env, "rp-on");
    const replay = await prepare_dispatch(env.service, env.ctx("rp-prep"), prep_input);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, first.result);
  });
});

test("a damaged policy also beats replay", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "rd-claim");
    const input = prepare_payload(env, l, "rk-rd");
    await prepare_dispatch(env.service, env.ctx("rd-prep"), input);
    env.db.exec("PRAGMA ignore_check_constraints = ON");
    env.db.run("UPDATE projects SET current_policy_id = NULL WHERE id = ?", env.project_id);
    await rejects_with_api_error(prepare_dispatch(env.service, env.ctx("rd-prep"), input), "policy_denied");
  });
});

// ---------------------------------------------------------------------------
// 6. PR4 rules hold for the new commands

interface World {
  lease: Lease;
  t0: string;
  t1: string;
  dp1: string;
  dp2: string;
  dp3: string;
  da1: string;
  da2: string;
}

async function make_world(env: Env): Promise<World> {
  const lease = await claim_go_lease(env, "k-claim");
  const t0 = (await issue(env, "k-t0", ["run"])).token_id;
  const t1 = (await issue(env, "k-t1", ["content"])).token_id;
  const dp1 = await do_prepare(env, "k-dp1", lease, "rk-k-dp1");
  const dp2 = await do_prepare(env, "k-dp2", lease, "rk-k-dp2");
  const dp3 = await do_prepare(env, "k-dp3", lease, "rk-k-dp3");
  const da1 = await do_prepare(env, "k-da1", lease, "rk-k-da1");
  const da2 = await do_prepare(env, "k-da2", lease, "rk-k-da2");
  await do_authorize(env, "k-da1-auth", lease, da1);
  await do_authorize(env, "k-da2-auth", lease, da2);
  return { lease, t0, t1, dp1, dp2, dp3, da1, da2 };
}

interface ContractCase {
  command: string;
  payload(env: Env, w: World): unknown;
  alt(env: Env, w: World): unknown;
}

const CONTRACT_CASES: ContractCase[] = [
  {
    command: "token.issue",
    payload: (env) => ({ actor_id: env.agent_id, scopes: ["run"] }),
    alt: (env) => ({ actor_id: env.agent_id, scopes: ["content"] }),
  },
  {
    command: "token.revoke",
    payload: (_env, w) => ({ token_id: w.t0 }),
    alt: (_env, w) => ({ token_id: w.t1 }),
  },
  {
    command: "policy.set",
    payload: () => ({ allow_opencode_go: false, reason: "합성 하나" }),
    alt: () => ({ allow_opencode_go: false, reason: "합성 둘" }),
  },
  {
    command: "dispatch.prepare",
    payload: (env, w) => prepare_payload(env, w.lease, "rk-contract-a"),
    alt: (env, w) => prepare_payload(env, w.lease, "rk-contract-b"),
  },
  {
    command: "dispatch.authorize",
    payload: (_env, w) => ({ dispatch_id: w.dp1, ...guard(w.lease) }),
    alt: (_env, w) => ({ dispatch_id: w.dp2, ...guard(w.lease) }),
  },
  {
    command: "dispatch.mark_sent",
    payload: (_env, w) => ({ dispatch_id: w.da1, ...guard(w.lease) }),
    alt: (_env, w) => ({ dispatch_id: w.da2, ...guard(w.lease) }),
  },
  {
    command: "dispatch.block",
    payload: (_env, w) => ({ dispatch_id: w.dp3, reason: "합성 하나" }),
    alt: (_env, w) => ({ dispatch_id: w.dp3, reason: "합성 둘" }),
  },
];

for (const c of CONTRACT_CASES) {
  test(`${c.command}: same key replays, a different request is refused`, async () => {
    await with_env(async (env) => {
      const w = await make_world(env);
      const payload = c.payload(env, w);
      const first = await env.service.execute(env.ctx("ct-key"), c.command, payload);
      assert.equal(first.replayed, false);
      const counts = table_counts(env.db);
      const sig = state_signature(env.db);

      const again = await env.service.execute(env.ctx("ct-key"), c.command, payload);
      assert.equal(again.replayed, true);
      const strip = (r: unknown) => {
        const { token: _t, ...rest } = r as Record<string, unknown>;
        return rest;
      };
      assert.deepEqual(strip(again.result), strip(first.result));
      assert.equal(state_signature(env.db), sig, "a replay writes nothing");
      assert.deepEqual(table_counts(env.db), counts);

      await rejects_with_api_error(
        env.service.execute(env.ctx("ct-key"), c.command, c.alt(env, w)),
        "idempotency_key_reuse",
      );
      assert.equal(state_signature(env.db), sig);
    });
  });

  test(`${c.command}: events and the receipt share one tx, with the registered action`, async () => {
    await with_env(async (env) => {
      const w = await make_world(env);
      await env.service.execute(env.ctx("ct-tx"), c.command, c.payload(env, w));
      const rc = receipt_for(env.db, env.project_id, "ct-tx");
      assert.ok(rc);
      assert.equal(rc.action, NEW_COMMANDS[c.command]);
      const events = events_of(env.db, rc.id);
      assert.ok(events.length >= 1);
      assert.equal(events[0]!.type, NEW_COMMANDS[c.command]);
      for (const [i, e] of events.entries()) {
        assert.equal(e.tx_index, BigInt(i));
        assert.equal(e.tx_size, BigInt(events.length));
      }
      if (c.command.startsWith("dispatch.") && c.command !== "dispatch.block") {
        assert.equal(rc.run_id, w.lease.run_id);
        assert.equal(rc.lease_id, w.lease.lease_id);
        assert.equal(rc.fence, BigInt(w.lease.fence));
      }
    });
  });

  test(`${c.command}: a failure at the end rolls everything back and the retry still works`, async () => {
    await with_env(async (env) => {
      const w = await make_world(env);
      const payload = c.payload(env, w);
      const failing = env.with_db(
        wrap_db(env.db, (sql) => {
          if (/INSERT\s+INTO\s+events\b/i.test(sql)) throw new Error("synthetic events failure");
        }),
      );
      const before = state_signature(env.db);
      await assert.rejects(failing.execute(env.ctx("ct-rb"), c.command, payload), /synthetic events failure/);
      assert.equal(state_signature(env.db), before, "no row, event or receipt survives");
      const retry = await env.service.execute(env.ctx("ct-rb"), c.command, payload);
      assert.equal(retry.replayed, false);
    });
  });
}

test("a rejected new command (policy, owner, lease) leaves no receipt behind and the key stays usable", async () => {
  await with_env(async (env) => {
    const l = await claim_go_lease(env, "ru-claim");
    await go_off(env, "ru-off");
    const before = state_signature(env.db);
    await rejects_with_api_error(prepare_dispatch(env.service, env.ctx("ru-key"), prepare_payload(env, l, "rk-ru")), "policy_denied");
    assert.equal(receipt_for(env.db, env.project_id, "ru-key"), undefined);
    assert.equal(state_signature(env.db), before);
    await go_on(env, "ru-on");
    // Final-review F1: OFF revoked the old lease, so the retry runs under a new claim.
    const l2 = await claim_go_lease(env, "ru-reclaim", l.run_id);
    const ok = await prepare_dispatch(env.service, env.ctx("ru-key"), prepare_payload(env, l2, "rk-ru"));
    assert.equal(ok.replayed, false);
  });
});

test("no secret or hash ever reaches an error: failed new commands carry only closed codes", async () => {
  await with_env(async (env) => {
    const t = await issue(env, "se-issue");
    const attempts: Array<Promise<unknown>> = [
      issue_agent_token(env.service, env.ctx("se-1", env.agent_id), { actor_id: env.agent_id, scopes: [] }),
      revoke_agent_token(env.service, env.ctx("se-2"), { token_id: "missing" }),
      set_policy(env.service, env.ctx("se-3", env.agent_id), { allow_opencode_go: false, reason: "합성" }),
    ];
    for (const attempt of attempts) {
      const err = await rejects_with_api_error(attempt);
      const text = `${err.message} ${JSON.stringify(err.details ?? null)}`;
      assert.equal(text.includes(t.token), false);
      const hash = env.db.get<{ token_hash: string }>("SELECT token_hash FROM agent_tokens WHERE id = ?", t.token_id);
      assert.ok(hash);
      assert.equal(text.includes(hash.token_hash), false);
    }
  });
});

// SEL-43 PR10 final-review regression tests (writing mode). Everything is synthetic.
// Source: the final review (Codex) findings F1, F2, R1 and R3, with the leader's decisions:
//
// F1  policy.set(Go OFF) revokes the active lease of a mode A (Go) run in the same transaction,
//     moves a running run to "interrupted", and writes an audit event. Mode B runs and finished
//     runs are untouched. An old lease_id/fence is never usable again, not even after Go is
//     switched ON again; only a new claim (new fence) lets dispatches go on.
// F2  PolicyChecker.check gets a database handle that is read-only for real: writes, PRAGMAs,
//     ATTACH, transaction control and multi-statement SQL throw; SELECT / WITH reads work; the
//     handle is dead once check() has returned.
// R1  token.issue refuses an actor without a user, with a disabled user, a disabled actor, or
//     without membership in the project. No row is written.
// R3  When Go goes OFF (and for dispatch.block), an "authorized" dispatch that already shows send
//     evidence (sent_at or external_request_id) becomes "unknown", not "blocked", and keeps the
//     evidence. Without evidence, prepared / authorized become "blocked" as before.
//
// The audit event type for F1 is not fixed by the issue, so the tests only require "an event of
// this transaction that names the run and is neither policy.changed nor dispatch.blocked".

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { FakeClock } from "../scripts/pes_core/clock.ts";
import { connect, migrate, type Db, type RunResult, type SqlValue } from "../scripts/pes_core/db.ts";
import { ApiError } from "../scripts/pes_core/errors.ts";
import {
  CommandService,
  type MutationContext,
  type PolicyChecker,
  type PolicyDecision,
} from "../scripts/pes_core/commands.ts";
import type { RunConfig } from "../scripts/pes_core/config.ts";
import { claim, complete, heartbeat, record_receipt } from "../scripts/pes_core/runs.ts";
import { issue_agent_token } from "../scripts/pes_core/actors.ts";
import {
  DbPolicyChecker,
  authorize_dispatch,
  block_dispatch,
  current_policy,
  mark_sent,
  prepare_dispatch,
  set_policy,
} from "../scripts/pes_core/policy.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { isolated_home, type IsolatedHome } from "./helpers/isolated_home.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

const START_MS = 1_760_000_000_000;
const TEST_CONFIG: RunConfig = { lease_ttl_ms: 60_000, heartbeat_interval_ms: 20_000 };
const GO_MODEL = "opencode-go/deepseek-v4.1-flash";

// ---------------------------------------------------------------------------
// Harness

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
  blob_id: string;
  ctx(key: string, actor_id?: string): MutationContext;
  /** the internal_ai actor that holds mode A (Go) leases */
  ai_ctx(key: string): MutationContext;
  close(): void;
}

let project_seq = 0;

async function make_env(policy: PolicyChecker = new DbPolicyChecker()): Promise<Env> {
  project_seq += 1;
  const home = isolated_home("pes-sel43f-");
  const db = connect(db_path(home.env));
  migrate(db);
  const clock = new FakeClock(START_MS);
  // Bootstrap always goes through the real checker; the probe checker is swapped in by the test.
  const boot = new CommandService(db, { clock, policy: new DbPolicyChecker(), run_config: TEST_CONFIG });
  const out = await boot.execute(
    { project_id: null, actor_id: null, via: "cli", client_request_id: "setup-p" },
    "project.bootstrap",
    { slug: `synthetic-final-${project_seq}`, topic: "합성 최종 주제", owner_display_name: "합성 소유자" },
  );
  const r = out.result as { project_id: string; owner_actor_id: string; owner_user_id: string };
  // SEL-68: a mode A run belongs to an internal_ai actor only, so the Go lease flow below runs as this actor
  // (the human owner keeps the policy commands: set_policy, ...).
  db.run(
    "INSERT INTO actors (id, kind, user_id, display_name) VALUES ('agent-ai', 'internal_ai', ?, '합성 내장 AI')",
    r.owner_user_id,
  );
  db.run(
    `INSERT INTO blobs (id, project_id, storage_key, sha256, size, media_type, state, created_by)
     VALUES (?, ?, ?, ?, 10, 'application/json', 'ready', ?)`,
    "blob-manifest-f",
    r.project_id,
    "synthetic/manifest-f",
    "c".repeat(64),
    r.owner_actor_id,
  );
  const service =
    policy instanceof DbPolicyChecker
      ? boot
      : new CommandService(db, { clock, policy, run_config: TEST_CONFIG });
  return {
    home,
    db,
    clock,
    service,
    project_id: r.project_id,
    owner_actor_id: r.owner_actor_id,
    owner_user_id: r.owner_user_id,
    blob_id: "blob-manifest-f",
    ctx: (key, actor_id) => ({
      project_id: r.project_id,
      actor_id: actor_id ?? r.owner_actor_id,
      via: "cli",
      client_request_id: key,
    }),
    ai_ctx: (key) => ({ project_id: r.project_id, actor_id: "agent-ai", via: "cli", client_request_id: key }),
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

async function rejects_with_api_error(p: Promise<unknown> | unknown, code?: string | string[]): Promise<ApiError> {
  try {
    await p;
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
    if (code !== undefined) {
      const allowed = Array.isArray(code) ? code : [code];
      assert.ok(allowed.includes(error.code), `expected one of ${allowed.join("/")}, got ${error.code}`);
    }
    return error;
  }
  assert.fail("expected the call to be rejected");
}

/** The old guard may be refused as a stale lease (conflict) or by the OFF policy (policy_denied). */
const STALE: string[] = ["conflict", "policy_denied"];

function guard(l: Lease): { run_id: string; lease_id: string; fence: number } {
  return { run_id: l.run_id, lease_id: l.lease_id, fence: l.fence };
}

async function claim_go(env: Env, key: string): Promise<Lease> {
  const out = await claim(env.service, env.ai_ctx(key), {
    mode: "A",
    runtime: "synthetic-runtime",
    provider: "opencode-go",
    model: GO_MODEL,
  });
  return out.result as Lease;
}

async function claim_b(env: Env, key: string): Promise<Lease> {
  const out = await claim(env.service, env.ai_ctx(key), {
    mode: "B",
    runtime: "synthetic-runtime",
    provider: "synthetic",
    model: "synthetic-model",
  });
  return out.result as Lease;
}

async function reclaim(env: Env, key: string, run_id: string): Promise<Lease> {
  const out = await claim(env.service, env.ai_ctx(key), { run_id });
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
  const out = await prepare_dispatch(env.service, env.ai_ctx(key), prepare_payload(env, l, request_key));
  return (out.result as { dispatch_id: string }).dispatch_id;
}

async function do_authorize(env: Env, key: string, l: Lease, dispatch_id: string): Promise<void> {
  await authorize_dispatch(env.service, env.ai_ctx(key), { dispatch_id, ...guard(l) });
}

async function go_off(env: Env, key = "go-off") {
  return set_policy(env.service, env.ctx(key), { allow_opencode_go: false, reason: "합성: Go 끔" });
}

async function go_on(env: Env, key = "go-on") {
  return set_policy(env.service, env.ctx(key), { allow_opencode_go: true, reason: "합성: Go 켬" });
}

function row_of(db: Db, sql: string, ...params: SqlValue[]): Record<string, unknown> {
  const row = db.get<Record<string, unknown>>(sql, ...params);
  assert.ok(row, `row exists: ${sql}`);
  return { ...row };
}

function dispatch_row(db: Db, id: string): Record<string, unknown> {
  return row_of(db, "SELECT * FROM outbound_dispatches WHERE id = ?", id);
}

function run_row(db: Db, id: string): Record<string, unknown> {
  return row_of(db, "SELECT * FROM runs WHERE id = ?", id);
}

function lease_row(env: Env): Record<string, unknown> {
  return row_of(env.db, "SELECT * FROM project_leases WHERE project_id = ?", env.project_id);
}

function receipt_id(env: Env, key: string): string {
  const row = env.db.get<{ id: string }>(
    "SELECT id FROM mutation_commits WHERE project_id = ? AND client_request_id = ?",
    env.project_id,
    key,
  );
  assert.ok(row, `receipt for ${key}`);
  return row.id;
}

function events_of_tx(env: Env, tx_id: string) {
  return env.db
    .all<{ type: string; run_id: string | null; payload: string }>(
      "SELECT type, run_id, payload FROM events WHERE tx_id = ? ORDER BY tx_index",
      tx_id,
    )
    .map((row) => ({ ...row }));
}

/** A synthetic object version a run can record an input receipt for. */
let input_seq = 0;
function make_input(env: Env): { version_id: string; tx_id: string } {
  input_seq += 1;
  const object_id = `fobj-${input_seq}`;
  const version_id = `fver-${input_seq}`;
  const first_tx = env.db.get<{ id: string }>(
    "SELECT id FROM mutation_commits WHERE project_id = ? ORDER BY rowid LIMIT 1",
    env.project_id,
  );
  assert.ok(first_tx);
  env.db.run(
    "INSERT INTO objects (id, project_id, kind, display_no) VALUES (?, ?, 'artifact', ?)",
    object_id,
    env.project_id,
    BigInt(input_seq),
  );
  env.db.run(
    `INSERT INTO object_versions (id, project_id, object_id, kind, version_no, actor_id, tx_id, content_hash)
     VALUES (?, ?, ?, 'artifact', 1, ?, ?, ?)`,
    version_id,
    env.project_id,
    object_id,
    env.owner_actor_id,
    first_tx.id,
    "d".repeat(64),
  );
  return { version_id, tx_id: first_tx.id };
}

function applied_receipt_count(env: Env, run_id: string): number {
  const row = env.db.get<{ n: bigint }>(
    "SELECT count(*) AS n FROM run_input_receipts WHERE project_id = ? AND run_id = ? AND state = 'applied'",
    env.project_id,
    run_id,
  );
  return Number(row?.n ?? 0n);
}

// ---------------------------------------------------------------------------
// F1. Go OFF invalidates the lease of the Go run

/** Every command that an old guard might still try, each expected to be refused and to write nothing. */
async function assert_old_guard_refused(env: Env, old: Lease, tag: string, input: { version_id: string; tx_id: string }, dispatch_ids: string[]) {
  const before = state_signature(env.db);
  const attempts: Array<[string, () => Promise<unknown>]> = [
    ["heartbeat", () => heartbeat(env.service, env.ai_ctx(`${tag}-hb`), guard(old))],
    [
      "record_receipt(applied)",
      () =>
        record_receipt(env.service, env.ctx(`${tag}-rec`), {
          ...guard(old),
          input_version_id: input.version_id,
          state: "applied",
          applied_tx_id: input.tx_id,
        }),
    ],
    ["prepare", () => prepare_dispatch(env.service, env.ai_ctx(`${tag}-prep`), prepare_payload(env, old, `rk-${tag}-new`))],
    ["complete", () => complete(env.service, env.ai_ctx(`${tag}-done`), { ...guard(old), status: "succeeded" })],
  ];
  for (const [i, dispatch_id] of dispatch_ids.entries()) {
    attempts.push([`authorize#${i}`, () => authorize_dispatch(env.service, env.ai_ctx(`${tag}-auth${i}`), { dispatch_id, ...guard(old) })]);
    attempts.push([`mark_sent#${i}`, () => mark_sent(env.service, env.ai_ctx(`${tag}-sent${i}`), { dispatch_id, ...guard(old) })]);
  }
  for (const [name, attempt] of attempts) {
    await rejects_with_api_error(attempt(), STALE).catch((e) => {
      throw new Error(`${tag}: ${name} was not refused: ${String(e)}`);
    });
  }
  assert.equal(state_signature(env.db), before, `${tag}: refused old-guard calls write nothing`);
  assert.equal(applied_receipt_count(env, old.run_id), 0, `${tag}: no applied input receipt`);
}

test("F1 review reproduction 1-6: OFF revokes the Go lease; the old guard stays dead through OFF and ON; a new claim is required", async () => {
  await with_env(async (env) => {
    // 1. bootstrap, mode A claim, dispatch prepare / authorize
    const old = await claim_go(env, "f1-claim");
    const authorized = await do_prepare(env, "f1-prep", old, "rk-f1-a");
    await do_authorize(env, "f1-auth", old, authorized);
    const prepared = await do_prepare(env, "f1-prep-2", old, "rk-f1-b");
    const input = make_input(env);
    // sanity: before OFF the guard works
    await heartbeat(env.service, env.ai_ctx("f1-hb-before"), guard(old));
    assert.equal(lease_row(env).state, "active");
    assert.equal(run_row(env.db, old.run_id).status, "running");

    // 2. a human owner turns Go OFF
    const off = await go_off(env, "f1-off");

    // 3. the lease is no longer active, the run is interrupted (not left running), the dispatches are blocked
    const lease = lease_row(env);
    assert.notEqual(lease.state, "active", "OFF must leave no active lease");
    assert.equal(run_row(env.db, old.run_id).status, "interrupted");
    assert.equal(dispatch_row(env.db, authorized).state, "blocked");
    assert.equal(dispatch_row(env.db, prepared).state, "blocked");
    assert.deepEqual(
      new Set((off.result as { blocked_dispatch_ids: string[] }).blocked_dispatch_ids),
      new Set([authorized, prepared]),
    );

    // 3-6 while OFF: heartbeat, applied input receipt, prepare/authorize/mark_sent and complete are refused
    await assert_old_guard_refused(env, old, "f1-off-phase", input, [authorized, prepared]);
    assert.equal(run_row(env.db, old.run_id).status, "interrupted", "complete did not run");

    // 5. Go is switched ON again: the old guard is still dead and no dispatch can reach "sent" with it
    await go_on(env, "f1-on");
    assert.notEqual(lease_row(env).state, "active", "ON must not revive the lease");
    assert.equal(run_row(env.db, old.run_id).status, "interrupted", "ON must not resume the run");
    await assert_old_guard_refused(env, old, "f1-on-phase", input, [authorized, prepared]);
    const sent_count = env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM outbound_dispatches WHERE state = 'sent'");
    assert.equal(sent_count?.n, 0n);

    // only a new claim (new fence) lets a new dispatch go through
    const fresh = await reclaim(env, "f1-reclaim", old.run_id);
    assert.ok(fresh.fence > old.fence, "the new claim gets a higher fence");
    assert.notEqual(fresh.lease_id, old.lease_id);
    assert.equal(run_row(env.db, old.run_id).status, "running");
    await assert_old_guard_refused(env, old, "f1-after-claim", input, [authorized, prepared]);

    const next = await do_prepare(env, "f1-prep-new", fresh, "rk-f1-c");
    await do_authorize(env, "f1-auth-new", fresh, next);
    await mark_sent(env.service, env.ai_ctx("f1-sent-new"), { dispatch_id: next, ...guard(fresh), external_request_id: "ext-f1" });
    assert.equal(dispatch_row(env.db, next).state, "sent");
    // the blocked history is not revived by the new claim
    assert.equal(dispatch_row(env.db, authorized).state, "blocked");
    assert.equal(dispatch_row(env.db, prepared).state, "blocked");
  });
});

test("F1 the lease change, the run interruption and the audit event are in the same transaction as policy.changed", async () => {
  await with_env(async (env) => {
    const l = await claim_go(env, "f1t-claim");
    await go_off(env, "f1t-off");
    const tx_id = receipt_id(env, "f1t-off");
    const events = events_of_tx(env, tx_id);
    assert.equal(events[0]?.type, "policy.changed");
    const audit = events.filter(
      (e) => e.run_id === l.run_id && e.type !== "policy.changed" && e.type !== "dispatch.blocked",
    );
    assert.ok(audit.length >= 1, `an audit event names the run; got ${events.map((e) => e.type).join(",")}`);
    for (const e of events) assert.doesNotThrow(() => JSON.parse(e.payload));
    // the audit trail is part of that one receipt: no second mutation_commits row for the revocation
    const commits = env.db.get<{ n: bigint }>(
      "SELECT count(*) AS n FROM mutation_commits WHERE client_request_id LIKE 'f1t-%'",
    );
    assert.equal(commits?.n, 2n, "only the claim and the OFF command have receipts");
  });
});

test("F1 a failing lease or run write rolls the whole OFF back: policy, dispatches, lease and run are unchanged", async () => {
  await with_env(async (env) => {
    const l = await claim_go(env, "f1r-claim");
    const d = await do_prepare(env, "f1r-prep", l, "rk-f1r");
    const before = state_signature(env.db);
    const policy_before = current_policy(env.db, env.project_id);

    for (const table of ["project_leases", "runs"] as const) {
      const broken = wrap_db(env.db, (sql) => {
        if (new RegExp(`\\b(UPDATE|DELETE\\s+FROM|INSERT\\s+INTO)\\s+${table}\\b`, "i").test(sql)) {
          throw new Error(`synthetic failure while writing ${table}`);
        }
      });
      const service = new CommandService(broken, { clock: env.clock, policy: new DbPolicyChecker(), run_config: TEST_CONFIG });
      await assert.rejects(
        set_policy(service, env.ctx(`f1r-off-${table}`), { allow_opencode_go: false, reason: "합성" }),
        /synthetic failure/,
      );
      assert.equal(state_signature(env.db), before, `${table}: nothing persisted`);
      assert.deepEqual(current_policy(env.db, env.project_id), policy_before);
      assert.equal(dispatch_row(env.db, d).state, "prepared");
    }
    // the lease still works, so the failed OFF did not half-revoke it
    await heartbeat(env.service, env.ai_ctx("f1r-hb"), guard(l));
  });
});

test("F1 a mode B run keeps its lease and stays running through OFF and ON", async () => {
  await with_env(async (env) => {
    const b = await claim_b(env, "f1b-claim");
    const lease_before = lease_row(env);
    const run_before = run_row(env.db, b.run_id);
    await go_off(env, "f1b-off");
    assert.deepEqual(lease_row(env), lease_before, "the B lease row is untouched");
    assert.deepEqual(run_row(env.db, b.run_id), run_before, "the B run row is untouched");
    const events = events_of_tx(env, receipt_id(env, "f1b-off"));
    assert.deepEqual(events.map((e) => e.type), ["policy.changed"], "no run event for a B run");
    // the B run is not a Go send: its lease keeps working during OFF
    await heartbeat(env.service, env.ai_ctx("f1b-hb"), guard(b));
    await go_on(env, "f1b-on");
    await heartbeat(env.service, env.ai_ctx("f1b-hb2"), guard(b));
    assert.equal(run_row(env.db, b.run_id).status, "running");
    assert.equal(lease_row(env).state, "active");
  });
});

test("F1 finished runs stay as they are: a completed Go run is not interrupted, a later Go run is", async () => {
  await with_env(async (env) => {
    const first = await claim_go(env, "f1d-claim-1");
    await complete(env.service, env.ai_ctx("f1d-done-1"), { ...guard(first), status: "succeeded" });
    const finished_run = run_row(env.db, first.run_id);
    assert.equal(finished_run.status, "succeeded");

    // with only a finished Go run, OFF touches neither the run nor the (released) lease
    const lease_released = lease_row(env);
    await go_off(env, "f1d-off-1");
    assert.deepEqual(run_row(env.db, first.run_id), finished_run);
    assert.deepEqual(lease_row(env), lease_released);
    assert.deepEqual(events_of_tx(env, receipt_id(env, "f1d-off-1")).map((e) => e.type), ["policy.changed"]);
    await go_on(env, "f1d-on-1");

    // a second, running Go run is the one OFF interrupts; the first stays succeeded
    const second = await claim_go(env, "f1d-claim-2");
    await go_off(env, "f1d-off-2");
    assert.equal(run_row(env.db, second.run_id).status, "interrupted");
    assert.deepEqual(run_row(env.db, first.run_id), finished_run, "the earlier finished run is unchanged");
    assert.notEqual(lease_row(env).state, "active");
  });
});

test("F1 OFF while the Go run sits with a released lease (no active lease) changes no lease and no run", async () => {
  await with_env(async (env) => {
    const a = await claim_go(env, "f1n-claim");
    const d = await do_prepare(env, "f1n-prep", a, "rk-f1n");
    await complete(env.service, env.ai_ctx("f1n-done"), { ...guard(a), status: "failed" });
    const run_before = run_row(env.db, a.run_id);
    const lease_before = lease_row(env);
    const out = await go_off(env, "f1n-off");
    assert.deepEqual(run_row(env.db, a.run_id), run_before);
    assert.deepEqual(lease_row(env), lease_before);
    // an unsent dispatch is still blocked by OFF, as before
    assert.equal(dispatch_row(env.db, d).state, "blocked");
    assert.deepEqual((out.result as { blocked_dispatch_ids: string[] }).blocked_dispatch_ids, [d]);
  });
});

test("F1 a rejected OFF (agent actor, invalid payload) does not touch the Go run or its lease", async () => {
  await with_env(async (env) => {
    const l = await claim_go(env, "f1x-claim");
    env.db.run(
      "INSERT INTO actors (id, kind, user_id, display_name) VALUES ('agent-f1x', 'external_agent', ?, '합성 에이전트')",
      env.owner_user_id,
    );
    const before = state_signature(env.db);
    await rejects_with_api_error(
      set_policy(env.service, env.ctx("f1x-agent", "agent-f1x"), { allow_opencode_go: false, reason: "합성" }),
      "forbidden",
    );
    await rejects_with_api_error(
      set_policy(env.service, env.ctx("f1x-bad"), { allow_opencode_go: "no", reason: "합성" }),
      "invalid_payload",
    );
    assert.equal(state_signature(env.db), before);
    assert.equal(lease_row(env).state, "active");
    await heartbeat(env.service, env.ai_ctx("f1x-hb"), guard(l));
  });
});

// ---------------------------------------------------------------------------
// F2. The policy checker's database handle is read-only for real

type CheckDb = Pick<Db, "get" | "all">;

/** SQL that must throw when the checker runs it through get() and through all(). */
const FORBIDDEN_SQL: Array<[string, string]> = [
  ["update returning (review reproduction)", "UPDATE projects SET topic = 'synthetic checker write' WHERE id = ? RETURNING topic"],
  ["update", "UPDATE projects SET topic = 'synthetic checker write' WHERE id = ?"],
  ["lowercase update", "update projects set topic = 'synthetic checker write' where id = ?"],
  ["comment + update", "/* harmless */ UPDATE projects SET topic = 'synthetic checker write' WHERE id = ?"],
  ["line comment + update", "-- harmless\nUPDATE projects SET topic = 'synthetic checker write' WHERE id = ?"],
  ["whitespace + update", "\n\t  UPDATE projects SET topic = 'synthetic checker write' WHERE id = ?"],
  ["cte + update", "WITH x AS (SELECT 1) UPDATE projects SET topic = 'synthetic checker write' WHERE id = ?"],
  ["insert", "INSERT INTO users (id, display_name, created_at) VALUES ('user-probe', 'probe', 0)"],
  ["insert returning", "INSERT INTO users (id, display_name, created_at) VALUES ('user-probe', 'probe', 0) RETURNING id"],
  ["insert or replace", "INSERT OR REPLACE INTO users (id, display_name, created_at) VALUES ('user-probe', 'probe', 0)"],
  ["replace into", "REPLACE INTO users (id, display_name, created_at) VALUES ('user-probe', 'probe', 0)"],
  ["delete", "DELETE FROM users WHERE id = 'user-probe'"],
  ["delete returning", "DELETE FROM mutation_commits RETURNING id"],
  ["create table", "CREATE TABLE probe_t (x INTEGER)"],
  ["drop table", "DROP TABLE agent_tokens"],
  ["alter table", "ALTER TABLE users ADD COLUMN probe TEXT"],
  ["vacuum", "VACUUM"],
  ["pragma foreign_keys off", "PRAGMA foreign_keys = OFF"],
  ["pragma ignore_check_constraints", "PRAGMA ignore_check_constraints = ON"],
  ["pragma user_version", "PRAGMA user_version = 99"],
  ["pragma read", "PRAGMA foreign_keys"],
  ["attach", "ATTACH DATABASE ':memory:' AS probe_db"],
  ["detach", "DETACH DATABASE probe_db"],
  ["begin", "BEGIN"],
  ["begin immediate", "BEGIN IMMEDIATE"],
  ["commit", "COMMIT"],
  ["rollback", "ROLLBACK"],
  ["savepoint", "SAVEPOINT probe_sp"],
  ["release", "RELEASE probe_sp"],
  ["two reads", "SELECT 1; SELECT 2"],
  ["read then write", "SELECT 1; UPDATE projects SET topic = 'synthetic checker write'"],
  ["write then read", "UPDATE projects SET topic = 'synthetic checker write'; SELECT 1"],
  ["empty", ""],
];

const ALLOWED_SQL: Array<[string, string]> = [
  ["select", "SELECT id, topic FROM projects WHERE id = ?"],
  ["lowercase select", "select id from projects where id = ?"],
  ["with select", "WITH p AS (SELECT id, topic FROM projects WHERE id = ?) SELECT topic FROM p"],
  ["select count", "SELECT count(*) AS n FROM users"],
];

function topic_of(env: Env): string {
  return String(row_of(env.db, "SELECT topic FROM projects WHERE id = ?", env.project_id).topic);
}

/** true when fn throws. */
function throws(fn: () => unknown): boolean {
  try {
    fn();
  } catch {
    return true;
  }
  return false;
}

/** The checker probes the handle during check(), keeps it, and allows the command. */
class ProbeChecker implements PolicyChecker {
  retained: CheckDb | null = null;
  calls = 0;
  inside: Array<{ label: string; via: "get" | "all"; threw: boolean }> = [];
  reads: Array<{ label: string; ok: boolean; rows: number }> = [];

  readonly project_id: () => string;

  constructor(project_id: () => string) {
    this.project_id = project_id;
  }

  check(_ctx: MutationContext, command: string, _payload: unknown, db: CheckDb): PolicyDecision {
    if (command !== "token.issue") return { allowed: true };
    this.calls += 1;
    this.retained = db;
    const id = this.project_id();
    for (const [label, sql] of FORBIDDEN_SQL) {
      const params: SqlValue[] = sql.includes("?") ? [id] : [];
      this.inside.push({ label, via: "get", threw: throws(() => db.get(sql, ...params)) });
      this.inside.push({ label, via: "all", threw: throws(() => db.all(sql, ...params)) });
    }
    for (const [label, sql] of ALLOWED_SQL) {
      const params: SqlValue[] = sql.includes("?") ? [id] : [];
      let ok = true;
      let rows = 0;
      try {
        rows = db.all(sql, ...params).length;
        db.get(sql, ...params);
      } catch {
        ok = false;
      }
      this.reads.push({ label, ok, rows });
    }
    return { allowed: true };
  }
}

function ensure_f2_agent(env: Env): void {
  env.db.run(
    "INSERT OR IGNORE INTO actors (id, kind, user_id, display_name) VALUES ('agent-f2', 'external_agent', ?, '합성 에이전트')",
    env.owner_user_id,
  );
}

async function issue_to_agent(env: Env, key: string): Promise<unknown> {
  ensure_f2_agent(env);
  return issue_agent_token(env.service, env.ctx(key), { actor_id: "agent-f2", scopes: ["run"] });
}

test("F2 every write / PRAGMA / ATTACH / transaction-control / multi-statement SQL throws inside check(); reads work", async () => {
  let project_for_probe = "";
  const probe = new ProbeChecker(() => project_for_probe);
  const env = await make_env(probe);
  try {
    project_for_probe = env.project_id;
    ensure_f2_agent(env);
    const topic_before = topic_of(env);
    const pragmas_before = {
      foreign_keys: row_of(env.db, "PRAGMA foreign_keys").foreign_keys,
      ignore_check_constraints: row_of(env.db, "PRAGMA ignore_check_constraints").ignore_check_constraints,
      user_version: row_of(env.db, "PRAGMA user_version").user_version,
    };
    const counts_before = table_counts(env.db);

    await issue_to_agent(env, "f2-probe");
    assert.equal(probe.calls, 1);

    for (const attempt of probe.inside) {
      assert.equal(attempt.threw, true, `${attempt.label} via ${attempt.via} must throw inside check()`);
    }
    for (const read of probe.reads) {
      assert.equal(read.ok, true, `${read.label} must still work`);
      assert.ok(read.rows >= 1, `${read.label} returns rows`);
    }

    // nothing the probes tried to do took effect
    assert.equal(topic_of(env), topic_before);
    assert.deepEqual(
      {
        foreign_keys: row_of(env.db, "PRAGMA foreign_keys").foreign_keys,
        ignore_check_constraints: row_of(env.db, "PRAGMA ignore_check_constraints").ignore_check_constraints,
        user_version: row_of(env.db, "PRAGMA user_version").user_version,
      },
      pragmas_before,
    );
    assert.equal(env.db.get("SELECT 1 FROM users WHERE id = 'user-probe'"), undefined);
    assert.equal(env.db.get("SELECT 1 FROM sqlite_master WHERE name = 'probe_t'"), undefined);
    assert.equal(env.db.get("SELECT 1 FROM pragma_database_list WHERE name = 'probe_db'"), undefined);
    const counts_after = table_counts(env.db);
    // the token.issue itself is the only change: one token, one receipt, one event
    const delta: Record<string, bigint> = {};
    for (const [table, n] of Object.entries(counts_after)) {
      if (n !== counts_before[table]) delta[table] = n - (counts_before[table] ?? 0n);
    }
    assert.deepEqual(delta, { agent_tokens: 1n, events: 1n, mutation_commits: 1n }, "only the token.issue rows were added");
    assert.ok(env.db.get("SELECT 1 FROM agent_tokens WHERE actor_id = 'agent-f2'"));
  } finally {
    env.close();
  }
});

test("F2 a handle kept after check() returned refuses get and all, for reads and writes alike", async () => {
  let project_id = "";
  const probe = new ProbeChecker(() => project_id);
  const env = await make_env(probe);
  try {
    project_id = env.project_id;
    await issue_to_agent(env, "f2k-issue");
    const retained = probe.retained;
    assert.ok(retained, "the checker kept the handle");
    const topic_before = topic_of(env);
    const before = state_signature(env.db);
    const attempts: Array<[string, () => unknown]> = [
      ["get select", () => retained.get("SELECT 1 AS one")],
      ["all select", () => retained.all("SELECT 1 AS one")],
      ["get select project", () => retained.get("SELECT id FROM projects WHERE id = ?", project_id)],
      ["all select project", () => retained.all("SELECT id FROM projects WHERE id = ?", project_id)],
      ["get update returning", () => retained.get("UPDATE projects SET topic = 'synthetic after transaction' WHERE id = ? RETURNING topic", project_id)],
      ["all update returning", () => retained.all("UPDATE projects SET topic = 'synthetic after transaction' WHERE id = ? RETURNING topic", project_id)],
      ["get insert", () => retained.get("INSERT INTO users (id, display_name, created_at) VALUES ('user-late', 'late', 0)")],
      ["all pragma", () => retained.all("PRAGMA foreign_keys = OFF")],
    ];
    for (const [label, attempt] of attempts) {
      assert.equal(throws(attempt), true, `${label} on a retained handle must throw`);
    }
    assert.equal(topic_of(env), topic_before);
    assert.equal(state_signature(env.db), before, "the retained handle changed nothing");
    assert.equal(env.db.get("SELECT 1 FROM users WHERE id = 'user-late'"), undefined);

    // the next command gets a handle that works again, and the earlier one stays dead
    await issue_agent_token(env.service, env.ctx("f2k-issue-2"), { actor_id: "agent-f2", scopes: [] });
    assert.notEqual(probe.retained, null);
    assert.equal(throws(() => retained.get("SELECT 1 AS one")), true, "the first handle is still dead");
  } finally {
    env.close();
  }
});

test("F2 review reproduction: a checker that UPDATEs projects.topic in check() cannot change the topic", async () => {
  let project_id = "";
  let kept: CheckDb | null = null;
  const evil: PolicyChecker = {
    check(_ctx, _command, _payload, db) {
      kept = db;
      db.get("UPDATE projects SET topic = 'synthetic checker write' WHERE id = ? RETURNING topic", project_id);
      return { allowed: true };
    },
  };
  const env = await make_env(evil);
  try {
    project_id = env.project_id;
    env.db.run(
      "INSERT INTO actors (id, kind, user_id, display_name) VALUES ('agent-f2e', 'external_agent', ?, '합성 에이전트')",
      env.owner_user_id,
    );
    const topic_before = topic_of(env);
    const before = state_signature(env.db);
    let failed = false;
    try {
      await issue_agent_token(env.service, env.ctx("f2e-issue"), { actor_id: "agent-f2e", scopes: ["run"] });
    } catch {
      failed = true;
    }
    assert.equal(topic_of(env), topic_before, "the topic did not change");
    if (failed) {
      // a failed command leaves no receipt, no event and no token
      assert.equal(state_signature(env.db), before, "a failed command writes nothing");
    }
    // the retained handle cannot write after the transaction either
    const handle = kept as CheckDb | null;
    assert.ok(handle);
    assert.equal(
      throws(() => handle.all("UPDATE projects SET topic = 'synthetic after transaction' WHERE id = ? RETURNING topic", project_id)),
      true,
    );
    assert.equal(topic_of(env), topic_before);
    const commits = env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM mutation_commits");
    const after_topic_change = env.db.get<{ n: bigint }>(
      "SELECT count(*) AS n FROM events WHERE type LIKE '%topic%'",
    );
    assert.ok((commits?.n ?? 0n) >= 1n);
    assert.equal(after_topic_change?.n, 0n);
  } finally {
    env.close();
  }
});

test("F2 the real DbPolicyChecker still reads the policy through the guarded handle (Go gate works, OFF and ON)", async () => {
  await with_env(async (env) => {
    await go_off(env, "f2g-off");
    const l = await claim_go(env, "f2g-claim"); // claim is not a Go send, so OFF does not stop it
    await rejects_with_api_error(
      prepare_dispatch(env.service, env.ai_ctx("f2g-prep-off"), prepare_payload(env, l, "rk-f2g-b")),
      "policy_denied",
    );
    await go_on(env, "f2g-on");
    const next = await do_prepare(env, "f2g-prep-on", l, "rk-f2g-c");
    assert.equal(dispatch_row(env.db, next).state, "prepared");
  });
});

// ---------------------------------------------------------------------------
// R1. token.issue applies the same eligibility rule as token verification

function insert_user(env: Env, id: string, disabled: boolean): void {
  env.db.run(
    "INSERT INTO users (id, display_name, created_at, disabled_at) VALUES (?, ?, 0, ?)",
    id,
    `합성 ${id}`,
    disabled ? BigInt(START_MS) : null,
  );
}

function insert_actor(env: Env, id: string, user_id: string | null, disabled: boolean): void {
  env.db.run(
    "INSERT INTO actors (id, kind, user_id, display_name, disabled_at) VALUES (?, 'external_agent', ?, ?, ?)",
    id,
    user_id,
    `합성 ${id}`,
    disabled ? BigInt(START_MS) : null,
  );
}

function join_project(env: Env, user_id: string): void {
  env.db.run("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'editor')", env.project_id, user_id);
}

function token_count(env: Env): bigint {
  return env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM agent_tokens")?.n ?? 0n;
}

test("R1 token.issue refuses an actor without a user, with a disabled user, a disabled actor, or outside the project; no row is written", async () => {
  await with_env(async (env) => {
    // userless agent actor (a member user cannot exist for it)
    insert_actor(env, "agent-nouser", null, false);
    // disabled user, member of the project
    insert_user(env, "user-dis", true);
    insert_actor(env, "agent-userdis", "user-dis", false);
    join_project(env, "user-dis");
    // disabled actor with an enabled member user
    insert_user(env, "user-actdis", false);
    insert_actor(env, "agent-actdis", "user-actdis", true);
    join_project(env, "user-actdis");
    // enabled actor and user, but not a member of this project
    insert_user(env, "user-out", false);
    insert_actor(env, "agent-out", "user-out", false);

    for (const actor_id of ["agent-nouser", "agent-userdis", "agent-actdis", "agent-out"]) {
      const before = state_signature(env.db);
      const err = await rejects_with_api_error(
        issue_agent_token(env.service, env.ctx(`r1-${actor_id}`), { actor_id, scopes: ["run"] }),
        ["forbidden", "not_found", "invalid_payload"],
      );
      assert.equal(/pes_[A-Za-z0-9_-]{20,}/.test(`${err.message}${JSON.stringify(err.details ?? null)}`), false);
      assert.equal(state_signature(env.db), before, `${actor_id}: nothing written`);
    }
    assert.equal(token_count(env), 0n, "no token row for any refused target");
    assert.equal(
      env.db.get("SELECT 1 FROM events WHERE type = 'token.issued'"),
      undefined,
      "no token.issued event",
    );
  });
});

test("R1 the same actors become issuable once they are eligible (control: the rule is eligibility, not blanket refusal)", async () => {
  await with_env(async (env) => {
    insert_user(env, "user-ok", false);
    insert_actor(env, "agent-ok", "user-ok", false);
    // not a member yet
    await rejects_with_api_error(
      issue_agent_token(env.service, env.ctx("r1c-1"), { actor_id: "agent-ok", scopes: ["run"] }),
      ["forbidden", "not_found", "invalid_payload"],
    );
    join_project(env, "user-ok");
    const ok = await issue_agent_token(env.service, env.ctx("r1c-2"), { actor_id: "agent-ok", scopes: ["run"] });
    assert.equal(ok.replayed, false);
    assert.equal(token_count(env), 1n);

    // a user disabled after joining is refused again
    env.db.run("UPDATE users SET disabled_at = ? WHERE id = 'user-ok'", BigInt(START_MS));
    await rejects_with_api_error(
      issue_agent_token(env.service, env.ctx("r1c-3"), { actor_id: "agent-ok", scopes: ["run"] }),
      ["forbidden", "not_found", "invalid_payload"],
    );
    assert.equal(token_count(env), 1n);
  });
});

test("R1 membership is per project: a member of another project only is refused in this one", async () => {
  await with_env(async (env) => {
    const other = await env.service.execute(
      { project_id: null, actor_id: null, via: "cli", client_request_id: "r1m-p2" },
      "project.bootstrap",
      { slug: "synthetic-final-other", topic: "다른 합성 주제", owner_display_name: "다른 소유자" },
    );
    const o = other.result as { project_id: string };
    insert_user(env, "user-p2", false);
    insert_actor(env, "agent-p2", "user-p2", false);
    env.db.run("INSERT INTO project_members (project_id, user_id, role) VALUES (?, 'user-p2', 'editor')", o.project_id);
    const before = state_signature(env.db);
    await rejects_with_api_error(
      issue_agent_token(env.service, env.ctx("r1m-issue"), { actor_id: "agent-p2", scopes: ["run"] }),
      ["forbidden", "not_found", "invalid_payload"],
    );
    assert.equal(state_signature(env.db), before);
    assert.equal(token_count(env), 0n);
  });
});

// ---------------------------------------------------------------------------
// R3. OFF / dispatch.block keep send evidence as "unknown"

/** Dispatches in the four shapes R3 cares about, all on one Go run. */
async function r3_world(env: Env) {
  const l = await claim_go(env, "r3-claim");
  const prepared = await do_prepare(env, "r3-p0", l, "rk-r3-0");
  const clean = await do_prepare(env, "r3-p1", l, "rk-r3-1");
  const with_sent_at = await do_prepare(env, "r3-p2", l, "rk-r3-2");
  const with_ext = await do_prepare(env, "r3-p3", l, "rk-r3-3");
  const with_both = await do_prepare(env, "r3-p4", l, "rk-r3-4");
  for (const [i, id] of [clean, with_sent_at, with_ext, with_both].entries()) {
    await do_authorize(env, `r3-a${i + 1}`, l, id);
  }
  // synthetic send evidence on an authorized row (the schema allows this combination)
  env.db.run("UPDATE outbound_dispatches SET sent_at = ? WHERE id = ?", BigInt(START_MS + 5), with_sent_at);
  env.db.run("UPDATE outbound_dispatches SET external_request_id = 'ext-r3-synthetic' WHERE id = ?", with_ext);
  env.db.run(
    "UPDATE outbound_dispatches SET sent_at = ?, external_request_id = 'ext-r3-both' WHERE id = ?",
    BigInt(START_MS + 6),
    with_both,
  );
  return { l, prepared, clean, with_sent_at, with_ext, with_both };
}

test("R3 Go OFF: an authorized row with sent_at or external_request_id becomes unknown with its evidence kept; clean rows are blocked", async () => {
  await with_env(async (env) => {
    const w = await r3_world(env);
    const evidence_before = {
      sent: dispatch_row(env.db, w.with_sent_at),
      ext: dispatch_row(env.db, w.with_ext),
      both: dispatch_row(env.db, w.with_both),
    };
    await go_off(env, "r3-off");

    assert.equal(dispatch_row(env.db, w.prepared).state, "blocked");
    assert.equal(dispatch_row(env.db, w.clean).state, "blocked");
    for (const [name, id, before] of [
      ["sent_at", w.with_sent_at, evidence_before.sent],
      ["external_request_id", w.with_ext, evidence_before.ext],
      ["both", w.with_both, evidence_before.both],
    ] as const) {
      const now = dispatch_row(env.db, id);
      assert.equal(now.state, "unknown", `${name}: evidence means unknown, not blocked`);
      assert.equal(now.sent_at, before.sent_at, `${name}: sent_at kept`);
      assert.equal(now.external_request_id, before.external_request_id, `${name}: external_request_id kept`);
      assert.equal(now.authorized_at, before.authorized_at, `${name}: authorized_at kept`);
      assert.notEqual(now.unknown_at, null, `${name}: unknown_at is set`);
      assert.equal(now.usage_json, null);
      assert.equal(now.cost_json, null);
    }
    // the clean rows carry no send evidence, and OFF does not invent any
    for (const id of [w.prepared, w.clean]) {
      const now = dispatch_row(env.db, id);
      assert.equal(now.sent_at, null);
      assert.equal(now.external_request_id, null);
    }
    // blocked history gets dispatch.blocked events for the blocked rows only
    const events = events_of_tx(env, receipt_id(env, "r3-off"));
    const blocked_ids = events
      .filter((e) => e.type === "dispatch.blocked")
      .map((e) => (JSON.parse(e.payload) as { dispatch_id: string }).dispatch_id);
    assert.deepEqual(new Set(blocked_ids), new Set([w.prepared, w.clean]));
  });
});

test("R3 ON does not revive or change an unknown row, and a new claim cannot send it", async () => {
  await with_env(async (env) => {
    const w = await r3_world(env);
    await go_off(env, "r3b-off");
    const unknown_before = [w.with_sent_at, w.with_ext, w.with_both].map((id) => dispatch_row(env.db, id));
    await go_on(env, "r3b-on");
    const fresh = await reclaim(env, "r3b-reclaim", w.l.run_id);
    for (const [i, id] of [w.with_sent_at, w.with_ext, w.with_both].entries()) {
      await rejects_with_api_error(mark_sent(env.service, env.ai_ctx(`r3b-sent-${i}`), { dispatch_id: id, ...guard(fresh) }), "conflict");
      await rejects_with_api_error(authorize_dispatch(env.service, env.ai_ctx(`r3b-auth-${i}`), { dispatch_id: id, ...guard(fresh) }), "conflict");
    }
    assert.deepEqual([w.with_sent_at, w.with_ext, w.with_both].map((id) => dispatch_row(env.db, id)), unknown_before);
  });
});

test("R3 dispatch.block follows the same rule: evidence -> unknown (kept), no evidence -> blocked; prepared -> blocked", async () => {
  await with_env(async (env) => {
    const w = await r3_world(env);
    const before = {
      sent: dispatch_row(env.db, w.with_sent_at),
      ext: dispatch_row(env.db, w.with_ext),
      both: dispatch_row(env.db, w.with_both),
    };
    for (const [key, id] of [
      ["r3c-b-sent", w.with_sent_at],
      ["r3c-b-ext", w.with_ext],
      ["r3c-b-both", w.with_both],
    ] as const) {
      await block_dispatch(env.service, env.ctx(key), { dispatch_id: id, reason: "합성: 수동 차단" });
    }
    await block_dispatch(env.service, env.ctx("r3c-b-clean"), { dispatch_id: w.clean, reason: "합성: 수동 차단" });
    await block_dispatch(env.service, env.ctx("r3c-b-prepared"), { dispatch_id: w.prepared, reason: "합성: 수동 차단" });

    for (const [id, b] of [
      [w.with_sent_at, before.sent],
      [w.with_ext, before.ext],
      [w.with_both, before.both],
    ] as const) {
      const now = dispatch_row(env.db, id);
      assert.equal(now.state, "unknown");
      assert.equal(now.sent_at, b.sent_at);
      assert.equal(now.external_request_id, b.external_request_id);
      assert.notEqual(now.unknown_at, null);
    }
    assert.equal(dispatch_row(env.db, w.clean).state, "blocked");
    assert.equal(dispatch_row(env.db, w.prepared).state, "blocked");
    // an unknown row is final: a second block is refused and changes nothing
    const signature = state_signature(env.db);
    await rejects_with_api_error(
      block_dispatch(env.service, env.ctx("r3c-again"), { dispatch_id: w.with_both, reason: "합성" }),
      "conflict",
    );
    assert.equal(state_signature(env.db), signature);
  });
});

test("R3 sent, response and failed history stays as it is when OFF runs next to an evidence row", async () => {
  await with_env(async (env) => {
    const l = await claim_go(env, "r3d-claim");
    const sent = await do_prepare(env, "r3d-p1", l, "rk-r3d-1");
    await do_authorize(env, "r3d-a1", l, sent);
    await mark_sent(env.service, env.ai_ctx("r3d-s1"), { dispatch_id: sent, ...guard(l), external_request_id: "ext-r3d" });
    const evidence = await do_prepare(env, "r3d-p2", l, "rk-r3d-2");
    await do_authorize(env, "r3d-a2", l, evidence);
    env.db.run("UPDATE outbound_dispatches SET external_request_id = 'ext-r3d-2' WHERE id = ?", evidence);
    const sent_before = dispatch_row(env.db, sent);
    await go_off(env, "r3d-off");
    assert.deepEqual(dispatch_row(env.db, sent), sent_before, "a really sent row is not edited by OFF");
    assert.equal(dispatch_row(env.db, evidence).state, "unknown");
    assert.equal(dispatch_row(env.db, evidence).external_request_id, "ext-r3d-2");
  });
});

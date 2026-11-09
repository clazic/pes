// SEL-38 (stage 2 PR5): run / lease / fence tests, written before the implementation.
//
// Command names (registered in COMMANDS by scripts/pes_core/commands/runs.ts) and what they do:
//   run.claim          new run (payload {mode, runtime, provider, model, role?, parent_run_id?}) or
//                      re-claim of an existing run (payload {run_id}) whose status is queued /
//                      waiting_human / blocked_usage / interrupted. Needs no active, unexpired lease
//                      on the project. Run -> running, lease -> active, fence = previous fence + 1
//                      (first lease: 1). result {project_id, run_id, lease_id, fence, expires_at,
//                      heartbeat_interval_ms}. Receipt action/event type "run.claimed".
//   run.heartbeat      payload {run_id, lease_id, fence}; expires_at = now + lease_ttl_ms.
//                      result {project_id, run_id, lease_id, fence, expires_at}. "run.heartbeat".
//   run.wait           payload {run_id, lease_id, fence, reason?}: run -> waiting_human, lease ->
//                      released (fence kept), event + receipt, ONE tx. "run.waiting_human".
//   run.complete       payload {run_id, lease_id, fence, status?: 'succeeded'|'failed'} (default
//                      succeeded): run ends, lease released. Never an approval. "run.completed".
//   run.release        payload {run_id, lease_id, fence}: lease released, run -> queued. "run.released".
//   run.handoff        payload {run_id, lease_id, fence}: lease released, run -> queued. "run.handed_off".
//   run.interrupt      payload {run_id, lease_id, fence}: lease released, run -> interrupted.
//                      "run.interrupted".
//   run.record_receipt payload {run_id, lease_id, fence, input_version_id, state: 'seen'|'applied'|
//                      'ignored', reason?, applied_tx_id?}. 'applied' needs an applied_tx_id that is
//                      a mutation_commits.id of the same project (else ApiError invalid_payload).
//                      Recording an input that is already 'applied' (same run, or a run whose
//                      parent_run_id chain applied it) does not apply it again: result
//                      {already_applied: true}, the stored applied_tx_id is unchanged.
//                      "run.input_receipt_recorded".
//   Every lease-guarded command (all but a fresh claim) is rejected with ApiError code "conflict"
//   when the lease is not the project's current active, unexpired lease with that exact
//   lease_id AND fence. A rejection writes nothing. A lease is expired when now >= expires_at.
//   Receipts (mutation_commits) of lease-guarded commands carry run_id, lease_id and fence;
//   events carry run_id (events.run_id).
//
// scripts/pes_core/runs.ts: public functions, each runs exactly one CommandService.execute:
//   claim(service, ctx, input), heartbeat(service, ctx, input), wait(...), complete(...),
//   release(...), handoff(...), interrupt(...), record_receipt(...)
//   -> Promise<CommandOutcome>   (service: CommandService, ctx: MutationContext, input: payload)
//
// scripts/pes_core/config.ts:
//   interface RunConfig { lease_ttl_ms: number; heartbeat_interval_ms: number }
//   resolve_run_config(overrides?: Partial<RunConfig>, env?: Record<string, string | undefined>): RunConfig
//     precedence: overrides > env (PES_LEASE_TTL_MS, PES_HEARTBEAT_INTERVAL_MS) > settings default.
//   new CommandService(db, { clock, policy, run_config?: RunConfig }): run commands read the TTL
//   and heartbeat interval from the injected run_config (omitted -> resolve_run_config()).
//
// Static write allow-list: tests/test_command_service.test.ts and ..._hardening.test.ts allow
// writes under scripts/pes_core/commands/ by folder path; runs.ts and config.ts stay write-free.

import assert from "node:assert/strict";
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
import { resolve_run_config, type RunConfig } from "../scripts/pes_core/config.ts";
import {
  claim,
  complete,
  handoff,
  heartbeat,
  interrupt,
  record_receipt,
  release,
  wait,
} from "../scripts/pes_core/runs.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { isolated_home, type IsolatedHome } from "./helpers/isolated_home.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

const START_MS = 1_760_000_000_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "..", "scripts", "pes_core");
const TEST_CONFIG: RunConfig = { lease_ttl_ms: 60_000, heartbeat_interval_ms: 20_000 };
const RUN_COMMANDS = [
  "run.claim",
  "run.heartbeat",
  "run.wait",
  "run.complete",
  "run.release",
  "run.handoff",
  "run.interrupt",
  "run.record_receipt",
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
      : ({ allowed: false, reason: "synthetic policy: runs are OFF" } as const);
  }
}

interface Project {
  project_id: string;
  actor_id: string;
}

interface Env {
  home: IsolatedHome;
  db: Db;
  clock: FakeClock;
  policy: FakePolicy;
  service: CommandService;
  p: Project;
  ctx(key: string): MutationContext;
  with_db(db: Db): CommandService;
  close(): void;
}

interface Lease {
  run_id: string;
  lease_id: string;
  fence: number;
  expires_at: number;
  heartbeat_interval_ms?: number;
}

async function make_env(config: RunConfig = TEST_CONFIG): Promise<Env> {
  const home = isolated_home("pes-sel38-");
  const db = connect(db_path(home.env));
  migrate(db);
  const clock = new FakeClock(START_MS);
  const policy = new FakePolicy();
  const service = new CommandService(db, { clock, policy, run_config: config });
  const out = await service.execute(
    { project_id: null, actor_id: null, via: "cli", client_request_id: "setup-p" },
    "project.bootstrap",
    { slug: "synthetic-runs", topic: "합성 run 주제", owner_display_name: "합성 소유자" },
  );
  const r = out.result as { project_id: string; owner_actor_id: string };
  const p = { project_id: r.project_id, actor_id: r.owner_actor_id };
  policy.calls = 0;
  return {
    home,
    db,
    clock,
    policy,
    service,
    p,
    ctx: (key) => ({ project_id: p.project_id, actor_id: p.actor_id, via: "cli", client_request_id: key }),
    with_db: (wrapped) => new CommandService(wrapped, { clock, policy, run_config: config }),
    close() {
      db.close();
      home.cleanup();
    },
  };
}

async function with_env(fn: (env: Env) => Promise<void> | void, config?: RunConfig): Promise<void> {
  const env = await make_env(config);
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
  assert.fail("expected the command to be rejected");
}

const NEW_RUN = { mode: "B", runtime: "synthetic-runtime", provider: "synthetic", model: "synthetic-model" };

async function claim_new(env: Env, key: string, extra: Record<string, unknown> = {}): Promise<Lease> {
  const out = await claim(env.service, env.ctx(key), { ...NEW_RUN, ...extra });
  assert.equal(out.replayed, false);
  return out.result as Lease;
}

async function reclaim(env: Env, key: string, run_id: string): Promise<Lease> {
  const out = await claim(env.service, env.ctx(key), { run_id });
  return out.result as Lease;
}

function guard(l: Lease): { run_id: string; lease_id: string; fence: number } {
  return { run_id: l.run_id, lease_id: l.lease_id, fence: l.fence };
}

interface LeaseRow {
  lease_id: string;
  run_id: string | null;
  fence: bigint;
  state: string;
  acquired_at: bigint;
  heartbeat_at: bigint;
  expires_at: bigint;
}

function lease_row(db: Db, project_id: string): LeaseRow {
  const row = db.get<LeaseRow>("SELECT * FROM project_leases WHERE project_id = ?", project_id);
  assert.ok(row, "the project has a lease row");
  return row;
}

function run_row(db: Db, run_id: string) {
  const row = db.get<{ status: string; started_at: bigint | null; ended_at: bigint | null }>(
    "SELECT status, started_at, ended_at FROM runs WHERE id = ?",
    run_id,
  );
  assert.ok(row, "the run exists");
  return row;
}

function receipt_for(db: Db, project_id: string, key: string) {
  return db.get<{
    id: string;
    action: string;
    run_id: string | null;
    lease_id: string | null;
    fence: bigint | null;
  }>(
    "SELECT id, action, run_id, lease_id, fence FROM mutation_commits WHERE project_id = ? AND client_request_id = ?",
    project_id,
    key,
  );
}

function events_of(db: Db, tx_id: string) {
  return db.all<{ type: string; run_id: string | null }>(
    "SELECT type, run_id FROM events WHERE tx_id = ? ORDER BY tx_index",
    tx_id,
  );
}

/** Creates an object version (an "input") plus returns a real receipt id usable as evidence. */
function make_input(env: Env, name: string): { input_version_id: string; evidence_tx_id: string } {
  const { project_id, actor_id } = env.p;
  const tx = env.db.get<{ id: string }>("SELECT id FROM mutation_commits WHERE project_id = ? LIMIT 1", project_id);
  assert.ok(tx);
  const object_id = `obj-${name}`;
  const version_id = `ver-${name}`;
  env.db.run(
    "INSERT INTO objects (id, project_id, kind, display_no) VALUES (?, ?, 'artifact', ?)",
    object_id,
    project_id,
    BigInt(1 + env.db.all("SELECT 1 FROM objects").length),
  );
  env.db.run(
    `INSERT INTO object_versions (id, project_id, object_id, kind, version_no, actor_id, tx_id, content_hash)
     VALUES (?, ?, ?, 'artifact', 1, ?, ?, ?)`,
    version_id,
    project_id,
    object_id,
    actor_id,
    tx.id,
    "a".repeat(64),
  );
  return { input_version_id: version_id, evidence_tx_id: tx.id };
}

// ---------------------------------------------------------------------------
// Registry

test("the eight run commands are registered under their own distinct actions", () => {
  const actions = new Set<string>();
  for (const name of RUN_COMMANDS) {
    const def = COMMANDS.get(name);
    assert.ok(def, `${name} is registered`);
    assert.equal(def.scope, "project");
    actions.add(def.action);
  }
  assert.equal(actions.size, RUN_COMMANDS.length);
});

// ---------------------------------------------------------------------------
// 1. claim: one active lease per project, fence goes up

test("claim creates a running run and an active lease with fence 1, receipt and event carry run/lease/fence", async () => {
  await with_env(async (env) => {
    const l = await claim_new(env, "c-1");
    assert.equal(l.fence, 1);
    const row = lease_row(env.db, env.p.project_id);
    assert.equal(row.state, "active");
    assert.equal(row.run_id, l.run_id);
    assert.equal(row.lease_id, l.lease_id);
    assert.equal(row.fence, 1n);
    assert.equal(row.acquired_at, BigInt(START_MS));
    assert.equal(row.heartbeat_at, BigInt(START_MS));
    assert.equal(row.expires_at, BigInt(START_MS + TEST_CONFIG.lease_ttl_ms));
    assert.equal(l.expires_at, START_MS + TEST_CONFIG.lease_ttl_ms);
    assert.equal(l.heartbeat_interval_ms, TEST_CONFIG.heartbeat_interval_ms);
    const run = run_row(env.db, l.run_id);
    assert.equal(run.status, "running");
    assert.equal(run.started_at, BigInt(START_MS));

    const rc = receipt_for(env.db, env.p.project_id, "c-1");
    assert.ok(rc);
    assert.equal(rc.action, "run.claimed");
    assert.equal(rc.run_id, l.run_id);
    assert.equal(rc.lease_id, l.lease_id);
    assert.equal(rc.fence, 1n);
    const events = events_of(env.db, rc.id);
    assert.deepEqual(
      events.map((e) => e.type),
      ["run.claimed"],
    );
    assert.equal(events[0]!.run_id, l.run_id);
  });
});

test("a second run cannot claim while another run holds an unexpired lease", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "c-a");
    env.clock.advance(TEST_CONFIG.lease_ttl_ms - 1);
    const sig = state_signature(env.db);
    await rejects_with_api_error(claim(env.service, env.ctx("c-b"), NEW_RUN), "conflict");
    assert.equal(state_signature(env.db), sig, "a refused claim writes nothing, not even a run row");
    const row = lease_row(env.db, env.p.project_id);
    assert.equal(row.run_id, a.run_id);
    assert.equal(row.fence, 1n);
    assert.equal(
      env.db.all("SELECT 1 FROM project_leases WHERE project_id = ? AND state = 'active'", env.p.project_id).length,
      1,
    );
  });
});

test("the same run cannot claim a second lease on top of its own active lease", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "c-self");
    const sig = state_signature(env.db);
    await rejects_with_api_error(claim(env.service, env.ctx("c-self-2"), { run_id: a.run_id }), "conflict");
    assert.equal(state_signature(env.db), sig);
  });
});

test("fence only goes up: expiry, release and re-claim each add one", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "f-a");
    assert.equal(a.fence, 1);

    env.clock.advance(TEST_CONFIG.lease_ttl_ms); // exactly at expires_at => expired
    const b = await claim_new(env, "f-b");
    assert.equal(b.fence, 2);
    assert.notEqual(b.lease_id, a.lease_id);
    assert.equal(lease_row(env.db, env.p.project_id).run_id, b.run_id);

    await release(env.service, env.ctx("f-b-rel"), guard(b));
    assert.equal(lease_row(env.db, env.p.project_id).fence, 2n, "release keeps the fence");
    const c = await claim_new(env, "f-c");
    assert.equal(c.fence, 3);

    await rejects_with_api_error(reclaim(env, "f-d-prep", c.run_id), "conflict");
    await interrupt(env.service, env.ctx("f-c-int"), guard(c));
    const again = await reclaim(env, "f-c-again", c.run_id);
    assert.equal(again.fence, 4);
    assert.equal(again.run_id, c.run_id);
  });
});

test("claim refuses a run that already ended", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "e-a");
    await complete(env.service, env.ctx("e-a-done"), guard(a));
    const sig = state_signature(env.db);
    await rejects_with_api_error(claim(env.service, env.ctx("e-a-again"), { run_id: a.run_id }), "conflict");
    assert.equal(state_signature(env.db), sig);
  });
});

test("claim rejects a malformed payload and an unknown run without writing", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    await rejects_with_api_error(claim(env.service, env.ctx("m-1"), { mode: "B" }), "invalid_payload");
    await rejects_with_api_error(claim(env.service, env.ctx("m-2"), { ...NEW_RUN, mode: "Z" }), "invalid_payload");
    await rejects_with_api_error(claim(env.service, env.ctx("m-3"), { run_id: "no-such-run" }), "not_found");
    assert.equal(state_signature(env.db), sig);
  });
});

// ---------------------------------------------------------------------------
// 2. expired leases are never revived; old fences are refused

test("heartbeat before expiry extends the lease from now; at exactly expires_at it is too late", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "h-a");
    env.clock.advance(TEST_CONFIG.lease_ttl_ms - 1);
    const hb = await heartbeat(env.service, env.ctx("h-1"), guard(a));
    const now = START_MS + TEST_CONFIG.lease_ttl_ms - 1;
    assert.equal((hb.result as Lease).expires_at, now + TEST_CONFIG.lease_ttl_ms);
    const row = lease_row(env.db, env.p.project_id);
    assert.equal(row.heartbeat_at, BigInt(now));
    assert.equal(row.expires_at, BigInt(now + TEST_CONFIG.lease_ttl_ms));
    assert.equal(row.fence, 1n, "heartbeat does not bump the fence");
    const rc = receipt_for(env.db, env.p.project_id, "h-1");
    assert.ok(rc);
    assert.equal(rc.action, "run.heartbeat");
    assert.equal(rc.lease_id, a.lease_id);
    assert.equal(rc.fence, 1n);

    env.clock.advance(TEST_CONFIG.lease_ttl_ms); // now == expires_at
    const sig = state_signature(env.db);
    await rejects_with_api_error(heartbeat(env.service, env.ctx("h-2"), guard(a)), "conflict");
    assert.equal(state_signature(env.db), sig);
  });
});

type Call = (e: Env, l: Lease, input: { input_version_id: string; evidence_tx_id: string }) => Promise<unknown>;

for (const [name, call] of [
  ["heartbeat", (e, l) => heartbeat(e.service, e.ctx("x-late"), guard(l))],
  ["wait", (e, l) => wait(e.service, e.ctx("x-late"), guard(l))],
  ["complete", (e, l) => complete(e.service, e.ctx("x-late"), guard(l))],
  ["release", (e, l) => release(e.service, e.ctx("x-late"), guard(l))],
  ["handoff", (e, l) => handoff(e.service, e.ctx("x-late"), guard(l))],
  ["interrupt", (e, l) => interrupt(e.service, e.ctx("x-late"), guard(l))],
  [
    "record_receipt",
    (e, l, i) =>
      record_receipt(e.service, e.ctx("x-late"), {
        ...guard(l),
        input_version_id: i.input_version_id,
        state: "seen",
      }),
  ],
] as [string, Call][]) {
  test(`an expired lease is not revived by ${name}: rejected, nothing written`, async () => {
    await with_env(async (env) => {
      const a = await claim_new(env, "x-a");
      const input = make_input(env, "late");
      env.clock.advance(TEST_CONFIG.lease_ttl_ms + 5_000);
      const sig = state_signature(env.db);
      const lease_before = lease_row(env.db, env.p.project_id);
      await rejects_with_api_error(call(env, a, input), "conflict");
      assert.equal(state_signature(env.db), sig);
      assert.deepEqual(lease_row(env.db, env.p.project_id), lease_before, "the lease row is untouched");
      assert.equal(run_row(env.db, a.run_id).status, "running");
      assert.equal(receipt_for(env.db, env.p.project_id, "x-late"), undefined);
    });
  });
}

test("after another run takes over, the old run's lease_id and fence are refused", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "t-a");
    env.clock.advance(TEST_CONFIG.lease_ttl_ms);
    const b = await claim_new(env, "t-b");
    assert.equal(b.fence, 2);

    const sig = state_signature(env.db);
    // the old holder, with both its old lease_id and old fence
    await rejects_with_api_error(heartbeat(env.service, env.ctx("t-1"), guard(a)), "conflict");
    // the new lease_id but the old fence
    await rejects_with_api_error(
      heartbeat(env.service, env.ctx("t-2"), { run_id: b.run_id, lease_id: b.lease_id, fence: 1 }),
      "conflict",
    );
    // the old lease_id but the new fence
    await rejects_with_api_error(
      heartbeat(env.service, env.ctx("t-3"), { run_id: b.run_id, lease_id: a.lease_id, fence: 2 }),
      "conflict",
    );
    // the new lease on behalf of the other run
    await rejects_with_api_error(
      heartbeat(env.service, env.ctx("t-4"), { run_id: a.run_id, lease_id: b.lease_id, fence: 2 }),
      "conflict",
    );
    // a fence from the future
    await rejects_with_api_error(
      heartbeat(env.service, env.ctx("t-5"), { run_id: b.run_id, lease_id: b.lease_id, fence: 3 }),
      "conflict",
    );
    assert.equal(state_signature(env.db), sig, "every refused write left nothing behind");

    const ok = await heartbeat(env.service, env.ctx("t-ok"), guard(b));
    assert.equal(ok.replayed, false);
  });
});

test("a released lease cannot be used again (no revival after release)", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "r-a");
    await release(env.service, env.ctx("r-rel"), guard(a));
    const sig = state_signature(env.db);
    await rejects_with_api_error(heartbeat(env.service, env.ctx("r-hb"), guard(a)), "conflict");
    await rejects_with_api_error(complete(env.service, env.ctx("r-done"), guard(a)), "conflict");
    assert.equal(state_signature(env.db), sig);
    assert.equal(lease_row(env.db, env.p.project_id).state, "released");
  });
});

// ---------------------------------------------------------------------------
// 3. wait: one transaction

test("wait puts the run in waiting_human, releases the lease and leaves event + receipt", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "w-a");
    env.clock.advance(1_000);
    const out = await wait(env.service, env.ctx("w-1"), { ...guard(a), reason: "사람 답변 대기" });
    assert.equal(out.replayed, false);
    assert.equal(run_row(env.db, a.run_id).status, "waiting_human");
    const row = lease_row(env.db, env.p.project_id);
    assert.equal(row.state, "released");
    assert.equal(row.fence, 1n);
    const rc = receipt_for(env.db, env.p.project_id, "w-1");
    assert.ok(rc);
    assert.equal(rc.action, "run.waiting_human");
    assert.equal(rc.run_id, a.run_id);
    assert.equal(rc.lease_id, a.lease_id);
    assert.equal(rc.fence, 1n);
    const events = events_of(env.db, rc.id);
    assert.deepEqual(events.map((e) => e.type), ["run.waiting_human"]);
    assert.equal(events[0]!.run_id, a.run_id);
    assert.equal(
      env.db.all("SELECT 1 FROM project_leases WHERE project_id = ? AND state = 'active'", env.p.project_id).length,
      0,
    );
  });
});

for (const [label, pattern] of [
  ["run update", /^\s*UPDATE\s+runs\b/i],
  ["lease update", /^\s*(?:UPDATE|INSERT(?:\s+OR\s+\w+)?\s+INTO)\s+project_leases\b/i],
  ["events insert", /^\s*INSERT\s+INTO\s+events\b/i],
  ["receipt insert", /^\s*INSERT\s+INTO\s+mutation_commits\b/i],
] as const) {
  test(`wait: a failure at the ${label} rolls everything back (run, lease, event, receipt)`, async () => {
    await with_env(async (env) => {
      const a = await claim_new(env, "wf-a");
      env.clock.advance(1_000);
      const sig = state_signature(env.db);
      const counts = table_counts(env.db);
      const failing = wrap_db(env.db, (sql) => {
        if (pattern.test(sql)) throw new Error("injected wait failure");
      });
      await assert.rejects(
        async () => wait(env.with_db(failing), env.ctx("wf-1"), guard(a)),
        /injected wait failure/,
      );
      assert.equal(state_signature(env.db), sig);
      assert.deepEqual(table_counts(env.db), counts);
      assert.equal(run_row(env.db, a.run_id).status, "running");
      assert.equal(lease_row(env.db, env.p.project_id).state, "active");

      const retry = await wait(env.service, env.ctx("wf-1"), guard(a));
      assert.equal(retry.replayed, false, "the failed attempt left no receipt");
      assert.equal(run_row(env.db, a.run_id).status, "waiting_human");
    });
  });
}

test("after wait the run can claim again and gets a new, higher fence", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "ra-a");
    await wait(env.service, env.ctx("ra-w"), guard(a));
    env.clock.advance(10_000);
    const again = await reclaim(env, "ra-again", a.run_id);
    assert.equal(again.run_id, a.run_id);
    assert.equal(again.fence, 2);
    assert.notEqual(again.lease_id, a.lease_id);
    assert.equal(run_row(env.db, a.run_id).status, "running");
    assert.equal(lease_row(env.db, env.p.project_id).state, "active");

    // the pre-wait lease stays dead even though the run is running again
    await rejects_with_api_error(heartbeat(env.service, env.ctx("ra-old"), guard(a)), "conflict");
    // and while it waited, another run could have taken the project
  });
});

test("while a run waits, another run may claim; the waiting run then cannot re-claim until it is free", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "wo-a");
    await wait(env.service, env.ctx("wo-w"), guard(a));
    const b = await claim_new(env, "wo-b");
    assert.equal(b.fence, 2);
    const sig = state_signature(env.db);
    await rejects_with_api_error(claim(env.service, env.ctx("wo-a2"), { run_id: a.run_id }), "conflict");
    assert.equal(state_signature(env.db), sig);
    assert.equal(run_row(env.db, a.run_id).status, "waiting_human");
  });
});

// ---------------------------------------------------------------------------
// 4. applied needs evidence

test("an input receipt can be 'applied' only with applied_tx_id evidence", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "ap-a");
    const input = make_input(env, "ap");
    const base = { ...guard(a), input_version_id: input.input_version_id };

    const sig = state_signature(env.db);
    await rejects_with_api_error(
      record_receipt(env.service, env.ctx("ap-1"), { ...base, state: "applied" }),
      "invalid_payload",
    );
    await rejects_with_api_error(
      record_receipt(env.service, env.ctx("ap-2"), { ...base, state: "applied", applied_tx_id: "" }),
      "invalid_payload",
    );
    assert.equal(state_signature(env.db), sig, "no row, receipt or event for refused attempts");

    // evidence that is not a receipt of this project is not evidence
    await assert.rejects(
      async () =>
        record_receipt(env.service, env.ctx("ap-3"), { ...base, state: "applied", applied_tx_id: "no-such-tx" }),
      "a made-up applied_tx_id is refused",
    );
    assert.equal(state_signature(env.db), sig, "and leaves nothing behind");

    const ok = await record_receipt(env.service, env.ctx("ap-4"), {
      ...base,
      state: "applied",
      applied_tx_id: input.evidence_tx_id,
    });
    assert.equal(ok.replayed, false);
    const row = env.db.get<{ state: string; applied_tx_id: string | null }>(
      "SELECT state, applied_tx_id FROM run_input_receipts WHERE run_id = ? AND input_version_id = ?",
      a.run_id,
      input.input_version_id,
    );
    assert.deepEqual(row, { state: "applied", applied_tx_id: input.evidence_tx_id });
    const rc = receipt_for(env.db, env.p.project_id, "ap-4");
    assert.ok(rc);
    assert.equal(rc.action, "run.input_receipt_recorded");
    assert.equal(rc.fence, 1n);
    assert.equal(rc.lease_id, a.lease_id);
  });
});

test("'seen' and 'ignored' need no evidence and an unknown state is refused", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "si-a");
    const one = make_input(env, "si1");
    const two = make_input(env, "si2");
    await record_receipt(env.service, env.ctx("si-1"), {
      ...guard(a),
      input_version_id: one.input_version_id,
      state: "seen",
    });
    await record_receipt(env.service, env.ctx("si-2"), {
      ...guard(a),
      input_version_id: two.input_version_id,
      state: "ignored",
      reason: "범위 밖",
    });
    const rows = env.db.all<{ state: string }>("SELECT state FROM run_input_receipts ORDER BY input_version_id");
    assert.deepEqual(rows.map((r) => r.state), ["seen", "ignored"]);
    const sig = state_signature(env.db);
    await rejects_with_api_error(
      record_receipt(env.service, env.ctx("si-3"), { ...guard(a), input_version_id: one.input_version_id, state: "done" }),
      "invalid_payload",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

// ---------------------------------------------------------------------------
// 5. hand-off: the same input is not applied twice

test("after interrupt + re-claim, an input already applied is not applied again", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "h5-a");
    const input = make_input(env, "h5");
    await record_receipt(env.service, env.ctx("h5-1"), {
      ...guard(a),
      input_version_id: input.input_version_id,
      state: "applied",
      applied_tx_id: input.evidence_tx_id,
    });
    await interrupt(env.service, env.ctx("h5-int"), guard(a));
    assert.equal(run_row(env.db, a.run_id).status, "interrupted");
    const b = await reclaim(env, "h5-re", a.run_id);
    assert.equal(b.fence, 2);

    const before = env.db.all("SELECT * FROM run_input_receipts");
    const again = await record_receipt(env.service, env.ctx("h5-2"), {
      ...guard(b),
      input_version_id: input.input_version_id,
      state: "applied",
      applied_tx_id: input.evidence_tx_id,
    });
    assert.equal((again.result as { already_applied?: boolean }).already_applied, true);
    assert.deepEqual(env.db.all("SELECT * FROM run_input_receipts"), before, "still exactly one applied row");
  });
});

test("a run that continues after handoff (parent_run_id) does not re-apply the parent's applied input", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "hc-a");
    const input = make_input(env, "hc");
    await record_receipt(env.service, env.ctx("hc-1"), {
      ...guard(a),
      input_version_id: input.input_version_id,
      state: "applied",
      applied_tx_id: input.evidence_tx_id,
    });
    await handoff(env.service, env.ctx("hc-h"), guard(a));
    assert.equal(run_row(env.db, a.run_id).status, "queued");
    const b = await claim_new(env, "hc-b", { parent_run_id: a.run_id });
    assert.notEqual(b.run_id, a.run_id);
    assert.equal(b.fence, 2);

    const out = await record_receipt(env.service, env.ctx("hc-2"), {
      ...guard(b),
      input_version_id: input.input_version_id,
      state: "applied",
      applied_tx_id: input.evidence_tx_id,
    });
    assert.equal((out.result as { already_applied?: boolean }).already_applied, true);
    const applied = env.db.all(
      "SELECT run_id FROM run_input_receipts WHERE input_version_id = ? AND state = 'applied'",
      input.input_version_id,
    );
    assert.equal(applied.length, 1, "the input is applied once across the hand-off");
  });
});

test("recording the same input twice in one run does not create a second row or change the evidence", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "d-a");
    const input = make_input(env, "d");
    const payload = {
      ...guard(a),
      input_version_id: input.input_version_id,
      state: "applied",
      applied_tx_id: input.evidence_tx_id,
    };
    await record_receipt(env.service, env.ctx("d-1"), payload);
    const second = await record_receipt(env.service, env.ctx("d-2"), payload);
    assert.equal((second.result as { already_applied?: boolean }).already_applied, true);
    assert.equal(env.db.all("SELECT 1 FROM run_input_receipts WHERE run_id = ?", a.run_id).length, 1);
  });
});

// ---------------------------------------------------------------------------
// 6. complete is not an approval

test("complete ends the run and releases the lease but approves nothing", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "cp-a");
    const stages_before = env.db.all("SELECT id, status, approved_snapshot_id, stale_since_event_seq, rev FROM stages ORDER BY id");
    const counts_before = table_counts(env.db);
    env.clock.advance(5_000);

    const out = await complete(env.service, env.ctx("cp-1"), guard(a));
    assert.equal(out.replayed, false);
    const run = run_row(env.db, a.run_id);
    assert.equal(run.status, "succeeded");
    assert.equal(run.ended_at, BigInt(START_MS + 5_000));
    assert.equal(lease_row(env.db, env.p.project_id).state, "released");

    assert.deepEqual(
      env.db.all("SELECT id, status, approved_snapshot_id, stale_since_event_seq, rev FROM stages ORDER BY id"),
      stages_before,
      "no stage changes status or approval",
    );
    const counts = table_counts(env.db);
    for (const table of ["approvals", "snapshots", "rounds"]) {
      assert.equal(counts[table], counts_before[table], `${table} is untouched`);
    }
    const rc = receipt_for(env.db, env.p.project_id, "cp-1");
    assert.ok(rc);
    assert.equal(rc.action, "run.completed");
    const events = events_of(env.db, rc.id);
    assert.deepEqual(events.map((e) => e.type), ["run.completed"]);
    for (const e of events) assert.doesNotMatch(e.type, /approv|seal|stage/i);
    assert.equal(env.db.all("SELECT 1 FROM stages WHERE status = 'approved'").length, 0);
  });
});

test("complete can end a run as failed but never as an arbitrary status", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "cs-a");
    const sig = state_signature(env.db);
    await rejects_with_api_error(
      complete(env.service, env.ctx("cs-bad"), { ...guard(a), status: "approved" }),
      "invalid_payload",
    );
    await rejects_with_api_error(
      complete(env.service, env.ctx("cs-bad2"), { ...guard(a), status: "waiting_human" }),
      "invalid_payload",
    );
    assert.equal(state_signature(env.db), sig);
    await complete(env.service, env.ctx("cs-ok"), { ...guard(a), status: "failed" });
    assert.equal(run_row(env.db, a.run_id).status, "failed");
  });
});

// ---------------------------------------------------------------------------
// release / handoff / interrupt

for (const [name, fn, status] of [
  ["release", release, "queued"],
  ["handoff", handoff, "queued"],
  ["interrupt", interrupt, "interrupted"],
] as const) {
  test(`${name} releases the lease, sets the run to ${status}, and records event + receipt`, async () => {
    await with_env(async (env) => {
      const a = await claim_new(env, `${name}-a`);
      await fn(env.service, env.ctx(`${name}-1`), guard(a));
      assert.equal(lease_row(env.db, env.p.project_id).state, "released");
      assert.equal(run_row(env.db, a.run_id).status, status);
      const rc = receipt_for(env.db, env.p.project_id, `${name}-1`);
      assert.ok(rc);
      assert.equal(rc.run_id, a.run_id);
      assert.equal(rc.lease_id, a.lease_id);
      assert.equal(rc.fence, 1n);
      const events = events_of(env.db, rc.id);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.run_id, a.run_id);
      // the project is free: a different run can claim at once, fence + 1
      const b = await claim_new(env, `${name}-b`);
      assert.equal(b.fence, 2);
    });
  });
}

// ---------------------------------------------------------------------------
// 7. TTL / heartbeat values come from configuration

test("the lease TTL and heartbeat interval come from the injected config, not a constant", async () => {
  for (const config of [
    { lease_ttl_ms: 5_000, heartbeat_interval_ms: 1_500 },
    { lease_ttl_ms: 90_000, heartbeat_interval_ms: 45_000 },
  ] satisfies RunConfig[]) {
    await with_env(async (env) => {
      const a = await claim_new(env, "cfg-a");
      assert.equal(a.expires_at - START_MS, config.lease_ttl_ms);
      assert.equal(a.heartbeat_interval_ms, config.heartbeat_interval_ms);
      assert.equal(lease_row(env.db, env.p.project_id).expires_at, BigInt(START_MS + config.lease_ttl_ms));

      env.clock.advance(config.lease_ttl_ms - 1);
      await heartbeat(env.service, env.ctx("cfg-hb"), guard(a));
      env.clock.advance(config.lease_ttl_ms); // exactly TTL after the heartbeat
      await rejects_with_api_error(heartbeat(env.service, env.ctx("cfg-late"), guard(a)), "conflict");
      const b = await claim_new(env, "cfg-b");
      assert.equal(b.fence, 2, "expiry happened exactly at the configured TTL");
    }, config);
  }
});

test("resolve_run_config: overrides beat env, env beats the settings default, values are sane", () => {
  const defaults = resolve_run_config({}, {});
  assert.ok(Number.isSafeInteger(defaults.lease_ttl_ms) && defaults.lease_ttl_ms > 0);
  assert.ok(Number.isSafeInteger(defaults.heartbeat_interval_ms) && defaults.heartbeat_interval_ms > 0);
  assert.ok(defaults.heartbeat_interval_ms < defaults.lease_ttl_ms, "heartbeat is more frequent than expiry");

  const from_env = resolve_run_config(undefined, {
    PES_LEASE_TTL_MS: "12345",
    PES_HEARTBEAT_INTERVAL_MS: "2345",
  });
  assert.deepEqual(from_env, { lease_ttl_ms: 12345, heartbeat_interval_ms: 2345 });

  const overridden = resolve_run_config(
    { lease_ttl_ms: 777 },
    { PES_LEASE_TTL_MS: "12345", PES_HEARTBEAT_INTERVAL_MS: "100" },
  );
  assert.deepEqual(overridden, { lease_ttl_ms: 777, heartbeat_interval_ms: 100 });
});

test("resolve_run_config rejects non-positive, non-integer or inverted values", () => {
  assert.throws(() => resolve_run_config({ lease_ttl_ms: 0 }, {}));
  assert.throws(() => resolve_run_config({ lease_ttl_ms: -1 }, {}));
  assert.throws(() => resolve_run_config({ lease_ttl_ms: 1.5 }, {}));
  assert.throws(() => resolve_run_config({}, { PES_LEASE_TTL_MS: "abc" }));
  assert.throws(() => resolve_run_config({ lease_ttl_ms: 1_000, heartbeat_interval_ms: 1_000 }, {}));
});

test("without an injected config the service uses resolve_run_config() defaults", async () => {
  const home = isolated_home("pes-sel38-cfg-");
  const db = connect(db_path(home.env));
  try {
    migrate(db);
    const clock = new FakeClock(START_MS);
    const service = new CommandService(db, { clock, policy: new FakePolicy() });
    const boot = await service.execute(
      { project_id: null, actor_id: null, via: "cli", client_request_id: "d-setup" },
      "project.bootstrap",
      { slug: "synthetic-default", topic: "t", owner_display_name: "o" },
    );
    const r = boot.result as { project_id: string; owner_actor_id: string };
    const out = await claim(
      service,
      { project_id: r.project_id, actor_id: r.owner_actor_id, via: "cli", client_request_id: "d-claim" },
      NEW_RUN,
    );
    const l = out.result as Lease;
    const defaults = resolve_run_config();
    assert.equal(l.expires_at - START_MS, defaults.lease_ttl_ms);
    assert.equal(l.heartbeat_interval_ms, defaults.heartbeat_interval_ms);
  } finally {
    db.close();
    home.cleanup();
  }
});

test("run sources hard-code no TTL/heartbeat numbers", () => {
  for (const rel of ["runs.ts", join("commands", "runs.ts")]) {
    const source = readFileSync(join(CORE_DIR, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(source, /\b(?:ttl|heartbeat|lease)\w*\s*[:=]\s*\d/i, `${rel}: no numeric TTL/heartbeat assignment`);
    assert.doesNotMatch(source, /\b\d{1,3}(?:_\d{3})+\b|\b\d{4,}\b/, `${rel}: no large numeric literal (ms constants)`);
  }
});

// ---------------------------------------------------------------------------
// 8. PR4 rules hold for every run command

type Scenario = {
  command: (typeof RUN_COMMANDS)[number];
  payload: (l: Lease, input: { input_version_id: string; evidence_tx_id: string }) => Record<string, unknown>;
};

const SCENARIOS: Scenario[] = [
  { command: "run.claim", payload: () => ({ ...NEW_RUN }) },
  { command: "run.heartbeat", payload: (l) => guard(l) },
  { command: "run.wait", payload: (l) => ({ ...guard(l), reason: "대기" }) },
  { command: "run.complete", payload: (l) => guard(l) },
  { command: "run.release", payload: (l) => guard(l) },
  { command: "run.handoff", payload: (l) => guard(l) },
  { command: "run.interrupt", payload: (l) => guard(l) },
  {
    command: "run.record_receipt",
    payload: (l, i) => ({ ...guard(l), input_version_id: i.input_version_id, state: "seen" }),
  },
];

for (const scenario of SCENARIOS) {
  test(`${scenario.command}: policy runs before replay, same key replays, a different request is refused`, async () => {
    await with_env(async (env) => {
      // claim is the first command of a project; the others need a live lease first
      const lease = scenario.command === "run.claim" ? undefined : await claim_new(env, "pol-setup");
      const input = make_input(env, "pol");
      const payload = scenario.payload(lease ?? ({} as Lease), input);

      const first = await env.service.execute(env.ctx("pol-1"), scenario.command, payload);
      assert.equal(first.replayed, false);
      const sig = state_signature(env.db);
      env.policy.calls = 0;

      // policy first: a denial wins over an existing receipt for the same key
      env.policy.allowed = false;
      await rejects_with_api_error(env.service.execute(env.ctx("pol-1"), scenario.command, payload), "policy_denied");
      assert.equal(env.policy.calls, 1, "the policy was asked before any replay");
      assert.equal(state_signature(env.db), sig);

      // allowed again: same key + same request replays the stored result with no new writes
      env.policy.allowed = true;
      env.clock.advance(TEST_CONFIG.lease_ttl_ms * 3); // even the lease is long gone
      const sig_after_clock = state_signature(env.db);
      const replay = await env.service.execute(env.ctx("pol-1"), scenario.command, payload);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.result, first.result);
      assert.equal(state_signature(env.db), sig_after_clock);

      // same key, different request
      await rejects_with_api_error(
        env.service.execute(env.ctx("pol-1"), scenario.command, { ...payload, extra: "다른 요청" }),
        "idempotency_key_reuse",
      );
      assert.equal(state_signature(env.db), sig_after_clock);
    });
  });
}

test("run commands are denied by policy before touching run state, even for a fresh key", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    env.policy.allowed = false;
    await rejects_with_api_error(claim(env.service, env.ctx("den-1"), NEW_RUN), "policy_denied");
    assert.equal(state_signature(env.db), sig);
  });
});

test("the public functions are thin: each one equals service.execute of its command", async () => {
  await with_env(async (env) => {
    const via_fn = await claim(env.service, env.ctx("thin-1"), NEW_RUN);
    const via_service = await env.service.execute(env.ctx("thin-1"), "run.claim", NEW_RUN);
    assert.equal(via_service.replayed, true, "claim() created the receipt for run.claim");
    assert.deepEqual(via_service.result, via_fn.result);

    const lease = via_fn.result as Lease;
    const hb = await heartbeat(env.service, env.ctx("thin-2"), guard(lease));
    const hb_again = await env.service.execute(env.ctx("thin-2"), "run.heartbeat", guard(lease));
    assert.equal(hb_again.replayed, true);
    assert.deepEqual(hb_again.result, hb.result);
  });
});

test("an actor outside the project cannot use run commands", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    await rejects_with_api_error(
      claim(env.service, { ...env.ctx("out-1"), actor_id: "no-such-actor" }, NEW_RUN),
      "forbidden",
    );
    await rejects_with_api_error(
      claim(env.service, { ...env.ctx("out-2"), project_id: "no-such-project" }, NEW_RUN),
      "not_found",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

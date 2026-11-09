// SEL-38 hardening: extra edge cases for run / lease / fence (tests only).
import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeClock } from "../scripts/pes_core/clock.ts";
import { connect, migrate, type Db, type RunResult, type SqlValue } from "../scripts/pes_core/db.ts";
import { ApiError } from "../scripts/pes_core/errors.ts";
import { CommandService, type MutationContext, type PolicyChecker } from "../scripts/pes_core/commands.ts";
import type { RunConfig } from "../scripts/pes_core/config.ts";
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
const CFG: RunConfig = { lease_ttl_ms: 60_000, heartbeat_interval_ms: 20_000 };
const NEW_RUN = { mode: "B", runtime: "synthetic-runtime", provider: "synthetic", model: "synthetic-model" };

class AllowAll implements PolicyChecker {
  check() {
    return { allowed: true } as const;
  }
}

interface P {
  project_id: string;
  actor_id: string;
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
  p: P;
  q: P; // a second project in the same database
  ctx(key: string, who?: P): MutationContext;
  with_db(db: Db): CommandService;
  close(): void;
}

async function make_env(config: RunConfig = CFG): Promise<Env> {
  const home = isolated_home("pes-sel38h-");
  const db = connect(db_path(home.env));
  migrate(db);
  const clock = new FakeClock(START_MS);
  const service = new CommandService(db, { clock, policy: new AllowAll(), run_config: config });
  const boot = async (slug: string): Promise<P> => {
    const out = await service.execute(
      { project_id: null, actor_id: null, via: "cli", client_request_id: `setup-${slug}` },
      "project.bootstrap",
      { slug, topic: "합성 주제", owner_display_name: "합성 소유자" },
    );
    const r = out.result as { project_id: string; owner_actor_id: string };
    return { project_id: r.project_id, actor_id: r.owner_actor_id };
  };
  const p = await boot("synthetic-h1");
  const q = await boot("synthetic-h2");
  return {
    home,
    db,
    clock,
    service,
    p,
    q,
    ctx: (key, who = p) => ({ project_id: who.project_id, actor_id: who.actor_id, via: "cli", client_request_id: key }),
    with_db: (w) => new CommandService(w, { clock, policy: new AllowAll(), run_config: config }),
    close() {
      db.close();
      home.cleanup();
    },
  };
}

async function with_env(fn: (env: Env) => Promise<void>, config?: RunConfig): Promise<void> {
  const env = await make_env(config);
  try {
    await fn(env);
  } finally {
    env.close();
  }
}

async function rejects_code(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail("expected rejection");
}

async function claim_new(env: Env, key: string, who: P = env.p, extra: Record<string, unknown> = {}): Promise<Lease> {
  const out = await claim(env.service, env.ctx(key, who), { ...NEW_RUN, ...extra });
  return out.result as Lease;
}

function g(l: Lease) {
  return { run_id: l.run_id, lease_id: l.lease_id, fence: l.fence };
}

function lease_row(db: Db, project_id: string) {
  const row = db.get<{ state: string; fence: bigint; expires_at: bigint; run_id: string | null; lease_id: string }>(
    "SELECT state, fence, expires_at, run_id, lease_id FROM project_leases WHERE project_id = ?",
    project_id,
  );
  assert.ok(row);
  return row;
}

function run_status(db: Db, run_id: string): string {
  const row = db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", run_id);
  assert.ok(row);
  return row.status;
}

function any_tx(db: Db, project_id: string): string {
  const row = db.get<{ id: string }>("SELECT id FROM mutation_commits WHERE project_id = ? LIMIT 1", project_id);
  assert.ok(row);
  return row.id;
}

let seq = 0;
function make_input(env: Env, who: P, name: string): string {
  seq += 1;
  const tx = any_tx(env.db, who.project_id);
  const object_id = `hobj-${name}-${seq}`;
  const version_id = `hver-${name}-${seq}`;
  env.db.run(
    "INSERT INTO objects (id, project_id, kind, display_no) VALUES (?, ?, 'artifact', ?)",
    object_id,
    who.project_id,
    BigInt(seq),
  );
  env.db.run(
    `INSERT INTO object_versions (id, project_id, object_id, kind, version_no, actor_id, tx_id, content_hash)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    version_id,
    who.project_id,
    object_id,
    "artifact",
    who.actor_id,
    tx,
    "b".repeat(64),
  );
  return version_id;
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

// --- expiry boundary --------------------------------------------------------

test("one ms before expires_at the lease still works for every guarded command; at expires_at claim succeeds", async () => {
  for (const name of ["heartbeat", "wait", "complete", "release", "handoff", "interrupt"] as const) {
    await with_env(async (env) => {
      const a = await claim_new(env, "e-a");
      env.clock.advance(CFG.lease_ttl_ms - 1);
      const fn = { heartbeat, wait, complete, release, handoff, interrupt }[name];
      const out = await fn(env.service, env.ctx("e-1"), g(a));
      assert.equal(out.replayed, false, name);
    });
  }
  await with_env(async (env) => {
    const a = await claim_new(env, "e-a");
    env.clock.advance(CFG.lease_ttl_ms); // now == expires_at
    const b = await claim_new(env, "e-b");
    assert.equal(b.fence, a.fence + 1);
    assert.notEqual(b.lease_id, a.lease_id);
  });
});

test("claim exactly one ms before expiry is refused and writes nothing", async () => {
  await with_env(async (env) => {
    await claim_new(env, "e2-a");
    env.clock.advance(CFG.lease_ttl_ms - 1);
    const sig = state_signature(env.db);
    await rejects_code(claim(env.service, env.ctx("e2-b"), NEW_RUN), "conflict");
    assert.equal(state_signature(env.db), sig);
  });
});

test("record_receipt at now == expires_at is refused even for a valid input, and nothing is stored", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "e3-a");
    const input = make_input(env, env.p, "e3");
    env.clock.advance(CFG.lease_ttl_ms);
    const counts = table_counts(env.db);
    await rejects_code(
      record_receipt(env.service, env.ctx("e3-1"), { ...g(a), input_version_id: input, state: "seen" }),
      "conflict",
    );
    assert.deepEqual(table_counts(env.db), counts);
  });
});

// --- claim: finished runs, concurrency, release state -----------------------

test("a succeeded, failed or interrupted-then-completed run cannot be claimed again", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "f-a");
    await complete(env.service, env.ctx("f-done"), { ...g(a), status: "failed" });
    const sig = state_signature(env.db);
    await rejects_code(claim(env.service, env.ctx("f-re"), { run_id: a.run_id }), "conflict");
    assert.equal(state_signature(env.db), sig);

    const b = await claim_new(env, "f-b");
    await complete(env.service, env.ctx("f-done2"), g(b));
    await rejects_code(claim(env.service, env.ctx("f-re2"), { run_id: b.run_id }), "conflict");
    assert.equal(run_status(env.db, b.run_id), "succeeded");
  });
});

test("an interrupted run ends (ended_at set) and its re-claim clears ended_at", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "i-a");
    await interrupt(env.service, env.ctx("i-1"), g(a));
    const ended = env.db.get<{ ended_at: bigint | null }>("SELECT ended_at FROM runs WHERE id = ?", a.run_id);
    assert.notEqual(ended?.ended_at, null);
    await claim(env.service, env.ctx("i-2"), { run_id: a.run_id });
    const again = env.db.get<{ ended_at: bigint | null; status: string }>(
      "SELECT ended_at, status FROM runs WHERE id = ?",
      a.run_id,
    );
    assert.equal(again?.ended_at, null);
    assert.equal(again?.status, "running");
  });
});

test("two claims racing for one project: exactly one wins, the other leaves nothing behind", async () => {
  await with_env(async (env) => {
    const results = await Promise.allSettled([
      claim(env.service, env.ctx("race-1"), NEW_RUN),
      claim(env.service, env.ctx("race-2"), NEW_RUN),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(lost.reason instanceof ApiError);
    assert.equal(lost.reason.code, "conflict");
    assert.equal(env.db.all("SELECT 1 FROM runs WHERE project_id = ?", env.p.project_id).length, 1);
    assert.equal(
      env.db.all("SELECT 1 FROM project_leases WHERE project_id = ? AND state = 'active'", env.p.project_id).length,
      1,
    );
  });
});

test("claim of a queued run that is not queued-after-release (running) is refused", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "r-a");
    env.clock.advance(CFG.lease_ttl_ms + 1); // lease expired but run still 'running'
    await rejects_code(claim(env.service, env.ctx("r-b"), { run_id: a.run_id }), "conflict");
  });
});

// --- project isolation ------------------------------------------------------

test("leases of two projects are independent: both can hold one, fences count separately", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "p-a", env.p);
    const b = await claim_new(env, "p-b", env.q);
    assert.equal(a.fence, 1);
    assert.equal(b.fence, 1);
    assert.notEqual(a.lease_id, b.lease_id);
    await release(env.service, env.ctx("p-rel", env.p), g(a));
    assert.equal(lease_row(env.db, env.q.project_id).state, "active", "the other project is untouched");
    assert.equal(lease_row(env.db, env.p.project_id).state, "released");
  });
});

test("a lease of project B cannot guard commands in project A, and the other way round", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "x-a", env.p);
    const b = await claim_new(env, "x-b", env.q);
    const sig = state_signature(env.db);
    await rejects_code(heartbeat(env.service, env.ctx("x-1", env.p), g(b)), "conflict");
    await rejects_code(wait(env.service, env.ctx("x-2", env.q), g(a)), "conflict");
    await rejects_code(complete(env.service, env.ctx("x-3", env.p), g(b)), "conflict");
    await rejects_code(handoff(env.service, env.ctx("x-4", env.p), g(b)), "conflict");
    assert.equal(state_signature(env.db), sig);
  });
});

test("claiming another project's run id is not found, and a foreign parent_run_id is refused", async () => {
  await with_env(async (env) => {
    const b = await claim_new(env, "y-b", env.q);
    await complete(env.service, env.ctx("y-bdone", env.q), g(b));
    const sig = state_signature(env.db);
    await rejects_code(claim(env.service, env.ctx("y-1", env.p), { run_id: b.run_id }), "not_found");
    await rejects_code(
      claim(env.service, env.ctx("y-2", env.p), { ...NEW_RUN, parent_run_id: b.run_id }),
      "not_found",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

test("record_receipt refuses an applied_tx_id or input version that belongs to another project", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "z-a", env.p);
    const mine = make_input(env, env.p, "z-mine");
    const theirs = make_input(env, env.q, "z-theirs");
    const foreign_tx = any_tx(env.db, env.q.project_id);
    const own_tx = any_tx(env.db, env.p.project_id);
    const sig = state_signature(env.db);
    await rejects_code(
      record_receipt(env.service, env.ctx("z-1"), {
        ...g(a),
        input_version_id: mine,
        state: "applied",
        applied_tx_id: foreign_tx,
      }),
      "invalid_payload",
    );
    await rejects_code(
      record_receipt(env.service, env.ctx("z-2"), {
        ...g(a),
        input_version_id: theirs,
        state: "applied",
        applied_tx_id: own_tx,
      }),
      "invalid_payload",
    );
    await rejects_code(
      record_receipt(env.service, env.ctx("z-3"), { ...g(a), input_version_id: theirs, state: "seen" }),
      "invalid_payload",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

test("an input applied in project A does not make the same-named flow 'already applied' in project B", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "w-a", env.p);
    const b = await claim_new(env, "w-b", env.q);
    const ia = make_input(env, env.p, "wa");
    const ib = make_input(env, env.q, "wb");
    await record_receipt(env.service, env.ctx("w-1", env.p), {
      ...g(a),
      input_version_id: ia,
      state: "applied",
      applied_tx_id: any_tx(env.db, env.p.project_id),
    });
    const out = await record_receipt(env.service, env.ctx("w-2", env.q), {
      ...g(b),
      input_version_id: ib,
      state: "applied",
      applied_tx_id: any_tx(env.db, env.q.project_id),
    });
    assert.equal((out.result as { already_applied: boolean }).already_applied, false);
  });
});

// --- stale fences / mixed guards on every command ---------------------------

test("after takeover, wait/complete/record_receipt/release/handoff/interrupt with the old fence all fail untouched", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "s-a");
    const input = make_input(env, env.p, "s");
    env.clock.advance(CFG.lease_ttl_ms);
    const b = await claim_new(env, "s-b");
    const sig = state_signature(env.db);
    const counts = table_counts(env.db);
    let i = 0;
    const k = () => `s-old-${(i += 1)}`;
    await rejects_code(wait(env.service, env.ctx(k()), g(a)), "conflict");
    await rejects_code(complete(env.service, env.ctx(k()), g(a)), "conflict");
    await rejects_code(release(env.service, env.ctx(k()), g(a)), "conflict");
    await rejects_code(handoff(env.service, env.ctx(k()), g(a)), "conflict");
    await rejects_code(interrupt(env.service, env.ctx(k()), g(a)), "conflict");
    await rejects_code(
      record_receipt(env.service, env.ctx(k()), { ...g(a), input_version_id: input, state: "seen" }),
      "conflict",
    );
    // right lease id + run, wrong fence (older) for the live holder
    await rejects_code(wait(env.service, env.ctx(k()), { ...g(b), fence: a.fence }), "conflict");
    assert.equal(state_signature(env.db), sig);
    assert.deepEqual(table_counts(env.db), counts);
    assert.equal(run_status(env.db, b.run_id), "running");
  });
});

test("an old fence of a run that is already waiting cannot complete it", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "ow-a");
    await wait(env.service, env.ctx("ow-1"), g(a));
    const sig = state_signature(env.db);
    await rejects_code(complete(env.service, env.ctx("ow-2"), g(a)), "conflict");
    assert.equal(state_signature(env.db), sig);
    assert.equal(run_status(env.db, a.run_id), "waiting_human");
  });
});

test("malformed guards (fence 0, negative, float, string, missing ids) are invalid_payload and write nothing", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "m-a");
    const sig = state_signature(env.db);
    for (const bad of [
      { ...g(a), fence: 0 },
      { ...g(a), fence: -1 },
      { ...g(a), fence: 1.5 },
      { ...g(a), fence: "1" },
      { ...g(a), lease_id: "" },
      { run_id: a.run_id, fence: a.fence },
    ]) {
      await rejects_code(heartbeat(env.service, env.ctx("m-x"), bad as never), "invalid_payload");
    }
    assert.equal(state_signature(env.db), sig);
  });
});

// --- wait atomicity ----------------------------------------------------------

test("wait: failing at the receipt insert after run/lease updates ran rolls back all of them (also event count)", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "wa-a");
    const events_before = env.db.all("SELECT 1 FROM events").length;
    const receipts_before = env.db.all("SELECT 1 FROM mutation_commits").length;
    const seen: string[] = [];
    const failing = wrap_db(env.db, (sql) => {
      seen.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (/^\s*INSERT\s+INTO\s+mutation_commits\b/i.test(sql)) throw new Error("boom-late");
    });
    await assert.rejects(async () => wait(env.with_db(failing), env.ctx("wa-1"), g(a)), /boom-late/);
    assert.ok(seen.some((s) => /^UPDATE runs/i.test(s)), "run was updated before the failure");
    assert.equal(run_status(env.db, a.run_id), "running");
    assert.equal(lease_row(env.db, env.p.project_id).state, "active");
    assert.equal(env.db.all("SELECT 1 FROM events").length, events_before);
    assert.equal(env.db.all("SELECT 1 FROM mutation_commits").length, receipts_before);
  });
});

for (const [name, call] of [
  ["complete", (e: Env, a: Lease, s: CommandService) => complete(s, e.ctx("rb-1"), g(a))],
  ["release", (e: Env, a: Lease, s: CommandService) => release(s, e.ctx("rb-1"), g(a))],
  ["handoff", (e: Env, a: Lease, s: CommandService) => handoff(s, e.ctx("rb-1"), g(a))],
  ["interrupt", (e: Env, a: Lease, s: CommandService) => interrupt(s, e.ctx("rb-1"), g(a))],
] as const) {
  test(`${name}: failure while writing the event rolls back run, lease and receipt`, async () => {
    await with_env(async (env) => {
      const a = await claim_new(env, "rb-a");
      const sig = state_signature(env.db);
      const counts = table_counts(env.db);
      const failing = wrap_db(env.db, (sql) => {
        if (/^\s*INSERT\s+INTO\s+events\b/i.test(sql)) throw new Error("boom-event");
      });
      await assert.rejects(async () => call(env, a, env.with_db(failing)), /boom-event/);
      assert.equal(state_signature(env.db), sig);
      assert.deepEqual(table_counts(env.db), counts);
      assert.equal(run_status(env.db, a.run_id), "running");
      assert.equal(lease_row(env.db, env.p.project_id).state, "active");
    });
  });
}

test("claim: failure while writing the lease rolls back the new run too", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    const counts = table_counts(env.db);
    const failing = wrap_db(env.db, (sql) => {
      if (/^\s*(?:UPDATE|INSERT(?:\s+OR\s+\w+)?\s+INTO)\s+project_leases\b/i.test(sql)) throw new Error("boom-lease");
    });
    await assert.rejects(async () => claim(env.with_db(failing), env.ctx("cf-1"), NEW_RUN), /boom-lease/);
    assert.equal(state_signature(env.db), sig);
    assert.deepEqual(table_counts(env.db), counts);
  });
});

// --- hand-off chain ---------------------------------------------------------

test("a three-run chain (a -> b -> c) does not re-apply an input applied by the grandparent", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "c-a");
    const input = make_input(env, env.p, "chain");
    const tx = any_tx(env.db, env.p.project_id);
    await record_receipt(env.service, env.ctx("c-1"), {
      ...g(a),
      input_version_id: input,
      state: "applied",
      applied_tx_id: tx,
    });
    await handoff(env.service, env.ctx("c-h1"), g(a));
    const b = await claim_new(env, "c-b", env.p, { parent_run_id: a.run_id });
    await handoff(env.service, env.ctx("c-h2"), g(b));
    const c = await claim_new(env, "c-c", env.p, { parent_run_id: b.run_id });
    const out = await record_receipt(env.service, env.ctx("c-2"), {
      ...g(c),
      input_version_id: input,
      state: "applied",
      applied_tx_id: tx,
    });
    const r = out.result as { already_applied: boolean; applied_tx_id: string };
    assert.equal(r.already_applied, true);
    assert.equal(r.applied_tx_id, tx);
    assert.equal(
      env.db.all("SELECT 1 FROM run_input_receipts WHERE input_version_id = ?", input).length,
      1,
    );
  });
});

test("after handoff an input only 'seen' by the parent can still be applied by the child exactly once", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "sn-a");
    const input = make_input(env, env.p, "seen");
    await record_receipt(env.service, env.ctx("sn-1"), { ...g(a), input_version_id: input, state: "seen" });
    await handoff(env.service, env.ctx("sn-h"), g(a));
    const b = await claim_new(env, "sn-b", env.p, { parent_run_id: a.run_id });
    const tx = any_tx(env.db, env.p.project_id);
    const first = await record_receipt(env.service, env.ctx("sn-2"), {
      ...g(b),
      input_version_id: input,
      state: "applied",
      applied_tx_id: tx,
    });
    assert.equal((first.result as { already_applied: boolean }).already_applied, false);
    const second = await record_receipt(env.service, env.ctx("sn-3"), {
      ...g(b),
      input_version_id: input,
      state: "applied",
      applied_tx_id: tx,
    });
    assert.equal((second.result as { already_applied: boolean }).already_applied, true);
  });
});

test("a sibling run without a parent link is not treated as having applied the input", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "sb-a");
    const input = make_input(env, env.p, "sib");
    const tx = any_tx(env.db, env.p.project_id);
    await record_receipt(env.service, env.ctx("sb-1"), {
      ...g(a),
      input_version_id: input,
      state: "applied",
      applied_tx_id: tx,
    });
    await complete(env.service, env.ctx("sb-done"), g(a));
    const b = await claim_new(env, "sb-b"); // no parent_run_id
    const out = await record_receipt(env.service, env.ctx("sb-2"), {
      ...g(b),
      input_version_id: input,
      state: "applied",
      applied_tx_id: tx,
    });
    assert.equal((out.result as { already_applied: boolean }).already_applied, false);
  });
});

test("a later 'ignored' or 'seen' for an already-applied input does not downgrade it", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "dg-a");
    const input = make_input(env, env.p, "dg");
    const tx = any_tx(env.db, env.p.project_id);
    await record_receipt(env.service, env.ctx("dg-1"), {
      ...g(a),
      input_version_id: input,
      state: "applied",
      applied_tx_id: tx,
    });
    for (const state of ["seen", "ignored"]) {
      await record_receipt(env.service, env.ctx(`dg-${state}`), { ...g(a), input_version_id: input, state });
    }
    const row = env.db.get<{ state: string; applied_tx_id: string | null }>(
      "SELECT state, applied_tx_id FROM run_input_receipts WHERE input_version_id = ?",
      input,
    );
    assert.equal(row?.state, "applied");
    assert.equal(row?.applied_tx_id, tx);
  });
});

test("an 'applied' receipt that points at a missing input version is refused", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "mi-a");
    const sig = state_signature(env.db);
    await rejects_code(
      record_receipt(env.service, env.ctx("mi-1"), {
        ...g(a),
        input_version_id: "no-such-version",
        state: "applied",
        applied_tx_id: any_tx(env.db, env.p.project_id),
      }),
      "invalid_payload",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

// --- replay vs lease guard order --------------------------------------------

test("replaying the same key after the lease moved on returns the stored result and writes nothing", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "rp-a");
    const first = await heartbeat(env.service, env.ctx("rp-hb"), g(a));
    env.clock.advance(CFG.lease_ttl_ms * 2);
    const b = await claim_new(env, "rp-b");
    assert.equal(b.fence, 2);
    const sig = state_signature(env.db);
    const replay = await heartbeat(env.service, env.ctx("rp-hb"), g(a));
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, first.result);
    assert.equal(state_signature(env.db), sig);
    assert.equal(lease_row(env.db, env.p.project_id).fence, 2n);
  });
});

test("the same key with a different guard is idempotency_key_reuse, not a lease check, and claim replay is stable", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "rk-a");
    const again = await claim(env.service, env.ctx("rk-a"), NEW_RUN);
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, a);
    assert.equal(env.db.all("SELECT 1 FROM runs").length, 1);
    await rejects_code(
      heartbeat(env.service, env.ctx("rk-a"), g(a)),
      "idempotency_key_reuse",
    );
    await heartbeat(env.service, env.ctx("rk-hb"), g(a));
    await rejects_code(
      heartbeat(env.service, env.ctx("rk-hb"), { ...g(a), fence: 9 }),
      "idempotency_key_reuse",
    );
  });
});

test("the replay of a claim does not bump the fence or extend the lease", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "rc-a");
    env.clock.advance(10_000);
    const again = await claim(env.service, env.ctx("rc-a"), NEW_RUN);
    assert.equal(again.replayed, true);
    const row = lease_row(env.db, env.p.project_id);
    assert.equal(row.fence, 1n);
    assert.equal(row.expires_at, BigInt(a.expires_at));
  });
});

test("a key used in project A is a fresh key in project B (receipts are per project)", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "same-key", env.p);
    const b = await claim_new(env, "same-key", env.q);
    assert.notEqual(a.run_id, b.run_id);
    const out = await claim(env.service, env.ctx("same-key", env.q), NEW_RUN);
    assert.equal(out.replayed, true);
  });
});

// --- TTL / heartbeat config -------------------------------------------------

test("heartbeat result and row expires_at use the injected TTL, not the claim-time TTL, on every beat", async () => {
  const cfg: RunConfig = { lease_ttl_ms: 7_000, heartbeat_interval_ms: 2_000 };
  await with_env(async (env) => {
    const a = await claim_new(env, "ttl-a");
    for (let i = 1; i <= 3; i += 1) {
      env.clock.advance(3_000);
      const out = await heartbeat(env.service, env.ctx(`ttl-${i}`), g(a));
      const now = START_MS + 3_000 * i;
      assert.equal((out.result as Lease).expires_at, now + 7_000);
      assert.equal(lease_row(env.db, env.p.project_id).expires_at, BigInt(now + 7_000));
    }
    env.clock.advance(7_000);
    await rejects_code(heartbeat(env.service, env.ctx("ttl-late"), g(a)), "conflict");
  }, cfg);
});

test("re-claim after wait uses the injected TTL for the new lease", async () => {
  const cfg: RunConfig = { lease_ttl_ms: 9_000, heartbeat_interval_ms: 3_000 };
  await with_env(async (env) => {
    const a = await claim_new(env, "tw-a");
    await wait(env.service, env.ctx("tw-w"), g(a));
    env.clock.advance(500);
    const b = (await claim(env.service, env.ctx("tw-b"), { run_id: a.run_id })).result as Lease & {
      heartbeat_interval_ms: number;
    };
    assert.equal(b.expires_at, START_MS + 500 + 9_000);
    assert.equal(b.heartbeat_interval_ms, 3_000);
    assert.equal(b.fence, 2);
  }, cfg);
});

// --- receipts record run / lease / fence ------------------------------------

test("every guarded command's receipt stores the run_id, lease_id and fence of the lease it used", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "rr-a");
    const input = make_input(env, env.p, "rr");
    const l1 = a;
    await heartbeat(env.service, env.ctx("rr-hb"), g(l1));
    await record_receipt(env.service, env.ctx("rr-rec"), { ...g(l1), input_version_id: input, state: "seen" });
    await release(env.service, env.ctx("rr-rel"), g(l1));
    const l2 = (await claim(env.service, env.ctx("rr-re"), { run_id: a.run_id })).result as Lease;
    await complete(env.service, env.ctx("rr-done"), g(l2));
    const want: Record<string, Lease> = {
      "rr-hb": l1,
      "rr-rec": l1,
      "rr-rel": l1,
      "rr-re": l2,
      "rr-done": l2,
    };
    for (const [key, lease] of Object.entries(want)) {
      const rc = env.db.get<{ run_id: string; lease_id: string; fence: bigint }>(
        "SELECT run_id, lease_id, fence FROM mutation_commits WHERE project_id = ? AND client_request_id = ?",
        env.p.project_id,
        key,
      );
      assert.ok(rc, key);
      assert.equal(rc.run_id, lease.run_id, key);
      assert.equal(rc.lease_id, lease.lease_id, key);
      assert.equal(rc.fence, BigInt(lease.fence), key);
    }
  });
});

test("an expired lease can be re-claimed by the same run only when the run is claimable; a fresh run reuses the lease row", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "lr-a");
    env.clock.advance(CFG.lease_ttl_ms);
    const b = await claim_new(env, "lr-b");
    assert.equal(env.db.all("SELECT 1 FROM project_leases WHERE project_id = ?", env.p.project_id).length, 1);
    assert.equal(lease_row(env.db, env.p.project_id).run_id, b.run_id);
    // the displaced run a is interrupted by the new claim (SEL-38 r1 decision 2)
    assert.equal(run_status(env.db, a.run_id), "interrupted");
    await rejects_code(complete(env.service, env.ctx("lr-1"), g(a)), "conflict");
  });
});

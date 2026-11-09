// SEL-38 PR5: regression tests for the final review (F1, F2, R1, R2, R3). Tests only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FakeClock } from "../scripts/pes_core/clock.ts";
import { connect, migrate, type Db, type RunResult, type SqlValue } from "../scripts/pes_core/db.ts";
import { ApiError } from "../scripts/pes_core/errors.ts";
import { CommandService, type MutationContext, type PolicyChecker } from "../scripts/pes_core/commands.ts";
import type { RunConfig } from "../scripts/pes_core/config.ts";
import { claim, handoff, heartbeat, record_receipt, release } from "../scripts/pes_core/runs.ts";
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

interface Lease {
  run_id: string;
  lease_id: string;
  fence: number;
  expires_at: number;
  heartbeat_interval_ms: number;
}
interface Env {
  home: IsolatedHome;
  db: Db;
  clock: FakeClock;
  service: CommandService;
  project_id: string;
  actor_id: string;
  ctx(key: string): MutationContext;
  with_db(db: Db): CommandService;
  close(): void;
}

let project_seq = 0;
async function make_env(): Promise<Env> {
  const home = isolated_home("pes-sel38f-");
  const db = connect(db_path(home.env));
  migrate(db);
  const clock = new FakeClock(START_MS);
  const service = new CommandService(db, { clock, policy: new AllowAll(), run_config: CFG });
  project_seq += 1;
  const out = await service.execute(
    { project_id: null, actor_id: null, via: "cli", client_request_id: "setup-f1" },
    "project.bootstrap",
    { slug: `synthetic-f${project_seq}`, topic: "합성 주제", owner_display_name: "합성 소유자" },
  );
  const r = out.result as { project_id: string; owner_actor_id: string };
  return {
    home,
    db,
    clock,
    service,
    project_id: r.project_id,
    actor_id: r.owner_actor_id,
    ctx: (key) => ({ project_id: r.project_id, actor_id: r.owner_actor_id, via: "cli", client_request_id: key }),
    with_db: (w) => new CommandService(w, { clock, policy: new AllowAll(), run_config: CFG }),
    close() {
      db.close();
      home.cleanup();
    },
  };
}

async function with_env(fn: (env: Env) => Promise<void>): Promise<void> {
  const env = await make_env();
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

async function claim_new(env: Env, key: string, extra: Record<string, unknown> = {}): Promise<Lease> {
  const out = await claim(env.service, env.ctx(key), { ...NEW_RUN, ...extra });
  return out.result as Lease;
}

function g(l: Lease) {
  return { run_id: l.run_id, lease_id: l.lease_id, fence: l.fence };
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

function tx_ids(env: Env): string[] {
  return env.db
    .all<{ id: string }>("SELECT id FROM mutation_commits WHERE project_id = ? ORDER BY rowid", env.project_id)
    .map((r) => r.id);
}

let seq = 0;
function make_input(env: Env, name: string): string {
  seq += 1;
  const object_id = `fobj-${name}-${seq}`;
  const version_id = `fver-${name}-${seq}`;
  env.db.run(
    "INSERT INTO objects (id, project_id, kind, display_no) VALUES (?, ?, 'artifact', ?)",
    object_id,
    env.project_id,
    BigInt(seq),
  );
  env.db.run(
    `INSERT INTO object_versions (id, project_id, object_id, kind, version_no, actor_id, tx_id, content_hash)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    version_id,
    env.project_id,
    object_id,
    "artifact",
    env.actor_id,
    tx_ids(env)[0],
    "c".repeat(64),
  );
  return version_id;
}

function applied_rows(env: Env, input: string) {
  return env.db.all<{ run_id: string; applied_tx_id: string | null }>(
    "SELECT run_id, applied_tx_id FROM run_input_receipts WHERE project_id = ? AND input_version_id = ? AND state = 'applied'",
    env.project_id,
    input,
  );
}

let key_seq = 0;
function k(prefix: string): string {
  key_seq += 1;
  return `${prefix}-${key_seq}`;
}

async function record(env: Env, l: Lease, input: string, state: string, tx?: string) {
  const out = await record_receipt(env.service, env.ctx(k("rec")), {
    ...g(l),
    input_version_id: input,
    state,
    ...(tx === undefined ? {} : { applied_tx_id: tx }),
  });
  return out.result as { already_applied: boolean; applied_tx_id: string | null };
}

// --- F1: blocked_usage run can be resumed ------------------------------------

function make_blocked(env: Env, run_id: string): void {
  env.db.run(
    "UPDATE runs SET status = 'blocked_usage', go_block_reason = 'usage_limit', go_blocked_at = ?, go_block_reset_at = ? WHERE id = ?",
    BigInt(START_MS),
    BigInt(START_MS + 60_000),
    run_id,
  );
}

function run_block_fields(env: Env, run_id: string) {
  const row = env.db.get<{
    status: string;
    go_block_reason: string | null;
    go_blocked_at: bigint | null;
    go_block_reset_at: bigint | null;
  }>("SELECT status, go_block_reason, go_blocked_at, go_block_reset_at FROM runs WHERE id = ?", run_id);
  assert.ok(row);
  return row;
}

test("F1: claim({run_id}) resumes a blocked_usage run and clears every go_block field", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "f1-a");
    await release(env.service, env.ctx("f1-rel"), g(a));
    make_blocked(env, a.run_id);
    const before = run_block_fields(env, a.run_id);
    assert.equal(before.status, "blocked_usage");
    assert.equal(before.go_block_reason, "usage_limit");

    env.clock.advance(1_000);
    const out = await claim(env.service, env.ctx("f1-resume"), { run_id: a.run_id });
    const r = out.result as Lease;
    assert.equal(r.run_id, a.run_id);
    assert.equal(r.fence, a.fence + 1);
    assert.notEqual(r.lease_id, a.lease_id);
    const after = run_block_fields(env, a.run_id);
    assert.equal(after.status, "running");
    assert.equal(after.go_block_reason, null);
    assert.equal(after.go_blocked_at, null);
    assert.equal(after.go_block_reset_at, null);
    // the new lease is usable
    await heartbeat(env.service, env.ctx("f1-hb"), g(r));
  });
});

test("F1: a resumed blocked_usage claim failing midway rolls everything back", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "f1b-a");
    await release(env.service, env.ctx("f1b-rel"), g(a));
    make_blocked(env, a.run_id);
    const sig = state_signature(env.db);
    const counts = table_counts(env.db);
    const failing = wrap_db(env.db, (sql) => {
      if (/^\s*(?:UPDATE|INSERT(?:\s+OR\s+\w+)?\s+INTO)\s+project_leases\b/i.test(sql)) throw new Error("boom-lease");
    });
    await assert.rejects(async () => claim(env.with_db(failing), env.ctx("f1b-resume"), { run_id: a.run_id }), /boom-lease/);
    assert.equal(state_signature(env.db), sig);
    assert.deepEqual(table_counts(env.db), counts);
    const row = run_block_fields(env, a.run_id);
    assert.equal(row.status, "blocked_usage");
    assert.equal(row.go_block_reason, "usage_limit");
  });
});

// --- F2: duplicate-apply protection across a hand-off flow --------------------

async function flow_a_to_b(env: Env) {
  const input = make_input(env, "f2");
  const a = await claim_new(env, k("f2-a"));
  await record(env, a, input, "seen");
  await handoff(env.service, env.ctx(k("f2-ho-a")), g(a));
  const b = await claim_new(env, k("f2-b"), { parent_run_id: a.run_id });
  const txs = tx_ids(env);
  await record(env, b, input, "applied", txs[0]);
  await handoff(env.service, env.ctx(k("f2-ho-b")), g(b));
  return { input, a, b, txs };
}

test("F2: A -> B hand-off, B applied V, A resumed: A's applied record is already_applied and nothing is added", async () => {
  await with_env(async (env) => {
    const { input, a, txs } = await flow_a_to_b(env);
    const a2 = (await claim(env.service, env.ctx(k("f2-resume")), { run_id: a.run_id })).result as Lease;
    assert.equal(a2.run_id, a.run_id);
    const stored = applied_rows(env, input);
    assert.equal(stored.length, 1);
    const original_tx = stored[0].applied_tx_id;
    assert.equal(original_tx, txs[0]);

    const second_tx = tx_ids(env).find((t) => t !== txs[0]);
    assert.ok(second_tx);
    const r = await record(env, a2, input, "applied", second_tx);
    assert.equal(r.already_applied, true);
    assert.equal(r.applied_tx_id, original_tx);
    const after = applied_rows(env, input);
    assert.equal(after.length, 1);
    assert.equal(after[0].applied_tx_id, original_tx);
  });
});

test("F2: another follow-up run C derived from A is also blocked from applying V again", async () => {
  await with_env(async (env) => {
    const { input, a, txs } = await flow_a_to_b(env);
    const c = await claim_new(env, k("f2-c"), { parent_run_id: a.run_id });
    const second_tx = tx_ids(env).find((t) => t !== txs[0]);
    assert.ok(second_tx);
    const r = await record(env, c, input, "applied", second_tx);
    assert.equal(r.already_applied, true);
    assert.equal(r.applied_tx_id, txs[0]);
    assert.equal(applied_rows(env, input).length, 1);
  });
});

test("F2: a deeper descendant applying V blocks the root and a sibling branch", async () => {
  await with_env(async (env) => {
    const input = make_input(env, "f2d");
    const a = await claim_new(env, k("d-a"));
    await handoff(env.service, env.ctx(k("d-ho-a")), g(a));
    const b = await claim_new(env, k("d-b"), { parent_run_id: a.run_id });
    await handoff(env.service, env.ctx(k("d-ho-b")), g(b));
    const c = await claim_new(env, k("d-c"), { parent_run_id: b.run_id });
    const txs = tx_ids(env);
    assert.equal((await record(env, c, input, "applied", txs[0])).already_applied, false);
    await handoff(env.service, env.ctx(k("d-ho-c")), g(c));

    const a2 = (await claim(env.service, env.ctx(k("d-resume-a")), { run_id: a.run_id })).result as Lease;
    const ra = await record(env, a2, input, "applied", txs[1] ?? txs[0]);
    assert.equal(ra.already_applied, true);
    assert.equal(ra.applied_tx_id, txs[0]);
    await handoff(env.service, env.ctx(k("d-ho-a2")), g(a2));

    const sibling = await claim_new(env, k("d-sib"), { parent_run_id: a.run_id });
    const rs = await record(env, sibling, input, "applied", txs[1] ?? txs[0]);
    assert.equal(rs.already_applied, true);
    assert.equal(applied_rows(env, input).length, 1);
  });
});

test("F2: runs with different roots do not block each other", async () => {
  await with_env(async (env) => {
    const input = make_input(env, "f2i");
    const x = await claim_new(env, k("i-x"));
    const txs = tx_ids(env);
    assert.equal((await record(env, x, input, "applied", txs[0])).already_applied, false);
    await handoff(env.service, env.ctx(k("i-ho-x")), g(x));
    const y = await claim_new(env, k("i-y")); // no parent: independent root
    const r = await record(env, y, input, "applied", txs[0]);
    assert.equal(r.already_applied, false);
    assert.equal(applied_rows(env, input).length, 2);
  });
});

// --- R1: registry entries input cannot be mutated before commands.ts loads ---

test("R1: a fresh process cannot inject a command through the run entries exported by commands/runs.ts", () => {
  const runs_url = new URL("../scripts/pes_core/commands/runs.ts", import.meta.url).href;
  const commands_url = new URL("../scripts/pes_core/commands.ts", import.meta.url).href;
  const script = `
    const runs = await import(${JSON.stringify(runs_url)});
    const entries = runs.RUN_COMMAND_ENTRIES;
    const injected = Object.freeze({ action: "synthetic.injected", scope: "project", rev_bearing: false, run() { return { result: {}, events: [] }; } });
    const attempts = [];
    if (entries !== undefined) {
      const tries = [
        () => entries.push(["synthetic.injected", injected]),
        () => { entries[0] = ["synthetic.injected", injected]; },
        () => { entries[0][1] = injected; },
        () => { entries[0][0] = "synthetic.injected"; },
        () => { entries.length = 0; },
        () => entries.unshift(["synthetic.injected", injected]),
        () => entries.splice(0, 1, ["synthetic.injected", injected]),
      ];
      for (const t of tries) { try { t(); attempts.push("ok"); } catch { attempts.push("threw"); } }
    }
    const mod = await import(${JSON.stringify(commands_url)});
    const claim = mod.COMMANDS.get("run.claim");
    console.log(JSON.stringify({
      has_injected: mod.COMMANDS.has("synthetic.injected"),
      names: [...mod.COMMANDS.keys()].sort(),
      claim_action: claim === undefined ? null : claim.action,
    }));
  `;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    env: { ...process.env, HOME: process.env.TMPDIR ?? "/tmp", USERPROFILE: process.env.TMPDIR ?? "/tmp", PES_HOME: process.env.TMPDIR ?? "/tmp" },
  });
  const line = stdout.trim().split("\n").pop() ?? "";
  const out = JSON.parse(line) as { has_injected: boolean; names: string[]; claim_action: string | null };
  assert.equal(out.has_injected, false, "no injected command may reach COMMANDS");
  assert.equal(out.claim_action, "run.claimed", "run.claim must keep its original definition");
  for (const n of ["run.claim", "run.heartbeat", "run.wait", "run.complete", "run.release", "run.handoff", "run.interrupt", "run.record_receipt"]) {
    assert.ok(out.names.includes(n), `${n} stays registered`);
  }
});

// --- R2: injected run_config is validated and copied ------------------------

test("R2: injected run_config is validated by the constructor", async () => {
  const env = await make_env();
  try {
    const bad: Array<[string, RunConfig]> = [
      ["heartbeat >= ttl", { lease_ttl_ms: 1_000, heartbeat_interval_ms: 2_000 }],
      ["heartbeat == ttl", { lease_ttl_ms: 1_000, heartbeat_interval_ms: 1_000 }],
      ["zero ttl", { lease_ttl_ms: 0, heartbeat_interval_ms: 1 }],
      ["zero heartbeat", { lease_ttl_ms: 1_000, heartbeat_interval_ms: 0 }],
      ["negative ttl", { lease_ttl_ms: -5, heartbeat_interval_ms: 1 }],
      ["negative heartbeat", { lease_ttl_ms: 1_000, heartbeat_interval_ms: -1 }],
      ["fractional ttl", { lease_ttl_ms: 1_000.5, heartbeat_interval_ms: 10 }],
      ["fractional heartbeat", { lease_ttl_ms: 1_000, heartbeat_interval_ms: 10.5 }],
      ["NaN ttl", { lease_ttl_ms: Number.NaN, heartbeat_interval_ms: 10 }],
      ["Infinity ttl", { lease_ttl_ms: Number.POSITIVE_INFINITY, heartbeat_interval_ms: 10 }],
    ];
    for (const [label, run_config] of bad) {
      assert.throws(
        () => new CommandService(env.db, { clock: env.clock, policy: new AllowAll(), run_config }),
        (error: unknown) => error instanceof Error,
        label,
      );
    }
    assert.doesNotThrow(
      () =>
        new CommandService(env.db, {
          clock: env.clock,
          policy: new AllowAll(),
          run_config: { lease_ttl_ms: 1_000, heartbeat_interval_ms: 999 },
        }),
    );
  } finally {
    env.close();
  }
});

test("R2: changing the injected object after construction does not change lease timing", async () => {
  const env = await make_env();
  try {
    const cfg: RunConfig = { lease_ttl_ms: 60_000, heartbeat_interval_ms: 20_000 };
    const service = new CommandService(env.db, { clock: env.clock, policy: new AllowAll(), run_config: cfg });
    cfg.lease_ttl_ms = 5_000_000;
    cfg.heartbeat_interval_ms = 4_000_000;
    const out = await claim(service, env.ctx("r2-a"), NEW_RUN);
    const l = out.result as Lease;
    assert.equal(l.expires_at - env.clock.now_ms(), 60_000);
    assert.equal(l.heartbeat_interval_ms, 20_000);
    env.clock.advance(10_000);
    const hb = (await heartbeat(service, env.ctx("r2-hb"), g(l))).result as { expires_at: number };
    assert.equal(hb.expires_at - env.clock.now_ms(), 60_000);
  } finally {
    env.close();
  }
});

// --- R3: fence upper bound ----------------------------------------------------

function set_fence(env: Env, fence: bigint): void {
  const written = env.db.run("UPDATE project_leases SET fence = ? WHERE project_id = ?", fence, env.project_id);
  assert.equal(written.changes, 1n);
}

test("R3: a stored fence of MAX_SAFE_INTEGER refuses a new claim and writes nothing", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "r3-a");
    await release(env.service, env.ctx("r3-rel"), g(a));
    set_fence(env, BigInt(Number.MAX_SAFE_INTEGER));
    const sig = state_signature(env.db);
    const counts = table_counts(env.db);
    await rejects_code(claim(env.service, env.ctx("r3-b"), NEW_RUN), "conflict");
    assert.equal(state_signature(env.db), sig);
    assert.deepEqual(table_counts(env.db), counts);
  });
});

test("R3: a stored fence of MAX_SAFE_INTEGER - 1 yields a usable fence MAX_SAFE_INTEGER", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "r3c-a");
    await release(env.service, env.ctx("r3c-rel"), g(a));
    set_fence(env, BigInt(Number.MAX_SAFE_INTEGER - 1));
    const b = await claim_new(env, "r3c-b");
    assert.equal(b.fence, Number.MAX_SAFE_INTEGER);
    const stored = env.db.get<{ fence: bigint }>("SELECT fence FROM project_leases WHERE project_id = ?", env.project_id);
    assert.equal(stored?.fence, BigInt(Number.MAX_SAFE_INTEGER));
    env.clock.advance(1_000);
    const hb = await heartbeat(env.service, env.ctx("r3c-hb"), g(b));
    assert.equal((hb.result as { fence: number }).fence, Number.MAX_SAFE_INTEGER);
  });
});

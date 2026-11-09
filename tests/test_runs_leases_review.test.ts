// SEL-38 PR5: regression tests for the first review's recommendations 2, 3 and 4 (tests only).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FakeClock } from "../scripts/pes_core/clock.ts";
import { connect, migrate, type Db, type RunResult, type SqlValue } from "../scripts/pes_core/db.ts";
import { ApiError } from "../scripts/pes_core/errors.ts";
import { CommandService, type MutationContext, type PolicyChecker } from "../scripts/pes_core/commands.ts";
import type { RunConfig } from "../scripts/pes_core/config.ts";
import { claim, complete, interrupt } from "../scripts/pes_core/runs.ts";
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
  ctx(key: string): MutationContext;
  with_db(db: Db): CommandService;
  close(): void;
}

async function make_env(): Promise<Env> {
  const home = isolated_home("pes-sel38r-");
  const db = connect(db_path(home.env));
  migrate(db);
  const clock = new FakeClock(START_MS);
  const service = new CommandService(db, { clock, policy: new AllowAll(), run_config: CFG });
  const out = await service.execute(
    { project_id: null, actor_id: null, via: "cli", client_request_id: "setup-r1" },
    "project.bootstrap",
    { slug: "synthetic-r1", topic: "합성 주제", owner_display_name: "합성 소유자" },
  );
  const r = out.result as { project_id: string; owner_actor_id: string };
  const p: P = { project_id: r.project_id, actor_id: r.owner_actor_id };
  return {
    home,
    db,
    clock,
    service,
    p,
    ctx: (key) => ({ project_id: p.project_id, actor_id: p.actor_id, via: "cli", client_request_id: key }),
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

function run_row(db: Db, run_id: string) {
  const row = db.get<{ status: string; ended_at: bigint | null }>(
    "SELECT status, ended_at FROM runs WHERE id = ?",
    run_id,
  );
  assert.ok(row);
  return row;
}

function events_for_run(db: Db, run_id: string): string[] {
  return db.all<{ type: string }>("SELECT type FROM events WHERE run_id = ? ORDER BY rowid", run_id).map((e) => e.type);
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

// --- recommendation 2: claim cleans up the run of an expired lease ----------

test("claim over an expired lease turns the old running run into interrupted and records an event for it", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "x-a");
    assert.deepEqual(events_for_run(env.db, a.run_id).filter((t) => /interrupt/.test(t)), []);
    env.clock.advance(CFG.lease_ttl_ms); // now == expires_at
    const b = await claim_new(env, "x-b");
    assert.equal(b.fence, a.fence + 1);
    const old = run_row(env.db, a.run_id);
    assert.equal(old.status, "interrupted");
    assert.ok(old.ended_at !== null, "interrupted run has ended_at");
    const interrupted = events_for_run(env.db, a.run_id).filter((t) => /interrupt/.test(t));
    assert.equal(interrupted.length, 1, "exactly one interrupted event for the old run");
    assert.equal(run_row(env.db, b.run_id).status, "running");
    assert.deepEqual(events_for_run(env.db, b.run_id).filter((t) => /interrupt/.test(t)), []);
  });
});

test("claim one ms before expiry is still refused and the old run stays running", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "x2-a");
    env.clock.advance(CFG.lease_ttl_ms - 1);
    const sig = state_signature(env.db);
    await rejects_code(claim(env.service, env.ctx("x2-b"), NEW_RUN), "conflict");
    assert.equal(state_signature(env.db), sig);
    assert.equal(run_row(env.db, a.run_id).status, "running");
  });
});

test("claim over an expired lease does not touch a run that already ended", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "x3-a");
    await complete(env.service, env.ctx("x3-done"), { ...g(a), status: "succeeded" });
    const before = run_row(env.db, a.run_id);
    const events_before = events_for_run(env.db, a.run_id);
    env.clock.advance(CFG.lease_ttl_ms * 2);
    await claim_new(env, "x3-b");
    const after = run_row(env.db, a.run_id);
    assert.equal(after.status, "succeeded");
    assert.equal(after.ended_at, before.ended_at);
    assert.deepEqual(events_for_run(env.db, a.run_id), events_before);
  });
});

test("claim over an expired lease does not touch a run that was already interrupted", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "x4-a");
    await interrupt(env.service, env.ctx("x4-int"), g(a));
    const before = run_row(env.db, a.run_id);
    const events_before = events_for_run(env.db, a.run_id);
    env.clock.advance(CFG.lease_ttl_ms * 2);
    await claim_new(env, "x4-b");
    assert.deepEqual(run_row(env.db, a.run_id), before);
    assert.deepEqual(events_for_run(env.db, a.run_id), events_before);
  });
});

test("claim failing midway rolls back the old run's interrupted change and its event", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "x5-a");
    env.clock.advance(CFG.lease_ttl_ms);
    const sig = state_signature(env.db);
    const counts = table_counts(env.db);
    const failing = wrap_db(env.db, (sql) => {
      if (/^\s*(?:UPDATE|INSERT(?:\s+OR\s+\w+)?\s+INTO)\s+project_leases\b/i.test(sql)) throw new Error("boom-lease");
    });
    await assert.rejects(async () => claim(env.with_db(failing), env.ctx("x5-b"), NEW_RUN), /boom-lease/);
    assert.equal(state_signature(env.db), sig);
    assert.deepEqual(table_counts(env.db), counts);
    assert.equal(run_row(env.db, a.run_id).status, "running");
  });
});

test("claim failing while writing events rolls back the old run's interrupted change", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "x6-a");
    env.clock.advance(CFG.lease_ttl_ms);
    const sig = state_signature(env.db);
    const failing = wrap_db(env.db, (sql) => {
      if (/^\s*INSERT\s+INTO\s+events\b/i.test(sql)) throw new Error("boom-event");
    });
    await assert.rejects(async () => claim(env.with_db(failing), env.ctx("x6-b"), NEW_RUN), /boom-event/);
    assert.equal(state_signature(env.db), sig);
    assert.equal(run_row(env.db, a.run_id).status, "running");
  });
});

test("an expired-lease claim by resuming an interrupted run also leaves other runs consistent", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "x7-a");
    await interrupt(env.service, env.ctx("x7-int"), g(a));
    const b = await claim_new(env, "x7-b"); // fresh run takes the (released) lease
    env.clock.advance(CFG.lease_ttl_ms);
    const again = (await claim(env.service, env.ctx("x7-again"), { run_id: a.run_id })).result as Lease;
    assert.equal(again.run_id, a.run_id);
    assert.equal(run_row(env.db, b.run_id).status, "interrupted", "displaced run b is interrupted");
    assert.equal(run_row(env.db, a.run_id).status, "running");
  });
});

// --- recommendation 3: resume rejects parent_run_id / role ------------------

async function interrupted_run(env: Env, key: string): Promise<Lease> {
  const a = await claim_new(env, key);
  await interrupt(env.service, env.ctx(`${key}-int`), g(a));
  return a;
}

test("resuming a run with parent_run_id is invalid_payload and writes nothing", async () => {
  await with_env(async (env) => {
    const other = await claim_new(env, "p-other");
    await complete(env.service, env.ctx("p-other-done"), { ...g(other), status: "succeeded" });
    const a = await interrupted_run(env, "p-a");
    const sig = state_signature(env.db);
    await rejects_code(
      claim(env.service, env.ctx("p-1"), { run_id: a.run_id, parent_run_id: other.run_id }),
      "invalid_payload",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

test("resuming a run with role (even a valid one) is invalid_payload and writes nothing", async () => {
  for (const role of ["worker", "reviewer"]) {
    await with_env(async (env) => {
      const a = await interrupted_run(env, `r-${role}`);
      const sig = state_signature(env.db);
      await rejects_code(
        claim(env.service, env.ctx("r-1"), { run_id: a.run_id, role }),
        "invalid_payload",
      );
      assert.equal(state_signature(env.db), sig);
    });
  }
});

test("resuming with both parent_run_id and role is invalid_payload; a plain resume still works", async () => {
  await with_env(async (env) => {
    const a = await interrupted_run(env, "pr-a");
    const sig = state_signature(env.db);
    await rejects_code(
      claim(env.service, env.ctx("pr-1"), { run_id: a.run_id, parent_run_id: a.run_id, role: "worker" }),
      "invalid_payload",
    );
    assert.equal(state_signature(env.db), sig);
    const ok = (await claim(env.service, env.ctx("pr-2"), { run_id: a.run_id })).result as Lease;
    assert.equal(ok.run_id, a.run_id);
  });
});

test("a fresh claim still accepts parent_run_id and role", async () => {
  await with_env(async (env) => {
    const a = await claim_new(env, "ok-a");
    await complete(env.service, env.ctx("ok-done"), { ...g(a), status: "succeeded" });
    const b = await claim_new(env, "ok-b", { parent_run_id: a.run_id, role: "reviewer" });
    const row = env.db.get<{ parent_run_id: string | null; role: string }>(
      "SELECT parent_run_id, role FROM runs WHERE id = ?",
      b.run_id,
    );
    assert.equal(row?.parent_run_id, a.run_id);
    assert.equal(row?.role, "reviewer");
  });
});

// --- recommendation 4: import order independence ----------------------------

test("importing commands/runs.ts first in a fresh process works and COMMANDS has run.* entries", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const runs_url = pathToFileURL(`${root}scripts/pes_core/commands/runs.ts`).href;
  const commands_url = pathToFileURL(`${root}scripts/pes_core/commands.ts`).href;
  const code = `
    await import(${JSON.stringify(runs_url)});
    const m = await import(${JSON.stringify(commands_url)});
    console.log(JSON.stringify([...m.COMMANDS.keys()].filter((k) => k.startsWith("run."))));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const names = JSON.parse(out.trim().split("\n").pop() as string) as string[];
  for (const n of ["run.claim", "run.heartbeat", "run.wait", "run.complete", "run.release", "run.handoff", "run.interrupt", "run.record_receipt"]) {
    assert.ok(names.includes(n), `COMMANDS has ${n}`);
  }
});

test("importing commands/runs.ts alone in a fresh process does not throw", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const runs_url = pathToFileURL(`${root}scripts/pes_core/commands/runs.ts`).href;
  const code = `await import(${JSON.stringify(runs_url)}); console.log("ok");`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(out.trim(), "ok");
});

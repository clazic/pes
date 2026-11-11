/**
 * SEL-56 F1 보강 (데이터 보존·보안, tester 보강 모드).
 * F1 = 9415a24 / d6141c2: `running` + 만료된 lease 인 run 을 같은 actor 가 run_id claim(B) / resume(A) 으로 이어받는다.
 * 이 파일은 그 변경을 부수려고 쓴 새 시험이다. 기존 시험은 건드리지 않는다. 합성 자료·임시 HOME/PES_HOME·가짜 서버만 쓴다.
 *
 * 노린 곳 (지시 번호):
 *  (1) 경계 시각: now == expires_at, expires_at-1, 하트비트로 늘어난 만료, 시계 되감기
 *  (2) 다른 actor·다른 프로젝트·회수된 토큰·강등된 actor(SEL-68)·Go OFF 로 같은 run 이어받기 → 거부, 상태 변화 0, 재전송도 거부
 *  (3) 동시 경합: 같은 actor 의 진짜 두 프로세스, 같은 actor 두 MCP 클라이언트, 다른 actor 의 새 claim 과의 경합
 *  (4) 옛 guard(만료된 lease)로 heartbeat·submit·ask·wait·complete·release → 거부, 이어받기 전·후 모두
 *  (5) A resume: 미정산 dispatch(prepared·authorized·sent·unknown) → conflict + 행 바이트 동일, 사람 정리 뒤에만, Go OFF → 정책 거부
 *  (6) 사건·영수증 수, 같은 키 재전송 = 처음 결과 그대로(새 행 0)
 *  (7) 이어받은 뒤 이전에 제출된 버전·입력 유실 0
 *  (8) MCP pes_claim · CLI claim 도 같은 규칙
 *
 * 이 파일은 자기 자신을 자식 프로세스로도 띄운다(PES_F1_CHILD 가 있으면 시험 대신 claim 한 번만 하고 끝난다).
 * Windows: 자식 출력은 ASCII JSON, 경로는 환경변수로 넘기고, CLI 시험은 기존 헬퍼(UTF-8 강제)를 쓴다.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { connect, migrate, type Db } from "../scripts/pes_core/db.ts";
import { ApiError } from "../scripts/pes_core/errors.ts";
import { CommandService, type MutationContext, type PolicyChecker } from "../scripts/pes_core/commands.ts";
import type { RunConfig } from "../scripts/pes_core/config.ts";
import type { Clock } from "../scripts/pes_core/clock.ts";
import { claim, complete, heartbeat, release, wait } from "../scripts/pes_core/runs.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { BuiltinExecutor } from "../scripts/pes_core/a_runtime/loop.ts";
import { issue_agent_token } from "../scripts/pes_core/actors.ts";
import { isolated_home, type IsolatedHome } from "./helpers/isolated_home.ts";
import { state_signature } from "./helpers/state_signature.ts";
import { assert_error, assert_ok, call, go_off, make_agent, with_api, type ApiEnv, type ApiResponse, type Auth } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { expect_rejected, json_out, with_cli, SLUG } from "./helpers/cli_write_env.ts";
import { b_stale_guard_raw_code, Driver, type Guard, type Side } from "./helpers/cross_driver.ts";
import { B_TOOLS, lease_row, make_cross_env, ready_cross, run_info, versions_of, with_cross_env, type CrossEnv } from "./helpers/cross_env.ts";
import {
  FINISH,
  all_runs,
  context_turn,
  dispatches,
  events_by_type,
  next_key,
  policy_off,
  policy_on,
  resume_outcome,
  resume_run,
  set_script,
  start_run,
  submit_turn,
} from "./helpers/a_builtin_env.ts";
import type { Db as DbType } from "../scripts/pes_core/db.ts";

const START_MS = 1_760_000_000_000;
const TTL = 60_000;
const CFG: RunConfig = { lease_ttl_ms: TTL, heartbeat_interval_ms: 20_000 };
const NEW_RUN = { mode: "B", runtime: "synthetic-runtime", provider: "synthetic", model: "synthetic-model" };
const THIS_FILE = fileURLToPath(import.meta.url);

class AllowAll implements PolicyChecker {
  check() {
    return { allowed: true } as const;
  }
}

/** A clock a test can move both ways (FakeClock only moves forward). */
class Tick implements Clock {
  t: number;
  constructor(t: number) {
    this.t = t;
  }
  now_ms(): number {
    return this.t;
  }
}

// ---------------------------------------------------------------------------------------------------------
// child process: one claim against a database file, at a fixed time, then exit

interface ChildJob {
  db: string;
  now: number;
  key: string;
  project_id: string;
  actor_id: string;
  payload: Record<string, unknown>;
}

async function child_main(job: ChildJob): Promise<void> {
  const db = connect(job.db);
  let out: Record<string, unknown>;
  try {
    const service = new CommandService(db, { clock: new Tick(job.now), policy: new AllowAll(), run_config: CFG });
    const result = await claim(
      service,
      { project_id: job.project_id, actor_id: job.actor_id, via: "cli", client_request_id: job.key },
      job.payload,
    );
    const r = result.result as { run_id: string; lease_id: string; fence: number };
    out = { ok: true, run_id: r.run_id, lease_id: r.lease_id, fence: r.fence };
  } catch (error) {
    out = { ok: false, code: error instanceof ApiError ? error.code : `other:${String(error)}` };
  } finally {
    db.close();
  }
  process.stdout.write(`F1CHILD${JSON.stringify(out)}\n`);
}

if (process.env.PES_F1_CHILD !== undefined) {
  await child_main(JSON.parse(process.env.PES_F1_CHILD) as ChildJob);
  process.exit(0);
}

function run_child(home: IsolatedHome, job: ChildJob): Promise<{ ok: boolean; code?: string; run_id?: string; fence?: number; lease_id?: string }> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(home.env)) if (v !== undefined) env[k] = v;
    env.PES_F1_CHILD = JSON.stringify(job);
    const child = spawn(process.execPath, ["--no-warnings", THIS_FILE], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    child.on("close", (code) => {
      const line = out.split(/\r?\n/).find((l) => l.startsWith("F1CHILD"));
      if (line === undefined) return reject(new Error(`child exit ${code}: ${err.slice(0, 500)}`));
      resolve(JSON.parse(line.slice("F1CHILD".length)));
    });
  });
}

// ---------------------------------------------------------------------------------------------------------
// core env: two projects in one database, a movable clock

interface Pj {
  project_id: string;
  actor_id: string;
}
interface Lease {
  run_id: string;
  lease_id: string;
  fence: number;
  expires_at: number;
}
interface CoreEnv {
  home: IsolatedHome;
  db: Db;
  clock: Tick;
  service: CommandService;
  p: Pj;
  q: Pj;
  ctx(key: string, who?: Pj): MutationContext;
  close(): void;
}

async function make_core(): Promise<CoreEnv> {
  const home = isolated_home("pes-sel56-f1-");
  const db = connect(db_path(home.env));
  migrate(db);
  const clock = new Tick(START_MS);
  const service = new CommandService(db, { clock, policy: new AllowAll(), run_config: CFG });
  const boot = async (slug: string): Promise<Pj> => {
    const out = await service.execute(
      { project_id: null, actor_id: null, via: "cli", client_request_id: `setup-${slug}` },
      "project.bootstrap",
      { slug, topic: "합성 주제", owner_display_name: "합성 소유자" },
    );
    const r = out.result as { project_id: string; owner_actor_id: string };
    return { project_id: r.project_id, actor_id: r.owner_actor_id };
  };
  const p = await boot("synthetic-f1a");
  const q = await boot("synthetic-f1b");
  return {
    home,
    db,
    clock,
    service,
    p,
    q,
    ctx: (key, who = p) => ({ project_id: who.project_id, actor_id: who.actor_id, via: "cli", client_request_id: key }),
    close() {
      db.close();
      home.cleanup();
    },
  };
}

async function with_core(fn: (env: CoreEnv) => Promise<void>): Promise<void> {
  const env = await make_core();
  try {
    await fn(env);
  } finally {
    env.close();
  }
}

/** a second actor (same user) of project p: the only thing a stranger needs for the command layer */
function add_stranger(env: CoreEnv, id = "agent-stranger", kind = "external_agent"): Pj {
  const owner = env.db.get<{ user_id: string }>("SELECT user_id FROM actors WHERE id = ?", env.p.actor_id);
  assert.ok(owner);
  env.db.run("INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, ?, ?, '합성 타인')", id, kind, owner.user_id);
  return { project_id: env.p.project_id, actor_id: id };
}

async function claim_new(env: CoreEnv, key: string, who: Pj = env.p): Promise<Lease> {
  return (await claim(env.service, env.ctx(key, who), NEW_RUN)).result as Lease;
}

const g = (l: { run_id: string; lease_id: string; fence: number }) => ({ run_id: l.run_id, lease_id: l.lease_id, fence: l.fence });

async function code_of(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
    return error.code;
  }
  assert.fail("expected a rejection");
}

function lease_of(db: Db, project_id: string): { state: string; fence: number; expires_at: number; run_id: string | null; lease_id: string; owner_actor_id: string } {
  const row = db.get<any>("SELECT state, fence, expires_at, run_id, lease_id, owner_actor_id FROM project_leases WHERE project_id = ?", project_id);
  assert.ok(row);
  return { ...row, fence: Number(row.fence), expires_at: Number(row.expires_at) };
}

function events_of(db: Db, project_id: string, type: string, run_id?: string): Array<{ run_id: string | null; payload: any }> {
  return db
    .all<{ run_id: string | null; payload: string }>("SELECT run_id, payload FROM events WHERE project_id = ? AND type = ? ORDER BY event_seq", project_id, type)
    .filter((e) => run_id === undefined || e.run_id === run_id)
    .map((e) => ({ run_id: e.run_id, payload: typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload }));
}

function receipts_of(db: Db, project_id: string): string[] {
  return db.all<{ action: string }>("SELECT action FROM mutation_commits WHERE project_id = ? ORDER BY rowid", project_id).map((r) => r.action);
}

function run_row(db: Db, run_id: string): any {
  const row = db.get<any>("SELECT * FROM runs WHERE id = ?", run_id);
  assert.ok(row);
  return row;
}

/** every column of the run row that a takeover must NOT touch */
function run_fixed(db: Db, run_id: string): string {
  const { status: _s, ended_at: _e, ...rest } = run_row(db, run_id);
  return JSON.stringify(rest, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
}

// ---------------------------------------------------------------------------------------------------------
// (1) boundary times

test("F1 (1) boundary: expires_at-1 is still live (conflict, nothing written); now == expires_at is dead (takeover works, fence+1, same run)", async () => {
  await with_core(async (env) => {
    const a = await claim_new(env, "b1-a");
    assert.equal(a.expires_at, START_MS + TTL);
    env.clock.t = a.expires_at - 1;
    const before = state_signature(env.db);
    assert.equal(await code_of(claim(env.service, env.ctx("b1-early"), { run_id: a.run_id })), "conflict");
    assert.equal(state_signature(env.db), before, "one millisecond before expiry the lease still holds the run");

    env.clock.t = a.expires_at; // exactly the expiry: now < expires_at is false
    const b = (await claim(env.service, env.ctx("b1-at"), { run_id: a.run_id })).result as Lease;
    assert.equal(b.run_id, a.run_id);
    assert.equal(b.fence, a.fence + 1);
    assert.notEqual(b.lease_id, a.lease_id);
    assert.equal(b.expires_at, a.expires_at + TTL);
    assert.equal(run_row(env.db, a.run_id).status, "running");
    assert.equal(run_row(env.db, a.run_id).ended_at, null);
  });
});

test("F1 (1) boundary: a heartbeat at expires_at-1 moves the expiry, so the OLD expiry no longer lets a takeover in; at exactly the NEW expiry it does", async () => {
  await with_core(async (env) => {
    const a = await claim_new(env, "b2-a");
    env.clock.t = a.expires_at - 1;
    const hb = (await heartbeat(env.service, env.ctx("b2-hb"), g(a))).result as { expires_at: number };
    assert.equal(hb.expires_at, a.expires_at - 1 + TTL);
    env.clock.t = a.expires_at; // the old expiry
    const before = state_signature(env.db);
    assert.equal(await code_of(claim(env.service, env.ctx("b2-old"), { run_id: a.run_id })), "conflict");
    env.clock.t = hb.expires_at - 1;
    assert.equal(await code_of(claim(env.service, env.ctx("b2-new-1"), { run_id: a.run_id })), "conflict");
    assert.equal(state_signature(env.db), before, "no write while the extended lease lives");
    env.clock.t = hb.expires_at;
    const b = (await claim(env.service, env.ctx("b2-new"), { run_id: a.run_id })).result as Lease;
    assert.equal(b.fence, a.fence + 1);
  });
});

test("F1 (1) boundary: at now == expires_at the holder's own heartbeat is already dead (cannot revive the lease), and nothing is written", async () => {
  await with_core(async (env) => {
    const a = await claim_new(env, "b3-a");
    env.clock.t = a.expires_at;
    const before = state_signature(env.db);
    assert.equal(await code_of(heartbeat(env.service, env.ctx("b3-hb"), g(a))), "conflict");
    assert.equal(state_signature(env.db), before);
    // and after the takeover the old guard stays dead
    await claim(env.service, env.ctx("b3-take"), { run_id: a.run_id });
    const after = state_signature(env.db);
    assert.equal(await code_of(heartbeat(env.service, env.ctx("b3-hb2"), g(a))), "conflict");
    assert.equal(state_signature(env.db), after);
  });
});

test("F1 (1) clock rewind: after a takeover a clock that goes back before the OLD expiry cannot make the old guard or a second claim work", async () => {
  await with_core(async (env) => {
    const a = await claim_new(env, "r1-a");
    env.clock.t = a.expires_at + 5_000;
    const b = (await claim(env.service, env.ctx("r1-b"), { run_id: a.run_id })).result as Lease;
    env.clock.t = a.expires_at - 30_000; // the clock jumps back inside the dead lease's own window
    const before = state_signature(env.db);
    assert.equal(await code_of(heartbeat(env.service, env.ctx("r1-old"), g(a))), "conflict", "old lease_id/fence is dead whatever the clock says");
    assert.equal(await code_of(claim(env.service, env.ctx("r1-again"), { run_id: a.run_id })), "conflict", "the new lease is live (now < its expiry)");
    assert.equal(await code_of(claim(env.service, env.ctx("r1-fresh"), NEW_RUN)), "conflict");
    assert.equal(state_signature(env.db), before);
    // (not asserted: a heartbeat of the NEW guard under a rewound clock trips the heartbeat_at >= acquired_at CHECK as a raw
    //  SQLite error instead of an ApiError; that is older than F1 and outside this change, noted in the report)
    assert.equal(lease_of(env.db, env.p.project_id).lease_id, b.lease_id);
  });
});

test("F1 (1) clock rewind before the takeover: a dead run is NOT re-claimable if the clock goes back into the lease window, and is again once time passes", async () => {
  await with_core(async (env) => {
    const a = await claim_new(env, "r2-a");
    env.clock.t = a.expires_at + 1;
    env.clock.t = a.expires_at - 10; // rewound
    const before = state_signature(env.db);
    assert.equal(await code_of(claim(env.service, env.ctx("r2-x"), { run_id: a.run_id })), "conflict");
    assert.equal(state_signature(env.db), before);
    env.clock.t = a.expires_at;
    assert.equal(((await claim(env.service, env.ctx("r2-y"), { run_id: a.run_id })).result as Lease).fence, a.fence + 1);
  });
});

// ---------------------------------------------------------------------------------------------------------
// (2) other actor / other project / finished runs: refused, nothing changes

test("F1 (2) core: a stranger, another project, an unknown run and a finished run cannot take a dead run; each refusal leaves the database exactly as it was", async () => {
  await with_core(async (env) => {
    const stranger = add_stranger(env);
    const a = await claim_new(env, "o-a");
    env.clock.t = a.expires_at + 1;
    let before = state_signature(env.db);
    assert.equal(await code_of(claim(env.service, env.ctx("o-s", stranger), { run_id: a.run_id })), "conflict", "another actor of the same project");
    assert.equal(await code_of(claim(env.service, env.ctx("o-q", env.q), { run_id: a.run_id })), "not_found", "the same id in another project");
    assert.equal(await code_of(claim(env.service, env.ctx("o-z"), { run_id: "00000000-0000-4000-8000-000000000000" })), "not_found");
    assert.equal(await code_of(claim(env.service, env.ctx("o-pp"), { run_id: a.run_id, parent_run_id: a.run_id })), "invalid_payload");
    assert.equal(await code_of(claim(env.service, env.ctx("o-role"), { run_id: a.run_id, role: "worker" })), "invalid_payload");
    assert.equal(await code_of(claim(env.service, env.ctx("o-blank"), { run_id: "  " })), "invalid_payload");
    assert.equal(state_signature(env.db), before);

    // a finished run with a dead lease is not "dead running": complete it first, then it is simply finished
    const done = await claim_new(env, "o-done", env.q);
    await complete(env.service, env.ctx("o-done-c", env.q), g(done));
    env.clock.t = done.expires_at + 1;
    before = state_signature(env.db);
    assert.equal(await code_of(claim(env.service, env.ctx("o-fin", env.q), { run_id: done.run_id })), "conflict");
    assert.equal(state_signature(env.db), before);
  });
});

test("F1 (2) core: the owner's takeover needs the run's own actor; a stranger's refused attempt does not interrupt the dead run or end its lease", async () => {
  await with_core(async (env) => {
    const stranger = add_stranger(env);
    const a = await claim_new(env, "s-a");
    env.clock.t = a.expires_at + 1;
    const interrupted_before = events_of(env.db, env.p.project_id, "run.interrupted").length;
    await code_of(claim(env.service, env.ctx("s-try", stranger), { run_id: a.run_id }));
    assert.equal(events_of(env.db, env.p.project_id, "run.interrupted").length, interrupted_before);
    assert.equal(run_row(env.db, a.run_id).status, "running");
    assert.equal(lease_of(env.db, env.p.project_id).lease_id, a.lease_id);
    assert.equal(lease_of(env.db, env.p.project_id).state, "active");
    // the rightful actor still gets it
    assert.equal(((await claim(env.service, env.ctx("s-own"), { run_id: a.run_id })).result as Lease).fence, a.fence + 1);
  });
});

// ---------------------------------------------------------------------------------------------------------
// (4) old guard on every guarded command, before and after the takeover

test("F1 (4) core: with the expired guard, heartbeat/wait/complete/release are refused BEFORE the takeover and AFTER it (and so are mixed-up guards); the new guard works", async () => {
  await with_core(async (env) => {
    const a = await claim_new(env, "g-a");
    env.clock.t = a.expires_at; // dead exactly at the expiry
    const ops: Array<[string, (guard: ReturnType<typeof g>, key: string) => Promise<unknown>]> = [
      ["heartbeat", (guard, key) => heartbeat(env.service, env.ctx(key), guard)],
      ["wait", (guard, key) => wait(env.service, env.ctx(key), guard)],
      ["complete", (guard, key) => complete(env.service, env.ctx(key), guard)],
      ["release", (guard, key) => release(env.service, env.ctx(key), guard)],
    ];
    const refuse_all = async (guard: ReturnType<typeof g>, label: string): Promise<void> => {
      for (const [name, run_op] of ops) {
        const before = state_signature(env.db);
        assert.equal(await code_of(run_op(guard, `g-${label}-${name}-${env.clock.t}`)), "conflict", `${label}: ${name}`);
        assert.equal(state_signature(env.db), before, `${label}: ${name} changed nothing`);
      }
    };
    await refuse_all(g(a), "expired-before-takeover");
    const b = (await claim(env.service, env.ctx("g-take"), { run_id: a.run_id })).result as Lease;
    await refuse_all(g(a), "old-after-takeover");
    await refuse_all({ ...g(a), fence: b.fence }, "old lease_id + new fence");
    await refuse_all({ ...g(b), fence: a.fence }, "new lease_id + old fence");
    await refuse_all({ run_id: env.p.actor_id, lease_id: b.lease_id, fence: b.fence }, "wrong run id");
    assert.equal(run_row(env.db, a.run_id).status, "running", "the refusals did not end the run");
    await heartbeat(env.service, env.ctx("g-new-hb"), g(b));
    await complete(env.service, env.ctx("g-new-done"), g(b));
    assert.equal(run_row(env.db, a.run_id).status, "succeeded");
    // a finished run can no longer be taken, whatever the time
    env.clock.t += 10 * TTL;
    const sig = state_signature(env.db);
    assert.equal(await code_of(claim(env.service, env.ctx("g-late"), { run_id: a.run_id })), "conflict");
    assert.equal(state_signature(env.db), sig);
  });
});

// ---------------------------------------------------------------------------------------------------------
// (6) events, receipts, idempotent resend

test("F1 (6) core: one takeover = one run.interrupted(lease_expired, old lease_id, old fence) + one run.claimed + one run.claimed receipt; the run row keeps everything but status", async () => {
  await with_core(async (env) => {
    const a = await claim_new(env, "e-a");
    const fixed = run_fixed(env.db, a.run_id);
    env.clock.t = a.expires_at + 7;
    const ev_int = events_of(env.db, env.p.project_id, "run.interrupted").length;
    const ev_claim = events_of(env.db, env.p.project_id, "run.claimed").length;
    const rc = receipts_of(env.db, env.p.project_id);
    const b = (await claim(env.service, env.ctx("e-take"), { run_id: a.run_id })).result as Lease;

    const interrupted = events_of(env.db, env.p.project_id, "run.interrupted");
    assert.equal(interrupted.length, ev_int + 1);
    const last = interrupted[interrupted.length - 1]!;
    assert.equal(last.run_id, a.run_id);
    assert.deepEqual(last.payload, { reason: "lease_expired", lease_id: a.lease_id, fence: a.fence });
    const claimed = events_of(env.db, env.p.project_id, "run.claimed");
    assert.equal(claimed.length, ev_claim + 1);
    assert.equal(claimed[claimed.length - 1]!.run_id, a.run_id);
    assert.equal(claimed[claimed.length - 1]!.payload.fence, b.fence);
    assert.deepEqual(receipts_of(env.db, env.p.project_id), [...rc, "run.claimed"]);
    assert.equal(run_fixed(env.db, a.run_id), fixed, "actor, mode, labels, parent, base rev and started_at are untouched");
    assert.equal(run_row(env.db, a.run_id).status, "running");
    assert.equal(lease_of(env.db, env.p.project_id).run_id, a.run_id);
    assert.equal(
      env.db.all("SELECT 1 FROM project_leases WHERE project_id = ?", env.p.project_id).length,
      1,
      "still one lease row per project",
    );
    assert.equal(env.db.all("SELECT 1 FROM runs WHERE project_id = ?", env.p.project_id).length, 1, "no second run appeared");
  });
});

test("F1 (6) core: the same key resent (before and after a later takeover) returns the FIRST result and writes nothing; the same key with another run_id is refused; a second death/takeover adds exactly one more pair", async () => {
  await with_core(async (env) => {
    const a = await claim_new(env, "k-a");
    env.clock.t = a.expires_at;
    const first = (await claim(env.service, env.ctx("k-1"), { run_id: a.run_id })).result as Lease;
    let sig = state_signature(env.db);
    const replay = (await claim(env.service, env.ctx("k-1"), { run_id: a.run_id })).result as Lease;
    assert.deepEqual(replay, first, "live lease, same key: the stored answer");
    assert.equal(state_signature(env.db), sig, "no new row of any kind");
    // another request under the same key is not an answer, and writes nothing
    const other = await claim_new(env, "k-other", env.q);
    sig = state_signature(env.db);
    const reuse = await code_of(claim(env.service, env.ctx("k-1"), { run_id: other.run_id }));
    assert.equal(reuse, "idempotency_key_reuse", "the key check comes before any run lookup");
    assert.equal(state_signature(env.db), sig);

    // the process dies again; a second takeover under a new key
    env.clock.t = first.expires_at;
    const second = (await claim(env.service, env.ctx("k-2"), { run_id: a.run_id })).result as Lease;
    assert.equal(second.fence, a.fence + 2);
    const mine = events_of(env.db, env.p.project_id, "run.interrupted", a.run_id);
    assert.deepEqual(
      mine.map((e) => [e.payload.reason, e.payload.lease_id, e.payload.fence]),
      [
        ["lease_expired", a.lease_id, a.fence],
        ["lease_expired", first.lease_id, first.fence],
      ],
      "each generation's lease is ended once, with its own ids",
    );
    assert.equal(receipts_of(env.db, env.p.project_id).filter((x) => x === "run.claimed").length, 4 - 1 /* k-other is on q */ + 0, "k-a, k-1, k-2 on p");
    // the first key still answers with the FIRST result, not the newest lease
    sig = state_signature(env.db);
    assert.deepEqual((await claim(env.service, env.ctx("k-1"), { run_id: a.run_id })).result, first);
    assert.equal(state_signature(env.db), sig);
  });
});

// ---------------------------------------------------------------------------------------------------------
// (3) concurrency

test("F1 (3) core: same actor, two overlapping takeovers of one dead run in one process: exactly one wins, the loser leaves nothing", async () => {
  await with_core(async (env) => {
    const a = await claim_new(env, "c-a");
    env.clock.t = a.expires_at;
    const results = await Promise.allSettled([
      claim(env.service, env.ctx("c-1"), { run_id: a.run_id }),
      claim(env.service, env.ctx("c-2"), { run_id: a.run_id }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(lost.reason instanceof ApiError);
    assert.equal(lost.reason.code, "conflict");
    assert.equal(events_of(env.db, env.p.project_id, "run.interrupted", a.run_id).length, 1, "the dead lease is ended once");
    assert.equal(receipts_of(env.db, env.p.project_id).filter((x) => x === "run.claimed").length, 2, "the first claim and one takeover");
    assert.equal(lease_of(env.db, env.p.project_id).fence, a.fence + 1);
    assert.equal(env.db.all("SELECT 1 FROM runs WHERE project_id = ?", env.p.project_id).length, 1);
  });
});

test("F1 (3) core: a stranger's NEW claim and the owner's takeover race at the expiry — either order leaves one live lease, one winner, one fence step, and no duplicated interrupt", async () => {
  for (const owner_first of [true, false]) {
    await with_core(async (env) => {
      const stranger = add_stranger(env);
      const a = await claim_new(env, "x-a");
      env.clock.t = a.expires_at;
      const take = () => claim(env.service, env.ctx("x-take"), { run_id: a.run_id });
      const fresh = () => claim(env.service, env.ctx("x-fresh", stranger), NEW_RUN);
      const results = await Promise.allSettled(owner_first ? [take(), fresh()] : [fresh(), take()]);
      const winners = results.filter((r) => r.status === "fulfilled").length;
      assert.equal(winners, 1, `owner_first=${owner_first}: exactly one winner`);
      const lease = lease_of(env.db, env.p.project_id);
      assert.equal(lease.state, "active");
      assert.equal(lease.fence, a.fence + 1);
      const runs = env.db.all<{ id: string; status: string; actor_id: string }>("SELECT id, status, actor_id FROM runs WHERE project_id = ? ORDER BY rowid", env.p.project_id);
      const dead = runs.find((r) => r.id === a.run_id)!;
      const interrupts = events_of(env.db, env.p.project_id, "run.interrupted", a.run_id);
      if (lease.run_id === a.run_id) {
        assert.equal(dead.status, "running");
        assert.equal(runs.length, 1, "the stranger's lost claim created no run");
        assert.equal(interrupts.length, 1);
        assert.equal(interrupts[0]!.payload.lease_id, a.lease_id);
      } else {
        assert.equal(dead.status, "interrupted", "displaced by the stranger's claim");
        assert.equal(runs.length, 2);
        assert.equal(interrupts.length, 1);
        // the owner's takeover can no longer start: the stranger's lease is live
        const sig = state_signature(env.db);
        assert.equal(await code_of(claim(env.service, env.ctx("x-late"), { run_id: a.run_id })), "conflict");
        assert.equal(state_signature(env.db), sig);
      }
      assert.equal(env.db.all("SELECT 1 FROM project_leases WHERE project_id = ? AND state = 'active'", env.p.project_id).length, 1);
    });
  }
});

test("F1 (3) two real processes take over the same dead run at the same instant: exactly one wins, the loser leaves no trace", async () => {
  const env = await make_core();
  try {
    const a = await claim_new(env, "p-a");
    const at = a.expires_at;
    const file = db_path(env.home.env);
    const job = (key: string): ChildJob => ({ db: file, now: at, key, project_id: env.p.project_id, actor_id: env.p.actor_id, payload: { run_id: a.run_id } });
    const rounds: Array<Array<Awaited<ReturnType<typeof run_child>>>> = [];
    rounds.push(await Promise.all([run_child(env.home, job("p-1")), run_child(env.home, job("p-2"))]));
    const [r1, r2] = rounds[0]!;
    const wins = [r1!, r2!].filter((r) => r.ok);
    const losses = [r1!, r2!].filter((r) => !r.ok);
    assert.equal(wins.length, 1, `one winner (got ${JSON.stringify(rounds[0])})`);
    assert.equal(losses[0]!.code, "conflict");
    assert.equal(wins[0]!.run_id, a.run_id);
    assert.equal(wins[0]!.fence, a.fence + 1);
    assert.equal(events_of(env.db, env.p.project_id, "run.interrupted", a.run_id).length, 1);
    assert.equal(receipts_of(env.db, env.p.project_id).filter((x) => x === "run.claimed").length, 2);
    assert.equal(env.db.all("SELECT 1 FROM runs WHERE project_id = ?", env.p.project_id).length, 1);
    assert.equal(lease_of(env.db, env.p.project_id).lease_id, wins[0]!.lease_id);
  } finally {
    env.close();
  }
});

test("F1 (3) two real processes: the owner's takeover vs a stranger's new claim — one lease, one winner, consistent run states", async () => {
  const env = await make_core();
  try {
    const stranger = add_stranger(env);
    const a = await claim_new(env, "q-a");
    const file = db_path(env.home.env);
    const [mine, theirs] = await Promise.all([
      run_child(env.home, { db: file, now: a.expires_at, key: "q-take", project_id: env.p.project_id, actor_id: env.p.actor_id, payload: { run_id: a.run_id } }),
      run_child(env.home, { db: file, now: a.expires_at, key: "q-fresh", project_id: env.p.project_id, actor_id: stranger.actor_id, payload: NEW_RUN }),
    ]);
    assert.equal([mine, theirs].filter((r) => r.ok).length, 1, `one winner (${JSON.stringify([mine, theirs])})`);
    const lease = lease_of(env.db, env.p.project_id);
    assert.equal(lease.fence, a.fence + 1);
    const dead = run_row(env.db, a.run_id);
    if (mine.ok) {
      assert.equal(dead.status, "running");
      assert.equal(env.db.all("SELECT 1 FROM runs WHERE project_id = ?", env.p.project_id).length, 1);
    } else {
      assert.equal(dead.status, "interrupted");
      assert.equal(env.db.all("SELECT 1 FROM runs WHERE project_id = ?", env.p.project_id).length, 2);
    }
    assert.equal(events_of(env.db, env.p.project_id, "run.interrupted", a.run_id).length, 1);
  } finally {
    env.close();
  }
});

// ---------------------------------------------------------------------------------------------------------
// API / SEL-68: revoked token, demoted actor, Go OFF, wrong actor, replay after change

const GO_MODEL = "opencode-go/deepseek-v4.1-flash";
const A_BODY = { mode: "A", runtime: "pes_builtin", provider: "opencode-go", model: GO_MODEL };
const B_BODY = { mode: "B", runtime: "codex_cli", provider: "openai", model: "unknown" };
const API_TTL = 120_000;
const claim_http = (env: ApiEnv, auth: Auth, body: unknown, key?: string): Promise<ApiResponse> =>
  call(env, { method: "POST", path: P(env, "/claims"), auth, body, key });

async function dead_run(env: ApiEnv, token: string, body: Record<string, unknown>): Promise<{ run_id: string; lease_id: string; fence: string }> {
  const held = assert_ok(await claim_http(env, { token }, body));
  env.clock.advance(API_TTL + 1);
  return held;
}

test("F1 (2) API: a dead B run — a revoked token, another agent, a human session and a wrong project are all refused, nothing written; the rightful token takes it", async () => {
  await with_api(async (env) => {
    const mine = await make_agent(env, "f1-mine");
    const other = await make_agent(env, "f1-other");
    const held = await dead_run(env, mine.token, B_BODY);
    env.db.run("UPDATE agent_tokens SET revoked_at = ? WHERE id = ?", 1n, mine.token_id);
    const before = state_signature(env.db);
    const revoked = await claim_http(env, { token: mine.token }, { run_id: held.run_id });
    assert.ok(revoked.status === 401 || revoked.status === 403, `revoked token: ${revoked.status}`);
    assert.equal(assert_error(await claim_http(env, { token: other.token }, { run_id: held.run_id }), 409, "conflict").code, "conflict");
    assert.ok([403, 409].includes((await claim_http(env, "owner", { run_id: held.run_id })).status), "the human session is not the run's actor");
    assert.equal((await claim_http(env, "none", { run_id: held.run_id })).status, 401);
    assert.equal((await call(env, { method: "POST", path: `/api/v1/projects/00000000-0000-4000-8000-000000000000/claims`, auth: { token: mine.token }, body: { run_id: held.run_id } })).status >= 400, true);
    assert.equal(state_signature(env.db), before, "none of the refusals touched the database");
    env.db.run("UPDATE agent_tokens SET revoked_at = NULL WHERE id = ?", mine.token_id);
    const taken = assert_ok(await claim_http(env, { token: mine.token }, { run_id: held.run_id }));
    assert.equal(taken.run_id, held.run_id);
    assert.equal(taken.fence, String(Number(held.fence) + 1));
  });
});

test("F1 (2) API/SEL-68: a dead mode A run — an external token, a demoted actor and Go OFF are refused before any write; demoted/ON again works; a resent takeover key is re-checked each time", async () => {
  await with_api(async (env) => {
    const ext = await make_agent(env, "f1-ext");
    const int = await make_agent(env, "f1-int", undefined, "internal_ai");
    const held = await dead_run(env, int.token, A_BODY);
    let before = state_signature(env.db);
    assert_error(await claim_http(env, { token: ext.token }, { run_id: held.run_id }), 403, "forbidden");
    assert.equal(state_signature(env.db), before, "an external agent never takes an A run, dead or not");

    // demoted: forbidden, and Go OFF wins nothing over forbidden
    env.db.run("UPDATE actors SET kind = 'external_agent' WHERE id = ?", int.actor_id);
    assert_error(await claim_http(env, { token: int.token }, { run_id: held.run_id }), 403, "forbidden");
    await go_off(env);
    before = state_signature(env.db);
    assert_error(await claim_http(env, { token: int.token }, { run_id: held.run_id }), 403, "forbidden");
    assert.equal(state_signature(env.db), before);
    env.db.run("UPDATE actors SET kind = 'internal_ai' WHERE id = ?", int.actor_id);
    before = state_signature(env.db);
    assert_error(await claim_http(env, { token: int.token }, { run_id: held.run_id }), 403, "policy_blocked");
    assert.equal(state_signature(env.db), before, "Go OFF refuses the takeover with no write");
    const row = env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", held.run_id);
    assert.equal(row?.status, "interrupted", "Go OFF interrupted the live A run; the refusals themselves wrote nothing");

    // ON again: takeover works under key K; then the actor is demoted / Go switched off and K is resent
    const { set_policy } = await import("../scripts/pes_core/policy.ts");
    await set_policy(env.service, env.ctx("f1-go-on"), { allow_opencode_go: true, reason: "합성: Go 켜기" });
    const taken = assert_ok(await claim_http(env, { token: int.token }, { run_id: held.run_id }, "f1-take-key"));
    assert.equal(taken.fence, String(Number(held.fence) + 1));
    const stored = state_signature(env.db);
    assert.deepEqual(assert_ok(await claim_http(env, { token: int.token }, { run_id: held.run_id }, "f1-take-key")), taken, "same key, same answer");
    assert.equal(state_signature(env.db), stored, "no new row on the replay");
    env.db.run("UPDATE actors SET kind = 'external_agent' WHERE id = ?", int.actor_id);
    assert_error(await claim_http(env, { token: int.token }, { run_id: held.run_id }, "f1-take-key"), 403, "forbidden");
    env.db.run("UPDATE actors SET kind = 'internal_ai' WHERE id = ?", int.actor_id);
    await go_off(env);
    assert_error(await claim_http(env, { token: int.token }, { run_id: held.run_id }, "f1-take-key"), 403, "policy_blocked");
    await set_policy(env.service, env.ctx("f1-go-on-2"), { allow_opencode_go: true, reason: "합성: Go 켜기" });
    assert.deepEqual(assert_ok(await claim_http(env, { token: int.token }, { run_id: held.run_id }, "f1-take-key")), taken, "restored: the first answer again");
  });
});

test("F1 (2) API: a live lease is never taken (even by the same actor), at expires_at-1; at expires_at it is — both through HTTP", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "f1-live");
    const held = assert_ok(await claim_http(env, { token: agent.token }, B_BODY));
    const lease = env.db.get<{ expires_at: bigint }>("SELECT expires_at FROM project_leases WHERE project_id = ?", env.p.project_id)!;
    env.clock.advance(Number(lease.expires_at) - env.clock.now_ms() - 1);
    const before = state_signature(env.db);
    assert_error(await claim_http(env, { token: agent.token }, { run_id: held.run_id }), 409, "conflict");
    assert.equal(state_signature(env.db), before);
    env.clock.advance(1);
    const taken = assert_ok(await claim_http(env, { token: agent.token }, { run_id: held.run_id }));
    assert.equal(taken.fence, String(Number(held.fence) + 1));
  });
});

// ---------------------------------------------------------------------------------------------------------
// (8) CLI claim

test("F1 (8) CLI: `claim --run` takes a dead B run back (same run, fence+1); another agent, a live lease and a bad token do not; refusals change nothing", async () => {
  await with_cli(async (c) => {
    const mine = await c.agent("cli-f1-mine");
    const other = await c.agent("cli-f1-other");
    const first = json_out(c.run(["claim", SLUG], { PES_TOKEN: mine.token }));
    // the CLI reads the real clock: age the lease in the (temporary) database instead of waiting
    const now = Date.now();
    c.env.db.run(
      "UPDATE project_leases SET acquired_at = ?, heartbeat_at = ?, expires_at = ? WHERE project_id = ?",
      BigInt(now - 100_000),
      BigInt(now - 90_000),
      BigInt(now - 1_000),
      c.env.p.project_id,
    );
    let before = state_signature(c.env.db);
    let commits = c.commits().length;
    expect_rejected(c.run(["claim", SLUG, "--run", first.run_id], { PES_TOKEN: other.token }), "another agent");
    expect_rejected(c.run(["claim", SLUG, "--run", first.run_id], { PES_TOKEN: "pes_not_a_token" }), "bad token");
    assert.equal(state_signature(c.env.db), before);
    assert.equal(c.commits().length, commits);

    const again = json_out(c.run(["claim", SLUG, "--run", first.run_id], { PES_TOKEN: mine.token }));
    assert.equal(again.run_id, first.run_id);
    assert.equal(Number(again.fence), Number(first.fence) + 1);
    assert.equal(c.commits().length, commits + 1);

    before = state_signature(c.env.db);
    commits = c.commits().length;
    expect_rejected(c.run(["claim", SLUG, "--run", first.run_id], { PES_TOKEN: mine.token }), "live lease");
    expect_rejected(c.run(["claim", SLUG], { PES_TOKEN: other.token }), "a fresh claim while the lease is live");
    assert.equal(state_signature(c.env.db), before);
    assert.equal(c.commits().length, commits);
  });
});

// ---------------------------------------------------------------------------------------------------------
// cross env: B over MCP and A through the built-in runner, with real data

const B: Side = { kind: "B", tool: B_TOOLS[0]! };
const DATA_TABLES = ["objects", "object_versions", "run_input_receipts", "outbound_dispatches", "blobs", "questions", "question_sets", "assumptions", "decisions"];

/** rows of the tables that hold the work itself (never touched by a lease change) */
function data_sig(db: DbType): string {
  const present = new Set(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name));
  return DATA_TABLES.filter((t) => present.has(t))
    .map((t) => `${t}:${JSON.stringify(db.all(`SELECT * FROM "${t}" ORDER BY rowid`), (_k, v) => (typeof v === "bigint" ? `${v}n` : v))}`)
    .join("\n");
}

const GUARD_OPS = ["submit", "ask", "wait", "release", "complete", "heartbeat"] as const;

async function refuse_every_guard_op(env: CrossEnv, who: Driver, old: Guard, label: string): Promise<void> {
  for (const op of GUARD_OPS) {
    const before = state_signature(env.db);
    const got = await who.step({ op, guard_value: old });
    assert.equal(got.ok, false, `${label}: ${op} must be refused`);
    assert.equal(got.code, "conflict", `${label}: ${op} → conflict (got ${got.code})`);
    if (who.side.kind === "B") assert.equal(got.raw_code, b_stale_guard_raw_code(op), `${label}: ${op} B's own spelling (got ${got.raw_code})`);
    assert.deepEqual(got.events, [], `${label}: ${op} wrote no event`);
    assert.deepEqual(got.receipts, [], `${label}: ${op} left no receipt`);
    assert.equal(state_signature(env.db), before, `${label}: ${op} changed nothing`);
  }
}

test("F1 (4)(6)(7)(8) MCP: a restarted B client takes its dead run back by run_id — nothing it had submitted is lost, the old guard is dead on all six tools before and after, a repeated key replays", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const opened = await ready_cross(env);
    const first = new Driver(env, B);
    assert.equal((await first.step({ op: "claim" })).ok, true);
    const old = first.guard!;
    assert.equal((await first.step({ op: "submit", title: "죽기 전에 낸 첫 결과" })).versions_added, 1);
    assert.equal((await first.step({ op: "submit", title: "죽기 전에 낸 둘째 결과" })).versions_added, 1);
    const chain_before = versions_of(env, opened.object_id);
    const data_before = data_sig(env.db);
    assert.equal(chain_before.length, 3, "the opening version and two submissions");

    // alive: the claim by run_id is refused and nothing changes
    const client = await env.mcp_client(B_TOOLS[0]!);
    let sig = state_signature(env.db);
    const live = await client.tool("pes_claim", { idempotency_key: "m-live", run_id: old.run_id });
    assert.equal(live.is_error, true);
    assert.equal(live.data.error.code, "conflict");
    assert.equal(state_signature(env.db), sig);

    // dead: exactly at expires_at
    const lease = lease_row(env)!;
    const exp = Number(env.db.get<{ expires_at: bigint }>("SELECT expires_at FROM project_leases WHERE project_id = ?", env.p.project_id)!.expires_at);
    env.clock.advance(exp - env.clock.now_ms() - 1);
    const edge = await client.tool("pes_claim", { idempotency_key: "m-edge", run_id: old.run_id });
    assert.equal(edge.is_error, true, "expires_at-1: still alive");
    env.clock.advance(1);
    await refuse_every_guard_op(env, first, old, "expired, not yet taken");
    assert.equal(data_sig(env.db), data_before);

    const ev = Number(env.db.get<{ n: bigint }>("SELECT max(event_seq) AS n FROM events WHERE project_id = ?", env.p.project_id)!.n);
    const taken = await client.tool("pes_claim", { idempotency_key: "m-take", run_id: old.run_id });
    assert.equal(taken.is_error, false, JSON.stringify(taken.data));
    assert.equal(taken.data.run_id, old.run_id);
    assert.equal(Number(taken.data.fence), old.fence + 1);
    const after = lease_row(env)!;
    assert.equal(after.state, "active");
    assert.equal(after.lease_id, taken.data.lease_id, "the lease row is the new one");
    assert.equal(after.fence, old.fence + 1, "fence rose by exactly one");
    assert.notEqual(after.lease_id, lease.lease_id);
    const types = env.db
      .all<{ type: string }>("SELECT type FROM events WHERE project_id = ? AND event_seq > ? ORDER BY event_seq", env.p.project_id, ev)
      .map((r) => r.type);
    assert.deepEqual(types, ["run.interrupted", "run.claimed"]);
    assert.equal(run_info(env, old.run_id).status, "running");
    assert.equal(data_sig(env.db), data_before, "the takeover moved no byte of the work");
    assert.deepEqual(versions_of(env, opened.object_id), chain_before);

    // repeating the key replays the first answer and writes nothing
    sig = state_signature(env.db);
    const replay = await client.tool("pes_claim", { idempotency_key: "m-take", run_id: old.run_id });
    const { replayed: _r, ...replay_data } = replay.data;
    assert.deepEqual(replay_data, taken.data, "the first answer");
    assert.equal(state_signature(env.db), sig);

    // the old guard is dead on every tool now; the new one works, and appends to the same chain
    await refuse_every_guard_op(env, first, old, "old guard after takeover");
    const second = new Driver(env, B);
    second.guard = { run_id: taken.data.run_id, lease_id: taken.data.lease_id, fence: Number(taken.data.fence) };
    assert.equal((await second.step({ op: "heartbeat" })).ok, true);
    assert.equal((await second.step({ op: "submit", title: "이어받은 뒤 낸 결과" })).versions_added, 1);
    const chain = versions_of(env, opened.object_id);
    assert.deepEqual(chain.map((v) => v.version_no), [1, 2, 3, 4], "one chain, no gap, no copy");
    assert.deepEqual(chain.slice(0, 3), chain_before, "earlier versions are byte-for-byte the same rows");
    assert.equal(chain[3]!.run_id, old.run_id);
    assert.equal((await second.step({ op: "complete" })).run_status, "succeeded");
  });
});

test("F1 (2)(8) MCP: another agent's token cannot take a dead B run, nor an A run; a revoked or foreign token changes nothing", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    await ready_cross(env);
    const owner_b = new Driver(env, B);
    await owner_b.step({ op: "claim" });
    const run_id = owner_b.guard!.run_id;
    env.clock.advance(125_000);
    const other = await make_agent_for(env, "f1-b2");
    const other_client = await env.mcp_client(B_TOOLS[0]!, other.token);
    const sig = state_signature(env.db);
    const refused = await other_client.tool("pes_claim", { idempotency_key: "o-1", run_id });
    assert.equal(refused.is_error, true);
    assert.equal(refused.data.error.code, "conflict");
    assert.equal(state_signature(env.db), sig, "the dead run was not touched by another agent");
    // the owner's own agent may still take it
    const again = await (await env.mcp_client(B_TOOLS[0]!)).tool("pes_claim", { idempotency_key: "o-2", run_id });
    assert.equal(again.is_error, false);
  });
});

async function make_agent_for(env: CrossEnv, name: string): Promise<{ actor_id: string; token: string }> {
  const owner = env.db.get<{ owner_user_id: string }>("SELECT owner_user_id FROM projects WHERE id = ?", env.p.project_id)!;
  const actor_id = `agent-${name}`;
  env.db.run("INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, 'external_agent', ?, ?)", actor_id, owner.owner_user_id, `합성 ${name}`);
  const out = await issue_agent_token(env.service, env.ctx(`tok-${name}`), { actor_id, scopes: ["context:read", "run:claim", "run:submit", "file:write", "file:read"] });
  return { actor_id, token: (out.result as { token: string }).token };
}

test("F1 (3)(8) MCP: two clients of the SAME agent race for one dead run: one wins, one conflict, one interrupt event, one new fence", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    await ready_cross(env);
    const dead = new Driver(env, B);
    await dead.step({ op: "claim" });
    const old = dead.guard!;
    env.clock.advance(125_000);
    const c1 = await env.mcp_client(B_TOOLS[0]!);
    const c2 = await env.mcp_client(B_TOOLS[0]!);
    const [r1, r2] = await Promise.all([
      c1.tool("pes_claim", { idempotency_key: "race-1", run_id: old.run_id }),
      c2.tool("pes_claim", { idempotency_key: "race-2", run_id: old.run_id }),
    ]);
    assert.equal([r1, r2].filter((r) => !r.is_error).length, 1);
    const lost = [r1, r2].find((r) => r.is_error)!;
    assert.equal(lost.data.error.code, "conflict");
    assert.equal(lease_row(env)!.fence, old.fence + 1);
    assert.equal(
      env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM events WHERE project_id = ? AND type = 'run.interrupted' AND run_id = ?", env.p.project_id, old.run_id)!.n,
      1n,
    );
    assert.equal(run_info(env, old.run_id).status, "running");
    assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM runs WHERE project_id = ?", env.p.project_id)!.n, 1n);
  });
});

// ---------------------------------------------------------------------------------------------------------
// (5) A resume

interface Mortal {
  env: CrossEnv;
  die(): void;
  revive(): void;
}

async function mortal_env(): Promise<Mortal> {
  let dead = false;
  const gate = (db: Db): Db => {
    const stop = (): void => {
      if (dead) throw new Error("synthetic: the process died");
    };
    return {
      path: db.path,
      exec: (sql) => {
        if (!/^\s*(SELECT|PRAGMA)/i.test(sql)) stop();
        return db.exec(sql);
      },
      prepare: (sql) => db.prepare(sql),
      run: (sql, ...params) => {
        stop();
        return db.run(sql, ...params);
      },
      get: (sql, ...params) => db.get(sql, ...params),
      all: (sql, ...params) => db.all(sql, ...params),
      close: () => db.close(),
    };
  };
  const env = await make_cross_env("openai_compatible", { wrap: gate, save_retries: 0 });
  return { env, die: () => void (dead = true), revive: () => void (dead = false) };
}

/** the process dies while the first model call is in flight: a `running` run, an active lease, one call that may have gone out */
async function die_mid_call(m: Mortal): Promise<{ run_id: string; object_id: string }> {
  const { env } = m;
  const opened = await ready_cross(env);
  set_script(env, [context_turn(), submit_turn(opened.object_id, "죽기 전 계획"), FINISH]);
  env.fake.on_call = (n) => {
    if (n === 1) m.die();
  };
  await assert.rejects(start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id }));
  m.revive();
  env.fake.on_call = undefined;
  const run = all_runs(env)[0]!;
  assert.equal(run.status, "running");
  assert.equal(dispatches(env, run.id)[0]!.state, "sent");
  return { run_id: run.id, object_id: opened.object_id };
}

function bytes_of_dispatches(env: CrossEnv, run_id: string): string {
  return JSON.stringify(dispatches(env, run_id), (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
}

for (const state of ["prepared", "authorized", "sent", "unknown"] as const) {
  test(`F1 (5) A: a dead run with a '${state}' call is NOT resumable (conflict), the call row stays byte-identical, nothing is sent, no lease is taken`, async () => {
    const m = await mortal_env();
    try {
      const { env } = m;
      const { run_id } = await die_mid_call(m);
      if (state !== "sent") {
        env.db.run(
          "UPDATE outbound_dispatches SET state = ?, unknown_at = ?, unknown_reason = ?, authorized_at = COALESCE(authorized_at, ?) WHERE run_id = ?",
          state,
          state === "unknown" ? BigInt(env.clock.now_ms()) : null,
          state === "unknown" ? "synthetic_unknown" : null,
          BigInt(env.clock.now_ms()),
          run_id,
        );
      }
      env.clock.advance(125_000); // the lease is long dead
      env.exec = new BuiltinExecutor(env.deps);
      set_script(env, [FINISH]);
      const calls = env.fake.calls.length;
      const rows = bytes_of_dispatches(env, run_id);
      const sig = state_signature(env.db);
      const refused = await resume_outcome(env, run_id);
      assert.ok(refused.error instanceof ApiError, "resume is refused");
      assert.equal(refused.error!.code, "conflict");
      assert.equal(env.fake.calls.length, calls, "nothing is sent");
      assert.equal(bytes_of_dispatches(env, run_id), rows, "the call row is exactly as the dead process left it");
      assert.equal(state_signature(env.db), sig, "no run, lease, event or receipt moved");
      assert.equal(run_info(env, run_id).status, "running");
    } finally {
      await m.env.close_cross();
    }
  });
}

test("F1 (5) A: one millisecond before the lease dies a person cannot settle the call and the run cannot resume; exactly at expires_at both work, once, with one pair of events and one new fence; the settled row is not rewritten", async () => {
  const m = await mortal_env();
  try {
    const { env } = m;
    const { run_id, object_id } = await die_mid_call(m);
    const lease0 = lease_row(env)!;
    const exp = Number(env.db.get<{ expires_at: bigint }>("SELECT expires_at FROM project_leases WHERE project_id = ?", env.p.project_id)!.expires_at);
    const call_row = dispatches(env, run_id)[0]!;
    const settle = () =>
      env.service.execute(env.ctx(next_key(env, "settle")), "dispatch.resolve_unknown", { dispatch_id: call_row.id, outcome: "not_charged", note: "합성: 콘솔 확인" });
    env.exec = new BuiltinExecutor(env.deps);

    // alive by one millisecond: the person is told the run is still working; resume is refused; nothing moves
    env.clock.advance(exp - env.clock.now_ms() - 1);
    set_script(env, [submit_turn(object_id, "이어 쓴 계획"), FINISH]);
    let sig = state_signature(env.db);
    const calls = env.fake.calls.length;
    await assert.rejects(settle(), (e: unknown) => e instanceof ApiError && e.code === "conflict");
    assert.equal((await resume_outcome(env, run_id)).error?.code, "conflict", "a live lease is never taken");
    assert.equal(state_signature(env.db), sig);
    assert.equal(env.fake.calls.length, calls);

    // exactly dead: settle, then resume
    env.clock.advance(1);
    await settle();
    const settled_first = JSON.stringify(dispatches(env, run_id)[0], (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
    const ev = Number(env.db.get<{ n: bigint }>("SELECT max(event_seq) AS n FROM events WHERE project_id = ?", env.p.project_id)!.n);
    const done = await resume_outcome(env, run_id);
    assert.equal(done.error, null, `${done.error?.code}: ${done.error?.message}`);
    assert.equal(done.result?.run_id, run_id, "the same run");
    assert.equal(done.result?.status, "succeeded");
    assert.equal(lease_row(env)!.fence, lease0.fence + 1);
    const types = env.db
      .all<{ type: string; payload: string }>("SELECT type, payload FROM events WHERE project_id = ? AND event_seq > ? AND run_id = ? ORDER BY event_seq", env.p.project_id, ev, run_id)
      .filter((e) => e.type === "run.interrupted" || e.type === "run.claimed");
    assert.deepEqual(types.map((e) => e.type), ["run.interrupted", "run.claimed"]);
    assert.match(types[0]!.payload, /lease_expired/);
    const after_first = JSON.stringify(dispatches(env, run_id)[0], (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
    assert.equal(after_first, settled_first, "the settled call row itself is unchanged by the resume");
    // a second resume of the now-finished run is refused
    sig = state_signature(env.db);
    assert.equal((await resume_outcome(env, run_id)).error?.code, "conflict");
    assert.equal(state_signature(env.db), sig);
  } finally {
    await m.env.close_cross();
  }
});

test("F1 (5) A: Go OFF refuses the resume of a dead, settled run (policy_denied, before the status check, nothing sent or written); ON again it resumes", async () => {
  const m = await mortal_env();
  try {
    const { env } = m;
    const { run_id, object_id } = await die_mid_call(m);
    env.clock.advance(125_000);
    const call_row = dispatches(env, run_id)[0]!;
    env.exec = new BuiltinExecutor(env.deps);
    await policy_off(env);
    // OFF with the call still open: the switch is read first
    set_script(env, [submit_turn(object_id, "이어 쓴 계획"), FINISH]);
    let sig = state_signature(env.db);
    let calls = env.fake.calls.length;
    assert.equal((await resume_outcome(env, run_id)).error?.code, "policy_denied");
    assert.equal(state_signature(env.db), sig);
    await env.service.execute(env.ctx(next_key(env, "settle")), "dispatch.resolve_unknown", { dispatch_id: call_row.id, outcome: "not_charged", note: "합성" });
    sig = state_signature(env.db);
    calls = env.fake.calls.length;
    assert.equal((await resume_outcome(env, run_id)).error?.code, "policy_denied", "settled, still OFF");
    assert.equal(state_signature(env.db), sig);
    assert.equal(env.fake.calls.length, calls);
    assert.equal(run_info(env, run_id).status, "interrupted", "Go OFF itself ends a live A run; the refusals add nothing");
    await policy_on(env);
    const back = await resume_outcome(env, run_id);
    assert.equal(back.error, null, `${back.error?.code}: ${back.error?.message}`);
    assert.equal(back.result?.status, "succeeded");
  } finally {
    await m.env.close_cross();
  }
});

test("F1 (2)(5) A: a demoted AI actor cannot resume its dead run (forbidden, nothing sent, nothing written)", async () => {
  const m = await mortal_env();
  try {
    const { env } = m;
    const { run_id } = await die_mid_call(m);
    env.clock.advance(125_000);
    const call_row = dispatches(env, run_id)[0]!;
    await env.service.execute(env.ctx(next_key(env, "settle")), "dispatch.resolve_unknown", { dispatch_id: call_row.id, outcome: "not_charged", note: "합성" });
    env.exec = new BuiltinExecutor(env.deps);
    env.db.run("UPDATE actors SET kind = 'external_agent' WHERE id = ?", env.ai_actor_id);
    set_script(env, [FINISH]);
    const sig = state_signature(env.db);
    const calls = env.fake.calls.length;
    const got = await resume_outcome(env, run_id);
    assert.ok(got.error, "refused");
    assert.equal(got.error!.code, "forbidden");
    assert.equal(env.fake.calls.length, calls);
    assert.equal(state_signature(env.db), sig);
    assert.equal(run_info(env, run_id).status, "running");
  } finally {
    await m.env.close_cross();
  }
});

test("F1 (3)(5) A: B's new claim after the expiry interrupts the dead A run; A's resume is then refused while B's lease lives and works after B lets go (new fence above B's)", async () => {
  const m = await mortal_env();
  try {
    const { env } = m;
    const { run_id, object_id } = await die_mid_call(m);
    env.clock.advance(125_000);
    const call_row = dispatches(env, run_id)[0]!;
    await env.service.execute(env.ctx(next_key(env, "settle")), "dispatch.resolve_unknown", { dispatch_id: call_row.id, outcome: "not_charged", note: "합성" });
    env.exec = new BuiltinExecutor(env.deps);
    const b = new Driver(env, B);
    assert.equal((await b.step({ op: "claim" })).ok, true);
    assert.equal(run_info(env, run_id).status, "interrupted");
    set_script(env, [submit_turn(object_id, "이어 쓴 계획"), FINISH]);
    const sig = state_signature(env.db);
    const calls = env.fake.calls.length;
    assert.equal((await resume_outcome(env, run_id)).error?.code, "conflict", "B's lease is live");
    assert.equal(state_signature(env.db), sig);
    assert.equal(env.fake.calls.length, calls);
    assert.equal((await b.step({ op: "release" })).lease, "released");
    const fence_b = b.previous!.fence;
    const back = await resume_outcome(env, run_id);
    assert.equal(back.error, null, `${back.error?.code}: ${back.error?.message}`);
    assert.equal(back.result?.run_id, run_id);
    assert.equal(lease_row(env)!.fence, fence_b + 1);
  } finally {
    await m.env.close_cross();
  }
});

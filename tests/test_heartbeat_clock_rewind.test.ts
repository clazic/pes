/**
 * SEL-69 [결함] 시계가 되감긴 뒤 heartbeat 가 원시 SQLite CHECK 오류(heartbeat_at >= acquired_at) 로 끝난다.
 *
 * leader 결정(정답):
 *   - 시계가 되감긴 상태(now < acquired_at)의 heartbeat 는 성공한다.
 *   - heartbeat_at = max(now, acquired_at). 이어서 CHECK(acquired_at <= heartbeat_at < expires_at) 는 늘 참이다.
 *   - expires_at = max(기존 expires_at, now + ttl). 되감긴 시계로 만료를 앞당기지 않는다(줄지 않는다).
 *   - 만료 판정(now < expires_at 이어야 현재 lease)은 그대로다. 되감긴 시계가 죽은 lease 를 살리지는 못한다.
 *   - 쓰기는 정해진 것만: lease 행의 heartbeat_at·expires_at, 사건 run.heartbeat 1개, 영수증 run.heartbeat 1개.
 *   - 응답의 expires_at 은 실제로 저장된 값(= max(기존, now + ttl)). now + ttl 이 아니다.
 *   - 응답·오류 어디에도 SQL·표 이름·열 이름이 나오지 않는다.
 *
 * 해석 (구현이 갈릴 수 있는 곳, 시험이 고른 쪽):
 *   해석 1. 되감긴 시각의 heartbeat_at 은 정확히 acquired_at 이다(now 도 아니고 이전 heartbeat_at 도 아니다).
 *   해석 2. 이미 한 번 늘어난 expires_at 위에서 되감겨도 expires_at 은 그 늘어난 값을 지킨다(처음 claim 값으로 돌아가지 않는다).
 *   해석 3. 이전 heartbeat_at 보다 작아지는 것은 허용한다(단조 증가를 요구하지 않는다). 요구는 heartbeat_at >= acquired_at 뿐이다.
 *   해석 4. 되감긴 heartbeat 도 평소처럼 사건 1개·영수증 1개를 남기고, 같은 키 재전송은 첫 결과 그대로이며 새 행이 0이다.
 *   해석 5. 정상 시계로 돌아온 다음 heartbeat 는 평소 규칙(heartbeat_at = now, expires_at = now + ttl)이다.
 *   해석 6. 되감긴 시계에서도 틀린 lease_id / 틀린 fence 는 평소처럼 거부(core conflict, HTTP·MCP lease_lost)이고 아무것도 쓰지 않는다.
 *
 * 경로: 코어 run.heartbeat · API POST /runs/{r}/heartbeat · MCP pes_heartbeat(B, 도구 하나) · A 도구 경로(run.heartbeat 명령) ·
 *       A 내장 실행기 루프(BuiltinExecutor 가 모델 호출마다 보내는 heartbeat).
 * 모두 합성 자료·임시 HOME/PES_HOME·FakeClock(인스턴스의 now_ms 를 덮어써 양방향으로 움직인다).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError } from "../scripts/pes_core/errors.ts";
import { heartbeat } from "../scripts/pes_core/runs.ts";
import { assert_error, assert_ok, call, agent_claims, make_agent, with_api, type ApiEnv, type ApiResponse } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { Driver, type Guard, type Side } from "./helpers/cross_driver.ts";
import { B_TOOLS, make_cross_env, ready_cross, with_cross_env, type CrossEnv } from "./helpers/cross_env.ts";
import {
  FINISH,
  context_turn,
  open_stage,
  ready_project,
  set_script,
  start_run,
  submit_turn,
  with_a_env,
  type AEnv,
} from "./helpers/a_builtin_env.ts";

const START_MS = 1_760_000_000_000;
/** how far the clock goes back before the lease's acquired_at: one millisecond, one hour */
const DELTAS: Array<[string, number]> = [
  ["1 ms back (acquired_at - 1)", 1],
  ["1 hour back (acquired_at - 3 600 000)", 3_600_000],
];
const B: Side = { kind: "B", tool: B_TOOLS[0]! };
const A: Side = { kind: "A" };
/** nothing the caller sees may name the SQL layer or a table/column */
const SQL_WORDS = /CHECK|constraint|SQLITE|project_leases|heartbeat_at|acquired_at|SELECT |UPDATE |INSERT /i;

// ---------------------------------------------------------------------------------------------------------
// a clock that moves both ways (FakeClock only moves forward): the instance's now_ms is replaced

interface Movable {
  set(t: number): void;
  now(): number;
}

function movable(env: { clock: { now_ms(): number } }): Movable {
  let current = env.clock.now_ms();
  (env.clock as { now_ms(): number }).now_ms = () => current;
  return {
    set(t) {
      current = t;
    },
    now: () => current,
  };
}

// ---------------------------------------------------------------------------------------------------------
// reading what a heartbeat may and may not change

interface LeaseSnap {
  lease_id: string;
  run_id: string | null;
  owner_actor_id: string | null;
  fence: number;
  state: string;
  acquired_at: number;
  heartbeat_at: number;
  expires_at: number;
}

interface DbEnv {
  db: CrossEnv["db"];
  p: { project_id: string };
}

function lease_snap(env: DbEnv): LeaseSnap {
  const row = env.db.get<any>(
    "SELECT lease_id, run_id, owner_actor_id, fence, state, acquired_at, heartbeat_at, expires_at FROM project_leases WHERE project_id = ?",
    env.p.project_id,
  );
  assert.ok(row, "the project has a lease row");
  return {
    lease_id: row.lease_id,
    run_id: row.run_id,
    owner_actor_id: row.owner_actor_id,
    state: row.state,
    fence: Number(row.fence),
    acquired_at: Number(row.acquired_at),
    heartbeat_at: Number(row.heartbeat_at),
    expires_at: Number(row.expires_at),
  };
}

function guard_of(l: LeaseSnap): Guard {
  assert.ok(l.run_id);
  return { run_id: l.run_id, lease_id: l.lease_id, fence: l.fence };
}

function last_event_seq(env: DbEnv): number {
  return Number(env.db.get<{ n: bigint | null }>("SELECT max(event_seq) AS n FROM events WHERE project_id = ?", env.p.project_id)?.n ?? 0n);
}

function last_receipt(env: DbEnv): number {
  return Number(env.db.get<{ n: bigint | null }>("SELECT max(rowid) AS n FROM mutation_commits WHERE project_id = ?", env.p.project_id)?.n ?? 0n);
}

function events_since(env: DbEnv, seq: number): Array<{ type: string; payload: any }> {
  return env.db
    .all<{ type: string; payload: unknown }>("SELECT type, payload FROM events WHERE project_id = ? AND event_seq > ? ORDER BY event_seq", env.p.project_id, seq)
    .map((e) => ({ type: e.type, payload: typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload }));
}

function receipts_since(env: DbEnv, rowid: number): string[] {
  return env.db
    .all<{ action: string }>("SELECT action FROM mutation_commits WHERE project_id = ? AND rowid > ? ORDER BY rowid", env.p.project_id, rowid)
    .map((r) => r.action);
}

function run_json(env: DbEnv, run_id: string): string {
  const row = env.db.get<any>("SELECT * FROM runs WHERE id = ?", run_id);
  assert.ok(row);
  return JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
}

// ---------------------------------------------------------------------------------------------------------
// the shared check: one rewind, then one normal heartbeat. `beat` sends ONE heartbeat with the given key and returns the
// expires_at the path REPORTED to its caller.

type Beat = (key: string) => Promise<number>;

async function rewind_then_recover(env: DbEnv, clock: Movable, label: string, delta: number, beat: Beat, ttl: number): Promise<void> {
  const before = lease_snap(env);
  const run_before = run_json(env, before.run_id!);
  const ev = last_event_seq(env);
  const rc = last_receipt(env);

  clock.set(before.acquired_at - delta);
  const reported = await beat(`${label}-rewound`);

  const after = lease_snap(env);
  // the lease is the same lease, nothing but the two time columns moved
  assert.equal(after.lease_id, before.lease_id, `${label}: same lease`);
  assert.equal(after.fence, before.fence);
  assert.equal(after.state, "active");
  assert.equal(after.owner_actor_id, before.owner_actor_id);
  assert.equal(after.run_id, before.run_id);
  assert.equal(after.acquired_at, before.acquired_at, `${label}: acquired_at is never rewritten`);
  // 해석 1: max(now, acquired_at) = acquired_at
  assert.equal(after.heartbeat_at, after.acquired_at, `${label}: heartbeat_at = max(now, acquired_at) = acquired_at`);
  assert.ok(after.heartbeat_at >= after.acquired_at);
  // the expiry does not move back, and (the clock being behind) does not move at all
  assert.ok(after.expires_at >= before.expires_at, `${label}: expires_at never shrinks`);
  assert.equal(after.expires_at, before.expires_at, `${label}: a rewound clock does not move the expiry (max(old, now + ttl) = old)`);
  assert.ok(after.expires_at > after.heartbeat_at, `${label}: the lease stays alive`);
  // the caller is told the stored value, not now + ttl
  assert.equal(reported, after.expires_at, `${label}: the reported expires_at is the stored one`);
  assert.notEqual(reported, clock.now() + ttl, `${label}: ... and not now + ttl of the rewound clock`);
  // the run itself and the writes: exactly one event and one receipt of the heartbeat
  assert.equal(run_json(env, before.run_id!), run_before, `${label}: the run row is untouched`);
  const events = events_since(env, ev);
  assert.deepEqual(events.map((e) => e.type), ["run.heartbeat"], `${label}: one event`);
  assert.equal(Number(events[0]!.payload.expires_at), after.expires_at, `${label}: the event carries the stored expiry`);
  assert.deepEqual(receipts_since(env, rc), ["run.heartbeat"], `${label}: one receipt`);

  // 해석 5: back on a normal clock the usual rule holds
  const normal = before.acquired_at + 1_000;
  clock.set(normal);
  const reported2 = await beat(`${label}-normal`);
  const again = lease_snap(env);
  assert.equal(again.lease_id, before.lease_id);
  assert.equal(again.heartbeat_at, normal, `${label}: heartbeat_at = now again`);
  assert.equal(again.expires_at, normal + ttl, `${label}: expires_at = now + ttl again`);
  assert.equal(reported2, again.expires_at);
  assert.ok(again.expires_at >= after.expires_at);
  assert.equal(run_json(env, before.run_id!), run_before);
  assert.deepEqual(receipts_since(env, rc), ["run.heartbeat", "run.heartbeat"]);
}

function ttl_of(l: LeaseSnap): number {
  return l.expires_at - l.heartbeat_at;
}

// ---------------------------------------------------------------------------------------------------------
// beats per path

function core_beat(env: CrossEnv, guard: Guard, actor_id: string): Beat {
  return async (key) => {
    const out = await heartbeat(env.service, env.agent_ctx(actor_id, key), guard);
    return Number((out.result as { expires_at: number }).expires_at);
  };
}

function api_beat(env: ApiEnv, token: string, guard: Guard): Beat {
  return async (key) => {
    const res = await call(env, {
      method: "POST",
      path: P(env, `/runs/${guard.run_id}/heartbeat`),
      auth: { token },
      key,
      body: { lease_id: guard.lease_id, fence: String(guard.fence) },
    });
    const data = assert_ok(res);
    assert.doesNotMatch(JSON.stringify(res.json), SQL_WORDS, "a heartbeat answer never names SQL or a table");
    return Number(data.lease.expires_at);
  };
}

function driver_beat(driver: Driver): Beat {
  return async (key) => {
    const res = await driver.step({ op: "heartbeat", key });
    assert.equal(res.ok, true, `${driver.label}: heartbeat must succeed, got ${res.code}: ${res.message}`);
    assert.doesNotMatch(JSON.stringify(res.data ?? {}), SQL_WORDS, "a heartbeat answer never names SQL or a table");
    const data = res.data;
    // B: the API answer { lease: { expires_at } }; A tool path: the core result { expires_at }
    const value = data?.lease?.expires_at ?? data?.expires_at;
    assert.equal(typeof value, "number", `${driver.label}: the answer carries expires_at (${JSON.stringify(data)})`);
    return Number(value);
  };
}

async function b_claim(env: CrossEnv): Promise<Driver> {
  const driver = new Driver(env, B);
  const claimed = await driver.step({ op: "claim" });
  assert.equal(claimed.ok, true, `${claimed.code}: ${claimed.message}`);
  return driver;
}

async function a_claim_driver(env: CrossEnv): Promise<Driver> {
  const driver = new Driver(env, A);
  const claimed = await driver.step({ op: "claim" });
  assert.equal(claimed.ok, true, `${claimed.code}: ${claimed.message}`);
  return driver;
}

// ---------------------------------------------------------------------------------------------------------
// core: run.heartbeat

for (const [name, delta] of DELTAS) {
  test(`core run.heartbeat, clock ${name}: succeeds, heartbeat_at = acquired_at, expires_at does not shrink, then a normal heartbeat works`, async () => {
    await with_cross_env("openai_compatible", async (env) => {
      const clock = movable(env);
      await ready_cross(env);
      const first = await b_claim(env);
      const lease = lease_snap(env);
      assert.equal(lease.acquired_at, START_MS);
      await rewind_then_recover(env, clock, `core-${delta}`, delta, core_beat(env, guard_of(lease), env.agent.actor_id), ttl_of(lease));
      void first;
    });
  });
}

test("core run.heartbeat: a rewound clock after an EARLIER heartbeat extended the lease keeps that extended expiry (해석 2, 3)", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const clock = movable(env);
    await ready_cross(env);
    await b_claim(env);
    const lease = lease_snap(env);
    const ttl = ttl_of(lease);
    const beat = core_beat(env, guard_of(lease), env.agent.actor_id);

    clock.set(lease.acquired_at + 30_000);
    assert.equal(await beat("ext-1"), lease.acquired_at + 30_000 + ttl);
    const extended = lease_snap(env);
    assert.equal(extended.expires_at, lease.acquired_at + 30_000 + ttl);
    assert.equal(extended.heartbeat_at, lease.acquired_at + 30_000);

    // back before acquired_at: the lease keeps the later expiry; heartbeat_at is no earlier than acquired_at (3: it may go below the old heartbeat_at)
    clock.set(lease.acquired_at - 1);
    const reported = await beat("ext-2");
    const after = lease_snap(env);
    assert.equal(after.expires_at, extended.expires_at, "the extended expiry is kept, not reset to the claim's");
    assert.equal(reported, extended.expires_at);
    assert.ok(after.heartbeat_at >= after.acquired_at);
    assert.ok(after.expires_at > after.heartbeat_at);

    // back inside the window between acquired_at and the earlier heartbeat: still no shrink
    clock.set(lease.acquired_at + 10_000);
    const inside = await beat("ext-3");
    const inside_row = lease_snap(env);
    assert.equal(inside_row.expires_at, extended.expires_at, "now + ttl is earlier than the stored expiry, so the stored one stays");
    assert.equal(inside, extended.expires_at);
    assert.ok(inside_row.heartbeat_at >= inside_row.acquired_at);
    assert.equal(inside_row.heartbeat_at, lease.acquired_at + 10_000, "inside the window, heartbeat_at = now");
  });
});

test("core run.heartbeat: a rewound heartbeat with a progress note keeps the note and still leaves one event and one receipt", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const clock = movable(env);
    await ready_cross(env);
    await b_claim(env);
    const lease = lease_snap(env);
    const ev = last_event_seq(env);
    const rc = last_receipt(env);
    clock.set(lease.acquired_at - 3_600_000);
    const out = await heartbeat(env.service, env.agent_ctx(env.agent.actor_id, "prog-1"), { ...guard_of(lease), progress: { phase: "researching" } } as never);
    const result = out.result as { expires_at: number; progress: { phase: string; observed_at: number } };
    assert.equal(result.progress.phase, "researching");
    assert.equal(result.expires_at, lease.expires_at);
    const after = lease_snap(env);
    assert.equal(after.heartbeat_at, after.acquired_at);
    assert.deepEqual(events_since(env, ev).map((e) => e.type), ["run.heartbeat"]);
    assert.deepEqual(receipts_since(env, rc), ["run.heartbeat"]);
  });
});

test("core run.heartbeat: repeating a rewound heartbeat's key replays the first answer and writes nothing (해석 4)", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const clock = movable(env);
    await ready_cross(env);
    await b_claim(env);
    const lease = lease_snap(env);
    clock.set(lease.acquired_at - 1);
    const ctx = env.agent_ctx(env.agent.actor_id, "replay-1");
    const first = await heartbeat(env.service, ctx, guard_of(lease));
    const snap = lease_snap(env);
    const ev = last_event_seq(env);
    const rc = last_receipt(env);
    // time passes on a normal clock; the same key still gives the same answer and moves nothing
    clock.set(lease.acquired_at + 5_000);
    const second = await heartbeat(env.service, ctx, guard_of(lease));
    assert.deepEqual(second.result, first.result, "the first answer");
    assert.equal(second.replayed, true);
    assert.deepEqual(lease_snap(env), snap, "the lease row did not move on the replay");
    assert.equal(last_event_seq(env), ev);
    assert.equal(last_receipt(env), rc);
  });
});

test("core run.heartbeat: a rewound clock does not make a wrong lease_id / wrong fence work, and nothing is written (해석 6)", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const clock = movable(env);
    await ready_cross(env);
    await b_claim(env);
    const lease = lease_snap(env);
    clock.set(lease.acquired_at - 1);
    const snap = lease_snap(env);
    const ev = last_event_seq(env);
    const rc = last_receipt(env);
    const g = guard_of(lease);
    for (const [what, bad] of [
      ["wrong lease_id", { ...g, lease_id: "00000000-0000-4000-8000-000000000000" }],
      ["wrong fence", { ...g, fence: g.fence + 1 }],
    ] as const) {
      try {
        await heartbeat(env.service, env.agent_ctx(env.agent.actor_id, `bad-${what}`), bad);
        assert.fail(`${what}: expected a rejection`);
      } catch (error) {
        assert.ok(error instanceof ApiError, `${what}: an ApiError, not a raw error (${String(error)})`);
        assert.equal(error.code, "conflict", what);
        assert.doesNotMatch(error.message, SQL_WORDS);
      }
    }
    assert.deepEqual(lease_snap(env), snap);
    assert.equal(last_event_seq(env), ev);
    assert.equal(last_receipt(env), rc);
  });
});

test("core run.heartbeat: a rewound clock does not revive a lease that is already dead (now >= expires_at stays a conflict)", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const clock = movable(env);
    await ready_cross(env);
    await b_claim(env);
    const lease = lease_snap(env);
    // time passes beyond the expiry: the lease is dead whatever happens afterwards
    clock.set(lease.expires_at);
    const snap = lease_snap(env);
    await assert.rejects(heartbeat(env.service, env.agent_ctx(env.agent.actor_id, "dead-1"), guard_of(lease)), (e: unknown) => e instanceof ApiError && e.code === "conflict");
    assert.deepEqual(lease_snap(env), snap, "an expired lease is not touched");
  });
});

// ---------------------------------------------------------------------------------------------------------
// API: POST /runs/{r}/heartbeat

for (const [name, delta] of DELTAS) {
  test(`API POST heartbeat, clock ${name}: 200 with the stored expiry, no SQL words, then a normal heartbeat works`, async () => {
    await with_api(async (env) => {
      const clock = movable(env);
      const agent = await make_agent(env, "hb-rewind");
      const held = await agent_claims(env, agent);
      const lease = lease_snap(env);
      assert.equal(lease.lease_id, held.lease_id);
      await rewind_then_recover(env, clock, `api-${delta}`, delta, api_beat(env, agent.token, guard_of(lease)), ttl_of(lease));
    });
  });
}

test("API POST heartbeat: a wrong lease or wrong fence under a rewound clock is a plain lease_lost (409), no SQL words, nothing written", async () => {
  await with_api(async (env) => {
    const clock = movable(env);
    const agent = await make_agent(env, "hb-rewind-bad");
    await agent_claims(env, agent);
    const lease = lease_snap(env);
    clock.set(lease.acquired_at - 3_600_000);
    const snap = lease_snap(env);
    const ev = last_event_seq(env);
    const rc = last_receipt(env);
    const path = P(env, `/runs/${lease.run_id}/heartbeat`);
    const bad_lease: ApiResponse = await call(env, { method: "POST", path, auth: { token: agent.token }, body: { lease_id: "00000000-0000-4000-8000-000000000000", fence: String(lease.fence) } });
    assert_error(bad_lease, 409, "lease_lost");
    const bad_fence: ApiResponse = await call(env, { method: "POST", path, auth: { token: agent.token }, body: { lease_id: lease.lease_id, fence: String(lease.fence + 1) } });
    assert_error(bad_fence, 409, "lease_lost");
    assert.deepEqual(lease_snap(env), snap);
    assert.equal(last_event_seq(env), ev);
    assert.equal(last_receipt(env), rc);
  });
});

test("API POST heartbeat: repeating a rewound heartbeat's Idempotency-Key replays the first answer, nothing new is written (해석 4)", async () => {
  await with_api(async (env) => {
    const clock = movable(env);
    const agent = await make_agent(env, "hb-rewind-replay");
    await agent_claims(env, agent);
    const lease = lease_snap(env);
    clock.set(lease.acquired_at - 1);
    const send = (): Promise<ApiResponse> =>
      call(env, {
        method: "POST",
        path: P(env, `/runs/${lease.run_id}/heartbeat`),
        auth: { token: agent.token },
        key: "api-replay-1",
        body: { lease_id: lease.lease_id, fence: String(lease.fence) },
      });
    const first = assert_ok(await send());
    const snap = lease_snap(env);
    const ev = last_event_seq(env);
    const rc = last_receipt(env);
    const again = await send();
    const second = assert_ok(again);
    assert.deepEqual(second.lease, first.lease, "the same lease answer");
    assert.equal(again.headers["idempotent-replayed"] ?? again.headers["x-idempotent-replayed"] ?? "true", "true");
    assert.deepEqual(lease_snap(env), snap);
    assert.equal(last_event_seq(env), ev);
    assert.equal(last_receipt(env), rc);
  });
});

// ---------------------------------------------------------------------------------------------------------
// MCP: pes_heartbeat (B), one tool; the explicit-guard form and the guard-the-server-remembers form

for (const [name, delta] of DELTAS) {
  test(`MCP pes_heartbeat (B), clock ${name}: succeeds (no isError), stored expiry reported, no SQL words, then a normal heartbeat works`, async () => {
    await with_cross_env("openai_compatible", async (env) => {
      const clock = movable(env);
      await ready_cross(env);
      const driver = await b_claim(env);
      const lease = lease_snap(env);
      assert.deepEqual(driver.guard, guard_of(lease));
      await rewind_then_recover(env, clock, `mcp-${delta}`, delta, driver_beat(driver), ttl_of(lease));
    });
  });
}

test("MCP pes_heartbeat: under a rewound clock the server remembers the guard of its own claim (no arguments) and the heartbeat still succeeds", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const clock = movable(env);
    await ready_cross(env);
    const client = await env.mcp_client(B_TOOLS[0]!);
    const claimed = await client.tool("pes_claim", { idempotency_key: "mcp-mem-claim" });
    assert.equal(claimed.is_error, false, JSON.stringify(claimed.data));
    const lease = lease_snap(env);
    clock.set(lease.acquired_at - 1);
    const hb = await client.tool("pes_heartbeat", { idempotency_key: "mcp-mem-hb" });
    assert.equal(hb.is_error, false, `a rewound heartbeat is not an error: ${JSON.stringify(hb.data)}`);
    assert.doesNotMatch(JSON.stringify(hb.raw), SQL_WORDS);
    const after = lease_snap(env);
    assert.equal(after.heartbeat_at, after.acquired_at);
    assert.equal(after.expires_at, lease.expires_at);
  });
});

test("MCP pes_heartbeat: a stale guard under a rewound clock is the usual lease_lost, never a raw error, and nothing is written (해석 6)", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const clock = movable(env);
    await ready_cross(env);
    const driver = await b_claim(env);
    const lease = lease_snap(env);
    clock.set(lease.acquired_at - 3_600_000);
    const snap = lease_snap(env);
    const ev = last_event_seq(env);
    const rc = last_receipt(env);
    for (const bad of [{ ...driver.guard!, fence: driver.guard!.fence + 1 }, { ...driver.guard!, lease_id: "00000000-0000-4000-8000-000000000000" }]) {
      const res = await driver.step({ op: "heartbeat", guard_value: bad });
      assert.equal(res.ok, false);
      assert.equal(res.raw_code, "lease_lost");
      assert.doesNotMatch(String(res.message), SQL_WORDS);
    }
    assert.deepEqual(lease_snap(env), snap);
    assert.equal(last_event_seq(env), ev);
    assert.equal(last_receipt(env), rc);
  });
});

// ---------------------------------------------------------------------------------------------------------
// A: the tool path (the run.heartbeat command an internal_ai actor sends)

for (const [name, delta] of DELTAS) {
  test(`A tool path run.heartbeat (internal_ai), clock ${name}: succeeds, heartbeat_at = acquired_at, expiry does not shrink, then a normal heartbeat works`, async () => {
    await with_cross_env("openai_compatible", async (env) => {
      const clock = movable(env);
      await ready_cross(env);
      const driver = await a_claim_driver(env);
      const lease = lease_snap(env);
      assert.equal(lease.owner_actor_id, env.ai_actor_id);
      await rewind_then_recover(env, clock, `a-${delta}`, delta, driver_beat(driver), ttl_of(lease));
    });
  });
}

// ---------------------------------------------------------------------------------------------------------
// A: the built-in executor's own loop. It sends run.heartbeat before every model call ("keep the lease alive for the length
// of the call"). The service's execute is wrapped so that only the 2nd heartbeat of the run sees a rewound clock and the 3rd a
// normal one; every other command (and the model calls) see the clock as it was.

for (const [name, delta] of DELTAS) {
  test(`A executor loop, clock ${name}: the heartbeat before a model call survives a rewound clock — the run goes on and succeeds, the lease stays sane`, async () => {
    await with_a_env("openai_compatible", async (env: AEnv) => {
      const clock = movable(env);
      await ready_project(env);
      const opened = await open_stage(env, "plan");
      set_script(env, [context_turn(), context_turn(), context_turn(), submit_turn(opened.object_id, "합성 되감기 결과"), FINISH]);

      const original = env.service.execute.bind(env.service);
      let beats = 0;
      const seen: Array<{ n: number; before: LeaseSnap; after: LeaseSnap; reported: number }> = [];
      (env.service as { execute: unknown }).execute = async (ctx: any, command: string, payload: any) => {
        if (command !== "run.heartbeat") return original(ctx, command, payload);
        beats += 1;
        const n = beats;
        const saved = clock.now();
        const before = lease_snap(env);
        if (n === 2) clock.set(before.acquired_at - delta);
        try {
          const out = await original(ctx, command, payload);
          seen.push({ n, before, after: lease_snap(env), reported: Number((out.result as { expires_at: number }).expires_at) });
          return out;
        } finally {
          // heartbeat 2 returns to a clock a little LATER than before it (time kept running); the others leave the clock alone
          clock.set(n === 2 ? saved + 1_000 : saved);
        }
      };

      const res = await start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id });
      assert.equal(res.status, "succeeded", `the run must not die on a rewound heartbeat: ${JSON.stringify(res)}`);
      assert.ok(beats >= 3, `the loop heartbeats before each call (saw ${beats})`);

      const second = seen.find((s) => s.n === 2)!;
      assert.ok(second, "heartbeat 2 ran");
      assert.equal(second.after.lease_id, second.before.lease_id);
      assert.equal(second.after.acquired_at, second.before.acquired_at);
      assert.equal(second.after.heartbeat_at, second.after.acquired_at, "heartbeat_at = acquired_at under the rewound clock");
      assert.equal(second.after.expires_at, second.before.expires_at, "the expiry did not move");
      assert.equal(second.reported, second.after.expires_at, "the loop was told the stored expiry");

      const third = seen.find((s) => s.n === 3)!;
      assert.ok(third, "heartbeat 3 ran");
      assert.equal(third.after.lease_id, second.before.lease_id, "same lease the whole time");
      assert.equal(third.after.heartbeat_at, third.before.acquired_at + 1_000, "back on a normal clock: heartbeat_at = now");
      assert.equal(third.after.expires_at, third.after.heartbeat_at + (second.before.expires_at - second.before.heartbeat_at), "expires_at = now + ttl");

      // every row of the lease is sane at the end and every heartbeat event of this run names an expiry that never went down
      const end = lease_snap(env);
      assert.ok(end.heartbeat_at >= end.acquired_at);
      const expiries = env.db
        .all<{ payload: unknown }>("SELECT payload FROM events WHERE project_id = ? AND type = 'run.heartbeat' ORDER BY event_seq", env.p.project_id)
        .map((e) => Number((typeof e.payload === "string" ? JSON.parse(e.payload) : (e.payload as any)).expires_at));
      assert.equal(expiries.length, beats);
      for (let i = 1; i < expiries.length; i += 1) assert.ok(expiries[i]! >= expiries[i - 1]!, `heartbeat event ${i + 1}: the reported expiry never shrinks (${expiries.join(", ")})`);
    });
  });
}

// ---------------------------------------------------------------------------------------------------------
// one more look from the outside: the make_cross_env helper is imported so a failed setup names this file
void make_cross_env;

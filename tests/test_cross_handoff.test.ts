/**
 * SEL-56 PR21 — A·B 교차 계약, 인계편 (tester, 작성 모드). 완료 조건 2·3:
 *   2  유실·중복 0, 옛 fence 거부(A·B 교차로)
 *   3  A→B·B→A 인계 뒤 새 claim/fence 가 선다, 옛 guard(lease_id·fence) 재사용은 거부
 * One database, A (internal_ai, built-in runner tool path / real executor) and B (external_agent over MCP) taking the
 * project turn by turn. Sources: docs/plan/stage-2-db-guarantees.md 8.16~8.19, decision 0019, SEL-68.
 *
 * 해석:
 *  해석 9   "인계" = lease 를 내려놓음(release / 만료 / interrupt) → 다른 쪽의 NEW claim. B 는 A 의 run 을 run_id 로
 *           이어받지 못한다(SEL-68: mode A run 은 internal_ai 만) — 그래서 인계 뒤에는 새 run·새 lease·새 fence 다.
 *  해석 10  fence 는 프로젝트 하나의 lease 줄 하나에서 claim 마다 정확히 1 오른다(양쪽 공통 카운터). 시험은 '엄격 증가'와
 *           '1 씩'을 둘 다 건다.
 *  해석 11  같은 idempotency key 의 재전송은 lease 가 넘어간 뒤에도 '처음 답 재생'이다(docs 8.17: PES 가 자격·정책을
 *           검사한 뒤 처음 답을 재생). 새 쓰기도 오류도 아니다. 이 가정이 틀리면 실패하고 결함 후보로 적는다.
 *  해석 13  제출(result.submit / pes_submit)은 승인이 아니다: 새 버전은 저장되지만 사람이 채택하기 전에는 자료의 current 가
 *           아니라서 다음 실행의 context 에 나오지 않는다. '유실 0'은 버전 사슬이 DB 에 그대로 남는 것으로 시험한다.
 *  해석 12  경합하는 두 claim 중 진 쪽은 conflict 이고 아무것도 남기지 않는다. 단 A 쪽은 owner 가 run.create 를 먼저 하므로
 *           진 A 의 queued run 1개가 남을 수 있다(고아가 아니라 나중에 claim 할 수 있는 대기 run).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { b_stale_guard_raw_code, Driver, type Guard, type Side } from "./helpers/cross_driver.ts";
import {
  B_TOOLS,
  lease_row,
  ready_cross,
  run_info,
  versions_of,
  with_cross_env,
  type BTool,
  type CrossEnv,
} from "./helpers/cross_env.ts";
import { FINISH, context_turn, request_text, set_script, start_run, submit_turn } from "./helpers/a_builtin_env.ts";

const A: Side = { kind: "A" };
const DIRECT = B_TOOLS.filter((t) => t.direct !== null);
const bside = (tool: BTool): Side => ({ kind: "B", tool });
const GUARD_OPS = ["submit", "ask", "wait", "release", "complete", "heartbeat"] as const;

interface World {
  versions: number;
  events: number;
  receipts: number;
  runs: string;
  lease: string;
}

/** What a rejected guard must not have changed: version/event/receipt counts, run statuses, the lease row. */
function world(env: CrossEnv): World {
  const n = (sql: string): number => Number(env.db.get<{ n: bigint }>(sql, env.p.project_id)!.n);
  return {
    versions: Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM object_versions")!.n),
    events: n("SELECT count(*) AS n FROM events WHERE project_id = ?"),
    receipts: n("SELECT count(*) AS n FROM mutation_commits WHERE project_id = ?"),
    runs: JSON.stringify(env.db.all("SELECT id, status FROM runs WHERE project_id = ? ORDER BY rowid", env.p.project_id)),
    lease: JSON.stringify(lease_row(env)),
  };
}

/** Every guard-taking tool of `side` with an OLD guard: refused, and the world did not move. */
async function assert_old_guard_refused(env: CrossEnv, who: Driver, old: Guard, label: string): Promise<void> {
  for (const op of GUARD_OPS) {
    const before = world(env);
    const got = await who.step({ op, guard_value: old });
    assert.equal(got.ok, false, `${label}: ${op} with an old guard must be refused`);
    assert.equal(got.code, "conflict", `${label}: ${op} → conflict (got ${got.code})`);
    if (who.side.kind === "B") assert.equal(got.raw_code, b_stale_guard_raw_code(op), `${label}: ${op} B's own spelling (got ${got.raw_code})`);
    assert.deepEqual(got.events, [], `${label}: ${op} wrote no event`);
    assert.deepEqual(got.receipts, [], `${label}: ${op} left no receipt`);
    assert.deepEqual(world(env), before, `${label}: ${op} changed nothing`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// 3. A → B and B → A: a new claim, a new fence, a new lease

for (const tool of DIRECT) {
  test(`A → B (${tool.id}): B's claim is a new run / lease / fence; A's old guard is refused on every tool; no version lost or doubled`, async () => {
    await with_cross_env("openai_compatible", async (env) => {
      const opened = await ready_cross(env);
      const a = new Driver(env, A);
      const b = new Driver(env, bside(tool));
      assert.equal((await a.step({ op: "claim" })).ok, true);
      const a_guard = a.guard!;
      assert.equal((await a.step({ op: "submit", title: "A 가 쓴 것" })).versions_added, 1);
      assert.equal((await a.step({ op: "release" })).lease, "released");
      assert.equal(lease_row(env)!.fence, a_guard.fence, "released keeps the fence it had");

      const claimed = await b.step({ op: "claim" });
      assert.equal(claimed.ok, true);
      const b_guard = b.guard!;
      assert.notEqual(b_guard.run_id, a_guard.run_id, "a new run, not A's run");
      assert.notEqual(b_guard.lease_id, a_guard.lease_id, "a new lease");
      assert.equal(b_guard.fence, a_guard.fence + 1, "해석 10: the fence goes up by exactly one");
      const lease = lease_row(env)!;
      assert.equal(lease.state, "active");
      assert.equal(lease.owner_actor_id, env.agent.actor_id);
      assert.equal(lease.run_id, b_guard.run_id);
      assert.equal(run_info(env, a_guard.run_id).status, "queued", "A's released run is left as it was");

      // B sees A's version as the current one and adds its own on top
      const sub = await b.step({ op: "submit", title: "B 가 이어 쓴 것" });
      assert.equal(sub.ok, true);
      const versions = versions_of(env, opened.object_id);
      assert.deepEqual(versions.map((v) => v.version_no), [1, 2, 3], "one chain, no gap, no copy");
      assert.deepEqual(versions.slice(1).map((v) => v.run_id), [a_guard.run_id, b_guard.run_id]);

      // A's whole old guard is dead on every tool
      await assert_old_guard_refused(env, a, a_guard, "A's old guard");
      assert.equal(lease_row(env)!.lease_id, b_guard.lease_id, "B's lease is untouched by the refusals");
      assert.equal((await b.step({ op: "heartbeat" })).ok, true, "B still works");
    });
  });

  test(`B (${tool.id}) → A: A's claim is a new run / lease / fence; B's old guard is refused on every tool`, async () => {
    await with_cross_env("openai_compatible", async (env) => {
      const opened = await ready_cross(env);
      const a = new Driver(env, A);
      const b = new Driver(env, bside(tool));
      assert.equal((await b.step({ op: "claim" })).ok, true);
      const b_guard = b.guard!;
      assert.equal((await b.step({ op: "submit", title: "B 가 쓴 것" })).versions_added, 1);
      assert.equal((await b.step({ op: "release" })).lease, "released");

      const claimed = await a.step({ op: "claim" });
      assert.equal(claimed.ok, true);
      const a_guard = a.guard!;
      assert.notEqual(a_guard.run_id, b_guard.run_id);
      assert.notEqual(a_guard.lease_id, b_guard.lease_id);
      assert.equal(a_guard.fence, b_guard.fence + 1, "해석 10");
      const lease = lease_row(env)!;
      assert.equal(lease.owner_actor_id, env.ai_actor_id);
      assert.equal(lease.run_id, a_guard.run_id);

      assert.equal((await a.step({ op: "submit", title: "A 가 이어 쓴 것" })).versions_added, 1);
      assert.deepEqual(versions_of(env, opened.object_id).map((v) => v.version_no), [1, 2, 3]);
      await assert_old_guard_refused(env, b, b_guard, "B's old guard");
      assert.equal(lease_row(env)!.lease_id, a_guard.lease_id);
    });
  });
}

test("a claim while the other side holds a live lease is refused on both paths and writes nothing", async () => {
  for (const [first, second] of [
    [A, bside(DIRECT[0]!)],
    [bside(DIRECT[0]!), A],
    [bside(DIRECT[0]!), bside(DIRECT[1]!)],
  ] as Array<[Side, Side]>) {
    await with_cross_env("openai_compatible", async (env) => {
      await ready_cross(env);
      const one = new Driver(env, first);
      const two = new Driver(env, second);
      assert.equal((await one.step({ op: "claim" })).ok, true);
      const holder = lease_row(env)!;
      const before = world(env);
      const got = await two.step({ op: "claim" });
      assert.equal(got.ok, false, `${one.label} holds; ${two.label} must be refused`);
      assert.equal(got.code, "conflict");
      assert.deepEqual(got.receipts.filter((r) => r === "run.claimed"), [], "no claim receipt");
      assert.deepEqual(lease_row(env), holder, "the holder's lease row is unchanged");
      // the loser leaves no running run; an A loser may leave its queued run (해석 12)
      assert.equal(env.db.all("SELECT 1 FROM runs WHERE project_id = ? AND status = 'running'", env.p.project_id).length, 1);
      assert.equal(world(env).versions, before.versions);
    });
  }
});

test("a claim race: exactly one of A and B wins, the other is refused, one active lease remains", async () => {
  for (const tool of DIRECT) {
    await with_cross_env("openai_compatible", async (env) => {
      await ready_cross(env);
      const a = new Driver(env, A);
      const b = new Driver(env, bside(tool));
      const [ra, rb] = await Promise.all([a.step({ op: "claim" }), b.step({ op: "claim" })]);
      assert.equal([ra, rb].filter((r) => r.ok).length, 1, `${tool.id}: one winner (A=${ra.ok} B=${rb.ok})`);
      const loser = ra.ok ? rb : ra;
      assert.equal(loser.code, "conflict");
      assert.equal(env.db.all("SELECT 1 FROM project_leases WHERE project_id = ? AND state = 'active'", env.p.project_id).length, 1);
      assert.equal(env.db.all("SELECT 1 FROM runs WHERE project_id = ? AND status = 'running'", env.p.project_id).length, 1);
      assert.equal(lease_row(env)!.fence, 1, "the loser did not move the fence");
    });
  }
});

// ---------------------------------------------------------------------------------------------------------
// 2. loss and duplication across many switches

test("six turns A,B,A,B,A,B: the fence rises by one each turn, every lease is new, versions form one gapless chain with the right run", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const opened = await ready_cross(env);
    const order: Side[] = [A, bside(DIRECT[0]!), A, bside(DIRECT[2]!), A, bside(DIRECT[4]!)];
    const guards: Array<{ who: Driver; guard: Guard }> = [];
    let expected_fence = 0;
    for (const [i, side] of order.entries()) {
      const driver = new Driver(env, side);
      assert.equal((await driver.step({ op: "claim" })).ok, true, `turn ${i}`);
      expected_fence += 1;
      assert.equal(driver.guard!.fence, expected_fence, `turn ${i}: fence`);
      assert.equal(lease_row(env)!.fence, expected_fence);
      assert.equal((await driver.step({ op: "submit", title: `턴 ${i}` })).versions_added, 1);
      guards.push({ who: driver, guard: driver.guard! });
      assert.equal((await driver.step({ op: "release" })).ok, true);
    }
    const leases = new Set(guards.map((g) => g.guard.lease_id));
    assert.equal(leases.size, order.length, "no lease id is ever reused");
    const versions = versions_of(env, opened.object_id);
    assert.deepEqual(versions.map((v) => v.version_no), [1, 2, 3, 4, 5, 6, 7], "one version per turn, none lost, none doubled");
    assert.deepEqual(versions.slice(1).map((v) => v.run_id), guards.map((g) => g.guard.run_id), "each version belongs to the run that wrote it");
    assert.equal(
      Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM events WHERE project_id = ? AND type = 'result.submitted'", env.p.project_id)!.n),
      order.length,
    );
    // every guard of every turn is dead now, on both paths
    for (const { who, guard } of guards) await assert_old_guard_refused(env, who, guard, `turn guard fence ${guard.fence}`);
    assert.deepEqual(versions_of(env, opened.object_id).map((v) => v.version_no), [1, 2, 3, 4, 5, 6, 7], "the refusals added nothing");
  });
});

test("해석 11 — a lost answer: the same key retried after the lease moved to the other side is the first answer replayed, not a second write", async () => {
  for (const [first, second] of [
    [bside(DIRECT[0]!), A],
    [A, bside(DIRECT[0]!)],
  ] as Array<[Side, Side]>) {
    await with_cross_env("openai_compatible", async (env) => {
      const opened = await ready_cross(env);
      const one = new Driver(env, first);
      const two = new Driver(env, second);
      await one.step({ op: "claim" });
      const original = await one.step({ op: "submit", key: "lost-answer-key", title: "한 번만" });
      assert.equal(original.ok, true);
      const old = one.guard!;
      await one.step({ op: "release" });
      await two.step({ op: "claim" });
      const before = versions_of(env, opened.object_id).length;
      const retry = await one.step({ op: "submit", key: "lost-answer-key", title: "한 번만", guard_value: old });
      assert.equal(retry.ok, true, `${one.label}: the retry of the same key is answered (replayed), not refused (got ${retry.code})`);
      assert.deepEqual(retry.events, [], "a replay writes no new event");
      assert.deepEqual(retry.receipts, [], "a replay writes no new receipt");
      assert.equal(versions_of(env, opened.object_id).length, before, "no second version");
      // a retry with a DIFFERENT body under the same key is not a replay
      const clash = await one.step({ op: "submit", key: "lost-answer-key", title: "다른 내용", guard_value: old });
      assert.equal(clash.ok, false);
      assert.equal(versions_of(env, opened.object_id).length, before);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------
// a holder that vanishes (process exit): the lease runs out, the other side takes over

test("a vanished holder: after the lease TTL the other side claims, the displaced run is interrupted with its own event, the old guard is refused", async () => {
  for (const [gone, next] of [
    [bside(DIRECT[0]!), A],
    [A, bside(DIRECT[1]!)],
  ] as Array<[Side, Side]>) {
    await with_cross_env("openai_compatible", async (env) => {
      const opened = await ready_cross(env);
      const one = new Driver(env, gone);
      const two = new Driver(env, next);
      await one.step({ op: "claim" });
      await one.step({ op: "submit", title: "사라지기 전" });
      const old = one.guard!;
      // before the TTL passes the lease is still the holder's
      env.clock.advance(60_000);
      assert.equal((await two.step({ op: "claim" })).ok, false, "a live lease is not taken");
      env.clock.advance(61_000);
      const took = await two.step({ op: "claim" });
      assert.equal(took.ok, true, `${two.label} takes over an expired lease`);
      assert.equal(two.guard!.fence, old.fence + 1);
      assert.equal(run_info(env, old.run_id).status, "interrupted", "the displaced run is ended, not left running");
      assert.ok(took.events.includes("run.interrupted"), "with its own event");
      const interrupted = env.db.get<{ payload: string }>("SELECT payload FROM events WHERE run_id = ? AND type = 'run.interrupted'", old.run_id);
      assert.match(interrupted!.payload, /lease_expired/);
      assert.deepEqual(versions_of(env, opened.object_id).map((v) => v.version_no), [1, 2], "what the vanished holder saved is kept");
      await assert_old_guard_refused(env, one, old, "the vanished holder's guard");
    });
  }
});

// ---------------------------------------------------------------------------------------------------------
// 3 (real executor): B → A through the built-in runner itself, with the fake AI server

test("B → A through the real built-in runner: A's model is shown B's version, A writes on top, B's old guard is refused", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const opened = await ready_cross(env);
    const b = new Driver(env, bside(DIRECT[0]!));
    await b.step({ op: "claim" });
    await b.step({ op: "submit", title: "B 의 합성 초안" });
    const b_guard = b.guard!;
    await b.step({ op: "release" });

    set_script(env, [context_turn(), submit_turn(opened.object_id, "A 가 이어 쓴 장"), FINISH]);
    const res = await start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id });
    assert.equal(res.status, "succeeded");
    // 해석 13: a submitted version is not current until a person adopts it, so A's context.get does not list it; what
    // must hold is that nothing was lost - B's version is still in the chain below, under B's run
    const context_reply = request_text(env.fake.bodies()[1]!);
    assert.match(context_reply, new RegExp(opened.object_id), "A's model was shown the stage's objects");
    const a_run = run_info(env, res.run_id);
    assert.equal(a_run.mode, "A");
    const lease = lease_row(env)!;
    assert.equal(lease.fence, b_guard.fence + 1, "A's run took the next fence");
    assert.equal(lease.state, "released", "and gave the lease back at the end");
    assert.deepEqual(versions_of(env, opened.object_id).map((v) => v.version_no), [1, 2, 3]);
    await assert_old_guard_refused(env, b, b_guard, "B's old guard after A's run");
  });
});

test("A → B after a real built-in run: B claims a new run with the next fence and the A run's work is still the current chain", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const opened = await ready_cross(env);
    set_script(env, [context_turn(), submit_turn(opened.object_id, "A 의 합성 초안"), FINISH]);
    const res = await start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id });
    assert.equal(res.status, "succeeded");
    const fence_after_a = lease_row(env)!.fence;
    const dispatches_after_a = Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM outbound_dispatches")!.n);
    assert.ok(dispatches_after_a >= 3, "the A run sent its own model calls");

    const b = new Driver(env, bside(DIRECT[3]!));
    assert.equal((await b.step({ op: "claim" })).ok, true);
    assert.equal(b.guard!.fence, fence_after_a + 1);
    const ctx = await (await env.mcp_client(DIRECT[3]!)).ok("pes_context", {});
    // 해석 13: A's submission is a proposal until a person adopts it, so B's context still names the adopted version
    assert.equal(ctx.manifest.find((m: any) => m.object_id === opened.object_id).version_no, 1);
    assert.deepEqual(versions_of(env, opened.object_id).map((v) => v.version_no), [1, 2], "A's version is stored and waits for a person");
    assert.equal((await b.step({ op: "submit", title: "B 가 이어 쓴 장" })).versions_added, 1);
    assert.equal(
      Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM outbound_dispatches")!.n),
      dispatches_after_a,
      "B's work added no dispatch: PES sent nothing outward for it",
    );
  });
});

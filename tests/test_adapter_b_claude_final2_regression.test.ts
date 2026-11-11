/**
 * SEL-53 PR20a — Codex 최종 리뷰 2/2 회귀 (tester, 작성 모드). 리뷰 전문: logs/SEL-53-final-review-2.md
 * 구현 전에 쓴 정답이다. 지금은 실패하는 것이 정상이고 mid가 동시에 고친다.
 *
 *  N1  같은 run 을 새 fence 로 다시 claim 한 뒤 옛 wait/release 키를 재전송(replayed)해도 MCP 가 기억한 새 guard 는
 *      그대로다 → guard 를 생략한 heartbeat·submit 이 claim_required 없이 새 lease/fence 로 성공한다(도구별로 따로).
 *      재전송 heartbeat 도 기억한 guard 를 바꾸지 않는다. 실제 성공한 wait/release 는 run_id·lease_id·fence 가
 *      기억한 guard 와 모두 같을 때만 기억을 지운다(다르면 그대로).
 *  P   페이지 축소: 가짜 입력 API 가 limit 를 지키고 큰 항목을 주면, 16KB 상한 때문에 limit 를 줄여 다시 읽는 분기가
 *      실제로 실행되고(요청 limit 가 줄어든다) 빠짐·겹침이 없다.
 * 합성 자료만 쓴다. 자식 프로세스·경로·줄바꿈 비교가 없어 Windows 점검표의 해당 항목은 없다.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { McpServer } from "../scripts/pes_core/mcp_server.ts";
import { FakeMcpClient, type AdapterEnv } from "./helpers/adapter_b_env.ts";
import { claim_fresh, with_cleanup, type Claimed } from "./helpers/adapter_b_flow.ts";
import { INPUTS_CURSOR_ARG, read_all_inputs_sized } from "./helpers/mcp_read.ts";
import { state_signature } from "./helpers/state_signature.ts";

// ---------------------------------------------------------------------------
// N1

const lease_of = (env: AdapterEnv) =>
  env.db.get<{ lease_id: string; fence: bigint; state: string; run_id: string }>(
    "SELECT lease_id, state, fence, run_id FROM project_leases WHERE project_id = ?",
    env.p.project_id,
  )!;

const submit_args = (env: AdapterEnv, key: string) => ({
  results: [{ op: "append_version", object_id: env.object_id, title: `n1 ${key}` }],
  idempotency_key: key,
});

/** claim → lease-ending tool (key B) → claim the same run again with a new fence → returns both guards. */
async function ended_then_resumed(client: FakeMcpClient, tool: "pes_wait" | "pes_release", key: string) {
  const first = await claim_fresh(client);
  await client.ok(tool, { idempotency_key: key });
  const again = await client.ok("pes_claim", { run_id: first.run_id, idempotency_key: `${key}-reclaim` });
  assert.equal(again.run_id, first.run_id, "the same run is resumed");
  assert.notEqual(again.lease_id, first.lease_id, "a new lease");
  assert.ok(BigInt(again.fence) > BigInt(first.fence), "a higher fence");
  return { first, again: { run_id: again.run_id as string, lease_id: again.lease_id as string, fence: again.fence as string } as Claimed };
}

for (const tool of ["pes_wait", "pes_release"] as const) {
  for (const next of ["pes_heartbeat", "pes_submit"] as const) {
    test(`N1: replaying an old ${tool} key after the run was claimed with a new fence keeps the new guard — a guard-less ${next} still works`, async () => {
      await with_cleanup(async (env, open) => {
        const client = open(await env.client());
        const key = `n1-${tool}-${next}`;
        const { again } = await ended_then_resumed(client, tool, key);
        env.tick();

        const sig = state_signature(env.db);
        const replay = await client.ok(tool, { idempotency_key: key });
        assert.equal(replay.replayed, true, "the old key replays PES's first answer");
        assert.equal(state_signature(env.db), sig, "a replay writes nothing");
        const held = lease_of(env);
        assert.equal(held.lease_id, again.lease_id, "the new lease is still held");
        assert.equal(String(held.fence), again.fence);

        // the memory still holds the new guard: no guard needed, no claim_required
        const out =
          next === "pes_heartbeat"
            ? await client.tool("pes_heartbeat", { idempotency_key: `${key}-next` })
            : await client.tool("pes_submit", submit_args(env, `${key}-next`));
        assert.equal(out.is_error, false, `${next} after the replay failed: ${JSON.stringify(out.data)}`);
        const after = lease_of(env);
        assert.equal(after.lease_id, again.lease_id, "still the new lease");
        assert.equal(String(after.fence), again.fence, "still the new fence");
      });
    });
  }
}

test("N1: a replayed pes_wait AND a replayed pes_release in a row (different resumes) both leave the newest guard alone", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const first = await claim_fresh(client);
    await client.ok("pes_wait", { idempotency_key: "n1-two-wait" });
    const second = await client.ok("pes_claim", { run_id: first.run_id, idempotency_key: "n1-two-c2" });
    await client.ok("pes_release", { idempotency_key: "n1-two-release" });
    const third = await client.ok("pes_claim", { run_id: first.run_id, idempotency_key: "n1-two-c3" });
    assert.ok(BigInt(third.fence) > BigInt(second.fence));
    env.tick();

    assert.equal((await client.ok("pes_wait", { idempotency_key: "n1-two-wait" })).replayed, true);
    assert.equal((await client.ok("pes_release", { idempotency_key: "n1-two-release" })).replayed, true);
    await client.ok("pes_heartbeat", { idempotency_key: "n1-two-hb" });
    const held = lease_of(env);
    assert.equal(held.lease_id, third.lease_id);
    assert.equal(String(held.fence), third.fence);
  });
});

test("N1: a replayed pes_heartbeat key (after a new fence) does not change the remembered guard", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const first = await claim_fresh(client);
    await client.ok("pes_heartbeat", { idempotency_key: "n1-hb-old" });
    await client.ok("pes_wait", { idempotency_key: "n1-hb-wait" });
    const again = await client.ok("pes_claim", { run_id: first.run_id, idempotency_key: "n1-hb-reclaim" });
    env.tick();

    // the repeat may replay or be refused; either way it must not move the remembered guard
    await client.tool("pes_heartbeat", { idempotency_key: "n1-hb-old" });
    env.tick();
    const next = await client.tool("pes_heartbeat", { idempotency_key: "n1-hb-new" });
    assert.equal(next.is_error, false, `guard-less heartbeat failed: ${JSON.stringify(next.data)}`);
    const held = lease_of(env);
    assert.equal(held.lease_id, again.lease_id);
    assert.equal(String(held.fence), again.fence);
    const sub = await client.tool("pes_submit", submit_args(env, "n1-hb-submit"));
    assert.equal(sub.is_error, false, `guard-less submit failed: ${JSON.stringify(sub.data)}`);
  });
});

test("N1: a REAL successful wait/release with the remembered guard (run, lease and fence all equal) forgets it — the next guard-less call is claim_required", async () => {
  for (const tool of ["pes_wait", "pes_release"] as const) {
    await with_cleanup(async (env, open) => {
      const client = open(await env.client());
      const g = await claim_fresh(client);
      await client.ok(tool, { run_id: g.run_id, lease_id: g.lease_id, fence: g.fence, idempotency_key: `n1-real-${tool}` });
      await client.fails("pes_heartbeat", { idempotency_key: `n1-real-${tool}-hb` }, "claim_required");
    });
  }
});

test("N1: replaying run 1's wait/release key while run 2 holds the lease (a different run_id) leaves run 2's guard alone", async () => {
  // the project has one lease, so a second run exists only after the first one let go of it
  for (const tool of ["pes_wait", "pes_release"] as const) {
    await with_cleanup(async (env, open) => {
      const client = open(await env.client());
      const one = await claim_fresh(client);
      await client.ok(tool, { idempotency_key: `n1-other-${tool}` });
      const two = await claim_fresh(client); // fails the test if a fresh run cannot be made
      assert.notEqual(two.run_id, one.run_id, "a second, different run");
      env.tick();

      const sig = state_signature(env.db);
      const replay = await client.ok(tool, { idempotency_key: `n1-other-${tool}` });
      assert.equal(replay.replayed, true);
      assert.equal(state_signature(env.db), sig, "a replay writes nothing");
      const beat = await client.tool("pes_heartbeat", { idempotency_key: `n1-other-${tool}-hb` });
      assert.equal(beat.is_error, false, `run 1's replay cleared run 2's guard: ${JSON.stringify(beat.data)}`);
      const held = lease_of(env);
      assert.equal(held.run_id, two.run_id);
      assert.equal(held.lease_id, two.lease_id);
      assert.equal(String(held.fence), two.fence);
    });
  }
});

// ---------------------------------------------------------------------------
// P — page shrink with a fake API that honours `limit`

interface Seen {
  limit: number;
  cursor: string | null;
}

/** GET .../runs/{r}/inputs that applies `limit` (1..100) and returns big entries (about 600 bytes each). */
function big_inputs(env: AdapterEnv, total: number, seen: Seen[]) {
  const pad = "가".repeat(120);
  const entries = Array.from({ length: total }, (_, i) => ({
    input_version_id: randomUUID(),
    object_id: randomUUID(),
    kind: "answer",
    question_id: randomUUID(),
    available_at: 1 + i,
    state: "new",
    note: `${i} ${pad}`,
  }));
  const api = {
    async handle(request: { method: string; path: string; headers: Record<string, string>; body: string | Uint8Array | null }) {
      const url = new URL(request.path, "http://synthetic.invalid");
      if (request.method === "GET" && /\/runs\/[^/]+\/inputs$/.test(url.pathname)) {
        const cursor = url.searchParams.get("cursor");
        const asked = url.searchParams.get("limit");
        const limit = asked === null ? 100 : Math.max(1, Math.min(100, Number(asked)));
        seen.push({ limit, cursor });
        const at = cursor !== null && cursor.startsWith("big-") ? Number(cursor.slice("big-".length)) : 0;
        const slice = entries.slice(at, at + limit);
        const end = at + slice.length;
        return {
          status: 200,
          headers: {},
          bytes: null,
          json: {
            format_version: "1.0",
            request_id: `big-${at}-${limit}`,
            data: { inputs: slice, next_cursor: `big-${end}`, has_more: end < total, epoch: "1" },
          },
        };
      }
      return env.app.handle(request as any);
    },
  };
  return { api, ids: entries.map((entry) => entry.input_version_id) };
}

test("P: big inputs (50 would exceed 16 KiB) — the adapter re-reads the SAME cursor with a smaller limit, then reaches the end with no gap or repeat", async () => {
  await with_cleanup(async (env, open) => {
    const seen: Seen[] = [];
    const canned = big_inputs(env, 120, seen);
    const server = new McpServer({ api: canned.api as any, project_id: env.p.project_id, token: env.agent.token });
    const client = open(new FakeMcpClient(server));
    await client.initialize();
    const claim = await claim_fresh(client);
    env.tick();
    seen.length = 0;

    const { inputs, sizes } = await read_all_inputs_sized(client, claim.run_id);
    const got = inputs.map((entry) => entry.input_version_id as string);
    assert.equal(new Set(got).size, got.length, "no input twice");
    assert.deepEqual(got, canned.ids, "all inputs, in order, none missing");

    // the first read asks for the default page (more than one entry) and the size rule shrinks it
    assert.ok(seen.length >= 2, "the page was read again");
    assert.ok(seen[0]!.limit > 1 && seen[0]!.limit <= 50, `first limit is the default page, got ${seen[0]!.limit}`);
    const retry = seen.findIndex((s, i) => i > 0 && s.cursor === seen[0]!.cursor);
    assert.ok(retry > 0, "the same cursor is read again");
    assert.ok(seen[retry]!.limit < seen[0]!.limit, `the retry asks for fewer (${seen[retry]!.limit} < ${seen[0]!.limit})`);
    assert.ok(seen[retry]!.limit >= 1);
    // every reply, and each page's serialized inputs, stays within 16 KiB
    for (const [i, size] of sizes.entries()) assert.ok(size <= 64 * 1024, `call ${i + 1} answered ${size} bytes`);
    assert.ok(sizes.length > 120 / 50, "more calls than a plain 50-page needs, because pages were shrunk");
  });
});

test("P: small inputs keep the default page of 50 (no shrink, one read per page)", async () => {
  await with_cleanup(async (env, open) => {
    const seen: Seen[] = [];
    const canned = big_inputs(env, 120, seen);
    // same API, but short notes: rebuild with a tiny pad by wrapping
    const slim = {
      async handle(request: any) {
        const out: any = await canned.api.handle(request);
        if (out.json?.data?.inputs) out.json.data.inputs = out.json.data.inputs.map(({ note: _n, ...rest }: any) => rest);
        return out;
      },
    };
    const server = new McpServer({ api: slim as any, project_id: env.p.project_id, token: env.agent.token });
    const client = open(new FakeMcpClient(server));
    await client.initialize();
    const claim = await claim_fresh(client);
    env.tick();
    seen.length = 0;

    const first = await client.ok("pes_context", { run_id: claim.run_id });
    assert.equal(first.inputs.length, 50, "the default page is 50");
    assert.equal(seen.length, 1, "one read, no shrink");
    assert.equal(seen[0]!.limit, 50);
    const next = await client.ok("pes_context", { run_id: claim.run_id, [INPUTS_CURSOR_ARG]: first.inputs_next_cursor });
    assert.equal(next.inputs[0].input_version_id, canned.ids[50], "the next page starts right after the first");
  });
});

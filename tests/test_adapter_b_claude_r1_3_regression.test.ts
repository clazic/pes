/**
 * SEL-53 PR20a — 1차 리뷰 r1-3 회귀 (tester, 작성 모드). 리뷰 전문: logs/SEL-53-r1-3.md
 * 구현 전에 쓴 정답이다. 지금은 실패하는 것이 정상이고 mid가 동시에 고친다.
 *
 *  R1  입력이 600개 쌓여도 pes_context 한 호출의 응답(text 블록 + structuredContent 합)이 상한
 *      (tests/helpers/mcp_read.ts 의 MAX_CONTEXT_RESPONSE_BYTES, 64KB)을 넘지 않고, 커서로 끝까지 빠짐·중복 없이 읽힌다.
 *      입력 한 개는 실제처럼 UUID 3개(약 200바이트)다.
 *  B   expected_heads 를 HTTP API(POST /runs {import})로 직접 보낸다: 맞으면 성공, 머리가 다르면 rev_conflict·쓰기 0,
 *      모양 오류·중복·상한 초과는 명확한 오류·쓰기 0, 생략하면 기존 동작.
 *  C   guard 기억(256개)을 넘겨 밀려난 옛 키의 재전송은 claim_required(되살리지 않음), 최근 키는 재생(replayed).
 * 합성 자료만 쓴다. 자식 프로세스·경로·줄바꿈 비교가 없어 Windows 점검표의 해당 항목은 없다.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { append_version, set_current } from "../scripts/pes_core/content.ts";
import { McpServer } from "../scripts/pes_core/mcp_server.ts";
import { FakeMcpClient, type AdapterEnv } from "./helpers/adapter_b_env.ts";
import { claim_fresh, events_of_type, with_cleanup } from "./helpers/adapter_b_flow.ts";
import { assert_error, assert_ok, call } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { new_artifact } from "./helpers/blob_env.ts";
import { MAX_CONTEXT_RESPONSE_BYTES, read_all_inputs_sized } from "./helpers/mcp_read.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

// ---------------------------------------------------------------------------
// R1

/** GET .../runs/{r}/inputs 가 total 개를 100개씩, API 커서 모양으로 주는 ApiLike. 입력 하나는 UUID 3개로 실제 크기다. */
function realistic_inputs(env: AdapterEnv, total: number) {
  const entries = Array.from({ length: total }, (_, i) => ({
    input_version_id: randomUUID(),
    object_id: randomUUID(),
    kind: "answer",
    question_id: randomUUID(),
    available_at: 1 + i,
    state: "new",
  }));
  const api = {
    async handle(request: { method: string; path: string; headers: Record<string, string>; body: string | Uint8Array | null }) {
      const url = new URL(request.path, "http://synthetic.invalid");
      if (request.method === "GET" && /\/runs\/[^/]+\/inputs$/.test(url.pathname)) {
        const cursor = url.searchParams.get("cursor");
        const at = cursor !== null && cursor.startsWith("canned-") ? Number(cursor.slice("canned-".length)) : 0;
        const slice = entries.slice(at, at + 100);
        const end = at + slice.length;
        return {
          status: 200,
          headers: {},
          bytes: null,
          json: {
            format_version: "1.0",
            request_id: `canned-${at}`,
            data: { inputs: slice, next_cursor: `canned-${end}`, has_more: end < total, epoch: "1" },
          },
        };
      }
      return env.app.handle(request as any);
    },
  };
  return { api, ids: entries.map((entry) => entry.input_version_id) };
}

for (const total of [150, 300, 600]) {
  test(`R1: ${total} realistic inputs — every pes_context call stays within ${MAX_CONTEXT_RESPONSE_BYTES} bytes and the cursor reaches the end with no gap or repeat`, async () => {
    await with_cleanup(async (env, open) => {
      const canned = realistic_inputs(env, total);
      const server = new McpServer({
        api: canned.api as any,
        project_id: env.p.project_id,
        token: env.agent.token,
        claim_defaults: { runtime: "claude_code", provider: "anthropic", model: "synthetic-model" },
      });
      const client = open(new FakeMcpClient(server));
      await client.initialize();
      const claim = await claim_fresh(client);
      env.tick();

      const { inputs, sizes } = await read_all_inputs_sized(client, claim.run_id);
      const got = inputs.map((entry) => entry.input_version_id as string);
      assert.equal(new Set(got).size, got.length, "no input twice");
      assert.deepEqual(got, canned.ids, "all inputs, in order");
      for (const [i, size] of sizes.entries()) {
        assert.ok(size <= MAX_CONTEXT_RESPONSE_BYTES, `call ${i + 1} answered ${size} bytes (limit ${MAX_CONTEXT_RESPONSE_BYTES})`);
      }
      if (total >= 300) assert.ok(sizes.length >= 2, "more than one call was needed, so the cursor was really used");
    });
  });
}

test("R1: the first call of a project that already holds 600 inputs is itself within the limit and carries the cursor", async () => {
  await with_cleanup(async (env, open) => {
    const canned = realistic_inputs(env, 600);
    const server = new McpServer({ api: canned.api as any, project_id: env.p.project_id, token: env.agent.token });
    const client = open(new FakeMcpClient(server));
    await client.initialize();
    const claim = await claim_fresh(client);
    const first = await client.tool("pes_context", { run_id: claim.run_id });
    assert.equal(first.is_error, false);
    const bytes = Buffer.byteLength(first.raw.content.map((b: { text: string }) => b.text).join(""), "utf8") + Buffer.byteLength(JSON.stringify(first.raw.structuredContent), "utf8");
    assert.ok(bytes <= MAX_CONTEXT_RESPONSE_BYTES, `first call answered ${bytes} bytes`);
    assert.equal(first.data.inputs_has_more, true);
    assert.equal(typeof first.data.inputs_next_cursor, "string");
    assert.ok(first.data.inputs.length < 600, "not everything in one call");
  });
});

// ---------------------------------------------------------------------------
// B — expected_heads straight over the HTTP API

let import_seq = 0;
const import_request = (env: AdapterEnv, extra: Record<string, unknown>, title = "직접 보낸 가져오기") => {
  import_seq += 1;
  const request_id = `r13-import-${import_seq}`;
  return {
    key: `import-${request_id}`,
    body: { import: { request_id, results: [{ op: "append_version", object_id: env.object_id, title }], ...extra } },
  };
};
const post_import = (env: AdapterEnv, extra: Record<string, unknown>, title?: string) => {
  const { key, body } = import_request(env, extra, title);
  return call(env, { method: "POST", path: P(env, "/runs"), auth: "owner", key, body });
};
const handoff_runs = (env: AdapterEnv): bigint =>
  env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM runs WHERE runtime = 'claude_app_handoff'")!.n;
const head_of = (env: AdapterEnv, object_id: string): string =>
  env.db.get<{ current_version_id: string }>("SELECT current_version_id FROM objects WHERE id = ?", object_id)!.current_version_id;

async function move_head(env: AdapterEnv, object_id: string, key: string): Promise<string> {
  const next = (await append_version(env.service, env.ctx(`${key}-v`), { object_id, title: `경합 ${key}` })).result as { version_id: string };
  await set_current(env.service, env.ctx(`${key}-c`), { object_id, version_id: next.version_id });
  return next.version_id;
}

test("B: expected_heads that match the current head import; leaving it out keeps the old behaviour", async () => {
  await with_cleanup(async (env) => {
    const ok = await post_import(env, { expected_heads: [{ object_id: env.object_id, version_id: head_of(env, env.object_id) }] });
    const data = assert_ok(ok, 201);
    assert.equal(typeof data.run_id, "string");
    assert.equal(handoff_runs(env), 1n);

    const without = await post_import(env, {}, "expected_heads 없음");
    assert_ok(without, 201);
    assert.equal(handoff_runs(env), 2n);
    const empty = await post_import(env, { expected_heads: [] }, "빈 expected_heads");
    assert_ok(empty, 201);
    assert.equal(handoff_runs(env), 3n);
  });
});

test("B: a head that is not the current one → rev_conflict naming the object, nothing written, and the same request is not used up", async () => {
  await with_cleanup(async (env) => {
    const stale = head_of(env, env.object_id);
    await move_head(env, env.object_id, "b-move");
    const sig = state_signature(env.db);
    const counts = table_counts(env.db);
    const { key, body } = import_request(env, { expected_heads: [{ object_id: env.object_id, version_id: stale }] });
    const res = await call(env, { method: "POST", path: P(env, "/runs"), auth: "owner", key, body });
    const error = assert_error(res, 409, "rev_conflict");
    assert.equal(error.details?.object_id, env.object_id);
    assert.equal(state_signature(env.db), sig, "a refused import writes nothing");
    assert.deepEqual(table_counts(env.db), counts);
    assert.equal(handoff_runs(env), 0n);
    assert.equal(events_of_type(env, "result.submitted").length, 0);

    // same request id with the head now correct goes through (the refusal left no receipt behind)
    (body.import as any).expected_heads = [{ object_id: env.object_id, version_id: head_of(env, env.object_id) }];
    const again = await call(env, { method: "POST", path: P(env, "/runs"), auth: "owner", key, body });
    assert_ok(again, 201);
    assert.equal(handoff_runs(env), 1n);
  });
});

test("B: a wrong head on an object the result does not touch also stops the import", async () => {
  await with_cleanup(async (env) => {
    const unrelated = await new_artifact(env, "r13-unrelated");
    const stale = head_of(env, unrelated.object_id);
    await move_head(env, unrelated.object_id, "b-unrelated");
    const sig = state_signature(env.db);
    const res = await post_import(env, {
      expected_heads: [
        { object_id: env.object_id, version_id: head_of(env, env.object_id) },
        { object_id: unrelated.object_id, version_id: stale },
      ],
    });
    const error = assert_error(res, 409, "rev_conflict");
    assert.equal(error.details?.object_id, unrelated.object_id);
    assert.equal(state_signature(env.db), sig);
    assert.equal(handoff_runs(env), 0n);
  });
});

test("B: an unknown object id as a head → rev_conflict, nothing written", async () => {
  await with_cleanup(async (env) => {
    const sig = state_signature(env.db);
    const res = await post_import(env, { expected_heads: [{ object_id: "no-such-object", version_id: "no-such-version" }] });
    const error = assert_error(res, 409, "rev_conflict");
    assert.equal(error.details?.object_id, "no-such-object");
    assert.equal(state_signature(env.db), sig);
  });
});

test("B: malformed expected_heads → invalid_payload, nothing written", async () => {
  await with_cleanup(async (env) => {
    const head = { object_id: env.object_id, version_id: head_of(env, env.object_id) };
    const cases: Array<[string, unknown]> = [
      ["not an array", "oops"],
      ["an object instead of an array", { object_id: env.object_id }],
      ["a number entry", [1]],
      ["an entry without version_id", [{ object_id: env.object_id }]],
      ["an empty object_id", [{ object_id: "", version_id: head.version_id }]],
      ["an empty version_id", [{ object_id: env.object_id, version_id: "" }]],
      ["a non-string version_id", [{ object_id: env.object_id, version_id: 7 }]],
      ["an extra field", [{ ...head, extra: true }]],
      ["the same object twice", [head, head]],
    ];
    const sig = state_signature(env.db);
    for (const [label, expected_heads] of cases) {
      const res = await post_import(env, { expected_heads });
      assert_error(res, 400, "invalid_payload");
      assert.equal(state_signature(env.db), sig, `${label}: nothing written`);
    }
    assert.equal(handoff_runs(env), 0n);
  });
});

test("B: far more expected_heads than any bundle can carry → a clear 4xx error (invalid_payload or payload_too_large), never a 5xx, nothing written", async () => {
  await with_cleanup(async (env) => {
    const sig = state_signature(env.db);
    for (const total of [3000, 10001, 20000]) {
      const heads = Array.from({ length: total }, () => ({ object_id: randomUUID(), version_id: randomUUID() }));
      const res = await post_import(env, { expected_heads: heads });
      assert.ok(res.status === 400 || res.status === 413, `${total} heads: status ${res.status}`);
      assert.ok(["invalid_payload", "payload_too_large"].includes(res.json.error.code), `${total} heads: ${res.json.error?.code}`);
      assert.equal(state_signature(env.db), sig, `${total} heads: nothing written`);
    }
    assert.equal(handoff_runs(env), 0n);
  });
});

// ---------------------------------------------------------------------------
// C — the 256 remembered keys

test("C: after more than 256 lease-ending calls the oldest key is forgotten (claim_required, nothing revived), recent keys still replay", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const total = 260;
    for (let i = 0; i < total; i += 1) {
      await client.ok("pes_claim", { idempotency_key: `c13-claim-${i}` });
      await client.ok("pes_complete", { status: "succeeded", idempotency_key: `c13-done-${i}` });
      env.clock.advance(3_000); // stay under the per-minute request budget (60 calls/min)
    }
    const sig = state_signature(env.db);

    const recent = await client.ok("pes_complete", { status: "succeeded", idempotency_key: `c13-done-${total - 1}` });
    assert.equal(recent.replayed, true, "the newest key still replays");
    const edge = await client.ok("pes_complete", { status: "succeeded", idempotency_key: `c13-done-${total - 256}` });
    assert.equal(edge.replayed, true, "the 256th newest key still replays");

    // forgotten keys: no guard to resend, and the lease is not brought back
    for (const forgotten of [0, 1, 3]) {
      await client.fails("pes_complete", { status: "succeeded", idempotency_key: `c13-done-${forgotten}` }, "claim_required");
    }
    assert.equal(state_signature(env.db), sig, "replays and refusals wrote nothing");
    assert.equal(events_of_type(env, "run.completed").length, total);
  });
});

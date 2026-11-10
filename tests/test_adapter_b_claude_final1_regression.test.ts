/**
 * SEL-53 PR20a — Codex 최종 리뷰 1/2 회귀 (tester, 작성 모드). 리뷰 전문: logs/SEL-53-final-review-1.md
 * 구현 전에 쓴 정답이다. 지금은 실패하는 것이 정상이고 senior가 동시에 고친다.
 *
 *  F1  MCP만으로 사람의 답(값·의견)·질문·자료 본문을 읽는다. 도구 이름·인자는 tests/helpers/mcp_read.ts 한 곳(후보 pes_read).
 *      결과는 API의 버전 조회와 같다. 권한 부족·다른 프로젝트·AI 참조 금지는 API와 같은 거부. 읽기는 아무것도 쓰지 않는다.
 *  F2  wait·complete·release·cancel을 같은 멱등 키로 다시 보내면 같은 답(replayed)·쓰기 0 — claim_required가 아니다.
 *      새 키의 lease 작업은 계속 claim_required, 같은 키의 다른 인자는 idempotency_key_reuse.
 *  F3  가져오기와 다른 쓰기가 같은 기반 버전을 두고 경합하면 하나만 성공한다. 경합은 어댑터의 마지막 GET이 끝난 뒤
 *      POST 직전에 훅이 자료 머리를 옮겨 강제한다. 거부는 bundle_stale(또는 rev_conflict), 쓰기 0, 새로 복사하면 가져온다.
 *  F4  입력이 500개를 넘어도 MCP 커서로 끝까지 읽어 빠짐·중복이 없다.
 * 합성 자료만 쓰고 실제 Claude·앱·MCP 설정은 읽지 않는다. 자식 프로세스·경로 비교가 없어 Windows 점검표의 해당 항목은 없다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { append_version, set_current } from "../scripts/pes_core/content.ts";
import { McpServer } from "../scripts/pes_core/mcp_server.ts";
import { ask_args, FakeMcpClient, wire, type AdapterEnv } from "./helpers/adapter_b_env.ts";
import { adapter, export_for, paste, refused, register_second } from "./helpers/adapter_b_harden.ts";
import { claim_fresh, events_of_type, with_cleanup } from "./helpers/adapter_b_flow.ts";
import { assert_ok, call, make_agent } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { attach, bytes_of, new_artifact, put_ready } from "./helpers/blob_env.ts";
import { read_all_inputs, read_version, read_version_raw } from "./helpers/mcp_read.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

const VPATH = (env: AdapterEnv, object_id: string, version_id: string) => P(env, `/objects/${object_id}/versions/${version_id}`);
const without_replayed = (value: any) => {
  const { replayed: _r, ...rest } = value;
  return rest;
};

async function human_answer(env: AdapterEnv, asked: any, value: string, comment?: string): Promise<string> {
  const res = await call(env, {
    method: "POST",
    path: P(env, "/submissions"),
    auth: "owner",
    body: {
      set_id: asked.question_set_id,
      answers: [{ question_id: asked.question.id, question_version_id: asked.question.version_id, value, ...(comment === undefined ? {} : { comment }) }],
    },
  });
  return assert_ok(res, 201).answers[0].answer_version_id as string;
}

// ---------------------------------------------------------------------------
// F1

test("F1: the agent reads the human's answer (value and comment) through MCP and submits a result that depends on it", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const claim = await claim_fresh(client);
    const asked = await client.ok("pes_ask", ask_args(env, "f1"));
    await client.ok("pes_wait", { idempotency_key: "f1-wait" });
    const answer_version = await human_answer(env, asked, "b", "의견: 둘째 안으로 가되 근거를 보강");
    env.tick();
    const ctx = await client.ok("pes_context", { run_id: claim.run_id });
    const input = (ctx.inputs as any[]).find((entry) => entry.input_version_id === answer_version);
    assert.ok(input, "the answer is listed");
    assert.equal(typeof input.object_id, "string");

    const sig = state_signature(env.db);
    const read = await read_version(client, input.object_id, input.input_version_id);
    assert.equal(state_signature(env.db), sig, "a read writes nothing");
    assert.equal(read.version_id, answer_version);
    assert.equal(read.content.value, "b");
    assert.equal(read.content.comment, "의견: 둘째 안으로 가되 근거를 보강");
    // the same data the API gives the same token
    const api = assert_ok(await call(env, { method: "GET", path: VPATH(env, input.object_id, input.input_version_id), auth: { token: env.agent.token } }));
    assert.deepEqual(without_replayed(read), api);
    assert.ok(!wire(read).includes(env.agent.token));

    // the agent acts on what it read
    await client.ok("pes_claim", { run_id: claim.run_id, idempotency_key: "f1-resume" });
    const submitted = await client.ok("pes_submit", {
      results: [{ op: "append_version", object_id: env.object_id, title: `사람 답 ${read.content.value} 반영`, summary: read.content.comment }],
      idempotency_key: "f1-submit",
    });
    assert.equal(typeof submitted.results[0].version_id, "string");
    const stored = env.db.get<{ title: string }>("SELECT title FROM artifact_versions WHERE version_id = ?", submitted.results[0].version_id);
    assert.equal(stored?.title, "사람 답 b 반영");
  });
});

test("F1: work material (an artifact's body) and the question are readable through the same tool, equal to the API", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const claim = await claim_fresh(client);
    const asked = await client.ok("pes_ask", ask_args(env, "f1q", "읽을 질문 본문"));

    const material = await read_version(client, env.object_id, env.version_id);
    assert.equal(material.object_id, env.object_id);
    assert.equal(material.content.title, "합성 장 adapter-artifact");
    const api_material = assert_ok(await call(env, { method: "GET", path: VPATH(env, env.object_id, env.version_id), auth: { token: env.agent.token } }));
    assert.deepEqual(without_replayed(material), api_material);

    const q = await read_version(client, asked.question.object_id ?? asked.question.id, asked.question.version_id);
    assert.equal(q.version_id, asked.question.version_id);
    assert.ok(wire(q.content).includes("읽을 질문 본문"), "the question text is in the version content");
    assert.ok(claim.run_id.length > 0);
  });
});

test("F1: refusals equal the API's — unknown version, a version of another object, another project, a token without context:read", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const second = await register_second(env);
    const other_object = (await new_artifact(env, "f1-other")).object_id;
    const cases: Array<[string, string, string]> = [
      ["unknown version", env.object_id, "no-such-version"],
      ["unknown object", "no-such-object", env.version_id],
      ["version under another object", other_object, env.version_id],
      ["another project's object and version", second.object_id, second.version_id],
    ];
    const narrow = await make_agent(env, "f1-narrow", ["run:claim", "run:submit"]);
    const sig = state_signature(env.db);
    for (const [label, object_id, version_id] of cases) {
      const api = await call(env, { method: "GET", path: VPATH(env, object_id, version_id), auth: { token: env.agent.token } });
      assert.ok(api.status >= 400, label);
      const out = await read_version_raw(client, object_id, version_id);
      assert.equal(out.is_error, true, label);
      assert.equal(out.data.error.code, api.json.error.code, label);
      assert.ok(!wire(out.data).includes(second.version_id) || label !== "another project's object and version", `${label}: no foreign body`);
    }

    const weak = open(await env.client(narrow.token));
    const api_denied = await call(env, { method: "GET", path: VPATH(env, env.object_id, env.version_id), auth: { token: narrow.token } });
    assert.equal(api_denied.status, 403);
    const denied = await read_version_raw(weak, env.object_id, env.version_id);
    assert.equal(denied.is_error, true);
    assert.equal(denied.data.error.code, api_denied.json.error.code);
    assert.equal(state_signature(env.db), sig, "refused reads write nothing");
  });
});

test("F1: a file the owner marked 'AI may not reference' is neither listed nor named in the MCP read, but its text is", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const v = await new_artifact(env, "f1-deny");
    const allowed = await put_ready(env, bytes_of("f1-allowed", 24), "f1-allowed");
    const denied = await put_ready(env, bytes_of("f1-denied", 24), "f1-denied");
    await attach(env, v.version_id, allowed.blob_id, "attachment", "f1-att-1");
    await attach(env, v.version_id, denied.blob_id, "source", "f1-att-2");
    const policy = env.db.get<{ id: string; rev: bigint; changed_by_actor_id: string; changed_by_user_id: string; tx_id: string }>(
      "SELECT id, rev, changed_by_actor_id, changed_by_user_id, tx_id FROM file_policies WHERE project_id = ? AND blob_id = ?",
      env.p.project_id,
      denied.blob_id,
    )!;
    env.db.run("UPDATE file_policies SET ai_access = 'deny', rev = ? WHERE id = ?", policy.rev + 1n, policy.id);
    env.db.run(
      `INSERT INTO file_ai_access_versions
         (id, project_id, file_policy_id, ai_access, changed_by_actor_id, changed_by_user_id, changed_at, reason, rev, tx_id)
       VALUES (?, ?, ?, 'deny', ?, ?, 0, NULL, ?, ?)`,
      `deny-${denied.blob_id}`,
      env.p.project_id,
      policy.id,
      policy.changed_by_actor_id,
      policy.changed_by_user_id,
      policy.rev + 1n,
      policy.tx_id,
    );

    const read = await read_version(client, v.object_id, v.version_id);
    assert.deepEqual(read.files.map((f: { blob_id: string }) => f.blob_id), [allowed.blob_id]);
    assert.ok(!wire(read).includes(denied.blob_id), "the denied blob id appears nowhere");
    assert.equal(read.content.title, "합성 장 f1-deny", "the version's own text is still readable");
    const owner = assert_ok(await call(env, { method: "GET", path: VPATH(env, v.object_id, v.version_id), auth: "owner" }));
    assert.equal(owner.files.length, 2, "the human owner still sees both");
  });
});

// ---------------------------------------------------------------------------
// F2

type Replayable = { tool: string; first: Record<string, unknown>; changed: Record<string, unknown> | null };
const REPLAYABLE: Replayable[] = [
  { tool: "pes_wait", first: { reason: "사람 답을 기다림" }, changed: { reason: "다른 이유" } },
  { tool: "pes_complete", first: { status: "succeeded" }, changed: { status: "failed" } },
  { tool: "pes_release", first: {}, changed: null },
  { tool: "pes_cancel", first: { confirm: true, reason: "합성 취소" }, changed: { confirm: true, reason: "다른 취소 이유" } },
];

for (const { tool, first, changed } of REPLAYABLE) {
  test(`F2: ${tool} sent again with the same key and arguments replays the first answer, writes nothing, and stays replayable`, async () => {
    await with_cleanup(async (env, open) => {
      const client = open(await env.client());
      await claim_fresh(client);
      const args = { ...first, idempotency_key: "repro-final" };
      const one = await client.ok(tool, args);
      assert.notEqual(one.replayed, true);
      const sig = state_signature(env.db);
      const counts = table_counts(env.db);

      const two = await client.ok(tool, args);
      assert.equal(two.replayed, true, "the lost-answer retry is a replay");
      assert.deepEqual(without_replayed(two), without_replayed(one), "the first answer, unchanged");
      assert.equal(state_signature(env.db), sig, "a replay writes nothing");
      assert.deepEqual(table_counts(env.db), counts);
      const three = await client.ok(tool, args);
      assert.equal(three.replayed, true, "and again");

      if (changed !== null) {
        const reuse = await client.fails(tool, { ...changed, idempotency_key: "repro-final" }, "idempotency_key_reuse");
        assert.equal(reuse.next_action, "use_new_key");
      }
      // a NEW key still needs a claim: the replay did not bring the lease back
      const fresh = tool === "pes_cancel" ? { confirm: true, idempotency_key: "repro-final-new" } : { ...first, idempotency_key: "repro-final-new" };
      await client.fails(tool, fresh, "claim_required");
      await client.fails("pes_submit", { results: [], idempotency_key: "repro-after" }, "claim_required");
      assert.equal(state_signature(env.db), sig, "nothing written by the refusals either");
    });
  });
}

test("F2: a replayed release/complete does not revive the lease for other tools, and an explicit guard replays too", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const claim = await claim_fresh(client);
    const guard = { run_id: claim.run_id, lease_id: claim.lease_id, fence: claim.fence };
    await client.ok("pes_complete", { status: "succeeded", idempotency_key: "g-complete" });
    const sig = state_signature(env.db);
    const explicit = await client.ok("pes_complete", { status: "succeeded", idempotency_key: "g-complete", ...guard });
    assert.equal(explicit.replayed, true);
    await client.ok("pes_complete", { status: "succeeded", idempotency_key: "g-complete" });
    await client.fails("pes_heartbeat", { idempotency_key: "g-hb" }, "claim_required");
    assert.equal(state_signature(env.db), sig);
    assert.equal(events_of_type(env, "run.completed").length, 1);
  });
});

// ---------------------------------------------------------------------------
// F3

/** An ApiLike that runs `before_post_runs` once, after everything the adapter read and just before its POST /runs. */
function racing(env: AdapterEnv, before_post_runs: () => Promise<void>) {
  let fired = false;
  return {
    async handle(request: { method: string; path: string; headers: Record<string, string>; body: string | Uint8Array | null }) {
      if (!fired && request.method === "POST" && request.path.endsWith("/runs")) {
        fired = true;
        await before_post_runs();
      }
      return env.app.handle(request as any);
    },
    get fired() {
      return fired;
    },
  };
}

const handoff_runs = (env: AdapterEnv): bigint =>
  env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM runs WHERE runtime = 'claude_app_handoff'")!.n;

async function move_head(env: AdapterEnv, object_id: string, key: string): Promise<void> {
  const next = (await append_version(env.service, env.ctx(`${key}-v`), { object_id, title: `경합 ${key}` })).result as { version_id: string };
  await set_current(env.service, env.ctx(`${key}-c`), { object_id, version_id: next.version_id });
}

test("F3: the head of a result's object moves between the adapter's checks and its POST — refused, nothing written, a fresh copy imports", async () => {
  await with_cleanup(async (env) => {
    const probe = adapter(env);
    const { text } = await export_for(env, probe);
    let after_move = "";
    const api = racing(env, async () => {
      await move_head(env, env.object_id, "race-1");
      after_move = state_signature(env.db);
    });
    const racer = adapter(env, { api });
    const error = await refused(racer.import_result({ bundle_text: text, result_text: paste(env.object_id, "오래된 기반 결과") }), ["bundle_stale", "rev_conflict", "conflict"]);
    assert.equal(api.fired, true, "the race was really forced");
    assert.equal(state_signature(env.db), after_move, "the import wrote nothing at all");
    assert.equal(handoff_runs(env), 0n);
    assert.equal(events_of_type(env, "result.submitted").length, 0);
    assert.equal(error.next_action, "export_again");

    // the bundle was not used up: a fresh copy of the new state imports exactly once
    const again = adapter(env);
    const fresh = await export_for(env, again);
    const done = await again.import_result({ bundle_text: fresh.text, result_text: paste(env.object_id, "새 기반 결과") });
    assert.equal(done.status, "imported");
    assert.equal(handoff_runs(env), 1n);
  });
});

test("F3: the head of an object the result does not touch (but the bundle carries) moves in the race — also refused, nothing written", async () => {
  await with_cleanup(async (env) => {
    const unrelated = await new_artifact(env, "f3-unrelated");
    const { text } = await export_for(env, adapter(env));
    let after_move = "";
    const api = racing(env, async () => {
      await move_head(env, unrelated.object_id, "race-2");
      after_move = state_signature(env.db);
    });
    await refused(adapter(env, { api }).import_result({ bundle_text: text, result_text: paste(env.object_id, "다른 자료만 건드린 결과") }), ["bundle_stale", "rev_conflict", "conflict"]);
    assert.equal(api.fired, true);
    assert.equal(state_signature(env.db), after_move);
    assert.equal(handoff_runs(env), 0n);
  });
});

test("F3: with no race the same import still works, and a general agent result may still build on an older version (contract unchanged)", async () => {
  await with_cleanup(async (env, open) => {
    const a = adapter(env);
    const { text } = await export_for(env, a);
    const out = await a.import_result({ bundle_text: text, result_text: paste(env.object_id, "경합 없음") });
    assert.equal(out.status, "imported");

    // the import's own run moved the head; an agent proposing from the OLD version is still accepted
    const client = open(await env.client());
    await claim_fresh(client);
    await move_head(env, env.object_id, "race-3");
    const submitted = await client.ok("pes_submit", {
      results: [{ op: "append_version", object_id: env.object_id, title: "옛 기반 제안", based_on_version_id: env.version_id }],
      idempotency_key: "f3-old-base",
    });
    assert.equal(typeof submitted.results[0].version_id, "string");
  });
});

// ---------------------------------------------------------------------------
// F4

/** An ApiLike whose `GET .../runs/{r}/inputs` serves `total` canned answers, 100 a page, with the API's cursor shape. */
function many_inputs(env: AdapterEnv, total: number) {
  const ids = Array.from({ length: total }, (_, i) => `canned-input-${String(i).padStart(5, "0")}`);
  let input_calls = 0;
  const api = {
    async handle(request: { method: string; path: string; headers: Record<string, string>; body: string | Uint8Array | null }) {
      const url = new URL(request.path, "http://synthetic.invalid");
      if (request.method === "GET" && /\/runs\/[^/]+\/inputs$/.test(url.pathname)) {
        input_calls += 1;
        const cursor = url.searchParams.get("cursor");
        const at = cursor !== null && cursor.startsWith("canned-") ? Number(cursor.slice("canned-".length)) : 0;
        const slice = ids.slice(at, at + 100);
        const end = at + slice.length;
        return {
          status: 200,
          headers: {},
          bytes: null,
          json: {
            format_version: "1.0",
            request_id: `canned-${input_calls}`,
            data: {
              inputs: slice.map((id, i) => ({ input_version_id: id, object_id: `canned-object-${at + i}`, kind: "answer", question_id: "canned-q", available_at: 1 + at + i, state: "new" })),
              next_cursor: `canned-${end}`,
              has_more: end < total,
              epoch: "1",
            },
          },
        };
      }
      return env.app.handle(request as any);
    },
  };
  return { api, ids, calls: () => input_calls };
}

for (const total of [99, 100, 500, 501, 650, 1234]) {
  test(`F4: ${total} inputs are read to the end through MCP with no gap and no repeat`, async () => {
    await with_cleanup(async (env, open) => {
      const canned = many_inputs(env, total);
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
      const got = (await read_all_inputs(client, claim.run_id)).map((entry) => entry.input_version_id as string);
      assert.equal(new Set(got).size, got.length, "no input twice");
      assert.deepEqual(got, canned.ids, `all ${total} inputs, in order${got.length < total ? ` (only ${got.length} reachable)` : ""}`);

      // a new connection, even for another view of the same run, reaches the tail too
      const second = open(new FakeMcpClient(new McpServer({ api: canned.api as any, project_id: env.p.project_id, token: env.agent.token })));
      await second.initialize();
      const again = (await read_all_inputs(second, claim.run_id)).map((entry) => entry.input_version_id as string);
      assert.deepEqual(again, canned.ids);
    });
  });
}

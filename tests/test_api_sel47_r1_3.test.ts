/**
 * SEL-47 PR14 — 1차 리뷰 재확인(r1-3) 회귀 시험 (tester, 회귀 모드). 리뷰: logs/SEL-47-r1-3.md
 *
 *   N3 (a) 같은 질문에 사람이 다시 제출해도 이전 제출(submission)의 comment 가 새 답 content 로 끌려오지 않는다.
 *      (b) 다른 run 에 쓴 Idempotency-Key 를 이 run 의 handoffs·interrupt 에 쓰면 409 idempotency_key_reuse
 *          (같은 action 이라도 대상 run 이 다르면 재사용), 아무것도 쓰지 않는다.
 *   N4 docs/api/openapi-v1.yaml 의 inputs 200 응답이 InputItem 을 $ref 하고 object_id 가 필수다.
 *      픽스처(versions.json 의 answer·question 장면, handoffs.json 의 400 장면)와 그것을 돌리는 계약 시험은
 *      tests/test_api_fixture_contract.test.ts 끝의 "extra scenes" 절.
 *   N1 은 tests/test_serve_api_r1_3.py (실서버).
 *
 * 합성 값만 쓴다.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { assert_error, assert_ok, call, make_agent, with_api, type Agent, type ApiEnv, type Lease } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { parse_yaml, resolve_ref, validate } from "./helpers/mini_yaml.ts";
import { open_round, single_spec } from "./helpers/questions_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const MODE_B = { mode: "B", runtime: "synthetic-runtime", provider: "synthetic", model: "synthetic-model" } as const;

async function run_for_b(env: ApiEnv, agent: Agent): Promise<Lease> {
  const created = assert_ok(await call(env, { method: "POST", path: P(env, "/runs"), auth: "owner", body: { actor_id: agent.actor_id, ...MODE_B } }), 201);
  const claimed = assert_ok(await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: agent.token }, body: { run_id: created.run_id } }));
  return { run_id: claimed.run_id, lease_id: claimed.lease_id, fence: claimed.fence };
}

// ---------------------------------------------------------------------------
// N3 (a)

test("N3a the same question answered again by the human: each answer version carries its own comment, never an earlier submission's", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "n3a");
    const lease = await run_for_b(env, agent);
    const { stage_id, round_id } = await open_round(env, "n3a-round");
    const asked = assert_ok(
      await call(env, {
        method: "POST",
        path: P(env, "/questions"),
        auth: { token: agent.token },
        body: { stage_id, round_id, purpose: "review", form_key: "ask", question: single_spec("합성 재제출 질문"), run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence },
      }),
      201,
    );
    const q = { set_id: asked.question_set_id as string, question_id: asked.question.id as string, question_version_id: asked.question.version_id as string };

    const submit = async (value: string, comment?: string): Promise<string> => {
      const answer: Record<string, unknown> = { question_id: q.question_id, question_version_id: q.question_version_id, value };
      if (comment !== undefined) answer.comment = comment;
      const res = await call(env, { method: "POST", path: P(env, "/submissions"), auth: "owner", body: { set_id: q.set_id, answers: [answer] } });
      return assert_ok(res, 201).answers[0].answer_version_id as string;
    };

    const first = await submit("a", "n3a-COMMENT-ONE");
    const second = await submit("b"); // no comment this time
    const third = await submit("a", "n3a-COMMENT-THREE");
    assert.equal(new Set([first, second, third]).size, 3, "three distinct answer versions");

    const inputs = assert_ok(await call(env, { method: "GET", path: P(env, `/runs/${lease.run_id}/inputs`), auth: { token: agent.token } })).inputs as Array<{
      input_version_id: string;
      object_id: string;
    }>;
    const by_version = new Map(inputs.map((i) => [i.input_version_id, i]));
    for (const id of [first, second, third]) assert.ok(by_version.has(id), `inputs names answer version ${id}`);

    const read = async (id: string) => {
      const item = by_version.get(id)!;
      return assert_ok(await call(env, { method: "GET", path: P(env, `/objects/${item.object_id}/versions/${id}`), auth: { token: agent.token } }));
    };
    const one = await read(first);
    const two = await read(second);
    const three = await read(third);

    assert.equal(one.content.comment, "n3a-COMMENT-ONE");
    assert.equal(one.content.value, "a");
    assert.equal(two.content.comment, null, "a submission without a comment does not pull the first one's comment");
    assert.equal(two.content.value, "b");
    assert.equal(three.content.comment, "n3a-COMMENT-THREE");
    assert.equal(three.content.value, "a");
    // nothing leaks sideways
    assert.ok(!JSON.stringify(two).includes("n3a-COMMENT"), "the comment-less answer carries no other comment text");
    assert.ok(!JSON.stringify(one).includes("COMMENT-THREE"));
    assert.ok(!JSON.stringify(three).includes("COMMENT-ONE"));
    // reading again later gives the same content (the earlier versions are not rewritten by the later submissions)
    assert.deepEqual((await read(first)).content, one.content);
    assert.deepEqual((await read(second)).content, two.content);
  });
});

// ---------------------------------------------------------------------------
// N3 (b)

test("N3b a key spent on the same command for ANOTHER run is 409 idempotency_key_reuse on handoffs and on interrupt, and writes nothing", async () => {
  await with_api(async (env) => {
    const one = await make_agent(env, "n3b-1");
    const two = await make_agent(env, "n3b-2");

    for (const [action, body] of [
      ["handoffs", { target_mode: "B" }],
      ["interrupt", { reason: "합성" }],
    ] as const) {
      const key = `synthetic-n3b-${action}-key`;
      // The key is spent on run one (held by agent one), which that call then releases / ends.
      const lease_one = await run_for_b(env, one);
      assert_ok(await call(env, { method: "POST", path: P(env, `/runs/${lease_one.run_id}/${action}`), auth: { token: one.token }, body, key }), action === "interrupt" ? 202 : 200);
      // Run two is another run (held by agent two): the same key on the same action is a reuse, not a replay.
      const lease_two = await run_for_b(env, two);
      const before = state_signature(env.db);
      for (const [who, auth] of [
        ["holder", { token: two.token }],
        ["owner", "owner"],
      ] as const) {
        const other = await call(env, { method: "POST", path: P(env, `/runs/${lease_two.run_id}/${action}`), auth, body, key });
        assert_error(other, 409, "idempotency_key_reuse");
        assert.equal(state_signature(env.db), before, `${action}/${who}: a refused reuse writes nothing`);
      }
      assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", lease_two.run_id)?.status, "running", `${action}: run two untouched`);
      // Free the project for the next round: run two ends with its own key.
      assert_ok(await call(env, { method: "POST", path: P(env, `/runs/${lease_two.run_id}/interrupt`), auth: { token: two.token }, body: { reason: "합성 정리" }, key: `synthetic-n3b-end-${action}` }), 202);
    }
  });
});

// ---------------------------------------------------------------------------
// N4 — the OpenAPI document names InputItem in the inputs response

const OPENAPI = parse_yaml(readFileSync(new URL("../docs/api/openapi-v1.yaml", import.meta.url), "utf8"));

function inputs_200_schema(): any {
  const op = OPENAPI.paths["/api/v1/projects/{id}/runs/{r}/inputs"].get;
  return op.responses["200"].content["application/json"].schema;
}

function mentions_ref(node: unknown, ref: string): boolean {
  if (Array.isArray(node)) return node.some((n) => mentions_ref(n, ref));
  if (node !== null && typeof node === "object") {
    return Object.entries(node as Record<string, unknown>).some(([k, v]) => (k === "$ref" && v === ref) || mentions_ref(v, ref));
  }
  return false;
}

test("N4 openapi: the inputs 200 response references the InputItem schema, and InputItem requires object_id", () => {
  assert.ok(mentions_ref(inputs_200_schema(), "#/components/schemas/InputItem"), "inputs 200 → InputItem ($ref), not just a plain Success + prose");
  const item = resolve_ref(OPENAPI, { $ref: "#/components/schemas/InputItem" });
  assert.ok(item.required.includes("object_id"));
  assert.ok(item.properties.object_id, "object_id is a property");
});

test("N4 openapi: the inputs 200 schema accepts an item with object_id and refuses one without it", () => {
  const item = { input_version_id: "ver_x", object_id: "ans_x", kind: "answer", question_id: "qst_x", available_at: 1, state: "new" };
  const body = (items: unknown[]) => ({ format_version: "1.0", request_id: "req_x", data: { inputs: items, next_cursor: "cur_x", has_more: false, epoch: "1" } });
  assert.deepEqual(validate(OPENAPI, inputs_200_schema(), body([item])), []);
  const { object_id: _gone, ...without } = item;
  assert.notDeepEqual(validate(OPENAPI, inputs_200_schema(), body([without])), [], "an item with no object_id is refused by the document's own schema");
  assert.notDeepEqual(validate(OPENAPI, inputs_200_schema(), body([{ ...item, kind: "question" }])), [], "kind is answer");
});

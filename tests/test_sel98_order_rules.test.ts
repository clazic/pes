/**
 * SEL-98 U2d (서버 쓰기·규칙) — 질문 순서 바꾸기 · ask_ai 방향 · single 숨은 질문 · 구성원 버전 한 규칙 · 보류 되돌리기 (tester, 작성 모드).
 * [회귀] = 지금도 통과해야 하는 가드, [신규] = 구현 전에는 실패.
 *
 * 스스로 정한 해석:
 *  3. 순서 바꾸기 = 명령 서비스 명령 하나(권장 이름 question.reorder). 새 질문·새 질문 버전·새 표 없이 **새 폼 세트 하나**를 같은 tx 로 발행한다(구성원 순서만 다름).
 *       POST P/question-sets/{set_id}/order   본문 {question_ids: [질문 id…]}   (소유자 세션 또는 run:submit 토큰, 멱등 키 필수)
 *       question_ids 는 그 세트 구성원 전부의 새 순서(순열)여야 한다. 응답 201 data = { set: {id, version_no, form_key}, members: [{question_id, version_id, position}] }.
 *       - 세트가 그 (단계, form_key)의 최신이 아니면 409 conflict (details.reason "stale_set"), 모르는 세트 404, 순열이 아니면(빠짐·중복·모르는 id) 422 validation_failed
 *         (target "$.body.question_ids", details.reason "not_a_permutation"). 거절은 아무것도 쓰지 않는다. 같은 키·같은 본문은 replayed:true(새 세트 0), 다른 본문은 409 idempotency_key_reuse.
 *       - 답은 그대로(순서는 답이 아니다). 새 세트의 구성원은 각 질문의 **현재 버전**을 가리킨다(아래 6번).
 *  4. ask_ai(사람이 AI 에게 묻는 질문) = 서버는 **계속 받지 않는다**. 근거: 이 서버의 질문은 에이전트가 사람에게 묻는 한 방향(agent_to_human)만 다루고, 사람→AI 는 라운드 입력(runs/inputs)으로
 *       가는 다른 길이라 질문 폼에 섞지 않는다(DB CHECK 가 human_to_agent 를 허용하지만 제출·재확인·필수 규칙이 사람 쪽 답을 전제로 해서 이 이슈에서 열지 않는다). 거절은 400 invalid_payload
 *       target "$.body.direction", 아무것도 쓰지 않는다. 문서(stage-1-api.md)에 '받지 않는다'를 적는다. 앱은 계속 요청 없이 NotConnectedError.
 *  6. (a) mode "single" 도 show_if 로 숨은(적용 안 되는) 질문의 답이면 bundle 처럼 invalid_payload details.reason "not_applicable" 로 거절하고 아무것도 쓰지 않는다.
 *     (b) 보류(deferred)는 되돌리지 않는다 — 되돌리기 명령을 만들지 않고 문서(stage-2-db-guarantees.md 8.8)에 "보류는 되돌릴 수 없다"를 적는다(SEL-90 최종 리뷰 권장 1의 두 길 중 문서 쪽).
 *     (c) 새 세트를 만드는 세 길(extend_latest · plan_sets_without(철회·보류·합침으로 빠짐) · 순서 바꾸기)은 남은 구성원의 질문 버전을 **현재 버전**으로 정한다. 문서 8.8 도 그렇게 고친다.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { assert_error, assert_ok, call, make_agent, with_api, type ApiEnv } from "./helpers/api_env.ts";
import { P, assert_final_error } from "./helpers/api_flow.ts";
import { make_content, seal, stage_ids } from "./helpers/editions_env.ts";
import {
  answer_version_count,
  api_submit,
  current_answer,
  current_row,
  history_counts,
  latest_set,
  make_form,
  owner_get,
  owner_post,
  set_count,
  single_spec,
  text_spec,
} from "./helpers/sel90_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const order = (env: ApiEnv, set_id: string, question_ids: string[], key?: string, extra: Record<string, unknown> = {}) =>
  owner_post(env, `/question-sets/${set_id}/order`, { question_ids, ...extra }, key);
const members = (env: ApiEnv, f: { stage_id: string }) => latest_set(env.db, env.p.project_id, f.stage_id).members;

function member_versions(env: ApiEnv, set_id: string): Record<string, string> {
  const rows = env.db.all<{ question_id: string; question_version_id: string }>("SELECT question_id, question_version_id FROM question_set_members WHERE set_id = ?", set_id);
  return Object.fromEntries(rows.map((r) => [r.question_id, r.question_version_id]));
}

/** 라운드를 봉인한다(합성 산출물 하나로 — 기존 라운드 흐름 시험과 같은 방법). */
async function seal_it(env: ApiEnv, round_id: string, tag: string): Promise<void> {
  const content = await make_content(env, tag);
  await seal(env, round_id, [{ object_id: content.object_id, version_id: content.version_id }], `${tag}-seal`);
}

// ---------------------------------------------------------------------------
// 3. 순서 바꾸기

test("[신규] 순서 바꾸기: 새 세트 하나(순서만 다름)가 한 tx 로 나오고, 질문·질문 버전은 새로 생기지 않는다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("가"), single_spec("나"), text_spec("다")]);
    const [a, b, c] = f.ids as [string, string, string];
    const before = history_counts(env.db);
    const sets_before = set_count(env.db, f.stage_id);
    const res = await order(env, f.set.set_id, [c, a, b], "ord-1");
    const data = assert_ok(res, 201);
    assert.equal(res.json.replayed, false);
    assert.notEqual(data.set.id, f.set.set_id);
    assert.equal(data.set.version_no, f.set.set_version_no + 1);
    assert.equal(data.set.form_key, "main");
    assert.deepEqual(data.members.map((m: any) => m.question_id), [c, a, b]);
    assert.deepEqual(data.members.map((m: any) => m.position), [0, 1, 2]);
    for (const m of data.members) assert.equal(m.version_id, current_row(env.db, m.question_id).version_id, "현재 버전");
    const after = history_counts(env.db);
    assert.equal(set_count(env.db, f.stage_id), sets_before + 1);
    assert.equal(after.question_sets - before.question_sets, 1);
    assert.equal(after.question_set_members - before.question_set_members, 3);
    assert.equal(after.questions, before.questions, "새 질문 없음");
    assert.equal(after.question_versions, before.question_versions, "새 질문 버전 없음");
    assert.equal(after.mutation_commits - before.mutation_commits, 1, "순서 바꾸기 = 한 tx");
    assert.deepEqual(members(env, f), [c, a, b]);
    // 옛 세트는 그대로
    assert.deepEqual(
      env.db.all<{ question_id: string }>("SELECT question_id FROM question_set_members WHERE set_id = ? ORDER BY position", f.set.set_id).map((r) => r.question_id),
      [a, b, c],
    );
  });
});

test("[신규] 순서 바꾸기: 라운드 읽기에 새 set_id · 새 form_version · 새 순서로 보인다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("가"), single_spec("나")]);
    const [a, b] = f.ids as [string, string];
    const out = assert_ok(await order(env, f.set.set_id, [b, a]), 201);
    const round = assert_ok(await owner_get(env, "/stages/plan/rounds/1"));
    assert.equal(round.set_id, out.set.id);
    assert.equal(round.form_version, out.set.version_no);
    assert.deepEqual(round.questions.map((q: any) => q.id), [b, a]);
  });
});

test("[신규] 순서 바꾸기: 답은 그대로이고, 새 세트로 버전 지정 없는 제출이 접수된다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("가"), single_spec("나")]);
    const [a, b] = f.ids as [string, string];
    assert_ok(await owner_post(env, "/submissions", { set_id: f.set.set_id, answers: [{ question_id: a, value: "a" }] }), 201);
    const answers_before = answer_version_count(env.db);
    const out = assert_ok(await order(env, f.set.set_id, [b, a]), 201);
    assert.equal(answer_version_count(env.db), answers_before, "순서는 답을 만들지 않는다");
    assert.equal(current_answer(env.db, a)?.value, "a");
    assert_ok(await owner_post(env, "/submissions", { set_id: out.set.id, mode: "bundle", answers: [{ question_id: b, value: "c" }] }), 201);
    assert.equal(current_answer(env.db, b)?.value, "c");
  });
});

test("[신규] 순서 바꾸기: 같은 키·같은 본문은 replayed(새 세트 0), 같은 키·다른 본문은 409 idempotency_key_reuse", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("가"), single_spec("나"), single_spec("다")]);
    const [a, b, c] = f.ids as [string, string, string];
    const first = assert_ok(await order(env, f.set.set_id, [b, c, a], "ord-same"), 201);
    const sets = set_count(env.db, f.stage_id);
    const again = await order(env, f.set.set_id, [b, c, a], "ord-same");
    assert.equal(again.status, 201);
    assert.equal(again.json.replayed, true);
    assert.deepEqual(again.json.data, first);
    assert.equal(set_count(env.db, f.stage_id), sets);
    assert_final_error(await order(env, f.set.set_id, [c, b, a], "ord-same"), 409, "idempotency_key_reuse");
    assert.equal(set_count(env.db, f.stage_id), sets);
  });
});

test("[신규] 순서 바꾸기 거절: 순열이 아니면 422, 옛 세트면 409, 모르는 세트 404, 키·필드·자격 — 아무것도 쓰지 않는다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("가"), single_spec("나"), single_spec("다")]);
    const [a, b, c] = f.ids as [string, string, string];
    const reader = await make_agent(env, "reader", ["context:read"]);
    const sig = state_signature(env.db);
    const reasons = async (ids: string[]) => {
      const res = await order(env, f.set.set_id, ids);
      const error = assert_error(res, 422, "validation_failed");
      assert.equal(error.target, "$.body.question_ids");
      assert.equal(error.details?.reason, "not_a_permutation");
    };
    await reasons([a, b]); // 빠짐
    await reasons([a, b, c, c]); // 중복
    await reasons([a, b, "no-such-question"]); // 모르는 id
    await reasons([]);
    assert_final_error(await order(env, "no-such-set", [a, b, c]), 404, "not_found");
    assert_final_error(await call(env, { method: "POST", path: P(env, `/question-sets/${f.set.set_id}/order`), auth: "owner", body: { question_ids: [a, b, c] }, key: null }), 400, "invalid_payload", { target: /idempotency-key/i });
    assert_final_error(await order(env, f.set.set_id, [a, b, c], undefined, { surprise: 1 }), 400, "invalid_payload");
    assert_final_error(await owner_post(env, `/question-sets/${f.set.set_id}/order`, { question_ids: "abc" }), 400, "invalid_payload");
    assert_final_error(await call(env, { method: "POST", path: P(env, `/question-sets/${f.set.set_id}/order`), auth: "none", body: { question_ids: [a, b, c] } }), 401, "unauthenticated");
    assert_final_error(await call(env, { method: "POST", path: P(env, `/question-sets/${f.set.set_id}/order`), auth: { token: reader.token }, body: { question_ids: [a, b, c] } }), 403, "forbidden");
    assert.deepEqual(state_signature(env.db), sig, "거절은 아무것도 쓰지 않는다");
    // 옛 세트: 한 번 바꾼 뒤 처음 세트로 다시 바꾸려 하면 낡은 폼
    assert_ok(await order(env, f.set.set_id, [c, b, a]), 201);
    const stale = assert_error(await order(env, f.set.set_id, [a, b, c]), 409, "conflict");
    assert.equal(stale.details?.reason, "stale_set");
  });
});

test("[신규] 순서 바꾸기: 철회로 빠진 질문은 순열에 넣을 수 없다(최신 세트 구성원만)", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("가"), single_spec("나"), single_spec("다")]);
    const [a, b, c] = f.ids as [string, string, string];
    assert_ok(await owner_post(env, `/questions/${b}/withdraw`, {}), 201);
    const latest = latest_set(env.db, env.p.project_id, f.stage_id);
    assert.deepEqual(latest.members, [a, c]);
    assert_error(await order(env, latest.id, [c, b, a]), 422, "validation_failed");
    assert_ok(await order(env, latest.id, [c, a]), 201);
    assert.deepEqual(members(env, f), [c, a]);
  });
});

test("[신규] 순서 바꾸기: 닫힌(봉인된) 라운드의 세트는 바꿀 수 없다 — 409", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("가"), single_spec("나")]);
    const [a, b] = f.ids as [string, string];
    await seal_it(env, f.round_id, "sl");
    const sig = state_signature(env.db);
    assert_error(await order(env, f.set.set_id, [b, a]), 409, "conflict");
    assert.deepEqual(state_signature(env.db), sig);
  });
});

test("[신규] OpenAPI·문서에 순서 바꾸기 라우트가 적혀 있다", async () => {
  const yaml = readFileSync(new URL("../docs/api/openapi-v1.yaml", import.meta.url), "utf8");
  assert.match(yaml, /\/api\/v1\/projects\/\{id\}\/question-sets\/\{[a-z]+\}\/order:\n\s+post:/);
});

// ---------------------------------------------------------------------------
// 4. ask_ai 방향 — 서버는 계속 받지 않는다

test("[회귀] 질문 방향은 agent_to_human 만 — ask_ai · human_to_agent 는 400 invalid_payload (target $.body.direction), 아무것도 쓰지 않는다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("가")]);
    const body = (direction: unknown) => ({ stage_id: f.stage_id, round_id: f.round_id, purpose: "stage_start", form_key: "main", direction, question: single_spec("사람이 AI 에게") });
    const sig = state_signature(env.db);
    for (const direction of ["ask_ai", "human_to_agent", "bogus"]) {
      const error = assert_error(await owner_post(env, "/questions", body(direction)), 400, "invalid_payload");
      assert.equal(error.target, "$.body.direction", direction);
    }
    assert.deepEqual(state_signature(env.db), sig);
    // agent_to_human 은 받는다 (회귀)
    assert_ok(await owner_post(env, "/questions", body("agent_to_human")), 201);
  });
});

test("[신규] 문서: stage-1-api.md 가 ask_ai(사람→AI) 질문을 서버가 받지 않는다고 적는다", () => {
  const doc = readFileSync(new URL("../docs/plan/stage-1-api.md", import.meta.url), "utf8");
  assert.match(doc, /ask_ai[^\n]{0,200}(받지 않|지원하지 않|거절)/);
});

// ---------------------------------------------------------------------------
// 6. SEL-90 권장

function hidden_pair(env: ApiEnv) {
  return (async () => {
    const f = await make_form(env, [single_spec("부모", { required: false })]);
    const parent = f.ids[0]!;
    const added = assert_ok(
      await owner_post(env, "/questions", { stage_id: f.stage_id, round_id: f.round_id, purpose: "stage_start", form_key: "main", question: single_spec("자식", { required: false, show_if: { id: parent, in: ["a"] } }) }),
      201,
    );
    const child = added.question.id as string;
    return { f, parent, child, set_id: latest_set(env.db, env.p.project_id, f.stage_id).id };
  })();
}

test("[신규] single 제출도 show_if 로 숨은 질문의 답은 not_applicable 로 거절하고 아무것도 쓰지 않는다", async () => {
  await with_api(async (env) => {
    const { parent, child, set_id } = await hidden_pair(env);
    assert_ok(await api_submit(env, set_id, [{ question_id: parent, value: "b" }], { mode: "single" }), 201); // 부모 b → 자식 숨음
    const sig = state_signature(env.db);
    const res = await api_submit(env, set_id, [{ question_id: child, value: "a" }], { mode: "single" });
    const error = assert_error(res, 422, "validation_failed");
    assert.equal(error.details?.reason, "not_applicable");
    assert.deepEqual(error.details?.question_ids ?? [error.details?.question_id], [child]);
    assert.deepEqual(state_signature(env.db), sig);
    assert.equal(current_answer(env.db, child), null);
  });
});

test("[회귀] bundle 의 not_applicable 은 그대로이고, single 도 적용되는 질문(부모 a 일 때 자식)은 받는다", async () => {
  await with_api(async (env) => {
    const { parent, child, set_id } = await hidden_pair(env);
    assert_ok(await api_submit(env, set_id, [{ question_id: parent, value: "b" }], { mode: "bundle" }), 201);
    const bundle = assert_error(await api_submit(env, set_id, [{ question_id: child, value: "a" }], { mode: "bundle" }), 422, "validation_failed");
    assert.equal(bundle.details?.reason, "not_applicable");
    assert_ok(await api_submit(env, set_id, [{ question_id: parent, value: "a" }], { mode: "single" }), 201); // 부모 a → 자식 보임
    assert_ok(await api_submit(env, set_id, [{ question_id: child, value: "b" }], { mode: "single" }), 201);
    assert.equal(current_answer(env.db, child)?.value, "b");
  });
});

test("[회귀] single 의 같은 제출 안 조건: 부모를 a 로 바꾸는 것과 같이 보내는 자식은 single 이 아니라 항목 1개 규칙 때문에 거절된다 (single_requires_one_item 유지)", async () => {
  await with_api(async (env) => {
    const { parent, child, set_id } = await hidden_pair(env);
    const sig = state_signature(env.db);
    const error = assert_error(await api_submit(env, set_id, [{ question_id: parent, value: "a" }, { question_id: child, value: "b" }], { mode: "single" }), 422, "validation_failed");
    assert.equal(error.details?.reason, "single_requires_one_item");
    assert.deepEqual(state_signature(env.db), sig);
  });
});

test("[신규] 구성원 버전 한 규칙: 질문을 고친 뒤 다른 질문을 철회하면 새 세트는 고친 질문의 현재 버전을 가리킨다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("고칠 질문"), single_spec("철회할 질문"), single_spec("그대로")]);
    const [a, b, c] = f.ids as [string, string, string];
    const v1 = current_row(env.db, a).version_id;
    assert_ok(await owner_post(env, `/questions/${a}/revisions`, { base_version_id: v1, question: { text: "고친 문구" } }), 201);
    const v2 = current_row(env.db, a).version_id;
    assert.notEqual(v1, v2);
    assert_ok(await owner_post(env, `/questions/${b}/withdraw`, {}), 201);
    const latest = latest_set(env.db, env.p.project_id, f.stage_id);
    const pinned = member_versions(env, latest.id);
    assert.deepEqual(latest.members, [a, c]);
    assert.equal(pinned[a], v2, "철회로 만든 새 세트가 고친 질문의 옛 버전을 가리키면 안 된다");
    assert.equal(pinned[c], current_row(env.db, c).version_id);
  });
});

test("[신규] 구성원 버전 한 규칙: 보류·합침으로 빠지는 새 세트도 같은 규칙이고, 이어 붙이기·순서 바꾸기와 결과가 같다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("고칠 질문"), single_spec("보류할 질문"), single_spec("합칠 질문"), single_spec("받는 질문")]);
    const [a, b, c, d] = f.ids as [string, string, string, string];
    const v1 = current_row(env.db, a).version_id;
    assert_ok(await owner_post(env, `/questions/${a}/revisions`, { base_version_id: v1, question: { text: "고친 문구" } }), 201);
    const v2 = current_row(env.db, a).version_id;
    assert_ok(await owner_post(env, `/questions/${b}/defer`, {}), 201);
    assert.equal(member_versions(env, latest_set(env.db, env.p.project_id, f.stage_id).id)[a], v2, "보류로 빠지는 세트");
    assert_ok(await owner_post(env, `/questions/${c}/merge`, { merged_into_question_id: d }), 201);
    assert.equal(member_versions(env, latest_set(env.db, env.p.project_id, f.stage_id).id)[a], v2, "합침으로 빠지는 세트");
    // 이어 붙이기(질문 추가)와 순서 바꾸기도 같은 현재 버전
    assert_ok(await owner_post(env, "/questions", { stage_id: f.stage_id, round_id: f.round_id, purpose: "stage_start", form_key: "main", question: text_spec("새 질문") }), 201);
    assert.equal(member_versions(env, latest_set(env.db, env.p.project_id, f.stage_id).id)[a], v2, "이어 붙이기");
    const latest = latest_set(env.db, env.p.project_id, f.stage_id);
    assert_ok(await order(env, latest.id, [...latest.members].reverse()), 201);
    assert.equal(member_versions(env, latest_set(env.db, env.p.project_id, f.stage_id).id)[a], v2, "순서 바꾸기");
  });
});

test("[회귀] 보류는 되돌리는 길이 없다: 보류한 질문은 세트에 다시 못 넣고 다시 보류해도 conflict (고치기는 state deferred 유지)", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("보류할 질문"), single_spec("남는 질문")]);
    const [a] = f.ids as [string, string];
    assert_ok(await owner_post(env, `/questions/${a}/defer`, {}), 201);
    assert_error(await owner_post(env, `/questions/${a}/defer`, {}), 409, "conflict");
    const v = current_row(env.db, a).version_id;
    assert_ok(await owner_post(env, `/questions/${a}/revisions`, { base_version_id: v, question: { text: "보류 중 고침" } }), 201);
    assert.equal(current_row(env.db, a).state, "deferred", "고쳐도 state 는 deferred");
    assert_error(await owner_post(env, "/questions", { stage_id: f.stage_id, round_id: f.round_id, purpose: "stage_start", form_key: "main", question: { question_id: a } }), 422, "validation_failed");
  });
});

test("[신규] 문서: 8.8 이 '보류는 되돌릴 수 없다'를 적고, 빠지는 세트 설명이 '폼이 고정한 버전 그대로' 가 아니라 현재 버전 규칙이다", () => {
  const doc = readFileSync(new URL("../docs/plan/stage-2-db-guarantees.md", import.meta.url), "utf8");
  assert.match(doc, /보류[^\n]{0,80}되돌릴 수 없/);
  const line = doc.split("\n").find((l) => l.startsWith("- **빠지는 세트**"));
  assert.ok(line, "빠지는 세트 항목");
  assert.doesNotMatch(line!, /폼이 고정한 버전 그대로/);
  assert.match(line!, /현재 버전/);
  assert.match(doc, /순서 바꾸기/);
});

// 1차 리뷰 권장 7(a): 새 순서가 현재 순서와 같으면 헛 쓰기(새 세트·사건) 대신 422 no_change 로 거절한다 — 아무것도 쓰지 않는다.
test("[신규] 순서 바꾸기: 현재 순서와 같은 순서는 422 validation_failed(reason no_change, target $.body.question_ids) — 새 세트·사건 0", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("가"), single_spec("나"), single_spec("다")]);
    const [a, b, c] = f.ids as [string, string, string];
    const sig = state_signature(env.db);
    const sets = set_count(env.db, f.stage_id);
    const error = assert_error(await order(env, f.set.set_id, [a, b, c], "ord-noop"), 422, "validation_failed");
    assert.equal(error.target, "$.body.question_ids");
    assert.equal(error.details?.reason, "no_change");
    assert.equal(set_count(env.db, f.stage_id), sets);
    assert.deepEqual(state_signature(env.db), sig, "거절은 아무것도 쓰지 않는다");
    // 한 번 바꾼 뒤에는 그 순서가 '현재' 순서다
    assert_ok(await order(env, f.set.set_id, [b, c, a], "ord-real"), 201);
    const now = latest_set(env.db, env.p.project_id, f.stage_id);
    assert_error(await order(env, now.id, [b, c, a], "ord-noop2"), 422, "validation_failed");
  });
});

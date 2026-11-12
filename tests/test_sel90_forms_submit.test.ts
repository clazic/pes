/**
 * SEL-90 U2a — 폼 세트 발행·질문 고치기·중요도/필수·묶음/개별 제출 (tester, 작성 모드).
 * 이름 앞 [회귀]는 지금도 통과해야 하는 가드(이미 있는 동작), [신규]는 구현 전에는 실패하는 시험.
 *
 * 스스로 정한 해석(이슈가 모양을 주지 않은 부분):
 *   - 추가·제외·순서 = question.publish_set(기존 질문은 {question_id}로 가리킴)이 새 세트를 발행. 새 명령 question.add 는 만들지 않는다.
 *     API 에서는 POST P/questions 가 같은 form_key 의 최신 세트 멤버를 이어 받아 끝에 새 질문을 붙인 새 세트를 낸다.
 *   - answer.submit / POST P/submissions 에 닫힌 선택 필드 `mode: "bundle" | "single"` 을 더한다. 없으면 지금 동작(부분 제출 허용) 그대로.
 *       bundle: 이 제출 + 이미 낸 현재 답으로 폼의 "적용되는 필수 질문"이 모두 채워져야 한다. 아니면 invalid_payload
 *               (details.reason = "required_missing", details.question_ids) 이고 아무것도 쓰지 않는다.
 *               show_if {id: <질문 id>, in: [값…]} 가 거짓인 질문은 적용되지 않는다: 필수가 아니고, 답을 보내면
 *               invalid_payload (details.reason = "not_applicable"). 조건은 이 제출의 답을 먼저, 없으면 현재 답으로 본다.
 *               의견(other)만 있는 항목은 allow_comment_as_answer=1 일 때만 필수를 채운다.
 *       single: 항목이 정확히 1개(아니면 invalid_payload, details.reason = "single_requires_one_item").
 *   - 결과/응답에 `form_complete`(boolean)와 `missing_required`(질문 id 배열)를 더한다. single 은 다른 필수 질문이 비어 있으면
 *     form_complete=false 이고 라운드·단계 상태는 바뀌지 않는다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { publish_set, resume_ready, revise_question, submit_answers } from "../scripts/pes_core/questions.ts";
import { assert_ok, with_api, call, type ApiEnv } from "./helpers/api_env.ts";
import { P, assert_final_error } from "./helpers/api_flow.ts";
import { rejects_api } from "./helpers/questions_env.ts";
import {
  answer_version_count,
  api_submit,
  api_submit_ok,
  cmd,
  comment_messages,
  current_answer,
  current_row,
  history_counts,
  latest_set,
  make_form,
  owner_post,
  set_count,
  single_spec,
  text_spec,
  versions_of,
} from "./helpers/sel90_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const A = (id: string, value: unknown = "a", extra: Record<string, unknown> = {}) => ({ question_id: id, value, ...extra });
const submit = (env: ApiEnv, set_id: string, answers: Record<string, unknown>[], key: string, extra: Record<string, unknown> = {}) =>
  submit_answers(env.service, env.ctx(key), { set_id, answers, ...extra });

// ---------------------------------------------------------------------------
// 2. 추가·제외·순서 = 새 폼 세트

test("[회귀] 추가·제외·순서 변경마다 새 세트가 발행되고, 옛 세트·멤버는 그대로다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("질문 1"), single_spec("질문 2")]);
    const [q1, q2] = f.ids;
    const where = { stage_id: f.stage_id, round_id: f.round_id, purpose: "stage_start", form_key: "main" };

    // 추가: 기존 둘 + 새 질문 하나 — 새 질문과 첫 버전은 세트와 같은 tx
    const before = history_counts(env.db);
    const added = await publish_set(env.service, env.ctx("add-1"), { ...where, questions: [{ question_id: q1 }, { question_id: q2 }, text_spec("질문 3")] });
    const r1 = added.result as any;
    assert.equal(r1.set_version_no, 2);
    const after = history_counts(env.db);
    assert.equal(after.questions - before.questions, 1);
    assert.equal(after.question_versions - before.question_versions, 1, "새 질문의 첫 버전");
    assert.equal(after.question_sets - before.question_sets, 1);
    assert.equal(after.question_set_members - before.question_set_members, 3);
    assert.equal(after.mutation_commits - before.mutation_commits, 1, "추가 = 한 tx");
    const q3 = r1.members[2].question_id;

    // 제외: q2 를 빼도 질문은 삭제되지 않고 열려 있다
    const removed = await publish_set(env.service, env.ctx("rm-1"), { ...where, questions: [{ question_id: q1 }, { question_id: q3 }] });
    assert.equal((removed.result as any).set_version_no, 3);
    assert.equal(current_row(env.db, q2!).state, "open");
    assert.equal(versions_of(env.db, q2!).length, 1);

    // 순서: 같은 멤버, 거꾸로
    const reordered = await publish_set(env.service, env.ctx("ord-1"), { ...where, questions: [{ question_id: q3 }, { question_id: q1 }] });
    const r3 = reordered.result as any;
    assert.equal(r3.set_version_no, 4);
    assert.deepEqual(latest_set(env.db, env.p.project_id, f.stage_id).members, [q3, q1]);
    assert.equal(set_count(env.db, f.stage_id), 4);
    const first = env.db.all("SELECT question_id FROM question_set_members WHERE set_id = ? ORDER BY position", f.set.set_id);
    assert.deepEqual(first.map((r: any) => r.question_id), [q1, q2], "첫 세트는 바뀌지 않는다");
    const chain = env.db.all("SELECT version_no, previous_set_id, id FROM question_sets WHERE stage_id = ? ORDER BY version_no", f.stage_id) as any[];
    for (let i = 1; i < chain.length; i += 1) assert.equal(chain[i].previous_set_id, chain[i - 1].id);
  });
});

test("[회귀] 새 질문이 하나라도 잘못이면 세트·질문·첫 버전·멤버가 하나도 남지 않는다 (질문 추가와 첫 버전은 한 tx)", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("질문 1")]);
    const sig = state_signature(env.db);
    const where = { stage_id: f.stage_id, round_id: f.round_id, purpose: "stage_start", form_key: "main" };
    await rejects_api(
      publish_set(env.service, env.ctx("add-bad"), { ...where, questions: [{ question_id: f.ids[0] }, text_spec("좋은 질문"), { text: "나쁜 질문", type: "nope" }] }),
      "invalid_payload",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

test("[신규] API 질문 추가: 같은 form_key 로 게시하면 이전 질문들을 이어 받은 새 세트가 나온다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("질문 1"), single_spec("질문 2")]);
    const res = await owner_post(env, "/questions", {
      stage_id: f.stage_id,
      round_id: f.round_id,
      purpose: "stage_start",
      form_key: "main",
      question: text_spec("질문 3"),
    });
    const data = assert_ok(res, 201);
    const now = latest_set(env.db, env.p.project_id, f.stage_id);
    assert.equal(now.id, data.question_set_id);
    assert.equal(now.version_no, 2);
    assert.deepEqual(now.members, [...f.ids, data.question.id], "이전 멤버가 순서대로 남고 새 질문이 끝에 붙는다");
    // 이어 받은 질문에는 새 버전이 생기지 않는다
    for (const id of f.ids) assert.equal(versions_of(env.db, id).length, 1);
  });
});

// ---------------------------------------------------------------------------
// 3. 고치기 = 새 버전·재확인·옛 답 보존·자동 승계 없음

test("[회귀] 고치면 새 버전·재확인 필요·옛 답 보존, 옛 답은 새 버전으로 승계되지 않는다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("고칠 질문")]);
    const q = f.ids[0]!;
    await submit(env, f.set.set_id, [A(q)], "s1");
    const v1 = current_row(env.db, q).version_id;
    const a1 = current_answer(env.db, q)!;
    assert.equal(a1.question_version_id, v1);
    assert.equal(resume_ready(env.db, env.p.project_id, f.round_id).ready, true);

    const rev = (await revise_question(env.service, env.ctx("r1"), { question_id: q, base_version_id: v1, text: "고친 문구" })).result as any;
    assert.equal(rev.version_no, 2);
    assert.equal(versions_of(env.db, q).length, 2);
    assert.equal(versions_of(env.db, q)[0]!.text, "고칠 질문", "옛 문구는 그대로");
    assert.equal(answer_version_count(env.db), 1, "고치기만으로 답이 늘지 않는다");
    assert.equal(current_answer(env.db, q)!.question_version_id, v1, "옛 답은 옛 질문 버전에 묶인 채 남는다");
    const ready = resume_ready(env.db, env.p.project_id, f.round_id);
    assert.equal(ready.ready, false);
    assert.deepEqual(ready.missing.map((m) => [m.question_id, m.reason]), [[q, "needs_reconfirmation"]]);
  });
});

test("[회귀] 새 문구를 확인한 뒤 다시 답하면 새 답 버전이 옛 답 위에 쌓이고, 옛 답 행은 남는다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("고칠 질문")]);
    const q = f.ids[0]!;
    const where = { stage_id: f.stage_id, round_id: f.round_id, purpose: "stage_start", form_key: "main" };
    await submit(env, f.set.set_id, [A(q, "a")], "s1");
    const old_answer = current_answer(env.db, q)!;
    await cmd(env, "r1", "question.revise", { question_id: q, text: "고친 문구" });
    // 옛 세트는 낡았다
    await rejects_api(submit(env, f.set.set_id, [A(q, "b")], "s-stale"), "conflict");
    const next = (await publish_set(env.service, env.ctx("pub-2"), { ...where, questions: [{ question_id: q }] })).result as any;
    const v2 = current_row(env.db, q).version_id;
    await submit(env, next.set_id, [A(q, "c", { question_version_id: v2 })], "s2");
    const now = current_answer(env.db, q)!;
    assert.equal(now.value, "c");
    assert.equal(now.question_version_id, v2);
    assert.equal(answer_version_count(env.db), 2);
    const old = env.db.get<{ value: string }>("SELECT value FROM answer_versions WHERE version_id = ?", old_answer.version_id);
    assert.equal(JSON.parse(old!.value), "a", "옛 답 버전은 그대로");
    assert.equal(resume_ready(env.db, env.p.project_id, f.round_id).ready, true);
  });
});

// ---------------------------------------------------------------------------
// 4. 중요도·필수 독립

test("[회귀] 중요도만 고치면 필수는 그대로, 필수만 고치면 중요도는 그대로다 (독립 사례 2개)", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("독립 질문", { importance: "low", required: false })]);
    const q = f.ids[0]!;
    assert.deepEqual([current_row(env.db, q).importance, current_row(env.db, q).required], ["low", 0]);
    await cmd(env, "imp", "question.revise", { question_id: q, importance: "high" });
    assert.deepEqual([current_row(env.db, q).importance, current_row(env.db, q).required], ["high", 0], "사례 1: 중요도만 바뀐다");
    await cmd(env, "req", "question.revise", { question_id: q, required: true });
    assert.deepEqual([current_row(env.db, q).importance, current_row(env.db, q).required], ["high", 1], "사례 2: 필수만 바뀐다");
    assert.equal(versions_of(env.db, q).length, 3, "고칠 때마다 새 버전");
    assert.equal(versions_of(env.db, q)[0]!.importance, "low", "옛 버전은 그대로");
  });
});

test("[회귀] API 고치기도 importance·required 를 따로 고친다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("독립 질문", { importance: "normal", required: true })]);
    const q = f.ids[0]!;
    const v1 = current_row(env.db, q).version_id;
    const a = assert_ok(await owner_post(env, `/questions/${q}/revisions`, { base_version_id: v1, question: { importance: "high" } }), 201);
    assert.deepEqual([current_row(env.db, q).importance, current_row(env.db, q).required], ["high", 1]);
    assert_ok(await owner_post(env, `/questions/${q}/revisions`, { base_version_id: a.question.version_id, question: { required: false } }), 201);
    assert.deepEqual([current_row(env.db, q).importance, current_row(env.db, q).required], ["high", 0]);
  });
});

test("[회귀] 기본값·추천은 답이 아니다: used_default 는 사람이 기본값을 골라 보낼 때만 1", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("기본값 질문"), single_spec("기본값 질문 2"), single_spec("기본값 질문 3")]);
    const [a, b, c] = f.ids;
    assert.equal(answer_version_count(env.db), 0, "게시·고치기만으로 답이 생기지 않는다");
    await cmd(env, "rv", "question.revise", { question_id: a!, default_value: "c" });
    assert.equal(answer_version_count(env.db), 0);
    await api_submit_ok(env, f.set.set_id, [
      { question_id: b, value: "b", used_default: true },
      { question_id: c, value: "a" },
    ]);
    assert.equal(current_answer(env.db, b!)!.used_default, 1);
    assert.equal(current_answer(env.db, c!)!.used_default, 0, "추천 선택지를 골라도 기본값 채택이 아니다");
    assert.equal(current_answer(env.db, a!), null);
  });
});

// ---------------------------------------------------------------------------
// 5. 묶음 제출

async function required_form(env: ApiEnv) {
  return make_form(env, [single_spec("필수 1"), single_spec("필수 2"), text_spec("선택 3")]);
}

test("[신규] 묶음: 적용되는 필수 질문이 하나라도 비면 거부하고 아무것도 쓰지 않는다", async () => {
  await with_api(async (env) => {
    const f = await required_form(env);
    const [q1, q2] = f.ids;
    const sig = state_signature(env.db);
    const err = await rejects_api(submit(env, f.set.set_id, [A(q1!)], "b-1", { mode: "bundle" }), "invalid_payload");
    assert.equal((err.details as any)?.reason, "required_missing");
    assert.deepEqual((err.details as any)?.question_ids, [q2]);
    assert.equal(state_signature(env.db), sig, "부분 접수 0");
    const ok = await submit(env, f.set.set_id, [A(q1!), A(q2!, "c")], "b-2", { mode: "bundle" });
    assert.equal((ok.result as any).form_complete, true);
    assert.deepEqual((ok.result as any).missing_required, []);
  });
});

test("[신규] 묶음: 앞서 낸 현재 답은 필수를 채운다 (같은 질문 버전일 때만)", async () => {
  await with_api(async (env) => {
    const f = await required_form(env);
    const [q1, q2] = f.ids;
    await submit(env, f.set.set_id, [A(q1!)], "pre");
    const done = await submit(env, f.set.set_id, [A(q2!, "b")], "b-1", { mode: "bundle" });
    assert.equal((done.result as any).form_complete, true, "q1 은 이미 현재 버전에 답이 있다");

    // q1 을 고치면 옛 답은 필수를 채우지 못한다
    await cmd(env, "r-q1", "question.revise", { question_id: q1!, text: "고친 필수 1" });
    const where = { stage_id: f.stage_id, round_id: f.round_id, purpose: "stage_start", form_key: "main" };
    const next = (await publish_set(env.service, env.ctx("pub-3"), { ...where, questions: f.ids.map((question_id) => ({ question_id })) })).result as any;
    const err = await rejects_api(submit(env, next.set_id, [A(q2!, "c")], "b-2", { mode: "bundle" }), "invalid_payload");
    assert.deepEqual((err.details as any)?.question_ids, [q1]);
  });
});

test("[신규] 묶음 + 조건부(show_if): 조건이 거짓이면 그 질문은 필수가 아니고, 답을 보내면 거부한다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("부모 질문")]);
    const parent = f.ids[0]!;
    const where = { stage_id: f.stage_id, round_id: f.round_id, purpose: "stage_start", form_key: "main" };
    const next = (
      await publish_set(env.service, env.ctx("pub-c"), {
        ...where,
        questions: [{ question_id: parent }, text_spec("조건부 자식", { required: true, show_if: { id: parent, in: ["a"] } })],
      })
    ).result as any;
    const child = next.members[1].question_id;
    assert.deepEqual(current_row(env.db, child).show_if, JSON.stringify({ id: parent, in: ["a"] }));

    // 부모가 "b" → 자식은 적용되지 않는다
    const none = await submit(env, next.set_id, [A(parent, "b")], "c-1", { mode: "bundle" });
    assert.equal((none.result as any).form_complete, true, "적용되지 않는 필수 질문은 비어 있어도 된다");
    const sig = state_signature(env.db);
    const e1 = await rejects_api(submit(env, next.set_id, [A(parent, "b"), A(child, "x")], "c-2", { mode: "bundle" }), "invalid_payload");
    assert.equal((e1.details as any)?.reason, "not_applicable");
    assert.equal(state_signature(env.db), sig, "거부된 묶음은 아무것도 쓰지 않는다");

    // 부모가 "a" → 자식은 필수
    const e2 = await rejects_api(submit(env, next.set_id, [A(parent, "a")], "c-3", { mode: "bundle" }), "invalid_payload");
    assert.equal((e2.details as any)?.reason, "required_missing");
    assert.deepEqual((e2.details as any)?.question_ids, [child]);
    const ok = await submit(env, next.set_id, [A(parent, "a"), A(child, "채움")], "c-4", { mode: "bundle" });
    assert.equal((ok.result as any).form_complete, true);
  });
});

test("[회귀] 충돌하는 항목이 하나라도 있으면 제출·답·의견·영수증 모두 0 (묶음 부분 접수 없음)", async () => {
  await with_api(async (env) => {
    const f = await required_form(env);
    const [q1, q2, q3] = f.ids;
    const stale = current_row(env.db, q2!).version_id;
    await cmd(env, "r-q2", "question.revise", { question_id: q2!, text: "고친 필수 2" });
    const sig = state_signature(env.db);
    const err = await rejects_api(
      submit(env, f.set.set_id, [A(q1!), A(q2!, "b", { question_version_id: stale }), { question_id: q3, other: "의견", value: "글" }], "c-1"),
      "conflict",
    );
    assert.equal((err.details as any)?.reason, "question_version_changed");
    assert.equal(state_signature(env.db), sig);
    const counts = history_counts(env.db);
    assert.equal(counts.submissions, 0);
    assert.equal(counts.threads, 0);
  });
});

test("[신규] allow_comment_as_answer 허용: 의견만 보내도 필수 질문이 채워진다 (묶음)", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("의견 허용 필수", { allow_comment_as_answer: true })]);
    const q = f.ids[0]!;
    const out = await submit(env, f.set.set_id, [{ question_id: q, other: "선택지에 없는 직접 의견" }], "ca-1", { mode: "bundle" });
    assert.equal((out.result as any).form_complete, true);
    const answer = current_answer(env.db, q)!;
    assert.equal(answer.value, null, "의견이 답으로 인정돼도 선택지를 대신 고르지 않는다");
    assert.equal(comment_messages(env.db, q).length, 1);
    assert.equal(comment_messages(env.db, q)[0]!.body_md, "선택지에 없는 직접 의견");
  });
});

test("[신규] allow_comment_as_answer 불허: 의견만으로는 필수를 못 채우고, 묶음 전체가 거부되어 의견도 남지 않는다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("의견 불허 필수", { allow_comment_as_answer: false })]);
    const q = f.ids[0]!;
    const sig = state_signature(env.db);
    const err = await rejects_api(submit(env, f.set.set_id, [{ question_id: q, other: "의견만" }], "cn-1", { mode: "bundle" }), "invalid_payload");
    assert.equal((err.details as any)?.reason, "required_missing");
    assert.equal(state_signature(env.db), sig);
    // 선택하고 의견을 덧붙이면 둘 다 남는다
    const ok = await submit(env, f.set.set_id, [{ question_id: q, value: "a", other: "덧붙임" }], "cn-2", { mode: "bundle" });
    assert.equal((ok.result as any).form_complete, true);
    assert.equal(current_answer(env.db, q)!.value, "a");
    assert.equal(comment_messages(env.db, q).length, 1);
  });
});

test("[회귀] 묶음 아닌 제출에서는 불허 질문의 의견만 있는 항목이 의견으로만 남고 답은 생기지 않는다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [text_spec("선택 질문", { allow_comment_as_answer: false })]);
    const q = f.ids[0]!;
    await submit(env, f.set.set_id, [{ question_id: q, other: "의견만" }], "co-1");
    assert.equal(current_answer(env.db, q), null);
    assert.equal(comment_messages(env.db, q).length, 1);
    assert.equal(comment_messages(env.db, q)[0]!.context_kind, "question_comment");
  });
});

test("[회귀] __other 의견만 있는 응답(허용 질문): 추천·기본 선택지가 대신 골라지지 않고 의견 스레드가 질문 버전에 묶인다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("직접 쓰기", { allow_comment_as_answer: true })]);
    const q = f.ids[0]!;
    const data = await api_submit_ok(env, f.set.set_id, [{ question_id: q, comment: "__other 로 쓴 의견" }]);
    assert.equal(data.answers[0].state, "submitted");
    const answer = current_answer(env.db, q)!;
    assert.equal(answer.value, null);
    assert.equal(answer.used_default, 0);
    const msg = comment_messages(env.db, q);
    assert.equal(msg.length, 1);
    const thread = env.db.get<{ target_version_id: string }>("SELECT target_version_id FROM threads WHERE object_id = ?", msg[0]!.thread_id);
    assert.equal(thread?.target_version_id, current_row(env.db, q).version_id);
  });
});

test("[신규] API 묶음: mode=bundle 은 필수 누락을 422 validation_failed 로 알리고 target 이 답 목록을 가리킨다", async () => {
  await with_api(async (env) => {
    const f = await required_form(env);
    const [q1, q2] = f.ids;
    const sig = state_signature(env.db);
    const e = assert_final_error(await api_submit(env, f.set.set_id, [A(q1!)], { mode: "bundle" }), 422, "validation_failed", { target: "$.body.answers" });
    assert.equal(e.details.reason, "required_missing");
    assert.deepEqual(e.details.question_ids, [q2]);
    assert.equal(state_signature(env.db), sig);
    const data = assert_ok(await api_submit(env, f.set.set_id, [A(q1!), A(q2!, "c")], { mode: "bundle" }), 201);
    assert.equal(data.form_complete, true);
    assert.deepEqual(data.missing_required, []);
    assert_final_error(await api_submit(env, f.set.set_id, [A(q1!)], { mode: "everything" }), 400, "invalid_payload", { target: "$.body.mode" });
  });
});

// ---------------------------------------------------------------------------
// 6. 개별 제출

test("[신규] 개별 제출: 한 질문만 접수하고 다른 필수 질문이 끝났다고 말하지 않는다 (라운드·폼 상태 불변)", async () => {
  await with_api(async (env) => {
    const f = await required_form(env);
    const [q1, q2] = f.ids;
    const round_before = env.db.get<{ state: string; rev: bigint }>("SELECT state, rev FROM rounds WHERE id = ?", f.round_id);
    const stage_before = env.db.get<{ status: string; rev: bigint }>("SELECT status, rev FROM stages WHERE id = ?", f.stage_id);
    const out = await submit(env, f.set.set_id, [A(q1!)], "one", { mode: "single" });
    const r = out.result as any;
    assert.equal(r.answers.length, 1);
    assert.equal(r.form_complete, false);
    assert.deepEqual(r.missing_required, [q2]);
    assert.equal(current_answer(env.db, q1!)!.value, "a");
    assert.equal(current_answer(env.db, q2!), null, "다른 질문의 답은 만들어지지 않는다");
    assert.equal(history_counts(env.db).submissions, 1);
    const ready = resume_ready(env.db, env.p.project_id, f.round_id);
    assert.equal(ready.ready, false, "재개 준비는 여전히 아니다");
    assert.deepEqual(ready.missing.map((m) => m.question_id), [q2]);
    assert.deepEqual(env.db.get("SELECT state, rev FROM rounds WHERE id = ?", f.round_id), round_before, "라운드 상태·rev 불변");
    assert.deepEqual(env.db.get("SELECT status, rev FROM stages WHERE id = ?", f.stage_id), stage_before, "단계 상태·rev 불변");
  });
});

test("[신규] 개별 제출: 항목이 둘 이상이거나 0개면 거부한다", async () => {
  await with_api(async (env) => {
    const f = await required_form(env);
    const [q1, q2] = f.ids;
    const sig = state_signature(env.db);
    const e = await rejects_api(submit(env, f.set.set_id, [A(q1!), A(q2!)], "one-2", { mode: "single" }), "invalid_payload");
    assert.equal((e.details as any)?.reason, "single_requires_one_item");
    await rejects_api(submit(env, f.set.set_id, [], "one-0", { mode: "single" }), "invalid_payload");
    assert.equal(state_signature(env.db), sig);
  });
});

test("[신규] API 개별 제출: 201 + form_complete=false + missing_required, 모든 필수가 이미 채워졌으면 true", async () => {
  await with_api(async (env) => {
    const f = await required_form(env);
    const [q1, q2] = f.ids;
    const first = assert_ok(await api_submit(env, f.set.set_id, [A(q1!)], { mode: "single" }), 201);
    assert.equal(first.submission.state, "accepted");
    assert.equal(first.answers.length, 1);
    assert.equal(first.form_complete, false);
    assert.deepEqual(first.missing_required, [q2]);
    const last = assert_ok(await api_submit(env, f.set.set_id, [A(q2!, "c")], { mode: "single" }), 201);
    assert.equal(last.form_complete, true, "남은 필수가 없으면 사실대로 true");
    assert.deepEqual(last.missing_required, []);
  });
});

test("[회귀] 개별 제출은 사람만: 에이전트 토큰은 403 human_required, 아무것도 쓰지 않는다", async () => {
  await with_api(async (env) => {
    const f = await required_form(env);
    const { make_agent } = await import("./helpers/api_env.ts");
    const agent = await make_agent(env, "single-agent");
    const sig = state_signature(env.db);
    assert_final_error(
      await call(env, { method: "POST", path: P(env, "/submissions"), auth: { token: agent.token }, body: { set_id: f.set.set_id, mode: "single", answers: [A(f.ids[0]!)] } }),
      403,
      "human_required",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

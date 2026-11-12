/**
 * SEL-90 U2a — 질문별 의견: question.comment_add, POST P/threads, POST P/threads/{t}/messages (tester, 작성 모드).
 * 구현 전에는 명령이 없고 두 라우트가 501 not_supported 라서 실패하는 것이 정상.
 *
 * 정한 이름·모양:
 *   명령  question.comment_add {question_id, body_md, question_version_id?, thread_id?, reply_to?, run_id?, lease_id?, fence?}
 *         thread_id 가 없으면 새 스레드(context_kind='question_comment', target = 그 질문의 (지정 또는 현재) 버전, thread_versions state=open)
 *         + 첫 메시지(messages.submission_id = NULL, message_versions state=published)를 한 tx 로 쓴다.
 *         thread_id 가 있으면 그 스레드(같은 프로젝트·같은 질문의 question_comment 스레드)에 메시지만 더한다.
 *         결과 {project_id, question_id, thread_id, message_id, message_version_id, thread_created}.
 *   POST P/threads    {target_object_id: <질문 id>, target_version_id?, context_kind: "question_comment", initial_message: {body_md}, run_id?, lease_id?, fence?}
 *         → 201 data {thread:{id, state:"open"}, message:{id, version_no:"1"}}.  context_kind "annotation" 은 U4a 몫이라
 *         이 이슈에서는 501 not_supported(쓰기 없음), 그 밖의 값은 422 validation_failed target $.body.context_kind.
 *   POST P/threads/{t}/messages  {body_md, reply_to?, run_id?, lease_id?, fence?} → 201 data {message:{id, version_no:"1", thread_id}}
 *   읽기  GET P/objects/{message}/versions/{v} → content {thread_id, body_md, state, reply_to}
 *         GET P/objects/{thread}/versions/{v}  → content {target_object_id, target_version_id, context_kind, state}
 *         GET P/workspace → records.comments.count 가 메시지 수.
 *   섞이지 않음: 의견은 answers/answer_versions/submissions 를 만들지 않고, allow_comment_as_answer 질문이어도 필수를 채우지 않는다.
 *   권한: 사람 소유자, 리스를 쥔 에이전트(run:submit) — 행위자는 토큰의 행위자. 리스 없는 에이전트는 forbidden.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { resume_ready } from "../scripts/pes_core/questions.ts";
import { agent_claims, assert_ok, call, make_agent, with_api } from "./helpers/api_env.ts";
import { P, assert_final_error } from "./helpers/api_flow.ts";
import { add_agent, agent_ctx, rejects_api } from "./helpers/questions_env.ts";
import { second_project } from "./helpers/blob_env.ts";
import {
  answer_version_count,
  api_submit_ok,
  cmd,
  comment_messages,
  current_answer,
  current_row,
  history_counts,
  make_form,
  owner_get,
  owner_post,
  single_spec,
  text_spec,
} from "./helpers/sel90_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

// ---------------------------------------------------------------------------
// 명령

test("question.comment_add: 새 스레드 + 첫 메시지를 한 tx 로 쓴다 (답·제출은 만들지 않는다)", async () => {
  {
    await with_api(async (env) => {
      const f = await make_form(env, [single_spec("의견 질문")]);
      const q = f.ids[0]!;
      const before = history_counts(env.db);
      const out = await cmd(env, "c-1", "question.comment_add", { question_id: q, body_md: "이 질문은 범위가 모호합니다." });
      const r = out.result as any;
      assert.equal(r.question_id, q);
      assert.equal(r.thread_created, true);
      const after = history_counts(env.db);
      assert.equal(after.threads - before.threads, 1);
      assert.equal(after.messages - before.messages, 1);
      assert.equal(after.message_versions - before.message_versions, 1);
      assert.equal(after.mutation_commits - before.mutation_commits, 1, "한 tx = 영수증 하나");
      assert.equal(after.answers, before.answers);
      assert.equal(after.answer_versions, before.answer_versions);
      assert.equal(after.submissions, before.submissions, "의견은 제출이 아니다");
      const rows = comment_messages(env.db, q);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.body_md, "이 질문은 범위가 모호합니다.");
      assert.equal(rows[0]!.state, "published");
      assert.equal(rows[0]!.context_kind, "question_comment");
      assert.equal(rows[0]!.actor_id, env.p.actor_id);
      assert.equal(rows[0]!.submission_id, null);
      const thread = env.db.get<{ target_version_id: string }>("SELECT target_version_id FROM threads WHERE object_id = ?", r.thread_id);
      assert.equal(thread?.target_version_id, current_row(env.db, q).version_id, "스레드는 의견을 쓴 때의 질문 버전을 가리킨다");
      const tv = env.db.get<{ state: string }>("SELECT state FROM thread_versions WHERE object_id = ?", r.thread_id);
      assert.equal(tv?.state, "open");
    });
  }
});

test("question.comment_add: 같은 스레드에 이어 쓰고(reply_to 가능), 질문을 고친 뒤에도 옛 버전에 묶인 스레드는 그대로다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("의견 질문")]);
    const q = f.ids[0]!;
    const v1 = current_row(env.db, q).version_id;
    const first = (await cmd(env, "c-1", "question.comment_add", { question_id: q, body_md: "첫 의견" })).result as any;
    const second = (await cmd(env, "c-2", "question.comment_add", { question_id: q, thread_id: first.thread_id, body_md: "이어 쓰기", reply_to: first.message_id })).result as any;
    assert.equal(second.thread_created, false);
    assert.equal(second.thread_id, first.thread_id);
    assert.notEqual(second.message_id, first.message_id);
    const reply = env.db.get<{ reply_to: string }>("SELECT reply_to FROM messages WHERE object_id = ?", second.message_id);
    assert.equal(reply?.reply_to, first.message_id);

    await cmd(env, "rv", "question.revise", { question_id: q, text: "고친 문구" });
    const third = (await cmd(env, "c-3", "question.comment_add", { question_id: q, body_md: "고친 뒤 새 의견" })).result as any;
    assert.equal(third.thread_created, true, "스레드 id 없이 쓰면 새 스레드");
    const t1 = env.db.get<{ target_version_id: string }>("SELECT target_version_id FROM threads WHERE object_id = ?", first.thread_id);
    const t3 = env.db.get<{ target_version_id: string }>("SELECT target_version_id FROM threads WHERE object_id = ?", third.thread_id);
    assert.equal(t1?.target_version_id, v1, "옛 스레드는 옛 버전에 그대로");
    assert.equal(t3?.target_version_id, current_row(env.db, q).version_id);
    assert.equal(comment_messages(env.db, q).length, 3);
  });
});

test("question.comment_add: 빈 글·공백만·외톨이 서러게이트·모르는 필드는 invalid_payload, 없는 질문·스레드·다른 프로젝트는 not_found, 아무것도 쓰지 않는다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("의견 질문"), single_spec("다른 질문")]);
    const [q, other_q] = f.ids;
    const thread = ((await cmd(env, "c-0", "question.comment_add", { question_id: other_q!, body_md: "다른 질문 의견" })).result as any).thread_id;
    const foreign = await second_project(env, "synthetic-sel90-d");
    const foreign_ctx = (k: string) => ({ project_id: foreign.project_id, actor_id: foreign.actor_id, via: "cli" as const, client_request_id: k });
    const sig = state_signature(env.db);
    for (const body_md of ["", "   \n\t", "\ud800"]) {
      await rejects_api(cmd(env, `bad-${body_md.length}`, "question.comment_add", { question_id: q!, body_md }), "invalid_payload");
    }
    await rejects_api(cmd(env, "bad-field", "question.comment_add", { question_id: q!, body_md: "x", surprise: 1 }), "invalid_payload");
    await rejects_api(cmd(env, "no-q", "question.comment_add", { question_id: "no-such-question", body_md: "x" }), "not_found");
    await rejects_api(cmd(env, "no-t", "question.comment_add", { question_id: q!, thread_id: "no-such-thread", body_md: "x" }), "not_found");
    await rejects_api(cmd(env, "wrong-q", "question.comment_add", { question_id: q!, thread_id: thread, body_md: "다른 질문의 스레드에 쓰기" }), "not_found", "conflict", "invalid_payload");
    await rejects_api(env.service.execute(foreign_ctx("fx"), "question.comment_add", { question_id: q!, body_md: "x" }), "not_found");
    await rejects_api(cmd(env, "bad-ver", "question.comment_add", { question_id: q!, question_version_id: current_row(env.db, other_q!).version_id, body_md: "x" }), "not_found", "invalid_payload", "conflict");
    assert.equal(state_signature(env.db), sig, "거부된 요청은 행도 영수증도 사건도 남기지 않는다");
  });
});

test("question.comment_add: 에이전트는 리스가 있어야 한다 (행위자는 에이전트), 같은 키는 재생", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("의견 질문")]);
    const q = f.ids[0]!;
    const agent = add_agent(env, "agent-sel90-c");
    const sig = state_signature(env.db);
    await rejects_api(env.service.execute(agent_ctx(agent, "ag-1"), "question.comment_add", { question_id: q, body_md: "리스 없음" }), "forbidden");
    assert.equal(state_signature(env.db), sig);

    const first = await cmd(env, "idem", "question.comment_add", { question_id: q, body_md: "멱등 의견" });
    const n = history_counts(env.db);
    const again = await cmd(env, "idem", "question.comment_add", { question_id: q, body_md: "멱등 의견" });
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, first.result);
    assert.deepEqual(history_counts(env.db), n);
    await rejects_api(cmd(env, "idem", "question.comment_add", { question_id: q, body_md: "다른 내용" }), "idempotency_key_reuse");
  });
});

// ---------------------------------------------------------------------------
// 답과 섞이지 않음

test("의견은 답이 아니다: 답 버전·현재 답은 그대로이고, allow_comment_as_answer 질문이어도 필수/재개 준비를 채우지 않는다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("허용 질문", { allow_comment_as_answer: true }), single_spec("답한 질문")]);
    const [q1, q2] = f.ids;
    await api_submit_ok(env, f.set.set_id, [{ question_id: q2, value: "a" }]);
    const answer_before = current_answer(env.db, q2!);
    const versions_before = answer_version_count(env.db);

    await cmd(env, "c-1", "question.comment_add", { question_id: q1!, body_md: "답이 아니라 의견" });
    await cmd(env, "c-2", "question.comment_add", { question_id: q2!, body_md: "답한 뒤의 의견" });

    assert.equal(answer_version_count(env.db), versions_before, "의견이 답 버전을 만들지 않는다");
    assert.deepEqual(current_answer(env.db, q2!), answer_before, "이미 낸 답은 그대로");
    assert.equal(current_answer(env.db, q1!), null, "허용 질문이어도 스레드 의견은 답이 아니다");
    const ready = resume_ready(env.db, env.p.project_id, f.round_id);
    assert.equal(ready.ready, false);
    assert.deepEqual(ready.missing.map((m) => [m.question_id, m.reason]), [[q1, "unanswered"]]);
  });
});

test("읽기에서도 섞이지 않는다: 답 버전 읽기에는 스레드 의견이 없고, 의견 읽기에는 답 값이 없다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("읽기 질문")]);
    const q = f.ids[0]!;
    const sub = await api_submit_ok(env, f.set.set_id, [{ question_id: q, value: "b" }]);
    const answer_object = env.db.get<{ object_id: string }>("SELECT object_id FROM answer_versions WHERE version_id = ?", sub.answers[0].answer_version_id)!.object_id;
    const written = (await cmd(env, "c-1", "question.comment_add", { question_id: q, body_md: "읽기 시험 의견" })).result as any;

    const answer_read = assert_ok(await owner_get(env, `/objects/${answer_object}/versions/${sub.answers[0].answer_version_id}`));
    assert.equal(answer_read.kind, "answer");
    assert.equal(answer_read.content.value, "b");
    assert.equal(answer_read.content.comment, null, "제출과 함께 보낸 의견만 답 읽기에 붙는다 — 따로 쓴 스레드 의견은 아니다");
    assert.doesNotMatch(JSON.stringify(answer_read), /읽기 시험 의견/);

    const message_version = env.db.get<{ version_id: string }>("SELECT version_id FROM message_versions WHERE object_id = ?", written.message_id)!.version_id;
    const message_read = assert_ok(await owner_get(env, `/objects/${written.message_id}/versions/${message_version}`));
    assert.equal(message_read.kind, "message");
    assert.equal(message_read.content.body_md, "읽기 시험 의견");
    assert.equal(message_read.content.thread_id, written.thread_id);
    assert.equal(message_read.content.state, "published");
    assert.ok(!("value" in message_read.content), "의견 읽기에는 답 값이 없다");
    assert.ok(!("question_version_id" in message_read.content && "value" in message_read.content));

    const thread_version = env.db.get<{ version_id: string }>("SELECT version_id FROM thread_versions WHERE object_id = ?", written.thread_id)!.version_id;
    const thread_read = assert_ok(await owner_get(env, `/objects/${written.thread_id}/versions/${thread_version}`));
    assert.equal(thread_read.kind, "thread");
    assert.equal(thread_read.content.context_kind, "question_comment");
    assert.equal(thread_read.content.target_object_id, q);
    assert.equal(thread_read.content.state, "open");
  });
});

test("작업 공간 records.comments.count 는 메시지 수를 따라가고, 제출과 함께 보낸 의견도 센다 (답 수와 따로)", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("세는 질문", { allow_comment_as_answer: true })]);
    const q = f.ids[0]!;
    const count = async () => assert_ok(await owner_get(env, "/workspace")).records.comments.count as number;
    const base = await count();
    await cmd(env, "c-1", "question.comment_add", { question_id: q, body_md: "첫 의견" });
    assert.equal(await count(), base + 1);
    await api_submit_ok(env, f.set.set_id, [{ question_id: q, value: "a", comment: "제출 때 의견" }]);
    assert.equal(await count(), base + 2);
    assert.equal(answer_version_count(env.db), 1);
    assert.equal(assert_ok(await owner_get(env, "/workspace")).records.empty, false);
  });
});

// ---------------------------------------------------------------------------
// API 라우트

test("POST P/threads (question_comment): 201, 스레드 + 첫 메시지, 답은 만들지 않는다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("API 의견 질문")]);
    const q = f.ids[0]!;
    const before = history_counts(env.db);
    const res = await owner_post(env, "/threads", {
      format_version: "1.0",
      target_object_id: q,
      context_kind: "question_comment",
      initial_message: { body_md: "API 로 쓴 의견" },
    });
    const data = assert_ok(res, 201);
    assert.equal(res.json.replayed, false);
    assert.equal(typeof data.thread.id, "string");
    assert.equal(data.thread.state, "open");
    assert.equal(typeof data.message.id, "string");
    assert.equal(data.message.version_no, "1");
    const after = history_counts(env.db);
    assert.equal(after.threads - before.threads, 1);
    assert.equal(after.messages - before.messages, 1);
    assert.equal(after.answer_versions, before.answer_versions);
    assert.equal(after.mutation_commits - before.mutation_commits, 1);
    assert.equal(comment_messages(env.db, q)[0]!.body_md, "API 로 쓴 의견");
    const t = env.db.get<{ target_version_id: string }>("SELECT target_version_id FROM threads WHERE object_id = ?", data.thread.id);
    assert.equal(t?.target_version_id, current_row(env.db, q).version_id, "target_version_id 를 안 주면 현재 질문 버전");
  });
});

test("POST P/threads: 잘못된 요청은 거부하고 쓰지 않는다 (키 없음 400, 빈 글 422, 모르는 context_kind 422, annotation 501, 없는 질문 404, 모르는 필드 400, 자격 401/403)", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("API 의견 질문")]);
    const q = f.ids[0]!;
    const ok_body = { target_object_id: q, context_kind: "question_comment", initial_message: { body_md: "x" } };
    const sig = state_signature(env.db);
    assert_final_error(await call(env, { method: "POST", path: P(env, "/threads"), auth: "owner", body: ok_body, key: null }), 400, "invalid_payload", { target: /idempotency-key/i });
    assert_final_error(await owner_post(env, "/threads", { ...ok_body, initial_message: { body_md: "  " } }), 422, "validation_failed", { target: "$.body.initial_message.body_md" });
    assert_final_error(await owner_post(env, "/threads", { ...ok_body, context_kind: "bogus" }), 422, "validation_failed", { target: "$.body.context_kind" });
    assert_final_error(await owner_post(env, "/threads", { ...ok_body, context_kind: "annotation" }), 501, "not_supported");
    assert_final_error(await owner_post(env, "/threads", { ...ok_body, target_object_id: "no-such-question" }), 404, "not_found");
    assert_final_error(await owner_post(env, "/threads", { ...ok_body, surprise: 1 }), 400, "invalid_payload");
    assert_final_error(await owner_post(env, "/threads", { target_object_id: q, context_kind: "question_comment" }), 400, "invalid_payload", { target: "$.body.initial_message" });
    assert_final_error(await call(env, { method: "POST", path: P(env, "/threads"), body: ok_body }), 401, "unauthenticated");
    const reader = await make_agent(env, "reader", ["context:read"]);
    assert_final_error(await call(env, { method: "POST", path: P(env, "/threads"), auth: { token: reader.token }, body: ok_body }), 403, "forbidden");
    assert.equal(state_signature(env.db), sig);
  });
});

test("POST P/threads/{t}/messages: 201, 같은 스레드에 메시지가 붙고 version_no 는 1, 키 재생·다른 본문 거부", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("API 의견 질문")]);
    const q = f.ids[0]!;
    const t = assert_ok(await owner_post(env, "/threads", { target_object_id: q, context_kind: "question_comment", initial_message: { body_md: "첫 글" } }), 201);
    const res = await owner_post(env, `/threads/${t.thread.id}/messages`, { body_md: "이어 쓴 글", reply_to: t.message.id }, "msg-1");
    const data = assert_ok(res, 201);
    assert.equal(data.message.version_no, "1");
    assert.equal(data.message.thread_id, t.thread.id);
    assert.deepEqual(comment_messages(env.db, q).map((m) => m.body_md), ["첫 글", "이어 쓴 글"]);

    const sig = state_signature(env.db);
    const again = await owner_post(env, `/threads/${t.thread.id}/messages`, { body_md: "이어 쓴 글", reply_to: t.message.id }, "msg-1");
    assert.equal(again.json.replayed, true);
    assert.deepEqual(again.json.data, data);
    assert_final_error(await owner_post(env, `/threads/${t.thread.id}/messages`, { body_md: "다른 본문" }, "msg-1"), 409, "idempotency_key_reuse");
    assert_final_error(await owner_post(env, "/threads/no-such-thread/messages", { body_md: "x" }), 404, "not_found");
    assert_final_error(await owner_post(env, `/threads/${t.thread.id}/messages`, { body_md: "" }), 422, "validation_failed", { target: "$.body.body_md" });
    assert_final_error(await owner_post(env, `/threads/${t.thread.id}/messages`, { body_md: "x", surprise: 1 }), 400, "invalid_payload");
    assert.equal(state_signature(env.db), sig);
  });
});

test("API: 리스를 쥔 에이전트는 의견을 쓸 수 있고 행위자는 에이전트다, 리스 없는 에이전트는 403", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("에이전트 의견 질문")]);
    const q = f.ids[0]!;
    const agent = await make_agent(env, "commenter");
    const lease = await agent_claims(env, agent);
    const guard = { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence };
    const body = { target_object_id: q, context_kind: "question_comment", initial_message: { body_md: "에이전트 의견" } };
    assert_final_error(await call(env, { method: "POST", path: P(env, "/threads"), auth: { token: agent.token }, body }), 403, "forbidden");
    const data = assert_ok(await call(env, { method: "POST", path: P(env, "/threads"), auth: { token: agent.token }, body: { ...body, ...guard } }), 201);
    const rows = comment_messages(env.db, q);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.actor_id, agent.actor_id, "행위자는 토큰의 행위자");
    const more = await call(env, { method: "POST", path: P(env, `/threads/${data.thread.id}/messages`), auth: { token: agent.token }, body: { body_md: "이어서", ...guard } });
    assert.equal(assert_ok(more, 201).message.version_no, "1");
    assert.equal(answer_version_count(env.db), 0, "에이전트 의견도 답이 아니다");
  });
});

test("capabilities: P/threads 와 P/threads/{t}/messages 는 지원 목록으로 옮겨가고, resolutions 는 계속 미지원이다", async () => {
  await with_api(async (env) => {
    const caps = assert_ok(await call(env, { method: "GET", path: "/api/v1/capabilities", auth: "owner" }));
    for (const route of ["POST /api/v1/projects/{id}/threads", "POST /api/v1/projects/{id}/threads/{t}/messages"]) {
      assert.ok(caps.routes.includes(route), `routes 에 ${route}`);
      assert.ok(!caps.unsupported.includes(route), `${route} 는 더 이상 미지원이 아니다`);
    }
    assert.ok(caps.unsupported.includes("POST /api/v1/projects/{id}/threads/{t}/resolutions"), "해결은 U4 몫이라 미지원 그대로");
    const res = await owner_post(env, "/threads/no-such-thread/resolutions", {});
    assert.equal(res.status, 501);
  });
});

test("텍스트 질문(text_spec)에도 의견 스레드가 붙는다 — 질문 종류와 무관", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [text_spec("글 질문")]);
    await cmd(env, "c-1", "question.comment_add", { question_id: f.ids[0]!, body_md: "글 질문 의견" });
    assert.equal(comment_messages(env.db, f.ids[0]!).length, 1);
  });
});

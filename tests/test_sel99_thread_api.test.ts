/**
 * SEL-99 U4a — HTTP: POST P/threads(annotation) · P/threads/{t}/messages · P/threads/{t}/resolutions · P/threads/{t}/reanchor · P/followups · P/followups/{f}/apply
 *   와 읽기 GET P/threads · P/threads/{t} · P/followups (tester, 작성 모드).
 * 구현 전에는 annotation 이 501, 나머지 라우트가 501/404 라서 실패하는 것이 정상이다. 명령 쪽 의미는 test_sel99_annotation / _anchor_status / _followup 이 시험한다.
 * 이 파일은 HTTP 모양·상태 코드·권한·멱등·읽기 경로를 본다. 문서 계약 그대로의 장면은 test_sel99_fixture_contract.test.ts.
 *
 * 있던 것(회귀 가드): 질문 의견(question_comment)용 POST P/threads · P/threads/{t}/messages 는 SEL-90 그대로 — 아래 "회귀" 시험.
 *
 * 정한 해석(HTTP — 문서 픽스처 docs/plan/fixtures/api-v1/{threads,thread-messages,thread-resolutions,followup-apply}.json 을 따르고, 없는 것은 스스로 정함):
 *   POST P/threads  {format_version?, target_object_id, target_version_id?, context_kind:'annotation', anchor:{exact_quote, prefix?, suffix?, start_cp?, end_cp?}, initial_message:{body_md}, run_id?, lease_id?, fence?}
 *     → 201 data {thread:{id, state:'open', anchor_id, anchor_status}, message:{id, version_no:'1'}}.  anchor 는 annotation 에만(없으면 400 invalid_payload target $.body.anchor, question_comment 에 있으면 400).
 *     인용문이 대상 버전에 없음 → 422 validation_failed target $.body.anchor.exact_quote details {reason:'quote_not_found', target_version_id} next_action choose_exact_quote.
 *     같은 인용문이 여러 곳인데 위치·문맥으로 못 가름 → 같은 모양, details.reason 'ambiguous_quote'. 위치 길이 불일치 → 422 validation_failed target $.body.anchor.
 *     대상이 글이 아님(질문 등) → 422 validation_failed target $.body.target_object_id. 없는 대상 404. 빈 첨언 422 target $.body.initial_message.body_md.
 *   POST P/threads/{t}/messages  annotation 스레드 → 201 data {thread_id, message:{id, version_no, author_actor_id}} (문서 픽스처 모양; question_comment 스레드는 SEL-90 모양 그대로).
 *     resolved/archived 스레드 → 409 thread_closed target $.path.thread_id details {thread_id, state} next_action open_new_thread.
 *   POST P/threads/{t}/resolutions  {format_version?, resolution, reason, followup?:{kind, description?, proposed_body_md?, target_version_id?, target_stage_id?, target_round_id?}}  **소유자 세션만**(토큰은 403 human_required)
 *     → 201 data {thread:{id, state:'resolved'}, followup:{id, state:'proposed'}|null, applied:false, note:'해결됨과 반영됨은 다릅니다.'}.  이미 해결됨 → 409 already_resolved target $.path.thread_id
 *     details {thread_id, state, resolution_id} next_action reread_thread.  reason 없음 400 invalid_payload, 빈 reason 422 validation_failed target $.body.reason, 모르는 resolution 422 target $.body.resolution.
 *   POST P/threads/{t}/reanchor  {version_id?} 재판정(첨언 쓰기 권한자) / {version_id?, start_cp, end_cp} 다시 붙이기(**소유자 세션만**, 토큰은 403 human_required)
 *     → 201 data {thread_id, anchor:{id, status, start_cp, end_cp, candidates, evaluated_version_id, resolution_id, confirmed_by_actor_id}}.
 *   POST P/followups  {origin_thread_id, kind, description, proposed_body_md?, base_version_id?, target_stage_id?, target_round_id?, run_id?…} 소유자 또는 리스를 쥔 에이전트(제안만)
 *     → 201 data {followup:{id, kind, state:'proposed', version_no:'1', base_version_id}}.
 *   POST P/followups/{f}/apply  {format_version?, base_version_id, expected_rev}  **소유자 세션만** → 200 data {followup:{id, state, applied_tx_id, result_version_id}, thread:{id, state}}.
 *     기반 불일치 → 409 basis_changed target $.body.base_version_id details {expected, current, current_rev} next_action reread_followup. expected_rev 불일치 → 409 rev_conflict.
 *   GET P/threads?target_object_id=&context_kind=&state=  → data.threads[] {id, context_kind, state, target_object_id, target_version_id, message_count(number), anchor_status|null, summary}
 *   GET P/threads/{t} → data {thread:{id, context_kind, state, target_object_id, target_version_id, summary, resolution|null{resolution, reason, followup_id|null, message_version_id}},
 *        anchor|null{id, exact_quote, prefix, suffix, text_format_version, start_cp, end_cp, target_version_id, status, current{evaluated_version_id, status, start_cp|null, end_cp|null, text|null, candidates, confirmed_by_actor_id|null}},
 *        messages[]{id, version_id, body_md, state, reply_to|null, actor_id, created_at}, followups[]{id, kind, state}}.  anchor.current 는 글의 **현재 버전** 기준 판정(읽기는 쓰지 않는다).
 *   GET P/followups?thread_id=&state=&kind= → data.followups[] {id, kind, state, description, version_no, origin_thread_id, origin_version_id, base_version_id|null, proposed_version_id|null,
 *        proposed_body_md|null, result_version_id|null, applied_tx_id|null, confirmed_by_actor_id|null, target_stage_id|null}.
 *   읽기 권한: context:read 토큰 또는 소유자. 무자격 401, 범위 없는 토큰 403 forbidden, 모르는 프로젝트·스레드·다른 프로젝트의 스레드 404. 모르는 필터 값 400 invalid_payload.
 *   쓰기 공통: Idempotency-Key 필수(없으면 400), 같은 키·같은 본문 replayed:true, 다른 본문 409 idempotency_key_reuse, 무자격 401, 알 수 없는 필드 400, 거절은 아무것도 안 쓴다.
 *   쓰기 권한: 소유자 세션, 또는 run:submit 범위 + 리스(run_id·lease_id·fence)를 쥔 에이전트 토큰(제안·첨언·답글만). 리스 없는 에이전트 403 forbidden.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { OPENAPI_PATH, agent_claims, assert_error, assert_ok, call, make_agent, with_api, type ApiEnv, type Auth } from "./helpers/api_env.ts";
import { P, assert_final_error } from "./helpers/api_flow.ts";
import { create_object, add_artifact } from "../scripts/pes_core/content.ts";
import { ctx_for, second_project } from "./helpers/blob_env.ts";
import { stage_ids } from "./helpers/editions_env.ts";
import { single_spec } from "./helpers/questions_env.ts";
import { make_form } from "./helpers/sel90_env.ts";
import { state_signature } from "./helpers/state_signature.ts";
import {
  anchor_row,
  body_of,
  count_of,
  cp_find,
  current_version_of,
  followup_row,
  messages_of,
  resolutions_of,
  text_artifact,
  text_version,
  thread_row,
} from "./helpers/sel99_env.ts";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const DEC = /^(0|[1-9][0-9]*)$/;

const QUOTE = "정책 대안은 두 가지다.";
const PREFIX = "2장 합성 정책 분석에서 ";
const SUFFIX = " 첫 번째는 현행 유지다.";
const BODY = `머리글\n\n${PREFIX}${QUOTE}${SUFFIX}\n\n| 항목 | 값 |\n|---|---|\n| 가 | 1 |\n\n😀 이모지 뒤 문장입니다.`;
const NEW_BODY = `머리글\n\n${PREFIX}정책 대안은 두 가지이며 근거는 부록 A 에 있다.${SUFFIX}\n\n끝.`;

const post = (env: ApiEnv, rest: string, auth: Auth, body: unknown, key?: string) =>
  call(env, { method: "POST", path: P(env, rest), auth, body, ...(key === undefined ? {} : { key }) });
const get = (env: ApiEnv, rest: string, auth: Auth = "owner") => call(env, { method: "GET", path: P(env, rest), auth });

const anchor_body = (extra: Record<string, unknown> = {}) => ({ exact_quote: QUOTE, prefix: PREFIX, suffix: SUFFIX, ...cp_find(BODY, QUOTE), ...extra });

async function make_thread(env: ApiEnv, tag = "t", body = BODY) {
  const art = await text_artifact(env, tag, body);
  const res = await post(env, "/threads", "owner", {
    format_version: "1.0",
    target_object_id: art.object_id,
    target_version_id: art.version_id,
    context_kind: "annotation",
    anchor: anchor_body(),
    initial_message: { body_md: "이 문장의 근거를 더 설명해 주세요." },
  });
  const data = assert_ok(res, 201);
  return { art, data, thread_id: data.thread.id as string };
}

async function leased(env: ApiEnv, name: string) {
  const agent = await make_agent(env, name);
  const lease = await agent_claims(env, agent);
  return { agent, guard: { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence } };
}

// ---------------------------------------------------------------------------
// POST P/threads (annotation)

test("POST P/threads annotation: 201, 문서 픽스처 모양, 앵커·스레드·메시지·판정이 한 번에 저장된다", async () => {
  await with_api(async (env) => {
    const { art, data, thread_id } = await make_thread(env);
    assert.deepEqual(Object.keys(data.thread).sort(), ["anchor_id", "anchor_status", "id", "state"]);
    assert.deepEqual(Object.keys(data.message).sort(), ["id", "version_no"]);
    assert.equal(data.thread.state, "open");
    assert.equal(data.thread.anchor_status, "exact");
    assert.equal(data.message.version_no, "1");

    const t = thread_row(env.db, thread_id);
    assert.equal(t.context_kind, "annotation");
    assert.equal(t.anchor_id, data.thread.anchor_id);
    assert.equal(t.target_version_id, art.version_id);
    assert.equal(resolutions_of(env.db, data.thread.anchor_id).length, 1);
    assert.equal(messages_of(env.db, thread_id)[0]!.body_md, "이 문장의 근거를 더 설명해 주세요.");
    assert.equal(messages_of(env.db, thread_id)[0]!.actor_id, env.p.actor_id);
  });
});

test("POST P/threads annotation: target_version_id 없이도 된다(현재 버전), 키 재생·다른 본문 거부·키 없음 400", async () => {
  await with_api(async (env) => {
    const art = await text_artifact(env, "k", BODY);
    const body = { target_object_id: art.object_id, context_kind: "annotation", anchor: anchor_body(), initial_message: { body_md: "첨언" } };
    const first = await post(env, "/threads", "owner", body, "an-key");
    const data = assert_ok(first, 201);
    assert.equal(thread_row(env.db, data.thread.id).target_version_id, art.version_id);
    const sig = state_signature(env.db);
    const again = await post(env, "/threads", "owner", body, "an-key");
    assert.equal(again.json.replayed, true);
    assert.deepEqual(again.json.data, data);
    assert_final_error(await post(env, "/threads", "owner", { ...body, initial_message: { body_md: "다른 첨언" } }, "an-key"), 409, "idempotency_key_reuse");
    assert_final_error(await call(env, { method: "POST", path: P(env, "/threads"), auth: "owner", body, key: null }), 400, "invalid_payload", { target: /idempotency-key/i });
    assert.equal(state_signature(env.db), sig);
  });
});

test("POST P/threads annotation 거절: 인용문 없음 422 quote_not_found, 여러 곳 422 ambiguous_quote, 길이 불일치, 앵커 누락, 질문 대상, 없는 대상, 빈 글 — 쓰지 않는다", async () => {
  await with_api(async (env) => {
    const art = await text_artifact(env, "bad", `${BODY}\n\n결론은 A다. 그리고 다시 결론은 A다.`);
    const f = await make_form(env, [single_spec("질문")]);
    const ok = { target_object_id: art.object_id, target_version_id: art.version_id, context_kind: "annotation", anchor: anchor_body(), initial_message: { body_md: "x" } };
    const sig = state_signature(env.db);

    const missing = assert_final_error(await post(env, "/threads", "owner", { ...ok, anchor: { exact_quote: "이 문장은 합성 본문에 없다.", start_cp: 200, end_cp: 214 } }), 422, "validation_failed", { target: "$.body.anchor.exact_quote", next_action: "choose_exact_quote" });
    assert.equal(missing.details.reason, "quote_not_found");
    assert.equal(missing.details.target_version_id, art.version_id);
    assert.deepEqual(Object.keys(missing.details).sort(), ["reason", "target_version_id"]);

    const amb = assert_final_error(await post(env, "/threads", "owner", { ...ok, anchor: { exact_quote: "결론은 A다." } }), 422, "validation_failed", { target: "$.body.anchor.exact_quote", next_action: "choose_exact_quote" });
    assert.equal(amb.details.reason, "ambiguous_quote");

    assert_final_error(await post(env, "/threads", "owner", { ...ok, anchor: { exact_quote: QUOTE, start_cp: 5, end_cp: 7 } }), 422, "validation_failed", { target: "$.body.anchor" });
    assert_final_error(await post(env, "/threads", "owner", { ...ok, anchor: undefined }), 400, "invalid_payload", { target: "$.body.anchor" });
    assert_final_error(await post(env, "/threads", "owner", { ...ok, anchor: { exact_quote: QUOTE, color: "red" } }), 400, "invalid_payload");
    assert_final_error(await post(env, "/threads", "owner", { ...ok, anchor: { exact_quote: "\ud800" } }), 400, "invalid_payload");
    assert_final_error(await post(env, "/threads", "owner", { ...ok, target_object_id: f.ids[0]!, target_version_id: undefined }), 422, "validation_failed", { target: "$.body.target_object_id" });
    assert_final_error(await post(env, "/threads", "owner", { ...ok, target_object_id: "no-such-object", target_version_id: undefined }), 404, "not_found");
    assert_final_error(await post(env, "/threads", "owner", { ...ok, target_version_id: "no-such-version" }), 404, "not_found");
    assert_final_error(await post(env, "/threads", "owner", { ...ok, initial_message: { body_md: "  " } }), 422, "validation_failed", { target: "$.body.initial_message.body_md" });
    assert_final_error(await post(env, "/threads", "owner", { ...ok, surprise: 1 }), 400, "invalid_payload");
    // question_comment 에는 앵커가 없다
    assert_final_error(await post(env, "/threads", "owner", { target_object_id: f.ids[0]!, context_kind: "question_comment", anchor: anchor_body(), initial_message: { body_md: "x" } }), 400, "invalid_payload", { target: "$.body.anchor" });
    assert.equal(state_signature(env.db), sig);
  });
});

test("POST P/threads annotation 권한: 무자격 401, 범위 없는 토큰 403, 리스 없는 에이전트 403, 리스를 쥔 에이전트는 201(행위자는 에이전트)", async () => {
  await with_api(async (env) => {
    const art = await text_artifact(env, "auth", BODY);
    const body = { target_object_id: art.object_id, context_kind: "annotation", anchor: anchor_body(), initial_message: { body_md: "첨언" } };
    const reader = await make_agent(env, "reader", ["context:read"]);
    const { agent, guard } = await leased(env, "annotator");
    const sig = state_signature(env.db);
    assert_final_error(await post(env, "/threads", "none", body), 401, "unauthenticated");
    assert_final_error(await post(env, "/threads", { token: reader.token }, body), 403, "forbidden");
    assert_final_error(await post(env, "/threads", { token: agent.token }, body), 403, "forbidden");
    assert.equal(state_signature(env.db), sig);
    const data = assert_ok(await post(env, "/threads", { token: agent.token }, { ...body, ...guard }), 201);
    assert.equal(messages_of(env.db, data.thread.id)[0]!.actor_id, agent.actor_id);
    assert.equal(thread_row(env.db, data.thread.id).state, "open");
  });
});

test("회귀(SEL-90): question_comment 스레드는 그대로 — 질문 의견 모양과 답글 모양이 안 바뀐다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("회귀 질문")]);
    const q = f.ids[0]!;
    const c = assert_ok(await post(env, "/threads", "owner", { target_object_id: q, context_kind: "question_comment", initial_message: { body_md: "질문 의견" } }), 201);
    assert.deepEqual(Object.keys(c.thread).sort(), ["id", "state"]);
    assert.deepEqual(Object.keys(c.message).sort(), ["id", "thread_id", "version_no"]);
    const r = assert_ok(await post(env, `/threads/${c.thread.id}/messages`, "owner", { body_md: "이어서" }), 201);
    assert.deepEqual(Object.keys(r.message).sort(), ["id", "thread_id", "version_no"]);
  });
});

test("질문 의견 스레드와 첨언 스레드는 목록에서 섞이지 않는다(context_kind 로 가른다)", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("회귀 질문")]);
    const q = f.ids[0]!;
    const c = assert_ok(await post(env, "/threads", "owner", { target_object_id: q, context_kind: "question_comment", initial_message: { body_md: "질문 의견" } }), 201);
    const art = await text_artifact(env, "reg", BODY);
    await post(env, "/threads", "owner", { target_object_id: art.object_id, context_kind: "annotation", anchor: anchor_body(), initial_message: { body_md: "첨언" } });
    const list = assert_ok(await get(env, "/threads?context_kind=question_comment"));
    assert.deepEqual(list.threads.map((t: any) => t.id), [c.thread.id]);
  });
});

// ---------------------------------------------------------------------------
// POST P/threads/{t}/messages (annotation)

test("POST P/threads/{t}/messages annotation: 201 문서 픽스처 모양, reply_to, 키 재생, 닫힌 스레드는 409 thread_closed", async () => {
  await with_api(async (env) => {
    const { thread_id, data: first } = await make_thread(env);
    const res = await post(env, `/threads/${thread_id}/messages`, "owner", { format_version: "1.0", body_md: "첨언에 대한 합성 답글입니다.", reply_to: first.message.id }, "msg-1");
    const data = assert_ok(res, 201);
    assert.deepEqual(Object.keys(data).sort(), ["message", "thread_id"]);
    assert.equal(data.thread_id, thread_id);
    assert.deepEqual(Object.keys(data.message).sort(), ["author_actor_id", "id", "version_no"]);
    assert.match(data.message.version_no, DEC);
    assert.equal(data.message.author_actor_id, env.p.actor_id);
    const msgs = messages_of(env.db, thread_id);
    assert.deepEqual(msgs.map((m) => m.body_md), ["이 문장의 근거를 더 설명해 주세요.", "첨언에 대한 합성 답글입니다."]);
    assert.equal(msgs[1]!.reply_to, first.message.id);

    const sig = state_signature(env.db);
    assert.equal((await post(env, `/threads/${thread_id}/messages`, "owner", { format_version: "1.0", body_md: "첨언에 대한 합성 답글입니다.", reply_to: first.message.id }, "msg-1")).json.replayed, true);
    assert_final_error(await post(env, `/threads/${thread_id}/messages`, "owner", { body_md: "다른 본문" }, "msg-1"), 409, "idempotency_key_reuse");
    assert_final_error(await post(env, `/threads/${thread_id}/messages`, "owner", { body_md: "" }), 422, "validation_failed", { target: "$.body.body_md" });
    assert_final_error(await post(env, "/threads/no-such-thread/messages", "owner", { body_md: "x" }), 404, "not_found");
    assert.equal(state_signature(env.db), sig);

    assert_ok(await post(env, `/threads/${thread_id}/resolutions`, "owner", { resolution: "none", reason: "닫는다." }), 201);
    const closed = assert_final_error(await post(env, `/threads/${thread_id}/messages`, "owner", { body_md: "닫힌 스레드에 남기는 합성 답글입니다.", reply_to: null }), 409, "thread_closed", { target: "$.path.thread_id", next_action: "open_new_thread" });
    assert.equal(closed.details.thread_id, thread_id);
    assert.equal(closed.details.state, "resolved");
  });
});

// ---------------------------------------------------------------------------
// resolutions · followups · apply

test("POST P/threads/{t}/resolutions: 사람이 해결하면 thread resolved + 후속 proposed, applied:false, 글은 그대로", async () => {
  await with_api(async (env) => {
    const { art, thread_id } = await make_thread(env);
    const res = await post(env, `/threads/${thread_id}/resolutions`, "owner", { format_version: "1.0", resolution: "edit_text", reason: "문장을 보강합니다.", followup: { kind: "edit_text", target_version_id: art.version_id } }, "res-1");
    const data = assert_ok(res, 201);
    assert.deepEqual(Object.keys(data).sort(), ["applied", "followup", "note", "thread"]);
    assert.deepEqual(data.thread, { id: thread_id, state: "resolved" });
    assert.deepEqual(Object.keys(data.followup).sort(), ["id", "state"]);
    assert.equal(data.followup.state, "proposed");
    assert.equal(data.applied, false);
    assert.equal(data.note, "해결됨과 반영됨은 다릅니다.");
    assert.equal(thread_row(env.db, thread_id).state, "resolved");
    assert.equal(followup_row(env.db, data.followup.id).state, "proposed");
    assert.equal(current_version_of(env.db, art.object_id), art.version_id);
    assert.equal(count_of(env.db, "reflection_entries"), 0, "해결은 반영 내역이 아니다");

    const sig = state_signature(env.db);
    assert.equal((await post(env, `/threads/${thread_id}/resolutions`, "owner", { format_version: "1.0", resolution: "edit_text", reason: "문장을 보강합니다.", followup: { kind: "edit_text", target_version_id: art.version_id } }, "res-1")).json.replayed, true);
    const again = assert_final_error(await post(env, `/threads/${thread_id}/resolutions`, "owner", { resolution: "none", reason: "또 닫기" }), 409, "already_resolved", { target: "$.path.thread_id", next_action: "reread_thread" });
    assert.equal(again.details.thread_id, thread_id);
    assert.equal(again.details.state, "resolved");
    assert.equal(typeof again.details.resolution_id, "string");
    assert.equal(state_signature(env.db), sig);
  });
});

test("POST P/threads/{t}/resolutions 거절: 사람만(토큰 403 human_required), 값·사유 오류, 없는 스레드 404, 무자격 401 — 쓰지 않는다", async () => {
  await with_api(async (env) => {
    const { thread_id } = await make_thread(env);
    const { agent, guard } = await leased(env, "resolver");
    const sig = state_signature(env.db);
    assert_final_error(await post(env, `/threads/${thread_id}/resolutions`, { token: agent.token }, { resolution: "none", reason: "에이전트가 닫기", ...guard }), 403, "human_required", { next_action: "use_owner_session" });
    assert_final_error(await post(env, `/threads/${thread_id}/resolutions`, "none", { resolution: "none", reason: "x" }), 401, "unauthenticated");
    assert_final_error(await post(env, `/threads/${thread_id}/resolutions`, "owner", { resolution: "deleted", reason: "x" }), 422, "validation_failed", { target: "$.body.resolution" });
    assert_final_error(await post(env, `/threads/${thread_id}/resolutions`, "owner", { resolution: "none" }), 400, "invalid_payload");
    assert_final_error(await post(env, `/threads/${thread_id}/resolutions`, "owner", { resolution: "none", reason: "  " }), 422, "validation_failed", { target: "$.body.reason" });
    assert_final_error(await post(env, `/threads/${thread_id}/resolutions`, "owner", { resolution: "edit_text", reason: "x", followup: { kind: "next_round_task", description: "d" } }), 422, "validation_failed", { target: "$.body.followup.kind" });
    assert_final_error(await post(env, `/threads/${thread_id}/resolutions`, "owner", { resolution: "none", reason: "x", surprise: 1 }), 400, "invalid_payload");
    assert_final_error(await post(env, "/threads/no-such-thread/resolutions", "owner", { resolution: "none", reason: "x" }), 404, "not_found");
    assert.equal(state_signature(env.db), sig);
    assert.equal(thread_row(env.db, thread_id).state, "open");
  });
});

test("해결 결과 4종은 읽기에서 그대로 보인다: GET P/threads/{t}.thread.resolution", async () => {
  await with_api(async (env) => {
    const stages = stage_ids(env.db, env.p.edition_id);
    const variants: Array<[string, Record<string, unknown> | undefined]> = [
      ["edit_text", { kind: "edit_text", description: "고친다", proposed_body_md: NEW_BODY }],
      ["next_round_task", { kind: "next_round_task", description: "다음에", target_stage_id: stages.research }],
      ["reopen_stage", { kind: "reopen_stage", description: "다시 연다", target_stage_id: stages.plan }],
      ["none", undefined],
    ];
    for (const [i, [resolution, followup]] of variants.entries()) {
      const { thread_id } = await make_thread(env, `res4-${i}`);
      const done = assert_ok(await post(env, `/threads/${thread_id}/resolutions`, "owner", { resolution, reason: `사유 ${resolution}`, ...(followup === undefined ? {} : { followup }) }), 201);
      const read = assert_ok(await get(env, `/threads/${thread_id}`));
      assert.equal(read.thread.state, "resolved");
      assert.equal(read.thread.resolution.resolution, resolution);
      assert.equal(read.thread.resolution.reason, `사유 ${resolution}`);
      if (followup !== undefined) {
        assert.equal(read.thread.resolution.followup_id, done.followup.id);
        assert.deepEqual(read.followups.map((x: any) => [x.id, x.kind, x.state]), [[done.followup.id, resolution, "proposed"]]);
      }
    }
  });
});

test("POST P/followups: 소유자·리스를 쥔 에이전트가 제안한다(proposed), 에이전트는 확정하지 못한다, 리스 없으면 403, 거절은 쓰지 않는다", async () => {
  await with_api(async (env) => {
    const { art, thread_id } = await make_thread(env);
    const { agent, guard } = await leased(env, "proposer");
    const body = { origin_thread_id: thread_id, kind: "edit_text", description: "근거를 보강한다.", proposed_body_md: NEW_BODY };
    const sig = state_signature(env.db);
    assert_final_error(await post(env, "/followups", { token: agent.token }, body), 403, "forbidden");
    assert_final_error(await post(env, "/followups", "none", body), 401, "unauthenticated");
    assert_final_error(await post(env, "/followups", "owner", { ...body, proposed_body_md: undefined }), 400, "invalid_payload");
    assert_final_error(await post(env, "/followups", "owner", { ...body, kind: "delete_everything" }), 422, "validation_failed", { target: "$.body.kind" });
    assert_final_error(await post(env, "/followups", "owner", { ...body, origin_thread_id: "no-such-thread" }), 404, "not_found");
    assert_final_error(await post(env, "/followups", "owner", { ...body, surprise: 1 }), 400, "invalid_payload");
    assert.equal(state_signature(env.db), sig);

    const mine = assert_ok(await post(env, "/followups", "owner", body, "fu-1"), 201);
    assert.equal(mine.followup.kind, "edit_text");
    assert.equal(mine.followup.state, "proposed");
    assert.equal(mine.followup.version_no, "1");
    assert.equal(mine.followup.base_version_id, art.version_id);
    assert.equal((await post(env, "/followups", "owner", body, "fu-1")).json.replayed, true);

    const theirs = assert_ok(await post(env, "/followups", { token: agent.token }, { ...body, description: "에이전트 제안", ...guard }), 201);
    assert.equal(theirs.followup.state, "proposed");
    assert.equal(followup_row(env.db, theirs.followup.id).confirmed_by_actor_id, null);
    assert.equal(current_version_of(env.db, art.object_id), art.version_id, "제안은 글을 바꾸지 않는다");
    assert.equal(body_of(env.db, art.version_id), BODY);
  });
});

test("POST P/followups/{f}/apply: 사람이 edit_text 를 채택하면 200, 새 버전, applied_tx_id·result_version_id, 스레드는 그대로, 에이전트 토큰은 403 human_required", async () => {
  await with_api(async (env) => {
    const { art, thread_id } = await make_thread(env);
    const prop = assert_ok(await post(env, "/followups", "owner", { origin_thread_id: thread_id, kind: "edit_text", description: "보강", proposed_body_md: NEW_BODY }), 201).followup;
    const { agent, guard } = await leased(env, "applier");
    const apply_body = { format_version: "1.0", base_version_id: art.version_id, expected_rev: prop.version_no };
    const sig = state_signature(env.db);
    assert_final_error(await post(env, `/followups/${prop.id}/apply`, { token: agent.token }, { ...apply_body, ...guard }), 403, "human_required", { next_action: "use_owner_session" });
    assert_final_error(await post(env, `/followups/${prop.id}/apply`, "none", apply_body), 401, "unauthenticated");
    assert_final_error(await post(env, `/followups/${prop.id}/apply`, "owner", { ...apply_body, expected_rev: "99" }), 409, "rev_conflict");
    assert_final_error(await post(env, "/followups/no-such-followup/apply", "owner", apply_body), 404, "not_found");
    assert_final_error(await post(env, `/followups/${prop.id}/apply`, "owner", { ...apply_body, surprise: 1 }), 400, "invalid_payload");
    assert.equal(state_signature(env.db), sig);

    const res = await post(env, `/followups/${prop.id}/apply`, "owner", apply_body, "ap-1");
    const data = assert_ok(res, 200);
    assert.deepEqual(Object.keys(data).sort(), ["followup", "thread"]);
    assert.deepEqual(Object.keys(data.followup).sort(), ["applied_tx_id", "id", "result_version_id", "state"]);
    assert.equal(data.followup.state, "applied");
    assert.equal(data.followup.id, prop.id);
    assert.deepEqual(data.thread, { id: thread_id, state: "open" });
    assert.equal(current_version_of(env.db, art.object_id), data.followup.result_version_id);
    assert.equal(body_of(env.db, data.followup.result_version_id), NEW_BODY);
    assert.equal(body_of(env.db, art.version_id), BODY);
    assert.equal(followup_row(env.db, prop.id).applied_tx_id, data.followup.applied_tx_id);
    assert.equal((await post(env, `/followups/${prop.id}/apply`, "owner", apply_body, "ap-1")).json.replayed, true);
  });
});

test("POST P/followups/{f}/apply: 그사이 글이 바뀌었으면 409 basis_changed(details expected/current/current_rev)이고 글·제안·후속이 그대로다", async () => {
  await with_api(async (env) => {
    const { art, thread_id } = await make_thread(env);
    const prop = assert_ok(await post(env, "/followups", "owner", { origin_thread_id: thread_id, kind: "edit_text", description: "보강", proposed_body_md: NEW_BODY }), 201).followup;
    const edited = await text_version(env, "api-edit", art.object_id, `${BODY}\n\n그사이 덧붙인 문장.`);
    const sig = state_signature(env.db);
    const err = assert_final_error(await post(env, `/followups/${prop.id}/apply`, "owner", { base_version_id: art.version_id, expected_rev: prop.version_no }), 409, "basis_changed", { target: "$.body.base_version_id", next_action: "reread_followup" });
    assert.deepEqual(Object.keys(err.details).sort(), ["current", "current_rev", "expected"]);
    assert.equal(err.details.expected, art.version_id);
    assert.equal(err.details.current, edited.version_id);
    assert.match(err.details.current_rev, DEC);
    assert.equal(state_signature(env.db), sig);
    assert.equal(followup_row(env.db, prop.id).state, "proposed");
    assert.equal(current_version_of(env.db, art.object_id), edited.version_id);
  });
});

// ---------------------------------------------------------------------------
// reanchor

test("POST P/threads/{t}/reanchor: 재판정은 판정 줄을 더하고 상태를 돌려준다(lost 도 오류가 아니다), 다시 붙이기는 사람만", async () => {
  await with_api(async (env) => {
    const { art, data, thread_id } = await make_thread(env);
    const frozen = anchor_row(env.db, data.thread.anchor_id);
    await text_version(env, "ra-v2", art.object_id, "완전히 다시 쓴 글이다. 정책 선택지는 두 가지로 줄었다.");
    const lost = assert_ok(await post(env, `/threads/${thread_id}/reanchor`, "owner", {}), 201);
    assert.equal(lost.thread_id, thread_id);
    assert.equal(lost.anchor.status, "lost");
    assert.equal(lost.anchor.start_cp, null);
    assert.deepEqual(lost.anchor.candidates, []);
    assert.equal(resolutions_of(env.db, data.thread.anchor_id).length, 2);
    assert.equal(anchor_row(env.db, data.thread.anchor_id), frozen);

    const { agent, guard } = await leased(env, "reanchorer");
    const sig = state_signature(env.db);
    assert_final_error(await post(env, `/threads/${thread_id}/reanchor`, { token: agent.token }, { start_cp: 0, end_cp: 3, ...guard }), 403, "human_required");
    assert_final_error(await post(env, `/threads/${thread_id}/reanchor`, "owner", { start_cp: 3 }), 400, "invalid_payload");
    assert_final_error(await post(env, `/threads/${thread_id}/reanchor`, "owner", { start_cp: 0, end_cp: 9999 }), 422, "validation_failed");
    assert_final_error(await post(env, "/threads/no-such-thread/reanchor", "owner", {}), 404, "not_found");
    assert.equal(state_signature(env.db), sig);

    const pick = cp_find("완전히 다시 쓴 글이다. 정책 선택지는 두 가지로 줄었다.", "정책 선택지는 두 가지로 줄었다.");
    const moved = assert_ok(await post(env, `/threads/${thread_id}/reanchor`, "owner", pick), 201);
    assert.equal(moved.anchor.status, "moved");
    assert.equal(moved.anchor.start_cp, pick.start_cp);
    assert.equal(moved.anchor.confirmed_by_actor_id, env.p.actor_id);
    assert.deepEqual(resolutions_of(env.db, data.thread.anchor_id).map((r) => r.status), ["exact", "lost", "moved"]);
  });
});

// ---------------------------------------------------------------------------
// 읽기

test("GET P/threads/{t}: 스레드·앵커(원래 + 현재 판정)·메시지·후속이 한 번에 읽힌다", async () => {
  await with_api(async (env) => {
    const { art, data, thread_id } = await make_thread(env);
    const reply = assert_ok(await post(env, `/threads/${thread_id}/messages`, "owner", { body_md: "답글", reply_to: data.message.id }), 201);
    const read = assert_ok(await get(env, `/threads/${thread_id}`));
    assert.deepEqual(
      { id: read.thread.id, context_kind: read.thread.context_kind, state: read.thread.state, target_object_id: read.thread.target_object_id, target_version_id: read.thread.target_version_id, resolution: read.thread.resolution },
      { id: thread_id, context_kind: "annotation", state: "open", target_object_id: art.object_id, target_version_id: art.version_id, resolution: null },
    );
    const a = read.anchor;
    assert.equal(a.id, data.thread.anchor_id);
    assert.equal(a.exact_quote, QUOTE);
    assert.equal(a.prefix, PREFIX);
    assert.equal(a.suffix, SUFFIX);
    assert.equal(a.text_format_version, 1);
    assert.equal(a.start_cp, cp_find(BODY, QUOTE).start_cp);
    assert.equal(a.end_cp, cp_find(BODY, QUOTE).end_cp);
    assert.equal(a.target_version_id, art.version_id);
    assert.equal(a.status, "exact");
    assert.equal(a.current.status, "exact");
    assert.equal(a.current.evaluated_version_id, art.version_id);
    assert.equal(a.current.text, QUOTE);
    assert.deepEqual(a.current.candidates, []);
    assert.equal(a.current.confirmed_by_actor_id, null);

    assert.equal(read.messages.length, 2);
    assert.deepEqual(read.messages.map((m: any) => m.body_md), ["이 문장의 근거를 더 설명해 주세요.", "답글"]);
    assert.equal(read.messages[1].id, reply.message.id);
    assert.equal(read.messages[1].reply_to, data.message.id);
    assert.equal(read.messages[0].reply_to, null);
    assert.equal(read.messages[0].actor_id, env.p.actor_id);
    assert.equal(read.messages[0].state, "published");
    assert.match(read.messages[0].created_at, ISO);
    assert.deepEqual(read.followups, []);
  });
});

test("GET P/threads/{t}: 글이 바뀌면 현재 판정이 moved/ambiguous/lost 로 그대로 보이고 숨지 않는다(읽기는 아무것도 쓰지 않는다)", async () => {
  await with_api(async (env) => {
    const { art, data, thread_id } = await make_thread(env);
    const insert = "새로 끼운 문단 😀 입니다.\n\n";
    const v2 = await text_version(env, "rd-v2", art.object_id, insert + BODY);
    const sig = state_signature(env.db);
    const moved = assert_ok(await get(env, `/threads/${thread_id}`)).anchor;
    assert.equal(moved.status, "exact", "원래 앵커 자체는 그대로");
    assert.equal(moved.start_cp, cp_find(BODY, QUOTE).start_cp);
    assert.equal(moved.current.status, "moved");
    assert.equal(moved.current.evaluated_version_id, v2.version_id);
    assert.equal(moved.current.start_cp, cp_find(insert + BODY, QUOTE).start_cp);
    assert.equal(moved.current.text, QUOTE);
    assert.equal(state_signature(env.db), sig, "읽기는 쓰지 않는다");

    // 모호: 인용문이 문맥 없이 두 번
    await text_version(env, "rd-v3", art.object_id, `요약: ${QUOTE} 그리고 다시 ${QUOTE} 끝.`);
    const amb = assert_ok(await get(env, `/threads/${thread_id}`)).anchor.current;
    assert.equal(amb.status, "ambiguous");
    assert.equal(amb.start_cp, null);
    assert.equal(amb.end_cp, null);
    assert.equal(amb.text, null);
    assert.equal(amb.candidates.length, 2, "후보가 모두 보이고, 하나로 정해져 있지 않다");

    // 사라짐
    await text_version(env, "rd-v4", art.object_id, "아무 관련 없는 새 글이다.");
    const read = assert_ok(await get(env, `/threads/${thread_id}`));
    assert.equal(read.anchor.current.status, "lost");
    assert.equal(read.anchor.current.start_cp, null);
    assert.equal(read.anchor.exact_quote, QUOTE, "lost 여도 인용문은 남는다");
    assert.equal(read.messages.length, 1, "lost 여도 메시지는 남는다");
    assert.equal(read.thread.state, "open");
    assert.equal(count_of(env.db, "anchor_resolutions"), 1, "읽기만으로는 판정 줄이 늘지 않는다");
    assert.equal(anchor_row(env.db, data.thread.anchor_id).includes(QUOTE), true);
  });
});

test("GET P/threads: 글·종류·상태로 거를 수 있고, 줄마다 현재 앵커 상태가 보인다", async () => {
  await with_api(async (env) => {
    const a = await make_thread(env, "list-a");
    const b = await make_thread(env, "list-b");
    assert_ok(await post(env, `/threads/${b.thread_id}/resolutions`, "owner", { resolution: "none", reason: "닫는다." }), 201);
    await text_version(env, "list-v2", a.art.object_id, "관련 없는 새 글.");

    const all = assert_ok(await get(env, "/threads")).threads as any[];
    assert.deepEqual(all.map((t) => t.id).sort(), [a.thread_id, b.thread_id].sort());
    const row_a = all.find((t) => t.id === a.thread_id)!;
    assert.equal(row_a.context_kind, "annotation");
    assert.equal(row_a.state, "open");
    assert.equal(row_a.message_count, 1);
    assert.equal(row_a.anchor_status, "lost", "lost 가 목록에서도 보인다");
    assert.equal(all.find((t) => t.id === b.thread_id)!.anchor_status, "exact");

    assert.deepEqual((assert_ok(await get(env, `/threads?target_object_id=${a.art.object_id}`)).threads as any[]).map((t) => t.id), [a.thread_id]);
    assert.deepEqual((assert_ok(await get(env, "/threads?state=resolved")).threads as any[]).map((t) => t.id), [b.thread_id]);
    assert.deepEqual((assert_ok(await get(env, "/threads?state=open&context_kind=annotation")).threads as any[]).map((t) => t.id), [a.thread_id]);
    assert.deepEqual(assert_ok(await get(env, "/threads?context_kind=question_comment")).threads, []);
    assert_final_error(await get(env, "/threads?state=bogus"), 400, "invalid_payload");
    assert_final_error(await get(env, "/threads?context_kind=bogus"), 400, "invalid_payload");
  });
});

test("GET P/followups: 제안·적용 상태와 제안 글, 필터(thread_id·state·kind)", async () => {
  await with_api(async (env) => {
    const { art, thread_id } = await make_thread(env);
    const stages = stage_ids(env.db, env.p.edition_id);
    const edit = assert_ok(await post(env, "/followups", "owner", { origin_thread_id: thread_id, kind: "edit_text", description: "보강", proposed_body_md: NEW_BODY }), 201).followup;
    const task = assert_ok(await post(env, "/followups", "owner", { origin_thread_id: thread_id, kind: "next_round_task", description: "다음에 한다", target_stage_id: stages.research }), 201).followup;
    const list = assert_ok(await get(env, `/followups?thread_id=${thread_id}`)).followups as any[];
    assert.deepEqual(list.map((f) => f.id).sort(), [edit.id, task.id].sort());
    const e = list.find((f) => f.id === edit.id)!;
    assert.deepEqual(
      { kind: e.kind, state: e.state, description: e.description, version_no: e.version_no, origin_thread_id: e.origin_thread_id, origin_version_id: e.origin_version_id, base_version_id: e.base_version_id, proposed_body_md: e.proposed_body_md, result_version_id: e.result_version_id, applied_tx_id: e.applied_tx_id, confirmed_by_actor_id: e.confirmed_by_actor_id },
      { kind: "edit_text", state: "proposed", description: "보강", version_no: "1", origin_thread_id: thread_id, origin_version_id: art.version_id, base_version_id: art.version_id, proposed_body_md: NEW_BODY, result_version_id: null, applied_tx_id: null, confirmed_by_actor_id: null },
    );
    assert.equal(typeof e.proposed_version_id, "string");
    const t = list.find((f) => f.id === task.id)!;
    assert.equal(t.target_stage_id, stages.research);
    assert.equal(t.proposed_body_md, null);

    assert_ok(await post(env, `/followups/${edit.id}/apply`, "owner", { base_version_id: art.version_id, expected_rev: edit.version_no }), 200);
    const applied = assert_ok(await get(env, "/followups?state=applied")).followups as any[];
    assert.deepEqual(applied.map((f) => f.id), [edit.id]);
    assert.equal(applied[0].version_no, "2");
    assert.equal(applied[0].confirmed_by_actor_id, env.p.actor_id);
    assert.equal(typeof applied[0].result_version_id, "string");
    assert.equal(typeof applied[0].applied_tx_id, "string");
    assert.deepEqual((assert_ok(await get(env, "/followups?kind=next_round_task")).followups as any[]).map((f) => f.id), [task.id]);
    assert.deepEqual((assert_ok(await get(env, "/followups?state=proposed&kind=edit_text")).followups as any[]), []);
    assert_final_error(await get(env, "/followups?state=bogus"), 400, "invalid_payload");
    assert_final_error(await get(env, "/followups?kind=bogus"), 400, "invalid_payload");
  });
});

test("읽기 권한: 무자격 401, context:read 없는 토큰 403, context:read 토큰·소유자 200, 모르는 프로젝트·스레드 404, 다른 프로젝트의 스레드 404", async () => {
  await with_api(async (env) => {
    const { thread_id } = await make_thread(env);
    const reader = await make_agent(env, "reader", ["context:read"]);
    const writer = await make_agent(env, "writer-only", ["run:submit"]);
    for (const rest of ["/threads", `/threads/${thread_id}`, "/followups"]) {
      assert_final_error(await get(env, rest, "none"), 401, "unauthenticated");
      assert_final_error(await get(env, rest, { token: writer.token }), 403, "forbidden");
      assert_ok(await get(env, rest, { token: reader.token }));
      assert_ok(await get(env, rest, "owner"));
    }
    assert_final_error(await get(env, "/threads/no-such-thread"), 404, "not_found");
    for (const path of ["/api/v1/projects/prj-does-not-exist/threads", `/api/v1/projects/prj-does-not-exist/threads/${thread_id}`, "/api/v1/projects/prj-does-not-exist/followups"]) {
      const res = await call(env, { method: "GET", path, auth: "owner" });
      assert_error(res, 404, "not_found");
    }

    // 다른 프로젝트에 있는 스레드 id 는 이 프로젝트 경로에서 보이지 않는다
    const foreign = await second_project(env, "synthetic-sel99-api");
    const obj = (await create_object(env.service, ctx_for(foreign, "fo-o"), { kind: "artifact", edition_id: foreign.edition_id })).result as { object_id: string };
    await add_artifact(env.service, ctx_for(foreign, "fo-v"), { object_id: obj.object_id, artifact_kind: "chapter", title: "남의 장", summary: "s", body_md: BODY });
    const other = (await env.service.execute(ctx_for(foreign, "fo-an"), "annotation.create", { target_object_id: obj.object_id, anchor: { exact_quote: QUOTE }, body_md: "남의 프로젝트 첨언" })).result as any;
    assert_final_error(await get(env, `/threads/${other.thread_id}`), 404, "not_found");
    assert_final_error(await post(env, `/threads/${other.thread_id}/messages`, "owner", { body_md: "x" }), 404, "not_found");
    assert_final_error(await post(env, `/threads/${other.thread_id}/resolutions`, "owner", { resolution: "none", reason: "x" }), 404, "not_found");
    assert.deepEqual((assert_ok(await get(env, "/threads")).threads as any[]).map((t) => t.id), [thread_id], "목록에도 남의 프로젝트 스레드가 없다");
  });
});

test("capabilities: 새 라우트가 지원 목록으로 옮겨가고(미지원이 아니다), 문서(OpenAPI)에도 있다", async () => {
  await with_api(async (env) => {
    const caps = assert_ok(await call(env, { method: "GET", path: "/api/v1/capabilities", auth: "owner" }));
    const routes = [
      "POST /api/v1/projects/{id}/threads/{t}/resolutions",
      "POST /api/v1/projects/{id}/threads/{t}/reanchor",
      "POST /api/v1/projects/{id}/followups",
      "POST /api/v1/projects/{id}/followups/{f}/apply",
      "GET /api/v1/projects/{id}/threads",
      "GET /api/v1/projects/{id}/threads/{t}",
      "GET /api/v1/projects/{id}/followups",
    ];
    for (const route of routes) {
      assert.ok(caps.routes.includes(route), `routes 에 ${route}`);
      assert.ok(!caps.unsupported.includes(route), `${route} 는 미지원이 아니다`);
    }
    const doc = readFileSync(OPENAPI_PATH, "utf8");
    for (const path of ["/api/v1/projects/{id}/threads/{t}/resolutions:", "/api/v1/projects/{id}/threads/{t}/reanchor:", "/api/v1/projects/{id}/followups:", "/api/v1/projects/{id}/followups/{f}/apply:", "/api/v1/projects/{id}/threads/{t}:"]) {
      assert.ok(doc.includes(path), `OpenAPI 에 ${path}`);
    }
    assert.equal(doc.includes('annotation is 501 not_supported until U4a'), false, "OpenAPI 의 'annotation 은 501' 설명이 지워졌다");
  });
});

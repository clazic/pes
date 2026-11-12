/**
 * SEL-99 U4a — 후속(followups)·edit_text 제안/채택·스레드 해결과 반영의 분리: 명령 thread.reply · followup.propose · thread.resolve · followup.apply (tester, 작성 모드).
 * 구현 전에는 명령이 없어 실패하는 것이 정상이다. 인터페이스 표는 test_sel99_annotation.test.ts 머리말.
 *
 * 있던 것: DDL followups · followup_versions(kind: edit_text/next_round_task/reopen_stage/none, state: proposed/accepted/running/applied/deferred/rejected/cancelled,
 *   base_artifact_version_id · proposed_artifact_version_id · result_version_id · applied_tx_id · confirmed_by_actor_id), reflection_entries(SEL-93 reflection.create 의 applied 증거 규칙).
 *   content.append_version(현재 버전 안 바꿈) · content.set_current.
 *
 * 정한 해석:
 *   thread.reply {thread_id, body_md, reply_to?, run_id?, lease_id?, fence?}   사람 또는 리스를 쥔 에이전트. 스레드가 resolved/archived 면 conflict(details.reason 'thread_closed') — 새 스레드를 열어야 한다.
 *     reply_to 는 같은 스레드의 메시지여야 한다. 결과 {thread_id, message_id, message_version_id}. 영수증 action 'thread.reply'.
 *   followup.propose {origin_thread_id, kind, description, proposed_body_md?, base_version_id?, target_stage_id?, target_round_id?, run_id?, lease_id?, fence?}   사람 또는 리스를 쥔 에이전트(제안만).
 *     followups(origin_thread_id, origin_version_id = 스레드의 target_version_id) + followup_versions(state 'proposed', version_no 1). 결과 {followup_id, version_id, kind, state:'proposed', base_version_id}.
 *     edit_text: proposed_body_md 필수(비어 있지 않은 well-formed 글). base_version_id 기본 = 그 글의 **현재 버전**, 주면 같은 글의 버전이어야 한다.
 *       제안 글은 proposed_artifact_version_id 로 가리키는 **새 비현재 artifact_versions**(append_version 처럼)로 저장한다 — 글의 현재 버전·원문은 그대로.
 *     next_round_task · reopen_stage: target_stage_id 필수(이 프로젝트의 단계). target_round_id 는 그 단계의 라운드일 때만. none: 설명만.
 *     제안은 스레드 상태를 바꾸지 않고 reflection_entries 를 만들지 않는다. 영수증 action 'followup.propose'.
 *   thread.resolve {thread_id, resolution:'edit_text'|'next_round_task'|'reopen_stage'|'none', reason, followup?:{kind, description?, proposed_body_md?, target_version_id?, target_stage_id?, target_round_id?}}   **사람 소유자만**.
 *     한 tx 로: 결론 메시지(reason) + thread_versions 새 줄(state 'resolved', resolved_by_message_version_id = 그 메시지 버전) + (edit_text/next_round_task/reopen_stage 면) 후속 한 건(proposed).
 *     followup.kind 는 resolution 과 같아야 한다(다르면 invalid_payload); none 에는 followup 을 못 붙인다. 문서 픽스처처럼 edit_text 의 followup 은 target_version_id 만 줘도 된다(제안 글 없는 후속 —
 *     proposed_artifact_version_id NULL; 글을 정해 주기 전에는 채택 못 한다). 결과 {thread_id, state:'resolved', resolution, followup_id|null, applied:false, resolution_message_version_id}.
 *     **해결됨은 반영됨이 아니다**: 글·reflection_entries 는 안 바뀌고 후속은 proposed 로 남는다. 이미 resolved 면 conflict(details.reason 'already_resolved'). 영수증 action 'thread.resolve'.
 *   followup.apply {followup_id, base_version_id, expected_rev}   **사람 소유자만**(에이전트는 제안만 — 스스로 정한 해석; 문서 픽스처의 "permitted agent" 는 이 이슈에서 열지 않는다).
 *     expected_rev = 후속의 현재 followup_versions version_no(10진 문자열). 순서: 후속이 이미 applied 면 conflict → base_version_id 가 후속의 base 이고 글의 현재 버전이 아니면
 *     conflict(details.reason 'basis_changed', details.expected = 요청 base, details.current = 글의 현재 버전, details.current_rev) → expected_rev 가 다르면 rev_conflict.
 *     edit_text: 기반이 맞으면 제안 글을 **새 버전**으로 채택한다(글의 현재 버전이 새 버전으로 옮겨 가고 옛 버전 행·본문은 그대로) — followup_versions 새 줄(state 'applied', applied_tx_id = 이 호출의 tx(영수증 id),
 *       result_version_id = 새 버전, confirmed_by_actor_id = 사람). 제안 글이 없으면 거절. next_round_task: applied(결과 버전 없음). reopen_stage: 사람만(에이전트 forbidden) — 소유자 적용의 효과는 U4b.
 *     apply 는 스레드를 해결하지도 reflection 을 쓰지도 않는다(반영 내역은 reflection.create 가 따로 쓴다 — SEL-93 규칙: followup 이 applied 이고 applied_tx_id == evidence_tx_id, origin_version_id == source_version_id).
 *     기반이 달라 실패하면 글·제안(proposed_artifact_version_id 가 가리키는 본문)·후속 상태가 그대로 보존된다. 영수증 action 'followup.apply'.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { second_project } from "./helpers/blob_env.ts";
import { add_agent, agent_claim, events_of, receipt_of, rejects_api, stage_ids, stage_row, with_env, type Env } from "./helpers/editions_env.ts";
import { open_round } from "./helpers/questions_env.ts";
import { state_signature } from "./helpers/state_signature.ts";
import {
  artifact_version_count,
  body_of,
  count_of,
  current_version_of,
  cp_find,
  followup_row,
  followup_version_count,
  type FollowupRow,
  messages_of,
  text_artifact,
  text_version,
  thread_row,
  thread_version_count,
  type Out,
} from "./helpers/sel99_env.ts";

const BODY = "2장 합성 정책 분석에서 정책 대안은 두 가지다. 첫 번째는 현행 유지다.";
const QUOTE = "정책 대안은 두 가지다.";
const NEW_BODY = "2장 합성 정책 분석에서 정책 대안은 두 가지이며 근거는 부록 A 에 있다. 첫 번째는 현행 유지다.";

async function run(env: Env, key: string, command: string, payload: Record<string, unknown>): Promise<Out> {
  return (await env.service.execute(env.ctx(key), command, payload)).result as Out;
}

async function scene(env: Env, tag = "f") {
  const art = await text_artifact(env, tag, BODY);
  const note = await run(env, `${tag}-note`, "annotation.create", { target_object_id: art.object_id, anchor: { exact_quote: QUOTE, ...cp_find(BODY, QUOTE) }, body_md: "근거를 더 설명해 주세요." });
  return { art, note, thread_id: note.thread_id as string };
}

function edit_proposal(s: Awaited<ReturnType<typeof scene>>, extra: Record<string, unknown> = {}) {
  return { origin_thread_id: s.thread_id, kind: "edit_text", description: "근거를 보강한다.", proposed_body_md: NEW_BODY, ...extra };
}

/** 리스를 쥔 에이전트 맥락(서비스 수준). guard 는 요청 본문에 더하는 run_id/lease_id/fence. */
async function leased_agent(env: Env, name: string) {
  const base = add_agent(env, name);
  const lease = await agent_claim(env, base, `claim-${name}`);
  return { ctx: (key: string) => ({ ...base, client_request_id: key }), guard: { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence }, actor_id: base.actor_id as string };
}

// ---------------------------------------------------------------------------
// thread.reply

test("thread.reply: 첨언 스레드에 답글을 더한다(메시지 한 줄, 영수증·사건, 스레드 상태는 open 그대로)", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const first = messages_of(env.db, s.thread_id)[0]!;
    const tv = thread_version_count(env.db, s.thread_id);
    const out = await run(env, "rp-1", "thread.reply", { thread_id: s.thread_id, body_md: "첨언에 대한 합성 답글입니다.", reply_to: first.message_id });
    const msgs = messages_of(env.db, s.thread_id);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[1]!.message_id, out.message_id);
    assert.equal(msgs[1]!.version_id, out.message_version_id);
    assert.equal(msgs[1]!.body_md, "첨언에 대한 합성 답글입니다.");
    assert.equal(msgs[1]!.state, "published");
    assert.equal(msgs[1]!.reply_to, first.message_id);
    assert.equal(msgs[1]!.actor_id, env.p.actor_id);
    assert.equal(thread_row(env.db, s.thread_id).state, "open");
    assert.equal(thread_version_count(env.db, s.thread_id), tv, "답글은 스레드 상태를 바꾸지 않는다");
    const receipt = receipt_of(env.db, env.p.project_id, "rp-1")!;
    assert.equal(receipt.action, "thread.reply");
    assert.ok(events_of(env.db, receipt.id).length >= 1);

    const sig = state_signature(env.db);
    const again = await env.service.execute(env.ctx("rp-1"), "thread.reply", { thread_id: s.thread_id, body_md: "첨언에 대한 합성 답글입니다.", reply_to: first.message_id });
    assert.equal(again.replayed, true);
    assert.equal(state_signature(env.db), sig);
    await rejects_api(env.service.execute(env.ctx("rp-1"), "thread.reply", { thread_id: s.thread_id, body_md: "다른 내용" }), "idempotency_key_reuse");
  });
});

test("thread.reply 거절: 빈 글·서로게이트·다른 스레드의 reply_to·모르는 스레드/필드·다른 프로젝트 — 쓰지 않는다", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const other = await run(env, "rp-o", "annotation.create", { target_object_id: s.art.object_id, anchor: { exact_quote: "첫 번째는 현행 유지다." }, body_md: "다른 스레드" });
    const other_msg = messages_of(env.db, other.thread_id)[0]!.message_id;
    const foreign = await second_project(env, "synthetic-sel99-f");
    const sig = state_signature(env.db);
    const bad: Array<[Record<string, unknown>, string[]]> = [
      [{ thread_id: s.thread_id, body_md: "" }, ["invalid_payload"]],
      [{ thread_id: s.thread_id, body_md: "  \n" }, ["invalid_payload"]],
      [{ thread_id: s.thread_id, body_md: "\ud800" }, ["invalid_payload"]],
      [{ thread_id: s.thread_id, body_md: "x", reply_to: other_msg }, ["invalid_payload", "conflict", "not_found"]],
      [{ thread_id: s.thread_id, body_md: "x", reply_to: "no-such-message" }, ["not_found", "invalid_payload"]],
      [{ thread_id: "no-such-thread", body_md: "x" }, ["not_found"]],
      [{ thread_id: s.thread_id, body_md: "x", surprise: 1 }, ["invalid_payload"]],
    ];
    for (const [i, [payload, codes]] of bad.entries()) await rejects_api(env.service.execute(env.ctx(`rb-${i}`), "thread.reply", payload), ...codes);
    await rejects_api(
      env.service.execute({ project_id: foreign.project_id, actor_id: foreign.actor_id, via: "cli", client_request_id: "fx" }, "thread.reply", { thread_id: s.thread_id, body_md: "x" }),
      "not_found",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

test("thread.reply: 리스를 쥔 에이전트는 쓸 수 있고(행위자는 에이전트) 리스 없는 에이전트는 forbidden", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const lone = add_agent(env, "agent-nolease");
    await rejects_api(env.service.execute({ ...lone, client_request_id: "nl" }, "thread.reply", { thread_id: s.thread_id, body_md: "리스 없음" }), "forbidden");
    const ag = await leased_agent(env, "agent-replier");
    const out = (await env.service.execute(ag.ctx("ag-reply"), "thread.reply", { thread_id: s.thread_id, body_md: "에이전트 답글", ...ag.guard })).result as Out;
    const last = messages_of(env.db, s.thread_id).at(-1)!;
    assert.equal(last.message_id, out.message_id);
    assert.equal(last.actor_id, ag.actor_id);
    assert.equal(thread_row(env.db, s.thread_id).state, "open");
  });
});

// ---------------------------------------------------------------------------
// followup.propose

test("followup.propose edit_text: 제안 글은 새 비현재 버전으로 저장되고 원문·현재 버전·스레드·반영 내역은 그대로다", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const current = current_version_of(env.db, s.art.object_id);
    assert.equal(current, s.art.version_id);
    const reflections = count_of(env.db, "reflection_entries");
    const out = await run(env, "fp-1", "followup.propose", edit_proposal(s));
    assert.equal(out.kind, "edit_text");
    assert.equal(out.state, "proposed");
    assert.equal(out.base_version_id, s.art.version_id);

    const row = followup_row(env.db, out.followup_id);
    assert.equal(row.version_id, out.version_id);
    assert.equal(row.version_no, 1);
    assert.equal(row.kind, "edit_text");
    assert.equal(row.state, "proposed");
    assert.equal(row.description, "근거를 보강한다.");
    assert.equal(row.origin_thread_id, s.thread_id);
    assert.equal(row.origin_version_id, s.art.version_id, "후속의 원 버전은 스레드가 가리키는 글 버전");
    assert.equal(row.base_artifact_version_id, s.art.version_id);
    assert.ok(row.proposed_artifact_version_id, "제안 글을 가리킨다");
    assert.notEqual(row.proposed_artifact_version_id, s.art.version_id);
    assert.equal(body_of(env.db, row.proposed_artifact_version_id!), NEW_BODY);
    assert.equal(row.applied_tx_id, null);
    assert.equal(row.result_version_id, null);
    assert.equal(row.confirmed_by_actor_id, null);

    assert.equal(current_version_of(env.db, s.art.object_id), s.art.version_id, "글의 현재 버전은 그대로 — 제안은 원문을 덮어쓰지 않는다");
    assert.equal(body_of(env.db, s.art.version_id), BODY);
    assert.equal(thread_row(env.db, s.thread_id).state, "open");
    assert.equal(count_of(env.db, "reflection_entries"), reflections);
    const receipt = receipt_of(env.db, env.p.project_id, "fp-1")!;
    assert.equal(receipt.action, "followup.propose");
    assert.ok(events_of(env.db, receipt.id).length >= 1);

    const sig = state_signature(env.db);
    assert.equal((await env.service.execute(env.ctx("fp-1"), "followup.propose", edit_proposal(s))).replayed, true);
    assert.equal(state_signature(env.db), sig);
    await rejects_api(env.service.execute(env.ctx("fp-1"), "followup.propose", edit_proposal(s, { description: "다른 설명" })), "idempotency_key_reuse");
  });
});

test("followup.propose: 다음 라운드 할 일·reopen 제안·그냥 기록(none) — 제안만 남기고 단계·글은 건드리지 않는다", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const stages = stage_ids(env.db, env.p.edition_id);
    const stage_before = stage_row(env.db, stages.plan);
    const versions = artifact_version_count(env.db, s.art.object_id);

    const task = await run(env, "fp-task", "followup.propose", { origin_thread_id: s.thread_id, kind: "next_round_task", description: "다음 라운드에서 부록 A 를 확인한다.", target_stage_id: stages.research });
    assert.equal(task.state, "proposed");
    const trow = followup_row(env.db, task.followup_id);
    assert.equal(trow.kind, "next_round_task");
    assert.equal(trow.target_stage_id, stages.research);
    assert.equal(trow.proposed_artifact_version_id, null);
    assert.equal(trow.base_artifact_version_id, null);
    assert.equal(trow.origin_version_id, s.art.version_id);

    const reopen = await run(env, "fp-reopen", "followup.propose", { origin_thread_id: s.thread_id, kind: "reopen_stage", description: "계획 단계를 다시 연다.", target_stage_id: stages.plan });
    const rrow = followup_row(env.db, reopen.followup_id);
    assert.equal(rrow.kind, "reopen_stage");
    assert.equal(rrow.state, "proposed");
    assert.equal(rrow.confirmed_by_actor_id, null, "reopen 은 사람이 확정하기 전에는 아무도 승인하지 않은 제안");
    assert.deepEqual(stage_row(env.db, stages.plan), stage_before, "제안만으로 단계가 다시 열리지 않는다");

    const none = await run(env, "fp-none", "followup.propose", { origin_thread_id: s.thread_id, kind: "none", description: "기록만 남긴다." });
    assert.equal(followup_row(env.db, none.followup_id).kind, "none");
    assert.equal(artifact_version_count(env.db, s.art.object_id), versions, "글 버전은 늘지 않는다");
    assert.equal(thread_row(env.db, s.thread_id).state, "open");
  });
});

test("followup.propose 거절: 제안 글 없음·빈 설명·모르는 kind·단계 없는 할 일/reopen·남의 단계·다른 글의 기반 버전·서로게이트·모르는 스레드 — 쓰지 않는다", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const other = await text_artifact(env, "other", "다른 글이다.");
    const stages = stage_ids(env.db, env.p.edition_id);
    const foreign = await second_project(env, "synthetic-sel99-g");
    const foreign_stage = stage_ids(env.db, foreign.edition_id).plan;
    const sig = state_signature(env.db);
    const base = { origin_thread_id: s.thread_id, description: "설명" };
    const bad: Array<[string, Record<string, unknown>, string[]]> = [
      ["edit_text 글 없음", { ...base, kind: "edit_text" }, ["invalid_payload"]],
      ["edit_text 빈 글", { ...base, kind: "edit_text", proposed_body_md: "  " }, ["invalid_payload"]],
      ["edit_text 서로게이트", { ...base, kind: "edit_text", proposed_body_md: "\ud800" }, ["invalid_payload"]],
      ["빈 설명", { origin_thread_id: s.thread_id, kind: "none", description: "" }, ["invalid_payload"]],
      ["모르는 kind", { ...base, kind: "delete_everything" }, ["invalid_payload"]],
      ["할 일에 단계 없음", { ...base, kind: "next_round_task" }, ["invalid_payload"]],
      ["reopen 에 단계 없음", { ...base, kind: "reopen_stage" }, ["invalid_payload"]],
      ["남의 프로젝트 단계", { ...base, kind: "next_round_task", target_stage_id: foreign_stage }, ["not_found"]],
      ["라운드만", { ...base, kind: "next_round_task", target_round_id: "rnd-x" }, ["invalid_payload", "not_found"]],
      ["다른 글의 기반", { ...base, kind: "edit_text", proposed_body_md: NEW_BODY, base_version_id: other.version_id }, ["invalid_payload", "conflict", "not_found"]],
      ["모르는 스레드", { ...base, kind: "none", origin_thread_id: "no-such-thread" }, ["not_found"]],
      ["스레드 없음", { kind: "none", description: "x" }, ["invalid_payload"]],
      ["모르는 필드", { ...base, kind: "none", surprise: 1 }, ["invalid_payload"]],
    ];
    for (const [i, [name, payload, codes]] of bad.entries()) {
      await rejects_api(env.service.execute(env.ctx(`fb-${i}`), "followup.propose", payload), ...codes).catch((e) => {
        throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    assert.equal(state_signature(env.db), sig);
    assert.ok(stages.research.length > 0);
  });
});

test("followup.propose: 리스를 쥔 에이전트는 제안할 수 있다(행위자는 에이전트, 제안 상태), 리스 없는 에이전트는 forbidden", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const lone = add_agent(env, "agent-nolease2");
    await rejects_api(env.service.execute({ ...lone, client_request_id: "nl" }, "followup.propose", edit_proposal(s)), "forbidden");
    const ag = await leased_agent(env, "agent-proposer");
    const out = (await env.service.execute(ag.ctx("ag-fp"), "followup.propose", { ...edit_proposal(s), ...ag.guard })).result as Out;
    assert.equal(out.state, "proposed");
    const actor = env.db.get<{ actor_id: string }>("SELECT actor_id FROM object_versions WHERE id = ?", out.version_id)!.actor_id;
    assert.equal(actor, ag.actor_id);
    assert.equal(followup_row(env.db, out.followup_id).confirmed_by_actor_id, null, "에이전트의 제안은 확정이 아니다");
  });
});

// ---------------------------------------------------------------------------
// thread.resolve — 해결됨 ≠ 반영됨

test("thread.resolve edit_text: 스레드는 resolved, 후속은 proposed 로 남고 글·반영 내역은 그대로다(해결만으로 반영됨이 되지 않는다)", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const reflections = count_of(env.db, "reflection_entries");
    const versions = artifact_version_count(env.db, s.art.object_id);
    const tv = thread_version_count(env.db, s.thread_id);
    const out = await run(env, "rs-1", "thread.resolve", {
      thread_id: s.thread_id,
      resolution: "edit_text",
      reason: "문장을 보강합니다.",
      followup: { kind: "edit_text", description: "근거를 보강한다.", proposed_body_md: NEW_BODY },
    });
    assert.equal(out.state, "resolved");
    assert.equal(out.resolution, "edit_text");
    assert.equal(out.applied, false);
    assert.ok(out.followup_id);

    const t = thread_row(env.db, s.thread_id);
    assert.equal(t.state, "resolved");
    assert.equal(thread_version_count(env.db, s.thread_id), tv + 1, "thread_versions 에 새 줄(옛 줄은 그대로)");
    const msgs = messages_of(env.db, s.thread_id);
    assert.equal(msgs.at(-1)!.body_md.includes("문장을 보강합니다."), true, "결론 메시지에 사유가 남는다");
    assert.equal(t.resolved_by_message_version_id, msgs.at(-1)!.version_id);
    assert.equal(out.resolution_message_version_id, msgs.at(-1)!.version_id);

    const f = followup_row(env.db, out.followup_id);
    assert.equal(f.state, "proposed", "해결 ≠ 반영: 후속은 아직 제안일 뿐");
    assert.equal(f.origin_thread_id, s.thread_id);
    assert.equal(f.applied_tx_id, null);
    assert.equal(current_version_of(env.db, s.art.object_id), s.art.version_id);
    assert.equal(body_of(env.db, s.art.version_id), BODY);
    assert.equal(count_of(env.db, "reflection_entries"), reflections);
    assert.ok(artifact_version_count(env.db, s.art.object_id) <= versions + 1, "제안 글 하나까지만 늘 수 있다");
    const receipt = receipt_of(env.db, env.p.project_id, "rs-1")!;
    assert.equal(receipt.action, "thread.resolve");
    assert.ok(events_of(env.db, receipt.id).length >= 1);
  });
});

test("thread.resolve: 해결 결과 4종(글 수정 / 다음 라운드 할 일 / 앞 단계 다시 열기 / 그냥 닫기)이 모두 스레드를 resolved 로 닫고 후속은 proposed·글은 그대로", async () => {
  await with_env(async (env) => {
    const stages = stage_ids(env.db, env.p.edition_id);
    const cases: Array<[string, Record<string, unknown> | undefined]> = [
      ["edit_text", { kind: "edit_text", description: "고친다", proposed_body_md: NEW_BODY }],
      ["next_round_task", { kind: "next_round_task", description: "다음 라운드에서", target_stage_id: stages.research }],
      ["reopen_stage", { kind: "reopen_stage", description: "다시 연다", target_stage_id: stages.plan }],
      ["none", undefined],
    ];
    for (const [i, [resolution, followup]] of cases.entries()) {
      const s = await scene(env, `r4-${i}`);
      const reflections = count_of(env.db, "reflection_entries");
      const out = await run(env, `r4-${i}-res`, "thread.resolve", { thread_id: s.thread_id, resolution, reason: `사유 ${resolution}`, ...(followup === undefined ? {} : { followup }) });
      assert.equal(out.resolution, resolution);
      assert.equal(out.state, "resolved");
      assert.equal(out.applied, false);
      assert.equal(thread_row(env.db, s.thread_id).state, "resolved");
      if (resolution !== "none") assert.equal(followup_row(env.db, out.followup_id).state, "proposed", resolution);
      else assert.ok(out.followup_id === null || followup_row(env.db, out.followup_id).kind === "none", "그냥 닫기는 후속 없음(또는 kind none 기록)");
      assert.equal(current_version_of(env.db, s.art.object_id), s.art.version_id);
      assert.equal(count_of(env.db, "reflection_entries"), reflections, `${resolution}: 반영 내역은 따로`);
    }
    // reopen 제안으로 단계가 열리지 않았다
    assert.ok(stage_row(env.db, stages.plan));
  });
});

test("thread.resolve: 문서 픽스처 모양(edit_text + target_version_id 만)은 제안 글 없는 후속을 만든다", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const out = await run(env, "rs-fx", "thread.resolve", { thread_id: s.thread_id, resolution: "edit_text", reason: "문장을 보강합니다.", followup: { kind: "edit_text", target_version_id: s.art.version_id } });
    const f = followup_row(env.db, out.followup_id);
    assert.equal(f.kind, "edit_text");
    assert.equal(f.state, "proposed");
    assert.equal(f.base_artifact_version_id, s.art.version_id);
    assert.equal(f.proposed_artifact_version_id, null, "제안 글이 아직 없다");
    // 글을 정해 주기 전에는 채택할 수 없다
    const sig = state_signature(env.db);
    await rejects_api(
      env.service.execute(env.ctx("rs-fx-apply"), "followup.apply", { followup_id: out.followup_id, base_version_id: s.art.version_id, expected_rev: String(f.version_no) }),
      "invalid_payload",
      "validation_failed",
      "conflict",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

test("thread.resolve 거절: 이미 해결됨(already_resolved)·결과가 아닌 값·사유 없음·kind 불일치·none 에 후속·할 일에 단계 없음·모르는 스레드 — 쓰지 않는다", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const stages = stage_ids(env.db, env.p.edition_id);
    const sig = state_signature(env.db);
    const bad: Array<[string, Record<string, unknown>, string[]]> = [
      ["모르는 결과", { thread_id: s.thread_id, resolution: "deleted", reason: "x" }, ["invalid_payload"]],
      ["사유 없음", { thread_id: s.thread_id, resolution: "none" }, ["invalid_payload"]],
      ["빈 사유", { thread_id: s.thread_id, resolution: "none", reason: "  " }, ["invalid_payload"]],
      ["kind 불일치", { thread_id: s.thread_id, resolution: "edit_text", reason: "x", followup: { kind: "next_round_task", description: "d", target_stage_id: stages.research } }, ["invalid_payload"]],
      ["none 에 후속", { thread_id: s.thread_id, resolution: "none", reason: "x", followup: { kind: "none", description: "d" } }, ["invalid_payload"]],
      ["할 일에 단계 없음", { thread_id: s.thread_id, resolution: "next_round_task", reason: "x", followup: { kind: "next_round_task", description: "d" } }, ["invalid_payload"]],
      ["후속 없는 edit_text", { thread_id: s.thread_id, resolution: "edit_text", reason: "x" }, ["invalid_payload"]],
      ["모르는 스레드", { thread_id: "no-such-thread", resolution: "none", reason: "x" }, ["not_found"]],
      ["모르는 필드", { thread_id: s.thread_id, resolution: "none", reason: "x", surprise: 1 }, ["invalid_payload"]],
    ];
    for (const [i, [name, payload, codes]] of bad.entries()) {
      await rejects_api(env.service.execute(env.ctx(`rsb-${i}`), "thread.resolve", payload), ...codes).catch((e) => {
        throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    assert.equal(state_signature(env.db), sig);

    await run(env, "rs-ok", "thread.resolve", { thread_id: s.thread_id, resolution: "none", reason: "그냥 닫는다." });
    const after = state_signature(env.db);
    const err = await rejects_api(env.service.execute(env.ctx("rs-twice"), "thread.resolve", { thread_id: s.thread_id, resolution: "none", reason: "또 닫기" }), "conflict");
    assert.equal((err.details as any)?.reason, "already_resolved");
    assert.equal(state_signature(env.db), after);

    // 닫힌 스레드에는 답글도 못 단다
    const closed = await rejects_api(env.service.execute(env.ctx("rp-closed"), "thread.reply", { thread_id: s.thread_id, body_md: "닫힌 뒤" }), "conflict");
    assert.equal((closed.details as any)?.reason, "thread_closed");
    assert.equal(state_signature(env.db), after);
  });
});

test("thread.resolve 는 사람만: 리스를 쥔 에이전트도 forbidden(같은 리스로 답글은 되므로 리스 문제가 아니다), 쓰지 않는다", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const ag = await leased_agent(env, "agent-resolver");
    await env.service.execute(ag.ctx("ag-control"), "thread.reply", { thread_id: s.thread_id, body_md: "대조: 같은 리스로 답글은 된다", ...ag.guard });
    const sig = state_signature(env.db);
    await rejects_api(env.service.execute(ag.ctx("ag-res"), "thread.resolve", { thread_id: s.thread_id, resolution: "none", reason: "에이전트가 닫기", ...ag.guard }), "forbidden");
    await rejects_api(env.service.execute(ag.ctx("ag-res2"), "thread.resolve", { thread_id: s.thread_id, resolution: "edit_text", reason: "x", followup: { kind: "edit_text", proposed_body_md: NEW_BODY }, ...ag.guard }), "forbidden");
    assert.equal(state_signature(env.db), sig);
    assert.equal(thread_row(env.db, s.thread_id).state, "open");
  });
});

// ---------------------------------------------------------------------------
// followup.apply — edit_text 채택

async function proposed(env: Env, s: Awaited<ReturnType<typeof scene>>, key = "ap-p"): Promise<Out & { row: FollowupRow }> {
  const out = await run(env, key, "followup.propose", edit_proposal(s));
  return { ...out, row: followup_row(env.db, out.followup_id) };
}

test("followup.apply edit_text: 기반이 맞으면 제안 글이 새 버전으로 채택되고, 원문은 덮어쓰이지 않고, 해결·반영 내역은 따로다", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const p = await proposed(env, s);
    const reflections = count_of(env.db, "reflection_entries");
    const fv = followup_version_count(env.db, p.followup_id);
    const out = await run(env, "ap-1", "followup.apply", { followup_id: p.followup_id, base_version_id: s.art.version_id, expected_rev: String(p.row.version_no) });
    assert.equal(out.state, "applied");

    const receipt = receipt_of(env.db, env.p.project_id, "ap-1")!;
    assert.equal(receipt.action, "followup.apply");
    assert.ok(events_of(env.db, receipt.id).length >= 1);
    const f = followup_row(env.db, p.followup_id);
    assert.equal(f.state, "applied");
    assert.equal(f.version_no, p.row.version_no + 1);
    assert.equal(followup_version_count(env.db, p.followup_id), fv + 1, "제안 줄은 지워지지 않고 applied 줄이 더해진다");
    assert.equal(f.applied_tx_id, receipt.id, "적용 증거 = 이 호출의 tx");
    assert.equal(out.applied_tx_id, receipt.id);
    assert.ok(f.result_version_id);
    assert.equal(out.result_version_id, f.result_version_id);
    assert.equal(f.confirmed_by_actor_id, env.p.actor_id, "채택은 사람이 확정");
    assert.notEqual(f.result_version_id, s.art.version_id);
    assert.equal(body_of(env.db, f.result_version_id!), NEW_BODY, "새 버전이 제안 글");
    assert.equal(current_version_of(env.db, s.art.object_id), f.result_version_id, "현재 버전이 새 버전으로");
    assert.equal(body_of(env.db, s.art.version_id), BODY, "원문(옛 버전)은 덮어쓰이지 않았다");
    const based = env.db.get<{ b: string | null }>("SELECT based_on_version_id AS b FROM object_versions WHERE id = ?", f.result_version_id!)!.b;
    assert.equal(based, s.art.version_id, "새 버전의 기반은 옛 버전");

    assert.equal(thread_row(env.db, s.thread_id).state, "open", "적용은 스레드를 해결하지 않는다");
    assert.equal(count_of(env.db, "reflection_entries"), reflections, "적용은 반영 내역을 쓰지 않는다");

    // 한 번 적용된 후속은 다시 적용되지 않는다
    const sig = state_signature(env.db);
    await rejects_api(env.service.execute(env.ctx("ap-again"), "followup.apply", { followup_id: p.followup_id, base_version_id: f.result_version_id!, expected_rev: String(f.version_no) }), "conflict", "rev_conflict");
    assert.equal(state_signature(env.db), sig);
  });
});

test("followup.apply: 기반이 달라졌으면 채택은 실패하고(conflict basis_changed) 원문·현재 버전·제안 글·후속 상태가 그대로 보존된다", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const p = await proposed(env, s);
    // 그사이 누군가 글을 고쳤다: 새 현재 버전
    const edited = await text_version(env, "ap-edit", s.art.object_id, `${BODY} 그사이 다른 사람이 덧붙인 문장이다.`);
    const sig = state_signature(env.db);

    const err = await rejects_api(env.service.execute(env.ctx("ap-stale"), "followup.apply", { followup_id: p.followup_id, base_version_id: s.art.version_id, expected_rev: String(p.row.version_no) }), "conflict");
    assert.equal((err.details as any)?.reason, "basis_changed");
    assert.equal((err.details as any)?.expected, s.art.version_id);
    assert.equal((err.details as any)?.current, edited.version_id);
    assert.equal(state_signature(env.db), sig, "실패한 채택은 아무것도(행·영수증·사건) 남기지 않는다");

    assert.equal(current_version_of(env.db, s.art.object_id), edited.version_id);
    assert.equal(body_of(env.db, s.art.version_id), BODY);
    const f = followup_row(env.db, p.followup_id);
    assert.equal(f.state, "proposed");
    assert.equal(body_of(env.db, f.proposed_artifact_version_id!), NEW_BODY, "제안은 보존");

    // 새 현재 버전을 기반이라고 우겨도 후속의 기반(옛 버전)과 다르므로 마찬가지로 충돌
    const err2 = await rejects_api(env.service.execute(env.ctx("ap-stale2"), "followup.apply", { followup_id: p.followup_id, base_version_id: edited.version_id, expected_rev: String(p.row.version_no) }), "conflict");
    assert.equal((err2.details as any)?.reason, "basis_changed");
    // 전혀 모르는 기반 id 도 not_found 가 아니라 기반 충돌
    const err3 = await rejects_api(env.service.execute(env.ctx("ap-stale3"), "followup.apply", { followup_id: p.followup_id, base_version_id: "ver_stale_never_existed", expected_rev: String(p.row.version_no) }), "conflict");
    assert.equal((err3.details as any)?.reason, "basis_changed");
    assert.equal(state_signature(env.db), sig);
  });
});

test("followup.apply: expected_rev 가 다르면 rev_conflict(쓰지 않음), 사람이 아니면 forbidden, 모르는 후속·다른 프로젝트는 not_found", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const p = await proposed(env, s);
    const foreign = await second_project(env, "synthetic-sel99-h");
    const ag = await leased_agent(env, "agent-applier");
    const sig = state_signature(env.db);
    await rejects_api(env.service.execute(env.ctx("rev-bad"), "followup.apply", { followup_id: p.followup_id, base_version_id: s.art.version_id, expected_rev: "99" }), "rev_conflict");
    await rejects_api(env.service.execute(env.ctx("rev-neg"), "followup.apply", { followup_id: p.followup_id, base_version_id: s.art.version_id, expected_rev: "-1" }), "invalid_payload");
    await rejects_api(env.service.execute(env.ctx("no-f"), "followup.apply", { followup_id: "no-such-followup", base_version_id: s.art.version_id, expected_rev: "1" }), "not_found");
    await rejects_api(env.service.execute(env.ctx("surprise"), "followup.apply", { followup_id: p.followup_id, base_version_id: s.art.version_id, expected_rev: "1", surprise: 1 }), "invalid_payload");
    await rejects_api(
      env.service.execute({ project_id: foreign.project_id, actor_id: foreign.actor_id, via: "cli", client_request_id: "fx" }, "followup.apply", { followup_id: p.followup_id, base_version_id: s.art.version_id, expected_rev: "1" }),
      "not_found",
    );
    // 리스를 쥔 에이전트라도 채택은 사람만(제안만 한다)
    await rejects_api(env.service.execute(ag.ctx("ag-apply"), "followup.apply", { followup_id: p.followup_id, base_version_id: s.art.version_id, expected_rev: String(p.row.version_no), ...ag.guard }), "forbidden");
    assert.equal(state_signature(env.db), sig);
    assert.equal(followup_row(env.db, p.followup_id).state, "proposed");
  });
});

test("followup.apply next_round_task: 사람이 적용하면 applied(결과 버전·글 변화 없음), reopen_stage 는 에이전트가 적용할 수 없다", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const stages = stage_ids(env.db, env.p.edition_id);
    const task = await run(env, "nt-p", "followup.propose", { origin_thread_id: s.thread_id, kind: "next_round_task", description: "다음 라운드 할 일", target_stage_id: stages.research });
    const versions = artifact_version_count(env.db, s.art.object_id);
    const out = await run(env, "nt-a", "followup.apply", { followup_id: task.followup_id, base_version_id: s.art.version_id, expected_rev: "1" });
    assert.equal(out.state, "applied");
    const f = followup_row(env.db, task.followup_id);
    assert.equal(f.state, "applied");
    assert.equal(f.applied_tx_id, receipt_of(env.db, env.p.project_id, "nt-a")!.id);
    assert.equal(f.result_version_id, null);
    assert.equal(f.confirmed_by_actor_id, env.p.actor_id);
    assert.equal(artifact_version_count(env.db, s.art.object_id), versions);
    assert.equal(current_version_of(env.db, s.art.object_id), s.art.version_id);

    const reopen = await run(env, "ro-p", "followup.propose", { origin_thread_id: s.thread_id, kind: "reopen_stage", description: "다시 연다", target_stage_id: stages.plan });
    const ag = await leased_agent(env, "agent-reopener");
    const sig = state_signature(env.db);
    await rejects_api(env.service.execute(ag.ctx("ro-ag"), "followup.apply", { followup_id: reopen.followup_id, base_version_id: s.art.version_id, expected_rev: "1", ...ag.guard }), "forbidden");
    assert.equal(state_signature(env.db), sig);
    assert.equal(followup_row(env.db, reopen.followup_id).state, "proposed");
  });
});

// ---------------------------------------------------------------------------
// 반영 내역(SEL-93 reflection.create)과 이어지는 길

test("후속이 applied 일 때만 반영 내역(applied)의 증거가 된다: 제안 상태·해결만으로는 거절, 적용 뒤에는 followup_id + applied_tx_id 로 통과", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const { round_id } = await open_round(env, "refl");
    const p = await proposed(env, s);
    const entry = (extra: Record<string, unknown>) => ({ source_version_id: s.art.version_id, disposition: "applied", rationale: "첨언대로 본문을 고쳤다.", followup_id: p.followup_id, ...extra });
    const first_tx = env.db.get<{ id: string }>("SELECT id FROM mutation_commits WHERE project_id = ? ORDER BY rowid LIMIT 1", env.p.project_id)!.id;

    // 아직 제안일 뿐
    await rejects_api(env.service.execute(env.ctx("rf-0"), "reflection.create", { target_round_id: round_id, entries: [entry({ evidence_tx_id: first_tx })] }), "invalid_payload", "conflict");
    // 스레드를 해결해도 반영됨이 되지 않는다
    await run(env, "rf-res", "thread.resolve", { thread_id: s.thread_id, resolution: "none", reason: "따로 닫는다." });
    await rejects_api(env.service.execute(env.ctx("rf-1"), "reflection.create", { target_round_id: round_id, entries: [entry({ evidence_tx_id: first_tx })] }), "invalid_payload", "conflict");
    assert.equal(count_of(env.db, "reflection_entries"), 0);

    const applied = await run(env, "rf-apply", "followup.apply", { followup_id: p.followup_id, base_version_id: s.art.version_id, expected_rev: String(p.row.version_no) });
    const ok = await run(env, "rf-2", "reflection.create", { target_round_id: round_id, entries: [entry({ evidence_tx_id: applied.applied_tx_id, result_version_id: applied.result_version_id })] });
    assert.equal(ok.applied_count, 1);
    assert.equal(count_of(env.db, "reflection_entries"), 1);
  });
});

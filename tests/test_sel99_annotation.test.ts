/**
 * SEL-99 U4a — 선택 구간 첨언: 명령 annotation.create (tester, 작성 모드).
 * 구현 전에는 명령이 없어 실패하는 것이 정상이다("unknown_command").
 *
 * 있던 것: DDL anchors · anchor_resolutions · threads(context_kind 'annotation', CHECK 로 target_version_id·anchor_id 필수) · thread_versions ·
 *   messages · message_versions. 새 표 없음. 질문 의견 question.comment_add(SEL-90)는 그대로(회귀 가드는 test_sel99_thread_api.test.ts).
 *
 * ===== 이 이슈에서 스스로 정한 인터페이스(머리말 표) =====
 * | 이름 | 모양 |
 * |---|---|
 * | 명령 annotation.create | {target_object_id, target_version_id?(없으면 현재 버전), anchor:{exact_quote, prefix?, suffix?, start_cp?, end_cp?}, body_md, run_id?, lease_id?, fence?} |
 * |   결과 | {thread_id, message_id, message_version_id, anchor_id, anchor_status:'exact'|'moved', start_cp, end_cp, resolution_id, target_version_id} |
 * | 명령 annotation.reanchor | 재판정 {thread_id, version_id?(없으면 글의 현재 버전)} / 다시 붙이기(사람만) {thread_id, version_id?, start_cp, end_cp} — test_sel99_anchor_status |
 * | 명령 thread.reply | {thread_id, body_md, reply_to?, run_id?, lease_id?, fence?} (annotation·question_comment 스레드 모두) |
 * | 명령 thread.resolve | {thread_id, resolution:'edit_text'|'next_round_task'|'reopen_stage'|'none', reason, followup?:{…}} 사람만 — test_sel99_followup |
 * | 명령 followup.propose | {origin_thread_id, kind, description, proposed_body_md?, base_version_id?, target_stage_id?, target_round_id?, run_id?…} — test_sel99_followup |
 * | 명령 followup.apply | {followup_id, base_version_id, expected_rev} 사람만 — test_sel99_followup |
 * | HTTP | POST P/threads(annotation) · POST P/threads/{t}/messages · POST P/threads/{t}/resolutions · POST P/threads/{t}/reanchor · POST P/followups · POST P/followups/{f}/apply · GET P/threads · GET P/threads/{t} · GET P/followups — test_sel99_thread_api |
 * | A 도구 | thread.reply · followup.propose (allowlist 이름은 이미 있음 — 결정 0013) — test_sel99_agent_tools |
 * | B MCP | pes_thread_reply · pes_followup_propose (같은 명령) — test_sel99_agent_tools |
 *
 * ===== 앵커 규칙(정한 해석) =====
 * - 정규 텍스트 text_format_version=1: 글 버전의 body_md **그대로**(정규화·줄바꿈 변환 없음). 위치는 UTF-16 가 아니라 **code point(유니코드 스칼라)** 위치.
 *   😀 한 개는 1, 👨‍👩 (ZWJ 연결) 은 3, 한글 음절은 1.
 * - 만들 때: 인용문은 대상 버전 본문에 있어야 한다(없으면 거절 — HTTP 422 quote_not_found). 본문이 없는 버전(body_md NULL)도 거절.
 *   start_cp/end_cp 를 주면 end-start == 인용문 code point 수여야 하고, 그 자리에 인용문이 있으면 exact, 자리는 틀렸지만 (prefix/suffix 로 좁혀)
 *   한 곳으로 정해지면 moved(바로잡은 위치로), 그래도 여러 곳이면 거절(자동으로 고르지 않는다).
 *   start_cp/end_cp 를 안 주면 인용문이 (prefix/suffix 로 좁혀) 한 곳일 때만 exact 로 그 위치, 여러 곳이면 거절.
 * - 외톨이 서로게이트·빈 인용문·빈 본문·모르는 필드는 거절. 거절은 아무것도(행·영수증·사건) 남기지 않는다.
 * - 첫 판정은 anchor_resolutions 에 한 줄(evaluated_version_id = 대상 버전)로 남는다.
 * - 권한: 사람 소유자, 또는 리스를 쥔 에이전트(run:submit). 리스 없는 에이전트는 forbidden. 행위자는 부른 행위자.
 * - 한 호출 = 영수증 1(action 'annotation.create') + 사건 ≥ 1.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { COMMANDS } from "../scripts/pes_core/commands.ts";
import { with_api } from "./helpers/api_env.ts";
import { new_artifact, second_project } from "./helpers/blob_env.ts";
import { add_agent, events_of, receipt_of, rejects_api, with_env, type Env } from "./helpers/editions_env.ts";
import { single_spec } from "./helpers/questions_env.ts";
import { make_form } from "./helpers/sel90_env.ts";
import { state_signature } from "./helpers/state_signature.ts";
import {
  anchor_row,
  count_of,
  cp_find,
  cp_len,
  messages_of,
  resolutions_of,
  text_artifact,
  text_version,
  thread_row,
  type Out,
} from "./helpers/sel99_env.ts";

const QUOTE = "정책 대안은 두 가지다.";
const PREFIX = "2장 합성 정책 분석에서 ";
const SUFFIX = " 첫 번째는 현행 유지다.";
const EMOJI_SENTENCE = "문장입니다.";
const BODY =
  `${PREFIX}${QUOTE}${SUFFIX}\n\n| 항목 | 값 |\n|---|---|\n| 가 | 1 |\n| 나 | 2 |\n\n😀 이모지 뒤 ${EMOJI_SENTENCE} 👨‍👩 가족 문장이다.`;

async function annotate(env: Env, key: string, payload: Record<string, unknown>): Promise<Out> {
  return (await env.service.execute(env.ctx(key), "annotation.create", payload)).result as Out;
}

async function scene(env: Env, body = BODY, tag = "a") {
  return text_artifact(env, tag, body);
}

test("the U4a commands are registered", () => {
  for (const name of ["annotation.create", "annotation.reanchor", "thread.reply", "thread.resolve", "followup.propose", "followup.apply"]) {
    assert.ok(COMMANDS.has(name), `${name} is registered`);
  }
});

test("annotation.create: 인용문·prefix/suffix·code point 위치를 앵커로 저장하고 스레드·첫 메시지·첫 판정(exact)을 한 tx 로 남긴다", async () => {
  await with_env(async (env) => {
    const a = await scene(env);
    const pos = cp_find(BODY, QUOTE);
    const before = { threads: count_of(env.db, "threads"), anchors: count_of(env.db, "anchors"), msgs: count_of(env.db, "messages"), txs: count_of(env.db, "mutation_commits") };
    const out = await annotate(env, "an-1", {
      target_object_id: a.object_id,
      target_version_id: a.version_id,
      anchor: { exact_quote: QUOTE, prefix: PREFIX, suffix: SUFFIX, ...pos },
      body_md: "이 문장의 근거를 더 설명해 주세요.",
    });
    assert.equal(out.anchor_status, "exact");
    assert.equal(out.start_cp, pos.start_cp);
    assert.equal(out.end_cp, pos.end_cp);
    assert.equal(out.target_version_id, a.version_id);

    const t = thread_row(env.db, out.thread_id);
    assert.equal(t.context_kind, "annotation");
    assert.equal(t.target_object_id, a.object_id);
    assert.equal(t.target_version_id, a.version_id);
    assert.equal(t.anchor_id, out.anchor_id);
    assert.equal(t.state, "open");

    const anchor = env.db.get<any>("SELECT * FROM anchors WHERE id = ?", out.anchor_id)!;
    assert.equal(anchor.exact_quote, QUOTE);
    assert.equal(anchor.prefix, PREFIX);
    assert.equal(anchor.suffix, SUFFIX);
    assert.equal(Number(anchor.text_format_version), 1);
    assert.equal(Number(anchor.start_cp), pos.start_cp);
    assert.equal(Number(anchor.end_cp), pos.end_cp);
    assert.equal(anchor.target_object_id, a.object_id);
    assert.equal(anchor.target_version_id, a.version_id);
    assert.equal(anchor.supersedes_anchor_id, null);

    const res = resolutions_of(env.db, out.anchor_id);
    assert.equal(res.length, 1, "첫 판정 한 줄");
    assert.equal(res[0]!.status, "exact");
    assert.equal(res[0]!.evaluated_version_id, a.version_id);
    assert.equal(res[0]!.start_cp, pos.start_cp);
    assert.equal(res[0]!.end_cp, pos.end_cp);
    assert.equal(res[0]!.id, out.resolution_id);

    const msgs = messages_of(env.db, out.thread_id);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]!.body_md, "이 문장의 근거를 더 설명해 주세요.");
    assert.equal(msgs[0]!.state, "published");
    assert.equal(msgs[0]!.actor_id, env.p.actor_id);
    assert.equal(msgs[0]!.message_id, out.message_id);

    assert.equal(count_of(env.db, "threads") - before.threads, 1);
    assert.equal(count_of(env.db, "anchors") - before.anchors, 1);
    assert.equal(count_of(env.db, "messages") - before.msgs, 1);
    assert.equal(count_of(env.db, "mutation_commits") - before.txs, 1, "한 tx = 영수증 하나");
    const receipt = receipt_of(env.db, env.p.project_id, "an-1")!;
    assert.equal(receipt.action, "annotation.create");
    assert.ok(events_of(env.db, receipt.id).length >= 1, "사건이 남는다");
  });
});

test("annotation.create: 같은 키·같은 내용은 재생(행 변화 없음), 같은 키·다른 내용은 idempotency_key_reuse", async () => {
  await with_env(async (env) => {
    const a = await scene(env);
    const payload = { target_object_id: a.object_id, anchor: { exact_quote: QUOTE, prefix: PREFIX, suffix: SUFFIX }, body_md: "멱등 첨언" };
    const first = await env.service.execute(env.ctx("idem"), "annotation.create", payload);
    const sig = state_signature(env.db);
    const again = await env.service.execute(env.ctx("idem"), "annotation.create", payload);
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, first.result);
    assert.equal(state_signature(env.db), sig);
    await rejects_api(env.service.execute(env.ctx("idem"), "annotation.create", { ...payload, body_md: "다른 내용" }), "idempotency_key_reuse");
    assert.equal(state_signature(env.db), sig);
  });
});

test("target_version_id 가 없으면 글의 현재 버전, 있으면 그 옛 버전에 단다(옛 버전 앵커는 그 버전에서 exact)", async () => {
  await with_env(async (env) => {
    const a = await scene(env);
    const v2 = await text_version(env, "a-v2", a.object_id, `앞에 새 문단이 붙었다.\n\n${BODY}`);
    const on_current = await annotate(env, "cur", { target_object_id: a.object_id, anchor: { exact_quote: QUOTE, prefix: PREFIX, suffix: SUFFIX }, body_md: "현재 버전에" });
    assert.equal(on_current.target_version_id, v2.version_id);
    assert.equal(thread_row(env.db, on_current.thread_id).target_version_id, v2.version_id);
    assert.equal(on_current.anchor_status, "exact");
    assert.equal(on_current.start_cp, cp_find(`앞에 새 문단이 붙었다.\n\n${BODY}`, QUOTE).start_cp);

    const on_old = await annotate(env, "old", { target_object_id: a.object_id, target_version_id: a.version_id, anchor: { exact_quote: QUOTE, prefix: PREFIX, suffix: SUFFIX }, body_md: "옛 버전에" });
    assert.equal(on_old.target_version_id, a.version_id);
    assert.equal(on_old.anchor_status, "exact");
    assert.equal(on_old.start_cp, cp_find(BODY, QUOTE).start_cp);
  });
});

test("code point 위치: 이모지(서로게이트 쌍)·ZWJ 이모지·한글·표 뒤에서도 start_cp/end_cp 는 UTF-16 이 아니라 code point 다", async () => {
  await with_env(async (env) => {
    const a = await scene(env);
    // 😀 은 UTF-16 으로 2칸이지만 code point 로는 1칸이다.
    assert.notEqual(cp_find(BODY, EMOJI_SENTENCE).start_cp, BODY.indexOf(EMOJI_SENTENCE), "이 본문에서는 두 좌표가 실제로 다르다");
    const pos = cp_find(BODY, EMOJI_SENTENCE);
    const exact = await annotate(env, "emo-ok", { target_object_id: a.object_id, anchor: { exact_quote: EMOJI_SENTENCE, prefix: "😀 이모지 뒤 ", suffix: " 👨‍👩 가족", ...pos }, body_md: "이모지 뒤" });
    assert.equal(exact.anchor_status, "exact");
    assert.equal(exact.start_cp, pos.start_cp);
    assert.equal(exact.end_cp, pos.end_cp);

    // 클라이언트가 UTF-16 위치를 보내면(잘못된 좌표) 그 자리에는 인용문이 없다 — 한 곳으로 정해지니 moved, 서버가 code point 위치로 바로잡는다.
    const utf16_start = BODY.indexOf(EMOJI_SENTENCE);
    const wrong = await annotate(env, "emo-utf16", {
      target_object_id: a.object_id,
      anchor: { exact_quote: EMOJI_SENTENCE, prefix: "😀 이모지 뒤 ", suffix: " 👨‍👩 가족", start_cp: utf16_start, end_cp: utf16_start + EMOJI_SENTENCE.length },
      body_md: "UTF-16 좌표",
    });
    assert.equal(wrong.anchor_status, "moved");
    assert.equal(wrong.start_cp, pos.start_cp, "code point 위치로 바로잡힌다");
    assert.equal(wrong.end_cp, pos.end_cp);

    // ZWJ 로 이어 붙인 이모지(👨‍👩 = 3 code point) 바로 뒤의 한글
    const family = "가족 문장이다.";
    const fpos = cp_find(BODY, family);
    assert.equal(cp_len("👨‍👩"), 3);
    const f = await annotate(env, "emo-zwj", { target_object_id: a.object_id, anchor: { exact_quote: family, prefix: "👨‍👩 ", suffix: "", ...fpos }, body_md: "ZWJ 뒤" });
    assert.equal(f.anchor_status, "exact");
    assert.equal(f.start_cp, fpos.start_cp);

    // 인용문 자체가 이모지를 품어도 길이는 code point 수
    const inner = "😀 이모지 뒤 문장입니다.";
    const ipos = cp_find(BODY, inner);
    const i = await annotate(env, "emo-in", { target_object_id: a.object_id, anchor: { exact_quote: inner, prefix: "\n\n", suffix: " 👨‍👩", ...ipos }, body_md: "이모지가 든 인용" });
    assert.equal(i.end_cp - i.start_cp, cp_len(inner));
    assert.equal(i.anchor_status, "exact");
  });
});

test("표: 셀 경계(|)와 줄바꿈을 지나는 인용문도 그대로 저장되고 exact 로 붙는다", async () => {
  await with_env(async (env) => {
    const a = await scene(env);
    for (const [i, quote] of ["| 가 | 1 |", "| 가 | 1 |\n| 나 | 2 |", "|---|---|\n| 가"].entries()) {
      const pos = cp_find(BODY, quote);
      const out = await annotate(env, `tbl-${i}`, { target_object_id: a.object_id, anchor: { exact_quote: quote, ...pos }, body_md: `표 ${i}` });
      assert.equal(out.anchor_status, "exact", quote);
      assert.equal(out.start_cp, pos.start_cp);
      const stored = env.db.get<{ exact_quote: string }>("SELECT exact_quote FROM anchors WHERE id = ?", out.anchor_id)!;
      assert.equal(stored.exact_quote, quote, "인용문은 글자 그대로(줄바꿈 포함) 저장된다");
    }
  });
});

test("반복 인용: 위치를 주면 그 위치의 것, 위치가 없으면 prefix/suffix 가 가르는 한 곳, 가를 수 없으면 거절(자동으로 고르지 않는다)", async () => {
  await with_env(async (env) => {
    const REPEAT = "결론은 A다.";
    const body = `첫 단락. ${REPEAT} 둘째 단락.\n\n셋째 단락. ${REPEAT} 넷째 단락.`;
    const a = await scene(env, body, "rep");
    const first = cp_find(body, REPEAT, 0);
    const second = cp_find(body, REPEAT, 1);
    assert.notDeepEqual(first, second);

    const at_second = await annotate(env, "rep-pos", { target_object_id: a.object_id, anchor: { exact_quote: REPEAT, prefix: "셋째 단락. ", suffix: " 넷째", ...second }, body_md: "두 번째 것" });
    assert.equal(at_second.anchor_status, "exact");
    assert.equal(at_second.start_cp, second.start_cp);

    const by_context = await annotate(env, "rep-ctx", { target_object_id: a.object_id, anchor: { exact_quote: REPEAT, prefix: "첫 단락. ", suffix: " 둘째" }, body_md: "맥락으로 첫 번째" });
    assert.equal(by_context.start_cp, first.start_cp);
    assert.equal(by_context.anchor_status, "exact");

    const sig = state_signature(env.db);
    await rejects_api(env.service.execute(env.ctx("rep-amb"), "annotation.create", { target_object_id: a.object_id, anchor: { exact_quote: REPEAT }, body_md: "어느 것?" }), "invalid_payload", "validation_failed", "conflict");
    assert.equal(state_signature(env.db), sig, "거절은 아무것도 남기지 않는다 — 두 후보 중 하나를 대신 고르지 않는다");

    // 위치가 틀렸고 맥락도 못 가르면 마찬가지로 거절
    await rejects_api(
      env.service.execute(env.ctx("rep-wrong"), "annotation.create", { target_object_id: a.object_id, anchor: { exact_quote: REPEAT, start_cp: 0, end_cp: cp_len(REPEAT) }, body_md: "틀린 위치" }),
      "invalid_payload",
      "validation_failed",
      "conflict",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

test("거절: 본문에 없는 인용문·본문 없는 버전·빈 값·외톨이 서로게이트·길이가 안 맞는 위치·모르는 필드·없는 대상 — 아무것도 남기지 않는다", async () => {
  await with_env(async (env) => {
    const a = await scene(env);
    const no_body = await new_artifact(env, "nobody");
    const other = await text_artifact(env, "other", "다른 글의 본문이다.");
    const sig = state_signature(env.db);
    const base = { target_object_id: a.object_id, anchor: { exact_quote: QUOTE }, body_md: "첨언" };
    const bad: Array<[string, Record<string, unknown>, string[]]> = [
      ["quote 없음", { ...base, anchor: { exact_quote: "이 문장은 합성 본문에 없다." } }, ["invalid_payload", "validation_failed", "conflict"]],
      ["빈 인용문", { ...base, anchor: { exact_quote: "" } }, ["invalid_payload", "validation_failed"]],
      ["서로게이트 인용문", { ...base, anchor: { exact_quote: "\ud800" } }, ["invalid_payload", "validation_failed"]],
      ["서로게이트 prefix", { ...base, anchor: { exact_quote: QUOTE, prefix: "\udc00" } }, ["invalid_payload", "validation_failed"]],
      ["빈 첨언", { ...base, body_md: "   \n" }, ["invalid_payload", "validation_failed"]],
      ["서로게이트 첨언", { ...base, body_md: "\ud800" }, ["invalid_payload", "validation_failed"]],
      ["길이 불일치", { ...base, anchor: { exact_quote: QUOTE, start_cp: 5, end_cp: 7 } }, ["invalid_payload", "validation_failed"]],
      ["end < start", { ...base, anchor: { exact_quote: QUOTE, start_cp: 20, end_cp: 5 } }, ["invalid_payload", "validation_failed"]],
      ["음수 위치", { ...base, anchor: { exact_quote: QUOTE, start_cp: -1, end_cp: cp_len(QUOTE) - 1 } }, ["invalid_payload", "validation_failed"]],
      ["한쪽 위치만", { ...base, anchor: { exact_quote: QUOTE, start_cp: 5 } }, ["invalid_payload", "validation_failed"]],
      ["모르는 anchor 필드", { ...base, anchor: { exact_quote: QUOTE, color: "red" } }, ["invalid_payload"]],
      ["모르는 필드", { ...base, surprise: 1 }, ["invalid_payload"]],
      ["anchor 없음", { target_object_id: a.object_id, body_md: "첨언" }, ["invalid_payload"]],
      ["없는 글", { ...base, target_object_id: "no-such-object" }, ["not_found"]],
      ["다른 글의 버전", { ...base, target_version_id: other.version_id }, ["not_found", "conflict", "invalid_payload"]],
      ["없는 버전", { ...base, target_version_id: "no-such-version" }, ["not_found"]],
      ["본문 없는 버전", { target_object_id: no_body.object_id, anchor: { exact_quote: QUOTE }, body_md: "첨언" }, ["invalid_payload", "validation_failed", "conflict"]],
    ];
    for (const [i, [name, payload, codes]] of bad.entries()) {
      await rejects_api(env.service.execute(env.ctx(`bad-${i}`), "annotation.create", payload), ...codes).catch((e) => {
        throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    assert.equal(state_signature(env.db), sig, "거절된 요청은 행도 영수증도 사건도 남기지 않는다");
  });
});

test("질문은 첨언 대상이 아니다(질문 의견은 question.comment_add): annotation.create 에 질문 id 를 주면 거절한다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("질문")]);
    const sig = state_signature(env.db);
    await rejects_api(
      env.service.execute(env.ctx("q-1"), "annotation.create", { target_object_id: f.ids[0]!, anchor: { exact_quote: "질문" }, body_md: "x" }),
      "invalid_payload",
      "validation_failed",
      "conflict",
      "not_found",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

test("권한: 리스 없는 에이전트는 forbidden(아무것도 안 씀), 다른 프로젝트의 글은 not_found", async () => {
  await with_env(async (env) => {
    const a = await scene(env);
    const agent = add_agent(env, "agent-sel99-a");
    const sig = state_signature(env.db);
    await rejects_api(
      env.service.execute({ ...agent, client_request_id: "ag-1" }, "annotation.create", { target_object_id: a.object_id, anchor: { exact_quote: QUOTE }, body_md: "리스 없음" }),
      "forbidden",
    );
    const foreign = await second_project(env, "synthetic-sel99-a");
    await rejects_api(
      env.service.execute({ project_id: foreign.project_id, actor_id: foreign.actor_id, via: "cli", client_request_id: "fx" }, "annotation.create", { target_object_id: a.object_id, anchor: { exact_quote: QUOTE }, body_md: "다른 프로젝트" }),
      "not_found",
    );
    assert.equal(state_signature(env.db).includes("다른 프로젝트"), false);
    assert.ok(sig.length > 0);
  });
});

test("원래 앵커와 글 원문은 만든 뒤에도 바뀌지 않는다(첨언을 더 달아도)", async () => {
  await with_env(async (env) => {
    const a = await scene(env);
    const one = await annotate(env, "imm-1", { target_object_id: a.object_id, anchor: { exact_quote: QUOTE, prefix: PREFIX, suffix: SUFFIX }, body_md: "하나" });
    const frozen = anchor_row(env.db, one.anchor_id);
    const body_before = env.db.get<{ b: string }>("SELECT body_md AS b FROM artifact_versions WHERE version_id = ?", a.version_id)!.b;
    await annotate(env, "imm-2", { target_object_id: a.object_id, anchor: { exact_quote: "| 가 | 1 |" }, body_md: "둘" });
    await annotate(env, "imm-3", { target_object_id: a.object_id, anchor: { exact_quote: QUOTE, prefix: PREFIX, suffix: SUFFIX }, body_md: "같은 구간에 또 하나" });
    assert.equal(anchor_row(env.db, one.anchor_id), frozen);
    assert.equal(env.db.get<{ b: string }>("SELECT body_md AS b FROM artifact_versions WHERE version_id = ?", a.version_id)!.b, body_before);
    assert.equal(count_of(env.db, "threads"), 3, "같은 구간이어도 스레드는 따로(합치지 않는다)");
  });
});

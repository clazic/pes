/**
 * SEL-112 최종 검토 2 필수 1 — 다시 붙이기(사람이 고른 구간 확정)는 "선택을 만든 글 버전"을 함께 받아, 그 버전이 지금 글 버전(= 서버 현재 판정 버전,
 * anchor.current.evaluated_version_id 는 늘 글의 현재 버전 기준이다)과 다르면 거절한다. 옛 글에서 고른 좌표가 새 글의 엉뚱한 구간에
 * 사람 확정(method=manual)으로 저장되지 않게.
 *
 * 정한 해석:
 *   annotation.reanchor / POST P/threads/{t}/reanchor 에 basis_version_id?(선택을 만든 글 버전 id).
 *   주어지면: basis_version_id ≠ 글의 현재 버전, 또는 version_id 가 함께 주어졌는데 basis_version_id 와 다르면
 *     명령은 conflict(details.reason 'basis_changed', expected = basis_version_id, current = 글의 현재 버전),
 *     HTTP 는 409 basis_changed target $.body.basis_version_id details {expected, current} next_action reread_thread — 영수증 · 판정 줄(anchor_resolutions) · 사건 아무것도 안 쓴다.
 *   같으면 지금처럼 확정한다(그 버전 기준 판정 줄 하나).
 *   주지 않으면 지금과 같다(기존 U4a 호출 호환).
 * 합성 자료뿐(실제 자료·키·경로 없음).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { assert_ok, call, with_api, type ApiEnv, type Auth } from "./helpers/api_env.ts";
import { P, assert_final_error } from "./helpers/api_flow.ts";
import { rejects_api, with_env, type Env } from "./helpers/editions_env.ts";
import { state_signature } from "./helpers/state_signature.ts";
import { all_resolution_count, cp_find, cp_slice, resolutions_of, text_artifact, text_version, type Out } from "./helpers/sel99_env.ts";

const QUOTE = "정책 대안은 두 가지다.";
const PREFIX = "2장 합성 정책 분석에서 ";
const SUFFIX = " 첫 번째는 현행 유지다.";
const V1 = `머리글\n\n${PREFIX}${QUOTE}${SUFFIX}\n\n마무리 문단이다.`;
// 본문 앞에 문장을 넣은 v2 — v1 좌표는 v2 에서 다른 글자를 가리킨다
const V2 = `새로 삽입한 문장입니다. ${V1}`;

async function annotate(env: Env, key: string, payload: Record<string, unknown>): Promise<Out> {
  return (await env.service.execute(env.ctx(key), "annotation.create", payload)).result as Out;
}

test("명령: v1 에서 고른 좌표(basis v1)로 v2 가 현재인 글에 다시 붙이면 conflict basis_changed — 판정 줄 · 상태 그대로", async () => {
  await with_env(async (env) => {
    const art = await text_artifact(env, "bs", V1);
    const note = await annotate(env, "bs-an", { target_object_id: art.object_id, anchor: { exact_quote: QUOTE, prefix: PREFIX, suffix: SUFFIX, ...cp_find(V1, QUOTE) }, body_md: "첨언" });
    const v2 = await text_version(env, "bs-v2", art.object_id, V2);
    const pick = cp_find(V1, QUOTE);
    assert.notEqual(cp_slice(V2, pick.start_cp, pick.end_cp), QUOTE, "v1 좌표는 v2 에서 다른 구간이다");

    const rows = all_resolution_count(env.db);
    const sig = state_signature(env.db);
    // 앱이 옛 선택 좌표에 현재 버전을 붙여 보내는 경우(version_id = v2, basis = v1)
    const err = await rejects_api(env.service.execute(env.ctx("bs-r1"), "annotation.reanchor", { thread_id: note.thread_id, version_id: v2.version_id, basis_version_id: art.version_id, ...pick }), "conflict");
    assert.equal((err.details as any)?.reason, "basis_changed");
    assert.equal((err.details as any)?.expected, art.version_id);
    assert.equal((err.details as any)?.current, v2.version_id);
    // version_id 없이 basis 만(옛 버전)
    const err2 = await rejects_api(env.service.execute(env.ctx("bs-r2"), "annotation.reanchor", { thread_id: note.thread_id, basis_version_id: art.version_id, ...pick }), "conflict");
    assert.equal((err2.details as any)?.reason, "basis_changed");
    // version_id 와 basis 가 다르면(basis 는 현재여도) 거절
    const err3 = await rejects_api(env.service.execute(env.ctx("bs-r3"), "annotation.reanchor", { thread_id: note.thread_id, version_id: art.version_id, basis_version_id: v2.version_id, ...pick }), "conflict");
    assert.equal((err3.details as any)?.reason, "basis_changed");
    assert.equal(all_resolution_count(env.db), rows, "anchor_resolutions 줄이 늘지 않는다");
    assert.equal(state_signature(env.db), sig);

    // 지금 버전에서 고른 좌표(basis = 현재)는 확정된다
    const now = cp_find(V2, QUOTE);
    const ok = (await env.service.execute(env.ctx("bs-ok"), "annotation.reanchor", { thread_id: note.thread_id, basis_version_id: v2.version_id, ...now })).result as Out;
    assert.equal(ok.evaluated_version_id, v2.version_id);
    assert.equal(ok.start_cp, now.start_cp);
    assert.equal(all_resolution_count(env.db), rows + 1);
  });
});

const post = (env: ApiEnv, rest: string, auth: Auth, body: unknown, key?: string) =>
  call(env, { method: "POST", path: P(env, rest), auth, body, ...(key === undefined ? {} : { key }) });

test("HTTP: POST P/threads/{t}/reanchor 옛 basis_version_id 는 409 basis_changed(target $.body.basis_version_id) · anchor_resolutions 0 증가", async () => {
  await with_api(async (env) => {
    const art = await text_artifact(env, "hb", V1);
    const created = assert_ok(
      await post(env, "/threads", "owner", {
        target_object_id: art.object_id,
        target_version_id: art.version_id,
        context_kind: "annotation",
        anchor: { exact_quote: QUOTE, prefix: PREFIX, suffix: SUFFIX, ...cp_find(V1, QUOTE) },
        initial_message: { body_md: "첨언" },
      }),
      201,
    );
    const thread_id = created.thread.id as string;
    const anchor_id = created.thread.anchor_id as string;
    const v2 = await text_version(env, "hb-v2", art.object_id, V2);
    const before = resolutions_of(env.db, anchor_id).length;
    const sig = state_signature(env.db);

    const err = assert_final_error(
      await post(env, `/threads/${thread_id}/reanchor`, "owner", { version_id: v2.version_id, basis_version_id: art.version_id, ...cp_find(V1, QUOTE) }),
      409,
      "basis_changed",
      { target: "$.body.basis_version_id", next_action: "reread_thread" },
    );
    assert.equal((err as any).details?.expected, art.version_id);
    assert.equal((err as any).details?.current, v2.version_id);
    assert.equal(resolutions_of(env.db, anchor_id).length, before);
    assert.equal(state_signature(env.db), sig);

    const now = cp_find(V2, QUOTE);
    const ok = assert_ok(await post(env, `/threads/${thread_id}/reanchor`, "owner", { version_id: v2.version_id, basis_version_id: v2.version_id, ...now }), 201);
    assert.equal(ok.anchor.evaluated_version_id, v2.version_id);
    assert.equal(ok.anchor.start_cp, now.start_cp);
    assert.equal(resolutions_of(env.db, anchor_id).length, before + 1);
  });
});

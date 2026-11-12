/**
 * SEL-126 — 라운드 읽기(GET P/stages/{s}/rounds/{rd})에 그 라운드의 결과 글(현재 버전)을 싣는다 (tester, 작성 모드).
 * 서버 읽기 전용 · 새 표 없음 · 쓰기 0. 합성 자료만. 구현 전에는 `result` 칸이 없어 실패하는 시험이 정상이다.
 *
 * ═══ 정한 인터페이스 (worker 가 맞춘다) ═══
 *   data.result = null | { object_id: string, version_id: string, body_md: string }          // 기존 칸(edition·stage·round_id·set_id·questions …)은 그대로
 *
 *   · "그 라운드의 결과 글" = 그 라운드가 봉인될 때 round_contents 에 role 'result' 로 담긴 글 객체(여러 개면 position 이 가장 앞선 것).
 *     봉인 전(열린 라운드) · 단계 시작 자리(start) · 결과가 담기지 않은 라운드는 result: null — 칸은 늘 있고(null), 지어내지 않는다.
 *   · (SEL-126 후속) result 는 version_no(10진 글) · title · created_at(ISO) 도 싣는다 — 같은 현재 버전의 값. 앱은 서버가 준 값만 쓴다.
 *   · "현재 버전" = objects.current_version_id — 첨언·다시 붙이기(basis_version_id)가 판정하는 버전과 같다(append_version 은 안 옮기고, content.set_current · edit_text 채택이 옮긴다).
 *   · version_id · body_md 는 그 글 객체의 **현재 버전**(objects.current_version_id)의 값이다. 봉인 뒤 글에 새 버전이 붙으면 새 버전 값이 실린다
 *     (봉인 때 담은 옛 버전이 아니다). body_md 는 artifact_versions.body_md 그대로(정규화 없음).
 *   · 권한은 기존 라운드 읽기와 같다: 소유자 세션 또는 context:read 토큰. 무자격 401 · 범위 없는 토큰 403 (결과 칸이 권한을 넓히지 않는다).
 *   · AI 참조 금지(SEL-115, scripts/pes_core/commands/file_access.ts): 호출자가 사람(소유자 세션)이 아니고, 결과 글의 **현재 버전**이
 *     닫힌 파일을 품으면(본문 파일 또는 붙은 파일이 ai_access deny — artifact_version_denied / version_ai_denied, 버전 단위) 그 호출자의 응답은
 *     `result: null` 이다. 흔적 없음: 응답 어디에도 그 글의 object_id · version_id · 본문이 없다(SEL-115 "no trace"). 같은 일을 사람(소유자)은 그대로 본다.
 *     버전 단위라서: 옛 버전이 닫혔어도 현재 버전이 열려 있으면 AI 도 현재 버전을 본다. 현재 버전이 닫히면 가려진다. 열면(allow) 다시 보인다.
 *   · 판: 기존 규칙 그대로 — 라운드 경로는 활성 판의 자료이고 data.edition 이 작업 공간의 활성 판 번호와 같다. 결과는 그 자리(단계+라운드)의 것만 싣는다
 *     (다른 라운드의 결과가 새지 않는다).
 *   · 읽기는 아무것도 쓰지 않는다(state_signature 불변).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { add_artifact, add_source, append_version, create_object, set_current } from "../scripts/pes_core/content.ts";
import { assert_error, assert_ok, call, make_agent, OPENAPI_PATH, with_api, type ApiEnv, type Auth } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { attach, new_artifact, put_ready } from "./helpers/blob_env.ts";
import { seal, start } from "./helpers/editions_env.ts";
import { make_form, owner_get, single_spec } from "./helpers/sel90_env.ts";
import { set_access } from "./helpers/sel115_env.ts";
import { state_signature } from "./helpers/state_signature.ts";
import { cp_find, current_version_of } from "./helpers/sel99_env.ts";

const BODY_1 = "# 합성 결과 글\n\n첫 판 본문 MARK-R126-V1 입니다.\r\n둘째 줄  끝";
const BODY_2 = "# 합성 결과 글\n\n고친 본문 MARK-R126-V2 입니다.";
const BODY_3 = "# 합성 결과 글\n\n세 번째 본문 MARK-R126-V3 입니다.";
const round_path = (place: string) => `/stages/plan/rounds/${place}`;

interface Ver {
  object_id: string;
  version_id: string;
}

/** 본문(body_md)이 있는 글 객체와 첫 버전. */
async function new_result(env: ApiEnv, key: string, body_md: string): Promise<Ver> {
  const obj = (await create_object(env.service, env.ctx(`${key}-o`), { kind: "artifact", edition_id: env.p.edition_id })).result as { object_id: string };
  const out = await add_artifact(env.service, env.ctx(`${key}-v`), { object_id: obj.object_id, artifact_kind: "chapter", title: `합성 결과 ${key}`, summary: "합성 요약", body_md });
  return { object_id: obj.object_id, version_id: (out.result as { version_id: string }).version_id };
}

/** 다음 버전을 붙인다. make_current 면 현재 버전으로도 올린다(content.set_current — 첨언 판정이 쓰는 objects.current_version_id). */
async function next_version(env: ApiEnv, key: string, object_id: string, body_md: string, make_current = true): Promise<Ver> {
  const out = await append_version(env.service, env.ctx(key), { object_id, title: `합성 결과 ${key}`, body_md });
  const version_id = (out.result as { version_id: string }).version_id;
  if (make_current) await set_current(env.service, env.ctx(`${key}-cur`), { object_id, version_id });
  return { object_id, version_id };
}

/** 그 버전에 파일을 붙이고 AI 참조를 닫는다(사람 소유자 요청). 파일 정책 id 를 돌려준다. */
async function close_version(env: ApiEnv, version_id: string, tag: string): Promise<string> {
  const bytes = new TextEncoder().encode(`합성 첨부 ${tag}`);
  const blob = await put_ready(env, bytes, `${tag}-blob`);
  const att = await attach(env, version_id, blob.blob_id, "attachment", `${tag}-att`);
  assert_ok(await set_access(env, att.file_policy_id, "deny"));
  return att.file_policy_id;
}

/** 열린 라운드 1과 폼을 만들고, 결과 글을 봉인한다(봉인 때 담은 버전 = 첫 버전). */
async function sealed_round(env: ApiEnv, tag: string, body = BODY_1) {
  const form = await make_form(env, [single_spec("질문")], tag);
  const result = await new_result(env, `${tag}-res`, body);
  return { form, result, seal: () => seal(env, form.round_id, [result], `${tag}-seal`) };
}

const get_as = (env: ApiEnv, place: string, auth: Auth) => call(env, { method: "GET", path: P(env, round_path(place)), auth });

// ---------------------------------------------------------------------------
// (1) 결과 글이 있으면 현재 버전 값이 실린다

test("[신규] 결과 글이 있는 라운드 읽기: result{object_id, version_id, body_md} 가 현재 버전 값이다 · 기존 칸은 그대로", async () => {
  await with_api(async (env) => {
    const s = await sealed_round(env, "a1");
    await s.seal();
    const data = assert_ok(await owner_get(env, round_path("1")));
    assert.ok(data.result, "결과 글이 실린다");
    assert.equal(data.result.object_id, s.result.object_id);
    assert.equal(data.result.version_id, s.result.version_id);
    assert.equal(data.result.body_md, BODY_1, "본문은 그대로(줄바꿈·공백 정규화 없음)");
    // 기존 칸은 건드리지 않는다
    assert.equal(data.stage, "plan");
    assert.equal(data.round_id, 1);
    assert.equal(data.set_id, s.form.set.set_id);
    assert.equal(data.questions.length, 1);
    assert.equal(data.state, "closed");
  });
});

test("[신규] 결과 글에 새 버전이 붙으면 새 버전의 version_id · body_md 가 실린다(봉인 때 버전이 아니다)", async () => {
  await with_api(async (env) => {
    const s = await sealed_round(env, "a2");
    await s.seal();
    const first = assert_ok(await owner_get(env, round_path("1")));
    assert.equal(first.result.body_md, BODY_1);
    const v2 = await next_version(env, "a2-v2", s.result.object_id, BODY_2);
    assert.notEqual(v2.version_id, s.result.version_id);
    const second = assert_ok(await owner_get(env, round_path("1")));
    assert.equal(second.result.object_id, s.result.object_id, "같은 글 객체");
    assert.equal(second.result.version_id, v2.version_id);
    assert.equal(second.result.body_md, BODY_2);
    const v3 = await next_version(env, "a2-v3", s.result.object_id, BODY_3);
    const third = assert_ok(await owner_get(env, round_path("1")));
    assert.equal(third.result.version_id, v3.version_id);
    assert.equal(third.result.body_md, BODY_3);
  });
});

test("[신규] '현재 버전'은 objects.current_version_id — append_version 만으로는 안 바뀌고, set_current 가 옮긴다 · 첨언이 판정하는 버전과 같다", async () => {
  await with_api(async (env) => {
    const s = await sealed_round(env, "a3");
    await s.seal();
    const read = async () => assert_ok(await owner_get(env, round_path("1"))).result;
    assert.equal((await read()).version_id, current_version_of(env.db, s.result.object_id));
    // 붙이기만 한 버전(현재로 안 올림)은 결과 읽기에 안 나온다
    const loose = await next_version(env, "a3-loose", s.result.object_id, BODY_2, false);
    assert.equal((await read()).version_id, s.result.version_id);
    assert.equal(current_version_of(env.db, s.result.object_id), s.result.version_id);
    // 첨언 다시 붙이기: 결과가 준 version_id 가 basis 로 통과하고, 붙이기만 한 버전을 basis 로 하면 basis_changed
    const note = (await env.service.execute(env.ctx("a3-an"), "annotation.create", { target_object_id: s.result.object_id, anchor: { exact_quote: "MARK-R126-V1", prefix: "첫 판 본문 ", suffix: " 입니다.", start_cp: 17, end_cp: 29 }, body_md: "첨언" })).result as { thread_id: string };
    const pos = { start_cp: 17, end_cp: 29 };
    const bad = await env.service.execute(env.ctx("a3-bad"), "annotation.reanchor", { thread_id: note.thread_id, basis_version_id: loose.version_id, ...pos }).then(
      () => null,
      (error: unknown) => error as { details?: { reason?: string } },
    );
    assert.equal(bad?.details?.reason, "basis_changed");
    const ok = (await env.service.execute(env.ctx("a3-ok"), "annotation.reanchor", { thread_id: note.thread_id, basis_version_id: (await read()).version_id, ...pos })).result as { evaluated_version_id: string };
    assert.equal(ok.evaluated_version_id, s.result.version_id);
    // set_current 가 옮기면 결과 읽기도 같이 옮긴다
    await set_current(env.service, env.ctx("a3-cur"), { object_id: s.result.object_id, version_id: loose.version_id });
    assert.equal((await read()).version_id, loose.version_id);
    assert.equal((await read()).version_id, current_version_of(env.db, s.result.object_id));
    assert.equal((await read()).body_md, BODY_2);
  });
});

test("[신규] result 는 version_no(10진 글) · title · created_at(ISO) 도 같은 현재 버전의 값으로 싣는다", async () => {
  await with_api(async (env) => {
    const s = await sealed_round(env, "a4");
    await s.seal();
    const first = assert_ok(await owner_get(env, round_path("1"))).result;
    assert.equal(first.version_no, "1");
    assert.equal(first.title, "합성 결과 a4-res");
    assert.equal(typeof first.created_at, "string");
    assert.ok(!Number.isNaN(new Date(first.created_at).getTime()) && new Date(first.created_at).toISOString() === first.created_at, "ISO 8601");
    await next_version(env, "a4-v2", s.result.object_id, BODY_2);
    const second = assert_ok(await owner_get(env, round_path("1"))).result;
    assert.equal(second.version_no, "2");
    assert.equal(second.title, "합성 결과 a4-v2", "제목도 현재 버전의 것");
    // 비사람에게 가려진 경우 이 값들도 흔적이 없다
    await close_version(env, second.version_id, "a4-close");
    const reader = await make_agent(env, "reader", ["context:read"]);
    const res = await get_as(env, "1", { token: reader.token });
    assert.equal(assert_ok(res).result, null);
    assert.ok(!JSON.stringify(res.json).includes("합성 결과 a4-v2"));
  });
});

// ---------------------------------------------------------------------------
// (2) 결과 글이 없으면 null

test("[신규] 결과 글이 없는 라운드는 result:null — 칸은 있고, 봉인 전 · 결과 없이 봉인한 라운드 · 단계 시작 자리 모두", async () => {
  await with_api(async (env) => {
    const form = await make_form(env, [single_spec("질문")], "b1");
    // 열린(봉인 전) 라운드: 글 객체가 있어도 아직 이 라운드의 결과로 담기지 않았다
    await new_result(env, "b1-res", BODY_1);
    const open = assert_ok(await owner_get(env, round_path("1")));
    assert.ok("result" in open, "result 칸은 늘 있다");
    assert.equal(open.result, null);
    // 결과 없이 봉인한 라운드
    await seal(env, form.round_id, [], "b1-seal").catch(() => undefined);
    const after = assert_ok(await owner_get(env, round_path("1")));
    assert.ok("result" in after);
    assert.equal(after.result, null, "결과가 담기지 않았으면 지어내지 않는다");
    // 단계 시작 자리
    const start_place = await owner_get(env, round_path("start"));
    if (start_place.status === 200) {
      assert.ok("result" in start_place.json.data);
      assert.equal(start_place.json.data.result, null);
    } else {
      assert_error(start_place, 404, "not_found");
    }
  });
});

test("[신규] 폼이 없는 라운드도 결과가 있으면 싣는다(결과 칸은 폼과 무관), 결과가 없으면 null", async () => {
  await with_api(async (env) => {
    const s = await sealed_round(env, "b2");
    await s.seal();
    // 같은 단계의 다음 라운드(폼 없음, 열림): result null
    const r2 = await start(env, s.form.stage_id, "b2-start2");
    assert.ok(r2.round_id);
    const second = assert_ok(await owner_get(env, round_path("2")));
    assert.equal(second.set_id, null);
    assert.deepEqual(second.questions, []);
    assert.equal(second.result, null);
    // 1번 라운드의 결과는 2번 라운드 읽기에 새지 않고, 1번 읽기에는 그대로 있다
    const first = assert_ok(await owner_get(env, round_path("1")));
    assert.equal(first.result.version_id, s.result.version_id);
  });
});

// ---------------------------------------------------------------------------
// (3) 권한

test("[신규] 권한은 기존 라운드 읽기와 같다 — 무자격 401 · 범위 없는 토큰 403 · context:read 토큰은 열린 결과를 본다", async () => {
  await with_api(async (env) => {
    const s = await sealed_round(env, "c1");
    await s.seal();
    const reader = await make_agent(env, "reader", ["context:read"]);
    const writer = await make_agent(env, "writer", ["run:submit"]);
    assert_error(await get_as(env, "1", "none"), 401, "unauthenticated");
    assert_error(await get_as(env, "1", { token: writer.token }), 403, "forbidden");
    const ok = assert_ok(await get_as(env, "1", { token: reader.token }));
    assert.equal(ok.result.object_id, s.result.object_id);
    assert.equal(ok.result.version_id, s.result.version_id);
    assert.equal(ok.result.body_md, BODY_1, "닫힌 파일이 없으면 AI 도 본문을 받는다");
    assert_error(await call(env, { method: "GET", path: "/api/v1/projects/no-such-project" + round_path("1"), auth: "owner" }), 404, "not_found");
    assert_error(await call(env, { method: "POST", path: P(env, round_path("1")), auth: "owner", body: {} }), 405, "method_not_allowed");
  });
});

// ---------------------------------------------------------------------------
// (4) AI 참조 금지 — 비사람 호출자에게 현재 버전이 닫힌 파일을 품으면 result:null (흔적 없음), 사람은 본다

test("[신규] 현재 버전이 닫힌 파일을 품으면 비사람 호출자는 result:null · 흔적 없음, 소유자(사람)는 본문까지 본다", async () => {
  await with_api(async (env) => {
    const s = await sealed_round(env, "d1");
    await close_version(env, s.result.version_id, "d1");
    await s.seal();
    const reader = await make_agent(env, "reader", ["context:read"]);
    const ai = await make_agent(env, "inner", ["context:read"], "internal_ai");
    for (const who of [reader, ai]) {
      const res = await get_as(env, "1", { token: who.token });
      const data = assert_ok(res);
      assert.ok("result" in data, "칸은 있다");
      assert.equal(data.result, null, "닫힌 파일을 품은 버전은 비사람에게 가려진다");
      const wire = JSON.stringify(res.json);
      assert.ok(!wire.includes("MARK-R126-V1"), "본문 흔적 없음");
      assert.ok(!wire.includes(s.result.object_id), "글 객체 id 흔적 없음");
      assert.ok(!wire.includes(s.result.version_id), "글 버전 id 흔적 없음");
      assert.equal(data.questions.length, 1, "질문 읽기는 그대로(결과만 가린다)");
    }
    const human = assert_ok(await owner_get(env, round_path("1")));
    assert.equal(human.result.object_id, s.result.object_id);
    assert.equal(human.result.version_id, s.result.version_id);
    assert.equal(human.result.body_md, BODY_1, "사람은 닫힌 파일이 있어도 본다");
  });
});

test("[신규] 판단 단위는 현재 버전: 옛 버전이 닫혀도 새 버전이 열려 있으면 AI 도 새 버전을 받는다", async () => {
  await with_api(async (env) => {
    const s = await sealed_round(env, "d2");
    await close_version(env, s.result.version_id, "d2-old");
    await s.seal();
    const reader = await make_agent(env, "reader", ["context:read"]);
    assert.equal(assert_ok(await get_as(env, "1", { token: reader.token })).result, null, "현재(첫) 버전이 닫혀 있는 동안은 가려진다");
    const v2 = await next_version(env, "d2-v2", s.result.object_id, BODY_2);
    const seen = assert_ok(await get_as(env, "1", { token: reader.token }));
    assert.ok(seen.result, "현재 버전(v2)에는 닫힌 파일이 없다");
    assert.equal(seen.result.version_id, v2.version_id);
    assert.equal(seen.result.body_md, BODY_2);
  });
});

test("[신규] 새 버전이 닫힌 파일을 품으면 그 순간부터 가려지고, 다시 열면(allow) 보인다", async () => {
  await with_api(async (env) => {
    const s = await sealed_round(env, "d3");
    await s.seal();
    const reader = await make_agent(env, "reader", ["context:read"]);
    assert.equal(assert_ok(await get_as(env, "1", { token: reader.token })).result.body_md, BODY_1);
    const v2 = await next_version(env, "d3-v2", s.result.object_id, BODY_2);
    const fp = await close_version(env, v2.version_id, "d3-new");
    const closed = await get_as(env, "1", { token: reader.token });
    assert.equal(assert_ok(closed).result, null);
    assert.ok(!JSON.stringify(closed.json).includes("MARK-R126-V2"));
    assert.equal(assert_ok(await owner_get(env, round_path("1"))).result.body_md, BODY_2, "사람은 그대로");
    assert_ok(await set_access(env, fp, "allow"));
    const reopened = assert_ok(await get_as(env, "1", { token: reader.token }));
    assert.equal(reopened.result.version_id, v2.version_id);
    assert.equal(reopened.result.body_md, BODY_2);
  });
});

// ---------------------------------------------------------------------------
// (5) 판 · 라운드 경계

test("[신규] 판 번호는 기존 규칙 그대로(작업 공간의 활성 판과 같다), 결과는 그 자리의 것만 — 다른 라운드 결과가 새지 않는다", async () => {
  await with_api(async (env) => {
    const s = await sealed_round(env, "e1");
    await s.seal();
    const r2 = await start(env, s.form.stage_id, "e1-start2");
    assert.ok(r2.round_id);
    const result2 = await new_result(env, "e1-res2", BODY_3);
    await seal(env, r2.round_id, [result2], "e1-seal2");
    const ws = assert_ok(await owner_get(env, "/workspace"));
    const one = assert_ok(await owner_get(env, round_path("1")));
    const two = assert_ok(await owner_get(env, round_path("2")));
    assert.equal(one.edition, ws.edition);
    assert.equal(two.edition, ws.edition);
    assert.equal(one.result.object_id, s.result.object_id);
    assert.equal(one.result.body_md, BODY_1);
    assert.equal(two.result.object_id, result2.object_id);
    assert.equal(two.result.version_id, result2.version_id);
    assert.equal(two.result.body_md, BODY_3);
    assert.notEqual(one.result.object_id, two.result.object_id);
  });
});

// ---------------------------------------------------------------------------
// 읽기 전용

test("[회귀] 결과를 싣는 읽기는 아무것도 쓰지 않는다(사람 · 토큰 · 가려진 경우 모두)", async () => {
  await with_api(async (env) => {
    const s = await sealed_round(env, "f1");
    await close_version(env, s.result.version_id, "f1");
    await s.seal();
    const reader = await make_agent(env, "reader", ["context:read"]);
    const sig = state_signature(env.db);
    assert_ok(await owner_get(env, round_path("1")));
    assert_ok(await get_as(env, "1", { token: reader.token }));
    assert.equal(state_signature(env.db), sig);
  });
});

// ---------------------------------------------------------------------------
// (4) 여러 객체가 담긴 라운드: 글 아닌 객체는 건너뛰고, 첫 글의 현재 버전에 본문이 없으면 다음 글로 넘어가지 않는다

test("[신규] 결과는 봉인 순서(position)에서 처음 나오는 '글' 객체다 — 글이 아닌 객체(출처)는 건너뛴다", async () => {
  await with_api(async (env) => {
    const form = await make_form(env, [single_spec("질문")], "c1");
    const src_obj = (await create_object(env.service, env.ctx("c1-so"), { kind: "source", edition_id: env.p.edition_id })).result as { object_id: string };
    const src = (await add_source(env.service, env.ctx("c1-sv"), { object_id: src_obj.object_id, source_kind: "web", title: "합성 출처", url: "https://example.invalid/c1", method: "fetch", verification_state: "unverified" })).result as { object_id: string; version_id: string };
    const art = await new_result(env, "c1-art", BODY_1);
    // 봉인 순서: 출처(position 0) → 글(position 1). 출처가 앞이어도 결과는 글이다.
    await seal(env, form.round_id, [{ object_id: src.object_id, version_id: src.version_id }, { object_id: art.object_id, version_id: art.version_id }], "c1-seal");
    const data = assert_ok(await owner_get(env, round_path("1")));
    assert.ok(data.result, "글이 결과로 실린다");
    assert.equal(data.result.object_id, art.object_id);
    assert.equal(data.result.version_id, art.version_id);
    assert.equal(data.result.body_md, BODY_1);
  });
});

test("[신규] 첫 글의 현재 버전에 본문(body_md)이 없으면 result:null — 뒤의 글 본문으로 넘어가지 않는다", async () => {
  await with_api(async (env) => {
    const form = await make_form(env, [single_spec("질문")], "c2");
    const empty = await new_artifact(env, "c2-empty"); // 본문 없는 글(본문이 파일 blob 인 경우와 같은 자리)
    const later = await new_result(env, "c2-later", BODY_2);
    await seal(env, form.round_id, [{ object_id: empty.object_id, version_id: empty.version_id }, later], "c2-seal");
    const data = assert_ok(await owner_get(env, round_path("1")));
    assert.ok("result" in data);
    assert.equal(data.result, null, "첫 글이 본문 없이 결과가 되고, 뒤 글은 쓰이지 않는다");
    assert.ok(!JSON.stringify(data).includes("MARK-R126-V2"), "뒤 글의 본문이 새지 않는다");
  });
});

// ---------------------------------------------------------------------------
// (5) 앱이 쓰는 길: 결과의 version_id 를 HTTP 로 첨언 생성 · 제안(edit_text base_version_id) · 채택(apply)에 넣으면 통과한다

test("[신규] 라운드 결과의 version_id 를 HTTP 첨언 생성 · edit_text 제안 base_version_id · 채택(apply)에 넣으면 모두 통과한다", async () => {
  await with_api(async (env) => {
    const s = await sealed_round(env, "e1");
    await s.seal();
    const result = assert_ok(await owner_get(env, round_path("1"))).result;
    assert.equal(result.version_id, s.result.version_id);
    // 1) 첨언 생성: 결과가 준 version_id 를 target_version_id 로
    const cp = cp_find(BODY_1, "MARK-R126-V1");
    const made = assert_ok(
      await call(env, {
        method: "POST",
        path: P(env, "/threads"),
        auth: "owner",
        body: {
          target_object_id: result.object_id,
          target_version_id: result.version_id,
          context_kind: "annotation",
          anchor: { exact_quote: "MARK-R126-V1", prefix: "첫 판 본문 ", suffix: " 입니다.", ...cp },
          initial_message: { body_md: "이 본문의 근거를 설명해 주세요." },
        },
      }),
      201,
    );
    assert.equal(made.thread.state, "open");
    // 2) edit_text 제안: base_version_id 는 결과의 version_id (현재 버전과 같다)
    const prop = assert_ok(
      await call(env, {
        method: "POST",
        path: P(env, "/followups"),
        auth: "owner",
        body: { origin_thread_id: made.thread.id, kind: "edit_text", description: "본문을 고친다.", proposed_body_md: BODY_2, base_version_id: result.version_id },
      }),
      201,
    ).followup;
    assert.equal(prop.base_version_id, result.version_id);
    // 3) 채택: base_version_id 와 expected_rev 를 같이 넣어 200, 결과 글의 현재 버전이 새 버전이 된다
    const applied = assert_ok(
      await call(env, {
        method: "POST",
        path: P(env, `/followups/${prop.id}/apply`),
        auth: "owner",
        body: { format_version: "1.0", base_version_id: result.version_id, expected_rev: prop.version_no },
      }),
      200,
    );
    assert.equal(applied.followup.state, "applied");
    assert.notEqual(applied.followup.result_version_id, result.version_id);
    assert.equal(current_version_of(env.db, result.object_id), applied.followup.result_version_id);
    const after = assert_ok(await owner_get(env, round_path("1"))).result;
    assert.equal(after.version_id, applied.followup.result_version_id, "결과 읽기도 채택된 현재 버전을 준다");
    assert.equal(after.body_md, BODY_2);
  });
});

// ---------------------------------------------------------------------------
// 문서 · 계약 갱신

test("[신규] OpenAPI 의 라운드 읽기 설명이 result{object_id, version_id, body_md} · null · AI 가림을 적는다", () => {
  const yaml = readFileSync(OPENAPI_PATH, "utf8");
  const at = yaml.search(/\n {2}\/api\/v1\/projects\/\{id\}\/stages\/\{s\}\/rounds\/\{rd\}:\r?\n/);
  assert.ok(at >= 0);
  const rest = yaml.slice(at + 1);
  const end = rest.search(/\n {2}\/api\/v1\/projects\/\{id\}\/stages\/\{s\}\/rounds\/\{rd\}\/threads:/);
  const block = rest.slice(0, end);
  for (const word of ["result", "object_id", "version_id", "body_md"]) assert.ok(block.includes(word), `OpenAPI 라운드 읽기에 ${word}`);
  assert.match(block, /result[^.]*null|null[^.]*result/i, "결과가 없으면 null 임을 적는다");
  assert.match(block, /closed to AI|ai_access|AI/, "닫힌 파일(AI 참조 금지)일 때의 모양을 적는다");
});

test("[신규] stage-1-api 의 라운드 읽기 행이 결과 글(result)을 적는다", () => {
  const md = readFileSync(new URL("../docs/plan/stage-1-api.md", import.meta.url), "utf8");
  const row = md.split(/\r?\n/).find((line) => line.includes("GET P/stages/{s}/rounds/{rd}"));
  assert.ok(row, "라운드 읽기 행");
  assert.match(row, /result/);
  assert.match(row, /body_md/);
});

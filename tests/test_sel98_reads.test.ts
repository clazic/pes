/**
 * SEL-98 U2d (서버 읽기) — 앱이 실제 서버로 답·의견·순서를 쓰는 데 빠진 읽기 경로 (tester, 작성 모드).
 * 이름 앞 [회귀]는 지금도 통과해야 하는 가드, [신규]는 구현 전에는 실패하는 시험(404 not_found 등 요구사항 때문에).
 *
 * 없던 것: 서버에는 "라운드 하나의 질문"을 읽는 길이 없다(app/src/api/types.ts READS.round 가 '(미정)'). 그래서 앱의 http getRound 는 질문을 못 채웠다.
 * 새 읽기 전용 경로(새 표 없음 · 기존 읽기 모델 위 · 명령 서비스 아님 · 쓰기 0):
 *
 *   GET P/stages/{stage_key}/rounds/{place}             place = "start"(단계 시작 질문) | 1 이상의 라운드 번호(10진 글)
 *     권한: 소유자 세션 또는 context:read 토큰. 모르는 단계 키·번호 → 404 not_found. 폼이 아직 없으면 200 + set_id null + questions [].
 *     data = {
 *       stage: "plan",
 *       round_id: null | <번호 숫자>,                  // 작업 공간의 stages[].rounds[].round_id 와 같은 값
 *       server_round_id: null | string,               // 번호 라운드의 서버 id(rounds.id) — POST P/questions 의 round_id 로 쓴다. start 는 null
 *       state: "current" | "closed",                  // 작업 공간 stages[].rounds[].state 와 같은 값
 *       set_id: string | null,                        // 그 자리(단계 + 라운드)의 form_key "main" 최신 질문 세트 id
 *       form_version: number | null,                  // 그 세트의 version_no (숫자)
 *       questions: [{                                 // 세트 구성원 순서(position). 철회·보류·합침으로 세트에서 빠진 질문은 없다
 *         id, version_id, version_no: "<10진 글>", state: "open"|"deferred"|"merged"|"withdrawn",
 *         type: "single"|"multi"|"text"|"number", text, required: bool, allow_comment_as_answer: bool,
 *         importance: string|null, help: string|null, default_value: any|null, options: [{value,label,recommended?}] , show_if: {id,in}|null,
 *         merged_into_question_id: string|null, display_no: number(화면 질문 번호 — objects.display_no),
 *         answer: null | { version_id, value, question_version_id, used_default: bool, state, tx_id, receipt_no, committed_at }   // 현재 답(없으면 null). 영수증 3칸 = 그 답을 쓴 tx 의 영수증(test_sel98_receipt 와 같은 값)
 *       }]
 *     }
 *
 *   GET P/stages/{stage_key}/rounds/{place}/threads      같은 권한·같은 404 규칙
 *     data = { threads: [{ thread_id, question_id: <질문 id> | "__other", question_version_id: string|null, question_version: number|null,
 *                          messages: [{ message_id, body_md, at: ISO 8601, by: "human"|"ai", receipt_no?: string }] }] }
 *     질문 의견 스레드(context_kind question_comment)는 대상 질문 id 로, 질문에 묶이지 않은 스레드(context_kind general = 이전된 프로젝트의 낱개 의견)는 "__other" 로.
 *     메시지는 쓴 순서. 이 자리(단계·라운드)의 폼에 든 적 없는 질문의 스레드는 싣지 않는다. 답·제출은 만들지 않는다(읽기만).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { assert_error, assert_ok, call, make_agent, with_api, type ApiEnv } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { cmd, current_row, history_counts, make_form, owner_get, owner_post, single_spec, text_spec } from "./helpers/sel90_env.ts";
import { make_content, seal, stage_ids } from "./helpers/editions_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const DEC = /^(0|[1-9][0-9]*)$/;
const round_path = (place: string, tail = "") => `/stages/plan/rounds/${place}${tail}`;

/** 라운드를 봉인한다(합성 산출물 하나로 — 기존 라운드 흐름 시험과 같은 방법). */
async function seal_it(env: ApiEnv, round_id: string, tag: string): Promise<void> {
  const content = await make_content(env, tag);
  await seal(env, round_id, [{ object_id: content.object_id, version_id: content.version_id }], `${tag}-seal`);
}

// ---------------------------------------------------------------------------
// 1. 라운드 읽기 — set_id · 질문 version_id · 번호 라운드의 서버 round_id

test("[신규] 라운드 읽기: 번호 라운드 — set_id · form_version · server_round_id · 질문마다 version_id 가 읽힌다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("질문 가"), text_spec("질문 나")]);
    const [q1, q2] = f.ids;
    const data = assert_ok(await owner_get(env, round_path("1")));
    assert.equal(data.stage, "plan");
    assert.equal(data.round_id, 1);
    assert.equal(data.server_round_id, f.round_id, "번호 라운드의 서버 id(rounds.id) — POST P/questions 의 round_id");
    assert.equal(data.set_id, f.set.set_id);
    assert.equal(data.form_version, f.set.set_version_no);
    assert.equal(data.questions.length, 2);
    assert.deepEqual(data.questions.map((q: any) => q.id), [q1, q2], "세트 구성원 순서");
    const row1 = current_row(env.db, q1!);
    assert.equal(data.questions[0].version_id, row1.version_id, "질문 현재 버전 id");
    assert.match(data.questions[0].version_no, DEC);
    assert.ok(Number.isInteger(data.questions[0].display_no) && data.questions[0].display_no >= 1, "화면에 보이는 질문 번호(objects.display_no)");
    assert.ok(data.questions[1].display_no > data.questions[0].display_no, "만든 순서대로 늘어난다");
    assert.equal(data.questions[0].state, "open");
    assert.equal(data.questions[0].type, "single");
    assert.equal(data.questions[0].text, "질문 가");
    assert.equal(data.questions[0].required, true);
    assert.equal(data.questions[0].allow_comment_as_answer, false);
    assert.deepEqual(data.questions[0].options.map((o: any) => o.value), ["a", "b", "c"]);
    assert.equal(data.questions[0].default_value, "b");
    assert.equal(data.questions[0].show_if, null);
    assert.equal(data.questions[0].answer, null);
    assert.equal(data.questions[1].type, "text");
    assert.equal(data.questions[1].required, false);
  });
});

test("[신규] 라운드 읽기: 상태는 workspace 와 같다(round_id · state), 닫힌 라운드도 읽힌다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("질문 가")]);
    const ws = assert_ok(await owner_get(env, "/workspace"));
    const plan = ws.stages.find((s: any) => s.key === "plan");
    const place = plan.rounds.find((r: any) => r.round_id === 1);
    assert.ok(place, "작업 공간에 1번 라운드 자리");
    const open = assert_ok(await owner_get(env, round_path("1")));
    assert.equal(open.state, place.state);
    // 봉인하면 닫힌 자리 — 그래도 읽힌다
    await seal_it(env, f.round_id, "sl");
    const ws2 = assert_ok(await owner_get(env, "/workspace"));
    const closed_place = ws2.stages.find((s: any) => s.key === "plan").rounds.find((r: any) => r.round_id === 1);
    const closed = assert_ok(await owner_get(env, round_path("1")));
    assert.equal(closed.state, closed_place.state);
    assert.equal(closed.state, "closed");
    assert.equal(closed.set_id, f.set.set_id);
  });
});

test("[신규] 라운드 읽기: 현재 답은 answer 칸에 — 답한 질문만, 값 · used_default · 질문 버전", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("답할 질문"), text_spec("비워 둔 질문")]);
    const [q1] = f.ids;
    const res = await owner_post(env, "/submissions", { set_id: f.set.set_id, answers: [{ question_id: q1, value: "b", used_default: true }] });
    assert.ok(assert_ok(res, 201).submission);
    const data = assert_ok(await owner_get(env, round_path("1")));
    const a = data.questions[0].answer;
    assert.ok(a, "답한 질문의 현재 답");
    assert.equal(a.value, "b");
    assert.equal(a.used_default, true);
    assert.equal(a.question_version_id, current_row(env.db, q1!).version_id);
    assert.equal(typeof a.version_id, "string");
    // 답을 쓴 쓰기의 영수증 — 앱의 '보낸 답' 칸(SentAnswer: receipt_no · tx_id · committed_at)에 그대로 쓴다. POST 응답의 영수증과 같다
    assert.equal(a.tx_id, res.json.receipt?.tx_id);
    assert.equal(a.receipt_no, res.json.receipt?.receipt_no);
    assert.equal(a.committed_at, res.json.receipt?.committed_at);
    assert.equal(data.questions[1].answer, null);
  });
});

test("[신규] 라운드 읽기: 고친 질문은 새 버전 id · version_no 를 보이고, 철회한 질문은 새 세트에서 빠진다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("고칠 질문"), single_spec("철회할 질문")]);
    const [q1, q2] = f.ids;
    const before = assert_ok(await owner_get(env, round_path("1")));
    const v1 = before.questions[0].version_id;
    assert_ok(await owner_post(env, `/questions/${q1}/revisions`, { base_version_id: v1, question: { text: "고친 문구" } }), 201);
    assert_ok(await owner_post(env, `/questions/${q2}/withdraw`, {}), 201);
    const after = assert_ok(await owner_get(env, round_path("1")));
    assert.deepEqual(after.questions.map((q: any) => q.id), [q1], "철회한 질문은 최신 세트에 없다");
    assert.notEqual(after.questions[0].version_id, v1);
    assert.equal(after.questions[0].version_no, "2");
    assert.equal(after.questions[0].text, "고친 문구");
    assert.ok(after.form_version > before.form_version, "철회가 새 세트(폼 버전)를 만든다");
  });
});

test("[신규] 라운드 읽기: show_if · 기본값 · help · importance 가 읽힌다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("부모", { importance: "high" })]);
    const parent = f.ids[0]!;
    const added = assert_ok(
      await owner_post(env, "/questions", {
        stage_id: f.stage_id,
        round_id: f.round_id,
        purpose: "stage_start",
        form_key: "main",
        question: single_spec("자식", { show_if: { id: parent, in: ["a"] }, help: "도움말 글", required: false }),
      }),
      201,
    );
    assert.ok(added.question);
    const data = assert_ok(await owner_get(env, round_path("1")));
    assert.equal(data.questions[0].importance, "high");
    const child = data.questions[1];
    assert.deepEqual(child.show_if, { id: parent, in: ["a"] });
    assert.equal(child.help, "도움말 글");
    assert.equal(child.required, false);
  });
});

test("[신규] 라운드 읽기: 단계 시작 질문(start)은 server_round_id null · round_id null", async () => {
  await with_api(async (env) => {
    const s = stage_ids(env.db, env.p.edition_id);
    // 단계 시작 질문 자리(round_id null)에 세트를 낸다 — 이 단계가 질문을 받는 상태인지는 기존 규칙을 따른다
    const res = await owner_post(env, "/questions", {
      stage_id: s.plan,
      round_id: null,
      purpose: "stage_start",
      form_key: "main",
      question: single_spec("시작 질문"),
    });
    if (res.status !== 201) return; // 이 합성 프로젝트의 단계가 시작 질문을 받지 않으면 이 장면은 해당 없음(아래 404 시험이 start 자리를 따로 본다)
    const data = assert_ok(await owner_get(env, round_path("start")));
    assert.equal(data.stage, "plan");
    assert.equal(data.round_id, null);
    assert.equal(data.server_round_id, null);
    assert.equal(typeof data.set_id, "string");
    assert.equal(data.questions.length, 1);
    assert.equal(data.questions[0].text, "시작 질문");
  });
});

test("[신규] 라운드 읽기: 폼이 아직 없는 자리는 200 + set_id null + 빈 질문, 모르는 단계·번호는 404, 쓰기 상태 서명 불변", async () => {
  await with_api(async (env) => {
    await make_form(env, [single_spec("질문")]);
    assert_ok(await owner_get(env, round_path("1")), 200);
    const sig = state_signature(env.db);
    const counts = history_counts(env.db);
    assert_error(await owner_get(env, "/stages/no-such-stage/rounds/1"), 404, "not_found");
    assert_error(await owner_get(env, round_path("99")), 404, "not_found");
    assert_error(await owner_get(env, round_path("0")), 404, "not_found");
    assert_error(await owner_get(env, round_path("abc")), 404, "not_found");
    // 아직 시작하지 않은 단계(research)의 start 자리 — 폼이 없다. 자리가 없으면 404, 있으면 빈 폼. 둘 중 하나여야 하고 지어낸 질문은 없다.
    const res = await call(env, { method: "GET", path: P(env, "/stages/research/rounds/start"), auth: "owner" });
    if (res.status === 200) {
      assert.equal(res.json.data.set_id, null);
      assert.deepEqual(res.json.data.questions, []);
    } else {
      assert_error(res, 404, "not_found");
    }
    assert.deepEqual(state_signature(env.db), sig, "읽기는 아무것도 쓰지 않는다");
    assert.deepEqual(history_counts(env.db), counts);
  });
});

test("[신규] 라운드 읽기: 소유자 세션 또는 context:read 토큰만 — 무자격 401, 범위 없는 토큰 403, 다른 프로젝트 404", async () => {
  await with_api(async (env) => {
    await make_form(env, [single_spec("질문")]);
    const reader = await make_agent(env, "reader", ["context:read"]);
    const writer = await make_agent(env, "writer", ["run:submit"]);
    assert_error(await call(env, { method: "GET", path: P(env, round_path("1")), auth: "none" }), 401, "unauthenticated");
    assert_ok(await call(env, { method: "GET", path: P(env, round_path("1")), auth: { token: reader.token } }));
    assert_error(await call(env, { method: "GET", path: P(env, round_path("1")), auth: { token: writer.token } }), 403, "forbidden");
    assert_error(await call(env, { method: "GET", path: "/api/v1/projects/no-such-project" + round_path("1"), auth: "owner" }), 404, "not_found");
    assert_error(await call(env, { method: "POST", path: P(env, round_path("1")), auth: "owner", body: {} }), 405, "method_not_allowed");
  });
});

// ---------------------------------------------------------------------------
// 2. 질문별 의견 목록 읽기

test("[신규] 의견 목록: 스레드는 대상 질문 id 로, 메시지는 쓴 순서 · 시각 ISO · by human", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("의견 질문 가"), single_spec("의견 질문 나")]);
    const [q1, q2] = f.ids;
    const created = assert_ok(await owner_post(env, "/threads", { target_object_id: q1, context_kind: "question_comment", initial_message: { body_md: "첫 의견" } }), 201);
    assert_ok(await owner_post(env, `/threads/${created.thread.id}/messages`, { body_md: "이어 쓴 의견" }), 201);
    assert_ok(await owner_post(env, "/threads", { target_object_id: q2, context_kind: "question_comment", initial_message: { body_md: "다른 질문 의견" } }), 201);
    const data = assert_ok(await owner_get(env, round_path("1", "/threads")));
    assert.equal(data.threads.length, 2);
    const t1 = data.threads.find((t: any) => t.question_id === q1);
    assert.ok(t1);
    assert.equal(t1.thread_id, created.thread.id);
    assert.equal(t1.question_version_id, current_row(env.db, q1!).version_id, "스레드가 가리킨 질문 버전");
    assert.deepEqual(t1.messages.map((m: any) => m.body_md), ["첫 의견", "이어 쓴 의견"]);
    for (const m of t1.messages) {
      assert.equal(typeof m.message_id, "string");
      assert.match(m.at, ISO);
      assert.equal(m.by, "human");
      if ("receipt_no" in m) assert.equal(typeof m.receipt_no, "string");
    }
    const t2 = data.threads.find((t: any) => t.question_id === q2);
    assert.deepEqual(t2.messages.map((m: any) => m.body_md), ["다른 질문 의견"]);
  });
});

test("[신규] 의견 목록: 의견은 답이 아니다 — 읽어도 답·제출이 생기지 않고, 답 읽기에도 나타나지 않는다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("의견 질문")]);
    const q = f.ids[0]!;
    assert_ok(await owner_post(env, "/threads", { target_object_id: q, context_kind: "question_comment", initial_message: { body_md: "의견만" } }), 201);
    const before = history_counts(env.db);
    assert_ok(await owner_get(env, round_path("1", "/threads")));
    assert.deepEqual(history_counts(env.db), before);
    const round = assert_ok(await owner_get(env, round_path("1")));
    assert.equal(round.questions[0].answer, null, "의견은 답 칸에 들어가지 않는다");
  });
});

test("[신규] 의견 목록: 스레드가 없으면 빈 목록, 이 자리 폼에 든 적 없는 질문의 스레드는 싣지 않는다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("질문")]);
    assert.deepEqual(assert_ok(await owner_get(env, round_path("1", "/threads"))).threads, []);
    // 다른 단계(research)의 질문에 쓴 의견은 plan 라운드 목록에 없다
    const s = stage_ids(env.db, env.p.edition_id);
    const other = await owner_post(env, "/questions", { stage_id: s.research, round_id: null, purpose: "stage_start", form_key: "main", question: single_spec("다른 단계 질문") });
    if (other.status === 201) {
      assert_ok(await owner_post(env, "/threads", { target_object_id: other.json.data.question.id, context_kind: "question_comment", initial_message: { body_md: "남의 단계" } }), 201);
      assert.deepEqual(assert_ok(await owner_get(env, round_path("1", "/threads"))).threads, []);
    }
    assert.ok(f.ids.length === 1);
  });
});

test("[신규] 의견 목록: 질문에 묶이지 않은 스레드(general)는 question_id \"__other\" — 아무 것도 깨지지 않는다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("질문")]);
    const q = f.ids[0]!;
    await cmd(env, "other-c", "question.comment_add", { question_id: q, body_md: "묶이지 않은 의견" });
    const t = env.db.get<{ object_id: string }>("SELECT object_id FROM threads WHERE target_object_id = ?", q);
    assert.ok(t);
    // 이전된 프로젝트의 낱개 의견 = context_kind general (스키마가 허용하는 값)
    env.db.run("UPDATE threads SET context_kind = 'general' WHERE object_id = ?", t!.object_id);
    const data = assert_ok(await owner_get(env, round_path("1", "/threads")));
    assert.equal(data.threads.length, 1);
    assert.equal(data.threads[0].question_id, "__other");
    assert.equal(data.threads[0].thread_id, t!.object_id);
    assert.deepEqual(data.threads[0].messages.map((m: any) => m.body_md), ["묶이지 않은 의견"]);
  });
});

test("[신규] 의견 목록: 권한은 라운드 읽기와 같다(401 · 범위 없는 토큰 403 · 모르는 번호 404)", async () => {
  await with_api(async (env) => {
    await make_form(env, [single_spec("질문")]);
    const reader = await make_agent(env, "reader", ["context:read"]);
    const writer = await make_agent(env, "writer", ["run:submit"]);
    const path = P(env, round_path("1", "/threads"));
    assert_error(await call(env, { method: "GET", path, auth: "none" }), 401, "unauthenticated");
    assert_ok(await call(env, { method: "GET", path, auth: { token: reader.token } }));
    assert_error(await call(env, { method: "GET", path, auth: { token: writer.token } }), 403, "forbidden");
    assert_error(await owner_get(env, round_path("99", "/threads")), 404, "not_found");
  });
});

// ---------------------------------------------------------------------------
// 3. 문서 · OpenAPI

test("[신규] OpenAPI 에 새 읽기 경로 둘이 GET 으로 적혀 있다", async () => {
  const { readFileSync } = await import("node:fs");
  const { OPENAPI_PATH } = await import("./helpers/api_env.ts");
  const yaml = readFileSync(OPENAPI_PATH, "utf8");
  assert.match(yaml, /\/api\/v1\/projects\/\{id\}\/stages\/\{s\}\/rounds\/\{rd\}:\n\s+get:/);
  assert.match(yaml, /\/api\/v1\/projects\/\{id\}\/stages\/\{s\}\/rounds\/\{rd\}\/threads:\n\s+get:/);
});

// ---------------------------------------------------------------------------
// 판 번호 — 1차 리뷰 필수 1: 라운드·의견 읽기는 활성 판의 자료라서, 응답에 그 판 번호(작업 공간 읽기의 edition 과 같은 수)를 싣는다.

test("[신규] 판 번호: 라운드 읽기와 의견 읽기 응답이 작업 공간의 edition 과 같은 활성 판 번호를 싣는다", async () => {
  await with_api(async (env) => {
    await make_form(env, [single_spec("질문")]);
    const ws = assert_ok(await owner_get(env, "/workspace"));
    assert.ok(Number.isInteger(ws.edition) && ws.edition >= 1);
    const round = assert_ok(await owner_get(env, round_path("1")));
    assert.equal(round.edition, ws.edition, "라운드 읽기 data.edition");
    const threads = assert_ok(await owner_get(env, round_path("1", "/threads")));
    assert.equal(threads.edition, ws.edition, "의견 읽기 data.edition");
    // start 자리도 같다
    const start = await owner_get(env, round_path("start"));
    if (start.status === 200) assert.equal(start.json.data.edition, ws.edition);
  });
});

/**
 * SEL-98 U2d (서버 영수증) — 쓰기 201 응답에 영수증을 싣는다 (tester, 작성 모드).
 *
 * 지금: 서버 성공 본문은 {format_version, request_id, data, replayed?} 뿐이라, 앱이 쓰기 뒤에 `GET P/requests/{key}` 를 한 번 더 불러 tx_id 를 읽고
 * 번호·시각은 지어내지 못해 "번호 없는 접수됨"(numbered:false)으로 처리했다(SEL-92 리뷰). 영수증을 응답에 싣는다 — **스스로 정한 해석**:
 *
 *   성공(201) 본문에 형제 칸 `receipt` 를 더한다: { receipt_no: 10진 글(프로젝트 안에서 쓰기 순서대로 늘어난다), tx_id: 그 쓰기의 mutation_commits.id,
 *                                                 committed_at: 그 tx 의 커밋 시각 ISO 8601 }.
 *     → {format_version, request_id, data, receipt, replayed?}. data 의 모양은 바꾸지 않는다(기존 data 단언·픽스처 data 모양 그대로).
 *   같은 키·같은 본문의 재생(replayed:true)은 **첫 응답과 같은 영수증**. 오류 본문에는 receipt 가 없다. 읽기(GET) 본문에도 없다.
 *   기존 `GET P/requests/{key}` 는 유지하되(앱·다른 클라이언트용) data 에 receipt_no · committed_at 을 더해 POST 의 영수증과 같게 한다 (기존 키 key·state·action·status·operation_id·tx_id·run_id 는 그대로).
 *   적용 범위: 질문(만들기·고치기·철회·보류·합치기)·순서 바꾸기·스레드/메시지·제출, 그리고 같은 방식의 다른 201 쓰기(가정 제안으로 확인) — 한 곳(공통 응답 조립)에서 처리.
 *
 * 기존 시험과 충돌하는 곳(구현 때 갱신해야 함 — 이 시험은 고치지 않는다): tests/test_api_fixture_contract.test.ts:693 의 "envelope keys" 단언이 성공 본문 키를
 * 픽스처(docs/plan/fixtures/api-v1/*.json 의 body 키)와 같게 요구한다. 픽스처의 201 쓰기 본문에 receipt 를 더하고(문서 계약), 단언이 receipt 를 선택 칸으로 보게 해야 한다.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { assert_error, assert_ok, call, with_api, type ApiEnv } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { latest_set, make_form, owner_get, owner_post, single_spec, text_spec } from "./helpers/sel90_env.ts";
import { current_row } from "./helpers/sel90_env.ts";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const DEC = /^[0-9]+$/;

function assert_receipt(res: { json: any }, where: string): { receipt_no: string; tx_id: string; committed_at: string } {
  const r = res.json.receipt;
  assert.ok(r && typeof r === "object", `${where}: 응답에 receipt`);
  assert.deepEqual(Object.keys(r).sort(), ["committed_at", "receipt_no", "tx_id"], `${where}: 영수증 칸`);
  assert.match(r.receipt_no, DEC, `${where}: receipt_no 는 10진 글`);
  assert.equal(typeof r.tx_id, "string");
  assert.ok(r.tx_id.length > 0);
  assert.match(r.committed_at, ISO, `${where}: committed_at ISO`);
  return r;
}

test("[신규] 쓰기 201 응답에 영수증(receipt_no · tx_id · committed_at)이 실리고, GET requests/{key} 와 같은 값이다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("가"), single_spec("나"), single_spec("다")]);
    const [a, b, c] = f.ids as [string, string, string];
    const v = current_row(env.db, a).version_id;
    const calls: { name: string; key: string; run: () => Promise<{ status: number; json: any }> }[] = [
      { name: "questions.create", key: "rc-create", run: () => owner_post(env, "/questions", { stage_id: f.stage_id, round_id: f.round_id, purpose: "stage_start", form_key: "main", question: text_spec("새 질문") }, "rc-create") },
      { name: "questions.revise", key: "rc-revise", run: () => owner_post(env, `/questions/${a}/revisions`, { base_version_id: v, question: { text: "고침" } }, "rc-revise") },
      { name: "questions.defer", key: "rc-defer", run: () => owner_post(env, `/questions/${b}/defer`, {}, "rc-defer") },
      { name: "questions.merge", key: "rc-merge", run: () => owner_post(env, `/questions/${c}/merge`, { merged_into_question_id: a }, "rc-merge") },
      { name: "threads.create", key: "rc-thread", run: () => owner_post(env, "/threads", { target_object_id: a, context_kind: "question_comment", initial_message: { body_md: "의견" } }, "rc-thread") },
      { name: "submissions.create", key: "rc-submit", run: () => owner_post(env, "/submissions", { set_id: latest_set(env.db, env.p.project_id, f.stage_id).id, answers: [{ question_id: a, value: "a" }] }, "rc-submit") },
      { name: "assumptions.create", key: "rc-assume", run: () => owner_post(env, "/assumptions", { statement: "합성 가정", state: "proposed" }, "rc-assume") },
    ];
    let last = -1n;
    for (const c of calls) {
      const res = await c.run();
      assert.equal(res.status, 201, `${c.name}: ${JSON.stringify(res.json)}`);
      const r = assert_receipt(res, c.name);
      assert.ok(BigInt(r.receipt_no) > last, `${c.name}: receipt_no 는 쓰기 순서대로 늘어난다 (${r.receipt_no} > ${last})`);
      last = BigInt(r.receipt_no);
      const read = assert_ok(await owner_get(env, `/requests/${c.key}`));
      assert.equal(read.tx_id, r.tx_id, `${c.name}: GET requests/{key} 의 tx_id`);
      assert.equal(read.receipt_no, r.receipt_no, `${c.name}: GET requests/{key} 의 receipt_no`);
      assert.equal(read.committed_at, r.committed_at, `${c.name}: GET requests/{key} 의 committed_at`);
      // 기존 칸은 유지
      for (const k of ["key", "state", "action", "status", "operation_id", "tx_id", "run_id"]) assert.ok(k in read, `${c.name}: 기존 칸 ${k} 유지`);
      assert.equal(read.key, c.key);
      assert.equal(read.state, "completed");
    }
  });
});

test("[신규] 영수증 시각은 그 tx 의 커밋 시각이고 tx_id 는 실제 mutation_commits 행이다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("가")]);
    const res = await owner_post(env, `/questions/${f.ids[0]}/withdraw`, {}, "rc-time");
    assert.equal(res.status, 201);
    const r = assert_receipt(res, "withdraw");
    const row = env.db.get<{ id: string; created_at: bigint }>("SELECT id, created_at FROM mutation_commits WHERE id = ?", r.tx_id);
    assert.ok(row, "tx_id 는 mutation_commits.id");
    assert.equal(Date.parse(r.committed_at), Number(row!.created_at), "committed_at = 커밋 시각(ms)");
  });
});

test("[신규] 재생(replayed:true)은 첫 응답과 같은 영수증을 돌려주고 번호를 새로 받지 않는다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("가"), single_spec("나")]);
    const first = await owner_post(env, `/questions/${f.ids[0]}/defer`, {}, "rc-replay");
    assert.equal(first.status, 201);
    const r1 = assert_receipt(first, "first");
    const other = await owner_post(env, `/questions/${f.ids[1]}/withdraw`, {}, "rc-other");
    assert.equal(other.status, 201);
    const again = await owner_post(env, `/questions/${f.ids[0]}/defer`, {}, "rc-replay");
    assert.equal(again.status, 201);
    assert.equal(again.json.replayed, true);
    assert.deepEqual(assert_receipt(again, "replay"), r1);
  });
});

test("[회귀] 오류 응답과 읽기 응답에는 영수증이 없다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("가")]);
    const bad = await owner_post(env, `/questions/${f.ids[0]}/revisions`, { base_version_id: "no-such-version", question: { text: "x" } });
    assert.ok(bad.status >= 400);
    assert.equal("receipt" in bad.json, false);
    assert.equal("receipt" in (await owner_get(env, "/workspace")).json, false);
    const missing = await call(env, { method: "GET", path: P(env, "/requests/never-used"), auth: "owner" });
    assert_error(missing, 404, "not_found");
  });
});

test("[신규] OpenAPI 의 Success 본문이 receipt 를 설명한다", () => {
  const yaml = readFileSync(new URL("../docs/api/openapi-v1.yaml", import.meta.url), "utf8");
  const start = yaml.indexOf("    Success:");
  assert.ok(start > 0);
  const block = yaml.slice(start, start + 800);
  assert.match(block, /receipt/);
  assert.match(block, /receipt_no/);
});

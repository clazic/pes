/**
 * SEL-51 PR18 — 1차 리뷰 r1-3 권장 1 회귀 시험 (tester, 작성 모드). 구현 전에는 실패하는 것이 정상이다.
 *   R1a 80자 넘는 폼 id 로 `pes ask` 는 거부(종료≠0·한국어 안내·DB 불변·ask 파일 0). 80자 이하(경계 80)는 그대로 받는다.
 *   R1a' 80자 폼은 끝까지 맞물린다(spec·set_id 답이 그 판에 연결, 개정 뒤 옛 set_id 는 409).
 *   R1b 80자 이하 폼에서 spec·set_id 를 실었는데 그 form_key 의 판이 0개인 제출은 409 (쓰기 0).
 * 권장 3(show_if)은 test_web_r1_3_show_if.test.ts, 브라우저 쪽은 tests/e2e/workspace_r13.spec.ts. 합성 자료, 임시 HOME·USERPROFILE·PES_HOME.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { run_py } from "./helpers/cli_read_env.ts";
import { commit_count, db_with_form, feedback_files, http, page_data, step, sub_count, with_server, write_spec } from "./helpers/web_env.ts";
import { raw_post } from "./helpers/web_raw.ts";
import { SLUG } from "./helpers/cli_write_env.ts";

const KOREAN = /[가-힣]/;
const setcount = (c: { env: { db: { get: <T>(sql: string) => T | undefined } } }): number =>
  Number(c.env.db.get<{ n: number | bigint }>("SELECT count(*) AS n FROM question_sets")!.n);

const spec_with = (id: string, questions: unknown[]) => ({ id, stage: "plan", kind: "review", round: 2, title: "점검", questions });
const SIMPLE = [{ id: "chk", type: "text", label: "점검 질문", required: true }];

// ---------------------------------------------------------------------------
// 권장 1

test("R1a 폼 id 가 80자를 넘으면 pes ask 는 거부한다 — 종료≠0, 한국어 안내, DB·ask 파일 불변; 80자 이하는 받는다", async () => {
  const c = await db_with_form();
  try {
    const long_id = `${"a".repeat(60)}-${"b".repeat(30)}`; // 91자
    const before = { sets: setcount(c), commits: commit_count(c) };
    const ask_files = (): string[] => (existsSync(join(c.folder, "ask")) ? readdirSync(join(c.folder, "ask")).sort() : []);
    const files_before = ask_files();
    for (const id of [long_id, "x".repeat(81)]) {
      const res = run_py(c, ["ask", SLUG, write_spec(c, spec_with(id, SIMPLE), "long.json")], { flag: "1" });
      assert.notEqual(res.status, 0, `${id.length}자 폼 id 는 거부: ${res.stdout}`);
      assert.match(res.stderr + res.stdout, KOREAN, "거부 사유는 한국어로 안내한다");
      assert.equal(setcount(c), before.sets, "거부면 질문 세트 불변");
      assert.equal(commit_count(c), before.commits, "거부면 커밋 불변");
      assert.deepEqual(ask_files(), files_before, "거부면 ask 파일도 만들지 않는다");
      assert.equal(existsSync(join(c.folder, `ask-${id.toLowerCase()}.html`)), false, "거부면 질문 페이지도 만들지 않는다");
    }
    // 경계: 정확히 80자는 받는다
    const ok_id = "c".repeat(80);
    const res = run_py(c, ["ask", SLUG, write_spec(c, spec_with(ok_id, SIMPLE), "edge.json")], { flag: "1" });
    assert.equal(res.status, 0, `80자 폼 id 는 받는다: ${res.stderr}${res.stdout}`);
    assert.equal(setcount(c) - before.sets, 1);
  } finally {
    c.close();
  }
});

test("R1a' 80자 폼은 끝까지 맞물린다 — 대시보드가 보낸 spec·set_id 로 보낸 답이 그 판에 연결되고, 개정 뒤 옛 set_id 는 409", async () => {
  const c = await db_with_form();
  try {
    const id = "d".repeat(80);
    step(c, "1", ["ask", SLUG, write_spec(c, spec_with(id, SIMPLE), "e1.json")]);
    await with_server(c, {}, async (s) => {
      const review = page_data((await http(s, `/${SLUG}/`)).text).project.stages.plan.review;
      assert.ok(review?.set_id, "점검 질문에 set_id 가 실린다");
      step(c, "1", ["ask", SLUG, write_spec(c, spec_with(id, [{ ...SIMPLE[0], label: "개정 질문" }]), "e2.json")]);
      const subs = sub_count(c);
      const body = { stage: "plan", round: 2, kind: "review", text: "[AI 점검 답]", answers: {}, spec: id, set_id: review.set_id };
      const r = await raw_post(s, `/${SLUG}/feedback`, JSON.stringify(body));
      assert.equal(r.status, 409, `80자 폼의 개정도 막는다: ${r.status} ${r.text}`);
      assert.equal(sub_count(c), subs);
    });
  } finally {
    c.close();
  }
});

test("R1b 80자 이하 폼에서 spec·set_id 를 실었는데 그 form_key 의 판이 하나도 없으면 409 — 조용히 set_id null 로 저장하지 않는다", async () => {
  const c = await db_with_form();
  try {
    await with_server(c, {}, async (s) => {
      for (const kind of ["review", "stage_start"]) {
        const subs = sub_count(c);
        const commits = commit_count(c);
        const body = { stage: "plan", round: 2, kind, text: "합성 답", answers: {}, spec: "never-asked-form", set_id: "synthetic-set-id" };
        const r = await raw_post(s, `/${SLUG}/feedback`, JSON.stringify(body));
        assert.equal(r.status, 409, `${kind}: 판 없는 폼은 409: ${r.status} ${r.text}`);
        assert.equal(r.json?.ok, false);
        assert.equal(sub_count(c), subs, `${kind}: 거절이면 제출 0`);
        assert.equal(commit_count(c), commits, `${kind}: 거절이면 커밋 0`);
      }
      assert.deepEqual(feedback_files(c), []);
      // 판이 있는 정식 폼은 그대로 받는다 (시작 질문 폼)
      const data = page_data((await http(s, `/${SLUG}/ask-plan-start.html`)).text);
      assert.ok(data.set_id, "시작 질문 폼에 set_id 가 실린다");
      const ok = await raw_post(s, `/${SLUG}/feedback`, JSON.stringify({ stage: "plan", round: 2, kind: "stage_start", text: "합성", answers: {}, spec: data.spec.id, set_id: data.set_id }));
      assert.equal(ok.status, 200, ok.text);
    });
  } finally {
    c.close();
  }
});

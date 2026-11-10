/**
 * SEL-51 PR18 — Codex 최종 리뷰 1/2 회귀 시험 (tester, 보강 모드). 구현 전에는 실패하는 것이 정상이다.
 *   F1 호환 경로 POST /feedback(Referer 로 프로젝트 판정)이 DB 원본 규칙을 우회하지 못한다:
 *      project.json 이 남은 active DB 프로젝트는 'DB 제출이 되거나 명시적 거부' 중 하나(구현 선택 — 해석), 어느 쪽이든 feedback 폴더에 파일 0,
 *      성공 응답이면 DB pending 에 보인다. legacy 프로젝트·플래그 없음의 /feedback 은 v0.15 그대로.
 *   F2 (서버 쪽) 대시보드 AI 점검 폼을 같은 form_key 로 개정한 뒤 옛 대시보드 send() 와 같은 본문을 보내면 409 이거나 당시 판에 연결(set_id null 금지).
 *   F3 (데이터 쪽) AI 점검 질문의 show_if.id 가 같은 화면 질문의 id 와 맞는다.
 * 브라우저 쪽 F2·F3·F4 는 tests/e2e/workspace_final.spec.ts. 모두 합성 자료, 임시 HOME·USERPROFILE·PES_HOME.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { make_cli_env, SLUG } from "./helpers/cli_write_env.ts";
import { plain_legacy, write_legacy } from "./helpers/cli_read_env.ts";
import { commit_count, db_with_form, feedback_files, http, page_data, pending_names, step, sub_count, with_server, write_spec } from "./helpers/web_env.ts";
import { raw_post } from "./helpers/web_raw.ts";

const COMPAT = { stage: "plan", round: 2, kind: "feedback", text: "합성 우회 답", answers: {} };

test("F1a project.json 이 남은 active DB 프로젝트에 POST /feedback(Referer): DB 제출이거나 명시적 거부 — feedback 폴더 파일 0, 성공이면 DB pending 에 보인다", async () => {
  const c = await db_with_form();
  try {
    write_legacy(c.folder, { ...plain_legacy(SLUG), topic: "합성 남은 옛 project.json" }); // 보존된 옛 파일(active DB 프로젝트 폴더)
    await with_server(c, {}, async (s) => {
      const commits = commit_count(c);
      const subs = sub_count(c);
      const pend = pending_names(c).length;
      const r = await raw_post(s, "/feedback", JSON.stringify(COMPAT), { headers: { Referer: `${s.origin}/${SLUG}/ask-plan-start.html` } });
      assert.ok(r.status < 500 && r.status !== 0, `서버 오류 아님: ${r.status} ${r.text}`);
      assert.deepEqual(feedback_files(c), [], "feedback 폴더에 파일을 쓰지 않는다 (옛 상태 쓰기 경로 우회)");
      if (r.status === 200) {
        assert.equal(r.json?.ok, true);
        assert.equal(sub_count(c) - subs, 1, "성공이면 DB 제출 한 건");
        assert.equal(commit_count(c) - commits, 1);
        assert.equal(pending_names(c).length - pend, 1, "성공이면 DB pending 에 보인다");
        assert.ok(pending_names(c).includes(r.json.file), "응답의 file 이 pending 이름");
      } else {
        assert.ok([400, 403, 404, 405, 409, 410].includes(r.status), `명시적 거부: ${r.status} ${r.text}`);
        assert.equal(r.json?.ok, false, "거부 본문은 {ok:false}");
        assert.equal(sub_count(c), subs, "거부면 쓰기 0");
        assert.equal(commit_count(c), commits);
      }
      // 정식 경로는 그대로 받는다
      const ok = await raw_post(s, `/${SLUG}/feedback`, JSON.stringify({ ...COMPAT, text: "합성 정식 답" }));
      assert.equal(ok.status, 200, ok.text);
      assert.deepEqual(feedback_files(c), []);
    });
  } finally {
    c.close();
  }
});

test("F1b Referer 변형도 같다: 쿼리·해시·대소문자·슬래시 없는 주소·다른 프로젝트 Referer 로 DB 프로젝트를 우회하지 못한다", async () => {
  const c = await db_with_form();
  try {
    write_legacy(c.folder, { ...plain_legacy(SLUG), topic: "합성 남은 옛 project.json" });
    await with_server(c, {}, async (s) => {
      const refs = [`${s.origin}/${SLUG}/`, `${s.origin}/${SLUG}/index.html?x=1#plan`, `${s.origin}/${SLUG}/ask-plan-start.html`, `${s.origin}/${SLUG}`, `${s.origin}/${SLUG}/reports/plan/report.html`];
      const subs = sub_count(c);
      let accepted = 0;
      for (const referer of refs) {
        const r = await raw_post(s, "/feedback", JSON.stringify(COMPAT), { headers: { Referer: referer } });
        assert.ok(r.status < 500 && r.status !== 0, `${referer}: ${r.status}`);
        if (r.status === 200) accepted += 1;
        assert.deepEqual(feedback_files(c), [], `${referer}: feedback 폴더에 파일 0`);
      }
      assert.equal(sub_count(c) - subs, accepted, "성공 응답 수 = DB 제출 수");
    });
  } finally {
    c.close();
  }
});

test("F1c 플래그 없음·legacy: /feedback(Referer) 은 v0.15 그대로 feedback/ 에 파일을 쓰고 DB 에는 쓰지 않는다", async () => {
  const c = await make_cli_env(); // 폴더에 옛 project.json
  try {
    for (const flag of [undefined, "1"] as const) {
      const other = flag === undefined ? SLUG : "synthetic-legacy-compat";
      const dir = flag === undefined ? c.folder : join(c.folder, "..", other);
      if (flag !== undefined) write_legacy(dir, { ...plain_legacy(other), topic: "합성 옛 전용" });
      await with_server(c, { flag }, async (s) => {
        const before = existsSync(join(dir, "feedback")) ? readdirSync(join(dir, "feedback")).filter((x) => x.endsWith(".json")).length : 0;
        const commits = commit_count(c);
        const r = await raw_post(s, "/feedback", JSON.stringify(COMPAT), { headers: { Referer: `${s.origin}/${other}/index.html` } });
        assert.equal(r.status, 200, `flag=${String(flag)}: ${r.text}`);
        const after = readdirSync(join(dir, "feedback")).filter((x) => x.endsWith(".json"));
        assert.equal(after.length - before, 1, `flag=${String(flag)}: v0.15 처럼 feedback/ 에 json 한 개`);
        assert.ok(after.includes(r.json.file));
        assert.equal(commit_count(c), commits, `flag=${String(flag)}: DB 에 쓰지 않는다`);
      });
    }
  } finally {
    c.close();
  }
});

// ---------------------------------------------------------------------------

const REVIEW = (label: string, extra: unknown[] = []) => ({
  id: "plan-check-r2",
  stage: "plan",
  kind: "review",
  round: 2,
  title: "점검",
  questions: [{ id: "chk", type: "text", label, required: true }, ...extra],
});

test("F2 AI 점검 폼 개정 뒤 옛 대시보드 send() 와 같은 본문: 409 이거나 당시 판에 연결 — set_id null 로 저장되지 않는다", async () => {
  const c = await db_with_form();
  try {
    step(c, "1", ["ask", SLUG, write_spec(c, REVIEW("이전 질문"), "review-old.json")]);
    await with_server(c, {}, async (s) => {
      const dash = page_data((await http(s, `/${SLUG}/`)).text);
      const review = dash.project.stages.plan.review;
      assert.ok(review && review.questions.length >= 1, "대시보드에 점검 질문이 있다");
      step(c, "1", ["ask", SLUG, write_spec(c, REVIEW("개정 질문"), "review-new.json")]); // 같은 form_key 개정
      const subs = sub_count(c);
      // v0.15 대시보드의 send() 가 만드는 본문 그대로 (새 화면이 더 싣는 필드는 review 데이터에서 그대로 따라 싣는다)
      const body: Record<string, unknown> = { stage: "plan", round: review.round, kind: "review", text: "[AI 점검 답]\n이전 질문: 답", answers: { [review.questions[0].id]: "답" } };
      for (const key of ["set_id", "form_key", "spec"]) if (key in review) body[key === "form_key" ? "spec" : key] = review[key];
      const r = await raw_post(s, `/${SLUG}/feedback`, JSON.stringify(body));
      if (r.status === 200) {
        const row = c.env.db.get<{ set_id: string | null }>("SELECT set_id FROM submissions ORDER BY rowid DESC LIMIT 1")!;
        assert.notEqual(row.set_id, null, "받았다면 당시 판에 연결해야 한다 (set_id null 금지)");
        assert.equal(sub_count(c) - subs, 1);
      } else {
        assert.equal(r.status, 409, `409 가 아니면 안 된다: ${r.status} ${r.text}`);
        assert.equal(r.json?.ok, false);
        assert.equal(sub_count(c), subs, "거절이면 쓰기 0");
      }
    });
  } finally {
    c.close();
  }
});

test("F3 AI 점검 질문: show_if.id 가 같은 화면(대시보드 데이터) 질문의 id 와 맞는다 — 단일 추천 wide + 필수 why(show_if scope in wide)", async () => {
  const c = await db_with_form();
  try {
    const spec = REVIEW("점검 질문", []);
    spec.questions = [
      { id: "scope", type: "single", label: "범위는?", required: true, options: [{ value: "narrow", label: "좁게" }, { value: "wide", label: "넓게", recommended: true }] } as any,
      { id: "why", type: "text", label: "넓게 하는 이유는?", required: true, show_if: { id: "scope", in: ["wide"] } } as any,
    ];
    step(c, "1", ["ask", SLUG, write_spec(c, spec, "review-sw.json")]);
    await with_server(c, {}, async (s) => {
      const review = page_data((await http(s, `/${SLUG}/`)).text).project.stages.plan.review;
      assert.ok(review, "점검 질문이 대시보드에 있다");
      const ids = new Set(review.questions.map((q: any) => q.id));
      const dependent = review.questions.filter((q: any) => q.show_if);
      assert.equal(dependent.length, 1, "조건부 질문이 있다");
      assert.ok(ids.has(dependent[0].show_if.id), `show_if.id(${dependent[0].show_if.id}) 가 이 화면 질문 id(${[...ids].join(", ")}) 중 하나다`);
      const parent = review.questions.find((q: any) => q.id === dependent[0].show_if.id);
      assert.equal(parent.label, "범위는?", "참조하는 질문이 scope 질문이다");
      assert.ok(parent.options.some((o: any) => o.recommended && o.value === "wide"), "추천(wide)이 유지된다");
      assert.equal(review.questions.find((q: any) => q.label === "넓게 하는 이유는?").required, true);
    });
  } finally {
    c.close();
  }
});

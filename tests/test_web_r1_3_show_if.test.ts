/**
 * SEL-51 PR18 — 1차 리뷰 r1-3 권장 3 회귀 시험 (tester, 작성 모드). 지금 구현을 못 박는 시험이라 구현 전에도 통과할 수 있다.
 *   R3a 없는 질문·자기 자신을 가리키는 show_if 는 대시보드 데이터에서 버려지고 그 질문은 늘 보인다(필수 유지).
 *   R3b legacy import 로 옮겨 온 v0.15 review 질문의 show_if 는 bank_key 로 해석돼 화면 질문 id 와 맞는다.
 *   R3c position 없는 기존 DB 세트(시험에서 직접 만든)는 조건을 못 찾아 버려지고 늘 보인다.
 * 브라우저 쪽(필수 질문 전송 차단)은 tests/e2e/workspace_r13.spec.ts. 합성 자료, 임시 HOME·USERPROFILE·PES_HOME.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { review_questions } from "../scripts/pes_core/legacy_view.ts";
import { SLUG } from "./helpers/cli_write_env.ts";
import { run_import, with_legacy } from "./helpers/legacy_env.ts";
import { db_with_form, http, page_data, step, with_server, write_spec } from "./helpers/web_env.ts";

const spec_with = (id: string, questions: unknown[]) => ({ id, stage: "plan", kind: "review", round: 2, title: "점검", questions });

// ---------------------------------------------------------------------------
// 권장 3

test("R3a 없는 질문·자기 자신을 가리키는 show_if 는 대시보드 데이터에서 버려지고 그 질문은 늘 보인다 (필수는 필수 그대로)", async () => {
  const c = await db_with_form();
  try {
    const qs = [
      { id: "scope", type: "single", label: "범위는?", required: true, options: [{ value: "narrow", label: "좁게" }, { value: "wide", label: "넓게" }] },
      { id: "ghost-dep", type: "text", label: "없는 질문에 기대는 질문", required: true, show_if: { id: "ghost", in: ["x"] } },
      { id: "self-dep", type: "text", label: "자기 자신에 기대는 질문", required: true, show_if: { id: "self-dep", in: ["x"] } },
      { id: "good-dep", type: "text", label: "정상 조건 질문", required: false, show_if: { id: "scope", in: ["wide"] } },
    ];
    step(c, ["ask", SLUG, write_spec(c, spec_with("plan-check-r2", qs), "r3a.json")]);
    step(c, ["render", SLUG]); // pes.ts: 대시보드 파일은 render 가 다시 짓는다
    await with_server(c, {}, async (s) => {
      const review = page_data((await http(s, `/${SLUG}/`)).text).project.stages.plan.review;
      assert.ok(review, "점검 질문이 대시보드에 있다");
      const by = (label: string): any => review.questions.find((q: any) => q.label === label);
      const ids = new Set(review.questions.map((q: any) => q.id));
      for (const label of ["없는 질문에 기대는 질문", "자기 자신에 기대는 질문"]) {
        const q = by(label);
        assert.ok(q, `${label}: 질문은 남는다`);
        assert.equal(q.show_if, undefined, `${label}: 못 찾는/자기 참조 조건은 버린다 (늘 보인다)`);
        assert.equal(q.required, true, `${label}: 필수는 그대로`);
      }
      const good = by("정상 조건 질문");
      assert.ok(good.show_if, "정상 조건은 남는다");
      assert.ok(ids.has(good.show_if.id), "남은 조건은 화면 질문 id 를 가리킨다");
      assert.equal(good.show_if.id, by("범위는?").id);
      for (const q of review.questions) {
        if (q.show_if) {
          assert.ok(ids.has(q.show_if.id), `show_if.id(${q.show_if.id}) 는 화면 질문 id 중 하나`);
          assert.notEqual(q.show_if.id, q.id, "자기 자신을 가리키지 않는다");
        }
      }
    });
  } finally {
    c.close();
  }
});

test("R3b legacy import 로 옮겨 온 v0.15 review 질문의 show_if 는 bank_key 로 해석돼 화면 질문 id 와 맞는다 (못 찾는·자기 참조는 버린다)", async () => {
  await with_legacy(async (env, api) => {
    const dir = join(env.home.root, "r3b-legacy");
    mkdirSync(dir, { recursive: true });
    const review = {
      round: 1,
      summary: "합성 옛 점검",
      questions: [
        { id: "scope", type: "single", label: "범위는?", required: true, options: [{ value: "narrow", label: "좁게" }, { value: "wide", label: "넓게" }] },
        { id: "why", type: "text", label: "넓게 하는 이유는?", required: true, show_if: { id: "scope", in: ["wide"] } },
        { id: "orphan", type: "text", label: "고아 조건", required: true, show_if: { id: "ghost", in: ["x"] } },
        { id: "loop", type: "text", label: "자기 참조", required: true, show_if: { id: "loop", in: ["x"] } },
      ],
    };
    writeFileSync(
      join(dir, "project.json"),
      JSON.stringify({
        pes: 1, topic: "합성 옛 주제", slug: "r3b-legacy", created: "2026-03-01", current: "plan", settings: {}, processed: [], complete: false,
        stages: { plan: { status: "active", round: 1, items: [], review } },
      }),
      "utf8",
    );
    const result = await run_import(env, api, dir);
    assert.equal(result.state, "staging");
    const set = env.db.get<{ id: string }>("SELECT id FROM question_sets WHERE project_id = ? AND purpose = 'review'", result.project_id);
    assert.ok(set, "옮겨 온 review 질문 세트가 있다");
    const rows = review_questions(env.db, result.project_id, set.id);
    assert.equal(rows.length, 4);
    const ids = new Set(rows.map((q: any) => q.id));
    const by = (label: string): any => rows.find((q: any) => q.label === label);
    const why = by("넓게 하는 이유는?");
    assert.ok(why.show_if, "bank_key(scope) 로 해석돼 조건이 남는다");
    assert.ok(ids.has(why.show_if.id), `show_if.id(${why.show_if.id}) 는 화면 질문 id 중 하나`);
    assert.equal(why.show_if.id, by("범위는?").id, "scope 질문의 화면 id 를 가리킨다");
    assert.deepEqual(why.show_if.in, ["wide"], "조건의 나머지 값은 그대로");
    assert.equal(why.required, true);
    for (const label of ["고아 조건", "자기 참조"]) {
      assert.equal(by(label).show_if, undefined, `${label}: 버려져 늘 보인다`);
      assert.equal(by(label).required, true);
    }
  });
});

test("R3c position 없는 기존 DB 세트(이번 수정 이전 pes ask 로 올린 것)는 조건을 못 찾아 버려지고 늘 보인다 — 대시보드 데이터에서도 같다", async () => {
  const c = await db_with_form();
  try {
    const qs = [
      { id: "scope", type: "single", label: "범위는?", required: true, options: [{ value: "narrow", label: "좁게" }, { value: "wide", label: "넓게" }] },
      { id: "why", type: "text", label: "넓게 하는 이유는?", required: true, show_if: { id: "scope", in: ["wide"] } },
    ];
    step(c, ["ask", SLUG, write_spec(c, spec_with("plan-check-old", qs), "r3c.json")]);
    step(c, ["render", SLUG]); // pes.ts: 대시보드 파일은 render 가 다시 짓는다
    // 이전 판 모양으로 되돌린다: show_if 에 position 이 없고 질문엔 bank_key 도 없다(spec id 만 남은 show_if)
    const changed = c.env.db.run(
      `UPDATE question_versions SET show_if = json_remove(show_if, '$.position') WHERE show_if IS NOT NULL AND show_if LIKE '%"position"%'`,
    );
    assert.ok(Number(changed.changes) >= 1, "position 이 든 show_if 가 있었다(지금 구현의 저장 모양)");
    const set = c.env.db.get<{ id: string; project_id: string }>(
      "SELECT s.id AS id, s.project_id AS project_id FROM question_sets s WHERE s.form_key = 'plan-check-old'",
    );
    assert.ok(set, "점검 세트가 있다");
    const rows = review_questions(c.env.db, set.project_id, set.id);
    const why = rows.find((q: any) => q.label === "넓게 하는 이유는?") as any;
    assert.ok(why, "질문은 남는다");
    assert.equal(why.show_if, undefined, "position 이 없고 id 도 bank_key 도 못 찾으면 조건을 버린다 (늘 보인다)");
    assert.equal(why.required, true);
    await with_server(c, {}, async (s) => {
      const review = page_data((await http(s, `/${SLUG}/`)).text).project.stages.plan.review;
      const q = review.questions.find((x: any) => x.label === "넓게 하는 이유는?");
      assert.ok(q, "대시보드에도 있다");
      assert.equal(q.show_if, undefined, "대시보드 데이터에서도 조건이 없다 (숨김 아님)");
      assert.equal(q.required, true);
    });
  } finally {
    c.close();
  }
});

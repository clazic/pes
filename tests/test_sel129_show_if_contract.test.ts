/**
 * SEL-129 계약 시험 — 앱 show_if 판정이 서버 판정과 같다 (tester, 작성 모드).
 *
 * 서버 판정: scripts/pes_core/commands/questions.ts 의 hidden_questions(db, project_id, ids) (judge_questions 의 applicable).
 *   조건 {id, in:[…]} — 조건 질문의 현재 제출 답(질문 현재 버전에 대한 것)이 in 의 값 하나라도 포함하면 보임. 답 없음 → 숨김.
 *   모양을 모르는 조건(JSON 아님 · id 문자열 아님 · in 배열 아님)은 보임. 숨은 질문은 필수가 아니다(resume_ready · form_complete 가 건너뜀).
 * 앱 판정: app/src/api/show-if.ts (정한 인터페이스는 app/src/api/sel129-show-if.test.ts 머리말) — showIfFromWire → showIfApplies.
 *   같은 입력 표(조건 in × 부모 유형 × 부모 답)를 두 쪽에 넣고 결과가 같은지 대조한다. 앱 쪽 값은 서버에 실제로 낸 답 그대로(하나 고르기·글 = 값 1개, 여러 개 = 고른 전부).
 *
 * 구현 전에는 앱 모듈이 없어 [신규] 시험이 실패한다(없는 모듈 때문). 서버만 보는 [회귀] 시험은 지금도 통과한다.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { hidden_questions } from "../scripts/pes_core/commands/questions.ts";
import { assert_ok, with_api, type ApiEnv } from "./helpers/api_env.ts";
import { api_submit, latest_set, make_form, owner_post, single_spec, text_spec } from "./helpers/sel90_env.ts";

type ShowIf = { question_id: string; in: string[] };
interface AppShowIf {
  showIfFromWire(raw: unknown): { show_if: ShowIf | null; unsupported: boolean };
  showIfApplies(s: ShowIf | null | undefined, chosen: readonly string[] | null | undefined): boolean;
}
// 변수로 불러 구현 전에도 tsc 가 통과한다(없는 모듈은 실행 때 실패)
const APP_MODULE = "../app/src/api/show-if.ts";
const app = (): Promise<AppShowIf & { showIfToWire(s: ShowIf): { id: string; in: string[] } }> => import(APP_MODULE);

type Kind = "single" | "multi" | "text";
const parent_spec = (kind: Kind): Record<string, unknown> =>
  kind === "single"
    ? single_spec("부모", { required: false })
    : kind === "multi"
      ? single_spec("부모", { required: false, type: "multi", default_value: null })
      : text_spec("부모");

/** 부모 + 필수 자식(조건 걸림) 한 쌍을 만들고, 부모 답을 서버에 낸 뒤 서버의 숨김 판정을 돌려준다. answer undefined = 부모 답 없음. */
async function server_hidden_in(env: ApiEnv, kind: Kind, condition_in: unknown, answer: string | string[] | undefined): Promise<boolean> {
  const f = await make_form(env, [parent_spec(kind)]);
  const parent = f.ids[0]!;
  const added = assert_ok(
    await owner_post(env, "/questions", {
      stage_id: f.stage_id,
      round_id: f.round_id,
      purpose: "stage_start",
      form_key: "main",
      question: single_spec("자식", { required: true, show_if: { id: parent, in: condition_in } }),
    }),
    201,
  );
  const child = added.question.id as string;
  if (answer !== undefined) {
    const set_id = latest_set(env.db, env.p.project_id, f.stage_id).id;
    assert_ok(await api_submit(env, set_id, [{ question_id: parent, value: answer }], { mode: "single" }), 201);
  }
  return hidden_questions(env.db, env.p.project_id, [child]).has(child);
}

/** 경우마다 새 환경(한 판에 열린 라운드는 하나뿐이다) */
async function server_hidden(kind: Kind, condition_in: unknown, answer: string | string[] | undefined): Promise<boolean> {
  let hidden = false;
  await with_api(async (env) => {
    hidden = await server_hidden_in(env, kind, condition_in, answer);
  });
  return hidden;
}

const INS: string[][] = [["a", "b"], ["a"], ["c", "b"], ["a", "b", "c"]];
const ANSWERS: Record<Kind, (string | string[] | undefined)[]> = {
  single: ["a", "b", "c", undefined],
  multi: [["a"], ["b"], ["c"], ["a", "c"], ["c", "b"], ["a", "b", "c"], undefined],
  text: ["a", "c", "d", undefined],
};
const values_of = (answer: string | string[] | undefined): string[] | null => (answer === undefined ? null : Array.isArray(answer) ? answer : [answer]);
const label = (kind: Kind, condition_in: string[], answer: unknown) => `${kind} 부모 · in ${JSON.stringify(condition_in)} · 답 ${JSON.stringify(answer ?? null)}`;

// ---------------------------------------------------------------------------
// [회귀] 서버 판정이 이 시험이 기대하는 표와 같다 (앱이 맞춰야 할 정답)

test("[회귀] 서버: in:[a,b] — 하나 고르기 부모는 a·b 에서 보이고 c · 답 없음에서 숨는다", async () => {
  assert.equal(await server_hidden("single", ["a", "b"], "a"), false);
  assert.equal(await server_hidden("single", ["a", "b"], "b"), false);
  assert.equal(await server_hidden("single", ["a", "b"], "c"), true);
  assert.equal(await server_hidden("single", ["a", "b"], undefined), true);
});

test("[회귀] 서버: in:[a,b] — 여러 개 고르기 부모는 하나라도 a·b 면 보인다", async () => {
  assert.equal(await server_hidden("multi", ["a", "b"], ["a", "c"]), false);
  assert.equal(await server_hidden("multi", ["a", "b"], ["c"]), true);
});

// ---------------------------------------------------------------------------
// [신규] 같은 입력 표 → 앱 판정 == 서버 판정

for (const kind of ["single", "multi", "text"] as Kind[]) {
  test(`[신규] 앱 == 서버: ${kind} 부모 — in × 답 표 전부에서 보임·숨김이 같다 (숨김 = 필수 아님도 같다)`, async () => {
    const m = await app();
    for (const condition_in of INS) {
      for (const answer of ANSWERS[kind]) {
        const hidden = await server_hidden(kind, condition_in, answer);
        const parsed = m.showIfFromWire({ id: "qst-parent", in: condition_in });
        assert.equal(parsed.unsupported, false, label(kind, condition_in, answer));
        const shown = m.showIfApplies(parsed.show_if, values_of(answer));
        assert.equal(shown, !hidden, `앱 ${shown ? "보임" : "숨김"} ≠ 서버 ${hidden ? "숨김" : "보임"} — ${label(kind, condition_in, answer)}`);
      }
    }
  });
}

test("[신규] 앱 == 서버: 빈 in 은 어떤 답에도 숨는다", async () => {
  const m = await app();
  for (const answer of ["a", "c", undefined]) {
    const hidden = await server_hidden("single", [], answer);
    const shown = m.showIfApplies(m.showIfFromWire({ id: "qst-parent", in: [] }).show_if, values_of(answer));
    assert.equal(shown, !hidden, `빈 in · 답 ${answer ?? "없음"}`);
    assert.equal(hidden, true);
  }
});

test("[신규] 앱 == 서버: in 에 문자열 아닌 값이 섞여도 문자열 항목 기준으로 같은 판정이고 앱은 '지원 안 함'으로 표시한다", async () => {
  const m = await app();
  const condition_in = ["a", 1, "b"];
  for (const answer of ["a", "b", "c", undefined]) {
    const hidden = await server_hidden("single", condition_in, answer);
    const parsed = m.showIfFromWire({ id: "qst-parent", in: condition_in });
    assert.equal(parsed.unsupported, true);
    assert.equal(m.showIfApplies(parsed.show_if, values_of(answer)), !hidden, `혼합 in · 답 ${answer ?? "없음"}`);
  }
});

// ---------------------------------------------------------------------------
// [신규] 앱이 못 다루는 모양: 서버는 '보임'(모르는 모양은 조건 없음 취급), 앱은 같이 보이되 정직하게 '지원 안 함'

const OPAQUE: [string, (parent: string) => unknown][] = [
  ["in 없음", (p) => ({ id: p })],
  ["id 없음", () => ({ in: ["a"] })],
  ["in 이 문자열", (p) => ({ id: p, in: "a" })],
  ["문자열 조건", () => "a"],
  ["배열 조건", () => ["a"]],
];

test("[신규] 모르는 모양의 조건: 서버는 보임, 앱도 보임 + unsupported true + show_if null", async () => {
  const m = await app();
  for (const [name, make] of OPAQUE) {
    await with_api(async (env) => {
      const f = await make_form(env, [parent_spec("single"), single_spec("자식", { required: true })]);
      const [parent, child] = f.ids as [string, string];
      const raw = make(parent);
      env.db.run(
        "UPDATE question_versions SET show_if = ? WHERE version_id = (SELECT current_version_id FROM objects WHERE id = ?)",
        JSON.stringify(raw),
        child,
      );
      const hidden = hidden_questions(env.db, env.p.project_id, [child]).has(child);
      const parsed = m.showIfFromWire(raw);
      assert.equal(hidden, false, `서버는 모르는 모양(${name})을 보임으로 본다`);
      assert.equal(parsed.unsupported, true, name);
      assert.equal(parsed.show_if, null, name);
      assert.equal(m.showIfApplies(parsed.show_if, null), !hidden, name);
    });
  }
});

test("[신규] 앱이 읽은 서버 조건을 다시 쓰면 서버가 가진 값과 같다 (showIfToWire 왕복 — 값 하나로 줄지 않는다)", async () => {
  const mod = await app();
  await with_api(async (env) => {
    const f = await make_form(env, [parent_spec("single")]);
    const parent = f.ids[0]!;
    assert_ok(
      await owner_post(env, "/questions", {
        stage_id: f.stage_id,
        round_id: f.round_id,
        purpose: "stage_start",
        form_key: "main",
        question: single_spec("자식", { required: false, show_if: { id: parent, in: ["a", "b"] } }),
      }),
      201,
    );
    const stored = env.db.get<{ show_if: string }>(
      "SELECT qv.show_if AS show_if FROM question_versions qv JOIN objects o ON o.current_version_id = qv.version_id WHERE o.kind = 'question' AND qv.show_if LIKE '%\"b\"%'",
    );
    assert.ok(stored, "서버가 in 두 값을 저장했다");
    const raw: unknown = JSON.parse(stored.show_if);
    assert.deepEqual(mod.showIfToWire(mod.showIfFromWire(raw).show_if!), raw);
  });
});

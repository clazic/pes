/**
 * SEL-90 U2a — 1차 리뷰(r1) 수정 시험. 모든 값은 지어낸 것이다. 기존 단언은 바꾸지 않는다.
 *
 *   권장 2  없는 질문은 누구에게나 not_found, 있는 질문은 리스 없는 에이전트에 forbidden — 다섯 명령 모두 같은 순서
 *   권장 3  form_complete 와 resume_ready 가 show_if 를 같게 본다
 *   권장 4  마지막 질문을 철회하면 빈 최신 세트가 생기고, 질문 추가로 이어 붙을 수 있다
 *   권장 5  영수증 action·사건 이름을 고정한다 (question.retracted / deferred / merged / commented; withdrawn 은 'raw' 금지 시험에 걸림)
 *   권장 6  extend_latest 는 라운드가 달라도 같은 (stage, form_key)의 최신 세트에서 열린 질문을 이어받는다
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { publish_set, resume_ready, submit_answers } from "../scripts/pes_core/questions.ts";
import { assert_ok, with_api } from "./helpers/api_env.ts";
import { ctx_for, second_project } from "./helpers/blob_env.ts";
import { make_content, seal, start } from "./helpers/editions_env.ts";
import { add_agent, agent_ctx, events_of, receipt_of, rejects_api } from "./helpers/questions_env.ts";
import {
  cmd,
  current_row,
  latest_set,
  make_form,
  owner_post,
  single_spec,
  text_spec,
} from "./helpers/sel90_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

// ---------------------------------------------------------------------------
// 권장 2 — 존재 → 리스 순서

test("[R1-2] 없는 질문은 리스 없는 에이전트에게도 not_found, 있는 질문은 forbidden — revise·withdraw·defer·merge·comment_add 모두", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("첫째 질문"), single_spec("둘째 질문")]);
    const [q1, q2] = f.ids;
    const agent = add_agent(env, "agent-r1-order");
    const calls: [string, (question_id: string) => Record<string, unknown>][] = [
      ["question.revise", (question_id) => ({ question_id, text: "고친 문구" })],
      ["question.withdraw", (question_id) => ({ question_id })],
      ["question.defer", (question_id) => ({ question_id })],
      ["question.merge", (question_id) => ({ question_id, merged_into_question_id: q2! })],
      ["question.comment_add", (question_id) => ({ question_id, body_md: "의견" })],
    ];
    const sig = state_signature(env.db);
    for (const [name, body] of calls) {
      await rejects_api(
        env.service.execute(agent_ctx(agent, `no-${name}`), name, body("no-such-question")),
        "not_found",
      );
      await rejects_api(env.service.execute(agent_ctx(agent, `yes-${name}`), name, body(q1!)), "forbidden");
    }
    assert.equal(state_signature(env.db), sig, "거부는 아무것도 쓰지 않는다");
  });
});

test("[R1-2b] 다른 프로젝트의 실제 질문 id 로 불러도 not_found 다 — 질문 조회는 호출한 프로젝트로 걸러진다", async () => {
  await with_api(async (env) => {
    const mine = await make_form(env, [single_spec("내 질문"), single_spec("내 둘째")]);
    const other_project = await second_project(env, "synthetic-r1-other");
    const other_env = { ...env, p: other_project, ctx: (key: string) => ctx_for(other_project, key) } as typeof env;
    const theirs = await make_form(other_env, [single_spec("남의 질문")]);
    const foreign = theirs.ids[0]!;
    assert.ok(!mine.ids.includes(foreign));
    const agent = add_agent(env, "agent-r1-foreign");
    const sig = state_signature(env.db);
    for (const name of ["question.revise", "question.withdraw", "question.defer", "question.merge", "question.comment_add"]) {
      const body: Record<string, unknown> =
        name === "question.revise" ? { question_id: foreign, text: "고친 문구" }
        : name === "question.merge" ? { question_id: foreign, merged_into_question_id: mine.ids[1]! }
        : name === "question.comment_add" ? { question_id: foreign, body_md: "의견" }
        : { question_id: foreign };
      await rejects_api(env.service.execute(agent_ctx(agent, `foreign-${name}`), name, body), "not_found");
    }
    assert.equal(state_signature(env.db), sig, "거부는 아무것도 쓰지 않는다");
  });
});

// ---------------------------------------------------------------------------
// 권장 3 — show_if: form_complete 와 resume_ready 가 같다

test("[R1-3] 부모가 조건 밖이면 숨은 필수 자식은 form_complete 도 resume_ready 도 요구하지 않는다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("부모 질문")]);
    const parent = f.ids[0]!;
    const where = { stage_id: f.stage_id, round_id: f.round_id, purpose: "stage_start", form_key: "main" };
    const next = (
      await publish_set(env.service, env.ctx("sf-pub"), {
        ...where,
        questions: [{ question_id: parent }, text_spec("조건부 자식", { required: true, show_if: { id: parent, in: ["a"] } })],
      })
    ).result as any;
    const child = next.members[1].question_id as string;

    // 아직 아무 답도 없다: 부모가 필수 미답이라 부모만 빠진 것으로 본다 (자식은 조건이 거짓이라 숨음)
    const none = resume_ready(env.db, env.p.project_id, f.round_id);
    assert.deepEqual(none.missing.map((m) => m.question_id), [parent]);

    // 부모=b: 자식은 숨는다 → 둘 다 "끝"
    const sub = (
      await submit_answers(env.service, env.ctx("sf-b"), {
        set_id: next.set_id,
        mode: "bundle",
        answers: [{ question_id: parent, value: "b" }],
      })
    ).result as any;
    assert.equal(sub.form_complete, true);
    assert.deepEqual(sub.missing_required, []);
    assert.deepEqual(resume_ready(env.db, env.p.project_id, f.round_id), { ready: true, missing: [] });

    // 부모=a: 자식이 적용된다 → 둘 다 "아직"
    const again = (
      await submit_answers(env.service, env.ctx("sf-a"), {
        set_id: next.set_id,
        mode: "single",
        answers: [{ question_id: parent, value: "a" }],
      })
    ).result as any;
    assert.equal(again.form_complete, false);
    assert.deepEqual(again.missing_required, [child]);
    const ready = resume_ready(env.db, env.p.project_id, f.round_id);
    assert.equal(ready.ready, false);
    assert.deepEqual(ready.missing.map((m) => m.question_id), [child]);

    // 자식이 차면 다시 둘 다 "끝"
    await submit_answers(env.service, env.ctx("sf-c"), {
      set_id: next.set_id,
      mode: "single",
      answers: [{ question_id: child, value: "채움" }],
    });
    assert.deepEqual(resume_ready(env.db, env.p.project_id, f.round_id), { ready: true, missing: [] });
  });
});

// ---------------------------------------------------------------------------
// 권장 4 — 빈 세트

test("[R1-4] 마지막 질문을 철회하면 빈 최신 세트가 생기고, 제출은 거부되며, 질문 추가로 이어 붙는다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("유일한 질문")]);
    const only = f.ids[0]!;
    await cmd(env, "ed-wd", "question.withdraw", { question_id: only });

    const empty = latest_set(env.db, env.p.project_id, f.stage_id);
    assert.equal(empty.version_no, 2);
    assert.deepEqual(empty.members, [], "구성원이 0인 최신 세트는 허용된다");

    await rejects_api(
      submit_answers(env.service, env.ctx("ed-sub"), { set_id: empty.id, answers: [] }),
      "invalid_payload",
    );
    // 빈 세트는 그대로 최신이다(아무 것도 새 세트를 만들지 않았다)
    assert.equal(latest_set(env.db, env.p.project_id, f.stage_id).id, empty.id);

    const res = await owner_post(env, "/questions", {
      stage_id: f.stage_id,
      round_id: f.round_id,
      purpose: "stage_start",
      form_key: "main",
      question: text_spec("새 질문"),
    });
    const data = assert_ok(res, 201);
    const now = latest_set(env.db, env.p.project_id, f.stage_id);
    assert.equal(now.version_no, 3);
    assert.deepEqual(now.members, [data.question.id], "철회된 질문은 따라오지 않고 새 질문만 남는다");
  });
});

// ---------------------------------------------------------------------------
// 권장 5 — 사건 이름

test("[R1-5] 영수증 action 과 사건 type 이 question.retracted·deferred·merged·commented 로 고정된다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("첫째"), single_spec("둘째"), single_spec("셋째")]);
    const [q1, q2, q3] = f.ids;
    const cases: [string, string, string, Record<string, unknown>][] = [
      ["ev-wd", "question.withdraw", "question.retracted", { question_id: q1! }],
      ["ev-df", "question.defer", "question.deferred", { question_id: q2! }],
      ["ev-mg", "question.merge", "question.merged", { question_id: q3!, merged_into_question_id: q2! }],
      ["ev-cm", "question.comment_add", "question.commented", { question_id: q2!, body_md: "의견" }],
    ];
    // merge 대상(q2)은 열려 있어야 하므로 합치기를 보류보다 먼저 한다
    const order = [cases[0]!, cases[2]!, cases[1]!, cases[3]!];
    for (const [key, command, action, body] of order) {
      await cmd(env, key, command, body);
      const receipt = receipt_of(env.db, env.p.project_id, key);
      assert.ok(receipt, `${key} 영수증`);
      assert.equal(receipt.action, action);
      const types = events_of(env.db, receipt.id).map((e) => e.type);
      assert.equal(types[0], action, "첫 사건이 영수증 action 과 같은 이름이다");
    }
  });
});

// ---------------------------------------------------------------------------
// 권장 6 — extend_latest 는 라운드를 가리지 않는다

test("[R1-6] 새 라운드의 질문 추가는 앞 라운드(봉인) 최신 세트의 열린 질문을 이어받고, 철회된 질문은 따라오지 않는다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("열린 질문"), single_spec("철회될 질문")], "xr");
    const [open_q, gone_q] = f.ids;
    await cmd(env, "xr-wd", "question.withdraw", { question_id: gone_q! });
    const content = await make_content(env, "xr-content");
    await seal(env, f.round_id, [{ object_id: content.object_id, version_id: content.version_id }], "xr-seal");
    const round2 = await start(env, f.stage_id, "xr-start-2");
    assert.notEqual(round2.round_id, f.round_id);

    const out = await publish_set(env.service, env.ctx("xr-pub-2"), {
      stage_id: f.stage_id,
      round_id: round2.round_id,
      purpose: "stage_start",
      form_key: "main",
      questions: [text_spec("두 번째 라운드의 새 질문")],
      extend_latest: true,
    });
    const result = out.result as any;
    const members = result.members.map((m: any) => m.question_id) as string[];
    assert.equal(members.length, 2);
    assert.equal(members[0], open_q, "앞 라운드 폼의 열린 질문이 앞에 온다");
    assert.ok(!members.includes(gone_q!), "철회된 질문은 따라오지 않는다");
    assert.equal(current_row(env.db, open_q!).state, "open");
    const now = latest_set(env.db, env.p.project_id, f.stage_id);
    assert.equal(now.id, result.set_id);
    assert.equal(now.members.length, 2);
  });
});

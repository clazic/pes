/**
 * SEL-90 U2a — 질문 철회·보류·합치기 (tester, 작성 모드). 구현 전에는 명령·라우트가 없어 실패하는 것이 정상.
 *
 * 정한 이름·모양(이슈가 이름만 주고 모양은 주지 않아 여기서 정한다):
 *   명령  question.withdraw {question_id, base_version_id?, reason?}
 *         question.defer    {question_id, base_version_id?, defer_until? (정수 ms), reason?}
 *         question.merge    {question_id, merged_into_question_id, base_version_id?, reason?}
 *   각 명령은 질문의 새 버전(version_no + 1)을 쓴다 — 상태는 question_versions.state, 옛 버전·옛 답은 그대로.
 *   결과 {project_id, question_id, question_version_id, version_no, state}.
 *   질문이 어떤 폼의 최신 세트에 들어 있으면 같은 tx 에서 그 질문만 뺀 새 세트를 발행한다(빼기 = 새 폼 버전).
 *   라우트 POST P/questions/{q}/withdraw|defer|merge → 201 data {question:{id, version_id, version_no(10진 문자열),
 *         state}, previous_answers_preserved:true} (merge 는 question.merged_into_question_id 도). 멱등 키 필수.
 *
 * 상태 전이표(채택):
 *   open     -> withdrawn | deferred | merged
 *   deferred -> withdrawn | merged            (deferred -> deferred, -> open 은 이 이슈 범위 밖)
 *   withdrawn, merged -> 끝(어느 명령이든 conflict)
 *   merge 대상: 같은 프로젝트의 open 질문, 자기 자신 아님. 다른 프로젝트 질문은 not_found.
 *   권한: 사람 소유자. 리스 없는 에이전트는 forbidden.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { resume_ready, submit_answers } from "../scripts/pes_core/questions.ts";
import { assert_ok, call, make_agent, with_api, type ApiEnv } from "./helpers/api_env.ts";
import { P, assert_final_error, NEXT_ACTION } from "./helpers/api_flow.ts";
import { add_agent, agent_ctx, rejects_api } from "./helpers/questions_env.ts";
import { second_project } from "./helpers/blob_env.ts";
import {
  api_submit_ok,
  cmd,
  current_answer,
  current_row,
  history_counts,
  latest_set,
  make_form,
  owner_post,
  receipts_count,
  set_count,
  single_spec,
  text_spec,
  versions_of,
} from "./helpers/sel90_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const A = (id: string, value = "a") => ({ question_id: id, value });

async function two_question_form(env: ApiEnv) {
  return make_form(env, [single_spec("첫째 질문"), single_spec("둘째 질문"), text_spec("셋째 질문")]);
}

// ---------------------------------------------------------------------------
// 명령: 철회

test("question.withdraw: 새 버전(state=withdrawn), 옛 버전·질문 행·옛 답은 그대로, 삭제 0", async () => {
  await with_api(async (env) => {
    const f = await two_question_form(env);
    const [q1, q2] = f.ids;
    await submit_answers(env.service, env.ctx("sub-1"), { set_id: f.set.set_id, answers: [A(q1!), A(q2!, "c")] });
    const answer_before = current_answer(env.db, q1!);
    const before = history_counts(env.db);

    const out = await cmd(env, "wd-1", "question.withdraw", { question_id: q1!, reason: "합성 철회 사유" });
    assert.equal(out.replayed, false);
    const result = out.result as any;
    assert.equal(result.question_id, q1);
    assert.equal(result.version_no, 2);
    assert.equal(result.state, "withdrawn");

    const versions = versions_of(env.db, q1!);
    assert.equal(versions.length, 2, "옛 버전은 남고 새 버전이 하나 붙는다");
    assert.equal(versions[0]!.state, "open", "옛 버전 행은 바뀌지 않는다");
    assert.equal(versions[1]!.state, "withdrawn");
    assert.equal(versions[1]!.version_id, result.question_version_id);
    assert.equal(versions[1]!.text, versions[0]!.text);
    assert.equal(current_row(env.db, q1!).version_id, result.question_version_id);

    const after = history_counts(env.db);
    for (const [table, n] of Object.entries(before)) {
      assert.ok(after[table]! >= n, `${table}: 행이 줄지 않는다 (hard delete 없음)`);
    }
    assert.equal(after.questions, before.questions);
    assert.equal(after.answers, before.answers);
    assert.equal(after.answer_versions, before.answer_versions, "옛 답은 그대로이고 새 답도 없다");
    assert.deepEqual(current_answer(env.db, q1!), answer_before, "옛 답을 건드리지 않는다");
    assert.equal(after.mutation_commits - before.mutation_commits, 1, "명령 하나 = 영수증 하나");
  });
});

test("question.withdraw: 폼에서 빠진다 — 새 폼 세트(version_no + 1)에 그 질문이 없고 옛 세트는 그대로", async () => {
  await with_api(async (env) => {
    const f = await two_question_form(env);
    const [q1, q2, q3] = f.ids;
    const old_set = f.set.set_id;
    assert.equal(set_count(env.db, f.stage_id), 1);

    await cmd(env, "wd-2", "question.withdraw", { question_id: q2! });
    assert.equal(set_count(env.db, f.stage_id), 2, "빼기마다 새 세트가 발행된다");
    const now = latest_set(env.db, env.p.project_id, f.stage_id);
    assert.equal(now.version_no, 2);
    assert.deepEqual(now.members, [q1, q3], "남은 질문의 순서가 유지된다");
    const old = env.db.all("SELECT question_id FROM question_set_members WHERE set_id = ? ORDER BY position", old_set);
    assert.deepEqual(old.map((r: any) => r.question_id), [q1, q2, q3], "옛 세트의 멤버는 바뀌지 않는다");
    const prev = env.db.get<{ previous_set_id: string }>("SELECT previous_set_id FROM question_sets WHERE id = ?", now.id);
    assert.equal(prev?.previous_set_id, old_set);

    // 옛 세트로는 더 답할 수 없고(최신 세트가 아님), 새 세트에는 그 질문이 없다
    await rejects_api(submit_answers(env.service, env.ctx("sub-old"), { set_id: old_set, answers: [A(q1!)] }), "conflict");
    await rejects_api(submit_answers(env.service, env.ctx("sub-new"), { set_id: now.id, answers: [A(q2!)] }), "invalid_payload");
    const ok = await submit_answers(env.service, env.ctx("sub-ok"), { set_id: now.id, answers: [A(q1!)] });
    assert.equal(ok.replayed, false);
  });
});

test("철회·보류·합치기한 필수 질문은 재개 준비(resume_ready)를 막지 않는다 — 이유 없이 사라지지도 않는다", async () => {
  await with_api(async (env) => {
    const f = await two_question_form(env);
    const [q1, q2] = f.ids;
    await cmd(env, "wd-3", "question.withdraw", { question_id: q1! });
    await cmd(env, "df-3", "question.defer", { question_id: q2! });
    const ready = resume_ready(env.db, env.p.project_id, f.round_id);
    assert.deepEqual(ready.missing.map((m) => m.question_id), [], "남은 필수 질문이 없으면 부족 목록이 비어 있다");
    assert.equal(ready.ready, true);
  });
});

// ---------------------------------------------------------------------------
// 명령: 보류

test("question.defer: state=deferred, defer_until 기록, 폼에서 빠지고 옛 답은 그대로", async () => {
  await with_api(async (env) => {
    const f = await two_question_form(env);
    const [q1, q2, q3] = f.ids;
    await submit_answers(env.service, env.ctx("sub-d"), { set_id: f.set.set_id, answers: [A(q2!)] });
    const until = env.clock.now_ms() + 86_400_000;
    const out = await cmd(env, "df-1", "question.defer", { question_id: q2!, defer_until: until });
    assert.equal((out.result as any).state, "deferred");
    const row = current_row(env.db, q2!);
    assert.equal(row.state, "deferred");
    assert.equal(row.defer_until, until);
    assert.equal(versions_of(env.db, q2!)[0]!.state, "open");
    assert.deepEqual(latest_set(env.db, env.p.project_id, f.stage_id).members, [q1, q3]);
    assert.equal(current_answer(env.db, q2!)?.value, "a", "보류해도 옛 답은 남는다");

    // defer_until 은 정수여야 한다
    await rejects_api(cmd(env, "df-bad", "question.defer", { question_id: q1!, defer_until: "내일" }), "invalid_payload");
    assert.equal(current_row(env.db, q1!).state, "open");
  });
});

// ---------------------------------------------------------------------------
// 명령: 합치기

test("question.merge: state=merged + merged_into_question_id, 폼에서 빠지고 옛 답은 대상으로 옮겨지지 않는다", async () => {
  await with_api(async (env) => {
    const f = await two_question_form(env);
    const [q1, q2, q3] = f.ids;
    await submit_answers(env.service, env.ctx("sub-m"), { set_id: f.set.set_id, answers: [A(q1!, "b")] });
    const out = await cmd(env, "mg-1", "question.merge", { question_id: q1!, merged_into_question_id: q2! });
    assert.equal((out.result as any).state, "merged");
    const row = current_row(env.db, q1!);
    assert.equal(row.state, "merged");
    assert.equal(row.merged_into_question_id, q2);
    assert.equal(versions_of(env.db, q1!).length, 2);
    assert.deepEqual(latest_set(env.db, env.p.project_id, f.stage_id).members, [q2, q3], "합쳐진 질문은 빠지고 대상은 남는다");
    assert.equal(current_answer(env.db, q1!)?.value, "b", "옛 답은 합쳐진 질문에 그대로 있다");
    assert.equal(current_answer(env.db, q2!), null, "답을 대상 질문으로 자동 승계하지 않는다");
    assert.equal(current_row(env.db, q2!).state, "open", "대상 질문은 바뀌지 않는다");
  });
});

test("question.merge 대상 검증: 자기 자신·없는 질문·다른 프로젝트·열려 있지 않은 질문은 거부하고 아무것도 쓰지 않는다", async () => {
  await with_api(async (env) => {
    const f = await two_question_form(env);
    const [q1, q2, q3] = f.ids;
    const other = await second_project(env, "synthetic-sel90-b");
    const other_form = await (async () => {
      // 다른 프로젝트의 질문: 그 프로젝트 소유자 문맥으로 열고 게시
      const { stage_ids, start } = await import("./helpers/editions_env.ts");
      const { publish } = await import("./helpers/questions_env.ts");
      const e2 = { ...env, p: other, ctx: (k: string) => ({ project_id: other.project_id, actor_id: other.actor_id, via: "cli" as const, client_request_id: k }) } as any;
      const s = stage_ids(env.db, other.edition_id);
      const round = await start(e2, s.plan, "other-start");
      return publish(e2, { stage_id: s.plan, round_id: round.round_id }, [single_spec("다른 프로젝트 질문")], "other-pub");
    })();
    const foreign = other_form.members[0]!.question_id;

    await cmd(env, "wd-t", "question.withdraw", { question_id: q3! });
    const sig = state_signature(env.db);
    await rejects_api(cmd(env, "mg-self", "question.merge", { question_id: q1!, merged_into_question_id: q1! }), "invalid_payload");
    await rejects_api(cmd(env, "mg-none", "question.merge", { question_id: q1!, merged_into_question_id: "no-such-question" }), "not_found");
    await rejects_api(cmd(env, "mg-foreign", "question.merge", { question_id: q1!, merged_into_question_id: foreign }), "not_found");
    await rejects_api(cmd(env, "mg-withdrawn", "question.merge", { question_id: q1!, merged_into_question_id: q3! }), "conflict");
    await rejects_api(cmd(env, "mg-missing", "question.merge", { question_id: q1! }), "invalid_payload");
    assert.equal(state_signature(env.db), sig, "거부된 요청은 행도 영수증도 사건도 남기지 않는다");
    assert.equal(current_row(env.db, q1!).state, "open");
    assert.equal(current_row(env.db, q2!).state, "open");
  });
});

test("합치기 대상이 나중에 철회되면 이미 합쳐진 질문의 기록은 그대로다 (대상 삭제 없음)", async () => {
  await with_api(async (env) => {
    const f = await two_question_form(env);
    const [q1, q2] = f.ids;
    await cmd(env, "mg-a", "question.merge", { question_id: q1!, merged_into_question_id: q2! });
    await cmd(env, "wd-b", "question.withdraw", { question_id: q2! });
    assert.equal(current_row(env.db, q1!).merged_into_question_id, q2);
    assert.equal(current_row(env.db, q2!).state, "withdrawn");
  });
});

// ---------------------------------------------------------------------------
// 잘못된 전이

test("전이표: withdrawn·merged 는 끝이고 deferred 는 withdrawn/merged 로만 간다 — 나머지는 conflict, 쓰지 않는다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("a"), single_spec("b"), single_spec("c"), single_spec("d")]);
    const [w, m, d, target] = f.ids;
    await cmd(env, "t-w", "question.withdraw", { question_id: w! });
    await cmd(env, "t-m", "question.merge", { question_id: m!, merged_into_question_id: target! });
    await cmd(env, "t-d", "question.defer", { question_id: d! });

    const sig = state_signature(env.db);
    for (const q of [w!, m!]) {
      await rejects_api(cmd(env, `x-w-${q}`, "question.withdraw", { question_id: q }), "conflict");
      await rejects_api(cmd(env, `x-d-${q}`, "question.defer", { question_id: q }), "conflict");
      await rejects_api(cmd(env, `x-m-${q}`, "question.merge", { question_id: q, merged_into_question_id: target! }), "conflict");
    }
    await rejects_api(cmd(env, "x-dd", "question.defer", { question_id: d! }), "conflict", "invalid_payload");
    assert.equal(state_signature(env.db), sig, "거부된 전이는 아무것도 남기지 않는다");

    await cmd(env, "ok-dw", "question.withdraw", { question_id: d! });
    assert.equal(current_row(env.db, d!).state, "withdrawn", "deferred -> withdrawn 은 된다");
  });
});

test("deferred -> merged 는 된다", async () => {
  await with_api(async (env) => {
    const f = await two_question_form(env);
    const [q1, q2] = f.ids;
    await cmd(env, "dm-1", "question.defer", { question_id: q1! });
    await cmd(env, "dm-2", "question.merge", { question_id: q1!, merged_into_question_id: q2! });
    assert.equal(current_row(env.db, q1!).state, "merged");
    assert.equal(versions_of(env.db, q1!).length, 3);
  });
});

test("없는 질문은 not_found, 닫힌 필드 밖의 값은 invalid_payload", async () => {
  await with_api(async (env) => {
    const f = await two_question_form(env);
    for (const name of ["question.withdraw", "question.defer"]) {
      await rejects_api(cmd(env, `nf-${name}`, name, { question_id: "no-such-question" }), "not_found");
      await rejects_api(cmd(env, `uf-${name}`, name, { question_id: f.ids[0]!, surprise: 1 }), "invalid_payload");
      await rejects_api(cmd(env, `mf-${name}`, name, {}), "invalid_payload");
    }
    assert.equal(current_row(env.db, f.ids[0]!).state, "open");
  });
});

test("base_version_id 가 낡았으면 rev_conflict 이고 아무것도 쓰지 않는다 (질문을 고친 뒤 옛 화면에서 철회)", async () => {
  await with_api(async (env) => {
    const f = await two_question_form(env);
    const q = f.ids[0]!;
    const v1 = current_row(env.db, q).version_id;
    await cmd(env, "rv-1", "question.revise", { question_id: q, text: "고친 질문", base_version_id: v1 });
    const sig = state_signature(env.db);
    await rejects_api(cmd(env, "wd-stale", "question.withdraw", { question_id: q, base_version_id: v1 }), "rev_conflict");
    assert.equal(state_signature(env.db), sig);
    const v2 = current_row(env.db, q).version_id;
    await cmd(env, "wd-fresh", "question.withdraw", { question_id: q, base_version_id: v2 });
    assert.equal(current_row(env.db, q).state, "withdrawn");
  });
});

// ---------------------------------------------------------------------------
// 권한·멱등

test("권한: 사람 소유자는 된다, 리스 없는 에이전트와 다른 프로젝트 사람은 안 된다 — 아무것도 쓰지 않는다", async () => {
  await with_api(async (env) => {
    const f = await two_question_form(env);
    const [q1, q2] = f.ids;
    const agent = add_agent(env, "agent-sel90");
    const other = await second_project(env, "synthetic-sel90-c");
    const other_ctx = (k: string) => ({ project_id: other.project_id, actor_id: other.actor_id, via: "cli" as const, client_request_id: k });
    const sig = state_signature(env.db);
    for (const [name, extra] of [
      ["question.withdraw", {}],
      ["question.defer", {}],
      ["question.merge", { merged_into_question_id: q2! }],
    ] as const) {
      await rejects_api(env.service.execute(agent_ctx(agent, `ag-${name}`), name, { question_id: q1!, ...extra }), "forbidden");
      await rejects_api(env.service.execute(other_ctx(`ot-${name}`), name, { question_id: q1!, ...extra }), "not_found", "forbidden");
    }
    assert.equal(state_signature(env.db), sig);
  });
});

test("멱등: 같은 키 + 같은 요청은 저장된 결과를 다시 주고 쓰지 않는다, 같은 키 + 다른 요청은 idempotency_key_reuse", async () => {
  await with_api(async (env) => {
    const f = await two_question_form(env);
    const [q1, q2] = f.ids;
    const first = await cmd(env, "idem-1", "question.withdraw", { question_id: q1! });
    const sig = state_signature(env.db);
    const n = receipts_count(env.db);
    const again = await cmd(env, "idem-1", "question.withdraw", { question_id: q1! });
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, first.result);
    assert.equal(receipts_count(env.db), n);
    assert.equal(state_signature(env.db), sig);
    await rejects_api(cmd(env, "idem-1", "question.defer", { question_id: q2! }), "idempotency_key_reuse");
    assert.equal(state_signature(env.db), sig);
  });
});

// ---------------------------------------------------------------------------
// API 라우트

const ROUTES = ["withdraw", "defer", "merge"] as const;

function route_body(kind: (typeof ROUTES)[number], target: string): Record<string, unknown> {
  return kind === "merge" ? { merged_into_question_id: target } : kind === "defer" ? { defer_until: 1_800_000_000_000 } : {};
}

for (const kind of ROUTES) {
  test(`POST P/questions/{q}/${kind}: 201, 문서 모양, 새 버전 하나, 옛 답 보존`, async () => {
    await with_api(async (env) => {
      const f = await two_question_form(env);
      const [q1, q2] = f.ids;
      await api_submit_ok(env, f.set.set_id, [A(q1!)]);
      const before = history_counts(env.db);
      const res = await owner_post(env, `/questions/${q1}/${kind}`, route_body(kind, q2!));
      const data = assert_ok(res, 201);
      assert.equal(res.json.replayed, false);
      assert.equal(data.question.id, q1);
      assert.equal(data.question.version_no, "2", "version_no 는 10진 문자열");
      assert.equal(typeof data.question.version_id, "string");
      assert.equal(data.question.state, kind === "withdraw" ? "withdrawn" : kind === "defer" ? "deferred" : "merged");
      if (kind === "merge") assert.equal(data.question.merged_into_question_id, q2);
      assert.equal(data.previous_answers_preserved, true);
      const after = history_counts(env.db);
      assert.equal(after.question_versions - before.question_versions, 1);
      assert.equal(after.answer_versions, before.answer_versions);
      assert.equal(after.mutation_commits - before.mutation_commits, 1);
      assert.equal(current_row(env.db, q1!).version_id, data.question.version_id);
      assert.equal(current_answer(env.db, q1!)?.value, "a");
    });
  });
}

test("API 철회: 같은 키는 재생, 같은 키 + 다른 본문은 409 idempotency_key_reuse, 잘못된 전이는 409 conflict", async () => {
  await with_api(async (env) => {
    const f = await two_question_form(env);
    const [q1, q2] = f.ids;
    const first = await owner_post(env, `/questions/${q1}/withdraw`, {}, "wd-key");
    assert_ok(first, 201);
    const sig = state_signature(env.db);
    const again = await owner_post(env, `/questions/${q1}/withdraw`, {}, "wd-key");
    assert.equal(again.json.replayed, true);
    assert.deepEqual(again.json.data, first.json.data);
    assert_final_error(await owner_post(env, `/questions/${q2}/withdraw`, { reason: "다른 본문" }, "wd-key"), 409, "idempotency_key_reuse", { next_action: NEXT_ACTION.idempotency_key_reuse });
    assert_final_error(await owner_post(env, `/questions/${q1}/defer`, {}), 409, "conflict", { next_action: NEXT_ACTION.conflict });
    assert_final_error(await owner_post(env, `/questions/${q1}/merge`, { merged_into_question_id: q2 }), 409, "conflict");
    assert.equal(state_signature(env.db), sig);
  });
});

test("API: 낡은 base_version_id 는 409 rev_conflict, 없는 질문은 404, 모르는 필드는 400, 키 없으면 400", async () => {
  await with_api(async (env) => {
    const f = await two_question_form(env);
    const [q1, q2] = f.ids;
    const v1 = current_row(env.db, q1!).version_id;
    assert_ok(
      await owner_post(env, `/questions/${q1}/revisions`, { base_version_id: v1, question: { text: "고친 질문" } }),
      201,
    );
    const sig = state_signature(env.db);
    const e = assert_final_error(await owner_post(env, `/questions/${q1}/withdraw`, { base_version_id: v1 }), 409, "rev_conflict");
    assert.equal(e.target, "$.body.base_version_id");
    assert_final_error(await owner_post(env, "/questions/no-such-question/withdraw", {}), 404, "not_found");
    assert_final_error(await owner_post(env, `/questions/${q2}/withdraw`, { surprise: 1 }), 400, "invalid_payload");
    assert_final_error(await owner_post(env, `/questions/${q2}/merge`, {}), 400, "invalid_payload");
    assert_final_error(await call(env, { method: "POST", path: P(env, `/questions/${q2}/withdraw`), auth: "owner", body: {}, key: null }), 400, "invalid_payload", { target: /idempotency-key/i });
    assert.equal(state_signature(env.db), sig);
  });
});

test("API merge 대상: 자기 자신·열려 있지 않은 질문은 거부(422/409), 다른 프로젝트 질문은 404", async () => {
  await with_api(async (env) => {
    const f = await two_question_form(env);
    const [q1, q2, q3] = f.ids;
    assert_ok(await owner_post(env, `/questions/${q3}/withdraw`, {}), 201);
    const sig = state_signature(env.db);
    const self = assert_final_error(await owner_post(env, `/questions/${q1}/merge`, { merged_into_question_id: q1 }), 422, "validation_failed", { target: "$.body.merged_into_question_id" });
    assert.equal(typeof self.details, "object");
    assert_final_error(await owner_post(env, `/questions/${q1}/merge`, { merged_into_question_id: q3 }), 409, "conflict");
    assert_final_error(await owner_post(env, `/questions/${q1}/merge`, { merged_into_question_id: "no-such-question" }), 404, "not_found");
    assert.equal(state_signature(env.db), sig);
    assert_ok(await owner_post(env, `/questions/${q1}/merge`, { merged_into_question_id: q2 }), 201);
  });
});

test("API 자격: 없으면 401, run:submit 없는 토큰·리스 없는 에이전트는 403 — 아무것도 쓰지 않는다", async () => {
  await with_api(async (env) => {
    const f = await two_question_form(env);
    const q1 = f.ids[0]!;
    const sig = state_signature(env.db);
    for (const kind of ROUTES) {
      const path = P(env, `/questions/${q1}/${kind}`);
      const body = route_body(kind, f.ids[1]!);
      assert_final_error(await call(env, { method: "POST", path, body }), 401, "unauthenticated", { next_action: NEXT_ACTION.unauthenticated });
      const reader = await make_agent(env, `reader-${kind}`, ["context:read"]);
      assert_final_error(await call(env, { method: "POST", path, auth: { token: reader.token }, body }), 403, "forbidden");
      const writer = await make_agent(env, `writer-${kind}`, ["run:submit"]);
      assert_final_error(await call(env, { method: "POST", path, auth: { token: writer.token }, body }), 403, "forbidden");
    }
    assert.equal(state_signature(env.db), sig);
  });
});

test("capabilities 는 새 라우트를 지원 목록에 올리고, 작업 공간 actions 에 새 동작이 나온다", async () => {
  await with_api(async (env) => {
    const caps = assert_ok(await call(env, { method: "GET", path: "/api/v1/capabilities", auth: "owner" }));
    for (const kind of ROUTES) {
      assert.ok(
        caps.routes.includes(`POST /api/v1/projects/{id}/questions/{q}/${kind}`),
        `routes 에 ${kind} 가 있다`,
      );
      assert.ok(!caps.unsupported.includes(`POST /api/v1/projects/{id}/questions/{q}/${kind}`));
    }
    await two_question_form(env);
    const ws = assert_ok(await call(env, { method: "GET", path: P(env, "/workspace"), auth: "owner" }));
    const names = ws.actions.map((a: any) => a.action);
    for (const op of ["questions.withdraw", "questions.defer", "questions.merge", "threads.create", "threads.messages.create"]) {
      assert.ok(names.includes(op), `workspace actions 에 ${op} 가 있다`);
    }
  });
});

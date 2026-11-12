/**
 * SEL-100 U3c — 1차 리뷰(R1) 수정 시험 (mid-worker). 고치기 전에는 아래 둘 다 실패해야 한다.
 *
 * 필수 1 — 새 판으로 복사된 결정의 proposed_by:
 *   복사본(copy_records_to_edition → insert_decision_object)의 version_no=1 은 edition.create 를 부른 행위자가 쓴다.
 *   그래서 "그 객체의 첫 버전을 쓴 행위자" 를 그대로 proposed_by 로 읽으면 AI 가 제안하고 사람이 채택한 판 범위 결정이
 *   2판에서는 "사람이 제안"으로 보인다. DB 근거: decisions.originated_from_version_id 가 부모 결정의 버전을 가리키므로
 *   (복사본이면) 그 버전의 객체를 따라가 첫 버전의 행위자를 읽는다. 부모가 또 복사본이면 사슬을 끝까지(3판 이상) 따라간다.
 *   복사본이 아닌 결정은 지금처럼 자기 첫 버전의 행위자다(test_sel100_reads 가 지킨다).
 *
 * 필수 3 — 반영 결과 버전 허용 kind 는 허용 목록:
 *   결과 버전(result_version_id)은 "의견을 처리한 결과가 될 수 있는 것" 만 된다 — 글(artifact) 버전, 판단된 가정(confirmed·rejected·revised),
 *   판단된 결정(adopted·superseded·revoked). 토큰도 한 번의 쓰기로 (버전, 그 버전을 만든 tx) 쌍을 만들 수 있는 message·thread·question·answer·source 같은
 *   나머지 kind 는 모두 거절한다(422 validation_failed, `$.body.entries[0].result_version_id`, reason evidence_mismatch, 아무것도 쓰지 않는다).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { assert_ok, call, make_agent, with_api, type ApiEnv, type Auth } from "./helpers/api_env.ts";
import { P, assert_final_error } from "./helpers/api_flow.ts";
import { artifact_version, count, reflection_rows, tx_of_version } from "./helpers/sel93_env.ts";
import { cmd, comment_messages, make_form, single_spec } from "./helpers/sel90_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const post = (env: ApiEnv, rest: string, auth: Auth, body: unknown) => call(env, { method: "POST", path: P(env, rest), auth, body });
const get = (env: ApiEnv, rest: string, auth: Auth = "owner") => call(env, { method: "GET", path: P(env, rest), auth });

function active_edition(env: ApiEnv): string {
  return env.db.get<{ id: string }>("SELECT active_edition_id AS id FROM projects WHERE id = ?", env.p.project_id)!.id;
}
function edition_no(env: ApiEnv, edition_id: string): number {
  return Number(env.db.get<{ n: bigint }>("SELECT edition_no AS n FROM editions WHERE id = ?", edition_id)!.n);
}

// ---------------------------------------------------------------------------
// 필수 1 — 복사된 결정의 제안자

test("a decision copied into a new edition keeps the ORIGINAL proposer (the agent), not whoever started the edition; a 3rd edition too", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "cp");
    const proposed = assert_ok(
      await post(env, "/decisions", { token: agent.token }, { scope: "edition", statement: "AI 가 제안한 판 결정", state: "proposed", supersedes: null, rationale: "합성" }),
      201,
    ).decision;
    assert_ok(await post(env, "/decisions", "owner", { scope: "edition", statement: "AI 가 제안한 판 결정", state: "adopted", supersedes: null, decision_id: proposed.id, base_version_id: proposed.version_id }), 201);

    const second = (await env.service.execute(env.ctx("cp-e2"), "edition.create", { parent_edition_id: active_edition(env) })).result as { edition_id: string };
    const second_rows = assert_ok(await get(env, `/decisions?edition=${edition_no(env, second.edition_id)}`)).decisions as any[];
    const copy2 = second_rows.find((r) => r.statement === "AI 가 제안한 판 결정");
    assert.ok(copy2 && copy2.id !== proposed.id, "the 2nd edition has its own copy");
    assert.equal(copy2.proposed_by.id, agent.actor_id, "proposed_by follows the parent version to the original proposer");
    assert.equal(copy2.proposed_by.kind, "ai");
    assert.equal(copy2.decided_by.id, env.p.actor_id, "decided_by stays the human who adopted it");

    // the copy of a copy: the chain is followed to the end
    const third = (await env.service.execute(env.ctx("cp-e3"), "edition.create", { parent_edition_id: second.edition_id })).result as { edition_id: string };
    const third_rows = assert_ok(await get(env, `/decisions?edition=${edition_no(env, third.edition_id)}`)).decisions as any[];
    const copy3 = third_rows.find((r) => r.statement === "AI 가 제안한 판 결정");
    assert.ok(copy3 && copy3.id !== copy2.id, "the 3rd edition has its own copy");
    assert.equal(copy3.proposed_by.id, agent.actor_id, "still the agent after two copies");
    assert.equal(copy3.proposed_by.kind, "ai");
  });
});

// ---------------------------------------------------------------------------
// 필수 3 — 결과 버전은 허용 목록

test("a message version (a one-step write anyone with a token can make) is not a reflection result, even with the commit that made it", async () => {
  await with_api(async (env) => {
    const form = await make_form(env, [single_spec("의견 질문")]);
    const source = await artifact_version(env, "rf-src");
    const q = form.ids[0]!;
    const out = await cmd(env, "rf-comment", "question.comment_add", { question_id: q, body_md: "이 질문은 범위가 모호합니다." });
    const message_version_id = (out.result as { message_version_id: string }).message_version_id;
    assert.equal(comment_messages(env.db, q).length, 1);
    const tx = tx_of_version(env.db, message_version_id);
    const sig = state_signature(env.db);
    const rows = count(env.db, "reflection_entries");
    for (const disposition of ["applied", "partial"]) {
      const err = assert_final_error(
        await post(env, "/reflections", "owner", {
          target_round_id: form.round_id,
          entries: [{ source_version_id: source.version_id, disposition, rationale: "반영했다.", result_version_id: message_version_id, evidence_tx_id: tx }],
        }),
        422,
        "validation_failed",
        { target: /^\$\.body\.entries\[0\]\.(result_version_id|evidence_tx_id)$/ },
      );
      assert.equal(err.details.reason, "evidence_mismatch");
    }
    assert.equal(state_signature(env.db), sig, "a refused reflection writes nothing");
    assert.equal(count(env.db, "reflection_entries"), rows);
    assert.equal(reflection_rows(env.db).length, 0);
  });
});

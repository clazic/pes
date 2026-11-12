/**
 * SEL-93 U3a — Opus 최종 리뷰 1/2 권장 2·7·8 의 새 동작 (mid-worker). 기존 시험의 단언은 바꾸지 않는다.
 *
 * 권장 2 (API): 채택·폐기 요청의 scope 는 결정의 실제 scope 와 같아야 한다(다르면 422 scope_mismatch, 아무것도 안 씀),
 *   토큰이 supersedes 를 보내면 대상 상태를 알려 주기 전에 바로 403 human_required, 대체 요청에
 *   decision_id 를 같이 보내면 400 invalid_payload. (채택·폐기의 statement 거절은 하지 않았다 — 기존 시험이 채택 때 다른 statement 를 보내 201 을 기대한다.)
 * 권장 7 (A): reflection.write 는 이 run 의 라운드로 고정. 다른 라운드를 target_round_id 로 주면 거절(오류 결과), 같은 값이면 통과. 아무것도 안 쓴다.
 * 권장 8 (코어): 이미 대체된 반영 항목을 다시 대체하면(다른 호출이든 같은 호출이든) 409 conflict, 아무것도 안 쓴다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { assert_ok, call, make_agent, with_api, type ApiEnv, type Auth } from "./helpers/api_env.ts";
import { P, assert_final_error } from "./helpers/api_flow.ts";
import {
  FINISH,
  close_stage,
  open_stage,
  ready_project,
  start_run,
  with_a_env,
  type AEnv,
  type ScriptedTurn,
} from "./helpers/a_builtin_env.ts";
import { with_env } from "./helpers/blob_env.ts";
import { open_round } from "./helpers/questions_env.ts";
import { artifact_version, decision_versions, ok, reflection_rows, refused } from "./helpers/sel93_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const post = (env: ApiEnv, rest: string, auth: Auth, body: unknown) => call(env, { method: "POST", path: P(env, rest), auth, body });

async function proposed(env: ApiEnv, scope: string, statement = "결정 문장"): Promise<any> {
  return assert_ok(await post(env, "/decisions", "owner", { scope, statement, state: "proposed", supersedes: null }), 201).decision;
}

async function adopted(env: ApiEnv, scope: string, statement = "채택한 결정"): Promise<any> {
  const d = await proposed(env, scope, statement);
  return assert_ok(await post(env, "/decisions", "owner", { scope, statement, state: "adopted", supersedes: null, decision_id: d.id, base_version_id: d.version_id }), 201).decision;
}

// ---------------------------------------------------------------------------
// 권장 2

test("adopt / revoke with a scope that is not the decision's own scope: 422 scope_mismatch at $.body.scope, nothing written", async () => {
  await with_api(async (env) => {
    const d = await proposed(env, "project");
    const sig = state_signature(env.db);
    const err = assert_final_error(
      await post(env, "/decisions", "owner", { scope: "edition", statement: "결정 문장", state: "adopted", supersedes: null, decision_id: d.id, base_version_id: d.version_id }),
      422,
      "validation_failed",
      { target: "$.body.scope" },
    );
    assert.equal(err.details.reason, "scope_mismatch");
    assert.equal(state_signature(env.db), sig, "a refused adoption leaves no row");
    const a = await adopted(env, "project");
    const sig2 = state_signature(env.db);
    const err2 = assert_final_error(
      await post(env, "/decisions", "owner", { scope: "edition", statement: "x", state: "revoked", supersedes: null, decision_id: a.id, base_version_id: a.version_id, rationale: "폐기" }),
      422,
      "validation_failed",
      { target: "$.body.scope" },
    );
    assert.equal(err2.details.reason, "scope_mismatch");
    assert.equal(state_signature(env.db), sig2);
    // the matching scope still works
    assert_ok(await post(env, "/decisions", "owner", { scope: "project", statement: "x", state: "revoked", supersedes: null, decision_id: a.id, base_version_id: a.version_id, rationale: "폐기" }), 201);
  });
});

test("a token naming `supersedes` is 403 human_required right away: no target state, no current decision id leaks, even for state 'proposed'", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "supersede-probe");
    const t: Auth = { token: agent.token };
    const old = await adopted(env, "edition", "1판 결정");
    const replacement = await post(env, "/decisions", "owner", { scope: "edition", statement: "2판 결정", state: "adopted", supersedes: old.id, base_version_id: old.version_id, rationale: "바꾼다" });
    assert_ok(replacement, 201); // `old` is now superseded: a probe would learn its state and the id of the decision that replaced it
    const never = await proposed(env, "edition", "아직 제안");
    const sig = state_signature(env.db);
    for (const target of [old.id, never.id, "no-such-decision"]) {
      for (const state of ["proposed", "adopted"]) {
        const res = await post(env, "/decisions", t, { scope: "edition", statement: "탐색", state, supersedes: target, base_version_id: old.version_id, rationale: "탐색" });
        const error = assert_final_error(res, 403, "human_required");
        assert.equal(error.details?.target_state, undefined, "the answer does not reveal the target's state");
        assert.equal(error.details?.current_decision_id, undefined, "the answer does not reveal the replacing decision");
      }
    }
    assert.equal(state_signature(env.db), sig);
  });
});

test("a supersede request that also carries decision_id is 400 invalid_payload (the field has no meaning there), nothing written", async () => {
  await with_api(async (env) => {
    const a = await adopted(env, "edition", "1판 결정");
    const sig = state_signature(env.db);
    assert_final_error(
      await post(env, "/decisions", "owner", { scope: "edition", statement: "2판 결정", state: "adopted", supersedes: a.id, decision_id: a.id, base_version_id: a.version_id, rationale: "바꾼다" }),
      400,
      "invalid_payload",
    );
    assert.equal(state_signature(env.db), sig);
    assert_ok(await post(env, "/decisions", "owner", { scope: "edition", statement: "2판 결정", state: "adopted", supersedes: a.id, base_version_id: a.version_id, rationale: "바꾼다" }), 201);
  });
});

// ---------------------------------------------------------------------------
// 권장 7

function script_fn(env: AEnv, fn: (n: number) => ScriptedTurn): void {
  const base = env.fake.calls.length;
  env.fake.script = (n: number) => fn(n - base);
}

test("A reflection.write is pinned to the run's own round: another round's id is refused (nothing written), the run's own id passes", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const first = await open_stage(env, "plan");
    await close_stage(env, first, "plan");
    const o = await open_stage(env, "research");
    assert.notEqual(first.round_id, o.round_id);
    const entry = (rationale: string) => ({ source_version_id: o.base_version_id, disposition: "deferred", rationale });
    script_fn(env, (n) =>
      n === 1
        ? {
            tools: [
              { name: "reflection.write", args: { target_round_id: first.round_id, entries: [entry("다른 라운드에 쓰려는 시도")] } },
              { name: "reflection.write", args: { target_round_id: o.round_id, entries: [entry("자기 라운드를 그대로 적음")] } },
              { name: "reflection.write", args: { entries: [entry("인자 없이")] } },
            ],
          }
        : FINISH,
    );
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "succeeded", JSON.stringify(res));
    assert.equal(reflection_rows(env.db, first.round_id).length, 0, "nothing landed in the other round");
    assert.deepEqual(
      reflection_rows(env.db, o.round_id).map((r) => r.rationale),
      ["자기 라운드를 그대로 적음", "인자 없이"],
    );
    assert.match(JSON.stringify(env.fake.calls[1]!.json), /\\"ok\\":false/, "the model was told the first call failed");
  });
});

// ---------------------------------------------------------------------------
// 권장 8

test("reflection: a second entry superseding an entry that is already superseded is 409 conflict, in another call or inside one call; nothing written", async () => {
  await with_env(async (env) => {
    const { round_id } = await open_round(env, "dup");
    const source = await artifact_version(env, "dup-src");
    const entry = (rationale: string, extra: Record<string, unknown> = {}) => ({ source_version_id: source.version_id, disposition: "deferred", rationale, ...extra });
    const first = await ok(env, env.ctx("dup-1"), "reflection.create", { target_round_id: round_id, entries: [entry("처음")] });
    const old_entry = first.entries[0].entry_id as string;
    const second = await ok(env, env.ctx("dup-2"), "reflection.create", { target_round_id: round_id, entries: [entry("다시", { supersedes_entry_id: old_entry })] });
    assert.ok(second.entries[0].entry_id);

    const sig = state_signature(env.db);
    await refused(env, env.ctx("dup-3"), "reflection.create", { target_round_id: round_id, entries: [entry("또 대체", { supersedes_entry_id: old_entry })] }, "conflict");
    assert.equal(state_signature(env.db), sig, "the second replacement of the same entry wrote nothing");

    // inside one call: two new entries naming the same still-live entry
    const live = second.entries[0].entry_id as string;
    await refused(
      env,
      env.ctx("dup-4"),
      "reflection.create",
      { target_round_id: round_id, entries: [entry("가", { supersedes_entry_id: live }), entry("나", { supersedes_entry_id: live })] },
      "conflict",
    );
    assert.equal(state_signature(env.db), sig, "a duplicated target inside one call wrote nothing (not even the first of the two)");

    // control: replacing the live entry once is fine
    await ok(env, env.ctx("dup-5"), "reflection.create", { target_round_id: round_id, entries: [entry("한 번만", { supersedes_entry_id: live })] });
    assert.equal(reflection_rows(env.db, round_id).length, 3);
  });
});

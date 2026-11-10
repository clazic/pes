/**
 * SEL-47 r1 회귀 (tester, 회귀 모드): R4, S2, S4, S5, S7, S9. (R1·S1·S10 은 test_api_default_secret.test.ts 와
 * tests/test_serve_api_r1_regression.py, R2 는 test_api_fixture_contract.test.ts.)
 *
 *   R4  받아 놓고 버리는 필드 = 가짜 성공. POST P/questions 의 direction, POST P/stages/{s}/rounds 의 purpose·
 *       question_set_id: 201 이면 저장된 값을 다시 읽어 같아야 하고, 코어가 저장하지 않는 값이면 400 이어야 한다
 *       (아무것도 쓰지 않음). 코어가 항상 저장하는 값(direction "agent_to_human")은 그대로 201.
 *   S2  is_human_owner_actor 는 DB 오류를 "owner 아님"으로 바꾸지 않는다 (forbidden 만 false).
 *   S4  register 재생 응답은 data.token_issued_before === true 이고 토큰 원문이 없다.
 *   S5  / % 공백이 든 Idempotency-Key 도 GET P/requests/{key}(퍼센트 인코딩)로 조회된다.
 *   S7  PR13 라우트도 본문에 format_version "1.0" 을 선택으로 받고 다른 값은 400 ($.body.format_version).
 *   S9  다른 질문의 question_version_id 를 핀한 답은 409(conflict 또는 question_version_changed)이고 아무것도 쓰지 않는다.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { is_human_owner_actor, type CommandRuntime } from "../scripts/pes_core/commands/shared.ts";
import type { Db } from "../scripts/pes_core/db.ts";
import { agent_claims, assert_ok, call, make_agent, with_api, type ApiEnv } from "./helpers/api_env.ts";
import { P, assert_final_error } from "./helpers/api_flow.ts";
import { open_round, single_spec } from "./helpers/questions_env.ts";
import { stage_ids } from "./helpers/editions_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

// ---------------------------------------------------------------------------
// R4

async function question_body(env: ApiEnv, extra: Record<string, unknown> = {}) {
  const { stage_id, round_id } = await open_round(env, `r4-${env.seq++}`);
  return { stage_id, round_id, purpose: "stage_start", question: single_spec("합성 질문"), ...extra };
}

test("R4 POST P/questions direction: stored and read back, or refused with 400 — never accepted and dropped", async () => {
  await with_api(async (env) => {
    const body = await question_body(env, { direction: "human_to_agent" });
    const before = state_signature(env.db);
    const res = await call(env, { method: "POST", path: P(env, "/questions"), auth: "owner", body });
    if (res.status === 201) {
      const id = res.json.data.question.id as string;
      const row = env.db.get<{ direction: string; intended_actor_id: string | null }>(
        "SELECT direction, intended_actor_id FROM questions WHERE object_id = ?",
        id,
      );
      assert.equal(row?.direction, "human_to_agent", "201 means the direction was stored");
    } else {
      assert_final_error(res, 400, "invalid_payload", { target: "$.body.direction" });
      assert.equal(state_signature(env.db), before, "a refusal writes nothing");
    }
  });
});

test("R4 POST P/questions direction agent_to_human is what the core always stores, so it is accepted and read back", async () => {
  await with_api(async (env) => {
    const body = await question_body(env, { direction: "agent_to_human" });
    const data = assert_ok(await call(env, { method: "POST", path: P(env, "/questions"), auth: "owner", body }), 201);
    const row = env.db.get<{ direction: string }>("SELECT direction FROM questions WHERE object_id = ?", data.question.id);
    assert.equal(row?.direction, "agent_to_human");
    assert.equal(data.question.intended_actor_id, null);
    const stored = env.db.get<{ intended_actor_id: string | null }>("SELECT intended_actor_id FROM questions WHERE object_id = ?", data.question.id);
    assert.equal(stored?.intended_actor_id, data.question.intended_actor_id, "the response says what is stored");
  });
});

function rounds_columns(env: ApiEnv): string[] {
  return env.db.all<{ name: string }>("PRAGMA table_info(rounds)").map((c) => c.name);
}

for (const [field, value] of [
  ["purpose", "review"],
  ["question_set_id", "synthetic-question-set"],
] as const) {
  test(`R4 POST P/stages/{s}/rounds ${field}: stored on the round and read back, or refused with 400`, async () => {
    await with_api(async (env) => {
      const s = stage_ids(env.db, env.p.edition_id);
      const before = state_signature(env.db);
      const res = await call(env, { method: "POST", path: P(env, `/stages/${s.plan}/rounds`), auth: "owner", body: { [field]: value } });
      if (res.status === 201) {
        assert.ok(rounds_columns(env).includes(field), `201 but the rounds table has no ${field} column: the value was dropped`);
        const id = res.json.data.round.id as string;
        const row = env.db.get<Record<string, unknown>>(`SELECT ${field} AS v FROM rounds WHERE id = ?`, id);
        assert.equal(row?.v, value);
      } else {
        assert_final_error(res, 400, "invalid_payload", { target: `$.body.${field}` });
        assert.equal(state_signature(env.db), before, "a refusal writes nothing");
      }
    });
  });
}

// ---------------------------------------------------------------------------
// S2

test("S2 is_human_owner_actor: true for the owner, false for an agent, and a database error is thrown, not turned into false", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "s2");
    const runtime = (db: Db, actor_id: string | null): CommandRuntime =>
      ({ db, project: { id: env.p.project_id }, actor_id }) as unknown as CommandRuntime;
    assert.equal(is_human_owner_actor(runtime(env.db, env.p.actor_id)), true);
    assert.equal(is_human_owner_actor(runtime(env.db, agent.actor_id)), false);
    assert.equal(is_human_owner_actor(runtime(env.db, null)), false, "no actor: not an owner");
    assert.equal(is_human_owner_actor({ ...runtime(env.db, env.p.actor_id), project: null } as CommandRuntime), false);

    const broken: Db = {
      path: env.db.path,
      exec: (sql) => env.db.exec(sql),
      prepare: (sql) => env.db.prepare(sql),
      run: (sql, ...params) => env.db.run(sql, ...params),
      get: () => {
        throw new Error("synthetic disk I/O error");
      },
      all: () => {
        throw new Error("synthetic disk I/O error");
      },
      close: () => undefined,
    };
    assert.throws(() => is_human_owner_actor(runtime(broken, env.p.actor_id)), /synthetic disk I\/O error/);
  });
});

// ---------------------------------------------------------------------------
// S4

test("S4 a register replay says token_issued_before:true and carries no token text anywhere", async () => {
  await with_api(async (env) => {
    const body = { slug: "synthetic-s4", topic: "합성", owner_display_name: "합성 소유자", device_label: "합성 기기" };
    const first = await call(env, { method: "POST", path: "/api/v1/project-registrations", auth: "owner", body, key: "s4-key" });
    const issued = assert_ok(first, 201);
    assert.equal(typeof issued.token, "string");
    assert.ok(issued.token_issued_before === undefined || issued.token_issued_before === false);
    const replay = await call(env, { method: "POST", path: "/api/v1/project-registrations", auth: "owner", body, key: "s4-key" });
    const again = assert_ok(replay, 201);
    assert.equal(replay.json.replayed, true);
    assert.equal(again.token_issued_before, true, "the client learns the token was already handed out");
    assert.equal(again.token, undefined);
    assert.ok(!JSON.stringify(replay.json).includes(issued.token), "the raw token is nowhere in the replay");
    assert.equal(again.project_id, issued.project_id);
  });
});

// ---------------------------------------------------------------------------
// S5

for (const key of ["key with spaces", "a/b", "100%25-and-%", "mix /% é"]) {
  test(`S5 GET P/requests/{key} finds an Idempotency-Key with special characters: ${JSON.stringify(key)}`, async () => {
    await with_api(async (env) => {
      const agent = await make_agent(env, "s5");
      const created = await call(env, {
        method: "POST",
        path: P(env, "/runs"),
        auth: "owner",
        key,
        body: { actor_id: agent.actor_id, mode: "B", runtime: "r", provider: "p", model: "m" },
      });
      assert.equal(created.status, 201, JSON.stringify(created.json));
      const found = await call(env, { method: "GET", path: P(env, `/requests/${encodeURIComponent(key)}`), auth: "owner" });
      const data = assert_ok(found);
      assert.equal(data.action, "run.create");
      assert.equal(data.status, 201);
    });
  });
}

// ---------------------------------------------------------------------------
// S7

test("S7 PR13 routes accept format_version \"1.0\" like the PR14 routes, and refuse any other value", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "s7");
    const lease = await agent_claims(env, agent);
    const guard = { lease_id: lease.lease_id, fence: lease.fence };
    const cases: Array<{ name: string; path: string; auth: "owner" | { token: string }; body: Record<string, unknown> }> = [
      { name: "claims", path: P(env, "/claims"), auth: { token: agent.token }, body: { mode: "B", runtime: "r", provider: "p", model: "m" } },
      { name: "runs", path: P(env, "/runs"), auth: "owner", body: { actor_id: agent.actor_id, mode: "B", runtime: "r", provider: "p", model: "m" } },
      { name: "uploads", path: P(env, "/uploads"), auth: "owner", body: { original_name: "a.txt", media_type: "text/plain", size: 1, sha256: "0".repeat(64) } },
      { name: "projects", path: "/api/v1/projects", auth: "owner", body: { slug: "synthetic-s7", topic: "합성", owner_display_name: "합성" } },
      { name: "wait", path: P(env, `/runs/${lease.run_id}/wait`), auth: { token: agent.token }, body: { ...guard, reason: "waiting_human" } },
      { name: "results", path: P(env, `/runs/${lease.run_id}/results`), auth: { token: agent.token }, body: { ...guard, expected_control_rev: "0", results: [] } },
      { name: "complete", path: P(env, `/runs/${lease.run_id}/complete`), auth: { token: agent.token }, body: { ...guard, status: "succeeded" } },
    ];
    for (const c of cases) {
      const ok = await call(env, { method: "POST", path: c.path, auth: c.auth, body: { ...c.body, format_version: "1.0" } });
      assert.ok(
        !(ok.status === 400 && ok.json?.error?.target === "$.body.format_version"),
        `${c.name}: format_version "1.0" must be accepted, got ${ok.status} ${JSON.stringify(ok.json)}`,
      );
      assert.ok(
        !(ok.json?.error?.code === "invalid_payload" && /format_version/.test(JSON.stringify(ok.json.error))),
        `${c.name}: format_version is not an unknown field`,
      );
      const bad = await call(env, { method: "POST", path: c.path, auth: c.auth, body: { ...c.body, format_version: "2.0" } });
      assert_final_error(bad, 400, "invalid_payload", { target: "$.body.format_version" });
    }
  });
});

// ---------------------------------------------------------------------------
// S9

test("S9 an answer that pins another question's version id is a 409 refusal and writes nothing", async () => {
  await with_api(async (env) => {
    const { stage_id, round_id } = await open_round(env, "s9");
    const publish = async (form_key: string, text: string) => {
      const res = await call(env, {
        method: "POST",
        path: P(env, "/questions"),
        auth: "owner",
        body: { stage_id, round_id, purpose: "stage_start", form_key, question: single_spec(text) },
      });
      const data = assert_ok(res, 201);
      return { set_id: data.question_set_id as string, question_id: data.question.id as string, version_id: data.question.version_id as string };
    };
    const a = await publish("form-a", "합성 질문 A");
    const b = await publish("form-b", "합성 질문 B");
    const before = state_signature(env.db);
    const res = await call(env, {
      method: "POST",
      path: P(env, "/submissions"),
      auth: "owner",
      body: { set_id: a.set_id, answers: [{ question_id: a.question_id, question_version_id: b.version_id, value: "a" }] },
    });
    // The review wrote "conflict"; the implementation answers 409 question_version_changed (the documented
    // name for a pinned version that is not the question's). Either is a 409 refusal; a 2xx would be the bug.
    assert.equal(res.status, 409, JSON.stringify(res.json));
    assert.ok(["conflict", "question_version_changed"].includes(res.json.error.code), res.json.error.code);
    assert.equal(state_signature(env.db), before, "a refused answer writes nothing");
    // control: the right version id is accepted
    assert_ok(
      await call(env, {
        method: "POST",
        path: P(env, "/submissions"),
        auth: "owner",
        body: { set_id: a.set_id, answers: [{ question_id: a.question_id, question_version_id: a.version_id, value: "a" }] },
      }),
      201,
    );
  });
});

/**
 * SEL-47 PR14 — Codex 최종 리뷰 1/2 회귀 시험 (tester, 회귀 모드). 리뷰 전문: logs/SEL-47-final-review-1.md
 * 결정: ledger 'SEL-47 Codex 최종 1/2'. S2·S3 는 tests/test_serve_api_sel47_final1.py (ApiBudget, 합성 시계).
 *
 *   F1  GET P/runs/{r}/inputs?wait_ms= 가 주입 sleep 중에 (a) Go OFF (b) 토큰 회수 (c) 멤버십 제거가
 *       커밋되면, 대기가 끝난 뒤의 응답은 새 요청과 같다: 403 policy_blocked / 401 unauthenticated / 403,
 *       그리고 그 응답에도 입력(입력 버전 id)이 없다. (d) external_agent 에 등록된 mode A run 도
 *       Go OFF 면 대기 없이 403 policy_blocked (읽기 경계는 호출자 종류가 아니라 run 의 목적지로 판단).
 *   F2  사람이 답(value·comment)을 제출하면 inputs 항목에 `object_id`(답 object id)가 있고
 *       GET P/objects/{object_id}/versions/{input_version_id} 가 kind "answer" 와
 *         content = { question_version_id, value, state, comment }   (DTO 이름: `content`)
 *       를 돌려준다. 질문 버전은 kind "question" 과
 *         content = { text, type, options, required, default_value, ... }
 *       권한·소속·Go 규칙은 다른 버전 읽기와 같다 (context:read 없으면 403, 무자격 401, 다른 프로젝트 404,
 *       Go OFF 에서 internal_ai 는 403 policy_blocked, 거부 응답에 본문 없음).
 *   F3  다른 명령에 쓴 Idempotency-Key 를 handoffs·interrupt 에 재사용하면 409 idempotency_key_reuse
 *       (500 이 아니다), 아무것도 쓰지 않는다.
 *   S1  handoffs 의 target_actor_id·target_mode 가 현재 run 의 actor·mode 와 다르면 400 invalid_payload
 *       (target 은 해당 필드, 쓰기 0). 같거나 생략이면 기존 동작(200, 같은 run 반납).
 *
 * 합성 값만 쓴다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { revoke_agent_token } from "../scripts/pes_core/actors.ts";
import {
  assert_error,
  assert_ok,
  call,
  go_off,
  make_agent,
  with_api,
  type Agent,
  type ApiEnv,
  type ApiResponse,
  type Lease,
} from "./helpers/api_env.ts";
import { second_project } from "./helpers/blob_env.ts";
import { P, assert_final_error, until_gate } from "./helpers/api_flow.ts";
import { OPTIONS, open_round, single_spec } from "./helpers/questions_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const MODE_A = { mode: "A", runtime: "synthetic-runtime", provider: "opencode-go", model: "opencode-go/synthetic" } as const;

async function min_poll_gap(env: ApiEnv): Promise<number> {
  const caps = assert_ok(await call(env, { method: "GET", path: "/api/v1/capabilities" }));
  return caps.limits.min_poll_interval_ms as number;
}

/** The owner registers a queued run for the agent; the agent claims it. */
async function run_for(env: ApiEnv, agent: Agent, mode: "A" | "B"): Promise<Lease> {
  const body =
    mode === "A"
      ? { actor_id: agent.actor_id, ...MODE_A }
      : { actor_id: agent.actor_id, mode: "B", runtime: "synthetic-runtime", provider: "synthetic", model: "synthetic-model" };
  const created = assert_ok(await call(env, { method: "POST", path: P(env, "/runs"), auth: "owner", body }), 201);
  const claimed = assert_ok(await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: agent.token }, body: { run_id: created.run_id } }));
  return { run_id: claimed.run_id, lease_id: claimed.lease_id, fence: claimed.fence };
}

interface Asked {
  set_id: string;
  question_id: string;
  question_version_id: string;
}

async function agent_asks(env: ApiEnv, agent: Agent, lease: Lease, spec = single_spec("에이전트의 합성 질문")): Promise<Asked> {
  const { stage_id, round_id } = await open_round(env, `f-ask${env.seq++}`);
  const res = await call(env, {
    method: "POST",
    path: P(env, "/questions"),
    auth: { token: agent.token },
    body: { stage_id, round_id, purpose: "review", form_key: "ask", question: spec, run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence },
  });
  const data = assert_ok(res, 201);
  return { set_id: data.question_set_id, question_id: data.question.id, question_version_id: data.question.version_id };
}

async function owner_submits(env: ApiEnv, q: Asked, value = "a", comment?: string): Promise<string> {
  const answer: Record<string, unknown> = { question_id: q.question_id, question_version_id: q.question_version_id, value };
  if (comment !== undefined) answer.comment = comment;
  const res = await call(env, { method: "POST", path: P(env, "/submissions"), auth: "owner", body: { set_id: q.set_id, answers: [answer] } });
  return assert_ok(res, 201).answers[0].answer_version_id as string;
}

function no_input(res: ApiResponse, input_version_id: string): void {
  const text = JSON.stringify(res.json);
  assert.ok(!text.includes(input_version_id), "the refused response carries no input");
  assert.equal(res.json.data, undefined);
}

// ---------------------------------------------------------------------------
// F1 — long-poll re-checks the caller at the read

type Mutate = (env: ApiEnv, agent: Agent) => Promise<void>;

async function parked_poll(env: ApiEnv, name: string, mutate: Mutate) {
  const agent = await make_agent(env, name, undefined, "internal_ai");
  const lease = await run_for(env, agent, "A");
  const gap = await min_poll_gap(env);
  const q = await agent_asks(env, agent, lease);
  const path = P(env, `/runs/${lease.run_id}/inputs`);
  const start = assert_ok(await call(env, { method: "GET", path, auth: { token: agent.token } }));
  assert.deepEqual(start.inputs, []);
  env.clock.advance(gap);

  env.hold_sleep = true;
  const pending = call(env, { method: "GET", path: `${path}?cursor=${encodeURIComponent(start.next_cursor)}&wait_ms=25000`, auth: { token: agent.token } });
  await until_gate(env);
  env.hold_sleep = false;
  // The human answers while the request waits, THEN the caller's right to read is taken away.
  const answered = await owner_submits(env, q, "a", "합성 대기 중 의견");
  await mutate(env, agent);
  env.gates[0]!.release();
  const res = await pending;
  // A new request now gets the same refusal.
  env.clock.advance(gap);
  const fresh = await call(env, { method: "GET", path, auth: { token: agent.token } });
  return { res, fresh, answered, agent, lease };
}

test("F1 (a) Go OFF committed during the wait: the waiting inputs request ends 403 policy_blocked with no input", async () => {
  await with_api(async (env) => {
    const { res, fresh, answered } = await parked_poll(env, "f1a", (e) => go_off(e));
    assert_error(fresh, 403, "policy_blocked");
    assert.equal(assert_error(res, 403, "policy_blocked").retryable, false);
    no_input(res, answered);
  });
});

test("F1 (b) token revoked during the wait: the waiting inputs request ends 401 unauthenticated with no input", async () => {
  await with_api(async (env) => {
    const { res, fresh, answered } = await parked_poll(env, "f1b", async (e, agent) => {
      await revoke_agent_token(e.service, e.ctx("f1b-revoke"), { token_id: agent.token_id });
    });
    assert_error(fresh, 401, "unauthenticated");
    assert_error(res, 401, "unauthenticated");
    no_input(res, answered);
  });
});

test("F1 (c) membership removed during the wait: the waiting inputs request ends 403 with no input", async () => {
  await with_api(async (env) => {
    const { res, fresh, answered } = await parked_poll(env, "f1c", async (e) => {
      // The membership row is referenced by other rows; a committed removal is simulated with the checks off.
      e.db.exec("PRAGMA foreign_keys = OFF");
      try {
        e.db.run("DELETE FROM project_members WHERE project_id = ? AND user_id = (SELECT owner_user_id FROM projects WHERE id = ?)", e.p.project_id, e.p.project_id);
      } finally {
        e.db.exec("PRAGMA foreign_keys = ON");
      }
    });
    assert.equal(fresh.status, 403, `a new request is refused: ${JSON.stringify(fresh.json)}`);
    assert.equal(res.status, 403, `the waiting request is refused too: ${JSON.stringify(res.json)}`);
    assert.equal(typeof res.json.error?.code, "string");
    no_input(res, answered);
  });
});

test("F1 (d) an external_agent holding a mode A run is blocked by Go OFF at once — no wait, no input", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "f1d"); // external_agent
    const lease = await run_for(env, agent, "A");
    const q = await agent_asks(env, agent, lease);
    const answered = await owner_submits(env, q);
    const path = P(env, `/runs/${lease.run_id}/inputs`);
    await go_off(env);
    env.hold_sleep = true;
    const res = await call(env, { method: "GET", path: `${path}?wait_ms=25000`, auth: { token: agent.token } });
    assert.equal(assert_error(res, 403, "policy_blocked").retryable, false);
    no_input(res, answered);
    assert.equal(env.gates.length, 0, "a refused read never sleeps");
    // A mode B run of another external agent is not a Go run and still reads its inputs.
    const other = await make_agent(env, "f1d-b");
    const b = await run_for(env, other, "B");
    const ok = assert_ok(await call(env, { method: "GET", path: P(env, `/runs/${b.run_id}/inputs`), auth: { token: other.token } }));
    assert.ok(Array.isArray(ok.inputs));
  });
});

// ---------------------------------------------------------------------------
// F2 — the answer / question content can be read

test("F2 the human's answer reaches the agent: inputs names the answer object, the exact version returns value, comment, state and the pinned question version", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "f2");
    const lease = await run_for(env, agent, "B");
    const q = await agent_asks(env, agent, lease);
    const comment = "합성 의견 f2-comment-marker";
    const answered = await owner_submits(env, q, "a", comment);

    const inputs = assert_ok(await call(env, { method: "GET", path: P(env, `/runs/${lease.run_id}/inputs`), auth: { token: agent.token } }));
    assert.equal(inputs.inputs.length, 1);
    const item = inputs.inputs[0];
    assert.equal(item.input_version_id, answered);
    assert.equal(item.kind, "answer");
    assert.equal(typeof item.object_id, "string", "the item names the answer object to read");
    assert.ok(item.object_id.length > 0);

    const data = assert_ok(await call(env, { method: "GET", path: P(env, `/objects/${item.object_id}/versions/${item.input_version_id}`), auth: { token: agent.token } }));
    assert.equal(data.kind, "answer");
    assert.equal(data.version_id, answered);
    assert.equal(data.object_id, item.object_id);
    assert.ok(data.content && typeof data.content === "object", "data.content exists");
    assert.equal(data.content.question_version_id, q.question_version_id);
    assert.equal(data.content.value, "a");
    // content.state is the ANSWER VERSION state; item.state is the run's receipt state ('new') — different things.
    assert.equal(data.content.state, "submitted");
    assert.equal(data.content.comment, comment);
    // The owner reads the same thing.
    const owner = assert_ok(await call(env, { method: "GET", path: P(env, `/objects/${item.object_id}/versions/${item.input_version_id}`), auth: "owner" }));
    assert.deepEqual(owner.content, data.content);

    // The question it answers: the exact question version carries the text, type and options.
    const qv = assert_ok(await call(env, { method: "GET", path: P(env, `/objects/${q.question_id}/versions/${q.question_version_id}`), auth: { token: agent.token } }));
    assert.equal(qv.kind, "question");
    assert.ok(qv.content && typeof qv.content === "object", "question content exists");
    assert.equal(qv.content.text, "에이전트의 합성 질문");
    assert.equal(qv.content.type, "single");
    assert.equal(qv.content.required, true);
    assert.equal(qv.content.default_value, "b");
    assert.deepEqual(
      (qv.content.options as Array<{ value: string; label: string }>).map((o) => [o.value, o.label]),
      OPTIONS.map((o) => [o.value, o.label]),
    );
  });
});

test("F2 an answer without a comment has comment null, and a text answer returns its value", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "f2b");
    const lease = await run_for(env, agent, "B");
    const q = await agent_asks(env, agent, lease, { text: "합성 서술 질문", type: "text", required: false, allow_comment_as_answer: false });
    await owner_submits(env, q, "합성 서술 답 f2b-value");
    const item = assert_ok(await call(env, { method: "GET", path: P(env, `/runs/${lease.run_id}/inputs`), auth: { token: agent.token } })).inputs[0];
    assert.equal(typeof item.object_id, "string", "the item names the answer object to read");
    const data = assert_ok(await call(env, { method: "GET", path: P(env, `/objects/${item.object_id}/versions/${item.input_version_id}`), auth: { token: agent.token } }));
    assert.equal(data.content.value, "합성 서술 답 f2b-value");
    assert.equal(data.content.comment, null);
    assert.equal(data.content.question_version_id, q.question_version_id);
  });
});

test("F2 the answer and question content follow the other version reads: no context:read 403, no credential 401, other project 404, Go OFF blocks internal_ai", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "f2c");
    const lease = await run_for(env, agent, "B");
    const q = await agent_asks(env, agent, lease);
    const marker = "합성 의견 f2c-secret-marker";
    await owner_submits(env, q, "a", marker);
    const item = assert_ok(await call(env, { method: "GET", path: P(env, `/runs/${lease.run_id}/inputs`), auth: { token: agent.token } })).inputs[0];
    assert.equal(typeof item.object_id, "string", "the item names the answer object to read");
    const answer_path = P(env, `/objects/${item.object_id}/versions/${item.input_version_id}`);
    const question_path = P(env, `/objects/${q.question_id}/versions/${q.question_version_id}`);
    const leak = (res: ApiResponse) => assert.ok(!JSON.stringify(res.json).includes("f2c-secret-marker"), "no answer text in a refusal");

    const files_only = await make_agent(env, "f2c-files", ["file:read", "file:write"]);
    for (const path of [answer_path, question_path]) {
      const denied = await call(env, { method: "GET", path, auth: { token: files_only.token } });
      assert_error(denied, 403, "forbidden");
      leak(denied);
      const anon = await call(env, { method: "GET", path });
      assert_error(anon, 401, "unauthenticated");
      leak(anon);
    }

    // another project's path never reads this project's answer
    const other = await second_project(env, "synthetic-f2-other");
    const via_other = await call(env, {
      method: "GET",
      path: `/api/v1/projects/${other.project_id}/objects/${item.object_id}/versions/${item.input_version_id}`,
      auth: "owner",
    });
    assert.ok(via_other.status === 404 || via_other.status === 403, `got ${via_other.status}`);
    leak(via_other);
    // a made-up version id under the real object is 404
    assert_error(await call(env, { method: "GET", path: P(env, `/objects/${item.object_id}/versions/no-such-version`), auth: { token: agent.token } }), 404, "not_found");

    // Go OFF: an internal_ai caller is blocked, the owner still reads
    const internal = await make_agent(env, "f2c-internal", ["context:read"], "internal_ai");
    await go_off(env);
    for (const path of [answer_path, question_path]) {
      const blocked = await call(env, { method: "GET", path, auth: { token: internal.token } });
      assert.equal(assert_error(blocked, 403, "policy_blocked").retryable, false);
      leak(blocked);
    }
    assert.equal(assert_ok(await call(env, { method: "GET", path: answer_path, auth: "owner" })).content.comment, marker);
  });
});

// ---------------------------------------------------------------------------
// F3 — a key spent on another command is 409, not 500

test("F3 an Idempotency-Key spent on another command is 409 idempotency_key_reuse on handoffs and on interrupt, and writes nothing", async () => {
  await with_api(async (env) => {
    // (1) the key of POST /runs (a receipt with no lease) reused on a queued run
    const holder = await make_agent(env, "f3a");
    const created = assert_ok(
      await call(env, {
        method: "POST",
        path: P(env, "/runs"),
        auth: "owner",
        body: { actor_id: holder.actor_id, mode: "B", runtime: "synthetic-runtime", provider: "synthetic", model: "synthetic-model" },
        key: "synthetic-used-key",
      }),
      201,
    );
    const before = state_signature(env.db);
    const handoff = await call(env, { method: "POST", path: P(env, `/runs/${created.run_id}/handoffs`), auth: "owner", body: { target_mode: "B" }, key: "synthetic-used-key" });
    assert_error(handoff, 409, "idempotency_key_reuse");
    const interrupt = await call(env, { method: "POST", path: P(env, `/runs/${created.run_id}/interrupt`), auth: "owner", body: { reason: "합성" }, key: "synthetic-used-key" });
    assert_error(interrupt, 409, "idempotency_key_reuse");
    assert.equal(state_signature(env.db), before, "a refused reuse writes nothing");

    // (2) the key of a claim (a receipt WITH a lease) reused on the held run's handoffs / interrupt
    const agent = await make_agent(env, "f3b");
    const run = assert_ok(
      await call(env, {
        method: "POST",
        path: P(env, "/runs"),
        auth: "owner",
        body: { actor_id: agent.actor_id, mode: "B", runtime: "synthetic-runtime", provider: "synthetic", model: "synthetic-model" },
      }),
      201,
    );
    assert_ok(await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: agent.token }, body: { run_id: run.run_id }, key: "synthetic-claim-key" }));
    const held = state_signature(env.db);
    assert_error(
      await call(env, { method: "POST", path: P(env, `/runs/${run.run_id}/handoffs`), auth: { token: agent.token }, body: { target_mode: "B" }, key: "synthetic-claim-key" }),
      409,
      "idempotency_key_reuse",
    );
    assert_error(
      await call(env, { method: "POST", path: P(env, `/runs/${run.run_id}/interrupt`), auth: { token: agent.token }, body: { reason: "합성" }, key: "synthetic-claim-key" }),
      409,
      "idempotency_key_reuse",
    );
    assert.equal(state_signature(env.db), held, "the run is still held and nothing was written");
    assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", run.run_id)?.status, "running");

    // The right replay still works: the same key on the same command and run answers the same.
    const first = await call(env, { method: "POST", path: P(env, `/runs/${run.run_id}/handoffs`), auth: { token: agent.token }, body: { target_mode: "B" }, key: "synthetic-own-key" });
    assert_ok(first);
    const replay = await call(env, { method: "POST", path: P(env, `/runs/${run.run_id}/handoffs`), auth: { token: agent.token }, body: { target_mode: "B" }, key: "synthetic-own-key" });
    assert_ok(replay);
    assert.equal(replay.json.replayed, true);
  });
});

// ---------------------------------------------------------------------------
// S1 — a handoff target that cannot take effect is refused

test("S1 handoffs: a target_actor_id or target_mode that differs from the run's own is 400 invalid_payload and writes nothing; the run's own (or none) is the old behaviour", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "s1a");
    const other = await make_agent(env, "s1b");
    const lease = await run_for(env, agent, "B");
    const path = P(env, `/runs/${lease.run_id}/handoffs`);
    const before = state_signature(env.db);

    for (const [who, auth] of [
      ["holder", { token: agent.token }],
      ["owner", "owner"],
    ] as const) {
      assert_final_error(await call(env, { method: "POST", path, auth, body: { target_mode: "B", target_actor_id: other.actor_id } }), 400, "invalid_payload", {
        target: "$.body.target_actor_id",
      });
      assert_final_error(await call(env, { method: "POST", path, auth, body: { target_mode: "A" } }), 400, "invalid_payload", { target: "$.body.target_mode" });
      assert.equal(state_signature(env.db), before, `${who}: a refusal writes nothing`);
    }
    assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", lease.run_id)?.status, "running");
    assert.equal(env.db.get<{ actor_id: string }>("SELECT actor_id FROM runs WHERE id = ?", lease.run_id)?.actor_id, agent.actor_id);

    // The run's own actor and mode: allowed, the same run goes back to the queue.
    const same = assert_ok(await call(env, { method: "POST", path, auth: { token: agent.token }, body: { target_mode: "B", target_actor_id: agent.actor_id, reason: "합성" } }));
    assert.equal(same.run_id, lease.run_id);
    assert.equal(same.status, "queued");
    assert.equal(same.target_actor_id, agent.actor_id);
    assert.equal(same.target_mode, "B");

    // Omitted fields: allowed too (claim again, then hand back with no target at all).
    const again = assert_ok(await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: agent.token }, body: { run_id: lease.run_id } }));
    const bare = assert_ok(await call(env, { method: "POST", path: P(env, `/runs/${again.run_id}/handoffs`), auth: { token: agent.token }, body: {} }));
    assert.equal(bare.run_id, lease.run_id);
    assert.equal(bare.status, "queued");
  });
});

/**
 * SEL-99 U4a — 에이전트 경로: A 내장 실행기 도구 thread.reply · followup.propose, B MCP 도구, 같은 명령 (tester, 작성 모드).
 * 가짜 AI 서버(tests/helpers/a_builtin_env.ts FakeAi)와 가짜 MCP 클라이언트만 쓴다. 실제 모델·네트워크 호출 없음.
 *
 * ===== (7) 필요한가? — 정한 결론: **둘 다 필요하다** =====
 *   - A: allowlist 에는 결정 0013 으로 이름 thread.reply · followup.propose 가 이미 있다(그대로 — 새 이름을 더하지 않는다). 지금은 thread.reply 가 "명령 없음" 거절이고(모델에게 안 보여 줌)
 *     followup.propose 는 project.add_note 의 "[AI 제안: 후속 작업]" 노트만 만든다. U4a 가 명령(thread.reply · followup.propose)을 만들므로 두 도구를 **진짜 명령에 잇고**
 *     thread.reply 를 모델에게 보여 준다(기존 시험 중 "thread.reply 는 안 보임"을 단언하는 것은 이 이슈에서 바뀐다 — 보고에 목록).
 *   - B: B MCP 에 같은 명령을 쓰는 도구가 필요하다: pes_thread_reply · pes_followup_propose (tests/helpers/sel99_env.ts 의 B99_TOOL — 이름이 바뀌면 그 상수만 고친다).
 *   - 사람 전용 일(해결 thread.resolve · 채택 followup.apply · 다시 붙이기 annotation.reanchor 의 선택)은 A 도구에도 B 도구에도 **없다**. 모델이 부르면 "not available".
 *
 * 정한 해석:
 *   A thread.reply {thread_id, text, reply_to?}  → 명령 thread.reply {thread_id, body_md: text, reply_to?}. 성공 {ok:true, message_id, ...}. 거절(없는 스레드·닫힌 스레드·빈 글)은 is_error 결과로 돌려주고 run 은 계속된다.
 *   A followup.propose {thread_id, text, kind?, proposed_body_md?, target_stage_id?, target_round_id?} → 명령 followup.propose {origin_thread_id: thread_id, kind: kind ?? 'none', description: text, ...}. 항상 proposed.
 *     (thread_id 가 없는 호출의 처리는 이 이슈의 시험 밖이다 — 기존 노트 동작 시험이 그대로 본다.)
 *   B pes_thread_reply {idempotency_key, thread_id, body_md, reply_to?} · pes_followup_propose {idempotency_key, thread_id, kind, description, proposed_body_md?, target_stage_id?, target_round_id?}.
 *   행위자는 에이전트(A: 내장 AI 행위자, B: 토큰 행위자). 에이전트가 만든 후속은 언제나 proposed(확정 없음). A 와 B 는 같은 행·같은 영수증 action 을 남긴다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { A_TOOL_ALLOWLIST, TOOL_SPECS } from "../scripts/pes_core/a_runtime/tools.ts";
import {
  FINISH,
  offered_tools,
  open_stage,
  ready_project,
  run_row,
  start_run,
  with_a_env,
  type AEnv,
  type ScriptedTurn,
} from "./helpers/a_builtin_env.ts";
import { make_adapter_env } from "./helpers/adapter_b_env.ts";
import { claim_fresh, with_cleanup } from "./helpers/adapter_b_flow.ts";
import { B99_TOOL, HUMAN_ONLY_U4, body_of, cp_find, current_version_of, followup_row, messages_of, text_artifact, thread_row, type Out } from "./helpers/sel99_env.ts";
import { state_signature } from "./helpers/state_signature.ts";
import type { Env } from "./helpers/blob_env.ts";

const BODY = "2장 합성 정책 분석에서 정책 대안은 두 가지다. 첫 번째는 현행 유지다.";
const QUOTE = "정책 대안은 두 가지다.";
const NEW_BODY = "2장 합성 정책 분석에서 정책 대안은 두 가지이며 근거는 부록 A 에 있다. 첫 번째는 현행 유지다.";

function script_fn(env: AEnv, fn: (n: number) => ScriptedTurn): void {
  const base = env.fake.calls.length;
  env.fake.script = (n: number) => fn(n - base);
}

/** 사람(소유자)이 만들어 둔 첨언 스레드. */
async function seeded_thread(env: Env, tag = "seed") {
  const art = await text_artifact(env, tag, BODY);
  const note = (await env.service.execute(env.ctx(`${tag}-note`), "annotation.create", { target_object_id: art.object_id, anchor: { exact_quote: QUOTE, ...cp_find(BODY, QUOTE) }, body_md: "근거를 더 설명해 주세요." })).result as Out;
  return { art, thread_id: note.thread_id as string };
}

const actions_u4 = (env: { db: Env["db"] }): string[] =>
  env.db.all<{ action: string }>("SELECT action FROM mutation_commits WHERE action IN ('thread.reply','followup.propose','thread.resolve','followup.apply','annotation.reanchor') ORDER BY rowid").map((r) => r.action);

const note_count = (env: { db: Env["db"] }): number => Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM artifacts WHERE kind = 'note'")?.n ?? 0n);

// ---------------------------------------------------------------------------
// A: allowlist 와 제공 도구

test("A allowlist: 이름은 그대로 8개(새 이름 없음), thread.reply · followup.propose 둘 다 모델에게 제공되고, 해결·채택·다시 붙이기 도구는 어디에도 없다", () => {
  const list = [...A_TOOL_ALLOWLIST].sort();
  assert.deepEqual(list, ["assumption.propose", "context.get", "decision.propose", "followup.propose", "question.ask", "reflection.write", "result.submit", "thread.reply"]);
  const offered = TOOL_SPECS.map((t) => t.name);
  for (const name of ["thread.reply", "followup.propose"]) assert.ok(offered.includes(name), `${name} 은 이제 명령이 있으므로 모델에게 보인다`);
  for (const name of offered) {
    assert.ok(list.includes(name), `${name} offered ⊆ allowed`);
    assert.doesNotMatch(name, HUMAN_ONLY_U4, `${name}: 사람만 하는 일은 도구가 될 수 없다`);
  }
  for (const name of list) assert.doesNotMatch(name, /^(shell|bash|exec|fs|file|http|fetch|web|net|curl|sh)\b/i, `${name} 은 파일·셸·네트워크 도구가 아니다`);
});

// ---------------------------------------------------------------------------
// A: 합성 라운드

for (const format of ["openai_compatible", "anthropic"] as const) {
  test(`A round (${format}): 내장 실행기가 진짜 스레드 답글과 edit_text 제안을 만든다(제안일 뿐, 글·스레드 상태·반영 내역은 그대로)`, async () => {
    await with_a_env(format, async (env) => {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      const s = await seeded_thread(env);
      script_fn(env, (n) =>
        n === 1
          ? {
              tools: [
                { name: "thread.reply", args: { thread_id: s.thread_id, text: "AI 가 단 답글: 근거를 부록 A 에 정리하겠습니다." } },
                { name: "followup.propose", args: { thread_id: s.thread_id, kind: "edit_text", text: "근거 문장을 보강한다.", proposed_body_md: NEW_BODY } },
              ],
            }
          : FINISH,
      );
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(res.status, "succeeded", JSON.stringify(res));
      assert.ok(offered_tools(env.fake.calls[0]!.json).includes("thread.reply"), "모델이 thread.reply 를 볼 수 있다");

      const msgs = messages_of(env.db, s.thread_id);
      assert.equal(msgs.length, 2);
      assert.equal(msgs[1]!.body_md, "AI 가 단 답글: 근거를 부록 A 에 정리하겠습니다.");
      assert.equal(msgs[1]!.actor_id, env.ai_actor_id);
      assert.equal(thread_row(env.db, s.thread_id).state, "open", "AI 는 스레드를 닫지 않는다");

      const f = env.db.get<{ object_id: string }>("SELECT object_id FROM followups ORDER BY rowid LIMIT 1");
      assert.ok(f, "후속이 진짜 followups 행으로 생겼다(노트가 아니다)");
      const row = followup_row(env.db, f.object_id);
      assert.equal(row.kind, "edit_text");
      assert.equal(row.state, "proposed");
      assert.equal(row.origin_thread_id, s.thread_id);
      assert.equal(row.confirmed_by_actor_id, null, "AI 는 확정하지 않는다");
      assert.equal(row.description, "근거 문장을 보강한다.");
      assert.equal(body_of(env.db, row.proposed_artifact_version_id!), NEW_BODY);
      assert.equal(current_version_of(env.db, s.art.object_id), s.art.version_id, "AI 제안은 글을 바꾸지 않는다");
      assert.equal(body_of(env.db, s.art.version_id), BODY);
      assert.equal(Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM reflection_entries")!.n), 0);
      assert.equal(note_count(env), 0, "이 도구들은 더 이상 '[AI 제안: …]' 노트를 만들지 않는다");
      assert.deepEqual(actions_u4(env), ["thread.reply", "followup.propose"]);
      assert.equal(run_row(env, res.run_id).status, "succeeded");
    });
  });
}

test("A: 거절은 모델에게 오류 결과로 돌아가고 아무것도 쓰지 않으며 run 은 계속된다(대조군 호출은 쓰인다)", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const open_t = await seeded_thread(env, "open");
    const closed_t = await seeded_thread(env, "closed");
    await env.service.execute(env.ctx("close-it"), "thread.resolve", { thread_id: closed_t.thread_id, resolution: "none", reason: "닫았다." });
    const sig_before = state_signature(env.db);
    script_fn(env, (n) =>
      n === 1
        ? {
            tools: [
              { name: "thread.reply", args: { thread_id: "no-such-thread", text: "x" } },
              { name: "thread.reply", args: { thread_id: closed_t.thread_id, text: "닫힌 뒤" } },
              { name: "thread.reply", args: { thread_id: open_t.thread_id, text: "   " } },
              { name: "followup.propose", args: { thread_id: open_t.thread_id, kind: "edit_text", text: "글이 없다" } },
              { name: "followup.propose", args: { thread_id: open_t.thread_id, kind: "next_round_task", text: "단계가 없다" } },
              { name: "followup.propose", args: { thread_id: "no-such-thread", kind: "none", text: "x" } },
              // 대조군: 올바른 호출은 같은 턴에서 쓰인다 — 위의 빈 결과가 죽은 도구 때문이 아니다
              { name: "thread.reply", args: { thread_id: open_t.thread_id, text: "대조군 답글" } },
            ],
          }
        : FINISH,
    );
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "succeeded");
    assert.deepEqual(messages_of(env.db, open_t.thread_id).map((m) => m.body_md), ["근거를 더 설명해 주세요.", "대조군 답글"]);
    assert.equal(messages_of(env.db, closed_t.thread_id).length, 2, "닫힌 스레드(첫 첨언 + 결론)에는 답글이 안 붙었다");
    assert.equal(Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM followups")!.n), 0);
    assert.notEqual(state_signature(env.db), sig_before);
    assert.match(JSON.stringify(env.fake.calls[1]!.json), /\\"ok\\":false/, "모델은 도구가 실패했다고 들었다");
  });
});

test("A: 사람 전용 일(thread.resolve · followup.apply · annotation.reanchor)이나 파일·셸·네트워크 도구 이름은 'not available' 이고 아무것도 바꾸지 않는다", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const s = await seeded_thread(env);
    const prop = (await env.service.execute(env.ctx("seed-fp"), "followup.propose", { origin_thread_id: s.thread_id, kind: "edit_text", description: "사람이 올린 제안", proposed_body_md: NEW_BODY })).result as Out;
    const sig = state_signature(env.db);
    script_fn(env, (n) =>
      n === 1
        ? {
            tools: [
              { name: "thread.resolve", args: { thread_id: s.thread_id, resolution: "none", reason: "AI 가 닫기" } },
              { name: "followup.apply", args: { followup_id: prop.followup_id, base_version_id: s.art.version_id, expected_rev: "1" } },
              { name: "annotation.reanchor", args: { thread_id: s.thread_id, start_cp: 0, end_cp: 3 } },
              { name: "file.read", args: { path: "/etc/passwd" } },
              { name: "shell", args: { cmd: "id" } },
              { name: "web.fetch", args: { url: "http://example.invalid" } },
            ],
          }
        : FINISH,
    );
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "succeeded");
    assert.match(JSON.stringify(env.fake.calls[1]!.json), /not available/);
    assert.equal(thread_row(env.db, s.thread_id).state, "open");
    assert.equal(followup_row(env.db, prop.followup_id).state, "proposed");
    assert.equal(current_version_of(env.db, s.art.object_id), s.art.version_id);
    assert.deepEqual(actions_u4(env), ["followup.propose"], "AI 호출로는 U4 영수증이 하나도 더 생기지 않았다");
    assert.ok(sig.length > 0);
  });
});

test("A: reopen_stage 제안은 제안으로만 남는다(AI 가 단계를 다시 열 수 없다)", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const s = await seeded_thread(env);
    const before = env.db.get<{ state: string }>("SELECT state FROM stages WHERE id = ?", o.stage_id)!.state;
    script_fn(env, (n) => (n === 1 ? { tools: [{ name: "followup.propose", args: { thread_id: s.thread_id, kind: "reopen_stage", text: "계획 단계를 다시 연다.", target_stage_id: o.stage_id } }] } : FINISH));
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "succeeded");
    const f = env.db.get<{ object_id: string }>("SELECT object_id FROM followups LIMIT 1")!;
    assert.equal(followup_row(env.db, f.object_id).kind, "reopen_stage");
    assert.equal(followup_row(env.db, f.object_id).state, "proposed");
    assert.equal(env.db.get<{ state: string }>("SELECT state FROM stages WHERE id = ?", o.stage_id)!.state, before);
  });
});

// ---------------------------------------------------------------------------
// B: MCP

test("B: tools/list 에 pes_thread_reply · pes_followup_propose 가 있고(idempotency_key 필수), 해결·채택·다시 붙이기 도구는 없다", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const listed = await client.request("tools/list", {});
    const names: string[] = listed.result.tools.map((t: any) => t.name);
    for (const name of Object.values(B99_TOOL)) {
      assert.ok(names.includes(name), `${name} is listed`);
      const spec = listed.result.tools.find((t: any) => t.name === name);
      assert.equal(spec.inputSchema.type, "object");
      assert.ok(spec.inputSchema.properties.idempotency_key, `${name} takes idempotency_key`);
      assert.ok(spec.inputSchema.properties.thread_id, `${name} takes thread_id`);
    }
    for (const name of names) assert.doesNotMatch(name, HUMAN_ONLY_U4, `${name}: 사람 전용 일은 MCP 도구가 될 수 없다`);
  });
});

test("B: 연결된 에이전트가 MCP 로 답글과 edit_text 제안을 만든다 — 재생은 안전하고, 거절은 도구 오류(API 코드)이며 아무것도 쓰지 않는다", async () => {
  await with_cleanup(async (env, open) => {
    const s = await seeded_thread(env, "b");
    const client = open(await env.client());
    await claim_fresh(client);

    const reply = await client.ok(B99_TOOL.reply, { idempotency_key: "b-r", thread_id: s.thread_id, body_md: "B 에이전트의 답글" });
    assert.ok(reply);
    const msgs = messages_of(env.db, s.thread_id);
    assert.equal(msgs.at(-1)!.body_md, "B 에이전트의 답글");
    assert.equal(msgs.at(-1)!.actor_id, env.agent.actor_id);

    const f = await client.ok(B99_TOOL.followup, { idempotency_key: "b-f", thread_id: s.thread_id, kind: "edit_text", description: "근거 보강", proposed_body_md: NEW_BODY });
    const fid = f.followup_id ?? f.followup?.id ?? f.id;
    assert.ok(fid, JSON.stringify(f));
    const row = followup_row(env.db, fid);
    assert.equal(row.state, "proposed");
    assert.equal(row.kind, "edit_text");
    assert.equal(row.confirmed_by_actor_id, null);
    assert.equal(body_of(env.db, row.proposed_artifact_version_id!), NEW_BODY);
    assert.equal(current_version_of(env.db, s.art.object_id), s.art.version_id);
    assert.equal(thread_row(env.db, s.thread_id).state, "open");

    // 재생: 같은 키·같은 인자는 아무것도 더하지 않고, 같은 키·다른 인자는 거절
    const sig = state_signature(env.db);
    await client.ok(B99_TOOL.reply, { idempotency_key: "b-r", thread_id: s.thread_id, body_md: "B 에이전트의 답글" });
    assert.equal(state_signature(env.db), sig);
    await client.fails(B99_TOOL.reply, { idempotency_key: "b-r", thread_id: s.thread_id, body_md: "다른 답글" }, "idempotency_key_reuse");

    // 거절은 도구 오류
    const empty = await client.tool(B99_TOOL.reply, { idempotency_key: "b-bad1", thread_id: s.thread_id, body_md: "" });
    assert.equal(empty.is_error, true);
    assert.ok(["validation_failed", "invalid_payload"].includes(empty.data.error.code), empty.data.error.code);
    const missing = await client.tool(B99_TOOL.reply, { idempotency_key: "b-bad2", thread_id: "no-such-thread", body_md: "x" });
    assert.equal(missing.is_error, true);
    assert.equal(missing.data.error.code, "not_found");
    const no_text = await client.tool(B99_TOOL.followup, { idempotency_key: "b-bad3", thread_id: s.thread_id, kind: "edit_text", description: "글 없음" });
    assert.equal(no_text.is_error, true);
    const no_key = await client.tool(B99_TOOL.reply, { thread_id: s.thread_id, body_md: "키 없음" });
    assert.equal(no_key.is_error, true);
    assert.equal(no_key.data.error.code, "invalid_payload");
    assert.equal(state_signature(env.db), sig, "거절된 호출은 아무것도 쓰지 않는다");

    // 닫힌 스레드
    await env.service.execute(env.ctx("b-close"), "thread.resolve", { thread_id: s.thread_id, resolution: "none", reason: "닫았다." });
    const closed = await client.tool(B99_TOOL.reply, { idempotency_key: "b-closed", thread_id: s.thread_id, body_md: "닫힌 뒤" });
    assert.equal(closed.is_error, true);
    assert.equal(closed.data.error.code, "thread_closed");
  });
});

// ---------------------------------------------------------------------------
// A 와 B 는 같은 명령

test("A 와 B 는 같은 모양의 행과 같은 영수증 action 을 남긴다: 같은 명령", async () => {
  const shape = (env: Env): Record<string, unknown> => {
    const t = env.db.get<{ object_id: string }>("SELECT object_id FROM threads ORDER BY rowid LIMIT 1")!.object_id;
    const f = env.db.get<{ object_id: string }>("SELECT object_id FROM followups ORDER BY rowid LIMIT 1")!.object_id;
    const row = followup_row(env.db, f);
    const msgs = messages_of(env.db, t);
    return {
      messages: msgs.map((m) => [m.body_md, m.state, m.reply_to === null]),
      followup: { kind: row.kind, state: row.state, description: row.description, confirmed: row.confirmed_by_actor_id, applied: row.applied_tx_id, has_text: row.proposed_artifact_version_id !== null, version_no: row.version_no },
      thread_state: thread_row(env.db, t).state,
      actions: actions_u4(env),
    };
  };
  let a_shape: Record<string, unknown> = {};
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const s = await seeded_thread(env);
    script_fn(env, (n) =>
      n === 1
        ? {
            tools: [
              { name: "thread.reply", args: { thread_id: s.thread_id, text: "같은 답글" } },
              { name: "followup.propose", args: { thread_id: s.thread_id, kind: "edit_text", text: "같은 제안", proposed_body_md: NEW_BODY } },
            ],
          }
        : FINISH,
    );
    assert.equal((await start_run(env, { stage_id: o.stage_id, round_id: o.round_id })).status, "succeeded");
    a_shape = shape(env);
  });
  const env = await make_adapter_env();
  try {
    const s = await seeded_thread(env, "p");
    const client = await env.client();
    await claim_fresh(client);
    await client.ok(B99_TOOL.reply, { idempotency_key: "p-r", thread_id: s.thread_id, body_md: "같은 답글" });
    await client.ok(B99_TOOL.followup, { idempotency_key: "p-f", thread_id: s.thread_id, kind: "edit_text", description: "같은 제안", proposed_body_md: NEW_BODY });
    await client.close();
    assert.deepEqual(shape(env), a_shape);
    assert.deepEqual((a_shape.actions as string[]), ["thread.reply", "followup.propose"]);
  } finally {
    env.close();
  }
});

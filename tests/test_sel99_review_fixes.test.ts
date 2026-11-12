/**
 * SEL-99 최종 리뷰 1/2 고침 (회귀 시험).
 *
 * 필수 1 — 읽기의 "현재 앵커"(GET P/threads/{t} 의 anchor.current = thread_reads.current_anchor)는
 *   글의 현재 버전에 대해 **사람이 확정한 줄(confirmed_by_actor_id)이 하나라도 있으면 그중 마지막**을 보인다.
 *   (가) 사람이 다시 붙인 뒤 리스를 쥔 에이전트가 자동 재판정(annotation.reanchor, 구간 없음)을 불러도 사람 결정이 남는다.
 *   (나) 앵커를 만든 그 버전에서 사람이 다른 자리(반복 인용의 두 번째)로 다시 붙이면 읽기도 그 자리를 보인다.
 *   사람 확정 줄이 없을 때만 자동 계산(원래 버전이면 원래 자리, 아니면 본문에서 판정).
 *
 * 권장 1 — A thread.reply 와 B pes_thread_reply(POST P/threads/{t}/messages)는 질문 의견(question_comment) 스레드에서도 같은 명령에 닿는다:
 *   같은 영수증 action, 같은 메시지 행, 닫힌(resolved) 스레드는 둘 다 거절(B 는 409 thread_closed)하고 아무것도 쓰지 않는다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { thread_detail } from "../scripts/pes_core/commands/thread_reads.ts";
import { FINISH, open_stage, ready_project, start_run, with_a_env, type AEnv, type ScriptedTurn } from "./helpers/a_builtin_env.ts";
import { make_adapter_env } from "./helpers/adapter_b_env.ts";
import { claim_fresh } from "./helpers/adapter_b_flow.ts";
import { add_agent, agent_claim, with_env, type Env } from "./helpers/editions_env.ts";
import { publish, single_spec } from "./helpers/questions_env.ts";
import { B99_TOOL, cp_find, messages_of, resolutions_of, text_artifact, text_version, type Out } from "./helpers/sel99_env.ts";

async function run(env: Env, key: string, command: string, payload: Record<string, unknown>): Promise<Out> {
  return (await env.service.execute(env.ctx(key), command, payload)).result as Out;
}

function current_of(env: Env, thread_id: string): Record<string, any> {
  const read = thread_detail(env.db, env.p.project_id, thread_id) as Record<string, any>;
  return read.anchor.current;
}

// ---------------------------------------------------------------------------
// 필수 1

test("(가) 사람이 다시 붙인 뒤 에이전트가 자동 재판정을 불러도 읽기는 사람 결정을 보인다", async () => {
  await with_env(async (env) => {
    const QUOTE = "정책 대안은 두 가지다.";
    const V1 = `머리글. ${QUOTE} 끝.`;
    const art = await text_artifact(env, "ga", V1);
    const note = await run(env, "ga-an", "annotation.create", { target_object_id: art.object_id, anchor: { exact_quote: QUOTE, ...cp_find(V1, QUOTE) }, body_md: "첨언" });
    const V2 = "완전히 다시 쓴 글. 정책 선택지는 둘로 줄었다. 끝.";
    const v2 = await text_version(env, "ga-v2", art.object_id, V2);

    const pick = cp_find(V2, "정책 선택지는 둘로 줄었다.");
    const moved = await run(env, "ga-pick", "annotation.reanchor", { thread_id: note.thread_id, version_id: v2.version_id, ...pick });
    assert.equal(moved.status, "moved");
    const by_person = current_of(env, note.thread_id as string);
    assert.equal(by_person.status, "moved");
    assert.equal(by_person.start_cp, pick.start_cp);
    assert.equal(by_person.confirmed_by_actor_id, env.p.actor_id);

    // 리스를 쥔 에이전트의 자동 재판정: 줄은 더해지지만(lost) 사람 결정을 가리지 않는다
    const base = add_agent(env, "agent-sel99-fix");
    const lease = await agent_claim(env, base, "ga-claim");
    const auto = (await env.service.execute({ ...base, client_request_id: "ga-auto" }, "annotation.reanchor", { thread_id: note.thread_id, run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence })).result as Out;
    assert.equal(auto.status, "lost");
    const rows = resolutions_of(env.db, note.anchor_id as string);
    assert.equal(rows.at(-1)!.status, "lost", "자동 줄은 남는다(append-only)");
    assert.equal(rows.at(-1)!.confirmed_by_actor_id, null);

    const after = current_of(env, note.thread_id as string);
    assert.equal(after.status, "moved", "사람 결정이 계속 보인다");
    assert.equal(after.start_cp, pick.start_cp);
    assert.equal(after.end_cp, pick.end_cp);
    assert.equal(after.text, "정책 선택지는 둘로 줄었다.");
    assert.equal(after.confirmed_by_actor_id, env.p.actor_id);
  });
});

test("(나) 원래 버전에서 사람이 반복 인용의 두 번째로 다시 붙이면 읽기도 그 자리를 보인다(명령 결과와 읽기가 같다)", async () => {
  await with_env(async (env) => {
    const BODY = "가 정책 문장. 나 정책 문장. 끝";
    const QUOTE = "정책 문장.";
    const art = await text_artifact(env, "na", BODY);
    const first = cp_find(BODY, QUOTE, 0);
    const second = cp_find(BODY, QUOTE, 1);
    const note = await run(env, "na-an", "annotation.create", { target_object_id: art.object_id, anchor: { exact_quote: QUOTE, ...first }, body_md: "첨언" });
    const before = current_of(env, note.thread_id as string);
    assert.equal(before.status, "exact");
    assert.equal(before.start_cp, first.start_cp);
    assert.equal(before.confirmed_by_actor_id, null);

    const out = await run(env, "na-pick", "annotation.reanchor", { thread_id: note.thread_id, version_id: art.version_id, ...second });
    assert.equal(out.status, "moved");
    assert.equal(out.start_cp, second.start_cp);

    const read = current_of(env, note.thread_id as string);
    assert.equal(read.evaluated_version_id, art.version_id);
    assert.equal(read.status, out.status);
    assert.equal(read.start_cp, out.start_cp);
    assert.equal(read.end_cp, out.end_cp);
    assert.equal(read.confirmed_by_actor_id, env.p.actor_id);
  });
});

// ---------------------------------------------------------------------------
// 권장 1

interface Seen {
  actions: string[];
  bodies: string[];
  closed_refused: boolean;
  closed_messages: number;
}

const comment_actions = (env: { db: Env["db"] }): string[] =>
  env.db.all<{ action: string }>("SELECT action FROM mutation_commits WHERE action IN ('thread.reply','question.commented') ORDER BY rowid").map((r) => r.action);

/** 소유자가 질문 하나에 의견 스레드 둘(열린 것·닫은 것)을 만들어 둔다. */
async function question_threads(env: Env, where: { stage_id: string; round_id: string | null }, tag: string) {
  const pub = await publish(env, where, [single_spec("합성 질문")], `${tag}-pub`);
  const q = pub.members[0]!.question_id;
  const open_t = (await run(env, `${tag}-c1`, "question.comment_add", { question_id: q, body_md: "열린 의견" })).thread_id as string;
  const closed_t = (await run(env, `${tag}-c2`, "question.comment_add", { question_id: q, body_md: "닫을 의견" })).thread_id as string;
  await run(env, `${tag}-close`, "thread.resolve", { thread_id: closed_t, resolution: "none", reason: "닫았다." });
  return { open_t, closed_t };
}

test("A thread.reply 와 B pes_thread_reply 는 질문 의견 스레드에서도 같은 명령: 같은 영수증 action·같은 메시지, 닫힌 스레드는 둘 다 거절", async () => {
  const a: { seen: Seen | null } = { seen: null };
  await with_a_env("openai_compatible", async (aenv: AEnv) => {
    const env = aenv as unknown as Env;
    await ready_project(aenv);
    const o = await open_stage(aenv, "plan");
    const t = await question_threads(env, o, "a");
    const before = comment_actions(env);
    const base = aenv.fake.calls.length;
    aenv.fake.script = (n: number): ScriptedTurn =>
      n - base === 1
        ? {
            tools: [
              { name: "thread.reply", args: { thread_id: t.open_t, text: "같은 답글" } },
              { name: "thread.reply", args: { thread_id: t.closed_t, text: "닫힌 뒤" } },
            ],
          }
        : FINISH;
    assert.equal((await start_run(aenv, { stage_id: o.stage_id, round_id: o.round_id })).status, "succeeded");
    a.seen = {
      actions: comment_actions(env).slice(before.length),
      bodies: messages_of(env.db, t.open_t).map((m) => m.body_md),
      closed_refused: /thread_closed|conflict/.test(JSON.stringify(aenv.fake.calls[base + 1]!.json)),
      closed_messages: messages_of(env.db, t.closed_t).length,
    };
  });

  const benv = await make_adapter_env();
  try {
    const env = benv as unknown as Env;
    const where = { stage_id: benv.stage.plan, round_id: benv.round_id };
    const t = await question_threads(env, where, "b");
    const before = comment_actions(env);
    const client = await benv.client();
    await claim_fresh(client);
    await client.ok(B99_TOOL.reply, { idempotency_key: "b-r", thread_id: t.open_t, body_md: "같은 답글" });
    const closed = await client.tool(B99_TOOL.reply, { idempotency_key: "b-closed", thread_id: t.closed_t, body_md: "닫힌 뒤" });
    await client.close();
    assert.equal(closed.is_error, true);
    assert.equal(closed.data.error.code, "thread_closed");
    const b_seen: Seen = {
      actions: comment_actions(env).slice(before.length),
      bodies: messages_of(env.db, t.open_t).map((m) => m.body_md),
      closed_refused: true,
      closed_messages: messages_of(env.db, t.closed_t).length,
    };
    assert.ok(a.seen !== null);
    assert.deepEqual(b_seen, a.seen);
    assert.deepEqual(b_seen.actions, ["question.commented"], "질문 의견 스레드의 답글은 질문 의견 명령 하나");
    assert.equal(b_seen.closed_messages, 2, "닫힌 스레드에는 답글이 안 붙었다(첫 의견 + 결론)");
  } finally {
    benv.close();
  }
});

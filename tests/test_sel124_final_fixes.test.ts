/**
 * SEL-124 최종 리뷰 1/2 — 필수 2건(F1·F2)과 권장(R3·R5) 시험. 합성 데이터만, 가짜 AI 서버만(실제 모델·네트워크 호출 없음).
 *
 *  F1  context.get 이 준 스레드 인용문(threads[].quote)은 실행기 기록(turns)에 남아 다음 요청마다 다시 나간다. 인용문을 준 뒤
 *      (첫 전달 전이든 한 번 전달한 뒤든) 그 인용문의 원본 판·현재 앵커 판이 AI 금지(version_ai_denied)로 바뀌면, 다음 요청은
 *      나가지 않는다 — SEL-113 참고자료 철회와 같게 요청 직전 재판정으로 run 을 멈추고(interrupted·reference_withdrawn) 보내지 않는다.
 *      재현: 리뷰의 합성 재현 그대로 — env.keys.get 을 감싸 다음 요청용 키를 읽는 동안 file.ai_access_set(deny).
 *      OpenAI 호환·Anthropic × 첫 전달 전 철회·한 번 전달한 뒤 철회.
 *  F2  직렬화하면 긴 한 스레드 행(제어 문자 300자 quote·message)이 스레드 전용 쪽에서도 담기지 않아 next_offset 이 0 에 머물던 것 —
 *      스레드 전용 쪽에는 적어도 한 행이 들어가고(글을 더 줄이고 truncated_fields 로 알림), 4000자 상한도 지킨다.
 *  R3  열린 스레드가 실린 응답에는 짧은 threads_help 가 있다(도구 설명은 늘리지 않는다).
 *  R5  경계: 현재 판만 닫힘 · 다른 프로젝트 첨언 제외 · archived / question_comment 제외 · 철회된 마지막 메시지 대신 이전 공개 메시지 ·
 *      앞 목록이 첫 쪽을 다 써서 스레드 0건이면 threads_offset: 0 으로 이어 읽는다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { TOOL_SPECS } from "../scripts/pes_core/a_runtime/tools.ts";
import { add_artifact, create_object } from "../scripts/pes_core/content.ts";
import { FINISH, context_turn, open_stage, ready_project, start_run, with_a_env, type AEnv, type Format, type ScriptedTurn } from "./helpers/a_builtin_env.ts";
import { ctx_for, put_ready, second_project } from "./helpers/blob_env.ts";
import { art, more, ok } from "./helpers/sel119_env.ts";
import { cp_find, messages_of } from "./helpers/sel99_env.ts";
import { attached } from "./helpers/sel113_env.ts";

// ---------------------------------------------------------------------------
// 준비물

function tool_results(body: any): any[] {
  const out: any[] = [];
  for (const m of (body?.messages ?? []) as any[]) {
    if (m.role === "tool" && typeof m.content === "string") out.push(JSON.parse(m.content));
    if (m.role === "user" && Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block?.type !== "tool_result") continue;
        const c = block.content;
        const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => x?.text ?? "").join("") : "";
        out.push(JSON.parse(text));
      }
    }
  }
  return out;
}

const last_result = (body: any): any => {
  const all = tool_results(body);
  assert.ok(all.length > 0, "the request carried a tool result");
  return all[all.length - 1];
};

const result_at = (env: AEnv, n: number): any => last_result(env.fake.calls[n - 1]!.json);
const wire = (env: AEnv, index: number): string => JSON.stringify(env.fake.calls[index]!.json);

function script_fn(env: AEnv, fn: (n: number, body: any) => ScriptedTurn): number {
  const base = env.fake.calls.length;
  env.fake.script = (n: number, rec) => fn(n - base, rec.json);
  return base;
}

async function note(env: AEnv, key: string, object_id: string, body: string, quote: string, text: string, ctx = env.ctx(key)): Promise<string> {
  const out = (await env.service.execute(ctx, "annotation.create", { target_object_id: object_id, anchor: { exact_quote: quote, ...cp_find(body, quote) }, body_md: text })).result as {
    thread_id: string;
  };
  return out.thread_id;
}

const threads_of = (result: any): any[] => {
  assert.ok(Array.isArray(result?.context?.threads), `context.threads is missing: ${JSON.stringify(result).slice(0, 300)}`);
  return result.context.threads;
};

/** what the run left: status and the reason on its last run.interrupted event, its dispatches' states */
function stopped_state(env: AEnv): { status: string; reason: string | null; dispatches: string[] } {
  const run = env.db.get<{ id: string; status: string }>("SELECT id, status FROM runs WHERE project_id = ? ORDER BY rowid DESC LIMIT 1", env.p.project_id)!;
  const event = env.db.get<{ payload: string }>("SELECT payload FROM events WHERE run_id = ? AND type = 'run.interrupted' ORDER BY event_seq DESC LIMIT 1", run.id);
  const dispatches = env.db.all<{ state: string }>("SELECT state FROM outbound_dispatches WHERE run_id = ? ORDER BY rowid", run.id).map((d) => d.state);
  return { status: run.status, reason: event === undefined ? null : (JSON.parse(event.payload).reason ?? null), dispatches };
}

const FORMATS: Format[] = ["openai_compatible", "anthropic"];
const BODY = ["첫째 문장은 정책 배경이다.", "둘째 문장은 비용 추정이다.", "셋째 문장은 위험 요인이다."].join(" ");

// ---------------------------------------------------------------------------
// F1 — 인용문을 준 뒤 금지로 바뀌면 다음 요청이 나가지 않는다

const SECRET = "SYNTHETIC-SEL124-REVOKED-QUOTE";

/** 파일이 붙은 판 V1 에 SECRET 을 인용한 첨언, 현재 판 V2 는 인용문 없는 공개 글, 마지막 메시지도 인용문 없는 일반 첨언. 처음엔 허용. */
async function revocable_scene(env: AEnv, o: { stage_id: string }) {
  const body1 = `앞글 ${SECRET} 뒷글`;
  const doc = await art(env, "rv-doc", { stage_id: o.stage_id, body_md: body1, title: "철회될 문서" });
  const blob = await put_ready(env, new TextEncoder().encode("철회될 파일 본문"), "rv-file");
  const material = (await env.service.execute(env.ctx("rv-up"), "file.upload", { blob_id: blob.blob_id, title: "철회될파일" })).result as Record<string, any>;
  await ok(env, env.ctx("rv-attach"), "file.attach_version", { version_id: doc.version_id, blob_id: blob.blob_id, role: "attachment" });
  const thread_id = await note(env, "rv-note", doc.object_id, body1, SECRET, "일반 첨언입니다.");
  await more(env, "rv-v2", doc.object_id, { title: "철회될 문서", body_md: "인용문이 없는 공개 글이다.", current: true });
  return { thread_id, file_policy_id: material.file_policy_id as string };
}

const deny = (env: AEnv, policy: string, key: string) => env.service.execute(env.ctx(key), "file.ai_access_set", { file_policy_id: policy, ai_access: "deny" });

/** env.keys.get 을 감싸 `at` 번째(base 기준) 요청을 마친 뒤 다음 요청용 키를 읽는 동안 한 번 금지한다. */
function deny_while_key_read(env: AEnv, base: number, at: number, policy: string): () => boolean {
  const original = env.keys.get.bind(env.keys);
  let done = false;
  (env.keys as any).get = async (k: string) => {
    if (!done && env.fake.calls.length - base === at) {
      done = true;
      await deny(env, policy, `rv-deny-${at}`);
    }
    return original(k);
  };
  return () => done;
}

for (const format of FORMATS) {
  test(`F1 (${format}) 첫 전달 전 금지: context.get 이 준 인용문은 한 번도 나가지 않고 run 은 reference_withdrawn 으로 멈춘다`, async () => {
    await with_a_env(format, async (env) => {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      const s = await revocable_scene(env, o);
      const base = script_fn(env, (n) => (n === 1 ? context_turn() : FINISH));
      const denied = deny_while_key_read(env, base, 1, s.file_policy_id);
      await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(denied(), true, "금지는 두 요청 사이에 일어났다");
      assert.equal(env.fake.calls.length - base, 1, "둘째 요청은 나가지 않는다");
      for (let i = base; i < env.fake.calls.length; i++) assert.equal(wire(env, i).includes(SECRET), false, "인용문 글자는 어떤 요청에도 없다");
      const state = stopped_state(env);
      assert.equal(state.status, "interrupted");
      assert.equal(state.reason, "reference_withdrawn");
    });
  });

  test(`F1 (${format}) 한 번 전달한 뒤 금지: 셋째 요청은 나가지 않는다(앞 결과도 모델의 파생 응답도 다시 나가지 않는다)`, async () => {
    await with_a_env(format, async (env) => {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      const s = await revocable_scene(env, o);
      const base = script_fn(env, (n) =>
        n === 1 ? context_turn() : n === 2 ? { text: `읽은 인용문: ${SECRET}`, tools: [{ name: "context.get", args: { threads_offset: 0 } }] } : FINISH,
      );
      const denied = deny_while_key_read(env, base, 2, s.file_policy_id);
      await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(denied(), true);
      assert.equal(env.fake.calls.length - base, 2, "셋째 요청은 나가지 않는다");
      assert.ok(wire(env, base + 1).includes(SECRET), "금지 전에는 한 번 나갔다(되돌릴 수 없음)");
      const state = stopped_state(env);
      assert.equal(state.status, "interrupted");
      assert.equal(state.reason, "reference_withdrawn");
    });
  });
}

test("F1 대조: 금지가 없으면 인용문은 다음 요청에도 그대로 실리고 run 은 끝까지 간다; 처음부터 가린 인용문은 재판정 대상이 아니다", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const s = await revocable_scene(env, o);
    let base = script_fn(env, (n) => (n <= 2 ? context_turn() : FINISH));
    await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(stopped_state(env).status, "succeeded");
    assert.equal(env.fake.calls.length - base, 3);
    assert.ok(wire(env, base + 2).includes(SECRET));

    // 처음부터 금지: 인용문은 null 이고 run 은 멈추지 않는다(가린 행은 의존성이 아니다)
    await deny(env, s.file_policy_id, "rv-deny-first");
    base = script_fn(env, (n) => (n <= 2 ? context_turn() : FINISH));
    await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(stopped_state(env).status, "succeeded");
    const row = threads_of(result_at(env, base + 2)).find((t) => t.id === s.thread_id);
    assert.equal(row.quote, null);
    assert.equal(row.quote_withheld, true);
    for (let i = base; i < env.fake.calls.length; i++) assert.equal(wire(env, i).includes(SECRET), false);
  });
});

// ---------------------------------------------------------------------------
// F2 — 직렬화가 큰 한 행도 스레드 전용 쪽은 앞으로 간다

test("F2 제어 문자 300자 quote·message 행: 스레드 전용 쪽에 적어도 한 행이 들어가고(truncated_fields) next_offset 이 진행한다; 4000자 상한", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env, { subscription_limits: { five_hour_tokens: 1_000_000, weekly_tokens: 10_000_000, monthly_tokens: 40_000_000 } });
    const o = await open_stage(env, "plan");
    const q1 = "\u0001".repeat(300);
    const q2 = "\u0003".repeat(300);
    const body = `앞 ${q1} 가운데 ${q2} 뒤`;
    const doc = await art(env, "f2", { stage_id: o.stage_id, body_md: body });
    const t1 = await note(env, "f2a", doc.object_id, body, q1, "\u0002".repeat(300));
    const t2 = await note(env, "f2b", doc.object_id, body, q2, "\u0004".repeat(300));
    const assert_size = (r: any) => assert.ok(JSON.stringify(r).length <= 4000, `한 응답은 4000자 이하: ${JSON.stringify(r).length}`);

    const pages: any[] = [];
    script_fn(env, (n, b) => {
      if (n === 1) return context_turn();
      const r = last_result(b);
      pages.push(r);
      const next = r.context.threads_page?.next_offset;
      if (next !== null && next !== undefined && pages.length < 6) return { tools: [{ name: "context.get", args: { threads_offset: next } }] };
      return FINISH;
    });
    await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(stopped_state(env).status, "succeeded");
    pages.forEach(assert_size);
    const seen: string[] = [];
    let prev = -1;
    for (const p of pages) {
      const page = p.context.threads_page;
      if (p !== pages[0]) {
        assert.ok(threads_of(p).length >= 1, `스레드 전용 쪽에는 적어도 한 행: ${JSON.stringify(p).slice(0, 200)}`);
        assert.ok(page.offset > prev, "스레드 전용 쪽은 앞으로만 간다");
        prev = page.offset;
      }
      for (const row of threads_of(p)) {
        seen.push(row.id);
        if (row.quote !== null && row.quote.length < 300) assert.ok((row.truncated_fields as string[]).includes("quote"));
        if (row.last_message.text.length < 300) assert.ok((row.truncated_fields as string[]).includes("last_message"));
      }
    }
    assert.deepEqual(new Set(seen), new Set([t1, t2]), "두 스레드 id 를 모두 얻는다");
    assert.equal(pages.at(-1).context.threads_page.next_offset, null);
  });
});

// ---------------------------------------------------------------------------
// R3 — threads_help

test("R3 열린 스레드가 실린 응답에는 threads_help 가 있고, 없으면 없다; 도구 설명은 늘지 않았다", async () => {
  assert.equal(TOOL_SPECS.find((t) => t.name === "context.get")!.description, "Read the project, stage, round, objects, materials, questions.");
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const doc = await art(env, "r3", { stage_id: o.stage_id, body_md: BODY });
    set_turns(env, [context_turn(), FINISH]);
    await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal("threads_help" in result_at(env, env.fake.calls.length).context, false);

    await note(env, "r3n", doc.object_id, BODY, "첫째 문장은 정책 배경이다.", "첨언");
    set_turns(env, [context_turn(), FINISH]);
    await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    const help = result_at(env, env.fake.calls.length).context.threads_help;
    assert.equal(typeof help, "string");
    assert.match(help, /thread\.reply/);
    assert.match(help, /thread_id/);
  });
});

function set_turns(env: AEnv, turns: ScriptedTurn[]): void {
  script_fn(env, (n) => turns[n - 1] ?? FINISH);
}

// ---------------------------------------------------------------------------
// R5 — 경계

test("R5 현재 판만 닫힘: 앵커가 놓인 현재 판에 닫힌 파일이 붙으면 원본 판이 열려 있어도 인용문을 가린다", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const quote = "현재판만닫힘-인용-124";
    const body = `머리 ${quote} 꼬리`;
    const doc = await art(env, "cur", { stage_id: o.stage_id, body_md: body });
    const t = await note(env, "cur-n", doc.object_id, body, quote, "현재 판 첨언");
    const v2 = await more(env, "cur-v2", doc.object_id, { body_md: body, current: true });
    const blob = await put_ready(env, new TextEncoder().encode("현재 판 파일"), "cur-file");
    const material = (await env.service.execute(env.ctx("cur-up"), "file.upload", { blob_id: blob.blob_id, title: "현재판파일" })).result as Record<string, any>;
    await ok(env, env.ctx("cur-attach"), "file.attach_version", { version_id: v2, blob_id: blob.blob_id, role: "attachment" });
    await deny(env, material.file_policy_id, "cur-deny");

    const base = script_fn(env, (n) => (n === 1 ? context_turn() : FINISH));
    await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    const row = threads_of(result_at(env, base + 2)).find((r) => r.id === t);
    assert.equal(row.anchor_status, "exact");
    assert.equal(row.quote, null);
    assert.equal(row.quote_withheld, true);
    for (let i = base; i < env.fake.calls.length; i++) assert.equal(wire(env, i).includes(quote), false);
  });
});

test("R5 다른 프로젝트의 첨언은 싣지 않는다", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const doc = await art(env, "mine", { stage_id: o.stage_id, body_md: BODY });
    const mine = await note(env, "mine-n", doc.object_id, BODY, "첫째 문장은 정책 배경이다.", "내 프로젝트 첨언");
    const other = await second_project(env, "sel124-other");
    const other_body = "다른 프로젝트의 비밀 문장-124 이다.";
    const made = (await create_object(env.service, ctx_for(other, "ot-o"), { kind: "artifact", edition_id: other.edition_id })).result as { object_id: string };
    await add_artifact(env.service, ctx_for(other, "ot-v"), { object_id: made.object_id, artifact_kind: "chapter", title: "남의 글", summary: "s", body_md: other_body });
    const foreign = await note(env, "ot-n", made.object_id, other_body, "다른 프로젝트의 비밀 문장-124", "남의 첨언", ctx_for(other, "ot-n"));
    const base = script_fn(env, (n) => (n === 1 ? context_turn() : FINISH));
    await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.deepEqual(threads_of(result_at(env, base + 2)).map((r) => r.id), [mine]);
    for (let i = base; i < env.fake.calls.length; i++) {
      assert.equal(wire(env, i).includes("남의 첨언"), false);
      assert.equal(wire(env, i).includes(foreign), false);
    }
  });
});

test("R5 archived 스레드와 question_comment 스레드는 싣지 않는다", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const doc = await art(env, "ex", { stage_id: o.stage_id, body_md: BODY });
    const keep = await note(env, "ex-a", doc.object_id, BODY, "첫째 문장은 정책 배경이다.", "남는 첨언");
    const archived = await note(env, "ex-b", doc.object_id, BODY, "둘째 문장은 비용 추정이다.", "보관된 첨언");
    const qc = await note(env, "ex-c", doc.object_id, BODY, "셋째 문장은 위험 요인이다.", "질문 의견");
    // 공개 명령이 없는 상태는 합성 DB 행으로 만든다(상태 판정만 본다)
    env.db.run(
      "UPDATE thread_versions SET state = 'archived' WHERE project_id = ? AND version_id = (SELECT current_version_id FROM objects WHERE project_id = ? AND id = ?)",
      env.p.project_id,
      env.p.project_id,
      archived,
    );
    env.db.run("UPDATE threads SET context_kind = 'question_comment' WHERE project_id = ? AND object_id = ?", env.p.project_id, qc);
    const base = script_fn(env, (n) => (n === 1 ? context_turn() : FINISH));
    await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.deepEqual(threads_of(result_at(env, base + 2)).map((r) => r.id), [keep]);
  });
});

test("R5 마지막 메시지가 철회됐으면 그 앞의 공개 메시지를 싣고, 전부 철회면 빈 글이다", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const doc = await art(env, "wd", { stage_id: o.stage_id, body_md: BODY });
    const t = await note(env, "wd-n", doc.object_id, BODY, "첫째 문장은 정책 배경이다.", "처음 공개 메시지");
    await env.service.execute(env.ctx("wd-r"), "thread.reply", { thread_id: t, body_md: "철회될 마지막 메시지" });
    const withdraw = (message_id: string) =>
      env.db.run(
        "UPDATE message_versions SET state = 'withdrawn' WHERE project_id = ? AND version_id = (SELECT current_version_id FROM objects WHERE project_id = ? AND id = ?)",
        env.p.project_id,
        env.p.project_id,
        message_id,
      );
    const msgs = messages_of(env.db, t);
    assert.equal(msgs.length, 2);
    withdraw(msgs[1]!.message_id);
    let base = script_fn(env, (n) => (n === 1 ? context_turn() : FINISH));
    await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    let row = threads_of(result_at(env, base + 2)).find((r) => r.id === t);
    assert.equal(row.last_message.text, "처음 공개 메시지");
    for (let i = base; i < env.fake.calls.length; i++) assert.equal(wire(env, i).includes("철회될 마지막 메시지"), false);

    withdraw(msgs[0]!.message_id);
    base = script_fn(env, (n) => (n === 1 ? context_turn() : FINISH));
    await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    row = threads_of(result_at(env, base + 2)).find((r) => r.id === t);
    assert.equal(row.last_message.text, "");
  });
});

test("R5 앞 목록(객체·참고자료)이 첫 쪽을 다 쓰면 첫 쪽 스레드는 0건이고 threads_offset: 0 으로 이어 읽어 스레드를 얻는다", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env, { subscription_limits: { five_hour_tokens: 1_000_000, weekly_tokens: 10_000_000, monthly_tokens: 40_000_000 } });
    const o = await open_stage(env, "plan");
    const doc = await art(env, "fill-doc", { stage_id: o.stage_id, body_md: BODY });
    const t = await note(env, "fill-n", doc.object_id, BODY, "첫째 문장은 정책 배경이다.", "뒤로 밀린 첨언");
    for (let i = 0; i < 3; i++) await attached(env, `fill-ref-${i}`);
    for (let i = 0; i < 40; i++) await art(env, `fill-${i}`, { stage_id: o.stage_id, title: `채움 문서 ${i} ${"긴 제목 ".repeat(12)}` });
    const pages: any[] = [];
    script_fn(env, (n, b) => {
      if (n === 1) return context_turn();
      const r = last_result(b);
      pages.push(r);
      if (pages.length === 1) return { tools: [{ name: "context.get", args: { threads_offset: r.context.threads_page.next_offset } }] };
      return FINISH;
    });
    await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    const first = pages[0].context;
    assert.equal(first.truncated, true);
    assert.ok(first.omitted.objects > 0, "객체가 첫 쪽을 다 썼다");
    assert.deepEqual(first.threads, []);
    assert.deepEqual(first.threads_page, { offset: 0, returned: 0, total: 1, next_offset: 0 });
    assert.equal(first.omitted.threads, 1);
    assert.match(String(first.next), /threads_offset: 0/);
    assert.equal("threads_help" in first, false, "스레드가 실리지 않은 쪽에는 도움말도 없다");
    const second = pages[1].context;
    assert.deepEqual(threads_of(pages[1]).map((r) => r.id), [t]);
    assert.equal(second.threads_page.next_offset, null);
    assert.equal(typeof second.threads_help, "string");
  });
});

/**
 * SEL-124 — A 내장 실행기가 답글을 달 스레드를 알 수 있게: context.get 에 그 run 이 볼 수 있는 열린 첨언 스레드 목록 (tester, 작성 모드).
 * 근거: SEL-99 최종 리뷰 2/2 권장 1 — 지금은 context.get 에도 시작 메시지에도 스레드 id·첨언 내용이 없어, 실제 모델은 thread.reply 의 thread_id 를 알 길이 없다.
 * 가짜 AI 서버(tests/helpers/a_builtin_env.ts FakeAi)만 쓴다. 실제 모델·네트워크 호출 없음. 합성 데이터만.
 *
 * ===== 정한 인터페이스 (구현은 이 머리말에 맞춘다) =====
 *   도구 목록은 그대로(allowlist 8개, 새 도구 없음). context.get 은 인자 하나가 늘어난다: threads_offset (정수 ≥ 0, 선택).
 *
 *   context.get {} (reference_id·offset 없음) 의 응답 {ok:true, context} 의 context 에 칸이 늘어난다:
 *     context.threads  = [{ id, anchor_status, quote, last_message:{ text }, ... }]   // 칸 이름은 이 네 가지가 필수, 더 있어도 된다
 *        - 대상: 그 run 의 프로젝트에서 **열린(open) 첨언(annotation) 스레드**만. 해결·보관된 스레드는 싣지 않는다.
 *        - id            = 스레드 객체 id (thread.reply 의 thread_id 로 그대로 쓴다).
 *        - anchor_status = 앵커의 지금 상태 'exact' | 'moved' | 'ambiguous' | 'lost' (thread 읽기의 anchor.current.status 와 같다).
 *        - quote         = 앵커가 처음 만들어질 때의 인용문(anchor.exact_quote). 길면 CONTEXT_FIELD_MAX(300)자로 자르고 truncated_fields:['quote'] 로 알린다.
 *        - last_message  = 그 스레드의 마지막 메시지 { text }. text 는 300자 넘으면 자르고 truncated_fields:['last_message'].
 *        - 순서: **마지막 활동(마지막 메시지)이 가장 최근인 스레드가 먼저**. (같은 시각이면 나중에 쓴 메시지 쪽이 먼저 — 쓴 순서 역순.)
 *     context.threads 칸은 열린 스레드가 하나도 없으면 **아예 없다**(참고자료 목록이 없을 때와 같다 — 요청마다 길이를 늘리지 않는다).
 *
 *   권한·AI 참조 금지(SEL-115): 그 스레드의 앵커가 만들어진 글 버전(target_version_id)이나 앵커가 지금 놓인 글 버전이
 *     version_ai_denied(닫힌 파일 자료이거나 닫힌 파일이 붙은 글 버전)이면 그 스레드의 **인용문은 싣지 않는다**:
 *     quote = null 이고 quote_withheld = true. 스레드 id·anchor_status·마지막 메시지(사람이 쓴 첨언 글)는 그대로 싣는다
 *     (그래야 모델이 답글을 달 수 있다). 모델에게 가는 어떤 요청에도 그 인용문 글자가 없어야 한다. 다시 열면(allow) 다시 실린다.
 *
 *   크기 상한: context.get 응답은 기존 CONTEXT_TEXT_MAX(4000자) 안에서 항목 단위로 채운다(JSON 은 절대 잘리지 않는다).
 *     못 담은 스레드는 context.omitted.threads(개수) 로 세고, context.truncated = true,
 *     context.threads_page = { offset, returned, total, next_offset }(next_offset: 다음 쪽 시작 위치 또는 null),
 *     context.next 가 다음에 무엇을 부를지 알려 준다. 다음 쪽은 context.get {threads_offset: next_offset} —
 *     그 응답은 스레드 쪽만 담는다 { threads, threads_page, (잘렸으면 truncated·omitted.threads·next) }.
 *     threads_offset 이 0 이상의 정수가 아니거나 reference_id 와 같이 오면 is_error 거절(references_offset 과 같다).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { TOOL_SPECS, A_TOOL_ALLOWLIST } from "../scripts/pes_core/a_runtime/tools.ts";
import {
  FINISH,
  context_turn,
  open_stage,
  ready_project,
  request_text,
  set_script,
  start_run,
  with_a_env,
  type AEnv,
  type Format,
  type ScriptedTurn,
} from "./helpers/a_builtin_env.ts";
import { put_ready } from "./helpers/blob_env.ts";
import { art, more, ok } from "./helpers/sel119_env.ts";
import { cp_find, messages_of, text_version, text_artifact, thread_row } from "./helpers/sel99_env.ts";

// ---------------------------------------------------------------------------
// 준비물

/** 한 요청 본문(openai 또는 anthropic 모양)에 실린 도구 결과들을 JSON 으로 풀어 순서대로. */
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

/** n 번째(1부터) 모델 요청이 받은 마지막 도구 결과. */
const result_at = (env: AEnv, n: number): any => last_result(env.fake.calls[n - 1]!.json);

function script_fn(env: AEnv, fn: (n: number, body: any) => ScriptedTurn): void {
  const base = env.fake.calls.length;
  env.fake.script = (n: number, rec) => fn(n - base, rec.json);
}

const BODY = ["첫째 문장은 정책 배경이다.", "둘째 문장은 비용 추정이다.", "셋째 문장은 위험 요인이다.", "넷째 문장은 결론이다."].join(" ");

/** 사람(소유자)이 만든 첨언 스레드 하나. */
async function note(env: AEnv, key: string, object_id: string, body: string, quote: string, text: string): Promise<string> {
  const out = (await env.service.execute(env.ctx(key), "annotation.create", { target_object_id: object_id, anchor: { exact_quote: quote, ...cp_find(body, quote) }, body_md: text })).result as { thread_id: string };
  return out.thread_id;
}

const threads_of = (result: any): any[] => {
  assert.ok(Array.isArray(result?.context?.threads), `context.threads is missing: ${JSON.stringify(result).slice(0, 200)}`);
  return result.context.threads;
};

const FORMATS: Format[] = ["openai_compatible", "anthropic"];

// ---------------------------------------------------------------------------
// 인터페이스 모양

test("도구 목록은 그대로(여덟 개)이고 context.get 은 선택 인자 threads_offset(정수)을 더 받는다", () => {
  assert.equal([...A_TOOL_ALLOWLIST].length, 8);
  const spec = TOOL_SPECS.find((t) => t.name === "context.get")!;
  const props = (spec.parameters as any).properties;
  assert.ok(props.reference_id && props.references_offset, "기존 인자는 그대로");
  assert.equal(props.threads_offset?.type, "integer", "threads_offset 정수 인자");
  assert.deepEqual((spec.parameters as any).required ?? [], [], "모두 선택");
});

// ---------------------------------------------------------------------------
// 핵심 흐름: id 를 미리 모르는 모델이 context.get → thread.reply

for (const format of FORMATS) {
  test(`(${format}) 가짜 모델은 id 를 모른다: context.get 으로 열린 스레드 목록을 받고, 거기서 얻은 id 로 thread.reply 해 진짜 답글이 달린다`, async () => {
    await with_a_env(format, async (env) => {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      const doc = await art(env, "d1", { stage_id: o.stage_id, body_md: BODY, title: "문서-1" });
      const t1 = await note(env, "n1", doc.object_id, BODY, "둘째 문장은 비용 추정이다.", "비용 근거를 더 설명해 주세요.");
      const t2 = await note(env, "n2", doc.object_id, BODY, "넷째 문장은 결론이다.", "결론이 약합니다.");

      let seen: any[] = [];
      script_fn(env, (n, body) => {
        if (n === 1) return context_turn();
        if (n === 2) {
          // 이 시점에 모델이 아는 것은 첫 context.get 결과뿐이다 — id 는 거기서만 얻는다.
          seen = threads_of(last_result(body));
          const target = seen.find((t) => t.last_message.text.includes("결론이 약합니다"));
          assert.ok(target, "모델이 받은 목록에 결론 스레드가 있다");
          return { tools: [{ name: "thread.reply", args: { thread_id: target.id, text: "결론을 보강하겠습니다." } }] };
        }
        return FINISH;
      });
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(res.status, "succeeded", JSON.stringify(res));

      assert.equal(seen.length, 2);
      for (const row of seen) {
        for (const key of ["id", "anchor_status", "quote", "last_message"]) assert.ok(key in row, `row.${key}`);
        assert.equal(typeof row.id, "string");
        assert.equal(typeof row.last_message.text, "string");
      }
      assert.deepEqual(new Set(seen.map((t) => t.id)), new Set([t1, t2]));
      const r1 = seen.find((t) => t.id === t1);
      assert.equal(r1.quote, "둘째 문장은 비용 추정이다.");
      assert.equal(r1.anchor_status, "exact");
      assert.equal(r1.last_message.text, "비용 근거를 더 설명해 주세요.");

      // 답글이 진짜로 달렸다(결론 스레드에만, AI 행위자, 스레드는 열린 채).
      const msgs = messages_of(env.db, t2);
      assert.equal(msgs.length, 2);
      assert.equal(msgs[1]!.body_md, "결론을 보강하겠습니다.");
      assert.equal(msgs[1]!.actor_id, env.ai_actor_id);
      assert.equal(messages_of(env.db, t1).length, 1, "다른 스레드는 그대로");
      assert.equal(thread_row(env.db, t2).state, "open");
    });
  });
}

// ---------------------------------------------------------------------------
// 앵커 상태 · 대상 · 순서

test("anchor_status 는 앵커의 지금 상태다: exact · moved · lost 가 각각 맞게 실린다(인용문은 처음 것 그대로)", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const exact_doc = await text_artifact(env, "ex", BODY);
    const moved_doc = await text_artifact(env, "mv", BODY);
    const lost_doc = await text_artifact(env, "ls", BODY);
    const te = await note(env, "ne", exact_doc.object_id, BODY, "첫째 문장은 정책 배경이다.", "정확");
    const tm = await note(env, "nm", moved_doc.object_id, BODY, "둘째 문장은 비용 추정이다.", "이동");
    const tl = await note(env, "nl", lost_doc.object_id, BODY, "셋째 문장은 위험 요인이다.", "사라짐");
    await text_version(env, "mv2", moved_doc.object_id, `새로 덧붙인 머리 문단이다.\n\n${BODY}`);
    await text_version(env, "ls2", lost_doc.object_id, "전혀 다른 글이다. 앞의 문장은 어디에도 없다.");

    set_script(env, [context_turn(), FINISH]);
    assert.equal((await start_run(env, { stage_id: o.stage_id, round_id: o.round_id })).status, "succeeded");
    const rows = threads_of(result_at(env, 2));
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(by[te].anchor_status, "exact");
    assert.equal(by[tm].anchor_status, "moved");
    assert.equal(by[tl].anchor_status, "lost");
    assert.equal(by[tl].quote, "셋째 문장은 위험 요인이다.", "lost 여도 처음 인용문은 남는다(닫힌 글이 아닐 때)");
    assert.equal(by[tm].quote, "둘째 문장은 비용 추정이다.");
  });
});

test("열린 스레드만 싣는다: 해결한 스레드는 빠지고, 마지막 활동이 가장 최근인 스레드가 먼저 온다(답글이 달리면 앞으로 올라온다)", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const doc = await art(env, "ord", { stage_id: o.stage_id, body_md: BODY });
    const a = await note(env, "oa", doc.object_id, BODY, "첫째 문장은 정책 배경이다.", "A 첨언");
    const b = await note(env, "ob", doc.object_id, BODY, "둘째 문장은 비용 추정이다.", "B 첨언");
    const c = await note(env, "oc", doc.object_id, BODY, "셋째 문장은 위험 요인이다.", "C 첨언");
    await env.service.execute(env.ctx("close-b"), "thread.resolve", { thread_id: b, resolution: "none", reason: "닫았다." });

    set_script(env, [context_turn(), FINISH]);
    await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.deepEqual(threads_of(result_at(env, 2)).map((t) => t.id), [c, a], "b 는 해결돼 빠지고, 늦게 쓴 c 가 먼저");

    // 사람이 a 에 새 메시지를 쓰면 a 가 맨 앞이고 last_message 도 그 글이다.
    await env.service.execute(env.ctx("reply-a"), "thread.reply", { thread_id: a, body_md: "A 에 새 메시지" });
    const mark = env.fake.calls.length;
    env.fake.script = (n: number) => (n === mark + 1 ? context_turn() : FINISH);
    await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    const again = threads_of(result_at(env, mark + 2));
    assert.deepEqual(again.map((t) => t.id), [a, c]);
    assert.equal(again[0].last_message.text, "A 에 새 메시지");
  });
});

test("열린 스레드가 하나도 없으면 context.threads 칸이 없다(요청 길이를 늘리지 않는다)", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    await art(env, "none", { stage_id: o.stage_id, body_md: BODY });
    set_script(env, [context_turn(), FINISH]);
    await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    const result = result_at(env, 2);
    assert.equal(result.ok, true);
    assert.equal("threads" in result.context, false);
    assert.equal("threads_page" in result.context, false);
  });
});

// ---------------------------------------------------------------------------
// AI 참조 금지

const SECRET_QUOTE = "비밀문장-앵커-124a";
const OPEN_QUOTE = "공개문장-앵커-124b";

async function closed_scene(env: AEnv, o: { stage_id: string }) {
  const BODY1 = `앞글 ${SECRET_QUOTE} 뒷글`;
  const doc = await art(env, "cl-doc", { stage_id: o.stage_id, body_md: BODY1, title: "닫힐 문서" });
  const blob = await put_ready(env, new TextEncoder().encode("비공개 파일 본문-124"), "cl-file");
  const material = (await env.service.execute(env.ctx("cl-up"), "file.upload", { blob_id: blob.blob_id, title: "비공개파일-124" })).result as Record<string, any>;
  await ok(env, env.ctx("cl-attach"), "file.attach_version", { version_id: doc.version_id, blob_id: blob.blob_id, role: "attachment" });
  const closed_thread = await note(env, "cl-note", doc.object_id, BODY1, SECRET_QUOTE, "닫힌 글에 단 첨언입니다.");
  // 현재 버전은 닫힌 파일이 없다. 앵커는 닫힌 첫 버전에서 만들어졌고 지금은 lost 다.
  await more(env, "cl-v2", doc.object_id, { title: "닫힐 문서", body_md: "전혀 다른 공개 글이다.", current: true });
  // 대조군: 열린 글의 스레드
  const BODY2 = `앞글 ${OPEN_QUOTE} 뒷글`;
  const open_doc = await art(env, "op-doc", { stage_id: o.stage_id, body_md: BODY2, title: "열린 문서" });
  const open_thread = await note(env, "op-note", open_doc.object_id, BODY2, OPEN_QUOTE, "열린 글에 단 첨언입니다.");
  return { closed_thread, open_thread, file_policy_id: material.file_policy_id as string };
}

test("닫힌 글 버전의 앵커 인용문은 싣지 않는다(스레드 id·상태·마지막 메시지는 싣고 답글도 달린다); 열린 글은 그대로; 다시 열면 실린다", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const s = await closed_scene(env, o);
    await env.service.execute(env.ctx("cl-deny"), "file.ai_access_set", { file_policy_id: s.file_policy_id, ai_access: "deny" });

    const mark = env.fake.calls.length;
    script_fn(env, (n, body) => {
      if (n === 1) return context_turn();
      if (n === 2) {
        const row = threads_of(last_result(body)).find((t) => t.id === s.closed_thread);
        assert.ok(row, "닫힌 글의 스레드도 id 로는 보인다");
        return { tools: [{ name: "thread.reply", args: { thread_id: row.id, text: "닫힌 글의 첨언에 답합니다." } }] };
      }
      return FINISH;
    });
    assert.equal((await start_run(env, { stage_id: o.stage_id, round_id: o.round_id })).status, "succeeded");
    const sent = env.fake.calls.slice(mark).map((c) => c.json);
    assert.ok(sent.length >= 3);
    const wire = sent.map((b) => request_text(b)).join("\n") + JSON.stringify(sent);
    assert.ok(!wire.includes(SECRET_QUOTE), "닫힌 글의 인용문 글자가 모델 요청 어디에도 없다");
    assert.ok(wire.includes(OPEN_QUOTE), "열린 글의 인용문은 실린다");

    const rows = threads_of(last_result(sent[1]));
    const closed = rows.find((t) => t.id === s.closed_thread);
    assert.equal(closed.quote, null);
    assert.equal(closed.quote_withheld, true);
    assert.equal(closed.anchor_status, "lost");
    assert.equal(closed.last_message.text, "닫힌 글에 단 첨언입니다.");
    const open = rows.find((t) => t.id === s.open_thread);
    assert.equal(open.quote, OPEN_QUOTE);
    assert.notEqual(open.quote_withheld, true);
    assert.equal(messages_of(env.db, s.closed_thread).length, 2, "닫힌 글의 스레드에도 AI 답글이 달린다");

    // 다시 열면 다시 실린다.
    await env.service.execute(env.ctx("cl-allow"), "file.ai_access_set", { file_policy_id: s.file_policy_id, ai_access: "allow" });
    const mark2 = env.fake.calls.length;
    env.fake.script = (n: number) => (n === mark2 + 1 ? context_turn() : FINISH);
    await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    const reopened = threads_of(result_at(env, mark2 + 2)).find((t) => t.id === s.closed_thread);
    assert.equal(reopened.quote, SECRET_QUOTE);
    assert.notEqual(reopened.quote_withheld, true);
  });
});

// ---------------------------------------------------------------------------
// 크기 상한 · 잘림 표시

test("스레드가 많아 4000자를 넘으면 항목 단위로 자르고 잘림을 알린다 — JSON 은 온전하고, threads_offset 으로 이어 읽어 전부 얻은 id 로 답글을 단다", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env, { subscription_limits: { five_hour_tokens: 1_000_000, weekly_tokens: 10_000_000, monthly_tokens: 40_000_000 } });
    const o = await open_stage(env, "plan");
    const sentences = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(2, "0")}번째 검토 문장이다.`);
    const body = sentences.join(" ");
    const doc = await art(env, "many", { stage_id: o.stage_id, body_md: body });
    const ids: string[] = [];
    for (let i = 0; i < sentences.length; i++) ids.push(await note(env, `m${i}`, doc.object_id, body, sentences[i]!, `${i}번 첨언: ${"자세한 설명 ".repeat(8)}`));
    const newest_first = [...ids].reverse();

    const pages: any[] = [];
    let replied: string | null = null;
    script_fn(env, (n, body_json) => {
      if (n === 1) return context_turn();
      if (replied !== null) return FINISH;
      const result = last_result(body_json);
      pages.push(result);
      threads_of(result);
      const page = result.context.threads_page;
      assert.ok(page, "context.threads_page is missing");
      if (page.next_offset !== null) return { tools: [{ name: "context.get", args: { threads_offset: page.next_offset } }] };
      // 마지막 쪽에서 얻은 id 에 답글: 처음 목록에는 없던 스레드다.
      replied = threads_of(result).at(-1).id;
      return { tools: [{ name: "thread.reply", args: { thread_id: replied, text: "뒷쪽 스레드에 답합니다." } }] };
    });
    assert.equal((await start_run(env, { stage_id: o.stage_id, round_id: o.round_id })).status, "succeeded");

    assert.ok(pages.length >= 2, "한 번에 다 담기지 않아 쪽이 나뉜다");
    const first = pages[0].context;
    assert.equal(first.truncated, true);
    assert.ok(first.omitted.threads > 0);
    assert.ok(first.threads.length > 0 && first.threads.length < 30);
    assert.equal(first.threads_page.offset, 0);
    assert.equal(first.threads_page.total, 30);
    assert.equal(first.threads_page.returned, first.threads.length);
    assert.equal(first.threads_page.next_offset, first.threads.length);
    assert.equal(first.omitted.threads, 30 - first.threads.length);
    assert.match(String(first.next), /threads_offset/);
    // 첫 쪽의 기존 칸(주제·단계·객체)은 그대로 있고, 응답 한 번은 4000자를 넘지 않는다.
    assert.equal(first.stage, "plan");
    assert.ok(Array.isArray(first.objects));
    for (const raw of env.fake.calls.slice(1).map((c) => tool_results(c.json))) for (const r of raw) assert.ok(JSON.stringify(r).length <= 4000, "한 응답은 4000자 이하");

    // 다음 쪽들은 스레드 쪽만 담고, 이어 붙이면 전부가 중복 없이 최신순으로 나온다.
    const all: string[] = [];
    pages.forEach((p, i) => {
      if (i > 0) assert.equal(p.context.threads_page.offset, all.length, "쪽은 이어진다");
      all.push(...p.context.threads.map((t: any) => t.id));
    });
    assert.deepEqual(all, newest_first);
    const lastp = pages.at(-1).context;
    assert.equal(lastp.threads_page.next_offset, null);
    assert.equal(lastp.truncated ?? false, false, "마지막 쪽은 더 잘린 것이 없다");

    assert.ok(replied !== null && messages_of(env.db, replied).length === 2, "다음 쪽에서 얻은 id 로 진짜 답글이 달렸다");
    assert.equal(messages_of(env.db, replied).at(-1)!.body_md, "뒷쪽 스레드에 답합니다.");
  });
});

test("긴 인용문·긴 마지막 메시지는 300자로 자르고 어느 칸을 잘랐는지 truncated_fields 로 알린다(JSON 은 온전)", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const long_quote = `긴인용${"가나다라마바사 ".repeat(80)}끝`; // 300자 훨씬 넘음
    const long_body = `${long_quote} 그리고 짧은 문장이다.`;
    const doc = await art(env, "long", { stage_id: o.stage_id, body_md: long_body });
    const t = await note(env, "lg", doc.object_id, long_body, long_quote, `긴메시지${"나다라마바사아 ".repeat(100)}끝`);
    set_script(env, [context_turn(), FINISH]);
    assert.equal((await start_run(env, { stage_id: o.stage_id, round_id: o.round_id })).status, "succeeded");
    const row = threads_of(result_at(env, 2)).find((r) => r.id === t);
    assert.ok(row, "긴 글이어도 스레드 id 는 실린다");
    assert.ok(row.quote.length <= 300 && long_quote.startsWith(row.quote));
    assert.ok(row.last_message.text.length <= 300);
    assert.ok((row.truncated_fields as string[]).includes("quote"));
    assert.ok((row.truncated_fields as string[]).includes("last_message"));
  });
});

// ---------------------------------------------------------------------------
// 인자 검증

test("threads_offset 은 0 이상의 정수여야 하고 reference_id 와 같이 올 수 없다 — 오류 결과로 돌려주고 run 은 계속된다", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const doc = await art(env, "arg", { stage_id: o.stage_id, body_md: BODY });
    await note(env, "ag", doc.object_id, BODY, "첫째 문장은 정책 배경이다.", "첨언");
    const bad: unknown[] = [-1, 1.5, "2", null];
    set_script(env, [
      ...bad.map((v) => ({ tools: [{ name: "context.get", args: { threads_offset: v } }] }) as ScriptedTurn),
      { tools: [{ name: "context.get", args: { threads_offset: 0, reference_id: "ref-x" } }] },
      { tools: [{ name: "context.get", args: { threads_offset: 99 } }] },
      FINISH,
    ]);
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "succeeded", JSON.stringify(res));
    for (let i = 0; i < bad.length + 1; i++) {
      const r = result_at(env, i + 2);
      assert.equal(r.ok, false, `거절 ${i}`);
      assert.equal(typeof r.error, "string");
    }
    // 끝을 넘는 위치는 오류가 아니라 빈 쪽이다.
    const past = result_at(env, bad.length + 3);
    assert.equal(past.ok, true);
    assert.deepEqual(past.context.threads ?? [], []);
    assert.equal(past.context.threads_page.total, 1);
    assert.equal(past.context.threads_page.next_offset, null);
  });
});

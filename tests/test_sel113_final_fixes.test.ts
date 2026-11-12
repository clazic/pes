/**
 * SEL-113 REF1a — 최종 리뷰(F1) 필수 2건 수정 시험. 합성 데이터만, 실제 모델·네트워크 호출 없음(로컬 fake AI 만).
 *
 *  F1-1  A 실행기는 읽은 참고자료 본문을 turns 에 보관해 다음 요청에 다시 싣는다. 읽은 뒤(키 읽기 같은 비동기 사이) 원본 Go OFF·
 *        원본 접근 철회가 일어나면, 매 모델 요청 직전에 같은 판정(decide)으로 다시 보고 그 도구 결과를 보내지 않는다
 *        (대체 문구: 회수됨·이유). 이미 보낸 결과도, 그 뒤 모델이 쓴 글(파생)도 이후 요청에 다시 싣지 않는다.
 *        재현: 리뷰의 합성 재현 그대로 — env.keys.get 을 감싸 둘째 요청용 키를 읽는 동안 철회한다.
 *  F1-2  인자 없는 context.get 의 references 목록이 기존 4000자 문자열 clip 을 타서 JSON 이 깨진 채 성공으로 가던 것 —
 *        목록도 객체 단위 JSON 예산(objects·questions 와 합친 전체 응답)으로 만들고, 넘치면 truncated·omitted·다음 쪽
 *        읽는 법(references_offset)을 밝힌다. 성공 JSON 은 어디서도 중간에서 잘리지 않는다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { add_artifact, create_object } from "../scripts/pes_core/content.ts";
import { FINISH, context_turn, open_stage, ready_project, start_run, with_a_env, type AEnv, type ScriptedTurn } from "./helpers/a_builtin_env.ts";
import { attached, revoke_access, source_go, type Source } from "./helpers/sel113_env.ts";

/** the whole outbound request as text */
const request_text = (env: AEnv, index: number): string => JSON.stringify(env.fake.calls[index]!.json);

function script_fn(env: AEnv, fn: (n: number) => ScriptedTurn): number {
  const base = env.fake.calls.length;
  env.fake.script = (n: number) => fn(n - base);
  return base;
}

function tool_messages(env: AEnv, request_index: number): string[] {
  const body = env.fake.calls[request_index]!.json as any;
  return (body.messages as any[]).filter((m) => m.role === "tool").map((m) => m.content as string);
}

const reference_turn = (reference_id: string, text?: string): ScriptedTurn => ({
  tools: [{ name: "context.get", args: { reference_id } }],
  ...(text === undefined ? {} : { text }),
});

type Revoke = "go_off" | "access";

async function revoke(env: AEnv, src: Source, how: Revoke, key: string): Promise<void> {
  if (how === "go_off") await source_go(env, src, false, key);
  else revoke_access(env, src);
}

const REASON: Record<Revoke, string> = { go_off: "source_go_off", access: "no_permission" };

// ---------------------------------------------------------------------------
// F1-1 — withdrawn between the read and the first delivery

for (const how of ["go_off", "access"] as Revoke[]) {
  test(`F1-1 (${how}): revoked while the key for the next request is read — the read text is never sent; the tool result says withdrawn with the reason`, async () => {
    await with_a_env("openai_compatible", async (env) => {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      const { src, ref } = await attached(env, `f11-${how}`);
      const base = script_fn(env, (n) => (n === 1 ? reference_turn(ref.reference_id) : FINISH));
      // the reviewer's reproduction: after the first reply and the tool read, revoke while the second key is read
      const original = env.keys.get.bind(env.keys);
      let revoked = false;
      (env.keys as any).get = async (k: string) => {
        if (!revoked && env.fake.calls.length - base === 1) {
          revoked = true;
          await revoke(env, src, how, `f11-${how}-revoke`);
        }
        return original(k);
      };
      const result = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(revoked, true, "the revocation happened between the two requests");
      assert.equal(env.fake.calls.length - base, 2, JSON.stringify(result));
      const first = request_text(env, base);
      const second = request_text(env, base + 1);
      assert.equal(first.includes(src.report_marker), false);
      assert.equal(second.includes(src.report_marker), false, "the report text is not sent after the revocation");
      assert.equal(second.includes(src.source_marker), false, "nor the source text");
      const tools = tool_messages(env, base + 1);
      const back = JSON.parse(tools[tools.length - 1]!);
      assert.equal(back.ok, false);
      assert.equal(back.withdrawn, true);
      assert.equal(back.reference_id, ref.reference_id);
      assert.equal(back.reason, REASON[how]);
      assert.equal(result.status, "succeeded", JSON.stringify(result));
    });
  });
}

// ---------------------------------------------------------------------------
// F1-1 — already sent once: not sent again, and neither is what the model wrote after reading it

for (const how of ["go_off", "access"] as Revoke[]) {
  test(`F1-1 (${how}): revoked after the text was sent — later requests carry neither the first read nor the model's text written from it`, async () => {
    await with_a_env("openai_compatible", async (env) => {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      const { src, ref } = await attached(env, `f12-${how}`);
      const base = script_fn(env, (n) =>
        n === 1 ? reference_turn(ref.reference_id) : n === 2 ? reference_turn(ref.reference_id, `읽은 내용: ${src.report_marker}`) : FINISH,
      );
      env.fake.on_call = async (n) => {
        if (n - base === 2) await revoke(env, src, how, `f12-${how}-revoke`);
      };
      const result = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(env.fake.calls.length - base, 3, JSON.stringify(result));
      assert.ok(request_text(env, base + 1).includes(src.report_marker), "the text did go out once (before the revocation)");
      const third = request_text(env, base + 2);
      assert.equal(third.includes(src.report_marker), false, "not sent again, not even inside the model's own later text");
      assert.equal(third.includes(src.source_marker), false);
      const tools = tool_messages(env, base + 2).map((t) => JSON.parse(t));
      assert.equal(tools.length, 2, "both reads are still answered (the pairing of calls and results holds)");
      assert.ok(tools[1].ok === false || tools[1].content === null, "the new read after the revocation gets no content (decide)");
      assert.equal(tools[0].ok, false);
      assert.equal(tools[0].reference_id, ref.reference_id);
      assert.equal(tools[0].withdrawn, true, "the first read is withdrawn");
      assert.equal(tools[0].reason, REASON[how]);
      assert.equal(result.status, "succeeded", JSON.stringify(result));
    });
  });
}

test("F1-1: nothing withdrawn while access and Go stay on — the read text is carried to the next request as before", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const { src, ref } = await attached(env, "f13");
    const base = script_fn(env, (n) => (n === 1 ? reference_turn(ref.reference_id) : n === 2 ? context_turn() : FINISH));
    const result = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.ok(request_text(env, base + 1).includes(src.report_marker));
    assert.ok(request_text(env, base + 2).includes(src.report_marker), "still allowed: kept in the history");
  });
});

// ---------------------------------------------------------------------------
// F1-2 — the list in context.get is built object by object inside the budget

const CONTEXT_LIMIT = 4_000;

function last_tool(env: AEnv, request_index: number): string {
  const tools = tool_messages(env, request_index);
  assert.ok(tools.length > 0);
  return tools[tools.length - 1]!;
}

test("F1-2: eight references — the context reply is whole JSON within the budget, says what was left out and how to read the next page; paging reaches every reference", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env, { subscription_limits: { five_hour_tokens: 1_000_000, weekly_tokens: 10_000_000, monthly_tokens: 40_000_000 } });
    const o = await open_stage(env, "plan");
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) ids.push((await attached(env, `integrated-list-${i}`)).ref.reference_id as string);
    const seen: string[] = [];
    let next: number | null = null;
    const base = script_fn(env, (n) => {
      if (n === 1) return context_turn();
      if (next !== null) return { tools: [{ name: "context.get", args: { references_offset: next } }] };
      return FINISH;
    });
    // the next offset is read from the reply the model just got (the fake model pages on until next_offset is null)
    env.fake.on_call = async (n) => {
      const k = n - base;
      if (k < 2) return;
      try {
        next = JSON.parse(last_tool(env, base + k - 1)).context.references_page.next_offset;
      } catch {
        next = null;
      }
    };
    const result = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id, max_turns: 20 });
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    const requests = env.fake.calls.length - base;
    assert.ok(requests >= 3, "the list took more than one page");
    for (let k = 1; k < requests; k += 1) {
      const text = last_tool(env, base + k);
      assert.ok(text.length <= CONTEXT_LIMIT, `reply ${k} is within the budget (${text.length})`);
      const back = JSON.parse(text); // must not throw
      assert.equal(back.ok, true);
      const page = back.context.references_page;
      assert.equal(page.total, 8);
      assert.equal(page.offset, seen.length);
      assert.equal(page.returned, back.context.references.length);
      assert.ok(page.returned > 0, "every page makes progress");
      for (const row of back.context.references) seen.push(row.id);
      if (page.next_offset !== null) {
        assert.equal(page.next_offset, seen.length);
        assert.equal(back.context.truncated, true);
        assert.equal(back.context.omitted.references, 8 - seen.length);
        assert.match(back.context.next, /references_offset/);
      }
    }
    assert.deepEqual(seen, ids, "every reference once, in order");
  });
});

test("F1-2: a large current context (25 long objects, long labels) — still whole JSON within the budget; objects and references left out are counted", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env, { subscription_limits: { five_hour_tokens: 1_000_000, weekly_tokens: 10_000_000, monthly_tokens: 40_000_000 } });
    const o = await open_stage(env, "plan");
    for (let i = 0; i < 25; i += 1) {
      const obj = (await create_object(env.service, env.ctx(`big-o-${i}`), { kind: "artifact", edition_id: env.p.edition_id })).result as { object_id: string };
      await add_artifact(env.service, env.ctx(`big-v-${i}`), { object_id: obj.object_id, artifact_kind: "chapter", title: `긴 장 ${i} ${"제".repeat(150)}`, summary: "요".repeat(400) });
    }
    for (let i = 0; i < 3; i += 1) await attached(env, `long-label-${i}`, { source_label: `${"이름".repeat(100)}` });
    const base = script_fn(env, (n) => (n === 1 ? context_turn() : FINISH));
    const result = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    const text = last_tool(env, base + 1);
    assert.ok(text.length <= CONTEXT_LIMIT, `within the budget (${text.length})`);
    const back = JSON.parse(text);
    assert.equal(back.ok, true);
    assert.equal(back.context.truncated, true);
    assert.ok(back.context.omitted.objects > 0, "objects that did not fit are counted");
    assert.equal(back.context.objects.length + back.context.omitted.objects, 26, "every object is given or counted");
    assert.equal(back.context.references_page.total, 3);
    assert.equal(back.context.references.length + back.context.omitted.references, 3);
  });
});

test("F1-2: references_offset with reference_id is refused; a bad offset is refused", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const { ref } = await attached(env, "f2bad");
    const base = script_fn(env, (n) =>
      n === 1
        ? { tools: [{ name: "context.get", args: { reference_id: ref.reference_id, references_offset: 0 } }, { name: "context.get", args: { references_offset: -1 } }] }
        : FINISH,
    );
    const result = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    const tools = tool_messages(env, base + 1).map((t) => JSON.parse(t));
    assert.equal(tools.length, 2);
    for (const t of tools) assert.equal(t.ok, false);
  });
});

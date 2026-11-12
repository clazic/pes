/**
 * SEL-113 REF1a — 최종 리뷰(F1) 필수 2건 수정 시험. 합성 데이터만, 실제 모델·네트워크 호출 없음(로컬 fake AI 만).
 *
 *  F1-1  A 실행기는 읽은 참고자료 본문을 turns 에 보관해 다음 요청에 다시 싣는다. 읽은 뒤(키 읽기 같은 비동기 사이) 원본 Go OFF·
 *        원본 접근 철회가 일어나면, 매 모델 요청 직전에 같은 판정(decide)으로 다시 보고 그 요청을 보내지 않는다 — run 은
 *        interrupted·이유 reference_withdrawn 으로 멈춘다(F2 사용자 결정: 지우기 대신 멈춤). 이미 보낸 결과도, 그 뒤 모델이
 *        쓴 글(파생)도 다시 나가지 않는다. 재현: 리뷰의 합성 재현 그대로 — env.keys.get 을 감싸 둘째 요청용 키를 읽는 동안 철회한다.
 *  F1-2  인자 없는 context.get 의 references 목록이 기존 4000자 문자열 clip 을 타서 JSON 이 깨진 채 성공으로 가던 것 —
 *        목록도 객체 단위 JSON 예산(objects·questions 와 합친 전체 응답)으로 만들고, 넘치면 truncated·omitted·다음 쪽
 *        읽는 법(references_offset)을 밝힌다. 성공 JSON 은 어디서도 중간에서 잘리지 않는다.
 *  M-99  origin/main(SEL-99 U4a) 합치기 뒤 새 출구 점검: thread.reply·followup.propose(A)의 인자도 철회 뒤 다시 실리지 않고(run 이 멈춘다),
 *        참고자료 원본의 글(다른 프로젝트 객체)은 첨언 대상이 될 수 없다(스레드·후속 읽기는 현재 프로젝트 객체만 본다).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { add_artifact, create_object } from "../scripts/pes_core/content.ts";
import { FINISH, context_turn, open_stage, ready_project, start_run, with_a_env, type AEnv, type ScriptedTurn } from "./helpers/a_builtin_env.ts";
import { rejects_api } from "./helpers/blob_env.ts";
import { recheck_reference } from "../scripts/pes_core/a_runtime/tools.ts";
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

/** the reason the same decide() gives now for this run's actor (the run stopped on it) */
function recheck_reason(env: AEnv, reference_id: string): string | null {
  const run = env.db.get<{ id: string; actor_id: string }>("SELECT id, actor_id FROM runs WHERE project_id = ? ORDER BY rowid DESC LIMIT 1", env.p.project_id)!;
  return recheck_reference(env.db, { project_id: env.p.project_id, actor_id: run.actor_id } as any, reference_id);
}

// ---------------------------------------------------------------------------
// F1-1 — withdrawn between the read and the first delivery

for (const how of ["go_off", "access"] as Revoke[]) {
  test(`F1-1 (${how}): revoked while the key for the next request is read — the read text is never sent; the run stops with reference_withdrawn`, async () => {
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
      assert.equal(env.fake.calls.length - base, 1, `the second request is not sent: ${JSON.stringify(result)}`);
      const first = request_text(env, base);
      assert.equal(first.includes(src.report_marker), false, "the report text is never sent");
      assert.equal(first.includes(src.source_marker), false, "nor the source text");
      assert.equal(result.status, "interrupted", JSON.stringify(result));
      assert.equal(result.interrupt_reason, "reference_withdrawn");
      assert.equal(recheck_reason(env, ref.reference_id), REASON[how], "the reason decide() gives now");
    });
  });
}

// ---------------------------------------------------------------------------
// F1-1 — already sent once: not sent again, and neither is what the model wrote after reading it

for (const how of ["go_off", "access"] as Revoke[]) {
  test(`F1-1 (${how}): revoked after the text was sent — no later request goes (neither the first read nor the model's text written from it); the run stops`, async () => {
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
      assert.equal(env.fake.calls.length - base, 2, `no third request: ${JSON.stringify(result)}`);
      assert.ok(request_text(env, base + 1).includes(src.report_marker), "the text did go out once (before the revocation)");
      assert.equal(result.status, "interrupted", JSON.stringify(result));
      assert.equal(result.interrupt_reason, "reference_withdrawn");
      assert.equal(recheck_reason(env, ref.reference_id), REASON[how]);
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

// ---------------------------------------------------------------------------
// M-99 — SEL-99 exits after the merge

test("M-99: thread.reply and followup.propose written after a withdrawn reference read are not sent again (their arguments are cleared)", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const { src, ref } = await attached(env, "m99a");
    const base = script_fn(env, (n) =>
      n === 1
        ? reference_turn(ref.reference_id)
        : n === 2
          ? {
              tools: [
                { name: "thread.reply", args: { thread_id: "thr-none", text: `답글: ${src.report_marker}` } },
                { name: "followup.propose", args: { text: `후속: ${src.report_marker}` } },
              ],
            }
          : FINISH,
    );
    env.fake.on_call = async (n) => {
      if (n - base === 2) await source_go(env, src, false, "m99a-revoke");
    };
    const result = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(env.fake.calls.length - base, 2, `no third request: neither the read nor the reply/follow-up arguments derived from it go out again: ${JSON.stringify(result)}`);
    assert.equal(result.status, "interrupted", JSON.stringify(result));
    assert.equal(result.interrupt_reason, "reference_withdrawn");
  });
});

test("M-99: a text of the referenced project cannot be annotated from this project; the refusal carries none of its content", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const { src } = await attached(env, "m99b");
    const error = await rejects_api(
      env.service.execute(env.ctx("m99b-ann"), "annotation.create", {
        target_object_id: src.report.object_id,
        target_version_id: src.report.version_id,
        anchor: { exact_quote: src.report_marker },
        body_md: "원본 글에 첨언",
      }),
      "not_found",
      "validation_failed",
    );
    assert.equal(JSON.stringify({ message: error.message, details: (error as any).details }).includes(`${src.report_marker} 본문`), false);
    const threads = env.db.all<{ n: bigint }>("SELECT count(*) AS n FROM anchors WHERE target_object_id = ?", src.report.object_id);
    assert.equal(Number(threads[0]!.n), 0, "no anchor points at the other project's text");
  });
});

// ---------------------------------------------------------------------------
// F2 — the last boundary before the HTTP call, and the run stops on a withdrawal (사용자 결정: 지우기 대신 멈춤)
//
//  F2-1  재판정 뒤 heartbeat·dispatch.authorize 의 await 사이에 원본 Go OFF·원본 접근 철회 → 아직 안 보낸 본문이 처음 나가던 것.
//        리뷰의 합성 재현 그대로: env.service.execute 를 감싸 원래 명령이 끝난 다음(둘째 요청의 heartbeat 또는 authorize 가
//        반환되기 전) 철회한다. 이제 그 요청은 나가지 않고(HTTP 1회), 그 dispatch 는 blocked(보낸 적 없음), run 은
//        interrupted·이유 reference_withdrawn 이다.
//  F2-2  도구 검증 오류(invalid_payload: unknown field: <본문 문구>)가 모델이 보낸 참고 문구를 되돌려 회수에서 빠지던 것.
//        리뷰의 합성 재현 그대로: 셋째 요청용 env.keys.get 안에서 철회한다. 이제 셋째 요청은 나가지 않는다.

/** what the run left in the DB: its status, the reason on its last run.interrupted event, and its dispatches' states */
function stopped_state(env: AEnv, run_id: string): { status: string; reason: string | null; dispatches: string[] } {
  const run = env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", run_id)!;
  const event = env.db.get<{ payload: string }>(
    "SELECT payload FROM events WHERE run_id = ? AND type = 'run.interrupted' ORDER BY event_seq DESC LIMIT 1",
    run_id,
  );
  const dispatches = env.db
    .all<{ state: string }>("SELECT state FROM outbound_dispatches WHERE run_id = ? ORDER BY rowid", run_id)
    .map((d) => d.state);
  return { status: run.status, reason: event === undefined ? null : (JSON.parse(event.payload).reason ?? null), dispatches };
}

for (const [point, how] of [
  ["run.heartbeat", "go_off"],
  ["dispatch.authorize", "go_off"],
  ["dispatch.authorize", "access"],
] as Array<[string, Revoke]>) {
  test(`F2-1 (${point}, ${how}): revoked after the recheck while ${point} is awaited — the request is not sent, the dispatch is blocked, the run stops with reference_withdrawn`, async () => {
    await with_a_env("openai_compatible", async (env) => {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      const { src, ref } = await attached(env, `f21-${point}-${how}`);
      const base = script_fn(env, (n) => (n === 1 ? reference_turn(ref.reference_id) : FINISH));
      // the reviewer's reproduction: after the original command has run, before it returns to the runner
      const execute = env.service.execute.bind(env.service);
      let revoked = false;
      (env.service as any).execute = async (ctx: any, command: string, payload: unknown) => {
        const out = await execute(ctx, command, payload);
        if (!revoked && command === point && env.fake.calls.length - base === 1) {
          revoked = true;
          await revoke(env, src, how, `f21-${point}-${how}-revoke`);
        }
        return out;
      };
      const result = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(revoked, true, "the revocation happened between the recheck and the send");
      assert.equal(env.fake.calls.length - base, 1, `the second request is never sent: ${JSON.stringify(result)}`);
      for (let i = base; i < env.fake.calls.length; i += 1) {
        assert.equal(request_text(env, i).includes(src.report_marker), false);
        assert.equal(request_text(env, i).includes(src.source_marker), false);
      }
      // the run read and the DB say why it stopped; the unsent dispatch is not "sent"
      assert.equal(result.status, "interrupted", JSON.stringify(result));
      assert.equal(result.interrupt_reason, "reference_withdrawn");
      const state = stopped_state(env, result.run_id);
      assert.equal(state.status, "interrupted");
      assert.equal(state.reason, "reference_withdrawn");
      assert.equal(state.dispatches.length, 2, JSON.stringify(state));
      assert.notEqual(state.dispatches[0], "sent");
      assert.equal(state.dispatches[1], "blocked", "the second dispatch was authorized, never sent");
      const lease = env.db.get<{ state: string }>("SELECT state FROM project_leases WHERE project_id = ?", env.p.project_id);
      assert.equal(lease?.state, "released", "the lease is not left held");
    });
  });
}

for (const how of ["go_off", "access"] as Revoke[]) {
  test(`F2-2 (${how}): a tool error that echoes the reference text (unknown field) — revoked before the next request, the run stops and the echo is never sent`, async () => {
    await with_a_env("openai_compatible", async (env) => {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      const { src, ref } = await attached(env, `tool-error-${how}`);
      const base = script_fn(env, (n) =>
        n === 1
          ? reference_turn(ref.reference_id)
          : n === 2
            ? {
                tools: [
                  {
                    name: "result.submit",
                    args: { results: [{ op: "append_version", object_id: o.object_id, title: "합성 글", [src.report_marker]: "합성 부가 칸" }] },
                  },
                ],
              }
            : FINISH,
      );
      const original = env.keys.get.bind(env.keys);
      let revoked = false;
      (env.keys as any).get = async (k: string) => {
        if (!revoked && env.fake.calls.length - base === 2) {
          revoked = true;
          await revoke(env, src, how, `f22-${how}-revoke`);
        }
        return original(k);
      };
      const result = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(revoked, true);
      assert.equal(env.fake.calls.length - base, 2, `the third request is never sent: ${JSON.stringify(result)}`);
      assert.ok(request_text(env, base + 1).includes(src.report_marker), "the text did go out once (before the revocation)");
      assert.equal(result.status, "interrupted", JSON.stringify(result));
      assert.equal(result.interrupt_reason, "reference_withdrawn");
      const state = stopped_state(env, result.run_id);
      assert.equal(state.status, "interrupted");
      assert.equal(state.reason, "reference_withdrawn");
      assert.equal(state.dispatches.length, 2, "no third dispatch is written");
      for (const d of state.dispatches) assert.ok(!["prepared", "authorized", "sent"].includes(d), JSON.stringify(state));
    });
  });
}

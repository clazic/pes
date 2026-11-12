/**
 * SEL-113 REF1a — 에이전트 경로: A 내장 실행기 도구 context.get 과 B MCP pes_context 가 같은 참고자료 읽기를 하고,
 * Go OFF(원본 또는 현재 프로젝트 하나라도)·권한 없음·원본 없음에서는 본문을 내보내지 않는다 (tester, 작성 모드).
 * 가짜 AI 서버(a_builtin_env FakeAi)와 가짜 MCP 클라이언트만 쓴다. 실제 모델·네트워크 호출 없음.
 *
 * 있던 것(회귀 가드): A_TOOL_ALLOWLIST 여덟 개(thread.reply·followup.propose 포함), context.get 은 인자 없음, MCP 도구 열네 개(TOOLS),
 *   pes_context 는 API GET /context 를 읽는다, internal_ai 토큰은 현재 프로젝트 Go OFF 이면 go:true 읽기가 403 policy_blocked.
 *
 * 정한 해석:
 *   새 도구를 더하지 않는다. A 의 allowlist 8개와 B 의 도구 14개는 그대로이고, 참고자료 본문 읽기는 기존 두 읽기 도구의 **선택 인자**다.
 *     A  context.get {reference_id?}   인자 없음 → 기존 {ok, context} 에 context.references[] (목록·요약, 본문 없음).
 *                                      reference_id → {ok:true, reference, content}  (context 는 없음. 모르는 id → is_error 결과 {ok:false, error})
 *     B  pes_context {reference_id?}   인자 없음 → 기존 data 에 references[] (같은 목록). reference_id → {reference, content}. 모르는 id → tool error not_found,
 *                                      접근 없음 → tool error forbidden. (idempotency_key 불필요 — 읽기)
 *   reference / content / references[] 의 모양은 HTTP 와 똑같다(test_sel113_api.test.ts 머리말): 같은 상태에서 A·B·HTTP 가 같은 읽기 결과.
 *   Go 규칙(엄격한 쪽 우선): 원본 프로젝트 또는 현재 프로젝트 중 **하나라도** allow_opencode_go=false 이면 AI 호출자(A 도구, B MCP, 에이전트 토큰)는
 *     그 참고자료의 content 를 받지 못한다. 줄은 보이고 ai_delivery = {allowed:false, withheld_reason:'source_go_off'|'project_go_off'}, content = null.
 *     (docs/plan/ui/dashboard-v2.md 5.3 표: B 도구의 목적지를 모르면 API 목적지로 보고 엄격하게 — 그래서 B 도 막는다.) 사람(소유자 세션)은 영향 없음.
 *     원본 없음이면 ai_delivery.withheld_reason='source_missing'. Go 를 다시 켜면(새 정책 개정) 다시 읽힌다.
 *   권한: A·B 는 일하는 행위자의 사람 사용자 기준으로 원본 접근을 본다. 접근이 없으면 줄은 REF_NOPERM_KEYS 세 칸, 본문 단 한 글자도 없다.
 *   인용: content.items[].citation 에 프로젝트·라벨·스냅숏·버전이 있다(A·B 모두).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { A_TOOL_ALLOWLIST, TOOL_SPECS } from "../scripts/pes_core/a_runtime/tools.ts";
import {
  FINISH,
  context_turn,
  open_stage,
  ready_project,
  request_text,
  start_run,
  with_a_env,
  type AEnv,
  type ScriptedTurn,
} from "./helpers/a_builtin_env.ts";
import { TOOLS } from "./helpers/adapter_b_env.ts";
import { with_cleanup } from "./helpers/adapter_b_flow.ts";
import { assert_ok, call, type ApiEnv } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { REF_KEYS, REF_NOPERM_KEYS, add_new_version, attached, current_go, has_text, revoke_access, source_go } from "./helpers/sel113_env.ts";

function script_fn(env: AEnv, fn: (n: number) => ScriptedTurn): void {
  const base = env.fake.calls.length;
  env.fake.script = (n: number) => fn(n - base);
}

/** 모델이 받은 도구 결과(JSON) 가운데 n 번째 요청에서 마지막 것. */
function tool_json(env: AEnv, request_index: number): any {
  const body = env.fake.calls[request_index]!.json as any;
  const tools = (body.messages as any[]).filter((m) => m.role === "tool");
  assert.ok(tools.length > 0, "the request carried a tool result");
  return JSON.parse(tools[tools.length - 1].content);
}

const reference_turn = (reference_id: string): ScriptedTurn => ({ tools: [{ name: "context.get", args: { reference_id } }] });

async function a_world(env: AEnv, tag: string) {
  await ready_project(env);
  const o = await open_stage(env, "plan");
  const { src, ref } = await attached(env, tag);
  return { o, src, ref };
}

const whole_transcript = (env: AEnv): string => env.fake.calls.map((c) => request_text(c.json)).join("\n");

const VIEW_KEYS = ["state", "access", "source_label", "scope", "new_version_available", "ai_delivery"];
const view = (row: any): Record<string, unknown> => Object.fromEntries(VIEW_KEYS.filter((k) => k in row).map((k) => [k, row[k]]));

// ---------------------------------------------------------------------------
// A

test("A: no new tool — the allowlist stays at eight; context.get only gains an optional reference_id", () => {
  assert.equal(A_TOOL_ALLOWLIST.length, 8);
  assert.ok(!A_TOOL_ALLOWLIST.some((n) => /reference/i.test(n)), "no reference.* tool");
  const spec = TOOL_SPECS.find((t) => t.name === "context.get")!;
  const props = (spec.parameters as any).properties;
  assert.ok(props.reference_id, "context.get accepts reference_id");
  assert.equal(props.reference_id.type, "string");
  assert.ok(!((spec.parameters as any).required ?? []).includes("reference_id"), "it is optional");
  assert.ok(!TOOL_SPECS.some((t) => /reference/i.test(t.name)));
});

test("A: context.get lists the references (summary, pinned snapshot, scope, delivery) and never the bodies", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const { o, src, ref } = await a_world(env, "a1");
    script_fn(env, (n) => (n === 1 ? context_turn() : FINISH));
    assert.equal((await start_run(env, { stage_id: o.stage_id, round_id: o.round_id })).status, "succeeded");
    const list: any[] = tool_json(env, 1).context.references;
    assert.equal(list.length, 1);
    assert.deepEqual(Object.keys(list[0]).sort(), [...REF_KEYS].sort());
    assert.equal(list[0].id, ref.reference_id);
    assert.equal(list[0].source_snapshot_id, src.snapshot_id);
    assert.equal(list[0].state, "pinned");
    assert.deepEqual(list[0].ai_delivery, { allowed: true, withheld_reason: null });
    assert.equal(has_text(whole_transcript(env), src.report_marker), false, "the list carries no report text");
    assert.equal(has_text(whole_transcript(env), src.source_marker), false);
  });
});

test("A: context.get {reference_id} reads the pinned content with citations; the project and snapshot are named on every item", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const { o, src, ref } = await a_world(env, "a2");
    const v2 = await add_new_version(env, src, 2); // the source moved on; the pin must not
    script_fn(env, (n) => (n === 1 ? reference_turn(ref.reference_id) : FINISH));
    assert.equal((await start_run(env, { stage_id: o.stage_id, round_id: o.round_id })).status, "succeeded");
    const back = tool_json(env, 1);
    assert.equal(back.ok, true);
    assert.equal(back.context, undefined, "only the reference");
    assert.equal(back.reference.id, ref.reference_id);
    assert.equal(back.reference.state, "new_version", "the AI is told a newer version exists");
    assert.equal(back.reference.latest_snapshot_id, v2.snapshot_id);
    const items: any[] = back.content.items;
    assert.equal(items.length, 2);
    assert.ok(has_text(items, src.report_marker), "the pinned (first) version");
    assert.equal(has_text(items, v2.marker), false, "not the newer one");
    for (const item of items) {
      assert.equal(item.citation.project_id, src.p.project_id);
      assert.equal(item.citation.snapshot_id, src.snapshot_id);
      assert.equal(item.citation.version_id, item.version_id);
      assert.equal(item.citation.reference_id, ref.reference_id);
      assert.equal(typeof item.citation.project_label, "string");
    }
  });
});

test("A: source Go OFF → the row says withheld (source_go_off), the content is null, and the whole transcript holds no source text; Go back ON → readable again", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const { o, src, ref } = await a_world(env, "a3");
    await source_go(env, src, false, "a3-off");
    script_fn(env, (n) => (n === 1 ? context_turn() : n === 2 ? reference_turn(ref.reference_id) : FINISH));
    assert.equal((await start_run(env, { stage_id: o.stage_id, round_id: o.round_id })).status, "succeeded");
    const list = tool_json(env, 1).context.references;
    assert.deepEqual(list[0].ai_delivery, { allowed: false, withheld_reason: "source_go_off" });
    const direct = tool_json(env, 2);
    assert.equal(direct.reference.ai_delivery.allowed, false);
    assert.equal(direct.content, null);
    const text = whole_transcript(env);
    for (const m of [src.report_marker, src.source_marker]) assert.equal(has_text(text, m), false, `${m} never reached the model`);
    assert.equal(env.fake.calls.length >= 3, true);

    await source_go(env, src, true, "a3-on");
    script_fn(env, (n) => (n === 1 ? reference_turn(ref.reference_id) : FINISH));
    const calls_before = env.fake.calls.length;
    const again = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(again.status, "succeeded");
    const back = tool_json(env, calls_before + 1);
    assert.ok(has_text(back.content, src.report_marker), "a new policy revision lets the content through again");
  });
});

test("A: no access to the source (membership revoked) → three keys, no content, no source text in any request", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const { o, src, ref } = await a_world(env, "a4");
    revoke_access(env, src);
    script_fn(env, (n) => (n === 1 ? context_turn() : n === 2 ? reference_turn(ref.reference_id) : FINISH));
    assert.equal((await start_run(env, { stage_id: o.stage_id, round_id: o.round_id })).status, "succeeded");
    const row = tool_json(env, 1).context.references[0];
    assert.deepEqual(Object.keys(row).sort(), [...REF_NOPERM_KEYS].sort());
    assert.equal(row.state, "no_permission");
    const direct = tool_json(env, 2);
    assert.equal(direct.ok, false, "the read of a reference without access is refused");
    assert.equal(has_text(whole_transcript(env), src.report_marker), false);
    assert.equal(has_text(whole_transcript(env), src.source_marker), false);
    assert.equal(has_text(whole_transcript(env), src.p.project_id), false, "not even the project id");
  });
});

test("A: an unknown reference_id comes back as an error result and the run goes on; the original-gone row says so and holds no content", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const { o, src, ref } = await a_world(env, "a5");
    script_fn(env, (n) => (n === 1 ? reference_turn("no-such-reference") : FINISH));
    assert.equal((await start_run(env, { stage_id: o.stage_id, round_id: o.round_id })).status, "succeeded");
    assert.equal(tool_json(env, 1).ok, false);

    await env.service.execute({ project_id: src.p.project_id, actor_id: src.p.actor_id, via: "cli", client_request_id: "a5-gone" }, "reference.source_gone", { referenced_project_id: src.p.project_id });
    script_fn(env, (n) => (n === 1 ? reference_turn(ref.reference_id) : FINISH));
    const before = env.fake.calls.length;
    assert.equal((await start_run(env, { stage_id: o.stage_id, round_id: o.round_id })).status, "succeeded");
    const back = tool_json(env, before + 1);
    assert.equal(back.reference.state, "source_missing");
    assert.equal(back.content, null);
    assert.equal(back.reference.ai_delivery.withheld_reason, "source_missing");
    assert.equal(has_text(whole_transcript(env), src.report_marker), false);
  });
});

// ---------------------------------------------------------------------------
// B

test("B: still fourteen tools, none for references; pes_context takes an optional reference_id", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const listed = await client.request("tools/list", {});
    const names: string[] = listed.result.tools.map((t: any) => t.name);
    assert.deepEqual([...names].sort(), [...TOOLS].sort());
    assert.ok(!names.some((n) => /reference/i.test(n)));
    const spec = listed.result.tools.find((t: any) => t.name === "pes_context");
    assert.equal(spec.inputSchema.properties.reference_id.type, "string");
    assert.ok(!(spec.inputSchema.required ?? []).includes("reference_id"));
  });
});

test("B: pes_context lists the same rows as GET /context for the agent token; no body text", async () => {
  await with_cleanup(async (env, open) => {
    const { src, ref } = await attached(env, "b1");
    const client = open(await env.client());
    const out = await client.ok("pes_context", {});
    assert.equal(out.references.length, 1);
    assert.equal(out.references[0].id, ref.reference_id);
    assert.deepEqual(Object.keys(out.references[0]).sort(), [...REF_KEYS].sort());
    const http = assert_ok(await call(env as ApiEnv, { method: "GET", path: P(env, "/context"), auth: { token: env.agent.token } }));
    assert.deepEqual(out.references, http.references, "MCP and HTTP read the same rows");
    assert.equal(has_text(out, src.report_marker), false);
    assert.equal(has_text(out, src.source_marker), false);
  });
});

test("B: pes_context {reference_id} = HTTP GET references/{ref} (reference + content with citations); the pin holds while the source moves on", async () => {
  await with_cleanup(async (env, open) => {
    const { src, ref } = await attached(env, "b2");
    const v2 = await add_new_version(env, src, 2);
    const client = open(await env.client());
    const out = await client.ok("pes_context", { reference_id: ref.reference_id });
    const http = assert_ok(await call(env as ApiEnv, { method: "GET", path: P(env, `/references/${ref.reference_id}`), auth: { token: env.agent.token } }));
    assert.deepEqual(out.reference, http.reference);
    assert.deepEqual(out.content, http.content);
    assert.equal(out.reference.state, "new_version");
    assert.ok(has_text(out.content, src.report_marker));
    assert.equal(has_text(out.content, v2.marker), false);
    for (const item of out.content.items) {
      assert.equal(item.citation.project_id, src.p.project_id);
      assert.equal(item.citation.snapshot_id, src.snapshot_id);
      assert.equal(item.citation.version_id, item.version_id);
    }
    await client.fails("pes_context", { reference_id: "no-such-reference" }, "not_found");
  });
});

test("B: source Go OFF, then current Go OFF — content is withheld each time (reason named), no source text in any tool output or HTTP agent read; the owner session still reads it", async () => {
  await with_cleanup(async (env, open) => {
    const { src, ref } = await attached(env, "b3");
    const client = open(await env.client());
    const agent_get = (path: string) => call(env as ApiEnv, { method: "GET", path: P(env, path), auth: { token: env.agent.token } });

    await source_go(env, src, false, "b3-src-off");
    let out = await client.ok("pes_context", { reference_id: ref.reference_id });
    assert.deepEqual(out.reference.ai_delivery, { allowed: false, withheld_reason: "source_go_off" });
    assert.equal(out.content, null);
    assert.equal(has_text(out, src.report_marker) || has_text(out, src.source_marker), false);
    let http = await agent_get(`/references/${ref.reference_id}`);
    assert.equal(assert_ok(http).content, null);
    assert.equal(has_text(http.json, src.report_marker), false);
    const listed = await client.ok("pes_context", {});
    assert.equal(listed.references[0].ai_delivery.allowed, false);
    const human = assert_ok(await call(env as ApiEnv, { method: "GET", path: P(env, `/references/${ref.reference_id}`), auth: "owner" }));
    assert.ok(has_text(human.content, src.report_marker), "a person may still read what the AI may not");

    await source_go(env, src, true, "b3-src-on");
    out = await client.ok("pes_context", { reference_id: ref.reference_id });
    assert.equal(out.reference.ai_delivery.allowed, true);
    assert.ok(has_text(out.content, src.report_marker));

    await current_go(env, false, "b3-cur-off");
    out = await client.ok("pes_context", { reference_id: ref.reference_id });
    assert.deepEqual(out.reference.ai_delivery, { allowed: false, withheld_reason: "project_go_off" }, "the stricter side wins: this project's switch counts too");
    assert.equal(out.content, null);
    http = await agent_get(`/references/${ref.reference_id}`);
    assert.equal(assert_ok(http).content, null);
    assert.equal(has_text(http.json, src.report_marker), false);

    await source_go(env, src, false, "b3-src-off2");
    out = await client.ok("pes_context", { reference_id: ref.reference_id });
    assert.equal(out.content, null, "both off: still nothing");
  });
});

test("B: without access to the source the row is three keys and the read is a forbidden tool error — no source text at all", async () => {
  await with_cleanup(async (env, open) => {
    const { src, ref } = await attached(env, "b4");
    const client = open(await env.client());
    revoke_access(env, src);
    const listed = await client.ok("pes_context", {});
    assert.deepEqual(Object.keys(listed.references[0]).sort(), [...REF_NOPERM_KEYS].sort());
    const err = await client.fails("pes_context", { reference_id: ref.reference_id }, "forbidden");
    for (const out of [listed, err]) {
      assert.equal(has_text(out, src.report_marker) || has_text(out, src.source_marker) || has_text(out, src.p.project_id), false);
    }
  });
});

test("B: an original that is gone reads as source_missing with the name kept and no content; a detached reference disappears from the list", async () => {
  await with_cleanup(async (env, open) => {
    const { src, ref } = await attached(env, "b5");
    const client = open(await env.client());
    await env.service.execute({ project_id: src.p.project_id, actor_id: src.p.actor_id, via: "cli", client_request_id: "b5-gone" }, "reference.source_gone", { referenced_project_id: src.p.project_id });
    const out = await client.ok("pes_context", { reference_id: ref.reference_id });
    assert.equal(out.reference.state, "source_missing");
    assert.equal(out.reference.source_label, ref.source_label);
    assert.equal(out.content, null);
    assert.equal(out.reference.ai_delivery.withheld_reason, "source_missing");
    await env.service.execute(env.ctx("b5-det"), "reference.detach", { reference_id: ref.reference_id });
    assert.deepEqual((await client.ok("pes_context", {})).references, []);
  });
});

// ---------------------------------------------------------------------------
// A and B read the same thing

test("A and B give the same read result for the same state (normal / source Go OFF / no access) — compared on the shared fields", async () => {
  const states = ["normal", "go_off", "no_access"] as const;
  const seen = { a: {} as Record<string, unknown>, b: {} as Record<string, unknown> };
  for (const state of states) {
    await with_a_env("openai_compatible", async (env) => {
      const { o, src } = await a_world(env, "ab");
      if (state === "go_off") await source_go(env, src, false, "ab-off");
      if (state === "no_access") revoke_access(env, src);
      script_fn(env, (n) => (n === 1 ? context_turn() : FINISH));
      await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      seen.a[state] = view(tool_json(env, 1).context.references[0]);
    });
    await with_cleanup(async (env, open) => {
      const { src } = await attached(env, "ab");
      if (state === "go_off") await source_go(env, src, false, "ab-off");
      if (state === "no_access") revoke_access(env, src);
      const client = open(await env.client());
      seen.b[state] = view((await client.ok("pes_context", {})).references[0]);
    });
  }
  assert.deepEqual(seen.a, seen.b);
  assert.equal((seen.a.normal as any).state, "pinned");
  assert.equal((seen.a.go_off as any).ai_delivery.allowed, false);
  assert.equal((seen.a.no_access as any).state, "no_permission");
});

/**
 * SEL-123 REF1 후속 1번 — 원본 프로젝트의 "AI 참조 금지" 파일 글이 참고자료를 통해 AI 에게 새지 않는다 (tester, 작성 모드).
 *
 * 근거: SEL-113-r1.md 권장 4. 현재 프로젝트의 AI 출구는 file_ai_denied / material_object_denied / version_ai_denied (commands/file_access.ts) 로
 * 막지만, 참고자료의 내용(reference_content)은 *다른 프로젝트*의 sources.quote·보고서 본문을 그대로 낸다.
 *
 * 정한 인터페이스 (구현이 이 표를 따른다. 다르게 정하면 이 머리말과 헬퍼만 고친다)
 *
 *  판정    references.ts 의 decide() 옆에서 같은 함수들을 **원본 프로젝트 id** 로 재사용한다 —
 *          항목(보고서 버전/출처 버전) 하나마다 version_ai_denied(db, 원본 project_id, version_id) 이 참이면 그 항목은 AI 호출자에게 안 나간다.
 *          (file 자료 출처: 그 자료 객체의 어느 버전이든 금지 파일이면 객체 단위로 막힘 = material_object_denied. 보고서: 그 버전이 금지 파일을 지니면 막힘.)
 *          판정은 읽는 **지금** 한다(붙일 때가 아니다): 붙인 뒤 deny 로 바뀌면 막히고, 다시 allow 로 돌리면 다시 나간다.
 *  사람    소유자 세션(reference_caller ai=false)은 영향 없음 — 같은 항목을 모두 본다.
 *  막는 모양  막힌 항목은 content.items 에서 **통째로 빠진다**(quote 만 null 로 두지 않는다 — 제목이 파일 이름일 수 있어서. SEL-115 의
 *          "존재 표시 없음" 정책과 같다). 이름·제목·url·quote·본문·object_id·version_id·citation 어디에도 안 남고, 막은 개수도 안 낸다.
 *          items_status 는 AI 가 볼 수 있는 항목으로 센다(전부 막히면 sources: "none" — "막혔다"는 표시를 만들지 않는다).
 *          원본 Go OFF 의 content=null 규칙은 그대로.
 *  출구    AI 출구 전부 같은 결과: 서비스 read_reference(ai=true) · HTTP GET P/references/{ref}(에이전트 토큰) · GET P/context(토큰) ·
 *          B MCP pes_context{reference_id} · A 도구 context.get{reference_id} · SEL-118 프롬프트 조립(POST P/prompt-builds, 참고자료 글은 원래 안 들어간다 — 보증용).
 *
 * 있던 것(회귀 가드, 이 파일이 새 실패를 만들면 안 되는 쪽): 금지 파일이 없으면 AI 도 그대로 본다(허용 파일·파일 없는 출처).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { add_artifact, add_source, append_version, create_object } from "../scripts/pes_core/content.ts";
import { read_reference, reference_caller } from "../scripts/pes_core/references.ts";
import { open_stage, ready_project, request_text, FINISH, start_run, with_a_env, type AEnv, type ScriptedTurn } from "./helpers/a_builtin_env.ts";
import { with_cleanup } from "./helpers/adapter_b_flow.ts";
import { assert_ok, call, type ApiEnv } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { attach, ctx_for, new_artifact, put_ready, second_project, type Env, type Project } from "./helpers/blob_env.ts";
import { attach_ref, grant_access, has_text, take_snapshot } from "./helpers/sel113_env.ts";

const take_snapshot_for = (env: Env, p: Project, key: string, versions: Array<{ object_id: string; version_id: string }>): Promise<string> =>
  take_snapshot(env, p, key, versions.map((v) => ({ object_id: v.object_id, version_id: v.version_id })));

interface World {
  p: Project;
  snapshot_id: string;
  report: { object_id: string; version_id: string };
  file_src: { object_id: string; version_id: string };
  web_src: { object_id: string; version_id: string };
  report_blob: string;
  file_blob: string;
  report_policy: string;
  file_policy: string;
  m: { report: string; file_title: string; file_quote: string; web_title: string; web_quote: string };
}

/**
 * 원본 프로젝트: 보고서 R(금지 후보 파일 하나 첨부) + file 출처 SF(금지 후보 파일 하나 첨부, quote 있음) + web 출처 SW(파일 없음, quote 있음).
 * 처음엔 파일 정책이 모두 allow. 판 스냅숏 하나에 셋 다 든다.
 */
async function make_world(env: Env, tag: string): Promise<World> {
  const p = await second_project(env, `ref-deny-${tag}`);
  const m = {
    report: `DENY-${tag}-REPORT`,
    file_title: `DENY-${tag}-FILETITLE`,
    file_quote: `DENY-${tag}-FILEQUOTE`,
    web_title: `DENY-${tag}-WEBTITLE`,
    web_quote: `DENY-${tag}-WEBQUOTE`,
  };
  const obj = async (key: string, kind: "artifact" | "source"): Promise<string> =>
    ((await create_object(env.service, ctx_for(p, `${tag}-${key}-o`), { kind, edition_id: p.edition_id })).result as { object_id: string }).object_id;

  const report = (
    await add_artifact(env.service, ctx_for(p, `${tag}-rep-v`), {
      object_id: await obj("rep", "artifact"),
      artifact_kind: "report",
      title: `${m.report} 제목`,
      summary: `${m.report} 요약`,
      body_md: `# 보고서\n\n${m.report} 본문`,
    })
  ).result as { object_id: string; version_id: string };
  const file_src = (
    await add_source(env.service, ctx_for(p, `${tag}-file-v`), {
      object_id: await obj("file", "source"),
      source_kind: "file",
      title: m.file_title,
      url: null,
      quote: m.file_quote,
      locator: { page: 1 },
      method: "fetch",
      verification_state: "unverified",
    })
  ).result as { object_id: string; version_id: string };
  const web_src = (
    await add_source(env.service, ctx_for(p, `${tag}-web-v`), {
      object_id: await obj("web", "source"),
      source_kind: "web",
      title: m.web_title,
      url: "https://example.invalid/synthetic-deny",
      quote: m.web_quote,
      locator: { page: 1 },
      method: "fetch",
      verification_state: "unverified",
    })
  ).result as { object_id: string; version_id: string };

  const report_blob = (await put_ready(env, new TextEncoder().encode(`${tag}-report-file-bytes`), `${tag}-rb`, p)).blob_id;
  const file_blob = (await put_ready(env, new TextEncoder().encode(`${tag}-source-file-bytes`), `${tag}-fb`, p)).blob_id;
  const report_policy = (await attach(env, report.version_id, report_blob, "attachment", `${tag}-rb-a`, p)).file_policy_id;
  const file_policy = (await attach(env, file_src.version_id, file_blob, "attachment", `${tag}-fb-a`, p)).file_policy_id;
  const snapshot_id = await take_snapshot_for(env, p, `${tag}-snap`, [report, file_src, web_src]);
  return { p, snapshot_id, report, file_src, web_src, report_blob, file_blob, report_policy, file_policy, m };
}

async function set_ai_access(env: Env, w: World, policy_id: string, ai_access: "allow" | "deny", key: string): Promise<void> {
  await env.service.execute(ctx_for(w.p, key), "file.ai_access_set", { file_policy_id: policy_id, ai_access });
}

async function attached_world(env: Env, tag: string): Promise<{ w: World; reference_id: string }> {
  const w = await make_world(env, tag);
  grant_access(env, { p: w.p } as never);
  const ref = (await attach_ref(env, { p: w.p, snapshot_id: w.snapshot_id } as never, `att-${tag}`)) as { reference_id: string };
  return { w, reference_id: ref.reference_id };
}

function read(env: Env, reference_id: string, ai: boolean): { reference: any; content: any } {
  return read_reference(env.db, env.p.project_id, reference_id, reference_caller(env.db, env.p.actor_id, ai)) as any;
}

/** 금지 파일 출처 SF 의 흔적(제목·quote·객체/버전 id)이 이 값에 하나라도 있나. */
function file_src_traces(w: World): string[] {
  return [w.m.file_title, w.m.file_quote, w.file_src.object_id, w.file_src.version_id, w.file_blob, w.file_policy];
}
function report_traces(w: World): string[] {
  return [w.m.report, w.report.object_id, w.report.version_id, w.report_blob, w.report_policy];
}
function traces_in(value: unknown, traces: string[]): string[] {
  return traces.filter((t) => has_text(value, t));
}

// ---------------------------------------------------------------------------
// 서비스: 판정

test("file material source: its denied file keeps its quote, title and ids out of an AI read (item dropped whole); a person still sees them; the web source stays", async () => {
  await with_cleanup(async (env) => {
    const { w, reference_id } = await attached_world(env, "d1");
    await set_ai_access(env, w, w.file_policy, "deny", "d1-deny");
    const ai = read(env, reference_id, true);
    assert.deepEqual(traces_in(ai, file_src_traces(w)), [], "nothing of the denied file source reaches the AI");
    assert.ok(has_text(ai.content, w.m.web_quote), "the allowed web source is still delivered");
    assert.ok(has_text(ai.content, w.m.report), "the report (no denied file) is still delivered");
    assert.equal(ai.content.items.filter((i: any) => i.item === "sources").length, 1);
    assert.equal(ai.content.items_status.sources, "ok", "status counts what the AI may see");

    const person = read(env, reference_id, false);
    assert.ok(has_text(person.content, w.m.file_quote), "the person sees the quote");
    assert.ok(has_text(person.content, w.m.file_title));
    assert.equal(person.content.items.filter((i: any) => i.item === "sources").length, 2);
  });
});

test("report whose version carries a denied file: the AI gets no title, summary, body or ids of it; a person does", async () => {
  await with_cleanup(async (env) => {
    const { w, reference_id } = await attached_world(env, "d2");
    await set_ai_access(env, w, w.report_policy, "deny", "d2-deny");
    const ai = read(env, reference_id, true);
    assert.deepEqual(traces_in(ai, report_traces(w)), []);
    assert.equal(ai.content.items.some((i: any) => i.item === "final_report"), false);
    assert.ok(has_text(ai.content, w.m.web_quote), "the other items are untouched");
    assert.ok(has_text(read(env, reference_id, false).content, w.m.report));
  });
});

test("the decision is made at read time: denying after attach hides it, allowing again brings it back", async () => {
  await with_cleanup(async (env) => {
    const { w, reference_id } = await attached_world(env, "d3");
    assert.ok(has_text(read(env, reference_id, true).content, w.m.file_quote), "allowed at first");
    await set_ai_access(env, w, w.file_policy, "deny", "d3-deny");
    assert.deepEqual(traces_in(read(env, reference_id, true), file_src_traces(w)), []);
    await set_ai_access(env, w, w.file_policy, "allow", "d3-allow");
    assert.ok(has_text(read(env, reference_id, true).content, w.m.file_quote), "allowed again");
  });
});

test("object unit: a later version of the file material without the file is still closed when an earlier version carries a denied file", async () => {
  await with_cleanup(async (env) => {
    const w = await make_world(env, "d4");
    grant_access(env, { p: w.p } as never);
    await set_ai_access(env, w, w.file_policy, "deny", "d4-deny");
    const v2_title = "DENY-d4-FILE-V2-TITLE";
    const v2 = (await append_version(env.service, ctx_for(w.p, "d4-v2"), { object_id: w.file_src.object_id, title: v2_title, locator: {}, method: "fetch", verification_state: "unverified", quote: `${v2_title}-QUOTE` })).result as { object_id: string; version_id: string };
    const snapshot_id = await take_snapshot_for(env, w.p, "d4-snap2", [w.report, v2, w.web_src]);
    const ref = (await attach_ref(env, { p: w.p, snapshot_id } as never, "att-d4")) as { reference_id: string };
    const ai = read(env, ref.reference_id, true);
    assert.deepEqual(traces_in(ai, [v2_title, `${v2_title}-QUOTE`, v2.version_id, w.file_src.object_id, w.m.file_quote]), [], "the pinned newer version of a closed material is closed too");
    assert.ok(has_text(ai.content, w.m.web_quote));
    assert.ok(has_text(read(env, ref.reference_id, false).content, v2_title), "the person sees it");
  });
});

test("regression: no denied file → the AI reads everything; a denied file of the CURRENT project does not touch the reference", async () => {
  await with_cleanup(async (env) => {
    const { w, reference_id } = await attached_world(env, "d5");
    const ai = read(env, reference_id, true);
    for (const text of [w.m.report, w.m.file_quote, w.m.web_quote]) assert.ok(has_text(ai.content, text), `${text} delivered`);
    assert.equal(ai.content.items.length, 3, "report, file source, web source");
    // a denied file in the CURRENT project
    const own = await new_artifact(env, "d5-own");
    const blob = (await put_ready(env, new TextEncoder().encode("d5-own-file"), "d5-ob")).blob_id;
    const policy = (await attach(env, own.version_id, blob, "attachment", "d5-oa")).file_policy_id;
    await env.service.execute(env.ctx("d5-odeny"), "file.ai_access_set", { file_policy_id: policy, ai_access: "deny" });
    assert.equal(read(env, reference_id, true).content.items.length, 3);
  });
});

// ---------------------------------------------------------------------------
// HTTP 과 B

test("HTTP + B: agent token reads of the reference and of /context hold none of the denied text; the owner session still gets all of it", async () => {
  await with_cleanup(async (env, open) => {
    const { w, reference_id } = await attached_world(env, "h1");
    await set_ai_access(env, w, w.file_policy, "deny", "h1-fdeny");
    await set_ai_access(env, w, w.report_policy, "deny", "h1-rdeny");
    const all = [...file_src_traces(w), ...report_traces(w)];
    const token = { token: env.agent.token };
    const one = assert_ok(await call(env as ApiEnv, { method: "GET", path: P(env, `/references/${reference_id}`), auth: token }));
    assert.deepEqual(traces_in(one, all), [], "GET references/{ref} with a token");
    const list = assert_ok(await call(env as ApiEnv, { method: "GET", path: P(env, "/references"), auth: token }));
    assert.deepEqual(traces_in(list, all), []);
    const ctx = assert_ok(await call(env as ApiEnv, { method: "GET", path: P(env, "/context"), auth: token }));
    assert.deepEqual(traces_in(ctx, all), [], "GET /context with a token");
    assert.ok(has_text(one.content, w.m.web_quote), "the allowed source is still there");

    const client = open(await env.client());
    const b = await client.ok("pes_context", { reference_id });
    assert.deepEqual(traces_in(b, all), [], "B pes_context {reference_id}");
    assert.deepEqual(b.content, one.content, "B and HTTP agree");

    const owner = assert_ok(await call(env as ApiEnv, { method: "GET", path: P(env, `/references/${reference_id}`), auth: "owner" }));
    for (const text of [w.m.report, w.m.file_quote, w.m.file_title, w.m.web_quote]) assert.ok(has_text(owner.content, text), `owner session sees ${text}`);
  });
});

// ---------------------------------------------------------------------------
// A 도구 와 프롬프트 조립

function script_fn(env: AEnv, fn: (n: number) => ScriptedTurn): void {
  const base = env.fake.calls.length;
  env.fake.script = (n: number) => fn(n - base);
}

test("A: context.get {reference_id} → no request sent to the model holds the denied text", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const { w, reference_id } = await attached_world(env as unknown as Env, "a1");
    await set_ai_access(env as unknown as Env, w, w.file_policy, "deny", "a1-fdeny");
    await set_ai_access(env as unknown as Env, w, w.report_policy, "deny", "a1-rdeny");
    script_fn(env, (n) => (n === 1 ? { tools: [{ name: "context.get", args: { reference_id } }] } : FINISH));
    assert.equal((await start_run(env, { stage_id: o.stage_id, round_id: o.round_id })).status, "succeeded");
    const transcript = env.fake.calls.map((c) => request_text(c.json)).join("\n");
    assert.deepEqual(traces_in(transcript, [...file_src_traces(w), ...report_traces(w)]), [], "the whole transcript is clean");
    assert.ok(transcript.includes(w.m.web_quote), "the allowed source reached the model");
  });
});

test("prompt build (SEL-118): with a reference whose source has denied files, the prompt carries no source text (target A and B)", async () => {
  await with_cleanup(async (env) => {
    const { w } = await attached_world(env, "p1");
    await set_ai_access(env, w, w.file_policy, "deny", "p1-fdeny");
    const own = (await add_artifact(env.service, env.ctx("p1-own-v"), {
      object_id: ((await create_object(env.service, env.ctx("p1-own-o"), { kind: "artifact", edition_id: env.p.edition_id })).result as { object_id: string }).object_id,
      artifact_kind: "chapter",
      title: "합성 장",
      summary: "합성 요약 문장",
    })).result as { version_id: string };
    for (const target of ["A", "B"]) {
      const res = await call(env as ApiEnv, {
        method: "POST",
        path: P(env, "/prompt-builds"),
        auth: "owner",
        body: { question: "쉽게 설명해 줘", target, selection: { version_id: own.version_id, quote: "합성 요약 문장" } },
      });
      const data = assert_ok(res);
      assert.deepEqual(traces_in(data, [...file_src_traces(w), w.m.web_quote, w.m.report]), [], `target ${target}: no source text in the prompt`);
    }
  });
});

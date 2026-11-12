/**
 * SEL-113 REF1a — 1차 리뷰(R1) 필수 3건 수정 시험. 합성 데이터만, 실제 모델·네트워크 호출 없음.
 *
 *  필수 1  항목별 상태 content.items_status — scope 의 항목마다 ok | none | not_supported | snapshot_content_unavailable.
 *          '지원하지 않음'·'원본에 없음'·'읽을 수 없음'이 서로 구별된다. 응답(service)·HTTP·A·B 가 같은 객체.
 *  필수 2  A 응답 상한 — 항목을 하나씩 더하며 JSON 길이 예산(60000) 안에서 멈춘다. truncated:true · omitted_items:n,
 *          잘린 필드는 항목의 truncated_fields. 결과는 항상 JSON.parse 되는 JSON.
 *  필수 3  legacy 가져온 프로젝트의 stage 범위 스냅숏(round_id NULL, 영수증 없음, 내용 없음) — 조용한 빈 값이 아니라
 *          snapshot_content_unavailable. round 범위 legacy 는 round_contents 로 읽는다.
 *  권장    B pes_context 에 reference_id 와 run_id/inputs_cursor 를 같이 주면 invalid_payload (조용히 버리지 않는다).
 *          영수증이 깨지면 round_contents 로 대체, round 도 없으면 snapshot_content_unavailable.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { add_source, create_object } from "../scripts/pes_core/content.ts";
import { read_reference, reference_caller } from "../scripts/pes_core/references.ts";
import { FINISH, context_turn, open_stage, ready_project, start_run, with_a_env, type AEnv, type ScriptedTurn } from "./helpers/a_builtin_env.ts";
import { with_cleanup } from "./helpers/adapter_b_flow.ts";
import { assert_ok, call, type ApiEnv } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { ctx_for, type Env } from "./helpers/blob_env.ts";
import { run_import, with_legacy } from "./helpers/legacy_env.ts";
import {
  attached,
  grant_access,
  make_source,
  owner_user_of,
  take_snapshot,
  type Source,
} from "./helpers/sel113_env.ts";
import { ok } from "./helpers/sel93_env.ts";

const ALL_ITEMS = ["final_report", "stage_report", "sources", "decisions", "questions_answers", "files"];
const NOT_SUPPORTED = ["stage_report", "decisions", "questions_answers", "files"];

function read(env: Env, reference_id: string, ai: boolean): { reference: any; content: any } {
  return read_reference(env.db, env.p.project_id, reference_id, reference_caller(env.db, env.p.actor_id, ai)) as any;
}

function script_fn(env: AEnv, fn: (n: number) => ScriptedTurn): void {
  const base = env.fake.calls.length;
  env.fake.script = (n: number) => fn(n - base);
}

function tool_json_text(env: AEnv, request_index: number): string {
  const body = env.fake.calls[request_index]!.json as any;
  const tools = (body.messages as any[]).filter((m) => m.role === "tool");
  assert.ok(tools.length > 0, "the request carried a tool result");
  return tools[tools.length - 1].content as string;
}

// ---------------------------------------------------------------------------
// 필수 1 — items_status

test("items_status: every scope item gets a state; unsupported items say not_supported (not a silent empty); service, HTTP (owner and agent) and B agree", async () => {
  await with_cleanup(async (env, open) => {
    const { src, ref } = await attached(env, "s1", { scope: ALL_ITEMS });
    const person = read(env, ref.reference_id, false);
    const ai = read(env, ref.reference_id, true);
    const expected: Record<string, string> = { final_report: "ok", sources: "ok" };
    for (const item of NOT_SUPPORTED) expected[item] = "not_supported";
    assert.deepEqual(person.content.items_status, expected);
    assert.deepEqual(ai.content.items_status, expected);
    assert.ok(person.content.items.length >= 2, "the supported items are still delivered");
    assert.equal(person.content.items.some((i: any) => NOT_SUPPORTED.includes(i.item)), false);

    const http = assert_ok(await call(env as ApiEnv, { method: "GET", path: P(env, `/references/${ref.reference_id}`), auth: "owner" }));
    assert.deepEqual(http.content.items_status, expected);
    const http_agent = assert_ok(await call(env as ApiEnv, { method: "GET", path: P(env, `/references/${ref.reference_id}`), auth: { token: env.agent.token } }));
    assert.deepEqual(http_agent.content, http.content);
    const client = open(await env.client());
    const b = await client.ok("pes_context", { reference_id: ref.reference_id });
    assert.deepEqual(b.content, http.content);
    assert.ok(src);
  });
});

test("items_status: a supported item the snapshot does not hold is 'none' — different from 'not_supported'", async () => {
  await with_cleanup(async (env) => {
    const src = await make_source(env, "s2");
    grant_access(env, src);
    // a snapshot with ONLY the source version (no report)
    const only_source = await take_snapshot(env, src.p, "s2-only-src", [{ object_id: src.source.object_id, version_id: src.source.version_id }]);
    const a = (await ok(env, env.ctx("s2-att"), "reference.attach", {
      referenced_project_id: src.p.project_id,
      source_snapshot_id: only_source,
      scope: ["final_report", "sources", "decisions"],
    })) as Record<string, any>;
    const content = read(env, a.reference_id, false).content;
    assert.deepEqual(content.items_status, { final_report: "none", sources: "ok", decisions: "not_supported" });
    assert.equal(content.items.length, 1);

    // and a snapshot with ONLY the report: sources is none
    const only_report = await take_snapshot(env, src.p, "s2-only-rep", [{ object_id: src.report.object_id, version_id: src.report.version_id }]);
    await ok(env, env.ctx("s2-ref"), "reference.refresh", { reference_id: a.reference_id, source_snapshot_id: only_report });
    const again = read(env, a.reference_id, false).content;
    assert.deepEqual(again.items_status, { final_report: "ok", sources: "none", decisions: "not_supported" });
  });
});

test("items_status: A context.get {reference_id} carries the same items_status", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const { ref } = await attached(env, "s3", { scope: ["final_report", "decisions"] });
    script_fn(env, (n) => (n === 1 ? { tools: [{ name: "context.get", args: { reference_id: ref.reference_id } }] } : FINISH));
    const result = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    const back = JSON.parse(tool_json_text(env, 1));
    assert.deepEqual(back.content.items_status, { final_report: "ok", decisions: "not_supported" });
    assert.ok(env && context_turn);
  });
});

// ---------------------------------------------------------------------------
// 필수 2 — A reply budget

const LIMIT = 60_000;
/** a big reply is read by the model on the next call; the fake connection must have room for its reservation */
const BIG_LIMITS = { five_hour_tokens: 1_000_000_000, weekly_tokens: 1_000_000_000, monthly_tokens: 1_000_000_000 };

async function big_source(env: Env, tag: string, source_count: number, quote_length: number): Promise<Source> {
  const base = await make_source(env, tag);
  const versions = [{ object_id: base.report.object_id, version_id: base.report.version_id }];
  // replace the short report body with a long one (20000 > the 12000 field cap)
  const long_body = `# 긴 보고서\n\n${"가".repeat(20_000)}`;
  const r = await ok(env, ctx_for(base.p, `${tag}-longrep`), "content.append_version", { object_id: base.report.object_id, title: "긴 보고서", summary: "요약", body_md: long_body });
  versions[0] = { object_id: (r as any).object_id, version_id: (r as any).version_id };
  for (let i = 0; i < source_count; i += 1) {
    const o = await create_object(env.service, ctx_for(base.p, `${tag}-so${i}`), { kind: "source", edition_id: base.p.edition_id });
    const object_id = (o.result as { object_id: string }).object_id;
    const v = (await add_source(env.service, ctx_for(base.p, `${tag}-sv${i}`), {
      object_id,
      source_kind: "web",
      title: `출처 ${i}`,
      url: `https://example.invalid/big/${i}`,
      quote: `${"나".repeat(quote_length)}-${i}`,
      locator: { page: 1 },
      method: "fetch",
      verification_state: "unverified",
    })).result as { object_id: string; version_id: string };
    versions.push({ object_id: v.object_id, version_id: v.version_id });
  }
  const snapshot_id = await take_snapshot(env, base.p, `${tag}-big`, versions);
  return { ...base, snapshot_id };
}

test("A: a long report plus 50 sources — the reply stays valid JSON within the budget, says truncated, counts omitted items, and names the cut fields", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env, { subscription_limits: BIG_LIMITS });
    const o = await open_stage(env, "plan");
    const src = await big_source(env, "big1", 50, 3_000);
    grant_access(env, src);
    const ref = (await ok(env, env.ctx("big1-att"), "reference.attach", { referenced_project_id: src.p.project_id, source_snapshot_id: src.snapshot_id })) as Record<string, any>;
    script_fn(env, (n) => (n === 1 ? { tools: [{ name: "context.get", args: { reference_id: ref.reference_id } }] } : FINISH));
    const result = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    const text = tool_json_text(env, 1);
    assert.ok(text.length <= LIMIT, `the reply is within the budget (${text.length})`);
    const back = JSON.parse(text); // must not throw
    assert.equal(back.ok, true);
    assert.equal(back.content.truncated, true);
    assert.ok(back.content.omitted_items > 0, "some items did not fit");
    assert.equal(back.content.items.length + back.content.omitted_items, 51, "every item is either given or counted as omitted");
    const report = back.content.items.find((i: any) => i.item === "final_report");
    assert.ok(report, "the report is first and is kept");
    assert.ok(report.body_md.length <= 12_000, "the long field is cut");
    assert.ok(report.truncated_fields.includes("body_md"), "and the cut is named");
    assert.deepEqual(back.content.items_status, { final_report: "ok", sources: "ok" });
  });
});

test("A: a small reference is not marked truncated and has no omitted items", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const { ref } = await attached(env, "small1");
    script_fn(env, (n) => (n === 1 ? { tools: [{ name: "context.get", args: { reference_id: ref.reference_id } }] } : FINISH));
    const result = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    const back = JSON.parse(tool_json_text(env, 1));
    assert.equal(back.content.truncated ?? false, false);
    assert.equal(back.content.omitted_items ?? 0, 0);
    for (const item of back.content.items) assert.equal(item.truncated_fields, undefined);
  });
});

test("A: more than 40 short items are capped at 40 and the rest is counted", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env, { subscription_limits: BIG_LIMITS });
    const o = await open_stage(env, "plan");
    const src = await big_source(env, "many1", 44, 10);
    grant_access(env, src);
    const ref = (await ok(env, env.ctx("many1-att"), "reference.attach", { referenced_project_id: src.p.project_id, source_snapshot_id: src.snapshot_id, scope: ["sources"] })) as Record<string, any>;
    script_fn(env, (n) => (n === 1 ? { tools: [{ name: "context.get", args: { reference_id: ref.reference_id } }] } : FINISH));
    const result = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    const back = JSON.parse(tool_json_text(env, 1));
    assert.equal(back.content.items.length, 40);
    assert.equal(back.content.omitted_items, 4);
    assert.equal(back.content.truncated, true);
  });
});

// ---------------------------------------------------------------------------
// 필수 3 — legacy snapshots

const LEGACY_STAGE_ONLY = {
  pes: 1,
  topic: "합성 stage 스냅숏",
  slug: "synthetic-legacy-stage-only",
  created: "2026-02-01",
  current: "plan",
  complete: false,
  settings: {},
  processed: [],
  stages: { plan: { status: "approved", round: 0, approved_at: "2026-02-01 10:00", items: [] } },
};

function write_legacy(env: Env, name: string, project: unknown): string {
  const dir = join(env.home.root, `legacy-rf-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "project.json"), JSON.stringify(project), "utf8");
  return dir;
}

function snapshots_of(env: Env, project_id: string): Array<{ id: string; scope: string; round_id: string | null }> {
  return env.db.all<any>("SELECT id, scope, round_id FROM snapshots WHERE project_id = ? ORDER BY rowid", project_id);
}

async function attach_imported(env: Env, project_id: string, snapshot_id: string, key: string): Promise<Record<string, any>> {
  const user = owner_user_of(env.db, env.p.project_id);
  const member = env.db.get("SELECT 1 AS ok FROM project_members WHERE project_id = ? AND user_id = ?", project_id, user);
  if (member === undefined) env.db.run("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'editor')", project_id, user);
  return (await ok(env, env.ctx(key), "reference.attach", { referenced_project_id: project_id, source_snapshot_id: snapshot_id, scope: ["final_report", "sources", "decisions"] })) as Record<string, any>;
}

test("legacy import: an approved stage-scope snapshot (no round, no receipt, no content) reads as snapshot_content_unavailable, not as an empty 'none'", async () => {
  await with_legacy(async (env, api) => {
    const imported = await run_import(env, api, write_legacy(env, "stage", LEGACY_STAGE_ONLY));
    const stage_snap = snapshots_of(env, imported.project_id).find((s) => s.scope === "stage");
    assert.ok(stage_snap, "the importer made a stage-scope snapshot");
    assert.equal(stage_snap.round_id, null);
    const ref = await attach_imported(env, imported.project_id, stage_snap.id, "lg1-att");
    for (const ai of [false, true]) {
      const content = read(env, ref.reference_id, ai).content;
      assert.deepEqual(content.items, []);
      assert.deepEqual(content.items_status, { final_report: "snapshot_content_unavailable", sources: "snapshot_content_unavailable", decisions: "not_supported" });
    }
  });
});

test("legacy import: a round-scope snapshot with no stored contents is also unavailable (it cannot be proven empty)", async () => {
  await with_legacy(async (env, api) => {
    const complete = { ...LEGACY_STAGE_ONLY, slug: "synthetic-legacy-round", stages: { plan: { status: "approved", round: 1, approved_at: "2026-02-01 10:00", items: [] } } };
    const imported = await run_import(env, api, write_legacy(env, "round", complete));
    const round_snap = snapshots_of(env, imported.project_id).find((s) => s.scope === "round");
    assert.ok(round_snap, "the importer made a round-scope snapshot");
    assert.ok(round_snap.round_id, "it has a round");
    const ref = await attach_imported(env, imported.project_id, round_snap.id, "lg2-att");
    const content = read(env, ref.reference_id, false).content;
    assert.deepEqual(content.items, []);
    assert.equal(content.items_status.final_report, "snapshot_content_unavailable");
  });
});

test("native snapshot with a damaged receipt: no receipt versions and no round → snapshot_content_unavailable; the data is not invented", async () => {
  await with_cleanup(async (env) => {
    const { src, ref } = await attached(env, "dmg1");
    // a damaged receipt: still valid JSON (the table checks that) but without a readable versions list
    env.db.run(
      "UPDATE mutation_commits SET result_json = ? WHERE project_id = ? AND action = 'edition.snapshotted' AND json_extract(result_json, '$.snapshot_id') = ?",
      JSON.stringify({ snapshot_id: src.snapshot_id, versions: "damaged" }),
      src.p.project_id,
      src.snapshot_id,
    );
    const content = read(env, ref.reference_id, false).content;
    assert.deepEqual(content.items, []);
    assert.deepEqual(content.items_status, { final_report: "snapshot_content_unavailable", sources: "snapshot_content_unavailable" });
  });
});

// ---------------------------------------------------------------------------
// 권장 8 — B: reference_id with run_id / inputs_cursor

test("B: pes_context refuses reference_id together with run_id or inputs_cursor (invalid_payload) instead of silently ignoring them", async () => {
  await with_cleanup(async (env, open) => {
    const { ref } = await attached(env, "b8");
    const client = open(await env.client());
    await client.fails("pes_context", { reference_id: ref.reference_id, run_id: "run-x" }, "invalid_payload");
    await client.fails("pes_context", { reference_id: ref.reference_id, inputs_cursor: "c1" }, "invalid_payload");
    const fine = await client.ok("pes_context", { reference_id: ref.reference_id });
    assert.equal(fine.reference.id, ref.reference_id);
  });
});

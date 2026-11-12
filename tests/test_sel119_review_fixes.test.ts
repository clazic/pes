/**
 * SEL-119 U6a — 1차 리뷰(R1) 수정: 제거·보관된 산출물·가정·결정이 manifest `excluded` 에 이유와 함께 남아야 한다.
 *
 * 규칙(고치기 전에 이 시험들이 실패해야 한다):
 *   · 버전 status "removed" → {category: body|table, reason:"removed", object_id, version_id}
 *   · 버전 status "archived" 또는 객체 archived_at 이 있음 → reason:"archived"
 *   · 가정·결정 객체가 archived → {category:"assumption"|"decision", reason:"archived", object_id, version_id}
 *   · 고르지 않은 카테고리면 not_selected 가 우선 — 개별 항목은 기록하지 않는다.
 *   · 기록된 항목의 글은 본문(html)에 없고, 같은 manifest 를 다시 출력해도 excluded 가 같다.
 *   · (권장 1) include 에 footnote 만 있고 body/table 이 없으면 footnote item 도 manifest 에 쌓이지 않는다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { with_env, type Env } from "./helpers/blob_env.ts";
import { start } from "./helpers/editions_env.ts";
import { art, cite, items_of, ok, propose_assumption, propose_decision, stage_of, stored_html, stored_manifest } from "./helpers/sel119_env.ts";

async function scene(env: Env) {
  const plan = stage_of(env, "plan");
  const round = await start(env, plan, "rf-start");
  const kept = await art(env, "rf-kept", { stage_id: plan, body_md: "남는본문-알파", title: "남는제목-알파" });
  return { plan, round, kept };
}

const commit = (env: Env, payload: Record<string, unknown>, key: string) => ok(env, env.ctx(key), "print.commit", payload);
const excluded_of = (m: any, reason: string) => m.excluded.filter((e: any) => e.reason === reason);
const archive = (env: Env, object_id: string) => env.db.run("UPDATE objects SET archived_at = 1 WHERE id = ?", object_id);

test("a removed or archived artifact is recorded in excluded with its reason and is not printed", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const removed = await art(env, "rf-removed", { stage_id: s.plan, body_md: "제거본문-베타", title: "제거제목-베타", status: "removed" });
    const arch_status = await art(env, "rf-arch-status", { stage_id: s.plan, kind: "table", body_md: "보관표-감마", title: "보관표제목-감마", status: "archived" });
    const arch_object = await art(env, "rf-arch-object", { stage_id: s.plan, body_md: "보관객체-델타", title: "보관객체제목-델타" });
    archive(env, arch_object.object_id);

    const m = stored_manifest(env, (await commit(env, { scope: "round", round_id: s.round.round_id }, "rf-1")).snapshot_id);
    assert.deepEqual(excluded_of(m, "removed"), [{ category: "body", reason: "removed", object_id: removed.object_id, version_id: removed.version_id }]);
    assert.deepEqual(
      excluded_of(m, "archived").map((e: any) => [e.category, e.object_id, e.version_id]),
      [
        ["table", arch_status.object_id, arch_status.version_id],
        ["body", arch_object.object_id, arch_object.version_id],
      ],
    );
    assert.deepEqual(items_of(m, "body").map((i) => i.version_id), [s.kept.version_id]);
    assert.equal(items_of(m, "table").length, 0);
    const html = stored_html(env, m);
    assert.match(html, /남는본문-알파/);
    assert.doesNotMatch(html, /제거본문-베타|제거제목-베타|보관표-감마|보관표제목-감마|보관객체-델타|보관객체제목-델타/);
  });
});

test("an archived assumption and decision are recorded in excluded as archived and are not items", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const a_keep = await propose_assumption(env, "rf-a-keep", "남는가정-엡실론");
    const a_arch = await propose_assumption(env, "rf-a-arch", "보관가정-제타");
    const d_keep = await propose_decision(env, "rf-d-keep", "남는결정-에타");
    const d_arch = await propose_decision(env, "rf-d-arch", "보관결정-쎄타");
    archive(env, a_arch.object_id);
    archive(env, d_arch.object_id);

    const m = stored_manifest(env, (await commit(env, { scope: "round", round_id: s.round.round_id }, "rf-2")).snapshot_id);
    assert.deepEqual(items_of(m, "assumption").map((i) => i.object_id), [a_keep.object_id]);
    assert.deepEqual(items_of(m, "decision").map((i) => i.object_id), [d_keep.object_id]);
    assert.deepEqual(excluded_of(m, "archived"), [
      { category: "assumption", reason: "archived", object_id: a_arch.object_id, version_id: a_arch.version_id },
      { category: "decision", reason: "archived", object_id: d_arch.object_id, version_id: d_arch.version_id },
    ]);
  });
});

test("a category that was not chosen is not_selected only: removed and archived items in it are not listed one by one", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    await art(env, "rf-removed-t", { stage_id: s.plan, kind: "table", body_md: "제거표-카파", title: "제거표제목-카파", status: "removed" });
    const a_arch = await propose_assumption(env, "rf-a2", "보관가정-람다");
    archive(env, a_arch.object_id);
    const m = stored_manifest(env, (await commit(env, { scope: "round", round_id: s.round.round_id, include: ["body"] }, "rf-3")).snapshot_id);
    assert.equal(excluded_of(m, "removed").length, 0);
    assert.equal(excluded_of(m, "archived").length, 0);
    assert.ok(m.excluded.some((e: any) => e.category === "table" && e.reason === "not_selected"));
    assert.ok(m.excluded.some((e: any) => e.category === "assumption" && e.reason === "not_selected"));
  });
});

test("the same manifest reprints the same excluded list and the same bytes, removed and archived included", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    await art(env, "rf-removed2", { stage_id: s.plan, body_md: "제거본문-뮤", title: "제거제목-뮤", status: "removed" });
    const arch = await art(env, "rf-arch2", { stage_id: s.plan, body_md: "보관본문-뉴", title: "보관제목-뉴" });
    archive(env, arch.object_id);
    const first = await commit(env, { scope: "round", round_id: s.round.round_id }, "rf-4a");
    const second = await commit(env, { scope: "round", round_id: s.round.round_id }, "rf-4b");
    const m1 = stored_manifest(env, first.snapshot_id);
    const m2 = stored_manifest(env, second.snapshot_id);
    assert.deepEqual(m2.excluded, m1.excluded);
    assert.equal(second.content_hash, first.content_hash);
    assert.equal(second.selection_hash, first.selection_hash);
    assert.equal(stored_html(env, m2), stored_html(env, m1));
  });
});

test("footnote without body or table: no footnote item is kept, because no printed text carries it", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    await cite(env, "rf-fn", s.kept.version_id);
    const m = stored_manifest(env, (await commit(env, { scope: "round", round_id: s.round.round_id, include: ["footnote"] }, "rf-5")).snapshot_id);
    assert.equal(items_of(m, "footnote").length, 0);
    assert.doesNotMatch(stored_html(env, m), /합성 출처 rf-fn/);
  });
});

// ---------------------------------------------------------------------------
// 리뷰 2회차 필수 1 — GET P/print 는 AI 출구다: AI 참조 금지(SEL-115) 자료의 제목·발췌·id·개수가 에이전트(비사람) 응답에 없어야 한다.
// 고정본은 사람이 만든 것이고 사람(소유자 세션)에게는 그대로 보인다.
// [leader 승인 · 최종 2회차 사용자 결정] 인쇄물은 사람용이다: 비사람의 GET P/print 는 금지 여부와 상관없이 403 forbidden 이고
// 부분 응답(manifest 허용 부분·withheld)은 없다. 그래서 아래 시험은 "부분 응답" 대신 "403, 흔적 0, 정책을 바꿔도 그대로"를 본다.

import { add_citation } from "../scripts/pes_core/content.ts";
import { assert_ok, call, make_agent, with_api, type ApiEnv } from "./helpers/api_env.ts";
import { P, new_material, set_access, wire_of } from "./helpers/sel115_env.ts";

const SECRET_QUOTE = "비공개발췌-QQ-9d41";

async function print_scene(env: ApiEnv) {
  const plan = stage_of(env, "plan");
  const round = await start(env, plan, "ai-start");
  const body = await art(env, "ai-body", { stage_id: plan, body_md: "공개본문-알파", title: "공개제목-알파" });
  return { plan, round, body };
}

async function material_cited_by(env: ApiEnv, body_version_id: string, label: string) {
  const secret = await new_material(env, label, { name: `비공개파일-${label}.txt`, marker: `SECRET-MARK-${label}`, extra: { title: `비공개제목-${label}` } });
  await add_citation(env.service, env.ctx(`${label}-cite`), { artifact_version_id: body_version_id, source_version_id: secret.data.version_id, quote: SECRET_QUOTE });
  return secret;
}

const owner_commit = async (env: ApiEnv, round_id: string, key: string) =>
  assert_ok(await call(env, { method: "POST", path: P(env, "/print/commit"), auth: "owner", body: { scope: "round", round_id }, key }), 201);
const print_get = (env: ApiEnv, auth: Parameters<typeof call>[1]["auth"], snapshot: string) =>
  call(env, { method: "GET", path: P(env, `/print?scope=round&snapshot=${snapshot}`), auth });

function leak_needles(secret: Awaited<ReturnType<typeof new_material>>, label: string): string[] {
  return [
    `비공개파일-${label}.txt`,
    `비공개제목-${label}`,
    SECRET_QUOTE,
    secret.data.object_id,
    secret.data.version_id,
    secret.blob.blob_id,
    secret.blob.sha256,
    secret.data.file_policy_id,
    `SECRET-MARK-${label}`,
  ];
}

test("GET print: an agent never gets a closed material's title, quote or id from a stored print (403); a human does; allow does not reopen it", async () => {
  await with_api(async (env) => {
    const s = await print_scene(env);
    // order matters: the closed citation first, so the allowed web citation is number 2 in the stored print and must come out as 1.
    const secret = await material_cited_by(env, s.body.version_id, "ai-a");
    await cite(env, "ai-open", s.body.version_id, "공개발췌-허용");
    assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
    const done = await owner_commit(env, s.round.round_id, "ai-commit-1");
    const agent = await make_agent(env, "ai-reader", ["context:read"]);
    const needles = leak_needles(secret, "ai-a");

    // the human sees the stored print as it is
    const human = await print_get(env, "owner", done.snapshot_id);
    assert.equal(human.status, 200);
    assert.ok(wire_of(human).includes(SECRET_QUOTE) && wire_of(human).includes("비공개제목-ai-a"), "the owner session still sees the whole print");
    assert.equal(typeof human.json.data.document, "string");
    assert.notEqual(human.json.data.output, null);
    assert.equal("withheld" in human.json.data, false, "the human response keeps its old shape");

    // the agent: 403 forbidden, closed material is in no part of the response, and there is no partial answer
    const res = await print_get(env, { token: agent.token }, done.snapshot_id);
    assert.equal(res.status, 403, JSON.stringify(res.json));
    for (const needle of needles) assert.ok(!wire_of(res).includes(needle), `agent GET print: "${needle}" must not appear`);
    assert.equal(res.json.data, undefined, "no data at all");

    // allow again → the agent is still refused: a print is a human's document, whatever the policies say
    assert_ok(await set_access(env, secret.data.file_policy_id, "allow"));
    const back = await print_get(env, { token: agent.token }, done.snapshot_id);
    assert.equal(back.status, 403);
    assert.equal((await print_get(env, "owner", done.snapshot_id)).status, 200);
  });
});

test("GET print: the latest-print form (no snapshot) is refused the same way for an agent", async () => {
  await with_api(async (env) => {
    const s = await print_scene(env);
    const secret = await material_cited_by(env, s.body.version_id, "ai-b");
    assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
    await owner_commit(env, s.round.round_id, "ai-commit-2");
    const agent = await make_agent(env, "ai-reader2", ["context:read"]);
    const res = await call(env, { method: "GET", path: P(env, "/print?scope=round"), auth: { token: agent.token } });
    assert.equal(res.status, 403);
    for (const needle of leak_needles(secret, "ai-b")) assert.ok(!wire_of(res).includes(needle), `latest print: "${needle}" must not appear`);
    assert.equal(res.json.data, undefined);
  });
});

test("GET print: a body whose text file is closed to AI is refused to an agent too (no title, no id, no document)", async () => {
  await with_api(async (env) => {
    const s = await print_scene(env);
    const marker = "SECRET-BODY-MARK-ai-c";
    const secret = await new_material(env, "ai-c", { name: "비공개본문-ai-c.txt", marker });
    const done = await owner_commit(env, s.round.round_id, "ai-commit-3");
    // a body kept as a file (legacy import shape): the version points at the material's blob
    env.db.run("UPDATE artifact_versions SET body_md = NULL, body_blob_id = ? WHERE version_id = ?", secret.blob.blob_id, s.body.version_id);
    assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
    const agent = await make_agent(env, "ai-reader3", ["context:read"]);
    const res = await print_get(env, { token: agent.token }, done.snapshot_id);
    assert.equal(res.status, 403);
    assert.ok(!wire_of(res).includes(s.body.version_id), "the body version id of a closed body is not named");
    assert.ok(!wire_of(res).includes("공개제목-알파"));
    assert.equal(res.json.data, undefined);
    assert.equal(print_get_human_has_body(await print_get(env, "owner", done.snapshot_id)), true);
  });
});
const print_get_human_has_body = (res: { json: any }): boolean => res.json.data.manifest.items.some((i: any) => i.category === "body");

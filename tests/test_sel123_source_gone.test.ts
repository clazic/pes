/**
 * SEL-123 REF1 후속 3번 — reference.source_gone 검증 (tester, 작성 모드).
 *
 * 근거: SEL-113-r1.md 권장 6 — ① snapshot_id 가 정말 이 원본 프로젝트의 스냅숏인지 안 본다(모르는 id 면 조용히 0건 + 영수증),
 * ② 영수증·사건(원본 프로젝트 쪽에 남는다)에 *참조하는 다른 프로젝트* 의 id 를 싣는다, ③ 승인·봉인 스냅숏도 남의 참조를 죽일 수 있다
 * (stage-1-db.md:47 "승인·봉인 스냅숏은 영구 보존, 삭제 가능한 원본/초안 스냅숏만 해제").
 *
 * 정한 인터페이스 (구현이 이 표를 따른다. 다르게 정하면 이 머리말만 고친다)
 *
 *  reference.source_gone {referenced_project_id, snapshot_id?}   (ctx = 원본 프로젝트의 사람 소유자 — 그대로)
 *   소속 검증   snapshot_id 를 주면 그것이 **이 원본 프로젝트(referenced_project_id)의 스냅숏**이어야 한다.
 *              모르는 id · 다른 프로젝트의 스냅숏 id → ApiError not_found, **쓰기 0**(state_signature 불변: 영수증·사건·참조 줄 모두 그대로).
 *   삭제 가능 조건  snapshot_id 를 준 해제는 "삭제 가능한 스냅숏"만 된다 = 봉인되지 않았고(scope 'round' 가 아님 — round.sealed 로 생긴 것)
 *              승인되지 않았다(approvals 가 가리키지 않음). 편집판 스냅숏(scope 'edition', edition.snapshotted)은 삭제 가능(초안).
 *              봉인 또는 승인된 스냅숏 → ApiError conflict, 쓰기 0. 프로젝트 전체 해제(snapshot_id 생략)는 프로젝트가 사라지는 일이라 이 조건을 안 건다.
 *   결과·영수증  {released_count: 정수}. **다른 프로젝트의 id 를 싣지 않는다** — 원본 프로젝트의 영수증(mutation_commits.result_json)과
 *              원본 프로젝트의 사건(events.payload) 어디에도 참조하는 프로젝트의 id(project_references.project_id)가 글자로 없다.
 *              (reference_id 는 있어도 된다. released 배열의 project_id 칸은 없어진다.)
 *   그대로    같은 tx 에서 비우고 tombstone, 사람만, 멱등, 다른 프로젝트·다른 스냅숏 참조는 그대로 — SEL-113 의 기존 규칙.
 *
 * 충돌하는 기존 시험: test_sel113_commands.test.ts 의 source_gone 시험 세 군데가 `out.released[…].project_id`·`noop.released` 를 단언한다
 * (released 배열이 사라지고 released_count 가 생기므로 구현과 함께 고쳐야 한다). 이 파일은 그 시험을 건드리지 않는다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { add_artifact, create_object } from "../scripts/pes_core/content.ts";
import { approve_stage, seal_round, start_round } from "../scripts/pes_core/editions.ts";
import { ctx_for, put_ready, with_env, type Env } from "./helpers/blob_env.ts";
import { stage_ids } from "./helpers/editions_env.ts";
import { add_new_version, attached, ref_row, type Source } from "./helpers/sel113_env.ts";
import { ok, refused } from "./helpers/sel93_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const owner_of = (src: Source, key: string) => ({ project_id: src.p.project_id, actor_id: src.p.actor_id, via: "cli" as const, client_request_id: key });

/** 원본 프로젝트의 plan 단계에 라운드를 열어 봉인하고(옵션: 승인) 그 스냅숏 id 를 돌려준다. */
async function sealed_snapshot(env: Env, src: Source, tag: string, approve: boolean): Promise<string> {
  const stage_id = stage_ids(env.db, src.p.edition_id).plan;
  const round = (await start_round(env.service, ctx_for(src.p, `${tag}-start`), { stage_id })).result as { round_id: string };
  const obj = ((await create_object(env.service, ctx_for(src.p, `${tag}-o`), { kind: "artifact", edition_id: src.p.edition_id })).result as { object_id: string }).object_id;
  const v = (await add_artifact(env.service, ctx_for(src.p, `${tag}-v`), { object_id: obj, artifact_kind: "chapter", title: `봉인 ${tag}`, summary: "합성" })).result as {
    object_id: string;
    version_id: string;
  };
  const versions = [{ object_id: v.object_id, version_id: v.version_id }];
  const blob = await put_ready(env, new TextEncoder().encode(JSON.stringify({ versions })), `${tag}-mf`, src.p);
  const sealed = (await seal_round(env.service, ctx_for(src.p, `${tag}-seal`), { round_id: round.round_id, manifest_blob_id: blob.blob_id, versions })).result as { snapshot_id: string };
  if (approve) await approve_stage(env.service, ctx_for(src.p, `${tag}-approve`), { stage_id, snapshot_id: sealed.snapshot_id });
  return sealed.snapshot_id;
}

// ---------------------------------------------------------------------------
// 소속 검증

test("source_gone: an unknown snapshot id is not_found and writes nothing (no receipt, no event, the reference stays active)", async () => {
  await with_env(async (env) => {
    const { src, ref } = await attached(env, "g1");
    const before = state_signature(env.db);
    await refused(env, owner_of(src, "g1-gone"), "reference.source_gone", { referenced_project_id: src.p.project_id, snapshot_id: "no-such-snapshot" }, "not_found");
    assert.equal(state_signature(env.db), before, "zero writes");
    assert.equal(ref_row(env.db, ref.reference_id)!.status, "active");
  });
});

test("source_gone: another project's snapshot id is not_found (the id is not enough), nothing written, the other project's reference untouched", async () => {
  await with_env(async (env) => {
    const mine = await attached(env, "g2-a");
    const other = await attached(env, "g2-b");
    const before = state_signature(env.db);
    // other.src's snapshot, named by the OWNER OF mine.src
    await refused(env, owner_of(mine.src, "g2-gone"), "reference.source_gone", { referenced_project_id: mine.src.p.project_id, snapshot_id: other.src.snapshot_id }, "not_found");
    // the current project's own snapshot, too
    const own = env.db.get<{ id: string }>("SELECT id FROM snapshots WHERE project_id = ? LIMIT 1", env.p.project_id);
    if (own !== undefined) {
      await refused(env, owner_of(mine.src, "g2-gone2"), "reference.source_gone", { referenced_project_id: mine.src.p.project_id, snapshot_id: own.id }, "not_found");
    }
    assert.equal(state_signature(env.db), before, "zero writes");
    assert.equal(ref_row(env.db, other.ref.reference_id)!.status, "active");
    assert.equal(ref_row(env.db, mine.ref.reference_id)!.status, "active");
  });
});

// ---------------------------------------------------------------------------
// 삭제 가능 조건

test("source_gone: a sealed round snapshot is permanent — conflict, nothing written, the reference stays active", async () => {
  await with_env(async (env) => {
    const { src, ref } = await attached(env, "g3");
    const sealed = await sealed_snapshot(env, src, "g3s", false);
    await ok(env, env.ctx("g3-refresh"), "reference.refresh", { reference_id: ref.reference_id, source_snapshot_id: sealed });
    const reference_id = ref.reference_id as string;
    const before = state_signature(env.db);
    await refused(env, owner_of(src, "g3-gone"), "reference.source_gone", { referenced_project_id: src.p.project_id, snapshot_id: sealed }, "conflict");
    assert.equal(state_signature(env.db), before, "zero writes");
    assert.equal(ref_row(env.db, reference_id)!.status, "active");
    assert.equal(ref_row(env.db, reference_id)!.source_snapshot_id, sealed);
  });
});

test("source_gone: an approved snapshot is permanent too — conflict, nothing written", async () => {
  await with_env(async (env) => {
    const src = (await attached(env, "g4")).src;
    const approved = await sealed_snapshot(env, src, "g4s", true);
    const before = state_signature(env.db);
    await refused(env, owner_of(src, "g4-gone"), "reference.source_gone", { referenced_project_id: src.p.project_id, snapshot_id: approved }, "conflict");
    assert.equal(state_signature(env.db), before, "zero writes");
  });
});

test("source_gone: a draft (edition) snapshot of the source can be released; others stay; whole-project release ignores the condition", async () => {
  await with_env(async (env) => {
    const { src, ref } = await attached(env, "g5");
    const v2 = await add_new_version(env, src, 2); // a second draft snapshot nobody points at
    const none = await ok(env, owner_of(src, "g5-none"), "reference.source_gone", { referenced_project_id: src.p.project_id, snapshot_id: v2.snapshot_id });
    assert.equal(none.released_count, 0);
    assert.equal(ref_row(env.db, ref.reference_id)!.status, "active");

    const one = await ok(env, owner_of(src, "g5-one"), "reference.source_gone", { referenced_project_id: src.p.project_id, snapshot_id: src.snapshot_id });
    assert.equal(one.released_count, 1);
    assert.equal(ref_row(env.db, ref.reference_id)!.status, "source_missing");

    // the project goes away while it holds a sealed + approved snapshot: allowed
    const b = await attached(env, "g5-b");
    await sealed_snapshot(env, b.src, "g5bs", true);
    const gone = await ok(env, owner_of(b.src, "g5-all"), "reference.source_gone", { referenced_project_id: b.src.p.project_id });
    assert.equal(gone.released_count, 1);
    assert.equal(ref_row(env.db, b.ref.reference_id)!.referenced_project_id, null);
  });
});

// ---------------------------------------------------------------------------
// 영수증·사건에 다른 프로젝트 id 가 없다

test("source_gone: the source project's receipt and events carry no id of the referencing project; the result is a count", async () => {
  await with_env(async (env) => {
    const { src, ref } = await attached(env, "g6");
    const out = await ok(env, owner_of(src, "g6-gone"), "reference.source_gone", { referenced_project_id: src.p.project_id });
    assert.equal(out.released_count, 1);
    assert.equal("released" in out, false, "no list of other projects' rows");
    assert.equal(JSON.stringify(out).includes(env.p.project_id), false, "the result has no foreign project id");

    const receipts = env.db.all<{ result_json: string }>("SELECT result_json FROM mutation_commits WHERE project_id = ? AND action LIKE 'reference.%'", src.p.project_id);
    assert.ok(receipts.length > 0, "the release left a receipt on the source");
    for (const r of receipts) assert.equal(r.result_json.includes(env.p.project_id), false, "receipt");
    const events = env.db.all<{ payload: string }>("SELECT payload FROM events WHERE project_id = ? AND type LIKE 'reference.%'", src.p.project_id);
    assert.ok(events.length > 0, "the release left an event on the source");
    for (const e of events) assert.equal(e.payload.includes(env.p.project_id), false, "event");
    assert.equal(ref_row(env.db, ref.reference_id)!.status, "source_missing", "the reference itself is still emptied");
  });
});

test("source_gone: replay with the same key is safe and gives the same count", async () => {
  await with_env(async (env) => {
    const { src } = await attached(env, "g7");
    const ctx = owner_of(src, "g7-gone");
    const first = await env.service.execute(ctx, "reference.source_gone", { referenced_project_id: src.p.project_id, snapshot_id: src.snapshot_id });
    const again = await env.service.execute(ctx, "reference.source_gone", { referenced_project_id: src.p.project_id, snapshot_id: src.snapshot_id });
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, first.result);
    assert.equal((first.result as { released_count: number }).released_count, 1);
  });
});

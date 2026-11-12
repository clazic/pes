/**
 * SEL-113 REF1a — 참고자료 명령: reference.attach · detach · refresh · source_gone (tester, 작성 모드).
 * 구현 전에는 네 명령이 등록돼 있지 않아 실패하는 것이 정상.
 *
 * 있던 것(회귀 가드로 쓴다): DDL project_references(001_initial.sql) — 자기 참조 CHECK, 복합 FK(원본 스냅숏), status 3값,
 *   source_missing 이면 source_snapshot_id·latest_snapshot_id 가 NULL, rev 정수. 새 표·새 마이그레이션 없음.
 *   없던 것: 위 표를 쓰는 명령·읽기·API 전부.
 *
 * 정한 인터페이스 (표 — 아래를 구현의 정답으로 삼는다. 다르게 정하면 이 표와 helpers/sel113_env.ts 만 고친다)
 *
 *  명령                  입력                                                 결과 / 규칙
 *  reference.attach      {referenced_project_id, source_snapshot_id?,         결과 {reference_id, referenced_project_id, source_snapshot_id, source_snapshot_key,
 *                         scope?: string[], source_label?}                       source_label, scope, status:'active', rev:0}
 *                                                                              사람 소유자(현재 프로젝트)만. 에이전트 → forbidden. 호출한 사람이 원본 프로젝트의 구성원이 아니면
 *                                                                              forbidden 또는 not_found(내용·존재를 알리지 않음). 자기 자신 → invalid_payload.
 *                                                                              모르는 프로젝트/스냅숏, 다른 프로젝트의 스냅숏 → not_found. 같은 원본을 이미 붙임(스냅숏이 같든 다르든) → conflict
 *                                                                              (버전 바꾸기는 refresh). 떼고 나면 다시 붙일 수 있다. 서로 다른 원본 여러 개 가능.
 *                                                                              source_snapshot_id 생략 = 원본의 가장 나중 스냅숏. scope 생략 = ["final_report","sources"].
 *                                                                              scope 값 = final_report|stage_report|sources|decisions|questions_answers|files (비어 있거나 모르는 값/중복 → invalid_payload)
 *                                                                              source_label 생략 = 원본 프로젝트의 slug 또는 topic. 안정 key: referenced_project_key = 원본 프로젝트 id,
 *                                                                              source_snapshot_key = 고정한 스냅숏 id. latest_snapshot_id = 붙일 때 고정한 스냅숏. attached_at = 시계 ms.
 *  reference.detach      {reference_id}                                        결과 {reference_id, detached:true}. 행을 지운다(이력은 영수증·사건). 모르는/다른 프로젝트의 id → not_found. 사람만.
 *  reference.refresh     {reference_id, source_snapshot_id?, base_rev?}        결과 {reference_id, source_snapshot_id, source_snapshot_key, previous_snapshot_id, rev}. 다른 스냅숏으로 다시 고정,
 *                                                                              rev+1, refreshed_at = 시계 ms. 생략 = 가장 나중 스냅숏. 이미 그 스냅숏 → conflict. base_rev 가 낡으면 rev_conflict.
 *                                                                              source_missing 인 줄 → conflict. 다른 프로젝트 스냅숏 → not_found. 사람만. 원본은 건드리지 않는다.
 *  reference.source_gone {referenced_project_id, snapshot_id?}                 (ctx = 원본 프로젝트 사람 소유자) 원본 프로젝트(snapshot_id 생략) 또는 그 스냅숏 하나가 사라질 때, 그것을 가리키는
 *                                                                              모든 참조를 **같은 tx 에서** source_snapshot_id·latest_snapshot_id 를 NULL 로 비우고 status='source_missing'. key·label·scope 보존.
 *                                                                              프로젝트가 사라지면 referenced_project_id 도 NULL. rev+1. 결과 {released:[{reference_id, project_id}]}. 사람만. 다른 스냅숏/프로젝트 참조는 그대로.
 *
 *  영수증/사건: 명령마다 mutation_commits 한 줄(action /^reference\./)과 같은 tx_id 의 사건 /^reference\./ (payload.reference_id). 같은 키 재전송 = replayed:true,
 *  같은 키 다른 본문 = idempotency_key_reuse, 거절은 아무것도 쓰지 않는다(state_signature 불변). 원본 프로젝트의 행은 attach/refresh/detach 가 바꾸지 않는다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { COMMANDS } from "../scripts/pes_core/commands.ts";
import { with_env, type Env } from "./helpers/blob_env.ts";
import { project_rows } from "./helpers/backup_fixture.ts";
import {
  DEFAULT_SCOPE,
  add_new_version,
  attach_ref,
  attached,
  grant_access,
  last_event_seq,
  make_source,
  owner_user_of,
  receipt_actions,
  ref_count,
  ref_events,
  ref_row,
  ref_rows,
} from "./helpers/sel113_env.ts";
import { agent_of, agent_with_key, ok, refused } from "./helpers/sel93_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const NAMES = ["reference.attach", "reference.detach", "reference.refresh", "reference.source_gone"];

function source_rows(env: Env, src: { p: { project_id: string }; user_id: string }) {
  return project_rows(env.db, src.p.project_id, src.user_id);
}

test("the four reference commands are registered", () => {
  for (const name of NAMES) assert.ok(COMMANDS.has(name), `${name} is a registered command`);
});

// ---------------------------------------------------------------------------
// attach

test("attach: pins the chosen source snapshot; the row carries the stable keys, label, default scope and who/when", async () => {
  await with_env(async (env) => {
    const { src, ref } = await attached(env, "a1");
    assert.equal(ref.status, "active");
    assert.equal(ref.rev, 0);
    assert.equal(ref.referenced_project_id, src.p.project_id);
    assert.equal(ref.source_snapshot_id, src.snapshot_id);
    assert.deepEqual(ref.scope, DEFAULT_SCOPE, "default items are the final report and the sources");
    const row = ref_row(env.db, ref.reference_id);
    assert.ok(row, "one project_references row");
    assert.equal(row.project_id, env.p.project_id);
    assert.equal(row.referenced_project_id, src.p.project_id);
    assert.equal(row.referenced_project_key, src.p.project_id, "stable key = the source project id");
    assert.equal(row.source_snapshot_id, src.snapshot_id);
    assert.equal(row.source_snapshot_key, src.snapshot_id, "snapshot key = the pinned snapshot id");
    assert.equal(row.latest_snapshot_id, src.snapshot_id);
    assert.deepEqual(JSON.parse(row.scope_json), DEFAULT_SCOPE);
    assert.equal(row.status, "active");
    assert.equal(row.attached_by_actor_id, env.p.actor_id);
    assert.equal(row.attached_by_user_id, owner_user_of(env.db, env.p.project_id));
    assert.equal(row.attached_at, env.clock.now_ms());
    assert.equal(row.refreshed_at, null);
    assert.equal(row.rev, 0);
    assert.ok(row.source_label.length > 0);
    assert.equal(ref.source_label, row.source_label);
  });
});

test("attach: a given label is kept; the default label names the source project; a custom scope is stored in order", async () => {
  await with_env(async (env) => {
    const a = await make_source(env, "lab");
    grant_access(env, a);
    const out = await ok(env, env.ctx("lab-1"), "reference.attach", {
      referenced_project_id: a.p.project_id,
      source_snapshot_id: a.snapshot_id,
      source_label: "장기요양 실태 1판(합성)",
      scope: ["sources", "final_report", "decisions"],
    });
    assert.equal(out.source_label, "장기요양 실태 1판(합성)");
    assert.deepEqual(ref_row(env.db, out.reference_id)!.scope_json, JSON.stringify(["sources", "final_report", "decisions"]));
    const b = await make_source(env, "lab2");
    grant_access(env, b);
    const dflt = await ok(env, env.ctx("lab-2"), "reference.attach", { referenced_project_id: b.p.project_id });
    const slug_or_topic = env.db.get<{ slug: string; topic: string }>("SELECT slug, topic FROM projects WHERE id = ?", b.p.project_id)!;
    assert.ok([slug_or_topic.slug, slug_or_topic.topic].includes(dflt.source_label), `default label ${dflt.source_label} names the source`);
  });
});

test("attach without a snapshot pins the source's newest snapshot; an explicit older snapshot stays pinned even when newer exist", async () => {
  await with_env(async (env) => {
    const src = await make_source(env, "pin");
    grant_access(env, src);
    const v2 = await add_new_version(env, src, 2);
    const newest = await ok(env, env.ctx("pin-n"), "reference.attach", { referenced_project_id: src.p.project_id });
    assert.equal(newest.source_snapshot_id, v2.snapshot_id);
    await ok(env, env.ctx("pin-d"), "reference.detach", { reference_id: newest.reference_id });
    const old = await ok(env, env.ctx("pin-o"), "reference.attach", { referenced_project_id: src.p.project_id, source_snapshot_id: src.snapshot_id });
    assert.equal(old.source_snapshot_id, src.snapshot_id, "the person's choice wins over the newest");
    assert.equal(ref_row(env.db, old.reference_id)!.source_snapshot_key, src.snapshot_id);
  });
});

test("attach: every documented item is accepted; empty, unknown, duplicated or non-string items are refused", async () => {
  await with_env(async (env) => {
    const src = await make_source(env, "sc");
    grant_access(env, src);
    const good = ["final_report", "stage_report", "sources", "decisions", "questions_answers", "files"];
    const out = await attach_ref(env, src, "sc-all", { scope: good });
    assert.deepEqual(ref_row(env.db, out.reference_id)!.scope_json, JSON.stringify(good));
    await ok(env, env.ctx("sc-d"), "reference.detach", { reference_id: out.reference_id });
    const sig = state_signature(env.db);
    const bad: unknown[] = [[], ["nope"], ["sources", "sources"], [1], "sources", null, ["final_report", ""]];
    for (const [i, scope] of bad.entries()) {
      await refused(env, env.ctx(`sc-bad-${i}`), "reference.attach", { referenced_project_id: src.p.project_id, source_snapshot_id: src.snapshot_id, scope }, "invalid_payload");
    }
    await refused(env, env.ctx("sc-extra"), "reference.attach", { referenced_project_id: src.p.project_id, surprise: 1 }, "invalid_payload");
    await refused(env, env.ctx("sc-miss"), "reference.attach", {}, "invalid_payload");
    assert.equal(state_signature(env.db), sig, "no refusal wrote anything");
  });
});

test("attach: a project cannot reference itself (refused by the service, not by a SQL CHECK)", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    const err = await refused(env, env.ctx("self"), "reference.attach", { referenced_project_id: env.p.project_id }, "invalid_payload");
    assert.doesNotMatch(err.message, /CHECK|constraint|sqlite/i, "no SQL text in the message");
    assert.equal(state_signature(env.db), sig);
    assert.equal(ref_count(env.db), 0);
  });
});

test("attach: unknown project, unknown snapshot and another project's snapshot are not_found; nothing is written", async () => {
  await with_env(async (env) => {
    const a = await make_source(env, "nf-a");
    const b = await make_source(env, "nf-b");
    grant_access(env, a);
    grant_access(env, b);
    const sig = state_signature(env.db);
    await refused(env, env.ctx("nf-1"), "reference.attach", { referenced_project_id: "no-such-project" }, "not_found");
    await refused(env, env.ctx("nf-2"), "reference.attach", { referenced_project_id: a.p.project_id, source_snapshot_id: "no-such-snapshot" }, "not_found");
    await refused(env, env.ctx("nf-3"), "reference.attach", { referenced_project_id: a.p.project_id, source_snapshot_id: b.snapshot_id }, "not_found");
    assert.equal(state_signature(env.db), sig);
  });
});

test("attach: the same source cannot be attached twice (same or other snapshot) — conflict; detach frees it; several different sources are fine", async () => {
  await with_env(async (env) => {
    const { src, ref } = await attached(env, "dup");
    const v2 = await add_new_version(env, src, 2);
    const sig = state_signature(env.db);
    await refused(env, env.ctx("dup-same"), "reference.attach", { referenced_project_id: src.p.project_id, source_snapshot_id: src.snapshot_id }, "conflict");
    await refused(env, env.ctx("dup-other"), "reference.attach", { referenced_project_id: src.p.project_id, source_snapshot_id: v2.snapshot_id }, "conflict");
    assert.equal(state_signature(env.db), sig);
    assert.equal(ref_rows(env.db, env.p.project_id).length, 1);

    const second = await make_source(env, "dup2");
    grant_access(env, second);
    await attach_ref(env, second, "dup-2nd");
    assert.equal(ref_rows(env.db, env.p.project_id).length, 2, "one or more earlier projects");

    await ok(env, env.ctx("dup-det"), "reference.detach", { reference_id: ref.reference_id });
    const again = await attach_ref(env, src, "dup-again", { source_snapshot_id: v2.snapshot_id });
    assert.notEqual(again.reference_id, ref.reference_id, "a new row, not the old one revived");
  });
});

test("attach: needs access to BOTH projects — a person with no membership in the source is refused and learns nothing", async () => {
  await with_env(async (env) => {
    const src = await make_source(env, "perm");
    // no grant_access: the current project's owner is not a member of the source
    const sig = state_signature(env.db);
    const err = await refused(env, env.ctx("perm-1"), "reference.attach", { referenced_project_id: src.p.project_id, source_snapshot_id: src.snapshot_id }, "forbidden", "not_found");
    const text = JSON.stringify({ message: err.message, details: err.details });
    assert.ok(!text.includes(src.report_marker) && !text.includes(src.source_marker), "no content in the refusal");
    assert.equal(state_signature(env.db), sig);
    grant_access(env, src, "editor");
    const out = await attach_ref(env, src, "perm-2");
    assert.equal(out.status, "active");
  });
});

test("attach/refresh/detach are human-only: an agent actor is refused and nothing is written", async () => {
  await with_env(async (env) => {
    const { src, ref } = await attached(env, "hum");
    const v2 = await add_new_version(env, src, 2);
    const agent = agent_of(env, "agent-ref");
    const sig = state_signature(env.db);
    await refused(env, agent_with_key(agent, "hum-a"), "reference.attach", { referenced_project_id: src.p.project_id }, "forbidden", "conflict");
    await refused(env, agent_with_key(agent, "hum-r"), "reference.refresh", { reference_id: ref.reference_id, source_snapshot_id: v2.snapshot_id }, "forbidden");
    await refused(env, agent_with_key(agent, "hum-d"), "reference.detach", { reference_id: ref.reference_id }, "forbidden");
    assert.equal(state_signature(env.db), sig);
  });
});

test("attach: receipt, events and the row share one transaction; the replay writes once; a different body under the same key is refused", async () => {
  await with_env(async (env) => {
    const src = await make_source(env, "tx");
    grant_access(env, src);
    const seq = last_event_seq(env.db);
    const first = await env.service.execute(env.ctx("tx-1"), "reference.attach", { referenced_project_id: src.p.project_id, source_snapshot_id: src.snapshot_id });
    const again = await env.service.execute(env.ctx("tx-1"), "reference.attach", { referenced_project_id: src.p.project_id, source_snapshot_id: src.snapshot_id });
    assert.equal(first.replayed, false);
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, first.result);
    assert.equal(ref_rows(env.db, env.p.project_id).length, 1);
    const actions = receipt_actions(env.db, env.p.project_id, "tx-%");
    assert.equal(actions.length, 1);
    assert.match(actions[0]!, /^reference\./);
    const receipt = env.db.get<{ id: string; actor_id: string }>("SELECT id, actor_id FROM mutation_commits WHERE project_id = ? AND client_request_id = 'tx-1'", env.p.project_id)!;
    assert.equal(receipt.actor_id, env.p.actor_id);
    const events = ref_events(env.db, env.p.project_id, seq);
    assert.equal(events.length, 1, "one event for one attach (the replay adds none)");
    assert.match(events[0]!.type, /^reference\./);
    assert.equal(events[0]!.tx_id, receipt.id, "the event belongs to the same transaction as the receipt");
    assert.equal(events[0]!.payload.reference_id, (first.result as any).reference_id);
    const b = await make_source(env, "tx-b");
    grant_access(env, b);
    await refused(env, env.ctx("tx-1"), "reference.attach", { referenced_project_id: b.p.project_id }, "idempotency_key_reuse", "conflict");
    assert.equal(ref_rows(env.db, env.p.project_id).length, 1);
  });
});

test("attach, refresh and detach never change the source project's rows", async () => {
  await with_env(async (env) => {
    const src = await make_source(env, "ro");
    grant_access(env, src);
    const v2 = await add_new_version(env, src, 2);
    const before = source_rows(env, src);
    const ref = await attach_ref(env, src, "ro-a", { source_snapshot_id: src.snapshot_id });
    assert.deepEqual(source_rows(env, src), before, "attach: source untouched");
    await ok(env, env.ctx("ro-r"), "reference.refresh", { reference_id: ref.reference_id, source_snapshot_id: v2.snapshot_id });
    assert.deepEqual(source_rows(env, src), before, "refresh: source untouched");
    await ok(env, env.ctx("ro-d"), "reference.detach", { reference_id: ref.reference_id });
    assert.deepEqual(source_rows(env, src), before, "detach: source untouched");
    assert.deepEqual(env.db.all("PRAGMA foreign_key_check"), []);
  });
});

// ---------------------------------------------------------------------------
// detach

test("detach: the row is gone, the source and its snapshots stay, receipt and event say what happened, a replay is safe", async () => {
  await with_env(async (env) => {
    const { src, ref } = await attached(env, "det");
    const seq = last_event_seq(env.db);
    const snapshots_before = Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM snapshots WHERE project_id = ?", src.p.project_id)!.n);
    const first = await env.service.execute(env.ctx("det-1"), "reference.detach", { reference_id: ref.reference_id });
    assert.deepEqual(first.result, { reference_id: ref.reference_id, detached: true });
    assert.equal(ref_row(env.db, ref.reference_id), undefined);
    assert.equal(Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM snapshots WHERE project_id = ?", src.p.project_id)!.n), snapshots_before);
    const again = await env.service.execute(env.ctx("det-1"), "reference.detach", { reference_id: ref.reference_id });
    assert.equal(again.replayed, true);
    const actions = receipt_actions(env.db, env.p.project_id, "det-%");
    assert.deepEqual(actions.map((a) => /^reference\./.test(a)), [true]);
    const events = ref_events(env.db, env.p.project_id, seq);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.payload.reference_id, ref.reference_id);
    const tx = env.db.get<{ id: string }>("SELECT id FROM mutation_commits WHERE project_id = ? AND client_request_id = 'det-1'", env.p.project_id)!.id;
    assert.equal(events[0]!.tx_id, tx);
  });
});

test("detach: an unknown id, a second detach under a new key, and another project's reference are not_found and write nothing", async () => {
  await with_env(async (env) => {
    const { ref } = await attached(env, "det2");
    await ok(env, env.ctx("det2-1"), "reference.detach", { reference_id: ref.reference_id });
    const other = await make_source(env, "det2-other"); // a second, unrelated project to act as the "other" side
    await refused(env, env.ctx("det2-2"), "reference.detach", { reference_id: ref.reference_id }, "not_found");
    await refused(env, env.ctx("det2-3"), "reference.detach", { reference_id: "no-such-ref" }, "not_found");
    await refused(env, env.ctx("det2-4"), "reference.detach", {}, "invalid_payload");
    // a reference that belongs to ANOTHER project cannot be detached from this one
    const mine = await attached(env, "det2-mine");
    const sig = state_signature(env.db);
    const other_ctx = { project_id: other.p.project_id, actor_id: other.p.actor_id, via: "cli" as const, client_request_id: "det2-x" };
    await refused(env, other_ctx, "reference.detach", { reference_id: mine.ref.reference_id }, "not_found");
    assert.ok(ref_row(env.db, mine.ref.reference_id), "still attached");
    assert.equal(state_signature(env.db), sig, "the refusal wrote nothing");
  });
});

// ---------------------------------------------------------------------------
// refresh

test("refresh: re-pins to another snapshot of the same source — rev+1, previous kept in the result, old snapshot and source untouched, scope kept", async () => {
  await with_env(async (env) => {
    const { src, ref } = await attached(env, "rf", { scope: ["sources", "decisions"] });
    const v2 = await add_new_version(env, src, 2);
    const clock_before = env.clock.now_ms();
    env.clock.advance(5000);
    const seq = last_event_seq(env.db);
    const before = source_rows(env, src);
    const out = await ok(env, env.ctx("rf-1"), "reference.refresh", { reference_id: ref.reference_id, source_snapshot_id: v2.snapshot_id });
    assert.equal(out.reference_id, ref.reference_id);
    assert.equal(out.source_snapshot_id, v2.snapshot_id);
    assert.equal(out.source_snapshot_key, v2.snapshot_id);
    assert.equal(out.previous_snapshot_id, src.snapshot_id);
    assert.equal(out.rev, 1);
    const row = ref_row(env.db, ref.reference_id)!;
    assert.equal(row.source_snapshot_id, v2.snapshot_id);
    assert.equal(row.source_snapshot_key, v2.snapshot_id);
    assert.equal(row.rev, 1);
    assert.equal(row.refreshed_at, clock_before + 5000);
    assert.equal(row.status, "active");
    assert.deepEqual(JSON.parse(row.scope_json), ["sources", "decisions"], "the chosen items survive a refresh");
    assert.equal(row.attached_at, clock_before, "attach time and person are not rewritten");
    assert.equal(row.attached_by_actor_id, env.p.actor_id);
    assert.deepEqual(source_rows(env, src), before, "the source is not modified");
    const events = ref_events(env.db, env.p.project_id, seq);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.payload.reference_id, ref.reference_id);
    assert.deepEqual(receipt_actions(env.db, env.p.project_id, "rf-%").map((a) => /^reference\./.test(a)), [true]);
  });
});

test("refresh without a snapshot goes to the newest; the same snapshot again, a stale base_rev, a foreign snapshot and an unknown reference are refused", async () => {
  await with_env(async (env) => {
    const { src, ref } = await attached(env, "rf2");
    const sig0 = state_signature(env.db);
    await refused(env, env.ctx("rf2-same0"), "reference.refresh", { reference_id: ref.reference_id }, "conflict"); // newest == pinned
    assert.equal(state_signature(env.db), sig0, "already the newest: nothing to do");
    const v2 = await add_new_version(env, src, 2);
    const stranger = await make_source(env, "rf2-x");
    const out = await ok(env, env.ctx("rf2-1"), "reference.refresh", { reference_id: ref.reference_id, base_rev: 0 });
    assert.equal(out.source_snapshot_id, v2.snapshot_id);
    const sig = state_signature(env.db);
    await refused(env, env.ctx("rf2-2"), "reference.refresh", { reference_id: ref.reference_id, source_snapshot_id: v2.snapshot_id }, "conflict");
    await refused(env, env.ctx("rf2-3"), "reference.refresh", { reference_id: ref.reference_id, source_snapshot_id: src.snapshot_id, base_rev: 0 }, "rev_conflict");
    await refused(env, env.ctx("rf2-4"), "reference.refresh", { reference_id: ref.reference_id, source_snapshot_id: stranger.snapshot_id }, "not_found");
    await refused(env, env.ctx("rf2-5"), "reference.refresh", { reference_id: "no-such-ref" }, "not_found");
    await refused(env, env.ctx("rf2-6"), "reference.refresh", { reference_id: ref.reference_id, source_snapshot_id: "no-such" }, "not_found");
    assert.equal(state_signature(env.db), sig);
    // going back to an older snapshot is allowed (the person chooses)
    const back = await ok(env, env.ctx("rf2-7"), "reference.refresh", { reference_id: ref.reference_id, source_snapshot_id: src.snapshot_id, base_rev: 1 });
    assert.equal(back.source_snapshot_id, src.snapshot_id);
    assert.equal(back.rev, 2);
  });
});

test("refresh: same key replays once; the same key with another snapshot is refused", async () => {
  await with_env(async (env) => {
    const { src, ref } = await attached(env, "rf3");
    const v2 = await add_new_version(env, src, 2);
    const v3 = await add_new_version(env, src, 3);
    const a = await env.service.execute(env.ctx("rf3-1"), "reference.refresh", { reference_id: ref.reference_id, source_snapshot_id: v2.snapshot_id });
    const b = await env.service.execute(env.ctx("rf3-1"), "reference.refresh", { reference_id: ref.reference_id, source_snapshot_id: v2.snapshot_id });
    assert.equal(b.replayed, true);
    assert.deepEqual(b.result, a.result);
    assert.equal(ref_row(env.db, ref.reference_id)!.rev, 1);
    await refused(env, env.ctx("rf3-1"), "reference.refresh", { reference_id: ref.reference_id, source_snapshot_id: v3.snapshot_id }, "idempotency_key_reuse", "conflict");
    assert.equal(ref_row(env.db, ref.reference_id)!.source_snapshot_id, v2.snapshot_id);
  });
});

// ---------------------------------------------------------------------------
// source gone → tombstone

test("source_gone (one snapshot): pointers are emptied EXPLICITLY in the same tx, status source_missing, key/label/scope/project link kept", async () => {
  await with_env(async (env) => {
    const { src, ref } = await attached(env, "gone");
    const v2 = await add_new_version(env, src, 2); // a second, unreferenced snapshot
    const seq = last_event_seq(env.db);
    const out = await ok(env, { project_id: src.p.project_id, actor_id: src.p.actor_id, via: "cli", client_request_id: "gone-1" }, "reference.source_gone", {
      referenced_project_id: src.p.project_id,
      snapshot_id: src.snapshot_id,
    });
    assert.deepEqual(out.released.map((r: any) => r.reference_id), [ref.reference_id]);
    assert.equal(out.released[0].project_id, env.p.project_id);
    const row = ref_row(env.db, ref.reference_id)!;
    assert.equal(row.status, "source_missing");
    assert.equal(row.source_snapshot_id, null);
    assert.equal(row.latest_snapshot_id, null);
    assert.equal(row.referenced_project_id, src.p.project_id, "the project still exists: only the snapshot link is released");
    assert.equal(row.referenced_project_key, src.p.project_id);
    assert.equal(row.source_snapshot_key, src.snapshot_id, "the last pinned version stays identifiable");
    assert.equal(row.source_label, ref.source_label);
    assert.deepEqual(JSON.parse(row.scope_json), DEFAULT_SCOPE);
    assert.equal(row.rev, 1);
    assert.deepEqual(env.db.all("PRAGMA foreign_key_check"), []);
    // one transaction: the receipt of the source's command and the events share a tx id
    const tx = env.db.get<{ id: string }>("SELECT id FROM mutation_commits WHERE project_id = ? AND client_request_id = 'gone-1'", src.p.project_id)!;
    const events = env.db.all<any>("SELECT type, tx_id, payload FROM events WHERE tx_id = ?", tx.id).filter((e) => /^reference\./.test(e.type));
    assert.equal(events.length, 1);
    assert.equal(JSON.parse(events[0].payload).reference_id, ref.reference_id);
    assert.ok(last_event_seq(env.db) > seq);
    void v2;
  });
});

test("source_gone (whole project): referenced_project_id is emptied too; an unrelated reference and an unrelated snapshot are left alone", async () => {
  await with_env(async (env) => {
    const a = await attached(env, "pg-a");
    const b = await attached(env, "pg-b");
    const a_ctx = { project_id: a.src.p.project_id, actor_id: a.src.p.actor_id, via: "cli" as const, client_request_id: "pg-1" };
    // a snapshot that no reference points at: releasing it changes nothing
    const v2 = await add_new_version(env, a.src, 2);
    const noop = await ok(env, { ...a_ctx, client_request_id: "pg-0" }, "reference.source_gone", { referenced_project_id: a.src.p.project_id, snapshot_id: v2.snapshot_id });
    assert.deepEqual(noop.released, []);
    assert.equal(ref_row(env.db, a.ref.reference_id)!.status, "active");

    const out = await ok(env, a_ctx, "reference.source_gone", { referenced_project_id: a.src.p.project_id });
    assert.deepEqual(out.released.map((r: any) => r.reference_id), [a.ref.reference_id]);
    const row = ref_row(env.db, a.ref.reference_id)!;
    assert.equal(row.status, "source_missing");
    assert.equal(row.referenced_project_id, null);
    assert.equal(row.source_snapshot_id, null);
    assert.equal(row.latest_snapshot_id, null);
    assert.equal(row.referenced_project_key, a.src.p.project_id, "the key survives the project");
    assert.equal(row.source_snapshot_key, a.src.snapshot_id);
    assert.equal(row.source_label, a.ref.source_label);
    const other = ref_row(env.db, b.ref.reference_id)!;
    assert.equal(other.status, "active", "another project's reference is untouched");
    assert.equal(other.source_snapshot_id, b.src.snapshot_id);
    assert.deepEqual(env.db.all("PRAGMA foreign_key_check"), []);
  });
});

test("source_gone: replay is safe; an agent cannot trigger it; a tombstone can be detached but not refreshed", async () => {
  await with_env(async (env) => {
    const { src, ref } = await attached(env, "tomb");
    const owner_ctx = { project_id: src.p.project_id, actor_id: src.p.actor_id, via: "cli" as const, client_request_id: "tomb-1" };
    const first = await env.service.execute(owner_ctx, "reference.source_gone", { referenced_project_id: src.p.project_id });
    const again = await env.service.execute(owner_ctx, "reference.source_gone", { referenced_project_id: src.p.project_id });
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, first.result);
    assert.equal(ref_row(env.db, ref.reference_id)!.rev, 1, "the replay did not bump rev");
    // an agent of the source project is not a human owner
    env.db.run(
      "INSERT INTO actors (id, kind, user_id, display_name) VALUES ('agent-src', 'external_agent', ?, '합성 에이전트')",
      src.user_id,
    );
    await refused(env, { ...owner_ctx, actor_id: "agent-src", client_request_id: "tomb-2" }, "reference.source_gone", { referenced_project_id: src.p.project_id }, "forbidden");
    // a person of the CURRENT project may not tell the service that someone else's source is gone
    await refused(env, env.ctx("tomb-3"), "reference.source_gone", { referenced_project_id: src.p.project_id }, "forbidden", "not_found", "invalid_payload");
    await refused(env, env.ctx("tomb-4"), "reference.refresh", { reference_id: ref.reference_id }, "conflict");
    await ok(env, env.ctx("tomb-5"), "reference.detach", { reference_id: ref.reference_id });
    assert.equal(ref_row(env.db, ref.reference_id), undefined, "a tombstone can still be removed by a person");
  });
});

/**
 * SEL-119 U6a — 범위 인쇄 서버: 명령 print.prepare · print.commit (tester, 작성 모드).
 * 구현 전에는 두 명령이 없어 실패하는 것이 정상. 인쇄 화면·print.css 는 이 이슈 밖이다.
 *
 * 있던 것: snapshots(scope edition|stage|round, manifest_blob_id, content_hash), blobs(PR9), 봉인(round.seal)·승인(stage.approve) 스냅숏,
 *   round_contents, artifacts.stage_id + objects.current_version_id, citations, assumption/decision/reflection 명령(SEL-93).
 * 없던 것: 인쇄 명령 · 인쇄 고정본 읽기. **새 표는 만들지 않는다**(snapshots + blobs 만 쓴다).
 *
 * ── 정한 인터페이스 ──────────────────────────────────────────────────────────────
 * | 명령 | 입력 | 결과 |
 * |---|---|---|
 * | print.prepare | {scope, round_id?, stage_id?, edition_id?, all_editions?, confirm_volume?, include?} | {project_id, scope, manifest, selection_hash, volume:{editions,stages,items,bytes}, confirm_required} |
 * | print.commit  | prepare 와 같은 입력 + selection_hash? | {project_id, snapshot_id, scope, manifest_blob_id, output_blob_id, content_hash, selection_hash} |
 *
 *   scope  "round"|"stage"|"edition" 만. 그 밖(예: "project")·없음·알 수 없는 필드 → invalid_payload.
 *   기본 범위(id 생략): round → 현재 단계(editions.current_stage_id)의 현재 라운드(stages.current_round_id), stage → 현재 단계,
 *     edition → 활성 판(projects.active_edition_id). 모르는 id → not_found.
 *   all_editions(기본 false, scope "edition" 에서만): 모든 판. confirm_volume(정수)이 **prepare 의 volume.items 와 같을 때만** commit 허용
 *     (없거나 다르면 invalid_payload). prepare 는 confirm 없이도 되고 confirm_required=true 와 volume 을 돌려 준다. scope round|stage 에 주면 invalid_payload.
 *   include  부분집합 of ["body","table","footnote","comment","assumption","decision","reflection"], 기본 = 일곱 개 전부. 빈 배열·모르는 이름 → invalid_payload.
 *   권한: 프로젝트 **읽기 권한이 있는 사람**(owner·editor·reader 구성원)이 실행. 에이전트(external_agent·internal_ai)는 기본 forbidden
 *     (별도 허가의 모양은 이 이슈에서 정하지 않는다). 구성원이 아닌 사람은 forbidden 또는 not_found. 거절은 아무것도 쓰지 않는다.
 *   print.prepare 가 쓰는 것: 영수증(mutation_commits action "print.prepared") + 사건 1개(type "print.prepared")뿐. snapshot·blob·파일은 0.
 *   print.commit  한 tx 에서: 출력물 blob(text/html, ready) + manifest blob(application/json, ready) + snapshots 행 1개 + 영수증(action "print.committed")
 *     + 사건 1개(type "print.committed", payload {snapshot_id, scope, manifest_blob_id, output_blob_id}). 중간에 실패하면 전부 되돌린다(행·파일 0).
 *     snapshots 행: scope = 요청 scope, round 면 round_id·stage_id, stage 면 stage_id, edition 이면 둘 다 NULL; manifest_blob_id = manifest blob;
 *     content_hash = 포함된 항목(category·object·version)의 sha256. **라운드는 건드리지 않는다**(state·sealed_snapshot_id·rev·round_contents 불변).
 *   같은 멱등 키 + 같은 입력 → replayed:true, 새 행 0. 같은 키 + 다른 입력 → idempotency_key_reuse.
 *
 * ── manifest (manifest blob 의 JSON, GET data.manifest 와 같다) ────────────────────
 *   { format_version:"1.0", kind:"print", scope, all_editions:bool, include:[카테고리…],
 *     targets:[{ edition_id, edition_no, stages:[{ stage_id, stage_key, round_id|null, round_no|null,
 *                 basis:"sealed"|"approved"|"open"|"none", basis_snapshot_id|null }] }],
 *     items:[{ category, object_id, version_id, stage_id|null, position }],     // reflection 항목은 object_id 대신 entry_id·source_version_id·round_id
 *     excluded:[{ category, reason, object_id?, version_id? }],
 *     comments:{ included:bool, items:[] },                                       // 첨언(U4) 칸은 자리만
 *     output:{ blob_id, sha256, size, media_type:"text/html" } | null }           // prepare 미리보기에서는 null, commit 에서 채워진다
 *   basis: 봉인 라운드 = "sealed"(basis_snapshot_id = 그 봉인 snapshot, 본문은 round_contents), 승인 단계 = "approved"(approved_snapshot_id),
 *     열린 라운드 = "open"(본문은 출력 시점 stages 의 산출물 현재 버전), 라운드 없는 단계 = "none".
 *   본문(body)/표(table) = artifact 종류 table 이면 table, chapter 등이면 body. 각주(footnote) = 포함된 산출물 버전의 citations
 *     → 항목 {category:"footnote", object_id, version_id(출처 버전), cited_by_version_id, citation_no}.
 *   가정/결정 = 판 전체 객체의 **출력 시점 현재 버전**을 version_id 로 고정(범위가 round 여도 판 전체). 반영(reflection) = 범위 안 라운드가 target 인 항목.
 *   excluded: 고르지 않은 카테고리마다 {category, reason:"not_selected"}; 미제출 초안(artifact_versions.status='draft')마다
 *     {category:"unsubmitted_draft", reason:"unsubmitted", object_id, version_id}; 토큰 스트림은 **항상 정확히 한 줄**
 *     {category:"token_stream", reason:"default_excluded"}.
 *   출력물 html: 포함된 body/table 항목의 title·body_md 와 각주 출처 title 이 들어 있고, 제외 항목(초안·고르지 않은 카테고리)의 글은 없다.
 *     html 은 포함 항목에서만 만들어진다(시각·사건 번호·키가 들어가지 않는다) — 같은 내용이면 같은 sha256.
 *   selection_hash = manifest 에서 output 을 뺀 canonical JSON 의 sha256. commit 이 selection_hash 를 받고 지금 계산한 값과 다르면 conflict.
 *
 * ── 스스로 정한 해석 ────────────────────────────────────────────────────────────
 *   · 명령 이름은 저장소 규칙(점 표기)에 맞춰 print.prepare / print.commit (이슈의 print_prepare/print_commit).
 *   · 열린 라운드의 "미제출 초안"은 서버가 가진 유일한 미제출 표지인 artifact_versions.status='draft' 로 본다(답 초안은 서버에 없다 — questions.ts).
 *   · 봉인·승인 라운드의 본문은 snapshot 의 round_contents 그대로이고, 가정·결정·반영은 출력 시점 현재값으로 고정한다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { COMMANDS } from "../scripts/pes_core/commands.ts";
import { create_edition } from "../scripts/pes_core/editions.ts";
import { start_round } from "../scripts/pes_core/editions.ts";
import { wrap_db, with_env, type Env } from "./helpers/blob_env.ts";
import { add_agent, approve, events_of, start } from "./helpers/editions_env.ts";
import { state_signature } from "./helpers/state_signature.ts";
import {
  art,
  blob_bytes,
  cite,
  commit_rows,
  footprint,
  human_member,
  human_outsider,
  items_of,
  more,
  ok,
  propose_assumption,
  propose_decision,
  refused,
  round_state,
  sealed_round,
  sha256_hex,
  snapshot_row,
  stage_of,
  stored_html,
  stored_manifest,
  with_key,
} from "./helpers/sel119_env.ts";
import { blob_row } from "./helpers/blob_env.ts";

const ALL = ["body", "table", "footnote", "comment", "assumption", "decision", "reflection"];

/** 계획 단계에 열린 라운드 + 본문 1 + 표 1 (둘 다 단계 산출물의 현재 버전). */
async function open_scene(env: Env, tag = "o") {
  const plan = stage_of(env, "plan");
  const round = await start(env, plan, `${tag}-start`);
  const body = await art(env, `${tag}-body`, { stage_id: plan, body_md: "열린본문-알파", title: "열린제목-알파" });
  const table = await art(env, `${tag}-table`, { stage_id: plan, kind: "table", body_md: "열린표-베타", title: "열린표제목-베타" });
  return { plan, round, body, table };
}

const prepare = (env: Env, payload: Record<string, unknown>, key: string) => ok(env, env.ctx(key), "print.prepare", payload);
const commit = (env: Env, payload: Record<string, unknown>, key: string) => ok(env, env.ctx(key), "print.commit", payload);

// ---------------------------------------------------------------------------
// 등록 · prepare

test("print.prepare and print.commit are registered commands", () => {
  assert.ok(COMMANDS.has("print.prepare"));
  assert.ok(COMMANDS.has("print.commit"));
});

test("prepare previews the manifest and writes only a receipt and one event — no snapshot, no blob, no file", async () => {
  await with_env(async (env) => {
    const s = await open_scene(env);
    const before = footprint(env);
    const out = await prepare(env, { scope: "round", round_id: s.round.round_id }, "p1");
    const after = footprint(env);
    assert.equal(after.snapshots, before.snapshots);
    assert.equal(after.blobs, before.blobs);
    assert.deepEqual(after.files, before.files);
    assert.equal(after.round_contents, before.round_contents);
    assert.equal(after.rounds, before.rounds);
    assert.equal(after.commits, before.commits + 1);
    const receipts = commit_rows(env.db, "print.prepared");
    assert.equal(receipts.length, 1);
    assert.deepEqual(events_of(env.db, receipts[0]!.id).map((e) => e.type), ["print.prepared"]);
    assert.equal(out.scope, "round");
    assert.equal(out.manifest.kind, "print");
    assert.equal(out.manifest.output, null, "the preview has no output blob yet");
    assert.equal(typeof out.selection_hash, "string");
    assert.match(out.selection_hash, /^[0-9a-f]{64}$/);
    assert.equal(out.volume.items, out.manifest.items.length);
    assert.equal(out.confirm_required, false);
    assert.equal(items_of(out.manifest, "body").length, 1);
    assert.equal(items_of(out.manifest, "table").length, 1);
  });
});

test("prepare is idempotent: same key and input replays, same key and other input is refused", async () => {
  await with_env(async (env) => {
    const s = await open_scene(env);
    const a = await env.service.execute(env.ctx("pi"), "print.prepare", { scope: "round", round_id: s.round.round_id });
    const b = await env.service.execute(env.ctx("pi"), "print.prepare", { scope: "round", round_id: s.round.round_id });
    assert.equal(a.replayed, false);
    assert.equal(b.replayed, true);
    assert.deepEqual(b.result, a.result);
    assert.equal(commit_rows(env.db, "print.prepared").length, 1);
    await refused(env, env.ctx("pi"), "print.prepare", { scope: "round", round_id: s.round.round_id, include: ["body"] }, "idempotency_key_reuse");
  });
});

// ---------------------------------------------------------------------------
// commit: 쓰기 · 멱등 · 영수증 · 사건

test("commit stores a fixed print: output blob + manifest blob + one snapshot, one receipt, one event, and leaves the open round alone", async () => {
  await with_env(async (env) => {
    const s = await open_scene(env);
    const before = footprint(env);
    const round_before = round_state(env.db, s.round.round_id);
    const out = await commit(env, { scope: "round", round_id: s.round.round_id }, "c1");
    const after = footprint(env);
    assert.equal(after.snapshots, before.snapshots + 1);
    assert.equal(after.blobs, before.blobs + 2, "manifest blob and output blob");
    assert.equal(after.round_contents, before.round_contents, "printing seals nothing");
    assert.deepEqual(round_state(env.db, s.round.round_id), round_before);
    assert.equal(round_before.state, "open");

    const snap = snapshot_row(env.db, out.snapshot_id);
    assert.equal(snap.scope, "round");
    assert.equal(snap.round_id, s.round.round_id);
    assert.equal(snap.stage_id, s.plan);
    assert.equal(snap.manifest_blob_id, out.manifest_blob_id);
    assert.equal(snap.content_hash, out.content_hash);
    for (const id of [out.manifest_blob_id, out.output_blob_id]) assert.equal(blob_row(env.db, id)?.state, "ready");
    assert.equal(blob_row(env.db, out.output_blob_id)?.media_type, "text/html");

    const manifest = stored_manifest(env, out.snapshot_id);
    assert.equal(manifest.kind, "print");
    assert.equal(manifest.format_version, "1.0");
    assert.equal(manifest.output.blob_id, out.output_blob_id);
    const html_bytes = blob_bytes(env, out.output_blob_id);
    assert.equal(manifest.output.sha256, sha256_hex(html_bytes));
    assert.equal(manifest.output.size, html_bytes.length);

    const rows = commit_rows(env.db, "print.committed");
    assert.equal(rows.length, 1);
    const events = events_of(env.db, rows[0]!.id);
    assert.deepEqual(events.map((e) => e.type), ["print.committed"]);
    const payload = JSON.parse(events[0]!.payload);
    assert.equal(payload.snapshot_id, out.snapshot_id);
    assert.equal(payload.scope, "round");
    assert.equal(payload.manifest_blob_id, out.manifest_blob_id);
    assert.equal(payload.output_blob_id, out.output_blob_id);
  });
});

test("commit replay: same key and input returns the same result with no new rows; same key and other input is refused", async () => {
  await with_env(async (env) => {
    const s = await open_scene(env);
    const a = await env.service.execute(env.ctx("ci"), "print.commit", { scope: "round", round_id: s.round.round_id });
    const mid = footprint(env);
    const b = await env.service.execute(env.ctx("ci"), "print.commit", { scope: "round", round_id: s.round.round_id });
    assert.equal(a.replayed, false);
    assert.equal(b.replayed, true);
    assert.deepEqual(b.result, a.result);
    assert.deepEqual(footprint(env), mid);
    await refused(env, env.ctx("ci"), "print.commit", { scope: "round", round_id: s.round.round_id, include: ["body"] }, "idempotency_key_reuse");
    assert.deepEqual(footprint(env), mid);
  });
});

test("a second commit of unchanged content under a new key is a new snapshot with the same output bytes and content hash", async () => {
  await with_env(async (env) => {
    const s = await open_scene(env);
    const a = await commit(env, { scope: "round", round_id: s.round.round_id }, "c-a");
    const b = await commit(env, { scope: "round", round_id: s.round.round_id }, "c-b");
    assert.notEqual(a.snapshot_id, b.snapshot_id);
    assert.equal(a.content_hash, b.content_hash);
    assert.equal(a.selection_hash, b.selection_hash);
    assert.equal(stored_manifest(env, a.snapshot_id).output.sha256, stored_manifest(env, b.snapshot_id).output.sha256);
    assert.deepEqual(blob_bytes(env, a.output_blob_id), blob_bytes(env, b.output_blob_id), "reprinting the same manifest gives the same bytes");
  });
});

// ---------------------------------------------------------------------------
// 권한

test("any member who can read the project may prepare and commit: owner, editor, reader", async () => {
  await with_env(async (env) => {
    const s = await open_scene(env);
    const editor = human_member(env, "ed-1", "editor");
    const reader = human_member(env, "rd-1", "reader");
    for (const [who, ctx] of [["owner", env.ctx("x")], ["editor", editor], ["reader", reader]] as const) {
      const p = await ok(env, with_key(ctx, `pm-${who}`), "print.prepare", { scope: "round", round_id: s.round.round_id });
      assert.equal(p.manifest.kind, "print", who);
      const c = await ok(env, with_key(ctx, `cm-${who}`), "print.commit", { scope: "round", round_id: s.round.round_id });
      assert.ok(snapshot_row(env.db, c.snapshot_id), who);
    }
  });
});

test("an agent is refused by default (forbidden) and so is a person outside the project; a refusal writes nothing", async () => {
  await with_env(async (env) => {
    const s = await open_scene(env);
    const agent = add_agent(env, "agent-print");
    const outsider = human_outsider(env);
    const sig = state_signature(env.db);
    const files = footprint(env).files;
    for (const command of ["print.prepare", "print.commit"]) {
      await refused(env, with_key(agent, `ag-${command}`), command, { scope: "round", round_id: s.round.round_id }, "forbidden");
      await refused(env, with_key(outsider, `ou-${command}`), command, { scope: "round", round_id: s.round.round_id }, "forbidden", "not_found");
    }
    assert.equal(state_signature(env.db), sig);
    assert.deepEqual(footprint(env).files, files);
  });
});

// ---------------------------------------------------------------------------
// 실패 롤백

for (const [name, re] of [
  ["the snapshot row", /INSERT\s+INTO\s+snapshots/i],
  ["a blob row", /INSERT\s+INTO\s+blobs/i],
  ["the event row", /INSERT\s+INTO\s+events/i],
] as const) {
  test(`a failure at ${name} rolls everything back: no snapshot, no blob row, no file, no receipt — and the same key can be retried`, async () => {
    await with_env(async (env) => {
      const s = await open_scene(env);
      const sig = state_signature(env.db);
      const files = footprint(env).files;
      const failing = env.with_db(
        wrap_db(env.db, (sql) => {
          if (re.test(sql)) throw new Error("injected failure");
        }),
      );
      await assert.rejects(failing.execute(env.ctx("rb"), "print.commit", { scope: "round", round_id: s.round.round_id }));
      assert.equal(state_signature(env.db), sig, "every table is exactly as before");
      assert.deepEqual(footprint(env).files, files, "no stray blob file");
      const retry = await env.service.execute(env.ctx("rb"), "print.commit", { scope: "round", round_id: s.round.round_id });
      assert.equal(retry.replayed, false, "a failed attempt left no receipt to replay");
      assert.equal(footprint(env).snapshots, 1);
    });
  });
}

// ---------------------------------------------------------------------------
// 범위 검증 · 기본 범위 · 모든 판

test("scope is closed: no project-wide scope, missing scope, unknown fields, bad include — all invalid_payload and write nothing", async () => {
  await with_env(async (env) => {
    const s = await open_scene(env);
    const sig = state_signature(env.db);
    const bad: Array<Record<string, unknown>> = [
      { scope: "project" },
      { scope: "all" },
      { scope: "ROUND" },
      {},
      { scope: "round", round_id: s.round.round_id, surprise: 1 },
      { scope: "round", round_id: s.round.round_id, include: [] },
      { scope: "round", round_id: s.round.round_id, include: ["body", "tokens"] },
      { scope: "round", round_id: s.round.round_id, all_editions: true },
      { scope: "stage", stage_id: s.plan, all_editions: true },
    ];
    for (const [i, payload] of bad.entries()) {
      for (const command of ["print.prepare", "print.commit"]) await refused(env, env.ctx(`bad-${command}-${i}`), command, payload, "invalid_payload");
    }
    await refused(env, env.ctx("nf-r"), "print.commit", { scope: "round", round_id: "no-such-round" }, "not_found");
    await refused(env, env.ctx("nf-s"), "print.commit", { scope: "stage", stage_id: "no-such-stage" }, "not_found");
    await refused(env, env.ctx("nf-e"), "print.commit", { scope: "edition", edition_id: "no-such-edition" }, "not_found");
    assert.equal(state_signature(env.db), sig);
    assert.equal(snapshot_count_with_scope(env, "project"), 0);
  });
});

function snapshot_count_with_scope(env: Env, scope: string): number {
  return Number(env.db.get<{ c: bigint }>("SELECT count(*) AS c FROM snapshots WHERE scope = ?", scope)!.c);
}

test("without ids the scope is the current round, the current stage, the current edition", async () => {
  await with_env(async (env) => {
    const s = await open_scene(env);
    const r = await commit(env, { scope: "round" }, "d-r");
    assert.equal(snapshot_row(env.db, r.snapshot_id).round_id, s.round.round_id);
    const st = await commit(env, { scope: "stage" }, "d-s");
    const st_row = snapshot_row(env.db, st.snapshot_id);
    assert.equal(st_row.scope, "stage");
    assert.equal(st_row.stage_id, s.plan);
    assert.equal(st_row.round_id, null);
    const ed = await commit(env, { scope: "edition" }, "d-e");
    const ed_row = snapshot_row(env.db, ed.snapshot_id);
    assert.equal(ed_row.scope, "edition");
    assert.equal(ed_row.edition_id, env.p.edition_id);
    assert.equal(ed_row.stage_id, null);
    assert.equal(ed_row.round_id, null);
    const m = stored_manifest(env, ed.snapshot_id);
    assert.equal(m.all_editions, false);
    assert.equal(m.targets.length, 1);
    assert.equal(m.targets[0].stages.length, 6, "the current edition means all six stages");
  });
});

test("all editions is an explicit option that needs the previewed volume confirmed; edition scope alone prints only the current edition", async () => {
  await with_env(async (env) => {
    // 판 1 에 내용, 판 2 를 활성으로
    const plan1 = stage_of(env, "plan");
    await start(env, plan1, "ae-r1");
    await art(env, "ae-a1", { stage_id: plan1, body_md: "옛판본문-감마", title: "옛판제목-감마" });
    const created = (await create_edition(env.service, env.ctx("ae-ed2"), { parent_edition_id: env.p.edition_id })).result as { edition_id: string; stage_ids: Record<string, string> };
    env.db.run("UPDATE editions SET status = 'completed' WHERE id = ?", env.p.edition_id);
    env.db.run("UPDATE editions SET status = 'active' WHERE id = ?", created.edition_id);
    env.db.run("UPDATE projects SET active_edition_id = ? WHERE id = ?", created.edition_id, env.p.project_id);
    await start_round(env.service, env.ctx("ae-r2"), { stage_id: created.stage_ids.plan });
    await art(env, "ae-a2", { stage_id: created.stage_ids.plan, edition_id: created.edition_id, body_md: "새판본문-델타", title: "새판제목-델타" });

    const only = await commit(env, { scope: "edition" }, "ae-only");
    const only_m = stored_manifest(env, only.snapshot_id);
    assert.deepEqual(only_m.targets.map((t: any) => t.edition_id), [created.edition_id]);
    assert.match(stored_html(env, only_m), /새판본문-델타/);
    assert.doesNotMatch(stored_html(env, only_m), /옛판본문-감마/);

    const preview = await prepare(env, { scope: "edition", all_editions: true }, "ae-prep");
    assert.equal(preview.confirm_required, true);
    assert.equal(preview.volume.editions, 2);
    assert.equal(preview.volume.items, 2);
    await refused(env, env.ctx("ae-noconf"), "print.commit", { scope: "edition", all_editions: true }, "invalid_payload");
    await refused(env, env.ctx("ae-wrong"), "print.commit", { scope: "edition", all_editions: true, confirm_volume: preview.volume.items + 1 }, "invalid_payload");
    assert.equal(snapshot_count_with_scope(env, "edition"), 1, "the refused attempts stored nothing");

    const all = await commit(env, { scope: "edition", all_editions: true, confirm_volume: preview.volume.items }, "ae-all");
    const m = stored_manifest(env, all.snapshot_id);
    assert.equal(m.all_editions, true);
    assert.deepEqual(m.targets.map((t: any) => t.edition_id).sort(), [env.p.edition_id, created.edition_id].sort());
    assert.equal(snapshot_row(env.db, all.snapshot_id).scope, "edition", "no project scope exists: it is an edition snapshot");
    assert.match(stored_html(env, m), /옛판본문-감마/);
    assert.match(stored_html(env, m), /새판본문-델타/);
  });
});

// ---------------------------------------------------------------------------
// 봉인 · 승인 · 열린 라운드

test("a sealed round prints its own snapshot (not the newer versions); the round stays sealed and unchanged", async () => {
  await with_env(async (env) => {
    const plan = stage_of(env, "plan");
    const sealed = await sealed_round(env, plan, "sl", "봉인본문-엡실론");
    await more(env, "sl-v2", sealed.art.object_id, { body_md: "봉인뒤새글-제타", title: "새제목", current: true });
    const before = footprint(env);
    const out = await commit(env, { scope: "round", round_id: sealed.round.round_id }, "sl-c");
    const m = stored_manifest(env, out.snapshot_id);
    const stage = m.targets[0].stages[0];
    assert.equal(stage.basis, "sealed");
    assert.equal(stage.basis_snapshot_id, sealed.snapshot_id);
    assert.deepEqual(items_of(m, "body").map((i) => i.version_id), [sealed.art.version_id]);
    assert.match(stored_html(env, m), /봉인본문-엡실론/);
    assert.doesNotMatch(stored_html(env, m), /봉인뒤새글-제타/);
    const after = footprint(env);
    assert.equal(after.round_contents, before.round_contents);
    assert.equal(round_state(env.db, sealed.round.round_id).state, "sealed");
    assert.equal(round_state(env.db, sealed.round.round_id).sealed_snapshot_id, sealed.snapshot_id, "the round keeps its own seal");
  });
});

test("an approved stage prints its approved snapshot", async () => {
  await with_env(async (env) => {
    const plan = stage_of(env, "plan");
    const sealed = await sealed_round(env, plan, "ap", "승인본문-에타");
    const approved = await approve(env, plan, sealed.snapshot_id, "ap-approve");
    await more(env, "ap-v2", sealed.art.object_id, { body_md: "승인뒤새글-세타", current: true });
    const out = await commit(env, { scope: "stage", stage_id: plan }, "ap-c");
    const m = stored_manifest(env, out.snapshot_id);
    const stage = m.targets[0].stages[0];
    assert.equal(stage.basis, "approved");
    assert.equal(stage.basis_snapshot_id, approved.snapshot_id);
    assert.match(stored_html(env, m), /승인본문-에타/);
    assert.doesNotMatch(stored_html(env, m), /승인뒤새글-세타/);
  });
});

test("an open round is fixed at print time and never sealed; later edits do not change the stored print, a new print sees them", async () => {
  await with_env(async (env) => {
    const s = await open_scene(env);
    const before = round_state(env.db, s.round.round_id);
    const first = await commit(env, { scope: "round", round_id: s.round.round_id }, "op-1");
    const m1 = stored_manifest(env, first.snapshot_id);
    assert.equal(m1.targets[0].stages[0].basis, "open");
    assert.equal(m1.targets[0].stages[0].basis_snapshot_id, null);
    assert.deepEqual(items_of(m1, "body").map((i) => i.version_id), [s.body.version_id]);
    const html1 = stored_html(env, m1);
    assert.match(html1, /열린본문-알파/);

    await more(env, "op-edit", s.body.object_id, { body_md: "고친본문-이오타", title: "고친제목", current: true });
    assert.equal(stored_html(env, stored_manifest(env, first.snapshot_id)), html1, "the stored print did not move");
    const second = await commit(env, { scope: "round", round_id: s.round.round_id }, "op-2");
    const html2 = stored_html(env, stored_manifest(env, second.snapshot_id));
    assert.match(html2, /고친본문-이오타/);
    assert.notEqual(second.content_hash, first.content_hash);
    assert.deepEqual(round_state(env.db, s.round.round_id), before, "two prints later the round is still open and untouched");
  });
});

// ---------------------------------------------------------------------------
// 제외 · 포함 · 자리

test("unsubmitted drafts and the token stream are excluded and the exclusion is recorded", async () => {
  await with_env(async (env) => {
    const s = await open_scene(env);
    const draft = await art(env, "dr", { stage_id: s.plan, status: "draft", body_md: "초안본문-카파", title: "초안제목-카파" });
    const out = await commit(env, { scope: "round", round_id: s.round.round_id }, "dr-c");
    const m = stored_manifest(env, out.snapshot_id);
    assert.ok(!m.items.some((i: any) => i.version_id === draft.version_id), "the draft is not an item");
    assert.deepEqual(
      m.excluded.filter((e: any) => e.category === "unsubmitted_draft").map((e: any) => [e.reason, e.object_id, e.version_id]),
      [["unsubmitted", draft.object_id, draft.version_id]],
    );
    assert.deepEqual(m.excluded.filter((e: any) => e.category === "token_stream"), [{ category: "token_stream", reason: "default_excluded" }]);
    const html = stored_html(env, m);
    assert.doesNotMatch(html, /초안본문-카파|초안제목-카파/);
    assert.match(html, /열린본문-알파/);
  });
});

test("include selects categories; every category that is left out is listed as not_selected, and its text is not printed", async () => {
  await with_env(async (env) => {
    const s = await open_scene(env);
    const all = stored_manifest(env, (await commit(env, { scope: "round", round_id: s.round.round_id }, "in-all")).snapshot_id);
    assert.deepEqual(all.include, ALL);
    assert.equal(all.excluded.filter((e: any) => e.reason === "not_selected").length, 0);

    const some = stored_manifest(env, (await commit(env, { scope: "round", round_id: s.round.round_id, include: ["body", "decision"] }, "in-some")).snapshot_id);
    assert.deepEqual(some.include, ["body", "decision"]);
    assert.equal(items_of(some, "table").length, 0);
    assert.equal(items_of(some, "body").length, 1);
    assert.deepEqual(
      some.excluded.filter((e: any) => e.reason === "not_selected").map((e: any) => e.category),
      ["table", "footnote", "comment", "assumption", "reflection"],
    );
    assert.doesNotMatch(stored_html(env, some), /열린표-베타|열린표제목-베타/);
    assert.match(stored_html(env, some), /열린본문-알파/);
  });
});

test("footnotes: the citations of included versions are items and their sources are printed; leaving footnote out drops them", async () => {
  await with_env(async (env) => {
    const s = await open_scene(env);
    const src = await cite(env, "fn", s.body.version_id);
    const m = stored_manifest(env, (await commit(env, { scope: "round", round_id: s.round.round_id }, "fn-1")).snapshot_id);
    const notes = items_of(m, "footnote");
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.version_id, src.version_id);
    assert.equal(notes[0]!.object_id, src.object_id);
    assert.equal(notes[0]!.cited_by_version_id, s.body.version_id);
    assert.equal(notes[0]!.citation_no, 1);
    assert.match(stored_html(env, m), /합성 출처 fn/);
    const without = stored_manifest(env, (await commit(env, { scope: "round", round_id: s.round.round_id, include: ["body", "table"] }, "fn-2")).snapshot_id);
    assert.equal(items_of(without, "footnote").length, 0);
    assert.doesNotMatch(stored_html(env, without), /합성 출처 fn/);
  });
});

test("assumptions, decisions and reflections are pinned by version at print time; the comment slot (U4) is only a place", async () => {
  await with_env(async (env) => {
    const s = await open_scene(env);
    const a = await propose_assumption(env, "as-1", "가정-람다");
    const d = await propose_decision(env, "de-1", "결정-뮤");
    const reflected = await ok(env, env.ctx("rf-1"), "reflection.create", {
      target_round_id: s.round.round_id,
      entries: [{ source_version_id: s.body.version_id, disposition: "rejected", rationale: "반영하지 않는다-뉴" }],
    });
    const out = await commit(env, { scope: "round", round_id: s.round.round_id }, "pin-c");
    const m = stored_manifest(env, out.snapshot_id);
    assert.deepEqual(items_of(m, "assumption").map((i) => [i.object_id, i.version_id]), [[a.object_id, a.version_id]]);
    assert.deepEqual(items_of(m, "decision").map((i) => [i.object_id, i.version_id]), [[d.object_id, d.version_id]]);
    const refl = items_of(m, "reflection");
    assert.equal(refl.length, 1);
    assert.equal(refl[0]!.entry_id, reflected.entries[0].entry_id);
    assert.equal(refl[0]!.source_version_id, s.body.version_id);
    assert.equal(refl[0]!.round_id, s.round.round_id);
    assert.deepEqual(m.comments, { included: true, items: [] }, "comments are a reserved slot, nothing is invented");

    // 나중에 가정이 더 생겨도 고정본은 그대로
    await propose_assumption(env, "as-2", "나중 가정-크시");
    assert.equal(items_of(stored_manifest(env, out.snapshot_id), "assumption").length, 1);

    const no_comment = stored_manifest(env, (await commit(env, { scope: "round", round_id: s.round.round_id, include: ["body"] }, "pin-nc")).snapshot_id);
    assert.deepEqual(no_comment.comments, { included: false, items: [] });
  });
});

// ---------------------------------------------------------------------------
// 같은 manifest · 오래된 미리보기

test("the same manifest reprints to the same content: manifest items, content hash and output bytes are equal", async () => {
  await with_env(async (env) => {
    const s = await open_scene(env);
    await cite(env, "rp", s.body.version_id);
    const a = await commit(env, { scope: "round", round_id: s.round.round_id }, "rp-a");
    const b = await commit(env, { scope: "round", round_id: s.round.round_id }, "rp-b");
    const ma = stored_manifest(env, a.snapshot_id);
    const mb = stored_manifest(env, b.snapshot_id);
    assert.deepEqual({ ...ma, output: null }, { ...mb, output: null });
    assert.equal(ma.output.sha256, mb.output.sha256);
    assert.equal(a.content_hash, b.content_hash);
  });
});

test("commit with the selection_hash of the preview is refused when the content moved in between", async () => {
  await with_env(async (env) => {
    const s = await open_scene(env);
    const preview = await prepare(env, { scope: "round", round_id: s.round.round_id }, "sh-p");
    await more(env, "sh-edit", s.body.object_id, { body_md: "움직인본문", current: true });
    const sig = state_signature(env.db);
    await refused(env, env.ctx("sh-stale"), "print.commit", { scope: "round", round_id: s.round.round_id, selection_hash: preview.selection_hash }, "conflict");
    assert.equal(state_signature(env.db), sig);
    const fresh = await prepare(env, { scope: "round", round_id: s.round.round_id }, "sh-p2");
    assert.notEqual(fresh.selection_hash, preview.selection_hash);
    const done = await commit(env, { scope: "round", round_id: s.round.round_id, selection_hash: fresh.selection_hash }, "sh-ok");
    assert.equal(done.selection_hash, fresh.selection_hash);
  });
});

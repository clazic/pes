// SEL-39 (stage 2 PR6) leader rulings on three gaps found by hardening:
//  (1) after stage.reopen only a snapshot sealed AFTER the reopen can approve the stage;
//  (2) edition.carry_over kind "tasks" needs from_stage and to_stage in the same edition;
//  (3) round.seal and edition.snapshot refuse an empty versions list (invalid_payload).
// Everything is synthetic. Rows are compared as { ...row }.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  approve_stage,
  carry_over,
  create_edition,
  reopen_stage,
  seal_round,
  snapshot,
} from "../scripts/pes_core/editions.ts";
import {
  approvals_of,
  approve,
  drive_stage,
  insert_followup,
  make_content,
  manifest_blob,
  rejects_api,
  round_row,
  seal,
  stage_ids,
  stage_row,
  start,
  with_env,
  type SealResult,
} from "./helpers/editions_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

test("after a reopen the old sealed snapshot cannot re-approve the stage; a new round sealed after it can", async () => {
  await with_env(async (env) => {
    const s = stage_ids(env.db, env.p.edition_id);
    const first = await drive_stage(env, s.plan, "plan");
    await reopen_stage(env.service, env.ctx("reopen-1"), { stage_id: s.plan });
    const before = state_signature(env.db);
    await rejects_api(
      approve_stage(env.service, env.ctx("re-old"), { stage_id: s.plan, snapshot_id: first.sealed.snapshot_id }),
      "conflict",
    );
    assert.equal(state_signature(env.db), before, "nothing is written");
    assert.equal(approvals_of(env.db, s.plan).length, 1, "no duplicate approval");
    assert.equal(stage_row(env.db, s.plan).status, "active");
    assert.equal(stage_row(env.db, s.plan).approved_snapshot_id, null);

    const r2 = await start(env, s.plan, "plan2-start");
    // while the new round is open the old snapshot is still refused
    await rejects_api(
      approve_stage(env.service, env.ctx("re-old-2"), { stage_id: s.plan, snapshot_id: first.sealed.snapshot_id }),
      "conflict",
    );
    const c = await make_content(env, "plan2");
    const sealed2 = (await seal(env, r2.round_id, [{ object_id: c.object_id, version_id: c.version_id }], "plan2-seal")).result as SealResult;
    assert.equal(round_row(env.db, r2.round_id).state, "sealed");
    await rejects_api(
      approve_stage(env.service, env.ctx("re-old-3"), { stage_id: s.plan, snapshot_id: first.sealed.snapshot_id }),
      "conflict",
    );
    const approved = await approve(env, s.plan, sealed2.snapshot_id, "plan2-approve");
    assert.equal(approved.snapshot_id, sealed2.snapshot_id);
    assert.equal(approvals_of(env.db, s.plan).length, 2);
    assert.equal(stage_row(env.db, s.plan).status, "approved");
    assert.equal(stage_row(env.db, s.plan).approved_snapshot_id, sealed2.snapshot_id);
  });
});

test("a reopen of the last stage also blocks re-approval with the old snapshot and keeps the edition active", async () => {
  await with_env(async (env) => {
    const s = stage_ids(env.db, env.p.edition_id);
    let last: Awaited<ReturnType<typeof drive_stage>> | undefined;
    for (const key of ["plan", "research", "analyze", "write", "verify", "publish"] as const) {
      last = await drive_stage(env, s[key], key);
    }
    await reopen_stage(env.service, env.ctx("reopen-pub"), { stage_id: s.publish });
    const before = state_signature(env.db);
    await rejects_api(
      approve_stage(env.service, env.ctx("pub-old"), { stage_id: s.publish, snapshot_id: last!.sealed.snapshot_id }),
      "conflict",
    );
    assert.equal(state_signature(env.db), before);
    const ed = env.db.get<{ status: string }>("SELECT status FROM editions WHERE id = ?", env.p.edition_id)!;
    assert.equal(ed.status, "active");
  });
});

test("carry_over tasks refuses a stage of another edition on either side and writes nothing", async () => {
  await with_env(async (env) => {
    const s = stage_ids(env.db, env.p.edition_id);
    const ed2 = (await create_edition(env.service, env.ctx("ed-2"), {})).result as { stage_ids: Record<string, string> };
    insert_followup(env, "f1", s.plan, "accepted", "합성 요청");
    insert_followup(env, "f2", ed2.stage_ids.plan!, "accepted", "합성 요청 둘");
    const before = state_signature(env.db);
    await rejects_api(
      carry_over(env.service, env.ctx("x-to"), { kind: "tasks", from_stage_id: s.plan, to_stage_id: ed2.stage_ids.research! }),
      "conflict",
    );
    await rejects_api(
      carry_over(env.service, env.ctx("x-from"), { kind: "tasks", from_stage_id: ed2.stage_ids.plan!, to_stage_id: s.research }),
      "conflict",
    );
    await rejects_api(
      carry_over(env.service, env.ctx("x-later"), { kind: "tasks", from_stage_id: s.plan, to_stage_id: ed2.stage_ids.publish! }),
      "conflict",
    );
    assert.equal(state_signature(env.db), before);
    // inside one edition the same call still works
    const ok = await carry_over(env.service, env.ctx("ok"), { kind: "tasks", from_stage_id: s.plan, to_stage_id: s.research });
    assert.equal((ok.result as { carried: unknown[] }).carried.length, 1);
  });
});

test("round.seal and edition.snapshot refuse an empty versions list with invalid_payload and write nothing", async () => {
  await with_env(async (env) => {
    const s = stage_ids(env.db, env.p.edition_id);
    const r = await start(env, s.plan, "plan-start");
    const m = await manifest_blob(env, [], "empty");
    const before = state_signature(env.db);
    await rejects_api(seal_round(env.service, env.ctx("e-seal"), { round_id: r.round_id, manifest_blob_id: m, versions: [] }), "invalid_payload");
    await rejects_api(snapshot(env.service, env.ctx("e-snap"), { scope: "edition", manifest_blob_id: m, versions: [] }), "invalid_payload");
    await rejects_api(snapshot(env.service, env.ctx("e-snap-st"), { scope: "stage", stage_id: s.plan, manifest_blob_id: m, versions: [] }), "invalid_payload");
    assert.equal(state_signature(env.db), before);
    assert.equal(round_row(env.db, r.round_id).state, "open", "the round stays open and can still be sealed");
    const c = await make_content(env, "c1");
    const ok = await seal(env, r.round_id, [{ object_id: c.object_id, version_id: c.version_id }], "ok-seal");
    assert.equal(ok.replayed, false);
  });
});

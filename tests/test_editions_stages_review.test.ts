// SEL-39 (stage 2 PR6) regression tests for the first review (leader rulings A-E). They are written
// against the requirements, not the current code: they are expected to FAIL until the code is fixed.
//  A) stage.approve needs every earlier stage to be approved AND not stale; refusal writes nothing.
//  B) round.start needs the same condition on earlier stages.
//  C) stage.reopen also interrupts a later stage's running run (lease released, event with run_id).
//  D) an agent may seal / snapshot only for the stage / round its guard's run belongs to.
//  E) stage.approve, round.seal and stage.reopen refuse an edition that is not active
//     (a completed edition may still be reopened).
// Everything is synthetic. Rows are compared as { ...row }.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  approve_stage,
  reopen_stage,
  seal_round,
  snapshot,
  start_round,
} from "../scripts/pes_core/editions.ts";
import {
  add_agent,
  agent_claim,
  agent_ctx,
  aim_run,
  approvals_of,
  approve,
  drive_stage,
  edition_row,
  events_of,
  insert_run,
  make_content,
  manifest_blob,
  receipt_of,
  rejects_api,
  round_row,
  seal,
  stage_ids,
  stage_row,
  start,
  with_env,
  type Env,
  type SealResult,
} from "./helpers/editions_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

function ref(c: { object_id: string; version_id: string }) {
  return { object_id: c.object_id, version_id: c.version_id };
}

/** Seal an open round with one fresh version. */
async function seal_fresh(env: Env, round_id: string, tag: string): Promise<SealResult> {
  const c = await make_content(env, tag);
  return (await seal(env, round_id, [ref(c)], `${tag}-seal`)).result as SealResult;
}

// ---------------------------------------------------------------------------
// A) approve needs all earlier stages approved and not stale

test("A: approve is refused while an earlier stage was reopened under an already open round; allowed after it is re-approved", async () => {
  await with_env(async (env) => {
    const s = stage_ids(env.db, env.p.edition_id);
    await drive_stage(env, s.plan, "plan");
    const r2 = await start(env, s.research, "research-start");
    await reopen_stage(env.service, env.ctx("reopen-plan"), { stage_id: s.plan });
    assert.ok(stage_row(env.db, s.research).stale_since_event_seq !== null);
    const sealed2 = await seal_fresh(env, r2.round_id, "research");
    assert.equal(round_row(env.db, r2.round_id).state, "sealed");

    const before = state_signature(env.db);
    await rejects_api(
      approve_stage(env.service, env.ctx("research-approve-early"), { stage_id: s.research, snapshot_id: sealed2.snapshot_id }),
      "conflict",
    );
    assert.equal(state_signature(env.db), before, "no receipt, event or state change");
    assert.equal(receipt_of(env.db, env.p.project_id, "research-approve-early"), undefined);
    assert.equal(stage_row(env.db, s.plan).status, "active");
    assert.equal(stage_row(env.db, s.research).status, "active");
    assert.equal(stage_row(env.db, s.research).approved_snapshot_id, null);
    assert.equal(approvals_of(env.db, s.research).length, 0);
    assert.equal(edition_row(env.db, env.p.edition_id).current_stage_id, s.plan);

    // plan approved again: the order is restored and research may be approved
    const r3 = await start(env, s.plan, "plan2-start");
    const sealed3 = await seal_fresh(env, r3.round_id, "plan2");
    await approve(env, s.plan, sealed3.snapshot_id, "plan2-approve");
    const ok = await approve(env, s.research, sealed2.snapshot_id, "research-approve");
    assert.equal(ok.snapshot_id, sealed2.snapshot_id);
    assert.equal(stage_row(env.db, s.research).status, "approved");
    assert.equal(stage_row(env.db, s.plan).status, "approved");
  });
});

test("A: approving the last stage under a reopened earlier stage is refused and the edition is not completed", async () => {
  await with_env(async (env) => {
    const s = stage_ids(env.db, env.p.edition_id);
    for (const key of ["plan", "research", "analyze", "write", "verify"] as const) {
      await drive_stage(env, s[key], key);
    }
    const r = await start(env, s.publish, "publish-start");
    await reopen_stage(env.service, env.ctx("reopen-plan"), { stage_id: s.plan });
    const sealed = await seal_fresh(env, r.round_id, "publish");

    const before = state_signature(env.db);
    await rejects_api(
      approve_stage(env.service, env.ctx("publish-approve-early"), { stage_id: s.publish, snapshot_id: sealed.snapshot_id }),
      "conflict",
    );
    assert.equal(state_signature(env.db), before);
    assert.equal(edition_row(env.db, env.p.edition_id).status, "active", "the edition is not completed");
    assert.equal(stage_row(env.db, s.publish).status, "active");
    assert.equal(approvals_of(env.db, s.publish).length, 0);
  });
});

test("A: approve is also refused when an earlier stage is approved but stale", async () => {
  await with_env(async (env) => {
    const s = stage_ids(env.db, env.p.edition_id);
    await drive_stage(env, s.plan, "plan");
    await drive_stage(env, s.research, "research");
    await drive_stage(env, s.analyze, "analyze");
    const r = await start(env, s.write, "write-start");
    // reopen research and approve it again: research is clean, analyze is approved but stale
    await reopen_stage(env.service, env.ctx("reopen-research"), { stage_id: s.research });
    const rr = await start(env, s.research, "research2-start");
    const rs = await seal_fresh(env, rr.round_id, "research2");
    await approve(env, s.research, rs.snapshot_id, "research2-approve");
    const analyze = stage_row(env.db, s.analyze);
    assert.equal(analyze.status, "approved");
    assert.ok(analyze.stale_since_event_seq !== null, "analyze is approved but stale");

    const ws = await seal_fresh(env, r.round_id, "write");
    const before = state_signature(env.db);
    await rejects_api(
      approve_stage(env.service, env.ctx("write-approve"), { stage_id: s.write, snapshot_id: ws.snapshot_id }),
      "conflict",
    );
    assert.equal(state_signature(env.db), before);
    assert.equal(stage_row(env.db, s.write).status, "active");
  });
});

// ---------------------------------------------------------------------------
// B) round.start needs the same condition

test("B: round.start is refused when an earlier stage is approved but stale, and writes nothing", async () => {
  await with_env(async (env) => {
    const s = stage_ids(env.db, env.p.edition_id);
    await drive_stage(env, s.plan, "plan");
    await drive_stage(env, s.research, "research");
    await drive_stage(env, s.analyze, "analyze");
    await reopen_stage(env.service, env.ctx("reopen-research"), { stage_id: s.research });
    const rr = await start(env, s.research, "research2-start");
    const rs = await seal_fresh(env, rr.round_id, "research2");
    await approve(env, s.research, rs.snapshot_id, "research2-approve");
    const analyze = stage_row(env.db, s.analyze);
    assert.equal(analyze.status, "approved");
    assert.ok(analyze.stale_since_event_seq !== null, "analyze is approved but stale");

    const before = state_signature(env.db);
    await rejects_api(start_round(env.service, env.ctx("write-start"), { stage_id: s.write }), "conflict");
    assert.equal(state_signature(env.db), before);
    assert.equal(receipt_of(env.db, env.p.project_id, "write-start"), undefined);
    assert.equal(env.db.all("SELECT 1 FROM rounds WHERE stage_id = ?", s.write).length, 0);
  });
});

test("B: round.start is refused when the stage right before is reopened (not approved)", async () => {
  await with_env(async (env) => {
    const s = stage_ids(env.db, env.p.edition_id);
    await drive_stage(env, s.plan, "plan");
    await drive_stage(env, s.research, "research");
    await reopen_stage(env.service, env.ctx("reopen-research"), { stage_id: s.research });
    const before = state_signature(env.db);
    await rejects_api(start_round(env.service, env.ctx("analyze-start"), { stage_id: s.analyze }), "conflict");
    assert.equal(state_signature(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// C) reopen interrupts a later stage's running run

test("C: reopen releases the lease of a later stage's running run, marks it interrupted and records an event with its run_id; finished runs stay", async () => {
  await with_env(async (env) => {
    const s = stage_ids(env.db, env.p.edition_id);
    const base = add_agent(env);
    await drive_stage(env, s.plan, "plan");
    const research = await drive_stage(env, s.research, "research");
    const lease = await agent_claim(env, base, "claim-1");
    aim_run(env, lease.run_id, s.research, research.round.round_id, null);
    insert_run(env, "run-later-succeeded", "succeeded", s.research, research.round.round_id, null);
    insert_run(env, "run-later-failed", "failed", s.analyze, null, null);
    const running = env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", lease.run_id)!;
    assert.equal(running.status, "running");
    const succeeded_before = { ...env.db.get("SELECT * FROM runs WHERE id = 'run-later-succeeded'")! };
    const failed_before = { ...env.db.get("SELECT * FROM runs WHERE id = 'run-later-failed'")! };

    await reopen_stage(env.service, env.ctx("reopen-plan"), { stage_id: s.plan });

    const run = env.db.get<{ status: string; ended_at: bigint | null }>("SELECT status, ended_at FROM runs WHERE id = ?", lease.run_id)!;
    assert.equal(run.status, "interrupted");
    assert.ok(run.ended_at !== null);
    const l = env.db.get<{ state: string }>("SELECT state FROM project_leases WHERE project_id = ? AND lease_id = ?", env.p.project_id, lease.lease_id)!;
    assert.notEqual(l.state, "active", "the lease is released");
    const receipt = receipt_of(env.db, env.p.project_id, "reopen-plan")!;
    assert.ok(events_of(env.db, receipt.id).some((e) => e.run_id === lease.run_id), "an event carries the interrupted run_id");
    assert.deepEqual({ ...env.db.get("SELECT * FROM runs WHERE id = 'run-later-succeeded'")! }, succeeded_before);
    assert.deepEqual({ ...env.db.get("SELECT * FROM runs WHERE id = 'run-later-failed'")! }, failed_before);

    // the dead guard no longer works
    const m = await manifest_blob(env, [], "x");
    await rejects_api(
      snapshot(env.service, agent_ctx(base, "after"), {
        scope: "stage", stage_id: s.plan, manifest_blob_id: m, versions: [ref(research.content)],
        run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence,
      }),
      "conflict", "forbidden",
    );
  });
});

test("C: a running run of the reopened stage itself or of an earlier stage is not interrupted", async () => {
  await with_env(async (env) => {
    const s = stage_ids(env.db, env.p.edition_id);
    const base = add_agent(env);
    const plan = await drive_stage(env, s.plan, "plan");
    await drive_stage(env, s.research, "research");
    const lease = await agent_claim(env, base, "claim-1");
    aim_run(env, lease.run_id, s.research, null, null);
    // reopening the LAST approved stage (research): its own run and earlier ones are not later stages
    await reopen_stage(env.service, env.ctx("reopen-research"), { stage_id: s.research });
    assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", lease.run_id)!.status, "running");
    assert.equal(env.db.get<{ state: string }>("SELECT state FROM project_leases WHERE project_id = ? AND lease_id = ?", env.p.project_id, lease.lease_id)!.state, "active");
    assert.ok(plan);
  });
});

// ---------------------------------------------------------------------------
// D) the guard's run must belong to the target round / stage

/** plan reopened with a new open plan round while research still has its old open round. */
async function two_open_rounds(env: Env) {
  const s = stage_ids(env.db, env.p.edition_id);
  await drive_stage(env, s.plan, "plan");
  const research_round = await start(env, s.research, "research-start");
  await reopen_stage(env.service, env.ctx("reopen-plan"), { stage_id: s.plan });
  const plan_round = await start(env, s.plan, "plan2-start");
  return { s, research_round, plan_round };
}

test("D: an agent cannot seal a round that belongs to another stage or round than its run; nothing is written", async () => {
  await with_env(async (env) => {
    const { s, research_round, plan_round } = await two_open_rounds(env);
    const base = add_agent(env);
    const lease = await agent_claim(env, base, "claim-1");
    const guard = { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence };
    aim_run(env, lease.run_id, s.plan, plan_round.round_id, null);
    const c = await make_content(env, "x");
    const versions = [ref(c)];
    const m = await manifest_blob(env, versions, "mx");

    const before = state_signature(env.db);
    await rejects_api(
      seal_round(env.service, agent_ctx(base, "foreign-seal"), { round_id: research_round.round_id, manifest_blob_id: m, versions, ...guard }),
      "forbidden",
    );
    assert.equal(state_signature(env.db), before);
    assert.equal(round_row(env.db, research_round.round_id).state, "open");

    // a run of the same stage but another round is refused too
    aim_run(env, lease.run_id, s.plan, research_round.round_id, null);
    await rejects_api(
      seal_round(env.service, agent_ctx(base, "other-round-seal"), { round_id: plan_round.round_id, manifest_blob_id: m, versions, ...guard }),
      "forbidden",
    );
    assert.equal(state_signature(env.db), before);

    // control: the run's own round can be sealed
    aim_run(env, lease.run_id, s.plan, plan_round.round_id, null);
    const ok = await seal_round(env.service, agent_ctx(base, "own-seal"), { round_id: plan_round.round_id, manifest_blob_id: m, versions, ...guard });
    assert.equal(ok.replayed, false);
    assert.equal(round_row(env.db, plan_round.round_id).state, "sealed");
  });
});

test("D: an agent cannot snapshot another stage than its run's; its own stage works", async () => {
  await with_env(async (env) => {
    const { s, plan_round } = await two_open_rounds(env);
    const base = add_agent(env);
    const lease = await agent_claim(env, base, "claim-1");
    const guard = { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence };
    aim_run(env, lease.run_id, s.plan, plan_round.round_id, null);
    const c = await make_content(env, "x");
    const versions = [ref(c)];
    const m = await manifest_blob(env, versions, "mx");

    const before = state_signature(env.db);
    await rejects_api(
      snapshot(env.service, agent_ctx(base, "foreign-snap"), { scope: "stage", stage_id: s.research, manifest_blob_id: m, versions, ...guard }),
      "forbidden",
    );
    assert.equal(state_signature(env.db), before);
    const ok = await snapshot(env.service, agent_ctx(base, "own-snap"), { scope: "stage", stage_id: s.plan, manifest_blob_id: m, versions, ...guard });
    assert.equal(ok.replayed, false);
  });
});

// ---------------------------------------------------------------------------
// E) the edition must be active

test("E: approve, seal and reopen are refused on an archived edition and write nothing", async () => {
  await with_env(async (env) => {
    const s = stage_ids(env.db, env.p.edition_id);
    await drive_stage(env, s.plan, "plan");
    const r = await start(env, s.research, "research-start");
    const sealed_ok = await seal_fresh(env, r.round_id, "research");
    env.db.run("UPDATE editions SET status = 'archived' WHERE id = ?", env.p.edition_id);
    const before = state_signature(env.db);
    await rejects_api(
      approve_stage(env.service, env.ctx("arch-approve"), { stage_id: s.research, snapshot_id: sealed_ok.snapshot_id }),
      "conflict",
    );
    await rejects_api(reopen_stage(env.service, env.ctx("arch-reopen"), { stage_id: s.plan }), "conflict");
    assert.equal(state_signature(env.db), before);
    assert.equal(stage_row(env.db, s.plan).status, "approved");
    assert.equal(stage_row(env.db, s.research).status, "active");
  });
});

test("E: round.seal is refused on an archived edition and the round stays open", async () => {
  await with_env(async (env) => {
    const s = stage_ids(env.db, env.p.edition_id);
    const r = await start(env, s.plan, "plan-start");
    const c = await make_content(env, "c");
    const versions = [ref(c)];
    const m = await manifest_blob(env, versions, "m");
    env.db.run("UPDATE editions SET status = 'archived' WHERE id = ?", env.p.edition_id);
    const before = state_signature(env.db);
    await rejects_api(seal_round(env.service, env.ctx("arch-seal"), { round_id: r.round_id, manifest_blob_id: m, versions }), "conflict");
    assert.equal(state_signature(env.db), before);
    assert.equal(round_row(env.db, r.round_id).state, "open");
  });
});

test("E: approve and seal are refused on a draft edition", async () => {
  await with_env(async (env) => {
    const s = stage_ids(env.db, env.p.edition_id);
    const r = await start(env, s.plan, "plan-start");
    const sealed = await seal_fresh(env, r.round_id, "plan");
    env.db.run("UPDATE editions SET status = 'draft' WHERE id = ?", env.p.edition_id);
    const before = state_signature(env.db);
    await rejects_api(
      approve_stage(env.service, env.ctx("draft-approve"), { stage_id: s.plan, snapshot_id: sealed.snapshot_id }),
      "conflict",
    );
    assert.equal(state_signature(env.db), before);
    assert.equal(stage_row(env.db, s.plan).status, "active");
  });
});

test("E: a completed edition can still be reopened (control)", async () => {
  await with_env(async (env) => {
    const s = stage_ids(env.db, env.p.edition_id);
    for (const key of ["plan", "research", "analyze", "write", "verify", "publish"] as const) {
      await drive_stage(env, s[key], key);
    }
    assert.equal(edition_row(env.db, env.p.edition_id).status, "completed");
    await reopen_stage(env.service, env.ctx("reopen-pub"), { stage_id: s.publish });
    assert.equal(edition_row(env.db, env.p.edition_id).status, "active");
    assert.equal(stage_row(env.db, s.publish).status, "active");
  });
});

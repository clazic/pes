// SEL-39 (stage 2 PR6) regression tests for the final review (leader rulings F1, R1).
// Written against the requirements; expected to FAIL until the code is fixed.
//  F1) stage.reopen ends a later stage's running run as 'cancelled' (not 'interrupted'), releases its lease and
//      records run.invalidated (run_id) like other unfinished runs. So claim({run_id}) cannot resume it:
//      refused, and receipts / events / leases do not change. The old basis can never be sealed or approved.
//  R1) a run with stage_id / round_id NULL (not aimed) is bound to its target stage / round by its first
//      round.seal (stage snapshots already require an aimed run) in the same transaction. Sealing another stage / round afterwards is
//      forbidden and writes nothing.
// Everything is synthetic.

import assert from "node:assert/strict";
import { test } from "node:test";

import { reopen_stage, seal_round } from "../scripts/pes_core/editions.ts";
import { claim } from "../scripts/pes_core/runs.ts";
import {
  add_agent,
  agent_claim,
  agent_ctx,
  aim_run,
  approvals_of,
  drive_stage,
  events_of,
  make_content,
  manifest_blob,
  receipt_of,
  rejects_api,
  round_row,
  stage_ids,
  stage_row,
  start,
  with_env,
  type Env,
} from "./helpers/editions_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

function ref(c: { object_id: string; version_id: string }) {
  return { object_id: c.object_id, version_id: c.version_id };
}

type RunRow = { status: string; ended_at: bigint | null; stage_id: string | null; round_id: string | null; context_snapshot_id: string | null; base_control_rev: bigint };
function run_row(env: Env, run_id: string): RunRow {
  return { ...env.db.get<RunRow>("SELECT status, ended_at, stage_id, round_id, context_snapshot_id, base_control_rev FROM runs WHERE id = ?", run_id)! };
}

// ---------------------------------------------------------------------------
// F1

test("F1: reopen cancels a later stage's running run (event run.invalidated), releases its lease, and the run cannot be claimed again", async () => {
  await with_env(async (env) => {
    const s = stage_ids(env.db, env.p.edition_id);
    const plan = await drive_stage(env, s.plan, "plan");
    const r = await start(env, s.research, "research-start");
    const base = add_agent(env);
    const old = await agent_claim(env, base, "claim");
    aim_run(env, old.run_id, s.research, r.round_id, plan.sealed.snapshot_id);
    const c = await make_content(env, "research-result-before-reopen");
    const versions = [ref(c)];
    const manifest_blob_id = await manifest_blob(env, versions, "research-before-reopen");

    await reopen_stage(env.service, env.ctx("reopen-plan"), { stage_id: s.plan });

    // the run is cancelled (not interrupted), the lease is released, one run.invalidated event carries run_id
    const after_reopen = run_row(env, old.run_id);
    assert.equal(after_reopen.status, "cancelled");
    assert.ok(after_reopen.ended_at !== null);
    const lease = env.db.get<{ state: string }>("SELECT state FROM project_leases WHERE project_id = ? AND lease_id = ?", env.p.project_id, old.lease_id)!;
    assert.notEqual(lease.state, "active");
    const receipt = receipt_of(env.db, env.p.project_id, "reopen-plan")!;
    const own = events_of(env.db, receipt.id).filter((e) => e.run_id === old.run_id);
    assert.deepEqual(own.map((e) => e.type), ["run.invalidated"]);
    assert.equal(events_of(env.db, receipt.id).some((e) => e.type === "run.interrupted"), false);

    // a re-claim of that run (new request key) is refused and changes nothing
    const before = state_signature(env.db);
    await rejects_api(claim(env.service, agent_ctx(base, "reclaim"), { run_id: old.run_id }), "conflict", "forbidden", "invalid_payload", "not_found");
    assert.equal(state_signature(env.db), before);
    assert.equal(receipt_of(env.db, env.p.project_id, "reclaim"), undefined, "a refused claim leaves no receipt");
    assert.deepEqual(run_row(env, old.run_id), after_reopen, "the run row is untouched (status, context, base_control_rev)");
    assert.equal(run_row(env, old.run_id).context_snapshot_id, plan.sealed.snapshot_id);

    // the old guard cannot seal either
    await rejects_api(
      seal_round(env.service, agent_ctx(base, "seal-old-guard"), { round_id: r.round_id, manifest_blob_id, versions, run_id: old.run_id, lease_id: old.lease_id, fence: old.fence }),
      "conflict", "forbidden",
    );
    assert.equal(round_row(env.db, r.round_id).state, "open");

    // plan is re-done and approved again: research is clean again, but the old run does not come back
    await drive_stage(env, s.plan, "plan2");
    assert.equal(run_row(env, old.run_id).status, "cancelled");
    const before2 = state_signature(env.db);
    await rejects_api(claim(env.service, agent_ctx(base, "reclaim-2"), { run_id: old.run_id }), "conflict", "forbidden", "invalid_payload", "not_found");
    assert.equal(state_signature(env.db), before2);
    await rejects_api(
      seal_round(env.service, agent_ctx(base, "seal-old-guard-2"), { round_id: r.round_id, manifest_blob_id, versions, run_id: old.run_id, lease_id: old.lease_id, fence: old.fence }),
      "conflict", "forbidden",
    );

    // so there is no sealed snapshot and no approval for research that rests on the old basis
    assert.equal(round_row(env.db, r.round_id).state, "open");
    assert.equal(round_row(env.db, r.round_id).sealed_snapshot_id, null);
    assert.deepEqual(approvals_of(env.db, s.research), []);
    assert.notEqual(stage_row(env.db, s.research).status, "approved");
  });
});

test("F1: a fresh claim (no run_id) after the reopen still works and gets a new run", async () => {
  await with_env(async (env) => {
    const s = stage_ids(env.db, env.p.edition_id);
    await drive_stage(env, s.plan, "plan");
    const r = await start(env, s.research, "research-start");
    const base = add_agent(env);
    const old = await agent_claim(env, base, "claim");
    aim_run(env, old.run_id, s.research, r.round_id, null);
    await reopen_stage(env.service, env.ctx("reopen-plan"), { stage_id: s.plan });
    const fresh = await agent_claim(env, base, "claim-new");
    assert.notEqual(fresh.run_id, old.run_id);
    assert.equal(run_row(env, fresh.run_id).status, "running");
    assert.equal(run_row(env, old.run_id).status, "cancelled");
  });
});

// ---------------------------------------------------------------------------
// R1

/** plan approved, research R1 open, plan reopened, plan R2 open. */
async function research_r1_and_plan_r2(env: Env) {
  const s = stage_ids(env.db, env.p.edition_id);
  await drive_stage(env, s.plan, "plan");
  const research_round = await start(env, s.research, "research-start");
  await reopen_stage(env.service, env.ctx("reopen-plan"), { stage_id: s.plan });
  const plan_round = await start(env, s.plan, "plan2-start");
  return { s, research_round, plan_round };
}

test("R1: an unaimed run is bound to the stage and round of its first seal; sealing another stage / round afterwards is forbidden and writes nothing", async () => {
  await with_env(async (env) => {
    const { s, research_round, plan_round } = await research_r1_and_plan_r2(env);
    const base = add_agent(env);
    const lease = await agent_claim(env, base, "claim");
    const guard = { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence };
    assert.equal(run_row(env, lease.run_id).stage_id, null);
    assert.equal(run_row(env, lease.run_id).round_id, null);

    const c1 = await make_content(env, "r1");
    const v1 = [ref(c1)];
    const m1 = await manifest_blob(env, v1, "m1");
    const c2 = await make_content(env, "r2");
    const v2 = [ref(c2)];
    const m2 = await manifest_blob(env, v2, "m2");

    const first = await seal_round(env.service, agent_ctx(base, "seal-research"), { round_id: research_round.round_id, manifest_blob_id: m1, versions: v1, ...guard });
    assert.equal(first.replayed, false);
    assert.equal(round_row(env.db, research_round.round_id).state, "sealed");
    const bound = run_row(env, lease.run_id);
    assert.equal(bound.stage_id, s.research, "bound to the sealed round's stage");
    assert.equal(bound.round_id, research_round.round_id, "bound to the sealed round");

    const before = state_signature(env.db);
    await rejects_api(
      seal_round(env.service, agent_ctx(base, "seal-plan"), { round_id: plan_round.round_id, manifest_blob_id: m2, versions: v2, ...guard }),
      "forbidden",
    );
    assert.equal(state_signature(env.db), before);
    assert.equal(round_row(env.db, plan_round.round_id).state, "open");
    assert.equal(receipt_of(env.db, env.p.project_id, "seal-plan"), undefined);
    assert.deepEqual(run_row(env, lease.run_id), bound);
  });
});

test("R1: the reviewer's sequence - one unaimed guard seals plan R2 first, then research R1 is refused (and the binding is the first target)", async () => {
  await with_env(async (env) => {
    const { s, research_round, plan_round } = await research_r1_and_plan_r2(env);
    const base = add_agent(env);
    const lease = await agent_claim(env, base, "claim");
    const guard = { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence };
    const c1 = await make_content(env, "p");
    const v1 = [ref(c1)];
    const m1 = await manifest_blob(env, v1, "mp");
    const c2 = await make_content(env, "q");
    const v2 = [ref(c2)];
    const m2 = await manifest_blob(env, v2, "mq");

    await seal_round(env.service, agent_ctx(base, "seal-plan"), { round_id: plan_round.round_id, manifest_blob_id: m1, versions: v1, ...guard });
    assert.equal(run_row(env, lease.run_id).stage_id, s.plan);
    assert.equal(run_row(env, lease.run_id).round_id, plan_round.round_id);
    const before = state_signature(env.db);
    await rejects_api(
      seal_round(env.service, agent_ctx(base, "seal-research"), { round_id: research_round.round_id, manifest_blob_id: m2, versions: v2, ...guard }),
      "forbidden",
    );
    assert.equal(state_signature(env.db), before);
    assert.equal(round_row(env.db, research_round.round_id).state, "open");
  });
});

test("R1: a seal refused for another reason does not bind the run", async () => {
  await with_env(async (env) => {
    const { s, research_round, plan_round } = await research_r1_and_plan_r2(env);
    const base = add_agent(env);
    const lease = await agent_claim(env, base, "claim");
    const guard = { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence };
    const m = await manifest_blob(env, [], "empty");
    const before = state_signature(env.db);
    await rejects_api(
      seal_round(env.service, agent_ctx(base, "empty-seal"), { round_id: research_round.round_id, manifest_blob_id: m, versions: [], ...guard }),
      "invalid_payload", "conflict", "forbidden",
    );
    assert.equal(state_signature(env.db), before);
    assert.equal(run_row(env, lease.run_id).stage_id, null);
    assert.equal(run_row(env, lease.run_id).round_id, null);
    assert.ok(s && plan_round);
  });
});

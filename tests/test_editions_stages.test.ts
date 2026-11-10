// SEL-39 (stage 2 PR6): editions / stages / rounds commands, tests written before the implementation.
// The worker matches these names and shapes. Everything is synthetic (FakeClock, temporary HOME).
// Rows from db.get() are null-prototype objects: compare them as { ...row }.
//
// Files (leader decision):
//   scripts/pes_core/commands/editions.ts  frozen EDITION_COMMAND_ENTRIES (command definitions, all SQL writes);
//                                          commands.ts spreads it into COMMANDS like the other *_COMMAND_ENTRIES.
//   scripts/pes_core/editions.ts           public functions, each exactly ONE service.execute (no SQL writes):
//     create_edition / start_round / seal_round / approve_stage / reopen_stage / release_completion /
//     carry_over / snapshot (service, ctx, input) -> Promise<CommandOutcome>
//     plus ONE read-only function (chosen by the test author, no write even on failure):
//     open_tasks_for_round(db, project_id, round_id) -> OpenTask[]   (see "carry_over tasks" below)
//   tests/helpers/command_names.ts         EXPECTED_COMMAND_NAMES gets the 8 names below (kept sorted).
//
// Commands (scope "project", NOT rev-bearing: no base_control_rev). Receipt action == event type.
//   command                    action / event type          who
//   edition.create             edition.created              human owner only
//   round.start                round.started                human member, or an agent member
//   round.seal                 round.sealed                 human member, or an agent that holds the lease (guard)
//   stage.approve              stage.approved               human owner ONLY (an agent -> ApiError "forbidden")
//   stage.reopen               stage.reopened               human owner ONLY (agent -> "forbidden")
//   edition.release_completion edition.completion_released human owner ONLY (agent -> "forbidden")
//   edition.carry_over         edition.carried_over         human owner only
//   edition.snapshot           edition.snapshotted          human member, or an agent that holds the lease (guard)
//   Unknown payload fields -> "invalid_payload"; a missing id (or an id of another project) -> "not_found";
//   a wrong state / wrong order -> "conflict". A rejection writes nothing (not even a receipt).
//   "human owner" = PR10 rule: actor.kind 'human' AND project_members role 'owner' (read_credential_actor);
//   an agent that shares the owner's user_id is still refused. "Guard" = {run_id, lease_id, fence} of the
//   agent's active, unexpired lease (PR5): a stale fence / released lease -> "conflict"; an agent call
//   WITHOUT a guard -> "forbidden"; a human needs no guard. A guarded call's receipt carries run_id,
//   lease_id, fence and its event carries run_id.
//
//   edition.create      {parent_edition_id?}  new edition: edition_no = max + 1, status 'draft', exactly six
//                       pending stages (plan..publish, ordinal 1..6), current_stage_id = its plan stage.
//                       It does not activate the edition. result {project_id, edition_id, edition_no, stage_ids}.
//   round.start         {stage_id}  the stage must belong to the ACTIVE edition, be the edition's current stage
//                       (or a later stage whose predecessors are all approved), and have no open round; stage 1
//                       needs nothing else; every other stage needs the previous stage approved. A stage that is
//                       'approved' and not stale -> "conflict"; an approved-but-stale stage may start a new round.
//                       Creates rounds(round_no = max+1, state 'open', base_snapshot_id = the stage's latest
//                       sealed snapshot or NULL), stages.current_round_id = it, stages.status 'active', stage rev + 1.
//                       result {project_id, edition_id, stage_id, round_id, round_no}.
//   round.seal          {round_id, manifest_blob_id, versions: [{object_id, version_id}, ...], run_id?, lease_id?, fence?}
//                       the round must be open (else "conflict"); manifest_blob_id is a READY blob of the project
//                       (made with the PR9 reserve/store/complete path); every {object_id, version_id} must be a real
//                       version OF THAT object (else "not_found"/"conflict"). Does NOT need an approval first.
//                       One tx: rounds.state 'sealed' + sealed_snapshot_id, a snapshots row (scope 'round',
//                       edition/stage/round ids, manifest_blob_id, content_hash 64 hex, control_rev = projects.control_rev),
//                       round_contents rows (round_id, object_id, version_id, position = list index, role 'result').
//                       result {project_id, round_id, snapshot_id, versions (the same list, same order), content_hash}.
//                       content_hash is a function of the exact version list: same list -> same hash, another version
//                       of an object -> another hash.
//   stage.approve       {stage_id, snapshot_id, note?}  snapshot_id must be the sealed snapshot of the stage's CURRENT
//                       round (round sealed; an open round, another stage's snapshot or an older snapshot -> "conflict").
//                       Writes approvals (origin 'new', assurance 'verified', actor_kind 'human', human_user_id = the
//                       owner's user, tx_id = the receipt id, snapshot_id), stages.status 'approved',
//                       approved_snapshot_id = snapshot_id, stale_since_event_seq NULL, rev + 1; the NEXT stage goes
//                       pending -> 'asking' and editions.current_stage_id moves to it. Approving the last stage
//                       (publish) sets editions.status 'completed'. Follow-ups and QA leftovers are never touched.
//                       result {project_id, stage_id, approval_id, snapshot_id, next_stage_id (null after publish),
//                       edition_completed (boolean)}.
//   stage.reopen        {stage_id, reason?}  stage must be 'approved' (else "conflict"). v0.15 semantics on the new schema:
//                       the stage gets status 'active', approved_snapshot_id NULL, stale NULL; editions.current_stage_id
//                       = it; a completed edition becomes 'active' again (completion released in the SAME tx);
//                       every LATER stage whose status is not 'pending' gets stale_since_event_seq = the event_seq of this
//                       command's 'stage.reopened' event. Approval rows and later stages' approved_snapshot_id are KEPT.
//                       Execution basis: runs of the later stages (stage ordinal > reopened) in status queued /
//                       waiting_human / blocked_usage / interrupted become 'cancelled' (ended_at = now) with one
//                       'run.invalidated' event each (run_id set); running runs with a lease are not touched here;
//                       succeeded / failed runs are history and stay as they are.
//                       result {project_id, stage_id, stale_stage_ids, cancelled_run_ids, edition_status}.
//   edition.release_completion {edition_id}  completed -> active (another active edition or a non-completed edition ->
//                       "conflict"). result {project_id, edition_id, status: 'active'}.
//   edition.snapshot    {scope: 'edition'|'stage', stage_id? (required for 'stage'), manifest_blob_id, versions}
//                       writes a snapshots row (same checks/hash as seal; through_event_seq = the last event_seq that
//                       existed when it ran; control_rev = projects.control_rev). A snapshot keeps pointing at the exact
//                       versions it was made with even after newer versions exist.
//                       result {project_id, snapshot_id, scope, versions, content_hash}.
//   edition.carry_over  two different branches, chosen by `kind`:
//     kind 'topic'   {kind: 'topic', source_version_id, stage_id, title, question?}  the source must be a version of an
//                    artifacts row with kind 'topic' (else "conflict"; missing -> "not_found"). Creates a NEW object
//                    (kind 'artifact') + artifacts(kind 'topic', stage_id, origin_version_id = EXACTLY source_version_id)
//                    + version 1 (current) + version_relations(from new version, to source version, 'derived_from').
//                    The source (and any newer version of it) is not changed.
//                    result {project_id, object_id, version_id, origin_version_id}.
//     kind 'tasks'   {kind: 'tasks', from_stage_id, to_stage_id}  to_stage ordinal must be greater than from_stage
//                    (else "conflict"). Every followup whose CURRENT version is kind 'next_round_task', targets
//                    from_stage_id and has state proposed / accepted / running / deferred is carried: a NEW version is
//                    appended (version_no + 1, object_versions.based_on_version_id = the old version) with the same
//                    kind, state, description, and base/proposed artifact ids, target_stage_id = to_stage_id,
//                    target_round_id NULL (the first round R1 of to_stage is not known yet), and followups.object's
//                    current_version_id moves to it. Old versions stay. applied / rejected / cancelled follow-ups
//                    are NOT carried. followups.origin_* columns are never changed.
//                    result {project_id, carried: [{followup_id, from_version_id, version_id}]} ordered by followup_id.
//   open_tasks_for_round(db, project_id, round_id) -> [{followup_id, version_id, state, description,
//                    based_on_version_id}]  the CURRENT versions of followups with kind 'next_round_task' whose
//                    target_stage_id is the round's stage, state proposed / accepted / running / deferred and
//                    (target_round_id IS NULL or = round_id), ordered by followup_id.
//
// complete (run.complete, PR5), seal and approve are three different events: 'run.completed', 'round.sealed',
// 'stage.approved'; run.complete changes neither rounds nor stages.

import assert from "node:assert/strict";
import { test } from "node:test";

import { COMMANDS } from "../scripts/pes_core/commands.ts";
import { add_artifact, append_version, create_object } from "../scripts/pes_core/content.ts";
import {
  approve_stage,
  carry_over,
  create_edition,
  open_tasks_for_round,
  release_completion,
  reopen_stage,
  seal_round,
  snapshot,
  start_round,
} from "../scripts/pes_core/editions.ts";
import { complete } from "../scripts/pes_core/runs.ts";
import { EXPECTED_COMMAND_NAMES } from "./helpers/command_names.ts";
import {
  STAGE_KEYS,
  add_agent,
  agent_claim,
  agent_ctx,
  aim_run,
  approvals_of,
  approve,
  drive_stage,
  edition_row,
  events_of,
  insert_followup,
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
  wrap_db,
  type Approved,
  type Env,
  type SealResult,
  type VersionRef,
} from "./helpers/editions_env.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

const EDITION_COMMANDS = [
  ["edition.create", "edition.created"],
  ["round.start", "round.started"],
  ["round.seal", "round.sealed"],
  ["stage.approve", "stage.approved"],
  ["stage.reopen", "stage.reopened"],
  ["edition.release_completion", "edition.completion_released"],
  ["edition.carry_over", "edition.carried_over"],
  ["edition.snapshot", "edition.snapshotted"],
] as const;

function ids(env: Env) {
  return stage_ids(env.db, env.p.edition_id);
}

async function drive_all(env: Env): Promise<{ sealed: Record<string, SealResult>; approved: Record<string, Approved> }> {
  const s = ids(env);
  const sealed: Record<string, SealResult> = {};
  const approved: Record<string, Approved> = {};
  for (const key of STAGE_KEYS) {
    const r = await drive_stage(env, s[key], key);
    sealed[key] = r.sealed;
    approved[key] = r.approved;
  }
  return { sealed, approved };
}

function last_event_seq(env: Env): bigint {
  return env.db.get<{ n: bigint }>("SELECT coalesce(max(event_seq), 0) AS n FROM events")!.n;
}

// ---------------------------------------------------------------------------
// Registry

test("the eight edition/stage/round commands are registered under their own distinct actions", () => {
  const actions = new Set<string>();
  for (const [name, action] of EDITION_COMMANDS) {
    const def = COMMANDS.get(name);
    assert.ok(def, `${name} is registered`);
    assert.equal(def.scope, "project");
    assert.equal(def.rev_bearing, false);
    assert.equal(def.action, action);
    actions.add(def.action);
    assert.ok(EXPECTED_COMMAND_NAMES.includes(name), `${name} is in EXPECTED_COMMAND_NAMES`);
  }
  assert.equal(actions.size, EDITION_COMMANDS.length);
});

// ---------------------------------------------------------------------------
// 1. A synthetic six-stage flow runs: edition -> round -> seal -> approve -> next stage opens ... -> publish

test("a synthetic edition runs through all six stages: start, seal, approve, next stage opens", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    assert.equal(edition_row(env.db, env.p.edition_id).status, "active");
    assert.equal(edition_row(env.db, env.p.edition_id).current_stage_id, s.plan);

    let prev_approved: Approved | undefined;
    for (const [index, key] of STAGE_KEYS.entries()) {
      const stage_id = s[key];
      const r = await drive_stage(env, stage_id, key);
      const stage = stage_row(env.db, stage_id);
      assert.equal(stage.status, "approved");
      assert.equal(stage.approved_snapshot_id, r.sealed.snapshot_id);
      assert.equal(stage.stale_since_event_seq, null);
      assert.equal(stage.current_round_id, r.round.round_id);
      assert.equal(r.round.round_no, 1);
      const round = round_row(env.db, r.round.round_id);
      assert.equal(round.state, "sealed");
      assert.equal(round.sealed_snapshot_id, r.sealed.snapshot_id);

      const next = STAGE_KEYS[index + 1];
      if (next !== undefined) {
        assert.equal(r.approved.next_stage_id, s[next]);
        assert.equal(r.approved.edition_completed, false);
        assert.equal(stage_row(env.db, s[next]).status, "asking", "the next stage opens (pending -> asking)");
        assert.equal(edition_row(env.db, env.p.edition_id).current_stage_id, s[next]);
        assert.equal(edition_row(env.db, env.p.edition_id).status, "active");
      } else {
        assert.equal(r.approved.next_stage_id, null);
        assert.equal(r.approved.edition_completed, true);
        assert.equal(edition_row(env.db, env.p.edition_id).status, "completed");
      }
      prev_approved = r.approved;
    }
    assert.ok(prev_approved);
    for (const key of STAGE_KEYS) {
      assert.equal(approvals_of(env.db, s[key]).length, 1, `${key} has exactly one approval`);
      assert.equal(stage_row(env.db, s[key]).status, "approved");
    }
  });
});

test("approval rows record a verified new human approval tied to the receipt", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const r = await drive_stage(env, s.plan, "plan");
    const rows = approvals_of(env.db, s.plan);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.id, r.approved.approval_id);
    assert.equal(row.snapshot_id, r.sealed.snapshot_id);
    assert.equal(row.actor_id, env.p.actor_id);
    assert.equal(row.actor_kind, "human");
    assert.equal(row.origin, "new");
    assert.equal(row.assurance, "verified");
    assert.ok(row.human_user_id);
    const receipt = receipt_of(env.db, env.p.project_id, "plan-approve");
    assert.ok(receipt);
    assert.equal(row.tx_id, receipt.id);
  });
});

test("edition.create makes a draft edition with exactly six pending stages and does not activate it", async () => {
  await with_env(async (env) => {
    const before_active = edition_row(env.db, env.p.edition_id);
    const out = await create_edition(env.service, env.ctx("ed-2"), { parent_edition_id: env.p.edition_id });
    const r = out.result as { edition_id: string; edition_no: number; stage_ids: Record<string, string> };
    assert.equal(r.edition_no, 2);
    const ed = edition_row(env.db, r.edition_id);
    assert.equal(ed.edition_no, 2n);
    assert.equal(ed.status, "draft");
    assert.equal(ed.parent_edition_id, env.p.edition_id);
    const stages = env.db.all<{ key: string; ordinal: bigint; status: string }>(
      "SELECT key, ordinal, status FROM stages WHERE edition_id = ? ORDER BY ordinal",
      r.edition_id,
    );
    assert.deepEqual(
      stages.map((x) => ({ ...x })),
      STAGE_KEYS.map((key, i) => ({ key, ordinal: BigInt(i + 1), status: "pending" })),
    );
    assert.equal(ed.current_stage_id, r.stage_ids.plan);
    assert.deepEqual({ ...edition_row(env.db, env.p.edition_id) }, { ...before_active }, "the active edition is untouched");
    const project = env.db.get<{ active_edition_id: string }>("SELECT active_edition_id FROM projects WHERE id = ?", env.p.project_id);
    assert.equal(project!.active_edition_id, env.p.edition_id);

    const receipt = receipt_of(env.db, env.p.project_id, "ed-2");
    assert.ok(receipt);
    assert.equal(receipt.action, "edition.created");
    assert.deepEqual(events_of(env.db, receipt.id).map((e) => e.type), ["edition.created"]);

    // a round cannot start in a draft edition
    await rejects_api(start_round(env.service, env.ctx("draft-start"), { stage_id: r.stage_ids.plan }), "conflict");
  });
});

test("a failure in the middle of edition.create rolls everything back (no half-built edition)", async () => {
  await with_env(async (env) => {
    const before = state_signature(env.db);
    let stage_inserts = 0;
    const wrapped = wrap_db(env.db, (sql) => {
      if (/INSERT INTO stages/i.test(sql)) {
        stage_inserts += 1;
        if (stage_inserts === 4) throw new Error("injected failure");
      }
    });
    await assert.rejects(create_edition(env.with_db(wrapped), env.ctx("ed-fail"), {}));
    assert.equal(state_signature(env.db), before);
    const ok = await create_edition(env.service, env.ctx("ed-fail"), {});
    assert.equal(ok.replayed, false);
  });
});

// ---------------------------------------------------------------------------
// Order and state rules

test("a stage cannot start before the previous stage is approved; one open round per stage", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const before = state_signature(env.db);
    await rejects_api(start_round(env.service, env.ctx("early"), { stage_id: s.research }), "conflict");
    assert.equal(state_signature(env.db), before, "a rejected start writes nothing");

    const r1 = await start(env, s.plan, "plan-start");
    assert.equal(stage_row(env.db, s.plan).status, "active");
    assert.equal(stage_row(env.db, s.plan).current_round_id, r1.round_id);
    const open = env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM rounds WHERE stage_id = ? AND state = 'open'", s.plan)!.n;
    assert.equal(open, 1n);
    await rejects_api(start_round(env.service, env.ctx("second-open"), { stage_id: s.plan }), "conflict");
    await rejects_api(start_round(env.service, env.ctx("bad-stage"), { stage_id: "no-such-stage" }), "not_found");
    await rejects_api(start_round(env.service, env.ctx("extra"), { stage_id: s.plan, surprise: 1 }), "invalid_payload");
  });
});

test("seal and approve respect the round state; a sealed round cannot be sealed again", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const round = await start(env, s.plan, "plan-start");
    const content = await make_content(env, "c1");
    const versions = [{ object_id: content.object_id, version_id: content.version_id }];

    // approving while the round is still open is refused
    const other = await seal(env, round.round_id, versions, "seal-1");
    const sealed = other.result as SealResult;
    const before = state_signature(env.db);
    await rejects_api(seal(env, round.round_id, versions, "seal-2"), "conflict");
    // (the second seal uploaded a manifest blob before being refused; only business rows must be unchanged)
    const counts = table_counts(env.db);
    assert.equal(counts.rounds, 1n);
    assert.equal(counts.approvals, 0n);
    assert.notEqual(before, "");

    // a snapshot of another stage cannot approve this stage
    const s2 = await seal_other_stage_snapshot(env);
    await rejects_api(approve_stage(env.service, env.ctx("wrong-snap"), { stage_id: s.plan, snapshot_id: s2 }), "conflict");
    assert.equal(table_counts(env.db).approvals, 0n);

    const approved = await approve(env, s.plan, sealed.snapshot_id, "approve-ok");
    assert.equal(approved.snapshot_id, sealed.snapshot_id);
    // approving twice is a conflict, not a second approval
    await rejects_api(approve_stage(env.service, env.ctx("approve-again"), { stage_id: s.plan, snapshot_id: sealed.snapshot_id }), "conflict");
    assert.equal(approvals_of(env.db, s.plan).length, 1);
  });
});

async function seal_other_stage_snapshot(env: Env): Promise<string> {
  // an edition-scope snapshot is a valid snapshot of this edition, but it is not this stage's sealed snapshot
  const content = await make_content(env, "other");
  const versions = [{ object_id: content.object_id, version_id: content.version_id }];
  const manifest_blob_id = await manifest_blob(env, versions, "other");
  const out = await snapshot(env.service, env.ctx("other-snap"), { scope: "edition", manifest_blob_id, versions });
  return (out.result as { snapshot_id: string }).snapshot_id;
}

test("approving a stage whose round is still open is refused and writes nothing", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const round = await start(env, s.plan, "plan-start");
    const content = await make_content(env, "c1");
    const versions = [{ object_id: content.object_id, version_id: content.version_id }];
    const snap_id = await seal_other_stage_snapshot(env);
    const before = state_signature(env.db);
    await rejects_api(approve_stage(env.service, env.ctx("early-approve"), { stage_id: s.plan, snapshot_id: snap_id }), "conflict");
    assert.equal(state_signature(env.db), before);
    assert.equal(round_row(env.db, round.round_id).state, "open");
    assert.deepEqual(versions.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 3. complete / seal / approve are three different events

test("run.complete, round.seal and stage.approve leave three different events and move different state", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const round = await start(env, s.plan, "plan-start");

    // a run belonging to this round ends: that is not a seal and not an approval
    const lease = await agent_claim(env, { ...env.ctx("x"), actor_id: env.p.actor_id }, "claim-1");
    aim_run(env, lease.run_id, s.plan, round.round_id, null);
    const done = await complete(env.service, env.ctx("run-done"), { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence });
    const done_receipt = receipt_of(env.db, env.p.project_id, "run-done")!;
    assert.deepEqual(events_of(env.db, done_receipt.id).map((e) => e.type), ["run.completed"]);
    assert.equal(done.replayed, false);
    assert.equal(round_row(env.db, round.round_id).state, "open", "complete does not seal");
    assert.equal(stage_row(env.db, s.plan).status, "active", "complete does not approve");
    assert.equal(table_counts(env.db).approvals, 0n);

    const content = await make_content(env, "c1");
    const versions = [{ object_id: content.object_id, version_id: content.version_id }];
    const sealed = (await seal(env, round.round_id, versions, "seal-1")).result as SealResult;
    const seal_receipt = receipt_of(env.db, env.p.project_id, "seal-1")!;
    assert.deepEqual(events_of(env.db, seal_receipt.id).map((e) => e.type), ["round.sealed"]);
    assert.equal(round_row(env.db, round.round_id).state, "sealed");
    assert.equal(stage_row(env.db, s.plan).status, "active", "seal does not approve");
    assert.equal(stage_row(env.db, s.plan).approved_snapshot_id, null);
    assert.equal(table_counts(env.db).approvals, 0n);

    await approve(env, s.plan, sealed.snapshot_id, "approve-1");
    const approve_receipt = receipt_of(env.db, env.p.project_id, "approve-1")!;
    assert.deepEqual(events_of(env.db, approve_receipt.id).map((e) => e.type), ["stage.approved"]);
    assert.equal(stage_row(env.db, s.plan).status, "approved");

    const tx_ids = new Set([done_receipt.id, seal_receipt.id, approve_receipt.id]);
    assert.equal(tx_ids.size, 3, "three separate transactions");
    const actions = [done_receipt.action, seal_receipt.action, approve_receipt.action];
    assert.deepEqual(actions, ["run.completed", "round.sealed", "stage.approved"]);
  });
});

// ---------------------------------------------------------------------------
// 4. Seal before approval; permitted agent seals; agent approval is refused

test("a human seals a round before any approval exists and the round, snapshot and contents agree", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const round = await start(env, s.plan, "plan-start");
    const a = await make_content(env, "a");
    const b = await make_content(env, "b");
    const versions: VersionRef[] = [
      { object_id: a.object_id, version_id: a.version_id },
      { object_id: b.object_id, version_id: b.version_id },
    ];
    const out = await seal(env, round.round_id, versions, "seal-1");
    const r = out.result as SealResult;
    assert.deepEqual(r.versions, versions);
    assert.match(r.content_hash, /^[0-9a-f]{64}$/);

    const row = env.db.get<{
      scope: string; edition_id: string; stage_id: string | null; round_id: string | null; manifest_blob_id: string; content_hash: string; control_rev: bigint;
    }>("SELECT * FROM snapshots WHERE id = ?", r.snapshot_id)!;
    assert.equal(row.scope, "round");
    assert.equal(row.edition_id, env.p.edition_id);
    assert.equal(row.stage_id, s.plan);
    assert.equal(row.round_id, round.round_id);
    assert.equal(row.content_hash, r.content_hash);
    const project = env.db.get<{ control_rev: bigint }>("SELECT control_rev FROM projects WHERE id = ?", env.p.project_id)!;
    assert.equal(row.control_rev, project.control_rev);
    const blob = env.db.get<{ state: string }>("SELECT state FROM blobs WHERE id = ?", row.manifest_blob_id)!;
    assert.equal(blob.state, "ready");

    const contents = env.db.all<{ object_id: string; version_id: string; position: bigint; role: string }>(
      "SELECT object_id, version_id, position, role FROM round_contents WHERE round_id = ? ORDER BY position",
      round.round_id,
    );
    assert.deepEqual(
      contents.map((c) => ({ ...c })),
      versions.map((v, i) => ({ ...v, position: BigInt(i), role: "result" })),
    );
    assert.equal(table_counts(env.db).approvals, 0n, "sealing needs and creates no approval");
    const receipt = receipt_of(env.db, env.p.project_id, "seal-1")!;
    assert.equal(receipt.action, "round.sealed");
    const ev = events_of(env.db, receipt.id);
    assert.deepEqual(ev.map((e) => e.type), ["round.sealed"]);
  });
});

test("sealing refuses a version that does not belong to the named object or does not exist", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const round = await start(env, s.plan, "plan-start");
    const a = await make_content(env, "a");
    const b = await make_content(env, "b");
    const before = table_counts(env.db);
    await rejects_api(
      seal(env, round.round_id, [{ object_id: a.object_id, version_id: b.version_id }], "bad-pair"),
      "conflict",
      "not_found",
    );
    await rejects_api(
      seal(env, round.round_id, [{ object_id: a.object_id, version_id: "no-such-version" }], "bad-ver"),
      "not_found",
    );
    const after = table_counts(env.db);
    assert.equal(after.rounds, before.rounds);
    assert.equal(after.snapshots, before.snapshots);
    assert.equal(after.round_contents, before.round_contents);
    assert.equal(round_row(env.db, round.round_id).state, "open");
  });
});

test("an agent that holds the lease may seal; without a guard or with a stale fence it may not", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const base = add_agent(env);
    const round = await start(env, s.plan, "plan-start");
    const content = await make_content(env, "a");
    const versions = [{ object_id: content.object_id, version_id: content.version_id }];

    const lease = await agent_claim(env, base, "agent-claim");
    const before = state_signature(env.db);

    // no guard at all -> forbidden for an agent
    await rejects_api(seal(env, round.round_id, versions, "agent-noguard", agent_ctx(base, "agent-noguard")), "forbidden");
    // a wrong fence -> conflict
    await rejects_api(
      seal(env, round.round_id, versions, "agent-stale", agent_ctx(base, "agent-stale"), {
        run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence + 1,
      }),
      "conflict",
    );
    assert.equal(round_row(env.db, round.round_id).state, "open");
    assert.ok(before.length > 0);

    const out = await seal(env, round.round_id, versions, "agent-seal", agent_ctx(base, "agent-seal"), {
      run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence,
    });
    assert.equal(out.replayed, false);
    assert.equal(round_row(env.db, round.round_id).state, "sealed");
    const receipt = receipt_of(env.db, env.p.project_id, "agent-seal")!;
    assert.equal(receipt.run_id, lease.run_id);
    assert.equal(receipt.lease_id, lease.lease_id);
    assert.equal(receipt.fence, BigInt(lease.fence));
    assert.equal(events_of(env.db, receipt.id)[0]!.run_id, lease.run_id);
    assert.equal(table_counts(env.db).approvals, 0n, "an agent seal is not an approval");
  });
});

test("an agent cannot approve a stage, reopen it, create an edition or release completion; nothing is written", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const base = add_agent(env);
    const round = await start(env, s.plan, "plan-start");
    const content = await make_content(env, "a");
    const versions = [{ object_id: content.object_id, version_id: content.version_id }];
    const sealed = (await seal(env, round.round_id, versions, "seal-1")).result as SealResult;
    const lease = await agent_claim(env, base, "agent-claim");
    const guard = { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence };

    const before = state_signature(env.db);
    await rejects_api(
      approve_stage(env.service, agent_ctx(base, "agent-approve"), { stage_id: s.plan, snapshot_id: sealed.snapshot_id, ...guard }),
      "forbidden",
    );
    await rejects_api(
      approve_stage(env.service, agent_ctx(base, "agent-approve-2"), { stage_id: s.plan, snapshot_id: sealed.snapshot_id }),
      "forbidden",
    );
    await rejects_api(create_edition(env.service, agent_ctx(base, "agent-edition"), {}), "forbidden");
    await rejects_api(release_completion(env.service, agent_ctx(base, "agent-release"), { edition_id: env.p.edition_id }), "forbidden");
    assert.equal(state_signature(env.db), before, "refused agent commands write nothing, not even a receipt");
    assert.equal(stage_row(env.db, s.plan).status, "active");
    assert.equal(table_counts(env.db).approvals, 0n);

    // the human approves; then the agent still cannot reopen
    await approve(env, s.plan, sealed.snapshot_id, "approve-ok");
    const after = state_signature(env.db);
    await rejects_api(reopen_stage(env.service, agent_ctx(base, "agent-reopen"), { stage_id: s.plan, ...guard }), "forbidden");
    assert.equal(state_signature(env.db), after);
    assert.equal(stage_row(env.db, s.plan).status, "approved");
  });
});

// ---------------------------------------------------------------------------
// 2. reopen: stale, approvals kept, execution basis invalidated, completion released

test("reopen keeps every approval, marks later stages stale, invalidates dependent runs and moves the pointer back", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const plan = await drive_stage(env, s.plan, "plan");
    const research = await drive_stage(env, s.research, "research");
    // research approval opened analyze ('asking')
    assert.equal(stage_row(env.db, s.analyze).status, "asking");

    // runs that lean on earlier results (context_snapshot_id = the research sealed snapshot)
    insert_run(env, "run-queued", "queued", s.research, research.round.round_id, research.sealed.snapshot_id);
    insert_run(env, "run-waiting", "waiting_human", s.analyze, null, research.sealed.snapshot_id);
    insert_run(env, "run-done", "succeeded", s.research, research.round.round_id, plan.sealed.snapshot_id);
    const approvals_before = env.db.all("SELECT * FROM approvals ORDER BY id").map((r) => ({ ...r }));

    const out = await reopen_stage(env.service, env.ctx("reopen-plan"), { stage_id: s.plan, reason: "합성: 질문 범위 변경" });
    const r = out.result as { stage_id: string; stale_stage_ids: string[]; cancelled_run_ids: string[]; edition_status: string };
    assert.equal(r.stage_id, s.plan);
    assert.deepEqual([...r.stale_stage_ids].sort(), [s.research, s.analyze].sort());
    assert.deepEqual([...r.cancelled_run_ids].sort(), ["run-queued", "run-waiting"]);
    assert.equal(r.edition_status, "active");

    const receipt = receipt_of(env.db, env.p.project_id, "reopen-plan")!;
    assert.equal(receipt.action, "stage.reopened");
    const events = events_of(env.db, receipt.id);
    const reopened_event = events.find((e) => e.type === "stage.reopened");
    assert.ok(reopened_event);
    assert.deepEqual(events.filter((e) => e.type === "run.invalidated").map((e) => e.run_id).sort(), ["run-queued", "run-waiting"]);

    const plan_row = stage_row(env.db, s.plan);
    assert.equal(plan_row.status, "active");
    assert.equal(plan_row.approved_snapshot_id, null);
    assert.equal(plan_row.stale_since_event_seq, null);
    assert.equal(edition_row(env.db, env.p.edition_id).current_stage_id, s.plan);

    for (const stage_id of [s.research, s.analyze]) {
      assert.equal(stage_row(env.db, stage_id).stale_since_event_seq, reopened_event.event_seq, "stale points at the reopen event");
    }
    assert.equal(stage_row(env.db, s.research).status, "approved", "stale does not erase the approval");
    assert.equal(stage_row(env.db, s.research).approved_snapshot_id, research.sealed.snapshot_id);
    for (const stage_id of [s.write, s.verify, s.publish]) {
      assert.equal(stage_row(env.db, stage_id).stale_since_event_seq, null, "a pending stage was never built on the old result");
    }

    assert.deepEqual(env.db.all("SELECT * FROM approvals ORDER BY id").map((x) => ({ ...x })), approvals_before, "approval history is untouched");

    const status = (id: string) => env.db.get<{ status: string; ended_at: bigint | null }>("SELECT status, ended_at FROM runs WHERE id = ?", id)!;
    assert.equal(status("run-queued").status, "cancelled");
    assert.equal(status("run-queued").ended_at, BigInt(env.clock.now_ms()));
    assert.equal(status("run-waiting").status, "cancelled");
    assert.equal(status("run-done").status, "succeeded", "finished runs are history");

    // reopening something that is not approved is a conflict and writes nothing
    const before = state_signature(env.db);
    await rejects_api(reopen_stage(env.service, env.ctx("reopen-again"), { stage_id: s.plan }), "conflict");
    assert.equal(state_signature(env.db), before);
  });
});

test("after a reopen the stage gets a new round on top of the old sealed snapshot; re-approval keeps the old approval and stale clears only when that stage is re-approved", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const plan = await drive_stage(env, s.plan, "plan");
    const research = await drive_stage(env, s.research, "research");
    await reopen_stage(env.service, env.ctx("reopen-plan"), { stage_id: s.plan });

    // an approved, non-stale stage cannot start a round; a reopened one can (round 2 on top of the old snapshot)
    const r2 = await start(env, s.plan, "plan-r2");
    assert.equal(r2.round_no, 2);
    assert.equal(round_row(env.db, r2.round_id).base_snapshot_id, plan.sealed.snapshot_id);
    const c2 = await make_content(env, "plan-c2");
    const v2 = [{ object_id: c2.object_id, version_id: c2.version_id }];
    const sealed2 = (await seal(env, r2.round_id, v2, "plan-seal-2")).result as SealResult;
    await approve(env, s.plan, sealed2.snapshot_id, "plan-approve-2");

    assert.equal(approvals_of(env.db, s.plan).length, 2, "the first approval is kept next to the new one");
    assert.equal(stage_row(env.db, s.plan).approved_snapshot_id, sealed2.snapshot_id);
    assert.notEqual(stage_row(env.db, s.research).stale_since_event_seq, null, "research is still stale after plan is re-approved");
    assert.equal(edition_row(env.db, env.p.edition_id).current_stage_id, s.research);

    // research is approved but stale, so it may start another round; re-approving clears its stale mark
    const rr = await start(env, s.research, "research-r2");
    assert.equal(rr.round_no, 2);
    const c3 = await make_content(env, "research-c2");
    const sealed3 = (await seal(env, rr.round_id, [{ object_id: c3.object_id, version_id: c3.version_id }], "research-seal-2")).result as SealResult;
    await approve(env, s.research, sealed3.snapshot_id, "research-approve-2");
    assert.equal(stage_row(env.db, s.research).stale_since_event_seq, null);
    assert.equal(stage_row(env.db, s.research).approved_snapshot_id, sealed3.snapshot_id);
    assert.equal(approvals_of(env.db, s.research).length, 2);
    assert.notEqual(stage_row(env.db, s.analyze).stale_since_event_seq, null, "analyze is stale until it is approved again");
    assert.equal(research.approved.stage_id, s.research);

    // a non-stale approved stage refuses a new round
    await rejects_api(start_round(env.service, env.ctx("research-r3"), { stage_id: s.research }), "conflict");
  });
});

test("reopening after the last approval releases the edition completion in the same transaction", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    await drive_all(env);
    assert.equal(edition_row(env.db, env.p.edition_id).status, "completed");

    const out = await reopen_stage(env.service, env.ctx("reopen-write"), { stage_id: s.write });
    const r = out.result as { stale_stage_ids: string[]; edition_status: string };
    assert.equal(r.edition_status, "active");
    assert.equal(edition_row(env.db, env.p.edition_id).status, "active");
    assert.deepEqual([...r.stale_stage_ids].sort(), [s.verify, s.publish].sort());
    assert.equal(edition_row(env.db, env.p.edition_id).current_stage_id, s.write);
    // earlier stages stay approved and are not stale
    for (const key of ["plan", "research", "analyze"] as const) {
      assert.equal(stage_row(env.db, s[key]).status, "approved");
      assert.equal(stage_row(env.db, s[key]).stale_since_event_seq, null);
    }
  });
});

test("release_completion turns a completed edition active again; any other state is a conflict", async () => {
  await with_env(async (env) => {
    const before = state_signature(env.db);
    await rejects_api(release_completion(env.service, env.ctx("rel-active"), { edition_id: env.p.edition_id }), "conflict");
    assert.equal(state_signature(env.db), before);

    await drive_all(env);
    assert.equal(edition_row(env.db, env.p.edition_id).status, "completed");
    const approvals = table_counts(env.db).approvals;
    const out = await release_completion(env.service, env.ctx("rel-1"), { edition_id: env.p.edition_id });
    assert.equal((out.result as { status: string }).status, "active");
    assert.equal(edition_row(env.db, env.p.edition_id).status, "active");
    assert.equal(table_counts(env.db).approvals, approvals, "releasing completion does not remove an approval");
    for (const key of STAGE_KEYS) assert.equal(stage_row(env.db, ids(env)[key]).status, "approved");
    const receipt = receipt_of(env.db, env.p.project_id, "rel-1")!;
    assert.equal(receipt.action, "edition.completion_released");
    assert.deepEqual(events_of(env.db, receipt.id).map((e) => e.type), ["edition.completion_released"]);

    await rejects_api(release_completion(env.service, env.ctx("rel-nope"), { edition_id: "no-such-edition" }), "not_found");
  });
});

// ---------------------------------------------------------------------------
// 5. Remaining QA findings / unfinished requests survive approval and carry_over, and show in the next R1

test("follow-ups of several stages survive approval and carry_over and are listed for the next stage's R1", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const f1 = insert_followup(env, "qa-1", s.plan, "accepted", "합성 QA 지적: 조사 범위 한 줄 보강");
    const f2 = insert_followup(env, "qa-2", s.plan, "proposed", "합성 미완료 요청: 용어 정리");
    const f3 = insert_followup(env, "done-1", s.plan, "applied", "합성 끝난 요청");
    const f4 = insert_followup(env, "qa-3", s.research, "accepted", "합성 QA 지적: 출처 한 곳 더");
    const followup_rows = () =>
      env.db.all("SELECT * FROM followup_versions ORDER BY version_id").map((r) => ({ ...r }));
    const initial_rows = followup_rows();

    // approving the plan stage touches no follow-up
    await drive_stage(env, s.plan, "plan");
    assert.deepEqual(followup_rows(), initial_rows, "approval leaves follow-ups exactly as they were");
    const plan_round = env.db.get<{ id: string }>("SELECT id FROM rounds WHERE stage_id = ?", s.plan)!.id;
    assert.deepEqual(
      open_tasks_for_round(env.db, env.p.project_id, plan_round).map((t) => t.followup_id),
      [f1.object_id, f2.object_id].sort(),
      "still listed for the stage they were aimed at",
    );

    // carry the plan leftovers into research
    const out = await carry_over(env.service, env.ctx("carry-1"), { kind: "tasks", from_stage_id: s.plan, to_stage_id: s.research });
    const carried = (out.result as { carried: { followup_id: string; from_version_id: string; version_id: string }[] }).carried;
    assert.deepEqual(carried.map((c) => c.followup_id), [f1.object_id, f2.object_id].sort());
    assert.deepEqual(carried.map((c) => c.from_version_id), [f1, f2].sort((a, b) => a.object_id.localeCompare(b.object_id)).map((f) => f.version_id));

    // old versions are intact, new versions point at research, keep the request text and chain back to the old version
    for (const c of carried) {
      const old = env.db.get<Record<string, unknown>>("SELECT * FROM followup_versions WHERE version_id = ?", c.from_version_id)!;
      const orig = initial_rows.find((r) => r.version_id === c.from_version_id)!;
      assert.deepEqual({ ...old }, orig, "the old version is unchanged");
      const nv = env.db.get<{ kind: string; state: string; description: string; target_stage_id: string; target_round_id: string | null }>(
        "SELECT kind, state, description, target_stage_id, target_round_id FROM followup_versions WHERE version_id = ?",
        c.version_id,
      )!;
      assert.equal(nv.kind, "next_round_task");
      assert.equal(nv.state, orig.state);
      assert.equal(nv.description, orig.description);
      assert.equal(nv.target_stage_id, s.research);
      assert.equal(nv.target_round_id, null);
      const ov = env.db.get<{ version_no: bigint; based_on_version_id: string | null; object_id: string }>(
        "SELECT version_no, based_on_version_id, object_id FROM object_versions WHERE id = ?",
        c.version_id,
      )!;
      assert.equal(ov.version_no, 2n);
      assert.equal(ov.based_on_version_id, c.from_version_id);
      assert.equal(env.db.get<{ current_version_id: string }>("SELECT current_version_id FROM objects WHERE id = ?", c.followup_id)!.current_version_id, c.version_id);
    }
    // the finished request was not carried and the research follow-up was not changed
    assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM object_versions WHERE object_id = ?", f3.object_id)!.n, 1n);
    assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM object_versions WHERE object_id = ?", f4.object_id)!.n, 1n);
    const receipt = receipt_of(env.db, env.p.project_id, "carry-1")!;
    assert.equal(receipt.action, "edition.carried_over");
    assert.deepEqual(events_of(env.db, receipt.id).map((e) => e.type), ["edition.carried_over"]);

    // research R1 lists the carried requests together with its own
    const r1 = await start(env, s.research, "research-start");
    const tasks = open_tasks_for_round(env.db, env.p.project_id, r1.round_id);
    assert.deepEqual(tasks.map((t) => t.followup_id), [f1.object_id, f2.object_id, f4.object_id].sort());
    const carried_task = tasks.find((t) => t.followup_id === f1.object_id)!;
    assert.equal(carried_task.version_id, carried.find((c) => c.followup_id === f1.object_id)!.version_id);
    assert.equal(carried_task.based_on_version_id, f1.version_id);
    assert.equal(carried_task.description, "합성 QA 지적: 조사 범위 한 줄 보강");
    assert.equal(tasks.find((t) => t.followup_id === f4.object_id)!.based_on_version_id, null);

    // finish research, carry again: the chain keeps growing and nothing is lost
    const research_c = await make_content(env, "research-c");
    const sealed = (await seal(env, r1.round_id, [{ object_id: research_c.object_id, version_id: research_c.version_id }], "research-seal")).result as SealResult;
    await approve(env, s.research, sealed.snapshot_id, "research-approve");
    await carry_over(env.service, env.ctx("carry-2"), { kind: "tasks", from_stage_id: s.research, to_stage_id: s.analyze });
    const a1 = await start(env, s.analyze, "analyze-start");
    const analyze_tasks = open_tasks_for_round(env.db, env.p.project_id, a1.round_id);
    assert.deepEqual(analyze_tasks.map((t) => t.followup_id), [f1.object_id, f2.object_id, f4.object_id].sort());
    assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM object_versions WHERE object_id = ?", f1.object_id)!.n, 3n);
    assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM object_versions WHERE object_id = ?", f3.object_id)!.n, 1n);

    // a target stage that is not later than the source is refused
    const before = state_signature(env.db);
    await rejects_api(carry_over(env.service, env.ctx("carry-back"), { kind: "tasks", from_stage_id: s.analyze, to_stage_id: s.plan }), "conflict");
    assert.equal(state_signature(env.db), before);
  });
});

test("carry_over of topics derives a NEW topic from the exact source version and links them", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const obj = (await create_object(env.service, env.ctx("t-o"), { kind: "artifact", edition_id: env.p.edition_id })).result as { object_id: string };
    const v1 = (
      await add_artifact(env.service, env.ctx("t-v1"), {
        object_id: obj.object_id, artifact_kind: "topic", stage_id: s.plan, title: "합성 주제 A", summary: "합성 요약", question: "합성 질문?",
      })
    ).result as { version_id: string };
    // the source topic gets a newer version afterwards; the derivation must still point at v1
    await append_version(env.service, env.ctx("t-v2"), { object_id: obj.object_id, title: "합성 주제 A (고침)" });
    const before_source = env.db.all("SELECT * FROM object_versions WHERE object_id = ? ORDER BY version_no", obj.object_id).map((r) => ({ ...r }));

    const out = await carry_over(env.service, env.ctx("carry-topic"), {
      kind: "topic", source_version_id: v1.version_id, stage_id: s.research, title: "합성 조사 주제 A", question: "합성 질문?",
    });
    const r = out.result as { object_id: string; version_id: string; origin_version_id: string };
    assert.equal(r.origin_version_id, v1.version_id);
    assert.notEqual(r.object_id, obj.object_id);

    const art = env.db.get<{ kind: string; stage_id: string | null; origin_version_id: string | null }>(
      "SELECT kind, stage_id, origin_version_id FROM artifacts WHERE object_id = ?",
      r.object_id,
    )!;
    assert.equal(art.kind, "topic");
    assert.equal(art.stage_id, s.research);
    assert.equal(art.origin_version_id, v1.version_id);
    const ver = env.db.get<{ title: string; question: string | null }>("SELECT title, question FROM artifact_versions WHERE version_id = ?", r.version_id)!;
    assert.equal(ver.title, "합성 조사 주제 A");
    assert.equal(ver.question, "합성 질문?");
    assert.equal(env.db.get<{ current_version_id: string }>("SELECT current_version_id FROM objects WHERE id = ?", r.object_id)!.current_version_id, r.version_id);
    const rel = env.db.all<{ from_version_id: string; to_version_id: string; kind: string }>(
      "SELECT from_version_id, to_version_id, kind FROM version_relations WHERE from_version_id = ?",
      r.version_id,
    );
    assert.deepEqual(rel.map((x) => ({ ...x })), [{ from_version_id: r.version_id, to_version_id: v1.version_id, kind: "derived_from" }]);
    assert.deepEqual(
      env.db.all("SELECT * FROM object_versions WHERE object_id = ? ORDER BY version_no", obj.object_id).map((x) => ({ ...x })),
      before_source,
      "the source topic is not changed",
    );
    assert.equal(table_counts(env.db).followup_versions, 0n, "the topic branch creates no follow-up");

    // only a topic can be a source; a missing version is not_found
    const chapter = (await create_object(env.service, env.ctx("c-o"), { kind: "artifact", edition_id: env.p.edition_id })).result as { object_id: string };
    const cv = (await add_artifact(env.service, env.ctx("c-v"), { object_id: chapter.object_id, artifact_kind: "chapter", title: "합성 장", summary: "x" })).result as { version_id: string };
    const sig = state_signature(env.db);
    await rejects_api(carry_over(env.service, env.ctx("carry-bad"), { kind: "topic", source_version_id: cv.version_id, stage_id: s.research, title: "x" }), "conflict");
    await rejects_api(carry_over(env.service, env.ctx("carry-miss"), { kind: "topic", source_version_id: "no-such", stage_id: s.research, title: "x" }), "not_found");
    await rejects_api(carry_over(env.service, env.ctx("carry-kind"), { kind: "edition", source_version_id: v1.version_id }), "invalid_payload");
    assert.equal(state_signature(env.db), sig);
  });
});

// ---------------------------------------------------------------------------
// 6. snapshot / manifest point at exact versions

test("a snapshot keeps pointing at the exact versions even after newer versions appear", async () => {
  await with_env(async (env) => {
    const a = await make_content(env, "a");
    const b = await make_content(env, "b");
    const first: VersionRef[] = [
      { object_id: a.object_id, version_id: a.version_id },
      { object_id: b.object_id, version_id: b.version_id },
    ];
    const last_before = last_event_seq(env);
    const m1 = await manifest_blob(env, first, "snap-1");
    const out1 = await snapshot(env.service, env.ctx("snap-1"), { scope: "edition", manifest_blob_id: m1, versions: first });
    const r1 = out1.result as { snapshot_id: string; scope: string; versions: VersionRef[]; content_hash: string };
    assert.equal(r1.scope, "edition");
    assert.deepEqual(r1.versions, first);

    const row = () => ({ ...env.db.get<Record<string, unknown>>("SELECT * FROM snapshots WHERE id = ?", r1.snapshot_id)! });
    const snap_row = row();
    assert.equal(snap_row.scope, "edition");
    assert.equal(snap_row.stage_id, null);
    assert.equal(snap_row.round_id, null);
    assert.equal(snap_row.edition_id, env.p.edition_id);
    assert.equal(snap_row.manifest_blob_id, m1);
    assert.equal(snap_row.content_hash, r1.content_hash);
    assert.ok((snap_row.through_event_seq as bigint) >= last_before);
    assert.ok((snap_row.through_event_seq as bigint) <= last_event_seq(env));
    const receipt = receipt_of(env.db, env.p.project_id, "snap-1")!;
    assert.equal(receipt.action, "edition.snapshotted");
    const ev = events_of(env.db, receipt.id);
    assert.deepEqual(ev.map((e) => e.type), ["edition.snapshotted"]);
    assert.deepEqual((JSON.parse(ev[0]!.payload) as { versions: VersionRef[] }).versions, first);

    // newer version of a: the old snapshot is not rewritten
    const a2 = (await append_version(env.service, env.ctx("a-v2"), { object_id: a.object_id, title: "합성 제목 a2" })).result as { version_id: string };
    assert.notEqual(a2.version_id, a.version_id);
    assert.deepEqual(row(), snap_row, "the snapshot row did not change");

    const second: VersionRef[] = [{ object_id: a.object_id, version_id: a2.version_id }, first[1]!];
    const m2 = await manifest_blob(env, second, "snap-2");
    const r2 = (await snapshot(env.service, env.ctx("snap-2"), { scope: "edition", manifest_blob_id: m2, versions: second })).result as {
      snapshot_id: string; versions: VersionRef[]; content_hash: string;
    };
    assert.notEqual(r2.snapshot_id, r1.snapshot_id);
    assert.notEqual(r2.content_hash, r1.content_hash, "another version -> another hash");
    assert.deepEqual(r2.versions, second);
    assert.deepEqual(row(), snap_row);

    // the same exact list again gives the same hash
    const m3 = await manifest_blob(env, first, "snap-3");
    const r3 = (await snapshot(env.service, env.ctx("snap-3"), { scope: "edition", manifest_blob_id: m3, versions: first })).result as { content_hash: string };
    assert.equal(r3.content_hash, r1.content_hash);
  });
});

test("a stage snapshot needs a stage; a pair that does not match or a missing blob is refused and writes nothing", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const a = await make_content(env, "a");
    const b = await make_content(env, "b");
    const good: VersionRef[] = [{ object_id: a.object_id, version_id: a.version_id }];
    const m = await manifest_blob(env, good, "m");

    const out = await snapshot(env.service, env.ctx("stage-snap"), { scope: "stage", stage_id: s.research, manifest_blob_id: m, versions: good });
    const row = env.db.get<{ scope: string; stage_id: string | null; round_id: string | null }>(
      "SELECT scope, stage_id, round_id FROM snapshots WHERE id = ?",
      (out.result as { snapshot_id: string }).snapshot_id,
    )!;
    assert.deepEqual({ ...row }, { scope: "stage", stage_id: s.research, round_id: null });

    const before = state_signature(env.db);
    await rejects_api(snapshot(env.service, env.ctx("no-stage"), { scope: "stage", manifest_blob_id: m, versions: good }), "invalid_payload");
    await rejects_api(snapshot(env.service, env.ctx("bad-scope"), { scope: "galaxy", manifest_blob_id: m, versions: good }), "invalid_payload");
    await rejects_api(snapshot(env.service, env.ctx("no-blob"), { scope: "edition", manifest_blob_id: "no-such-blob", versions: good }), "not_found");
    await rejects_api(
      snapshot(env.service, env.ctx("bad-pair"), { scope: "edition", manifest_blob_id: m, versions: [{ object_id: a.object_id, version_id: b.version_id }] }),
      "conflict",
      "not_found",
    );
    assert.equal(state_signature(env.db), before);
  });
});

test("a blob that is not ready (still staging) cannot be a manifest", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const round = await start(env, s.plan, "plan-start");
    const a = await make_content(env, "a");
    const versions = [{ object_id: a.object_id, version_id: a.version_id }];
    const { reserve_upload } = await import("../scripts/pes_core/files.ts");
    const bytes = new TextEncoder().encode("합성 미완성 manifest");
    const { sha256_hex } = await import("../scripts/pes_core/files.ts");
    const staged = (
      await reserve_upload(env.service, env.ctx("staged"), { sha256: sha256_hex(bytes), size: bytes.byteLength, media_type: "application/json", original_name: "m.json" })
    ).result as { blob_id: string; state: string };
    assert.equal(staged.state, "staging");
    const before = state_signature(env.db);
    await rejects_api(seal_round(env.service, env.ctx("seal-staging"), { round_id: round.round_id, manifest_blob_id: staged.blob_id, versions }), "conflict", "invalid_payload");
    assert.equal(state_signature(env.db), before);
    assert.equal(round_row(env.db, round.round_id).state, "open");
  });
});

// ---------------------------------------------------------------------------
// 7. PR4 rules for the new commands: policy first, replay, rollback, receipt + events in one tx

test("policy is checked before anything else and a denied command writes nothing", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const round = await start(env, s.plan, "plan-start");
    const content = await make_content(env, "c1");
    const versions = [{ object_id: content.object_id, version_id: content.version_id }];
    const manifest_blob_id = await manifest_blob(env, versions, "m1");
    const sealed = (await seal_round(env.service, env.ctx("seal-1"), { round_id: round.round_id, manifest_blob_id, versions })).result as SealResult;
    await approve(env, s.plan, sealed.snapshot_id, "approve-1");

    env.policy.allowed = false;
    const before = state_signature(env.db);
    const calls = [
      () => create_edition(env.service, env.ctx("p-ed"), {}),
      () => start_round(env.service, env.ctx("p-start"), { stage_id: s.research }),
      () => seal_round(env.service, env.ctx("p-seal"), { round_id: round.round_id, manifest_blob_id, versions }),
      () => approve_stage(env.service, env.ctx("p-approve"), { stage_id: s.plan, snapshot_id: sealed.snapshot_id }),
      () => reopen_stage(env.service, env.ctx("p-reopen"), { stage_id: s.plan }),
      () => release_completion(env.service, env.ctx("p-release"), { edition_id: env.p.edition_id }),
      () => carry_over(env.service, env.ctx("p-carry"), { kind: "tasks", from_stage_id: s.plan, to_stage_id: s.research }),
      () => snapshot(env.service, env.ctx("p-snap"), { scope: "edition", manifest_blob_id, versions }),
    ];
    for (const call of calls) await rejects_api(call(), "policy_denied");
    assert.equal(state_signature(env.db), before);

    // a reply stored while policy was ON is not replayed while policy is OFF
    await rejects_api(start_round(env.service, env.ctx("plan-start"), { stage_id: s.plan }), "policy_denied");
    env.policy.allowed = true;
  });
});

test("the same key and request replays the stored result and writes nothing; the same key with another request is refused", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const first = await start_round(env.service, env.ctx("k-start"), { stage_id: s.plan });
    const rounds = table_counts(env.db).rounds;
    const events = table_counts(env.db).events;
    const again = await start_round(env.service, env.ctx("k-start"), { stage_id: s.plan });
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, first.result);
    assert.equal(table_counts(env.db).rounds, rounds);
    assert.equal(table_counts(env.db).events, events);
    await rejects_api(start_round(env.service, env.ctx("k-start"), { stage_id: s.research }), "idempotency_key_reuse");

    // seal / approve / reopen / snapshot / carry_over / release replay the same way
    const round_id = (first.result as { round_id: string }).round_id;
    const content = await make_content(env, "c1");
    const versions = [{ object_id: content.object_id, version_id: content.version_id }];
    const manifest_blob_id = await manifest_blob(env, versions, "m1");
    const seal1 = await seal_round(env.service, env.ctx("k-seal"), { round_id, manifest_blob_id, versions });
    const seal2 = await seal_round(env.service, env.ctx("k-seal"), { round_id, manifest_blob_id, versions });
    assert.equal(seal2.replayed, true);
    assert.deepEqual(seal2.result, seal1.result);
    const snapshot_id = (seal1.result as SealResult).snapshot_id;
    const ap1 = await approve_stage(env.service, env.ctx("k-approve"), { stage_id: s.plan, snapshot_id });
    const ap2 = await approve_stage(env.service, env.ctx("k-approve"), { stage_id: s.plan, snapshot_id });
    assert.equal(ap2.replayed, true);
    assert.deepEqual(ap2.result, ap1.result);
    assert.equal(approvals_of(env.db, s.plan).length, 1);
    const ro1 = await reopen_stage(env.service, env.ctx("k-reopen"), { stage_id: s.plan });
    const ro2 = await reopen_stage(env.service, env.ctx("k-reopen"), { stage_id: s.plan });
    assert.equal(ro2.replayed, true);
    assert.deepEqual(ro2.result, ro1.result);
    assert.equal(stage_row(env.db, s.plan).status, "active");
    const sn1 = await snapshot(env.service, env.ctx("k-snap"), { scope: "edition", manifest_blob_id, versions });
    const sn_count = table_counts(env.db).snapshots;
    const sn2 = await snapshot(env.service, env.ctx("k-snap"), { scope: "edition", manifest_blob_id, versions });
    assert.equal(sn2.replayed, true);
    assert.deepEqual(sn2.result, sn1.result);
    assert.equal(table_counts(env.db).snapshots, sn_count);
  });
});

test("an event or receipt failure rolls the whole command back and the same key can run again", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const round = await start(env, s.plan, "plan-start");
    const content = await make_content(env, "c1");
    const versions = [{ object_id: content.object_id, version_id: content.version_id }];
    const manifest_blob_id = await manifest_blob(env, versions, "m1");

    // seal: fails at the events insert -> no snapshot, no round_contents, round still open
    const before_seal = state_signature(env.db);
    const fail_events = wrap_db(env.db, (sql) => {
      if (/INSERT INTO events/i.test(sql)) throw new Error("injected failure");
    });
    await assert.rejects(seal_round(env.with_db(fail_events), env.ctx("seal-1"), { round_id: round.round_id, manifest_blob_id, versions }));
    assert.equal(state_signature(env.db), before_seal);
    assert.equal(round_row(env.db, round.round_id).state, "open");
    const sealed = (await seal_round(env.service, env.ctx("seal-1"), { round_id: round.round_id, manifest_blob_id, versions })).result as SealResult;

    // approve: fails at the receipt insert -> still unapproved, next stage still pending
    const before_approve = state_signature(env.db);
    const fail_receipt = wrap_db(env.db, (sql) => {
      if (/INSERT INTO mutation_commits/i.test(sql)) throw new Error("injected failure");
    });
    await assert.rejects(approve_stage(env.with_db(fail_receipt), env.ctx("approve-1"), { stage_id: s.plan, snapshot_id: sealed.snapshot_id }));
    assert.equal(state_signature(env.db), before_approve);
    assert.equal(stage_row(env.db, s.plan).status, "active");
    assert.equal(stage_row(env.db, s.research).status, "pending");
    assert.equal(table_counts(env.db).approvals, 0n);
    const ok = await approve_stage(env.service, env.ctx("approve-1"), { stage_id: s.plan, snapshot_id: sealed.snapshot_id });
    assert.equal(ok.replayed, false);

    // reopen: fails after the stage update (events insert) -> approval and pointers unchanged
    const before_reopen = state_signature(env.db);
    await assert.rejects(reopen_stage(env.with_db(fail_events), env.ctx("reopen-1"), { stage_id: s.plan }));
    assert.equal(state_signature(env.db), before_reopen);
    assert.equal(stage_row(env.db, s.plan).status, "approved");
  });
});

test("every successful command leaves its receipt and its events in one transaction", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const r = await drive_stage(env, s.plan, "plan");
    await reopen_stage(env.service, env.ctx("reopen-1"), { stage_id: s.plan });
    await carry_over(env.service, env.ctx("carry-1"), { kind: "tasks", from_stage_id: s.plan, to_stage_id: s.research });
    const m = await manifest_blob(env, r.versions, "snap");
    await snapshot(env.service, env.ctx("snap-1"), { scope: "edition", manifest_blob_id: m, versions: r.versions });
    await create_edition(env.service, env.ctx("ed-1"), {});

    for (const [key, action] of [
      ["plan-start", "round.started"],
      ["plan-seal", "round.sealed"],
      ["plan-approve", "stage.approved"],
      ["reopen-1", "stage.reopened"],
      ["carry-1", "edition.carried_over"],
      ["snap-1", "edition.snapshotted"],
      ["ed-1", "edition.created"],
    ] as const) {
      const receipt = receipt_of(env.db, env.p.project_id, key);
      assert.ok(receipt, `${key} has a receipt`);
      assert.equal(receipt.action, action);
      const events = events_of(env.db, receipt.id);
      assert.ok(events.length >= 1, `${key} has an event in the same tx`);
      assert.equal(events[0]!.type, action);
    }
    // an event carries the tx_size of its own transaction
    const approve_receipt = receipt_of(env.db, env.p.project_id, "plan-approve")!;
    const sizes = env.db.all<{ tx_size: bigint }>("SELECT tx_size FROM events WHERE tx_id = ?", approve_receipt.id);
    for (const row of sizes) assert.equal(row.tx_size, BigInt(sizes.length));
  });
});

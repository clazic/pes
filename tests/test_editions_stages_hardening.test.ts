// SEL-39 (stage 2 PR6) hardening: tests that try to break the edition / stage / round commands.
// Interface and semantics: see the comment at the top of tests/test_editions_stages.test.ts.
// Everything is synthetic (FakeClock, temporary HOME). db.get() rows are null-prototype: compare { ...row }.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { MutationContext } from "../scripts/pes_core/commands.ts";
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
import { release } from "../scripts/pes_core/runs.ts";
import { second_project } from "./helpers/blob_env.ts";
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
  rejects_any,
  round_row,
  seal,
  stage_ids,
  stage_row,
  start,
  with_env,
  wrap_db,
  type Env,
  type SealResult,
  type VersionRef,
} from "./helpers/editions_env.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

function ids(env: Env) {
  return stage_ids(env.db, env.p.edition_id);
}

function defer_pragma(env: Env): bigint {
  const row = env.db.get<{ defer_foreign_keys: bigint }>("PRAGMA defer_foreign_keys")!;
  return row.defer_foreign_keys;
}

function fk_pragma(env: Env): bigint {
  return env.db.get<{ foreign_keys: bigint }>("PRAGMA foreign_keys")!.foreign_keys;
}

async function drive_all(env: Env) {
  const s = ids(env);
  for (const key of STAGE_KEYS) await drive_stage(env, s[key], key);
}

function ref(c: { object_id: string; version_id: string }): VersionRef {
  return { object_id: c.object_id, version_id: c.version_id };
}

/** A second human who is a plain editor of the project (not the owner). */
function add_editor(env: Env): MutationContext {
  env.db.run("INSERT INTO users (id, display_name) VALUES ('user-editor', '합성 편집자')");
  env.db.run("INSERT INTO actors (id, kind, user_id, display_name) VALUES ('actor-editor', 'human', 'user-editor', '합성 편집자')");
  env.db.run("INSERT INTO project_members (project_id, user_id, role) VALUES (?, 'user-editor', 'editor')", env.p.project_id);
  return { project_id: env.p.project_id, actor_id: "actor-editor", via: "cli", client_request_id: "unset" };
}

// ---------------------------------------------------------------------------
// 1. PRAGMA defer_foreign_keys in stage.reopen must not leak

test("after a successful reopen the connection checks foreign keys immediately again", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    await drive_stage(env, s.plan, "plan");
    await drive_stage(env, s.research, "research");
    assert.equal(defer_pragma(env), 0n);
    await reopen_stage(env.service, env.ctx("reopen-1"), { stage_id: s.plan });
    assert.equal(defer_pragma(env), 0n, "the deferral ended with the transaction");
    assert.equal(fk_pragma(env), 1n);
    const before = state_signature(env.db);
    assert.throws(() => env.db.run("UPDATE stages SET approved_snapshot_id = 'no-such-snapshot' WHERE id = ?", s.analyze));
    assert.equal(state_signature(env.db), before, "a direct FK violation is refused on the spot");
  });
});

test("a rolled-back reopen leaves no deferral behind and the next commands still check foreign keys", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    await drive_stage(env, s.plan, "plan");
    const before = state_signature(env.db);
    const fail_events = wrap_db(env.db, (sql) => {
      if (/INSERT INTO events/i.test(sql)) throw new Error("injected failure");
    });
    await assert.rejects(reopen_stage(env.with_db(fail_events), env.ctx("reopen-1"), { stage_id: s.plan }));
    assert.equal(state_signature(env.db), before);
    assert.equal(defer_pragma(env), 0n, "defer_foreign_keys did not survive the rollback");
    assert.throws(() => env.db.run("UPDATE stages SET approved_snapshot_id = 'no-such-snapshot' WHERE id = ?", s.research));
    // the same connection runs other commands normally
    const r = await start(env, s.research, "research-start");
    assert.equal(round_row(env.db, r.round_id).state, "open");
    assert.equal(defer_pragma(env), 0n);
  });
});

test("a reopen rejected before its writes (conflict) leaves the pragma untouched", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    await rejects_api(reopen_stage(env.service, env.ctx("reopen-early"), { stage_id: s.plan }), "conflict");
    assert.equal(defer_pragma(env), 0n);
  });
});

test("a reopen whose event never gets written cannot commit a dangling stale_since_event_seq", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    await drive_stage(env, s.plan, "plan");
    await drive_stage(env, s.research, "research");
    const before = state_signature(env.db);
    // the events insert is swallowed: the later stage's stale pointer would reference a missing event
    const drop_events = wrap_db(env.db, (sql) => {
      if (/INSERT INTO events/i.test(sql)) return { changes: 0n, last_insert_rowid: 0n };
    });
    await rejects_any(reopen_stage(env.with_db(drop_events), env.ctx("reopen-drop"), { stage_id: s.plan }));
    assert.equal(state_signature(env.db), before, "the foreign-key violation was not committed");
    assert.equal(defer_pragma(env), 0n);
    assert.equal(stage_row(env.db, s.research).stale_since_event_seq, null);
    assert.equal(stage_row(env.db, s.plan).status, "approved");
    const ok = await reopen_stage(env.service, env.ctx("reopen-drop"), { stage_id: s.plan });
    assert.equal(ok.replayed, false);
  });
});

test("a failure in the middle of reopen's run invalidation rolls back stages, editions and runs", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    await drive_stage(env, s.plan, "plan");
    const research = await drive_stage(env, s.research, "research");
    insert_run(env, "run-q1", "queued", s.research, research.round.round_id, research.sealed.snapshot_id);
    insert_run(env, "run-q2", "waiting_human", s.analyze, null, research.sealed.snapshot_id);
    const before = state_signature(env.db);
    let cancels = 0;
    const wrapped = wrap_db(env.db, (sql) => {
      if (/UPDATE runs/i.test(sql)) {
        cancels += 1;
        if (cancels === 2) throw new Error("injected failure");
      }
    });
    await assert.rejects(reopen_stage(env.with_db(wrapped), env.ctx("reopen-mid"), { stage_id: s.plan }));
    assert.equal(state_signature(env.db), before);
    assert.equal(defer_pragma(env), 0n);
    const run = env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = 'run-q1'")!;
    assert.equal(run.status, "queued");
    assert.equal(stage_row(env.db, s.plan).status, "approved");
    assert.equal(edition_row(env.db, env.p.edition_id).current_stage_id, s.analyze);
  });
});

test("other commands that fail halfway never commit a foreign-key violation", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const r = await start(env, s.plan, "plan-start");
    const c = await make_content(env, "c1");
    const m = await manifest_blob(env, [ref(c)], "m1");
    const before = state_signature(env.db);
    // round_contents insert fails after the snapshot row exists
    const wrapped = wrap_db(env.db, (sql) => {
      if (/INSERT INTO round_contents/i.test(sql)) throw new Error("injected failure");
    });
    await assert.rejects(seal_round(env.with_db(wrapped), env.ctx("seal-x"), { round_id: r.round_id, manifest_blob_id: m, versions: [ref(c)] }));
    assert.equal(state_signature(env.db), before);
    assert.equal(table_counts(env.db).snapshots, 0n);
    assert.equal(defer_pragma(env), 0n);
  });
});

// ---------------------------------------------------------------------------
// 2. Order and state violations

test("approving an unsealed round, re-approving, and approving with a snapshot of another round are refused", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const r = await start(env, s.plan, "plan-start");
    const sig0 = state_signature(env.db);
    await rejects_api(approve_stage(env.service, env.ctx("a-nosnap"), { stage_id: s.plan, snapshot_id: "no-such" }), "conflict", "not_found");
    assert.equal(state_signature(env.db), sig0);

    const c = await make_content(env, "c1");
    const sealed = (await seal(env, r.round_id, [ref(c)], "seal-1")).result as SealResult;
    // a snapshot of a different stage cannot approve the plan stage
    const approved = await approve(env, s.plan, sealed.snapshot_id, "a-ok");
    assert.equal(approved.snapshot_id, sealed.snapshot_id);
    const sig1 = state_signature(env.db);
    await rejects_api(approve_stage(env.service, env.ctx("a-again"), { stage_id: s.plan, snapshot_id: sealed.snapshot_id }), "conflict");
    assert.equal(state_signature(env.db), sig1);
    assert.equal(approvals_of(env.db, s.plan).length, 1);

    // research round open: its stage cannot be approved with the plan's snapshot
    const r2 = await start(env, s.research, "research-start");
    assert.ok(r2.round_id);
    await rejects_api(approve_stage(env.service, env.ctx("a-wrong"), { stage_id: s.research, snapshot_id: sealed.snapshot_id }), "conflict");
    assert.equal(approvals_of(env.db, s.research).length, 0);
  });
});

test("a later stage cannot start while an earlier stage is unapproved, even if it is 'asking'", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    await drive_stage(env, s.plan, "plan");
    assert.equal(stage_row(env.db, s.research).status, "asking");
    const before = state_signature(env.db);
    await rejects_api(start_round(env.service, env.ctx("skip-1"), { stage_id: s.analyze }), "conflict");
    await rejects_api(start_round(env.service, env.ctx("skip-2"), { stage_id: s.publish }), "conflict");
    assert.equal(state_signature(env.db), before);
    // while research has an open round, analyze still cannot start
    await start(env, s.research, "research-start");
    await rejects_api(start_round(env.service, env.ctx("skip-3"), { stage_id: s.analyze }), "conflict");
  });
});

test("reopen twice in a row, reopen of a never-approved stage and reopen of a pending stage are conflicts", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    await drive_stage(env, s.plan, "plan");
    await reopen_stage(env.service, env.ctx("reopen-1"), { stage_id: s.plan });
    const after_first = state_signature(env.db);
    await rejects_api(reopen_stage(env.service, env.ctx("reopen-2"), { stage_id: s.plan }), "conflict");
    await rejects_api(reopen_stage(env.service, env.ctx("reopen-asking"), { stage_id: s.research }), "conflict");
    await rejects_api(reopen_stage(env.service, env.ctx("reopen-pending"), { stage_id: s.publish }), "conflict");
    await rejects_api(reopen_stage(env.service, env.ctx("reopen-missing"), { stage_id: "no-such" }), "not_found");
    assert.equal(state_signature(env.db), after_first);
  });
});

test("a completed edition accepts no new round, no second seal and no second approval", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    await drive_all(env);
    assert.equal(edition_row(env.db, env.p.edition_id).status, "completed");
    const before = state_signature(env.db);
    for (const key of STAGE_KEYS) {
      await rejects_api(start_round(env.service, env.ctx(`done-start-${key}`), { stage_id: s[key] }), "conflict");
    }
    const round_id = env.db.get<{ id: string }>("SELECT id FROM rounds WHERE stage_id = ?", s.publish)!.id;
    const c = await make_content(env, "late");
    const m = await manifest_blob(env, [ref(c)], "late-m");
    await rejects_api(seal_round(env.service, env.ctx("done-seal"), { round_id, manifest_blob_id: m, versions: [ref(c)] }), "conflict");
    const snap = env.db.get<{ approved_snapshot_id: string }>("SELECT approved_snapshot_id FROM stages WHERE id = ?", s.publish)!.approved_snapshot_id;
    await rejects_api(approve_stage(env.service, env.ctx("done-approve"), { stage_id: s.publish, snapshot_id: snap }), "conflict");
    // the late content and its manifest blob are fixtures; only business rows must be unchanged
    assert.equal(table_counts(env.db).approvals, 6n);
    assert.equal(table_counts(env.db).rounds, 6n);
    assert.equal(table_counts(env.db).snapshots, 6n);
    assert.ok(before.length > 0);
    assert.equal(edition_row(env.db, env.p.edition_id).status, "completed");
  });
});

test("ids of another project or of another edition are not usable", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const other = await second_project(env);
    const other_ctx = (key: string): MutationContext => ({ project_id: other.project_id, actor_id: other.actor_id, via: "cli", client_request_id: key });
    const other_stages = stage_ids(env.db, other.edition_id);

    const r = await start(env, s.plan, "plan-start");
    const c = await make_content(env, "c1");
    const m = await manifest_blob(env, [ref(c)], "m1");
    const sealed = (await seal_round(env.service, env.ctx("seal-1"), { round_id: r.round_id, manifest_blob_id: m, versions: [ref(c)] })).result as SealResult;
    const before = state_signature(env.db);

    // project B's owner names project A's ids
    await rejects_api(start_round(env.service, other_ctx("x-start"), { stage_id: s.plan }), "not_found");
    await rejects_api(seal_round(env.service, other_ctx("x-seal"), { round_id: r.round_id, manifest_blob_id: m, versions: [ref(c)] }), "not_found");
    await rejects_api(approve_stage(env.service, other_ctx("x-approve"), { stage_id: s.plan, snapshot_id: sealed.snapshot_id }), "not_found");
    await rejects_api(reopen_stage(env.service, other_ctx("x-reopen"), { stage_id: s.plan }), "not_found");
    await rejects_api(release_completion(env.service, other_ctx("x-release"), { edition_id: env.p.edition_id }), "not_found");
    await rejects_api(carry_over(env.service, other_ctx("x-carry"), { kind: "tasks", from_stage_id: s.plan, to_stage_id: s.research }), "not_found");
    await rejects_api(snapshot(env.service, other_ctx("x-snap"), { scope: "stage", stage_id: s.plan, manifest_blob_id: m, versions: [ref(c)] }), "not_found", "conflict");
    await rejects_api(create_edition(env.service, other_ctx("x-ed"), { parent_edition_id: env.p.edition_id }), "not_found", "conflict");
    assert.equal(state_signature(env.db), before);

    // project A names project B's stage / a project-B snapshot
    await rejects_api(start_round(env.service, env.ctx("y-start"), { stage_id: other_stages.plan }), "not_found");
    const rb = (await start_round(env.service, other_ctx("b-start"), { stage_id: other_stages.plan })).result as { round_id: string };
    await rejects_api(approve_stage(env.service, env.ctx("y-approve"), { stage_id: other_stages.plan, snapshot_id: sealed.snapshot_id }), "not_found");
    await rejects_api(seal_round(env.service, env.ctx("y-seal"), { round_id: rb.round_id, manifest_blob_id: m, versions: [ref(c)] }), "not_found");
    // sealing project B's round with project A's versions and blob is refused too
    await rejects_api(seal_round(env.service, other_ctx("b-seal"), { round_id: rb.round_id, manifest_blob_id: m, versions: [ref(c)] }), "not_found", "conflict");
    assert.equal(round_row(env.db, rb.round_id).state, "open");
  });
});

test("a draft edition's stages cannot start, and a stage of an older edition is not the active one", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const ed2 = (await create_edition(env.service, env.ctx("ed-2"), { parent_edition_id: env.p.edition_id })).result as { stage_ids: Record<string, string> };
    const before = state_signature(env.db);
    await rejects_api(start_round(env.service, env.ctx("d-start"), { stage_id: ed2.stage_ids.plan! }), "conflict");
    await rejects_api(approve_stage(env.service, env.ctx("d-approve"), { stage_id: ed2.stage_ids.plan!, snapshot_id: "x" }), "conflict", "not_found");
    await rejects_api(reopen_stage(env.service, env.ctx("d-reopen"), { stage_id: ed2.stage_ids.plan! }), "conflict");
    assert.equal(state_signature(env.db), before);
    // the active edition is unaffected
    assert.ok((await start(env, s.plan, "plan-start")).round_id);
  });
});

test("seal refuses duplicates, wrong object/version pairs and a manifest blob of nothing", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const r = await start(env, s.plan, "plan-start");
    const a = await make_content(env, "a");
    const b = await make_content(env, "b");
    const m = await manifest_blob(env, [ref(a)], "m1");
    const before = state_signature(env.db);
    await rejects_api(
      seal_round(env.service, env.ctx("s-swap"), { round_id: r.round_id, manifest_blob_id: m, versions: [{ object_id: a.object_id, version_id: b.version_id }] }),
      "not_found",
      "conflict",
    );
    await rejects_api(
      seal_round(env.service, env.ctx("s-blob"), { round_id: r.round_id, manifest_blob_id: "no-such-blob", versions: [ref(a)] }),
      "not_found",
      "conflict",
    );
    await rejects_api(
      seal_round(env.service, env.ctx("s-unknown"), { round_id: r.round_id, manifest_blob_id: m, versions: [ref(a)], extra: 1 }),
      "invalid_payload",
    );
    await rejects_api(
      seal_round(env.service, env.ctx("s-notlist"), { round_id: r.round_id, manifest_blob_id: m, versions: "nope" }),
      "invalid_payload",
    );
    await rejects_api(
      seal_round(env.service, env.ctx("s-missing-id"), { manifest_blob_id: m, versions: [ref(a)] }),
      "invalid_payload",
    );
    assert.equal(state_signature(env.db), before);
    assert.equal(round_row(env.db, r.round_id).state, "open");
  });
});

// ---------------------------------------------------------------------------
// 3. Permissions

test("an expired lease, a released lease and a guard mixed from another run cannot seal or snapshot", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const base = add_agent(env);
    const r = await start(env, s.plan, "plan-start");
    const c = await make_content(env, "a");
    const versions = [ref(c)];
    const m = await manifest_blob(env, versions, "m1");

    const lease = await agent_claim(env, base, "claim-1");
    const guard = { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence };
    const before = state_signature(env.db);

    // another run's id with this lease
    await rejects_api(
      seal_round(env.service, agent_ctx(base, "mix-1"), { round_id: r.round_id, manifest_blob_id: m, versions, ...guard, run_id: "some-other-run" }),
      "conflict",
      "forbidden",
      "not_found",
    );
    await rejects_api(
      seal_round(env.service, agent_ctx(base, "mix-2"), { round_id: r.round_id, manifest_blob_id: m, versions, ...guard, lease_id: "some-other-lease" }),
      "conflict",
      "forbidden",
      "not_found",
    );
    await rejects_api(
      snapshot(env.service, agent_ctx(base, "mix-3"), { scope: "edition", manifest_blob_id: m, versions, ...guard, fence: lease.fence + 1 }),
      "conflict",
    );
    await rejects_api(snapshot(env.service, agent_ctx(base, "mix-4"), { scope: "edition", manifest_blob_id: m, versions }), "forbidden");
    assert.equal(state_signature(env.db), before);

    // the lease expires with time
    env.clock.advance(10 * 60 * 1000);
    await rejects_api(seal_round(env.service, agent_ctx(base, "exp-1"), { round_id: r.round_id, manifest_blob_id: m, versions, ...guard }), "conflict", "forbidden");
    await rejects_api(snapshot(env.service, agent_ctx(base, "exp-2"), { scope: "edition", manifest_blob_id: m, versions, ...guard }), "conflict", "forbidden");
    assert.equal(round_row(env.db, r.round_id).state, "open");
    assert.equal(table_counts(env.db).snapshots, 0n);

    // a fresh lease works; once released, its guard is dead again
    const lease2 = await agent_claim(env, base, "claim-2");
    const guard2 = { run_id: lease2.run_id, lease_id: lease2.lease_id, fence: lease2.fence };
    await release(env.service, agent_ctx(base, "release-2"), guard2);
    await rejects_api(snapshot(env.service, agent_ctx(base, "rel-1"), { scope: "edition", manifest_blob_id: m, versions, ...guard2 }), "conflict", "forbidden");
    await rejects_api(seal_round(env.service, agent_ctx(base, "rel-2"), { round_id: r.round_id, manifest_blob_id: m, versions, ...guard2 }), "conflict", "forbidden");
    assert.equal(table_counts(env.db).snapshots, 0n);

    // the old fence of the first lease stays dead after a new claim
    const lease3 = await agent_claim(env, base, "claim-3");
    assert.ok(lease3.fence > lease.fence);
    await rejects_api(seal_round(env.service, agent_ctx(base, "old-fence"), { round_id: r.round_id, manifest_blob_id: m, versions, ...guard }), "conflict", "forbidden");
    const ok = await snapshot(env.service, agent_ctx(base, "new-fence"), {
      scope: "edition", manifest_blob_id: m, versions, run_id: lease3.run_id, lease_id: lease3.lease_id, fence: lease3.fence,
    });
    assert.equal(ok.replayed, false);
  });
});

test("an agent cannot carry over, and an agent guard does not turn it into an owner", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const base = add_agent(env);
    insert_followup(env, "f1", s.plan, "accepted", "합성");
    const lease = await agent_claim(env, base, "claim-1");
    const guard = { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence };
    const before = state_signature(env.db);
    await rejects_api(carry_over(env.service, agent_ctx(base, "ag-carry"), { kind: "tasks", from_stage_id: s.plan, to_stage_id: s.research }), "forbidden");
    await rejects_api(carry_over(env.service, agent_ctx(base, "ag-carry-g"), { kind: "tasks", from_stage_id: s.plan, to_stage_id: s.research, ...guard }), "forbidden", "invalid_payload");
    assert.equal(state_signature(env.db), before);
  });
});

test("a plain editor may start and seal but never approve, reopen, release, carry over or create an edition", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const editor = add_editor(env);
    const ectx = (key: string) => agent_ctx(editor, key);
    const r = (await start_round(env.service, ectx("e-start"), { stage_id: s.plan })).result as { round_id: string };
    const c = await make_content(env, "c1");
    const m = await manifest_blob(env, [ref(c)], "m1");
    const sealed = (await seal_round(env.service, ectx("e-seal"), { round_id: r.round_id, manifest_blob_id: m, versions: [ref(c)] })).result as SealResult;

    const before = state_signature(env.db);
    await rejects_api(approve_stage(env.service, ectx("e-approve"), { stage_id: s.plan, snapshot_id: sealed.snapshot_id }), "forbidden");
    await rejects_api(create_edition(env.service, ectx("e-ed"), {}), "forbidden");
    await rejects_api(carry_over(env.service, ectx("e-carry"), { kind: "tasks", from_stage_id: s.plan, to_stage_id: s.research }), "forbidden");
    await rejects_api(release_completion(env.service, ectx("e-rel"), { edition_id: env.p.edition_id }), "forbidden");
    assert.equal(state_signature(env.db), before);

    await approve(env, s.plan, sealed.snapshot_id, "o-approve");
    const after = state_signature(env.db);
    await rejects_api(reopen_stage(env.service, ectx("e-reopen"), { stage_id: s.plan }), "forbidden");
    assert.equal(state_signature(env.db), after);
  });
});

test("a disabled owner actor or user is refused for approve, reopen, release, create and carry_over", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const r = await start(env, s.plan, "plan-start");
    const c = await make_content(env, "c1");
    const sealed = (await seal(env, r.round_id, [ref(c)], "seal-1")).result as SealResult;
    await approve(env, s.plan, sealed.snapshot_id, "approve-1");
    await drive_stage(env, s.research, "research");

    const owner = env.db.get<{ user_id: string }>("SELECT user_id FROM actors WHERE id = ?", env.p.actor_id)!.user_id;
    for (const mode of ["actor", "user"] as const) {
      if (mode === "actor") env.db.run("UPDATE actors SET disabled_at = 1 WHERE id = ?", env.p.actor_id);
      else env.db.run("UPDATE users SET disabled_at = 1 WHERE id = ?", owner);
      const before = state_signature(env.db);
      await rejects_api(approve_stage(env.service, env.ctx(`dis-ap-${mode}`), { stage_id: s.analyze, snapshot_id: sealed.snapshot_id }), "forbidden");
      await rejects_api(reopen_stage(env.service, env.ctx(`dis-re-${mode}`), { stage_id: s.plan }), "forbidden");
      await rejects_api(release_completion(env.service, env.ctx(`dis-rel-${mode}`), { edition_id: env.p.edition_id }), "forbidden", "conflict");
      await rejects_api(create_edition(env.service, env.ctx(`dis-ed-${mode}`), {}), "forbidden");
      await rejects_api(carry_over(env.service, env.ctx(`dis-ca-${mode}`), { kind: "tasks", from_stage_id: s.plan, to_stage_id: s.research }), "forbidden");
      await rejects_api(start_round(env.service, env.ctx(`dis-st-${mode}`), { stage_id: s.analyze }), "forbidden");
      assert.equal(state_signature(env.db), before);
      if (mode === "actor") env.db.run("UPDATE actors SET disabled_at = NULL WHERE id = ?", env.p.actor_id);
      else env.db.run("UPDATE users SET disabled_at = NULL WHERE id = ?", owner);
    }
  });
});

test("a non-human actor that shares the owner's user cannot approve, reopen, release or carry over, even with a lease", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const base = add_agent(env);
    const r = await start(env, s.plan, "plan-start");
    const c = await make_content(env, "c1");
    const sealed = (await seal(env, r.round_id, [ref(c)], "seal-1")).result as SealResult;
    await approve(env, s.plan, sealed.snapshot_id, "approve-1");
    const lease = await agent_claim(env, base, "claim-1");
    const guard = { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence };
    const before = state_signature(env.db);
    await rejects_api(reopen_stage(env.service, agent_ctx(base, "n-reopen"), { stage_id: s.plan, ...guard }), "forbidden");
    await rejects_api(release_completion(env.service, agent_ctx(base, "n-rel"), { edition_id: env.p.edition_id, ...guard }), "forbidden", "invalid_payload");
    await rejects_api(approve_stage(env.service, agent_ctx(base, "n-ap"), { stage_id: s.research, snapshot_id: sealed.snapshot_id, ...guard }), "forbidden", "invalid_payload");
    assert.equal(state_signature(env.db), before);
    // an internal_ai actor of the same user is not a human either
    env.db.run("INSERT INTO actors (id, kind, user_id, display_name) VALUES ('ai-1', 'internal_ai', (SELECT user_id FROM actors WHERE id = ?), '합성 내부 AI')", env.p.actor_id);
    const ai: MutationContext = { project_id: env.p.project_id, actor_id: "ai-1", via: "cli", client_request_id: "unset" };
    const before_ai = state_signature(env.db);
    await rejects_api(reopen_stage(env.service, agent_ctx(ai, "ai-reopen"), { stage_id: s.plan }), "forbidden");
    await rejects_api(create_edition(env.service, agent_ctx(ai, "ai-ed"), {}), "forbidden");
    assert.equal(state_signature(env.db), before_ai);
  });
});

// ---------------------------------------------------------------------------
// 4. What a reopen touches and what it does not

test("reopen marks only non-pending later stages stale, with the event_seq of its own stage.reopened event", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    await drive_stage(env, s.plan, "plan");
    await drive_stage(env, s.research, "research");
    // analyze is 'asking'; write, verify, publish are pending
    await reopen_stage(env.service, env.ctx("reopen-1"), { stage_id: s.plan });
    const receipt = receipt_of(env.db, env.p.project_id, "reopen-1")!;
    const ev = events_of(env.db, receipt.id).find((e) => e.type === "stage.reopened")!;
    assert.equal(stage_row(env.db, s.research).stale_since_event_seq, ev.event_seq);
    assert.equal(stage_row(env.db, s.analyze).stale_since_event_seq, ev.event_seq);
    for (const key of ["write", "verify", "publish"] as const) {
      assert.equal(stage_row(env.db, s[key]).stale_since_event_seq, null, `${key} is pending, not stale`);
      assert.equal(stage_row(env.db, s[key]).status, "pending");
    }
    assert.equal(stage_row(env.db, s.plan).stale_since_event_seq, null, "the reopened stage itself is not stale");
    assert.equal(stage_row(env.db, s.research).status, "approved", "a stale stage keeps its approved status");
    assert.ok(stage_row(env.db, s.research).approved_snapshot_id, "and its approved snapshot");
    assert.equal(approvals_of(env.db, s.research).length, 1);
    assert.equal(approvals_of(env.db, s.plan).length, 1);
  });
});

test("a stale approved stage cannot start a new round until its predecessor is approved again", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    await drive_stage(env, s.plan, "plan");
    await drive_stage(env, s.research, "research");
    await reopen_stage(env.service, env.ctx("reopen-1"), { stage_id: s.plan });
    const before = state_signature(env.db);
    await rejects_api(start_round(env.service, env.ctx("stale-start"), { stage_id: s.research }), "conflict");
    await rejects_api(start_round(env.service, env.ctx("asking-start"), { stage_id: s.analyze }), "conflict");
    assert.equal(state_signature(env.db), before);

    // plan: new round on top of the old snapshot, re-approved; only then research may start again
    const old_plan_snapshot = env.db.get<{ sealed_snapshot_id: string }>("SELECT sealed_snapshot_id FROM rounds WHERE stage_id = ?", s.plan)!.sealed_snapshot_id;
    const p2 = await start(env, s.plan, "plan2-start");
    assert.equal(round_row(env.db, p2.round_id).base_snapshot_id, old_plan_snapshot);
    assert.equal(p2.round_no, 2);
    const c = await make_content(env, "plan2");
    const sealed2 = (await seal(env, p2.round_id, [ref(c)], "plan2-seal")).result as SealResult;
    await approve(env, s.plan, sealed2.snapshot_id, "plan2-approve");
    assert.equal(approvals_of(env.db, s.plan).length, 2, "the first approval is kept");
    assert.equal(stage_row(env.db, s.research).stale_since_event_seq !== null, true, "research is still stale after plan is re-approved");
    const r2 = await start(env, s.research, "research2-start");
    assert.equal(r2.round_no, 2);
    // the old plan approval still points at the old snapshot
    assert.equal(approvals_of(env.db, s.plan)[0]!.snapshot_id, old_plan_snapshot);
  });
});

test("a second reopen of a different stage keeps the earlier stale marks and the approval history", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    await drive_stage(env, s.plan, "plan");
    await drive_stage(env, s.research, "research");
    await drive_stage(env, s.analyze, "analyze");
    await reopen_stage(env.service, env.ctx("reopen-research"), { stage_id: s.research });
    const analyze_stale = stage_row(env.db, s.analyze).stale_since_event_seq;
    assert.ok(analyze_stale !== null);
    // plan is earlier than research and still approved; reopening it marks research (active) and analyze stale
    await reopen_stage(env.service, env.ctx("reopen-plan"), { stage_id: s.plan });
    assert.equal(edition_row(env.db, env.p.edition_id).current_stage_id, s.plan);
    assert.ok(stage_row(env.db, s.research).stale_since_event_seq !== null);
    assert.ok(stage_row(env.db, s.analyze).stale_since_event_seq! > analyze_stale!, "marked again by the newer reopen");
    assert.equal(approvals_of(env.db, s.plan).length, 1);
    assert.equal(approvals_of(env.db, s.research).length, 1);
    assert.equal(approvals_of(env.db, s.analyze).length, 1);
  });
});

test("run invalidation reaches only later stages of this edition; finished and leased runs keep their record", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const base = add_agent(env);
    const plan = await drive_stage(env, s.plan, "plan");
    const research = await drive_stage(env, s.research, "research");

    insert_run(env, "run-earlier-queued", "queued", s.plan, plan.round.round_id, null);
    insert_run(env, "run-same-queued", "queued", s.plan, plan.round.round_id, plan.sealed.snapshot_id);
    insert_run(env, "run-later-interrupted", "interrupted", s.research, research.round.round_id, null);
    insert_run(env, "run-later-succeeded", "succeeded", s.research, research.round.round_id, null);
    insert_run(env, "run-later-failed", "failed", s.analyze, null, null);
    insert_run(env, "run-later-blocked", "queued", s.analyze, null, null);
    env.db.run("UPDATE runs SET status = 'blocked_usage', go_block_reason = 'usage_limit', go_blocked_at = 1 WHERE id = 'run-later-blocked'");
    // a running run that holds the lease
    const lease = await agent_claim(env, base, "claim-1");
    aim_run(env, lease.run_id, s.research, research.round.round_id, null);
    // a run of another edition
    const ed2 = (await create_edition(env.service, env.ctx("ed-2"), {})).result as { stage_ids: Record<string, string> };
    insert_run(env, "run-other-edition", "queued", ed2.stage_ids.research!, null, null);

    const succeeded_before = { ...env.db.get("SELECT * FROM runs WHERE id = 'run-later-succeeded'")! };
    const failed_before = { ...env.db.get("SELECT * FROM runs WHERE id = 'run-later-failed'")! };
    const lease_run_before = { ...env.db.get("SELECT * FROM runs WHERE id = ?", lease.run_id)! };

    const out = await reopen_stage(env.service, env.ctx("reopen-plan"), { stage_id: s.plan });
    const r = out.result as { cancelled_run_ids: string[] };
    assert.deepEqual([...r.cancelled_run_ids].sort(), ["run-later-blocked", "run-later-interrupted"]);
    const status = (id: string) => env.db.get<{ status: string; ended_at: bigint | null }>("SELECT status, ended_at FROM runs WHERE id = ?", id)!;
    assert.equal(status("run-earlier-queued").status, "queued");
    assert.equal(status("run-same-queued").status, "queued", "runs of the reopened stage itself stay");
    assert.equal(status("run-other-edition").status, "queued");
    assert.equal(status("run-later-interrupted").status, "cancelled");
    assert.equal(status("run-later-blocked").status, "cancelled");
    assert.ok(status("run-later-interrupted").ended_at !== null);
    assert.deepEqual({ ...env.db.get("SELECT * FROM runs WHERE id = 'run-later-succeeded'")! }, succeeded_before);
    assert.deepEqual({ ...env.db.get("SELECT * FROM runs WHERE id = 'run-later-failed'")! }, failed_before);
    assert.deepEqual({ ...env.db.get("SELECT * FROM runs WHERE id = ?", lease.run_id)! }, lease_run_before, "a running run with a lease is not touched");
    const receipt = receipt_of(env.db, env.p.project_id, "reopen-plan")!;
    assert.equal(events_of(env.db, receipt.id).filter((e) => e.type === "run.invalidated").length, 2);
    // history events of the finished runs are not rewritten: no invalidation event for them
    assert.equal(events_of(env.db, receipt.id).some((e) => e.run_id === "run-later-succeeded" || e.run_id === "run-later-failed"), false);
  });
});

test("reopen of the last stage releases completion; a released edition cannot be released twice", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    await drive_all(env);
    const out = await reopen_stage(env.service, env.ctx("reopen-publish"), { stage_id: s.publish });
    assert.equal((out.result as { edition_status: string }).edition_status, "active");
    assert.deepEqual((out.result as { stale_stage_ids: string[] }).stale_stage_ids, []);
    assert.equal(edition_row(env.db, env.p.edition_id).status, "active");
    assert.equal(edition_row(env.db, env.p.edition_id).current_stage_id, s.publish);
    const before = state_signature(env.db);
    await rejects_api(release_completion(env.service, env.ctx("rel-active"), { edition_id: env.p.edition_id }), "conflict");
    assert.equal(state_signature(env.db), before);
    // re-run publish and complete again
    const r = await start(env, s.publish, "publish2-start");
    const c = await make_content(env, "pub2");
    const sealed = (await seal(env, r.round_id, [ref(c)], "pub2-seal")).result as SealResult;
    const approved = await approve(env, s.publish, sealed.snapshot_id, "pub2-approve");
    assert.equal(approved.edition_completed, true);
    assert.equal(edition_row(env.db, env.p.edition_id).status, "completed");
  });
});

test("release_completion refuses another active edition and a non-completed edition", async () => {
  await with_env(async (env) => {
    await drive_all(env);
    // a second edition becomes active by hand (fixture: activation is another PR) -> release must conflict
    const ed2 = (await create_edition(env.service, env.ctx("ed-2"), {})).result as { edition_id: string };
    env.db.run("UPDATE editions SET status = 'active' WHERE id = ?", ed2.edition_id);
    const before = state_signature(env.db);
    await rejects_api(release_completion(env.service, env.ctx("rel-1"), { edition_id: env.p.edition_id }), "conflict");
    await rejects_api(release_completion(env.service, env.ctx("rel-2"), { edition_id: ed2.edition_id }), "conflict");
    assert.equal(state_signature(env.db), before);
    assert.equal(edition_row(env.db, env.p.edition_id).status, "completed");
  });
});

// ---------------------------------------------------------------------------
// 5. carry_over version accuracy

test("carry_over tasks twice moves nothing the second time and never rewrites an old version", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const f = insert_followup(env, "f1", s.plan, "accepted", "합성 요청 하나");
    const g = insert_followup(env, "f2", s.plan, "deferred", "합성 요청 둘");
    const done = insert_followup(env, "f3", s.plan, "rejected", "합성 거절");
    const cancelled = insert_followup(env, "f4", s.plan, "cancelled", "합성 취소");
    const old_rows = env.db.all("SELECT * FROM followup_versions ORDER BY version_id").map((x) => ({ ...x }));
    const old_obj_versions = env.db.all("SELECT * FROM object_versions WHERE kind = 'followup' ORDER BY id").map((x) => ({ ...x }));

    const first = (await carry_over(env.service, env.ctx("carry-1"), { kind: "tasks", from_stage_id: s.plan, to_stage_id: s.research })).result as { carried: { followup_id: string; from_version_id: string; version_id: string }[] };
    assert.deepEqual(first.carried.map((x) => x.followup_id), [f.object_id, g.object_id].sort());
    for (const old of old_rows) {
      const now = env.db.get("SELECT * FROM followup_versions WHERE version_id = ?", old.version_id as string)!;
      assert.deepEqual({ ...now }, old, "old version rows are byte-for-byte unchanged");
    }
    for (const old of old_obj_versions) {
      assert.deepEqual({ ...env.db.get("SELECT * FROM object_versions WHERE id = ?", old.id as string)! }, old);
    }
    const counts = table_counts(env.db);

    // already carried: from plan again carries nothing, creates no version and moves no pointer
    const second = (await carry_over(env.service, env.ctx("carry-2"), { kind: "tasks", from_stage_id: s.plan, to_stage_id: s.research })).result as { carried: unknown[] };
    assert.deepEqual(second.carried, []);
    const after = table_counts(env.db);
    assert.equal(after.object_versions, counts.object_versions);
    assert.equal(after.followup_versions, counts.followup_versions);
    for (const x of first.carried) {
      assert.equal(env.db.get<{ current_version_id: string }>("SELECT current_version_id FROM objects WHERE id = ?", x.followup_id)!.current_version_id, x.version_id);
    }
    // rejected / cancelled follow-ups stay with the old stage and old version
    for (const fu of [done, cancelled]) {
      assert.equal(env.db.get<{ current_version_id: string }>("SELECT current_version_id FROM objects WHERE id = ?", fu.object_id)!.current_version_id, fu.version_id);
    }
    // a carry into a skipped-over later stage chains from the newest version, not from the original
    const third = (await carry_over(env.service, env.ctx("carry-3"), { kind: "tasks", from_stage_id: s.research, to_stage_id: s.write })).result as { carried: { followup_id: string; from_version_id: string; version_id: string }[] };
    assert.deepEqual(third.carried.map((x) => x.followup_id), [f.object_id, g.object_id].sort());
    for (const x of third.carried) {
      const firstStep = first.carried.find((y) => y.followup_id === x.followup_id)!;
      assert.equal(x.from_version_id, firstStep.version_id);
      const ov = env.db.get<{ version_no: bigint; based_on_version_id: string }>("SELECT version_no, based_on_version_id FROM object_versions WHERE id = ?", x.version_id)!;
      assert.equal(ov.version_no, 3n);
      assert.equal(ov.based_on_version_id, firstStep.version_id);
    }
    // the plan stage no longer lists them; write does
    const plan_round = (await start(env, s.plan, "plan-start")).round_id;
    assert.deepEqual(open_tasks_for_round(env.db, env.p.project_id, plan_round), []);
  });
});

test("carry_over keeps the follow-up state, the artifact links and the origin columns; applied ones are skipped", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const f = insert_followup(env, "f1", s.plan, "running", "합성 실행 중");
    const applied = insert_followup(env, "f2", s.plan, "applied", "합성 반영됨");
    const before_origin = env.db.all("SELECT * FROM followups ORDER BY object_id").map((x) => ({ ...x }));
    const out = (await carry_over(env.service, env.ctx("carry-1"), { kind: "tasks", from_stage_id: s.plan, to_stage_id: s.analyze })).result as { carried: { followup_id: string; version_id: string }[] };
    assert.deepEqual(out.carried.map((x) => x.followup_id), [f.object_id]);
    const nv = env.db.get<{ state: string; target_stage_id: string; target_round_id: string | null }>("SELECT state, target_stage_id, target_round_id FROM followup_versions WHERE version_id = ?", out.carried[0]!.version_id)!;
    assert.equal(nv.state, "running");
    assert.equal(nv.target_stage_id, s.analyze, "carry may skip stages");
    assert.equal(nv.target_round_id, null);
    assert.deepEqual(env.db.all("SELECT * FROM followups ORDER BY object_id").map((x) => ({ ...x })), before_origin);
    assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM object_versions WHERE object_id = ?", applied.object_id)!.n, 1n);
  });
});

test("carry_over tasks: same stage, earlier stage, missing stage and unknown fields", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    insert_followup(env, "f1", s.research, "accepted", "합성");
    const before = state_signature(env.db);
    await rejects_api(carry_over(env.service, env.ctx("c-same"), { kind: "tasks", from_stage_id: s.research, to_stage_id: s.research }), "conflict");
    await rejects_api(carry_over(env.service, env.ctx("c-back"), { kind: "tasks", from_stage_id: s.research, to_stage_id: s.plan }), "conflict");
    await rejects_api(carry_over(env.service, env.ctx("c-miss"), { kind: "tasks", from_stage_id: s.research, to_stage_id: "no-such" }), "not_found");
    await rejects_api(carry_over(env.service, env.ctx("c-miss2"), { kind: "tasks", from_stage_id: "no-such", to_stage_id: s.analyze }), "not_found");
    await rejects_api(carry_over(env.service, env.ctx("c-extra"), { kind: "tasks", from_stage_id: s.research, to_stage_id: s.analyze, source_version_id: "x" }), "invalid_payload");
    await rejects_api(carry_over(env.service, env.ctx("c-nokind"), { from_stage_id: s.research, to_stage_id: s.analyze }), "invalid_payload");
    await rejects_api(carry_over(env.service, env.ctx("c-topic-extra"), { kind: "topic", from_stage_id: s.research }), "invalid_payload");
    assert.equal(state_signature(env.db), before);
  });
});

test("carry_over topic: an older source version stays the origin and the same source can be carried again as a separate topic", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const obj = (await create_object(env.service, env.ctx("t-o"), { kind: "artifact", edition_id: env.p.edition_id })).result as { object_id: string };
    const v1 = (await add_artifact(env.service, env.ctx("t-v1"), { object_id: obj.object_id, artifact_kind: "topic", stage_id: s.plan, title: "합성 주제", summary: "요약", question: "질문?" })).result as { version_id: string };
    const v2 = (await append_version(env.service, env.ctx("t-v2"), { object_id: obj.object_id, title: "합성 주제 2" })).result as { version_id: string };
    const a = (await carry_over(env.service, env.ctx("carry-a"), { kind: "topic", source_version_id: v2.version_id, stage_id: s.research, title: "A" })).result as { object_id: string; origin_version_id: string };
    assert.equal(a.origin_version_id, v2.version_id, "the exact version named, not the first or the latest");
    const b = (await carry_over(env.service, env.ctx("carry-b"), { kind: "topic", source_version_id: v1.version_id, stage_id: s.analyze, title: "B" })).result as { object_id: string; origin_version_id: string };
    assert.equal(b.origin_version_id, v1.version_id);
    assert.notEqual(a.object_id, b.object_id);
    assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM object_versions WHERE object_id = ?", obj.object_id)!.n, 2n);
    assert.equal(env.db.get<{ origin_version_id: string }>("SELECT origin_version_id FROM artifacts WHERE object_id = ?", obj.object_id)!.origin_version_id ?? null, null, "the source's own origin is untouched");
    // a stage of another project is not a valid target
    const other = await second_project(env);
    const other_stage = stage_ids(env.db, other.edition_id).plan;
    const before = state_signature(env.db);
    await rejects_api(carry_over(env.service, env.ctx("carry-x"), { kind: "topic", source_version_id: v1.version_id, stage_id: other_stage, title: "C" }), "not_found", "conflict");
    assert.equal(state_signature(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// 6. Snapshots do not move

test("a seal snapshot and an edition snapshot keep their versions, hash and manifest when newer versions arrive and the stage is reopened", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const r = await start(env, s.plan, "plan-start");
    const a = await make_content(env, "a");
    const sealed = (await seal(env, r.round_id, [ref(a)], "plan-seal")).result as SealResult;
    await approve(env, s.plan, sealed.snapshot_id, "plan-approve");
    const snap_before = { ...env.db.get("SELECT * FROM snapshots WHERE id = ?", sealed.snapshot_id)! };
    const contents_before = env.db.all("SELECT * FROM round_contents WHERE round_id = ? ORDER BY position", r.round_id).map((x) => ({ ...x }));
    assert.equal(contents_before.length, 1);

    // a newer version of the same object, then a reopen, a new round and a new seal
    const a2 = (await append_version(env.service, env.ctx("a-v2"), { object_id: a.object_id, title: "합성 제목 v2" })).result as { version_id: string };
    await reopen_stage(env.service, env.ctx("reopen-plan"), { stage_id: s.plan });
    const r2 = await start(env, s.plan, "plan2-start");
    const sealed2 = (await seal(env, r2.round_id, [{ object_id: a.object_id, version_id: a2.version_id }], "plan2-seal")).result as SealResult;
    assert.notEqual(sealed2.content_hash, sealed.content_hash, "another version -> another hash");
    assert.notEqual(sealed2.snapshot_id, sealed.snapshot_id);

    assert.deepEqual({ ...env.db.get("SELECT * FROM snapshots WHERE id = ?", sealed.snapshot_id)! }, snap_before);
    assert.deepEqual(env.db.all("SELECT * FROM round_contents WHERE round_id = ? ORDER BY position", r.round_id).map((x) => ({ ...x })), contents_before);
    assert.equal(round_row(env.db, r.round_id).sealed_snapshot_id, sealed.snapshot_id);
    assert.equal(round_row(env.db, r2.round_id).base_snapshot_id, sealed.snapshot_id);

    // the old approval still names the old snapshot until the stage is approved again
    assert.equal(approvals_of(env.db, s.plan)[0]!.snapshot_id, sealed.snapshot_id);
    // the OLD snapshot cannot approve the stage again (it is not the current round's snapshot)
    await rejects_api(approve_stage(env.service, env.ctx("old-approve"), { stage_id: s.plan, snapshot_id: sealed.snapshot_id }), "conflict");
    await approve(env, s.plan, sealed2.snapshot_id, "plan2-approve");
    assert.equal(stage_row(env.db, s.plan).approved_snapshot_id, sealed2.snapshot_id);
    assert.equal(approvals_of(env.db, s.plan).length, 2);
  });
});

test("the same version list gives the same hash across rounds and snapshots; position follows the list order", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const a = await make_content(env, "a");
    const b = await make_content(env, "b");
    const r = await start(env, s.plan, "plan-start");
    const sealed = (await seal(env, r.round_id, [ref(a), ref(b)], "seal-1")).result as SealResult;
    const m = await manifest_blob(env, [ref(a), ref(b)], "m-snap");
    const snap_ed = (await snapshot(env.service, env.ctx("snap-ed"), { scope: "edition", manifest_blob_id: m, versions: [ref(a), ref(b)] })).result as { content_hash: string; snapshot_id: string };
    const snap_st = (await snapshot(env.service, env.ctx("snap-st"), { scope: "stage", stage_id: s.plan, manifest_blob_id: m, versions: [ref(a), ref(b)] })).result as { content_hash: string; snapshot_id: string };
    assert.equal(snap_ed.content_hash, sealed.content_hash);
    assert.equal(snap_st.content_hash, sealed.content_hash);
    assert.match(sealed.content_hash, /^[0-9a-f]{64}$/);
    const rows = env.db.all<{ object_id: string; position: bigint }>("SELECT object_id, position FROM round_contents WHERE round_id = ? ORDER BY position", r.round_id);
    assert.deepEqual(rows.map((x) => x.object_id), [a.object_id, b.object_id]);
    assert.deepEqual(rows.map((x) => x.position), [0n, 1n]);
    const rev = await snapshot(env.service, env.ctx("snap-rev"), { scope: "edition", manifest_blob_id: m, versions: [ref(b), ref(a)] });
    assert.notEqual((rev.result as { content_hash: string }).content_hash, sealed.content_hash, "the hash is a function of the exact (ordered) list");
    // a snapshot does not approve, seal or move anything on the stage
    assert.equal(stage_row(env.db, s.plan).status, "active");
    assert.equal(round_row(env.db, r.round_id).state, "sealed");
    assert.equal(stage_row(env.db, s.plan).approved_snapshot_id, null);
  });
});

test("a snapshot records through_event_seq and control_rev at the time it ran, not later", async () => {
  await with_env(async (env) => {
    const a = await make_content(env, "a");
    const m = await manifest_blob(env, [ref(a)], "m1");
    const seq_of = () => env.db.get<{ n: bigint }>("SELECT coalesce(max(event_seq), 0) AS n FROM events")!.n;
    const rev_of = () => env.db.get<{ control_rev: bigint }>("SELECT control_rev FROM projects WHERE id = ?", env.p.project_id)!.control_rev;
    const seq0 = seq_of();
    const rev0 = rev_of();
    const out = (await snapshot(env.service, env.ctx("snap-1"), { scope: "edition", manifest_blob_id: m, versions: [ref(a)] })).result as { snapshot_id: string };
    const row = env.db.get<{ through_event_seq: bigint | null; control_rev: bigint }>("SELECT through_event_seq, control_rev FROM snapshots WHERE id = ?", out.snapshot_id)!;
    assert.equal(row.control_rev, rev0);
    assert.ok(row.through_event_seq !== null && row.through_event_seq >= seq0 && row.through_event_seq <= seq_of());
    const stored = row.through_event_seq;
    await make_content(env, "more");
    assert.ok(seq_of() > seq0);
    assert.equal(env.db.get<{ through_event_seq: bigint | null }>("SELECT through_event_seq FROM snapshots WHERE id = ?", out.snapshot_id)!.through_event_seq, stored);
  });
});

test("snapshot scope stage needs a stage of this project; edition scope must not carry a stage", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const a = await make_content(env, "a");
    const m = await manifest_blob(env, [ref(a)], "m1");
    const before = state_signature(env.db);
    await rejects_api(snapshot(env.service, env.ctx("sn-nostage"), { scope: "stage", manifest_blob_id: m, versions: [ref(a)] }), "invalid_payload", "conflict");
    await rejects_api(snapshot(env.service, env.ctx("sn-badstage"), { scope: "stage", stage_id: "no-such", manifest_blob_id: m, versions: [ref(a)] }), "not_found");
    await rejects_api(snapshot(env.service, env.ctx("sn-scope"), { scope: "round", stage_id: s.plan, manifest_blob_id: m, versions: [ref(a)] }), "invalid_payload");
    await rejects_api(snapshot(env.service, env.ctx("sn-extra"), { scope: "edition", manifest_blob_id: m, versions: [ref(a)], note: "x" }), "invalid_payload");
    assert.equal(state_signature(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// 7. Replay, other request, rollback, policy for the commands the first file covers lightly

test("create_edition, release_completion, carry_over and snapshot replay by key and refuse another request under the same key", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    insert_followup(env, "f1", s.plan, "accepted", "합성");
    const obj = (await create_object(env.service, env.ctx("t-o"), { kind: "artifact", edition_id: env.p.edition_id })).result as { object_id: string };
    const v1 = (await add_artifact(env.service, env.ctx("t-v1"), { object_id: obj.object_id, artifact_kind: "topic", stage_id: s.plan, title: "합성", summary: "x", question: "?" })).result as { version_id: string };

    const ed1 = await create_edition(env.service, env.ctx("k-ed"), {});
    const editions = table_counts(env.db).editions;
    const ed2 = await create_edition(env.service, env.ctx("k-ed"), {});
    assert.equal(ed2.replayed, true);
    assert.deepEqual(ed2.result, ed1.result);
    assert.equal(table_counts(env.db).editions, editions, "no second edition");
    assert.equal(table_counts(env.db).stages, 12n);
    await rejects_api(create_edition(env.service, env.ctx("k-ed"), { parent_edition_id: env.p.edition_id }), "idempotency_key_reuse");

    const c1 = await carry_over(env.service, env.ctx("k-carry"), { kind: "tasks", from_stage_id: s.plan, to_stage_id: s.research });
    const versions = table_counts(env.db).object_versions;
    const c2 = await carry_over(env.service, env.ctx("k-carry"), { kind: "tasks", from_stage_id: s.plan, to_stage_id: s.research });
    assert.equal(c2.replayed, true);
    assert.deepEqual(c2.result, c1.result);
    assert.equal(table_counts(env.db).object_versions, versions);
    await rejects_api(carry_over(env.service, env.ctx("k-carry"), { kind: "tasks", from_stage_id: s.plan, to_stage_id: s.analyze }), "idempotency_key_reuse");

    const t1 = await carry_over(env.service, env.ctx("k-topic"), { kind: "topic", source_version_id: v1.version_id, stage_id: s.research, title: "T" });
    const objects = table_counts(env.db).objects;
    const t2 = await carry_over(env.service, env.ctx("k-topic"), { kind: "topic", source_version_id: v1.version_id, stage_id: s.research, title: "T" });
    assert.equal(t2.replayed, true);
    assert.deepEqual(t2.result, t1.result);
    assert.equal(table_counts(env.db).objects, objects, "no second topic object");
    await rejects_api(carry_over(env.service, env.ctx("k-topic"), { kind: "topic", source_version_id: v1.version_id, stage_id: s.research, title: "T2" }), "idempotency_key_reuse");
    await rejects_api(carry_over(env.service, env.ctx("k-topic"), { kind: "tasks", from_stage_id: s.plan, to_stage_id: s.research }), "idempotency_key_reuse");
  });
});

test("release_completion replays and a different edition under the same key is refused", async () => {
  await with_env(async (env) => {
    await drive_all(env);
    const first = await release_completion(env.service, env.ctx("k-rel"), { edition_id: env.p.edition_id });
    const again = await release_completion(env.service, env.ctx("k-rel"), { edition_id: env.p.edition_id });
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, first.result);
    assert.equal(edition_row(env.db, env.p.edition_id).status, "active");
    await rejects_api(release_completion(env.service, env.ctx("k-rel"), { edition_id: "other" }), "idempotency_key_reuse");
    // the key is also a replay after later state changed: still the stored reply, no new write
    const before = state_signature(env.db);
    const third = await release_completion(env.service, env.ctx("k-rel"), { edition_id: env.p.edition_id });
    assert.equal(third.replayed, true);
    assert.equal(state_signature(env.db), before);
  });
});

test("a stored reopen reply replays even after the stage was approved again, and a different stage under the key is refused", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    await drive_stage(env, s.plan, "plan");
    const first = await reopen_stage(env.service, env.ctx("k-reopen"), { stage_id: s.plan });
    const r = await start(env, s.plan, "plan2-start");
    const c = await make_content(env, "p2");
    const sealed = (await seal(env, r.round_id, [ref(c)], "plan2-seal")).result as SealResult;
    await approve(env, s.plan, sealed.snapshot_id, "plan2-approve");
    const before = state_signature(env.db);
    const again = await reopen_stage(env.service, env.ctx("k-reopen"), { stage_id: s.plan });
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, first.result);
    assert.equal(state_signature(env.db), before, "a replay does not reopen the stage a second time");
    assert.equal(stage_row(env.db, s.plan).status, "approved");
    await rejects_api(reopen_stage(env.service, env.ctx("k-reopen"), { stage_id: s.research }), "idempotency_key_reuse");
    await rejects_api(reopen_stage(env.service, env.ctx("k-reopen"), { stage_id: s.plan, reason: "다른 사유" }), "idempotency_key_reuse");
  });
});

test("carry_over, release, snapshot, round.start and approve roll back completely when their event write fails", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const f = insert_followup(env, "f1", s.plan, "accepted", "합성");
    const fail_events = wrap_db(env.db, (sql) => {
      if (/INSERT INTO events/i.test(sql)) throw new Error("injected failure");
    });
    const failing = env.with_db(fail_events);

    let before = state_signature(env.db);
    await assert.rejects(carry_over(failing, env.ctx("fx-carry"), { kind: "tasks", from_stage_id: s.plan, to_stage_id: s.research }));
    assert.equal(state_signature(env.db), before);
    assert.equal(env.db.get<{ current_version_id: string }>("SELECT current_version_id FROM objects WHERE id = ?", f.object_id)!.current_version_id, f.version_id);
    const ok = await carry_over(env.service, env.ctx("fx-carry"), { kind: "tasks", from_stage_id: s.plan, to_stage_id: s.research });
    assert.equal(ok.replayed, false);

    await assert.rejects(start_round(failing, env.ctx("fx-start"), { stage_id: s.plan }));
    assert.equal(table_counts(env.db).rounds, 0n);

    const r = await start(env, s.plan, "plan-start");
    const c = await make_content(env, "c1");
    const m = await manifest_blob(env, [ref(c)], "m1");
    before = state_signature(env.db);
    await assert.rejects(snapshot(failing, env.ctx("fx-snap"), { scope: "edition", manifest_blob_id: m, versions: [ref(c)] }));
    assert.equal(state_signature(env.db), before);
    assert.equal(table_counts(env.db).snapshots, 0n);

    const sealed = (await seal_round(env.service, env.ctx("fx-seal"), { round_id: r.round_id, manifest_blob_id: m, versions: [ref(c)] })).result as SealResult;
    await approve(env, s.plan, sealed.snapshot_id, "fx-approve");
    await drive_stage(env, s.research, "research");
    await drive_stage(env, s.analyze, "analyze");
    await drive_stage(env, s.write, "write");
    await drive_stage(env, s.verify, "verify");
    await drive_stage(env, s.publish, "publish");
    assert.equal(edition_row(env.db, env.p.edition_id).status, "completed");
    before = state_signature(env.db);
    await assert.rejects(release_completion(failing, env.ctx("fx-rel"), { edition_id: env.p.edition_id }));
    assert.equal(state_signature(env.db), before);
    assert.equal(edition_row(env.db, env.p.edition_id).status, "completed");
  });
});

test("an approve whose last write fails leaves the stage, the next stage, the pointer and the edition as they were", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const r = await start(env, s.plan, "plan-start");
    const c = await make_content(env, "c1");
    const sealed = (await seal(env, r.round_id, [ref(c)], "seal-1")).result as SealResult;
    const before = state_signature(env.db);
    // fail on the second UPDATE of editions (the pointer move) inside approve
    const wrapped = wrap_db(env.db, (sql) => {
      if (/UPDATE editions/i.test(sql)) throw new Error("injected failure");
    });
    await assert.rejects(approve_stage(env.with_db(wrapped), env.ctx("ap-1"), { stage_id: s.plan, snapshot_id: sealed.snapshot_id }));
    assert.equal(state_signature(env.db), before);
    assert.equal(table_counts(env.db).approvals, 0n);
    assert.equal(stage_row(env.db, s.research).status, "pending");
  });
});

test("policy is asked first: a denied command is refused before payload, existence and role checks, for every new command", async () => {
  await with_env(async (env) => {
    env.policy.allowed = false;
    const base = add_agent(env);
    const before = state_signature(env.db);
    const bad = [
      () => create_edition(env.service, env.ctx("pd-1"), { bogus: 1 }),
      () => start_round(env.service, env.ctx("pd-2"), { stage_id: "no-such" }),
      () => seal_round(env.service, env.ctx("pd-3"), {}),
      () => approve_stage(env.service, agent_ctx(base, "pd-4"), { stage_id: "no-such", snapshot_id: "x" }),
      () => reopen_stage(env.service, agent_ctx(base, "pd-5"), { stage_id: "no-such" }),
      () => release_completion(env.service, env.ctx("pd-6"), { edition_id: "no-such" }),
      () => carry_over(env.service, env.ctx("pd-7"), { kind: "nope" }),
      () => snapshot(env.service, agent_ctx(base, "pd-8"), { scope: "edition" }),
    ];
    for (const call of bad) await rejects_api(call(), "policy_denied");
    assert.equal(state_signature(env.db), before);
    env.policy.allowed = true;
  });
});

test("policy denial of a repeated key does not replay, and re-allowing replays the stored reply", async () => {
  await with_env(async (env) => {
    const s = ids(env);
    const first = await start_round(env.service, env.ctx("pk-1"), { stage_id: s.plan });
    env.policy.allowed = false;
    await rejects_api(start_round(env.service, env.ctx("pk-1"), { stage_id: s.plan }), "policy_denied");
    env.policy.allowed = true;
    const again = await start_round(env.service, env.ctx("pk-1"), { stage_id: s.plan });
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, first.result);
  });
});

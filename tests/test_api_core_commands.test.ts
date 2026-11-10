/**
 * SEL-46 PR13 — core commands behind the HTTP API: run.create and result.submit (tester, 정정 모드).
 *
 * Public functions the tests pin (the worker implements them; the registry gets the two names):
 *
 *   scripts/pes_core/runs.ts
 *     create_run(service, ctx, input) -> Promise<CommandOutcome>      command "run.create"
 *       ctx    a human OWNER's context (agent actors and non-owners -> ApiError "forbidden")
 *       input  { actor_id, mode, runtime, provider, model }   (actor_id = the AGENT actor the run is for;
 *              unknown actor_id -> "not_found" or "invalid_payload")
 *       result { project_id, run_id, actor_id, status: "queued" }
 *       No lease is taken or touched: the first run.claim of this run gets fence 1.
 *       Receipt action / event type "run.created" (one receipt, one event, carrying run_id).
 *
 *   scripts/pes_core/content.ts
 *     submit_results(service, ctx, input) -> Promise<CommandOutcome>  command "result.submit"
 *       ctx    the AGENT's context (ctx.actor_id = the lease owner). The HTTP body's expected_control_rev
 *              is ctx.base_control_rev here (same rule as every other guarded command; stale ->
 *              ApiError "rev_conflict", nothing saved).
 *       input  { run_id, lease_id, fence, results: [{ op: "append_version", object_id, ...version fields
 *              of content.append_version }] }   (1..20 items, closed list: other op / extra key -> "invalid_payload")
 *       result { project_id, run_id, results: [{ object_id, version_id, version_no }] }  (item order kept)
 *       ONE transaction: lease guard (current active unexpired lease with that exact lease_id AND fence,
 *       else "conflict"), every append, ONE receipt (run_id, lease_id, fence), events carrying run_id.
 *       Any item failing (unknown object -> "not_found", ...) rolls back the whole batch: no versions,
 *       no receipt, no event. Same client_request_id + same input replays the receipt (replayed: true,
 *       same version ids, nothing new); same key + different input -> "idempotency_key_reuse".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { COMMANDS, type MutationContext } from "../scripts/pes_core/commands.ts";
import { submit_results } from "../scripts/pes_core/content.ts";
import { ApiError } from "../scripts/pes_core/errors.ts";
import { claim, complete, create_run } from "../scripts/pes_core/runs.ts";
import { new_artifact, with_env, type Env } from "./helpers/blob_env.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

const NEW_RUN = { mode: "B", runtime: "synthetic-runtime", provider: "synthetic", model: "synthetic-model" };

async function rejects(p: Promise<unknown>, ...codes: string[]): Promise<ApiError> {
  try {
    await p;
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
    assert.ok(codes.includes(error.code), `expected ${codes.join("|")}, got ${error.code}`);
    return error;
  }
  assert.fail("expected the command to be rejected");
}

function add_agent(env: Env, name: string): string {
  const user = env.db.get<{ owner_user_id: string }>(
    "SELECT owner_user_id FROM projects WHERE id = ?",
    env.p.project_id,
  );
  assert.ok(user);
  const id = `agent-${name}`;
  env.db.run(
    "INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, 'external_agent', ?, ?)",
    id,
    user.owner_user_id,
    `합성 ${name}`,
  );
  return id;
}

function agent_ctx(env: Env, actor_id: string, key: string, base_control_rev?: number): MutationContext {
  const ctx: MutationContext = { project_id: env.p.project_id, actor_id, via: "http", client_request_id: key };
  return base_control_rev === undefined ? ctx : { ...ctx, base_control_rev };
}

interface Leased {
  actor_id: string;
  run_id: string;
  lease_id: string;
  fence: number;
}

async function leased(env: Env, name: string): Promise<Leased> {
  const actor_id = add_agent(env, name);
  const made = await create_run(env.service, env.ctx(`mk-${name}`), { actor_id, ...NEW_RUN });
  const run_id = (made.result as { run_id: string }).run_id;
  const out = await claim(env.service, agent_ctx(env, actor_id, `cl-${name}`), { run_id });
  const r = out.result as { lease_id: string; fence: number };
  return { actor_id, run_id, lease_id: r.lease_id, fence: r.fence };
}

function batch(l: Leased, results: unknown[]) {
  return { run_id: l.run_id, lease_id: l.lease_id, fence: l.fence, results };
}

function version_count(env: Env): bigint {
  return table_counts(env.db).object_versions ?? 0n;
}

test("both commands are registered", () => {
  assert.ok("run.create" in COMMANDS);
  assert.ok("result.submit" in COMMANDS);
});

// ---------------------------------------------------------------------------
// run.create

test("run.create: the owner makes a queued run for an agent actor; no lease is taken", async () => {
  await with_env(async (env) => {
    const actor_id = add_agent(env, "w");
    const out = await create_run(env.service, env.ctx("rc-1"), { actor_id, ...NEW_RUN });
    assert.equal(out.replayed, false);
    const r = out.result as { project_id: string; run_id: string; actor_id: string; status: string };
    assert.equal(r.project_id, env.p.project_id);
    assert.equal(r.actor_id, actor_id);
    assert.equal(r.status, "queued");
    const row = env.db.get<{ status: string; actor_id: string }>("SELECT status, actor_id FROM runs WHERE id = ?", r.run_id);
    assert.equal(row?.status, "queued");
    assert.equal(row?.actor_id, actor_id);
    const lease = env.db.get<{ state: string }>("SELECT state FROM project_leases WHERE project_id = ?", env.p.project_id);
    assert.ok(lease === undefined || lease.state !== "active", "no active lease");
    const receipt = env.db.get<{ action: string; id: string }>(
      "SELECT id, action FROM mutation_commits WHERE project_id = ? AND client_request_id = ?",
      env.p.project_id,
      "rc-1",
    );
    assert.equal(receipt?.action, "run.created");
    const events = env.db.all<{ type: string; run_id: string | null }>("SELECT type, run_id FROM events WHERE tx_id = ?", receipt!.id);
    assert.deepEqual(events.map((e) => [e.type, e.run_id]), [["run.created", r.run_id]]);
  });
});

test("run.create: the first claim of that run gets fence 1", async () => {
  await with_env(async (env) => {
    const l = await leased(env, "w");
    assert.equal(Number(l.fence), 1);
  });
});

test("run.create: an agent actor and a non-owner human are rejected and nothing is written", async () => {
  await with_env(async (env) => {
    const actor_id = add_agent(env, "w");
    const other = add_agent(env, "o");
    env.db.run("INSERT INTO users (id, display_name) VALUES ('user-x', '합성 타인')");
    env.db.run("INSERT INTO actors (id, kind, user_id, display_name) VALUES ('human-x', 'human', 'user-x', '합성 타인')");
    const before = state_signature(env.db);
    await rejects(create_run(env.service, agent_ctx(env, other, "rc-a"), { actor_id, ...NEW_RUN }), "forbidden");
    await rejects(
      create_run(env.service, { ...agent_ctx(env, "human-x", "rc-h"), via: "web" }, { actor_id, ...NEW_RUN }),
      "forbidden",
    );
    assert.equal(state_signature(env.db), before);
  });
});

test("run.create: unknown actor, missing fields, and extra fields are rejected and nothing is written", async () => {
  await with_env(async (env) => {
    const actor_id = add_agent(env, "w");
    const before = state_signature(env.db);
    await rejects(create_run(env.service, env.ctx("rc-u"), { actor_id: "no-such-actor", ...NEW_RUN }), "not_found", "invalid_payload");
    await rejects(create_run(env.service, env.ctx("rc-m"), { actor_id, mode: "B" }), "invalid_payload");
    await rejects(create_run(env.service, env.ctx("rc-e"), { actor_id, ...NEW_RUN, status: "succeeded" }), "invalid_payload");
    assert.equal(state_signature(env.db), before);
  });
});

test("run.create: the same request replays the receipt; the same key with other input is refused", async () => {
  await with_env(async (env) => {
    const actor_id = add_agent(env, "w");
    const first = await create_run(env.service, env.ctx("rc-r"), { actor_id, ...NEW_RUN });
    const after_first = state_signature(env.db);
    const again = await create_run(env.service, env.ctx("rc-r"), { actor_id, ...NEW_RUN });
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, first.result);
    assert.equal(state_signature(env.db), after_first);
    await rejects(create_run(env.service, env.ctx("rc-r"), { actor_id, ...NEW_RUN, model: "other" }), "idempotency_key_reuse");
    assert.equal(state_signature(env.db), after_first);
  });
});

// ---------------------------------------------------------------------------
// result.submit

test("result.submit: several versions in one transaction, ids returned in item order, one receipt with the lease", async () => {
  await with_env(async (env) => {
    const l = await leased(env, "w");
    const a = await new_artifact(env, "ra");
    const b = await new_artifact(env, "rb");
    const versions_before = version_count(env);
    const out = await submit_results(
      env.service,
      agent_ctx(env, l.actor_id, "rs-1"),
      batch(l, [
        { op: "append_version", object_id: a.object_id, title: "새 제목 A" },
        { op: "append_version", object_id: b.object_id, title: "새 제목 B" },
      ]),
    );
    assert.equal(out.replayed, false);
    const r = out.result as { project_id: string; run_id: string; results: Array<{ object_id: string; version_id: string; version_no: number }> };
    assert.equal(r.run_id, l.run_id);
    assert.deepEqual(r.results.map((x) => x.object_id), [a.object_id, b.object_id]);
    assert.equal(version_count(env), versions_before + 2n);
    for (const [i, art] of [a, b].entries()) {
      assert.notEqual(r.results[i]!.version_id, art.version_id);
      assert.equal(r.results[i]!.version_no, art.version_no + 1);
    }
    const receipts = env.db.all<{ id: string; run_id: string | null; lease_id: string | null; fence: bigint | null }>(
      "SELECT id, run_id, lease_id, fence FROM mutation_commits WHERE project_id = ? AND client_request_id = ?",
      env.p.project_id,
      "rs-1",
    );
    assert.equal(receipts.length, 1, "one receipt for the whole batch");
    assert.equal(receipts[0]!.run_id, l.run_id);
    assert.equal(receipts[0]!.lease_id, l.lease_id);
    assert.equal(Number(receipts[0]!.fence), l.fence);
    const events = env.db.all<{ run_id: string | null }>("SELECT run_id FROM events WHERE tx_id = ?", receipts[0]!.id);
    assert.ok(events.length >= 1);
    assert.ok(events.every((e) => e.run_id === l.run_id));
  });
});

test("result.submit: one failing item rolls back the whole batch (no versions, receipt, or event)", async () => {
  await with_env(async (env) => {
    const l = await leased(env, "w");
    const a = await new_artifact(env, "ra");
    const before = state_signature(env.db);
    await rejects(
      submit_results(
        env.service,
        agent_ctx(env, l.actor_id, "rs-bad"),
        batch(l, [
          { op: "append_version", object_id: a.object_id, title: "좋은 항목" },
          { op: "append_version", object_id: "no-such-object", title: "나쁜 항목" },
        ]),
      ),
      "not_found",
    );
    assert.equal(state_signature(env.db), before);
  });
});

test("result.submit: a stale base_control_rev saves none of the batch; the current one succeeds", async () => {
  await with_env(async (env) => {
    const l = await leased(env, "w");
    const a = await new_artifact(env, "ra");
    const b = await new_artifact(env, "rb");
    await env.service.execute(
      { ...env.ctx("bump"), base_control_rev: 0 },
      "project.set_topic",
      { topic: "합성 주제 바뀜" },
    );
    const before = state_signature(env.db);
    const items = [
      { op: "append_version", object_id: a.object_id, title: "A" },
      { op: "append_version", object_id: b.object_id, title: "B" },
    ];
    await rejects(submit_results(env.service, agent_ctx(env, l.actor_id, "rs-stale", 0), batch(l, items)), "rev_conflict");
    assert.equal(state_signature(env.db), before);
    const ok = await submit_results(env.service, agent_ctx(env, l.actor_id, "rs-fresh", 1), batch(l, items));
    assert.equal((ok.result as { results: unknown[] }).results.length, 2);
  });
});

test("result.submit: stale fence, wrong lease id, another actor, and an ended run are all refused", async () => {
  await with_env(async (env) => {
    const l = await leased(env, "w");
    const other = add_agent(env, "o");
    const a = await new_artifact(env, "ra");
    const items = [{ op: "append_version", object_id: a.object_id, title: "t" }];
    const before = state_signature(env.db);
    await rejects(
      submit_results(env.service, agent_ctx(env, l.actor_id, "rs-f"), { ...batch(l, items), fence: l.fence + 1 }),
      "conflict",
    );
    await rejects(
      submit_results(env.service, agent_ctx(env, l.actor_id, "rs-l"), { ...batch(l, items), lease_id: "wrong-lease" }),
      "conflict",
    );
    await rejects(submit_results(env.service, agent_ctx(env, other, "rs-o"), batch(l, items)), "conflict", "forbidden");
    assert.equal(state_signature(env.db), before);

    await complete(env.service, agent_ctx(env, l.actor_id, "done"), { run_id: l.run_id, lease_id: l.lease_id, fence: l.fence });
    const ended = state_signature(env.db);
    await rejects(submit_results(env.service, agent_ctx(env, l.actor_id, "rs-end"), batch(l, items)), "conflict");
    assert.equal(state_signature(env.db), ended);
  });
});

test("result.submit: lease expiry (now >= expires_at) refuses the batch", async () => {
  await with_env(async (env) => {
    const l = await leased(env, "w");
    const a = await new_artifact(env, "ra");
    const lease = env.db.get<{ expires_at: bigint }>("SELECT expires_at FROM project_leases WHERE project_id = ?", env.p.project_id);
    assert.ok(lease);
    env.clock.advance(Number(lease.expires_at) - env.clock.now_ms());
    const before = state_signature(env.db);
    await rejects(
      submit_results(env.service, agent_ctx(env, l.actor_id, "rs-exp"), batch(l, [{ op: "append_version", object_id: a.object_id, title: "t" }])),
      "conflict",
    );
    assert.equal(state_signature(env.db), before);
  });
});

test("result.submit: the list is closed — unknown op, extra key, empty, and 21 items are invalid_payload", async () => {
  await with_env(async (env) => {
    const l = await leased(env, "w");
    const a = await new_artifact(env, "ra");
    const send = (key: string, results: unknown) => submit_results(env.service, agent_ctx(env, l.actor_id, key), batch(l, results as unknown[]));
    const before = state_signature(env.db);
    await rejects(send("c1", [{ op: "delete_everything", object_id: a.object_id }]), "invalid_payload");
    await rejects(send("c2", [{ op: "append_version", object_id: a.object_id, title: "t", sql: "DROP TABLE runs" }]), "invalid_payload");
    await rejects(send("c3", []), "invalid_payload");
    await rejects(
      send("c4", Array.from({ length: 21 }, (_, i) => ({ op: "append_version", object_id: a.object_id, title: `t${i}` }))),
      "invalid_payload",
    );
    await rejects(send("c5", "not-a-list"), "invalid_payload");
    assert.equal(state_signature(env.db), before);
  });
});

test("result.submit: the same request replays the receipt; the same key with other input is refused", async () => {
  await with_env(async (env) => {
    const l = await leased(env, "w");
    const a = await new_artifact(env, "ra");
    const items = [{ op: "append_version", object_id: a.object_id, title: "한 번만" }];
    const first = await submit_results(env.service, agent_ctx(env, l.actor_id, "rs-r"), batch(l, items));
    const after_first = state_signature(env.db);
    const again = await submit_results(env.service, agent_ctx(env, l.actor_id, "rs-r"), batch(l, items));
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, first.result);
    assert.equal(state_signature(env.db), after_first, "a replay writes nothing");
    await rejects(
      submit_results(env.service, agent_ctx(env, l.actor_id, "rs-r"), batch(l, [{ op: "append_version", object_id: a.object_id, title: "다른 제목" }])),
      "idempotency_key_reuse",
    );
    assert.equal(state_signature(env.db), after_first);
  });
});

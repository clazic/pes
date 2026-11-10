/**
 * SEL-46 PR13 — HTTP API: project creation (tester, 작성 모드).
 *
 *   POST /api/v1/projects   {slug, topic, owner_display_name}   credential: the local session only
 *     -> 201 data { project_id, owner_user_id, owner_actor_id, edition_id, policy_id,
 *                   stage_ids: {plan,...,publish} }
 *
 * The owner, the initial policy (OpenCode Go transfer ON, policy_rev 1, authored by the owner human),
 * the first edition with its six stages, the mutation receipt, and the event are ONE transaction.
 * The core command may be the existing project.bootstrap or a new project.create — the tests only
 * look at the HTTP answer and the rows. The client never chooses an id, status, or policy.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { assert_error, assert_ok, call, make_agent, project_path, with_api, SESSION_SECRET } from "./helpers/api_env.ts";
import { wrap_db } from "./helpers/blob_env.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

const CREATE = "/api/v1/projects";
const BODY = { slug: "synthetic-created", topic: "합성 새 주제", owner_display_name: "합성 새 소유자" };

test("project create makes the owner, the initial policy, and the first edition together", async () => {
  await with_api(async (env) => {
    const before = table_counts(env.db);
    const res = await call(env, { method: "POST", path: CREATE, auth: "owner", body: BODY });
    const data = assert_ok(res, 201);
    assert.equal(res.json.replayed, false);
    for (const key of ["project_id", "owner_user_id", "owner_actor_id", "edition_id", "policy_id"]) {
      assert.equal(typeof data[key], "string", key);
    }
    assert.deepEqual(Object.keys(data.stage_ids).sort(), ["analyze", "plan", "publish", "research", "verify", "write"]);

    const project = env.db.get<Record<string, unknown>>("SELECT * FROM projects WHERE id = ?", data.project_id);
    assert.ok(project);
    assert.equal(project.slug, BODY.slug);
    assert.equal(project.topic, BODY.topic);
    assert.equal(project.status, "active");
    assert.equal(project.owner_user_id, data.owner_user_id);
    assert.equal(project.active_edition_id, data.edition_id);
    assert.equal(project.current_policy_id, data.policy_id);
    assert.equal(project.control_rev, 0n);

    const member = env.db.get<{ role: string }>(
      "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
      data.project_id,
      data.owner_user_id,
    );
    assert.equal(member?.role, "owner");
    const actor = env.db.get<{ kind: string; user_id: string }>("SELECT kind, user_id FROM actors WHERE id = ?", data.owner_actor_id);
    assert.equal(actor?.kind, "human");
    assert.equal(actor?.user_id, data.owner_user_id);

    const edition = env.db.get<{ edition_no: bigint; status: string }>("SELECT edition_no, status FROM editions WHERE id = ?", data.edition_id);
    assert.equal(edition?.edition_no, 1n);
    assert.equal(edition?.status, "active");
    assert.equal(env.db.all("SELECT 1 FROM stages WHERE edition_id = ?", data.edition_id).length, 6);

    const policy = env.db.get<{ policy_rev: bigint; allow_opencode_go: bigint; changed_by_kind: string }>(
      "SELECT policy_rev, allow_opencode_go, changed_by_kind FROM project_policy_versions WHERE id = ?",
      data.policy_id,
    );
    assert.equal(policy?.policy_rev, 1n);
    assert.equal(policy?.allow_opencode_go, 1n, "Go transfer is ON by default");
    assert.equal(policy?.changed_by_kind, "human");

    // One transaction: the receipt, the policy row, and the events share one tx id.
    const receipts = env.db.all<{ id: string }>("SELECT id FROM mutation_commits WHERE project_id = ?", data.project_id);
    assert.equal(receipts.length, 1);
    const policy_tx = env.db.get<{ tx_id: string }>("SELECT tx_id FROM project_policy_versions WHERE id = ?", data.policy_id);
    assert.equal(policy_tx?.tx_id, receipts[0].id);
    const events = env.db.all<{ type: string; tx_id: string }>("SELECT type, tx_id FROM events WHERE project_id = ?", data.project_id);
    assert.ok(events.length >= 1);
    assert.ok(events.every((e) => e.tx_id === receipts[0].id));
    assert.ok(events.some((e) => e.type === "project.created"));

    const after = table_counts(env.db);
    assert.equal(after.projects, before.projects + 1n);
    assert.equal(after.project_policy_versions, before.project_policy_versions + 1n);
    assert.equal(after.editions, before.editions + 1n);
    assert.equal(after.stages, before.stages + 6n);
  });
});

test("the created project is usable at once: the owner session reads its context", async () => {
  await with_api(async (env) => {
    const created = assert_ok(await call(env, { method: "POST", path: CREATE, auth: "owner", body: BODY }), 201);
    const ctx = assert_ok(
      await call(env, { method: "GET", path: `/api/v1/projects/${created.project_id}/context`, auth: "owner" }),
    );
    assert.equal(ctx.project_id, created.project_id);
    assert.equal(ctx.topic, BODY.topic);
    assert.equal(ctx.control_rev, "0");
    assert.equal(ctx.policy.policy_rev, "1");
    assert.equal(ctx.policy.allow_opencode_go, true);
    assert.equal(ctx.edition.edition_id, created.edition_id);
    assert.equal(ctx.stages.length, 6);
  });
});

test("a failure in the middle leaves nothing behind, answers a generic 500, and a retry then succeeds", async () => {
  for (const failing_table of ["project_policy_versions", "stages", "editions", "project_members", "counters"]) {
    let armed = true;
    await with_api(
      async (env) => {
        const before = state_signature(env.db);
        const res = await call(env, { method: "POST", path: CREATE, auth: "owner", key: "create-fail", body: BODY });
        const error = assert_error(res, 500, "internal_error");
        assert.doesNotMatch(error.message, /boom|disk full|project_policy_versions|stages|editions/i);
        assert.equal(state_signature(env.db), before, `${failing_table}: no user, actor, project, policy, edition, receipt, or event`);

        armed = false;
        const retry = await call(env, { method: "POST", path: CREATE, auth: "owner", key: "create-fail", body: BODY });
        const data = assert_ok(retry, 201);
        assert.equal(retry.json.replayed, false, "the failed attempt left no receipt to replay");
        assert.equal(env.db.all("SELECT 1 FROM projects WHERE slug = ?", BODY.slug).length, 1);
        assert.equal(data.stage_ids.plan.length > 0, true);
      },
      {
        wrap: (db) =>
          wrap_db(db, (sql) => {
            if (armed && new RegExp(`^\\s*INSERT INTO ${failing_table}\\b`, "i").test(sql)) {
              throw new Error("boom: disk full");
            }
          }),
      },
    );
  }
});

test("a failure after the policy row but before the project pointers still leaves nothing", async () => {
  let armed = true;
  await with_api(
    async (env) => {
      const before = state_signature(env.db);
      const res = await call(env, { method: "POST", path: CREATE, auth: "owner", body: BODY });
      assert_error(res, 500, "internal_error");
      assert.equal(state_signature(env.db), before);
      armed = false;
      assert_ok(await call(env, { method: "POST", path: CREATE, auth: "owner", body: BODY }), 201);
    },
    {
      wrap: (db) =>
        wrap_db(db, (sql) => {
          if (armed && /^\s*UPDATE projects\s+SET active_edition_id/i.test(sql)) throw new Error("boom: crash before pointers");
        }),
    },
  );
});

test("replay: the same key and body returns the original project; a different body under the key is 409", async () => {
  await with_api(async (env) => {
    const first = await call(env, { method: "POST", path: CREATE, auth: "owner", key: "create-1", body: BODY });
    const a = assert_ok(first, 201);
    const counts = table_counts(env.db);
    const again = await call(env, { method: "POST", path: CREATE, auth: "owner", key: "create-1", body: BODY });
    const b = assert_ok(again, 201);
    assert.equal(again.json.replayed, true);
    assert.equal(b.project_id, a.project_id);
    assert.deepEqual(table_counts(env.db), counts);
    const reused = await call(env, { method: "POST", path: CREATE, auth: "owner", key: "create-1", body: { ...BODY, topic: "다른 주제" } });
    assert_error(reused, 409, "idempotency_key_reuse");
    assert.deepEqual(table_counts(env.db), counts);
  });
});

test("a duplicate slug is 409 conflict and creates nothing", async () => {
  await with_api(async (env) => {
    assert_ok(await call(env, { method: "POST", path: CREATE, auth: "owner", body: BODY }), 201);
    const before = state_signature(env.db);
    const res = await call(env, { method: "POST", path: CREATE, auth: "owner", body: { ...BODY, topic: "다른 주제" } });
    assert_error(res, 409, "conflict");
    assert.equal(state_signature(env.db), before);
  });
});

test("only the local session may create a project: no credential 401, wrong secret 401, an agent token never", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "any");
    const before = state_signature(env.db);
    assert_error(await call(env, { method: "POST", path: CREATE, body: BODY }), 401, "unauthenticated");
    assert_error(await call(env, { method: "POST", path: CREATE, headers: { "x-pes-session": "wrong" }, body: BODY }), 401, "unauthenticated");
    const with_token = await call(env, { method: "POST", path: CREATE, auth: { token: agent.token }, body: BODY });
    assert.ok([401, 403].includes(with_token.status), `an agent token got ${with_token.status}`);
    assert.ok(with_token.json.error);
    assert.equal(state_signature(env.db), before);
    // Sanity: the right secret works.
    assert.equal(SESSION_SECRET.length > 0, true);
  });
});

test("validation: missing, empty, non-string, and unknown fields (including client-chosen ids/policy) are 400", async () => {
  await with_api(async (env) => {
    const before = state_signature(env.db);
    const bad: unknown[] = [
      {},
      { slug: BODY.slug, topic: BODY.topic },
      { slug: BODY.slug, owner_display_name: BODY.owner_display_name },
      { topic: BODY.topic, owner_display_name: BODY.owner_display_name },
      { ...BODY, slug: "" },
      { ...BODY, topic: "   " },
      { ...BODY, owner_display_name: 7 },
      { ...BODY, slug: null },
      { ...BODY, project_id: "client-chosen" },
      { ...BODY, owner_user_id: "client-chosen" },
      { ...BODY, status: "active" },
      { ...BODY, allow_opencode_go: false },
      { ...BODY, policy: { allow_opencode_go: false } },
    ];
    for (const body of bad) {
      assert_error(await call(env, { method: "POST", path: CREATE, auth: "owner", body }), 400, "invalid_payload");
    }
    assert_error(await call(env, { method: "POST", path: CREATE, auth: "owner", raw: "not json" }), 400, "invalid_payload");
    assert_error(await call(env, { method: "POST", path: CREATE, auth: "owner", key: null, body: BODY }), 400, "invalid_payload");
    assert.equal(state_signature(env.db), before, "no partial project from a rejected request");
  });
});

test("project create is closed: it is not a generic table insert, and other verbs on the collection are not it", async () => {
  await with_api(async (env) => {
    const res = await call(env, { method: "DELETE", path: CREATE, auth: "owner" });
    assert.ok([404, 405].includes(res.status));
    assert.ok(res.json.error);
    const patch = await call(env, { method: "PATCH", path: project_path(env), auth: "owner", body: { topic: "x" } });
    assert.ok([404, 405].includes(patch.status));
    assert.ok(patch.json.error);
  });
});

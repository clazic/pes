/**
 * SEL-47 PR14 — HTTP API: POST /api/v1/project-registrations, the first registration of a project
 * without a project token, by device approval (tester, 작성 모드). The empty-account end-to-end of
 * method B (PR20a) is NOT tested here.
 *
 *   POST /api/v1/project-registrations
 *     credential: the owner's local session ONLY (x-pes-session) — that session IS the human's approval of
 *     the new device. No project token exists yet, and no token (of any project) may register.
 *     body {slug, topic, owner_display_name, device_label, scopes?}
 *       scopes: non-empty, unique, each one of context:read|run:claim|run:submit|file:write|file:read;
 *               default = all five. Anything else (stage:approve, owner, policy:write …) is 400.
 *       unknown fields (owner_user_id, role, allow_opencode_go, policy …) are 400 — a registration cannot
 *       choose the owner, the policy, or an id.
 *     -> 201 data = the project.create result {project_id, owner_user_id, owner_actor_id, edition_id,
 *        policy_id, stage_ids} PLUS {device_actor_id, token_id, token, scopes, expires_at}
 *     One transaction (new core command `project.register`, scope: no project yet, like project.bootstrap):
 *     owner, initial policy (Go ON, rev 1), first edition, the device actor (kind external_agent, the owner's
 *     user, display_name = device_label), the token (30 days, hash only), one receipt, the events.
 *     A replay (same key, same body) answers 201 with replayed:true and the same ids but NEVER the token
 *     again; the same key with another body is 409; a slug that already exists is 409 `conflict` and
 *     writes nothing (no device, no token).
 *
 * The device token is an ordinary agent token: it reads context, claims, submits — and cannot approve,
 * reopen, change the policy, create or register projects, or touch another project.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ALL_AGENT_SCOPES, SESSION_SECRET, assert_ok, call, make_agent, with_api, DECIMAL } from "./helpers/api_env.ts";
import { P, assert_final_error, NEXT_ACTION } from "./helpers/api_flow.ts";
import { wrap_db } from "./helpers/blob_env.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

const REGISTER = "/api/v1/project-registrations";
const BODY = { slug: "synthetic-registered", topic: "합성 등록 주제", owner_display_name: "합성 등록 소유자", device_label: "합성 기기 A" };

function dump_text(env: { db: { all: (sql: string) => unknown[] } }): string {
  // Every row of every table, as text — used to prove a raw secret is stored nowhere.
  const tables = env.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'") as Array<{ name: string }>;
  return tables.map((t) => JSON.stringify(env.db.all(`SELECT * FROM "${t.name}"`), (_k, v) => (typeof v === "bigint" ? v.toString() : v))).join("\n");
}

test("device approval registers the project and returns its first token in one step", async () => {
  await with_api(async (env) => {
    const before = table_counts(env.db);
    const res = await call(env, { method: "POST", path: REGISTER, auth: "owner", body: BODY });
    const data = assert_ok(res, 201);
    assert.equal(res.json.replayed, false);
    for (const key of ["project_id", "owner_user_id", "owner_actor_id", "edition_id", "policy_id", "device_actor_id", "token_id", "token"]) {
      assert.equal(typeof data[key], "string", key);
    }
    assert.deepEqual(Object.keys(data.stage_ids).sort(), ["analyze", "plan", "publish", "research", "verify", "write"]);
    assert.deepEqual([...data.scopes].sort(), [...ALL_AGENT_SCOPES].sort(), "default scopes");
    assert.ok(Number.isSafeInteger(data.expires_at));
    assert.equal(data.expires_at, env.clock.now_ms() + 30 * 24 * 60 * 60 * 1000);

    const after = table_counts(env.db);
    assert.equal(after.projects - before.projects, 1n);
    assert.equal(after.agent_tokens - before.agent_tokens, 1n);
    assert.equal(after.mutation_commits - before.mutation_commits, 1n, "one transaction, one receipt");

    const device = env.db.get<{ kind: string; user_id: string; display_name: string }>("SELECT kind, user_id, display_name FROM actors WHERE id = ?", data.device_actor_id);
    assert.equal(device?.kind, "external_agent", "a device is an agent, never a human");
    assert.equal(device?.user_id, data.owner_user_id);
    assert.equal(device?.display_name, BODY.device_label);
    const policy = env.db.get<{ policy_rev: bigint; allow_opencode_go: bigint; changed_by_kind: string }>(
      "SELECT policy_rev, allow_opencode_go, changed_by_kind FROM project_policy_versions WHERE id = ?",
      data.policy_id,
    );
    assert.equal(policy?.policy_rev, 1n);
    assert.equal(policy?.allow_opencode_go, 1n);
    assert.equal(policy?.changed_by_kind, "human", "the initial policy is the human owner's, not the device's");
    const receipts = env.db.all<{ id: string; actor_id: string }>("SELECT id, actor_id FROM mutation_commits WHERE project_id = ?", data.project_id);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.actor_id, data.owner_actor_id, "the approving human is the actor of record");
    const events = env.db.all<{ type: string; tx_id: string }>("SELECT type, tx_id FROM events WHERE project_id = ?", data.project_id);
    assert.ok(events.length >= 1 && events.every((e) => e.tx_id === receipts[0]!.id));
    assert.ok(events.some((e) => e.type === "project.registered"));
    const token = env.db.get<{ actor_id: string; project_id: string; token_hash: string }>("SELECT actor_id, project_id, token_hash FROM agent_tokens WHERE id = ?", data.token_id);
    assert.equal(token?.actor_id, data.device_actor_id);
    assert.equal(token?.project_id, data.project_id);
    assert.ok(!dump_text(env).includes(data.token), "the raw token is stored nowhere (hash only, not in the receipt)");
  });
});

test("the returned token works as an ordinary agent token and nothing more", async () => {
  await with_api(async (env) => {
    const data = assert_ok(await call(env, { method: "POST", path: REGISTER, auth: "owner", body: BODY }), 201);
    const bearer = { token: data.token as string };
    const proj = (rest = "") => `/api/v1/projects/${data.project_id}${rest}`;

    const context = assert_ok(await call(env, { method: "GET", path: proj("/context"), auth: bearer }));
    assert.equal(context.project_id, data.project_id);
    const claim = assert_ok(await call(env, { method: "POST", path: proj("/claims"), auth: bearer, body: { mode: "B", runtime: "device", provider: "synthetic", model: "synthetic-model" } }));
    assert.equal(typeof claim.run_id, "string");

    const sig = state_signature(env.db);
    const plan = data.stage_ids.plan as string;
    assert_final_error(await call(env, { method: "POST", path: proj(`/stages/${plan}/approve`), auth: bearer, body: { snapshot_id: "x" } }), 403, "forbidden", {
      next_action: NEXT_ACTION.forbidden_human_only,
    });
    assert_final_error(await call(env, { method: "POST", path: proj("/policies/opencode-go/revisions"), auth: bearer, body: { reason: "x", allow_opencode_go: false } }), 403, "forbidden");
    assert_final_error(await call(env, { method: "POST", path: proj("/runs"), auth: bearer, body: { actor_id: data.device_actor_id, mode: "B", runtime: "r", provider: "p", model: "m" } }), 403, "forbidden");
    assert_final_error(await call(env, { method: "POST", path: REGISTER, auth: bearer, body: { ...BODY, slug: "second-by-token" } }), 401, "unauthenticated");
    assert_final_error(await call(env, { method: "POST", path: "/api/v1/projects", auth: bearer, body: { slug: "second-by-token", topic: "합성", owner_display_name: "x" } }), 401, "unauthenticated");
    assert.equal(state_signature(env.db), sig);

    // Not valid for another project.
    const other = assert_ok(await call(env, { method: "POST", path: REGISTER, auth: "owner", body: { ...BODY, slug: "synthetic-registered-2" } }), 201);
    assert_final_error(await call(env, { method: "GET", path: `/api/v1/projects/${other.project_id}/context`, auth: bearer }), 401, "unauthenticated");
    assert_ok(await call(env, { method: "GET", path: `/api/v1/projects/${other.project_id}/context`, auth: { token: other.token } }));
  });
});

test("only the local session approves a device: no credential, a wrong session, or any project token is 401 and writes nothing", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "existing");
    const sig = state_signature(env.db);
    assert_final_error(await call(env, { method: "POST", path: REGISTER, body: BODY }), 401, "unauthenticated", { next_action: NEXT_ACTION.unauthenticated });
    assert_final_error(await call(env, { method: "POST", path: REGISTER, headers: { "x-pes-session": "wrong" }, body: BODY }), 401, "unauthenticated");
    assert_final_error(await call(env, { method: "POST", path: REGISTER, auth: { token: agent.token }, body: BODY }), 401, "unauthenticated");
    assert_final_error(await call(env, { method: "POST", path: REGISTER, auth: { token: agent.token }, headers: { "x-pes-session": "wrong" }, body: BODY }), 401, "unauthenticated");
    assert.equal(state_signature(env.db), sig);
    assert.equal(SESSION_SECRET.length > 0, true);
  });
});

test("the body: required fields, closed scopes, and no way to choose the owner, role, policy, or an id", async () => {
  await with_api(async (env) => {
    const sig = state_signature(env.db);
    const post = (body: unknown) => call(env, { method: "POST", path: REGISTER, auth: "owner", body });
    for (const field of ["slug", "topic", "owner_display_name", "device_label"]) {
      const { [field]: _omit, ...rest } = BODY as Record<string, string>;
      assert_final_error(await post(rest), 400, "invalid_payload", { target: `$.body.${field}`, next_action: NEXT_ACTION.invalid_payload });
    }
    assert_final_error(await post({ ...BODY, slug: "Bad Slug!" }), 400, "invalid_payload", { target: "$.body.slug" });
    assert_final_error(await post({ ...BODY, device_label: "" }), 400, "invalid_payload", { target: "$.body.device_label" });
    for (const field of ["owner_user_id", "owner_actor_id", "role", "allow_opencode_go", "policy", "project_id", "token", "actor_id", "kind"]) {
      assert_final_error(await post({ ...BODY, [field]: "x" }), 400, "invalid_payload", { target: `$.body.${field}` });
    }
    assert_final_error(await post({ ...BODY, scopes: [] }), 400, "invalid_payload", { target: "$.body.scopes" });
    assert_final_error(await post({ ...BODY, scopes: "context:read" }), 400, "invalid_payload", { target: "$.body.scopes" });
    assert_final_error(await post({ ...BODY, scopes: ["context:read", "context:read"] }), 400, "invalid_payload", { target: "$.body.scopes" });
    for (const bad of ["stage:approve", "owner", "policy:write", "project:create", "*", "token:issue"]) {
      assert_final_error(await post({ ...BODY, scopes: ["context:read", bad] }), 400, "invalid_payload", { target: "$.body.scopes[1]" });
    }
    assert_final_error(await call(env, { method: "POST", path: REGISTER, auth: "owner", body: BODY, key: null }), 400, "invalid_payload", { target: /idempotency-key/i });
    assert_final_error(await call(env, { method: "POST", path: REGISTER, auth: "owner", raw: "{not json" }), 400, "invalid_payload");
    assert.equal(state_signature(env.db), sig, "no refused registration left a project, a device, a token, or a receipt");

    const narrow = assert_ok(await post({ ...BODY, scopes: ["context:read"] }), 201);
    assert.deepEqual(narrow.scopes, ["context:read"]);
    assert_ok(await call(env, { method: "GET", path: `/api/v1/projects/${narrow.project_id}/context`, auth: { token: narrow.token } }));
    assert_final_error(
      await call(env, { method: "POST", path: `/api/v1/projects/${narrow.project_id}/claims`, auth: { token: narrow.token }, body: { mode: "B", runtime: "r", provider: "p", model: "m" } }),
      403,
      "forbidden",
    );
  });
});

test("a taken slug is 409 and leaves nothing; the same key replays without the token; another body under that key is 409", async () => {
  await with_api(async (env) => {
    const first = await call(env, { method: "POST", path: REGISTER, auth: "owner", body: BODY, key: "reg-1" });
    const data = assert_ok(first, 201);
    const sig = state_signature(env.db);

    const replay = await call(env, { method: "POST", path: REGISTER, auth: "owner", body: BODY, key: "reg-1" });
    const again = assert_ok(replay, 201);
    assert.equal(replay.json.replayed, true);
    for (const key of ["project_id", "owner_user_id", "owner_actor_id", "edition_id", "policy_id", "device_actor_id", "token_id"]) {
      assert.equal(again[key], data[key], key);
    }
    assert.equal(again.token, undefined, "the secret is shown once, never replayed");
    assert.equal(state_signature(env.db), sig, "a replay writes nothing — no second device, no second token");

    assert_final_error(await call(env, { method: "POST", path: REGISTER, auth: "owner", body: { ...BODY, device_label: "다른 기기" }, key: "reg-1" }), 409, "idempotency_key_reuse");
    assert_final_error(await call(env, { method: "POST", path: REGISTER, auth: "owner", body: { ...BODY, device_label: "다른 기기" }, key: "reg-2" }), 409, "conflict", {
      next_action: NEXT_ACTION.conflict,
    });
    assert.equal(state_signature(env.db), sig);
    // A slug taken by an ordinary project create is taken for registration too.
    const created = await call(env, { method: "POST", path: "/api/v1/projects", auth: "owner", body: { slug: "taken-by-create", topic: "합성", owner_display_name: "합성" } });
    assert_ok(created, 201);
    assert_final_error(await call(env, { method: "POST", path: REGISTER, auth: "owner", body: { ...BODY, slug: "taken-by-create" } }), 409, "conflict");
  });
});

test("registration is all or nothing: a failure while issuing the token leaves no project, no device, no receipt", async () => {
  let armed = false;
  await with_api(
    async (env) => {
      const sig = state_signature(env.db);
      armed = true;
      const res = await call(env, { method: "POST", path: REGISTER, auth: "owner", body: BODY, key: "reg-fail" });
      assert.equal(res.status, 500);
      assert.equal(res.json.error.code, "internal_error");
      assert.doesNotMatch(JSON.stringify(res.json), /boom|disk full|agent_tokens/i);
      assert.equal(state_signature(env.db), sig);
      armed = false;
      const retry = await call(env, { method: "POST", path: REGISTER, auth: "owner", body: BODY, key: "reg-fail" });
      assert_ok(retry, 201);
      assert.equal(retry.json.replayed, false, "the failed attempt left nothing to replay");
    },
    {
      wrap: (db) =>
        wrap_db(db, (sql) => {
          if (armed && /^\s*INSERT INTO agent_tokens\b/i.test(sql)) throw new Error("boom: disk full");
        }),
    },
  );
});

test("core: project.register is a registered command with project.bootstrap's scope; an actor inside a project cannot call it", async () => {
  await with_api(async (env) => {
    const out = await env.service.execute(
      { project_id: null, actor_id: null, via: "cli", client_request_id: "core-reg-1" },
      "project.register",
      { ...BODY, slug: "core-registered" },
    );
    const result = out.result as Record<string, unknown>;
    assert.equal(typeof result.token, "string");
    assert.equal(typeof result.device_actor_id, "string");
    assert.match(String(result.expires_at), DECIMAL);
    const sig = state_signature(env.db);
    await assert.rejects(
      env.service.execute(env.ctx("core-reg-inside"), "project.register", { ...BODY, slug: "core-registered-2" }),
      (error: { code?: string }) => ["forbidden", "invalid_payload"].includes(error.code ?? ""),
    );
    assert.equal(state_signature(env.db), sig);
    assert.equal(P(env).startsWith("/api/v1/projects/"), true);
  });
});

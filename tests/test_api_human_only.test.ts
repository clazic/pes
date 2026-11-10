/**
 * SEL-47 PR14 — HTTP API: human-only commands and the session / token split (tester, 작성 모드).
 * Shapes and error names follow docs/plan/fixtures/api-v1 (stage-approve, stage-reopen, rounds, round-seal,
 * policy-revisions).
 *
 *   POST P/stages/{s}/approve   body {snapshot_id, expected_stage_rev? (decimal string), confirm? ("owner"),
 *                                format_version?}                  owner human session ONLY
 *        -> 200 data {stage:{id, status:"approved", approved_snapshot_id}, approval:{id,
 *                     assurance:"verified", human_user_id}}
 *        409 `stale_stage` (target "$.body.expected_stage_rev", details {stage_status, current_rev},
 *        next_action "reread_stage") when expected_stage_rev is not the stage's rev.
 *   POST P/stages/{s}/reopen    body {reason?, expected_stage_rev?, format_version?}   owner human session ONLY
 *        -> 200 data {stage:{id, status, current_round_id|null}, reopened:{prior_approval_id,
 *                     stale_after_stage_ordinal}}
 *   POST P/stages/{s}/rounds    body {purpose?, base_stage_rev?, question_set_id?, format_version?}
 *        owner session, or an agent member with run:submit (no lease field)
 *        -> 201 data {round:{id, round_no (decimal string), state:"open", stage_id}};
 *        409 `stage_not_active` (details {stage_id, stage_status}, target "$.path.stage_id",
 *        next_action "reread_stage") for an approved stage; 409 `conflict` for a second open round.
 *   POST P/rounds/{rd}/seal     body {manifest_blob_id, versions[], run_id?, lease_id?, fence?, snapshot_scope?,
 *                                expected_round_rev?}   owner, or an agent holding the lease
 *        -> 200 data {round:{id, state:"sealed", sealed_snapshot_id, through_event_seq (decimal string)}};
 *        409 `already_sealed` (target "$.path.round_id", details {round_id, state, snapshot_id},
 *        next_action "reread_round").  (The documents' seal body has no manifest: a documented gap, see report.)
 *   POST P/policies/opencode-go/revisions   body {reason, allow_opencode_go?, go_usage_stop_percent?,
 *        mode_a_model?, expected_policy_rev? (decimal string), format_version?}   owner session ONLY
 *        -> 201 data {policy:{id, policy_rev (decimal string), allow_opencode_go, changed_by_user_id}};
 *        afterwards a mode A claim is 403 `policy_blocked`; 409 `rev_conflict` (target
 *        "$.body.expected_policy_rev") when expected_policy_rev is stale.
 *
 * Credentials: `x-pes-session` = the owner's local human session; `Authorization: Bearer` = a project
 * agent token. They are never mixed: a request with a session header carrying a wrong secret is 401 even
 * if it also carries a valid token. An agent on a human-only route is authenticated but not allowed:
 *   approve / reopen / submissions: 403 `human_required`;  policy revisions: 403 `owner_required`;
 *   target "$.headers.Authorization", next_action "use_owner_session",
 *   details {actor_kind, required} (required = "human_owner" for human_required, "owner_human" for owner_required).
 * Nothing in the body or extra headers (human_id, via, x-pes-actor, WebMCP notes) can make an agent a
 * human. Check order: credential -> kind of actor -> body shape -> state; so an agent is always 403 and the
 * refusal writes nothing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agent_claims,
  assert_ok,
  call,
  make_agent,
  with_api,
  type ApiEnv,
} from "./helpers/api_env.ts";
import { P, assert_final_error, NEXT_ACTION } from "./helpers/api_flow.ts";
import { make_content, manifest_blob, seal, stage_ids, start } from "./helpers/editions_env.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

/** plan stage with a sealed round, set up through the core service (not HTTP). */
async function sealed_plan(env: ApiEnv, tag: string) {
  const s = stage_ids(env.db, env.p.edition_id);
  const round = await start(env, s.plan, `${tag}-start`);
  const content = await make_content(env, tag);
  const versions = [{ object_id: content.object_id, version_id: content.version_id }];
  const sealed = (await seal(env, round.round_id, versions, `${tag}-seal`)).result as { snapshot_id: string };
  return { s, round, versions, snapshot_id: sealed.snapshot_id };
}

// ---------------------------------------------------------------------------
// approve / reopen: the owner's human session only

test("the owner approves a sealed stage over HTTP: 200, one approval by the human, verified", async () => {
  await with_api(async (env) => {
    const { s, snapshot_id } = await sealed_plan(env, "ap");
    const before = table_counts(env.db);
    const res = await call(env, {
      method: "POST",
      path: P(env, `/stages/${s.plan}/approve`),
      auth: "owner",
      body: { format_version: "1.0", snapshot_id, confirm: "owner" },
    });
    const data = assert_ok(res, 200);
    assert.equal(data.stage.id, s.plan);
    assert.equal(data.stage.status, "approved");
    assert.equal(data.stage.approved_snapshot_id, snapshot_id);
    assert.equal(data.approval.assurance, "verified");
    assert.equal(data.approval.human_user_id, env.db.get<{ owner_user_id: string }>("SELECT owner_user_id FROM projects WHERE id = ?", env.p.project_id)?.owner_user_id);
    const after = table_counts(env.db);
    assert.equal(after.approvals - before.approvals, 1n);
    const approval = env.db.get<{ actor_id: string; actor_kind: string; human_user_id: string; origin: string; assurance: string }>(
      "SELECT actor_id, actor_kind, human_user_id, origin, assurance FROM approvals WHERE id = ?",
      data.approval.id,
    );
    assert.equal(approval?.actor_id, env.p.actor_id);
    assert.equal(approval?.actor_kind, "human");
    assert.equal(approval?.origin, "new");
    assert.equal(approval?.assurance, "verified");
    const stage = env.db.get<{ status: string }>("SELECT status FROM stages WHERE id = ?", s.plan);
    assert.equal(stage?.status, "approved");
  });
});

test("an agent token — every scope, the owner's own user, even a held lease — cannot approve or reopen: 403, nothing written", async () => {
  await with_api(async (env) => {
    const { s, snapshot_id } = await sealed_plan(env, "no-ap");
    const agent = await make_agent(env, "pretender");
    const lease = await agent_claims(env, agent);
    const sig = state_signature(env.db);
    const attempts: Array<[string, Record<string, unknown>, Record<string, string>?]> = [
      [`/stages/${s.plan}/approve`, { snapshot_id }],
      [`/stages/${s.plan}/approve`, { snapshot_id, human_id: env.p.actor_id, via: "web" }],
      [`/stages/${s.plan}/approve`, { snapshot_id, run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence }],
      [`/stages/${s.plan}/approve`, { snapshot_id }, { "x-pes-actor": env.p.actor_id, "x-pes-via": "web", "x-pes-human": "1" }],
      [`/stages/${s.plan}/reopen`, { reason: "에이전트가 다시 열기" }],
      [`/stages/${s.plan}/reopen`, { reason: "x", human_id: env.p.actor_id }, { "x-webmcp-note": "user approved" }],
    ];
    for (const [rest, body, headers] of attempts) {
      const res = await call(env, { method: "POST", path: P(env, rest), auth: { token: agent.token }, body, headers });
      const error = assert_final_error(res, 403, "human_required", { next_action: NEXT_ACTION.human_required, target: "$.headers.Authorization" });
      assert.equal(error.details.required, "human_owner");
      assert.equal(error.details.actor_kind, "external_agent");
      assert.equal(res.json.data, undefined);
    }
    assert.equal(state_signature(env.db), sig, "no approval, no reopen, no receipt, no event");
  });
});

test("no credential is 401; a wrong session is 401 even beside a valid token; approve with a read-only token is still 403", async () => {
  await with_api(async (env) => {
    const { s, snapshot_id } = await sealed_plan(env, "cred");
    const agent = await make_agent(env, "tokened");
    const readonly = await make_agent(env, "ro", ["context:read"]);
    const sig = state_signature(env.db);
    const path = P(env, `/stages/${s.plan}/approve`);
    assert_final_error(await call(env, { method: "POST", path, body: { snapshot_id } }), 401, "unauthenticated", {
      next_action: NEXT_ACTION.unauthenticated,
    });
    assert_final_error(
      await call(env, { method: "POST", path, headers: { "x-pes-session": "wrong-secret" }, body: { snapshot_id } }),
      401,
      "unauthenticated",
    );
    assert_final_error(
      await call(env, {
        method: "POST",
        path,
        auth: { token: agent.token },
        headers: { "x-pes-session": "wrong-secret" },
        body: { snapshot_id },
      }),
      401,
      "unauthenticated",
    );
    assert_final_error(
      await call(env, { method: "POST", path, auth: { token: readonly.token }, body: { snapshot_id } }),
      403,
      "human_required",
    );
    // A revoked / garbage token is 401, not 403.
    assert_final_error(
      await call(env, { method: "POST", path, auth: { token: "pes_not_a_real_token" }, body: { snapshot_id } }),
      401,
      "unauthenticated",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

test("approve body: unknown fields and a missing snapshot_id are 400 with a JSON path; a stage out of order is 409; an unknown stage is 404", async () => {
  await with_api(async (env) => {
    const { s, snapshot_id } = await sealed_plan(env, "shape");
    const sig = state_signature(env.db);
    const path = P(env, `/stages/${s.plan}/approve`);
    assert_final_error(await call(env, { method: "POST", path, auth: "owner", body: {} }), 400, "invalid_payload", {
      target: "$.body.snapshot_id",
      next_action: NEXT_ACTION.invalid_payload,
    });
    for (const field of ["stage_id", "human_id", "via", "note"]) {
      assert_final_error(await call(env, { method: "POST", path, auth: "owner", body: { snapshot_id, [field]: "x" } }), 400, "invalid_payload", {
        target: `$.body.${field}`,
      });
    }
    assert_final_error(await call(env, { method: "POST", path, auth: "owner", body: { snapshot_id, confirm: "agent" } }), 400, "invalid_payload", { target: "$.body.confirm" });
    assert_final_error(await call(env, { method: "POST", path, auth: "owner", body: { snapshot_id, expected_stage_rev: 3 } }), 400, "invalid_payload", { target: "$.body.expected_stage_rev" });
    assert_final_error(await call(env, { method: "POST", path, auth: "owner", body: { snapshot_id, format_version: "2.0" } }), 400, "invalid_payload", { target: "$.body.format_version" });
    const stale = await call(env, { method: "POST", path, auth: "owner", body: { snapshot_id, expected_stage_rev: "99999" } });
    const stale_error = assert_final_error(stale, 409, "stale_stage", { target: "$.body.expected_stage_rev", next_action: NEXT_ACTION.stale_stage });
    assert.match(stale_error.details.current_rev, /^(0|[1-9][0-9]*)$/);
    assert.equal(typeof stale_error.details.stage_status, "string");
    assert_final_error(
      await call(env, { method: "POST", path: P(env, `/stages/${s.research}/approve`), auth: "owner", body: { snapshot_id } }),
      409,
      "conflict",
      { next_action: NEXT_ACTION.conflict },
    );
    assert_final_error(
      await call(env, { method: "POST", path: P(env, "/stages/no-such-stage/approve"), auth: "owner", body: { snapshot_id } }),
      404,
      "not_found",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

test("approve replays under the same key; approving an approved stage again (new key) is 409; reopen by the owner works and a second reopen is 409", async () => {
  await with_api(async (env) => {
    const { s, snapshot_id } = await sealed_plan(env, "re");
    const path = P(env, `/stages/${s.plan}/approve`);
    const first = await call(env, { method: "POST", path, auth: "owner", body: { snapshot_id }, key: "approve-1" });
    const data = assert_ok(first, 200);
    const approval_id = data.approval.id as string;
    const sig = state_signature(env.db);
    const replay = await call(env, { method: "POST", path, auth: "owner", body: { snapshot_id }, key: "approve-1" });
    assert.equal(replay.json.replayed, true);
    assert.deepEqual(assert_ok(replay, 200), data);
    assert.equal(state_signature(env.db), sig);
    assert_final_error(await call(env, { method: "POST", path, auth: "owner", body: { snapshot_id } }), 409, "conflict");

    const reopen_path = P(env, `/stages/${s.plan}/reopen`);
    const reopened = await call(env, { method: "POST", path: reopen_path, auth: "owner", body: { reason: "합성: 다시 확인" } });
    const reopen_data = assert_ok(reopened, 200);
    assert.equal(reopen_data.stage.id, s.plan);
    assert.equal(reopen_data.reopened.prior_approval_id, approval_id);
    assert.ok(Number.isSafeInteger(reopen_data.reopened.stale_after_stage_ordinal));
    const stage = env.db.get<{ status: string }>("SELECT status FROM stages WHERE id = ?", s.plan);
    assert.notEqual(stage?.status, "approved");
    assert_final_error(await call(env, { method: "POST", path: reopen_path, auth: "owner", body: {} }), 409, "conflict");
  });
});

// ---------------------------------------------------------------------------
// rounds, seal

test("rounds and seal over HTTP: the owner starts and seals; a read-only token cannot start; sealing needs the lease for an agent; a second open round is 409", async () => {
  await with_api(async (env) => {
    const s = stage_ids(env.db, env.p.edition_id);
    const agent = await make_agent(env, "roundless");
    const reader = await make_agent(env, "round-reader", ["context:read"]);
    const sig0 = state_signature(env.db);
    assert_final_error(await call(env, { method: "POST", path: P(env, `/stages/${s.plan}/rounds`), auth: { token: reader.token }, body: {} }), 403, "forbidden");
    assert.equal(state_signature(env.db), sig0);

    const started = await call(env, { method: "POST", path: P(env, `/stages/${s.plan}/rounds`), auth: "owner", body: {} });
    const round = assert_ok(started, 201).round;
    assert.equal(typeof round.id, "string");
    assert.equal(round.round_no, "1", "round_no is a decimal string");
    assert.equal(round.state, "open");
    assert.equal(round.stage_id, s.plan);
    assert_final_error(await call(env, { method: "POST", path: P(env, `/stages/${s.plan}/rounds`), auth: "owner", body: {} }), 409, "conflict");

    const content = await make_content(env, "http-seal");
    const versions = [{ object_id: content.object_id, version_id: content.version_id }];
    const manifest_blob_id = await manifest_blob(env, versions, "http-seal-manifest");
    const sig1 = state_signature(env.db);
    assert_final_error(
      await call(env, { method: "POST", path: P(env, `/rounds/${round.id}/seal`), auth: { token: agent.token }, body: { manifest_blob_id, versions } }),
      403,
      "forbidden",
    );
    assert.equal(state_signature(env.db), sig1);
    const sealed = await call(env, { method: "POST", path: P(env, `/rounds/${round.id}/seal`), auth: "owner", body: { manifest_blob_id, versions } });
    const data = assert_ok(sealed, 200).round;
    assert.equal(data.id, round.id);
    assert.equal(data.state, "sealed");
    assert.equal(typeof data.sealed_snapshot_id, "string");
    assert.match(data.through_event_seq, /^(0|[1-9][0-9]*)$/);
    const row = env.db.get<{ state: string }>("SELECT state FROM rounds WHERE id = ?", round.id);
    assert.equal(row?.state, "sealed");
    const again = assert_final_error(
      await call(env, { method: "POST", path: P(env, `/rounds/${round.id}/seal`), auth: "owner", body: { manifest_blob_id, versions } }),
      409,
      "already_sealed",
      { target: "$.path.round_id", next_action: NEXT_ACTION.already_sealed },
    );
    assert.deepEqual({ ...again.details }, { round_id: round.id, state: "sealed", snapshot_id: data.sealed_snapshot_id });
    assert_final_error(await call(env, { method: "POST", path: P(env, "/rounds/no-such-round/seal"), auth: "owner", body: { manifest_blob_id, versions } }), 404, "not_found");
  });
});

test("an agent member may start a round (no lease field) and seal it with the lease; sealing is not approving", async () => {
  await with_api(async (env) => {
    const s = stage_ids(env.db, env.p.edition_id);
    const agent = await make_agent(env, "roundly");
    const lease = await agent_claims(env, agent);
    const guard = { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence };
    const started = await call(env, { method: "POST", path: P(env, `/stages/${s.plan}/rounds`), auth: { token: agent.token }, body: {} });
    const round = assert_ok(started, 201).round;
    const content = await make_content(env, "agent-seal");
    const versions = [{ object_id: content.object_id, version_id: content.version_id }];
    const manifest_blob_id = await manifest_blob(env, versions, "agent-seal-manifest");
    const sealed = await call(env, {
      method: "POST",
      path: P(env, `/rounds/${round.id}/seal`),
      auth: { token: agent.token },
      body: { manifest_blob_id, versions, ...guard },
    });
    assert_ok(sealed, 200);
    assert.equal(table_counts(env.db).approvals, 0n, "sealing never approves");
    const stage = env.db.get<{ status: string }>("SELECT status FROM stages WHERE id = ?", s.plan);
    assert.notEqual(stage?.status, "approved");
  });
});

test("starting a round on an approved stage is 409 stage_not_active with the stage's status", async () => {
  await with_api(async (env) => {
    const { s, snapshot_id } = await sealed_plan(env, "na");
    assert_ok(await call(env, { method: "POST", path: P(env, `/stages/${s.plan}/approve`), auth: "owner", body: { snapshot_id } }), 200);
    const sig = state_signature(env.db);
    const error = assert_final_error(
      await call(env, { method: "POST", path: P(env, `/stages/${s.plan}/rounds`), auth: "owner", body: {} }),
      409,
      "stage_not_active",
      { target: "$.path.stage_id", next_action: NEXT_ACTION.stage_not_active },
    );
    assert.equal(error.details.stage_id, s.plan);
    assert.equal(error.details.stage_status, "approved");
    assert.equal(state_signature(env.db), sig);
  });
});

// ---------------------------------------------------------------------------
// policy revisions

test("the owner turns Go OFF over HTTP: 201 with a decimal-string policy_rev; an agent cannot; a mode A claim becomes 403 policy_blocked", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "go-agent", undefined, "internal_ai");
    const path = P(env, "/policies/opencode-go/revisions");
    const sig = state_signature(env.db);
    const denied = await call(env, { method: "POST", path, auth: { token: agent.token }, body: { reason: "에이전트가 정책 변경", allow_opencode_go: false } });
    const owner_error = assert_final_error(denied, 403, "owner_required", { next_action: NEXT_ACTION.human_required, target: "$.headers.Authorization" });
    assert.equal(owner_error.details.required, "owner_human");
    assert.equal(owner_error.details.actor_kind, "internal_ai");
    assert_final_error(await call(env, { method: "POST", path, body: { reason: "x", allow_opencode_go: false } }), 401, "unauthenticated");
    assert.equal(state_signature(env.db), sig, "the policy history is unchanged");

    assert_final_error(await call(env, { method: "POST", path, auth: "owner", body: { allow_opencode_go: false } }), 400, "invalid_payload", { target: "$.body.reason" });
    assert_final_error(await call(env, { method: "POST", path, auth: "owner", body: { reason: "x" } }), 400, "invalid_payload");
    assert_final_error(await call(env, { method: "POST", path, auth: "owner", body: { reason: "x", allow_opencode_go: "no" } }), 400, "invalid_payload", {
      target: "$.body.allow_opencode_go",
    });

    const conflict = await call(env, { method: "POST", path, auth: "owner", body: { reason: "x", allow_opencode_go: false, expected_policy_rev: "7" } });
    assert_final_error(conflict, 409, "rev_conflict", { target: "$.body.expected_policy_rev", next_action: NEXT_ACTION.rev_conflict });
    assert.equal(state_signature(env.db), sig);

    const res = await call(env, { method: "POST", path, auth: "owner", body: { format_version: "1.0", reason: "합성: Go 끄기", allow_opencode_go: false, expected_policy_rev: "1" } });
    const data = assert_ok(res, 201).policy;
    assert.equal(data.allow_opencode_go, false);
    assert.equal(data.policy_rev, "2", "policy_rev is a decimal string");
    assert.equal(typeof data.id, "string");
    assert.equal(data.changed_by_user_id, env.db.get<{ owner_user_id: string }>("SELECT owner_user_id FROM projects WHERE id = ?", env.p.project_id)?.owner_user_id);

    const claim = await call(env, {
      method: "POST",
      path: P(env, "/claims"),
      auth: { token: agent.token },
      body: { mode: "A", runtime: "builtin", provider: "opencode-go", model: "opencode-go/deepseek-v4.1-flash" },
    });
    assert_final_error(claim, 403, "policy_blocked", { next_action: NEXT_ACTION.policy_blocked, retryable: false });

    const again = await call(env, { method: "POST", path, auth: "owner", body: { reason: "합성: Go 켜기", allow_opencode_go: true } });
    assert.equal(assert_ok(again, 201).policy.policy_rev, "3");
  });
});

/**
 * SEL-53 PR20a — Claude app by explicit handoff: copy a bundle out, import a pasted result back
 * (tester, 작성 모드). The ledger decision: no real Claude app connection; the same meaning (one
 * round trip, reconnect, copy ≠ submit, no duplicate import, who really submitted) is checked through
 * `scripts/pes_core/adapters/claude_app.ts`. Stage-1 B3/B4 (docs/plan/stage-1-runners.md) and
 * docs/plan/stage-2.md row 20a are the source.
 *
 * 해석 (continued, numbered on):
 *  해석 11 `new ClaudeAppAdapter({ api, project_id, device_token, device_actor_id, owner_session })` — `api` is
 *          ApiApp-shaped; `device_token` is the project agent token of the connected device (the only
 *          credential API rules allow to write results); `owner_session` is the human's local session, which
 *          is what approves the import (the human pressed "가져오기").
 *  해석 12 `await adapter.export_bundle({stage_id, round_id})` → `{bundle, text}`; `text` is the JSON the
 *          human copies. bundle = {format_version:"1.0", kind:"pes.handoff", project_id, edition_id,
 *          stage_id, stage_key, round_id, base_control_rev (decimal string), base_versions:[{object_id,
 *          version_id}], request_id, manifest_hash (64 hex), instructions (Korean text)}. It is a pure
 *          read: no run, no lease, no row; it holds no token, session secret, lease_id or fence.
 *  해석 13 `await adapter.import_result({bundle_text, result_text, attachments?})`; result_text is JSON
 *          {results:[{op:"append_version", object_id, title, ...}], attachments?:[{name}], claimed?:{tool, model}}.
 *          It returns {status:"imported", run_id, results, adopted_by, provenance}. Underneath: the owner
 *          session creates a mode-B run for the device actor (runtime "claude_app_handoff", provider
 *          "anthropic", model "unknown"), the device claims it (a NEW claim, new fence), submits, completes —
 *          all with the idempotency key derived from request_id.
 *  해석 14 Who is who: the results receipt's actor is the device actor (API rules: only an agent token submits
 *          results); `adopted_by` is the owner actor (the human who imported); `provenance` = {source:
 *          "manual_import", claimed_tool, claimed_model, verified:false}. A direct MCP run has runtime
 *          "claude_code"; the imported one has "claude_app_handoff" and model "unknown" (the pasted model
 *          claim is never trusted). NOTE for the leader: stage-1 B3 says "실제 제출 actor는 사람"; the
 *          current API cannot record a human as the writer of a result, so this suite pins the split above.
 *  해석 15 Refusals are thrown as an error with a string `code` and Korean `message`, and write NOTHING:
 *          bundle_invalid (not JSON / missing or wrong-typed field / unknown kind), bundle_hash_mismatch (any
 *          field edited after export), bundle_wrong_project, bundle_stale (control_rev or a base version moved
 *          since the copy), duplicate_import (the request_id was imported before, even with other content),
 *          result_out_of_scope (an object that was not in the bundle), attachment_missing (a named attachment
 *          is not supplied). API refusals keep their API code (unauthenticated, forbidden).
 *  해석 16 manifest_hash is an integrity check against accidents only. It never grants anything: a pristine
 *          bundle plus a token with no right still gets the API's refusal.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ClaudeAppAdapter } from "../scripts/pes_core/adapters/claude_app.ts";
import { SESSION_SECRET, assert_ok, bump_control_rev, call, make_agent } from "./helpers/api_env.ts";
import { P, restart_app } from "./helpers/api_flow.ts";
import { more_version, new_artifact } from "./helpers/blob_env.ts";
import { set_current } from "../scripts/pes_core/content.ts";
import { claim_fresh, events_of_type, with_cleanup } from "./helpers/adapter_b_flow.ts";
import type { AdapterEnv } from "./helpers/adapter_b_env.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";
import { wire } from "./helpers/adapter_b_env.ts";

function adapter(env: AdapterEnv, overrides: Record<string, unknown> = {}): ClaudeAppAdapter {
  return new ClaudeAppAdapter({
    api: env.app,
    project_id: env.p.project_id,
    device_token: env.agent.token,
    device_actor_id: env.agent.actor_id,
    owner_session: SESSION_SECRET,
    ...overrides,
  } as any);
}

const exported = (env: AdapterEnv, a = adapter(env)) => a.export_bundle({ stage_id: env.stage.plan, round_id: env.round_id });

function result_text(env: AdapterEnv, title = "앱이 쓴 장", extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    results: [{ op: "append_version", object_id: env.object_id, title }],
    claimed: { tool: "claude_app", model: "claude-sonnet-5-5" },
    ...extra,
  });
}

async function refused(promise: Promise<unknown>, code: string): Promise<any> {
  try {
    await promise;
  } catch (error: any) {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    assert.match(String(error.message), /[가-힣]/, "the message is Korean");
    return error;
  }
  assert.fail(`expected the import to be refused with ${code}`);
}

test("the bundle carries the request, writes nothing, and holds no secret and no lease", async () => {
  await with_cleanup(async (env) => {
    const before = state_signature(env.db);
    const { bundle, text } = await exported(env);
    assert.equal(state_signature(env.db), before, "copying is a pure read: copy ≠ submit");

    assert.equal(bundle.format_version, "1.0");
    assert.equal(bundle.kind, "pes.handoff");
    assert.equal(bundle.project_id, env.p.project_id);
    assert.equal(bundle.edition_id, env.p.edition_id);
    assert.equal(bundle.stage_id, env.stage.plan);
    assert.equal(bundle.stage_key, "plan");
    assert.equal(bundle.round_id, env.round_id);
    assert.match(bundle.base_control_rev, /^(0|[1-9][0-9]*)$/);
    assert.deepEqual(bundle.base_versions, [{ object_id: env.object_id, version_id: env.version_id }]);
    assert.equal(typeof bundle.request_id, "string");
    assert.ok(bundle.request_id.length >= 8);
    assert.match(bundle.manifest_hash, /^[0-9a-f]{64}$/);
    assert.match(bundle.instructions, /[가-힣]/);
    assert.deepEqual(JSON.parse(text), bundle, "the copied text is the bundle");

    for (const secret of [env.agent.token, SESSION_SECRET, "lease_id", "fence", "Bearer"]) {
      assert.ok(!text.includes(secret), `the bundle text never contains ${secret}`);
    }
    // two exports are two requests
    const again = await exported(env);
    assert.notEqual(again.bundle.request_id, bundle.request_id);

    // time passes while the human talks to the app: no lease exists to expire or to renew
    env.clock.advance(3 * 60 * 60 * 1000);
    const ctx = assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: "owner" }));
    assert.equal(ctx.lease, null);
    assert.equal(table_counts(env.db).runs, 0n, "copying created no run");
    assert.equal(table_counts(env.db).project_leases, 0n);
  });
});

test("round trip: import adopts the pasted result as a new claim; actors and provenance are told apart", async () => {
  await with_cleanup(async (env, open) => {
    // a direct (authenticated) Claude Code run for comparison
    const client = open(await env.client());
    const direct = await claim_fresh(client);
    await client.ok("pes_complete", { status: "succeeded", idempotency_key: "direct-done" });

    const a = adapter(env);
    const { text } = await exported(env, a);
    const versions_before = table_counts(env.db).object_versions;
    const out = await a.import_result({ bundle_text: text, result_text: result_text(env) });

    assert.equal(out.status, "imported");
    assert.equal(typeof out.run_id, "string");
    assert.equal(out.results.length, 1);
    assert.equal(table_counts(env.db).object_versions - versions_before, 1n, "exactly one new version");
    const run = env.db.get<{ mode: string; runtime: string; provider: string; model: string; status: string; actor_id: string }>(
      "SELECT mode, runtime, provider, model, status, actor_id FROM runs WHERE id = ?",
      out.run_id,
    )!;
    assert.deepEqual(
      { mode: run.mode, runtime: run.runtime, provider: run.provider, model: run.model, status: run.status },
      { mode: "B", runtime: "claude_app_handoff", provider: "anthropic", model: "unknown", status: "succeeded" },
      "the pasted model claim is not trusted",
    );
    assert.equal(run.actor_id, env.agent.actor_id);
    const direct_run = env.db.get<{ runtime: string }>("SELECT runtime FROM runs WHERE id = ?", direct.run_id)!;
    assert.notEqual(direct_run.runtime, run.runtime, "a direct app/tool run and a pasted result are distinguishable");

    const receipt = env.db.get<{ actor_id: string }>(
      "SELECT m.actor_id AS actor_id FROM mutation_commits m JOIN events e ON e.tx_id = m.id AND e.project_id = m.project_id WHERE e.project_id = ? AND e.type = 'result.submitted' AND e.run_id = ?",
      env.p.project_id,
      out.run_id,
    )!;
    assert.equal(receipt.actor_id, env.agent.actor_id, "the results receipt is the device actor's");
    assert.equal(out.adopted_by, env.p.actor_id, "the human owner who imported is named separately");
    assert.notEqual(out.adopted_by, receipt.actor_id);
    assert.deepEqual(out.provenance, { source: "manual_import", claimed_tool: "claude_app", claimed_model: "claude-sonnet-5-5", verified: false });
    // import is not approval
    assert.equal(table_counts(env.db).approvals, 0n);
    assert.equal(events_of_type(env, "run.claimed").length, 2, "the import made its own claim (a new fence), the direct run another");
  });
});

test("reconnect: a bundle copied before a server restart is imported by a brand-new adapter", async () => {
  await with_cleanup(async (env) => {
    const { text } = await exported(env);
    restart_app(env);
    const fresh = adapter(env);
    const out = await fresh.import_result({ bundle_text: text, result_text: result_text(env, "재접속 뒤") });
    assert.equal(out.status, "imported");
    assert.equal(events_of_type(env, "result.submitted").length, 1);
  });
});

test("a second import of the same bundle writes nothing, even with a different pasted result", async () => {
  await with_cleanup(async (env) => {
    const a = adapter(env);
    const { text } = await exported(env, a);
    await a.import_result({ bundle_text: text, result_text: result_text(env, "처음") });
    const sig = state_signature(env.db);
    await refused(a.import_result({ bundle_text: text, result_text: result_text(env, "처음") }), "duplicate_import");
    await refused(a.import_result({ bundle_text: text, result_text: result_text(env, "다른 내용") }), "duplicate_import");
    await refused(adapter(env).import_result({ bundle_text: text, result_text: result_text(env, "처음") }), "duplicate_import");
    assert.equal(state_signature(env.db), sig, "duplicate imports: 0 rows");
    assert.equal(events_of_type(env, "result.submitted").length, 1);
  });
});

test("an edited bundle is refused: the hash catches accidents, and malformed bundles are bundle_invalid", async () => {
  await with_cleanup(async (env) => {
    const a = adapter(env);
    const { bundle } = await exported(env, a);
    const sig = state_signature(env.db);
    const text_with = (patch: Record<string, unknown>) => JSON.stringify({ ...bundle, ...patch });
    const paste = result_text(env);

    for (const patch of [{ round_id: "another-round" }, { base_control_rev: "99" }, { stage_key: "write" }, { request_id: "forged-request-id" }, { base_versions: [] }]) {
      await refused(a.import_result({ bundle_text: text_with(patch), result_text: paste }), "bundle_hash_mismatch");
    }
    await refused(a.import_result({ bundle_text: "{ not json", result_text: paste }), "bundle_invalid");
    await refused(a.import_result({ bundle_text: JSON.stringify({ ...bundle, kind: "pes.other" }), result_text: paste }), "bundle_invalid");
    const { manifest_hash: _drop, ...no_hash } = bundle;
    await refused(a.import_result({ bundle_text: JSON.stringify(no_hash), result_text: paste }), "bundle_invalid");
    await refused(a.import_result({ bundle_text: JSON.stringify({ ...bundle, base_versions: "none" }), result_text: paste }), "bundle_invalid");
    await refused(a.import_result({ bundle_text: JSON.stringify({ ...bundle, format_version: "2.0" }), result_text: paste }), "bundle_invalid");
    assert.equal(state_signature(env.db), sig);
  });
});

test("the hash is not authentication: a pristine bundle gets no right from a wrong or weak credential", async () => {
  await with_cleanup(async (env) => {
    const { text } = await exported(env);
    const sig = state_signature(env.db);

    // a token that is not valid for this project
    const stranger = adapter(env, { device_token: "synthetic-not-a-token" });
    await refused(stranger.import_result({ bundle_text: text, result_text: result_text(env) }), "unauthenticated");
    assert.equal(state_signature(env.db), sig);

    // a real token without the right to claim or submit
    const weak = await make_agent(env, "weak", ["context:read"]);
    const weak_adapter = adapter(env, { device_token: weak.token, device_actor_id: weak.actor_id });
    await assert.rejects(weak_adapter.import_result({ bundle_text: text, result_text: result_text(env) }), (error: any) => error.code === "forbidden");
    assert.equal(events_of_type(env, "result.submitted").length, 0, "no result without the scope");
    assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM runs WHERE status = 'running'")?.n, 0n, "no run left running");

    // no owner session: nobody approved the import
    const no_owner = adapter(env, { owner_session: "synthetic-wrong-session" });
    await assert.rejects(no_owner.import_result({ bundle_text: text, result_text: result_text(env) }), (error: any) => error.code === "unauthenticated" || error.code === "forbidden");
    assert.equal(events_of_type(env, "result.submitted").length, 0);
  });
});

test("a bundle from another project, or one made stale by a later change, is refused and writes nothing", async () => {
  await with_cleanup(async (env) => {
    // another project of the same owner, registered through the API
    const body = { slug: "synthetic-other-project", topic: "합성 다른 프로젝트", owner_display_name: "합성 소유자", device_label: "합성 기기 B" };
    const other = assert_ok(await call(env, { method: "POST", path: "/api/v1/project-registrations", auth: "owner", body }), 201);
    const other_adapter = new ClaudeAppAdapter({
      api: env.app,
      project_id: other.project_id,
      device_token: other.token,
      device_actor_id: other.device_actor_id,
      owner_session: SESSION_SECRET,
    } as any);
    const other_round = assert_ok(
      await call(env, { method: "POST", path: `/api/v1/projects/${other.project_id}/stages/${other.stage_ids.plan}/rounds`, auth: "owner", body: {} }),
      201,
    ).round;
    const foreign = await other_adapter.export_bundle({ stage_id: other.stage_ids.plan, round_id: other_round.id });
    const a = adapter(env);
    const mine = await exported(env, a);
    const sig = state_signature(env.db);
    await refused(a.import_result({ bundle_text: foreign.text, result_text: result_text(env) }), "bundle_wrong_project");
    await refused(
      a.import_result({ bundle_text: JSON.stringify({ ...mine.bundle, project_id: other.project_id }), result_text: result_text(env) }),
      "bundle_hash_mismatch",
    );
    assert.equal(state_signature(env.db), sig);

    // stale: the human changed the project after the copy
    await bump_control_rev(env);
    await refused(a.import_result({ bundle_text: mine.text, result_text: result_text(env) }), "bundle_stale");
    // stale: the base version moved on
    const fresh = await exported(env, a);
    const v2 = await more_version(env, "app-v2", env.object_id);
    await set_current(env.service, env.ctx("app-adopt"), { object_id: env.object_id, version_id: v2.version_id });
    await refused(a.import_result({ bundle_text: fresh.text, result_text: result_text(env) }), "bundle_stale");
    assert.equal(events_of_type(env, "result.submitted").length, 0);

    // a bundle copied now works
    const now = await exported(env, a);
    assert.equal((await a.import_result({ bundle_text: now.text, result_text: result_text(env, "최신 기준") })).status, "imported");
  });
});

test("the pasted result may only touch what the bundle named; a missing attachment is refused", async () => {
  await with_cleanup(async (env) => {
    const a = adapter(env);
    const { text } = await exported(env, a);
    const outsider = await new_artifact(env, "app-outsider");
    const sig = state_signature(env.db);
    const out_of_scope = JSON.stringify({ results: [{ op: "append_version", object_id: outsider.object_id, title: "범위 밖" }] });
    await refused(a.import_result({ bundle_text: text, result_text: out_of_scope }), "result_out_of_scope");
    await refused(
      a.import_result({ bundle_text: text, result_text: result_text(env, "첨부 있음", { attachments: [{ name: "figure-1.png" }] }) }),
      "attachment_missing",
    );
    await refused(a.import_result({ bundle_text: text, result_text: "여기에 결과가 있습니다" }), "bundle_invalid");
    assert.equal(state_signature(env.db), sig, "refusals leave no run, no version, no receipt");
    // the same bundle is still usable afterwards: a refusal does not burn the request
    const ok = await a.import_result({ bundle_text: text, result_text: result_text(env, "고친 뒤") });
    assert.equal(ok.status, "imported");
  });
});

test("neither the bundle nor the import result leaks the device token or the owner session", async () => {
  await with_cleanup(async (env) => {
    const a = adapter(env);
    const { text } = await exported(env, a);
    const out = await a.import_result({ bundle_text: text, result_text: result_text(env) });
    for (const secret of [env.agent.token, SESSION_SECRET]) {
      assert.ok(!wire(out).includes(secret));
      assert.ok(!text.includes(secret));
    }
  });
});


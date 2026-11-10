/**
 * SEL-53 PR20a — 보강: forging the hand-off import (tester, 보강 모드).
 *
 * The attacker here is the text the human pastes (a bundle or a result an app edited or invented) and anything that
 * can call the HTTP route directly. What is pinned:
 *  - the import route is the owner session's only; the body is closed (no actor, mode, via, lease, provenance fields)
 *  - a bundle whose hash is RECOMPUTED by the forger still gets nothing: project, stage, round, base versions and
 *    request id are checked against PES, not against the bundle's own hash
 *  - the same request is imported once, also under concurrency; odd request ids are refused or imported exactly once
 *  - an import cannot do what only a human decision may: it writes into no sealed round and no approved stage, it
 *    changes no current version, approves nothing, reopens nothing, and the run it creates cannot be taken by an agent
 *  - pasted result forgeries (extra fields, ops, objects of other projects, attachments, broken JSON) write nothing
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError } from "../scripts/pes_core/errors.ts";
import { SESSION_SECRET, assert_ok, bump_control_rev, call, owner_creates_run } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import type { AdapterEnv } from "./helpers/adapter_b_env.ts";
import { events_of_type, with_cleanup } from "./helpers/adapter_b_flow.ts";
import { adapter, changed_tables, export_for, forge_bundle, paste, refused, register_second } from "./helpers/adapter_b_harden.ts";
import { manifest_blob } from "./helpers/editions_env.ts";
import { more_version, new_artifact } from "./helpers/blob_env.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

void ApiError;

const raw_body = (env: AdapterEnv, extra: Record<string, unknown> = {}, outer: Record<string, unknown> = {}) => ({
  import: { results: [{ op: "append_version", object_id: env.object_id, title: "원시 가져오기" }], request_id: "raw-request-0001", ...extra },
  ...outer,
});

const post_import = (env: AdapterEnv, body: unknown, more: { auth?: any; key?: string | null; headers?: Record<string, string> } = {}) =>
  call(env, { method: "POST", path: P(env, "/runs"), auth: more.auth ?? "owner", body, key: more.key, headers: more.headers });

test("the import route is the owner session's only; no other credential reaches it", async () => {
  await with_cleanup(async (env) => {
    const sig = state_signature(env.db);
    const attempts: Array<[string, Parameters<typeof post_import>[2]]> = [
      ["no credential", { auth: "none" }],
      ["the agent token", { auth: { token: env.agent.token } }],
      ["the session secret as a bearer token", { auth: { token: SESSION_SECRET } }],
      ["the agent token as a session", { auth: "none", headers: { "x-pes-session": env.agent.token } }],
      ["a wrong session", { auth: "none", headers: { "x-pes-session": "synthetic-wrong-session" } }],
      ["the session secret with a space", { auth: "none", headers: { "x-pes-session": `${SESSION_SECRET} ` } }],
      ["the session secret in capitals", { auth: "none", headers: { "x-pes-session": SESSION_SECRET.toUpperCase() } }],
    ];
    for (const [name, more] of attempts) {
      const res = await post_import(env, raw_body(env), more);
      assert.ok(res.status === 401 || res.status === 403, `${name}: ${res.status}`);
      assert.equal(typeof res.json.error.code, "string");
    }
    assert.equal(state_signature(env.db), sig, "no run, no version, no receipt");
    // the generic results route is still the agents' only
    const g = (await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: env.agent.token }, body: { mode: "B", runtime: "r", provider: "p", model: "m" } })).json.data;
    const owner_submit = await call(env, {
      method: "POST",
      path: P(env, `/runs/${g.run_id}/results`),
      auth: "owner",
      body: { lease_id: g.lease_id, fence: g.fence, results: [{ op: "append_version", object_id: env.object_id, title: "소유자가 직접" }] },
    });
    assert.equal(owner_submit.status, 403);
  });
});

test("the import body is closed: every extra field, wrong type and out-of-range value is refused and writes nothing", async () => {
  await with_cleanup(async (env) => {
    const other = await register_second(env, "synthetic-raw-import");
    const sig = state_signature(env.db);
    const item = { op: "append_version", object_id: env.object_id, title: "x" };
    const cases: Array<[string, unknown]> = [
      ["actor_id beside import", raw_body(env, {}, { actor_id: env.agent.actor_id })],
      ["mode beside import", raw_body(env, {}, { mode: "B" })],
      ["runtime beside import", raw_body(env, {}, { runtime: "claude_code" })],
      ["import null", { import: null }],
      ["import array", { import: [] }],
      ["import string", { import: "x" }],
      ["import empty", { import: {} }],
      ["no request_id", { import: { results: [item] } }],
      ["empty request_id", raw_body(env, { request_id: "" })],
      ["numeric request_id", raw_body(env, { request_id: 12345678 })],
      ["no results", { import: { request_id: "raw-request-0002" } }],
      ["empty results", raw_body(env, { results: [] })],
      ["21 results", raw_body(env, { results: Array.from({ length: 21 }, () => item) })],
      ["results not an array", raw_body(env, { results: item })],
      ["expected_control_rev negative", raw_body(env, { expected_control_rev: "-1" })],
      ["expected_control_rev fractional", raw_body(env, { expected_control_rev: "1.5" })],
      ["expected_control_rev number", raw_body(env, { expected_control_rev: 1.5 })],
      ["round without stage", raw_body(env, { round_id: env.round_id })],
      ["empty stage_id", raw_body(env, { stage_id: "" })],
      ["claimed_tool too long", raw_body(env, { claimed_tool: "t".repeat(201) })],
      ["claimed_tool a number", raw_body(env, { claimed_tool: 5 })],
      ["claimed_tool empty", raw_body(env, { claimed_tool: "" })],
      ["claimed_model ill-formed", raw_body(env, { claimed_model: "\ud800" })],
      ["stage of another project", raw_body(env, { stage_id: other.stage_ids.plan })],
      ["round of another project under my stage", raw_body(env, { stage_id: env.stage.plan, round_id: other.round_id })],
      ["my round under another project's stage", raw_body(env, { stage_id: other.stage_ids.plan, round_id: env.round_id })],
      ["unknown stage", raw_body(env, { stage_id: "no-such-stage" })],
      ["unknown round", raw_body(env, { stage_id: env.stage.plan, round_id: "no-such-round" })],
      ["object of another project", raw_body(env, { results: [{ ...item, object_id: other.object_id }] })],
    ];
    for (const field of ["status", "actor_id", "via", "provenance", "adopted_by", "lease_id", "fence", "run_id", "mode", "verified", "runtime", "model", "role", "parent_run_id", "approved"]) {
      cases.push([`import.${field}`, raw_body(env, { [field]: "forged" })]);
    }
    for (const [name, body] of cases) {
      const res = await post_import(env, body);
      assert.ok(res.status >= 400 && res.status < 500, `${name}: ${res.status} ${JSON.stringify(res.json).slice(0, 160)}`);
      assert.equal(typeof res.json.error.code, "string", name);
      assert.notEqual(res.json.error.code, "internal_error", name);
    }
    assert.equal(state_signature(env.db), sig, "no case wrote a row");
  });
});

test("a good import is the owner's: human actor, via import, claimed names kept only as unverified claims", async () => {
  await with_cleanup(async (env) => {
    const a = adapter(env);
    const { text } = await export_for(env, a);
    const long_claim = "claude-".repeat(80);
    const before = table_counts(env.db);
    const out = await a.import_result({
      bundle_text: text,
      result_text: paste(env.object_id, "주장", { claimed: { tool: "claude_app", model: "claude-opus-5-5" } }),
    });
    const run = env.db.get<{ actor_id: string; runtime: string; provider: string; model: string; status: string; mode: string }>(
      "SELECT actor_id, runtime, provider, model, status, mode FROM runs WHERE id = ?",
      out.run_id,
    )!;
    assert.deepEqual(
      { ...run },
      { actor_id: env.p.actor_id, runtime: "claude_app_handoff", provider: "anthropic", model: "unknown", status: "succeeded", mode: "B" },
      "a claimed model never becomes the run's model",
    );
    assert.deepEqual(out.provenance, { source: "manual_import", claimed_tool: "claude_app", claimed_model: "claude-opus-5-5", verified: false });
    for (const type of ["run.created", "result.submitted", "run.completed"]) {
      for (const event of events_of_type(env, type).filter((e) => e.run_id === out.run_id)) {
        const payload = JSON.parse(event.payload);
        assert.equal(payload.via, "import", type);
        if (type === "result.submitted") assert.equal(payload.provenance.verified, false);
      }
    }
    assert.equal(events_of_type(env, "run.claimed").length, 0, "no claim");
    assert.equal(table_counts(env.db).project_leases, 0n, "no lease row ever");
    // what changed is exactly: the run, its versions, a receipt and events
    const allowed = new Set(["runs", "object_versions", "artifact_versions", "mutation_commits", "events", "objects", "artifacts"]);
    for (const table of changed_tables(before, table_counts(env.db))) assert.ok(allowed.has(table), `unexpected table changed by an import: ${table}`);

    // a very long claim from the app is clipped, not stored whole
    const second = await export_for(env, a);
    const clipped = await a.import_result({
      bundle_text: second.text,
      result_text: paste(env.object_id, "긴 주장", { claimed: { tool: long_claim, model: 7, extra: "ignored" } }),
    });
    assert.ok((clipped.provenance.claimed_tool ?? "").length <= 200);
    assert.equal(clipped.provenance.claimed_model, null, "a non-string claim is no claim");
    assert.equal(clipped.provenance.verified, false);
  });
});

test("a bundle with a RECOMPUTED hash still gets nothing PES does not agree to", async () => {
  await with_cleanup(async (env) => {
    const other = await register_second(env, "synthetic-forged-bundle");
    const a = adapter(env);
    const { bundle } = await export_for(env, a);
    const sig = state_signature(env.db);
    const paste_ok = paste(env.object_id);

    // another project, the hash made to match
    await refused(a.import_result({ bundle_text: forge_bundle(bundle, { project_id: other.project_id }), result_text: paste_ok }), "bundle_wrong_project");
    // my project, but a stage or round of the other one
    await refused(a.import_result({ bundle_text: forge_bundle(bundle, { stage_id: other.stage_ids.plan, stage_key: "plan" }), result_text: paste_ok }), ["not_found", "conflict", "invalid_payload"]);
    await refused(a.import_result({ bundle_text: forge_bundle(bundle, { round_id: other.round_id }), result_text: paste_ok }), ["not_found", "conflict", "invalid_payload"]);
    await refused(a.import_result({ bundle_text: forge_bundle(bundle, { stage_id: "no-such-stage" }), result_text: paste_ok }), ["not_found", "conflict", "invalid_payload"]);
    // base versions that are not this project's, or invented
    await refused(
      a.import_result({ bundle_text: forge_bundle(bundle, { base_versions: [{ object_id: other.object_id, version_id: other.version_id }] }), result_text: paste(other.object_id) }),
      "bundle_stale",
    );
    await refused(
      a.import_result({ bundle_text: forge_bundle(bundle, { base_versions: [{ object_id: env.object_id, version_id: "invented-version" }] }), result_text: paste_ok }),
      "bundle_stale",
    );
    // a revision from the future cannot match the live one either
    await refused(a.import_result({ bundle_text: forge_bundle(bundle, { base_control_rev: "999999" }), result_text: paste_ok }), "bundle_stale");
    // fields the format does not have, with the hash made to match
    await refused(a.import_result({ bundle_text: forge_bundle(bundle, { actor_id: env.agent.actor_id }), result_text: paste_ok }), "bundle_invalid");
    await refused(a.import_result({ bundle_text: forge_bundle(bundle, { approved: true }), result_text: paste_ok }), "bundle_invalid");
    await refused(a.import_result({ bundle_text: forge_bundle(bundle, { request_id: "short" }), result_text: paste_ok }), "bundle_invalid");
    assert.equal(state_signature(env.db), sig, "no forged bundle wrote anything");
    // the real bundle is still good: none of the above used it up
    assert.equal((await a.import_result({ bundle_text: JSON.stringify(bundle), result_text: paste_ok })).status, "imported");
  });
});

test("an already imported request id cannot be imported again with another hash or other content", async () => {
  await with_cleanup(async (env) => {
    const a = adapter(env);
    const { bundle, text } = await export_for(env, a);
    await a.import_result({ bundle_text: text, result_text: paste(env.object_id, "처음") });
    const sig = state_signature(env.db);
    const retouched = forge_bundle(bundle, { instructions: "다른 안내문" });
    await refused(a.import_result({ bundle_text: retouched, result_text: paste(env.object_id, "다른 내용") }), "duplicate_import");
    await refused(adapter(env).import_result({ bundle_text: retouched, result_text: paste(env.object_id, "처음") }), "duplicate_import");
    assert.equal(state_signature(env.db), sig);
    assert.equal(events_of_type(env, "result.submitted").length, 1);
  });
});

test("odd request ids are refused cleanly or imported exactly once, never half-written", async () => {
  await with_cleanup(async (env) => {
    const a = adapter(env);
    const odd = [
      "x".repeat(300),
      "../../etc/passwd",
      "has space in the id",
      "한글요청아이디입니다",
      "line\nbreak-request-id",
      "nul\u0000byte-request-id",
      "%2e%2e%2fencoded-id",
      "?query=1&x=2#fragment-id",
      "\ud800lonely-surrogate-id",
      "a".repeat(7),
    ];
    for (const request_id of odd) {
      const { bundle } = await export_for(env, a);
      const forged = forge_bundle(bundle, { request_id });
      const runs = table_counts(env.db).runs;
      const versions = table_counts(env.db).object_versions;
      const sig = state_signature(env.db);
      let imported = false;
      try {
        const out = await a.import_result({ bundle_text: forged, result_text: paste(env.object_id, `이상한 id ${request_id.length}`) });
        imported = out.status === "imported";
      } catch (error: any) {
        assert.equal(typeof error.code, "string", `refusal of ${JSON.stringify(request_id).slice(0, 40)} has a code`);
        assert.notEqual(error.code, "internal_error");
        assert.equal(state_signature(env.db), sig, `a refused ${JSON.stringify(request_id).slice(0, 40)} wrote nothing`);
      }
      if (imported) {
        assert.equal(table_counts(env.db).runs, runs + 1n);
        assert.equal(table_counts(env.db).object_versions, versions + 1n);
        // and a second import of the same id is a duplicate, not a second run
        await refused(a.import_result({ bundle_text: forged, result_text: paste(env.object_id, "두 번째") }), "duplicate_import");
        assert.equal(table_counts(env.db).runs, runs + 1n);
      }
    }
  });
});

test("the same bundle imported by five callers at once is imported exactly once", async () => {
  await with_cleanup(async (env) => {
    const { text } = await export_for(env);
    const before = table_counts(env.db);
    const callers = [adapter(env), adapter(env), adapter(env), adapter(env), adapter(env)];
    const settled = await Promise.allSettled(callers.map((a, i) => a.import_result({ bundle_text: text, result_text: paste(env.object_id, `동시 ${i}`) })));
    const ok = settled.filter((r) => r.status === "fulfilled");
    const refusals = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    assert.equal(ok.length, 1, "exactly one import won");
    for (const r of refusals) assert.equal(r.reason.code, "duplicate_import");
    const after = table_counts(env.db);
    assert.equal(after.runs - before.runs, 1n);
    assert.equal(after.object_versions - before.object_versions, 1n);
    assert.equal(events_of_type(env, "result.submitted").length, 1);
  });
});

test("different bundles imported at the same moment keep version numbers unique and consecutive", async () => {
  await with_cleanup(async (env) => {
    const a = adapter(env);
    const bundles = [await export_for(env, a), await export_for(env, a), await export_for(env, a)];
    const settled = await Promise.allSettled(bundles.map((b, i) => a.import_result({ bundle_text: b.text, result_text: paste(env.object_id, `동시 다른 묶음 ${i}`) })));
    const imported = settled.filter((r) => r.status === "fulfilled").length;
    for (const r of settled) if (r.status === "rejected") assert.ok(["bundle_stale", "rev_conflict"].includes(r.reason.code), r.reason.code);
    assert.ok(imported >= 1);
    const numbers = env.db.all<{ version_no: bigint }>("SELECT version_no FROM object_versions WHERE object_id = ? ORDER BY version_no", env.object_id).map((r) => Number(r.version_no));
    assert.deepEqual(numbers, Array.from({ length: imported + 1 }, (_v, i) => i + 1), "1 (the original) then one number per imported version, no gap, no duplicate");
    assert.equal(table_counts(env.db).runs, BigInt(imported));
  });
});

test("raw API: the same Idempotency-Key replays; the same key with other content is refused; a replay writes nothing", async () => {
  await with_cleanup(async (env) => {
    const first = assert_ok(await post_import(env, raw_body(env), { key: "raw-key-1" }), 201);
    assert.equal(first.mode, "B");
    const sig = state_signature(env.db);
    const again = await post_import(env, raw_body(env), { key: "raw-key-1" });
    assert.equal(again.status, 201);
    assert.equal(again.json.replayed, true);
    assert.equal(again.json.data.run_id, first.run_id);
    const other = await post_import(env, raw_body(env, { results: [{ op: "append_version", object_id: env.object_id, title: "다른 내용" }] }), { key: "raw-key-1" });
    assert.equal(other.json.error?.code, "idempotency_key_reuse");
    assert.equal(state_signature(env.db), sig);
    // no key at all is refused (a write without a key cannot be retried safely)
    const nokey = await post_import(env, raw_body(env, { request_id: "raw-request-nokey" }), { key: null });
    assert.ok(nokey.status >= 400 && nokey.status < 500, `${nokey.status}`);
    assert.equal(state_signature(env.db), sig);
    // a stale revision is refused with no write
    await bump_control_rev(env);
    const bumped = state_signature(env.db);
    const stale = await post_import(env, raw_body(env, { expected_control_rev: "0", request_id: "raw-request-stale" }), { key: "raw-key-stale" });
    assert.equal(stale.status, 409, JSON.stringify(stale.json));
    assert.equal(stale.json.error.code, "rev_conflict");
    assert.equal(state_signature(env.db), bumped);
  });
});

test("an import changes no current version, approves nothing and reopens nothing", async () => {
  await with_cleanup(async (env) => {
    const a = adapter(env);
    const current = () => env.db.get<{ current_version_id: string }>("SELECT current_version_id FROM objects WHERE id = ?", env.object_id)!.current_version_id;
    const stage_status = () => env.db.get<{ status: string }>("SELECT status FROM stages WHERE id = ?", env.stage.plan)!.status;
    const round_state = () => env.db.get<{ state: string }>("SELECT state FROM rounds WHERE id = ?", env.round_id)!.state;
    const event_count = (type: string) => events_of_type(env, type).length;
    const types = ["stage.approved", "stage.reopened", "round.sealed", "round.started", "run.claimed"];
    const before = { current: current(), stage: stage_status(), round: round_state(), counts: table_counts(env.db), events: types.map(event_count) };
    const { text } = await export_for(env, a);
    const out = await a.import_result({ bundle_text: text, result_text: paste(env.object_id, "현재 버전이 되려 함") });
    assert.equal(current(), before.current, "the imported version is a proposal: the current version did not move");
    assert.notEqual(out.results[0]!.version_id, current());
    assert.equal(stage_status(), before.stage);
    assert.equal(round_state(), before.round);
    const counts = table_counts(env.db);
    for (const table of ["approvals", "snapshots", "rounds", "stages", "editions"]) {
      if (table in counts) assert.equal(counts[table], before.counts[table], `${table} is untouched`);
    }
    assert.deepEqual(types.map(event_count), before.events, "no approval, reopen, seal, round or claim event came from an import");
  });
});

test("the run an import creates cannot be claimed, cancelled, extended or written to by an agent", async () => {
  await with_cleanup(async (env, open) => {
    const a = adapter(env);
    const { text } = await export_for(env, a);
    const out = await a.import_result({ bundle_text: text, result_text: paste(env.object_id) });
    const client = open(await env.client());
    const sig = state_signature(env.db);
    const refused_codes = ["forbidden", "conflict", "not_found", "lease_lost", "claim_required"];
    for (const [tool, args] of [
      ["pes_claim", { run_id: out.run_id }],
      ["pes_cancel", { run_id: out.run_id, confirm: true }],
      ["pes_heartbeat", { run_id: out.run_id, lease_id: "forged", fence: "1" }],
      ["pes_submit", { run_id: out.run_id, lease_id: "forged", fence: "1", results: [{ op: "append_version", object_id: env.object_id, title: "남의 실행에 쓰기" }] }],
      ["pes_complete", { run_id: out.run_id, lease_id: "forged", fence: "1", status: "failed" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const res = await client.tool(tool, { ...args, idempotency_key: `own-run-${tool}` });
      assert.equal(res.is_error, true, tool);
      assert.ok(refused_codes.includes(res.data.error.code), `${tool}: ${res.data.error.code}`);
    }
    // the import's request key belongs to the owner: an agent cannot cite it as evidence either
    const claim = await client.ok("pes_claim", { idempotency_key: "agent-own-claim" });
    assert.equal(typeof claim.run_id, "string");
    assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", out.run_id)?.status, "succeeded");
    void sig;
  });
});

async function seal_plan_round(env: AdapterEnv): Promise<{ snapshot_id: string }> {
  const versions = [{ object_id: env.object_id, version_id: env.version_id }];
  const blob = await manifest_blob(env, versions, "harden-manifest");
  const sealed = assert_ok(await call(env, { method: "POST", path: P(env, `/rounds/${env.round_id}/seal`), auth: "owner", body: { manifest_blob_id: blob, versions } }));
  return { snapshot_id: sealed.round.sealed_snapshot_id as string };
}

test("an import writes into no SEALED round (a human closed it; an agent's question into it is refused too)", async () => {
  await with_cleanup(async (env, open) => {
    const a = adapter(env);
    await seal_plan_round(env);
    const client = open(await env.client());
    await client.ok("pes_claim", { idempotency_key: "sealed-claim" });
    await client.fails("pes_ask", { stage_id: env.stage.plan, round_id: env.round_id, purpose: "review", question: { text: "봉인 뒤 질문", type: "text" }, idempotency_key: "sealed-ask" }, "conflict");
    const bundle = await export_for(env, a);
    const sig = state_signature(env.db);
    await refused(a.import_result({ bundle_text: bundle.text, result_text: paste(env.object_id, "봉인된 라운드") }), ["conflict", "forbidden"]);
    assert.equal(state_signature(env.db), sig, "a sealed round took no hand-off run");
  });
});

test("an import writes into no APPROVED stage: a human must reopen it first", async () => {
  await with_cleanup(async (env) => {
    const a = adapter(env);
    const { snapshot_id } = await seal_plan_round(env);
    assert_ok(await call(env, { method: "POST", path: P(env, `/stages/${env.stage.plan}/approve`), auth: "owner", body: { snapshot_id } }));
    const bundle = await export_for(env, a);
    const sig = state_signature(env.db);
    await refused(a.import_result({ bundle_text: bundle.text, result_text: paste(env.object_id, "승인된 단계") }), ["conflict", "forbidden"]);
    assert.equal(state_signature(env.db), sig, "an approved stage took no hand-off run");
    assert.equal(env.db.get<{ status: string }>("SELECT status FROM stages WHERE id = ?", env.stage.plan)?.status, "approved");
    assert.equal(table_counts(env.db).runs, 0n);
  });
});

test("pasted results that forge fields, ops or objects are refused and write nothing", async () => {
  await with_cleanup(async (env) => {
    const other = await register_second(env, "synthetic-pasted-forgery");
    const a = adapter(env);
    const { text } = await export_for(env, a);
    const sibling = await new_artifact(env, "pasted-sibling");
    const sig = state_signature(env.db);
    const item = (extra: Record<string, unknown> = {}) => ({ op: "append_version", object_id: env.object_id, title: "위조", ...extra });
    const results = (items: unknown[], top: Record<string, unknown> = {}) => JSON.stringify({ results: items, ...top });

    for (const field of ["actor_id", "run_id", "via", "provenance", "verified", "adopted_by", "status", "current", "is_current", "set_current", "approved", "version_id", "version_no", "created_at"]) {
      await refused(a.import_result({ bundle_text: text, result_text: results([item({ [field]: "forged" })]) }), "invalid_payload");
    }
    for (const op of ["set_current", "approve", "reopen", "delete", "append_version ", "APPEND_VERSION", "", null, 5]) {
      await refused(a.import_result({ bundle_text: text, result_text: results([{ ...item(), op }]) }), "bundle_invalid");
    }
    await refused(a.import_result({ bundle_text: text, result_text: results([item({ object_id: other.object_id })]) }), "result_out_of_scope");
    await refused(a.import_result({ bundle_text: text, result_text: results([item({ object_id: sibling.object_id })]) }), "result_out_of_scope");
    await refused(a.import_result({ bundle_text: text, result_text: results([item({ based_on_version_id: other.version_id })]) }), ["not_found", "conflict", "invalid_payload"]);
    await refused(a.import_result({ bundle_text: text, result_text: results([item({ based_on_version_id: sibling.version_id })]) }), ["not_found", "conflict", "invalid_payload"]);
    await refused(a.import_result({ bundle_text: text, result_text: results([item({}), item({ approved: true })]) }), "invalid_payload");
    await refused(a.import_result({ bundle_text: text, result_text: results([item({}), item({ object_id: sibling.object_id })]) }), "result_out_of_scope");
    await refused(a.import_result({ bundle_text: text, result_text: results(Array.from({ length: 21 }, () => item())) }), "bundle_invalid");
    await refused(a.import_result({ bundle_text: text, result_text: results([]) }), "bundle_invalid");
    await refused(a.import_result({ bundle_text: text, result_text: results([null]) }), "bundle_invalid");
    await refused(a.import_result({ bundle_text: text, result_text: results([[item()]]) }), "bundle_invalid");
    await refused(a.import_result({ bundle_text: text, result_text: JSON.stringify({ results: [item()], approved: true }) }), "bundle_invalid");
    await refused(a.import_result({ bundle_text: text, result_text: JSON.stringify({ results: [item()], claimed: "claude" }) }), "bundle_invalid");
    // the `__proto__` of a pasted item is an unknown field, and nothing is polluted
    await refused(a.import_result({ bundle_text: text, result_text: '{"results":[{"op":"append_version","object_id":"' + env.object_id + '","title":"x","__proto__":{"polluted":true}}]}' }), "invalid_payload");
    assert.equal(({} as any).polluted, undefined);
    assert.equal(state_signature(env.db), sig, "not one of them wrote a row");
  });
});

test("pasted results that are not the JSON the bundle asked for are bundle_invalid; attachments are not stored", async () => {
  await with_cleanup(async (env) => {
    const a = adapter(env);
    const { text } = await export_for(env, a);
    const sig = state_signature(env.db);
    const good = paste(env.object_id);
    for (const result_text of [
      "[]",
      "null",
      "42",
      '"text"',
      "{}",
      "",
      "   ",
      `﻿${good}`,
      `\`\`\`json\n${good}\n\`\`\``,
      `${good} 이상 입니다`,
      `여기 결과입니다: ${good}`,
      `${good}${good}`,
      '{"results": NaN}',
      "{'results': []}",
    ]) {
      await refused(a.import_result({ bundle_text: text, result_text }), "bundle_invalid");
    }
    for (const bad of [undefined, null, 5, {}, [], true] as unknown[]) {
      await refused(a.import_result({ bundle_text: text, result_text: bad as any }), "bundle_invalid");
      await refused(a.import_result({ bundle_text: bad as any, result_text: good }), "bundle_invalid");
    }
    await refused(a.import_result(undefined as any), "bundle_invalid");
    await refused(a.import_result(null as any), "bundle_invalid");
    await refused(a.import_result({} as any), "bundle_invalid");
    await refused(a.import_result({ bundle_text: "x".repeat(100_000), result_text: good }), "bundle_invalid");
    await refused(a.import_result({ bundle_text: `${"[".repeat(5000)}${"]".repeat(5000)}`, result_text: good }), "bundle_invalid");
    // attachments
    await refused(a.import_result({ bundle_text: text, result_text: paste(env.object_id, "첨부", { attachments: "figure.png" }) }), "bundle_invalid");
    await refused(a.import_result({ bundle_text: text, result_text: paste(env.object_id, "첨부", { attachments: [{}] }) }), "bundle_invalid");
    await refused(a.import_result({ bundle_text: text, result_text: paste(env.object_id, "첨부", { attachments: [{ name: 5 }] }) }), "bundle_invalid");
    await refused(a.import_result({ bundle_text: text, result_text: paste(env.object_id, "첨부", { attachments: [{ name: "a.png" }] }) }), "attachment_missing");
    await refused(
      a.import_result({ bundle_text: text, result_text: paste(env.object_id, "첨부", { attachments: [{ name: "a.png" }] }), attachments: [{ name: "a.png" }] }),
      "attachment_unsupported",
    );
    await refused(
      a.import_result({ bundle_text: text, result_text: paste(env.object_id, "첨부", { attachments: [{ name: "a.png" }, { name: "b.png" }] }), attachments: [{ name: "a.png" }] }),
      "attachment_missing",
    );
    assert.equal(state_signature(env.db), sig);
    assert.equal((await a.import_result({ bundle_text: text, result_text: good })).status, "imported", "none of them used the bundle up");
  });
});

test("one import may not carry the same object twice: invalid_payload, nothing written (leader decision — no branching versions)", async () => {
  await with_cleanup(async (env) => {
    const a = adapter(env);
    const { text } = await export_for(env, a);
    const sig = state_signature(env.db);
    for (const n of [2, 20]) {
      const items = Array.from({ length: n }, (_v, i) => ({ op: "append_version", object_id: env.object_id, title: `중복 ${i + 1}` }));
      await assert.rejects(
        a.import_result({ bundle_text: text, result_text: JSON.stringify({ results: items }) }),
        (error: any) => error.code === "invalid_payload",
        `${n} versions of one object in one import are refused`,
      );
      assert.equal(state_signature(env.db), sig, "a refused import writes nothing (no run, no version, no receipt)");
    }
    // one version of the object is still accepted, and makes one run
    const ok = await a.import_result({ bundle_text: text, result_text: JSON.stringify({ results: [{ op: "append_version", object_id: env.object_id, title: "한 번" }] }) });
    assert.equal(ok.results.length, 1);
    assert.equal(events_of_type(env, "run.created").length, 1, "one run for the import");
  });
});

test("ill-formed text, huge text and a version already superseded do not half-write an import", async () => {
  await with_cleanup(async (env) => {
    const a = adapter(env);
    const { text } = await export_for(env, a);
    const sig = state_signature(env.db);
    // an ill-formed title is refused, or stored as well-formed text — never stored broken
    let imported = false;
    try {
      await a.import_result({ bundle_text: text, result_text: '{"results":[{"op":"append_version","object_id":"' + env.object_id + '","title":"\\ud800 깨진 글자"}]}' });
      imported = true;
    } catch (error: any) {
      assert.equal(typeof error.code, "string");
      assert.equal(state_signature(env.db), sig);
    }
    if (imported) {
      for (const row of env.db.all<{ title: string }>("SELECT title FROM artifact_versions")) assert.ok(row.title.isWellFormed(), "stored text is well-formed");
    }
    // a huge title is a clean refusal (the API's body limit), not a crash and not a partial write
    const fresh = await export_for(env, a);
    const before = state_signature(env.db);
    const err = await refused(a.import_result({ bundle_text: fresh.text, result_text: paste(env.object_id, "가".repeat(3 * 1024 * 1024)) }));
    assert.notEqual(err.code, "internal_error");
    assert.equal(state_signature(env.db), before);

    // the object moved on after the copy: stale, and the bundle stays usable once re-exported
    const moved = await export_for(env, a);
    await more_version(env, "superseded", env.object_id);
    const after_move = state_signature(env.db);
    // an appended version does not move `current`, so this bundle is still honest about what it was based on
    const ok = await a.import_result({ bundle_text: moved.text, result_text: paste(env.object_id, "이동 뒤") }).then(
      (out) => out.status,
      (error) => error.code,
    );
    assert.ok(ok === "imported" || ok === "bundle_stale", String(ok));
    if (ok !== "imported") assert.equal(state_signature(env.db), after_move);
  });
});

test("an owner session that is not the owner's gets nothing, for the copy and for the paste", async () => {
  await with_cleanup(async (env) => {
    const good = adapter(env);
    const { text } = await export_for(env, good);
    const sig = state_signature(env.db);
    for (const owner_session of [env.agent.token, `${SESSION_SECRET} `, SESSION_SECRET.toUpperCase(), SESSION_SECRET.slice(0, -1), `Bearer ${SESSION_SECRET}`, `${SESSION_SECRET}\n`]) {
      const bad = adapter(env, { owner_session });
      await refused(bad.import_result({ bundle_text: text, result_text: paste(env.object_id) }), ["unauthenticated", "forbidden"]);
      await refused(export_for(env, bad), ["unauthenticated", "forbidden"]);
    }
    assert.equal(state_signature(env.db), sig);
    // a project the session cannot see
    await refused(adapter(env, { project_id: "no-such-project" }).import_result({ bundle_text: text, result_text: paste(env.object_id) }), ["bundle_wrong_project", "not_found", "forbidden"]);
    assert.equal(state_signature(env.db), sig);
    void owner_creates_run;
  });
});

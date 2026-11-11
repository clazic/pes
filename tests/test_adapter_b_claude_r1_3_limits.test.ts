/**
 * SEL-53 PR20a — r1-3 마무리(mid 8fee21d) 한도 시험 (tester, 작성 모드).
 *  L1  어댑터 MAX_BUNDLE_BASE_VERSIONS 와 서버 MAX_EXPECTED_HEADS 는 같은 값(1000)이다.
 *  L2  GET /runs/{r}/inputs 의 limit: 0·101·숫자 아님·음수·소수 → 400 invalid_payload, 1·100 허용.
 *  L3  내보내기: base_versions 1000개는 되고 1001개는 payload_too_large(next_action archive_objects)·쓰기 0.
 *  L4  가져오기 묶음: base_versions 1000 초과·같은 object 중복은 bundle_invalid·쓰기 0.
 * 합성 자료만 쓴다. 자식 프로세스·경로·줄바꿈 비교가 없어 Windows 점검표의 해당 항목은 없다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_BUNDLE_BASE_VERSIONS } from "../scripts/pes_core/adapters/claude_app.ts";
import { MAX_EXPECTED_HEADS } from "../scripts/pes_core/commands/handoff_import.ts";
import type { AdapterEnv } from "./helpers/adapter_b_env.ts";
import { claim_fresh, with_cleanup } from "./helpers/adapter_b_flow.ts";
import { adapter, export_for, forge_bundle, paste, refused } from "./helpers/adapter_b_harden.ts";
import { assert_error, assert_ok, call } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { new_artifact } from "./helpers/blob_env.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

test("L1: the adapter's bundle limit and the server's expected_heads limit are the same number", () => {
  assert.equal(MAX_BUNDLE_BASE_VERSIONS, MAX_EXPECTED_HEADS);
  assert.equal(MAX_BUNDLE_BASE_VERSIONS, 1000);
});

test("L2: GET /runs/{r}/inputs limit — 0, 101, not a number, negative, fractional → 400; 1 and 100 are allowed", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const claim = await claim_fresh(client);
    env.tick();
    const get = (query: string) => call(env, { method: "GET", path: P(env, `/runs/${claim.run_id}/inputs${query}`), auth: { token: env.agent.token } });
    for (const bad of ["0", "101", "abc", "-1", "1.5", "", "1e2", "%2B5", "99999999999999999999"]) {
      assert_error(await get(`?limit=${bad}`), 400, "invalid_payload");
    }
    for (const good of ["1", "100", "50"]) {
      env.tick();
      const data = assert_ok(await get(`?limit=${good}`));
      assert.ok(Array.isArray(data.inputs));
      assert.ok(data.inputs.length <= Number(good));
    }
    env.tick();
    assert_ok(await get(""));
  });
});

/** Make the manifest hold exactly `target` appendable objects (the env starts with some). */
async function fill_to(env: AdapterEnv, target: number): Promise<void> {
  const context = assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: "owner" }));
  const have = (context.manifest as Array<{ kind: string }>).filter((entry) => entry.kind === "artifact" || entry.kind === "source").length;
  for (let i = have; i < target; i += 1) await new_artifact(env, `lim-${i}`);
}

test("L3: exactly 1000 base versions export; 1001 are refused with payload_too_large and nothing is written", async () => {
  await with_cleanup(async (env) => {
    await fill_to(env, MAX_BUNDLE_BASE_VERSIONS);
    const at_limit = await export_for(env);
    assert.equal(at_limit.bundle.base_versions.length, MAX_BUNDLE_BASE_VERSIONS);

    await new_artifact(env, "lim-over");
    const sig = state_signature(env.db);
    const counts = table_counts(env.db);
    const error = await refused(export_for(env), "payload_too_large");
    assert.equal(error.next_action, "archive_objects");
    assert.equal(state_signature(env.db), sig, "a refused export writes nothing");
    assert.deepEqual(table_counts(env.db), counts);
  });
});

test("L4: an import bundle with more than 1000 base versions, or one object twice, is bundle_invalid and writes nothing", async () => {
  await with_cleanup(async (env) => {
    const a = adapter(env);
    const { bundle } = await export_for(env, a);
    const sig = state_signature(env.db);
    const first = bundle.base_versions[0]!;

    const many = Array.from({ length: MAX_BUNDLE_BASE_VERSIONS + 1 }, (_, i) => ({ object_id: `lim-obj-${i}`, version_id: `lim-ver-${i}` }));
    const over = forge_bundle(bundle, { base_versions: many });
    await refused(a.import_result({ bundle_text: over, result_text: paste(first.object_id) }), "bundle_invalid");

    const twice = forge_bundle(bundle, { base_versions: [first, { object_id: first.object_id, version_id: "other-version" }] });
    await refused(a.import_result({ bundle_text: twice, result_text: paste(first.object_id) }), "bundle_invalid");

    const same_pair_twice = forge_bundle(bundle, { base_versions: [first, first] });
    await refused(a.import_result({ bundle_text: same_pair_twice, result_text: paste(first.object_id) }), "bundle_invalid");

    assert.equal(state_signature(env.db), sig, "refused imports write nothing");
  });
});

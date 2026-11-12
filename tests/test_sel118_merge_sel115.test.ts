/**
 * SEL-118 × SEL-115 (merge) — the prompt build is an AI exit too: a file material closed to AI (any version holds a denied file)
 * goes through the one decision of commands/file_access.ts (material_object_denied), the same unit as the version read.
 *
 * - a caller that is not the human asking about a closed material: 403 forbidden (the version read answers the same)
 * - the human: 200, but the material's own text (its title) and the quote stay out, excluded with reason ai_access_denied
 * - allow again: the text is back
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { assert_ok, call, make_agent, with_api, type ApiEnv, type Auth } from "./helpers/api_env.ts";
import { P, assert_no_trace, new_material, set_access } from "./helpers/sel115_env.ts";

function build(env: ApiEnv, auth: Auth, body: Record<string, unknown>) {
  return call(env, { method: "POST", path: P(env, "/prompt-builds"), auth, body });
}

for (const target of ["A", "B"] as const) {
  test(`prompt build (${target}) about a closed file material: agent 403, owner gets it without the material's text; allow brings it back`, async () => {
    await with_api(async (env) => {
      const secret = await new_material(env, `pb-${target}`, { marker: `SECRET-PB-${target}`, name: `비공개-pb-${target}.txt` });
      const title = `제목 pb-${target}`;
      const agent = await make_agent(env, "asker", ["context:read", "file:read"]);
      const body = {
        question: "이 자료를 요약해 주세요",
        selection: { version_id: secret.data.version_id, quote: title },
        target,
      };

      // open: the title is in the prompt
      const before = assert_ok(await build(env, "owner", body));
      assert.ok(before.prompt_text.includes(title), "before deny the material's text is in the prompt");

      assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));

      const refused = await build(env, { token: agent.token }, body);
      assert.equal(refused.status, 403, `agent build ${JSON.stringify(refused.json)}`);
      assert.equal(refused.json.error.code, "forbidden");
      assert_no_trace(JSON.stringify(refused.json), secret, "agent refusal");
      assert.ok(!JSON.stringify(refused.json).includes(title), "agent refusal has no title");

      const owner = assert_ok(await build(env, "owner", body));
      assert.ok(!owner.prompt_text.includes(title), "the closed material's title and quote stay out of the prompt");
      assert_no_trace(owner.prompt_text, secret, "owner prompt_text");
      const reasons = owner.excluded
        .filter((item: any) => item.kind === "version" || item.kind === "selection")
        .map((item: any) => `${item.kind}:${item.reason}`)
        .sort();
      assert.deepEqual(reasons, ["selection:ai_access_denied", "version:ai_access_denied"]);
      assert.ok(!owner.included.some((item: any) => item.kind === "version"), "version content not included");

      assert_ok(await set_access(env, secret.data.file_policy_id, "allow"));
      const after = assert_ok(await build(env, "owner", body));
      assert.ok(after.prompt_text.includes(title), "allow brings the text back");
      const agent_after = await build(env, { token: agent.token }, body);
      assert.equal(agent_after.status, 200);
    });
  });
}

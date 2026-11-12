/**
 * SEL-119 × SEL-118 합치기 — 인쇄 blob 이 프롬프트 조립(POST P/prompt-builds)에 들어가는 길.
 *
 * 인쇄물은 사람용이다(사용자 결정): 인쇄가 만든 출력·manifest blob 은 비사람의 GET files/{b}/content·preview 가 403 이다.
 * 그 blob 은 ready 라서 다른 버전에 파일로 붙이거나 자료로 등록할 수 있고, 그러면 프롬프트 조립이 그 파일을 AI 글에 적을 수 있다.
 * 같은 규칙: 비사람(토큰)의 조립에는 인쇄 blob 의 id·이름이 없고, 인쇄 blob 을 단 자료를 고르면 403 이다.
 * 사람(소유자)의 조립에는 "AI 에게 빼었다"(ai_access_denied)로 남는다(닫힌 파일과 같은 모양).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { add_artifact, create_object } from "../scripts/pes_core/content.ts";
import { assert_ok, call, make_agent, with_api, type ApiEnv } from "./helpers/api_env.ts";
import { attach } from "./helpers/blob_env.ts";
import { start } from "./helpers/editions_env.ts";
import { P, wire_of } from "./helpers/sel115_env.ts";
import { art, stage_of } from "./helpers/sel119_env.ts";

async function printed(env: ApiEnv, tag: string) {
  const plan = stage_of(env, "plan");
  const round = await start(env, plan, `${tag}-start`);
  await art(env, `${tag}-body`, { stage_id: plan, body_md: `공개본문-${tag}`, title: `공개제목-${tag}` });
  return assert_ok(
    await call(env, { method: "POST", path: P(env, "/print/commit"), auth: "owner", body: { scope: "round", round_id: round.round_id }, key: `${tag}-commit` }),
    201,
  );
}

async function artifact(env: ApiEnv, key: string): Promise<{ object_id: string; version_id: string }> {
  const obj = (await create_object(env.service, env.ctx(`${key}-o`), { kind: "artifact", edition_id: env.p.edition_id })).result as { object_id: string };
  const out = await add_artifact(env.service, env.ctx(`${key}-v`), { object_id: obj.object_id, artifact_kind: "chapter", title: "합성 장", summary: "합성 요약" });
  return out.result as { object_id: string; version_id: string };
}

const build = (env: ApiEnv, auth: any, body: unknown) => call(env, { method: "POST", path: P(env, "/prompt-builds"), auth, body });

test("a print blob attached to a version is not named in a non-human prompt build; the owner sees it held back", async () => {
  await with_api(async (env) => {
    const done = await printed(env, "m118a");
    const v = await artifact(env, "m118a-art");
    const blobs = [done.output_blob_id, done.manifest_blob_id] as string[];
    await attach(env as any, v.version_id, blobs[0]!, "attachment", "m118a-at1");
    await attach(env as any, v.version_id, blobs[1]!, "source", "m118a-at2");
    const agent = await make_agent(env, "m118a-reader", ["context:read"]);
    const body = { question: "q", selection: { version_id: v.version_id } };

    const token_build = await build(env, { token: agent.token }, body);
    const data = assert_ok(token_build);
    for (const blob_id of blobs) assert.ok(!wire_of(token_build).includes(blob_id), `no print blob id in the token's build: ${blob_id}`);
    assert.ok(!data.included.some((i: any) => i.kind === "file"));
    assert.ok(!data.excluded.some((e: any) => e.reason === "ai_access_denied"));

    const owner = assert_ok(await build(env, "owner", body));
    for (const blob_id of blobs) {
      assert.equal(owner.excluded.find((e: any) => e.kind === "file" && e.id === blob_id)?.reason, "ai_access_denied", blob_id);
      assert.ok(!owner.included.some((i: any) => i.id === blob_id));
    }
  });
});

test("a material whose file is a print blob is 403 for a non-human prompt build, even with AI access allowed", async () => {
  await with_api(async (env) => {
    const done = await printed(env, "m118b");
    const agent = await make_agent(env, "m118b-reader", ["context:read"]);
    for (const blob_id of [done.output_blob_id, done.manifest_blob_id] as string[]) {
      const reg = await call(env, { method: "POST", path: P(env, "/materials"), auth: "owner", body: { blob_id, title: `인쇄자료-${blob_id}` } });
      assert.equal(reg.status, 201, JSON.stringify(reg.json));
      const version_id = reg.json.data.version_id as string;
      assert.ok(version_id, "the material has a version");
      const body = { question: "q", selection: { version_id } };
      const token_build = await build(env, { token: agent.token }, body);
      assert.equal(token_build.status, 403, JSON.stringify(token_build.json));
      assert.ok(!wire_of(token_build).includes(blob_id));
      const owner = assert_ok(await build(env, "owner", body));
      assert.ok(owner.excluded.some((e: any) => e.kind === "version" && e.reason === "ai_access_denied"), "the human is told the text was held back");
      assert.ok(!owner.included.some((i: any) => i.kind === "file" && i.id === blob_id));
    }
  });
});

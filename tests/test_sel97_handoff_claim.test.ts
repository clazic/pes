/**
 * SEL-97 (tester, 작성 모드) — 작업 공간 읽기의 handed_off 판정 (SEL-87 최종 2/2 권장 1).
 * 합성 DB · 임시 HOME 뿐.
 *
 * 정한 길(이슈가 준 두 후보 중): "가져오기 경로 증거" 쪽이다 — runtime 이름을 claim 에서 거절하지 않는다.
 *   handed_off = runtime *_app_handoff + 사람 소유자 + succeeded + 그 run 을 만든 사건이 가져오기(via = import).
 *   소유자 세션이 claim(`POST /claims`)으로 만든 run 은 runtime 이 인계 이름이어도, succeeded 여도 handed_off 가 아니다.
 *   (거절 쪽을 고르면 SEL-87 시험 tests/test_sel87_final_fixes.test.ts 의 "에이전트 claim 은 받아들여져 running" 이 깨진다.)
 *
 * 기존 시험과 새 계약이 충돌하는 곳(보고 목록):
 *   tests/test_sel87_workspace_ai.test.ts "runs: handed_off only for a hand-off import run" — runs 표에 사건 없이 직접 INSERT 한
 *   *_app_handoff 행이 handed_off 로 나오길 기대한다. 새 계약에서는 가져오기 사건이 없는 행은 그대로 succeeded 다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { with_cleanup } from "./helpers/adapter_b_flow.ts";
import { assert_ok, call } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";

const HANDOFF = [
  ["claude_app", "claude_app_handoff"],
  ["codex_app", "codex_app_handoff"],
  ["opencode_app", "opencode_app_handoff"],
] as const;

async function shown(env: any, run_id: string): Promise<any> {
  const data = assert_ok(await call(env, { method: "GET", path: P(env, "/workspace"), auth: "owner" }));
  return (data.runs as any[]).find((r) => r.id === run_id);
}

for (const [n, [, runtime]] of HANDOFF.entries()) {
  test(`handed_off: 소유자가 ${runtime} 으로 claim 해 succeeded 로 끝낸 run 은 handed_off 로 보이지 않는다`, async () => {
    await with_cleanup(async (env) => {
      const claim = await call(env, {
        method: "POST",
        path: P(env, "/claims"),
        auth: "owner",
        body: { mode: "B", runtime, provider: "synthetic", model: "m" },
        key: `claim-owner-handoff-${n}-00000001`,
      });
      const run_id = assert_ok(claim).run_id as string;
      const row = env.db.get("SELECT runtime, actor_id FROM runs WHERE id = ?", run_id) as { runtime: string; actor_id: string };
      assert.equal(row.runtime, runtime, "claim 이 runtime 이름을 그대로 저장한다(거절하지 않는 쪽을 골랐다)");
      env.db.run("UPDATE runs SET status = 'succeeded', ended_at = started_at WHERE id = ?", run_id);
      const run = await shown(env, run_id);
      assert.equal(run.status, "succeeded", "가져오기 사건이 없으면 사람이 claim 한 run 도 DB 상태 그대로");
    });
  });
}

test("handed_off: 실제 인계 가져오기(via import)로 만든 run 은 여전히 handed_off (회귀 가드)", async () => {
  await with_cleanup(async (env) => {
    for (const [n, [app]] of HANDOFF.entries()) {
      const request_id = `sel97-import-${n}-00000001`;
      const res = await call(env, {
        method: "POST",
        path: P(env, "/runs"),
        auth: "owner",
        body: { import: { app, request_id, results: [{ op: "append_version", object_id: env.object_id, title: `인계 ${n}` }] } },
        key: `import-${request_id}`,
      });
      const run_id = assert_ok(res, 201).run_id as string;
      assert.equal((await shown(env, run_id)).status, "handed_off");
    }
  });
});

test("handed_off: 가져오기 run 과 소유자 claim run 이 같은 프로젝트에 섞여도 각자 제 모양으로 보인다", async () => {
  await with_cleanup(async (env) => {
    const request_id = "sel97-mixed-import-0001";
    const imported = assert_ok(
      await call(env, {
        method: "POST",
        path: P(env, "/runs"),
        auth: "owner",
        body: { import: { app: "claude_app", request_id, results: [{ op: "append_version", object_id: env.object_id, title: "인계" }] } },
        key: `import-${request_id}`,
      }),
      201,
    ).run_id as string;
    const claimed = assert_ok(
      await call(env, {
        method: "POST",
        path: P(env, "/claims"),
        auth: "owner",
        body: { mode: "B", runtime: "claude_app_handoff", provider: "synthetic", model: "m" },
        key: "claim-owner-mixed-00000001",
      }),
    ).run_id as string;
    env.db.run("UPDATE runs SET status = 'succeeded', ended_at = started_at WHERE id = ?", claimed);
    assert.equal((await shown(env, imported)).status, "handed_off");
    assert.equal((await shown(env, claimed)).status, "succeeded");
  });
});

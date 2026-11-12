/**
 * SEL-87 최종 리뷰 1/2(Opus) 수정 시험 — 필수 1 (mid-worker). 합성 DB · 임시 HOME 뿐.
 *   필수 1  handed_off 는 runtime *_app_handoff 이름만으로 만들지 않는다. 실제 인계 가져오기 run 의 모양
 *           (commands/handoff_import.ts: 사람 소유자 actor · status = succeeded)과 맞을 때만 "handed_off" 이다.
 *           에이전트가 runtime "claude_app_handoff" 로 claim 한 run 은 DB 상태(running 등) 그대로 나간다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { with_cleanup } from "./helpers/adapter_b_flow.ts";
import { assert_ok, call, make_agent, with_api, type ApiEnv } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";

const HANDOFF_RUNTIMES = ["claude_app_handoff", "codex_app_handoff", "opencode_app_handoff"] as const;

async function read(env: ApiEnv): Promise<any> {
  return assert_ok(await call(env, { method: "GET", path: P(env, "/workspace"), auth: "owner" }));
}

for (const [n, runtime] of HANDOFF_RUNTIMES.entries()) {
  test(`handed_off: an agent run claimed with runtime ${runtime} keeps its DB status (running)`, async () => {
    await with_api(async (env) => {
      const agent = await make_agent(env, `handoff-name-${n}`);
      const claim = await call(env, {
        method: "POST",
        path: P(env, "/claims"),
        auth: { token: agent.token },
        body: { mode: "B", runtime, provider: "synthetic", model: "m" },
        key: `claim-handoff-name-${n}-00000001`,
      });
      const run_id = assert_ok(claim).run_id as string;
      const row = env.db.get<{ status: string; runtime: string }>("SELECT status, runtime FROM runs WHERE id = ?", run_id)!;
      assert.equal(row.runtime, runtime);
      assert.equal(row.status, "running", "the DB holds a running run");
      const shown = ((await read(env)).runs as any[]).find((r) => r.id === run_id);
      assert.equal(shown.status, "running", `an agent run with runtime ${runtime} must not read handed_off`);
    });
  });
}

test("handed_off: agent runs with an *_app_handoff runtime show failed / interrupted / blocked_usage as stored", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "handoff-states");
    const claim = await call(env, {
      method: "POST",
      path: P(env, "/claims"),
      auth: { token: agent.token },
      body: { mode: "B", runtime: "codex_app_handoff", provider: "synthetic", model: "m" },
      key: "claim-handoff-states-00000001",
    });
    const run_id = assert_ok(claim).run_id as string;
    for (const status of ["failed", "interrupted", "cancelled"]) {
      env.db.run("UPDATE runs SET status = ?, ended_at = started_at WHERE id = ?", status, run_id);
      const shown = ((await read(env)).runs as any[]).find((r) => r.id === run_id);
      assert.equal(shown.status, status, `${status} must not be hidden as handed_off`);
    }
  });
});

test("handed_off: a human owner's succeeded import run still reads handed_off (created through the real import)", async () => {
  await with_cleanup(async (env) => {
    for (const [n, app] of (["claude_app", "codex_app", "opencode_app"] as const).entries()) {
      const request_id = `final-fix-import-${n}-0001`;
      const res = await call(env, {
        method: "POST",
        path: P(env, "/runs"),
        auth: "owner",
        body: { import: { app, request_id, results: [{ op: "append_version", object_id: env.object_id, title: `인계 ${n}` }] } },
        key: `import-${request_id}`,
      });
      const run_id = assert_ok(res, 201).run_id as string;
      const row = env.db.get<{ status: string; runtime: string }>("SELECT status, runtime FROM runs WHERE id = ?", run_id)!;
      assert.equal(row.status, "succeeded");
      assert.ok((HANDOFF_RUNTIMES as readonly string[]).includes(row.runtime));
      const shown = ((await read(env)).runs as any[]).find((r) => r.id === run_id);
      assert.equal(shown.status, "handed_off");
    }
  });
});

/**
 * SEL-87 — 계약 시험: 서버 작업 공간 응답 모양 = 앱 WorkspaceView(app/src/api/types.ts) 모양, OpenAPI · 픽스처가 새 칸을 적는다.
 * 구현 전에는 칸 · 문서가 없어 실패하는 것이 정상. 칸 이름 · 값의 뜻은 tests/test_sel87_workspace_ai.test.ts 머리말이 정한다.
 *
 *   - 서버 응답 data 의 모든 최상위 칸은 앱 WorkspaceView 가 아는 칸이다(서버가 앱이 모르는 칸을 더하지 않는다).
 *   - 서버 값 집합은 앱 값 집합의 부분집합이다(서버가 내는 policy · run status · dispatch state 를 앱이 모른 채 받지 않는다).
 *   - docs/api/openapi-v1.yaml 의 workspace 설명이 새 칸(ai_connection · dispatches · past_approval · runs)과 '내지 않는 칸'
 *     (run_permissions · cancel_state · external_stop)의 이유를 적는다.
 *   - tests/fixtures/contracts/api/workspace_ai_ok.json 이 있고 실제 앱에 대해 통과한다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { OPENAPI_PATH, assert_ok, call, load_api_fixture, run_api_fixture, with_api } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";

const TYPES = readFileSync(new URL("../app/src/api/types.ts", import.meta.url), "utf8");
const MIGRATIONS = new URL("../scripts/pes_core/migrations/", import.meta.url);

/** `export interface WorkspaceView { ... }` 의 최상위 칸 이름 */
function app_workspace_keys(): string[] {
  const body = /export interface WorkspaceView \{([\s\S]*?)\n\}/.exec(TYPES)?.[1];
  assert.ok(body, "WorkspaceView interface in app/src/api/types.ts");
  return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!);
}

function union_of(type_name: string): string[] {
  const m = new RegExp(`export type ${type_name} =([^;]+);`).exec(TYPES);
  assert.ok(m, `type ${type_name} in types.ts`);
  return [...m[1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!);
}

test("every top-level field the server sends is a field of the app's WorkspaceView", async () => {
  await with_api(async (env) => {
    const data = assert_ok(await call(env, { method: "GET", path: P(env, "/workspace"), auth: "owner" }));
    const app = new Set(app_workspace_keys());
    // `actions` is the server's own display-only field the app does not need yet; everything else must be known to the app
    const unknown = Object.keys(data).filter((k) => !app.has(k) && k !== "actions");
    assert.deepEqual(unknown, [], "the server added a field the app's type does not have");
    for (const k of ["ai_connection", "runs"]) assert.ok(app.has(k), `app type has ${k}`);
    assert.ok(Object.hasOwn(data, "ai_connection") && Object.hasOwn(data, "runs"), "server sends the new fields");
  });
});

test("the app's value sets cover what the DB can say (policy, dispatch state, run status incl. blocked_usage, stage null)", () => {
  const initial = readFileSync(new URL("001_initial.sql", MIGRATIONS), "utf8");
  const ai = readFileSync(new URL("002_ai_connections.sql", MIGRATIONS), "utf8");
  const dispatch_states = [...(/CREATE TABLE outbound_dispatches[\s\S]*?state TEXT NOT NULL CHECK \(state IN\s*\(([^)]*)\)/.exec(initial)?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  assert.equal(dispatch_states.length, 8, "8 dispatch states in the DB");
  const run_statuses = [...(/CREATE TABLE runs_new[\s\S]*?status TEXT NOT NULL CHECK \(status IN\s*\(([^)]*)\)/.exec(ai)?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  assert.ok(run_statuses.includes("blocked_usage") && run_statuses.length === 8);

  const app_dispatch = new Set(/export interface AiDispatchView \{([\s\S]*?)\n\}/.exec(TYPES)?.[1].match(/"[a-z_]+"/g)?.map((s) => s.slice(1, -1)));
  for (const s of dispatch_states) assert.ok(app_dispatch.has(s), `AiDispatchView.state accepts the DB state ${s}`);
  const app_run = new Set(union_of("RunStatus"));
  for (const s of run_statuses) assert.ok(app_run.has(s), `RunStatus accepts the DB status ${s}`);
  assert.ok(app_run.has("handed_off"), "handed_off stays (derived from the hand-off import runtime)");
  const policy = new Set(union_of("AiPolicy"));
  for (const s of ["allowed", "denied", "missing", "corrupt"]) assert.ok(policy.has(s), `AiPolicy ${s}`);
  const run_view = /export interface RunView \{([\s\S]*?)\n\}/.exec(TYPES)?.[1] ?? "";
  assert.match(run_view, /stage:\s*StageKey\s*\|\s*null/, "RunView.stage can be null (a run without a stage)");
  const stage_ref = /export interface StageRef \{([\s\S]*?)\n\}/.exec(TYPES)?.[1] ?? "";
  assert.match(stage_ref, /past_approval\?:\s*PastApprovalView/);
});

test("docs/api/openapi-v1.yaml's workspace entry documents the new fields and says what is deliberately not sent", () => {
  const text = readFileSync(OPENAPI_PATH, "utf8");
  const start = text.indexOf("/api/v1/projects/{id}/workspace:");
  assert.ok(start >= 0);
  const next = text.indexOf("\n  /api/v1/", start + 10);
  const entry = text.slice(start, next < 0 ? undefined : next);
  for (const word of ["ai_connection", "dispatches", "past_approval", "runs", "blocked_usage", "handed_off", "resolution"]) {
    assert.ok(entry.includes(word), `the workspace entry names ${word}`);
  }
  for (const word of ["run_permissions", "cancel_state", "external_stop"]) {
    assert.ok(entry.includes(word), `the workspace entry says ${word} is not sent (no DB evidence)`);
  }
});

test("the workspace contract fixture exists and passes against the real app", async () => {
  const fixture = load_api_fixture("workspace_ai_ok.json");
  assert.equal(fixture.steps[0]!.request.path, "/api/v1/projects/${project}/workspace");
  await with_api(async (env) => {
    await run_api_fixture(env, fixture);
  });
});

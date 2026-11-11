/**
 * SEL-82 U1b — GET P/workspace: the new read contract (tester, 작성 모드). 구현 전에는 라우트가 없어 404 로 실패하는 것이 정상.
 *
 * 해석 (이슈 U1·docs/plan/issues/stage-3.md, stage-1-ui.md 114, app/src/api/types.ts WorkspaceView 에서 뽑음 — 구현을 추측하지 않음):
 *   GET /api/v1/projects/{id}/workspace      소유자 세션 또는 context:read 토큰. 읽기 전용(쓰기·새 표 없음).
 *   → 200 { format_version, request_id, data }. data 는 앱 types.ts 의 WorkspaceView 와 같은 모양(앱 HTTP 클라이언트가 .data 를 그대로 쓴다):
 *       slug, title, edition(정수), mode("A"|"B"), current{stage, round_id|null}, stages[{key, view, rounds[{round_id|null, state}]}], turn{side, ...}
 *     시각 필드(since·last_signal·*_at)는 ISO 8601. 화면 글자(한국어 단계 이름·상태 이름)는 싣지 않는다 — 기계 값만.
 *   + 권한별 가능 동작 `actions`: [{ action: string, enabled: boolean, disabled_reason: string | null }] (action 이름은 중복 없음).
 *       enabled=true ⇒ disabled_reason null, enabled=false ⇒ 비어 있지 않은 한국어 이유. 서버 검사를 대체하지 않는다(표시용).
 *       소유자 세션은 켜진 동작이 하나 이상, context:read 만 가진 토큰은 모든 동작이 꺼져 있고 이유가 있다.
 *   + 기록 `records`: { assumptions, decisions, comments } 각 { count: 정수 }, 그리고 empty: boolean(셋 다 0 이면 true).
 *       이전된 합성 프로젝트(가정·결정·의견 없음)는 empty=true — 화면이 '기록 없음'을 그릴 자료. 지어낸 항목은 없다.
 *   모르는 프로젝트 id → 404 not_found, 무자격 → 401 unauthenticated, context:read 없는 토큰 → 403 forbidden.
 *   새 표 없음: 마이그레이션 파일 목록이 지금과 같고, 읽어도 DB 내용이 변하지 않는다.
 */

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { assert_error, assert_ok, call, make_agent, with_api, type ApiEnv } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { state_signature } from "./helpers/state_signature.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const STAGE_KEYS = ["plan", "research", "analyze", "write", "verify", "publish"];
const VIEWS = ["approved", "current_you", "current_ai", "current_blocked", "stale", "pending"];
const SIDES = ["you", "ai", "waiting", "done"];
const WS = (env: ApiEnv) => P(env, "/workspace");

function walk(v: unknown, path: string, visit: (key: string, value: unknown, path: string) => void): void {
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, visit));
  else if (v !== null && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      visit(k, x, `${path}.${k}`);
      walk(x, `${path}.${k}`, visit);
    }
}

test("owner session: 200 with the app's WorkspaceView shape (slug, title, edition, mode, current, stages, turn)", async () => {
  await with_api(async (env) => {
    const slug = env.db.get<{ slug: string }>("SELECT slug FROM projects WHERE id = ?", env.p.project_id)!.slug;
    const res = await call(env, { method: "GET", path: WS(env), auth: "owner" });
    const data = assert_ok(res);
    assert.equal(data.slug, slug);
    assert.equal(typeof data.title, "string");
    assert.ok(data.title.length > 0);
    assert.ok(Number.isSafeInteger(data.edition) && data.edition >= 1, "edition is a JSON integer");
    assert.ok(["A", "B"].includes(data.mode));
    assert.ok(STAGE_KEYS.includes(data.current.stage));
    assert.ok(data.current.round_id === null || Number.isSafeInteger(data.current.round_id));
    assert.ok(Array.isArray(data.stages) && data.stages.length >= 1);
    for (const stage of data.stages) {
      assert.ok(STAGE_KEYS.includes(stage.key), `stage key ${stage.key}`);
      assert.ok(VIEWS.includes(stage.view), `stage view ${stage.view}`);
      assert.ok(Array.isArray(stage.rounds));
      for (const round of stage.rounds) {
        assert.ok(round.round_id === null || (Number.isSafeInteger(round.round_id) && round.round_id >= 1), "round ids start at 1 (no fake R0)");
        assert.ok(["closed", "current"].includes(round.state));
      }
    }
    assert.ok(data.stages.some((s: any) => s.key === data.current.stage), "the current stage is one of the stages");
    assert.ok(SIDES.includes(data.turn.side));
    // screen words are the screen's: the DTO carries machine values only
    assert.doesNotMatch(JSON.stringify(data.stages), /승인됨|현재 진행|시작 전|나의 할 일/);
  });
});

test("every time field is ISO 8601, and nothing secret or internal leaks", async () => {
  await with_api(async (env) => {
    const res = await call(env, { method: "GET", path: WS(env), auth: "owner" });
    const data = assert_ok(res);
    const bad: string[] = [];
    walk(data, "$", (k, v, p) => {
      if (/(^|_)(at|since|last_signal)$/.test(k) && v !== null) if (typeof v !== "string" || !ISO.test(v)) bad.push(`${p} = ${JSON.stringify(v)}`);
    });
    assert.deepEqual(bad, []);
    assert.doesNotMatch(JSON.stringify(res.json), /payload|token_hash|local_session_secret|synthetic-local-session-secret|pes_[A-Za-z0-9_-]{16,}/);
  });
});

test("actions: owner has enabled actions, each disabled one explains why, names are unique", async () => {
  await with_api(async (env) => {
    const data = assert_ok(await call(env, { method: "GET", path: WS(env), auth: "owner" }));
    assert.ok(Array.isArray(data.actions) && data.actions.length >= 1);
    const names = new Set<string>();
    for (const a of data.actions) {
      assert.deepEqual(Object.keys(a).sort(), ["action", "disabled_reason", "enabled"]);
      assert.equal(typeof a.action, "string");
      assert.ok(a.action.length > 0);
      assert.ok(!names.has(a.action), `duplicate action ${a.action}`);
      names.add(a.action);
      assert.equal(typeof a.enabled, "boolean");
      if (a.enabled) assert.equal(a.disabled_reason, null, `${a.action}: enabled has no reason`);
      else {
        assert.equal(typeof a.disabled_reason, "string");
        assert.ok(a.disabled_reason.trim().length > 0, `${a.action}: a disabled action says why`);
      }
    }
    assert.ok(data.actions.some((a: any) => a.enabled), "the owner can do something");
  });
});

test("actions are per credential: a context:read token sees them all disabled, each with a reason", async () => {
  await with_api(async (env) => {
    const reader = await make_agent(env, "reader", ["context:read"]);
    const owner = assert_ok(await call(env, { method: "GET", path: WS(env), auth: "owner" }));
    const data = assert_ok(await call(env, { method: "GET", path: WS(env), auth: { token: reader.token } }));
    assert.ok(Array.isArray(data.actions) && data.actions.length >= 1);
    assert.deepEqual(data.actions.map((a: any) => a.action).sort(), owner.actions.map((a: any) => a.action).sort(), "the same action list, only the answers differ");
    for (const a of data.actions) {
      assert.equal(a.enabled, false, `${a.action} must be off for a read-only token`);
      assert.ok(typeof a.disabled_reason === "string" && a.disabled_reason.trim().length > 0, `${a.action}: reason`);
    }
    assert.equal(data.slug, owner.slug, "the reading itself is the same project");
  });
});

test("records: a project with no assumptions, decisions or comments says so with counts, not with made-up rows", async () => {
  await with_api(async (env) => {
    const data = assert_ok(await call(env, { method: "GET", path: WS(env), auth: "owner" }));
    assert.deepEqual(Object.keys(data.records).sort(), ["assumptions", "comments", "decisions", "empty"]);
    for (const k of ["assumptions", "decisions", "comments"]) {
      assert.ok(Number.isSafeInteger(data.records[k].count), `${k}.count`);
      assert.equal(data.records[k].count, 0);
    }
    assert.equal(data.records.empty, true, "empty = '기록 없음' material for the screen");
  });
});

test("authentication and scope: none → 401 unauthenticated, no context:read → 403 forbidden, unknown project → 404", async () => {
  await with_api(async (env) => {
    assert_error(await call(env, { method: "GET", path: WS(env), auth: "none" }), 401, "unauthenticated");
    const noscope = await make_agent(env, "noscope", ["run:claim"]);
    assert_error(await call(env, { method: "GET", path: WS(env), auth: { token: noscope.token } }), 403, "forbidden");
    assert_error(await call(env, { method: "GET", path: "/api/v1/projects/no-such-project/workspace", auth: "owner" }), 404, "not_found");
  });
});

test("reading the workspace writes nothing (no row changes, no new table) and the migration list is unchanged", async () => {
  await with_api(async (env) => {
    const before = state_signature(env.db);
    for (let i = 0; i < 3; i += 1) assert_ok(await call(env, { method: "GET", path: WS(env), auth: "owner" }));
    assert.equal(state_signature(env.db), before, "GET workspace is read-only");
    // U1 is a read model: 'new SQL goes into one read-model function', no new table / migration (stage-3.md U1)
    assert.deepEqual(readdirSync(join(HERE, "..", "scripts", "pes_core", "migrations")).sort(), ["001_initial.sql", "002_ai_connections.sql"]);
  });
});

test("workspace is a registered route of the API contract, not a hidden one (capabilities / the route list name it)", async () => {
  await with_api(async (env) => {
    const caps = assert_ok(await call(env, { method: "GET", path: "/api/v1/capabilities", auth: "owner" }));
    assert.ok((caps.routes as string[]).includes("GET /api/v1/projects/{id}/workspace"), "capabilities.routes lists GET workspace");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// R1 권장 2 (작성 모드 2): 화면의 `enabled` 와 서버 검사가 갈라지지 않는다. `#action_refusal` 이 `#bind` 의 권한 규칙을 복제하므로,
// 자격(세션 · 토큰 scope 조합)마다 모든 action 에 대해 "enabled == 실제로 그 동작을 불렀을 때 권한 때문에 거절되지 않음" 을 확인한다.
// (작업 공간 읽기에 context:read 가 필요하므로 모든 토큰 조합이 context:read 를 가진다.)
// 해석: 권한 거절 = 401/403. 본문 `{}`·가짜 id 로 부르므로 enabled 인 동작은 400/404/409/422 같은 다른 이유로 끝나도 된다(권한 거절만 아니면 됨).
//   - enabled=true  ⇒ 응답이 401/403 이 아니다 (화면이 켠 버튼이 서버에서 권한으로 막히면 안 된다).
//   - 응답이 401/403 ⇒ enabled=false (거꾸로 같은 말).
//   - 상태 조건이 없는 동작(아래 NO_STATE_RULE) 은 enabled 와 (응답이 401/403 아님) 이 정확히 같다 — 권한만으로 꺼진 것이 서버에서는 통과하는 어긋남도 잡는다.

const ACTION_CALLS: Record<string, { method: string; path: (env: ApiEnv) => string }> = {
  "submissions.create": { method: "POST", path: (e) => P(e, "/submissions") },
  "questions.create": { method: "POST", path: (e) => P(e, "/questions") },
  "questions.revise": { method: "POST", path: (e) => P(e, "/questions/no-such-question/revisions") },
  "rounds.create": { method: "POST", path: (e) => P(e, "/stages/plan/rounds") },
  "rounds.seal": { method: "POST", path: (e) => P(e, "/rounds/no-such-round/seal") },
  "stages.approve": { method: "POST", path: (e) => P(e, "/stages/plan/approve") },
  "stages.reopen": { method: "POST", path: (e) => P(e, "/stages/plan/reopen") },
  "runs.create": { method: "POST", path: (e) => P(e, "/runs") },
  "uploads.create": { method: "POST", path: (e) => P(e, "/uploads") },
  "policies.opencode_go.revise": { method: "POST", path: (e) => P(e, "/policies/opencode-go/revisions") },
};
const NO_STATE_RULE = ["questions.create", "questions.revise", "rounds.create", "runs.create", "uploads.create", "policies.opencode_go.revise"];

test("R1 권장 2: for every credential (owner, tokens of each scope mix) every action's `enabled` equals what the server really does", async () => {
  await with_api(async (env) => {
    const credentials: Array<[string, { token: string } | "owner"]> = [["owner", "owner"]];
    for (const [name, scopes] of [
      ["read", ["context:read"]],
      ["read+submit", ["context:read", "run:submit"]],
      ["read+claim", ["context:read", "run:claim"]],
      ["read+files", ["context:read", "file:write", "file:read"]],
      ["read+claim+submit", ["context:read", "run:claim", "run:submit"]],
      ["all", ["context:read", "run:claim", "run:submit", "file:write", "file:read"]],
    ] as const) {
      const agent = await make_agent(env, `parity-${name}`, scopes);
      credentials.push([`token(${scopes.join(",")})`, { token: agent.token }]);
    }
    // read every credential's view first: the calls below may change the project
    const views: Array<[string, { token: string } | "owner", Array<{ action: string; enabled: boolean }>]> = [];
    for (const [label, auth] of credentials) {
      const data = assert_ok(await call(env, { method: "GET", path: WS(env), auth }));
      const names = data.actions.map((a: any) => a.action);
      for (const known of Object.keys(ACTION_CALLS)) assert.ok(names.includes(known), `${label}: action ${known} is listed`);
      for (const name of names) assert.ok(name in ACTION_CALLS, `${label}: the test does not know action ${name} — add its call to ACTION_CALLS`);
      views.push([label, auth, data.actions]);
    }
    const mismatches: string[] = [];
    for (const [label, auth, actions] of views) {
      for (const a of actions) {
        const spec = ACTION_CALLS[a.action] as { method: string; path: (env: ApiEnv) => string };
        const res = await call(env, { method: spec.method, path: spec.path(env), auth, body: {} });
        const refused = res.status === 401 || res.status === 403;
        if (a.enabled && refused) mismatches.push(`${label} ${a.action}: shown enabled but the server answered ${res.status} ${res.json?.error?.code}`);
        if (!a.enabled && NO_STATE_RULE.includes(a.action) && !refused) mismatches.push(`${label} ${a.action}: shown disabled but the server did not refuse it (${res.status})`);
      }
    }
    assert.deepEqual(mismatches, []);
  });
});

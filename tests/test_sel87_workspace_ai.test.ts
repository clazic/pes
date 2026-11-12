/**
 * SEL-87 — GET P/workspace 에 AI 연결 정책 · 전송 · 과거 승인 · run 상태를 채운다 (tester, 작성 모드).
 * 구현 전에는 칸이 없어 실패하는 것이 정상. 합성 DB · 임시 HOME 뿐(실제 자료 · 키 · 경로 없음).
 *
 * 근거 (leader 결정 + 코드 조사 — 구현을 추측하지 않음):
 *   - scripts/pes_core/api.ts #workspace_data(1569행~) 가 지금 주는 칸: slug title edition mode current stages turn actions records.
 *   - policy.ts current_policy(54행~): 포인터 NULL → policy_denied(누락), 포인터가 가리키는 행 없음 · 되감김 · 범위 밖 → policy_denied(손상).
 *     방식 A 허용 판정은 project_policy_versions.allow_opencode_go 비트 하나뿐이다(project_ai_selections · ai_connections 는
 *     어느 연결 · 모델을 쓰는지만 고르며 허용 여부를 정하지 않는다: a_runtime/loop.ts:325, commands/ai.ts:655·1030). 그래서 policy 는 비트만 따른다.
 *
 * [정한 wire 모양 — 새 칸은 모두 `data` 바로 아래, 기계 값만 (앱 WorkspaceView 와 같은 이름)]
 *   ai_connection: { policy: "allowed" | "denied" | "missing" | "corrupt", dispatches: [...] }
 *       - policy: allow_opencode_go=1 → allowed, 0 → denied, 포인터 NULL → missing, 그 밖의 손상 → corrupt.
 *         "pending"(확정 전)은 서버가 내지 않는다 — DB 에 '확정 전' 근거(저장소)가 없다(project_policy_versions 는 확정된 행만 가진다).
 *       - dispatches[]: 이 프로젝트의 outbound_dispatches 를 생성 순서(rowid)대로. 칸: { id, run_id, state, resolution? }
 *           state = DB 값 그대로(prepared authorized sent response adopted blocked failed unknown, 8값). 지어낸 값 · 이름 바꿈 없음.
 *           resolution = dispatch_resolutions.outcome("charged" | "not_charged") — 행이 있을 때만(키 자체가 없다). 행이 없으면 키 없음.
 *           cancel_state 는 서버가 내지 않는다: outbound_dispatches · dispatch_resolutions 어디에도 '취소 시도' 근거가 없다
 *           (state 8값에 cancel_requested 없음, 취소 열 · 사건 없음). 근거가 생기는 이슈에서 추가한다.
 *           payload_hash · request_key · external_request_id · manifest/response blob · usage/cost JSON 은 싣지 않는다.
 *   stages[].past_approval: { at: ISO 8601 | null, origin: "verified" | "legacy_unverified" } — 그 단계에 approvals 행이 있으면
 *       view 가 stale 이어도 준다(가장 나중 승인). at = 그 승인 커밋(mutation_commits.created_at)의 시각, 0 이면 null.
 *       origin = approvals.assurance. 승인 기록이 없는 단계는 키 자체가 없다.
 *   runs: [{ id, stage: StageKey | null, mode: "A" | "B", status }] — 이 프로젝트의 runs 를 생성 순서(rowid)대로.
 *       status = DB 값 그대로(queued running waiting_human blocked_usage succeeded failed cancelled interrupted),
 *       단 runtime 이 hand-off 가져오기 기록(claude_app_handoff · codex_app_handoff · opencode_app_handoff)이면 "handed_off".
 *       (parent_run_id 는 '다시 시도의 부모' 가 아니라 계보라 인계 근거로 쓰지 않는다 — 코드에 다른 인계 기록이 없다.)
 *       stage_id 가 NULL 인 run → stage: null. external_stop 은 서버가 내지 않는다(DB 근거 없음 — 연결 끊김 ≠ 취소를 지어내지 않음).
 *   run_permissions: 칸 자체를 내지 않는다 — 외부 앱 질문 · 권한을 담는 저장소가 없다(grep run_permission / permission_request: 없음).
 *       앱은 '정보 없음' 으로 그린다(types.ts 의 선택 칸).
 *   권한 · 격리: 기존 context:read 그대로(소유자 · context:read 토큰 모두 같은 칸을 본다). 다른 프로젝트의 run · dispatch · 승인은 섞이지 않는다.
 *   읽기 전용 · 새 표 없음 · 마이그레이션 목록 변화 없음. 화면 글자(한국어)는 싣지 않는다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { assert_ok, call, go_off, make_agent, with_api, type ApiEnv } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { drive_stage, stage_ids } from "./helpers/editions_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const WS = (env: ApiEnv) => P(env, "/workspace");
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const DB_DISPATCH_STATES = ["prepared", "authorized", "sent", "response", "adopted", "blocked", "failed", "unknown"] as const;

async function read(env: ApiEnv, auth: "owner" | { token: string } = "owner"): Promise<any> {
  return assert_ok(await call(env, { method: "GET", path: WS(env), auth }));
}

function edition_of(env: ApiEnv, project_id = env.p.project_id): string {
  return env.db.get<{ id: string }>("SELECT active_edition_id AS id FROM projects WHERE id = ?", project_id)!.id;
}

function add_run(
  env: ApiEnv,
  id: string,
  opts: { status?: string; stage?: string | null; mode?: "A" | "B"; runtime?: string; project_id?: string; actor_id?: string } = {},
): void {
  const project_id = opts.project_id ?? env.p.project_id;
  const actor_id = opts.actor_id ?? env.p.actor_id;
  const status = opts.status ?? "succeeded";
  const mode = opts.mode ?? "B";
  const stage = opts.stage === undefined ? stage_ids(env.db, edition_of(env, project_id)).research : opts.stage;
  const runtime = opts.runtime ?? (mode === "A" ? "pes_builtin" : "synthetic-runtime");
  const provider = mode === "A" ? "opencode-go" : "synthetic";
  const model = mode === "A" ? "opencode-go/deepseek-v4.1-flash" : "synthetic-model";
  const blocked = status === "blocked_usage";
  env.db.run(
    `INSERT INTO runs (id, project_id, edition_id, stage_id, round_id, actor_id, mode, runtime, provider, model, status,
        go_block_reason, go_blocked_at, base_control_rev, started_at, ended_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`,
    id,
    project_id,
    edition_of(env, project_id),
    stage,
    actor_id,
    mode,
    runtime,
    provider,
    model,
    status,
    blocked ? "usage_limit" : null,
    blocked ? 5n : null,
    ["succeeded", "failed", "cancelled", "interrupted"].includes(status) ? 2n : null,
  );
}

function add_blob(env: ApiEnv, id: string, project_id = env.p.project_id, actor_id = env.p.actor_id): void {
  env.db.run(
    `INSERT INTO blobs (id, project_id, storage_key, sha256, size, media_type, state, created_by)
     VALUES (?, ?, ?, ?, 1, 'application/json', 'ready', ?)`,
    id,
    project_id,
    `key-${id}`,
    id.padEnd(64, "a").slice(0, 64).replace(/[^0-9a-f]/g, "a"),
    actor_id,
  );
}

function add_dispatch(env: ApiEnv, id: string, run_id: string, state: string, project_id = env.p.project_id, actor_id = env.p.actor_id): void {
  const policy_id = env.db.get<{ id: string }>("SELECT current_policy_id AS id FROM projects WHERE id = ?", project_id)!.id;
  const blob = `blob-${id}`;
  add_blob(env, blob, project_id, actor_id);
  const needs_response = state === "response" || state === "adopted";
  if (needs_response) add_blob(env, `resp-${id}`, project_id, actor_id);
  let adopted: string | null = null;
  if (state === "adopted") {
    adopted = env.db.get<{ id: string }>("SELECT id FROM object_versions WHERE project_id = ? LIMIT 1", project_id)?.id ?? null;
    assert.ok(adopted, "adopted needs one object version in the project (the test drives a stage first)");
  }
  env.db.run(
    `INSERT INTO outbound_dispatches (id, project_id, run_id, provider, policy_version_id, manifest_blob_id, payload_hash, state,
        request_key, external_request_id, response_blob_id, response_hash, adopted_version_id, unknown_at, unknown_reason)
     VALUES (?, ?, ?, 'opencode-go', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    project_id,
    run_id,
    policy_id,
    blob,
    "b".repeat(64),
    state,
    `request-key-${id}`,
    `external-request-${id}`,
    needs_response ? `resp-${id}` : null,
    needs_response ? "c".repeat(64) : null,
    adopted,
    state === "unknown" ? 9n : null,
    state === "unknown" ? "합성: 응답 잃음" : null,
  );
}

function resolve_dispatch(env: ApiEnv, dispatch_id: string, outcome: "charged" | "not_charged"): void {
  env.db.run(
    `INSERT INTO dispatch_resolutions (dispatch_id, project_id, outcome, note, resolved_by, resolved_at)
     VALUES (?, ?, ?, '합성 정리', ?, 10)`,
    dispatch_id,
    env.p.project_id,
    outcome,
    env.p.actor_id,
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// 1. 정책

test("policy: allow_opencode_go=1 → allowed, after Go off → denied, back on → allowed; the bit is the whole rule", async () => {
  await with_api(async (env) => {
    assert.equal((await read(env)).ai_connection.policy, "allowed", "a new project allows (stage-0 7-1 initial policy)");
    await go_off(env);
    assert.equal((await read(env)).ai_connection.policy, "denied");
    env.seq += 1;
    const { set_policy } = await import("../scripts/pes_core/policy.ts");
    await set_policy(env.service, env.ctx(`go-on-${env.seq}`), { allow_opencode_go: true, reason: "합성: 다시 켬" });
    assert.equal((await read(env)).ai_connection.policy, "allowed");
  });
});

test("policy: a project with no policy pointer → missing; a rewound pointer (an older, allowing row) → corrupt — never allowed", async () => {
  await with_api(async (env) => {
    await go_off(env); // rev 2 (denied)
    const first = env.db.get<{ id: string }>("SELECT id FROM project_policy_versions WHERE project_id = ? ORDER BY policy_rev ASC LIMIT 1", env.p.project_id)!;
    const newest = env.db.get<{ id: string }>("SELECT current_policy_id AS id FROM projects WHERE id = ?", env.p.project_id)!;
    env.db.run("UPDATE projects SET current_policy_id = ? WHERE id = ?", first.id, env.p.project_id); // rev 1 allows, but the pointer is rewound
    assert.equal((await read(env)).ai_connection.policy, "corrupt", "a rewound pointer is damage, not an old policy");
    env.db.run("UPDATE projects SET current_policy_id = NULL WHERE id = ?", env.p.project_id);
    assert.equal((await read(env)).ai_connection.policy, "missing");
    env.db.run("UPDATE projects SET current_policy_id = ? WHERE id = ?", newest.id, env.p.project_id);
    assert.equal((await read(env)).ai_connection.policy, "denied", "repaired pointer reads normally again");
  });
});

test("policy: never 'pending' (no DB evidence for 'not yet decided'), and the AI connection selection does not change it", async () => {
  await with_api(async (env) => {
    const seen = new Set<string>();
    seen.add((await read(env)).ai_connection.policy);
    await go_off(env);
    seen.add((await read(env)).ai_connection.policy);
    assert.ok(!seen.has("pending"));
    for (const p of seen) assert.ok(["allowed", "denied", "missing", "corrupt"].includes(p));
    // a selection row exists but the policy stays the bit's answer
    const user = env.db.get<{ id: string }>("SELECT id FROM users LIMIT 1")!.id;
    env.db.run(
      `INSERT INTO ai_connections (id, owner_user_id, name, kind, request_format, base_url, billing, key_ref, key_last4, key_storage,
          key_set_at, key_set_by, cost_cap_currency, cost_cap_micros, created_at, updated_at)
       VALUES ('conn-1', ?, '합성 연결', 'custom', 'openai_compatible', 'https://example.invalid/v1', 'pay_per_use', 'ref-1', 'abcd', 'memory', 1, ?, 'USD', 1000, 1, 1)`,
      user,
      env.p.actor_id,
    );
    env.db.run("INSERT INTO project_ai_selections (id, project_id, connection_id, model, selected_by, selected_at) VALUES ('sel-1', ?, 'conn-1', 'm', ?, 1)", env.p.project_id, env.p.actor_id);
    assert.equal((await read(env)).ai_connection.policy, "denied", "denied stays denied with a connection selected");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// 2. 전송 (outbound_dispatches)

test("dispatches: a project that sent nothing has an empty list, not a made-up row", async () => {
  await with_api(async (env) => {
    const data = await read(env);
    assert.deepEqual(data.ai_connection.dispatches, []);
  });
});

test("dispatches: all 8 DB states come through verbatim, in creation order, with exactly the agreed keys", async () => {
  await with_api(async (env) => {
    await drive_stage(env, stage_ids(env.db, edition_of(env)).plan, "ws87-d"); // gives an object version for `adopted`
    add_run(env, "run-d", { mode: "A" });
    DB_DISPATCH_STATES.forEach((state) => add_dispatch(env, `disp-${state}`, "run-d", state));
    const list = (await read(env)).ai_connection.dispatches as any[];
    assert.deepEqual(list.map((d) => d.id), DB_DISPATCH_STATES.map((s) => `disp-${s}`));
    assert.deepEqual(list.map((d) => d.state), [...DB_DISPATCH_STATES], "the DB value, not renamed or merged");
    for (const d of list) {
      assert.equal(d.run_id, "run-d");
      assert.deepEqual(Object.keys(d).sort(), ["id", "run_id", "state"], `${d.id}: no resolution row → no resolution key, no cancel_state`);
    }
  });
});

test("dispatches: no cancel_state is ever invented (the DB has no cancel evidence), and 'cancel_requested' is never a state", async () => {
  await with_api(async (env) => {
    add_run(env, "run-c", { mode: "A" });
    for (const state of ["prepared", "authorized", "sent", "unknown", "failed", "blocked"]) add_dispatch(env, `c-${state}`, "run-c", state);
    const data = await read(env);
    assert.equal(data.ai_connection.dispatches.length, 6, "the dispatches are listed (so the absence below means something)");
    assert.doesNotMatch(JSON.stringify(data), /cancel_state|cancel_requested/);
  });
});

test("dispatches: a settled unknown call carries resolution (charged / not_charged) beside the still-'unknown' state", async () => {
  await with_api(async (env) => {
    add_run(env, "run-r", { mode: "A" });
    add_dispatch(env, "disp-a", "run-r", "unknown");
    add_dispatch(env, "disp-b", "run-r", "unknown");
    add_dispatch(env, "disp-c", "run-r", "unknown");
    resolve_dispatch(env, "disp-a", "charged");
    resolve_dispatch(env, "disp-b", "not_charged");
    const by = Object.fromEntries(((await read(env)).ai_connection.dispatches as any[]).map((d) => [d.id, d]));
    assert.equal(by["disp-a"].state, "unknown", "settling does not rewrite the call row (stage-2-db-guarantees 8.16)");
    assert.equal(by["disp-a"].resolution, "charged");
    assert.equal(by["disp-b"].resolution, "not_charged");
    assert.equal(Object.hasOwn(by["disp-c"], "resolution"), false, "unsettled: the key is absent, not null");
  });
});

test("dispatches: nothing secret or internal leaves (hashes, request keys, external ids, blob ids, usage, cost)", async () => {
  await with_api(async (env) => {
    add_run(env, "run-s", { mode: "A" });
    add_dispatch(env, "disp-s", "run-s", "sent");
    const data = await read(env);
    assert.equal(data.ai_connection.dispatches.length, 1);
    const text = JSON.stringify(data);
    assert.doesNotMatch(text, /request-key-|external-request-|payload_hash|manifest_blob|blob-disp|usage_json|cost_json|allowance|bbbbbbbbbb/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// 3. 과거 승인

test("past_approval: an approved stage that went stale keeps its approval (verified, ISO time); view is stale", async () => {
  await with_api(async (env) => {
    const ids = stage_ids(env.db, edition_of(env));
    await drive_stage(env, ids.plan, "ws87-pa");
    const fresh = (await read(env)).stages.find((s: any) => s.key === "plan");
    assert.equal(fresh.view, "approved");
    assert.equal(fresh.past_approval.origin, "verified");
    assert.match(fresh.past_approval.at, ISO);
    const seq = env.db.get<{ seq: bigint }>("SELECT max(event_seq) AS seq FROM events WHERE project_id = ?", env.p.project_id)!.seq;
    env.db.run("UPDATE stages SET stale_since_event_seq = ? WHERE id = ?", seq, ids.plan);
    const stale = (await read(env)).stages.find((s: any) => s.key === "plan");
    assert.equal(stale.view, "stale");
    assert.deepEqual(stale.past_approval, fresh.past_approval, "stale does not erase the fact that it was approved");
    assert.deepEqual(Object.keys(stale.past_approval).sort(), ["at", "origin"]);
  });
});

test("past_approval: a legacy approval is origin legacy_unverified, and a stage never approved has no past_approval key", async () => {
  await with_api(async (env) => {
    const ids = stage_ids(env.db, edition_of(env));
    await drive_stage(env, ids.plan, "ws87-lg");
    env.db.run("UPDATE approvals SET origin = 'legacy', assurance = 'legacy_unverified' WHERE stage_id = ?", ids.plan);
    const stages = (await read(env)).stages as any[];
    assert.equal(stages.find((s) => s.key === "plan").past_approval.origin, "legacy_unverified");
    for (const s of stages.filter((x) => x.key !== "plan")) assert.equal(Object.hasOwn(s, "past_approval"), false, `${s.key}: never approved → no key`);
  });
});

test("past_approval: a legacy approval whose commit time is unknown (0) gives at = null, not a made-up date", async () => {
  await with_api(async (env) => {
    const ids = stage_ids(env.db, edition_of(env));
    await drive_stage(env, ids.plan, "ws87-lg0");
    env.db.run("UPDATE approvals SET origin = 'legacy', assurance = 'legacy_unverified' WHERE stage_id = ?", ids.plan);
    env.db.run("UPDATE mutation_commits SET created_at = 0 WHERE id = (SELECT tx_id FROM approvals WHERE stage_id = ?)", ids.plan);
    const plan = (await read(env)).stages.find((s: any) => s.key === "plan");
    assert.deepEqual(plan.past_approval, { at: null, origin: "legacy_unverified" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// 4. runs

test("runs: none → an empty list (the field exists, 0 runs is stated, not guessed)", async () => {
  await with_api(async (env) => {
    assert.deepEqual((await read(env)).runs, []);
  });
});

test("runs: the DB status comes through verbatim (incl. blocked_usage), in creation order, with id, stage, mode", async () => {
  await with_api(async (env) => {
    const statuses = ["queued", "running", "waiting_human", "blocked_usage", "succeeded", "failed", "cancelled", "interrupted"];
    statuses.forEach((status, i) => add_run(env, `run-${status}`, { status, mode: i % 2 === 0 ? "A" : "B" }));
    const runs = (await read(env)).runs as any[];
    assert.deepEqual(runs.map((r) => r.id), statuses.map((s) => `run-${s}`));
    assert.deepEqual(runs.map((r) => r.status), statuses);
    assert.deepEqual(runs.map((r) => r.mode), statuses.map((_, i) => (i % 2 === 0 ? "A" : "B")));
    for (const r of runs) {
      assert.equal(r.stage, "research");
      assert.deepEqual(Object.keys(r).sort(), ["id", "mode", "stage", "status"], "no external_stop: the DB has no evidence for it");
    }
  });
});

test("runs: a run without a stage has stage null", async () => {
  await with_api(async (env) => {
    add_run(env, "run-nostage", { stage: null });
    const run = ((await read(env)).runs as any[]).find((r) => r.id === "run-nostage");
    assert.equal(run.stage, null);
  });
});

test("runs: handed_off only for a hand-off import run (runtime *_app_handoff); an ordinary run with a parent is not handed_off", async () => {
  await with_api(async (env) => {
    add_run(env, "run-hc", { runtime: "claude_app_handoff" });
    add_run(env, "run-hx", { runtime: "codex_app_handoff" });
    add_run(env, "run-ho", { runtime: "opencode_app_handoff" });
    add_run(env, "run-plain", {});
    add_run(env, "run-child", {});
    env.db.run("UPDATE runs SET parent_run_id = 'run-plain' WHERE id = 'run-child'");
    const by = Object.fromEntries(((await read(env)).runs as any[]).map((r) => [r.id, r.status]));
    assert.equal(by["run-hc"], "handed_off");
    assert.equal(by["run-hx"], "handed_off");
    assert.equal(by["run-ho"], "handed_off");
    assert.equal(by["run-plain"], "succeeded");
    assert.equal(by["run-child"], "succeeded", "parent_run_id alone is not a hand-off");
  });
});

test("run_permissions: the server has no store for external-app questions, so it does not send the field at all", async () => {
  await with_api(async (env) => {
    add_run(env, "run-p", {});
    const data = await read(env);
    assert.equal(data.runs.length, 1, "runs are sent (so the absence below means something)");
    assert.equal(Object.hasOwn(data, "run_permissions"), false, "absent = '정보 없음' on screen; an empty list would claim 'none'");
    assert.doesNotMatch(JSON.stringify(data), /external_app|pes_tool|external_stop/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// 5. 권한 · 격리 · 읽기 전용 · 기존 칸 유지

test("another project's runs, dispatches and approvals never show up here", async () => {
  await with_api(async (env) => {
    const other = (await env.service.execute(
      { project_id: null, actor_id: null, via: "cli", client_request_id: "ws87-other" },
      "project.bootstrap",
      { slug: "other-synthetic", topic: "합성 다른 주제", owner_display_name: "합성 다른 소유자" },
    )).result as { project_id: string; owner_actor_id: string };
    add_run(env, "run-mine", {});
    add_run(env, "run-theirs", { project_id: other.project_id, actor_id: other.owner_actor_id });
    add_dispatch(env, "disp-theirs", "run-theirs", "sent", other.project_id, other.owner_actor_id);
    const data = await read(env);
    assert.deepEqual((data.runs as any[]).map((r) => r.id), ["run-mine"]);
    assert.deepEqual(data.ai_connection.dispatches, []);
    assert.doesNotMatch(JSON.stringify(data), /theirs|other-synthetic/);
  });
});

test("a context:read token reads the same new fields as the owner; a token without context:read is still 403", async () => {
  await with_api(async (env) => {
    add_run(env, "run-t", {});
    const reader = await make_agent(env, "reader87", ["context:read"]);
    const owner = await read(env);
    const token = await read(env, { token: reader.token });
    assert.ok(owner.ai_connection !== undefined && Array.isArray(owner.runs), "the new fields exist for the owner");
    assert.deepEqual(token.ai_connection, owner.ai_connection);
    assert.deepEqual(token.runs, owner.runs);
    assert.deepEqual(token.stages, owner.stages);
    const noscope = await make_agent(env, "noscope87", ["run:claim"]);
    assert.equal((await call(env, { method: "GET", path: WS(env), auth: { token: noscope.token } })).status, 403);
  });
});

test("the existing fields are untouched and the new ones add to them; no Korean screen words in the new fields; reading writes nothing", async () => {
  await with_api(async (env) => {
    await drive_stage(env, stage_ids(env.db, edition_of(env)).plan, "ws87-keep");
    add_run(env, "run-k", { mode: "A" });
    add_dispatch(env, "disp-k", "run-k", "sent");
    const before = state_signature(env.db);
    const data = await read(env);
    for (const key of ["slug", "title", "edition", "mode", "current", "stages", "turn", "actions", "records", "ai_connection", "runs"]) {
      assert.ok(Object.hasOwn(data, key), `data.${key}`);
    }
    assert.doesNotMatch(JSON.stringify({ ai: data.ai_connection, runs: data.runs }), /[가-힣]/, "machine values only");
    assert.equal(state_signature(env.db), before, "GET workspace stays read-only");
  });
});

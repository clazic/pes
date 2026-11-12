/**
 * SEL-87 1차 리뷰(R1) 수정 시험 — 필수 1 · 권장 1~4 (mid-worker). 합성 DB · 임시 HOME 뿐.
 *   필수 1  runs 는 활성 판(edition)의 것만 — 이전 판의 run 이 섞이지 않는다.
 *   R1-2 필수 1  dispatches 는 판과 무관한 프로젝트 전체 최근 50건 — 이전 판에서 나간 sent/unknown 전송도 남는다(전송·청구는 프로젝트 단위 사실). runs 만 활성 판.
 *   권장 2  runs 의 50건 상한은 활성 판 안에서 센다(이전 판의 많은 행이 쓰지 않는다) · dispatches 는 프로젝트 전체 기준 · 상한 안에서 오래된 것부터.
 *   권장 3  승인 시각이 Date 범위 밖(손상)이어도 읽기는 200, past_approval.at 은 null.
 *   권장 4  past_approval 은 같은 단계의 가장 나중 승인 행(rowid)에서 온다 — 시각이 더 이르거나 origin 이 달라도.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { assert_ok, call, with_api, type ApiEnv } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { drive_stage, stage_ids } from "./helpers/editions_env.ts";

const WS = (env: ApiEnv) => P(env, "/workspace");
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

async function read(env: ApiEnv): Promise<any> {
  return assert_ok(await call(env, { method: "GET", path: WS(env), auth: "owner" }));
}

function edition_of(env: ApiEnv, project_id = env.p.project_id): string {
  return env.db.get<{ id: string }>("SELECT active_edition_id AS id FROM projects WHERE id = ?", project_id)!.id;
}

/** edition.create (a draft with six pending stages), then make it the active one the way the tests elsewhere do. */
async function activate_new_edition(env: ApiEnv, key: string): Promise<string> {
  const out = await env.service.execute(
    { project_id: env.p.project_id, actor_id: env.p.actor_id, via: "cli", client_request_id: key },
    "edition.create",
    { parent_edition_id: edition_of(env) },
  );
  const edition_id = (out.result as { edition_id: string }).edition_id;
  env.db.run("UPDATE projects SET active_edition_id = ? WHERE id = ?", edition_id, env.p.project_id);
  return edition_id;
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

function activate(env: ApiEnv, edition_id: string): void {
  env.db.run("UPDATE projects SET active_edition_id = ? WHERE id = ?", edition_id, env.p.project_id);
}

const ids_of = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id);

// ---------------------------------------------------------------------------------------------------------------------------------------
// 필수 1 · 권장 1 — 활성 판만

test("edition: a new active edition shows none of the previous edition's runs, but keeps the project's earlier dispatches (unknown / sent / resolved)", async () => {
  await with_api(async (env) => {
    add_run(env, "run-old-1", {});
    add_run(env, "run-old-2", { status: "blocked_usage", mode: "A" });
    add_dispatch(env, "disp-old-1", "run-old-1", "unknown");
    add_dispatch(env, "disp-old-2", "run-old-2", "sent");
    add_dispatch(env, "disp-old-3", "run-old-1", "response");
    resolve_dispatch(env, "disp-old-3", "charged");
    assert.deepEqual(ids_of((await read(env)).runs), ["run-old-1", "run-old-2"], "before the switch they are the active edition's");
    const old_edition = edition_of(env);

    await activate_new_edition(env, "ws87-r1-ed2");
    const fresh = await read(env);
    assert.equal(fresh.edition, 2);
    assert.deepEqual(fresh.runs, [], "the old edition's runs are not mixed into the new edition");
    // leader 승인: 리뷰 필수 1에 따라 단언 반전 — what was sent (and what is unsettled) is a project fact, not an edition one
    assert.deepEqual(
      fresh.ai_connection.dispatches,
      [
        { id: "disp-old-1", run_id: "run-old-1", state: "unknown" },
        { id: "disp-old-2", run_id: "run-old-2", state: "sent" },
        { id: "disp-old-3", run_id: "run-old-1", state: "response", resolution: "charged" },
      ],
      "an earlier edition's dispatches stay (the unknown one has no resolution yet; the settled one carries it)",
    );

    add_run(env, "run-new-1", { stage: stage_ids(env.db, edition_of(env)).plan });
    add_dispatch(env, "disp-new-1", "run-new-1", "sent");
    const mixed = await read(env);
    assert.deepEqual(ids_of(mixed.runs), ["run-new-1"]);
    assert.equal(mixed.runs[0].stage, "plan", "the stage key is the new edition's stage row");
    assert.deepEqual(ids_of(mixed.ai_connection.dispatches), ["disp-old-1", "disp-old-2", "disp-old-3", "disp-new-1"], "project-wide, oldest first");
    assert.doesNotMatch(JSON.stringify(mixed.runs), /run-old/, "runs stay the active edition's only");

    activate(env, old_edition);
    const back = await read(env);
    assert.deepEqual(ids_of(back.runs), ["run-old-1", "run-old-2"], "and the other way: the old edition shows only its own");
    assert.deepEqual(ids_of(back.ai_connection.dispatches), ["disp-old-1", "disp-old-2", "disp-old-3", "disp-new-1"], "dispatches do not depend on which edition is active");
  });
});

test("edition: the runs cap is counted inside the active edition; the dispatches cap is the newest 50 of the whole project", async () => {
  await with_api(async (env) => {
    const pad = (i: number) => String(i).padStart(3, "0");
    for (let i = 1; i <= 55; i += 1) add_run(env, `run-a${pad(i)}`, { mode: "A" });
    for (let i = 1; i <= 55; i += 1) add_dispatch(env, `disp-a${pad(i)}`, `run-a${pad(i)}`, "sent");
    await activate_new_edition(env, "ws87-r1-cap");
    for (let i = 1; i <= 3; i += 1) add_run(env, `run-b${pad(i)}`, { mode: "A" });
    for (let i = 1; i <= 3; i += 1) add_dispatch(env, `disp-b${pad(i)}`, `run-b${pad(i)}`, "sent");
    const data = await read(env);
    assert.deepEqual(ids_of(data.runs), ["run-b001", "run-b002", "run-b003"], "newer rowids of the active edition only; the 55 old ones are not in the 50");
    const dispatches = ids_of(data.ai_connection.dispatches);
    assert.equal(dispatches.length, 50, "newest 50 of the project: 47 old + 3 new");
    assert.equal(dispatches[0], "disp-a009");
    assert.deepEqual(dispatches.slice(-4), ["disp-a055", "disp-b001", "disp-b002", "disp-b003"]);
  });
});

test("edition: within one edition the cap is still the newest 50, oldest first, with the resolution riding on its dispatch", async () => {
  await with_api(async (env) => {
    const pad = (i: number) => String(i).padStart(3, "0");
    for (let i = 1; i <= 52; i += 1) add_run(env, `run-${pad(i)}`, {});
    for (let i = 1; i <= 52; i += 1) add_dispatch(env, `disp-${pad(i)}`, `run-${pad(i)}`, i === 52 ? "unknown" : "sent");
    resolve_dispatch(env, "disp-052", "charged");
    resolve_dispatch(env, "disp-001", "not_charged");
    const data = await read(env);
    assert.equal(data.runs.length, 50);
    assert.deepEqual(ids_of(data.runs).slice(0, 2), ["run-003", "run-004"]);
    const dispatches = data.ai_connection.dispatches as any[];
    assert.equal(dispatches.length, 50);
    assert.equal(dispatches[0].id, "disp-003");
    assert.equal(Object.hasOwn(dispatches[0], "resolution"), false, "no resolution row → no key");
    assert.deepEqual(dispatches[49], { id: "disp-052", run_id: "run-052", state: "unknown", resolution: "charged" });
    assert.ok(!ids_of(dispatches).includes("disp-001"), "the resolved-but-old one is outside the newest 50");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// 권장 3 — 범위 밖 시각

test("past_approval: a commit time past the Date range (damaged) gives at = null; the read stays 200 and other stages are fine", async () => {
  await with_api(async (env) => {
    const ids = stage_ids(env.db, edition_of(env));
    await drive_stage(env, ids.plan, "ws87-r1-big");
    const tx = env.db.get<{ tx_id: string }>("SELECT tx_id FROM approvals WHERE stage_id = ?", ids.plan)!.tx_id;
    for (const bad of [9_000_000_000_000_000n, 9_223_372_036_854_775_807n]) {
      env.db.run("UPDATE mutation_commits SET created_at = ? WHERE id = ?", bad, tx);
      const res = await call(env, { method: "GET", path: WS(env), auth: "owner" });
      assert.equal(res.status, 200, `created_at ${bad} must not turn the whole read into an error`);
      const plan = (res.json as any).data.stages.find((s: any) => s.key === "plan");
      assert.deepEqual(plan.past_approval, { at: null, origin: "verified" }, `created_at ${bad}`);
      assert.equal(plan.view, "approved");
    }
    env.db.run("UPDATE mutation_commits SET created_at = 8_640_000_000_000_000 WHERE id = ?", tx);
    const edge = (await read(env)).stages.find((s: any) => s.key === "plan");
    assert.match(edge.past_approval.at, /^\+?275760-09-13T00:00:00/, "the last valid instant is still shown");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// 권장 4 — 가장 나중 승인 행

test("past_approval: with two approval rows of one stage, at and origin come from the LATER row (not the earlier time, not the first row)", async () => {
  await with_api(async (env) => {
    const ids = stage_ids(env.db, edition_of(env));
    await drive_stage(env, ids.plan, "ws87-r1-two");
    const first = env.db.get<{ id: string; snapshot_id: string; actor_id: string; actor_kind: string; human_user_id: string; tx_id: string }>(
      "SELECT id, snapshot_id, actor_id, actor_kind, human_user_id, tx_id FROM approvals WHERE stage_id = ?",
      ids.plan,
    )!;
    const other_tx = env.db.get<{ id: string }>("SELECT id FROM mutation_commits WHERE project_id = ? AND id <> ? ORDER BY rowid LIMIT 1", env.p.project_id, first.tx_id)!.id;
    // the first row: a legacy approval stamped LATER in time; the second row (inserted after it): verified, stamped EARLIER
    env.db.run("UPDATE approvals SET origin = 'legacy', assurance = 'legacy_unverified' WHERE id = ?", first.id);
    env.db.run("UPDATE mutation_commits SET created_at = 1700000000000 WHERE id = ?", first.tx_id);
    env.db.run("UPDATE mutation_commits SET created_at = 1600000000000 WHERE id = ?", other_tx);
    env.db.run(
      `INSERT INTO approvals (id, project_id, stage_id, snapshot_id, actor_id, actor_kind, human_user_id, origin, assurance, tx_id)
       VALUES ('approval-later', ?, ?, ?, ?, ?, ?, 'new', 'verified', ?)`,
      env.p.project_id,
      ids.plan,
      first.snapshot_id,
      first.actor_id,
      first.actor_kind,
      first.human_user_id,
      other_tx,
    );
    const plan = (await read(env)).stages.find((s: any) => s.key === "plan");
    assert.deepEqual(plan.past_approval, { at: new Date(1600000000000).toISOString(), origin: "verified" });
    assert.match(plan.past_approval.at, ISO);

    // and the other way round: the later row is the legacy one → legacy_unverified, with its own time
    env.db.run("DELETE FROM approvals WHERE id = 'approval-later'");
    env.db.run("UPDATE approvals SET origin = 'new', assurance = 'verified' WHERE id = ?", first.id);
    env.db.run(
      `INSERT INTO approvals (id, project_id, stage_id, snapshot_id, actor_id, actor_kind, human_user_id, origin, assurance, tx_id)
       VALUES ('approval-later-2', ?, ?, ?, ?, ?, ?, 'legacy', 'legacy_unverified', ?)`,
      env.p.project_id,
      ids.plan,
      first.snapshot_id,
      first.actor_id,
      first.actor_kind,
      first.human_user_id,
      other_tx,
    );
    const flipped = (await read(env)).stages.find((s: any) => s.key === "plan");
    assert.deepEqual(flipped.past_approval, { at: new Date(1600000000000).toISOString(), origin: "legacy_unverified" });
  });
});

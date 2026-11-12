/**
 * SEL-93 U3a — Opus 최종 리뷰 2/2 필수 1·2, 권장 3 의 새 동작 (mid-worker). 기존 시험의 단언은 바꾸지 않는다.
 *
 * 필수 1 (코어): 판 범위 결정의 대체(decision.supersede)가 만든 새 결정은 **옛 결정이 속한 판**에 들어간다
 *   (draft 복사본을 대체해도 활성 판에는 아무것도 안 생긴다). 프로젝트 범위 새 결정은 활성 판에 들어간다(그대로).
 * 필수 2 (API): 같은 Idempotency-Key·같은 본문의 대체 요청은 첫 응답을 재생(201 replayed:true, 쓰기 없음),
 *   같은 키·다른 본문은 409 idempotency_key_reuse.
 * 권장 3: "draft 판은 열려 있다"를 활성 판 status 를 바꿔 흉내 내지 않고 실제 edition.create 복사본(다른 판 id)으로 확인한다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { assert_ok, call, with_api, type ApiEnv, type Auth } from "./helpers/api_env.ts";
import { P, assert_final_error } from "./helpers/api_flow.ts";
import { count } from "./helpers/sel93_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const post = (env: ApiEnv, rest: string, auth: Auth, body: unknown, key?: string) =>
  call(env, { method: "POST", path: P(env, rest), auth, body, ...(key === undefined ? {} : { key }) });
const get = (env: ApiEnv, rest: string, auth: Auth = "owner") => call(env, { method: "GET", path: P(env, rest), auth });

async function proposed(env: ApiEnv, scope: string, statement: string): Promise<any> {
  return assert_ok(await post(env, "/decisions", "owner", { scope, statement, state: "proposed", supersedes: null }), 201).decision;
}

async function adopted(env: ApiEnv, scope: string, statement: string): Promise<any> {
  const d = await proposed(env, scope, statement);
  return assert_ok(await post(env, "/decisions", "owner", { scope, statement, state: "adopted", supersedes: null, decision_id: d.id, base_version_id: d.version_id }), 201).decision;
}

function active_edition(env: ApiEnv): string {
  return env.db.get<{ id: string }>("SELECT active_edition_id AS id FROM projects WHERE id = ?", env.p.project_id)!.id;
}

/** A real edition.create copy (draft, its own edition id); the active edition stays the old one. */
async function make_draft(env: ApiEnv, key: string): Promise<string> {
  const out = await env.service.execute(env.ctx(key), "edition.create", { parent_edition_id: active_edition(env) });
  const edition_id = (out.result as { edition_id: string }).edition_id;
  assert.notEqual(edition_id, active_edition(env));
  assert.equal(env.db.get<{ status: string }>("SELECT status FROM editions WHERE id = ?", edition_id)?.status, "draft");
  return edition_id;
}

function copy_in(env: ApiEnv, edition_id: string, kind: "decision" | "assumption"): { object_id: string; version_id: string } {
  const row = env.db.get<{ object_id: string; version_id: string }>(
    "SELECT id AS object_id, current_version_id AS version_id FROM objects WHERE project_id = ? AND edition_id = ? AND kind = ? ORDER BY display_no",
    env.p.project_id,
    edition_id,
    kind,
  );
  assert.ok(row, `the draft edition has a ${kind} copy`);
  return row;
}

/** Live (adopted) decisions that belong to one edition. */
function adopted_in(env: ApiEnv, edition_id: string): number {
  return Number(
    env.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM objects o JOIN decision_versions v ON v.project_id = o.project_id AND v.version_id = o.current_version_id
        WHERE o.project_id = ? AND o.edition_id = ? AND o.kind = 'decision' AND v.state = 'adopted'`,
      env.p.project_id,
      edition_id,
    )!.n,
  );
}

function edition_of_object(env: ApiEnv, object_id: string): string | null {
  return env.db.get<{ edition_id: string | null }>("SELECT edition_id FROM objects WHERE id = ?", object_id)!.edition_id;
}

// ---------------------------------------------------------------------------
// 필수 1

test("superseding the draft copy of an edition-scope decision puts the new decision in the draft edition; the active edition is untouched", async () => {
  await with_api(async (env) => {
    const parent = await adopted(env, "edition", "활성 판의 판 범위 결정");
    const active = active_edition(env);
    const draft = await make_draft(env, "d2-edition");
    const copy = copy_in(env, draft, "decision");
    assert.notEqual(copy.object_id, parent.id, "the copy is its own object");

    const active_adopted = adopted_in(env, active);
    const list_before = assert_ok(await get(env, "/decisions")).decisions.length;
    const ws_before = assert_ok(await get(env, "/workspace")).records.decisions.count;

    const out = await env.service.execute(env.ctx("d2-sup"), "decision.supersede", {
      decision_id: copy.object_id,
      base_version_id: copy.version_id,
      statement: "초안 판에서 바꾼 결정",
      rationale: "새 판 준비 중 판단",
    });
    const new_id = (out.result as { decision_id: string }).decision_id;
    assert.equal(edition_of_object(env, new_id), draft, "the replacement lives in the edition of the decision it replaces");
    assert.equal(adopted_in(env, active), active_adopted, "the active edition gained no adopted decision");
    assert.equal(adopted_in(env, draft), 1, "the draft edition holds exactly the replacement (the copy is superseded)");
    assert_ok(await get(env, "/decisions")); // still readable
    assert.equal(assert_ok(await get(env, "/decisions")).decisions.length, list_before, "GET decisions (active edition) did not change");
    assert.equal(assert_ok(await get(env, "/workspace")).records.decisions.count, ws_before, "workspace decision count did not change");
    const parent_state = env.db.get<{ state: string }>(
      "SELECT v.state AS state FROM objects o JOIN decision_versions v ON v.project_id = o.project_id AND v.version_id = o.current_version_id WHERE o.id = ?",
      parent.id,
    );
    assert.equal(parent_state?.state, "adopted", "the active edition's own decision stays adopted");
  });
});

test("superseding in the active edition keeps the replacement there; a project-scope replacement goes to the active edition too", async () => {
  await with_api(async (env) => {
    const active = active_edition(env);
    const edition_decision = await adopted(env, "edition", "활성 판 결정");
    const project_decision = await adopted(env, "project", "프로젝트 결정");
    await make_draft(env, "d2-keep");

    const a = await env.service.execute(env.ctx("d2-a"), "decision.supersede", {
      decision_id: edition_decision.id,
      base_version_id: edition_decision.version_id,
      statement: "활성 판 대체",
      rationale: "이유",
    });
    assert.equal(edition_of_object(env, (a.result as any).decision_id), active);
    const b = await env.service.execute(env.ctx("d2-b"), "decision.supersede", {
      decision_id: project_decision.id,
      base_version_id: project_decision.version_id,
      statement: "프로젝트 대체",
      rationale: "이유",
    });
    assert.equal(edition_of_object(env, (b.result as any).decision_id), active, "a project-scope replacement stays where it was always put");
  });
});

// ---------------------------------------------------------------------------
// 필수 2

test("replaying a supersede request (same key, same body) replays the first 201; the same key with another body is idempotency_key_reuse", async () => {
  await with_api(async (env) => {
    const d = await adopted(env, "edition", "대체될 결정");
    const body = { scope: "edition", statement: "대체한 결정", state: "adopted", supersedes: d.id, base_version_id: d.version_id, rationale: "이유" };
    const first = await post(env, "/decisions", "owner", body, "sup-replay");
    const data = assert_ok(first, 201);
    assert.notEqual(first.json.replayed, true);

    const sig = state_signature(env.db);
    const decisions = count(env.db, "decisions");
    const again = await post(env, "/decisions", "owner", body, "sup-replay");
    assert.equal(again.json.replayed, true, "the replay is flagged");
    assert.deepEqual(assert_ok(again, 201), data, "the replay carries the first response's data");
    assert.equal(state_signature(env.db), sig, "a replay writes nothing");
    assert.equal(count(env.db, "decisions"), decisions);

    assert_final_error(await post(env, "/decisions", "owner", { ...body, statement: "다른 문장" }, "sup-replay"), 409, "idempotency_key_reuse");

    // a new key for the same (now superseded) target is still the plain conflict
    assert_final_error(await post(env, "/decisions", "owner", body, "sup-fresh"), 409, "supersedes_conflict");
  });
});

// ---------------------------------------------------------------------------
// 권장 3

test("a real edition.create copy (draft, another edition id) is open to judgement: assumption assess, decision adopt / revoke / supersede", async () => {
  await with_api(async (env) => {
    const active = active_edition(env);
    const assumption = assert_ok(
      await post(env, "/assumptions", "owner", { format_version: "1.0", statement: "복사될 가정", state: "proposed", rationale: "합성 배경", scope: "edition" }),
      201,
    ).assumption;
    assert.ok(assumption.id);
    await adopted(env, "edition", "복사될 결정");
    const draft = await make_draft(env, "d3");
    const a_copy = copy_in(env, draft, "assumption");
    const d_copy = copy_in(env, draft, "decision");
    assert.equal(edition_of_object(env, a_copy.object_id), draft);

    // assumption judgement on the draft copy
    await env.service.execute(env.ctx("d3-as"), "decision.revoke", { decision_id: d_copy.object_id, base_version_id: d_copy.version_id, rationale: "초안 판에서 폐기" });
    const assessed = await env.service.execute(env.ctx("d3-assess"), "assumption.assess", { assumption_id: a_copy.object_id, base_version_id: a_copy.version_id, state: "confirmed" });
    assert.equal((assessed.result as any).state, "confirmed");

    // decision adoption: a proposal that lives in the draft edition (made while the draft was the active one), then judged while it is not
    env.db.run("UPDATE projects SET active_edition_id = ? WHERE id = ?", draft, env.p.project_id);
    const p = await env.service.execute(env.ctx("d3-p"), "decision.propose", { statement: "초안 판의 제안", scope: "edition" });
    env.db.run("UPDATE projects SET active_edition_id = ? WHERE id = ?", active, env.p.project_id);
    const proposal = p.result as { object_id: string; version_id: string };
    assert.equal(edition_of_object(env, proposal.object_id), draft);
    assert.notEqual(active_edition(env), draft);
    const adopt = await env.service.execute(env.ctx("d3-adopt"), "decision.adopt", { decision_id: proposal.object_id, base_version_id: proposal.version_id });
    assert.equal((adopt.result as any).state, "adopted");
    const sup = await env.service.execute(env.ctx("d3-sup"), "decision.supersede", {
      decision_id: proposal.object_id,
      base_version_id: (adopt.result as any).version_id,
      statement: "초안 판에서 대체",
      rationale: "이유",
    });
    assert.equal(edition_of_object(env, (sup.result as any).decision_id), draft);
  });
});

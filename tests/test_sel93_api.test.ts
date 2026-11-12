/**
 * SEL-93 U3a — HTTP: POST P/assumptions · P/decisions · P/reflections 와 읽기 경로 (tester, 작성 모드).
 * 구현 전에는 세 POST 가 501 not_supported, GET 이 404 라서 실패하는 것이 정상.
 *
 * 있던 것: 세 POST 는 `unsupported`(501) 로 등록돼 있었다. docs/plan/fixtures/api-v1/{assumptions,decisions,reflections}.json 이 문서 계약이다
 *   (요청/응답 모양·오류 코드). 이 시험은 그 문서 계약 그대로를 구현의 정답으로 삼는다.
 *
 * 정한 해석:
 *   POST P/assumptions  본문은 문서 픽스처 모양 {format_version?, statement, state, rationale?, scope?}.
 *       state "proposed" → 새 가정 제안(소유자 세션 또는 에이전트 토큰 모두). scope 는 받아서 무시(문서 본문에 있다).
 *       state "confirmed"|"rejected"|"revised" + {assumption_id, base_version_id} → 사람 판단(소유자 세션만; 토큰은 403 human_required).
 *       응답 201 data.assumption = {id, version_id, state, needs_review, assessed_by_actor_id} (키 집합 고정, 판단 응답도 같은 키).
 *       빈 statement → 422 validation_failed target "$.body.statement", next_action fix_request.
 *   POST P/decisions    본문 {scope, statement, state, supersedes|null, rationale?, decision_id?, base_version_id?}.
 *       state "proposed" → 제안(세션/토큰). state "adopted"+{decision_id, base_version_id} → 채택(사람만). state "adopted"+supersedes+{base_version_id}
 *       → 대체(사람만; 새 결정 만들고 옛 결정은 superseded). state "revoked"+{decision_id, base_version_id, rationale} → 폐기(사람만).
 *       응답 201 data.decision = {id, version_id, state, scope} (키 집합 고정). 대체 대상이 adopted 가 아니면 409 supersedes_conflict
 *       target "$.body.supersedes" next_action reread_decisions. 토큰이 제안 외 state → 403 human_required.
 *   POST P/reflections  본문 {format_version?, target_round_id, entries:[{source_version_id, disposition, rationale, result_version_id?, followup_id?, evidence_tx_id?}]}.
 *       에이전트 토큰 또는 소유자 세션. 응답 201 data.reflection = {id, target_round_id, applied_count, partial_count}.
 *       applied/partial 증거 없음 → 422 evidence_required target "$.body.entries[i].result_version_id" next_action add_evidence.
 *       증거는 있으나 서로 안 맞음(tx 가 결과를 만든 것이 아님·후속이 applied 아님) → 422 validation_failed target "$.body.entries[i].evidence_tx_id".
 *   GET P/assumptions · P/decisions  context:read 토큰 또는 소유자. data.assumptions[] / data.decisions[] = 객체마다 **현재 버전** 한 줄
 *       (옛 판단·대체된 결정도 줄로 남는다). 시각은 ISO 8601, version_no 는 10진 문자열.
 *       assumptions 줄 키: id, version_id, version_no, statement, state, needs_review(bool), proposed_by_actor_id, assessed_by_actor_id|null,
 *         assessed_at|null, rationale.   decisions 줄 키: id, version_id, version_no, statement, state, scope, decided_by_actor_id|null, rationale,
 *         supersedes_decision_id|null.
 *   GET P/reflections?round_id=<id>  data = {round_id, submitted(bool), counts{applied,partial,rejected,deferred}, entries[]}.
 *       제출 전 submitted=false(entries=[]), 0건 제출 submitted=true(entries=[]) — "미제출"과 "0건"이 다르다.
 *       entries 줄 키: id, source_version_id, disposition, rationale, result_version_id|null, followup_id|null, applied_tx_id|null, actor_id.
 *   쓰기 공통: Idempotency-Key 필수(없으면 400 invalid_payload), 같은 키·같은 본문은 replayed:true, 다른 본문은 409 idempotency_key_reuse,
 *       무자격 401, 알 수 없는 프로젝트 404, 알 수 없는 필드 400 invalid_payload, 거절은 아무것도 안 쓴다(상태 서명 불변).
 *       토큰에 run:submit 범위가 없으면 쓰기 403 forbidden, context:read 없으면 읽기 403 forbidden.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { assert_error, assert_ok, call, make_agent, OPENAPI_PATH, with_api, type ApiEnv, type Auth } from "./helpers/api_env.ts";
import { P, assert_final_error } from "./helpers/api_flow.ts";
import { insert_followup, stage_ids } from "./helpers/editions_env.ts";
import { open_round } from "./helpers/questions_env.ts";
import { state_signature } from "./helpers/state_signature.ts";
import { artifact_version, count, reflection_rows, tx_of_version } from "./helpers/sel93_env.ts";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const DEC = /^(0|[1-9][0-9]*)$/;
const ASSUMPTION_KEYS = ["assessed_by_actor_id", "id", "needs_review", "state", "version_id"];
const DECISION_KEYS = ["id", "scope", "state", "version_id"];

const post = (env: ApiEnv, rest: string, auth: Auth, body: unknown, key?: string) =>
  call(env, { method: "POST", path: P(env, rest), auth, body, ...(key === undefined ? {} : { key }) });
const get = (env: ApiEnv, rest: string, auth: Auth = "owner") => call(env, { method: "GET", path: P(env, rest), auth });

async function propose_assumption(env: ApiEnv, statement = "정책 대상은 광역시 거주자로 한정한다.", auth: Auth = "owner"): Promise<any> {
  return assert_ok(await post(env, "/assumptions", auth, { format_version: "1.0", statement, state: "proposed", rationale: "합성 배경", scope: "edition" }), 201).assumption;
}

async function propose_decision(env: ApiEnv, statement = "2판은 대안 B 로 간다.", scope = "edition", auth: Auth = "owner"): Promise<any> {
  return assert_ok(await post(env, "/decisions", auth, { format_version: "1.0", scope, statement, state: "proposed", supersedes: null, rationale: "합성 근거" }), 201).decision;
}

// ---------------------------------------------------------------------------
// assumptions

test("POST assumptions (proposed): 201 with the documented keys; the AI/person proposal is unassessed and needs review", async () => {
  await with_api(async (env) => {
    const a = await propose_assumption(env);
    assert.deepEqual(Object.keys(a).sort(), ASSUMPTION_KEYS);
    assert.equal(typeof a.id, "string");
    assert.equal(a.state, "proposed");
    assert.equal(a.needs_review, true);
    assert.equal(a.assessed_by_actor_id, null);
    const row = env.db.get<{ statement: string; state: string; assessment_actor_id: string | null }>("SELECT statement, state, assessment_actor_id FROM assumption_versions WHERE version_id = ?", a.version_id);
    assert.equal(row?.state, "proposed");
    assert.equal(row?.assessment_actor_id, null);
  });
});

test("an agent token proposes an assumption (attributed to the agent); the same token cannot assess", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "proposer");
    const a = await propose_assumption(env, "AI 가정", { token: agent.token });
    assert.equal(env.db.get<{ p: string }>("SELECT proposed_by_actor_id AS p FROM assumptions WHERE object_id = ?", a.id)?.p, agent.actor_id);
    const sig = state_signature(env.db);
    for (const state of ["confirmed", "rejected", "revised"]) {
      assert_final_error(
        await post(env, "/assumptions", { token: agent.token }, { assumption_id: a.id, base_version_id: a.version_id, state, statement: "고침", rationale: "이유" }),
        403,
        "human_required",
      );
    }
    assert.equal(state_signature(env.db), sig);
  });
});

test("the owner assesses over HTTP: confirmed / rejected / revised each add a version with judge and reason; the response keeps the same keys", async () => {
  await with_api(async (env) => {
    const a = await propose_assumption(env, "원문 가정");
    const confirmed = assert_ok(await post(env, "/assumptions", "owner", { assumption_id: a.id, base_version_id: a.version_id, state: "confirmed" }), 201).assumption;
    assert.deepEqual(Object.keys(confirmed).sort(), ASSUMPTION_KEYS);
    assert.equal(confirmed.id, a.id);
    assert.equal(confirmed.state, "confirmed");
    assert.equal(confirmed.needs_review, false);
    assert.equal(confirmed.assessed_by_actor_id, env.p.actor_id);
    assert.notEqual(confirmed.version_id, a.version_id);
    const b = await propose_assumption(env, "틀릴 가정");
    const rejected = assert_ok(await post(env, "/assumptions", "owner", { assumption_id: b.id, base_version_id: b.version_id, state: "rejected", rationale: "자료와 다르다" }), 201).assumption;
    assert.equal(rejected.state, "rejected");
    const c = await propose_assumption(env, "고칠 가정");
    const revised = assert_ok(await post(env, "/assumptions", "owner", { assumption_id: c.id, base_version_id: c.version_id, state: "revised", statement: "고친 가정", rationale: "범위 축소" }), 201).assumption;
    assert.equal(revised.state, "revised");
    const texts = env.db.all<{ statement: string; state: string }>("SELECT statement, state FROM assumption_versions WHERE object_id = ? ORDER BY rowid", c.id);
    assert.deepEqual(texts.map((t) => t.statement), ["고칠 가정", "고친 가정"], "the original text is preserved");
  });
});

test("assumption writes: blank statement 422 validation_failed at $.body.statement; stale base 409 rev_conflict; unknown 404; bad state/field 400/422", async () => {
  await with_api(async (env) => {
    const a = await propose_assumption(env);
    const sig = state_signature(env.db);
    assert_final_error(await post(env, "/assumptions", "owner", { format_version: "1.0", statement: "", state: "proposed", rationale: "빈 가정", scope: "edition" }), 422, "validation_failed", { target: "$.body.statement", next_action: "fix_request" });
    assert_final_error(await post(env, "/assumptions", "owner", { assumption_id: a.id, base_version_id: "old", state: "confirmed" }), 409, "rev_conflict");
    assert_final_error(await post(env, "/assumptions", "owner", { assumption_id: "no-such", base_version_id: a.version_id, state: "confirmed" }), 404, "not_found");
    assert_final_error(await post(env, "/assumptions", "owner", { assumption_id: a.id, base_version_id: a.version_id, state: "rejected" }), 422, "validation_failed", { target: /\$\.body\.rationale/ });
    assert_final_error(await post(env, "/assumptions", "owner", { statement: "가정", state: "maybe" }), 422, "validation_failed", { target: "$.body.state" });
    assert_final_error(await post(env, "/assumptions", "owner", { statement: "가정", state: "proposed", surprise: 1 }), 400, "invalid_payload");
    assert.equal(state_signature(env.db), sig, "no refusal wrote anything");
  });
});

test("GET assumptions: one current row per object with proposer, judge, ISO time and reason; a judged one shows its judgement, not the proposal", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "p2");
    const a = await propose_assumption(env, "AI 가정", { token: agent.token });
    const b = await propose_assumption(env, "사람 가정");
    await post(env, "/assumptions", "owner", { assumption_id: b.id, base_version_id: b.version_id, state: "revised", statement: "사람이 고친 가정", rationale: "근거 문장" });
    env.clock.advance(1000);
    const data = assert_ok(await get(env, "/assumptions"));
    assert.ok(Array.isArray(data.assumptions));
    assert.equal(data.assumptions.length, 2);
    const by = new Map<string, any>(data.assumptions.map((r: any) => [r.id, r]));
    const ra = by.get(a.id);
    assert.deepEqual(Object.keys(ra).sort(), ["assessed_at", "assessed_by_actor_id", "id", "needs_review", "proposed_by_actor_id", "rationale", "state", "statement", "version_id", "version_no"]);
    assert.equal(ra.state, "proposed");
    assert.equal(ra.needs_review, true);
    assert.equal(ra.assessed_by_actor_id, null);
    assert.equal(ra.assessed_at, null);
    assert.equal(ra.proposed_by_actor_id, agent.actor_id);
    assert.match(ra.version_no, DEC);
    const rb = by.get(b.id);
    assert.equal(rb.state, "revised");
    assert.equal(rb.statement, "사람이 고친 가정");
    assert.equal(rb.rationale, "근거 문장");
    assert.equal(rb.assessed_by_actor_id, env.p.actor_id);
    assert.equal(rb.version_no, "2");
    assert.match(rb.assessed_at, ISO);
    assert.equal(rb.proposed_by_actor_id, env.p.actor_id);
    assert.equal(rb.needs_review, false);
  });
});

test("workspace records.assumptions.count follows the writes (and 'empty' flips)", async () => {
  await with_api(async (env) => {
    const before = assert_ok(await get(env, "/workspace")).records;
    assert.equal(before.empty, true);
    await propose_assumption(env);
    await propose_decision(env);
    const after = assert_ok(await get(env, "/workspace")).records;
    assert.equal(after.assumptions.count, 1);
    assert.equal(after.decisions.count, 1);
    assert.equal(after.empty, false);
  });
});

// ---------------------------------------------------------------------------
// decisions

test("POST decisions (proposed): 201 with the documented keys; a token can propose but nothing is adopted", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "dproposer");
    const d = await propose_decision(env, "AI 가 제안한 결정", "project", { token: agent.token });
    assert.deepEqual(Object.keys(d).sort(), DECISION_KEYS);
    assert.equal(d.state, "proposed");
    assert.equal(d.scope, "project");
    const row = env.db.get<{ state: string; decided_by: string | null }>("SELECT state, decided_by FROM decision_versions WHERE version_id = ?", d.version_id);
    assert.equal(row?.state, "proposed");
    assert.equal(row?.decided_by, null);
  });
});

test("only the owner adopts, supersedes or revokes: a token gets 403 human_required for every state but 'proposed'", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "dagent");
    const d = await propose_decision(env);
    const sig = state_signature(env.db);
    const t: Auth = { token: agent.token };
    assert_final_error(await post(env, "/decisions", t, { scope: "edition", statement: "x", state: "adopted", supersedes: null, decision_id: d.id, base_version_id: d.version_id }), 403, "human_required");
    assert_final_error(await post(env, "/decisions", t, { scope: "edition", statement: "x", state: "adopted", supersedes: d.id, base_version_id: d.version_id, rationale: "대체" }), 403, "human_required");
    assert_final_error(await post(env, "/decisions", t, { scope: "edition", statement: "x", state: "revoked", supersedes: null, decision_id: d.id, base_version_id: d.version_id, rationale: "폐기" }), 403, "human_required");
    assert.equal(state_signature(env.db), sig);
  });
});

test("owner adopts a proposal, then supersedes it: the old decision stays and links forward; GET shows the whole chain", async () => {
  await with_api(async (env) => {
    const d = await propose_decision(env, "1판 결정", "edition");
    const adopted = assert_ok(await post(env, "/decisions", "owner", { scope: "edition", statement: "1판 결정", state: "adopted", supersedes: null, decision_id: d.id, base_version_id: d.version_id, rationale: "채택" }), 201).decision;
    assert.deepEqual(Object.keys(adopted).sort(), DECISION_KEYS);
    assert.equal(adopted.id, d.id);
    assert.equal(adopted.state, "adopted");
    const next = assert_ok(await post(env, "/decisions", "owner", { scope: "edition", statement: "2판 결정", state: "adopted", supersedes: d.id, base_version_id: adopted.version_id, rationale: "바꾼다" }), 201).decision;
    assert.notEqual(next.id, d.id);
    assert.equal(next.state, "adopted");
    const rows = assert_ok(await get(env, "/decisions")).decisions as any[];
    assert.equal(rows.length, 2);
    const old = rows.find((r) => r.id === d.id)!;
    const fresh = rows.find((r) => r.id === next.id)!;
    assert.deepEqual(Object.keys(old).sort(), ["decided_by_actor_id", "id", "rationale", "scope", "state", "statement", "supersedes_decision_id", "version_id", "version_no"]);
    assert.equal(old.state, "superseded");
    assert.equal(old.statement, "1판 결정", "the old text is kept");
    assert.equal(old.decided_by_actor_id, env.p.actor_id);
    assert.equal(fresh.state, "adopted");
    assert.equal(fresh.supersedes_decision_id, d.id);
    assert.equal(fresh.decided_by_actor_id, env.p.actor_id);
    assert.equal(fresh.scope, "edition");
    assert.match(fresh.version_no, DEC);
    assert.equal(env.db.all("SELECT 1 FROM decision_versions WHERE object_id = ?", d.id).length, 3, "proposed, adopted, superseded — nothing overwritten");
  });
});

test("supersedes a revoked or never-adopted decision: 409 supersedes_conflict at $.body.supersedes (next_action reread_decisions), nothing written", async () => {
  await with_api(async (env) => {
    const d = await propose_decision(env, "곧 폐기");
    const adopted = assert_ok(await post(env, "/decisions", "owner", { scope: "edition", statement: "곧 폐기", state: "adopted", supersedes: null, decision_id: d.id, base_version_id: d.version_id }), 201).decision;
    const revoked = assert_ok(await post(env, "/decisions", "owner", { scope: "edition", statement: "곧 폐기", state: "revoked", supersedes: null, decision_id: d.id, base_version_id: adopted.version_id, rationale: "전제 무너짐" }), 201).decision;
    assert.equal(revoked.state, "revoked");
    const p = await propose_decision(env, "아직 제안");
    const sig = state_signature(env.db);
    const body = (target: string, version: string) => ({ format_version: "1.0", scope: "edition", statement: "대체", state: "adopted", supersedes: target, base_version_id: version, rationale: "대체 사례" });
    const e1 = assert_final_error(await post(env, "/decisions", "owner", body(d.id, revoked.version_id)), 409, "supersedes_conflict", { target: "$.body.supersedes", next_action: "reread_decisions" });
    assert.equal(e1.details?.target_state, "revoked");
    assert_final_error(await post(env, "/decisions", "owner", body(p.id, p.version_id)), 409, "supersedes_conflict", { target: "$.body.supersedes" });
    assert_final_error(await post(env, "/decisions", "owner", body("no-such-decision", p.version_id)), 404, "not_found");
    assert.equal(state_signature(env.db), sig);
  });
});

test("decision write validation: scope/state/statement problems are 422 with the field path; unknown fields 400", async () => {
  await with_api(async (env) => {
    const sig = state_signature(env.db);
    const ok = { format_version: "1.0", scope: "edition", statement: "결정", state: "proposed", supersedes: null, rationale: "근거" };
    assert_final_error(await post(env, "/decisions", "owner", { ...ok, scope: "global" }), 422, "validation_failed", { target: "$.body.scope" });
    assert_final_error(await post(env, "/decisions", "owner", { ...ok, statement: " " }), 422, "validation_failed", { target: "$.body.statement" });
    assert_final_error(await post(env, "/decisions", "owner", { ...ok, state: "done" }), 422, "validation_failed", { target: "$.body.state" });
    assert_final_error(await post(env, "/decisions", "owner", { ...ok, surprise: true }), 400, "invalid_payload");
    assert.equal(state_signature(env.db), sig);
  });
});

// ---------------------------------------------------------------------------
// reflections

async function reflection_scene(env: ApiEnv): Promise<{ round_id: string; source: any; result: any; result_tx: string }> {
  const { round_id } = await open_round(env, "rf");
  const source = await artifact_version(env, "rf-src");
  const result = await artifact_version(env, "rf-res");
  return { round_id, source, result, result_tx: tx_of_version(env.db, result.version_id) };
}

test("POST reflections: the documented applied entry is accepted (token) and returns {id, target_round_id, applied_count, partial_count}", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "reflector");
    const s = await reflection_scene(env);
    const res = await post(env, "/reflections", { token: agent.token }, {
      format_version: "1.0",
      target_round_id: s.round_id,
      entries: [{ source_version_id: s.source.version_id, disposition: "applied", rationale: "본문에 반영했다.", result_version_id: s.result.version_id, evidence_tx_id: s.result_tx }],
    });
    const r = assert_ok(res, 201).reflection;
    assert.deepEqual(Object.keys(r).sort(), ["applied_count", "id", "partial_count", "target_round_id"]);
    assert.equal(r.target_round_id, s.round_id);
    assert.equal(r.applied_count, 1);
    assert.equal(r.partial_count, 0);
    const rows = reflection_rows(env.db, s.round_id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.actor_id, agent.actor_id);
    assert.equal(rows[0]!.applied_tx_id, s.result_tx);
  });
});

test("applied without evidence is 422 evidence_required at $.body.entries[0].result_version_id (next_action add_evidence); a real-but-unrelated tx is 422 validation_failed", async () => {
  await with_api(async (env) => {
    const s = await reflection_scene(env);
    const sig = state_signature(env.db);
    const entry = { source_version_id: s.source.version_id, disposition: "applied", rationale: "증거 없이 적용으로 표시하는 합성 사례", result_version_id: null, evidence_tx_id: null };
    assert_final_error(await post(env, "/reflections", "owner", { format_version: "1.0", target_round_id: s.round_id, entries: [entry] }), 422, "evidence_required", { target: "$.body.entries[0].result_version_id", next_action: "add_evidence" });
    assert_final_error(await post(env, "/reflections", "owner", { target_round_id: s.round_id, entries: [{ ...entry, disposition: "partial" }] }), 422, "evidence_required", { target: "$.body.entries[0].result_version_id" });
    const first_tx = env.db.get<{ id: string }>("SELECT id FROM mutation_commits WHERE project_id = ? ORDER BY rowid LIMIT 1", env.p.project_id)!.id;
    assert_final_error(
      await post(env, "/reflections", "owner", { target_round_id: s.round_id, entries: [{ ...entry, result_version_id: s.result.version_id, evidence_tx_id: first_tx }] }),
      422,
      "validation_failed",
      { target: "$.body.entries[0].evidence_tx_id" },
    );
    // a follow-up that is merely proposed is not evidence either
    const ids = stage_ids(env.db, env.p.edition_id);
    const f = insert_followup({ db: env.db, p: env.p } as any, "api-f", ids.research, "proposed", "제안만 된 후속");
    const sig2 = state_signature(env.db);
    assert_final_error(await post(env, "/reflections", "owner", { target_round_id: s.round_id, entries: [{ ...entry, followup_id: f.object_id, evidence_tx_id: first_tx }] }), 422, "validation_failed", { target: "$.body.entries[0].evidence_tx_id" });
    assert.equal(state_signature(env.db), sig2);
    assert.notEqual(sig, "");
    assert.equal(reflection_rows(env.db).length, 0);
  });
});

test("rejected and deferred need only a reason; an entry that names evidence fields on them is 422", async () => {
  await with_api(async (env) => {
    const s = await reflection_scene(env);
    const base = { source_version_id: s.source.version_id, rationale: "이유" };
    const r = assert_ok(await post(env, "/reflections", "owner", { target_round_id: s.round_id, entries: [{ ...base, disposition: "rejected" }, { ...base, disposition: "deferred" }] }), 201).reflection;
    assert.equal(r.applied_count, 0);
    assert.equal(r.partial_count, 0);
    assert.equal(reflection_rows(env.db).length, 2);
    const sig = state_signature(env.db);
    assert_final_error(await post(env, "/reflections", "owner", { target_round_id: s.round_id, entries: [{ ...base, disposition: "rejected", result_version_id: s.result.version_id, evidence_tx_id: s.result_tx }] }), 422, "validation_failed", { target: /^\$\.body\.entries\[0\]/ });
    assert_final_error(await post(env, "/reflections", "owner", { target_round_id: s.round_id, entries: [{ ...base, disposition: "done" }] }), 422, "validation_failed", { target: "$.body.entries[0].disposition" });
    assert_final_error(await post(env, "/reflections", "owner", { target_round_id: s.round_id, entries: [{ ...base, rationale: "", disposition: "deferred" }] }), 422, "validation_failed", { target: "$.body.entries[0].rationale" });
    assert_final_error(await post(env, "/reflections", "owner", { target_round_id: s.round_id }), 400, "invalid_payload");
    assert_final_error(await post(env, "/reflections", "owner", { target_round_id: "no-such-round", entries: [] }), 404, "not_found");
    assert.equal(state_signature(env.db), sig);
  });
});

test("GET reflections: 'not submitted' and '0 entries' are different answers; entries carry the evidence links", async () => {
  await with_api(async (env) => {
    const s = await reflection_scene(env);
    const q = `/reflections?round_id=${encodeURIComponent(s.round_id)}`;
    const none = assert_ok(await get(env, q));
    assert.equal(none.round_id, s.round_id);
    assert.equal(none.submitted, false);
    assert.deepEqual(none.entries, []);
    assert.deepEqual(none.counts, { applied: 0, partial: 0, rejected: 0, deferred: 0 });
    assert_ok(await post(env, "/reflections", "owner", { target_round_id: s.round_id, entries: [] }), 201);
    const zero = assert_ok(await get(env, q));
    assert.equal(zero.submitted, true, "a submitted-but-empty reflection is '0건', not '미제출'");
    assert.deepEqual(zero.entries, []);
    assert.deepEqual(zero.counts, { applied: 0, partial: 0, rejected: 0, deferred: 0 });
    assert_ok(
      await post(env, "/reflections", "owner", {
        target_round_id: s.round_id,
        entries: [
          { source_version_id: s.source.version_id, disposition: "applied", rationale: "반영", result_version_id: s.result.version_id, evidence_tx_id: s.result_tx },
          { source_version_id: s.source.version_id, disposition: "rejected", rationale: "안 한다" },
        ],
      }),
      201,
    );
    const full = assert_ok(await get(env, q));
    assert.equal(full.submitted, true);
    assert.deepEqual(full.counts, { applied: 1, partial: 0, rejected: 1, deferred: 0 });
    assert.equal(full.entries.length, 2);
    const applied = full.entries.find((e: any) => e.disposition === "applied");
    assert.deepEqual(Object.keys(applied).sort(), ["actor_id", "applied_tx_id", "disposition", "followup_id", "id", "rationale", "result_version_id", "source_version_id"]);
    assert.equal(applied.result_version_id, s.result.version_id);
    assert.equal(applied.applied_tx_id, s.result_tx);
    assert.equal(applied.followup_id, null);
    assert.equal(applied.source_version_id, s.source.version_id);
    assert_final_error(await get(env, "/reflections?round_id=no-such-round"), 404, "not_found");
  });
});

test("GET reflections without a round: the rounds that have a submission are listed; none yet reads as an empty list, never as made-up rows", async () => {
  await with_api(async (env) => {
    const empty = assert_ok(await get(env, "/reflections"));
    assert.ok(Array.isArray(empty.reflections));
    assert.equal(empty.reflections.length, 0);
  });
});

// ---------------------------------------------------------------------------
// shared write rules

const ROUTES = ["assumptions", "decisions", "reflections"] as const;

function minimal_body(route: (typeof ROUTES)[number], round_id: string): Record<string, unknown> {
  if (route === "assumptions") return { statement: "가정", state: "proposed" };
  if (route === "decisions") return { scope: "edition", statement: "결정", state: "proposed", supersedes: null };
  return { target_round_id: round_id, entries: [] };
}

test("authentication and scope: none 401; unknown project 404; a token without run:submit cannot write (403 forbidden); without context:read cannot read", async () => {
  await with_api(async (env) => {
    const { round_id } = await open_round(env, "au");
    const reader = await make_agent(env, "reader", ["context:read"]);
    const writer = await make_agent(env, "writeonly", ["run:submit"]);
    for (const route of ROUTES) {
      const body = minimal_body(route, round_id);
      assert_final_error(await post(env, `/${route}`, "none", body), 401, "unauthenticated");
      assert_final_error(await post(env, `/${route}`, { token: reader.token }, body), 403, "forbidden");
      assert_final_error(await get(env, `/${route}`, "none"), 401, "unauthenticated");
      assert_final_error(await get(env, `/${route}`, { token: writer.token }), 403, "forbidden");
      const unknown = await call(env, { method: "POST", path: `/api/v1/projects/no-such-project/${route}`, auth: "owner", body });
      assert_error(unknown, 404, "not_found");
      assert_ok(await get(env, `/${route}`, { token: reader.token }));
    }
  });
});

test("Idempotency-Key is required; the same key replays; the same key with another body is 409 idempotency_key_reuse; replays write nothing", async () => {
  await with_api(async (env) => {
    const { round_id } = await open_round(env, "id");
    for (const route of ROUTES) {
      const body = minimal_body(route, round_id);
      assert_final_error(await call(env, { method: "POST", path: P(env, `/${route}`), auth: "owner", body, key: null }), 400, "invalid_payload");
      const first = await post(env, `/${route}`, "owner", body, `k-${route}`);
      const data = assert_ok(first, 201);
      assert.notEqual(first.json.replayed, true);
      const sig = state_signature(env.db);
      const again = await post(env, `/${route}`, "owner", body, `k-${route}`);
      assert.equal(again.json.replayed, true);
      assert.deepEqual(assert_ok(again, 201), data);
      assert.equal(state_signature(env.db), sig, `${route}: a replay writes nothing`);
      const other = route === "assumptions" ? { ...body, statement: "다른 가정" } : route === "decisions" ? { ...body, statement: "다른 결정" } : { ...body, entries: [{ source_version_id: "x", disposition: "deferred", rationale: "다른" }] };
      assert_final_error(await post(env, `/${route}`, "owner", other, `k-${route}`), 409, "idempotency_key_reuse");
    }
    assert.equal(count(env.db, "assumptions"), 1);
    assert.equal(count(env.db, "decisions"), 1);
  });
});

test("the three operations are supported in capabilities; their unsupported (501) entries are gone", async () => {
  await with_api(async (env) => {
    const data = assert_ok(await call(env, { method: "GET", path: "/api/v1/capabilities" }));
    const caps = data.capabilities;
    for (const op of ["assumptions.create", "decisions.create", "reflections.create"]) {
      assert.equal(caps.operations[op].supported, true, op);
    }
    const unsupported = JSON.stringify(data.unsupported);
    for (const route of ROUTES) assert.doesNotMatch(unsupported, new RegExp(`/${route}\\b`));
    const routes = (data.routes as string[]).join("\n");
    for (const route of ROUTES) {
      assert.match(routes, new RegExp(`POST [^\\n]*/${route}\\b`), `POST ${route} is listed`);
      assert.match(routes, new RegExp(`GET [^\\n]*/${route}\\b`), `GET ${route} is listed`);
    }
  });
});

test("OpenAPI documents all three paths with POST and GET and the new error codes", () => {
  const doc = readFileSync(OPENAPI_PATH, "utf8");
  for (const route of ROUTES) {
    const at = doc.indexOf(`/api/v1/projects/{id}/${route}:`);
    assert.ok(at >= 0, `${route} path is documented`);
    const rest = doc.slice(at + 10);
    const next = rest.search(/\n {2}\/api\/v1\//);
    const block = next < 0 ? rest : rest.slice(0, next);
    assert.match(block, /\n {4}post:/, `${route}: post`);
    assert.match(block, /\n {4}get:/, `${route}: get`);
  }
  for (const code of ["supersedes_conflict", "evidence_required"]) assert.match(doc, new RegExp(code), `${code} is documented`);
});

test("the three docs fixtures (docs/plan/fixtures/api-v1) now pass as written: normal bodies are accepted verbatim", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "fx");
    const dir = new URL("../docs/plan/fixtures/api-v1/", import.meta.url);
    const read = (n: string) => JSON.parse(readFileSync(new URL(n, dir), "utf8"));
    // assumptions.json normal (agent token, no lease guard in the body)
    const a = read("assumptions.json");
    const a_res = await post(env, "/assumptions", { token: agent.token }, a.normal.request.body);
    const a_data = assert_ok(a_res, a.normal.response.status);
    assert.deepEqual(Object.keys(a_data.assumption).sort(), Object.keys(a.normal.response.body.data.assumption).sort());
    assert.equal(a_data.assumption.state, "proposed");
    assert.equal(a_data.assumption.needs_review, true);
    assert.equal(a_data.assumption.assessed_by_actor_id, null);
    const a_err = a.error.response.body.error;
    assert_final_error(await post(env, "/assumptions", { token: agent.token }, a.error.request.body), a.error.response.status, a_err.code, { target: a_err.target, next_action: a_err.next_action });
    // decisions.json normal (owner)
    const d = read("decisions.json");
    const d_data = assert_ok(await post(env, "/decisions", "owner", d.normal.request.body), d.normal.response.status);
    assert.deepEqual(Object.keys(d_data.decision).sort(), Object.keys(d.normal.response.body.data.decision).sort());
    assert.equal(d_data.decision.state, "proposed");
    assert.equal(d_data.decision.scope, "edition");
    // reflections.json normal / error with real ids substituted for the fake ones
    const r = read("reflections.json");
    const s = await reflection_scene(env);
    const subst = (body: any) =>
      JSON.parse(JSON.stringify(body).replaceAll("rnd_01J9Z3K7Q5", s.round_id).replaceAll("ver_01J9Z3K7QA", s.source.version_id).replaceAll("ver_01J9Z3K7QZ", s.result.version_id).replaceAll("tx_01J9Z3K7Q2", s.result_tx));
    const r_data = assert_ok(await post(env, "/reflections", { token: agent.token }, subst(r.normal.request.body)), r.normal.response.status);
    assert.deepEqual(Object.keys(r_data.reflection).sort(), Object.keys(r.normal.response.body.data.reflection).sort());
    const r_err = r.error.response.body.error;
    assert_final_error(await post(env, "/reflections", { token: agent.token }, subst(r.error.request.body)), r.error.response.status, r_err.code, { target: r_err.target, next_action: r_err.next_action });
  });
});

test("no new table: the SQLite schema has exactly the tables of 001 + 002", async () => {
  await with_api(async (env) => {
    const names = env.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name);
    for (const must of ["assumptions", "assumption_versions", "decisions", "decision_versions", "reflection_entries", "followups", "followup_versions"]) {
      assert.ok(names.includes(must), must);
    }
    assert.equal(names.some((n) => /assess|adoption|reflection_(?!entries)|judg/.test(n)), false, `unexpected new table in ${names.join(",")}`);
  });
});

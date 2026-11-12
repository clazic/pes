/**
 * SEL-100 U3c — 반영 증거의 원문 연결 (SEL-93 최종 리뷰 1/2 권장 1) (tester, 작성 모드).
 *
 * 있던 것(회귀 가드로 남김): applied/partial 은 evidence_tx_id 가 이 프로젝트 커밋이어야 하고, result_version_id 가 있으면 그 버전을
 *   만든 tx 가 evidence_tx_id 와 같고 원문 자신이 아니어야 하며, followup_id 가 있으면 후속의 현재 버전이 applied 이고 applied_tx_id 가 같아야 한다
 *   (tests/test_sel93_reflection.test.ts). 글(artifact) 버전이 결과인 경로와 origin_version_id 가 비어 있는 후속이 증거인 경로(같은 파일 183행)는 계속 통과해야 한다.
 * 없던 것: ① 가정·결정의 **제안(proposed) 버전**을 '적용 결과'로 못 쓴다 ② 후속의 원문 연결.
 *
 * 정한 허용 kind — DB 를 보고 정했다 (근거):
 *   DB: object_versions.kind 는 artifact·source·question·answer·assumption·decision·thread·message·followup (migrations/001_initial.sql 306행).
 *   `assumption.propose`·`decision.propose` 는 누구나(토큰 포함) 부를 수 있고 곧바로 새 버전을 만든다(tx T). 그래서 "방금 만든 제안 버전 + 그 tx" 쌍이
 *   증거 검사(결과 버전을 만든 tx == evidence_tx_id)를 항상 통과해 의견이 처리된 것처럼 보이게 된다. 반면 판단·채택(assumption.assess · decision.adopt)은
 *   소유자 사람만 만들 수 있어 의견에 대한 사람의 처리 결과로 볼 수 있다.
 *   → 결과 버전이 assumption_versions.state = 'proposed' 또는 decision_versions.state = 'proposed' 인 버전이면 거절한다.
 *   → (1차 리뷰 수정) 거절 목록이 아니라 **허용 목록**: 글(artifact) 버전, 가정의 confirmed·rejected·revised 버전, 결정의 adopted·superseded·revoked 버전만 결과가 된다.
 *     message·thread·question·answer·source·followup 버전은 토큰도 한 번의 쓰기로 (버전, 그 버전을 만든 tx) 쌍을 만들 수 있어 모두 거절한다 (tests/test_sel100_review_fixes.test.ts).
 *   거절 모양: API 422 validation_failed, target `$.body.entries[i].result_version_id` 또는 `…evidence_tx_id`(reason evidence_mismatch), 아무것도 쓰지 않는다.
 *
 * 후속 연결 — 이슈 본문은 `followups.source_version_id` 라고 쓰지만 그런 칸은 없다. 후속(followups)의 원문 칸은 **origin_version_id** 다
 *   (migrations/001_initial.sql 913~927행). 해석: followup_id 를 주면 followups.origin_version_id 가 entry.source_version_id 와 같아야 한다.
 *   leader 결정(2026-11-12): origin_version_id 가 NULL 인 후속도 **거절**한다(원문과 연결 안 된 후속은 증거가 아니다). 기존 f-ok 시험은 origin 을 source 로 맞춘 뒤 통과하도록 옮겼다.
 *   origin 이 다른 버전이면 거절: 422 validation_failed, target `$.body.entries[i].followup_id`, 아무것도 쓰지 않는다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { assert_ok, call, with_api, type ApiEnv, type Auth } from "./helpers/api_env.ts";
import { P, assert_final_error } from "./helpers/api_flow.ts";
import { insert_followup, stage_ids } from "./helpers/editions_env.ts";
import { open_round } from "./helpers/questions_env.ts";
import { artifact_version, count, reflection_rows, tx_of_version } from "./helpers/sel93_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const post = (env: ApiEnv, rest: string, auth: Auth, body: unknown) => call(env, { method: "POST", path: P(env, rest), auth, body });

async function propose_assumption(env: ApiEnv, statement: string): Promise<any> {
  return assert_ok(await post(env, "/assumptions", "owner", { statement, state: "proposed", scope: "edition" }), 201).assumption;
}
async function propose_decision(env: ApiEnv, statement: string): Promise<any> {
  return assert_ok(await post(env, "/decisions", "owner", { scope: "edition", statement, state: "proposed", supersedes: null }), 201).decision;
}

async function scene(env: ApiEnv) {
  const { round_id } = await open_round(env, "ev");
  const source = await artifact_version(env, "ev-src");
  return { round_id, source };
}

const entry = (source_version_id: string, extra: Record<string, unknown>) => ({ source_version_id, disposition: "applied", rationale: "반영했다.", ...extra });
const MISMATCH = /^\$\.body\.entries\[0\]\.(result_version_id|evidence_tx_id)$/;

// ---------------------------------------------------------------------------
// ① 제안 버전은 결과가 아니다

test("an assumption PROPOSAL version cannot be an applied/partial result, even with the commit that made it as evidence", async () => {
  await with_api(async (env) => {
    const s = await scene(env);
    const a = await propose_assumption(env, "방금 제안한 가정");
    const tx = tx_of_version(env.db, a.version_id);
    const sig = state_signature(env.db);
    for (const disposition of ["applied", "partial"]) {
      const err = assert_final_error(
        await post(env, "/reflections", "owner", { target_round_id: s.round_id, entries: [entry(s.source.version_id, { disposition, result_version_id: a.version_id, evidence_tx_id: tx })] }),
        422,
        "validation_failed",
        { target: MISMATCH },
      );
      assert.equal(err.details.reason, "evidence_mismatch");
    }
    assert.equal(state_signature(env.db), sig, "a refused reflection writes nothing");
    assert.equal(reflection_rows(env.db).length, 0);
  });
});

test("a decision PROPOSAL version cannot be an applied/partial result either", async () => {
  await with_api(async (env) => {
    const s = await scene(env);
    const d = await propose_decision(env, "방금 제안한 결정");
    const tx = tx_of_version(env.db, d.version_id);
    const sig = state_signature(env.db);
    assert_final_error(
      await post(env, "/reflections", "owner", { target_round_id: s.round_id, entries: [entry(s.source.version_id, { result_version_id: d.version_id, evidence_tx_id: tx })] }),
      422,
      "validation_failed",
      { target: MISMATCH },
    );
    assert.equal(state_signature(env.db), sig);
  });
});

test("the proposal is also refused when it is one of two evidences (result + applied follow-up) and in a later entry of the same call (all or nothing)", async () => {
  await with_api(async (env) => {
    const s = await scene(env);
    const good = await artifact_version(env, "ev-good");
    const a = await propose_assumption(env, "제안 가정");
    const sig = state_signature(env.db);
    const res = await post(env, "/reflections", "owner", {
      target_round_id: s.round_id,
      entries: [
        entry(s.source.version_id, { result_version_id: good.version_id, evidence_tx_id: tx_of_version(env.db, good.version_id) }),
        entry(s.source.version_id, { result_version_id: a.version_id, evidence_tx_id: tx_of_version(env.db, a.version_id) }),
      ],
    });
    assert_final_error(res, 422, "validation_failed", { target: /^\$\.body\.entries\[1\]\.(result_version_id|evidence_tx_id)$/ });
    assert.equal(state_signature(env.db), sig, "the first (good) entry was not written either");
  });
});

test("a JUDGED version still counts as a result: assumption revised / confirmed / rejected and decision adopted are accepted (the owner made them)", async () => {
  await with_api(async (env) => {
    const s = await scene(env);
    const a1 = await propose_assumption(env, "고칠 가정");
    const revised = assert_ok(await post(env, "/assumptions", "owner", { assumption_id: a1.id, base_version_id: a1.version_id, state: "revised", statement: "고친 가정", rationale: "의견 반영" }), 201).assumption;
    const a2 = await propose_assumption(env, "확인할 가정");
    const confirmed = assert_ok(await post(env, "/assumptions", "owner", { assumption_id: a2.id, base_version_id: a2.version_id, state: "confirmed" }), 201).assumption;
    const a3 = await propose_assumption(env, "틀린 가정");
    const rejected = assert_ok(await post(env, "/assumptions", "owner", { assumption_id: a3.id, base_version_id: a3.version_id, state: "rejected", rationale: "자료와 다름" }), 201).assumption;
    const d = await propose_decision(env, "채택할 결정");
    const adopted = assert_ok(await post(env, "/decisions", "owner", { scope: "edition", statement: "채택할 결정", state: "adopted", supersedes: null, decision_id: d.id, base_version_id: d.version_id }), 201).decision;
    const results = [revised, confirmed, rejected, adopted];
    const out = assert_ok(
      await post(env, "/reflections", "owner", {
        target_round_id: s.round_id,
        entries: results.map((r) => entry(s.source.version_id, { result_version_id: r.version_id, evidence_tx_id: tx_of_version(env.db, r.version_id) })),
      }),
      201,
    );
    assert.equal(out.reflection.applied_count, 4);
  });
});

test("an ordinary text (artifact) version is still an accepted result (regression)", async () => {
  await with_api(async (env) => {
    const s = await scene(env);
    const result = await artifact_version(env, "ev-art");
    const out = assert_ok(await post(env, "/reflections", "owner", { target_round_id: s.round_id, entries: [entry(s.source.version_id, { result_version_id: result.version_id, evidence_tx_id: tx_of_version(env.db, result.version_id) })] }), 201);
    assert.equal(out.reflection.applied_count, 1);
  });
});

test("rejected / deferred entries are not affected (they take no evidence)", async () => {
  await with_api(async (env) => {
    const s = await scene(env);
    const out = assert_ok(
      await post(env, "/reflections", "owner", {
        target_round_id: s.round_id,
        entries: [
          { source_version_id: s.source.version_id, disposition: "rejected", rationale: "안 한다" },
          { source_version_id: s.source.version_id, disposition: "deferred", rationale: "다음에" },
        ],
      }),
      201,
    );
    assert.equal(out.reflection.applied_count, 0);
    assert.equal(count(env.db, "reflection_entries"), 2);
  });
});

// ---------------------------------------------------------------------------
// ② 후속은 같은 원문에서 나온 것이어야 한다

function applied_followup(env: ApiEnv, tag: string, origin_version_id: string | null): { object_id: string; tx: string } {
  const stage = stage_ids(env.db, env.db.get<{ id: string }>("SELECT active_edition_id AS id FROM projects WHERE id = ?", env.p.project_id)!.id);
  const f = insert_followup(env as any, tag, stage.research, "applied", "후속 작업 설명");
  if (origin_version_id !== null) env.db.run("UPDATE followups SET origin_version_id = ? WHERE object_id = ?", origin_version_id, f.object_id);
  const tx = env.db.get<{ applied_tx_id: string }>("SELECT applied_tx_id FROM followup_versions WHERE version_id = ?", f.version_id)!.applied_tx_id;
  return { object_id: f.object_id, tx };
}

test("a follow-up whose origin is the entry's source is accepted as evidence", async () => {
  await with_api(async (env) => {
    const s = await scene(env);
    const f = applied_followup(env, "ok", s.source.version_id);
    const out = assert_ok(await post(env, "/reflections", "owner", { target_round_id: s.round_id, entries: [entry(s.source.version_id, { followup_id: f.object_id, evidence_tx_id: f.tx })] }), 201);
    assert.equal(out.reflection.applied_count, 1);
    assert.equal(reflection_rows(env.db)[0]!.followup_id, f.object_id);
  });
});

test("a follow-up that came from ANOTHER version is refused (an applied follow-up of some other opinion is not this entry's evidence)", async () => {
  await with_api(async (env) => {
    const s = await scene(env);
    const other = await artifact_version(env, "ev-other");
    const f = applied_followup(env, "other", other.version_id);
    const sig = state_signature(env.db);
    for (const disposition of ["applied", "partial"]) {
      assert_final_error(
        await post(env, "/reflections", "owner", { target_round_id: s.round_id, entries: [entry(s.source.version_id, { disposition, followup_id: f.object_id, evidence_tx_id: f.tx })] }),
        422,
        "validation_failed",
        { target: "$.body.entries[0].followup_id" },
      );
    }
    assert.equal(state_signature(env.db), sig);
  });
});

test("a follow-up with no origin (origin_version_id NULL) is refused: not linked to any opinion, it is no evidence", async () => {
  await with_api(async (env) => {
    const s = await scene(env);
    const f = applied_followup(env, "null", null);
    const sig = state_signature(env.db);
    assert_final_error(
      await post(env, "/reflections", "owner", { target_round_id: s.round_id, entries: [entry(s.source.version_id, { followup_id: f.object_id, evidence_tx_id: f.tx })] }),
      422,
      "validation_failed",
      { target: "$.body.entries[0].followup_id" },
    );
    assert.equal(state_signature(env.db), sig);
  });
});

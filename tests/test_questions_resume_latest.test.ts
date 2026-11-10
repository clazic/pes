// SEL-41 (stage 2 PR8) final-review 1/2 regression tests: resume_ready must judge the LATEST set of a
// (stage_id, form_key) across rounds, not the latest set within the round. Synthetic data only.
//
// Pinned behaviour:
//  1  round set v1 -> stage_start (round_id NULL) set v2 of the same key: the round has no latest set for the
//     key any more, so the abandoned v1 questions are NOT reported missing.
//  2  stage_start (NULL) set v1 -> round set v2 of the same key: the round's latest set is v2; its required
//     questions are reported missing.
//  3  v1 -> v2 inside the same round: judged by v2 (existing behaviour kept).

import assert from "node:assert/strict";
import { test } from "node:test";

import { resume_ready } from "../scripts/pes_core/questions.ts";
import { open_round, publish, single_spec, with_env } from "./helpers/questions_env.ts";

test("resume 1: a newer round-less set of the same key retires the round's older set", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set1 = await publish(env, where, [single_spec("합성 질문 1")], "pub-1");
    assert.equal(set1.set_version_no, 1);
    const set2 = await publish(env, { stage_id: where.stage_id, round_id: null }, [single_spec("합성 질문 2")], "pub-2");
    assert.equal(set2.set_version_no, 2);
    assert.equal(set2.round_id, null);

    const r = resume_ready(env.db, env.p.project_id, where.round_id);
    assert.deepEqual(
      r.missing.map((m) => m.question_id),
      [],
      "the abandoned v1 question is not missing",
    );
    assert.equal(r.ready, true);
  });
});

test("resume 2: a newer round set of the same key replaces an older round-less set", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set1 = await publish(env, { stage_id: where.stage_id, round_id: null }, [single_spec("합성 질문 1")], "pub-1");
    assert.equal(set1.set_version_no, 1);
    const set2 = await publish(env, where, [single_spec("합성 질문 2")], "pub-2");
    assert.equal(set2.set_version_no, 2);

    const r = resume_ready(env.db, env.p.project_id, where.round_id);
    assert.equal(r.ready, false);
    assert.deepEqual(
      r.missing.map((m) => m.question_id),
      [set2.members[0]!.question_id],
      "only the v2 required question is missing",
    );
    assert.equal(r.missing[0]!.reason, "unanswered");
  });
});

test("resume 3: v1 -> v2 inside the same round is judged by v2", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set1 = await publish(env, where, [single_spec("합성 질문 1")], "pub-1");
    const set2 = await publish(env, where, [single_spec("합성 질문 2")], "pub-2");
    assert.equal(set2.set_version_no, 2);
    assert.notEqual(set1.members[0]!.question_id, set2.members[0]!.question_id);

    const r = resume_ready(env.db, env.p.project_id, where.round_id);
    assert.equal(r.ready, false);
    assert.deepEqual(
      r.missing.map((m) => m.question_id),
      [set2.members[0]!.question_id],
    );
  });
});

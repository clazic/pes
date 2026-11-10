// SEL-41 (stage 2 PR8) first-review regression tests (log: SEL-41-r1, leader decisions A–H).
// These pin the REQUIRED behaviour; they are expected to FAIL until the implementation is fixed.
// Interfaces: see the header of tests/test_questions_answers.test.ts.
// Everything is synthetic (FakeClock, temporary HOME). Rows from node:sqlite are copied with { ...row };
// bigint values are serialised with a replacer.
//
// Decisions pinned here:
//  A  question.publish_set: stage's edition must be active (and the project's active edition); a given
//     round must be open. Otherwise `conflict`, nothing written.
//  B  answer.submit / validate_submission: the set's edition must be active and the set's round not sealed.
//     Otherwise `conflict`.
//  C  re-using a question whose current version state is not 'open' in a new set -> `conflict`
//     (chosen: conflict, same code as a stale version; the question exists but is not usable now).
//  D  required=1 + empty value ('', whitespace, []) -> invalid_payload, the whole bundle is rejected.
//  E  the same question_id twice in one set -> invalid_payload (not a raw SQLite error).
//  F  submitting to a set that is not the latest version of its (stage_id, form_key) -> conflict.
//  G  answer.submit takes no run_id / lease_id / fence (unknown field -> invalid_payload).
//  H  a new question spec without allow_comment_as_answer defaults to false; only an explicit true counts.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError } from "../scripts/pes_core/errors.ts";
import { publish_set, submit_answers, validate_submission } from "../scripts/pes_core/questions.ts";
import { make_content, seal, stage_ids, type SealResult } from "./helpers/editions_env.ts";
import {
  answer_versions_of,
  comments_of,
  counts,
  open_round,
  publish,
  question_current,
  question_version,
  rejects_api,
  single_spec,
  submit,
  text_spec,
  with_env,
  type Env,
  type PublishResult,
} from "./helpers/questions_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? `${v}n` : v);

function snapshot(env: Env): string {
  return `${state_signature(env.db)}|${JSON.stringify(counts(env.db), replacer)}`;
}

async function seal_round_of(env: Env, round_id: string, tag: string): Promise<void> {
  const content = await make_content(env, tag);
  const versions = [{ object_id: content.object_id, version_id: content.version_id }];
  const out = await seal(env, round_id, versions, `${tag}-seal`);
  assert.ok((out.result as SealResult).snapshot_id);
}

function set_edition_status(env: Env, status: "completed" | "archived"): void {
  env.db.run("UPDATE editions SET status = ? WHERE id = ?", status, env.p.edition_id);
}

// ---------------------------------------------------------------------------
// A. publish_set needs an active edition and an open round

for (const status of ["completed", "archived"] as const) {
  test(`review A: publishing into a stage of a ${status} edition is a conflict and writes nothing`, async () => {
    await with_env(async (env) => {
      const where = await open_round(env);
      await publish(env, where, [single_spec("합성 질문")], "pub-1");
      set_edition_status(env, status);
      const before = snapshot(env);
      await rejects_api(
        publish_set(env.service, env.ctx("pub-2"), {
          stage_id: where.stage_id,
          round_id: where.round_id,
          purpose: "stage_start",
          form_key: "main",
          questions: [single_spec("합성 질문 2")],
        }),
        "conflict",
      );
      // also without a round
      await rejects_api(
        publish_set(env.service, env.ctx("pub-3"), {
          stage_id: where.stage_id,
          round_id: null,
          purpose: "stage_start",
          form_key: "other",
          questions: [single_spec("합성 질문 3")],
        }),
        "conflict",
      );
      assert.equal(snapshot(env), before, "no receipt, event, question or set was written");
    });
  });
}

test("review A: publishing into a sealed round is a conflict and writes nothing", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    await publish(env, where, [single_spec("합성 질문")], "pub-1");
    await seal_round_of(env, where.round_id, "c1");
    const before = snapshot(env);
    await rejects_api(
      publish_set(env.service, env.ctx("pub-2"), {
        stage_id: where.stage_id,
        round_id: where.round_id,
        purpose: "stage_start",
        form_key: "main",
        questions: [single_spec("합성 질문 2")],
      }),
      "conflict",
    );
    assert.equal(snapshot(env), before);
  });
});

test("review A: a stage of the active edition with an open round still publishes (control)", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [single_spec("합성 질문")], "pub-1");
    assert.equal(set.set_version_no, 1);
  });
});

// ---------------------------------------------------------------------------
// B. submit / validate need an active edition and an unsealed round

for (const status of ["completed", "archived"] as const) {
  test(`review B: a set of a ${status} edition takes no answers (submit and validate)`, async () => {
    await with_env(async (env) => {
      const where = await open_round(env);
      const set = await publish(env, where, [single_spec("합성 질문")], "pub-1");
      const q = set.members[0]!;
      set_edition_status(env, status);
      const before = snapshot(env);
      await rejects_api(
        submit_answers(env.service, env.ctx("sub-1"), { set_id: set.set_id, answers: [{ question_id: q.question_id, value: "a" }] }),
        "conflict",
      );
      assert.equal(snapshot(env), before);
      const v = validate_submission(env.db, env.ctx("v"), { set_id: set.set_id, answers: [{ question_id: q.question_id, value: "a" }] });
      assert.equal(v.ok, false);
      assert.equal(v.errors[0]!.code, "conflict");
      assert.equal(answer_versions_of(env.db, q.question_id).length, 0);
    });
  });
}

test("review B: a set of a sealed round takes no answers (submit and validate)", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [single_spec("합성 질문")], "pub-1");
    const q = set.members[0]!;
    await seal_round_of(env, where.round_id, "c1");
    const before = snapshot(env);
    await rejects_api(
      submit_answers(env.service, env.ctx("sub-1"), { set_id: set.set_id, answers: [{ question_id: q.question_id, value: "a" }] }),
      "conflict",
    );
    assert.equal(snapshot(env), before);
    const v = validate_submission(env.db, env.ctx("v"), { set_id: set.set_id, answers: [{ question_id: q.question_id, value: "a" }] });
    assert.equal(v.ok, false);
    assert.equal(v.errors[0]!.code, "conflict");
  });
});

test("review B: a set without a round (stage_start) of an active edition still takes answers (control)", async () => {
  await with_env(async (env) => {
    const s = stage_ids(env.db, env.p.edition_id);
    const set = await publish(env, { stage_id: s.plan, round_id: null }, [single_spec("합성 질문")], "pub-1");
    const out = await submit(env, set.set_id, [{ question_id: set.members[0]!.question_id, value: "a" }], "sub-1");
    assert.equal(out.answers.length, 1);
  });
});

// ---------------------------------------------------------------------------
// C. a closed question cannot go into a new set (and takes no answer)

for (const state of ["deferred", "withdrawn", "closed", "draft"] as const) {
  test(`review C: a question whose current version is '${state}' cannot be put into a new set`, async () => {
    await with_env(async (env) => {
      const where = await open_round(env);
      const set1 = await publish(env, where, [single_spec("합성 질문"), single_spec("합성 질문 2")], "pub-1");
      const q = set1.members[0]!;
      env.db.run("UPDATE question_versions SET state = ? WHERE version_id = ?", state, question_current(env.db, q.question_id));
      const before = snapshot(env);
      await rejects_api(
        publish_set(env.service, env.ctx("pub-2"), {
          stage_id: where.stage_id,
          round_id: where.round_id,
          purpose: "stage_start",
          form_key: "main",
          questions: [{ question_id: set1.members[1]!.question_id }, { question_id: q.question_id }],
        }),
        "conflict",
      );
      assert.equal(snapshot(env), before, "the whole set is refused, nothing written");
      assert.equal(question_version(env.db, question_current(env.db, q.question_id)).state, state);
    });
  });
}

test("review C: an answer to a question that is no longer open is refused, even from an older set", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [single_spec("합성 질문"), single_spec("합성 질문 2")], "pub-1");
    const [q1, q2] = set.members as [PublishResult["members"][number], PublishResult["members"][number]];
    env.db.run("UPDATE question_versions SET state = 'withdrawn' WHERE version_id = ?", question_current(env.db, q1.question_id));
    const before = snapshot(env);
    await rejects_api(
      submit_answers(env.service, env.ctx("sub-1"), {
        set_id: set.set_id,
        answers: [{ question_id: q2.question_id, value: "a" }, { question_id: q1.question_id, value: "a" }],
      }),
      "conflict",
    );
    assert.equal(snapshot(env), before, "the open question's answer is not written either");
  });
});

// ---------------------------------------------------------------------------
// D. required questions need a non-empty answer

const EMPTY_TEXT = ["", " ", "   ", "\t\n"];
for (const type of ["text", "textarea"] as const) {
  for (const empty of EMPTY_TEXT) {
    test(`review D: a required ${type} answered with ${JSON.stringify(empty)} is invalid_payload and the bundle is rejected`, async () => {
      await with_env(async (env) => {
        const where = await open_round(env);
        const set = await publish(
          env,
          where,
          [
            single_spec("합성 질문 1"),
            { text: "합성 필수", type, required: true, allow_comment_as_answer: false },
          ],
          "pub-1",
        );
        const [q1, q2] = set.members as [PublishResult["members"][number], PublishResult["members"][number]];
        const before = snapshot(env);
        await rejects_api(
          submit_answers(env.service, env.ctx("sub-1"), {
            set_id: set.set_id,
            answers: [{ question_id: q1.question_id, value: "a" }, { question_id: q2.question_id, value: empty }],
          }),
          "invalid_payload",
        );
        assert.equal(snapshot(env), before);
        const v = validate_submission(env.db, env.ctx("v"), {
          set_id: set.set_id,
          answers: [{ question_id: q2.question_id, value: empty }],
        });
        assert.equal(v.ok, false);
        assert.equal(v.errors[0]!.code, "invalid_payload");
        assert.equal(v.errors[0]!.question_id, q2.question_id);
      });
    });
  }
}

test("review D: a required multi answered with [] is invalid_payload and the bundle is rejected", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(
      env,
      where,
      [
        single_spec("합성 질문 1"),
        { text: "합성 다중", type: "multi", required: true, allow_comment_as_answer: false, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
      ],
      "pub-1",
    );
    const [q1, q2] = set.members as [PublishResult["members"][number], PublishResult["members"][number]];
    const before = snapshot(env);
    await rejects_api(
      submit_answers(env.service, env.ctx("sub-1"), {
        set_id: set.set_id,
        answers: [{ question_id: q1.question_id, value: "a" }, { question_id: q2.question_id, value: [] }],
      }),
      "invalid_payload",
    );
    assert.equal(snapshot(env), before);
    // control: a non-empty selection is fine
    const ok = await submit(env, set.set_id, [{ question_id: q2.question_id, value: ["a"] }], "sub-2");
    assert.equal(ok.answers.length, 1);
  });
});

test("review D: a non-required text may still be answered with an empty string (control, not pinned either way beyond not crashing)", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [text_spec("합성 선택 질문")], "pub-1");
    // Either accepted or invalid_payload is acceptable; it must not throw a non-ApiError.
    try {
      await submit_answers(env.service, env.ctx("sub-1"), { set_id: set.set_id, answers: [{ question_id: set.members[0]!.question_id, value: "" }] });
    } catch (error) {
      assert.ok(error instanceof ApiError);
    }
  });
});

// ---------------------------------------------------------------------------
// E. the same question twice in one set

test("review E: the same new-question id twice in one set is invalid_payload, not a raw SQLite error", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set1 = await publish(env, where, [single_spec("합성 질문")], "pub-1");
    const id = set1.members[0]!.question_id;
    const before = snapshot(env);
    await rejects_api(
      publish_set(env.service, env.ctx("pub-2"), {
        stage_id: where.stage_id,
        round_id: where.round_id,
        purpose: "stage_start",
        form_key: "main",
        questions: [{ question_id: id }, { question_id: id }],
      }),
      "invalid_payload",
    );
    assert.equal(snapshot(env), before);
  });
});

test("review E: a repeated id mixed with other questions is also invalid_payload", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set1 = await publish(env, where, [single_spec("합성 질문 1"), single_spec("합성 질문 2")], "pub-1");
    const [a, b] = set1.members as [PublishResult["members"][number], PublishResult["members"][number]];
    const before = snapshot(env);
    await rejects_api(
      publish_set(env.service, env.ctx("pub-2"), {
        stage_id: where.stage_id,
        round_id: where.round_id,
        purpose: "stage_start",
        form_key: "main",
        questions: [{ question_id: a.question_id }, single_spec("합성 새 질문"), { question_id: b.question_id }, { question_id: a.question_id }],
      }),
      "invalid_payload",
    );
    assert.equal(snapshot(env), before, "the new question in the same call was not created either");
  });
});

// ---------------------------------------------------------------------------
// F. only the latest set of a (stage_id, form_key) takes answers

test("review F: an older set of the same (stage, form_key) is stale even when every member version is unchanged", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set1 = await publish(env, where, [single_spec("합성 질문")], "pub-1");
    const q = set1.members[0]!;
    const set2 = await publish(env, where, [{ question_id: q.question_id }], "pub-2");
    assert.equal(set2.set_version_no, 2);
    assert.equal(set2.members[0]!.question_version_id, q.question_version_id, "same question version in both sets");

    const before = snapshot(env);
    await rejects_api(
      submit_answers(env.service, env.ctx("sub-old"), { set_id: set1.set_id, answers: [{ question_id: q.question_id, value: "a" }] }),
      "conflict",
    );
    assert.equal(snapshot(env), before);
    const v = validate_submission(env.db, env.ctx("v"), { set_id: set1.set_id, answers: [{ question_id: q.question_id, value: "a" }] });
    assert.equal(v.ok, false);
    assert.equal(v.errors[0]!.code, "conflict");

    // the latest set works
    const ok = await submit(env, set2.set_id, [{ question_id: q.question_id, value: "a" }], "sub-new");
    assert.equal(ok.set_id, set2.set_id);
  });
});

test("review F: a different form_key of the same stage is independent (its latest set stays answerable)", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const main = await publish(env, where, [single_spec("합성 질문 A")], "pub-main");
    const side = await publish(env, where, [single_spec("합성 질문 B")], "pub-side", { form_key: "side" });
    await publish(env, where, [{ question_id: main.members[0]!.question_id }], "pub-main-2");
    const ok = await submit(env, side.set_id, [{ question_id: side.members[0]!.question_id, value: "a" }], "sub-side");
    assert.equal(ok.answers.length, 1);
  });
});

// ---------------------------------------------------------------------------
// G. answer.submit takes no lease fields

for (const extra of [{ run_id: "run-x" }, { lease_id: "lease-x" }, { fence: 1 }, { run_id: "run-x", lease_id: "lease-x", fence: 1 }]) {
  test(`review G: answer.submit rejects ${Object.keys(extra).join("+")} as unknown field(s)`, async () => {
    await with_env(async (env) => {
      const where = await open_round(env);
      const set = await publish(env, where, [single_spec("합성 질문")], "pub-1");
      const before = snapshot(env);
      await rejects_api(
        submit_answers(env.service, env.ctx("sub-1"), {
          set_id: set.set_id,
          answers: [{ question_id: set.members[0]!.question_id, value: "a" }],
          ...extra,
        }),
        "invalid_payload",
      );
      assert.equal(snapshot(env), before);
      const v = validate_submission(env.db, env.ctx("v"), {
        set_id: set.set_id,
        answers: [{ question_id: set.members[0]!.question_id, value: "a" }],
        ...extra,
      });
      assert.equal(v.ok, false, "validate_submission rejects the same unknown fields");
      assert.equal(v.errors[0]!.code, "invalid_payload");
    });
  });
}

// ---------------------------------------------------------------------------
// H. allow_comment_as_answer defaults to false for new questions

function spec_without_allow(text: string): Record<string, unknown> {
  const spec = single_spec(text);
  delete spec.allow_comment_as_answer;
  return spec;
}

test("review H: a new question spec without allow_comment_as_answer is stored as 0", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [spec_without_allow("합성 질문")], "pub-1");
    const row = question_version(env.db, set.members[0]!.question_version_id);
    assert.equal(row.allow_comment_as_answer, 0n);
  });
});

test("review H: with the default, a comment alone is NOT an answer; it is kept only as a comment", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [spec_without_allow("합성 질문")], "pub-1");
    const q = set.members[0]!;
    const out = await submit(env, set.set_id, [{ question_id: q.question_id, other: "합성 덧붙임" }], "sub-1");
    assert.equal(out.answers[0]!.answer_id, null);
    assert.equal(out.answers[0]!.version_id, null);
    assert.equal(answer_versions_of(env.db, q.question_id).length, 0);
    const comments = comments_of(env.db, q.question_id);
    assert.equal(comments.length, 1);
    assert.equal(comments[0]!.body_md, "합성 덧붙임");
  });
});

test("review H: an explicit allow_comment_as_answer: true makes a comment alone an answer", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [single_spec("합성 질문", { allow_comment_as_answer: true })], "pub-1");
    const q = set.members[0]!;
    assert.equal(question_version(env.db, q.question_version_id).allow_comment_as_answer, 1n);
    const out = await submit(env, set.set_id, [{ question_id: q.question_id, other: "합성 덧붙임" }], "sub-1");
    assert.ok(out.answers[0]!.answer_id);
    assert.equal(answer_versions_of(env.db, q.question_id).length, 1);
  });
});

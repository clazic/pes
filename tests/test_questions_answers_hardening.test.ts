// SEL-41 (stage 2 PR8) hardening: tries to break the question/answer implementation.
// Interfaces and meanings: see the header of tests/test_questions_answers.test.ts.
// Everything is synthetic (FakeClock, temporary HOME). Rows from node:sqlite are copied with { ...row };
// bigint values are serialised with a replacer.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  publish_set,
  resume_ready,
  revise_question,
  submit_answers,
  validate_submission,
} from "../scripts/pes_core/questions.ts";
import { second_project } from "./helpers/blob_env.ts";
import { ctx_for } from "./helpers/editions_env.ts";
import {
  add_agent,
  agent_claim,
  agent_ctx,
  answer_objects_of,
  answer_versions_of,
  comments_of,
  counts,
  events_of,
  open_round,
  publish,
  question_current,
  receipt_of,
  rejects_api,
  single_spec,
  submit,
  text_spec,
  with_env,
  wrap_db,
  type Env,
  type Guard,
  type PublishResult,
  type ReviseResult,
} from "./helpers/questions_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? `${v}n` : v);

function missing(env: Env, round_id: string) {
  return resume_ready(env.db, env.p.project_id, round_id).missing.map((m) => ({ ...m }));
}

function missing_ids(env: Env, round_id: string): string[] {
  return missing(env, round_id).map((m) => m.question_id).sort();
}

async function revise(env: Env, question_id: string, fields: Record<string, unknown>, key: string): Promise<ReviseResult> {
  const out = await revise_question(env.service, env.ctx(key), { question_id, ...fields });
  return out.result as ReviseResult;
}

function answer_rows_json(env: Env, question_id: string): string {
  return JSON.stringify(answer_versions_of(env.db, question_id), replacer);
}

// ---------------------------------------------------------------------------
// 1. Version pinning

test("hardening: an old set cannot be answered after a revision; a re-published set must be re-confirmed and the old answer is left untouched", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set1 = await publish(env, where, [single_spec("합성 질문 1"), text_spec("합성 질문 2", { required: true })], "pub-1");
    const [q1, q2] = set1.members as [PublishResult["members"][number], PublishResult["members"][number]];

    // a first answer on the original version
    await submit(env, set1.set_id, [{ question_id: q1.question_id, value: "a" }], "sub-1");
    const old_rows = answer_rows_json(env, q1.question_id);
    assert.equal(JSON.parse(old_rows).length, 1);

    // the question changes
    const rev = await revise(env, q1.question_id, { text: "합성 질문 1 (고침)" }, "rev-1");
    assert.equal(rev.version_no, 2);

    // the OLD set is stale for q1: one conflict, nothing written, even when the other item is fine
    const before = state_signature(env.db);
    await rejects_api(
      submit_answers(env.service, env.ctx("sub-stale"), { set_id: set1.set_id, answers: [{ question_id: q2.question_id, value: "x" }, { question_id: q1.question_id, value: "b" }] }),
      "conflict",
    );
    assert.equal(state_signature(env.db), before);
    const v = validate_submission(env.db, env.ctx("v"), { set_id: set1.set_id, answers: [{ question_id: q1.question_id, value: "b" }] });
    assert.equal(v.ok, false);
    assert.equal(v.errors[0]!.code, "conflict");
    assert.equal(v.errors[0]!.question_id, q1.question_id);

    // q2 alone in the old set is still fine (its version did not move)
    await submit(env, set1.set_id, [{ question_id: q2.question_id, value: "x" }], "sub-q2");

    // still ready-blocked on q1 only, and it is a reconfirmation, not "unanswered"
    assert.deepEqual(missing(env, where.round_id), [
      { question_id: q1.question_id, question_version_id: rev.question_version_id, reason: "needs_reconfirmation" },
    ]);

    // publish the new set at the current versions
    const set2 = await publish(env, where, [{ question_id: q1.question_id }, { question_id: q2.question_id }], "pub-2");
    assert.equal(set2.set_version_no, 2);
    assert.equal(set2.members[0]!.question_version_id, rev.question_version_id);
    // the latest set is the one that counts, and the revised question still waits
    assert.deepEqual(missing_ids(env, where.round_id), [q1.question_id]);
    assert.equal(answer_rows_json(env, q1.question_id), old_rows, "publishing does not touch the old answer");

    // the old set is stale for q1 for good, the new one works
    await rejects_api(submit_answers(env.service, env.ctx("sub-stale-2"), { set_id: set1.set_id, answers: [{ question_id: q1.question_id, value: "b" }] }), "conflict");
    const fresh = await submit(env, set2.set_id, [{ question_id: q1.question_id, value: "b" }], "sub-new");
    assert.equal(fresh.answers[0]!.question_version_id, rev.question_version_id);

    // the old answer row is untouched (same bytes), a new one was appended after it
    const rows = answer_versions_of(env.db, q1.question_id);
    assert.equal(rows.length, 2);
    assert.equal(JSON.stringify([rows[0]], replacer), JSON.stringify([JSON.parse(old_rows)[0]]));
    assert.equal(rows[0]!.question_version_id, q1.question_version_id);
    assert.equal(rows[1]!.question_version_id, rev.question_version_id);
    assert.equal(rows[1]!.supersedes_version_id, rows[0]!.version_id);
    assert.equal(answer_objects_of(env.db, q1.question_id).length, 1, "one answers object per question");
    assert.deepEqual(missing(env, where.round_id), []);
  });
});

test("hardening: a second revision invalidates a set that was published between the two", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set1 = await publish(env, where, [single_spec("합성 질문")], "pub-1");
    const q = set1.members[0]!;
    await revise(env, q.question_id, { text: "둘째" }, "rev-1");
    const set2 = await publish(env, where, [{ question_id: q.question_id }], "pub-2");
    await revise(env, q.question_id, { text: "셋째" }, "rev-2");

    for (const set of [set1, set2]) {
      await rejects_api(
        submit_answers(env.service, env.ctx(`stale-${set.set_version_no}`), { set_id: set.set_id, answers: [{ question_id: q.question_id, value: "a" }] }),
        "conflict",
      );
    }
    assert.equal(answer_versions_of(env.db, q.question_id).length, 0);
  });
});

test("hardening: revising makes an optional question required and a required one optional for resume_ready", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [single_spec("합성 필수"), text_spec("합성 선택")], "pub-1");
    const [req, opt] = set.members.map((m) => m.question_id) as [string, string];
    assert.deepEqual(missing_ids(env, where.round_id), [req]);

    await revise(env, opt, { required: true }, "rev-opt");
    await revise(env, req, { required: false }, "rev-req");
    // judged by the CURRENT version, not the version in the (older) set
    assert.deepEqual(missing_ids(env, where.round_id), [opt]);
    const [m] = missing(env, where.round_id);
    assert.equal(m!.question_version_id, question_current(env.db, opt));
    assert.equal(m!.reason, "unanswered");
  });
});

// ---------------------------------------------------------------------------
// 2. allow_comment_as_answer × (other only / value only / both) × (empty, blank, text, lone surrogate)

for (const allow of [false, true]) {
  test(`hardening: allow_comment_as_answer=${allow ? 1 : 0}: other only / value only / both`, async () => {
    await with_env(async (env) => {
      const where = await open_round(env);
      const set = await publish(env, where, [
        single_spec("합성 질문 1", { allow_comment_as_answer: allow }),
        single_spec("합성 질문 2", { allow_comment_as_answer: allow }),
        single_spec("합성 질문 3", { allow_comment_as_answer: allow }),
      ], "pub-1");
      const [only, val, both] = set.members as [PublishResult["members"][number], PublishResult["members"][number], PublishResult["members"][number]];

      const r = await submit(env, set.set_id, [
        { question_id: only.question_id, other: "합성 의견만" },
        { question_id: val.question_id, value: "c" },
        { question_id: both.question_id, value: "a", other: "합성 값과 의견" },
      ], "sub-1");

      // other only
      const o = answer_versions_of(env.db, only.question_id);
      if (allow) {
        assert.equal(o.length, 1);
        assert.equal(o[0]!.value, "null", "a comment never turns into a choice, not even the recommended one");
        assert.equal(o[0]!.used_default, 0n);
        assert.ok(r.answers[0]!.version_id);
      } else {
        assert.equal(o.length, 0);
        assert.equal(r.answers[0]!.answer_id, null);
        assert.equal(r.answers[0]!.version_id, null);
      }
      assert.equal(comments_of(env.db, only.question_id).length, 1);
      assert.ok(r.answers[0]!.thread_id && r.answers[0]!.message_id);

      // value only: an answer, no comment rows
      assert.equal(answer_versions_of(env.db, val.question_id)[0]!.value, JSON.stringify("c"));
      assert.equal(comments_of(env.db, val.question_id).length, 0);
      assert.equal(r.answers[1]!.thread_id, null);
      assert.equal(r.answers[1]!.message_id, null);

      // both: the value wins as the answer, the text is the comment
      assert.equal(answer_versions_of(env.db, both.question_id)[0]!.value, JSON.stringify("a"));
      assert.equal(comments_of(env.db, both.question_id)[0]!.body_md, "합성 값과 의견");

      const unanswered = allow ? [] : [only.question_id];
      assert.deepEqual(missing_ids(env, where.round_id), unanswered);
    });
  });

  test(`hardening: allow_comment_as_answer=${allow ? 1 : 0}: empty, blank and lone-surrogate comments`, async () => {
    await with_env(async (env) => {
      const where = await open_round(env);
      const set = await publish(env, where, [single_spec("합성 질문", { allow_comment_as_answer: allow })], "pub-1");
      const q = set.members[0]!.question_id;

      // nothing but an empty / blank / null / missing comment: not an answer, refused, nothing written
      const before = state_signature(env.db);
      for (const [i, item] of [
        { question_id: q },
        { question_id: q, other: "" },
        { question_id: q, other: "   " },
        { question_id: q, other: "\n\t " },
        { question_id: q, other: null },
        { question_id: q, value: null },
        { question_id: q, value: null, other: "  " },
      ].entries()) {
        await rejects_api(submit_answers(env.service, env.ctx(`empty-${i}`), { set_id: set.set_id, answers: [item] }), "invalid_payload");
      }
      // a lone surrogate is not text
      await rejects_api(submit_answers(env.service, env.ctx("lone-1"), { set_id: set.set_id, answers: [{ question_id: q, other: "\ud800" }] }), "invalid_payload");
      await rejects_api(submit_answers(env.service, env.ctx("lone-2"), { set_id: set.set_id, answers: [{ question_id: q, value: "a", other: "합성\udc00" }] }), "invalid_payload");
      await rejects_api(submit_answers(env.service, env.ctx("lone-3"), { set_id: set.set_id, answers: [{ question_id: "\ud800", value: "a" }] }), "invalid_payload");
      await rejects_api(submit_answers(env.service, env.ctx("lone-4"), { set_id: "\ud800", answers: [{ question_id: q, value: "a" }] }), "invalid_payload");
      assert.equal(state_signature(env.db), before);
      for (const item of [{ question_id: q, other: 5 }, { question_id: q, other: ["x"] }, { question_id: q, other: {} }]) {
        assert.equal(validate_submission(env.db, env.ctx("v"), { set_id: set.set_id, answers: [item] }).errors[0]!.code, "invalid_payload");
      }

      // a value with a blank / empty comment is just the value: no thread, no message
      const r = await submit(env, set.set_id, [{ question_id: q, value: "a", other: "   " }], "blank-with-value");
      assert.equal(r.answers[0]!.thread_id, null);
      assert.equal(comments_of(env.db, q).length, 0);
      assert.equal(counts(env.db).threads, 0n);
      const r2 = await submit(env, set.set_id, [{ question_id: q, value: "b", other: "" }], "empty-with-value");
      assert.equal(r2.answers[0]!.message_id, null);
      assert.equal(counts(env.db).messages, 0n);
    });
  });
}

test("hardening: a comment-only item on a question that allows it still pins the seen version and is satisfied", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [single_spec("합성 질문", { allow_comment_as_answer: true })], "pub-1");
    const q = set.members[0]!;
    const r = await submit(env, set.set_id, [{ question_id: q.question_id, other: "합성 의견" }], "sub-1");
    const rows = answer_versions_of(env.db, q.question_id);
    assert.equal(rows[0]!.question_version_id, q.question_version_id);
    assert.equal(rows[0]!.value, "null");
    const c = comments_of(env.db, q.question_id)[0]!;
    assert.equal(c.target_version_id, q.question_version_id);
    assert.equal(c.submission_id, r.submission_id);
    assert.equal(c.actor_id, env.p.actor_id);
    assert.deepEqual(missing(env, where.round_id), []);
  });
});

// ---------------------------------------------------------------------------
// 3. Defaults and recommendations

test("hardening: used_default is forged in every way it can be and nothing is written", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [
      single_spec("합성 단일"),
      text_spec("합성 글", { default_value: "기본", required: true }),
      number_spec_with_default(),
      single_spec("합성 무기본", { default_value: null }),
      { text: "합성 다중", type: "multi", required: true, allow_comment_as_answer: false, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], default_value: ["a", "b"] },
    ], "pub-1");
    const [single, txt, num, nodef, multi] = set.members.map((m) => m.question_id) as [string, string, string, string, string];

    const before = state_signature(env.db);
    const bad: Record<string, unknown>[][] = [
      [{ question_id: single, value: "a", used_default: true }], // value != default ("b")
      [{ question_id: single, value: "c", used_default: true }],
      [{ question_id: txt, value: "다른", used_default: true }],
      [{ question_id: txt, value: "기본 ", used_default: true }], // near miss
      [{ question_id: num, value: 6, used_default: true }],
      [{ question_id: nodef, value: "b", used_default: true }], // no default at all
      [{ question_id: nodef, value: "a", used_default: true }],
      [{ question_id: multi, value: ["a"], used_default: true }],
      [{ question_id: multi, value: [], used_default: true }],
      [{ question_id: single, used_default: true }], // no value
      [{ question_id: single, other: "합성", used_default: true }], // only a comment
      [{ question_id: single, value: "b", used_default: "true" }], // not a boolean
      [{ question_id: single, value: "b", used_default: 1 }],
      [{ question_id: single, value: "b", used_default: null }],
      // one forged item hides behind good ones
      [{ question_id: txt, value: "기본", used_default: true }, { question_id: nodef, value: "a", used_default: true }],
    ];
    for (const [i, answers] of bad.entries()) {
      await rejects_api(submit_answers(env.service, env.ctx(`forge-${i}`), { set_id: set.set_id, answers }), "invalid_payload");
    }
    assert.equal(state_signature(env.db), before);
    assert.equal(counts(env.db).answers, 0n);

    // the honest use: value equals the default, flag recorded as 1; same value without the flag is 0
    await submit(env, set.set_id, [
      { question_id: single, value: "b", used_default: true },
      { question_id: txt, value: "기본", used_default: true },
      { question_id: num, value: 5, used_default: true },
      { question_id: multi, value: ["a", "b"], used_default: true },
      { question_id: nodef, value: "b", used_default: false },
    ], "honest");
    for (const q of [single, txt, num, multi]) assert.equal(answer_versions_of(env.db, q)[0]!.used_default, 1n);
    assert.equal(answer_versions_of(env.db, nodef)[0]!.used_default, 0n);

    // choosing the default value again without pressing the button is recorded as 0 and supersedes
    await submit(env, set.set_id, [{ question_id: single, value: "b" }], "again");
    const rows = answer_versions_of(env.db, single);
    assert.deepEqual(rows.map((r) => r.used_default), [1n, 0n]);
  });
});

function number_spec_with_default(): Record<string, unknown> {
  return { text: "합성 숫자", type: "number", required: true, allow_comment_as_answer: false, default_value: 5 };
}

test("hardening: the recommended option and the default are never picked for the human, however the submission is shaped", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [
      single_spec("합성 질문 1", { allow_comment_as_answer: true }),
      single_spec("합성 질문 2"),
      single_spec("합성 질문 3"),
    ], "pub-1");
    const [a, b, c] = set.members.map((m) => m.question_id) as [string, string, string];

    // comment only, bare comment, an untouched item: none picks "a" (recommended) or "b" (default)
    await submit(env, set.set_id, [{ question_id: a, other: "추천에 동의합니다" }, { question_id: b, other: "기본값 좋아요" }], "sub-1");
    assert.equal(answer_versions_of(env.db, a)[0]!.value, "null");
    assert.equal(answer_versions_of(env.db, b).length, 0);
    assert.equal(answer_versions_of(env.db, c).length, 0);
    for (const q of [b, c]) assert.ok(missing_ids(env, where.round_id).includes(q));

    // an out-of-options value is refused, not "fixed" to the recommended one
    await rejects_api(submit_answers(env.service, env.ctx("bad"), { set_id: set.set_id, answers: [{ question_id: c, value: "zzz" }] }), "invalid_payload");
    await rejects_api(submit_answers(env.service, env.ctx("bad2"), { set_id: set.set_id, answers: [{ question_id: c, value: ["a"] }] }), "invalid_payload");
    await rejects_api(submit_answers(env.service, env.ctx("bad3"), { set_id: set.set_id, answers: [{ question_id: c, value: 1 }] }), "invalid_payload");
    assert.equal(answer_versions_of(env.db, c).length, 0);

    // validate_submission reads only
    const before = state_signature(env.db);
    validate_submission(env.db, env.ctx("v"), { set_id: set.set_id, answers: [{ question_id: c, value: "a" }] });
    validate_submission(env.db, env.ctx("v"), { set_id: set.set_id, answers: [{ question_id: c, value: "zzz" }] });
    assert.equal(state_signature(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// 4. Bundles: all or nothing

test("hardening: only the last item is wrong, and each kind of wrong writes nothing", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [
      single_spec("합성 질문 1", { allow_comment_as_answer: true }),
      text_spec("합성 질문 2"),
      text_spec("합성 질문 3"),
    ], "pub-1");
    const [a, b, c] = set.members.map((m) => m.question_id) as [string, string, string];
    const good = [{ question_id: a, value: "a", other: "합성 좋은 의견" }, { question_id: b, value: "x" }];

    const before = state_signature(env.db);
    const last_bad: [string, Record<string, unknown>][] = [
      ["invalid_payload", { question_id: c, value: 7 }],
      ["invalid_payload", { question_id: c }],
      ["invalid_payload", { question_id: c, value: "x", surprise: 1 }],
      ["invalid_payload", { question_id: a, value: "b" }], // duplicate question
      ["invalid_payload", { question_id: "not-in-this-set", value: "x" }],
    ];
    for (const [i, [code, item]] of last_bad.entries()) {
      await rejects_api(submit_answers(env.service, env.ctx(`last-${i}`), { set_id: set.set_id, answers: [...good, item] }), code);
      assert.equal(state_signature(env.db), before, `case ${i} wrote something`);
    }
    // stale last item
    await revise(env, c, { text: "고침" }, "rev-c");
    const mid = state_signature(env.db);
    await rejects_api(submit_answers(env.service, env.ctx("last-stale"), { set_id: set.set_id, answers: [...good, { question_id: c, value: "x" }] }), "conflict");
    assert.equal(state_signature(env.db), mid);
    assert.equal(receipt_of(env.db, env.p.project_id, "last-stale"), undefined);

    // an unknown top-level field, an empty list, a non-list
    for (const [i, input] of [
      { set_id: set.set_id, answers: good, extra: 1 },
      { set_id: set.set_id, answers: [] },
      { set_id: set.set_id, answers: "x" },
      { set_id: set.set_id },
      { answers: good },
      { set_id: "", answers: good },
      { set_id: 5, answers: good },
    ].entries()) {
      await rejects_api(submit_answers(env.service, env.ctx(`top-${i}`), input), "invalid_payload");
    }
    assert.equal(state_signature(env.db), mid);
    await rejects_api(submit_answers(env.service, env.ctx("unknown-set"), { set_id: "no-such-set", answers: good }), "not_found");
    assert.equal(state_signature(env.db), mid);
  });
});

test("hardening: a failure injected into the very last write of the last item rolls everything back; the same key then works", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [single_spec("합성 질문 1"), text_spec("합성 질문 2")], "pub-1");
    const [a, b] = set.members.map((m) => m.question_id) as [string, string];
    const answers = [{ question_id: a, value: "a", other: "합성 의견 1" }, { question_id: b, value: "x", other: "합성 의견 2" }];
    const before = state_signature(env.db);

    // each table the command writes, failing on its LAST insert
    for (const [table, nth] of [["submissions", 1], ["answer_versions", 2], ["threads", 2], ["thread_versions", 2], ["messages", 2], ["message_versions", 2], ["object_versions", 99], ["events", 1], ["mutation_commits", 1]] as const) {
      let seen = 0;
      const wrapped = wrap_db(env.db, (sql) => {
        if (new RegExp(`INSERT INTO ${table}\\b`, "i").test(sql)) {
          seen += 1;
          if (seen === nth || nth === 99) throw new Error(`injected failure in ${table}`);
        }
      });
      await assert.rejects(submit_answers(env.with_db(wrapped), env.ctx("sub-1"), { set_id: set.set_id, answers }));
      assert.equal(state_signature(env.db), before, `${table}: something survived the rollback`);
    }
    const ok = await submit_answers(env.service, env.ctx("sub-1"), { set_id: set.set_id, answers });
    assert.equal(ok.replayed, false);
    assert.equal(counts(env.db).answer_versions, 2n);
    assert.equal(counts(env.db).threads, 2n);
  });
});

test("hardening: replaying a bundle with the same key returns the stored result and writes nothing; another request on that key is refused", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [single_spec("합성 질문 1"), text_spec("합성 질문 2")], "pub-1");
    const [a, b] = set.members.map((m) => m.question_id) as [string, string];
    const answers = [{ question_id: a, value: "a", other: "합성 의견" }, { question_id: b, value: "x" }];
    const first = await submit_answers(env.service, env.ctx("k"), { set_id: set.set_id, answers });
    const settled = state_signature(env.db);

    const again = await submit_answers(env.service, env.ctx("k"), { set_id: set.set_id, answers });
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, first.result);
    assert.equal(state_signature(env.db), settled);

    // a different request on the same key: refused, nothing changes (even a "smaller" one)
    for (const other of [
      [{ question_id: a, value: "c" }],
      [{ question_id: a, value: "a" }],
      [answers[1]!, answers[0]!],
      [{ ...answers[0]!, other: "다른 의견" }, answers[1]!],
    ]) {
      await rejects_api(submit_answers(env.service, env.ctx("k"), { set_id: set.set_id, answers: other }), "idempotency_key_reuse");
    }
    assert.equal(state_signature(env.db), settled);
    assert.equal(answer_versions_of(env.db, a).length, 1);

    // another key with the same content is a new submission: a second version, the first one kept
    await submit_answers(env.service, env.ctx("k2"), { set_id: set.set_id, answers });
    assert.equal(answer_versions_of(env.db, a).length, 2);
    assert.equal(counts(env.db).submissions, 2n);
    assert.equal(counts(env.db).threads, 2n, "the comment is kept again for the second submission");
  });
});

test("hardening: a published set key is replayable too, and a rejected command leaves no receipt or event", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    await rejects_api(publish_set(env.service, env.ctx("bad-pub"), { stage_id: where.stage_id, round_id: where.round_id, purpose: "stage_start", form_key: "main", questions: [] }), "invalid_payload");
    assert.equal(receipt_of(env.db, env.p.project_id, "bad-pub"), undefined);
    const set = await publish(env, where, [single_spec("합성 질문")], "pub-1");
    const receipt = receipt_of(env.db, env.p.project_id, "pub-1")!;
    assert.equal(events_of(env.db, receipt.id).length, 1);
    assert.ok(set.set_id);
  });
});

// ---------------------------------------------------------------------------
// 5. __other

test("hardening: a comment never replaces an earlier real choice and every earlier comment thread is kept", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [single_spec("합성 질문")], "pub-1");
    const q = set.members[0]!;

    await submit(env, set.set_id, [{ question_id: q.question_id, value: "c", other: "합성 첫 의견" }], "sub-1");
    const first_comment = comments_of(env.db, q.question_id)[0]!;

    // a later comment-only submission on a question that does NOT allow it: the choice stays "c"
    const r = await submit(env, set.set_id, [{ question_id: q.question_id, other: "합성 추천에 동의" }], "sub-2");
    assert.equal(r.answers[0]!.version_id, null);
    const rows = answer_versions_of(env.db, q.question_id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.value, JSON.stringify("c"));
    const obj = answer_objects_of(env.db, q.question_id)[0]!;
    assert.equal(obj.current_version_id, rows[0]!.version_id);

    // a third submission with a new value and a new comment: two more threads in the end
    await submit(env, set.set_id, [{ question_id: q.question_id, value: "a", other: "합성 셋째 의견" }], "sub-3");
    const comments = comments_of(env.db, q.question_id);
    assert.equal(comments.length, 3);
    assert.deepEqual(comments.map((c) => c.body_md), ["합성 첫 의견", "합성 추천에 동의", "합성 셋째 의견"]);
    assert.equal(new Set(comments.map((c) => c.thread_id)).size, 3, "a new thread per comment, none reused");
    assert.deepEqual({ ...comments[0]! }, { ...first_comment }, "the first thread/message is exactly as it was");
    assert.equal(new Set(comments.map((c) => c.submission_id)).size, 3);
  });
});

test("hardening: a minimal comment is exactly a thread, a message, their versions and nothing else; the same text twice in one bundle stays two rows", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [single_spec("합성 질문 1"), single_spec("합성 질문 2")], "pub-1");
    const [a, b] = set.members as [PublishResult["members"][number], PublishResult["members"][number]];
    const before = counts(env.db);
    const r = await submit(env, set.set_id, [
      { question_id: a.question_id, value: "a", other: "같은 글" },
      { question_id: b.question_id, value: "a", other: "같은 글" },
    ], "sub-1");
    const after = counts(env.db);
    assert.equal(after.submissions - before.submissions, 1n);
    assert.equal(after.answer_versions - before.answer_versions, 2n);
    assert.equal(after.threads - before.threads, 2n);
    assert.equal(after.messages - before.messages, 2n);
    assert.equal(after.message_versions - before.message_versions, 2n);
    assert.equal(after.question_versions, before.question_versions, "a comment does not touch the questions");
    assert.equal(after.question_sets, before.question_sets);
    assert.equal(after.mutation_commits - before.mutation_commits, 1n);
    assert.notEqual(r.answers[0]!.thread_id, r.answers[1]!.thread_id);
    for (const [m, e] of [[a, r.answers[0]!], [b, r.answers[1]!]] as const) {
      const c = comments_of(env.db, m.question_id);
      assert.equal(c.length, 1);
      assert.equal(c[0]!.thread_id, e.thread_id);
      assert.equal(c[0]!.message_id, e.message_id);
      assert.equal(c[0]!.context_kind, "question_comment");
      assert.equal(c[0]!.target_version_id, m.question_version_id);
      assert.equal(c[0]!.message_state, "published");
    }
    const thread_current = env.db.all<{ current_version_id: string | null }>("SELECT current_version_id FROM objects WHERE kind IN ('thread','message')").map((row) => ({ ...row }));
    assert.equal(thread_current.length, 4);
    assert.ok(thread_current.every((row) => row.current_version_id !== null));
  });
});

test("hardening: a comment on a revised question points at the version the human saw, not the newest one", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set1 = await publish(env, where, [text_spec("합성 질문")], "pub-1");
    const q = set1.members[0]!;
    const rev = await revise(env, q.question_id, { text: "고침" }, "rev");
    const set2 = await publish(env, where, [{ question_id: q.question_id }], "pub-2");
    await submit(env, set2.set_id, [{ question_id: q.question_id, value: "x", other: "합성 의견" }], "sub-1");
    const c = comments_of(env.db, q.question_id)[0]!;
    assert.equal(c.target_version_id, rev.question_version_id);
    assert.notEqual(c.target_version_id, q.question_version_id);
  });
});

// ---------------------------------------------------------------------------
// 6. Who may do what, and in which project

test("hardening: an agent cannot answer, however the request is dressed", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const base = add_agent(env);
    const lease = await agent_claim(env, base, "claim");
    const guard: Guard = { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence };
    const set = await publish(env, where, [single_spec("합성 질문")], "pub-1");
    const q = set.members[0]!.question_id;
    const before = state_signature(env.db);

    const bundles: Record<string, unknown>[] = [
      { set_id: set.set_id, answers: [{ question_id: q, value: "a" }] },
      { set_id: set.set_id, answers: [{ question_id: q, value: "a" }], ...guard },
      { set_id: set.set_id, answers: [{ question_id: q, value: "a" }], ...guard, fence: guard.fence + 5 },
      { set_id: set.set_id, answers: [{ question_id: q, other: "의견" }], ...guard },
    ];
    for (const [i, input] of bundles.entries()) {
      await rejects_api(submit_answers(env.service, agent_ctx(base, `ag-${i}`), input), "forbidden", "invalid_payload");
    }
    // the human-shaped ones must be exactly forbidden (the extra fence/run fields are not part of answer.submit)
    await rejects_api(submit_answers(env.service, agent_ctx(base, "ag-x"), bundles[0]!), "forbidden");
    await rejects_api(submit_answers(env.service, agent_ctx(base, "ag-y"), bundles[3]!), "forbidden", "invalid_payload");
    assert.equal(state_signature(env.db), before);
    assert.equal(counts(env.db).submissions, 0n);

    // the same agent id presented with a human's `via` values is still an agent
    for (const via of ["web", "cli"] as const) {
      await rejects_api(submit_answers(env.service, { ...agent_ctx(base, `via-${via}`), via }, bundles[0]!), "forbidden");
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("hardening: a disabled human actor or a disabled user can do none of the three commands", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [single_spec("합성 질문")], "pub-1");
    const q = set.members[0]!.question_id;

    const calls = (tag: string) => [
      () => publish_set(env.service, env.ctx(`${tag}-pub`), { stage_id: where.stage_id, round_id: where.round_id, purpose: "review", form_key: "x", questions: [single_spec("합성")] }),
      () => revise_question(env.service, env.ctx(`${tag}-rev`), { question_id: q, text: "고침" }),
      () => submit_answers(env.service, env.ctx(`${tag}-sub`), { set_id: set.set_id, answers: [{ question_id: q, value: "a" }] }),
    ];

    env.db.run("UPDATE actors SET disabled_at = ? WHERE id = ?", env.clock.now_ms(), env.p.actor_id);
    const before = state_signature(env.db);
    for (const call of calls("actor")) await rejects_api(call(), "forbidden");
    assert.equal(state_signature(env.db), before);
    env.db.run("UPDATE actors SET disabled_at = NULL WHERE id = ?", env.p.actor_id);

    const user = env.db.get<{ user_id: string }>("SELECT user_id FROM actors WHERE id = ?", env.p.actor_id)!;
    env.db.run("UPDATE users SET disabled_at = ? WHERE id = ?", env.clock.now_ms(), user.user_id);
    const before2 = state_signature(env.db);
    for (const call of calls("user")) await rejects_api(call(), "forbidden");
    assert.equal(state_signature(env.db), before2);
    env.db.run("UPDATE users SET disabled_at = NULL WHERE id = ?", user.user_id);

    // enabled again: it works
    await submit(env, set.set_id, [{ question_id: q, value: "a" }], "ok");
  });
});

test("hardening: sets, questions and rounds of another project are unreachable and a mixed-up set is refused", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const other_p = await second_project(env);
    const other_env: Env = { ...env, p: other_p, ctx: (key: string) => ctx_for(other_p, key) };
    const other_where = await open_round(other_env, "o");

    const mine = await publish(env, where, [single_spec("합성 내 질문")], "pub-mine");
    const theirs = await publish(other_env, other_where, [single_spec("합성 남의 질문")], "pub-theirs");
    const my_q = mine.members[0]!.question_id;
    const their_q = theirs.members[0]!.question_id;

    const before = state_signature(env.db);
    // my context, their set / their question
    await rejects_api(submit_answers(env.service, env.ctx("x1"), { set_id: theirs.set_id, answers: [{ question_id: their_q, value: "a" }] }), "not_found");
    await rejects_api(submit_answers(env.service, env.ctx("x2"), { set_id: mine.set_id, answers: [{ question_id: their_q, value: "a" }] }), "invalid_payload");
    await rejects_api(submit_answers(env.service, env.ctx("x3"), { set_id: mine.set_id, answers: [{ question_id: my_q, value: "a" }, { question_id: their_q, value: "a" }] }), "invalid_payload");
    await rejects_api(revise_question(env.service, env.ctx("x4"), { question_id: their_q, text: "가로채기" }), "not_found");
    await rejects_api(publish_set(env.service, env.ctx("x5"), { stage_id: other_where.stage_id, round_id: null, purpose: "review", form_key: "x", questions: [single_spec("합성")] }), "not_found");
    await rejects_api(publish_set(env.service, env.ctx("x6"), { stage_id: where.stage_id, round_id: other_where.round_id, purpose: "review", form_key: "x", questions: [single_spec("합성")] }), "not_found");
    await rejects_api(publish_set(env.service, env.ctx("x7"), { stage_id: where.stage_id, round_id: null, purpose: "review", form_key: "x", questions: [{ question_id: their_q }] }), "not_found");
    assert.equal(state_signature(env.db), before);

    // their owner against my set
    await rejects_api(submit_answers(env.service, other_env.ctx("y1"), { set_id: mine.set_id, answers: [{ question_id: my_q, value: "a" }] }), "not_found", "forbidden");
    assert.equal(state_signature(env.db), before);

    // reads are scoped too
    assert.throws(() => resume_ready(env.db, env.p.project_id, other_where.round_id), (e: unknown) => (e as { code?: string }).code === "not_found");
    assert.throws(() => resume_ready(env.db, other_p.project_id, where.round_id), (e: unknown) => (e as { code?: string }).code === "not_found");
    assert.equal(validate_submission(env.db, env.ctx("v"), { set_id: theirs.set_id, answers: [{ question_id: their_q, value: "a" }] }).errors[0]!.code, "not_found");

    // answering inside my project does not leak into theirs
    await submit(env, mine.set_id, [{ question_id: my_q, value: "a" }], "ok");
    assert.deepEqual(missing_ids(other_env, other_where.round_id), [their_q]);
    assert.deepEqual(missing_ids(env, where.round_id), []);
  });
});

test("hardening: a question of another set (other form, other stage level) cannot be answered through this set", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const main = await publish(env, where, [single_spec("합성 주 질문")], "pub-main");
    const extra = await publish(env, where, [single_spec("합성 추가 질문")], "pub-extra", { form_key: "extra", purpose: "review" });
    const stage_level = await publish(env, { stage_id: where.stage_id, round_id: null }, [single_spec("합성 단계 질문")], "pub-stage", { form_key: "s", purpose: "stage_start" });
    const mq = main.members[0]!.question_id;
    const eq = extra.members[0]!.question_id;
    const sq = stage_level.members[0]!.question_id;
    assert.equal(stage_level.round_id, null);

    const before = state_signature(env.db);
    await rejects_api(submit_answers(env.service, env.ctx("m1"), { set_id: main.set_id, answers: [{ question_id: eq, value: "a" }] }), "invalid_payload");
    await rejects_api(submit_answers(env.service, env.ctx("m2"), { set_id: extra.set_id, answers: [{ question_id: sq, value: "a" }] }), "invalid_payload");
    await rejects_api(submit_answers(env.service, env.ctx("m3"), { set_id: stage_level.set_id, answers: [{ question_id: mq, value: "a" }] }), "invalid_payload");
    assert.equal(state_signature(env.db), before);

    // the stage-level set never counts toward the round
    assert.deepEqual(missing_ids(env, where.round_id), [mq, eq].sort());
  });
});

// ---------------------------------------------------------------------------
// 7. resume_ready

test("hardening: resume_ready ignores optional, closed questions and replaced sets; one question in two forms is judged once", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const v1 = await publish(env, where, [single_spec("합성 A"), single_spec("합성 B"), text_spec("합성 선택")], "pub-1");
    const [a, b, opt] = v1.members.map((m) => m.question_id) as [string, string, string];
    assert.deepEqual(missing_ids(env, where.round_id), [a, b].sort());

    // v2 of the same form drops b: only the LATEST set of (stage, form) counts
    const v2 = await publish(env, where, [{ question_id: a }, { question_id: opt }], "pub-2");
    assert.equal(v2.set_version_no, 2);
    assert.deepEqual(missing_ids(env, where.round_id), [a]);

    // a second form that includes `a` again: still listed once
    await publish(env, where, [{ question_id: a }], "pub-x", { form_key: "x", purpose: "review" });
    const m = missing(env, where.round_id);
    assert.equal(m.length, 1);
    assert.equal(m[0]!.question_id, a);

    // answering through the older set (still valid: a did not change) satisfies the question everywhere
    await submit(env, v1.set_id, [{ question_id: a, value: "a" }], "sub-old");
    assert.deepEqual(missing(env, where.round_id), []);
    assert.equal(resume_ready(env.db, env.p.project_id, where.round_id).ready, true);

    // a closed question never blocks: close it by writing the state through the question's current version
    const cur = env.db.get<{ current_version_id: string }>("SELECT current_version_id FROM objects WHERE id = ?", b)!;
    env.db.run("UPDATE question_versions SET state = 'closed' WHERE version_id = ?", cur.current_version_id);
    const v3 = await publish(env, where, [{ question_id: a }, { question_id: b }], "pub-3", { form_key: "c", purpose: "review" }).catch((e: unknown) => e);
    // whether a closed question may be included in a new set is not specified; either way it must not block
    void v3;
    assert.equal(missing_ids(env, where.round_id).includes(b), false);
  });
});

test("hardening: resume_ready lists only the question's current version and judges a later answer by its pinned version", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [single_spec("합성 질문")], "pub-1");
    const q = set.members[0]!;
    await submit(env, set.set_id, [{ question_id: q.question_id, value: "a" }], "sub-1");
    const r1 = await revise(env, q.question_id, { text: "둘째" }, "rev-1");
    const r2 = await revise(env, q.question_id, { text: "셋째" }, "rev-2");

    assert.deepEqual(missing(env, where.round_id), [
      { question_id: q.question_id, question_version_id: r2.question_version_id, reason: "needs_reconfirmation" },
    ]);
    assert.notEqual(r1.question_version_id, r2.question_version_id);

    const set2 = await publish(env, where, [{ question_id: q.question_id }], "pub-2");
    await submit(env, set2.set_id, [{ question_id: q.question_id, value: "b" }], "sub-2");
    assert.deepEqual(missing(env, where.round_id), []);

    // revising once more after the reconfirmation asks again
    const r3 = await revise(env, q.question_id, { text: "넷째" }, "rev-3");
    assert.deepEqual(missing(env, where.round_id), [
      { question_id: q.question_id, question_version_id: r3.question_version_id, reason: "needs_reconfirmation" },
    ]);
  });
});

test("hardening: a comment-only item on a question that does not allow it never satisfies resume_ready, with or without a revision", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [single_spec("합성 질문")], "pub-1");
    const q = set.members[0]!;
    await submit(env, set.set_id, [{ question_id: q.question_id, other: "합성 의견만" }], "sub-1");
    assert.deepEqual(missing(env, where.round_id).map((m) => m.reason), ["unanswered"]);
    // allowing comment-as-answer later does not retroactively turn the old comment into an answer
    const rev = await revise(env, q.question_id, { allow_comment_as_answer: true }, "rev");
    assert.deepEqual(missing(env, where.round_id), [
      { question_id: q.question_id, question_version_id: rev.question_version_id, reason: "unanswered" },
    ]);
    assert.equal(answer_versions_of(env.db, q.question_id).length, 0);
  });
});

test("hardening: resume_ready rejects missing and malformed round ids with not_found and writes nothing", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    await publish(env, where, [single_spec("합성 질문")], "pub-1");
    const before = state_signature(env.db);
    for (const id of ["", "nope", where.stage_id, env.p.project_id, "' OR 1=1 --"]) {
      assert.throws(() => resume_ready(env.db, env.p.project_id, id), (e: unknown) => (e as { code?: string }).code === "not_found", `round id ${JSON.stringify(id)}`);
    }
    assert.equal(state_signature(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// 8. publish / revise edges

test("hardening: publish_set refuses bad specs without writing a question, set or member", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const before = state_signature(env.db);
    const base = { stage_id: where.stage_id, round_id: where.round_id, purpose: "stage_start", form_key: "main" };
    const bad: Record<string, unknown>[] = [
      { ...base, questions: [] },
      { ...base, questions: [single_spec("합성"), { question_id: "no-such-question" }] },
      { ...base, questions: [single_spec("합성"), { text: "합성", type: "bogus" }] },
      { ...base, questions: [single_spec("합성"), single_spec("합성", { options: [{ value: "", label: "x" }] })] },
      { ...base, questions: [single_spec("합성"), single_spec("합성", { options: [{ value: "a", label: "x", extra: 1 }] })] },
      { ...base, purpose: "bogus", questions: [single_spec("합성")] },
      { ...base, questions: [single_spec("합성")], surprise: true },
      { ...base, stage_id: "no-such-stage", questions: [single_spec("합성")] },
      { ...base, round_id: "no-such-round", questions: [single_spec("합성")] },
    ];
    for (const [i, input] of bad.entries()) {
      await rejects_api(publish_set(env.service, env.ctx(`bad-${i}`), input), "invalid_payload", "not_found");
      assert.equal(state_signature(env.db), before, `case ${i} wrote something`);
    }
  });
});

test("hardening: revise keeps every unchanged field, the old version row and the old set membership exactly", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [single_spec("합성 질문", { help: "합성 도움말", importance: "high", allow_comment_as_answer: true })], "pub-1");
    const q = set.members[0]!;
    const old_json = JSON.stringify(env.db.all("SELECT * FROM question_versions WHERE version_id = ?", q.question_version_id).map((r) => ({ ...r })), replacer);
    const old_member = JSON.stringify(env.db.all("SELECT * FROM question_set_members WHERE set_id = ?", set.set_id).map((r) => ({ ...r })), replacer);
    await submit(env, set.set_id, [{ question_id: q.question_id, value: "a" }], "sub-1");

    const rev = await revise(env, q.question_id, { text: "고친 글" }, "rev");
    const row = env.db.get<Record<string, unknown>>("SELECT * FROM question_versions WHERE version_id = ?", rev.question_version_id)!;
    assert.equal(row.text, "고친 글");
    assert.equal(row.help, "합성 도움말");
    assert.equal(row.importance, "high");
    assert.equal(row.allow_comment_as_answer, 1n);
    assert.equal(row.type, "single");
    assert.equal(row.default_value, JSON.stringify("b"));

    assert.equal(JSON.stringify(env.db.all("SELECT * FROM question_versions WHERE version_id = ?", q.question_version_id).map((r) => ({ ...r })), replacer), old_json);
    assert.equal(JSON.stringify(env.db.all("SELECT * FROM question_set_members WHERE set_id = ?", set.set_id).map((r) => ({ ...r })), replacer), old_member);
    assert.equal(question_current(env.db, q.question_id), rev.question_version_id);

    // a revise that changes nothing still appends a version (the contract says version_no + 1), and unknown fields are refused
    const same = await revise(env, q.question_id, {}, "rev-same").catch((e: unknown) => e);
    if (!(same instanceof Error)) assert.equal((same as ReviseResult).version_no, 3);
    await rejects_api(revise_question(env.service, env.ctx("rev-bad-1"), { question_id: q.question_id, text: "x", surprise: 1 }), "invalid_payload");
    await rejects_api(revise_question(env.service, env.ctx("rev-bad-2"), { question_id: q.question_id, type: "bogus" }), "invalid_payload");
    await rejects_api(revise_question(env.service, env.ctx("rev-bad-3"), { question_id: "no-such-question", text: "x" }), "not_found");
  });
});

test("hardening: a revision that removes an option makes the old option an invalid value on the new version only", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set1 = await publish(env, where, [single_spec("합성 질문")], "pub-1");
    const q = set1.members[0]!;
    await revise(env, q.question_id, { options: [{ value: "a", label: "A" }], default_value: null }, "rev");
    const set2 = await publish(env, where, [{ question_id: q.question_id }], "pub-2");

    const before = state_signature(env.db);
    await rejects_api(submit_answers(env.service, env.ctx("old-opt"), { set_id: set2.set_id, answers: [{ question_id: q.question_id, value: "c" }] }), "invalid_payload");
    await rejects_api(submit_answers(env.service, env.ctx("old-def"), { set_id: set2.set_id, answers: [{ question_id: q.question_id, value: "b", used_default: true }] }), "invalid_payload");
    assert.equal(state_signature(env.db), before);
    await submit(env, set2.set_id, [{ question_id: q.question_id, value: "a" }], "ok");
    assert.equal(answer_versions_of(env.db, q.question_id)[0]!.value, JSON.stringify("a"));
  });
});

test("hardening: value types are strict per question type", async () => {
  await with_env(async (env) => {
    const where = await open_round(env);
    const set = await publish(env, where, [
      { text: "합성 다중", type: "multi", required: true, allow_comment_as_answer: false, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
      { text: "합성 숫자", type: "number", required: true, allow_comment_as_answer: false },
      { text: "합성 척도", type: "scale", required: true, allow_comment_as_answer: false },
      text_spec("합성 글", { required: true }),
    ], "pub-1");
    const [multi, num, scale, txt] = set.members.map((m) => m.question_id) as [string, string, string, string];
    const before = state_signature(env.db);
    const bad: [string, unknown][] = [
      [multi, "a"], [multi, ["a", "z"]], [multi, [1]], [multi, { 0: "a" }], [multi, 3],
      [num, "3"], [num, true], [num, [3]], [scale, "x"], [scale, {}],
      [txt, 3], [txt, ["x"]], [txt, true], [txt, {}],
    ];
    for (const [i, [question_id, value]] of bad.entries()) {
      await rejects_api(submit_answers(env.service, env.ctx(`t-${i}`), { set_id: set.set_id, answers: [{ question_id, value }] }), "invalid_payload");
    }
    assert.equal(state_signature(env.db), before);
    // numbers that cannot be JSON are refused rather than stored as null
    for (const [i, value] of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY].entries()) {
      await rejects_api(submit_answers(env.service, env.ctx(`nf-${i}`), { set_id: set.set_id, answers: [{ question_id: num, value }] }), "invalid_payload");
    }
    assert.equal(state_signature(env.db), before);
    // edge values that ARE fine
    await submit(env, set.set_id, [{ question_id: multi, value: [] }, { question_id: num, value: 0 }, { question_id: scale, value: -1.5 }, { question_id: txt, value: "" }], "ok");
    assert.equal(answer_versions_of(env.db, num)[0]!.value, "0");
    assert.equal(answer_versions_of(env.db, txt)[0]!.value, '""');
  });
});

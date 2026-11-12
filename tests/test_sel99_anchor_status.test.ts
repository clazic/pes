/**
 * SEL-99 U4a — 앵커 상태 exact / moved / ambiguous / lost 계산과 다시 붙이기: 명령 annotation.reanchor (tester, 작성 모드).
 * 구현 전에는 명령이 없어 실패하는 것이 정상이다. 인터페이스 표는 test_sel99_annotation.test.ts 머리말.
 *
 * 정한 해석:
 *   annotation.reanchor {thread_id, version_id?}  = 재판정. 그 글 버전(기본: 글의 현재 버전)의 본문에서 **원래 앵커**(인용문·prefix/suffix·위치)를 다시 판정하고
 *     anchor_resolutions 에 **새 줄 하나**를 더한다(줄이 쌓인다. 옛 줄·anchors 줄은 안 바뀐다). 영수증 action 'annotation.reanchor', 사건 ≥ 1.
 *     결과 {thread_id, anchor_id, resolution_id, evaluated_version_id, status, start_cp, end_cp, candidates:[{start_cp,end_cp}]}.
 *   판정(후보 = 본문에서 인용문이 글자 그대로 나오는 모든 code point 위치, 문맥 일치 = 그 자리 앞이 prefix 로, 뒤가 suffix 로 정확히 이어짐(빈 값은 항상 일치)):
 *     - 원래 앵커가 만들어진 그 버전을 판정하면 exact(원래 위치).
 *     - 후보가 0 → lost (start_cp/end_cp = null, candidates = []).
 *     - 문맥이 일치하는 후보가 정확히 1 → 원래 위치면 exact, 아니면 moved (그 위치).
 *     - 문맥이 일치하는 후보가 없고 후보가 정확히 1 → moved (인용문이 본문에 하나뿐이므로).
 *     - 그 밖(문맥 일치 후보 ≥ 2, 또는 문맥 일치 0 이고 후보 ≥ 2) → ambiguous (start_cp/end_cp = null, candidates = 문맥 일치 후보들(없으면 모든 후보)). 서버는 하나를 고르지 않는다.
 *     (원래 위치에 같은 인용문이 그대로 있고 다른 후보가 없으면 exact — 글이 그 앞뒤만 바뀌어 문맥이 어긋나도 위치가 같으면 exact.)
 *   annotation.reanchor {thread_id, version_id?, start_cp, end_cp} = 다시 붙이기(**사람 소유자만**; 에이전트·무자격은 forbidden). 사람이 고른 구간을 확정한다:
 *     anchor_resolutions 에 새 줄(status = 고른 구간 본문이 원래 인용문이고 원래 위치면 exact, 아니면 moved; confirmed_by_actor_id = 사람)을 더한다.
 *     lost·ambiguous 였던 줄도 그대로 남는다. 구간은 그 버전 본문 안이어야 하고(start < end ≤ 본문 code point 수) 둘 다 줘야 한다. 어긋나면 거절하고 쓰지 않는다.
 *     원래 anchors 줄은 절대 안 바뀐다(필요하면 구현이 supersedes_anchor_id 계보로 새 anchors 줄을 더해도 된다 — 원래 줄만 같으면 된다).
 *   lost 는 삭제가 아니다: 인용문·스레드·메시지·anchors·옛 판정 줄이 모두 남고, 스레드 상태(open)도 안 바뀐다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { second_project } from "./helpers/blob_env.ts";
import { add_agent, events_of, receipt_of, rejects_api, with_env, type Env } from "./helpers/editions_env.ts";
import { state_signature } from "./helpers/state_signature.ts";
import {
  all_resolution_count,
  anchor_row,
  count_of,
  cp_find,
  cp_len,
  messages_of,
  resolutions_of,
  text_artifact,
  text_version,
  thread_row,
  thread_version_count,
  type Out,
} from "./helpers/sel99_env.ts";

const QUOTE = "정책 대안은 두 가지다.";
const PREFIX = "2장 합성 정책 분석에서 ";
const SUFFIX = " 첫 번째는 현행 유지다.";
const V1 = `머리글\n\n${PREFIX}${QUOTE}${SUFFIX}\n\n마무리 문단이다.`;

async function annotate(env: Env, key: string, payload: Record<string, unknown>): Promise<Out> {
  return (await env.service.execute(env.ctx(key), "annotation.create", payload)).result as Out;
}

async function reanchor(env: Env, key: string, payload: Record<string, unknown>): Promise<Out> {
  return (await env.service.execute(env.ctx(key), "annotation.reanchor", payload)).result as Out;
}

/** 글 v1 에 QUOTE 를 첨언해 둔 상태. */
async function with_thread(env: Env, body = V1, quote = QUOTE, prefix = PREFIX, suffix = SUFFIX, nth = 0) {
  const art = await text_artifact(env, "st", body);
  const note = await annotate(env, "st-an", { target_object_id: art.object_id, anchor: { exact_quote: quote, prefix, suffix, ...cp_find(body, quote, nth) }, body_md: "첨언" });
  return { art, note };
}

test("같은 버전 재판정은 exact(원래 위치), 글 뒤에 덧붙이기만 해도 exact", async () => {
  await with_env(async (env) => {
    const { art, note } = await with_thread(env);
    const same = await reanchor(env, "r-1", { thread_id: note.thread_id, version_id: art.version_id });
    assert.equal(same.status, "exact");
    assert.equal(same.start_cp, note.start_cp);
    assert.equal(same.end_cp, note.end_cp);
    assert.deepEqual(same.candidates, []);

    await text_version(env, "st-v2", art.object_id, `${V1}\n\n덧붙인 문단이다.`);
    const after = await reanchor(env, "r-2", { thread_id: note.thread_id });
    assert.equal(after.status, "exact");
    assert.equal(after.start_cp, note.start_cp);
    assert.equal(after.evaluated_version_id, env.db.get<{ v: string }>("SELECT current_version_id AS v FROM objects WHERE id = ?", art.object_id)!.v, "기본은 글의 현재 버전");
  });
});

test("moved: 앞에 글(한글·이모지)이 끼면 위치가 code point 수만큼 밀리고, 원래 앵커 줄은 그대로, 판정 줄이 하나 더 생긴다", async () => {
  await with_env(async (env) => {
    const { art, note } = await with_thread(env);
    const insert = "새로 끼운 문단입니다 😀😀 한글 이모지.\n\n";
    const v2 = await text_version(env, "mv-v2", art.object_id, insert + V1);
    const frozen = anchor_row(env.db, note.anchor_id);
    const before = resolutions_of(env.db, note.anchor_id);
    assert.equal(before.length, 1);

    const out = await reanchor(env, "mv-r", { thread_id: note.thread_id });
    assert.equal(out.status, "moved");
    assert.equal(out.start_cp, note.start_cp + cp_len(insert), "이모지 한 개는 1 code point 로 센다");
    assert.equal(out.end_cp, note.end_cp + cp_len(insert));
    assert.equal(out.start_cp, cp_find(insert + V1, QUOTE).start_cp);
    assert.equal(out.evaluated_version_id, v2.version_id);

    assert.equal(anchor_row(env.db, note.anchor_id), frozen, "원래 앵커는 바뀌지 않는다");
    const rows = resolutions_of(env.db, note.anchor_id);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], before[0], "옛 판정 줄도 그대로");
    assert.equal(rows[1]!.status, "moved");
    assert.equal(rows[1]!.evaluated_version_id, v2.version_id);
    assert.equal(rows[1]!.start_cp, out.start_cp);
    assert.equal(rows[1]!.id, out.resolution_id);
    assert.equal(rows[1]!.confirmed_by_actor_id, null, "자동 판정은 사람 확정이 아니다");

    const receipt = receipt_of(env.db, env.p.project_id, "mv-r")!;
    assert.equal(receipt.action, "annotation.reanchor");
    assert.ok(events_of(env.db, receipt.id).length >= 1);
    assert.equal(thread_row(env.db, note.thread_id).target_version_id, art.version_id, "스레드가 가리키는 버전은 그대로(현재 위치는 판정 줄에서 읽는다)");
  });
});

test("반복 인용: 두 번째 것에 단 첨언은 글이 밀려도 두 번째 것을 따라간다(prefix/suffix 문맥)", async () => {
  await with_env(async (env) => {
    const REPEAT = "결론은 A다.";
    const body = `첫 단락. ${REPEAT} 둘째 단락.\n\n셋째 단락. ${REPEAT} 넷째 단락.`;
    const { art, note } = await with_thread(env, body, REPEAT, "셋째 단락. ", " 넷째 단락.", 1);
    const second_before = cp_find(body, REPEAT, 1);
    assert.equal(note.start_cp, second_before.start_cp);
    const shifted = `새 머리말 😀\n\n${body}`;
    await text_version(env, "rep-v2", art.object_id, shifted);
    const out = await reanchor(env, "rep-r", { thread_id: note.thread_id });
    assert.equal(out.status, "moved");
    assert.equal(out.start_cp, cp_find(shifted, REPEAT, 1).start_cp, "첫 번째가 아니라 두 번째를 따라간다");
  });
});

test("ambiguous: 문맥으로 못 가르는 후보가 둘이면 start/end 없이 후보만 돌려주고 하나를 고르지 않는다", async () => {
  await with_env(async (env) => {
    const REPEAT = "핵심 결론은 A다.";
    const body = `서문 X. ${REPEAT} 끝.`;
    const { art, note } = await with_thread(env, body, REPEAT, "서문 X. ", " 끝.");
    // 다시 쓴 글: 같은 인용문이 두 번 나오지만 어느 쪽도 원래 앞뒤(서문 X. / 끝.)에 놓여 있지 않다
    const v2_body = `요약: ${REPEAT} 그리고 본문에서 다시 ${REPEAT} 이상.`;
    await text_version(env, "amb-v2", art.object_id, v2_body);
    const frozen = anchor_row(env.db, note.anchor_id);
    const sig_threads = { threads: count_of(env.db, "threads"), msgs: count_of(env.db, "messages") };

    const out = await reanchor(env, "amb-r", { thread_id: note.thread_id });
    assert.equal(out.status, "ambiguous");
    assert.equal(out.start_cp, null, "후보를 대신 고르지 않는다");
    assert.equal(out.end_cp, null);
    assert.deepEqual(out.candidates, [cp_find(v2_body, REPEAT, 0), cp_find(v2_body, REPEAT, 1)]);

    const rows = resolutions_of(env.db, note.anchor_id);
    assert.equal(rows.at(-1)!.status, "ambiguous");
    assert.equal(rows.at(-1)!.start_cp, null);
    assert.equal(rows.at(-1)!.end_cp, null);
    assert.equal(rows.at(-1)!.confirmed_by_actor_id, null);
    assert.equal(anchor_row(env.db, note.anchor_id), frozen);
    assert.equal(thread_row(env.db, note.thread_id).state, "open", "ambiguous 는 스레드를 닫거나 지우지 않는다");
    assert.deepEqual({ threads: count_of(env.db, "threads"), msgs: count_of(env.db, "messages") }, sig_threads);
  });
});

test("lost: 인용문이 사라지면 lost 로 보이되 스레드·메시지·인용문·옛 판정은 지워지지 않고, 본문이 돌아오면 다시 붙는다", async () => {
  await with_env(async (env) => {
    const { art, note } = await with_thread(env);
    const frozen = anchor_row(env.db, note.anchor_id);
    const v2 = await text_version(env, "lost-v2", art.object_id, "완전히 다시 쓴 글이다. 앞의 문장은 어디에도 없다.");
    const counts = { threads: count_of(env.db, "threads"), anchors: count_of(env.db, "anchors"), msgs: count_of(env.db, "messages"), tv: thread_version_count(env.db, note.thread_id) };

    const lost = await reanchor(env, "lost-r", { thread_id: note.thread_id });
    assert.equal(lost.status, "lost");
    assert.equal(lost.start_cp, null);
    assert.equal(lost.end_cp, null);
    assert.deepEqual(lost.candidates, []);
    assert.equal(lost.evaluated_version_id, v2.version_id);

    assert.equal(anchor_row(env.db, note.anchor_id), frozen, "인용문·prefix/suffix 가 그대로 남는다");
    assert.equal(count_of(env.db, "threads"), counts.threads);
    assert.equal(count_of(env.db, "anchors"), counts.anchors);
    assert.equal(count_of(env.db, "messages"), counts.msgs);
    assert.equal(thread_version_count(env.db, note.thread_id), counts.tv, "lost 는 스레드 상태 변화가 아니다");
    assert.equal(thread_row(env.db, note.thread_id).state, "open");
    assert.equal(messages_of(env.db, note.thread_id)[0]!.body_md, "첨언");
    const rows = resolutions_of(env.db, note.anchor_id);
    assert.deepEqual(rows.map((r) => r.status), ["exact", "lost"], "exact 줄이 지워지지 않고 lost 줄이 쌓인다");

    // 본문이 되살아나면(새 버전) 같은 앵커가 다시 붙는다 — lost 는 끝이 아니다
    await text_version(env, "lost-v3", art.object_id, `돌아온 본문. ${PREFIX}${QUOTE}${SUFFIX}`);
    const back = await reanchor(env, "lost-r3", { thread_id: note.thread_id });
    assert.equal(back.status, "moved");
    assert.deepEqual(resolutions_of(env.db, note.anchor_id).map((r) => r.status), ["exact", "lost", "moved"]);
  });
});

test("판정은 쌓이기만 한다: 같은 버전을 다시 판정해도 새 줄이 더해지고 옛 줄은 안 바뀐다. 같은 키는 재생", async () => {
  await with_env(async (env) => {
    const { art, note } = await with_thread(env);
    await text_version(env, "acc-v2", art.object_id, `앞말.\n${V1}`);
    const a = await reanchor(env, "acc-1", { thread_id: note.thread_id });
    const b = await reanchor(env, "acc-2", { thread_id: note.thread_id });
    assert.notEqual(a.resolution_id, b.resolution_id);
    const rows = resolutions_of(env.db, note.anchor_id);
    assert.equal(rows.length, 3);
    assert.equal(rows[1]!.id, a.resolution_id);
    assert.equal(rows[2]!.id, b.resolution_id);
    const sig = state_signature(env.db);
    const replay = await env.service.execute(env.ctx("acc-2"), "annotation.reanchor", { thread_id: note.thread_id });
    assert.equal(replay.replayed, true);
    assert.equal(state_signature(env.db), sig);
    await rejects_api(env.service.execute(env.ctx("acc-2"), "annotation.reanchor", { thread_id: note.thread_id, version_id: art.version_id }), "idempotency_key_reuse");
  });
});

test("다시 붙이기(사람): lost 인 첨언을 새 구간에 붙이면 새 anchor_resolutions 줄(사람 확정)이 생기고 원래 앵커·옛 lost 줄은 그대로다", async () => {
  await with_env(async (env) => {
    const { art, note } = await with_thread(env);
    const new_body = "다시 쓴 글이다. 정책 선택지는 두 가지로 줄었다. 나머지는 부록으로 옮겼다.";
    const v2 = await text_version(env, "re-v2", art.object_id, new_body);
    await reanchor(env, "re-eval", { thread_id: note.thread_id });
    const frozen = anchor_row(env.db, note.anchor_id);
    const before = resolutions_of(env.db, note.anchor_id);
    assert.equal(before.at(-1)!.status, "lost");

    const pick = cp_find(new_body, "정책 선택지는 두 가지로 줄었다.");
    const out = await reanchor(env, "re-pick", { thread_id: note.thread_id, version_id: v2.version_id, ...pick });
    assert.equal(out.status, "moved");
    assert.equal(out.start_cp, pick.start_cp);
    assert.equal(out.end_cp, pick.end_cp);

    const rows = resolutions_of(env.db, note.anchor_id);
    assert.equal(rows.length, before.length + 1, "새 anchor_resolutions 행 하나");
    assert.deepEqual(rows.slice(0, before.length), before, "옛 줄은 그대로");
    const last = rows.at(-1)!;
    assert.equal(last.status, "moved");
    assert.equal(last.start_cp, pick.start_cp);
    assert.equal(last.end_cp, pick.end_cp);
    assert.equal(last.evaluated_version_id, v2.version_id);
    assert.equal(last.confirmed_by_actor_id, env.p.actor_id, "사람이 확정했다");
    assert.equal(anchor_row(env.db, note.anchor_id), frozen);
    assert.equal(thread_row(env.db, note.thread_id).state, "open");
  });
});

test("다시 붙이기(사람): ambiguous 후보 중 사람이 하나를 고르면 그 위치로 확정된다(후보가 아닌 곳을 고를 수도 있으나 본문 안이어야 한다)", async () => {
  await with_env(async (env) => {
    const REPEAT = "핵심 결론은 A다.";
    const { art, note } = await with_thread(env, `서문 X. ${REPEAT} 끝.`, REPEAT, "서문 X. ", " 끝.");
    const v2_body = `요약: ${REPEAT} 그리고 본문에서 다시 ${REPEAT} 이상.`;
    const v2 = await text_version(env, "pk-v2", art.object_id, v2_body);
    const amb = await reanchor(env, "pk-eval", { thread_id: note.thread_id });
    assert.equal(amb.status, "ambiguous");
    const second = amb.candidates[1];
    const out = await reanchor(env, "pk-pick", { thread_id: note.thread_id, version_id: v2.version_id, start_cp: second.start_cp, end_cp: second.end_cp });
    assert.equal(out.status, "moved");
    assert.equal(out.start_cp, second.start_cp);
    const rows = resolutions_of(env.db, note.anchor_id);
    assert.deepEqual(rows.map((r) => r.status), ["exact", "ambiguous", "moved"]);
    assert.equal(rows.at(-1)!.confirmed_by_actor_id, env.p.actor_id);
  });
});

test("다시 붙이기 거절: 한쪽만·역순·본문 밖·빈 구간·모르는 스레드/버전·다른 글의 버전 — 아무것도 쓰지 않는다", async () => {
  await with_env(async (env) => {
    const { art, note } = await with_thread(env);
    const other = await text_artifact(env, "other", "다른 글의 본문이다.");
    const v2 = await text_version(env, "bad-v2", art.object_id, "짧은 새 글이다.");
    const sig = state_signature(env.db);
    const n = cp_len("짧은 새 글이다.");
    const bad: Array<[string, Record<string, unknown>, string[]]> = [
      ["start 만", { thread_id: note.thread_id, version_id: v2.version_id, start_cp: 1 }, ["invalid_payload"]],
      ["end 만", { thread_id: note.thread_id, version_id: v2.version_id, end_cp: 3 }, ["invalid_payload"]],
      ["역순", { thread_id: note.thread_id, version_id: v2.version_id, start_cp: 5, end_cp: 2 }, ["invalid_payload", "validation_failed"]],
      ["빈 구간", { thread_id: note.thread_id, version_id: v2.version_id, start_cp: 3, end_cp: 3 }, ["invalid_payload", "validation_failed"]],
      ["본문 밖", { thread_id: note.thread_id, version_id: v2.version_id, start_cp: 0, end_cp: n + 1 }, ["invalid_payload", "validation_failed"]],
      ["음수", { thread_id: note.thread_id, version_id: v2.version_id, start_cp: -1, end_cp: 3 }, ["invalid_payload", "validation_failed"]],
      ["모르는 스레드", { thread_id: "no-such-thread" }, ["not_found"]],
      ["모르는 버전", { thread_id: note.thread_id, version_id: "no-such-version" }, ["not_found"]],
      ["다른 글의 버전", { thread_id: note.thread_id, version_id: other.version_id }, ["not_found", "conflict", "invalid_payload"]],
      ["모르는 필드", { thread_id: note.thread_id, surprise: 1 }, ["invalid_payload"]],
    ];
    for (const [i, [name, payload, codes]] of bad.entries()) {
      await rejects_api(env.service.execute(env.ctx(`bad-${i}`), "annotation.reanchor", payload), ...codes).catch((e) => {
        throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    assert.equal(state_signature(env.db), sig);
  });
});

test("다시 붙이기는 사람만: 에이전트(리스 없음)·다른 프로젝트는 거절하고 쓰지 않는다", async () => {
  await with_env(async (env) => {
    const { art, note } = await with_thread(env);
    const v2 = await text_version(env, "h-v2", art.object_id, "다시 쓴 글이다.");
    const agent = add_agent(env, "agent-sel99-r");
    const foreign = await second_project(env, "synthetic-sel99-r");
    const sig = state_signature(env.db);
    await rejects_api(env.service.execute({ ...agent, client_request_id: "a-1" }, "annotation.reanchor", { thread_id: note.thread_id, version_id: v2.version_id, start_cp: 0, end_cp: 3 }), "forbidden");
    await rejects_api(env.service.execute({ ...agent, client_request_id: "a-2" }, "annotation.reanchor", { thread_id: note.thread_id }), "forbidden");
    await rejects_api(
      env.service.execute({ project_id: foreign.project_id, actor_id: foreign.actor_id, via: "cli", client_request_id: "fx" }, "annotation.reanchor", { thread_id: note.thread_id }),
      "not_found",
    );
    assert.equal(state_signature(env.db), sig);
    assert.equal(all_resolution_count(env.db), 1);
  });
});

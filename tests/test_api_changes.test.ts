/**
 * SEL-47 PR14 — HTTP API: GET P/changes, the change feed and its cursor (tester, 작성 모드).
 * Shapes follow docs/plan/fixtures/api-v1/changes.json.
 *
 *   GET P/changes?cursor=<opaque>&limit=<1..100>      owner session, or an agent token with context:read
 *   -> 200 data {
 *        events:      [{ event_seq (decimal STRING), type, object_id|null, before_version_id|null,
 *                        after_version_id|null, at (ms, integer) }]   (exactly these keys),
 *        next_cursor: opaque string (always present; pass it back unchanged),
 *        has_more:    boolean,
 *        epoch:       decimal string (db_meta.cursor_epoch)
 *      }
 *   No cursor = from the beginning of what the caller may see. limit default 100, max 100.
 *
 *   Rules the tests pin:
 *   - events ascend by event_seq with no gap and no duplicate across pages;
 *   - a page never splits one transaction (the tx of an event is read from the events table in the test) —
 *     a page may hold more than `limit` events when its last transaction is bigger;
 *   - the DTO is public: no `payload`, no secrets; an agent never sees token.* events, and the scan cursor
 *     still moves past events it may not see (no stuck cursor);
 *   - the cursor is server-made and bound to project, caller kind/scope, and database; a changed, foreign or
 *     other-scope cursor is 400 `cursor_invalid` (target "$.query.cursor", next_action "reread_context");
 *   - when the epoch or the database instance changed the old cursor is 410 `cursor_expired` (the document
 *     contract): retryable false, target "$.query.cursor", next_action "resync", details {
 *       database_instance_id, cursor_epoch (the cursor's, decimal string), current_epoch (decimal string),
 *       reason: "epoch_changed" | "database_changed", next_cursor (a fresh cursor valid now),
 *       snapshot: {control_rev, digest, stages[{stage_id,key,status,rev}]} (no object bodies),
 *       keep_unsubmitted_answers: true }.
 *     The 410 writes nothing, and unsubmitted answers are never the server's to lose: it has no draft
 *     (PUT P/answer-drafts is an unknown route, 404) and the 410 tells the client to keep them; a submission
 *     against the same question versions still goes through afterwards.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DECIMAL,
  agent_claims,
  assert_ok,
  call,
  go_off,
  make_agent,
  with_api,
  type ApiEnv,
} from "./helpers/api_env.ts";
import { P, assert_final_error, NEXT_ACTION } from "./helpers/api_flow.ts";
import { open_round, single_spec } from "./helpers/questions_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const CHANGES = (env: ApiEnv, query = "") => P(env, `/changes${query}`);

async function publish(env: ApiEnv, key = "chg"): Promise<{ set_id: string; question_id: string; question_version_id: string }> {
  const { stage_id, round_id } = await open_round(env, key);
  const res = await call(env, {
    method: "POST",
    path: P(env, "/questions"),
    auth: "owner",
    body: { stage_id, round_id, purpose: "stage_start", form_key: "main", question: single_spec("합성 질문") },
  });
  const data = assert_ok(res, 201);
  return { set_id: data.question_set_id, question_id: data.question.id, question_version_id: data.question.version_id };
}

const submit_body = (q: { set_id: string; question_id: string; question_version_id: string }) => ({
  set_id: q.set_id,
  answers: [{ question_id: q.question_id, question_version_id: q.question_version_id, value: "a" }],
});

async function read_all(env: ApiEnv, auth: "owner" | { token: string }, limit: number) {
  const pages: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 500; i += 1) {
    const q = `?limit=${limit}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
    const data = assert_ok(await call(env, { method: "GET", path: CHANGES(env, q), auth }));
    pages.push(data);
    cursor = data.next_cursor;
    if (!data.has_more) return pages;
  }
  assert.fail("the feed never ended: the cursor is stuck");
}

test("the first read: public event DTOs in ascending order, decimal-string numbers, a cursor, and the epoch", async () => {
  await with_api(async (env) => {
    await publish(env);
    const res = await call(env, { method: "GET", path: CHANGES(env), auth: "owner" });
    const data = assert_ok(res);
    assert.match(data.epoch, DECIMAL);
    assert.equal(typeof data.next_cursor, "string");
    assert.ok(data.next_cursor.length > 0);
    assert.equal(typeof data.has_more, "boolean");
    assert.ok(data.events.length >= 2);
    const allowed = new Set(["event_seq", "type", "object_id", "before_version_id", "after_version_id", "at"]);
    let last = -1n;
    for (const event of data.events) {
      assert.deepEqual(Object.keys(event).filter((k) => !allowed.has(k)), [], "only public DTO keys");
      assert.match(event.event_seq, DECIMAL);
      assert.ok(BigInt(event.event_seq) > last, "ascending");
      last = BigInt(event.event_seq);
      assert.equal(typeof event.type, "string");
      assert.ok(Number.isSafeInteger(event.at));
      for (const key of ["object_id", "before_version_id", "after_version_id"]) assert.ok(event[key] === null || typeof event[key] === "string", key);
    }
    assert.ok(data.events.some((e: any) => e.type === "question.set_published"));
    assert.doesNotMatch(JSON.stringify(res.json), /payload|token_hash|pes_[A-Za-z0-9_-]{16,}/);
  });
});

test("paging with limit: no gap, no duplicate, and a page never splits one transaction", async () => {
  await with_api(async (env) => {
    await publish(env);
    const by_tx = env.db.all<{ tx_id: string; n: bigint }>("SELECT tx_id, count(*) AS n FROM events WHERE project_id = ? GROUP BY tx_id", env.p.project_id);
    assert.ok(by_tx.some((t) => t.n >= 2n), "the setup has a multi-event transaction");
    const whole = (await read_all(env, "owner", 100)).flatMap((p) => p.events);
    for (const limit of [1, 2, 3, 7]) {
      const pages = await read_all(env, "owner", limit);
      const flat = pages.flatMap((p) => p.events);
      assert.deepEqual(flat.map((e: any) => e.event_seq), whole.map((e: any) => e.event_seq), `limit ${limit}: the same feed`);
      const seen_tx = new Map<string, number>();
      const tx_of = (e: any) => env.db.get<{ tx_id: string }>("SELECT tx_id FROM events WHERE event_seq = ?", Number(e.event_seq))!.tx_id;
      pages.forEach((page, i) => {
        for (const tx of new Set(page.events.map(tx_of))) {
          assert.ok(!seen_tx.has(tx as string) || seen_tx.get(tx as string) === i, `limit ${limit}: tx ${tx} is on one page only`);
          seen_tx.set(tx as string, i);
        }
        if (page.has_more) assert.ok(page.events.length >= 1, "a page that has more makes progress");
      });
    }
  });
});

test("reading from the returned cursor yields only what is new; an idle read is empty with a usable cursor", async () => {
  await with_api(async (env) => {
    const set = await publish(env);
    const first = assert_ok(await call(env, { method: "GET", path: CHANGES(env), auth: "owner" }));
    const idle = assert_ok(await call(env, { method: "GET", path: CHANGES(env, `?cursor=${encodeURIComponent(first.next_cursor)}`), auth: "owner" }));
    assert.deepEqual(idle.events, []);
    assert.equal(idle.has_more, false);

    assert_ok(
      await call(env, {
        method: "POST",
        path: P(env, "/submissions"),
        auth: "owner",
        body: submit_body(set),
      }),
      201,
    );
    const fresh = assert_ok(await call(env, { method: "GET", path: CHANGES(env, `?cursor=${encodeURIComponent(idle.next_cursor)}`), auth: "owner" }));
    assert.ok(fresh.events.length >= 1);
    assert.ok(fresh.events.every((e: any) => BigInt(e.event_seq) > BigInt(first.events.at(-1).event_seq)));
    assert.ok(fresh.events.some((e: any) => e.type === "answer.submitted"));
    const same = assert_ok(await call(env, { method: "GET", path: CHANGES(env, `?cursor=${encodeURIComponent(idle.next_cursor)}`), auth: "owner" }));
    assert.deepEqual(same.events, fresh.events, "the same cursor reads the same slice");
  });
});

test("an agent's feed hides token events but the scan cursor still advances to the end", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "watcher", ["context:read"]);
    await publish(env);
    const owner_events = (await read_all(env, "owner", 100)).flatMap((p) => p.events);
    assert.ok(owner_events.some((e: any) => e.type.startsWith("token.")), "the owner sees the token events");
    for (const limit of [1, 5, 100]) {
      const pages = await read_all(env, { token: agent.token }, limit);
      const events = pages.flatMap((p) => p.events);
      assert.ok(events.every((e: any) => !e.type.startsWith("token.")), "the agent never sees token events");
      assert.ok(events.length < owner_events.length);
      assert.ok(events.some((e: any) => e.type === "question.set_published"));
    }
    // After the last hidden event the cursor sits at the tail: a read from it is empty, not stuck.
    const tail = (await read_all(env, { token: agent.token }, 100)).at(-1);
    const idle = assert_ok(await call(env, { method: "GET", path: CHANGES(env, `?cursor=${encodeURIComponent(tail.next_cursor)}`), auth: { token: agent.token } }));
    assert.deepEqual(idle.events, []);
  });
});

test("credentials: none 401, wrong session 401, a token without context:read 403, an internal_ai token with Go OFF is policy_blocked", async () => {
  await with_api(async (env) => {
    const noscope = await make_agent(env, "noscope", ["run:claim"]);
    const external = await make_agent(env, "ext", ["context:read"]);
    const internal = await make_agent(env, "int", ["context:read"], "internal_ai");
    assert_final_error(await call(env, { method: "GET", path: CHANGES(env) }), 401, "unauthenticated");
    assert_final_error(await call(env, { method: "GET", path: CHANGES(env), headers: { "x-pes-session": "wrong" } }), 401, "unauthenticated");
    assert_final_error(await call(env, { method: "GET", path: CHANGES(env), auth: { token: noscope.token } }), 403, "forbidden");
    assert_ok(await call(env, { method: "GET", path: CHANGES(env), auth: { token: internal.token } }));
    await go_off(env);
    assert_final_error(await call(env, { method: "GET", path: CHANGES(env), auth: { token: internal.token } }), 403, "policy_blocked", {
      next_action: NEXT_ACTION.policy_blocked,
    });
    assert_ok(await call(env, { method: "GET", path: CHANGES(env), auth: { token: external.token } }));
    assert_ok(await call(env, { method: "GET", path: CHANGES(env), auth: "owner" }));
  });
});

test("limit and cursor shape: bad values are 400 with the query path; tampered, foreign-project, and other-caller cursors are cursor_invalid", async () => {
  await with_api(async (env) => {
    await publish(env);
    const agent = await make_agent(env, "reader", ["context:read"]);
    const first = assert_ok(await call(env, { method: "GET", path: CHANGES(env, "?limit=1"), auth: { token: agent.token } }));
    for (const bad of ["0", "101", "-1", "abc", "1.5", ""]) {
      assert_final_error(await call(env, { method: "GET", path: CHANGES(env, `?limit=${bad}`), auth: "owner" }), 400, "invalid_payload", {
        target: "$.query.limit",
        next_action: NEXT_ACTION.invalid_payload,
      });
    }
    const cursor = first.next_cursor as string;
    const tampered = cursor.slice(0, -2) + (cursor.endsWith("AA") ? "BB" : "AA");
    for (const bad of [tampered, "not-a-cursor", "0", "9999999999999999999999"]) {
      const error = assert_final_error(
        await call(env, { method: "GET", path: CHANGES(env, `?cursor=${encodeURIComponent(bad)}`), auth: { token: agent.token } }),
        400,
        "cursor_invalid",
        { target: "$.query.cursor", next_action: NEXT_ACTION.cursor_invalid },
      );
      assert.equal(error.retryable, false);
    }
    // The cursor of the agent's feed is bound to its scope: the owner session cannot reuse it.
    assert_final_error(
      await call(env, { method: "GET", path: CHANGES(env, `?cursor=${encodeURIComponent(cursor)}`), auth: "owner" }),
      400,
      "cursor_invalid",
      { target: "$.query.cursor" },
    );
    // Bound to the project: a cursor made for another project is refused here.
    const other = await call(env, { method: "POST", path: "/api/v1/projects", auth: "owner", body: { slug: "chg-other", topic: "합성", owner_display_name: "합성 소유자 둘" } });
    const other_id = assert_ok(other, 201).project_id as string;
    const other_cursor = assert_ok(await call(env, { method: "GET", path: `/api/v1/projects/${other_id}/changes?limit=1`, auth: "owner" })).next_cursor as string;
    assert_final_error(
      await call(env, { method: "GET", path: CHANGES(env, `?cursor=${encodeURIComponent(other_cursor)}`), auth: "owner" }),
      400,
      "cursor_invalid",
    );
  });
});

const EPOCH_ERROR = { target: "$.query.cursor", next_action: NEXT_ACTION.cursor_expired, retryable: false } as const;

test("a changed epoch is 410 cursor_expired with the resync details, no writes, and a fresh cursor that works", async () => {
  await with_api(async (env) => {
    const set = await publish(env);
    const first = assert_ok(await call(env, { method: "GET", path: CHANGES(env), auth: "owner" }));
    const old_epoch = first.epoch as string;
    const instance = env.db.get<{ database_instance_id: string }>("SELECT database_instance_id FROM db_meta WHERE id = 1")!.database_instance_id;
    env.db.run("UPDATE db_meta SET cursor_epoch = cursor_epoch + 1 WHERE id = 1");
    const epoch = env.db.get<{ cursor_epoch: bigint }>("SELECT cursor_epoch FROM db_meta WHERE id = 1")!.cursor_epoch;
    const sig = state_signature(env.db);

    const res = await call(env, { method: "GET", path: CHANGES(env, `?cursor=${encodeURIComponent(first.next_cursor)}`), auth: "owner" });
    const error = assert_final_error(res, 410, "cursor_expired", EPOCH_ERROR);
    const d = error.details;
    assert.equal(d.database_instance_id, instance);
    assert.equal(d.cursor_epoch, old_epoch);
    assert.equal(d.current_epoch, epoch.toString());
    assert.equal(d.reason, "epoch_changed");
    assert.equal(d.keep_unsubmitted_answers, true, "the client is told not to discard unsubmitted answers");
    assert.equal(typeof d.next_cursor, "string");
    assert.notEqual(d.next_cursor, first.next_cursor);
    assert.match(d.snapshot.control_rev, DECIMAL);
    assert.match(d.snapshot.digest, /^[0-9a-f]{64}$/);
    assert.equal(d.snapshot.stages.length, 6);
    assert.doesNotMatch(JSON.stringify(res.json), /body_md|"text"|합성 질문/, "a snapshot, not the full bodies");
    assert.equal(state_signature(env.db), sig, "an expired cursor writes nothing — no receipt, no event, no answer touched");

    // The server holds no draft; the browser's unsubmitted answer is still submittable against the same version.
    assert_final_error(await call(env, { method: "PUT", path: P(env, "/answer-drafts"), auth: "owner", body: { answers: [] } }), 404, "not_found");
    assert_ok(await call(env, { method: "POST", path: P(env, "/submissions"), auth: "owner", body: submit_body(set) }), 201);

    // The fresh cursor from the details continues after the snapshot: the submission, no second 410.
    const next = assert_ok(await call(env, { method: "GET", path: CHANGES(env, `?cursor=${encodeURIComponent(d.next_cursor)}`), auth: "owner" }));
    assert.ok(next.events.some((e: any) => e.type === "answer.submitted"));
    assert.equal(next.epoch, epoch.toString());
    // So does a read without a cursor.
    assert_ok(await call(env, { method: "GET", path: CHANGES(env), auth: "owner" }));
  });
});

test("a different database instance also expires the cursor, with its own reason", async () => {
  await with_api(async (env) => {
    await publish(env);
    const first = assert_ok(await call(env, { method: "GET", path: CHANGES(env), auth: "owner" }));
    env.db.run("UPDATE db_meta SET database_instance_id = 'synthetic-restored-db' WHERE id = 1");
    const error = assert_final_error(
      await call(env, { method: "GET", path: CHANGES(env, `?cursor=${encodeURIComponent(first.next_cursor)}`), auth: "owner" }),
      410,
      "cursor_expired",
      EPOCH_ERROR,
    );
    assert.equal(error.details.reason, "database_changed");
    assert.equal(error.details.database_instance_id, "synthetic-restored-db");
  });
});

test("an agent gets the same 410 after an epoch change; its lease and run are untouched", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "resyncer", ["context:read", "run:claim", "run:submit"]);
    const lease = await agent_claims(env, agent);
    const first = assert_ok(await call(env, { method: "GET", path: CHANGES(env), auth: { token: agent.token } }));
    env.db.run("UPDATE db_meta SET cursor_epoch = cursor_epoch + 1 WHERE id = 1");
    assert_final_error(
      await call(env, { method: "GET", path: CHANGES(env, `?cursor=${encodeURIComponent(first.next_cursor)}`), auth: { token: agent.token } }),
      410,
      "cursor_expired",
      EPOCH_ERROR,
    );
    const run = env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", lease.run_id);
    assert.equal(run?.status, "running");
  });
});

test("there is no server-side answer draft: PUT/POST P/answer-drafts is an unknown route", async () => {
  await with_api(async (env) => {
    for (const method of ["PUT", "POST", "GET"]) {
      const res = await call(env, { method, path: P(env, "/answer-drafts"), auth: "owner", body: method === "GET" ? undefined : { answers: [] } });
      assert_final_error(res, 404, "not_found");
    }
  });
});

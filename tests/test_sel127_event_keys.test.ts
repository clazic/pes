/**
 * SEL-127 리뷰 R1-2 — 닫힌 자료의 id 를 payload 의 다른 키로 싣는 사건도 비사람 GET changes 에서 숨는다.
 * event_denied 는 blob_id·file_policy_id·object_id·version_id 만 보던 시절이 있었다. 여기서는 실제 사건 type 이 쓰는 키
 * (annotation.created · content.citation_added · content.relation_linked · followup.proposed) 를 DB 에 직접 넣고,
 * 같은 키에 열린 자료 id 를 실은 사건은 나가는지 본다. 합성 값만 쓴다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { assert_ok, call, make_agent, with_api, type ApiEnv } from "./helpers/api_env.ts";
import { P, http_blob, set_access, text_bytes, upload_material } from "./helpers/sel115_env.ts";

async function material(env: ApiEnv, label: string) {
  const blob = await http_blob(env, text_bytes(label, `SECRET-${label}`), { name: `합성-${label}.txt` });
  const res = await upload_material(env, { blob_id: blob.blob_id });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.data as { object_id: string; version_id: string; blob_id: string; file_policy_id: string };
}

/** One stored event whose payload carries these ids under keys other than the four the first check reads. The columns stay NULL, as write_events leaves them. */
let tx_no = 0;
function add_event(env: ApiEnv, type: string, payload: Record<string, unknown>): string {
  tx_no += 1;
  const tx_id = `tx-sel127-keys-${tx_no}`;
  env.db.run(
    `INSERT INTO mutation_commits
       (id, project_id, actor_id, via, client_request_id, request_hash, action, base_control_rev, run_id, result_json, created_at)
     VALUES (?, ?, ?, 'import', ?, ?, ?, 0, NULL, '{}', 1)`,
    tx_id,
    env.p.project_id,
    env.p.actor_id,
    `sel127-keys-${tx_no}`,
    "b".repeat(64),
    type,
  );
  env.db.run(
    `INSERT INTO events (id, project_id, run_id, tx_id, tx_index, tx_size, type, payload, created_at)
     VALUES (?, ?, NULL, ?, 0, 1, ?, ?, 1)`,
    `ev-sel127-keys-${tx_no}`,
    env.p.project_id,
    tx_id,
    type,
    JSON.stringify(payload),
  );
  const row = env.db.get<{ event_seq: bigint }>("SELECT event_seq FROM events WHERE id = ?", `ev-sel127-keys-${tx_no}`);
  return String(row?.event_seq);
}

test("R1-2: 닫힌 자료 id 를 annotation·citation·relation·followup 의 키로 실은 사건은 비사람 changes 에서 숨고, 열린 자료의 같은 사건은 나간다; 사람은 모두 본다", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "sel127-keys", ["context:read", "file:read"], "external_agent");
    const closed = await material(env, "keys-closed");
    const open = await material(env, "keys-open");
    assert_ok(await set_access(env, closed.file_policy_id, "deny"));

    const hidden = [
      add_event(env, "annotation.created", { thread_id: "t-closed", message_id: "m-1", anchor_id: "a-1", target_object_id: closed.object_id, target_version_id: closed.version_id, anchor_status: "exact" }),
      add_event(env, "content.citation_added", { artifact_version_id: "v-synthetic-artifact", source_version_id: closed.version_id, citation_no: 1 }),
      add_event(env, "content.relation_linked", { from_version_id: open.version_id, to_version_id: closed.version_id, kind: "supports" }),
      add_event(env, "followup.proposed", { followup_id: "f-1", version_id: "v-synthetic-followup", kind: "revise", thread_id: "t-closed", proposed_version_id: closed.version_id }),
    ];
    const shown = add_event(env, "annotation.created", { thread_id: "t-open", message_id: "m-2", anchor_id: "a-2", target_object_id: open.object_id, target_version_id: open.version_id, anchor_status: "exact" });

    const agent_feed = assert_ok(await call(env, { method: "GET", path: P(env, "/changes?limit=100"), auth: { token: agent.token } })).events as Array<{ event_seq: string }>;
    const agent_seqs = new Set(agent_feed.map((e) => e.event_seq));
    for (const seq of hidden) assert.ok(!agent_seqs.has(seq), `closed-id event ${seq} must not reach the agent feed`);
    assert.ok(agent_seqs.has(shown), "an event about an open material still reaches the agent feed");

    const owner_feed = assert_ok(await call(env, { method: "GET", path: P(env, "/changes?limit=100"), auth: "owner" })).events as Array<{ event_seq: string }>;
    const owner_seqs = new Set(owner_feed.map((e) => e.event_seq));
    for (const seq of [...hidden, shown]) assert.ok(owner_seqs.has(seq), `the owner sees event ${seq}`);
  });
});

/** SEL-127 리뷰 F1-1 — dispatch.adopted 는 adopted_version_id 를 싣는다. 닫힌 자료 판이면 비사람 changes 에서 숨는다. */
test("F1-1: 닫힌 자료 판을 adopted_version_id 로 실은 dispatch.adopted 는 비사람 changes 에서 숨고, 열린 자료 판이면 나간다", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "sel127-adopted", ["context:read", "file:read"], "external_agent");
    const closed = await material(env, "adopted-closed");
    const open = await material(env, "adopted-open");
    assert_ok(await set_access(env, closed.file_policy_id, "deny"));

    const hidden = add_event(env, "dispatch.adopted", { dispatch_id: "d-closed", run_id: "r-1", adopted_version_id: closed.version_id });
    const shown = add_event(env, "dispatch.adopted", { dispatch_id: "d-open", run_id: "r-2", adopted_version_id: open.version_id });

    const agent_feed = assert_ok(await call(env, { method: "GET", path: P(env, "/changes?limit=100"), auth: { token: agent.token } })).events as Array<{ event_seq: string }>;
    const agent_seqs = new Set(agent_feed.map((e) => e.event_seq));
    assert.ok(!agent_seqs.has(hidden), "dispatch.adopted naming a closed material version must not reach the agent feed");
    assert.ok(agent_seqs.has(shown), "dispatch.adopted naming an open material version still reaches the agent feed");

    const owner_feed = assert_ok(await call(env, { method: "GET", path: P(env, "/changes?limit=100"), auth: "owner" })).events as Array<{ event_seq: string }>;
    const owner_seqs = new Set(owner_feed.map((e) => e.event_seq));
    assert.ok(owner_seqs.has(hidden) && owner_seqs.has(shown), "the owner sees both dispatch.adopted events");
  });
});

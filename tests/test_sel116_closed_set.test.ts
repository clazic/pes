/**
 * SEL-116 × SEL-127 정합 — closed_materials (한 번에 만드는 닫힌 집합) 도 file_ai_denied 의 '추출 조상 재귀 규칙'을 안다:
 * 원본이 닫히면 그 추출 글자·그 글자의 추출 글자도 닫힌다. 집합판과 낱개 판정(file_ai_denied · material_object_denied)이
 * 같은 답을 내는지, 그리고 비사람의 GET materials · GET changes 가 낱개 판정과 같이 가리는지 지킨다. 합성 값만 쓴다.
 *
 * 사슬은 API 로만 만든다: 소유자가 추출 글자를 자료로 다시 올려 다시 추출한다(단계마다 다른 blob 이 되도록 홀수 개 BOM 으로 시작).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { call, make_agent, with_api, assert_ok, type ApiEnv } from "./helpers/api_env.ts";
import { closed_materials, file_ai_denied, material_object_denied } from "../scripts/pes_core/commands/file_access.ts";
import { P, extract, extraction_rows, material_of, set_access, type Mat } from "./helpers/sel116_env.ts";

const BOM = "﻿";
const enc = (s: string) => new TextEncoder().encode(s);
const BODY = "SYNTHETIC-PRIVATE\n";

interface Link {
  mat: Mat;
  blob_id: string;
  policy_id: string;
}

/** links[0] = S, links[i] = the (i-1)-th extracted text pasted back as a material. last_blob_id = the text of the last link (no material). */
async function build_chain(env: ApiEnv, depth: number): Promise<{ links: Link[]; last_blob_id: string }> {
  let bytes = enc(BOM.repeat(2 * depth + 1) + BODY);
  const links: Link[] = [];
  let last_blob_id = "";
  for (let i = 0; i <= depth; i++) {
    const mat = await material_of(env, `단계${i}.txt`, bytes);
    const res = assert_ok(await extract(env, mat), 201);
    assert.notEqual(res.text_blob_id, mat.blob.blob_id, `step ${i} must make a different blob`);
    links.push({ mat, blob_id: mat.blob.blob_id, policy_id: mat.data.file_policy_id });
    last_blob_id = res.text_blob_id;
    const read = await call(env, { method: "GET", path: P(env, `/files/${res.text_blob_id}/content`), auth: "owner" });
    bytes = new Uint8Array(read.bytes ?? new Uint8Array());
  }
  return { links, last_blob_id };
}

/** the set must give the same answer as the per-item decisions for every blob and every material object */
function assert_same(env: ApiEnv, links: Link[], last_blob_id: string, where: string): ReturnType<typeof closed_materials> {
  const project_id = env.p.project_id;
  const closed = closed_materials(env.db, project_id);
  for (const blob_id of [...links.map((l) => l.blob_id), last_blob_id]) {
    assert.equal(closed.denied_blobs.has(blob_id), file_ai_denied(env.db, project_id, blob_id), `${where}: denied_blobs ${blob_id}`);
  }
  for (const l of links) {
    const object_id = l.mat.data.object_id as string;
    assert.equal(closed.objects.has(object_id), material_object_denied(env.db, project_id, object_id), `${where}: objects ${object_id}`);
  }
  return closed;
}

test("S→T→U: only S denied — closed_materials closes T, U (and the last text) like file_ai_denied; objects, blobs, policies follow; allow again reopens", async () => {
  await with_api(async (env) => {
    const { links, last_blob_id } = await build_chain(env, 2);
    const [s, t, u] = links as [Link, Link, Link];
    const open = assert_same(env, links, last_blob_id, "all allow");
    assert.equal(open.denied_blobs.size, 0);
    assert.equal(open.objects.size, 0);

    assert_ok(await set_access(env, s.policy_id, "deny"));
    const closed = assert_same(env, links, last_blob_id, "S denied");
    for (const blob of [s.blob_id, t.blob_id, u.blob_id, last_blob_id]) assert.ok(closed.denied_blobs.has(blob), `denied_blobs has ${blob}`);
    for (const l of links) assert.ok(closed.objects.has(l.mat.data.object_id), "every material of the family is a closed object");
    for (const l of links) assert.ok(closed.blobs.has(l.blob_id) && closed.policies.has(l.policy_id), "blobs and policies follow");
    assert.ok(closed.versions.has(u.mat.data.version_id as string));

    assert_ok(await set_access(env, s.policy_id, "allow"));
    const reopened = assert_same(env, links, last_blob_id, "allow again");
    assert.equal(reopened.denied_blobs.size, 0);
    assert.equal(reopened.objects.size, 0);
  });
});

test("only the middle text T denied: T, U closed; S stays open — set equals the per-item answers", async () => {
  await with_api(async (env) => {
    const { links, last_blob_id } = await build_chain(env, 2);
    const [s, t, u] = links as [Link, Link, Link];
    assert_ok(await set_access(env, t.policy_id, "deny"));
    const closed = assert_same(env, links, last_blob_id, "T denied");
    assert.ok(!closed.denied_blobs.has(s.blob_id) && !closed.objects.has(s.mat.data.object_id), "S stays open");
    assert.ok(closed.denied_blobs.has(t.blob_id) && closed.denied_blobs.has(u.blob_id) && closed.denied_blobs.has(last_blob_id));
    assert.ok(closed.objects.has(t.mat.data.object_id) && closed.objects.has(u.mat.data.object_id));
  });
});

test("deny position sweep on a 5-step chain: the set equals the per-item answers at every position", async () => {
  await with_api(async (env) => {
    const { links, last_blob_id } = await build_chain(env, 5);
    for (let pos = 0; pos < links.length; pos++) {
      assert_ok(await set_access(env, links[pos]!.policy_id, "deny"));
      const closed = assert_same(env, links, last_blob_id, `deny@${pos}`);
      links.forEach((l, i) => assert.equal(closed.denied_blobs.has(l.blob_id), i >= pos, `deny@${pos}: blob ${i}`));
      assert.equal(closed.denied_blobs.has(last_blob_id), true);
      assert_ok(await set_access(env, links[pos]!.policy_id, "allow"));
    }
    assert.equal(closed_materials(env.db, env.p.project_id).denied_blobs.size, 0);
  });
});

test("a cycle and a self-edge in file_extractions end, and the set still equals the per-item answers", async () => {
  await with_api(async (env) => {
    const { links, last_blob_id } = await build_chain(env, 2);
    const [s, t] = links as [Link, Link, Link];
    const first = extraction_rows(env.db, env.p.project_id)[0]!;
    const copy = (n: string, blob_id: string, text_blob_id: string, text_policy: string) =>
      env.db.run(
        `INSERT INTO file_extractions (id, project_id, version_id, blob_id, source_file_policy_id, source_format, extractor, extractor_version,
           status, text_blob_id, text_file_policy_id, text_hash, page_count, table_count, warnings_json, created_at, tx_id)
         SELECT ?, project_id, version_id, ?, (SELECT id FROM file_policies WHERE project_id = file_extractions.project_id AND blob_id = ?),
                source_format, extractor, 'cycle-' || ?, status, ?, ?, text_hash, page_count, table_count, warnings_json, created_at, tx_id
           FROM file_extractions WHERE id = ?`,
        `cyc-${n}`,
        blob_id,
        blob_id,
        n,
        text_blob_id,
        text_policy,
        first.id,
      );
    const policy_of = (blob: string) => env.db.get<{ id: string }>("SELECT id FROM file_policies WHERE blob_id = ?", blob)!.id;
    copy("self", last_blob_id, last_blob_id, policy_of(last_blob_id));
    copy("back", last_blob_id, s.blob_id, policy_of(s.blob_id));

    const started = Date.now();
    assert_same(env, links, last_blob_id, "cycle, all allow");
    assert_ok(await set_access(env, t.policy_id, "deny"));
    const closed = assert_same(env, links, last_blob_id, "cycle, T denied");
    assert.ok(closed.denied_blobs.has(s.blob_id), "through the back edge S sees T as an ancestor too");
    assert.ok(Date.now() - started < 2000, "the walk ends");
  });
});

test("the closed set costs a constant number of queries however long the chain is", async () => {
  await with_api(async (env) => {
    const short = await build_chain(env, 2);
    assert_ok(await set_access(env, short.links[0]!.policy_id, "deny"));
    const count_of = () => {
      let n = 0;
      const db = {
        get: (...a: Parameters<typeof env.db.get>) => (n++, env.db.get(...a)),
        all: (...a: Parameters<typeof env.db.all>) => (n++, env.db.all(...a)),
      } as Pick<typeof env.db, "get" | "all">;
      closed_materials(db, env.p.project_id);
      return n;
    };
    const with_short = count_of();
    const longer = await build_chain(env, 12);
    assert_ok(await set_access(env, longer.links[0]!.policy_id, "deny"));
    const with_long = count_of();
    assert.equal(with_long, with_short, "query count does not grow with chain length");
    assert.ok(with_long <= 3, `a constant couple of queries, got ${with_long}`);
  });
});

test("non-human GET materials and GET changes hide the family's materials and events exactly as the per-item decisions do", async () => {
  await with_api(async (env) => {
    const { links, last_blob_id } = await build_chain(env, 2);
    const other = await material_of(env, "무관.txt", enc("UNRELATED-OPEN\n"));
    const agent = await make_agent(env, "family", ["context:read", "file:read"]);
    const project_id = env.p.project_id;

    const agent_objects = async () =>
      new Set(((assert_ok(await call(env, { method: "GET", path: P(env, "/materials"), auth: { token: agent.token } })).materials as Array<{ object_id: string }>) ?? []).map((m) => m.object_id));
    const before = await agent_objects();
    for (const l of links) assert.ok(before.has(l.mat.data.object_id), "all open: visible");

    assert_ok(await set_access(env, links[0]!.policy_id, "deny"));
    const after = await agent_objects();
    for (const l of links) {
      const object_id = l.mat.data.object_id as string;
      assert.equal(material_object_denied(env.db, project_id, object_id), true, "the per-item decision closes the whole family");
      assert.equal(after.has(object_id), false, `GET materials hides ${l.mat.data.object_id}`);
    }
    assert.ok(after.has(other.data.object_id), "an unrelated open material stays");

    // the change feed: every event the per-item decisions call closed is gone, the rest stays
    const feed = assert_ok(await call(env, { method: "GET", path: P(env, "/changes?limit=100"), auth: { token: agent.token } })).events as Array<{ event_seq: string }>;
    const shown = new Set(feed.map((e) => e.event_seq));
    const family_blobs = new Set([...links.map((l) => l.blob_id), last_blob_id]);
    const policy_blob = new Map(env.db.all<{ id: string; blob_id: string }>("SELECT id, blob_id FROM file_policies WHERE project_id = ?", project_id).map((r) => [r.id, r.blob_id]));
    const object_keys = ["object_id", "target_object_id"];
    const version_keys = ["version_id", "target_version_id", "source_version_id", "artifact_version_id", "from_version_id", "to_version_id", "proposed_version_id", "adopted_version_id", "input_version_id"];
    const version_owner = new Map(env.db.all<{ id: string; object_id: string }>("SELECT id, object_id FROM object_versions WHERE project_id = ?", project_id).map((r) => [r.id, r.object_id]));
    let hidden_with_family = 0;
    // token events are hidden from every non-human feed by an older rule (not the closed set) — left out of this comparison
    for (const e of env.db.all<{ event_seq: bigint; payload: string }>("SELECT event_seq, payload FROM events WHERE type NOT LIKE 'token.%' ORDER BY event_seq")) {
      const p = JSON.parse(e.payload) as Record<string, unknown>;
      const str = (k: string): string | undefined => (typeof p[k] === "string" ? (p[k] as string) : undefined);
      const by_blob = str("blob_id") !== undefined && file_ai_denied(env.db, project_id, str("blob_id")!);
      const by_policy = str("file_policy_id") !== undefined && policy_blob.has(str("file_policy_id")!) && file_ai_denied(env.db, project_id, policy_blob.get(str("file_policy_id")!)!);
      const by_object = object_keys.some((k) => str(k) !== undefined && material_object_denied(env.db, project_id, str(k)!));
      const by_version = version_keys.some((k) => {
        const owner = str(k) === undefined ? undefined : version_owner.get(str(k)!);
        return owner !== undefined && material_object_denied(env.db, project_id, owner);
      });
      const oracle_closed = by_blob || by_policy || by_object || by_version;
      assert.equal(shown.has(e.event_seq.toString()), !oracle_closed, `event ${e.event_seq} ${e.payload}`);
      if (oracle_closed && (str("blob_id") !== undefined ? family_blobs.has(str("blob_id")!) : false)) hidden_with_family++;
    }
    assert.ok(hidden_with_family > 0, "the family's own events exist and are hidden");
  });
});

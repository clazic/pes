/**
 * SEL-116 final review 2 (F2-M1, F2-M2) — a text extracted from a closed file is closed to AI however many extraction steps
 * lie between them, and the change feed follows the same decision (file_ai_denied) as every read exit.
 *
 * Chains are built through the API only: the owner pastes an extracted text back as a material and extracts it again. Each
 * step must yield a DIFFERENT blob, so the synthetic source starts with an odd run of UTF-8 BOMs (an extraction removes two).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { call, make_agent, with_api, assert_ok, assert_error, type ApiEnv } from "./helpers/api_env.ts";
import { file_ai_denied } from "../scripts/pes_core/commands/file_access.ts";
import { P, count, extract, extraction_rows, http_blob, material_of, set_access, upload_material, type Mat } from "./helpers/sel116_env.ts";

const BOM = "﻿";
const enc = (s: string) => new TextEncoder().encode(s);
const BODY = "SYNTHETIC-PRIVATE\n";

interface Link {
  mat: Mat;
  /** this step's source blob */
  blob_id: string;
  /** the policy of this step's source blob */
  policy_id: string;
  /** the extraction id made from this step (its text is the next link's source) */
  extraction_id: string;
}

/** links[0] = S (the original), links[i] = the i-th extracted text pasted back as a material and extracted again. Returns depth+1 links plus the last text blob. */
async function build_chain(env: ApiEnv, depth: number): Promise<{ links: Link[]; last_blob_id: string; last_policy_id: string }> {
  let bytes = enc(BOM.repeat(2 * depth + 1) + BODY);
  const links: Link[] = [];
  let last_blob_id = "";
  let last_policy_id = "";
  for (let i = 0; i <= depth; i++) {
    const mat = await material_of(env, `단계${i}.txt`, bytes);
    const res = assert_ok(await extract(env, mat), 201);
    assert.ok(res.text_blob_id, "text blob expected");
    assert.notEqual(res.text_blob_id, mat.blob.blob_id, `step ${i} must make a different blob`);
    links.push({ mat, blob_id: mat.blob.blob_id, policy_id: mat.data.file_policy_id, extraction_id: res.extraction_id });
    last_blob_id = res.text_blob_id;
    last_policy_id = res.text_file_policy_id;
    const read = await call(env, { method: "GET", path: P(env, `/files/${res.text_blob_id}/content`), auth: "owner" });
    bytes = new Uint8Array(read.bytes ?? new Uint8Array());
  }
  return { links, last_blob_id, last_policy_id };
}

async function agent_status(env: ApiEnv, token: string, blob_id: string): Promise<number> {
  return (await call(env, { method: "GET", path: P(env, `/files/${blob_id}/content`), auth: { token } })).status;
}

async function feed_seqs(env: ApiEnv, auth: "owner" | { token: string }): Promise<Set<string>> {
  const res = await call(env, { method: "GET", path: P(env, "/changes?limit=100"), auth });
  return new Set((assert_ok(res).events as Array<{ event_seq: string }>).map((e) => e.event_seq));
}

/** event_seq of every file.extracted / file.extract_confirmed event, keyed by the source blob of its extraction */
function extraction_event_seqs(env: ApiEnv): Map<string, string[]> {
  const by_extraction = new Map(extraction_rows(env.db, env.p.project_id).map((r) => [r.id, r.blob_id]));
  const out = new Map<string, string[]>();
  for (const e of env.db.all<{ event_seq: bigint; payload: string }>(
    "SELECT event_seq, payload FROM events WHERE type IN ('file.extracted','file.extract_confirmed') ORDER BY event_seq",
  )) {
    const blob = by_extraction.get(JSON.parse(e.payload).extraction_id as string);
    assert.ok(blob, "event names a stored extraction");
    out.set(blob, [...(out.get(blob) ?? []), e.event_seq.toString()]);
  }
  return out;
}

test("F2-M1: S→T→U — closing only the first original closes U (read 403, guessed upload 404, nothing written); allow again reopens", async () => {
  await with_api(async (env) => {
    const { links, last_blob_id } = await build_chain(env, 2);
    const [s, t] = links;
    const u_blob = last_blob_id;
    const agent_before = await make_agent(env, "before", ["context:read", "file:read", "file:write"]);
    assert.equal(file_ai_denied(env.db, env.p.project_id, u_blob), false);
    assert.equal(await agent_status(env, agent_before.token, u_blob), 200);

    assert_ok(await set_access(env, s.policy_id, "deny"));
    assert.equal(file_ai_denied(env.db, env.p.project_id, t.blob_id), true);
    assert.equal(file_ai_denied(env.db, env.p.project_id, u_blob), true, "U inherits S's deny through T");

    const agent = await make_agent(env, "after", ["context:read", "file:read", "file:write"]);
    assert.equal(await agent_status(env, agent.token, t.blob_id), 403);
    assert.equal(await agent_status(env, agent.token, u_blob), 403, "the second-level text is closed too");

    // a guess of U's bytes dedups onto U — must look like an unknown blob
    const guess = await http_blob(env, enc(BODY), { name: "추측.txt", auth: { token: agent.token } });
    assert.equal(guess.blob_id, u_blob);
    const before = { receipts: count(env.db, "mutation_commits"), events: count(env.db, "events"), objects: count(env.db, "objects") };
    assert_error(await upload_material(env, { blob_id: guess.blob_id }, { token: agent.token }), 404, "not_found");
    assert.equal(count(env.db, "mutation_commits"), before.receipts);
    assert.equal(count(env.db, "events"), before.events);
    assert.equal(count(env.db, "objects"), before.objects);

    assert_ok(await set_access(env, s.policy_id, "allow"));
    assert.equal(file_ai_denied(env.db, env.p.project_id, u_blob), false);
    assert.equal(await agent_status(env, agent.token, u_blob), 200, "reopened");
    assert_ok(await upload_material(env, { blob_id: guess.blob_id }, { token: agent.token }), 201);
  });
});

test("F2-M1: only the middle text T denied closes U, not S; direct allow policies along the chain do not open it", async () => {
  await with_api(async (env) => {
    const { links, last_blob_id } = await build_chain(env, 2);
    const [s, t, u] = links;
    // T's own policy is the policy of U's source... T is the source blob of links[1]; deny that one only
    assert_ok(await set_access(env, t.policy_id, "deny"));
    assert.equal(file_ai_denied(env.db, env.p.project_id, s.blob_id), false, "S stays open");
    assert.equal(file_ai_denied(env.db, env.p.project_id, t.blob_id), true);
    assert.equal(file_ai_denied(env.db, env.p.project_id, u.blob_id), true);
    assert.equal(file_ai_denied(env.db, env.p.project_id, last_blob_id), true);
    const agent = await make_agent(env, "mid", ["context:read", "file:read"]);
    assert.equal(await agent_status(env, agent.token, s.blob_id), 200);
    assert.equal(await agent_status(env, agent.token, last_blob_id), 403);
  });
});

test("F2-M1: deny position × chain depth 5 — a blob is closed exactly when an ancestor (or it) is denied; content 403 and the feed move together (F2-M2)", async () => {
  await with_api(async (env) => {
    const { links, last_blob_id } = await build_chain(env, 5);
    const blobs = [...links.map((l) => l.blob_id), last_blob_id];
    const events = extraction_event_seqs(env);
    const owner_seqs = await feed_seqs(env, "owner");
    const agent = await make_agent(env, "sweep", ["context:read", "file:read"]);
    for (const e of events.values()) assert.ok(e.every((q) => owner_seqs.has(q)), "the owner sees every extraction event");

    const denied_at: number[] = [];
    for (let pos = 0; pos < links.length; pos++) {
      assert_ok(await set_access(env, links[pos]!.policy_id, "deny"));
      const seqs = await feed_seqs(env, { token: agent.token });
      for (let i = 0; i < blobs.length; i++) {
        const closed = i >= pos;
        const blob = blobs[i]!;
        assert.equal(file_ai_denied(env.db, env.p.project_id, blob), closed, `deny@${pos}: blob ${i}`);
        assert.equal(await agent_status(env, agent.token, blob), closed ? 403 : 200, `deny@${pos}: content ${i}`);
        // the extraction MADE FROM blob i (i < last) has its event hidden exactly when blob i is closed
        if (i < links.length) {
          const mine = events.get(blob) ?? [];
          assert.ok(mine.length > 0, "an extraction event exists");
          assert.equal(mine.some((q) => seqs.has(q)), !closed, `deny@${pos}: event of extraction ${i} ${closed ? "hidden" : "shown"}`);
        }
      }
      denied_at.push(pos);
      assert_ok(await set_access(env, links[pos]!.policy_id, "allow"));
    }
    // everything allowed again: all open, all events back
    const seqs = await feed_seqs(env, { token: agent.token });
    for (const blob of blobs) {
      assert.equal(file_ai_denied(env.db, env.p.project_id, blob), false);
      assert.equal(await agent_status(env, agent.token, blob), 200);
    }
    for (const mine of events.values()) assert.ok(mine.every((q) => seqs.has(q)));
    assert.equal(denied_at.length, links.length);
  });
});

test("F2-M1: a cycle and a self-edge in file_extractions end (time-bounded) and still follow the ancestors' policies", async () => {
  await with_api(async (env) => {
    const { links, last_blob_id } = await build_chain(env, 2);
    const [s, t] = links;
    const rows = extraction_rows(env.db, env.p.project_id);
    const first = rows[0]!;
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
    // self edge on U, and a back edge U → S (S's text is "U's source")
    copy("self", last_blob_id, last_blob_id, policy_of(last_blob_id));
    copy("back", last_blob_id, s.blob_id, policy_of(s.blob_id));

    const started = Date.now();
    assert.equal(file_ai_denied(env.db, env.p.project_id, last_blob_id), false);
    assert.equal(file_ai_denied(env.db, env.p.project_id, s.blob_id), false);
    assert_ok(await set_access(env, t.policy_id, "deny"));
    assert.equal(file_ai_denied(env.db, env.p.project_id, last_blob_id), true);
    assert.equal(file_ai_denied(env.db, env.p.project_id, s.blob_id), true, "through the cycle S sees T as an ancestor too");
    assert.ok(Date.now() - started < 2000, "the walk ends");
  });
});

test("F2-M1: several sources for one text — any one denied closes it, all open opens it", async () => {
  await with_api(async (env) => {
    // "x\r\n" and "x\r" both extract to the same text blob "x\n"
    const a = await material_of(env, "원본A.txt", enc("SYNTHETIC\r\n"));
    const b = await material_of(env, "원본B.txt", enc("SYNTHETIC\r"));
    const ra = assert_ok(await extract(env, a), 201);
    const rb = assert_ok(await extract(env, b), 201);
    assert.equal(ra.text_blob_id, rb.text_blob_id, "the two sources dedup onto one text blob");
    const text = ra.text_blob_id as string;
    const agent = await make_agent(env, "multi", ["context:read", "file:read"]);
    assert.equal(file_ai_denied(env.db, env.p.project_id, text), false);

    assert_ok(await set_access(env, a.data.file_policy_id, "deny"));
    assert.equal(file_ai_denied(env.db, env.p.project_id, text), true);
    assert.equal(await agent_status(env, agent.token, text), 403);
    assert_ok(await set_access(env, b.data.file_policy_id, "deny"));
    assert_ok(await set_access(env, a.data.file_policy_id, "allow"));
    assert.equal(file_ai_denied(env.db, env.p.project_id, text), true, "B alone still closes it");
    assert_ok(await set_access(env, b.data.file_policy_id, "allow"));
    assert.equal(file_ai_denied(env.db, env.p.project_id, text), false);
    assert.equal(await agent_status(env, agent.token, text), 200);
  });
});

test("F2-M1: a 50-step chain is judged in constant queries and well inside the time limit", async () => {
  await with_api(async (env) => {
    const { links, last_blob_id } = await build_chain(env, 50);
    assert.equal(links.length, 51);
    const counting = (db: typeof env.db) => {
      let n = 0;
      return {
        db: {
          get: (...args: Parameters<typeof db.get>) => (n++, db.get(...args)),
          all: (...args: Parameters<typeof db.all>) => (n++, db.all(...args)),
        } as Pick<typeof db, "get" | "all">,
        calls: () => n,
      };
    };
    assert_ok(await set_access(env, links[0]!.policy_id, "deny"));
    const deep = counting(env.db);
    const t0 = performance.now();
    assert.equal(file_ai_denied(deep.db, env.p.project_id, last_blob_id), true);
    const elapsed = performance.now() - t0;
    const shallow = counting(env.db);
    assert.equal(file_ai_denied(shallow.db, env.p.project_id, links[1]!.blob_id), true);
    assert.equal(deep.calls(), shallow.calls(), "query count does not grow with the number of ancestors");
    assert.ok(deep.calls() <= 2, `at most a constant couple of queries, got ${deep.calls()}`);
    assert.ok(elapsed < 500, `50-step walk took ${elapsed}ms`);

    // closing the position moves the answer: deny only the 30th link
    assert_ok(await set_access(env, links[0]!.policy_id, "allow"));
    assert.equal(file_ai_denied(env.db, env.p.project_id, last_blob_id), false);
    assert_ok(await set_access(env, links[30]!.policy_id, "deny"));
    assert.equal(file_ai_denied(env.db, env.p.project_id, last_blob_id), true);
    assert.equal(file_ai_denied(env.db, env.p.project_id, links[29]!.blob_id), false);
    assert.equal(file_ai_denied(env.db, env.p.project_id, links[30]!.blob_id), true);
  });
});

test("F2-M2: the extraction events of a closed family (file.extracted and file.extract_confirmed) are hidden from non-human feeds, shown to the owner", async () => {
  await with_api(async (env) => {
    // S (CRLF) → T (LF); the owner pastes T as its own material and extracts it again
    const s = await material_of(env, "원본.txt", enc("SYNTHETIC PRIVATE\r\n"));
    const rs = assert_ok(await extract(env, s), 201);
    const t_blob = await http_blob(env, enc("SYNTHETIC PRIVATE\n"), { name: "붙임.txt" });
    assert.equal(t_blob.blob_id, rs.text_blob_id);
    const t_res = assert_ok(await upload_material(env, { blob_id: t_blob.blob_id, title: "붙인 글자" }), 201);
    const t: Mat = { data: t_res, blob: t_blob, name: "붙임.txt", bytes: enc("SYNTHETIC PRIVATE\n") };

    // a control material that stays open, with its own extraction
    const open = await material_of(env, "공개.txt", enc("OPEN\r\n"));
    assert_ok(await extract(env, open), 201);

    assert_ok(await set_access(env, s.data.file_policy_id, "deny"));
    const t_first = assert_ok(await extract(env, t, "owner", "key-t-1"), 201);
    // The HTTP route answers a repeat from the stored row; the command itself (reached by a retry race) stores file.extract_confirmed.
    const again = await env.service.execute(env.ctx("confirm-t"), "file.extract", { version_id: t.data.version_id, blob_id: t.blob.blob_id });
    assert.equal((again.result as { changed: boolean }).changed, false, "the second request only confirms");
    assert.ok(t_first.extraction_id);

    const types = env.db.all<{ type: string }>("SELECT type FROM events WHERE type IN ('file.extracted','file.extract_confirmed')").map((e) => e.type);
    assert.ok(types.includes("file.extract_confirmed"), "a confirmed event was stored");

    const agent = await make_agent(env, "feed", ["context:read", "file:read"]);
    const res = await call(env, { method: "GET", path: P(env, "/changes?limit=100"), auth: { token: agent.token } });
    const feed = assert_ok(res).events as Array<{ event_seq: string; type: string; at: number }>;
    const extraction_events = feed.filter((e) => e.type === "file.extracted" || e.type === "file.extract_confirmed");
    assert.equal(extraction_events.length, 1, "only the open material's extraction shows (no count, no time of the closed family)");

    const by_blob = extraction_event_seqs(env);
    const hidden = [...(by_blob.get(s.blob.blob_id) ?? []), ...(by_blob.get(t.blob.blob_id) ?? [])];
    assert.ok(hidden.length >= 3, "S's extraction and T's extract + confirm are stored events");
    const seen = new Set(feed.map((e) => e.event_seq));
    assert.ok(hidden.every((q) => !seen.has(q)), "none of them reaches the agent");

    const owner = await feed_seqs(env, "owner");
    assert.ok(hidden.every((q) => owner.has(q)), "the owner sees all of them");

    // allow again → they come back
    assert_ok(await set_access(env, s.data.file_policy_id, "allow"));
    const back = await feed_seqs(env, { token: agent.token });
    assert.ok(hidden.every((q) => back.has(q)));
  });
});

/**
 * SEL-116 final review 1 (M1) — a closed source's extracted text is closed to AI the same way the source is.
 * The upload exit (POST /uploads → POST /materials) and the extraction exit (POST /file-extractions) used to judge only the blob's
 * own policy, so an agent could (1) guess the extracted text of a closed file and learn from 201 vs 404, and (2) extract the text
 * blob itself through a version that carries it. Both must answer like a closed blob: 404 / 403, nothing written.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { call, make_agent, with_api, assert_error, assert_ok } from "./helpers/api_env.ts";
import { P, count, extract, extraction_rows, http_blob, material_of, set_access, upload_material } from "./helpers/sel116_env.ts";

const enc = (s: string) => new TextEncoder().encode(s);

test("M1: a guess of a closed file's extracted text is refused like an unknown blob (404), and writes nothing", async () => {
  await with_api(async (env) => {
    // CRLF source → the extracted text differs from the source bytes, so it is a separate text blob
    const m = await material_of(env, "비밀.txt", enc("연봉 12345\r\n"));
    const extracted = assert_ok(await extract(env, m), 201);
    assert.ok(extracted.text_blob_id, "text blob expected");
    await set_access(env, m.data.file_policy_id, "deny");

    const agent = await make_agent(env, "guesser", ["context:read", "file:read", "file:write"]);
    const tok = { token: agent.token };

    // the exact text bytes: same blob as the closed file's extracted text (dedup) — must look like an unknown blob
    const hit = await http_blob(env, enc("연봉 12345\n"), { name: "추측.txt", auth: tok });
    assert.equal(hit.blob_id, extracted.text_blob_id, "guess must dedup onto the extracted text blob");
    const before = { receipts: count(env.db, "mutation_commits"), events: count(env.db, "events"), objects: count(env.db, "objects") };
    const refused = await upload_material(env, { blob_id: hit.blob_id }, tok);
    assert_error(refused, 404, "not_found");
    assert.equal(count(env.db, "mutation_commits"), before.receipts);
    assert.equal(count(env.db, "events"), before.events);
    assert.equal(count(env.db, "objects"), before.objects);

    // a wrong guess is an ordinary new material (201) — the refusal above is about the closed text, not about the agent
    const miss = await http_blob(env, enc("연봉 99999\n"), { name: "추측.txt", auth: tok });
    assert.notEqual(miss.blob_id, extracted.text_blob_id);
    assert_ok(await upload_material(env, { blob_id: miss.blob_id }, tok), 201);
  });
});

test("M1: an agent cannot extract a closed file's text blob through another version that carries it (403, nothing written)", async () => {
  await with_api(async (env) => {
    const m = await material_of(env, "원본.txt", enc("연봉 12345\r\n"));
    const extracted = assert_ok(await extract(env, m), 201);
    assert.ok(extracted.text_blob_id, "text blob expected");
    await set_access(env, m.data.file_policy_id, "deny");

    // the owner attaches the closed file's text blob to a material of its own (the text blob's own policy is allow)
    const text_blob = await http_blob(env, enc("연봉 12345\n"), { name: "글자.txt" });
    assert.equal(text_blob.blob_id, extracted.text_blob_id);
    const other = await upload_material(env, { blob_id: text_blob.blob_id, title: "다른 자료" });
    const other_data = assert_ok(other, 201);

    const agent = await make_agent(env, "extractor", ["context:read", "file:read", "file:write"]);
    const tok = { token: agent.token };
    const before = { rows: extraction_rows(env.db, env.p.project_id).length, receipts: count(env.db, "mutation_commits") };
    const refused = await call(env, {
      method: "POST",
      path: P(env, "/file-extractions"),
      auth: tok,
      body: { version_id: other_data.version_id, blob_id: text_blob.blob_id },
    });
    assert_error(refused, 403, "forbidden");
    assert.equal(extraction_rows(env.db, env.p.project_id).length, before.rows);
    assert.equal(count(env.db, "mutation_commits"), before.receipts);
  });
});

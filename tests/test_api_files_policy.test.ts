/**
 * SEL-46 PR13 — HTTP API: file reserve / upload / complete / read, token scope, and Go OFF
 * (tester, 작성 모드). The interface is described at the top of tests/helpers/api_env.ts and
 * tests/test_api_context.test.ts.
 *
 *   POST P/uploads                  {sha256, size, media_type, original_name?} -> 201 staging (200 when deduplicated)
 *   PUT  P/uploads/{b}              raw bytes; must match the reservation byte for byte
 *   POST P/uploads/{b}/complete     {} -> the server re-reads and measures the stored bytes -> ready
 *   GET  P/files/{b}/content        raw bytes through the PES proxy; policy is checked on EVERY read
 *
 * Scopes: file:write for the first three, file:read for the read. A Go-bound actor (kind internal_ai)
 * is blocked from reading while Go is OFF (403 policy_denied, retryable=false); the owner and external
 * agents are not. There is no download URL anywhere in a response, so OFF cannot be bypassed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { sha256_hex } from "./helpers/backup_fixture.ts";
import {
  assert_error,
  assert_ok,
  call,
  go_off,
  make_agent,
  project_path,
  with_api,
  type ApiEnv,
} from "./helpers/api_env.ts";
import { blob_row_must, bytes_of, list_files, plant_bytes, put_ready, second_project } from "./helpers/blob_env.ts";
import { state_signature } from "./helpers/state_signature.ts";
import { set_policy } from "../scripts/pes_core/policy.ts";

const P = (env: ApiEnv, rest = "") => project_path(env, rest);
const MEDIA = "application/octet-stream";

async function reserve(env: ApiEnv, token: string | "owner", bytes: Uint8Array, extra: Record<string, unknown> = {}) {
  return call(env, {
    method: "POST",
    path: P(env, "/uploads"),
    auth: token === "owner" ? "owner" : { token },
    body: { sha256: sha256_hex(bytes), size: bytes.byteLength, media_type: MEDIA, original_name: "합성.bin", ...extra },
  });
}

async function upload(env: ApiEnv, token: string | "owner", blob_id: string, bytes: Uint8Array) {
  return call(env, {
    method: "PUT",
    path: P(env, `/uploads/${blob_id}`),
    auth: token === "owner" ? "owner" : { token },
    raw: bytes,
    headers: { "content-type": MEDIA },
  });
}

async function complete(env: ApiEnv, token: string | "owner", blob_id: string) {
  return call(env, {
    method: "POST",
    path: P(env, `/uploads/${blob_id}/complete`),
    auth: token === "owner" ? "owner" : { token },
    body: {},
  });
}

async function read(env: ApiEnv, token: string | "owner" | "none", blob_id: string, project = env.p.project_id) {
  return call(env, {
    method: "GET",
    path: `/api/v1/projects/${project}/files/${blob_id}/content`,
    auth: token === "owner" ? "owner" : token === "none" ? "none" : { token },
  });
}

async function ready_blob(env: ApiEnv, token: string | "owner", bytes: Uint8Array): Promise<string> {
  const r = assert_ok(await reserve(env, token, bytes), 201);
  assert_ok(await upload(env, token, r.blob_id, bytes));
  const done = assert_ok(await complete(env, token, r.blob_id));
  assert.equal(done.state, "ready");
  return r.blob_id as string;
}

// ---------------------------------------------------------------------------
// 5. reserve -> upload -> complete -> ready -> read

test("reserve, upload, complete, read: the bytes round trip and the blob is ready only after complete", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "files");
    const bytes = bytes_of("round-trip", 300);

    const reserved = await reserve(env, agent.token, bytes);
    const r = assert_ok(reserved, 201);
    assert.equal(r.state, "staging");
    assert.equal(r.deduplicated, false);
    assert.equal(typeof r.blob_id, "string");
    assert.equal(reserved.json.replayed, false);
    assert.equal(blob_row_must(env.db, r.blob_id).state, "staging");

    // Not readable while staging, not even by the owner.
    assert_error(await read(env, "owner", r.blob_id), 409, "conflict");

    const uploaded = assert_ok(await upload(env, agent.token, r.blob_id, bytes));
    assert.equal(uploaded.blob_id, r.blob_id);
    assert.equal(uploaded.state, "staging", "the upload alone does not make a blob ready");
    assert_error(await read(env, "owner", r.blob_id), 409, "conflict");

    const done = assert_ok(await complete(env, agent.token, r.blob_id));
    assert.equal(done.state, "ready");
    assert.equal(blob_row_must(env.db, r.blob_id).state, "ready");

    const got = await read(env, agent.token, r.blob_id);
    assert.equal(got.status, 200);
    assert.deepEqual(Buffer.from(got.bytes ?? new Uint8Array()), Buffer.from(bytes));
    assert.match(got.headers["content-type"] ?? "", /application\/octet-stream/);
    assert.equal(got.json, null);
    const owner_got = await read(env, "owner", r.blob_id);
    assert.deepEqual(Buffer.from(owner_got.bytes ?? new Uint8Array()), Buffer.from(bytes));
  });
});

test("an upload that does not match the reservation is rejected and leaves no bytes or state behind", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "files");
    const bytes = bytes_of("exact", 64);
    const r = assert_ok(await reserve(env, agent.token, bytes), 201);
    const before = state_signature(env.db);
    const same_size_other_content = bytes_of("exact", 64).slice();
    same_size_other_content[0] ^= 0xff;
    assert_error(await upload(env, agent.token, r.blob_id, same_size_other_content), 400, "invalid_payload");
    assert_error(await upload(env, agent.token, r.blob_id, bytes.slice(0, bytes.byteLength - 1)), 400, "invalid_payload");
    assert.equal(state_signature(env.db), before);
    assert.deepEqual(list_files(env.objects), [], "nothing was written to the object store");
    // The honest upload still works afterwards.
    assert_ok(await upload(env, agent.token, r.blob_id, bytes));
    assert.equal(list_files(env.objects).length, 1);
  });
});

test("complete before any bytes arrive is 409 and the blob stays staging", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "files");
    const r = assert_ok(await reserve(env, agent.token, bytes_of("no-bytes")), 201);
    const res = await complete(env, agent.token, r.blob_id);
    assert_error(res, 409, "conflict");
    assert.equal(blob_row_must(env.db, r.blob_id).state, "staging");
  });
});

test("complete takes no hash or size from the caller: a claim that disagrees quarantines, never readies", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "files");
    const bytes = bytes_of("claim", 40);
    const r = assert_ok(await reserve(env, agent.token, bytes), 201);
    assert_ok(await upload(env, agent.token, r.blob_id, bytes));
    const res = await call(env, {
      method: "POST",
      path: P(env, `/uploads/${r.blob_id}/complete`),
      auth: { token: agent.token },
      body: { sha256: "0".repeat(64) },
    });
    // Either an outright 400 (field not accepted) or a quarantine answer — never ready.
    if (res.status === 200) assert.equal(res.json.data.state, "quarantined");
    else assert_error(res, 400, "invalid_payload");
    assert.notEqual(blob_row_must(env.db, r.blob_id).state, "ready");
    assert_error(await read(env, "owner", r.blob_id), 409, "conflict");
  });
});

test("bytes changed on disk after ready are never served: the read is 409 conflict", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "files");
    const bytes = bytes_of("tamper", 80);
    const blob_id = await ready_blob(env, agent.token, bytes);
    plant_bytes(env, blob_row_must(env.db, blob_id), bytes_of("tamper-other", 80));
    const res = await read(env, agent.token, blob_id);
    assert_error(res, 409, "conflict");
    assert.equal(res.bytes, null);
  });
});

test("reserving the bytes of a ready blob again is deduplicated (200, ready) and writes no second blob", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "files");
    const bytes = bytes_of("dedup", 20);
    const first = await ready_blob(env, agent.token, bytes);
    const again = await reserve(env, agent.token, bytes);
    const data = assert_ok(again, 200);
    assert.equal(data.blob_id, first);
    assert.equal(data.state, "ready");
    assert.equal(data.deduplicated, true);
    assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM blobs")?.n, 1n);
  });
});

test("reserve replay: same key + body replays the answer; a different body under that key is 409", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "files");
    const bytes = bytes_of("replay");
    const body = { sha256: sha256_hex(bytes), size: bytes.byteLength, media_type: MEDIA };
    const a = await call(env, { method: "POST", path: P(env, "/uploads"), auth: { token: agent.token }, key: "up-1", body });
    const b = await call(env, { method: "POST", path: P(env, "/uploads"), auth: { token: agent.token }, key: "up-1", body });
    assert.equal(assert_ok(b, a.status).blob_id, assert_ok(a, 201).blob_id);
    assert.equal(b.json.replayed, true);
    assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM blobs")?.n, 1n);
    const other = bytes_of("replay-2");
    const reuse = await call(env, {
      method: "POST",
      path: P(env, "/uploads"),
      auth: { token: agent.token },
      key: "up-1",
      body: { sha256: sha256_hex(other), size: other.byteLength, media_type: MEDIA },
    });
    assert_error(reuse, 409, "idempotency_key_reuse");
  });
});

test("reserve validation: bad sha256, negative or non-integer size, missing media_type, unknown field are 400", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "files");
    const bytes = bytes_of("valid");
    const good = { sha256: sha256_hex(bytes), size: bytes.byteLength, media_type: MEDIA };
    const before = state_signature(env.db);
    const bad: Array<Record<string, unknown>> = [
      { ...good, sha256: "xyz" },
      { ...good, sha256: "A".repeat(63) },
      { ...good, size: -1 },
      { ...good, size: 1.5 },
      { ...good, size: "10" },
      { sha256: good.sha256, size: good.size },
      { ...good, storage_key: "../../etc/passwd" },
      { ...good, state: "ready" },
    ];
    for (const body of bad) {
      assert_error(await call(env, { method: "POST", path: P(env, "/uploads"), auth: { token: agent.token }, body }), 400, "invalid_payload");
    }
    assert.equal(state_signature(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// access: credentials, scopes, projects

test("file routes: no credential is 401, wrong scope is 403, and nothing is written", async () => {
  await with_api(async (env) => {
    const reader = await make_agent(env, "reader", ["file:read"]);
    const writer = await make_agent(env, "writer", ["file:write"]);
    const bytes = bytes_of("scopes");
    const ready = await ready_blob(env, "owner", bytes_of("scopes-ready"));
    const before = state_signature(env.db);

    assert_error(await call(env, { method: "POST", path: P(env, "/uploads"), body: {} }), 401, "unauthenticated");
    assert_error(await read(env, "none", ready), 401, "unauthenticated");
    assert_error(await reserve(env, reader.token, bytes), 403, "forbidden");
    assert_error(await read(env, writer.token, ready), 403, "forbidden");
    assert.equal(state_signature(env.db), before);
    assert_ok(await read(env, reader.token, ready));
    assert_ok(await reserve(env, writer.token, bytes), 201);
  });
});

test("a blob of another project is 404 for read, upload, and complete (never 403/409, never its bytes)", async () => {
  await with_api(async (env) => {
    const other = await second_project(env, "synthetic-files-other");
    const foreign = await put_ready(env, bytes_of("foreign", 30), "foreign", other);
    const agent = await make_agent(env, "files");
    const res = await read(env, agent.token, foreign.blob_id);
    assert_error(res, 404, "not_found");
    assert.equal(res.bytes, null);
    assert_error(await upload(env, agent.token, foreign.blob_id, bytes_of("foreign", 30)), 404, "not_found");
    assert_error(await complete(env, agent.token, foreign.blob_id), 404, "not_found");
    assert_error(await read(env, agent.token, "no-such-blob"), 404, "not_found");
    assert_error(await read(env, agent.token, "../../etc/passwd"), 404, "not_found");
  });
});

test("responses never contain a download URL or a storage path", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "files");
    const bytes = bytes_of("no-url", 10);
    const reserved = await reserve(env, agent.token, bytes);
    const r = assert_ok(reserved, 201);
    const uploaded = await upload(env, agent.token, r.blob_id, bytes);
    const done = await complete(env, agent.token, r.blob_id);
    const row = blob_row_must(env.db, r.blob_id);
    for (const res of [reserved, uploaded, done]) {
      const text = JSON.stringify(res.json);
      assert.doesNotMatch(text, /https?:\/\//);
      assert.doesNotMatch(text, /"(url|download_url|signed_url|storage_key|path)"/);
      assert.ok(!text.includes(row.storage_key));
      assert.ok(!text.includes(env.objects));
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Go OFF read block; 4. policy denial is final

test("Go OFF blocks a Go-bound actor's file read on every request; ON again lets it read; the owner and external agents are never blocked", async () => {
  await with_api(async (env) => {
    const go_actor = await make_agent(env, "go", undefined, "internal_ai");
    const external = await make_agent(env, "ext");
    const bytes = bytes_of("go-off", 50);
    const blob_id = await ready_blob(env, "owner", bytes);

    assert.equal((await read(env, go_actor.token, blob_id)).status, 200);

    await go_off(env);
    const before = state_signature(env.db);
    const begins = env.begin_count();
    for (let i = 0; i < 3; i += 1) {
      const res = await read(env, go_actor.token, blob_id);
      const error = assert_error(res, 403, "policy_denied");
      assert.equal(error.retryable, false);
      assert.equal(res.headers["retry-after"], undefined);
      assert.equal(res.bytes, null, "no bytes leak with the denial");
    }
    assert.ok(env.begin_count() - begins <= 3, "one attempt per request, no server-side repeats");
    assert.equal(state_signature(env.db), before, "a denied read writes nothing");

    assert.equal((await read(env, "owner", blob_id)).status, 200);
    assert.equal((await read(env, external.token, blob_id)).status, 200);

    await set_policy(env.service, env.ctx("go-on"), { allow_opencode_go: true, reason: "합성: 다시 켜기" });
    assert.equal((await read(env, go_actor.token, blob_id)).status, 200);
  });
});

test("Go OFF denial comes before the file lookup: an unknown blob is also 403 for the Go-bound actor", async () => {
  await with_api(async (env) => {
    const go_actor = await make_agent(env, "go", undefined, "internal_ai");
    await go_off(env);
    assert_error(await read(env, go_actor.token, "no-such-blob"), 403, "policy_denied");
  });
});

test("a policy_denied answer is final: the same request repeated is denied again with identical bodies, and nothing runs in between", async () => {
  await with_api(async (env) => {
    const go_actor = await make_agent(env, "go", undefined, "internal_ai");
    const blob_id = await ready_blob(env, "owner", bytes_of("final", 10));
    await go_off(env);
    const first = await read(env, go_actor.token, blob_id);
    const second = await read(env, go_actor.token, blob_id);
    const a = assert_error(first, 403, "policy_denied");
    const b = assert_error(second, 403, "policy_denied");
    assert.deepEqual({ ...a }, { ...b });
    assert.equal(a.retryable, false);
    assert.ok(a.next_action === null || !/retry|again/i.test(String(a.next_action)), "no retry instruction");
  });
});

test("a Go OFF denial is not replayed from an old success: policy is checked before the receipt lookup", async () => {
  await with_api(async (env) => {
    const go_actor = await make_agent(env, "go", undefined, "internal_ai");
    const body = { mode: "A", runtime: "builtin", provider: "opencode-go", model: "opencode-go/deepseek-v4.1-flash" };
    const ok = await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: go_actor.token }, key: "go-claim", body });
    assert_ok(ok);
    await go_off(env);
    const replay = await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: go_actor.token }, key: "go-claim", body });
    assert_error(replay, 403, "policy_denied");
  });
});

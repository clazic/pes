/**
 * SEL-115 (3단계 MAT1a) — 내 자료 올리기 `file.upload`(POST P/materials)·자료 목록·`file_preview`(GET P/files/{b}/preview)
 * (tester, 작성 모드). 인터페이스 표는 tests/helpers/sel115_env.ts 머리말. 글자 추출(SEL-116)·화면(SEL-117)은 범위 밖.
 * 합성 파일만. 이미 있는 동작(예약→PUT→complete)은 helper 로 재사용한다.
 */

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

import { OPENAPI_PATH, assert_error, assert_ok, call, make_agent, with_api } from "./helpers/api_env.ts";
import { bytes_of, put_ready, second_project } from "./helpers/blob_env.ts";
import { sha256_hex } from "./helpers/backup_fixture.ts";
import { state_signature } from "./helpers/state_signature.ts";
import {
  P,
  count,
  events_of,
  http_blob,
  new_material,
  policy_rows,
  set_access,
  text_bytes,
  upload_material,
  wire_of,
} from "./helpers/sel115_env.ts";

// ---------------------------------------------------------------------------
// 1. 올리기: 정책·연결·hash/크기/형식·원본 보존

test("upload: the material is a file-source object, the blob gets ONE allow policy (rev 1) linked from version_files, hash/size/type/name recorded", async () => {
  await with_api(async (env) => {
    const m = await new_material(env, "basic", { media_type: "text/csv", name: "합성표.csv" });
    const d = m.data;
    assert.equal(typeof d.object_id, "string");
    assert.equal(typeof d.version_id, "string");
    assert.equal(d.version_no, 1);
    assert.equal(d.blob_id, m.blob.blob_id);
    assert.equal(d.role, "attachment", "role defaults to attachment");
    assert.equal(d.ai_access, "allow", "the default is allow");
    assert.equal(d.sha256, sha256_hex(m.bytes));
    assert.equal(d.size, m.bytes.byteLength);
    assert.equal(d.media_type, "text/csv");
    assert.equal(d.original_name, "합성표.csv");

    const policies = policy_rows(env.db, env.p.project_id);
    assert.equal(policies.length, 1, "exactly one policy for the blob");
    assert.equal(policies[0]!.blob_id, m.blob.blob_id);
    assert.equal(policies[0]!.ai_access, "allow");
    assert.equal(policies[0]!.rev, 1n);
    assert.equal(policies[0]!.id, d.file_policy_id);

    const vf = env.db.all<{ version_id: string; blob_id: string; role: string; file_policy_id: string }>(
      "SELECT version_id, blob_id, role, file_policy_id FROM version_files WHERE blob_id = ?",
      m.blob.blob_id,
    );
    assert.deepEqual(vf.map((r) => ({ ...r })), [{ version_id: d.version_id, blob_id: m.blob.blob_id, role: "attachment", file_policy_id: d.file_policy_id }]);

    const obj = env.db.get<{ kind: string }>("SELECT kind FROM objects WHERE id = ?", d.object_id);
    assert.equal(obj?.kind, "source");
    const src = env.db.get<{ kind: string }>("SELECT kind FROM sources WHERE object_id = ?", d.object_id);
    assert.equal(src?.kind, "file", "a material is a source of kind file");
    const blob = env.db.get<{ sha256: string; size: bigint; media_type: string; original_name: string; state: string }>(
      "SELECT sha256, size, media_type, original_name, state FROM blobs WHERE id = ?",
      m.blob.blob_id,
    );
    assert.equal(blob?.sha256, d.sha256);
    assert.equal(Number(blob?.size), d.size);
    assert.equal(blob?.state, "ready");
  });
});

test("upload: the original bytes are kept untouched — the owner reads back exactly what was uploaded", async () => {
  await with_api(async (env) => {
    const m = await new_material(env, "orig");
    const got = await call(env, { method: "GET", path: P(env, `/files/${m.blob.blob_id}/content`), auth: "owner" });
    assert.equal(got.status, 200);
    assert.deepEqual(Buffer.from(got.bytes ?? new Uint8Array()), Buffer.from(m.bytes));
    // 같은 자료에 새 버전을 올려도 앞 원본 바이트는 그대로.
    const second = await http_blob(env, text_bytes("orig2", "MARK-orig2"), { name: "자료2.txt" });
    assert_ok(await upload_material(env, { blob_id: second.blob_id, object_id: m.data.object_id }), 201);
    const again = await call(env, { method: "GET", path: P(env, `/files/${m.blob.blob_id}/content`), auth: "owner" });
    assert.deepEqual(Buffer.from(again.bytes ?? new Uint8Array()), Buffer.from(m.bytes));
  });
});

test("upload: receipt + event are written once per upload, and the same key + body replays without new rows", async () => {
  await with_api(async (env) => {
    const blob = await http_blob(env, text_bytes("rc", "MARK-rc"));
    const body = { blob_id: blob.blob_id, title: "영수증 자료" };
    const first = await upload_material(env, body, "owner", "mat-key-1");
    const a = assert_ok(first, 201);
    assert.equal(first.json.replayed, false);
    const receipts = () =>
      Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM mutation_commits WHERE action = 'file.material_uploaded'")?.n ?? 0n);
    assert.equal(receipts(), 1);
    assert.equal(events_of(env.db, "file.material_uploaded").length, 1);
    const sig = state_signature(env.db);

    const again = await upload_material(env, body, "owner", "mat-key-1");
    const b = assert_ok(again, 201);
    assert.equal(again.json.replayed, true);
    assert.deepEqual(b, a, "the first answer, unchanged");
    assert.equal(receipts(), 1);
    assert.equal(state_signature(env.db), sig, "a replay writes nothing");

    assert_error(await upload_material(env, { ...body, title: "다른 제목" }, "owner", "mat-key-1"), 409, "idempotency_key_reuse");
    assert.equal(state_signature(env.db), sig, "a conflicting reuse of the key writes nothing");
  });
});

test("upload: the same bytes uploaded again → same blob, a new material, the SAME file policy (one policy row, two version_files)", async () => {
  await with_api(async (env) => {
    const m1 = await new_material(env, "dup", { marker: "MARK-dup", name: "복사본.txt" });
    const blob2 = await http_blob(env, m1.bytes, { name: "복사본.txt" });
    assert.equal(blob2.blob_id, m1.blob.blob_id, "reserve deduplicates identical bytes");
    const res = await upload_material(env, { blob_id: blob2.blob_id, title: "같은 내용 다시" });
    const d2 = assert_ok(res, 201);
    assert.notEqual(d2.object_id, m1.data.object_id, "a new material object");
    assert.notEqual(d2.version_id, m1.data.version_id);
    assert.equal(d2.file_policy_id, m1.data.file_policy_id, "same blob → same policy");
    assert.equal(policy_rows(env.db, env.p.project_id).length, 1);
    assert.equal(count(env.db, "version_files"), 2);
  });
});

test("upload: a deny on a blob stays when the same bytes are uploaded again (a re-upload cannot reset it to allow)", async () => {
  await with_api(async (env) => {
    const m1 = await new_material(env, "stay", { marker: "MARK-stay" });
    assert_ok(await set_access(env, m1.data.file_policy_id, "deny"));
    const blob2 = await http_blob(env, m1.bytes);
    const d2 = assert_ok(await upload_material(env, { blob_id: blob2.blob_id }), 201);
    assert.equal(d2.file_policy_id, m1.data.file_policy_id);
    assert.equal(d2.ai_access, "deny", "the new material inherits the blob's current deny, never resets it");
    assert.equal(policy_rows(env.db, env.p.project_id)[0]!.ai_access, "deny");
  });
});

test("upload: a new version of the same material (object_id) with other bytes → version_no 2, its own policy, the old version_files untouched", async () => {
  await with_api(async (env) => {
    const m = await new_material(env, "v1");
    const v2blob = await http_blob(env, text_bytes("v2", "MARK-v2"));
    const d = assert_ok(await upload_material(env, { blob_id: v2blob.blob_id, object_id: m.data.object_id }), 201);
    assert.equal(d.object_id, m.data.object_id);
    assert.equal(d.version_no, 2);
    assert.notEqual(d.version_id, m.data.version_id);
    assert.notEqual(d.file_policy_id, m.data.file_policy_id, "another blob → another policy");
    const old = env.db.all<{ blob_id: string }>("SELECT blob_id FROM version_files WHERE version_id = ?", m.data.version_id);
    assert.deepEqual(old.map((r) => r.blob_id), [m.blob.blob_id]);
    assert.equal(policy_rows(env.db, env.p.project_id).length, 2);
  });
});

test("upload: attaching the same blob to the same object/role twice is 409 and writes nothing", async () => {
  await with_api(async (env) => {
    const m = await new_material(env, "twice");
    const sig = state_signature(env.db);
    assert_error(await upload_material(env, { blob_id: m.blob.blob_id, object_id: m.data.object_id }), 409, "conflict");
    assert.equal(state_signature(env.db), sig);
  });
});

// ---------------------------------------------------------------------------
// 2. 검증·오류

test("upload: refusals — staging blob 409, unknown 404, another project's blob 404, bad payload 400; none writes anything", async () => {
  await with_api(async (env) => {
    const bytes = text_bytes("stage", "MARK-stage");
    const reserved = assert_ok(
      await call(env, {
        method: "POST",
        path: P(env, "/uploads"),
        auth: "owner",
        body: { sha256: sha256_hex(bytes), size: bytes.byteLength, media_type: "text/plain" },
      }),
      201,
    );
    const other = await second_project(env, "synthetic-sel115-b");
    const foreign = await put_ready(env, bytes_of("foreign", 30), "sel115-foreign", other);
    const ok = await http_blob(env, text_bytes("ok", "MARK-ok"));
    const sig = state_signature(env.db);

    assert_error(await upload_material(env, { blob_id: reserved.blob_id }), 409, "conflict");
    assert_error(await upload_material(env, { blob_id: "no-such-blob" }), 404, "not_found");
    assert_error(await upload_material(env, { blob_id: foreign.blob_id }), 404, "not_found");
    assert_error(await upload_material(env, {}), 400, "invalid_payload");
    assert_error(await upload_material(env, { blob_id: ok.blob_id, role: "executable" }), 400, "invalid_payload");
    assert_error(await upload_material(env, { blob_id: ok.blob_id, surprise: 1 }), 400, "invalid_payload");
    assert_error(await upload_material(env, { blob_id: ok.blob_id, object_id: "no-such-object" }), 404, "not_found");
    assert_error(await upload_material(env, { blob_id: ok.blob_id, title: 42 }), 400, "invalid_payload");
    assert.equal(state_signature(env.db), sig, "no refusal changes any state");
  });
});

test("upload: permissions — no credential 401; a token without file:write 403; a token WITH file:write may upload", async () => {
  await with_api(async (env) => {
    const blob = await http_blob(env, text_bytes("perm", "MARK-perm"));
    const reader = await make_agent(env, "reader", ["context:read", "file:read"]);
    const writer = await make_agent(env, "writer", ["file:write"]);
    const sig = state_signature(env.db);
    assert_error(await upload_material(env, { blob_id: blob.blob_id }, "none"), 401, "unauthenticated");
    assert_error(await upload_material(env, { blob_id: blob.blob_id }, { token: reader.token }), 403, "forbidden");
    assert.equal(state_signature(env.db), sig);
    assert_ok(await upload_material(env, { blob_id: blob.blob_id }, { token: writer.token }), 201);
  });
});

// ---------------------------------------------------------------------------
// 3. 자료 목록

test("materials list: the owner sees every material with name/type/size/hash and its ai_access; no credential 401, no context:read 403", async () => {
  await with_api(async (env) => {
    const a = await new_material(env, "la", { name: "가.txt" });
    const b = await new_material(env, "lb", { name: "나.txt" });
    assert_ok(await set_access(env, b.data.file_policy_id, "deny"));
    const list = assert_ok(await call(env, { method: "GET", path: P(env, "/materials"), auth: "owner" }));
    assert.ok(Array.isArray(list.materials));
    assert.equal(list.materials.length, 2);
    const by = new Map<string, any>(list.materials.map((x: any) => [x.file_policy_id, x]));
    assert.equal(by.get(a.data.file_policy_id).ai_access, "allow");
    assert.equal(by.get(b.data.file_policy_id).ai_access, "deny");
    for (const [m, x] of [[a, by.get(a.data.file_policy_id)], [b, by.get(b.data.file_policy_id)]] as const) {
      assert.equal(x.original_name, m.name);
      assert.equal(x.sha256, m.blob.sha256);
      assert.equal(x.size, m.bytes.byteLength);
      assert.equal(x.media_type, "text/plain");
      assert.equal(x.blob_id, m.blob.blob_id);
      assert.equal(x.object_id, m.data.object_id);
    }
    const noscope = await make_agent(env, "noscope", ["file:read"]);
    assert_error(await call(env, { method: "GET", path: P(env, "/materials"), auth: "none" }), 401, "unauthenticated");
    assert_error(await call(env, { method: "GET", path: P(env, "/materials"), auth: { token: noscope.token } }), 403, "forbidden");
  });
});

test("materials list: only the CURRENT version of a material is listed", async () => {
  await with_api(async (env) => {
    const m = await new_material(env, "cur1");
    const v2 = await http_blob(env, text_bytes("cur2", "MARK-cur2"));
    const d2 = assert_ok(await upload_material(env, { blob_id: v2.blob_id, object_id: m.data.object_id }), 201);
    const list = assert_ok(await call(env, { method: "GET", path: P(env, "/materials"), auth: "owner" }));
    assert.deepEqual(list.materials.map((x: any) => x.version_id), [d2.version_id]);
  });
});

// ---------------------------------------------------------------------------
// 4. file_preview

async function preview(env: any, blob_id: string, auth: any = "owner") {
  return call(env, { method: "GET", path: P(env, `/files/${blob_id}/preview`), auth });
}

test("preview: the owner gets the original bytes; text/plain is inline with nosniff and no sandbox needed", async () => {
  await with_api(async (env) => {
    const m = await new_material(env, "pv");
    const res = await preview(env, m.blob.blob_id);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(res.bytes ?? new Uint8Array()), Buffer.from(m.bytes));
    assert.match(res.headers["content-type"] ?? "", /^text\/plain/);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.match(res.headers["content-disposition"] ?? "", /^inline/);
    assert.equal(res.headers["content-security-policy"], undefined, "a plain text type needs no document sandbox");
  });
});

const PREVIEW_CASES: Array<[string, string, RegExp, boolean]> = [
  ["text/html", "<html><script>alert(1)</script></html>", /^attachment/, true],
  ["image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>", /^attachment/, true],
  ["application/xhtml+xml", "<html xmlns='http://www.w3.org/1999/xhtml'/>", /^attachment/, true],
  ["application/pdf", "%PDF-1.4 synthetic", /^inline/, false],
  ["application/octet-stream", "raw-synthetic", /^attachment/, false],
];

for (const [media_type, body, disposition, sandboxed] of PREVIEW_CASES) {
  test(`preview: ${media_type} is served safely — nosniff, ${sandboxed ? "document sandbox" : "no sandbox"}, ${disposition.source.slice(1)} — and equals the content route's judgement`, async () => {
    await with_api(async (env) => {
      const bytes = new TextEncoder().encode(`${body} ${media_type}`);
      const blob = await http_blob(env, bytes, { media_type, name: "안전.bin" });
      assert_ok(await upload_material(env, { blob_id: blob.blob_id }), 201);
      const res = await preview(env, blob.blob_id);
      assert.equal(res.status, 200);
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.match(res.headers["content-disposition"] ?? "", disposition);
      const csp = res.headers["content-security-policy"] ?? "";
      if (sandboxed) {
        assert.match(csp, /sandbox/);
        assert.ok(!/allow-same-origin/.test(csp), "an opaque origin: allow-same-origin is never granted");
      } else {
        assert.equal(csp, "");
      }
      const content = await call(env, { method: "GET", path: P(env, `/files/${blob.blob_id}/content`), auth: "owner" });
      assert.equal(content.headers["content-security-policy"] ?? "", csp, "preview reuses the content route's sandbox judgement");
      assert.equal(content.headers["x-content-type-options"], res.headers["x-content-type-options"]);
    });
  });
}

test("preview: refusals — no credential 401, no file:read 403, unknown 404, another project's blob 404, staging 409, tampered bytes 409", async () => {
  await with_api(async (env) => {
    const m = await new_material(env, "pvx");
    const noscope = await make_agent(env, "noread", ["context:read"]);
    const other = await second_project(env, "synthetic-sel115-c");
    const foreign = await put_ready(env, bytes_of("foreign-pv", 30), "sel115-foreign-pv", other);
    const bytes = text_bytes("pvstage", "MARK-pvstage");
    const staged = assert_ok(
      await call(env, {
        method: "POST",
        path: P(env, "/uploads"),
        auth: "owner",
        body: { sha256: sha256_hex(bytes), size: bytes.byteLength, media_type: "text/plain" },
      }),
      201,
    );
    assert_error(await preview(env, m.blob.blob_id, "none"), 401, "unauthenticated");
    assert_error(await preview(env, m.blob.blob_id, { token: noscope.token }), 403, "forbidden");
    assert_error(await preview(env, "no-such-blob"), 404, "not_found");
    assert_error(await preview(env, foreign.blob_id), 404, "not_found");
    assert_error(await preview(env, staged.blob_id), 409, "conflict");
    const key = env.db.get<{ storage_key: string }>("SELECT storage_key FROM blobs WHERE id = ?", m.blob.blob_id)!.storage_key;
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    writeFileSync(join(env.objects, ...key.split("/")), new TextEncoder().encode("tampered bytes"));
    const res = await preview(env, m.blob.blob_id);
    assert_error(res, 409, "conflict");
    assert.equal(res.bytes, null, "tampered bytes are never served");
  });
});

// ---------------------------------------------------------------------------
// 5. 문서 동기화

test("OpenAPI documents the new MAT1a routes", () => {
  const yaml = readFileSync(OPENAPI_PATH, "utf8");
  for (const path of [
    "/api/v1/projects/{id}/materials:",
    "/api/v1/projects/{id}/file-policies/{fp}/ai-access:",
    "/api/v1/projects/{id}/files/{b}/preview:",
  ]) {
    assert.ok(yaml.includes(path), `OpenAPI has ${path}`);
  }
});

test("a wire dump of a success never carries the object-store path of the blob", async () => {
  await with_api(async (env) => {
    const m = await new_material(env, "nopath");
    const res = await upload_material(env, { blob_id: (await http_blob(env, text_bytes("np2", "MARK-np2"))).blob_id });
    assert.ok(!wire_of(res).includes(env.objects), "no storage path in a response");
    assert.ok(!wire_of(res).includes("storage_key"));
    void m;
  });
});

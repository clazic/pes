/**
 * SEL-116 (3단계 MAT1b) — `file.extract`(POST P/file-extractions) 명령 계약 (tester, 작성 모드).
 * 인터페이스 표: tests/helpers/sel116_env.ts 머리말 (선행 SEL-115 표 포함).
 *
 * 권한·멱등·영수증·사건, file_extractions 행(원본 정책·추출본 정책 연결), 추출본의 blob·정책,
 * **원본의 AI 참조 스위치를 따른다**(원본 deny → 추출본도 에이전트에게 비노출, allow 로 되돌리면 같이).
 * 글자를 뽑는 형식별 규칙은 test_sel116_formats, 미지원·손상·상한은 test_sel116_limits.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { assert_error, assert_ok, call, make_agent, with_api } from "./helpers/api_env.ts";
import { put_ready, second_project } from "./helpers/blob_env.ts";
import { sha256_hex } from "./helpers/backup_fixture.ts";
import { state_signature } from "./helpers/state_signature.ts";
import {
  P,
  agent_sweep,
  count,
  events_of,
  extract,
  extracted,
  extraction_rows,
  http_blob,
  material_of,
  receipts_of,
  set_access,
  text_of,
  upload_material,
} from "./helpers/sel116_env.ts";

const BODY = "첫 줄 합성 문장\n둘째 줄 MARK-cmd-91c2\n";
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
// leader 승인(SEL-116): 글자가 원본과 바이트까지 같으면 새 blob·정책이 없다(blob 하나에 정책 하나). 아래 시험은 "다른 내용이면 별도 blob·정책"을
// 시험하므로 올리는 원본에 CRLF 를 넣어 바이트가 달라지게 한다(추출 글자는 LF 로 정리돼 BODY 그대로).
const crlf = (s: string): Uint8Array => bytes(s.replace(/\n/g, "\r\n"));

const policy_of = (env: any, id: string) =>
  env.db.get(
    "SELECT id, blob_id, ai_access, rev FROM file_policies WHERE id = ?",
    id,
  ) as { id: string; blob_id: string; ai_access: string; rev: bigint } | undefined;

// ---------------------------------------------------------------------------
// 1. 정상: 결과·DB 행·추출본 blob·정책·영수증·사건

test("extract txt: result, file_extractions row (source policy + its OWN text policy), text blob/policy, receipt and event", async () => {
  await with_api(async (env) => {
    const { m, r } = await extracted(env, "합성메모.txt", crlf(BODY));
    assert.equal(r.status, "extracted");
    assert.equal(r.version_id, m.data.version_id);
    assert.equal(r.blob_id, m.blob.blob_id);
    assert.equal(r.source_file_policy_id, m.data.file_policy_id);
    assert.equal(r.source_format, "txt");
    assert.equal(typeof r.extractor, "string");
    assert.ok(r.extractor.length > 0);
    assert.equal(typeof r.extractor_version, "string");
    assert.ok(r.extractor_version.length > 0);
    assert.equal(r.changed, true);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.reason, null);

    // 추출본은 새 blob·새 정책: 원본과 다른 id.
    assert.notEqual(r.text_blob_id, m.blob.blob_id);
    assert.notEqual(r.text_file_policy_id, m.data.file_policy_id);
    const text = await text_of(env, r);
    assert.equal(text, BODY);
    assert.equal(r.text_hash, sha256_hex(bytes(BODY)));

    const tb = env.db.get<{ sha256: string; size: bigint; media_type: string; original_name: string; state: string }>(
      "SELECT sha256, size, media_type, original_name, state FROM blobs WHERE id = ?",
      r.text_blob_id,
    );
    assert.equal(tb?.state, "ready");
    assert.equal(tb?.sha256, r.text_hash);
    assert.equal(Number(tb?.size), bytes(BODY).byteLength);
    assert.ok(tb?.media_type.startsWith("text/plain"), `media_type ${tb?.media_type}`);
    assert.ok(tb?.original_name?.endsWith(".txt") && tb.original_name.includes("합성메모"), `name ${tb?.original_name}`);

    const tp = policy_of(env, r.text_file_policy_id);
    assert.equal(tp?.blob_id, r.text_blob_id, "the text policy belongs to the text blob");
    assert.equal(tp?.ai_access, "allow");
    assert.equal(tp?.rev, 1n);

    const rows = extraction_rows(env.db, env.p.project_id);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.id, r.extraction_id);
    assert.equal(row.version_id, m.data.version_id);
    assert.equal(row.blob_id, m.blob.blob_id);
    assert.equal(row.source_file_policy_id, m.data.file_policy_id);
    assert.equal(row.text_blob_id, r.text_blob_id);
    assert.equal(row.text_file_policy_id, r.text_file_policy_id);
    assert.equal(row.text_hash, r.text_hash);
    assert.equal(row.status, "ready");
    assert.equal(row.source_format, "txt");
    assert.equal(row.warnings_json, "[]");
    assert.equal(Number(row.table_count ?? -1), 0);

    assert.equal(receipts_of(env.db, "file.extracted"), 1);
    assert.equal(events_of(env.db, "file.extracted").length, 1);
  });
});

test("extract: the original material is untouched (bytes, version_files, source policy rev) — nothing is overwritten", async () => {
  await with_api(async (env) => {
    const { m, r } = await extracted(env, "원본보존.txt", bytes(BODY));
    const got = await call(env, { method: "GET", path: P(env, `/files/${m.blob.blob_id}/content`), auth: "owner" });
    assert.deepEqual(Buffer.from(got.bytes ?? new Uint8Array()), Buffer.from(m.bytes));
    const vf = env.db.all<{ blob_id: string }>("SELECT blob_id FROM version_files WHERE version_id = ?", m.data.version_id);
    assert.deepEqual(vf.map((x) => x.blob_id), [m.blob.blob_id], "the extracted text is NOT swapped into the version's files");
    const sp = policy_of(env, m.data.file_policy_id);
    assert.equal(sp?.rev, 1n, "the source policy did not change");
    assert.ok(r.text_blob_id);
  });
});

test("extract: the event carries no text, no original name, no blob id of the original — it is readable through /changes", async () => {
  await with_api(async (env) => {
    const { m, r } = await extracted(env, "사건본문.txt", bytes("SECRET-EVENT-TEXT-5d1e\n"));
    const payloads = events_of(env.db, "file.extracted").map((e) => e.payload);
    assert.equal(payloads.length, 1);
    const p = payloads[0]!;
    assert.ok(!p.includes("SECRET-EVENT-TEXT-5d1e"), "no extracted text in the event");
    assert.ok(!p.includes("사건본문"), "no original name in the event");
    assert.ok(!p.includes(m.blob.blob_id) && !p.includes(r.text_blob_id), "no blob id in the event");
    assert.ok(p.includes(r.extraction_id) && p.includes("extracted"), "the extraction id and status are enough");
  });
});

test("identical bytes: a txt with no BOM and no CRLF is its own text — text_blob_id / text_file_policy_id point at the source blob and policy, no new blob, still idempotent", async () => {
  await with_api(async (env) => {
    const m = await material_of(env, "같은바이트.txt", bytes(BODY));
    const blobs = count(env.db, "blobs");
    const policies = count(env.db, "file_policies");
    const r = assert_ok(await extract(env, m), 201);
    assert.equal(r.status, "extracted");
    assert.equal(r.text_blob_id, m.blob.blob_id);
    assert.equal(r.text_file_policy_id, m.data.file_policy_id);
    assert.equal(r.text_hash, m.blob.sha256);
    assert.equal(count(env.db, "blobs"), blobs, "no second blob can hold the same bytes");
    assert.equal(count(env.db, "file_policies"), policies);
    const row = extraction_rows(env.db, env.p.project_id)[0]!;
    assert.equal(row.text_blob_id, m.blob.blob_id);
    assert.equal(row.text_file_policy_id, m.data.file_policy_id);
    assert.equal(row.source_file_policy_id, m.data.file_policy_id);
    assert.equal(await text_of(env, r), BODY);

    const sig = state_signature(env.db);
    const again = assert_ok(await extract(env, m), 201);
    assert.equal(again.changed, false);
    assert.equal(again.extraction_id, r.extraction_id);
    assert.equal(state_signature(env.db), sig, "asking again writes nothing");

    // 정책이 하나이므로 원본 스위치가 곧 텍스트 스위치다(읽기 판정: 원본 allow AND 텍스트 allow = 그 정책).
    const agent = await make_agent(env, "reader", ["context:read", "file:read"]);
    assert_ok(await set_access(env, m.data.file_policy_id, "deny"));
    assert.equal((await call(env, { method: "GET", path: P(env, `/files/${r.text_blob_id}/content`), auth: { token: agent.token } })).status, 403);
    assert_ok(await set_access(env, m.data.file_policy_id, "allow"));
    assert.equal((await call(env, { method: "GET", path: P(env, `/files/${r.text_blob_id}/content`), auth: { token: agent.token } })).status, 200);
  });
});

// ---------------------------------------------------------------------------
// 2. 멱등

test("idempotency: same key + body replays the first answer and writes nothing; same key + other body is 409", async () => {
  await with_api(async (env) => {
    const m = await material_of(env, "멱등.txt", bytes(BODY));
    const first = await extract(env, m, "owner", "ext-key-1");
    const a = assert_ok(first, 201);
    assert.equal(first.json.replayed, false);
    const sig = state_signature(env.db);

    const again = await extract(env, m, "owner", "ext-key-1");
    assert.equal(again.json.replayed, true);
    assert.deepEqual(assert_ok(again, 201), a);
    assert.equal(state_signature(env.db), sig, "a replay writes nothing");

    const other = await material_of(env, "다른.txt", bytes("다른 글자\n"));
    const sig_before_clash = state_signature(env.db); // 준비 오류 수정(leader 승인 대상): 다른 자료를 올린 뒤의 상태와 비교한다
    const clash = await call(env, {
      method: "POST",
      path: P(env, "/file-extractions"),
      auth: "owner",
      key: "ext-key-1",
      body: { version_id: other.data.version_id, blob_id: other.blob.blob_id },
    });
    assert_error(clash, 409, "idempotency_key_reuse"); // 준비 오류 수정(leader 승인 대상): 같은 키·다른 본문의 코드는 SEL-115 와 같다
    assert.equal(state_signature(env.db), sig_before_clash);
  });
});

test("idempotency: extracting the SAME version/blob again with a NEW key creates no row, blob, policy, receipt or event; changed:false, same ids", async () => {
  await with_api(async (env) => {
    const m = await material_of(env, "두번.txt", crlf(BODY));
    const a = assert_ok(await extract(env, m), 201);
    const sig = state_signature(env.db);
    const b = assert_ok(await extract(env, m), 201);
    assert.equal(b.changed, false);
    assert.equal(b.extraction_id, a.extraction_id);
    assert.equal(b.text_blob_id, a.text_blob_id);
    assert.equal(b.text_file_policy_id, a.text_file_policy_id);
    assert.equal(extraction_rows(env.db, env.p.project_id).length, 1);
    assert.equal(receipts_of(env.db, "file.extracted"), 1);
    assert.equal(events_of(env.db, "file.extracted").length, 1);
    assert.equal(count(env.db, "blobs"), 2);
    assert.equal(state_signature(env.db), sig, "nothing changed");
  });
});

test("the same bytes attached to two materials: two extractions, ONE text blob and ONE text policy (a blob has one policy)", async () => {
  await with_api(async (env) => {
    const m1 = await material_of(env, "쌍둥이.txt", crlf(BODY));
    const m2 = await material_of(env, "쌍둥이.txt", crlf(BODY));
    assert.equal(m2.blob.blob_id, m1.blob.blob_id);
    assert.notEqual(m2.data.version_id, m1.data.version_id);
    const a = assert_ok(await extract(env, m1), 201);
    const b = assert_ok(await extract(env, m2), 201);
    assert.notEqual(a.extraction_id, b.extraction_id, "one extraction per version/blob");
    assert.equal(a.text_blob_id, b.text_blob_id);
    assert.equal(a.text_file_policy_id, b.text_file_policy_id);
    assert.equal(extraction_rows(env.db, env.p.project_id).length, 2);
  });
});

// ---------------------------------------------------------------------------
// 3. 권한·입력 검사

test("auth: no credential 401; a token without file:write 403; a token with file:write works; none of the refusals writes", async () => {
  await with_api(async (env) => {
    const m = await material_of(env, "권한.txt", bytes(BODY));
    const weak = await make_agent(env, "weak", ["context:read", "file:read"]);
    const writer = await make_agent(env, "writer", ["context:read", "file:read", "file:write"]);
    const sig = state_signature(env.db);
    assert_error(await extract(env, m, "none"), 401, "unauthenticated");
    assert_error(await extract(env, m, { token: weak.token }), 403, "forbidden");
    assert.equal(state_signature(env.db), sig, "refusals write nothing");
    const ok = assert_ok(await extract(env, m, { token: writer.token }), 201);
    assert.equal(ok.status, "extracted");
    assert.equal(receipts_of(env.db, "file.extracted"), 1);
  });
});

test("input: bad payloads are 400 invalid_payload, unknown/foreign targets are 404, and nothing is written", async () => {
  await with_api(async (env) => {
    const m = await material_of(env, "입력.txt", bytes(BODY));
    const other_material = await material_of(env, "다른자료.txt", bytes("다른 자료 글자\n"));
    const p2 = await second_project(env);
    const foreign = await put_ready(env, bytes("남의 프로젝트\n"), "sel116-foreign", p2);
    const sig = state_signature(env.db);
    const post = (body: unknown) => call(env, { method: "POST", path: P(env, "/file-extractions"), auth: "owner", body });

    for (const bad of [{}, { version_id: m.data.version_id }, { blob_id: m.blob.blob_id }, { version_id: 7, blob_id: m.blob.blob_id }, { version_id: m.data.version_id, blob_id: m.blob.blob_id, surprise: 1 }]) {
      assert_error(await post(bad), 400, "invalid_payload");
    }
    assert_error(await post({ version_id: "no-such-version", blob_id: m.blob.blob_id }), 404, "not_found");
    assert_error(await post({ version_id: m.data.version_id, blob_id: "no-such-blob" }), 404, "not_found");
    assert_error(await post({ version_id: m.data.version_id, blob_id: other_material.blob.blob_id }), 404, "not_found");
    assert_error(await post({ version_id: m.data.version_id, blob_id: foreign.blob_id }), 404, "not_found");
    assert.equal(state_signature(env.db), sig);
    assert.equal(extraction_rows(env.db, env.p.project_id).length, 0);
  });
});

// ---------------------------------------------------------------------------
// 4. 원본의 AI 참조 스위치를 따른다

type Surfaces = Array<[string, string]>;

function text_paths(env: any, m: any, r: any): Surfaces {
  return [
    ["context", P(env, "/context")],
    ["materials", P(env, "/materials")],
    ["workspace", P(env, "/workspace")],
    ["changes", P(env, "/changes?limit=100")],
    ["source-content", P(env, `/files/${m.blob.blob_id}/content`)],
    ["text-content", P(env, `/files/${r.text_blob_id}/content`)],
    ["text-preview", P(env, `/files/${r.text_blob_id}/preview`)],
  ];
}

function assert_no_text_trace(text: string, m: any, r: any, marker: string, where: string): void {
  for (const needle of [m.blob.blob_id, m.data.file_policy_id, m.blob.sha256, m.name, marker, r.text_blob_id, r.text_file_policy_id, r.text_hash, r.extraction_id]) {
    assert.ok(!text.includes(needle), `${where}: "${needle}" must not appear`);
  }
}

for (const kind of ["external_agent", "internal_ai"] as const) {
  test(`switch (${kind}): source deny → the extracted text, its ids/hash and the extraction vanish for the agent everywhere; allow brings them back`, async () => {
    await with_api(async (env) => {
      const marker = `SECRET-EXTRACT-${kind}`;
      const { m, r } = await extracted(env, `비공개-${kind}.txt`, bytes(`본문 ${marker}\n`));
      const agent = await make_agent(env, "reader", ["context:read", "file:read"], kind);

      let sweep = await agent_sweep(env, agent.token, text_paths(env, m, r));
      assert.equal(sweep.statuses["text-content"], 200, "allowed by default");
      assert.equal(sweep.statuses["text-preview"], 200);
      assert.ok(sweep.text.includes(marker), "before deny the agent reads the text");
      const listed = assert_ok(await call(env, { method: "GET", path: P(env, "/materials"), auth: { token: agent.token } }));
      assert.equal(listed.materials[0].extraction_status, "extracted");
      assert.equal(listed.materials[0].extraction.text_blob_id, r.text_blob_id);

      assert_ok(await set_access(env, m.data.file_policy_id, "deny"));
      sweep = await agent_sweep(env, agent.token, text_paths(env, m, r));
      assert_no_text_trace(sweep.text, m, r, marker, "agent sweep after source deny");
      assert.equal(sweep.statuses["source-content"], 403);
      assert.equal(sweep.statuses["text-content"], 403, "the text blob is blocked because its SOURCE is denied (stricter side wins)");
      assert.equal(sweep.statuses["text-preview"], 403);
      for (const label of ["context", "materials", "workspace", "changes"]) {
        assert.equal(sweep.statuses[label], 200, `${label} stays readable without the denied file`);
      }
      const none = assert_ok(await call(env, { method: "GET", path: P(env, "/materials"), auth: { token: agent.token } }));
      assert.deepEqual(none.materials, [], "not even a count of the hidden material");

      // 사람은 늘 본다.
      const human = assert_ok(await call(env, { method: "GET", path: P(env, "/materials"), auth: "owner" }));
      assert.equal(human.materials.length, 1);
      assert.equal(human.materials[0].extraction_status, "extracted");
      assert.equal(await text_of(env, r), `본문 ${marker}\n`, "a person can still read the text");

      assert_ok(await set_access(env, m.data.file_policy_id, "allow"));
      sweep = await agent_sweep(env, agent.token, text_paths(env, m, r));
      assert.equal(sweep.statuses["text-content"], 200, "allow again → the text is served again");
      assert.equal(sweep.statuses["text-preview"], 200);
      assert.ok(sweep.text.includes(marker));
      assert.ok(sweep.text.includes(r.text_blob_id));
    });
  });
}

test("switch: extracting a source that is ALREADY denied works for the owner, the agent still sees nothing, and re-allowing shows the text", async () => {
  await with_api(async (env) => {
    const marker = "SECRET-PREDENIED-7ac9";
    const m = await material_of(env, "미리금지.txt", bytes(`본문 ${marker}\n`));
    assert_ok(await set_access(env, m.data.file_policy_id, "deny"));
    const agent = await make_agent(env, "reader", ["context:read", "file:read", "file:write"]);

    assert_error(await extract(env, m, { token: agent.token }), 403, "forbidden");
    assert.equal(extraction_rows(env.db, env.p.project_id).length, 0, "the agent's refused try wrote nothing");
    const r = assert_ok(await extract(env, m), 201);
    assert.equal(r.status, "extracted", "the owner may extract a denied file (a person reads it)");

    let sweep = await agent_sweep(env, agent.token, text_paths(env, m, r));
    assert_no_text_trace(sweep.text, m, r, marker, "agent sweep, extracted while denied");
    assert.equal(sweep.statuses["text-content"], 403);

    assert_ok(await set_access(env, m.data.file_policy_id, "allow"));
    sweep = await agent_sweep(env, agent.token, text_paths(env, m, r));
    assert.equal(sweep.statuses["text-content"], 200, "re-allowed source → the text becomes readable");
    assert.ok(sweep.text.includes(marker));
  });
});

test("strict side wins: the owner setting the TEXT policy to allow does not open a text whose source is denied", async () => {
  await with_api(async (env) => {
    const marker = "SECRET-STRICT-3be0";
    const { m, r } = await extracted(env, "엄격.txt", crlf(`본문 ${marker}\n`));
    const agent = await make_agent(env, "reader", ["context:read", "file:read"]);
    assert_ok(await set_access(env, m.data.file_policy_id, "deny"));
    assert_ok(await set_access(env, r.text_file_policy_id, "allow"));
    const sweep = await agent_sweep(env, agent.token, text_paths(env, m, r));
    assert_no_text_trace(sweep.text, m, r, marker, "source deny, text allow");
    assert.equal(sweep.statuses["text-content"], 403);
  });
});

test("strict side wins: the owner denying only the TEXT policy hides the text (the source stays readable) and the extraction shows status without text ids", async () => {
  await with_api(async (env) => {
    const marker = "SECRET-TEXTONLY-18df";
    const { m, r } = await extracted(env, "본문만금지.txt", crlf(`본문 ${marker}\n`));
    const agent = await make_agent(env, "reader", ["context:read", "file:read"]);
    assert_ok(await set_access(env, r.text_file_policy_id, "deny"));

    const sweep = await agent_sweep(env, agent.token, text_paths(env, m, r));
    assert.equal(sweep.statuses["source-content"], 200, "the original is still allowed");
    assert.equal(sweep.statuses["text-content"], 403);
    assert.equal(sweep.statuses["text-preview"], 403);
    for (const needle of [r.text_blob_id, r.text_file_policy_id, r.text_hash]) {
      assert.ok(!sweep.text.includes(needle), `"${needle}" must not appear`);
    }
    // 준비 오류 수정(leader 승인 대상): 허용된 원본 본문에는 표식이 있다 — 글자 표면(text-content·text-preview)에만 표식이 없어야 한다.
    const text_only = await agent_sweep(env, agent.token, [["text-content", P(env, `/files/${r.text_blob_id}/content`)], ["text-preview", P(env, `/files/${r.text_blob_id}/preview`)]]);
    assert.ok(!text_only.text.includes(marker), "no marker on the text surfaces");
    const listed = assert_ok(await call(env, { method: "GET", path: P(env, "/materials"), auth: { token: agent.token } }));
    assert.equal(listed.materials.length, 1);
    assert.equal(listed.materials[0].extraction_status, "extracted", "the status is honest");
    assert.equal(listed.materials[0].extraction.text_blob_id, null);
    assert.equal(listed.materials[0].extraction.text_file_policy_id, null);
    assert.equal(listed.materials[0].extraction.text_hash, null);

    const human = assert_ok(await call(env, { method: "GET", path: P(env, "/materials"), auth: "owner" }));
    assert.equal(human.materials[0].extraction.text_blob_id, r.text_blob_id);
    assert.equal(human.materials[0].extraction.text_ai_access, "deny");
  });
});

test("the owner's own TEXT deny survives the source switch going deny → allow (the source switch never overwrites it)", async () => {
  await with_api(async (env) => {
    const marker = "SECRET-SURVIVE-4410";
    const { m, r } = await extracted(env, "유지.txt", crlf(`본문 ${marker}\n`));
    const agent = await make_agent(env, "reader", ["context:read", "file:read"]);
    assert_ok(await set_access(env, r.text_file_policy_id, "deny"));
    assert_ok(await set_access(env, m.data.file_policy_id, "deny"));
    assert_ok(await set_access(env, m.data.file_policy_id, "allow"));
    const sweep = await agent_sweep(env, agent.token, text_paths(env, m, r));
    assert.equal(sweep.statuses["source-content"], 200);
    assert.equal(sweep.statuses["text-content"], 403, "still hidden: the text policy was denied on its own");
    assert.equal(sweep.statuses["text-preview"], 403);
    assert.equal(policy_of(env, r.text_file_policy_id)?.ai_access, "deny");
  });
});

// ---------------------------------------------------------------------------
// 5. 읽기 응답의 추출 상태 칸

test("read: GET /materials has extraction_status on every item — not_extracted before, extracted after; extraction is null before", async () => {
  await with_api(async (env) => {
    const a = await material_of(env, "읽기a.txt", bytes("a 글자\n"));
    const b = await material_of(env, "읽기b.txt", bytes("b 글자\n"));
    let list = assert_ok(await call(env, { method: "GET", path: P(env, "/materials"), auth: "owner" })).materials as any[];
    assert.equal(list.length, 2);
    for (const x of list) {
      assert.equal(x.extraction_status, "not_extracted");
      assert.equal(x.extraction, null);
    }
    const r = assert_ok(await extract(env, a), 201);
    list = assert_ok(await call(env, { method: "GET", path: P(env, "/materials"), auth: "owner" })).materials as any[];
    const la = list.find((x) => x.object_id === a.data.object_id)!;
    const lb = list.find((x) => x.object_id === b.data.object_id)!;
    assert.equal(la.extraction_status, "extracted");
    assert.equal(la.extraction.extraction_id, r.extraction_id);
    assert.equal(la.extraction.status, "extracted");
    assert.equal(la.extraction.source_format, "txt");
    assert.equal(la.extraction.text_blob_id, r.text_blob_id);
    assert.equal(la.extraction.text_file_policy_id, r.text_file_policy_id);
    assert.equal(la.extraction.text_hash, r.text_hash);
    assert.equal(la.extraction.text_ai_access, "allow");
    assert.deepEqual(la.extraction.warnings, []);
    assert.equal(lb.extraction_status, "not_extracted");
  });
});

test("read: GET /context data.materials carries the same extraction_status as /materials", async () => {
  await with_api(async (env) => {
    const { m } = await extracted(env, "맥락.txt", bytes("맥락 글자\n"));
    const agent = await make_agent(env, "reader", ["context:read", "file:read"]);
    const ctx = assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: { token: agent.token } }));
    const mats = assert_ok(await call(env, { method: "GET", path: P(env, "/materials"), auth: { token: agent.token } })).materials;
    assert.deepEqual(ctx.materials, mats);
    assert.equal(ctx.materials[0].object_id, m.data.object_id);
    assert.equal(ctx.materials[0].extraction_status, "extracted");
  });
});

test("read: a new version of the material is its own extraction target — the list shows the CURRENT version's status", async () => {
  await with_api(async (env) => {
    const v1 = await material_of(env, "버전.txt", bytes("버전1 글자\n"));
    assert_ok(await extract(env, v1), 201);
    const b2 = await http_blob(env, bytes("버전2 글자\n"), { name: "버전.txt" });
    const v2 = assert_ok(await upload_material(env, { blob_id: b2.blob_id, object_id: v1.data.object_id }), 201);
    const list = assert_ok(await call(env, { method: "GET", path: P(env, "/materials"), auth: "owner" })).materials as any[];
    assert.equal(list.length, 1);
    assert.equal(list[0].version_no, 2);
    assert.equal(list[0].extraction_status, "not_extracted", "v2 has not been extracted yet — v1's result is not shown for it");
    const r2 = assert_ok(
      await call(env, { method: "POST", path: P(env, "/file-extractions"), auth: "owner", body: { version_id: v2.version_id, blob_id: b2.blob_id } }),
      201,
    );
    assert.equal(r2.status, "extracted");
    assert.equal(extraction_rows(env.db, env.p.project_id).length, 2, "v1's row is kept");
  });
});

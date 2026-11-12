/**
 * SEL-116 (3단계 MAT1b) — 추출 못 하는 경우를 정직하게 남긴다 (tester, 작성 모드). 인터페이스·형식별 결정: tests/helpers/sel116_env.ts 머리말.
 *
 * (4) hwp·doc·xls·ppt·pdf·모르는 형식 = unsupported(이유). 글자를 지어내지 않는다.
 * (5) 손상 파일 = failed, 너무 큰 파일·zip 폭탄 = failed(too_large). 일부만 돌려주지 않는다.
 * (6) 읽기 응답의 추출 상태 칸: extracted | partial | unsupported | failed | not_extracted.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { assert_ok, call, make_agent, with_api } from "./helpers/api_env.ts";
import { put_ready } from "./helpers/blob_env.ts";
import { state_signature } from "./helpers/state_signature.ts";
import {
  P,
  count,
  events_of,
  extract,
  extracted,
  extraction_rows,
  fake_legacy,
  fake_pdf,
  http_blob,
  make_docx,
  make_xlsx,
  make_zip,
  material_of,
  set_access,
  upload_material,
  wire_of,
} from "./helpers/sel116_env.ts";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const SQL_OR_STACK = /SELECT |INSERT |UPDATE |sqlite|node_modules|\.ts:\d|at \S+ \(/i;
const MIB = 1024 * 1024;

// ---------------------------------------------------------------------------
// unsupported: hwp doc xls ppt pdf, 모르는 형식

const LEGACY: Array<[string, string]> = [
  ["옛한글.hwp", "hwp"],
  ["옛워드.doc", "doc"],
  ["옛엑셀.xls", "xls"],
  ["옛발표.ppt", "ppt"],
  ["스캔본.pdf", "pdf"],
  ["이상한.xyz", "unknown"],
];

for (const [name, format] of LEGACY) {
  test(`unsupported (${name}): honest 'unsupported' with a reason — no text, no new blob, no new policy, text fields all null`, async () => {
    await with_api(async (env) => {
      const marker = `READABLE-ASCII-${format}-2e7b`;
      const data = format === "pdf" ? fake_pdf(marker) : fake_legacy(marker);
      const m = await material_of(env, name, data);
      const blobs = count(env.db, "blobs");
      const policies = count(env.db, "file_policies");

      const res = await extract(env, m);
      const r = assert_ok(res, 201);
      assert.equal(r.status, "unsupported");
      assert.equal(r.source_format, format);
      assert.equal(r.reason, "unsupported_format");
      assert.equal(r.text_blob_id, null);
      assert.equal(r.text_file_policy_id, null);
      assert.equal(r.text_hash, null);
      assert.ok(Array.isArray(r.warnings) && r.warnings.length >= 1, "a warning explains why");
      assert.equal(r.warnings[0].code, "unsupported_format");
      assert.ok(String(r.warnings[0].message).toLowerCase().includes(format === "unknown" ? "xyz" : format), "the message names the format");
      assert.ok(!wire_of(res).includes(marker), "the readable ASCII inside the file is NOT passed off as extracted text");

      assert.equal(count(env.db, "blobs"), blobs, "no blob is made for text that does not exist");
      assert.equal(count(env.db, "file_policies"), policies, "no text policy either");

      const row = extraction_rows(env.db, env.p.project_id)[0]!;
      assert.equal(row.status, "unsupported");
      assert.equal(row.source_format, format);
      assert.equal(row.source_file_policy_id, m.data.file_policy_id);
      assert.equal(row.text_blob_id, null);
      assert.equal(row.text_file_policy_id, null);
      assert.equal(row.text_hash, null);
      assert.ok(JSON.parse(row.warnings_json).length >= 1, "warnings_json is not empty");
      assert.equal(events_of(env.db, "file.extracted").length, 1, "the attempt is recorded once");

      const list = assert_ok(await call(env, { method: "GET", path: P(env, "/materials"), auth: "owner" })).materials as any[];
      assert.equal(list[0].extraction_status, "unsupported");
      assert.equal(list[0].extraction.text_blob_id, null);
      assert.ok(list[0].extraction.warnings.length >= 1, "the warning is not hidden from the list");
      assert.ok(!JSON.stringify(list).includes(marker));
    });
  });
}

test("unsupported: asking again is idempotent (no new row/receipt/event); an allowed agent sees the status and warning but never text ids", async () => {
  await with_api(async (env) => {
    const m = await material_of(env, "옛한글.hwp", fake_legacy("READABLE-ASCII-again"));
    assert_ok(await extract(env, m), 201);
    const sig = state_signature(env.db);
    const again = assert_ok(await extract(env, m), 201);
    assert.equal(again.changed, false);
    assert.equal(again.status, "unsupported");
    assert.equal(state_signature(env.db), sig);

    const agent = await make_agent(env, "reader", ["context:read", "file:read"]);
    const list = assert_ok(await call(env, { method: "GET", path: P(env, "/materials"), auth: { token: agent.token } })).materials as any[];
    assert.equal(list.length, 1);
    assert.equal(list[0].extraction_status, "unsupported");
    assert.ok(list[0].extraction.warnings.length >= 1);
    assert.equal(list[0].extraction.text_blob_id, null);
  });
});

test("unsupported: a denied legacy file shows the agent nothing at all (not even the unsupported status)", async () => {
  await with_api(async (env) => {
    const m = await material_of(env, "비공개옛.hwp", fake_legacy("READABLE-ASCII-denied"));
    const r = assert_ok(await extract(env, m), 201);
    assert_ok(await set_access(env, m.data.file_policy_id, "deny"));
    const agent = await make_agent(env, "reader", ["context:read", "file:read"]);
    const mats = await call(env, { method: "GET", path: P(env, "/materials"), auth: { token: agent.token } });
    assert.deepEqual(assert_ok(mats).materials, []);
    assert.ok(!wire_of(mats).includes(r.extraction_id));
    const ctx = await call(env, { method: "GET", path: P(env, "/context"), auth: { token: agent.token } });
    assert.ok(!wire_of(ctx).includes(r.extraction_id));
  });
});

// ---------------------------------------------------------------------------
// failed: 손상 파일

const good_docx = (): Uint8Array => make_docx(["멀쩡한 문단", [["가", "나"], ["1", "2"]]]);

const CORRUPT: Array<[string, string, () => Uint8Array, string]> = [
  ["not a zip at all", "가짜.docx", () => bytes("이것은 zip 이 아니라 그냥 글자입니다\n"), "invalid_container"],
  ["empty file named .docx", "빈.docx", () => new Uint8Array(), "invalid_container"],
  ["truncated zip (first half)", "잘림.docx", () => good_docx().slice(0, Math.floor(good_docx().length / 2)), "invalid_container"],
  ["zip bytes damaged in the middle", "깨진바이트.xlsx", () => {
    const z = make_xlsx([{ name: "시트", rows: [["가", "나"]] }]).slice();
    for (let i = 40; i < Math.min(z.length - 30, 120); i += 1) z[i] = z[i]! ^ 0xff;
    return z;
  }, "invalid_container"],
  ["valid zip without the main part", "본문없음.docx", () => make_zip([{ name: "word/other.xml", data: "<x/>" }]), "invalid_document"],
  ["main part is not well-formed XML", "엑스엠엘깨짐.docx", () => make_zip([{ name: "word/document.xml", data: "<w:document><w:body><w:p><w:t>끝없는" }]), "invalid_document"],
  ["xlsx without a workbook", "워크북없음.xlsx", () => make_zip([{ name: "xl/sharedStrings.xml", data: "<sst/>" }]), "invalid_document"],
  ["pptx with no slide", "슬라이드없음.pptx", () => make_zip([{ name: "ppt/presentation.xml", data: "<p:presentation/>" }]), "invalid_document"],
  ["hwpx without sections", "구역없음.hwpx", () => make_zip([{ name: "mimetype", data: "application/hwp+zip", method: "store" }]), "invalid_document"],
];

for (const [label, name, make, code] of CORRUPT) {
  test(`failed (${label}): status 'failed' / ${code}, no text or policy, a plain-language warning (no SQL or stack text), the list says failed`, async () => {
    await with_api(async (env) => {
      const m = await material_of(env, name, make());
      const blobs = count(env.db, "blobs");
      const policies = count(env.db, "file_policies");
      const res = await extract(env, m);
      const r = assert_ok(res, 201);
      assert.equal(r.status, "failed");
      assert.equal(r.reason, code);
      assert.ok(r.warnings.some((w: any) => w.code === code), JSON.stringify(r.warnings));
      assert.equal(r.text_blob_id, null);
      assert.equal(r.text_file_policy_id, null);
      assert.equal(r.text_hash, null);
      assert.equal(count(env.db, "blobs"), blobs);
      assert.equal(count(env.db, "file_policies"), policies);
      assert.doesNotMatch(wire_of(res), SQL_OR_STACK, "no internals in the answer");
      const row = extraction_rows(env.db, env.p.project_id)[0]!;
      assert.equal(row.status, "failed");
      assert.equal(row.text_blob_id, null);
      assert.ok(JSON.parse(row.warnings_json).length >= 1);
      const list = assert_ok(await call(env, { method: "GET", path: P(env, "/materials"), auth: "owner" })).materials as any[];
      assert.equal(list[0].extraction_status, "failed");
      assert.doesNotMatch(JSON.stringify(list), SQL_OR_STACK);
    });
  });
}

test("failed: the original upload survives a failed extraction (still readable, still allow, still one version)", async () => {
  await with_api(async (env) => {
    const data = bytes("zip 아님\n");
    const m = await material_of(env, "남는원본.docx", data);
    assert_ok(await extract(env, m), 201);
    const got = await call(env, { method: "GET", path: P(env, `/files/${m.blob.blob_id}/content`), auth: "owner" });
    assert.deepEqual(Buffer.from(got.bytes ?? new Uint8Array()), Buffer.from(data));
    assert.equal(env.db.get<{ ai_access: string }>("SELECT ai_access FROM file_policies WHERE id = ?", m.data.file_policy_id)?.ai_access, "allow");
  });
});

// ---------------------------------------------------------------------------
// 상한

test("limit: a source larger than 32 MiB is 'failed / too_large' — no text at all (never a cut-off prefix), no text blob, no policy", async () => {
  await with_api(async (env) => {
    const big = new Uint8Array(32 * MIB + 1).fill(0x61);
    const stored = await put_ready(env, big, "sel116-big");
    const up = assert_ok(await upload_material(env, { blob_id: stored.blob_id, title: "큰 글자" }), 201);
    const blobs = count(env.db, "blobs");
    const res = await call(env, {
      method: "POST",
      path: P(env, "/file-extractions"),
      auth: "owner",
      body: { version_id: up.version_id, blob_id: stored.blob_id },
    });
    const r = assert_ok(res, 201);
    assert.equal(r.status, "failed");
    assert.equal(r.reason, "too_large");
    assert.ok(r.warnings.some((w: any) => w.code === "too_large"));
    assert.equal(r.text_blob_id, null);
    assert.equal(count(env.db, "blobs"), blobs);
  });
});

test("limit: a source of 1 MiB is fine (the cap is not tiny)", async () => {
  await with_api(async (env) => {
    const text = "가나다라마바사\n".repeat(Math.ceil((1 * MIB) / 22));
    // 준비 오류 수정(leader 승인 대상): put_ready 의 이름은 "합성.bin"(모르는 형식)이라 글자로 읽히지 않는다 — .txt 이름으로 올린다.
    const stored = await http_blob(env, bytes(text), { name: "일메가.txt", media_type: "text/plain" });
    const up = assert_ok(await upload_material(env, { blob_id: stored.blob_id, title: "일 메가" }), 201);
    const r = assert_ok(
      await call(env, { method: "POST", path: P(env, "/file-extractions"), auth: "owner", body: { version_id: up.version_id, blob_id: stored.blob_id } }),
      201,
    );
    assert.equal(r.status, "extracted");
    const got = await call(env, { method: "GET", path: P(env, `/files/${r.text_blob_id}/content`), auth: "owner" });
    assert.equal(Buffer.from(got.bytes ?? new Uint8Array()).toString("utf8"), text);
  });
});

test("limit: a small zip that inflates past 64 MiB (zip bomb) is 'failed / too_large' and stops before finishing the inflate", async () => {
  await with_api(async (env) => {
    const head = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>폭탄 앞</w:t></w:r></w:p>';
    const filler = " ".repeat(80 * MIB);
    const xml = `${head}${filler}</w:body></w:document>`;
    const zip = make_zip([{ name: "word/document.xml", data: xml }]);
    assert.ok(zip.byteLength < 2 * MIB, `the bomb is small on disk (${zip.byteLength} bytes)`);
    const started = Date.now();
    const { r } = await extracted(env, "폭탄.docx", zip);
    assert.equal(r.status, "failed");
    assert.equal(r.reason, "too_large");
    assert.equal(r.text_blob_id, null);
    assert.ok(Date.now() - started < 20_000, "gave up quickly");
  });
});

test("limit: a zip whose header LIES about the unpacked size (claims 10 bytes, really 80 MiB) is refused too — the real size is what counts", async () => {
  await with_api(async (env) => {
    const filler = " ".repeat(80 * MIB);
    const zip = make_zip([
      { name: "word/document.xml", data: `<w:document><w:body><w:p><w:t>거짓말</w:t></w:p>${filler}</w:body></w:document>`, claimed_size: 10 },
    ]);
    const { r } = await extracted(env, "거짓헤더.docx", zip);
    assert.equal(r.status, "failed");
    assert.ok(["too_large", "invalid_container"].includes(r.reason), `reason ${r.reason}`);
    assert.equal(r.text_blob_id, null);
  });
});

test("limit: many modest parts that together pass 64 MiB are refused as a whole (the cap is on the total, not per part)", async () => {
  await with_api(async (env) => {
    const chunk = `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>조각</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>${" ".repeat(9 * MIB)}</p:sld>`;
    const parts = Array.from({ length: 8 }, (_v, i) => ({ name: `ppt/slides/slide${i + 1}.xml`, data: chunk }));
    const zip = make_zip(parts);
    const { r } = await extracted(env, "조각들.pptx", zip);
    assert.equal(r.status, "failed");
    assert.equal(r.reason, "too_large");
  });
});

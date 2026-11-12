/**
 * SEL-116 (3단계 MAT1b) — 1차 리뷰 R1 필수 5건 재현 시험 (mid-worker, 보안). 모두 합성 입력, 작은 zip 으로 빠르게.
 *
 *  1. 속성 읽기 정규식이 입력 길이에 선형이어야 한다 (이름 글자만 길게 이어지는 속성).
 *  2. 희소 xlsx(거대 행·열 번호) 가 출력을 폭증시키지 못한다 — 추출 글자 수 상한 MAX_TEXT_CHARS.
 *  3. 공유 문자열 재참조·중첩 표 증폭 + 잡히지 않는 예외(RangeError) 가 failed 기록으로 남는다.
 *  4. 펼친 합계 상한(64 MiB) 은 헤더가 아니라 실제 펼친 바이트로 판정한다 (거짓 크기 부품 다수).
 *  5. 닫힌(deny) 무관 blob 과 글자가 같아도 비사람 호출자 응답에 그 blob 의 id·정책 id·해시가 없다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { call, make_agent, with_api, type ApiEnv } from "./helpers/api_env.ts";
import { MAX_TEXT_CHARS, extract_text } from "../scripts/pes_core/file_extract.ts";
import { P, count, esc, extract, make_docx, make_pptx, make_zip, material_of, set_access, wire_of } from "./helpers/sel116_env.ts";

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MIB = 1024 * 1024;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

/** xlsx 한 시트를 손으로 만든다: sheet_xml 과 (있으면) 공유 문자열 목록. */
function raw_xlsx(sheet_xml: string, shared: string[] = []): Uint8Array {
  return make_zip([
    { name: "xl/workbook.xml", data: `${XML}<workbook xmlns:r="r"><sheets><sheet name="시트" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `${XML}<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    },
    { name: "xl/worksheets/sheet1.xml", data: `${XML}<worksheet><sheetData>${sheet_xml}</sheetData></worksheet>` },
    { name: "xl/sharedStrings.xml", data: `${XML}<sst>${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join("")}</sst>` },
  ]);
}

// ---------------------------------------------------------------------------
// 필수 1 — 정규식 선형

test("R1-1: a 200,000-character attribute name without '=' is rejected in linear time (docx)", () => {
  const evil = `<w:document><w:body><w:p ${"a".repeat(200_000)}><w:t>x</w:t></w:p></w:body></w:document>`;
  const zip = make_zip([{ name: "word/document.xml", data: evil }]);
  const { value, ms } = timed(() => extract_text("악성.docx", zip));
  assert.ok(ms < 300, `took ${ms.toFixed(0)} ms`);
  assert.equal(value.status, "failed");
  assert.equal(value.text, null);
});

test("R1-1: 200,000 characters of well-formed attributes are also handled in linear time", () => {
  const evil = `<w:document><w:body><w:p ${'a="1" '.repeat(34_000)}><w:t>x</w:t></w:p></w:body></w:document>`;
  const zip = make_zip([{ name: "word/document.xml", data: evil }]);
  const { value, ms } = timed(() => extract_text("속성많음.docx", zip));
  assert.ok(ms < 300, `took ${ms.toFixed(0)} ms`);
  assert.equal(value.status, "failed", "an absurd attribute count is not accepted");
});

test("R1-1: a long valid attribute value and ordinary attributes still parse", () => {
  const body = `<w:document><w:body><w:p w:rsidR="00AB12" w:x='single "q"' w:long="${"v".repeat(5000)}"><w:t>정상 문장</w:t></w:p></w:body></w:document>`;
  const out = extract_text("정상.docx", make_zip([{ name: "word/document.xml", data: body }]));
  assert.equal(out.status, "extracted");
  assert.equal(out.text, "정상 문장\n");
});

test("R1-1: an attribute name followed by garbage or a missing quote is still 'bad attribute' (docx fails, nothing invented)", () => {
  for (const attrs of ['a=1', 'a="1" junk', 'a="unterminated', '="x"', 'a = ']) {
    const body = `<w:document><w:body><w:p ${attrs}><w:t>x</w:t></w:p></w:body></w:document>`;
    const out = extract_text("깨짐.docx", make_zip([{ name: "word/document.xml", data: body }]));
    assert.equal(out.status, "failed", `attrs ${attrs}`);
    assert.equal(out.reason, "invalid_document");
  }
});

// ---------------------------------------------------------------------------
// 필수 2 — 희소 xlsx, 출력 글자 수 상한

test("R1-2: MAX_TEXT_CHARS is a real, bounded constant (not above the source limit)", () => {
  assert.ok(Number.isInteger(MAX_TEXT_CHARS) && MAX_TEXT_CHARS > 1 * MIB && MAX_TEXT_CHARS <= 32 * MIB, `MAX_TEXT_CHARS ${MAX_TEXT_CHARS}`);
});

test("R1-2: a few-hundred-byte sparse xlsx (XFD1 in every row) never yields text over the cap — failed/too_large, quickly", () => {
  const rows = Array.from({ length: 2000 }, (_v, i) => `<row r="${i + 1}"><c r="XFD${i + 1}"><v>1</v></c></row>`).join("");
  const zip = raw_xlsx(rows);
  assert.ok(zip.byteLength < 20_000, `zip ${zip.byteLength} bytes`);
  const { value, ms } = timed(() => extract_text("희소.xlsx", zip));
  assert.ok(ms < 5_000, `took ${ms.toFixed(0)} ms`);
  if (value.text !== null) assert.ok(value.text.length <= MAX_TEXT_CHARS, `text ${value.text.length} chars`);
  assert.equal(value.status, "failed");
  assert.equal(value.reason, "too_large");
  assert.equal(value.text, null, "no partial text is handed back");
});

test("R1-2: a sparse sheet with few rows stays small and every row has the same number of cells (R10)", () => {
  const xml =
    '<row r="1"><c r="A1" t="inlineStr"><is><t>머리</t></is></c><c r="C1" t="inlineStr"><is><t>끝</t></is></c></row>' +
    '<row r="2"><c r="A2"><v>7</v></c></row>';
  const out = extract_text("희소작음.xlsx", raw_xlsx(xml));
  assert.equal(out.status, "extracted");
  assert.equal(out.text, "## 시트\n| 머리 |  | 끝 |\n| --- | --- | --- |\n| 7 |  |  |\n");
});

test("R1-2: many rows that each hold one far-right cell are bounded by the cell/row limits, not by memory", () => {
  const rows = Array.from({ length: 6000 }, (_v, i) => `<row r="${i + 1}"><c r="Z${i + 1}"><v>1</v></c></row>`).join("");
  const { value, ms } = timed(() => extract_text("행많음.xlsx", raw_xlsx(rows)));
  assert.ok(ms < 5_000, `took ${ms.toFixed(0)} ms`);
  if (value.text !== null) assert.ok(value.text.length <= MAX_TEXT_CHARS);
});

// ---------------------------------------------------------------------------
// 필수 3 — 공유 문자열 재참조, 중첩 표, 잡히지 않는 예외

test("R1-3a: one huge shared string referenced by thousands of cells fails as too_large — it does not throw RangeError", () => {
  const cells = (r: number) => Array.from({ length: 26 }, (_v, c) => `<c r="${String.fromCharCode(65 + c)}${r}" t="s"><v>0</v></c>`).join("");
  const rows = Array.from({ length: 100 }, (_v, i) => `<row r="${i + 1}">${cells(i + 1)}</row>`).join("");
  const zip = raw_xlsx(rows, ["가".repeat(1_000_000)]);
  assert.ok(zip.byteLength < 20_000, `zip ${zip.byteLength} bytes`);
  let out: ReturnType<typeof extract_text> | undefined;
  assert.doesNotThrow(() => {
    out = extract_text("재참조.xlsx", zip);
  });
  assert.equal(out?.status, "failed");
  assert.equal(out?.reason, "too_large");
  assert.equal(out?.text, null);
});

function nested_tables(depth: number, cells_per_level: number): string {
  const empty_cells = '<w:tc><w:p/></w:tc>'.repeat(cells_per_level);
  let inner = "";
  for (let level = 0; level < depth; level += 1) {
    inner = `<w:tbl><w:tr>${empty_cells}<w:tc>${inner}<w:p/></w:tc></w:tr></w:tbl>`;
  }
  return `<w:document><w:body>${inner}</w:body></w:document>`;
}

test("R1-3b: nested tables cannot multiply the output — over the cap it is failed/too_large, within it the text respects the cap", () => {
  const zip = make_zip([{ name: "word/document.xml", data: nested_tables(100, 3000) }]);
  assert.ok(zip.byteLength < 60_000, `zip ${zip.byteLength} bytes`);
  const { value, ms } = timed(() => extract_text("중첩.docx", zip));
  assert.ok(ms < 8_000, `took ${ms.toFixed(0)} ms`);
  if (value.text !== null) assert.ok(value.text.length <= MAX_TEXT_CHARS, `text ${value.text.length} chars`);
  assert.equal(value.status, "failed");
  assert.equal(value.reason, "too_large");
});

test("R1-3b: an ordinary nested table (two levels) is still extracted", () => {
  const inner = '<w:tbl><w:tr><w:tc><w:p><w:t>안</w:t></w:p></w:tc></w:tr></w:tbl>';
  const doc = `<w:document><w:body><w:tbl><w:tr><w:tc><w:p><w:t>겉</w:t></w:p>${inner}</w:tc></w:tr></w:tbl></w:body></w:document>`;
  const out = extract_text("이중.docx", make_zip([{ name: "word/document.xml", data: doc }]));
  assert.equal(out.status, "extracted");
  assert.equal(out.table_count, 2);
  assert.ok(out.text?.includes("겉") && out.text.includes("안"));
});

test("R1-3c: whatever goes wrong inside the extractor becomes a failed record (extract_error), never an exception", () => {
  // A non-ExtractFailure error from deep inside: a Buffer-too-large style RangeError must not escape.
  const out = extract_text("a.docx", { get byteLength(): number { return 10; }, get length(): number { throw new RangeError("Invalid string length"); } } as unknown as Uint8Array);
  assert.equal(out.status, "failed");
  assert.equal(out.reason, "extract_error");
});

test("R1-3c: HTTP — a failed extraction of a hostile xlsx is a 201 'failed' record, not a 500", async () => {
  await with_api(async (env) => {
    const rows = Array.from({ length: 2000 }, (_v, i) => `<row r="${i + 1}"><c r="XFD${i + 1}"><v>1</v></c></row>`).join("");
    const m = await material_of(env, "희소.xlsx", raw_xlsx(rows));
    const blobs = count(env.db, "blobs");
    const res = await extract(env, m);
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.data.status, "failed");
    assert.equal(res.json.data.reason, "too_large");
    assert.equal(res.json.data.text_blob_id, null);
    assert.equal(count(env.db, "blobs"), blobs, "no text blob for a failed extraction");
  });
});

// ---------------------------------------------------------------------------
// 필수 4 — 펼친 합계 상한은 실제 펼친 바이트로

test("R1-4: pptx whose slides all LIE about their size (header 10, really 40 MiB) fails as a whole, quickly, without unpacking them all", () => {
  const zeros = Buffer.alloc(40 * MIB);
  const slides = Array.from({ length: 12 }, (_v, i) => ({ name: `ppt/slides/slide${i + 1}.xml`, data: zeros, claimed_size: 10 }));
  const zip = make_zip(slides);
  assert.ok(zip.byteLength < 1_000_000, `zip ${zip.byteLength} bytes`);
  const { value, ms } = timed(() => extract_text("거짓.pptx", zip));
  assert.equal(value.status, "failed", JSON.stringify(value.warnings));
  assert.ok(["invalid_container", "too_large"].includes(value.reason ?? ""), `reason ${value.reason}`);
  assert.equal(value.text, null);
  assert.ok(ms < 1_000, `took ${ms.toFixed(0)} ms`);
});

test("R1-4: a part whose size is understated does not poison the other parts as warnings — the whole container is invalid", () => {
  const big = "x".repeat(200_000);
  const zip = make_zip([
    { name: "ppt/slides/slide1.xml", data: `<p:sld><a:p><a:t>정상</a:t></a:p></p:sld>` },
    { name: "ppt/slides/slide2.xml", data: `<p:sld><a:p><a:t>${big}</a:t></a:p></p:sld>`, claimed_size: 100 },
  ]);
  const out = extract_text("작은거짓.pptx", zip);
  assert.equal(out.status, "failed");
  assert.equal(out.reason, "invalid_container");
  assert.equal(out.text, null);
});

test("R1-4: a corrupt deflate stream or CRC mismatch in one part makes the whole container invalid (not a part warning)", () => {
  const good = make_zip([
    { name: "ppt/slides/slide1.xml", data: `<p:sld><a:p><a:t>하나</a:t></a:p></p:sld>` },
    { name: "ppt/slides/slide2.xml", data: `<p:sld><a:p><a:t>둘 둘 둘 둘 둘 둘</a:t></a:p></p:sld>` },
  ]);
  const damaged = Buffer.from(good);
  // flip a byte inside the second slide's packed data (near the end, before the central directory)
  const cd = damaged.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  damaged[cd - 3] = (damaged[cd - 3] as number) ^ 0xff;
  const out = extract_text("깨진조각.pptx", damaged);
  assert.equal(out.status, "failed");
  assert.equal(out.reason, "invalid_container");
});

test("R1-4: honest parts that together exceed 64 MiB still stop with too_large (budget is spent by real bytes)", () => {
  const part = Buffer.alloc(30 * MIB);
  const zip = make_zip([1, 2, 3].map((n) => ({ name: `ppt/slides/slide${n}.xml`, data: part })));
  const out = extract_text("합계.pptx", zip);
  assert.equal(out.status, "failed");
  assert.equal(out.reason, "too_large");
});

test("R1-4: an unreadable slide of well-formed zip but malformed XML is still just a warning (partial) — existing contract", () => {
  const out = extract_text(
    "일부.pptx",
    make_pptx([["좋음 하나"], ["나쁨"], ["좋음 셋"]], { broken: [2] }),
  );
  assert.equal(out.status, "partial");
  assert.ok(out.warnings.some((w) => w.code === "part_unreadable"));
});

// ---------------------------------------------------------------------------
// 필수 5 — 닫힌 무관 blob 과 글자가 같을 때 비사람 응답에 id 가 없다

async function leak_setup(env: ApiEnv) {
  const secret = await material_of(env, "비밀.txt", new TextEncoder().encode("SEC-LINE-1\n"));
  const deny = await set_access(env, secret.data.file_policy_id, "deny");
  assert.equal(deny.status, 200, JSON.stringify(deny.json));
  const doc = await material_of(env, "공개처럼.docx", make_docx(["SEC-LINE-1"]));
  const agent = await make_agent(env, "writer", ["context:read", "file:read", "file:write"]);
  return { secret, doc, agent };
}

function assert_no_trace(wire: string, secret: Awaited<ReturnType<typeof material_of>>): void {
  assert.ok(!wire.includes(secret.blob.blob_id), "no blob id of the closed file");
  assert.ok(!wire.includes(secret.data.file_policy_id), "no policy id of the closed file");
  assert.ok(!wire.includes(secret.blob.sha256), "no hash of the closed file");
}

test("R1-5: the agent's write response for a text identical to a CLOSED unrelated blob carries no id, policy id or hash", async () => {
  await with_api(async (env) => {
    const { secret, doc, agent } = await leak_setup(env);
    const res = await extract(env, doc, { token: agent.token });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.data.status, "extracted");
    assert.equal(res.json.data.text_blob_id, null);
    assert.equal(res.json.data.text_file_policy_id, null);
    assert.equal(res.json.data.text_hash, null);
    assert_no_trace(wire_of(res), secret);

    // another key: the shortcut for an already-extracted target answers the same way
    const again = await extract(env, doc, { token: agent.token }, "other-key-r1-5");
    assert.equal(again.status, 201);
    assert.equal(again.json.data.text_blob_id, null);
    assert.equal(again.json.data.text_file_policy_id, null);
    assert.equal(again.json.data.text_hash, null);
    assert_no_trace(wire_of(again), secret);

    // same key again: the replay is the stored (redacted) answer
    const replay = await extract(env, doc, { token: agent.token }, "other-key-r1-5");
    assert.equal(replay.status, 201);
    assert_no_trace(wire_of(replay), secret);

    // the owner (human) still gets the full answer
    const owner_res = await extract(env, doc, "owner", "owner-key-r1-5");
    assert.equal(owner_res.status, 201);
    assert.equal(typeof owner_res.json.data.text_blob_id, "string");
    assert.equal(owner_res.json.data.text_blob_id, secret.blob.blob_id, "text is stored once, in the existing blob");
  });
});

test("R1-5: the command's known branch (no HTTP shortcut) also hides it from a non-human caller", async () => {
  await with_api(async (env) => {
    const { secret, doc, agent } = await leak_setup(env);
    const first = await extract(env, doc); // owner extracts first: the row exists
    assert.equal(first.status, 201);
    assert.equal(first.json.data.text_blob_id, secret.blob.blob_id);
    const out = await env.service.execute({ ...env.ctx("known-r1-5"), actor_id: agent.actor_id }, "file.extract", {
      version_id: doc.data.version_id,
      blob_id: doc.blob.blob_id,
    });
    const result = out.result as Record<string, unknown>;
    assert.equal(result.text_blob_id, null);
    assert.equal(result.text_file_policy_id, null);
    assert.equal(result.text_hash, null);
    assert.ok(!JSON.stringify(result).includes(secret.blob.blob_id));
    // and the stored receipt did not keep the ids for the agent
    const receipts = env.db.all<{ result_json: string }>(
      "SELECT result_json FROM mutation_commits WHERE client_request_id = ?",
      "known-r1-5",
    );
    assert.equal(receipts.length, 1);
    for (const row of receipts) assert.ok(!row.result_json.includes(secret.blob.blob_id));
  });
});

test("R1-5: an unrelated OPEN blob with the same text is still reported to the agent as usual (nothing is hidden needlessly)", async () => {
  await with_api(async (env) => {
    const open = await material_of(env, "열림.txt", new TextEncoder().encode("OPEN-LINE-1\n"));
    const doc = await material_of(env, "문서.docx", make_docx(["OPEN-LINE-1"]));
    const agent = await make_agent(env, "writer2", ["context:read", "file:read", "file:write"]);
    const res = await extract(env, doc, { token: agent.token });
    assert.equal(res.status, 201);
    assert.equal(res.json.data.text_blob_id, open.blob.blob_id);
    assert.equal(typeof res.json.data.text_hash, "string");
  });
});

test("R1-5: the closed file's blob and policy ids do not appear anywhere else an agent can read after the extraction", async () => {
  await with_api(async (env) => {
    const { secret, doc, agent } = await leak_setup(env);
    await extract(env, doc, { token: agent.token });
    const mats = await call(env, { method: "GET", path: P(env, "/materials"), auth: { token: agent.token } });
    assert_no_trace(wire_of(mats), secret);
  });
});

// ---------------------------------------------------------------------------
// 권장 중 작고 안전한 것 (R9 · R12 · R10)

test("R9: invalid UTF-8 in a zip part is not turned into U+FFFD — the part is unreadable (main part: invalid_document; a slide: a warning)", () => {
  const bad = Buffer.concat([Buffer.from("<w:document><w:body><w:p><w:t>a"), Buffer.from([0xff, 0xfe]), Buffer.from("b</w:t></w:p></w:body></w:document>")]);
  const main = extract_text("나쁜글자.docx", make_zip([{ name: "word/document.xml", data: bad }]));
  assert.equal(main.status, "failed");
  assert.equal(main.reason, "invalid_document");

  const slide_bad = Buffer.concat([Buffer.from("<p:sld><a:p><a:t>x"), Buffer.from([0xc3, 0x28]), Buffer.from("</a:t></a:p></p:sld>")]);
  const slides = extract_text(
    "나쁜슬라이드.pptx",
    make_zip([
      { name: "ppt/slides/slide1.xml", data: "<p:sld><a:p><a:t>좋음</a:t></a:p></p:sld>" },
      { name: "ppt/slides/slide2.xml", data: slide_bad },
    ]),
  );
  assert.equal(slides.status, "partial");
  assert.ok(slides.warnings.some((w) => w.code === "part_unreadable"));
  assert.ok(!slides.text?.includes("�"));
});

test("R9: '&#0;' and other forbidden control characters never become characters of the text; tab, LF and CR references still do", () => {
  const doc = '<w:document><w:body><w:p><w:t>a&#0;b&#1;c&#xB;d&#9;e&#xFFFF;f</w:t></w:p></w:body></w:document>';
  const out = extract_text("제어.docx", make_zip([{ name: "word/document.xml", data: doc }]));
  assert.equal(out.status, "extracted");
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f￿]/.test(out.text ?? ""), JSON.stringify(out.text));
  assert.ok(out.text?.includes("\t"), "a tab reference is kept");
});

test("R12: a slide whose file-name number has hundreds of digits is not a slide (no 'Infinity' heading); normal slides keep their order", () => {
  const huge = "9".repeat(400);
  const out = extract_text(
    "큰번호.pptx",
    make_zip([
      { name: "ppt/slides/slide2.xml", data: "<p:sld><a:p><a:t>둘</a:t></a:p></p:sld>" },
      { name: "ppt/slides/slide1.xml", data: "<p:sld><a:p><a:t>하나</a:t></a:p></p:sld>" },
      { name: `ppt/slides/slide${huge}.xml`, data: "<p:sld><a:p><a:t>괴물</a:t></a:p></p:sld>" },
    ]),
  );
  assert.equal(out.status, "extracted");
  assert.ok(!out.text?.includes("Infinity"));
  assert.ok(!out.text?.includes("괴물"));
  assert.equal(out.text, "## 슬라이드 1\n하나\n## 슬라이드 2\n둘\n");
});

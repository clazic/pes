/**
 * SEL-116 (3단계 MAT1b) — 형식별 글자·표 추출 규칙 (tester, 작성 모드). 인터페이스·형식별 결정: tests/helpers/sel116_env.ts 머리말.
 *
 * txt·md·csv(인코딩 UTF-8·BOM·줄바꿈, csv 는 원래 글자 유지) 와 hwpx·docx·xlsx·pptx(zip+XML, Node 기본 기능만).
 * 합성 파일은 시험 안에서 만든다. 실제 자료 없음.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { assert_ok, with_api } from "./helpers/api_env.ts";
import { sha256_hex } from "./helpers/backup_fixture.ts";
import {
  extract,
  extraction_rows,
  extracted,
  make_docx,
  make_hwpx,
  make_pptx,
  make_xlsx,
  material_of,
  text_of,
} from "./helpers/sel116_env.ts";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const with_bom = (s: string): Uint8Array => new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(s)]);

/** 빈 줄을 뺀 줄 목록. */
const lines_of = (text: string): string[] => text.split("\n").filter((l) => l.trim() !== "");

/** needles 가 이 순서대로(사이에 다른 줄이 있어도) 나오는지. */
function assert_in_order(text: string, needles: string[], where: string): void {
  const lines = lines_of(text);
  let at = 0;
  for (const n of needles) {
    const found = lines.findIndex((l, i) => i >= at && l === n);
    assert.ok(found >= 0, `${where}: line "${n}" expected (in order) in:\n${text}`);
    at = found + 1;
  }
}

// ---------------------------------------------------------------------------
// txt · md · csv

test("txt: UTF-8 text is kept as is; the extracted bytes are UTF-8 without BOM, hash = sha256 of the text", async () => {
  await with_api(async (env) => {
    const body = "한글 문단\nsecond line\n";
    const { r } = await extracted(env, "메모.txt", bytes(body));
    assert.equal(r.status, "extracted");
    assert.equal(r.source_format, "txt");
    assert.equal(await text_of(env, r), body);
    assert.equal(r.text_hash, sha256_hex(bytes(body)));
    assert.equal(r.table_count, 0);
    assert.equal(r.page_count, null);
  });
});

test("txt: a UTF-8 BOM is removed and CRLF / CR become LF (the contract text is LF)", async () => {
  await with_api(async (env) => {
    const { r } = await extracted(env, "윈도우.txt", with_bom("가\r\n나\r다\n"));
    assert.equal(r.status, "extracted");
    const got = await text_of(env, r);
    assert.equal(got, "가\n나\n다\n");
    assert.ok(!got.startsWith("﻿"), "no BOM in the extracted text");
  });
});

test("txt: an empty file is extracted with empty text (a blob and policy still exist); the extension case does not matter (.TXT)", async () => {
  await with_api(async (env) => {
    const { r } = await extracted(env, "빈.TXT", new Uint8Array());
    assert.equal(r.status, "extracted");
    assert.equal(r.source_format, "txt");
    assert.equal(await text_of(env, r), "");
    assert.ok(r.text_file_policy_id);
    assert.equal(r.text_hash, sha256_hex(new Uint8Array()));
  });
});

test("md: Markdown is kept verbatim (headings, lists, pipe tables) — no rendering, no rewriting", async () => {
  await with_api(async (env) => {
    const md = "# 제목\n\n- 항목 하나\n- 항목 둘\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n";
    const { r } = await extracted(env, "노트.md", bytes(md));
    assert.equal(r.status, "extracted");
    assert.equal(r.source_format, "md");
    assert.equal(await text_of(env, r), md);
    assert.equal(r.table_count, 0, "md tables are not counted — the text is kept as written");
  });
});

test("csv: the original csv text is kept (quotes, commas inside quotes, empty cells, row order); BOM and CRLF are tidied; table_count is 1", async () => {
  await with_api(async (env) => {
    const csv = '이름,값,비고\r\n"가,나",12.5,\r\n다,"따옴표 ""안""",끝\r\n';
    const { r } = await extracted(env, "합성표.csv", with_bom(csv));
    assert.equal(r.status, "extracted");
    assert.equal(r.source_format, "csv");
    assert.equal(await text_of(env, r), '이름,값,비고\n"가,나",12.5,\n다,"따옴표 ""안""",끝\n');
    assert.equal(r.table_count, 1);
  });
});

test("csv: an empty csv has no table (table_count 0)", async () => {
  await with_api(async (env) => {
    const { r } = await extracted(env, "빈표.csv", new Uint8Array());
    assert.equal(r.status, "extracted");
    assert.equal(r.table_count, 0);
  });
});

test("encoding: bytes that are not UTF-8 (EUC-KR, UTF-16 with BOM) are 'failed / invalid_encoding' — the text is never guessed, no text blob, no text policy", async () => {
  await with_api(async (env) => {
    const euc_kr = new Uint8Array([0xc7, 0xd1, 0xb1, 0xdb, 0x0a]); // "한글\n" in EUC-KR
    const utf16 = new Uint8Array([0xff, 0xfe, 0x5c, 0xd5, 0x00, 0xae, 0x0a, 0x00]);
    for (const [name, data] of [["옛글.txt", euc_kr], ["유니.txt", utf16]] as const) {
      // 준비 오류 수정(leader 승인 대상): 개수는 올리기 뒤·추출 바로 전에 센다 — 올리기가 만든 원본 blob 은 셈에서 뺀다.
      const m = await material_of(env, name, data);
      const before = Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM blobs")?.n);
      const r = assert_ok(await extract(env, m), 201);
      assert.equal(r.status, "failed", name);
      assert.equal(r.reason, "invalid_encoding", name);
      assert.ok(r.warnings.some((w: any) => w.code === "invalid_encoding"), name);
      assert.equal(r.text_blob_id, null);
      assert.equal(r.text_file_policy_id, null);
      assert.equal(r.text_hash, null);
      assert.equal(Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM blobs")?.n), before, "no blob was created");
    }
    const rows = extraction_rows(env.db, env.p.project_id);
    assert.deepEqual(rows.map((x) => x.status), ["failed", "failed"]);
    assert.ok(rows.every((x) => x.text_blob_id === null && x.text_file_policy_id === null && x.text_hash === null));
  });
});

// ---------------------------------------------------------------------------
// zip + XML 형식 (Node 기본 기능만)

test("no new dependency: package.json has no 'dependencies' and the devDependencies are still exactly the ones that were there", () => {
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
  assert.equal(pkg.dependencies, undefined, "zip/XML reading uses node:zlib and hand-written code");
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ["@playwright/test", "@types/node", "typescript"]);
});

test("docx: paragraphs in order and a table as pipe-table rows (header separator after the first row, '|' escaped); table_count 1", async () => {
  await with_api(async (env) => {
    const docx = make_docx(["제목 문단", [["항목", "값"], ["가", "1 | 2"], ["나", "x & <y>"]], "끝 문단"]);
    const { m, r } = await extracted(env, "합성문서.docx", docx);
    assert.equal(r.status, "extracted");
    assert.equal(r.source_format, "docx");
    assert.equal(r.table_count, 1);
    assert.equal(r.page_count, null);
    assert.deepEqual(r.warnings, []);
    const text = await text_of(env, r);
    assert_in_order(text, ["제목 문단", "| 항목 | 값 |", "| --- | --- |", "| 가 | 1 \\| 2 |", "| 나 | x & <y> |", "끝 문단"], "docx");
    assert.ok(!text.includes("<w:"), "no raw XML in the text");
    assert.ok(!text.includes("PK"), "no zip bytes in the text");
    assert.equal(m.data.media_type, "application/octet-stream", "the original is stored as uploaded");
  });
});

test("docx: a document with no table has table_count 0; XML entities are decoded", async () => {
  await with_api(async (env) => {
    const { r } = await extracted(env, "표없음.docx", make_docx(["A & B < C", "둘째"]));
    assert.equal(r.status, "extracted");
    assert.equal(r.table_count, 0);
    assert_in_order(await text_of(env, r), ["A & B < C", "둘째"], "docx entities");
  });
});

test("hwpx: sections in number order, paragraphs and tables from hp:p / hp:tbl; the input side only (no hwpx output)", async () => {
  await with_api(async (env) => {
    const hwpx = make_hwpx([
      ["구역0 첫 문단", [["이름", "값"], ["가나", "다"]], "구역0 끝"],
      ["구역1 문단"],
    ]);
    const { r } = await extracted(env, "합성한글.hwpx", hwpx);
    assert.equal(r.status, "extracted");
    assert.equal(r.source_format, "hwpx");
    assert.equal(r.table_count, 1);
    assert_in_order(
      await text_of(env, r),
      ["구역0 첫 문단", "| 이름 | 값 |", "| --- | --- |", "| 가나 | 다 |", "구역0 끝", "구역1 문단"],
      "hwpx",
    );
  });
});

test("xlsx: sheets in workbook order with a '## 이름' heading, shared / inline strings and numbers as written (12.5), empty cell kept empty; counts", async () => {
  await with_api(async (env) => {
    const xlsx = make_xlsx([
      { name: "합성시트", rows: [["이름", "값"], ["가나", 12.5], ["다", { inline: "인라인" }]] },
      { name: "빈시트", rows: [] },
      { name: "둘째", rows: [["a", null, "c"]] },
    ]);
    const { r } = await extracted(env, "합성통계.xlsx", xlsx);
    assert.equal(r.status, "extracted");
    assert.equal(r.source_format, "xlsx");
    assert.equal(r.page_count, 3, "sheets");
    assert.equal(r.table_count, 2, "non-empty sheets");
    assert_in_order(
      await text_of(env, r),
      ["## 합성시트", "| 이름 | 값 |", "| --- | --- |", "| 가나 | 12.5 |", "| 다 | 인라인 |", "## 둘째", "| a |  | c |"],
      "xlsx",
    );
  });
});

test("pptx: slides in NUMBER order (slide2 before slide10 even though stored first), '## 슬라이드 N' headings, tables; page_count = slides", async () => {
  await with_api(async (env) => {
    const pptx = make_pptx(
      [["S-ten 본문"], ["S-one 제목", "S-one 본문"], ["S-two 본문", [["열1", "열2"], ["값1", "값2"]]]],
      { numbers: [10, 1, 2] },
    );
    const { r } = await extracted(env, "합성발표.pptx", pptx);
    assert.equal(r.status, "extracted");
    assert.equal(r.source_format, "pptx");
    assert.equal(r.page_count, 3);
    assert.equal(r.table_count, 1);
    assert_in_order(
      await text_of(env, r),
      ["## 슬라이드 1", "S-one 제목", "S-one 본문", "## 슬라이드 2", "S-two 본문", "| 열1 | 열2 |", "| --- | --- |", "| 값1 | 값2 |", "## 슬라이드 10", "S-ten 본문"],
      "pptx",
    );
  });
});

test("partial: one unreadable slide → status 'partial', the readable slides' text is kept, warning part_unreadable names the part; DB status 'partial'", async () => {
  await with_api(async (env) => {
    const pptx = make_pptx([["S-ok-one"], ["S-bad-two"], ["S-ok-three"]], { broken: [2] });
    const { m, r } = await extracted(env, "일부깨짐.pptx", pptx);
    assert.equal(r.status, "partial");
    assert.ok(r.warnings.some((w: any) => w.code === "part_unreadable"), JSON.stringify(r.warnings));
    assert.ok(r.warnings.some((w: any) => String(w.message).includes("slide2")), "the warning names the part");
    const text = await text_of(env, r);
    assert.ok(text.includes("S-ok-one") && text.includes("S-ok-three"));
    assert.ok(!text.includes("깨짐"), "nothing from the broken part is invented");
    const row = extraction_rows(env.db, env.p.project_id)[0]!;
    assert.equal(row.status, "partial");
    assert.ok(row.text_blob_id && row.text_file_policy_id, "partial still has a text blob and its policy");
    assert.equal(JSON.parse(row.warnings_json).length, r.warnings.length);
    void m;
  });
});

test("partial: one unreadable sheet in an xlsx → 'partial', the other sheets are kept", async () => {
  await with_api(async (env) => {
    const xlsx = make_xlsx(
      [
        { name: "좋음", rows: [["가", "나"]] },
        { name: "나쁨", rows: [["x", "y"]] },
        { name: "또좋음", rows: [["다", "라"]] },
      ],
      { broken_sheet: 2 },
    );
    const { r } = await extracted(env, "일부시트.xlsx", xlsx);
    assert.equal(r.status, "partial");
    assert.ok(r.warnings.some((w: any) => w.code === "part_unreadable"));
    const text = await text_of(env, r);
    assert_in_order(text, ["## 좋음", "| 가 | 나 |", "## 또좋음", "| 다 | 라 |"], "xlsx partial");
  });
});

test("partial: one unreadable hwpx section → 'partial', the other section is kept", async () => {
  await with_api(async (env) => {
    const hwpx = make_hwpx([["구역0 좋음"], ["구역1 나쁨"], ["구역2 좋음"]], { broken: [1] });
    const { r } = await extracted(env, "일부구역.hwpx", hwpx);
    assert.equal(r.status, "partial");
    const text = await text_of(env, r);
    assert.ok(text.includes("구역0 좋음") && text.includes("구역2 좋음"));
    assert.ok(!text.includes("구역1 나쁨") && !text.includes("깨짐"));
  });
});

test("the extracted text blob of an office file is a plain UTF-8 text blob with its own policy (not the zip, not XML)", async () => {
  await with_api(async (env) => {
    const { m, r } = await extracted(env, "정책확인.docx", make_docx(["정책 확인 문단"]));
    const tb = env.db.get<{ media_type: string; original_name: string }>("SELECT media_type, original_name FROM blobs WHERE id = ?", r.text_blob_id);
    assert.ok(tb?.media_type.startsWith("text/plain"));
    assert.ok(tb?.original_name?.endsWith(".txt") && tb.original_name.includes("정책확인"));
    assert.notEqual(r.text_blob_id, m.blob.blob_id);
    assert.notEqual(r.text_file_policy_id, m.data.file_policy_id);
  });
});

// Minimal pure-TypeScript HWPX writer for the WEB0 spike.
//
// It intentionally uses only TextEncoder + fflate (pure JS), no Node built-ins,
// no DOM, and no external converter. The output has the OPC/mimetype skeleton
// required by the HWPX package. Whether Hancom Office opens it, and how faithful
// the layout is compared with hwpx-uri, must be confirmed by a human.

import { strToU8, zipSync } from "fflate";

export interface ReportTable {
  headers: string[];
  rows: string[][];
}

export interface ReportModel {
  title: string;
  paragraphs: string[];
  table?: ReportTable;
}

export interface HwpxResult {
  bytes: Uint8Array;
  report: ReportModel;
  entries: string[];
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Small synthetic Markdown parser: title, paragraphs, and one pipe table. */
export function parseReportMarkdown(markdown: string): ReportModel {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  let title = "합성 보고서";
  const paragraphs: string[] = [];
  let table: ReportTable | undefined;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      index += 1;
      continue;
    }
    if (trimmed.startsWith("# ")) {
      title = trimmed.slice(2).trim();
      index += 1;
      continue;
    }
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const tableLines: string[] = [];
      while (index < lines.length) {
        const candidate = (lines[index] ?? "").trim();
        if (!(candidate.startsWith("|") && candidate.endsWith("|"))) break;
        tableLines.push(candidate);
        index += 1;
      }
      const cells = tableLines
        .map((row) =>
          row
            .slice(1, -1)
            .split("|")
            .map((cell) => cell.trim()),
        )
        .filter(
          (row) =>
            row.length === 0 || !row.every((cell) => /^:?-{3,}:?$/.test(cell)),
        );
      if (cells.length > 0) {
        table = { headers: cells[0] ?? [], rows: cells.slice(1) };
      }
      continue;
    }
    paragraphs.push(trimmed.replace(/^#+\s*/, ""));
    index += 1;
  }
  return { title, paragraphs, table };
}

function paragraphXml(text: string, id: number, bold = false): string {
  return `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="${bold ? "1" : "0"}"><hp:t>${escapeXml(text)}</hp:t></hp:run></hp:p>`;
}

function tableXml(table: ReportTable, startId: number): string {
  const rows = [table.headers, ...table.rows];
  const colCount = Math.max(1, ...rows.map((row) => row.length));
  const rowXml = rows
    .map((row, rowIndex) => {
      const cells = Array.from({ length: colCount }, (_, cellIndex) => row[cellIndex] ?? "");
      const cellXml = cells
        .map(
          (cell, cellIndex) => `<hp:tc name="" header="${rowIndex === 0 ? "1" : "0"}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="0">
  <hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">
    ${paragraphXml(cell, startId + rowIndex * colCount + cellIndex, rowIndex === 0)}
  </hp:subList>
  <hp:cellAddr colAddr="${cellIndex}" rowAddr="${rowIndex}"/>
  <hp:cellSpan colSpan="1" rowSpan="1"/>
  <hp:cellSz width="8000" height="1200"/>
  <hp:cellMargin left="0" right="0" top="0" bottom="0"/>
</hp:tc>`,
        )
        .join("");
      return `<hp:tr>${cellXml}</hp:tr>`;
    })
    .join("");
  return `<hp:tbl id="${startId}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${rows.length}" colCnt="${colCount}" cellSpacing="0" borderFillIDRef="0" noAdjust="0">
  <hp:sz width="42000" widthRelTo="ABSOLUTE" height="0" heightRelTo="ABSOLUTE" protect="0"/>
  <hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>
  <hp:outMargin left="0" right="0" top="0" bottom="0"/>
  <hp:inMargin left="0" right="0" top="0" bottom="0"/>
  ${rowXml}
</hp:tbl>`;
}

function headerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" version="1.1">
  <hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>
  <hh:refList>
    <hh:borderFills itemCnt="1">
      <hh:borderFill id="0" threeD="0" shadow="0" centerLine="0" breakCellSeparateLine="0">
        <hh:leftBorder type="SOLID" width="0.1 mm" color="#000000"/>
        <hh:rightBorder type="SOLID" width="0.1 mm" color="#000000"/>
        <hh:topBorder type="SOLID" width="0.1 mm" color="#000000"/>
        <hh:bottomBorder type="SOLID" width="0.1 mm" color="#000000"/>
        <hh:diagonal type="NONE" width="0.1 mm" color="#000000"/>
      </hh:borderFill>
    </hh:borderFills>
    <hh:charProperties itemCnt="2">
      <hh:charPr id="0" height="1000" textColor="#000000" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="0">
        <hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
      </hh:charPr>
      <hh:charPr id="1" height="1200" textColor="#000000" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="0">
        <hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
      </hh:charPr>
    </hh:charProperties>
    <hh:paraProperties itemCnt="1">
      <hh:paraPr id="0" align="JUSTIFY">
        <hh:align horizontal="JUSTIFY" vertical="BASELINE"/>
        <hh:heading type="NONE" idRef="0" level="0"/>
        <hh:margin><hh:intent value="0"/><hh:left value="0"/><hh:right value="0"/><hh:prev value="0"/><hh:next value="0"/></hh:margin>
        <hh:lineSpacing type="PERCENT" value="160"/>
      </hh:paraPr>
    </hh:paraProperties>
  </hh:refList>
</hh:head>`;
}

function sectionXml(report: ReportModel): string {
  const blocks: string[] = [paragraphXml(report.title, 0, true)];
  let id = 1;
  for (const paragraph of report.paragraphs) {
    blocks.push(paragraphXml(paragraph, id));
    id += 1;
  }
  if (report.table) {
    blocks.push(tableXml(report.table, id));
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" version="1.1">
  ${blocks.join("\n  ")}
</hs:sec>`;
}

function contentHpf(report: ReportModel): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="pes-id">
  <opf:metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${escapeXml(report.title)}</dc:title>
    <dc:language>ko</dc:language>
    <dc:creator>PES WEB0 Spike</dc:creator>
  </opf:metadata>
  <opf:manifest>
    <opf:item id="header" href="header.xml" media-type="application/xml"/>
    <opf:item id="section0" href="section0.xml" media-type="application/xml"/>
  </opf:manifest>
  <opf:spine>
    <opf:itemref idref="section0"/>
  </opf:spine>
</opf:package>`;
}

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="Contents/content.hpf" media-type="application/hwp+zip"/>
  </rootfiles>
</container>`;

const VERSION_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hv:version xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" version="1.1" subVersion="1.0" buildNumber="0" os="1" application="PES WEB0 Spike"/>`;

export function buildHwpxFromMarkdown(markdown: string): HwpxResult {
  const report = parseReportMarkdown(markdown);
  // Insertion order matters: mimetype must be the first zip entry and stored.
  const epoch = new Date(1980, 0, 1, 0, 0, 0);
  const files: Record<string, [Uint8Array, { level: 0 | 6; mtime: Date }]> = {
    mimetype: [strToU8("application/hwp+zip"), { level: 0, mtime: epoch }],
    "version.xml": [strToU8(VERSION_XML), { level: 6, mtime: epoch }],
    "META-INF/container.xml": [strToU8(CONTAINER_XML), { level: 6, mtime: epoch }],
    "Contents/content.hpf": [strToU8(contentHpf(report)), { level: 6, mtime: epoch }],
    "Contents/header.xml": [strToU8(headerXml()), { level: 6, mtime: epoch }],
    "Contents/section0.xml": [strToU8(sectionXml(report)), { level: 6, mtime: epoch }],
  };
  return {
    bytes: zipSync(files, { level: 6 }),
    report,
    entries: Object.keys(files),
  };
}

/** Read the first local file header without any zip library. */
export function firstZipEntry(bytes: Uint8Array): { name: string; method: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x04034b50) throw new Error("not a zip local header");
  const method = view.getUint16(8, true);
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  const name = new TextDecoder().decode(bytes.slice(30, 30 + nameLength));
  void extraLength;
  return { name, method };
}

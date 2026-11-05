import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { unzipSync, strFromU8 } from "fflate";
import {
  buildHwpxFromMarkdown,
  firstZipEntry,
  parseReportMarkdown,
} from "../ts-core/hwpx.ts";

const REPORT_PATH = fileURLToPath(new URL("../fixtures/report.md", import.meta.url));
const HWPX_SOURCE = fileURLToPath(new URL("../ts-core/hwpx.ts", import.meta.url));

test("HWPX: synthetic report.md parses title, paragraphs, and one table", () => {
  const report = parseReportMarkdown(readFileSync(REPORT_PATH, "utf8"));
  assert.equal(report.title, "합성 정책 보고서");
  assert.equal(report.paragraphs.length, 2);
  assert.deepEqual(report.table?.headers, ["구분", "값"]);
  assert.equal(report.table?.rows.length, 2);
});

test("HWPX: mimetype is the first stored entry", () => {
  const result = buildHwpxFromMarkdown(readFileSync(REPORT_PATH, "utf8"));
  const first = firstZipEntry(result.bytes);
  assert.equal(first.name, "mimetype");
  assert.equal(first.method, 0);
  assert.equal(new TextDecoder().decode(result.bytes.slice(30, 30 + 8)), "mimetype");
});

test("HWPX: required OPC/OWPML entries and table structure", () => {
  const result = buildHwpxFromMarkdown(readFileSync(REPORT_PATH, "utf8"));
  const files = unzipSync(result.bytes);
  for (const name of [
    "mimetype",
    "version.xml",
    "META-INF/container.xml",
    "Contents/content.hpf",
    "Contents/header.xml",
    "Contents/section0.xml",
  ]) {
    assert.ok(files[name], `missing ${name}`);
  }
  assert.equal(strFromU8(files.mimetype ?? new Uint8Array()), "application/hwp+zip");
  const container = strFromU8(files["META-INF/container.xml"] ?? new Uint8Array());
  assert.match(container, /full-path="Contents\/content\.hpf"/);
  assert.match(container, /media-type="application\/hwp\+zip"/);
  const version = strFromU8(files["version.xml"] ?? new Uint8Array());
  assert.match(version, /<hv:version/);
  const hpf = strFromU8(files["Contents/content.hpf"] ?? new Uint8Array());
  assert.match(hpf, /<opf:manifest>/);
  assert.match(hpf, /href="section0\.xml"/);
  const header = strFromU8(files["Contents/header.xml"] ?? new Uint8Array());
  assert.match(header, /<hh:head/);
  assert.match(header, /<hh:refList>/);
  assert.match(header, /<hh:charProperties/);
  const section = strFromU8(files["Contents/section0.xml"] ?? new Uint8Array());
  assert.match(section, /<hs:sec/);
  assert.match(section, /합성 정책 보고서/);
  assert.match(section, /두 번째 문단/);
  assert.match(section, /<hp:tbl/);
  assert.match(section, /<hp:tr>/);
  assert.match(section, /<hp:tc/);
  assert.equal((section.match(/<hp:tr>/g) ?? []).length, 3);
  assert.equal((section.match(/<hp:tc/g) ?? []).length, 6);
  assert.match(section, /프로젝트/);
  assert.match(section, /합성 정책 연구/);
});

test("HWPX: converter source has no Node/DOM-only API", () => {
  const source = readFileSync(HWPX_SOURCE, "utf8");
  assert.doesNotMatch(source, /from\s+["']node:/);
  assert.doesNotMatch(source, /\bBuffer\b/);
  assert.doesNotMatch(source, /\bdocument\b/);
  assert.doesNotMatch(source, /\bwindow\b/);
  assert.doesNotMatch(source, /require\(/);
  assert.match(source, /from "fflate"/);
});

test("HWPX: browser bundle builds without Node polyfills", async () => {
  const result = await build({
    entryPoints: [HWPX_SOURCE],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: ["es2022"],
    logLevel: "silent",
  });
  const output = result.outputFiles?.[0]?.contents;
  assert.ok(output && output.length > 0);
  const text = new TextDecoder().decode(output);
  assert.doesNotMatch(text, /node:zlib|node:fs|require\("node:/);
});

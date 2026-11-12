// SEL-125 — Windows failures that only CI windows-latest saw (run 43230108426), kept here as string-level regression tests that run on every OS.
//   W1  a child's `--import` of an absolute path must be a file:// URL — `D:\a\…\x.ts` is read as a URL with the scheme `d:` (ERR_UNSUPPORTED_ESM_URL_SCHEME).
//   W2  every `--import` a test passes to a node child (argv or NODE_OPTIONS) goes through import_url() / pathToFileURL() or is a relative `./…` spelling.
//   W3  a YAML / text check that spans a line end accepts CRLF (a Windows checkout with core.autocrlf=true turns docs/** into CRLF).
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { test } from "node:test";

import { use_home_guard } from "./helpers/home_guard.ts";
import { import_url } from "./helpers/import_url.ts";

use_home_guard();

const REPO = join(import.meta.dirname, "..");

test("W1 import_url: a Windows absolute path becomes a file:/// URL (drive letter kept, `\\` → `/`, a space and `~` escaped); a POSIX path too", () => {
  const helper = win32.join("D:\\a\\pes\\pes", "tests", "helpers", "require_temp_home.ts");
  assert.equal(helper, "D:\\a\\pes\\pes\\tests\\helpers\\require_temp_home.ts");
  assert.equal(import_url(helper, true), "file:///D:/a/pes/pes/tests/helpers/require_temp_home.ts");
  assert.equal(import_url("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\pes x\\probe.ts", true), "file:///C:/Users/RUNNER%7E1/AppData/Local/Temp/pes%20x/probe.ts");
  assert.equal(import_url("/tmp/pes x/probe.ts", false), "file:///tmp/pes%20x/probe.ts");
  // the bare Windows spelling is what broke: as a URL its scheme is the drive letter
  assert.equal(new URL(helper).protocol, "d:");
  assert.equal(new URL(import_url(helper, true)).protocol, "file:");
});

/** Every `"--import", <value>` in the test and script sources, with its file and line. */
function import_args(): { where: string; line: string; value: string }[] {
  const out: { where: string; line: string; value: string }[] = [];
  for (const rel of globSync(["tests/**/*.ts", "scripts/**/*.ts"], { cwd: REPO })) {
    if (rel.replace(/\\/g, "/") === "tests/test_sel125_windows_spellings.test.ts") continue; // this file's own patterns
    const lines = readFileSync(join(REPO, rel), "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const m of line.matchAll(/"--import",\s*([^\]),]+)/g)) out.push({ where: `${rel}:${index + 1}`, line, value: m[1].trim() });
      for (const m of line.matchAll(/NODE_OPTIONS:\s*`--import (\$\{[^}]*\}[^`]*)`/g)) out.push({ where: `${rel}:${index + 1}`, line, value: m[1] });
    });
  }
  return out;
}

test("W2 every `--import` handed to a node child is a URL (import_url / pathToFileURL) or a relative ./ spelling — never a bare absolute path", () => {
  const found = import_args();
  assert.ok(found.length >= 8, `the scan finds the known --import sites (${found.length})`);
  const bad = found.filter(({ line, value }) => {
    if (/import_url\(|pathToFileURL\(/.test(value)) return false;
    if (/^"\.\//.test(value) || /^"--/.test(value)) return false; // a relative URL, or the next flag in a list of flag names
    if (value === "IMPORT_ENTRY") return false; // scripts/run_tests.ts: "./tests/helpers/require_temp_home.ts"
    if (/"init"/.test(line)) return false; // `pes init --import <library>` — a PES CLI option, not node's
    return true;
  });
  assert.deepEqual(bad.map(({ where, value }) => `${where}: ${value}`), []);
});

test("W3 the OpenAPI checks that span a line end match the same text with CRLF line ends", () => {
  const lf = "  /api/v1/projects/{id}/question-sets/{qs}/order:\n    post:\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  const order = /\/api\/v1\/projects\/\{id\}\/question-sets\/\{[a-z]+\}\/order:\r?\n\s+post:/;
  assert.match(lf, order);
  assert.match(crlf, order);
  assert.doesNotMatch(crlf, /\/api\/v1\/projects\/\{id\}\/question-sets\/\{[a-z]+\}\/order:\n\s+post:/, "the old LF-only pattern fails on CRLF — what CI Windows saw");
});

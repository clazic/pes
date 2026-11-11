// SEL-74 (PR #58 CI): Windows PowerShell 5.1 reads a .ps1 run with -File as the ANSI code page unless the file starts with a
// UTF-8 BOM. Our .ps1 files carry Korean text (messages), so without the BOM `powershell -File bootstrap.ps1` (commands/setup.md)
// and `-File install.ps1` fail with parse errors (windows-latest run 43090412010). Every .ps1 under scripts/ keeps the BOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");

test("every scripts/*.ps1 starts with a UTF-8 BOM (Windows PowerShell 5.1 -File reads it as UTF-8)", () => {
  const files = readdirSync(SCRIPTS).filter((f) => f.endsWith(".ps1"));
  assert.ok(files.length >= 3, `found ${files.join(", ")}`);
  for (const f of files) {
    const head = readFileSync(join(SCRIPTS, f)).subarray(0, 3);
    assert.deepEqual([...head], [0xef, 0xbb, 0xbf], `${f} must start with EF BB BF`);
  }
});

test("the Windows install job also runs install.ps1 the README way (irm | iex: text with the BOM as a character)", () => {
  const ci = readFileSync(join(SCRIPTS, "..", ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ci, /Invoke-Expression \$s/);
  assert.match(ci, /-File scripts\/install\.ps1/);
});

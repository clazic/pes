// SEL-74 D (1/3) — the install / bootstrap scripts are Node-based: no Python anywhere in them, Node 26 is what they check and how they
// tell the user to install it, and they have the three test seams that let CI (and the run tests) install without a network:
//   PES_INSTALL_MIRROR=<folder>   the folder is the repository: bootstrap + sources come from it instead of the network / `git clone`
//   PES_INSTALL_PATH_ONLY=1       PATH is exactly what the caller gave (no /opt/homebrew/bin, no registry PATH refresh)
//   PES_SKIP_TOOLS=1              step 4 (kosis · vworld · korean-law · ego lite install/upgrade) is skipped, like PES_SKIP_KEYS skips step 5
// Written before the edit: these fail until the scripts are converted.
import assert from "node:assert/strict";
import { test } from "node:test";

import { read_rel } from "./helpers/sel74_env.ts";

const SH = ["scripts/install.sh", "scripts/bootstrap.sh", "scripts/install-desktop.sh"];
const PS = ["scripts/install.ps1", "scripts/bootstrap.ps1", "scripts/install-desktop.ps1"];

test("D1: no Python in install.sh · install.ps1 · bootstrap.* · install-desktop.* (no interpreter call, no `.py`, no `py -3`, no Python in the text)", () => {
  for (const rel of [...SH, ...PS]) {
    const text = read_rel(rel);
    assert.doesNotMatch(text, /python|\bpy\s+-3\b|\.py\b|PYTHON|PyEOF|PYEOF/i, `${rel} still mentions Python`);
  }
});

test("D2: the scripts call the TypeScript tools (setup.ts · pes.ts) with node", () => {
  for (const rel of ["scripts/install.sh", "scripts/install.ps1"]) {
    const text = read_rel(rel);
    for (const sub of ["install missing", "upgrade all", "keys --wait", "mark"]) assert.match(text, new RegExp(`scripts[/\\\\]setup\\.ts[^\\n]*${sub}|setup\\.ts[^\\n]*${sub}`), `${rel}: setup.ts ${sub}`);
    assert.match(text, /pes\.ts[^\n]*doctor --net|doctor --net/, `${rel}: pes.ts doctor --net`);
    assert.match(text, /\bnode\b/, `${rel}: runs node`);
  }
});

test("D3: bootstrap checks Node.js 26 or newer — the version rule is in the text, the check line is `<OK|INSTALLED|MISSING|FAIL> node …`, the last line names the node command (not PYTHON)", () => {
  for (const rel of ["scripts/bootstrap.sh", "scripts/bootstrap.ps1"]) {
    const text = read_rel(rel);
    assert.match(text, /26/, `${rel}: the major version 26`);
    assert.match(text, /\bnode\b/i);
    assert.match(text, /NODE /, `${rel}: last line "NODE <명령>"`);
    assert.doesNotMatch(text, /PYTHON/);
  }
});

test("D4: bootstrap installs/points to Node 26 — brew (macOS) / winget (Windows) — and says where to get it when there is no package manager", () => {
  const sh = read_rel("scripts/bootstrap.sh");
  assert.match(sh, /brew install[^\n]*node/, "brew install node");
  assert.match(sh, /nodejs\.org/, "a download address");
  const ps = read_rel("scripts/bootstrap.ps1");
  assert.match(ps, /OpenJS\.NodeJS/, "winget id of Node.js");
  assert.match(ps, /nodejs\.org|winget 없음/, "a way out without winget");
});

test("D5: install.sh · install.ps1 stop with a Korean message about Node 26 when node is missing or older than 26 (they no longer ask for Python 3.9+)", () => {
  for (const rel of ["scripts/install.sh", "scripts/install.ps1"]) {
    const text = read_rel(rel);
    assert.match(text, /Node(?:\.js)?\s*26/, `${rel}: Node 26 message`);
    assert.doesNotMatch(text, /3\.9/, `${rel}: no 3.9`);
  }
});

test("D6: the test seams exist in install.sh and install.ps1: PES_INSTALL_MIRROR · PES_INSTALL_PATH_ONLY · PES_SKIP_TOOLS (plus the old PES_SKIP_KEYS · PES_NO_UPGRADE · PES_TARGET)", () => {
  for (const rel of ["scripts/install.sh", "scripts/install.ps1"]) {
    const text = read_rel(rel);
    for (const name of ["PES_INSTALL_MIRROR", "PES_INSTALL_PATH_ONLY", "PES_SKIP_TOOLS", "PES_SKIP_KEYS", "PES_NO_UPGRADE", "PES_TARGET"]) assert.match(text, new RegExp(name), `${rel}: ${name}`);
  }
  for (const rel of ["scripts/bootstrap.sh", "scripts/bootstrap.ps1"]) assert.match(read_rel(rel), /PES_INSTALL_PATH_ONLY/, `${rel}: PES_INSTALL_PATH_ONLY`);
  for (const rel of ["scripts/install-desktop.sh", "scripts/install-desktop.ps1"]) assert.match(read_rel(rel), /PES_INSTALL_MIRROR/, `${rel}: PES_INSTALL_MIRROR`);
});

test("D7: the Claude Desktop settings registration (extraKnownMarketplaces.pes-local · enabledPlugins pes@pes-local, backup .bak-pes) is written without Python — install.sh uses node", () => {
  const sh = read_rel("scripts/install.sh");
  assert.match(sh, /extraKnownMarketplaces/);
  assert.match(sh, /\.bak-pes/);
  assert.match(sh, /\bnode\b[^\n]*(?:-e\b|setup\.ts|--input-type)/, "node does the JSON edit");
});

test("D8: README / commands/setup.md describe the 6 install steps without Python (step 1 = Git · Node.js)", () => {
  assert.match(read_rel("README.md"), /Git[^\n]*Node\.js 26/);
  assert.doesNotMatch(read_rel("README.md"), /Git·Python·Node\.js|Git · Python|Python 3 · Node\.js/);
});

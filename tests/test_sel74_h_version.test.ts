// SEL-74 H — this PR does not raise any version (0.16.0 is PR22's release). plugin.json stays 0.15.6; no manifest, package or doc claims a new one.
import assert from "node:assert/strict";
import { test } from "node:test";

import { read_rel } from "./helpers/sel74_env.ts";

test("H1: plugin.json version is still 0.15.6 and the marketplace entry carries no other version", () => {
  const plugin = JSON.parse(read_rel(".claude-plugin/plugin.json")) as { version: string; name: string };
  assert.equal(plugin.name, "pes");
  assert.equal(plugin.version, "0.15.6");
  const market = read_rel(".claude-plugin/marketplace.json");
  for (const m of market.matchAll(/"version"\s*:\s*"([^"]+)"/g)) assert.equal(m[1], "0.15.6", "marketplace.json version");
});

test("H2: package.json stays the private 0.0.0 development package (no release version)", () => {
  const pkg = JSON.parse(read_rel("package.json")) as { version: string; private?: boolean };
  assert.equal(pkg.version, "0.0.0");
  assert.equal(pkg.private, true);
});

test("H3: no document or script announces 0.16 as already released (the release is PR22's)", () => {
  for (const rel of ["README.md", "AGENTS.md", "scripts/install.sh", "scripts/install.ps1", "scripts/bootstrap.sh", "scripts/bootstrap.ps1"]) {
    assert.doesNotMatch(read_rel(rel), /\b0\.16\.\d+\b(?![^\n]*(?:예정|계획|PR22|release|배포))/i, `${rel}: no 0.16.x version claim`);
  }
});

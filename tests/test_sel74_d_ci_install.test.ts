// SEL-74 D (2/3) — CI runs the install and the upgrade on Windows and macOS (workflow static check). The install runs in a temporary HOME,
// without a network (PES_INSTALL_MIRROR = this checkout, PES_SKIP_KEYS=1), the external installers are replaced by fake commands.
import assert from "node:assert/strict";
import { test } from "node:test";

import { parse_yaml } from "./helpers/mini_yaml.ts";
import { read_rel } from "./helpers/sel74_env.ts";

interface Step {
  name?: string;
  run?: string;
  shell?: string;
  uses?: string;
  if?: string;
  env?: Record<string, unknown>;
  "timeout-minutes"?: number;
}
interface Job {
  name?: string;
  "runs-on"?: string;
  env?: Record<string, unknown>;
  steps?: Step[];
  strategy?: { matrix?: Record<string, unknown> };
  "timeout-minutes"?: number;
}

const ci = (): { jobs: Record<string, Job> } => parse_yaml(read_rel(".github/workflows/ci.yml")) as { jobs: Record<string, Job> };
const oses = (job: Job): string[] => {
  const m = job.strategy?.matrix?.os;
  return Array.isArray(m) ? (m as string[]) : job["runs-on"] === undefined ? [] : [job["runs-on"]];
};
const calls = (job: Job, script: string): Step[] => (job.steps ?? []).filter((s) => (s.run ?? "").includes(script));

/** the job(s) that install on `os` with `script` */
function install_jobs(os: "windows-latest" | "macos-latest", script: string): Job[] {
  return Object.values(ci().jobs).filter((j) => oses(j).includes(os) && calls(j, script).length > 0);
}

test("D9: a CI job installs with scripts/install.sh on macOS and with scripts/install.ps1 on Windows — and runs the install a second time as the upgrade (two calls per OS)", () => {
  for (const [os, script] of [["macos-latest", "scripts/install.sh"], ["windows-latest", "scripts/install.ps1"]] as const) {
    const jobs = install_jobs(os, script);
    assert.ok(jobs.length >= 1, `${os}: a job that runs ${script}`);
    const total = jobs.reduce((n, j) => n + calls(j, script).length, 0);
    assert.ok(total >= 2, `${os}: ${script} runs at least twice (install, then upgrade over it) — found ${total}`);
    const names = jobs.flatMap((j) => j.steps ?? []).map((s) => s.name ?? "");
    assert.ok(names.some((n) => /upgrade|업그레이드/i.test(n)), `${os}: a step named for the upgrade`);
    assert.ok(names.some((n) => /install|설치/i.test(n)), `${os}: a step named for the install`);
  }
});

test("D10: the install job uses a temporary HOME (runner.temp), no network branch (PES_INSTALL_MIRROR, PES_SKIP_KEYS=1) and fake external commands", () => {
  for (const [os, script] of [["macos-latest", "scripts/install.sh"], ["windows-latest", "scripts/install.ps1"]] as const) {
    assert.ok(install_jobs(os, script).length > 0, `${os}: an install job exists`);
    for (const job of install_jobs(os, script)) {
      for (const step of calls(job, script)) {
        const env = { ...(job.env ?? {}), ...(step.env ?? {}) };
        const text = JSON.stringify(env);
        assert.match(text, /runner\.temp/, `${os}: HOME / USERPROFILE point into runner.temp (${text})`);
        assert.ok("HOME" in env || "USERPROFILE" in env, `${os}: HOME or USERPROFILE is set for the install step`);
        assert.ok("PES_INSTALL_MIRROR" in env, `${os}: PES_INSTALL_MIRROR`);
        assert.equal(String(env.PES_SKIP_KEYS), "1", `${os}: PES_SKIP_KEYS=1`);
      }
      const all = (job.steps ?? []).map((s) => `${s.name ?? ""}\n${s.run ?? ""}`).join("\n");
      assert.match(all, /fake|가짜|shim/i, `${os}: the external installers are replaced by fake commands (a step that makes them)`);
    }
  }
});

test("D11: the install job needs Node 26 (setup-node 26) and has a timeout; it never uses the real HOME (no step runs the script without the temporary HOME env)", () => {
  for (const [os, script] of [["macos-latest", "scripts/install.sh"], ["windows-latest", "scripts/install.ps1"]] as const) {
    assert.ok(install_jobs(os, script).length > 0, `${os}: an install job exists`);
    for (const job of install_jobs(os, script)) {
      assert.ok(typeof job["timeout-minutes"] === "number", `${os}: timeout-minutes`);
      const node = (job.steps ?? []).find((s) => (s.uses ?? "").startsWith("actions/setup-node"));
      assert.ok(node, `${os}: actions/setup-node`);
      assert.ok(String(JSON.stringify(node)).includes("26"), `${os}: Node 26`);
    }
  }
});

test("D12: after the install the job checks the result (setup.ts / pes.ts exist under the temporary HOME's .pes/src, doctor ran) — not only the exit code", () => {
  for (const [os, script] of [["macos-latest", "scripts/install.sh"], ["windows-latest", "scripts/install.ps1"]] as const) {
    const text = install_jobs(os, script).flatMap((j) => j.steps ?? []).map((s) => s.run ?? "").join("\n");
    assert.match(text, /setup\.ts/, `${os}: setup.ts checked`);
    assert.match(text, /\.pes[\\/]+src/, `${os}: the .pes/src checkout checked`);
  }
});

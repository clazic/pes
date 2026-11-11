// SEL-74 F — the real home is protected in every new test: temporary HOME / USERPROFILE / PES_HOME, the TS child guard (real-home reads +
// hub ports), and a before/after snapshot of the real ~/.pes · ~/pes-projects (home_guard) — the install-script tests add ~/.claude.
// This file looks at the SEL-74 test files themselves, so a later test cannot forget the guard.
import assert from "node:assert/strict";
import { test } from "node:test";

import { read_rel, repo_files } from "./helpers/sel74_env.ts";

const FILES = repo_files("tests").filter((f) => /^tests\/test_sel74_[a-z0-9_]+\.test\.ts$/.test(f));
// a file that starts anything (a CLI, a server, an install script) must be guarded
/** read-only checks of text and YAML: they start nothing (the words `spawn(` they search for are data) */
const STATIC = new Set(["tests/test_sel74_e_python_removed.test.ts", "tests/test_sel74_d_install_static.test.ts", "tests/test_sel74_d_ci_install.test.ts", "tests/test_sel74_h_version.test.ts"]);
const STARTS = /\b(?:pes_ts|pes_ts_async|run_ts_cli|run_ts_cli_async|ts_run|serve_fixture|with_cli|spawnSync|spawn)\s*\(/;

test("F1: the SEL-74 test files exist (so this check cannot pass empty)", () => {
  for (const name of ["a_skill_calls", "b_db_commands", "c_d14_refusal", "c_migrate", "c_doctor_hub", "d_install_static", "d_ci_install", "d_install_run", "e_python_removed", "f_real_home", "g_server_safety", "g2_hung_server", "h_version"]) {
    assert.ok(FILES.includes(`tests/test_sel74_${name}.test.ts`), `tests/test_sel74_${name}.test.ts`);
  }
});

test("F2: every SEL-74 test that starts a process calls use_home_guard() (before/after snapshot of the real ~/.pes and ~/pes-projects)", () => {
  const missing = FILES.filter((f) => {
    if (STATIC.has(f)) return false;
    const text = read_rel(f);
    return STARTS.test(text) && !/\buse_home_guard\(\)/.test(text);
  });
  assert.deepEqual(missing, []);
});

test("F3: no SEL-74 test names the real home: no os.homedir() / userInfo() / process.env.HOME reads of its own, no literal ~/.pes or ~/pes-projects path", () => {
  const bad: string[] = [];
  for (const f of FILES) {
    if (f.endsWith("test_sel74_f_real_home.test.ts")) continue;
    read_rel(f).split("\n").forEach((line, i) => {
      if (/\bhomedir\(\)|\buserInfo\(\)|process\.env\.(?:HOME|USERPROFILE)\b|["'`]~[\\/]\.(?:pes|claude)|["'`]~[\\/]pes-projects/.test(line)) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(bad, []);
});

test("F4: every child of the install-script tests runs with a temporary HOME / USERPROFILE / PES_HOME / TMPDIR, the guard module and a private hub range", () => {
  const text = read_rel("tests/test_sel74_d_install_run.test.ts");
  for (const needle of ["HOME: ctx.home_dir", "USERPROFILE: ctx.home_dir", "PES_HOME: ctx.pes_home", "TMPDIR: ctx.tmp", "ts_child_guard.ts", "PES_HUB_PORTS", "PES_TEST_REAL_HOME", "claude_snapshot()"]) {
    assert.ok(text.includes(needle), `d_install_run: ${needle}`);
  }
});

test("F5: the shared tools of the SEL-74 tests never mutate process.env except the one G3 test that restores it", () => {
  const helper = read_rel("tests/helpers/sel74_env.ts");
  assert.doesNotMatch(helper, /process\.env\.\w+\s*=[^=]/);
  const writers = FILES.filter((f) => !f.endsWith("test_sel74_f_real_home.test.ts") && /process\.env\.\w+\s*=[^=]/.test(read_rel(f)));
  assert.deepEqual([...writers].sort(), ["tests/test_sel74_e_python_removed.test.ts", "tests/test_sel74_g_server_safety.test.ts"], "only the G3 / E5 tests set process.env, each inside try/finally");
});

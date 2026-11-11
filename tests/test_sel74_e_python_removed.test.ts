// SEL-74 E — Python is removed. The 0.15 tools (pes.py · serve.py · setup.py), the design check (check_ddl.py), the pytest suite and its
// requirements are gone; the CI has no Python job; no test starts Python. The 0.15 behaviour stays pinned by the FROZEN baseline records
// (tests/fixtures/compat/baseline/*.json, kept as the 0.15 record) which pes.ts is compared with — this PR makes no new baseline.
// Written before the removal: these fail until the files are deleted and the harness is converted.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { has_rel, read_rel, REPO, repo_files } from "./helpers/sel74_env.ts";
import { parse_yaml } from "./helpers/mini_yaml.ts";

const SELF = /^tests\/test_sel74_/;
/** history records (plans, spike logs, archived designs) may name the old commands — nothing else may */
const HISTORY = ["docs/plan/", "docs/archive/"];
/** these two helpers spell the 0.15 usage line ("사용: python3 -I …") that the FROZEN baselines recorded, to normalise it — text, not a call */
const BASELINE_SPELLING = new Set(["tests/helpers/compat_ts_srv.ts", "tests/helpers/compat_cases.ts"]);
const is_history = (rel: string): boolean => HISTORY.some((p) => rel.startsWith(p));

test("E1: the 0.15 Python entry points, the Python design check, the pytest files and their requirements are deleted", () => {
  const gone = ["scripts/pes.py", "scripts/serve.py", "scripts/setup.py", "docs/plan/schemas/check_ddl.py", "pytest.ini", "requirements-dev.txt", "tests/conftest.py", "tests/serve_budget.py"];
  assert.deepEqual(gone.filter(has_rel), [], "still there");
  const py_tests = repo_files("tests").filter((f) => f.endsWith(".py"));
  assert.deepEqual(py_tests, [], "no Python file under tests/ (the pytest suite and the fixture generator are gone)");
  assert.deepEqual(repo_files("scripts").filter((f) => f.endsWith(".py")), [], "no Python file under scripts/");
});

test("E2: no `.py` file outside the history folders (docs/plan, docs/archive)", () => {
  const rest = repo_files().filter((f) => f.endsWith(".py") && !is_history(f));
  assert.deepEqual(rest, []);
});

test("E3: no Python call (`python3 … pes.py|serve.py|setup.py|check_ddl.py`, `py -3`, `python -m pytest|venv`) anywhere in the repository except the history folders and this PR's own tests", () => {
  const call = /\b(?:python3?|py)\b(?:\s+-\S+(?:\s+utf8)?)*\s+\S*(?:pes|serve|setup|check_ddl)\.py\b|\bpy\s+-3\b|\bpython3?\s+-m\s+(?:pytest|venv)\b|\.venv[\\/](?:bin|Scripts)[\\/](?:python|pip)/;
  const text_ext = /\.(?:md|ts|json|yml|yaml|sh|ps1|html|txt|toml|cfg)$/;
  const bad: string[] = [];
  for (const rel of repo_files()) {
    // the frozen 0.15 baseline records (E7 forbids touching them) keep the 0.15 usage line as DATA ("사용: python3 -I setup.py <명령>" in E14)
    if (is_history(rel) || SELF.test(rel) || BASELINE_SPELLING.has(rel) || rel.startsWith("tests/fixtures/compat/baseline/") || !text_ext.test(rel) || rel === "package-lock.json") continue;
    read_rel(rel).split("\n").forEach((line, i) => {
      if (call.test(line)) bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(bad, [], `Python calls left:\n${bad.join("\n")}`);
});

test("E4: no test or test helper starts Python or names the retired harness pieces (PES_PY · SERVE_PY · SETUP_PY · CONFTEST_PY · py_guard_source · run_py_code · a \"py\" target)", () => {
  const ident = /\b(?:PES_PY|SERVE_PY|SETUP_PY|CONFTEST_PY|py_guard_source|run_py_code|run_py|PY_FLAGS|PYTHON)\b|spawn(?:Sync)?\(\s*["'`]python3?["'`]|["'`]python3?["'`]\s*,\s*(?:hub_blocked_argv|\[)|type Target = "py"|target:\s*"py"|PES_COMPAT_TARGET=py/;
  const bad: string[] = [];
  for (const rel of repo_files("tests")) {
    if (!rel.endsWith(".ts") || SELF.test(rel)) continue;
    read_rel(rel).split("\n").forEach((line, i) => {
      if (ident.test(line)) bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(bad, [], `Python still used by the tests:\n${bad.slice(0, 40).join("\n")}${bad.length > 40 ? `\n… ${bad.length - 40} more` : ""}`);
});

test("E5: the compat harness compares pes.ts / serve.ts / setup.ts with the frozen baselines only — the default target is ts, `py` is refused, no baseline update mode", async () => {
  const env = await import("./helpers/compat_env.ts");
  const before = process.env.PES_COMPAT_TARGET;
  try {
    delete process.env.PES_COMPAT_TARGET;
    assert.equal(env.target_from_env(), "ts", "the default target is ts");
    process.env.PES_COMPAT_TARGET = "py";
    assert.throws(() => env.target_from_env(), /ts/, "py is not a target any more");
    process.env.PES_COMPAT_TARGET = "ts";
    assert.equal(env.target_from_env(), "ts");
  } finally {
    if (before === undefined) delete process.env.PES_COMPAT_TARGET;
    else process.env.PES_COMPAT_TARGET = before;
  }
  const update_name = ["PES_COMPAT", "UPDATE"].join("_");
  const users = repo_files("tests").filter((f) => f.endsWith(".ts") && !SELF.test(f) && read_rel(f).includes(update_name));
  assert.deepEqual(users, [], "nothing can rewrite the baselines any more (this PR makes none)");
});

test("E6: every compat case (E01~E15, X01~X11) runs on ts and is `implemented` — no `not_yet` case is left and the baselines are the frozen 0.15 record", () => {
  for (const file of ["cases.json", "contract.json"]) {
    const data = JSON.parse(read_rel(`tests/fixtures/compat/${file}`)) as { cases: Array<{ id: string; ts?: { status?: string } }> };
    for (const c of data.cases) assert.equal(c.ts?.status, "implemented", `${file} ${c.id}`);
  }
});

test("E7: the baseline records are byte-identical to the 0.15 record (sha256 manifest written when PR26e began) — none was changed, added or removed", () => {
  const manifest = JSON.parse(read_rel("tests/fixtures/compat/baseline.sha256.json")) as { files: Record<string, string> };
  const dir = join(REPO, "tests", "fixtures", "compat", "baseline");
  const now: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) now[name] = createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
  assert.deepEqual(now, manifest.files);
});

test("E8: the CI workflow has no Python: no setup-python step, no pytest, no requirements-dev, no PYTHON* env, no `test` job with a python-version matrix", () => {
  const text = read_rel(".github/workflows/ci.yml");
  assert.doesNotMatch(text, /python/i, "the word python does not appear in ci.yml");
  assert.doesNotMatch(text, /pytest|requirements-dev/i);
  const ci = parse_yaml(text) as { jobs: Record<string, { strategy?: { matrix?: Record<string, unknown> } }> };
  for (const [name, job] of Object.entries(ci.jobs)) assert.equal(job.strategy?.matrix?.["python-version"], undefined, `${name}: no python-version matrix`);
  assert.equal(ci.jobs.test, undefined, "the Python `test` job is gone");
});

test("E9: the TypeScript and browser jobs stay (typecheck · design check on shard 1 · 8 shards · Playwright) on Windows and macOS", () => {
  const ci = parse_yaml(read_rel(".github/workflows/ci.yml")) as { jobs: Record<string, { "runs-on"?: string; strategy?: { matrix?: Record<string, unknown> }; steps?: Array<Record<string, unknown>> }> };
  const ts = ci.jobs.typescript;
  assert.ok(ts, "typescript job");
  assert.deepEqual([...(ts.strategy?.matrix?.os as string[])].sort(), ["macos-latest", "windows-latest"]);
  assert.equal((ts.strategy?.matrix?.shard as unknown[]).length, 8);
  const runs = (ts.steps ?? []).map((s) => String(s.run ?? ""));
  for (const need of ["npm run typecheck", "npm run check:ddl", "node --test"]) assert.ok(runs.some((r) => r.includes(need)), need);
  assert.ok(ci.jobs.browser, "browser job");
});

test("E10: AGENTS.md and tests/README.md no longer ask for Python (the Python 3.9 line, the pytest commands, the PES_DB_CORE Python note) and say Node 26 is all that is needed", () => {
  for (const rel of ["AGENTS.md", "tests/README.md"]) {
    const text = read_rel(rel);
    assert.doesNotMatch(text, /Python 3\.9 이상/, `${rel}: no Python 3.9 requirement`);
    assert.doesNotMatch(text, /pytest/, `${rel}: no pytest`);
    assert.match(text, /Node 26/, `${rel}: Node 26`);
  }
});

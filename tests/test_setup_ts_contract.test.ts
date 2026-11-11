// SEL-72 (PR26c): scripts/setup.ts — the commands that need no browser and no network: check [--json], needed, mark, the usage text, and
// the parts of install / upgrade that decide on the spot (unknown name, missing npm / claude). Contract = scripts/setup.py run directly.
//
// Isolation (the harness, compat_ts_srv.ts): temp HOME / USERPROFILE / PES_HOME, PATH narrowed to an empty folder, and `--permission`
// with an allow-list that holds neither /opt/homebrew nor /usr/local nor the real home — so no developer PC's kosis / vworld / ego /
// claude / npm is visible to the child and the rows below are the same on every machine. The child cannot spawn a process. A setup.ts
// that meets a tool it cannot run must treat it as missing (setup.py's run() swallowed every exception into code -1; so must setup.ts).
//
// NOT tested here, on purpose (they call the network or open a browser): `install kosis|vworld|ego-browser` (curl | sh, app download),
// `install missing` / `install` with no names, `upgrade kosis|vworld|ego-browser|all`, and `keys` without --no-open.
//
// D12: no `python` row in `check` (PES TS runs no Python — docs/plan/migration-ts-equivalence.md 9.1), usage names `node scripts/setup.ts`.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { read_baseline } from "./helpers/compat_cases.ts";
import { make_ctx } from "./helpers/compat_env.ts";
import { BARE_SETUP, REPO_ROOT, TS_SETUP_USAGE_LINE, run_ts_bare, run_ts_setup } from "./helpers/compat_ts_srv.ts";
import { use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

const VERSION: string = JSON.parse(readFileSync(join(REPO_ROOT, ".claude-plugin", "plugin.json"), "utf8")).version;
const STATES = new Set(["ok", "missing", "user", "optional", "key"]);

function setup(ctx: ReturnType<typeof make_ctx>, args: string[], env?: Record<string, string | undefined>) {
  return run_ts_setup(ctx, args, { narrow_path: true, env });
}

function mask(value: string): string {
  return value.length > 4 ? value.slice(0, 2) + "*".repeat(value.length - 4) + value.slice(-2) : "****";
}

/** The rows of `check --json` of a machine that has none of the tools (the harness hides them all), 0.15's text for each. */
function expected_rows(): Array<[string, string, string, string, string]> {
  const rows: Array<[string, string, string, string, string]> = [["git", "missing", "Git", "bootstrap 으로 설치", "기본"]];
  if (process.platform === "win32") rows.push(["gitbash", "missing", "Git Bash", "답 자동 수신(Monitor)에 필요 — Git for Windows", "기본"]);
  rows.push(
    ["node", "missing", "Node.js·npm", "korean-law 설치에 필요", "기본"],
    ["ego-browser", "user", "ego lite (ego-browser)", "앱 설치 + 첫 실행 안내(온보딩)는 사용자가 직접", "도구"],
    ["ego-browser-skill", "optional", "ego-browser 스킬", "ego lite 설치 후 생김", "도구"],
    ["kosis", "missing", "kosis CLI + 스킬", "통계청 KOSIS", "도구"],
    ["vworld", "missing", "vworld CLI + 스킬", "국가공간정보", "도구"],
    ["korean-law", "missing", "korean-law CLI", "법령 조회", "도구"],
    ["korean-law-mcp", "optional", "korean-law MCP (선택)", "claude CLI 가 없어 확인 생략 — CLI 만으로 충분", "도구"],
    ["key-kosis", "key", "KOSIS API 키", "https://kosis.kr/openapi/", "API 키"],
    ["key-vworld", "key", "VWorld API 키", "https://www.vworld.kr", "API 키"],
    ["key-law", "key", "법령 LAW_OC", "https://open.law.go.kr", "API 키"],
  );
  return rows;
}

test("run method: plain `node scripts/setup.ts` — bare, unguarded, isolated env: the usage goes to stdout (exit 1) with 0.15's text and the TS command name", () => {
  const ctx = make_ctx("pes-setup-usage-");
  try {
    // 0.15's pinned usage (E14 baseline, the bogus-command step) is the reference: one line differs (D12), the port is the real default
    const base = read_baseline("E14");
    const bogus = base.steps.find((s: any) => s.step[1] === "bogus-command") as { stdout: string[] };
    const expected = `${bogus.stdout.map((l) => l.replace("127.0.0.1:<PORT>", "127.0.0.1:8759").replace(["사용:", "python3", "-I", "setup.py", "<명령>"].join(" "), TS_SETUP_USAGE_LINE) /* the 0.15 usage line, spelled out as words */).join("\n")}\n`;
    assert.ok(expected.includes(TS_SETUP_USAGE_LINE), "the reference text must contain the usage line");
    for (const args of [[], ["bogus-command"], ["check-json"], ["KEYS"], ["--help"]]) {
      const bare = run_ts_bare(ctx, BARE_SETUP, args, { narrow_path: true });
      assert.equal(bare.status, 1, `args ${JSON.stringify(args)}`);
      assert.equal(bare.stdout, expected, `args ${JSON.stringify(args)}`);
      assert.equal(bare.stderr, "", `args ${JSON.stringify(args)}`);
    }
    const guarded = setup(ctx, ["bogus-command"]);
    assert.deepEqual([guarded.status, guarded.stdout, guarded.stderr], [1, expected, ""], "the guarded child prints the same");
  } finally {
    ctx.cleanup();
  }
});

test("check --json: 0.15's rows in 0.15's order (no python row), one JSON array, indent 1, keys name state label detail group", () => {
  const ctx = make_ctx("pes-setup-check-");
  try {
    const run = setup(ctx, ["check", "--json"]);
    assert.equal(run.status, 0);
    assert.equal(run.stderr, "");
    const rows = JSON.parse(run.stdout) as Array<Record<string, string>>;
    assert.equal(run.stdout, `${JSON.stringify(rows, null, 1)}\n`, "json.dumps(ensure_ascii=False, indent=1) + newline");
    for (const row of rows) {
      assert.deepEqual(Object.keys(row), ["name", "state", "label", "detail", "group"]);
      assert.ok(STATES.has(row.state as string), `state ${row.state}`);
    }
    assert.ok(!rows.some((r) => r.name === "python"), "PES TS needs no Python: no python row (D12)");
    assert.deepEqual(rows.map((r) => [r.name, r.state, r.label, r.detail, r.group]), expected_rows());
    // the groups appear in this order and are contiguous
    const groups = rows.map((r) => r.group).filter((g, i, all) => i === 0 || g !== all[i - 1]);
    assert.deepEqual(groups, ["기본", "도구", "API 키"]);
  } finally {
    ctx.cleanup();
  }
});

test("check (text): ■ group headers and `  [상태] label — detail` lines, [정상] [없음] [직접] [선택] [키 필요]", () => {
  const ctx = make_ctx("pes-setup-check-text-");
  try {
    const rows = JSON.parse(setup(ctx, ["check", "--json"]).stdout) as Array<Record<string, string>>;
    const map: Record<string, string> = { ok: "[정상]", missing: "[없음]", user: "[직접]", optional: "[선택]", key: "[키 필요]" };
    const lines: string[] = [];
    let group: string | undefined;
    for (const row of rows) {
      if (row.group !== group) {
        group = row.group;
        lines.push(`■ ${group}`);
      }
      lines.push(`  ${map[row.state as string]} ${row.label}${row.detail ? ` — ${row.detail}` : ""}`);
    }
    const text = setup(ctx, ["check"]);
    assert.equal(text.status, 0);
    assert.equal(text.stdout, `${lines.join("\n")}\n`);
    assert.ok(text.stdout.includes("  [키 필요] 법령 LAW_OC — https://open.law.go.kr"));
  } finally {
    ctx.cleanup();
  }
});

test("needed / mark: never checked → 1 and the Korean reason; mark writes ~/.pes/setup.json; then needed is OK; a changed version or a broken file asks for setup again", () => {
  const ctx = make_ctx("pes-setup-needed-");
  try {
    const never = "PES 설치 점검을 한 적이 없습니다 — /pes:setup";
    assert.deepEqual(pick(setup(ctx, ["needed"])), [1, `${never}\n`, ""]);

    const mark = setup(ctx, ["mark"]);
    assert.equal(mark.status, 0);
    assert.equal(mark.stderr, "");
    const marked = /^설치 완료 표시: (.+) \(PES (.+)\)\n$/.exec(mark.stdout);
    assert.ok(marked !== null, mark.stdout);
    assert.equal(marked[2], VERSION, "the version is the plugin's (.claude-plugin/plugin.json)");
    const file = join(ctx.home_dir, ".pes", "setup.json");
    assert.equal(realpathSync.native(marked[1] as string), realpathSync.native(file), "the printed path is ~/.pes/setup.json of the temp home");

    const text = readFileSync(file, "utf8");
    const data = JSON.parse(text) as { version: string; time: string; state: Record<string, string> };
    assert.deepEqual(Object.keys(data), ["version", "time", "state"]);
    assert.equal(text, JSON.stringify(data, null, 1), "indent 1, UTF-8, no trailing newline");
    assert.equal(data.version, VERSION);
    assert.match(data.time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    const rows = JSON.parse(setup(ctx, ["check", "--json"]).stdout) as Array<{ name: string; state: string }>;
    assert.deepEqual(data.state, Object.fromEntries(rows.map((r) => [r.name, r.state])), "state = name → state of every check row");

    assert.deepEqual(pick(setup(ctx, ["needed"])), [0, "OK\n", ""]);

    writeFileSync(file, JSON.stringify({ ...data, version: "0.0.1" }), "utf8");
    assert.deepEqual(pick(setup(ctx, ["needed"])), [1, `PES 가 0.0.1 → ${VERSION} 로 바뀌었습니다 — /pes:setup 으로 다시 점검\n`, ""]);
    writeFileSync(file, "{ not json", "utf8");
    assert.deepEqual(pick(setup(ctx, ["needed"])), [1, `${never}\n`, ""]);
    writeFileSync(file, "", "utf8");
    assert.deepEqual(pick(setup(ctx, ["needed"])), [1, `${never}\n`, ""]);

    // mark twice: the second replaces the first
    assert.equal(setup(ctx, ["mark"]).status, 0);
    assert.deepEqual(pick(setup(ctx, ["needed"])), [0, "OK\n", ""]);
  } finally {
    ctx.cleanup();
  }
});

test("the LAW_OC row: from the environment first, else ~/.claude/settings.json env; shown masked, never in full; a broken settings file is no key", () => {
  const ctx = make_ctx("pes-setup-law-");
  try {
    const row = (env?: Record<string, string | undefined>): Record<string, string> => {
      const run = setup(ctx, ["check", "--json"], env);
      assert.equal(run.status, 0);
      return (JSON.parse(run.stdout) as Array<Record<string, string>>).find((r) => r.name === "key-law") as Record<string, string>;
    };
    assert.equal(row().state, "key");
    const settings = join(ctx.home_dir, ".claude", "settings.json");
    mkdirSync(join(ctx.home_dir, ".claude"), { recursive: true });

    writeFileSync(settings, JSON.stringify({ env: { LAW_OC: "SYNTHETICLAWKEY99" } }), "utf8");
    assert.deepEqual([row().state, row().detail], ["ok", mask("SYNTHETICLAWKEY99")]);
    assert.equal(mask("SYNTHETICLAWKEY99"), "SY*************99");
    // the environment wins over the settings file
    const from_env = row({ LAW_OC: "ENVSYNTHETICKEY" });
    assert.deepEqual([from_env.state, from_env.detail], ["ok", mask("ENVSYNTHETICKEY")]);
    // short values are fully hidden
    writeFileSync(settings, JSON.stringify({ env: { LAW_OC: "abcd" } }), "utf8");
    assert.equal(row().detail, "****");
    writeFileSync(settings, JSON.stringify({ env: { LAW_OC: "abcde" } }), "utf8");
    assert.equal(row().detail, "ab*de");
    // no key in any shape: not a key
    for (const bad of ["{ not json", "[]", "null", JSON.stringify({ env: null }), JSON.stringify({ env: { LAW_OC: "" } }), JSON.stringify({ other: 1 })]) {
      writeFileSync(settings, bad, "utf8");
      const r = row();
      assert.equal(r.state, "key", `settings ${bad}`);
      assert.equal(r.detail, "https://open.law.go.kr");
    }
    // nothing printed contains a key in full
    writeFileSync(settings, JSON.stringify({ env: { LAW_OC: "SYNTHETICLAWKEY99" } }), "utf8");
    for (const args of [["check"], ["check", "--json"], ["mark"], ["needed"]]) {
      const run = setup(ctx, args);
      assert.ok(!run.stdout.includes("SYNTHETICLAWKEY99") && !run.stderr.includes("SYNTHETICLAWKEY99"), `${args.join(" ")} printed the key`);
    }
    assert.ok(!readFileSync(join(ctx.home_dir, ".pes", "setup.json"), "utf8").includes("SYNTHETICLAWKEY99"), "setup.json holds states, not keys");
  } finally {
    ctx.cleanup();
  }
});

test("install: an unknown name FAILs with the Korean reason; korean-law without npm FAILs; korean-law-mcp without the claude CLI is SKIPped — exit 0 each, output line by line", () => {
  const ctx = make_ctx("pes-setup-install-");
  try {
    const unknown = setup(ctx, ["install", "zzz"]);
    assert.deepEqual(pick(unknown), [0, "... zzz 설치 중\nFAIL zzz — 알 수 없는 항목: zzz\n", ""]);
    const law = setup(ctx, ["install", "korean-law"]);
    assert.deepEqual(pick(law), [0, "... korean-law 설치 중\nFAIL korean-law — npm 없음 — bootstrap 으로 Node.js 먼저 설치\n", ""]);
    const mcp = setup(ctx, ["install", "korean-law-mcp"]);
    assert.deepEqual(pick(mcp), [0, "... korean-law-mcp 설치 중\nSKIP korean-law-mcp — claude CLI 가 없어 MCP 등록을 건너뜀 (PES 는 korean-law CLI 를 쓰므로 없어도 됨)\n", ""]);
    // several names: one block per name, in the order given
    const many = setup(ctx, ["install", "zzz", "korean-law-mcp", "yyy"]);
    assert.equal(many.stdout, "... zzz 설치 중\nFAIL zzz — 알 수 없는 항목: zzz\n... korean-law-mcp 설치 중\nSKIP korean-law-mcp — claude CLI 가 없어 MCP 등록을 건너뜀 (PES 는 korean-law CLI 를 쓰므로 없어도 됨)\n... yyy 설치 중\nFAIL yyy — 알 수 없는 항목: yyy\n");
  } finally {
    ctx.cleanup();
  }
});

test("upgrade: an unknown name FAILs at once; korean-law without npm is SKIPped; `all` is no name; the lines are `... <name> 최신 버전 확인` then `<STATE> <name> <message>`", () => {
  const ctx = make_ctx("pes-setup-upgrade-");
  try {
    assert.deepEqual(pick(setup(ctx, ["upgrade", "zzz"])), [0, "FAIL zzz 알 수 없는 항목\n", ""]);
    assert.deepEqual(pick(setup(ctx, ["upgrade", "korean-law"])), [0, "... korean-law 최신 버전 확인\nSKIP korean-law 설치되어 있지 않음\n", ""]);
    assert.deepEqual(pick(setup(ctx, ["upgrade", "korean-law", "all"])), [0, "... korean-law 최신 버전 확인\nSKIP korean-law 설치되어 있지 않음\n", ""], "`all` among names is dropped");
    assert.deepEqual(pick(setup(ctx, ["upgrade", "zzz", "korean-law"])), [0, "FAIL zzz 알 수 없는 항목\n... korean-law 최신 버전 확인\nSKIP korean-law 설치되어 있지 않음\n", ""]);
  } finally {
    ctx.cleanup();
  }
});

test("setup.ts only writes below the temp home (~/.pes, ~/.claude) and leaves the PES home folder alone", () => {
  const ctx = make_ctx("pes-setup-writes-");
  try {
    for (const args of [["mark"], ["needed"], ["check", "--json"]]) assert.ok(setup(ctx, args).status !== null);
    assert.ok(existsSync(join(ctx.home_dir, ".pes", "setup.json")));
    assert.deepEqual(readdirSync(ctx.pes_home), [], "nothing is written into the PES home (the projects folder) by setup");
    assert.ok(!existsSync(join(ctx.home_dir, ".pes", "pes.db")), "no database either");
  } finally {
    ctx.cleanup();
  }
});

function pick(run: { status: number | null; stdout: string; stderr: string }): [number | null, string, string] {
  return [run.status, run.stdout, run.stderr];
}

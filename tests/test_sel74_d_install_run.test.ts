// SEL-74 D (3/3) — the install scripts really run, in a temporary HOME, without a network, with fake external commands.
//   install.sh · bootstrap.sh · install-desktop.sh : macOS / Linux          install.ps1 · bootstrap.ps1 · install-desktop.ps1 : Windows
// (the other OS skips with the reason below — CI runs both).  The author could run only the sh side (macOS); the Windows half is written
// from the same contract and is the first thing the Windows CI job proves.
//
// How the scripts are isolated (the seams of test_sel74_d_install_static, D6):
//   PATH            = one folder of fakes (+ symlinks to the system tools the script needs) — PES_INSTALL_PATH_ONLY=1 keeps it exact
//   PES_INSTALL_MIRROR = a copy of this checkout's scripts/ templates/ … (no download, no `git clone`)
//   PES_SKIP_KEYS=1, PES_SKIP_TOOLS=1  — no key screen, no kosis/vworld/korean-law/ego install
//   HOME · USERPROFILE · PES_HOME · TMPDIR = temporary folders; `curl` is a fake that fails (a call to it = a network attempt); `python3` ·
//   `python` · `py` are decoys that log and fail (a call to them = the scripts still want Python)
// The real ~/.claude · ~/.pes · ~/pes-projects are snapshot before and after (names · sizes · mtimes only — never read).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { free_port, make_ctx, type CompatCtx } from "./helpers/compat_env.ts";
import { account_home, real_homes, use_home_guard } from "./helpers/home_guard.ts";
import { REPO } from "./helpers/sel74_env.ts";

use_home_guard();

const WIN = process.platform === "win32";
const GUARD = join(import.meta.dirname, "helpers", "ts_child_guard.ts");
const SH_ONLY = WIN ? "install.sh 는 macOS·Linux 용이다 — Windows 는 install.ps1 시험이 같은 계약을 맡는다" : false;
const PS_ONLY = WIN ? false : "install.ps1 은 Windows 전용이다 — macOS·Linux 는 install.sh 시험이 같은 계약을 맡는다";

// ---------------------------------------------------------------------------
// the real account's .claude (the guard of use_home_guard covers .pes and pes-projects): stat only, never read

function claude_snapshot(): string {
  const base = join(account_home(), ".claude");
  const names = [base, join(base, "settings.json"), join(base, "plugins")];
  return JSON.stringify(
    names.map((p) => {
      try {
        const st = lstatSync(p);
        return [p, st.size, st.mtimeMs, st.isDirectory() ? readdirSync(p).length : 0];
      } catch {
        return [p, "absent"];
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// the scene

interface Scene {
  ctx: CompatCtx;
  bin: string;
  logs: string;
  mirror: string;
  home: string;
  src: string;
  env: Record<string, string>;
  cleanup(): void;
}

const SYSTEM_TOOLS = ["sh", "bash", "env", "uname", "mktemp", "tr", "sed", "ls", "head", "tail", "grep", "cat", "cp", "rm", "mkdir", "dirname", "basename", "ln", "mv", "sleep", "date", "readlink", "touch", "wc", "sort", "find", "xargs", "tee", "cut", "chmod", "id", "awk", "expr", "pwd", "stat", "uniq", "printf", "test"];

function write_exec(file: string, text: string): void {
  writeFileSync(file, text, "utf8");
  chmodSync(file, 0o755);
}

/** the fakes. `node` is `real` (a symlink to this Node) or a version shim like "v20.11.0". */
function make_bin(bin: string, logs: string, node: "real" | string | "none", extras: { claude?: boolean; brew?: boolean } = {}): void {
  mkdirSync(bin, { recursive: true });
  if (WIN) {
    const cmd = (name: string, body: string): void => writeFileSync(join(bin, `${name}.cmd`), `@echo off\r\n${body}\r\n`, "utf8");
    cmd("git", `echo git %* >> "%PES_TEST_LOG_DIR%\\git.log"\r\nif "%1"=="--version" echo git version 2.40.0`);
    if (extras.claude !== false) cmd("claude", `echo claude %* >> "%PES_TEST_LOG_DIR%\\claude.log"\r\nif "%1"=="--version" echo 2.0.0 Claude Code\r\nif "%1 %2"=="plugin list" echo pes@pes-local 0.15.6`);
    for (const name of ["python3", "python", "py"]) cmd(name, `echo ${name} %* >> "%PES_TEST_LOG_DIR%\\python.log"\r\nexit /b 1`);
    if (node !== "real" && node !== "none") cmd("node", `if "%1"=="--version" echo ${node}`);
    return;
  }
  for (const name of SYSTEM_TOOLS) {
    for (const dir of ["/bin", "/usr/bin"]) {
      const from = join(dir, name);
      if (existsSync(from) && !existsSync(join(bin, name))) {
        symlinkSync(from, join(bin, name));
        break;
      }
    }
  }
  write_exec(join(bin, "git"), `#!/bin/sh\necho "git $*" >> "$PES_TEST_LOG_DIR/git.log"\ncase "$1" in --version) echo "git version 2.40.0";; esac\nexit 0\n`);
  write_exec(join(bin, "curl"), `#!/bin/sh\necho "curl $*" >> "$PES_TEST_LOG_DIR/curl.log"\nexit 22\n`);
  if (extras.claude !== false) {
    write_exec(join(bin, "claude"), `#!/bin/sh\necho "claude $*" >> "$PES_TEST_LOG_DIR/claude.log"\ncase "$1" in --version) echo "2.0.0 (Claude Code)";; esac\n[ "$1 $2" = "plugin list" ] && echo "pes@pes-local 0.15.6"\nexit 0\n`);
  }
  for (const name of ["python3", "python", "py"]) write_exec(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$PES_TEST_LOG_DIR/python.log"\nexit 1\n`);
  if (extras.brew === true) {
    // `brew install node…` puts a Node 26 shim into the folder (what a real install would do)
    write_exec(join(bin, "brew"), `#!/bin/sh\necho "brew $*" >> "$PES_TEST_LOG_DIR/brew.log"\nif [ "$1" = install ]; then printf '#!/bin/sh\\n[ "$1" = --version ] && echo v26.1.0\\nexit 0\\n' > "${bin}/node"; chmod 755 "${bin}/node"; fi\nexit 0\n`);
  }
  if (node === "real") symlinkSync(process.execPath, join(bin, "node"));
  else if (node !== "none") write_exec(join(bin, "node"), `#!/bin/sh\n[ "$1" = --version ] && echo ${node}\nexit 0\n`);
}

/** a copy of what the install fetches: scripts · templates · questions · skills … (no node_modules · .git · tests · docs) */
function make_mirror(dir: string): void {
  const keep = new Set(["scripts", "templates", "questions", "skills", "commands", "agents", ".claude-plugin", "package.json", "README.md"]);
  cpSync(REPO, dir, { recursive: true, filter: (from) => {
    const rel = from.slice(REPO.length).replace(/^[\\/]+/, "");
    if (rel === "") return true;
    return keep.has(rel.split(/[\\/]/)[0] as string);
  } });
}

async function scene(prefix: string, node: "real" | string | "none" = "real", extras: { claude?: boolean; brew?: boolean } = {}): Promise<Scene> {
  const ctx = make_ctx(prefix);
  const bin = join(ctx.home.root, "fakebin");
  const logs = join(ctx.home.root, "logs");
  const mirror = join(ctx.home.root, "mirror");
  mkdirSync(logs, { recursive: true });
  mkdirSync(ctx.tmp, { recursive: true });
  make_bin(bin, logs, node, extras);
  make_mirror(mirror);
  const port = await free_port();
  const path = WIN
    ? [bin, dirname(process.execPath), join(process.env.SystemRoot ?? "C:\\Windows", "System32"), join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0")].join(delimiter)
    : bin;
  const env: Record<string, string> = {
    PATH: path,
    HOME: ctx.home_dir,
    USERPROFILE: ctx.home_dir,
    PES_HOME: ctx.pes_home,
    TMPDIR: ctx.tmp,
    TEMP: ctx.tmp,
    TMP: ctx.tmp,
    PES_INSTALL_MIRROR: mirror,
    PES_INSTALL_PATH_ONLY: "1",
    PES_SKIP_KEYS: "1",
    PES_SKIP_TOOLS: "1",
    PES_TEST_LOG_DIR: logs,
    PES_HUB_PORTS: `${port}-${port}`,
    // Windows needs these to resolve `git` → git.cmd and to start powershell.exe at all (PR #58 windows run 43094452053:
    // without PATHEXT the fakes were invisible and 'powershell' was "not recognized")
    ...(WIN ? { PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD", SystemRoot: process.env.SystemRoot ?? "C:\\Windows", windir: process.env.windir ?? process.env.SystemRoot ?? "C:\\Windows", ComSpec: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", SystemDrive: process.env.SystemDrive ?? "C:" } : {}),
    PES_TEST_GUARD: "1",
    PES_TEST_REAL_HOME: real_homes().join(delimiter),
    NODE_OPTIONS: `--import ${pathToFileURL(GUARD).href}`,
    LANG: "C.UTF-8",
  };
  if (WIN) {
    env.SystemRoot = process.env.SystemRoot ?? "C:\\Windows";
    env.LOCALAPPDATA = join(ctx.home_dir, "AppData", "Local");
    env.APPDATA = join(ctx.home_dir, "AppData", "Roaming");
  }
  return { ctx, bin, logs, mirror, home: ctx.home_dir, src: join(ctx.home_dir, ".pes", "src"), env, cleanup: () => ctx.cleanup() };
}

interface Ran {
  status: number | null;
  out: string;
}

function norm(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\u001b\[[0-9;]*m/g, "");
}

function run_script(s: Scene, script: string, extra: Record<string, string> = {}, args: string[] = []): Ran {
  // Safety: a script without the seams would use the REAL tools of this machine (/opt/homebrew/bin first in its own PATH, a network download,
  // a real `brew install`). Refuse to start it — the seams are a requirement of their own (D6).
  const text = readFileSync(join(REPO, "scripts", `${script}.${WIN ? "ps1" : "sh"}`), "utf8");
  const need = script === "bootstrap" ? ["PES_INSTALL_PATH_ONLY"] : script === "install-desktop" ? ["PES_INSTALL_MIRROR"] : ["PES_INSTALL_PATH_ONLY", "PES_INSTALL_MIRROR", "PES_SKIP_TOOLS"];
  for (const name of need) assert.ok(text.includes(name), `scripts/${script} has no ${name} seam yet — not run (it would touch this machine's real tools and network)`);
  const env = { ...s.env, ...extra };
  const result = WIN
    ? spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(REPO, "scripts", `${script}.ps1`), ...args], { env, cwd: s.home, encoding: "utf8", timeout: 600_000, input: "" })
    : spawnSync("/bin/sh", [join(REPO, "scripts", `${script}.sh`), ...args], { env, cwd: s.home, encoding: "utf8", timeout: 300_000, input: "" });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, out: norm(`${result.stdout ?? ""}${result.stderr ?? ""}`) };
}

const log_of = (s: Scene, name: string): string => (existsSync(join(s.logs, name)) ? readFileSync(join(s.logs, name), "utf8") : "");

function assert_no_python_no_network(s: Scene, ran: Ran, what: string): void {
  assert.equal(log_of(s, "python.log"), "", `${what}: Python was called`);
  assert.equal(log_of(s, "curl.log"), "", `${what}: the network branch was taken (curl)`);
  assert.doesNotMatch(ran.out, /python/i, `${what}: the output mentions Python`);
}

function assert_installed(s: Scene, ran: Ran, what: string): void {
  assert.equal(ran.status, 0, `${what}: exit ${ran.status}\n${ran.out}`);
  for (const n of [1, 2, 3, 4, 5, 6]) assert.match(ran.out, new RegExp(`\\[${n}/6\\]`), `${what}: step ${n}`);
  assert.match(ran.out, /완료/, `${what}: the closing line`);
  assert.ok(existsSync(join(s.src, "scripts", "setup.ts")), `${what}: ~/.pes/src/scripts/setup.ts`);
  assert.ok(existsSync(join(s.src, "scripts", "pes.ts")), `${what}: ~/.pes/src/scripts/pes.ts`);
  const claude = log_of(s, "claude.log");
  assert.match(claude, /plugin marketplace add/, `${what}: the marketplace was added`);
  assert.match(claude, /plugin install pes@pes-local|plugin update pes@pes-local/, `${what}: the plugin was installed`);
  assert_no_python_no_network(s, ran, what);
  assert.ok(existsSync(join(s.home, ".pes", "setup.json")), `${what}: the completion mark (~/.pes/setup.json)`);
}

/** a 0.15 install laid over: ~/.pes/src with the old Python tools and an old completion mark */
function seed_v015_install(s: Scene): number {
  mkdirSync(join(s.src, ".git"), { recursive: true });
  mkdirSync(join(s.src, "scripts"), { recursive: true });
  for (const f of ["setup.py", "pes.py", "serve.py"]) writeFileSync(join(s.src, "scripts", f), "# PES 0.15 (old)\n", "utf8");
  const mark = join(s.home, ".pes", "setup.json");
  writeFileSync(mark, JSON.stringify({ version: "0.15.6", at: "2026-01-01 00:00", src: s.src }), "utf8");
  const old = new Date("2026-01-01T00:00:00Z");
  utimesSync(mark, old, old);
  return old.getTime();
}

function node_needed_ok(s: Scene): void {
  const run = spawnSync(process.execPath, [join(s.src, "scripts", "setup.ts"), "needed"], { env: { ...s.env, NODE_OPTIONS: s.env.NODE_OPTIONS }, cwd: s.home, encoding: "utf8", timeout: 120_000 });
  assert.equal(run.status, 0, `setup.ts needed after the install: ${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /OK/);
}

// ---------------------------------------------------------------------------
// install.sh

test("D13: install.sh (macOS/Linux) — a clean temporary HOME installs with Node only: six steps, plugin registered, ~/.pes/src from the mirror, no Python, no network", { skip: SH_ONLY, timeout: 600_000 }, async () => {
  const before = claude_snapshot();
  const s = await scene("pes-sel74-d13-");
  try {
    const ran = run_script(s, "install");
    assert_installed(s, ran, "install.sh");
    node_needed_ok(s);
  } finally {
    s.cleanup();
  }
  assert.equal(claude_snapshot(), before, "the real ~/.claude is as it was");
});

test("D14: install.sh upgrades over a 0.15 install (old ~/.pes/src with Python tools + an old completion mark): passes, new TypeScript tools in place, the mark rewritten", { skip: SH_ONLY, timeout: 600_000 }, async () => {
  const s = await scene("pes-sel74-d14-");
  try {
    const seeded_at = seed_v015_install(s);
    const ran = run_script(s, "install");
    assert_installed(s, ran, "upgrade over 0.15");
    const mark = join(s.home, ".pes", "setup.json");
    assert.ok(statMs(mark) > seeded_at, "the completion mark was rewritten by this run");
    JSON.parse(readFileSync(mark, "utf8"));
    node_needed_ok(s);
    // and running it again (the user runs the one-liner twice) is fine
    const again = run_script(s, "install");
    assert_installed(s, again, "second run");
  } finally {
    s.cleanup();
  }
});

function statMs(file: string): number {
  return lstatSync(file).mtimeMs;
}

test("D15: install.sh stops with a Korean Node 26 message when node is older than 26 — exit 1, nothing fetched into ~/.pes/src, no Python", { skip: SH_ONLY, timeout: 300_000 }, async () => {
  const s = await scene("pes-sel74-d15-", "v20.11.0");
  try {
    const ran = run_script(s, "install");
    assert.notEqual(ran.status, 0, ran.out);
    assert.match(ran.out, /Node(?:\.js)?\s*26/, ran.out);
    assert.equal(existsSync(join(s.src, "scripts")), false, "nothing was fetched");
    assert.equal(log_of(s, "claude.log"), "", "no plugin work before the runtime is right");
    assert_no_python_no_network(s, ran, "old node");
  } finally {
    s.cleanup();
  }
});

test("D16: bootstrap.sh --check — node 26 is OK and the last line names the node command; node 20 or missing is MISSING/FAIL naming 26; no Python line ever", { skip: SH_ONLY, timeout: 300_000 }, async () => {
  for (const [node, expect_ok] of [["real", true], ["v26.0.0", true], ["v20.11.0", false], ["none", false]] as const) {
    const s = await scene("pes-sel74-d16-", node);
    try {
      const ran = run_script(s, "bootstrap", {}, ["--check"]);
      const lines = ran.out.split("\n").filter((l) => l !== "");
      assert.ok(lines.some((l) => /^OK git /.test(l)), `${node}: git line`);
      if (expect_ok) {
        assert.ok(lines.some((l) => /^OK node v2[6-9]|^OK node v[3-9]\d/.test(l)), `${node}: OK node\n${ran.out}`);
        assert.match(lines[lines.length - 1] as string, /^NODE \S+/, `${node}: last line NODE <command>`);
        assert.notEqual(lines[lines.length - 1], "NODE none");
      } else {
        assert.ok(lines.some((l) => /^(MISSING|FAIL) node\b.*26/.test(l)), `${node}: MISSING/FAIL node … 26\n${ran.out}`);
        assert.equal(lines[lines.length - 1], "NODE none", `${node}: last line`);
      }
      assert.doesNotMatch(ran.out, /python/i, `${node}: no Python line`);
    } finally {
      s.cleanup();
    }
  }
});

test("D17: bootstrap.sh without --check and without node installs it with Homebrew (`brew install … node`) and reports INSTALLED node", { skip: SH_ONLY, timeout: 300_000 }, async () => {
  const s = await scene("pes-sel74-d17-", "none", { brew: true });
  try {
    const ran = run_script(s, "bootstrap");
    assert.match(log_of(s, "brew.log"), /brew install .*node/, "brew was asked for node");
    assert.match(ran.out, /^INSTALLED node v26/m, ran.out);
    assert.match(ran.out.trim().split("\n").pop() as string, /^NODE \S+/);
    assert_no_python_no_network(s, ran, "bootstrap install");
  } finally {
    s.cleanup();
  }
});

test("D18: install-desktop.sh (Claude Desktop only, none found): registers the PES marketplace in the temporary ~/.claude/settings.json — other keys kept, the old file saved as settings.json.bak-pes", { skip: SH_ONLY, timeout: 600_000 }, async () => {
  const s = await scene("pes-sel74-d18-", "real", { claude: false });
  try {
    const settings = join(s.home, ".claude", "settings.json");
    mkdirSync(dirname(settings), { recursive: true });
    const original = JSON.stringify({ theme: "dark", enabledPlugins: { "x@y": true }, extraKnownMarketplaces: { other: { source: { source: "github", repo: "a/b" } } } }, null, 2);
    writeFileSync(settings, original, "utf8");
    const ran = run_script(s, "install-desktop");
    assert.equal(ran.status, 0, ran.out);
    const now = JSON.parse(readFileSync(settings, "utf8")) as Record<string, any>;
    assert.equal(now.theme, "dark", "other keys are kept");
    assert.equal(now.enabledPlugins["x@y"], true);
    assert.equal(now.enabledPlugins["pes@pes-local"], true);
    assert.deepEqual(now.extraKnownMarketplaces.other, { source: { source: "github", repo: "a/b" } });
    assert.equal(now.extraKnownMarketplaces["pes-local"].source.source, "github");
    assert.match(now.extraKnownMarketplaces["pes-local"].source.repo, /pes/);
    assert.equal(readFileSync(`${settings}.bak-pes`, "utf8"), original, "the backup is the old file, byte for byte");
    assert_no_python_no_network(s, ran, "install-desktop.sh");
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// install.ps1 (Windows only)

test("D19: install.ps1 (Windows) — a clean temporary USERPROFILE installs with Node only: six steps, plugin registered, ~/.pes/src from the mirror, no Python, no network", { skip: PS_ONLY, timeout: 900_000 }, async () => {
  const s = await scene("pes-sel74-d19-");
  try {
    const ran = run_script(s, "install");
    assert_installed(s, ran, "install.ps1");
    node_needed_ok(s);
  } finally {
    s.cleanup();
  }
});

test("D20: install.ps1 upgrades over a 0.15 install and a second run passes too", { skip: PS_ONLY, timeout: 900_000 }, async () => {
  const s = await scene("pes-sel74-d20-");
  try {
    const seeded_at = seed_v015_install(s);
    const ran = run_script(s, "install");
    assert_installed(s, ran, "upgrade over 0.15");
    assert.ok(statMs(join(s.home, ".pes", "setup.json")) > seeded_at, "the mark was rewritten");
    assert_installed(s, run_script(s, "install"), "second run");
  } finally {
    s.cleanup();
  }
});

test("D21: bootstrap.ps1 -CheckOnly — OK node, last line `NODE <command>`, no Python line; install.ps1 stops with a Node 26 message when node is older", { skip: PS_ONLY, timeout: 600_000 }, async () => {
  const ok = await scene("pes-sel74-d21-");
  try {
    const ran = run_script(ok, "bootstrap", {}, ["-CheckOnly"]);
    const lines = ran.out.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    assert.ok(lines.some((l) => /^OK node v/.test(l)), ran.out);
    assert.match(lines[lines.length - 1] as string, /^NODE \S+/);
    assert.doesNotMatch(ran.out, /python/i);
  } finally {
    ok.cleanup();
  }
  const old = await scene("pes-sel74-d21b-", "v20.11.0");
  try {
    // the shim `node.cmd` comes first on PATH and answers v20
    const ran = run_script(old, "install");
    assert.notEqual(ran.status, 0, ran.out);
    assert.match(ran.out, /Node(?:\.js)?\s*26/);
    assert.equal(existsSync(join(old.src, "scripts")), false);
  } finally {
    old.cleanup();
  }
});

test("D22: install-desktop.ps1 (none found): registers the marketplace in the temporary .claude\\settings.json, other keys kept, .bak-pes is the old file", { skip: PS_ONLY, timeout: 900_000 }, async () => {
  const s = await scene("pes-sel74-d22-", "real", { claude: false });
  try {
    const settings = join(s.home, ".claude", "settings.json");
    mkdirSync(dirname(settings), { recursive: true });
    const original = JSON.stringify({ theme: "dark", enabledPlugins: { "x@y": true } }, null, 2);
    writeFileSync(settings, original, "utf8");
    const ran = run_script(s, "install-desktop");
    assert.equal(ran.status, 0, ran.out);
    const now = JSON.parse(readFileSync(settings, "utf8")) as Record<string, any>;
    assert.equal(now.theme, "dark");
    assert.equal(now.enabledPlugins["pes@pes-local"], true);
    assert.ok(now.extraKnownMarketplaces["pes-local"]);
    assert.equal(readFileSync(`${settings}.bak-pes`, "utf8").replace(/^\uFEFF/, ""), original);
    assert_no_python_no_network(s, ran, "install-desktop.ps1");
  } finally {
    s.cleanup();
  }
});

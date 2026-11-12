// SEL-103 — "does this test run start in the real account home?", decided from STRINGS ONLY.
//
// Why it exists: the home guard (home_guard.ts) takes a before / after listing of <home>/.pes and <home>/pes-projects. When the run itself has the real
// account home as HOME, that very listing (lstat · readdir) is a look at the real home. So this check comes first and touches no file system path at all:
//   * no lstat / readdir / realpath / exists — only string comparison (os.userInfo() asks the account database, it opens no path);
//   * it has no imports besides node:os and node:path, so nothing it loads can look at a path either.
// A symlink alias of the real home (a temp folder that is a link to it) cannot be seen from a spelling; that is the job of the later layers
// (touches_protected / the child guard's realpath) — documented in tests/README.md.
//
// "Real home" here is:
//   * os.userInfo().homedir  — the account's home, whatever $HOME says;
//   * the usual shapes of an account home: /Users/<x> · /home/<x> · /root · <drive>:\Users\<x> — even when userInfo() cannot be asked;
//   * the folders named in PES_TEST_ACCOUNT_HOME (path.delimiter-separated) — the way the guard's own tests inject a FAKE account home. This variable
//     can only ADD homes to refuse; it can never make a refused HOME acceptable.
// HOME / USERPROFILE is refused when it IS such a home, is a parent of one, or lies inside its .pes · pes-projects · .claude; or when the variable that
// drives os.homedir() on this OS (HOME on macOS / Linux, USERPROFILE on Windows) is empty or not absolute — Node then falls back to the passwd entry,
// which is the real home again. The other variable is judged only when it is set.

import { userInfo } from "node:os";
import { delimiter } from "node:path";

/** Folders of a real home no test may look at (home_guard.ts re-exports this; `.claude` is denied only, never compared before / after). */
export const PROTECTED_NAMES = [".pes", "pes-projects", ".claude"] as const;

const HOME_KEYS = ["HOME", "USERPROFILE"] as const;
type HomeKey = (typeof HOME_KEYS)[number];

/** `/Users/<x>` · `/home/<x>` · `/root` · `<drive>:/Users/<x>` (after canon()). */
const ACCOUNT_SHAPE = /^(?:[a-z]:)?\/(?:users|home)\/[^/]+$|^\/root$/i;

function folds_case(platform: string): boolean {
  return platform === "win32" || platform === "darwin";
}

/**
 * A platform-independent spelling of an absolute path: `\` → `/`, `.` / `..` / `//` resolved textually, no trailing `/`, a drive letter kept,
 * case folded on the case-insensitive systems. `undefined` for a relative path. Never touches the file system (not even the cwd).
 */
function canon(path: string, fold: boolean): string | undefined {
  const text = path.split("\\").join("/");
  const drive = /^[A-Za-z]:(?=\/|$)/.exec(text)?.[0] ?? "";
  const rest = text.slice(drive.length);
  if (!rest.startsWith("/") && !(drive !== "" && rest === "")) return undefined;
  const stack: string[] = [];
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  const out = `${drive}/${stack.join("/")}`;
  return fold ? out.toLowerCase() : out;
}

function inside_or_same(path: string, folder: string): boolean {
  if (path === folder) return true;
  return path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);
}

/** Why `value` (the content of `key`) may not be the home of a test run — `undefined` when it is acceptable. */
function problem_with(key: HomeKey, value: string, account_homes: readonly string[], fold: boolean): string | undefined {
  const home = canon(value, fold);
  if (home === undefined) return `${key} 가 절대 경로가 아니다`;
  if (ACCOUNT_SHAPE.test(home)) return `${key} 가 계정 홈 모양(/Users/x · /home/x · C:\\Users\\x)이다`;
  for (const account of account_homes) {
    const real = canon(account, fold);
    if (real === undefined) continue;
    if (home === real) return `${key} 가 계정의 실제 홈이다`;
    if (inside_or_same(real, home)) return `${key} 가 계정의 실제 홈을 품은 폴더다`;
    for (const name of PROTECTED_NAMES) {
      if (inside_or_same(home, `${real}/${fold ? name.toLowerCase() : name}`)) return `${key} 가 실제 홈의 ${name} 안이다`;
    }
  }
  return undefined;
}

/**
 * The first reason the run's home is the real one (or cannot be told apart from it), or `undefined`. `account_homes` is the injected "real home" list
 * (see default_account_homes); `platform` decides which variable drives os.homedir() and whether paths compare case-insensitively.
 */
export function real_home_problem(env: Record<string, string | undefined>, account_homes: readonly string[], platform: string = process.platform): string | undefined {
  const fold = folds_case(platform);
  const driving: HomeKey = platform === "win32" ? "USERPROFILE" : "HOME";
  for (const key of HOME_KEYS) {
    const value = env[key];
    if (value === undefined || value === "") {
      if (key === driving) return `${key} 가 비어 있다 (Node 는 계정 DB 의 실제 홈으로 되돌아간다)`;
      continue;
    }
    const problem = problem_with(key, value, account_homes, fold);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** os.userInfo().homedir (HOME ignored) plus the homes injected through PES_TEST_ACCOUNT_HOME — strings only. */
export function default_account_homes(env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = [];
  try {
    const account = userInfo().homedir;
    if (account) out.push(account);
  } catch {
    // no account database entry (some containers): the shape check still applies
  }
  for (const injected of (env.PES_TEST_ACCOUNT_HOME ?? "").split(delimiter)) if (injected !== "") out.push(injected);
  return out;
}

/** Throws before anything is listed or opened when the run starts in the real account home. */
export function assert_temp_home_env(env: Record<string, string | undefined> = process.env, account_homes: readonly string[] = default_account_homes(env)): void {
  const problem = real_home_problem(env, account_homes);
  if (problem === undefined) return;
  throw new Error(`home guard: 실제 계정 홈에서는 시험을 시작할 수 없다 — 임시 HOME 으로 실행하라 (${problem}). 예: HOME="$(mktemp -d)" USERPROFILE="$HOME" npm test (Windows PowerShell: $env:HOME = $env:USERPROFILE = Join-Path $env:TEMP "pes-test-home")`);
}

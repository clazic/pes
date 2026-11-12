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
// HOME / USERPROFILE is refused when it IS such a home, is a parent of one, or lies inside its .pes · pes-projects · .claude (the account-home SHAPES get the same
// parent / protected-folder treatment); when it is not an absolute path (relative, drive-relative `D:` · `D:foo`, an unreadable `\\?\Volume{…}` namespace) — a Windows
// namespace spelling (`\\?\C:\…` · `\\.\C:\…` · `\??\C:\…` · `\\localhost\c$\…`) is first rewritten to the plain drive path; or when the variable that
// drives os.homedir() on this OS (HOME on macOS / Linux, USERPROFILE on Windows) is empty or not absolute — Node then falls back to the passwd entry,
// which is the real home again. The other variable is judged only when it is set.

import { userInfo } from "node:os";
import { delimiter } from "node:path";

/** Folders of a real home no test may look at (home_guard.ts re-exports this; `.claude` is denied only, never compared before / after). */
export const PROTECTED_NAMES = [".pes", "pes-projects", ".claude"] as const;

const HOME_KEYS = ["HOME", "USERPROFILE"] as const;
type HomeKey = (typeof HOME_KEYS)[number];

/** The root of an account-home SHAPE: `/Users/<x>` · `/home/<x>` · `/root` · `<drive>:/Users/<x>` (after canon()) — what follows (if anything) starts with `/`. */
const SHAPE_ROOT = /^(?:[a-z]:)?(?:\/(?:users|home)\/[^/]+|\/root)(?=\/|$)/i;
/** The parents of such homes: `/` · `/Users` · `/home` · `<drive>:/` · `<drive>:/Users` (after canon()). */
const SHAPE_PARENT = /^(?:[a-z]:)?\/(?:users|home)?$/i;

function folds_case(platform: string): boolean {
  return platform === "win32" || platform === "darwin";
}

/** `//host/<x>$/rest` — the administrative share of drive `<x>` on ANY host (`localhost` · `127.0.0.1` · this machine's name · …; refusing more is the safe side) — is the drive path `<x>:/rest`. */
function admin_share_drive_path(text: string): string | undefined {
  const share = /^\/\/[^/]+\/([A-Za-z])\$(\/.*)?$/s.exec(text);
  return share === null ? undefined : `${share[1]}:${share[2] ?? "/"}`;
}

/**
 * Removes a Windows namespace prefix so the SAME place has one spelling (`/` separators already): `//?/C:/x` · `//./C:/x` · `/??/C:/x` → `C:/x`,
 * `//?/UNC/localhost/c$/x` → `C:/x`, a plain `//localhost/c$/x` → `C:/x`. A namespace that is not a drive or UNC path (`//?/Volume{…}/…`, `//?/GLOBALROOT/…`,
 * `//./PhysicalDrive0`, `//?/`) cannot be told from the real home by spelling → `undefined` (refused). Any other `//host/share/…` is left to canon(), which
 * collapses the doubled slash exactly like a POSIX `//Users/x` — so no spelling of the real home slips through on either OS.
 */
function strip_windows_namespace(text: string): string | undefined {
  const namespaced = /^\/\/[?.]\/(.*)$/s.exec(text) ?? /^\/\?\?\/(.*)$/s.exec(text);
  if (namespaced === null) return admin_share_drive_path(text) ?? text;
  const rest = namespaced[1] ?? "";
  const unc = /^unc(?:\/(.*))?$/is.exec(rest);
  if (unc !== null) return admin_share_drive_path(`//${unc[1] ?? ""}`) ?? `//${unc[1] ?? ""}`;
  if (/^[A-Za-z]:(?:\/|$)/.test(rest)) return rest;
  return undefined;
}

/**
 * A platform-independent spelling of an absolute path: `\` → `/`, namespace prefixes removed, `.` / `..` / `//` resolved textually, no trailing `/`, a drive
 * letter kept, case folded on the case-insensitive systems. `undefined` for a path that is not absolute — relative, a drive-relative `D:` · `D:foo` (meaning
 * depends on that drive's current directory) — or whose namespace cannot be read. A root-relative path (`/x` with no drive: on Windows the current drive's
 * root) is returned without a drive. Never touches the file system (not even the cwd).
 */
function canon(path: string, fold: boolean): string | undefined {
  const text = strip_windows_namespace(path.split("\\").join("/"));
  if (text === undefined) return undefined;
  const drive = /^[A-Za-z]:/.exec(text)?.[0] ?? "";
  const rest = text.slice(drive.length);
  if (!rest.startsWith("/")) return undefined;
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
  if (home === undefined) return `${key} 가 절대 경로가 아니거나 읽을 수 없는 표기다 (상대 경로·D: 같은 드라이브 상대 경로·알 수 없는 \\\\?\\ 네임스페이스)`;
  if (SHAPE_PARENT.test(home)) return `${key} 가 계정 홈의 부모 폴더(/ · /Users · /home · C:\\ · C:\\Users)다`;
  const shape = SHAPE_ROOT.exec(home);
  if (shape !== null) {
    const below = home.slice(shape[0].length).split("/")[1];
    if (below === undefined) return `${key} 가 계정 홈 모양(/Users/x · /home/x · C:\\Users\\x)이다`;
    const protected_name = PROTECTED_NAMES.find((name) => name === below.toLowerCase());
    if (protected_name !== undefined) return `${key} 가 계정 홈 모양의 ${protected_name} 안이다`;
  }
  const drive_less = home.startsWith("/"); // root-relative: the drive it lives on is the current one — compare without the drive
  for (const account of account_homes) {
    let real = canon(account, fold);
    if (real === undefined) continue;
    if (drive_less) real = real.replace(/^[a-z]:/i, "");
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

/**
 * SEL-103: is `path` (the spelling alone — no fs call) one of the account's real homes? Used to leave the real account home out of every listing: the
 * default listing holds only the temporary HOME and the fake homes a test injects. Same spelling rules as the start check (canon()).
 */
export function is_account_home(path: string, account_homes: readonly string[] = default_account_homes(), platform: string = process.platform): boolean {
  const fold = folds_case(platform);
  const home = canon(path, fold);
  if (home === undefined) return false;
  return account_homes.some((account) => canon(account, fold) === home);
}

/** Throws before anything is listed or opened when the run starts in the real account home. */
export function assert_temp_home_env(env: Record<string, string | undefined> = process.env, account_homes: readonly string[] = default_account_homes(env)): void {
  const problem = real_home_problem(env, account_homes);
  if (problem === undefined) return;
  throw new Error(`home guard: 실제 계정 홈에서는 시험을 시작할 수 없다 — 임시 HOME 으로 실행하라 (${problem}). 예: test_home="$(mktemp -d)"; HOME="$test_home" USERPROFILE="$test_home" npm test (Windows PowerShell: $env:HOME = $env:USERPROFILE = Join-Path $env:TEMP "pes-test-home")`);
}

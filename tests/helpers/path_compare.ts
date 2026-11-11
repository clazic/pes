// Path comparison that survives Windows (CI windows-latest): 8.3 short names (RUNNER~1) via realpathSync.native, a case-insensitive
// file system (compared lower-case on win32 ONLY — POSIX stays case-sensitive), `\` vs `/`, and the `\*` / `/*` tail of a permission flag.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** Pure: the comparison key of one path spelling. `win` = fold case (the file system ignores it). */
export function path_key(path: string, win: boolean): string {
  let out = path.replace(/\\/g, "/").replace(/\/+/g, "/");
  out = out.replace(/\/\*$/, "").replace(/(.)\/+$/, "$1");
  return win ? out.toLowerCase() : out;
}

/** The key of an existing or not-yet-existing path: native realpath first (8.3 → long name, /private/var → /var is NOT folded: both spellings are kept by the caller). */
export function path_key_native(path: string, win: boolean = process.platform === "win32"): string {
  const bare = path.replace(/[\\/]\*$/, "");
  let real = bare;
  try {
    real = realpathSync.native(bare);
  } catch {
    real = resolve(bare);
  }
  return path_key(real, win);
}

/** True when `child` is `root` itself or below it (either may carry a `\*` tail). Both spellings of the root (given and native) count. */
export function is_at_or_below(child: string, root: string, win: boolean = process.platform === "win32"): boolean {
  const roots = new Set([path_key(root, win), path_key_native(root, win)]);
  const keys = new Set([path_key(child, win), path_key_native(child, win)]);
  for (const k of keys) for (const r of roots) if (k === r || k.startsWith(`${r}/`)) return true;
  return false;
}

// SEL-103 test tool (`--import`, loaded BEFORE require_temp_home.ts): records every path-taking fs call whose path lies inside PES_FS_WATCH
// (path.delimiter-separated folders) as one line `<function> <absolute path>` appended to the file PES_FS_LOG. Used to prove that a run refused at start
// made ZERO fs calls on the (fake) account home — test_sel103_real_home_precheck. Only the first two arguments are looked at (one- and two-path functions);
// a file descriptor or anything else that is not a path is ignored. Calls are passed through unchanged. Without PES_FS_LOG / PES_FS_WATCH it does nothing.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { delimiter, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const log = process.env.PES_FS_LOG;
const fold = process.platform === "win32" || process.platform === "darwin";
const spell = (path: string): string => (fold ? path.toLowerCase() : path);
const watched = (process.env.PES_FS_WATCH ?? "").split(delimiter).filter((folder) => folder !== "").map((folder) => spell(resolve(folder)));

if (log !== undefined && log !== "" && watched.length > 0) {
  const append = fs.appendFileSync; // the original, taken before anything is wrapped
  let busy = false;

  const path_of = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (Buffer.isBuffer(value)) return value.toString("utf8");
    if (value instanceof URL) {
      try {
        return fileURLToPath(value);
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  const note = (name: string, args: unknown[]): void => {
    if (busy) return;
    for (const value of args.slice(0, 2)) {
      const path = path_of(value);
      if (path === undefined || path === "") continue;
      const full = resolve(path);
      const key = spell(full);
      if (watched.some((folder) => key === folder || key.startsWith(`${folder}${sep}`))) {
        busy = true;
        try {
          append(log, `${name} ${full}\n`);
        } finally {
          busy = false;
        }
      }
    }
  };

  const wrap_all = (target: Record<string, any>, label: string): void => {
    for (const name of Object.getOwnPropertyNames(target)) {
      if (!/^[a-z]/.test(name)) continue; // classes (Stats · ReadStream · Dirent …) and constants
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      const original = descriptor?.value;
      if (typeof original !== "function" || descriptor?.writable !== true) continue;
      const wrapped: any = function (this: unknown, ...args: unknown[]): unknown {
        note(`${label}${name}`, args);
        return original.apply(this, args);
      };
      for (const key of Object.keys(original)) wrapped[key] = original[key]; // e.g. realpathSync.native
      target[name] = wrapped;
      if (typeof wrapped.native === "function") {
        const native = wrapped.native as (...args: unknown[]) => unknown;
        wrapped.native = function (this: unknown, ...args: unknown[]): unknown {
          note(`${label}${name}.native`, args);
          return native.apply(this, args);
        };
      }
    }
  };

  wrap_all(fs as unknown as Record<string, any>, "");
  wrap_all(fs.promises as unknown as Record<string, any>, "promises.");
  syncBuiltinESMExports();
}

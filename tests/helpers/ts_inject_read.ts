// Test-only fault injection for TypeScript children (SEL-71 review 1, recommendation 9): reading ONE named file fails with an OS error
// code (EPERM — what Windows answers for an unreadable file — or EACCES). Loaded with `--import` (compat_ts `imports`), after the home guard.
// SEL71_READ_FAIL = JSON {"name": "<basename>", "code": "EPERM" | "EACCES" | "EISDIR" | "ENOENT"}. Only fs.readFileSync of that basename
// throws; everything else (including every other file) goes through. No file under scripts/ changes.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";

interface Config {
  name?: string;
  code?: "EPERM" | "EACCES" | "EISDIR" | "ENOENT";
}

const cfg = JSON.parse(process.env.SEL71_READ_FAIL ?? "{}") as Config;
const ERRNO = { EPERM: -1, EACCES: -13, EISDIR: -21, ENOENT: -2 } as const;
const TEXT = { EPERM: "operation not permitted", EACCES: "permission denied", EISDIR: "illegal operation on a directory", ENOENT: "no such file or directory" } as const;
const original = fs.readFileSync.bind(fs);

if (cfg.name !== undefined && cfg.code !== undefined) {
  const code = cfg.code;
  (fs as unknown as { readFileSync: unknown }).readFileSync = function (this: unknown, ...args: unknown[]): unknown {
    const target = args[0];
    if (typeof target === "string" && basename(target) === cfg.name) {
      throw Object.assign(new Error(`${code}: ${TEXT[code]}, open '${target}'`), { code, errno: ERRNO[code], syscall: "open", path: target });
    }
    return (original as (...a: unknown[]) => unknown)(...args);
  };
  syncBuiltinESMExports();
}

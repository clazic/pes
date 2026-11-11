// Test-only guard for TypeScript children (SEL-71, PR26b): `node --import tests/helpers/ts_child_guard.ts scripts/pes.ts …`.
//
// The Python children of the compat harness run the audit hook of tests/conftest.py. A Node child has no audit hook, so this module is
// its counterpart. It is loaded with `--import` BEFORE the script, in the child, and does three things:
//   1. Real-home read guard. Every `node:fs` / `node:fs/promises` function that takes a path (open, read, stat, readdir, access,
//      exists, realpath, copy, rename … reads AND writes) and `new DatabaseSync(path)` first checks the path against the protected
//      folders `<real home>/.pes` and `<real home>/pes-projects`. A hit writes `PESHomeAccessViolation: <function> <path>` to stderr
//      (so the harness fails even when the product code catches the error) and throws EACCES. The real homes come from
//      PES_TEST_REAL_HOME (the account home; the guard self-test passes a fake one), several separated by `path.delimiter`.
//      Symlinks / junctions / 8.3 names are seen through `realpath` of the longest existing prefix.
//   2. Hub block. Nothing may connect to 127.0.0.1:8760~8775 (the hub ports, tests/helpers/hub_block.ts): `net.Socket#connect` and
//      `fetch` answer ECONNREFUSED, as if no server ran there. PES_TEST_ALLOW_HUB_PORT (comma list) keeps ports open for a test that
//      starts its own stand-in. Every blocked attempt is appended to the file named by PES_TEST_HUB_LOG (when set).
//   3. Nothing else: no fake clock, no injection (the SEL-75 injection is the separate ts_inject_fs.ts).
// It is a second safety net behind `node --permission` (compat_ts.ts gives the child an allow-list that does not contain the real
// home, so the kernel-level denial is the first net and this module is the one that REPORTS an attempt). Not covered: native
// addons, `process.binding`, a path built from another process (grandchildren — `--allow-child-process` is off by default).

import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports, createRequire } from "node:module";
import net from "node:net";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";

const orig = {
  writeSync: fs.writeSync.bind(fs),
  appendFileSync: fs.appendFileSync.bind(fs),
  realpathSync: fs.realpathSync.native.bind(fs.realpathSync),
  readlinkSync: fs.readlinkSync.bind(fs),
};

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
const fold = (value: string): string => (CASE_INSENSITIVE ? value.toLowerCase() : value);

function protected_roots(): string[] {
  const homes = (process.env.PES_TEST_REAL_HOME ?? "").split(delimiter).filter((x) => x !== "");
  const out = new Set<string>();
  for (const home of homes) {
    const spellings = new Set<string>([resolve(home)]);
    try {
      spellings.add(orig.realpathSync(home));
    } catch {
      // the home does not exist: its plain spelling is all there is
    }
    for (const base of spellings) for (const name of [".pes", "pes-projects"]) out.add(join(base, name));
  }
  return [...out];
}

const ROOTS = process.env.PES_TEST_GUARD === "1" ? protected_roots() : [];

function inside(path: string, folder: string): boolean {
  const rel = relative(fold(folder), fold(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The path with every symlink / junction / 8.3 name below it resolved, as far as the child may look. The native realpath is tried
 * first; when `--permission` denies it (a link inside the allowed temp root that points outside it), the links are followed by hand
 * with readlink on each existing prefix, so an alias of the real `.pes` is still recognised.
 */
function through_links(path: string, depth = 0): string {
  const full = resolve(path);
  if (depth > 16) return full;
  let head = full;
  const tail: string[] = [];
  for (;;) {
    const rest = [...tail].reverse();
    try {
      const target = orig.readlinkSync(head);
      return through_links(join(resolve(dirname(head), target), ...rest), depth + 1);
    } catch {
      // not a link (or not readable): maybe a plain existing prefix
    }
    try {
      return join(orig.realpathSync(head), ...rest);
    } catch {
      const parent = dirname(head);
      if (parent === head) return full;
      tail.push(basename(head));
      head = parent;
    }
  }
}

function as_path(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg instanceof URL) return arg.protocol === "file:" ? decodeURIComponent(arg.pathname.replace(/^\/([A-Za-z]:)/, "$1")) : undefined;
  if (Buffer.isBuffer(arg)) return arg.toString("utf8");
  return undefined;
}

function violates(arg: unknown): string | undefined {
  const text = as_path(arg);
  if (text === undefined || text === "") return undefined;
  const plain = resolve(text);
  if (ROOTS.some((root) => inside(plain, root))) return plain;
  const real = through_links(plain);
  return ROOTS.some((root) => inside(real, root)) ? real : undefined;
}

function fail(name: string, path: string): never {
  try {
    orig.writeSync(2, `PESHomeAccessViolation: ${name} ${path}\n`);
  } catch {
    // stderr gone: the throw below still happens
  }
  throw Object.assign(new Error(`EACCES: PESHomeAccessViolation ${name} '${path}'`), { code: "EACCES", syscall: name, path });
}

type AnyFn = (...args: unknown[]) => unknown;

function guarded(name: string, fn: AnyFn): AnyFn {
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    // the first two arguments can be paths (rename / copyFile / cp / link / symlink); a number is an fd and is skipped
    for (const arg of args.slice(0, 2)) {
      const hit = violates(arg);
      if (hit !== undefined) {
        // callback API: the error must reach the callback too, but the stderr line is already written by fail()
        try {
          fail(name, hit);
        } catch (error) {
          const callback = args[args.length - 1];
          if (typeof callback === "function") {
            (callback as (e: unknown) => void)(error);
            return undefined;
          }
          throw error;
        }
      }
    }
    return fn.apply(this, args);
  };
  Object.defineProperty(wrapped, "name", { value: fn.name });
  return wrapped as AnyFn;
}

// functions that take no path (fd based or pure) are skipped by the `typeof` test above; these are the ones never worth wrapping
const SKIP = new Set(["constants", "Stats", "Dirent", "Dir", "ReadStream", "WriteStream", "FileReadStream", "FileWriteStream", "promises", "close", "closeSync", "read", "readSync", "write", "writeSync", "fstat", "fstatSync", "futimes", "fsync", "fdatasync", "ftruncate", "fchmod", "fchown", "readv", "writev", "readvSync", "writevSync", "createWriteStream_"]);

function wrap_module(target: Record<string, unknown>, prefix: string): void {
  for (const key of Object.keys(target)) {
    const value = target[key];
    if (SKIP.has(key) || typeof value !== "function" || /^[A-Z]/.test(key)) continue;
    const wrapped = guarded(`${prefix}${key}`, value as AnyFn);
    // keep realpath.native / realpathSync.native
    for (const sub of Object.keys(value)) {
      const inner = (value as unknown as Record<string, unknown>)[sub];
      if (typeof inner === "function") (wrapped as unknown as Record<string, unknown>)[sub] = guarded(`${prefix}${key}.${sub}`, inner as AnyFn);
    }
    try {
      target[key] = wrapped;
    } catch {
      // read-only export: leave it (the permission flags are the other net)
    }
  }
}

if (ROOTS.length > 0) {
  wrap_module(fs as unknown as Record<string, unknown>, "fs.");
  wrap_module(fsp as unknown as Record<string, unknown>, "fs/promises.");
  // fs.promises is the same object as node:fs/promises
  try {
    const require = createRequire(import.meta.url);
    const sqlite = require("node:sqlite") as { DatabaseSync: new (path: unknown, ...rest: unknown[]) => unknown };
    const Original = sqlite.DatabaseSync;
    class GuardedDatabaseSync extends (Original as unknown as new (...a: unknown[]) => object) {
      constructor(path: unknown, ...rest: unknown[]) {
        const hit = violates(path);
        if (hit !== undefined) fail("sqlite.DatabaseSync", hit);
        super(path, ...rest);
      }
    }
    (sqlite as { DatabaseSync: unknown }).DatabaseSync = GuardedDatabaseSync;
  } catch {
    // node:sqlite missing: nothing to guard
  }
}

// ---------------------------------------------------------------- hub block (127.0.0.1:8760~8775)
const HUB_FIRST = 8760;
const HUB_LAST = 8775;
const ALLOWED = new Set((process.env.PES_TEST_ALLOW_HUB_PORT ?? "").split(",").filter((x) => x !== "").map(Number));

function blocked_port(port: unknown): number | undefined {
  const n = typeof port === "number" ? port : typeof port === "string" && /^\d+$/.test(port) ? Number(port) : NaN;
  return n >= HUB_FIRST && n <= HUB_LAST && !ALLOWED.has(n) ? n : undefined;
}

function note_blocked(port: number): void {
  const log = process.env.PES_TEST_HUB_LOG;
  if (log === undefined || log === "") return;
  try {
    orig.appendFileSync(log, `${port}\n`);
  } catch {
    // the log is only a test aid
  }
}

function refusal(port: number): Error {
  return Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:${port}`), { code: "ECONNREFUSED", errno: -111, syscall: "connect", address: "127.0.0.1", port });
}

const original_connect = net.Socket.prototype.connect as (...args: unknown[]) => net.Socket;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  const port = blocked_port(typeof first === "object" && first !== null ? (first as { port?: unknown }).port : first);
  if (port !== undefined) {
    note_blocked(port);
    process.nextTick(() => this.destroy(refusal(port)));
    return this;
  }
  return original_connect.apply(this, args);
} as typeof net.Socket.prototype.connect;

const original_fetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: unknown): Promise<Response> => {
  let url: URL | undefined;
  try {
    url = new URL(typeof input === "string" || input instanceof URL ? String(input) : (input as { url: string }).url);
  } catch {
    url = undefined;
  }
  const port = url === undefined ? undefined : blocked_port(url.port);
  if (port !== undefined) {
    note_blocked(port);
    throw Object.assign(new TypeError("fetch failed"), { cause: refusal(port) });
  }
  return original_fetch(input as Parameters<typeof fetch>[0], init as RequestInit);
}) as typeof fetch;

syncBuiltinESMExports();

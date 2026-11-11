// Test-only fault injection for TypeScript children (SEL-71, SEL-75 matrix): the Node twin of INJECT_CODE in
// tests/test_cli_set_lock_windows.test.ts. Loaded with `--import` after the home guard (compat_ts `imports`). No file under scripts/ changes.
//
// It makes the OS errors of a Windows "lock file is being deleted" window happen on any OS, only for the lock file name
// (`.project.json.lock` unless SEL75_INJECT.lock says otherwise), then lets the real call through:
//   open_fail k    the first k opens/creates of the lock (openSync / open / promises.open / writeFileSync·writeFile·appendFile with an
//                  exclusive flag / mkdirSync·mkdir) throw EPERM (`code` can say EACCES); -1 = every time
//   exists_fail k  the first k creates throw EEXIST (someone else holds the lock)
//   stat_fail k    the first k stat / lstat (sync, callback, promises) of the lock throw EPERM
//   unlink_fail k  the first k unlink / rm / rmdir (sync, callback, promises) of the lock throw EPERM
//   nt             while an injected EPERM is being handled — from the throw until the next patched call or sleep — `process.platform`
//                  reads "win32" (the Python twin flips os.name the same way), so the product's Windows branch runs; false = real OS
//   fake_clock     Date.now / performance.now run on a synthetic clock and every sleep (setTimeout of both timer modules, Atomics.wait,
//                  child_process spawnSync("sleep")-free) only advances it: the 30 s deadline never costs real time
// At exit the counts {open, stat, unlink, exists, slept} are written to SEL75_REPORT (JSON) — the test reads what really happened.

import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import timers from "node:timers";
import timersp from "node:timers/promises";
import { basename } from "node:path";

interface Config {
  open_fail?: number;
  stat_fail?: number;
  unlink_fail?: number;
  exists_fail?: number;
  nt?: boolean;
  fake_clock?: boolean;
  code?: "EPERM" | "EACCES";
  lock?: string;
}

const cfg = JSON.parse(process.env.SEL75_INJECT ?? "{}") as Config;
const LOCK = cfg.lock ?? ".project.json.lock";
const REAL_PLATFORM = process.platform;
const left: Record<"open" | "stat" | "unlink" | "exists", number> = { open: cfg.open_fail ?? 0, stat: cfg.stat_fail ?? 0, unlink: cfg.unlink_fail ?? 0, exists: cfg.exists_fail ?? 0 };
const hit = { open: 0, stat: 0, unlink: 0, exists: 0, slept: 0 };
const write_report = fs.writeFileSync.bind(fs);

function restore(): void {
  if (process.platform !== REAL_PLATFORM) Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
}

function take(kind: keyof typeof left): boolean {
  if (left[kind] === 0) return false;
  if (left[kind] > 0) left[kind] -= 1;
  hit[kind] += 1;
  return true;
}

function path_of(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg instanceof URL) return arg.pathname;
  if (Buffer.isBuffer(arg)) return arg.toString("utf8");
  return undefined;
}

function is_lock(arg: unknown): arg is string {
  const path = path_of(arg);
  return path !== undefined && basename(path) === LOCK;
}

function os_error(kind: "EPERM" | "EACCES" | "EEXIST", syscall: string, path: string): NodeJS.ErrnoException {
  const text = kind === "EEXIST" ? "file already exists" : "operation not permitted";
  return Object.assign(new Error(`${kind}: ${text}, ${syscall} '${path}'`), { code: kind, errno: kind === "EEXIST" ? -17 : kind === "EPERM" ? -1 : -13, syscall, path });
}

function permission_error(syscall: string, path: string): NodeJS.ErrnoException {
  if (cfg.nt === true) Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  return os_error(cfg.code ?? "EPERM", syscall, path);
}

/** Does this call create the lock (an exclusive open / write / append, or a mkdir of the lock name)? */
function creates(name: string, args: unknown[]): boolean {
  if (name === "mkdirSync" || name === "mkdir") return true;
  const flag = name.startsWith("write") || name.startsWith("append") ? (args[2] as { flag?: string } | string | undefined) : args[1];
  const text = typeof flag === "string" ? flag : typeof flag === "object" && flag !== null ? ((flag as { flag?: string }).flag ?? "") : typeof flag === "number" ? (flag & fs.constants.O_EXCL ? "x" : "") : "";
  return text.includes("x");
}

type AnyFn = (...args: unknown[]) => unknown;

/** Which injection (if any) applies to `name(path, …)`; returns the error to throw or undefined. */
function injected(name: string, args: unknown[]): NodeJS.ErrnoException | undefined {
  restore();
  const target = args[0];
  if (!is_lock(target)) return undefined;
  const path = path_of(target) as string;
  if (/^(open|openSync|writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|createWriteStream)$/.test(name) && creates(name, args)) {
    if (take("open")) return permission_error("open", path);
    if (take("exists")) return os_error("EEXIST", "open", path);
    return undefined;
  }
  if (/^(stat|statSync|lstat|lstatSync)$/.test(name)) return take("stat") ? permission_error("stat", path) : undefined;
  if (/^(unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync)$/.test(name)) return take("unlink") ? permission_error("unlink", path) : undefined;
  return undefined;
}

function wrap(target: Record<string, unknown>, prefix: string): void {
  for (const name of Object.keys(target)) {
    const fn = target[name];
    if (typeof fn !== "function" || !/^(open|openSync|writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|stat|statSync|lstat|lstatSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync)$/.test(name)) continue;
    const original = fn as AnyFn;
    const sync = name.endsWith("Sync");
    const promises = prefix === "fs/promises.";
    target[name] = function (this: unknown, ...args: unknown[]): unknown {
      const error = injected(name, args);
      if (error === undefined) return original.apply(this, args);
      if (sync) throw error;
      if (promises) return Promise.reject(error);
      const callback = args[args.length - 1];
      if (typeof callback === "function") {
        process.nextTick(() => (callback as (e: unknown) => void)(error));
        return undefined;
      }
      throw error;
    };
  }
}

wrap(fs as unknown as Record<string, unknown>, "fs.");
wrap(fsp as unknown as Record<string, unknown>, "fs/promises.");

// ---------------------------------------------------------------- synthetic clock: sleeping only moves the clock
if (cfg.fake_clock === true) {
  let skew = 0;
  const real_now = Date.now.bind(Date);
  const real_perf = performance.now.bind(performance);
  Date.now = (): number => real_now() + skew;
  performance.now = (): number => real_perf() + skew;
  const sleeping = (ms: unknown): void => {
    restore();
    hit.slept += 1;
    skew += Number(ms) || 0;
  };
  const real_set_timeout = globalThis.setTimeout.bind(globalThis);
  const fake_set_timeout = ((callback: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    sleeping(ms);
    // setImmediate, not setTimeout(…, 0): on Windows a 0 ms timer still waits for the ~15 ms timer tick, so 1000 synthetic
    // sleeps cost ~11 s of real time and a 30 s synthetic deadline test ran out (PR #58 windows run 43091570453).
    void real_set_timeout;
    return setImmediate(callback, ...rest) as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  globalThis.setTimeout = fake_set_timeout;
  (timers as unknown as { setTimeout: typeof setTimeout }).setTimeout = fake_set_timeout;
  const real_promises_timeout = timersp.setTimeout.bind(timersp);
  (timersp as unknown as { setTimeout: typeof timersp.setTimeout }).setTimeout = ((ms?: number, value?: unknown, options?: unknown) => {
    sleeping(ms);
    void real_promises_timeout;
    void options;
    return new Promise((done) => setImmediate(() => done(value as never)));
  }) as typeof timersp.setTimeout;
  const real_wait = Atomics.wait.bind(Atomics);
  (Atomics as unknown as { wait: unknown }).wait = (array: Int32Array, index: number, value: number, timeout?: number): string => {
    // a wait that nobody can wake up is a sleep; one with a real waker is not ours to fake
    sleeping(timeout ?? 0);
    return Atomics.load(array, index) === value ? "timed-out" : real_wait(array, index, value, 0);
  };
}

process.on("exit", () => {
  restore();
  const file = process.env.SEL75_REPORT;
  if (file !== undefined && file !== "") write_report(file, JSON.stringify(hit), "utf8");
});

syncBuiltinESMExports();

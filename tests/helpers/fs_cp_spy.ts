// SEL-73 (stage 2 PR26d) 시험 전용 훅: 일정 구간 동안 `node:child_process` 의 실행 함수(spawn/exec/fork …)를 막고 기록하며,
// `node:fs`(sync·promises)의 경로 접근을 기록한다. process.env 는 건드리지 않는다.
//
// 어떻게 먼저 불러온 모듈(`import { readFileSync } from "node:fs"` 같은 이름 있는 가져오기)에도 먹나:
// 내장 모듈의 CommonJS 객체 속성을 바꾼 뒤 `syncBuiltinESMExports()` 로 ESM 쪽 live binding 을 맞춘다. 구간이 끝나면 원복한다.
// (node --test 는 파일마다 별도 프로세스라 다른 시험 파일에 번지지 않는다.)
//
// Windows 점검표: 경로는 realpathSync.native 로 정규화(8.3 짧은 이름)하고 win32 에서는 대소문자를 무시해서 견준다.

import cp from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface ProcessCall {
  fn: string;
  command: string;
}

export interface FsCall {
  op: string;
  /** 정규화한 절대 경로 */
  path: string;
  write: boolean;
}

const CP_FUNCTIONS = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;

const FS_READ_OPS = [
  "readFileSync", "readdirSync", "lstatSync", "statSync", "existsSync", "openSync", "opendirSync",
  "realpathSync", "readlinkSync", "accessSync", "readFile", "readdir", "lstat", "stat", "open", "opendir",
  "realpath", "readlink", "access", "createReadStream",
] as const;
const FS_WRITE_OPS = [
  "writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "unlinkSync", "renameSync", "copyFileSync", "mkdtempSync",
  "rmdirSync", "symlinkSync", "truncateSync", "chmodSync", "utimesSync", "writeFile", "appendFile", "mkdir", "rm",
  "unlink", "rename", "copyFile", "rmdir", "symlink", "truncate", "chmod", "utimes", "createWriteStream", "cp", "cpSync",
] as const;

export interface Spy {
  process_calls: ProcessCall[];
  fs_calls: FsCall[];
  stop(): void;
}

function path_of(arg: unknown): string | null {
  if (typeof arg === "string") return arg;
  if (arg instanceof URL) return fileURLToPath(arg);
  if (arg instanceof Uint8Array) return Buffer.from(arg).toString("utf8");
  return null;
}

const real_realpath = fs.realpathSync.native.bind(fs);
const real_exists = fs.existsSync.bind(fs);

/** 존재하는 가장 긴 조상을 realpath(native)로 풀고 나머지를 붙인다. */
export function canon(p: string): string {
  const abs = resolve(p);
  let head = abs;
  const rest: string[] = [];
  while (!real_exists(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    rest.unshift(head.slice(parent.length).replace(/^[\\/]+/, ""));
    head = parent;
  }
  let base = head;
  try {
    base = real_realpath(head);
  } catch {
    // keep head
  }
  return rest.length ? join(base, ...rest) : base;
}

export function under(path: string, root: string): boolean {
  const a = process.platform === "win32" ? path.toLowerCase() : path;
  const b = process.platform === "win32" ? root.toLowerCase() : root;
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/** `root` 아래 상대 경로("/" 구분). 아래가 아니면 null. */
export function rel_under(path: string, root: string): string | null {
  if (!under(path, root)) return null;
  const r = relative(root, path).split(sep).join("/");
  return r === "" ? "" : r;
}

export function start_spy(): Spy {
  const process_calls: ProcessCall[] = [];
  const fs_calls: FsCall[] = [];
  const restores: Array<() => void> = [];
  let stopped = false;

  for (const name of CP_FUNCTIONS) {
    const original = (cp as unknown as Record<string, unknown>)[name];
    if (typeof original !== "function") continue;
    (cp as unknown as Record<string, unknown>)[name] = (...args: unknown[]): never => {
      process_calls.push({ fn: name, command: String(args[0]) });
      throw new Error(`child_process.${name} is blocked during the legacy import (SEL-73 spy)`);
    };
    restores.push(() => {
      (cp as unknown as Record<string, unknown>)[name] = original;
    });
  }

  const wrap = (target: Record<string, unknown>, name: string, write: boolean, prefix: string): void => {
    const original = target[name];
    if (typeof original !== "function") return;
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      const p = path_of(args[0]);
      if (p !== null) fs_calls.push({ op: `${prefix}${name}`, path: canon(p), write });
      // rename/copyFile/symlink 은 두 번째 경로도 쓴다
      if (write && (name.startsWith("rename") || name.startsWith("copyFile") || name.startsWith("cp"))) {
        const q = path_of(args[1]);
        if (q !== null) fs_calls.push({ op: `${prefix}${name}`, path: canon(q), write });
      }
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    // realpathSync.native 도 같이 쓰이므로 속성을 복사한다
    Object.assign(wrapped, original);
    target[name] = wrapped;
    restores.push(() => {
      target[name] = original;
    });
  };

  for (const name of FS_READ_OPS) {
    wrap(fs as unknown as Record<string, unknown>, name, false, "fs.");
    wrap(fsp as unknown as Record<string, unknown>, name, false, "fsp.");
  }
  for (const name of FS_WRITE_OPS) {
    wrap(fs as unknown as Record<string, unknown>, name, true, "fs.");
    wrap(fsp as unknown as Record<string, unknown>, name, true, "fsp.");
  }

  syncBuiltinESMExports();

  return {
    process_calls,
    fs_calls,
    stop(): void {
      if (stopped) return;
      stopped = true;
      for (const restore of restores.reverse()) restore();
      syncBuiltinESMExports();
    },
  };
}

export function is_absolute_path(p: string): boolean {
  return isAbsolute(p);
}

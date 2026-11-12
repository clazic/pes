// `npm test` 실행기 (SEL-106) — node --test 의 동시 실행 수를 제한한다.
//
// 사용: node scripts/run_tests.ts [node --test 에 넘길 추가 인자…]      (npm test -- <인자…>)
//
// 왜 스크립트인가: 전체 시험 하나가 시험 파일마다 node 자식을 띄워 코어 수만큼(10코어면 load 140 대까지) 몰린다.
// `--test-concurrency` 는 NODE_OPTIONS 로 줄 수 없고, npm 스크립트 문자열의 env 치환($VAR·%VAR%)은 셸마다 다르다.
// 그래서 작은 node 실행기가 env 를 읽어 인자를 만들고 node 를 직접(셸 없이) 부른다 — Windows·macOS 같은 방식.
//
// 동시 실행 수: PES_TEST_CONCURRENCY(정수 ≥ 1) → 없거나 빈 문자열이면 max(2, floor(코어 수 / 2)).
//   잘못된 값(0·음수·소수·문자 섞임)은 시험을 돌리지 않고 종료 코드 2 로 거절한다.
//   추가 인자에 --test-concurrency 가 이미 있으면 그것을 따른다(이 스크립트는 더하지 않는다).
// 인자 순서: 옵션(추가 인자 포함)은 시험 대상 glob 앞에 둔다 — node 는 glob 뒤의 `--옵션` 을 파일 이름으로 취급해 무시한다.
// 진입 판정: 기호 링크(저장소를 링크로 연 경우·Windows junction·subst)여도 realpath 로 비교한다. 판정이 틀려 main() 이 안 돌면 가짜 통과(종료 0)가 되므로,
//   이름이 run_tests.ts 인데 진입으로 판정되지 않으면 시험을 돌리지 못한 것으로 보고 1 로 실패한다.
// 자식은 저장소 루트를 cwd 로 시작하고(어느 폴더에서 불러도 glob 이 같다), POSIX 에서는 자기 프로세스 그룹으로 띄워
//   SIGINT·SIGTERM·SIGHUP 를 받으면 그룹 전체(node --test 와 시험 파일 프로세스)에 전달하고 남은 것은 정리한다 — hc-heavy 취소 뒤 고아가 과부하를 만들지 않게.
// CI 는 이 스크립트를 쓰지 않고 `node --test --test-shard=N/8` 을 직접 부른다(조각 나누기와 겹치지 않는다).

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { availableParallelism, constants as os_constants } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const IMPORT_ENTRY = "./tests/helpers/require_temp_home.ts";
export const TEST_GLOB = "tests/**/*.test.ts";
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 코어 수의 절반, 최소 2. */
export function default_concurrency(cores: number): number {
  return Math.max(2, Math.floor(cores / 2));
}

/** PES_TEST_CONCURRENCY 값 → 동시 실행 수. 없음/빈 문자열 → 기본값, 잘못된 값 → Error. */
export function parse_concurrency(raw: string | undefined, cores: number): number {
  if (raw === undefined || raw === "") return default_concurrency(cores);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`PES_TEST_CONCURRENCY 는 1 이상의 정수여야 한다 (받은 값: ${JSON.stringify(raw)})`);
  }
  return Number(raw);
}

/** node 에 넘길 인자(실행 파일 제외). */
export function build_node_args(env: Record<string, string | undefined>, extra: readonly string[], cores: number): string[] {
  const args = ["--import", IMPORT_ENTRY, "--test"];
  const own = extra.some((a) => a === "--test-concurrency" || a.startsWith("--test-concurrency="));
  if (!own) args.push(`--test-concurrency=${parse_concurrency(env.PES_TEST_CONCURRENCY, cores)}`);
  args.push(...extra, TEST_GLOB);
  return args;
}

/** 이 모듈이 `node <argv1>` 의 진입 파일인가 — 기호 링크·junction 은 realpath 로 풀어 비교한다. 풀 수 없으면 문자열 비교. */
export function is_entry(module_url: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  const own = fileURLToPath(module_url);
  try {
    return realpathSync.native(own) === realpathSync.native(argv1);
  } catch {
    return own === argv1;
  }
}

const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** exe 를 셸 없이 REPO_ROOT 에서 돌리고 종료 코드를 돌려준다. 신호를 받으면 자식 그룹 전체에 전달하고 128+번호로 끝난다. */
export function run_node(exe: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve_code) => {
    const group = process.platform !== "win32";
    const child = spawn(exe, [...args], { stdio: "inherit", cwd: REPO_ROOT, detached: group });
    let got: NodeJS.Signals | undefined;
    const send = (signal: NodeJS.Signals): void => {
      try {
        if (group && child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* 이미 끝남 */
      }
    };
    const handlers = FORWARDED.map((signal) => {
      const handler = (): void => {
        got = signal;
        send(signal);
      };
      process.on(signal, handler);
      return [signal, handler] as const;
    });
    const finish = (code: number): void => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      if (got && group) send("SIGKILL"); // 신호를 받은 경우 그룹에 남은 것(신호를 무시하는 시험 프로세스)을 정리한다
      resolve_code(code);
    };
    child.on("error", (error) => {
      process.stderr.write(`node 를 시작하지 못했다: ${error.message}\n`);
      finish(1);
    });
    child.on("close", (status, signal) => {
      if (got) {
        process.stderr.write(`신호 ${got} 를 받아 시험을 중단했다\n`);
        finish(128 + (os_constants.signals[got] ?? 1));
      } else if (signal) {
        process.stderr.write(`node 가 신호 ${signal} 로 끝났다\n`);
        finish(1);
      } else finish(status ?? 1);
    });
  });
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  cores: number = availableParallelism(),
  runner: (exe: string, args: readonly string[]) => Promise<number> = run_node,
): Promise<number> {
  let args: string[];
  try {
    args = build_node_args(env, argv, cores);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  return runner(process.execPath, args);
}

const argv1 = process.argv[1];
if (is_entry(import.meta.url, argv1)) process.exit(await main());
else if (argv1 && basename(argv1) === "run_tests.ts") {
  process.stderr.write("run_tests.ts 를 진입 파일로 알아보지 못했다 — 시험을 돌리지 못했으므로 실패로 끝낸다\n");
  process.exit(1);
}

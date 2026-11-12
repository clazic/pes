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
// CI 는 이 스크립트를 쓰지 않고 `node --test --test-shard=N/8` 을 직접 부른다(조각 나누기와 겹치지 않는다).

import { spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

export const IMPORT_ENTRY = "./tests/helpers/require_temp_home.ts";
export const TEST_GLOB = "tests/**/*.test.ts";

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

function main(): number {
  let args: string[];
  try {
    args = build_node_args(process.env, process.argv.slice(2), availableParallelism());
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`node 를 시작하지 못했다: ${result.error.message}\n`);
    return 1;
  }
  if (result.signal) {
    process.stderr.write(`node 가 신호 ${result.signal} 로 끝났다\n`);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main());

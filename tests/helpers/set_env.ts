// SEL-50 `pes set` 시험 공용 준비물. 전부 합성 자료이고 HOME·USERPROFILE·PES_HOME 은 임시 폴더다.
//
// `pes set <dir> <stage> <field> <file|->` · `pes set <dir> project <field> <file|->` 를 `node scripts/pes.ts` 로 돌린다 (SEL-74: 0.15 Python 은 없다).
// 프로젝트는 `init` 이 DB 에 만든다 — project.json 은 없고, 상태(`state()`)는 DB 읽기 모델(0.15 project.json 모양)에서 읽는다.
// Windows 점검표: 가드 아래 node(cli_read_env.run_cli), 출력·파일은 CRLF→LF 정규화, 셸·which 에 기대지 않는다.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isolated_home, type IsolatedHome } from "./isolated_home.ts";
import { run_cli, type HomeLike, type RunOptions } from "./cli_read_env.ts";
import { ts_view, ts_age_lease } from "./compat_ts.ts";
import type { CliResult } from "./cli_write_env.ts";

export const STAGE_NAMES = ["plan", "research", "analyze", "write", "verify", "publish"] as const;
export type StageName = (typeof STAGE_NAMES)[number];

export const STAGE_FIELDS = ["summary", "changes", "carry_over", "settings", "review"] as const;
export const PROJECT_FIELDS = ["executive_summary", "conclusion"] as const;

export interface SetEnv extends HomeLike {
  home: IsolatedHome;
  slug: string;
  folder: string;
  json_path: string;
  /** 임시 폴더에 값 파일을 쓰고 경로를 돌려준다. */
  value_file(name: string, text: string): string;
  /** pes.ts 를 돌린다. PES_OWNER/PES_TOKEN 은 extra 로만 준다. */
  py(args: string[], opts?: RunOptions): CliResult;
  /** 상태(옛 project.json 모양). `of` 를 주면 그 슬러그의 프로젝트(기본: 이 환경의 프로젝트). */
  state(of?: string): any;
  raw(): string;
  /** 살아 있는 잠금(lease)을 쥔 세션 표시(PES_OWNER), 없으면 undefined — 0.15 의 .pes-lock 의 owner 에 해당한다(D04). */
  lock_owner(): string | undefined;
  /** 잠금을 `seconds` 만큼 과거로 돌린다(0.15 의 .pes-lock 시각 고치기). */
  age_lock(seconds: number): void;
  /** 프로젝트 폴더의 파일 이름(하위 폴더는 `폴더/` 로 한 단계만). */
  listing(): string[];
  cleanup(): void;
}

export function make_set_env(slug = "set-synth"): SetEnv {
  const home = isolated_home("pes-sel50-set-");
  const folder = join(home.env.PES_HOME as string, slug);
  const self: SetEnv = {
    env: { home },
    home,
    slug,
    folder,
    json_path: join(folder, "project.json"),
    value_file(name, text) {
      const file = join(home.root, name);
      writeFileSync(file, text, "utf8");
      return file;
    },
    py(args, opts = {}) {
      return run_cli(self, args, opts);
    },
    state(of = slug) {
      // DB 읽기 모델(옛 project.json 모양). 기본값(notes·processed)은 미리 채워 비교한다.
      const view = ts_view({ env: home.env, pes_home: home.env.PES_HOME as string, home_dir: home.env.HOME as string }, of);
      assert.ok(view !== undefined, `DB 에 프로젝트 ${of} 가 있다`);
      const p = JSON.parse(JSON.stringify(view.project));
      p.notes ??= [];
      p.processed ??= [];
      return p;
    },
    lock_owner() {
      return ts_view({ env: home.env, pes_home: home.env.PES_HOME as string, home_dir: home.env.HOME as string }, slug)?.lock?.owner;
    },
    age_lock(seconds) {
      ts_age_lease({ env: home.env, pes_home: home.env.PES_HOME as string, home_dir: home.env.HOME as string }, slug, seconds);
    },
    raw() {
      // project.json 은 없다 — 상태 전체를 JSON 글자로 (같은 상태면 같은 글자)
      return JSON.stringify(self.state());
    },
    listing() {
      return listing_of(folder);
    },
    cleanup() {
      home.cleanup();
    },
  };
  const init = self.py(["init", slug, "--topic", "합성 set 주제"]);
  assert.equal(init.status, 0, `init: ${init.stderr}${init.stdout}`);
  return self;
}

export function with_set<T>(fn: (e: SetEnv) => T): T {
  const e = make_set_env();
  try {
    return fn(e);
  } finally {
    e.cleanup();
  }
}

function listing_of(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.isDirectory()) {
      out.push(`${entry.name}/`);
      for (const name of readdirSync(join(dir, entry.name)).sort()) out.push(`${entry.name}/${name}`);
    } else {
      out.push(entry.name);
    }
  }
  return out;
}

export function ok_run(res: CliResult, what: string): CliResult {
  assert.equal(res.status, 0, `${what}: exit ${res.status}\n${res.stderr}${res.stdout}`);
  assert.doesNotMatch(res.stderr, /Traceback/, `${what}: 스택 추적이 아니라 분명한 메시지여야 한다`);
  return res;
}

/** 거부: 0 아닌 종료, 스택 추적 없음, 한국어 설명 한 줄 이상. */
export function expect_refused(res: CliResult, what: string, opts: { allow_usage?: boolean } = {}): void {
  assert.notEqual(res.status, 0, `${what}: 거부해야 한다 (stdout: ${res.stdout})`);
  const text = res.stderr + res.stdout;
  // `set` 을 모르는 pes.py 는 "알 수 없는 명령" 으로 사용법 전체를 찍고 1로 끝난다 — 그것은 set 의 거부가 아니다.
  if (opts.allow_usage !== true) assert.doesNotMatch(text, /프로젝트 상태 CLI/, `${what}: 사용법 전체 출력(=명령을 모름)이 아니라 set 이 이유를 말해야 한다`);
  assert.doesNotMatch(text, /Traceback|SyntaxError|ModuleNotFoundError|UnicodeEncodeError/, `${what}: 충돌이 아니라 분명한 거부여야 한다\n${text}`);
  assert.match(text, /[가-힣]/, `${what}: 한국어로 이유를 말해야 한다\n${text}`);
}

/** 대상 경로(키 배열)의 값을 뺀 사본. 나머지가 같은지 비교할 때 쓴다. */
export function without(obj: unknown, path: readonly string[]): unknown {
  const copy = JSON.parse(JSON.stringify(obj));
  let at = copy;
  for (const key of path.slice(0, -1)) at = at?.[key];
  if (at !== undefined && at !== null) delete at[path[path.length - 1]!];
  return copy;
}

export function at_path(obj: any, path: readonly string[]): any {
  let at = obj;
  for (const key of path) at = at?.[key];
  return at;
}

/** 필드 → project.json 안의 경로. */
export function field_path(target: StageName | "project", field: string): string[] {
  return target === "project" ? [field] : ["stages", target, field];
}

// SEL-50 PR17 r1-1 회귀 시험 공용 준비물: 같은 시나리오를 플래그 없음(v0.15)과 PES_DB_CORE=1(DB 경로) 양쪽에 돌린다.
// 전부 합성 자료이고 HOME·USERPROFILE·PES_HOME 은 임시 폴더다. Windows 점검표: python -I -X utf8(run_py), 출력 LF 정규화,
// 경로는 node:path, which·sh 에 기대지 않는다.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { make_cli_env, type CliEnv, type CliResult } from "./cli_write_env.ts";
import { run_py } from "./cli_read_env.ts";
import { make_set_env, type SetEnv } from "./set_env.ts";

export type ModeName = "off" | "on";

export const SLUG_STATE = "state-synth";
export const OWNER = "sess-state0001";

export interface Mode {
  name: ModeName;
  slug: string;
  root: string;
  /** pes.py 를 이 모드로 돌린다(PES_OWNER 붙임). 출력은 LF 정규화. */
  py(args: string[]): CliResult;
  /** 임시 폴더에 텍스트 파일을 쓰고 경로를 돌려준다. */
  file(name: string, text: string): string;
  /** 임시 폴더에 JSON 파일을 쓰고 경로를 돌려준다. */
  json(name: string, value: unknown): string;
  /** 플래그 없음 모드에서만: project.json 전체. */
  state(): any;
  /** 프로젝트 폴더(플래그 없음에서만 의미). */
  folder: string;
  close(): void;
}

function lf(res: CliResult): CliResult {
  return { status: res.status, stdout: res.stdout.replace(/\r\n/g, "\n"), stderr: res.stderr.replace(/\r\n/g, "\n") };
}

export async function open_mode(name: ModeName): Promise<Mode> {
  if (name === "off") {
    const e: SetEnv = make_set_env(SLUG_STATE);
    const self: Mode = {
      name,
      slug: SLUG_STATE,
      root: e.home.root,
      folder: e.folder,
      py: (args) => lf(run_py(e, args, { flag: undefined, extra: { PES_OWNER: OWNER } })),
      file: (n, text) => e.value_file(n, text),
      json: (n, value) => e.value_file(n, JSON.stringify(value)),
      state: () => e.state(),
      close: () => e.cleanup(),
    };
    return self;
  }
  const c: CliEnv = await make_cli_env();
  const root = c.env.home.root;
  const self: Mode = {
    name,
    slug: SLUG_STATE,
    root,
    folder: join(c.env.home.env.PES_HOME as string, SLUG_STATE),
    py: (args) => lf(run_py(c, args, { flag: "1", extra: { PES_OWNER: OWNER } })),
    file(n, text) {
      const f = join(root, n);
      writeFileSync(f, text, "utf8");
      return f;
    },
    json(n, value) {
      return self.file(n, JSON.stringify(value));
    },
    state() {
      throw new Error("DB 모드에는 project.json 이 없다");
    },
    close: () => c.close(),
  };
  const init = self.py(["init", SLUG_STATE, "--topic", "합성 상태 주제"]);
  assert.equal(init.status, 0, `init: ${init.stderr}${init.stdout}`);
  return self;
}

export async function with_mode<T>(name: ModeName, fn: (m: Mode) => T | Promise<T>): Promise<T> {
  const m = await open_mode(name);
  try {
    return await fn(m);
  } finally {
    m.close();
  }
}

export function ok(res: CliResult, what: string): CliResult {
  assert.equal(res.status, 0, `${what}: 종료 ${res.status}\n${res.stderr}${res.stdout}`);
  assert.doesNotMatch(res.stderr, /Traceback|SyntaxError|ModuleNotFoundError|UnicodeEncodeError/, `${what}: 충돌이 아니라 정상 종료여야 한다\n${res.stderr}`);
  return res;
}

/** `show <slug> <stage> <id> --fields a,b` 의 JSON 배열 첫 원소. */
export function item_fields(m: Mode, stage: string, id: number, fields: string): any {
  const res = ok(m.py(["show", m.slug, stage, String(id), "--fields", fields]), `show ${stage} ${id}`);
  const arr = JSON.parse(res.stdout);
  assert.ok(Array.isArray(arr) && arr.length === 1, `show ${stage} ${id}: 항목 하나 (실제: ${res.stdout.slice(0, 200)})`);
  return arr[0];
}

/** 합성 참고자료(library) 원본 폴더: `<root>/<name>/state.json`. 항목 하나(id 1)에 요약·출처가 있다. */
export function make_library_source(m: Mode, name = "lib-src"): string {
  const dir = join(m.root, name);
  mkdirSync(dir, { recursive: true });
  const state = {
    topic: "합성 참고 주제",
    round: 2,
    settings: {},
    items: [
      {
        id: 1,
        title: "합성 기존 조사",
        kind: "topic",
        status: "done",
        summary: "기존 조사 요약",
        details: "기존 조사 본문",
        sources: [{ url: "https://lib.example.test/a", title: "기존 출처", verified: false }],
        stats: [],
        shots: [],
        confidence: "중간",
        conflicts: [],
        links: {},
      },
    ],
    suggestions: [],
    warnings: [],
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state), "utf8");
  return dir;
}

export const round_trip = <T>(x: T): T => JSON.parse(JSON.stringify(x));

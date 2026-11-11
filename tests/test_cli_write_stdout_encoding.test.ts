/**
 * SEL-48 PR15 — Windows CI 수정: pes.py는 stdout·stderr 인코딩이 cp1252여도 한글을 UTF-8로 낸다.
 *
 * 배경: Windows의 파이프·리디렉션 stdout 기본 인코딩은 cp1252라 print(한글)이 UnicodeEncodeError로 죽었다.
 * `python3 -I`는 PYTHONIOENCODING을 무시하므로, 시험은 -I 없이 PYTHONIOENCODING=cp1252로 인코딩을 강제한다.
 * HOME·USERPROFILE·PES_HOME은 임시 폴더다. 모든 자료는 합성이다.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { PES_PY, SLUG, with_cli, type CliEnv } from "./helpers/cli_write_env.ts";
import { hub_blocked_argv } from "./helpers/hub_block.ts";

function run_cp1252(c: CliEnv, args: string[], extra: Record<string, string | undefined> = {}) {
  const child: Record<string, string | undefined> = {
    ...c.env.home.env,
    PYTHONIOENCODING: "cp1252",
    PES_OWNER: undefined,
    PES_TOKEN: undefined,
    PES_DB_CORE: "1",
    ...extra,
  };
  for (const key of Object.keys(child)) if (child[key] === undefined) delete child[key];
  assert.equal(child.HOME, c.env.home.env.HOME, "격리 HOME");
  assert.equal(child.USERPROFILE, c.env.home.env.HOME, "격리 USERPROFILE");
  assert.ok(child.PES_HOME, "격리 PES_HOME");
  const r = spawnSync("python3", hub_blocked_argv([PES_PY, ...args]), {
    env: child as NodeJS.ProcessEnv,
    cwd: c.env.home.root,
    encoding: "buffer",
    timeout: 60_000,
  });
  if (r.error !== undefined) throw r.error;
  return {
    status: r.status,
    stdout: r.stdout.toString("utf8"),
    stderr: r.stderr.toString("utf8"),
  };
}

test("stdout이 cp1252여도 DB 경로 round-start가 한글을 UTF-8로 내고 exit 0", () =>
  with_cli(async (c) => {
    const res = run_cp1252(c, ["round-start", SLUG, "plan"]);
    assert.equal(res.status, 0, `exit ${res.status}: ${res.stderr}${res.stdout}`);
    assert.doesNotMatch(res.stderr, /UnicodeEncodeError|Traceback/);
    assert.match(res.stdout, /기획 R1 시작/, "한글이 UTF-8 그대로 읽힌다");
  }));

test("stdout이 cp1252여도 v0.15 경로 round-start가 한글을 UTF-8로 내고 exit 0", () =>
  with_cli(async (c) => {
    const off = { PES_DB_CORE: undefined };
    const made = run_cp1252(c, ["init", "synthetic-off", "--topic", "합성 옛 방식"], off);
    assert.equal(made.status, 0, `init exit ${made.status}: ${made.stderr}${made.stdout}`);
    const res = run_cp1252(c, ["round-start", "synthetic-off", "plan"], off);
    assert.equal(res.status, 0, `exit ${res.status}: ${res.stderr}${res.stdout}`);
    assert.doesNotMatch(res.stderr, /UnicodeEncodeError|Traceback/);
    assert.match(res.stdout, /기획 R1 시작/, "한글이 UTF-8 그대로 읽힌다");
  }));

test("stderr도 cp1252여도 한글 오류 문구가 UTF-8로 나온다 (스택 추적 없음)", () =>
  with_cli(async (c) => {
    const res = run_cp1252(c, ["round-start", SLUG, "nope"]);
    assert.notEqual(res.status, 0, "잘못된 단계는 거절");
    assert.doesNotMatch(res.stderr + res.stdout, /UnicodeEncodeError|Traceback/);
  }));

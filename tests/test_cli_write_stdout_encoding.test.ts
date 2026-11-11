/**
 * SEL-48 PR15 — Windows CI 수정: 콘솔 인코딩이 cp1252 여도 한글을 UTF-8 로 낸다.
 *
 * 배경: Windows 의 파이프·리디렉션 stdout 기본 인코딩은 cp1252 라 0.15 의 print(한글)이 UnicodeEncodeError 로 죽었다.
 * SEL-74: pes.ts(Node)는 stdout·stderr 를 늘 UTF-8 로 쓴다 — 시험은 옛 변수(PYTHONIOENCODING=cp1252)와 cp949 코드 페이지 환경을 줘도 같은 결과여야 함을 고정한다.
 * (0.15 의 'v0.15 경로' 시험은 지웠다: 플래그와 Python 이 없다.) HOME·USERPROFILE·PES_HOME은 임시 폴더다. 모든 자료는 합성이다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { SLUG, with_cli } from "./helpers/cli_write_env.ts";

const HOSTILE = { PYTHONIOENCODING: "cp1252", LANG: "C", LC_ALL: "C" } as const;

test("콘솔 인코딩 환경이 cp1252·C 로케일이어도 round-start 가 한글을 UTF-8 로 내고 exit 0", () =>
  with_cli(async (c) => {
    const res = c.run(["round-start", SLUG, "plan"], HOSTILE);
    assert.equal(res.status, 0, `exit ${res.status}: ${res.stderr}${res.stdout}`);
    assert.doesNotMatch(res.stderr, /UnicodeEncodeError|Traceback|�/);
    assert.match(res.stdout, /기획 R1 시작/, "한글이 UTF-8 그대로 읽힌다");
    assert.doesNotMatch(res.stdout, /�/, "깨진 글자(U+FFFD)가 없다");
  }));

test("stderr 도 같다: 한글 오류 문구가 UTF-8 로 나온다 (스택 추적 없음)", () =>
  with_cli(async (c) => {
    const res = c.run(["round-start", SLUG, "nope"], HOSTILE);
    assert.notEqual(res.status, 0, "잘못된 단계는 거절");
    assert.doesNotMatch(res.stderr + res.stdout, /UnicodeEncodeError|Traceback|�/);
    assert.match(res.stderr + res.stdout, /[가-힣]/, "한국어 문구");
  }));

/**
 * SEL-50 PR17 — `pes set` 보강 (tester, 보강 모드). 구현(scripts/pes.py cmd_set)을 깨뜨리는 경계를 건다.
 * 계약은 test_cli_set_accept/reject (플래그 없음). 자료는 합성, HOME·USERPROFILE·PES_HOME 은 임시 폴더, python -I -X utf8.
 *
 * 공통 기대: 거부는 0 아닌 종료 + 한국어 이유 + 스택 추적 없음 + project.json 바이트 불변 + project.json.tmp 없음.
 * Windows 점검표: 줄바꿈 정규화, 경로는 node:path, 셸 없음, 동시 실행은 spawn(비동기) 두 개.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { PES_PY } from "./helpers/cli_write_env.ts";
import { PY } from "./helpers/cli_read_env.ts";
import { expect_refused, ok_run, with_set, type SetEnv } from "./helpers/set_env.ts";

function bytes_file(e: SetEnv, name: string, data: Buffer | string): string {
  const file = join(e.home.root, name);
  writeFileSync(file, data);
  return file;
}

function refuse_unchanged(e: SetEnv, args: string[], what: string, opts: { input?: string | Buffer } = {}): void {
  const raw = e.raw();
  const listing = e.listing();
  const res = e.py(args, opts.input !== undefined ? { input: opts.input as string } : {});
  expect_refused(res, what);
  assert.equal(e.raw(), raw, `${what}: project.json 바이트 불변`);
  assert.deepEqual(e.listing(), listing, `${what}: 폴더 불변 (tmp 없음)`);
  assert.ok(!existsSync(join(e.folder, "project.json.tmp")), `${what}: tmp 가 남지 않는다`);
}

const BOM = "\uFEFF";

// ---------------------------------------------------------------------------
// 빈 값·긴 값

test("set: 빈 파일·공백만 있는 텍스트는 거부하고, 빈 JSON 배열·객체는 받는다", () =>
  with_set((e) => {
    for (const [field, target] of [["summary", "plan"], ["executive_summary", "project"], ["conclusion", "project"]] as const) {
      refuse_unchanged(e, ["set", e.slug, target, field, bytes_file(e, `empty-${field}.txt`, "")], `${field} 빈 파일`);
      refuse_unchanged(e, ["set", e.slug, target, field, bytes_file(e, `ws-${field}.txt`, " \n\t \r\n")], `${field} 공백만`);
    }
    ok_run(e.py(["set", e.slug, "plan", "changes", bytes_file(e, "e1.json", "[]")]), "빈 배열");
    ok_run(e.py(["set", e.slug, "plan", "carry_over", bytes_file(e, "e2.json", "[]")]), "빈 배열");
    ok_run(e.py(["set", e.slug, "plan", "settings", bytes_file(e, "e3.json", "{}")]), "빈 객체");
    ok_run(e.py(["set", e.slug, "plan", "review", bytes_file(e, "e4.json", "{}")]), "빈 객체");
  }));

test("set: 매우 긴 값(텍스트 약 3MB·배열 5000개)도 잘리지 않고 저장되며 project.json 은 유효하다", () =>
  with_set((e) => {
    const long = "가나다라마바사 ".repeat(150_000); // ~1.05M 글자, ~3MB
    ok_run(e.py(["set", e.slug, "plan", "summary", bytes_file(e, "long.txt", long)], { timeout: 120_000 }), "긴 텍스트");
    assert.equal(e.state().stages.plan.summary.length, long.trimEnd().length, "길이가 같다");
    const many = Array.from({ length: 5000 }, (_, i) => ({ item: i, title: `항목 ${i}`, request: "요청" }));
    ok_run(e.py(["set", e.slug, "plan", "carry_over", bytes_file(e, "many.json", JSON.stringify(many))], { timeout: 120_000 }), "많은 배열");
    assert.equal(e.state().stages.plan.carry_over.length, 5000);
    ok_run(e.py(["set", e.slug, "project", "conclusion", "-"], { input: long, timeout: 120_000 }), "stdin 긴 텍스트");
    assert.equal(e.state().conclusion.length, long.trimEnd().length);
    ok_run(e.py(["status", e.slug]), "status");
  }));

// ---------------------------------------------------------------------------
// CRLF·BOM·인코딩

test("set: CRLF 입력은 LF 로 저장한다 (텍스트·JSON 모두), 파일과 stdin 같다", () =>
  with_set((e) => {
    ok_run(e.py(["set", e.slug, "plan", "summary", bytes_file(e, "c1.txt", "첫째 줄\r\n둘째 줄\r\n")]), "crlf file");
    assert.equal(e.state().stages.plan.summary, "첫째 줄\n둘째 줄");
    ok_run(e.py(["set", e.slug, "plan", "changes", "-"], { input: '[\r\n "가: 하나",\r\n "나: 둘"\r\n]\r\n' }), "crlf json stdin");
    assert.deepEqual(e.state().stages.plan.changes, ["가: 하나", "나: 둘"]);
    ok_run(e.py(["set", e.slug, "project", "conclusion", "-"], { input: "결론 한 줄\r\n둘째\r\n" }), "crlf stdin text");
    assert.equal(e.state().conclusion, "결론 한 줄\n둘째");
  }));

test("set: UTF-8 BOM(Windows PowerShell 5.1 의 Set-Content -Encoding UTF8, 메모장)이 붙은 입력도 받고 BOM 은 값에 남기지 않는다", () =>
  with_set((e) => {
    ok_run(e.py(["set", e.slug, "plan", "summary", bytes_file(e, "bom.txt", Buffer.from(`${BOM}BOM 요약`, "utf8"))]), "bom text file");
    assert.equal(e.state().stages.plan.summary, "BOM 요약", "텍스트 값 앞에 \\ufeff 가 남지 않는다");
    ok_run(e.py(["set", e.slug, "plan", "carry_over", bytes_file(e, "bom.json", Buffer.from(`${BOM}[{"item": 1, "title": "t", "request": "r"}]`, "utf8"))]), "bom json file");
    assert.equal(e.state().stages.plan.carry_over[0].item, 1);
    ok_run(e.py(["set", e.slug, "project", "conclusion", "-"], { input: `${BOM}stdin BOM 결론` }), "bom stdin");
    assert.equal(e.state().conclusion, "stdin BOM 결론");
    ok_run(e.py(["set", e.slug, "plan", "settings", "-"], { input: `${BOM}{"a": 1}` }), "bom json stdin");
    assert.deepEqual(e.state().stages.plan.settings, { a: 1 });
  }));

test("set: UTF-8 이 아닌 바이트(cp949·UTF-16)는 깨진 글자로 저장하지 않고 거부한다", () =>
  with_set((e) => {
    refuse_unchanged(e, ["set", e.slug, "plan", "summary", bytes_file(e, "bad.txt", Buffer.from([0xb0, 0xa1, 0xb3, 0xaa, 0xb4, 0xd9]))], "cp949 바이트");
    refuse_unchanged(e, ["set", e.slug, "plan", "summary", bytes_file(e, "u16.txt", Buffer.from(`${BOM}UTF16 요약`, "utf16le"))], "UTF-16");
    refuse_unchanged(e, ["set", e.slug, "plan", "summary", "-"], "stdin cp949", { input: Buffer.from([0xb0, 0xa1, 0xb3, 0xaa]) });
  }));

test("set: 줄바꿈이 섞인 한글·이모지·제어문자 없는 특수문자 텍스트가 그대로 돌아온다 (왕복)", () =>
  with_set((e) => {
    const text = '이모지 😀 𠮷 — “따옴표” ‘작은’ \\ 역슬래시 \t탭 "큰따옴표" \'작은따옴표\' <b>&amp;</b> $HOME `백틱` ${x} %PATH% \\n';
    ok_run(e.py(["set", e.slug, "plan", "summary", bytes_file(e, "sp.txt", text)]), "special");
    assert.equal(e.state().stages.plan.summary, text);
    ok_run(e.py(["set", e.slug, "plan", "settings", bytes_file(e, "sp.json", JSON.stringify({ k: text }))]), "special json");
    assert.equal(e.state().stages.plan.settings.k, text);
  }));

// ---------------------------------------------------------------------------
// 위험한 JSON

test("set: JSON 의 NaN·Infinity·1e999 는 거부한다 (project.json 에 Infinity 가 들어가면 다른 도구가 못 읽는다)", () =>
  with_set((e) => {
    for (const [i, text] of ['{"a": NaN}', '{"a": Infinity}', '{"a": -Infinity}', '{"a": 1e999}', '{"a": [1e400]}', '{"a": -1e999}'].entries()) {
      refuse_unchanged(e, ["set", e.slug, "plan", "settings", bytes_file(e, `inf${i}.json`, text)], `settings ${text}`);
    }
    refuse_unchanged(e, ["set", e.slug, "plan", "review", bytes_file(e, "inf-r.json", '{"x": 1e999}')], "review 1e999");
    JSON.parse(e.raw()); // 표준 JSON 으로 읽힌다
  }));

test("set: 지나치게 깊게 중첩된 JSON 은 충돌(RecursionError)이 아니라 거부한다", () =>
  with_set((e) => {
    refuse_unchanged(e, ["set", e.slug, "plan", "settings", bytes_file(e, "deep.json", `{"a":${"[".repeat(200_000)}${"]".repeat(200_000)}}`)], "깊은 중첩");
  }));

test("set: UTF-8 로 쓸 수 없는 값(짝 없는 서로게이트 \\ud800)은 충돌·잔여 tmp 없이 거부한다", () =>
  with_set((e) => {
    refuse_unchanged(e, ["set", e.slug, "plan", "settings", bytes_file(e, "sur.json", '{"a": "\\ud800"}')], "서로게이트 settings");
    refuse_unchanged(e, ["set", e.slug, "plan", "changes", bytes_file(e, "sur2.json", '["\\udc00 끝"]')], "서로게이트 changes");
    ok_run(e.py(["status", e.slug]), "그 뒤에도 프로젝트를 읽을 수 있다");
  }));

test("set: JSON 의 중복 키·큰 정수·유니코드 이스케이프는 유효한 값으로 저장된다", () =>
  with_set((e) => {
    ok_run(e.py(["set", e.slug, "plan", "settings", bytes_file(e, "dup.json", '{"a": 1, "a": 2, "\\uac00": "\\ub098", "n": 12345678901234567890}')]), "dup");
    const s = e.state().stages.plan.settings;
    assert.equal(s.a, 2);
    assert.equal(s["가"], "나");
  }));

// ---------------------------------------------------------------------------
// 인자·경로

test("set: 인자가 많거나 적으면 거부하고, 대상·필드 앞뒤 공백·NUL 은 거부한다", () =>
  with_set((e) => {
    const f = bytes_file(e, "ok.txt", "x");
    refuse_unchanged(e, ["set", e.slug, "plan", "summary", f, "남는"], "인자 5개");
    refuse_unchanged(e, ["set", e.slug, "plan", " summary", f], "필드 앞 공백");
    refuse_unchanged(e, ["set", e.slug, "plan ", "summary", f], "대상 뒤 공백");
    refuse_unchanged(e, ["set", e.slug, "PROJECT", "conclusion", f], "대문자 PROJECT");
    refuse_unchanged(e, ["set", e.slug, "project", "summary", f], "project 에 단계 필드");
    refuse_unchanged(e, ["set", e.slug, "plan", "conclusion", f], "단계에 project 필드");
  }));

test("set: 폴더 인자 — 절대 경로·공백/한글 경로·상대 경로(./)·슬러그 모두 같은 프로젝트를 가리키고, 윈도 꼴 경로는 충돌 없이 거부한다", () =>
  with_set((e) => {
    const f = bytes_file(e, "값 파일 (한글).txt", "경로 시험 요약");
    ok_run(e.py(["set", e.folder, "plan", "summary", f]), "절대 경로");
    assert.equal(e.state().stages.plan.summary, "경로 시험 요약");
    ok_run(e.py(["set", e.slug, "plan", "summary", bytes_file(e, "b.txt", "슬러그")]), "슬러그");
    // 홈 밖 공백·한글 폴더 (init 은 절대 경로 폴더도 만든다)
    const odd = join(e.home.root, "다른 폴더 (공백)", "proj 하나");
    ok_run(e.py(["init", odd, "--topic", "공백 경로"]), "init odd");
    ok_run(e.py(["set", odd, "project", "conclusion", f]), "공백·한글 경로");
    assert.equal(JSON.parse(readFileSync(join(odd, "project.json"), "utf8")).conclusion, "경로 시험 요약");
    // 상대 경로: cwd 는 홈 루트
    ok_run(e.py(["set", "./다른 폴더 (공백)/proj 하나", "plan", "summary", "값 파일 (한글).txt"]), "상대 경로");
    // 윈도 꼴: macOS/Linux 에서는 그런 폴더가 없으므로 거부, Windows 에서는 다른 임시 경로라 역시 없음
    for (const odd_path of ["C:\\없는\\폴더", "..\\없는", "\\\\서버\\공유\\p"]) {
      const before = e.raw();
      const res = e.py(["set", odd_path, "plan", "summary", f]);
      expect_refused(res, `윈도 꼴 경로 ${odd_path}`);
      assert.equal(e.raw(), before);
    }
  }));

test("set: project.json 이 깨져 있으면 충돌이 아니라 분명한 이유로 거부하고 파일을 건드리지 않는다", () =>
  with_set((e) => {
    writeFileSync(e.json_path, '{"pes": 1, "topic": ', "utf8");
    refuse_unchanged(e, ["set", e.slug, "plan", "summary", bytes_file(e, "v.txt", "요약")], "깨진 project.json");
  }));

// ---------------------------------------------------------------------------
// 동시 실행·잠금 경합

interface Done {
  status: number | null;
  stderr: string;
  stdout: string;
}

function py_async(e: SetEnv, args: string[], extra: Record<string, string> = {}): Promise<Done> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string | undefined> = { ...e.home.env, PES_OWNER: undefined, PES_TOKEN: undefined, PES_DB_CORE: undefined, ...extra };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const child = spawn(PY, ["-I", "-X", "utf8", PES_PY, ...args], { env: env as NodeJS.ProcessEnv, cwd: e.home.root });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code, stderr: err, stdout: out }));
  });
}

test("set 동시 실행 둘: 어느 쪽도 충돌하지 않고 project.json 은 항상 유효하며 tmp 가 남지 않는다 (10회)", async () => {
  const e = (await import("./helpers/set_env.ts")).make_set_env();
  try {
    for (let round = 0; round < 10; round++) {
      const a = bytes_file(e, `a${round}.txt`, `에이 ${round}`);
      const b = bytes_file(e, `b${round}.txt`, `비 ${round}`);
      const [ra, rb] = await Promise.all([
        py_async(e, ["set", e.slug, "plan", "summary", a]),
        py_async(e, ["set", e.slug, "project", "conclusion", b]),
      ]);
      for (const [name, r] of [["a", ra], ["b", rb]] as const) {
        assert.doesNotMatch(r.stderr, /Traceback|FileNotFoundError|PermissionError/, `라운드 ${round} ${name}: 충돌하면 안 된다\n${r.stderr}`);
        assert.equal(r.status, 0, `라운드 ${round} ${name}: 종료 ${r.status}\n${r.stderr}`);
      }
      const st = JSON.parse(readFileSync(e.json_path, "utf8")); // 유효한 JSON
      assert.equal(typeof st.stages.plan.summary, "string");
      assert.ok(!existsSync(join(e.folder, "project.json.tmp")), `라운드 ${round}: tmp 가 남는다`);
    }
  } finally {
    e.cleanup();
  }
});

test("set 동시 실행 둘이 같은 세션(PES_OWNER)이면 두 값이 모두 남는다 — 갱신 유실 없음", async () => {
  const e = (await import("./helpers/set_env.ts")).make_set_env();
  try {
    let lost = 0;
    for (let round = 0; round < 12; round++) {
      const a = bytes_file(e, `a${round}.txt`, `에이 ${round}`);
      const b = bytes_file(e, `b${round}.txt`, `비 ${round}`);
      const owner = { PES_OWNER: "session-same0001" };
      await Promise.all([py_async(e, ["set", e.slug, "plan", "summary", a], owner), py_async(e, ["set", e.slug, "project", "conclusion", b], owner)]);
      const st = JSON.parse(readFileSync(e.json_path, "utf8"));
      if (st.stages.plan.summary !== `에이 ${round}` || st.conclusion !== `비 ${round}`) lost += 1;
    }
    assert.equal(lost, 0, `12번 중 ${lost}번 한쪽 갱신이 사라졌다 (읽기-수정-쓰기 사이에 교체됨)`);
  } finally {
    e.cleanup();
  }
});

test("set 잠금 경합: 같은 시각에 잠근 세션과 다른 세션이 쓰면 다른 세션만 거부되고 값은 잠근 쪽 것이다", async () => {
  const e = (await import("./helpers/set_env.ts")).make_set_env();
  try {
    ok_run(e.py(["lock", e.slug], { extra: { PES_OWNER: "session-owner01" } }), "lock");
    for (let round = 0; round < 6; round++) {
      const mine = bytes_file(e, `m${round}.txt`, `주인 ${round}`);
      const theirs = bytes_file(e, `t${round}.txt`, `남 ${round}`);
      const [r1, r2] = await Promise.all([
        py_async(e, ["set", e.slug, "plan", "summary", mine], { PES_OWNER: "session-owner01" }),
        py_async(e, ["set", e.slug, "plan", "summary", theirs], { PES_OWNER: "session-other02" }),
      ]);
      assert.equal(r1.status, 0, r1.stderr);
      assert.notEqual(r2.status, 0, "다른 세션은 거부");
      assert.doesNotMatch(r2.stderr, /Traceback/);
      assert.match(r2.stderr, /다른 세션/);
      assert.equal(JSON.parse(readFileSync(e.json_path, "utf8")).stages.plan.summary, `주인 ${round}`);
    }
    const lock = JSON.parse(readFileSync(join(e.folder, ".pes-lock"), "utf8"));
    assert.equal(lock.owner, "session-owner01", "남의 시도가 잠금 주인을 바꾸지 못한다");
  } finally {
    e.cleanup();
  }
});

test("set: 같은 이름으로 끊긴 tmp 가 남아 있어도(앞선 실패 흔적) 정상 저장하고 tmp 를 남기지 않는다", () =>
  with_set((e) => {
    writeFileSync(join(e.folder, "project.json.tmp"), "{끊긴 흔적", "utf8");
    ok_run(e.py(["set", e.slug, "plan", "summary", bytes_file(e, "v.txt", "흔적 뒤 요약")]), "set");
    assert.equal(e.state().stages.plan.summary, "흔적 뒤 요약");
    assert.ok(!existsSync(join(e.folder, "project.json.tmp")));
  }));

test("set: 값 파일이 프로젝트 폴더 안(rounds/…)에 있어도 되고, 폴더 안 project.json 자체를 값 파일로 주면 거부하거나 안전하게 문자열로만 취급한다", () =>
  with_set((e) => {
    mkdirSync(join(e.folder, "rounds", "plan-R1"), { recursive: true });
    const inside = join(e.folder, "rounds", "plan-R1", "summary.txt");
    writeFileSync(inside, "폴더 안 값 파일", "utf8");
    ok_run(e.py(["set", e.slug, "plan", "summary", inside]), "폴더 안 값 파일");
    assert.equal(e.state().stages.plan.summary, "폴더 안 값 파일");
    // project.json 을 summary 값으로 주면: 통째 JSON 문자열이 summary 에 들어가는 것은 허용 필드이므로 막을 이유는 없지만, 파일이 유효해야 한다
    const res = e.py(["set", e.slug, "plan", "summary", e.json_path]);
    if (res.status === 0) JSON.parse(e.raw());
    else expect_refused(res, "project.json 을 값으로");
  }));

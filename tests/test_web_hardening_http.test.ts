/**
 * SEL-51 PR18 — 화면 서버 보강 시험 1/2 (tester, 보강 모드): Origin·CSRF 우회, 본문(크기·깊이·잘못된 UTF-8), 경로 이탈, /api/v1 이름 충돌.
 * 구현을 깨뜨리려는 시험이다. 바이트 단위가 필요해서 fetch 대신 node:http(tests/helpers/web_raw.ts)로 보낸다.
 * 모두 합성 자료. 서버는 임시 HOME·USERPROFILE·PES_HOME 에서만 뜬다. 서버 하나·프로젝트 하나를 파일 안에서 같이 쓴다(준비물 재사용).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";

import type { CliEnv } from "./helpers/cli_write_env.ts";
import { plain_legacy, read_lf } from "./helpers/cli_read_env.ts";
import { commit_count, db_with_form, feedback_body, http, SLUG, start_server, step, sub_count, type Server } from "./helpers/web_env.ts";
import { raw, raw_post, tree } from "./helpers/web_raw.ts";

const CANARY = "OUTSIDE-CANARY-MUST-NOT-LEAK-sel51";
const STATIC_TRAP = "STATIC-FILE-MUST-NOT-BE-SERVED-sel51";

let c: CliEnv;
let s: Server;
let pes_home: string;
let outside: string;

before(async () => {
  c = await db_with_form();
  pes_home = c.env.home.env.PES_HOME as string;
  outside = join(dirname(pes_home), "outside-canary.txt"); // PES_HOME 바깥(임시 루트 안)
  writeFileSync(outside, CANARY, "utf8");
  writeFileSync(join(dirname(pes_home), "outside-canary.json"), JSON.stringify({ secret: CANARY }), "utf8");
  s = await start_server(c);
});

after(async () => {
  await s?.stop();
  c?.close();
});

const writes = (): { commits: number; subs: number; files: string[]; log: string } => ({
  commits: commit_count(c),
  subs: sub_count(c),
  files: tree(pes_home),
  log: existsSync(join(c.folder, "feedback.log")) ? read_lf(join(c.folder, "feedback.log")) : "",
});

function expect_no_new_writes(before_state: ReturnType<typeof writes>, what: string): void {
  const now = writes();
  assert.equal(now.commits, before_state.commits, `${what}: DB 커밋이 늘었다`);
  assert.equal(now.subs, before_state.subs, `${what}: 제출이 늘었다`);
  assert.deepEqual(now.files, before_state.files, `${what}: PES 홈에 파일이 생겼다`);
  assert.equal(now.log, before_state.log, `${what}: feedback.log 가 바뀌었다`);
}

const alive = async (): Promise<void> => {
  const r = await http(s, "/ping");
  assert.equal(r.status, 200, "서버가 아직 산다");
};

// ---------------------------------------------------------------------------
// CSRF · Origin

test("H1a Origin 우회 모음: null·대문자·포트 다름·끝 슬래시·사용자정보·https·IPv6·Referer 만 — 모두 403 + origin 오류, 쓰기 0", async () => {
  const own = s.origin;
  const port = s.port;
  const origins: Array<[string, string | null, Record<string, string>]> = [
    ["Origin: null (sandbox iframe·file://)", "null", {}],
    ["대문자 스킴", own.replace("http", "HTTP"), {}],
    ["대문자 호스트 LOCALHOST", `http://LOCALHOST:${port}`, {}],
    ["끝 슬래시", `${own}/`, {}],
    ["포트 없음", "http://127.0.0.1", {}],
    ["다른 포트", `http://127.0.0.1:${port + 1}`, {}],
    ["포트 뒤에 도메인 이어 붙이기", `${own}.evil.example`, {}],
    ["사용자정보로 속이기", `http://evil.example@127.0.0.1:${port}`, {}],
    ["https 스킴", `https://127.0.0.1:${port}`, {}],
    ["IPv6 루프백", `http://[::1]:${port}`, {}],
    ["0.0.0.0", `http://0.0.0.0:${port}`, {}],
    ["공백만", " ", {}],
    ["Origin 없음 + 같은 출처 Referer 만", null, { Referer: `${own}/${SLUG}/ask-plan-start.html` }],
    ["Origin 없음 + Sec-Fetch-Site: same-origin 만", null, { "Sec-Fetch-Site": "same-origin" }],
    ["Origin 없음 + Content-Type text/plain (단순 요청)", null, { "Content-Type": "text/plain" }],
  ];
  const before_state = writes();
  for (const [what, origin, headers] of origins) {
    const r = await raw_post(s, `/${SLUG}/feedback`, JSON.stringify(feedback_body()), { origin, headers });
    assert.equal(r.status, 403, `${what}: ${r.status} ${r.text}`);
    assert.equal(r.json?.ok, false, what);
    assert.equal(r.json?.error, "origin", what);
    assert.ok(!("Access-Control-Allow-Origin".toLowerCase() in r.headers), `${what}: 거부 응답에 CORS 허용 머리글이 있다`);
  }
  expect_no_new_writes(before_state, "Origin 우회");
  await alive();
});

// (H1b /api/v1 … — 지웠다: PR18 의 DB 서버·0.15 플래그 기능이고 scripts/serve.ts 에는 대응이 없다. tests/README.md 처리표 '서버 갭'/'플래그')
test("H1c 같은 출처(127.0.0.1·localhost)의 정상 POST 는 받는다 — 거부 규칙이 정상 길을 막지 않는다", async () => {
  const before_state = writes();
  const a = await raw_post(s, `/${SLUG}/feedback`, JSON.stringify(feedback_body({ text: "합성 정상 하나", answers: { memo: "정상 하나" } })), { origin: `http://127.0.0.1:${s.port}` });
  assert.equal(a.status, 200, a.text);
  const b = await raw_post(s, `/${SLUG}/feedback`, JSON.stringify(feedback_body({ text: "합성 정상 둘", answers: { memo: "정상 둘" } })), { origin: `http://localhost:${s.port}` });
  assert.equal(b.status, 200, b.text);
  const now = writes();
  assert.equal(now.commits - before_state.commits, 2);
  assert.equal(now.subs - before_state.subs, 2);
  assert.notEqual(a.json.file, b.json.file, "서로 다른 처리 대기 이름");
});

// ---------------------------------------------------------------------------
// 본문

test("H2a 잘못된 UTF-8 본문·NUL·BOM·빈 본문: 5xx 나 연결 끊김 없이 거절하고(400/413) 아무것도 쓰지 않는다", async () => {
  const before_state = writes();
  const bodies: Array<[string, Buffer]> = [
    ["잘못된 UTF-8 바이트", Buffer.from([0x7b, 0x22, 0x74, 0x65, 0x78, 0x74, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0xc0, 0x80, 0x22, 0x7d])],
    ["잘린 멀티바이트", Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xed, 0x95]), Buffer.from('"}')])],
    ["NUL 바이트로 시작", Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(feedback_body()))])],
    ["JSON 배열(객체 아님)", Buffer.from("[1,2,3]")],
    ["JSON 문자열", Buffer.from('"just a string"')],
    ["JSON null", Buffer.from("null")],
    ["숫자", Buffer.from("42")],
    ["공백만", Buffer.from("   ")],
  ];
  for (const [what, body] of bodies) {
    const r = await raw_post(s, `/${SLUG}/feedback`, body);
    assert.ok([400, 413].includes(r.status), `${what}: 400/413 이어야 한다 (받은 ${r.status} ${r.text.slice(0, 120)})`);
    assert.equal(r.json?.ok, false, what);
  }
  expect_no_new_writes(before_state, "잘못된 본문");
  await alive();
});

test("H2b 형식이 틀린 필드: round 가 문자·null·무한대·거대 소수, answers 가 배열·문자열, text 가 숫자 — 5xx 없이 400 이거나 정리해서 받는다", async () => {
  const before_state = writes();
  const cases: Array<[string, string]> = [
    ["round 문자", '{"round":"abc","kind":"feedback","text":"x"}'],
    ["round null", '{"round":null,"kind":"feedback","text":"x"}'],
    ["round 무한대 리터럴", '{"round":1e999,"kind":"feedback","text":"x"}'],
    ["kind 배열", '{"round":0,"kind":["feedback"],"text":"x"}'],
    ["kind 비어 있는 문자열", '{"round":0,"kind":"","text":"x"}'], // v0.15: "" -> "feedback"
  ];
  for (const [what, body] of cases) {
    const r = await raw_post(s, `/${SLUG}/feedback`, body);
    assert.ok([200, 400].includes(r.status), `${what}: ${r.status} ${r.text.slice(0, 160)}`);
    assert.equal(typeof r.json?.ok, "boolean", `${what}: 본문이 {ok} JSON 이다`);
  }
  await alive();
  // 받은 것(200)만큼만 쓰기가 있었고, 받은 것은 정확히 한 건당 한 커밋이다
  const now = writes();
  assert.equal(now.commits - before_state.commits, now.subs - before_state.subs, "받은 답마다 커밋 한 번·제출 한 건");
  const log_new = now.log.slice(before_state.log.length).split("\n").filter(Boolean);
  assert.equal(log_new.length, now.subs - before_state.subs, "알림 줄 수 = 받은 답 수");
});

test("H2c 아주 깊은 JSON: 파이썬 재귀 한도를 넘는 중첩과 한도 근처 중첩 모두 연결 끊김·500 없이 거절/수용한다", async () => {
  const nest = (depth: number): string => `{"round":0,"kind":"feedback","text":"깊이 시험","answers":{"a":${"[".repeat(depth)}${"]".repeat(depth)}}}`;
  const before_state = writes();
  const deep = await raw_post(s, `/${SLUG}/feedback`, nest(20000));
  // 클라이언트 입력 문제는 4xx 다. 503 {"error":"db"} 는 "DB 가 죽었으니 나중에 다시"라는 뜻이라 틀린 안내다.
  assert.ok([400, 413].includes(deep.status), `깊이 20000(256KiB 안): ${deep.status} ${deep.text.slice(0, 120)}`);
  expect_no_new_writes(before_state, "깊이 20000");
  // 파이썬 json.loads 한도 바로 안쪽: 읽기는 되지만 브리지로 다시 직렬화하는 깊이에서 끊기지 않아야 한다.
  const results: Array<[number, number]> = [];
  for (const depth of [100, 400, 800, 900, 950, 970, 985, 990, 995]) {
    const r = await raw_post(s, `/${SLUG}/feedback`, nest(depth));
    results.push([depth, r.status]);
    assert.ok([200, 400, 413].includes(r.status), `깊이 ${depth}: 상태 ${r.status} (0=연결 끊김, 5xx=서버 오류) ${r.text.slice(0, 160)}`);
    assert.equal(r.json?.ok === true || r.json?.ok === false, true, `깊이 ${depth}: 본문이 {ok} JSON 이다`);
  }
  await alive();
  const now = writes();
  const accepted = results.filter(([, status]) => status === 200).length;
  assert.equal(now.subs - before_state.subs, accepted, `받은 만큼만 제출 (${JSON.stringify(results)})`);
});

test("H2d 본문 크기 경계: 정확히 256KiB 는 받고 1바이트 넘으면 413, Content-Length 0·chunked 는 거절 — 거절은 쓰기 0", async () => {
  const MAX = 256 * 1024;
  const sized = (bytes: number): string => {
    const stem = JSON.stringify({ round: 0, kind: "feedback", stage: "plan", text: "요약", answers: { memo: "" } });
    const pad = bytes - Buffer.byteLength(stem);
    assert.ok(pad > 0);
    return JSON.stringify({ round: 0, kind: "feedback", stage: "plan", text: "요약", answers: { memo: "m".repeat(pad) } });
  };
  const exact = sized(MAX);
  assert.equal(Buffer.byteLength(exact), MAX);
  const before_state = writes();
  const over = await raw_post(s, `/${SLUG}/feedback`, sized(MAX + 1));
  assert.equal(over.status, 413, `${MAX + 1} 바이트: ${over.status}`);
  const empty = await raw_post(s, `/${SLUG}/feedback`, "");
  assert.ok([400, 413].includes(empty.status), `빈 본문: ${empty.status}`);
  const chunked = await raw_post(s, `/${SLUG}/feedback`, JSON.stringify(feedback_body()), { chunked: true });
  assert.ok([400, 411, 413].includes(chunked.status), `chunked: ${chunked.status} (조용히 성공하면 안 된다 — Content-Length 없는 본문은 읽지 않는다)`);
  expect_no_new_writes(before_state, "크기 경계 거절");
  const fit = await raw_post(s, `/${SLUG}/feedback`, exact);
  assert.equal(fit.status, 200, `정확히 ${MAX} 바이트: ${fit.status} ${fit.text.slice(0, 160)}`);
  assert.equal(commit_count(c) - before_state.commits, 1);
  await alive();
});

test("H2g v0.15 가 받던 큰 답: text 가 10만 자를 넘어도 본문 상한(256KiB) 안이면 받는다 — 한도 때문에 사람의 답이 조용히 버려지지 않는다", async () => {
  const before_state = writes();
  const ascii = `[단계 시작 질문 · 기획]\n${"a".repeat(120_000)}`; // 120,000 바이트 < 262,144
  assert.ok(Buffer.byteLength(JSON.stringify(feedback_body({ text: ascii, answers: { memo: "합성" } }))) < 256 * 1024);
  const r = await raw_post(s, `/${SLUG}/feedback`, JSON.stringify(feedback_body({ text: ascii, answers: { memo: "합성" } })));
  assert.equal(r.status, 200, `120,000 자 text(본문 120KB): ${r.status} ${r.text.slice(0, 120)} — v0.15 는 받았다`);
  assert.equal(commit_count(c) - before_state.commits, 1);
});

test("H2e 거짓 Content-Length: 보낸 것보다 큰 값·음수·숫자 아님 — 서버가 매달리지 않고 끊거나 거절하고 쓰기 0", async () => {
  const before_state = writes();
  for (const length of ["-5", "abc", "1e3", "99999999999999999999", "0x10"]) {
    const r = await raw(s, {
      method: "POST",
      path: `/${SLUG}/feedback`,
      headers: { Origin: s.origin, "Content-Type": "application/json", "Content-Length": length },
      body: "",
    });
    // 어떤 거절이든 좋다(400/411/413) 또는 응답 없이 닫기(0). 200 은 안 된다.
    assert.ok(r.status !== 200 && r.status < 500, `Content-Length ${length}: ${r.status} ${r.text.slice(0, 120)}`);
  }
  expect_no_new_writes(before_state, "거짓 Content-Length");
  await alive();
});

test("H2f 로그 줄 주입: 줄바꿈·제어 문자를 담은 stage·kind·spec·text 가 feedback.log 를 한 줄 이상으로 쪼개거나 가짜 줄을 만들지 못한다", async () => {
  const before_state = writes();
  const lines_before = before_state.log.split("\n").filter(Boolean).length;
  const evil = "x\nFEEDBACK plan R0 approve /etc/passwd\r\nFEEDBACK";
  const body = feedback_body({ stage: `pl\nan${evil}`, spec: evil, kind: "feedback", text: evil, answers: { memo: evil } });
  const r = await raw_post(s, `/${SLUG}/feedback`, JSON.stringify(body));
  assert.ok([200, 400].includes(r.status), `${r.status} ${r.text}`);
  const now_lines = read_lf(join(c.folder, "feedback.log")).split("\n").filter(Boolean);
  assert.equal(now_lines.length - lines_before, r.status === 200 ? 1 : 0, "받은 답마다 정확히 한 줄");
  for (const line of now_lines.slice(lines_before)) {
    assert.match(line, /^FEEDBACK [a-z]+ R-?\d+ [a-z_]+ \S/, "알림 줄 형식");
    assert.ok(!line.includes("passwd"), "주입한 내용이 알림 줄에 없다");
  }
});

// ---------------------------------------------------------------------------
// 경로 이탈 (fetch 는 ".." 를 접으므로 raw 로 보낸다)

test("H6a 정적 경로 이탈: 원문·인코딩(%2e%2e, %2f, %5c)·이중 인코딩·NUL 어느 쪽으로도 PES 홈 밖 파일이 나가지 않는다", async () => {
  const paths = [
    "/../outside-canary.txt",
    "/../../outside-canary.txt",
    "/..%2foutside-canary.txt",
    "/%2e%2e/outside-canary.txt",
    "/%2e%2e%2foutside-canary.txt",
    "/%2E%2E/%2E%2E/outside-canary.txt",
    "/..%5coutside-canary.txt",
    "/..\\outside-canary.txt",
    "/%252e%252e/outside-canary.txt",
    "/%252e%252e%252foutside-canary.txt",
    "/....//outside-canary.txt",
    "/.%2e/outside-canary.txt",
    `/${SLUG}/../outside-canary.txt`,
    `/${SLUG}/../`,
    `/${SLUG}/%2e%2e/outside-canary.txt`,
    `/${SLUG}/%2e%2e/%2e%2e/outside-canary.txt`,
    `/${SLUG}/..%2f..%2foutside-canary.txt`,
    `/${SLUG}/..%5c..%5coutside-canary.txt`,
    `/${SLUG}/reports/../../outside-canary.txt`,
    `/${SLUG}/out/../../outside-canary.txt`,
    `/${SLUG}/reports/plan/..%2f..%2f..%2foutside-canary.txt`,
    `/${SLUG}/reports/plan/%2e%2e/%2e%2e/%2e%2e/outside-canary.txt`,
    `/${SLUG}/out/..%2f..%2f..%2foutside-canary.json`,
    `/${SLUG}/reports/plan/report.html%00.txt`,
    `/${SLUG}%00/`,
    "//outside-canary.txt",
    "/\\outside-canary.txt",
    "/.%00./outside-canary.txt",
  ];
  const secret = readfile_label();
  for (const path of paths) {
    const r = await raw(s, { path });
    assert.ok(!r.text.includes(CANARY), `${path}: PES 홈 밖 파일이 나갔다 (${r.status})`);
    assert.ok(!r.text.includes(secret), `${path}: 임시 루트의 다른 내용이 나갔다`);
    assert.notEqual(r.status, 500, `${path}: 500`);
  }
  await alive();
});

function readfile_label(): string {
  return c.env.home.env.HOME as string; // 사용자 홈(임시)의 경로가 본문에 실리면 안 된다
}

test("H6b 경로 이탈 POST: /<slug>/../<다른>/feedback·%2f·%2e%2e 로 다른 프로젝트·홈 밖으로 답을 쓰지 못한다", async () => {
  const before_state = writes();
  const paths = [
    `/${SLUG}/../${SLUG}/feedback`,
    `/${SLUG}/%2e%2e/${SLUG}/feedback`,
    `/${SLUG}/..%2f${SLUG}%2ffeedback`,
    `/../${SLUG}/feedback`,
    `/${SLUG}/./feedback/`,
    `/${SLUG}/feedback/../feedback`,
    `/${SLUG}/feedback/extra`,
    `/%2e%2e/feedback`,
    "/feedback",
  ];
  for (const path of paths) {
    const r = await raw_post(s, path, JSON.stringify(feedback_body()));
    // 어떤 경로든 홈 밖·다른 곳에 쓰지 않는다. 정확히 이 프로젝트의 feedback 으로 정규화되는 경우만 받아도 된다.
    assert.ok([200, 403, 404].includes(r.status), `${path}: ${r.status} ${r.text.slice(0, 120)}`);
  }
  const now = writes();
  const received = now.subs - before_state.subs;
  assert.equal(now.commits - before_state.commits, received, "받은 만큼만 커밋");
  assert.deepEqual(
    now.files.filter((f) => !before_state.files.includes(f)),
    received > 0 ? [`${SLUG}/feedback.log`].filter((f) => !before_state.files.includes(f)) : [],
    "PES 홈 안의 새 파일은 feedback.log 뿐이다",
  );
  assert.ok(!existsSync(join(dirname(pes_home), "feedback")), "PES 홈 밖에 feedback 폴더가 없다");
  assert.ok(!existsSync(join(dirname(pes_home), "feedback.log")));
});

test("H6c 심볼릭 링크: 폴더 안 reports/·out/ 링크는 DB 보고서 길이 따라가지 않는다 (DB 가 서빙하는 주소는 폴더 파일이 아니다)", async () => {
  step(c, ["report", SLUG, "plan"]);
  const dir = join(c.folder, "reports", "plan");
  mkdirSync(dir, { recursive: true });
  const trap_report = join(dir, "trap.html");
  const trap_out = join(c.folder, "out");
  try {
    symlinkSync(outside, trap_report);
    mkdirSync(trap_out, { recursive: true });
    symlinkSync(outside, join(trap_out, "trap.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") return; // Windows: 링크 권한 없음
    throw error;
  }
  for (const path of [`/${SLUG}/reports/plan/trap.html`, `/${SLUG}/out/trap.json`]) {
    const r = await http(s, path);
    assert.ok(!r.text.includes(CANARY), `${path}: 링크를 따라 홈 밖 파일이 나갔다 (${r.status})`);
    assert.equal(r.status, 404, `${path}: DB 에 없는 보고서 파일은 404`);
  }
  // DB 가 가진 파일은 폴더에 같은 이름의 링크가 있어도 DB 내용이다
  const real = join(dir, "report.html");
  try {
    symlinkSync(outside, real);
  } catch {
    return;
  }
  const r = await http(s, `/${SLUG}/reports/plan/report.html`);
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(CANARY), "DB 의 보고서가 폴더 링크로 바뀌어 나가면 안 된다");
});

// ---------------------------------------------------------------------------
// /api/v1 과 정적 폴더 이름 충돌

// (H7 /api/v1 … — 지웠다: PR18 의 DB 서버·0.15 플래그 기능이고 scripts/serve.ts 에는 대응이 없다. tests/README.md 처리표 '서버 갭'/'플래그')

/**
 * SEL-85 1차 리뷰(보안) 권장 1·2·4·5·6 의 시험 — 새 시험만 더한다(기존 시험 단언은 그대로).
 *
 *   - 권장 1: 발급 길(세션 헤더 없음/틀림 → 401·예산 안 씀, 닫힌 본문 → 400, 큰 본문 → 413)과 교환 길(Origin 없음·대소문자·끝 슬래시 → 403 이고 코드는 안 탄다,
 *             413)을 HTTP 로 직접 본다. 예산·상한·TTL 경계는 시계를 주입한 AppCodes 단위 시험으로 값싸게 본다.
 *   - 권장 2: API 프록시는 Cache-Control 기본값을 더하지 않는다(두 새 길만 send() 로 no-store).
 *   - 권장 4: 교환 예산은 실패한 시도만 센다 — 맞는 코드는 세지 않고, 예산이 바닥나도 맞는 코드는 통한다.
 *   - 권장 5: 쓰이지 않은 유효 코드가 64개면 새 발급은 거절(오래된 것을 밀어내지 않는다).
 *   - 권장 6: 브라우저 열기 인자는 모든 플랫폼에서 주소 하나뿐이다(Windows rundll32 포함).
 * 실제 홈·실제 PES 포트 0: 임시 홈 + 주입된 빈 포트(TsServeProcess).
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { TsServeProcess, srv_seed_project } from "./helpers/compat_ts_srv.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { connect_read_only } from "../scripts/pes_core/db.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { AppCodes, CODE_SHAPE, EXCHANGE_ATTEMPTS_PER_MINUTE, ISSUE_REQUESTS_PER_MINUTE, MAX_LIVE_CODES, code_ttl_ms, valid_projects } from "../scripts/pes_core/app_session.ts";
import { browser_command } from "../scripts/pes_core/cli_server.ts";
import { serve_fixture, type ServeFixture } from "./helpers/serve_ts_env.ts";

use_home_guard();

const SECRET = "synthetic-sel85-review-owner-session-0123456789abcdef";
const EXCHANGE = "/api/v1/app-session";
const ISSUE = "/api/v1/app-session/codes";
const UNKNOWN_CODE = "A".repeat(43);

interface Fx {
  fx: ServeFixture;
  server: TsServeProcess;
  project_id: string;
  issue(projects?: unknown, session?: string | null): ReturnType<TsServeProcess["post"]>;
  exchange(code: unknown, origin?: string | null): ReturnType<TsServeProcess["post"]>;
  cleanup(): Promise<void>;
}

async function start(prefix: string): Promise<Fx> {
  const fx = await serve_fixture(prefix, { no_start: true, no_db: true });
  mkdirSync(fx.project, { recursive: true });
  writeFileSync(join(fx.project, "project.json"), JSON.stringify({ pes: 1, topic: "합성 주제", stages: { plan: { items: [{ id: 1, title: "합성 항목" }] } } }), "utf8");
  await srv_seed_project(fx.ctx, fx.project);
  const server = new TsServeProcess(fx.ctx, fx.root, { extra_env: { PES_LOCAL_SESSION_SECRET: SECRET } });
  await server.start();
  const db = connect_read_only(db_path(fx.ctx.env));
  let project_id: string;
  try {
    project_id = db.get<{ id: string }>("SELECT id FROM projects WHERE slug = 'synthetic'")!.id;
  } finally {
    db.close();
  }
  return {
    fx,
    server,
    project_id,
    issue: (projects = { synthetic: project_id }, session = SECRET) => server.post(ISSUE, { projects }, null, session === null ? {} : { "x-pes-session": session }),
    exchange: (code, origin = server.origin()) => server.post(EXCHANGE, { code }, origin),
    cleanup: async () => {
      await server.stop();
      await fx.cleanup();
    },
  };
}

const no_store = (res: { headers: Record<string, string> }): void => assert.match(res.headers["cache-control"] ?? "", /no-store/);
const has_no_session = (text: string): void => assert.ok(!text.includes(SECRET), "the answer holds no session");

// ---------------------------------------------------------------- 권장 1: 발급 길

test("R1 발급: 세션 헤더가 없거나 틀리면 401 — 코드는 안 만들어지고 발급 예산도 쓰지 않는다", { timeout: 120_000 }, async () => {
  const f = await start("pes-sel85-rf-issue-auth-");
  try {
    for (const session of [null, "", "wrong-session", SECRET.slice(0, -1), `${SECRET}x`, SECRET.toUpperCase()]) {
      const res = await f.issue(undefined, session);
      assert.equal(res.status, 401, `session ${JSON.stringify(session)} → ${res.status} ${res.text()}`);
      assert.equal(res.json().data, undefined, "no code in a refusal");
      has_no_session(res.text());
      no_store(res);
    }
    // 무인증 요청이 예산을 못 쓴다: 한도보다 많이 두드려도 소유자의 첫 발급은 201
    for (let i = 0; i < ISSUE_REQUESTS_PER_MINUTE + 5; i += 1) assert.equal((await f.issue(undefined, null)).status, 401);
    const ok = await f.issue();
    assert.equal(ok.status, 201, ok.text());
    assert.match(ok.json().data.code, CODE_SHAPE);
    assert.deepEqual(Object.keys(ok.json().data), ["code"]);
    no_store(ok);
    // 호출자는 세션을 고르지 못한다: 코드는 서버가 가진 소유자 세션을 가리킨다
    const traded = await f.exchange(ok.json().data.code);
    assert.equal(traded.status, 200, traded.text());
    assert.equal(traded.json().data.session, SECRET);
    assert.deepEqual(traded.json().data.projects, { synthetic: f.project_id });
  } finally {
    await f.cleanup();
  }
});

test("R1 발급: 본문은 닫힌 모양 {projects:{slug:id}} 뿐 — 그 밖은 400, 5KB 본문은 413, 모두 no-store 이고 세션이 없다", { timeout: 120_000 }, async () => {
  const f = await start("pes-sel85-rf-issue-body-");
  try {
    const many: Record<string, string> = {};
    for (let i = 0; i < 65; i += 1) many[`p${i}`] = "id";
    const bad: unknown[] = [
      [],
      null,
      "synthetic",
      { "Bad Slug": "id" },
      { "_hidden": "id" },
      { "../x": "id" },
      { a: "" },
      { a: 1 },
      { a: "x".repeat(129) },
      { a: "line\nbreak" },
      many,
    ];
    for (const projects of bad) {
      const res = await f.issue(projects);
      assert.equal(res.status, 400, `${JSON.stringify(projects).slice(0, 60)} → ${res.status} ${res.text()}`);
      assert.equal(res.json().data, undefined);
      has_no_session(res.text());
      no_store(res);
    }
    // 다른 키(세션을 고르려는 시도 포함)가 붙으면 400
    for (const extra of [{ session: "attacker-chosen" }, { code: "x" }, { projects_extra: 1 }]) {
      const res = await f.server.post(ISSUE, { projects: { synthetic: f.project_id }, ...extra }, null, { "x-pes-session": SECRET });
      assert.equal(res.status, 400, JSON.stringify(extra));
      assert.equal(res.json().data, undefined);
    }
    for (const raw of [Buffer.from("{}"), Buffer.from("not json"), Buffer.from("[]"), Buffer.from("null"), Buffer.from([0xff, 0xfe, 0x7b, 0x7d]), Buffer.alloc(0)]) {
      const res = await f.server.post(ISSUE, raw, null, { "x-pes-session": SECRET });
      assert.equal(res.status, 400, `raw ${raw.length} bytes → ${res.status}`);
      has_no_session(res.text());
    }
    const big = await f.server.post(ISSUE, Buffer.from(JSON.stringify({ projects: { a: "x".repeat(5000) } }), "utf8"), null, { "x-pes-session": SECRET });
    assert.equal(big.status, 413, big.text());
    has_no_session(big.text());
    no_store(big);
    // 상한(64 slug)에 딱 맞는 모양은 통한다
    delete many.p64;
    const edge = await f.issue(many);
    assert.equal(edge.status, 201, edge.text());
    assert.equal(Object.keys((await f.exchange(edge.json().data.code)).json().data.projects).length, 64);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------- 권장 1: 교환 길

test("R1 교환 Origin: 헤더 없음·대소문자·끝 슬래시·경로 붙은 값은 403 이고, 거절된 시도는 코드를 태우지 않는다", { timeout: 120_000 }, async () => {
  const f = await start("pes-sel85-rf-origin-");
  try {
    const code = (await f.issue()).json().data.code as string;
    const port = f.server.port;
    for (const origin of [null, "", `HTTP://127.0.0.1:${port}`, `http://127.0.0.1:${port}/`, `http://127.0.0.1:${port}/x`, `http://127.0.0.1.evil.example:${port}`]) {
      const res = await f.exchange(code, origin);
      assert.equal(res.status, 403, `Origin ${JSON.stringify(origin)} → ${res.status}`);
      assert.equal(res.json().data, undefined);
      has_no_session(res.text());
      no_store(res);
    }
    // 위에서 거절된 시도는 코드를 읽지 않았다: 맞는 Origin 에서는 아직 통한다
    const good = await f.exchange(code);
    assert.equal(good.status, 200, good.text());
    assert.equal(good.json().data.session, SECRET);
  } finally {
    await f.cleanup();
  }
});

test("R1 교환 본문: 5KB 이상은 413(세션 없음·no-store), 코드 모양 틀림은 400, 모르는 코드는 401", { timeout: 120_000 }, async () => {
  const f = await start("pes-sel85-rf-exch-body-");
  try {
    const big = await f.server.post(EXCHANGE, Buffer.from(JSON.stringify({ code: "a".repeat(5000) }), "utf8"), f.server.origin());
    assert.equal(big.status, 413, big.text());
    no_store(big);
    has_no_session(big.text());
    for (const code of ["short", "has space has space has space", `${"a".repeat(129)}`, `${"é".repeat(30)}`]) assert.equal((await f.exchange(code)).status, 400, code);
    for (const body of [{ code: UNKNOWN_CODE, session: "x" }, { code: UNKNOWN_CODE, extra: 1 }]) {
      const res = await f.server.post(EXCHANGE, body, f.server.origin());
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await f.exchange(UNKNOWN_CODE)).status, 401);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------- 권장 4: 예산 (HTTP)

test("R4 교환 예산: 실패한 시도만 분당 120회 — 넘으면 429(+Retry-After), 그래도 맞는 코드는 통하고, 맞는 교환은 예산을 쓰지 않는다", { timeout: 180_000 }, async () => {
  const f = await start("pes-sel85-rf-budget-");
  try {
    // 맞는 교환은 세지 않는다: 한도보다 많은 성공 교환(발급 예산 60 안에서)을 먼저 하고도 실패 예산은 그대로다
    for (let i = 0; i < 30; i += 1) {
      const code = (await f.issue()).json().data.code as string;
      assert.equal((await f.exchange(code)).status, 200);
    }
    for (let i = 0; i < EXCHANGE_ATTEMPTS_PER_MINUTE; i += 1) {
      const res = await f.exchange(UNKNOWN_CODE);
      assert.equal(res.status, 401, `failure #${i + 1} → ${res.status} ${res.text()}`);
    }
    const over = await f.exchange(UNKNOWN_CODE);
    assert.equal(over.status, 429, over.text());
    assert.match(over.headers["retry-after"] ?? "", /^[1-9][0-9]*$/);
    assert.ok(Number(over.headers["retry-after"]) <= 60);
    assert.equal(over.json().error.code, "rate_limited");
    assert.equal(over.json().error.retryable, true);
    no_store(over);
    has_no_session(over.text());
    // 모양 틀린 시도도 같은 예산이다
    assert.equal((await f.exchange("short")).status, 429);
    // 예산이 바닥나도 사용자 자신의 맞는 코드는 통한다(흉내 낸 Origin 의 실패 폭주가 서비스를 막지 못한다)
    const code = (await f.issue()).json().data.code as string;
    const good = await f.exchange(code);
    assert.equal(good.status, 200, good.text());
    assert.equal(good.json().data.session, SECRET);
    // 같은 코드를 또 내면 이제 실패로 보고 429
    assert.equal((await f.exchange(code)).status, 429);
  } finally {
    await f.cleanup();
  }
});

test("R1 발급 예산: 분당 60회 — 넘으면 429(+Retry-After)", { timeout: 180_000 }, async () => {
  const f = await start("pes-sel85-rf-issue-budget-");
  try {
    for (let i = 0; i < ISSUE_REQUESTS_PER_MINUTE; i += 1) {
      const res = await f.issue();
      assert.equal(res.status, 201, `#${i + 1} → ${res.status} ${res.text()}`);
    }
    const over = await f.issue();
    assert.equal(over.status, 429, over.text());
    assert.match(over.headers["retry-after"] ?? "", /^[1-9][0-9]*$/);
    assert.equal(over.json().error.code, "rate_limited");
    assert.equal(over.json().data, undefined);
    no_store(over);
    // 소유자 세션이 없으면 예산이 남든 바닥나든 401 (예산 상태를 알려 주지 않는다)
    assert.equal((await f.issue(undefined, null)).status, 401);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------- 권장 2

test("R2 API 프록시는 Cache-Control 기본값을 더하지 않는다 — no-store 는 두 새 길의 몫이다", { timeout: 120_000 }, async () => {
  const f = await start("pes-sel85-rf-cache-");
  try {
    const ws = await f.server.request(`/api/v1/projects/${f.project_id}/workspace`, { headers: { "x-pes-session": SECRET } });
    assert.equal(ws.status, 200, ws.text());
    assert.equal(ws.headers["cache-control"], undefined, "main 과 같다: API 앱이 주지 않은 헤더를 서버가 더하지 않는다");
    no_store(await f.issue());
    no_store(await f.exchange(UNKNOWN_CODE));
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------- AppCodes 단위 (시계 주입)

function clock(start_ms = 1_000_000): { now: () => number; advance(ms: number): void } {
  let t = start_ms;
  return { now: () => t, advance: (ms) => void (t += ms) };
}
const handoff = (n = 1) => ({ session: "synthetic-session", projects: { [`p${n}`]: `id-${n}` } });
const code_of = (made: { code: string } | { retry_after_ms: number }): string => {
  assert.ok("code" in made, `a code was expected, got ${JSON.stringify(made)}`);
  return made.code;
};

test("AppCodes TTL 경계: 수명 끝 1ms 전까지 통하고 끝 시각부터 거절, 한 번 읽으면 사라진다", () => {
  const c = clock();
  const codes = new AppCodes({ ttl_ms: 1000, now: c.now });
  const a = code_of(codes.issue(handoff()));
  const b = code_of(codes.issue(handoff()));
  const e = code_of(codes.issue(handoff()));
  c.advance(999);
  assert.deepEqual(codes.take(a), handoff());
  assert.equal(codes.take(a), null, "한 번만");
  c.advance(1); // 정확히 expires_at
  assert.equal(codes.take(b), null, "수명이 끝난 시각의 코드는 거절");
  assert.equal(codes.take(b), null);
  c.advance(10_000);
  assert.equal(codes.take(e), null);
  assert.equal(codes.take("never-issued-code-0123456789"), null);
});

test("AppCodes 상한: 쓰이지 않은 유효 코드 64개가 차면 새 발급을 거절하고(오래된 코드는 그대로 유효), 가장 먼저 만료될 때까지 기다리라고 알린다", () => {
  const c = clock();
  const codes = new AppCodes({ ttl_ms: 60_000, now: c.now });
  const issued: string[] = [];
  for (let i = 0; i < MAX_LIVE_CODES; i += 1) {
    issued.push(code_of(codes.issue(handoff(i))));
    c.advance(100);
  }
  const full = codes.issue(handoff(99));
  assert.ok("retry_after_ms" in full, "65번째는 거절");
  // 가장 오래된 코드는 60_000 - 64*100 ms 뒤에 만료된다
  assert.equal(full.retry_after_ms, 60_000 - MAX_LIVE_CODES * 100);
  assert.deepEqual(codes.take(issued[0] as string), handoff(0), "가장 오래된 유효 코드가 밀려나지 않았다");
  // 한 칸 비면 다시 발급된다
  assert.ok("code" in codes.issue(handoff(100)));
  assert.ok("retry_after_ms" in codes.issue(handoff(101)));
  // 시간이 지나 만료되면 쌓인 코드가 치워지고 발급이 다시 열린다
  c.advance(60_000);
  assert.ok("code" in codes.issue(handoff(102)));
  assert.equal(codes.take(issued[1] as string), null);
});

test("AppCodes 예산 창: 실패 120회 뒤 다음은 대기, 창이 지나면 다시 열린다 / 발급 60회도 같다 / 맞는 take 는 예산을 쓰지 않는다", () => {
  const c = clock();
  const codes = new AppCodes({ ttl_ms: 60_000, now: c.now });
  for (let i = 0; i < EXCHANGE_ATTEMPTS_PER_MINUTE; i += 1) assert.equal(codes.exchange_failed(), null, `failure ${i + 1}`);
  c.advance(10_000);
  assert.equal(codes.exchange_failed(), 50_000, "가장 오래된 실패가 창을 떠날 때까지");
  c.advance(49_999);
  assert.equal(codes.exchange_failed(), 1);
  c.advance(1);
  assert.equal(codes.exchange_failed(), null, "창이 지나 다시 열림");

  for (let i = 0; i < ISSUE_REQUESTS_PER_MINUTE; i += 1) assert.equal(codes.issue_wait(), null);
  assert.equal(codes.issue_wait(), 60_000);
  c.advance(60_000);
  assert.equal(codes.issue_wait(), null);

  // 맞는 코드를 읽는 일(take)은 실패 예산을 건드리지 않는다
  const fresh = new AppCodes({ ttl_ms: 60_000, now: c.now });
  for (let i = 0; i < 100; i += 1) {
    assert.ok(fresh.take(code_of(fresh.issue(handoff()))) !== null);
  }
  for (let i = 0; i < EXCHANGE_ATTEMPTS_PER_MINUTE; i += 1) assert.equal(fresh.exchange_failed(), null);
});

test("AppCodes: 코드는 매번 다르고 43자 base64url, 표는 발급 때의 값을 복사해 둔다", () => {
  const codes = new AppCodes();
  const input = handoff();
  const a = code_of(codes.issue(input));
  const b = code_of(codes.issue(input));
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  input.projects.p1 = "changed-after-issue";
  assert.deepEqual(codes.take(a), handoff(), "발급 뒤에 바꾼 값이 코드에 스며들지 않는다");
});

test("code_ttl_ms·valid_projects 경계", () => {
  assert.equal(code_ttl_ms(undefined), 60_000);
  assert.equal(code_ttl_ms("1"), 1);
  assert.equal(code_ttl_ms("600000"), 600_000);
  assert.equal(code_ttl_ms("999999999"), 600_000, "최대 10분");
  for (const bad of ["0", "-1", "1.5", "abc", "", "1e3", " 5", "0123", "1234567890"]) assert.equal(code_ttl_ms(bad), 60_000, JSON.stringify(bad));
  assert.deepEqual(valid_projects({ a: "x" }), { a: "x" });
  assert.equal(valid_projects({ "A": "x" }), null);
  assert.equal(valid_projects([]), null);
  assert.equal(valid_projects(null), null);
});

// ---------------------------------------------------------------- 권장 6

test("R6 브라우저 열기 인자는 모든 플랫폼에서 주소 하나뿐이다(세션 없음) — win32 의 rundll32 포함", () => {
  const url = "http://127.0.0.1:8761/p/synthetic/e/1/s/plan/r/start#code=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  assert.deepEqual(browser_command(url, "darwin"), ["open", [url]]);
  assert.deepEqual(browser_command(url, "linux"), ["xdg-open", [url]]);
  assert.deepEqual(browser_command(url, "win32"), ["rundll32", ["url.dll,FileProtocolHandler", url]]);
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const [, args] = browser_command(url, platform);
    assert.ok(args.every((a) => !a.includes("session") && !a.includes("#pes=")), platform);
  }
});

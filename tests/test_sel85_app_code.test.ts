/**
 * SEL-85 [3단계] U1b 후속 A — 앱 세션 전달을 1회용 코드 교환으로 (tester, 작성 모드). 구현 전이라 실패가 정상.
 *
 * 스스로 정한 해석 (이슈·F1/R1-2 로그의 '1회용·짧은(60초) 코드, 앱이 POST 로 세션과 교환, 쓰이면 무효'만 근거 — 구현을 추측하지 않음):
 *   - 주소 조각: `pes open <slug> --app` 이 주는 주소의 조각은 `#code=<코드>` 이다. 코드 = base64url 문자([A-Za-z0-9_-]) 20자 이상, 호출마다 다르다.
 *     조각에 세션 원문도, 세션을 base64/base64url 로 인코딩한 것도, 옛 `#pes=` 도 없다. 주소의 나머지(경로·쿼리)는 SEL-82 와 같다.
 *   - 교환 경로: `POST /api/v1/app-session`  본문 JSON `{"code":"<코드>"}`  →  200 `{ "data": { "session": "<소유자 세션>", "projects": { "<slug>": "<프로젝트 id>" } } }`.
 *     (SEL-82 조각의 {session, projects} 와 같은 알맹이.) 세션 헤더 없이 부른다 — 코드 자체가 증표다.
 *   - 실패는 200 이 아니고 응답 어디에도 세션이 없다: 한 번 쓴 코드·만료 코드·모르는 코드·본문 없음/모양 틀림 = 401 또는 410(또는 400 — 모양 틀림만),
 *     다른 출처(Origin: 낯선 주소) = 403. 모든 응답(성공·실패)에 `Cache-Control: no-store`.
 *   - 코드 수명: 기본 60초. 시험은 서버 환경변수 `PES_APP_CODE_TTL_MS`(밀리초)로 줄여 만료를 본다 — 기본값 60초 자체는 시험하지 않는다.
 *   - 코드는 세션 대신 쓸 수 없다: `x-pes-session: <코드>` 로 API 를 부르면 401.
 *   - 코드를 만드는 길(CLI → 서버 전달 방식)은 구현 몫 — 시험은 `pes open --app` 의 출력과 HTTP 만 본다.
 * 실제 홈·실제 PES 포트 0: 임시 홈 + 주입된 빈 포트(TsServeProcess)·PES_HUB_PORTS.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import { run_ts_cli } from "./helpers/compat_ts.ts";
import { TsServeProcess, srv_seed_project } from "./helpers/compat_ts_srv.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { connect_read_only } from "../scripts/pes_core/db.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { serve_fixture, type ServeFixture } from "./helpers/serve_ts_env.ts";

use_home_guard();

const SECRET = "synthetic-sel85-owner-session-0123456789abcdef";
const EXCHANGE = "/api/v1/app-session";
const CODE = /^[A-Za-z0-9_-]{20,}$/;

interface Fx {
  fx: ServeFixture;
  server: TsServeProcess;
  project_id: string;
  run(args: string[], extra_env?: Record<string, string>): ReturnType<typeof run_ts_cli>;
  /** `pes open synthetic --app` (PES_NO_BROWSER=1) → [주소 전체, 코드] */
  open(): { address: string; code: string };
  exchange(code: unknown, origin?: string | null): Promise<Awaited<ReturnType<TsServeProcess["post"]>>>;
  cleanup(): Promise<void>;
}

async function start(prefix: string, server_env: Record<string, string> = {}): Promise<Fx> {
  const fx = await serve_fixture(prefix, { no_start: true, no_db: true });
  mkdirSync(fx.project, { recursive: true });
  writeFileSync(join(fx.project, "project.json"), JSON.stringify({ pes: 1, topic: "합성 주제", stages: { plan: { items: [{ id: 1, title: "합성 항목" }] } } }), "utf8");
  await srv_seed_project(fx.ctx, fx.project);
  const server = new TsServeProcess(fx.ctx, fx.root, { extra_env: { PES_LOCAL_SESSION_SECRET: SECRET, ...server_env } });
  await server.start();
  const db = connect_read_only(db_path(fx.ctx.env));
  let project_id: string;
  try {
    project_id = db.get<{ id: string }>("SELECT id FROM projects WHERE slug = 'synthetic'")!.id;
  } finally {
    db.close();
  }
  const run: Fx["run"] = (args, extra_env = {}) =>
    run_ts_cli(fx.ctx, args, { env: { PES_HUB_PORTS: `${server.port}-${server.port}`, PES_NO_BROWSER: "1", PES_LOCAL_SESSION_SECRET: SECRET, ...server_env, ...extra_env } });
  return {
    fx,
    server,
    project_id,
    run,
    open() {
      const out = run(["open", "synthetic", "--app"]);
      assert.equal(out.status, 0, out.stderr);
      const address = out.stdout.trim();
      const m = /#code=([^#\s]*)$/.exec(address);
      assert.ok(m, `the address ends with #code=<code>, got ${address.slice(0, 120)}`);
      return { address, code: m[1] as string };
    },
    exchange: (code, origin = server.origin()) => server.post(EXCHANGE, { code }, origin),
    cleanup: async () => {
      await server.stop();
      await fx.cleanup();
    },
  };
}

const sessionVariants = [SECRET, Buffer.from(SECRET).toString("base64"), Buffer.from(SECRET).toString("base64url"), Buffer.from(SECRET).toString("hex")];
const leaks = (text: string): string[] => sessionVariants.filter((v) => text.includes(v));

test("1 pes open <slug> --app: 주소 조각은 #code=<1회용 코드> 뿐 — 세션 원문·인코딩·옛 #pes= 가 stdout·stderr 어디에도 없다", { timeout: 120_000 }, async () => {
  const f = await start("pes-sel85-frag-");
  try {
    const out = f.run(["open", "synthetic", "--app"]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stderr, "");
    const lines = out.stdout.split("\n").filter((x) => x !== "");
    assert.equal(lines.length, 1, `one address line, got ${JSON.stringify(out.stdout)}`);
    const url = new URL(lines[0] as string);
    assert.equal(url.origin, `http://127.0.0.1:${f.server.port}`);
    assert.match(url.pathname, /^\/p\/synthetic\/e\/[1-9][0-9]*\/s\/[a-z][a-z_-]*\/r\/(start|[1-9][0-9]*)$/, "SEL-82 와 같은 작업 공간 주소");
    assert.equal(url.search, "");
    const m = /^#code=(.+)$/.exec(url.hash);
    assert.ok(m, `fragment is #code=<code>, got ${url.hash.slice(0, 40)}`);
    assert.match(m[1] as string, CODE, "code: base64url 20+ chars");
    assert.ok(!out.stdout.includes("#pes="), "옛 세션 조각 없음");
    assert.deepEqual(leaks(out.stdout + out.stderr), [], "세션이 출력에 없다");
    // 조각을 풀어도 세션이 안 나온다 (코드는 JSON 이 아니다)
    const decoded = Buffer.from(m[1] as string, "base64url").toString("utf8");
    assert.deepEqual(leaks(decoded), []);
    assert.ok(!decoded.includes('"session"'));
  } finally {
    await f.cleanup();
  }
});

test("1 코드는 호출마다 다르다(추측·재사용 불가)", { timeout: 120_000 }, async () => {
  const f = await start("pes-sel85-uniq-");
  try {
    const a = f.open().code;
    const b = f.open().code;
    assert.notEqual(a, b);
  } finally {
    await f.cleanup();
  }
});

test("1 브라우저로 열 때(PES_NO_BROWSER 없음) 브라우저 명령 인자·CLI 출력에도 세션이 없고 조각은 #code= 이다", { timeout: 120_000, skip: process.platform === "win32" ? "rundll32 can't be faked on Windows" : false }, async () => {
  const f = await start("pes-sel85-browser-");
  const bin = mkdtempSync(join(tmpdir(), "pes-sel85-bin-"));
  const log = join(bin, "args.log");
  try {
    for (const name of ["open", "xdg-open"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${log}"\n`, "utf8");
      chmodSync(join(bin, name), 0o755);
    }
    const out = run_ts_cli(f.fx.ctx, ["open", "synthetic", "--app"], {
      allow_child_process: true,
      extra_read: [bin],
      env: { PES_HUB_PORTS: `${f.server.port}-${f.server.port}`, PES_NO_BROWSER: "", PES_LOCAL_SESSION_SECRET: SECRET, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
    } as any);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(leaks(out.stdout + out.stderr), []);
    for (let i = 0; i < 60 && !existsSync(log); i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(log), "the (fake) browser command was started");
    const args = readFileSync(log, "utf8");
    assert.deepEqual(leaks(args), [], "브라우저 인자에 세션이 없다");
    assert.ok(!args.includes("#pes="));
    assert.match(args, /#code=[A-Za-z0-9_-]{20,}/, "브라우저는 코드 조각 주소를 받는다");
  } finally {
    rmSync(bin, { recursive: true, force: true });
    await f.cleanup();
  }
});

test("2 교환: POST /api/v1/app-session {code} → 소유자 세션과 projects, Cache-Control: no-store", { timeout: 120_000 }, async () => {
  const f = await start("pes-sel85-ok-");
  try {
    const { code } = f.open();
    const res = await f.exchange(code);
    assert.equal(res.status, 200, res.text());
    assert.match(res.headers["cache-control"] ?? "", /no-store/);
    const data = res.json().data;
    assert.equal(data.session, SECRET);
    assert.equal(data.projects.synthetic, f.project_id);
    for (const [slug, id] of Object.entries(data.projects)) assert.ok(typeof slug === "string" && typeof id === "string" && id !== "");
    // 받은 세션은 실제로 통한다
    const ws = await f.server.request(`/api/v1/projects/${f.project_id}/workspace`, { headers: { "x-pes-session": data.session } });
    assert.equal(ws.status, 200, ws.text());
  } finally {
    await f.cleanup();
  }
});

test("2 코드는 한 번만: 두 번째 교환은 401/410, 응답에 세션 없음, no-store", { timeout: 120_000 }, async () => {
  const f = await start("pes-sel85-once-");
  try {
    const { code } = f.open();
    assert.equal((await f.exchange(code)).status, 200);
    const again = await f.exchange(code);
    assert.ok([401, 410].includes(again.status), `reuse refused, got ${again.status}`);
    assert.deepEqual(leaks(again.text()), []);
    assert.match(again.headers["cache-control"] ?? "", /no-store/);
    assert.ok(again.json().data === undefined);
  } finally {
    await f.cleanup();
  }
});

test("2 동시에 두 번 보내도 세션을 받는 쪽은 하나뿐이다", { timeout: 120_000 }, async () => {
  const f = await start("pes-sel85-race-");
  try {
    const { code } = f.open();
    const results = await Promise.all([f.exchange(code), f.exchange(code), f.exchange(code)]);
    assert.equal(results.filter((r) => r.status === 200).length, 1, results.map((r) => r.status).join(","));
    for (const r of results.filter((x) => x.status !== 200)) assert.ok([401, 410].includes(r.status));
  } finally {
    await f.cleanup();
  }
});

test("2 만료: 수명(PES_APP_CODE_TTL_MS)이 지난 코드는 401/410", { timeout: 120_000 }, async () => {
  const f = await start("pes-sel85-ttl-", { PES_APP_CODE_TTL_MS: "1500" });
  try {
    const fresh = f.open().code;
    const stale = f.open().code;
    assert.equal((await f.exchange(fresh)).status, 200, "수명 안의 코드는 통한다");
    await new Promise((r) => setTimeout(r, 2200));
    const res = await f.exchange(stale);
    assert.ok([401, 410].includes(res.status), `expired code refused, got ${res.status}`);
    assert.deepEqual(leaks(res.text()), []);
    assert.match(res.headers["cache-control"] ?? "", /no-store/);
  } finally {
    await f.cleanup();
  }
});

test("2 모르는 코드·빈 코드·모양 틀린 요청은 세션을 주지 않는다", { timeout: 120_000 }, async () => {
  const f = await start("pes-sel85-bad-");
  try {
    f.open();
    const bodies: unknown[] = ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "", "x", " ", "../etc/passwd", "a".repeat(5000), null, 12345, ["a"], { $ne: "" }];
    for (const code of bodies) {
      const res = await f.exchange(code);
      assert.ok([400, 401, 410, 413].includes(res.status), `${JSON.stringify(code)?.slice(0, 30)} → ${res.status}`);
      assert.deepEqual(leaks(res.text()), []);
      assert.match(res.headers["cache-control"] ?? "", /no-store/);
    }
    for (const raw of [Buffer.from("not json"), Buffer.from("[]"), Buffer.from("{}"), Buffer.alloc(0)]) {
      const res = await f.server.post(EXCHANGE, raw, f.server.origin());
      assert.ok([400, 401, 410].includes(res.status), `raw ${raw.length} bytes → ${res.status}`);
      assert.deepEqual(leaks(res.text()), []);
    }
    // 쿼리로 코드를 보내는 길은 없다
    const code = f.open().code;
    const viaQuery = await f.server.request(`${EXCHANGE}?code=${code}`, { method: "POST", headers: { origin: f.server.origin(), "content-type": "application/json" }, body: "{}" });
    assert.notEqual(viaQuery.status, 200);
    const viaGet = await f.server.request(`${EXCHANGE}?code=${code}`);
    assert.notEqual(viaGet.status, 200, "GET 으로는 교환할 수 없다");
    assert.deepEqual(leaks(viaGet.text()), []);
  } finally {
    await f.cleanup();
  }
});

test("2 다른 출처(Origin)에서 온 교환은 403 이고 세션이 없다 — 그 코드가 유출 상태가 아니어도 같다", { timeout: 120_000 }, async () => {
  const f = await start("pes-sel85-origin-");
  try {
    const { code } = f.open();
    for (const origin of ["http://evil.example", "https://127.0.0.1", `http://localhost:${f.server.port}`, "null", `http://127.0.0.1:${f.server.port + 1}`]) {
      const res = await f.exchange(code, origin);
      assert.equal(res.status, 403, `Origin ${origin}`);
      assert.deepEqual(leaks(res.text()), []);
      assert.match(res.headers["cache-control"] ?? "", /no-store/);
      assert.equal(res.headers["access-control-allow-origin"], undefined, "CORS 허용 없음");
    }
    const preflight = await f.server.request(EXCHANGE, { method: "OPTIONS", headers: { origin: "http://evil.example", "access-control-request-method": "POST" } });
    assert.equal(preflight.headers["access-control-allow-origin"], undefined);
  } finally {
    await f.cleanup();
  }
});

test("2 코드는 세션 대신 쓸 수 없다: x-pes-session 에 코드를 넣은 API 호출은 401", { timeout: 120_000 }, async () => {
  const f = await start("pes-sel85-notsession-");
  try {
    const { code } = f.open();
    const res = await f.server.request(`/api/v1/projects/${f.project_id}/workspace`, { headers: { "x-pes-session": code } });
    assert.equal(res.status, 401, res.text());
  } finally {
    await f.cleanup();
  }
});

test("2 서버가 꺼져 있으면(아직 그대로) 코드도 만들지 않는다: 0이 아닌 종료 코드, 조각 출력 0", { timeout: 120_000 }, async () => {
  const f = await start("pes-sel85-off-");
  try {
    await f.server.stop();
    const out = f.run(["open", "synthetic", "--app"]);
    assert.notEqual(out.status, 0);
    const all = `${out.stdout}\n${out.stderr}`;
    assert.ok(!all.includes("#code=") && !all.includes("#pes=") && leaks(all).length === 0);
    assert.match(all, /serve/);
  } finally {
    await f.cleanup();
  }
});

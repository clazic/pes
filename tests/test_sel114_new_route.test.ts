/**
 * SEL-114 최종 리뷰 1 필수 1 — 새 프로젝트 화면 주소 `/new` 를 서버(scripts/serve.ts)가 `/p/<slug>/…` 와 같은 규칙으로 앱 index.html 로 내준다
 * (같은 Content-Security-Policy · 세션 값 없음 · 쿠키 없음). 주소 예약 규칙: `/new`(끝 / 있든 없든)만 앱이고 `/new/…` 아래와 `/newer` 같은 이웃은 앱이 아니다.
 * 이미 `new` 라는 프로젝트가 있으면 그 프로젝트의 주소가 우선한다(`p` · `app` 프로젝트와 같은 원칙 — 기존 사용자의 주소를 앱이 가리지 않는다).
 * 실제 홈·실제 PES 포트 0: 임시 홈 + 주입된 빈 포트.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { TsServeProcess, srv_seed_project } from "./helpers/compat_ts_srv.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { serve_fixture, type ServeFixture } from "./helpers/serve_ts_env.ts";

use_home_guard();

const SECRET = "synthetic-sel114-session-secret-0123456789";
const APP_INDEX = '<!doctype html><html><head><title>PES 앱 합성</title></head><body><div id="root"></div><script type="module" src="/_app/assets/app.js"></script></body></html>';

interface Fx {
  fx: ServeFixture;
  server: TsServeProcess;
  cleanup(): Promise<void>;
}

async function start(prefix: string, extra_projects: string[] = []): Promise<Fx> {
  const fx = await serve_fixture(prefix, { no_start: true, no_db: true });
  writeFileSync(join(fx.project, "project.json"), JSON.stringify({ pes: 1, topic: "합성 주제", stages: { plan: { items: [{ id: 1, title: "합성 항목" }] } } }), "utf8");
  await srv_seed_project(fx.ctx, fx.project);
  for (const slug of extra_projects) {
    mkdirSync(join(fx.root, slug), { recursive: true });
    writeFileSync(join(fx.root, slug, "project.json"), JSON.stringify({ pes: 1, topic: `합성 ${slug}`, stages: { plan: { items: [{ id: 1, title: "합성 항목" }] } } }), "utf8");
    writeFileSync(join(fx.root, slug, "ask-plan.html"), "<html>ask</html>", "utf8");
    await srv_seed_project(fx.ctx, join(fx.root, slug));
  }
  const dist = join(fx.ctx.home.root, "app-dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), APP_INDEX, "utf8");
  writeFileSync(join(dist, "assets", "app.js"), "console.log('synthetic app bundle');\n", "utf8");
  const server = new TsServeProcess(fx.ctx, fx.root, { extra_env: { PES_LOCAL_SESSION_SECRET: SECRET, PES_APP_DIR: dist } });
  await server.start();
  return {
    fx,
    server,
    cleanup: async () => {
      await server.stop();
      await fx.cleanup();
    },
  };
}

test("/new 와 /new/ 는 /p/<slug>/… 와 같은 앱 index.html — 같은 CSP · 세션 값 없음 · 쿠키 없음", { timeout: 90_000 }, async () => {
  const f = await start("pes-sel114-new-");
  try {
    const reference = await f.server.request("/p/synthetic/e/1/s/research/r/2");
    assert.equal(reference.status, 200);
    const csp = reference.headers["content-security-policy"];
    assert.ok(csp, "the /p/ app index has a Content-Security-Policy");
    for (const path of ["/new", "/new/", "/new?from=reload", "/new/?x=1"]) {
      const res = await f.server.request(path);
      assert.equal(res.status, 200, `${path}: ${res.text().slice(0, 120)}`);
      assert.match(res.headers["content-type"] ?? "", /^text\/html/, path);
      assert.equal(res.text(), APP_INDEX, `${path}: the app index`);
      assert.equal(res.headers["content-security-policy"], csp, `${path}: the same CSP as /p/…`);
      assert.equal(res.headers["set-cookie"], undefined, `${path}: cookie-free`);
      assert.equal(res.headers["cache-control"], reference.headers["cache-control"], `${path}: same cache rule`);
      assert.doesNotMatch(res.text(), new RegExp(SECRET), `${path}: no session value`);
      assert.doesNotMatch(JSON.stringify(res.headers), new RegExp(SECRET), `${path}: no session value in headers`);
    }
    const head = await f.server.request("/new", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.match(head.headers["content-type"] ?? "", /^text\/html/);
  } finally {
    await f.cleanup();
  }
});

test("주소 예약은 /new 한 곳뿐 — /new/… 아래 · /newer · /p/new 같은 이웃은 앱이 아니다", { timeout: 90_000 }, async () => {
  const f = await start("pes-sel114-new-neighbors-");
  try {
    for (const path of ["/new/anything", "/new/e/1", "/newer", "/new.html", "/NEW"]) {
      const res = await f.server.request(path);
      assert.notEqual(res.text(), APP_INDEX, `${path}: not the app index`);
      assert.equal(res.status, 404, path);
    }
  } finally {
    await f.cleanup();
  }
});

test("이미 `new` 라는 프로젝트가 있으면 그 프로젝트가 /new 를 가진다 — 앱 index 가 가리지 않는다", { timeout: 120_000 }, async () => {
  const f = await start("pes-sel114-new-project-", ["new"]);
  try {
    const ping = await f.server.request("/new/ping");
    assert.equal(ping.status, 200);
    assert.deepEqual(ping.json(), { ok: true });
    const dash = await f.server.request("/new/index.html");
    assert.equal(dash.status, 200);
    assert.notEqual(dash.text(), APP_INDEX);
    const bare = await f.server.request("/new");
    assert.notEqual(bare.text(), APP_INDEX, "/new is the project's address, not the app");
    const root_page = await f.server.request("/new/");
    assert.equal(root_page.status, 302);
    assert.equal(root_page.headers.location, "/new/ask-plan.html");
    // the app index is still there for every other address
    assert.equal((await f.server.request("/p/synthetic/e/1/s/research/r/2")).text(), APP_INDEX);
  } finally {
    await f.cleanup();
  }
});

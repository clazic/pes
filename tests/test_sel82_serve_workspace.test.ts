/**
 * SEL-82 U1b — scripts/serve.ts 가 workspace · changes · versions 읽기 경로를 통과시키고, 앱 빌드 산출물을 /p/<slug>/... 로 내준다
 * (tester, 작성 모드). 구현 전에는 workspace 라우트와 /p/ 라우트가 없어 실패하는 것이 정상.
 *
 * 해석 (이슈 SEL-82 · docs/plan/issues/stage-3.md U1 — 구현을 추측하지 않음):
 *  1 /api/v1/* 는 이미 serve.ts 가 ApiApp 으로 통과시킨다(SEL-74). 새 것은 `GET P/workspace` 한 경로뿐. changes · versions 는 통과가 계속됨을 서버 쪽에서 못 박는다.
 *  2 앱 산출물 위치: 환경변수 `PES_APP_DIR`(없으면 저장소 `app/dist`). 시험은 임시 홈 안에 합성 산출물(index.html · assets/*)을 두고 이 변수로 가리킨다.
 *    - GET /p/<slug>/e/<n>/s/<stage>/r/<round> (그 밖의 /p/<slug>/ 아래 모든 경로) → 200, 앱 index.html(SPA 되돌림), text/html.
 *    - GET /app/<산출물 상대 경로>(assets/...) → 그 파일(올바른 Content-Type). 앱은 base "/app/" 로 빌드된다. 산출물 밖은 안 열림(.. 통과 불가).
 *    - 산출물이 없으면 /p/... 는 404(스택 없음). 쿠키는 만들지 않는다.
 *    - 기존 `/<slug>/` 대시보드·ask·version·ping·feedback 은 그대로(앱 경로가 가리지 않음).
 *  3 '앱과 기존 대시보드 HTML 이 같은 JSON API 를 읽는다' = 같은 읽기 모델: 기존 대시보드가 내장한 자료(topic · current stage)가
 *    `GET P/workspace` 의 title · current.stage 와 같은 값이다(둘이 서로 다른 계산을 하지 않는다).
 *  4 실제 홈·실제 PES 포트(8760~8775) 0: 서버는 항상 임시 홈 + 주입된 빈 포트(TsServeProcess)이고, 허브 접속 시도 0.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { TsServeProcess, srv_seed_project } from "./helpers/compat_ts_srv.ts";
import { connect, connect_read_only } from "../scripts/pes_core/db.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { serve_fixture, type ServeFixture } from "./helpers/serve_ts_env.ts";

use_home_guard();

const SECRET = "synthetic-sel82-session-secret-0123456789";
const APP_INDEX = '<!doctype html><html><head><title>PES 앱 합성</title></head><body><div id="root"></div><script type="module" src="/app/assets/app.js"></script></body></html>';
const APP_JS = "console.log('synthetic app bundle');\n";

interface Fx {
  fx: ServeFixture;
  server: TsServeProcess;
  project_id: string;
  dist: string;
  cleanup(): Promise<void>;
}

async function start(prefix: string, with_dist = true): Promise<Fx> {
  // a 0.15 project folder with one plan item: migrated into the DB (the way the user's migration does) so the change feed names an object version
  const fx = await serve_fixture(prefix, { no_start: true, no_db: true });
  writeFileSync(join(fx.project, "project.json"), JSON.stringify({ pes: 1, topic: "합성 주제", stages: { plan: { items: [{ id: 1, title: "합성 항목" }] } } }), "utf8");
  await srv_seed_project(fx.ctx, fx.project);
  const dist = join(fx.ctx.home.root, "app-dist");
  if (with_dist) {
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), APP_INDEX, "utf8");
    writeFileSync(join(dist, "assets", "app.js"), APP_JS, "utf8");
    writeFileSync(join(dist, "assets", "app.css"), "body{color:#222}\n", "utf8");
  }
  // a file the app folder must never give out
  writeFileSync(join(fx.ctx.home.root, "outside-secret.txt"), "OUTSIDE-SECRET", "utf8");
  const server = new TsServeProcess(fx.ctx, fx.root, { extra_env: { PES_LOCAL_SESSION_SECRET: SECRET, PES_APP_DIR: dist } });
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
    dist,
    cleanup: async () => {
      await server.stop();
      await fx.cleanup();
    },
  };
}

const owner = { "x-pes-session": SECRET };
const P = (f: Fx, rest: string) => `/api/v1/projects/${f.project_id}${rest}`;

test("GET P/workspace through serve.ts: owner session → the app's WorkspaceView; no session → 401; a migrated synthetic project reads '기록 없음'", { timeout: 90_000 }, async () => {
  const f = await start("pes-sel82-ws-");
  try {
    const res = await f.server.request(P(f, "/workspace"), { headers: owner });
    assert.equal(res.status, 200, res.text());
    assert.match(res.headers["content-type"] ?? "", /^application\/json/);
    const data = res.json().data;
    assert.equal(data.slug, "synthetic");
    assert.equal(typeof data.title, "string");
    assert.ok(Number.isSafeInteger(data.edition));
    assert.ok(["A", "B"].includes(data.mode));
    assert.ok(Array.isArray(data.stages));
    assert.ok(["you", "ai", "waiting", "done"].includes(data.turn.side));
    assert.ok(Array.isArray(data.actions) && data.actions.every((a: any) => typeof a.enabled === "boolean" && (a.enabled ? a.disabled_reason === null : String(a.disabled_reason).trim() !== "")));
    // a migrated project that has no assumptions / decisions / comments is honest about it
    assert.equal(data.records.empty, true);
    assert.equal(data.records.assumptions.count + data.records.decisions.count + data.records.comments.count, 0);
    // regression: no credential → 401, a wrong credential → 401
    assert.equal((await f.server.request(P(f, "/workspace"))).status, 401);
    assert.equal((await f.server.request(P(f, "/workspace"), { headers: { "x-pes-session": "wrong" } })).status, 401);
    // real ports / real home: none
    assert.ok(f.server.port > 0 && !(f.server.port >= 8760 && f.server.port <= 8775), "an injected free port, never a real PES port");
    assert.deepEqual(f.server.hub_attempts(), []);
  } finally {
    await f.cleanup();
  }
});

test("workspace read through serve.ts writes nothing: the database content is the same before and after", { timeout: 90_000 }, async () => {
  const f = await start("pes-sel82-ro-");
  try {
    const rows = (): string => {
      const db = connect_read_only(db_path(f.fx.ctx.env));
      try {
        const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((t) => t.name);
        return JSON.stringify(tables.map((t) => [t, db.all(`SELECT * FROM "${t}" ORDER BY rowid`).map((r) => JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)))]));
      } finally {
        db.close();
      }
    };
    const before = rows();
    for (let i = 0; i < 3; i += 1) assert.equal((await f.server.request(P(f, "/workspace"), { headers: owner })).status, 200);
    assert.equal(rows(), before);
  } finally {
    await f.cleanup();
  }
});

test("regression: a write with another Origin is 403 and a missing credential is 401; the workspace read needs no Origin", { timeout: 90_000 }, async () => {
  const f = await start("pes-sel82-origin-");
  try {
    const evil = await f.server.post(P(f, "/submissions"), { set_id: "x", answers: [] }, "http://evil.example", { ...owner, "idempotency-key": "sel82-k1" });
    assert.equal(evil.status, 403);
    assert.equal(evil.json().error.code, "forbidden");
    const anon = await f.server.post(P(f, "/submissions"), { set_id: "x", answers: [] }, f.server.origin(), { "idempotency-key": "sel82-k2" });
    assert.equal(anon.status, 401);
    assert.equal((await f.server.request(P(f, "/workspace"), { headers: owner })).status, 200);
  } finally {
    await f.cleanup();
  }
});

test("changes through serve.ts: a first page, then cursor_invalid (400) for a bad cursor and cursor_expired (410) after the epoch moved", { timeout: 90_000 }, async () => {
  const f = await start("pes-sel82-changes-");
  try {
    const first = await f.server.request(P(f, "/changes?limit=2"), { headers: owner });
    assert.equal(first.status, 200, first.text());
    const page = first.json().data;
    assert.ok(Array.isArray(page.events) && page.events.length >= 1);
    assert.equal(typeof page.next_cursor, "string");
    const bad = await f.server.request(P(f, "/changes?cursor=not-a-real-cursor"), { headers: owner });
    assert.equal(bad.status, 400);
    assert.equal(bad.json().error.code, "cursor_invalid");
    assert.equal(bad.json().error.target, "$.query.cursor");
    // the epoch moves (restore / reset): the old cursor expires; the 410 hands out a fresh one and says to keep unsent answers
    const db = connect(db_path(f.fx.ctx.env));
    try {
      db.run("UPDATE db_meta SET cursor_epoch = cursor_epoch + 1 WHERE id = 1");
    } finally {
      db.close();
    }
    const gone = await f.server.request(P(f, `/changes?cursor=${encodeURIComponent(page.next_cursor)}`), { headers: owner });
    assert.equal(gone.status, 410, gone.text());
    assert.equal(gone.json().error.code, "cursor_expired");
    assert.equal(gone.json().error.details.keep_unsubmitted_answers, true);
    const fresh = gone.json().error.details.next_cursor;
    assert.equal((await f.server.request(P(f, `/changes?cursor=${encodeURIComponent(fresh)}`), { headers: owner })).status, 200);
  } finally {
    await f.cleanup();
  }
});

test("objects/{o}/versions/{v} through serve.ts: a migrated object version reads 200, an unknown version is 404, no credential is 401", { timeout: 90_000 }, async () => {
  const f = await start("pes-sel82-versions-");
  try {
    // the importer's events do not name object versions, so the pair comes from the database (object_versions of the migrated plan item)
    const db = connect_read_only(db_path(f.fx.ctx.env));
    let named: { object_id: string; after_version_id: string } | undefined;
    try {
      const row = db.get<{ object_id: string; id: string }>("SELECT object_id, id FROM object_versions WHERE project_id = ? ORDER BY rowid LIMIT 1", f.project_id);
      if (row !== undefined) named = { object_id: row.object_id, after_version_id: row.id };
    } finally {
      db.close();
    }
    assert.ok(named, "the migrated synthetic project has an object version");
    const path = P(f, `/objects/${encodeURIComponent(named.object_id)}/versions/${encodeURIComponent(named.after_version_id)}`);
    const ok = await f.server.request(path, { headers: owner });
    assert.equal(ok.status, 200, ok.text());
    assert.equal((await f.server.request(path)).status, 401);
    const missing = await f.server.request(P(f, `/objects/${encodeURIComponent(named.object_id)}/versions/no-such-version`), { headers: owner });
    assert.equal(missing.status, 404);
    assert.equal(missing.json().error.code, "not_found");
  } finally {
    await f.cleanup();
  }
});

test("the built app is served: /p/<slug>/e/<n>/s/<stage>/r/<round> (and any path below /p/<slug>/) is the app's index.html; /app/assets/* are its files", { timeout: 90_000 }, async () => {
  const f = await start("pes-sel82-app-");
  try {
    for (const path of ["/p/synthetic/e/1/s/research/r/2", "/p/synthetic/e/1/s/plan/r/start?view=ask&focus=q-22&peek=q-21&print=1", "/p/synthetic/", "/p/synthetic/e/1/s/research/r/2/"]) {
      const res = await f.server.request(path);
      assert.equal(res.status, 200, `${path}: ${res.text().slice(0, 120)}`);
      assert.match(res.headers["content-type"] ?? "", /^text\/html/);
      assert.equal(res.text(), APP_INDEX, `${path}: the SPA fallback is the app index`);
      assert.equal(res.headers["set-cookie"], undefined, "the app is cookie-free");
    }
    const js = await f.server.request("/app/assets/app.js");
    assert.equal(js.status, 200);
    assert.match(js.headers["content-type"] ?? "", /javascript/);
    assert.equal(js.text(), APP_JS);
    const css = await f.server.request("/app/assets/app.css");
    assert.equal(css.status, 200);
    assert.match(css.headers["content-type"] ?? "", /^text\/css/);
    assert.equal((await f.server.request("/app/assets/nope.js")).status, 404);
    // the app folder is a jail
    for (const path of ["/app/../outside-secret.txt", "/app/%2e%2e/outside-secret.txt", "/app/..%2foutside-secret.txt", "/p/synthetic/..%2f..%2foutside-secret.txt"]) {
      const res = await f.server.request(path);
      assert.doesNotMatch(res.text(), /OUTSIDE-SECRET/, path);
    }
  } finally {
    await f.cleanup();
  }
});

test("the old per-project pages stay as they are next to the app (dashboard, version, ping, ask)", { timeout: 90_000 }, async () => {
  const f = await start("pes-sel82-legacy-");
  try {
    const dash = await f.server.request("/synthetic/index.html");
    assert.equal(dash.status, 200);
    assert.match(dash.text(), /<script id="data" type="application\/json">/, "the 0.15 dashboard, not the app index");
    assert.notEqual(dash.text(), APP_INDEX);
    assert.equal((await f.server.request("/synthetic/version")).status, 200);
    const ping = await f.server.request("/synthetic/ping");
    assert.equal(ping.status, 200);
    assert.deepEqual(ping.json(), { ok: true });
    assert.equal((await f.server.request("/synthetic/ask-plan.html")).status, 200);
    assert.equal((await f.server.request("/whoami")).status, 200);
  } finally {
    await f.cleanup();
  }
});

test("app and old dashboard read the same model: the topic and current stage the dashboard embeds equal workspace.title and workspace.current.stage", { timeout: 90_000 }, async () => {
  const f = await start("pes-sel82-same-");
  try {
    const ws = (await f.server.request(P(f, "/workspace"), { headers: owner })).json().data;
    const html = (await f.server.request("/synthetic/index.html")).text();
    const m = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m, "the dashboard embeds its data");
    const embedded = JSON.parse((m[1] as string).replace(/\\u003c/gi, "<")) as { topic?: string; current?: string };
    assert.equal(embedded.topic, ws.title);
    if (embedded.current !== undefined) assert.equal(embedded.current, ws.current.stage);
  } finally {
    await f.cleanup();
  }
});

test("without a built app /p/<slug>/... is a plain 404 (no stack trace, no directory listing), and the API and old pages still work", { timeout: 90_000 }, async () => {
  const f = await start("pes-sel82-nodist-", false);
  try {
    const res = await f.server.request("/p/synthetic/e/1/s/research/r/2");
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.text(), /node:internal|\bat .+\(.+:\d+:\d+\)|TypeError|ENOENT/);
    assert.equal((await f.server.request(P(f, "/workspace"), { headers: owner })).status, 200);
    assert.equal((await f.server.request("/synthetic/index.html")).status, 200);
  } finally {
    await f.cleanup();
  }
});

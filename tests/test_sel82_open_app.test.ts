/**
 * SEL-82 U1b R1 필수 1 — `pes open <slug> --app`: 앱을 여는 쪽이 세션을 URL 조각(fragment)으로 넘긴다 (tester, 작성 모드 2). 구현 전에는 --app 이 없어 실패하는 것이 정상.
 *
 * 해석 (leader 결정 "필수 1 = 권장안 A" + R1 로그 — 구현을 추측하지 않음):
 *   - 명령: `pes open <slug> --app`  (기존 `pes open <slug>` = 옛 대시보드 주소 `http://127.0.0.1:<port>/<slug>/` 는 그대로, 조각 없음).
 *     출력 한 줄(PES_NO_BROWSER=1 이면 브라우저 없이 그 주소만, 아니면 브라우저로 같은 주소를 연다):
 *       http://127.0.0.1:<port>/p/<slug>/e/<판>/s/<단계>/r/<라운드|start>#pes=<base64url(JSON {"session": "<소유자 세션>", "projects": {"<slug>": "<프로젝트 id>"}})>
 *     경로는 앱 라우터가 그리는 작업 공간 주소(작업 공간 읽기가 알려 주는 현재 판·단계·라운드)다 — `/p/<slug>/` 만 열면 앱이 '없는 화면'이 되기 때문.
 *   - 세션 값은 소유자 세션(PES_LOCAL_SESSION_SECRET > ~/.pes/config.json > 비밀 파일 — api_secret.ts 와 같은 순서). 주소의 조각(# 뒤) 밖 어디에도 나오지 않는다(경로·쿼리·stderr).
 *   - 서버가 꺼져 있으면 서버를 새로 띄우지 않고(open 은 아무것도 시작하지 않는다) 0이 아닌 종료 코드 + 한국어 한두 줄 안내(`pes serve` 를 먼저). 조각·세션 출력 0.
 *   - 모르는 slug 도 0이 아닌 종료 코드, 세션 출력 0.
 *   - `serve`·`hub` 가 앱 주소를 안내하게 된다면(지금은 대시보드 주소) 같은 규칙(조각만, 세션은 # 뒤에만)을 따른다 — 여기서는 `open` 만 못 박는다.
 * 실제 홈·실제 PES 포트 0: 임시 홈 + 주입된 빈 포트(TsServeProcess)·PES_HUB_PORTS.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { run_ts_cli } from "./helpers/compat_ts.ts";
import { TsServeProcess, free_port, srv_seed_project } from "./helpers/compat_ts_srv.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { connect_read_only } from "../scripts/pes_core/db.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { serve_fixture, type ServeFixture } from "./helpers/serve_ts_env.ts";

use_home_guard();

const SECRET = "synthetic-sel82-open-app-session-0123456789";

interface Fx {
  fx: ServeFixture;
  server: TsServeProcess;
  project_id: string;
  run(args: string[], extra_env?: Record<string, string>): ReturnType<typeof run_ts_cli>;
  cleanup(): Promise<void>;
}

async function start(prefix: string, serve_on = true): Promise<Fx> {
  const fx = await serve_fixture(prefix, { no_start: true, no_db: true });
  mkdirSync(fx.project, { recursive: true });
  writeFileSync(join(fx.project, "project.json"), JSON.stringify({ pes: 1, topic: "합성 주제", stages: { plan: { items: [{ id: 1, title: "합성 항목" }] } } }), "utf8");
  await srv_seed_project(fx.ctx, fx.project);
  const server = new TsServeProcess(fx.ctx, fx.root, { extra_env: { PES_LOCAL_SESSION_SECRET: SECRET } });
  if (serve_on) await server.start();
  const hub_port = serve_on ? server.port : await free_port(); // a free port nobody listens on = "the server is off"
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
    // no allow_child_process: with PES_NO_BROWSER=1 `open` starts nothing (the permission model refuses a spawn)
    run: (args, extra_env = {}) =>
      run_ts_cli(fx.ctx, args, { env: { PES_HUB_PORTS: `${hub_port}-${hub_port}`, PES_NO_BROWSER: "1", PES_LOCAL_SESSION_SECRET: SECRET, ...extra_env } }),
    cleanup: async () => {
      await server.stop();
      await fx.cleanup();
    },
  };
}

function decode(fragment: string): any {
  const m = /^#pes=([A-Za-z0-9_-]+)=*$/.exec(fragment);
  assert.ok(m, `the fragment is #pes=<base64url>, got ${fragment.slice(0, 40)}`);
  return JSON.parse(Buffer.from(m[1] as string, "base64url").toString("utf8"));
}

test("pes open <slug> --app prints one app address with #pes=<base64url JSON {session, projects}> and nothing of the session outside the fragment", { timeout: 120_000 }, async () => {
  const f = await start("pes-sel82-open-");
  try {
    const out = f.run(["open", "synthetic", "--app"]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stderr, "");
    const lines = out.stdout.split("\n").filter((x) => x !== "");
    assert.equal(lines.length, 1, `one address line, got ${JSON.stringify(out.stdout)}`);
    const url = new URL(lines[0] as string);
    assert.equal(url.origin, `http://127.0.0.1:${f.server.port}`);
    assert.match(url.pathname, /^\/p\/synthetic\/e\/[1-9][0-9]*\/s\/[a-z][a-z_-]*\/r\/(start|[1-9][0-9]*)$/, "a work-space address the app's router draws");
    assert.equal(url.search, "");
    const handoff = decode(url.hash);
    assert.deepEqual(Object.keys(handoff).sort(), ["projects", "session"]);
    assert.equal(handoff.session, SECRET);
    assert.equal(handoff.projects.synthetic, f.project_id);
    for (const [slug, id] of Object.entries(handoff.projects)) assert.ok(typeof slug === "string" && typeof id === "string" && id !== "", "slug → id strings");
    // outside the fragment the session is nowhere (not in the path, not in a query, not in stderr)
    const without_fragment = out.stdout.slice(0, out.stdout.indexOf("#"));
    assert.ok(!without_fragment.includes(SECRET) && !without_fragment.includes(Buffer.from(SECRET).toString("base64")) && !without_fragment.includes(Buffer.from(SECRET).toString("base64url")));
    assert.ok(!out.stderr.includes(SECRET));
    assert.deepEqual(out.hub_attempts, [], "the injected port range only");
  } finally {
    await f.cleanup();
  }
});

test("the address names the project's real current position (the same edition / stage / round the workspace read gives)", { timeout: 120_000 }, async () => {
  const f = await start("pes-sel82-open-pos-");
  try {
    const out = f.run(["open", "synthetic", "--app"]);
    assert.equal(out.status, 0, out.stderr);
    const url = new URL(out.stdout.trim());
    const ws = await f.server.request(`/api/v1/projects/${f.project_id}/workspace`, { headers: { "x-pes-session": SECRET } });
    assert.equal(ws.status, 200, ws.text());
    const data = ws.json().data;
    const round = data.current.round_id === null ? "start" : String(data.current.round_id);
    assert.equal(url.pathname, `/p/synthetic/e/${data.edition}/s/${data.current.stage}/r/${round}`);
  } finally {
    await f.cleanup();
  }
});

test("the session in the fragment is the one the CLI resolves (PES_LOCAL_SESSION_SECRET here) — never a made-up value", { timeout: 120_000 }, async () => {
  const f = await start("pes-sel82-open-src-");
  try {
    // the CLI reads the session the way api_secret.ts does; a value it is given is the value it hands over (a wrong one shows up as wrong — nothing replaces it)
    const out = f.run(["open", "synthetic", "--app"], { PES_LOCAL_SESSION_SECRET: "synthetic-other-session-value-9876543210" });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(decode(new URL(out.stdout.trim()).hash).session, "synthetic-other-session-value-9876543210");
  } finally {
    await f.cleanup();
  }
});

test("plain `pes open <slug>` is unchanged: the old dashboard address, no fragment, no session", { timeout: 120_000 }, async () => {
  const f = await start("pes-sel82-open-old-");
  try {
    const out = f.run(["open", "synthetic"]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout.trim(), `http://127.0.0.1:${f.server.port}/synthetic/`);
    assert.ok(!out.stdout.includes("#") && !out.stdout.includes(SECRET));
  } finally {
    await f.cleanup();
  }
});

test("--app with the server off starts nothing: non-zero exit, a short Korean hint, no fragment and no session printed", { timeout: 120_000 }, async () => {
  const f = await start("pes-sel82-open-off-", false);
  try {
    const out = f.run(["open", "synthetic", "--app"]);
    assert.notEqual(out.status, 0, "an app address needs a running server");
    const all = `${out.stdout}\n${out.stderr}`;
    assert.ok(!all.includes("#pes=") && !all.includes(SECRET), "no handoff without a server");
    assert.match(all, /[가-힣]/, "a Korean hint");
    assert.match(all, /serve/, "names `pes serve`");
    assert.doesNotMatch(all, /node:internal|\bat .+\(.+:\d+:\d+\)|TypeError/);
    assert.deepEqual(out.hub_attempts, []);
  } finally {
    await f.cleanup();
  }
});

test("--app for an unknown project is an error with no session in it", { timeout: 120_000 }, async () => {
  const f = await start("pes-sel82-open-unk-");
  try {
    const out = f.run(["open", "no-such-project", "--app"]);
    assert.notEqual(out.status, 0);
    const all = `${out.stdout}\n${out.stderr}`;
    assert.ok(!all.includes("#pes=") && !all.includes(SECRET));
    assert.doesNotMatch(all, /node:internal|\bat .+\(.+:\d+:\d+\)|TypeError/);
  } finally {
    await f.cleanup();
  }
});

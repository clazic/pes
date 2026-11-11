// SEL-82 U1b — 앱이 실제 API 를 읽는다 (Playwright, tester 작성 모드 · R1 반영 2차). 구현 전이라 실패가 정상.
//
// 임시 HOME·USERPROFILE·PES_HOME 의 합성 DB 프로젝트를 serve.ts 가 서빙하고(실제 홈·실제 PES 포트 0), 서버가 /p/<slug>/... 로 내주는 앱 빌드를
// Chromium 으로 연다. 앱 산출물 = 환경변수 PES_APP_DIR(없으면 app/dist), 자산은 /_app/…(vite base "/_app/").
//
// 세션 넘기기(R1 필수 1, leader 결정 = 권장안 A) — 이 파일이 못 박는 해석:
//   - 앱을 여는 명령 `pes open <slug> --app` (PES_NO_BROWSER=1 이면 주소만 출력, 시험은 ws.open_app() 으로 받음) 이
//     http://127.0.0.1:<port>/p/<slug>/e/<판>/s/<단계>/r/<라운드>#pes=<base64url JSON {session, projects:{slug:id}}> 를 준다.
//     시험은 addInitScript 를 쓰지 않는다 — 그 주소로 열기만 한다.
//   - 앱은 렌더 전(main.tsx)에 조각을 읽어 같은 탭 sessionStorage(막히면 메모리)에 두고 history.replaceState 로 조각을 지운다. 서버는 앱 페이지에 세션을 심지 않는다.
//   - 조각이 없거나 깨졌으면(그리고 같은 탭에 이미 받은 것도 없으면) 앱은 가짜 클라이언트로 되돌아가지 않고 '이 주소는 pes open 으로 여세요' 안내를 그린다 — 안내 글에
//     `pes open` 이 들어간다(시험은 /pes open/ 으로 찾는다). 가짜(합성) 클라이언트는 개발·시험 모드(vite dev · vitest · 비 production 빌드)에서만 기본이다.
//     production 빌드(npm run build)는 안내만 그린다 — 그래서 이 파일은 production 빌드(app/dist)를 연다.
//   - 세션이 서버에서 거절되면(틀린 세션) 가짜 자료로 되돌아가지 않고 오류를 보인다.
//
// 앞 조건: `cd app && npm ci && npm run build` (app/dist/index.html, production 빌드, 자산 경로 /_app/). 없으면 건너뛰지 않고 실패한다(CI 계약).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";

import { REPO, open_workspace, type Workspace } from "./helpers/workspace.ts";

const DIST = join(REPO, "app", "dist");

let ws: Workspace;
test.beforeAll(async () => {
  expect(existsSync(join(DIST, "index.html")), "앱 빌드가 없다 — cd app && npm ci && npm run build 를 먼저 한다(app/dist/index.html)").toBe(true);
  ws = await open_workspace({ PES_APP_DIR: DIST });
});
test.afterAll(async () => {
  await ws?.close();
});

const api = (rest: string): string => `${ws.base}/api/v1/projects/${ws.project_id}${rest}`;

/** 서버가 알려 주는 작업 공간(현재 단계·라운드·판) — 합성 프로젝트의 내용을 미리 가정하지 않는다. */
async function workspaceData(page: Page): Promise<any> {
  const res = await page.request.get(api("/workspace"), { headers: { "x-pes-session": ws.session } });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).data;
}

const payloadOf = (url: string): string => new URL(url).hash.replace(/^#pes=/, "");

/** 주소의 조각을 바꾼 주소(경로·쿼리는 그대로) */
function withHash(url: string, hash: string): string {
  const u = new URL(url);
  u.hash = hash;
  return u.href;
}
const b64url = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

interface Seen {
  url: URL;
  method: string;
  headers: Record<string, string>;
}
/** 브라우저가 보낸 모든 요청(헤더는 Referer 까지 포함). 끝날 때 `done()` 으로 기다린다. */
function watchRequests(page: Page) {
  const pending: Promise<Seen>[] = [];
  page.on("request", (r) => pending.push(r.allHeaders().then((headers) => ({ url: new URL(r.url()), method: r.method(), headers }))));
  return { done: async (): Promise<Seen[]> => Promise.all(pending) };
}

test("A0 앞 조건: 앱 빌드의 자산 경로는 /_app/ 이다(옛 /app/ 이 아님) — slug 가 `app` 인 프로젝트의 쪽을 가리지 않는다", async () => {
  const html = readFileSync(join(DIST, "index.html"), "utf8");
  expect(html).toMatch(/(src|href)="\/_app\/assets\//);
  expect(html).not.toMatch(/(src|href)="\/app\//);
  const res = await fetch(`${ws.base}/_app/index.html`);
  expect(res.status).toBe(200);
});

test("A1 pes open --app 이 준 주소로만 열어도(addInitScript 없음) 앱 화면이 임시 홈 합성 프로젝트의 서버 자료를 보인다", async ({ page }) => {
  const url = ws.open_app();
  expect(new URL(url).hash).toMatch(/^#pes=/);
  const data = await workspaceData(page);
  expect(data.slug).toBe(ws.slug);
  const seen = watchRequests(page);
  const response = await page.goto(url);
  expect(response?.status()).toBe(200);
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
  // 서버가 준 제목 — 합성 fixture(`예시 연구`)가 아니다
  await expect(page.getByRole("navigation", { name: "현재 위치" })).toContainText(data.title);
  await expect(page.locator("body")).not.toContainText("예시 연구");
  await expect(page.getByRole("navigation", { name: /연구 흐름/ })).toBeVisible();
  const all = await seen.done();
  // 읽기는 GET 만, 같은 출처, 세션 헤더 포함, workspace 를 실제로 읽었다
  const apiCalls = all.filter((r) => r.url.pathname.startsWith("/api/"));
  expect(apiCalls.some((r) => r.url.pathname === `/api/v1/projects/${ws.project_id}/workspace`)).toBe(true);
  for (const r of apiCalls) {
    expect(r.method, r.url.pathname).toBe("GET");
    expect(r.headers["x-pes-session"], r.url.pathname).toBe(ws.session);
    expect(r.url.origin).toBe(ws.base);
  }
  // 다른 출처·허브 포트 요청 0, 앱 자산은 /_app/ 에서
  for (const r of all) expect(r.url.origin === ws.base || r.url.protocol === "data:" || r.url.protocol === "blob:", r.url.href).toBe(true);
  const assets = all.filter((r) => /\.(js|css|woff2?)$/.test(r.url.pathname));
  expect(assets.length).toBeGreaterThan(0);
  for (const r of assets) expect(r.url.pathname, "앱 자산").toMatch(/^\/_app\//);
  expect((await page.context().cookies()).length, "쿠키 0").toBe(0);
});

test("B1 조각은 렌더 뒤 주소창에서 지워지고, 주소·요청 URL·헤더(Referer 포함)·콘솔·localStorage·쿠키 어디에도 세션이 없다(세션 헤더는 API 요청의 x-pes-session 뿐)", async ({ page }) => {
  const url = ws.open_app();
  const payload = payloadOf(url);
  expect(payload.length).toBeGreaterThan(10);
  const consoles: string[] = [];
  page.on("console", (m) => consoles.push(m.text()));
  page.on("pageerror", (e) => consoles.push(String(e)));
  const seen = watchRequests(page);
  await page.goto(url);
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash, { message: "조각이 history.replaceState 로 지워진다" }).toBe("");
  const after = page.url();
  expect(after).toBe(`${ws.base}${new URL(url).pathname}`);
  for (const secret of [ws.session, payload, Buffer.from(ws.session).toString("base64")]) {
    expect(after).not.toContain(secret);
    for (const r of await seen.done()) {
      expect(r.url.href, "요청 URL").not.toContain(secret);
      for (const [name, value] of Object.entries(r.headers)) {
        if (name === "x-pes-session" && r.url.pathname.startsWith("/api/") && secret === ws.session) continue;
        expect(value, `요청 헤더 ${name} (${r.url.pathname})`).not.toContain(secret);
      }
    }
    expect(consoles.join("\n")).not.toContain(secret);
  }
  for (const r of await seen.done()) expect(r.headers["referer"] ?? "", "Referer 에 조각이 없다").not.toMatch(/#|pes=/);
  const inside = String(await page.evaluate("JSON.stringify({ href: location.href, referrer: document.referrer, state: history.state, ls: { ...localStorage }, cookie: document.cookie, name: window.name })"));
  expect(inside).not.toContain(ws.session);
  expect(inside).not.toContain(payload);
  expect((await page.context().cookies()).length).toBe(0);
});

test("B2 E12 유지: 브라우저가 받은 어떤 응답(본문·헤더)에도 소유자 세션 비밀이 없다(앱 페이지·자산·API 응답 모두)", async ({ page }) => {
  const url = ws.open_app();
  const payload = payloadOf(url);
  const bodies: string[] = [];
  page.on("response", async (r) => {
    try {
      bodies.push(await r.text(), JSON.stringify(await r.allHeaders()));
    } catch {
      // body not available (redirect, binary, etc.)
    }
  });
  await page.goto(url);
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
  await page.goto(`${ws.base}/`);
  await page.goto(`${ws.base}/${ws.slug}/`);
  await page.waitForTimeout(500);
  const all = bodies.join("\n");
  expect(all.length).toBeGreaterThan(1000);
  expect(all).not.toContain(ws.session);
  expect(all).not.toContain(payload);
  expect(all).not.toContain(Buffer.from(ws.session).toString("base64"));
});

test("B3 같은 탭에서는 새로고침·뒤로 가기가 서버 자료를 다시 그린다(세션은 같은 탭 sessionStorage/메모리), 새 탭·새 창은 조각 없이는 열리지 않는다", async ({ page, browser }) => {
  const url = ws.open_app();
  const data = await workspaceData(page);
  await page.goto(url);
  await expect(page.getByRole("navigation", { name: "현재 위치" })).toContainText(data.title);
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  const cleaned = page.url();
  await page.reload();
  await expect(page).toHaveURL(cleaned);
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "현재 위치" })).toContainText(data.title);
  await expect(page.locator("body")).not.toContainText("예시 연구");
  // 다른 곳을 갔다 뒤로 와도 같은 자료
  await page.goto(`${ws.base}/${ws.slug}/`);
  await page.goBack();
  await expect(page.getByRole("navigation", { name: "현재 위치" })).toContainText(data.title);
  // localStorage 에는 세션을 두지 않는다(탭을 넘어 새지 않는다)
  expect(String(await page.evaluate("JSON.stringify({ ...localStorage })"))).not.toContain(ws.session);
  // 새 컨텍스트(= 다른 브라우저 프로필/탭)에서 조각 없는 주소: 안내, 서버 자료 없음
  await assertGuidance(browser, cleaned);
});

test("B4 slug 가 서버 맵에 없는 주소는 '찾을 수 없음' 이다(조각은 정상, 서버가 앱은 내주고 화면이 판단한다)", async ({ page }) => {
  const url = new URL(ws.open_app());
  url.pathname = "/p/no-such-project/e/1/s/plan/r/start";
  const seen = watchRequests(page);
  const response = await page.goto(url.href);
  expect(response?.status()).toBe(200);
  await expect(page.getByText(/찾을 수 없/).first()).toBeVisible();
  // the document request itself carries the slug in its path; what must not happen is an API read for it
  expect((await seen.done()).filter((r) => r.url.pathname.startsWith("/api/") && r.url.pathname.includes("no-such-project"))).toEqual([]);
});

/** 조각 없음·깨진 조각: 안내(`pes open`)가 보이고, 합성 자료도 서버 자료도 없고, /api/ 요청이 0 이다. */
async function assertGuidance(browser: Browser, address: string): Promise<void> {
  const context = await browser.newContext({ locale: "ko-KR", timezoneId: "Asia/Seoul" });
  try {
    const page = await context.newPage();
    const seen = watchRequests(page);
    const response = await page.goto(address);
    expect(response?.status(), address.slice(0, 80)).toBe(200);
    await expect(page.getByText(/pes open/).first(), `안내 — ${address.slice(0, 80)}`).toBeVisible();
    await expect(page.locator("body")).not.toContainText("예시 연구");
    await expect(page.locator("main [data-screen-title]")).toHaveCount(0);
    await page.waitForTimeout(300);
    expect((await seen.done()).filter((r) => r.url.pathname.startsWith("/api/")), "/api/ 요청 0").toEqual([]);
    expect(page.url(), "깨진 조각도 주소창에 남기지 않는다").not.toContain("pes=");
  } finally {
    await context.close();
  }
}

test("D1 조각이 없으면(주소를 그냥 붙여 넣음) 가짜 클라이언트가 아니라 '이 주소는 pes open 으로 여세요' 안내다 — production 빌드에서 합성 자료(예시 연구)가 보이면 안 된다", async ({ browser }) => {
  const url = new URL(ws.open_app());
  url.hash = "";
  await assertGuidance(browser, url.href);
  await assertGuidance(browser, `${ws.base}/p/sample-study/e/1/s/research/r/2`);
});

test("D2 깨진 조각은 모두 안내다 — 빈 값 · base64 아님 · JSON 아님 · 모양 틀림 · 세션 빔 · projects 값이 문자열 아님", async ({ browser }) => {
  const base = ws.open_app();
  const broken = [
    "#pes=",
    "#pes=!!!not-base64!!!",
    `#pes=${b64url("this is not json")}`,
    `#pes=${b64url("[]")}`,
    `#pes=${b64url("null")}`,
    `#pes=${b64url(JSON.stringify({ projects: { [ws.slug]: ws.project_id } }))}`,
    `#pes=${b64url(JSON.stringify({ session: "", projects: { [ws.slug]: ws.project_id } }))}`,
    `#pes=${b64url(JSON.stringify({ session: ws.session, projects: "nope" }))}`,
    `#pes=${b64url(JSON.stringify({ session: ws.session, projects: { [ws.slug]: 7 } }))}`,
    `#pes=${b64url(JSON.stringify({ session: 12345, projects: {} }))}`,
  ];
  for (const hash of broken) await assertGuidance(browser, withHash(base, hash));
});

test("D3 서버가 세션을 거절하면(틀린 세션 조각) 가짜 자료로 되돌아가지 않고 오류를 보이며, 틀린 세션도 주소창에 남지 않는다", async ({ page }) => {
  const url = withHash(ws.open_app(), `#pes=${b64url(JSON.stringify({ session: "synthetic-wrong-session-value", projects: { [ws.slug]: ws.project_id } }))}`);
  const data = await workspaceData(page);
  const seen = watchRequests(page);
  await page.goto(url);
  await page.waitForTimeout(800);
  await expect(page.locator("body")).not.toContainText("예시 연구");
  await expect(page.locator("body")).not.toContainText(data.title);
  const calls = (await seen.done()).filter((r) => r.url.pathname.startsWith("/api/"));
  expect(calls.length).toBeGreaterThan(0);
  expect(page.url()).not.toContain("pes=");
  expect(page.url()).not.toContain("synthetic-wrong-session-value");
});

test("A5 앱 경로가 있어도 기존 대시보드(/<slug>/)·ask 링크·version·ping 이 그대로 동작한다", async ({ page }) => {
  await page.goto(`${ws.base}/${ws.slug}/`);
  await expect(page.locator("h1").first()).toContainText("합성 파일 주제");
  expect((await page.request.get(`${ws.base}/${ws.slug}/ping`)).status()).toBe(200);
  expect((await page.request.get(`${ws.base}/${ws.slug}/version`)).status()).toBe(200);
  const home = await page.request.get(`${ws.base}/`);
  expect(home.status()).toBe(200);
  expect(await home.text()).toContain(ws.slug);
});

test("A6 같은 JSON API: 기존 대시보드가 내장한 제목(topic)·현재 단계가 앱이 읽는 workspace 와 같다", async ({ page }) => {
  const data = await workspaceData(page);
  const html = await (await page.request.get(`${ws.base}/${ws.slug}/index.html`)).text();
  const m = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  expect(m).not.toBeNull();
  const embedded = JSON.parse((m![1] as string).replace(/\\u003c/gi, "<")) as { topic?: string; current?: string };
  expect(embedded.topic).toBe(data.title);
  if (embedded.current !== undefined) expect(embedded.current).toBe(data.current.stage);
});

test("A7 인쇄: 앱 주소에 ?print=1 을 붙이면 인쇄 미리보기 영역이 서버 자료로 열린다(조각은 그대로 앱에 넘어간다)", async ({ page }) => {
  const u = new URL(ws.open_app());
  u.search = "?print=1";
  const data = await workspaceData(page);
  await page.goto(u.href);
  await expect(page.getByRole("region", { name: "인쇄 미리보기" })).toBeVisible();
  await expect(page.getByRole("region", { name: "인쇄 미리보기" })).toContainText(data.title);
  expect(page.url()).toContain("print=1");
  expect(page.url()).not.toContain("pes=");
});

// SEL-82 U1b — 앱이 실제 API 를 읽는다 (Playwright, tester 작성 모드). 구현 전이라 실패가 정상.
//
// 임시 HOME·USERPROFILE·PES_HOME 의 합성 DB 프로젝트를 serve.ts 가 서빙하고(실제 홈·실제 PES 포트 0), 서버가 /p/<slug>/... 로 내주는 앱 빌드를
// Chromium 으로 열어 화면이 서버 자료를 보이는지 본다. 앱 모드/클라이언트 해석은 app/src/api/http-client.test.ts 머리말, 서버 해석은
// tests/test_sel82_serve_workspace.test.ts 머리말: 앱 산출물 = 환경변수 PES_APP_DIR(없으면 app/dist), 자산은 /app/…, 모드 설정은
// window.__PES_APP__ = { api: "http", session, projects: { [slug]: 프로젝트 id } } (여기서는 addInitScript 가 대신한다).
//
// 앞 조건: `cd app && npm ci && npm run build` (app/dist/index.html). 없으면 건너뛰지 않고 실패한다(CI 계약 — 빌드 단계는 worker 가 CI 에 더한다).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

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

/** 서버가 알려 주는 작업 공간(현재 단계·라운드·판)에서 앱 주소를 만든다 — 합성 프로젝트의 내용을 미리 가정하지 않는다. */
async function workspaceUrl(page: Page): Promise<{ path: string; data: any }> {
  const res = await page.request.get(api("/workspace"), { headers: { "x-pes-session": ws.session } });
  expect(res.status(), await res.text()).toBe(200);
  const data = (await res.json()).data;
  const round = data.current.round_id === null ? "start" : String(data.current.round_id);
  return { path: `/p/${ws.slug}/e/${data.edition}/s/${data.current.stage}/r/${round}`, data };
}

const configure = (page: Page, projects: Record<string, string> = { [ws.slug]: ws.project_id }) =>
  page.addInitScript(([session, map]) => {
    (globalThis as unknown as Record<string, unknown>).__PES_APP__ = { api: "http", session, projects: map };
  }, [ws.session, projects] as const);

function watchRequests(page: Page) {
  const seen: { url: URL; method: string; session: string | undefined }[] = [];
  page.on("request", (r) => seen.push({ url: new URL(r.url()), method: r.method(), session: r.headers()["x-pes-session"] }));
  return seen;
}

test("A1 서버가 /p/<slug>/e/<n>/s/<stage>/r/<round> 로 앱을 내주고, 앱 화면이 임시 홈 합성 프로젝트의 제목과 단계를 보인다", async ({ page }) => {
  const { path, data } = await workspaceUrl(page);
  expect(data.slug).toBe(ws.slug);
  await configure(page);
  const seen = watchRequests(page);
  const response = await page.goto(`${ws.base}${path}`);
  expect(response?.status()).toBe(200);
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
  // 서버가 준 제목 — 합성 fixture(`예시 연구`)가 아니다
  await expect(page.getByRole("navigation", { name: "현재 위치" })).toContainText(data.title);
  await expect(page.locator("body")).not.toContainText("예시 연구");
  await expect(page.getByRole("navigation", { name: /연구 흐름/ })).toBeVisible();
  // 읽기는 GET 만, 같은 출처, 세션 헤더 포함, workspace 를 실제로 읽었다
  const apiCalls = seen.filter((r) => r.url.pathname.startsWith("/api/"));
  expect(apiCalls.some((r) => r.url.pathname === `/api/v1/projects/${ws.project_id}/workspace`)).toBe(true);
  for (const r of apiCalls) {
    expect(r.method, r.url.pathname).toBe("GET");
    expect(r.session, r.url.pathname).toBe(ws.session);
    expect(r.url.origin).toBe(ws.base);
  }
  // 다른 출처·허브 포트 요청 0
  for (const r of seen) expect(r.url.origin === ws.base || r.url.protocol === "data:" || r.url.protocol === "blob:", r.url.href).toBe(true);
  expect((await page.context().cookies()).length, "쿠키 0").toBe(0);
});

test("A2 새로고침·뒤로 가기: 같은 주소에서 같은 서버 자료를 다시 그린다", async ({ page }) => {
  const { path, data } = await workspaceUrl(page);
  await configure(page);
  await page.goto(`${ws.base}${path}`);
  await expect(page.getByRole("navigation", { name: "현재 위치" })).toContainText(data.title);
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`));
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "현재 위치" })).toContainText(data.title);
});

test("A3 설정에 없는 slug 의 주소는 '찾을 수 없음' 이다(서버가 앱은 내주고 화면이 판단한다)", async ({ page }) => {
  await configure(page);
  const response = await page.goto(`${ws.base}/p/no-such-project/e/1/s/plan/r/start`);
  expect(response?.status()).toBe(200);
  await expect(page.getByText(/찾을 수 없/).first()).toBeVisible();
});

test("A4 설정(window.__PES_APP__)이 없으면 U1a 그대로 가짜 클라이언트이고 /api/ 요청이 0이다", async ({ page }) => {
  const seen = watchRequests(page);
  await page.goto(`${ws.base}/p/sample-study/e/1/s/research/r/2`);
  await expect(page.locator("main [data-screen-title]")).toContainText("조사 R2");
  expect(seen.filter((r) => r.url.pathname.startsWith("/api/"))).toEqual([]);
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
  const { data } = await workspaceUrl(page);
  const html = await (await page.request.get(`${ws.base}/${ws.slug}/index.html`)).text();
  const m = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  expect(m).not.toBeNull();
  const embedded = JSON.parse((m![1] as string).replace(/\\u003c/gi, "<")) as { topic?: string; current?: string };
  expect(embedded.topic).toBe(data.title);
  if (embedded.current !== undefined) expect(embedded.current).toBe(data.current.stage);
});

test("A7 인쇄: 앱 주소에 ?print=1 을 붙이면 인쇄 미리보기 영역이 서버 자료로 열린다", async ({ page }) => {
  const { path, data } = await workspaceUrl(page);
  await configure(page);
  await page.goto(`${ws.base}${path}?print=1`);
  await expect(page.getByRole("region", { name: "인쇄 미리보기" })).toBeVisible();
  await expect(page.getByRole("region", { name: "인쇄 미리보기" })).toContainText(data.title);
});

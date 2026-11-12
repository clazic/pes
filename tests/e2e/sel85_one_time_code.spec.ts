// SEL-85 U1b 후속 A — 앱 세션 전달 = 1회용 코드 교환 (Playwright, tester 작성 모드). 구현 전이라 실패가 정상.
//
// 해석 (서버·앱 계약은 tests/test_sel85_app_code.test.ts · app/src/api/sel85-exchange.test.ts 머리말):
//   - `pes open <slug> --app` 주소의 조각은 `#code=<코드>`. 앱은 렌더 전에 조각을 지우고 `POST /api/v1/app-session {code}` 로 세션과 바꾼다(한 번).
//   - 코드를 쓰고 나면 같은 주소를 다시 열어도(브라우저 기록·북마크) 세션을 못 얻는다 → production 빌드가 `pes open` 안내를 그린다(가짜 자료·서버 자료 없음).
//   - 교환이 실패하면 안내(OpenGuidance 류: 글에 `pes open`) — 가짜(합성) 자료로 돌아가지 않는다.
//   - 기존 B1~B4·D1~D3·E12 의 보장은 새 흐름에서도 같다: 세션이 주소·요청 URL·Referer·콘솔·localStorage·쿠키에 없고, 응답 본문·헤더에도 없다(교환 응답 본문만 예외 — 세션을 돌려주는 곳).
// 앞 조건: `cd app && npm ci && npm run build` (app/dist, production, 자산 /_app/). 없으면 건너뛰지 않고 실패한다.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";

import { REPO, open_workspace, type Workspace } from "./helpers/workspace.ts";

const DIST = join(REPO, "app", "dist");
const EXCHANGE = "/api/v1/app-session";

let ws: Workspace;
test.beforeAll(async () => {
  expect(existsSync(join(DIST, "index.html")), "앱 빌드가 없다 — cd app && npm ci && npm run build 를 먼저 한다(app/dist/index.html)").toBe(true);
  ws = await open_workspace({ PES_APP_DIR: DIST });
});
test.afterAll(async () => {
  await ws?.close();
});

const codeOf = (url: string): string => new URL(url).hash.replace(/^#code=/, "");
const withHash = (url: string, hash: string): string => {
  const u = new URL(url);
  u.hash = hash;
  return u.href;
};

interface Seen {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}
function watch(page: Page) {
  const pending: Promise<Seen>[] = [];
  page.on("request", (r) => pending.push(r.allHeaders().then((headers) => ({ url: new URL(r.url()), method: r.method(), headers, body: r.postData() }))));
  return { done: async (): Promise<Seen[]> => Promise.all(pending) };
}
const exchanges = (all: Seen[]): Seen[] => all.filter((r) => r.url.pathname === EXCHANGE);

async function assertGuidance(browser: Browser, address: string, label: string): Promise<void> {
  const context = await browser.newContext({ locale: "ko-KR", timezoneId: "Asia/Seoul" });
  try {
    const page = await context.newPage();
    const seen = watch(page);
    const consoles: string[] = [];
    page.on("console", (m) => consoles.push(m.text()));
    const response = await page.goto(address);
    expect(response?.status(), label).toBe(200);
    await expect(page.getByText(/pes open/).first(), `안내 — ${label}`).toBeVisible();
    await expect(page.locator("body")).not.toContainText("예시 연구");
    await expect(page.locator("main [data-screen-title]")).toHaveCount(0);
    await page.waitForTimeout(300);
    const all = await seen.done();
    // 교환을 시도했다면 거절됐다 — 그리고 세션을 읽는 API 요청은 성공하지 못한다
    for (const r of exchanges(all)) expect(r.method).toBe("POST");
    expect(all.filter((r) => r.url.pathname.startsWith("/api/") && r.url.pathname !== EXCHANGE), `${label}: 세션 없는 API 요청 0`).toEqual([]);
    expect(page.url(), "코드를 주소창에 남기지 않는다").not.toContain("code=");
    expect(consoles.join("\n")).not.toContain(ws.session);
    expect(await context.cookies()).toEqual([]);
    expect(String(await page.evaluate("JSON.stringify({ ...localStorage, ...sessionStorage })"))).not.toContain(ws.session);
  } finally {
    await context.close();
  }
}

test("C1 pes open --app 주소만으로 열면 앱이 코드를 교환(POST 한 번)하고 서버 자료를 보인다 — 교환 응답은 no-store, 요청에 세션 헤더 없음", async ({ page }) => {
  const url = ws.open_app();
  expect(new URL(url).hash).toMatch(/^#code=[A-Za-z0-9_-]{20,}$/);
  expect(url).not.toContain("#pes=");
  expect(url).not.toContain(ws.session);
  const code = codeOf(url);
  const res = await page.request.get(`${ws.base}/api/v1/projects/${ws.project_id}/workspace`, { headers: { "x-pes-session": ws.session } });
  const data = (await res.json()).data;
  const seen = watch(page);
  let exchangeResponse: { status: number; cache: string | undefined } | null = null;
  page.on("response", (r) => {
    if (new URL(r.url()).pathname === EXCHANGE) exchangeResponse = { status: r.status(), cache: r.headers()["cache-control"] };
  });
  await page.goto(url);
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "현재 위치" })).toContainText(data.title);
  await expect(page.locator("body")).not.toContainText("예시 연구");
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  const all = await seen.done();
  const ex = exchanges(all);
  expect(ex, "교환 요청은 정확히 한 번").toHaveLength(1);
  expect(ex[0]!.method).toBe("POST");
  expect(ex[0]!.url.origin).toBe(ws.base);
  expect(ex[0]!.headers["x-pes-session"]).toBeUndefined();
  expect(JSON.parse(ex[0]!.body ?? "{}")).toEqual({ code });
  expect(exchangeResponse).not.toBeNull();
  expect((exchangeResponse as any).status).toBe(200);
  expect((exchangeResponse as any).cache ?? "").toMatch(/no-store/);
  // 교환 뒤의 API 읽기는 GET + 세션 헤더
  const reads = all.filter((r) => r.url.pathname.startsWith("/api/") && r.url.pathname !== EXCHANGE);
  expect(reads.length).toBeGreaterThan(0);
  for (const r of reads) {
    expect(r.method, r.url.pathname).toBe("GET");
    expect(r.headers["x-pes-session"], r.url.pathname).toBe(ws.session);
  }
});

test("C2 B1·E12 유지: 새 흐름에서도 세션은 주소·요청 URL·Referer·콘솔·localStorage·쿠키·window.name·history.state 에 없고, 교환 응답 말고는 어떤 응답 본문·헤더에도 없다", async ({ page }) => {
  const url = ws.open_app();
  const code = codeOf(url);
  const consoles: string[] = [];
  page.on("console", (m) => consoles.push(m.text()));
  page.on("pageerror", (e) => consoles.push(String(e)));
  const bodies: string[] = [];
  page.on("response", async (r) => {
    if (new URL(r.url()).pathname === EXCHANGE) return;
    try {
      bodies.push(await r.text(), JSON.stringify(await r.allHeaders()));
    } catch {
      // no body
    }
  });
  const seen = watch(page);
  await page.goto(url);
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  expect(page.url()).toBe(`${ws.base}${new URL(url).pathname}`);
  await page.goto(`${ws.base}/`);
  await page.goto(`${ws.base}/${ws.slug}/`);
  await page.waitForTimeout(300);
  const all = await seen.done();
  for (const secret of [ws.session, Buffer.from(ws.session).toString("base64"), Buffer.from(ws.session).toString("base64url")]) {
    for (const r of all) {
      expect(r.url.href, "요청 URL").not.toContain(secret);
      for (const [name, value] of Object.entries(r.headers)) {
        if (name === "x-pes-session" && r.url.pathname.startsWith("/api/") && secret === ws.session) continue;
        expect(value, `요청 헤더 ${name} (${r.url.pathname})`).not.toContain(secret);
      }
    }
    expect(consoles.join("\n")).not.toContain(secret);
    expect(bodies.join("\n")).not.toContain(secret);
  }
  for (const r of all) expect(r.headers["referer"] ?? "", "Referer 에 조각이 없다").not.toMatch(/#|code=/);
  expect(bodies.join("\n").length).toBeGreaterThan(1000);
  expect(consoles.join("\n")).not.toContain(code);
  await page.goBack();
  const inside = String(await page.evaluate("JSON.stringify({ href: location.href, referrer: document.referrer, state: history.state, ls: { ...localStorage }, cookie: document.cookie, name: window.name })"));
  expect(inside).not.toContain(ws.session);
  expect(inside).not.toContain(code);
  expect(await page.context().cookies()).toEqual([]);
});

test("C3 기록에 남은 주소를 다시 열어도(코드 재사용) 세션을 얻지 못한다 — 새 프로필·같은 프로필의 새 탭 모두 안내, 서버 자료·가짜 자료 없음", async ({ page, browser }) => {
  const url = ws.open_app();
  await page.goto(url);
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  // 브라우저 기록·북마크에 남았을 수 있는 원래 주소(코드 조각 포함)를 다른 프로필에서 연다
  await assertGuidance(browser, url, "다른 프로필에서 재사용");
  // 같은 프로필의 새 탭도 sessionStorage 를 이어받지 않으므로 같다
  const second = await page.context().newPage();
  const seen = watch(second);
  await second.goto(url);
  await expect(second.getByText(/pes open/).first()).toBeVisible();
  await expect(second.locator("main [data-screen-title]")).toHaveCount(0);
  const all = await seen.done();
  expect(all.filter((r) => r.url.pathname.startsWith("/api/") && r.url.pathname !== EXCHANGE)).toEqual([]);
  expect(second.url()).not.toContain("code=");
});

test("C4 코드 교환이 거절되면(모르는 코드 · 모양 틀린 코드 · 빈 코드) 가짜 자료로 돌아가지 않고 pes open 안내를 그린다", async ({ browser }) => {
  const base = ws.open_app();
  for (const hash of ["#code=AAAAAAAAAAAAAAAAAAAAAAAA", "#code=", "#code=!!!", `#code=${"x".repeat(4000)}`, "#code=%00", "#pes=AAAA"]) {
    await assertGuidance(browser, withHash(base, hash), hash.slice(0, 30));
  }
});

test("C5 서버가 세션 대신 에러를 돌려줘도 합성 자료가 아니라 안내다 — 교환 응답을 500 으로 바꿔도 같다", async ({ browser }) => {
  const context = await browser.newContext({ locale: "ko-KR", timezoneId: "Asia/Seoul" });
  try {
    const page = await context.newPage();
    await page.route(`**${EXCHANGE}`, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal_error" } }) }));
    const url = ws.open_app();
    await page.goto(url);
    await expect(page.getByText(/pes open/).first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText("예시 연구");
    await expect(page.locator("main [data-screen-title]")).toHaveCount(0);
    expect(page.url()).not.toContain("code=");
  } finally {
    await context.close();
  }
});

test("C6 D3 유지: 서버가 거절하는 세션이 오면(교환이 틀린 세션을 돌려줘도) 가짜 자료가 아니라 오류를 보인다", async ({ page }) => {
  await page.route(`**${EXCHANGE}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify({ data: { session: "synthetic-wrong-session-value", projects: { [ws.slug]: ws.project_id } } }) }),
  );
  const res = await page.request.get(`${ws.base}/api/v1/projects/${ws.project_id}/workspace`, { headers: { "x-pes-session": ws.session } });
  const data = (await res.json()).data;
  await page.goto(ws.open_app());
  await page.waitForTimeout(800);
  await expect(page.locator("body")).not.toContainText("예시 연구");
  await expect(page.locator("body")).not.toContainText(data.title);
  expect(page.url()).not.toContain("synthetic-wrong-session-value");
});

test("C7 B3 유지: 같은 탭 새로고침은 서버 자료를 다시 그리고(코드를 다시 쓰지 않는다), 새 프로필은 못 이어받는다", async ({ page, browser }) => {
  const url = ws.open_app();
  const res = await page.request.get(`${ws.base}/api/v1/projects/${ws.project_id}/workspace`, { headers: { "x-pes-session": ws.session } });
  const data = (await res.json()).data;
  await page.goto(url);
  await expect(page.getByRole("navigation", { name: "현재 위치" })).toContainText(data.title);
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  const cleaned = page.url();
  const seen = watch(page);
  await page.reload();
  await expect(page.getByRole("navigation", { name: "현재 위치" })).toContainText(data.title);
  expect(exchanges(await seen.done()), "새로고침은 교환하지 않는다").toHaveLength(0);
  expect(String(await page.evaluate("JSON.stringify({ ...localStorage })"))).not.toContain(ws.session);
  await assertGuidance(browser, cleaned, "조각 없는 주소, 새 프로필");
});

test("C8 코드는 전체 흐름에서 한 번만 산다: 교환된 코드로 API 를 직접 불러도 두 번째 교환은 거절된다", async ({ page }) => {
  const url = ws.open_app();
  const code = codeOf(url);
  await page.goto(url);
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
  const again = await page.request.post(`${ws.base}${EXCHANGE}`, { data: { code }, headers: { origin: ws.base } });
  expect([401, 410]).toContain(again.status());
  expect(await again.text()).not.toContain(ws.session);
  const evil = await page.request.post(`${ws.base}${EXCHANGE}`, { data: { code: codeOf(ws.open_app()) }, headers: { origin: "http://evil.example" } });
  expect(evil.status()).toBe(403);
});

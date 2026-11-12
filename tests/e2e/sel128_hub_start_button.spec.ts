// SEL-128 첫 페이지(프로젝트 목록)의 '프로젝트 시작' 버튼 — Playwright (tester, 작성 모드). 구현 전이라 실패가 정상.
//
// 세션 방식 (leader 결정, 안 C — 서버 변경 0, 새 신뢰 경로 없음. 자세한 계약은 tests/test_sel128_hub_start.test.ts 머리말):
//   - `pes hub --open` 이 첫 페이지 주소 http://127.0.0.1:<포트>/#code=<1회용 코드> 를 준다(PES_NO_BROWSER=1 이면 출력). 코드는 빈 projects({})용.
//   - 첫 페이지 JS 는 렌더·요청 전에 history.replaceState 로 #code 를 지우고 POST /api/v1/app-session {code} 를 한 번(credentials omit·재시도 없음) 보낸다.
//     세션은 같은 탭 sessionStorage 의 `pes-app-handoff` = {session, projects} 에만 둔다(앱과 같은 키) — 주소·HTML·콘솔·쿠키·localStorage 에 없다.
//   - 코드 없이 연 첫 페이지: 버튼은 보이고, 누르면 '터미널에서 pes list 로 여세요' 안내 한 줄(요청 0, DB·폴더 변화 0).
// 화면 계약(접근 이름으로 찾는다 — 구현은 이 이름을 따른다):
//   - 버튼: role=button 이름 '프로젝트 시작'. 누르면 role=dialog(이름에 '프로젝트 시작') 가 열리고 입력 칸 '주제'(필수)·'이름(slug)'(선택, label 에 slug)·버튼 '만들기'.
//   - 열면 '주제' 칸에 초점. Esc 로 닫히고 초점은 '프로젝트 시작' 버튼으로 돌아온다. 키보드만으로 열기·입력·만들기가 된다(Enter 로 제출).
//   - 실패는 role=alert 한국어 한 줄(줄바꿈 없음). 이름 중복 = '이미'/'중복', 권한 없음 = '권한'. 실패하면 입력 칸은 열려 있고 이동하지 않는다.
//   - 만들기 요청: POST /api/v1/projects {slug, topic, owner_display_name}(x-pes-session + Idempotency-Key, credentials omit). 이름을 비우면 첫 페이지가 정한다
//     (모양 ^[a-z0-9][a-z0-9-]{0,63}$). 같은 제출(두 번 누름·Enter 두 번)은 같은 Idempotency-Key 라 프로젝트 1개. 성공하면 같은 탭에서
//     /p/<slug>/ → 앱이 기획 단계 시작 자리(/p/<slug>/e/<n>/s/plan/r/start)를 연다(세션은 sessionStorage 로 이어받음; projects 에 {slug: project_id} 가 더해져 있다).
// 앞 조건: `cd app && npm ci && npm run build` (app/dist). 없으면 건너뛰지 않고 실패한다. 실제 홈 0 — 전부 임시 HOME 의 합성 홈.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

import { CREATE, EXCHANGE, REPO, STORE_KEY, open_empty_home, type EmptyHome } from "./helpers/sel128_home.ts";

const DIST = join(REPO, "app", "dist");
const SLUG_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const one_line = (s: string): boolean => s.trim() !== "" && !/[\r\n]/.test(s.trim()) && /[가-힣]/.test(s);

let ws: EmptyHome;
test.beforeAll(async () => {
  expect(existsSync(join(DIST, "index.html")), "앱 빌드가 없다 — cd app && npm ci && npm run build 를 먼저 한다(app/dist/index.html)").toBe(true);
});
test.afterEach(async () => {
  await ws?.close();
});

interface Seen {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  frame_url: string;
}
function watch(page: Page) {
  const pending: Promise<Seen>[] = [];
  page.on("request", (r) => pending.push(r.allHeaders().then((headers) => ({ url: new URL(r.url()), method: r.method(), headers, body: r.postData(), frame_url: r.frame().url() }))));
  return { done: async (): Promise<Seen[]> => Promise.all(pending) };
}
const creates = (all: Seen[]): Seen[] => all.filter((r) => r.url.pathname === CREATE);
const start_button = (page: Page) => page.getByRole("button", { name: "프로젝트 시작" });
const dialog = (page: Page) => page.getByRole("dialog", { name: /프로젝트 시작/ });
const topic_input = (page: Page) => dialog(page).getByLabel(/주제/);
const slug_input = (page: Page) => dialog(page).getByLabel(/slug/i);
const submit = (page: Page) => dialog(page).getByRole("button", { name: "만들기" });

async function open_with_code(page: Page, home: EmptyHome): Promise<void> {
  await page.goto(home.open_hub());
  await expect(start_button(page)).toBeVisible();
  // 교환이 끝나 세션이 같은 탭 sessionStorage 에 들어올 때까지
  await expect.poll(() => page.evaluate((k) => sessionStorage.getItem(k) !== null, STORE_KEY)).toBe(true);
}

test("1 빈 홈: 코드로 연 첫 페이지에 버튼이 보이고 — 조각은 지워지고, 교환은 한 번(세션 헤더·조각 없이), 세션은 sessionStorage 에만", async ({ page, context }) => {
  ws = await open_empty_home();
  expect(ws.slugs()).toBeNull();
  const address = ws.open_hub();
  expect(new URL(address).hash).toMatch(/^#code=[A-Za-z0-9_-]{20,}$/);
  expect(address).not.toContain(ws.session);
  const seen = watch(page);
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
  await page.goto(address);
  await expect(page.getByRole("heading", { name: "프로젝트", level: 1 })).toBeVisible();
  await expect(start_button(page)).toBeVisible();
  await expect(page.getByText("해당하는 프로젝트가 없습니다.")).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  expect(page.url()).toBe(`${ws.base}/`);
  await expect.poll(() => page.evaluate((k) => sessionStorage.getItem(k) !== null, STORE_KEY)).toBe(true);
  const stored = JSON.parse(await page.evaluate((k) => sessionStorage.getItem(k) as string, STORE_KEY));
  expect(stored).toEqual({ session: ws.session, projects: {} });
  const all = await seen.done();
  const ex = all.filter((r) => r.url.pathname === EXCHANGE);
  expect(ex, "교환 요청은 정확히 한 번").toHaveLength(1);
  expect(ex[0]!.method).toBe("POST");
  expect(ex[0]!.url.origin).toBe(ws.base);
  expect(ex[0]!.headers["x-pes-session"]).toBeUndefined();
  expect(ex[0]!.frame_url, "요청 전에 조각을 지웠다").not.toContain("#");
  expect(ex[0]!.headers["referer"] ?? "").not.toMatch(/#|code=/);
  expect(JSON.parse(ex[0]!.body ?? "{}")).toEqual({ code: new URL(address).hash.replace(/^#code=/, "") });
  expect(all.filter((r) => r.url.pathname === CREATE)).toEqual([]);
  // 세션은 어디에도 새지 않는다
  for (const secret of [ws.session, Buffer.from(ws.session).toString("base64"), Buffer.from(ws.session).toString("base64url")]) {
    for (const r of all) expect(r.url.href).not.toContain(secret);
    expect(consoles.join("\n")).not.toContain(secret);
    expect(bodies.join("\n")).not.toContain(secret);
  }
  expect(await context.cookies()).toEqual([]);
  expect(String(await page.evaluate("JSON.stringify({ ...localStorage })"))).not.toContain(ws.session);
  expect(String(await page.evaluate("JSON.stringify({ href: location.href, state: history.state, name: window.name, cookie: document.cookie, referrer: document.referrer })"))).not.toContain(ws.session);
  expect(ws.slugs()).toBeNull();
});

test("2 키보드만으로: Tab 으로 버튼 → Enter 로 열림(주제 칸 초점) → Esc 로 닫히고 초점 복귀 → 다시 열어 입력 → Enter 로 만들기", async ({ page }) => {
  ws = await open_empty_home();
  await open_with_code(page, ws);
  const btn = start_button(page);
  await btn.focus();
  await expect(btn).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  await expect(topic_input(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  await expect(btn).toBeFocused();
  expect(ws.slugs()).toBeNull();
  // 다시 열어 키보드로 끝까지
  await page.keyboard.press("Enter");
  await expect(topic_input(page)).toBeFocused();
  await page.keyboard.type("키보드로 만든 합성 주제");
  await page.keyboard.press("Tab"); // 이름(slug) 칸 — 비워 둔다
  await expect(slug_input(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/p\/[a-z0-9][a-z0-9-]*\/e\/[0-9]+\/s\/plan\/r\/start$/);
  expect(ws.slugs()).toHaveLength(1);
});

test("2 주제는 필수: 비우거나 공백뿐이면 요청을 보내지 않고 한국어 한 줄로 알린다 — DB·폴더 변화 0, 입력 칸은 열려 있다", async ({ page }) => {
  ws = await open_empty_home();
  await open_with_code(page, ws);
  const tree = ws.tree();
  const seen = watch(page);
  await start_button(page).click();
  await submit(page).click();
  await expect(dialog(page)).toBeVisible();
  const msg = await page.getByRole("alert").first().innerText();
  expect(one_line(msg), msg).toBe(true);
  expect(msg).toContain("주제");
  await topic_input(page).fill("   ");
  await submit(page).click();
  await expect(page.getByRole("alert").first()).toContainText("주제");
  await page.waitForTimeout(300);
  expect(creates(await seen.done()), "요청 0").toEqual([]);
  expect(ws.slugs()).toBeNull();
  expect(ws.tree()).toEqual(tree);
});

test("3 이름(slug) 비움: 첫 페이지가 모양에 맞는 이름을 정해 보내고, 만든 뒤 새 앱의 그 프로젝트 기획 시작 자리가 열린다 — 빈 홈에서 처음부터 끝까지", async ({ page }) => {
  ws = await open_empty_home();
  await open_with_code(page, ws);
  const seen = watch(page);
  await start_button(page).click();
  await topic_input(page).fill("합성 첫 프로젝트 주제");
  await submit(page).click();
  await expect(page).toHaveURL(/\/p\/[a-z0-9][a-z0-9-]*\/e\/[0-9]+\/s\/plan\/r\/start$/);
  const all = await seen.done();
  const made = creates(all);
  expect(made, "만들기 요청 하나").toHaveLength(1);
  expect(made[0]!.method).toBe("POST");
  expect(made[0]!.url.origin).toBe(ws.base);
  expect(made[0]!.headers["x-pes-session"]).toBe(ws.session);
  expect(made[0]!.headers["idempotency-key"]).toBeTruthy();
  const body = JSON.parse(made[0]!.body ?? "{}");
  expect(Object.keys(body).sort()).toEqual(["owner_display_name", "slug", "topic"]);
  expect(body.topic).toBe("합성 첫 프로젝트 주제");
  expect(body.slug).toMatch(SLUG_SHAPE);
  expect(typeof body.owner_display_name === "string" && body.owner_display_name !== "").toBe(true);
  expect(new URL(page.url()).pathname.startsWith(`/p/${body.slug}/`)).toBe(true);
  expect(ws.slugs()).toEqual([body.slug]);
  // 새 앱: 그 프로젝트의 기획 단계 시작 화면(합성 예시 연구가 아니다), 세션이 이어받아졌다
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("예시 연구");
  await expect(page.getByRole("navigation", { name: "현재 위치" })).toContainText("합성 첫 프로젝트 주제");
  const stored = JSON.parse(await page.evaluate((k) => sessionStorage.getItem(k) as string, STORE_KEY));
  expect(stored.session).toBe(ws.session);
  expect(Object.keys(stored.projects)).toEqual([body.slug]);
  expect(new URL(page.url()).hash).toBe("");
});

test("3 이름(slug)을 적으면 그 이름으로 만든다 — 열린 주소에도 그 이름", async ({ page }) => {
  ws = await open_empty_home();
  await open_with_code(page, ws);
  const seen = watch(page);
  await start_button(page).click();
  await topic_input(page).fill("합성 이름 지정 주제");
  await slug_input(page).fill("synthetic-named");
  await submit(page).click();
  await expect(page).toHaveURL(/\/p\/synthetic-named\/e\/[0-9]+\/s\/plan\/r\/start$/);
  expect(JSON.parse(creates(await seen.done())[0]!.body ?? "{}").slug).toBe("synthetic-named");
  expect(ws.slugs()).toEqual(["synthetic-named"]);
});

test("4 멱등: 만들기를 연달아 두 번 눌러도(응답이 늦어도) 요청은 같은 Idempotency-Key 이고 프로젝트는 1개다", async ({ page }) => {
  ws = await open_empty_home();
  await open_with_code(page, ws);
  await page.route(`**${CREATE}`, async (route) => {
    await new Promise((r) => setTimeout(r, 600));
    await route.continue();
  });
  const seen = watch(page);
  await start_button(page).click();
  await topic_input(page).fill("합성 두 번 누름 주제");
  await slug_input(page).fill("synthetic-twice");
  await submit(page).click({ noWaitAfter: true });
  await submit(page).click({ force: true, noWaitAfter: true, timeout: 1000 }).catch(() => undefined); // 두 번째는 막혀 있어도 된다
  await page.keyboard.press("Enter").catch(() => undefined);
  await expect(page).toHaveURL(/\/p\/synthetic-twice\/e\/[0-9]+\/s\/plan\/r\/start$/);
  const made = creates(await seen.done());
  expect(made.length).toBeGreaterThanOrEqual(1);
  expect(new Set(made.map((r) => r.headers["idempotency-key"])).size, "모든 요청이 같은 키").toBe(1);
  expect(ws.slugs()).toEqual(["synthetic-twice"]);
});

test("5 이름 중복: 한국어 한 줄('이미' 또는 '중복')로 알리고 이동하지 않으며 아무것도 더 만들지 않는다", async ({ page }) => {
  ws = await open_empty_home();
  expect((await ws.api_create({ slug: "synthetic-dup", topic: "합성 먼저 있던 주제", owner_display_name: "합성 소유자" }, "seed-1")).status).toBe(201);
  const tree = ws.tree();
  await open_with_code(page, ws);
  await start_button(page).click();
  await topic_input(page).fill("합성 중복 시도 주제");
  await slug_input(page).fill("synthetic-dup");
  await submit(page).click();
  const alert = page.getByRole("alert").first();
  await expect(alert).toContainText(/이미|중복/);
  expect(one_line(await alert.innerText())).toBe(true);
  await expect(dialog(page)).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
  expect(ws.slugs()).toEqual(["synthetic-dup"]);
  expect(ws.tree()).toEqual(tree);
  // 이름을 바꾸면 이어서 만들 수 있다
  await slug_input(page).fill("synthetic-dup-2");
  await submit(page).click();
  await expect(page).toHaveURL(/\/p\/synthetic-dup-2\/e\/[0-9]+\/s\/plan\/r\/start$/);
  expect(ws.slugs()).toEqual(["synthetic-dup", "synthetic-dup-2"]);
});

test("5 권한 없음: 서버가 세션을 받아들이지 않으면 한국어 한 줄('권한')로 알리고 아무것도 만들지 않는다", async ({ page }) => {
  ws = await open_empty_home();
  await open_with_code(page, ws);
  await page.evaluate((k) => sessionStorage.setItem(k, JSON.stringify({ session: "synthetic-wrong-session-000000000", projects: {} })), STORE_KEY);
  const tree = ws.tree();
  await page.reload();
  await start_button(page).click();
  await topic_input(page).fill("합성 권한 없음 주제");
  await submit(page).click();
  const alert = page.getByRole("alert").first();
  await expect(alert).toContainText("권한");
  expect(one_line(await alert.innerText())).toBe(true);
  expect(new URL(page.url()).pathname).toBe("/");
  expect(ws.slugs()).toBeNull();
  expect(ws.tree()).toEqual(tree);
});

test("6 코드 없이 연 첫 페이지(북마크·다른 탭): 버튼은 보이고, 누르면 '터미널에서 pes list 로 여세요' 한 줄 — 요청 0, DB·폴더 변화 0", async ({ page }) => {
  ws = await open_empty_home();
  const plain = ws.plain_hub();
  expect(plain).not.toContain("#");
  const tree = ws.tree();
  const seen = watch(page);
  await page.goto(plain);
  await expect(start_button(page)).toBeVisible();
  await start_button(page).click();
  const note = page.getByText(/터미널에서 pes list 로 여세요/);
  await expect(note.first()).toBeVisible();
  expect(one_line(await note.first().innerText())).toBe(true);
  await expect(topic_input(page)).toHaveCount(0);
  await page.waitForTimeout(300);
  const all = await seen.done();
  expect(all.filter((r) => r.url.pathname.startsWith("/api/")), "첫 페이지가 보낸 API 요청 0").toEqual([]);
  expect(await page.evaluate((k) => sessionStorage.getItem(k), STORE_KEY)).toBeNull();
  expect(ws.slugs()).toBeNull();
  expect(ws.tree()).toEqual(tree);
});

test("6 쓴 코드·다른 출처: 같은 주소를 다시 열면(쓴 코드) 세션이 없어 안내만 — 그리고 localhost 로 열면 교환이 거절돼 안내만, 만들어지지 않는다", async ({ page, browser }) => {
  ws = await open_empty_home();
  const address = ws.open_hub();
  await page.goto(address);
  await expect(start_button(page)).toBeVisible();
  await expect.poll(() => page.evaluate((k) => sessionStorage.getItem(k) !== null, STORE_KEY)).toBe(true);
  // 쓴 코드: 새 맥락(= 새 탭·세션 저장소 비어 있음)에서 같은 주소
  const again = await browser.newContext({ locale: "ko-KR", timezoneId: "Asia/Seoul" });
  try {
    const p2 = await again.newPage();
    const seen = watch(p2);
    await p2.goto(address);
    await expect(start_button(p2)).toBeVisible();
    await expect.poll(() => new URL(p2.url()).hash).toBe("");
    await start_button(p2).click();
    await expect(p2.getByText(/터미널에서 pes list 로 여세요/).first()).toBeVisible();
    await p2.waitForTimeout(300);
    expect(creates(await seen.done())).toEqual([]);
    expect(await p2.evaluate((k) => sessionStorage.getItem(k), STORE_KEY)).toBeNull();
  } finally {
    await again.close();
  }
  // 낯선 출처(localhost): 교환은 127.0.0.1:<포트> Origin 에서만 된다
  const other = await browser.newContext({ locale: "ko-KR", timezoneId: "Asia/Seoul" });
  try {
    const p3 = await other.newPage();
    const fresh = ws.open_hub();
    const url = new URL(fresh);
    await p3.goto(`http://localhost:${ws.port}/${url.hash}`);
    await expect(start_button(p3)).toBeVisible();
    await expect.poll(() => new URL(p3.url()).hash).toBe("");
    await start_button(p3).click();
    await expect(p3.getByText(/터미널에서 pes list 로 여세요/).first()).toBeVisible();
    expect(await p3.evaluate((k) => sessionStorage.getItem(k), STORE_KEY)).toBeNull();
  } finally {
    await other.close();
  }
  expect(ws.slugs()).toBeNull();
});

test("7 새로 고침해도 같은 탭이면 세션이 남아 만들 수 있다(sessionStorage) — 쿠키·localStorage 에는 없다", async ({ page, context }) => {
  ws = await open_empty_home();
  await open_with_code(page, ws);
  await page.reload();
  await expect(start_button(page)).toBeVisible();
  await start_button(page).click();
  await topic_input(page).fill("합성 새로 고침 뒤 주제");
  await slug_input(page).fill("synthetic-reload");
  await submit(page).click();
  await expect(page).toHaveURL(/\/p\/synthetic-reload\/e\/[0-9]+\/s\/plan\/r\/start$/);
  expect(ws.slugs()).toEqual(["synthetic-reload"]);
  expect(await context.cookies()).toEqual([]);
});

test("8 첫 페이지 디자인 불변: 프로젝트가 있는 홈의 목록(제목·KPI·필터·표 행·열기 링크)이 그대로이고, 버튼이 더해졌을 뿐이다", async ({ page }) => {
  ws = await open_empty_home();
  expect((await ws.api_create({ slug: "synthetic-existing", topic: "합성 기존 프로젝트", owner_display_name: "합성 소유자" }, "seed-1")).status).toBe(201);
  ws.plain_hub();
  await page.goto(`${ws.base}/`);
  await expect(page.getByRole("heading", { name: "프로젝트", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "프로젝트 목록", level: 2 })).toBeVisible();
  await expect(page.locator(".kpi")).toHaveCount(4);
  await expect(page.getByRole("navigation", { name: "프로젝트 필터" }).getByRole("button")).toHaveCount(4);
  const row = page.locator(".project-table tbody tr");
  await expect(row).toHaveCount(1);
  await expect(row.locator(".name b")).toHaveText("합성 기존 프로젝트");
  await expect(row.locator(".name small")).toContainText("synthetic-existing");
  await expect(row.getByRole("link", { name: /열기/ })).toHaveAttribute("href", "synthetic-existing/index.html");
  await expect(page.locator(".foot")).toContainText("진행 상태는 단계 이름 아래에 표시됩니다.");
  await expect(start_button(page)).toBeVisible();
});

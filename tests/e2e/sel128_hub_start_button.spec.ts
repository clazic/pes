// SEL-128 첫 페이지(프로젝트 목록)의 '프로젝트 시작' 버튼 — Playwright. SEL-130 에서 대화 상자 시험은 /new 흐름(sel130 spec) 또는 아래의 이동 시험으로 옮겼다.
//
// 세션 방식 (leader 결정, 안 C — 서버 변경 0, 새 신뢰 경로 없음. 자세한 계약은 tests/test_sel128_hub_start.test.ts 머리말):
//   - `pes hub --open` 이 첫 페이지 주소 http://127.0.0.1:<포트>/#code=<1회용 코드> 를 준다(PES_NO_BROWSER=1 이면 출력). 코드는 빈 projects({})용.
//   - 첫 페이지 JS 는 렌더·요청 전에 history.replaceState 로 #code 를 지우고 POST /api/v1/app-session {code} 를 한 번(credentials omit·재시도 없음) 보낸다.
//     세션은 같은 탭 sessionStorage 의 `pes-app-handoff` = {session, projects} 에만 둔다(앱과 같은 키) — 주소·HTML·콘솔·쿠키·localStorage 에 없다.
//   - 코드 없이 연 첫 페이지: 버튼은 보이고, 누르면 '터미널에서 pes list 로 여세요' 안내 한 줄(요청 0, DB·폴더 변화 0).
// 화면 계약(접근 이름으로 찾는다 — 구현은 이 이름을 따른다):
//   - 버튼: role=button 이름 '프로젝트 시작'. (SEL-130) 누르면 대화 상자 없이 같은 탭이 앱 /new 로 간다 — 이동 직전에만 세션을 sessionStorage 에 넘긴다.
//     프로젝트를 만드는 화면(주제·이름·만들기)과 만들기 요청은 앱 /new 에 있고 tests/e2e/sel130_new_project_path.spec.ts 가 본다. 이 파일은 첫 페이지 쪽 성질만 본다.
// 앞 조건: `cd app && npm ci && npm run build` (app/dist). 없으면 건너뛰지 않고 실패한다. 실제 홈 0 — 전부 임시 HOME 의 합성 홈.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

import { CREATE, EXCHANGE, REPO, STORE_KEY, open_empty_home, type EmptyHome } from "./helpers/sel128_home.ts";

const DIST = join(REPO, "app", "dist");
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
  // done() 뒤에 오는 요청은 모으지 않는다 — 모으면 테스트가 끝날 때 allHeaders 가 "Test ended" 로 거절돼 시험이 흔들린다(sel85 C2, Windows CI). done() 전의 요청은 모두 기다려 단언한다
  let closed = false;
  page.on("request", (r) => {
    if (closed) return;
    pending.push(r.allHeaders().then((headers) => ({ url: new URL(r.url()), method: r.method(), headers, body: r.postData(), frame_url: r.frame().url() })));
  });
  return {
    done: async (): Promise<Seen[]> => {
      closed = true;
      return Promise.all(pending);
    },
  };
}
const creates = (all: Seen[]): Seen[] => all.filter((r) => r.url.pathname === CREATE);
const start_button = (page: Page) => page.getByRole("button", { name: "프로젝트 시작" });

async function open_with_code(page: Page, home: EmptyHome): Promise<void> {
  const exchanged = page.waitForResponse((r) => new URL(r.url()).pathname === EXCHANGE);
  await page.goto(home.open_hub());
  await expect(start_button(page)).toBeVisible();
  // 교환이 끝나 세션이 첫 페이지 메모리에 들어올 때까지(세션은 sessionStorage 에 두지 않는다 — 버튼은 교환이 끝난 뒤에야 열린다)
  expect((await exchanged).status()).toBe(200);
}

test("1 빈 홈: 코드로 연 첫 페이지에 버튼이 보이고 — 조각은 지워지고, 교환은 한 번(세션 헤더·조각 없이), 세션은 메모리에만(sessionStorage 에도 없다)", async ({ page, context }) => {
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
  const exchanged = page.waitForResponse((r) => new URL(r.url()).pathname === EXCHANGE);
  await page.goto(address);
  await expect(page.getByRole("heading", { name: "프로젝트", level: 1 })).toBeVisible();
  await expect(start_button(page)).toBeVisible();
  await expect(page.getByText("해당하는 프로젝트가 없습니다.")).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  expect(page.url()).toBe(`${ws.base}/`);
  expect((await exchanged).status()).toBe(200);
  // 세션은 첫 페이지 JS 메모리에만 있다: 교환이 끝났어도(= 세션을 받았다) 누르기 전에는 sessionStorage 에 없다(R1-1)
  expect(await page.evaluate((k) => sessionStorage.getItem(k), STORE_KEY)).toBeNull();
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
  await expect(page.locator("dialog")).toHaveCount(0);
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
  const exchanged = page.waitForResponse((r) => new URL(r.url()).pathname === EXCHANGE);
  await page.goto(address);
  await expect(start_button(page)).toBeVisible();
  expect((await exchanged).status()).toBe(200);
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

test("7 새로 고침하면 세션이 없다(메모리에만 있었다): 안내 한 줄만 — sessionStorage·쿠키·localStorage 에 세션 없음, 만들어지지 않는다", async ({ page, context }) => {
  ws = await open_empty_home();
  await open_with_code(page, ws);
  await page.reload();
  await expect(start_button(page)).toBeVisible();
  await start_button(page).click();
  await expect(page.getByText(/터미널에서 pes list 로 여세요/).first()).toBeVisible();
  await expect(page.locator("dialog")).toHaveCount(0);
  expect(await page.evaluate((k) => sessionStorage.getItem(k), STORE_KEY)).toBeNull();
  expect(String(await page.evaluate("JSON.stringify({ ...localStorage })"))).not.toContain(ws.session);
  expect(ws.slugs()).toBeNull();
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

// SEL-128 1차 리뷰 R1-1: 교환한 세션이 첫 페이지 탭의 sessionStorage 에 남으면, 같은 탭으로 연 sandbox 없는 옛 화면(<slug>/index.html)이 읽는다.
// 세션은 첫 페이지 JS 메모리에만 두고, sessionStorage 에는 '만들기 성공 → 앱으로 이동' 직전에만 쓴다.
const LEGACY_PAGE = `<!doctype html><meta charset="utf-8"><title>legacy</title><script>document.title = 'STOLEN:' + String(sessionStorage.getItem('${STORE_KEY}'));</script>`;
function seed_legacy_folder(home: EmptyHome): void {
  const dir = join(home.pes_home, "legacy-y");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "project.json"), "{}");
  writeFileSync(join(dir, "index.html"), LEGACY_PAGE);
}

test("9 교환한 세션은 첫 페이지 메모리에만 — 교환 직후 sessionStorage 에 없고, 같은 탭으로 옛 화면(sandbox 없음)에 가도 읽히지 않는다", async ({ page }) => {
  ws = await open_empty_home();
  seed_legacy_folder(ws);
  const exchanged = page.waitForResponse((r) => new URL(r.url()).pathname === EXCHANGE);
  await page.goto(ws.open_hub());
  expect((await exchanged).status()).toBe(200);
  await expect(start_button(page)).toBeVisible();
  expect(await page.evaluate((k) => sessionStorage.getItem(k), STORE_KEY), "교환 직후 sessionStorage 에 세션이 없다").toBeNull();
  // 같은 탭으로 옛 화면에 간다(= 리뷰 재현)
  await page.goto(`${ws.base}/legacy-y/index.html`);
  await expect(page).toHaveTitle("STOLEN:null");
  expect(await page.evaluate((k) => sessionStorage.getItem(k), STORE_KEY)).toBeNull();
});

test("9 첫 페이지를 떠나기 전(pagehide)에 남아 있는 값은 지워진다 — 앱이 두고 간 값이 첫 페이지에서 옛 화면으로 새지 않는다", async ({ page }) => {
  ws = await open_empty_home();
  seed_legacy_folder(ws);
  await page.goto(ws.plain_hub());
  await expect(start_button(page)).toBeVisible();
  await page.evaluate((k) => sessionStorage.setItem(k, JSON.stringify({ session: "synthetic-left-behind-session-00000", projects: {} })), STORE_KEY);
  await page.goto(`${ws.base}/legacy-y/index.html`);
  await expect(page).toHaveTitle("STOLEN:null");
});


// ───── 이동 시도(버튼 누름 → /new) 쪽 성질. 대화 상자가 있던 시절의 R2-1·R2-3·F1-1·F2-2 시험을 /new 이동으로 옮긴 것 ─────
// /new 요청을 204 로 막으면 이동이 일어나지 않는다 — 세션이 sessionStorage 에 남은 채 굳으면 같은 탭 옛 화면이 읽는다.
async function click_with_blocked_move(page: Page): Promise<void> {
  await page.route("**/new", (route) => route.fulfill({ status: 204 }));
  await open_with_code(page, ws);
  const moved = page.waitForRequest((r) => new URL(r.url()).pathname === "/new");
  await start_button(page).click();
  await moved;
  await expect(start_button(page)).toBeVisible(); // 204 라 첫 페이지에 그대로 머문다
}

// R2-3: 세션을 sessionStorage 에 못 넣는 브라우저(저장 거부)는 이동하지 않고 한 줄로 알린다 — 버튼은 되살아난다
test("9 sessionStorage 에 못 쓰면 /new 로 이동하지 않고 '터미널에서 pes open' 한 줄을 보이며 버튼을 되살린다", async ({ page }) => {
  ws = await open_empty_home();
  await page.addInitScript((k) => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === k) throw new Error("synthetic quota");
      return real.call(this, key, value);
    };
  }, STORE_KEY);
  const asked = [] as string[];
  page.on("request", (r) => asked.push(new URL(r.url()).pathname));
  await open_with_code(page, ws);
  await start_button(page).click();
  await expect(page.getByRole("status").filter({ hasText: "이 브라우저는 세션을 잠깐 넘길 수 없습니다 — 터미널에서 pes open 으로 여세요" })).toBeVisible();
  await expect(start_button(page)).toBeEnabled();
  expect(new URL(page.url()).pathname, "이동하지 않는다").toBe("/");
  expect(asked.includes("/new"), "/new 를 요청하지 않는다").toBe(false);
});

test("9 이동이 안 된 채 bfcache 복귀(pageshow persisted)여도 키를 지우고 버튼을 되살리며 pagehide 정리를 되살린다", async ({ page }) => {
  ws = await open_empty_home();
  seed_legacy_folder(ws);
  await click_with_blocked_move(page);
  // 타이머보다 먼저 bfcache 복귀를 흉내 낸다
  await page.evaluate('window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }))');
  expect(await page.evaluate((k) => sessionStorage.getItem(k), STORE_KEY), "복귀하면 키가 없다").toBeNull();
  await expect(start_button(page)).toBeEnabled();
  // 키가 다시 생겨도(앱이 둔 값) pagehide 가 지운다 = leaving 이 되돌려졌다
  await page.evaluate((k) => sessionStorage.setItem(k, JSON.stringify({ session: "synthetic-left-behind-session-00000", projects: {} })), STORE_KEY);
  await page.goto(`${ws.base}/legacy-y/index.html`);
  await expect(page).toHaveTitle("STOLEN:null");
});

// F2-2: 누른 직후(poll 없이) 옛 화면으로 가는 이동 경로들 — 캡처 처리기가 이동이 시작되기 전에 값을 지운다.
test("F2-2 이동을 기다리는 중 목록의 열기 링크로 Enter 를 눌러 가도 옛 화면은 세션을 읽지 못한다", async ({ page }) => {
  ws = await open_empty_home();
  seed_legacy_folder(ws);
  await click_with_blocked_move(page);
  await page.locator('a[href="legacy-y/index.html"]').evaluate((el) => (el as { focus(): void }).focus());
  await page.keyboard.press("Enter");
  await page.waitForURL(/legacy-y/);
  await expect(page).toHaveTitle("STOLEN:null");
});

test("F2-2 이동을 기다리는 중 ⌘/Ctrl+클릭으로 새 탭을 열어도 새 탭의 sessionStorage 에 세션이 없다", async ({ page, context }) => {
  ws = await open_empty_home();
  seed_legacy_folder(ws);
  await click_with_blocked_move(page);
  const opened = context.waitForEvent("page");
  await page.locator('a[href="legacy-y/index.html"]').click({ modifiers: ["ControlOrMeta"] });
  const tab = await opened;
  await tab.waitForLoadState();
  await expect(tab).toHaveTitle("STOLEN:null");
});

test("F2-2 이동을 기다리는 중 가운데 클릭으로 새 탭을 열어도 새 탭의 sessionStorage 에 세션이 없다", async ({ page, context }) => {
  ws = await open_empty_home();
  seed_legacy_folder(ws);
  await click_with_blocked_move(page);
  const opened = context.waitForEvent("page");
  await page.locator('a[href="legacy-y/index.html"]').click({ button: "middle" });
  const tab = await opened;
  await tab.waitForLoadState();
  await expect(tab).toHaveTitle("STOLEN:null");
});

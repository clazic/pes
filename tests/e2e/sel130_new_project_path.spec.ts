// SEL-130 새 프로젝트 만드는 길을 하나로 — Playwright (tester, 작성 모드). 구현 완료 — 통과가 기대값.
//
// 정한 인터페이스 (이슈 요구사항 + 아래 결정. 구현은 이 이름을 따른다):
//   - 첫 페이지(templates/hub.html)의 버튼 role=button 이름 '프로젝트 시작' 은 그대로. 누르면 대화 상자를 열지 않고 같은 탭에서 앱 `/new` 로 간다.
//   - 주제 미리 채우기는 하지 않는다(결정): 첫 페이지에는 주제 입력이 없고, /new 주소에는 조각·질의(?topic=…)가 없다 — 주제도 URL 에 남기지 않는다.
//   - 세션 전달은 SEL-128 방식 그대로: 첫 페이지 메모리의 세션(1회용 코드 교환으로 받은 것)을 이동 직전에만 같은 탭 sessionStorage `pes-app-handoff`
//     ({session, projects}) 에 쓰고 location.assign('/new') 한다. 앱이 그것을 이어받는다. 세션은 URL·HTML·history·쿠키·localStorage 에 없다.
//   - 이동이 일어나지 않으면(204·취소·실패) SEL-128 처럼 몇 초 뒤 sessionStorage 를 지우고 버튼을 되살린다.
//   - 코드 없이 연 첫 페이지(세션 없음)는 SEL-128 그대로: 누르면 '터미널에서 pes list 로 여세요' 한 줄, 이동 없음, 요청 0.
//   - /new 화면(app/src/features/materials/NewScreen.tsx): 입력 칸 '주제'(필수)·'이름(slug)'(선택, label 에 slug) 과 버튼 '만들기'(form 제출 — Enter 로도 된다).
//     만들기 요청은 앱이 POST /api/v1/projects {slug, topic, owner_display_name} (x-pes-session + Idempotency-Key). 이름을 비우면 앱이 정한다(^[a-z0-9][a-z0-9-]{0,63}$).
//     같은 제출(두 번 누름)은 같은 Idempotency-Key 라 프로젝트 1개. 성공하면 같은 탭이 /p/<slug>/e/<n>/s/plan/r/start 로 간다(그 프로젝트 기획 시작 자리).
//     실패는 role=alert 한국어 한 줄: 주제 없음='주제', 이름 중복='이미'/'중복', 세션 없음='권한'(또는 pes list/open 안내). 실패하면 /new 에 머문다.
//   - 만드는 길은 /new 하나: 서비스되는 첫 페이지 HTML 에 <dialog>·'/api/v1/projects' 요청 코드가 없다(교환 /api/v1/app-session 만 남는다).
// 앞 조건: `cd app && npm ci && npm run build` (app/dist). 없으면 건너뛰지 않고 실패한다. 실제 홈 0 — 전부 임시 HOME 의 합성 홈.
import { request } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

import { CREATE, EXCHANGE, REPO, STORE_KEY, open_empty_home, type EmptyHome } from "./helpers/sel128_home.ts";

const DIST = join(REPO, "app", "dist");
const SLUG_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PLAN_START = /\/p\/[a-z0-9][a-z0-9-]*\/e\/[0-9]+\/s\/plan\/r\/start$/;
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
}
function watch(page: Page) {
  const pending: Promise<Seen>[] = [];
  let closed = false; // done() 뒤 요청은 모으지 않는다(sel85 C2 — 시험이 끝날 때 allHeaders 가 거절돼 흔들린다)
  page.on("request", (r) => {
    if (closed) return;
    pending.push(r.allHeaders().then((headers) => ({ url: new URL(r.url()), method: r.method(), headers, body: r.postData() })));
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
const topic_input = (page: Page) => page.getByLabel(/주제/);
const slug_input = (page: Page) => page.getByLabel(/slug/i);
const make_button = (page: Page) => page.getByRole("button", { name: "만들기", exact: true });

async function open_with_code(page: Page, home: EmptyHome): Promise<void> {
  const exchanged = page.waitForResponse((r) => new URL(r.url()).pathname === EXCHANGE);
  await page.goto(home.open_hub());
  await expect(start_button(page)).toBeVisible();
  expect((await exchanged).status()).toBe(200);
}
/** 빈 홈 → 코드로 연 첫 페이지 → 버튼 → /new 의 만들기 칸까지 */
async function to_new_screen(page: Page, home: EmptyHome): Promise<void> {
  await open_with_code(page, home);
  await start_button(page).click();
  await expect(page).toHaveURL(`${home.base}/new`);
  await expect(page.locator("main [data-screen-title]")).toHaveText("새 프로젝트");
  await expect(topic_input(page)).toBeVisible();
}

test("1 버튼은 대화 상자 없이 같은 탭의 /new 로 간다 — 주소에 조각·질의·세션이 없고, 이동 직전에만 sessionStorage 에 세션이 있다", async ({ page, context }) => {
  ws = await open_empty_home();
  await open_with_code(page, ws);
  expect(await page.evaluate((k) => sessionStorage.getItem(k), STORE_KEY), "누르기 전에는 세션이 sessionStorage 에 없다").toBeNull();
  const pages_before = context.pages().length;
  await start_button(page).click();
  await expect(page).toHaveURL(`${ws.base}/new`);
  expect(context.pages().length, "새 탭을 열지 않는다").toBe(pages_before);
  const u = new URL(page.url());
  expect([u.pathname, u.search, u.hash]).toEqual(["/new", "", ""]);
  expect(page.url()).not.toContain(ws.session);
  await expect(page.locator("dialog")).toHaveCount(0);
  await expect(page.locator("main [data-screen-title]")).toHaveText("새 프로젝트");
  // 앱이 세션을 이어받았다 — 같은 키·같은 세션, 아직 만든 프로젝트는 없다
  const stored = JSON.parse(await page.evaluate((k) => sessionStorage.getItem(k) as string, STORE_KEY));
  expect(stored.session).toBe(ws.session);
  expect(stored.projects).toEqual({});
  expect(ws.slugs()).toBeNull();
});

test("2 빈 홈에서 처음부터 끝까지: 버튼 → /new → 주제 입력·만들기 → 그 프로젝트의 기획 시작 자리 — 만들기 요청은 앱이 하나만 보낸다", async ({ page }) => {
  ws = await open_empty_home();
  await to_new_screen(page, ws);
  const seen = watch(page);
  await topic_input(page).fill("합성 하나로 합친 길 주제");
  await make_button(page).click();
  await expect(page).toHaveURL(PLAN_START);
  const made = creates(await seen.done());
  expect(made, "만들기 요청 하나").toHaveLength(1);
  expect(made[0]!.method).toBe("POST");
  expect(made[0]!.url.origin).toBe(ws.base);
  expect(made[0]!.headers["x-pes-session"]).toBe(ws.session);
  expect(made[0]!.headers["idempotency-key"]).toBeTruthy();
  const body = JSON.parse(made[0]!.body ?? "{}");
  expect(Object.keys(body).sort()).toEqual(["owner_display_name", "slug", "topic"]);
  expect(body.topic).toBe("합성 하나로 합친 길 주제");
  expect(body.slug).toMatch(SLUG_SHAPE);
  expect(typeof body.owner_display_name === "string" && body.owner_display_name !== "").toBe(true);
  expect(new URL(page.url()).pathname.startsWith(`/p/${body.slug}/`)).toBe(true);
  expect(ws.slugs()).toEqual([body.slug]);
  // 그 프로젝트의 기획 시작 화면(합성 예시 연구가 아니다)
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("예시 연구");
  await expect(page.getByRole("navigation", { name: "현재 위치" })).toContainText("합성 하나로 합친 길 주제");
  const stored = JSON.parse(await page.evaluate((k) => sessionStorage.getItem(k) as string, STORE_KEY));
  expect(stored.session).toBe(ws.session);
  expect(Object.keys(stored.projects)).toEqual([body.slug]);
  expect(new URL(page.url()).hash).toBe("");
});

test("2 이름(slug)을 적으면 그 이름으로 만든다 — 열린 주소에도 그 이름", async ({ page }) => {
  ws = await open_empty_home();
  await to_new_screen(page, ws);
  const seen = watch(page);
  await topic_input(page).fill("합성 이름 지정 주제");
  await slug_input(page).fill("synthetic-named-130");
  await make_button(page).click();
  await expect(page).toHaveURL(/\/p\/synthetic-named-130\/e\/[0-9]+\/s\/plan\/r\/start$/);
  expect(JSON.parse(creates(await seen.done())[0]!.body ?? "{}").slug).toBe("synthetic-named-130");
  expect(ws.slugs()).toEqual(["synthetic-named-130"]);
});

test("3 키보드만으로: 첫 페이지 버튼에 초점 → Enter 로 /new → 주제를 쓰고 Enter 로 만들기", async ({ page }) => {
  ws = await open_empty_home();
  await open_with_code(page, ws);
  await start_button(page).focus();
  await expect(start_button(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${ws.base}/new`);
  await topic_input(page).focus();
  await page.keyboard.type("키보드로 만든 합성 주제");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(PLAN_START);
  expect(ws.slugs()).toHaveLength(1);
});

test("4 주제는 필수: 비우거나 공백뿐이면 요청을 보내지 않고 한국어 한 줄로 알린다 — /new 에 머문다, DB·폴더 변화 0", async ({ page }) => {
  ws = await open_empty_home();
  await to_new_screen(page, ws);
  const tree = ws.tree();
  const seen = watch(page);
  await make_button(page).click();
  const alert = page.getByRole("alert").filter({ hasText: "주제" });
  await expect(alert.first()).toBeVisible();
  expect(one_line(await alert.first().innerText())).toBe(true);
  await topic_input(page).fill("   ");
  await make_button(page).click();
  await expect(alert.first()).toBeVisible();
  await page.waitForTimeout(300);
  expect(creates(await seen.done()), "요청 0").toEqual([]);
  expect(new URL(page.url()).pathname).toBe("/new");
  expect(ws.slugs()).toBeNull();
  expect(ws.tree()).toEqual(tree);
});

test("5 멱등: 만들기를 연달아 두 번 눌러도(응답이 늦어도) 요청은 같은 Idempotency-Key 이고 프로젝트는 1개다", async ({ page }) => {
  ws = await open_empty_home();
  await to_new_screen(page, ws);
  await page.route(`**${CREATE}`, async (route) => {
    await new Promise((r) => setTimeout(r, 600));
    await route.continue();
  });
  const seen = watch(page);
  await topic_input(page).fill("합성 두 번 누름 주제");
  await slug_input(page).fill("synthetic-twice-130");
  await make_button(page).click({ noWaitAfter: true });
  await make_button(page).click({ force: true, noWaitAfter: true, timeout: 1000 }).catch(() => undefined); // 두 번째는 막혀 있어도 된다
  await page.keyboard.press("Enter").catch(() => undefined);
  await expect(page).toHaveURL(/\/p\/synthetic-twice-130\/e\/[0-9]+\/s\/plan\/r\/start$/);
  const made = creates(await seen.done());
  expect(made.length).toBeGreaterThanOrEqual(1);
  expect(new Set(made.map((r) => r.headers["idempotency-key"])).size, "모든 요청이 같은 키").toBe(1);
  expect(ws.slugs()).toEqual(["synthetic-twice-130"]);
});

test("6 이름 중복: 한국어 한 줄('이미' 또는 '중복')로 알리고 /new 에 머물며 아무것도 더 만들지 않는다 — 이름을 바꾸면 이어서 만들어진다", async ({ page }) => {
  ws = await open_empty_home();
  expect((await ws.api_create({ slug: "synthetic-dup-130", topic: "합성 먼저 있던 주제", owner_display_name: "합성 소유자" }, "seed-1")).status).toBe(201);
  await to_new_screen(page, ws);
  const tree = ws.tree();
  await topic_input(page).fill("합성 중복 시도 주제");
  await slug_input(page).fill("synthetic-dup-130");
  await make_button(page).click();
  const alert = page.getByRole("alert").filter({ hasText: /이미|중복/ });
  await expect(alert.first()).toBeVisible();
  expect(one_line(await alert.first().innerText())).toBe(true);
  expect(new URL(page.url()).pathname).toBe("/new");
  expect(ws.slugs()).toEqual(["synthetic-dup-130"]);
  expect(ws.tree()).toEqual(tree);
  await slug_input(page).fill("synthetic-dup-130-b");
  await make_button(page).click();
  await expect(page).toHaveURL(/\/p\/synthetic-dup-130-b\/e\/[0-9]+\/s\/plan\/r\/start$/);
  expect(ws.slugs()).toEqual(["synthetic-dup-130", "synthetic-dup-130-b"]);
});

test("7 세션은 어디에도 새지 않는다 — 버튼 → /new → 만들기 → 기획 시작 전 과정의 주소·요청·응답·history·쿠키·localStorage·HTML", async ({ page, context }) => {
  ws = await open_empty_home();
  const secrets = [ws.session, Buffer.from(ws.session).toString("base64"), Buffer.from(ws.session).toString("base64url"), Buffer.from(ws.session).toString("hex")];
  const consoles: string[] = [];
  page.on("console", (m) => consoles.push(m.text()));
  page.on("pageerror", (e) => consoles.push(String(e)));
  const documents: string[] = [];
  const frame_urls: string[] = [];
  page.on("framenavigated", (f) => frame_urls.push(f.url()));
  page.on("response", async (r) => {
    const path = new URL(r.url()).pathname;
    if (path === EXCHANGE || path === CREATE) return; // 교환·만들기 응답은 앱이 받는 값이다(세션을 보내는 쪽은 요청 헤더) — 나머지 문서·자원만 본다
    try {
      documents.push(await r.text(), JSON.stringify(await r.allHeaders()));
    } catch {
      // no body
    }
  });
  const seen = watch(page);
  await to_new_screen(page, ws);
  await topic_input(page).fill("합성 세션 비노출 주제");
  await make_button(page).click();
  await expect(page).toHaveURL(PLAN_START);
  const all = await seen.done();
  for (const secret of secrets) {
    for (const r of all) expect(r.url.href, "요청 주소에 세션 없음").not.toContain(secret);
    for (const u of frame_urls) expect(u).not.toContain(secret);
    expect(page.url()).not.toContain(secret);
    expect(documents.join("\n"), "문서·자원·응답 머리에 세션 없음").not.toContain(secret);
    expect(consoles.join("\n")).not.toContain(secret);
  }
  // 세션 헤더는 같은 출처(origin=base)의 만들기 요청(POST /api/v1/projects)과, 방금 만든 그 프로젝트의 /api/v1/projects/<그 id>/ 아래 읽기·쓰기에만 실린다
  // (만든 뒤 기획 시작 화면을 그리려면 앱이 그 프로젝트의 workspace 를 읽는다). 다른 출처·/api/v1 밖 경로·다른 프로젝트 id·첫 페이지 요청에는 없다.
  const made_id = Object.values(JSON.parse(await page.evaluate((k) => sessionStorage.getItem(k) as string, STORE_KEY)).projects as Record<string, string>)[0];
  expect(typeof made_id === "string" && made_id !== "", "만든 프로젝트 id").toBe(true);
  const own_tree = `/api/v1/projects/${encodeURIComponent(made_id as string)}/`;
  const with_session = all.filter((r) => r.headers["x-pes-session"] !== undefined);
  expect(with_session.length, "세션 헤더가 실린 요청이 있다(만들기 + 읽기)").toBeGreaterThan(0);
  for (const r of with_session) {
    expect(r.url.origin, `세션 헤더는 다른 출처로 가지 않는다: ${r.url.href}`).toBe(ws.base);
    expect(r.url.pathname.startsWith("/api/v1/"), `세션 헤더는 /api/v1 밖으로 가지 않는다: ${r.url.pathname}`).toBe(true);
    expect(r.url.pathname === CREATE || r.url.pathname.startsWith(own_tree), `세션 헤더는 만들기 또는 그 프로젝트 경로뿐: ${r.url.pathname}`).toBe(true);
    if (r.url.pathname === CREATE) expect(r.method).toBe("POST");
  }
  // 첫 페이지(/)·교환 요청에는 세션 헤더가 없다
  for (const r of all.filter((x) => x.url.pathname === "/" || x.url.pathname === EXCHANGE)) expect(r.headers["x-pes-session"], r.url.pathname).toBeUndefined();
  // 모든 앱 이동 주소가 조각·질의 없이 깨끗하다(/new 에 주제도 없다)
  // 단 첫 이동은 터미널이 준 열기 주소(1회용 코드 #code=… — 세션이 아니다)다. 코드는 그 문서가 요청 전에 지우고, 그 뒤 모든 이동 주소는 깨끗하다
  frame_urls.forEach((u, i) => {
    const x = new URL(u);
    if (i === 0) expect(x.hash, u).toMatch(/^#code=[A-Za-z0-9_-]{20,}$/);
    else expect(x.hash, u).toBe("");
    expect(x.search, u).toBe("");
  });
  expect(await context.cookies()).toEqual([]);
  expect(String(await page.evaluate("JSON.stringify({ ...localStorage })"))).not.toContain(ws.session);
  expect(String(await page.evaluate("JSON.stringify({ href: location.href, state: history.state, name: window.name, cookie: document.cookie, referrer: document.referrer })"))).not.toContain(ws.session);
  expect(String(await page.evaluate("document.documentElement.outerHTML"))).not.toContain(ws.session);
  expect(String(await page.evaluate("JSON.stringify(Object.keys(window).filter((k) => /session/i.test(k)))"))).not.toContain(ws.session);
});

test("7 주제도 주소에 남지 않는다 — 첫 페이지에서 /new 로 넘어갈 때와 만든 뒤 열린 주소 모두 질의·조각이 없다", async ({ page }) => {
  ws = await open_empty_home();
  await to_new_screen(page, ws);
  expect([new URL(page.url()).search, new URL(page.url()).hash]).toEqual(["", ""]);
  await topic_input(page).fill("합성주소에남으면안되는주제");
  await slug_input(page).fill("synthetic-topic-url");
  await make_button(page).click();
  await expect(page).toHaveURL(/\/p\/synthetic-topic-url\/e\/[0-9]+\/s\/plan\/r\/start$/);
  expect(decodeURIComponent(page.url())).not.toContain("합성주소에남으면안되는주제");
  expect(page.url()).not.toContain("?");
  expect(page.url()).not.toContain("#");
});

test("8 만드는 길은 /new 하나 — 서비스되는 첫 페이지에는 대화 상자도, 프로젝트 만들기 요청 코드도 없다(교환 코드만 남는다)", async ({ page }) => {
  ws = await open_empty_home();
  const address = ws.plain_hub();
  const html = await (await fetch(address)).text();
  expect(html).toContain("프로젝트 시작"); // 버튼은 그대로
  expect(html).not.toMatch(/<dialog/i);
  expect(html).not.toContain("pes-start-dlg");
  expect(html).not.toContain(CREATE);
  expect(html).not.toMatch(/idempotency-key/i);
  expect(html).toContain(EXCHANGE);
  await page.goto(address);
  await expect(start_button(page)).toBeVisible();
  await expect(page.locator("dialog")).toHaveCount(0);
});

test("9 코드 없이 연 첫 페이지(북마크·다른 탭): 버튼을 눌러도 이동하지 않고 '터미널에서 pes list 로 여세요' 한 줄 — 요청 0, DB·폴더 변화 0", async ({ page }) => {
  ws = await open_empty_home();
  const plain = ws.plain_hub();
  const tree = ws.tree();
  const seen = watch(page);
  await page.goto(plain);
  await start_button(page).click();
  const note = page.getByText(/터미널에서 pes list 로 여세요/);
  await expect(note.first()).toBeVisible();
  expect(one_line(await note.first().innerText())).toBe(true);
  await page.waitForTimeout(300);
  expect(new URL(page.url()).pathname).toBe("/");
  expect((await seen.done()).filter((r) => r.url.pathname.startsWith("/api/")), "첫 페이지가 보낸 API 요청 0").toEqual([]);
  expect(await page.evaluate((k) => sessionStorage.getItem(k), STORE_KEY)).toBeNull();
  expect(ws.slugs()).toBeNull();
  expect(ws.tree()).toEqual(tree);
});

test("9 다른 출처(localhost)로 연 첫 페이지: 교환이 거절돼 세션이 없으니 누르면 안내만 — 이동·만들기 없음", async ({ browser }) => {
  ws = await open_empty_home();
  const other = await browser.newContext({ locale: "ko-KR", timezoneId: "Asia/Seoul" });
  try {
    const p = await other.newPage();
    const fresh = new URL(ws.open_hub());
    await p.goto(`http://localhost:${ws.port}/${fresh.hash}`);
    await expect(start_button(p)).toBeVisible();
    await expect.poll(() => new URL(p.url()).hash).toBe("");
    await start_button(p).click();
    await expect(p.getByText(/터미널에서 pes list 로 여세요/).first()).toBeVisible();
    expect(new URL(p.url()).pathname).toBe("/");
    expect(await p.evaluate((k) => sessionStorage.getItem(k), STORE_KEY)).toBeNull();
  } finally {
    await other.close();
  }
  expect(ws.slugs()).toBeNull();
});

test("9 다른 출처의 만들기 요청(Origin 이 127.0.0.1:<포트> 가 아님)은 서버가 거절한다 — 아무것도 만들어지지 않는다", async () => {
  ws = await open_empty_home();
  const tree = ws.tree();
  for (const origin of ["http://evil.example", `http://127.0.0.1:${ws.port + 1}`]) {
    const status = await new Promise<number>((done, reject) => {
      const body = JSON.stringify({ slug: "synthetic-foreign", topic: "합성 다른 출처 주제", owner_display_name: "합성 소유자" });
      const req = request(
        { host: "127.0.0.1", port: ws.port, path: CREATE, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), origin, "x-pes-session": ws.session, "idempotency-key": "foreign-1" } },
        (res) => {
          res.resume();
          res.on("end", () => done(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    expect(status, `Origin ${origin}`).toBeGreaterThanOrEqual(400);
    expect(status, `Origin ${origin}`).toBeLessThan(500);
  }
  expect(ws.slugs()).toBeNull();
  expect(ws.tree()).toEqual(tree);
});

test("10 세션 없이 직접 연 /new(주소 직접 입력·북마크): 화면은 열리지만 만들기는 한국어 한 줄('권한' 또는 pes list/open 안내)로 막히고 요청 0 — 아무것도 만들지 않는다", async ({ page }) => {
  ws = await open_empty_home();
  ws.plain_hub();
  const tree = ws.tree();
  const seen = watch(page);
  await page.goto(`${ws.base}/new`);
  await expect(page.locator("main [data-screen-title]")).toHaveText("새 프로젝트");
  await expect(topic_input(page)).toBeVisible();
  await topic_input(page).fill("합성 세션 없는 주제");
  await make_button(page).click();
  const alert = page.getByRole("alert").filter({ hasText: /권한|pes list|pes open/ });
  await expect(alert.first()).toBeVisible();
  expect(one_line(await alert.first().innerText())).toBe(true);
  await page.waitForTimeout(300);
  expect(creates(await seen.done()), "세션이 없으면 만들기 요청을 보내지 않는다").toEqual([]);
  expect(new URL(page.url()).pathname).toBe("/new");
  expect(ws.slugs()).toBeNull();
  expect(ws.tree()).toEqual(tree);
});

test("11 서버가 세션을 받아들이지 않으면 /new 가 한국어 한 줄('권한')로 알리고 아무것도 만들지 않는다", async ({ page }) => {
  ws = await open_empty_home();
  // 교환 응답을 서버가 모르는 세션으로 바꿔 돌려준다 — 첫 페이지는 그 세션을 /new 로 넘기고, 앱은 그 세션으로 만들기를 요청하고, 서버는 받아들이지 않는다
  await page.route(`**${EXCHANGE}`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { session: "synthetic-wrong-session-000000000", projects: {} } }) }));
  await to_new_screen(page, ws);
  const tree = ws.tree();
  await topic_input(page).fill("합성 권한 없음 주제");
  await make_button(page).click();
  const alert = page.getByRole("alert").filter({ hasText: "권한" });
  await expect(alert.first()).toBeVisible();
  expect(one_line(await alert.first().innerText())).toBe(true);
  expect(new URL(page.url()).pathname).toBe("/new");
  expect(ws.slugs()).toBeNull();
  expect(ws.tree()).toEqual(tree);
});

// SEL-128 R2-1 유지: 앱 이동이 일어나지 않는 길(204·취소·실패)이면 sessionStorage 에 남은 세션을 지우고 버튼을 되살린다 — 같은 탭 옛 화면(sandbox 없음)이 읽지 못한다.
const LEGACY_PAGE = `<!doctype html><meta charset="utf-8"><title>legacy</title><script>document.title = 'STOLEN:' + String(sessionStorage.getItem('${STORE_KEY}'));</script>`;
function seed_legacy_folder(home: EmptyHome): void {
  const dir = join(home.pes_home, "legacy-y");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "project.json"), "{}");
  writeFileSync(join(dir, "index.html"), LEGACY_PAGE);
}

test("12 /new 로 가는 이동이 막히면(204) 몇 초 뒤 sessionStorage 를 지우고 버튼을 되살린다 — 같은 탭으로 옛 화면에 가도 세션이 읽히지 않는다", async ({ page }) => {
  ws = await open_empty_home();
  seed_legacy_folder(ws);
  await page.route("**/new", (route) => route.fulfill({ status: 204 }));
  await open_with_code(page, ws);
  const moved = page.waitForRequest((r) => new URL(r.url()).pathname === "/new");
  await start_button(page).click();
  await moved;
  await expect(start_button(page)).toBeVisible(); // 204 라 첫 페이지에 머문다
  await expect
    .poll(async () => page.evaluate((k) => sessionStorage.getItem(k), STORE_KEY), { timeout: 8000, message: "이동이 안 되면 키를 지운다" })
    .toBeNull();
  await expect(start_button(page)).toBeEnabled({ timeout: 8000 });
  await expect(page.getByRole("status").filter({ hasText: /다시/ }).first()).toBeVisible(); // 다시 눌러 달라는 한 줄
  expect(ws.slugs()).toBeNull();
  await page.goto(`${ws.base}/legacy-y/index.html`);
  await expect(page).toHaveTitle("STOLEN:null");
});

test("12 첫 페이지를 떠나는 옛 화면 링크(목록의 열기 →)로 가면 이동 전에 값이 지워진다 — 버튼을 누른 직후 다른 곳으로 가도 옛 화면은 세션을 읽지 못한다", async ({ page }) => {
  ws = await open_empty_home();
  seed_legacy_folder(ws);
  await page.route("**/new", (route) => route.fulfill({ status: 204 }));
  await open_with_code(page, ws);
  const moved = page.waitForRequest((r) => new URL(r.url()).pathname === "/new");
  await start_button(page).click();
  await moved;
  await page.locator('a[href="legacy-y/index.html"]').click();
  await page.waitForURL(/legacy-y/);
  await expect(page).toHaveTitle("STOLEN:null");
});

test("13 /new 에서 새로 고쳐도 같은 탭이라 세션을 이어받아 만들 수 있다 — 주소는 그대로 /new", async ({ page }) => {
  ws = await open_empty_home();
  await to_new_screen(page, ws);
  await page.reload();
  await expect(page).toHaveURL(`${ws.base}/new`);
  await topic_input(page).fill("합성 새로 고침 뒤 주제");
  await slug_input(page).fill("synthetic-after-reload");
  await make_button(page).click();
  await expect(page).toHaveURL(/\/p\/synthetic-after-reload\/e\/[0-9]+\/s\/plan\/r\/start$/);
  expect(ws.slugs()).toEqual(["synthetic-after-reload"]);
});

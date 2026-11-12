// SEL-81 U1a — 작업 공간 앱 셸 e2e (Playwright, 빌드한 앱 + vite preview). 구현 전이므로 실패가 정상(앱 화면이 없다).
// 계약(이름·합성 fixture)은 src/test/contract.ts. 픽셀 기준선 없음 — 위치·겹침·초점·요청만 본다.
import { expect, test, type Page } from "@playwright/test";
import { AREAS, CURRENT, NAMES, PAST, SHELL, STAGE_START, WIDTHS, url } from "../src/test/contract";

const HEIGHT = 800;

async function open(page: Page, path: string, width: number = WIDTHS.wide1440, height = HEIGHT) {
  await page.setViewportSize({ width, height });
  await page.goto(path);
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
}

/** data-area 영역 중 실제로 보이는 것(크기 있음·display/visibility 숨김 아님)의 위치 */
async function visibleAreas(page: Page) {
  return page.evaluate((names) => {
    const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
    for (const n of names) {
      const el = document.querySelector<HTMLElement>(`[data-area="${n}"]`);
      if (!el) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (cs.display === "none" || cs.visibility === "hidden" || r.width < 2 || r.height < 2) continue;
      out[n] = { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    return out;
  }, [...AREAS]);
}

async function expectNoBreakage(page: Page, expectedCount: number) {
  const areas = await visibleAreas(page);
  expect(Object.keys(areas).length, `보이는 영역: ${Object.keys(areas)}`).toBe(expectedCount);
  const list = Object.entries(areas);
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const [na, a] = list[i]!;
      const [nb, b] = list[j]!;
      const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1;
      expect(overlap, `${na} 와 ${nb} 가 겹침`).toBe(false);
    }
  const sizes = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, win: window.innerWidth }));
  expect(sizes.doc, "가로 스크롤").toBeLessThanOrEqual(sizes.win + 1);
  expect(sizes.body, "가로 스크롤(body)").toBeLessThanOrEqual(sizes.win + 1);
  // 영역이 화면 밖으로 나가지 않는다
  for (const [n, r] of list) expect(r.x + r.w, `${n} 오른쪽이 화면 밖`).toBeLessThanOrEqual(sizes.win + 1);
}

/** 단계·라운드 나무 = 사이드바 연구 흐름 nav (최종 리뷰 필수 1(d)) */
const flow = (page: Page) => page.getByRole("navigation", { name: SHELL.sidebarNav });

test.describe("열 배치(≥1280 사이드바|본문|질문, <1280 한 열) · 고정 헤더", () => {
  for (const [label, width, count] of [
    ["1366", WIDTHS.wide1366, 2],
    ["1440", WIDTHS.wide1440, 2],
    ["중간 1100", WIDTHS.mid, 1],
    ["200% 확대(1366→683)", WIDTHS.zoom200of1366, 1],
    ["200% 확대(1440→720)", WIDTHS.zoom200of1440, 1],
  ] as const) {
    test(`${label}px: 보이는 영역 ${count}개, 겹침·가로 스크롤 없음`, async ({ page }) => {
      await open(page, CURRENT, width);
      await expectNoBreakage(page, count);
    });
  }

  test("1영역에서는 view 가 고른 하나만 보인다(body·ask 각각) — 모르는 값 nav 는 본문", async ({ page }) => {
    for (const v of ["body", "ask"] as const) {
      await open(page, `${CURRENT}?view=${v}`, WIDTHS.zoom200of1366);
      const areas = await visibleAreas(page);
      expect(Object.keys(areas), `view=${v}`).toEqual([v]);
      await expectNoBreakage(page, 1);
    }
  });

  test("900~1279 도 한 열이다(2영역 없음) — view 기본은 본문, view=ask 면 질문, view=nav 는 본문", async ({ page }) => {
    await open(page, CURRENT, WIDTHS.mid);
    expect(Object.keys(await visibleAreas(page))).toEqual(["body"]);
    await open(page, `${CURRENT}?view=ask`, WIDTHS.mid);
    expect(Object.keys(await visibleAreas(page))).toEqual(["ask"]);
    await open(page, `${CURRENT}?view=nav`, WIDTHS.mid);
    expect(Object.keys(await visibleAreas(page))).toEqual(["body"]);
  });

  test("머리줄은 고정이다 — 긴 스크롤 뒤에도 맨 위, 초점 받은 질문이 머리줄에 가리지 않는다", async ({ page }) => {
    await open(page, `${CURRENT}?view=ask`, WIDTHS.wide1366, 500);
    const header = page.locator("header").first();
    await page.mouse.wheel(0, 900);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const top = await header.evaluate((h) => h.getBoundingClientRect().top);
    expect(top).toBeLessThanOrEqual(1);
    expect(top).toBeGreaterThanOrEqual(-1);
    await page.locator("#q-22").focus();
    const [hb, qt] = await Promise.all([header.evaluate((h) => h.getBoundingClientRect().bottom), page.locator("#q-22").evaluate((e) => e.getBoundingClientRect().top)]);
    expect(qt).toBeGreaterThanOrEqual(hb - 1);
  });

  test("단계/라운드 표시·과거/현재 구분·단계 시작이 1366 사이드바 나무에서 보인다", async ({ page }) => {
    await open(page, CURRENT, WIDTHS.wide1366);
    const nav = flow(page);
    await expect(nav).toBeVisible();
    for (const t of [/기획/, /조사/, /분석/, /승인됨/, /현재 진행/, /시작 전/, /단계 시작/]) await expect(nav).toContainText(t);
    await expect(nav.locator('a[aria-current="page"]')).toHaveCount(1);
    await expect(page.getByRole("navigation", { name: "단계와 라운드" }), "옛 열은 없다").toHaveCount(0);
    await open(page, url("research", 1), WIDTHS.wide1366);
    await expect(page.getByRole("main")).toContainText("지난 라운드");
    await expect(page.getByRole("main")).toContainText("보는 중");
    await expect(flow(page)).toContainText("현재 진행");
    await open(page, STAGE_START, WIDTHS.wide1366);
    await expect(page.locator("main [data-screen-title]")).toContainText("조사 단계 시작");
    await expect(page.locator("body")).not.toContainText(/\bR0\b/);
  });
});

test.describe("URL — 새로고침·뒤로/앞으로·딥링크가 같은 화면·같은 초점", () => {
  const focusedId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? "");

  test("딥링크 focus=q-22 → 그 요소에 초점, 새로고침 뒤에도 같다", async ({ page }) => {
    await open(page, `${CURRENT}?view=ask&focus=q-22`);
    await expect.poll(() => focusedId(page)).toBe("q-22");
    await page.reload();
    await expect(page.locator("main [data-screen-title]")).toBeVisible();
    await expect.poll(() => focusedId(page)).toBe("q-22");
    expect(new URL(page.url()).searchParams.get("view")).toBe("ask");
  });

  test("질문 영역에서 Tab 으로 q-22 에 가면 URL focus 가 따라가고, 새로고침해도 같은 초점", async ({ page }) => {
    await open(page, `${CURRENT}?view=ask`);
    await page.locator("#q-21").focus();
    await page.keyboard.press("Tab");
    // q-21 다음 Tab 들 중 q-22 에 닿을 때까지
    for (let i = 0; i < 30 && (await focusedId(page)) !== "q-22"; i++) await page.keyboard.press("Tab");
    expect(await focusedId(page)).toBe("q-22");
    await expect.poll(() => new URL(page.url()).searchParams.get("focus")).toBe("q-22");
    await page.reload();
    await expect.poll(() => focusedId(page)).toBe("q-22");
  });

  test("라운드를 옮겼다가 뒤로 → 앞으로 가면 각 화면과 초점이 돌아온다", async ({ page }) => {
    await open(page, `${CURRENT}?view=ask&focus=q-21`);
    await expect.poll(() => focusedId(page)).toBe("q-21");
    await flow(page).locator(`a[href="${url("research", 1)}"]`).first().click();
    await expect(page.locator("main [data-screen-title]")).toContainText("조사 R1");
    await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute("data-screen-title"))).toBe(true);
    await page.goBack();
    await expect(page.locator("main [data-screen-title]")).toContainText("조사 R2");
    await expect.poll(() => focusedId(page)).toBe("q-21");
    await page.goForward();
    await expect(page.locator("main [data-screen-title]")).toContainText("조사 R1");
  });

  test("peek·print 딥링크: 새로고침해도 같은 화면, 뒤로 가기로 닫힌다", async ({ page }) => {
    await open(page, `${CURRENT}?peek=q-21`);
    await expect(page.getByRole("dialog", { name: NAMES.peek })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("dialog", { name: NAMES.peek })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: NAMES.peek })).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has("peek")).toBe(false);
    await open(page, `${CURRENT}?print=1`);
    await expect(page.getByRole("region", { name: NAMES.print })).toBeVisible();
  });

  test("깊은 주소는 서버가 앱으로 되돌려 준다(SPA 되돌림) — 없는 라운드는 찾을 수 없음 화면", async ({ page }) => {
    await page.goto(url("research", 0));
    await expect(page.getByText(/찾을 수 없/)).toBeVisible();
  });
});

test.describe("키보드만으로", () => {
  test("건너뛰기 링크 → 단계 → 라운드 → 질문에 닿고 Tab 덫·초점 상실이 없다", async ({ page }) => {
    await open(page, `${CURRENT}?view=ask`, WIDTHS.wide1440);
    const seen: string[] = [];
    let first = "";
    for (let i = 0; i < 200; i++) {
      await page.keyboard.press("Tab");
      const d = await page.evaluate(() => {
        const e = document.activeElement;
        if (!e || e === document.body || e === document.documentElement) return null;
        return { key: `${e.tagName}#${e.id}|${e.getAttribute("href") ?? ""}|${(e.textContent ?? "").trim().slice(0, 24)}`, inNav: !!e.closest('nav[aria-label*="연구 흐름"]'), id: e.id, text: (e.textContent ?? "").trim() };
      });
      if (!d) break; // 문서 끝에서 브라우저 바깥으로 나갔다 = 덫 없음
      if (i === 0) first = d.text;
      seen.push(d.key + (d.inNav ? "|NAV" : ""));
    }
    expect(first).toContain(NAMES.skip);
    expect(new Set(seen).size, `반복된 초점이 있다(덫): ${seen.join(" > ")}`).toBe(seen.length);
    expect(seen.length).toBeLessThan(200);
    expect(seen.some((s) => s.includes("NAV") && /기획|조사|분석/.test(s))).toBe(true);
    expect(seen.some((s) => s.includes("NAV") && /R[12]/.test(s))).toBe(true);
    expect(seen.some((s) => s.includes("#q-21"))).toBe(true);
    expect(seen.some((s) => s.includes("#q-22"))).toBe(true);
  });

  test("키보드로 라운드 링크를 열면 새 화면 제목으로 초점이 가고 body 로 빠지지 않는다", async ({ page }) => {
    await open(page, CURRENT, WIDTHS.wide1366);
    const target = url("research", 1);
    for (let i = 0; i < 150 && (await page.evaluate(() => document.activeElement?.getAttribute("href") ?? "")) !== target; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("href"))).toBe(target);
    await page.keyboard.press("Enter");
    await expect(page.locator("main [data-screen-title]")).toContainText("조사 R1");
    await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute("data-screen-title"))).toBe(true);
  });

  test("200% 확대(683px) 1영역에서도 키보드로 보기를 바꿔 질문에 닿는다", async ({ page }) => {
    await open(page, CURRENT, WIDTHS.zoom200of1366);
    const group = page.getByRole("radiogroup", { name: NAMES.viewGroup });
    await group.getByRole("radio", { name: NAMES.viewAsk }).focus();
    await page.keyboard.press("Space");
    await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("ask");
    await expect(page.locator("#q-21")).toBeVisible();
    await page.locator("#q-21").focus();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("q-21");
  });

  test("미리보기: 열면 대화 상자, Esc 로 닫으면 연 단추로 초점", async ({ page }) => {
    await open(page, `${CURRENT}?view=ask`);
    const opener = page.getByRole("button", { name: NAMES.peekOpener }).first();
    await opener.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: NAMES.peek })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: NAMES.peek })).toHaveCount(0);
    await expect(opener).toBeFocused();
  });
});

test.describe("모바일 폭 — 읽기·답·의견 응답·오류 확인·인쇄 미리보기·복사 대안만", () => {
  test.describe("휴대폰(390, 터치)", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("편집·첨언 작성은 막히고 이유가 보인다, 나머지는 켜져 있다, 가로 스크롤 없음", async ({ page }) => {
      await page.goto(`${CURRENT}?view=ask`);
      await expect(page.locator("main [data-screen-title]")).toBeVisible();
      const edit = page.getByRole("complementary", { name: NAMES.ask }).getByRole("button", { name: NAMES.edit });
      await expect(edit).toHaveAttribute("aria-disabled", "true");
      const reasonId = await edit.getAttribute("aria-describedby");
      expect(reasonId).toBeTruthy();
      await expect(page.locator(`[id="${reasonId!.split(" ")[0]}"]`)).toContainText("데스크톱");
      await edit.click({ force: true });
      await expect(page.getByRole("dialog")).toHaveCount(0);

      const answer = page.getByRole("complementary", { name: NAMES.ask }).getByRole("textbox", { name: /답/ }).first();
      await expect(answer).toBeEnabled();
      await answer.fill("합성 답");
      await expect(answer).toHaveValue("합성 답");
      await expect(page.getByRole("complementary", { name: NAMES.ask }).getByRole("textbox", { name: /의견/ }).first()).toBeEnabled();

      await page.goto(`${CURRENT}?view=body`);
      await expect(page.locator("main [data-screen-title]")).toBeVisible();
      await expect(page.getByRole("button", { name: NAMES.annotate })).toHaveAttribute("aria-disabled", "true");
      for (const n of [NAMES.print, NAMES.copy, NAMES.ackError]) await expect(page.getByRole("button", { name: n })).not.toHaveAttribute("aria-disabled", "true");
      const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, i: window.innerWidth }));
      expect(w.s).toBeLessThanOrEqual(w.i + 1);
    });

    test("누르는 곳은 44px 이상이다(답·의견·인쇄·복사)", async ({ page }) => {
      await page.goto(`${CURRENT}?view=body`);
      await expect(page.locator("main [data-screen-title]")).toBeVisible();
      for (const n of [NAMES.print, NAMES.copy, NAMES.ackError]) {
        const box = await page.getByRole("button", { name: n }).boundingBox();
        expect(box!.height, n).toBeGreaterThanOrEqual(43.5);
      }
    });

    test("인쇄 미리보기 단추가 print 영역을 연다(window.print 는 저절로 불리지 않음)", async ({ page }) => {
      await page.addInitScript(() => {
        (window as unknown as { __printed: number }).__printed = 0;
        window.print = () => { (window as unknown as { __printed: number }).__printed++; };
      });
      await page.goto(`${CURRENT}?view=body`);
      await page.getByRole("button", { name: NAMES.print }).click();
      await expect(page.getByRole("region", { name: NAMES.print })).toBeVisible();
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(0);
    });
  });

  test("데스크톱 200% 확대(683px, 마우스)는 폭만으로 도구를 숨기지 않는다", async ({ page }) => {
    await open(page, `${CURRENT}?view=ask`, WIDTHS.zoom200of1366);
    await expect(page.getByRole("complementary", { name: NAMES.ask }).getByRole("button", { name: NAMES.edit })).not.toHaveAttribute("aria-disabled", "true");
  });

  test("320px 에서도 가로 스크롤이 없다", async ({ page }) => {
    for (const v of ["nav", "body", "ask"]) {
      await open(page, `${CURRENT}?view=${v}`, 320, 640);
      const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, i: window.innerWidth }));
      expect(w.s, `view=${v}`).toBeLessThanOrEqual(w.i + 1);
    }
  });
});

test.describe("네트워크 요청 0 (가짜 클라이언트 외)", () => {
  test("화면을 열고 만지는 동안 fetch·XHR·WebSocket·EventSource·ping 0, 다른 출처 0", async ({ page, baseURL }) => {
    const bad: string[] = [];
    const origin = new URL(baseURL!).origin;
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["fetch", "xhr", "websocket", "eventsource", "ping", "other"].includes(type) && !req.url().startsWith(`${origin}/@`)) bad.push(`${type} ${req.url()}`);
      if (!req.url().startsWith(`${origin}/`) && !req.url().startsWith("data:") && !req.url().startsWith("blob:")) bad.push(`외부 ${req.url()}`);
    });
    page.on("websocket", (ws) => bad.push(`websocket ${ws.url()}`));
    for (const path of [CURRENT, PAST, STAGE_START, `${CURRENT}?view=ask&peek=q-21`, `${CURRENT}?print=1`]) {
      await open(page, path, WIDTHS.wide1366);
      await flow(page).getByRole("link").first().hover();
      await page.keyboard.press("Tab");
    }
    await page.waitForTimeout(500);
    expect(bad).toEqual([]);
  });
});

// SEL-81 U1a (최종 리뷰 1/2 Opus 반영) — 실제 Chromium 에서만 보이는 것: 열 배치·폭 · 사이드바 나무 · 쿠키 0 · 테마 · 오류 확인 초점.
// 계약은 src/test/contract.ts(설계 12.9). 구현 전/수정 전에는 실패가 정상.
import { expect, test, type Page } from "@playwright/test";
import { ASK_WIDTH, CURRENT, MAIN_MIN_REM, NAMES, REMOVED, SHELL, SIDEBAR_STORAGE_KEY, WIDTHS, url } from "../src/test/contract";

async function open(page: Page, path: string, width: number, height = 800) {
  await page.setViewportSize({ width, height });
  await page.goto(path);
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
}
const sidebar = (page: Page) => page.getByRole("navigation", { name: SHELL.sidebarNav });
const main = (page: Page) => page.getByRole("main");
const ask = (page: Page) => page.getByRole("complementary", { name: NAMES.ask });
const rootPx = (page: Page) => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));

test.describe("필수 1(d) — ≥1280: 사이드바 | 본문 | 질문, 단계·라운드 열 없음, 본문이 좁아지지 않는다", () => {
  for (const [label, width, askW] of [
    ["1280", 1280, ASK_WIDTH.at1280],
    ["1366", WIDTHS.wide1366, ASK_WIDTH.at1280],
    ["1440", WIDTHS.wide1440, ASK_WIDTH.at1440],
  ] as const) {
    test(`${label}: 왼→오 사이드바·본문·질문, 겹침 없음, 질문 폭 ${askW}, 본문 폭 ≥ ${MAIN_MIN_REM}rem(사이드바 펼침)`, async ({ page }) => {
      await open(page, CURRENT, width);
      await expect(sidebar(page)).toHaveCount(1);
      await expect(page.getByRole("navigation", { name: REMOVED.navName })).toHaveCount(0);
      await expect(page.locator(`[data-area="${REMOVED.navArea}"]`)).toHaveCount(0);
      const [s, m, a] = [await sidebar(page).boundingBox(), await main(page).boundingBox(), await ask(page).boundingBox()];
      expect(s && m && a, "세 상자").toBeTruthy();
      expect(s!.x + s!.width, "사이드바 오른쪽 ≤ 본문 왼쪽").toBeLessThanOrEqual(m!.x + 1);
      expect(m!.x + m!.width, "본문 오른쪽 ≤ 질문 왼쪽").toBeLessThanOrEqual(a!.x + 1);
      expect(a!.x + a!.width, "질문 오른쪽 ≤ 화면").toBeLessThanOrEqual(width + 1);
      expect(Math.abs(a!.width - askW), `질문 폭 ${a!.width}`).toBeLessThanOrEqual(2);
      // 12.9: 사이드바 240px 이하. 1280 에서 옛 4열(사이드바 210 + 탐색 240)이면 본문이 450px 로 줄었다
      expect(s!.width, "사이드바 펼침 폭").toBeLessThanOrEqual(240);
      const floor = MAIN_MIN_REM * (await rootPx(page));
      expect(m!.width, `본문 ${m!.width}px < 결과 글 읽기 폭 ${floor}px (${MAIN_MIN_REM}rem)`).toBeGreaterThanOrEqual(floor - 1);
      const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, i: window.innerWidth }));
      expect(w.s, "가로 스크롤").toBeLessThanOrEqual(w.i + 1);
    });
  }

  test("1280: 사이드바를 접으면 본문이 사이드바가 줄어든 만큼(≥100px) 넓어진다", async ({ page }) => {
    await open(page, CURRENT, 1280);
    const before = (await main(page).boundingBox())!;
    const sBefore = (await sidebar(page).boundingBox())!;
    await page.getByRole("button", { name: SHELL.sidebarToggle }).click();
    await expect(page.getByRole("button", { name: SHELL.sidebarToggle })).toHaveAttribute("aria-expanded", "false");
    await expect.poll(async () => (await main(page).boundingBox())!.width).toBeGreaterThan(before.width + Math.min(100, sBefore.width - 60));
  });

  test("영역은 본문·질문 둘뿐이다(data-area)", async ({ page }) => {
    await open(page, CURRENT, WIDTHS.wide1366);
    const names = await page.evaluate(() => [...document.querySelectorAll("[data-area]")].map((e) => e.getAttribute("data-area")).sort());
    expect(names).toEqual(["ask", "body"]);
  });
});

test.describe("필수 1(d) — 사이드바 나무: 단계 아래 라운드, 하나의 nav", () => {
  test("1440: 조사 단계 링크 아래에 단계 시작·R1·R2 라운드 링크, 보는 라운드만 aria-current=page", async ({ page }) => {
    await open(page, CURRENT, WIDTHS.wide1440);
    const nav = sidebar(page);
    await expect(page.getByRole("navigation", { name: SHELL.sidebarNav })).toHaveCount(1);
    for (const r of ["start", 1, 2] as const) await expect(nav.locator(`a[href="${url("research", r)}"]`).first()).toBeVisible();
    await expect(nav.locator('a[aria-current="page"]')).toHaveCount(1);
    await expect(nav.locator('a[aria-current="page"]')).toHaveAttribute("href", CURRENT);
    // 단계 이름이 두 번 나오는 목록(옛 연구 흐름 + 단계와 라운드)이 아니다: 단계 이름 링크 하나씩만
    const stageLinks = await nav.getByRole("link", { name: /^(기획|조사|분석)(?!.*(R\d|단계 시작))/ }).count();
    expect(stageLinks).toBe(3);
  });

  test("라운드 링크를 눌러도 사이드바가 그대로 있고 새 화면 제목으로 초점이 간다", async ({ page }) => {
    await open(page, CURRENT, WIDTHS.wide1440);
    await sidebar(page).locator(`a[href="${url("research", 1)}"]`).filter({ hasText: /R1/ }).click();
    await expect(page.locator("main [data-screen-title]")).toContainText("조사 R1");
    await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute("data-screen-title"))).toBe(true);
    await expect(sidebar(page)).toBeVisible();
  });

  test("683: Sheet 를 열면 나무가 있고, 라운드를 누르면 Sheet 가 닫힌다", async ({ page }) => {
    await open(page, CURRENT, WIDTHS.zoom200of1366, 700);
    await expect(sidebar(page)).toHaveCount(0);
    await page.getByRole("button", { name: SHELL.sidebarToggle }).click();
    const nav = sidebar(page);
    await expect(nav.locator(`a[href="${url("research", 1)}"]`).filter({ hasText: /R1/ })).toBeVisible();
    await nav.locator(`a[href="${url("research", 1)}"]`).filter({ hasText: /R1/ }).click();
    await expect(page.locator("main [data-screen-title]")).toContainText("조사 R1");
    await expect(sidebar(page)).toHaveCount(0);
  });
});

test.describe("필수 1(b)·(a) — 쿠키 0: 사이드바 접힘·테마는 이 브라우저(localStorage)에만", () => {
  async function watchCookies(page: Page) {
    const sent: string[] = [];
    page.on("request", async (req) => {
      const c = await req.headerValue("cookie");
      if (c) sent.push(`${req.url()} ← ${c}`);
    });
    return sent;
  }

  test("접고 새로고침해도 접힌 채이고, 쿠키는 하나도 없고, 요청에 Cookie 가 실리지 않는다", async ({ page, context }) => {
    const sent = await watchCookies(page);
    await open(page, CURRENT, WIDTHS.wide1440);
    await page.getByRole("button", { name: SHELL.sidebarToggle }).click();
    await expect(page.getByRole("button", { name: SHELL.sidebarToggle })).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Control+b");
    await expect(page.getByRole("button", { name: SHELL.sidebarToggle })).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Control+b");
    await expect(page.getByRole("button", { name: SHELL.sidebarToggle })).toHaveAttribute("aria-expanded", "false");
    expect(await context.cookies(), "쿠키 0").toEqual([]);
    expect(await page.evaluate(() => document.cookie)).toBe("");
    const keys = await page.evaluate(() => Object.keys(localStorage));
    expect(keys.filter((k) => SIDEBAR_STORAGE_KEY.test(k)).length, `localStorage 키: ${keys}`).toBeGreaterThan(0);
    await page.reload();
    await expect(page.locator("main [data-screen-title]")).toBeVisible();
    await expect(page.getByRole("button", { name: SHELL.sidebarToggle })).toHaveAttribute("aria-expanded", "false");
    expect(await context.cookies()).toEqual([]);
    expect(sent, "서버로 가는 요청에 Cookie 헤더가 실리면 안 된다").toEqual([]);
  });
});

test.describe("필수 1(a) — 테마: 기본 Modern Minimal · 4종 · localStorage 에만", () => {
  test("처음엔 Modern Minimal, 고른 테마는 새로고침 뒤에도 남고 쿠키·요청 추가 0", async ({ page, context }) => {
    const reqs: string[] = [];
    await open(page, CURRENT, WIDTHS.wide1440);
    page.on("request", (r) => reqs.push(r.url()));
    expect(await page.evaluate(() => document.documentElement.classList.contains("theme-modern-minimal"))).toBe(true);
    await page.getByRole("button", { name: SHELL.theme }).click();
    await expect(page.getByRole("menuitemradio")).toHaveCount(4 + 3); // 테마 4 + 밝게/어둡게/시스템 3
    await page.getByRole("menuitemradio", { name: /Vercel/ }).click();
    expect(await page.evaluate(() => document.documentElement.classList.contains("theme-vercel"))).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem("pes-theme") ?? "")).toContain("vercel");
    expect(await context.cookies()).toEqual([]);
    await page.reload();
    await expect(page.locator("main [data-screen-title]")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.classList.contains("theme-vercel"))).toBe(true);
    expect(reqs.filter((u) => /theme|api|setting/i.test(new URL(u).pathname)), "테마를 서버에 보내지 않는다").toEqual([]);
  });
});

test.describe("필수 2 — 오류 확인: 초점 유지·성공 뒤 결과 줄/제목", () => {
  for (const [label, w, h] of [
    ["1440×800", WIDTHS.wide1440, 800],
    ["683×600", WIDTHS.zoom200of1366, 600],
  ] as const) {
    test(`${label}: Enter → 초점이 BODY 로 떨어지는 순간 없음, disabled 속성 없음, 성공 뒤 tabIndex -1 결과 줄/제목 + role=status`, async ({ page }) => {
      await open(page, `${CURRENT}?view=body`, w, h);
      const btn = page.getByRole("main").getByRole("button", { name: NAMES.ackError });
      await btn.focus();
      await page.evaluate(() => {
        const samples: { onBody: boolean; disabledBtn: boolean }[] = [];
        (window as unknown as { __ack: typeof samples }).__ack = samples;
        const take = () => {
          const b = [...document.querySelectorAll<HTMLButtonElement>("main button")].find((x) => x.textContent?.trim() === "오류 확인");
          samples.push({ onBody: document.activeElement === document.body || document.activeElement === document.documentElement, disabledBtn: !!b?.disabled });
        };
        new MutationObserver(take).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
        document.addEventListener("focusout", (e) => {
          // 초점이 어디로도 가지 않고 나가는 순간(relatedTarget 없음) 다음 틱에도 BODY 이면 상실
          const ev = e as FocusEvent;
          if (!ev.relatedTarget) setTimeout(take, 0);
        });
      });
      await page.keyboard.press("Enter");
      const alertSec = page.locator("main section[data-print='hide']");
      await expect(alertSec.getByRole("status")).toHaveText("오류를 확인했습니다");
      await page.waitForTimeout(250);
      const r = await page.evaluate(() => {
        const samples = (window as unknown as { __ack: { onBody: boolean; disabledBtn: boolean }[] }).__ack;
        const e = document.activeElement as HTMLElement;
        const sec = e.closest("main section[data-print='hide']");
        const rect = e.getBoundingClientRect();
        const top = document.elementFromPoint(rect.left + rect.width / 2, Math.min(Math.max(rect.top + Math.min(rect.height / 2, 12), 0), window.innerHeight - 1));
        return {
          n: samples.length,
          bodyMoments: samples.filter((s) => s.onBody).length,
          disabledMoments: samples.filter((s) => s.disabledBtn).length,
          tag: e.tagName,
          tabindex: e.getAttribute("tabindex"),
          inAlert: !!sec,
          text: (e.textContent ?? "").trim().slice(0, 40),
          isTitle: !!sec && e.id !== "" && e.id === sec.getAttribute("aria-labelledby"),
          visible: !!top && (e === top || e.contains(top) || top.contains(e)),
        };
      });
      expect(r.n, "표본").toBeGreaterThan(0);
      expect(r.disabledMoments, "disabled 속성 금지(aria-disabled + 핸들러 무시)").toBe(0);
      expect(r.bodyMoments, "초점이 BODY 인 순간").toBe(0);
      expect(r.tag, "초점이 BODY 로 떨어짐").not.toBe("BODY");
      expect(r.inAlert, `초점 ${r.tag} "${r.text}" 이 알림 영역 안`).toBe(true);
      expect(r.tabindex).toBe("-1");
      expect(r.isTitle || /확인함 · 접수 \d+/.test(r.text), `결과 줄 또는 알림 제목 (지금: "${r.text}")`).toBe(true);
      expect(r.visible, "초점 받은 곳이 화면 안에서 보이고 머리줄에 가려지지 않음").toBe(true);
    });
  }
});

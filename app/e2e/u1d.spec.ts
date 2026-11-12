// SEL-84 U1d — AI 연결 칩 · 실행 패널 e2e (Playwright, 빌드한 앱 + vite preview, 가짜 클라이언트 합성 fixture).
// 이름에 keyboard 가 든 시험은 Windows CI 필수 묶음. 계약: src/test/u1d.ts 머리말.
import { expect, test, type Page } from "@playwright/test";
import { CURRENT, WIDTHS } from "../src/test/contract";

async function open(page: Page, width: number = WIDTHS.wide1440) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(CURRENT);
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
}
const chip = (page: Page) => page.getByRole("button", { name: /^AI 연결/ });

test("keyboard: 칩에 초점 → Enter 로 열고 Esc 로 닫으면 초점이 칩으로 돌아온다", async ({ page }) => {
  await open(page);
  await expect(chip(page)).toHaveCount(1);
  await chip(page).focus();
  await page.keyboard.press("Enter");
  await expect(chip(page)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("region", { name: "AI 연결 상태" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "AI 연결 상태" })).toBeHidden();
  await expect(chip(page)).toBeFocused();
});

test("keyboard: Tab 만으로 칩에 닿는다(초점 덫 없음)", async ({ page }) => {
  await open(page);
  await expect(chip(page)).toHaveCount(1);
  let reached = false;
  for (let i = 0; i < 60 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await chip(page).evaluate((el) => el === document.activeElement);
  }
  expect(reached).toBe(true);
});

test("칩 상태는 이름에 낱말로 있고(색만 아님), 화면에 낱말 'Go' 가 없다", async ({ page }) => {
  await open(page);
  await expect(chip(page)).toHaveAccessibleName(/켜짐|차단 중|변경 중|unknown|알 수 없음/);
  await chip(page).click();
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/\bGo\b/);
  const labels = await page.locator("[aria-label],[title]").evaluateAll((els) => els.flatMap((e) => [e.getAttribute("aria-label"), e.getAttribute("title")]));
  expect(labels.filter((l) => l && /\bGo\b/.test(l))).toEqual([]);
});

test("실행 · 기록 패널이 있고 연구 질문 영역과 섞이지 않는다", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("region", { name: "실행" })).toBeVisible();
  await expect(page.getByRole("region", { name: "기록" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "질문" }).getByRole("region", { name: "실행" })).toHaveCount(0);
});

test("휴대폰 폭에서도 칩이 열린다(읽기 허용)", async ({ page }) => {
  await open(page, WIDTHS.phone);
  await expect(chip(page)).toHaveCount(1);
  await chip(page).click();
  await expect(page.getByRole("region", { name: "AI 연결 상태" })).toBeVisible();
});

test.describe("휴대폰(390, 터치) — 칩 누르는 곳 44px", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("칩 높이·너비가 44px 이상이다", async ({ page }) => {
    await page.goto(CURRENT);
    await expect(page.locator("main [data-screen-title]")).toBeVisible();
    const box = await chip(page).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(43.5);
    expect(box!.width).toBeGreaterThanOrEqual(43.5);
  });
});

test("인쇄에서는 칩 · 실행 · 기록 패널이 숨는다", async ({ page }) => {
  await open(page);
  await chip(page).click();
  await expect(page.getByRole("region", { name: "AI 연결 상태" })).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(chip(page)).toBeHidden();
  await expect(page.getByRole("region", { name: "AI 연결 상태" })).toBeHidden();
  await expect(page.getByRole("region", { name: "실행" })).toBeHidden();
  await expect(page.getByRole("region", { name: "기록" })).toBeHidden();
});

test("keyboard: 답 칸에 초점이 있을 때 Esc 로 칸을 닫아도 초점은 답 칸에 남는다", async ({ page }) => {
  await open(page);
  await chip(page).click();
  await expect(page.getByRole("region", { name: "AI 연결 상태" })).toBeVisible();
  const answer = page.getByRole("complementary", { name: "질문" }).getByRole("textbox").first();
  await answer.focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "AI 연결 상태" })).toBeHidden();
  await expect(answer).toBeFocused();
});

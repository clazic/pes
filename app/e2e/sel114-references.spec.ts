// SEL-114 REF1b — 이전 프로젝트 참고자료 화면 e2e (Playwright, 빌드한 앱 + vite preview, 앱 기본 가짜 클라이언트의 합성 fixture).
// 이름에 keyboard 가 든 시험은 Windows CI 필수 묶음. 계약: src/test/sel114.ts 머리말(특히 "e2e 가 기대하는 앱 기본 가짜 클라이언트 자료").
import { expect, test, type Page } from "@playwright/test";
import { WIDTHS, base } from "../src/test/contract";

const REFS = `${base}/references`;

async function open(page: Page, path: string, width: number = WIDTHS.wide1440) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(path);
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
}
const row = (page: Page, id: string) => page.locator(`[data-reference="${id}"]`);

test("상태는 낱말로 있고(색만으로 알리지 않는다) AI 전달 이유가 보인다", async ({ page }) => {
  await open(page, REFS);
  await expect(row(page, "ref-1").locator('[data-cell="state"]')).toContainText("새 버전 있음");
  await expect(row(page, "ref-1").locator('[data-cell="state"]')).toContainText("저절로 바뀌지 않");
  await expect(row(page, "ref-2").locator('[data-cell="state"]')).toContainText("고정됨");
  await expect(row(page, "ref-3").locator('[data-cell="state"]')).toContainText("원본 없음");
  await expect(row(page, "ref-4").locator('[data-cell="state"]')).toContainText("권한 없음");
  await expect(row(page, "ref-2").locator('[data-cell="ai-delivery"]')).toContainText("AI 전달 안 됨");
  await expect(page.locator("[data-ai-notice]")).toContainText("이 화면에서는 계속 보입니다");
});

test("keyboard: Tab 으로 ‘참고 프로젝트 붙이기’ 단추에 닿고 Enter 로 열고 Esc 로 닫으면 초점이 단추로 돌아온다", async ({ page }) => {
  await open(page, REFS);
  const btn = page.getByRole("button", { name: "참고 프로젝트 붙이기" });
  let reached = false;
  for (let i = 0; i < 120 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await btn.evaluate((el) => el === document.activeElement);
  }
  expect(reached).toBe(true);
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "참고 프로젝트 붙이기" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(btn).toBeFocused();
});

test("붙이기: 프로젝트를 고르면 추천 버전이 기본으로 골라지고, 붙이면 접수 번호와 새 행이 보인다", async ({ page }) => {
  await open(page, REFS);
  const before = await page.locator("[data-reference]").count();
  await page.getByRole("button", { name: "참고 프로젝트 붙이기" }).click();
  const dialog = page.getByRole("dialog", { name: "참고 프로젝트 붙이기" });
  await dialog.getByRole("radio", { name: /합성 지역통계/ }).check();
  await expect(dialog.getByRole("radio", { name: /1판 완료본/ })).toBeChecked();
  await expect(dialog.getByRole("radiogroup", { name: "고정할 버전" })).toContainText("승인 안 됨");
  await dialog.getByRole("button", { name: "붙이기", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /접수 \d{4}/ })).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(page.locator("[data-reference]")).toHaveCount(before + 1);
});

test("다시 고정: 새 버전 있음 행을 다른 버전으로 고정하면 고정됨이 되고 고지가 사라진다", async ({ page }) => {
  await open(page, REFS);
  await row(page, "ref-1").getByRole("button", { name: "다시 고정: 합성 장기요양" }).click();
  const dialog = page.getByRole("dialog", { name: "다른 버전으로 다시 고정" });
  await expect(dialog.getByRole("radio", { name: /2판 R1 승인본/ })).toBeChecked();
  await dialog.getByRole("button", { name: "다시 고정", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, "ref-1").locator('[data-cell="version"]')).toContainText("2판 R1 승인본");
  await expect(row(page, "ref-1").locator('[data-cell="state"]')).toContainText("고정됨");
  await expect(row(page, "ref-1").locator('[data-cell="state"]')).not.toContainText("저절로 바뀌지 않");
});

test("떼기: 확인 뒤 그 행만 사라지고, 내용 보기는 읽기 전용에 프로젝트와 버전 이름을 인용으로 보인다", async ({ page }) => {
  await open(page, REFS);
  await row(page, "ref-2").getByRole("button", { name: "내용 보기: 합성 물가" }).click();
  const pane = page.getByRole("region", { name: /참고 내용: 합성 물가/ });
  await expect(pane).toContainText("읽기 전용");
  await expect(pane.locator("[data-citation]").first()).toContainText("합성 물가");
  await expect(pane.locator("[data-citation]").first()).toContainText("1판 완료본");
  await row(page, "ref-5").getByRole("button", { name: "떼기: 합성 병원" }).click();
  const dialog = page.getByRole("dialog", { name: "참고 프로젝트 떼기" });
  await expect(dialog).toContainText("인용");
  await dialog.getByRole("button", { name: "떼기", exact: true }).click();
  await expect(row(page, "ref-5")).toHaveCount(0);
  await expect(row(page, "ref-2")).toHaveCount(1);
});

test("휴대폰 폭(390)에서도 붙이기 · 떼기 · 다시 고정이 있고 문서가 옆으로 넘치지 않는다", async ({ page }) => {
  await open(page, REFS, 390);
  await expect(page.getByRole("button", { name: "참고 프로젝트 붙이기" })).toBeVisible();
  await expect(row(page, "ref-1").getByRole("button", { name: /다시 고정/ })).toBeAttached();
  await expect(row(page, "ref-2").getByRole("button", { name: /떼기/ })).toBeAttached();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("/new: 참고 프로젝트 칸은 담기만 한다 — 담은 목록에 쌓이고 빼면 사라진다", async ({ page }) => {
  // 개발 · 미리보기 서버와 서버(serve.ts)는 아직 `/new` 를 앱 index.html 로 내주지 않는다(/p/… 만) — 앱이 뜬 뒤 주소만 옮겨 라우터가 읽게 한다
  await open(page, REFS);
  await page.evaluate(() => {
    history.pushState({}, "", "/new");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("heading", { level: 1, name: "새 프로젝트" })).toBeVisible();
  const region = page.getByRole("region", { name: "참고 프로젝트" });
  await region.getByRole("radio", { name: /합성 지역통계/ }).check();
  await region.getByRole("radiogroup", { name: "고정할 버전" }).getByRole("radio", { name: /2판 R1 승인본/ }).check();
  await region.getByRole("button", { name: "담기" }).click();
  const item = region.getByRole("list", { name: "담은 참고 프로젝트" }).locator("[data-staged]");
  await expect(item).toContainText("2판 R1 승인본");
  await expect(region).toContainText("아직 프로젝트에 붙이지 않아요");
  await item.getByRole("button", { name: "빼기: 합성 지역통계" }).click();
  await expect(region.locator("[data-staged]")).toHaveCount(0);
});

// SEL-94 U3b 1차 리뷰 고침 — 인쇄 때 가로 스크롤 표가 잘리지 않는다(권장 7c). 합성 fixture, 빌드한 앱.
import { expect, test } from "@playwright/test";
import { WIDTHS, base } from "../src/test/contract";

test("인쇄: 표를 감싼 가로 스크롤 칸은 넘침이 풀리고 표 최소 너비도 없어 종이 폭에 맞는다", async ({ page }) => {
  await page.setViewportSize({ width: WIDTHS.wide1440, height: 800 });
  await page.goto(`${base}/records`);
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
  const screenMin = await page.locator("[data-table-scroll] table").first().evaluate((t) => getComputedStyle(t).minWidth);
  expect(screenMin).not.toBe("0px");
  await page.emulateMedia({ media: "print" });
  const scrolls = page.locator("[data-table-scroll]");
  expect(await scrolls.count()).toBeGreaterThanOrEqual(3);
  for (const s of await scrolls.all()) {
    expect(await s.evaluate((el) => getComputedStyle(el).overflowX)).toBe("visible");
    expect(await s.locator("table").evaluate((t) => getComputedStyle(t).minWidth)).toBe("0px");
  }
});

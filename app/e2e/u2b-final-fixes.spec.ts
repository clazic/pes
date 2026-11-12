// SEL-91 U2b — 최종 리뷰 1/2 수정 e2e (Playwright, 빌드한 앱 + vite preview, 앱 기본 가짜 클라이언트). 실제 CSS 로 확인한다.
import { expect, test, type Page } from "@playwright/test";
import { CURRENT, WIDTHS } from "../src/test/contract";

const ask = (page: Page) => page.getByRole("complementary", { name: "질문" });
const activeQuestion = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-question]")?.dataset.question ?? null);
const display = (page: Page, selector: string) => page.evaluate((s) => getComputedStyle(document.querySelector(s)!).display, selector);

async function open(page: Page, width: number, url: string = CURRENT) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(url);
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
}

test("질문 더하기 대화 상자를 열어 둔 채 인쇄 미디어: 덮개·내용은 숨고 본문은 남는다", async ({ page }) => {
  await open(page, WIDTHS.wide1440);
  await ask(page).getByRole("button", { name: "질문 더하기" }).click();
  const dlg = page.getByRole("dialog", { name: "질문 더하기" });
  await dlg.getByLabel("질문 문장").fill("F1 미제출 질문 초안 — 인쇄 제외 대상");
  await expect(page.locator('[data-slot="dialog-content"]')).toBeVisible();
  await page.emulateMedia({ media: "print" });
  expect(await display(page, '[data-slot="dialog-content"]')).toBe("none");
  expect(await display(page, '[data-slot="dialog-overlay"]')).toBe("none");
  expect(await display(page, '[data-area="ask"]')).toBe("none");
  await expect(page.locator('[data-area="body"]')).toBeVisible();
  await page.emulateMedia({ media: "screen" });
  await expect(page.locator('[data-slot="dialog-content"]')).toBeVisible();
});

test("정리 확인 대화 상자를 열어 둔 채 인쇄 미디어: 덮개·내용이 숨는다", async ({ page }) => {
  await open(page, WIDTHS.wide1440);
  await ask(page).getByRole("button", { name: "질문 22 정리" }).click();
  await ask(page).getByRole("group", { name: "질문 22 정리" }).getByRole("button", { name: "철회" }).click();
  await expect(page.getByRole("dialog", { name: "질문 22 철회" })).toBeVisible();
  await page.emulateMedia({ media: "print" });
  expect(await display(page, '[data-slot="dialog-content"]')).toBe("none");
  expect(await display(page, '[data-slot="dialog-overlay"]')).toBe("none");
});

for (const width of [WIDTHS.mid, WIDTHS.zoom200of1366]) {
  test(`keyboard: ${width}px 본문 보기에서 J/K — 질문 보기로 바뀌고 실제 카드에 초점, 주소 view·focus 가 따라간다`, async ({ page }) => {
    await open(page, width, `${CURRENT}?view=body`);
    await expect(ask(page)).toBeHidden();
    await page.locator("main [data-screen-title]").focus();
    await page.keyboard.press("j");
    await expect.poll(() => activeQuestion(page)).toBe("q-21");
    await expect(ask(page)).toBeVisible();
    await expect(page).toHaveURL(/view=ask/);
    await expect(page).toHaveURL(/focus=q-21/);
    await page.keyboard.press("j");
    await expect.poll(() => activeQuestion(page)).toBe("q-22");
    await expect(page).toHaveURL(/focus=q-22/);
    await page.keyboard.press("k");
    await expect.poll(() => activeQuestion(page)).toBe("q-21");
  });
}

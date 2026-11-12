// SEL-92 U2c — 답 초안 · 개별/묶음 제출 · 질문별 의견 e2e (Playwright, 빌드한 앱 + vite preview, 앱 기본 가짜 클라이언트).
// 이름에 keyboard 가 든 시험은 Windows CI 필수 묶음. 계약: src/test/u2c.ts 머리말.
// 앱 기본 가짜 클라이언트(DEMO_WORKSPACE · ROUNDS)가 submitAnswers · addComment · getComments 를 구현해야 한다 —
// 조사 R2 의 q-21(높음 · 필수) · q-22(보통)는 그대로이고 그 밖에 질문이 더 있어도 된다. 합성 자료뿐.
import { expect, test, type Page } from "@playwright/test";
import { CURRENT, WIDTHS } from "../src/test/contract";

async function open(page: Page, width: number = WIDTHS.wide1440) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(CURRENT);
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
}
const ask = (page: Page) => page.getByRole("complementary", { name: "질문" });
const item = (page: Page, id: string) => page.locator(`[data-question="${id}"]`);
const draftKeys = (page: Page, re: string) => page.evaluate((r) => Object.keys(window.sessionStorage).filter((k) => new RegExp(r).test(k)).length, re);

test("keyboard: 개별 제출 — 그 질문만 보내고 영수증 뒤에 접수 번호와 보낸 답이 보이며 폼 완료를 주장하지 않는다", async ({ page }) => {
  await open(page);
  await page.locator("#q-22").fill("지역 도서관 연보");
  await ask(page).getByRole("button", { name: "질문 22 이 답만 보내기" }).click();
  await expect(item(page, "q-22").locator('[data-field-kind="answer"]')).toContainText("지역 도서관 연보");
  const status = ask(page).getByRole("status").filter({ hasText: /접수/ });
  await expect(status).toContainText(/접수 \d{4}/);
  await expect(status).toContainText("이 답만");
  await expect(status).not.toContainText(/모두|완료|끝났/);
  // 필수 q-21 은 비어 있으므로 남은 필수를 알린다
  await expect(status).toContainText(/필수 \d+개/);
  expect(await draftKeys(page, "q-22.*answer")).toBe(0);
});

test("keyboard: 묶음 검토 대화 상자 — 필수가 비면 확정이 막히고, Esc 로 닫으면 연 단추로 초점이 돌아온다", async ({ page }) => {
  await open(page);
  await page.locator("#q-22").fill("출처 하나");
  const opener = ask(page).getByRole("button", { name: "답 검토 후 보내기" });
  await opener.focus();
  await page.keyboard.press("Enter");
  const dlg = page.getByRole("dialog", { name: "답 검토" });
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('[data-missing="q-21"]')).toContainText("질문 21");
  await expect(dlg.getByRole("button", { name: "묶음으로 보내기" })).toHaveAttribute("aria-disabled", "true");
  // 초점이 대화 상자 밖으로 새지 않는다
  for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(page.locator("#q-22")).toHaveValue("출처 하나");
});

test("keyboard: 필수를 채우고 묶음으로 보내면 한 번에 접수된다", async ({ page }) => {
  await open(page);
  await page.locator("#q-21").fill("한 줄로 이어 주세요");
  await page.locator("#q-22").fill("출처 하나");
  await ask(page).getByRole("button", { name: "답 검토 후 보내기" }).click();
  const dlg = page.getByRole("dialog", { name: "답 검토" });
  await dlg.getByRole("button", { name: "묶음으로 보내기" }).click();
  await expect(dlg).toHaveCount(0);
  await expect(item(page, "q-21").locator('[data-field-kind="answer"]')).toContainText("한 줄로 이어 주세요");
  await expect(item(page, "q-22").locator('[data-field-kind="answer"]')).toContainText("출처 하나");
  await expect(ask(page).getByRole("status").filter({ hasText: /묶음/ })).toContainText(/접수 \d{4}/);
});

test("keyboard: 한글 조합(IME) 중에는 초안을 저장하지 않고 조합이 끝나면 저장한다 (의견 스레드 칸)", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "CDP 조합 입력은 chromium 만");
  await open(page);
  await ask(page).getByRole("button", { name: "질문 22 의견 스레드" }).click();
  const box = page.getByLabel("질문 22 스레드 의견 쓰기");
  await box.focus();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "ㅇ", selectionStart: 1, selectionEnd: 1 });
  expect(await draftKeys(page, "q-22.*comment")).toBe(0);
  await cdp.send("Input.insertText", { text: "의견" });
  await expect.poll(() => draftKeys(page, "q-22.*comment")).toBe(1);
  await expect(box).toHaveValue("의견");
});

test("질문별 의견: 스레드에 남기면 접수 번호와 메시지가 보이고 답은 생기지 않는다", async ({ page }) => {
  await open(page);
  await ask(page).getByRole("button", { name: "질문 22 의견 스레드" }).click();
  const region = page.locator('[data-comments="q-22"]');
  await page.getByLabel("질문 22 스레드 의견 쓰기").fill("이 질문은 범위가 넓어요");
  await region.getByRole("button", { name: "스레드에 남기기" }).click();
  await expect(region.locator("li[data-message]")).toHaveCount(1);
  await expect(region.locator('[data-field-kind="comment"]')).toContainText("이 질문은 범위가 넓어요");
  await expect(ask(page).getByRole("status").filter({ hasText: /접수/ })).toContainText(/접수 \d{4}/);
  await expect(item(page, "q-22").locator('[data-field-kind="answer"]')).toHaveCount(0);
});

test("인쇄: 열린 검토 대화 상자는 인쇄에서 빠진다", async ({ page }) => {
  await open(page);
  await page.locator("#q-22").fill("출처 하나");
  await ask(page).getByRole("button", { name: "답 검토 후 보내기" }).click();
  const dlg = page.getByRole("dialog", { name: "답 검토" });
  await expect(dlg).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(dlg).toBeHidden();
  await expect(page.locator('[data-slot="dialog-overlay"]')).toBeHidden();
});

test.describe("휴대폰(굵은 포인터)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("보내기 · 의견 단추와 의견 칸을 누르는 곳이 44px 이상이다", async ({ page }) => {
    await page.goto(`${CURRENT}?view=ask`);
    await expect(page.locator("[data-screen-title]")).toBeVisible();
    const targets = [page.getByRole("button", { name: "질문 22 이 답만 보내기" }), page.getByRole("button", { name: "답 검토 후 보내기" }), page.getByRole("button", { name: "질문 22 의견 스레드" })];
    for (const t of targets) {
      await t.scrollIntoViewIfNeeded();
      const box = await t.boundingBox();
      expect(box?.height ?? 0, await t.innerText()).toBeGreaterThanOrEqual(44);
    }
  });

  test("가로 넘침 없이 답 칸과 보내기 단추가 한 화면 폭 안에 든다", async ({ page }) => {
    await page.goto(`${CURRENT}?view=ask`);
    await expect(page.locator("[data-screen-title]")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });
});

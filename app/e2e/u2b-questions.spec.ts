// SEL-91 U2b — 질문 카드 · 필터 · 이동 · 인라인 고치기 e2e (Playwright, 빌드한 앱 + vite preview, 앱 기본 가짜 클라이언트).
// 이름에 keyboard 가 든 시험은 Windows CI 필수 묶음. 계약: src/test/u2b.ts 머리말.
// 앱 기본 가짜 클라이언트(DEMO_WORKSPACE · ROUNDS)가 이 계약의 읽기·쓰기를 구현해야 한다 — 조사 R2 의 q-21(높음 · 필수) · q-22(보통)는 그대로이고, 그 밖에 질문이 더 있어도 된다.
import { expect, test, type Page } from "@playwright/test";
import { CURRENT, WIDTHS } from "../src/test/contract";

async function open(page: Page, width: number = WIDTHS.wide1440) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(CURRENT);
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
}
const ask = (page: Page) => page.getByRole("complementary", { name: "질문" });
const item = (page: Page, id: string) => page.locator(`[data-question="${id}"]`);
const activeQuestion = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-question]")?.dataset.question ?? null);

test("질문 항목 · 필터 · 이동 표식이 있다", async ({ page }) => {
  await open(page);
  await expect(item(page, "q-21")).toBeVisible();
  await expect(item(page, "q-21").locator('[data-chip="required"]')).toHaveText("필수");
  await expect(item(page, "q-21").locator('[data-chip="importance"]')).toContainText("높음");
  await expect(item(page, "q-22").locator('[data-chip="required"]')).toHaveCount(0);
  const group = ask(page).getByRole("radiogroup", { name: "질문 거르기" });
  await expect(group.getByRole("radio")).toHaveCount(4);
  await expect(group.getByRole("radio", { name: /^전체 \d+$/ })).toBeChecked();
  await expect(ask(page).locator("[data-position]")).toHaveText(/^1\/\d+$/);
});

test("keyboard: 높음 필터를 고르면 높음 질문만 남는다(q-21 있고 q-22 없음)", async ({ page }) => {
  await open(page);
  const group = ask(page).getByRole("radiogroup", { name: "질문 거르기" });
  await group.getByRole("radio", { name: /^높음 \d+$/ }).check();
  await expect(item(page, "q-21")).toBeVisible();
  await expect(item(page, "q-22")).toHaveCount(0);
  await group.getByRole("radio", { name: /^전체/ }).check();
  await expect(item(page, "q-22")).toBeVisible();
});

test("keyboard: J/K 로 질문을 오가고, 입력 칸에서는 글자가 들어간다", async ({ page }) => {
  await open(page);
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("j");
  await expect.poll(() => activeQuestion(page)).toBe("q-21");
  await page.keyboard.press("j");
  await expect.poll(() => activeQuestion(page)).toBe("q-22");
  await page.keyboard.press("k");
  await expect.poll(() => activeQuestion(page)).toBe("q-21");
  await expect(page).toHaveURL(/focus=q-21/);
  const box = page.locator("#q-22");
  await box.click();
  await page.keyboard.type("jk");
  await expect(box).toHaveValue("jk");
  await expect(box).toBeFocused();
});

test("keyboard: 다음 질문 단추와 3/12 꼴 위치 글", async ({ page }) => {
  await open(page);
  await ask(page).getByRole("button", { name: "다음 질문" }).click();
  await expect(ask(page).locator("[data-position]")).toHaveText(/^2\/\d+$/);
  await expect.poll(() => activeQuestion(page)).toBe("q-22");
});

test("keyboard: 고치기 form — 열면 첫 칸 초점, 문장을 고치면 저장 전에 '재확인 필요' 경고, 저장하면 새 버전 배지", async ({ page }) => {
  await open(page);
  await ask(page).getByRole("button", { name: "질문 22 고치기" }).click();
  const form = ask(page).getByRole("form", { name: "질문 22 고치기" });
  await expect(form.getByLabel("질문 문장")).toBeFocused();
  await expect(form.locator('[data-warning="recheck"]')).toHaveCount(0);
  await page.keyboard.type(" (고침)");
  const warning = form.locator('[data-warning="recheck"]');
  await expect(warning).toContainText("재확인 필요");
  await expect(warning).toContainText(/옛 답/);
  await form.getByRole("button", { name: "새 버전으로 저장" }).click();
  await expect(form).toHaveCount(0);
  await expect(item(page, "q-22").locator('[data-badge="recheck"]')).toHaveText("재확인 필요");
  await expect(item(page, "q-22").locator('[data-chip="version"]')).toHaveText("버전 2");
  await expect(ask(page).getByRole("status").filter({ hasText: "새 버전" })).toContainText(/접수 \d+/);
});

test("중요도만 고치면 경고도 배지도 없다", async ({ page }) => {
  await open(page);
  await ask(page).getByRole("button", { name: "질문 22 고치기" }).click();
  const form = ask(page).getByRole("form", { name: "질문 22 고치기" });
  await form.getByLabel("중요도").selectOption({ label: "높음" });
  await expect(form.locator('[data-warning="recheck"]')).toHaveCount(0);
  await form.getByRole("button", { name: "새 버전으로 저장" }).click();
  await expect(item(page, "q-22").locator('[data-chip="importance"]')).toContainText("높음");
  await expect(item(page, "q-22").locator('[data-badge="recheck"]')).toHaveCount(0);
});

test("keyboard: 철회 대화 상자는 Esc 로 닫히고 질문은 그대로", async ({ page }) => {
  await open(page);
  await ask(page).getByRole("button", { name: "질문 22 정리" }).click();
  await ask(page).getByRole("group", { name: "질문 22 정리" }).getByRole("button", { name: "철회" }).click();
  const dlg = page.getByRole("dialog", { name: "질문 22 철회" });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText(/지우지 않/);
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  await expect(item(page, "q-22")).toBeVisible();
});

test("철회를 확정하면 질문은 지워지지 않고 정리된 질문에 철회됨으로 남는다", async ({ page }) => {
  await open(page);
  await ask(page).getByRole("button", { name: "질문 22 정리" }).click();
  await ask(page).getByRole("group", { name: "질문 22 정리" }).getByRole("button", { name: "철회" }).click();
  await page.getByRole("dialog", { name: "질문 22 철회" }).getByRole("button", { name: "철회 확정" }).click();
  const closed = ask(page).getByRole("region", { name: "정리된 질문" });
  await expect(closed.locator('[data-question="q-22"]')).toContainText("철회됨");
  await expect(closed.locator('[data-question="q-22"] textarea')).toHaveCount(0);
});

test("화면에 낱말 'Go' 가 없다", async ({ page }) => {
  await open(page);
  await ask(page).getByRole("button", { name: "질문 22 고치기" }).click();
  expect(await page.locator("body").innerText()).not.toMatch(/\bGo\b/);
  const labels = await page.locator("[aria-label],[title]").evaluateAll((els) => els.flatMap((e) => [e.getAttribute("aria-label"), e.getAttribute("title")]));
  expect(labels.filter((l) => l && /\bGo\b/.test(l))).toEqual([]);
});

test.describe("휴대폰(390, 터치)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("질문 도구는 꺼져 있고 이유 글이 있다. 답 칸은 쓸 수 있다", async ({ page }) => {
    await page.goto(`${CURRENT}?view=ask`);
    await expect(page.locator("[data-screen-title]")).toBeVisible();
    const edit = ask(page).getByRole("button", { name: "질문 22 고치기" });
    await expect(edit).toHaveAttribute("aria-disabled", "true");
    const reasonId = await edit.getAttribute("aria-describedby");
    expect(reasonId).toBeTruthy();
    await expect(page.locator(`#${reasonId}`)).toContainText("데스크톱");
    await page.locator("#q-22").fill("휴대폰 답");
    await expect(page.locator("#q-22")).toHaveValue("휴대폰 답");
  });

  test("필터 라디오와 다음 질문 단추를 누르는 곳이 44px 이상이다", async ({ page }) => {
    await page.goto(`${CURRENT}?view=ask`);
    await expect(page.locator("[data-screen-title]")).toBeVisible();
    const targets = [ask(page).getByRole("radiogroup", { name: "질문 거르기" }).getByRole("radio").first(), ask(page).getByRole("button", { name: "다음 질문" })];
    for (const t of targets) {
      const box = await t.boundingBox();
      expect(box?.height ?? 0, "높이").toBeGreaterThanOrEqual(44);
      expect(box?.width ?? 0, "너비").toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe("데스크톱 굵은 포인터가 아닌 경우의 도구 크기", () => {
  test("질문 22 고치기 · 위로 · 아래로 단추는 마우스 기준 24px 이상(WCAG 2.2 2.5.8)", async ({ page }) => {
    await open(page);
    for (const name of ["질문 22 고치기", "질문 22 위로 옮기기", "질문 22 아래로 옮기기", "질문 22 정리"]) {
      const box = await ask(page).getByRole("button", { name }).boundingBox();
      expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(24);
      expect(box?.width ?? 0, name).toBeGreaterThanOrEqual(24);
    }
  });
});

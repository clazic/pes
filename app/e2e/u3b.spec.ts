// SEL-94 U3b — 가정·결정·반영 화면 e2e (Playwright, 빌드한 앱 + vite preview, 앱 기본 가짜 클라이언트의 합성 fixture).
// 이름에 keyboard 가 든 시험은 Windows CI 필수 묶음. 계약: src/test/u3b.ts 머리말(특히 "e2e 가 기대하는 앱 기본 가짜 클라이언트 자료").
// 근거 링크가 보고서·산출물(/<slug>/reports · out)로 가는 경우는 같은 탭 전체 이동 — vitest 쪽 머리말 참고(SEL-86 병합 뒤 재확인).
import { expect, test, type Page } from "@playwright/test";
import { CURRENT, WIDTHS, base } from "../src/test/contract";

const RECORDS = `${base}/records`;

async function open(page: Page, path: string, width: number = WIDTHS.wide1440) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(path);
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
}
const asRow = (page: Page, id: string) => page.locator(`[data-assumption="${id}"]`);

test("keyboard: Tab 으로 가정 '확인' 단추에 닿고 Enter 로 열고 Esc 로 닫으면 초점이 단추로 돌아온다", async ({ page }) => {
  await open(page, RECORDS);
  const btn = asRow(page, "as-1").getByRole("button", { name: "확인" });
  await expect(btn).toBeVisible();
  let reached = false;
  for (let i = 0; i < 120 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await btn.evaluate((el) => el === document.activeElement);
  }
  expect(reached).toBe(true);
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: /가정 확인/ });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(btn).toBeFocused();
});

test("keyboard: 마우스 없이 틀림 판단을 기록하면 접수 번호가 보이고 행이 '틀림'이 된다", async ({ page }) => {
  await open(page, RECORDS);
  const btn = asRow(page, "as-1").getByRole("button", { name: "틀림" });
  await btn.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: /가정 틀림/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "근거" }).fill("정의가 중간에 바뀜");
  await dialog.getByRole("button", { name: "판단 기록" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: /접수 \d{4}/ })).toBeVisible();
  await expect(asRow(page, "as-1")).toHaveAttribute("data-state", "rejected");
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("표는 이름 있는 표 셋이고 상태는 낱말로 있으며, 화면에 낱말 'Go' 가 없다", async ({ page }) => {
  await open(page, RECORDS);
  for (const name of ["가정", "결정", "반영 내역"]) await expect(page.getByRole("region", { name }).getByRole("table", { name: new RegExp(name) })).toHaveCount(1);
  await expect(asRow(page, "as-1").locator('[data-cell="state"]')).toContainText("판단 전");
  await expect(asRow(page, "as-2").locator('[data-cell="state"]')).toContainText("확인");
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/\bGo\b/);
  const labels = await page.locator("[aria-label],[title]").evaluateAll((els) => els.flatMap((e) => [e.getAttribute("aria-label"), e.getAttribute("title")]));
  expect(labels.filter((l) => l && /\bGo\b/.test(l))).toEqual([]);
});

test("결정 대체 사슬: 대체한 결정의 링크가 옛 결정 행으로 가고 둘 다 보인다", async ({ page }) => {
  await open(page, RECORDS);
  const next = page.locator('[data-decision="dec-2"]');
  await expect(page.locator('[data-decision="dec-1"]')).toBeVisible();
  await expect(next).toBeVisible();
  await next.locator('[data-cell="supersedes"] a').click();
  await expect(page).toHaveURL(/#decision-dec-1$/);
  await expect(page.locator("#decision-dec-1")).toBeVisible();
});

test("라운드 첫머리: 반영 내역 막대가 '기록' 영역보다 위에 있고, 증거 없는 줄은 적용에 세지 않는다", async ({ page }) => {
  await open(page, CURRENT);
  const reflection = page.getByRole("region", { name: "반영 내역" });
  await expect(reflection).toBeVisible();
  await expect(reflection.locator("[data-reflection-bar]")).toBeVisible();
  const above = await page.evaluate(() => {
    const a = document.querySelector('[role="region"][aria-label="반영 내역"], section[aria-label="반영 내역"]');
    const b = document.querySelector('[aria-label="기록"]');
    return !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(above).toBe(true);
  for (const r of await reflection.locator('[data-reflection][data-evidence="missing"]').all()) await expect(r.locator('[data-cell="state"]')).toContainText("증거 없음");
});

test("휴대폰 폭: 가로로 넘치지 않고 판단 단추가 있다", async ({ page }) => {
  await open(page, RECORDS, WIDTHS.phone);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(asRow(page, "as-1").getByRole("button", { name: "확인" })).toBeVisible();
});

test.describe("휴대폰(390, 터치) — 판단 단추 누르는 곳 44px", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 } });
  test("확인 · 틀림 · 고침 단추가 44px 이상", async ({ page }) => {
    await page.goto(RECORDS);
    await expect(page.locator("main [data-screen-title]")).toBeVisible();
    for (const name of ["확인", "틀림", "고침"]) {
      const box = await asRow(page, "as-1").getByRole("button", { name }).boundingBox();
      expect(box, name).not.toBeNull();
      expect(box!.height, name).toBeGreaterThanOrEqual(44);
      expect(box!.width, name).toBeGreaterThanOrEqual(44);
    }
  });
});

test("인쇄: 판단 단추는 빠지고 표는 남는다", async ({ page }) => {
  await open(page, RECORDS);
  await page.emulateMedia({ media: "print" });
  await expect(asRow(page, "as-1").getByRole("button", { name: "확인" })).toBeHidden();
  await expect(page.getByRole("region", { name: "가정" }).getByRole("table")).toBeVisible();
  await expect(asRow(page, "as-2").locator('[data-cell="judge"]')).toBeVisible();
});

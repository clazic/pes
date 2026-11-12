// SEL-117 MAT1c — 내 자료 화면 e2e (Playwright, 빌드한 앱 + vite preview, 앱 기본 가짜 클라이언트의 합성 자료).
// 이름에 keyboard 가 든 시험은 키보드만으로 끝까지 간다. 계약: src/test/sel117.ts 머리말(특히 “e2e 가 기대하는 앱 기본 가짜 클라이언트 자료”).
import { expect, test, type Page } from "@playwright/test";
import { base } from "../src/test/contract";

const FILES = `${base}/files`;

async function open(page: Page, path: string, width = 1440) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(path);
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
  await expect(page.locator("[data-material]").first()).toBeVisible();
}
const row = (page: Page, id: string) => page.locator(`[data-material="${id}"]`);

test("올리기: 파일을 고르면 접수 번호가 보이고 그 뒤 목록에 새 행이 생긴다 (영수증 전에는 행이 없다)", async ({ page }) => {
  await open(page, FILES);
  const before = await page.locator("[data-material]").count();
  await page.getByLabel("자료 파일 고르기").setInputFiles({ name: "e2e-upload-synthetic.txt", mimeType: "text/plain", buffer: Buffer.from("합성 올리기 시험") });
  await expect(page.getByRole("status").filter({ hasText: /접수 \d+ · e2e-upload-synthetic\.txt/ })).toBeVisible();
  await expect(page.locator("[data-material]")).toHaveCount(before + 1);
  await expect(page.locator("table")).toContainText("e2e-upload-synthetic.txt");
});

test("keyboard: Tab 으로 스위치에 닿고 Enter 로 대화 상자를 열고 Esc 로 닫으면 초점이 스위치로 돌아온다 · 다시 열어 끄면 접수 번호와 새 값", async ({ page }) => {
  await open(page, FILES);
  const sw = row(page, "mat-1").getByRole("switch");
  await expect(sw).toHaveAttribute("aria-checked", "true");
  let reached = false;
  for (let i = 0; i < 80 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await sw.evaluate((el) => el === document.activeElement);
  }
  expect(reached).toBe(true);
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "AI 참조 끄기" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  // 정직한 안내: B 직접 읽기는 막지 못하고, 이미 나간 내용은 회수되지 않는다
  await expect(dialog).toContainText("막지 못");
  await expect(dialog).toContainText("회수");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(sw).toBeFocused();
  await expect(sw).toHaveAttribute("aria-checked", "true");

  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "이유" }).fill("합성 이유");
  await dialog.getByRole("button", { name: "AI 참조 끄기" }).click();
  await expect(dialog).toBeHidden();
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(row(page, "mat-1")).toHaveAttribute("data-ai-access", "deny");
  await expect(page.getByRole("status").filter({ hasText: /접수 \d+/ })).toBeVisible();
  await expect(sw).toBeFocused();
});

test("미리보기: 글 파일은 pre 에 글자로 보이고, 그 밖 형식은 열지 않고 내려받기만 보인다. 문서 틀(iframe)은 없다", async ({ page }) => {
  await open(page, FILES);
  await row(page, "mat-1").getByRole("button", { name: /미리보기/ }).click();
  const pane = page.getByRole("region", { name: /미리보기: 합성 면담 메모/ });
  await expect(pane.locator("pre")).toContainText("합성 본문");
  await pane.getByRole("button", { name: "닫기" }).click();
  await expect(pane).toBeHidden();
  await row(page, "mat-2").getByRole("button", { name: /미리보기/ }).click();
  const pdf = page.getByRole("region", { name: /미리보기: 합성 선행연구 요약/ });
  await expect(pdf).toContainText("내려받기");
  await expect(pdf).toContainText("미리볼 수 없");
  await expect(page.locator("iframe, object, embed")).toHaveCount(0);
});

for (const width of [390, 900, 1440]) {
  test(`${width}: 표가 옆으로 밀리고 문서 전체는 가로로 넘치지 않는다`, async ({ page }) => {
    await open(page, FILES, width);
    const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, i: window.innerWidth }));
    expect(w.s).toBeLessThanOrEqual(w.i + 1);
  });
}

test("/new: 담기만 하고 서버에는 아무것도 올리지 않는다 — 올릴 때부터 금지로 바꿀 수 있다", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") posts.push(`${r.method()} ${r.url()}`);
  });
  // 서버가 /new 를 앱 주소로 내주지 않는다(앱 화면 주소는 /p/<slug>/…) — 앱 안 이동(pushState + popstate)으로 연다
  await page.goto(FILES);
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
  await page.evaluate(() => {
    history.pushState({}, "", "/new");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  const region = page.getByRole("region", { name: "내 자료" });
  await expect(region).toBeVisible();
  await region.getByLabel("자료 파일 고르기").setInputFiles({ name: "staged-e2e-synthetic.csv", mimeType: "text/csv", buffer: Buffer.from("a,b\n1,2") });
  await expect(region).toContainText("staged-e2e-synthetic.csv");
  await expect(region).toContainText("아직 올리지 않");
  const sw = region.getByRole("switch", { name: /AI 참조.*staged-e2e-synthetic/ });
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(region).toContainText("올릴 때부터 AI 참조 금지");
  expect(posts).toEqual([]);
});

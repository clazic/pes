// SEL-126 F2 — 실제 서버가 내준 봉인 라운드(state:"closed" + result)에서 앱의 첨언·선택 도구가 켜진다 (Playwright, production 앱 빌드 app/dist).
// 봉인한 라운드는 서버가 늘 state:"closed" 로 준다. 막는 기준은 라운드 상태가 아니라 '활성 판인가'다(지난 판만 읽기 전용).
// 앞 조건: cd app && npm ci && npm run build. 임시 HOME 의 합성 프로젝트(seed_sealed_result.ts)만 쓴다.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

import { REPO, open_workspace, type Workspace } from "./helpers/workspace.ts";

const DIST = join(REPO, "app", "dist");

let ws: Workspace;
test.beforeAll(async () => {
  expect(existsSync(join(DIST, "index.html")), "앱 빌드가 없다 — cd app && npm ci && npm run build 를 먼저 한다(app/dist/index.html)").toBe(true);
  ws = await open_workspace({ PES_APP_DIR: DIST }, "seed_sealed_result.ts");
});
test.afterAll(async () => {
  await ws?.close();
});

test("봉인한 라운드의 결과 글: '첨언 쓰기'가 켜지고 본문을 고르면 선택 도구줄이 뜬다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(ws.open_app());
  await page.goto(`${ws.base}/p/${ws.slug}/e/1/s/plan/r/1`);
  const para = page.locator("main article p", { hasText: "MARK-F2-SEALED" });
  await expect(para).toBeVisible();
  await expect(page.getByText(/지난 라운드 · 보는 중/)).toBeVisible(); // 서버가 state:"closed" 로 줬다
  await expect(page.getByRole("button", { name: "첨언 쓰기" })).not.toHaveAttribute("aria-disabled", "true");
  // 루트 tsconfig 에는 DOM 타입이 없어 브라우저 쪽 코드는 글로 넘긴다
  await page.evaluate(`(() => {
    const el = [...document.querySelectorAll("main article p")].find((p) => (p.textContent || "").includes("MARK-F2-SEALED"));
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  })()`);
  await expect(page.getByRole("toolbar", { name: "선택한 글 도구" })).toBeVisible();
});

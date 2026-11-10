// SEL-51 PR18 — 최종 리뷰 2/2 필수 2 회귀 (tester, 작성 모드): 질문 폼(ask)에서 응답을 기다리는 동안 더 입력한 내용은
// 영수증이 지우지 않고, 다시 불러오면(reload) 복원된다. 구현 전에는 실패하는 것이 정상이다. 합성 DB 프로젝트만 쓴다.
import { expect, test } from "@playwright/test";

import { open_workspace, type Workspace } from "./helpers/workspace.ts";

let ws: Workspace;
test.beforeAll(async () => {
  ws = await open_workspace();
});
test.afterAll(async () => {
  await ws?.close();
});

const url = (path: string): string => `${ws.base}/${ws.slug}${path}`;

async function stored(page: import("@playwright/test").Page): Promise<string[]> {
  return JSON.parse((await page.evaluate(`JSON.stringify(Object.keys(sessionStorage).filter(k => k.startsWith("pes-draft:")).map(k => sessionStorage.getItem(k)))`)) as string);
}

test("N2 질문 폼: 응답을 기다리는 동안 더 입력 → 영수증 → reload 하면 추가 입력이 복원된다 (보낸 내용만 정리)", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const posts: string[] = [];
  await page.route("**/feedback", async (route) => {
    posts.push(route.request().postData() ?? "");
    await gate;
    await route.fulfill({ status: 200, json: { ok: true, file: "plan-R1-20260101-000000.json", v: 999999 } });
  });
  await page.goto(url("/ask-plan-start.html"));
  await expect(page.locator("#send")).toBeVisible();
  const memo = page.locator('textarea[data-q="memo"]');
  await memo.fill("합성 보낸 메모");
  const started = page.waitForRequest((r) => r.method() === "POST" && /\/feedback$/.test(new URL(r.url()).pathname));
  await page.locator("#send").click();
  await started;
  await memo.fill("합성 보낸 메모 + 응답 전 추가 입력"); // 응답을 기다리는 동안
  release();
  await expect(page.locator("#send")).toHaveText(/보냈습니다/);
  expect(posts).toHaveLength(1);
  expect(posts[0], "요청에는 보낸 시점의 내용만 있다").not.toContain("응답 전 추가 입력");
  await page.waitForTimeout(300);
  expect((await stored(page)).join("\n"), "추가 입력이 저장소에 남아 있다").toContain("응답 전 추가 입력");
  await page.unroute("**/feedback");
  await page.reload();
  await expect(page.locator('textarea[data-q="memo"]'), "다시 불러와도 추가 입력이 복원된다").toHaveValue("합성 보낸 메모 + 응답 전 추가 입력");
});

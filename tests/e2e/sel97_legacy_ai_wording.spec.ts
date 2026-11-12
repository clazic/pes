// SEL-97 (tester, 작성 모드) — 기존 대시보드의 AI 연결 표시가 새 앱(app/src/components/pes/status-registry.ts)과 같은 말이다.
//
// 정한 인터페이스: 대시보드에 `[data-ai-connection]` 요소 하나. 글자는 "AI 연결 <상태 낱말>", `data-state` 는 새 앱 칩과 같은 on | blocked | unknown.
//   정책 기계 값(페이지 데이터 ai_connection.policy) → 낱말: allowed=켜짐, denied·missing·corrupt=차단 중, 칸 없음·모르는 값=알 수 없음.
//   모르는 값을 켜짐으로 읽지 않는다(설계 P4). 'Go' 낱말과 서버가 안 보내는 칸(변경 중·취소 시도·외부 앱 질문)은 글자에 없다.
// 페이지 데이터는 route 로 바꿔 끼운다(다른 정책 상태를 DB 를 건드리지 않고 만든다). 임시 HOME 의 합성 프로젝트 뿐.
import { expect, test, type Page } from "@playwright/test";

import { open_workspace, type Workspace } from "./helpers/workspace.ts";

let ws: Workspace;
test.beforeAll(async () => {
  ws = await open_workspace();
});
test.afterAll(async () => {
  await ws?.close();
});

const url = (path: string): string => `${ws.base}/${ws.slug}${path}`;

/** 대시보드의 `#data` JSON 을 고쳐서 내준다. patch 는 데이터 객체를 제자리에서 바꾼다. */
async function with_data(page: Page, patch: (data: any) => void): Promise<void> {
  await page.route(url("/"), async (route) => {
    const res = await route.fetch();
    const html = await res.text();
    const fixed = html.replace(/(<script id="data" type="application\/json">)([\s\S]*?)(<\/script>)/, (_m, a: string, json: string, c: string) => {
      const data = JSON.parse(json);
      patch(data);
      return `${a}${JSON.stringify(data).replace(/</g, "\\u003c")}${c}`;
    });
    await route.fulfill({ response: res, body: fixed });
  });
}

const chip = (page: Page) => page.locator("[data-ai-connection]");

test("S1 기본(정책 허용): 'AI 연결 켜짐', Go 낱말 없음", async ({ page }) => {
  await page.goto(url("/"));
  await expect(chip(page)).toHaveCount(1);
  await expect(chip(page)).toContainText("AI 연결");
  await expect(chip(page)).toContainText("켜짐");
  await expect(chip(page)).toHaveAttribute("data-state", "on");
  expect(await page.locator("body").innerText()).not.toMatch(/\bGo\b/);
});

for (const policy of ["denied", "missing", "corrupt"]) {
  test(`S2 정책 ${policy}: 'AI 연결 차단 중' (허용으로 읽지 않음)`, async ({ page }) => {
    await with_data(page, (d) => (d.ai_connection = { policy }));
    await page.goto(url("/"));
    await expect(chip(page)).toContainText("차단 중");
    await expect(chip(page)).not.toContainText("켜짐");
    await expect(chip(page)).toHaveAttribute("data-state", "blocked");
  });
}

test("S3 서버가 AI 연결 칸을 안 보내면 '알 수 없음' — 켜짐도 차단 중도 지어내지 않는다", async ({ page }) => {
  await with_data(page, (d) => {
    delete d.ai_connection;
  });
  await page.goto(url("/"));
  await expect(chip(page)).toContainText("AI 연결");
  await expect(chip(page)).toContainText("알 수 없음");
  await expect(chip(page)).toHaveAttribute("data-state", "unknown");
  await expect(chip(page)).not.toContainText(/켜짐|차단 중/);
});

test("S4 모르는 policy 값도 '알 수 없음' (켜짐으로 읽지 않음)", async ({ page }) => {
  await with_data(page, (d) => (d.ai_connection = { policy: "surprise" }));
  await page.goto(url("/"));
  await expect(chip(page)).toContainText("알 수 없음");
  await expect(chip(page)).not.toContainText("켜짐");
});

test("S5 서버가 안 보내는 칸(변경 중·취소 시도·외부 앱 질문)은 어느 상태에서도 글자에 없다", async ({ page }) => {
  for (const policy of ["allowed", "denied", "missing", "corrupt"]) {
    await page.unroute(url("/")).catch(() => {});
    await with_data(page, (d) => (d.ai_connection = { policy }));
    await page.goto(url("/"));
    const text = await page.locator("body").innerText();
    expect(text, `policy=${policy}`).not.toMatch(/변경 중|취소 시도|외부 앱|\bGo\b/);
  }
});

test("S6 결과를 모르는 전송은 새 앱과 같은 낱말 '알 수 없음'으로 보인다", async ({ page }) => {
  await page.goto(url("/"));
  const text = await page.locator("#runbox").innerText({ timeout: 8_000 });
  expect(text).toContain("알 수 없음");
});

test("S7 인쇄 회귀: 인쇄 화면에서도 본문(h1)이 남고 가로로 넘치지 않는다", async ({ page }) => {
  await page.goto(url("/"));
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("h1").first()).toBeVisible();
  const overflow = Number(await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth"));
  expect(overflow).toBeLessThanOrEqual(1);
});

test("S8 ask 폼·허브 화면 글자에도 Go 낱말이 없다", async ({ page }) => {
  for (const path of ["/ask-plan-start.html", "/"]) {
    await page.goto(url(path));
    expect(await page.locator("body").innerText(), path).not.toMatch(/\bGo\b/);
  }
  await page.goto(`${ws.base}/`);
  expect(await page.locator("body").innerText(), "허브").not.toMatch(/\bGo\b/);
});

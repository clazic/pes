// SEL-51 PR18 — Playwright 스모크 (tester, 작성 모드). 구현 전이므로 일부는 실패하는 것이 정상이다.
//
// 임시 HOME·USERPROFILE·PES_HOME 의 합성 DB 프로젝트(project.json 없음)를 PES_DB_CORE=1 로 serve.py 가 서빙하고, Chromium 으로 열어
// 질문 답 제출·승인·보고서 열기·초안 보존·안전한 Markdown·인쇄 CSS·run 표시를 본다. 픽셀 기준선은 없다.
// 브라우저가 없으면 건너뛰지 않고 실패한다(첫 시험). 설치: npx playwright install chromium
//
// 이 시험이 고정하는 해석(보고서의 '해석 n'과 tests/test_web_parity.test.ts 머리말의 번호를 잇는다):
//   해석 13 화면이 쓰는 길은 같은 출처의 `POST feedback`(질문 답·승인·다시 열기) 한 길이고, 성공 표시는 서버의 영수증({ok:true, file:<이름>}) 뒤에만 한다.
//   해석 14 보내기가 실패(충돌 409·시간 초과·서버 오류)하거나 /version 이 실패(커서 무효 410)해도 입력 중인 초안은 지워지지 않고 화면도 다시 불러오지 않는다.
//           409 는 사용자에게 "충돌/바뀌/새 판/다시" 중 하나가 담긴 안내를 보인다.
//   해석 15 초안은 sessionStorage 에 두고(F04) 같은 탭에서 다시 불러오면 복원된다. 서버 영수증을 받은 제출 뒤에는 그 초안을 지운다.
//   해석 16 안전한 Markdown: 항목·보고서의 스크립트·javascript: 링크·onerror 이미지가 실행되거나 링크·요소로 살아나지 않는다(글자로만 보인다).
//   해석 17 run·Go 최소 표시(대시보드 본문 글자): 실행 중 run → "실행 중", 사람 대기 run → "기다리|대기", 송신 중 → "전송 중|송신 중|보내는 중",
//           결과 미확인(unknown) → "확인 불가|알 수 없|확인되지|미확인|불명".
//   해석 18 인쇄 CSS(print 미디어): 단계 보고서 .bar·nav.toc, 최종 보고서 .globalbar·.bar·nav.toc, eli5 .globalbar·.back 는 숨겨지고 본문은 남는다.
import { chromium, expect, test, type Page } from "@playwright/test";

import { open_workspace, type Workspace } from "./helpers/workspace.ts";

// 시험마다 따로 판정한다(앞 시험이 실패해도 뒤 시험은 돈다). 같은 작업 공간을 쓰므로 처리 대기 수는 늘 "전/후 차이"로 본다.
let ws: Workspace;
test.beforeAll(async () => {
  ws = await open_workspace();
});
test.afterAll(async () => {
  await ws?.close();
});

const url = (path: string): string => `${ws.base}/${ws.slug}${path}`;

async function no_dialogs(page: Page): Promise<string[]> {
  const seen: string[] = [];
  page.on("dialog", async (d) => {
    seen.push(d.message());
    await d.dismiss();
  });
  return seen;
}

function feedback_posts(page: Page): string[] {
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/feedback$/.test(new URL(r.url()).pathname)) posts.push(r.url());
  });
  return posts;
}

test("E0 Chromium 이 설치돼 있다 — 없으면 건너뛰지 않고 실패한다 (CI 계약)", async () => {
  const browser = await chromium.launch();
  await browser.close();
});

test("E1 홈 목록에서 프로젝트를 열면 같은 URL(/<slug>/) 대시보드가 뜬다", async ({ page }) => {
  await page.goto(`${ws.base}/`);
  const link = page.locator(`a[href*="${ws.slug}"]`).first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/${ws.slug}/`));
  await expect(page.locator("h1").first()).toContainText("합성 파일 주제");
});

test("E2 대시보드: 단계 탭·딥링크(#plan-item-N)·항목×라운드·타임라인", async ({ page }) => {
  await page.goto(url("/#plan"));
  await expect(page.locator("#app")).toContainText("합성 기획 항목 하나");
  await expect(page.locator("#mxbox")).toBeVisible();
  await page.locator('[data-stage="research"]').first().click();
  await expect(page).toHaveURL(/#research$/);
  await page.goto(url("/#plan-item-1"));
  await expect(page.locator("#plan-item-1")).toHaveClass(/target/);
  expect(await page.locator("#app").innerText()).toMatch(/R1/);
});

test("E3 질문 폼: 추천 미리 선택·show_if·필수·__other 로 답을 제출하면 서버 영수증 뒤에 '보냈습니다'가 뜬다", async ({ page }) => {
  const before = ws.pending().length;
  const posts = feedback_posts(page);
  await page.goto(url("/ask-plan-start.html"));
  await expect(page.locator("#send")).toBeVisible();
  await expect(page.locator('input[data-q="scope"][value="narrow"]')).toBeChecked(); // 추천
  await expect(page.locator('.q[data-qid="why-wide"]')).toHaveClass(/hidden/); // show_if
  await page.locator('input[data-q="scope"][value="wide"]').check();
  await expect(page.locator('.q[data-qid="why-wide"]')).not.toHaveClass(/hidden/);
  await page.locator("#send").click(); // 필수 질문(memo) 비어 있음
  await expect(page.locator("#toast")).toContainText("필수");
  expect(posts.length, "필수가 비어 있으면 서버로 보내지 않는다").toBe(0);
  await page.locator('input[data-q="why-wide"]').fill("합성 이유");
  await page.locator('textarea[data-q="memo"]').fill("합성 메모");
  await page.locator('input[data-qo="scope"]').fill("합성 기타");
  const request = page.waitForRequest((r) => r.method() === "POST" && /\/feedback$/.test(new URL(r.url()).pathname));
  await page.locator("#send").click();
  const body = (await request).postDataJSON();
  expect(body.answers).toMatchObject({ scope: "wide", channels: ["web"], "why-wide": "합성 이유", memo: "합성 메모", scope__other: "합성 기타" });
  expect(body.spec).toBe("plan-start");
  await expect(page.locator("#send")).toContainText("보냈습니다");
  await expect.poll(() => ws.pending().length).toBe(before + 1);
});

test("E4 승인: 모달에서 승인하면 처리 대기 한 건이 쌓이고 단계는 아직 승인되지 않는다", async ({ page }) => {
  const before = ws.pending().length;
  await page.goto(url("/#plan"));
  await expect(page.locator("#send")).toBeVisible();
  await page.locator("#approve").click();
  await expect(page.locator("#modal")).toHaveClass(/on/);
  await page.locator("#mok").click();
  await expect(page.locator("#toast")).toContainText("승인을 보냈습니다");
  await expect.poll(() => ws.pending().length).toBe(before + 1);
  expect(ws.pes(["status", ws.slug]).stdout).not.toMatch(/기획[^\n]*승인됨|plan[^\n]*approved/);
});

test("E5 초안 보존: 입력 중 새 결과가 와도 다시 불러오지 않고, 보내기 실패(충돌·시간 초과·서버 오류)에도 초안이 남는다", async ({ page }) => {
  await page.clock.install();
  let v = 1;
  await page.route("**/version", (route) => route.fulfill({ json: { v } }));
  await Promise.all([page.waitForResponse(/\/version/), page.goto(url("/ask-plan-start.html"))]);
  await page.evaluate("window.__marker = 1");
  const free = page.locator("#free");
  await free.fill("합성 초안 하나");
  v = 2;
  await page.clock.runFor(11_000);
  await expect(page.locator("#pes-live")).toBeVisible(); // 알림만
  expect(await page.evaluate("window.__marker")).toBe(1); // 다시 불러오지 않았다
  await expect(free).toHaveValue("합성 초안 하나");

  // 커서 무효(410): 오류가 나도 화면은 그대로
  await page.unroute("**/version");
  await page.route("**/version", (route) => route.fulfill({ status: 410, json: { error: { code: "cursor_invalid" } } }));
  await page.clock.runFor(11_000);
  expect(await page.evaluate("window.__marker")).toBe(1);
  await expect(free).toHaveValue("합성 초안 하나");

  await page.locator('textarea[data-q="memo"]').fill("합성 메모");
  const attempts: Array<[string, (r: import("@playwright/test").Route) => Promise<void>]> = [
    ["충돌 409", (r) => r.fulfill({ status: 409, json: { ok: false, error: "conflict" } })],
    ["시간 초과", (r) => r.abort("timedout")],
    ["서버 오류 500", (r) => r.fulfill({ status: 500, json: { ok: false } })],
    ["영수증 없는 200", (r) => r.fulfill({ status: 200, json: { ok: true } })],
  ];
  for (const [name, handler] of attempts) {
    await page.unroute("**/feedback");
    await page.route("**/feedback", handler);
    await page.locator("#send").click();
    await expect(page.locator("#send"), `${name}: 성공 표시가 없다`).not.toContainText("보냈습니다");
    await expect(page.locator("#send"), `${name}: 다시 보낼 수 있다`).toBeEnabled();
    await expect(free, `${name}: 초안이 남는다`).toHaveValue("합성 초안 하나");
    await expect(page.locator('textarea[data-q="memo"]')).toHaveValue("합성 메모");
    if (name === "충돌 409") await expect(page.locator("#toast")).toContainText(/충돌|바뀌|새 판|다시/);
  }
  // 영수증을 받으면 성공이고, 그 초안은 지워진다
  await page.unroute("**/feedback");
  await page.route("**/feedback", (r) => r.fulfill({ status: 200, json: { ok: true, file: "plan-R0-20260101-000000.json" } }));
  await page.locator("#send").click();
  await expect(page.locator("#send")).toContainText("보냈습니다");
  await page.unroute("**/version");
  await page.reload();
  await expect(page.locator("#free")).toHaveValue("");
});

test("E6 초안 복원: 같은 탭에서 다시 불러와도 입력 중이던 답이 남는다 (sessionStorage)", async ({ page }) => {
  await page.goto(url("/ask-plan-start.html"));
  await page.locator("#free").fill("합성 복원 초안");
  await page.locator('textarea[data-q="memo"]').fill("합성 복원 메모");
  await page.locator('input[data-q="scope"][value="wide"]').check();
  await page.reload();
  await expect(page.locator("#free")).toHaveValue("합성 복원 초안");
  await expect(page.locator('textarea[data-q="memo"]')).toHaveValue("합성 복원 메모");
  await expect(page.locator('input[data-q="scope"][value="wide"]')).toBeChecked();
});

test("E7 안전한 Markdown: 대시보드 항목의 스크립트·javascript: 링크·onerror 이미지가 살아나지 않는다", async ({ page }) => {
  const dialogs = await no_dialogs(page);
  await page.goto(url("/#plan"));
  await expect(page.locator("#app")).toContainText("악성 항목");
  await page.goto(url("/#plan-item-9"));
  await page.waitForTimeout(500);
  expect(await page.evaluate("window.__pwned")).toBeUndefined();
  expect(dialogs).toEqual([]);
  expect(await page.locator('a[href^="javascript:" i]').count()).toBe(0);
  expect(await page.locator("#app script").count()).toBe(0);
  expect(await page.locator("#app img[onerror]").count()).toBe(0);
  expect(await page.locator("#app [onerror], #app [onclick]").count()).toBe(0);
});

test("E8 보고서: 대시보드가 가리키는 같은 URL 로 열리고, 악성 입력은 글자로만 보이며, 인쇄 CSS 가 도구 막대를 숨긴다", async ({ page }) => {
  const dialogs = await no_dialogs(page);
  await page.goto(url("/#plan"));
  const href = await page.locator('a[href$="reports/plan/report.html"]').first().getAttribute("href", { timeout: 8_000 });
  expect(href).toBeTruthy();
  await page.goto(new URL(href as string, url("/")).toString());
  await expect(page.locator("h1").first()).toContainText(/기획|합성 파일 주제/);
  await expect(page.locator("article, #doc")).toContainText("합성 기획 항목 하나");
  expect(await page.evaluate("window.__pwned")).toBeUndefined();
  expect(dialogs).toEqual([]);
  expect(await page.locator('a[href^="javascript:" i]').count()).toBe(0);
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".bar")).toBeHidden();
  await expect(page.locator("nav.toc")).toBeHidden();
  await expect(page.locator("h1").first()).toBeVisible();
});

test("E9 eli5·최종 보고서도 같은 URL 로 열리고 인쇄 CSS 가 적용된다", async ({ page }) => {
  await page.goto(url("/reports/plan/eli5.html"));
  await expect(page.locator("h1")).toContainText("합성 그림 설명");
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".globalbar")).toBeHidden();
  await expect(page.locator(".back")).toBeHidden();
  await expect(page.locator("h1")).toBeVisible();
  await page.emulateMedia({ media: "screen" });
  await page.goto(url("/out/report.html"));
  await expect(page.locator("article")).toContainText("첫 장 본문입니다");
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".globalbar")).toBeHidden();
  await expect(page.locator("nav.toc")).toBeHidden();
  await expect(page.locator("article")).toBeVisible();
});

test("E10 run·Go 최소 표시: 실행 중·사람 대기·송신 중·결과 미확인(unknown)이 글자로 보인다", async ({ page }) => {
  await page.goto(url("/"));
  const text = await page.locator("#app").innerText({ timeout: 8_000 });
  expect(text, "실행 중 run").toMatch(/실행 중/);
  expect(text, "사람을 기다리는 run").toMatch(/기다리|대기/);
  expect(text, "송신 중(in-flight) Go 호출").toMatch(/전송 중|송신 중|보내는 중/);
  expect(text, "결과를 모르는(unknown) Go 호출").toMatch(/확인 불가|알 수 없|확인되지|미확인|불명/);
});

test("E11 원격 Origin·CSRF: 다른 출처에서 온 답은 브라우저에서도 거절되고 아무것도 쌓이지 않는다", async ({ page, request }) => {
  const before = ws.pending().length;
  const evil = await request.post(url("/feedback"), {
    headers: { Origin: "http://evil.example", "Content-Type": "text/plain" },
    data: JSON.stringify({ stage: "plan", round: 0, kind: "feedback", text: "합성 침입", answers: {} }),
  });
  expect(evil.status()).toBe(403);
  const none = await request.post(url("/feedback"), { data: { stage: "plan", round: 0, kind: "feedback", text: "합성 침입", answers: {} } });
  expect([403, 400]).toContain(none.status());
  // 페이지 안의 다른 출처 요청도 허용되지 않는다 (같은 출처 정책 + Origin 검사)
  await page.goto(url("/"));
  const cross = await page.evaluate(async (target) => {
    try {
      const r = await fetch(target, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: "{}" });
      return r.type;
    } catch {
      return "blocked";
    }
  }, "http://127.0.0.1:1/feedback");
  expect(["opaque", "blocked"]).toContain(cross);
  expect(ws.pending().length).toBe(before);
});

test("E12 소유자 세션 비밀은 브라우저가 받은 어떤 응답에도 없다", async ({ page }) => {
  const bodies: string[] = [];
  page.on("response", async (r) => {
    try {
      bodies.push(await r.text(), JSON.stringify(await r.allHeaders()));
    } catch {
      // body not available (redirect, etc.)
    }
  });
  await page.goto(`${ws.base}/`);
  await page.goto(url("/"));
  await page.goto(url("/ask-plan-start.html"));
  await page.waitForTimeout(500);
  expect(bodies.join("\n")).not.toContain("synthetic-owner-session-secret-sel51-e2e");
  expect(await page.evaluate("JSON.stringify([localStorage, sessionStorage, document.cookie])")).not.toContain("synthetic-owner-session-secret");
});

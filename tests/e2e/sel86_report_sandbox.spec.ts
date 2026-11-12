// SEL-86 U1b 후속 B — 보고서·산출물 HTML 의 CSP sandbox 를 실제 브라우저로 본다 (Playwright, tester 작성 모드). 구현 전이라 실패가 정상.
//
// 임시 HOME·USERPROFILE·PES_HOME 의 합성 DB 프로젝트를 serve.ts 가 서빙하고(PES_APP_DIR = 앱 production 빌드 app/dist), 앱을 `pes open --app` 식
// 조각 주소로 연다. 앱이 sessionStorage 에 세션을 둔 뒤, **같은 탭에서** 보고서 주소로 옮겨 간다 — 보고서 문서 안의 스크립트가 무엇을 못 읽는지 본다.
//
// 스스로 정한 해석:
//   - 보고서 문서는 불투명 출처가 된다: window.origin === "null", sessionStorage·localStorage 접근이 SecurityError 로 던져진다,
//     같은 출처 /api/ 로의 fetch 는 (CORS 가 없으므로) 거절된다. 세션 값이 문서 안 어디에서도 읽히지 않는다.
//   - 보고서 자신의 스크립트는 그대로 돈다: 단계 보고서·최종 보고서의 본문(#doc)이 그려지고, eli5 가 그려지고, ?print=1 이면 load 뒤 print() 를 부른다.
//     (headless 에서 진짜 인쇄 창이 안 뜨므로 addInitScript 로 window.print 를 세는 가짜로 바꾼다 — 가짜는 sandbox 와 무관하다. 대신 allow-modals 는
//      alert 대화상자로, allow-popups 는 window.open 팝업으로, allow-downloads 는 download 링크로 실제 확인한다.)
//   - 앱(/p/<slug>/…)은 sandbox 가 아니라 평소처럼 같은 출처이며 CSP 위반(securitypolicyviolation)이 0이다.
//   - 대시보드·ask 폼은 기존처럼 같은 출처에서 돈다(sessionStorage 쓰기·읽기 가능, 위반 0).
// 앞 조건: cd app && npm ci && npm run build. 없으면 건너뛰지 않고 실패한다(CI 계약).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

import { REPO, open_workspace, type Workspace } from "./helpers/workspace.ts";

// page.evaluate 의 함수 본문은 브라우저에서 돈다 — 이 저장소 tsconfig 에는 DOM 형이 없어 쓰는 전역만 선언한다
declare const window: any;
declare const document: any;
declare const location: any;
declare const sessionStorage: any;
declare const localStorage: any;
declare function alert(message: string): void;

const DIST = join(REPO, "app", "dist");

let ws: Workspace;
test.beforeAll(async () => {
  expect(existsSync(join(DIST, "index.html")), "앱 빌드가 없다 — cd app && npm ci && npm run build 를 먼저 한다(app/dist/index.html)").toBe(true);
  ws = await open_workspace({ PES_APP_DIR: DIST });
});
test.afterAll(async () => {
  await ws?.close();
});

const report = (path: string): string => `${ws.base}/${ws.slug}/${path}`;
const REPORT_PAGES = ["reports/plan/report.html", "reports/plan/eli5.html", "out/report.html"];

/** 모든 문서(보고서 포함)에 심는 것: window.print 를 세는 가짜로, CSP 위반을 모은다. */
async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as any;
    w.__printed = 0;
    w.print = () => {
      w.__printed += 1;
    };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e: any) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
}

/** 앱을 pes open --app 식 조각 주소로 열어 sessionStorage 에 세션이 들어갈 때까지 기다린다. */
async function open_app_with_session(page: Page): Promise<void> {
  await page.goto(ws.open_app());
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
  await expect
    .poll(() => page.evaluate((secret) => Object.keys(sessionStorage).some((k) => (sessionStorage.getItem(k) ?? "").includes(secret)), ws.session), { message: "앱이 세션을 같은 탭 sessionStorage 에 둔다" })
    .toBe(true);
}

test("P0 앞 조건: 보고서 세 주소(단계 보고서·eli5·최종 보고서)가 200 text/html 이고 sandbox 헤더(allow-same-origin 없음)를 갖는다", async () => {
  for (const path of REPORT_PAGES) {
    const res = await fetch(report(path));
    expect(res.status, path).toBe(200);
    expect(res.headers.get("content-type"), path).toMatch(/^text\/html/);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp, `${path}: CSP 헤더`).toMatch(/\bsandbox\b/);
    expect(csp, path).toMatch(/\ballow-scripts\b/);
    expect(csp, path).not.toMatch(/allow-same-origin/);
  }
});

for (const path of REPORT_PAGES) {
  test(`B1 같은 탭에서 앱 → ${path}: 보고서 문서는 불투명 출처라 sessionStorage·localStorage·같은 출처 API 를 읽지 못하고, 세션 값이 어디에도 없다`, async ({ page }) => {
    await instrument(page);
    await open_app_with_session(page);
    // 같은 탭에서 보고서 주소로 옮겨 간다 (앱 안에는 링크가 없어 주소창에 직접 치는 경우)
    await page.goto(report(path));
    const probe = await page.evaluate(
      async ({ api, session }) => {
        const out: Record<string, unknown> = { origin: window.origin, locationOrigin: location.origin };
        for (const kind of ["sessionStorage", "localStorage"] as const) {
          try {
            out[kind] = `읽힘:${(window as any)[kind].length}`;
          } catch (e) {
            out[kind] = `던짐:${(e as Error).name}`;
          }
        }
        try {
          const res = await fetch(api, { headers: { "x-pes-session": session } });
          out.api = `응답:${res.status}`;
        } catch (e) {
          out.api = `거절:${(e as Error).name}`;
        }
        try {
          const res = await fetch(api.replace(/\/workspace$/, "/workspace"), { credentials: "include" });
          out.api_plain = `응답:${res.status}`;
        } catch (e) {
          out.api_plain = `거절:${(e as Error).name}`;
        }
        out.has_session_text = document.documentElement.outerHTML.includes(session);
        return out;
      },
      { api: `${ws.base}/api/v1/projects/${ws.project_id}/workspace`, session: ws.session },
    );
    expect(probe.origin, "불투명 출처").toBe("null");
    expect(probe.sessionStorage, "sessionStorage").toMatch(/^던짐:SecurityError$/);
    expect(probe.localStorage, "localStorage").toMatch(/^던짐:SecurityError$/);
    expect(probe.api, "세션 헤더를 단 같은 출처 API fetch").toMatch(/^거절:/);
    expect(probe.api_plain, "헤더 없는 같은 출처 fetch 도 응답을 읽지 못한다").toMatch(/^거절:/);
    expect(probe.has_session_text).toBe(false);
  });
}

test("B2 되돌아오면 앱의 sessionStorage 는 그대로다(보고서 방문이 앱 쪽 저장을 지우지 않는다)", async ({ page }) => {
  await instrument(page);
  await open_app_with_session(page);
  await page.goto(report("reports/plan/report.html"));
  await page.goBack();
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
  expect(await page.evaluate((secret) => Object.keys(sessionStorage).some((k) => (sessionStorage.getItem(k) ?? "").includes(secret)), ws.session)).toBe(true);
});

test("R1 sandbox 된 보고서 안의 스크립트 자체는 돈다: 단계 보고서·최종 보고서 본문(#doc)과 eli5 가 그려지고 CSP 위반이 0이다", async ({ page }) => {
  await instrument(page);
  for (const path of ["reports/plan/report.html", "out/report.html"]) {
    await page.goto(report(path));
    await expect(page.locator("#doc")).not.toBeEmpty();
    await expect(page.locator("#doc")).toContainText(/\S/);
    expect(await page.evaluate(() => (window as any).__csp), `${path}: 위반 0 (sandbox 는 위반 이벤트가 아니다)`).toEqual([]);
  }
  await page.goto(report("reports/plan/eli5.html"));
  await expect(page.locator("#app")).not.toBeEmpty();
  await expect(page.locator("#app")).toContainText("합성");
});

test("R2 보고서 안의 인쇄 버튼(onclick)이 돈다 — 단계 보고서 '인쇄·PDF', 최종 보고서 '인쇄·PDF', eli5 '인쇄·PDF'", async ({ page }) => {
  await instrument(page);
  for (const path of ["reports/plan/report.html", "out/report.html", "reports/plan/eli5.html"]) {
    await page.goto(report(path));
    const button = page.getByText("인쇄·PDF").first();
    await expect(button, path).toBeVisible();
    const before = await page.evaluate(() => (window as any).__printed);
    await button.click();
    await expect.poll(() => page.evaluate(() => (window as any).__printed), { message: `${path}: 버튼이 print() 를 부른다` }).toBe(before + 1);
  }
});

test("R3 ?print=1: 세 보고서 모두 load 뒤 print() 를 한 번 부르고, ?print=1 이 없으면 부르지 않는다", async ({ page }) => {
  await instrument(page);
  for (const path of REPORT_PAGES) {
    await page.goto(report(`${path}?print=1`));
    await expect.poll(() => page.evaluate(() => (window as any).__printed), { message: `${path}?print=1`, timeout: 6_000 }).toBeGreaterThanOrEqual(1);
    expect(await page.evaluate(() => window.origin), "인쇄 주소도 sandbox").toBe("null");
    await page.goto(report(path));
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => (window as any).__printed), `${path}: 인쇄 쿼리 없음 → print 안 부름`).toBe(0);
  }
});

test("S1 sandbox 의 허용 목록 실제 확인: allow-modals(alert 대화상자)·allow-popups(window.open)·allow-downloads(download 링크) 가 막히지 않는다", async ({ page }) => {
  await instrument(page);
  await page.goto(report("reports/plan/report.html"));
  const dialogs: string[] = [];
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    await d.dismiss();
  });
  await page.evaluate(() => alert("sel86-modal"));
  expect(dialogs, "allow-modals: alert 가 대화상자를 연다").toEqual(["sel86-modal"]);

  const [popup] = await Promise.all([page.waitForEvent("popup", { timeout: 5_000 }), page.evaluate(() => void window.open("about:blank"))]);
  expect(popup, "allow-popups: window.open 이 새 창을 연다").toBeTruthy();
  await popup.close();

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 5_000 }),
    page.evaluate(() => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(["sel86 download"], { type: "text/plain" }));
      a.download = "sel86.txt";
      document.body.append(a);
      a.click();
    }),
  ]);
  expect(download.suggestedFilename(), "allow-downloads").toBe("sel86.txt");
});

test("S2 sandbox 에서도 보고서 안 링크(대시보드로, 마크다운으로)는 열린다 — 보고서 화면 이동이 막히지 않는다", async ({ page }) => {
  await instrument(page);
  await page.goto(report("reports/plan/report.html"));
  await page.getByRole("link", { name: "마크다운" }).first().click();
  await expect(page).toHaveURL(/reports\/plan\/report\.md$/);
});

test("A1 앱(/p/<slug>/…)은 sandbox 가 아니다 — 같은 출처에서 정상으로 뜨고 CSP 위반(script-src 'self')이 0이며 인라인 스크립트가 없다", async ({ page }) => {
  await instrument(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (/content security policy|refused to (execute|load|apply)/i.test(m.text())) errors.push(m.text());
  });
  await open_app_with_session(page);
  expect(await page.evaluate(() => window.origin)).toBe(new URL(ws.base).origin);
  expect(await page.evaluate(() => (window as any).__csp), "앱 CSP 위반 0").toEqual([]);
  expect(errors).toEqual([]);
  // 인라인 스크립트가 없다 (script-src 'self' 와 맞는다)
  expect(await page.evaluate(() => Array.from(document.scripts).filter((s: any) => !s.src && s.textContent?.trim()).length)).toBe(0);
  // 인쇄 화면도 평소처럼
  const u = new URL(ws.open_app());
  u.search = "?print=1";
  await page.goto(u.href);
  await expect(page.getByRole("region", { name: "인쇄 미리보기" })).toBeVisible();
});

test("A2 앱 index 는 'self' 가 아닌 곳의 스크립트를 실행하지 않는다 (script-src 'self' 실제 집행)", async ({ page }) => {
  await instrument(page);
  await open_app_with_session(page);
  const ran = await page.evaluate(async () => {
    (window as any).__x = 0;
    const s = document.createElement("script");
    s.textContent = "window.__x = 1";
    document.head.append(s);
    const e = document.createElement("script");
    e.src = "data:text/javascript,window.__x = 2";
    document.head.append(e);
    await new Promise((r) => setTimeout(r, 300));
    return (window as any).__x;
  });
  expect(ran, "인라인·data: 스크립트는 실행되지 않는다").toBe(0);
  expect((await page.evaluate(() => (window as any).__csp)).length, "위반 이벤트가 생긴다").toBeGreaterThan(0);
});

test("D1 기존 서버 페이지 회귀: 대시보드와 ask 폼은 같은 출처에서 그대로 돈다(스크립트가 그려지고 sessionStorage 를 쓰며 위반 0)", async ({ page }) => {
  await instrument(page);
  await page.goto(`${ws.base}/${ws.slug}/`);
  await expect(page.locator("h1").first()).toBeVisible();
  expect(await page.evaluate(() => window.origin)).toBe(new URL(ws.base).origin);
  expect(await page.evaluate(() => {
    sessionStorage.setItem("sel86", "1");
    return sessionStorage.getItem("sel86");
  })).toBe("1");
  expect(await page.evaluate(() => (window as any).__csp)).toEqual([]);
  await page.goto(`${ws.base}/${ws.slug}/ask-plan-start.html`);
  await expect(page.locator("form, [data-q], .q").first()).toBeVisible();
  expect(await page.evaluate(() => window.origin)).toBe(new URL(ws.base).origin);
  expect(await page.evaluate(() => (window as any).__csp)).toEqual([]);
  await page.goto(`${ws.base}/`);
  await expect(page.locator("a[href*='" + ws.slug + "']").first()).toBeVisible();
  expect(await page.evaluate(() => (window as any).__csp)).toEqual([]);
});

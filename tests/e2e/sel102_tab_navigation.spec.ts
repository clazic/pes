// SEL-102 — 보고서의 자기 탭 이동 우회를 실제 브라우저로 본다 (Playwright, tester 작성 모드, 보안). 구현 전이라 실패가 정상.
// 근거: SEL-86-final-review-1.md 권장 1(재현: /app 의 sessionStorage → 같은 탭에서 sandbox 된 /r → location.href='/evil' → /evil 이 SECRET 를 읽음) · 권장 2.
//
// 임시 HOME·USERPROFILE·PES_HOME 의 합성 DB 프로젝트(tests/e2e/helpers/workspace.ts, PES_APP_DIR = 앱 production 빌드 app/dist)를 serve.ts 가 서빙한다.
// 프로젝트 폴더(<PES 홈>/<slug>/)에 에이전트가 쓸 수 있는 임의 파일을 둔다: notes/x.html · notes/y.svg · notes/z.xml · notes/evil.js · 홈 루트의 loose.html.
//
// 스스로 정한 해석:
//   - "읽지 못한다" = 그 문서의 window.origin 이 "null"(불투명 출처)이고 sessionStorage·localStorage 접근이 SecurityError 로 던져지고 문서 어디에도 세션 값이 없다.
//   - 보고서 문서 안의 스크립트가 location.href 로 같은 탭을 폴더의 임의 HTML/SVG/XML 로 옮기는 것은 막지 않는다(sandbox 의 자기 탭 이동은 허용 토큰과 무관하게 열려 있다).
//     막는 것은 도착한 페이지가 sandbox 라는 사실이다. 도착한 페이지 자신의 스크립트는 allow-scripts 로 계속 돈다.
//   - 앱 index 는 폴더의 .js 를 싣지 못한다(script-src 가 /_app/ 로 좁혀짐): 주입한 <script src=/<slug>/notes/evil.js> 는 실행되지 않고 위반 이벤트가 생긴다.
//     <base> 주입은 무시되고(base-uri 'none') <object>/<embed> 는 막힌다(object-src 'none'). 그러면서 앱 자신은 평소처럼 뜨고 로드 시점 위반은 0이다.
//   - 회귀: 옛 대시보드·ask 폼·허브는 같은 출처 그대로, <img> 로 넣은 svg 는 보이고, 인쇄(?print=1) 보고서는 sandbox 에서 돈다.
// 앞 조건: cd app && npm ci && npm run build. 없으면 건너뛰지 않고 실패한다(CI 계약).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

import { REPO, open_workspace, type Workspace } from "./helpers/workspace.ts";

// page.evaluate 의 함수 본문은 브라우저에서 돈다 — 이 저장소 tsconfig 에는 DOM 형이 없어 쓰는 전역만 선언한다
declare const window: any;
declare const document: any;
declare const location: any;
declare const sessionStorage: any;
declare const localStorage: any;

const DIST = join(REPO, "app", "dist");

/** 도착한 페이지가 하는 일: 자기 출처와 저장소 접근 결과를 #probe 에 JSON 으로 적는다 (HTML·SVG·XML 모두 같은 스크립트). */
const PROBE = `
var out = { origin: window.origin };
["sessionStorage", "localStorage"].forEach(function (k) {
  try { out[k] = "읽힘:" + window[k].length + ":" + Object.keys(window[k]).map(function (n) { return window[k].getItem(n); }).join("|"); } catch (e) { out[k] = "던짐:" + e.name; }
});
out.ran = true;
window.__probe = out;
`;
const HTML_PROBE = `<!doctype html><html><head><meta charset="utf-8"><title>노트</title></head><body><p id="probe">대기</p><script>${PROBE}document.getElementById("probe").textContent = JSON.stringify(out);</script></body></html>`;
const SVG_PROBE = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="teal"/><script>${PROBE}</script></svg>`;
const XML_PROBE = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>xml</p><script>${PROBE}</script></body></html>`;
const EVIL_JS = `window.__evil = 1; try { sessionStorage.setItem("__evil", "1"); } catch (e) {}`;

let ws: Workspace;
let folder: string;
let home: string;

test.beforeAll(async () => {
  expect(existsSync(join(DIST, "index.html")), "앱 빌드가 없다 — cd app && npm ci && npm run build 를 먼저 한다(app/dist/index.html)").toBe(true);
  ws = await open_workspace({ PES_APP_DIR: DIST });
  const out = ws.pes(["home"]);
  const m = /PES 홈:\s*(.+?)\s{2}\(/.exec(out.stdout);
  expect(m, `pes home 출력에서 PES 홈 경로를 읽는다: ${out.stdout}`).not.toBeNull();
  home = (m as RegExpExecArray)[1] as string;
  folder = join(home, ws.slug);
  expect(existsSync(folder), "프로젝트 폴더").toBe(true);
  mkdirSync(join(folder, "notes"), { recursive: true });
  writeFileSync(join(folder, "notes", "x.html"), HTML_PROBE, "utf8");
  writeFileSync(join(folder, "notes", "y.svg"), SVG_PROBE, "utf8");
  writeFileSync(join(folder, "notes", "z.xml"), XML_PROBE, "utf8");
  writeFileSync(join(folder, "notes", "evil.js"), EVIL_JS, "utf8");
  writeFileSync(join(home, "loose.html"), HTML_PROBE, "utf8");
});
test.afterAll(async () => {
  await ws?.close();
});

const at = (path: string): string => `${ws.base}/${ws.slug}/${path}`;
const REPORT = "reports/plan/report.html";
const TARGETS = [
  { name: "프로젝트 폴더 notes/x.html", url: () => at("notes/x.html") },
  { name: "프로젝트 폴더 notes/y.svg", url: () => at("notes/y.svg") },
  { name: "프로젝트 폴더 notes/z.xml", url: () => at("notes/z.xml") },
  { name: "홈 루트 loose.html", url: () => `${ws.base}/loose.html` },
];

async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as any;
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e: any) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
}

const has_session = (page: Page): Promise<boolean> =>
  page.evaluate((secret) => Object.keys(sessionStorage).some((k) => (sessionStorage.getItem(k) ?? "").includes(secret)), ws.session);

async function open_app_with_session(page: Page): Promise<void> {
  await page.goto(ws.open_app());
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
  await expect.poll(() => has_session(page), { message: "앱이 세션을 같은 탭 sessionStorage 에 둔다" }).toBe(true);
}

test("P0 앞 조건: 폴더의 임의 파일을 정적 폴백이 그대로 내준다(200) — 시험 재료가 서 있다", async () => {
  for (const t of TARGETS) {
    const res = await fetch(t.url());
    expect(res.status, t.name).toBe(200);
    await res.arrayBuffer();
  }
});

for (const target of TARGETS) {
  test(`E1 재현(권장 1): 앱 세션을 든 탭 → 보고서 → 보고서 스크립트가 location.href 로 ${target.name} 으로 탭을 옮겨도 도착한 페이지는 sessionStorage 를 못 읽는다`, async ({ page }) => {
    await instrument(page);
    await open_app_with_session(page);
    await page.goto(at(REPORT));
    expect(await page.evaluate(() => window.origin), "보고서는 불투명 출처").toBe("null");
    // 보고서 안의 스크립트(= 조작된 보고서)가 같은 탭을 옮긴다
    await page.evaluate((to) => {
      location.href = to;
    }, target.url());
    await page.waitForURL(target.url());
    await expect.poll(() => page.evaluate(() => (window as any).__probe?.ran === true), { message: "도착한 페이지의 스크립트는 allow-scripts 로 돈다" }).toBe(true);
    const probe = await page.evaluate(() => (window as any).__probe);
    expect(probe.origin, `${target.name}: 도착한 페이지도 불투명 출처 (sandbox)`).toBe("null");
    expect(probe.sessionStorage, "sessionStorage").toBe("던짐:SecurityError");
    expect(probe.localStorage, "localStorage").toBe("던짐:SecurityError");
    expect(JSON.stringify(probe), "페이지가 본 것 어디에도 세션 값이 없다").not.toContain(ws.session);
    expect(await page.evaluate((s) => document.documentElement.outerHTML.includes(s), ws.session), "문서에 세션 값이 없다").toBe(false);
  });
}

test("E2 도착한 페이지에서 앱으로 되돌아가도(뒤로 가기) 앱 탭의 sessionStorage 는 그대로, 폴더 페이지는 그 값을 본 적이 없다", async ({ page }) => {
  await instrument(page);
  await open_app_with_session(page);
  await page.goto(at(REPORT));
  await page.evaluate((to) => {
    location.href = to;
  }, at("notes/x.html"));
  await page.waitForURL(at("notes/x.html"));
  await expect.poll(() => page.evaluate(() => (window as any).__probe?.ran === true)).toBe(true);
  expect((await page.evaluate(() => (window as any).__probe)).sessionStorage).toBe("던짐:SecurityError");
  await page.goBack();
  await page.goBack();
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
  expect(await has_session(page), "앱 쪽 저장은 지워지지 않았다").toBe(true);
});

test("E3 폴더 페이지를 주소창으로 바로 열어도(앱 세션 없는 새 탭) 불투명 출처다 — 같은 출처 HTML 이 없다", async ({ page }) => {
  for (const target of TARGETS) {
    await page.goto(target.url());
    await expect.poll(() => page.evaluate(() => (window as any).__probe?.ran === true), { message: target.name }).toBe(true);
    const probe = await page.evaluate(() => (window as any).__probe);
    expect(probe.origin, target.name).toBe("null");
    expect(probe.sessionStorage, target.name).toBe("던짐:SecurityError");
  }
});

test("A1 앱 index: 폴더의 .js 를 싣지 못한다 — 주입한 <script src=/<slug>/notes/evil.js> 는 실행되지 않고 위반 이벤트가 생긴다; <base> 는 무시, <object> 는 막힌다", async ({ page }) => {
  await instrument(page);
  await open_app_with_session(page);
  expect(await page.evaluate(() => (window as any).__csp), "앱이 평소처럼 뜨는 동안 위반 0 (앱 자신의 스크립트는 허용)").toEqual([]);
  const result = await page.evaluate(async (evil) => {
    const w = window as any;
    w.__evil = 0;
    const before = document.baseURI;
    const s = document.createElement("script");
    s.src = evil;
    document.head.append(s);
    const base = document.createElement("base");
    base.href = "/evil-base/";
    document.head.prepend(base);
    const obj = document.createElement("object");
    obj.data = evil;
    obj.type = "text/javascript";
    document.body.append(obj);
    await new Promise((r) => setTimeout(r, 600));
    return { evil: w.__evil, evil_storage: sessionStorage.getItem("__evil"), base_changed: document.baseURI !== before, violations: w.__csp as string[] };
  }, at("notes/evil.js"));
  expect(result.evil, "폴더의 evil.js 는 실행되지 않는다").toBe(0);
  expect(result.evil_storage, "evil.js 가 sessionStorage 를 건드리지 못했다").toBeNull();
  expect(result.violations.some((v) => /^script-src/.test(v)), `script-src 위반 이벤트 (${result.violations.join(" / ")})`).toBe(true);
  expect(result.base_changed, "<base> 주입은 무시된다 (base-uri 'none')").toBe(false);
  expect(result.violations.some((v) => /^base-uri/.test(v)), `base-uri 위반 이벤트 (${result.violations.join(" / ")})`).toBe(true);
  expect(result.violations.some((v) => /^object-src/.test(v)), `object-src 위반 이벤트 (${result.violations.join(" / ")})`).toBe(true);
});

test("A2 앱 자신의 스크립트는 그대로 돈다 — 모든 화면 주소에서 앱이 뜨고 로드 시점 CSP 위반이 0이다 (경로 좁히기가 앱을 깨지 않는다)", async ({ page }) => {
  await instrument(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (/content security policy|refused to (execute|load|apply)/i.test(m.text())) errors.push(m.text());
  });
  await open_app_with_session(page);
  expect(await page.evaluate(() => window.origin)).toBe(new URL(ws.base).origin);
  expect(await page.evaluate(() => (window as any).__csp)).toEqual([]);
  expect(errors).toEqual([]);
  const u = new URL(ws.open_app());
  u.search = "?print=1";
  await page.goto(u.href);
  await expect(page.getByRole("region", { name: "인쇄 미리보기" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("R1 회귀: 옛 대시보드·ask 폼·허브는 같은 출처(sandbox 아님)에서 그대로 돌고 sessionStorage 를 쓴다; 같은 출처 /version fetch 가 된다", async ({ page }) => {
  await instrument(page);
  for (const path of [`${ws.base}/${ws.slug}/`, at("ask-plan-start.html"), `${ws.base}/`]) {
    await page.goto(path);
    expect(await page.evaluate(() => window.origin), path).toBe(new URL(ws.base).origin);
    expect(
      await page.evaluate(() => {
        sessionStorage.setItem("sel102", "1");
        return sessionStorage.getItem("sel102");
      }),
      path,
    ).toBe("1");
    expect(await page.evaluate(() => (window as any).__csp), `${path}: 위반 0`).toEqual([]);
  }
  await page.goto(`${ws.base}/${ws.slug}/`);
  expect(await page.evaluate(async (url) => (await fetch(url)).status, at("version")), "같은 출처 fetch").toBe(200);
});

test("R2 회귀: svg 를 <img> 로 넣은 표시는 그대로 보인다(문서가 아니므로 sandbox 와 무관)", async ({ page }) => {
  await instrument(page);
  await page.goto(`${ws.base}/${ws.slug}/`);
  const shown = await page.evaluate(async (src) => {
    const img = document.createElement("img");
    img.src = src;
    document.body.append(img);
    await new Promise((r) => {
      img.onload = r;
      img.onerror = r;
    });
    return { w: img.naturalWidth, h: img.naturalHeight };
  }, at("notes/y.svg"));
  expect(shown.w, "<img> 의 svg 가 그려진다").toBe(40);
  expect(shown.h).toBe(40);
});

test("N1 폴더의 svg 응답 헤더: sandbox + nosniff (주소로 열면 문서, <img> 는 위 R2 처럼 계속 보인다)", async () => {
  const res = await fetch(at("notes/y.svg"));
  expect(res.headers.get("x-content-type-options")?.toLowerCase(), "정적 폴백 nosniff").toBe("nosniff");
  expect(res.headers.get("content-security-policy") ?? "").toMatch(/\bsandbox\b/);
  await res.arrayBuffer();
});

test("R3 회귀: 보고서(?print=1)는 sandbox 에서 돌고 인쇄 버튼·본문 스크립트가 산다 (SEL-86 동작 유지)", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__printed = 0;
    window.print = () => {
      (window as any).__printed += 1;
    };
  });
  await page.goto(at(`${REPORT}?print=1`));
  await expect.poll(() => page.evaluate(() => (window as any).__printed), { timeout: 6_000 }).toBeGreaterThanOrEqual(1);
  expect(await page.evaluate(() => window.origin)).toBe("null");
  await expect(page.locator("#doc")).not.toBeEmpty();
});

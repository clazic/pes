// SEL-51 PR18 — Playwright 보강 (tester, 보강 모드): 안전한 Markdown 우회 모음, /version 이 이상하게 답해도 초안 보존.
// 합성 DB 프로젝트(tests/e2e/helpers/workspace.ts)만 쓴다. 우회 항목은 round-start 뒤 merge 로 넣는다.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { open_workspace, type Workspace } from "./helpers/workspace.ts";

let ws: Workspace;
const PAYLOADS = [
  "[a](JAVASCRIPT:window.__pwned=1)",
  "[b](JaVaScRiPt:window.__pwned=1)",
  "[c](&#106;avascript:window.__pwned=1)",
  "[d](&#x6A;avascript:window.__pwned=1)",
  "[e](java\tscript:window.__pwned=1)",
  "[f](data:text/html;base64,PHNjcmlwdD53aW5kb3cuX19wd25lZD0xPC9zY3JpcHQ+)",
  "[g](vbscript:msgbox(1))",
  "[h](https:javascript:window.__pwned=1)",
  '[i](https://a.example/"onmouseover="window.__pwned=1)',
  "[j](https://a.example/**x**)",
  "**[k](https://a.example/**",
  "`<img src=x onerror=window.__pwned=1>`",
  "<svg onload=window.__pwned=1></svg>",
  "<svg><script>window.__pwned=1</script></svg>",
  "&lt;img src=x onerror=window.__pwned=1&gt;",
  "&amp;lt;script&amp;gt;window.__pwned=1&amp;lt;/script&amp;gt;",
  "%3Cscript%3Ewindow.__pwned=1%3C/script%3E",
  "<iframe srcdoc='<script>parent.__pwned=1</script>'></iframe>",
  "<a href=javascript:window.__pwned=1>z</a>",
  "| <img src=x onerror=window.__pwned=1> | [t](JAVASCRIPT:window.__pwned=1) |",
];
const BAD = "JAVASCRIPT:window.__pwned=1";
let tmp: string;

test.beforeAll(async () => {
  ws = await open_workspace();
  tmp = mkdtempSync(join(tmpdir(), "pes-e2e-hard-"));
  const text = PAYLOADS.join("\n\n");
  const items = [
    {
      id: 21,
      kind: "topic",
      title: `우회 모음 ${PAYLOADS[0]} <b onmouseover=window.__pwned=1>굵게</b>`,
      summary: text,
      details: text,
      status: "done",
      path: BAD,
      shots: [BAD],
      user_links: [{ url: BAD, title: "x" }, { url: "data:text/html,<script>window.__pwned=1</script>", title: "y" }],
    },
    { id: 22, kind: "topic", title: "공백 경로 항목", summary: "공백이 든 올바른 상대 경로", status: "done", path: "shots/a b.png", shots: ["shots/a b.png", "out/한글 보고서.html", "https://example.org/a b"] },
    { id: 23, kind: "topic", title: "위험 경로 항목", summary: "막아야 하는 경로", status: "done", path: "java\tscript:window.__pwned=1", shots: ["java\tscript:window.__pwned=1", "//evil.example/x.png", "\\\\evil\\share\\x.png", " jAvAsCrIpT:window.__pwned=1"] },
  ];
  const file = join(tmp, "bypass.json");
  writeFileSync(file, JSON.stringify(items), "utf8");
  expect(ws.pes(["round-start", ws.slug, "plan"]).status).toBe(0);
  const merged = ws.pes(["merge", ws.slug, "plan", file]);
  expect(merged.status, merged.stderr + merged.stdout).toBe(0);
});
test.afterAll(async () => {
  await ws?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const url = (path: string): string => `${ws.base}/${ws.slug}${path}`;

// 브라우저 안에서 도는 코드(문자열: 이 저장소의 TS 설정에는 DOM 타입이 없다).
const INERT_SCRIPT = `(() => {
  const out = [];
  for (const el of Array.from(document.querySelectorAll("*"))) {
    const inside = el.closest("#app, #doc, article") !== null && el.closest(".bar, .globalbar, nav") === null; // 템플릿 자신의 단추는 본문 밖
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name) && inside) out.push(el.tagName + "[" + attr.name + "]");
      if (/^(href|src|srcdoc|xlink:href|action|formaction)$/i.test(attr.name) && /^[\\s\\u0000-\\u001f]*(javascript|vbscript|data):/i.test(attr.value.replace(/[\\t\\n\\r]/g, ""))) out.push(el.tagName + "[" + attr.name + "=" + attr.value.slice(0, 40) + "]");
    }
  }
  for (const el of Array.from(document.querySelectorAll("#app script, #app iframe, #app svg, #app object, #app embed, #doc script, #doc iframe, #doc svg"))) out.push("<" + el.tagName + ">");
  return out;
})()`;

async function expect_inert(page: Page, dialogs: string[]): Promise<void> {
  await page.waitForTimeout(600);
  expect(await page.evaluate("window.__pwned")).toBeUndefined();
  expect(dialogs).toEqual([]);
  const bad = (await page.evaluate(INERT_SCRIPT)) as string[];
  expect(bad, `살아난 요소/속성: ${bad.join(", ")}`).toEqual([]);
}

test("X1 Markdown 우회 모음: 대문자·엔티티·data:·svg·이중 인코딩·속성 탈출 모두 대시보드에서 글자로만 남는다", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    await d.dismiss();
  });
  await page.goto(url("/#plan"));
  await expect(page.locator("#app")).toContainText("우회 모음");
  await expect_inert(page, dialogs);
  await page.goto(url("/#plan-item-21"));
  await expect(page.locator("#plan-item-21")).toBeVisible();
  await expect_inert(page, dialogs);
  // 항목 상세를 펼치는 단추가 있으면 눌러도 같다
  for (const btn of await page.locator("#plan-item-21 summary, #plan-item-21 button").all()) await btn.click({ timeout: 2000 }).catch(() => undefined);
  await expect_inert(page, dialogs);
});

test("X2 보고서에 실린 우회 모음도 같다 (단계 보고서 HTML)", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    await d.dismiss();
  });
  expect(ws.pes(["report", ws.slug, "plan"]).status).toBe(0);
  await page.goto(url("/reports/plan/report.html"));
  await expect(page.locator("h1").first()).toBeVisible();
  await expect_inert(page, dialogs);
});

test("X3 /version 이 500·깨진 본문·엉뚱한 값·연결 끊김·410 이어도 입력 중인 초안은 남고 화면은 다시 불러오지 않는다", async ({ page }) => {
  await page.clock.install();
  const replies: Array<(r: import("@playwright/test").Route) => Promise<void>> = [
    (r) => r.fulfill({ status: 500, body: "boom" }),
    (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<html>not json</html>" }),
    (r) => r.fulfill({ json: { v: "abc" } }),
    (r) => r.fulfill({ json: {} }),
    (r) => r.fulfill({ json: { v: null } }),
    (r) => r.fulfill({ json: { v: -1 } }),
    (r) => r.abort("connectionreset"),
    (r) => r.fulfill({ status: 410, json: { error: { code: "cursor_invalid" } } }),
  ];
  let step = 0;
  await page.route("**/version", (route) => replies[Math.min(step, replies.length - 1)]!(route));
  await page.goto(url("/ask-plan-start.html"));
  await page.evaluate("window.__marker = 1");
  await page.locator("#free").fill("합성 초안 보존");
  await page.locator('textarea[data-q="memo"]').fill("합성 메모 보존");
  for (step = 0; step < replies.length; step += 1) {
    await page.clock.runFor(11_000);
    expect(await page.evaluate("window.__marker"), `응답 ${step}: 다시 불러왔다`).toBe(1);
    await expect(page.locator("#free")).toHaveValue("합성 초안 보존");
    await expect(page.locator('textarea[data-q="memo"]')).toHaveValue("합성 메모 보존");
  }
});

/** 가짜 시계를 돌려 /version 조회가 실제로 `n` 번 끝나게 한다(응답이 도착해야 막대 판정이 난다). */
async function polls(page: Page, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const answered = page.waitForResponse((r) => /\/version$/.test(new URL(r.url()).pathname), { timeout: 15_000 });
    await page.clock.runFor(11_000);
    await answered;
    await page.waitForTimeout(250);
  }
}

test("X4 필수2 공백이 든 올바른 상대 경로는 링크가 그대로 그 파일을 가리키고(인코딩 허용), java\\tscript:·//·\\\\ 는 링크가 되지 않는다", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    await d.dismiss();
  });
  await page.goto(url("/#plan-item-22"));
  await expect(page.locator("#plan-item-22")).toBeVisible();
  const hrefs: string[] = [];
  for (const a of await page.locator("#plan-item-22 a[href]").all()) hrefs.push((await a.getAttribute("href")) ?? "");
  const decoded = hrefs.map((h) => {
    try {
      return decodeURI(h);
    } catch {
      return h;
    }
  });
  for (const want of ["shots/a b.png", "out/한글 보고서.html"]) expect(decoded, `링크가 ${want} 를 그대로 가리킨다: ${hrefs.join(" | ")}`).toContain(want);
  expect(decoded.some((h) => /^https:\/\/example\.org\/a( |%20)b$/.test(h) || h === "https://example.org/a b"), `http(s) 주소의 공백도 지우지 않는다: ${hrefs.join(" | ")}`).toBe(true);
  expect(decoded.filter((h) => h === "shots/ab.png" || h === "out/한글보고서.html")).toEqual([]);

  await page.goto(url("/#plan-item-23"));
  await expect(page.locator("#plan-item-23")).toBeVisible();
  const bad: string[] = [];
  for (const el of await page.locator("#plan-item-23 a[href], #plan-item-23 img[src]").all()) bad.push((await el.getAttribute("href")) ?? (await el.getAttribute("src")) ?? "");
  expect(bad, `링크가 되면 안 되는 값: ${bad.join(" | ")}`).toEqual([]);
  expect(await page.evaluate("window.__pwned")).toBeUndefined();
  expect(dialogs).toEqual([]);
});

/**
 * 화면을 열고, 화면이 처음 묻는 /version 두 번(overlay 의 floor, 탭의 base)이 성공으로 끝날 때까지 조건으로 기다린다.
 * 이 둘이 끝나기 전에 입력·제출을 하면 기준값이 제출 뒤 값으로 잡혀 판정이 느린 러너(Windows)에서 흔들린다. 고정 대기 없음.
 */
async function goto_settled(page: Page, path: string): Promise<void> {
  let ok = 0;
  const on_response = (r: { url(): string; status(): number }) => {
    if (/\/version$/.test(new URL(r.url()).pathname) && r.status() === 200) ok += 1;
  };
  page.on("response", on_response);
  try {
    await page.goto(url(path));
    await expect.poll(() => ok, { message: "처음 /version 두 번이 끝나야 한다", timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    // 응답 본문을 화면 스크립트가 읽어 기준값을 잡는 마이크로태스크까지 한 번 비운다(시간이 아니라 이벤트 루프 기준)
    await page.evaluate("new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0)))");
  } finally {
    page.off("response", on_response);
  }
}

test("X5 권장2 답을 보낸 탭은 자기 제출로 '새 결과' 막대가 뜨지 않는다 (질문 폼·승인)", async ({ page }) => {
  await page.clock.install();
  await goto_settled(page, "/ask-plan-start.html");
  await expect(page.locator("#send")).toBeVisible();
  await page.locator('input[data-q="scope"][value="narrow"]').check();
  await page.locator('textarea[data-q="memo"]').fill("합성 메모 자기 제출");
  await page.clock.runFor(1_000);
  await page.locator("#send").click();
  await expect(page.locator("#send")).toContainText("보냈습니다");
  await polls(page, 3);
  await expect(page.locator("#pes-live"), "질문 폼: 자기 제출로 새 결과 막대가 떴다").toBeHidden();

  await goto_settled(page, "/#plan");
  await expect(page.locator("#approve")).toBeVisible();
  await page.locator("#approve").click();
  await page.locator("#mok").click();
  await expect(page.locator("#toast")).toContainText("승인을 보냈습니다");
  await polls(page, 3);
  await expect(page.locator("#pes-live"), "대시보드: 자기 승인으로 새 결과 막대가 떴다").toBeHidden();
});

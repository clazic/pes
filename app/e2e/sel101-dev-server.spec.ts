// SEL-101 — 개발 서버(npm run dev = vite)로 `/` · `/_app/` · `/p/<slug>/` 를 열면 '찾을 수 없음'이 아니라 현재 위치(가짜 클라이언트의 current)로 간다.
// 같이 production 경로 규칙(자산 `/_app/`, 앱 `/p/<slug>/**`)이 그대로인지 e2e preview 서버(playwright.config.ts)로 가드한다.
//
// 개발 서버는 이 파일이 따로 띄운다: 빈 포트(SEL-96 방식 — 4173·5173 하드코딩 없음)에 `vite --port <빈 포트> --strictPort`.
// 준비 완료는 URL 응답이 아니라 이번에 띄운 vite 가 그 포트에 바인딩했다고 찍는 줄로만 판단한다. 임시 HOME 으로 격리하고 끝나면 프로세스를 끈다.
// 해석: dev 는 비 production 이라 가짜 클라이언트(조사 R2 가 현재) — 그래서 도착 주소는 contract 의 CURRENT.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { CURRENT, SLUG } from "../src/test/contract";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

let child: ChildProcess | undefined;
let home = "";
let origin = "";
let log = "";

test.describe("개발 서버(vite dev)", () => {
  test.beforeAll(async () => {
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    home = mkdtempSync(join(tmpdir(), "pes-sel101-dev-"));
    child = spawn(process.execPath, [join(APP, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
      cwd: APP,
      env: { ...process.env, HOME: home, USERPROFILE: home, PES_HOME: join(home, "pes-projects"), PYTHONIOENCODING: "utf-8", NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ready = new RegExp(`Local:\\s+http://127\\.0\\.0\\.1:${port}/`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`vite dev 가 30초 안에 바인딩하지 않았다:\n${log}`)), 30_000);
      const onData = (b: Buffer) => {
        log += b.toString("utf8");
        if (ready.test(log)) {
          clearTimeout(timer);
          resolve();
        }
      };
      child!.stdout!.on("data", onData);
      child!.stderr!.on("data", onData);
      child!.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`vite dev 가 바로 끝났다(${code}):\n${log}`));
      });
    });
  });

  test.afterAll(() => {
    child?.kill();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  async function landsOnCurrent(page: import("@playwright/test").Page, path: string) {
    await page.goto(`${origin}${path}`);
    await expect(page.locator("main [data-screen-title]")).toContainText("조사 R2");
    expect(new URL(page.url()).pathname).toBe(CURRENT);
    await expect(page.getByText("찾을 수 없음")).toHaveCount(0);
  }

  test("`/` (vite 가 base 로 보낸 `/_app/` 포함)로 열면 현재 위치로 간다", async ({ page }) => landsOnCurrent(page, "/"));
  test("`/_app/` 로 열면 현재 위치로 간다", async ({ page }) => landsOnCurrent(page, "/_app/"));
  test("`/p/<slug>/` · `/p/<slug>` 로 열면 그 프로젝트의 현재 위치로 간다", async ({ page }) => {
    await landsOnCurrent(page, `/p/${SLUG}/`);
    await landsOnCurrent(page, `/p/${SLUG}`);
  });
  test("딥링크는 그대로 열린다", async ({ page }) => landsOnCurrent(page, CURRENT));
  test("없는 slug 는 '찾을 수 없음' 안내", async ({ page }) => {
    await page.goto(`${origin}/p/no-such-study/`);
    await expect(page.getByRole("heading", { name: "찾을 수 없음" })).toBeVisible();
  });
  test("dev 에서도 빌드 자산 경로는 `/_app/` 아래다(base 그대로)", async ({ page }) => {
    const res = await page.request.get(`${origin}/_app/index.html`);
    expect(res.status()).toBe(200);
    expect(await res.text()).toMatch(/(src|href)="\/_app\//);
  });
});

// production 경로 규칙 가드 — playwright.config.ts 의 preview 서버(--mode e2e 빌드, baseURL)로 본다.
test.describe("빌드한 앱 서버(vite preview) — production 경로 규칙", () => {
  test("자산은 `/_app/` 에서, 앱 화면은 `/p/<slug>/**` 에서 내려온다", async ({ page }) => {
    const assets: string[] = [];
    page.on("request", (r) => {
      const p = new URL(r.url()).pathname;
      if (/\.(js|css|woff2?)$/.test(p)) assets.push(p);
    });
    await page.goto(CURRENT);
    await expect(page.locator("main [data-screen-title]")).toContainText("조사 R2");
    expect(assets.length).toBeGreaterThan(0);
    for (const p of assets) expect(p, "앱 자산").toMatch(/^\/_app\//);
    const res = await page.request.get(`/_app/index.html`);
    expect(res.status()).toBe(200);
  });

  test("`/p/<slug>/` 도 앱 index.html 을 내주고 앱이 현재 위치로 보낸다", async ({ page }) => {
    const res = await page.request.get(`/p/${SLUG}/`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/text\/html/);
    await page.goto(`/p/${SLUG}/`);
    await expect(page.locator("main [data-screen-title]")).toContainText("조사 R2");
    expect(new URL(page.url()).pathname).toBe(CURRENT);
  });

  test("`/_app/` 도 현재 위치로 간다", async ({ page }) => {
    await page.goto(`/_app/`);
    await expect(page.locator("main [data-screen-title]")).toContainText("조사 R2");
    expect(new URL(page.url()).pathname).toBe(CURRENT);
  });
});

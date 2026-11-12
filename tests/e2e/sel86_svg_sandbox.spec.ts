// SEL-86 U1b 후속 B (추가 3) — reports·out 의 SVG 를 주소로 직접 열 때의 CSP sandbox 를 실제 브라우저로 본다 (Playwright).
//
// 옛 project.json 폴더(정적 서빙) 하나를 합성 DB 작업 공간 옆에 놓고(같은 PES_HOME) serve.ts 를 띄운다. 임시 HOME·USERPROFILE·PES_HOME.
//  E1 같은 탭에서 같은 출처 sessionStorage 에 값을 넣은 뒤 reports/·out/ 의 SVG 를 직접 연다 → SVG 안의 스크립트가 돌지만 sessionStorage 를 읽지 못한다(SecurityError).
//     대조: SEL-102 로 notes/ 의 SVG 도 sandbox — 같은 값을 읽지 못한다(스크립트가 도는 것은 data-r 로 증명). 값은 sandbox 없는 같은 출처 /ping 에서 심는다.
//  E2 같은 SVG 를 <img> 로 넣은 페이지(notes/embed.html)는 그림이 그대로 뜬다(naturalWidth > 0, 로드 오류 없음).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

declare const window: any;
declare const document: any;
declare const sessionStorage: any;

const REPO = resolve(process.cwd());
const LEGACY = "synthetic-legacy-svg-e2e";
const SECRET = "svg-secret-sel86";
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="#357"/><script>//<![CDATA[
var r; try { r = "read:" + sessionStorage.getItem("k"); } catch (e) { r = "throw:" + e.name; }
document.documentElement.setAttribute("data-r", r);
document.documentElement.setAttribute("data-origin", String(window.origin));
//]]></script></svg>`;

let base = "";
let root = "";
let server: ChildProcess;

function free_port(): Promise<number> {
  return new Promise((done, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const a = probe.address();
      const port = typeof a === "object" && a !== null ? a.port : 0;
      probe.close(() => done(port));
    });
  });
}

test.beforeAll(async () => {
  const seeded = spawnSync(process.execPath, [join(REPO, "tests", "e2e", "helpers", "seed_workspace.ts")], { encoding: "utf8", cwd: REPO, timeout: 120_000 });
  if (seeded.status !== 0) throw new Error(`seed_workspace failed (${seeded.status}): ${seeded.stderr}`);
  const info = JSON.parse(seeded.stdout.trim().split("\n").pop() as string) as { root: string; home: string; pes_home: string };
  root = info.root;
  const dir = join(info.pes_home, LEGACY);
  for (const sub of ["reports/plan", "out", "notes"]) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, "project.json"), JSON.stringify({ pes: 1, topic: "합성 옛 SVG", slug: LEGACY, current: "plan", processed: [], notes: [], stages: {} }), "utf8");
  writeFileSync(join(dir, "reports", "plan", "d.svg"), SVG, "utf8");
  writeFileSync(join(dir, "out", "d.svg"), SVG, "utf8");
  writeFileSync(join(dir, "notes", "d.svg"), SVG, "utf8");
  writeFileSync(join(dir, "notes", "set.html"), `<!doctype html><title>set</title><script>sessionStorage.setItem("k", "${SECRET}")</script>ok`, "utf8");
  writeFileSync(
    join(dir, "notes", "embed.html"),
    `<!doctype html><title>embed</title><img id="a" src="../reports/plan/d.svg" alt="a"><img id="b" src="../out/d.svg" alt="b">`,
    "utf8",
  );

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^PES_/.test(k)) env[k] = v;
  Object.assign(env, { HOME: info.home, USERPROFILE: info.home, PES_HOME: info.pes_home });
  for (const guard of ["HOME", "USERPROFILE", "PES_HOME"]) if (!env[guard]!.startsWith(info.root)) throw new Error(`${guard} is not the isolated temporary folder`);
  const port = await free_port();
  server = spawn(process.execPath, [join(REPO, "scripts", "serve.ts"), info.pes_home, String(port)], { env, cwd: info.root, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  server.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/ping`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`serve.ts did not start: ${stderr}`);
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.afterAll(async () => {
  if (server !== undefined && server.exitCode === null) {
    await new Promise<void>((done) => {
      server.once("exit", () => done());
      server.kill();
      setTimeout(done, 3000).unref();
    });
  }
  if (root !== "") rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const attr = (page: any, name: string): Promise<string | null> => page.evaluate((n: string) => document.documentElement.getAttribute(n), name);

for (const path of ["reports/plan/d.svg", "out/d.svg"]) {
  test(`E1 같은 탭에서 sessionStorage 를 둔 뒤 ${path} 를 직접 열면 SVG 스크립트가 sessionStorage 를 읽지 못한다 (불투명 출처)`, async ({ page }) => {
    // 같은 출처이면서 sandbox 가 없는 문서(/ping, text/plain)에서 값을 심는다 — SEL-102 뒤로 notes/*.html 도 sandbox 라 쓸 수 없다
    await page.goto(`${base}/ping`);
    await page.evaluate((v) => sessionStorage.setItem("k", v), SECRET);
    expect(await page.evaluate(() => sessionStorage.getItem("k"))).toBe(SECRET);
    const res = await page.goto(`${base}/${LEGACY}/${path}`);
    expect(res?.headers()["content-security-policy"] ?? "").toMatch(/\bsandbox\b/);
    expect(res?.headers()["content-security-policy"] ?? "").not.toMatch(/allow-same-origin/);
    await expect.poll(() => attr(page, "data-r"), { message: "SVG 안의 스크립트가 돈다" }).not.toBeNull();
    expect(await attr(page, "data-r")).toBe("throw:SecurityError");
    expect(await attr(page, "data-origin")).toBe("null");
  });
}

test("E1 대조(SEL-102 로 바뀜): reports/·out/ 밖(notes/)의 SVG 도 이제 sandbox — 스크립트는 돌지만(data-r 이 생김) 같은 값을 읽지 못한다", async ({ page }) => {
  await page.goto(`${base}/ping`);
  await page.evaluate((v) => sessionStorage.setItem("k", v), SECRET);
  expect(await page.evaluate(() => sessionStorage.getItem("k"))).toBe(SECRET);
  const res = await page.goto(`${base}/${LEGACY}/notes/d.svg`);
  expect(res?.headers()["content-security-policy"] ?? "").toMatch(/\bsandbox\b/);
  await expect.poll(() => attr(page, "data-r"), { message: "SVG 안의 스크립트가 돈다" }).not.toBeNull();
  expect(await attr(page, "data-r")).toBe("throw:SecurityError");
});

test("E2 <img> 로 넣은 reports/·out/ SVG 는 그대로 뜬다 (sandbox 는 문서에만 걸린다)", async ({ page }) => {
  const errors: string[] = [];
  page.on("requestfailed", (r) => errors.push(r.url()));
  await page.goto(`${base}/${LEGACY}/notes/embed.html`);
  await expect.poll(() => page.evaluate(() => ["a", "b"].map((id) => (document as any).getElementById(id).naturalWidth))).toEqual([12, 12]);
  expect(errors).toEqual([]);
});

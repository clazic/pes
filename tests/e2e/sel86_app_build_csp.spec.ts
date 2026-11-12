// SEL-86 U1b 후속 B — 실제 앱 빌드(app/dist)의 인라인 스크립트 없음 + 서버가 내주는 앱 index 의 CSP script-src 'self' (Playwright 잡이 앱을 빌드한다).
// tests/test_sel86_report_csp.test.ts 의 S3(Node 잡: 앱 빌드 없음 → 원본 app/index.html 과 합성 빌드)와 같은 단언을 실제 app/dist 에 건다.
//   - app/dist/index.html: 인라인 <script>·on*=·javascript: 링크 없음
//   - 실제 dist 를 PES_APP_DIR 로 띄운 서버에서 /p/<slug>/… 와 /_app/index.html: 200 text/html, 인라인 없음, script-src 'self'(unsafe-* 없음), sandbox 없음
//   - 빌드가 가리키는 자산(JS·CSS): 200, sandbox 없음
// 앞 조건: cd app && npm ci && npm run build. 없으면 건너뛰지 않고 실패한다(CI 계약).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

import { REPO, open_workspace, type Workspace } from "./helpers/workspace.ts";

const DIST = join(REPO, "app", "dist");

let ws: Workspace;
test.beforeAll(async () => {
  expect(existsSync(join(DIST, "index.html")), "앱 빌드가 없다 — cd app && npm ci && npm run build 를 먼저 한다(app/dist/index.html)").toBe(true);
  ws = await open_workspace({ PES_APP_DIR: DIST });
});
test.afterAll(async () => {
  await ws?.close();
});

/** 모든 content-security-policy 값을 ; 로 나눈 지시어 표 { 이름 → 토큰들 } (같은 이름은 합친다) */
function directives(policies: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const policy of policies) {
    for (const part of policy.split(";")) {
      const words = part.trim().split(/\s+/).filter((w) => w !== "");
      if (words.length === 0) continue;
      const name = (words[0] as string).toLowerCase();
      out.set(name, [...(out.get(name) ?? []), ...words.slice(1).map((w) => w.toLowerCase())]);
    }
  }
  return out;
}

function header_policies(headers: Headers): string[] {
  const raw = headers.get("content-security-policy");
  return raw === null ? [] : [raw];
}

function meta_policies(html: string): string[] {
  const out: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/http-equiv\s*=\s*["']?content-security-policy["']?/i.test(tag)) continue;
    const m = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(tag);
    if (m !== null) out.push((m[1] ?? m[2]) as string);
  }
  return out;
}

function expect_no_inline_script(html: string, what: string): void {
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) expect(tag, `${what}: 인라인 <script> 가 없다 (${tag})`).toMatch(/\bsrc\s*=/i);
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) expect((m[1] as string).trim(), `${what}: <script> 본문이 비어 있다`).toBe("");
  expect(html, `${what}: on*= 이벤트 속성이 없다`).not.toMatch(/\son[a-z]+\s*=/i);
  expect(html, `${what}: javascript: 링크가 없다`).not.toMatch(/href\s*=\s*["']\s*javascript:/i);
}

function expect_app_script_policy(headers: Headers, html: string, what: string): void {
  const d = directives([...header_policies(headers), ...meta_policies(html)]);
  const src = d.get("script-src") ?? d.get("default-src");
  expect(src, `${what}: 헤더나 meta CSP 에 script-src 가 있다`).toBeDefined();
  expect(src, `${what}: script-src 가 'self' 를 허용한다 (${(src ?? []).join(" ")})`).toContain("'self'");
  for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "*", "data:", "blob:", "http:", "https:"]) expect(src, `${what}: script-src 에 ${bad} 가 없다`).not.toContain(bad);
  expect(d.has("sandbox"), `${what}: 앱에는 sandbox 가 없다 (앱은 같은 출처 sessionStorage 가 필요)`).toBe(false);
}

test("A1 app/dist/index.html: 인라인 <script>·on*=·javascript: 링크가 없다", () => {
  expect_no_inline_script(readFileSync(join(DIST, "index.html"), "utf8"), "app/dist/index.html 빌드");
});

test("A2 실제 빌드를 서빙: /p/<slug>/… 와 /_app/index.html 의 script-src 'self', 인라인 없음, sandbox 없음; 자산에도 sandbox 없음", async () => {
  const built = readFileSync(join(DIST, "index.html"), "utf8");
  for (const path of [`/p/${ws.slug}/e/1/s/plan/r/1`, `/p/${ws.slug}/`, `/p/${ws.slug}/e/1/s/plan/r/start?print=1`, "/_app/index.html"]) {
    const res = await fetch(`${ws.base}${path}`);
    expect(res.status, path).toBe(200);
    expect(res.headers.get("content-type") ?? "", path).toMatch(/^text\/html/);
    const html = await res.text();
    expect_no_inline_script(html, path);
    expect_app_script_policy(res.headers, html, path);
  }
  const assets = [...built.matchAll(/(?:src|href)="(\/_app\/assets\/[^"]+)"/g)].map((m) => m[1] as string);
  expect(assets.length, "빌드 index 가 자산(JS·CSS)을 가리킨다").toBeGreaterThanOrEqual(2);
  for (const asset of assets) {
    const res = await fetch(`${ws.base}${asset}`);
    expect(res.status, asset).toBe(200);
    await res.arrayBuffer();
    expect(directives(header_policies(res.headers)).has("sandbox"), `${asset}: 자산에는 sandbox 가 없다`).toBe(false);
  }
});

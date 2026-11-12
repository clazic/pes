// SEL-101 — 실서버(serve.ts)가 내주는 앱에서 `/p/<slug>/`(판·단계·라운드 없음)도 그 프로젝트의 현재 위치로 간다 (Playwright, 작성 모드).
// dev 서버와 같은 동작이어야 한다("dev·실서버 같게"). 임시 HOME·USERPROFILE·PES_HOME 의 합성 프로젝트만 쓴다(실제 홈·실제 PES 포트 0).
// 해석: 실서버 앱은 production 빌드(app/dist, 자산 /_app/)라 1회용 코드(`#code=`)로만 서버 자료를 읽는다 → `pes open --app` 주소의 경로만
// `/p/<slug>/`(또는 `/p/<slug>`)로 바꾸고 조각은 그대로 연다. 도착 주소는 서버가 알려 주는 workspace 의 current 와 같다.
// 앞 조건: `cd app && npm ci && npm run build` — 없으면 건너뛰지 않고 실패한다.
import { existsSync } from "node:fs";
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

/** 1회용 코드 주소의 경로만 바꾼 주소 — 코드는 한 번만 쓰이므로 열 때마다 새로 받는다 */
function openAt(path: string): string {
  const u = new URL(ws.open_app());
  u.pathname = path;
  return u.href;
}

async function currentPath(page: import("@playwright/test").Page): Promise<{ pathname: string; edition: number; stage: string; round: number | null }> {
  const res = await page.request.get(`${ws.base}/api/v1/projects/${ws.project_id}/workspace`, { headers: { "x-pes-session": ws.session } });
  expect(res.status()).toBe(200);
  const d = (await res.json()).data;
  const round = d.current.round_id as number | null;
  return { pathname: `/p/${d.slug}/e/${d.edition}/s/${d.current.stage}/r/${round === null ? "start" : round}`, edition: d.edition, stage: d.current.stage, round };
}

for (const shape of ["/", ""]) {
  test(`실서버 /p/<slug>${shape} 는 앱을 내주고 앱이 프로젝트의 현재 위치로 보낸다 (찾을 수 없음 아님)`, async ({ page }) => {
    const want = await currentPath(page);
    const response = await page.goto(openAt(`/p/${ws.slug}${shape}`));
    expect(response?.status()).toBe(200);
    await expect(page.locator("main [data-screen-title]")).toBeVisible();
    await expect(page.getByText("찾을 수 없음")).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(want.pathname);
  });
}

test("실서버 자산은 계속 /_app/ 에서, 없는 slug 는 찾을 수 없음 안내", async ({ page }) => {
  const assets: string[] = [];
  page.on("request", (r) => {
    const p = new URL(r.url()).pathname;
    if (/\.(js|css|woff2?)$/.test(p)) assets.push(p);
  });
  await page.goto(openAt(`/p/no-such-study/`));
  await expect(page.getByRole("heading", { name: "찾을 수 없음" })).toBeVisible();
  expect(assets.length).toBeGreaterThan(0);
  for (const p of assets) expect(p).toMatch(/^\/_app\//);
});

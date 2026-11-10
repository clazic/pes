// SEL-51 PR18 — 1차 리뷰 r1-3 권장 3(가) 회귀 (tester, 작성 모드): 없는 질문·자기 자신을 가리키는 show_if 질문은 늘 보이고,
// 필수이면 답이 없을 때 전송이 막힌다(숨은 필수 질문이 검증을 피해 가지 않는다). 합성 DB 프로젝트만 쓴다.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { open_workspace, type Workspace } from "./helpers/workspace.ts";

let ws: Workspace;
let tmp: string;
test.beforeAll(async () => {
  ws = await open_workspace();
  tmp = mkdtempSync(join(tmpdir(), "pes-e2e-r13-"));
});
test.afterAll(async () => {
  await ws?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const url = (path: string): string => `${ws.base}/${ws.slug}${path}`;

test("R3a 없는 질문·자기 자신을 가리키는 show_if 의 필수 질문은 늘 보이고, 비운 채 보내면 전송이 막힌다", async ({ page }) => {
  const file = join(tmp, "review-r13.json");
  writeFileSync(
    file,
    JSON.stringify({
      id: "plan-check-r2",
      stage: "plan",
      kind: "review",
      round: 2,
      title: "점검",
      questions: [
        { id: "ghost-dep", type: "text", label: "없는 질문에 기대는 필수", required: true, show_if: { id: "ghost", in: ["x"] } },
        { id: "self-dep", type: "text", label: "자기 자신에 기대는 필수", required: true, show_if: { id: "self-dep", in: ["x"] } },
      ],
    }),
    "utf8",
  );
  const r = ws.pes(["ask", ws.slug, file]);
  expect(r.status, r.stderr + r.stdout).toBe(0);
  const posts: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && /\/feedback$/.test(new URL(req.url()).pathname)) posts.push(req.url());
  });
  await page.goto(url("/#plan"));
  await expect(page.locator("#rvbox")).toBeVisible();
  const ghost = page.locator("#rvbox .q", { hasText: "없는 질문에 기대는 필수" });
  const self = page.locator("#rvbox .q", { hasText: "자기 자신에 기대는 필수" });
  await expect(ghost, "없는 질문을 가리키는 조건은 버려져 늘 보인다").toBeVisible();
  await expect(self, "자기 자신을 가리키는 조건은 버려져 늘 보인다").toBeVisible();
  await page.locator("#free").fill("합성 자유 의견"); // 보낼 내용이 있어야 필수 검사까지 간다
  await page.locator("#send").click();
  await expect(page.locator("#toast")).toContainText("필수");
  await expect(page.locator("#rvbox .q-missing"), "두 필수 질문 모두 빠진 것으로 표시된다").toHaveCount(2);
  expect(posts, "필수 질문이 비었으면 보내지 않는다").toEqual([]);
  await expect(page.locator("#send")).not.toContainText("보냈습니다");
});

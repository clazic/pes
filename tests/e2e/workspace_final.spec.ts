// SEL-51 PR18 — Codex 최종 리뷰 1/2 회귀 (tester, 보강 모드): F4 제출 도중 탭 전환 초안, F3 점검 질문 조건부 표시·필수, F2 점검 폼 개정 뒤 전송.
// 구현 전에는 실패하는 것이 정상이다. 합성 DB 프로젝트(tests/e2e/helpers/workspace.ts)만 쓴다. 순서가 의미 있다:
// 점검 질문(review)이 올라가면 대시보드 전송이 필수 질문을 요구하므로 F4 를 먼저 둔다.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { open_workspace, type Workspace } from "./helpers/workspace.ts";

let ws: Workspace;
let tmp: string;
test.beforeAll(async () => {
  ws = await open_workspace();
  tmp = mkdtempSync(join(tmpdir(), "pes-e2e-final-"));
});
test.afterAll(async () => {
  await ws?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const url = (path: string): string => `${ws.base}/${ws.slug}${path}`;

/** 이 탭의 초안 저장소: 단계 → 저장된 JSON 문자열. */
async function drafts(page: Page): Promise<Record<string, string>> {
  return JSON.parse((await page.evaluate(`JSON.stringify(Object.fromEntries(Object.keys(sessionStorage).filter(k => k.startsWith("pes-draft:")).map(k => [k.split(":").pop(), sessionStorage.getItem(k)])))`)) as string);
}

async function go_stage(page: Page, stage: string): Promise<void> {
  await page.evaluate(`location.hash = "#${stage}"`);
  await expect(page.locator("h2, .pipeline").first()).toBeVisible();
}


async function hold_posts(page: Page): Promise<{ release(): void; started: Promise<unknown> }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/feedback", async (route) => {
    await gate;
    await route.fulfill({ status: 200, json: { ok: true, file: "plan-R2-20260101-000000.json", v: 999999 } });
  });
  return { release, started: page.waitForRequest((r) => r.method() === "POST" && /\/feedback$/.test(new URL(r.url()).pathname)) };
}

test("F4a 제출 도중 다른 단계 탭으로 가도 영수증은 요청을 시작한 단계(plan)의 초안만 지우고 research 초안은 남는다", async ({ page }) => {
  await page.goto(url("/#plan"));
  await expect(page.locator("#send")).toBeVisible();
  // 이전에 저장된 다른 단계 초안(그 단계가 현재였을 때 입력하다 남긴 것): 이 탭의 sessionStorage 에 단계별 키로 있다
  await page.evaluate(`sessionStorage.setItem("pes-draft:" + location.pathname + ":research", JSON.stringify({"#free": "research 초안 하나"}))`);
  await page.locator("#free").fill("plan 초안 하나");
  expect(Object.keys(await drafts(page)).sort()).toEqual(["plan", "research"]);
  const held = await hold_posts(page);
  await page.locator("#send").click();
  await held.started;
  await go_stage(page, "research"); // 응답을 기다리는 동안 탭 전환 (실제 hashchange 로 SEL 이 바뀐다)
  held.release();
  await expect(page.locator("#send")).toHaveText(/보냈습니다/);
  await expect.poll(async () => Object.keys(await drafts(page)).includes("plan"), { message: "보낸 plan 초안은 정리된다", timeout: 5000 }).toBe(false);
  const left = await drafts(page);
  expect(left.research, "research 초안은 그대로 남는다").toContain("research 초안 하나");
});

test("F4b 응답을 기다리는 동안 같은 단계에서 더 입력한 내용은 영수증이 지우지 않는다", async ({ page }) => {
  await page.goto(url("/#plan"));
  await expect(page.locator("#send")).toBeVisible();
  await page.locator("#free").fill("plan 보낸 초안");
  const held = await hold_posts(page);
  await page.locator("#send").click();
  await held.started;
  await page.locator("#free").fill("plan 보낸 초안 + 응답 전 추가 입력");
  held.release();
  await expect(page.locator("#send")).toHaveText(/보냈습니다/);
  await page.waitForTimeout(300);
  const left = await drafts(page);
  expect(left.plan, "응답 전에 더 입력한 plan 초안은 보존된다").toContain("응답 전 추가 입력");
});

const REVIEW_SPEC = (label: string): string =>
  JSON.stringify({
    id: "plan-check-r2",
    stage: "plan",
    kind: "review",
    round: 2,
    title: "점검",
    questions: [
      { id: "scope", type: "single", label, required: true, options: [{ value: "narrow", label: "좁게" }, { value: "wide", label: "넓게", recommended: true }] },
      { id: "why", type: "text", label: "넓게 하는 이유는?", required: true, show_if: { id: "scope", in: ["wide"] } },
    ],
  });

function ask_review(label: string): void {
  const file = join(tmp, `review-${Math.abs(label.length)}-${Date.now()}.json`);
  writeFileSync(file, REVIEW_SPEC(label), "utf8");
  const r = ws.pes(["ask", ws.slug, file]);
  expect(r.status, r.stderr + r.stdout).toBe(0);
}

test("F3 AI 점검: 추천(wide)이 선택되면 필수 why 가 보이고, 비운 채 보내면 막히고, narrow 를 고르면 사라진다", async ({ page }) => {
  ask_review("범위는?");
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/feedback$/.test(new URL(r.url()).pathname)) posts.push(r.url());
  });
  await page.goto(url("/#plan"));
  await expect(page.locator("#rvbox")).toBeVisible();
  const why = page.locator("#rvbox .q", { hasText: "넓게 하는 이유는?" });
  await expect(page.locator('#rvbox input[type="radio"][value="wide"]')).toBeChecked(); // 추천 미리 선택
  await expect(why, "추천 wide 가 선택돼 있으면 why 가 보인다").toBeVisible();
  await page.locator("#send").click();
  await expect(page.locator("#toast")).toContainText("필수");
  expect(posts, "필수 why 가 비었으면 보내지 않는다").toEqual([]);
  await page.locator('#rvbox input[type="radio"][value="narrow"]').check();
  await expect(why, "narrow 를 고르면 why 가 숨겨진다").toBeHidden();
  await page.locator('#rvbox input[type="radio"][value="wide"]').check();
  await expect(why).toBeVisible();
});

function ask_simple(label: string): void {
  const file = join(tmp, `simple-${label.length}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify({ id: "plan-check-r2", stage: "plan", kind: "review", round: 2, title: "점검", questions: [{ id: "chk", type: "text", label, required: true }] }), "utf8");
  const r = ws.pes(["ask", ws.slug, file]);
  expect(r.status, r.stderr + r.stdout).toBe(0);
}

test("F2 AI 점검 폼을 다른 곳에서 개정한 뒤 옛 화면에서 보내면 충돌 안내가 뜨고 입력한 초안은 남는다 (성공으로 보이지 않는다)", async ({ page }) => {
  ask_simple("이전 질문"); // 앞 시험이 실패해 작업 공간이 새로 떠도 스스로 점검 폼을 올린다(같은 form_key 로 다시 ask 해도 된다)
  await page.goto(url("/#plan"));
  await expect(page.locator("#rvbox")).toBeVisible();
  const why = page.locator('#rvbox input[type="text"], #rvbox textarea').first();
  await why.fill("합성 이유 초안");
  ask_simple("개정 질문"); // 같은 form_key 개정
  await page.locator("#send").click();
  await expect(page.locator("#toast")).toContainText(/충돌|바뀌|새 판|다시/);
  await expect(page.locator("#send"), "충돌인데 보냈다고 표시되면 안 된다").not.toContainText("보냈습니다");
  await expect(why).toHaveValue("합성 이유 초안");
  expect((await drafts(page)).plan ?? "", "초안이 저장소에 남는다").toContain("합성 이유 초안");
});

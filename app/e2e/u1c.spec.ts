// SEL-83 U1c — 입력 초안 보존 · 커서 갱신 · 명령 메뉴 e2e (Playwright, 빌드한 앱 + vite preview). 구현 전이므로 실패가 정상.
// 이름에 keyboard / ime / deep_link 가 든 시험은 Windows CI 필수 묶음(`-g "keyboard|ime|deep_link"`). 계약: src/test/contract.ts 머리말 U1c.
// 실제 한글 IME 는 CDP Input.imeSetComposition 으로 흉내 낸다(실제 OS IME 는 수동 병행 시험). 실제 자료·네트워크 없음.
import { expect, test, type Page } from "@playwright/test";
import { CMD, CURRENT, NAMES, SHELL, U1C, WIDTHS, url } from "../src/test/contract";

const HEIGHT = 800;
const MOD = process.platform === "darwin" ? "Meta" : "Control";

async function open(page: Page, path: string, width: number = WIDTHS.wide1440) {
  await page.setViewportSize({ width, height: HEIGHT });
  await page.goto(path);
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
}
const menu = (page: Page) => page.getByRole("dialog", { name: CMD.dialog });

test("keyboard: Ctrl/Cmd+K 로 열고 글자로 거르고 Enter 로 실행 — 마우스 없이 인쇄 미리보기까지", async ({ page }) => {
  await open(page, CURRENT);
  await page.keyboard.press(`${MOD}+k`);
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole("combobox", { name: CMD.combobox })).toBeFocused();
  await page.keyboard.type("인쇄");
  await expect(menu(page).getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(menu(page)).toBeHidden();
  expect(new URL(page.url()).searchParams.get("print")).toBe("1");
  await expect(page.getByRole("region", { name: NAMES.print })).toBeVisible();
});

test("keyboard: 머리줄 단추 → Enter 로 열고 Esc 로 닫으면 초점이 단추로 돌아온다", async ({ page }) => {
  await open(page, CURRENT);
  const btn = page.getByRole("banner").getByRole("button", { name: SHELL.command });
  await btn.focus();
  await page.keyboard.press("Enter");
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
  await expect(btn).toBeFocused();
});

test("keyboard: 명령 메뉴 안에서 Tab 을 계속 눌러도 초점이 대화 상자 밖으로 새지 않고 Esc 로 빠져나온다", async ({ page }) => {
  await open(page, CURRENT);
  await page.keyboard.press(`${MOD}+k`);
  await expect(menu(page)).toBeVisible();
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), `Tab ${i + 1}`).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
});

test("keyboard: 결과 없음에서 Enter 를 눌러도 AI 모드로 바뀌지 않고 요청이 나가지 않는다", async ({ page }) => {
  await open(page, CURRENT);
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.type("zzzz없는동작");
  await expect(menu(page).getByRole("status")).toContainText(CMD.noMatch);
  await page.keyboard.press("Enter");
  await expect(menu(page).getByRole("button", { name: CMD.aiToggle })).toHaveAttribute("aria-pressed", "false");
  expect(requests).toEqual([]);
});

test("ime: 한글 조합 중에는 Ctrl/Cmd+K 도 Tab 보조도 동작하지 않고, 조합이 끝나면 값이 남는다", async ({ page, context }) => {
  await open(page, CURRENT);
  const box = page.locator("#q-21");
  await box.focus();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "ㅎ", selectionStart: 1, selectionEnd: 1 });
  await page.keyboard.press(`${MOD}+k`);
  await expect(menu(page)).toBeHidden();
  await cdp.send("Input.insertText", { text: "한" });
  await expect(box).toHaveValue("한");
  await page.keyboard.press(`${MOD}+k`);
  await expect(menu(page)).toBeVisible();
});

// 한계(R1): 앱의 가짜 클라이언트는 변경을 내지 않아 실제 재그림이 일어나지 않는다 — 이 시험은 "갱신 박자가 지나는 동안 조합 중 글·초점이 안 깨진다"만 본다.
// 재그림 중 보존(같은 DOM 노드 · 선택 범위 · 조합 값)은 vitest(live-update.test.tsx)가 변경분을 실제로 내서 고정한다.
test("ime: 조합 중에 갱신 주기(3초 이상)가 지나도 조합 중 글·초점이 그대로", async ({ page, context }) => {
  await open(page, CURRENT);
  const box = page.locator("#q-21");
  await box.focus();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "ㅇ", selectionStart: 1, selectionEnd: 1 });
  await page.waitForTimeout(U1C.active.every + 1500);
  await expect(box).toBeFocused();
  expect(await box.evaluate((el: HTMLTextAreaElement) => el.value)).toBe("ㅇ");
  await cdp.send("Input.insertText", { text: "이" });
  await expect(box).toHaveValue("이");
});

test("ime: 조합 중 Tab 은 명령 메뉴 검색 칸에 라벨을 채우지 않는다", async ({ page, context }) => {
  await open(page, CURRENT);
  await page.keyboard.press(`${MOD}+k`);
  const input = menu(page).getByRole("combobox", { name: CMD.combobox });
  await input.focus();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "ㅇ", selectionStart: 1, selectionEnd: 1 });
  await page.keyboard.press("Tab");
  expect(await input.inputValue()).not.toContain(CMD.labels.print);
});

test("deep_link: 새로고침해도 같은 질문 초안 키로 초안이 돌아오고 peek 주소가 같은 화면을 복원한다", async ({ page }) => {
  await open(page, url("research", 2, "peek=q-22"));
  await expect(page.getByRole("dialog", { name: NAMES.peek })).toBeVisible();
  await expect(page.getByRole("dialog", { name: NAMES.peek }).getByRole("button", { name: CMD.nextQ })).toHaveAttribute("aria-disabled", "true");
  await page.locator("#q-21").fill("새로고침 뒤에도");
  await page.reload();
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
  await expect(page.getByRole("dialog", { name: NAMES.peek })).toBeVisible();
  await expect(page.locator("#q-21")).toHaveValue("새로고침 뒤에도");
  expect(new URL(page.url()).searchParams.get("peek")).toBe("q-22");
});

test("deep_link: 순서 넘김이 지난 라운드에서도 주소만 바꾼다", async ({ page }) => {
  await open(page, url("plan", 1, "peek=q-11"));
  const dlg = page.getByRole("dialog", { name: NAMES.peek });
  await expect(dlg).toBeVisible();
  await dlg.getByRole("button", { name: CMD.nextQ }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("peek")).toBe("q-12");
  expect(new URL(page.url()).pathname).toContain("/s/plan/r/1");
});

// 한계(R1): 가짜 클라이언트는 변경을 내지 않아 재그림이 없다 — 박자가 지나는 동안 글·초점이 유지되고 화면 밖 요청이 없다는 것만 본다(재그림 중 보존은 live-update.test.tsx).
// 네트워크 0 은 명령 메뉴를 열고 거르고 AI 모드로 바꿔 글을 써 보는 길까지 포함한다(새 글리프·글꼴 요청이 같은 출처 밖으로 나가지 않는다).
test("갱신이 도는 동안(3초 이상) 입력 중인 글과 초점이 유지되고 화면 밖 요청이 없다", async ({ page, baseURL }) => {
  await open(page, CURRENT);
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  const box = page.locator("#q-22");
  await box.focus();
  await page.keyboard.type("계속 쓰는 중");
  await page.waitForTimeout(U1C.active.every * 2 + 500);
  await expect(box).toBeFocused();
  await expect(box).toHaveValue("계속 쓰는 중");
  expect(requests.filter((u) => !u.startsWith(`${new URL(baseURL!).origin}/`))).toEqual([]);
});

test("명령 메뉴를 열고 거르고 AI 모드로 바꿔 써 보고 닫아도 같은 출처 밖 요청 0 (네트워크 0)", async ({ page, baseURL }) => {
  await open(page, CURRENT);
  const requests: string[] = [];
  const posts: string[] = [];
  page.on("request", (r) => {
    requests.push(r.url());
    if (r.method() !== "GET") posts.push(`${r.method()} ${r.url()}`);
  });
  await page.keyboard.press(`${MOD}+k`);
  await expect(menu(page)).toBeVisible();
  await page.keyboard.type("zzzz없는동작");
  await page.keyboard.press("Enter");
  await menu(page).getByRole("button", { name: CMD.aiToggle }).click();
  await expect(menu(page).getByRole("button", { name: CMD.aiToggle })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.type("이 연구를 요약해 줘 한글 글자들");
  await page.keyboard.press("Enter");
  await menu(page).getByRole("button", { name: CMD.aiToggle }).click();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
  await page.waitForTimeout(500);
  expect(requests.filter((u) => !u.startsWith(`${new URL(baseURL!).origin}/`))).toEqual([]);
  // AI 연결이 없다 — GET 이 아닌 요청(보내기)은 하나도 없다(글꼴 subset 같은 같은 출처 GET 은 허용)
  expect(posts).toEqual([]);
});

test("ime: 명령 메뉴 검색 칸에서 한글 조합 중 Esc 는 메뉴를 닫지 않는다(조합 취소용 Esc)", async ({ page, context }) => {
  await open(page, CURRENT);
  await page.keyboard.press(`${MOD}+k`);
  const input = menu(page).getByRole("combobox", { name: CMD.combobox });
  await expect(input).toBeFocused();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "ㅇ", selectionStart: 1, selectionEnd: 1 });
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeVisible();
  await cdp.send("Input.insertText", { text: "이" });
  await expect(input).toHaveValue("이");
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
});

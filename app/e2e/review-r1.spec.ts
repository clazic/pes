// SEL-81 U1a (R1 필수 1·2·3, 권장 6·8·10) — 1차 리뷰가 실제 Chromium 에서 재현한 결함을 고정하는 e2e. 구현 전/수정 전에는 실패가 정상.
// jsdom 은 CSS 가 없어 못 보는 것: 1·2영역의 display:none · 스크롤 되돌림 · 가려짐 · 인쇄 모드.
import { expect, test, type Page } from "@playwright/test";
import { CURRENT, NAMES, REMOVED, SHELL, WIDTHS } from "../src/test/contract";

async function open(page: Page, path: string, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto(path);
  await expect(page.locator("main [data-screen-title]")).toBeVisible();
}

interface Focus {
  id: string;
  tag: string;
  rect: { top: number; bottom: number; left: number; right: number };
  vh: number;
  vw: number;
  /** 요소 가운데 점이 화면 안이고, 그 점에서 보이는 맨 위 요소가 이 요소(또는 안/바깥 조상)다 = 머리줄 등에 가리지 않음 */
  reachable: boolean;
  inAsk: boolean;
}
const focused = (page: Page): Promise<Focus> =>
  page.evaluate(() => {
    const e = document.activeElement as HTMLElement;
    const r = e.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = Math.min(r.top + Math.min(r.height / 2, 12), r.bottom - 1);
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    let reachable = false;
    if (cx >= 0 && cx <= vw && cy >= 0 && cy <= vh) {
      const top = document.elementFromPoint(cx, cy);
      reachable = !!top && (e === top || e.contains(top) || top.contains(e));
    }
    return { id: e.id, tag: e.tagName, rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right }, vh, vw, reachable, inAsk: !!e.closest('[data-area="ask"]') };
  });
const settle = (page: Page) => page.waitForTimeout(250); // setParams(replace) → ScrollRestoration 이 도는 시간

const SIZES = [
  ["683×600 (1366 의 200%)", WIDTHS.zoom200of1366, 600],
  ["720×600 (1440 의 200%)", WIDTHS.zoom200of1440, 600],
  ["1100×600 (2영역)", WIDTHS.mid, 600],
  ["1366×400 (3영역, 낮은 창)", WIDTHS.wide1366, 400],
] as const;

test.describe("필수 1 — Tab 으로 질문 칸을 옮겨도 초점이 화면 안에 보인다 (WCAG 2.4.7·2.4.11)", () => {
  for (const [label, w, h] of SIZES) {
    test(`${label}: q-21 → … → q-22 → q-22-opinion 까지 모든 초점이 화면 안·가려지지 않음`, async ({ page }) => {
      await open(page, `${CURRENT}?view=ask`, w, h);
      await page.locator("#q-21").focus();
      await settle(page);
      const reached: string[] = [];
      for (let i = 0; i < 14; i++) {
        const f = await focused(page);
        if (!f.inAsk) break;
        reached.push(f.id || f.tag);
        expect(f.reachable, `${f.id || f.tag}: 초점이 화면 밖이거나 가려짐 (top=${f.rect.top}, bottom=${f.rect.bottom}, 화면 높이 ${f.vh})`).toBe(true);
        expect(f.rect.top, `${f.id || f.tag}: 위로 벗어남`).toBeGreaterThanOrEqual(-1);
        await page.keyboard.press("Tab");
        await settle(page);
      }
      expect(reached, `질문 영역에서 만난 초점: ${reached}`).toEqual(expect.arrayContaining(["q-21", "q-22", "q-22-opinion"]));
    });
  }
});

test.describe("필수 2 — '질문으로 가기'는 1·2영역에서도 첫 필수 질문에 초점을 둔다", () => {
  for (const [label, w, h] of [
    ["683×600", WIDTHS.zoom200of1366, 600],
    ["1100×600", WIDTHS.mid, 600],
    ["1366×600", WIDTHS.wide1366, 600],
    ["390×800", WIDTHS.phone, 800],
  ] as const) {
    test(`${label}: 클릭하면 #q-21 이 activeElement 이고 화면 안에서 보인다`, async ({ page }) => {
      await open(page, `${CURRENT}?view=body`, w, h);
      await page.getByRole("button", { name: /질문으로 가기/ }).click();
      await expect.poll(async () => (await focused(page)).id, { message: "초점이 q-21 로 가야 한다(BODY 면 질문 영역이 아직 숨겨진 때 focus() 를 부른 것)" }).toBe("q-21");
      await settle(page);
      const f = await focused(page);
      expect(f.id).toBe("q-21");
      expect(f.reachable, "q-21 이 화면 안에서 보여야 한다").toBe(true);
      expect(new URL(page.url()).searchParams.get("view")).toBe("ask");
      expect(new URL(page.url()).searchParams.get("focus")).toBe("q-21");
    });
  }

  test("키보드(Enter)로 눌러도 같다 — 683×600", async ({ page }) => {
    await open(page, `${CURRENT}?view=body`, WIDTHS.zoom200of1366, 600);
    await page.getByRole("button", { name: /질문으로 가기/ }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await focused(page)).id).toBe("q-21");
  });
});

test.describe("필수 2(같은 패턴) — 인쇄 미리보기 단추 뒤 초점은 미리보기 제목, 닫으면 연 단추", () => {
  for (const [label, w, h] of [
    ["683×600", WIDTHS.zoom200of1366, 600],
    ["1100×600", WIDTHS.mid, 600],
    ["1366×600", WIDTHS.wide1366, 600],
  ] as const) {
    test(`${label}`, async ({ page }) => {
      await open(page, `${CURRENT}?view=body`, w, h);
      await page.getByRole("button", { name: NAMES.print }).click();
      const region = page.getByRole("region", { name: NAMES.print });
      await expect(region).toBeVisible();
      await expect.poll(() => page.evaluate(() => /^H[1-6]$/.test(document.activeElement?.tagName ?? "") && !!document.activeElement?.closest('[aria-label="인쇄 미리보기"]'))).toBe(true);
      await settle(page);
      const f = await page.evaluate(() => {
        const r = document.activeElement!.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
      });
      expect(f.bottom, "제목이 화면 안").toBeGreaterThan(0);
      expect(f.top, "제목이 화면 안").toBeLessThan(f.vh);
      await region.getByRole("button", { name: /닫기/ }).click();
      await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("tool-print");
    });
  }
});

test.describe("권장 6 — 미리보기 대화 상자(peek)", () => {
  test("브라우저 뒤로 가기로 닫으면 초점이 BODY 가 아니라 연 단추로 간다", async ({ page }) => {
    await open(page, `${CURRENT}?view=ask`, WIDTHS.wide1440, 800);
    const opener = page.getByRole("button", { name: NAMES.peekOpener }).first();
    await opener.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: NAMES.peek })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("dialog", { name: NAMES.peek })).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  for (const [label, w, h] of [["1440×800", WIDTHS.wide1440, 800], ["1366×500", WIDTHS.wide1366, 500]] as const) {
    test(`${label}: 비모달 미리보기가 열려 있어도 질문 칸에 초점이 가면 가려지지 않는다 (2.4.11)`, async ({ page }) => {
      await open(page, `${CURRENT}?view=ask&peek=q-21`, w, h);
      await expect(page.getByRole("dialog", { name: NAMES.peek })).toBeVisible();
      for (const id of ["q-21", "q-22", "q-22-opinion"]) {
        await page.locator(`#${id}`).focus();
        await settle(page);
        const f = await focused(page);
        expect(f.id).toBe(id);
        expect(f.reachable, `${id}: 미리보기 대화 상자(또는 머리줄)에 가려짐`).toBe(true);
      }
    });
  }
});

test.describe("권장 8 → 최종 리뷰: <1280 은 한 열 — 보기 전환 라디오는 본문·질문 둘뿐, 낮은 창에서도 머리줄·전환 줄에 본문이 가려지지 않는다", () => {
  for (const [label, w, h] of [["1100×360", WIDTHS.mid, 360], ["683×600", WIDTHS.zoom200of1366, 600], ["1100×600", WIDTHS.mid, 600]] as const) {
    test(`${label}: 라디오 둘(본문·질문), '단계·라운드' 라디오·열 없음`, async ({ page }) => {
      await open(page, CURRENT, w, h);
      const group = page.getByRole("radiogroup", { name: NAMES.viewGroup });
      await expect(group.getByRole("radio")).toHaveCount(2);
      await expect(group.getByRole("radio", { name: REMOVED.viewRadio })).toHaveCount(0);
      await expect(page.getByRole("navigation", { name: REMOVED.navName })).toHaveCount(0);
      await expect(page.locator(`[data-area="${REMOVED.navArea}"]`)).toHaveCount(0);
    });
  }

  test("1100×360: 아래로 스크롤해도 본문 제목·도구는 머리줄·전환 줄에 덮인 채 멈추지 않는다(초점을 주면 보인다)", async ({ page }) => {
    await open(page, CURRENT, WIDTHS.mid, 360);
    for (const y of [0, 80, 200, 400]) {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await page.waitForTimeout(120);
    }
    await page.getByRole("button", { name: NAMES.print }).focus();
    await page.waitForTimeout(150);
    const covered = await page.evaluate(() => {
      const e = document.activeElement as HTMLElement;
      const r = e.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1));
      return !!top && !(e === top || e.contains(top) || top.contains(e));
    });
    expect(covered, "초점 받은 단추가 머리줄·전환 줄에 가림").toBe(false);
  });
});

test.describe("권장 10 — 인쇄 모드에서 결과 글이 한 번만 찍힌다", () => {
  test("?print=1 + 인쇄 미디어: 결과 글 첫 문장을 가진 보이는 요소는 정확히 하나", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto(`${CURRENT}?print=1`);
    await expect(page.getByRole("region", { name: NAMES.print })).toBeVisible();
    await page.emulateMedia({ media: "print" });
    const count = await page.evaluate(() => {
      const needle = "대출 수는 2019년 대비 2020년에 절반 가까이 줄었고";
      let n = 0;
      for (const el of document.querySelectorAll<HTMLElement>("body *")) {
        if (!(el.textContent ?? "").includes(needle)) continue;
        if ([...el.children].some((c) => (c.textContent ?? "").includes(needle))) continue; // 가장 안쪽만
        const cs = getComputedStyle(el);
        let visible = el.getClientRects().length > 0 && cs.visibility !== "hidden";
        for (let p: HTMLElement | null = el; p && visible; p = p.parentElement) if (getComputedStyle(p).display === "none") visible = false;
        if (visible) n++;
      }
      return n;
    });
    expect(count, "미리보기와 본문이 둘 다 나오면 결과 글이 두 번 찍힌다").toBe(1);
  });

  test("인쇄 미디어에서 앱 머리줄·사이드바·보기 전환 같은 조작 요소는 나오지 않는다", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto(`${CURRENT}?print=1`);
    await expect(page.getByRole("region", { name: NAMES.print })).toBeVisible();
    await page.emulateMedia({ media: "print" });
    const shown = await page.evaluate(() => {
      const vis = (el: Element | null) => !!el && getComputedStyle(el).display !== "none" && (el as HTMLElement).getClientRects().length > 0;
      return { radiogroup: vis(document.querySelector('[role="radiogroup"]')), header: vis(document.querySelector("header")), sidebar: vis(document.querySelector('nav[aria-label*="연구 흐름"]')) };
    });
    expect(shown).toEqual({ radiogroup: false, header: false, sidebar: false });
  });
});

test.describe("앱 셸(필수 3) — 사이드바·머리줄 기하", () => {
  const sidebarBox = async (page: Page) => {
    const nav = page.getByRole("navigation", { name: SHELL.sidebarNav });
    return (await nav.count()) ? nav.first().boundingBox({ timeout: 2_000 }).catch(() => null) : null; // 없으면 기다리지 않고 null
  };
  const mainBox = (page: Page) => page.getByRole("main").boundingBox();

  test("1440: 사이드바 펼침(폭 200~320) — 본문은 사이드바 오른쪽, 겹침·가로 스크롤 없음", async ({ page }) => {
    await open(page, CURRENT, WIDTHS.wide1440, 800);
    const [s, m] = [await sidebarBox(page), await mainBox(page)];
    expect(s, "사이드바").not.toBeNull();
    expect(s!.width).toBeGreaterThanOrEqual(200);
    expect(s!.width).toBeLessThanOrEqual(320);
    expect(m!.x, "본문 왼쪽 가장자리").toBeGreaterThanOrEqual(s!.x + s!.width - 1);
    const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, i: window.innerWidth }));
    expect(w.s).toBeLessThanOrEqual(w.i + 1);
  });

  test("사이드바 접기 단추: 접으면 본문이 넓어지고 사이드바는 아이콘 줄(폭 ≤ 96)", async ({ page }) => {
    await open(page, CURRENT, WIDTHS.wide1440, 800);
    const before = (await mainBox(page))!;
    await page.getByRole("button", { name: SHELL.sidebarToggle }).click({ timeout: 3_000 });
    await expect(page.getByRole("button", { name: SHELL.sidebarToggle })).toHaveAttribute("aria-expanded", "false");
    await expect.poll(async () => (await mainBox(page))!.width).toBeGreaterThan(before.width + 100);
    const s = await sidebarBox(page);
    expect(s, "접어도 아이콘 줄은 남는다").not.toBeNull();
    expect(s!.width, `접힌 사이드바 폭 ${s?.width}`).toBeLessThanOrEqual(96);
    const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, i: window.innerWidth }));
    expect(w.s).toBeLessThanOrEqual(w.i + 1);
  });

  test("1100 은 처음부터 아이콘 줄, 683 은 사이드바가 화면에 없다(Sheet)", async ({ page }) => {
    await open(page, CURRENT, WIDTHS.mid, 800);
    const s = await sidebarBox(page);
    expect(s, "1100 에서도 사이드바(아이콘 줄)는 있다").not.toBeNull();
    expect(s!.width).toBeLessThanOrEqual(96);
    await open(page, CURRENT, WIDTHS.zoom200of1366, 800);
    await expect(page.getByRole("navigation", { name: SHELL.sidebarNav })).toHaveCount(0);
  });

  test("Ctrl+B 로 접고 펴기(키보드만)", async ({ page }) => {
    await open(page, CURRENT, WIDTHS.wide1440, 800);
    const t = page.getByRole("button", { name: SHELL.sidebarToggle });
    await page.keyboard.press("Control+b");
    await expect(t).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Control+b");
    await expect(t).toHaveAttribute("aria-expanded", "true");
  });

  test("머리줄은 사이드바 위가 아니라 본문 열 위에 붙어 있고, 맨 위 고정이다", async ({ page }) => {
    await open(page, CURRENT, WIDTHS.wide1440, 500);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const top = await page.getByRole("banner").evaluate((h) => h.getBoundingClientRect().top);
    expect(Math.abs(top)).toBeLessThanOrEqual(1);
  });
});

test.describe("권장 5(b) — Tab 순서가 읽는 순서와 같다", () => {
  test("1440: 건너뛰기 링크 → 머리줄/사이드바 → 사이드바 단계·라운드 → 본문 도구 → 질문 q-21 → q-22 순서", async ({ page }) => {
    await open(page, `${CURRENT}?view=ask`, WIDTHS.wide1440, 800);
    const order: string[] = [];
    for (let i = 0; i < 120; i++) {
      await page.keyboard.press("Tab");
      const d = await page.evaluate(() => {
        const e = document.activeElement;
        if (!e || e === document.body) return null;
        return { id: e.id, text: (e.textContent ?? "").trim().slice(0, 20), area: e.closest("[data-area]")?.getAttribute("data-area") ?? (e.closest("header") ? "header" : e.closest('nav[aria-label*="연구 흐름"]') ? "sidebar" : "other") };
      });
      if (!d) break;
      order.push(`${d.area}:${d.id || d.text}`);
    }
    const idx = (pred: (s: string) => boolean) => order.findIndex(pred);
    const skip = idx((s) => s.includes(NAMES.skip));
    const stage = idx((s) => s.startsWith("sidebar:") && /기획|조사|분석/.test(s));
    const round = idx((s) => s.startsWith("sidebar:") && /R1|단계 시작/.test(s));
    const q21 = idx((s) => s.endsWith(":q-21"));
    const q22 = idx((s) => s.endsWith(":q-22"));
    expect(skip, order.join(" > ")).toBe(0);
    expect(stage, "사이드바 단계 링크가 Tab 에 걸린다").toBeGreaterThan(skip);
    expect(round, "사이드바 나무의 라운드 링크가 단계 링크 뒤에 걸린다").toBeGreaterThan(stage);
    expect(order.some((s) => s.startsWith("nav:")), "옛 '단계와 라운드' 열(data-area=nav)은 Tab 에 걸리면 안 된다").toBe(false);
    expect(q21, "q-21").toBeGreaterThan(round);
    expect(q22, "q-22").toBeGreaterThan(q21);
    // 머리줄·사이드바는 본문(영역)보다 먼저 온다
    const firstArea = idx((s) => /^(body|ask):/.test(s));
    for (const [i, s] of order.entries()) if (/^(header|sidebar):/.test(s)) expect(i, `${s} 는 본문 영역보다 앞`).toBeLessThan(firstArea);
  });
});

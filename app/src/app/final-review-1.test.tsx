// SEL-81 U1a (최종 리뷰 1/2 Opus 반영) — 시험 쪽 (Vitest, jsdom).
//  · 필수 2 "오류 확인": 보내는 동안 초점 유지(aria-disabled), 성공 뒤 초점이 BODY 가 아니라 결과 줄/알림 제목으로, role=status 문장
//  · 필수 1(a) 테마 결정(사용자 2026-11-12): 4종 유지 · localStorage 에만 · 기본 Modern Minimal
//  · 필수 1(b) 사이드바 접힘은 localStorage — 쿠키 0 (접힘 동작 자체는 shell.test.tsx)
//  · 권장 4·5·6: aria-controls 가 없는 id 를 가리키지 않음 · 빵부스러기 현재 곳은 aria-disabled 가 아님 · 제목 순서(h1 이 h2 보다 먼저)
// jsdom 은 CSS 가 없다 → 열 배치·폭·가려짐은 e2e(e2e/final-review-1.spec.ts)가 본다.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { initTheme } from "@/lib/theme";
import { DEFAULT_THEME, THEMES } from "@/themes/themes";
import { renderApp } from "@/test/render-app";
import { CURRENT, NAMES, PAST, SHELL, STAGE_START, WIDTHS, url } from "@/test/contract";

const ready = async () => {
  await screen.findByRole("main");
  await waitFor(() => expect(screen.getByRole("main").querySelector("[data-screen-title]")).not.toBeNull());
};

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  document.cookie = "sidebar_state=; max-age=0; path=/";
  document.documentElement.className = "";
});

/** 이 시험 파일의 환경들 — 데스크톱 1440, 200% 확대 683(마우스), 휴대폰 683·굵은 포인터 */
const ENVS = [
  ["1440×마우스", { width: WIDTHS.wide1440, coarse: false }],
  ["683×마우스(200% 확대)", { width: WIDTHS.zoom200of1366, coarse: false }],
  ["683×굵은 포인터(휴대폰)", { width: WIDTHS.zoom200of1366, coarse: true }],
] as const;

describe("필수 2 — 오류 확인: 초점을 잃지 않는다", () => {
  const ackButton = () => within(screen.getByRole("main")).getByRole("button", { name: NAMES.ackError });

  /**
   * 보내는 동안은 jsdom 에서 한 틱이라 직접 볼 수 없다 → DOM 이 바뀔 때마다 표본을 뜬다.
   * 표본마다: ① 초점이 BODY 인가 ② "오류 확인" 단추가 있으면 disabled 속성이 켜졌는가(켜지면 브라우저가 초점을 뺏는다).
   */
  function sampleFocus() {
    const samples: { onBody: boolean; disabledBtn: boolean }[] = [];
    const take = () => {
      const btn = Array.from(document.querySelectorAll<HTMLButtonElement>("main button")).find((b) => b.textContent?.trim() === NAMES.ackError);
      samples.push({ onBody: document.activeElement === document.body || document.activeElement === document.documentElement, disabledBtn: !!btn?.disabled });
    };
    const mo = new MutationObserver(take);
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    return { samples, stop: () => mo.disconnect(), take };
  }

  /** 알림 영역은 다시 그려져도 같은 제목 id 로 다시 찾는다(낡은 노드를 붙들지 않는다) */
  const alertOf = () => {
    const btn = within(screen.getByRole("main")).queryByRole("button", { name: NAMES.ackError });
    if (btn) return btn.closest("section") as HTMLElement;
    return document.querySelector<HTMLElement>("main section[aria-labelledby$='-title'][data-print='hide']")!;
  };
  async function finish(_section: HTMLElement) {
    await waitFor(() => expect(within(alertOf()).getByRole("status")).toHaveTextContent("오류를 확인했습니다"));
    return alertOf();
  }

  function expectLandedInAlert(section: HTMLElement) {
    const active = document.activeElement as HTMLElement;
    expect(active, "성공 뒤 초점이 BODY 로 떨어지면 안 된다").not.toBe(document.body);
    expect(active, "성공 뒤 초점이 문서 밖으로 나가면 안 된다").not.toBe(document.documentElement);
    expect(section.contains(active), `초점이 알림 영역 안에 있어야 한다 (지금: ${active.tagName}#${active.id})`).toBe(true);
    expect(active.getAttribute("tabindex"), "초점 받는 곳은 tabIndex -1 (결과 줄 또는 알림 제목)").toBe("-1");
    const isTitle = active.id !== "" && active.id === section.getAttribute("aria-labelledby");
    const isResultLine = /확인함 · 접수 \d+/.test(active.textContent ?? "");
    expect(isTitle || isResultLine, `결과 줄("확인함 · 접수 NNNN") 또는 알림 제목이어야 한다 (지금: ${active.textContent})`).toBe(true);
  }

  it.each(ENVS)("%s: Enter 로 누르면 초점이 BODY 로 한 번도 떨어지지 않고, disabled 속성을 쓰지 않으며, 성공 뒤 결과 줄/제목에 있다", async (_label, env) => {
    const user = userEvent.setup();
    await renderApp(CURRENT, env);
    await ready();
    const btn = ackButton();
    const section = btn.closest("section") as HTMLElement;
    expect(section, "알림 영역(section)").not.toBeNull();
    btn.focus();
    expect(document.activeElement).toBe(btn);
    const watch = sampleFocus();
    await user.keyboard("{Enter}");
    const after = await finish(section);
    watch.take();
    watch.stop();
    expect(watch.samples.length, "표본이 있어야 시험이 의미가 있다").toBeGreaterThan(0);
    expect(watch.samples.filter((s) => s.disabledBtn), "보내는 동안 disabled 속성 금지 — aria-disabled + 핸들러 무시(설계 12.6 R05)").toHaveLength(0);
    expect(watch.samples.filter((s) => s.onBody), "누른 뒤 초점이 BODY 인 순간이 있었다").toHaveLength(0);
    expectLandedInAlert(after);
  });

  it.each(ENVS)("%s: 마우스로 눌러도 같다 — 성공 뒤 초점이 알림 영역 안, role=status 는 '오류를 확인했습니다'", async (_label, env) => {
    const user = userEvent.setup();
    await renderApp(CURRENT, env);
    await ready();
    const section = ackButton().closest("section") as HTMLElement;
    await user.click(ackButton());
    const after = await finish(section);
    expectLandedInAlert(after);
    expect(within(after).getByRole("status")).toHaveTextContent("오류를 확인했습니다");
    expect(within(after).queryByRole("button", { name: NAMES.ackError }), "확인한 알림에는 단추가 더 없다").toBeNull();
    expect(after.textContent).toMatch(/확인함 · 접수 \d+/);
  });

  it("두 번 빨리 눌러도 접수는 하나다(같은 키 재전송 — 영수증이 둘로 갈라지지 않음)", async () => {
    const user = userEvent.setup();
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    const btn = ackButton();
    const section = btn.closest("section") as HTMLElement;
    btn.focus();
    await user.keyboard("{Enter}{Enter}");
    const after = await finish(section);
    expect(after.textContent?.match(/접수 \d+/g) ?? []).toHaveLength(1);
  });

  it("보내기 전에는 단추가 aria-disabled 도 disabled 도 아니다(누를 수 있음)", async () => {
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    expect(ackButton()).not.toBeDisabled();
    expect(ackButton()).not.toHaveAttribute("aria-disabled", "true");
  });
});

describe("필수 1(a) — 테마: 4종 유지 · localStorage 에만 · 기본 Modern Minimal (사용자 결정 2026-11-12)", () => {
  it("테마는 정확히 네 개이고 기본은 Modern Minimal 이다", () => {
    expect(THEMES.map((t) => t.id)).toEqual(["modern-minimal", "vercel", "graphite", "clean-slate"]);
    expect(THEMES.map((t) => t.name)).toEqual(["Modern Minimal", "Vercel", "Graphite", "Clean Slate"]);
    expect(DEFAULT_THEME).toBe("modern-minimal");
  });

  it("저장된 것이 없으면 Modern Minimal(밝게)로 시작한다 — 다른 테마 클래스·어두운 모드 없음", async () => {
    initTheme();
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    const cls = document.documentElement.classList;
    expect(cls.contains("theme-modern-minimal")).toBe(true);
    for (const t of THEMES.filter((t) => t.id !== "modern-minimal")) expect(cls.contains(`theme-${t.id}`), t.id).toBe(false);
    expect(cls.contains("dark")).toBe(false);
  });

  it("고르면 localStorage 에만 남는다 — 쿠키·sessionStorage 에는 테마가 없다", async () => {
    const user = userEvent.setup();
    initTheme();
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    const pick = THEMES[2]!;
    await user.click(screen.getByRole("button", { name: SHELL.theme }));
    await user.click(await screen.findByRole("menuitemradio", { name: new RegExp(pick.name) }));
    expect(document.documentElement.classList.contains(`theme-${pick.id}`)).toBe(true);
    expect(window.localStorage.getItem("pes-theme") ?? "").toContain(pick.id);
    expect(Object.values({ ...window.sessionStorage }).join("|")).not.toContain(pick.id);
    expect(document.cookie, "쿠키 0 — 서버에 보내지 않는다").toBe("");
  });
});

describe("권장 4 — aria-controls 는 문서에 있는 id 만 가리킨다 (닫힌 상태에서도)", () => {
  const cases = [
    ["조사 R2 1440", CURRENT, { width: WIDTHS.wide1440 }],
    ["조사 R2 질문 보기 683", `${CURRENT}?view=ask`, { width: WIDTHS.zoom200of1366 }],
    ["기획 R1(지난 라운드)", PAST, { width: WIDTHS.wide1440 }],
    ["조사 단계 시작", STAGE_START, { width: WIDTHS.wide1440 }],
    ["조사 R1(지난)", url("research", 1), { width: WIDTHS.wide1440 }],
  ] as const;
  it.each(cases)("%s", async (_label, path, env) => {
    await renderApp(path, env);
    await ready();
    const dangling: string[] = [];
    for (const el of document.querySelectorAll("[aria-controls]")) {
      for (const id of (el.getAttribute("aria-controls") ?? "").split(/\s+/).filter(Boolean)) {
        if (!document.getElementById(id)) dangling.push(`${el.tagName.toLowerCase()}[${(el.textContent ?? "").trim().slice(0, 16)}] → #${id}`);
      }
    }
    expect(dangling, "열렸을 때만 aria-controls 를 붙이거나, 패널을 늘 그리고 hidden 으로 숨긴다").toEqual([]);
  });
});

describe("권장 5 — 빵부스러기의 현재 곳은 aria-current 만 쓴다 (aria-disabled·role=link 없음)", () => {
  it("현재 곳 요소에 aria-disabled 가 없고 링크 역할도 아니다", async () => {
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    const crumbs = within(screen.getByRole("banner")).getByRole("navigation", { name: SHELL.crumbs });
    const here = crumbs.querySelector('[aria-current="page"]') as HTMLElement;
    expect(here).not.toBeNull();
    expect(here.getAttribute("aria-disabled"), "현재 위치는 aria-current=page 만으로 충분").toBeNull();
    expect(here.getAttribute("role")).not.toBe("link");
  });

  it("머리줄 안 aria-disabled 요소는 모두 이유 글(aria-describedby)이 있다 — 예외 없음", async () => {
    await renderApp(CURRENT, { width: WIDTHS.zoom200of1366, coarse: true });
    await ready();
    const bad: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("header [aria-disabled='true']")) {
      const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
      const reason = ids.map((id) => document.getElementById(id)?.textContent ?? "").join("").trim();
      if (!reason) bad.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 16)}"`);
    }
    expect(bad).toEqual([]);
  });
});

describe("권장 6 — 제목 순서: 화면 제목(h1)이 어떤 h2 보다도 먼저 나온다", () => {
  it.each([[CURRENT], [PAST], [STAGE_START], [`${CURRENT}?view=ask`]])("%s", async (path) => {
    await renderApp(path, { width: WIDTHS.wide1440 });
    await ready();
    const heads = Array.from(document.querySelectorAll("h1, h2"));
    const h1 = heads.findIndex((h) => h.tagName === "H1");
    expect(h1, "h1 이 있다").toBeGreaterThanOrEqual(0);
    expect(heads.filter((h) => h.tagName === "H1")).toHaveLength(1);
    expect(heads.slice(0, h1).map((h) => h.textContent), "h1 앞에 h2 가 있으면 안 된다").toEqual([]);
  });
});

describe("필수 1(d) — 900 미만: 단계·라운드는 사이드바 Sheet 안 나무에서만 연다", () => {
  it("Sheet 를 열면 조사 라운드(단계 시작·R1·R2)가 보이고, R1 을 누르면 Sheet 가 닫히고 새 화면 제목으로 초점이 간다", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(CURRENT, { width: WIDTHS.zoom200of1366 });
    await ready();
    expect(screen.queryByRole("navigation", { name: SHELL.sidebarNav }), "닫힌 동안은 없다").toBeNull();
    await user.click(screen.getByRole("button", { name: SHELL.sidebarToggle }));
    const dialog = await screen.findByRole("dialog", { name: /사이드바|메뉴|탐색/ });
    const nav = within(dialog).getByRole("navigation", { name: SHELL.sidebarNav });
    const hrefs = within(nav).getAllByRole("link").map((l) => l.getAttribute("href"));
    for (const h of [url("research", "start"), url("research", 1), url("research", 2)]) expect(hrefs, h).toContain(h);
    await user.click(nav.querySelector(`a[href="${url("research", 1)}"]`) as HTMLElement);
    await waitFor(() => expect(router.state.location.pathname).toBe(url("research", 1)));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /사이드바|메뉴|탐색/ })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("main").querySelector("[data-screen-title]")));
  });
});

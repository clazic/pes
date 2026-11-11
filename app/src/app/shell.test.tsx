// SEL-81 U1a (R1 필수 3·권장 7) — 앱 셸 구조: 사이드바 · 머리줄 · 랜드마크 · 상태 이름 (Vitest, jsdom).
// 승인 시안(shadcn sidebar-07 앱 셸 + 머리줄 + 연구 공간 틀, 설계 12.9 · 결정 0017 영향 12)을 따른다. 계약 이름은 src/test/contract.ts 의 SHELL.
// 명령 찾기·알림은 U1a 에 기능이 없다 → 자리만(aria-disabled + 이유). 기능은 U1c(명령 찾기)·U1d(알림) 몫.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";
import { CURRENT, NAMES, SHELL, WIDTHS } from "@/test/contract";

const ready = async () => {
  await screen.findByRole("main");
  await waitFor(() => expect(screen.getByRole("main").querySelector("[data-screen-title]")).not.toBeNull());
};
const clearSidebarCookie = () => {
  document.cookie = "sidebar_state=; max-age=0; path=/";
};
const toggle = () => screen.getByRole("button", { name: SHELL.sidebarToggle });
const sidebarNav = () => screen.queryByRole("navigation", { name: SHELL.sidebarNav });
const reasonOf = (btn: HTMLElement) =>
  (btn.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ")
    .trim();

beforeEach(() => {
  clearSidebarCookie();
  document.documentElement.className = "";
});

describe("랜드마크", () => {
  it("머리줄(banner) 하나 · 본문(main) 하나 · 질문 영역(complementary)은 main 안에 있지 않다", async () => {
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    const aside = screen.getByRole("complementary", { name: NAMES.ask });
    expect(screen.getByRole("main").contains(aside), "aside 가 main 안에 있으면 최상위 랜드마크 규칙(landmark-complementary-is-top-level) 위반").toBe(false);
    expect(screen.getByRole("banner").contains(screen.getByRole("main"))).toBe(false);
  });

  it("사이드바 부분은 main·banner 밖의 이름 있는 navigation 이다", async () => {
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    const side = sidebarNav();
    expect(side).not.toBeNull();
    expect(screen.getByRole("main").contains(side)).toBe(false);
    expect(screen.getByRole("banner").contains(side)).toBe(false);
    // 본문 안 단계·라운드 탐색(3영역의 한 영역)은 따로 그대로 있다
    expect(screen.getByRole("navigation", { name: NAMES.nav })).toBeInTheDocument();
  });
});

describe("머리줄", () => {
  it("빵부스러기(현재 위치) — 프로젝트 이름과 지금 보는 곳(aria-current=page)", async () => {
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    const crumbs = within(screen.getByRole("banner")).getByRole("navigation", { name: SHELL.crumbs });
    expect(crumbs.textContent).toMatch(/예시 연구/);
    const here = crumbs.querySelector('[aria-current="page"]');
    expect(here, "현재 곳 표시").not.toBeNull();
    expect(here!.textContent).toMatch(/조사|R2/);
  });

  it("사이드바 접기 · 명령 찾기 · 알림 · 테마 · 사용자 요소가 머리줄에 있다", async () => {
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    const header = within(screen.getByRole("banner"));
    expect(header.getByRole("button", { name: SHELL.sidebarToggle })).toBeInTheDocument();
    expect(header.getByRole("button", { name: SHELL.command })).toBeInTheDocument();
    expect(header.getByRole("button", { name: SHELL.notifications })).toBeInTheDocument();
    expect(header.getByRole("button", { name: SHELL.theme })).toBeInTheDocument();
    expect(header.getByRole("button", { name: SHELL.user })).toBeInTheDocument();
  });

  it("명령 찾기·알림은 U1a 에서 자리만: aria-disabled + 이유 글, 눌러도 아무것도 열리지 않는다", async () => {
    const user = userEvent.setup();
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    const header = within(screen.getByRole("banner"));
    for (const name of [SHELL.command, SHELL.notifications]) {
      const btn = header.getByRole("button", { name });
      expect(btn, String(name)).toHaveAttribute("aria-disabled", "true");
      expect(btn, String(name)).not.toBeDisabled(); // 초점을 받아 이유를 읽힌다
      expect(reasonOf(btn).length, `${name} 이유 글`).toBeGreaterThan(4);
      await user.click(btn);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByRole("menu")).toBeNull();
    }
  });

  it("Ctrl+K 도 U1a 에서는 명령 창을 열지 않는다(U1c 몫)", async () => {
    const user = userEvent.setup();
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("사이드바 — 단계·상태 이름은 상태 사전 그대로", () => {
  it("연구 흐름: 단계 링크 + 승인됨 · 현재 · 나의 할 일 · 시작 전, '모든 프로젝트' 링크", async () => {
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    const side = within(sidebarNav()!);
    for (const t of [/기획/, /조사/, /분석/]) expect(side.getByRole("link", { name: t })).toBeInTheDocument();
    const text = sidebarNav()!.textContent ?? "";
    for (const s of Object.values(SHELL.stageStates)) expect(text, s).toContain(s);
    expect(screen.getByRole("link", { name: SHELL.backToAll })).toBeInTheDocument();
  });

  it("지금 할 일 줄에 차례 말이 사전 이름 그대로('나의 할 일 1건') — 영문 상태 키는 화면에 나오지 않는다", async () => {
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    const main = screen.getByRole("main");
    expect(main.textContent).toContain(SHELL.turnYou);
    expect(document.body.textContent).not.toMatch(/\b(current_you|current_ai|waiting_human|approved|pending)\b/);
  });
});

describe("사이드바 접기", () => {
  it("≥1280 은 펼침, 단추 → 접힘 → 다시 펼침, 쿠키 sidebar_state 가 남는다", async () => {
    const user = userEvent.setup();
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(document.cookie).toContain("sidebar_state=false");
    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(document.cookie).toContain("sidebar_state=true");
  });

  it("접혀도 단계 링크의 이름은 남는다(아이콘 줄 — 화면 읽기·툴팁 이름)", async () => {
    const user = userEvent.setup();
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    const side = within(sidebarNav()!);
    for (const t of [/기획/, /조사/, /분석/]) expect(side.getByRole("link", { name: t })).toBeInTheDocument();
  });

  it("Ctrl+B 로 접고 펴며, 한글 조합 중(isComposing)에는 무시한다", async () => {
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    fireEvent.keyDown(document.body, { key: "b", ctrlKey: true });
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-expanded", "false"));
    fireEvent.keyDown(document.body, { key: "b", ctrlKey: true });
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-expanded", "true"));
    fireEvent.keyDown(document.body, { key: "b", ctrlKey: true, isComposing: true });
    fireEvent.keyDown(document.body, { key: "b", ctrlKey: true, keyCode: 229 });
    await new Promise((r) => setTimeout(r, 50));
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
  });

  it("사람이 바꾼 상태(쿠키)는 폭과 상관없이 처음 상태를 이긴다", async () => {
    document.cookie = "sidebar_state=false; path=/";
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("1280 미만(900~1279)은 처음에 아이콘 줄(접힘)", async () => {
    await renderApp(CURRENT, { width: WIDTHS.mid });
    await ready();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("900 미만은 사이드바가 단추로 여는 대화 상자(Sheet)다 — 닫으면 연 단추로 초점, Esc 로 닫힘", async () => {
    const user = userEvent.setup();
    await renderApp(CURRENT, { width: WIDTHS.zoom200of1366 });
    await ready();
    expect(sidebarNav(), "닫힌 동안 사이드바가 읽히거나 Tab 에 걸리면 안 된다").toBeNull();
    await user.click(toggle());
    const dialog = await screen.findByRole("dialog", { name: /사이드바|메뉴|탐색/ });
    expect(within(dialog).getByRole("navigation", { name: SHELL.sidebarNav })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /사이드바|메뉴|탐색/ })).toBeNull());
    expect(toggle()).toHaveFocus();
  });
});

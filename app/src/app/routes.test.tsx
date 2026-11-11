// SEL-81 U1a — 라우트·쿼리·단계/라운드 표시 (Vitest, jsdom). 구현 전이므로 실패가 정상(@/app/routes 가 아직 없다).
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderApp, query } from "@/test/render-app";
import { CURRENT, NAMES, PAST, STAGE_START, url } from "@/test/contract";

const title = async () => {
  const main = await screen.findByRole("main");
  await waitFor(() => expect(main.querySelector("[data-screen-title]")).not.toBeNull());
  return main.querySelector("[data-screen-title]") as HTMLElement;
};

describe("라우트 /p/<slug>/e/<edition>/s/<stage>/r/<round>", () => {
  it("현재 라운드·지난 라운드·단계 시작이 각자 제목으로 그려진다", async () => {
    const a = await renderApp(CURRENT);
    expect((await title()).textContent).toContain("조사 R2");
    a.unmount();
    const b = await renderApp(PAST);
    expect((await title()).textContent).toContain("기획 R1");
    b.unmount();
    await renderApp(STAGE_START);
    expect((await title()).textContent).toContain("조사 단계 시작");
  });

  it("round_id=NULL 인 단계 시작은 '단계 시작'이라 쓰고 가짜 R0 을 만들지 않는다", async () => {
    await renderApp(STAGE_START);
    await title();
    const nav = screen.getByRole("navigation", { name: NAMES.nav });
    expect(within(nav).getAllByText(/단계 시작/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/\bR0\b/);
  });

  it("없는 라운드(r/0)와 모르는 주소는 '찾을 수 없음' 화면이고 단계 시작으로 오해하지 않는다", async () => {
    await renderApp(url("research", 0));
    expect(await screen.findByText(/찾을 수 없/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/조사 단계 시작/);
  });

  it("모르는 view·focus·peek 값은 무시하고 기본 화면을 그린다(오류 화면 아님)", async () => {
    const { router } = await renderApp(`${CURRENT}?view=zzz&focus=nope&peek=nope&print=banana`);
    expect((await title()).textContent).toContain("조사 R2");
    expect(screen.queryByText(/찾을 수 없/)).toBeNull();
    expect(screen.queryByRole("dialog", { name: NAMES.peek })).toBeNull();
    expect(screen.queryByRole("region", { name: NAMES.print })).toBeNull();
    expect(router.state.location.pathname).toBe(CURRENT);
  });
});

describe("단계·라운드 탐색(1영역) · 과거/현재 구분", () => {
  it("단계 셋과 라운드가 링크로 있고 보는 라운드는 aria-current=page", async () => {
    await renderApp(CURRENT);
    await title();
    const nav = screen.getByRole("navigation", { name: NAMES.nav });
    for (const s of ["기획", "조사", "분석"]) expect(within(nav).getAllByText(new RegExp(s)).length).toBeGreaterThan(0);
    const r2 = within(nav).getAllByRole("link", { name: /R2/ }).find((l) => l.getAttribute("aria-current") === "page");
    expect(r2, "보는 라운드 R2 링크").toBeDefined();
    expect(r2!.getAttribute("href")).toBe(CURRENT);
  });

  it("과거 단계는 '승인', 현재 진행 라운드는 '현재 진행', 아직 안 열린 단계는 '아직'을 보인다", async () => {
    await renderApp(CURRENT);
    await title();
    const nav = screen.getByRole("navigation", { name: NAMES.nav });
    expect(nav.textContent).toMatch(/승인/);
    expect(nav.textContent).toMatch(/현재 진행/);
    expect(nav.textContent).toMatch(/아직/);
  });

  it("지난 라운드를 보면 본문은 '지난 라운드 · 보는 중', 탐색은 '현재 진행'을 함께 보인다", async () => {
    await renderApp(url("research", 1));
    await title();
    const main = screen.getByRole("main");
    expect(main.textContent).toMatch(/지난 라운드/);
    expect(main.textContent).toMatch(/보는 중/);
    expect(screen.getByRole("navigation", { name: NAMES.nav }).textContent).toMatch(/현재 진행/);
  });

  it("라운드 링크를 누르면 주소와 화면이 바뀐다(뒤로 가기로 되돌아온다)", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(CURRENT);
    await title();
    const nav = screen.getByRole("navigation", { name: NAMES.nav });
    await user.click(within(nav).getAllByRole("link", { name: /R1/ }).find((l) => /\/s\/research\//.test(l.getAttribute("href") ?? ""))!);
    await waitFor(() => expect(router.state.location.pathname).toBe(url("research", 1)));
    expect((await title()).textContent).toContain("조사 R1");
    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.pathname).toBe(CURRENT));
    expect((await title()).textContent).toContain("조사 R2");
  });
});

describe("view 쿼리 — 좁은 화면 보기 전환", () => {
  it.each([["nav", NAMES.viewNav], ["body", NAMES.viewBody], ["ask", NAMES.viewAsk]])("view=%s 면 라디오 '%s' 가 골라져 있다", async (view, label) => {
    await renderApp(`${CURRENT}?view=${view}`, { width: 683 });
    await title();
    const group = screen.getByRole("radiogroup", { name: NAMES.viewGroup });
    expect(within(group).getByRole("radio", { name: label })).toBeChecked();
  });

  it("라디오를 바꾸면 view 쿼리가 따라 바뀌고(새 기록 칸을 쌓지 않고) 다시 불러와도 같다", async () => {
    const user = userEvent.setup();
    const { router, unmount } = await renderApp(CURRENT, { width: 683 });
    await title();
    await user.click(within(screen.getByRole("radiogroup", { name: NAMES.viewGroup })).getByRole("radio", { name: NAMES.viewAsk }));
    await waitFor(() => expect(query(router).get("view")).toBe("ask"));
    const search = router.state.location.search;
    unmount();
    await renderApp(`${CURRENT}${search}`, { width: 683 });
    await title();
    expect(within(screen.getByRole("radiogroup", { name: NAMES.viewGroup })).getByRole("radio", { name: NAMES.viewAsk })).toBeChecked();
  });
});

describe("peek·print 쿼리", () => {
  it("peek=q-21 이면 미리보기 대화 상자가 열리고, Esc 로 닫으면 peek 가 지워지고 초점이 연 단추로 돌아간다", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(CURRENT);
    await title();
    const opener = screen.getAllByRole("button", { name: NAMES.peekOpener })[0]!;
    await user.click(opener);
    const dialog = await screen.findByRole("dialog", { name: NAMES.peek });
    expect(dialog).toBeVisible();
    await waitFor(() => expect(query(router).has("peek")).toBe(true));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: NAMES.peek })).toBeNull());
    expect(query(router).has("peek")).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("딥링크 peek=q-21 은 처음부터 열린 미리보기를 그린다", async () => {
    await renderApp(`${CURRENT}?peek=q-21`);
    expect(await screen.findByRole("dialog", { name: NAMES.peek })).toBeVisible();
  });

  it("print=1 은 '인쇄 미리보기' 영역을 그리되 window.print 를 저절로 부르지 않는다", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    await renderApp(`${CURRENT}?print=1`);
    expect(await screen.findByRole("region", { name: NAMES.print })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 300));
    expect(print).not.toHaveBeenCalled();
    print.mockRestore();
  });
});

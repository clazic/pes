// SEL-81 U1a — 라우트·쿼리·단계/라운드 표시 (Vitest, jsdom). 구현 전이므로 실패가 정상(@/app/routes 가 아직 없다).
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderApp, query } from "@/test/render-app";
import { CURRENT, NAMES, PAST, REMOVED, SHELL, STAGE_START, url } from "@/test/contract";

const title = async () => {
  const main = await screen.findByRole("main");
  await waitFor(() => expect(main.querySelector("[data-screen-title]")).not.toBeNull());
  return main.querySelector("[data-screen-title]") as HTMLElement;
};

/** 단계·라운드는 사이드바 `연구 흐름` 나무 하나뿐이다(최종 리뷰 필수 1(d) — 설계 12.9) */
const flow = () => screen.getByRole("navigation", { name: SHELL.sidebarNav });
/** 나무의 라운드 링크(단계 링크는 가장 최근 라운드 주소를 가지므로 이름으로 가린다 — 라운드 링크 이름에는 "R<n>" 또는 "단계 시작") */
const roundLinks = (nav: HTMLElement) => within(nav).getAllByRole("link").filter((l) => /R\d|단계 시작/.test(l.textContent ?? ""));

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
    expect(within(flow()).getAllByText(/단계 시작/).length).toBeGreaterThan(0);
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

describe("단계·라운드 탐색 = 사이드바 연구 흐름 나무 · 과거/현재 구분", () => {
  it("단계 셋 아래 라운드가 링크로 있고(조사 단계 시작·R1·R2) 보는 라운드는 aria-current=page 하나", async () => {
    await renderApp(CURRENT);
    await title();
    const nav = flow();
    for (const s of ["기획", "조사", "분석"]) expect(within(nav).getAllByText(new RegExp(s)).length).toBeGreaterThan(0);
    const research = roundLinks(nav).filter((l) => /\/s\/research\/r\//.test(l.getAttribute("href") ?? ""));
    expect(research.map((l) => l.getAttribute("href")).sort()).toEqual([url("research", 1), url("research", 2), url("research", "start")].sort());
    expect(research.some((l) => /단계 시작/.test(l.textContent ?? ""))).toBe(true);
    const here = nav.querySelectorAll('a[aria-current="page"]');
    expect(here, "보는 라운드 링크는 사이드바 안에 정확히 하나").toHaveLength(1);
    expect(here[0]!.getAttribute("href")).toBe(CURRENT);
    expect(here[0]!.textContent).toMatch(/R2/);
  });

  it("라운드는 단계 링크 바로 아래(같은 나무)에 있다 — 조사 단계 링크가 조사 라운드 링크보다 문서에서 앞", async () => {
    await renderApp(CURRENT);
    await title();
    const links = within(flow()).getAllByRole("link");
    const stage = links.findIndex((l) => /조사/.test(l.textContent ?? "") && !/R\d|단계 시작/.test(l.textContent ?? ""));
    const r2 = links.findIndex((l) => l.getAttribute("href") === CURRENT && /R2/.test(l.textContent ?? ""));
    expect(stage, "조사 단계 링크").toBeGreaterThanOrEqual(0);
    expect(r2, "R2 라운드 링크").toBeGreaterThan(stage);
  });

  it("지금 보는 단계(과거 기획)도 라운드가 펼쳐져 보는 라운드(기획 R1)가 aria-current=page, 현재 단계(조사)도 펼침", async () => {
    await renderApp(PAST);
    await title();
    const nav = flow();
    const here = nav.querySelectorAll('a[aria-current="page"]');
    expect(here).toHaveLength(1);
    expect(here[0]!.getAttribute("href")).toBe(PAST);
    expect(roundLinks(nav).some((l) => l.getAttribute("href") === CURRENT && /R2/.test(l.textContent ?? "")), "현재 단계(조사)의 현재 진행 라운드 R2 도 펼쳐져 있다").toBe(true);
  });

  it("과거 단계는 '승인됨', 현재 진행 라운드는 '현재 진행', 아직 안 열린 단계는 '시작 전' — 상태 사전 이름 그대로", async () => {
    await renderApp(CURRENT);
    await title();
    const text = flow().textContent ?? "";
    expect(text).toContain(SHELL.stageStates.approved);
    expect(text).toMatch(/현재 진행/);
    expect(text).toContain(SHELL.stageStates.pending);
  });

  it("옛 '단계와 라운드' 열(navigation · data-area=nav)은 어디에도 없다", async () => {
    await renderApp(CURRENT);
    await title();
    expect(screen.queryByRole("navigation", { name: REMOVED.navName })).toBeNull();
    expect(document.querySelector(`[data-area="${REMOVED.navArea}"]`)).toBeNull();
  });

  it("지난 라운드를 보면 본문은 '지난 라운드 · 보는 중', 탐색은 '현재 진행'을 함께 보인다", async () => {
    await renderApp(url("research", 1));
    await title();
    const main = screen.getByRole("main");
    expect(main.textContent).toMatch(/지난 라운드/);
    expect(main.textContent).toMatch(/보는 중/);
    expect(flow().textContent).toMatch(/현재 진행/);
  });

  it("라운드 링크를 누르면 주소와 화면이 바뀐다(뒤로 가기로 되돌아온다)", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(CURRENT);
    await title();
    await user.click(roundLinks(flow()).find((l) => /R1/.test(l.textContent ?? "") && /\/s\/research\//.test(l.getAttribute("href") ?? ""))!);
    await waitFor(() => expect(router.state.location.pathname).toBe(url("research", 1)));
    // the address changes before the heading re-renders: wait for the CURRENT heading to say it (same assertion, waited for).
    // Flaky three times on CI (#58·#60 Windows, #61 macOS) when the old h1 was read right after the address moved.
    await waitFor(async () => expect((await title()).textContent).toContain("조사 R1"));
    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.pathname).toBe(CURRENT));
    await waitFor(async () => expect((await title()).textContent).toContain("조사 R2"));
  });
});

describe("view 쿼리 — 좁은 화면 보기 전환", () => {
  it.each([["body", NAMES.viewBody], ["ask", NAMES.viewAsk]])("view=%s 면 라디오 '%s' 가 골라져 있다", async (view, label) => {
    await renderApp(`${CURRENT}?view=${view}`, { width: 683 });
    await title();
    const group = screen.getByRole("radiogroup", { name: NAMES.viewGroup });
    expect(within(group).getByRole("radio", { name: label })).toBeChecked();
  });

  it.each([683, 1100])("%ipx: view=nav 는 더 이상 값이 아니다 — 오류 없이 본문(기본)으로 그리고 '단계·라운드' 라디오는 없다", async (width) => {
    await renderApp(`${CURRENT}?view=nav`, { width });
    expect((await title()).textContent).toContain("조사 R2");
    expect(screen.queryByText(/찾을 수 없/)).toBeNull();
    const group = screen.getByRole("radiogroup", { name: NAMES.viewGroup });
    expect(within(group).getByRole("radio", { name: NAMES.viewBody })).toBeChecked();
    expect(within(group).queryByRole("radio", { name: REMOVED.viewRadio })).toBeNull();
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

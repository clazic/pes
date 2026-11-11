// SEL-81 U1a — 키보드만으로 단계·라운드·질문에 닿고 Tab 덫·초점 상실이 없다 (Vitest, jsdom + user-event).
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";
import { CURRENT, NAMES, url } from "@/test/contract";

const describeEl = (el: Element | null) => (el ? `${el.tagName.toLowerCase()}#${el.id}|${el.getAttribute("href") ?? ""}|${(el.textContent ?? "").trim().slice(0, 30)}` : "null");
const ready = async () => {
  await screen.findByRole("main");
  await waitFor(() => expect(screen.getByRole("main").querySelector("[data-screen-title]")).not.toBeNull());
};

/** Tab 을 최대 n 번 누르며 만난 초점 목록. 문서 끝에서 body 로 빠지면 한 바퀴로 보고 멈춘다. */
async function tabAll(user: ReturnType<typeof userEvent.setup>, n = 150) {
  const seen: Element[] = [];
  for (let i = 0; i < n; i++) {
    await user.tab();
    const el = document.activeElement;
    if (!el || el === document.body) break;
    seen.push(el);
  }
  return seen;
}

describe("Tab 순서", () => {
  it("첫 Tab 은 건너뛰기 링크, 이어서 단계 링크·라운드 링크·질문 q-21·q-22 에 닿는다", async () => {
    const user = userEvent.setup();
    await renderApp(`${CURRENT}?view=ask`, { width: 1440 });
    await ready();
    const seen = await tabAll(user);
    expect(seen[0]).toBe(screen.getByRole("link", { name: NAMES.skip }));
    const nav = screen.getByRole("navigation", { name: NAMES.nav });
    expect(seen.some((e) => nav.contains(e) && /기획|조사|분석/.test(e.textContent ?? ""))).toBe(true);
    expect(seen.some((e) => nav.contains(e) && /R1/.test(e.textContent ?? ""))).toBe(true);
    expect(seen.map((e) => e.id)).toEqual(expect.arrayContaining(["q-21", "q-22"]));
  });

  it("Tab 덫이 없다 — 같은 요소가 되풀이되기 전에 문서 끝(body)으로 나간다", async () => {
    const user = userEvent.setup();
    await renderApp(CURRENT, { width: 1440 });
    await ready();
    const seen = await tabAll(user, 200);
    const keys = seen.map(describeEl);
    expect(new Set(keys).size, `반복된 초점: ${keys.join(" > ")}`).toBe(keys.length);
    expect(seen.length).toBeLessThan(200);
  });

  it("Shift+Tab 으로 질문에서 거꾸로 건너뛰기 링크까지 돌아온다", async () => {
    const user = userEvent.setup();
    await renderApp(`${CURRENT}?view=ask&focus=q-22`, { width: 1440 });
    await ready();
    await waitFor(() => expect(document.activeElement?.id).toBe("q-22"));
    let reached = false;
    for (let i = 0; i < 150 && !reached; i++) {
      await user.tab({ shift: true });
      reached = document.activeElement === screen.getByRole("link", { name: NAMES.skip });
    }
    expect(reached).toBe(true);
  });
});

describe("키보드로 여는 것", () => {
  it("건너뛰기 링크 Enter → 본문으로 초점이 간다", async () => {
    const user = userEvent.setup();
    await renderApp(CURRENT);
    await ready();
    await user.tab();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("main").contains(document.activeElement) || document.activeElement === screen.getByRole("main")).toBe(true));
  });

  it("라운드 링크에 Tab 으로 가서 Enter → 새 화면 제목으로 초점, 초점 상실 없음", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(CURRENT, { width: 1440 });
    await ready();
    const target = url("research", 1);
    let guard = 0;
    while ((document.activeElement as HTMLAnchorElement | null)?.getAttribute?.("href") !== target && guard++ < 150) await user.tab();
    expect(guard).toBeLessThan(150);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(router.state.location.pathname).toBe(target));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("main").querySelector("[data-screen-title]")));
  });

  it("미리보기 대화 상자: Enter 로 열고 Esc 로 닫으면 초점이 그 단추로 돌아온다", async () => {
    const user = userEvent.setup();
    await renderApp(`${CURRENT}?view=ask`);
    await ready();
    const opener = screen.getAllByRole("button", { name: NAMES.peekOpener })[0]!;
    opener.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: NAMES.peek })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: NAMES.peek })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("좁은 화면 보기 라디오는 화살표 키로 옮겨 가고 view 가 바뀐다", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(CURRENT, { width: 683 });
    await ready();
    const group = screen.getByRole("radiogroup", { name: NAMES.viewGroup });
    const body = Array.from(group.querySelectorAll<HTMLElement>('[role="radio"], input[type="radio"]')).find((r) => /본문/.test(r.getAttribute("aria-label") ?? r.closest("label")?.textContent ?? r.textContent ?? ""))!;
    body.focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get("view")).toBe("ask"));
  });
});

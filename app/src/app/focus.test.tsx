// SEL-81 U1a — 초점·URL 복원·화면 바뀜 때 새 화면 제목으로 초점 (Vitest, jsdom).
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp, query } from "@/test/render-app";
import { CURRENT, NAMES, PAST, url } from "@/test/contract";

const titleEl = () => screen.getByRole("main").querySelector("[data-screen-title]") as HTMLElement | null;
const ready = async () => {
  await screen.findByRole("main");
  await waitFor(() => expect(titleEl()).not.toBeNull());
};

describe("focus 쿼리 — 같은 초점 복원", () => {
  it("딥링크 focus=q-22 는 그 요소를 document.activeElement 로 둔다", async () => {
    await renderApp(`${CURRENT}?view=ask&focus=q-22`);
    await ready();
    await waitFor(() => expect(document.activeElement?.id).toBe("q-22"));
  });

  it("처음 불러올 때 focus 가 없으면 초점을 훔치지 않는다(첫 Tab = 건너뛰기 링크)", async () => {
    const user = userEvent.setup();
    await renderApp(CURRENT);
    await ready();
    await new Promise((r) => setTimeout(r, 300));
    expect(document.activeElement === document.body || document.activeElement === document.documentElement).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: NAMES.skip }));
  });

  it("질문 영역에서 초점을 옮기면 URL 의 focus 가 따라 바뀐다(replace — 새 기록 칸 없음)", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(`${CURRENT}?view=ask`);
    await ready();
    const q22 = await waitFor(() => {
      const el = document.getElementById("q-22");
      if (!el) throw new Error("q-22 없음");
      return el;
    });
    await user.click(q22);
    await waitFor(() => expect(query(router).get("focus")).toBe("q-22"));
    expect(router.state.historyAction).not.toBe("PUSH");
  });

  it("새로고침(같은 주소로 다시 그리기)해도 같은 초점", async () => {
    const first = await renderApp(`${CURRENT}?view=ask&focus=q-21`);
    await ready();
    await waitFor(() => expect(document.activeElement?.id).toBe("q-21"));
    const search = first.router.state.location.search;
    first.unmount();
    await renderApp(`${CURRENT}${search}`);
    await ready();
    await waitFor(() => expect(document.activeElement?.id).toBe("q-21"));
  });

  it("다른 화면으로 갔다가 뒤로 가면 그 화면의 초점(q-21)을 되살린다", async () => {
    const { router } = await renderApp(`${CURRENT}?view=ask&focus=q-21`);
    await ready();
    await waitFor(() => expect(document.activeElement?.id).toBe("q-21"));
    await router.navigate(PAST);
    await waitFor(() => expect(titleEl()?.textContent).toContain("기획 R1"));
    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.pathname).toBe(CURRENT));
    await waitFor(() => expect(document.activeElement?.id).toBe("q-21"));
    await router.navigate(1);
    await waitFor(() => expect(router.state.location.pathname).toBe(PAST));
  });
});

describe("화면이 바뀌면 새 화면 제목으로 초점", () => {
  it("링크로 다른 라운드를 열면 초점이 새 제목([data-screen-title])에 있다(body 로 빠지지 않는다)", async () => {
    const user = userEvent.setup();
    await renderApp(CURRENT);
    await ready();
    const nav = screen.getByRole("navigation", { name: NAMES.nav });
    const link = Array.from(nav.querySelectorAll("a")).find((a) => a.getAttribute("href") === url("research", 1))!;
    await user.click(link);
    await waitFor(() => expect(titleEl()?.textContent).toContain("조사 R1"));
    await waitFor(() => expect(document.activeElement).toBe(titleEl()));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("단계 시작으로 옮겨도 마찬가지", async () => {
    const { router } = await renderApp(CURRENT);
    await ready();
    await router.navigate(url("research", "start"));
    await waitFor(() => expect(titleEl()?.textContent).toContain("조사 단계 시작"));
    await waitFor(() => expect(document.activeElement).toBe(titleEl()));
  });
});

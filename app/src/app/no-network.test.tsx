// SEL-81 U1a — 가짜 클라이언트 밖 네트워크 요청 0 (Vitest). e2e 도 같은 단언을 브라우저에서 한다.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "@/test/render-app";
import { CMD, CURRENT, PAST, SHELL, STAGE_START } from "@/test/contract";

const calls: string[] = [];
function spyNetwork() {
  calls.length = 0;
  const rec = (name: string) =>
    function recorded(this: unknown, ...a: unknown[]) {
      calls.push(`${name}:${String(a[0])}`);
      throw new Error(`네트워크 호출 금지: ${name}`);
    };
  vi.stubGlobal("fetch", rec("fetch"));
  vi.stubGlobal("XMLHttpRequest", class { constructor() { rec("XMLHttpRequest")(); } });
  vi.stubGlobal("WebSocket", class { constructor(u: string) { rec("WebSocket")(u); } });
  vi.stubGlobal("EventSource", class { constructor(u: string) { rec("EventSource")(u); } });
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: rec("sendBeacon") });
}
afterEach(() => vi.unstubAllGlobals());

describe("네트워크 0", () => {
  it.each([[CURRENT], [`${CURRENT}?view=ask&peek=q-21`], [PAST], [STAGE_START], [`${CURRENT}?print=1`]])("%s 를 그리고 만져도 fetch·XHR·WebSocket·EventSource·sendBeacon 0", async (path) => {
    spyNetwork();
    const user = userEvent.setup();
    await renderApp(path);
    await waitFor(() => expect(screen.getByRole("main").querySelector("[data-screen-title]")).not.toBeNull());
    for (const link of screen.getAllByRole("link").slice(0, 6)) await user.hover(link);
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toEqual([]);
  });
});

describe("네트워크 0 — 명령 메뉴 (R1 권장 8)", () => {
  it("메뉴를 열고 글자로 거르고 AI 모드로 바꾸고 글을 써 보고 닫아도 fetch·XHR·WebSocket·EventSource·sendBeacon 0", async () => {
    spyNetwork();
    const user = userEvent.setup();
    await renderApp(CURRENT);
    await waitFor(() => expect(screen.getByRole("main").querySelector("[data-screen-title]")).not.toBeNull());
    await user.click(within(screen.getByRole("banner")).getByRole("button", { name: SHELL.command }));
    const dlg = await screen.findByRole("dialog", { name: CMD.dialog });
    fireEvent.change(within(dlg).getByRole("combobox", { name: CMD.combobox }), { target: { value: "zzzz-없는-동작" } });
    await user.keyboard("{Enter}");
    await user.click(within(dlg).getByRole("button", { name: CMD.aiToggle }));
    const ai = within(dlg).getByRole("combobox", { name: /AI/ });
    fireEvent.change(ai, { target: { value: "이 연구 요약해 줘" } });
    await user.keyboard("{Enter}");
    await user.click(within(dlg).getByRole("button", { name: CMD.aiSend }));
    await user.click(within(dlg).getByRole("button", { name: CMD.aiToggle }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: CMD.dialog })).toBeNull());
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toEqual([]);
  });
});

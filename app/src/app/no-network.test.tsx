// SEL-81 U1a — 가짜 클라이언트 밖 네트워크 요청 0 (Vitest). e2e 도 같은 단언을 브라우저에서 한다.
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "@/test/render-app";
import { CURRENT, PAST, STAGE_START } from "@/test/contract";

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

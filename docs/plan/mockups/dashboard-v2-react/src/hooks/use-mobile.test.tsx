import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsMobile } from "@/hooks/use-mobile";

/** UI7-2 동작 보존 — use-mobile: 처음 폭으로 정하고, 폭이 바뀌면(미디어 쿼리 change) 다시 정한다. 경계는 900px */

function Probe() {
  return <output aria-label="휴대폰">{String(useIsMobile())}</output>;
}

/** change 처리기를 붙잡아 두는 matchMedia */
function installMatchMedia() {
  const listeners = new Set<() => void>();
  const queries: string[] = [];
  window.matchMedia = ((query: string) => {
    queries.push(query);
    return {
      matches: false,
      media: query,
      onchange: null,
      addEventListener: (_t: string, l: () => void) => listeners.add(l),
      removeEventListener: (_t: string, l: () => void) => listeners.delete(l),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
  return { listeners, queries };
}
function setWidth(w: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
}

afterEach(() => vi.restoreAllMocks());

describe("useIsMobile", () => {
  it("900 미만이면 처음부터 휴대폰이다", () => {
    installMatchMedia();
    setWidth(899);
    render(<Probe />);
    expect(screen.getByLabelText("휴대폰")).toHaveTextContent("true");
  });

  it("900 이상이면 휴대폰이 아니다(경계)", () => {
    installMatchMedia();
    setWidth(900);
    render(<Probe />);
    expect(screen.getByLabelText("휴대폰")).toHaveTextContent("false");
  });

  it("폭 기준은 max-width: 899px 쿼리다", () => {
    const { queries } = installMatchMedia();
    setWidth(1200);
    render(<Probe />);
    expect(queries).toContain("(max-width: 899px)");
  });

  it("폭이 바뀌어 change가 오면 다시 정한다", () => {
    const { listeners } = installMatchMedia();
    setWidth(1200);
    render(<Probe />);
    expect(screen.getByLabelText("휴대폰")).toHaveTextContent("false");
    setWidth(600);
    act(() => listeners.forEach((l) => l()));
    expect(screen.getByLabelText("휴대폰")).toHaveTextContent("true");
    setWidth(1000);
    act(() => listeners.forEach((l) => l()));
    expect(screen.getByLabelText("휴대폰")).toHaveTextContent("false");
  });

  it("그만 쓰면(unmount) change 처리기를 뗀다", () => {
    const { listeners } = installMatchMedia();
    setWidth(1200);
    const { unmount } = render(<Probe />);
    expect(listeners.size).toBe(1);
    unmount();
    expect(listeners.size).toBe(0);
  });
});

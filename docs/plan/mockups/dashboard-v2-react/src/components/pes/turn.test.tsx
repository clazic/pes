import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { agoText, elapsedText, TurnIndicator } from "@/components/pes/turn";
import type { TurnView } from "@/api/types";

/** UI7-2 동작 보존 — 차례 표시기 경과 글자: 그릴 때의 지금 시각으로 세고, 15초마다 다시 그린다 */

const T0 = Date.parse("2026-03-10T12:00:00Z");
const minutesAgo = (m: number) => new Date(T0 - m * 60000).toISOString();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

const ui = (turn: TurnView) => (
  <MemoryRouter>
    <TurnIndicator turn={turn} />
  </MemoryRouter>
);

describe("경과 글자 계산", () => {
  it("방금 시작 · n분째 · n시간 m분째", () => {
    expect(elapsedText(minutesAgo(0), T0)).toBe("방금 시작");
    expect(elapsedText(minutesAgo(3), T0)).toBe("3분째");
    expect(elapsedText(minutesAgo(60), T0)).toBe("1시간째");
    expect(elapsedText(minutesAgo(65), T0)).toBe("1시간 5분째");
  });
  it("마지막 소식: 방금 · n분 전", () => {
    expect(agoText(minutesAgo(0), T0)).toBe("방금");
    expect(agoText(minutesAgo(18), T0)).toBe("18분 전");
  });
  it("미래 시각은 0분으로 본다", () => {
    expect(elapsedText(new Date(T0 + 5 * 60000).toISOString(), T0)).toBe("방금 시작");
  });
});

describe("TurnIndicator 경과 · 소식", () => {
  it("AI 작업 중이면 경과와 소식 글자가 보인다", () => {
    render(ui({ side: "ai", since: minutesAgo(30), last_signal: minutesAgo(18), fresh: true }));
    expect(screen.getByText("30분째 · 소식 18분 전")).toBeInTheDocument();
  });

  it("소식이 오래됐으면(fresh=false) “마지막 소식”으로 쓴다", () => {
    render(ui({ side: "ai", since: minutesAgo(30), last_signal: minutesAgo(18), fresh: false }));
    expect(screen.getByText("30분째 · 마지막 소식 18분 전")).toBeInTheDocument();
  });

  it("방금 온 소식은 “방금 소식”이다", () => {
    render(ui({ side: "ai", since: minutesAgo(2), last_signal: minutesAgo(0), fresh: true }));
    expect(screen.getByText("2분째 · 방금 소식")).toBeInTheDocument();
  });

  it("AI 쪽이 아니면 경과 글자가 없다", () => {
    render(ui({ side: "waiting", since: minutesAgo(30), last_signal: minutesAgo(18), fresh: true }));
    expect(screen.queryByText(/분째/)).not.toBeInTheDocument();
  });

  it("15초마다 다시 그려 시간이 흐르면 글자가 바뀐다", () => {
    render(ui({ side: "ai", since: minutesAgo(3), fresh: true }));
    expect(screen.getByText("3분째")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(60 * 1000);
    });
    expect(screen.getByText("4분째")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2 * 60 * 1000);
    });
    expect(screen.getByText("6분째")).toBeInTheDocument();
  });

  it("15초가 차기 전에는 다시 그리지 않아 글자가 그대로다", () => {
    render(ui({ side: "ai", since: minutesAgo(3), fresh: true }));
    act(() => {
      vi.setSystemTime(T0 + 60 * 1000);
      vi.advanceTimersByTime(14 * 1000);
    });
    expect(screen.getByText("3분째")).toBeInTheDocument();
  });

  it("새 자료로 다시 그릴 때는 그때의 시각을 쓴다(옛 시각을 붙잡지 않음)", () => {
    const { rerender } = render(ui({ side: "ai", since: minutesAgo(3), fresh: true }));
    expect(screen.getByText("3분째")).toBeInTheDocument();
    vi.setSystemTime(T0 + 10 * 60 * 1000);
    rerender(ui({ side: "ai", since: minutesAgo(3), last_signal: minutesAgo(3), fresh: true }));
    expect(screen.getByText("13분째 · 소식 13분 전")).toBeInTheDocument();
  });

  it("그만 보이면 15초 타이머를 정리한다", () => {
    const { unmount } = render(ui({ side: "ai", since: minutesAgo(3), fresh: true }));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("밀리초가 있는 시각(최종 리뷰 회귀)", () => {
  const MS = Date.parse("2026-03-10T12:00:00.500Z");
  it("현재 .500 · 시작 11:57:00.500 · 소식 11:42:00.500 이면 3분째 · 소식 18분 전", () => {
    vi.setSystemTime(MS);
    render(ui({ side: "ai", since: "2026-03-10T11:57:00.500Z", last_signal: "2026-03-10T11:42:00.500Z", fresh: true }));
    expect(screen.getByText("3분째 · 소식 18분 전")).toBeInTheDocument();
  });
  it("elapsedText · agoText 도 밀리초를 버리지 않고 센다", () => {
    expect(elapsedText("2026-03-10T11:57:00.500Z", MS)).toBe("3분째");
    expect(agoText("2026-03-10T11:42:00.500Z", MS)).toBe("18분 전");
  });
  it("15초 갱신 때 밀리초 있는 분 경계를 놓치지 않는다", () => {
    vi.setSystemTime(Date.parse("2026-03-10T12:00:00.500Z") - 30 * 1000);
    render(ui({ side: "ai", since: "2026-03-10T11:57:00.500Z", fresh: true }));
    expect(screen.getByText("2분째")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(30 * 1000);
    });
    expect(screen.getByText("3분째")).toBeInTheDocument();
  });
});

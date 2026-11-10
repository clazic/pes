import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pes } from "@/api/mock-client";
import type { AiConnection, UsageView } from "@/api/types";
import { mockSettings } from "@/lib/mock-settings";
import { CONNECTIONS } from "@/mocks/connections";
import { USAGE } from "@/mocks/usage";
import { renderRoutes, setViewport } from "@/test/render-app";
import { UsagePage } from "./UsagePage";

/** F3 (설계 18.6) — 사용량 맨 위 한 줄: PES가 확인한 사실만. 7경우 문구 · “돈이 안 나간다” 단정 0건 · 연결 없으면 줄 없음 */

const SUB = CONNECTIONS.find((c) => c.id === "conn-sub")!;
const METERED = CONNECTIONS.find((c) => c.id === "conn-metered")!;
const FORBIDDEN = "지금 추가로 돈이 나가고 있지 않습니다";

function withExtraUsage(state: "confirmed" | "expiring" | "expired" | "none" | "billing"): AiConnection {
  const c = structuredClone(SUB);
  c.subscription!.extra_usage = { ...c.subscription!.extra_usage, state, valid_until: state === "confirmed" ? "11-12 09:10" : null };
  return c;
}
function withCap(cap: AiConnection["metered"] extends infer M ? (M extends { cap: infer C } ? C : never) : never, state: "set" | "missing"): AiConnection {
  const c = structuredClone(METERED);
  c.metered = { ...c.metered!, cap, state };
  return c;
}

function usageWith(connections: AiConnection[]): UsageView {
  return { ...structuredClone(USAGE), connections };
}

/** 맨 위 줄 — 돈 이야기를 하는 role=status */
function moneyLines() {
  return screen.queryAllByRole("status").filter((el) => /추가 요금|상한|확인하지 않았습니다/.test(el.textContent ?? ""));
}

async function showUsage(connections: AiConnection[]) {
  vi.spyOn(pes, "getUsage").mockResolvedValue(usageWith(connections));
  await renderRoutes([{ path: "usage", Component: UsagePage }], "/usage");
  await screen.findByRole("heading", { level: 1 }, { timeout: 4000 });
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  mockSettings.reset();
  setViewport(1440);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("F3 — 사용량 맨 위 줄 7경우", () => {
  it("1. 확인 유효 — “추가 요금 꺼짐 확인이 유효합니다(<연결> · <기한>까지)”", async () => {
    await showUsage([withExtraUsage("confirmed")]);
    const line = await waitFor(() => {
      const l = moneyLines();
      expect(l).toHaveLength(1);
      return l[0]!;
    });
    expect(line).toHaveTextContent("추가 요금 꺼짐 확인이 유효합니다(연구실 구독 API · 11-12 09:10까지)");
  });

  it.each(["expired", "none"] as const)("2·3. 확인 %s — “<연결>의 추가 요금 꺼짐을 확인하지 않았습니다 — 그 연결로는 실행을 시작하지 않습니다”", async (state) => {
    await showUsage([withExtraUsage(state)]);
    const line = await waitFor(() => {
      const l = moneyLines();
      expect(l).toHaveLength(1);
      return l[0]!;
    });
    expect(line).toHaveTextContent("연구실 구독 API의 추가 요금 꺼짐을 확인하지 않았습니다 — 그 연결로는 실행을 시작하지 않습니다");
    expect(line).not.toHaveTextContent("유효합니다");
  });

  it("4. 과금 표시 감지 — “추가 요금이 붙었을 수 있습니다 — 실행을 멈췄습니다”", async () => {
    await showUsage([withExtraUsage("billing")]);
    const line = await waitFor(() => {
      const l = moneyLines();
      expect(l).toHaveLength(1);
      return l[0]!;
    });
    expect(line).toHaveTextContent("추가 요금이 붙었을 수 있습니다 — 실행을 멈췄습니다");
  });

  it("5. 종량제 상한 있음 — “<연결> 이번 달 약 n원(PES 추정) · 상한 m원에서 멈춤”", async () => {
    await showUsage([withCap(METERED.metered!.cap, "set")]);
    const line = await waitFor(() => {
      const l = moneyLines();
      expect(l).toHaveLength(1);
      return l[0]!;
    });
    expect(line).toHaveTextContent("종량제 API(예시) 이번 달 약 12,400원(PES 추정) · 상한 50,000원에서 멈춤");
  });

  it("6. 종량제 상한 없음 — “<연결> 비용 상한이 없습니다 — 실행을 시작하지 않습니다”", async () => {
    await showUsage([withCap(null, "missing")]);
    const line = await waitFor(() => {
      const l = moneyLines();
      expect(l).toHaveLength(1);
      return l[0]!;
    });
    expect(line).toHaveTextContent("종량제 API(예시) 비용 상한이 없습니다 — 실행을 시작하지 않습니다");
  });

  it("7. 연결 없음 — 줄이 없다", async () => {
    await showUsage([]);
    // 화면 자체는 그려졌다(헛통과 방지): 제목 + 사용량 화면의 다른 요소
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(document.body.textContent?.trim().length).toBeGreaterThan(50);
    // role=status 전체에도 돈 이야기 줄이 없다
    // role=status 는 빈 안내 자리 하나뿐(글 없음)
    expect(screen.queryAllByRole("status").filter((el) => (el.textContent ?? "").trim() !== "")).toHaveLength(0);
    expect(screen.queryAllByRole("status").filter((el) => /원|요금|상한|꺼짐/.test(el.textContent ?? ""))).toHaveLength(0);
    expect(screen.queryByText(/꺼짐 확인이 유효/)).not.toBeInTheDocument();
    expect(screen.queryByText(/비용 상한이 없습니다/)).not.toBeInTheDocument();
  });
});

describe("F3 — 돈이 나가지 않는다는 단정 0건", () => {
  const CASES: [string, () => AiConnection[]][] = [
    ["확인 유효", () => [withExtraUsage("confirmed")]],
    ["확인 만료", () => [withExtraUsage("expired")]],
    ["확인 없음", () => [withExtraUsage("none")]],
    ["과금 표시", () => [withExtraUsage("billing")]],
    ["종량제 상한 있음", () => [withCap(METERED.metered!.cap, "set")]],
    ["종량제 상한 없음", () => [withCap(null, "missing")]],
    ["연결 없음", () => []],
    ["시안 기본 연결 2개", () => CONNECTIONS],
  ];
  it.each(CASES)("%s — 화면 어디에도 “지금 추가로 돈이 나가고 있지 않습니다”가 없다", async (_name, make) => {
    await showUsage(make());
    // 줄이 그려질 시간을 준다
    await new Promise((r) => setTimeout(r, 50));
    expect(document.body.textContent).not.toContain(FORBIDDEN);
    expect(screen.queryByText(FORBIDDEN)).not.toBeInTheDocument();
  });
});

// SEL-84 U1d — AI 연결 칩 (Vitest, jsdom). 구현 전이라 실패가 정상. 계약: src/test/u1d.ts 머리말.
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "@/test/render-app";
import { CURRENT, WIDTHS } from "@/test/contract";
import { ready } from "@/test/ui";
import { RECALL, NO_RESTART, UNKNOWN, chipButton, chipState, fakeBoot, goWordsIn, httpBoot, statePanel, unstubServer, withAi, ws } from "@/test/u1d";

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  unstubServer();
  cleanup();
});

const STATES: Array<[string, Record<string, unknown> | undefined, string, RegExp]> = [
  ["allowed", { policy: "allowed" }, "on", /켜짐/],
  ["denied", { policy: "denied" }, "blocked", /차단 중/],
  ["missing(정책 누락)", { policy: "missing" }, "blocked", /차단 중/],
  ["corrupt(정책 손상)", { policy: "corrupt" }, "blocked", /차단 중/],
  ["pending(확정 전)", { policy: "pending" }, "changing", /변경 중/],
  ["칸 없음(서버가 아직 안 줌)", undefined, "unknown", UNKNOWN],
  ["모르는 값", { policy: "something-new" }, "unknown", UNKNOWN],
];

describe("칩 상태 구분 (가짜 클라이언트)", () => {
  it.each(STATES.map(([name, ai, state, word]) => ({ name, ai, state, word })))("$name → 상태 $state, 이름에 상태 낱말", async ({ ai, state, word }) => {
    const { open } = fakeBoot(withAi(ai));
    await open();
    const chip = chipButton();
    expect(chip.getAttribute("data-state")).toBe(state);
    expect(chip.getAttribute("aria-label") ?? chip.textContent).toMatch(/^AI 연결/);
    expect(screen.getByRole("button", { name: /^AI 연결/ })).toBe(chip);
    expect(chip).toHaveAccessibleName(word);
    expect(screen.getAllByRole("button", { name: /^AI 연결/ }), "칩은 문서에 하나").toHaveLength(1);
  });

  it("모르면 켜짐이라 하지 않는다(unknown 이름에 '켜짐' 없음)", async () => {
    const { open } = fakeBoot(withAi(undefined));
    await open();
    expect(chipButton()).not.toHaveAccessibleName(/켜짐/);
  });

  it("기본 가짜 클라이언트(합성 fixture)는 켜짐으로 그린다", async () => {
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    expect(chipState()).toBe("on");
  });

  it("화면 문구에 낱말 'Go' 가 없다 — 모든 상태에서 'API' · 'AI 연결'", async () => {
    for (const [, ai] of STATES) {
      const { open } = fakeBoot(withAi(ai, ai?.policy === "denied" ? { ai_connection: { policy: "denied", dispatches: [{ id: "d1", run_id: "r1", state: "unknown" }] } } : {}));
      await open();
      await act(async () => chipButton().click());
      expect(goWordsIn(), JSON.stringify(ai)).toEqual([]);
      cleanup();
    }
  });
});

describe("칩 상태 구분 (HTTP 클라이언트 — 같은 표시)", () => {
  it.each(STATES.map(([name, ai, state, word]) => ({ name, ai, state, word })))("$name → 상태 $state", async ({ ai, state, word }) => {
    vi.useRealTimers();
    await httpBoot(withAi(ai));
    expect(chipButton().getAttribute("data-state")).toBe(state);
    expect(chipButton()).toHaveAccessibleName(word);
  });
});

describe("키보드 · 접근성", () => {
  it("Tab 으로 닿고 Enter 로 열리며 aria-expanded · aria-controls 가 맞고, Esc 로 닫으면 초점이 칩으로", async () => {
    const { open } = fakeBoot(withAi({ policy: "denied" }));
    const { user } = await open();
    const chip = chipButton();
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(statePanel()).toBeNull();
    // 키보드만으로 닿는다: 초점 가능(tabindex 가 -1 이 아님)이고 Tab 순서 안에 있다
    expect(chip.tabIndex).toBeGreaterThanOrEqual(0);
    chip.focus();
    await user.keyboard("{Enter}");
    expect(chip).toHaveAttribute("aria-expanded", "true");
    const panel = statePanel()!;
    expect(panel).not.toBeNull();
    expect(chip.getAttribute("aria-controls")).toBe(panel.id);
    await user.keyboard("{Escape}");
    expect(statePanel()).toBeNull();
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(chip);
  });

  it("Space 로도 열고 닫힌다 · 열어도 초점 덫이 없다(Tab 으로 빠져나온다)", async () => {
    const { open } = fakeBoot(withAi({ policy: "pending" }));
    const { user } = await open();
    chipButton().focus();
    await user.keyboard(" ");
    expect(chipButton()).toHaveAttribute("aria-expanded", "true");
    await user.tab();
    expect(document.activeElement).not.toBe(document.body);
    await user.keyboard("{Escape}");
  });

  it("칩을 여닫는 일은 읽기 메서드 밖의 클라이언트 호출을 하지 않는다(전송 없음)", async () => {
    const f = fakeBoot(withAi({ policy: "denied" }));
    const { user } = await f.open();
    f.s.reset();
    await user.click(chipButton());
    await user.click(chipButton());
    expect(f.s.unexpected()).toEqual([]);
  });

  it("휴대폰(390px · 굵은 포인터)에서도 칩이 있고 열린다", async () => {
    const { open } = fakeBoot(withAi({ policy: "denied" }));
    const { user } = await open(CURRENT, { width: WIDTHS.phone, coarse: true });
    await user.click(chipButton());
    expect(statePanel()).not.toBeNull();
  });
});

describe("안내 문구", () => {
  it("차단 중: 이미 나간 자료는 회수 보장 없음 · 재허용 뒤 자동 재시작 없음", async () => {
    const { open } = fakeBoot(withAi({ policy: "denied" }));
    const { user } = await open();
    await user.click(chipButton());
    const panel = statePanel()!;
    expect(panel.textContent).toMatch(RECALL);
    expect(panel.textContent).toMatch(NO_RESTART);
  });

  it("정책 누락·손상도 차단 중과 같은 안내(허용으로 읽지 않는다)", async () => {
    for (const policy of ["missing", "corrupt"]) {
      const { open } = fakeBoot(withAi({ policy }));
      const { user } = await open();
      await user.click(chipButton());
      expect(statePanel()!.textContent, policy).toMatch(RECALL);
      cleanup();
    }
  });

  it("진행 중 전송: 취소 시도와 unknown 이 서로 다르게 보이고, 취소됨은 회수했다고 하지 않는다", async () => {
    const dispatches = [
      { id: "d-cancel", run_id: "run-1", state: "cancel_requested" },
      { id: "d-unk", run_id: "run-1", state: "unknown" },
      { id: "d-done", run_id: "run-2", state: "cancelled" },
    ];
    const { open } = fakeBoot(withAi({ policy: "denied", dispatches }));
    const { user } = await open();
    await user.click(chipButton());
    const panel = statePanel()!;
    const item = (id: string) => panel.querySelector<HTMLElement>(`[data-dispatch="${id}"]`)!;
    expect(item("d-cancel").getAttribute("data-state")).toBe("cancel_requested");
    expect(item("d-cancel").textContent).toMatch(/취소 시도/);
    expect(item("d-cancel").textContent).not.toMatch(UNKNOWN);
    expect(item("d-unk").getAttribute("data-state")).toBe("unknown");
    expect(item("d-unk").textContent).toMatch(UNKNOWN);
    expect(item("d-unk").textContent).not.toMatch(/취소 시도/);
    expect(item("d-done").textContent).not.toMatch(/회수/);
    expect(panel.textContent).toMatch(RECALL);
  });

  it("방식 B: 칩은 남고 'AI 연결로 보내지 않음' 설명이 있다", async () => {
    const { open } = fakeBoot(withAi({ policy: "allowed" }, { mode: "B" }));
    const { user } = await open();
    await user.click(chipButton());
    expect(statePanel()!.textContent).toMatch(/보내지 않/);
  });
});

describe("갱신", () => {
  it("변경 중 → 켜짐: 작업 공간 변경분이 오면 칩 이름이 바뀌고 열린 칸과 초점이 유지된다", async () => {
    const f = fakeBoot(withAi({ policy: "pending" }));
    const { user } = await f.open();
    expect(chipState()).toBe("changing");
    chipButton().focus();
    await user.keyboard("{Enter}");
    f.set(withAi({ policy: "allowed" }));
    f.s.queueChanges({ cursor: "c-ws", txs: [{ tx_id: "tx-policy", touched: ["workspace"] }] });
    await advance(8_000);
    await waitFor(() => expect(chipButton().getAttribute("data-state")).toBe("on"));
    expect(chipButton()).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(chipButton());
    // 켜짐으로 돌아와도 "자동 재시작" 같은 말을 하지 않는다: 안내는 재허용 뒤 사람이 시작해야 함을 유지
    expect(statePanel()!.textContent).not.toMatch(/자동으로 다시 시작합니다/);
  });

  it("켜짐 → 차단 중: 이름이 바뀐다(role=status 가 아닌 단추라도 이름이 읽힌다)", async () => {
    const f = fakeBoot(withAi({ policy: "allowed" }));
    await f.open();
    f.set(withAi({ policy: "denied" }));
    f.s.queueChanges({ cursor: "c-ws2", txs: [{ tx_id: "tx-off", touched: ["workspace"] }] });
    await advance(8_000);
    await waitFor(() => expect(chipButton()).toHaveAccessibleName(/차단 중/));
  });
});

describe("작업 공간 밖 모양이 깨져도", () => {
  it("dispatches 가 비어 있거나 모르는 상태여도 화면이 죽지 않는다", async () => {
    const { open } = fakeBoot(withAi({ policy: "denied", dispatches: [{ id: "d-x", run_id: "r", state: "brand-new" }] }));
    const { user } = await open();
    await user.click(chipButton());
    const item = statePanel()!.querySelector<HTMLElement>('[data-dispatch="d-x"]')!;
    expect(item.textContent).toMatch(UNKNOWN);
  });

  it("ws() 기본(칸 없음) 작업 공간도 질문 영역을 그린다", async () => {
    const { open } = fakeBoot(ws());
    await open();
    expect(screen.getByRole("complementary", { name: "질문" })).toBeInTheDocument();
  });
});

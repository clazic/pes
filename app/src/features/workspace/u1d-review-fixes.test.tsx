// SEL-84 U1d 1차 리뷰(R1) 수정분 시험 — 칩 44px 규칙 · 인쇄 숨김 · Esc 초점 · 과거 승인 stale 판정 · 모르면 회수 안내 · 상태 변경 읽기 알림 · production 에 합성 자료 없음.
// 기존 u1d-* 시험의 단언은 건드리지 않고 여기에 더한다. 계약: src/test/u1d.ts 머리말.
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectClient } from "@/api/select-client";
import { RECALL, NO_RESTART, UNKNOWN, chipButton, fakeBoot, recordPanel, runPanel, stageLink, statePanel, unstubServer, withAi, ws } from "@/test/u1d";

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  unstubServer();
  cleanup();
});

describe("칩 터치 높이(필수 1)", () => {
  it("굵은 포인터 규칙(coarse:min-h-[44px] · min-w-[44px])이 칩 단추에 걸려 있다 — 실제 높이는 e2e 가 잰다", async () => {
    const { open } = fakeBoot(withAi({ policy: "allowed" }));
    await open();
    expect(chipButton().className).toMatch(/coarse:min-h-\[44px\]/);
    expect(chipButton().className).toMatch(/coarse:min-w-\[44px\]/);
  });
});

describe("인쇄에서 숨김(권장 1)", () => {
  it("칩 · 열린 AI 연결 상태 · 실행 · 기록 패널은 data-print=hide", async () => {
    const { open } = fakeBoot(withAi({ policy: "denied" }));
    const { user } = await open();
    await user.click(chipButton());
    expect(chipButton()).toHaveAttribute("data-print", "hide");
    expect(statePanel()).toHaveAttribute("data-print", "hide");
    expect(runPanel()).toHaveAttribute("data-print", "hide");
    expect(recordPanel()).toHaveAttribute("data-print", "hide");
  });
});

describe("Esc 와 초점(권장 2)", () => {
  it("답 칸에서 글을 쓰다 Esc 를 눌러도 입력 초점이 칩으로 빼앗기지 않는다(칸은 닫힌다)", async () => {
    const { open } = fakeBoot(withAi({ policy: "denied" }));
    const { user } = await open();
    await user.click(chipButton());
    expect(statePanel()).not.toBeNull();
    const answer = within(screen.getByRole("complementary", { name: "질문" })).getAllByRole("textbox")[0]!;
    answer.focus();
    expect(document.activeElement).toBe(answer);
    await user.keyboard("{Escape}");
    expect(statePanel()).toBeNull();
    expect(document.activeElement).toBe(answer);
    expect(document.activeElement).not.toBe(chipButton());
  });

  it("초점이 열린 칸 안(링크 · 글)에 있을 때 Esc 는 초점을 칩으로 돌려준다", async () => {
    const { open } = fakeBoot(withAi({ policy: "denied", dispatches: [{ id: "d1", run_id: "r1", state: "sent" }] }));
    const { user } = await open();
    await user.click(chipButton());
    const panel = statePanel()!;
    panel.tabIndex = -1;
    panel.focus();
    expect(panel.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(statePanel()).toBeNull();
    expect(document.activeElement).toBe(chipButton());
  });
});

describe("과거 승인은 stale 일 때만(권장 3)", () => {
  const approvedWithPast = (origin: "verified" | "legacy_unverified") => {
    const base = ws();
    const stages = base.stages.map((s) => (s.key === "plan" ? { ...s, past_approval: { at: "2026-11-01T09:00:00+09:00", origin } } : s));
    return { ...base, stages } as typeof base;
  };

  it("지금 승인된 단계에 서버가 past_approval(verified)을 같이 실어도 '승인됨'만 — '과거 승인' 없음", async () => {
    const { open } = fakeBoot(approvedWithPast("verified"));
    await open();
    const link = stageLink(/기획/)!;
    expect(link.textContent).toMatch(/승인됨/);
    expect(link.textContent).not.toMatch(/과거 승인/);
  });

  it("legacy_unverified 의 '검증 안 됨'은 stale 이 아니어도 유지된다", async () => {
    const { open } = fakeBoot(approvedWithPast("legacy_unverified"));
    await open();
    const link = stageLink(/기획/)!;
    expect(link.textContent).toMatch(/검증 안 됨/);
    expect(link.textContent).not.toMatch(/과거 승인/);
  });
});

describe("모르는 상태에서도 회수 안내(권장 4)", () => {
  it.each([
    ["칸 없음(unknown)", undefined],
    ["모르는 값(unknown)", { policy: "something-new" }],
    ["pending(변경 중)", { policy: "pending" }],
  ])("%s → 회수 보장 없음 · 자동 재시작 없음 안내가 보인다", async (_n, ai) => {
    const { open } = fakeBoot(withAi(ai));
    const { user } = await open();
    await user.click(chipButton());
    const text = statePanel()!.textContent ?? "";
    expect(text).toMatch(RECALL);
    expect(text).toMatch(NO_RESTART);
  });

  it("unknown 은 나간 자료가 있는지도 알 수 없다고 말한다", async () => {
    const { open } = fakeBoot(withAi(undefined));
    const { user } = await open();
    await user.click(chipButton());
    expect(statePanel()!.textContent).toMatch(/나간 자료가 있는지도 알 수 없/);
    expect(statePanel()!.textContent).toMatch(UNKNOWN);
  });

  it("켜짐이고 보낸 전송이 없으면 안내를 띄우지 않는다(상태를 지어내지 않음)", async () => {
    const { open } = fakeBoot(withAi({ policy: "allowed" }));
    const { user } = await open();
    await user.click(chipButton());
    expect(statePanel()!.textContent).not.toMatch(RECALL);
  });
});

describe("상태 변경 읽기 알림(권장 5)", () => {
  it("처음에는 비어 있고, 켜짐 → 차단 중이 되면 'AI 연결 차단 중' 이 알려진다", async () => {
    const f = fakeBoot(withAi({ policy: "allowed" }));
    await f.open();
    const region = chipButton().parentElement!.querySelector<HTMLElement>('[role="status"]')!;
    expect(region).not.toBeNull();
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
    f.set(withAi({ policy: "denied" }));
    f.s.queueChanges({ cursor: "c-live", txs: [{ tx_id: "tx-live", touched: ["workspace"] }] });
    await advance(8_000);
    await waitFor(() => expect(chipButton().getAttribute("data-state")).toBe("blocked"));
    await waitFor(() => expect(region.textContent).toMatch(/AI 연결 차단 중/));
  });

  it("상태가 같으면 알림을 만들지 않는다", async () => {
    const f = fakeBoot(withAi({ policy: "denied" }));
    await f.open();
    const region = chipButton().parentElement!.querySelector<HTMLElement>('[role="status"]')!;
    expect(region.textContent).toBe("");
  });
});

describe("production 에는 합성 자료가 없다(권장 6)", () => {
  it("MODE=production 이면 설정이 없을 때 가짜 클라이언트 대신 null", () => {
    vi.stubEnv("MODE", "production");
    expect(selectClient({})).toBeNull();
    expect(selectClient({ __PES_APP__: { api: "nope" } })).toBeNull();
  });

  it("시험 모드는 설정이 없으면 가짜 클라이언트를 돌려준다(위와 짝)", () => {
    vi.stubEnv("MODE", "test");
    expect(selectClient({})).not.toBeNull();
  });
});

// 오늘 서버 모양 보호 — 새 칸이 없으면 값을 지어내지 않는다
describe("칸 없음", () => {
  it("칩은 unknown 이고 실행 · 기록 패널은 정보 없음", async () => {
    const { open } = fakeBoot(ws());
    await open();
    expect(chipButton().getAttribute("data-state")).toBe("unknown");
    expect(runPanel().textContent).toMatch(/정보 없음/);
    expect(recordPanel().textContent).toMatch(/정보 없음/);
  });
});

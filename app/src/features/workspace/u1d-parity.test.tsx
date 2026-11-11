// SEL-84 U1d — 가짜 클라이언트와 HTTP 클라이언트가 같은 값에서 같은 표시를 한다 (Vitest, jsdom). 구현 전이라 실패가 정상.
// 오늘 서버 작업 공간 읽기에는 ai_connection · past_approval · runs · run_permissions 가 없다(보고서 참고) → 그 모양도 시험한다.
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { PERMISSIONS, RUNS, UNKNOWN, chipButton, fakeBoot, httpBoot, migratedSynthetic, recordPanel, runPanel, stageLink, staleAfterApproval, statePanel, unstubServer, withAi, ws } from "@/test/u1d";
import type { WorkspaceView } from "@/api/types";

afterEach(() => {
  unstubServer();
  cleanup();
});

const SCENARIOS: Array<[string, () => WorkspaceView]> = [
  ["켜짐", () => withAi({ policy: "allowed" })],
  ["차단 중 + 전송 unknown", () => withAi({ policy: "denied", dispatches: [{ id: "d1", run_id: "r1", state: "unknown" }, { id: "d2", run_id: "r1", state: "cancel_requested" }] })],
  ["변경 중", () => withAi({ policy: "pending" })],
  ["정책 손상 + 실행 상태 + 권한", () => withAi({ policy: "corrupt" }, { runs: RUNS, run_permissions: PERMISSIONS })],
  ["과거 승인 + stale", () => staleAfterApproval()],
  ["이전된 합성 프로젝트", () => migratedSynthetic()],
];

/** 화면에서 읽히는 것만 모은다 — 두 클라이언트가 같아야 하는 값 */
async function snapshot(user: { click: (e: Element) => Promise<void> }) {
  await user.click(chipButton());
  const out = {
    chip: [chipButton().getAttribute("data-state"), chipButton().getAttribute("aria-label") ?? chipButton().textContent],
    panel: statePanel()?.textContent ?? null,
    runs: runPanel().textContent,
    records: recordPanel().textContent,
    stages: ["기획", "조사", "분석"].map((n) => stageLink(new RegExp(n))?.textContent ?? null),
  };
  return out;
}

describe("가짜 클라이언트 = HTTP 클라이언트", () => {
  it.each(SCENARIOS)("%s", async (_name, make) => {
    const fake = fakeBoot(make());
    const a = await fake.open();
    const viaFake = await snapshot(a.user);
    cleanup();
    const b = await httpBoot(make());
    const viaHttp = await snapshot(b.user);
    expect(viaHttp).toEqual(viaFake);
    // 둘 다 비어 있지 않다(같은 빈 화면이라 통과하는 것을 막는다)
    expect(viaFake.chip[0]).toMatch(/^(on|blocked|changing|unknown)$/);
    expect(viaFake.runs).toBeTruthy();
  });
});

describe("오늘 서버 모양(새 칸 없음 · actions · records 있음)", () => {
  const today = () => ({
    ...ws(),
    actions: [{ action: "runs.create", enabled: true, disabled_reason: null }],
    records: { assumptions: { count: 0 }, decisions: { count: 0 }, comments: { count: 0 }, empty: true },
  });

  it("칩은 unknown(켜짐이라 하지 않음), 기록 없음은 서버 records.empty 로 표시, 화면은 안 깨진다", async () => {
    const { user } = await httpBoot(today());
    expect(chipButton().getAttribute("data-state")).toBe("unknown");
    expect(chipButton()).toHaveAccessibleName(UNKNOWN);
    expect(chipButton()).not.toHaveAccessibleName(/켜짐/);
    await user.click(chipButton());
    expect(statePanel()!.textContent).toMatch(UNKNOWN);
    expect(recordPanel().querySelector('[data-record="decisions"]')!.textContent).toMatch(/기록 없음/);
    expect(runPanel().querySelector("[data-run]")).toBeNull();
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("같은 값이면 가짜 클라이언트도 같은 칩", async () => {
    const { open } = fakeBoot(today() as unknown as WorkspaceView);
    await open();
    expect(chipButton().getAttribute("data-state")).toBe("unknown");
  });
});

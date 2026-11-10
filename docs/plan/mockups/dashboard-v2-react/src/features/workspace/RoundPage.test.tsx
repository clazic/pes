import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChangeFeed } from "@/api/queries";
import { mockSettings } from "@/lib/mock-settings";
import { answersSent, aiSheet, researchUi } from "@/lib/research-ui";
import { renderRoutes, setViewport, workspaceRoutes } from "@/test/render-app";

/** UI7-2 동작 보존 — 라운드 화면: “보냄” 카드 · 본 단계가 사라지면 “마쳤습니다” (렌더 중 ref를 상태로 바꿔도 그대로) */

/** 앱 뼈대가 하는 일 하나 — 서버가 알린 바뀐 읽기 키를 다시 받는다(없으면 명령 뒤에도 화면 자료가 그대로) */
function Feed() {
  useChangeFeed("dolbom-insight");
  return null;
}

const ROUND = "/p/dolbom-insight/e/1/s/research/r/2";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  mockSettings.reset();
  researchUi.set({ focus: false, aiPanel: true, aiOnRound: false });
  aiSheet.set({ open: false, target: null });
  answersSent.set(null);
  setViewport(1440);
});

describe("“보냄” 카드", () => {
  it("방금 보낸 답이 있으면 질문 단계 자리에 보냄 확인이 나온다(개수 · 접수 번호 · 다음 할 일)", async () => {
    answersSent.set({ slug: "dolbom-insight", receipt_no: "R-시험-1", count: 3 });
    await renderRoutes(await workspaceRoutes(), `${ROUND}?t=answer`);
    const heading = await screen.findByRole("heading", { name: "보냄 · AI가 이어서 합니다" }, { timeout: 4000 });
    const card = heading.closest("[aria-labelledby='sent-t']") as HTMLElement;
    expect(within(card).getByText(/답 3개를 보냈습니다\./)).toBeInTheDocument();
    expect(within(card).getByText("접수 번호 R-시험-1")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: /다음 할 일 ·/ })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /남은 질문 \d+개 보기/ })).toBeInTheDocument();
  });

  it("보냄 제목에 초점이 간다", async () => {
    answersSent.set({ slug: "dolbom-insight", receipt_no: "R-시험-1", count: 1 });
    await renderRoutes(await workspaceRoutes(), `${ROUND}?t=answer`);
    const heading = await screen.findByRole("heading", { name: "보냄 · AI가 이어서 합니다" }, { timeout: 4000 });
    await waitFor(() => expect(heading).toHaveFocus(), { timeout: 2000 });
  });

  it("다른 프로젝트에서 보낸 답은 이 프로젝트에 보이지 않는다", async () => {
    answersSent.set({ slug: "youth-housing", receipt_no: "R-다른", count: 1 });
    await renderRoutes(await workspaceRoutes(), `${ROUND}?t=answer`);
    await screen.findByRole("region", { name: /AI 동료/ }, { timeout: 4000 });
    expect(screen.queryByRole("heading", { name: "보냄 · AI가 이어서 합니다" })).not.toBeInTheDocument();
  });

  it("[남은 질문 n개 보기]를 누르면 보냄 확인이 사라진다", async () => {
    answersSent.set({ slug: "dolbom-insight", receipt_no: "R-시험-1", count: 1 });
    await renderRoutes(await workspaceRoutes(), `${ROUND}?t=answer`);
    await screen.findByRole("heading", { name: "보냄 · AI가 이어서 합니다" }, { timeout: 4000 });
    fireEvent.click(screen.getByRole("button", { name: /남은 질문 \d+개 보기/ }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "보냄 · AI가 이어서 합니다" })).not.toBeInTheDocument());
    expect(answersSent.get()).toBeNull();
  });

  it("질문 단계를 떠나면 보냄 기록이 지워진다(이 탭에서만)", async () => {
    answersSent.set({ slug: "dolbom-insight", receipt_no: "R-시험-1", count: 1 });
    const view = await renderRoutes(await workspaceRoutes(), `${ROUND}?t=answer`);
    await screen.findByRole("heading", { name: "보냄 · AI가 이어서 합니다" }, { timeout: 4000 });
    expect(answersSent.get()).not.toBeNull();
    await act(async () => {
      await view.router.navigate(`${ROUND}?t=review`);
    });
    await waitFor(() => expect(answersSent.get()).toBeNull());
    expect(screen.queryByRole("heading", { name: "보냄 · AI가 이어서 합니다" })).not.toBeInTheDocument();
  });
});

describe("“마쳤습니다” — 보던 단계가 사라졌을 때", () => {
  it("처음부터 없는 단계 주소는 마쳤다고 하지 않는다(본 적 없음)", async () => {
    await renderRoutes(await workspaceRoutes(), `${ROUND}?t=p-없는문제`);
    await screen.findByRole("region", { name: /AI 동료/ }, { timeout: 4000 });
    expect(screen.queryByText(/마쳤습니다/)).not.toBeInTheDocument();
  });

  it("동기화 충돌 단계를 풀어 단계가 사라지면 그 단계 이름과 함께 “마쳤습니다”가 나온다", async () => {
    await renderRoutes(await workspaceRoutes(), `${ROUND}?t=sync`, <Feed />);
    // 본 단계: 해결 흐름(선택지 라디오)
    const radios = await screen.findAllByRole("radio", {}, { timeout: 4000 });
    expect(screen.queryByText(/마쳤습니다/)).not.toBeInTheDocument();
    fireEvent.click(radios.find((r) => r.closest("label")?.textContent?.includes("내 컴퓨터 것을 새 버전")) ?? radios[1]!);
    const run = await screen.findByRole("button", { name: "내 컴퓨터 것을 새 버전(v4)으로 올리기" });
    await waitFor(() => expect(run).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(run);
    const done = await screen.findByText(/— 마쳤습니다/, {}, { timeout: 6000 });
    expect(done).toHaveTextContent("동기화 충돌 고르기 — 마쳤습니다");
    const card = done.closest("[aria-labelledby='done-t']") as HTMLElement;
    expect(within(card).getByText(/저절로 넘어가지 않습니다/)).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "연구 개요로" })).toHaveAttribute("href", "/p/dolbom-insight");
    const next = within(card).getByRole("link", { name: /다음 할 일 ·/ });
    expect(next).toHaveAttribute("href", expect.stringContaining("?t="));
    // 다음 할 일 링크로 초점
    await waitFor(() => expect(next).toHaveFocus(), { timeout: 2000 });
  }, 20000);
});

describe("“마쳤습니다” — 본 적 없는 단계 이름이 Object 상속 속성 이름일 때(최종 리뷰 회귀)", () => {
  it.each(["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"])("?t=%s 로 처음 열어도 마쳤다고 하지 않고 React 경고도 없다", async (name) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await renderRoutes(await workspaceRoutes(), `${ROUND}?t=${name}`);
      await screen.findByRole("region", { name: /AI 동료/ }, { timeout: 4000 });
      expect(screen.queryByText(/마쳤습니다/)).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /마쳤습니다/ })).not.toBeInTheDocument();
      const msgs = errors.mock.calls.map((c) => c.map(String).join(" "));
      expect(msgs.filter((m) => /not valid as a React child|Warning:/.test(m))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});

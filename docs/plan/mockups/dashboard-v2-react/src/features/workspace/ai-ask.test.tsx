import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { aiSheet, researchUi } from "@/lib/research-ui";
import { mockSettings } from "@/lib/mock-settings";
import { renderRoutes, setViewport, workspaceRoutes } from "@/test/render-app";

/** F1 (설계 18.2) — 결과 글의 “AI에게 부탁”이 접힌 AI 동료 칸을 펼치고 부탁할 곳 · 초점까지 전달한다 */

const REVIEW = "/p/dolbom-insight/e/1/s/research/r/2?t=review";
const SESSION_AI_ROUND = "pes-research-ai-round";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  mockSettings.reset();
  researchUi.set({ focus: false, aiPanel: true, aiOnRound: false });
  aiSheet.set({ open: false, target: null });
});

/** 선택한 문장 도구(문단 2가 강조된 합성 문장)의 “AI에게 부탁”을 누른다 */
async function clickAsk() {
  const toolbar = await screen.findByRole("toolbar", { name: "선택한 문장 도구" }, { timeout: 4000 });
  fireEvent.click(within(toolbar).getByRole("button", { name: "AI에게 부탁" }));
}

describe("F1 — 1280 이상, 접힌 AI 동료 칸", () => {
  it("처음에는 칸이 접혀 한 줄 요약만 보인다(전제)", async () => {
    setViewport(1440);
    await renderRoutes(await workspaceRoutes(), REVIEW);
    const summary = await screen.findByRole("region", { name: "AI 동료 요약" }, { timeout: 4000 });
    expect(within(summary).getByRole("button", { name: "AI 동료 펼치기" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("complementary", { name: "AI 동료 칸" })).not.toBeInTheDocument();
  });

  it("결과 글 “AI에게 부탁”(문단 2) → 칸이 펼쳐지고 · 부탁할 곳이 그 문단이고 · 부탁할 말 칸에 초점 · 펼침이 sessionStorage에 남는다", async () => {
    setViewport(1440);
    await renderRoutes(await workspaceRoutes(), REVIEW);
    await screen.findByRole("region", { name: "AI 동료 요약" }, { timeout: 4000 });

    await clickAsk();

    const panel = await screen.findByRole("complementary", { name: "AI 동료 칸" });
    expect(screen.queryByRole("region", { name: "AI 동료 요약" })).not.toBeInTheDocument();
    // 칸 머리의 [접기]
    expect(within(panel).getByRole("button", { name: "접기" })).toHaveAttribute("aria-expanded", "true");
    // 부탁할 곳 = 문단 2
    expect(within(panel).getByRole("combobox", { name: "부탁할 곳" })).toHaveTextContent("문단 2");
    // 부탁할 말 칸에 초점(칸이 새로 그려진 뒤 잠깐 있다가 준다)
    const textarea = within(panel).getByRole("textbox", { name: /부탁할 말/ });
    await waitFor(() => expect(textarea).toHaveFocus(), { timeout: 2000 });
    // 이 탭에서 펼침으로 기억
    expect(sessionStorage.getItem(SESSION_AI_ROUND)).toBe("1");
    expect(researchUi.get().aiOnRound).toBe(true);
  });

  it("펼친 칸의 [접기]를 누르면 다시 접히고 요약 줄이 돌아온다(펼침 기억도 접힘으로)", async () => {
    setViewport(1440);
    await renderRoutes(await workspaceRoutes(), REVIEW);
    await screen.findByRole("region", { name: "AI 동료 요약" }, { timeout: 4000 });
    await clickAsk();
    const panel = await screen.findByRole("complementary", { name: "AI 동료 칸" });
    fireEvent.click(within(panel).getByRole("button", { name: "접기" }));
    expect(await screen.findByRole("region", { name: "AI 동료 요약" })).toBeInTheDocument();
    expect(sessionStorage.getItem(SESSION_AI_ROUND)).toBe("0");
  });

  it("이미 펼쳐져 있어도(회귀) 부탁하면 부탁할 곳이 그 문단이 된다", async () => {
    setViewport(1440);
    researchUi.set({ aiOnRound: true });
    await renderRoutes(await workspaceRoutes(), REVIEW);
    await screen.findByRole("complementary", { name: "AI 동료 칸" }, { timeout: 4000 });
    await clickAsk();
    const panel = screen.getByRole("complementary", { name: "AI 동료 칸" });
    await waitFor(() => expect(within(panel).getByRole("combobox", { name: "부탁할 곳" })).toHaveTextContent("문단 2"));
    await waitFor(() => expect(within(panel).getByRole("textbox", { name: /부탁할 말/ })).toHaveFocus(), { timeout: 2000 });
  });
});

describe("F1 — 1280 미만(지금 동작 회귀)", () => {
  it("요약 줄 없이 머리줄 단추로 여는 판 — “AI에게 부탁”이 판을 열고 부탁할 곳이 그 문단", async () => {
    setViewport(1000);
    await renderRoutes(await workspaceRoutes(), REVIEW);
    await clickAsk();

    const dialog = await screen.findByRole("dialog", { name: "AI 동료" });
    expect(screen.queryByRole("region", { name: "AI 동료 요약" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "AI 동료 칸" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "부탁할 곳" })).toHaveTextContent("문단 2");
    // 좁은 화면은 칸 펼침 기억을 건드리지 않는다
    expect(researchUi.get().aiOnRound).toBe(false);
  });

  it("판이 열릴 때 부탁할 말 칸에 초점이 간다", async () => {
    setViewport(1000);
    await renderRoutes(await workspaceRoutes(), REVIEW);
    await clickAsk();
    const dialog = await screen.findByRole("dialog", { name: "AI 동료" });
    await waitFor(() => expect(within(dialog).getByRole("textbox", { name: /부탁할 말/ })).toHaveFocus(), { timeout: 2000 });
  });
});

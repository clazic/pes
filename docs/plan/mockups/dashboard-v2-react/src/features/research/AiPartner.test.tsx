import { act, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { pes } from "@/api/mock-client";
import type { WorkspaceView } from "@/api/types";
import { mockSettings } from "@/lib/mock-settings";
import { aiSheet, researchUi } from "@/lib/research-ui";
import { setViewport } from "@/test/render-app";
import { renderBarePage } from "@/test/render-page";
import { AiPartner } from "@/features/research/AiPartner";

/** UI7-2 동작 보존 — AI 동료의 “부탁할 곳”: 결과 글에서 고른 문단을 기본으로 받는다 */

let ws: WorkspaceView;
beforeEach(async () => {
  sessionStorage.clear();
  mockSettings.reset();
  researchUi.set({ focus: false, aiPanel: true, aiOnRound: false });
  aiSheet.set({ open: false, target: null });
  setViewport(1440);
  ws = await pes.getWorkspace("dolbom-insight");
});

const Partner = () => <AiPartner ws={ws} />;
const targetBox = () => screen.getByRole("combobox", { name: "부탁할 곳" });
const textBox = () => screen.getByRole("textbox", { name: /부탁할 말/ });

describe("AiPartner 부탁할 곳", () => {
  it("부탁을 받은 적이 없으면 “이 라운드 전체”다", async () => {
    await renderBarePage(Partner, "x", "/x");
    expect(targetBox()).toHaveTextContent("이 라운드 전체");
  });

  it("그리기 전에 고른 문단이 있으면 처음부터 그 문단이고, 부탁할 말 칸에 초점이 온다", async () => {
    act(() => aiSheet.ask("문단 2"));
    await renderBarePage(Partner, "x", "/x");
    expect(targetBox()).toHaveTextContent("문단 2");
    await waitFor(() => expect(textBox()).toHaveFocus(), { timeout: 2000 });
  });

  it("그려진 뒤에 새로 고른 문단은 부탁할 곳을 바꾼다", async () => {
    await renderBarePage(Partner, "x", "/x");
    expect(targetBox()).toHaveTextContent("이 라운드 전체");
    act(() => aiSheet.ask("문단 1"));
    await waitFor(() => expect(targetBox()).toHaveTextContent("문단 1"));
    act(() => aiSheet.ask("문단 3"));
    await waitFor(() => expect(targetBox()).toHaveTextContent("문단 3"));
    await waitFor(() => expect(textBox()).toHaveFocus(), { timeout: 2000 });
  });

  it("이미 처리한 부탁은 다시 그려져도 초점을 빼앗지 않는다", async () => {
    act(() => aiSheet.ask("문단 2"));
    const first = await renderBarePage(Partner, "x", "/x");
    await waitFor(() => expect(textBox()).toHaveFocus(), { timeout: 2000 });
    first.unmount();
    await renderBarePage(Partner, "x", "/x");
    // 부탁한 곳은 기억하지만(처음 값) 초점은 가져가지 않는다
    expect(targetBox()).toHaveTextContent("문단 2");
    await new Promise((r) => setTimeout(r, 300));
    expect(textBox()).not.toHaveFocus();
  });

  it("부탁할 말이 비어 있으면 보내기가 막혀 있고 이유를 읽을 수 있다", async () => {
    await renderBarePage(Partner, "x", "/x");
    const section = screen.getByRole("region", { name: "AI에게 부탁하기" });
    const send = within(section).getAllByRole("button").find((b) => b.getAttribute("aria-disabled") === "true");
    expect(send).toBeDefined();
    expect(within(section).getByText("부탁할 말을 적어 주세요.")).toBeInTheDocument();
  });
});

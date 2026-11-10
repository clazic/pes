import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { mockSettings } from "@/lib/mock-settings";
import { researchUi } from "@/lib/research-ui";
import { setViewport } from "@/test/render-app";
import { renderWorkspacePage } from "@/test/render-page";
import { SettingsPage } from "@/features/workspace/SettingsPage";

/** UI7-2 동작 보존 — 설정 화면: 연결을 고르면 그 연결의 기본 모델로 · 정책 스위치가 확인 대화 상자를 연다 */

const URL = "/p/dolbom-insight/settings";

beforeEach(() => {
  sessionStorage.clear();
  mockSettings.reset();
  researchUi.set({ focus: false, aiPanel: false, aiOnRound: false });
  setViewport(1440);
});

async function ready() {
  const view = await renderWorkspacePage(SettingsPage, "settings", URL);
  await screen.findByRole("switch", { name: "AI가 읽기" }, { timeout: 4000 });
  await screen.findAllByRole("radio", {}, { timeout: 4000 });
  return view;
}
const conn = (id: string) => document.getElementById(`sc-${id}`) as HTMLElement;
const modelBox = () => screen.getByRole("combobox", { name: "모델" });

describe("연결 · 모델 고르기", () => {
  it("처음엔 구독 연결과 그 연결의 기본 모델이다", async () => {
    await ready();
    expect(conn("conn-sub")).toHaveAttribute("aria-checked", "true");
    expect(modelBox()).toHaveTextContent("deepseek-v4.1-flash");
  });

  it("다른 연결을 고르면 모델이 그 연결의 기본 모델로 바뀌고, 되돌아오면 처음 모델로 돌아온다", async () => {
    await ready();
    fireEvent.click(conn("conn-metered"));
    await waitFor(() => expect(conn("conn-metered")).toHaveAttribute("aria-checked", "true"));
    await waitFor(() => expect(modelBox()).toHaveTextContent("example-chat-large"));
    fireEvent.click(conn("conn-sub"));
    await waitFor(() => expect(modelBox()).toHaveTextContent("deepseek-v4.1-flash"));
  });

  it("[바꾸기]는 고른 연결·모델을 이름에 넣은 확인 대화 상자를 연다", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "바꾸기" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "방식 A 연결·모델을 연구실 구독 API · deepseek-v4.1-flash(으)로 바꿀까요?" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("AI가 읽기 정책 스위치", () => {
  it("켜진 스위치를 누르면 막기 확인 대화 상자가 열리고, 스위치는 아직 바뀌지 않는다", async () => {
    await ready();
    const sw = screen.getByRole("switch", { name: "AI가 읽기" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "이 프로젝트의 AI가 읽기를 막을까요?" })).toBeInTheDocument();
    expect(sw).toHaveAttribute("aria-checked", "true");
  });

  it("막기는 요청 한 건마다 본인 확인을 거치고, 닫았다 다시 열면 처음 단계로 열린다", async () => {
    await ready();
    fireEvent.click(screen.getByRole("switch", { name: "AI가 읽기" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "AI가 읽기 막기 — 본인 확인으로" }));
    expect(within(dialog).getByText("본인 확인이 필요합니다")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("switch", { name: "AI가 읽기" }));
    const again = await screen.findByRole("dialog");
    expect(within(again).queryByText("본인 확인이 필요합니다")).not.toBeInTheDocument();
    expect(within(again).getByText("바뀌는 것")).toBeInTheDocument();
  });

  it("소유자가 아니면 스위치가 막혀 있고 대화 상자를 열지 않으며, 누르면 이유가 보인다", async () => {
    mockSettings.set({ role: "editor" });
    await ready();
    const sw = screen.getByRole("switch", { name: "AI가 읽기" });
    expect(sw).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(sw);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const why = screen.getAllByText("AI가 읽기는 소유자만 바꿀 수 있습니다.").find((n) => n.hasAttribute("data-reason"));
    expect(why).toBeDefined();
  });

  it("소유자가 아니면 [바꾸기](연결·모델)도 막혀 있다", async () => {
    mockSettings.set({ role: "reader" });
    await ready();
    expect(screen.getByRole("button", { name: "바꾸기" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "바꾸기" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

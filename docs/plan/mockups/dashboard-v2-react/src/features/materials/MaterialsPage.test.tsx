import { act, fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { mockSettings } from "@/lib/mock-settings";
import { researchUi } from "@/lib/research-ui";
import { setViewport } from "@/test/render-app";
import { renderWorkspacePage } from "@/test/render-page";
import { MaterialsPage } from "@/features/materials/MaterialsPage";

/** UI7-2 동작 보존 — 자료 화면: 거르기 · 이름 찾기 · 올리기 대화 상자(#upload 해시로도 열림) */

const URL = "/p/dolbom-insight/files";
const UPLOAD_TITLE = "자료 올리기 — 파일 또는 폴더째";

beforeEach(() => {
  sessionStorage.clear();
  mockSettings.reset();
  researchUi.set({ focus: false, aiPanel: false, aiOnRound: false });
  setViewport(1440);
});

async function ready(hash = "") {
  const view = await renderWorkspacePage(MaterialsPage, "files", URL + hash);
  await screen.findByRole("heading", { name: "자료", level: 2 }, { timeout: 4000 });
  await screen.findByRole("button", { name: "AI 참조 금지" }, { timeout: 4000 });
  return view;
}
const filterBtn = (name: string) => screen.getByRole("button", { name });
/** 파일 표의 몸통 줄 수(머리 줄 제외) */
const bodyRows = () => {
  const table = screen.getAllByRole("table")[0]!;
  return within(table).getAllByRole("row").length - 1;
};

describe("자료 거르기", () => {
  it("처음엔 “전체”가 눌려 있다", async () => {
    await ready();
    expect(filterBtn("전체")).toHaveAttribute("aria-pressed", "true");
    expect(filterBtn("AI 참조 금지")).toHaveAttribute("aria-pressed", "false");
  });

  it("조건 단추를 누르면 그 단추만 눌린 모양이 되고, 다시 “전체”를 누르면 처음 줄 수로 돌아온다", async () => {
    await ready();
    const total = bodyRows();
    expect(total).toBeGreaterThan(2);
    fireEvent.click(filterBtn("AI 참조 금지"));
    expect(filterBtn("AI 참조 금지")).toHaveAttribute("aria-pressed", "true");
    expect(filterBtn("전체")).toHaveAttribute("aria-pressed", "false");
    expect(bodyRows()).toBeLessThan(total);
    fireEvent.click(filterBtn("전체"));
    expect(filterBtn("전체")).toHaveAttribute("aria-pressed", "true");
    expect(bodyRows()).toBe(total);
  });

  it("이름으로 찾으면 줄이 줄고, 비우면 돌아온다", async () => {
    await ready();
    const total = bodyRows();
    const search = screen.getByPlaceholderText("파일·폴더 이름으로 찾기");
    fireEvent.change(search, { target: { value: "xlsx" } });
    expect(bodyRows()).toBeLessThan(total);
    fireEvent.change(search, { target: { value: "" } });
    expect(bodyRows()).toBe(total);
  });
});

describe("올리기 대화 상자", () => {
  it("처음엔 닫혀 있고 [파일 올리기] 단추로 열고 [취소]로 닫는다", async () => {
    await ready();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(document.getElementById("upload") as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: UPLOAD_TITLE })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("주소가 #upload면 처음부터 올리기 대화 상자가 열려 있다", async () => {
    await renderWorkspacePage(MaterialsPage, "files", `${URL}#upload`);
    const dialog = await screen.findByRole("dialog", {}, { timeout: 4000 });
    expect(within(dialog).getByRole("heading", { name: UPLOAD_TITLE })).toBeInTheDocument();
  });

  it("해시가 #upload로 바뀌면 대화 상자가 열리고, 닫은 뒤 다른 해시로 바뀌어도 저절로 열지 않는다", async () => {
    const view = await ready();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => {
      await view.router.navigate(`${URL}#upload`);
    });
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => {
      await view.router.navigate(`${URL}#f1`);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

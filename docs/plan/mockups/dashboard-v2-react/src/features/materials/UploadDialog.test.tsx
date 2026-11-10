import { useState } from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { mockSettings } from "@/lib/mock-settings";
import { setViewport } from "@/test/render-app";
import { renderBarePage } from "@/test/render-page";
import { UploadDialog } from "@/features/materials/UploadDialog";

/** UI7-2 동작 보존 — 업로드 대화 상자: 열 때마다 처음 단계(고르기)로, 고른 파일은 올리기 전 확인(preview)으로 */

beforeEach(() => {
  sessionStorage.clear();
  mockSettings.reset();
  setViewport(1440);
});

function Harness({ startMode }: { startMode?: "files" | "folder" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>열기</button>
      <UploadDialog open={open} onOpenChange={setOpen} slug="dolbom-insight" existing={[]} startMode={startMode} />
    </>
  );
}
const harness = (startMode?: "files" | "folder") => () => <Harness startMode={startMode} />;
const PICK_TEXT = /파일이나 폴더를 여기에 끌어 놓거나/;

describe("UploadDialog", () => {
  it("열면 고르기 단계다", async () => {
    await renderBarePage(harness(), "x", "/x");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("열기"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(PICK_TEXT)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "파일 고르기" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "폴더 고르기" })).toBeInTheDocument();
  });

  it("startMode에 따라 그 방법 단추가 강조(기본 모양)된다", async () => {
    await renderBarePage(harness("folder"), "x", "/x");
    fireEvent.click(screen.getByText("열기"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "폴더 고르기" })).toHaveAttribute("data-variant", "default");
    expect(within(dialog).getByRole("button", { name: "파일 고르기" })).toHaveAttribute("data-variant", "outline");
  });

  it("파일을 고르면 올리기 전 확인 단계로 가서 개수와 이름을 보이고, 아직 올리지 않았다고 알린다", async () => {
    await renderBarePage(harness(), "x", "/x");
    fireEvent.click(screen.getByText("열기"));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("파일 고르기", { selector: "input" });
    const files = [new File(["가"], "첫째 자료(가상).pdf", { type: "application/pdf" }), new File(["나나"], "둘째 자료(가상).xlsx")];
    fireEvent.change(input, { target: { files } });
    expect(within(dialog).queryByText(PICK_TEXT)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/아직 아무것도 올리지 않았습니다/)).toBeInTheDocument();
    expect(within(dialog).getByText("2개")).toBeInTheDocument();
    expect(within(dialog).getByText(/첫째 자료\(가상\)\.pdf/)).toBeInTheDocument();
    expect(within(dialog).getByText(/둘째 자료\(가상\)\.xlsx/)).toBeInTheDocument();
  });

  it("확인 단계에서 [다시 고르기]를 누르면 고르기 단계로 돌아온다", async () => {
    await renderBarePage(harness(), "x", "/x");
    fireEvent.click(screen.getByText("열기"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "예시 폴더로 보기(합성)" }));
    expect(within(dialog).getByText(/아직 아무것도 올리지 않았습니다/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "다시 고르기" }));
    expect(within(dialog).getByText(PICK_TEXT)).toBeInTheDocument();
  });

  it("확인 단계에서 닫았다 다시 열면 처음 단계(고르기)로 열리고 고른 목록은 비어 있다", async () => {
    await renderBarePage(harness(), "x", "/x");
    fireEvent.click(screen.getByText("열기"));
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "예시 폴더로 보기(합성)" }));
    expect(within(dialog).getByText(/아직 아무것도 올리지 않았습니다/)).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByText("열기"));
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(PICK_TEXT)).toBeInTheDocument();
    expect(within(dialog).queryByText(/아직 아무것도 올리지 않았습니다/)).not.toBeInTheDocument();
  });
});

// SEL-117 1차 리뷰 수정 시험 — 대화 상자가 열린 동안 뒤 화면을 inert 로 둔다(필수 1). 합성 자료뿐, 네트워크 0.
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { boot, createMaterialsClient, file, main, switchOf, waitRows } from "@/test/sel117";

afterEach(cleanup);

/** 앱 루트 — body 바로 아래에서 main 을 품고 있는 요소 */
const appRoot = () => {
  let el: HTMLElement = main();
  while (el.parentElement && el.parentElement !== document.body) el = el.parentElement;
  return el;
};

describe("리뷰 필수 1 — 대화 상자가 열린 동안 뒤 화면은 inert", () => {
  it("끄기 대화 상자가 열리면 앱 루트에 inert 가 걸리고, 닫으면 풀린다", async () => {
    await boot(createMaterialsClient());
    await waitRows();
    const user = userEvent.setup();
    expect(appRoot().hasAttribute("inert")).toBe(false);

    await user.click(switchOf("mat-1"));
    await screen.findByRole("dialog", { name: "AI 참조 끄기" });
    await waitFor(() => expect(appRoot().hasAttribute("inert")).toBe(true));

    await user.click(screen.getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(appRoot().hasAttribute("inert")).toBe(false));
  });
});

describe("리뷰 권장 3 — 요청이 나가기 전 실패는 “보내지 못함”, “접수 확인 중”이 아니다", () => {
  it("파일을 읽다 TypeError 가 나면 role 없는 글이 아니라 “보내지 못했어요”, “접수 확인 중”은 없다", async () => {
    const mc = createMaterialsClient();
    await boot(mc);
    await waitRows();
    mc.failNext(new TypeError("합성 브라우저 오류"));
    const user = userEvent.setup();
    const input = screen.getByLabelText("자료 파일 고르기", { selector: "input[type=file]" }) as HTMLInputElement;
    await user.upload(input, file("unsent-synthetic.txt", "보내지 않음"));
    await waitFor(() => expect(document.body.textContent).toContain("보내지 못했어요"));
    expect(document.body.textContent).not.toContain("접수 확인 중");
    expect(document.body.textContent).toContain("합성 브라우저 오류");
  });
});

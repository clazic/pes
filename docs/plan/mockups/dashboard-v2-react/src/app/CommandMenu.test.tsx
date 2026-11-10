import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CommandMenu } from "@/app/CommandMenu";
import { renderRoutes } from "@/test/render-app";

/** UI7-4a — 명령 메뉴(⌘K) 도움말 목록에 단축키 표가 있다 (설계 18.10 “명령 메뉴 도움말 목록에 같은 표”). 합성 자료만. */
describe("[새 요구] 명령 메뉴 단축키 도움말", () => {
  it("1~4(선택지 고르기)와 ⌘/Ctrl+Enter(답 검토 후 보내기)가 도움말에 나온다", async () => {
    await renderRoutes([{ path: "*", element: <CommandMenu open onOpenChange={() => {}} /> }], "/");
    const dialog = await screen.findByRole("dialog");
    const text = dialog.textContent ?? "";
    expect(text).toMatch(/1\s*[~–-]\s*4/);
    expect(text).toMatch(/선택지/);
    expect(text).toMatch(/Enter/);
    expect(text).toMatch(/답 검토 후 보내기/);
  });
});

describe("[회귀] 명령 메뉴", () => {
  it("열면 동작 목록과 검색 칸이 보인다", async () => {
    await renderRoutes([{ path: "*", element: <CommandMenu open onOpenChange={() => {}} /> }], "/");
    expect(await screen.findByPlaceholderText(/동작 이름으로 찾기/)).toBeInTheDocument();
    expect(screen.getByText("새 프로젝트")).toBeInTheDocument();
  });
});

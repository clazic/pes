// SEL-91 U2b — 최종 리뷰 1/2 수정: 질문 대화 상자는 인쇄에서 빠진다 · 좁은 본문 보기에서도 J/K 로 질문 이동 (Vitest, jsdom, 가짜 클라이언트).
// jsdom 은 CSS 를 읽지 않으므로 인쇄 숨김은 속성(data-print=hide — index.css 가 인쇄에서 숨기는 표식)으로, 숨은 영역은 폭·주소로 확인한다. 실제 인쇄 미디어·display:none 은 e2e.
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { CURRENT } from "@/test/contract";
import { query } from "@/test/render-app";
import { activeItemId, aside, boot, item } from "@/test/u2b";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

type User = Awaited<ReturnType<typeof boot>>["user"];
const tool = (name: string) => within(aside()).getByRole("button", { name });

/** 열린 질문 대화 상자의 덮개와 내용이 둘 다 인쇄 제외 표식을 달았는가 */
function expectPrintHidden() {
  const overlay = document.querySelector('[data-slot="dialog-overlay"]');
  const content = document.querySelector('[data-slot="dialog-content"]');
  expect(overlay).not.toBeNull();
  expect(content).not.toBeNull();
  expect(overlay).toHaveAttribute("data-print", "hide");
  expect(content).toHaveAttribute("data-print", "hide");
}

describe("질문 대화 상자는 인쇄에서 빠진다", () => {
  it("질문 더하기: 쓰던 질문 문장이 있는 채로 열려 있어도 덮개와 내용이 data-print=hide", async () => {
    const { user } = await boot();
    await user.click(tool("질문 더하기"));
    const dlg = await screen.findByRole("dialog", { name: "질문 더하기" });
    await user.type(within(dlg).getByLabelText("질문 문장"), "F1 미제출 질문 초안");
    expectPrintHidden();
    // 본문은 인쇄 제외 표식을 달지 않는다(결과 글은 남는다)
    expect(document.querySelector('main [data-area="body"]')?.closest('[data-print="hide"]')).toBeNull();
  });

  it.each([
    ["철회", "질문 23 철회"],
    ["보류", "질문 23 보류"],
    ["합치기", "질문 23 합치기"],
  ])("정리 확인(%s)도 덮개와 내용이 data-print=hide", async (button, dialogName) => {
    const { user } = await boot();
    await user.click(tool("질문 23 정리"));
    const group = within(aside()).getByRole("group", { name: "질문 23 정리" });
    await user.click(within(group).getByRole("button", { name: button }));
    await screen.findByRole("dialog", { name: dialogName });
    expectPrintHidden();
  });
});

describe("좁은 본문 보기에서 J/K", () => {
  const pressFromTitle = async (user: User, keys: string) => {
    const h1 = document.querySelector<HTMLElement>("main [data-screen-title]")!;
    h1.focus();
    expect(document.activeElement).toBe(h1);
    await user.keyboard(keys);
  };

  it.each([
    [1100, "1100px"],
    [683, "683px(200% 확대한 마우스)"],
  ])("%i px · view=body: J 가 질문 보기로 바꾸고 첫 질문에 초점 · 주소 view=ask · focus=q-21", async (width) => {
    const { user, router } = await boot({}, `${CURRENT}?view=body`, { width });
    await pressFromTitle(user, "j");
    await waitFor(() => expect(activeItemId()).toBe("q-21"));
    expect(query(router).get("view")).toBe("ask");
    expect(query(router).get("focus")).toBe("q-21");
  });

  it("좁은 본문 보기에서 J 두 번 뒤 K: q-22 로 갔다가 q-21 로 돌아오고 주소 focus 가 따라간다", async () => {
    const { user, router } = await boot({}, `${CURRENT}?view=body`, { width: 1100 });
    await pressFromTitle(user, "jj");
    await waitFor(() => expect(activeItemId()).toBe("q-22"));
    expect(query(router).get("view")).toBe("ask");
    expect(query(router).get("focus")).toBe("q-22");
    await user.keyboard("k");
    await waitFor(() => expect(activeItemId()).toBe("q-21"));
    expect(query(router).get("focus")).toBe("q-21");
  });

  it("주소에 view 가 없어도(기본 본문 보기) 좁으면 같다", async () => {
    const { user, router } = await boot({}, CURRENT, { width: 1100 });
    await pressFromTitle(user, "j");
    await waitFor(() => expect(activeItemId()).toBe("q-21"));
    expect(query(router).get("view")).toBe("ask");
  });

  it("'다음 질문' 단추도 같은 길을 쓴다(질문 보기에서는 view 그대로)", async () => {
    const { user, router } = await boot({}, `${CURRENT}?view=ask`, { width: 1100 });
    await user.click(within(aside()).getByRole("button", { name: "다음 질문" }));
    await waitFor(() => expect(activeItemId()).toBe("q-22"));
    expect(query(router).get("view")).toBe("ask");
  });

  it("넓은 화면(1440)은 두 영역이 함께 보이므로 view 를 바꾸지 않고 초점만 옮긴다", async () => {
    const { user, router } = await boot({}, CURRENT, { width: 1440 });
    await pressFromTitle(user, "j");
    await waitFor(() => expect(activeItemId()).toBe("q-21"));
    expect(query(router).get("view")).toBeNull();
    expect(query(router).get("focus")).toBe("q-21");
    expect(item("q-21")).toBe(document.activeElement);
  });
});

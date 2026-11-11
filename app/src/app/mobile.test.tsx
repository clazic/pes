// SEL-81 U1a — 모바일(폭 <900 + 굵은 포인터)은 읽기·답·의견·오류 확인·인쇄 미리보기·복사 대안만 (Vitest, jsdom).
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";
import { CURRENT, NAMES, PAST, WIDTHS } from "@/test/contract";

const ready = async () => {
  await screen.findByRole("main");
  await waitFor(() => expect(screen.getByRole("main").querySelector("[data-screen-title]")).not.toBeNull());
};
const ask = () => screen.getByRole("complementary", { name: NAMES.ask });
const body = () => screen.getByRole("main");

function reasonOf(btn: HTMLElement): string {
  const ids = (btn.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
}

describe("휴대폰(폭 390 + 굵은 포인터)", () => {
  it("편집·첨언 작성은 막힌다 — aria-disabled + 이유('데스크톱'), 단추는 남아 있다", async () => {
    await renderApp(`${CURRENT}?view=ask`, { width: WIDTHS.phone, coarse: true });
    await ready();
    const edit = within(ask()).getByRole("button", { name: NAMES.edit });
    expect(edit).toHaveAttribute("aria-disabled", "true");
    expect(reasonOf(edit)).toMatch(/데스크톱/);
  });

  it("막힌 단추를 눌러도 편집 화면·대화 상자가 열리지 않는다", async () => {
    const user = userEvent.setup();
    await renderApp(CURRENT, { width: WIDTHS.phone, coarse: true });
    await ready();
    const annotate = within(body()).getByRole("button", { name: NAMES.annotate });
    expect(annotate).toHaveAttribute("aria-disabled", "true");
    expect(reasonOf(annotate)).toMatch(/데스크톱/);
    await user.click(annotate);
    annotate.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("textbox", { name: /첨언/ })).toBeNull();
  });

  it("읽기·답·의견·오류 확인·인쇄 미리보기·복사 대안은 켜져 있다", async () => {
    const user = userEvent.setup();
    await renderApp(`${CURRENT}?view=ask`, { width: WIDTHS.phone, coarse: true });
    await ready();
    const answer = within(ask()).getAllByRole("textbox", { name: /답/ })[0]!;
    const comment = within(ask()).getAllByRole("textbox", { name: /의견/ })[0]!;
    for (const box of [answer, comment]) {
      expect(box).not.toHaveAttribute("aria-disabled", "true");
      expect(box).not.toBeDisabled();
      expect(box).not.toHaveAttribute("readonly");
    }
    await user.type(answer, "합성 답");
    expect(answer).toHaveValue("합성 답");
    for (const name of [NAMES.print, NAMES.copy, NAMES.ackError]) {
      const btn = within(body()).getByRole("button", { name });
      expect(btn, name).not.toHaveAttribute("aria-disabled", "true");
      expect(btn, name).not.toBeDisabled();
    }
  });

  it("'인쇄 미리보기'를 누르면 print 영역이 열린다(휴대폰에서도)", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(CURRENT, { width: WIDTHS.phone, coarse: true });
    await ready();
    await user.click(within(body()).getByRole("button", { name: NAMES.print }));
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get("print")).toBe("1"));
    expect(await screen.findByRole("region", { name: NAMES.print })).toBeInTheDocument();
  });
});

describe("폭만으로 숨기지 않는다(200% 확대 F08)", () => {
  it.each([[WIDTHS.zoom200of1366], [WIDTHS.zoom200of1440], [WIDTHS.phone]])("폭 %i · 거친 포인터 아님 → 편집 도구가 켜져 있다", async (width) => {
    await renderApp(`${CURRENT}?view=ask`, { width, coarse: false });
    await ready();
    expect(within(ask()).getByRole("button", { name: NAMES.edit })).not.toHaveAttribute("aria-disabled", "true");
  });

  it("굵은 포인터여도 폭이 넓으면(1440) 데스크톱으로 본다", async () => {
    await renderApp(`${CURRENT}?view=ask`, { width: 1440, coarse: true });
    await ready();
    expect(within(ask()).getByRole("button", { name: NAMES.edit })).not.toHaveAttribute("aria-disabled", "true");
  });
});

describe("지난 라운드는 읽기 전용", () => {
  it("과거 라운드에서는 데스크톱이어도 편집·첨언이 막히고 이유가 '지난 라운드'다", async () => {
    await renderApp(`${PAST}?view=ask`, { width: 1440 });
    await ready();
    const edit = within(ask()).getByRole("button", { name: NAMES.edit });
    expect(edit).toHaveAttribute("aria-disabled", "true");
    expect(reasonOf(edit)).toMatch(/지난/);
  });
});

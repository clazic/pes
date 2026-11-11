// SEL-83 U1c — 미리보기 · 순서 넘김 틀: 열린 질문 · 지난 라운드에서 같은 화면 상태를 유지한다 (Vitest, jsdom).
// 계약: src/test/contract.ts 머리말 "미리보기 · 순서 넘김 틀".
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { query, renderApp } from "@/test/render-app";
import { CMD, CURRENT, NAMES, PAST, WIDTHS, url } from "@/test/contract";
import { ready } from "@/test/ui";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

const peek = () => screen.getByRole("dialog", { name: NAMES.peek });
const open = async (user: ReturnType<typeof userEvent.setup>, n: number) => user.click(screen.getByRole("button", { name: `질문 ${n} 미리보기` }));

describe("순서 넘김", () => {
  it("열린 질문: 첫 질문에서 '이전 질문' 은 aria-disabled(숨기지 않음), '다음 질문' 은 peek 만 옆 질문으로 바꾼다", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    await open(user, 21);
    const prev = within(peek()).getByRole("button", { name: CMD.prevQ });
    const next = within(peek()).getByRole("button", { name: CMD.nextQ });
    expect(prev).toHaveAttribute("aria-disabled", "true");
    expect(next).not.toHaveAttribute("aria-disabled", "true");
    await user.click(prev);
    expect(query(router).get("peek"), "막힌 단추는 눌러도 그대로").toBe("q-21");
    await user.click(next);
    await waitFor(() => expect(query(router).get("peek")).toBe("q-22"));
    expect(peek().textContent).toContain("질문 22");
    expect(within(peek()).getByRole("button", { name: CMD.nextQ })).toHaveAttribute("aria-disabled", "true");
    expect(within(peek()).getByRole("button", { name: CMD.prevQ })).not.toHaveAttribute("aria-disabled", "true");
  });

  it("넘겨도 초점은 미리보기 대화 상자 안에 남는다", async () => {
    const user = userEvent.setup();
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    await open(user, 21);
    await user.click(within(peek()).getByRole("button", { name: CMD.nextQ }));
    await waitFor(() => expect(peek().contains(document.activeElement)).toBe(true));
  });

  it("다른 쿼리(view·focus)와 경로는 그대로 — 같은 화면 상태 유지", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(url("research", 2, "view=ask&focus=q-22"), { width: WIDTHS.mid });
    await ready();
    await open(user, 21);
    await user.click(within(peek()).getByRole("button", { name: CMD.nextQ }));
    await waitFor(() => expect(query(router).get("peek")).toBe("q-22"));
    expect(query(router).get("view")).toBe("ask");
    expect(router.state.location.pathname).toBe(new URL(CURRENT, "http://x").pathname);
  });

  it("넘기기는 기록을 쌓지 않는다(replace) — 닫은 뒤 뒤로 가기가 질문 사이를 헤매지 않는다", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    await open(user, 21);
    await user.click(within(peek()).getByRole("button", { name: CMD.nextQ }));
    await waitFor(() => expect(query(router).get("peek")).toBe("q-22"));
    expect(router.state.historyAction, "넘김은 replace").toBe("REPLACE");
  });

  it("지난 라운드(기획 R1)에서도 같은 틀: 경로는 지난 라운드 그대로, q-11 → q-12", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(PAST, { width: WIDTHS.wide1440 });
    await ready();
    await open(user, 11);
    await user.click(within(peek()).getByRole("button", { name: CMD.nextQ }));
    await waitFor(() => expect(query(router).get("peek")).toBe("q-12"));
    expect(router.state.location.pathname).toBe(new URL(PAST, "http://x").pathname);
    expect(peek().textContent).toContain("질문 12");
    expect(screen.getByRole("main").querySelector("[data-screen-title]")?.textContent).toContain("기획 R1");
  });

  it("보낸 답이 있는 지난 질문에서도 보낸 답이 미리보기에 보인다(순서를 넘겨도)", async () => {
    const user = userEvent.setup();
    await renderApp(PAST, { width: WIDTHS.wide1440 });
    await ready();
    await open(user, 11);
    expect(peek().textContent).toMatch(/보낸 답|접수/);
    await user.click(within(peek()).getByRole("button", { name: CMD.nextQ }));
    expect(peek().textContent).toMatch(/보낸 답|접수|아직 보낸 답이 없습니다/);
  });

  it("딥링크 ?peek=q-22 로 들어와도 '다음 질문' 은 막히고 '이전 질문' 은 q-21 로 간다", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(url("research", 2, "peek=q-22"), { width: WIDTHS.wide1440 });
    await ready();
    await screen.findByRole("dialog", { name: NAMES.peek });
    expect(within(peek()).getByRole("button", { name: CMD.nextQ })).toHaveAttribute("aria-disabled", "true");
    await user.click(within(peek()).getByRole("button", { name: CMD.prevQ }));
    await waitFor(() => expect(query(router).get("peek")).toBe("q-21"));
  });

  it("넘긴 뒤 Esc 로 닫으면 peek 가 지워진다(초점 자리는 아래 시험이 고정한다)", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    await open(user, 21);
    await user.click(within(peek()).getByRole("button", { name: CMD.nextQ }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(query(router).get("peek")).toBeNull());
    expect(screen.queryByRole("dialog", { name: NAMES.peek })).toBeNull();
  });
});

describe("닫은 뒤 초점 자리 (R1 권장 8 — 의도로 고정)", () => {
  it("넘기지 않고 닫으면 연 단추(#peek-q-21)로 돌아간다", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    await open(user, 21);
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(query(router).get("peek")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("peek-q-21")));
  });

  it("q-21 을 연 뒤 '다음 질문' 으로 q-22 를 보다가 닫으면 지금 보던 질문의 단추(#peek-q-22)로 돌아간다 — 처음 연 단추가 아니다", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    await open(user, 21);
    await user.click(within(peek()).getByRole("button", { name: CMD.nextQ }));
    await waitFor(() => expect(query(router).get("peek")).toBe("q-22"));
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(query(router).get("peek")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("peek-q-22")));
    expect(document.activeElement).not.toBe(document.getElementById("peek-q-21"));
  });

  it("넘긴 뒤 '닫기' 단추로 닫아도 같다(#peek-q-22)", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    await open(user, 21);
    await user.click(within(peek()).getByRole("button", { name: CMD.nextQ }));
    await user.click(within(peek()).getByRole("button", { name: /닫기/ }));
    await waitFor(() => expect(query(router).get("peek")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("peek-q-22")));
  });

  it("딥링크로 q-22 에서 시작해 '이전 질문' 으로 q-21 을 보고 닫으면 #peek-q-21", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(url("research", 2, "peek=q-22"), { width: WIDTHS.wide1440 });
    await ready();
    await screen.findByRole("dialog", { name: NAMES.peek });
    await user.click(within(peek()).getByRole("button", { name: CMD.prevQ }));
    await waitFor(() => expect(query(router).get("peek")).toBe("q-21"));
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(query(router).get("peek")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("peek-q-21")));
  });
});

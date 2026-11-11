// SEL-83 U1c — 화면의 초안: sessionStorage 열쇠 · 메모리 대체 · 새 버전 질문의 옛 초안 검토 (Vitest, jsdom).
// 계약: src/test/contract.ts 머리말 "초안". 이름 있는 sessionStorage 항목은 `pes-draft:` 로 시작.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScriptedClient } from "@/test/scripted-client";
import { renderApp } from "@/test/render-app";
import { CMD, CURRENT, PAST, U1C, WIDTHS, url } from "@/test/contract";
import { answerBox, askPane, draftEntries, opinionBox, ready } from "@/test/ui";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(() => vi.useRealTimers());

describe("sessionStorage 열쇠", () => {
  it("답 칸에 쓰면 프로젝트·사용자·판·폼 버전·질문·질문 버전이 든 키 하나에 저장된다", async () => {
    const user = userEvent.setup();
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    await user.type(answerBox("q-21"), "내 답");
    const hits = draftEntries(/^pes-draft:/).filter(([, v]) => v === "내 답");
    expect(hits).toHaveLength(1);
    const key = hits[0]![0];
    for (const part of ["sample-study", U1C.draftUser, "q-21", "answer"]) expect(key, part).toContain(part);
    expect(key).toMatch(/(^|[^\d])1([^\d]|$)/); // 판 1 (또는 e1)
    expect(key).toMatch(/2/); // 폼 버전 2 (조사 R2 의 form_version)
    expect(key).toMatch(/v?1/); // 질문 버전 1
  });

  it("의견 칸은 다른 키에 저장된다", async () => {
    const user = userEvent.setup();
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    await user.type(answerBox("q-21"), "답");
    await user.type(opinionBox("q-21"), "의견");
    const keys = draftEntries(/^pes-draft:/).map(([k]) => k);
    expect(new Set(keys).size).toBe(2);
    expect(draftEntries(/^pes-draft:/).map(([, v]) => v).sort()).toEqual(["답", "의견"]);
  });

  it("다른 질문(q-22)의 초안과 섞이지 않는다", async () => {
    const user = userEvent.setup();
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    await user.type(answerBox("q-21"), "하나");
    await user.type(answerBox("q-22"), "둘");
    expect(draftEntries(/q-21/).map(([, v]) => v)).toEqual(["하나"]);
    expect(draftEntries(/q-22/).map(([, v]) => v)).toEqual(["둘"]);
  });

  it("새로 불러와도(같은 탭) 초안이 돌아온다", async () => {
    const user = userEvent.setup();
    const first = await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    await user.type(answerBox("q-21"), "남아야 함");
    first.unmount();
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    expect(answerBox("q-21").value).toBe("남아야 함");
  });

  it("보낸 답이 있는 질문(지난 라운드)에는 답 칸이 없어 초안도 만들어지지 않는다", async () => {
    await renderApp(PAST, { width: WIDTHS.wide1440 });
    await ready();
    expect(within(askPane()).queryAllByRole("textbox")).toHaveLength(0);
    expect(draftEntries(/^pes-draft:/)).toHaveLength(0);
  });
});

describe("sessionStorage 를 못 쓸 때 — 메모리 대체", () => {
  const real = Object.getOwnPropertyDescriptor(window, "sessionStorage")!;
  afterEach(() => Object.defineProperty(window, "sessionStorage", real));

  it("저장소 접근이 예외여도 앱이 그려지고, 쓴 글이 라운드를 옮겼다 돌아와도 남는다", async () => {
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new DOMException("차단", "SecurityError");
      },
    });
    const user = userEvent.setup();
    const { router } = await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    await user.type(answerBox("q-21"), "메모리에 남김");
    await act(() => router.navigate(url("research", 1)));
    await waitFor(() => expect(screen.getByRole("main").querySelector("[data-screen-title]")?.textContent).toContain("조사 R1"));
    await act(() => router.navigate(CURRENT));
    await waitFor(() => expect(screen.getByRole("main").querySelector("[data-screen-title]")?.textContent).toContain("조사 R2"));
    expect(answerBox("q-21").value).toBe("메모리에 남김");
  });
});

describe("질문이 새 버전이 되면 — 옛 초안을 검토 없이 옮기지 않는다", () => {
  /** 조사 R2 의 q-21 이 version 2 로 바뀐 읽기 */
  const bump = (s: ReturnType<typeof createScriptedClient>) =>
    s.patchRound("research/2", (r) => ({ ...r, questions: r.questions.map((q) => (q.id === "q-21" ? { ...q, version: 2, text: `${q.text} (고친 질문)` } : q)) }));

  it("새 버전 읽기가 오면 새 칸은 비고, 안내(role=status)와 옛 초안이 읽기 전용으로 보인다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = createScriptedClient();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await renderApp(CURRENT, { width: WIDTHS.wide1440 }, { client: s.client });
    await ready();
    await user.type(answerBox("q-21"), "옛 버전에서 쓴 글");
    bump(s);
    s.queueChanges({ cursor: "c1", txs: [] }, { cursor: "c2", txs: [{ tx_id: "t1", touched: ["round:research/2"] }] });
    await act(() => vi.advanceTimersByTimeAsync(9000));

    const review = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-draft-review="q-21"]');
      expect(el, "새 버전 검토 영역").not.toBeNull();
      return el!;
    });
    expect(within(review).getByRole("status").textContent).toMatch(/새 버전/);
    expect(review.textContent).toContain("옛 버전에서 쓴 글");
    expect(within(review).queryByRole("textbox"), "옛 초안은 읽기 전용(입력 칸 아님)").toBeNull();
    expect(answerBox("q-21").value, "새 칸은 비어 있다").toBe("");
    // 옛 키 저장값은 지우지 않는다
    expect(draftEntries(/q-21/).some(([, v]) => v === "옛 버전에서 쓴 글")).toBe(true);
  });

  it("“이전 초안 가져오기”를 눌러야 새 칸에 들어가고 영역이 닫힌다 — 새 키에 저장", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = createScriptedClient();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await renderApp(CURRENT, { width: WIDTHS.wide1440 }, { client: s.client });
    await ready();
    await user.type(answerBox("q-21"), "가져올 글");
    bump(s);
    s.queueChanges({ cursor: "c1", txs: [] }, { cursor: "c2", txs: [{ tx_id: "t1", touched: ["round:research/2"] }] });
    await act(() => vi.advanceTimersByTimeAsync(9000));
    const review = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-draft-review="q-21"]');
      expect(el).not.toBeNull();
      return el!;
    });
    await user.click(within(review).getByRole("button", { name: CMD.reviewButton }));
    expect(answerBox("q-21").value).toBe("가져올 글");
    expect(document.querySelector('[data-draft-review="q-21"]')).toBeNull();
    const v2 = draftEntries(/q-21/).filter(([, v]) => v === "가져올 글");
    expect(v2.length, "옛 키 + 새 키").toBe(2);
  });

  it("옛 초안이 없으면 새 버전이어도 검토 영역이 없다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = createScriptedClient();
    await renderApp(CURRENT, { width: WIDTHS.wide1440 }, { client: s.client });
    await ready();
    bump(s);
    s.queueChanges({ cursor: "c1", txs: [] }, { cursor: "c2", txs: [{ tx_id: "t1", touched: ["round:research/2"] }] });
    await act(() => vi.advanceTimersByTimeAsync(9000));
    await waitFor(() => expect(screen.getByText(/\(고친 질문\)/)).toBeInTheDocument());
    expect(document.querySelector("[data-draft-review]")).toBeNull();
  });

  it("다른 질문(q-22)의 초안은 새 버전 영향을 받지 않는다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = createScriptedClient();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await renderApp(CURRENT, { width: WIDTHS.wide1440 }, { client: s.client });
    await ready();
    await user.type(answerBox("q-22"), "둘째 글");
    bump(s);
    s.queueChanges({ cursor: "c1", txs: [] }, { cursor: "c2", txs: [{ tx_id: "t1", touched: ["round:research/2"] }] });
    await act(() => vi.advanceTimersByTimeAsync(9000));
    await waitFor(() => expect(screen.getByText(/\(고친 질문\)/)).toBeInTheDocument());
    expect(answerBox("q-22").value).toBe("둘째 글");
    expect(document.querySelector('[data-draft-review="q-22"]')).toBeNull();
  });
});

// jsdom 에서 fireEvent 만 쓰는 import 가 안 쓰이면 린트가 막는다 — 아래 보호 시험이 사용
describe("초안 칸 기본 동작(회귀)", () => {
  it("값을 바꾸면 곧바로 저장되고 비우면 항목이 지워진다", async () => {
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    fireEvent.change(answerBox("q-21"), { target: { value: "임시" } });
    expect(draftEntries(/q-21/).map(([, v]) => v)).toEqual(["임시"]);
    fireEvent.change(answerBox("q-21"), { target: { value: "" } });
    expect(draftEntries(/q-21/)).toHaveLength(0);
  });
});

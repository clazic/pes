// SEL-83 U1c — 입력 중 갱신 보존: changes 갱신 · 커서 무효(410) · 시간 초과가 와도 초안·초점·한글 조합(IME) 값이 지워지지 않는다 (Vitest, jsdom, 가짜 시계).
// jsdom 은 실제 IME 가 없다 → compositionstart/compositionend 이벤트와 그 사이 값 변경으로 흉내 낸다. 실제 IME 는 e2e(u1c.spec.ts)와 수동 병행 시험.
// 계약: src/test/contract.ts 머리말 "입력 중 갱신에 대한 보존".
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, createScriptedClient, timeoutError } from "@/test/scripted-client";
import { renderApp } from "@/test/render-app";
import { CURRENT, WIDTHS } from "@/test/contract";
import { answerBox, draftEntries, opinionBox, ready } from "@/test/ui";

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

/** q-22 질문 글을 바꾸는 라운드 읽기 — 갱신이 실제로 화면에 닿았는지 보려는 표식 */
const MARK = "(갱신 표식)";
const mark = (s: ReturnType<typeof createScriptedClient>) =>
  s.patchRound("research/2", (r) => ({ ...r, questions: r.questions.map((q) => (q.id === "q-22" ? { ...q, text: `${q.text} ${MARK}` } : q)) }));
const touchRound = { cursor: "c-touch", txs: [{ tx_id: "tx-live", touched: ["round:research/2"] }] };

async function boot() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const s = createScriptedClient();
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const app = await renderApp(CURRENT, { width: WIDTHS.wide1440 }, { client: s.client });
  await ready();
  return { s, user, ...app };
}
const refreshed = () => waitFor(() => expect(screen.getByText(new RegExp(MARK.replace(/[()]/g, "\\$&")))).toBeInTheDocument());

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(() => vi.useRealTimers());

describe("changes 갱신이 와도", () => {
  it("입력 중인 답 칸은 같은 DOM 노드 · 값 · 초점 · 선택 범위가 그대로", async () => {
    const { s, user } = await boot();
    const box = answerBox("q-21");
    await user.click(box);
    await user.type(box, "쓰는 중인 글");
    box.setSelectionRange(2, 4);
    mark(s);
    s.queueChanges(touchRound);
    await advance(8_000);
    await refreshed();
    expect(answerBox("q-21"), "같은 노드(다시 만들지 않음)").toBe(box);
    expect(box.value).toBe("쓰는 중인 글");
    expect(document.activeElement).toBe(box);
    expect([box.selectionStart, box.selectionEnd]).toEqual([2, 4]);
  });

  it("갱신 직후에도 이어서 칠 수 있다(글이 이어 붙는다)", async () => {
    const { s, user } = await boot();
    await user.click(answerBox("q-21"));
    await user.type(answerBox("q-21"), "가나");
    mark(s);
    s.queueChanges(touchRound);
    await advance(8_000);
    await refreshed();
    await user.type(answerBox("q-21"), "다라");
    expect(answerBox("q-21").value).toBe("가나다라");
    expect(draftEntries(/q-21/).map(([, v]) => v)).toEqual(["가나다라"]);
  });

  it("다른 질문의 의견 칸 초점도 그대로", async () => {
    const { s, user } = await boot();
    await user.click(opinionBox("q-22"));
    await user.type(opinionBox("q-22"), "의견 씀");
    const box = opinionBox("q-22");
    mark(s);
    s.queueChanges(touchRound);
    await advance(8_000);
    await refreshed();
    expect(opinionBox("q-22")).toBe(box);
    expect(document.activeElement).toBe(box);
    expect(box.value).toBe("의견 씀");
  });

  it("workspace 읽기가 바뀌어도(차례 말 등) 질문 영역 입력은 그대로", async () => {
    const { s, user } = await boot();
    await user.click(answerBox("q-21"));
    await user.type(answerBox("q-21"), "유지");
    const box = answerBox("q-21");
    s.queueChanges({ cursor: "c-ws", txs: [{ tx_id: "tx-ws", touched: ["workspace"] }] });
    await advance(8_000);
    await waitFor(() => expect(s.count("getWorkspace")).toBeGreaterThanOrEqual(1));
    expect(answerBox("q-21")).toBe(box);
    expect(box.value).toBe("유지");
    expect(document.activeElement).toBe(box);
  });
});

describe("한글 조합(IME) 중 갱신", () => {
  it("compositionstart ~ compositionend 사이에 갱신이 와도 조합 중 값이 지워지거나 되돌려지지 않는다", async () => {
    const { s } = await boot();
    const box = answerBox("q-21");
    box.focus();
    fireEvent.change(box, { target: { value: "안" } });
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: "안ㄴ" } }); // 조합 중 중간 값
    mark(s);
    s.queueChanges(touchRound);
    await advance(8_000);
    await refreshed();
    expect(answerBox("q-21"), "같은 노드").toBe(box);
    expect(box.value, "조합 중 값").toBe("안ㄴ");
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "안녕" } });
    fireEvent.compositionEnd(box, { data: "녕" });
    expect(box.value).toBe("안녕");
    expect(draftEntries(/q-21/).map(([, v]) => v)).toEqual(["안녕"]);
  });

  it("조합 중에 커서 무효(410)가 와도 값·초점이 그대로", async () => {
    const { s } = await boot();
    const box = answerBox("q-21");
    box.focus();
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: "ㅎ" } });
    s.queueChanges(apiError("cursor_expired"));
    await advance(10_000);
    expect(answerBox("q-21")).toBe(box);
    expect(box.value).toBe("ㅎ");
    expect(document.activeElement).toBe(box);
  });

  it("조합이 끝나기 전 저장된 중간 값은 초안으로 확정되기 전이라도 화면 값을 덮지 않는다(조합 종료 뒤 확정 값이 저장)", async () => {
    const { s } = await boot();
    const box = answerBox("q-21");
    box.focus();
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: "ㅇ" } });
    mark(s);
    s.queueChanges(touchRound);
    await advance(8_000);
    await refreshed();
    fireEvent.change(box, { target: { value: "예" } });
    fireEvent.compositionEnd(box, { data: "예" });
    expect(box.value).toBe("예");
    expect(draftEntries(/q-21/).map(([, v]) => v).pop()).toBe("예");
  });
});

describe("커서 무효(410)·시간 초과·오류가 와도 초안이 남는다", () => {
  it.each([
    ["cursor_expired(410)", () => apiError("cursor_expired")],
    ["cursor_invalid(400)", () => apiError("cursor_invalid")],
    ["시간 초과", () => timeoutError()],
    ["일반 네트워크 오류", () => new Error("네트워크 끊김")],
  ])("%s", async (_name, make) => {
    const { s, user } = await boot();
    await user.click(answerBox("q-21"));
    await user.type(answerBox("q-21"), "지켜야 할 초안");
    await user.type(opinionBox("q-22"), "의견 초안");
    const box = answerBox("q-21");
    const focusEl = document.activeElement;
    s.queueChanges(make());
    await advance(20_000);
    expect(answerBox("q-21"), "질문 영역을 다시 만들지 않음").toBe(box);
    expect(box.value).toBe("지켜야 할 초안");
    expect(opinionBox("q-22").value).toBe("의견 초안");
    expect(document.activeElement).toBe(focusEl);
    const stored = draftEntries(/^pes-draft:/).map(([, v]) => v).sort();
    expect(stored).toEqual(["의견 초안", "지켜야 할 초안"].sort());
  });

  it("410 뒤 재동기화로 읽기를 다시 받아 화면 자료가 새로 오지만 초안은 그대로", async () => {
    const { s, user } = await boot();
    await user.click(answerBox("q-21"));
    await user.type(answerBox("q-21"), "초안 유지");
    mark(s);
    s.queueChanges(apiError("cursor_expired"));
    await advance(15_000);
    await refreshed(); // 재동기화로 받은 새 자료가 보인다
    expect(answerBox("q-21").value).toBe("초안 유지");
    expect(document.activeElement).toBe(answerBox("q-21"));
  });

  it("오류가 난 동안에도 화면 자료를 지우지 않는다(질문 글 그대로)", async () => {
    const { s } = await boot();
    s.queueChanges(new Error("끊김"), new Error("끊김"));
    await advance(30_000);
    expect(screen.getByText(/대출 수 자료의 정의가 2021년에 바뀌었어요/)).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
  });
});

// SEL-83 U1c 1차 리뷰(R1) 반영 시험 — 명령 메뉴: 조합 중 Esc(필수 1) · 한글 자판 Ctrl/Cmd+K(권장 6) · 열린 동안 동작 목록 갱신(권장 7) · 세션 1회(권장 5) · 맥락 메뉴 양보(권장 8) (Vitest, jsdom).
// 계약: src/test/contract.ts 머리말 "명령 메뉴" 의 [R1 …] 줄. 구현을 추측하지 않고 화면(role·이름)과 호출만 본다.
import * as React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandMenuProvider, useCommandMenu, useRegisterActions } from "@/app/CommandMenu";
import type { PesAction } from "@/app/actions";
import { createScriptedClient } from "@/test/scripted-client";
import { query, renderApp, setEnv } from "@/test/render-app";
import { CMD, CURRENT, NAMES, SHELL, WIDTHS } from "@/test/contract";
import { answerBox, ready } from "@/test/ui";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

const opener = () => within(screen.getByRole("banner")).getByRole("button", { name: SHELL.command });
const dialog = () => screen.queryByRole("dialog", { name: CMD.dialog });
const menu = () => screen.getByRole("dialog", { name: CMD.dialog });
const box = () => within(menu()).getByRole("combobox", { name: CMD.combobox }) as HTMLInputElement;
const typeInto = (text: string) => fireEvent.change(box(), { target: { value: text } });

async function boot(url = CURRENT) {
  const s = createScriptedClient();
  const user = userEvent.setup();
  const app = await renderApp(url, { width: WIDTHS.wide1440 }, { client: s.client });
  await ready();
  return { s, user, ...app };
}

describe("필수 1 — 검색 칸의 한글 조합 중 Esc 는 메뉴를 닫지 않는다", () => {
  it.each([
    ["compositionstart 뒤 isComposing", async () => fireEvent.compositionStart(box()), { isComposing: true }],
    ["compositionstart 뒤 keyCode 229", async () => fireEvent.compositionStart(box()), { keyCode: 229 }],
    ["이벤트 표시만 isComposing (compositionstart 이벤트 없이)", async () => {}, { isComposing: true }],
    ["이벤트 표시만 keyCode 229 (compositionstart 이벤트 없이)", async () => {}, { keyCode: 229 }],
    ["compositionstart 뒤 표시 없는 Esc(문서가 본 조합 상태)", async () => fireEvent.compositionStart(box()), {}],
  ])("%s → 대화 상자 유지 · 검색어 유지 · 초점 유지", async (_n, begin, init) => {
    const { user } = await boot();
    await user.click(opener());
    typeInto("인쇄");
    box().focus();
    await begin();
    const notPrevented = fireEvent.keyDown(box(), { key: "Escape", ...init });
    void notPrevented;
    await act(async () => {});
    expect(dialog(), "조합 취소용 Esc 에 메뉴가 사라지면 안 된다").not.toBeNull();
    expect(box().value).toBe("인쇄");
    expect(document.activeElement).toBe(box());
  });

  it("조합이 끝난 뒤 Esc 는 닫고 열기 전 단추로 초점이 돌아온다", async () => {
    const { user } = await boot();
    await user.click(opener());
    typeInto("인쇄");
    fireEvent.compositionStart(box());
    fireEvent.keyDown(box(), { key: "Escape", isComposing: true });
    expect(dialog()).not.toBeNull();
    fireEvent.compositionEnd(box());
    fireEvent.keyDown(box(), { key: "Escape" });
    await waitFor(() => expect(dialog()).toBeNull());
    expect(document.activeElement).toBe(opener());
  });

  it("조합 밖 Esc 는 (검색어가 있어도) 바로 닫고, 글 칸에서 연 메뉴는 그 글 칸으로 돌아온다", async () => {
    await boot();
    const ta = answerBox("q-21");
    ta.focus();
    fireEvent.keyDown(ta, { key: "k", ctrlKey: true });
    await screen.findByRole("dialog", { name: CMD.dialog });
    typeInto("미리");
    fireEvent.keyDown(box(), { key: "Escape" });
    await waitFor(() => expect(dialog()).toBeNull());
    expect(document.activeElement).toBe(ta);
  });

  it("조합 중 Esc 를 눌렀다 놓는 동안(keydown→keyup)에도 다시 열었을 때 검색어가 남지 않는다(세션 규칙 유지)", async () => {
    const { user } = await boot();
    await user.click(opener());
    typeInto("인쇄");
    fireEvent.compositionStart(box());
    fireEvent.keyDown(box(), { key: "Escape", isComposing: true });
    fireEvent.compositionEnd(box());
    fireEvent.keyDown(box(), { key: "Escape" });
    await waitFor(() => expect(dialog()).toBeNull());
    await user.click(opener());
    expect(box().value, "다시 열면 처음부터").toBe("");
  });

  it("AI 모드 입력 칸에서도 조합 중 Esc 는 닫지 않는다", async () => {
    const { user } = await boot();
    await user.click(opener());
    await user.click(within(menu()).getByRole("button", { name: CMD.aiToggle }));
    const input = within(menu()).getByRole("combobox", { name: /AI/ }) as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "안" } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    await act(async () => {});
    expect(dialog()).not.toBeNull();
    expect(input.value).toBe("안");
  });
});

describe("권장 6 — 한글 자판에서도 Ctrl/Cmd+K (key 가 'ㅏ' 여도 code 가 KeyK)", () => {
  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Cmd", { metaKey: true }],
  ])("%s+K, key='ㅏ' · code='KeyK' 로 연다", async (_n, mod) => {
    await boot();
    const notPrevented = fireEvent.keyDown(document.body, { key: "ㅏ", code: "KeyK", ...mod });
    expect(notPrevented, "열었으니 기본 동작을 막는다").toBe(false);
    expect(await screen.findByRole("dialog", { name: CMD.dialog })).toBeInTheDocument();
  });

  it("글 칸에서 쓰다가도 열린다", async () => {
    await boot();
    const ta = answerBox("q-22");
    ta.focus();
    fireEvent.keyDown(ta, { key: "ㅏ", code: "KeyK", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: CMD.dialog })).toBeInTheDocument();
  });

  it("한글 자판 + 조합 중이면 여전히 무시한다", async () => {
    await boot();
    const ta = answerBox("q-21");
    ta.focus();
    fireEvent.compositionStart(ta);
    fireEvent.keyDown(ta, { key: "ㅏ", code: "KeyK", ctrlKey: true, isComposing: true });
    fireEvent.keyDown(ta, { key: "ㅏ", code: "KeyK", ctrlKey: true, keyCode: 229 });
    expect(dialog()).toBeNull();
  });

  it.each([
    ["K 가 아닌 자리(KeyJ)", { key: "ㅓ", code: "KeyJ", ctrlKey: true }],
    ["Alt 가 함께", { key: "ㅏ", code: "KeyK", ctrlKey: true, altKey: true }],
    ["Ctrl/Cmd 없이 KeyK", { key: "ㅏ", code: "KeyK" }],
  ])("%s 는 열지 않는다", async (_n, init) => {
    await boot();
    fireEvent.keyDown(document.body, init);
    expect(dialog()).toBeNull();
  });
});

describe("권장 8 — 질문 맥락 메뉴 양보 규칙", () => {
  it("Shift+오른쪽 단추는 브라우저 메뉴에 양보한다 — 앱 메뉴가 열리지 않고 기본 동작도 막지 않는다", async () => {
    await boot();
    const ta = answerBox("q-21");
    const notPrevented = fireEvent.contextMenu(ta, { shiftKey: true });
    await act(async () => {});
    expect(screen.queryByRole("menu", { name: CMD.contextMenu })).toBeNull();
    expect(notPrevented, "브라우저 메뉴(붙여넣기·맞춤법)가 떠야 한다 — preventDefault 하지 않음").toBe(true);
  });

  it("Shift 없는 오른쪽 단추는 열고 기본 동작을 막는다(양보 규칙이 모든 경우를 삼키지 않는다)", async () => {
    await boot();
    const notPrevented = fireEvent.contextMenu(answerBox("q-21"));
    await screen.findByRole("menu", { name: CMD.contextMenu });
    expect(notPrevented).toBe(false);
  });

  it("Shift+오른쪽 단추 뒤에도 키보드 ContextMenu 키는 여전히 연다", async () => {
    await boot();
    fireEvent.contextMenu(answerBox("q-21"), { shiftKey: true });
    const ta = answerBox("q-22");
    ta.focus();
    fireEvent.keyDown(ta, { key: "ContextMenu" });
    expect(await screen.findByRole("menu", { name: CMD.contextMenu })).toBeInTheDocument();
  });

  it("터치 길게 누르기는 글 칸에서 글 고르기에 양보한다 — 700ms 가 지나도 앱 메뉴가 열리지 않는다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await boot();
      const ta = answerBox("q-21");
      fireEvent.pointerDown(ta, { pointerType: "touch", pointerId: 7, clientX: 10, clientY: 10, button: 0 });
      await act(() => vi.advanceTimersByTimeAsync(1500));
      expect(screen.queryByRole("menu", { name: CMD.contextMenu })).toBeNull();
      fireEvent.pointerUp(ta, { pointerType: "touch", pointerId: 7 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("대조: 글 칸이 아닌 질문 머리줄에서의 터치 길게 누르기는 맥락 메뉴를 연다(없으면 위 양보 시험이 아무것도 보장하지 않는다)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await boot();
      const head = document.getElementById("q-21-head")!;
      fireEvent.pointerDown(head, { pointerType: "touch", pointerId: 8, clientX: 10, clientY: 10, button: 0 });
      await act(() => vi.advanceTimersByTimeAsync(1500));
      expect(screen.queryByRole("menu", { name: CMD.contextMenu }), "Radix 길게 누르기가 jsdom 에서 열리는지").not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("마우스 pointerdown 은 가로채지 않는다 — 글 칸에서 마우스로 누른 뒤 오른쪽 단추는 평소처럼 열린다", async () => {
    await boot();
    const ta = answerBox("q-22");
    fireEvent.pointerDown(ta, { pointerType: "mouse", pointerId: 1, button: 0 });
    fireEvent.pointerUp(ta, { pointerType: "mouse", pointerId: 1, button: 0 });
    fireEvent.contextMenu(ta);
    expect(await screen.findByRole("menu", { name: CMD.contextMenu })).toBeInTheDocument();
  });
});

describe("맥락 메뉴 ↔ 명령 메뉴 — 같은 동작을 같은 라벨·단축키로 (정확 일치)", () => {
  it("맥락 메뉴의 (라벨, aria-keyshortcuts) 쌍은 모두 명령 메뉴에 정확히 같은 라벨로 있다", async () => {
    const { user } = await boot();
    answerBox("q-21").focus();
    fireEvent.keyDown(answerBox("q-21"), { key: "ContextMenu" });
    const ctx = await screen.findByRole("menu", { name: CMD.contextMenu });
    const clean = (el: Element) => el.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const ctxItems = within(ctx).getAllByRole("menuitem").map((el) => [clean(el), el.getAttribute("aria-keyshortcuts")] as const);
    expect(ctxItems.length).toBeGreaterThan(0);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu", { name: CMD.contextMenu })).toBeNull());
    await user.click(opener());
    const cmd = new Map(within(menu()).getAllByRole("option").map((el) => [clean(el), el.getAttribute("aria-keyshortcuts")] as const));
    for (const [label, keys] of ctxItems) {
      expect(cmd.has(label), `명령 메뉴에 정확히 같은 라벨이 없다: ${label} (있는 라벨: ${[...cmd.keys()].join(" | ")})`).toBe(true);
      expect(cmd.get(label) ?? null, `단축키 표시 ${label}`).toBe(keys);
    }
  });
});

describe("권장 7 — 메뉴가 열린 동안 동작 목록이 바뀌면 새 목록으로 (작은 화면 대역 harness)", () => {
  const act1 = (id: string, label: string, run: () => void, group: PesAction["group"] = "질문"): PesAction => ({ id, label, group, run });
  let setList: (l: PesAction[]) => void = () => {};

  function Screen({ initial }: { initial: PesAction[] }) {
    const [list, set] = React.useState(initial);
    setList = set;
    useRegisterActions(list);
    return <Opener />;
  }
  function Opener() {
    const { open } = useCommandMenu();
    return (
      <button type="button" onClick={open}>
        열기
      </button>
    );
  }
  const mount = (initial: PesAction[], strict = false) => {
    setEnv({ width: WIDTHS.wide1440 });
    const tree = (
      <CommandMenuProvider>
        <Screen initial={initial} />
      </CommandMenuProvider>
    );
    return render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree);
  };
  const labels = () => within(menu()).queryAllByRole("option").map((o) => o.textContent?.replace(/\s+/g, " ").trim());

  it("열어 둔 채 동작이 늘면 새 항목이 목록에 나타난다", async () => {
    mount([act1("a", "질문 1 미리보기", () => {})]);
    await userEvent.setup().click(screen.getByRole("button", { name: "열기" }));
    expect(labels()).toEqual(["질문 1 미리보기"]);
    act(() => setList([act1("a", "질문 1 미리보기", () => {}), act1("b", "질문 2 미리보기", () => {})]));
    await waitFor(() => expect(labels()).toEqual(["질문 1 미리보기", "질문 2 미리보기"]));
  });

  it("처음에 동작이 없어 '아직 동작이 없어요' 안내였다가, 라운드가 도착하면 목록으로 바뀐다", async () => {
    mount([]);
    await userEvent.setup().click(screen.getByRole("button", { name: "열기" }));
    expect(within(menu()).getByRole("status").textContent).toMatch(/아직 동작이 없어요/);
    expect(labels()).toEqual([]);
    act(() => setList([act1("a", "질문 1 미리보기", () => {})]));
    await waitFor(() => expect(labels()).toEqual(["질문 1 미리보기"]));
    expect(within(menu()).getByRole("status").textContent).not.toMatch(/아직 동작이 없어요/);
  });

  it("질문이 바뀌어도(같은 id·새 run) 고르면 새 run 이 실행되고 옛 run 은 실행되지 않는다", async () => {
    const oldRun = vi.fn();
    const newRun = vi.fn();
    mount([act1("peek:q-21", "질문 1 미리보기", oldRun)]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "열기" }));
    act(() => setList([act1("peek:q-21", "질문 1 미리보기", newRun)]));
    await user.click(within(menu()).getByRole("option", { name: "질문 1 미리보기" }));
    expect(newRun).toHaveBeenCalledTimes(1);
    expect(oldRun).not.toHaveBeenCalled();
  });

  it("Enter 로 고를 때도 새 run — 그리고 사라진 동작은 더 이상 고를 수 없다", async () => {
    const goneRun = vi.fn();
    const keepRun = vi.fn();
    mount([act1("gone", "사라질 동작", goneRun), act1("keep", "남는 동작", keepRun)]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "열기" }));
    act(() => setList([act1("keep", "남는 동작", keepRun)]));
    await waitFor(() => expect(labels()).toEqual(["남는 동작"]));
    await user.keyboard("{Enter}");
    expect(goneRun).not.toHaveBeenCalled();
    expect(keepRun).toHaveBeenCalledTimes(1);
  });

  it("목록이 갱신돼도 검색어와 초점은 그대로(세션을 새로 시작하지 않는다)", async () => {
    mount([act1("a", "인쇄 미리보기 열기", () => {}, "보기"), act1("b", "질문 1 미리보기", () => {})]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "열기" }));
    typeInto("미리보기");
    const input = box();
    act(() => setList([act1("a", "인쇄 미리보기 열기", () => {}, "보기"), act1("b", "질문 1 미리보기", () => {}), act1("c", "질문 2 미리보기", () => {})]));
    await waitFor(() => expect(labels()).toHaveLength(3));
    expect(box(), "같은 입력 칸").toBe(input);
    expect(box().value).toBe("미리보기");
    expect(document.activeElement).toBe(box());
  });

  it("목록이 갱신돼 강조하던 항목이 사라지면 강조는 남은 첫 항목(범위 안)으로 — Enter 가 빈 동작을 부르지 않는다", async () => {
    const run = vi.fn();
    mount([act1("a", "가 동작", () => {}), act1("b", "나 동작", () => {}), act1("c", "다 동작", run)]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "열기" }));
    await user.keyboard("{ArrowDown}{ArrowDown}"); // 다 동작
    act(() => setList([act1("c", "다 동작", run)]));
    await waitFor(() => expect(labels()).toEqual(["다 동작"]));
    await user.keyboard("{Enter}");
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("권장 5 — 열 때 세션 1회 (StrictMode 두 번 그림에도)", () => {
  // 세션 번호 자체는 화면에 보이지 않는다 → 보이는 결과로 지킨다: 한 번 열면 입력 칸이 한 번만 만들어지고(다시 만들어져 초점이 날아가지 않음),
  // 열린 채 한 번 더 열기(Ctrl+K)는 검색어·강조를 지우지 않으며, 닫았다 다시 열면 처음부터. 업데이터 순수성 경고(console.error)도 없어야 한다.
  function Screen() {
    useRegisterActions([
      { id: "a", label: "인쇄 미리보기 열기", group: "보기", run: () => {} },
      { id: "b", label: "본문으로 가기", group: "이동", run: () => {} },
    ]);
    const { open } = useCommandMenu();
    return (
      <button type="button" onClick={open}>
        열기
      </button>
    );
  }
  const mountStrict = () => {
    setEnv({ width: WIDTHS.wide1440 });
    return render(
      <React.StrictMode>
        <CommandMenuProvider>
          <Screen />
        </CommandMenuProvider>
      </React.StrictMode>,
    );
  };

  it("열 때 입력 칸 노드는 한 번만 만들어지고 초점이 검색 칸에 머문다", async () => {
    mountStrict();
    const added: Element[] = [];
    const mo = new MutationObserver((rs) => {
      for (const r of rs) r.addedNodes.forEach((n) => n instanceof Element && added.push(...(n.matches('[role="combobox"]') ? [n] : []), ...n.querySelectorAll('[role="combobox"]')));
    });
    mo.observe(document.body, { childList: true, subtree: true });
    await userEvent.setup().click(screen.getByRole("button", { name: "열기" }));
    await waitFor(() => expect(document.activeElement).toBe(box()));
    await act(async () => {});
    mo.disconnect();
    expect(added, "입력 칸 생성 횟수").toHaveLength(1);
    expect(document.activeElement).toBe(box());
  });

  it("열린 채 Ctrl+K 를 다시 눌러도 검색어·입력 칸이 그대로", async () => {
    mountStrict();
    await userEvent.setup().click(screen.getByRole("button", { name: "열기" }));
    typeInto("인쇄");
    const input = box();
    fireEvent.keyDown(input, { key: "k", ctrlKey: true });
    await act(async () => {});
    expect(box()).toBe(input);
    expect(box().value).toBe("인쇄");
  });

  it("닫았다 다시 열면 처음부터(검색어·AI 모드 초기화)", async () => {
    mountStrict();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "열기" }));
    typeInto("인쇄");
    await user.click(within(menu()).getByRole("button", { name: CMD.aiToggle }));
    expect(within(menu()).getByRole("button", { name: CMD.aiToggle })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(within(menu()).getByRole("combobox"), { key: "Escape" });
    await waitFor(() => expect(dialog()).toBeNull());
    await user.click(screen.getByRole("button", { name: "열기" }));
    expect(box().value).toBe("");
    expect(within(menu()).getByRole("button", { name: CMD.aiToggle })).toHaveAttribute("aria-pressed", "false");
  });

  it("열고 닫는 동안 React 경고(업데이터 안 부수 효과 등)가 console.error 로 나오지 않는다", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mountStrict();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "열기" }));
    fireEvent.keyDown(box(), { key: "Escape" });
    await waitFor(() => expect(dialog()).toBeNull());
    const texts = err.mock.calls.map((c) => c.map(String).join(" "));
    expect(texts.filter((t) => /update function|pure|Cannot update a component|act\(/i.test(t))).toEqual([]);
  });
});

describe("회귀 — 쿼리·화면 이동은 조합 중 Esc 에 영향받지 않는다", () => {
  it("조합 중 Esc 뒤에도 주소(peek·print)는 그대로", async () => {
    const { user, router } = await boot();
    await user.click(opener());
    fireEvent.compositionStart(box());
    fireEvent.keyDown(box(), { key: "Escape", isComposing: true });
    await act(async () => {});
    expect(query(router).get("print")).toBeNull();
    expect(query(router).get("peek")).toBeNull();
    expect(screen.queryByRole("dialog", { name: NAMES.peek })).toBeNull();
  });
});

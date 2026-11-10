import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { mockSettings } from "@/lib/mock-settings";
import { aiSheet, answersSent, researchUi } from "@/lib/research-ui";
import { renderRoutes, setViewport, workspaceRoutes } from "@/test/render-app";
import { renderQuestionPanel, synthQuestion } from "@/test/render-question-panel";

/**
 * UI7-4a 보강 — 1차 리뷰 반영(c23fce5) 회귀 시험과 깨뜨리기 시험. 합성 자료만.
 * 실제 화면 자료: dolbom-insight 조사 R2 (Q-21 선택지 4 · Q-22 선택지 3). 합성: 선택지 5·6개 카드.
 */

const ANSWER = "/p/dolbom-insight/e/1/s/research/r/2?t=answer";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  mockSettings.reset();
  researchUi.set({ focus: false, jk: true, aiPanel: true, aiOnRound: false });
  aiSheet.set({ open: false, target: null });
  answersSent.set(null);
  setViewport(1440);
});

async function openAnswerStage() {
  await renderRoutes(await workspaceRoutes(), ANSWER);
  await screen.findByRole("heading", { name: /조사 대상에 방문간호 인력도 포함할까요/ }, { timeout: 4000 });
}

function card(id: string) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`질문 카드 ${id} 없음`);
  return el;
}

function focusInside(id: string) {
  const btn = within(card(id)).getByRole("button", { name: /의견 남기기/ });
  btn.focus();
  return btn;
}

function draftOf(questionId: string): { option?: string; usedDefault?: boolean } | null {
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i) ?? "";
    if (k.startsWith("pes-draft:dolbom-insight:") && k.includes(`:${questionId}:`)) return JSON.parse(sessionStorage.getItem(k) ?? "null");
  }
  return null;
}

const pressDigit = (el: Element, n: number, init: KeyboardEventInit = {}) => fireEvent.keyDown(el, { code: `Digit${n}`, key: "Unidentified", ...init });
const pressSend = (el: Element | Window, init: KeyboardEventInit = {}) => fireEvent.keyDown(el, { code: "Enter", key: "Enter", metaKey: true, ...init });
const reviewDialog = () => screen.queryByRole("dialog", { name: /답 검토 후 보내기/ });

/** “보낼 답이 없습니다” 안내가 화면에 있는가 */
const noAnswersLine = () => screen.queryByText(/보낼 답이 없습니다/);

describe("[보강] ① ‘보낼 답이 없습니다’ 안내는 답을 고르면 사라진다", () => {
  it("안내가 뜬 뒤 키보드로 선택지를 고르면 안내가 사라진다", async () => {
    await openAnswerStage();
    pressSend(focusInside("q-21"));
    await screen.findByText(/보낼 답이 없습니다/);
    pressDigit(focusInside("q-21"), 1);
    await waitFor(() => expect(draftOf("q-21")?.option).toBe("a"));
    await waitFor(() => expect(noAnswersLine()).not.toBeInTheDocument());
  });

  it("안내가 뜬 뒤 마우스로 선택지를 골라도 사라진다", async () => {
    await openAnswerStage();
    pressSend(focusInside("q-21"));
    await screen.findByText(/보낼 답이 없습니다/);
    fireEvent.click(within(card("q-21")).getByRole("radio", { name: /^제외/ }));
    await waitFor(() => expect(draftOf("q-21")?.option).toBe("b"));
    await waitFor(() => expect(noAnswersLine()).not.toBeInTheDocument());
  });

  it("안내가 뜬 뒤 글(의견)로 답해도 사라진다", async () => {
    await openAnswerStage();
    pressSend(focusInside("q-22"));
    await screen.findByText(/보낼 답이 없습니다/);
    fireEvent.click(within(card("q-22")).getByRole("button", { name: /의견 남기기/ }));
    const box = await within(card("q-22")).findByRole("textbox");
    fireEvent.change(box, { target: { value: "메모" } });
    await waitFor(() => expect(noAnswersLine()).not.toBeInTheDocument());
  });

  it("안내가 뜬 뒤 ‘답 검토 후 보내기’ 단추를 누르면 대화 상자가 열리고 안내는 사라진다", async () => {
    await openAnswerStage();
    pressSend(focusInside("q-21"));
    await screen.findByText(/보낼 답이 없습니다/);
    fireEvent.click(screen.getByRole("button", { name: "답 검토 후 보내기" }));
    await screen.findByRole("dialog", { name: /답 검토 후 보내기/ });
    expect(noAnswersLine()).not.toBeInTheDocument();
  });

  it("안내가 뜬 뒤 답을 고르고 다시 ⌘+Enter 하면 안내 없이 대화 상자가 열린다", async () => {
    await openAnswerStage();
    pressSend(focusInside("q-21"));
    await screen.findByText(/보낼 답이 없습니다/);
    pressDigit(focusInside("q-21"), 2);
    await waitFor(() => expect(draftOf("q-21")?.option).toBe("b"));
    pressSend(focusInside("q-21"));
    await screen.findByRole("dialog", { name: /답 검토 후 보내기/ });
    expect(noAnswersLine()).not.toBeInTheDocument();
  });

  it("답이 계속 없으면 ⌘+Enter를 거듭 눌러도 안내 한 줄뿐이다", async () => {
    await openAnswerStage();
    pressSend(focusInside("q-21"));
    pressSend(focusInside("q-21"));
    await screen.findByText(/보낼 답이 없습니다/);
    expect(screen.getAllByText(/보낼 답이 없습니다/)).toHaveLength(1);
    expect(reviewDialog()).not.toBeInTheDocument();
  });
});

describe("[보강] ② 안내는 role=status 상시 영역 — 탭과 상관없이 보인다", () => {
  it("안내가 없을 때도 비어 있는 role=status 영역이 이미 있다(생길 때 처음 읽히게)", async () => {
    await openAnswerStage();
    const statuses = screen.getAllByRole("status");
    expect(statuses.some((s) => (s.textContent ?? "").trim() === "")).toBe(true);
  });

  it("안내가 뜨면 같은 role=status 요소의 글만 바뀐다(요소를 새로 만들지 않음)", async () => {
    await openAnswerStage();
    const empties = screen.getAllByRole("status").filter((s) => (s.textContent ?? "").trim() === "");
    expect(empties.length).toBeGreaterThan(0);
    pressSend(focusInside("q-21"));
    const line = await screen.findByText(/보낼 답이 없습니다/);
    const host = line.closest("[role='status']") as HTMLElement;
    expect(host).not.toBeNull();
    expect(empties).toContain(host);
    // 사라진 뒤에도 같은 요소가 남아 있다
    pressDigit(focusInside("q-21"), 1);
    await waitFor(() => expect(noAnswersLine()).not.toBeInTheDocument());
    expect(host.isConnected).toBe(true);
    expect((host.textContent ?? "").trim()).toBe("");
  });

  it("‘AI에게 묻는 질문’ 탭을 보고 있어도 안내가 보인다", async () => {
    await openAnswerStage();
    const tab = screen.getByRole("tab", { name: /AI에게 묻는 질문/ });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    await waitFor(() => expect(tab).toHaveAttribute("aria-selected", "true"));
    pressSend(tab);
    const line = await screen.findByText(/보낼 답이 없습니다/);
    expect(line.closest("[role='status']")).not.toBeNull();
    expect(line).toBeVisible();
    expect(reviewDialog()).not.toBeInTheDocument();
  });
});

describe("[보강] ③ 수식 키가 붙으면 1~4와 J/K를 무시한다", () => {
  it("Shift+1은 무시한다(대조: 맨 키는 된다)", async () => {
    await openAnswerStage();
    const from = focusInside("q-21");
    pressDigit(from, 1, { shiftKey: true });
    expect(draftOf("q-21")).toBeNull();
    pressDigit(from, 1);
    await waitFor(() => expect(draftOf("q-21")?.option).toBe("a"));
  });

  it("Alt+1 · Ctrl+1 · ⌘+1도 무시한다(브라우저 탭 바꾸기 키를 가로채지 않음)", async () => {
    await openAnswerStage();
    const from = focusInside("q-21");
    for (const init of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true, altKey: true }]) {
      const notPrevented = pressDigit(from, 1, init);
      expect(notPrevented).toBe(true); // preventDefault 하지 않음
    }
    expect(draftOf("q-21")).toBeNull();
    pressDigit(from, 1);
    await waitFor(() => expect(draftOf("q-21")?.option).toBe("a"));
  });

  it("처리된 맨 1 키는 기본 동작을 막고, 무시된 키는 막지 않는다", async () => {
    await openAnswerStage();
    const from = focusInside("q-21");
    expect(pressDigit(from, 1, { shiftKey: true })).toBe(true);
    expect(pressDigit(from, 1)).toBe(false);
  });

  it("Digit0 · Digit5 · Digit9와 숫자패드(Numpad1)는 무시한다", async () => {
    await openAnswerStage();
    const from = focusInside("q-21");
    for (const code of ["Digit0", "Digit5", "Digit9", "Numpad1", "KeyA", "Enter"]) {
      fireEvent.keyDown(from, { code, key: "1" });
    }
    expect(draftOf("q-21")).toBeNull();
  });

  it("J/K는 Shift·Alt가 붙으면 무시한다(대조: 맨 키는 처리)", async () => {
    researchUi.set({ focus: true });
    await openAnswerStage();
    const from = focusInside("q-21");
    const press = (code: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(from, { code, key: code === "KeyJ" ? "j" : "k", ...init });
    for (const code of ["KeyJ", "KeyK"]) {
      expect(press(code, { shiftKey: true })).toBe(true);
      expect(press(code, { altKey: true })).toBe(true);
      expect(press(code, { ctrlKey: true })).toBe(true);
      expect(press(code, { metaKey: true })).toBe(true);
      expect(press(code)).toBe(false);
    }
  });

  it("⌘/Ctrl+Enter에 Alt가 더 붙으면 열지 않는다", async () => {
    await openAnswerStage();
    fireEvent.click(within(card("q-21")).getByRole("radio", { name: /^제외/ }));
    await waitFor(() => expect(draftOf("q-21")?.option).toBe("b"));
    const from = focusInside("q-21");
    pressSend(from, { altKey: true });
    pressSend(from, { metaKey: false }); // 수식 키 없는 Enter
    pressSend(from, { metaKey: false, shiftKey: true }); // Shift+Enter
    expect(reviewDialog()).not.toBeInTheDocument();
    pressSend(from);
    await screen.findByRole("dialog", { name: /답 검토 후 보내기/ });
  });
});

describe("[보강] ④ 선택지 5개 이상 — 5번째부터는 배지·aria-keyshortcuts·키 모두 없음", () => {
  const rows = () => [synthQuestion("q-s1", 5), synthQuestion("q-s2", 6)];
  const labelText = (id: string, o: number) => document.querySelector(`label[for='${id}-o${o}']`)?.textContent?.trim() ?? "";

  it("5번째 선택지에 숫자 배지가 없고 1~4번에만 있다", async () => {
    await renderQuestionPanel(rows());
    for (const o of [1, 2, 3, 4]) expect(labelText("q-s1", o).charAt(0)).toBe(String(o));
    expect(labelText("q-s1", 5)).toMatch(/^선택지 5번/);
    expect(labelText("q-s2", 5)).toMatch(/^선택지 5번/);
    expect(labelText("q-s2", 6)).toMatch(/^선택지 6번/);
  });

  it("aria-keyshortcuts는 1~4번 선택지에만 붙고 5번째부터는 없다", async () => {
    await renderQuestionPanel(rows());
    const values = (id: string) => [...document.getElementById(id)!.querySelectorAll("[role='radio']")].map((e) => e.getAttribute("aria-keyshortcuts"));
    expect(values("q-s1")).toEqual(["1", "2", "3", "4", null]);
    expect(values("q-s2")).toEqual(["1", "2", "3", "4", null, null]);
  });

  it("5번 키는 5번째 선택지를 고르지 않고, 1~4는 여전히 된다", async () => {
    await renderQuestionPanel(rows());
    const el = document.getElementById("q-s1")!;
    const from = within(el).getByRole("button", { name: /의견 남기기/ });
    from.focus();
    expect(pressDigit(from, 5)).toBe(true);
    expect(within(el).queryAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(0);
    expect(pressDigit(from, 4)).toBe(false);
    await waitFor(() => expect(within(el).getByRole("radio", { name: /선택지 4번/ })).toHaveAttribute("aria-checked", "true"));
  });

  it("끄기를 켜면 5개 카드에서도 배지·aria-keyshortcuts가 모두 없다", async () => {
    researchUi.set({ jk: false });
    await renderQuestionPanel(rows());
    expect(document.querySelectorAll("[role='radio'][aria-keyshortcuts]")).toHaveLength(0);
    for (const o of [1, 2, 3, 4, 5]) expect(labelText("q-s1", o)).toMatch(/^선택지/);
  });
});

describe("[보강] ⑤ 명령 메뉴 도움말 — 끄기 표시", () => {
  async function openMenu() {
    const { CommandMenu } = await import("@/app/CommandMenu");
    await renderRoutes([{ path: "*", element: <CommandMenu open onOpenChange={() => {}} /> }], "/");
    return screen.findByRole("dialog");
  }

  it("켜짐일 때는 ‘(꺼짐)’이 없다", async () => {
    const dialog = await openMenu();
    expect(dialog.textContent).toMatch(/선택지 고르기/);
    expect(dialog.textContent).not.toMatch(/꺼짐/);
  });

  it("한 글자 단축키 끄기가 켜지면 ‘1~4 선택지 고르기’ 줄에 ‘(꺼짐)’이 붙는다", async () => {
    researchUi.set({ jk: false });
    const dialog = await openMenu();
    const line = [...dialog.querySelectorAll("p")].find((p) => /선택지 고르기/.test(p.textContent ?? ""));
    expect(line?.textContent).toMatch(/선택지 고르기\s*\(꺼짐\)/);
    // ⌘/Ctrl+Enter 줄은 끄기와 무관하다
    const send = [...dialog.querySelectorAll("p")].find((p) => /답 검토 후 보내기/.test(p.textContent ?? ""));
    expect(send?.textContent).not.toMatch(/꺼짐/);
  });

  it("메뉴가 열린 채로 끄기를 바꾸면 도움말이 따라 바뀐다", async () => {
    const dialog = await openMenu();
    expect(dialog.textContent).not.toMatch(/꺼짐/);
    researchUi.set({ jk: false });
    await waitFor(() => expect(dialog.textContent).toMatch(/\(꺼짐\)/));
    researchUi.set({ jk: true });
    await waitFor(() => expect(dialog.textContent).not.toMatch(/\(꺼짐\)/));
  });
});

describe("[보강] 키 처리기 등록·해제 — 깨뜨리기", () => {
  it("화면을 떠난 뒤에는 ⌘+Enter가 대화 상자를 열지 않는다(window 처리기 해제)", async () => {
    const view = await renderQuestionPanel([synthQuestion("q-s1", 3)]);
    const el = document.getElementById("q-s1")!;
    fireEvent.click(within(el).getByRole("radio", { name: /선택지 1번/ }));
    await waitFor(() => expect(sessionStorage.length).toBeGreaterThan(0));
    // 대조: 떠나기 전에는 처리된다(기본 동작을 막음)
    expect(pressSend(window)).toBe(false);
    await screen.findByRole("dialog", { name: /답 검토 후 보내기/ });
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    await waitFor(() => expect(reviewDialog()).not.toBeInTheDocument());
    view.unmount();
    // 해제 안 된 처리기가 남아 있으면 preventDefault 로 키를 삼킨다
    expect(pressSend(window)).toBe(true);
    expect(pressSend(document.body)).toBe(true);
    expect(reviewDialog()).not.toBeInTheDocument();
  });

  it("역할이 소유자에서 읽기 전용으로 바뀌면 옛 처리기가 남아 1~4를 받지 않는다(카드 처리기 해제)", async () => {
    await openAnswerStage();
    const from = focusInside("q-21");
    expect(pressDigit(from, 1)).toBe(false);
    await waitFor(() => expect(draftOf("q-21")?.option).toBe("a"));
    mockSettings.set({ role: "reader" });
    await waitFor(() => expect(within(card("q-21")).queryAllByRole("radio")).toHaveLength(0));
    sessionStorage.clear();
    expect(pressDigit(card("q-21"), 2)).toBe(true);
    expect(draftOf("q-21")).toBeNull();
  });

  it("다시 그려도 처리기가 겹치지 않는다 — 1 키 한 번에 선택 한 번, ⌘+Enter 한 번에 대화 상자 하나", async () => {
    await openAnswerStage();
    const from = focusInside("q-21");
    for (let i = 0; i < 3; i++) {
      pressDigit(from, 1);
      pressDigit(from, 2);
    }
    await waitFor(() => expect(draftOf("q-21")?.option).toBe("b"));
    pressSend(from);
    await screen.findByRole("dialog", { name: /답 검토 후 보내기/ });
    expect(screen.getAllByRole("dialog", { name: /답 검토 후 보내기/ })).toHaveLength(1);
  });

  it("카드는 다른 카드의 키를 받지 않는다 — 한 카드 키 한 번에 초안은 그 카드만 바뀐다", async () => {
    await openAnswerStage();
    pressDigit(focusInside("q-22"), 3);
    await waitFor(() => expect(draftOf("q-22")?.option).toBe("c"));
    expect(draftOf("q-21")).toBeNull();
  });

  it("끄기는 누르는 때 읽는다 — 그린 뒤에 끄고 켜도 곧바로 따른다", async () => {
    await openAnswerStage();
    const from = focusInside("q-21");
    researchUi.set({ jk: false });
    pressDigit(from, 1);
    expect(draftOf("q-21")).toBeNull();
    researchUi.set({ jk: true });
    pressDigit(from, 1);
    await waitFor(() => expect(draftOf("q-21")?.option).toBe("a"));
    researchUi.set({ jk: false });
    pressDigit(from, 2);
    expect(draftOf("q-21")?.option).toBe("a");
  });

  it("열린 메뉴(role=menu)나 목록 상자가 있어도 무시한다", async () => {
    await openAnswerStage();
    const from = focusInside("q-21");
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.setAttribute("data-state", "open");
    document.body.appendChild(menu);
    try {
      pressDigit(from, 1);
      expect(draftOf("q-21")).toBeNull();
      pressSend(from);
      expect(reviewDialog()).not.toBeInTheDocument();
      expect(noAnswersLine()).not.toBeInTheDocument();
    } finally {
      menu.remove();
    }
    pressDigit(from, 1);
    await waitFor(() => expect(draftOf("q-21")?.option).toBe("a"));
  });

  it("select · combobox 같은 입력 요소 안에서도 숫자는 무시한다", async () => {
    await openAnswerStage();
    const inner = document.createElement("input");
    card("q-21").appendChild(inner);
    try {
      inner.focus();
      pressDigit(inner, 1);
      expect(draftOf("q-21")).toBeNull();
    } finally {
      inner.remove();
    }
  });
});

describe("[보강] 바로 보내기 없음", () => {
  it("⌘+Enter를 여러 번 눌러도 대화 상자에서 확인하기 전에는 보내지 않는다", async () => {
    await openAnswerStage();
    pressDigit(focusInside("q-21"), 1);
    await waitFor(() => expect(draftOf("q-21")?.option).toBe("a"));
    pressSend(focusInside("q-21"));
    const dialog = await screen.findByRole("dialog", { name: /답 검토 후 보내기/ });
    pressSend(dialog);
    pressSend(document.body);
    pressSend(window);
    expect(answersSent.get()).toBeNull();
    expect(within(dialog).queryByText(/접수 번호/)).not.toBeInTheDocument();
    // 초안은 그대로 남아 있다
    expect(draftOf("q-21")?.option).toBe("a");
  });

  it("대화 상자를 닫으면(취소) 보내지 않고 초안이 남는다", async () => {
    await openAnswerStage();
    pressDigit(focusInside("q-21"), 3);
    await waitFor(() => expect(draftOf("q-21")?.option).toBe("c"));
    pressSend(focusInside("q-21"));
    await screen.findByRole("dialog", { name: /답 검토 후 보내기/ });
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    await waitFor(() => expect(reviewDialog()).not.toBeInTheDocument());
    expect(answersSent.get()).toBeNull();
    expect(draftOf("q-21")?.option).toBe("c");
  });

  it("‘답 검토 후 보내기’ 단추에 단축키 표시(aria-keyshortcuts)가 끄기와 상관없이 남는다", async () => {
    researchUi.set({ jk: false });
    await openAnswerStage();
    expect(screen.getByRole("button", { name: "답 검토 후 보내기" })).toHaveAttribute("aria-keyshortcuts", "Meta+Enter Control+Enter");
  });
});

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { mockSettings } from "@/lib/mock-settings";
import { aiSheet, answersSent, researchUi } from "@/lib/research-ui";
import { renderRoutes, setViewport, workspaceRoutes } from "@/test/render-app";

/**
 * UI7-4a 단축키 (설계 18.10 · 3.9 · 16.5) — 합성 자료(dolbom-insight 조사 R2)만 쓴다.
 * 질문: Q-21(선택지 4 · 기본값 c) · Q-22(선택지 3 · 기본값 없음) · Q-23(이미 보냄).
 * [새 요구] = 구현 전에는 실패해야 정상 · [회귀] = 지금 있는 동작이라 계속 통과해야 함.
 */

const ROUND = "/p/dolbom-insight/e/1/s/research/r/2";
const ANSWER = `${ROUND}?t=answer`;

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

function radio(id: string, name: RegExp) {
  return within(card(id)).getByRole("radio", { name });
}

/** 카드의 선택지(radio) 중 골라진 것의 이름들 */
function checkedNames(id: string) {
  return within(card(id))
    .queryAllByRole("radio")
    .filter((r) => r.getAttribute("aria-checked") === "true")
    .map((r) => r.getAttribute("aria-label") ?? document.querySelector(`label[for='${r.id}']`)?.textContent ?? "");
}

/** 이 탭에 남은 그 질문의 초안(sessionStorage) */
function draftOf(questionId: string): { option?: string; usedDefault?: boolean } | null {
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i) ?? "";
    if (k.startsWith("pes-draft:dolbom-insight:") && k.includes(`:${questionId}:`)) return JSON.parse(sessionStorage.getItem(k) ?? "null");
  }
  return null;
}

/** 한글 자판에서도 같은 자리를 쓰는지 보려고 key는 일부러 숫자가 아닌 값을 준다 */
function pressDigit(el: Element, n: number, init: KeyboardEventInit = {}) {
  return fireEvent.keyDown(el, { code: `Digit${n}`, key: "Unidentified", ...init });
}

function pressSend(el: Element, init: KeyboardEventInit = {}) {
  return fireEvent.keyDown(el, { code: "Enter", key: "Enter", metaKey: true, ...init });
}

function reviewDialog() {
  return screen.queryByRole("dialog", { name: /답 검토 후 보내기/ });
}

/** 비입력 요소에 초점을 둔다 — 카드 안의 “의견 남기기” 단추 */
function focusInside(id: string) {
  const btn = within(card(id)).getByRole("button", { name: /의견 남기기/ });
  btn.focus();
  return btn;
}

describe("[새 요구] 1~4 — 그 카드의 n번째 선택지", () => {
  it("카드 안 비입력 요소에서 1을 누르면 첫 선택지가 골라진다", async () => {
    await openAnswerStage();
    const from = focusInside("q-21");
    pressDigit(from, 1);
    await waitFor(() => expect(radio("q-21", /^포함/)).toHaveAttribute("aria-checked", "true"));
    expect(draftOf("q-21")?.option).toBe("a");
    expect(draftOf("q-21")?.usedDefault).toBeFalsy();
  });

  it("카드 자체(초점 가능한 article)에서도 동작하고 눌린 카드의 것만 바뀐다", async () => {
    await openAnswerStage();
    const q22 = card("q-22");
    q22.focus();
    pressDigit(q22, 2);
    await waitFor(() => expect(radio("q-22", /광역시 1곳/)).toHaveAttribute("aria-checked", "true"));
    expect(checkedNames("q-21")).toEqual([]);
  });

  it("기본값 줄(Q-21의 3번)을 누르면 기본값 사용으로 기록된다", async () => {
    await openAnswerStage();
    pressDigit(focusInside("q-21"), 3);
    await waitFor(() => expect(radio("q-21", /사례 지역 2곳만/)).toHaveAttribute("aria-checked", "true"));
    expect(draftOf("q-21")).toMatchObject({ option: "c", usedDefault: true });
  });

  it("4번 선택지(기타)도 고른다", async () => {
    await openAnswerStage();
    pressDigit(focusInside("q-21"), 4);
    await waitFor(() => expect(radio("q-21", /기타/)).toHaveAttribute("aria-checked", "true"));
  });

  it("선택지가 3개인 카드에서 4는 아무 일도 없다", async () => {
    await openAnswerStage();
    pressDigit(focusInside("q-22"), 4);
    // 같은 키 처리가 끝난 뒤에도 바뀐 것이 없다 — 먼저 1이 되는 것을 보고(키가 연결됨), 4가 그것을 바꾸지 않음을 본다
    pressDigit(focusInside("q-22"), 1);
    await waitFor(() => expect(radio("q-22", /6곳으로 늘림/)).toHaveAttribute("aria-checked", "true"));
    pressDigit(focusInside("q-22"), 4);
    expect(checkedNames("q-22")).toHaveLength(1);
    expect(radio("q-22", /6곳으로 늘림/)).toHaveAttribute("aria-checked", "true");
  });

  it("한글 자판(key가 숫자가 아님)에서도 event.code Digit1~4로 판정한다", async () => {
    await openAnswerStage();
    pressDigit(focusInside("q-21"), 2, { key: "ㅁ" });
    await waitFor(() => expect(radio("q-21", /제외/)).toHaveAttribute("aria-checked", "true"));
  });

  it("카드 밖(초점이 body)에서는 아무 일도 없다", async () => {
    await openAnswerStage();
    (document.activeElement as HTMLElement | null)?.blur();
    pressDigit(document.body, 1);
    // 카드 안 1을 한 번 눌러 키가 연결됐음을 보인 뒤, 밖의 키는 다른 카드를 바꾸지 않음
    pressDigit(focusInside("q-21"), 1);
    await waitFor(() => expect(draftOf("q-21")?.option).toBe("a"));
    expect(draftOf("q-22")).toBeNull();
  });
});

describe("[새 요구] 1~4 — 무시하는 때", () => {
  // 무시 시험은 “키가 연결돼 있다”는 대조(마지막 줄)까지 해야 구현 전에 거짓 통과하지 않는다.
  async function expectIgnoredThenWorks(act: () => void) {
    await openAnswerStage();
    act();
    expect(draftOf("q-21")).toBeNull();
    expect(checkedNames("q-21")).toEqual([]);
    return;
  }

  it("글 상자(의견) 안에서 숫자를 쳐도 선택이 바뀌지 않는다", async () => {
    await openAnswerStage();
    fireEvent.click(within(card("q-21")).getByRole("button", { name: /의견 남기기/ }));
    const box = await within(card("q-21")).findByRole("textbox");
    box.focus();
    pressDigit(box, 2);
    expect(draftOf("q-21")).toBeNull();
    // 대조: 같은 카드의 비입력 요소에서는 된다
    pressDigit(focusInside("q-21"), 2);
    await waitFor(() => expect(radio("q-21", /제외/)).toHaveAttribute("aria-checked", "true"));
  });

  it("한글 조합 중(isComposing)에는 무시한다", async () => {
    await openAnswerStage();
    const from = focusInside("q-21");
    pressDigit(from, 1, { isComposing: true });
    expect(draftOf("q-21")).toBeNull();
    pressDigit(from, 1);
    await waitFor(() => expect(draftOf("q-21")?.option).toBe("a"));
  });

  it("‘답 검토 후 보내기’ 대화 상자가 열려 있으면 무시한다", async () => {
    await openAnswerStage();
    fireEvent.click(screen.getByRole("button", { name: "답 검토 후 보내기" }));
    await screen.findByRole("dialog", { name: /답 검토 후 보내기/ });
    pressDigit(card("q-21"), 1);
    expect(draftOf("q-21")).toBeNull();
    // 대조: 닫으면 된다
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    await waitFor(() => expect(reviewDialog()).not.toBeInTheDocument());
    pressDigit(focusInside("q-21"), 1);
    await waitFor(() => expect(draftOf("q-21")?.option).toBe("a"));
  });

  it("한 글자 단축키 끄기를 켜면 무시한다", async () => {
    researchUi.set({ jk: false });
    await expectIgnoredThenWorks(() => pressDigit(focusInside("q-21"), 1));
    researchUi.set({ jk: true });
    pressDigit(focusInside("q-21"), 1);
    await waitFor(() => expect(draftOf("q-21")?.option).toBe("a"));
  });

  it("읽기 전용 역할에서는 아무 일도 없다", async () => {
    mockSettings.set({ role: "reader" });
    await openAnswerStage();
    expect(within(card("q-21")).queryAllByRole("radio")).toHaveLength(0);
    pressDigit(card("q-21"), 1);
    expect(draftOf("q-21")).toBeNull();
    // 대조: 소유자로 돌아가면 된다
    mockSettings.set({ role: "owner" });
    await waitFor(() => expect(within(card("q-21")).queryAllByRole("radio").length).toBeGreaterThan(0));
    pressDigit(focusInside("q-21"), 1);
    await waitFor(() => expect(draftOf("q-21")?.option).toBe("a"));
  });
});

describe("[새 요구] ⌘/Ctrl+Enter — 검토 대화 상자 열기", () => {
  async function pickOne() {
    fireEvent.click(radio("q-21", /^제외/));
    await waitFor(() => expect(draftOf("q-21")?.option).toBe("b"));
  }

  it("⌘+Enter는 ‘답 검토 후 보내기’ 대화 상자를 열고, 바로 보내지는 않는다", async () => {
    await openAnswerStage();
    await pickOne();
    pressSend(focusInside("q-21"));
    const dialog = await screen.findByRole("dialog", { name: /답 검토 후 보내기/ });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).queryByText(/접수 번호/)).not.toBeInTheDocument();
    expect(answersSent.get()).toBeNull();
  });

  it("Ctrl+Enter도 같다", async () => {
    await openAnswerStage();
    await pickOne();
    pressSend(focusInside("q-21"), { metaKey: false, ctrlKey: true });
    await screen.findByRole("dialog", { name: /답 검토 후 보내기/ });
  });

  it("답을 쓰는 중(글 상자 안)에도 열린다", async () => {
    await openAnswerStage();
    await pickOne();
    fireEvent.click(within(card("q-21")).getByRole("button", { name: /의견 남기기/ }));
    const box = await within(card("q-21")).findByRole("textbox");
    box.focus();
    fireEvent.change(box, { target: { value: "메모" } });
    pressSend(box);
    await screen.findByRole("dialog", { name: /답 검토 후 보내기/ });
  });

  it("한글 조합 중(isComposing)에는 열지 않는다", async () => {
    await openAnswerStage();
    await pickOne();
    const from = focusInside("q-21");
    pressSend(from, { isComposing: true });
    expect(reviewDialog()).not.toBeInTheDocument();
    // 대조
    pressSend(from);
    await screen.findByRole("dialog", { name: /답 검토 후 보내기/ });
  });

  it("이미 대화 상자가 열려 있으면 두 번째 대화 상자를 만들지 않는다", async () => {
    await openAnswerStage();
    await pickOne();
    pressSend(focusInside("q-21"));
    await screen.findByRole("dialog", { name: /답 검토 후 보내기/ });
    pressSend(card("q-21"));
    pressSend(document.body);
    expect(screen.getAllByRole("dialog", { name: /답 검토 후 보내기/ })).toHaveLength(1);
  });

  it("보낼 답이 0개면 대화 상자 대신 ‘보낼 답이 없습니다’ 상태 한 줄", async () => {
    await openAnswerStage();
    pressSend(focusInside("q-21"));
    const line = await screen.findByText(/보낼 답이 없습니다/);
    expect(reviewDialog()).not.toBeInTheDocument();
    expect(line.closest("[role='status'], [role='alert']")).not.toBeNull();
  });

  it("읽기 전용 역할에서도 대화 상자는 열리지 않는다(보낼 수 없음)", async () => {
    mockSettings.set({ role: "reader" });
    await openAnswerStage();
    pressSend(card("q-21"));
    expect(reviewDialog()).not.toBeInTheDocument();
  });
});

describe("[새 요구] 표시", () => {
  it("선택지 앞에 숫자 배지가 있다(1부터)", async () => {
    await openAnswerStage();
    const labels = ["a", "b", "c", "d"].map((o) => document.querySelector(`label[for='q-21-${o}']`)?.textContent ?? "");
    expect(labels.map((t) => t.trim().charAt(0))).toEqual(["1", "2", "3", "4"]);
    expect(document.querySelector("label[for='q-22-c']")?.textContent?.trim().charAt(0)).toBe("3");
  });

  it("선택지마다 aria-keyshortcuts가 1~4로 붙는다(카드의 선택지 수만큼)", async () => {
    await openAnswerStage();
    const values = (id: string) => [...card(id).querySelectorAll("[aria-keyshortcuts]")].map((e) => e.getAttribute("aria-keyshortcuts"));
    expect(values("q-21")).toEqual(["1", "2", "3", "4"]);
    expect(values("q-22")).toEqual(["1", "2", "3"]);
  });

  it("보내기 단추에 aria-keyshortcuts=\"Meta+Enter Control+Enter\"", async () => {
    await openAnswerStage();
    expect(screen.getByRole("button", { name: "답 검토 후 보내기" })).toHaveAttribute("aria-keyshortcuts", "Meta+Enter Control+Enter");
  });

  it("끄기를 켜면 숫자 배지와 선택지 aria-keyshortcuts가 사라진다(보내기 단추 것은 남음)", async () => {
    researchUi.set({ jk: false });
    await openAnswerStage();
    const labels = ["a", "b", "c", "d"].map((o) => document.querySelector(`label[for='q-21-${o}']`)?.textContent ?? "");
    expect(labels.some((t) => /^\s*[1-4]/.test(t))).toBe(false);
    expect(card("q-21").querySelectorAll("[aria-keyshortcuts]")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "답 검토 후 보내기" })).toHaveAttribute("aria-keyshortcuts", "Meta+Enter Control+Enter");
  });
});

describe("[새 요구] 끄기 스위치 하나가 J/K와 1~4를 함께 끈다", () => {
  it("집중 모드에서 스위치를 끄면 1~4도 멈추고, 켜면 다시 된다(⌘+Enter는 끄기와 무관)", async () => {
    researchUi.set({ focus: true });
    await openAnswerStage();
    const sw = await screen.findByRole("switch", { name: /단축키/ });
    expect(sw).toBeChecked();
    fireEvent.click(sw);
    await waitFor(() => expect(researchUi.get().jk).toBe(false));
    pressDigit(focusInside("q-21"), 1);
    expect(draftOf("q-21")).toBeNull();
    // 수식 키 조합은 끄기 대상이 아님 — 답이 없어도 ‘보낼 답이 없습니다’가 보여 키가 살아 있음을 안다
    pressSend(focusInside("q-21"));
    await screen.findByText(/보낼 답이 없습니다/);
    fireEvent.click(screen.getByRole("switch", { name: /단축키/ }));
    await waitFor(() => expect(researchUi.get().jk).toBe(true));
    pressDigit(focusInside("q-21"), 1);
    await waitFor(() => expect(draftOf("q-21")?.option).toBe("a"));
  });

  it("끄기를 켜도 ⌘+Enter는 대화 상자를 연다", async () => {
    researchUi.set({ jk: false });
    await openAnswerStage();
    fireEvent.click(radio("q-21", /^제외/));
    await waitFor(() => expect(draftOf("q-21")?.option).toBe("b"));
    pressSend(focusInside("q-21"));
    await screen.findByRole("dialog", { name: /답 검토 후 보내기/ });
  });
});

describe("[회귀] 지금 있는 J/K · 끄기", () => {
  const pressKey = (el: Element | Window, code: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(el, { code, key: code === "KeyJ" ? "j" : "k", ...init });

  it("집중 모드 + 켜짐: 입력 밖의 J/K는 처리된다(기본 동작을 막음)", async () => {
    researchUi.set({ focus: true });
    await openAnswerStage();
    expect(pressKey(focusInside("q-21"), "KeyJ")).toBe(false);
    expect(pressKey(focusInside("q-21"), "KeyK")).toBe(false);
  });

  it("한글 자판(key가 ㅓ)에서도 같은 자리 KeyJ로 처리된다", async () => {
    researchUi.set({ focus: true });
    await openAnswerStage();
    expect(fireEvent.keyDown(focusInside("q-21"), { code: "KeyJ", key: "ㅓ" })).toBe(false);
  });

  it("끄기를 켜면 J/K는 무시된다", async () => {
    researchUi.set({ focus: true, jk: false });
    await openAnswerStage();
    expect(pressKey(focusInside("q-21"), "KeyJ")).toBe(true);
    expect(screen.getByText("한 글자 단축키 꺼짐")).toBeInTheDocument();
  });

  it("집중 모드가 아니면 J/K는 무시된다", async () => {
    await openAnswerStage();
    expect(pressKey(focusInside("q-21"), "KeyJ")).toBe(true);
  });

  it("글 상자 안 · 한글 조합 중 · 대화 상자 열림에서는 무시된다", async () => {
    researchUi.set({ focus: true });
    await openAnswerStage();
    fireEvent.click(within(card("q-21")).getByRole("button", { name: /의견 남기기/ }));
    const box = await within(card("q-21")).findByRole("textbox");
    box.focus();
    expect(pressKey(box, "KeyJ")).toBe(true);
    expect(pressKey(focusInside("q-21"), "KeyJ", { isComposing: true })).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "답 검토 후 보내기" }));
    await screen.findByRole("dialog", { name: /답 검토 후 보내기/ });
    expect(pressKey(card("q-21"), "KeyJ")).toBe(true);
  });

  it("Esc는 집중 모드를 끝낸다", async () => {
    researchUi.set({ focus: true });
    await openAnswerStage();
    fireEvent.keyDown(focusInside("q-21"), { code: "Escape", key: "Escape" });
    await waitFor(() => expect(researchUi.get().focus).toBe(false));
  });

  it("끄기 설정은 이 브라우저에 남고 다시 켤 수 있다", () => {
    researchUi.set({ jk: false });
    expect(researchUi.get().jk).toBe(false);
    researchUi.set({ jk: true });
    expect(researchUi.get().jk).toBe(true);
  });

  it("숫자 키 없이도 지금 있는 ‘답 검토 후 보내기’ 단추로 대화 상자가 열린다", async () => {
    await openAnswerStage();
    fireEvent.click(screen.getByRole("button", { name: "답 검토 후 보내기" }));
    await screen.findByRole("dialog", { name: /답 검토 후 보내기/ });
  });
});

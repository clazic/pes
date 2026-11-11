// SEL-83 U1c — 명령 메뉴: 머리줄 '명령 찾기' 자리가 실제 메뉴가 된다 (Vitest, jsdom).
// 동작 목록 하나(메뉴·맥락 메뉴·단축키 공유) · 명시적 AI 모드 · Tab 은 IME 조합 밖에서만 보조 · 결과 없음→AI 자동 전송 금지 · 키보드만으로 열기·고르기·닫기·초점 복귀.
// 계약: src/test/contract.ts 머리말 "명령 메뉴".
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScriptedClient } from "@/test/scripted-client";
import { query, renderApp } from "@/test/render-app";
import { CMD, CURRENT, NAMES, PAST, SHELL, WIDTHS } from "@/test/contract";
import { answerBox, ready } from "@/test/ui";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

const opener = () => within(screen.getByRole("banner")).getByRole("button", { name: SHELL.command });
const menu = () => screen.getByRole("dialog", { name: CMD.dialog });
const box = () => within(menu()).getByRole("combobox", { name: CMD.combobox }) as HTMLInputElement;
const options = () => within(menu()).queryAllByRole("option");
const labels = () => options().map((o) => o.textContent?.replace(/\s+/g, " ").trim() ?? "");
const optionByLabel = (label: string | RegExp) => within(menu()).getByRole("option", { name: label });
const typeInto = (text: string) => fireEvent.change(box(), { target: { value: text } });

async function boot(url = CURRENT, width: number = WIDTHS.wide1440) {
  const s = createScriptedClient();
  const user = userEvent.setup();
  const app = await renderApp(url, { width }, { client: s.client });
  await ready();
  return { s, user, ...app };
}

describe("열기", () => {
  it("머리줄 단추는 더 이상 aria-disabled 가 아니고 대화 상자를 알린다", async () => {
    await boot();
    expect(opener()).not.toHaveAttribute("aria-disabled", "true");
    expect(opener()).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("단추를 누르면 이름 '명령 메뉴' 대화 상자가 열리고 검색 칸에 초점이 간다", async () => {
    const { user } = await boot();
    await user.click(opener());
    expect(menu()).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(box()));
  });

  it.each([
    ["Ctrl+K", { key: "k", ctrlKey: true }],
    ["Cmd+K", { key: "k", metaKey: true }],
  ])("%s 로 연다", async (_n, init) => {
    await boot();
    fireEvent.keyDown(document.body, init);
    expect(await screen.findByRole("dialog", { name: CMD.dialog })).toBeInTheDocument();
  });

  it("글 입력 칸에서 쓰다가 Ctrl+K 로 열어도 되고, 한글 조합 중이면 무시한다", async () => {
    await boot();
    const ta = answerBox("q-21");
    ta.focus();
    fireEvent.compositionStart(ta);
    fireEvent.keyDown(ta, { key: "k", ctrlKey: true, isComposing: true });
    fireEvent.keyDown(ta, { key: "k", ctrlKey: true, keyCode: 229 });
    expect(screen.queryByRole("dialog", { name: CMD.dialog })).toBeNull();
    fireEvent.compositionEnd(ta);
    fireEvent.keyDown(ta, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: CMD.dialog })).toBeInTheDocument();
  });

  it("동작 목록: 질문으로 가기 · 본문으로 가기 · 인쇄 미리보기 열기 · 질문마다 '질문 N 미리보기'", async () => {
    const { user } = await boot();
    await user.click(opener());
    const l = labels();
    for (const want of [CMD.labels.goAsk, CMD.labels.goBody, CMD.labels.print, CMD.peek(21), CMD.peek(22)]) expect(l.join("|"), want).toContain(want);
    expect(within(menu()).getByRole("listbox")).toBeInTheDocument();
  });

  it("첫 항목이 처음부터 강조되어 있다(aria-activedescendant 가 option 을 가리킴)", async () => {
    const { user } = await boot();
    await user.click(opener());
    const id = box().getAttribute("aria-activedescendant");
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)).toHaveAttribute("role", "option");
  });
});

describe("걸러내기 · 고르기", () => {
  it("부분 글자로 거른다(대소문자 무시)", async () => {
    const { user } = await boot();
    await user.click(opener());
    typeInto("인쇄");
    expect(labels()).toEqual([CMD.labels.print]);
    typeInto("");
    expect(options().length).toBeGreaterThan(3);
  });

  it("↑↓ 로 강조를 옮긴다", async () => {
    const { user } = await boot();
    await user.click(opener());
    const first = box().getAttribute("aria-activedescendant");
    await user.keyboard("{ArrowDown}");
    const second = box().getAttribute("aria-activedescendant");
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    await user.keyboard("{ArrowUp}");
    expect(box().getAttribute("aria-activedescendant")).toBe(first);
  });

  it("키보드만으로: 단추에 초점 → Enter 로 열기 → 글자 → Enter 로 실행 → 닫힘, 인쇄 미리보기가 열린다", async () => {
    const { user, router } = await boot();
    opener().focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog", { name: CMD.dialog });
    typeInto("인쇄");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: CMD.dialog })).toBeNull());
    expect(query(router).get("print")).toBe("1");
    expect(await screen.findByRole("region", { name: NAMES.print })).toBeInTheDocument();
  });

  it("마우스로 option 을 눌러도 같은 동작", async () => {
    const { user, router } = await boot();
    await user.click(opener());
    await user.click(optionByLabel(CMD.labels.print));
    await waitFor(() => expect(query(router).get("print")).toBe("1"));
  });

  it.each([
    [CMD.labels.goAsk, "complementary"],
    [CMD.labels.goBody, "main"],
  ] as const)("'%s' 를 고르면 닫히고 그 영역 안으로 초점이 간다", async (label, landmark) => {
    const { user } = await boot();
    await user.click(opener());
    await user.click(optionByLabel(label));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: CMD.dialog })).toBeNull());
    const region = landmark === "main" ? screen.getByRole("main") : screen.getByRole("complementary", { name: NAMES.ask });
    await waitFor(() => expect(region.contains(document.activeElement)).toBe(true));
  });

  it.each([
    ["열린 질문(조사 R2)", CURRENT, 21, "q-21"],
    ["지난 라운드(기획 R1)", PAST, 11, "q-11"],
  ])("%s 에서 '질문 N 미리보기' 가 같은 미리보기 대화 상자를 연다", async (_n, url, num, qid) => {
    const { user, router } = await boot(url);
    await user.click(opener());
    await user.click(optionByLabel(CMD.peek(num)));
    await waitFor(() => expect(query(router).get("peek")).toBe(qid));
    expect(await screen.findByRole("dialog", { name: NAMES.peek })).toBeInTheDocument();
    expect(router.state.location.pathname, "경로 그대로").toBe(new URL(url, "http://x").pathname);
  });
});

describe("닫기 · 초점 복귀", () => {
  it("단추로 연 메뉴를 Esc 로 닫으면 초점이 그 단추로 돌아온다", async () => {
    const { user } = await boot();
    await user.click(opener());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: CMD.dialog })).toBeNull());
    expect(document.activeElement).toBe(opener());
  });

  it("글 칸에서 단축키로 연 메뉴를 Esc 로 닫으면 그 글 칸으로 돌아온다", async () => {
    const { user } = await boot();
    const ta = answerBox("q-22");
    ta.focus();
    fireEvent.keyDown(ta, { key: "k", ctrlKey: true });
    await screen.findByRole("dialog", { name: CMD.dialog });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: CMD.dialog })).toBeNull());
    expect(document.activeElement).toBe(ta);
  });

  it("Tab 덫이 없다 — 대화 상자만 초점을 가두고, 계속 Tab 해도 초점이 문서 밖(body)으로 사라지지 않는다", async () => {
    const { user } = await boot();
    await user.click(opener());
    for (let i = 0; i < 12; i++) {
      await user.tab();
      expect(menu().contains(document.activeElement), `Tab ${i + 1}번째 초점`).toBe(true);
    }
  });
});

describe("검색 결과 없음 → AI 로 자동 전송 금지", () => {
  it("안내(role=status)만 보이고 Enter 를 눌러도 AI 모드로 바뀌거나 아무것도 보내지 않는다", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { s, user } = await boot();
    await user.click(opener());
    typeInto("zzzz-없는-동작-qq");
    expect(options()).toHaveLength(0);
    expect(within(menu()).getByRole("status").textContent).toMatch(CMD.noMatch);
    s.reset();
    await user.keyboard("{Enter}");
    expect(menu()).toBeInTheDocument();
    expect(within(menu()).getByRole("button", { name: CMD.aiToggle })).toHaveAttribute("aria-pressed", "false");
    expect(s.calls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("명시적 AI 모드", () => {
  it("단추 'AI 모드' 를 눌러야 바뀐다 — aria-pressed, 입력 이름, 보내기 단추는 막힌 자리(이유 글)", async () => {
    const { s, user } = await boot();
    await user.click(opener());
    const toggle = within(menu()).getByRole("button", { name: CMD.aiToggle });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(within(menu()).getByRole("combobox", { name: /AI/ }) ?? within(menu()).getByRole("textbox", { name: /AI/ })).toBeInTheDocument();
    expect(options(), "AI 모드에서는 동작 목록 대신 보낼 글").toHaveLength(0);
    const send = within(menu()).getByRole("button", { name: CMD.aiSend });
    expect(send).toHaveAttribute("aria-disabled", "true");
    expect((send.getAttribute("aria-describedby") ?? "").length).toBeGreaterThan(0);
    s.reset();
    await user.click(send);
    expect(s.calls, "AI 연결이 없으니 아무것도 보내지 않는다").toEqual([]);
  });

  it("AI 모드에서 글을 쓰고 Enter 를 눌러도 보내지 않고, 끄면 동작 목록으로 돌아온다", async () => {
    const { s, user } = await boot();
    await user.click(opener());
    const toggle = within(menu()).getByRole("button", { name: CMD.aiToggle });
    await user.click(toggle);
    const input = (within(menu()).queryByRole("combobox", { name: /AI/ }) ?? within(menu()).getByRole("textbox", { name: /AI/ })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "이 연구 요약해 줘" } });
    s.reset();
    await user.keyboard("{Enter}");
    expect(s.calls).toEqual([]);
    expect(s.unexpected()).toEqual([]);
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(options().length).toBeGreaterThan(3);
  });

  it("AI 모드 단추는 키보드(Tab → Enter/Space)로 닿는다", async () => {
    const { user } = await boot();
    await user.click(opener());
    const toggle = within(menu()).getByRole("button", { name: CMD.aiToggle });
    for (let i = 0; i < 6 && document.activeElement !== toggle; i++) await user.tab();
    expect(document.activeElement).toBe(toggle);
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });
});

describe("Tab 보조 — IME 조합 밖에서만", () => {
  it("조합 밖: Tab 이 강조된 option 의 라벨을 검색 칸에 채우고(preventDefault)", async () => {
    const { user } = await boot();
    await user.click(opener());
    typeInto("인쇄");
    const notPrevented = fireEvent.keyDown(box(), { key: "Tab" });
    expect(notPrevented, "preventDefault").toBe(false);
    expect(box().value).toBe(CMD.labels.print);
  });

  it("이미 라벨과 같으면 덫이 되지 않는다 — Tab 은 평소처럼 이동(막지 않음)", async () => {
    const { user } = await boot();
    await user.click(opener());
    typeInto(CMD.labels.print);
    expect(fireEvent.keyDown(box(), { key: "Tab" }), "막지 않음").toBe(true);
  });

  it.each([
    ["isComposing", { isComposing: true }],
    ["keyCode 229", { keyCode: 229 }],
  ])("조합 중(%s)에는 아무것도 채우지 않고 막지도 않는다", async (_n, init) => {
    const { user } = await boot();
    await user.click(opener());
    typeInto("인쇄");
    fireEvent.compositionStart(box());
    const notPrevented = fireEvent.keyDown(box(), { key: "Tab", ...init });
    expect(notPrevented).toBe(true);
    expect(box().value).toBe("인쇄");
  });

  it("조합 중 Enter 는 고르지 않는다(조합 확정용 Enter)", async () => {
    const { user, router } = await boot();
    await user.click(opener());
    typeInto("인쇄");
    fireEvent.compositionStart(box());
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
    expect(menu()).toBeInTheDocument();
    expect(query(router).get("print")).toBeNull();
  });
});

describe("동작 목록 하나 — 맥락 메뉴가 같은 목록을 쓴다", () => {
  const openContext = async (key = "ContextMenu") => {
    const ta = answerBox("q-21");
    ta.focus();
    fireEvent.keyDown(ta, { key });
    return { ta, ctx: await screen.findByRole("menu", { name: CMD.contextMenu }) };
  };

  it("질문 안에서 ContextMenu 키(또는 Shift+F10)로 '질문 동작' 메뉴가 열리고 '질문 21 미리보기' 가 있다", async () => {
    await boot();
    const { ctx } = await openContext();
    expect(within(ctx).getByRole("menuitem", { name: CMD.peek(21) })).toBeInTheDocument();
  });

  it("contextmenu 이벤트(오른쪽 단추)로도 열린다", async () => {
    await boot();
    fireEvent.contextMenu(answerBox("q-22"));
    const ctx = await screen.findByRole("menu", { name: CMD.contextMenu });
    expect(within(ctx).getByRole("menuitem", { name: CMD.peek(22) })).toBeInTheDocument();
  });

  it("맥락 메뉴의 모든 라벨은 명령 메뉴 라벨의 부분 집합이고 단축키 표시(aria-keyshortcuts)도 같다", async () => {
    const { user } = await boot();
    const { ctx } = await openContext();
    const ctxItems = within(ctx).getAllByRole("menuitem").map((el) => [el.textContent?.replace(/\s+/g, " ").trim() ?? "", el.getAttribute("aria-keyshortcuts")] as const);
    expect(ctxItems.length).toBeGreaterThan(0);
    await user.keyboard("{Escape}");
    await user.click(opener());
    const cmdItems = new Map(options().map((el) => [el.textContent?.replace(/\s+/g, " ").trim() ?? "", el.getAttribute("aria-keyshortcuts")] as const));
    for (const [label, keys] of ctxItems) {
      // 정확 일치(R1 권장 8) — 이름을 포함하는 다른 문구가 통과하지 않는다
      expect(cmdItems.has(label), `명령 메뉴에 정확히 같은 라벨이 없다: ${label}`).toBe(true);
      expect(cmdItems.get(label) ?? null, `단축키 표시 ${label}`).toBe(keys);
    }
  });

  it("맥락 메뉴를 Esc 로 닫으면 열기 전 글 칸으로 초점이 돌아온다", async () => {
    const { user } = await boot();
    const { ta } = await openContext();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu", { name: CMD.contextMenu })).toBeNull());
    expect(document.activeElement).toBe(ta);
    // Shift+F10 도 같은 메뉴
    const ta2 = answerBox("q-21");
    ta2.focus();
    fireEvent.keyDown(ta2, { key: "F10", shiftKey: true });
    await screen.findByRole("menu", { name: CMD.contextMenu });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu", { name: CMD.contextMenu })).toBeNull());
    expect(document.activeElement).toBe(ta2);
  });

  it("맥락 메뉴에서 '질문 21 미리보기' 를 고르면 명령 메뉴에서 고른 것과 같다(peek=q-21)", async () => {
    const { user, router } = await boot();
    const { ctx } = await openContext();
    await user.click(within(ctx).getByRole("menuitem", { name: CMD.peek(21) }));
    await waitFor(() => expect(query(router).get("peek")).toBe("q-21"));
    expect(await screen.findByRole("dialog", { name: NAMES.peek })).toBeInTheDocument();
  });
});

describe("회귀 — 명령 메뉴는 읽기 호출만 부른다", () => {
  it("열고 닫고 고르는 동안 클라이언트의 읽기 목록 밖 메서드는 불리지 않는다", async () => {
    const { s, user } = await boot();
    await user.click(opener());
    await user.click(optionByLabel(CMD.labels.print));
    await act(async () => {});
    expect(s.unexpected()).toEqual([]);
  });
});

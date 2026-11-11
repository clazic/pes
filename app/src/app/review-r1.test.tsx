// SEL-81 U1a (R1 권장 5·6·8) — 1차 리뷰에서 드러난 시험 공백: 보기 전환 키보드 · 인쇄 미리보기/미리보기 대화 상자 초점 · 테마 · 초안 (Vitest, jsdom).
// jsdom 은 CSS 가 없다 → 표시·스크롤·가려짐은 e2e(e2e/review-r1.spec.ts)가 본다. 여기서는 동작·초점·저장만.
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { initTheme } from "@/lib/theme";
import { THEMES } from "@/themes/themes";
import { renderApp, query } from "@/test/render-app";
import { CURRENT, NAMES, WIDTHS } from "@/test/contract";

const ready = async () => {
  await screen.findByRole("main");
  await waitFor(() => expect(screen.getByRole("main").querySelector("[data-screen-title]")).not.toBeNull());
};
const group = () => screen.getByRole("radiogroup", { name: NAMES.viewGroup });
const radios = () => within(group()).getAllByRole("radio");

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  document.documentElement.className = "";
  document.cookie = "sidebar_state=; max-age=0; path=/";
});

describe("보기 전환(radiogroup) 키보드 — WAI-ARIA 라디오 패턴", () => {
  it("1영역(683)에는 단계·라운드 · 본문 · 질문 세 개, 고른 것만 tabindex=0 (roving)", async () => {
    await renderApp(CURRENT, { width: WIDTHS.zoom200of1366 });
    await ready();
    expect(radios().map((r) => r.textContent?.trim())).toEqual([NAMES.viewNav, NAMES.viewBody, NAMES.viewAsk]);
    expect(radios().filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(radios().filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1);
    expect(within(group()).getByRole("radio", { name: NAMES.viewBody })).toHaveAttribute("tabindex", "0");
  });

  it("ArrowLeft/ArrowUp 은 앞으로, ArrowRight/ArrowDown 은 뒤로 — 끝에서 처음/끝으로 돈다, 초점이 따라간다", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(CURRENT, { width: WIDTHS.zoom200of1366 });
    await ready();
    const body = within(group()).getByRole("radio", { name: NAMES.viewBody });
    body.focus();
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(query(router).get("view")).toBe("nav"));
    expect(document.activeElement).toBe(within(group()).getByRole("radio", { name: NAMES.viewNav }));
    await user.keyboard("{ArrowLeft}"); // 처음 → 끝으로 돈다
    await waitFor(() => expect(query(router).get("view")).toBe("ask"));
    expect(document.activeElement).toBe(within(group()).getByRole("radio", { name: NAMES.viewAsk }));
    await user.keyboard("{ArrowRight}"); // 끝 → 처음으로 돈다
    await waitFor(() => expect(query(router).get("view")).toBe("nav"));
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(query(router).get("view")).toBe("body"));
    await user.keyboard("{ArrowUp}");
    await waitFor(() => expect(query(router).get("view")).toBe("nav"));
  });

  it("Home 은 첫 번째, End 는 마지막 라디오를 고른다", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(`${CURRENT}?view=body`, { width: WIDTHS.zoom200of1366 });
    await ready();
    within(group()).getByRole("radio", { name: NAMES.viewBody }).focus();
    await user.keyboard("{End}");
    await waitFor(() => expect(query(router).get("view")).toBe("ask"));
    await user.keyboard("{Home}");
    await waitFor(() => expect(query(router).get("view")).toBe("nav"));
    expect(radios().filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1);
  });

  it("2영역(900~1279)의 보기 전환에는 '단계·라운드'가 없다 — 본문 · 질문 둘 (단계·라운드는 이미 함께 보임)", async () => {
    await renderApp(CURRENT, { width: WIDTHS.mid });
    await ready();
    expect(radios().map((r) => r.textContent?.trim())).toEqual([NAMES.viewBody, NAMES.viewAsk]);
  });

  it("2영역에서 view=nav 주소로 들어와도 오류 없이 본문과 같은 화면(모르는 값처럼 기본)으로 그린다", async () => {
    await renderApp(`${CURRENT}?view=nav`, { width: WIDTHS.mid });
    await ready();
    expect(screen.queryByText(/찾을 수 없/)).toBeNull();
    expect(within(group()).getByRole("radio", { name: NAMES.viewBody })).toHaveAttribute("aria-checked", "true");
  });
});

describe("인쇄 미리보기 열기/닫기 초점", () => {
  it("단추로 열면 미리보기 제목으로 초점, 닫으면 연 단추(#tool-print)로 돌아온다", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    await user.click(screen.getByRole("button", { name: NAMES.print }));
    const region = await screen.findByRole("region", { name: NAMES.print });
    await waitFor(() => expect(region.contains(document.activeElement) && /H[1-6]/.test(document.activeElement!.tagName)).toBe(true));
    expect(query(router).get("print")).toBe("1");
    await user.click(within(region).getByRole("button", { name: /닫기/ }));
    await waitFor(() => expect(screen.queryByRole("region", { name: NAMES.print })).toBeNull());
    await waitFor(() => expect(document.activeElement?.id).toBe("tool-print"));
    expect(query(router).has("print")).toBe(false);
  });

  it("미리보기 안에는 보내지 않은 초안이 들어가지 않는다(출력 시점 고정)", async () => {
    const user = userEvent.setup();
    await renderApp(`${CURRENT}?view=ask`, { width: WIDTHS.wide1440 });
    await ready();
    await user.type(document.getElementById("q-21") as HTMLElement, "아직 안 보낸 초안 문장");
    await user.click(screen.getByRole("button", { name: NAMES.print }));
    const region = await screen.findByRole("region", { name: NAMES.print });
    expect(region.textContent).not.toContain("아직 안 보낸 초안 문장");
  });
});

describe("미리보기 대화 상자(peek) — 이름·초점·Esc 범위", () => {
  it("이름은 제목을 가리키는 aria-labelledby 이고 aria-label 이 아니다", async () => {
    await renderApp(`${CURRENT}?view=ask&peek=q-21`, { width: WIDTHS.wide1440 });
    const dialog = await screen.findByRole("dialog", { name: NAMES.peek });
    expect(dialog).toHaveAttribute("aria-labelledby");
    expect(dialog).not.toHaveAttribute("aria-label");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toContain(NAMES.peek);
  });

  it("브라우저 뒤로 가기로 닫아도 초점이 body 로 떨어지지 않고 연 단추로 간다", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(`${CURRENT}?view=ask`, { width: WIDTHS.wide1440 });
    await ready();
    const opener = screen.getAllByRole("button", { name: NAMES.peekOpener })[0]!;
    await user.click(opener);
    await screen.findByRole("dialog", { name: NAMES.peek });
    await act(async () => {
      await router.navigate(-1);
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: NAMES.peek })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("테마 메뉴가 열려 있을 때 Esc 는 메뉴만 닫고 미리보기는 그대로 둔다 — 두 번째 Esc 가 미리보기를 닫는다", async () => {
    const user = userEvent.setup();
    await renderApp(`${CURRENT}?view=ask&peek=q-21`, { width: WIDTHS.wide1440 });
    await screen.findByRole("dialog", { name: NAMES.peek });
    await user.click(screen.getByRole("button", { name: "테마" }));
    await screen.findByRole("menu");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(screen.queryByRole("dialog", { name: NAMES.peek }), "첫 Esc 는 메뉴 몫").not.toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: NAMES.peek })).toBeNull());
  });
});

describe("테마 — 고른 값은 이 브라우저에만 남고 다시 열면 복원", () => {
  const second = THEMES[1]!;

  it("메뉴에서 고르면 <html> 에 theme 클래스가 붙고 localStorage 에 남는다", async () => {
    const user = userEvent.setup();
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    await user.click(screen.getByRole("button", { name: "테마" }));
    await user.click(await screen.findByRole("menuitemradio", { name: new RegExp(second.name) }));
    expect(document.documentElement.classList.contains(`theme-${second.id}`)).toBe(true);
    const stored = Object.values({ ...window.localStorage }).join("|");
    expect(stored).toContain(second.id);
  });

  it("저장된 값이 있으면 다시 열 때 그 테마로 시작하고 메뉴의 고른 칸도 같다", async () => {
    window.localStorage.setItem("pes-theme", JSON.stringify({ theme: second.id, mode: "dark" }));
    initTheme();
    expect(document.documentElement.classList.contains(`theme-${second.id}`)).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    const user = userEvent.setup();
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    await user.click(screen.getByRole("button", { name: "테마" }));
    expect(await screen.findByRole("menuitemradio", { name: new RegExp(second.name) })).toHaveAttribute("aria-checked", "true");
  });

  it("망가진 저장값은 기본 테마로 — 오류 없이 시작", async () => {
    window.localStorage.setItem("pes-theme", "{깨짐");
    initTheme();
    await renderApp(CURRENT, { width: WIDTHS.wide1440 });
    await ready();
    expect(document.documentElement.classList.contains(`theme-${THEMES[0]!.id}`)).toBe(true);
  });
});

describe("초안(sessionStorage) — 새로고침에도 남고 칸끼리 섞이지 않는다", () => {
  it("답 칸에 쓴 글은 다시 그려도(새로고침) 남는다 · 의견 칸과 다른 질문 칸에는 번지지 않는다", async () => {
    const user = userEvent.setup();
    const a = await renderApp(`${CURRENT}?view=ask`, { width: WIDTHS.wide1440 });
    await ready();
    await user.type(document.getElementById("q-21") as HTMLElement, "초안 가나다");
    a.unmount();
    await renderApp(`${CURRENT}?view=ask`, { width: WIDTHS.wide1440 });
    await ready();
    expect((document.getElementById("q-21") as HTMLTextAreaElement).value).toBe("초안 가나다");
    expect((document.getElementById("q-21-opinion") as HTMLTextAreaElement).value).toBe("");
    expect((document.getElementById("q-22") as HTMLTextAreaElement).value).toBe("");
  });

  it("글을 모두 지우면 저장도 지워진다(빈 초안 흔적 없음)", async () => {
    const user = userEvent.setup();
    await renderApp(`${CURRENT}?view=ask`, { width: WIDTHS.wide1440 });
    await ready();
    const box = document.getElementById("q-22") as HTMLElement;
    await user.type(box, "지울 글");
    expect(Object.keys({ ...window.sessionStorage }).length).toBeGreaterThan(0);
    await user.clear(box);
    expect(Object.values({ ...window.sessionStorage }).join("")).not.toContain("지울 글");
  });

  it("초안은 localStorage 에 남지 않는다(탭을 닫으면 사라짐)", async () => {
    const user = userEvent.setup();
    await renderApp(`${CURRENT}?view=ask`, { width: WIDTHS.wide1440 });
    await ready();
    await user.type(document.getElementById("q-21") as HTMLElement, "탭 안에서만");
    expect(Object.values({ ...window.localStorage }).join("")).not.toContain("탭 안에서만");
  });
});

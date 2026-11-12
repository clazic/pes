// SEL-112 U4b — 결과 글 선택 도구(첨언 / AI에게 묻기 / 할 일로) · Alt+M · DOM 선택 → code point 위치 · 첨언 보내기 (Vitest, jsdom). 계약: src/test/sel112.ts 머리말.
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WIDTHS } from "@/test/contract";
import {
  BODY,
  FAMILY,
  GRIN,
  LONE_SURROGATE,
  OBJ,
  P_EMOJI,
  QUOTE_A,
  QUOTE_REPEAT,
  VER1,
  alertText,
  altM,
  apiFail,
  blockWith,
  blocks,
  boot,
  clearSelection,
  cpAt,
  cpLen,
  selectRange,
  selectText,
  sliceBy,
  statusTexts,
  toolButton,
  toolbar,
  type AnnotationInput,
} from "@/test/sel112";

afterEach(() => {
  cleanup();
  clearSelection();
});

const sentAnchor = (u4: Awaited<ReturnType<typeof boot>>["u4"]) => (u4.callsOf("createAnnotation")[0]!.input as unknown as AnnotationInput).anchor;

describe("선택 도구는 글을 선택했을 때만 뜬다", () => {
  it("글 블록(문단 · 표 칸)이 body_md 위치(data-cp-start)와 함께 그려지고 표는 표로 읽힌다", async () => {
    await boot();
    const bs = await blocks();
    const para = blockWith("정책 대안은 두 가지다.");
    expect(para.tagName).toBe("P");
    expect(para.getAttribute("data-cp-start")).toBe("0");
    expect(para.textContent).toBe(sliceBy(BODY, { start_cp: 0, end_cp: cpLen(para.textContent ?? "") }));
    const table = within(screen.getByRole("main")).getByRole("table");
    expect(within(table).getAllByRole("cell").length).toBeGreaterThan(0);
    // 모든 블록: 글이 body_md 의 [N, N+길이) 와 같다
    for (const b of bs) {
      const start = Number(b.getAttribute("data-cp-start"));
      const text = b.textContent ?? "";
      expect(sliceBy(BODY, { start_cp: start, end_cp: start + cpLen(text) }), b.outerHTML.slice(0, 60)).toBe(text);
    }
    // 파이프 · 구분줄은 보이지 않는다
    expect(table.textContent).not.toMatch(/\|/);
    expect(table.textContent).not.toMatch(/---/);
  });

  it("선택이 없으면 도구가 없다 — 선택하면 생기고, 선택을 풀면 사라진다", async () => {
    await boot();
    await blocks();
    expect(toolbar()).toBeNull();
    selectText(blockWith(QUOTE_A), QUOTE_A);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    const names = within(toolbar()!).getAllByRole("button").map((b) => b.textContent?.trim());
    expect(names).toEqual(expect.arrayContaining(["첨언", "AI에게 묻기", "할 일로"]));
    clearSelection();
    await waitFor(() => expect(toolbar()).toBeNull());
  });

  it("접힌 선택(커서만) 은 선택이 아니다", async () => {
    await boot();
    await blocks();
    const block = blockWith(QUOTE_A);
    selectRange(block, 3, 3);
    expect(toolbar()).toBeNull();
  });

  it("두 블록(문단 둘)에 걸친 선택에는 도구가 없고, 한 문단/칸 안에서만이라는 안내가 있다", async () => {
    await boot();
    await blocks();
    const a = blockWith(QUOTE_A);
    const b = blockWith("이모지 뒤");
    const range = document.createRange();
    range.setStart(a.firstChild!, 2);
    range.setEnd(b.firstChild!, 4);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    fireEvent.mouseUp(b);
    expect(toolbar()).toBeNull();
    await waitFor(() => expect(statusTexts()).toMatch(/한 (문단|칸)/));
  });

  it("결과 글 밖(질문 영역)의 선택에는 도구가 없다", async () => {
    await boot();
    await blocks();
    const ask = screen.getByRole("complementary", { name: "질문" });
    const node = [...ask.querySelectorAll("*")].map((e) => e.firstChild).find((n): n is Text => n?.nodeType === 3 && (n.textContent ?? "").length > 3)!;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 3);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    expect(toolbar()).toBeNull();
  });

  it("서버가 글 본문 · 객체 · 버전을 주지 않으면(body_md 없음) 선택해도 도구가 없다 — 위치를 지어내지 않는다", async () => {
    await boot({ withoutBody: true });
    const p = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("main article p");
      if (!el) throw new Error("결과 글 문단이 아직 없다");
      return el;
    });
    expect(p.hasAttribute("data-cp-start")).toBe(false);
    selectRange(p, 0, 3);
    expect(toolbar()).toBeNull();
    expect(screen.getByRole("button", { name: "첨언 쓰기" })).toBeTruthy();
  });

  it("휴대폰(좁은 폭 + 굵은 포인터)에서는 도구가 없다(편집·첨언 작성은 데스크톱, 설계 4.16)", async () => {
    await boot({}, { width: WIDTHS.phone, coarse: true });
    await blocks();
    selectText(blockWith(QUOTE_A), QUOTE_A);
    expect(toolbar()).toBeNull();
    altM();
    expect(toolbar()).toBeNull();
  });
});

describe("Alt+M 키보드만으로 연다", () => {
  it("선택이 있을 때 Alt+M 은 도구 첫 단추로 초점을 옮기고 선택은 그대로다", async () => {
    await boot();
    await blocks();
    selectText(blockWith(QUOTE_A), QUOTE_A);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    act(() => altM());
    await waitFor(() => expect(document.activeElement).toBe(toolButton("첨언")));
    expect(window.getSelection()!.toString()).toBe(QUOTE_A);
  });

  it("맥 Option+M(key 가 'µ') 도 code 'KeyM' 으로 같다", async () => {
    await boot();
    await blocks();
    selectText(blockWith(QUOTE_A), QUOTE_A);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    act(() => altM(document.body, "µ"));
    await waitFor(() => expect(document.activeElement).toBe(toolButton("첨언")));
  });

  it("선택이 없으면 Alt+M 은 아무 일도 없다(도구 없음 · 초점 그대로 · 쓰기 0)", async () => {
    const { u4 } = await boot();
    await blocks();
    const before = document.activeElement;
    act(() => altM());
    expect(toolbar()).toBeNull();
    expect(document.activeElement).toBe(before);
    expect(u4.writes()).toHaveLength(0);
  });

  it("키보드만으로 첨언까지: Alt+M → Enter(첨언) → 대화 상자 → 글 쓰기 → 보내기", async () => {
    const { u4, user } = await boot();
    await blocks();
    selectText(blockWith(QUOTE_A), QUOTE_A);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    act(() => altM());
    await waitFor(() => expect(document.activeElement).toBe(toolButton("첨언")));
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "첨언 달기" });
    await user.type(within(dialog).getByRole("textbox", { name: "첨언" }), "근거를 보여 주세요.");
    await user.click(within(dialog).getByRole("button", { name: "첨언 달기" }));
    await waitFor(() => expect(u4.callsOf("createAnnotation")).toHaveLength(1));
  });

  it("Esc 는 도구를 닫는다", async () => {
    const { user } = await boot();
    await blocks();
    selectText(blockWith(QUOTE_A), QUOTE_A);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    act(() => altM());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(toolbar()).toBeNull());
  });

  it("접근성: 도구는 이름 있는 toolbar · 단추마다 접근 가능한 이름 · 키 힌트 Alt+M 이 보이거나 aria-keyshortcuts 로 알린다", async () => {
    await boot();
    await blocks();
    selectText(blockWith(QUOTE_A), QUOTE_A);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    const tb = toolbar()!;
    for (const b of within(tb).getAllByRole("button")) expect(b.textContent?.trim() || b.getAttribute("aria-label")).toBeTruthy();
    const hint = (tb.textContent ?? "") + " " + [...tb.querySelectorAll("[aria-keyshortcuts]")].map((n) => n.getAttribute("aria-keyshortcuts")).join(" ") + " " + (tb.getAttribute("aria-keyshortcuts") ?? "");
    expect(hint).toMatch(/Alt\s*\+\s*M/i);
  });
});

describe("DOM 선택 → code point 위치 (첨언을 보낼 때 서버에 가는 값)", () => {
  async function annotate(select: (b: HTMLElement) => void, block: HTMLElement | (() => HTMLElement), text = "근거를 더 설명해 주세요.") {
    const ctx = await boot();
    await blocks();
    select(typeof block === "function" ? block() : block);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    await ctx.user.click(toolButton("첨언"));
    const dialog = await screen.findByRole("dialog", { name: "첨언 달기" });
    await ctx.user.type(within(dialog).getByRole("textbox", { name: "첨언" }), text);
    await ctx.user.click(within(dialog).getByRole("button", { name: "첨언 달기" }));
    await waitFor(() => expect(ctx.u4.callsOf("createAnnotation")).toHaveLength(1));
    return ctx;
  }

  it("한글: 위치는 글자 수(음절 1)", async () => {
    const { u4 } = await annotate((b) => selectText(b, QUOTE_A), () => blockWith(QUOTE_A));
    const call = u4.callsOf("createAnnotation")[0]!;
    const input = call.input as unknown as AnnotationInput;
    expect(input.target_object_id).toBe(OBJ);
    expect(input.target_version_id).toBe(VER1);
    expect(input.body_md).toBe("근거를 더 설명해 주세요.");
    expect(input.anchor.exact_quote).toBe(QUOTE_A);
    const want = cpAt(BODY, QUOTE_A);
    expect(input.anchor).toMatchObject(want);
    expect(call.key).toMatch(/\S/);
  });

  it("이모지 뒤 문장: UTF-16 위치가 아니라 code point 위치(😀 = 1 · 👨‍👩 = 3)", async () => {
    const { u4 } = await annotate((b) => selectText(b, "가족 문장이다."), () => blockWith("가족 문장이다."));
    const a = sentAnchor(u4);
    expect(a.exact_quote).toBe("가족 문장이다.");
    expect(a.start_cp).toBe(cpAt(BODY, "가족 문장이다.").start_cp);
    expect(a.end_cp - a.start_cp).toBe(cpLen("가족 문장이다."));
    expect(a.start_cp).not.toBe(BODY.indexOf("가족 문장이다.")); // UTF-16 위치였다면 틀리다
  });

  it("이모지 · ZWJ 가족 자체를 고르면 길이 1 · 3", async () => {
    const e = await annotate((b) => selectText(b, GRIN), () => blockWith(P_EMOJI));
    const a1 = sentAnchor(e.u4);
    expect(a1.end_cp - a1.start_cp).toBe(1);
    expect(a1.start_cp).toBe(cpAt(BODY, GRIN).start_cp);
    cleanup();
    clearSelection();
    const f = await annotate((b) => selectText(b, FAMILY), () => blockWith(P_EMOJI));
    const a2 = sentAnchor(f.u4);
    expect(a2.exact_quote).toBe(FAMILY);
    expect(a2.end_cp - a2.start_cp).toBe(3);
    expect(a2.start_cp).toBe(cpAt(BODY, FAMILY).start_cp);
  });

  it("표 칸 안의 글: 칸 블록의 data-cp-start 에서 센 본문 위치(파이프 · 구분줄 포함 본문 기준)", async () => {
    const cell = `${GRIN}2`;
    const { u4 } = await annotate((b) => selectText(b, cell), () => blockWith(cell));
    const a = sentAnchor(u4);
    expect(a.exact_quote).toBe(cell);
    expect(a).toMatchObject(cpAt(BODY, cell));
    expect(sliceBy(BODY, a)).toBe(cell);
  });

  it("표 칸 글의 일부만 골라도 맞다", async () => {
    const { u4 } = await annotate((b) => selectText(b, "2"), () => blockWith(`${GRIN}2`));
    const a = sentAnchor(u4);
    expect(a.exact_quote).toBe("2");
    const cell = cpAt(BODY, `${GRIN}2`);
    expect(a).toMatchObject({ start_cp: cell.end_cp - 1, end_cp: cell.end_cp });
  });

  it("반복 인용: 두 번째 '같은 말이다.' 를 고르면 두 번째 자리 위치를 싣고 prefix/suffix 가 비어 있지 않다", async () => {
    const { u4 } = await annotate((b) => selectText(b, QUOTE_REPEAT, 1), () => blockWith(QUOTE_REPEAT));
    const a = sentAnchor(u4);
    expect(a.exact_quote).toBe(QUOTE_REPEAT);
    const second = cpAt(BODY, QUOTE_REPEAT, 1);
    expect(a.start_cp).toBe(second.start_cp);
    expect(a.end_cp).toBe(second.end_cp);
    expect(a.start_cp).not.toBe(cpAt(BODY, QUOTE_REPEAT, 0).start_cp);
    expect(a.prefix.length).toBeGreaterThan(0);
    expect(a.suffix.length + a.prefix.length).toBeGreaterThan(0);
  });

  it("prefix 는 본문에서 그 자리 바로 앞 글, suffix 는 바로 뒤 글과 글자 그대로 이어진다(문단 경계를 넘을 수 있다)", async () => {
    const { u4 } = await annotate((b) => selectText(b, QUOTE_REPEAT, 1), () => blockWith(QUOTE_REPEAT));
    const a = sentAnchor(u4);
    const all = Array.from(BODY);
    expect(all.slice(0, a.start_cp).join("").endsWith(a.prefix)).toBe(true);
    expect(all.slice(a.end_cp).join("").startsWith(a.suffix)).toBe(true);
  });

  it("서로게이트 쌍 한가운데에서 끝난 선택: 외톨이 서로게이트를 보내지 않는다 — 인용문과 위치가 서로 맞는다", async () => {
    const block = () => blockWith(P_EMOJI);
    const select = (b: HTMLElement) => {
      const at = (b.textContent ?? "").indexOf(GRIN); // 😀 의 높은 서로게이트 위치
      selectRange(b, at + 1, at + 4); // 쌍 한가운데에서 시작 … " 이" 까지
    };
    const { u4 } = await annotate(select, block);
    const a = sentAnchor(u4);
    expect(a.exact_quote).not.toMatch(LONE_SURROGATE);
    expect(a.end_cp - a.start_cp).toBe(cpLen(a.exact_quote));
    expect(sliceBy(BODY, a)).toBe(a.exact_quote);
  });

  it("마지막 블록의 끝까지 고르거나 본문 맨 앞부터 골라도 위치가 맞다(경계값 0 · 끝)", async () => {
    const first = await annotate((b) => selectRange(b, 0, 4), () => blockWith(QUOTE_A));
    const a = sentAnchor(first.u4);
    expect(a.start_cp).toBe(0);
    expect(a.end_cp).toBe(cpLen(a.exact_quote));
    cleanup();
    clearSelection();
    const last = await annotate((b) => selectRange(b, (b.textContent ?? "").length - 4, (b.textContent ?? "").length), () => blockWith(QUOTE_REPEAT));
    const z = sentAnchor(last.u4);
    expect(z.end_cp).toBe(cpLen(BODY));
    expect(sliceBy(BODY, z)).toBe(z.exact_quote);
  });
});

describe("첨언 보내기 — 영수증 뒤에만 성공", () => {
  async function open(user: Awaited<ReturnType<typeof boot>>["user"]) {
    selectText(blockWith(QUOTE_A), QUOTE_A);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    await user.click(toolButton("첨언"));
    return screen.findByRole("dialog", { name: "첨언 달기" });
  }

  it("대화 상자는 인용을 보여 주고, 빈 글이면 호출 없이 칸에 aria-invalid", async () => {
    const { u4, user } = await boot();
    await blocks();
    const dialog = await open(user);
    expect(dialog.textContent).toContain(QUOTE_A);
    await user.click(within(dialog).getByRole("button", { name: "첨언 달기" }));
    expect(u4.callsOf("createAnnotation")).toHaveLength(0);
    expect(within(dialog).getByRole("textbox", { name: "첨언" }).getAttribute("aria-invalid")).toBe("true");
    await user.type(within(dialog).getByRole("textbox", { name: "첨언" }), "   ");
    await user.click(within(dialog).getByRole("button", { name: "첨언 달기" }));
    expect(u4.callsOf("createAnnotation")).toHaveLength(0);
  });

  it("보내는 동안은 '접수 확인 중' · 성공 말 없음 · 목록에 아직 없음 · 두 번 눌러도 한 번 · 단추는 disabled 가 아니라 aria-disabled", async () => {
    const { u4, user } = await boot();
    await blocks();
    const dialog = await open(user);
    await user.type(within(dialog).getByRole("textbox", { name: "첨언" }), "근거를 보여 주세요.");
    const release = u4.hold();
    const send = within(dialog).getByRole("button", { name: "첨언 달기" });
    await user.click(send);
    await user.click(send);
    await waitFor(() => expect(statusTexts()).toMatch(/접수 확인 중/));
    expect(statusTexts()).not.toMatch(/접수 \d/);
    expect(u4.callsOf("createAnnotation")).toHaveLength(1);
    expect(send.hasAttribute("disabled")).toBe(false);
    expect(send.getAttribute("aria-disabled")).toBe("true");
    expect(document.querySelector("[data-thread^='th-new']")).toBeNull();
    release();
    await waitFor(() => expect(statusTexts()).toMatch(/접수 1\d{3}/));
  });

  it("성공: 접수 번호 · 대화 상자 닫힘 · 초점은 body 가 아님 · 영수증 뒤 다시 읽어 목록과 글의 표시가 생긴다", async () => {
    const { u4, user } = await boot();
    await blocks();
    const dialog = await open(user);
    await user.type(within(dialog).getByRole("textbox", { name: "첨언" }), "근거를 보여 주세요.");
    await user.click(within(dialog).getByRole("button", { name: "첨언 달기" }));
    await waitFor(() => expect(statusTexts()).toMatch(/접수 \d{4}/));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "첨언 달기" })).toBeNull());
    expect(document.activeElement).not.toBe(document.body);
    const created = u4.threads[0]!;
    const el = await waitFor(() => {
      const t = document.querySelector<HTMLElement>(`[data-thread="${created.thread_id}"]:not(mark)`);
      if (!t) throw new Error("목록에 아직 없다");
      return t;
    });
    expect(el.textContent).toContain("근거를 보여 주세요.");
    expect(el.textContent).toContain(QUOTE_A);
    const mark = document.querySelector<HTMLElement>(`mark[data-thread="${created.thread_id}"]`);
    expect(mark?.textContent).toBe(QUOTE_A);
    expect(u4.reads.filter((r) => r.method === "getAnnotations").length).toBeGreaterThanOrEqual(2);
  });

  it("거절(PesApiError): role=alert 에 서버 문장, 대화 상자와 쓴 글 그대로, 성공 말 없음", async () => {
    const { u4, user } = await boot();
    await blocks();
    const dialog = await open(user);
    await user.type(within(dialog).getByRole("textbox", { name: "첨언" }), "근거를 보여 주세요.");
    u4.failNext(apiFail("validation_failed", "인용문이 이 글 버전에 없습니다."));
    await user.click(within(dialog).getByRole("button", { name: "첨언 달기" }));
    await waitFor(() => expect(alertText()).toMatch(/인용문이 이 글 버전에 없습니다/));
    expect(screen.getByRole("dialog", { name: "첨언 달기" })).toBeTruthy();
    expect((within(dialog).getByRole("textbox", { name: "첨언" }) as HTMLTextAreaElement).value).toBe("근거를 보여 주세요.");
    expect(statusTexts()).not.toMatch(/접수 \d{4}/);
    expect(u4.threads).toHaveLength(0);
  });

  it("시간 초과(TimeoutError)는 실패가 아니라 '접수 확인 중' — 다시 보내기는 같은 멱등 키", async () => {
    const { u4, user } = await boot();
    await blocks();
    const dialog = await open(user);
    await user.type(within(dialog).getByRole("textbox", { name: "첨언" }), "근거를 보여 주세요.");
    u4.failNext(Object.assign(new Error("시간 초과"), { name: "TimeoutError" }));
    await user.click(within(dialog).getByRole("button", { name: "첨언 달기" }));
    await waitFor(() => expect(statusTexts()).toMatch(/접수 확인 중/));
    expect(alertText()).not.toMatch(/실패/);
    await user.click(within(dialog).getByRole("button", { name: "첨언 달기" }));
    await waitFor(() => expect(u4.callsOf("createAnnotation")).toHaveLength(2));
    const [first, second] = u4.callsOf("createAnnotation");
    expect(second!.key).toBe(first!.key);
  });

  it("취소하면 호출 0 · 초점이 도구 단추나 글로 돌아온다(body 아님)", async () => {
    const { u4, user } = await boot();
    await blocks();
    const dialog = await open(user);
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "첨언 달기" })).toBeNull());
    expect(u4.writes()).toHaveLength(0);
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe("'AI에게 묻기'는 U5 자리 — 기존 복사 · runs 흐름과 섞지 않는다", () => {
  it("눌러도 클라이언트 쓰기 0 · 클립보드 0 · '아직' 안내만 상태 글에 나온다", async () => {
    const write = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write } });
    const { u4, user } = await boot();
    await blocks();
    selectText(blockWith(QUOTE_A), QUOTE_A);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    await user.click(toolButton("AI에게 묻기"));
    await waitFor(() => expect(statusTexts()).toMatch(/AI에게 묻기.*아직|아직.*AI에게 묻기/));
    expect(u4.writes()).toHaveLength(0);
    expect(write).not.toHaveBeenCalled();
    expect(u4.s.unexpected().map((c) => c.method)).not.toContain("acknowledgeAlert");
  });

  it("결과 글 윗줄의 '프롬프트 복사' 와 별개 단추로 그대로 있다", async () => {
    await boot();
    await blocks();
    expect(screen.getByRole("button", { name: "프롬프트 복사" })).toBeTruthy();
    selectText(blockWith(QUOTE_A), QUOTE_A);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(within(toolbar()!).queryByRole("button", { name: /프롬프트/ })).toBeNull();
  });
});

describe("'할 일로' — 다음 라운드 할 일 제안(바로 적용하지 않는다)", () => {
  it("첨언 스레드를 만든 뒤 그 스레드에서 next_round_task 후속을 제안하고, 적용은 하지 않는다", async () => {
    const { u4, user } = await boot();
    await blocks();
    selectText(blockWith(QUOTE_A), QUOTE_A);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    await user.click(toolButton("할 일로"));
    const dialog = await screen.findByRole("dialog", { name: "다음 라운드 할 일" });
    expect(dialog.textContent).toContain(QUOTE_A);
    await user.type(within(dialog).getByRole("textbox", { name: "할 일" }), "대안 두 가지의 근거 자료를 더 찾기");
    await user.click(within(dialog).getByRole("button", { name: "할 일로 남기기" }));
    await waitFor(() => expect(u4.callsOf("proposeFollowup")).toHaveLength(1));
    const created = u4.callsOf("createAnnotation");
    expect(created).toHaveLength(1);
    const prop = u4.callsOf("proposeFollowup")[0]!;
    expect(prop.input).toMatchObject({ kind: "next_round_task", origin_thread_id: u4.threads[0]!.thread_id, description: "대안 두 가지의 근거 자료를 더 찾기" });
    expect(u4.callsOf("applyFollowup")).toHaveLength(0);
    await waitFor(() => expect(statusTexts()).toMatch(/접수 \d{4}/));
    // 제안일 뿐이다 — 적용됨 · 반영됨으로 보이지 않는다
    const el = await screen.findByText(/대안 두 가지의 근거 자료를 더 찾기/, { selector: "[data-followup] *, [data-followup]" });
    const f = el.closest("[data-followup]") as HTMLElement;
    expect(f.getAttribute("data-state")).toBe("proposed");
    expect(f.textContent).not.toMatch(/적용됨|반영됨/);
  });

  it("빈 글이면 호출 0 · aria-invalid", async () => {
    const { u4, user } = await boot();
    await blocks();
    selectText(blockWith(QUOTE_A), QUOTE_A);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    await user.click(toolButton("할 일로"));
    const dialog = await screen.findByRole("dialog", { name: "다음 라운드 할 일" });
    await user.click(within(dialog).getByRole("button", { name: "할 일로 남기기" }));
    expect(u4.writes()).toHaveLength(0);
    expect(within(dialog).getByRole("textbox", { name: "할 일" }).getAttribute("aria-invalid")).toBe("true");
  });
});

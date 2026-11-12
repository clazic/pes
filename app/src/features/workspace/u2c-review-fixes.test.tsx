// SEL-92 U2c 1차 리뷰(CHANGES) 수정 — 화면: 번호 없는 영수증 · 의견 읽기가 첫 표시를 막지 않음 · 의견 읽기 실패 이유 · 지난 라운드 의견 읽기 전용 ·
// 기본값 채택 기록 새로고침 뒤 유지 · 보내는 사이에 더 쓴 글 보존 · dl 안 단추 위치 (Vitest, jsdom, 가짜 클라이언트).
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { CURRENT } from "@/test/contract";
import { NotConnectedError, type CommentThreadView } from "@/api/types";
import { renderApp } from "@/test/render-app";
import { aside, boot, btn, createU2cClient, field, item, notice, pick, waitSent } from "@/test/u2c";
import { ready } from "@/test/ui";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

const toggle = (n: number) => btn(`질문 ${n} 의견 스레드`);
const thread = (qid: string) => document.querySelector<HTMLElement>(`[data-comments="${qid}"]`);
const draftsOf = (field: string) => Object.entries({ ...window.sessionStorage }).filter(([k]) => k.startsWith("pes-draft:") && k.endsWith(`|${field}`));

describe("영수증 번호를 지어내지 않는다 (필수 1 — 화면)", () => {
  it("서버가 번호를 주지 않은 영수증(numbered:false)이면 ‘접수됨’ 이라고만 말하고 번호·긴 id 를 보이지 않는다", async () => {
    const h = await boot({ questions: pick("q-22") });
    const send = h.client.submitAnswers.bind(h.client);
    h.client.submitAnswers = async (...a: Parameters<typeof send>) => {
      const r = await send(...a);
      return { ...r, receipt: { ...r.receipt, receipt_no: "5d2e1c0a-7b3f-4e21-9a55-0f2b3c4d5e06", numbered: false } };
    };
    await h.user.type(field("q-22"), "출처 하나");
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitSent("q-22");
    const text = notice();
    expect(text).toContain("접수됨");
    expect(text).not.toMatch(/접수 \S/);
    expect(text).not.toContain("5d2e1c0a");
  });
});

describe("의견 읽기는 첫 표시를 막지 않는다 (권장 3)", () => {
  it("getComments 가 끝나지 않아도 질문이 그려지고, 스레드 칸만 ‘불러오는 중’ — 끝나면 빈 스레드 문구", async () => {
    const h = createU2cClient({ questions: pick("q-21", "q-22") });
    let release!: (v: CommentThreadView[]) => void;
    h.client.getComments = () => new Promise<CommentThreadView[]>((r) => (release = r));
    const user = userEvent.setup();
    await renderApp(CURRENT, { width: 1440 }, { client: h.client });
    await ready();
    expect(item("q-21")).toBeTruthy(); // 의견이 아직 안 와도 작업 공간이 그려졌다
    await user.click(toggle(21));
    expect(thread("q-21")!.textContent).toContain("불러오는 중");
    expect(thread("q-21")!.textContent).not.toMatch(/의견이 없어요|읽어 오지 못|읽다가 잘못/);
    expect(within(thread("q-21")!).getByRole("button", { name: "스레드에 남기기" }).getAttribute("aria-disabled")).toBe("true");
    release([]);
    await waitFor(() => expect(thread("q-21")!.textContent).toContain("아직 이 질문에 남긴 의견이 없어요"));
    cleanup();
  });
});

describe("의견 읽기 실패 이유 (권장 4)", () => {
  it("일시 오류(NotConnectedError 가 아님)는 ‘서버에 아직 이어지지 않았어요’ 라고 하지 않고, 다시 읽기 단추를 준다", async () => {
    const h = await boot({ questions: pick("q-21"), commentsError: new Error("network down") });
    await h.user.click(toggle(21));
    await waitFor(() => expect(thread("q-21")!.textContent).toContain("읽다가 잘못"));
    expect(thread("q-21")!.textContent).not.toContain("이어지지 않았어요");
    const before = h.calls("getComments").length;
    await h.user.click(within(thread("q-21")!).getByRole("button", { name: "의견 다시 읽기" }));
    await waitFor(() => expect(h.calls("getComments").length).toBeGreaterThan(before));
  });

  it("NotConnectedError 는 기존 문구 그대로 — 다시 읽기 단추 없음", async () => {
    const h = await boot({ questions: pick("q-21"), commentsError: new NotConnectedError("의견 읽기") });
    await h.user.click(toggle(21));
    await waitFor(() => expect(thread("q-21")!.textContent).toContain("이어지지 않았어요"));
    expect(within(thread("q-21")!).queryByRole("button", { name: "의견 다시 읽기" })).toBeNull();
  });
});

describe("지난 라운드 의견은 읽기만 (권장 5)", () => {
  it("지난 라운드에서는 스레드에 쓰기 칸·남기기 단추가 없다", async () => {
    const h = await boot({}, "/p/sample-study/e/1/s/plan/r/1");
    const first = document.querySelector<HTMLElement>("[data-question]")!;
    const id = first.dataset.question!;
    await h.user.click(within(first).getByRole("button", { name: /의견 스레드/ }));
    expect(thread(id)).toBeTruthy();
    expect(within(thread(id)!).queryByRole("button", { name: "스레드에 남기기" })).toBeNull();
    expect(document.getElementById(`${id}-comment`)).toBeNull();
    expect(thread(id)!.textContent).toContain("읽기만");
  });
});

describe("기본값 채택 기록은 새로고침 뒤에도 남는다 (권장 6)", () => {
  it("‘기본값 쓰기’ 뒤 화면을 다시 열어도 그대로 보내면 used_default=true", async () => {
    const first = await boot({ questions: pick("q-22") });
    await first.user.click(btn("질문 22 기본값 쓰기"));
    cleanup(); // 탭 새로고침: React 상태는 사라지고 sessionStorage 의 초안·기록만 남는다
    const again = await boot({ questions: pick("q-22") });
    expect(field("q-22").value).toBe("추가 출처 없음");
    await again.user.click(btn("질문 22 이 답만 보내기"));
    await waitSent("q-22");
    expect(again.submitted()[0]).toMatchObject({ value: "추가 출처 없음", used_default: true });
  });

  it("다시 연 뒤 고쳐 쓰면 false", async () => {
    const first = await boot({ questions: pick("q-22") });
    await first.user.click(btn("질문 22 기본값 쓰기"));
    cleanup();
    const again = await boot({ questions: pick("q-22") });
    await again.user.type(field("q-22"), " 그리고 지역 도서관");
    await again.user.click(btn("질문 22 이 답만 보내기"));
    await waitSent("q-22");
    expect(again.submitted()[0]).toMatchObject({ used_default: false });
  });

  it("보낸 뒤에는 기록도 지운다 — 같은 글을 직접 다시 써도 기본값으로 세지 않는다", async () => {
    const h = await boot({ questions: pick("q-22") });
    await h.user.click(btn("질문 22 기본값 쓰기"));
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitSent("q-22");
    expect(Object.keys({ ...window.sessionStorage }).filter((k) => k === "pes-default-used")).toEqual([]);
  });
});

describe("보내는 사이에 더 쓴 글을 지우지 않는다 (권장 7)", () => {
  it("느린 연결에서 보내는 중 같은 칸에 더 쓰면, 접수 뒤에도 그 글은 초안에 남는다", async () => {
    const h = await boot({ questions: pick("q-22") });
    await h.user.type(field("q-22"), "처음 글");
    const release = h.hold();
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await h.user.type(field("q-22"), " 그 사이에 더 씀");
    release();
    await waitSent("q-22");
    expect(draftsOf("answer").map(([, v]) => v)).toContain("처음 글 그 사이에 더 씀");
  });

  it("더 쓰지 않았으면 기존대로 보낸 초안을 비운다", async () => {
    const h = await boot({ questions: pick("q-22") });
    await h.user.type(field("q-22"), "그대로");
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitSent("q-22");
    expect(draftsOf("answer")).toEqual([]);
  });
});

describe("정의 목록 구조 (권장 8)", () => {
  it("기본값·추천 단추는 dl 의 div 가 아니라 dd 안에 있다", async () => {
    await boot({ questions: pick("q-21") });
    const buttons = [...aside().querySelectorAll<HTMLElement>("dl button")];
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const b of buttons) expect(b.closest("dd"), b.textContent ?? "").not.toBeNull();
    expect(screen.getAllByText("기본값").length).toBeGreaterThan(0);
  });
});

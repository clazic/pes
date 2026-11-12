// SEL-91 U2b — 1차 리뷰(R1) 수정: 정리 대화 상자 모달 · 유형 바꿀 때 기본값 정리 · 거르는 중 이동/저장/추가 · 미리보기 · 굵은 포인터 (Vitest, jsdom, 가짜 클라이언트).
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { CURRENT } from "@/test/contract";
import { aside, boot, closedPanel, editor, filterRadio, item, maybeItem, openOrder } from "@/test/u2b";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

type User = Awaited<ReturnType<typeof boot>>["user"];
const tool = (name: string) => within(aside()).getByRole("button", { name });
const field = (form: HTMLElement, label: string) => within(form).getByLabelText(label);

async function openTidy(user: User, n: number) {
  await user.click(tool(`질문 ${n} 정리`));
  return within(aside()).getByRole("group", { name: `질문 ${n} 정리` });
}

describe("정리 대화 상자는 모달", () => {
  it("모달이다: 열린 동안 뒤 화면이 접근성 트리에서 빠지고, Tab 이 대화 상자 안에 갇힌다", async () => {
    const { user } = await boot();
    const group = await openTidy(user, 23);
    await user.click(within(group).getByRole("button", { name: "철회" }));
    const dlg = await screen.findByRole("dialog", { name: "질문 23 철회" });
    expect(screen.queryByRole("complementary", { name: "질문" })).toBeNull();
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(dlg.contains(document.activeElement)).toBe(true);
    }
    await user.tab({ shift: true });
    expect(dlg.contains(document.activeElement)).toBe(true);
  });

  it("Esc 로 닫으면 명령 0번이고 초점은 연 단추(철회)로 돌아온다", async () => {
    const { user, calls } = await boot();
    const group = await openTidy(user, 23);
    await user.click(within(group).getByRole("button", { name: "철회" }));
    await screen.findByRole("dialog", { name: "질문 23 철회" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "질문 23 철회" })).toBeNull());
    expect(calls("withdrawQuestion")).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("tidy-withdraw-q-23")));
  });

  it("보류 대화 상자도 Esc 로 닫으면 명령 0번이고 질문은 열려 있다", async () => {
    const { user, calls } = await boot();
    const group = await openTidy(user, 23);
    await user.click(within(group).getByRole("button", { name: "보류" }));
    await screen.findByRole("dialog", { name: "질문 23 보류" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls("deferQuestion")).toHaveLength(0);
    expect(openOrder()).toContain("q-23");
  });
});

describe("유형을 바꿀 때 기본값 정리", () => {
  it("하나 고르기 → 글로 답하기: 기본값 칸이 비고, 저장 본문의 default_value 는 null, 선택지는 없다", async () => {
    const { user, calls } = await boot();
    await user.click(tool("질문 21 고치기"));
    const form = editor(21);
    expect(field(form, "기본값")).toHaveDisplayValue("따로 보기");
    await user.selectOptions(field(form, "유형"), "글로 답하기");
    expect((field(form, "기본값") as HTMLInputElement).value).toBe("");
    await user.click(within(form).getByRole("button", { name: "새 버전으로 저장" }));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(1));
    const body = calls("reviseQuestion")[0].args[3] as Record<string, unknown>;
    expect(body).toMatchObject({ kind: "free_text", options: [], default_value: null });
    await waitFor(() => expect(item("q-21").textContent).not.toContain("split"));
  });

  it("글로 답하기 → 하나 고르기: 쓰던 글 기본값이 선택지 칸에 새지 않는다", async () => {
    const { user, calls } = await boot({
      questions: [{ id: "q-22", number: 22, version: 1, required: false, importance: "normal", source: "ai", text: "글 질문", kind: "free_text", options: [], default_value: "직접 쓴 기본 글", status: "open", direction: "ask_human" }],
    });
    await user.click(tool("질문 22 고치기"));
    const form = editor(22);
    expect((field(form, "기본값") as HTMLInputElement).value).toBe("직접 쓴 기본 글");
    await user.selectOptions(field(form, "유형"), "하나 고르기");
    expect(field(form, "기본값")).toHaveDisplayValue("없음");
    await user.type(field(form, "선택지 1"), "가");
    await user.type(field(form, "선택지 2"), "나");
    await user.click(within(form).getByRole("button", { name: "새 버전으로 저장" }));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(1));
    expect((calls("reviseQuestion")[0].args[3] as Record<string, unknown>).default_value).toBeNull();
  });

  it("선택지 유형끼리 바꿀 때는 기본값을 지우지 않는다", async () => {
    const { user } = await boot();
    await user.click(tool("질문 21 고치기"));
    const form = editor(21);
    await user.selectOptions(field(form, "유형"), "여러 개 고르기");
    expect(field(form, "기본값")).toHaveDisplayValue("따로 보기");
  });
});

describe("거르는 중에 이동·저장·추가", () => {
  it("‘높음’ 거르기에서 위로 옮기면 보이는 이웃(21)과 자리를 바꾼다", async () => {
    const { user, calls } = await boot();
    await user.click(filterRadio("높음"));
    await waitFor(() => expect(openOrder()).toEqual(["q-21", "q-24"]));
    await user.click(tool("질문 24 위로 옮기기"));
    await waitFor(() => expect(calls("reorderQuestions")).toHaveLength(1));
    expect(calls("reorderQuestions")[0].args[4]).toEqual(["q-24", "q-22", "q-23", "q-21"]);
    await waitFor(() => expect(openOrder()).toEqual(["q-24", "q-21"]));
  });

  it("거르는 중 가장자리 판정은 보이는 질문 기준이다(첫 보이는 질문은 위로 옮길 수 없다)", async () => {
    const { user, calls } = await boot();
    await user.click(filterRadio("높음"));
    await waitFor(() => expect(openOrder()).toEqual(["q-21", "q-24"]));
    expect(tool("질문 24 아래로 옮기기")).toHaveAttribute("aria-disabled", "true");
    expect(tool("질문 21 위로 옮기기")).toHaveAttribute("aria-disabled", "true");
    expect(tool("질문 21 아래로 옮기기")).not.toHaveAttribute("aria-disabled", "true");
    await user.click(tool("질문 21 위로 옮기기"));
    expect(calls("reorderQuestions")).toHaveLength(0);
  });

  it("‘높음’ 거르기에서 중요도를 보통으로 저장하면 초점이 거르기로 가고 알림이 숨은 것을 알린다", async () => {
    const { user, calls } = await boot();
    await user.click(filterRadio("높음"));
    await user.click(tool("질문 24 고치기"));
    const form = editor(24);
    await user.selectOptions(field(form, "중요도"), "보통");
    await user.click(within(form).getByRole("button", { name: "새 버전으로 저장" }));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(1));
    await waitFor(() => expect(maybeItem("q-24")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(filterRadio("높음")));
    expect(within(aside()).getAllByRole("status").map((e) => e.textContent).join(" ")).toContain("지금 거르기에서는 보이지 않아요");
  });

  it("‘높음’ 거르기에서 중요도 없는 질문을 더하면 초점이 거르기로 가고, ‘전체’에서는 보인다", async () => {
    const { user } = await boot();
    await user.click(filterRadio("높음"));
    await user.click(tool("질문 더하기"));
    const dlg = await screen.findByRole("dialog", { name: "질문 더하기" });
    await user.type(within(dlg).getByLabelText("질문 문장"), "거르기에 안 걸리는 새 질문");
    await user.click(within(dlg).getByRole("button", { name: "추가하기" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "질문 더하기" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(filterRadio("높음")));
    expect(within(aside()).getAllByRole("status").map((e) => e.textContent).join(" ")).toContain("지금 거르기에서는 보이지 않아요");
    expect(maybeItem("q-30")).toBeNull();
    await user.click(filterRadio("전체"));
    expect(maybeItem("q-30")).not.toBeNull();
  });
});

describe("닫힌 질문 미리보기", () => {
  it("주소의 peek 가 닫힌(철회된) 질문이면 미리보기를 열지 않는다", async () => {
    await boot({}, `${CURRENT}?peek=q-26`);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(closedPanel().querySelector('[data-question="q-26"]')).not.toBeNull();
  });
});

describe("고치기 칸의 누르는 크기", () => {
  it("글·선택 칸과 ‘필수’ 라벨에 굵은 포인터용 44px 클래스가 있다", async () => {
    const { user } = await boot();
    await user.click(tool("질문 22 고치기"));
    const form = editor(22);
    for (const label of ["질문 문장", "유형", "중요도", "방향", "기본값"]) expect(field(form, label).className).toContain("coarse:min-h-[44px]");
    expect(within(form).getByText("필수").closest("label")?.className).toContain("coarse:min-h-[44px]");
  });
});

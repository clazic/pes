// SEL-92 U2c — 질문별 의견(스레드·메시지) 쓰기·보기 · 답과 섞이지 않음 · 이전된 합성 프로젝트(__other 스레드) · 접근성 (Vitest, jsdom, 가짜 클라이언트).
// 계약: src/test/u2c.ts 머리말. 구현은 아직 없다 — 실패해야 정상(요구사항 때문에 실패).
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { NotConnectedError } from "@/api/types";
import { LEGACY_QUESTIONS, touchRound } from "@/test/u2b";
import { aside, boot, btn, field, isDisabled, item, leaks, notice, pick, sentNode } from "@/test/u2c";
import { draftEntries } from "@/test/ui";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

const toggle = (n: number) => btn(`질문 ${n} 의견 스레드`);
const thread = (qid: string) => document.querySelector<HTMLElement>(`[data-comments="${qid}"]`);
const box = (qid: string) => document.getElementById(`${qid}-comment`) as HTMLTextAreaElement;
const seed = [
  {
    thread_id: "th-9",
    question_id: "q-21",
    question_version: 1,
    messages: [
      { message_id: "m-1", body_md: "이 질문은 범위가 모호합니다.", by: "human" as const },
      { message_id: "m-2", body_md: "정의 차이를 각주로 밝히면 됩니다.", by: "ai" as const },
    ],
  },
];

describe("질문별 의견 보기", () => {
  it("스레드 단추는 aria-expanded 로 접히고, 펴면 그 질문의 메시지가 순서대로 보인다", async () => {
    const h = await boot({ questions: pick("q-21", "q-22"), threads: seed });
    expect(toggle(21)).toHaveAttribute("aria-expanded", "false");
    expect(thread("q-21")).toBeNull();
    await h.user.click(toggle(21));
    expect(toggle(21)).toHaveAttribute("aria-expanded", "true");
    const msgs = [...thread("q-21")!.querySelectorAll("li[data-message]")];
    expect(msgs.map((m) => m.querySelector('[data-field-kind="comment"]')?.textContent)).toEqual(["이 질문은 범위가 모호합니다.", "정의 차이를 각주로 밝히면 됩니다."]);
    // 다른 질문 카드에는 이 스레드가 없다
    await h.user.click(toggle(22));
    expect(thread("q-22")!.querySelectorAll("li[data-message]")).toHaveLength(0);
  });

  it("의견은 답이 아니다: 의견 노드는 보낸 답 노드·기본값·추천·의견 칸과 다른 노드이고 보낸 답 칸에 들어가지 않는다", async () => {
    const h = await boot({ questions: pick("q-21"), threads: seed });
    await h.user.click(toggle(21));
    const comment = item("q-21").querySelector('[data-field-kind="comment"]')!;
    expect(comment.closest('[data-field-kind="answer"]')).toBeNull();
    expect(comment.closest('[data-field-kind="opinion"]')).toBeNull();
    expect(sentNode("q-21")).toBeNull();
    expect(h.calls("submitAnswers")).toHaveLength(0);
  });

  it("누가 썼는지(나 · AI)를 글로 밝힌다", async () => {
    const h = await boot({ questions: pick("q-21"), threads: seed });
    await h.user.click(toggle(21));
    const msgs = [...thread("q-21")!.querySelectorAll("li[data-message]")];
    expect(msgs[0]!.textContent).toContain("나");
    expect(msgs[1]!.textContent).toContain("AI");
  });

  it("마크다운 글에 든 HTML 은 글자로만 보인다 (스크립트를 그리지 않는다)", async () => {
    const evil = [{ thread_id: "th-x", question_id: "q-21", messages: [{ message_id: "m-x", body_md: "<img src=x onerror=alert(1)><b>굵게</b>" }] }];
    const h = await boot({ questions: pick("q-21"), threads: evil });
    await h.user.click(toggle(21));
    expect(thread("q-21")!.querySelector("img, script")).toBeNull();
    expect(thread("q-21")!.textContent).toContain("<b>굵게</b>");
  });
});

describe("질문별 의견 쓰기", () => {
  it("글이 비면 ‘스레드에 남기기’는 aria-disabled 이고 호출 0", async () => {
    const h = await boot({ questions: pick("q-21") });
    await h.user.click(toggle(21));
    const send = within(thread("q-21")!).getByRole("button", { name: "스레드에 남기기" });
    expect(isDisabled(send)).toBe(true);
    await h.user.click(send);
    expect(h.calls("addComment")).toHaveLength(0);
  });

  it("새 스레드: thread_id 없이 한 번 보내고, 영수증 뒤에만 접수 번호와 메시지가 보인다 (답은 안 만든다)", async () => {
    const h = await boot({ questions: pick("q-21", "q-24") });
    await h.user.click(toggle(21));
    await h.user.type(box("q-21"), "범위를 좁혀 주세요");
    const release = h.hold();
    await h.user.click(within(thread("q-21")!).getByRole("button", { name: "스레드에 남기기" }));
    await waitFor(() => expect(h.calls("addComment")).toHaveLength(1));
    expect(thread("q-21")!.querySelectorAll("li[data-message]")).toHaveLength(0);
    expect(notice()).not.toMatch(/접수 \d{4}/);
    release();
    await waitFor(() => expect(thread("q-21")!.querySelectorAll("li[data-message]")).toHaveLength(1));
    expect(notice()).toMatch(/접수 \d{4}/);
    const args = h.calls("addComment")[0]!.args as [string, number, string, { body_md: string; thread_id?: string }, string];
    expect(args[2]).toBe("q-21");
    expect(args[3].body_md).toBe("범위를 좁혀 주세요");
    expect(args[3].thread_id).toBeUndefined();
    expect(args[4]).toEqual(expect.any(String));
    // 의견은 답을 만들지 않는다
    expect(h.calls("submitAnswers")).toHaveLength(0);
    expect(sentNode("q-21")).toBeNull();
    expect(h.questions().find((q) => q.id === "q-21")!.sent).toBeUndefined();
    expect(box("q-21").value).toBe("");
  });

  it("이미 스레드가 있으면 그 thread_id 로 메시지만 더한다", async () => {
    const h = await boot({ questions: pick("q-21"), threads: seed });
    await h.user.click(toggle(21));
    await h.user.type(box("q-21"), "알겠습니다");
    await h.user.click(within(thread("q-21")!).getByRole("button", { name: "스레드에 남기기" }));
    await waitFor(() => expect(thread("q-21")!.querySelectorAll("li[data-message]")).toHaveLength(3));
    expect((h.calls("addComment")[0]!.args as unknown[])[3]).toMatchObject({ thread_id: "th-9", body_md: "알겠습니다" });
    expect(h.threads()).toHaveLength(1);
  });

  it("allow_comment_as_answer 질문에서도 스레드 의견은 필수를 채우지 않는다 (묶음 검토에서 여전히 비어 있는 필수)", async () => {
    const h = await boot({ questions: pick("q-22", "q-24") });
    await h.user.click(toggle(24));
    await h.user.type(box("q-24"), "스레드로만 말합니다");
    await h.user.click(within(thread("q-24")!).getByRole("button", { name: "스레드에 남기기" }));
    await waitFor(() => expect(h.calls("addComment")).toHaveLength(1));
    await h.user.type(field("q-22"), "출처");
    await h.user.click(btn("답 검토 후 보내기"));
    const dlg = await screen.findByRole("dialog", { name: "답 검토" });
    expect(dlg.querySelector('[data-missing="q-24"]')).not.toBeNull();
  });

  it("거절되면 role=alert 로 알리고 글을 지우지 않으며, 같은 글을 다시 누르면 같은 멱등 키", async () => {
    const h = await boot({ questions: pick("q-21") });
    await h.user.click(toggle(21));
    await h.user.type(box("q-21"), "다시 시도할 글");
    h.failNextWrite(new Error("연결 끊김"));
    const send = () => within(thread("q-21")!).getByRole("button", { name: "스레드에 남기기" });
    await h.user.click(send());
    await waitFor(() => expect(within(aside()).queryAllByRole("alert").length).toBeGreaterThan(0));
    expect(box("q-21").value).toBe("다시 시도할 글");
    expect(thread("q-21")!.querySelectorAll("li[data-message]")).toHaveLength(0);
    await h.user.click(send());
    await waitFor(() => expect(h.calls("addComment")).toHaveLength(2));
    const keys = h.calls("addComment").map((c) => (c.args as unknown[])[4]);
    expect(keys[0]).toBe(keys[1]);
  });

  it("의견 초안은 접었다 펴도·다시 읽어도 남고, 한글 조합 중에는 저장하지 않으며, 성공한 뒤에만 지워진다", async () => {
    const h = await boot({ questions: pick("q-21") });
    await h.user.click(toggle(21));
    const el = box("q-21");
    fireEvent.compositionStart(el);
    fireEvent.change(el, { target: { value: "ㅇ" } });
    expect(draftEntries(/q-21.*comment/)).toHaveLength(0);
    fireEvent.compositionEnd(el, { data: "의" });
    fireEvent.change(el, { target: { value: "의견 초안" } });
    await waitFor(() => expect(draftEntries(/q-21.*comment/)).toHaveLength(1));
    await h.user.click(toggle(21));
    await h.user.click(toggle(21));
    expect(box("q-21").value).toBe("의견 초안");
    const reads = h.calls("getRound").length;
    h.mutate(() => {});
    h.s.queueChanges(touchRound());
    await waitFor(() => expect(h.calls("getRound").length).toBeGreaterThan(reads), { timeout: 4000 });
    expect(box("q-21").value).toBe("의견 초안");
    await h.user.click(within(thread("q-21")!).getByRole("button", { name: "스레드에 남기기" }));
    await waitFor(() => expect(draftEntries(/q-21.*comment/)).toHaveLength(0));
  });
});

describe("이전된 합성 프로젝트", () => {
  it("__other 스레드는 ‘질문에 묶이지 않은 의견’ 칸에 보이고 아무 것도 깨지지 않는다", async () => {
    const other = [{ thread_id: "th-old", question_id: "__other", messages: [{ message_id: "m-old", body_md: "옛 의견 하나" }] }];
    await boot({ questions: LEGACY_QUESTIONS, threads: other });
    const region = screen.getByRole("region", { name: "질문에 묶이지 않은 의견" });
    expect(within(region).getByText("옛 의견 하나")).toBeTruthy();
    expect(item("q-21").textContent).toContain("이전된 합성 질문 하나");
    expect(leaks(aside())).toEqual([]);
  });

  it("중요도·종류·선택지가 없는 옛 질문에도 답 초안·개별 제출이 되고, 기본값·추천 단추는 없다", async () => {
    const h = await boot({ questions: LEGACY_QUESTIONS });
    expect(within(aside()).queryByRole("button", { name: /기본값 쓰기|추천 쓰기/ })).toBeNull();
    await h.user.type(field("q-21"), "이전된 질문에 답");
    await h.user.click(btn("질문 21 이 답만 보내기"));
    await waitFor(() => expect(h.calls("submitAnswers")).toHaveLength(1));
    expect((h.calls("submitAnswers")[0]!.args[4] as { answers: { question_version: number }[] }).answers[0]!.question_version).toBe(1);
  });

  it("스레드가 하나도 없어도 ‘질문에 묶이지 않은 의견’ 칸은 그리지 않는다", async () => {
    await boot({ questions: LEGACY_QUESTIONS });
    expect(screen.queryByRole("region", { name: "질문에 묶이지 않은 의견" })).toBeNull();
  });
});

describe("의견을 읽는 길이 없을 때(http 모드)", () => {
  it("getComments 가 NotConnectedError 여도 질문 영역은 깨지지 않고, 스레드를 열면 읽지 못했다고 정직하게 알린다 (빈 스레드로 단정하지 않는다)", async () => {
    const h = await boot({ questions: pick("q-21", "q-22"), commentsError: new NotConnectedError("의견 읽기") });
    expect(item("q-21")).toBeTruthy();
    await h.user.click(toggle(21));
    await waitFor(() => expect(thread("q-21")!.textContent).toMatch(/읽지 못|이어지지 않/));
    expect(thread("q-21")!.textContent).not.toMatch(/의견이 없어요|아직 의견이 없/);
    expect(leaks(aside())).toEqual([]);
    // 쓰기는 따로 시도할 수 있다
    expect(within(thread("q-21")!).getByRole("button", { name: "스레드에 남기기" })).toBeTruthy();
  });
});

describe("접근성", () => {
  it("스레드 단추·의견 칸·남기기 단추에 굵은 포인터용 44px 클래스가 있다", async () => {
    const h = await boot({ questions: pick("q-21", "q-22") }, undefined, { coarse: true });
    for (const el of [toggle(21), btn("질문 21 기본값 쓰기"), btn("질문 21 이 답만 보내기"), btn("답 검토 후 보내기")]) expect(el.className, el.textContent ?? "").toContain("coarse:min-h-[44px]");
    await h.user.click(toggle(21));
    expect(box("q-21").className).toContain("coarse:min-h-[44px]");
    expect(within(thread("q-21")!).getByRole("button", { name: "스레드에 남기기" }).className).toContain("coarse:min-h-[44px]");
  });

  it("스레드 영역은 단추가 aria-controls 로 가리키고, 의견 칸에는 보이는 라벨이 질문 번호를 포함한다", async () => {
    const h = await boot({ questions: pick("q-21") });
    await h.user.click(toggle(21));
    const region = thread("q-21")!;
    expect(toggle(21).getAttribute("aria-controls")).toBe(region.id);
    expect(screen.getByLabelText("질문 21 스레드 의견 쓰기")).toBe(box("q-21"));
  });

  it("J/K 질문 이동은 의견 칸에서 글자로 들어간다", async () => {
    const h = await boot({ questions: pick("q-21", "q-22") });
    await h.user.click(toggle(21));
    await h.user.type(box("q-21"), "jk");
    expect(box("q-21").value).toBe("jk");
    expect(document.activeElement).toBe(box("q-21"));
  });
});

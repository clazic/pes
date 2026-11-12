// SEL-92 U2c — 답 초안 · 기본값 · 추천 · 재확인 뒤 재답변 · 초안 보존 (Vitest, jsdom, 가짜 클라이언트).
// 계약: src/test/u2c.ts 머리말. 구현은 아직 없다 — 실패해야 정상(요구사항 때문에 실패).
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { touchRound } from "@/test/u2b";
import { aside, boot, btn, checkedIn, field, isDisabled, item, maybeBtn, notice, opinion, pick, sentNode, waitSent } from "@/test/u2c";
import { draftEntries } from "@/test/ui";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("기본값 · 추천은 초안에만 들어가고 제출 전에는 답이 아니다", () => {
  it("처음에는 답 칸이 비어 있고 기본값·추천 단추가 따로 있다 (보낸 답 노드 없음)", async () => {
    await boot({ questions: pick("q-21", "q-22") });
    expect(checkedIn("q-21")).toEqual([]);
    expect(field("q-22").value).toBe("");
    expect(sentNode("q-21")).toBeNull();
    expect(btn("질문 21 기본값 쓰기")).not.toBe(btn("질문 21 추천 쓰기"));
    expect(btn("질문 22 기본값 쓰기")).toBeTruthy();
    // 추천이 없는 질문에는 추천 단추가 없다
    expect(maybeBtn("질문 22 추천 쓰기")).toBeNull();
  });

  it("‘기본값 쓰기’는 선택지 초안만 채운다: 쓰기 호출 0 · 보낸 답 노드 없음 · 서버 상태 그대로", async () => {
    const { user, calls, questions } = await boot({ questions: pick("q-21", "q-22") });
    await user.click(btn("질문 21 기본값 쓰기"));
    expect(checkedIn("q-21")).toEqual(["따로 보기"]);
    expect(sentNode("q-21")).toBeNull();
    expect(calls("submitAnswers")).toHaveLength(0);
    expect(questions().find((q) => q.id === "q-21")!.sent).toBeUndefined();
    // 초안은 이 탭에만(sessionStorage)
    expect(draftEntries(/q-21.*answer/).length).toBe(1);
  });

  it("‘기본값 쓰기’(글)는 답 칸에 글을 채울 뿐 보내지 않는다", async () => {
    const { user, calls } = await boot({ questions: pick("q-22") });
    await user.click(btn("질문 22 기본값 쓰기"));
    expect(field("q-22").value).toBe("추가 출처 없음");
    expect(calls("submitAnswers")).toHaveLength(0);
    expect(sentNode("q-22")).toBeNull();
  });

  it("‘추천 쓰기’도 초안만 채우고, 기본값과 다른 값이다(서로 다른 단추·다른 선택)", async () => {
    const { user, calls } = await boot({ questions: pick("q-21") });
    await user.click(btn("질문 21 추천 쓰기"));
    expect(checkedIn("q-21")).toEqual(["이어 보기"]);
    expect(calls("submitAnswers")).toHaveLength(0);
    expect(sentNode("q-21")).toBeNull();
    // 기본값을 누르면 추천 선택이 기본값으로 바뀐다(둘이 섞여 두 개가 되지 않는다)
    await user.click(btn("질문 21 기본값 쓰기"));
    expect(checkedIn("q-21")).toEqual(["따로 보기"]);
  });

  it("값 구분: 기본값 · 추천 · 보낸 답이 서로 다른 노드, 서로 다른 말로 보인다", async () => {
    const q = pick("q-21")[0]!;
    await boot({ questions: [{ ...q, sent: { answer: "이어 보기", receipt_no: "0301", tx_id: "tx-301", committed_at: "2026-11-10T09:00:00+09:00" } }] });
    const el = item("q-21");
    const kinds = ["answer", "default", "recommendation"].map((k) => el.querySelector(`[data-field-kind="${k}"]`));
    expect(kinds.every(Boolean)).toBe(true);
    expect(new Set(kinds).size).toBe(3);
    expect(kinds[1]!.textContent).toContain("기본값");
    expect(kinds[2]!.textContent).toContain("AI 추천");
    expect(kinds[0]!.textContent).toContain("이어 보기");
    expect(kinds[0]!.textContent).not.toContain("AI 추천");
  });

  it("글 유형에서 기본값을 쓴 뒤 제출하면 used_default=true, 고쳐 쓰면 false (제출 때만 기록)", async () => {
    const h = await boot({ questions: pick("q-22") });
    await h.user.click(btn("질문 22 기본값 쓰기"));
    expect(h.calls("submitAnswers")).toHaveLength(0);
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitSent("q-22");
    expect(h.submitted()).toHaveLength(1);
    expect(h.submitted()[0]).toMatchObject({ question_id: "q-22", value: "추가 출처 없음", used_default: true, mode: "single" });
  });

  it("기본값을 쓴 뒤 사람이 고치면 used_default=false 로 간다", async () => {
    const h = await boot({ questions: pick("q-22") });
    await h.user.click(btn("질문 22 기본값 쓰기"));
    await h.user.type(field("q-22"), " 다만 지역 도서관");
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitSent("q-22");
    expect(h.submitted()[0]).toMatchObject({ value: "추가 출처 없음 다만 지역 도서관", used_default: false });
  });

  it("추천을 쓴 답은 used_default=false (추천은 기본값이 아니다)", async () => {
    const h = await boot({ questions: pick("q-21") });
    await h.user.click(btn("질문 21 추천 쓰기"));
    await h.user.click(btn("질문 21 이 답만 보내기"));
    await waitSent("q-21");
    expect(h.submitted()[0]).toMatchObject({ value: "join", used_default: false });
  });

  it("기본값을 직접 클릭으로 고른 답은 ‘기본값 쓰기’를 거치지 않았으므로 used_default=false", async () => {
    const h = await boot({ questions: pick("q-21") });
    await h.user.click(within(item("q-21")).getByRole("radio", { name: "따로 보기" }));
    await h.user.click(btn("질문 21 이 답만 보내기"));
    await waitSent("q-21");
    expect(h.submitted()[0]).toMatchObject({ value: "split", used_default: false });
  });

  it("보낸 뒤에는 보낸 답이 기본값 채택이었다고 표시된다(읽기), 제출 전에는 표시가 없다", async () => {
    const h = await boot({ questions: pick("q-22") });
    expect(item("q-22").querySelector("[data-used-default]")).toBeNull();
    await h.user.click(btn("질문 22 기본값 쓰기"));
    expect(item("q-22").querySelector('[data-field-kind="answer"]')).toBeNull();
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitSent("q-22");
    expect(sentNode("q-22")!.textContent).toContain("추가 출처 없음");
  });
});

describe("새 문구 확인 뒤 재답변 (재확인 필요 질문)", () => {
  it("재확인 필요 질문은 ‘새 문구를 확인했어요’ 전에는 보낼 수 없다 (aria-disabled · 호출 0 · 옛 답은 입력 칸에 없음)", async () => {
    const h = await boot({ questions: pick("q-26") });
    expect(item("q-26").querySelector('[data-badge="recheck"]')).not.toBeNull();
    expect(checkedIn("q-26")).toEqual([]);
    await h.user.click(within(item("q-26")).getByRole("radio", { name: "합쳐 세기" }));
    const send = btn("질문 26 이 답만 보내기");
    expect(isDisabled(send)).toBe(true);
    await h.user.click(send);
    expect(h.calls("submitAnswers")).toHaveLength(0);
  });

  it("확인 체크 뒤 새 답을 보내면 새 질문 버전(3)으로 가고, 재확인 배지가 사라지며 옛 답은 남는다", async () => {
    const h = await boot({ questions: pick("q-26") });
    await h.user.click(within(item("q-26")).getByRole("radio", { name: "합쳐 세기" }));
    await h.user.click(screen.getByRole("checkbox", { name: "질문 26 새 문구를 확인했어요" }));
    await h.user.click(btn("질문 26 이 답만 보내기"));
    await waitSent("q-26");
    expect(h.submitted()[0]).toMatchObject({ question_id: "q-26", question_version: 3, value: "yes" });
    await waitFor(() => expect(item("q-26").querySelector('[data-badge="recheck"]')).toBeNull());
    // 옛 답(버전 2)은 지워지지 않고 옛 답으로 따로 보인다 — 새 답과 다른 노드
    expect(item("q-26").querySelector('[data-badge="old-answer"]')).not.toBeNull();
    expect(sentNode("q-26")!.textContent).toContain("합쳐 세기");
    expect(sentNode("q-26")!.textContent).not.toContain("따로 세기");
  });

  it("묶음 제출에서도 확인 체크를 안 한 재확인 질문은 빠진다(보내지 않는다)", async () => {
    const h = await boot({ questions: pick("q-22", "q-26") });
    await h.user.type(field("q-22"), "알려 드릴 출처");
    await h.user.click(within(item("q-26")).getByRole("radio", { name: "합쳐 세기" }));
    await h.user.click(btn("답 검토 후 보내기"));
    const dlg = await screen.findByRole("dialog", { name: "답 검토" });
    expect(dlg.querySelector('[data-review-item="q-22"]')).not.toBeNull();
    expect(dlg.querySelector('[data-review-item="q-26"]')).toBeNull();
  });
});

describe("초안 보존 (F04)", () => {
  it("답·의견 초안은 갱신(changes → 다시 읽기)과 폼 버전 상승에도 노드·값·초점이 그대로다", async () => {
    const h = await boot({ questions: pick("q-22", "q-24") });
    await h.user.type(field("q-22"), "쓰던 답");
    await h.user.type(opinion("q-22"), "쓰던 의견");
    const box = field("q-22");
    box.focus();
    act(() => h.mutate((qs) => qs.push({ id: "q-90", number: 90, version: 1, required: false, source: "human", text: "남이 더한 질문", kind: "free_text", options: [], status: "open", direction: "ask_human" })));
    h.s.queueChanges(touchRound());
    await waitFor(() => expect(document.querySelector('[data-question="q-90"]')).not.toBeNull(), { timeout: 4000 });
    expect(field("q-22")).toBe(box);
    expect(field("q-22").value).toBe("쓰던 답");
    expect(opinion("q-22").value).toBe("쓰던 의견");
    expect(document.activeElement).toBe(box);
  });

  it("보낸 질문의 초안만 지워지고, 안 보낸 질문의 초안은 남는다", async () => {
    const h = await boot({ questions: pick("q-22", "q-24") });
    await h.user.type(field("q-22"), "보낼 답");
    await h.user.type(field("q-24"), "남겨 둘 답");
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitSent("q-22");
    expect(draftEntries(/q-22.*answer/)).toHaveLength(0);
    expect(draftEntries(/q-24.*answer/)).toHaveLength(1);
    expect(field("q-24").value).toBe("남겨 둘 답");
  });

  it("거절된 제출은 초안을 지우지 않는다", async () => {
    const h = await boot({ questions: pick("q-22") });
    await h.user.type(field("q-22"), "거절돼도 남을 답");
    h.failNextWrite(new Error("연결 끊김"));
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitFor(() => expect(within(aside()).queryAllByRole("alert").length).toBeGreaterThan(0));
    expect(field("q-22").value).toBe("거절돼도 남을 답");
    expect(draftEntries(/q-22.*answer/)).toHaveLength(1);
    expect(sentNode("q-22")).toBeNull();
  });

  it("한글 조합 중에는 저장하지 않고 조합이 끝나면 저장한다 (IME)", async () => {
    await boot({ questions: pick("q-22") });
    const box = field("q-22");
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: "ㅎ" } });
    fireEvent.change(box, { target: { value: "한" } });
    expect(draftEntries(/q-22.*answer/)).toHaveLength(0);
    fireEvent.compositionEnd(box, { data: "한" });
    await waitFor(() => expect(draftEntries(/q-22.*answer/)).toHaveLength(1));
  });

  it("질문이 새 버전이 되면 옛 초안은 몰래 새 질문으로 옮겨 가지 않는다(알림 없이 비어 있고, 옛 초안은 남는다)", async () => {
    const h = await boot({ questions: pick("q-22") });
    await h.user.type(field("q-22"), "옛 버전에서 쓴 답");
    act(() => h.mutate((qs) => Object.assign(qs.find((q) => q.id === "q-22")!, { version: 2, text: "문구가 바뀐 질문", needs_recheck: true })));
    h.s.queueChanges(touchRound());
    await waitFor(() => expect(item("q-22").textContent).toContain("문구가 바뀐 질문"), { timeout: 4000 });
    expect(field("q-22").value).not.toBe("옛 버전에서 쓴 답");
    expect(draftEntries(/q-22.*answer/).some(([, v]) => v === "옛 버전에서 쓴 답")).toBe(true);
    expect(notice()).not.toMatch(/접수/);
  });
});

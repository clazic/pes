// SEL-92 U2c — 묶음/개별 제출 · 필수·조건부 검증 · 부분 접수 0 · allow_comment_as_answer · 영수증 뒤 성공(F06) · 시간 초과 (Vitest, jsdom, 가짜 클라이언트).
// 계약: src/test/u2c.ts 머리말. 구현은 아직 없다 — 실패해야 정상(요구사항 때문에 실패).
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { activeQuestion, alertText, aside, boot, btn, field, isDisabled, item, leaks, notice, opinion, pick, requiredMissing, reviewDialog, sentNode, timeoutError, waitSent, withFields } from "@/test/u2c";
import { draftEntries } from "@/test/ui";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

const pickRadio = (qid: string, label: string, user: Awaited<ReturnType<typeof boot>>["user"]) => user.click(within(item(qid)).getByRole("radio", { name: label }));

describe("개별 제출 — 그 질문만, 폼 완료를 주장하지 않는다", () => {
  it("‘이 답만 보내기’는 그 질문 하나만 mode single 로 보낸다 (다른 초안은 건드리지 않는다)", async () => {
    const h = await boot({ questions: pick("q-21", "q-22", "q-24") });
    await h.user.type(field("q-22"), "출처 하나");
    await h.user.type(field("q-24"), "다른 질문의 초안");
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitSent("q-22");
    const calls = h.calls("submitAnswers");
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[4] as { mode: string; answers: { question_id: string; question_version: number }[] };
    expect(input.mode).toBe("single");
    expect(input.answers).toEqual([expect.objectContaining({ question_id: "q-22", question_version: 1, value: "출처 하나" })]);
    expect(calls[0]!.args[5]).toEqual(expect.any(String));
    // 다른 질문은 보내지도 지워지지도 않는다
    expect(sentNode("q-24")).toBeNull();
    expect(field("q-24").value).toBe("다른 질문의 초안");
  });

  it("다른 필수 질문이 비어 있으면 알림이 폼이 끝났다고 말하지 않고 남은 필수 개수를 알린다", async () => {
    const h = await boot({ questions: pick("q-22", "q-24") });
    await h.user.type(field("q-22"), "출처 하나");
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitSent("q-22");
    const text = notice();
    expect(text).toMatch(/접수 \d{4}/);
    expect(text).toContain("이 답만");
    expect(text).toMatch(/필수 1개/);
    expect(text).not.toMatch(/모두|완료|끝났|다 보냈/);
  });

  it("초안이 비면 ‘이 답만 보내기’는 aria-disabled 이고 눌러도 호출 0", async () => {
    const h = await boot({ questions: pick("q-22") });
    const send = btn("질문 22 이 답만 보내기");
    expect(isDisabled(send)).toBe(true);
    await h.user.click(send);
    expect(h.calls("submitAnswers")).toHaveLength(0);
  });

  it("글 칸 앞뒤 공백만 있는 초안은 빈 초안이다", async () => {
    const h = await boot({ questions: pick("q-22") });
    await h.user.type(field("q-22"), "   ");
    expect(isDisabled(btn("질문 22 이 답만 보내기"))).toBe(true);
    expect(h.calls("submitAnswers")).toHaveLength(0);
  });

  it("여러 개 고르기는 선택지 id 배열로 보낸다", async () => {
    const q23 = withFields(pick("q-23")[0]!, { show_if: null });
    const h = await boot({ questions: [q23] });
    await h.user.click(within(item("q-23")).getByRole("checkbox", { name: "각주" }));
    await h.user.click(within(item("q-23")).getByRole("checkbox", { name: "그림 설명" }));
    await h.user.click(btn("질문 23 이 답만 보내기"));
    await waitSent("q-23");
    expect(h.submitted()[0]!.value).toEqual(["foot", "chart"]);
  });

  it("두 번 눌러도 요청은 한 번이다", async () => {
    const h = await boot({ questions: pick("q-22") });
    await h.user.type(field("q-22"), "한 번만");
    const release = h.hold();
    const send = btn("질문 22 이 답만 보내기");
    await h.user.click(send);
    await h.user.click(send);
    release();
    await waitSent("q-22");
    expect(h.calls("submitAnswers")).toHaveLength(1);
  });
});

describe("묶음 제출 — 필수·조건부 검증", () => {
  it("‘답 검토 후 보내기’는 초안이 하나도 없으면 aria-disabled", async () => {
    const h = await boot({ questions: pick("q-21", "q-22") });
    const open = btn("답 검토 후 보내기");
    expect(isDisabled(open)).toBe(true);
    await h.user.click(open);
    expect(screen.queryByRole("dialog", { name: "답 검토" })).toBeNull();
  });

  it("검토 대화 상자는 보낼 항목과 비어 있는 적용 필수 질문을 따로 보이고, 필수가 비면 확정이 막힌다 (호출 0)", async () => {
    const h = await boot({ questions: pick("q-21", "q-22", "q-24") });
    await h.user.type(field("q-22"), "출처");
    await h.user.click(btn("답 검토 후 보내기"));
    const dlg = await reviewDialog();
    expect(dlg.querySelector('[data-review-item="q-22"]')).not.toBeNull();
    expect(dlg.querySelector('[data-review-item="q-21"]')).toBeNull();
    expect(dlg.querySelector('[data-missing="q-21"]')?.textContent).toContain("질문 21");
    expect(dlg.querySelector('[data-missing="q-24"]')?.textContent).toContain("질문 24");
    const confirm = within(dlg).getByRole("button", { name: "묶음으로 보내기" });
    expect(isDisabled(confirm)).toBe(true);
    await h.user.click(confirm);
    expect(h.calls("submitAnswers")).toHaveLength(0);
  });

  it("필수를 모두 채우면 한 번의 묶음 호출 — mode bundle, 항목은 보낼 질문들, 접수 뒤 폼 완료를 알린다", async () => {
    const h = await boot({ questions: pick("q-21", "q-22", "q-24") });
    await pickRadio("q-21", "이어 보기", h.user);
    await h.user.type(field("q-24"), "가정 정리");
    await h.user.type(field("q-22"), "출처 하나");
    await h.user.click(btn("답 검토 후 보내기"));
    const dlg = await reviewDialog();
    expect(dlg.querySelector("[data-missing]")).toBeNull();
    await h.user.click(within(dlg).getByRole("button", { name: "묶음으로 보내기" }));
    await waitSent("q-21");
    const calls = h.calls("submitAnswers");
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[4] as { mode: string; form_version: number; answers: { question_id: string }[] };
    expect(input.mode).toBe("bundle");
    expect(input.form_version).toEqual(expect.any(Number));
    expect(input.answers.map((a) => a.question_id).sort()).toEqual(["q-21", "q-22", "q-24"]);
    expect(new Set(h.submitted().map((s) => s.key)).size).toBe(1);
    expect(notice()).toMatch(/묶음/);
    expect(notice()).toMatch(/접수 \d{4}/);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "답 검토" })).toBeNull());
    for (const id of ["q-21", "q-22", "q-24"]) expect(draftEntries(new RegExp(`${id}.*answer`))).toHaveLength(0);
  });

  it("기본값을 그대로 보내는 항목은 검토 대화 상자에 [data-used-default] 로 따로 드러나고 used_default=true 로 간다", async () => {
    const h = await boot({ questions: pick("q-21", "q-22", "q-24") });
    await h.user.click(btn("질문 21 기본값 쓰기"));
    await h.user.type(field("q-24"), "가정 정리");
    await h.user.click(btn("답 검토 후 보내기"));
    const dlg = await reviewDialog();
    expect(dlg.querySelector('[data-review-item="q-21"] [data-used-default], [data-review-item="q-21"][data-used-default]')).not.toBeNull();
    expect(dlg.querySelector('[data-review-item="q-24"] [data-used-default], [data-review-item="q-24"][data-used-default]')).toBeNull();
    await h.user.click(within(dlg).getByRole("button", { name: "묶음으로 보내기" }));
    await waitSent("q-21");
    const byId = Object.fromEntries(h.submitted().map((s) => [s.question_id, s.used_default]));
    expect(byId).toMatchObject({ "q-21": true, "q-24": false });
  });

  it("취소하면 호출 0 이고 초안은 그대로다", async () => {
    const h = await boot({ questions: pick("q-22") });
    await h.user.type(field("q-22"), "아직 안 보냄");
    await h.user.click(btn("답 검토 후 보내기"));
    const dlg = await reviewDialog();
    await h.user.click(within(dlg).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "답 검토" })).toBeNull());
    expect(h.calls("submitAnswers")).toHaveLength(0);
    expect(field("q-22").value).toBe("아직 안 보냄");
  });

  it("묶음 확정을 두 번 눌러도 요청은 한 번이다", async () => {
    const h = await boot({ questions: pick("q-22") });
    await h.user.type(field("q-22"), "한 번만");
    await h.user.click(btn("답 검토 후 보내기"));
    const dlg = await reviewDialog();
    const release = h.hold();
    const confirm = within(dlg).getByRole("button", { name: "묶음으로 보내기" });
    await h.user.click(confirm);
    await h.user.click(confirm);
    release();
    await waitSent("q-22");
    expect(h.calls("submitAnswers")).toHaveLength(1);
  });

  it("의견 칸 글은 그 항목의 comment 로 함께 간다 (답과 같은 칸이 아니다)", async () => {
    const h = await boot({ questions: pick("q-22") });
    await h.user.type(field("q-22"), "답입니다");
    await h.user.type(opinion("q-22"), "이건 의견입니다");
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitSent("q-22");
    expect(h.submitted()[0]).toMatchObject({ value: "답입니다", comment: "이건 의견입니다" });
    expect(sentNode("q-22")!.textContent).not.toContain("이건 의견입니다");
  });
});

describe("조건부 필수 (show_if)", () => {
  it("조건이 안 맞는 필수 질문은 적용되지 않는다: data-applicable=false · 필수 취급 안 함 · 묶음에서 빠진다 (초안은 남는다)", async () => {
    const h = await boot({ questions: pick("q-21", "q-25") });
    await pickRadio("q-21", "이어 보기", h.user); // q-25 는 ‘따로 보기’일 때만
    expect(item("q-25").getAttribute("data-applicable")).toBe("false");
    await h.user.click(btn("답 검토 후 보내기"));
    const dlg = await reviewDialog();
    expect(dlg.querySelector('[data-missing="q-25"]')).toBeNull();
    await h.user.click(within(dlg).getByRole("button", { name: "묶음으로 보내기" }));
    await waitSent("q-21");
    expect((h.calls("submitAnswers")[0]!.args[4] as { answers: { question_id: string }[] }).answers.map((a) => a.question_id)).toEqual(["q-21"]);
  });

  it("조건이 맞게 되면 같은 질문이 필수가 되어 묶음 확정이 막힌다", async () => {
    const h = await boot({ questions: pick("q-21", "q-25") });
    await pickRadio("q-21", "따로 보기", h.user);
    expect(item("q-25").getAttribute("data-applicable")).not.toBe("false");
    await h.user.click(btn("답 검토 후 보내기"));
    const dlg = await reviewDialog();
    expect(dlg.querySelector('[data-missing="q-25"]')?.textContent).toContain("질문 25");
    expect(isDisabled(within(dlg).getByRole("button", { name: "묶음으로 보내기" }))).toBe(true);
  });

  it("조건이 안 맞게 된 질문에 써 둔 초안은 보내지 않지만 지우지도 않는다", async () => {
    const h = await boot({ questions: pick("q-21", "q-25") });
    await pickRadio("q-21", "따로 보기", h.user);
    await h.user.type(field("q-25"), "2021");
    await pickRadio("q-21", "이어 보기", h.user);
    await h.user.click(btn("답 검토 후 보내기"));
    const dlg = await reviewDialog();
    expect(dlg.querySelector('[data-review-item="q-25"]')).toBeNull();
    expect(field("q-25").value).toBe("2021");
  });
});

describe("allow_comment_as_answer 허용 / 불허 두 사례", () => {
  it("허용(q-24): 필수인데 의견 칸 글만 있어도 필수가 채워진다 — 묶음이 접수되고 항목은 value null + comment", async () => {
    const h = await boot({ questions: pick("q-22", "q-24") });
    await h.user.type(opinion("q-24"), "답 대신 의견으로 남깁니다");
    await h.user.click(btn("답 검토 후 보내기"));
    const dlg = await reviewDialog();
    expect(dlg.querySelector('[data-missing="q-24"]')).toBeNull();
    await h.user.click(within(dlg).getByRole("button", { name: "묶음으로 보내기" }));
    await waitFor(() => expect(h.calls("submitAnswers")).toHaveLength(1));
    const item24 = (h.calls("submitAnswers")[0]!.args[4] as { answers: { question_id: string; value: unknown; comment?: string }[] }).answers.find((a) => a.question_id === "q-24")!;
    expect(item24.value).toBeNull();
    expect(item24.comment).toBe("답 대신 의견으로 남깁니다");
    await waitFor(() => expect(notice()).toMatch(/접수 \d{4}/));
  });

  it("불허(q-25 에 해당하는 필수): 의견 칸 글만으로는 필수가 채워지지 않는다 — 비어 있는 필수로 남고 호출 0", async () => {
    const h = await boot({ questions: pick("q-21", "q-25") });
    await pickRadio("q-21", "따로 보기", h.user);
    await h.user.type(opinion("q-25"), "의견만 씁니다");
    await h.user.click(btn("답 검토 후 보내기"));
    const dlg = await reviewDialog();
    expect(dlg.querySelector('[data-missing="q-25"]')).not.toBeNull();
    await h.user.click(within(dlg).getByRole("button", { name: "묶음으로 보내기" }));
    expect(h.calls("submitAnswers")).toHaveLength(0);
  });

  it("개별 제출도 같다: 불허 질문은 의견만으로는 ‘이 답만 보내기’가 aria-disabled(호출 0), 허용 질문은 의견만으로 보낼 수 있다", async () => {
    const h = await boot({ questions: pick("q-24", "q-25") });
    await h.user.type(opinion("q-25"), "의견만");
    await h.user.click(btn("질문 25 이 답만 보내기"));
    expect(isDisabled(btn("질문 25 이 답만 보내기"))).toBe(true);
    expect(h.calls("submitAnswers")).toHaveLength(0);
    await h.user.type(opinion("q-24"), "의견이 곧 답");
    expect(isDisabled(btn("질문 24 이 답만 보내기"))).toBe(false);
    await h.user.click(btn("질문 24 이 답만 보내기"));
    await waitFor(() => expect(h.calls("submitAnswers")).toHaveLength(1));
    expect(h.submitted()[0]).toMatchObject({ question_id: "q-24", value: null, comment: "의견이 곧 답" });
  });
});

describe("충돌·거절 — 부분 접수 0 을 정직하게", () => {
  it("보던 질문 버전이 그 사이 바뀌었으면(conflict) 아무것도 접수되지 않았다고 알리고 초안·화면 답은 그대로다", async () => {
    const h = await boot({ questions: pick("q-22", "q-24") });
    await h.user.type(field("q-22"), "내 답");
    await h.user.type(field("q-24"), "내 가정");
    // 화면은 모르는 사이 다른 곳에서 q-24 가 새 버전이 됐다
    h.mutate((qs) => Object.assign(qs.find((q) => q.id === "q-24")!, { version: 2, text: "바뀐 문구", needs_recheck: true }));
    await h.user.click(btn("답 검토 후 보내기"));
    const dlg = await reviewDialog();
    await h.user.click(within(dlg).getByRole("button", { name: "묶음으로 보내기" }));
    await waitFor(() => expect(alertText()).toContain("아무것도 접수되지 않았어요"));
    expect(h.submitted()).toHaveLength(0);
    expect(sentNode("q-22")).toBeNull();
    expect(sentNode("q-24")).toBeNull();
    expect(notice()).not.toMatch(/접수 \d{4}/);
    // 초안은 지키되 옛 버전 키라 새 질문 칸에는 몰래 옮기지 않는다 — 옛 초안은 저장소에 남는다
    expect(draftEntries(/q-22.*answer/)).toHaveLength(1);
    expect(draftEntries(/q-24.*answer/).some(([, v]) => v === "내 가정")).toBe(true);
  });

  it("서버가 required_missing 으로 거절하면 빠진 질문을 이름으로 알리고 ‘질문 N로 가기’가 그 질문에 초점을 둔다", async () => {
    const h = await boot({ questions: pick("q-22", "q-24") });
    await h.user.type(field("q-22"), "출처");
    await h.user.type(opinion("q-24"), "의견");
    h.failNextWrite(requiredMissing(["q-24"]));
    await h.user.click(btn("답 검토 후 보내기"));
    const dlg = await reviewDialog();
    await h.user.click(within(dlg).getByRole("button", { name: "묶음으로 보내기" }));
    await waitFor(() => expect(alertText()).toContain("아무것도 접수되지 않았어요"));
    expect(alertText()).toContain("질문 24");
    expect(sentNode("q-22")).toBeNull();
    expect(h.submitted()).toHaveLength(0);
    const go = await screen.findByRole("button", { name: "질문 24로 가기" });
    await h.user.click(go);
    expect(activeQuestion()).toBe("q-24");
    expect(field("q-22").value).toBe("출처");
  });

  it("거절 뒤 같은 요청을 다시 누르면 같은 멱등 키, 초안을 바꾸면 새 키", async () => {
    const h = await boot({ questions: pick("q-22") });
    await h.user.type(field("q-22"), "첫 글");
    h.failNextWrite(new Error("연결 끊김"));
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitFor(() => expect(alertText()).not.toBe(""));
    h.failNextWrite(new Error("또 끊김"));
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitFor(() => expect(h.calls("submitAnswers")).toHaveLength(2));
    const keys = h.calls("submitAnswers").map((c) => c.args[5]);
    expect(keys[0]).toBe(keys[1]);
    await h.user.type(field("q-22"), " 고침");
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitSent("q-22");
    const all = h.calls("submitAnswers").map((c) => c.args[5]);
    expect(all[2]).not.toBe(all[0]);
  });
});

describe("성공은 영수증 뒤에만 (F06) · 시간 초과", () => {
  it("영수증을 받기 전(붙잡힌 동안)에는 보낸 답 노드도 ‘접수’ 글도 없고, 받은 뒤에 접수 번호와 함께 생긴다", async () => {
    const h = await boot({ questions: pick("q-22") });
    await h.user.type(field("q-22"), "보내는 중");
    const release = h.hold();
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitFor(() => expect(h.calls("submitAnswers")).toHaveLength(1));
    expect(sentNode("q-22")).toBeNull();
    expect(notice()).not.toMatch(/접수 \d{4}/);
    expect(isDisabled(btn("질문 22 이 답만 보내기"))).toBe(true);
    release();
    await waitSent("q-22");
    expect(notice()).toMatch(/접수 \d{4}/);
  });

  it("시간 초과: ‘접수 확인 중’ — 성공도 실패도 단정하지 않고 보낸 답 노드는 없다", async () => {
    const h = await boot({ questions: pick("q-22") });
    await h.user.type(field("q-22"), "응답이 늦는 답");
    h.failNextWrite(timeoutError());
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitFor(() => expect(notice()).toContain("접수 확인 중"));
    expect(sentNode("q-22")).toBeNull();
    expect(notice()).not.toMatch(/접수 \d{4}/);
    expect(field("q-22").value).toBe("응답이 늦는 답");
  });

  it("‘접수 다시 확인’은 같은 요청·같은 멱등 키로 다시 보내고, 영수증 재생(replayed)이어도 성공으로 처리한다", async () => {
    const h = await boot({ questions: pick("q-22") });
    await h.user.type(field("q-22"), "응답이 늦는 답");
    h.failNextWrite(timeoutError());
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitFor(() => expect(notice()).toContain("접수 확인 중"));
    await h.user.click(btn("접수 다시 확인"));
    await waitSent("q-22");
    const calls = h.calls("submitAnswers");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args[5]).toBe(calls[0]!.args[5]);
    expect(calls[1]!.args[4]).toEqual(calls[0]!.args[4]);
    expect(h.submitted()).toHaveLength(1);
  });

});

describe("화면 글자", () => {
  it("‘Go’ · undefined · null 이 새지 않는다 (제출 뒤·거절 뒤 포함)", async () => {
    const h = await boot({ questions: pick("q-21", "q-22", "q-24") });
    await h.user.type(field("q-22"), "출처");
    h.failNextWrite(requiredMissing(["q-21"]));
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitFor(() => expect(alertText()).not.toBe(""));
    expect(leaks(aside())).toEqual([]);
  });
});

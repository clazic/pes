// SEL-92 U2c 최종 리뷰 3/3(CHANGES) 수정 — 화면 (Vitest, jsdom, 가짜 클라이언트).
// 필수 1: U2a 의 실제 409 `question_version_changed`(next_action=reread_question)를 버전 충돌로 처리한다 — 라운드를 다시 읽고 새 문구 재확인 흐름으로.
// 필수 2: sessionStorage 쓰기가 막혀(QuotaExceededError) 메모리에 둔 최신 재시도 기록이 저장소의 옛 기록보다 먼저 읽힌다.
import { waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FORMAT_VERSION, PesApiError, NotConnectedError, type ApiErrorCode } from "@/api/types";
import { aside, boot, btn, field, alertText, pick, sentNode, timeoutError, reviewDialog } from "@/test/u2c";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

/** origin/main 의 실제 U2a 봉투(docs/plan/fixtures/api-v1/submissions.json 의 409) */
const realQuestionVersionChanged = (questionId: string) =>
  new PesApiError({
    format_version: FORMAT_VERSION,
    error: {
      code: "question_version_changed" as ApiErrorCode,
      message: "답변 대상 질문 버전이 바뀌었습니다. 새 버전을 확인해 주세요.",
      retryable: false,
      target: "$.body.answers[0].question_version_id",
      details: { expected: "qvr_stale_01J9Z3K7Q2", current: "qvr_01J9Z3K7QC", question_id: questionId },
      next_action: "reread_question",
    },
    request_id: "req_sub_err_01J9Z3K7QN",
  });

describe("실제 U2a 409 question_version_changed 를 버전 충돌로 처리한다 (필수 1)", () => {
  it("라운드를 다시 읽어 바뀐 문구를 보이고, 새 문구 재확인 안내를 하며, 아무것도 접수되지 않았다고 알린다", async () => {
    const h = await boot({ questions: pick("q-22", "q-24") });
    await h.user.type(field("q-24"), "내 가정");
    // 화면은 모르는 사이 서버에서 q-24 가 새 버전이 됐다 — 서버는 실제 U2a 봉투로 거절한다
    h.mutate((qs) => Object.assign(qs.find((q) => q.id === "q-24")!, { version: 2, text: "바뀐 문구", needs_recheck: true }));
    h.failNextWrite(realQuestionVersionChanged("q-24"));
    await h.user.click(btn("질문 24 이 답만 보내기"));
    await waitFor(() => expect(alertText()).toContain("아무것도 접수되지 않았어요"));
    // 새 문구를 읽었다고 알린다(재조회 + 안내)
    expect(alertText()).toContain("새로 읽었어요");
    await waitFor(() => expect(within(aside()).getAllByText(/바뀐 문구/).length).toBeGreaterThan(0));
    expect(h.submitted()).toHaveLength(0);
    expect(sentNode("q-24")).toBeNull();
    // 쓰던 글은 옛 버전 칸의 초안으로 남고(새 질문 칸으로 몰래 옮기지 않는다), 새 문구는 ‘확인했어요’ 전에는 보낼 수 없다
    expect(Object.values({ ...window.sessionStorage })).toContain("내 가정");
    expect(within(aside()).getByRole("checkbox", { name: "질문 24 새 문구를 확인했어요" })).toBeTruthy();
  });

  it("묶음 제출도 같다 — 거절 뒤 라운드를 다시 읽는다", async () => {
    const h = await boot({ questions: pick("q-22", "q-24") });
    await h.user.type(field("q-22"), "내 답");
    await h.user.type(field("q-24"), "내 가정");
    h.mutate((qs) => Object.assign(qs.find((q) => q.id === "q-24")!, { version: 2, text: "바뀐 문구", needs_recheck: true }));
    h.failNextWrite(realQuestionVersionChanged("q-24"));
    await h.user.click(btn("답 검토 후 보내기"));
    const dlg = await reviewDialog();
    await h.user.click(within(dlg).getByRole("button", { name: "묶음으로 보내기" }));
    await waitFor(() => expect(alertText()).toContain("새로 읽었어요"));
    await waitFor(() => expect(within(aside()).getAllByText(/바뀐 문구/).length).toBeGreaterThan(0));
    expect(h.submitted()).toHaveLength(0);
  });
});

describe("sessionStorage 쓰기 실패 때 메모리의 최신 재시도 기록이 먼저 읽힌다 (필수 2)", () => {
  it("기존 기록이 있는 상태에서 QuotaExceededError → 접수 후 타임아웃 → 같은 의견 재시도는 같은 키·접수 1건", async () => {
    const h = await boot({ questions: pick("q-21"), commentsError: new NotConnectedError("의견 읽기") });
    const toggle = btn("질문 21 의견 스레드");
    const box = () => document.getElementById("q-21-comment") as HTMLTextAreaElement;
    const send = () => within(document.querySelector<HTMLElement>('[data-comments="q-21"]')!).getByRole("button", { name: "스레드에 남기기" });
    // 1) 의견 A — 접수됐지만 응답을 못 받았다 → 저장소에 A 의 재시도 기록이 남는다
    await h.user.click(toggle);
    await h.user.type(box(), "A");
    h.failNextWrite(timeoutError());
    await h.user.click(send());
    await waitFor(() => expect(h.calls("addComment")).toHaveLength(1));
    await waitFor(() => expect(Object.keys({ ...window.sessionStorage }).some((k) => k.startsWith("pes-cmd:"))).toBe(true));
    // 2) 글을 B 로 바꾸고, 이제부터 pes-cmd: 항목 갱신만 저장소가 가득 찼다고 거절한다
    await h.user.clear(box());
    await h.user.type(box(), "B");
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith("pes-cmd:")) throw new DOMException("quota", "QuotaExceededError");
      return real.call(this, k, v);
    });
    // 3) B — 서버는 접수했지만 응답이 오지 않는다(시간 초과)
    const calls: string[] = [];
    const orig = h.client.addComment.bind(h.client);
    h.client.addComment = ((...a: Parameters<typeof orig>) => {
      calls.push(String(a[4]));
      return orig(...a).then(() => Promise.reject(timeoutError()));
    }) as typeof orig;
    await h.user.click(send());
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(within(document.querySelector<HTMLElement>('[data-comments="q-21"]')!).getByRole("alert").textContent).toContain("두 번 처리되지 않습니다"));
    // 4) 같은 B 를 다시 보낸다 — 같은 키여야 하고, 서버에는 B 가 한 건만 있다
    await h.user.click(send());
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toBe(calls[0]);
    const bodies = h.threads().flatMap((t) => t.messages).map((m) => m.body_md);
    expect(bodies.filter((b) => b === "B")).toHaveLength(1);
  });
});

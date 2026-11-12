// SEL-98 U2d — 의견 목록이 실제로 이어지면 첫 응답 뒤 threads 가 갱신되어 thread_id 가 재시도 서명(sig)에 들어간다 → 같은 의견의 재시도 키가 바뀌어 두 번 접수될 수 있다.
// SEL-98 댓글(SEL-92 최종 3차 worker 메모): "같은 의견에 대해 재시도 키가 안정적인지 시험으로 고정할 것". (Vitest, jsdom, 가짜 클라이언트 — src/test/u2c.ts)
//
// 스스로 정한 해석:
//  - '같은 의견' = 보내려던 글(body_md)과 질문이 같고, 확인이 끝나지 않은(영수증을 못 받은) 요청. 그 재시도는 같은 키 + 같은 요청 내용(첫 요청 그대로: thread_id 없음)으로 가야 서버가 재생한다
//    (키는 같은데 내용이 다르면 서버가 409 idempotency_key_reuse, 키가 다르면 의견이 두 번 접수된다).
//  - 중간에 의견 목록을 다시 읽어 방금 보낸 의견의 스레드가 보여도, 확인 중인 요청의 키·내용은 바뀌지 않는다. 확인이 끝난 뒤(영수증)에는 다음 의견이 그 스레드로 이어지고 새 키를 쓴다.
import { fireEvent, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { boot, btn, item, notice, pick, timeoutError } from "@/test/u2c";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

const toggle = (n: number) => btn(`질문 ${n} 의견 스레드`);
const thread = (qid: string) => document.querySelector<HTMLElement>(`[data-comments="${qid}"]`)!;
const box = (qid: string) => document.getElementById(`${qid}-comment`) as HTMLTextAreaElement;

/** 첫 addComment 만 '서버는 받았는데 답이 안 옴'(시간 초과)으로 만든다 */
function lostReplyOnce(h: Awaited<ReturnType<typeof boot>>) {
  const real = h.client.addComment.bind(h.client);
  let first = true;
  (h.client as { addComment: typeof h.client.addComment }).addComment = async (...args) => {
    const out = await real(...args);
    if (first) {
      first = false;
      throw timeoutError();
    }
    return out;
  };
}

describe("의견 재시도 키 안정성", () => {
  it("첫 요청이 서버에 닿았지만 답을 못 받은 뒤 의견 목록이 갱신되어도, 재시도는 같은 키 · 같은 요청(thread_id 없음)이고 의견은 한 번만 접수된다", async () => {
    const h = await boot({ questions: pick("q-21"), threads: [] });
    lostReplyOnce(h);
    await h.user.click(toggle(21));
    fireEvent.change(box("q-21"), { target: { value: "범위가 모호합니다" } });
    await h.user.click(within(thread("q-21")).getByRole("button", { name: "스레드에 남기기" }));
    await waitFor(() => expect(within(thread("q-21")).getByRole("alert").textContent).toContain("두 번 처리되지 않습니다"));
    expect(h.calls("addComment")).toHaveLength(1);
    const [first] = h.calls("addComment");
    expect((first!.args[3] as { thread_id?: string }).thread_id).toBeUndefined();
    expect(h.threads()).toHaveLength(1); // 서버는 이미 스레드를 만들었다

    // 변경분이 와서 의견 목록을 다시 읽는다 — 이제 화면은 방금 만들어진 스레드를 안다
    const reads = h.calls("getComments").length;
    // 실제 http 서버의 변경분은 라운드에 닿는 사건을 'round:*' 로 알린다(http-client touchedBy) — 의견 읽기 쿼리도 그 아래에 있다
    h.s.queueChanges({ cursor: "c-98", txs: [{ tx_id: "tx-98", touched: ["round:*"] }] });
    await waitFor(() => expect(h.calls("getComments").length).toBeGreaterThan(reads), { timeout: 4000 });
    await waitFor(() => expect(item("q-21").querySelectorAll("li[data-message]").length).toBe(1));

    await h.user.click(within(thread("q-21")).getByRole("button", { name: "스레드에 남기기" }));
    await waitFor(() => expect(h.calls("addComment")).toHaveLength(2));
    const second = h.calls("addComment")[1]!;
    expect(second.args[4], "같은 의견의 재시도는 같은 멱등 키").toBe(first!.args[4]);
    expect((second.args[3] as { thread_id?: string }).thread_id, "같은 요청 내용(첫 요청에는 thread_id 가 없었다)").toBeUndefined();
    await waitFor(() => expect(notice()).toMatch(/접수\s*\d{4}/));
    expect(h.threads()[0]!.messages, "의견이 두 번 접수되지 않았다").toHaveLength(1);
  });

  it("영수증을 받은 뒤의 다음 의견은 방금 만든 스레드로 이어지고 새 키를 쓴다 (안정성이 새 의견까지 묶지 않는다)", async () => {
    const h = await boot({ questions: pick("q-21"), threads: [] });
    await h.user.click(toggle(21));
    fireEvent.change(box("q-21"), { target: { value: "첫 의견" } });
    await h.user.click(within(thread("q-21")).getByRole("button", { name: "스레드에 남기기" }));
    await waitFor(() => expect(h.calls("addComment")).toHaveLength(1));
    await waitFor(() => expect(notice()).toMatch(/접수\s*\d{4}/));
    await waitFor(() => expect(item("q-21").querySelectorAll("li[data-message]").length).toBe(1));
    fireEvent.change(box("q-21"), { target: { value: "둘째 의견" } });
    await h.user.click(within(thread("q-21")).getByRole("button", { name: "스레드에 남기기" }));
    await waitFor(() => expect(h.calls("addComment")).toHaveLength(2));
    const [one, two] = h.calls("addComment");
    expect(two!.args[4]).not.toBe(one!.args[4]);
    expect((two!.args[3] as { thread_id?: string }).thread_id).toBe("th-1");
    expect(h.threads()[0]!.messages).toHaveLength(2);
  });
});

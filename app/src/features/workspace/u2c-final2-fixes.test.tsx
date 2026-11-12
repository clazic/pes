// SEL-92 U2c 최종 리뷰 2/2(CHANGES) 수정 — 화면 (Vitest, jsdom, 가짜 클라이언트).
// 필수 1: 답 제출 영수증 뒤에도 조합 중인 답 · 의견 칸(입력 노드)을 조합이 끝날 때까지 유지하고, 조합이 끝난 글을 저장한다.
// 필수 2: 늦게 온 이전 의견 응답이 새 시도의 재시도 키를 지우지 않는다.
import { fireEvent, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { NotConnectedError, type CommandResult, type PesClient } from "@/api/types";
import { CURRENT } from "@/test/contract";
import { renderApp } from "@/test/render-app";
import { ready } from "@/test/ui";
import { boot, btn, createU2cClient, field, notice, opinion, pick, sentNode, timeoutError, waitSent } from "@/test/u2c";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

const draftsOf = (kind: string) => Object.entries({ ...window.sessionStorage }).filter(([k]) => k.startsWith("pes-draft:") && k.endsWith(`|${kind}`)).map(([, v]) => v);
const toggle = (n: number) => btn(`질문 ${n} 의견 스레드`);
const thread = (qid: string) => document.querySelector<HTMLElement>(`[data-comments="${qid}"]`)!;
const box = (qid: string) => document.getElementById(`${qid}-comment`) as HTMLTextAreaElement;

describe("답 제출 영수증 뒤에도 조합 중인 칸은 남는다 (필수 1)", () => {
  it("답 칸 — 보내는 중 조합을 시작한 칸이 영수증·재조회 뒤에도 있고, 조합이 끝난 글이 저장된다", async () => {
    const h = await boot({ questions: pick("q-22") });
    await h.user.type(field("q-22"), "처음 글");
    const release = h.hold();
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitFor(() => expect(h.calls("submitAnswers")).toHaveLength(1));
    fireEvent.compositionStart(field("q-22"));
    fireEvent.change(field("q-22"), { target: { value: "처음 글 추가ㅎ" } });
    release();
    await waitSent("q-22");
    await waitFor(() => expect(notice()).toContain("접수"));
    // 입력 노드가 사라지면 안 된다 — 조합이 끝날 노드가 있어야 한다(필수 확인; 조건부 검사가 아니다)
    const still = field("q-22");
    expect(still).not.toBeNull();
    expect(still.value).toBe("처음 글 추가ㅎ");
    // 보낸 답(영수증 스냅숏)과 그 뒤 쓰는 글은 따로 보인다
    expect(sentNode("q-22")).not.toBeNull();
    fireEvent.change(still, { target: { value: "처음 글 추가해" } });
    fireEvent.compositionEnd(still);
    expect(field("q-22").value).toBe("처음 글 추가해");
    expect(draftsOf("answer")).toEqual(["처음 글 추가해"]);
  });

  it("조합이 끝난 글은 화면을 다시 열어도 남는다(unmount → remount)", async () => {
    const h = await boot({ questions: pick("q-22") });
    await h.user.type(field("q-22"), "처음 글");
    const release = h.hold();
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitFor(() => expect(h.calls("submitAnswers")).toHaveLength(1));
    fireEvent.compositionStart(field("q-22"));
    fireEvent.change(field("q-22"), { target: { value: "처음 글 추가ㅎ" } });
    release();
    await waitSent("q-22");
    fireEvent.change(field("q-22"), { target: { value: "처음 글 추가해" } });
    fireEvent.compositionEnd(field("q-22"));
    h.unmount();
    const again = await renderApp(CURRENT, { width: 1440 }, { client: h.client });
    await ready();
    await waitSent("q-22");
    expect(field("q-22").value).toBe("처음 글 추가해");
    again.unmount();
  });

  it("답에 붙이는 의견 칸도 같다 — 조합 중인 의견 칸이 영수증 뒤에도 남는다", async () => {
    const h = await boot({ questions: pick("q-22") });
    await h.user.type(field("q-22"), "답");
    await h.user.type(opinion("q-22"), "의견");
    const release = h.hold();
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitFor(() => expect(h.calls("submitAnswers")).toHaveLength(1));
    fireEvent.compositionStart(opinion("q-22"));
    fireEvent.change(opinion("q-22"), { target: { value: "의견 추가ㅎ" } });
    release();
    await waitSent("q-22");
    const still = opinion("q-22");
    expect(still).not.toBeNull();
    expect(still.value).toBe("의견 추가ㅎ");
    fireEvent.change(still, { target: { value: "의견 추가해" } });
    fireEvent.compositionEnd(still);
    expect(draftsOf("opinion")).toEqual(["의견 추가해"]);
  });

  it("보내는 중(조합 아님) 더 쓴 글도 보낸 값과 다르면 칸과 초안을 지우지 않는다", async () => {
    const h = await boot({ questions: pick("q-22") });
    await h.user.type(field("q-22"), "처음 글");
    const release = h.hold();
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitFor(() => expect(h.calls("submitAnswers")).toHaveLength(1));
    await h.user.type(field("q-22"), " 더");
    release();
    await waitSent("q-22");
    expect(field("q-22").value).toBe("처음 글 더");
    expect(draftsOf("answer")).toEqual(["처음 글 더"]);
  });

  it("조합이 영수증 직후에 끝나도 같다 — 끝난 글이 저장된다", async () => {
    const h = await boot({ questions: pick("q-22") });
    await h.user.type(field("q-22"), "처음 글");
    const release = h.hold();
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitFor(() => expect(h.calls("submitAnswers")).toHaveLength(1));
    fireEvent.compositionStart(field("q-22"));
    fireEvent.change(field("q-22"), { target: { value: "처음 글 ㅎ" } });
    release();
    await waitSent("q-22");
    fireEvent.compositionEnd(field("q-22"));
    expect(draftsOf("answer")).toEqual(["처음 글 ㅎ"]);
  });

  it("보낸 그대로면 기존대로 칸도 초안도 비운다", async () => {
    const h = await boot({ questions: pick("q-22") });
    await h.user.type(field("q-22"), "그대로");
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitSent("q-22");
    await waitFor(() => expect(document.getElementById("q-22")).toBeNull());
    expect(draftsOf("answer")).toEqual([]);
  });
});

describe("늦게 온 이전 의견 응답이 새 시도의 재시도 키를 지우지 않는다 (필수 2)", () => {
  type Call = { input: { body_md: string }; key: string; resolve: () => void; fail: () => void };

  async function bootGated() {
    // HTTP 연결처럼 의견 읽기를 아직 모르는 상태(threads=[]) — 리뷰 재현과 같은 조건
    const base = createU2cClient({ questions: pick("q-21"), commentsError: new NotConnectedError("의견 읽기") });
    const calls: Call[] = [];
    const inner = base.client;
    const client = {
      ...inner,
      addComment: (slug: string, edition: number, qid: string, input: { body_md: string; thread_id?: string; question_version?: number }, key: string | undefined) =>
        new Promise<CommandResult<{ thread_id: string; message_id: string; thread_created: boolean }>>((resolve, reject) => {
          calls.push({
            input,
            key: key!,
            // 서버가 접수한 뒤 영수증을 돌려준다
            resolve: () => void inner.addComment(slug, edition, qid, input, key).then(resolve, reject),
            // 서버는 접수했지만 응답을 못 받았다(시간 초과)
            fail: () => void inner.addComment(slug, edition, qid, input, key).then(() => reject(timeoutError()), reject),
          });
        }),
    } as unknown as PesClient;
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    const app = await renderApp(CURRENT, { width: 1440 }, { client });
    await ready();
    return { base, calls, user, app };
  }

  it("A 응답이 B 접수 뒤에 늦게 와도 B 의 재시도는 같은 키로 가서 한 번만 접수된다", async () => {
    const { base, calls, user } = await bootGated();
    await user.click(toggle(21));
    await user.type(box("q-21"), "A");
    await user.click(within(thread("q-21")).getByRole("button", { name: "스레드에 남기기" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    // 스레드를 접었다 펴서 새 컴포넌트에서 글을 B 로 바꿔 보낸다(A 응답은 아직 오지 않았다)
    await user.click(toggle(21));
    await user.click(toggle(21));
    await user.clear(box("q-21"));
    await user.type(box("q-21"), "B");
    await user.click(within(thread("q-21")).getByRole("button", { name: "스레드에 남기기" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.key).not.toBe(calls[0]!.key);
    // 이제 A 의 영수증이 늦게 온다
    calls[0]!.resolve();
    await waitFor(() => expect(notice()).toContain("의견을 남겼어요"));
    // B 는 접수됐지만 응답을 못 받았다
    calls[1]!.fail();
    await waitFor(() => expect(within(thread("q-21")).getByRole("alert").textContent).toContain("두 번 처리되지 않습니다"));
    // 같은 글을 다시 보낸다 — 같은 키여야 한다
    await user.click(within(thread("q-21")).getByRole("button", { name: "스레드에 남기기" }));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]!.key).toBe(calls[1]!.key);
    calls[2]!.resolve();
    await waitFor(() => expect(base.threads().flatMap((t) => t.messages).length).toBe(2));
    expect(base.threads().flatMap((t) => t.messages).map((m) => m.body_md).sort()).toEqual(["A", "B"]);
  });
});

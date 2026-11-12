// SEL-92 U2c 최종 리뷰 1/2(CHANGES) 수정 — 화면 (Vitest, jsdom, 가짜 클라이언트).
// 필수 1: 보내는 중 한글 조합 중인 글을 영수증 뒤에 지우지 않는다(의견 스레드 · 답 칸).
// 필수 2: 접수 결과를 모르는 의견은 스레드를 접었다 펴도 같은 멱등 키로 다시 확인한다(이중 접수 0).
import { fireEvent, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { boot, btn, field, notice, pick, timeoutError, waitSent } from "@/test/u2c";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

const toggle = (n: number) => btn(`질문 ${n} 의견 스레드`);
const thread = (qid: string) => document.querySelector<HTMLElement>(`[data-comments="${qid}"]`)!;
const box = (qid: string) => document.getElementById(`${qid}-comment`) as HTMLTextAreaElement;
const draftsOf = (kind: string) => Object.entries({ ...window.sessionStorage }).filter(([k]) => k.startsWith("pes-draft:") && k.endsWith(`|${kind}`)).map(([, v]) => v);

describe("보내는 중 조합 중인 글은 영수증 뒤에도 남는다 (필수 1)", () => {
  it("의견 스레드 — 조합 중인 새 글이 화면에도 초안에도 지워지지 않고, 조합이 끝나면 저장된다", async () => {
    const h = await boot({ questions: pick("q-21") });
    await h.user.click(toggle(21));
    await h.user.type(box("q-21"), "처음 글");
    const release = h.hold();
    await h.user.click(within(thread("q-21")).getByRole("button", { name: "스레드에 남기기" }));
    await waitFor(() => expect(h.calls("addComment")).toHaveLength(1));
    // 보내는 중에 한글 조합을 시작해 글을 더 쓴다(조합이 끝나기 전에는 저장하지 않는다)
    fireEvent.compositionStart(box("q-21"));
    fireEvent.change(box("q-21"), { target: { value: "처음 글 추가ㅎ" } });
    release();
    await waitFor(() => expect(notice()).toContain("의견을 남겼어요"));
    expect(box("q-21").value).toBe("처음 글 추가ㅎ");
    fireEvent.change(box("q-21"), { target: { value: "처음 글 추가해" } });
    fireEvent.compositionEnd(box("q-21"));
    expect(box("q-21").value).toBe("처음 글 추가해");
    expect(draftsOf("comment")).toContain("처음 글 추가해");
  });

  it("조합 중이 아니고 보낸 그대로면 기존대로 비운다", async () => {
    const h = await boot({ questions: pick("q-21") });
    await h.user.click(toggle(21));
    await h.user.type(box("q-21"), "그대로");
    await h.user.click(within(thread("q-21")).getByRole("button", { name: "스레드에 남기기" }));
    await waitFor(() => expect(notice()).toContain("의견을 남겼어요"));
    expect(box("q-21").value).toBe("");
    expect(draftsOf("comment")).toEqual([]);
  });

  it("답 칸 — 보내는 중 조합 중인 글이 있으면 영수증 뒤에도 칸과 초안을 지우지 않는다", async () => {
    const h = await boot({ questions: pick("q-22") });
    await h.user.type(field("q-22"), "처음 글");
    const release = h.hold();
    await h.user.click(btn("질문 22 이 답만 보내기"));
    await waitFor(() => expect(h.calls("submitAnswers")).toHaveLength(1));
    fireEvent.compositionStart(field("q-22"));
    fireEvent.change(field("q-22"), { target: { value: "처음 글 추가ㅎ" } });
    release();
    await waitSent("q-22");
    // 조합 중이던 칸의 초안을 비우지 않았다(비우면 조합이 끝난 글이 저장될 곳도, 화면 값도 사라진다)
    expect(draftsOf("answer")).toHaveLength(1);
    const still = document.getElementById("q-22") as HTMLTextAreaElement | null;
    if (still) {
      expect(still.value).toBe("처음 글 추가ㅎ");
      fireEvent.compositionEnd(still);
      expect(draftsOf("answer")).toContain("처음 글 추가ㅎ");
    }
  });
});

describe("접수 결과를 모르는 의견은 접었다 펴도 같은 키 (필수 2)", () => {
  const keysOf = (h: Awaited<ReturnType<typeof boot>>) => h.calls("addComment").map((c) => c.args[4] as string);

  it("시간 초과 뒤 스레드를 접었다 펴서 같은 글을 다시 보내도 같은 멱등 키다", async () => {
    const h = await boot({ questions: pick("q-21") });
    await h.user.click(toggle(21));
    await h.user.type(box("q-21"), "한 번만 접수돼야 함");
    h.failNextWrite(timeoutError());
    await h.user.click(within(thread("q-21")).getByRole("button", { name: "스레드에 남기기" }));
    await waitFor(() => expect(within(thread("q-21")).getByRole("alert").textContent).toContain("두 번 처리되지 않습니다"));
    await h.user.click(toggle(21)); // 접기 — 스레드 컴포넌트가 사라진다
    expect(document.querySelector('[data-comments="q-21"]')).toBeNull();
    await h.user.click(toggle(21)); // 펴기
    expect(box("q-21").value).toBe("한 번만 접수돼야 함"); // 초안은 남아 있다
    await h.user.click(within(thread("q-21")).getByRole("button", { name: "스레드에 남기기" }));
    await waitFor(() => expect(notice()).toContain("의견을 남겼어요"));
    const keys = keysOf(h);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(h.threads().flatMap((t) => t.messages)).toHaveLength(1);
  });

  it("글을 바꿔 보내면 새 키 — 다른 요청이므로", async () => {
    const h = await boot({ questions: pick("q-21") });
    await h.user.click(toggle(21));
    await h.user.type(box("q-21"), "첫 글");
    h.failNextWrite(timeoutError());
    await h.user.click(within(thread("q-21")).getByRole("button", { name: "스레드에 남기기" }));
    await waitFor(() => expect(within(thread("q-21")).getByRole("alert")).toBeTruthy());
    await h.user.click(toggle(21));
    await h.user.click(toggle(21));
    await h.user.type(box("q-21"), " 고침");
    await h.user.click(within(thread("q-21")).getByRole("button", { name: "스레드에 남기기" }));
    await waitFor(() => expect(notice()).toContain("의견을 남겼어요"));
    const keys = keysOf(h);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });
});

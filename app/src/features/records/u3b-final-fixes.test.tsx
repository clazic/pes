// SEL-94 U3b 최종 리뷰 1(Codex) 고침 시험 — 변경분 갱신이 기록 읽기에 닿는다 · rev_conflict 복구에서 쓰던 글을 지키지 않는다 · 시험 클라이언트의 base_version_id 계약.
// 기존 시험은 그대로 두고 고친 동작만 새로 못 박는다. 합성 자료뿐.
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FORMAT_VERSION, PesApiError, type ApiErrorCode } from "@/api/types";
import { boot, cellText, rowButton, rowOf, row, type U3Client } from "@/test/u3b";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const dialog = (name: RegExp) => screen.findByRole("dialog", { name });
const submit = (d: HTMLElement) => within(d).getByRole("button", { name: "판단 기록" });
const box = (d: HTMLElement, name: string) => within(d).getByRole("textbox", { name }) as HTMLTextAreaElement;
const receiptText = () => screen.queryAllByRole("status").map((s) => s.textContent ?? "").join(" ");
const apiError = (code: ApiErrorCode, retryable = false, message = "서버 말(시험)") =>
  new PesApiError({ format_version: FORMAT_VERSION, error: { code, message, retryable, next_action: "reread_context" }, request_id: "req-final" });
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const storedA = (u3: U3Client, id: string) => u3.store.assumptions.find((x) => x.object_id === id)!;

describe("필수 1 — 변경분 갱신이 가정·결정·반영 읽기에 닿는다", () => {
  it("다른 곳에서 바뀐 가정·결정이 변경분(workspace) 수신 뒤 표에 반영된다(화면을 옮기지 않아도)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { u3 } = await boot();
    await rowOf("assumption", "as-1");
    await rowOf("decision", "dec-4");
    expect(row("assumption", "as-1")!.getAttribute("data-state")).toBe("proposed");
    const dec = u3.store.decisions.find((x) => x.object_id === "dec-4")!;
    const decBefore = dec.state;

    // 이 화면의 판단 훅을 거치지 않은 외부 변경 — 저장 자료만 바뀐다
    storedA(u3, "as-1").state = "confirmed";
    dec.state = "adopted";
    u3.s.queueChanges({ cursor: "c-ext", txs: [{ tx_id: "tx-ext", touched: ["workspace"] }] });
    await advance(3500);

    await waitFor(() => expect(row("assumption", "as-1")!.getAttribute("data-state")).toBe("confirmed"));
    await waitFor(() => expect(row("decision", "dec-4")!.getAttribute("data-state")).toBe("adopted"));
    expect(decBefore).not.toBe("adopted");
  });

  it("라운드를 구체적으로 가리키는 변경분(round:research/2)은 그 아래 반영 읽기까지 다시 받게 한다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { u3 } = await boot();
    await rowOf("assumption", "as-1");
    const before = u3.readCalls("getReflections").length;
    expect(before).toBeGreaterThan(0);
    u3.s.queueChanges({ cursor: "c-ext2", txs: [{ tx_id: "tx-ext2", touched: ["round:research/2"] }] });
    await advance(3500);
    await waitFor(() => expect(u3.readCalls("getReflections").length).toBeGreaterThan(before));
  });

  it("커서 만료 복구(cursor_expired)도 가정·결정 읽기를 다시 받는다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { u3 } = await boot();
    await rowOf("assumption", "as-1");
    const before = u3.readCalls("getAssumptions").length;
    storedA(u3, "as-1").state = "rejected";
    u3.s.queueChanges(apiError("cursor_expired", false, "커서 만료(시험)"));
    await advance(3500);
    await waitFor(() => expect(u3.readCalls("getAssumptions").length).toBeGreaterThan(before));
    await waitFor(() => expect(row("assumption", "as-1")!.getAttribute("data-state")).toBe("rejected"));
  });
});

describe("필수 2 — rev_conflict 복구에서 쓰던 글을 지킨다", () => {
  /** 가정 고침 대화 상자에서 두 칸을 쓰고, 서버가 rev_conflict 로 거절하게 한 뒤 다시 보기를 누른다 */
  async function conflictOnRevise() {
    const ctx = await boot();
    const { u3, user } = ctx;
    await user.click(rowButton(await rowOf("assumption", "as-1"), "고침"));
    const d = await dialog(/가정 고침/);
    await user.clear(box(d, "고친 가정"));
    await user.type(box(d, "고친 가정"), "F1 보존해야 할 고친 가정");
    await user.type(box(d, "근거"), "F1 보존해야 할 근거");
    u3.failNext(apiError("rev_conflict", false, "기준 버전이 현재와 다릅니다."));
    await user.click(submit(d));
    await within(d).findByRole("button", { name: "다시 보기" });
    return { ...ctx, d };
  }

  it("가정 고침: 다시 보기 뒤 같은 고침을 다시 열면 고친 문장 · 근거가 그대로 있다", async () => {
    const { u3, user, d } = await conflictOnRevise();
    await user.click(within(d).getByRole("button", { name: "다시 보기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(receiptText()).toMatch(/다른 곳에서 바뀌어 다시 읽었어요/);

    await user.click(rowButton(row("assumption", "as-1")!, "고침"));
    const again = await dialog(/가정 고침/);
    expect(box(again, "고친 가정").value).toBe("F1 보존해야 할 고친 가정");
    expect(box(again, "근거").value).toBe("F1 보존해야 할 근거");
    expect(within(again).getByText(/쓰던 글을 그대로 두었어요/)).toBeTruthy();

    // 새 base_version_id · 새 멱등 키로 다시 판단할 수 있다
    storedA(u3, "as-1"); // (그대로 — 충돌은 failNext 로 낸 것이라 저장 버전은 안 바뀌었다)
    await user.click(submit(again));
    await waitFor(() => expect(u3.cmds).toHaveLength(2));
    expect(u3.cmds[1].input).toMatchObject({ verdict: "revise", statement: "F1 보존해야 할 고친 가정", rationale: "F1 보존해야 할 근거", base_version_id: "as-1-v1" });
    expect(u3.cmds[1].key).not.toBe(u3.cmds[0].key);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("그 사이 원문이 바뀌었으면 쓰던 글은 두고 '원문이 바뀌었으니 견주어 보라'고 알리며, 새 version_id 로 보낸다", async () => {
    const { u3, user, d } = await conflictOnRevise();
    const stored = storedA(u3, "as-1");
    stored.version_id = "as-1-v9";
    stored.statement = "도서관 방문 수의 정의는 2021년부터 같다고 본다";
    await user.click(within(d).getByRole("button", { name: "다시 보기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(cellText(row("assumption", "as-1")!, "statement")).toContain("2021년부터"));

    await user.click(rowButton(row("assumption", "as-1")!, "고침"));
    const again = await dialog(/가정 고침/);
    expect(box(again, "고친 가정").value).toBe("F1 보존해야 할 고친 가정");
    expect(box(again, "근거").value).toBe("F1 보존해야 할 근거");
    expect(within(again).getByText(/원문이 바뀌었/)).toBeTruthy();
    // 위 원문(blockquote)은 바뀐 원문
    expect(again.querySelector("blockquote")!.textContent).toContain("2021년부터");
    await user.click(submit(again));
    await waitFor(() => expect(u3.cmds).toHaveLength(2));
    expect(u3.cmds[1].input.base_version_id).toBe("as-1-v9");
  });

  it("결정 대체: 새 결정 · 근거가 다시 보기 뒤에도 남는다. 다른 행 · 다른 동작은 이어받지 않는다", async () => {
    const { u3, user } = await boot();
    await user.click(rowButton(await rowOf("decision", "dec-2"), "대체"));
    const d = await dialog(/결정 대체/);
    await user.type(box(d, "새 결정"), "F1 새 결정 문장");
    await user.type(box(d, "근거"), "F1 대체 근거");
    u3.failNext(apiError("rev_conflict"));
    await user.click(submit(d));
    await user.click(await within(d).findByRole("button", { name: "다시 보기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // 같은 행의 다른 동작(철회)은 빈 칸
    await user.click(rowButton(row("decision", "dec-2")!, "철회"));
    const other = await dialog(/결정 철회/);
    expect(box(other, "근거").value).toBe("");
    await user.click(within(other).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(rowButton(row("decision", "dec-2")!, "대체"));
    const again = await dialog(/결정 대체/);
    expect(box(again, "새 결정").value).toBe("F1 새 결정 문장");
    expect(box(again, "근거").value).toBe("F1 대체 근거");
  });

  it("초안은 한 번만 돌려준다 — 취소했다가 다시 열면 빈 칸", async () => {
    const { user, d } = await conflictOnRevise();
    await user.click(within(d).getByRole("button", { name: "다시 보기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(rowButton(row("assumption", "as-1")!, "고침"));
    const first = await dialog(/가정 고침/);
    expect(box(first, "근거").value).toBe("F1 보존해야 할 근거");
    await user.click(within(first).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(rowButton(row("assumption", "as-1")!, "고침"));
    const second = await dialog(/가정 고침/);
    expect(box(second, "근거").value).toBe("");
  });

  it("다시 읽기가 실패하면 '다시 읽었어요'라고 하지 않고 대화 상자 · 쓰던 글을 그대로 둔다", async () => {
    const { u3, user, d } = await conflictOnRevise();
    u3.breakRead("getAssumptions");
    await user.click(within(d).getByRole("button", { name: "다시 보기" }));
    const alert = await within(d).findByText(/다시 읽지 못했어요/);
    expect(alert).toBeTruthy();
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(box(d, "고친 가정").value).toBe("F1 보존해야 할 고친 가정");
    expect(box(d, "근거").value).toBe("F1 보존해야 할 근거");
    expect(receiptText()).not.toMatch(/다시 읽었어요/);
    // 다시 보기 단추는 다시 누를 수 있다
    expect(within(d).getByRole("button", { name: "다시 보기" }).getAttribute("aria-disabled")).not.toBe("true");
  });
});

describe("권장 1 — 시험 클라이언트가 base_version_id 계약을 모사한다", () => {
  it("낡은 base_version_id 는 rev_conflict 로 거절하고 행을 안 바꾼다. 성공하면 version_id 가 새로 바뀌어 예전 값으로 다시 쓰면 거절된다", async () => {
    const { u3 } = await boot();
    const ws = ["sample-study", 1] as const;
    await expect(u3.client.assessAssumption(...ws, "as-1", { verdict: "confirm", rationale: "", base_version_id: "as-1-낡음" }, "k1")).rejects.toMatchObject({ body: { error: { code: "rev_conflict" } } });
    expect(storedA(u3, "as-1").state).toBe("proposed");

    const ok = await u3.client.assessAssumption(...ws, "as-1", { verdict: "confirm", rationale: "", base_version_id: "as-1-v1" }, "k2");
    expect(storedA(u3, "as-1").version_id).toBe(ok.data.version_id);
    expect(ok.data.version_id).not.toBe("as-1-v1");
    await expect(u3.client.assessAssumption(...ws, "as-1", { verdict: "reject", rationale: "x", base_version_id: "as-1-v1" }, "k3")).rejects.toMatchObject({ body: { error: { code: "rev_conflict" } } });

    await expect(u3.client.revokeDecision(...ws, "dec-3", { rationale: "x", base_version_id: "dec-3-낡음" }, "k4")).rejects.toMatchObject({ body: { error: { code: "rev_conflict" } } });
    await expect(u3.client.supersedeDecision(...ws, "dec-2", { statement: "새", rationale: "x", base_version_id: "dec-2-낡음" }, "k5")).rejects.toMatchObject({ body: { error: { code: "rev_conflict" } } });
    await expect(u3.client.adoptDecision(...ws, "dec-4", { rationale: "", base_version_id: "dec-4-낡음" }, "k6")).rejects.toMatchObject({ body: { error: { code: "rev_conflict" } } });
  });
});

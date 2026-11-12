// SEL-114 최종 리뷰 1 필수 2 · 3 — 쓰기의 답이 유실된(또는 늦는) 동안 변경분(workspace)이 목록을 다시 읽게 해도, 같은 요청의 영수증 확인이 막히거나 사라지면 안 된다(F06).
// 실제 3초 변경분 경로(useLiveChanges → getChanges → touched: ["workspace"] → 참고 목록 무효화)를 거친다. 합성 자료뿐, 네트워크 0.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { boot, cell, createReferencesClient, rowOf, statusText, table, waitRows, type ReferencesClient } from "@/test/sel114";

afterEach(cleanup);

const dialogOf = (name: string) => screen.findByRole("dialog", { name });
const isDisabled = (el: HTMLElement) => el.getAttribute("aria-disabled") === "true" || (el as HTMLButtonElement).disabled === true;
const WORKSPACE_CHANGE = { cursor: "c-lost", txs: [{ tx_id: "tx-lost-1", touched: ["workspace"] }] };
const WAIT = { timeout: 9000 };

/** 목록을 변경분 경로로 다시 읽게 한다 — 다음 3초 박자에 workspace 변경이 온다 */
async function rereadByChanges(rc: ReferencesClient) {
  const before = rc.reads.length;
  rc.s.queueChanges(WORKSPACE_CHANGE);
  await waitFor(() => expect(rc.reads.length).toBeGreaterThan(before), WAIT);
}

describe("다시 고정 — 답이 유실된 뒤 변경분 조회가 성공해도 같은 요청의 영수증을 확인할 수 있다", () => {
  it("행이 이미 새 버전이 돼도 다시 고정 단추는 살아 있고, 다시 누르면 같은 키 · 최초 본문(source_snapshot_id · base_rev)으로 처음 영수증을 받는다", async () => {
    const rc = createReferencesClient();
    const user = userEvent.setup();
    await boot(rc);
    await waitRows();
    await user.click(within(rowOf("ref-1")).getByRole("button", { name: "다시 고정: 합성 장기요양" }));
    const dlg = await dialogOf("다른 버전으로 다시 고정");
    await within(dlg).findByRole("radiogroup", { name: "고정할 버전" });
    rc.loseReplyNext();
    await user.click(within(dlg).getByRole("button", { name: "다시 고정" }));
    await waitFor(() => expect(rc.refreshes).toHaveLength(1));
    await waitFor(() => expect(statusText()).toContain("접수 확인 중"));
    expect(rc.refreshes[0].input).toEqual({ source_snapshot_id: "s-a2", base_rev: "1" });

    await rereadByChanges(rc);
    // 목록은 서버가 처리한 값(2판 R1 승인본 · rev 2)을 보여 준다
    await waitFor(() => expect(cell("ref-1", "version").textContent).toContain("2판 R1 승인본"));
    // F06: 영수증을 받기 전에는 성공 말이 없다
    expect(statusText()).not.toMatch(/접수\s*0?\d{3,}|접수됨/);
    const open = screen.getByRole("dialog", { name: "다른 버전으로 다시 고정" });
    expect(statusText()).toContain("접수 확인 중");
    const go = within(open).getByRole("button", { name: "다시 고정" });
    expect(isDisabled(go)).toBe(false);

    await user.click(go);
    await waitFor(() => expect(rc.refreshes).toHaveLength(2));
    // 새 rev(2)로 새 요청을 만들지 않는다 — 처음 키와 처음 본문 그대로
    expect(rc.refreshes[1].key).toBe(rc.refreshes[0].key);
    expect(rc.refreshes[1].input).toEqual(rc.refreshes[0].input);
    await waitFor(() => expect(statusText()).toMatch(/접수\s*0?7\d\d/));
    expect(statusText()).toContain("이미 처리된 요청");
    expect(screen.queryByRole("dialog", { name: "다른 버전으로 다시 고정" })).toBeNull();
  });

  it("영수증 전에 다른 곳에서 값이 바뀌어도(행 rev 가 더 올라가도) 재확인은 처음 본문 그대로 나간다", async () => {
    const rc = createReferencesClient();
    const user = userEvent.setup();
    await boot(rc);
    await waitRows();
    await user.click(within(rowOf("ref-1")).getByRole("button", { name: "다시 고정: 합성 장기요양" }));
    const dlg = await dialogOf("다른 버전으로 다시 고정");
    await within(dlg).findByRole("radiogroup", { name: "고정할 버전" });
    rc.loseReplyNext();
    await user.click(within(dlg).getByRole("button", { name: "다시 고정" }));
    await waitFor(() => expect(statusText()).toContain("접수 확인 중"));
    rc.bumpOutside("ref-1");
    await rereadByChanges(rc);
    await waitFor(() => expect(table().querySelector('[data-reference="ref-1"]')).not.toBeNull());
    await user.click(within(screen.getByRole("dialog", { name: "다른 버전으로 다시 고정" })).getByRole("button", { name: "다시 고정" }));
    await waitFor(() => expect(rc.refreshes).toHaveLength(2));
    expect(rc.refreshes[1].key).toBe(rc.refreshes[0].key);
    expect(rc.refreshes[1].input).toEqual({ source_snapshot_id: "s-a2", base_rev: "1" });
    await waitFor(() => expect(statusText()).toMatch(/접수\s*0?7\d\d/));
  });
});

describe("떼기 — 답이 유실되거나 늦은 동안 변경분 조회가 행을 지워도 대화 상자 · 재시도 키 · 접수 확인이 남는다", () => {
  const openDetach = async (rc: ReferencesClient) => {
    const user = userEvent.setup();
    await boot(rc);
    await waitRows();
    await user.click(within(rowOf("ref-2")).getByRole("button", { name: "떼기: 합성 물가" }));
    const dlg = await dialogOf("참고 프로젝트 떼기");
    return { user, dlg };
  };

  it("답 유실 → 변경분이 행을 지움: 대화 상자와 “접수 확인 중”이 남고, 다시 떼기는 같은 키로 처음 영수증을 받는다", async () => {
    const rc = createReferencesClient();
    const { user, dlg } = await openDetach(rc);
    rc.loseReplyNext();
    await user.click(within(dlg).getByRole("button", { name: "떼기" }));
    await waitFor(() => expect(rc.detaches).toHaveLength(1));
    await waitFor(() => expect(statusText()).toContain("접수 확인 중"));

    await rereadByChanges(rc);
    await waitFor(() => expect(table().querySelector('[data-reference="ref-2"]')).toBeNull());
    const open = screen.getByRole("dialog", { name: "참고 프로젝트 떼기" });
    expect(statusText()).toContain("접수 확인 중");
    expect(statusText()).not.toMatch(/접수\s*0?\d{3,}|접수됨/);

    await user.click(within(open).getByRole("button", { name: "떼기" }));
    await waitFor(() => expect(rc.detaches).toHaveLength(2));
    expect(rc.detaches[1].key).toBe(rc.detaches[0].key);
    expect(rc.detaches[1].ref_id).toBe("ref-2");
    await waitFor(() => expect(statusText()).toMatch(/접수\s*0?7\d\d/));
    expect(statusText()).toContain("이미 처리된 요청");
    expect(screen.queryByRole("dialog", { name: "참고 프로젝트 떼기" })).toBeNull();
  });

  it("영수증 응답이 아직 대기 중인데 목록 조회가 먼저 끝나 행이 사라져도 대화 상자가 남고, 답이 오면 접수 번호로 닫힌다", async () => {
    const rc = createReferencesClient();
    const { user, dlg } = await openDetach(rc);
    const release = rc.holdReplyNext();
    await user.click(within(dlg).getByRole("button", { name: "떼기" }));
    await waitFor(() => expect(rc.detaches).toHaveLength(1));

    await rereadByChanges(rc);
    await waitFor(() => expect(table().querySelector('[data-reference="ref-2"]')).toBeNull());
    expect(screen.getByRole("dialog", { name: "참고 프로젝트 떼기" })).toBeTruthy();
    expect(statusText()).toContain("접수 확인 중");
    expect(statusText()).not.toMatch(/접수\s*0?\d{3,}|접수됨/);

    release();
    await waitFor(() => expect(statusText()).toMatch(/접수\s*0?7\d\d/));
    expect(screen.queryByRole("dialog", { name: "참고 프로젝트 떼기" })).toBeNull();
    expect(rc.detaches).toHaveLength(1);
  });

  it("취소는 아직 확인되지 않은 요청을 버린다 — 닫은 뒤 행이 없으면 그 요청은 더 이어지지 않는다(확인 전에는 닫는 길이 취소뿐)", async () => {
    const rc = createReferencesClient();
    const { user, dlg } = await openDetach(rc);
    rc.loseReplyNext();
    await user.click(within(dlg).getByRole("button", { name: "떼기" }));
    await waitFor(() => expect(statusText()).toContain("접수 확인 중"));
    await rereadByChanges(rc);
    await waitFor(() => expect(table().querySelector('[data-reference="ref-2"]')).toBeNull());
    await user.click(within(screen.getByRole("dialog", { name: "참고 프로젝트 떼기" })).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "참고 프로젝트 떼기" })).toBeNull());
    expect(rc.detaches).toHaveLength(1);
  });
});

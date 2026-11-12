// SEL-112 U4b — edit_text 제안 채택: 기반 버전 대조 · 409 basis_changed 안내 · 성공은 영수증 뒤에만(F06) (Vitest, jsdom). 계약: src/test/sel112.ts 머리말.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  BODY_V2,
  NEW_BODY,
  VER1,
  VER2,
  VER3,
  alertText,
  apiFail,
  article,
  blocks,
  boot,
  clearSelection,
  followup,
  statusTexts,
  thread,
  threadEl,
  threadOf,
} from "@/test/sel112";

afterEach(() => {
  cleanup();
  clearSelection();
});

const withProposal = (over = {}) => ({ threads: [thread("th-1", { followups: [followup("fu-1", "th-1", over)] })] });
const fuOf = async (id = "fu-1") => {
  const t = await threadOf("th-1");
  return t.querySelector<HTMLElement>(`[data-followup="${id}"]`)!;
};
const openAdopt = async (user: Awaited<ReturnType<typeof boot>>["user"]) => {
  const fu = await fuOf();
  await user.click(within(fu).getByRole("button", { name: /^채택/ }));
  return screen.findByRole("dialog", { name: "글 수정 채택" });
};

describe("제안 보기", () => {
  it("edit_text 제안: 종류 낱말 '글 수정' · 상태 '제안' · 제안 글 전체가 보이고, 결과 글은 아직 그대로다", async () => {
    await boot(withProposal());
    const fu = await fuOf();
    expect(fu.getAttribute("data-state")).toBe("proposed");
    expect(fu.textContent).toMatch(/글 수정/);
    expect(fu.textContent).toMatch(/제안/);
    expect(fu.textContent).toContain("첫째는 현행 유지이고 근거는 부록 A 에 있다.");
    await blocks();
    expect(article().textContent).not.toContain("부록 A");
  });

  it("제안 글이 없는 edit_text 후속(proposed_body_md null)은 채택할 수 없다 — aria-disabled + 이유('제안 글')", async () => {
    const { u4, user } = await boot(withProposal({ proposed_body_md: null, proposed_version_id: null }));
    const fu = await fuOf();
    const btn = within(fu).getByRole("button", { name: /^채택/ });
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(btn.getAttribute("aria-describedby") ?? "")?.textContent).toMatch(/제안 글/);
    await user.click(btn);
    expect(screen.queryByRole("dialog", { name: "글 수정 채택" })).toBeNull();
    expect(u4.writes()).toHaveLength(0);
  });

  it("next_round_task · reopen_stage 후속에는 '채택' 단추가 없다(이 이슈는 edit_text 채택만)", async () => {
    await boot({
      threads: [
        thread("th-1", {
          followups: [
            followup("fu-t", "th-1", { kind: "next_round_task", proposed_body_md: null, proposed_version_id: null, base_version_id: null }),
            followup("fu-r", "th-1", { kind: "reopen_stage", proposed_body_md: null, proposed_version_id: null, base_version_id: null }),
          ],
        }),
      ],
    });
    const t = await threadOf("th-1");
    for (const id of ["fu-t", "fu-r"]) expect(within(t.querySelector<HTMLElement>(`[data-followup="${id}"]`)!).queryByRole("button", { name: /^채택/ })).toBeNull();
  });

  it("이미 applied · rejected 인 후속에는 '채택' 단추가 없다", async () => {
    await boot({ threads: [thread("th-1", { followups: [followup("fu-a", "th-1", { state: "applied", result_version_id: VER2 }), followup("fu-x", "th-1", { state: "rejected" })] })] });
    const t = await threadOf("th-1");
    for (const id of ["fu-a", "fu-x"]) expect(within(t.querySelector<HTMLElement>(`[data-followup="${id}"]`)!).queryByRole("button", { name: /^채택/ })).toBeNull();
  });
});

describe("기반 버전 대조", () => {
  it("지금 글 버전과 제안 기반 버전이 같으면 채택 대화 상자가 열리고, 기반이 같은 쪽이라는 설명이 있다", async () => {
    const { user } = await boot(withProposal());
    const dialog = await openAdopt(user);
    expect(dialog.textContent).toMatch(/기반/);
    expect(within(dialog).getByRole("button", { name: "새 버전으로 채택" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "취소" })).toBeTruthy();
  });

  it("글이 이미 새 버전이면(제안 기반 ≠ 현재 버전) '채택' 은 aria-disabled + 이유('기반')이고 서버 호출 0", async () => {
    const { u4, user } = await boot({ ...withProposal(), version: VER3, body: BODY_V2 });
    const fu = await fuOf();
    const btn = within(fu).getByRole("button", { name: /^채택/ });
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    const why = document.getElementById(btn.getAttribute("aria-describedby") ?? "")?.textContent ?? "";
    expect(why).toMatch(/기반/);
    expect(why).toMatch(/바뀌|달라|새 버전/);
    await user.click(btn);
    expect(screen.queryByRole("dialog", { name: "글 수정 채택" })).toBeNull();
    expect(u4.callsOf("applyFollowup")).toHaveLength(0);
  });

  it("대화 상자를 연 채로 글이 바뀌면(채택 직전) 서버가 409 basis_changed 로 거절한다 — 안내 · 글 그대로 · 자동 재시도 없음", async () => {
    const { u4, user } = await boot(withProposal());
    const dialog = await openAdopt(user);
    u4.bumpVersion(VER3, BODY_V2); // 그사이 다른 사람이 새 버전을 냈다
    const reads = u4.reads.length;
    await user.click(within(dialog).getByRole("button", { name: "새 버전으로 채택" }));
    await waitFor(() => expect(u4.callsOf("applyFollowup")).toHaveLength(1));
    await waitFor(() => expect(alertText()).toMatch(/결과 글이 바뀌/));
    expect(alertText()).toMatch(/새 버전/);
    expect(statusTexts()).not.toMatch(/접수 \d{4}/);
    // 후속은 그대로 제안이고 글은 서버의 새 버전 그대로(제안 글로 덮이지 않았다)
    expect(threadEl("th-1")!.querySelector('[data-followup="fu-1"]')!.getAttribute("data-state")).toBe("proposed");
    expect(u4.state.body).toBe(BODY_V2);
    // 자동 재시도 없음 · 읽기는 다시 한다(새 버전을 알아보게)
    await new Promise((r) => setTimeout(r, 50));
    expect(u4.callsOf("applyFollowup")).toHaveLength(1);
    expect(u4.reads.length).toBeGreaterThan(reads);
  });

  it("409 안내 뒤 다시 읽으면 '채택' 은 기반 불일치로 막혀 같은 낡은 제안을 다시 채택할 수 없다", async () => {
    const { u4, user } = await boot(withProposal());
    const dialog = await openAdopt(user);
    u4.bumpVersion(VER3, BODY_V2);
    await user.click(within(dialog).getByRole("button", { name: "새 버전으로 채택" }));
    await waitFor(() => expect(alertText()).toMatch(/결과 글이 바뀌/));
    await user.click(within(screen.getByRole("dialog", { name: "글 수정 채택" })).getByRole("button", { name: "취소" }));
    await waitFor(() => {
      const btn = within(threadEl("th-1")!.querySelector<HTMLElement>('[data-followup="fu-1"]')!).getByRole("button", { name: /^채택/ });
      expect(btn.getAttribute("aria-disabled")).toBe("true");
    });
  });

  it("409 rev_conflict(후속이 그사이 바뀜) 도 서버 문장을 보이고 성공으로 보이지 않는다", async () => {
    const { u4, user } = await boot(withProposal());
    const dialog = await openAdopt(user);
    u4.failNext(apiFail("rev_conflict", "후속이 그사이 바뀌었습니다. 다시 확인해 주세요."));
    await user.click(within(dialog).getByRole("button", { name: "새 버전으로 채택" }));
    await waitFor(() => expect(alertText()).toMatch(/후속이 그사이 바뀌었습니다/));
    expect(statusTexts()).not.toMatch(/접수 \d{4}/);
    expect(screen.getByRole("dialog", { name: "글 수정 채택" })).toBeTruthy();
  });

  it("권한 거절(forbidden · human_required): 서버 문장을 그대로 보이고 대화 상자 그대로", async () => {
    const { u4, user } = await boot(withProposal());
    const dialog = await openAdopt(user);
    u4.failNext(apiFail("human_required", "글 수정 채택은 사람 소유자만 할 수 있습니다."));
    await user.click(within(dialog).getByRole("button", { name: "새 버전으로 채택" }));
    await waitFor(() => expect(alertText()).toMatch(/사람 소유자만/));
    expect(screen.getByRole("dialog", { name: "글 수정 채택" })).toBeTruthy();
  });
});

describe("채택 보내기 — 성공 표시는 영수증 뒤에만 (F06)", () => {
  it("보내는 값: 후속의 기반 버전 · 후속의 현재 rev(version_no) · 멱등 키", async () => {
    const { u4, user } = await boot(withProposal({ version_no: "3" }));
    const dialog = await openAdopt(user);
    await user.click(within(dialog).getByRole("button", { name: "새 버전으로 채택" }));
    await waitFor(() => expect(u4.callsOf("applyFollowup")).toHaveLength(1));
    const call = u4.callsOf("applyFollowup")[0]!;
    expect(call.id).toBe("fu-1");
    expect(call.input).toEqual({ base_version_id: VER1, expected_rev: "3" });
    expect(call.key).toMatch(/\S/);
  });

  it("영수증 전: '접수 확인 중' · 후속은 아직 제안 · 글은 옛 본문 · 접수 번호 · '적용' 말 없음 · 두 번 눌러도 한 번 · aria-disabled", async () => {
    const { u4, user } = await boot(withProposal());
    await blocks();
    const dialog = await openAdopt(user);
    const release = u4.hold();
    const send = within(dialog).getByRole("button", { name: "새 버전으로 채택" });
    await user.click(send);
    await user.click(send);
    await waitFor(() => expect(statusTexts()).toMatch(/접수 확인 중/));
    expect(u4.callsOf("applyFollowup")).toHaveLength(1);
    expect(send.hasAttribute("disabled")).toBe(false);
    expect(send.getAttribute("aria-disabled")).toBe("true");
    expect(statusTexts()).not.toMatch(/접수 \d{4}/);
    expect(threadEl("th-1")!.querySelector('[data-followup="fu-1"]')!.getAttribute("data-state")).toBe("proposed");
    expect(article().textContent).not.toContain("부록 A");
    expect(threadEl("th-1")!.textContent).not.toMatch(/적용됨|반영됨/);
    release();
    await waitFor(() => expect(statusTexts()).toMatch(/접수 \d{4}/));
  });

  it("성공: 접수 번호 · 대화 상자 닫힘 · 초점은 body 가 아님 · 후속 applied(적용) · 결과 글이 새 본문 · 스레드는 해결되지 않음", async () => {
    const { u4, user } = await boot(withProposal());
    await blocks();
    const dialog = await openAdopt(user);
    await user.click(within(dialog).getByRole("button", { name: "새 버전으로 채택" }));
    await waitFor(() => expect(statusTexts()).toMatch(/접수 \d{4}/));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "글 수정 채택" })).toBeNull());
    expect(document.activeElement).not.toBe(document.body);
    await waitFor(() => expect(threadEl("th-1")!.querySelector('[data-followup="fu-1"]')!.getAttribute("data-state")).toBe("applied"));
    expect(threadEl("th-1")!.querySelector('[data-followup="fu-1"]')!.textContent).toMatch(/적용/);
    await waitFor(() => expect(article().textContent).toContain("근거는 부록 A 에 있다"));
    expect(u4.state.body).toBe(NEW_BODY);
    expect(threadEl("th-1")!.getAttribute("data-state")).toBe("open");
    expect(threadEl("th-1")!.textContent).not.toMatch(/해결됨/);
  });

  it("시간 초과(TimeoutError)는 실패가 아니라 '접수 확인 중' — 다시 누르면 같은 멱등 키", async () => {
    const { u4, user } = await boot(withProposal());
    const dialog = await openAdopt(user);
    u4.failNext(Object.assign(new Error("시간 초과"), { name: "TimeoutError" }));
    await user.click(within(dialog).getByRole("button", { name: "새 버전으로 채택" }));
    await waitFor(() => expect(statusTexts()).toMatch(/접수 확인 중/));
    expect(alertText()).not.toMatch(/실패/);
    expect(threadEl("th-1")!.querySelector('[data-followup="fu-1"]')!.getAttribute("data-state")).toBe("proposed");
    await user.click(within(dialog).getByRole("button", { name: "새 버전으로 채택" }));
    await waitFor(() => expect(u4.callsOf("applyFollowup")).toHaveLength(2));
    const [a, b] = u4.callsOf("applyFollowup");
    expect(b!.key).toBe(a!.key);
  });

  it("채택이 반영 내역을 직접 쓰지 않는다 — 반영 의견 제출 · 판단 같은 다른 쓰기가 없다", async () => {
    const { u4, user } = await boot(withProposal());
    const dialog = await openAdopt(user);
    await user.click(within(dialog).getByRole("button", { name: "새 버전으로 채택" }));
    await waitFor(() => expect(statusTexts()).toMatch(/접수 \d{4}/));
    expect(u4.writes().map((c) => c.method)).toEqual(["applyFollowup"]);
  });

  it("취소하면 호출 0 · 초점이 채택 단추로 돌아온다", async () => {
    const { u4, user } = await boot(withProposal());
    const dialog = await openAdopt(user);
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "글 수정 채택" })).toBeNull());
    expect(u4.writes()).toHaveLength(0);
    expect(document.activeElement).toBe(within(await fuOf()).getByRole("button", { name: /^채택/ }));
  });

  it("접근성: 대화 상자는 Esc 로 닫히고(호출 0) 제안 글 영역은 이름 있는 영역으로 읽힌다", async () => {
    const { u4, user } = await boot(withProposal());
    await openAdopt(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "글 수정 채택" })).toBeNull());
    expect(u4.writes()).toHaveLength(0);
    const fu = await fuOf();
    expect(fu.getAttribute("aria-label") || fu.getAttribute("aria-labelledby") || fu.querySelector("h3,h4")).toBeTruthy();
  });
});

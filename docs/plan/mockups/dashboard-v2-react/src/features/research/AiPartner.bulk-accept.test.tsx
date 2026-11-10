import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { pes } from "@/api/mock-client";
import { useChangeFeed, useWorkspace } from "@/api/queries";
import { mockSettings } from "@/lib/mock-settings";
import { aiSheet, researchUi } from "@/lib/research-ui";
import { setViewport } from "@/test/render-app";
import { renderBarePage } from "@/test/render-page";
import { addProposal, decisionCalls, failAssumption, judgeElsewhere, pendingIds, SLUG } from "@/test/proposals";
import { AiPartner } from "@/features/research/AiPartner";

/**
 * UI7-4b 가정 일괄 받아들이기 (설계 18.10) — 새 요구 시험.
 * 정한 이름(worker 가 맞춘다):
 *  - 단추 이름: “판단 전 가정 n개 모두 받아들이기” (n ≥ 2 일 때만 있음)
 *  - 대화 상자(role=dialog) 안: 목록 aria-label “받아들일 가정”, 줄마다 번호 · 내용 첫 줄 · 근거,
 *    문구 “n개를 확인으로 기록합니다 — 판단자: 나”, 단추 “n개 받아들이기” · “취소”, 진행 중 단추 글자에 “받아들이는 중”
 *  - 끝 상태: “n개 중 m개 받아들임 · k개 실패”, 실패 목록 aria-label “실패한 가정”(줄마다 이유 한 줄),
 *    “이미 판단됨 j개”(실패에 안 셈), 단추 “실패한 것만 다시” · “닫기”, 캡션 “묶음 접수 번호 …”
 *  - 목 설정: failAssumption(제안 id) — src/test/proposals.ts 주석 참고
 */

const BULK = (n: number) => `판단 전 가정 ${n}개 모두 받아들이기`;

function Partner() {
  const { data } = useWorkspace(SLUG);
  useChangeFeed(SLUG);
  return data ? <AiPartner ws={data} /> : <p>읽는 중</p>;
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  pes.reset();
  mockSettings.reset();
  failAssumption(null);
  researchUi.set({ focus: false, aiPanel: true, aiOnRound: false });
  aiSheet.set({ open: false, target: null });
  setViewport(1440);
  // 시드: 판단 전 가정 pp1 하나 + 판단 전 결정 pp2 하나 + 받아들인 결정 pp3
});

const open = async () => {
  await renderBarePage(Partner, "x", "/x");
  await screen.findByRole("heading", { name: /AI가 남긴 가정·결정 제안/ }, { timeout: 4000 });
};
const noBulk = () => expect(screen.queryByRole("button", { name: /모두 받아들이기/ })).not.toBeInTheDocument();

/** 가정 3개(첫 줄만 보이는 여러 줄 글 하나 포함)를 더해 판단 전 가정이 4개가 되게 한다 — pp1 + a1 a2 a3 */
function seedThree() {
  addProposal({ id: "a1", kind: "assumption", text: "첫째 가정 첫 줄\n첫째 가정 둘째 줄", basis: "조사 노트 v5" });
  addProposal({ id: "a2", kind: "assumption", text: "둘째 가정", basis: "연구 설계서 v2" });
  addProposal({ id: "a3", kind: "assumption", text: "셋째 가정", basis: "자료 목록 v3" });
}
/** 판단 전 가정이 정확히 a1 a2 a3 만 되게(시드 pp1 은 받아들인 것으로) */
function onlyThree() {
  seedThree();
  judgeElsewhere("pp1");
}

async function openDialog(n: number) {
  fireEvent.click(await screen.findByRole("button", { name: BULK(n) }));
  return await screen.findByRole("dialog");
}

describe("UI7-4b ① 단추는 판단 전 가정이 2개 이상일 때만 — 결정 제안은 세지 않는다", () => {
  it("판단 전 가정 1개 + 판단 전 결정 1개(시드)면 단추가 없다", async () => {
    expect(pendingIds("assumption")).toEqual(["pp1"]);
    expect(pendingIds("decision")).toEqual(["pp2"]);
    await open();
    noBulk();
  });

  it("판단 전 가정 2개면 단추가 있고 이름에 가정 수가 들어간다", async () => {
    addProposal({ id: "a1", kind: "assumption", text: "새 가정" });
    await open();
    expect(await screen.findByRole("button", { name: BULK(2) })).toBeInTheDocument();
  });

  it("결정 제안이 아무리 많아도 수에 넣지 않는다(가정 1 + 결정 3 → 단추 없음)", async () => {
    addProposal({ id: "d1", kind: "decision", text: "결정 하나" });
    addProposal({ id: "d2", kind: "decision", text: "결정 둘" });
    await open();
    noBulk();
  });

  it("이미 받아들인 가정은 세지 않는다(가정 2개 중 1개가 판단됨 → 단추 없음)", async () => {
    addProposal({ id: "a1", kind: "assumption", text: "이미 판단된 가정", state: { domain: "proposal", value: "accepted", label: "받아들임 · 박검토 09:00" } });
    await open();
    noBulk();
  });

  it("가정 4개 + 결정 1개면 이름의 수는 가정만 센 4다", async () => {
    seedThree();
    await open();
    expect(await screen.findByRole("button", { name: BULK(4) })).toBeInTheDocument();
  });
});

describe("UI7-4b ② 권한 — 가정 확인 권한(소유자)만, 없으면 숨기지 않고 aria-disabled + 이유", () => {
  it.each(["editor", "reader"] as const)("%s 는 단추가 보이되 막혀 있고, 초점을 받아 이유를 읽을 수 있다", async (role) => {
    seedThree();
    mockSettings.set({ role });
    await open();
    const btn = await screen.findByRole("button", { name: BULK(4) });
    expect(btn).toHaveAttribute("aria-disabled", "true");
    btn.focus();
    expect(btn).toHaveFocus();
    const why = btn.getAttribute("aria-describedby");
    expect(why).toBeTruthy();
    const text = document.getElementById(why!.split(" ").pop()!)?.textContent ?? "";
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).toMatch(/소유자|가정 확인|권한/);
  });

  it("막힌 단추를 눌러도 대화 상자가 열리지 않고 명령도 나가지 않는다", async () => {
    seedThree();
    mockSettings.set({ role: "editor" });
    await open();
    const before = decisionCalls();
    fireEvent.click(await screen.findByRole("button", { name: BULK(4) }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(decisionCalls()).toBe(before);
  });

  it("소유자는 막혀 있지 않다", async () => {
    seedThree();
    await open();
    expect(await screen.findByRole("button", { name: BULK(4) })).not.toHaveAttribute("aria-disabled", "true");
  });
});

describe("UI7-4b ③ 한 번 확인 대화 상자", () => {
  it("받아들일 가정 목록(번호 · 첫 줄 · 근거 버전)과 수 문구, 두 단추를 보인다 — 누르기 전에는 명령이 나가지 않는다", async () => {
    onlyThree();
    await open();
    const before = decisionCalls();
    const dlg = await openDialog(3);
    const items = within(within(dlg).getByRole("list", { name: "받아들일 가정" })).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toMatch(/^\s*1/);
    expect(items[0]).toHaveTextContent("첫째 가정 첫 줄");
    expect(items[0]).not.toHaveTextContent("첫째 가정 둘째 줄"); // 첫 줄만
    expect(items[0]).toHaveTextContent("조사 노트 v5");
    expect(items[1].textContent).toMatch(/^\s*2/);
    expect(items[1]).toHaveTextContent("둘째 가정");
    expect(items[1]).toHaveTextContent("연구 설계서 v2");
    expect(items[2].textContent).toMatch(/^\s*3/);
    expect(items[2]).toHaveTextContent("자료 목록 v3");
    expect(within(dlg).getByText("3개를 확인으로 기록합니다 — 판단자: 나")).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "3개 받아들이기" })).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "취소" })).toBeInTheDocument();
    expect(decisionCalls()).toBe(before);
  });

  it("결정 제안과 이미 판단된 것은 목록에 넣지 않는다", async () => {
    onlyThree();
    addProposal({ id: "d1", kind: "decision", text: "결정은 하나씩 한다" });
    await open();
    const dlg = await openDialog(3);
    expect(dlg).not.toHaveTextContent("결정은 하나씩 한다");
    expect(dlg).not.toHaveTextContent("사례 지역 2곳의 경향을"); // 시드 pp1(받아들임으로 바꿈)
  });

  it("[취소]는 아무것도 기록하지 않고 닫는다", async () => {
    onlyThree();
    await open();
    const before = decisionCalls();
    const dlg = await openDialog(3);
    fireEvent.click(within(dlg).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(decisionCalls()).toBe(before);
    expect(pendingIds("assumption")).toEqual(["a1", "a2", "a3"]);
  });

  it("받아들이는 동안 단추는 진행 표시이고 대화 상자는 닫히지 않는다 — 끝나면 모두 받아들임", async () => {
    onlyThree();
    await open();
    const dlg = await openDialog(3);
    fireEvent.click(within(dlg).getByRole("button", { name: "3개 받아들이기" }));
    // 보내는 동안
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const progress = within(screen.getByRole("dialog")).getAllByRole("button").find((b) => /받아들이는 중/.test(b.textContent ?? ""));
    expect(progress).toBeDefined();
    expect(progress).toHaveAttribute("aria-disabled", "true");
    // 끝
    await waitFor(() => expect(pendingIds("assumption")).toEqual([]), { timeout: 8000 });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("UI7-4b ④ 기록 — 가정마다 개별 명령, 한 묶음 접수 번호, 원자성 약속 없음", () => {
  it("가정 수만큼 decision.record 가 나가고(결정 제안은 건드리지 않음), 묶음 접수 번호 캡션이 있다", async () => {
    onlyThree();
    await open();
    const before = decisionCalls();
    const dlg = await openDialog(3);
    fireEvent.click(within(dlg).getByRole("button", { name: "3개 받아들이기" }));
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByText(/묶음 접수 번호/)).toBeInTheDocument(), { timeout: 8000 });
    expect(decisionCalls() - before).toBe(3);
    expect(pendingIds("assumption")).toEqual([]);
    expect(pendingIds("decision")).toEqual(["pp2"]); // 결정 제안은 그대로
  });

  it("‘모두 또는 없음’ 같은 원자성 약속을 대화 상자(열 때 · 끝날 때)에 쓰지 않는다", async () => {
    onlyThree();
    await open();
    const dlg = await openDialog(3);
    const noPromise = (el: HTMLElement) => expect(el.textContent ?? "").not.toMatch(/모두 또는 없음|원자|전부 아니면|all.or.nothing|한꺼번에 취소|하나라도 실패하면 .*취소/i);
    noPromise(dlg);
    fireEvent.click(within(dlg).getByRole("button", { name: "3개 받아들이기" }));
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByText(/묶음 접수 번호/)).toBeInTheDocument(), { timeout: 8000 });
    noPromise(screen.getByRole("dialog"));
  });
});

describe("UI7-4b ⑤ 부분 실패 — 한 건 버전 충돌", () => {
  it("끝 상태: n개 중 m개 받아들임 · k개 실패 + 실패한 것만 목록(이유 한 줄) + [실패한 것만 다시] · [닫기]", async () => {
    onlyThree();
    failAssumption("a2");
    await open();
    const dlg = await openDialog(3);
    fireEvent.click(within(dlg).getByRole("button", { name: "3개 받아들이기" }));
    const end = await screen.findByText("3개 중 2개 받아들임 · 1개 실패", {}, { timeout: 8000 });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toContainElement(end);
    const failed = within(within(dialog).getByRole("list", { name: "실패한 가정" })).getAllByRole("listitem");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toHaveTextContent("둘째 가정");
    expect(failed[0]).toHaveTextContent("버전 충돌");
    expect(within(dialog).getByRole("button", { name: "실패한 것만 다시" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "닫기" })).toBeInTheDocument();
    // 서버: 성공한 것만 판단됨, 실패한 것은 판단 전 그대로
    expect(pendingIds("assumption")).toEqual(["a2"]);
  });

  it("[닫기] 뒤: 성공한 것은 판단 전에서 빠지고(개별 받아들이기 단추도 없음) 실패한 것은 판단 전 그대로 개별 단추가 남는다", async () => {
    onlyThree();
    failAssumption("a2");
    await open();
    const dlg = await openDialog(3);
    fireEvent.click(within(dlg).getByRole("button", { name: "3개 받아들이기" }));
    await screen.findByText("3개 중 2개 받아들임 · 1개 실패", {}, { timeout: 8000 });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // 판단 전 가정이 1개뿐이라 일괄 단추는 사라진다
    await waitFor(() => noBulk());
    // 개별 받아들이기: 실패한 가정 1 + 판단 전 결정 pp2 1
    await waitFor(() => expect(screen.getAllByRole("button", { name: "받아들이기" })).toHaveLength(2));
    const second = screen.getByText("둘째 가정").closest("li")!;
    expect(within(second).getByRole("button", { name: "받아들이기" })).toBeInTheDocument();
    const first = screen.getByText("첫째 가정 첫 줄", { exact: false }).closest("li")!;
    expect(within(first).queryByRole("button", { name: "받아들이기" })).not.toBeInTheDocument();
  });

  it("[실패한 것만 다시]는 실패한 것에만 명령을 보내고, 풀리면 실패 목록이 사라진다", async () => {
    onlyThree();
    failAssumption("a2");
    await open();
    const dlg = await openDialog(3);
    fireEvent.click(within(dlg).getByRole("button", { name: "3개 받아들이기" }));
    await screen.findByText("3개 중 2개 받아들임 · 1개 실패", {}, { timeout: 8000 });
    failAssumption(null); // 충돌이 풀림
    const before = decisionCalls();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "실패한 것만 다시" }));
    await waitFor(() => expect(pendingIds("assumption")).toEqual([]), { timeout: 8000 });
    expect(decisionCalls() - before).toBe(1);
    await waitFor(() => expect(within(screen.getByRole("dialog")).queryByRole("list", { name: "실패한 가정" })).not.toBeInTheDocument());
  });

  it("이미 다른 사람이 판단한 것은 실패가 아니라 ‘이미 판단됨’으로 따로 센다", async () => {
    onlyThree();
    failAssumption("a2");
    await open();
    const dlg = await openDialog(3); // 이 시점 화면에는 셋 다 판단 전
    judgeElsewhere("a3"); // 그 사이 다른 사람이 a3 를 판단
    fireEvent.click(within(dlg).getByRole("button", { name: "3개 받아들이기" }));
    const end = await screen.findByText("3개 중 1개 받아들임 · 1개 실패", {}, { timeout: 8000 });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toContainElement(end);
    expect(within(dialog).getByText(/이미 판단됨 1개/)).toBeInTheDocument();
    const failed = within(within(dialog).getByRole("list", { name: "실패한 가정" })).getAllByRole("listitem");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toHaveTextContent("둘째 가정");
    expect(failed[0]).not.toHaveTextContent("셋째 가정");
  });

  it("권한이 중간에 사라지면 실패 이유가 ‘권한’이다", async () => {
    onlyThree();
    await open();
    const dlg = await openDialog(3);
    mockSettings.set({ role: "reader" }); // 서버가 권한을 다시 확인해 거절
    fireEvent.click(within(dlg).getByRole("button", { name: "3개 받아들이기" }));
    await screen.findByText("3개 중 0개 받아들임 · 3개 실패", {}, { timeout: 8000 });
    const failed = within(within(screen.getByRole("dialog")).getByRole("list", { name: "실패한 가정" })).getAllByRole("listitem");
    expect(failed).toHaveLength(3);
    for (const li of failed) expect(li).toHaveTextContent(/권한/);
  });
});

describe("UI7-4b ⑥ 회귀 — 판단 전 제안은 나의 할 일에 세지 않는다(16.2)", () => {
  it("판단 전 가정·결정 제안을 더해도 나의 할 일 단계 수(counted)가 그대로다", async () => {
    const before = (await pes.getWorkspace(SLUG)).tasks.filter((t) => t.counted).length;
    seedThree();
    addProposal({ id: "d1", kind: "decision", text: "결정 하나" });
    const after = (await pes.getWorkspace(SLUG)).tasks.filter((t) => t.counted).length;
    expect(after).toBe(before);
  });
});

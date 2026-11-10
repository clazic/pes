import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pes } from "@/api/mock-client";
import { useChangeFeed, useWorkspace } from "@/api/queries";
import { mockSettings } from "@/lib/mock-settings";
import { aiSheet, researchUi } from "@/lib/research-ui";
import { setViewport, workspaceRoutes, renderRoutes } from "@/test/render-app";
import { renderBarePage } from "@/test/render-page";
import { addProposal, decisionCalls, failAssumption, judgeElsewhere, pendingIds, SLUG } from "@/test/proposals";
import { spyDecisionCommands } from "@/test/command-spy";
import { AiPartner } from "@/features/research/AiPartner";

/**
 * UI7-4b 최종 리뷰(Codex) 회귀 시험 — logs/SEL-65-final-review-1.md F1~F4 + 1차 재확인 권장 2건.
 * 화면 코드는 고치지 않고 이대로 실패 시험으로 고정한다(leader 결정). 기존 단추·대화 상자 이름은 기존 시험과 같다.
 *
 * 이 파일이 새로 정하는 것(worker 가 맞춘다):
 *  - F1: 대화 상자를 연 채 다른 프로젝트로 가면 대화 상자가 닫히고, 이전 프로젝트 가정 id 가 새 프로젝트 slug 로 가지 않는다.
 *  - F2: 목 서버 decision.record(accept, 가정)는 소유자만 — 편집자는 permission_denied.
 *        열린 대화 상자에서 owner→editor 가 되면 수락 단추가 막히거나(aria-disabled + 이유) 보내도 전부 ‘권한’ 실패, 저장소 그대로.
 *  - F3: 닫은 뒤 초점 — 취소 → 열기 단추 · 전부 성공(열기 단추 사라짐) → ‘AI가 남긴 가정·결정 제안’ 제목(h3, tabindex=-1)
 *        · 부분 실패 → 열기 단추.
 *  - F4: 결과 불명(result_unknown)은 실패와 따로 센다. 끝 문구에 “결과 불명 j개”, 그 가정에는 “판단 전 그대로”를 쓰지 않는다.
 *        다시 보내는 단추 이름은 /다시/ 를 포함(기존 “실패한 것만 다시” 그대로여도 됨). 결과 불명이 없을 때만 “실패한 가정은 판단 전 그대로” 허용.
 *  - 키: 재시도할 수 없는 실패(권한·버전 충돌) 다시 보내기 → 새 멱등 키. 결과 불명 → 같은 키.
 *  - 목 설정 이름(결과 불명): 이미 있는 mockSettings.set({ network: "lost" }) — 첫 명령은 서버가 커밋하고 응답만 유실(result_unknown), 이후 정상.
 *    새 목 설정은 만들지 않는다(failAssumption 은 기존 시험과 같음).
 */

const BULK = (n: number) => `판단 전 가정 ${n}개 모두 받아들이기`;
const PROPOSAL_HEADING = /AI가 남긴 가정·결정 제안/;
const T = { timeout: 8000 };
// 가정마다 목 서버가 450ms 걸려 여러 건 보내는 시험은 기본 5초를 넘을 수 있다
vi.setConfig({ testTimeout: 20000 });

function Partner() {
  const { data } = useWorkspace(SLUG);
  useChangeFeed(SLUG);
  return data ? <AiPartner ws={data} /> : <p>읽는 중</p>;
}

let spy: ReturnType<typeof spyDecisionCommands>;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  pes.reset();
  mockSettings.reset();
  failAssumption(null);
  researchUi.set({ focus: false, aiPanel: true, aiOnRound: false });
  aiSheet.set({ open: false, target: null });
  setViewport(1440);
  spy = spyDecisionCommands();
});
afterEach(() => spy.restore());

const open = async () => {
  await renderBarePage(Partner, "x", "/x");
  await screen.findByRole("heading", { name: PROPOSAL_HEADING }, { timeout: 4000 });
};
function seedThree() {
  addProposal({ id: "a1", kind: "assumption", text: "첫째 가정 첫 줄\n첫째 가정 둘째 줄", basis: "조사 노트 v5" });
  addProposal({ id: "a2", kind: "assumption", text: "둘째 가정", basis: "연구 설계서 v2" });
  addProposal({ id: "a3", kind: "assumption", text: "셋째 가정", basis: "자료 목록 v3" });
}
function onlyThree() {
  seedThree();
  judgeElsewhere("pp1");
}
async function openDialog(n: number) {
  fireEvent.click(await screen.findByRole("button", { name: BULK(n) }));
  return await screen.findByRole("dialog");
}
const go = (dlg: HTMLElement, n: number) => fireEvent.click(within(dlg).getByRole("button", { name: `${n}개 받아들이기` }));
const status = () => within(screen.getByRole("dialog")).getByRole("status");
const retryButton = () => within(screen.getByRole("dialog")).getByRole("button", { name: /다시/ });

describe("F1 대화 상자는 연 프로젝트에 고정 — 프로젝트 왕복", () => {
  it("대화 상자를 연 채 다른 프로젝트로 가면(뒤로 가기) 닫히고, 이전 프로젝트 가정 id 가 새 프로젝트로 전송되지 않는다", async () => {
    seedThree(); // dolbom-insight: pp1 + a1 a2 a3 (판단 전 가정 4개)
    const { router } = await renderRoutes(await workspaceRoutes(), "/p/youth-housing");
    await screen.findByRole("heading", { name: PROPOSAL_HEADING }, { timeout: 4000 });
    await act(async () => {
      await router.navigate("/p/dolbom-insight");
    });
    const dlg = await (async () => {
      fireEvent.click(await screen.findByRole("button", { name: BULK(4) }, { timeout: 4000 }));
      return await screen.findByRole("dialog");
    })();
    expect(dlg).toHaveTextContent("첫째 가정 첫 줄");
    // 브라우저 뒤로 가기에 해당 — 캐시된 youth-housing 으로
    await act(async () => {
      await router.navigate(-1);
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/youth-housing"));
    // 이전 프로젝트(dolbom)의 묶음을 보여 주는 대화 상자가 남아 있으면 안 된다
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByText("첫째 가정 첫 줄", { exact: false })).not.toBeInTheDocument();
    // 어떤 경로로든 dolbom 의 가정 id 가 youth-housing 으로 나가지 않는다
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });
    const leaked = spy.sent.filter((s) => s.name === "decision.record" && s.slug === "youth-housing" && ["a1", "a2", "a3", "pp1"].includes(s.proposalId ?? ""));
    expect(leaked).toEqual([]);
  });
});

describe("F2 소유자 권한 상실 — 열린 대화 상자에서 owner→editor", () => {
  it("편집자가 되면 수락 단추가 막혀 있거나, 보내도 전부 ‘권한’ 실패이며 저장소는 그대로", async () => {
    onlyThree();
    await open();
    const dlg = await openDialog(3);
    await act(async () => {
      mockSettings.set({ role: "editor" });
    });
    const before = decisionCalls();
    const btn = within(dlg).getByRole("button", { name: "3개 받아들이기" });
    if (btn.getAttribute("aria-disabled") === "true") {
      const why = btn.getAttribute("aria-describedby");
      expect(why).toBeTruthy();
      expect(document.getElementById(why!.split(" ").pop()!)?.textContent ?? "").toMatch(/소유자|가정 확인|권한/);
      fireEvent.click(btn);
    } else {
      fireEvent.click(btn);
      await screen.findByText("3개 중 0개 받아들임 · 3개 실패", {}, T);
      const failed = within(within(screen.getByRole("dialog")).getByRole("list", { name: "실패한 가정" })).getAllByRole("listitem");
      expect(failed).toHaveLength(3);
      for (const li of failed) expect(li).toHaveTextContent(/권한/);
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    expect(pendingIds("assumption")).toEqual(["a1", "a2", "a3"]);
    expect(decisionCalls() - before).toBe(0);
  });

  it("목 서버: 편집자의 가정 확인(decision.record accept)은 permission_denied 이고 저장소를 바꾸지 않는다", async () => {
    onlyThree();
    mockSettings.set({ role: "editor" });
    await expect(pes.command("decision.record", { slug: SLUG, proposal_id: "a1", verdict: "accept" }, { idempotencyKey: "final-editor-1" })).rejects.toMatchObject({ code: "permission_denied" });
    expect(pendingIds("assumption")).toEqual(["a1", "a2", "a3"]);
  });
});

describe("F3 닫은 뒤 초점 — body 로 새지 않는다", () => {
  it("[취소]로 닫으면 초점이 열기 단추로 돌아온다", async () => {
    onlyThree();
    await open();
    const opener = await screen.findByRole("button", { name: BULK(3) });
    opener.focus();
    expect(opener).toHaveFocus();
    fireEvent.click(opener);
    const dlg = await screen.findByRole("dialog");
    fireEvent.click(within(dlg).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("전부 성공해 열기 단추가 사라진 뒤 [닫기]하면 초점이 ‘가정·결정 제안’ 제목으로 간다", async () => {
    onlyThree();
    await open();
    const dlg = await openDialog(3);
    go(dlg, 3);
    await screen.findByText("3개 중 3개 받아들임 · 0개 실패", {}, T);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole("button", { name: /모두 받아들이기/ })).not.toBeInTheDocument());
    const heading = screen.getByRole("heading", { name: PROPOSAL_HEADING });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("부분 실패 뒤 [닫기]하면(열기 단추가 남음) 초점이 열기 단추로 돌아온다", async () => {
    // pp1 + a1 a2 a3 모두 묶음 대상(4개). a2 만 실패하면 최종 판단 전 가정은 a2 한 건이다.
    // 이 시험은 갱신이 도착하기 전의 일시 상태(남은 단추·초점)만 본다 — 최종 상태는 아래 ‘갱신 뒤’ 시험이 확인한다.
    seedThree();
    failAssumption("a2");
    await open();
    const opener = await screen.findByRole("button", { name: BULK(4) });
    opener.focus();
    fireEvent.click(opener);
    const dlg = await screen.findByRole("dialog");
    go(dlg, 4);
    await screen.findByText("4개 중 3개 받아들임 · 1개 실패", {}, T);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // 갱신 전 일시 상태: 아직 목록이 낡아 일괄 단추가 남아 있을 수 있다(이 단추는 최종 상태가 아니다)
    // 마지막 목록 갱신이 끝나면 최종 잔여는 a2 한 건이라 일괄 단추(2개 이상일 때만)는 사라진다
    await waitFor(() => expect(screen.queryByRole("button", { name: /모두 받아들이기/ })).not.toBeInTheDocument(), T);
    expect(pendingIds("assumption")).toEqual(["a2"]);
    // 초점은 body 로 빠지지 않고 제안 제목에 있다
    const heading = screen.getByRole("heading", { name: PROPOSAL_HEADING });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("부분 성공 직후 닫아도, 늦게 온 목록 갱신으로 열기 단추가 사라지면 초점이 제안 제목으로 간다(body 로 빠지지 않음)", async () => {
    onlyThree(); // pp1 은 이미 판단됨, a1 a2 a3 만 대상
    failAssumption("a2");
    await open();
    const opener = await screen.findByRole("button", { name: BULK(3) });
    opener.focus();
    fireEvent.click(opener);
    const dlg = await screen.findByRole("dialog");
    go(dlg, 3);
    await screen.findByText("3개 중 2개 받아들임 · 1개 실패", {}, T);
    // 결과가 보이는 즉시 닫는다(마지막 workspace 갱신이 아직 오기 전일 수 있다)
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // 갱신이 끝날 때까지 기다린다: 서버 기준 잔여 a2 한 건이면 일괄 단추(2개 이상)는 사라진다
    await waitFor(() => expect(screen.queryByRole("button", { name: /모두 받아들이기/ })).not.toBeInTheDocument(), T);
    expect(pendingIds("assumption")).toEqual(["a2"]);
    const heading = screen.getByRole("heading", { name: PROPOSAL_HEADING });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(document.activeElement?.tagName).not.toBe("BODY");
  });

  it("부분 성공 뒤 갱신 뒤에도 판단 전 가정이 2개 이상이라 열기 단추가 남으면 초점이 그 열기 단추에 남는다", async () => {
    onlyThree();
    failAssumption("a2");
    await open();
    const opener = await screen.findByRole("button", { name: BULK(3) });
    opener.focus();
    fireEvent.click(opener);
    const dlg = await screen.findByRole("dialog");
    go(dlg, 3);
    // 보내는 동안 다른 곳에서 새 가정이 생긴다(이 대화 상자의 3개에는 들어 있지 않다)
    addProposal({ id: "a4", kind: "assumption", text: "넷째 가정", basis: "자료 목록 v4" });
    await screen.findByText("3개 중 2개 받아들임 · 1개 실패", {}, T);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // 마지막 갱신 뒤 최종 잔여는 a2·a4 두 건 → 일괄 단추가 남는다
    await waitFor(() => expect(pendingIds("assumption")).toEqual(["a2", "a4"]), T);
    const remaining = await screen.findByRole("button", { name: BULK(2) }, T);
    await waitFor(() => expect(document.activeElement).toBe(remaining));
    expect(spy.keysOf("a4")).toHaveLength(0);
  });
});

describe("F4 결과 불명(응답 유실)은 실패와 따로 센다 — 단정하지 않는다", () => {
  async function runLost() {
    onlyThree();
    await open();
    const dlg = await openDialog(3);
    await act(async () => {
      mockSettings.set({ network: "lost" });
    });
    go(dlg, 3);
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveTextContent(/결과 불명/), T);
    await waitFor(() => expect(within(screen.getByRole("dialog")).queryByRole("status")).toBeInTheDocument(), T);
    return screen.getByRole("dialog");
  }

  it("‘결과 불명 1개’를 따로 세고, 실패로 세지 않으며, ‘판단 전 그대로’라고 단정하지 않는다(서버는 이미 기록함)", async () => {
    const dlg = await runLost();
    expect(pendingIds("assumption")).toEqual([]); // 서버는 셋 다 기록했다
    const s = within(dlg).getByRole("status");
    expect(s).toHaveTextContent(/결과 불명 1개/);
    expect(s).toHaveTextContent(/2개 받아들임/);
    expect(s.textContent ?? "").not.toMatch(/[1-9]\d*개 실패/);
    expect(dlg.textContent ?? "").not.toMatch(/판단 전 그대로/);
    expect(dlg.textContent ?? "").not.toMatch(/[1-9]\d*개 실패/);
    expect(dlg).toHaveTextContent("첫째 가정 첫 줄"); // 어느 가정이 불명인지 보인다
  });

  it("다시 보내면 같은 멱등 키로 보내고(두 번 처리하지 않음), 확인되면 ‘결과 불명’이 사라진다", async () => {
    await runLost();
    const firstKey = spy.keysOf("a1");
    expect(firstKey).toHaveLength(1);
    const callsBefore = decisionCalls();
    fireEvent.click(retryButton());
    await screen.findByText("3개 중 3개 받아들임", { exact: false }, T);
    expect(spy.keysOf("a1")).toEqual([firstKey[0], firstKey[0]]);
    expect(spy.keysOf("a2")).toHaveLength(1); // 이미 받아들인 것은 다시 보내지 않는다
    expect(spy.keysOf("a3")).toHaveLength(1);
    expect(decisionCalls()).toBe(callsBefore); // 같은 키 재전송은 새 처리가 아니다(replayed)
    expect(screen.getByRole("dialog").textContent ?? "").not.toMatch(/결과 불명/);
  });
});

describe("키 — 재시도할 수 없는 실패는 새 멱등 키, 결과 불명은 같은 키", () => {
  it("버전 충돌 뒤 [실패한 것만 다시]는 그 가정에 새 키를 쓴다", async () => {
    onlyThree();
    failAssumption("a2");
    await open();
    const dlg = await openDialog(3);
    go(dlg, 3);
    await screen.findByText("3개 중 2개 받아들임 · 1개 실패", {}, T);
    const first = spy.keysOf("a2");
    expect(first).toHaveLength(1);
    failAssumption(null);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "실패한 것만 다시" }));
    await waitFor(() => expect(pendingIds("assumption")).toEqual([]), T);
    const all = spy.keysOf("a2");
    expect(all).toHaveLength(2);
    expect(all[1]).not.toBe(all[0]);
    expect(spy.keysOf("a1")).toHaveLength(1);
  });

  it("권한 실패 뒤 [실패한 것만 다시]는 가정마다 새 키를 쓴다", async () => {
    onlyThree();
    await open();
    const dlg = await openDialog(3);
    await act(async () => {
      mockSettings.set({ role: "reader" });
    });
    go(dlg, 3);
    await screen.findByText("3개 중 0개 받아들임 · 3개 실패", {}, T);
    await act(async () => {
      mockSettings.set({ role: "owner" });
    });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "실패한 것만 다시" }));
    await waitFor(() => expect(pendingIds("assumption")).toEqual([]), T);
    for (const id of ["a1", "a2", "a3"]) {
      const k = spy.keysOf(id);
      expect(k).toHaveLength(2);
      expect(k[1]).not.toBe(k[0]);
    }
  });

  it("결과 불명과 버전 충돌이 함께 있으면: 결과 불명 a1 은 같은 키, 충돌 a2 는 새 키", async () => {
    onlyThree();
    failAssumption("a2");
    await open();
    const dlg = await openDialog(3);
    await act(async () => {
      mockSettings.set({ network: "lost" });
    });
    go(dlg, 3);
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveTextContent(/결과 불명/), T);
    await waitFor(() => expect(within(screen.getByRole("dialog")).queryByRole("status")).toBeInTheDocument(), T);
    failAssumption(null);
    fireEvent.click(retryButton());
    await waitFor(() => expect(pendingIds("assumption")).toEqual([]), T);
    await screen.findByText("3개 중 3개 받아들임", { exact: false }, T);
    const k1 = spy.keysOf("a1");
    const k2 = spy.keysOf("a2");
    expect(k1).toHaveLength(2);
    expect(k1[1]).toBe(k1[0]);
    expect(k2).toHaveLength(2);
    expect(k2[1]).not.toBe(k2[0]);
  });
});

describe("1차 재확인 권장 — 663cf52 반영분 (지금 통과해야 정상)", () => {
  it("다시 보내는 동안에는 실패한 행만 보이고 제목·설명이 다시 보내기다", async () => {
    onlyThree();
    failAssumption("a2");
    await open();
    const dlg = await openDialog(3);
    go(dlg, 3);
    await screen.findByText("3개 중 2개 받아들임 · 1개 실패", {}, T);
    failAssumption(null);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "실패한 것만 다시" }));
    const running = screen.getByRole("dialog");
    expect(within(running).getByText("실패한 가정 1개 다시 보내기")).toBeInTheDocument();
    const items = within(within(running).getByRole("list", { name: "다시 보낼 가정" })).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("둘째 가정");
    expect(running).not.toHaveTextContent("셋째 가정");
    await waitFor(() => expect(pendingIds("assumption")).toEqual([]), T);
  });

  it("끝나면 결과 문단(role=status)으로 초점이 오고, 다시 보낸 뒤에도 그렇다", async () => {
    onlyThree();
    failAssumption("a2");
    await open();
    const dlg = await openDialog(3);
    go(dlg, 3);
    await screen.findByText("3개 중 2개 받아들임 · 1개 실패", {}, T);
    await waitFor(() => expect(document.activeElement).toBe(status()));
    failAssumption(null);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "실패한 것만 다시" }));
    await screen.findByText("3개 중 3개 받아들임 · 0개 실패", {}, T);
    await waitFor(() => expect(document.activeElement).toBe(status()));
  });

  it("다시 보낼 때 이미 받아들인 가정에는 명령을 다시 보내지 않는다", async () => {
    onlyThree();
    failAssumption("a2");
    await open();
    const dlg = await openDialog(3);
    go(dlg, 3);
    await screen.findByText("3개 중 2개 받아들임 · 1개 실패", {}, T);
    failAssumption(null);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "실패한 것만 다시" }));
    await waitFor(() => expect(pendingIds("assumption")).toEqual([]), T);
    expect(spy.keysOf("a1")).toHaveLength(1);
    expect(spy.keysOf("a3")).toHaveLength(1);
  });
});

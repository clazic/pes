// SEL-84 U1d — 과거 승인 · stale · 중단/취소/인계 · 실행 권한 · 기록 없음 (Vitest, jsdom). 구현 전이라 실패가 정상. 계약: src/test/u1d.ts 머리말.
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PERMISSIONS, RUNS, UNKNOWN, fakeBoot, httpBoot, migratedSynthetic, recordPanel, runPanel, stageLink, staleAfterApproval, unstubServer, withAi, ws } from "@/test/u1d";

afterEach(() => {
  unstubServer();
  cleanup();
});

const LABEL = { interrupted: /중단됨/, cancelled: /취소됨/, handed_off: /인계됨/ } as const;

describe("과거 승인과 stale 을 함께", () => {
  it("승인된 뒤 stale 인 단계는 '과거 승인'과 stale 이름('앞 단계 변경')이 한 링크에 같이 보인다", async () => {
    const { open } = fakeBoot(staleAfterApproval());
    await open();
    const link = stageLink(/기획/)!;
    expect(link.textContent).toMatch(/과거 승인/);
    expect(link.textContent).toMatch(/앞 단계 변경/);
  });

  it("stale 이 아닌 승인 단계는 '승인됨'이고 stale 말이 없다", async () => {
    const { open } = fakeBoot(ws());
    await open();
    const link = stageLink(/기획/)!;
    expect(link.textContent).toMatch(/승인됨/);
    expect(link.textContent).not.toMatch(/앞 단계 변경/);
  });

  it("서버가 과거 승인을 안 실은 stale(오늘 서버 모양)은 stale 만 말하고 과거 승인을 지어내지 않는다", async () => {
    const w = staleAfterApproval();
    for (const s of w.stages) delete (s as unknown as Record<string, unknown>).past_approval;
    const { open } = fakeBoot(w);
    await open();
    const link = stageLink(/기획/)!;
    expect(link.textContent).toMatch(/앞 단계 변경/);
    expect(link.textContent).not.toMatch(/과거 승인/);
  });

  it("legacy_unverified 승인은 '검증 안 됨'이 붙고 깨끗한 '승인됨'으로 보이지 않는다", async () => {
    const { open } = fakeBoot(migratedSynthetic());
    await open();
    const link = stageLink(/기획/)!;
    expect(link.textContent).toMatch(/검증 안 됨/);
  });

  it("HTTP 클라이언트도 같은 표시", async () => {
    await httpBoot(staleAfterApproval());
    const link = stageLink(/기획/)!;
    expect(link.textContent).toMatch(/과거 승인/);
    expect(link.textContent).toMatch(/앞 단계 변경/);
  });
});

describe("실행 패널: 중단 · 취소 · 인계는 서로 다른 상태", () => {
  it("세 실행이 각자 자기 낱말만 쓴다", async () => {
    const { open } = fakeBoot(withAi({ policy: "allowed" }, { runs: RUNS }));
    await open();
    const panel = runPanel();
    const row = (id: string) => panel.querySelector<HTMLElement>(`[data-run="${id}"]`)!;
    const cases = [["run-int", "interrupted"], ["run-can", "cancelled"], ["run-hand", "handed_off"]] as const;
    for (const [id, status] of cases) {
      expect(row(id), id).not.toBeNull();
      expect(row(id).getAttribute("data-status")).toBe(status);
      for (const other of Object.keys(LABEL) as Array<keyof typeof LABEL>) {
        if (other === status) expect(row(id).textContent, `${id} 자기 낱말`).toMatch(LABEL[other]);
        else expect(row(id).textContent, `${id} 남의 낱말 ${other}`).not.toMatch(LABEL[other]);
      }
    }
  });

  it("중단됨인데 외부 중단이 unknown 이면 unknown 이라 말하고 '중단 확인됨'이라 하지 않는다(연결 끊김 ≠ 취소)", async () => {
    const { open } = fakeBoot(withAi({ policy: "allowed" }, { runs: RUNS }));
    await open();
    const text = runPanel().querySelector<HTMLElement>('[data-run="run-int"]')!.textContent ?? "";
    expect(text).toMatch(UNKNOWN);
    expect(text).not.toMatch(/중단 확인됨|취소됨/);
  });

  it("HTTP 클라이언트도 같은 상태 구분", async () => {
    await httpBoot(withAi({ policy: "allowed" }, { runs: RUNS }));
    const row = (id: string) => runPanel().querySelector<HTMLElement>(`[data-run="${id}"]`)!;
    expect(row("run-hand").textContent).toMatch(/인계됨/);
    expect(row("run-hand").textContent).not.toMatch(/취소됨|중단됨/);
    expect(row("run-can").textContent).toMatch(/취소됨/);
  });

  it("실행이 없으면 패널은 남고 빈 목록을 지어내지 않는다", async () => {
    const { open } = fakeBoot(ws());
    await open();
    expect(runPanel().querySelector("[data-run]")).toBeNull();
  });
});

describe("실행 권한 ≠ 연구 질문", () => {
  it("외부 앱의 질문·권한은 실행 패널의 '실행 권한' 안에만 있고 출처 낱말이 붙는다", async () => {
    const { open } = fakeBoot(withAi({ policy: "allowed" }, { run_permissions: PERMISSIONS }));
    await open();
    const group = within(runPanel()).getByRole("group", { name: "실행 권한" });
    for (const p of PERMISSIONS) expect(group.querySelector(`[data-permission="${p.id}"]`), p.id).not.toBeNull();
    expect(group.querySelector('[data-permission="perm-ext-q"]')!.textContent).toMatch(/외부 앱/);
    expect(group.querySelector('[data-permission="perm-pes"]')!.textContent).toMatch(/PES/);
    expect(group.querySelector('[data-permission="perm-pes"]')!.textContent).not.toMatch(/외부 앱/);
  });

  it("질문 영역(연구 질문)에는 실행 권한이 섞이지 않고, 실행 패널에는 연구 질문이 섞이지 않는다", async () => {
    const { open } = fakeBoot(withAi({ policy: "allowed" }, { run_permissions: PERMISSIONS }));
    await open();
    const ask = screen.getByRole("complementary", { name: "질문" });
    for (const p of PERMISSIONS) expect(ask.textContent).not.toContain(p.text);
    expect(ask.querySelector("[data-permission]")).toBeNull();
    const panel = runPanel();
    expect(panel.querySelector("#q-21, #q-22")).toBeNull();
    expect(panel.textContent).not.toContain("이 연구로 무엇을");
    // 연구 질문 칸(답 입력)은 계속 질문 영역에 있다
    expect(within(ask).getAllByRole("textbox").length).toBeGreaterThan(0);
  });

  it("실행 권한은 답 칸(textbox)이 아니다 — 연구 질문 답으로 보낼 수 없다", async () => {
    const { open } = fakeBoot(withAi({ policy: "allowed" }, { run_permissions: PERMISSIONS }));
    await open();
    const group = within(runPanel()).getByRole("group", { name: "실행 권한" });
    expect(within(group).queryAllByRole("textbox")).toHaveLength(0);
  });

  it("HTTP 클라이언트도 같은 구분", async () => {
    await httpBoot(withAi({ policy: "allowed" }, { run_permissions: PERMISSIONS }));
    expect(within(runPanel()).getByRole("group", { name: "실행 권한" }).querySelector('[data-permission="perm-ext-p"]')).not.toBeNull();
  });
});

describe("이전된 합성 프로젝트 → 기록 없음", () => {
  const rows = () => (["assumptions", "decisions", "comments"] as const).map((k) => recordPanel().querySelector<HTMLElement>(`[data-record="${k}"]`)!);

  it("가정·결정·의견이 모두 없으면 세 행이 모두 '기록 없음'", async () => {
    const { open } = fakeBoot(migratedSynthetic());
    await open();
    for (const r of rows()) {
      expect(r).not.toBeNull();
      expect(r.textContent).toMatch(/기록 없음/);
    }
  });

  it("일부만 있으면 있는 행은 개수, 없는 행만 '기록 없음'", async () => {
    const { open } = fakeBoot(withAi({ policy: "allowed" }, { records: { assumptions: { count: 2 }, decisions: { count: 0 }, comments: { count: 0 }, empty: false } }));
    await open();
    const [a, d, c] = rows();
    expect(a.textContent).toMatch(/2/);
    expect(a.textContent).not.toMatch(/기록 없음/);
    expect(d.textContent).toMatch(/기록 없음/);
    expect(c.textContent).toMatch(/기록 없음/);
  });

  it("서버 칸이 아예 없으면(records 없음) 0건이라 단정하지 않는다 — '기록 없음'을 지어내지 않는다", async () => {
    const { open } = fakeBoot(ws());
    await open();
    expect(recordPanel().textContent).not.toMatch(/기록 없음/);
  });

  it("이전된 프로젝트의 나머지 화면(단계 링크 · 질문 영역 · 칩)이 깨지지 않는다", async () => {
    const { open } = fakeBoot(migratedSynthetic());
    await open();
    expect(screen.getByRole("complementary", { name: "질문" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^AI 연결/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("HTTP 클라이언트(서버 records.empty 그대로)도 '기록 없음'", async () => {
    await httpBoot(migratedSynthetic());
    for (const r of rows()) expect(r.textContent).toMatch(/기록 없음/);
  });
});

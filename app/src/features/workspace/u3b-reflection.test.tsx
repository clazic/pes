// SEL-94 U3b — 다음 라운드 첫머리 반영 요약(막대 + 표) · applied/partial 의미 증거 · 미제출 / 0건 / 기록 없음 (Vitest, jsdom). 계약: src/test/u3b.ts 머리말.
// 근거 링크 중 결과 버전은 앱 안 라운드 주소(라우터 링크), 보고서 · 산출물 주소는 같은 탭 전체 이동(머리말, SEL-86 병합 뒤 재확인).
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CORRUPT, MISSING, R_APPLIED, R_DEFERRED, R_PARTIAL, R_REJECTED, R_UNVERIFIED, REFLECTION_FULL, ROUND_RESEARCH_2, boot, cell, cellText, fullData, goWordsIn, region, row, rowOf, type U3Data } from "@/test/u3b";
import { WIDTHS, url } from "@/test/contract";

afterEach(cleanup);

const text = (el: HTMLElement | null) => el?.textContent ?? "";
const open = (data: U3Data = fullData(), path = ROUND_RESEARCH_2, env = {}) => boot(data, path, env);
const seg = (name: string) => document.querySelector<HTMLElement>(`[data-reflection-bar] [data-seg="${name}"]`);
const reflectionOnly = (entries: typeof REFLECTION_FULL.entries): U3Data => ({ ...fullData(), reflections: { "research/2": { submission: "submitted", sent_count: entries.length, entries } } });

describe("라운드 첫머리에 반영 내역", () => {
  it("작업 공간 라운드 화면 본문 맨 위(화면 제목 뒤, U1d '기록' 영역 앞)에 region '반영 내역'이 있다", async () => {
    await open();
    const r = region("반영 내역");
    const title = screen.getByRole("main").querySelector("[data-screen-title]")!;
    const records = region("기록");
    expect(title.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(r.compareDocumentPosition(records) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("main").contains(r)).toBe(true);
    // 질문 영역(aside)에는 두지 않는다
    expect(within(screen.getByRole("complementary", { name: "질문" })).queryByRole("region", { name: "반영 내역" })).toBeNull();
  });

  it("이 라운드(단계·번호)의 반영을 읽는다 — getReflections(slug, 판, 단계, 라운드)", async () => {
    const { u3 } = await open();
    await rowOf("reflection", R_APPLIED.id);
    expect(u3.readCalls("getReflections")[0].args).toEqual(["sample-study", 1, "research", "2"]);
  });

  it("단계 시작 화면은 round 인자로 'start' 를 쓴다", async () => {
    const { u3 } = await open(fullData(), url("research", "start"));
    await waitFor(() => expect(u3.readCalls("getReflections").length).toBeGreaterThan(0));
    expect(u3.readCalls("getReflections")[0].args.slice(2)).toEqual(["research", "start"]);
  });

  it("요약 막대: 적용 · 부분 · 유예 · 거절을 낱말 + 개수로 말하고, 증거 없는 줄은 적용에 세지 않는다", async () => {
    await open();
    await rowOf("reflection", R_APPLIED.id);
    const bar = document.querySelector("[data-reflection-bar]")!;
    expect(bar).not.toBeNull();
    expect(text(seg("applied"))).toMatch(/적용.*1/);
    expect(text(seg("partial"))).toMatch(/부분.*1/);
    expect(text(seg("deferred"))).toMatch(/유예.*1/);
    expect(text(seg("rejected"))).toMatch(/거절.*1/);
    // R_UNVERIFIED 는 disposition 이 applied 지만 증거가 없다
    expect(text(seg("unverified"))).toMatch(/증거 없음.*1/);
  });

  it("증거가 모두 갖춰진 목록에는 '증거 없음' 조각이 없다", async () => {
    await open(reflectionOnly([R_APPLIED, R_PARTIAL, R_DEFERRED, R_REJECTED]));
    await rowOf("reflection", R_APPLIED.id);
    expect(text(seg("applied"))).toMatch(/적용.*1/);
    const un = seg("unverified");
    expect(un === null || /\b0\b|0건/.test(text(un)) || text(un).trim() === "").toBe(true);
    expect(text(region("반영 내역"))).not.toMatch(MISSING);
  });

  it("표: 줄마다 의견 · 처리 · 근거(rationale) · 판단자가 있고, 처리 낱말이 서로 다르다", async () => {
    await open();
    const rows = await Promise.all([R_APPLIED, R_PARTIAL, R_DEFERRED, R_REJECTED].map((x) => rowOf("reflection", x.id)));
    const words = rows.map((r) => cellText(r, "state").trim());
    expect(words[0]).toMatch(/^적용/);
    expect(words[1]).toMatch(/^부분/);
    expect(words[2]).toMatch(/^유예/);
    expect(words[3]).toMatch(/^거절/);
    expect(new Set(words).size).toBe(4);
    for (const [i, r] of rows.entries()) {
      expect(cellText(r, "opinion")).toContain([R_APPLIED, R_PARTIAL, R_DEFERRED, R_REJECTED][i].opinion);
      expect(cellText(r, "rationale")).toContain([R_APPLIED, R_PARTIAL, R_DEFERRED, R_REJECTED][i].rationale);
      expect(cellText(r, "judge")).toContain("검토자 하늘");
    }
    expect(within(region("반영 내역")).getByRole("table", { name: /반영 내역/ })).toBeTruthy();
  });
});

describe("applied / partial 은 의미 증거가 있어야 성공으로 보인다", () => {
  it("applied: 적용 tx 와 결과 버전 링크가 증거 칸에 보인다(결과 버전은 앱 안 라우터 링크)", async () => {
    const { user, router } = await open();
    const r = await rowOf("reflection", R_APPLIED.id);
    expect(r.getAttribute("data-evidence")).toBe("ok");
    expect(cellText(r, "evidence")).toContain("tx-0901");
    const link = within(cell(r, "evidence")!).getByRole("link", { name: /조사 결과 글 v3/ });
    expect(link.getAttribute("href")).toBe(ROUND_RESEARCH_2);
    await user.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe(ROUND_RESEARCH_2));
  });

  it("partial: 적용된 후속(다음 라운드 할 일)이 증거 — 후속 종류와 이름이 보인다", async () => {
    await open();
    const r = await rowOf("reflection", R_PARTIAL.id);
    expect(r.getAttribute("data-evidence")).toBe("ok");
    expect(cellText(r, "evidence")).toContain("tx-0902");
    expect(cellText(r, "evidence")).toMatch(/다음 라운드 할 일/);
    expect(cellText(r, "evidence")).toContain("R3 에서 노년층 자료 더 찾기");
  });

  it("유예 + reopen 제안(제안 상태): 후속은 '앞 단계 다시 열기 · 제안'으로 보이고 적용으로 보이지 않는다. 유예는 증거를 요구하지 않는다", async () => {
    await open();
    const r = await rowOf("reflection", R_DEFERRED.id);
    expect(r.getAttribute("data-evidence")).toBe("none");
    expect(cellText(r, "evidence")).toMatch(/앞 단계 다시 열기/);
    expect(cellText(r, "evidence")).toMatch(/제안/);
    expect(cellText(r, "evidence")).not.toMatch(/적용/);
    expect(text(r)).not.toMatch(MISSING);
  });

  it("거절: 증거 없이도 정상 — '증거 없음' 경고를 달지 않는다", async () => {
    await open();
    const r = await rowOf("reflection", R_REJECTED.id);
    expect(r.getAttribute("data-evidence")).toBe("none");
    expect(text(r)).not.toMatch(MISSING);
    expect(cellText(r, "rationale")).toContain("연구 범위 밖");
  });

  it("증거가 모자란 applied 는 '적용'이라 쓰지 않고 '증거 없음'", async () => {
    await open();
    const r = await rowOf("reflection", R_UNVERIFIED.id);
    expect(r.getAttribute("data-evidence")).toBe("missing");
    expect(cellText(r, "state")).toMatch(MISSING);
    expect(cellText(r, "state")).not.toMatch(/^\s*적용\s*$/);
    expect(r.getAttribute("data-disposition")).toBe("applied"); // 기계 값은 그대로 — 화면만 성공으로 읽히지 않게
  });

  for (const [name, entry] of Object.entries(CORRUPT)) {
    it(`증거 모자람 사례 — ${name}: 성공(적용/부분)으로 보이지 않는다`, async () => {
      await open(reflectionOnly([entry]));
      const r = await rowOf("reflection", entry.id);
      expect(r.getAttribute("data-evidence")).toBe("missing");
      expect(cellText(r, "state")).toMatch(MISSING);
      expect(cellText(r, "state")).not.toMatch(/^\s*(적용|부분)\s*$/);
      expect(text(seg("applied"))).not.toMatch(/[1-9]/);
      expect(text(seg("partial"))).not.toMatch(/[1-9]/);
      expect(text(seg("unverified"))).toMatch(/1/);
    });
  }

  it("근거(source) 링크로 원문 의견의 출처에 닿는다", async () => {
    await open();
    const r = await rowOf("reflection", R_APPLIED.id);
    const link = within(cell(r, "source")!).getByRole("link", { name: /첨언 12/ });
    expect(link.getAttribute("href")).toBe(url("research", 1));
  });
});

describe("미제출 · 0건 · 기록 없음은 서로 다르다", () => {
  const withView = (view: U3Data["reflections"][string]): U3Data => ({ ...fullData(), reflections: { "research/2": view } });
  const summary = async (view: U3Data["reflections"][string]) => {
    await open(withView(view));
    const r = region("반영 내역");
    await waitFor(() => expect(text(r).trim().length).toBeGreaterThan("반영 내역".length));
    return text(r);
  };

  it("의견을 제출하지 않았으면 '미제출' — 0건이라 쓰지 않는다", async () => {
    const t = await summary({ submission: "none", sent_count: 0, entries: [] });
    expect(t).toMatch(/미제출/);
    expect(t).not.toMatch(/0건|기록 없음/);
  });

  it("제출했는데 처리된 줄이 없으면 '처리 0건' — 미제출이라 쓰지 않는다", async () => {
    const t = await summary({ submission: "submitted", sent_count: 3, entries: [] });
    expect(t).toMatch(/처리 0건/);
    expect(t).not.toMatch(/미제출|기록 없음/);
  });

  it("서버가 반영 자료를 주지 않으면(null, 이전된 프로젝트) '기록 없음'", async () => {
    const t = await summary(null);
    expect(t).toMatch(/기록 없음/);
    expect(t).not.toMatch(/미제출|0건/);
  });

  it("세 경우의 요약 글이 모두 다르다", async () => {
    const a = await summary({ submission: "none", sent_count: 0, entries: [] });
    cleanup();
    const b = await summary({ submission: "submitted", sent_count: 3, entries: [] });
    cleanup();
    const c = await summary(null);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("미제출 · 0건 · 기록 없음일 때는 요약 막대를 그리지 않거나 빈 막대에 성공 색 칸이 없다", async () => {
    await summary({ submission: "none", sent_count: 0, entries: [] });
    expect(document.querySelector('[data-reflection-bar] [data-seg="applied"]')?.textContent ?? "").not.toMatch(/[1-9]/);
    expect(row("reflection", R_APPLIED.id)).toBeNull();
  });

  it("반영 읽기가 실패하면 '기록 없음'·'미제출'이 아니라 불러오지 못했다고 알린다", async () => {
    await boot(fullData(), ROUND_RESEARCH_2, {}, (u3) => u3.breakRead("getReflections"));
    const r = region("반영 내역");
    await waitFor(() => expect(text(r)).toMatch(/불러오지 못했/));
    expect(text(r)).not.toMatch(/기록 없음|미제출|0건/);
  });
});

describe("접근성 · 인쇄 · 좁은 화면", () => {
  it("화면 어디에도 낱말 'Go' 가 없고, 상태는 색이 아니라 낱말로 있다", async () => {
    await open();
    await rowOf("reflection", R_APPLIED.id);
    expect(goWordsIn()).toEqual([]);
    for (const r of document.querySelectorAll<HTMLElement>("[data-reflection]")) expect(cellText(r, "state").trim().length).toBeGreaterThan(0);
  });

  it("인쇄 미리보기(?print=1)에서도 반영 내역 영역과 표가 남는다", async () => {
    await open(fullData(), `${ROUND_RESEARCH_2}?print=1`);
    await rowOf("reflection", R_APPLIED.id);
    expect(screen.getByRole("region", { name: "인쇄 미리보기" })).toBeTruthy();
    expect(region("반영 내역").closest("[data-print='hide']")).toBeNull();
  });

  it("390px 휴대폰에서도 같은 낱말 · 막대 · 증거가 있다", async () => {
    await open(fullData(), ROUND_RESEARCH_2, { width: WIDTHS.phone, coarse: true });
    const r = await rowOf("reflection", R_APPLIED.id);
    expect(cellText(r, "evidence")).toContain("tx-0901");
    expect(text(seg("applied"))).toMatch(/적용.*1/);
  });

  it("다른 라운드로 가도 그 라운드의 반영만 읽는다(옛 라운드 자료가 새 라운드에 남지 않음)", async () => {
    const data = fullData();
    data.reflections["research/1"] = { submission: "submitted", sent_count: 1, entries: [{ ...R_REJECTED, id: "rf-old", opinion: "옛 라운드 의견" }] };
    const { u3 } = await open(data, url("research", 1));
    await rowOf("reflection", "rf-old");
    expect(row("reflection", R_APPLIED.id)).toBeNull();
    expect(u3.readCalls("getReflections")[0].args.slice(2)).toEqual(["research", "1"]);
  });
});

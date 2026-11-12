// SEL-94 U3b — 가정·결정 표 · AI 제안 vs 사람 판단 · 고침 · needs_review · 대체 사슬 · 근거 링크 · 기록 없음 (Vitest, jsdom). 계약: src/test/u3b.ts 머리말.
// 근거 링크가 보고서·산출물(/<slug>/reports · out)로 가면 같은 탭 전체 이동이다 — SEL-86 병합 뒤 주소 모양을 다시 확인할 것(머리말 참고).
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PLAN_REPORT, OUT_DOC, R1_RESULT, HUMAN, boot, cell, cellText, fullData, goWordsIn, migratedData, region, rowOf } from "@/test/u3b";
import { WIDTHS } from "@/test/contract";

afterEach(cleanup);

const text = (el: HTMLElement | null) => el?.textContent ?? "";

describe("표 구조", () => {
  it("화면 제목과 세 영역(가정 · 결정 · 반영 내역), 각 영역에 이름 있는 표 하나", async () => {
    await boot();
    expect(screen.getByRole("main").querySelector("[data-screen-title]")?.textContent).toMatch(/가정.*결정.*반영/);
    for (const name of ["가정", "결정", "반영 내역"]) {
      const r = region(name);
      const tables = within(r).getAllByRole("table");
      expect(tables, name).toHaveLength(1);
      expect(within(r).getByRole("table", { name: new RegExp(name) })).toBeTruthy();
      for (const th of r.querySelectorAll("thead th")) expect(th.getAttribute("scope"), `${name} 머리칸 scope`).toBe("col");
    }
  });

  it("가정 표에 버전 · 판단자 · 근거 칸, 결정 표에 버전 · 결정자 · 범위 · 근거 칸 머리", async () => {
    await boot();
    const heads = (name: string) => [...region(name).querySelectorAll("thead th")].map((th) => th.textContent ?? "").join("|");
    expect(heads("가정")).toMatch(/버전/);
    expect(heads("가정")).toMatch(/판단자/);
    expect(heads("가정")).toMatch(/근거/);
    expect(heads("결정")).toMatch(/버전/);
    expect(heads("결정")).toMatch(/결정자|판단자/);
    expect(heads("결정")).toMatch(/범위/);
    expect(heads("결정")).toMatch(/근거/);
  });

  it("화면 어디에도 낱말 'Go' 가 없다", async () => {
    await boot();
    await rowOf("assumption", "as-1");
    expect(goWordsIn()).toEqual([]);
  });
});

describe("AI 제안과 사람 판단이 다르게 보인다", () => {
  it("AI 제안(판단 전)은 판단자가 비어 있고, 사람 확인은 판단자 이름이 있다", async () => {
    await boot();
    const proposed = await rowOf("assumption", "as-1");
    const confirmed = await rowOf("assumption", "as-2");
    expect(cellText(proposed, "state")).toMatch(/판단 전/);
    expect(cellText(proposed, "proposer")).toMatch(/AI/);
    expect(cellText(proposed, "judge")).not.toContain(HUMAN.name);
    expect(cellText(confirmed, "state")).toMatch(/확인/);
    expect(cellText(confirmed, "judge")).toContain(HUMAN.name);
    expect(cellText(confirmed, "rationale")).toMatch(/정의서와 대조/);
  });

  it("제안(proposed)은 확인·채택처럼 읽히지 않는다 — 상태 칸에 '확인'·'채택' 없음", async () => {
    await boot();
    const proposed = await rowOf("assumption", "as-1");
    expect(cellText(proposed, "state")).not.toMatch(/확인|채택|틀림|고침/);
    const dec = await rowOf("decision", "dec-4");
    expect(cellText(dec, "state")).toMatch(/제안/);
    expect(cellText(dec, "state")).not.toMatch(/채택|대체|철회/);
    expect(cellText(dec, "judge")).not.toContain(HUMAN.name);
    expect(cellText(dec, "proposer")).toMatch(/AI/);
  });

  it("네 가정 상태(판단 전 · 확인 · 틀림 · 고침)는 서로 다른 낱말이고 행 data-state 로도 갈린다", async () => {
    await boot();
    const ids = ["as-1", "as-2", "as-3", "as-4"];
    const states = new Map<string, string>();
    for (const id of ids) {
      const r = await rowOf("assumption", id);
      states.set(id, cellText(r, "state").trim());
      expect(r.getAttribute("data-state")).toBe({ "as-1": "proposed", "as-2": "confirmed", "as-3": "rejected", "as-4": "revised" }[id]);
    }
    expect(new Set(states.values()).size).toBe(4);
    expect(states.get("as-3")).toMatch(/틀림/);
    expect(states.get("as-4")).toMatch(/고침/);
  });

  it("confirmed 인데 판단자가 AI 이면 '사람 판단 없음' — 확인으로 보이지 않는다", async () => {
    await boot();
    const r = await rowOf("assumption", "as-6");
    expect(cellText(r, "state")).toMatch(/사람 판단 없음/);
    expect(cellText(r, "state")).not.toMatch(/^\s*확인\s*$/);
  });

  it("confirmed 인데 판단자 칸이 비었어도(손상) 확인으로 보이지 않는다", async () => {
    const data = fullData();
    data.assumptions.find((x) => x.object_id === "as-2")!.assessed_by = null;
    await boot(data);
    const r = await rowOf("assumption", "as-2");
    expect(cellText(r, "state")).toMatch(/사람 판단 없음/);
  });

  it("adopted 인데 결정자가 없거나 AI 이면 '사람 판단 없음' — 채택으로 보이지 않는다", async () => {
    const data = fullData();
    data.decisions.find((x) => x.object_id === "dec-3")!.decided_by = null;
    data.decisions.find((x) => x.object_id === "dec-2")!.decided_by = { id: "act-ai", kind: "ai", name: "조사 AI" };
    await boot(data);
    for (const id of ["dec-3", "dec-2"]) expect(cellText(await rowOf("decision", id), "state"), id).toMatch(/사람 판단 없음/);
  });
});

describe("고침(revised)은 판단자 + 근거를 남기고 원문을 보존한다", () => {
  it("새 문장은 내용 칸, 고치기 전 문장은 원문 칸 — 둘 다 보이고 섞이지 않는다", async () => {
    await boot();
    const r = await rowOf("assumption", "as-4");
    expect(cellText(r, "statement")).toContain("2021년 이전과 이후를 나눠서");
    expect(cellText(r, "statement")).not.toContain("2019년부터 같은 정의");
    expect(cell(r, "original")).not.toBeNull();
    expect(cellText(r, "original")).toContain("방문 수는 2019년부터 같은 정의다");
    expect(cellText(r, "judge")).toContain(HUMAN.name);
    expect(cellText(r, "rationale")).toMatch(/정의가 바뀌었다/);
    expect(cellText(r, "version")).toMatch(/2/);
  });

  it("고침이 아닌 행에는 원문 칸이 비어 있다(원문을 지어내지 않음)", async () => {
    await boot();
    const r = await rowOf("assumption", "as-2");
    expect(cellText(r, "original").trim()).toBe("");
  });
});

describe("needs_review — 새 판 복사본도 자동 확인처럼 보이지 않는다", () => {
  it("confirmed + needs_review 는 '재확인 필요'이고 복사 출처가 보인다", async () => {
    await boot();
    const r = await rowOf("assumption", "as-5");
    expect(r.getAttribute("data-needs-review")).toBe("true");
    expect(cellText(r, "state")).toMatch(/재확인 필요/);
    expect(cellText(r, "copied-from")).toMatch(/이전 판에서 복사/);
    expect(within(r).getByRole("button", { name: "확인" })).toBeTruthy();
  });

  it("needs_review 가 아닌 확인 행은 재확인 말이 없다", async () => {
    await boot();
    const r = await rowOf("assumption", "as-2");
    expect(r.getAttribute("data-needs-review")).toBe("false");
    expect(text(r)).not.toMatch(/재확인 필요/);
  });

  it("proposed + needs_review(AI 가 복사해 온 제안)도 판단 전이면서 재확인 필요", async () => {
    const data = fullData();
    const x = data.assumptions.find((v) => v.object_id === "as-1")!;
    x.needs_review = true;
    await boot(data);
    const r = await rowOf("assumption", "as-1");
    expect(cellText(r, "state")).toMatch(/판단 전/);
    expect(text(r)).toMatch(/재확인 필요/);
  });
});

describe("결정: 범위 · 대체 사슬 · 과거를 덮어쓰지 않음", () => {
  it("프로젝트 결정과 판 결정은 범위 칸이 다르고, 판 결정은 당시 버전이 고정되어 보인다", async () => {
    await boot();
    const p = await rowOf("decision", "dec-2");
    const ed = await rowOf("decision", "dec-3");
    expect(p.getAttribute("data-scope")).toBe("project");
    expect(ed.getAttribute("data-scope")).toBe("edition");
    expect(cellText(p, "scope")).toMatch(/프로젝트/);
    expect(cellText(ed, "scope")).toMatch(/이 판/);
    expect(cellText(ed, "scope")).not.toMatch(/프로젝트/);
    expect(text(ed)).toMatch(/1판 결정.*v?2|당시 버전.*2/);
  });

  it("대체한 결정은 옛 결정으로, 옛 결정은 대체한 결정으로 이어진다 — 둘 다 남아 있다", async () => {
    await boot();
    const oldRow = await rowOf("decision", "dec-1");
    const newRow = await rowOf("decision", "dec-2");
    expect(oldRow.id).toBe("decision-dec-1");
    expect(newRow.id).toBe("decision-dec-2");
    const up = within(cell(newRow, "supersedes")!).getByRole("link");
    expect(up.getAttribute("href")).toMatch(/#decision-dec-1$/);
    const down = within(cell(oldRow, "superseded-by")!).getByRole("link");
    expect(down.getAttribute("href")).toMatch(/#decision-dec-2$/);
  });

  it("옛 결정은 '대체됨'이고 문장이 그대로이며, 새 결정 문장과 섞이지 않는다", async () => {
    await boot();
    const oldRow = await rowOf("decision", "dec-1");
    const newRow = await rowOf("decision", "dec-2");
    expect(cellText(oldRow, "state")).toMatch(/대체됨/);
    expect(cellText(oldRow, "statement")).toContain("2019년부터 지금까지로 한다");
    expect(cellText(newRow, "statement")).toContain("2021년부터 지금까지로 한다");
    expect(cellText(newRow, "state")).toMatch(/채택/);
    expect(cellText(newRow, "judge")).toContain(HUMAN.name);
    expect(text(newRow)).toContain("2019년부터 지금까지로 한다"); // 대체한 옛 결정 문장이 보인다
  });

  it("철회된 결정도 문장과 근거를 남기고 '철회'로 보인다", async () => {
    await boot();
    const r = await rowOf("decision", "dec-5");
    expect(cellText(r, "state")).toMatch(/철회/);
    expect(cellText(r, "statement")).toContain("민간 통계도 비교에 넣는다");
    expect(cellText(r, "rationale")).toMatch(/공개 자료가 아니다/);
  });
});

describe("근거 링크로 원문 · 출처에 닿는다", () => {
  it("앱 안 근거는 라우터 링크 — 누르면 새로 고침 없이 그 라운드 화면으로", async () => {
    const { user, router } = await boot();
    const r = await rowOf("assumption", "as-1");
    const link = within(cell(r, "source")!).getByRole("link", { name: /조사 R1 결과 글 v1/ });
    expect(link.getAttribute("href")).toBe(R1_RESULT);
    await user.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe(R1_RESULT));
  });

  it("보고서 · 산출물 근거는 평범한 같은 탭 링크(target 없음) — /<slug>/reports · /<slug>/out", async () => {
    await boot();
    const rep = within(cell(await rowOf("assumption", "as-2"), "source")!).getByRole("link", { name: /기획 보고서/ });
    expect(rep.getAttribute("href")).toBe(PLAN_REPORT);
    expect(rep.hasAttribute("target")).toBe(false);
    const out = within(cell(await rowOf("decision", "dec-2"), "source")!).getByRole("link", { name: /분석 보고서/ });
    expect(out.getAttribute("href")).toBe(OUT_DOC);
    expect(out.hasAttribute("target")).toBe(false);
  });

  it("근거가 없는 행은 링크를 지어내지 않고 '근거 없음'을 말한다", async () => {
    await boot();
    const r = await rowOf("assumption", "as-3");
    expect(within(cell(r, "source")!).queryAllByRole("link")).toHaveLength(0);
    expect(cellText(r, "source")).toMatch(/근거 없음|—/);
  });
});

describe("이전된 합성 프로젝트 — 기록 없음", () => {
  it("가정 · 결정 · 반영이 모두 없으면 각 영역이 '기록 없음'이고 0건이라 단정하지 않는다", async () => {
    await boot(migratedData());
    for (const name of ["가정", "결정", "반영 내역"]) {
      const r = region(name);
      await waitFor(() => expect(text(r)).toMatch(/기록 없음/));
      expect(text(r), name).not.toMatch(/0건|미제출/);
      expect(within(r).queryAllByRole("row").filter((x) => x.querySelector("td"))).toHaveLength(0);
    }
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("가정 읽기가 실패하면 '기록 없음'이 아니라 불러오지 못했다고 알린다(정직) — 다른 영역은 그대로", async () => {
    await boot(fullData(), undefined, {}, (u3) => u3.breakRead("getAssumptions"));
    await rowOf("decision", "dec-2");
    const r = region("가정");
    await waitFor(() => expect(text(r)).toMatch(/불러오지 못했/));
    expect(text(r)).not.toMatch(/기록 없음/);
    expect(text(region("결정"))).not.toMatch(/불러오지 못했/);
  });
});

describe("휴대폰 폭", () => {
  it("390px 에서도 내용 · 상태 · 판단자 · 근거가 모두 읽히고 판단 단추가 있다", async () => {
    await boot(fullData(), undefined, { width: WIDTHS.phone, coarse: true });
    const r = await rowOf("assumption", "as-4");
    expect(cellText(r, "state")).toMatch(/고침/);
    expect(cellText(r, "judge")).toContain(HUMAN.name);
    expect(cellText(r, "original")).toContain("2019년부터 같은 정의");
    const p = await rowOf("assumption", "as-1");
    for (const n of ["확인", "틀림", "고침"]) expect(within(p).getByRole("button", { name: n })).toBeTruthy();
  });
});

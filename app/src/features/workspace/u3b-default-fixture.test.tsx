// SEL-94 U3b — 앱 기본 가짜 클라이언트(합성 fixture)가 e2e 가 기대하는 자료를 가진다. 계약: src/test/u3b.ts 머리말 "e2e 가 기대하는 앱 기본 가짜 클라이언트 자료".
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";
import { ready } from "@/test/ui";
import { CURRENT } from "@/test/contract";
import { RECORDS, cellText, region, rowOf } from "@/test/u3b";

afterEach(cleanup);

describe("기본 가짜 클라이언트 자료 (클라이언트를 주입하지 않은 앱)", () => {
  it("기록 화면: as-1(판단 전 · AI 제안) · as-2(확인 · 사람) · dec-1(대체됨) · dec-2(채택, 옛 결정 대체) · dec-4(제안)", async () => {
    await renderApp(RECORDS, { width: 1440 });
    await ready();
    expect((await rowOf("assumption", "as-1")).getAttribute("data-state")).toBe("proposed");
    expect(cellText(await rowOf("assumption", "as-1"), "proposer")).toMatch(/AI/);
    expect((await rowOf("assumption", "as-2")).getAttribute("data-state")).toBe("confirmed");
    expect((await rowOf("decision", "dec-1")).getAttribute("data-state")).toBe("superseded");
    expect((await rowOf("decision", "dec-2")).getAttribute("data-state")).toBe("adopted");
    expect((await rowOf("decision", "dec-4")).getAttribute("data-state")).toBe("proposed");
  });

  it("조사 R2 첫머리 반영 내역: 증거가 갖춰진 적용 한 줄 이상과 유예 한 줄 이상", async () => {
    await renderApp(CURRENT, { width: 1440 });
    await ready();
    const r = region("반영 내역");
    await rowOf("reflection", [...document.querySelectorAll("[data-reflection]")][0]?.getAttribute("data-reflection") ?? "");
    expect(r.querySelectorAll('[data-reflection][data-disposition="applied"][data-evidence="ok"]').length).toBeGreaterThan(0);
    expect(r.querySelectorAll('[data-reflection][data-disposition="deferred"]').length).toBeGreaterThan(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

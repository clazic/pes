// SEL-126 후속 — 결과 글 머리글 아래 한 줄은 서버가 준 값만 잇는다(없는 칸은 'v0 · 초안' 같은 지어낸 표시 대신 숨긴다).
import { describe, expect, it } from "vitest";
import { resultMetaText } from "@/lib/labels";

describe("resultMetaText", () => {
  it("값이 모두 있으면 v번호 · 채택 여부 · 날짜를 잇는다", () => {
    const t = resultMetaText({ version: 3, status: "adopted", updated_at: "2026-11-13T01:00:00.000Z" });
    expect(t).toMatch(/^v3 · 채택본 · /);
  });

  it("서버가 안 준 칸(null)은 숨긴다 — v0 · 초안 이 나오지 않는다", () => {
    expect(resultMetaText({ version: 2, status: null, updated_at: null })).toBe("v2");
    expect(resultMetaText({ version: null, status: null, updated_at: "2026-11-13T01:00:00.000Z" })).not.toMatch(/v\d|초안|채택/);
  });

  it("아무 값도 없으면 null(줄을 그리지 않는다)", () => {
    expect(resultMetaText({ version: null, status: null, updated_at: null })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { cn } from "./utils";

const SIZES = ["text-caption", "text-meta", "text-body", "text-title", "text-page"] as const;

describe("cn — 글자 크기 토큰(설계 18.1)", () => {
  it("text-meta가 단추의 글자색을 지우지 않는다(“정리하기” 단추 버그 재발 방지)", () => {
    const out = cn("bg-primary text-primary-foreground", "text-meta");
    expect(out.split(" ")).toContain("text-primary-foreground");
    expect(out.split(" ")).toContain("bg-primary");
    expect(out.split(" ")).toContain("text-meta");
  });

  it.each(SIZES)("%s는 글자색 클래스를 지우지 않는다", (size) => {
    const out = cn("text-primary-foreground", size).split(" ");
    expect(out).toContain("text-primary-foreground");
    expect(out).toContain(size);
  });

  it("글자 크기끼리는 나중 것만 남는다 — text-meta 다음 text-body", () => {
    expect(cn("text-meta", "text-body")).toBe("text-body");
  });

  it.each(SIZES.flatMap((a) => SIZES.filter((b) => b !== a).map((b) => [a, b] as const)))("%s 다음 %s는 뒤의 것만", (a, b) => {
    expect(cn(a, b)).toBe(b);
  });

  it("글자색끼리는 여전히 나중 것만 남는다(합치기 규칙은 그대로)", () => {
    expect(cn("text-primary-foreground", "text-foreground")).toBe("text-foreground");
  });

  it("글자 크기와 글자색을 함께 쓴 뒤 크기만 바꿔도 색은 남는다", () => {
    const out = cn("text-caption text-muted-foreground", "text-title").split(" ");
    expect(out).toEqual(expect.arrayContaining(["text-muted-foreground", "text-title"]));
    expect(out).not.toContain("text-caption");
  });
});

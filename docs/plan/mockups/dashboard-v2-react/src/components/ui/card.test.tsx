import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * SEL-62 UI7-1 — Card compact 변형.
 * 요구: <Card size="compact"> 의 겉모습 = 지금 화면의 <Card className="gap-0 px-5"> (자식 간격 0 · 가로 여백 px-5 · 세로 여백 그대로).
 * 기존 size="default" · "sm" 의 클래스와 data-size 는 그대로(회귀).
 *
 * 구현 방식(기본 클래스에 바로 / data-[size=compact]: 변형 / cn 합치기)에 매이지 않도록
 * 클래스를 “실제로 이기는 값”으로 풀어서 비교한다(변형 클래스가 같은 속성의 기본 클래스를 이김).
 */

// compact 는 아직 타입에 없다. 구현 전 · 후 모두 컴파일되도록 단언으로 넘긴다.
const COMPACT = "compact" as unknown as "sm";

/** 지금 card.tsx 기본 클래스(구현 전 값을 고정). compact 를 더해도 이 토큰들은 남아 있어야 한다. */
const BASE_TOKENS = [
  "group/card",
  "flex",
  "min-w-0",
  "flex-col",
  "gap-(--card-spacing)",
  "rounded-xl",
  "border",
  "bg-card",
  "py-(--card-spacing)",
  "text-sm",
  "text-card-foreground",
  "shadow-xs",
  "[--card-spacing:--spacing(4)]",
  "has-[>img:first-child]:pt-0",
  "data-[size=sm]:[--card-spacing:--spacing(3)]",
  "*:[img:first-child]:rounded-t-xl",
  "*:[img:last-child]:rounded-b-xl",
];

function cardEl(ui: React.ReactElement) {
  const { container } = render(ui);
  return container.querySelector<HTMLElement>('[data-slot="card"]')!;
}

function tokens(el: Element) {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

/** 간격 · 여백에 관계된 속성 키. 못 읽는 토큰은 null. */
function spacingKey(token: string): string | null {
  if (/^\[--card-spacing:/.test(token)) return "--card-spacing";
  const m = token.match(/^(gap|px|py|pt|pb|pl|pr|p|space-y|space-x)-/);
  return m ? m[1] : null;
}

/** 카드가 `size` 일 때 실제로 이기는 간격 · 여백 값(속성 → 토큰). 같은 속성은 data-[size=…]: 변형이 기본을 이긴다. */
function resolvedSpacing(el: Element, size: string): Record<string, string> {
  const plain: Record<string, string> = {};
  const variant: Record<string, string> = {};
  for (const t of tokens(el)) {
    const v = t.match(/^data-\[size=([a-z]+)\]:(.+)$/);
    if (v) {
      if (v[1] !== size) continue;
      const key = spacingKey(v[2]);
      if (key) variant[key] = v[2];
    } else {
      const key = spacingKey(t);
      if (key) plain[key] = t;
    }
  }
  return { ...plain, ...variant };
}

describe("Card size=compact (새 요구 — 구현 전에는 실패해야 정상)", () => {
  it("① data-size=\"compact\" 가 붙는다", () => {
    const card = cardEl(<Card size={COMPACT} />);
    expect(card).toHaveAttribute("data-size", "compact");
  });

  it("① 자식 간격 0 · 가로 여백 px-5 가 이긴다", () => {
    const card = cardEl(<Card size={COMPACT} />);
    const r = resolvedSpacing(card, "compact");
    expect(r.gap).toBe("gap-0");
    expect(r.px).toBe("px-5");
  });

  it("① 세로 여백은 지금과 같다(py-(--card-spacing), 간격 변수 4 유지)", () => {
    const card = cardEl(<Card size={COMPACT} />);
    const r = resolvedSpacing(card, "compact");
    expect(r.py).toBe("py-(--card-spacing)");
    expect(r["--card-spacing"]).toBe("[--card-spacing:--spacing(4)]");
    expect(r.pt).toBeUndefined();
    expect(r.pb).toBeUndefined();
  });

  it("① 기존 기본 클래스는 하나도 빠지지 않는다", () => {
    const card = cardEl(<Card size={COMPACT} />);
    for (const t of BASE_TOKENS) expect(tokens(card)).toContain(t);
  });

  it("① 쓰는 쪽 className 이 compact 를 덮어쓸 수 있다(바깥 여백 · 색 등은 그대로 붙는다)", () => {
    const card = cardEl(<Card size={COMPACT} className="border-primary-line tab:col-span-2" />);
    expect(tokens(card)).toEqual(expect.arrayContaining(["border-primary-line", "tab:col-span-2"]));
    expect(card).toHaveAttribute("data-size", "compact");
  });

  it("③ compact 카드의 머리 · 본문 가로 여백 계산이 gap-0 px-5 카드와 같다", () => {
    const compact = cardEl(
      <Card size={COMPACT}>
        <CardHeader>
          <CardTitle>제목</CardTitle>
        </CardHeader>
        <CardContent>본문</CardContent>
      </Card>,
    );
    const compactHeader = compact.querySelector('[data-slot="card-header"]')!;
    const compactContent = compact.querySelector('[data-slot="card-content"]')!;
    document.body.innerHTML = "";

    const ref = cardEl(
      <Card className="gap-0 px-5">
        <CardHeader>
          <CardTitle>제목</CardTitle>
        </CardHeader>
        <CardContent>본문</CardContent>
      </Card>,
    );
    const refHeader = ref.querySelector('[data-slot="card-header"]')!;
    const refContent = ref.querySelector('[data-slot="card-content"]')!;

    // 카드 자신: 간격 · 여백이 같다 (참조 카드는 size=default 기준)
    expect(resolvedSpacing(compact, "compact")).toEqual(resolvedSpacing(ref, "default"));
    // 자식은 카드 여백 변수만 따라가므로 클래스가 그대로여야 한다(px-(--card-spacing))
    expect(tokens(compactHeader)).toContain("px-(--card-spacing)");
    expect(tokens(compactContent)).toContain("px-(--card-spacing)");
    expect(tokens(compactHeader)).toEqual(tokens(refHeader));
    expect(tokens(compactContent)).toEqual(tokens(refContent));
  });
});

describe("Card default · sm 회귀 (지금 통과해야 정상)", () => {
  it("② 기본: data-size=default · 기본 클래스 그대로 · 간격 변수 4", () => {
    const card = cardEl(<Card />);
    expect(card).toHaveAttribute("data-size", "default");
    for (const t of BASE_TOKENS) expect(tokens(card)).toContain(t);
    const r = resolvedSpacing(card, "default");
    expect(r.gap).toBe("gap-(--card-spacing)");
    expect(r.py).toBe("py-(--card-spacing)");
    expect(r["--card-spacing"]).toBe("[--card-spacing:--spacing(4)]");
    expect(r.px).toBeUndefined();
  });

  it("② sm: data-size=sm · 기본 클래스 그대로 · 간격 변수 3", () => {
    const card = cardEl(<Card size="sm" />);
    expect(card).toHaveAttribute("data-size", "sm");
    for (const t of BASE_TOKENS) expect(tokens(card)).toContain(t);
    const r = resolvedSpacing(card, "sm");
    expect(r.gap).toBe("gap-(--card-spacing)");
    expect(r.py).toBe("py-(--card-spacing)");
    expect(r["--card-spacing"]).toBe("data-[size=sm]:[--card-spacing:--spacing(3)]".replace(/^data-\[size=sm\]:/, ""));
    expect(r.px).toBeUndefined();
  });

  it("② 크기를 안 주면 default 와 같다", () => {
    const a = cardEl(<Card />);
    const aClass = a.getAttribute("class");
    document.body.innerHTML = "";
    const b = cardEl(<Card size="default" />);
    expect(b.getAttribute("class")).toBe(aClass);
  });

  it("② 머리 · 본문 · 제목 클래스는 그대로(가로 여백 변수 · sm 제목 글자)", () => {
    const card = cardEl(
      <Card size="sm">
        <CardHeader>
          <CardTitle>제목</CardTitle>
        </CardHeader>
        <CardContent>본문</CardContent>
      </Card>,
    );
    expect(tokens(card.querySelector('[data-slot="card-header"]')!)).toContain("px-(--card-spacing)");
    expect(tokens(card.querySelector('[data-slot="card-content"]')!)).toEqual(
      expect.arrayContaining(["flex", "flex-col", "gap-3", "px-(--card-spacing)"]),
    );
    expect(tokens(card.querySelector('[data-slot="card-title"]')!)).toContain("group-data-[size=sm]/card:text-sm");
  });

  it("② 지금 화면 방식 <Card className=\"gap-0 px-5\"> 는 여전히 gap-0 px-5 가 이긴다", () => {
    const card = cardEl(<Card className="gap-0 px-5" />);
    const r = resolvedSpacing(card, "default");
    expect(r.gap).toBe("gap-0");
    expect(r.px).toBe("px-5");
    expect(r.py).toBe("py-(--card-spacing)");
  });
});

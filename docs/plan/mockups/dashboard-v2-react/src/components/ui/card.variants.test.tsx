import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card } from "@/components/ui/card";

/**
 * SEL-62 UI7-1 보강 — Card 의 flush · metric · tone 변형.
 * 기준: 변형을 만들기 전 화면(StatCard · NowCard · Overview "이어서 하기")이 Card 에 덮어쓰던 클래스와 같은 겉모습.
 */

function cardEl(ui: React.ReactElement) {
  const { container } = render(ui);
  return container.querySelector<HTMLElement>('[data-slot="card"]')!;
}
function tokens(el: Element) {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

const TONES = ["primary", "ok", "warn", "bad"] as const;

describe("Card tone — 옛 border-X-line bg-X-soft 와 같다", () => {
  for (const t of TONES) {
    it(`tone=${t}: border-${t}-line · bg-${t}-soft 가 붙고 bg-card 는 빠진다`, () => {
      const card = cardEl(<Card tone={t} />);
      const c = tokens(card);
      expect(c).toContain(`border-${t}-line`);
      expect(c).toContain(`bg-${t}-soft`);
      expect(c).not.toContain("bg-card");
      // 기본 테두리 · 둥글기는 그대로
      expect(c).toEqual(expect.arrayContaining(["border", "rounded-xl", "shadow-xs"]));
    });
  }

  it("tone 을 안 주거나 default 면 색 클래스가 없고 bg-card 가 남는다", () => {
    for (const el of [cardEl(<Card />), cardEl(<Card tone="default" />)]) {
      const c = tokens(el);
      expect(c).toContain("bg-card");
      expect(c.filter((x) => /^(border|bg)-(primary|ok|warn|bad)-/.test(x))).toEqual([]);
    }
  });

  it("tone 끼리 서로 색 클래스를 남기지 않는다(하나만)", () => {
    for (const t of TONES) {
      const c = tokens(cardEl(<Card tone={t} />));
      const colored = c.filter((x) => /^(border|bg)-(primary|ok|warn|bad)-(line|soft)$/.test(x));
      expect(colored.sort()).toEqual([`bg-${t}-soft`, `border-${t}-line`].sort());
    }
  });
});

describe("Card size=flush — 옛 gap-0 py-0 @container/card", () => {
  it("flush: data-size · 안쪽 여백 0 · 자식 간격 0 · 컨테이너 쿼리", () => {
    const card = cardEl(<Card size="flush" />);
    const c = tokens(card);
    expect(card).toHaveAttribute("data-size", "flush");
    expect(c).toContain("data-[size=flush]:gap-0");
    expect(c).toContain("data-[size=flush]:py-0");
    expect(c).toContain("data-[size=flush]:@container/card");
    // 가로 여백은 내용이 직접 잡는다: px 변형이 없다
    expect(c.filter((x) => /^data-\[size=flush\]:px-/.test(x))).toEqual([]);
    expect(c).not.toContain("px-5");
  });

  it("실제로 이기는 값: flush = gap-0 · py-0 · px 없음 / compact = gap-0 · px-5 · py 변수", () => {
    const eff = (size: "flush" | "compact") => {
      const out: Record<string, string> = {};
      for (const t of tokens(cardEl(<Card size={size} />))) {
        const v = t.match(/^data-\[size=([a-z]+)\]:((?:gap|px|py)-.+)$/);
        const plain = t.match(/^((?:gap|px|py))-/);
        if (v && v[1] === size) out[v[2].match(/^(gap|px|py)/)![1]] = v[2];
        else if (!v && plain && !(plain[1] in out)) out[plain[1]] = t;
      }
      return out;
    };
    expect(eff("flush")).toMatchObject({ gap: "gap-0", py: "py-0" });
    expect(eff("flush").px).toBeUndefined();
    expect(eff("compact")).toMatchObject({ gap: "gap-0", px: "px-5", py: "py-(--card-spacing)" });
  });
});

describe("Card variant=metric — 옛 요약 카드 표면", () => {
  it("metric: 위쪽 그라데이션 · 다크에서는 단색", () => {
    const card = cardEl(<Card variant="metric" />);
    const c = tokens(card);
    expect(c).toEqual(
      expect.arrayContaining(["bg-linear-to-t", "from-primary/5", "to-card", "dark:bg-card", "dark:bg-none"]),
    );
  });

  it("default 에는 그라데이션이 없다", () => {
    const card = cardEl(<Card />);
    const c = tokens(card);
    expect(c.filter((x) => /linear|from-|dark:bg/.test(x))).toEqual([]);
  });

  it("StatCard 와 같은 조합(flush + metric)은 옛 클래스 묶음을 모두 갖는다", () => {
    const c = tokens(cardEl(<Card size="flush" variant="metric" />));
    expect(c).toEqual(
      expect.arrayContaining([
        "data-[size=flush]:@container/card",
        "data-[size=flush]:gap-0",
        "bg-linear-to-t",
        "from-primary/5",
        "to-card",
        "data-[size=flush]:py-0",
        "dark:bg-card",
        "dark:bg-none",
      ]),
    );
  });
});

describe("변형 섞기", () => {
  it("compact + tone (NowCard · 이어서 하기): 옛 gap-0 px-5 py-4 + 색", () => {
    for (const t of TONES) {
      const card = cardEl(<Card size="compact" tone={t} />);
      const c = tokens(card);
      expect(c).toEqual(
        expect.arrayContaining([
          "data-[size=compact]:gap-0",
          "data-[size=compact]:px-5",
          "py-(--card-spacing)",
          "[--card-spacing:--spacing(4)]",
          `border-${t}-line`,
          `bg-${t}-soft`,
        ]),
      );
      expect(c).not.toContain("bg-card");
      expect(card).toHaveAttribute("data-size", "compact");
    }
  });

  it("쓰는 쪽 className 이 tone 색을 덮어쓴다", () => {
    const c = tokens(cardEl(<Card tone="ok" className="border-bad-line bg-bad-soft" />));
    expect(c).toContain("border-bad-line");
    expect(c).toContain("bg-bad-soft");
    expect(c).not.toContain("border-ok-line");
    expect(c).not.toContain("bg-ok-soft");
  });

  it("sm / default + tone: 크기 클래스는 그대로, 색만 더해진다", () => {
    for (const size of ["default", "sm"] as const) {
      const card = cardEl(<Card size={size} tone="warn" />);
      const c = tokens(card);
      expect(card).toHaveAttribute("data-size", size);
      expect(c).toEqual(expect.arrayContaining(["gap-(--card-spacing)", "py-(--card-spacing)", "border-warn-line", "bg-warn-soft"]));
    }
  });

  it("default · sm 카드는 변형을 안 주면 flush/compact/metric/tone 때문에 바뀌지 않는다(기본 클래스 집합 동일)", () => {
    const a = tokens(cardEl(<Card />)).sort();
    const b = tokens(cardEl(<Card size="default" tone="default" variant="default" />)).sort();
    expect(b).toEqual(a);
  });

  it("metric + tone: 색 변형이 표면 변형과 함께 붙는다(둘 다 없어지지 않음)", () => {
    const c = tokens(cardEl(<Card variant="metric" tone="primary" />));
    expect(c).toContain("border-primary-line");
    expect(c).toContain("bg-primary-soft");
    expect(c).toContain("bg-linear-to-t");
  });
});

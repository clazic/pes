// SEL-112 U4b — code point ↔ JS UTF-16 위치 변환 순수 함수 (Vitest). 계약: src/test/sel112.ts 머리말 "순수 함수 — @/lib/anchor-text".
// 서버 규칙(SEL-99): 위치는 code point(유니코드 스칼라). 😀 = 1 · 👨‍👩(ZWJ 연결) = 3 · 한글 음절 = 1 · 정규화·줄바꿈 변환 없음.
import { describe, expect, it } from "vitest";
import { BODY, FAMILY, GRIN, P_REPEAT, cpAt, cpLen, cps, sliceBy } from "@/test/sel112";

interface AnchorText {
  cpLength(text: string): number;
  cpToUtf16(text: string, cp: number): number;
  utf16ToCp(text: string, index: number): number;
  sliceCp(text: string, startCp: number, endCp: number): string;
  snapUtf16Range(text: string, start: number, end: number): { start: number; end: number };
  findQuote(text: string, quote: string): { start_cp: number; end_cp: number }[];
}
const found = import.meta.glob<AnchorText>("/src/lib/anchor-text.{ts,tsx}");
const load = async (): Promise<AnchorText> => {
  const loader = Object.values(found)[0];
  if (!loader) throw new Error("src/lib/anchor-text.ts 가 없다 — 계약: src/test/sel112.ts 머리말");
  return loader();
};

const NFD_HAN = "한"; // 한(NFD) — 3 code point, 화면에는 글자 하나
const MIXED = `가나다 ${GRIN} abc ${FAMILY} 한${NFD_HAN}\r\n끝 \u{1F1F0}\u{1F1F7}`; // 한글 · 이모지 · ZWJ · 결합 · CRLF · 국기(2 cp)

describe("cpLength", () => {
  it("한글 음절 1 · 이모지 1 · ZWJ 가족 3 · 빈 글 0", async () => {
    const t = await load();
    expect(t.cpLength("한글")).toBe(2);
    expect(t.cpLength(GRIN)).toBe(1);
    expect(t.cpLength(FAMILY)).toBe(3);
    expect(t.cpLength("")).toBe(0);
    expect(t.cpLength(MIXED)).toBe(cpLen(MIXED));
  });

  it("정규화하지 않는다: NFD 한글은 3 · CRLF 는 2", async () => {
    const t = await load();
    expect(t.cpLength(NFD_HAN)).toBe(3);
    expect(t.cpLength("\r\n")).toBe(2);
    expect(t.cpLength("한".normalize("NFD"))).toBe(3);
  });
});

describe("cpToUtf16 · utf16ToCp", () => {
  it("모든 code point 경계에서 서로 되돌아온다(혼합 글)", async () => {
    const t = await load();
    const n = cpLen(MIXED);
    for (let cp = 0; cp <= n; cp++) {
      const u = t.cpToUtf16(MIXED, cp);
      expect(MIXED.slice(0, u), `cp ${cp}`).toBe(cps(MIXED).slice(0, cp).join(""));
      expect(t.utf16ToCp(MIXED, u), `cp ${cp}`).toBe(cp);
    }
  });

  it("알려진 값: 😀 뒤는 cp 1 ↔ UTF-16 2 · ZWJ 가족 뒤는 cp 3 ↔ UTF-16 5", async () => {
    const t = await load();
    expect(t.cpToUtf16(`${GRIN}가`, 1)).toBe(2);
    expect(t.utf16ToCp(`${GRIN}가`, 2)).toBe(1);
    expect(t.cpToUtf16(`${FAMILY}가`, 3)).toBe(5);
    expect(t.utf16ToCp(`${FAMILY}가`, 5)).toBe(3);
    expect(t.cpToUtf16("가나다", 2)).toBe(2);
  });

  it("범위 밖 · 정수 아님은 RangeError — 자르거나 조용히 맞추지 않는다", async () => {
    const t = await load();
    expect(() => t.cpToUtf16("가나", 3)).toThrow(RangeError);
    expect(() => t.cpToUtf16("가나", -1)).toThrow(RangeError);
    expect(() => t.cpToUtf16("가나", 1.5)).toThrow(RangeError);
    expect(() => t.utf16ToCp("가나", 3)).toThrow(RangeError);
    expect(() => t.utf16ToCp("가나", -1)).toThrow(RangeError);
    expect(() => t.cpToUtf16("", 1)).toThrow(RangeError);
    expect(t.cpToUtf16("", 0)).toBe(0);
    expect(t.utf16ToCp("", 0)).toBe(0);
  });

  it("서로게이트 쌍 한가운데 UTF-16 위치는 RangeError(code point 위치가 없다)", async () => {
    const t = await load();
    expect(() => t.utf16ToCp(`가${GRIN}`, 2)).toThrow(RangeError);
    expect(() => t.utf16ToCp(FAMILY, 1)).toThrow(RangeError);
    expect(() => t.utf16ToCp(FAMILY, 4)).toThrow(RangeError);
  });
});

describe("sliceCp", () => {
  it("code point 구간을 글로 자른다 — 이모지와 ZWJ 열을 쪼개지 않는다", async () => {
    const t = await load();
    expect(t.sliceCp(MIXED, 4, 5)).toBe(GRIN);
    expect(t.sliceCp(`a${FAMILY}b`, 1, 4)).toBe(FAMILY);
    expect(t.sliceCp(BODY, ...(Object.values(cpAt(BODY, "정책 대안은 두 가지다.")) as [number, number]))).toBe("정책 대안은 두 가지다.");
  });

  it("빈 구간은 빈 글 · 거꾸로 또는 범위 밖은 RangeError", async () => {
    const t = await load();
    expect(t.sliceCp("가나다", 1, 1)).toBe("");
    expect(() => t.sliceCp("가나다", 2, 1)).toThrow(RangeError);
    expect(() => t.sliceCp("가나다", 0, 4)).toThrow(RangeError);
  });
});

describe("snapUtf16Range — 서로게이트 쌍 한가운데에서 시작/끝난 선택", () => {
  it("끝이 쌍 한가운데면 쌍 뒤로, 시작이 쌍 한가운데면 쌍 앞으로 넓힌다", async () => {
    const t = await load();
    const s = `가${GRIN}나`; // UTF-16: 가0 [1,2]=😀 나3
    expect(t.snapUtf16Range(s, 0, 2)).toEqual({ start: 0, end: 3 });
    expect(t.snapUtf16Range(s, 2, 4)).toEqual({ start: 1, end: 4 });
    expect(t.snapUtf16Range(s, 2, 2)).toEqual({ start: 1, end: 3 });
  });

  it("이미 경계에 있으면 그대로 · ZWJ 가족 안쪽 쌍도 쌍 단위로만 넓힌다(ZWJ 는 한 code point)", async () => {
    const t = await load();
    expect(t.snapUtf16Range("가나다", 1, 2)).toEqual({ start: 1, end: 2 });
    expect(t.snapUtf16Range(FAMILY, 0, 2)).toEqual({ start: 0, end: 2 });
    expect(t.snapUtf16Range(FAMILY, 0, 1)).toEqual({ start: 0, end: 2 });
    expect(t.snapUtf16Range(FAMILY, 3, 4)).toEqual({ start: 3, end: 5 });
  });
});

describe("findQuote — 반복 인용 · 겹침 · 이모지 뒤 위치", () => {
  it("본문에서 글자 그대로 나오는 모든 자리를 code point 위치로 준다", async () => {
    const t = await load();
    const hits = t.findQuote(BODY, "같은 말이다.");
    expect(hits).toEqual([cpAt(BODY, "같은 말이다.", 0), cpAt(BODY, "같은 말이다.", 1)]);
    for (const h of hits) expect(sliceBy(BODY, h)).toBe("같은 말이다.");
    expect(P_REPEAT.startsWith("같은 말이다.")).toBe(true);
  });

  it("이모지 · ZWJ 가족 뒤의 인용도 code point 로 센다(UTF-16 위치와 다르다)", async () => {
    const t = await load();
    const [hit] = t.findQuote(BODY, "가족 문장이다.");
    expect(hit).toEqual(cpAt(BODY, "가족 문장이다."));
    expect(hit!.start_cp).toBeLessThan(BODY.indexOf("가족 문장이다."));
  });

  it("겹치는 자리도 센다: 'aa' in 'aaa' = 2곳", async () => {
    const t = await load();
    expect(t.findQuote("aaa", "aa")).toEqual([
      { start_cp: 0, end_cp: 2 },
      { start_cp: 1, end_cp: 3 },
    ]);
  });

  it("없으면 [] · 빈 인용문도 [] (모든 자리로 보지 않는다) · 표 칸 글(파이프 사이)도 찾는다", async () => {
    const t = await load();
    expect(t.findQuote(BODY, "없는 인용")).toEqual([]);
    expect(t.findQuote(BODY, "")).toEqual([]);
    expect(t.findQuote(BODY, `${GRIN}2`)).toEqual([cpAt(BODY, `${GRIN}2`)]);
  });
});

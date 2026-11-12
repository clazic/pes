/**
 * 첨언 위치 계산(U4b · SEL-112) — 서버(SEL-99)와 같은 단위: code point(유니코드 스칼라).
 * 한글 음절 1 · 😀 1 · 👨‍👩(ZWJ 연결) 3. 정규화·줄바꿈 변환은 하지 않는다(NFD 한글 3 · CRLF 2).
 * JS 문자열 위치(UTF-16)와 서로 바꾸는 일만 한다 — 범위 밖 · 정수 아님 · 서로게이트 쌍 한가운데는 RangeError(조용히 맞추지 않는다).
 */

export interface CpRange {
  start_cp: number;
  end_cp: number;
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** text 의 code point 수 */
export function cpLength(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (isHigh(text.charCodeAt(i)) && i + 1 < text.length && isLow(text.charCodeAt(i + 1))) i++;
    n++;
  }
  return n;
}

/** code point 위치 cp(0 ≤ cp ≤ cpLength) → UTF-16 위치 */
export function cpToUtf16(text: string, cp: number): number {
  if (!Number.isInteger(cp) || cp < 0) throw new RangeError(`code point 위치가 올바르지 않다: ${cp}`);
  let u = 0;
  for (let n = 0; n < cp; n++) {
    if (u >= text.length) throw new RangeError(`code point 위치 ${cp} 가 글(${cpLength(text)})보다 뒤다`);
    u += isHigh(text.charCodeAt(u)) && u + 1 < text.length && isLow(text.charCodeAt(u + 1)) ? 2 : 1;
  }
  return u;
}

/** UTF-16 위치 → code point 위치. 서로게이트 쌍 한가운데는 code point 위치가 없다(RangeError) */
export function utf16ToCp(text: string, index: number): number {
  if (!Number.isInteger(index) || index < 0 || index > text.length) throw new RangeError(`UTF-16 위치가 올바르지 않다: ${index}`);
  if (index > 0 && index < text.length && isHigh(text.charCodeAt(index - 1)) && isLow(text.charCodeAt(index))) throw new RangeError(`UTF-16 위치 ${index} 는 서로게이트 쌍 한가운데다`);
  return cpLength(text.slice(0, index));
}

/** code point 구간 [startCp, endCp) 의 글. 거꾸로 · 범위 밖은 RangeError */
export function sliceCp(text: string, startCp: number, endCp: number): string {
  if (endCp < startCp) throw new RangeError(`구간이 거꾸로다: ${startCp}..${endCp}`);
  const s = cpToUtf16(text, startCp);
  const e = cpToUtf16(text, endCp);
  return text.slice(s, e);
}

/**
 * 서로게이트 쌍 한가운데에서 시작/끝난 DOM 위치를 쌍 바깥으로 넓힌다 — 서버는 외톨이 서로게이트를 거절한다.
 * 시작이 쌍 한가운데면 쌍 앞으로, 끝이 쌍 한가운데면 쌍 뒤로(ZWJ 는 한 code point 라 쌍 단위로만 넓힌다).
 */
export function snapUtf16Range(text: string, start: number, end: number): { start: number; end: number } {
  const mid = (i: number) => i > 0 && i < text.length && isHigh(text.charCodeAt(i - 1)) && isLow(text.charCodeAt(i));
  return { start: mid(start) ? start - 1 : start, end: mid(end) ? end + 1 : end };
}

/** quote 가 글자 그대로 나오는 모든 자리(겹쳐도 센다) — code point 위치. 빈 인용문은 [] */
export function findQuote(text: string, quote: string): CpRange[] {
  if (!quote) return [];
  const hits: CpRange[] = [];
  const len = cpLength(quote);
  let from = 0;
  let cpBefore = 0; // text.slice(0, from) 의 code point 수
  for (;;) {
    const at = text.indexOf(quote, from);
    if (at < 0) break;
    // 서로게이트 쌍 한가운데에서 시작한 일치는 글자 그대로의 자리가 아니다 — 그 쌍 하나를 건너뛴다
    if (at > 0 && isHigh(text.charCodeAt(at - 1)) && isLow(text.charCodeAt(at))) {
      cpBefore += cpLength(text.slice(from, at + 1));
      from = at + 1;
      continue;
    }
    const start = cpBefore + cpLength(text.slice(from, at));
    hits.push({ start_cp: start, end_cp: start + len });
    // 다음 탐색은 한 code point 뒤(겹침 허용)
    const step = isHigh(text.charCodeAt(at)) && at + 1 < text.length && isLow(text.charCodeAt(at + 1)) ? 2 : 1;
    cpBefore += cpLength(text.slice(from, at)) + 1;
    from = at + step;
  }
  return hits;
}

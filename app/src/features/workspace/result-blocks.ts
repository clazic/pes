import { cpLength, cpToUtf16 } from "@/lib/anchor-text";

/**
 * 결과 글 본문(body_md)을 블록(문단 · 표 칸)으로 나눈다(U4b · SEL-112).
 * 블록마다 start_cp = 그 블록 글이 body_md 에서 시작하는 code point 위치 — 블록 글은 body_md 의 [start_cp, start_cp+길이) 와 글자 그대로 같다
 * (표 칸은 앞뒤 공백을 뺀 글). 파이프 · 구분줄은 그리지 않는다. 마크다운 꾸밈은 해석하지 않는다(글자 그대로 보여야 위치가 맞는다).
 */
export interface TextBlock {
  kind: "p";
  start_cp: number;
  text: string;
}
export interface CellBlock {
  start_cp: number;
  text: string;
  header: boolean;
}
export interface TableBlock {
  kind: "table";
  rows: CellBlock[][];
}
export type Block = TextBlock | TableBlock;

const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

interface Line {
  /** UTF-16 위치 */
  at: number;
  text: string;
}

function linesOf(body: string): Line[] {
  const out: Line[] = [];
  let at = 0;
  for (const text of body.split("\n")) {
    out.push({ at, text });
    at += text.length + 1;
  }
  return out;
}

/** 줄 끝의 \r 을 뺀 길이(CRLF 의 \r 은 블록 글이 아니다) */
const contentEnd = (l: Line): number => (l.text.endsWith("\r") ? l.text.length - 1 : l.text.length);

export function parseBody(body: string): Block[] {
  // cp[i] = body.slice(0, i) 의 code point 수(i 가 서로게이트 쌍 한가운데가 아닐 때)
  const cp = new Uint32Array(body.length + 1);
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    const pairTail = c >= 0xdc00 && c <= 0xdfff && i > 0 && body.charCodeAt(i - 1) >= 0xd800 && body.charCodeAt(i - 1) <= 0xdbff;
    cp[i + 1] = cp[i]! + (pairTail ? 0 : 1);
  }
  const lines = linesOf(body);
  const blocks: Block[] = [];
  const blank = (l: Line) => l.text.trim() === "";
  const isRow = (l: Line) => l.text.trimStart().startsWith("|");

  let i = 0;
  while (i < lines.length) {
    const first = lines[i]!;
    if (blank(first)) {
      i++;
      continue;
    }
    // 표: '|' 로 시작하는 줄 + 바로 다음 줄이 구분줄
    if (isRow(first) && i + 1 < lines.length && SEPARATOR.test(lines[i + 1]!.text) && lines[i + 1]!.text.includes("-")) {
      const rows: CellBlock[][] = [];
      let j = i;
      while (j < lines.length && isRow(lines[j]!)) {
        const line = lines[j]!;
        if (j !== i + 1) rows.push(cellsOf(line, j === i, cp));
        j++;
      }
      blocks.push({ kind: "table", rows });
      i = j;
      continue;
    }
    // 문단: 빈 줄이 나올 때까지(줄바꿈은 글에 그대로 둔다)
    let j = i;
    while (j < lines.length && !blank(lines[j]!)) j++;
    const last = lines[j - 1]!;
    const from = first.at;
    const to = last.at + contentEnd(last);
    blocks.push({ kind: "p", start_cp: cp[from]!, text: body.slice(from, to) });
    i = j;
  }
  return blocks;
}

/** 표 한 줄 → 칸들(앞뒤 공백을 뺀 글과 그 시작 위치). `\|` 는 칸을 나누지 않는다 */
function cellsOf(line: Line, header: boolean, cp: Uint32Array): CellBlock[] {
  const text = line.text.slice(0, contentEnd(line));
  const pipes: number[] = [];
  for (let k = 0; k < text.length; k++) if (text[k] === "|" && text[k - 1] !== "\\") pipes.push(k);
  const bounds: [number, number][] = [];
  for (let p = 0; p < pipes.length - 1; p++) bounds.push([pipes[p]! + 1, pipes[p + 1]!]);
  // 끝 파이프가 없는 줄: 마지막 파이프 뒤 글도 칸이다
  const tail = pipes.length ? pipes[pipes.length - 1]! + 1 : 0;
  if (tail < text.length && text.slice(tail).trim() !== "") bounds.push([tail, text.length]);
  return bounds.map(([a, b]) => {
    let s = a;
    let e = b;
    while (s < e && /\s/.test(text[s]!)) s++;
    while (e > s && /\s/.test(text[e - 1]!)) e--;
    return { start_cp: cp[line.at + s]!, text: text.slice(s, e), header };
  });
}

/** 글 위의 표시 하나(첨언 스레드) */
export interface MarkSpec {
  thread_id: string;
  start_cp: number;
  end_cp: number;
  state: "open" | "resolved" | "archived";
  status: "exact" | "moved";
}

export interface Segment {
  text: string;
  /** 이 조각을 덮는 표시들의 스레드 id(없으면 표시 없음) */
  threads: MarkSpec[];
}

/**
 * 블록 글을 표시 경계에서 조각낸다. 블록 밖으로 나가는 표시는 그리지 않는다(여러 블록에 걸친 앵커를 한 블록에 우겨 칠하지 않는다 — 목록에는 그대로 있다).
 */
export function segmentsOf(block: { start_cp: number; text: string }, marks: MarkSpec[]): Segment[] {
  const len = cpLength(block.text);
  const inside = marks.filter((m) => m.start_cp >= block.start_cp && m.end_cp <= block.start_cp + len && m.end_cp > m.start_cp);
  if (inside.length === 0) return [{ text: block.text, threads: [] }];
  const cuts = new Set<number>([0, block.text.length]);
  const local = inside.flatMap((m) => {
    try {
      const a = cpToUtf16(block.text, m.start_cp - block.start_cp);
      const b = cpToUtf16(block.text, m.end_cp - block.start_cp);
      cuts.add(a);
      cuts.add(b);
      return [{ m, a, b }];
    } catch {
      return [];
    }
  });
  const sorted = [...cuts].sort((x, y) => x - y);
  const out: Segment[] = [];
  for (let k = 0; k + 1 < sorted.length; k++) {
    const a = sorted[k]!;
    const b = sorted[k + 1]!;
    out.push({ text: block.text.slice(a, b), threads: local.filter((x) => x.a <= a && x.b >= b).map((x) => x.m) });
  }
  return out;
}

// Text anchors for selection comments (stage 3 U4a, SEL-99): pure functions, no database.
//
// An anchor names a quoted stretch of a text version: the exact quote, the text just before it (prefix) and just after it
// (suffix), and where it stood (start_cp / end_cp). Positions are CODE POINTS of the canonical text (text_format_version 1:
// the version's body_md exactly as stored, no normalization, no line-ending change) - not UTF-16 units. An emoji is one
// code point, a ZWJ family emoji is three, a Hangul syllable is one.
//
// Judging an anchor against a version never picks a place on its own when the text cannot decide:
//   exact      the quote stands where it stood (or is the only place, at the original position)
//   moved      one place, but not the original one
//   ambiguous  several places and the context cannot tell them apart: no position, only the candidates
//   lost       the quote is not in the text any more: no position (the thread and the quote stay)

export const TEXT_FORMAT_VERSION = 1;

export type AnchorStatus = "exact" | "moved" | "ambiguous" | "lost";

export interface CpRange {
  start_cp: number;
  end_cp: number;
}

export interface AnchorFacts {
  exact_quote: string;
  prefix: string;
  suffix: string;
  /** Where the quote stood in the version the anchor was made on; null when no position was kept. */
  start_cp: number | null;
}

export interface Judgement {
  status: AnchorStatus;
  start_cp: number | null;
  end_cp: number | null;
  /** exact / moved / lost: []. ambiguous: the places the quote might be (the ones whose context fits, else all). */
  candidates: CpRange[];
}

/** Number of code points. */
export function cp_length(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/** UTF-16 index -> code point index for every index of `text` (plus the end); a well-formed text only. */
function cp_index_table(text: string): Int32Array {
  const table = new Int32Array(text.length + 1);
  let cp = 0;
  let i = 0;
  while (i < text.length) {
    const unit = text.charCodeAt(i);
    const width = unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length ? 2 : 1;
    for (let k = 0; k < width; k += 1) table[i + k] = cp;
    i += width;
    cp += 1;
  }
  table[text.length] = cp;
  return table;
}

/** The code point range [start_cp, end_cp) of a text, as a string. */
export function cp_slice(text: string, start_cp: number, end_cp: number): string {
  return Array.from(text).slice(start_cp, end_cp).join("");
}

interface Candidate extends CpRange {
  /** UTF-16 index of the start, for the context test */
  at: number;
}

/** Every place the quote stands in the text, in order (matches may overlap). The quote and the text must be well-formed. */
function find_all(text: string, quote: string): Candidate[] {
  if (quote.length === 0) return [];
  const table = cp_index_table(text);
  const length = cp_length(quote);
  const found: Candidate[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(quote, from);
    if (at < 0) break;
    const start_cp = table[at] as number;
    found.push({ at, start_cp, end_cp: start_cp + length });
    from = at + 1;
  }
  return found;
}

/** The context fits when the text right before the quote ends with the prefix and the text right after starts with the suffix (empty always fits). */
function context_fits(text: string, quote: string, candidate: Candidate, prefix: string, suffix: string): boolean {
  if (prefix.length > 0) {
    const from = candidate.at - prefix.length;
    if (from < 0 || !text.startsWith(prefix, from)) return false;
  }
  if (suffix.length > 0 && !text.startsWith(suffix, candidate.at + quote.length)) return false;
  return true;
}

function plain(range: CpRange): CpRange {
  return { start_cp: range.start_cp, end_cp: range.end_cp };
}

/**
 * Judge an anchor against the text of a version (not the one it was made on - see `judge_on_origin`).
 * - no place for the quote: lost
 * - exactly one place whose context fits: exact when it is the original position, else moved
 * - none fits and the quote stands in exactly one place: exact at the original position, else moved (the quote is unique)
 * - anything else: ambiguous with the candidates (the ones whose context fits; if none fits, all)
 */
export function judge_anchor(text: string, anchor: AnchorFacts): Judgement {
  const all = find_all(text, anchor.exact_quote);
  if (all.length === 0) return { status: "lost", start_cp: null, end_cp: null, candidates: [] };
  const fitting = all.filter((candidate) => context_fits(text, anchor.exact_quote, candidate, anchor.prefix, anchor.suffix));
  let only: Candidate | null = null;
  if (fitting.length === 1) only = fitting[0] as Candidate;
  else if (fitting.length === 0 && all.length === 1) only = all[0] as Candidate;
  if (only !== null) {
    return {
      status: anchor.start_cp !== null && only.start_cp === anchor.start_cp ? "exact" : "moved",
      start_cp: only.start_cp,
      end_cp: only.end_cp,
      candidates: [],
    };
  }
  const candidates = (fitting.length >= 2 ? fitting : all).map(plain);
  return { status: "ambiguous", start_cp: null, end_cp: null, candidates };
}

/** The judgement of the version the anchor was made on: the original place, exact, whatever the context says. */
export function judge_on_origin(anchor: { start_cp: number | null; exact_quote: string }): Judgement {
  if (anchor.start_cp === null) return { status: "lost", start_cp: null, end_cp: null, candidates: [] };
  return { status: "exact", start_cp: anchor.start_cp, end_cp: anchor.start_cp + cp_length(anchor.exact_quote), candidates: [] };
}

export type PlaceRefusal = "quote_not_found" | "ambiguous_quote" | "anchor_length_mismatch";

export type Placement = { ok: true; status: "exact" | "moved"; start_cp: number; end_cp: number } | { ok: false; reason: PlaceRefusal };

/**
 * Where a NEW anchor goes. The quote must stand in the text.
 * - with a position: the quote stands there -> exact there; it does not (the position is wrong) -> the place the context
 *   (or the quote being unique) picks is used and the status is moved; several places remain -> ambiguous_quote (the server does not choose)
 * - without a position: the one place the context (or uniqueness) picks -> exact; otherwise ambiguous_quote
 * The quote is looked for first; a position (end_cp exclusive) whose length is not the quote's length in code points is anchor_length_mismatch.
 */
export function place_anchor(text: string, input: { exact_quote: string; prefix: string; suffix: string; start_cp: number | null; end_cp: number | null }): Placement {
  const length = cp_length(input.exact_quote);
  const all = find_all(text, input.exact_quote);
  if (all.length === 0) return { ok: false, reason: "quote_not_found" };
  if (input.start_cp !== null && input.end_cp !== null && input.end_cp - input.start_cp !== length) {
    return { ok: false, reason: "anchor_length_mismatch" };
  }
  if (input.start_cp !== null && all.some((candidate) => candidate.start_cp === input.start_cp)) {
    return { ok: true, status: "exact", start_cp: input.start_cp, end_cp: input.start_cp + length };
  }
  const fitting = all.filter((candidate) => context_fits(text, input.exact_quote, candidate, input.prefix, input.suffix));
  let only: Candidate | null = null;
  if (fitting.length === 1) only = fitting[0] as Candidate;
  else if (fitting.length === 0 && all.length === 1) only = all[0] as Candidate;
  if (only === null) return { ok: false, reason: "ambiguous_quote" };
  return { ok: true, status: input.start_cp === null ? "exact" : "moved", start_cp: only.start_cp, end_cp: only.end_cp };
}

// Pull plain text and tables out of a stored file (SEL-116 MAT1b). Pure functions: bytes in, text + facts out.
// No database, no disk, no network, no new dependency — only node:zlib and the hand-written zip / XML readers below.
//
// What it reads:
//   txt md csv                 UTF-8 only (BOM removed, CRLF / CR -> LF). Other encodings fail; nothing is guessed.
//   docx xlsx pptx hwpx        zip + XML. Paragraphs are one line each; tables are Markdown pipe tables.
//   hwp doc xls ppt pdf, other unsupported: this machine has no trustworthy pure-Node reader, so the answer is
//                              "unsupported" and NO text is made up.
//
// Safety of the zip reader (a file from outside is hostile until read):
//   - nothing is ever written to disk, so an entry name like "../x" cannot escape a folder; such names, absolute
//     names, backslashes, NULs, duplicate names and encrypted entries make the whole container invalid anyway;
//   - nested zip files inside the container are never opened (only exact, known part names are read);
//   - the total of unpacked bytes over ALL parts is capped (MAX_UNPACKED_BYTES). Each inflate is stopped by the
//     remaining budget (maxOutputLength), so the size written in the zip header is never trusted;
//   - the source is capped (MAX_SOURCE_BYTES) by the caller before the bytes are read; the entry count, the
//     central directory span and the XML nesting depth are capped too;
//   - the budget is spent by the bytes that really came out of inflate (never by the size a header claims), and a part
//     whose header lies, whose stream is broken or whose CRC fails makes the WHOLE container invalid;
//   - the OUTPUT is capped too (MAX_TEXT_CHARS, counted while the text is built, not at the end): a sparse sheet, a shared
//     string used by thousands of cells or nested tables cannot multiply a tiny file into gigabytes of text.
//
// ONE budget per extraction (class Budget). Every step pays BEFORE it copies, unpacks, joins or keeps something:
//   unpacked bytes (MAX_UNPACKED_BYTES), output characters (MAX_TEXT_CHARS), kept elements — cells, rows, paragraphs,
//   text pieces, sheets, relationships, shared strings (MAX_ITEMS) — and time (MAX_EXTRACT_MS, checked while XML is read).
//   Going over any of them stops the extraction right there as failed/too_large; no partial text is handed back.
//   Sheets (MAX_SHEETS) and warnings (MAX_WARNINGS, then one "n more" line) have their own small caps.
//
// Second wall: the server does not call extract_text on its own thread. file_extract_isolated.ts runs it in a worker thread with a
// heap limit and a wall-time limit, so whatever this budget misses ends that thread (failed/too_large, failed/extract_timeout), not the
// server. This file stays pure and synchronous (tests and the thread call it directly).

import { crc32, inflateRawSync } from "node:zlib";
import { posix } from "node:path";

export const EXTRACTOR = "pes-builtin";
export const EXTRACTOR_VERSION = "1";

/**
 * Failed reasons that say something about this moment, not about the file: the time limit (a slow or busy computer), an unexpected
 * error, a thread that earlier timed out and has not ended yet (extract_busy), a computer that does not allow worker threads
 * (worker_unavailable). Such an attempt is recorded (row, receipt, event) but never answers a later request for the same file —
 * the file is tried again. too_large and the damaged-file reasons are about the file and stay final.
 */
export const TRANSIENT_REASONS: readonly string[] = ["extract_timeout", "extract_error", "extract_busy", "worker_unavailable"];
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
/** The most characters one extraction may produce (counted while it is built, not at the end). Same scale as the source limit. */
export const MAX_TEXT_CHARS = 32 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_XML_DEPTH = 512;
const MAX_COLUMN = 16_384;
/** One tag: the attribute text, the number of attributes and a name stay small in any real document. */
const MAX_ATTR_TEXT = 64 * 1024;
const MAX_ATTRS = 256;
const MAX_NAME = 1024;
/** Tables inside table cells (a real document nests a few levels), and the cells a workbook may hold in all. */
const MAX_TABLE_DEPTH = 16;
/** Elements one extraction may keep in memory (cells, rows, paragraphs, text pieces, sheets, ...). A real 32 MiB workbook stays well below. */
export const MAX_ITEMS = 3_000_000;
/** Sheets one workbook may list. */
export const MAX_SHEETS = 1_000;
/** Warnings kept as they are; the rest become one "n more" line. */
export const MAX_WARNINGS = 50;
/** Wall time one extraction may take (it runs inside a write transaction). */
export const MAX_EXTRACT_MS = 10_000;
/** How many XML events go by between two looks at the clock. */
const TICK_EVERY = 4096;

export type ExtractStatus = "extracted" | "partial" | "unsupported" | "failed";

export interface ExtractWarning {
  code: string;
  message: string;
}

export interface ExtractOutcome {
  status: ExtractStatus;
  /** the machine word for why it is not a clean "extracted" (the first warning code), or null */
  reason: string | null;
  /** the extracted text (LF, no BOM); null when there is none (unsupported, failed) */
  text: string | null;
  page_count: number | null;
  table_count: number;
  warnings: ExtractWarning[];
}

export type SourceFormat = "txt" | "md" | "csv" | "docx" | "xlsx" | "pptx" | "hwpx" | "hwp" | "doc" | "xls" | "ppt" | "pdf" | "unknown";

const KNOWN_FORMATS: ReadonlySet<string> = new Set(["txt", "md", "csv", "docx", "xlsx", "pptx", "hwpx", "hwp", "doc", "xls", "ppt", "pdf"]);

/**
 * Formats extract_text really parses (the cases of its switch). Every other format answers "unsupported" without reading a byte.
 * file_extract_isolated.ts uses this one list to decide which files need a worker thread — a format added to the switch of
 * extract_text must be added here, or it would run inline in the server thread (tests/test_sel116_isolation.test.ts checks it).
 */
export const PARSED_FORMATS: ReadonlySet<string> = new Set(["txt", "md", "csv", "docx", "xlsx", "pptx", "hwpx"]);

/** The format is the lower-case extension of the original file name; anything else is "unknown". */
export function format_of(original_name: string | null): SourceFormat {
  const name = original_name ?? "";
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "unknown";
  const ext = name.slice(dot + 1).toLowerCase();
  return KNOWN_FORMATS.has(ext) ? (ext as SourceFormat) : "unknown";
}

function extension_of(original_name: string | null): string {
  const name = original_name ?? "";
  const dot = name.lastIndexOf(".");
  return dot < 0 || dot === name.length - 1 ? "" : name.slice(dot + 1).toLowerCase();
}

// ---------------------------------------------------------------------------
// outcomes

function failed(code: string, message: string): ExtractOutcome {
  return { status: "failed", reason: code, text: null, page_count: null, table_count: 0, warnings: [{ code, message }] };
}

class ExtractFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// zip

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
}

/**
 * The one budget of an extraction. Each step pays here BEFORE it builds: `unpack` before a part is kept, `charge` before
 * output characters are copied or joined, `item` before an element is kept, `tick` while XML is read. Going over stops
 * the whole extraction (failed/too_large).
 */
class Budget {
  /** unpacked bytes still allowed */
  remaining: number;
  private chars = 0;
  private items = 0;
  private readonly deadline: number;
  constructor(unpacked: number, ms: number = MAX_EXTRACT_MS) {
    this.remaining = unpacked;
    this.deadline = performance.now() + ms;
  }
  /** output characters about to be built */
  charge(n: number): void {
    this.chars += n;
    if (this.chars > MAX_TEXT_CHARS) throw text_too_large();
  }
  /** elements about to be kept */
  item(n = 1): void {
    this.items += n;
    if (this.items > MAX_ITEMS) throw new ExtractFailure("too_large", "문서 안의 칸·행·문단 같은 요소가 너무 많아 멈췄습니다. 일부만 돌려주거나 글자를 지어내지 않았습니다.");
  }
  tick(): void {
    if (performance.now() > this.deadline) throw new ExtractFailure("too_large", "글자를 뽑는 데 시간 상한을 넘어 멈췄습니다. 일부만 돌려주거나 글자를 지어내지 않았습니다.");
  }
}

function container_error(message: string): ExtractFailure {
  return new ExtractFailure("invalid_container", message);
}

function too_large(): ExtractFailure {
  return new ExtractFailure("too_large", "파일이 너무 커서 글자를 뽑지 않았습니다(펼친 크기가 상한을 넘었습니다).");
}

function text_too_large(): ExtractFailure {
  return new ExtractFailure("too_large", "추출한 글자가 상한을 넘어 멈췄습니다. 일부만 돌려주거나 글자를 지어내지 않았습니다.");
}

function unsafe_name(name: string): boolean {
  if (name.length === 0 || name.includes("\0") || name.includes("\\")) return true;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return true;
  return name.split("/").some((segment) => segment === "..");
}

class ZipArchive {
  private readonly bytes: Buffer;
  private readonly entries = new Map<string, ZipEntry>();
  readonly budget: Budget;

  constructor(input: Uint8Array, budget: Budget) {
    this.bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    this.budget = budget;
    this.index();
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  private index(): void {
    const buf = this.bytes;
    if (buf.length < 22) throw container_error("zip 파일이 아니거나 중간에서 잘렸습니다.");
    let eocd = -1;
    const lowest = Math.max(0, buf.length - 22 - 0xffff);
    for (let at = buf.length - 22; at >= lowest; at -= 1) {
      if (buf.readUInt32LE(at) === 0x06054b50) {
        eocd = at;
        break;
      }
    }
    if (eocd < 0) throw container_error("zip 파일이 아니거나 중간에서 잘렸습니다.");
    const total = buf.readUInt16LE(eocd + 10);
    const cd_size = buf.readUInt32LE(eocd + 12);
    const cd_offset = buf.readUInt32LE(eocd + 16);
    if (total === 0xffff || cd_size === 0xffffffff || cd_offset === 0xffffffff) throw container_error("지원하지 않는 zip 형식(zip64)입니다.");
    if (total > MAX_ENTRIES) throw too_large();
    if (cd_offset + cd_size > eocd) throw container_error("zip 목록이 손상되었습니다.");

    let at = cd_offset;
    for (let index = 0; index < total; index += 1) {
      if (at + 46 > cd_offset + cd_size || buf.readUInt32LE(at) !== 0x02014b50) throw container_error("zip 목록이 손상되었습니다.");
      const flags = buf.readUInt16LE(at + 8);
      const method = buf.readUInt16LE(at + 10);
      const crc = buf.readUInt32LE(at + 16);
      const csize = buf.readUInt32LE(at + 20);
      const usize = buf.readUInt32LE(at + 24);
      const name_length = buf.readUInt16LE(at + 28);
      const extra_length = buf.readUInt16LE(at + 30);
      const comment_length = buf.readUInt16LE(at + 32);
      const offset = buf.readUInt32LE(at + 42);
      if (at + 46 + name_length > cd_offset + cd_size) throw container_error("zip 목록이 손상되었습니다.");
      const name = buf.toString("utf8", at + 46, at + 46 + name_length);
      at += 46 + name_length + extra_length + comment_length;
      if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) throw container_error("지원하지 않는 zip 형식(zip64)입니다.");
      if ((flags & 1) !== 0) throw container_error("암호가 걸린 파일입니다.");
      if (unsafe_name(name)) throw container_error("zip 안의 파일 이름이 안전하지 않습니다.");
      if (this.entries.has(name)) throw container_error("zip 안에 같은 이름이 두 번 들어 있습니다.");
      // The local header must agree with the list, and the packed bytes must lie before the list.
      if (offset + 30 > cd_offset || buf.readUInt32LE(offset) !== 0x04034b50) throw container_error("zip 내용이 손상되었습니다.");
      const local_name_length = buf.readUInt16LE(offset + 26);
      const local_extra_length = buf.readUInt16LE(offset + 28);
      const local_name = buf.toString("utf8", offset + 30, offset + 30 + local_name_length);
      if (local_name !== name) throw container_error("zip 내용이 손상되었습니다.");
      if (offset + 30 + local_name_length + local_extra_length + csize > cd_offset) throw container_error("zip 내용이 손상되었습니다.");
      this.entries.set(name, { name, flags, method, crc, csize, usize, offset });
    }
  }

  /**
   * The unpacked bytes of one part. The budget is spent by what inflate really produced, before any check on the header
   * (a part that lies about its size cannot be unpacked for free), and inflate stops as soon as it passes the size the
   * header claims. A header that lies, a broken stream or a bad CRC means the zip cannot be trusted: the whole container fails.
   */
  read(name: string): Buffer {
    const entry = this.entries.get(name);
    if (entry === undefined) throw container_error(`부품 ${name} 이(가) 없습니다.`);
    if (entry.usize > this.budget.remaining) throw too_large();
    const start = entry.offset + 30 + this.bytes.readUInt16LE(entry.offset + 26) + this.bytes.readUInt16LE(entry.offset + 28);
    const packed = this.bytes.subarray(start, start + entry.csize);
    let out: Buffer;
    if (entry.method === 0) {
      if (entry.csize !== entry.usize) throw container_error(`부품 ${name} 이(가) 손상되었습니다.`);
      out = Buffer.from(packed);
    } else if (entry.method === 8) {
      try {
        out = inflateRawSync(packed, { maxOutputLength: Math.max(1, Math.min(this.budget.remaining, entry.usize)) });
      } catch {
        // past the claimed size (or past the budget, which the claimed size already fits in) or not a deflate stream at all
        throw container_error(`부품 ${name} 이(가) 손상되었습니다.`);
      }
    } else {
      throw container_error(`부품 ${name} 의 압축 방식을 지원하지 않습니다.`);
    }
    this.budget.remaining -= out.length;
    if (this.budget.remaining < 0) throw too_large();
    if (out.length !== entry.usize) throw container_error(`부품 ${name} 이(가) 손상되었습니다.`);
    if (crc32(out) !== entry.crc) throw container_error(`부품 ${name} 이(가) 손상되었습니다.`);
    return out;
  }
}

// ---------------------------------------------------------------------------
// XML (events; local names; well-formedness is checked, nothing is expanded beyond the five entities and numbers)

type XmlEvent =
  | { k: "open"; name: string; attrs: Record<string, string>; self: boolean }
  | { k: "close"; name: string }
  /** `literal`: CDATA, taken as written (no entity decoding). It is never re-escaped to be decoded again — that copy cost up to 5x before any budget saw it. */
  | { k: "text"; text: string; literal?: boolean };

class XmlError extends Error {}

/**
 * name="value" pairs, read one character at a time (no regular expression: a name of 200,000 letters without "=" made the
 * old pattern quadratic). Every character of the text must belong to a pair; sizes are capped.
 */
function read_attrs(text: string): Record<string, string> {
  if (text.length > MAX_ATTR_TEXT) throw new XmlError("attributes too long");
  const attrs: Record<string, string> = {};
  let count = 0;
  let at = 0;
  const skip_space = (): void => {
    while (at < text.length && /\s/.test(text[at] as string)) at += 1;
  };
  for (;;) {
    skip_space();
    if (at >= text.length) return attrs;
    const name_start = at;
    while (at < text.length) {
      const ch = text[at] as string;
      if (ch === "=" || ch === "/" || ch === ">" || /\s/.test(ch)) break;
      at += 1;
    }
    if (at === name_start || at - name_start > MAX_NAME) throw new XmlError("bad attribute");
    const name = text.slice(name_start, at);
    skip_space();
    if (text[at] !== "=") throw new XmlError("bad attribute");
    at += 1;
    skip_space();
    const quote = text[at];
    if (quote !== '"' && quote !== "'") throw new XmlError("bad attribute");
    const close = text.indexOf(quote, at + 1);
    if (close < 0) throw new XmlError("bad attribute");
    count += 1;
    if (count > MAX_ATTRS) throw new XmlError("too many attributes");
    attrs[name] = xml_decode(text.slice(at + 1, close));
    at = close + 1;
  }
}

/** The index of the ">" that ends the tag starting at `lt`, skipping ">" inside quoted attribute values; -1 when unterminated. */
function tag_end(src: string, lt: number): number {
  let quote = "";
  for (let i = lt + 1; i < src.length; i += 1) {
    const ch = src[i] as string;
    if (quote !== "") {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    } else if (ch === "<") {
      return -1;
    }
  }
  return -1;
}

function local_name(raw: string): string {
  const colon = raw.indexOf(":");
  return colon < 0 ? raw : raw.slice(colon + 1);
}

/** The character a numeric reference names, or null when it must stay as written (out of range, a surrogate, a control character). */
function char_ref(digits: string, hex: boolean): string | null {
  const code = hex ? Number.parseInt(digits, 16) : Number.parseInt(digits, 10);
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
  // XML 1.0 does not allow most control characters (a NUL made out of "&#0;" is not text)
  if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0xfffe || code === 0xffff) return null;
  return String.fromCodePoint(code);
}

const NAMED: ReadonlyArray<readonly [string, string]> = [["amp;", "&"], ["lt;", "<"], ["gt;", ">"], ["quot;", '"'], ["apos;", "'"]];

function is_digit(code: number, hex: boolean): boolean {
  return (code >= 48 && code <= 57) || (hex && ((code >= 65 && code <= 70) || (code >= 97 && code <= 102)));
}

/**
 * The five named entities and numeric references, decoded by jumping from "&" to "&" (no callback per match: millions of
 * entities in a few kilobytes of zip once cost gigabytes). Pieces are joined in small groups, so memory stays near the size
 * of the result. Anything that is not one of these references stays exactly as written.
 */
export function xml_decode(text: string): string {
  let amp = text.indexOf("&");
  if (amp < 0) return text;
  const chunks: string[] = [];
  let pieces: string[] = [];
  let last = 0;
  const put = (piece: string): void => {
    if (piece === "") return;
    pieces.push(piece);
    if (pieces.length >= 4096) {
      chunks.push(pieces.join(""));
      pieces = [];
    }
  };
  while (amp >= 0) {
    let decoded: string | null = null;
    let after = amp + 1;
    if (text.charCodeAt(amp + 1) === 35 /* # */) {
      const hex = text.charCodeAt(amp + 2) === 120; /* x */
      const from = amp + (hex ? 3 : 2);
      let at = from;
      while (at < text.length && is_digit(text.charCodeAt(at), hex)) at += 1;
      if (at > from && text.charCodeAt(at) === 59 /* ; */) {
        decoded = char_ref(text.slice(from, at), hex);
        after = at + 1;
      }
    } else {
      for (const [name, value] of NAMED) {
        if (text.startsWith(name, amp + 1)) {
          decoded = value;
          after = amp + 1 + name.length;
          break;
        }
      }
    }
    if (decoded === null) {
      amp = text.indexOf("&", amp + 1);
      continue;
    }
    put(text.slice(last, amp));
    put(decoded);
    last = after;
    amp = text.indexOf("&", after);
  }
  put(text.slice(last));
  chunks.push(pieces.join(""));
  return chunks.length === 1 ? (chunks[0] as string) : chunks.join("");
}

/** The characters of a text event: CDATA as written, everything else with its entities decoded. */
function text_of(ev: { text: string; literal?: boolean }): string {
  return ev.literal === true ? ev.text : xml_decode(ev.text);
}

function* xml_events(src: string, budget: Budget): Generator<XmlEvent> {
  const stack: string[] = [];
  let at = 0;
  let saw_root = false;
  let steps = 0;
  while (at < src.length) {
    steps += 1;
    if (steps % TICK_EVERY === 0) budget.tick();
    const lt = src.indexOf("<", at);
    if (lt < 0) {
      if (stack.length > 0 || src.slice(at).trim() !== "") throw new XmlError("text outside the root");
      return;
    }
    if (lt > at) {
      if (stack.length > 0) yield { k: "text", text: src.slice(at, lt) };
      else if (src.slice(at, lt).trim() !== "") throw new XmlError("text outside the root");
    }
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      if (end < 0) throw new XmlError("unterminated comment");
      at = end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      if (end < 0 || stack.length === 0) throw new XmlError("bad CDATA");
      yield { k: "text", text: src.slice(lt + 9, end), literal: true };
      at = end + 3;
      continue;
    }
    if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      if (end < 0) throw new XmlError("unterminated declaration");
      at = end + 2;
      continue;
    }
    if (src.startsWith("<!", lt)) throw new XmlError("DOCTYPE is not accepted");
    if (src[lt + 1] === "/") {
      const end = src.indexOf(">", lt);
      if (end < 0) throw new XmlError("unterminated tag");
      const raw = src.slice(lt + 2, end).trim();
      const top = stack.pop();
      if (top === undefined || top !== raw) throw new XmlError("mismatched closing tag");
      yield { k: "close", name: local_name(raw) };
      at = end + 1;
      continue;
    }
    const end = tag_end(src, lt);
    if (end < 0) throw new XmlError("bad tag");
    let inner = src.slice(lt + 1, end);
    const self = inner.endsWith("/");
    if (self) inner = inner.slice(0, -1);
    const name_hit = inner.match(/^[^\s/>]+/);
    if (name_hit === null) throw new XmlError("bad tag");
    const raw = name_hit[0];
    if (raw.length > MAX_NAME) throw new XmlError("name too long");
    const attr_text = inner.slice(raw.length);
    if (stack.length === 0) {
      if (saw_root) throw new XmlError("more than one root");
      saw_root = true;
    }
    const attrs = attr_text.trim() === "" ? {} : read_attrs(attr_text);
    yield { k: "open", name: local_name(raw), attrs, self };
    if (self) {
      yield { k: "close", name: local_name(raw) };
    } else {
      stack.push(raw);
      if (stack.length > MAX_XML_DEPTH) throw new XmlError("nested too deep");
    }
    at = end + 1;
  }
  if (stack.length > 0 || !saw_root) throw new XmlError("unclosed tag");
}

function attr_of(attrs: Record<string, string>, local: string): string | undefined {
  for (const [key, value] of Object.entries(attrs)) {
    if (local_name(key) === local) return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Markdown pipe tables

/**
 * Joins small pieces in groups, so a string made of millions of pieces never holds millions of them at once. (A global
 * `replace` keeps one record per match — about 25 bytes each — and ran a 256 MB heap out of memory on 15,000,000 matches.)
 */
class PieceJoiner {
  private chunks: string[] = [];
  private pieces: string[] = [];
  put(piece: string): void {
    this.pieces.push(piece);
    if (this.pieces.length >= 4096) {
      this.chunks.push(this.pieces.join(""));
      this.pieces = [];
    }
  }
  done(): string {
    this.chunks.push(this.pieces.join(""));
    this.pieces = [];
    const out = this.chunks.length === 1 ? (this.chunks[0] as string) : this.chunks.join("");
    this.chunks = [];
    return out;
  }
}

/**
 * One table cell: every run of white space becomes one space, the ends are trimmed and "|" becomes "\|" — in one pass
 * (same result as text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|"), same state machine as cell_text_length).
 */
export function cell_text(text: string): string {
  const out = new PieceJoiner();
  let run = -1; // where the current run of ordinary characters began
  let pending_space = false;
  let wrote = false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const space = is_space(code);
    if (!space && code !== 124 /* | */) {
      if (run < 0) {
        if (pending_space) out.put(" ");
        pending_space = false;
        run = i;
        wrote = true;
      }
      continue;
    }
    if (run >= 0) {
      out.put(text.slice(run, i));
      run = -1;
    }
    if (space) {
      if (wrote) pending_space = true;
    } else {
      if (pending_space) out.put(" ");
      pending_space = false;
      out.put("\\|");
      wrote = true;
    }
  }
  if (run >= 0) out.put(text.slice(run));
  return out.done();
}

/** CRLF and a lone CR become LF (same result as replace(/\r\n?/g, "\n"), without one record per match). */
export function normalize_newlines(text: string): string {
  let at = text.indexOf("\r");
  if (at < 0) return text;
  const out = new PieceJoiner();
  let last = 0;
  while (at >= 0) {
    out.put(text.slice(last, at));
    out.put("\n");
    last = text.charCodeAt(at + 1) === 10 ? at + 2 : at + 1;
    at = text.indexOf("\r", last);
  }
  out.put(text.slice(last));
  return out.done();
}

/** The characters that /\s/ matches (ECMAScript WhiteSpace + LineTerminator), by code unit. */
function is_space(code: number): boolean {
  return (
    (code >= 9 && code <= 13) || code === 32 || code === 160 || code === 5760 || (code >= 8192 && code <= 8202) ||
    code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279
  );
}

/**
 * cell_text(parts.join(" ")).length, counted without building anything (so the budget is paid before any copy is made).
 * Parts are read as if joined with one space.
 */
function cell_text_length(parts: readonly string[]): number {
  let length = 0;
  let pending_space = false;
  parts.forEach((text, index) => {
    if (index > 0 && length > 0) pending_space = true;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (is_space(code)) {
        if (length > 0) pending_space = true;
        continue;
      }
      if (pending_space) length += 1;
      pending_space = false;
      length += code === 124 /* | */ ? 2 : 1;
    }
  });
  return length;
}

/** One table cell for the output: the budget pays for the escaped text (and its " | ") first; only then is it joined and built. */
function cell_out(parts: readonly string[], budget: Budget): string {
  const length = cell_text_length(parts);
  budget.charge(length + 3);
  if (length === 0) return "";
  return cell_text(parts.length === 1 ? (parts[0] as string) : parts.join(" "));
}

function pipe_row(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

/**
 * Cells already escaped and paid for, laid out row by row (`row_ends[r]` = index after the last cell of row r) -> pipe-table
 * lines: header row, a separator of the same width, then the rest. Every row is padded to the widest row so the table stays
 * a table; the padding and the frame of each line are paid for before the line is built.
 */
function pipe_table(cells: string[], row_ends: number[], budget: Budget): string[] {
  let width = 0;
  let begin = 0;
  for (const end of row_ends) {
    width = Math.max(width, end - begin);
    begin = end;
  }
  const lines: string[] = [];
  begin = 0;
  row_ends.forEach((end, index) => {
    budget.charge(3 * (width - (end - begin)) + 6);
    const row = cells.slice(begin, end);
    while (row.length < width) row.push("");
    lines.push(pipe_row(row));
    begin = end;
    if (index === 0) {
      budget.charge(5 * width + 6);
      lines.push(pipe_row(Array.from({ length: width }, () => "---")));
    }
  });
  return lines;
}

/**
 * One sheet, kept flat (a row object per row once cost hundreds of bytes): only the cells that hold something, as
 * (column, escaped value) pairs in reading order; row r is cells row_starts[r] .. row_starts[r + 1].
 */
interface SheetData {
  row_starts: number[];
  cols: number[];
  vals: string[];
  width: number;
  /** characters paid for when the values were read (each value and its " | "); printing the sheet again must pay them again */
  paid: number;
  /** how many times the sheet has been printed */
  printed: number;
}

/** A sheet -> the same pipe table, padded to the widest row. A row is only widened to the page width when it is printed. */
function sparse_pipe_table(sheet: SheetData, budget: Budget): string[] {
  const { row_starts, cols, vals, width } = sheet;
  // The values were paid for when they were read, for the first printing. Every further printing (several sheets that point at
  // the same part) puts them out again, so it pays for them again - before a line is built.
  if (sheet.printed > 0) budget.charge(sheet.paid);
  sheet.printed += 1;
  const lines: string[] = [];
  row_starts.forEach((begin, index) => {
    const end = index + 1 < row_starts.length ? (row_starts[index + 1] as number) : cols.length;
    // the values were paid for when they were read; here the empty columns and the frame
    budget.charge(3 * Math.max(0, width - (end - begin)) + 6);
    const dense = new Array<string>(width).fill("");
    for (let i = begin; i < end; i += 1) dense[cols[i] as number] = vals[i] as string; // a later cell wins a column
    lines.push(pipe_row(dense));
    if (index === 0) {
      budget.charge(5 * width + 6);
      lines.push(pipe_row(Array.from({ length: width }, () => "---")));
    }
  });
  return lines;
}

function push_all(into: string[], from: readonly string[]): void {
  // not into.push(...from): spreading ~120,000 arguments overflows the call stack
  for (const line of from) into.push(line);
}

// ---------------------------------------------------------------------------
// word-processing / presentation / hwpx body: p (paragraph), t (text), br, tbl / tr / tc (tables)

interface BodyResult {
  lines: string[];
  tables: number;
}

interface ParaFrame {
  text: string;
  cell: CellFrame | null;
}
interface CellFrame {
  parts: string[];
  /** the table whose open row this cell belongs to, or null (a cell outside a row is read but not kept) */
  table: TableFrame | null;
}
/** A table, kept flat: escaped cells in order, and where each row ends. */
interface TableFrame {
  cells: string[];
  row_ends: number[];
  /** index in `cells` where the open row starts, or -1 when no row is open */
  row_start: number;
  parent_cell: CellFrame | null;
}

/** Walks one body part. Throws XmlError when the XML is not well formed. */
function read_body(xml: string, budget: Budget): BodyResult {
  const lines: string[] = [];
  let tables = 0;
  const paras: ParaFrame[] = [];
  const cells: CellFrame[] = [];
  const table_stack: TableFrame[] = [];
  let text_depth = 0;
  const append = (para: ParaFrame, piece: string): void => {
    if (piece === "") return;
    // joining onto text already there keeps one more piece alive until the paragraph ends
    if (para.text !== "") budget.item();
    para.text += piece;
  };
  for (const ev of xml_events(xml, budget)) {
    if (ev.k === "open") {
      switch (ev.name) {
        case "p":
          budget.item();
          paras.push({ text: "", cell: cells.length > 0 ? (cells[cells.length - 1] as CellFrame) : null });
          break;
        case "t":
          text_depth += 1;
          break;
        case "br":
        case "lineBreak":
          if (paras.length > 0) append(paras[paras.length - 1] as ParaFrame, "\n");
          break;
        case "tab":
          if (paras.length > 0 && text_depth === 0) append(paras[paras.length - 1] as ParaFrame, "\t");
          break;
        case "tbl":
          if (table_stack.length >= MAX_TABLE_DEPTH) throw new ExtractFailure("too_large", "표 안의 표가 너무 깊어 글자를 뽑지 않았습니다.");
          budget.item();
          tables += 1;
          table_stack.push({ cells: [], row_ends: [], row_start: -1, parent_cell: cells.length > 0 ? (cells[cells.length - 1] as CellFrame) : null });
          break;
        case "tr": {
          const table = table_stack[table_stack.length - 1];
          if (table === undefined) break;
          budget.item();
          // a row opened inside an open row starts over (the cells read so far in it are dropped)
          if (table.row_start >= 0) table.cells.length = table.row_start;
          table.row_start = table.cells.length;
          break;
        }
        case "tc": {
          budget.item();
          const table = table_stack[table_stack.length - 1];
          cells.push({ parts: [], table: table !== undefined && table.row_start >= 0 ? table : null });
          break;
        }
        default:
          break;
      }
    } else if (ev.k === "text") {
      if (text_depth > 0 && paras.length > 0) append(paras[paras.length - 1] as ParaFrame, text_of(ev));
    } else {
      switch (ev.name) {
        case "t":
          text_depth = Math.max(0, text_depth - 1);
          break;
        case "p": {
          const para = paras.pop();
          if (para === undefined) break;
          const text = para.text.trim();
          if (text === "") break;
          if (para.cell) {
            para.cell.parts.push(text);
          } else {
            budget.charge(text.length + 1);
            lines.push(text);
          }
          break;
        }
        case "tc": {
          const cell = cells.pop();
          if (cell?.table) cell.table.cells.push(cell_out(cell.parts, budget));
          break;
        }
        case "tr": {
          const table = table_stack[table_stack.length - 1];
          if (table !== undefined && table.row_start >= 0) {
            table.row_ends.push(table.cells.length);
            table.row_start = -1;
          }
          break;
        }
        case "tbl": {
          const table = table_stack.pop();
          if (table === undefined || table.row_ends.length === 0) break;
          const rendered = pipe_table(table.cells, table.row_ends, budget);
          if (table.parent_cell) {
            budget.item();
            table.parent_cell.parts.push(rendered.join(" "));
          } else push_all(lines, rendered);
          break;
        }
        default:
          break;
      }
    }
  }
  return { lines, tables };
}

function body_text(lines: string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** A zip part must be valid UTF-8: nothing is guessed (a bad byte is not turned into U+FFFD). */
function utf8(buf: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new XmlError("not valid UTF-8");
  }
}

function part_warning(name: string): ExtractWarning {
  return { code: "part_unreadable", message: `부품 ${name} 을(를) 읽지 못해 그 부분은 빠졌습니다.` };
}

/** At most MAX_WARNINGS warnings are kept as they are; the rest are counted and become one last line. */
class Warnings {
  private readonly kept: ExtractWarning[] = [];
  private more = 0;
  add(warning: ExtractWarning): void {
    if (this.kept.length < MAX_WARNINGS) this.kept.push(warning);
    else this.more += 1;
  }
  list(): ExtractWarning[] {
    if (this.more === 0) return this.kept;
    return [...this.kept, { code: "more_warnings", message: `같은 종류의 경고 ${this.more}개는 더 적지 않았습니다.` }];
  }
}

function invalid_document(message: string): ExtractFailure {
  return new ExtractFailure("invalid_document", message);
}

/** Reads a part that must exist: missing or unreadable XML -> invalid_document. */
function read_main(zip: ZipArchive, name: string, budget: Budget): BodyResult {
  if (!zip.has(name)) throw invalid_document(`본문 부품 ${name} 이(가) 없습니다.`);
  try {
    return read_body(utf8(zip.read(name)), budget);
  } catch (error) {
    if (error instanceof XmlError) throw invalid_document(`본문 부품 ${name} 을(를) 읽을 수 없습니다.`);
    throw error;
  }
}

/** Reads a numbered part list in number order; a part that cannot be read becomes a warning, and the rest stay. */
function numbered_parts(zip: ZipArchive, pattern: RegExp): Array<{ name: string; n: number }> {
  const found: Array<{ name: string; n: number }> = [];
  for (const name of zip.names()) {
    const hit = name.match(pattern);
    if (hit) found.push({ name, n: Number.parseInt(hit[1] as string, 10) });
  }
  return found.sort((a, b) => a.n - b.n || (a.name < b.name ? -1 : 1));
}

function guard_part<T>(name: string, warnings: Warnings, read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    if (error instanceof XmlError) {
      warnings.add(part_warning(name));
      return null;
    }
    // a part the list names but the package does not hold is a warning; anything wrong INSIDE the zip (a lying header,
    // a broken stream, a bad CRC, the budget) is not: the container is not trusted
    if (error instanceof ExtractFailure && error.code === "part_missing") {
      warnings.add(part_warning(name));
      return null;
    }
    throw error;
  }
}

function extract_docx(zip: ZipArchive, budget: Budget): ExtractOutcome {
  const body = read_main(zip, "word/document.xml", budget);
  return { status: "extracted", reason: null, text: body_text(body.lines), page_count: null, table_count: body.tables, warnings: [] };
}

function extract_hwpx(zip: ZipArchive, budget: Budget): ExtractOutcome {
  const sections = numbered_parts(zip, /^Contents\/section(\d{1,9})\.xml$/);
  if (sections.length === 0) throw invalid_document("본문 구역(Contents/section*.xml)이 없습니다.");
  const warnings = new Warnings();
  const lines: string[] = [];
  let tables = 0;
  let read = 0;
  for (const section of sections) {
    budget.tick();
    const body = guard_part(section.name, warnings, () => read_body(utf8(zip.read(section.name)), budget));
    if (body === null) continue;
    read += 1;
    push_all(lines, body.lines);
    tables += body.tables;
  }
  if (read === 0) throw invalid_document("읽을 수 있는 본문 구역이 없습니다.");
  return finish(lines, tables, null, warnings);
}

function extract_pptx(zip: ZipArchive, budget: Budget): ExtractOutcome {
  const slides = numbered_parts(zip, /^ppt\/slides\/slide(\d{1,9})\.xml$/);
  if (slides.length === 0) throw invalid_document("슬라이드(ppt/slides/slide*.xml)가 없습니다.");
  const warnings = new Warnings();
  const lines: string[] = [];
  let tables = 0;
  let read = 0;
  for (const slide of slides) {
    budget.tick();
    const body = guard_part(slide.name, warnings, () => read_body(utf8(zip.read(slide.name)), budget));
    if (body === null) continue;
    read += 1;
    budget.charge(24);
    lines.push(`## 슬라이드 ${slide.n}`);
    push_all(lines, body.lines);
    tables += body.tables;
  }
  if (read === 0) throw invalid_document("읽을 수 있는 슬라이드가 없습니다.");
  return finish(lines, tables, slides.length, warnings);
}

function finish(lines: string[], tables: number, pages: number | null, warnings: Warnings): ExtractOutcome {
  const list = warnings.list();
  return {
    status: list.length > 0 ? "partial" : "extracted",
    reason: list[0]?.code ?? null,
    text: body_text(lines),
    page_count: pages,
    table_count: tables,
    warnings: list,
  };
}

// ---------------------------------------------------------------------------
// xlsx

function column_index(ref: string): number | null {
  const hit = ref.match(/^([A-Za-z]+)/);
  if (!hit) return null;
  let n = 0;
  for (const ch of (hit[1] as string).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function read_shared_strings(xml: string, budget: Budget): string[] {
  const strings: string[] = [];
  let current: string | null = null;
  let in_t = false;
  let phonetic = 0;
  for (const ev of xml_events(xml, budget)) {
    if (ev.k === "open") {
      if (ev.name === "si") {
        budget.item();
        current = "";
      } else if (ev.name === "rPh") phonetic += 1;
      else if (ev.name === "t" && current !== null && phonetic === 0) in_t = true;
    } else if (ev.k === "text") {
      if (in_t && current !== null) {
        const piece = text_of(ev);
        if (current !== "" && piece !== "") budget.item();
        current += piece;
      }
    } else if (ev.name === "t") {
      in_t = false;
    } else if (ev.name === "rPh") {
      phonetic = Math.max(0, phonetic - 1);
    } else if (ev.name === "si" && current !== null) {
      strings.push(current);
      current = null;
    }
  }
  return strings;
}

/**
 * Shared strings, escaped for a table cell at most once each (a string used by 200,000 cells is escaped once and the
 * cells share it). The escaped LENGTH is known without building anything (`length_of`), so the caller pays the budget
 * first and only then asks for the text (`escaped_of`) — also the first time a string is used.
 */
class SharedCells {
  private readonly escaped = new Map<number, string>();
  private readonly lengths = new Map<number, number>();
  private readonly raw: string[];
  constructor(raw: string[]) {
    this.raw = raw;
  }
  /** the raw text (to know whether the cell is empty), or undefined for an unknown index */
  raw_of(index: number): string | undefined {
    return this.raw[index];
  }
  /** length of the escaped text; counted, not built */
  length_of(index: number): number {
    let length = this.lengths.get(index);
    if (length === undefined) {
      length = cell_text_length([this.raw[index] as string]);
      this.lengths.set(index, length);
    }
    return length;
  }
  /** the escaped text (built once); the caller has paid for length_of(index) before asking */
  escaped_of(index: number): string {
    let escaped = this.escaped.get(index);
    if (escaped === undefined) {
      escaped = cell_text(this.raw[index] as string);
      this.escaped.set(index, escaped);
    }
    return escaped;
  }
}

function read_sheet(xml: string, shared: SharedCells, budget: Budget): SheetData {
  const sheet: SheetData = { row_starts: [], cols: [], vals: [], width: 0, paid: 0, printed: 0 };
  let row_start = -1;
  let cell: { col: number; type: string; v: string; is: string } | null = null;
  let cap: "v" | "is" | null = null;
  let in_is = false;
  let phonetic = 0;
  let next_col = 0;
  for (const ev of xml_events(xml, budget)) {
    if (ev.k === "open") {
      if (ev.name === "row") {
        // a row opened inside an open row starts over
        if (row_start >= 0) {
          sheet.cols.length = row_start;
          sheet.vals.length = row_start;
        }
        row_start = sheet.cols.length;
        next_col = 0;
      } else if (ev.name === "c" && row_start >= 0) {
        const col = column_index(attr_of(ev.attrs, "r") ?? "") ?? next_col;
        if (col >= MAX_COLUMN) throw new XmlError("column out of range");
        cell = { col, type: attr_of(ev.attrs, "t") ?? "n", v: "", is: "" };
        next_col = col + 1;
      } else if (ev.name === "v" && cell !== null) {
        cap = "v";
      } else if (ev.name === "is" && cell !== null) {
        in_is = true;
      } else if (ev.name === "rPh") {
        phonetic += 1;
      } else if (ev.name === "t" && cell !== null && in_is && phonetic === 0) {
        cap = "is";
      }
    } else if (ev.k === "text") {
      if (cell !== null && cap !== null) {
        const piece = text_of(ev);
        if (cell[cap] !== "" && piece !== "") budget.item();
        cell[cap] += piece;
      }
    } else if (ev.name === "v" || ev.name === "t") {
      cap = null;
    } else if (ev.name === "rPh") {
      phonetic = Math.max(0, phonetic - 1);
    } else if (ev.name === "is") {
      in_is = false;
    } else if (ev.name === "c" && cell !== null && row_start >= 0) {
      let raw: string;
      let shared_index = -1;
      if (cell.type === "s") {
        const index = Number.parseInt(cell.v.trim(), 10);
        raw = shared.raw_of(index) ?? "";
        if (raw !== "") shared_index = index;
      } else if (cell.type === "inlineStr") raw = cell.is;
      else if (cell.type === "b") raw = cell.v.trim() === "1" ? "TRUE" : "FALSE";
      else raw = cell.v.trim();
      // An empty cell is not kept, and a row is never widened with empty cells here (a "XFD1" cell would otherwise cost
      // 16,384 cells for the one value): the row is widened only when it is printed, against the output budget.
      if (raw !== "") {
        budget.item();
        // the value is paid for BEFORE it is copied (a shared string is escaped once, after its first payment, and only referenced here)
        let value: string;
        if (shared_index >= 0) {
          const length = shared.length_of(shared_index);
          budget.charge(length + 3);
          sheet.paid += length + 3;
          value = shared.escaped_of(shared_index);
        } else {
          const length = cell_text_length([raw]);
          budget.charge(length + 3);
          sheet.paid += length + 3;
          value = length === 0 ? "" : cell_text(raw);
        }
        sheet.cols.push(cell.col);
        sheet.vals.push(value);
        if (cell.col + 1 > sheet.width) sheet.width = cell.col + 1;
      }
      cell = null;
    } else if (ev.name === "row" && row_start >= 0) {
      if (sheet.cols.length > row_start) {
        budget.item();
        sheet.row_starts.push(row_start);
      }
      row_start = -1;
    }
  }
  return sheet;
}

function extract_xlsx(zip: ZipArchive, budget: Budget): ExtractOutcome {
  if (!zip.has("xl/workbook.xml")) throw invalid_document("통합 문서(xl/workbook.xml)가 없습니다.");
  const sheets: Array<{ name: string; rid: string | undefined }> = [];
  try {
    for (const ev of xml_events(utf8(zip.read("xl/workbook.xml")), budget)) {
      if (ev.k === "open" && ev.name === "sheet") {
        if (sheets.length >= MAX_SHEETS) throw new ExtractFailure("too_large", `시트가 ${MAX_SHEETS}개를 넘어 글자를 뽑지 않았습니다.`);
        budget.item();
        sheets.push({ name: ev.attrs.name ?? "", rid: attr_of(ev.attrs, "id") });
      }
    }
  } catch (error) {
    if (error instanceof XmlError) throw invalid_document("통합 문서(xl/workbook.xml)를 읽을 수 없습니다.");
    throw error;
  }
  if (sheets.length === 0) throw invalid_document("시트가 없습니다.");

  const targets = new Map<string, string>();
  if (zip.has("xl/_rels/workbook.xml.rels")) {
    try {
      for (const ev of xml_events(utf8(zip.read("xl/_rels/workbook.xml.rels")), budget)) {
        if (ev.k === "open" && ev.name === "Relationship" && ev.attrs.Id !== undefined && ev.attrs.Target !== undefined) {
          budget.item();
          targets.set(ev.attrs.Id, ev.attrs.Target);
        }
      }
    } catch (error) {
      if (!(error instanceof XmlError)) throw error;
    }
  }

  let shared = new SharedCells([]);
  if (zip.has("xl/sharedStrings.xml")) {
    try {
      shared = new SharedCells(read_shared_strings(utf8(zip.read("xl/sharedStrings.xml")), budget));
    } catch (error) {
      if (error instanceof XmlError) throw invalid_document("공유 문자열(xl/sharedStrings.xml)을 읽을 수 없습니다.");
      throw error;
    }
  }

  const warnings = new Warnings();
  const lines: string[] = [];
  // a part is unpacked and read once, however many sheets point at it (null: it could not be read)
  const done = new Map<string, SheetData | null>();
  let non_empty = 0;
  let read = 0;
  for (const [index, sheet] of sheets.entries()) {
    budget.tick();
    const target = sheet.rid === undefined ? undefined : targets.get(sheet.rid);
    let path = `xl/worksheets/sheet${index + 1}.xml`;
    if (target !== undefined) {
      const resolved = target.startsWith("/") ? target.slice(1) : posix.normalize(`xl/${target}`);
      if (resolved.split("/")[0] !== "..") path = resolved;
    }
    let found: SheetData | null;
    if (done.has(path)) {
      found = done.get(path) ?? null;
      if (found === null) warnings.add(part_warning(path));
    } else {
      found = guard_part(path, warnings, () => {
        if (!zip.has(path)) throw new ExtractFailure("part_missing", `부품 ${path} 이(가) 없습니다.`);
        return read_sheet(utf8(zip.read(path)), shared, budget);
      });
      done.set(path, found);
    }
    if (found === null) continue;
    read += 1;
    if (found.row_starts.length === 0) continue;
    non_empty += 1;
    budget.charge(sheet.name.length + 5);
    lines.push(`## ${sheet.name}`);
    push_all(lines, sparse_pipe_table(found, budget));
  }
  if (read === 0) throw invalid_document("읽을 수 있는 시트가 없습니다.");
  return finish(lines, non_empty, sheets.length, warnings);
}

// ---------------------------------------------------------------------------
// plain text

function extract_plain(format: "txt" | "md" | "csv", bytes: Uint8Array): ExtractOutcome {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return failed("invalid_encoding", "UTF-8 이 아니어서 글자를 짐작하지 않고 멈췄습니다. UTF-8 로 저장해 다시 올려 주세요.");
  }
  if (decoded.charCodeAt(0) === 0xfeff) decoded = decoded.slice(1);
  const text = normalize_newlines(decoded);
  return {
    status: "extracted",
    reason: null,
    text,
    page_count: null,
    table_count: format === "csv" && text.trim() !== "" ? 1 : 0,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// entry point

/**
 * Extract text from the bytes of a file. `original_name` decides the format (by extension).
 * The caller must have checked `bytes.length <= MAX_SOURCE_BYTES` before reading the file (see too_large_outcome).
 */
export function extract_text(original_name: string | null, bytes: Uint8Array): ExtractOutcome {
  if (bytes.byteLength > MAX_SOURCE_BYTES) return too_large_outcome();
  const format = format_of(original_name);
  try {
    switch (format) {
      case "txt":
      case "md":
      case "csv":
        return extract_plain(format, bytes);
      case "docx":
        return extract_docx(...open_zip(bytes));
      case "xlsx":
        return extract_xlsx(...open_zip(bytes));
      case "pptx":
        return extract_pptx(...open_zip(bytes));
      case "hwpx":
        return extract_hwpx(...open_zip(bytes));
      default: {
        const label = format === "unknown" ? (extension_of(original_name) === "" ? "(확장자 없음)" : `.${extension_of(original_name)}`) : `.${format}`;
        return {
          status: "unsupported",
          reason: "unsupported_format",
          text: null,
          page_count: null,
          table_count: 0,
          warnings: [{ code: "unsupported_format", message: `${label} 형식은 이 컴퓨터에서 글자를 뽑을 수 없습니다. 글자를 지어내지 않았습니다.` }],
        };
      }
    }
  } catch (error) {
    if (error instanceof ExtractFailure) return failed(error.code, error.message);
    // Anything else (an engine limit such as "Invalid string length", a bug) must still leave a record, not a 500 and a rollback.
    return failed("extract_error", "글자를 뽑는 중 예기치 않은 오류가 나서 멈췄습니다. 글자를 지어내지 않았습니다.");
  }
}

function open_zip(bytes: Uint8Array): [ZipArchive, Budget] {
  const budget = new Budget(MAX_UNPACKED_BYTES);
  return [new ZipArchive(bytes, budget), budget];
}

export function too_large_outcome(): ExtractOutcome {
  return failed("too_large", "파일이 너무 커서 글자를 뽑지 않았습니다(원본 32 MiB, 펼친 크기 64 MiB 상한).");
}

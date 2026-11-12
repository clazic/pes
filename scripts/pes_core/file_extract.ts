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
//     central directory span and the XML nesting depth are capped too.

import { crc32, inflateRawSync } from "node:zlib";
import { posix } from "node:path";

export const EXTRACTOR = "pes-builtin";
export const EXTRACTOR_VERSION = "1";
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_XML_DEPTH = 512;
const MAX_COLUMN = 16_384;

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

class Budget {
  remaining: number;
  constructor(total: number) {
    this.remaining = total;
  }
}

function container_error(message: string): ExtractFailure {
  return new ExtractFailure("invalid_container", message);
}

function too_large(): ExtractFailure {
  return new ExtractFailure("too_large", "파일이 너무 커서 글자를 뽑지 않았습니다(펼친 크기가 상한을 넘었습니다).");
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

  /** The unpacked bytes of one part. Counts against the shared budget before and while unpacking. */
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
        out = inflateRawSync(packed, { maxOutputLength: Math.max(1, this.budget.remaining) });
      } catch (error) {
        if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw too_large();
        throw container_error(`부품 ${name} 이(가) 손상되었습니다.`);
      }
    } else {
      throw container_error(`부품 ${name} 의 압축 방식을 지원하지 않습니다.`);
    }
    if (out.length > this.budget.remaining) throw too_large();
    if (out.length !== entry.usize) throw container_error(`부품 ${name} 이(가) 손상되었습니다.`);
    if (crc32(out) !== entry.crc) throw container_error(`부품 ${name} 이(가) 손상되었습니다.`);
    this.budget.remaining -= out.length;
    return out;
  }
}

// ---------------------------------------------------------------------------
// XML (events; local names; well-formedness is checked, nothing is expanded beyond the five entities and numbers)

type XmlEvent =
  | { k: "open"; name: string; attrs: Record<string, string>; self: boolean }
  | { k: "close"; name: string }
  | { k: "text"; text: string };

class XmlError extends Error {}

const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

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

export function xml_decode(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (whole, body: string) => {
    if (body === "amp") return "&";
    if (body === "lt") return "<";
    if (body === "gt") return ">";
    if (body === "quot") return '"';
    if (body === "apos") return "'";
    const code = body[1] === "x" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
    return String.fromCodePoint(code);
  });
}

function* xml_events(src: string): Generator<XmlEvent> {
  const stack: string[] = [];
  let at = 0;
  let saw_root = false;
  while (at < src.length) {
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
      yield { k: "text", text: src.slice(lt + 9, end).replace(/&/g, "&amp;").replace(/</g, "&lt;") };
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
    const attr_text = inner.slice(raw.length);
    if (stack.length === 0) {
      if (saw_root) throw new XmlError("more than one root");
      saw_root = true;
    }
    const attrs: Record<string, string> = {};
    if (attr_text.trim() !== "") {
      // every character of the attribute text must belong to a name="value" pair
      if (attr_text.replace(ATTR_RE, "").trim() !== "") throw new XmlError("bad attribute");
      for (const found of attr_text.matchAll(ATTR_RE)) attrs[found[1] as string] = xml_decode(found[2] ?? found[3] ?? "");
    }
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

function cell_text(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

function pipe_row(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

/** rows -> pipe-table lines: header row, a separator of the same width, then the rest. */
function pipe_table(rows: string[][]): string[] {
  const lines: string[] = [];
  rows.forEach((row, index) => {
    lines.push(pipe_row(row.map(cell_text)));
    if (index === 0) lines.push(pipe_row(row.map(() => "---")));
  });
  return lines;
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
}
interface TableFrame {
  rows: CellFrame[][];
  row: CellFrame[] | null;
  parent_cell: CellFrame | null;
}

/** Walks one body part. Throws XmlError when the XML is not well formed. */
function read_body(xml: string): BodyResult {
  const lines: string[] = [];
  let tables = 0;
  const paras: ParaFrame[] = [];
  const cells: CellFrame[] = [];
  const table_stack: TableFrame[] = [];
  let text_depth = 0;
  for (const ev of xml_events(xml)) {
    if (ev.k === "open") {
      switch (ev.name) {
        case "p":
          paras.push({ text: "", cell: cells.length > 0 ? (cells[cells.length - 1] as CellFrame) : null });
          break;
        case "t":
          text_depth += 1;
          break;
        case "br":
        case "lineBreak":
          if (paras.length > 0) (paras[paras.length - 1] as ParaFrame).text += "\n";
          break;
        case "tab":
          if (paras.length > 0 && text_depth === 0) (paras[paras.length - 1] as ParaFrame).text += "\t";
          break;
        case "tbl":
          tables += 1;
          table_stack.push({ rows: [], row: null, parent_cell: cells.length > 0 ? (cells[cells.length - 1] as CellFrame) : null });
          break;
        case "tr":
          if (table_stack.length > 0) (table_stack[table_stack.length - 1] as TableFrame).row = [];
          break;
        case "tc": {
          const cell: CellFrame = { parts: [] };
          cells.push(cell);
          const table = table_stack[table_stack.length - 1];
          if (table?.row) table.row.push(cell);
          break;
        }
        default:
          break;
      }
    } else if (ev.k === "text") {
      if (text_depth > 0 && paras.length > 0) (paras[paras.length - 1] as ParaFrame).text += xml_decode(ev.text);
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
          if (para.cell) para.cell.parts.push(text);
          else lines.push(text);
          break;
        }
        case "tc":
          cells.pop();
          break;
        case "tr": {
          const table = table_stack[table_stack.length - 1];
          if (table?.row) {
            table.rows.push(table.row);
            table.row = null;
          }
          break;
        }
        case "tbl": {
          const table = table_stack.pop();
          if (table === undefined || table.rows.length === 0) break;
          const grid = table.rows.map((row) => row.map((cell) => cell.parts.join(" ")));
          const rendered = pipe_table(grid);
          if (table.parent_cell) table.parent_cell.parts.push(rendered.join(" "));
          else lines.push(...rendered);
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

function utf8(buf: Buffer): string {
  return buf.toString("utf8");
}

function part_warning(name: string): ExtractWarning {
  return { code: "part_unreadable", message: `부품 ${name} 을(를) 읽지 못해 그 부분은 빠졌습니다.` };
}

function invalid_document(message: string): ExtractFailure {
  return new ExtractFailure("invalid_document", message);
}

/** Reads a part that must exist: missing or unreadable XML -> invalid_document. */
function read_main(zip: ZipArchive, name: string): BodyResult {
  if (!zip.has(name)) throw invalid_document(`본문 부품 ${name} 이(가) 없습니다.`);
  try {
    return read_body(utf8(zip.read(name)));
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

function guard_part<T>(zip: ZipArchive, name: string, warnings: ExtractWarning[], read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    if (error instanceof XmlError) {
      warnings.push(part_warning(name));
      return null;
    }
    if (error instanceof ExtractFailure && error.code === "invalid_container") {
      warnings.push(part_warning(name));
      return null;
    }
    throw error;
  }
}

function extract_docx(zip: ZipArchive): ExtractOutcome {
  const body = read_main(zip, "word/document.xml");
  return { status: "extracted", reason: null, text: body_text(body.lines), page_count: null, table_count: body.tables, warnings: [] };
}

function extract_hwpx(zip: ZipArchive): ExtractOutcome {
  const sections = numbered_parts(zip, /^Contents\/section(\d+)\.xml$/);
  if (sections.length === 0) throw invalid_document("본문 구역(Contents/section*.xml)이 없습니다.");
  const warnings: ExtractWarning[] = [];
  const lines: string[] = [];
  let tables = 0;
  let read = 0;
  for (const section of sections) {
    const body = guard_part(zip, section.name, warnings, () => read_body(utf8(zip.read(section.name))));
    if (body === null) continue;
    read += 1;
    lines.push(...body.lines);
    tables += body.tables;
  }
  if (read === 0) throw invalid_document("읽을 수 있는 본문 구역이 없습니다.");
  return finish(lines, tables, null, warnings);
}

function extract_pptx(zip: ZipArchive): ExtractOutcome {
  const slides = numbered_parts(zip, /^ppt\/slides\/slide(\d+)\.xml$/);
  if (slides.length === 0) throw invalid_document("슬라이드(ppt/slides/slide*.xml)가 없습니다.");
  const warnings: ExtractWarning[] = [];
  const lines: string[] = [];
  let tables = 0;
  let read = 0;
  for (const slide of slides) {
    const body = guard_part(zip, slide.name, warnings, () => read_body(utf8(zip.read(slide.name))));
    if (body === null) continue;
    read += 1;
    lines.push(`## 슬라이드 ${slide.n}`, ...body.lines);
    tables += body.tables;
  }
  if (read === 0) throw invalid_document("읽을 수 있는 슬라이드가 없습니다.");
  return finish(lines, tables, slides.length, warnings);
}

function finish(lines: string[], tables: number, pages: number | null, warnings: ExtractWarning[]): ExtractOutcome {
  return {
    status: warnings.length > 0 ? "partial" : "extracted",
    reason: warnings[0]?.code ?? null,
    text: body_text(lines),
    page_count: pages,
    table_count: tables,
    warnings,
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

function read_shared_strings(xml: string): string[] {
  const strings: string[] = [];
  let current: string | null = null;
  let in_t = false;
  let phonetic = 0;
  for (const ev of xml_events(xml)) {
    if (ev.k === "open") {
      if (ev.name === "si") current = "";
      else if (ev.name === "rPh") phonetic += 1;
      else if (ev.name === "t" && current !== null && phonetic === 0) in_t = true;
    } else if (ev.k === "text") {
      if (in_t && current !== null) current += xml_decode(ev.text);
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

function read_sheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  let row: string[] | null = null;
  let cell: { col: number; type: string; v: string; is: string } | null = null;
  let cap: "v" | "is" | null = null;
  let in_is = false;
  let phonetic = 0;
  let next_col = 0;
  for (const ev of xml_events(xml)) {
    if (ev.k === "open") {
      if (ev.name === "row") {
        row = [];
        next_col = 0;
      } else if (ev.name === "c" && row !== null) {
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
      if (cell !== null && cap !== null) cell[cap] += xml_decode(ev.text);
    } else if (ev.name === "v" || ev.name === "t") {
      cap = null;
    } else if (ev.name === "rPh") {
      phonetic = Math.max(0, phonetic - 1);
    } else if (ev.name === "is") {
      in_is = false;
    } else if (ev.name === "c" && cell !== null && row !== null) {
      let value: string;
      if (cell.type === "s") value = shared[Number.parseInt(cell.v.trim(), 10)] ?? "";
      else if (cell.type === "inlineStr") value = cell.is;
      else if (cell.type === "b") value = cell.v.trim() === "1" ? "TRUE" : "FALSE";
      else value = cell.v.trim();
      while (row.length < cell.col) row.push("");
      row[cell.col] = value;
      cell = null;
    } else if (ev.name === "row" && row !== null) {
      if (row.some((value) => value !== "")) rows.push(row);
      row = null;
    }
  }
  return rows;
}

function extract_xlsx(zip: ZipArchive): ExtractOutcome {
  if (!zip.has("xl/workbook.xml")) throw invalid_document("통합 문서(xl/workbook.xml)가 없습니다.");
  const sheets: Array<{ name: string; rid: string | undefined }> = [];
  try {
    for (const ev of xml_events(utf8(zip.read("xl/workbook.xml")))) {
      if (ev.k === "open" && ev.name === "sheet") sheets.push({ name: ev.attrs.name ?? "", rid: attr_of(ev.attrs, "id") });
    }
  } catch (error) {
    if (error instanceof XmlError) throw invalid_document("통합 문서(xl/workbook.xml)를 읽을 수 없습니다.");
    throw error;
  }
  if (sheets.length === 0) throw invalid_document("시트가 없습니다.");

  const targets = new Map<string, string>();
  if (zip.has("xl/_rels/workbook.xml.rels")) {
    try {
      for (const ev of xml_events(utf8(zip.read("xl/_rels/workbook.xml.rels")))) {
        if (ev.k === "open" && ev.name === "Relationship" && ev.attrs.Id !== undefined && ev.attrs.Target !== undefined) targets.set(ev.attrs.Id, ev.attrs.Target);
      }
    } catch (error) {
      if (!(error instanceof XmlError)) throw error;
    }
  }

  let shared: string[] = [];
  if (zip.has("xl/sharedStrings.xml")) {
    try {
      shared = read_shared_strings(utf8(zip.read("xl/sharedStrings.xml")));
    } catch (error) {
      if (error instanceof XmlError) throw invalid_document("공유 문자열(xl/sharedStrings.xml)을 읽을 수 없습니다.");
      throw error;
    }
  }

  const warnings: ExtractWarning[] = [];
  const lines: string[] = [];
  let non_empty = 0;
  let read = 0;
  for (const [index, sheet] of sheets.entries()) {
    const target = sheet.rid === undefined ? undefined : targets.get(sheet.rid);
    let path = `xl/worksheets/sheet${index + 1}.xml`;
    if (target !== undefined) {
      const resolved = target.startsWith("/") ? target.slice(1) : posix.normalize(`xl/${target}`);
      if (resolved.split("/")[0] !== "..") path = resolved;
    }
    const rows = guard_part(zip, path, warnings, () => {
      if (!zip.has(path)) throw container_error("missing");
      return read_sheet(utf8(zip.read(path)), shared);
    });
    if (rows === null) continue;
    read += 1;
    if (rows.length === 0) continue;
    non_empty += 1;
    lines.push(`## ${sheet.name}`, ...pipe_table(rows));
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
  const text = decoded.replace(/\r\n?/g, "\n");
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
        return extract_docx(new ZipArchive(bytes, new Budget(MAX_UNPACKED_BYTES)));
      case "xlsx":
        return extract_xlsx(new ZipArchive(bytes, new Budget(MAX_UNPACKED_BYTES)));
      case "pptx":
        return extract_pptx(new ZipArchive(bytes, new Budget(MAX_UNPACKED_BYTES)));
      case "hwpx":
        return extract_hwpx(new ZipArchive(bytes, new Budget(MAX_UNPACKED_BYTES)));
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
    throw error;
  }
}

export function too_large_outcome(): ExtractOutcome {
  return failed("too_large", "파일이 너무 커서 글자를 뽑지 않았습니다(원본 32 MiB, 펼친 크기 64 MiB 상한).");
}

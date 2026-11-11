// Normalisers N1~N10 of docs/plan/migration-ts-equivalence.md 7.2 (SEL-70, PR26a). Pure functions: no I/O, no clock.
//
//   N1 time        N2 paths       N3 JSON        N4 order       N5 ids
//   N6 html        N7 encoding    N8 console     N9 file meta   N10 known (intended) differences
//
// The same functions normalise the 0.15 (py) side and the TS side, so a difference left after them is a real one.

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

// ---------------------------------------------------------------- N7 encoding
/** UTF-8, no BOM, LF. A lone CR (old Mac) is left alone; CRLF becomes LF. */
export function n7_text(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

// ---------------------------------------------------------------- N1 time
const TIME_KEYS = new Set(["built", "approved_at", "reports_built", "created", "recorded", "at", "since", "time", "updated", "ts"]);

export function n1_time(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<TIME>")
    .replace(/\b\d{8}-\d{6}\b/g, "<TIME>")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "<DATE>");
}

// ---------------------------------------------------------------- N2 paths
export interface Roots {
  /** repository root (scripts/pes.py lives below it) */
  PES?: string;
  /** one project folder */
  PROJECT?: string;
  /** the isolated HOME */
  HOME?: string;
  /** the isolated temp folder of the case (parent of everything above) */
  TMP?: string;
}

/** One root in every spelling: as given, realpath.native (Windows 8.3 RUNNER~1, macOS /private/var), JSON / repr doubled backslashes. */
export function root_spellings(root: string): string[] {
  const forms = new Set<string>([root]);
  try {
    forms.add(realpathSync.native(root));
  } catch {
    // a path that does not exist keeps only its own spelling
  }
  for (const form of [...forms]) {
    if (form.includes("\\")) {
      forms.add(form.split("\\").join("\\\\"));
      forms.add(form.split("\\").join("/"));
    }
  }
  return [...forms].filter((form) => form.length > 1);
}

const ORDER: (keyof Roots)[] = ["PROJECT", "HOME", "PES", "TMP"];

/** Replaces roots by <PROJECT> / <HOME> / <PES> / <TMP> (longest spelling first, most specific root first), then `\` → `/`. */
export function n2_paths(text: string, roots: Roots): string {
  let out = text;
  const pairs: [string, string][] = [];
  for (const key of ORDER) {
    const root = roots[key];
    if (root === undefined) continue;
    for (const form of root_spellings(root)) pairs.push([form, `<${key}>`]);
  }
  // A longer spelling must win over a shorter one that is its prefix, whatever root it belongs to.
  pairs.sort((x, y) => y[0].length - x[0].length);
  for (const [form, label] of pairs) out = out.split(form).join(label);
  // After the roots are gone, a remaining path separator inside a <ROOT>-relative path is made uniform. A folder name may hold
  // spaces ("<TMP>\\work\\합성 프로젝트\\project.json" on Windows): a space belongs to the path when the word after it still holds a
  // separator; otherwise the path ends there ("<PROJECT>/x.json and more").
  return out.replace(/(<(?:PROJECT|HOME|PES|TMP)>)((?:[^\s"'<>,;)\]}]| (?=[^\s"'<>,;)\]}]*[\\/]))*)/g, (_whole, label: string, rest: string) => label + rest.split("\\\\").join("/").split("\\").join("/"));
}

// ---------------------------------------------------------------- N8 console
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function n8_console(text: string, roots: Roots): string {
  return n11_relpaths(n1_time(n2_paths(n7_text(text).replace(ANSI, ""), roots)));
}

// ---------------------------------------------------------------- N11 relative paths in console text
/**
 * A relative file path printed by a command (`reports\plan\report.html` on Windows, `reports/plan/report.html` elsewhere) → `/`.
 * Only console TEXT: the same path stored in project.json is data and is NOT touched (see os_overrides in cases.json). A word
 * qualifies when it has at least one `\` between name parts (letters, digits, Hangul, `.`, `_`, `-`) and ends in a file extension
 * (so a literal `\n` inside a message is left alone).
 */
export function n11_relpaths(text: string): string {
  return text.replace(/(?<![\w<>.\\-])([\w.가-힣-]+(?:\\[\w.가-힣-]+)*\\[\w가-힣-]+\.\w+)/g, (word: string) => word.split("\\").join("/"));
}

// ---------------------------------------------------------------- N12 stdlib error page
/**
 * The 404 page that `http.server` writes itself. Its HTML is the interpreter's, not PES's: Python 3.9~3.12 send a 460 character
 * page, 3.13+ a shorter one. A response is this page when it is an HTML error status whose body has the stdlib title and heading.
 */
export function n12_stdlib_error_page(status: number, text: string): string | null {
  if (status < 400) return null;
  return /<title>Error response<\/title>/.test(text) && /<h1>Error response<\/h1>/.test(text) && /Error code: \d+/.test(text) ? "<python http.server error page>" : null;
}

export function lines(text: string): string[] {
  const out = text.split("\n");
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/** stderr as a "kind": a Python traceback is reduced to its exception line; anything else keeps its normalised lines. */
export function stderr_kind(stderr: string, roots: Roots): string[] {
  const body = lines(n8_console(stderr, roots));
  if (body.length === 0) return [];
  if (body.some((line) => line.startsWith("Traceback (most recent call last)"))) {
    const last = [...body].reverse().find((line) => /^[A-Za-z_.]+(Error|Exception|Exit)\b/.test(line)) ?? body[body.length - 1] ?? "";
    return [`traceback: ${last}`];
  }
  return body;
}

// ---------------------------------------------------------------- N3 JSON
export function n3_sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(n3_sort);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) out[key] = n3_sort((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** Canonical JSON text: keys sorted, 1-space indent, non-ASCII kept, null kept. Numbers and numeric strings stay different. */
export function n3_json(value: unknown): string {
  return JSON.stringify(n3_sort(value), null, 1);
}

/** Time-like values inside parsed JSON → <TIME> (strings) / <EPOCH> (numbers under known time keys). */
export function n1_json(value: unknown, roots: Roots = {}, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => n1_json(item, roots, key));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = n1_json(v, roots, k);
    return out;
  }
  if (typeof value === "number" && TIME_KEYS.has(key)) return "<EPOCH>";
  if (typeof value === "string") return n1_time(n2_paths(n7_text(value), roots));
  return value;
}

// ---------------------------------------------------------------- N4 order
export const STAGE_ORDINAL: Record<string, number> = { plan: 0, research: 1, analyze: 2, write: 3, verify: 4, publish: 5 };

/** Business order key of a list of rows: (stage ordinal, round, item id). Rows without one keep their input order (stable sort). */
export function n4_order<T extends { stage?: string; round?: number; id?: number | string }>(rows: T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const sa = STAGE_ORDINAL[a.row.stage ?? ""] ?? -1;
      const sb = STAGE_ORDINAL[b.row.stage ?? ""] ?? -1;
      return sa - sb || (a.row.round ?? 0) - (b.row.round ?? 0) || String(a.row.id ?? "").localeCompare(String(b.row.id ?? ""), "en", { numeric: true }) || a.index - b.index;
    })
    .map((x) => x.row);
}

/** Lists whose order is not a contract compare as multisets. */
export function n4_multiset<T>(items: T[]): string[] {
  return items.map((item) => JSON.stringify(n3_sort(item))).sort();
}

// ---------------------------------------------------------------- N5 ids
const ID_PATTERNS = [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, /\b(?:tx|evt|lease|run)_[0-9A-Za-z]{8,}\b/g];

/** New UUID / tx / event / lease ids → <ID:n> in order of first appearance; only the reference structure survives. Shares `seen` across calls. */
export function n5_ids(text: string, seen: Map<string, string> = new Map()): string {
  let out = text;
  for (const pattern of ID_PATTERNS) {
    out = out.replace(pattern, (id) => {
      let label = seen.get(id);
      if (label === undefined) {
        label = `<ID:${seen.size + 1}>`;
        seen.set(id, label);
      }
      return label;
    });
  }
  return out;
}

// ---------------------------------------------------------------- N6 html
export interface HtmlView {
  title: string;
  /** the text between <title> and </title> exactly as written (not unescaped): a page that forgot to escape differs here */
  raw_title: string;
  /**
   * every <script> / <style> block except the data one, in page order: tag, sorted attributes and a content hash (N7/N1/N2 applied).
   * A shared module inserted twice, left out, or a script changed shows up as a different list.
   */
  blocks: string[];
  /** parsed `<script id="data" type="application/json">…</script>` (undefined when the page has none) */
  data: unknown;
  /** visible text: scripts / styles / comments / tags removed, whitespace collapsed, entities decoded (the few that matter) */
  text: string;
}

export function html_unescape(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export function n6_html(html: string, roots: Roots = {}): HtmlView {
  const source = n7_text(html);
  const title = /<title>([\s\S]*?)<\/title>/.exec(source)?.[1] ?? "";
  const data_match = /<script\b(?=[^>]*\bid="data")[^>]*>([\s\S]*?)<\/script>/.exec(source);
  const data = data_match === null ? undefined : n1_json(JSON.parse(data_match[1] as string), roots);
  const text = source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<title>[\s\S]*?<\/title>/g, " ")
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ");
  const blocks: string[] = [];
  for (const block of source.matchAll(/<(script|style)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const attrs = (block[2] as string).trim().split(/\s+/).filter((a) => a !== "").sort();
    if (block[1] === "script" && attrs.includes('id="data"')) continue;
    blocks.push(`${block[1]} ${attrs.join(" ")} ${n9_text_hash(block[3] as string, roots)}`);
  }
  return { title: html_unescape(title), raw_title: title, blocks, data, text: n1_time(n2_paths(html_unescape(text).replace(/\s+/g, " ").trim(), roots)) };
}

// ---------------------------------------------------------------- N9 file meta
/** Content hash of a text file after N7 / N1 / N2 (mtime, mode and owner are never looked at). */
export function n9_text_hash(text: string, roots: Roots = {}): string {
  return createHash("sha256").update(n1_time(n2_paths(n7_text(text), roots)), "utf8").digest("hex").slice(0, 16);
}

export function n9_bytes_hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------- N10 known differences
export interface KnownDiff {
  id: string;
  title: string;
  /** why the new core is allowed (or required) to differ — shown in the case table */
  reason: string;
  /** paths (dotted, `*` matches one key / index) removed from a state DTO before comparison */
  drop?: string[];
  /**
   * produced-file names (`/`-separated, `*` = within one folder, `**` = across folders) that are not compared by name.
   * Whatever such a pattern removes must be covered by a separate, explicit assertion (see `files_check`).
   */
  drop_files?: string[];
  /** the separate assertion that replaces the by-name comparison of `drop_files`; compat_cases.compare_ts_record runs it */
  files_check?: "snapshot_contents";
  /**
   * per case id: DTO paths (dotted, numbers index arrays) whose *expected* value is not the pinned 0.15 one but the fixed behaviour
   * the new core must show. The pinned baseline is never rewritten; the override is applied to the baseline copy before comparing,
   * so the ts side must show exactly that value (a dropped path would accept anything).
   */
  override?: Record<string, Record<string, unknown>>;
  /** extra DTO assertions that replace a dropped path (run on the ts DTO against the baseline DTO) */
  checks?: ("ids_distinct" | "processed_count")[];
}

function glob_to_regex(pattern: string): RegExp {
  const body = pattern
    .split("**")
    .map((part) => part.split("*").map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

/** The produced-file map (name → digest) without the files an intended difference lists by name pattern. Unknown ids throw. */
export function n10_files(files: Record<string, string>, ids: string[], table: Record<string, KnownDiff>): Record<string, string> {
  const patterns: RegExp[] = [];
  for (const id of ids) {
    const diff = table[id];
    if (diff === undefined) throw new Error(`unknown intended difference ${id}`);
    for (const pattern of diff.drop_files ?? []) patterns.push(glob_to_regex(pattern));
  }
  return Object.fromEntries(Object.entries(files).filter(([name]) => !patterns.some((re) => re.test(name))));
}

/** The digests of the files that match `drop_files` of the listed differences, sorted — names are ignored, contents are not. */
export function dropped_digests(files: Record<string, string>, ids: string[], table: Record<string, KnownDiff>): string[] {
  const kept = n10_files(files, ids, table);
  return Object.entries(files)
    .filter(([name]) => !(name in kept))
    .map(([, digest]) => digest)
    .sort();
}

function drop_path(value: unknown, parts: string[]): void {
  if (value === null || typeof value !== "object" || parts.length === 0) return;
  const [head, ...rest] = parts as [string, ...string[]];
  const targets = head === "*" ? Object.keys(value as object) : [head];
  for (const key of targets) {
    if (rest.length === 0) {
      if (Array.isArray(value)) (value as unknown[])[Number(key)] = undefined;
      else delete (value as Record<string, unknown>)[key];
    } else {
      drop_path((value as Record<string, unknown>)[key], rest);
    }
  }
}

/** Removes what a listed intended difference makes incomparable, from a deep copy. Unknown ids throw (a typo must not hide a diff). */
export function n10_apply(dto: unknown, ids: string[], table: Record<string, KnownDiff>): unknown {
  const copy = JSON.parse(JSON.stringify(dto)) as unknown;
  for (const id of ids) {
    const diff = table[id];
    if (diff === undefined) throw new Error(`unknown intended difference ${id}`);
    for (const path of diff.drop ?? []) drop_path(copy, path.split("."));
  }
  return copy;
}

function set_path(value: unknown, parts: string[], replacement: unknown): void {
  let cursor = value as any;
  for (const part of parts.slice(0, -1)) {
    cursor = cursor?.[part];
    if (cursor === null || typeof cursor !== "object") throw new Error(`override path ${parts.join(".")} does not exist in the baseline DTO`);
  }
  const last = parts[parts.length - 1] as string;
  if (!(last in cursor)) throw new Error(`override path ${parts.join(".")} does not exist in the baseline DTO`);
  cursor[last] = replacement;
}

/** The pinned baseline DTO with the fixed behaviour of the listed differences written in (see KnownDiff.override). Missing path throws. */
export function n10_override(dto: unknown, case_id: string, ids: string[], table: Record<string, KnownDiff>): unknown {
  const copy = JSON.parse(JSON.stringify(dto)) as unknown;
  for (const id of ids) {
    const diff = table[id];
    if (diff === undefined) throw new Error(`unknown intended difference ${id}`);
    for (const [path, replacement] of Object.entries(diff.override?.[case_id] ?? {})) set_path(copy, path.split("."), replacement);
  }
  return copy;
}

/** KnownDiff.checks on the ts DTO. D01: items still carry an id and the ids are pairwise distinct. D03: `processed` is a list of the same length. */
export function n10_checks(got: any, base: any, ids: string[], table: Record<string, KnownDiff>): string[] {
  const problems: string[] = [];
  // an http case has no state DTO (dto: null on both sides): there is nothing to check
  if (base === null || base === undefined) return problems;
  for (const id of ids) {
    for (const check of table[id]?.checks ?? []) {
      if (check === "ids_distinct") {
        for (const [stage, value] of Object.entries<any>(got?.stages ?? {})) {
          const found = (value.items ?? []).map((item: any) => item.id);
          if (found.some((x: unknown) => x === undefined || x === null) || new Set(found).size !== found.length) problems.push(`${id}: stage ${stage} item ids are missing or repeat`);
        }
        const stages = Object.keys(base?.stages ?? {}).sort().join(",");
        if (Object.keys(got?.stages ?? {}).sort().join(",") !== stages) problems.push(`${id}: stage set differs`);
      } else if (check === "processed_count") {
        if (!Array.isArray(got?.processed) || got.processed.length !== (base?.processed ?? []).length) problems.push(`${id}: processed is not a list of ${(base?.processed ?? []).length}`);
      }
    }
  }
  return problems;
}

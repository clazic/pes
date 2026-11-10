// The real report generator (stage 2 PR16).
//
// A TypeScript port of the v0.15 report writers in scripts/pes.py: the stage report
// (`stage_md` + `fill` of templates/stage-report.html), the manuscript assembly
// (`cmd_assemble`) and the final web report (`cmd_web` + templates/final-report.html).
// It works on a "legacy-shaped project" — the same dictionary shape pes.py's `load()`
// returns — so one generator serves both callers:
//   - PR12 validate_import: the project read from project.json + feedback/*.json
//     (migration.ts), compared with the report the old tool left behind;
//   - the CLI report/assemble/web commands: the project rebuilt from the database
//     (legacy_view.ts).
//
// The functions are pure: no file or database access except reading the repository's
// own templates/ and questions/ folders. Time is an argument ("작성 <시각>"), never read.
//
// Python parity: the output is meant to equal pes.py's byte for byte (apart from the
// time), so a few Python behaviours are reproduced on purpose: str() of None/True/False,
// json.dumps' ", " / ": " separators, str.strip(), slicing by code point.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The project is a dynamic JSON shape (hand-written project.json, database view); it is
// handled the way the Python code handles it: loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Dict = Record<string, any>;

export const STAGES: ReadonlyArray<readonly [string, string]> = [
  ["plan", "기획"],
  ["research", "조사"],
  ["analyze", "분석·종합"],
  ["write", "집필"],
  ["verify", "검증"],
  ["publish", "산출·공유"],
];
export const STAGE_KEYS: readonly string[] = STAGES.map(([key]) => key);
export const LABEL: Record<string, string> = Object.fromEntries(STAGES);
export const VERIFIED: ReadonlySet<string> = new Set(["browser", "kosis", "law", "vworld"]);
export const REPORT_NAME: Record<string, string> = {
  plan: "기획보고서",
  research: "조사보고서",
  analyze: "분석·종합보고서",
  write: "원고 검토본",
  verify: "검증보고서",
  publish: "산출 보고서",
};
const KIND_TXT: Record<string, string> = {
  rq: "연구 질문",
  chapter: "목차",
  topic: "조사 항목",
  issue: "쟁점",
  table: "비교표",
  insight: "시사점",
  section: "원고",
  claim: "주장",
  output: "산출물",
  schedule: "일정",
};
const EXTRA_LABELS: Record<string, string> = {
  client_city: "발주처 도시",
  "client_city=ulsan": "울산",
  seoul_station: "서울 역세권형 집계",
  "seoul_station=split": "유형 분리",
  "seoul_station=merge": "합산",
  asof: "기준일",
  official: "집계 근거",
  "official=self": "고시 원문 전수 대조",
  "official=foia": "정보공개청구 병행",
  outside: "특·광역시 밖 사례",
  "outside=compare": "제언 장에서 인용만",
  "outside=full": "현황까지 포함",
};

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

// ---------------------------------------------------------------------------
// Python-compatible helpers

function is_dict(value: unknown): value is Dict {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Python truthiness: None, False, 0, "", [] and {} are false. */
export function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (is_dict(value)) return Object.keys(value).length > 0;
  return true;
}

function py_repr(value: unknown): string {
  if (typeof value === "string") {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    let body = value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
    if (quote === "'") body = body.replace(/'/g, "\\'");
    return `${quote}${body}${quote}`;
  }
  return py_str(value);
}

/** Python's str(): None / True / False, lists and dicts in their repr form. */
export function py_str(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return `[${value.map(py_repr).join(", ")}]`;
  if (is_dict(value)) {
    return `{${Object.entries(value)
      .map(([key, entry]) => `${py_repr(key)}: ${py_repr(entry)}`)
      .join(", ")}}`;
  }
  return String(value);
}

/** dict.get(key, default) as an f-string would print it: a present null prints "None". */
function pget(dict: unknown, key: string, fallback: unknown = ""): string {
  if (is_dict(dict) && key in dict) return py_str(dict[key]);
  return py_str(fallback);
}

/** x.get(key) or fallback — the falsy-aware lookup. */
function por(dict: unknown, key: string, fallback: unknown): unknown {
  const value = is_dict(dict) ? dict[key] : undefined;
  return truthy(value) ? value : fallback;
}

function code_points(text: string): string[] {
  return Array.from(text);
}

/** Python slicing text[:n] counts code points. */
function head(text: string, n: number): string {
  const points = code_points(text);
  return points.length <= n ? text : points.slice(0, n).join("");
}

/** json.dumps(value, ensure_ascii=False): the default ", " and ": " separators. */
export function py_json(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(py_json).join(", ")}]`;
  if (is_dict(value)) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => `${JSON.stringify(key)}: ${py_json(entry)}`)
      .join(", ")}}`;
  }
  return "null";
}

function html_escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ---------------------------------------------------------------------------
// templates and the question bank

const template_cache = new Map<string, string>();

function template(name: string): string {
  let text = template_cache.get(name);
  if (text === undefined) {
    text = readFileSync(join(REPO_ROOT, "templates", name), "utf8");
    template_cache.set(name, text);
  }
  return text;
}

/** pes.py `fill`: the page template with the title and the JSON data blob substituted. */
export function fill_template(name: string, title: string, data: Dict): string {
  const blob = py_json(data).replace(/<\//g, "<\\/");
  const questions = name === "ask.html" || template(name).includes("<!--__QUESTIONS__-->") ? template("_questions.html") : "";
  return template(name)
    .split("__TITLE__")
    .join(html_escape(String(title)))
    .split("<!--__QUESTIONS__-->")
    .join(questions)
    .split("/*__DATA__*/null")
    .join(blob);
}

const bank_cache = new Map<string, Dict[]>();

function question_bank(stage: string): Dict[] {
  let bank = bank_cache.get(stage);
  if (bank === undefined) {
    try {
      const parsed = JSON.parse(readFileSync(join(REPO_ROOT, "questions", `${stage}.json`), "utf8")) as Dict;
      bank = Array.isArray(parsed.questions) ? (parsed.questions as Dict[]) : [];
    } catch {
      bank = [];
    }
    bank_cache.set(stage, bank);
  }
  return bank;
}

/** pes.py `qlabels`: question id -> label and (id, value) -> option label, from the question bank. */
function qlabels(stage: string): { lab: Map<string, unknown>; opt: Map<string, unknown> } {
  const lab = new Map<string, unknown>();
  const opt = new Map<string, unknown>();
  const stack = [...question_bank(stage)];
  while (stack.length > 0) {
    const q = stack.pop();
    if (!is_dict(q) || !("id" in q)) continue;
    const id = String(q.id);
    if (!lab.has(id)) lab.set(id, "label" in q ? q.label : q.id);
    for (const option of Array.isArray(q.options) ? q.options : []) {
      if (is_dict(option)) opt.set(`${id}\u0000${py_str(option.value)}`, "label" in option ? option.label : option.value);
    }
  }
  return { lab, opt };
}

function show_val(qid: string, value: unknown, opt: Map<string, unknown>): string {
  if (Array.isArray(value)) return value.map((entry) => show_val(qid, entry, opt)).join(", ");
  if (is_dict(value)) {
    return Object.entries(value)
      .map(([key, entry]) => `${key}: ${show_val(qid, entry, opt)}`)
      .join("; ");
  }
  const key = `${qid}\u0000${py_str(value)}`;
  return py_str(opt.has(key) ? opt.get(key) : value);
}

// ---------------------------------------------------------------------------
// the legacy project shape

export function new_stage(): Dict {
  return {
    status: "pending",
    round: 0,
    settings: {},
    items: [],
    review: null,
    suggestions: [],
    warnings: [],
    changes: [],
    history: [],
    summary: "",
    approved_at: null,
    stale: false,
    reports: [],
  };
}

export function blank_item(id: unknown, title: string): Dict {
  return {
    id,
    title,
    kind: "",
    question: "",
    status: "new",
    request: "",
    depth: 0,
    updated_round: 0,
    summary: "",
    details: "",
    sources: [],
    stats: [],
    shots: [],
    confidence: "",
    conflicts: [],
    verify: null,
    links: {},
    user_links: [],
  };
}

/** pes.py `load()`: fill the fields a hand-written project.json leaves out. */
export function normalize_project(raw: Dict, library: Dict | null = null): Dict {
  const p: Dict = raw;
  if (!is_dict(p.stages)) p.stages = {};
  for (const key of STAGE_KEYS) {
    if (!is_dict(p.stages[key])) p.stages[key] = new_stage();
    const stage = p.stages[key] as Dict;
    for (const [field, value] of Object.entries(new_stage())) if (!(field in stage)) stage[field] = value;
    if (!Array.isArray(stage.items)) stage.items = [];
    for (const item of stage.items as Dict[]) {
      if (!is_dict(item)) continue;
      for (const [field, value] of Object.entries(blank_item(0, ""))) {
        if (field === "id" || field === "title" || field in item) continue;
        item[field] = Array.isArray(value) ? [] : is_dict(value) ? {} : value;
      }
    }
  }
  if (!("processed" in p)) p.processed = [];
  if (!("notes" in p)) p.notes = [];
  if (library !== null && !truthy(p.library)) p.library = library;
  return p;
}

export interface FeedbackEntry {
  stage: string;
  round: unknown;
  kind: unknown;
  time: string;
  text: unknown;
  via: unknown;
  file: string;
  processed: boolean;
}

/** pes.py `load_feedback`: one parsed feedback/<name>.json per entry (sorted by name; unreadable ones skipped). */
export function feedback_entries(files: ReadonlyArray<{ name: string; text: string }>, processed: ReadonlySet<string>): FeedbackEntry[] {
  const out: FeedbackEntry[] = [];
  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    let x: Dict;
    try {
      const parsed: unknown = JSON.parse(file.text);
      if (!is_dict(parsed)) continue;
      x = parsed;
    } catch {
      continue;
    }
    let time = x.time === undefined || x.time === null ? "" : py_str(x.time);
    if (/^\d{8}-\d{6}$/.test(time)) {
      time = `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)} ${time.slice(9, 11)}:${time.slice(11, 13)}`;
    }
    out.push({
      stage: truthy(x.stage) ? String(x.stage) : "",
      round: "round" in x ? x.round : 0,
      kind: "kind" in x ? x.kind : "feedback",
      time,
      text: "text" in x ? x.text : "",
      via: "via" in x ? x.via : "html",
      file: file.name,
      processed: processed.has(file.name),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// the stage report (pes.py `stage_md`)

function item_order(item: Dict): number | string {
  const value = "order" in item ? item.order : item.id;
  return typeof value === "number" || typeof value === "string" ? value : py_str(value);
}

function compare_keys(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function sorted_items(items: Dict[]): Dict[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => compare_keys(item_order(a.item), item_order(b.item)) || compare_keys(a.item.id, b.item.id) || a.index - b.index)
    .map((entry) => entry.item);
}

function source_key(source: Dict): string | undefined {
  const value = por(source, "url", por(source, "title", undefined));
  return value === undefined || value === null ? undefined : py_str(value);
}

function cell(value: unknown): string {
  return py_str(truthy(value) ? value : "").replace(/\|/g, "/").replace(/\n/g, " ");
}

export function stage_markdown(p: Dict, stage: string, feedback: ReadonlyArray<FeedbackEntry>, built: string, version_no: number | null = null): string {
  const st = p.stages[stage] as Dict;
  const items = (st.items as Dict[]).filter((item) => item.status !== "removed");
  const srcs: Dict[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    for (const x of (item.sources ?? []) as Dict[]) {
      const key = source_key(x);
      if (key !== undefined && key !== "" && !seen.has(key)) {
        seen.add(key);
        srcs.push(x);
      }
    }
  }
  const ok = srcs.filter((x) => VERIFIED.has(x.method)).length;
  const sidx = new Map<string, number>();
  srcs.forEach((x, index) => sidx.set(source_key(x) as string, index + 1));
  const topic = pget(p, "topic", "");
  const L: string[] = [
    `# ${topic} — ${REPORT_NAME[stage]}`,
    "",
    `- 단계: ${LABEL[stage]} · 라운드 ${py_str(st.round)}회 · 승인 ${py_str(por(st, "approved_at", "미승인"))}`,
    `- 항목 ${items.length}개 · 출처 ${srcs.length}개 (원문 확인 ${ok}개)`,
    `- 작성 ${built} · PES${version_no === null ? "" : ` (버전 ${version_no})`}`,
    "",
  ];
  L.push("## 1. 요약", "", py_str(por(st, "summary", `(요약 없음 — stages.${stage}.summary 를 채우세요)`)).trim(), "");
  const { lab, opt } = qlabels(stage);
  const sets = Object.entries(is_dict(st.settings) ? st.settings : {}).filter(([, v]) => !(v === null || v === "" || (Array.isArray(v) && v.length === 0) || (is_dict(v) && Object.keys(v).length === 0)));
  if (sets.length > 0) {
    L.push("## 2. 이 단계에서 정한 것 (시작 질문 답)", "", "| 질문 | 답 |", "|---|---|");
    for (const [k, v] of sets) {
      const label = lab.has(k) ? lab.get(k) : (EXTRA_LABELS[k] ?? k);
      L.push(`| ${py_str(label)} | ${show_val(k, v, opt).replace(/\|/g, "/")} |`);
    }
    L.push("");
  }
  L.push("## 3. 결과", "");
  const groups = new Map<string, Dict[]>();
  for (const item of sorted_items(items)) {
    const key = truthy(item.kind) ? String(item.kind) : "";
    const list = groups.get(key) ?? [];
    groups.set(key, list);
    list.push(item);
  }
  let n = 0;
  for (const [kind, list] of groups) {
    n += 1;
    L.push(`### 3.${n} ${KIND_TXT[kind] ?? (kind === "" ? "항목" : kind)} (${list.length})`, "");
    for (const it of list) {
      L.push(`#### #${py_str(it.id)} ${py_str(it.title)}`, "");
      if (truthy(it.question)) L.push(`- 질문: ${py_str(it.question)}`);
      const meta: string[] = [];
      if (truthy(it.confidence)) meta.push(`신뢰도 ${py_str(it.confidence)}`);
      if (truthy(it.verdict)) meta.push(`판정 ${py_str(it.verdict)}`);
      if (truthy(it.updated_round)) meta.push(`R${py_str(it.updated_round)} 갱신`);
      const links = is_dict(it.links) ? it.links : {};
      const lk = Object.entries(links)
        .filter(([, b]) => truthy(b))
        .map(([a, b]) => `${LABEL[a] ?? a} ${(Array.isArray(b) ? b : [b]).map((x: unknown) => `#${py_str(x)}`).join(", ")}`)
        .join("; ");
      if (meta.length > 0) L.push(`- ${meta.join(" · ")}`);
      if (lk !== "") L.push(`- 연결: ${lk}`);
      const refs: string[] = [];
      for (const sx of (it.sources ?? []) as Dict[]) {
        const k2 = source_key(sx);
        if (k2 !== undefined && sidx.has(k2)) refs.push(`[${sidx.get(k2)}${VERIFIED.has(sx.method) ? "" : "·미확인"}]`);
      }
      if (refs.length > 0) {
        L.push(`- 근거 출처: ${refs.join(" ")} (아래 「출처」 번호, 원문 확인 ${refs.filter((r) => !r.includes("미확인")).length}/${refs.length})`);
      } else if (!["rq", "chapter", "schedule", "topic"].includes(it.kind) || stage !== "plan") {
        L.push("- 근거 출처: 없음 ⚠ — 이 항목의 내용은 출처로 뒷받침되지 않았다");
      }
      L.push("");
      if (truthy(it.summary)) L.push(py_str(it.summary).trim(), "");
      if (truthy(it.details) && py_str(it.details).trim() !== py_str(por(it, "summary", "")).trim()) {
        L.push(py_str(it.details).trim(), "");
      }
      if (truthy(it.stats)) {
        L.push("| 지표 | 값 | 기준 | 원표 |", "|---|---|---|---|");
        for (const x of it.stats as Dict[]) {
          const t = truthy(x.tblId) ? `${py_str(x.orgId)}/${py_str(x.tblId)}` : py_str(por(x, "method", ""));
          L.push(`| ${pget(x, "name", "")} | ${pget(x, "value", "")} ${pget(x, "unit", "")} | ${pget(x, "period", "")} | ${t} |`);
        }
        L.push("");
      }
      for (const c of (it.conflicts ?? []) as unknown[]) L.push(`- ⚠ 충돌: ${typeof c === "string" ? c : py_json(c)}`);
      if (truthy(it.conflicts)) L.push("");
    }
  }
  const fbs = feedback.filter((f) => f.stage === stage && ["review", "feedback", "approve"].includes(String(f.kind)));
  if (fbs.length > 0 || truthy(st.history)) {
    L.push("## 4. 라운드 경과와 사용자 결정", "");
    for (const h of (st.history ?? []) as unknown[]) L.push(`- ${py_str(h)}`);
    for (const f of fbs) {
      const t = py_str(truthy(f.text) ? f.text : "").trim().replace(/\n/g, " / ");
      if (t !== "") L.push(`- R${py_str(f.round)} ${py_str(f.kind)}: ${head(t, 400)}`);
    }
    L.push("");
  }
  if (truthy(st.carry_over)) {
    L.push("## 4-1. 남은 일 — 다음 단계로 넘김", "", "승인 때 끝내지 못한 할 일이다. 다음 단계 첫 라운드에서 먼저 처리한다.", "");
    for (const c of st.carry_over as Dict[]) L.push(`- #${pget(c, "item")} ${pget(c, "title", "")}: ${pget(c, "request", "")}`);
    L.push("");
  }
  const qas = (Array.isArray(st.qa) ? st.qa : []) as Dict[];
  const rlog = new Map<number, Dict>();
  for (const r of (Array.isArray(st.review_log) ? st.review_log : []) as Dict[]) rlog.set(Number(por(r, "round", 0)) || 0, r);
  if (qas.length > 0 || rlog.size > 0) {
    L.push("## 5. 검토 기록 (자체 점검 → 독립 QC/QA 검토)", "");
    const ordered = qas.map((q, index) => ({ q, index })).sort((a, b) => (Number(por(a.q, "round", 0)) || 0) - (Number(por(b.q, "round", 0)) || 0) || a.index - b.index);
    for (const { q } of ordered) {
      const r = Number(por(q, "round", 0)) || 0;
      const rv = rlog.get(r) ?? {};
      L.push(`### R${r}`, "");
      if (truthy(rv.questions)) {
        L.push(`- 자체 점검: 질문 ${(rv.questions as unknown[]).length}개 — ${(rv.questions as Dict[]).map((qq) => `[${py_str(por(qq.gap, "kind", "-"))}] ${pget(qq, "label", null)}`).join("; ")}`);
      }
      const sc = (Array.isArray(q.spot_checks) ? q.spot_checks : []) as Dict[];
      L.push(`- 독립 검토(pes:reviewer): 판정 **${pget(q, "verdict", null)}** — ${pget(q, "summary", "")}`);
      if (sc.length > 0) L.push(`- 표본 대조: ${sc.filter((c) => c.result === "match").length}/${sc.length} 일치`);
      L.push("");
      const fs = [...((Array.isArray(q.qc) ? q.qc : []) as Dict[]), ...((Array.isArray(q.qa) ? q.qa : []) as Dict[])];
      if (fs.length > 0) {
        L.push("| 구분 | 항목 | 심각도 | 지적 | 근거 | 조치 권고 |", "|---|---|---|---|---|---|");
        for (const f of fs) L.push(`| ${cell(f.id)} | #${cell(f.item)} | ${cell(f.severity)} | ${cell(f.finding)} | ${cell(f.evidence)} | ${cell(f.recommendation)} |`);
        L.push("");
      }
      if (sc.length > 0) {
        L.push("| 항목 | 대조한 주장 | 출처 | 결과 | 메모 |", "|---|---|---|---|---|");
        for (const c of sc) L.push(`| #${cell(c.item)} | ${cell(c.claim)} | ${cell(c.source)} | ${cell(c.result)} | ${cell(c.note)} |`);
        L.push("");
      }
      if (truthy(q.missed_by_self_review)) L.push(`- 자체 점검이 놓친 것: ${(q.missed_by_self_review as unknown[]).map(py_str).join("; ")}`, "");
      if (truthy(q.evidence_gaps)) {
        L.push(`- 근거가 부족한 문장: ${(q.evidence_gaps as Dict[]).map((g) => `#${pget(g, "item")} ${pget(g, "statement")} → ${pget(g, "needed")}`).join("; ")}`, "");
      }
    }
  }
  if (srcs.length > 0) {
    L.push(`## ${qas.length > 0 || rlog.size > 0 ? 6 : 5}. 출처`, "");
    srcs.forEach((x, index) => {
      const mark = VERIFIED.has(x.method) ? "확인됨" : "미확인";
      L.push(`${index + 1}. ${py_str(por(x, "title", x.url))}${truthy(x.url) ? ` — ${py_str(x.url)}` : ""}${truthy(x.date) ? ` (${py_str(x.date)})` : ""} [${mark}]`);
    });
    L.push("");
  }
  return `${L.join("\n")}\n`;
}

export interface StageReportFiles {
  markdown: string;
  html: string;
  eli5_html: string | null;
}

/** The stage report page (pes.py `cmd_report`): report.md text and the stage-report.html built from it. */
export function stage_report(
  p: Dict,
  stage: string,
  feedback: ReadonlyArray<FeedbackEntry>,
  built: string,
  eli5: Dict | null = null,
  version_no: number | null = null,
): StageReportFiles {
  const st = p.stages[stage] as Dict;
  const markdown = stage_markdown(p, stage, feedback, built, version_no);
  const title = `${pget(p, "topic", "")} — ${REPORT_NAME[stage]}`;
  const meta: Dict = {
    title,
    stage,
    label: LABEL[stage],
    name: REPORT_NAME[stage],
    md: markdown,
    built,
    round: st.round,
    approved_at: "approved_at" in st ? st.approved_at : null,
  };
  const html = fill_template("stage-report.html", title, meta);
  let eli5_html: string | null = null;
  if (eli5 !== null) {
    const e: Dict = { ...eli5 };
    if (!("title" in e)) e.title = REPORT_NAME[stage];
    e.stage_label = LABEL[stage];
    e.topic = pget(p, "topic", "");
    e.name = REPORT_NAME[stage];
    eli5_html = fill_template("eli5.html", String(e.title), e);
  }
  return { markdown, html, eli5_html };
}

// ---------------------------------------------------------------------------
// manuscript assembly and the final web report (pes.py `cmd_assemble`, `cmd_web`)

export interface AssembledSource {
  n: number;
  title: unknown;
  url: unknown;
  date: unknown;
  method: unknown;
  verified: boolean;
}

export interface Assembly {
  markdown: string;
  sources: AssembledSource[];
  sections: number;
  footnotes: number;
  warnings: string[];
}

export function assemble_manuscript(p: Dict): Assembly {
  const write = p.stages.write as Dict;
  const items = sorted_items((write.items as Dict[]).filter((item) => item.status !== "removed"));
  const out: string[] = [`# ${pget(p, "topic", "")}`, ""];
  const notes: string[] = [];
  const key = new Map<string, number>();
  const sources: AssembledSource[] = [];
  const warnings: string[] = [];
  if (truthy(p.executive_summary)) out.push("## 요약", "", py_str(p.executive_summary), "");
  for (const it of items) {
    const srcs = ((it.sources ?? []) as Dict[]).filter((x) => x !== null);
    const sub = (match: string, digits: string): string => {
      const k = Number(digits);
      if (!(k >= 1 && k <= srcs.length)) return match;
      const s = srcs[k - 1] as Dict;
      // The same address with a different title (an article, a document) is a different footnote.
      const ident = `${py_str(por(s, "url", ""))}\u0000${py_str(por(s, "title", ""))}`;
      if (!key.has(ident)) {
        key.set(ident, key.size + 1);
        sources.push({
          n: key.get(ident) as number,
          title: "title" in s ? s.title : "",
          url: "url" in s ? s.url : "",
          date: "date" in s ? s.date : "",
          method: "method" in s ? s.method : "",
          verified: VERIFIED.has(s.method),
        });
        notes.push(`[^${key.get(ident)}]: ${pget(s, "title", "")}${truthy(s.url) ? `, ${py_str(s.url)}` : ""}${truthy(s.date) ? ` (${py_str(s.date)})` : ""}`);
      }
      return `[^${key.get(ident)}]`;
    };
    const details = truthy(it.details) ? py_str(it.details) : "";
    const bad = [...new Set([...details.matchAll(/\[\^(\d+)\]/g)].map((m) => Number(m[1])).filter((k) => !(k >= 1 && k <= srcs.length)))].sort((a, b) => a - b);
    if (bad.length > 0) {
      warnings.push(`경고: #${py_str(it.id)} 각주 번호 [${bad.join(", ")}] 가 이 장 출처(${srcs.length}개) 범위 밖 — 원고와 sources 순서를 확인`);
    }
    out.push(details.replace(/\[\^(\d+)\]/g, sub).trim(), "");
  }
  if (truthy(p.conclusion)) out.push("## 결론", "", py_str(p.conclusion), "");
  if (notes.length > 0) out.push("", ...notes);
  return { markdown: `${out.join("\n")}\n`, sources, sections: items.length, footnotes: notes.length, warnings };
}

export interface FinalHtmlInput {
  topic: string;
  markdown: string;
  appendix: string | null;
  sources: unknown[];
  cover: Dict;
  built: string;
}

export function final_report_html(input: FinalHtmlInput): string {
  let md = input.markdown;
  // The appendix (statistics tables, calculation notes, open tasks) goes after the body, before the footnotes.
  if (input.appendix !== null) md = `${md.replace(/\s+$/, "")}\n\n${input.appendix}`;
  const data: Dict = {
    topic: input.topic,
    md,
    sources: input.sources,
    cover: input.cover,
    built: input.built,
    built_date: input.built.slice(0, 10),
  };
  const title = truthy(input.cover.title) ? String(input.cover.title) : input.topic || "최종 보고서";
  return fill_template("final-report.html", title, data);
}

// ---------------------------------------------------------------------------
// comparing a regenerated report with an old one (validate_import)

const WRITTEN_AT_LINE = /작성 \d{4}-\d{2}-\d{2} \d{2}:\d{2} · PES(?: \(버전 \d+\))?/g;
const BUILT_FIELD = /"built": "\d{4}-\d{2}-\d{2} \d{2}:\d{2}"/g;

/** The "작성 <시각>" line and the page's built time are not part of the comparison. */
export function without_report_time(text: string): string {
  return text.replace(WRITTEN_AT_LINE, "작성 <시각> · PES").replace(BUILT_FIELD, '"built": "<시각>"');
}

/** Format epoch milliseconds like pes.py `now()`: local "YYYY-MM-DD HH:MM". */
export function local_stamp(ms: number): string {
  const d = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

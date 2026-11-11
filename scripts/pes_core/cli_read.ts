// pes.ts read and report commands: pending, digest, show, report, assemble, web (SEL-77 / PR26b-2).
// The text and the exit codes are 0.15's; the state is read from the database (core calls only). The files the skills and the person
// look at — reports/<stage>/report.md|html|eli5.html and out/report.md|sources.json|report.html — are written into the project folder
// like 0.15 wrote them (UTF-8, LF), from the very bytes the core stored as the new version (so the folder and the database agree).

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { build_index, legacy_project } from "./cli_screens.ts";
import { load_for_read } from "./cli_legacy_read.ts";
import { need_project, read_json_file } from "./cli_records.ts";
import { LABEL, STAGES, arg_at, bridge, die, first_line, is_record, missing_args, pdir, say, stage_arg, write_text } from "./cli_support.ts";
import { REPORT_NAME, VERIFIED, py_json, py_str, truthy } from "./report.ts";
import { output } from "./cli_support.ts";

type Dict = Record<string, any>;

const FMT_TXT: Record<string, string> = { md: "마크다운", html: "웹 보고서", eli5: "그림 설명(eli5)", docx: "Word", hwpx: "HWPX", pdf: "PDF", pptx: "발표자료", json: "데이터" };

/** The project as 0.15's `load` shows it: the database read model, or an unmigrated folder's own project.json. */
async function read_state(d: string): Promise<{ slug: string; project: Dict; pending: Dict[]; legacy: boolean }> {
  const state = await load_for_read(d);
  return { slug: state.slug, project: legacy_project(state.project) as Dict, pending: state.pending as Dict[], legacy: state.legacy };
}

/** Python's `int(text)` for the arguments of `--round`; a non-number ended 0.15 in a ValueError traceback (D11: one plain line). */
function int_arg(text: string | undefined, flag: string, command: string): number {
  if (text === undefined) return missing_args(command);
  if (!/^\s*[-+]?\d+\s*$/.test(text)) return die(`${command}: ${flag} 값은 정수여야 합니다: ${text}`, 1);
  return Number.parseInt(text, 10);
}

function py_dumps_indent(value: unknown): string {
  return JSON.stringify(value, null, 1);
}

// ---------------------------------------------------------------- pending

function answer_names(opts: string[]): string[] {
  return opts.filter((a) => a !== "--show").map((a) => a.split(/[\\/]/).pop() as string);
}

export async function cmd_pending(args: string[]): Promise<void> {
  const d = pdir(arg_at(args, 0, "pending"));
  const { slug, pending, legacy } = await read_state(d);
  if (args.slice(1).includes("--show")) {
    const names = answer_names(args.slice(1));
    const wanted = names.length > 0 ? names : pending.map((e) => String(e.name).split(/[\\/]/).pop() as string);
    if (wanted.length === 0) return;
    let answers: Array<{ name: string; text: string }>;
    if (legacy) {
      answers = wanted.map((n) => {
        const file = join(d, "feedback", n);
        if (!n.endsWith(".json") || !existsSync(file) || !statSync(file).isFile()) return die(`받은 답이 없습니다: ${n}`, 2);
        return { name: n, text: readFileSync(file, "utf8") };
      });
    } else {
      answers = ((await bridge("answer_texts", slug, { names: wanted })).answers as Array<{ name: string; text: string }>) ?? [];
    }
    for (const a of answers) {
      if (answers.length > 1) say(`=== ${a.name} ===`);
      output.raw(a.text.endsWith("\n") ? a.text : `${a.text}\n`);
    }
    return;
  }
  for (const e of pending) say(String(e.name));
}

// ---------------------------------------------------------------- digest

export async function cmd_digest(args: string[]): Promise<void> {
  const d = pdir(arg_at(args, 0, "digest"));
  const s = stage_arg(args[1] === undefined ? missing_args("digest") : args[1]);
  const { project } = await read_state(d);
  const st = project.stages[s] as Dict;
  const at = args.indexOf("--round");
  const rnd = at >= 0 ? int_arg(args[at + 1], "--round", "digest") : null;
  const items = ((st.items as Dict[]) ?? []).filter((i) => i.status !== "removed" && (rnd === null || i.updated_round === rnd));
  say(`[${LABEL[s]} R${py_str(st.round)}] 항목 ${items.length}개 · 상태 ${py_str(st.status)}`);
  for (const it of [...items].sort((a, b) => Number(a.id) - Number(b.id))) {
    const src: Dict[] = Array.isArray(it.sources) ? it.sources.filter(is_record) : [];
    const ok = src.filter((x) => VERIFIED.has(String(x.method))).length;
    const links = is_record(it.links) ? it.links : {};
    const lk = Object.entries(links)
      .filter(([, b]) => truthy(b))
      .map(([a, b]) => `${a}:${(b as unknown[]).map((x) => py_str(x)).join(",")}`)
      .join(" ");
    say(`\n#${py_str(it.id)} ${py_str(it.title)} [${py_str(it.kind ?? null)}/${py_str(it.status ?? null)}/R${py_str(it.updated_round ?? null)}] 신뢰도 ${truthy(it.confidence) ? py_str(it.confidence) : "-"} · 출처 ${src.length}(원문 ${ok}) · ${lk}`);
    if (truthy(it.summary)) say(`  요약: ${first_line(it.summary, 300)}`);
    const stats: Dict[] = Array.isArray(it.stats) ? it.stats : [];
    for (const x of stats.slice(0, 12)) {
      say(`  수치: ${py_str(x.name ?? null)} = ${py_str(x.value ?? null)} ${truthy(x.unit) ? py_str(x.unit) : ""} (${truthy(x.period) ? py_str(x.period) : "-"}; ${truthy(x.method) ? py_str(x.method) : "-"})`);
    }
    if (stats.length > 12) say(`  수치: … 외 ${stats.length - 12}개`);
    for (const c of Array.isArray(it.conflicts) ? it.conflicts : []) say(`  충돌: ${first_line(typeof c === "string" ? c : py_json(c), 200)}`);
    if (truthy(it.verdict)) say(`  판정: ${py_str(it.verdict)}`);
    if (truthy(it.request)) say(`  요청: ${first_line(it.request, 160)}`);
    for (const u of Array.isArray(it.user_links) ? it.user_links.filter(is_record) : []) {
      say(`  사용자 링크[${truthy(u.status) ? py_str(u.status) : "todo"}]: ${py_str(u.url ?? null)}${truthy(u.memo) ? ` — ${py_str(u.memo)}` : ""}`);
    }
  }
  const suggestions: unknown[] = Array.isArray(st.suggestions) ? st.suggestions : [];
  if (suggestions.length > 0) {
    say(`\n남은 질문·제안 ${suggestions.length}개:`);
    for (const x of suggestions.slice(-15)) say(`  - ${first_line(typeof x === "string" ? x : (x as Dict).text, 160)}`);
  }
}

// ---------------------------------------------------------------- show

const SHOW_STAGE_FIELDS = new Set(["changes", "carry_over", "settings", "review"]);

export async function cmd_show(args: string[]): Promise<void> {
  const d = pdir(arg_at(args, 0, "show"));
  const s = stage_arg(args[1] === undefined ? missing_args("show") : args[1]);
  const { project } = await read_state(d);
  let rest = args.slice(2);
  let fields: string[] | null = null;
  const k = rest.indexOf("--fields");
  if (k >= 0) {
    const value = rest[k + 1];
    if (value === undefined) return missing_args("show");
    fields = value.split(",");
    rest = [...rest.slice(0, k), ...rest.slice(k + 2)];
  }
  const ids = new Set(rest.filter((x) => /^\d+$/.test(x)).map(Number));
  const st = project.stages[s] as Dict;
  const wanted = fields ?? [];
  if (wanted.length > 0 && ids.size === 0 && wanted.every((f) => SHOW_STAGE_FIELDS.has(f))) {
    say(py_dumps_indent(Object.fromEntries(wanted.map((f) => [f, st[f] ?? null]))));
    return;
  }
  const items: Dict[] = (st.items as Dict[]) ?? [];
  if (ids.size === 0 && wanted.length === 0) {
    const summary: Dict = {};
    for (const [key, value] of Object.entries(st)) if (key !== "items") summary[key] = value;
    summary.items = items.map((i) => `#${py_str(i.id)} ${py_str(i.title)} [${py_str(i.kind ?? null)}/${py_str(i.status ?? null)}]`);
    say(py_dumps_indent(summary));
    return;
  }
  const out: Dict[] = [];
  for (const it of items) {
    if (ids.size > 0 && !ids.has(Number(it.id))) continue;
    out.push(wanted.length > 0 ? Object.fromEntries(["id", "title", ...wanted].map((key) => [key, it[key] ?? null])) : it);
  }
  say(py_dumps_indent(out));
}

// ---------------------------------------------------------------- report, assemble, web

function report_formats(p: Dict): string[] {
  const formats = is_record(p.settings) ? p.settings.stage_reports : undefined;
  return Array.isArray(formats) && formats.length > 0 ? formats.map(String) : ["md", "html", "eli5"];
}

/** One stored file of the newest version, as text (UTF-8 bytes the core wrote). */
async function stored_text(slug: string, path: string): Promise<string> {
  const data = await bridge("report_file", slug, { path });
  return Buffer.from(String(data.bytes_b64), "base64").toString("utf8");
}

function folder_files(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => statSync(join(dir, name)).isFile())
      .sort();
  } catch {
    return [];
  }
}

const REPORT_SUFFIXES = new Set([".md", ".html", ".docx", ".hwpx", ".pdf", ".pptx"]);

export async function cmd_report(args: string[]): Promise<void> {
  const d = pdir(arg_at(args, 0, "report"));
  const s = stage_arg(args[1] === undefined ? missing_args("report") : args[1]);
  const slug = await need_project(d, "읽기");
  const rd = join(d, "reports", s);
  // eli5.json is read only: the person's / the skill's picture description (0.15: rendered into eli5.html when it exists)
  const eli5_file = join(rd, "eli5.json");
  const eli5 = existsSync(eli5_file) ? read_json_file(eli5_file, "eli5.json") : null;
  const data = await bridge("report", slug, { stage: s, eli5, dir: d, plain: true });
  mkdirSync(rd, { recursive: true });
  for (const f of (data.files as Array<{ name: string }>) ?? []) write_text(join(rd, f.name), await stored_text(slug, `reports/${s}/${f.name}`));
  const state = (await bridge("read_project", slug)).project as Dict;
  const formats = report_formats(state);
  const reg: Array<{ format: string; label: string; path: string }> = [];
  for (const name of folder_files(rd)) {
    const dot = name.lastIndexOf(".");
    const suffix = dot >= 0 ? name.slice(dot).toLowerCase() : "";
    if (!REPORT_SUFFIXES.has(suffix) || name.startsWith(".")) continue;
    const stem = dot >= 0 ? name.slice(0, dot) : name;
    const format = stem === "eli5" ? "eli5" : suffix.slice(1);
    reg.push({ format, label: FMT_TXT[format] ?? format, path: relative(d, join(rd, name)).split(sep).join("/") });
  }
  const notes: string[] = [];
  if (eli5 === null && formats.includes("eli5")) notes.push(`eli5: ${eli5_file} 를 써야 합니다 (스키마는 pes:core 「단계 보고서」) — 쓴 뒤 report 를 다시 실행`);
  const have = new Set(reg.map((r) => r.format));
  for (const x of formats) if (!have.has(x) && x !== "eli5") notes.push(`${x}: 아직 없음 — report.md 로 해당 스킬을 써서 ${rd}/report.${x} 로 만든 뒤 report 를 다시 실행`);
  await build_index(d, slug);
  say([`${REPORT_NAME[s]}: ${reg.map((r) => `${r.label} ${r.path}`).join(", ")}`, ...notes].join("\n"));
}

function print_assemble_line(d: string, data: Dict): void {
  say(`${join(d, "out", "report.md")}  (장·절 ${Number(data.sections)}개, 각주 ${Number(data.footnotes)}개)`);
}

async function write_out_files(d: string, slug: string, names: string[]): Promise<void> {
  mkdirSync(join(d, "out"), { recursive: true });
  for (const name of names) write_text(join(d, "out", name), await stored_text(slug, `out/${name}`));
}

function warn_lines(data: Dict): void {
  for (const w of (data.warnings as string[] | undefined) ?? []) process.stderr.write(`${w}\n`);
}

export async function cmd_assemble(args: string[]): Promise<void> {
  const d = pdir(arg_at(args, 0, "assemble"));
  const slug = await need_project(d, "읽기");
  const data = await bridge("assemble", slug, { dir: d });
  await write_out_files(d, slug, ["report.md", "sources.json"]);
  warn_lines(data);
  print_assemble_line(d, data);
}

export async function cmd_web(args: string[]): Promise<void> {
  const d = pdir(arg_at(args, 0, "web"));
  const slug = await need_project(d, "읽기");
  const od = join(d, "out");
  const cover_file = join(od, "cover.json");
  const cover = existsSync(cover_file) ? read_json_file(cover_file, "out/cover.json") : {};
  const appendix_file = join(od, "appendix.md");
  const appendix = existsSync(appendix_file) ? readFileSync(appendix_file, "utf8").replace(/\r\n?/g, "\n") : null;
  const assemble = !existsSync(join(od, "report.md")) || args.includes("--assemble");
  const data = await bridge("web", slug, { assemble, cover: is_record(cover) ? cover : {}, appendix, dir: d });
  await write_out_files(d, slug, ["report.md", "sources.json", "report.html"]);
  warn_lines(data);
  if (assemble) print_assemble_line(d, data);
  const has_cover = is_record(cover) && Object.keys(cover).length > 0;
  say(`${join(od, "report.html")}  (출처 ${Number(data.sources)}개 · 확인됨 ${Number(data.verified)}개${has_cover ? "" : " · 표지 정보 없음: out/cover.json 을 쓰면 연구진·기관·발주처가 표지에 나온다"})`);
}


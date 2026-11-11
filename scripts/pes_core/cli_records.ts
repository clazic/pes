// pes.ts write commands, part 1: init, merge, mark, chat, note, qa-brief, qa, lock, unlock, status (SEL-71).
// 0.15 text and exit codes; the state lives in the database (core calls only).

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { server_url } from "./cli_home.ts";
import {
  LABEL,
  STAGES,
  Die,
  arg_at,
  bridge,
  die,
  first_line,
  is_record,
  missing_args,
  norm_text,
  now,
  pdir,
  say,
  stage_arg,
} from "./cli_support.ts";

// ---------------------------------------------------------------- project lookup (the 0.15 `load(d)` rule)

/** The slug of a project folder: the folder's name (0.15 `pdir` rule). */
export const slug_of = (d: string): string => basename(d);

async function db_slugs(): Promise<Set<string>> {
  try {
    return new Set(((await bridge("slugs")).slugs as string[] | undefined) ?? []);
  } catch (error) {
    if (error instanceof Die) return new Set();
    throw error;
  }
}

export async function project_exists(d: string): Promise<boolean> {
  return (await db_slugs()).has(slug_of(d));
}

/** `load(d)`: the project must exist. A 0.15 folder the database does not serve yet is refused with the migration notice. */
export async function need_project(d: string, what = "쓰기"): Promise<string> {
  const slug = slug_of(d);
  if ((await db_slugs()).has(slug)) return slug;
  if (existsSync(join(d, "project.json"))) {
    die(`${what}: ${slug} 는 아직 DB 로 이전하지 않은 옛 project.json 프로젝트라 쓸 수 없습니다 — 먼저 이전(import → 검증 → 활성화)하세요. 읽기(status·digest·show 등)는 그대로 됩니다`, 2);
  }
  return die(`project.json 없음: ${d}`, 1);
}

/** Reads a JSON file the way 0.15 would: a plain Korean line instead of a traceback, exit 1 (the traceback's exit; D11). */
export function read_json_file(path: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return die(`${what}이 없습니다: ${path}`, 1);
    return die(`${what}을 읽지 못했습니다: ${path} (${code ?? "읽기 오류"})`, 1);
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    return die(`${what}이 올바른 JSON이 아닙니다: ${path} (${(error as Error).message})`, 1);
  }
}

// ---------------------------------------------------------------- init

function library_dict(src: string): Record<string, unknown> {
  const file = join(src, "state.json");
  if (!existsSync(file)) die(`가져올 state.json 없음: ${file}`, 1);
  const state = read_json_file(file, "가져올 state.json");
  if (!is_record(state)) die(`가져올 state.json 은 JSON 객체여야 합니다: ${file}`, 1);
  const items: Record<string, unknown>[] = [];
  const given = Array.isArray(state.items) ? state.items : [];
  for (const raw of given) {
    if (!is_record(raw) || raw.status === "removed") continue;
    const item: Record<string, unknown> = { ...raw };
    const shots = Array.isArray(raw.shots) ? raw.shots : [];
    item.shots = shots.map((shot) => (typeof shot === "string" && !shot.startsWith("library/") ? `library/${shot}` : shot));
    items.push(item);
  }
  return {
    source: src,
    imported: now(),
    round: state.round ?? null,
    topic: state.topic ?? null,
    settings: state.settings ?? {},
    items,
    suggestions: state.suggestions ?? [],
    warnings: state.warnings ?? [],
  };
}

function copy_library_shots(d: string, src: string): void {
  const from = join(src, "shots");
  if (!existsSync(from)) return;
  const to = join(d, "library", "shots");
  mkdirSync(join(d, "library"), { recursive: true });
  if (!existsSync(to)) cpSync(from, to, { recursive: true });
}

export async function cmd_init(args: string[]): Promise<void> {
  if (args.length === 0) die("사용: init <dir> --topic 주제 [--slug s] [--import 폴더]", 1);
  const d = pdir(args[0] as string);
  const opt: Record<string, string> = {};
  const rest = args.slice(1);
  while (rest.length > 0) {
    const k = rest.shift() as string;
    if ((k === "--topic" || k === "--slug" || k === "--import") && rest.length > 0) opt[k.slice(2)] = rest.shift() as string;
    else die(`알 수 없는 인자: ${k}`, 1);
  }
  if ((await project_exists(d)) || existsSync(join(d, "project.json"))) {
    die(`이미 프로젝트가 있습니다: ${d}/project.json  (이어하기는 ask-prep ${d} resume)`, 2);
  }
  if (opt.topic === undefined || opt.topic === "") die("--topic 필요", 1);
  const slug = opt.slug !== undefined && opt.slug !== "" ? opt.slug : slug_of(d);
  if (slug !== slug_of(d)) {
    // later commands find the project by its folder's name: another name would hide the project that was just made
    die(`--slug(${slug})는 폴더 이름(${slug_of(d)})과 같아야 합니다 — 폴더 이름으로 프로젝트를 찾습니다`, 2);
  }
  const lib = opt.import !== undefined && opt.import !== "" ? library_dict(pdir(opt.import)) : null;
  // the database's checks (duplicate name, a library it refuses) first; the folder and the library's files only after they pass
  await bridge("init", null, { slug, topic: opt.topic, library: lib, any_name: true });
  mkdirSync(d, { recursive: true });
  if (opt.import !== undefined && opt.import !== "") copy_library_shots(d, pdir(opt.import));
  for (const sub of ["feedback", "ask", "snapshots", "shots", "out"]) mkdirSync(join(d, sub), { recursive: true });
  const log = join(d, "feedback.log");
  if (!existsSync(log)) writeFileSync(log, "", "utf8");
  say(join(d, "project.json"));
  if (lib !== null) say(`참고자료로 가져옴: 항목 ${(lib.items as unknown[]).length}개 (R${String(lib.round)}까지, ${String(lib.source)})`);
}

// ---------------------------------------------------------------- merge

export async function cmd_merge(args: string[]): Promise<void> {
  const d = pdir(arg_at(args, 0, "merge"));
  const s = stage_arg(args[1] === undefined ? missing_args("merge") : args[1]);
  const slug = await need_project(d);
  const results: Record<string, unknown>[] = [];
  for (const f of args.slice(2)) {
    const raw = read_json_file(f, "병합할 결과 파일");
    for (const item of Array.isArray(raw) ? raw : [raw]) {
      if (!is_record(item)) die(`merge: 결과 항목은 JSON 객체여야 합니다: ${f}`, 2);
      const r: Record<string, unknown> = { ...item };
      for (const k of ["title", "kind", "question", "summary", "details", "confidence", "verify", "order", "verdict", "path", "request"]) {
        if (k in r && r[k] !== null && r[k] !== undefined && r[k] !== "") r[k] = norm_text(r[k]);
      }
      results.push(r);
    }
  }
  const data = await bridge("merge", slug, { stage: s, results, v015: true, dir: d });
  say(`${LABEL[s]}: ${String(data.merged)}건 병합`);
}

// ---------------------------------------------------------------- mark, chat, note

export async function cmd_mark(args: string[]): Promise<void> {
  const d = pdir(arg_at(args, 0, "mark"));
  const slug = await need_project(d);
  const names = args.slice(1).map((f) => basename(f));
  if (names.length > 0) await bridge("mark", slug, { names, dir: d });
  say(`처리 완료 표시 ${args.length - 1}개`);
}

export async function cmd_chat(args: string[]): Promise<void> {
  const d = pdir(arg_at(args, 0, "chat"));
  const s = stage_arg(args[1] === undefined ? missing_args("chat") : args[1]);
  const text = args[2] === undefined ? missing_args("chat") : args[2];
  const kind = args[3] ?? "feedback";
  const slug = await need_project(d);
  const data = await bridge("chat", slug, { stage: s, text, kind, dir: d });
  say(`채팅 입력 기록: ${String(data.object_id)}`);
}

export async function cmd_note(args: string[]): Promise<void> {
  const d = pdir(arg_at(args, 0, "note"));
  const slug = await need_project(d);
  const text = args.slice(1).join(" ").trim();
  const data = await bridge("note", slug, { text, allow_blank: true, dir: d });
  say(`인계 메모 ${String(data.note_count)}개`);
}

// ---------------------------------------------------------------- qa-brief, qa

const STAGE_GOAL: Record<string, string> = {
  plan: "연구 질문·목차·조사 항목·일정이 주제와 사용자 답에 맞고 서로 연결되어 있는가",
  research: "기획의 조사 질문에 출처 있는 사실로 답했는가 (원문 확인·수치 정합·충돌 표시)",
  analyze: "조사 사실에서 쟁점·표·시사점을 근거 연결과 함께 끌어냈는가",
  write: "원고의 모든 주장·수치가 분석·조사 근거와 각주로 이어지는가, 목차·분량·문체",
  verify: "핵심 주장 검증이 충분하고 판정이 원문에 근거하는가",
  publish: "산출물이 승인된 원고와 같고 형식·부록·근거 표기가 빠짐없는가",
};

export async function cmd_qa_brief(args: string[]): Promise<void> {
  const d = pdir(arg_at(args, 0, "qa-brief"));
  const s = stage_arg(args[1] === undefined ? missing_args("qa-brief") : args[1]);
  const slug = await need_project(d);
  const info = await bridge("qa-data", slug, { stage: s });
  const rnd = Number(info.round_no);
  const rd = join(d, "rounds", `${s}-R${rnd}`);
  const lines: string[] = [`[${LABEL[s]} R${rnd}] 항목 ${(info.items as unknown[]).length}개`];
  for (const raw of info.items as Record<string, unknown>[]) {
    lines.push(`\n#${String(raw.id)} ${String(raw.title)} [${String(raw.kind)}/${String(raw.status)}] 신뢰도 ${String(raw.confidence ?? "") || "-"} · 출처 ${String(raw.sources)}`);
    if (typeof raw.summary === "string" && raw.summary !== "") lines.push(`  요약: ${first_line(raw.summary, 300)}`);
  }
  const basis = [`- 주제: ${String(info.topic)}`, ...((info.notes as string[] | undefined) ?? []).map((n) => `- 인계 메모: ${first_line(n, 300)}`)];
  const text = `[검토 대상] ${String(info.topic)} — ${LABEL[s]} 단계 R${rnd} 결과 (프로젝트 ${slug})
[단계 목적] ${STAGE_GOAL[s] ?? ""}
[읽을 것]
${lines.join("\n")}
[기준 — 사용자가 정한 것]
${basis.join("\n")}
[결과 파일] ${join(rd, "qa.json")}
pes:reviewer 형식대로 QC·QA·표본 대조(3~5개)를 하고 결과 파일에 쓴 뒤 한 줄만 돌려준다. 프로젝트 상태 파일은 고치지 않는다.
`;
  await bridge("qa-brief", slug, { stage: s, text, dir: d });
  mkdirSync(rd, { recursive: true });
  const file = join(rd, "qa-brief.md");
  writeFileSync(file, text, "utf8");
  say(file);
}

export async function cmd_qa(args: string[]): Promise<void> {
  const d = pdir(arg_at(args, 0, "qa"));
  const s = stage_arg(args[1] === undefined ? missing_args("qa") : args[1]);
  const slug = await need_project(d);
  const info = await bridge("qa-data", slug, { stage: s });
  const rnd = Number(info.round_no);
  const at = args.indexOf("--file");
  const file = at >= 0 ? (args[at + 1] ?? missing_args("qa")) : join(d, "rounds", `${s}-R${rnd}`, "qa.json");
  if (!existsSync(file)) die(`검토 결과 없음: ${file} — qa-brief 로 지시문을 만들고 pes:reviewer 를 먼저 돌리세요`, 1);
  const raw = read_json_file(file, "검토 결과 파일");
  if (!is_record(raw)) die(`검토 결과는 JSON 객체여야 합니다: ${file}`, 2);
  const q: Record<string, unknown> = { ...raw };
  q.round = Number(q.round || rnd);
  q.recorded = now();
  await bridge("qa", slug, { stage: s, qa: q, dir: d });
  const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(is_record) : []);
  const findings = [...list(q.qc), ...list(q.qa)];
  const high = findings.filter((x) => x.severity === "high");
  const spots = list(q.spot_checks);
  say(
    `${LABEL[s]} R${String(q.round)} 독립 검토: ${String(q.verdict ?? "None")} · QC ${list(q.qc).length} · QA ${list(q.qa).length} · high ${high.length}` +
      ` · 표본 일치 ${spots.filter((x) => x.result === "match").length}/${spots.length} · 자체 점검이 놓친 것 ${Array.isArray(q.missed_by_self_review) ? q.missed_by_self_review.length : 0}`,
  );
  for (const x of high) say(`  [${String(x.id ?? "None")}] #${String(x.item ?? "None")} ${String(x.finding ?? "None")}`);
}

// ---------------------------------------------------------------- lock, unlock

const session_head = (me: string): string => Array.from(me).slice(0, 8).join("");

export async function cmd_lock(args: string[]): Promise<void> {
  const d = pdir(arg_at(args, 0, "lock"));
  const slug = await need_project(d);
  const me = process.env.PES_OWNER ?? "";
  if (me === "") die("PES_OWNER 환경변수(이 세션 ID)가 필요합니다", 2);
  await bridge("lock", slug, { force: args.includes("--force"), dir: d });
  say(`잠금: ${slug_of(d)} (세션 ${session_head(me)}…)`);
}

export async function cmd_unlock(args: string[]): Promise<void> {
  const d = pdir(arg_at(args, 0, "unlock"));
  // 0.15 asks nothing of a folder without a lock file: no project, no lock, nothing to release
  if (await project_exists(d)) await bridge("unlock", slug_of(d), { force: args.includes("--force"), dir: d });
  say("잠금 해제");
}

// ---------------------------------------------------------------- status

function status_line(p: Record<string, unknown>, d: string, pend: Array<{ name: string; stage?: string; kind?: string; round?: number; text?: string }>, url: string | null): void {
  const stages = p.stages as Record<string, Record<string, unknown>>;
  say(`주제: ${String(p.topic)}  (${d})`);
  say(`현재 단계: ${LABEL[String(p.current)]}${p.complete ? "  · 전체 완료" : ""}`);
  for (const [k, v] of STAGES) {
    const st = stages[k] as Record<string, unknown>;
    const items = (st.items as Record<string, unknown>[]) ?? [];
    const live = items.filter((i) => i.status !== "removed");
    const todo = live.filter((i) => ["new", "deepen", "revise", "browser"].includes(String(i.status)));
    const rv = (st.review as Record<string, unknown> | null) ?? {};
    const questions = Array.isArray(rv.questions) ? rv.questions : [];
    const rvq = questions.length > 0 ? ` · 점검 질문 ${questions.length}개(R${String(rv.round ?? "None")})` : "";
    const label = `${v}${" ".repeat(Math.max(0, 6 - width_of(v)))}`;
    const state = `${String(st.status)}${" ".repeat(Math.max(0, 8 - String(st.status).length))}`;
    say(`  ${k === p.current ? "▶" : " "} ${label} ${state} R${String(st.round)} 항목 ${live.length} (할 일 ${todo.length})${rvq}${st.stale ? "  ⚠다시 확인 필요" : ""}`);
  }
  const lib = p.library as Record<string, unknown> | null | undefined;
  if (lib) say(`참고자료: 기존 조사 ${((lib.items as unknown[]) ?? []).length}개 항목 (${String(lib.source)})`);
  const notes = (p.notes as Record<string, unknown>[] | undefined) ?? [];
  if (notes.length > 0) {
    say(`인계 메모 ${notes.length}개 (최근 5):`);
    for (const n of notes.slice(-5)) say(`  - [${String(n.time)}] ${String(n.text)}`);
  }
  say(`처리 안 한 답: ${pend.length}개`);
  for (const x of pend) {
    const first = String(x.text ?? "").split(/\r?\n/)[0] ?? "";
    say(`  - ${x.name}  [${x.stage ?? ""}/${x.kind ?? ""}/R${x.round ?? 0}] ${Array.from(first).slice(0, 80).join("")}`);
  }
  say(`대시보드: ${url ?? `서버 꺼짐 — serve ${slug_of(d)}`}`);
}

/** Python's `{v:<6}` pads by code points; the Hangul and the middle dot are one each. */
function width_of(text: string): number {
  return Array.from(text).length;
}

export async function cmd_status(args: string[]): Promise<void> {
  const d = pdir(arg_at(args, 0, "status"));
  const slug = await need_project(d, "읽기");
  const data = await bridge("read_project", slug);
  const pend = (data.pending as Array<{ name: string; stage?: string; kind?: string; round?: number; text?: string }>) ?? [];
  status_line(data.project as Record<string, unknown>, d, pend, await server_url(d));
}


// pes.ts reads: the project a read command shows — from the database, or (a 0.15 folder nobody migrated yet) straight from its project.json.
// The old folder is only READ here, never written: no migration, no repair (the write commands refuse it, cli_records.need_project).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { Die, KEYS, bridge, die, py_json_error } from "./cli_support.ts";
import { normalize_project } from "./report.ts";

type Dict = Record<string, any>;

export interface PendingAnswer {
  /** what `pending` prints and `mark` takes: the database's name, or the feedback file's path for an old folder */
  name: string;
  stage?: string;
  kind?: string;
  round?: number;
  text?: string;
}

export interface ReadState {
  slug: string;
  project: Dict;
  pending: PendingAnswer[];
  legacy: boolean;
}

async function db_slugs(): Promise<Set<string>> {
  try {
    return new Set(((await bridge("slugs")).slugs as string[] | undefined) ?? []);
  } catch (error) {
    if (error instanceof Die) return new Set();
    throw error;
  }
}

function read_text(path: string): string {
  const text = readFileSync(path, "utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** An old project.json project as 0.15's `load(d)` returns it (the report paths of a Windows-written file read with "/"). */
function load_legacy(d: string): ReadState {
  const file = join(d, "project.json");
  let text: string;
  try {
    text = read_text(file);
  } catch (error) {
    return die(`project.json 을 읽지 못했습니다: ${file} (${(error as NodeJS.ErrnoException).code ?? "읽기 오류"}) — 폴더는 그대로 두었습니다`, 1);
  }
  const broken = py_json_error(text);
  if (broken !== null) die(`project.json 을 읽지 못했습니다: ${file} (${broken}) — 폴더는 그대로 두었습니다`, 1);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Python's json accepts NaN / Infinity / -Infinity, JSON.parse does not: one Korean line instead of the parser's English (R1 권장 4)
    return die(`project.json 에 지원하지 않는 값(NaN·Infinity)이 있습니다: ${file} — 폴더는 그대로 두었습니다`, 1);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) die(`project.json 은 JSON 객체여야 합니다: ${file}`, 1);
  const current = (raw as Dict).current;
  if (typeof current !== "string" || !KEYS.includes(current)) {
    // no stage to show: one line instead of `현재 단계: undefined` (D11, R1 권장 5)
    die(`project.json 의 현재 단계(current)가 단계 이름이 아닙니다: ${file} (${KEYS.join(", ")} 중 하나여야 함) — 폴더는 그대로 두었습니다`, 1);
  }
  let library: Dict | null = null;
  const lib_file = join(d, "library.json");
  if (existsSync(lib_file)) {
    try {
      library = JSON.parse(read_text(lib_file)) as Dict;
    } catch {
      library = null;
    }
  }
  const project = normalize_project(raw as Dict, library);
  for (const st of Object.values<Dict>(project.stages)) {
    for (const r of Array.isArray(st.reports) ? st.reports : []) if (r !== null && typeof r === "object" && typeof r.path === "string") r.path = r.path.replace(/\\/g, "/");
  }
  const processed = new Set<string>(Array.isArray(project.processed) ? project.processed.map(String) : []);
  const dir = join(d, "feedback");
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json") && !processed.has(n)).sort() : [];
  const pending: PendingAnswer[] = [];
  for (const name of names) {
    let body: Dict = {};
    try {
      body = JSON.parse(read_text(join(dir, name))) as Dict;
    } catch {
      body = {};
    }
    pending.push({ name: join(dir, name), stage: body.stage ?? "", kind: body.kind ?? "", round: body.round ?? 0, text: body.text ?? "" });
  }
  return { slug: basename(d), project, pending, legacy: true };
}

/** The project of folder `d` for a read command: the database's when it serves the folder's name, else the old project.json, else exit 1. */
export async function load_for_read(d: string): Promise<ReadState> {
  const slug = basename(d);
  if ((await db_slugs()).has(slug)) {
    const data = await bridge("read_project", slug);
    return { slug, project: data.project as Dict, pending: (data.pending as PendingAnswer[] | undefined) ?? [], legacy: false };
  }
  if (existsSync(join(d, "project.json"))) return load_legacy(d);
  return die(`project.json 없음: ${d}`, 1);
}

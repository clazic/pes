// pes.ts: the files a person looks at — the dashboard index.html, snapshots/*.json, the question page ask-*.html (SEL-71).
// Same templates and same data as 0.15's `build_index` / `cmd_render` / `cmd_ask`; the project they show comes from the database
// (the 0.15-shaped read model), the snapshots and the folder listings from the folder, exactly as 0.15 read them.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import { KEYS, QB, STAGES, TPL, bridge, html_escape, is_record, now } from "./cli_support.ts";

type Dict = Record<string, unknown>;

/** pes.py `fill`: the template with its title, the shared question module and the data blob (`</` escaped) put in. */
export function fill(template: string, title: string, data: unknown): string {
  const blob = JSON.stringify(data).replace(/<\//g, "<\\/");
  return readFileSync(join(TPL, template), "utf8")
    .split("__TITLE__")
    .join(html_escape(title))
    .split("<!--__QUESTIONS__-->")
    .join(readFileSync(join(TPL, "_questions.html"), "utf8"))
    .split("/*__DATA__*/null")
    .join(blob);
}

// ---------------------------------------------------------------- question labels (pes.py qlabels / all_qlabels)

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

function qlabels(stage: string): { lab: Dict; opt: Map<string, unknown> } {
  const lab: Dict = {};
  const opt = new Map<string, unknown>();
  let questions: unknown[] = [];
  try {
    const bank = JSON.parse(readFileSync(join(QB, `${stage}.json`), "utf8")) as Dict;
    questions = Array.isArray(bank.questions) ? bank.questions : [];
  } catch {
    questions = [];
  }
  const stack = [...questions];
  while (stack.length > 0) {
    const q = stack.pop();
    if (!is_record(q) || !("id" in q)) continue;
    const id = String(q.id);
    if (!(id in lab)) lab[id] = "label" in q ? q.label : id;
    for (const o of Array.isArray(q.options) ? q.options : []) {
      if (is_record(o)) opt.set(`${id}\u0000${String(o.value)}`, "label" in o ? o.label : o.value);
    }
  }
  return { lab, opt };
}

export function all_qlabels(): Dict {
  const out: Dict = {};
  for (const key of KEYS) {
    const { lab, opt } = qlabels(key);
    const merged: Dict = { ...EXTRA_LABELS, ...lab };
    for (const [pair, label] of opt) {
      const [a, b] = pair.split("\u0000");
      merged[`${a}=${b}`] = label;
    }
    out[key] = merged;
  }
  return out;
}

// ---------------------------------------------------------------- the project as 0.15's load() shows it

/** The DB read model always carries empty `qa` / `review_log` lists; 0.15 adds those keys with the first write — an empty one is the same state. */
export function legacy_project(p: Dict): Dict {
  const copy = JSON.parse(JSON.stringify(p)) as Dict;
  // `init` wrote both texts (empty) into project.json: the page and the snapshots show them from the start
  for (const key of ["executive_summary", "conclusion"]) if (!(key in copy)) copy[key] = "";
  for (const stage of Object.values((copy.stages as Record<string, Dict> | undefined) ?? {})) {
    for (const key of ["qa", "review_log"]) if (Array.isArray(stage[key]) && (stage[key] as unknown[]).length === 0) delete stage[key];
  }
  return copy;
}

/** pes.py `library_view`: the dashboard shows the library without the item bodies (summary 240 characters). */
function library_view(p: Dict): Dict {
  const lib = p.library;
  if (!is_record(lib)) return p;
  const out: Dict = { ...p };
  const items = (Array.isArray(lib.items) ? lib.items : []).filter(is_record);
  out.library = {
    ...Object.fromEntries(Object.entries(lib).filter(([k]) => k !== "items")),
    items: items.map((i) => ({
      id: i.id,
      title: i.title,
      summary: Array.from(String(i.summary ?? "")).slice(0, 240).join(""),
      confidence: i.confidence ?? null,
      sources: (Array.isArray(i.sources) ? i.sources : []).map((x) => ({ method: is_record(x) ? (x.method ?? null) : null })),
    })),
  };
  return out;
}

// ---------------------------------------------------------------- snapshots (pes.py cmd_render / build_index)

function slim(st: Dict): Dict {
  const items = ((st.items as Dict[] | undefined) ?? []).map((it) => {
    const row: Dict = {};
    for (const k of ["id", "title", "kind", "status", "request", "depth", "updated_round", "summary", "confidence", "conflicts", "verdict"]) row[k] = k in it ? it[k] : null;
    row.n_sources = Array.isArray(it.sources) ? it.sources.length : 0;
    row.n_stats = Array.isArray(it.stats) ? it.stats.length : 0;
    row.details_len = typeof it.details === "string" ? Array.from(it.details).length : 0;
    return row;
  });
  const review = is_record(st.review) && Object.keys(st.review).length > 0 ? st.review : null;
  return {
    round: st.round ?? null,
    status: st.status ?? null,
    changes: st.changes ?? [],
    items,
    n_suggestions: Array.isArray(st.suggestions) ? st.suggestions.length : 0,
    review: review === null ? null : { round: review.round ?? null, questions: (Array.isArray(review.questions) ? review.questions : []).map((q) => ({ id: is_record(q) ? (q.id ?? null) : null })) },
  };
}

/** Creates the file only when it does not exist yet (O_EXCL); false when it is already there. */
function write_snapshot(path: string, snap: Dict): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, Buffer.from(JSON.stringify(snap), "utf8"));
  } finally {
    closeSync(fd);
  }
  return true;
}

function snapshot_versions(base: string): Array<[number, string]> {
  const out: Array<[number, string]> = existsSync(base) ? [[1, base]] : [];
  const round_dir = base.replace(/\.json$/, "");
  try {
    if (statSync(round_dir).isDirectory()) {
      for (const name of readdirSync(round_dir)) {
        const m = name.match(/^(\d+)\.json$/);
        if (m !== null) out.push([Number(m[1]), join(round_dir, name)]);
      }
    }
  } catch {
    // no round folder
  }
  return out.sort((a, b) => a[0] - b[0]);
}

function snapshot_state(path: string): unknown {
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as Dict).state;
  } catch {
    return null;
  }
}

function same_json(a: unknown, b: unknown): boolean {
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (is_record(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]));
  return value;
}

/**
 * 0.15 render: the stage's state as it is now goes to snapshots/<stage>-R<n>.json; when the round already has a snapshot of another
 * state, the new one is added as snapshots/<stage>-R<n>/<k>.json (the first state is never overwritten).
 */
export function save_snapshot(d: string, stage: string, st: Dict): void {
  const round = Number(st.round);
  if (!(round > 0)) return;
  const snap: Dict = { stage, round, time: now(), state: st };
  const dir = join(d, "snapshots");
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `${stage}-R${round}.json`);
  write_snapshot(base, snap);
  const versions = snapshot_versions(base);
  const last = versions[versions.length - 1];
  if (last !== undefined && !same_json(snapshot_state(last[1]), st)) {
    const round_dir = join(dir, `${stage}-R${round}`);
    mkdirSync(round_dir, { recursive: true });
    let k = last[0] + 1;
    while (!write_snapshot(join(round_dir, `${k}.json`), snap)) k += 1;
  }
}

function folder_snapshots(d: string): Dict[] {
  const dir = join(d, "snapshots");
  const latest = new Map<string, [number, Dict]>();
  if (existsSync(dir)) {
    const candidates: Array<[string, number]> = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && /^.*-R.*\.json$/.test(entry.name)) candidates.push([join(dir, entry.name), 1]);
      else if (entry.isDirectory()) {
        for (const sub of readdirSync(join(dir, entry.name), { withFileTypes: true })) {
          const m = sub.name.match(/^(\d+)\.json$/);
          if (sub.isFile() && m !== null) candidates.push([join(dir, entry.name, sub.name), Number(m[1])]);
        }
      }
    }
    for (const [file, version] of candidates) {
      let entry: Dict;
      try {
        const x = JSON.parse(readFileSync(file, "utf8")) as Dict;
        entry = { stage: x.stage, round: x.round, time: x.time ?? null, state: slim(x.state as Dict) };
        if (typeof x.stage !== "string" || !is_record(x.state)) continue;
      } catch {
        continue;
      }
      const key = `${String(entry.stage)}\u0000${String(entry.round)}`;
      const have = latest.get(key);
      if (have === undefined || version > have[0]) latest.set(key, [version, entry]);
    }
  }
  const list = [...latest.values()].map(([, entry]) => entry);
  const order = (x: Dict): number => (KEYS.includes(String(x.stage)) ? KEYS.indexOf(String(x.stage)) : 9);
  return list.sort((a, b) => order(a) - order(b) || Number(a.round) - Number(b.round));
}

function folder_listing(d: string, name: string): string[] {
  const dir = join(d, name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => `${name}/${e.name}`)
    .sort();
}

/** 0.15 `build_index`: writes <d>/index.html from the project (database) and the folder (snapshots, asks, out/). Returns its path. */
export async function build_index(d: string, slug: string): Promise<string> {
  const data = await bridge("read_project", slug);
  const p = legacy_project(data.project as Dict);
  const asks = existsSync(d) ? readdirSync(d).filter((n) => /^ask-.*\.html$/.test(n)).sort() : [];
  const page: Dict = {
    project: library_view(p),
    stages: STAGES.map(([key, label]) => ({ key, label })),
    snapshots: folder_snapshots(d),
    feedback: (data.feedback as unknown[] | undefined) ?? [],
    asks,
    outputs: folder_listing(d, "out"),
    built: now(),
    qlabels: all_qlabels(),
  };
  mkdirSync(d, { recursive: true });
  const file = join(d, "index.html");
  writeFileSync(file, fill("dashboard.html", `${String(p.topic ?? "프로젝트")} · PES`, page), "utf8");
  return file;
}

/** Rebuilds index.html after a state change (best effort for the hub the project's folder sits in). */
export async function refresh_index(d: string, slug: string): Promise<string> {
  return build_index(d, slug);
}


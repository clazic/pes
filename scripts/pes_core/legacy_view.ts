// A read-only "legacy-shaped" view of one project in the database (stage 2 PR16).
//
// The v0.15 readers (status, digest, show, list, the report generators) work on the
// dictionary pes.py's `load()` returns. This module rebuilds that dictionary from the
// database rows so the same readers — and the same report generator (report.ts) — serve
// a project that lives in the database. Nothing is written.
//
// Two row layouts are read:
//   - items the CLI merge wrote: flat metadata (legacy_id, legacy_kind, depth, links, ...);
//   - items the PR11 importer wrote: the same facts under metadata.legacy_extra.
// An item that has no recorded round (the CLI merge keeps none) gets the round that was
// open when its version was written: the newest round whose start receipt precedes the
// version's receipt.

import type { Db } from "./db.ts";
import { read_storage_bytes } from "./files.ts";
import { blank_item, feedback_entries, local_stamp, new_stage, PyFloat, STAGE_KEYS, truthy, type Dict, type FeedbackEntry } from "./report.ts";

type Row = Record<string, unknown>;

/**
 * SQL fragment: the artifact version aliased `alias` is not one of the generated report files
 * (metadata.role stage_report / final_output). The report commands tag their artifacts with that role.
 */
export function not_a_report_sql(alias: string): string {
  return `COALESCE(json_extract(${alias}.metadata_json, '$.role'), '') NOT IN ('stage_report', 'final_output')`;
}

/**
 * The rendered files of one version under the names that version gave them. A blob is shared by
 * content (PR9 reuses one blob per project, sha256 and size and keeps its first upload name), so the
 * blob's original_name is not the file's name in this version: a report version records
 * metadata.files = [{name, sha256, size}] when it is written, and the name comes from there.
 * A version without that record (the importer's) falls back to the blob's name.
 */
export function rendered_files(db: Pick<Db, "all" | "get">, project_id: string, version_id: string): Array<{ name: string; storage_key: string | null; size: number }> {
  const rows = db.all<{ original_name: string | null; storage_key: string | null; sha256: string; size: bigint }>(
    `SELECT b.original_name AS original_name, b.storage_key AS storage_key, b.sha256 AS sha256, b.size AS size
       FROM version_files vf JOIN blobs b ON b.project_id = vf.project_id AND b.id = vf.blob_id
      WHERE vf.project_id = ? AND vf.version_id = ? AND vf.role = 'rendered'`,
    project_id,
    version_id,
  );
  const meta = db.get<{ metadata_json: string | null }>(
    "SELECT metadata_json FROM artifact_versions WHERE project_id = ? AND version_id = ?",
    project_id,
    version_id,
  );
  const recorded = record(parse(meta?.metadata_json, {})).files;
  const out: Array<{ name: string; storage_key: string | null; size: number }> = [];
  if (Array.isArray(recorded) && recorded.length > 0) {
    for (const entry of recorded) {
      const file = record(entry);
      if (typeof file.name !== "string") continue;
      const row = rows.find((r) => r.sha256 === file.sha256 && Number(r.size) === Number(file.size));
      if (row !== undefined) out.push({ name: file.name, storage_key: row.storage_key, size: num(row.size) });
    }
  } else {
    for (const row of rows) out.push({ name: row.original_name ?? "", storage_key: row.storage_key, size: num(row.size) });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function num(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0;
}

function parse(text: unknown, fallback: unknown): unknown {
  if (typeof text !== "string") return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function record(value: unknown): Dict {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : {};
}

export interface PendingAnswer {
  name: string;
  stage: string;
  kind: string;
  round: number;
  text: string;
}

export interface ProjectView {
  project: Dict;
  pending: PendingAnswer[];
  /** Every imported answer file, as the old `load_feedback` listed them (for the report's decision section). */
  feedback: FeedbackEntry[];
}

interface StageRow {
  id: string;
  key: string;
  status: string;
  current_round_id: string | null;
  stale: bigint | null;
  settings_json: string;
}

export function build_project_view(
  db: Pick<Db, "get" | "all">,
  project_id: string,
  objects_dir: string,
): ProjectView {
  const project = db.get<{ slug: string; topic: string; created_at: bigint; active_edition_id: string | null }>(
    "SELECT slug, topic, created_at, active_edition_id FROM projects WHERE id = ?",
    project_id,
  );
  if (project === undefined) throw new Error("project not found");
  const edition_id = project.active_edition_id;
  const edition = edition_id === null
    ? undefined
    : db.get<{ status: string; current_stage_id: string | null; settings_json: string }>(
        "SELECT status, current_stage_id, settings_json FROM editions WHERE project_id = ? AND id = ?",
        project_id,
        edition_id,
      );
  const edition_settings = record(parse(edition?.settings_json, {}));
  const edition_extra = record(edition_settings.legacy_extra);
  const stages = db.all<StageRow>(
    `SELECT id, key, status, current_round_id, stale_since_event_seq AS stale, settings_json
       FROM stages WHERE project_id = ? AND edition_id = ? ORDER BY ordinal`,
    project_id,
    edition_id ?? "",
  );
  const rounds = db.all<{ stage_id: string; round_no: bigint; start_rowid: bigint | null }>(
    `SELECT r.stage_id AS stage_id, r.round_no AS round_no,
            (SELECT mc.rowid FROM mutation_commits mc
              WHERE mc.project_id = r.project_id AND mc.action = 'round.started'
                AND json_extract(mc.result_json, '$.round_id') = r.id) AS start_rowid
       FROM rounds r WHERE r.project_id = ? AND r.edition_id = ?`,
    project_id,
    edition_id ?? "",
  );
  const round_no_of = new Map<string, number>();
  const rounds_by_stage = new Map<string, Array<{ no: number; start: number | null }>>();
  for (const row of rounds) {
    const list = rounds_by_stage.get(row.stage_id) ?? [];
    list.push({ no: num(row.round_no), start: row.start_rowid === null ? null : num(row.start_rowid) });
    rounds_by_stage.set(row.stage_id, list);
  }
  const stage_key_of = new Map<string, string>();
  for (const stage of stages) stage_key_of.set(stage.id, stage.key);

  const p: Dict = {
    pes: 1,
    topic: project.topic,
    slug: project.slug,
    created: num(project.created_at) > 0 ? local_stamp(num(project.created_at)).slice(0, 10) : "",
    current: STAGE_KEYS[0],
    complete: edition?.status === "completed",
    settings: Object.fromEntries(Object.entries(edition_settings).filter(([key]) => key !== "legacy_extra")),
    processed: [] as string[],
    notes: [] as Dict[],
    stages: {} as Dict,
  };
  if (edition?.current_stage_id) {
    const key = stage_key_of.get(edition.current_stage_id);
    if (key !== undefined) p.current = key;
  }

  const approved_rows = db.all<{ stage_id: string; origin: string; note: string | null; created_at: bigint }>(
    `SELECT ap.stage_id AS stage_id, ap.origin AS origin, ap.note AS note, mc.created_at AS created_at
       FROM approvals ap JOIN mutation_commits mc ON mc.project_id = ap.project_id AND mc.id = ap.tx_id
      WHERE ap.project_id = ? ORDER BY ap.rowid`,
    project_id,
  );
  const approved_at = new Map<string, string>();
  for (const row of approved_rows) {
    approved_at.set(row.stage_id, row.origin === "legacy" && row.note !== null ? row.note : local_stamp(num(row.created_at)));
  }

  for (const key of STAGE_KEYS) {
    const stage = stages.find((s) => s.key === key);
    const st = new_stage();
    if (stage !== undefined) {
      const list = rounds_by_stage.get(stage.id) ?? [];
      st.status = stage.status;
      st.round = list.reduce((top, r) => Math.max(top, r.no), 0);
      st.stale = stage.stale !== null;
      const settings = record(parse(stage.settings_json, {}));
      st.settings = Object.fromEntries(Object.entries(settings).filter(([name]) => name !== "legacy_extra"));
      const extra = record(settings.legacy_extra);
      if (truthy(extra.carry_over)) st.carry_over = extra.carry_over;
      st.approved_at = stage.status === "approved" ? (approved_at.get(stage.id) ?? null) : null;
    }
    p.stages[key] = st;
  }

  // artifacts: every current version of the project's artifact objects
  const artifacts = db.all<Row>(
    `SELECT o.id AS object_id, o.display_no AS display_no, a.kind AS kind, a.stage_id AS stage_id,
            v.version_id AS version_id, v.title AS title, v.question AS question, v.summary AS summary,
            v.body_md AS body_md, v.status AS status, v.confidence AS confidence, v.stats AS stats,
            v.conflicts AS conflicts, v.verify AS verify, v.metadata_json AS metadata_json,
            ov.created_in_round_id AS created_in_round_id, ov.created_at AS created_at,
            mc.rowid AS tx_rowid, ov.rowid AS version_rowid
       FROM objects o
       JOIN artifacts a ON a.project_id = o.project_id AND a.object_id = o.id
       JOIN artifact_versions v ON v.project_id = o.project_id AND v.version_id = o.current_version_id
       JOIN object_versions ov ON ov.project_id = v.project_id AND ov.id = v.version_id
       JOIN mutation_commits mc ON mc.project_id = ov.project_id AND mc.id = ov.tx_id
      WHERE o.project_id = ? AND o.kind = 'artifact'
      ORDER BY o.display_no`,
    project_id,
  );
  const round_no_by_id = new Map<string, number>();
  for (const row of db.all<{ id: string; round_no: bigint }>("SELECT id, round_no FROM rounds WHERE project_id = ?", project_id)) {
    round_no_by_id.set(row.id, num(row.round_no));
  }
  const citations = new Map<string, Dict[]>();
  for (const row of db.all<Row>(
    `SELECT c.artifact_version_id AS version_id, sv.title AS title, sv.url AS url, sv.method AS method,
            sv.locator AS locator
       FROM citations c
       JOIN source_versions sv ON sv.project_id = c.project_id AND sv.version_id = c.source_version_id
      WHERE c.project_id = ? ORDER BY c.artifact_version_id, c.citation_no`,
    project_id,
  )) {
    const locator = record(parse(row.locator, {}));
    const source: Dict = { title: row.title };
    if (typeof row.url === "string" && row.url.length > 0) source.url = row.url;
    const original = record(locator.legacy_extra).method_original;
    if (original !== undefined) {
      if (original !== null) source.method = original;
    } else if (row.method !== "unknown") {
      source.method = row.method;
    }
    for (const field of ["date", "note", "orgId", "tblId"]) if (field in locator) source[field] = locator[field];
    const list = citations.get(String(row.version_id)) ?? [];
    list.push(source);
    citations.set(String(row.version_id), list);
  }

  const suggestions = new Map<string, string[]>();
  const notes: Array<{ rowid: number; note: Dict }> = [];
  const qas = new Map<string, Array<{ rowid: number; qa: Dict }>>();
  const review_logs = new Map<string, Array<{ rowid: number; log: Dict }>>();
  const report_versions: Array<{ stage_key: string | null; version_id: string; role: string; round: number; meta: Dict; rowid: number }> = [];
  let library_items = 0;

  for (const row of artifacts) {
    const meta = record(parse(row.metadata_json, {}));
    const extra = record(meta.legacy_extra);
    const get = (field: string): unknown => (field in meta ? meta[field] : extra[field]);
    const kind = String(row.kind);
    const stage_key = typeof row.stage_id === "string" ? (stage_key_of.get(row.stage_id) ?? null) : null;
    const role = typeof meta.role === "string" ? meta.role : "";
    const rowid = num(row.version_rowid);

    if (kind === "note") {
      if (role === "handoff_note") {
        notes.push({ rowid, note: { time: local_stamp(num(row.created_at)), stage: typeof meta.stage === "string" ? meta.stage : p.current, text: row.body_md ?? "" } });
        continue;
      }
      if (role === "" && truthy(extra.note) && !("legacy_id" in extra)) {
        notes.push({ rowid, note: record(extra.note) });
        continue;
      }
      if (!("legacy_id" in extra) && !("legacy_id" in meta)) continue;
    }
    if (kind === "review") {
      if (stage_key !== null && truthy(meta.qa)) {
        const list = qas.get(stage_key) ?? [];
        list.push({ rowid, qa: record(meta.qa) });
        qas.set(stage_key, list);
      } else if (stage_key !== null && truthy(meta.review_log)) {
        const list = review_logs.get(stage_key) ?? [];
        list.push({ rowid, log: record(meta.review_log) });
        review_logs.set(stage_key, list);
      } else if (stage_key !== null && row.title === "(검토 요약)" && truthy(meta.review)) {
        (p.stages[stage_key] as Dict).review = meta.review;
      }
      continue;
    }
    if (role === "stage_report" || role === "final_output") {
      report_versions.push({ stage_key, version_id: String(row.version_id), role, round: 0, meta, rowid });
      continue;
    }
    if (kind === "report" || kind === "output") {
      // imported stubs of the old reports bookkeeping: they are not items
      if (stage_key !== null && typeof extra.stage_summary === "string") (p.stages[stage_key] as Dict).summary = extra.stage_summary;
      else if (stage_key !== null && truthy(extra.report)) (p.stages[stage_key] as Dict).reports.push(record(extra.report));
      else if (stage_key === null && typeof extra.executive_summary === "string") {
        p.executive_summary = extra.executive_summary;
        if (typeof meta.conclusion === "string") p.conclusion = meta.conclusion;
      }
      if (!("legacy_id" in extra) && !("legacy_id" in meta)) continue;
    }
    if (stage_key === null) {
      if ("legacy_id" in extra) library_items += 1;
      continue;
    }

    const item = blank_item(get("legacy_id") ?? num(row.display_no), String(row.title));
    const original_kind = typeof meta.legacy_kind === "string" ? meta.legacy_kind : extra.kind_original;
    item.kind = typeof original_kind === "string" ? original_kind : kind === "note" ? "" : kind;
    item.question = typeof row.question === "string" ? row.question : "";
    item.status = typeof extra.status_original === "string" ? extra.status_original : String(row.status);
    item.request = get("request") ?? "";
    item.depth = get("depth") ?? 0;
    let round = 0;
    if (typeof row.created_in_round_id === "string" && round_no_by_id.has(row.created_in_round_id)) {
      round = round_no_by_id.get(row.created_in_round_id) as number;
    } else if (typeof extra.updated_round === "number") {
      round = extra.updated_round;
    } else {
      for (const r of rounds_by_stage.get(String(row.stage_id)) ?? []) {
        if (r.start !== null && r.start < num(row.tx_rowid) && r.no > round) round = r.no;
      }
    }
    item.updated_round = round;
    item.summary = row.summary ?? "";
    item.details = typeof row.body_md === "string" ? row.body_md : "";
    item.sources = citations.get(String(row.version_id)) ?? [];
    item.stats = parse(row.stats, []);
    // numbers the old file wrote as 12.0 (the importer remembers which) are shown as 12.0 again
    if (Array.isArray(extra.stat_floats) && Array.isArray(item.stats)) {
      for (const mark of extra.stat_floats) {
        const [index, ...field] = String(mark).split("/");
        const stat = (item.stats as unknown[])[Number(index)];
        const name = field.join("/");
        if (stat !== null && typeof stat === "object" && typeof (stat as Dict)[name] === "number") (stat as Dict)[name] = new PyFloat((stat as Dict)[name] as number);
      }
    }
    const shots = get("shots");
    item.shots = Array.isArray(shots) ? shots : [];
    item.confidence = "confidence_original" in extra ? extra.confidence_original : (row.confidence ?? "");
    item.conflicts = parse(row.conflicts, []);
    item.verify = parse(row.verify, null);
    const links = get("links");
    item.links = links !== null && typeof links === "object" && !Array.isArray(links) ? links : {};
    for (const field of ["order", "verdict", "path", "model"]) {
      const value = get(field);
      if (value !== undefined && value !== null && value !== "") item[field] = value;
    }
    const open = meta.open_questions;
    if (Array.isArray(open) && stage_key !== null) {
      const list = suggestions.get(stage_key) ?? [];
      for (const q of open) list.push(`[#${String(item.id)}] ${String(q)}`);
      suggestions.set(stage_key, list);
    }
    ((p.stages[stage_key] as Dict).items as Dict[]).push(item);
  }

  notes.sort((a, b) => a.rowid - b.rowid);
  p.notes = notes.map((entry) => entry.note);
  for (const key of STAGE_KEYS) {
    const st = p.stages[key] as Dict;
    st.suggestions = suggestions.get(key) ?? [];
    st.qa = (qas.get(key) ?? []).sort((a, b) => a.rowid - b.rowid).map((entry) => entry.qa);
    st.review_log = (review_logs.get(key) ?? []).sort((a, b) => a.rowid - b.rowid).map((entry) => entry.log);
  }
  if (library_items > 0 || truthy(edition_extra.library)) {
    p.library = { ...record(edition_extra.library), items: new Array(library_items).fill(null).map((_, i) => ({ id: i + 1, title: "", summary: "", confidence: "", sources: [] })) };
    if (!("source" in p.library)) p.library.source = "";
  }

  // registered report files (the current version of each stage's report object)
  for (const entry of report_versions) {
    if (entry.role !== "stage_report" || entry.stage_key === null) continue;
    const files = rendered_files(db, project_id, entry.version_id);
    const st = p.stages[entry.stage_key] as Dict;
    st.reports = files.map((file) => {
      const name = file.name;
      const stem = name.replace(/\.[^.]+$/, "");
      const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
      return { format: stem === "eli5" ? "eli5" : ext, label: name, path: `reports/${entry.stage_key}/${name}`, bytes: num(file.size), round: st.round };
    });
  }

  // processed names and the history lines the importer kept as events
  const processed = new Set<string>();
  for (const event of db.all<{ type: string; payload: string }>(
    `SELECT type, payload FROM events
      WHERE project_id = ? AND type IN ('legacy.processed', 'input.marked_processed', 'legacy.history')
      ORDER BY rowid`,
    project_id,
  )) {
    const payload = record(parse(event.payload, {}));
    if (event.type === "legacy.processed" && typeof payload.name === "string") processed.add(payload.name);
    else if (event.type === "input.marked_processed" && Array.isArray(payload.names)) {
      for (const name of payload.names) if (typeof name === "string") processed.add(name);
    } else if (event.type === "legacy.history" && typeof payload.stage === "string" && typeof payload.line === "string") {
      const st = p.stages[payload.stage] as Dict | undefined;
      if (st !== undefined) st.history.push(payload.line);
    }
  }
  p.processed = [...processed];

  // unprocessed answers: imported answer files that nobody marked as processed
  const pending: PendingAnswer[] = [];
  const files: Array<{ name: string; text: string }> = [];
  // Every submission counts, whatever its channel (import, web, cli, http ...). One that kept its raw
  // answer file is named by that file; one that did not is named submission-<id>.json.
  for (const row of db.all<{ id: string; original_name: string | null; storage_key: string | null; stage_key: string | null; purpose: string | null }>(
    `SELECT s.id AS id, b.original_name AS original_name, b.storage_key AS storage_key,
            st.key AS stage_key, qs.purpose AS purpose
       FROM submissions s
       LEFT JOIN blobs b ON b.project_id = s.project_id AND b.id = s.raw_blob_id
       LEFT JOIN question_sets qs ON qs.project_id = s.project_id AND qs.id = s.set_id
       LEFT JOIN stages st ON st.project_id = qs.project_id AND st.id = qs.stage_id
      WHERE s.project_id = ?
      ORDER BY coalesce(b.original_name, 'submission-' || s.id || '.json')`,
    project_id,
  )) {
    const name = row.original_name ?? `submission-${row.id}.json`;
    let text = "";
    let doc: Dict = {};
    if (row.storage_key !== null) {
      try {
        text = new TextDecoder().decode(read_storage_bytes(objects_dir, project_id, row.storage_key));
        doc = record(JSON.parse(text));
      } catch {
        doc = {};
      }
      files.push({ name, text });
    }
    if (processed.has(name)) continue;
    pending.push({
      name,
      stage: typeof doc.stage === "string" ? doc.stage : (row.stage_key ?? ""),
      kind: typeof doc.kind === "string" ? doc.kind : (row.purpose ?? "feedback"),
      round: typeof doc.round === "number" ? doc.round : 0,
      text: typeof doc.text === "string" ? doc.text : "",
    });
  }
  return { project: p, pending, feedback: feedback_entries(files, processed) };
}

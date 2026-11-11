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

function is_dict(value: unknown): value is Dict {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Dict {
  return is_dict(value) ? value : {};
}


/**
 * A library item as the old research-loop state.json (and 0.15's `library`) showed it: the keys it had, with the values it had.
 * An empty value of a key the item may have lacked is left out (the import keeps no record of an absent key).
 */
function library_item(row: Row, extra: Dict, sources: Dict[]): Dict {
  const item: Dict = { id: extra.legacy_id };
  item.title = "title_original" in extra ? extra.title_original : row.title;
  const put = (key: string, value: unknown, keep_empty = false): void => {
    if (value === undefined || value === null) return;
    if (!keep_empty && (value === "" || (Array.isArray(value) && value.length === 0))) return;
    item[key] = value;
  };
  put("summary", typeof extra.summary !== "undefined" ? extra.summary : row.summary);
  put("details", typeof extra.details !== "undefined" ? extra.details : row.body_md);
  put("question", typeof extra.question !== "undefined" ? extra.question : row.question);
  put("confidence", typeof extra.confidence !== "undefined" ? extra.confidence : row.confidence);
  put("status", typeof extra.status !== "undefined" ? extra.status : row.status === "new" ? undefined : row.status);
  put("sources", sources);
  put("stats", typeof extra.stats !== "undefined" ? extra.stats : parse(row.stats, []));
  put("conflicts", typeof extra.conflicts !== "undefined" ? extra.conflicts : parse(row.conflicts, []));
  put("verify", parse(row.verify, null));
  if ("kind_original" in extra) put("kind", extra.kind_original);
  else if (row.kind !== "note") put("kind", row.kind);
  const skip = new Set(["legacy_id", "title_original", "summary", "details", "question", "confidence", "status", "stats", "conflicts", "kind_original", "stat_floats", "confidence_original", "status_original"]);
  for (const [key, value] of Object.entries(extra)) if (!skip.has(key)) item[key] = value;
  if ("confidence_original" in extra) item.confidence = extra.confidence_original;
  if ("status_original" in extra) item.status = extra.status_original;
  return item;
}

/** The manifest name of a round that `approve` opened and sealed by itself (cli_bridge compat_approve); the read model does not count it as a round. */
export const IMPLICIT_MANIFEST = "implicit-approval.json";

/** The `reason` of the reopen `approve` does by itself to approve a stage a second time (v0.15 allowed that); it leaves no history line. */
export const REAPPROVE_REASON = "pes-cli:re-approve";

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

export interface ViewOptions {
  /**
   * Show these exact versions (object id -> version id) instead of the current ones, and only these objects:
   * what a sealed round showed. Everything that is not an item of a stage (notes, reports, answers) is left out.
   */
  pin?: ReadonlyMap<string, string>;
}

export function build_project_view(
  db: Pick<Db, "get" | "all">,
  project_id: string,
  objects_dir: string,
  options: ViewOptions = {},
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
  const rounds = db.all<{ id: string; stage_id: string; round_no: bigint; start_rowid: bigint | null; implicit: bigint | null }>(
    `SELECT r.id AS id, r.stage_id AS stage_id, r.round_no AS round_no,
            (SELECT mc.rowid FROM mutation_commits mc
              WHERE mc.project_id = r.project_id AND mc.action = 'round.started'
                AND json_extract(mc.result_json, '$.round_id') = r.id) AS start_rowid,
            (SELECT 1 FROM snapshots sn JOIN blobs b ON b.project_id = sn.project_id AND b.id = sn.manifest_blob_id
              WHERE sn.project_id = r.project_id AND sn.id = r.sealed_snapshot_id AND b.original_name = ?) AS implicit
       FROM rounds r WHERE r.project_id = ? AND r.edition_id = ? ORDER BY r.stage_id, r.round_no`,
    IMPLICIT_MANIFEST,
    project_id,
    edition_id ?? "",
  );
  // A round the CLI opened only to seal an `approve` that came without one (v0.15 approved any stage) is not a round of the work:
  // it has no number of its own, so the stage shows the rounds a person started (round_display, 0 = none).
  const round_no_of = new Map<string, number>();
  const rounds_by_stage = new Map<string, Array<{ no: number; start: number | null }>>();
  const seen_visible = new Map<string, number>();
  for (const row of rounds) {
    const visible = seen_visible.get(row.stage_id) ?? 0;
    if (row.implicit !== null) {
      round_no_of.set(row.id, visible);
      continue;
    }
    seen_visible.set(row.stage_id, visible + 1);
    round_no_of.set(row.id, visible + 1);
    const list = rounds_by_stage.get(row.stage_id) ?? [];
    list.push({ no: visible + 1, start: row.start_rowid === null ? null : num(row.start_rowid) });
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
  } else if (edition !== undefined) {
    delete p.current; // a hand-written v0.15 file that never named a current stage has none
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
      // v0.15 `ask` flips a pending stage to "asking" once its start-question form is out
      if (stage.status === "pending" && db.get("SELECT 1 AS ok FROM question_sets WHERE project_id = ? AND stage_id = ? AND purpose = 'stage_start'", project_id, stage.id) !== undefined) {
        st.status = "asking";
      }
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

  // artifacts: every current version of the project's artifact objects (or the pinned versions of a sealed round)
  const pin = options.pin;
  const pin_entries = pin === undefined ? [] : [...pin.entries()];
  const pin_params: string[] = [];
  let pin_with = "";
  if (pin !== undefined) {
    pin_with = `WITH pinned(object_id, version_id) AS (VALUES ${pin_entries.map(() => "(?, ?)").join(", ") || "(NULL, NULL)"}) `;
    for (const [object_id, version_id] of pin_entries) pin_params.push(object_id, version_id);
  }
  const artifacts = db.all<Row>(
    `${pin_with}SELECT o.id AS object_id, o.display_no AS display_no, a.kind AS kind, a.stage_id AS stage_id,
            v.version_id AS version_id, v.title AS title, v.question AS question, v.summary AS summary,
            v.body_md AS body_md, v.status AS status, v.confidence AS confidence, v.stats AS stats,
            v.conflicts AS conflicts, v.verify AS verify, v.metadata_json AS metadata_json,
            ov.created_in_round_id AS created_in_round_id, ov.created_at AS created_at,
            mc.rowid AS tx_rowid, ov.rowid AS version_rowid
       FROM objects o
       ${pin === undefined ? "" : "JOIN pinned ON pinned.object_id = o.id"}
       JOIN artifacts a ON a.project_id = o.project_id AND a.object_id = o.id
       JOIN artifact_versions v ON v.project_id = o.project_id AND v.version_id = ${pin === undefined ? "o.current_version_id" : "pinned.version_id"}
       JOIN object_versions ov ON ov.project_id = v.project_id AND ov.id = v.version_id
       JOIN mutation_commits mc ON mc.project_id = ov.project_id AND mc.id = ov.tx_id
      WHERE o.project_id = ? AND o.kind = 'artifact'
      ORDER BY o.display_no`,
    ...pin_params,
    project_id,
  );
  const round_no_by_id = round_no_of;
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
  const library_items: Dict[] = [];
  const chat_inputs: Array<{ name: string; text: string }> = [];

  for (const row of artifacts) {
    const meta = record(parse(row.metadata_json, {}));
    const extra = record(meta.legacy_extra);
    const get = (field: string): unknown => (field in meta ? meta[field] : extra[field]);
    const kind = String(row.kind);
    const stage_key = typeof row.stage_id === "string" ? (stage_key_of.get(row.stage_id) ?? null) : null;
    const role = typeof meta.role === "string" ? meta.role : "";
    const rowid = num(row.version_rowid);

    if (kind === "note") {
      if (role === "chat_input") {
        // `pes chat`: v0.15 wrote an answer file (via chat) and marked it processed at once
        const stamp = local_stamp(num(row.created_at));
        const name = `chat-${String(row.object_id)}.json`;
        chat_inputs.push({
          name,
          text: JSON.stringify({ stage: typeof meta.stage === "string" ? meta.stage : "", round: typeof meta.round === "number" ? meta.round : 0, time: `${stamp.slice(0, 10).replace(/-/g, "")}-${stamp.slice(11, 13)}${stamp.slice(14, 16)}00`, kind: typeof meta.input_kind === "string" ? meta.input_kind : "feedback", text: row.body_md ?? "", via: "chat" }),
        });
        continue;
      }
      if (role === "handoff_note") {
        notes.push({ rowid, note: { time: local_stamp(num(row.created_at)), stage: typeof meta.stage === "string" ? meta.stage : meta.stage === null ? null : p.current, text: row.body_md ?? "" } });
        continue;
      }
      if (role === "" && truthy(extra.note) && !("legacy_id" in extra)) {
        notes.push({ rowid, note: record(extra.note) });
        continue;
      }
      if (!("legacy_id" in extra) && !("legacy_id" in meta)) continue;
    }
    if (kind === "review") {
      // `pes set`: one value per (stage or project, field), kept in the newest version of an invisible review artifact (cli_bridge set_field)
      if ((meta.role === "stage_field" || meta.role === "project_field") && typeof meta.field === "string") {
        if (meta.role === "stage_field" && stage_key !== null) {
          (p.stages[stage_key] as Dict)[meta.field] = meta.value;
          if (stage_key === "plan" && meta.field === "settings" && is_dict(meta.value)) p.settings = meta.value;
        } else if (meta.role === "project_field") {
          p[meta.field] = meta.value;
        }
        continue;
      }
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
      if ("legacy_id" in extra) library_items.push(library_item(row, extra, citations.get(String(row.version_id)) ?? []));
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
    // written by a DB-path merge (an imported item's reuse/user_links stay where the importer put them)
    if (meta.reuse !== undefined && meta.reuse !== null && meta.reuse !== "") item.reuse = meta.reuse;
    if (Array.isArray(meta.user_links)) item.user_links = meta.user_links;
    const open = meta.open_questions;
    if (Array.isArray(open) && stage_key !== null) {
      const list = suggestions.get(stage_key) ?? [];
      for (const q of open) list.push(`[#${String(item.id)}] ${String(q)}`);
      suggestions.set(stage_key, list);
    }
    ((p.stages[stage_key] as Dict).items as Dict[]).push(item);
  }

  // The newest AI-check (purpose review) question set of each stage is the stage's review box.
  if (pin === undefined) {
    for (const stage of stages) {
      const set = db.get<{ id: string; form_key: string; round_id: string | null }>(
        `SELECT id, form_key, round_id FROM question_sets
          WHERE project_id = ? AND stage_id = ? AND purpose = 'review' ORDER BY rowid DESC LIMIT 1`,
        project_id,
        stage.id,
      );
      if (set === undefined) continue;
      const questions = review_questions(db, project_id, set.id);
      if (questions.length === 0) continue;
      const st = p.stages[stage.key] as Dict;
      // The round the check is about: the round open when it was published; else the `-r<N>` of the form id; else the newest round.
      const tail = set.form_key.match(/-r(\d+)$/i);
      const round = set.round_id !== null && round_no_by_id.has(set.round_id)
        ? (round_no_by_id.get(set.round_id) as number)
        : tail !== null
          ? Number(tail[1])
          : num(st.round);
      // form_key·set_id: the screen sends them with the answer, so an answer to a revised form is refused (409) by the
      // same newest-version check the command makes, instead of being stored without its form version.
      st.review = { round, questions, form_key: set.form_key, set_id: set.id };
    }
  }

  notes.sort((a, b) => a.rowid - b.rowid);
  p.notes = notes.map((entry) => entry.note);
  // v0.15 wrote `notes` into project.json with its first save; a project nothing has been saved to (only created, asked) has no such key
  const touched = rounds.length > 0 || approved_rows.length > 0 || Object.values(p.stages as Record<string, Dict>).some((st) => (st.items as unknown[]).length > 0);
  if (!touched && notes.length === 0 && options.pin === undefined) delete p.notes;
  for (const key of STAGE_KEYS) {
    const st = p.stages[key] as Dict;
    st.suggestions = suggestions.get(key) ?? [];
    st.qa = (qas.get(key) ?? []).sort((a, b) => a.rowid - b.rowid).map((entry) => entry.qa);
    st.review_log = (review_logs.get(key) ?? []).sort((a, b) => a.rowid - b.rowid).map((entry) => entry.log);
  }
  // the library's own keys (source, imported, round, topic, settings ...): the importer keeps them in the edition, `pes init --import` in the event
  let library_shell = record(edition_extra.library);
  if (!truthy(edition_extra.library)) {
    const imported = db.get<{ payload: string }>(
      `SELECT payload FROM events WHERE project_id = ? AND type = 'content.library_imported' AND json_extract(payload, '$.original') IS NOT NULL ORDER BY event_seq LIMIT 1`,
      project_id,
    );
    const original = record(record(parse(imported?.payload, {})).original);
    library_shell = Object.fromEntries(Object.entries(original).filter(([key]) => key !== "items"));
  }
  if (library_items.length > 0 || truthy(library_shell)) {
    p.library = { ...library_shell, items: library_items };
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
  const snapshot_round = new Map<string, number>();
  for (const row of db.all<{ id: string; round_id: string | null }>("SELECT id, round_id FROM snapshots WHERE project_id = ?", project_id)) {
    if (row.round_id !== null && round_no_of.has(row.round_id)) snapshot_round.set(row.id, round_no_of.get(row.round_id) as number);
  }
  for (const event of db.all<{ type: string; payload: string; at: bigint | null }>(
    `SELECT e.type AS type, e.payload AS payload,
            (SELECT mc.created_at FROM mutation_commits mc WHERE mc.project_id = e.project_id AND mc.id = e.tx_id) AS at
       FROM events e
      WHERE e.project_id = ?
        AND (e.type IN ('legacy.processed', 'input.marked_processed', 'legacy.history', 'stage.reopened')
             OR (e.type = 'stage.approved'
                 AND EXISTS (SELECT 1 FROM approvals ap WHERE ap.project_id = e.project_id AND ap.id = json_extract(e.payload, '$.approval_id') AND ap.origin = 'new')))
      ORDER BY e.rowid`,
    project_id,
  )) {
    const payload = record(parse(event.payload, {}));
    // what v0.15 wrote into a stage's history when a stage was approved / reopened (the CLI's quiet reopen of a re-approval is not one)
    if (event.type === "stage.approved" || event.type === "stage.reopened") {
      const key = typeof payload.stage_id === "string" ? stage_key_of.get(payload.stage_id) : undefined;
      const st = key === undefined ? undefined : (p.stages[key] as Dict | undefined);
      if (st === undefined || (event.type === "stage.reopened" && payload.reason === REAPPROVE_REASON)) continue;
      const stamp = local_stamp(num(event.at));
      if (event.type === "stage.reopened") st.history.push(`다시 열기 ${stamp}`);
      else st.history.push(`승인 ${stamp} (R${typeof payload.snapshot_id === "string" ? (snapshot_round.get(payload.snapshot_id) ?? 0) : 0})`);
      continue;
    }
    if (event.type === "legacy.processed" && typeof payload.name === "string") processed.add(payload.name);
    else if (event.type === "input.marked_processed" && Array.isArray(payload.names)) {
      for (const name of payload.names) if (typeof name === "string") processed.add(name);
    } else if (event.type === "legacy.history" && typeof payload.stage === "string" && typeof payload.line === "string") {
      const st = p.stages[payload.stage] as Dict | undefined;
      if (st !== undefined) st.history.push(payload.line);
    }
  }
  for (const chat of chat_inputs) processed.add(chat.name);
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
  files.push(...chat_inputs);
  return { project: p, pending, feedback: feedback_entries(files, processed) };
}

/**
 * The questions of one published set in the shape the dashboard's review box reads (label, options, show_if, ...).
 * A question's id is its DB question id, and so is every `show_if.id`: the form author wrote `show_if` against the
 * spec's own question ids, which the DB does not keep. `pes ask` stores the referenced question's place in the same form
 * (`show_if.position`); a migrated v0.15 question keeps its spec id as `bank_key`. A reference that cannot be resolved
 * is dropped (the question is always shown) rather than left pointing at no question, which would hide it for good
 * and let a required question go unanswered.
 */
export function review_questions(db: Pick<Db, "all">, project_id: string, set_id: string): Dict[] {
  const rows = db.all<{ id: string; version_id: string; bank_key: string | null; text: string; type: string; required: bigint; other: bigint; options: string; show_if: string; help: string | null }>(
    `SELECT m.question_id AS id, m.question_version_id AS version_id, q.bank_key AS bank_key, qv.text AS text, qv.type AS type,
            qv.required AS required, qv.allow_comment_as_answer AS other, qv.options AS options, qv.show_if AS show_if, qv.help AS help
       FROM question_set_members m
       JOIN question_versions qv ON qv.project_id = m.project_id AND qv.version_id = m.question_version_id
       LEFT JOIN questions q ON q.project_id = m.project_id AND q.object_id = m.question_id
      WHERE m.project_id = ? AND m.set_id = ?
      ORDER BY m.position`,
    project_id,
    set_id,
  );
  const ids = new Set(rows.map((row) => row.id));
  const by_bank_key = new Map<string, string>();
  for (const row of rows) if (typeof row.bank_key === "string" && !by_bank_key.has(row.bank_key)) by_bank_key.set(row.bank_key, row.id);
  // `position` is a place in the set where this question version was first published. In that set it is used as is;
  // in another set (the same version re-used by question_id) only when the question it named there sits at the same
  // place here, or the question at that place carries the referenced spec id as bank_key. Otherwise: id, then bank_key.
  const first_target = (version_id: string, position: number): { set_id: string; question_id: string | null } | null => {
    const first = db.all<{ set_id: string }>(
      `SELECT m.set_id AS set_id FROM question_set_members m
         JOIN question_sets s ON s.project_id = m.project_id AND s.id = m.set_id
        WHERE m.project_id = ? AND m.question_version_id = ?
        ORDER BY s.rowid LIMIT 1`,
      project_id,
      version_id,
    )[0];
    if (first === undefined) return null;
    const at = db.all<{ question_id: string }>(
      "SELECT question_id FROM question_set_members WHERE project_id = ? AND set_id = ? AND position = ?",
      project_id,
      first.set_id,
      position,
    )[0];
    return { set_id: first.set_id, question_id: at?.question_id ?? null };
  };
  const resolve = (row: { version_id: string }, show_if: Record<string, unknown>): string | null => {
    const position = show_if.position;
    const ref = show_if.id;
    if (typeof position === "number" && Number.isInteger(position) && position >= 0 && position < rows.length) {
      const here = rows[position] as { id: string; bank_key: string | null };
      const first = first_target(row.version_id, position);
      if (first !== null && first.set_id === set_id) return here.id;
      if (first !== null && first.question_id === here.id) return here.id;
      if (typeof ref === "string" && here.bank_key === ref) return here.id;
    }
    if (typeof ref !== "string") return null;
    if (ids.has(ref)) return ref;
    return by_bank_key.get(ref) ?? null;
  };
  return rows.map((row) => {
    const question: Dict = { id: row.id, type: row.type, label: row.text, required: num(row.required) === 1, other: num(row.other) === 1 };
    const options = parse(row.options, []);
    if (Array.isArray(options) && options.length > 0) question.options = options;
    const show_if = parse(row.show_if, null);
    if (is_dict(show_if)) {
      const target = resolve(row, show_if);
      if (target !== null && target !== row.id) {
        const { position: _position, ...rest } = show_if;
        question.show_if = { ...rest, id: target };
      }
    }
    if (typeof row.help === "string" && row.help.length > 0) question.help = row.help;
    return question;
  });
}

export interface SnapshotEntry {
  stage: string;
  round: number;
  time: string;
  state: Dict;
}

const SLIM_FIELDS = ["id", "title", "kind", "status", "request", "depth", "updated_round", "summary", "confidence", "conflicts", "verdict"];

/**
 * pes.py `build_index` snapshots: one slim state per sealed round (what that round showed), stage order then round.
 * The sealed round's own items are the versions in its round_contents. `changes` was a project.json list the DB does not keep.
 */
export function build_snapshots(db: Pick<Db, "get" | "all">, project_id: string, objects_dir: string): SnapshotEntry[] {
  const rows = db.all<{ round_id: string; round_no: bigint; stage_key: string; ordinal: bigint; at: bigint | null }>(
    `SELECT r.id AS round_id, r.round_no AS round_no, st.key AS stage_key, st.ordinal AS ordinal,
            (SELECT mc.created_at FROM mutation_commits mc
              WHERE mc.project_id = r.project_id AND mc.action = 'round.sealed'
                AND json_extract(mc.result_json, '$.round_id') = r.id) AS at
       FROM rounds r
       JOIN stages st ON st.project_id = r.project_id AND st.id = r.stage_id
       JOIN projects p ON p.id = r.project_id AND p.active_edition_id = r.edition_id
      WHERE r.project_id = ? AND r.state = 'sealed'
      ORDER BY st.ordinal, r.round_no`,
    project_id,
  );
  const out: SnapshotEntry[] = [];
  for (const row of rows) {
    const pin = new Map<string, string>();
    for (const content of db.all<{ object_id: string; version_id: string }>(
      "SELECT object_id, version_id FROM round_contents WHERE project_id = ? AND round_id = ? ORDER BY position",
      project_id,
      row.round_id,
    )) {
      pin.set(content.object_id, content.version_id);
    }
    const view = build_project_view(db, project_id, objects_dir, { pin });
    const stage = view.project.stages[row.stage_key] as Dict;
    const items = ((stage.items as Dict[] | undefined) ?? []).map((item) => {
      const slim: Dict = {};
      for (const field of SLIM_FIELDS) slim[field] = field in item ? item[field] : null;
      slim.n_sources = Array.isArray(item.sources) ? item.sources.length : 0;
      slim.n_stats = Array.isArray(item.stats) ? item.stats.length : 0;
      slim.details_len = typeof item.details === "string" ? item.details.length : 0;
      return slim;
    });
    out.push({
      stage: row.stage_key,
      round: num(row.round_no),
      time: local_stamp(num(row.at)),
      state: {
        round: num(row.round_no),
        status: "active",
        changes: [],
        items,
        n_suggestions: Array.isArray(stage.suggestions) ? stage.suggestions.length : 0,
        review: null,
      },
    });
  }
  return out;
}

/** The files of the project's current final report, as the old `out/<name>` list the dashboard shows. */
export function output_names(db: Pick<Db, "get" | "all">, project_id: string): string[] {
  const row = db.get<{ version_id: string }>(
    `SELECT o.current_version_id AS version_id
       FROM objects o
       JOIN artifacts a ON a.project_id = o.project_id AND a.object_id = o.id
       JOIN artifact_versions v ON v.project_id = o.project_id AND v.version_id = o.current_version_id
      WHERE o.project_id = ? AND o.kind = 'artifact' AND a.kind = 'output'
        AND json_extract(v.metadata_json, '$.role') = 'final_output'
      ORDER BY o.display_no LIMIT 1`,
    project_id,
  );
  if (row === undefined) return [];
  return rendered_files(db, project_id, row.version_id).map((file) => `out/${file.name}`).sort();
}

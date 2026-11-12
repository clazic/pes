// Reference material from earlier projects (stage 3 REF1a, SEL-113): the read side and the one decision function.
//
// A reference is a read-only pointer from the current project to ONE snapshot of another project (table
// project_references, DDL 001; no new table). The write side lives in commands/references.ts (reference.attach /
// detach / refresh / source_gone). Everything here only reads: it never writes, so a GET has no side effect.
//
// ONE function decides what a caller may get out of a reference: decide(). Every exit that can hand reference text to
// an AI goes through it — the HTTP routes (GET P/references, GET P/references/{ref}, GET P/context, which the B MCP
// tool reads) and the built-in runner's context.get (A). A new exit must call decide() too; do not copy its rules.
//
//   permission  the acting actor's HUMAN user must be a member of the source project (project_members). Without it the
//               row is three keys — {id, access:'no_permission', state:'no_permission'} — and no content: not the
//               name, not the key, not a version id.
//   Go          the stricter side wins. If the source project OR the current project has OpenCode Go OFF (or its policy
//               is missing/damaged: fail closed), an AI caller (a token, the A tool) gets content = null and
//               ai_delivery = {allowed:false, withheld_reason}. A person (the owner session) is not affected.
//   original    status 'source_missing' (tombstone): no content for anyone; ai_delivery.withheld_reason = 'source_missing'.
//   content     content.items_status tells, per scope item, ok | none | not_supported | snapshot_content_unavailable (see
//               ReferenceItemStatus): an empty list is never silent about why it is empty.
//   AI files    an item of the source project (a report version, a source version) that the SOURCE project's own AI decision closes
//               (version_ai_denied, the same function every other AI exit uses, asked about the source project id) is left out of
//               content.items for an AI caller — whole, with no placeholder and no count. Judged at read time; a person is not affected.
//   new version a GET computes it (the source's newest snapshot differs from the pinned one); nothing is written.

import { read_credential_actor } from "./actors.ts";
import type { Db } from "./db.ts";
import { version_ai_denied } from "./commands/file_access.ts";
import { ApiError } from "./errors.ts";
import { current_policy } from "./policy.ts";

type ReadDb = Pick<Db, "get" | "all">;

/** The items a person can choose to attach. REF1a delivers content for final_report and sources; the others are kept in scope for later. */
export const REFERENCE_SCOPE_ITEMS: readonly string[] = ["final_report", "stage_report", "sources", "decisions", "questions_answers", "files"];
export const DEFAULT_REFERENCE_SCOPE: readonly string[] = ["final_report", "sources"];
/** The items whose content REF1a delivers. The other scope items can be chosen (for later) but are reported as not_supported. */
export const SUPPORTED_REFERENCE_ITEMS: readonly string[] = ["final_report", "sources"];

/**
 * What a scope item came out as, so a reader (person, A, B, HTTP: all get the same object) can tell three empties apart:
 *   ok                            the snapshot holds at least one such item
 *   none                          the item is supported and the snapshot was read, but it holds none
 *   not_supported                 this item is not delivered yet (REF1a delivers final_report and sources)
 *   snapshot_content_unavailable  the snapshot's contents cannot be read (no receipt, no sealed round contents — e.g. a
 *                                 legacy stage snapshot), so "none" cannot be claimed
 */
export type ReferenceItemStatus = "ok" | "none" | "not_supported" | "snapshot_content_unavailable";

export interface ReferenceContent {
  items: Array<Record<string, unknown>>;
  items_status: Record<string, ReferenceItemStatus>;
}

export const REFERENCE_NO_PERMISSION_KEYS: readonly string[] = ["access", "id", "state"];

export type WithheldReason = "source_missing" | "source_go_off" | "project_go_off";

export interface ReferenceDelivery {
  allowed: boolean;
  withheld_reason: WithheldReason | null;
}

/** Who is asking: the actor, the human user behind it, and whether the answer goes to an AI. */
export interface ReferenceCaller {
  actor_id: string;
  user_id: string;
  /** true for a token or the built-in runner; false for the owner's session. */
  ai: boolean;
}

export interface ReferenceRow {
  id: string;
  project_id: string;
  referenced_project_id: string | null;
  referenced_project_key: string;
  source_snapshot_id: string | null;
  source_snapshot_key: string | null;
  source_label: string;
  latest_snapshot_id: string | null;
  scope_json: string;
  status: string;
  attached_by_actor_id: string;
  attached_by_user_id: string;
  attached_at: bigint;
  refreshed_at: bigint | null;
  rev: bigint;
}

const SELECT_ROW = `SELECT id, project_id, referenced_project_id, referenced_project_key, source_snapshot_id, source_snapshot_key,
       source_label, latest_snapshot_id, scope_json, status, attached_by_actor_id, attached_by_user_id,
       attached_at, refreshed_at, rev
  FROM project_references`;

export function reference_rows(db: ReadDb, project_id: string): ReferenceRow[] {
  return db.all<ReferenceRow>(`${SELECT_ROW} WHERE project_id = ? ORDER BY rowid`, project_id);
}

export function reference_row(db: ReadDb, project_id: string, reference_id: string): ReferenceRow | undefined {
  return db.get<ReferenceRow>(`${SELECT_ROW} WHERE project_id = ? AND id = ?`, project_id, reference_id);
}

/** The caller behind an actor id. An actor that is gone or disabled is forbidden, like everywhere else. */
export function reference_caller(db: ReadDb, actor_id: string, ai: boolean): ReferenceCaller {
  const actor = read_credential_actor(db, actor_id);
  if (actor === undefined) throw new ApiError("forbidden", "the actor is not allowed in this project");
  return { actor_id: actor.actor_id, user_id: actor.user_id, ai };
}

/** Is this user a member (any role) of the project? */
export function is_member(db: ReadDb, project_id: string, user_id: string): boolean {
  return db.get("SELECT 1 AS ok FROM project_members WHERE project_id = ? AND user_id = ?", project_id, user_id) !== undefined;
}

/**
 * A print (SEL-119 U6a) is stored as a snapshot too, told apart by its print.committed event. It is a human's fixed document,
 * not a version selection a reference can pin: it is never the newest snapshot, and naming one is refused.
 */
const IS_PRINT_SNAPSHOT = `EXISTS (SELECT 1 FROM events e WHERE e.project_id = s.project_id AND e.type = 'print.committed' AND json_extract(e.payload, '$.snapshot_id') = s.id)`;

/** A snapshot of this project that a reference may pin (not a print), or undefined. */
export function pinnable_snapshot_id(db: ReadDb, project_id: string, snapshot_id: string): string | undefined {
  return db.get<{ id: string }>(`SELECT s.id AS id FROM snapshots s WHERE s.project_id = ? AND s.id = ? AND NOT ${IS_PRINT_SNAPSHOT}`, project_id, snapshot_id)?.id;
}

/** The newest snapshot of a project (by the order they were taken) that is not a print, or null. */
export function newest_snapshot_id(db: ReadDb, project_id: string): string | null {
  return db.get<{ id: string }>(`SELECT s.id AS id FROM snapshots s WHERE s.project_id = ? AND NOT ${IS_PRINT_SNAPSHOT} ORDER BY s.rowid DESC LIMIT 1`, project_id)?.id ?? null;
}

/** Go switch of a project. A missing or damaged policy reads as OFF (fail closed). */
function go_allowed(db: ReadDb, project_id: string): boolean {
  try {
    return current_policy(db, project_id).allow_opencode_go;
  } catch {
    return false;
  }
}

export interface ReferenceDecision {
  /** the caller's user is a member of the source (a tombstone with no source project needs no membership) */
  has_access: boolean;
  /** what an AI may be given */
  delivery: ReferenceDelivery;
  /** the content may be returned to THIS caller */
  content_allowed: boolean;
}

/**
 * The one decision about a reference (permission + Go + original gone). Pure reads; no side effect.
 * Both Go switches are looked at here and nowhere else.
 */
export function decide(db: ReadDb, row: ReferenceRow, caller: ReferenceCaller): ReferenceDecision {
  const has_access = row.referenced_project_id === null ? true : is_member(db, row.referenced_project_id, caller.user_id);
  let reason: WithheldReason | null = null;
  if (row.status === "source_missing" || row.referenced_project_id === null || row.source_snapshot_id === null) reason = "source_missing";
  else if (!go_allowed(db, row.referenced_project_id)) reason = "source_go_off";
  else if (!go_allowed(db, row.project_id)) reason = "project_go_off";
  const delivery: ReferenceDelivery = { allowed: reason === null, withheld_reason: reason };
  const present = row.status !== "source_missing" && row.referenced_project_id !== null && row.source_snapshot_id !== null;
  return { has_access, delivery, content_allowed: has_access && present && (!caller.ai || delivery.allowed) };
}

function iso(ms: bigint | null): string | null {
  return ms === null ? null : new Date(Number(ms)).toISOString();
}

function parse_scope(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/** One row of the list as the readers see it (sixteen keys, or the three of "no permission"). */
export function reference_view(db: ReadDb, row: ReferenceRow, caller: ReferenceCaller, decision?: ReferenceDecision): Record<string, unknown> {
  const d = decision ?? decide(db, row, caller);
  if (!d.has_access) return { id: row.id, access: "no_permission", state: "no_permission" };
  const live = row.status !== "source_missing" && row.referenced_project_id !== null;
  const latest = live ? newest_snapshot_id(db, row.referenced_project_id as string) : null;
  const new_version = row.status === "active" && latest !== null && latest !== row.source_snapshot_id;
  const state = row.status === "source_missing" ? "source_missing" : row.status === "source_archived" ? "source_archived" : new_version ? "new_version" : "pinned";
  return {
    access: "ok",
    ai_delivery: { allowed: d.delivery.allowed, withheld_reason: d.delivery.withheld_reason },
    attached_at: iso(row.attached_at),
    attached_by_actor_id: row.attached_by_actor_id,
    id: row.id,
    latest_snapshot_id: latest,
    new_version_available: new_version,
    referenced_project_id: row.referenced_project_id,
    referenced_project_key: row.referenced_project_key,
    refreshed_at: iso(row.refreshed_at),
    rev: row.rev.toString(),
    scope: parse_scope(row.scope_json),
    source_label: row.source_label,
    source_snapshot_id: row.source_snapshot_id,
    source_snapshot_key: row.source_snapshot_key,
    state,
  };
}

/** The list of a project's references (rows only, never a body). */
export function list_references(db: ReadDb, project_id: string, caller: ReferenceCaller): Array<Record<string, unknown>> {
  return reference_rows(db, project_id).map((row) => reference_view(db, row, caller));
}

// ---------------------------------------------------------------------------
// content of the pinned snapshot

interface VersionRef {
  object_id: string;
  version_id: string;
}

/**
 * The versions a snapshot holds: the receipt of the command that took it, else the sealed round's contents.
 * readable=false when neither source can be read — then an empty list means "unknown", not "nothing in it".
 */
function snapshot_versions(db: ReadDb, project_id: string, snapshot_id: string): { versions: VersionRef[]; readable: boolean } {
  const receipt = db.get<{ result_json: string }>(
    `SELECT result_json FROM mutation_commits
      WHERE project_id = ? AND action IN ('edition.snapshotted', 'round.sealed') AND json_extract(result_json, '$.snapshot_id') = ?
      ORDER BY rowid LIMIT 1`,
    project_id,
    snapshot_id,
  );
  if (receipt !== undefined) {
    try {
      const parsed = JSON.parse(receipt.result_json) as { versions?: unknown };
      if (Array.isArray(parsed.versions)) {
        const versions = parsed.versions.flatMap((entry): VersionRef[] => {
          const e = entry as { object_id?: unknown; version_id?: unknown };
          return typeof e.object_id === "string" && typeof e.version_id === "string" ? [{ object_id: e.object_id, version_id: e.version_id }] : [];
        });
        return { versions, readable: true };
      }
    } catch {
      // damaged receipt: fall through to the round contents
    }
  }
  // A round-scope snapshot keeps its contents in round_contents. A stage/edition-scope snapshot has no round (round_id NULL):
  // the join finds nothing — a legacy import's stage snapshot is exactly that (its manifest only says legacy_unverified).
  const versions = db.all<VersionRef>(
    `SELECT rc.object_id AS object_id, rc.version_id AS version_id
       FROM snapshots s JOIN round_contents rc ON rc.project_id = s.project_id AND rc.round_id = s.round_id
      WHERE s.project_id = ? AND s.id = ? ORDER BY rc.position`,
    project_id,
    snapshot_id,
  );
  return { versions, readable: versions.length > 0 };
}

/**
 * The pinned content: the chosen items of the pinned snapshot, each with its citation (which project, label, snapshot,
 * object, version). It is the version the snapshot holds — a newer version in the source does not change it.
 * items_status says, per scope item, why there are (or are no) items of it.
 *
 * For an AI caller (ai=true) an item that the source project closes to AI (version_ai_denied on the source project id) is skipped
 * as if it were not in the snapshot: items_status counts only what the AI may see, and nothing says something was held back.
 */
export function reference_content(db: ReadDb, row: ReferenceRow, ai: boolean = true): ReferenceContent {
  const project_id = row.referenced_project_id as string;
  const snapshot_id = row.source_snapshot_id as string;
  const scope = parse_scope(row.scope_json);
  const { versions, readable } = snapshot_versions(db, project_id, snapshot_id);
  const citation = (v: VersionRef): Record<string, unknown> => ({
    reference_id: row.id,
    project_id,
    project_label: row.source_label,
    snapshot_id,
    object_id: v.object_id,
    version_id: v.version_id,
  });
  const items: Array<Record<string, unknown>> = [];
  const items_status: Record<string, ReferenceItemStatus> = {};
  for (const item of scope) {
    if (item in items_status) continue;
    if (!SUPPORTED_REFERENCE_ITEMS.includes(item)) {
      items_status[item] = "not_supported";
      continue;
    }
    if (!readable) {
      items_status[item] = "snapshot_content_unavailable";
      continue;
    }
    let found = 0;
    // read-time AI decision of the source project, per item (a closed file material is closed by object, a report by its version)
    const closed = (v: VersionRef): boolean => ai && version_ai_denied(db, project_id, v.version_id);
    if (item === "final_report") {
      for (const v of versions) {
        if (closed(v)) continue;
        const a = db.get<{ kind: string; title: string; summary: string; body_md: string | null }>(
          `SELECT a.kind AS kind, av.title AS title, av.summary AS summary, av.body_md AS body_md
             FROM artifact_versions av JOIN artifacts a ON a.project_id = av.project_id AND a.object_id = av.object_id
            WHERE av.project_id = ? AND av.version_id = ? AND av.object_id = ?`,
          project_id,
          v.version_id,
          v.object_id,
        );
        if (a === undefined || a.kind !== "report") continue;
        items.push({ item, object_id: v.object_id, version_id: v.version_id, kind: a.kind, title: a.title, summary: a.summary, body_md: a.body_md, citation: citation(v) });
        found += 1;
      }
    } else if (item === "sources") {
      for (const v of versions) {
        if (closed(v)) continue;
        const s = db.get<{ kind: string; title: string; url: string | null; quote: string | null }>(
          `SELECT s.kind AS kind, sv.title AS title, sv.url AS url, sv.quote AS quote
             FROM source_versions sv JOIN sources s ON s.project_id = sv.project_id AND s.object_id = sv.object_id
            WHERE sv.project_id = ? AND sv.version_id = ? AND sv.object_id = ?`,
          project_id,
          v.version_id,
          v.object_id,
        );
        if (s === undefined) continue;
        items.push({ item, object_id: v.object_id, version_id: v.version_id, kind: s.kind, title: s.title, url: s.url, quote: s.quote, citation: citation(v) });
        found += 1;
      }
    }
    items_status[item] = found > 0 ? "ok" : "none";
  }
  return { items, items_status };
}

/**
 * The read of ONE reference: {reference, content}. No access → forbidden (nothing about the source). Unknown id, or an id of
 * another project → not_found. content is null when the original is gone, or when the caller is an AI and Go is OFF on either side.
 */
export function read_reference(db: ReadDb, project_id: string, reference_id: string, caller: ReferenceCaller): { reference: Record<string, unknown>; content: ReferenceContent | null } {
  const row = reference_row(db, project_id, reference_id);
  if (row === undefined) throw new ApiError("not_found", "reference not found");
  const decision = decide(db, row, caller);
  if (!decision.has_access) throw new ApiError("forbidden", "no permission for this reference");
  return {
    reference: reference_view(db, row, caller, decision),
    content: decision.content_allowed ? reference_content(db, row, caller.ai) : null,
  };
}

// ---------------------------------------------------------------------------
// candidates (SEL-120 REF1c): which other projects the person may attach, and which snapshots of each

export interface ReferenceCandidateSnapshot {
  id: string;
  key: string;
  /** the server keeps no snapshot name: null, never made up (the app shows the key) */
  label: null;
  /** some stage approval points at this snapshot */
  approved: boolean;
  /** exactly one per project: the newest approved snapshot, else the newest */
  recommended: boolean;
}

export interface ReferenceCandidate {
  project_id: string;
  key: string;
  label: string;
  /** this project already holds a reference line for it (the key stays after a tombstone) */
  attached: boolean;
  snapshots: ReferenceCandidateSnapshot[];
}

/**
 * The projects the person could attach as reference material from `project_id`, each with the snapshots a reference may pin.
 * Pure reads. Permission is is_member() — the same rule decide() applies to an attached line — so a project the person is not
 * in leaves no trace. A person is not held back by Go (decide() treats the owner session the same way). Queries: a constant
 * number per project, none per snapshot.
 */
export function list_reference_candidates(db: ReadDb, project_id: string, caller: ReferenceCaller): ReferenceCandidate[] {
  const attached = new Set(reference_rows(db, project_id).map((row) => row.referenced_project_key));
  const projects = db.all<{ id: string; slug: string; topic: string }>(
    "SELECT id, slug, topic FROM projects WHERE id <> ? AND status <> 'archived' ORDER BY rowid",
    project_id,
  );
  const out: ReferenceCandidate[] = [];
  for (const p of projects) {
    if (!is_member(db, p.id, caller.user_id)) continue;
    const rows = db.all<{ id: string; approved: bigint }>(
      `SELECT s.id AS id, EXISTS (SELECT 1 FROM approvals a WHERE a.project_id = s.project_id AND a.snapshot_id = s.id) AS approved
         FROM snapshots s WHERE s.project_id = ? AND NOT ${IS_PRINT_SNAPSHOT} ORDER BY s.rowid DESC`,
      p.id,
    );
    const recommended = rows.find((r) => Number(r.approved) !== 0)?.id ?? rows[0]?.id;
    out.push({
      project_id: p.id,
      key: p.id,
      label: p.topic.trim().length > 0 ? p.topic : p.slug,
      attached: attached.has(p.id),
      snapshots: rows.map((r) => ({ id: r.id, key: r.id, label: null, approved: Number(r.approved) !== 0, recommended: r.id === recommended })),
    });
  }
  return out;
}

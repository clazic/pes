// "May AI see this file?" — the one rule, and the reads of "my materials" built on it (SEL-115 MAT1a).
//
// Every exit that hands file facts to something that is not the human owner goes through the functions
// here: the HTTP API (GET context / materials / version / files content / preview), the MCP tools (they call
// the HTTP API), the A built-in tools (context.get) and the prompt they assemble. No exit keeps its own copy of the rule.
//
// The rule (strict side wins):
//   - one policy row per blob (file_policies); role and version uses share it, so no use is more permissive than the blob;
//   - a deny in the policy row OR in its newest history row (file_ai_access_versions) is a deny;
//   - a blob with no policy row has no recorded deny, so it is not denied;
//   - the project's Go switch is a separate gate (routes marked `go`), applied before this rule is reached.
//
// This module only reads. Writes to file_policies / file_ai_access_versions are in commands/files.ts.

import type { Db } from "../db.ts";

type ReadDb = Pick<Db, "get" | "all">;

export type AiAccess = "allow" | "deny";

export interface AccessState {
  policy_id: string;
  blob_id: string;
  /** file_policies.ai_access */
  current: AiAccess;
  /** the newest file_ai_access_versions row, or null when the history is empty */
  latest: AiAccess | null;
  /** file_policies.rev */
  rev: number;
  /** the newest history rev, or 0 when the history is empty */
  latest_rev: number;
  /** the value in force: deny when either layer says deny */
  effective: AiAccess;
}

interface AccessRow {
  policy_id: string;
  blob_id: string;
  current: string;
  rev: bigint;
  latest: string | null;
  latest_rev: bigint | null;
}

function as_access(value: string | null): AiAccess | null {
  if (value === null) return null;
  // Anything that is not exactly "allow" is treated as deny; the schema CHECK keeps this theoretical.
  return value === "allow" ? "allow" : "deny";
}

function state_of(row: AccessRow): AccessState {
  const current = as_access(row.current) as AiAccess;
  const latest = as_access(row.latest);
  return {
    policy_id: row.policy_id,
    blob_id: row.blob_id,
    current,
    latest,
    rev: Number(row.rev),
    latest_rev: row.latest_rev === null ? 0 : Number(row.latest_rev),
    effective: current === "deny" || latest === "deny" ? "deny" : "allow",
  };
}

const STATE_SQL = `SELECT p.id AS policy_id, p.blob_id AS blob_id, p.ai_access AS current, p.rev AS rev,
       (SELECT a.ai_access FROM file_ai_access_versions a
         WHERE a.project_id = p.project_id AND a.file_policy_id = p.id ORDER BY a.rev DESC LIMIT 1) AS latest,
       (SELECT MAX(a.rev) FROM file_ai_access_versions a
         WHERE a.project_id = p.project_id AND a.file_policy_id = p.id) AS latest_rev
  FROM file_policies p`;

/** The access state of the policy of a blob, or undefined when the blob has no policy row. */
export function access_state_of_blob(db: ReadDb, project_id: string, blob_id: string): AccessState | undefined {
  const row = db.get<AccessRow>(`${STATE_SQL} WHERE p.project_id = ? AND p.blob_id = ?`, project_id, blob_id);
  return row === undefined ? undefined : state_of(row);
}

/** The access state of a policy by its id, or undefined when this project has no such policy. */
export function access_state_of_policy(db: ReadDb, project_id: string, policy_id: string): AccessState | undefined {
  const row = db.get<AccessRow>(`${STATE_SQL} WHERE p.project_id = ? AND p.id = ?`, project_id, policy_id);
  return row === undefined ? undefined : state_of(row);
}

/**
 * THE decision: is this blob closed to AI? True for a deny in the policy row or the newest history row.
 * A blob without a policy row has no recorded deny (it is not attached to anything yet), so it is not denied.
 */
export function file_ai_denied(db: ReadDb, project_id: string, blob_id: string): boolean {
  return access_state_of_blob(db, project_id, blob_id)?.effective === "deny";
}

// ---------------------------------------------------------------------------
// Exits that carry a material's identity without carrying its file (manifest, version read, change feed).
// A material is a source object of kind file; its title defaults to the file name, so the object, its versions and the
// events about them name the file. They follow the same decision (file_ai_denied) — no exit keeps its own copy.

const MATERIAL_FILES_SQL = `SELECT vf.blob_id AS blob_id
  FROM version_files vf
  JOIN object_versions ov ON ov.project_id = vf.project_id AND ov.id = vf.version_id
  JOIN sources s ON s.project_id = ov.project_id AND s.object_id = ov.object_id AND s.kind = 'file'
 WHERE vf.project_id = ?`;

/**
 * True when this version belongs to a file material and carries at least one file closed to AI.
 * Version unit. The AI read exits do NOT use this (they use material_object_denied); it is for facts that name one version.
 */
export function material_version_denied(db: ReadDb, project_id: string, version_id: string): boolean {
  return db
    .all<{ blob_id: string }>(`${MATERIAL_FILES_SQL} AND vf.version_id = ?`, project_id, version_id)
    .some((row) => file_ai_denied(db, project_id, row.blob_id));
}

/**
 * True when any version of this file material carries a file closed to AI. THE unit of every AI-facing exit (materials list,
 * context manifest, version read, A tool, change feed, material upload): a later version inherits the earlier title (the file name).
 */
export function material_object_denied(db: ReadDb, project_id: string, object_id: string): boolean {
  return db
    .all<{ blob_id: string }>(`${MATERIAL_FILES_SQL} AND ov.object_id = ?`, project_id, object_id)
    .some((row) => file_ai_denied(db, project_id, row.blob_id));
}

/** True when this artifact version carries a file closed to AI: its body file, or a file attached to the version. */
export function artifact_version_denied(db: ReadDb, project_id: string, version_id: string): boolean {
  const body = db.get<{ body_blob_id: string | null }>("SELECT body_blob_id FROM artifact_versions WHERE project_id = ? AND version_id = ?", project_id, version_id);
  if (body?.body_blob_id != null && file_ai_denied(db, project_id, body.body_blob_id)) return true;
  return db
    .all<{ blob_id: string }>("SELECT blob_id FROM version_files WHERE project_id = ? AND version_id = ?", project_id, version_id)
    .some((row) => file_ai_denied(db, project_id, row.blob_id));
}

/**
 * THE decision for a fact that comes from ONE object version (a quote a thread's anchor kept from the version it was made on): the
 * version belongs to a file material that is closed (material_object_denied, object unit) or is an artifact version that carries a
 * closed file (artifact_version_denied). The decision is made now, on the version the fact came from, not on the current one.
 */
export function version_ai_denied(db: ReadDb, project_id: string, version_id: string): boolean {
  const owner = db.get<{ object_id: string }>("SELECT object_id FROM object_versions WHERE project_id = ? AND id = ?", project_id, version_id);
  if (owner !== undefined && material_object_denied(db, project_id, owner.object_id)) return true;
  return artifact_version_denied(db, project_id, version_id);
}

export interface EventFacts {
  object_id: string | null;
  before_version_id: string | null;
  after_version_id: string | null;
  /** the stored payload text (JSON) */
  payload: string;
}

/**
 * Must this event be left out of a non-human caller's change feed? Yes when it names a closed file (blob_id or
 * file_policy_id in the payload — upload, attach, material upload and the access switch itself) or an object/version of a
 * closed file material. The cursor still moves past it (the caller never learns it was there).
 */
export function event_denied(db: ReadDb, project_id: string, event: EventFacts): boolean {
  let payload: unknown = null;
  try {
    payload = JSON.parse(event.payload);
  } catch {
    payload = null;
  }
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const named = payload as Record<string, unknown>;
    if (typeof named.blob_id === "string" && file_ai_denied(db, project_id, named.blob_id)) return true;
    if (typeof named.file_policy_id === "string" && access_state_of_policy(db, project_id, named.file_policy_id)?.effective === "deny") return true;
  }
  const versions = [event.before_version_id, event.after_version_id].filter((id): id is string => id !== null);
  if (versions.some((id) => material_version_denied(db, project_id, id))) return true;
  return versions.length === 0 && event.object_id !== null && material_object_denied(db, project_id, event.object_id);
}

// ---------------------------------------------------------------------------
// "My materials": source objects of kind file, each with the file of its current version

export interface MaterialDto {
  object_id: string;
  version_id: string;
  version_no: number;
  blob_id: string;
  file_policy_id: string;
  role: string;
  title: string;
  original_name: string | null;
  media_type: string;
  size: number;
  sha256: string;
  /** only for the human owner: the value in force. AI callers never get this key. */
  ai_access?: AiAccess;
}

interface MaterialRow {
  object_id: string;
  version_id: string;
  version_no: bigint;
  blob_id: string;
  file_policy_id: string;
  role: string;
  title: string;
  original_name: string | null;
  media_type: string;
  size: bigint;
  sha256: string;
}

export type Audience = "human" | "ai";

/**
 * The materials a caller may see. `human` = all, each with its `ai_access` (that file's own switch); `ai` = the material objects
 * with no closed file in any version, without the `ai_access` key and with no trace of the closed ones (not even a count).
 * Both go through file_ai_denied; `ai` judges per object (material_object_denied), like every other AI exit.
 */
export function material_rows(db: ReadDb, project_id: string, audience: Audience): MaterialDto[] {
  const rows = db.all<MaterialRow>(
    `SELECT o.id AS object_id, o.current_version_id AS version_id, ov.version_no AS version_no,
            vf.blob_id AS blob_id, vf.file_policy_id AS file_policy_id, vf.role AS role,
            sv.title AS title, b.original_name AS original_name, b.media_type AS media_type,
            b.size AS size, b.sha256 AS sha256
       FROM objects o
       JOIN sources s ON s.project_id = o.project_id AND s.object_id = o.id AND s.kind = 'file'
       JOIN object_versions ov ON ov.project_id = o.project_id AND ov.id = o.current_version_id
       JOIN source_versions sv ON sv.project_id = o.project_id AND sv.version_id = o.current_version_id
       JOIN version_files vf ON vf.project_id = o.project_id AND vf.version_id = o.current_version_id
       JOIN blobs b ON b.project_id = vf.project_id AND b.id = vf.blob_id
      WHERE o.project_id = ? AND o.kind = 'source' AND o.archived_at IS NULL
      ORDER BY o.display_no, vf.role, vf.blob_id`,
    project_id,
  );
  const out: MaterialDto[] = [];
  // An AI caller's unit is the material OBJECT, as at the write exits (run_upload, event_denied): a closed file in any version closes
  // the whole object, because a later version may inherit the closed file's name as its title. Decided once per object.
  const object_closed = new Map<string, boolean>();
  for (const row of rows) {
    const denied = file_ai_denied(db, project_id, row.blob_id);
    if (audience === "ai") {
      let closed = object_closed.get(row.object_id);
      if (closed === undefined) {
        closed = material_object_denied(db, project_id, row.object_id);
        object_closed.set(row.object_id, closed);
      }
      if (closed) continue;
    }
    const dto: MaterialDto = {
      object_id: row.object_id,
      version_id: row.version_id,
      version_no: Number(row.version_no),
      blob_id: row.blob_id,
      file_policy_id: row.file_policy_id,
      role: row.role,
      title: row.title,
      original_name: row.original_name,
      media_type: row.media_type,
      size: Number(row.size),
      sha256: row.sha256,
    };
    if (audience === "human") dto.ai_access = denied ? "deny" : "allow";
    out.push(dto);
  }
  return out;
}

/** What the A built-in tool and the prompt may carry about one allowed material: no ids of blob/policy, no hash. */
export interface AiMaterialDto {
  object_id: string;
  version_id: string;
  title: string;
  original_name: string | null;
  media_type: string;
  size: number;
}

export function ai_material_rows(db: ReadDb, project_id: string, limit: number): AiMaterialDto[] {
  return material_rows(db, project_id, "ai")
    .slice(0, limit)
    .map((m) => ({
      object_id: m.object_id,
      version_id: m.version_id,
      title: m.title,
      original_name: m.original_name,
      media_type: m.media_type,
      size: m.size,
    }));
}

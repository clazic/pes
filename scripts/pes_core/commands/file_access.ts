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

const MATERIAL_FILES_FROM = `FROM version_files vf
  JOIN object_versions ov ON ov.project_id = vf.project_id AND ov.id = vf.version_id
  JOIN sources s ON s.project_id = ov.project_id AND s.object_id = ov.object_id AND s.kind = 'file'
 WHERE vf.project_id = ?`;
const MATERIAL_FILES_SQL = `SELECT vf.blob_id AS blob_id ${MATERIAL_FILES_FROM}`;

/**
 * True when any version of this file material carries a file closed to AI. THE unit of every AI-facing exit (materials list,
 * context manifest, version read, A tool, change feed, material upload, results.submit): a later version inherits the earlier title (the file name).
 */
export function material_object_denied(db: ReadDb, project_id: string, object_id: string): boolean {
  return db
    .all<{ blob_id: string }>(`${MATERIAL_FILES_SQL} AND ov.object_id = ?`, project_id, object_id)
    .some((row) => file_ai_denied(db, project_id, row.blob_id));
}

/**
 * The closed side of a whole project, decided in two queries (one per table family) instead of one per event/row.
 * It is the set form of the one rule above — a file is closed when file_ai_denied says so, a material OBJECT is closed when any
 * version of it carries a closed file (material_object_denied) — so the batch exits (change feed, materials list) cost the same
 * however many events or rows they look at. tests/test_sel127_closed_index.test.ts keeps it equal to the per-object functions.
 */
export interface ClosedMaterials {
  /** blobs whose own policy says deny (file_ai_denied is true) */
  denied_blobs: ReadonlySet<string>;
  /** material objects with a closed file in any version (material_object_denied is true) */
  objects: ReadonlySet<string>;
  /** every version of a closed material object, allowed ones included */
  versions: ReadonlySet<string>;
  /** denied blobs plus every blob attached to a closed material object (an allowed v2 file named in an upload event) */
  blobs: ReadonlySet<string>;
  /** the policies of `blobs` */
  policies: ReadonlySet<string>;
}

export function closed_materials(db: ReadDb, project_id: string): ClosedMaterials {
  const states = db.all<AccessRow>(`${STATE_SQL} WHERE p.project_id = ?`, project_id).map(state_of);
  const denied_blobs = new Set(states.filter((state) => state.effective === "deny").map((state) => state.blob_id));
  const files = db.all<{ blob_id: string; version_id: string; object_id: string }>(
    `SELECT vf.blob_id AS blob_id, vf.version_id AS version_id, ov.object_id AS object_id ${MATERIAL_FILES_FROM}`,
    project_id,
  );
  const objects = new Set(files.filter((file) => denied_blobs.has(file.blob_id)).map((file) => file.object_id));
  const versions = new Set<string>();
  const blobs = new Set(denied_blobs);
  for (const file of files) {
    if (!objects.has(file.object_id)) continue;
    versions.add(file.version_id);
    blobs.add(file.blob_id);
  }
  const policies = new Set(states.filter((state) => blobs.has(state.blob_id)).map((state) => state.policy_id));
  return { denied_blobs, objects, versions, blobs, policies };
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
 * Payload keys that name a material OBJECT or a VERSION, matched against the closed sets. Every event type that names one
 * of these ids in its payload must be listed here (grep the type in commands/): annotation.created (target_object_id,
 * target_version_id), content.citation_added (source_version_id, artifact_version_id), content.relation_linked
 * (from_version_id, to_version_id), followup.proposed (proposed_version_id), dispatch.adopted (adopted_version_id).
 */
export const CLOSED_OBJECT_PAYLOAD_KEYS = ["object_id", "target_object_id"] as const;
export const CLOSED_VERSION_PAYLOAD_KEYS = [
  "version_id",
  "target_version_id",
  "source_version_id",
  "artifact_version_id",
  "from_version_id",
  "to_version_id",
  "proposed_version_id",
  "adopted_version_id",
] as const;

/**
 * Must this event be left out of a non-human caller's change feed? The unit is the material OBJECT, as at every AI exit:
 * yes when it names a closed file or a file of a closed material (blob_id or file_policy_id in the payload — upload, attach,
 * material upload and the access switch itself), or a closed material object or one of its versions (the id keys above in the
 * payload) — an allowed later version of a closed material hides with it. The cursor still moves past it (the caller never
 * learns it was there). `closed` comes from closed_materials, built once per page.
 *
 * Known limit: only top-level string values are compared. An array or nested value (e.g. edition.snapshotted's versions[])
 * is not compared — such an event is not a material-only event, so only its type reaches a non-human caller.
 *
 * The event COLUMNS (object_id, before/after_version_id) are NULL in every row write_events writes today (commands/shared.ts),
 * so the payload keys are the only facts this reads in practice. The column check stays for rows that do fill them; filling
 * the columns is not done here.
 */
export function event_denied(closed: ClosedMaterials, event: EventFacts): boolean {
  let payload: unknown = null;
  try {
    payload = JSON.parse(event.payload);
  } catch {
    payload = null;
  }
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const named = payload as Record<string, unknown>;
    if (typeof named.blob_id === "string" && closed.blobs.has(named.blob_id)) return true;
    if (typeof named.file_policy_id === "string" && closed.policies.has(named.file_policy_id)) return true;
    for (const key of CLOSED_OBJECT_PAYLOAD_KEYS) {
      const id = named[key];
      if (typeof id === "string" && closed.objects.has(id)) return true;
    }
    for (const key of CLOSED_VERSION_PAYLOAD_KEYS) {
      const id = named[key];
      if (typeof id === "string" && closed.versions.has(id)) return true;
    }
  }
  if (event.object_id !== null && closed.objects.has(event.object_id)) return true;
  return [event.before_version_id, event.after_version_id].some((id) => id !== null && closed.versions.has(id));
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
  /** only for the human owner: the value in force for THIS row's file. AI callers never get this key. */
  ai_access?: AiAccess;
  /** only for the human owner: the object-unit state — deny when any version of the material carries a closed file (what AI callers are judged by). */
  object_ai_access?: AiAccess;
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
 * The materials a caller may see. `human` = all, each with its `ai_access` (that row's file switch) and `object_ai_access` (the
 * object-unit state AI callers are judged by); `ai` = the material objects with no closed file in any version, without either key
 * and with no trace of the closed ones (not even a count). Both read the same closed_materials, so the list never disagrees
 * with the change feed or the other exits.
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
  // An AI caller's unit is the material OBJECT, as at the write exits (run_upload, event_denied): a closed file in any version closes
  // the whole object, because a later version may inherit the closed file's name as its title.
  const closed = closed_materials(db, project_id);
  const out: MaterialDto[] = [];
  for (const row of rows) {
    const object_closed = closed.objects.has(row.object_id);
    if (audience === "ai" && object_closed) continue;
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
    if (audience === "human") {
      dto.ai_access = closed.denied_blobs.has(row.blob_id) ? "deny" : "allow";
      dto.object_ai_access = object_closed ? "deny" : "allow";
    }
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
